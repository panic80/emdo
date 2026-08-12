import type { LocalTraceEvent } from '../../packages/agent-core/src/trace.js';
import type { EffectiveAuthorizationScopeFingerprint } from '../../packages/contracts/src/capability.js';

import { normalizeLocalTraceEvents } from './local-trace-adapter.js';
import type {
  AgentEvalCheckpoint,
  AgentEvalDriver,
  AgentEvalPhase,
  AgentEvalUntrustedApprovalChannel,
} from './runner.js';

type EvalAuthorizationScopeFingerprint = EffectiveAuthorizationScopeFingerprint;

export interface AgentOrchestratorEvalTurnInput {
  readonly requestId: string;
  readonly runId: string;
  readonly householdId: string;
  readonly userId: string;
  readonly authenticatedSessionId: string;
  readonly conversationId: string;
  readonly spaceAccessGrantId: string;
  readonly authorizationScopeFingerprint: EvalAuthorizationScopeFingerprint;
  readonly disclosureGrantId: string;
  readonly message: string;
  readonly escalationTriggers: readonly (
    | 'dependent-cross-domain'
    | 'failed-output-validation'
    | 'low-confidence-reconciliation'
    | 'complex-reasoning'
  )[];
  readonly abortSignal: AbortSignal;
}

export interface AgentOrchestratorEvalResumeInput {
  readonly requestId: string;
  readonly runId: string;
  readonly householdId: string;
  readonly userId: string;
  readonly authenticatedSessionId: string;
  readonly conversationId: string;
  readonly spaceAccessGrantId: string;
  readonly collectionAuthorizationScopeFingerprint: EvalAuthorizationScopeFingerprint;
  readonly authorizationScopeFingerprint: EvalAuthorizationScopeFingerprint;
  readonly disclosureGrantId: string;
  readonly disclosureGrantVersion: string;
  readonly checkpointId: string;
  readonly interruptionId: string;
  readonly proposalId: string;
  readonly approvalDecisionId: string;
  readonly decision: 'approve' | 'reject';
  readonly approvalChannel: 'authenticated-visual';
  readonly abortSignal: AbortSignal;
}

export interface AgentOrchestratorEvalUntrustedResumeInput extends Omit<
  AgentOrchestratorEvalResumeInput,
  'approvalChannel'
> {
  readonly approvalChannel: AgentEvalUntrustedApprovalChannel;
}

export interface AgentOrchestratorEvalPort {
  runTurn(input: AgentOrchestratorEvalTurnInput): Promise<unknown>;
  resumeTurn(input: AgentOrchestratorEvalResumeInput): Promise<unknown>;
}

export interface AgentOrchestratorEvalUntrustedApprovalPort {
  /** Deliberate contract-negative probe; production must reject this input. */
  resumeTurn(
    input: AgentOrchestratorEvalUntrustedResumeInput,
  ): Promise<unknown>;
}

export interface EvalLocalTraceSource {
  /** Returns only trace events not returned by an earlier call. */
  take(traceReference: string): readonly LocalTraceEvent[];
}

export interface EvalLocalFeatureProbe {
  verifyOperational(
    scope: Readonly<{
      runId: string;
      householdId: string;
      userId: string;
    }>,
  ): Promise<boolean>;
}

const fail = (): never => {
  throw new Error('invalid-agent-orchestrator-eval-result');
};

const record = (raw: unknown): Readonly<Record<string, unknown>> => {
  if (
    raw === null ||
    typeof raw !== 'object' ||
    (Object.getPrototypeOf(raw) !== Object.prototype &&
      Object.getPrototypeOf(raw) !== null) ||
    Object.getOwnPropertySymbols(raw).length > 0
  ) {
    return fail();
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !('value' in descriptor)
    ) {
      return fail();
    }
    result[key] = descriptor.value;
  }
  return result;
};

const stringValue = (
  source: Readonly<Record<string, unknown>>,
  key: string,
): string => {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 && value.length <= 2_048
    ? value
    : fail();
};

const booleanValue = (
  source: Readonly<Record<string, unknown>>,
  key: string,
): boolean =>
  typeof source[key] === 'boolean' ? (source[key] as boolean) : fail();

const arrayValue = (
  source: Readonly<Record<string, unknown>>,
  key: string,
): readonly unknown[] => {
  const value = source[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    return fail();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
  return value.map((_entry, index) => {
    const descriptor = descriptors[String(index)];
    return descriptor !== undefined &&
      descriptor.get === undefined &&
      descriptor.set === undefined &&
      'value' in descriptor
      ? descriptor.value
      : fail();
  });
};

const phaseSafeError = (
  raw: unknown,
): NonNullable<AgentEvalPhase['safeError']> => {
  const value = record(raw);
  const code = stringValue(value, 'code');
  const rawMessage = stringValue(value, 'message');
  const retryable = booleanValue(value, 'retryable');
  const message =
    code === 'agent-model-unavailable'
      ? 'AI is temporarily unavailable. Local features still work.'
      : code === 'required-agent-model-unavailable'
        ? 'The model required to complete this request safely is temporarily unavailable.'
        : 'The agent run failed safely.';
  void rawMessage;
  return Object.freeze({ code, message, retryable });
};

const modelUnavailable = (rawModelResolution: unknown): boolean => {
  if (rawModelResolution === undefined) return false;
  const resolution = record(rawModelResolution);
  return resolution.status === 'unavailable';
};

interface PendingInterruption {
  readonly runId: string;
  readonly householdId: string;
  readonly userId: string;
  readonly interruptionId: string;
  readonly proposalId: string;
}

interface EvalResultScope {
  readonly runId: string;
  readonly householdId: string;
  readonly userId: string;
}

const pendingKey = (runId: string, checkpointId: string): string =>
  `${runId}:${checkpointId}`;

export const createAgentOrchestratorEvalDriver = (options: {
  readonly orchestrator: AgentOrchestratorEvalPort;
  readonly untrustedApproval?: AgentOrchestratorEvalUntrustedApprovalPort;
  readonly traces: EvalLocalTraceSource;
  readonly localFeatures: EvalLocalFeatureProbe;
}): AgentEvalDriver => {
  if (
    typeof options?.orchestrator?.runTurn !== 'function' ||
    typeof options.orchestrator.resumeTurn !== 'function' ||
    typeof options.traces?.take !== 'function' ||
    typeof options.localFeatures?.verifyOperational !== 'function'
  ) {
    throw new TypeError('invalid-agent-orchestrator-eval-driver');
  }
  const runTurn = options.orchestrator.runTurn.bind(options.orchestrator);
  const resumeTurn = options.orchestrator.resumeTurn.bind(options.orchestrator);
  const resumeWithUntrustedApproval =
    options.untrustedApproval?.resumeTurn.bind(options.untrustedApproval);
  const takeTrace = options.traces.take.bind(options.traces);
  const verifyLocalFeatures = options.localFeatures.verifyOperational.bind(
    options.localFeatures,
  );
  const pending = new Map<string, PendingInterruption>();

  const resultPhase = async (
    rawResult: unknown,
    scope: EvalResultScope,
  ): Promise<AgentEvalPhase> => {
    const result = record(rawResult);
    const status = stringValue(result, 'status');
    if (stringValue(result, 'runId') !== scope.runId) return fail();
    const traceReference = stringValue(result, 'localTraceReference');
    const events = normalizeLocalTraceEvents(
      scope.runId,
      traceReference,
      takeTrace(traceReference),
    );

    if (status === 'completed') {
      return {
        status: booleanValue(result, 'hasPartialFailures')
          ? 'partial'
          : 'completed',
        events,
      };
    }
    if (status === 'failed') {
      const localOperational = modelUnavailable(result.modelResolution)
        ? (await verifyLocalFeatures(
            Object.freeze({
              runId: scope.runId,
              householdId: scope.householdId,
              userId: scope.userId,
            }),
          )) === true
        : false;
      return {
        status: 'failed',
        events,
        safeError: phaseSafeError(result.safeError),
        localFeaturesOperational: localOperational,
      };
    }
    if (status === 'needs-approval') {
      const checkpoint = record(result.checkpoint);
      const checkpointId = stringValue(checkpoint, 'checkpointId');
      const expiresAt = stringValue(checkpoint, 'expiresAt');
      if (
        !Number.isFinite(Date.parse(expiresAt)) ||
        stringValue(checkpoint, 'runId') !== scope.runId ||
        stringValue(checkpoint, 'householdId') !== scope.householdId ||
        stringValue(checkpoint, 'userId') !== scope.userId
      ) {
        return fail();
      }
      const interruptions = arrayValue(result, 'interruptions');
      if (interruptions.length !== 1) return fail();
      const interruption = record(interruptions[0]);
      const interruptionId = stringValue(interruption, 'id');
      const capabilityId = stringValue(interruption, 'capabilityId');
      const proposalId = stringValue(interruption, 'proposalId');
      const agentId = stringValue(interruption, 'agentId');
      const interruptionEvents = events.filter(
        (event) => event.type === 'approval-interrupted',
      );
      const matchingInterruptionEvents = interruptionEvents.filter(
        (event) =>
          event.type === 'approval-interrupted' &&
          event.checkpointId === checkpointId &&
          event.capabilityId === capabilityId &&
          event.proposalId === proposalId &&
          event.agentId === agentId,
      );
      const interruptionEvent = matchingInterruptionEvents[0];
      if (interruptionEvent?.type !== 'approval-interrupted') return fail();
      if (
        interruptionEvents.length !== 1 ||
        matchingInterruptionEvents.length !== 1
      ) {
        return fail();
      }
      pending.set(
        pendingKey(scope.runId, checkpointId),
        Object.freeze({
          runId: scope.runId,
          householdId: scope.householdId,
          userId: scope.userId,
          interruptionId,
          proposalId: interruptionEvent.proposalId,
        }),
      );
      const evalCheckpoint: AgentEvalCheckpoint = Object.freeze({
        checkpointId,
        proposalId: interruptionEvent.proposalId,
        expiresAt,
      });
      return {
        status: 'needs-approval',
        checkpoint: evalCheckpoint,
        events,
      };
    }
    return fail();
  };

  const driver: AgentEvalDriver = {
    start: async ({ evalCase, signal }) =>
      resultPhase(
        await runTurn({
          ...evalCase.turn,
          abortSignal: signal,
        }),
        evalCase.turn,
      ),
    resume: async ({ evalCase, checkpoint, decision, signal }) => {
      const key = pendingKey(evalCase.turn.runId, checkpoint.checkpointId);
      const interrupted = pending.get(key);
      if (
        interrupted === undefined ||
        interrupted.runId !== evalCase.turn.runId ||
        interrupted.householdId !== evalCase.turn.householdId ||
        interrupted.userId !== evalCase.turn.userId ||
        interrupted.proposalId !== checkpoint.proposalId ||
        decision.decidedByUserId !== evalCase.turn.userId ||
        decision.channel !== 'authenticated-visual'
      ) {
        return fail();
      }
      return resultPhase(
        await resumeTurn({
          requestId: decision.requestId,
          runId: evalCase.turn.runId,
          householdId: evalCase.turn.householdId,
          userId: evalCase.turn.userId,
          authenticatedSessionId: evalCase.turn.authenticatedSessionId,
          conversationId: evalCase.turn.conversationId,
          spaceAccessGrantId: evalCase.turn.spaceAccessGrantId,
          collectionAuthorizationScopeFingerprint:
            evalCase.turn.authorizationScopeFingerprint,
          authorizationScopeFingerprint:
            evalCase.turn.authorizationScopeFingerprint,
          disclosureGrantId: evalCase.turn.disclosureGrantId,
          disclosureGrantVersion: '1.0.0',
          checkpointId: checkpoint.checkpointId,
          interruptionId: interrupted.interruptionId,
          proposalId: interrupted.proposalId,
          approvalDecisionId: decision.approvalDecisionId,
          decision: decision.decision === 'approved' ? 'approve' : 'reject',
          approvalChannel: 'authenticated-visual',
          abortSignal: signal,
        }),
        evalCase.turn,
      );
    },
    attemptUntrustedApproval: async ({
      evalCase,
      checkpoint,
      attempt,
      signal,
    }) => {
      const key = pendingKey(evalCase.turn.runId, checkpoint.checkpointId);
      const interrupted = pending.get(key);
      if (
        resumeWithUntrustedApproval === undefined ||
        interrupted === undefined ||
        interrupted.runId !== evalCase.turn.runId ||
        interrupted.householdId !== evalCase.turn.householdId ||
        interrupted.userId !== evalCase.turn.userId ||
        interrupted.proposalId !== checkpoint.proposalId ||
        attempt.decidedByUserId !== evalCase.turn.userId
      ) {
        return fail();
      }
      return resultPhase(
        await resumeWithUntrustedApproval({
          requestId: attempt.requestId,
          runId: evalCase.turn.runId,
          householdId: evalCase.turn.householdId,
          userId: evalCase.turn.userId,
          authenticatedSessionId: evalCase.turn.authenticatedSessionId,
          conversationId: evalCase.turn.conversationId,
          spaceAccessGrantId: evalCase.turn.spaceAccessGrantId,
          collectionAuthorizationScopeFingerprint:
            evalCase.turn.authorizationScopeFingerprint,
          authorizationScopeFingerprint:
            evalCase.turn.authorizationScopeFingerprint,
          disclosureGrantId: evalCase.turn.disclosureGrantId,
          disclosureGrantVersion: '1.0.0',
          checkpointId: checkpoint.checkpointId,
          interruptionId: interrupted.interruptionId,
          proposalId: interrupted.proposalId,
          approvalDecisionId: attempt.approvalDecisionId,
          decision: 'approve',
          approvalChannel: attempt.channel,
          abortSignal: signal,
        }),
        evalCase.turn,
      );
    },
  };
  return Object.freeze(driver);
};

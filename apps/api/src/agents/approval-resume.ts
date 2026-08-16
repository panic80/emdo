import type { ResumeTurnInput, TurnResult } from '@emdo/agent-core';
import {
  ActionDecisionSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
  OpaqueReferenceSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type ActionDecision,
  type EffectiveAuthorizationScopeFingerprint,
} from '@emdo/contracts';
import { z } from 'zod';

import {
  ActionDecisionRequestSchema,
  AuthenticatedPrincipalSchema,
  VisualProposalDecisionResultSchema,
} from '../schemas.js';
import type {
  AuthenticatedPrincipal,
  VisualProposalDecisionGateway,
  VisualProposalDecisionResult,
} from '../services/contracts.js';

const InterruptionIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/u);
const DisclosureGrantVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
const PositiveTerminalEventSequenceSchema = z.number().int().positive().safe();

export interface ApprovalResumeBinding {
  /** Server-generated request ID for this resume phase, never the decision request ID. */
  readonly turnRequestId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly checkpointId: string;
  readonly interruptionId: string;
  readonly proposalId: string;
  readonly approvalDecisionId: string;
  readonly decision: 'approve' | 'reject';
  readonly householdId: string;
  readonly userId: string;
  readonly authenticatedSessionId: string;
  /** Fresh phase grant minted only after equivalent stable scope is re-proved. */
  readonly spaceAccessGrantId: string;
  readonly disclosureGrantId: string;
  readonly disclosureGrantVersion: string;
  /** Fresh current collection scope bound to the fresh resume grant. */
  readonly collectionAuthorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
  /** Freshly re-derived stable operation scope for the exact proposal. */
  readonly authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
  readonly payloadHash: string;
  readonly approvalHash: string;
}

const ApprovalResumeBindingSchema = z
  .strictObject({
    turnRequestId: UuidSchema,
    runId: UuidSchema,
    conversationId: UuidSchema,
    checkpointId: UuidSchema,
    interruptionId: InterruptionIdSchema,
    proposalId: UuidSchema,
    approvalDecisionId: UuidSchema,
    decision: z.enum(['approve', 'reject']),
    householdId: UuidSchema,
    userId: UuidSchema,
    authenticatedSessionId: UuidSchema,
    spaceAccessGrantId: UuidSchema,
    disclosureGrantId: UuidSchema,
    disclosureGrantVersion: DisclosureGrantVersionSchema,
    collectionAuthorizationScopeFingerprint:
      EffectiveAuthorizationScopeFingerprintSchema,
    authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprintSchema,
    payloadHash: Sha256Schema,
    approvalHash: Sha256Schema,
  })
  .transform(deepFreeze);

const ResumeClaimSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('claimed'),
    claimId: OpaqueReferenceSchema,
    ownershipToken: OpaqueReferenceSchema,
    binding: ApprovalResumeBindingSchema,
  }),
  z.strictObject({
    status: z.literal('in-progress'),
    runId: UuidSchema,
  }),
  z.strictObject({
    status: z.literal('terminal-replay'),
    runId: UuidSchema,
    terminalEventSequence: PositiveTerminalEventSequenceSchema,
  }),
]);

type CompletionCasResult =
  | Readonly<{
      status: 'completed' | 'terminalized' | 'indeterminate' | 'replay';
      terminalEventSequence: number;
    }>
  | Readonly<{ status: 'conflict' }>;

const CompletionCasResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.enum(['completed', 'terminalized', 'indeterminate', 'replay']),
    terminalEventSequence: PositiveTerminalEventSequenceSchema,
  }),
  z.strictObject({ status: z.literal('conflict') }),
]);

/**
 * One database transaction must consume/replay the visual proof, persist the
 * exact decision, compare the stored stable authorization-scope fingerprint
 * with current locked membership/session scope, revalidate disclosure and
 * provider epochs, create/claim the resume outbox record, and mint the fresh
 * request-bound phase grant. Caller fields are constraints, never authority.
 */
export interface DurableApprovalDecisionResumeBoundary {
  /** Atomically persists/replays the visual decision and links its existing job. */
  decideAndLink(
    input: Parameters<
      VisualProposalDecisionGateway['decideWithVisualProof']
    >[0],
  ): Promise<VisualProposalDecisionResult>;
  /**
   * Claims the pre-linked job under fresh request authority. Implementations
   * mint the resume request/grant internally and re-lock current scope.
   */
  claim(input: {
    readonly decision: ActionDecision;
    readonly principal: AuthenticatedPrincipal;
    readonly decisionRequestId: string;
  }): Promise<
    | Readonly<{
        status: 'claimed';
        claimId: string;
        ownershipToken: string;
        binding: ApprovalResumeBinding;
      }>
    | Readonly<{ status: 'in-progress'; runId: string }>
    | Readonly<{
        status: 'terminal-replay';
        runId: string;
        terminalEventSequence: number;
      }>
  >;
  complete(input: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly binding: ApprovalResumeBinding;
    readonly result: TurnResult;
  }): Promise<CompletionCasResult>;
  terminalizeNotDispatched(input: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly binding: ApprovalResumeBinding;
    readonly reasonCode: 'approval-resume-binding-invalid';
  }): Promise<CompletionCasResult>;
  markIndeterminate(input: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly binding: ApprovalResumeBinding;
    readonly reasonCode: 'approval-resume-failed';
  }): Promise<CompletionCasResult>;
  check(): Promise<boolean>;
}

export interface ProductionApprovalResumeRuntimeFactory {
  create(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly runId: string;
    readonly conversationId: string;
    readonly approvalResume: Readonly<{
      checkpointId: string;
      proposalId: string;
      approvalDecisionId: string;
      authenticatedSessionId: string;
      disclosureGrantId: string;
      disclosureGrantVersion: string;
      collectionAuthorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
      authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
    }>;
  }): Promise<{
    readonly orchestrator: Readonly<{
      resumeTurn(input: ResumeTurnInput): Promise<TurnResult>;
    }>;
  }>;
  check(): Promise<boolean>;
}

const exactDecision = (input: {
  readonly decision: ActionDecision;
  readonly request: ReturnType<typeof ActionDecisionRequestSchema.parse>;
  readonly principal: AuthenticatedPrincipal;
}): boolean =>
  input.decision.proposalId === input.request.proposalId &&
  input.decision.userId === input.principal.userId &&
  input.decision.authenticatedSessionId === input.principal.sessionId &&
  input.decision.payloadHash === input.request.payloadHash &&
  input.decision.approvalHash === input.request.approvalHash &&
  input.decision.decision === input.request.decision &&
  input.decision.idempotencyKey === input.request.idempotencyKey &&
  input.decision.channel === 'authenticated-visual';

const exactClaimBinding = (input: {
  readonly binding: ApprovalResumeBinding;
  readonly decision: ActionDecision;
  readonly principal: AuthenticatedPrincipal;
  readonly decisionRequestId: string;
}): boolean => {
  const expectedDecision =
    input.decision.decision === 'approved' ? 'approve' : 'reject';
  return (
    input.binding.proposalId === input.decision.proposalId &&
    input.binding.approvalDecisionId === input.decision.id &&
    input.binding.decision === expectedDecision &&
    input.binding.householdId === input.principal.householdId &&
    input.binding.userId === input.principal.userId &&
    input.binding.authenticatedSessionId === input.principal.sessionId &&
    input.binding.payloadHash === input.decision.payloadHash &&
    input.binding.approvalHash === input.decision.approvalHash &&
    input.binding.turnRequestId !== input.decisionRequestId &&
    input.binding.spaceAccessGrantId !== input.principal.spaceAccessGrantId
  );
};

const requireTerminalCas = (
  raw: CompletionCasResult,
  expected: readonly CompletionCasResult['status'][],
  errorCode: string,
): void => {
  const result = CompletionCasResultSchema.safeParse(raw);
  if (
    !result.success ||
    result.data.status === 'conflict' ||
    !expected.includes(result.data.status)
  ) {
    throw new Error(errorCode);
  }
};

const safeCheck = async (
  ...checks: readonly (() => Promise<boolean>)[]
): Promise<boolean> => {
  try {
    const results = await Promise.all(
      checks.map((check) => Promise.resolve().then(check)),
    );
    return results.every((result) => result === true);
  } catch {
    return false;
  }
};

export const createProductionApprovalResumeBinding = (dependencies: {
  readonly boundary: DurableApprovalDecisionResumeBoundary;
  readonly runtimeFactory: ProductionApprovalResumeRuntimeFactory;
}) => {
  if (
    typeof dependencies?.boundary?.decideAndLink !== 'function' ||
    typeof dependencies.boundary.claim !== 'function' ||
    typeof dependencies.boundary.complete !== 'function' ||
    typeof dependencies.boundary.terminalizeNotDispatched !== 'function' ||
    typeof dependencies.boundary.markIndeterminate !== 'function' ||
    typeof dependencies.boundary.check !== 'function' ||
    typeof dependencies.runtimeFactory?.create !== 'function' ||
    typeof dependencies.runtimeFactory.check !== 'function'
  ) {
    throw new Error('api-production-approval-resume-dependency-invalid');
  }
  const boundary = dependencies.boundary;
  const runtimeFactory = dependencies.runtimeFactory;

  const decideWithVisualProof: VisualProposalDecisionGateway['decideWithVisualProof'] =
    async (rawInput) => {
      const request = ActionDecisionRequestSchema.parse(rawInput.request);
      const principal = AuthenticatedPrincipalSchema.parse(rawInput.principal);
      const decisionRequestId = UuidSchema.parse(rawInput.requestId);
      const durable = VisualProposalDecisionResultSchema.parse(
        await boundary.decideAndLink({
          ...rawInput,
          request,
          principal,
          requestId: decisionRequestId,
        }),
      );
      if (durable.status !== 'decided') return durable;
      const decision = ActionDecisionSchema.parse(durable.decision);
      if (!exactDecision({ decision, request, principal })) {
        throw new Error('api-approval-resume-decision-binding-invalid');
      }
      const publicResult = deepFreeze({ status: 'decided' as const, decision });
      const resume = ResumeClaimSchema.parse(
        await boundary.claim({
          decision,
          principal,
          decisionRequestId,
        }),
      );
      if (resume.status === 'terminal-replay') {
        if (resume.runId.length === 0) {
          throw new Error('api-approval-resume-replay-invalid');
        }
        return publicResult;
      }
      if (resume.status === 'in-progress') return publicResult;

      const binding = ApprovalResumeBindingSchema.parse(resume.binding);
      const claim = Object.freeze({
        claimId: resume.claimId,
        ownershipToken: resume.ownershipToken,
        binding,
      });
      if (
        !exactClaimBinding({
          binding,
          decision,
          principal,
          decisionRequestId,
        })
      ) {
        requireTerminalCas(
          await boundary.terminalizeNotDispatched({
            ...claim,
            reasonCode: 'approval-resume-binding-invalid',
          }),
          ['terminalized', 'replay'],
          'api-approval-resume-terminalization-invalid',
        );
        return publicResult;
      }

      const resumePrincipal = deepFreeze({
        ...principal,
        spaceAccessGrantId: binding.spaceAccessGrantId,
        collectionAuthorizationScopeFingerprint:
          binding.collectionAuthorizationScopeFingerprint,
      });
      try {
        const runtime = await runtimeFactory.create({
          principal: resumePrincipal,
          requestId: binding.turnRequestId,
          runId: binding.runId,
          conversationId: binding.conversationId,
          approvalResume: {
            checkpointId: binding.checkpointId,
            proposalId: binding.proposalId,
            approvalDecisionId: binding.approvalDecisionId,
            authenticatedSessionId: binding.authenticatedSessionId,
            disclosureGrantId: binding.disclosureGrantId,
            disclosureGrantVersion: binding.disclosureGrantVersion,
            collectionAuthorizationScopeFingerprint:
              binding.collectionAuthorizationScopeFingerprint,
            authorizationScopeFingerprint:
              binding.authorizationScopeFingerprint,
          },
        });
        if (typeof runtime?.orchestrator?.resumeTurn !== 'function') {
          throw new Error('api-approval-resume-runtime-invalid');
        }
        const result = await runtime.orchestrator.resumeTurn({
          requestId: binding.turnRequestId,
          runId: binding.runId,
          householdId: binding.householdId,
          userId: binding.userId,
          authenticatedSessionId: binding.authenticatedSessionId,
          conversationId: binding.conversationId,
          spaceAccessGrantId: binding.spaceAccessGrantId,
          collectionAuthorizationScopeFingerprint:
            binding.collectionAuthorizationScopeFingerprint,
          disclosureGrantId: binding.disclosureGrantId,
          disclosureGrantVersion: binding.disclosureGrantVersion,
          authorizationScopeFingerprint: binding.authorizationScopeFingerprint,
          checkpointId: binding.checkpointId,
          interruptionId: binding.interruptionId,
          proposalId: binding.proposalId,
          approvalDecisionId: binding.approvalDecisionId,
          decision: binding.decision,
          approvalChannel: 'authenticated-visual',
          abortSignal: new AbortController().signal,
        });
        requireTerminalCas(
          await boundary.complete({ ...claim, result }),
          ['completed', 'replay'],
          'api-approval-resume-completion-invalid',
        );
      } catch {
        requireTerminalCas(
          await boundary.markIndeterminate({
            ...claim,
            reasonCode: 'approval-resume-failed',
          }),
          ['indeterminate', 'replay'],
          'api-approval-resume-indeterminate-invalid',
        );
      }
      return publicResult;
    };

  const service: VisualProposalDecisionGateway = Object.freeze({
    decideWithVisualProof,
  });
  return Object.freeze({
    service,
    check: () =>
      safeCheck(
        boundary.check.bind(boundary),
        runtimeFactory.check.bind(runtimeFactory),
      ),
  });
};

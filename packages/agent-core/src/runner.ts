import { createHash, randomUUID } from 'node:crypto';

import {
  Agent,
  RunContext,
  Runner,
  RunState,
  tool,
  type FunctionTool,
  type RunToolApprovalItem,
} from '@openai/agents';
import {
  EffectiveAuthorizationScopeFingerprintSchema,
  SupportedLocaleSchema,
  type CapabilityInvocationContext,
  type EffectiveAuthorizationScopeFingerprint,
  type SupportedLocale,
} from '@emdo/contracts';
import { z } from 'zod';

import type {
  ApprovalCheckpointIdentity,
  ApprovalCheckpointView,
} from './approval-state.js';
import type { SpendGuard } from './budget.js';
import {
  sdkToolNameForCapability,
  type AgentCapabilityReference,
  type AgentSdkFacade,
  type CompiledAgent,
} from './factory.js';
import type {
  ConversationMemoryEntry,
  ManagerConversationMemory,
  ManagerMemoryContext,
} from './memory.js';
import type {
  EmdoModelId,
  ModelEscalationTrigger,
  ModelResolution,
  ModelRoutingPolicy,
  RequestedModelEscalationTrigger,
} from './model-router.js';
import type { LocalTraceRecorder, ActiveLocalTrace } from './trace.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const INTERRUPTION_ID_PATTERN = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_MESSAGE_LENGTH = 32_000;
const CHECKPOINT_TTL_MS = 10 * 60 * 1_000;
const RUNTIME_STATE_VERSION = 5 as const;
const CONVERSATION_DATA_CLASS = 'conversation.messages';
const MANAGER_PLAN_DATA_CLASS = 'agent.manager-plans';
const DELEGATION_DATA_CLASS = 'agent.delegations';
const SPECIALIST_OUTCOME_DATA_CLASS = 'agent.specialist-outcomes';

const SDK_CALL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const DISCLOSURE_PATH_PATTERN = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;

export const MANAGER_PLAN_OUTPUT_SCHEMA = z.strictObject({
  delegations: z
    .array(
      z.strictObject({
        id: z.string().regex(IDENTIFIER_PATTERN),
        specialistId: z.string().regex(IDENTIFIER_PATTERN),
        input: z.strictObject({
          request: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
        }),
        dependsOn: z.array(z.string().regex(IDENTIFIER_PATTERN)).max(128),
      }),
    )
    .max(128),
  directResponse: z.json().nullable(),
});

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;

export interface AgentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelCostCadMinor: number;
  readonly spendWarning?: true;
}

export type AgentProviderReplaySafety = 'safe' | 'unsafe';
export type AgentProviderFailureReason =
  | 'execution-failed'
  | 'timeout'
  | 'token-budget-exceeded'
  | 'capability-budget-exceeded'
  | 'monthly-spend-limit-reached'
  | 'spend-authorization-failed'
  | 'disclosure-denied'
  | 'multiple-provider-writes'
  | 'proposal-finalization-pending';

export interface AgentProviderInterruption {
  readonly id: string;
  readonly agentId: string;
  readonly capabilityId: string;
  readonly proposalId: string;
  readonly argumentsPreview: JsonValue;
  /** Trusted internal binding retained only in encrypted checkpoint state. */
  readonly sdkCallId?: string;
  /** Trusted internal binding retained only in encrypted checkpoint state. */
  readonly providerAuthorityBindingHash?: string;
  /** Trusted operation scope retained only in encrypted checkpoint state. */
  readonly authorizationScopeFingerprint?: EffectiveAuthorizationScopeFingerprint;
}

export type AgentProviderResult =
  | Readonly<{
      status: 'completed';
      output: JsonValue;
      usage: AgentUsage;
      /** Present when the provider can prove whether replay could duplicate work. */
      replaySafety?: AgentProviderReplaySafety;
      capabilityCalls?: number;
    }>
  | Readonly<{
      status: 'interrupted';
      serializedState: string;
      interruptions: readonly AgentProviderInterruption[];
      usage: AgentUsage;
      capabilityCalls?: number;
    }>
  | Readonly<{
      status: 'failed';
      reason: AgentProviderFailureReason;
      replaySafety: AgentProviderReplaySafety;
      usage: AgentUsage;
      capabilityCalls?: number;
    }>;

export type AgentExecutionPhase =
  'plan' | 'specialist' | 'synthesize' | 'resume';

export interface AgentExecutionContext {
  readonly requestId: string;
  readonly runId: string;
  readonly householdId: string;
  readonly userId: string;
  readonly authenticatedSessionId: string;
  readonly spaceAccessGrantId: string;
  readonly authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
  /** Fixed server-derived response locale for this turn; models cannot alter it. */
  readonly locale: SupportedLocale;
  readonly disclosureGrantId?: string;
  readonly disclosureGrantVersion?: string;
  readonly approvalDecisionId?: string;
  readonly agentId: string;
  readonly abortSignal: AbortSignal;
}

export type ModelDisclosurePurpose =
  'manager-plan' | 'specialist-execution' | 'manager-synthesis';

export interface ModelDisclosureAuthorization {
  readonly status: 'authorized';
  readonly grantId: string;
  readonly grantVersion: string;
  readonly runId: string;
  readonly householdId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly phasePurpose: ModelDisclosurePurpose;
  readonly phaseInvocationId: string;
  /** Exact user-authorized purpose stored on the durable disclosure grant. */
  readonly disclosurePurpose: string;
  readonly provider: 'openai';
  readonly expiresAt: string;
  readonly records: readonly Readonly<{
    readonly dataClass: string;
    readonly recordId: string;
    readonly fields: readonly string[];
  }>[];
  /** Canonical payload after the trusted gateway has removed unauthorized data. */
  readonly payload: JsonValue;
}

export type ModelDisclosureDenialReason =
  | 'grant-not-found'
  | 'grant-run-mismatch'
  | 'grant-household-mismatch'
  | 'grant-user-mismatch'
  | 'grant-agent-mismatch'
  | 'grant-purpose-mismatch'
  | 'grant-invocation-mismatch'
  | 'grant-provider-mismatch'
  | 'grant-expired'
  | 'record-not-allowed'
  | 'field-not-allowed'
  | 'no-active-grant';

export type ModelDisclosureDenial =
  | Readonly<{
      readonly status: 'denied';
      readonly reason: 'no-active-grant';
      readonly grantId?: string;
    }>
  | Readonly<{
      readonly status: 'denied';
      readonly grantId: string;
      readonly reason: Exclude<ModelDisclosureDenialReason, 'no-active-grant'>;
    }>;

export type ModelDisclosureDecision =
  ModelDisclosureAuthorization | ModelDisclosureDenial;

export type ModelDisclosureSource =
  | Readonly<{
      readonly kind: 'conversation-message';
      readonly entry: ConversationMemoryEntry;
    }>
  | Readonly<{
      readonly kind: 'manager-plan';
      readonly plan: JsonValue;
    }>
  | Readonly<{
      readonly kind: 'specialist-delegation';
      readonly delegation: JsonValue;
    }>
  | Readonly<{
      readonly kind: 'specialist-outcome';
      readonly outcome: JsonValue;
    }>;

/**
 * Trusted, server-owned disclosure boundary. Implementations resolve an active
 * grant from durable state using the supplied server-derived scope; callers do
 * not provide grant objects or field allowlists.
 */
export interface ModelDisclosureGateway {
  authorize(
    input: Readonly<{
      requestId: string;
      runId: string;
      householdId: string;
      userId: string;
      authenticatedSessionId: string;
      spaceAccessGrantId: string;
      authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
      agentId: string;
      phasePurpose: ModelDisclosurePurpose;
      /** Stable server-derived key for exactly one logical model dispatch. */
      phaseInvocationId: string;
      provider: 'openai';
      /** Trusted inputs projected to durable canonical records by the gateway. */
      sources: readonly ModelDisclosureSource[];
    }>,
  ): Promise<ModelDisclosureDecision>;
}

export interface PreparedProviderWriteProposal {
  readonly proposalId: string;
  /** Hash of the trusted, server-derived provider authorization binding. */
  readonly providerAuthorityBindingHash: string;
  /** Stable operation scope derived from the provider authority and proposal. */
  readonly authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
  readonly preview: JsonValue;
}

export type PreparedProviderWriteAbandonment =
  | Readonly<{ readonly status: 'abandoned' }>
  | Readonly<{ readonly status: 'already-abandoned' }>
  | Readonly<{ readonly status: 'not-abandonable' }>;

export type ProviderWriteProposalAbandonmentReason =
  | 'multiple-provider-writes-require-separate-turns'
  | 'execution-ended-before-checkpoint';

export interface ProviderWriteProposalAbandonmentScope {
  readonly requestId: string;
  readonly runId: string;
  readonly householdId: string;
  readonly userId: string;
  readonly authenticatedSessionId: string;
  readonly spaceAccessGrantId: string;
  readonly disclosureGrantId: string;
  readonly disclosurePolicyVersion: string;
  readonly agentId: string;
}

export interface ProviderWriteDecisionExecution {
  readonly outcome: 'executed-readback-verified' | 'rejected';
  readonly output: JsonValue;
  readonly idempotencyKey: string;
}

/**
 * Trusted server boundary for immutable ActionProposal preparation and
 * decision verification. Implementations own capability-specific previews and
 * must persist the SDK call binding; the model never supplies proposal IDs.
 */
export interface ProviderWriteProposalGateway {
  /**
   * Local-write/import materializers may return undefined after trusted
   * classification, which lets the same capability execute a safe input
   * directly. Provider writes must always return a proposal.
   */
  prepare(
    input: Readonly<{
      capabilityId: string;
      sdkCallId: string;
      canonicalArguments: JsonValue;
      context: AgentExecutionContext;
    }>,
  ): Promise<PreparedProviderWriteProposal | undefined>;
  resolvePrepared(
    input: Readonly<{
      capabilityId: string;
      sdkCallId: string;
      context: AgentExecutionContext;
    }>,
  ): Promise<PreparedProviderWriteProposal | undefined>;
  /**
   * Idempotently terminalizes an undispatched prepared proposal. The trusted
   * implementation must match every supplied binding and must never alter an
   * executing, applied, or otherwise terminal proposal.
   */
  abandonPrepared(
    input: Readonly<{
      proposalId: string;
      capabilityId: string;
      sdkCallId: string;
      providerAuthorityBindingHash: string;
      reason: ProviderWriteProposalAbandonmentReason;
      scope: ProviderWriteProposalAbandonmentScope;
    }>,
  ): Promise<PreparedProviderWriteAbandonment>;
  validateDecision(
    input: Readonly<{
      proposalId: string;
      approvalDecisionId: string;
      capabilityId: string;
      /** Fresh request/phase authority used for any resumed execution. */
      context: AgentExecutionContext;
      /** Immutable pause-time lineage used only to match the prepared proposal. */
      preparationContext: AgentExecutionContext;
      decision: 'approve' | 'reject';
    }>,
  ): Promise<boolean>;
  executeDecision(
    input: Readonly<{
      proposalId: string;
      approvalDecisionId: string;
      capabilityId: string;
      /** Fresh request/phase authority used for provider execution. */
      context: AgentExecutionContext;
      /** Immutable pause-time lineage used only to match the prepared proposal. */
      preparationContext: AgentExecutionContext;
      decision: 'approve' | 'reject';
    }>,
  ): Promise<ProviderWriteDecisionExecution>;
}

export interface AgentProviderRequest {
  readonly phase: AgentExecutionPhase;
  readonly agent: CompiledAgent;
  readonly model: EmdoModelId;
  readonly input: JsonValue;
  readonly context: AgentExecutionContext;
  readonly maxTurns: number;
  readonly priorCapabilityCalls?: number;
  /** Shared, app-owned turn guard; never serialized or exposed to the model. */
  readonly turnProviderWriteLedger?: TurnProviderWriteEffectLedger;
  /** Called immediately before model I/O to revalidate time-sensitive grants. */
  readonly beforeModelDispatch?: () => Promise<void>;
  /** Called immediately after the provider has initiated model I/O. */
  readonly onModelDispatch?: () => Promise<void>;
  readonly resume?: Readonly<{
    readonly serializedState: string;
    /** Immutable pause-time authority lineage for SDK interruption lookup. */
    readonly preparationContext: AgentExecutionContext;
    readonly decision: Readonly<{
      readonly interruptionId: string;
      readonly decision: 'approve' | 'reject';
      readonly proposalId: string;
      readonly approvalDecisionId: string;
      readonly capabilityId: string;
      readonly originalPhase: Exclude<AgentExecutionPhase, 'resume'>;
      readonly priorCapabilityCalls: number;
    }>;
  }>;
}

export interface AgentExecutionProvider {
  readonly sdkVersion?: string;
  execute(request: AgentProviderRequest): Promise<AgentProviderResult>;
}

export type OpenAiSdkAgent = Agent<AgentExecutionContext, z.ZodObject>;
export type OpenAiSdkFunctionTool = FunctionTool<
  AgentExecutionContext,
  z.ZodObject,
  unknown
>;

interface PreparedProviderWriteBinding {
  readonly capabilityId: string;
  readonly sdkCallId: string;
  readonly proposal: PreparedProviderWriteProposal;
  readonly context: AgentExecutionContext;
}

interface TurnProviderWriteEffectLedger {
  readonly abortController: AbortController;
  providerWriteProposalCount: number;
  providerWriteCapabilityId?: string;
  providerWriteSdkCallId?: string;
  providerWriteCanonicalArgumentsHash?: string;
  multipleProviderWritesRequested: boolean;
  providerWritePreparation?: Promise<PreparedProviderWriteBinding | undefined>;
  proposalFinalizationPending: boolean;
  proposalAbandonmentAttempted: boolean;
  proposalAbandonmentConfirmed: boolean;
  priorWriteTerminal: boolean;
}

interface AgentExecutionEffectLedger {
  consequentialCapabilityInvoked: boolean;
  capabilityCalls: number;
  readonly maxCapabilityCalls: number;
  readonly seenCallIds: Set<string>;
  capabilityBudgetExceeded: boolean;
  readonly turnProviderWrites: TurnProviderWriteEffectLedger;
}

const executionEffectLedgers = new WeakMap<
  object,
  AgentExecutionEffectLedger
>();

const recordCapabilityInvocation = (
  context: unknown,
  capabilityKind: AgentCapabilityReference['kind'],
  callId?: string,
): void => {
  if (context === null || typeof context !== 'object') return;
  const ledger = executionEffectLedgers.get(context);
  if (ledger === undefined) return;
  if (callId !== undefined && ledger.seenCallIds.has(callId)) {
    if (capabilityKind !== 'read' && capabilityKind !== 'delegation') {
      ledger.consequentialCapabilityInvoked = true;
    }
    return;
  }
  if (ledger.capabilityCalls >= ledger.maxCapabilityCalls) {
    ledger.capabilityBudgetExceeded = true;
    throw new Error('agent-capability-call-budget-exceeded');
  }
  ledger.capabilityCalls += 1;
  if (callId !== undefined) ledger.seenCallIds.add(callId);
  if (capabilityKind !== 'read' && capabilityKind !== 'delegation') {
    ledger.consequentialCapabilityInvoked = true;
  }
};

const providerWriteAbandonmentScope = (
  context: AgentExecutionContext,
): ProviderWriteProposalAbandonmentScope => {
  if (
    context.disclosureGrantId === undefined ||
    context.disclosureGrantVersion === undefined
  ) {
    throw new Error('provider-write-disclosure-grant-required');
  }
  return Object.freeze({
    requestId: context.requestId,
    runId: context.runId,
    householdId: context.householdId,
    userId: context.userId,
    authenticatedSessionId: context.authenticatedSessionId,
    spaceAccessGrantId: context.spaceAccessGrantId,
    disclosureGrantId: context.disclosureGrantId,
    disclosurePolicyVersion: context.disclosureGrantVersion,
    agentId: context.agentId,
  });
};

const abandonPreparedProviderWrite = async (
  gateway: ProviderWriteProposalGateway,
  ledger: TurnProviderWriteEffectLedger,
  reason: ProviderWriteProposalAbandonmentReason,
): Promise<boolean> => {
  if (ledger.providerWritePreparation === undefined) {
    return ledger.providerWriteProposalCount === 0 || ledger.priorWriteTerminal;
  }
  if (ledger.proposalAbandonmentConfirmed) return true;
  if (ledger.proposalAbandonmentAttempted) return false;
  ledger.proposalAbandonmentAttempted = true;
  let prepared: Awaited<
    NonNullable<TurnProviderWriteEffectLedger['providerWritePreparation']>
  >;
  try {
    prepared = await ledger.providerWritePreparation;
  } catch {
    ledger.proposalFinalizationPending = true;
    return false;
  }
  if (prepared === undefined) {
    return ledger.providerWriteProposalCount === 0 || ledger.priorWriteTerminal;
  }
  try {
    const abandonment = snapshotPreparedProposalAbandonment(
      await gateway.abandonPrepared(
        Object.freeze({
          proposalId: prepared.proposal.proposalId,
          capabilityId: prepared.capabilityId,
          sdkCallId: prepared.sdkCallId,
          providerAuthorityBindingHash:
            prepared.proposal.providerAuthorityBindingHash,
          reason,
          scope: providerWriteAbandonmentScope(prepared.context),
        }),
      ),
    );
    if (
      abandonment.status === 'abandoned' ||
      abandonment.status === 'already-abandoned'
    ) {
      ledger.proposalAbandonmentConfirmed = true;
      return true;
    }
  } catch {
    // The provider result below remains fail-closed and nonretryable.
  }
  ledger.proposalFinalizationPending = true;
  return false;
};

const createTurnProviderWriteEffectLedger = (
  priorWriteTerminal = false,
): TurnProviderWriteEffectLedger => ({
  abortController: new AbortController(),
  providerWriteProposalCount: priorWriteTerminal ? 1 : 0,
  multipleProviderWritesRequested: false,
  proposalFinalizationPending: false,
  proposalAbandonmentAttempted: false,
  proposalAbandonmentConfirmed: false,
  priorWriteTerminal,
});

export const createOpenAiAgentsSdkFacade = (
  options: {
    readonly proposalGateway?: ProviderWriteProposalGateway;
  } = {},
): AgentSdkFacade<OpenAiSdkAgent, OpenAiSdkFunctionTool> => {
  const createTool: AgentSdkFacade<
    OpenAiSdkAgent,
    OpenAiSdkFunctionTool
  >['createTool'] = (config) => {
    if (
      config.name !== sdkToolNameForCapability(config.canonicalCapabilityId)
    ) {
      throw new Error('sdk-tool-canonical-name-mismatch');
    }
    const needsApproval = config.needsApproval
      ? async (
          runContext: RunContext,
          input: unknown,
          callId?: string,
        ): Promise<boolean> => {
          if (
            callId === undefined ||
            !SDK_CALL_ID_PATTERN.test(callId) ||
            runContext?.context == null
          ) {
            throw new Error('provider-write-call-id-required');
          }
          const gateway = options.proposalGateway;
          if (gateway === undefined) {
            throw new Error('provider-write-proposal-gateway-required');
          }
          const context = snapshotExecutionContext(runContext.context);
          const ledger = executionEffectLedgers.get(runContext.context);
          if (ledger === undefined) {
            throw new Error('provider-write-live-execution-ledger-required');
          }
          const turnLedger = ledger.turnProviderWrites;
          const isProviderWrite = config.capabilityKind === 'provider-write';
          const canonicalArgumentsHash = createHash('sha256')
            .update(JSON.stringify(snapshotJson(input)))
            .digest('hex');
          if (turnLedger.providerWriteProposalCount >= 1) {
            if (
              turnLedger.providerWriteCapabilityId ===
                config.canonicalCapabilityId &&
              turnLedger.providerWriteSdkCallId === callId &&
              turnLedger.providerWriteCanonicalArgumentsHash ===
                canonicalArgumentsHash &&
              turnLedger.providerWritePreparation !== undefined
            ) {
              return (await turnLedger.providerWritePreparation) !== undefined;
            }
            turnLedger.multipleProviderWritesRequested = true;
            if (
              !(await abandonPreparedProviderWrite(
                gateway,
                turnLedger,
                'multiple-provider-writes-require-separate-turns',
              ))
            ) {
              throw new Error('provider-write-proposal-finalization-pending');
            }
            turnLedger.abortController.abort(
              new Error('multiple-provider-writes-require-separate-turns'),
            );
            throw new Error('multiple-provider-writes-require-separate-turns');
          }
          turnLedger.providerWriteProposalCount += 1;
          turnLedger.providerWriteCapabilityId = config.canonicalCapabilityId;
          turnLedger.providerWriteSdkCallId = callId;
          turnLedger.providerWriteCanonicalArgumentsHash =
            canonicalArgumentsHash;
          recordCapabilityInvocation(
            runContext.context,
            config.capabilityKind,
            callId,
          );
          const preparation = (async () => {
            const rawProposal = await gateway.prepare(
              Object.freeze({
                capabilityId: config.canonicalCapabilityId,
                sdkCallId: callId,
                canonicalArguments: snapshotJson(input),
                context,
              }),
            );
            if (rawProposal === undefined) return undefined;
            const proposal = snapshotPreparedProposal(rawProposal);
            return Object.freeze({
              capabilityId: config.canonicalCapabilityId,
              sdkCallId: callId,
              proposal,
              context,
            });
          })();
          turnLedger.providerWritePreparation = preparation;
          try {
            const prepared = await preparation;
            if (prepared === undefined) {
              if (isProviderWrite) {
                throw new Error('provider-write-proposal-required');
              }
              turnLedger.providerWriteProposalCount = 0;
              turnLedger.providerWriteCapabilityId = undefined;
              turnLedger.providerWriteSdkCallId = undefined;
              turnLedger.providerWriteCanonicalArgumentsHash = undefined;
              turnLedger.providerWritePreparation = undefined;
              return false;
            }
          } catch (error) {
            turnLedger.proposalFinalizationPending = true;
            throw error;
          }
          return true;
        }
      : false;
    return tool<
      z.ZodObject,
      AgentExecutionContext,
      unknown,
      z.ZodObject | undefined
    >({
      name: config.name,
      description: config.description,
      parameters: config.parameters,
      ...(config.outputSchema === undefined
        ? {}
        : { outputSchema: config.outputSchema }),
      strict: true,
      needsApproval,
      timeoutMs: config.timeoutMs,
      execute: async (input, runContext, details) => {
        if (runContext?.context == null) {
          throw new Error('agent-execution-context-required');
        }
        const detailsCallId = details?.toolCall?.callId;
        recordCapabilityInvocation(
          runContext.context,
          config.capabilityKind,
          typeof detailsCallId === 'string' ? detailsCallId : undefined,
        );
        return config.execute(
          input,
          snapshotCapabilityInvocationContext(runContext.context),
        );
      },
    }) as OpenAiSdkFunctionTool;
  };
  const createAgent: AgentSdkFacade<
    OpenAiSdkAgent,
    OpenAiSdkFunctionTool
  >['createAgent'] = (config) =>
    new Agent<AgentExecutionContext, z.ZodObject>({
      name: config.name,
      instructions: config.instructions,
      model: config.model,
      modelSettings: { maxTokens: config.maxOutputTokens },
      tools: [...config.tools],
      outputType: config.outputType,
    });
  return Object.freeze({ createTool, createAgent });
};

export interface TurnInput {
  readonly requestId: string;
  readonly runId: string;
  readonly householdId: string;
  readonly userId: string;
  readonly authenticatedSessionId: string;
  readonly conversationId: string;
  readonly spaceAccessGrantId: string;
  readonly authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
  readonly locale: SupportedLocale;
  readonly message: string;
  readonly escalationTriggers: readonly RequestedModelEscalationTrigger[];
  readonly abortSignal: AbortSignal;
}

export interface ResumeTurnInput {
  readonly requestId: string;
  readonly runId: string;
  readonly householdId: string;
  readonly userId: string;
  readonly authenticatedSessionId: string;
  readonly conversationId: string;
  readonly spaceAccessGrantId: string;
  /** Fresh collection scope used for post-resume model disclosure. */
  readonly collectionAuthorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
  /** Freshly re-derived proposal operation scope, compared to the checkpoint. */
  readonly authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
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

export interface SpecialistOutcome {
  readonly delegationId: string;
  readonly specialistId: string;
  readonly status: 'completed' | 'failed' | 'blocked';
  readonly output?: JsonValue;
  readonly safeError?: SafeAgentError;
  readonly usage: AgentUsage;
}

export interface RuntimeInterruption {
  readonly id: string;
  readonly agentId: string;
  readonly capabilityId: string;
  readonly proposalId: string;
  readonly argumentsPreview: JsonValue;
}

export interface SafeAgentError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

interface BaseTurnResult {
  readonly runId: string;
  readonly localTraceReference: string;
  readonly modelResolution?: ModelResolution;
}

export interface CompletedTurnResult extends BaseTurnResult {
  readonly status: 'completed';
  readonly output: JsonValue;
  readonly specialistOutcomes: readonly SpecialistOutcome[];
  readonly hasPartialFailures: boolean;
  readonly usage: AgentUsage;
  readonly modelResolution: Extract<ModelResolution, { status: 'resolved' }>;
}

export interface ApprovalTurnResult extends BaseTurnResult {
  readonly status: 'needs-approval';
  readonly checkpoint: ApprovalCheckpointView;
  readonly interruptions: readonly RuntimeInterruption[];
  readonly specialistOutcomes: readonly SpecialistOutcome[];
  readonly usage: AgentUsage;
  readonly modelResolution: Extract<ModelResolution, { status: 'resolved' }>;
}

export interface FailedTurnResult extends BaseTurnResult {
  readonly status: 'failed';
  readonly safeError: SafeAgentError;
  readonly specialistOutcomes: readonly SpecialistOutcome[];
  readonly usage: AgentUsage;
}

export type TurnResult =
  CompletedTurnResult | ApprovalTurnResult | FailedTurnResult;

export interface ModelResolver {
  resolve(input: {
    readonly triggers: readonly ModelEscalationTrigger[];
    readonly policy: ModelRoutingPolicy;
  }): Promise<ModelResolution>;
}

export interface ApprovalCheckpointGateway {
  create(
    input: ApprovalCheckpointIdentity & {
      readonly ttlMs: number;
      readonly serializedState: string;
    },
  ): Promise<ApprovalCheckpointView>;
  consumeForResume(
    input: ApprovalCheckpointIdentity,
    validateDecryptedState?: (
      state: Readonly<unknown>,
    ) => boolean | Promise<boolean>,
  ): Promise<
    | Readonly<{
        status: 'resumed';
        serializedState: string;
        checkpoint: ApprovalCheckpointView;
      }>
    | Readonly<{
        status: 'already-consumed' | 'expired' | 'mismatch' | 'not-found';
      }>
  >;
  cancel(input: {
    readonly checkpointId: string;
    readonly householdId: string;
    readonly userId: string;
  }): Promise<ApprovalCheckpointView | Readonly<{ status: 'not-found' }>>;
}

export interface AgentOrchestratorOptions {
  readonly manager: CompiledAgent;
  readonly specialists: readonly CompiledAgent[];
  readonly executionProvider: AgentExecutionProvider;
  readonly modelRouter: ModelResolver;
  readonly memory: ManagerConversationMemory;
  readonly traceRecorder: LocalTraceRecorder;
  readonly approvalCheckpoints: ApprovalCheckpointGateway;
  readonly proposalGateway: ProviderWriteProposalGateway;
  readonly disclosureGateway: ModelDisclosureGateway;
  readonly agentGraphHash: string;
  readonly sdkVersion: string;
  readonly createCheckpointId?: () => string;
  readonly checkpointTtlMs?: number;
  readonly clock?: () => Date;
}

interface Delegation {
  readonly id: string;
  readonly specialistId: string;
  readonly input: JsonValue;
  readonly dependsOn: readonly string[];
}

interface ManagerPlan {
  readonly delegations: readonly Delegation[];
  readonly directResponse?: JsonValue;
}

interface CollectedPausedExecution {
  readonly phase: 'plan' | 'specialist' | 'synthesize';
  readonly executionKey: string;
  readonly agentId: string;
  readonly serializedState: string;
  readonly interruptions: readonly AgentProviderInterruption[];
  readonly usage: AgentUsage;
  readonly capabilityCalls: number;
  readonly disclosureGrantId: string;
  readonly disclosureGrantVersion: string;
  readonly authorizationScopeFingerprint?: EffectiveAuthorizationScopeFingerprint;
}

interface PausedExecution extends CollectedPausedExecution {
  readonly authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
}

interface ModelDisclosureBinding {
  readonly grantId: string;
  readonly grantVersion: string;
}

type RuntimeProviderResult =
  | Readonly<
      Extract<AgentProviderResult, { status: 'completed' }> & {
        readonly disclosure: ModelDisclosureBinding;
      }
    >
  | Readonly<
      Extract<AgentProviderResult, { status: 'interrupted' }> & {
        readonly disclosure: ModelDisclosureBinding;
      }
    >
  | Extract<AgentProviderResult, { status: 'failed' }>;

type RuntimeFallbackCause =
  'failed-output-validation' | 'luna-execution-failed';

const fallbackTrigger = (
  cause: RuntimeFallbackCause,
): ModelEscalationTrigger =>
  cause === 'failed-output-validation'
    ? 'failed-output-validation'
    : 'luna-unavailable';

type SpecialistProviderExecution =
  | Readonly<{
      status: 'result';
      result: Exclude<RuntimeProviderResult, { status: 'failed' }>;
      modelResolution: Extract<ModelResolution, { status: 'resolved' }>;
    }>
  | Readonly<{
      status: 'failed';
      safeError: SafeAgentError;
      usage: AgentUsage;
    }>;

interface PersistedTurnScope {
  readonly requestId: string;
  readonly runId: string;
  readonly householdId: string;
  readonly userId: string;
  readonly authenticatedSessionId: string;
  readonly conversationId: string;
  readonly spaceAccessGrantId: string;
  readonly authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
  readonly locale: SupportedLocale;
  readonly message: string;
  readonly currentMessage: ConversationMemoryEntry;
}

interface PreparedTurnInput extends TurnInput {
  readonly currentMessage: ConversationMemoryEntry;
}

interface RuntimeCheckpointState {
  readonly version: 5;
  readonly turn: PersistedTurnScope;
  readonly modelResolution: Extract<ModelResolution, { status: 'resolved' }>;
  readonly plan?: ManagerPlan;
  readonly outcomes: readonly SpecialistOutcome[];
  readonly paused: readonly PausedExecution[];
  readonly usage: AgentUsage;
}

const ZERO_USAGE: AgentUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  modelCostCadMinor: 0,
});

const safeError = (
  code: string,
  message: string,
  retryable: boolean,
): SafeAgentError => Object.freeze({ code, message, retryable });

const checkpointCancellationConfirmed = (
  cancellation: ApprovalCheckpointView | Readonly<{ status: 'not-found' }>,
): boolean =>
  'status' in cancellation
    ? cancellation.status === 'not-found'
    : cancellation.state === 'cancelled' || cancellation.state === 'expired';

const checkpointCancellationRejectedAsNotFound = (reason: unknown): boolean =>
  reason instanceof Error && reason.message === 'approval-checkpoint-not-found';

const terminalProviderFailure = (
  result: Extract<AgentProviderResult, { status: 'failed' }>,
): SafeAgentError | undefined => {
  switch (result.reason) {
    case 'token-budget-exceeded':
      return safeError(
        'agent-token-budget-exceeded',
        'The agent stopped because its token budget was exceeded.',
        false,
      );
    case 'capability-budget-exceeded':
      return safeError(
        'agent-capability-budget-exceeded',
        'The agent stopped because its capability-call budget was exceeded.',
        false,
      );
    case 'monthly-spend-limit-reached':
      return safeError(
        'monthly-ai-spend-limit-reached',
        'The monthly AI spend limit has been reached.',
        false,
      );
    case 'spend-authorization-failed':
      return safeError(
        'model-spend-authorization-failed',
        'The model run could not be authorized for spending.',
        false,
      );
    case 'disclosure-denied':
      return safeError(
        'model-disclosure-denied',
        'The requested data could not be disclosed to the model safely.',
        false,
      );
    case 'multiple-provider-writes':
      return safeError(
        'multiple-provider-writes-require-separate-turns',
        'Each provider write requires a separate assistant turn and visual approval.',
        false,
      );
    case 'proposal-finalization-pending':
      return safeError(
        'provider-write-proposal-finalization-pending',
        'A prepared external action could not be terminalized safely. Reconciliation is required before retrying.',
        false,
      );
    case 'execution-failed':
    case 'timeout':
      return undefined;
  }
};

const addUsage = (left: AgentUsage, right: AgentUsage): AgentUsage => {
  const inputTokens = left.inputTokens + right.inputTokens;
  const outputTokens = left.outputTokens + right.outputTokens;
  const modelCostCadMinor = left.modelCostCadMinor + right.modelCostCadMinor;
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    !Number.isSafeInteger(modelCostCadMinor)
  ) {
    throw new Error('agent-usage-overflow');
  }
  return Object.freeze({
    inputTokens,
    outputTokens,
    modelCostCadMinor,
    ...(left.spendWarning === true || right.spendWarning === true
      ? { spendWarning: true as const }
      : {}),
  });
};

const uniqueDataClasses = (
  ...catalogs: readonly (readonly string[])[]
): readonly string[] => Object.freeze([...new Set(catalogs.flat())].sort());

const snapshotJson = (raw: unknown): JsonValue => {
  let nodes = 0;
  let text = 0;
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > 4_096 || depth > 16) throw new Error('invalid-agent-json');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('invalid-agent-json');
      return value;
    }
    if (typeof value === 'string') {
      text += value.length;
      if (text > 262_144) throw new Error('invalid-agent-json');
      return value;
    }
    if (typeof value !== 'object') throw new Error('invalid-agent-json');
    if (seen.has(value)) throw new Error('invalid-agent-json');
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 512) throw new Error('invalid-agent-json');
      return Object.freeze(value.map((entry) => visit(entry, depth + 1)));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('invalid-agent-json');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error('invalid-agent-json');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length > 128) throw new Error('invalid-agent-json');
    const output: Record<string, JsonValue> = {};
    for (const key of keys.sort()) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !('value' in descriptor)
      ) {
        throw new Error('invalid-agent-json');
      }
      text += key.length;
      output[key] = visit(descriptor.value as unknown, depth + 1);
    }
    return Object.freeze(output);
  };
  return visit(raw, 0);
};

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] =>
  Array.isArray(value);

const asObject = (value: JsonValue): Readonly<Record<string, JsonValue>> => {
  if (value === null || isJsonArray(value) || typeof value !== 'object') {
    throw new Error('invalid-agent-object');
  }
  return value;
};

const assertExactKeys = (
  value: Readonly<Record<string, JsonValue>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const keys = Object.keys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new Error('invalid-agent-object');
  }
};

const assertUuid = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error('invalid-turn-input');
  }
  return value;
};

const snapshotPreparedProposal = (
  raw: unknown,
): PreparedProviderWriteProposal => {
  const value = asObject(snapshotJson(raw));
  assertExactKeys(value, [
    'proposalId',
    'providerAuthorityBindingHash',
    'authorizationScopeFingerprint',
    'preview',
  ]);
  if (
    typeof value.providerAuthorityBindingHash !== 'string' ||
    !SHA256_PATTERN.test(value.providerAuthorityBindingHash)
  ) {
    throw new Error('invalid-provider-authority-binding-hash');
  }
  return Object.freeze({
    proposalId: assertUuid(value.proposalId),
    providerAuthorityBindingHash: value.providerAuthorityBindingHash,
    authorizationScopeFingerprint:
      EffectiveAuthorizationScopeFingerprintSchema.parse(
        value.authorizationScopeFingerprint,
      ),
    preview: snapshotJson(value.preview),
  });
};

const snapshotPreparedProposalAbandonment = (
  raw: unknown,
): PreparedProviderWriteAbandonment => {
  const value = asObject(snapshotJson(raw));
  assertExactKeys(value, ['status']);
  if (
    value.status !== 'abandoned' &&
    value.status !== 'already-abandoned' &&
    value.status !== 'not-abandonable'
  ) {
    throw new Error('invalid-prepared-proposal-abandonment');
  }
  return Object.freeze({ status: value.status });
};

const snapshotCanonicalDisclosurePayload = (
  raw: unknown,
  auditRecords: ModelDisclosureAuthorization['records'],
): JsonValue => {
  const envelope = asObject(snapshotJson(raw));
  assertExactKeys(envelope, ['schemaVersion', 'records']);
  if (
    envelope.schemaVersion !== 1 ||
    !Array.isArray(envelope.records) ||
    envelope.records.length !== auditRecords.length ||
    envelope.records.length === 0 ||
    envelope.records.length > 256
  ) {
    throw new Error('invalid-model-disclosure-authorization');
  }
  const records = Object.freeze(
    envelope.records.map((rawRecord, index) => {
      const record = asObject(rawRecord);
      assertExactKeys(record, ['dataClass', 'recordId', 'fields']);
      const fields = asObject(record.fields);
      const fieldNames = Object.keys(fields);
      if (
        fieldNames.length === 0 ||
        fieldNames.length > 128 ||
        fieldNames.some((field) => assertDisclosurePath(field) !== field) ||
        fieldNames.some(
          (field, fieldIndex) => field !== [...fieldNames].sort()[fieldIndex],
        )
      ) {
        throw new Error('invalid-model-disclosure-authorization');
      }
      const dataClass = assertDisclosurePath(record.dataClass);
      const recordId = assertDisclosurePath(record.recordId);
      const audit = auditRecords[index];
      if (
        audit === undefined ||
        audit.dataClass !== dataClass ||
        audit.recordId !== recordId ||
        audit.fields.length !== fieldNames.length ||
        audit.fields.some(
          (field, fieldIndex) => field !== fieldNames[fieldIndex],
        )
      ) {
        throw new Error('invalid-model-disclosure-authorization');
      }
      return Object.freeze({
        dataClass,
        recordId,
        fields: Object.freeze(
          Object.fromEntries(
            fieldNames.map((field) => [field, snapshotJson(fields[field])]),
          ),
        ),
      });
    }),
  );
  const bindings = records.map(
    ({ dataClass, recordId }) => `${dataClass}\0${recordId}`,
  );
  if (
    new Set(bindings).size !== bindings.length ||
    bindings.some((binding, index) => binding !== [...bindings].sort()[index])
  ) {
    throw new Error('invalid-model-disclosure-authorization');
  }
  return Object.freeze({ schemaVersion: 1, records });
};

const snapshotDisclosureAuthorization = (
  raw: unknown,
): ModelDisclosureDecision => {
  const value = asObject(snapshotJson(raw));
  if (value.status === 'denied') {
    assertExactKeys(value, ['status', 'reason'], ['grantId']);
    const reasons = new Set<ModelDisclosureDenialReason>([
      'grant-not-found',
      'grant-run-mismatch',
      'grant-household-mismatch',
      'grant-user-mismatch',
      'grant-agent-mismatch',
      'grant-purpose-mismatch',
      'grant-invocation-mismatch',
      'grant-provider-mismatch',
      'grant-expired',
      'record-not-allowed',
      'field-not-allowed',
      'no-active-grant',
    ]);
    if (!reasons.has(value.reason as ModelDisclosureDenialReason)) {
      throw new Error('invalid-model-disclosure-denial');
    }
    const reason = value.reason as ModelDisclosureDenialReason;
    if (reason === 'no-active-grant') {
      return Object.freeze({
        status: 'denied',
        reason,
        ...(value.grantId === undefined
          ? {}
          : { grantId: assertUuid(value.grantId) }),
      });
    }
    if (value.grantId === undefined) {
      throw new Error('invalid-model-disclosure-denial');
    }
    return Object.freeze({
      status: 'denied',
      grantId: assertUuid(value.grantId),
      reason,
    });
  }
  assertExactKeys(value, [
    'status',
    'grantId',
    'grantVersion',
    'runId',
    'householdId',
    'userId',
    'agentId',
    'phasePurpose',
    'phaseInvocationId',
    'disclosurePurpose',
    'provider',
    'expiresAt',
    'records',
    'payload',
  ]);
  if (
    typeof value.grantVersion !== 'string' ||
    !SEMVER_PATTERN.test(value.grantVersion) ||
    (value.phasePurpose !== 'manager-plan' &&
      value.phasePurpose !== 'specialist-execution' &&
      value.phasePurpose !== 'manager-synthesis') ||
    typeof value.disclosurePurpose !== 'string' ||
    value.disclosurePurpose.trim().length === 0 ||
    value.disclosurePurpose.length > 500 ||
    value.provider !== 'openai' ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    value.status !== 'authorized' ||
    !Array.isArray(value.records) ||
    value.records.length > 256
  ) {
    throw new Error('invalid-model-disclosure-authorization');
  }
  const records = Object.freeze(
    value.records.map((rawRecord) => {
      const record = asObject(rawRecord);
      assertExactKeys(record, ['dataClass', 'recordId', 'fields']);
      if (
        !Array.isArray(record.fields) ||
        record.fields.length === 0 ||
        record.fields.length > 128
      ) {
        throw new Error('invalid-model-disclosure-authorization');
      }
      const fields = Object.freeze(
        record.fields.map((field) => assertDisclosurePath(field)),
      );
      if (new Set(fields).size !== fields.length) {
        throw new Error('invalid-model-disclosure-authorization');
      }
      return Object.freeze({
        dataClass: assertDisclosurePath(record.dataClass),
        recordId: assertDisclosurePath(record.recordId),
        fields,
      });
    }),
  );
  const recordBindings = records.map(
    ({ dataClass, recordId }) => `${dataClass}\0${recordId}`,
  );
  if (new Set(recordBindings).size !== recordBindings.length) {
    throw new Error('invalid-model-disclosure-authorization');
  }
  return Object.freeze({
    status: 'authorized',
    grantId: assertUuid(value.grantId),
    grantVersion: value.grantVersion,
    runId: assertUuid(value.runId),
    householdId: assertUuid(value.householdId),
    userId: assertUuid(value.userId),
    agentId: assertIdentifier(value.agentId),
    phasePurpose: value.phasePurpose,
    phaseInvocationId: assertIdentifier(value.phaseInvocationId),
    disclosurePurpose: value.disclosurePurpose,
    provider: value.provider,
    expiresAt: value.expiresAt,
    records,
    payload: snapshotCanonicalDisclosurePayload(value.payload, records),
  });
};

const snapshotDecisionExecution = (
  raw: unknown,
): ProviderWriteDecisionExecution => {
  const value = asObject(snapshotJson(raw));
  assertExactKeys(value, ['outcome', 'output', 'idempotencyKey']);
  if (
    value.outcome !== 'executed-readback-verified' &&
    value.outcome !== 'rejected'
  ) {
    throw new Error('invalid-provider-write-decision-execution');
  }
  return Object.freeze({
    outcome: value.outcome,
    output: snapshotJson(value.output),
    idempotencyKey: assertIdentifier(value.idempotencyKey),
  });
};

const assertIdentifier = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length < 2 ||
    value.length > 160 ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new Error('invalid-agent-identifier');
  }
  return value;
};

const assertDisclosurePath = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length > 160 ||
    !DISCLOSURE_PATH_PATTERN.test(value)
  ) {
    throw new Error('invalid-model-disclosure-authorization');
  }
  return value;
};

const snapshotExecutionContext = (raw: unknown): AgentExecutionContext => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid-agent-execution-context');
  }
  const value = raw as Partial<AgentExecutionContext>;
  if (typeof value.abortSignal?.aborted !== 'boolean') {
    throw new Error('invalid-agent-execution-context');
  }
  return Object.freeze({
    requestId: assertUuid(value.requestId),
    runId: assertUuid(value.runId),
    householdId: assertUuid(value.householdId),
    userId: assertUuid(value.userId),
    authenticatedSessionId: assertUuid(value.authenticatedSessionId),
    spaceAccessGrantId: assertUuid(value.spaceAccessGrantId),
    authorizationScopeFingerprint:
      EffectiveAuthorizationScopeFingerprintSchema.parse(
        value.authorizationScopeFingerprint,
      ),
    locale: SupportedLocaleSchema.parse(value.locale),
    ...(value.disclosureGrantId === undefined
      ? {}
      : { disclosureGrantId: assertUuid(value.disclosureGrantId) }),
    ...(value.disclosureGrantVersion === undefined
      ? {}
      : {
          disclosureGrantVersion:
            typeof value.disclosureGrantVersion === 'string' &&
            SEMVER_PATTERN.test(value.disclosureGrantVersion)
              ? value.disclosureGrantVersion
              : (() => {
                  throw new Error('invalid-agent-execution-context');
                })(),
        }),
    ...(value.approvalDecisionId === undefined
      ? {}
      : { approvalDecisionId: assertUuid(value.approvalDecisionId) }),
    agentId: assertIdentifier(value.agentId),
    abortSignal: value.abortSignal,
  });
};

const snapshotCapabilityInvocationContext = (
  raw: unknown,
): CapabilityInvocationContext => {
  const context = snapshotExecutionContext(raw);
  return Object.freeze({
    requestId: context.requestId,
    runId: context.runId,
    userId: context.userId,
    householdId: context.householdId,
    sessionId: context.authenticatedSessionId,
    agentId: context.agentId,
    spaceAccessGrantId: context.spaceAccessGrantId,
    locale: context.locale,
    ...(context.disclosureGrantId === undefined
      ? {}
      : { disclosureGrantId: context.disclosureGrantId }),
    ...(context.approvalDecisionId === undefined
      ? {}
      : { approvalDecisionId: context.approvalDecisionId }),
    abortSignal: context.abortSignal,
  });
};

const snapshotUsage = (raw: unknown): AgentUsage => {
  const value = asObject(snapshotJson(raw));
  assertExactKeys(
    value,
    ['inputTokens', 'outputTokens', 'modelCostCadMinor'],
    ['spendWarning'],
  );
  if (value.spendWarning !== undefined && value.spendWarning !== true) {
    throw new Error('invalid-agent-usage');
  }
  for (const key of [
    'inputTokens',
    'outputTokens',
    'modelCostCadMinor',
  ] as const) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) {
      throw new Error('invalid-agent-usage');
    }
  }
  return Object.freeze({
    inputTokens: value.inputTokens as number,
    outputTokens: value.outputTokens as number,
    modelCostCadMinor: value.modelCostCadMinor as number,
    ...(value.spendWarning === true ? { spendWarning: true as const } : {}),
  });
};

const snapshotCapabilityCalls = (raw: JsonValue | undefined): number => {
  if (raw === undefined) return 0;
  if (!Number.isSafeInteger(raw) || (raw as number) < 0) {
    throw new Error('invalid-agent-provider-result');
  }
  return raw as number;
};

const snapshotProviderResult = (raw: unknown): AgentProviderResult => {
  const value = asObject(snapshotJson(raw));
  if (value.status === 'completed') {
    assertExactKeys(
      value,
      ['status', 'output', 'usage'],
      ['replaySafety', 'capabilityCalls'],
    );
    if (
      value.replaySafety !== undefined &&
      value.replaySafety !== 'safe' &&
      value.replaySafety !== 'unsafe'
    ) {
      throw new Error('invalid-agent-provider-result');
    }
    return Object.freeze({
      status: 'completed',
      output: snapshotJson(value.output),
      usage: snapshotUsage(value.usage),
      ...(value.replaySafety === undefined
        ? {}
        : { replaySafety: value.replaySafety }),
      capabilityCalls: snapshotCapabilityCalls(value.capabilityCalls),
    });
  }
  if (value.status === 'failed') {
    assertExactKeys(
      value,
      ['status', 'reason', 'replaySafety', 'usage'],
      ['capabilityCalls'],
    );
    if (
      (value.reason !== 'execution-failed' &&
        value.reason !== 'timeout' &&
        value.reason !== 'token-budget-exceeded' &&
        value.reason !== 'capability-budget-exceeded' &&
        value.reason !== 'monthly-spend-limit-reached' &&
        value.reason !== 'spend-authorization-failed' &&
        value.reason !== 'disclosure-denied' &&
        value.reason !== 'multiple-provider-writes' &&
        value.reason !== 'proposal-finalization-pending') ||
      (value.replaySafety !== 'safe' && value.replaySafety !== 'unsafe')
    ) {
      throw new Error('invalid-agent-provider-result');
    }
    return Object.freeze({
      status: 'failed',
      reason: value.reason,
      replaySafety: value.replaySafety,
      usage: snapshotUsage(value.usage),
      capabilityCalls: snapshotCapabilityCalls(value.capabilityCalls),
    });
  }
  if (value.status !== 'interrupted') {
    throw new Error('invalid-agent-provider-result');
  }
  assertExactKeys(
    value,
    ['status', 'serializedState', 'interruptions', 'usage'],
    ['capabilityCalls'],
  );
  if (
    typeof value.serializedState !== 'string' ||
    value.serializedState.length === 0 ||
    value.serializedState.length > 786_432
  ) {
    throw new Error('invalid-agent-provider-result');
  }
  try {
    const parsed: unknown = JSON.parse(value.serializedState);
    if (parsed === null || typeof parsed !== 'object') throw new Error('bad');
  } catch {
    throw new Error('invalid-agent-provider-result');
  }
  if (!Array.isArray(value.interruptions) || value.interruptions.length === 0) {
    throw new Error('invalid-agent-provider-result');
  }
  const interruptions = Object.freeze(
    value.interruptions.map((rawInterruption) => {
      const interruption = asObject(rawInterruption);
      assertExactKeys(
        interruption,
        ['id', 'agentId', 'capabilityId', 'proposalId', 'argumentsPreview'],
        [
          'sdkCallId',
          'providerAuthorityBindingHash',
          'authorizationScopeFingerprint',
        ],
      );
      if (
        (interruption.sdkCallId === undefined) !==
          (interruption.providerAuthorityBindingHash === undefined) ||
        (interruption.sdkCallId === undefined) !==
          (interruption.authorizationScopeFingerprint === undefined) ||
        (interruption.sdkCallId !== undefined &&
          (typeof interruption.sdkCallId !== 'string' ||
            !SDK_CALL_ID_PATTERN.test(interruption.sdkCallId))) ||
        (interruption.providerAuthorityBindingHash !== undefined &&
          (typeof interruption.providerAuthorityBindingHash !== 'string' ||
            !SHA256_PATTERN.test(interruption.providerAuthorityBindingHash)))
      ) {
        throw new Error('invalid-agent-provider-result');
      }
      return Object.freeze({
        id: assertIdentifier(interruption.id),
        agentId: assertIdentifier(interruption.agentId),
        capabilityId: assertIdentifier(interruption.capabilityId),
        proposalId: assertUuid(interruption.proposalId),
        argumentsPreview: snapshotJson(interruption.argumentsPreview),
        ...(interruption.sdkCallId === undefined
          ? {}
          : {
              sdkCallId: interruption.sdkCallId,
              providerAuthorityBindingHash:
                interruption.providerAuthorityBindingHash as string,
              authorizationScopeFingerprint:
                EffectiveAuthorizationScopeFingerprintSchema.parse(
                  interruption.authorizationScopeFingerprint,
                ),
            }),
      });
    }),
  );
  if (
    new Set(interruptions.map((item) => item.id)).size !== interruptions.length
  ) {
    throw new Error('invalid-agent-provider-result');
  }
  return Object.freeze({
    status: 'interrupted',
    serializedState: value.serializedState,
    interruptions,
    usage: snapshotUsage(value.usage),
    capabilityCalls: snapshotCapabilityCalls(value.capabilityCalls),
  });
};

const snapshotTurn = (input: TurnInput): TurnInput => {
  if (input === null || typeof input !== 'object') {
    throw new Error('invalid-turn-input');
  }
  const allowed = [
    'requestId',
    'runId',
    'householdId',
    'userId',
    'authenticatedSessionId',
    'conversationId',
    'spaceAccessGrantId',
    'authorizationScopeFingerprint',
    'locale',
    'message',
    'escalationTriggers',
    'abortSignal',
  ];
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
    allowed.some((key) => descriptors[key] === undefined) ||
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined || descriptor.set !== undefined,
    )
  ) {
    throw new Error('invalid-turn-input');
  }
  if (
    typeof input.message !== 'string' ||
    input.message.trim().length === 0 ||
    input.message.length > MAX_MESSAGE_LENGTH ||
    !Array.isArray(input.escalationTriggers) ||
    typeof input.abortSignal?.aborted !== 'boolean'
  ) {
    throw new Error('invalid-turn-input');
  }
  const allowedTriggers = new Set<RequestedModelEscalationTrigger>([
    'dependent-cross-domain',
    'failed-output-validation',
    'low-confidence-reconciliation',
    'complex-reasoning',
  ]);
  if (
    input.escalationTriggers.some((trigger) => !allowedTriggers.has(trigger))
  ) {
    throw new Error('invalid-turn-input');
  }
  return Object.freeze({
    requestId: assertUuid(input.requestId),
    runId: assertUuid(input.runId),
    householdId: assertUuid(input.householdId),
    userId: assertUuid(input.userId),
    authenticatedSessionId: assertUuid(input.authenticatedSessionId),
    conversationId: assertUuid(input.conversationId),
    spaceAccessGrantId: assertUuid(input.spaceAccessGrantId),
    authorizationScopeFingerprint:
      EffectiveAuthorizationScopeFingerprintSchema.parse(
        input.authorizationScopeFingerprint,
      ),
    locale: SupportedLocaleSchema.parse(input.locale),
    message: input.message,
    escalationTriggers: Object.freeze([...input.escalationTriggers]),
    abortSignal: input.abortSignal,
  });
};

const snapshotConversationEntry = (raw: unknown): ConversationMemoryEntry => {
  const value = asObject(snapshotJson(raw));
  assertExactKeys(value, [
    'id',
    'conversationId',
    'householdId',
    'userId',
    'role',
    'content',
    'createdAt',
  ]);
  if (
    (value.role !== 'user' && value.role !== 'assistant') ||
    typeof value.content !== 'string' ||
    value.content.trim().length === 0 ||
    value.content.length > 16_000 ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    throw new Error('invalid-conversation-memory-entry');
  }
  return Object.freeze({
    id: assertUuid(value.id),
    conversationId: assertUuid(value.conversationId),
    householdId: assertUuid(value.householdId),
    userId: assertUuid(value.userId),
    role: value.role,
    content: value.content,
    createdAt: value.createdAt,
  });
};

const snapshotDisclosureSources = (
  rawSources: readonly ModelDisclosureSource[],
): readonly ModelDisclosureSource[] => {
  if (
    !Array.isArray(rawSources) ||
    rawSources.length === 0 ||
    rawSources.length > 256
  ) {
    throw new Error('invalid-model-disclosure-sources');
  }
  return Object.freeze(
    rawSources.map((raw) => {
      const source = asObject(snapshotJson(raw));
      if (source.kind === 'conversation-message') {
        assertExactKeys(source, ['kind', 'entry']);
        return Object.freeze({
          kind: 'conversation-message' as const,
          entry: snapshotConversationEntry(source.entry),
        });
      }
      if (source.kind === 'manager-plan') {
        assertExactKeys(source, ['kind', 'plan']);
        return Object.freeze({
          kind: 'manager-plan' as const,
          plan: snapshotJson(source.plan),
        });
      }
      if (source.kind === 'specialist-delegation') {
        assertExactKeys(source, ['kind', 'delegation']);
        return Object.freeze({
          kind: 'specialist-delegation' as const,
          delegation: snapshotJson(source.delegation),
        });
      }
      if (source.kind === 'specialist-outcome') {
        assertExactKeys(source, ['kind', 'outcome']);
        return Object.freeze({
          kind: 'specialist-outcome' as const,
          outcome: snapshotJson(source.outcome),
        });
      }
      throw new Error('invalid-model-disclosure-sources');
    }),
  );
};

const disclosureSourceDataClass = (source: ModelDisclosureSource): string => {
  switch (source.kind) {
    case 'conversation-message':
      return CONVERSATION_DATA_CLASS;
    case 'manager-plan':
      return MANAGER_PLAN_DATA_CLASS;
    case 'specialist-delegation':
      return DELEGATION_DATA_CLASS;
    case 'specialist-outcome':
      return SPECIALIST_OUTCOME_DATA_CLASS;
  }
};

const persistedScope = (turn: PreparedTurnInput): PersistedTurnScope =>
  Object.freeze({
    requestId: turn.requestId,
    runId: turn.runId,
    householdId: turn.householdId,
    userId: turn.userId,
    authenticatedSessionId: turn.authenticatedSessionId,
    conversationId: turn.conversationId,
    spaceAccessGrantId: turn.spaceAccessGrantId,
    authorizationScopeFingerprint: turn.authorizationScopeFingerprint,
    locale: turn.locale,
    message: turn.message,
    currentMessage: snapshotConversationEntry(turn.currentMessage),
  });

const parseManagerPlan = (
  raw: JsonValue,
  specialists: ReadonlyMap<string, CompiledAgent>,
  maximumDelegations: number,
): ManagerPlan => {
  const value = asObject(raw);
  assertExactKeys(value, ['delegations'], ['directResponse']);
  if (
    !Array.isArray(value.delegations) ||
    value.delegations.length > maximumDelegations
  ) {
    throw new Error('invalid-manager-plan');
  }
  const delegations = Object.freeze(
    value.delegations.map((rawDelegation) => {
      const item = asObject(rawDelegation);
      assertExactKeys(item, ['id', 'specialistId', 'input', 'dependsOn']);
      const id = assertIdentifier(item.id);
      const specialistId = assertIdentifier(item.specialistId);
      if (!specialists.has(specialistId) || !Array.isArray(item.dependsOn)) {
        throw new Error('invalid-manager-plan');
      }
      const specialist = specialists.get(specialistId)!;
      let parsedInput: unknown;
      try {
        parsedInput = specialist.inputSchema.parse(item.input);
      } catch {
        throw new Error('invalid-manager-plan');
      }
      const dependsOn = Object.freeze(
        item.dependsOn.map((dependency) => assertIdentifier(dependency)),
      );
      if (
        dependsOn.includes(id) ||
        new Set(dependsOn).size !== dependsOn.length
      ) {
        throw new Error('invalid-manager-plan');
      }
      return Object.freeze({
        id,
        specialistId,
        input: snapshotJson(parsedInput),
        dependsOn,
      });
    }),
  );
  const ids = new Set(delegations.map((item) => item.id));
  if (ids.size !== delegations.length) throw new Error('invalid-manager-plan');
  const specialistIds = new Set(delegations.map((item) => item.specialistId));
  if (specialistIds.size !== delegations.length) {
    throw new Error('invalid-manager-plan');
  }
  if (
    delegations.some((item) =>
      item.dependsOn.some((dependency) => !ids.has(dependency)),
    )
  ) {
    throw new Error('invalid-manager-plan');
  }
  const resolved = new Set<string>();
  while (resolved.size < delegations.length) {
    const ready = delegations.filter(
      (item) =>
        !resolved.has(item.id) &&
        item.dependsOn.every((dependency) => resolved.has(dependency)),
    );
    if (ready.length === 0) throw new Error('invalid-manager-plan');
    for (const item of ready) resolved.add(item.id);
  }
  return Object.freeze({
    delegations,
    ...(value.directResponse === undefined
      ? {}
      : { directResponse: snapshotJson(value.directResponse) }),
  });
};

const publicInterruptions = (
  paused: readonly CollectedPausedExecution[],
): readonly RuntimeInterruption[] =>
  Object.freeze(
    paused.flatMap((execution) =>
      execution.interruptions.map((interruption) =>
        Object.freeze({
          id: `${execution.executionKey}:${interruption.id}`,
          agentId: interruption.agentId,
          capabilityId: interruption.capabilityId,
          proposalId: interruption.proposalId,
          argumentsPreview: interruption.argumentsPreview,
        }),
      ),
    ),
  );

const outputForMemory = (output: JsonValue): string => {
  if (typeof output === 'string') return output;
  if (output !== null && !isJsonArray(output) && typeof output === 'object') {
    for (const key of ['message', 'text', 'summary']) {
      const value = output[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  const serialized = JSON.stringify(output);
  return serialized.length <= 16_000
    ? serialized
    : 'The assistant completed the request; open the activity details to review the full result.';
};

type OpenAiApprovalItemLike = Pick<
  RunToolApprovalItem,
  'agent' | 'arguments' | 'name' | 'rawItem'
>;

interface OpenAiRunStateLike {
  readonly usage: Readonly<{
    readonly inputTokens: number;
    readonly outputTokens: number;
  }>;
  getInterruptions(): OpenAiApprovalItemLike[];
  approve(item: OpenAiApprovalItemLike): void;
  reject(item: OpenAiApprovalItemLike): void;
  toString(): string;
}

interface OpenAiRunResultLike {
  readonly finalOutput?: unknown;
  readonly interruptions?: readonly OpenAiApprovalItemLike[];
  readonly state: OpenAiRunStateLike;
}

export interface OpenAiAgentsRunnerPort {
  run(
    agent: OpenAiSdkAgent,
    input: string | OpenAiRunStateLike,
    options: Readonly<{
      context?: AgentExecutionContext | RunContext<AgentExecutionContext>;
      maxTurns: number;
      signal: AbortSignal;
      toolNameCollisionPolicy: 'error';
    }>,
  ): Promise<OpenAiRunResultLike>;
}

export interface OpenAiAgentsStateCodec {
  fromStringWithContext(
    agent: OpenAiSdkAgent,
    serializedState: string,
    context: RunContext<AgentExecutionContext>,
  ): Promise<OpenAiRunStateLike>;
}

export interface OpenAiAgentCostCalculator {
  calculateCadMinor(
    input: Readonly<{
      model: EmdoModelId;
      inputTokens: number;
      outputTokens: number;
    }>,
  ): number;
}

export interface OpenAiAgentInputTokenCounter {
  countUpperBound(
    input: Readonly<{
      agent: OpenAiSdkAgent;
      input: JsonValue;
      serializedResumeState?: string;
    }>,
  ): number;
}

/**
 * Conservative pre-dispatch bound: token count cannot exceed the serialized
 * UTF-8 byte count, and the fixed allowance covers request/message framing.
 */
export const createConservativeOpenAiInputTokenCounter =
  (): OpenAiAgentInputTokenCounter => {
    const counter: OpenAiAgentInputTokenCounter = {
      countUpperBound: (request) => {
        const { agent, input, serializedResumeState } = request;
        if (typeof agent.instructions !== 'string')
          return Number.MAX_SAFE_INTEGER;
        try {
          const serialized = JSON.stringify({
            instructions: agent.instructions,
            input,
            ...(serializedResumeState === undefined
              ? {}
              : { serializedResumeState }),
            tools: agent.tools.map((candidate) =>
              candidate.type === 'function'
                ? {
                    name: candidate.name,
                    description: candidate.description,
                    parameters: candidate.parameters,
                  }
                : { type: candidate.type },
            ),
          });
          const bytes = new TextEncoder().encode(serialized).byteLength;
          const upperBound = bytes + 1_024;
          return Number.isSafeInteger(upperBound)
            ? upperBound
            : Number.MAX_SAFE_INTEGER;
        } catch {
          return Number.MAX_SAFE_INTEGER;
        }
      },
    };
    return Object.freeze(counter);
  };

export interface OpenAiAgentsExecutionProviderOptions {
  readonly proposalGateway: ProviderWriteProposalGateway;
  readonly costCalculator: OpenAiAgentCostCalculator;
  readonly spendGuard: Pick<
    SpendGuard,
    'reserve' | 'markDispatched' | 'settle' | 'release'
  >;
  readonly inputTokenCounter?: OpenAiAgentInputTokenCounter;
  readonly runner?: OpenAiAgentsRunnerPort;
  readonly stateCodec?: OpenAiAgentsStateCodec;
}

const sdkInterruptionId = (callId: string): string => {
  if (!SDK_CALL_ID_PATTERN.test(callId)) {
    throw new Error('invalid-sdk-call-id');
  }
  return `approval-${createHash('sha256').update(callId).digest('hex').slice(0, 32)}`;
};

const sdkCallId = (item: OpenAiApprovalItemLike): string => {
  const raw = item.rawItem as { readonly callId?: unknown };
  if (typeof raw.callId !== 'string') throw new Error('invalid-sdk-call-id');
  return raw.callId;
};

const modelSpendReservationId = (
  request: AgentProviderRequest,
  effectivePhase: Exclude<AgentExecutionPhase, 'resume'>,
): string => {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        requestId: request.context.requestId,
        runId: request.context.runId,
        agentId: request.agent.manifest.id,
        phase: effectivePhase,
        model: request.model,
        input: request.input,
        ...(request.resume === undefined
          ? {}
          : {
              interruptionId: request.resume.decision.interruptionId,
              proposalId: request.resume.decision.proposalId,
              approvalDecisionId: request.resume.decision.approvalDecisionId,
            }),
      }),
    )
    .digest('hex');
  return `reservation-${digest}`;
};

type ModelSpendPreparation =
  | Readonly<{
      status: 'ready';
      reservationId: string;
      estimatedCadMinor: number;
      warning: boolean;
    }>
  | Readonly<{
      status: 'failed';
      reason: 'monthly-spend-limit-reached' | 'spend-authorization-failed';
      replaySafety: AgentProviderReplaySafety;
    }>;

const actualRunnerPort = (): OpenAiAgentsRunnerPort => {
  const runner = new Runner({
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
  });
  const port: OpenAiAgentsRunnerPort = {
    run: (agent, input, options) =>
      runner.run(
        agent,
        input as string | RunState<AgentExecutionContext, OpenAiSdkAgent>,
        options,
      ) as unknown as Promise<OpenAiRunResultLike>,
  };
  return Object.freeze(port);
};

const actualStateCodec = (): OpenAiAgentsStateCodec => {
  const codec: OpenAiAgentsStateCodec = {
    fromStringWithContext: async (agent, serializedState, context) =>
      (await RunState.fromStringWithContext(agent, serializedState, context, {
        contextStrategy: 'replace',
      })) as unknown as OpenAiRunStateLike,
  };
  return Object.freeze(codec);
};

/** Genuine @openai/agents 0.14.3 execution boundary; tests inject only ports. */
export class OpenAiAgentsExecutionProvider implements AgentExecutionProvider {
  readonly sdkVersion = '0.14.3';
  readonly #proposalGateway: ProviderWriteProposalGateway;
  readonly #calculateCost: OpenAiAgentCostCalculator['calculateCadMinor'];
  readonly #runner: OpenAiAgentsRunnerPort;
  readonly #stateCodec: OpenAiAgentsStateCodec;
  readonly #reserveSpend: SpendGuard['reserve'];
  readonly #markSpendDispatched: SpendGuard['markDispatched'];
  readonly #settleSpend: SpendGuard['settle'];
  readonly #releaseSpend: SpendGuard['release'];
  readonly #countInputTokens: OpenAiAgentInputTokenCounter['countUpperBound'];

  constructor(options: OpenAiAgentsExecutionProviderOptions) {
    if (
      typeof options?.proposalGateway?.prepare !== 'function' ||
      typeof options?.proposalGateway?.resolvePrepared !== 'function' ||
      typeof options.proposalGateway.abandonPrepared !== 'function' ||
      typeof options.proposalGateway.validateDecision !== 'function' ||
      typeof options.proposalGateway.executeDecision !== 'function' ||
      typeof options.costCalculator?.calculateCadMinor !== 'function' ||
      typeof options.spendGuard?.reserve !== 'function' ||
      typeof options.spendGuard.markDispatched !== 'function' ||
      typeof options.spendGuard.settle !== 'function' ||
      typeof options.spendGuard.release !== 'function' ||
      (options.inputTokenCounter !== undefined &&
        typeof options.inputTokenCounter.countUpperBound !== 'function') ||
      (options.runner !== undefined &&
        typeof options.runner.run !== 'function') ||
      (options.stateCodec !== undefined &&
        typeof options.stateCodec.fromStringWithContext !== 'function')
    ) {
      throw new Error('invalid-openai-execution-provider-dependency');
    }
    this.#proposalGateway = options.proposalGateway;
    this.#calculateCost = options.costCalculator.calculateCadMinor.bind(
      options.costCalculator,
    );
    this.#runner = options.runner ?? actualRunnerPort();
    this.#stateCodec = options.stateCodec ?? actualStateCodec();
    this.#reserveSpend = options.spendGuard.reserve.bind(options.spendGuard);
    this.#markSpendDispatched = options.spendGuard.markDispatched.bind(
      options.spendGuard,
    );
    this.#settleSpend = options.spendGuard.settle.bind(options.spendGuard);
    this.#releaseSpend = options.spendGuard.release.bind(options.spendGuard);
    const tokenCounter =
      options.inputTokenCounter ?? createConservativeOpenAiInputTokenCounter();
    this.#countInputTokens = tokenCounter.countUpperBound.bind(tokenCounter);
  }

  async #prepareModelSpend(
    request: AgentProviderRequest,
    effectivePhase: Exclude<AgentExecutionPhase, 'resume'>,
  ): Promise<ModelSpendPreparation> {
    const estimatedCadMinor = this.#calculateCost({
      model: request.model,
      inputTokens: request.agent.manifest.executionBudget.maxInputTokens,
      outputTokens: request.agent.manifest.executionBudget.maxOutputTokens,
    });
    if (!Number.isSafeInteger(estimatedCadMinor) || estimatedCadMinor <= 0) {
      return Object.freeze({
        status: 'failed',
        reason: 'spend-authorization-failed',
        replaySafety: 'safe',
      });
    }
    const reservationId = modelSpendReservationId(request, effectivePhase);
    let reserved: Awaited<ReturnType<SpendGuard['reserve']>>;
    try {
      reserved = await this.#reserveSpend({
        executionId: request.context.runId,
        reservationId,
        estimatedCadMinor,
      });
    } catch {
      return Object.freeze({
        status: 'failed',
        reason: 'spend-authorization-failed',
        replaySafety: 'safe',
      });
    }
    if (reserved.status === 'blocked') {
      return Object.freeze({
        status: 'failed',
        reason: 'monthly-spend-limit-reached',
        replaySafety: 'safe',
      });
    }
    if (reserved.status !== 'reserved') {
      return Object.freeze({
        status: 'failed',
        reason: 'spend-authorization-failed',
        replaySafety:
          reserved.status === 'dispatched' || reserved.status === 'settled'
            ? 'unsafe'
            : 'safe',
      });
    }
    return Object.freeze({
      status: 'ready',
      reservationId,
      estimatedCadMinor,
      warning: reserved.warning,
    });
  }

  async #settleModelSpend(
    request: AgentProviderRequest,
    reservationId: string,
    actualCadMinor: number,
  ): Promise<boolean> {
    try {
      const settled = await this.#settleSpend({
        executionId: request.context.runId,
        reservationId,
        actualCadMinor,
      });
      return settled.status === 'settled';
    } catch {
      return false;
    }
  }

  async #releaseModelSpend(
    request: AgentProviderRequest,
    reservationId: string,
  ): Promise<boolean> {
    try {
      const released = await this.#releaseSpend({
        executionId: request.context.runId,
        reservationId,
      });
      return released.status === 'released';
    } catch {
      return false;
    }
  }

  async execute(request: AgentProviderRequest): Promise<AgentProviderResult> {
    if (request.context.abortSignal.aborted)
      throw new Error('agent-run-aborted');
    const turnProviderWrites =
      request.turnProviderWriteLedger ?? createTurnProviderWriteEffectLedger();
    const deadlineSignal = AbortSignal.timeout(
      request.agent.manifest.executionBudget.timeoutMs,
    );
    const dispatchAuditAbort = new AbortController();
    const executionContext = Object.freeze({
      ...request.context,
      abortSignal: AbortSignal.any([
        request.context.abortSignal,
        deadlineSignal,
        dispatchAuditAbort.signal,
        turnProviderWrites.abortController.signal,
      ]),
    });
    const effectivePhase =
      request.phase === 'resume'
        ? request.resume?.decision.originalPhase
        : request.phase;
    if (effectivePhase === undefined) {
      throw new Error('invalid-agent-resume-phase');
    }
    const outputType =
      effectivePhase === 'plan'
        ? MANAGER_PLAN_OUTPUT_SCHEMA
        : request.agent.outputSchema;
    const exposeCapabilities = effectivePhase === 'specialist';
    const materialized = request.agent.materialize(request.model, {
      exposeCapabilities,
      outputType,
      ...(effectivePhase === 'synthesize'
        ? {
            trustedInstructions: Object.freeze([
              `Write the final EMDO synthesis in ${request.context.locale}. Keep evidence excerpts in their source language; do not translate those excerpts.`,
            ]),
          }
        : {}),
    });
    if (!(materialized instanceof Agent)) {
      throw new Error('invalid-openai-sdk-agent');
    }
    const sdkAgent = materialized as OpenAiSdkAgent;
    const inputTokenUpperBound = this.#countInputTokens({
      agent: sdkAgent,
      input: request.input,
      ...(request.resume === undefined
        ? {}
        : { serializedResumeState: request.resume.serializedState }),
    });
    if (
      !Number.isSafeInteger(inputTokenUpperBound) ||
      inputTokenUpperBound < 0 ||
      inputTokenUpperBound >
        request.agent.manifest.executionBudget.maxInputTokens
    ) {
      return Object.freeze({
        status: 'failed',
        reason: 'token-budget-exceeded',
        replaySafety: 'safe',
        usage: ZERO_USAGE,
        capabilityCalls:
          request.resume?.decision.priorCapabilityCalls ??
          request.priorCapabilityCalls ??
          0,
      });
    }
    let sdkInput: string | OpenAiRunStateLike;
    let optionsContext:
      AgentExecutionContext | RunContext<AgentExecutionContext> | undefined =
      executionContext;
    let resumedSdkCallId: string | undefined;
    if (request.resume === undefined) {
      sdkInput = JSON.stringify(request.input);
    } else {
      const runContext = new RunContext(executionContext);
      const state = await this.#stateCodec.fromStringWithContext(
        sdkAgent,
        request.resume.serializedState,
        runContext,
      );
      const selected = state
        .getInterruptions()
        .find(
          (item) =>
            sdkInterruptionId(sdkCallId(item)) ===
            request.resume?.decision.interruptionId,
        );
      if (selected === undefined) throw new Error('sdk-interruption-not-found');
      resumedSdkCallId = sdkCallId(selected);
      const binding = await this.#normalizeInterruption(request, selected);
      if (
        binding.proposalId !== request.resume.decision.proposalId ||
        binding.capabilityId !== request.resume.decision.capabilityId ||
        request.context.approvalDecisionId !==
          request.resume.decision.approvalDecisionId ||
        !(await this.#proposalGateway.validateDecision({
          proposalId: binding.proposalId,
          approvalDecisionId: request.resume.decision.approvalDecisionId,
          capabilityId: binding.capabilityId,
          context: request.context,
          preparationContext: request.resume.preparationContext,
          decision: request.resume.decision.decision,
        }))
      ) {
        throw new Error('provider-write-decision-binding-mismatch');
      }
      if (request.resume.decision.decision === 'approve') {
        state.approve(selected);
      } else {
        state.reject(selected);
      }
      sdkInput = state;
      optionsContext = undefined;
    }
    const priorCapabilityCalls =
      request.resume?.decision.priorCapabilityCalls ??
      request.priorCapabilityCalls ??
      0;
    if (
      !Number.isSafeInteger(priorCapabilityCalls) ||
      priorCapabilityCalls < 0 ||
      priorCapabilityCalls >
        request.agent.manifest.executionBudget.maxCapabilityCalls
    ) {
      throw new Error('invalid-agent-capability-call-count');
    }
    const spend = await this.#prepareModelSpend(request, effectivePhase);
    if (spend.status === 'failed') {
      return Object.freeze({
        status: 'failed',
        reason: spend.reason,
        replaySafety: spend.replaySafety,
        usage: ZERO_USAGE,
        capabilityCalls: priorCapabilityCalls,
      });
    }
    const effectLedger: AgentExecutionEffectLedger = {
      consequentialCapabilityInvoked: false,
      capabilityCalls: priorCapabilityCalls,
      maxCapabilityCalls:
        request.agent.manifest.executionBudget.maxCapabilityCalls,
      seenCallIds: new Set(
        resumedSdkCallId === undefined ? [] : [resumedSdkCallId],
      ),
      capabilityBudgetExceeded: false,
      turnProviderWrites,
    };
    executionEffectLedgers.set(executionContext, effectLedger);
    const failAfterPreparedProposalCleanup = async (
      failure: Extract<AgentProviderResult, { readonly status: 'failed' }>,
      reason: ProviderWriteProposalAbandonmentReason = 'execution-ended-before-checkpoint',
    ): Promise<Extract<AgentProviderResult, { readonly status: 'failed' }>> => {
      if (
        await abandonPreparedProviderWrite(
          this.#proposalGateway,
          turnProviderWrites,
          reason,
        )
      ) {
        return failure;
      }
      return Object.freeze({
        status: 'failed',
        reason: 'proposal-finalization-pending',
        replaySafety: 'unsafe',
        usage: failure.usage,
        capabilityCalls:
          failure.capabilityCalls ?? effectLedger.capabilityCalls,
      });
    };
    let result: OpenAiRunResultLike;
    let spendMarkedDispatched = false;
    let modelIoInitiated = false;
    try {
      if (executionContext.abortSignal.aborted) {
        throw new Error('agent-run-aborted-before-model-dispatch');
      }
      await request.beforeModelDispatch?.();
      if (executionContext.abortSignal.aborted) {
        throw new Error('agent-run-aborted-before-model-dispatch');
      }
      const dispatched = await this.#markSpendDispatched({
        executionId: request.context.runId,
        reservationId: spend.reservationId,
      });
      if (dispatched.status !== 'dispatched') {
        const released =
          dispatched.status === 'reserved'
            ? await this.#releaseModelSpend(request, spend.reservationId)
            : false;
        return Object.freeze({
          status: 'failed',
          reason: 'spend-authorization-failed',
          replaySafety: released ? 'safe' : 'unsafe',
          usage: spend.warning
            ? Object.freeze({ ...ZERO_USAGE, spendWarning: true as const })
            : ZERO_USAGE,
          capabilityCalls: effectLedger.capabilityCalls,
        });
      }
      spendMarkedDispatched = true;
      modelIoInitiated = true;
      const runPromise = this.#runner.run(sdkAgent, sdkInput, {
        ...(optionsContext === undefined ? {} : { context: optionsContext }),
        maxTurns: request.maxTurns,
        signal: executionContext.abortSignal,
        toolNameCollisionPolicy: 'error',
      });
      void runPromise.catch(() => undefined);
      try {
        await request.onModelDispatch?.();
      } catch (error) {
        dispatchAuditAbort.abort(
          new Error('model-dispatch-audit-failed', { cause: error }),
        );
        await runPromise.catch(() => undefined);
        throw error;
      }
      result = await runPromise;
    } catch {
      const spendClosed = spendMarkedDispatched
        ? await this.#settleModelSpend(
            request,
            spend.reservationId,
            spend.estimatedCadMinor,
          )
        : await this.#releaseModelSpend(request, spend.reservationId);
      const failure = Object.freeze({
        status: 'failed' as const,
        reason: turnProviderWrites.proposalFinalizationPending
          ? ('proposal-finalization-pending' as const)
          : !spendClosed
            ? ('spend-authorization-failed' as const)
            : turnProviderWrites.multipleProviderWritesRequested
              ? ('multiple-provider-writes' as const)
              : effectLedger.capabilityBudgetExceeded
                ? ('capability-budget-exceeded' as const)
                : deadlineSignal.aborted
                  ? ('timeout' as const)
                  : ('execution-failed' as const),
        replaySafety: 'unsafe' as const,
        usage: spend.warning
          ? Object.freeze({ ...ZERO_USAGE, spendWarning: true as const })
          : ZERO_USAGE,
        capabilityCalls: effectLedger.capabilityCalls,
      });
      const cleaned = await failAfterPreparedProposalCleanup(
        failure,
        turnProviderWrites.multipleProviderWritesRequested
          ? 'multiple-provider-writes-require-separate-turns'
          : 'execution-ended-before-checkpoint',
      );
      if (request.context.abortSignal.aborted) {
        if (cleaned.reason === 'proposal-finalization-pending') return cleaned;
        throw new Error('agent-run-aborted');
      }
      if (
        cleaned.reason !== 'proposal-finalization-pending' &&
        cleaned.reason !== 'multiple-provider-writes' &&
        spendClosed &&
        !effectLedger.consequentialCapabilityInvoked &&
        !(spendMarkedDispatched && !modelIoInitiated)
      ) {
        return Object.freeze({ ...cleaned, replaySafety: 'safe' as const });
      }
      return cleaned;
    } finally {
      executionEffectLedgers.delete(executionContext);
    }
    let rawUsage: AgentUsage;
    try {
      rawUsage = this.#usage(request.model, result.state.usage);
    } catch {
      return failAfterPreparedProposalCleanup(
        Object.freeze({
          status: 'failed',
          reason: 'execution-failed',
          replaySafety: 'unsafe',
          usage: ZERO_USAGE,
          capabilityCalls: effectLedger.capabilityCalls,
        }),
      );
    }
    const usage = spend.warning
      ? Object.freeze({ ...rawUsage, spendWarning: true as const })
      : rawUsage;
    if (
      !(await this.#settleModelSpend(
        request,
        spend.reservationId,
        usage.modelCostCadMinor,
      ))
    ) {
      return failAfterPreparedProposalCleanup(
        Object.freeze({
          status: 'failed',
          reason: 'spend-authorization-failed',
          replaySafety: 'unsafe',
          usage,
          capabilityCalls: effectLedger.capabilityCalls,
        }),
      );
    }
    const replaySafety = effectLedger.consequentialCapabilityInvoked
      ? 'unsafe'
      : 'safe';
    if (
      usage.inputTokens >
        request.agent.manifest.executionBudget.maxInputTokens ||
      usage.outputTokens >
        request.agent.manifest.executionBudget.maxOutputTokens
    ) {
      return failAfterPreparedProposalCleanup(
        Object.freeze({
          status: 'failed',
          reason: 'token-budget-exceeded',
          replaySafety,
          usage,
          capabilityCalls: effectLedger.capabilityCalls,
        }),
      );
    }
    if (turnProviderWrites.multipleProviderWritesRequested) {
      return failAfterPreparedProposalCleanup(
        Object.freeze({
          status: 'failed',
          reason: 'multiple-provider-writes',
          replaySafety: 'unsafe',
          usage,
          capabilityCalls: effectLedger.capabilityCalls,
        }),
        'multiple-provider-writes-require-separate-turns',
      );
    }
    let interruptions: readonly OpenAiApprovalItemLike[];
    try {
      interruptions = result.interruptions ?? result.state.getInterruptions();
    } catch {
      return failAfterPreparedProposalCleanup(
        Object.freeze({
          status: 'failed',
          reason: 'execution-failed',
          replaySafety,
          usage,
          capabilityCalls: effectLedger.capabilityCalls,
        }),
      );
    }
    if (interruptions.length > 0) {
      if (interruptions.length !== 1) {
        return failAfterPreparedProposalCleanup(
          Object.freeze({
            status: 'failed',
            reason: 'multiple-provider-writes',
            replaySafety: 'unsafe',
            usage,
            capabilityCalls: effectLedger.capabilityCalls,
          }),
          'multiple-provider-writes-require-separate-turns',
        );
      }
      try {
        const normalized = await this.#normalizeInterruption(
          request,
          interruptions[0]!,
        );
        if (turnProviderWrites.providerWritePreparation !== undefined) {
          const prepared = await turnProviderWrites.providerWritePreparation;
          if (prepared === undefined) {
            throw new Error('prepared-proposal-interruption-missing');
          }
          if (
            normalized.sdkCallId !== prepared.sdkCallId ||
            normalized.capabilityId !== prepared.capabilityId ||
            normalized.proposalId !== prepared.proposal.proposalId ||
            normalized.providerAuthorityBindingHash !==
              prepared.proposal.providerAuthorityBindingHash ||
            normalized.authorizationScopeFingerprint !==
              prepared.proposal.authorizationScopeFingerprint
          ) {
            throw new Error('prepared-proposal-interruption-mismatch');
          }
        }
        return Object.freeze({
          status: 'interrupted',
          serializedState: result.state.toString(),
          interruptions: Object.freeze([normalized]),
          usage,
          capabilityCalls: effectLedger.capabilityCalls,
        });
      } catch {
        return failAfterPreparedProposalCleanup(
          Object.freeze({
            status: 'failed',
            reason: 'execution-failed',
            replaySafety: 'unsafe',
            usage,
            capabilityCalls: effectLedger.capabilityCalls,
          }),
        );
      }
    }
    if (turnProviderWrites.providerWritePreparation !== undefined) {
      return failAfterPreparedProposalCleanup(
        Object.freeze({
          status: 'failed',
          reason: 'execution-failed',
          replaySafety: 'unsafe',
          usage,
          capabilityCalls: effectLedger.capabilityCalls,
        }),
      );
    }
    if (result.finalOutput === undefined) {
      return failAfterPreparedProposalCleanup(
        Object.freeze({
          status: 'failed',
          reason: 'execution-failed',
          replaySafety,
          usage,
          capabilityCalls: effectLedger.capabilityCalls,
        }),
      );
    }
    let output: JsonValue;
    try {
      output = snapshotJson(result.finalOutput);
    } catch {
      return failAfterPreparedProposalCleanup(
        Object.freeze({
          status: 'failed',
          reason: 'execution-failed',
          replaySafety,
          usage,
          capabilityCalls: effectLedger.capabilityCalls,
        }),
      );
    }
    return Object.freeze({
      status: 'completed',
      output,
      usage,
      replaySafety,
      capabilityCalls: effectLedger.capabilityCalls,
    });
  }

  #usage(model: EmdoModelId, raw: OpenAiRunStateLike['usage']): AgentUsage {
    const inputTokens = raw.inputTokens;
    const outputTokens = raw.outputTokens;
    if (
      !Number.isSafeInteger(inputTokens) ||
      inputTokens < 0 ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 0
    ) {
      throw new Error('invalid-openai-agent-usage');
    }
    const modelCostCadMinor = this.#calculateCost({
      model,
      inputTokens,
      outputTokens,
    });
    return snapshotUsage({ inputTokens, outputTokens, modelCostCadMinor });
  }

  async #normalizeInterruption(
    request: AgentProviderRequest,
    item: OpenAiApprovalItemLike,
  ): Promise<AgentProviderInterruption> {
    const name = item.name;
    if (typeof name !== 'string') throw new Error('invalid-sdk-interruption');
    const capability = request.agent.capabilities.find(
      ({ descriptor }) => sdkToolNameForCapability(descriptor.id) === name,
    );
    if (
      capability === undefined ||
      capability.descriptor.approval.rule !== 'authenticated-visual-proposal' ||
      (capability.descriptor.capabilityKind !== 'provider-write' &&
        capability.descriptor.capabilityKind !== 'local-write' &&
        capability.descriptor.capabilityKind !== 'import')
    ) {
      throw new Error('invalid-sdk-interruption-capability');
    }
    const callId = sdkCallId(item);
    const prepared = await this.#proposalGateway.resolvePrepared({
      capabilityId: capability.descriptor.id,
      sdkCallId: callId,
      context: request.resume?.preparationContext ?? request.context,
    });
    if (prepared === undefined) throw new Error('prepared-proposal-not-found');
    const proposal = snapshotPreparedProposal(prepared);
    return Object.freeze({
      id: sdkInterruptionId(callId),
      agentId: request.agent.manifest.id,
      capabilityId: capability.descriptor.id,
      proposalId: proposal.proposalId,
      argumentsPreview: proposal.preview,
      sdkCallId: callId,
      providerAuthorityBindingHash: proposal.providerAuthorityBindingHash,
      authorizationScopeFingerprint: proposal.authorizationScopeFingerprint,
    });
  }
}

export class AgentOrchestrator {
  readonly #manager: CompiledAgent;
  readonly #specialists: ReadonlyMap<string, CompiledAgent>;
  readonly #execute: AgentExecutionProvider['execute'];
  readonly #resolveModel: ModelResolver['resolve'];
  readonly #memory: ManagerConversationMemory;
  readonly #traceRecorder: LocalTraceRecorder;
  readonly #checkpoints: ApprovalCheckpointGateway;
  readonly #proposalGateway: ProviderWriteProposalGateway;
  readonly #authorizeDisclosure: ModelDisclosureGateway['authorize'];
  readonly #agentGraphHash: string;
  readonly #sdkVersion: string;
  readonly #createCheckpointId: () => string;
  readonly #checkpointTtlMs: number;
  readonly #clock: () => Date;

  constructor(options: AgentOrchestratorOptions) {
    if (
      options.manager.manifest.kind !== 'manager' ||
      options.specialists.some(
        (specialist) => specialist.manifest.kind !== 'specialist',
      ) ||
      typeof options.executionProvider?.execute !== 'function' ||
      typeof options.modelRouter?.resolve !== 'function' ||
      typeof options.memory?.retrieveForManager !== 'function' ||
      typeof options.memory.appendManagerMessage !== 'function' ||
      typeof options.traceRecorder?.start !== 'function' ||
      typeof options.approvalCheckpoints?.create !== 'function' ||
      typeof options.approvalCheckpoints.consumeForResume !== 'function' ||
      typeof options.approvalCheckpoints.cancel !== 'function' ||
      typeof options.proposalGateway?.abandonPrepared !== 'function' ||
      typeof options.proposalGateway?.validateDecision !== 'function' ||
      typeof options.proposalGateway.executeDecision !== 'function' ||
      typeof options.disclosureGateway?.authorize !== 'function' ||
      (options.clock !== undefined && typeof options.clock !== 'function') ||
      !SHA256_PATTERN.test(options.agentGraphHash) ||
      !SEMVER_PATTERN.test(options.sdkVersion)
    ) {
      throw new Error('invalid-agent-orchestrator-dependency');
    }
    const specialists = new Map<string, CompiledAgent>();
    for (const specialist of options.specialists) {
      if (specialists.has(specialist.manifest.id)) {
        throw new Error('duplicate-specialist-agent');
      }
      if (
        !options.manager.manifest.capabilityAllowlist.includes(
          `agent.${specialist.manifest.id}.delegate`,
        )
      ) {
        throw new Error('manager-specialist-delegation-denied');
      }
      specialists.set(specialist.manifest.id, specialist);
    }
    const ttl = options.checkpointTtlMs ?? CHECKPOINT_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > CHECKPOINT_TTL_MS) {
      throw new Error('invalid-agent-orchestrator-dependency');
    }
    this.#manager = options.manager;
    this.#specialists = specialists;
    this.#execute = options.executionProvider.execute.bind(
      options.executionProvider,
    );
    this.#resolveModel = options.modelRouter.resolve.bind(options.modelRouter);
    this.#memory = options.memory;
    this.#traceRecorder = options.traceRecorder;
    this.#checkpoints = options.approvalCheckpoints;
    this.#proposalGateway = options.proposalGateway;
    this.#authorizeDisclosure = options.disclosureGateway.authorize.bind(
      options.disclosureGateway,
    );
    this.#agentGraphHash = options.agentGraphHash;
    this.#sdkVersion = options.sdkVersion;
    this.#createCheckpointId = options.createCheckpointId ?? randomUUID;
    this.#checkpointTtlMs = ttl;
    this.#clock = options.clock ?? (() => new Date());
  }

  async runTurn(rawInput: TurnInput): Promise<TurnResult> {
    const input = snapshotTurn(rawInput);
    const trace = this.#traceRecorder.start(input.runId);
    await trace.record('run.started');
    let modelResolution: ModelResolution;
    try {
      modelResolution = await this.#resolveModel({
        triggers: input.escalationTriggers,
        policy: this.#manager.manifest.modelPolicy,
      });
    } catch {
      return this.#failed(
        input.runId,
        trace,
        safeError(
          'model-routing-failed',
          'The assistant could not select a model safely.',
          true,
        ),
      );
    }
    if (modelResolution.status === 'unavailable') {
      await trace.record('model.unavailable', {
        requestedModel: modelResolution.requestedModel,
        resolvedModel: null,
        attemptedModels: modelResolution.attemptedModels,
        reason: modelResolution.reason,
        ...('escalationTrigger' in modelResolution
          ? { escalationTrigger: modelResolution.escalationTrigger }
          : {}),
        safeErrorCode: modelResolution.safeError.code,
      });
      return this.#failed(
        input.runId,
        trace,
        modelResolution.safeError,
        [],
        ZERO_USAGE,
        modelResolution,
      );
    }
    await trace.record('model.resolved', {
      requestedModel: modelResolution.requestedModel,
      resolvedModel: modelResolution.resolvedModel,
      reason: modelResolution.reason,
      ...('escalationTrigger' in modelResolution
        ? { escalationTrigger: modelResolution.escalationTrigger }
        : {}),
    });
    try {
      asObject(
        snapshotJson(
          this.#manager.inputSchema.parse({ request: input.message }),
        ),
      );
    } catch {
      return this.#failed(
        input.runId,
        trace,
        safeError(
          'invalid-manager-input',
          'The assistant request did not match the manager input contract.',
          false,
        ),
        [],
        ZERO_USAGE,
        modelResolution,
      );
    }
    let memory: ManagerMemoryContext;
    let currentMessage: ConversationMemoryEntry;
    try {
      const retrieved = await this.#memory.retrieveForManager({
        conversationId: input.conversationId,
        householdId: input.householdId,
        userId: input.userId,
        query: input.message,
      });
      if (!Array.isArray(retrieved.entries) || retrieved.entries.length > 64) {
        throw new Error('invalid-conversation-memory-result');
      }
      const entries = Object.freeze(
        retrieved.entries.map((entry) => snapshotConversationEntry(entry)),
      );
      if (
        entries.some(
          (entry) =>
            entry.conversationId !== input.conversationId ||
            entry.householdId !== input.householdId ||
            entry.userId !== input.userId,
        )
      ) {
        throw new Error('conversation-memory-scope-mismatch');
      }
      memory = Object.freeze({ entries });
      currentMessage = snapshotConversationEntry(
        await this.#memory.appendManagerMessage({
          conversationId: input.conversationId,
          householdId: input.householdId,
          userId: input.userId,
          role: 'user',
          content: input.message,
        }),
      );
      if (
        currentMessage.conversationId !== input.conversationId ||
        currentMessage.householdId !== input.householdId ||
        currentMessage.userId !== input.userId ||
        currentMessage.role !== 'user' ||
        currentMessage.content !== input.message
      ) {
        throw new Error('conversation-memory-append-mismatch');
      }
    } catch {
      return this.#failed(
        input.runId,
        trace,
        safeError(
          'conversation-memory-unavailable',
          'Conversation memory is temporarily unavailable.',
          true,
        ),
        [],
        ZERO_USAGE,
        modelResolution,
      );
    }
    await trace.record('memory.retrieved', {
      entryCount: memory.entries.length,
    });
    const preparedTurn: PreparedTurnInput = Object.freeze({
      ...input,
      currentMessage,
    });
    let activeResolution = modelResolution;
    let planningUsage = ZERO_USAGE;
    let plan: ManagerPlan | undefined;
    let lastPlanFailure: RuntimeFallbackCause = 'luna-execution-failed';
    const planningSources = snapshotDisclosureSources(
      [...memory.entries, currentMessage].map((entry) =>
        Object.freeze({ kind: 'conversation-message' as const, entry }),
      ),
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let planning: RuntimeProviderResult | undefined;
      try {
        planning = await this.#runProvider(
          'plan',
          this.#manager,
          activeResolution.resolvedModel,
          preparedTurn,
          trace,
          {
            phaseInvocationId: 'manager-plan',
            sources: planningSources,
          },
        );
      } catch {
        lastPlanFailure = 'luna-execution-failed';
      }
      if (planning !== undefined) {
        planningUsage = addUsage(planningUsage, planning.usage);
      }
      if (planning?.status === 'failed') {
        const terminal = terminalProviderFailure(planning);
        if (terminal !== undefined) {
          return this.#failed(
            input.runId,
            trace,
            terminal,
            [],
            planningUsage,
            activeResolution,
          );
        }
        lastPlanFailure = 'luna-execution-failed';
      }
      if (planning?.status === 'interrupted') {
        return this.#pause(
          preparedTurn,
          activeResolution,
          undefined,
          [],
          [this.#paused('plan', 'manager-plan', this.#manager, planning)],
          planningUsage,
          trace,
        );
      }
      if (planning?.status === 'completed') {
        try {
          plan = parseManagerPlan(
            planning.output,
            this.#specialists,
            this.#manager.manifest.executionBudget.maxCapabilityCalls,
          );
          break;
        } catch {
          lastPlanFailure = 'failed-output-validation';
        }
      }
      if (attempt > 0 || activeResolution.resolvedModel !== 'gpt-5.6-luna') {
        break;
      }
      let fallback: ModelResolution;
      try {
        fallback = await this.#resolveModel({
          triggers: [fallbackTrigger(lastPlanFailure)],
          policy: this.#manager.manifest.modelPolicy,
        });
      } catch {
        break;
      }
      if (fallback.status === 'unavailable') {
        await trace.record('model.unavailable', {
          requestedModel: fallback.requestedModel,
          resolvedModel: null,
          attemptedModels: fallback.attemptedModels,
          reason: fallback.reason,
          ...('escalationTrigger' in fallback
            ? { escalationTrigger: fallback.escalationTrigger }
            : {}),
          safeErrorCode: fallback.safeError.code,
        });
        return this.#failed(
          input.runId,
          trace,
          fallback.safeError,
          [],
          planningUsage,
          fallback,
        );
      }
      if (fallback.resolvedModel !== 'gpt-5.6-terra') break;
      activeResolution = fallback;
      await trace.record('model.resolved', {
        requestedModel: fallback.requestedModel,
        resolvedModel: fallback.resolvedModel,
        reason: fallback.reason,
        fallbackCause: lastPlanFailure,
      });
    }
    if (plan === undefined) {
      return this.#failed(
        input.runId,
        trace,
        lastPlanFailure === 'failed-output-validation'
          ? safeError(
              'invalid-manager-plan',
              'The assistant produced an invalid delegation plan.',
              false,
            )
          : safeError(
              'manager-execution-failed',
              'The assistant could not plan this request safely.',
              true,
            ),
        [],
        planningUsage,
        activeResolution,
      );
    }
    await trace.record('manager.routed', {
      agentIds: plan.delegations.map((item) => item.specialistId),
      delegationCount: plan.delegations.length,
    });
    return this.#executePlan(
      preparedTurn,
      activeResolution,
      plan,
      [],
      planningUsage,
      trace,
    );
  }

  async resumeTurn(rawInput: ResumeTurnInput): Promise<TurnResult> {
    let trace: ActiveLocalTrace;
    try {
      assertUuid(rawInput.runId);
      trace = this.#traceRecorder.start(rawInput.runId);
    } catch {
      throw new Error('invalid-resume-turn-input');
    }
    if (rawInput.approvalChannel !== 'authenticated-visual') {
      return this.#failed(
        rawInput.runId,
        trace,
        safeError(
          'invalid-approval-channel',
          'Approval requires an authenticated visual confirmation.',
          false,
        ),
      );
    }
    let scope: Omit<TurnInput, 'message' | 'escalationTriggers' | 'locale'> &
      Readonly<{
        disclosureGrantId: string;
        disclosureGrantVersion: string;
        operationAuthorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
      }>;
    try {
      scope = Object.freeze({
        requestId: assertUuid(rawInput.requestId),
        runId: assertUuid(rawInput.runId),
        householdId: assertUuid(rawInput.householdId),
        userId: assertUuid(rawInput.userId),
        authenticatedSessionId: assertUuid(rawInput.authenticatedSessionId),
        conversationId: assertUuid(rawInput.conversationId),
        spaceAccessGrantId: assertUuid(rawInput.spaceAccessGrantId),
        authorizationScopeFingerprint:
          EffectiveAuthorizationScopeFingerprintSchema.parse(
            rawInput.collectionAuthorizationScopeFingerprint,
          ),
        operationAuthorizationScopeFingerprint:
          EffectiveAuthorizationScopeFingerprintSchema.parse(
            rawInput.authorizationScopeFingerprint,
          ),
        disclosureGrantId: assertUuid(rawInput.disclosureGrantId),
        disclosureGrantVersion:
          typeof rawInput.disclosureGrantVersion === 'string' &&
          SEMVER_PATTERN.test(rawInput.disclosureGrantVersion)
            ? rawInput.disclosureGrantVersion
            : (() => {
                throw new Error('bad');
              })(),
        abortSignal: rawInput.abortSignal,
      });
      assertUuid(rawInput.checkpointId);
      assertUuid(rawInput.proposalId);
      assertUuid(rawInput.approvalDecisionId);
      if (
        !INTERRUPTION_ID_PATTERN.test(rawInput.interruptionId) ||
        (rawInput.decision !== 'approve' && rawInput.decision !== 'reject') ||
        typeof rawInput.abortSignal?.aborted !== 'boolean'
      ) {
        throw new Error('bad');
      }
    } catch {
      return this.#failed(
        rawInput.runId,
        trace,
        safeError(
          'invalid-resume-turn-input',
          'The approval resume request is invalid.',
          false,
        ),
      );
    }
    const identity: ApprovalCheckpointIdentity = Object.freeze({
      checkpointId: rawInput.checkpointId,
      householdId: scope.householdId,
      userId: scope.userId,
      runId: scope.runId,
      agentGraphHash: this.#agentGraphHash,
      sdkVersion: this.#sdkVersion,
    });
    let consumed: Awaited<
      ReturnType<ApprovalCheckpointGateway['consumeForResume']>
    >;
    let validated:
      | Readonly<{
          state: RuntimeCheckpointState;
          selected: Readonly<{
            execution: PausedExecution;
            interruption: AgentProviderInterruption;
            publicId: string;
          }>;
          selectedAgent: CompiledAgent;
        }>
      | undefined;
    try {
      consumed = await this.#checkpoints.consumeForResume(
        identity,
        async (decryptedState) => {
          try {
            const state = this.#parseRuntimeState(
              JSON.stringify(decryptedState),
            );
            if (
              state.turn.runId !== scope.runId ||
              state.turn.householdId !== scope.householdId ||
              state.turn.userId !== scope.userId ||
              state.turn.conversationId !== scope.conversationId
            ) {
              return false;
            }
            const selected = state.paused
              .flatMap((execution) =>
                execution.interruptions.map((interruption) => ({
                  execution,
                  interruption,
                  publicId: `${execution.executionKey}:${interruption.id}`,
                })),
              )
              .find((item) => item.publicId === rawInput.interruptionId);
            if (
              selected === undefined ||
              selected.execution.interruptions.length !== 1 ||
              selected.interruption.proposalId !== rawInput.proposalId
            ) {
              return false;
            }
            const selectedAgent =
              selected.execution.agentId === this.#manager.manifest.id
                ? this.#manager
                : this.#specialists.get(selected.execution.agentId);
            if (selectedAgent === undefined) return false;
            const decisionContext: AgentExecutionContext = Object.freeze({
              requestId: scope.requestId,
              runId: scope.runId,
              householdId: scope.householdId,
              userId: scope.userId,
              authenticatedSessionId: scope.authenticatedSessionId,
              spaceAccessGrantId: scope.spaceAccessGrantId,
              authorizationScopeFingerprint:
                scope.operationAuthorizationScopeFingerprint,
              locale: state.turn.locale,
              disclosureGrantId: scope.disclosureGrantId,
              disclosureGrantVersion: scope.disclosureGrantVersion,
              approvalDecisionId: rawInput.approvalDecisionId,
              agentId: selected.execution.agentId,
              abortSignal: scope.abortSignal,
            });
            const preparationContext: AgentExecutionContext = Object.freeze({
              requestId: state.turn.requestId,
              runId: state.turn.runId,
              householdId: state.turn.householdId,
              userId: state.turn.userId,
              authenticatedSessionId: state.turn.authenticatedSessionId,
              spaceAccessGrantId: state.turn.spaceAccessGrantId,
              authorizationScopeFingerprint:
                selected.execution.authorizationScopeFingerprint,
              locale: state.turn.locale,
              disclosureGrantId: selected.execution.disclosureGrantId,
              disclosureGrantVersion: selected.execution.disclosureGrantVersion,
              approvalDecisionId: rawInput.approvalDecisionId,
              agentId: selected.execution.agentId,
              abortSignal: scope.abortSignal,
            });
            if (
              selected.execution.authorizationScopeFingerprint !==
                scope.operationAuthorizationScopeFingerprint ||
              !(await this.#proposalGateway.validateDecision({
                proposalId: rawInput.proposalId,
                approvalDecisionId: rawInput.approvalDecisionId,
                capabilityId: selected.interruption.capabilityId,
                context: decisionContext,
                preparationContext,
                decision: rawInput.decision,
              }))
            ) {
              return false;
            }
            validated = Object.freeze({ state, selected, selectedAgent });
            return true;
          } catch {
            return false;
          }
        },
      );
    } catch {
      return this.#failed(
        scope.runId,
        trace,
        safeError(
          'approval-checkpoint-invalid',
          'The approval checkpoint could not be resumed.',
          false,
        ),
      );
    }
    if (consumed.status !== 'resumed') {
      return this.#failed(
        scope.runId,
        trace,
        safeError(
          `approval-checkpoint-${consumed.status}`,
          'The approval checkpoint is no longer available.',
          false,
        ),
      );
    }
    const binding = validated as
      | Readonly<{
          state: RuntimeCheckpointState;
          selected: Readonly<{
            execution: PausedExecution;
            interruption: AgentProviderInterruption;
            publicId: string;
          }>;
          selectedAgent: CompiledAgent;
        }>
      | undefined;
    if (binding === undefined) {
      return this.#failed(
        scope.runId,
        trace,
        safeError(
          'approval-checkpoint-invalid',
          'The approval checkpoint could not be resumed.',
          false,
        ),
      );
    }
    const { selected, selectedAgent, state } = binding;
    const resumeTurn: PreparedTurnInput = Object.freeze({
      requestId: scope.requestId,
      runId: scope.runId,
      householdId: scope.householdId,
      userId: scope.userId,
      authenticatedSessionId: scope.authenticatedSessionId,
      conversationId: scope.conversationId,
      spaceAccessGrantId: scope.spaceAccessGrantId,
      authorizationScopeFingerprint: scope.authorizationScopeFingerprint,
      locale: state.turn.locale,
      abortSignal: scope.abortSignal,
      message: state.turn.message,
      escalationTriggers: Object.freeze([]),
      currentMessage: state.turn.currentMessage,
    });
    if (selected.execution.phase !== 'specialist') {
      return this.#failed(
        scope.runId,
        trace,
        safeError(
          'approval-checkpoint-invalid',
          'Only a specialist provider-write proposal can be resumed.',
          false,
        ),
        state.outcomes,
        state.usage,
        state.modelResolution,
      );
    }
    const decisionContext: AgentExecutionContext = Object.freeze({
      requestId: scope.requestId,
      runId: scope.runId,
      householdId: scope.householdId,
      userId: scope.userId,
      authenticatedSessionId: scope.authenticatedSessionId,
      spaceAccessGrantId: scope.spaceAccessGrantId,
      authorizationScopeFingerprint:
        scope.operationAuthorizationScopeFingerprint,
      locale: state.turn.locale,
      disclosureGrantId: scope.disclosureGrantId,
      disclosureGrantVersion: scope.disclosureGrantVersion,
      approvalDecisionId: rawInput.approvalDecisionId,
      agentId: selected.execution.agentId,
      abortSignal: scope.abortSignal,
    });
    const preparationContext: AgentExecutionContext = Object.freeze({
      requestId: state.turn.requestId,
      runId: state.turn.runId,
      householdId: state.turn.householdId,
      userId: state.turn.userId,
      authenticatedSessionId: state.turn.authenticatedSessionId,
      spaceAccessGrantId: state.turn.spaceAccessGrantId,
      authorizationScopeFingerprint:
        selected.execution.authorizationScopeFingerprint,
      locale: state.turn.locale,
      disclosureGrantId: selected.execution.disclosureGrantId,
      disclosureGrantVersion: selected.execution.disclosureGrantVersion,
      approvalDecisionId: rawInput.approvalDecisionId,
      agentId: selected.execution.agentId,
      abortSignal: scope.abortSignal,
    });
    let decisionExecution: ProviderWriteDecisionExecution;
    try {
      decisionExecution = snapshotDecisionExecution(
        await this.#proposalGateway.executeDecision({
          proposalId: rawInput.proposalId,
          approvalDecisionId: rawInput.approvalDecisionId,
          capabilityId: selected.interruption.capabilityId,
          context: decisionContext,
          preparationContext,
          decision: rawInput.decision,
        }),
      );
      if (
        (rawInput.decision === 'approve' &&
          decisionExecution.outcome !== 'executed-readback-verified') ||
        (rawInput.decision === 'reject' &&
          decisionExecution.outcome !== 'rejected')
      ) {
        throw new Error('provider-write-decision-outcome-mismatch');
      }
    } catch {
      return this.#failed(
        scope.runId,
        trace,
        rawInput.decision === 'approve'
          ? safeError(
              'approved-action-outcome-unknown',
              'The approved provider action may have executed. Reconciliation and provider readback are required before another attempt.',
              false,
            )
          : safeError(
              'approval-rejection-failed',
              'The proposal rejection could not be recorded safely.',
              false,
            ),
        state.outcomes,
        state.usage,
        state.modelResolution,
      );
    }
    await trace.record('approval.resumed', {
      agentId: selected.execution.agentId,
      proposalId: selected.interruption.proposalId,
      capabilityId: selected.interruption.capabilityId,
      decision: rawInput.decision,
    });
    if (rawInput.decision === 'approve') {
      await trace.record('action.executed', {
        agentId: selected.execution.agentId,
        proposalId: selected.interruption.proposalId,
        capabilityId: selected.interruption.capabilityId,
        idempotencyKey: decisionExecution.idempotencyKey,
        providerReadbackVerified: true,
      });
    }
    const parsed = selectedAgent.outputSchema.safeParse(
      decisionExecution.output,
    );
    if (!parsed.success) {
      return this.#failed(
        scope.runId,
        trace,
        rawInput.decision === 'approve'
          ? safeError(
              'approved-action-result-invalid',
              'The provider action was recorded, but its readback result did not match the specialist contract.',
              false,
            )
          : safeError(
              'approval-rejection-result-invalid',
              'The proposal rejection was recorded, but its result did not match the specialist contract.',
              false,
            ),
        state.outcomes,
        state.usage,
        state.modelResolution,
      );
    }
    if (state.plan === undefined) {
      return this.#failed(
        scope.runId,
        trace,
        safeError(
          'approval-checkpoint-invalid',
          'The approval checkpoint did not contain a delegation plan.',
          false,
        ),
        state.outcomes,
        state.usage,
        state.modelResolution,
      );
    }
    if (rawInput.decision === 'reject') {
      const outcomes = new Map(
        state.outcomes.map((outcome) => [outcome.delegationId, outcome]),
      );
      outcomes.set(
        selected.execution.executionKey,
        Object.freeze({
          delegationId: selected.execution.executionKey,
          specialistId: selected.execution.agentId,
          status: 'failed' as const,
          output: snapshotJson(parsed.data),
          safeError: safeError(
            'approval-rejected',
            'The requested provider action was not approved.',
            false,
          ),
          usage: ZERO_USAGE,
        }),
      );
      for (const delegation of state.plan.delegations) {
        if (outcomes.has(delegation.id)) continue;
        outcomes.set(
          delegation.id,
          Object.freeze({
            delegationId: delegation.id,
            specialistId: delegation.specialistId,
            status: 'blocked' as const,
            safeError: safeError(
              'approval-rejected',
              'This specialist delegation was not run because approval was rejected.',
              false,
            ),
            usage: ZERO_USAGE,
          }),
        );
      }
      return this.#synthesize(
        resumeTurn,
        state.modelResolution,
        state.plan,
        state.plan.delegations.map((delegation) =>
          outcomes.get(delegation.id)!,
        ),
        state.usage,
        trace,
      );
    }
    const outcomes = [
      ...state.outcomes,
      Object.freeze({
        delegationId: selected.execution.executionKey,
        specialistId: selected.execution.agentId,
        status: 'completed' as const,
        output: snapshotJson(parsed.data),
        usage: ZERO_USAGE,
      }),
    ];
    return this.#executePlan(
      resumeTurn,
      state.modelResolution,
      state.plan,
      outcomes,
      state.usage,
      trace,
      createTurnProviderWriteEffectLedger(true),
    );
  }

  async #runProvider(
    phase: AgentExecutionPhase,
    agent: CompiledAgent,
    model: EmdoModelId,
    turn: PreparedTurnInput,
    trace: ActiveLocalTrace,
    options: Readonly<{
      phaseInvocationId: string;
      sources: readonly ModelDisclosureSource[];
      resume?: AgentProviderRequest['resume'];
      approvalDecisionId?: string;
      priorCapabilityCalls?: number;
      turnProviderWriteLedger?: TurnProviderWriteEffectLedger;
    }>,
  ): Promise<RuntimeProviderResult> {
    if (turn.abortSignal.aborted) throw new Error('agent-run-aborted');
    const purpose: ModelDisclosurePurpose =
      phase === 'plan'
        ? 'manager-plan'
        : phase === 'synthesize'
          ? 'manager-synthesis'
          : 'specialist-execution';
    const phaseInvocationId = assertIdentifier(options.phaseInvocationId);
    const sources = snapshotDisclosureSources(options.sources);
    const sourceDataClasses = uniqueDataClasses(
      sources.map((source) => disclosureSourceDataClass(source)),
    );
    if (
      sourceDataClasses.some(
        (dataClass) => !agent.manifest.readableDataClasses.includes(dataClass),
      )
    ) {
      throw new Error('model-disclosure-source-class-denied');
    }
    let authorization: ModelDisclosureAuthorization;
    try {
      const decision = snapshotDisclosureAuthorization(
        await this.#authorizeDisclosure(
          Object.freeze({
            requestId: turn.requestId,
            runId: turn.runId,
            householdId: turn.householdId,
            userId: turn.userId,
            authenticatedSessionId: turn.authenticatedSessionId,
            spaceAccessGrantId: turn.spaceAccessGrantId,
            authorizationScopeFingerprint: turn.authorizationScopeFingerprint,
            agentId: agent.manifest.id,
            phasePurpose: purpose,
            phaseInvocationId,
            provider: 'openai' as const,
            sources,
          }),
        ),
      );
      if (decision.status === 'denied') {
        await trace.record('disclosure.denied', {
          ...(decision.grantId === undefined
            ? {}
            : { grantId: decision.grantId }),
          agentId: agent.manifest.id,
          reason: decision.reason,
        });
        return Object.freeze({
          status: 'failed',
          reason: 'disclosure-denied',
          replaySafety: 'safe',
          usage: ZERO_USAGE,
          capabilityCalls: options.priorCapabilityCalls ?? 0,
        });
      }
      authorization = decision;
      if (
        authorization.runId !== turn.runId ||
        authorization.householdId !== turn.householdId ||
        authorization.userId !== turn.userId ||
        authorization.agentId !== agent.manifest.id ||
        authorization.phasePurpose !== purpose ||
        authorization.phaseInvocationId !== phaseInvocationId ||
        sourceDataClasses.some(
          (dataClass) =>
            !authorization.records.some(
              (record) => record.dataClass === dataClass,
            ),
        ) ||
        authorization.records.some(
          (record) => !sourceDataClasses.includes(record.dataClass),
        ) ||
        authorization.provider !== 'openai'
      ) {
        throw new Error('model-disclosure-binding-mismatch');
      }
    } catch {
      await trace.record('disclosure.denied', {
        agentId: agent.manifest.id,
        phaseInvocationId,
        reason: 'inactive-or-mismatched-disclosure-grant',
      });
      return Object.freeze({
        status: 'failed',
        reason: 'disclosure-denied',
        replaySafety: 'safe',
        usage: ZERO_USAGE,
        capabilityCalls: options.priorCapabilityCalls ?? 0,
      });
    }
    if (turn.abortSignal.aborted) throw new Error('agent-run-aborted');
    let modelDispatchRecorded = false;
    let dispatchDisclosureDenial: ModelDisclosureDenialReason | undefined;
    const beforeModelDispatch = async (): Promise<void> => {
      if (turn.abortSignal.aborted) throw new Error('agent-run-aborted');
      const now = new Date(this.#clock());
      if (!Number.isFinite(now.getTime())) {
        throw new Error('invalid-agent-orchestrator-clock');
      }
      if (Date.parse(authorization.expiresAt) <= now.getTime()) {
        dispatchDisclosureDenial = 'grant-expired';
        await trace.record('disclosure.denied', {
          grantId: authorization.grantId,
          agentId: authorization.agentId,
          reason: dispatchDisclosureDenial,
        });
        throw new Error('model-disclosure-expired-before-dispatch');
      }
    };
    const onModelDispatch = async (): Promise<void> => {
      if (modelDispatchRecorded) return;
      for (const record of authorization.records) {
        await trace.record('disclosure.sent', {
          grantId: authorization.grantId,
          grantVersion: authorization.grantVersion,
          agentId: authorization.agentId,
          purpose: authorization.disclosurePurpose,
          phasePurpose: authorization.phasePurpose,
          phaseInvocationId: authorization.phaseInvocationId,
          dataClass: record.dataClass,
          recordId: record.recordId,
          fields: record.fields,
          provider: authorization.provider,
          expiresAt: authorization.expiresAt,
        });
      }
      modelDispatchRecorded = true;
    };
    let rawResult: AgentProviderResult;
    try {
      rawResult = await this.#execute(
        Object.freeze({
          phase,
          agent,
          model,
          input: authorization.payload,
          context: Object.freeze({
            requestId: turn.requestId,
            runId: turn.runId,
            householdId: turn.householdId,
            userId: turn.userId,
            authenticatedSessionId: turn.authenticatedSessionId,
            spaceAccessGrantId: turn.spaceAccessGrantId,
            authorizationScopeFingerprint: turn.authorizationScopeFingerprint,
            locale: turn.locale,
            disclosureGrantId: authorization.grantId,
            disclosureGrantVersion: authorization.grantVersion,
            ...(options.approvalDecisionId === undefined
              ? {}
              : { approvalDecisionId: options.approvalDecisionId }),
            agentId: agent.manifest.id,
            abortSignal: turn.abortSignal,
          }),
          maxTurns: agent.manifest.executionBudget.maxTurns,
          beforeModelDispatch,
          onModelDispatch,
          ...(options.priorCapabilityCalls === undefined
            ? {}
            : { priorCapabilityCalls: options.priorCapabilityCalls }),
          ...(options.turnProviderWriteLedger === undefined
            ? {}
            : {
                turnProviderWriteLedger: options.turnProviderWriteLedger,
              }),
          ...(options.resume === undefined ? {} : { resume: options.resume }),
        }),
      );
    } catch (error) {
      if (dispatchDisclosureDenial === undefined) throw error;
      return Object.freeze({
        status: 'failed',
        reason: 'disclosure-denied',
        replaySafety: 'safe',
        usage: ZERO_USAGE,
        capabilityCalls: options.priorCapabilityCalls ?? 0,
      });
    }
    if (dispatchDisclosureDenial !== undefined) {
      return Object.freeze({
        status: 'failed',
        reason: 'disclosure-denied',
        replaySafety: 'safe',
        usage: ZERO_USAGE,
        capabilityCalls: options.priorCapabilityCalls ?? 0,
      });
    }
    const result = snapshotProviderResult(rawResult);
    if (
      !modelDispatchRecorded &&
      (result.status === 'completed' || result.status === 'interrupted')
    ) {
      return Object.freeze({
        status: 'failed',
        reason: 'execution-failed',
        replaySafety: 'unsafe',
        usage: result.usage,
        capabilityCalls: result.capabilityCalls ?? 0,
      });
    }
    if (result.usage.spendWarning === true) {
      await trace.record('spend.warning', {
        code: 'monthly-ai-spend-warning-threshold-reached',
        thresholdCadMinor: 5_000,
      });
    }
    if (result.status === 'failed') return result;
    return Object.freeze({
      ...result,
      disclosure: Object.freeze({
        grantId: authorization.grantId,
        grantVersion: authorization.grantVersion,
      }),
    });
  }

  async #runSpecialistProvider(
    agent: CompiledAgent,
    modelResolution: Extract<ModelResolution, { status: 'resolved' }>,
    phaseInvocationId: string,
    sources: readonly ModelDisclosureSource[],
    turn: PreparedTurnInput,
    trace: ActiveLocalTrace,
    turnProviderWriteLedger: TurnProviderWriteEffectLedger,
  ): Promise<SpecialistProviderExecution> {
    let activeResolution = modelResolution;
    let usage = ZERO_USAGE;
    let lastFailure: RuntimeFallbackCause = 'luna-execution-failed';
    let terminalFailure: SafeAgentError | undefined;
    let capabilityCalls = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result: RuntimeProviderResult | undefined;
      let replaySafe = false;
      try {
        result = await this.#runProvider(
          'specialist',
          agent,
          activeResolution.resolvedModel,
          turn,
          trace,
          {
            phaseInvocationId,
            sources,
            priorCapabilityCalls: capabilityCalls,
            turnProviderWriteLedger,
          },
        );
      } catch {
        lastFailure = 'luna-execution-failed';
      }
      if (result !== undefined) {
        usage = addUsage(usage, result.usage);
        capabilityCalls = result.capabilityCalls ?? capabilityCalls;
      }
      if (result?.status === 'failed') {
        terminalFailure = terminalProviderFailure(result);
        lastFailure = 'luna-execution-failed';
        replaySafe = result.replaySafety === 'safe';
      }
      if (result?.status === 'interrupted') {
        return Object.freeze({
          status: 'result',
          result: Object.freeze({ ...result, usage }),
          modelResolution: activeResolution,
        });
      }
      if (result?.status === 'completed') {
        const parsed = agent.outputSchema.safeParse(result.output);
        if (parsed.success) {
          return Object.freeze({
            status: 'result',
            result: Object.freeze({
              ...result,
              output: snapshotJson(parsed.data),
              usage,
            }),
            modelResolution: activeResolution,
          });
        }
        lastFailure = 'failed-output-validation';
        replaySafe = result.replaySafety === 'safe';
      }
      if (
        terminalFailure !== undefined ||
        attempt > 0 ||
        !replaySafe ||
        activeResolution.resolvedModel !== 'gpt-5.6-luna'
      ) {
        break;
      }
      let fallback: ModelResolution;
      try {
        fallback = await this.#resolveModel({
          triggers: [fallbackTrigger(lastFailure)],
          policy: agent.manifest.modelPolicy,
        });
      } catch {
        break;
      }
      if (fallback.status === 'unavailable') {
        await trace.record('model.unavailable', {
          requestedModel: fallback.requestedModel,
          resolvedModel: null,
          attemptedModels: fallback.attemptedModels,
          reason: fallback.reason,
          ...('escalationTrigger' in fallback
            ? { escalationTrigger: fallback.escalationTrigger }
            : {}),
          safeErrorCode: fallback.safeError.code,
        });
        return Object.freeze({
          status: 'failed',
          safeError: fallback.safeError,
          usage,
        });
      }
      if (fallback.resolvedModel !== 'gpt-5.6-terra') break;
      activeResolution = fallback;
      await trace.record('model.resolved', {
        requestedModel: fallback.requestedModel,
        resolvedModel: fallback.resolvedModel,
        reason: fallback.reason,
        fallbackCause: lastFailure,
        agentId: agent.manifest.id,
      });
    }
    return Object.freeze({
      status: 'failed',
      safeError:
        terminalFailure ??
        (lastFailure === 'failed-output-validation'
          ? safeError(
              'specialist-output-validation-failed',
              'A specialist response did not match its output contract.',
              false,
            )
          : safeError(
              'specialist-execution-failed',
              'A specialist could not complete its delegated work.',
              true,
            )),
      usage,
    });
  }

  #paused(
    phase: PausedExecution['phase'],
    executionKey: string,
    agent: CompiledAgent,
    result: Extract<RuntimeProviderResult, { status: 'interrupted' }>,
  ): CollectedPausedExecution {
    const authorizationScopeFingerprint =
      result.interruptions[0]?.authorizationScopeFingerprint;
    return Object.freeze({
      phase,
      executionKey,
      agentId: agent.manifest.id,
      serializedState: result.serializedState,
      interruptions: result.interruptions,
      usage: result.usage,
      capabilityCalls: result.capabilityCalls ?? 0,
      disclosureGrantId: result.disclosure.grantId,
      disclosureGrantVersion: result.disclosure.grantVersion,
      ...(authorizationScopeFingerprint === undefined
        ? {}
        : { authorizationScopeFingerprint }),
    });
  }

  #isApprovalCheckpointAdmissible(
    plan: ManagerPlan | undefined,
    paused: readonly CollectedPausedExecution[],
  ): paused is readonly PausedExecution[] {
    const execution = paused[0];
    const interruption = execution?.interruptions[0];
    const specialist =
      execution === undefined
        ? undefined
        : this.#specialists.get(execution.agentId);
    const delegation =
      execution === undefined
        ? undefined
        : plan?.delegations.find(({ id }) => id === execution.executionKey);
    const capability = specialist?.capabilities.find(
      ({ descriptor }) => descriptor.id === interruption?.capabilityId,
    );
    return (
      plan !== undefined &&
      paused.length === 1 &&
      execution !== undefined &&
      execution.phase === 'specialist' &&
      execution.interruptions.length === 1 &&
      interruption !== undefined &&
      interruption.agentId === execution.agentId &&
      interruption.sdkCallId !== undefined &&
      interruption.providerAuthorityBindingHash !== undefined &&
      interruption.authorizationScopeFingerprint !== undefined &&
      specialist !== undefined &&
      delegation?.specialistId === execution.agentId &&
      capability?.descriptor.approval.rule ===
        'authenticated-visual-proposal' &&
      (capability.descriptor.capabilityKind === 'provider-write' ||
        capability.descriptor.capabilityKind === 'local-write' ||
        capability.descriptor.capabilityKind === 'import')
    );
  }

  async #executePlan(
    turn: PreparedTurnInput,
    modelResolution: Extract<ModelResolution, { status: 'resolved' }>,
    plan: ManagerPlan,
    existingOutcomes: readonly SpecialistOutcome[],
    initialUsage: AgentUsage,
    trace: ActiveLocalTrace,
    turnProviderWriteLedger: TurnProviderWriteEffectLedger = createTurnProviderWriteEffectLedger(),
  ): Promise<TurnResult> {
    const outcomes = new Map(
      existingOutcomes.map((outcome) => [outcome.delegationId, outcome]),
    );
    let activeResolution = modelResolution;
    let usage = initialUsage;
    let wave = 0;
    const cleanupPreparedWrites = async (
      paused: readonly CollectedPausedExecution[],
      reason: ProviderWriteProposalAbandonmentReason,
    ): Promise<boolean> => {
      turnProviderWriteLedger.abortController.abort(new Error(reason));
      const interruptionCount = paused.reduce(
        (count, execution) => count + execution.interruptions.length,
        0,
      );
      if (interruptionCount > 1) {
        return this.#abandonPausedProviderWrites(turn, paused, reason);
      }
      if (
        turnProviderWriteLedger.providerWritePreparation !== undefined ||
        turnProviderWriteLedger.priorWriteTerminal
      ) {
        return abandonPreparedProviderWrite(
          this.#proposalGateway,
          turnProviderWriteLedger,
          reason,
        );
      }
      return this.#abandonPausedProviderWrites(turn, paused, reason);
    };
    while (outcomes.size < plan.delegations.length) {
      let progressed = false;
      for (const delegation of plan.delegations) {
        if (outcomes.has(delegation.id)) continue;
        const failedDependency = delegation.dependsOn
          .map((id) => outcomes.get(id))
          .find(
            (outcome) =>
              outcome !== undefined && outcome.status !== 'completed',
          );
        if (failedDependency !== undefined) {
          outcomes.set(
            delegation.id,
            Object.freeze({
              delegationId: delegation.id,
              specialistId: delegation.specialistId,
              status: 'blocked' as const,
              safeError: safeError(
                'specialist-dependency-failed',
                'A required specialist dependency did not complete.',
                false,
              ),
              usage: ZERO_USAGE,
            }),
          );
          progressed = true;
        }
      }
      const ready = plan.delegations.filter(
        (delegation) =>
          !outcomes.has(delegation.id) &&
          delegation.dependsOn.every(
            (dependency) => outcomes.get(dependency)?.status === 'completed',
          ),
      );
      if (ready.length === 0) {
        if (progressed) continue;
        return this.#failed(
          turn.runId,
          trace,
          safeError(
            'invalid-manager-plan',
            'The assistant produced an invalid dependency plan.',
            false,
          ),
          [...outcomes.values()],
          usage,
          activeResolution,
        );
      }
      const maximumParallel = Math.min(
        3,
        this.#manager.manifest.executionBudget.maxParallelCalls,
      );
      for (let offset = 0; offset < ready.length; offset += maximumParallel) {
        wave += 1;
        const batch = ready.slice(offset, offset + maximumParallel);
        const waveResolution = activeResolution;
        for (const delegation of batch) {
          await trace.record('specialist.dispatched', {
            delegationId: delegation.id,
            agentId: delegation.specialistId,
            wave,
            dependsOn: delegation.dependsOn,
          });
        }
        const settled = await Promise.allSettled(
          batch.map(async (delegation) => {
            const specialist = this.#specialists.get(delegation.specialistId)!;
            const dependencyOutcomes = delegation.dependsOn.map((dependency) =>
              outcomes.get(dependency)!,
            );
            const execution = await this.#runSpecialistProvider(
              specialist,
              waveResolution,
              delegation.id,
              snapshotDisclosureSources([
                Object.freeze({
                  kind: 'specialist-delegation' as const,
                  delegation: snapshotJson(delegation),
                }),
                ...dependencyOutcomes.map((outcome) =>
                  Object.freeze({
                    kind: 'specialist-outcome' as const,
                    outcome: snapshotJson(outcome),
                  }),
                ),
              ]),
              turn,
              trace,
              turnProviderWriteLedger,
            );
            return { delegation, specialist, execution };
          }),
        );
        const paused = settled.flatMap((result) => {
          if (
            result.status !== 'fulfilled' ||
            result.value.execution.status !== 'result' ||
            result.value.execution.result.status !== 'interrupted'
          ) {
            return [];
          }
          return [
            this.#paused(
              'specialist',
              result.value.delegation.id,
              result.value.specialist,
              result.value.execution.result,
            ),
          ];
        });
        try {
          for (const [index, result] of settled.entries()) {
            const delegation = batch[index]!;
            if (result.status === 'rejected') {
              const outcome: SpecialistOutcome = Object.freeze({
                delegationId: delegation.id,
                specialistId: delegation.specialistId,
                status: 'failed',
                safeError: safeError(
                  'specialist-execution-failed',
                  'A specialist could not complete its delegated work.',
                  true,
                ),
                usage: ZERO_USAGE,
              });
              outcomes.set(delegation.id, outcome);
              await trace.record('specialist.outcome', {
                delegationId: delegation.id,
                agentId: delegation.specialistId,
                status: outcome.status,
              });
              continue;
            }
            const execution = result.value.execution;
            if (execution.status === 'failed') {
              usage = addUsage(usage, execution.usage);
              const outcome: SpecialistOutcome = Object.freeze({
                delegationId: delegation.id,
                specialistId: delegation.specialistId,
                status: 'failed',
                safeError: execution.safeError,
                usage: execution.usage,
              });
              outcomes.set(delegation.id, outcome);
              await trace.record('specialist.outcome', {
                delegationId: delegation.id,
                agentId: delegation.specialistId,
                status: outcome.status,
                errorCode: execution.safeError.code,
              });
              continue;
            }
            if (execution.modelResolution.resolvedModel === 'gpt-5.6-terra') {
              activeResolution = execution.modelResolution;
            }
            usage = addUsage(usage, execution.result.usage);
            if (execution.result.status === 'interrupted') continue;
            const outcome: SpecialistOutcome = Object.freeze({
              delegationId: delegation.id,
              specialistId: delegation.specialistId,
              status: 'completed',
              output: execution.result.output,
              usage: execution.result.usage,
            });
            outcomes.set(delegation.id, outcome);
            await trace.record('specialist.outcome', {
              delegationId: delegation.id,
              agentId: delegation.specialistId,
              status: outcome.status,
            });
          }
        } catch {
          const abandoned = await cleanupPreparedWrites(
            paused,
            'execution-ended-before-checkpoint',
          );
          return this.#failed(
            turn.runId,
            trace,
            abandoned
              ? safeError(
                  'specialist-result-processing-failed',
                  'Specialist results could not be recorded safely.',
                  false,
                )
              : safeError(
                  'provider-write-proposal-finalization-pending',
                  'A prepared external action could not be terminalized safely. Reconciliation is required before retrying.',
                  false,
                ),
            [...outcomes.values()],
            usage,
            activeResolution,
          );
        }
        const interruptionCount = paused.reduce(
          (count, execution) => count + execution.interruptions.length,
          0,
        );
        const everyInterruptionExactBound = paused.every((execution) =>
          execution.interruptions.every(
            (interruption) =>
              interruption.sdkCallId !== undefined &&
              interruption.providerAuthorityBindingHash !== undefined &&
              interruption.authorizationScopeFingerprint !== undefined,
          ),
        );
        if (paused.length > 0 && !everyInterruptionExactBound) {
          await cleanupPreparedWrites(
            paused,
            'execution-ended-before-checkpoint',
          );
          return this.#failed(
            turn.runId,
            trace,
            safeError(
              'provider-write-proposal-finalization-pending',
              'A provider-write interruption was not bound to a terminalizable proposal. Reconciliation is required before retrying.',
              false,
            ),
            [...outcomes.values()],
            usage,
            activeResolution,
          );
        }
        const multipleWriteFailure = settled.some(
          (result) =>
            result.status === 'fulfilled' &&
            result.value.execution.status === 'failed' &&
            result.value.execution.safeError.code ===
              'multiple-provider-writes-require-separate-turns',
        );
        const finalizationPending = settled.some(
          (result) =>
            result.status === 'fulfilled' &&
            result.value.execution.status === 'failed' &&
            result.value.execution.safeError.code ===
              'provider-write-proposal-finalization-pending',
        );
        if (
          turnProviderWriteLedger.multipleProviderWritesRequested ||
          interruptionCount > 1 ||
          multipleWriteFailure
        ) {
          const abandoned = await cleanupPreparedWrites(
            paused,
            'multiple-provider-writes-require-separate-turns',
          );
          for (const execution of paused) {
            outcomes.set(
              execution.executionKey,
              Object.freeze({
                delegationId: execution.executionKey,
                specialistId: execution.agentId,
                status: 'failed' as const,
                safeError: safeError(
                  abandoned
                    ? 'multiple-provider-writes-require-separate-turns'
                    : 'provider-write-proposal-finalization-pending',
                  abandoned
                    ? 'Each provider write requires a separate assistant turn and visual approval.'
                    : 'A prepared external action could not be terminalized safely. Reconciliation is required before retrying.',
                  false,
                ),
                usage: execution.usage,
              }),
            );
          }
          return this.#failed(
            turn.runId,
            trace,
            safeError(
              abandoned
                ? 'multiple-provider-writes-require-separate-turns'
                : 'provider-write-proposal-finalization-pending',
              abandoned
                ? 'Each provider write requires a separate assistant turn and visual approval.'
                : 'A prepared external action could not be terminalized safely. Reconciliation is required before retrying.',
              false,
            ),
            [...outcomes.values()],
            usage,
            activeResolution,
          );
        }
        if (finalizationPending) {
          return this.#failed(
            turn.runId,
            trace,
            safeError(
              'provider-write-proposal-finalization-pending',
              'A prepared external action could not be terminalized safely. Reconciliation is required before retrying.',
              false,
            ),
            [...outcomes.values()],
            usage,
            activeResolution,
          );
        }
        if (paused.length > 0) {
          return this.#pause(
            turn,
            activeResolution,
            plan,
            [...outcomes.values()],
            paused,
            usage,
            trace,
          );
        }
      }
    }
    return this.#synthesize(
      turn,
      activeResolution,
      plan,
      plan.delegations.map((delegation) => outcomes.get(delegation.id)!),
      usage,
      trace,
    );
  }

  async #synthesize(
    turn: PreparedTurnInput,
    modelResolution: Extract<ModelResolution, { status: 'resolved' }>,
    plan: ManagerPlan,
    outcomes: readonly SpecialistOutcome[],
    usage: AgentUsage,
    trace: ActiveLocalTrace,
  ): Promise<TurnResult> {
    let activeResolution = modelResolution;
    let totalUsage = usage;
    let lastFailure: RuntimeFallbackCause = 'luna-execution-failed';
    const synthesisSources = snapshotDisclosureSources([
      Object.freeze({
        kind: 'conversation-message' as const,
        entry: turn.currentMessage,
      }),
      Object.freeze({
        kind: 'manager-plan' as const,
        plan: snapshotJson(plan),
      }),
      ...outcomes.map((outcome) =>
        Object.freeze({
          kind: 'specialist-outcome' as const,
          outcome: snapshotJson(outcome),
        }),
      ),
    ]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let synthesis: RuntimeProviderResult | undefined;
      try {
        synthesis = await this.#runProvider(
          'synthesize',
          this.#manager,
          activeResolution.resolvedModel,
          turn,
          trace,
          {
            phaseInvocationId: 'manager-synthesis',
            sources: synthesisSources,
          },
        );
      } catch {
        lastFailure = 'luna-execution-failed';
      }
      if (synthesis !== undefined) {
        totalUsage = addUsage(totalUsage, synthesis.usage);
      }
      if (synthesis?.status === 'failed') {
        const terminal = terminalProviderFailure(synthesis);
        if (terminal !== undefined) {
          return this.#failed(
            turn.runId,
            trace,
            terminal,
            outcomes,
            totalUsage,
            activeResolution,
          );
        }
        lastFailure = 'luna-execution-failed';
      }
      if (synthesis?.status === 'interrupted') {
        return this.#pause(
          turn,
          activeResolution,
          plan,
          outcomes,
          [
            this.#paused(
              'synthesize',
              'manager-synthesis',
              this.#manager,
              synthesis,
            ),
          ],
          totalUsage,
          trace,
        );
      }
      if (synthesis?.status === 'completed') {
        const parsed = this.#manager.outputSchema.safeParse(synthesis.output);
        if (parsed.success) {
          return this.#complete(
            turn,
            activeResolution,
            snapshotJson(parsed.data),
            outcomes,
            totalUsage,
            trace,
          );
        }
        lastFailure = 'failed-output-validation';
      }
      if (attempt > 0 || activeResolution.resolvedModel !== 'gpt-5.6-luna') {
        break;
      }
      let fallback: ModelResolution;
      try {
        fallback = await this.#resolveModel({
          triggers: [fallbackTrigger(lastFailure)],
          policy: this.#manager.manifest.modelPolicy,
        });
      } catch {
        break;
      }
      if (fallback.status === 'unavailable') {
        await trace.record('model.unavailable', {
          requestedModel: fallback.requestedModel,
          resolvedModel: null,
          attemptedModels: fallback.attemptedModels,
          reason: fallback.reason,
          ...('escalationTrigger' in fallback
            ? { escalationTrigger: fallback.escalationTrigger }
            : {}),
          safeErrorCode: fallback.safeError.code,
        });
        return this.#failed(
          turn.runId,
          trace,
          fallback.safeError,
          outcomes,
          totalUsage,
          fallback,
        );
      }
      if (fallback.resolvedModel !== 'gpt-5.6-terra') break;
      activeResolution = fallback;
      await trace.record('model.resolved', {
        requestedModel: fallback.requestedModel,
        resolvedModel: fallback.resolvedModel,
        reason: fallback.reason,
        fallbackCause: lastFailure,
      });
    }
    return this.#failed(
      turn.runId,
      trace,
      lastFailure === 'failed-output-validation'
        ? safeError(
            'manager-output-validation-failed',
            'The assistant response did not match its output contract.',
            false,
          )
        : safeError(
            'manager-synthesis-failed',
            'The assistant could not synthesize the specialist results.',
            true,
          ),
      outcomes,
      totalUsage,
      activeResolution,
    );
  }

  async #complete(
    turn: PreparedTurnInput,
    modelResolution: Extract<ModelResolution, { status: 'resolved' }>,
    output: JsonValue,
    outcomes: readonly SpecialistOutcome[],
    usage: AgentUsage,
    trace: ActiveLocalTrace,
  ): Promise<TurnResult> {
    try {
      await this.#memory.appendManagerMessage({
        conversationId: turn.conversationId,
        householdId: turn.householdId,
        userId: turn.userId,
        role: 'assistant',
        content: outputForMemory(output),
      });
    } catch {
      return this.#failed(
        turn.runId,
        trace,
        safeError(
          'conversation-persistence-failed',
          'The assistant result could not be saved to the conversation.',
          true,
        ),
        outcomes,
        usage,
        modelResolution,
      );
    }
    await trace.record('run.completed', {
      partialFailures: outcomes.some(
        (outcome) => outcome.status !== 'completed',
      ),
    });
    return Object.freeze({
      status: 'completed',
      runId: turn.runId,
      output,
      specialistOutcomes: Object.freeze([...outcomes]),
      hasPartialFailures: outcomes.some(
        (outcome) => outcome.status !== 'completed',
      ),
      usage,
      modelResolution,
      localTraceReference: trace.reference,
    });
  }

  async #pause(
    turn: PreparedTurnInput,
    modelResolution: Extract<ModelResolution, { status: 'resolved' }>,
    plan: ManagerPlan | undefined,
    outcomes: readonly SpecialistOutcome[],
    paused: readonly CollectedPausedExecution[],
    usage: AgentUsage,
    trace: ActiveLocalTrace,
  ): Promise<TurnResult> {
    if (!this.#isApprovalCheckpointAdmissible(plan, paused)) {
      const abandoned = await this.#abandonPausedProviderWrites(
        turn,
        paused,
        'execution-ended-before-checkpoint',
      );
      return this.#failed(
        turn.runId,
        trace,
        abandoned
          ? safeError(
              'invalid-provider-write-approval-interruption',
              'Only one exact-bound specialist provider write can request visual approval.',
              false,
            )
          : safeError(
              'provider-write-proposal-finalization-pending',
              'An invalid approval request could not be terminalized safely. Reconciliation is required before retrying.',
              false,
            ),
        outcomes,
        usage,
        modelResolution,
      );
    }
    let checkpointId: string | undefined;
    let checkpoint: ApprovalCheckpointView | undefined;
    let createAttempted = false;
    try {
      checkpointId = assertUuid(this.#createCheckpointId());
      const state: RuntimeCheckpointState = Object.freeze({
        version: RUNTIME_STATE_VERSION,
        turn: persistedScope(turn),
        modelResolution,
        ...(plan === undefined ? {} : { plan }),
        outcomes: Object.freeze([...outcomes]),
        paused: Object.freeze([...paused]),
        usage,
      });
      createAttempted = true;
      checkpoint = await this.#checkpoints.create({
        checkpointId,
        householdId: turn.householdId,
        userId: turn.userId,
        runId: turn.runId,
        agentGraphHash: this.#agentGraphHash,
        sdkVersion: this.#sdkVersion,
        ttlMs: this.#checkpointTtlMs,
        serializedState: JSON.stringify(state),
      });
    } catch {
      const [checkpointCancellation, proposalAbandonment] =
        await Promise.allSettled([
          !createAttempted || checkpointId === undefined
            ? Promise.resolve({ status: 'not-found' as const })
            : this.#checkpoints.cancel({
                checkpointId,
                householdId: turn.householdId,
                userId: turn.userId,
              }),
          this.#abandonPausedProviderWrites(
            turn,
            paused,
            'execution-ended-before-checkpoint',
          ),
        ]);
      const checkpointFinalized =
        checkpointCancellation.status === 'fulfilled'
          ? checkpointCancellationConfirmed(checkpointCancellation.value)
          : checkpointCancellationRejectedAsNotFound(
              checkpointCancellation.reason,
            );
      const proposalAbandoned =
        proposalAbandonment.status === 'fulfilled' && proposalAbandonment.value;
      return this.#failed(
        turn.runId,
        trace,
        checkpointFinalized && proposalAbandoned
          ? safeError(
              'approval-checkpoint-persistence-failed',
              'The approval checkpoint could not be saved.',
              true,
            )
          : safeError(
              'provider-write-proposal-finalization-pending',
              'A prepared external action could not be terminalized safely. Reconciliation is required before retrying.',
              false,
            ),
        outcomes,
        usage,
        modelResolution,
      );
    }
    if (checkpointId === undefined || checkpoint === undefined) {
      throw new Error('approval-checkpoint-persistence-invalid');
    }
    try {
      for (const execution of paused) {
        for (const interruption of execution.interruptions) {
          await trace.record('approval.interrupted', {
            checkpointId,
            proposalId: interruption.proposalId,
            capabilityId: interruption.capabilityId,
            agentId: interruption.agentId,
            channel: 'authenticated-visual',
          });
        }
      }
    } catch {
      const [checkpointCancellation, proposalAbandonment] =
        await Promise.allSettled([
          this.#checkpoints.cancel({
            checkpointId,
            householdId: turn.householdId,
            userId: turn.userId,
          }),
          this.#abandonPausedProviderWrites(
            turn,
            paused,
            'execution-ended-before-checkpoint',
          ),
        ]);
      const checkpointCancelled =
        checkpointCancellation.status === 'fulfilled'
          ? checkpointCancellationConfirmed(checkpointCancellation.value)
          : checkpointCancellationRejectedAsNotFound(
              checkpointCancellation.reason,
            );
      const proposalAbandoned =
        proposalAbandonment.status === 'fulfilled' && proposalAbandonment.value;
      return this.#failed(
        turn.runId,
        trace,
        checkpointCancelled && proposalAbandoned
          ? safeError(
              'approval-interruption-audit-failed',
              'The approval request could not be audited and was cancelled safely.',
              false,
            )
          : safeError(
              'provider-write-proposal-finalization-pending',
              'Approval state could not be terminalized safely. Reconciliation is required before retrying.',
              false,
            ),
        outcomes,
        usage,
        modelResolution,
      );
    }
    return Object.freeze({
      status: 'needs-approval',
      runId: turn.runId,
      checkpoint,
      interruptions: publicInterruptions(paused),
      specialistOutcomes: Object.freeze([...outcomes]),
      usage,
      modelResolution,
      localTraceReference: trace.reference,
    });
  }

  async #abandonPausedProviderWrites(
    turn: TurnInput,
    paused: readonly CollectedPausedExecution[],
    reason: ProviderWriteProposalAbandonmentReason,
  ): Promise<boolean> {
    const bound = paused.flatMap((execution) =>
      execution.interruptions.flatMap((interruption) =>
        interruption.sdkCallId === undefined ||
        interruption.providerAuthorityBindingHash === undefined
          ? []
          : [
              Object.freeze({
                proposalId: interruption.proposalId,
                capabilityId: interruption.capabilityId,
                sdkCallId: interruption.sdkCallId,
                providerAuthorityBindingHash:
                  interruption.providerAuthorityBindingHash,
                reason,
                scope: Object.freeze({
                  requestId: turn.requestId,
                  runId: turn.runId,
                  householdId: turn.householdId,
                  userId: turn.userId,
                  authenticatedSessionId: turn.authenticatedSessionId,
                  spaceAccessGrantId: turn.spaceAccessGrantId,
                  disclosureGrantId: execution.disclosureGrantId,
                  disclosurePolicyVersion: execution.disclosureGrantVersion,
                  agentId: execution.agentId,
                }),
              }),
            ],
      ),
    );
    const everyInterruptionBound =
      bound.length ===
      paused.reduce(
        (count, execution) => count + execution.interruptions.length,
        0,
      );
    const settled = await Promise.allSettled(
      bound.map((binding) => this.#proposalGateway.abandonPrepared(binding)),
    );
    return (
      everyInterruptionBound &&
      settled.every((result) => {
        if (result.status !== 'fulfilled') return false;
        try {
          return (
            snapshotPreparedProposalAbandonment(result.value).status !==
            'not-abandonable'
          );
        } catch {
          return false;
        }
      })
    );
  }

  #parseRuntimeState(serialized: string): RuntimeCheckpointState {
    const raw: unknown = JSON.parse(serialized);
    const value = asObject(snapshotJson(raw));
    assertExactKeys(
      value,
      ['version', 'turn', 'modelResolution', 'outcomes', 'paused', 'usage'],
      ['plan'],
    );
    if (value.version !== RUNTIME_STATE_VERSION) {
      throw new Error('invalid-runtime-checkpoint');
    }
    const turn = asObject(value.turn);
    assertExactKeys(
      turn,
      [
        'requestId',
        'runId',
        'householdId',
        'userId',
        'authenticatedSessionId',
        'conversationId',
        'spaceAccessGrantId',
        'authorizationScopeFingerprint',
        'locale',
        'message',
        'currentMessage',
      ],
      ['locale'],
    );
    const model = asObject(value.modelResolution);
    if (
      model.status !== 'resolved' ||
      (model.resolvedModel !== 'gpt-5.6-luna' &&
        model.resolvedModel !== 'gpt-5.6-terra')
    ) {
      throw new Error('invalid-runtime-checkpoint');
    }
    if (!Array.isArray(value.outcomes) || !Array.isArray(value.paused)) {
      throw new Error('invalid-runtime-checkpoint');
    }
    const parsedTurn: PersistedTurnScope = Object.freeze({
      requestId: assertUuid(turn.requestId),
      runId: assertUuid(turn.runId),
      householdId: assertUuid(turn.householdId),
      userId: assertUuid(turn.userId),
      authenticatedSessionId: assertUuid(turn.authenticatedSessionId),
      conversationId: assertUuid(turn.conversationId),
      spaceAccessGrantId: assertUuid(turn.spaceAccessGrantId),
      authorizationScopeFingerprint:
        EffectiveAuthorizationScopeFingerprintSchema.parse(
          turn.authorizationScopeFingerprint,
        ),
      locale:
        turn.locale === undefined
          ? 'en-CA'
          : SupportedLocaleSchema.parse(turn.locale),
      message:
        typeof turn.message === 'string' &&
        turn.message.length <= MAX_MESSAGE_LENGTH
          ? turn.message
          : (() => {
              throw new Error('invalid-runtime-checkpoint');
            })(),
      currentMessage: snapshotConversationEntry(turn.currentMessage),
    });
    if (
      parsedTurn.currentMessage.conversationId !== parsedTurn.conversationId ||
      parsedTurn.currentMessage.householdId !== parsedTurn.householdId ||
      parsedTurn.currentMessage.userId !== parsedTurn.userId ||
      parsedTurn.currentMessage.role !== 'user' ||
      parsedTurn.currentMessage.content !== parsedTurn.message
    ) {
      throw new Error('invalid-runtime-checkpoint');
    }
    const plan =
      value.plan === undefined
        ? undefined
        : parseManagerPlan(
            value.plan,
            this.#specialists,
            this.#manager.manifest.executionBudget.maxCapabilityCalls,
          );
    const outcomes = Object.freeze(
      value.outcomes.map((rawOutcome) => this.#parseOutcome(rawOutcome)),
    );
    const paused = Object.freeze(
      value.paused.map((rawPaused) => this.#parsePaused(rawPaused)),
    );
    if (!this.#isApprovalCheckpointAdmissible(plan, paused)) {
      throw new Error('invalid-runtime-checkpoint');
    }
    return Object.freeze({
      version: RUNTIME_STATE_VERSION,
      turn: parsedTurn,
      modelResolution: model as unknown as Extract<
        ModelResolution,
        { status: 'resolved' }
      >,
      ...(plan === undefined ? {} : { plan }),
      outcomes,
      paused,
      usage: snapshotUsage(value.usage),
    });
  }

  #parseOutcome(raw: JsonValue): SpecialistOutcome {
    const value = asObject(raw);
    assertExactKeys(
      value,
      ['delegationId', 'specialistId', 'status', 'usage'],
      ['output', 'safeError'],
    );
    if (
      value.status !== 'completed' &&
      value.status !== 'failed' &&
      value.status !== 'blocked'
    ) {
      throw new Error('invalid-runtime-checkpoint');
    }
    let parsedError: SafeAgentError | undefined;
    if (value.safeError !== undefined) {
      const error = asObject(value.safeError);
      assertExactKeys(error, ['code', 'message', 'retryable']);
      if (
        typeof error.code !== 'string' ||
        typeof error.message !== 'string' ||
        typeof error.retryable !== 'boolean'
      ) {
        throw new Error('invalid-runtime-checkpoint');
      }
      parsedError = safeError(error.code, error.message, error.retryable);
    }
    return Object.freeze({
      delegationId: assertIdentifier(value.delegationId),
      specialistId: assertIdentifier(value.specialistId),
      status: value.status,
      ...(value.output === undefined
        ? {}
        : { output: snapshotJson(value.output) }),
      ...(parsedError === undefined ? {} : { safeError: parsedError }),
      usage: snapshotUsage(value.usage),
    });
  }

  #parsePaused(raw: JsonValue): PausedExecution {
    const value = asObject(raw);
    assertExactKeys(value, [
      'phase',
      'executionKey',
      'agentId',
      'serializedState',
      'interruptions',
      'usage',
      'capabilityCalls',
      'disclosureGrantId',
      'disclosureGrantVersion',
      'authorizationScopeFingerprint',
    ]);
    if (
      value.phase !== 'plan' &&
      value.phase !== 'specialist' &&
      value.phase !== 'synthesize'
    ) {
      throw new Error('invalid-runtime-checkpoint');
    }
    const provider = snapshotProviderResult({
      status: 'interrupted',
      serializedState: value.serializedState,
      interruptions: value.interruptions,
      usage: value.usage,
      capabilityCalls: value.capabilityCalls,
    });
    if (provider.status !== 'interrupted') {
      throw new Error('invalid-runtime-checkpoint');
    }
    return Object.freeze({
      phase: value.phase,
      executionKey: assertIdentifier(value.executionKey),
      agentId: assertIdentifier(value.agentId),
      serializedState: provider.serializedState,
      interruptions: provider.interruptions,
      usage: provider.usage,
      capabilityCalls: provider.capabilityCalls ?? 0,
      disclosureGrantId: assertUuid(value.disclosureGrantId),
      disclosureGrantVersion:
        typeof value.disclosureGrantVersion === 'string' &&
        SEMVER_PATTERN.test(value.disclosureGrantVersion)
          ? value.disclosureGrantVersion
          : (() => {
              throw new Error('invalid-runtime-checkpoint');
            })(),
      authorizationScopeFingerprint:
        EffectiveAuthorizationScopeFingerprintSchema.parse(
          value.authorizationScopeFingerprint,
        ),
    });
  }

  async #failed(
    runId: string,
    trace: ActiveLocalTrace,
    error: SafeAgentError,
    outcomes: readonly SpecialistOutcome[] = [],
    usage: AgentUsage = ZERO_USAGE,
    modelResolution?: ModelResolution,
  ): Promise<FailedTurnResult> {
    await trace.record('run.failed', { code: error.code });
    return Object.freeze({
      status: 'failed',
      runId,
      safeError: error,
      specialistOutcomes: Object.freeze([...outcomes]),
      usage,
      ...(modelResolution === undefined ? {} : { modelResolution }),
      localTraceReference: trace.reference,
    });
  }
}

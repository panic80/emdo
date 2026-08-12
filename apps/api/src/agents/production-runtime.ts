import {
  AgentFactory,
  AgentOrchestrator,
  LocalTraceRecorder,
  ModelRouter,
  OpenAiAgentsExecutionProvider,
  type LocalTraceSink,
  createOpenAiAgentsSdkFacade,
  type ApprovalCheckpointGateway,
  type ManagerConversationMemory,
  type ModelAvailability,
  type ModelDisclosureGateway,
  type ModelEscalationTrigger,
  type OpenAiAgentCostCalculator,
  type OpenAiSdkAgent,
  type OpenAiSdkFunctionTool,
  type SpendGuard,
  type TurnResult,
} from '@emdo/agent-core';
import { financeAgentDefinition } from '@emdo/agent-finance';
import { managerAgentDefinition } from '@emdo/agent-manager';
import { schedulerAgentDefinition } from '@emdo/agent-scheduler';
import { shoppingAgentDefinition } from '@emdo/agent-shopping';
import {
  AgentManifestSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
  OpaqueReferenceSchema,
  UuidSchema,
  type EffectiveAuthorizationScopeFingerprint,
} from '@emdo/contracts';
import {
  FOUNDATIONAL_SKILLS,
  hashCanonicalJson,
  type TrustedProviderWriteAuthorityResolver,
} from '@emdo/toolbox';
import { z } from 'zod';

import type {
  AuthenticatedPrincipal,
  ManagerTurnAcceptance,
  ManagerTurnGateway,
  PersistedRunEventGateway,
  TurnRequest,
} from '../services/contracts.js';
import {
  createProductionApprovalResumeBinding,
  type DurableApprovalDecisionResumeBoundary,
} from './approval-resume.js';
import {
  ALL_MANAGER_DELEGATION_CAPABILITY_IDS,
  ALL_SPECIALIST_CAPABILITY_IDS,
  createProductionCapabilityRuntime,
  type TrustedProviderProposalAuthorityResolver,
} from './capability-runtime.js';
import {
  createProductionCapabilityBindings,
  type TrustedProductionCapabilityServices,
} from './production-bindings.js';
import type { ProductionProviderProposalComposition } from './proposal-gateway.js';

const SDK_VERSION = '0.14.3' as const;
const REQUESTED_MODEL_ESCALATION_TRIGGERS = Object.freeze([
  'dependent-cross-domain',
  'failed-output-validation',
  'low-confidence-reconciliation',
  'complex-reasoning',
] as const);
type RequestedModelEscalationTrigger = Exclude<
  ModelEscalationTrigger,
  'luna-unavailable'
>;

/**
 * These are missing server-owned adapters, not optional feature flags. The
 * bundled API must report the agent graph unavailable until every boundary is
 * supplied by a durable production composition.
 */
export const PRODUCTION_AGENT_RUNTIME_BLOCKERS = Object.freeze([
  'agents.approval-checkpoints',
  'agents.approval-resume-dispatch',
  'agents.calendar-provider-reads',
  'agents.calendar-provider-writes',
  'agents.commerce-connectors',
  'agents.conversation-memory',
  'agents.disclosure-authority',
  'agents.domain-persistence',
  'agents.local-trace-persistence',
  'agents.maps-provider',
  'agents.model-cost-policy',
  'agents.openai-provider',
  'agents.proposal-gateway',
  'agents.provider-completion-receipts',
  'agents.run-events',
  'agents.spend-ledger',
  'agents.turn-idempotency',
] as const);

export interface ProductionAgentRuntimeDependencies {
  readonly capabilityServices: TrustedProductionCapabilityServices;
  readonly proposals: ProductionProviderProposalComposition;
  readonly trustedProviderWriteAuthorityResolver: TrustedProviderWriteAuthorityResolver;
  readonly trustedProviderProposalAuthorityResolver: TrustedProviderProposalAuthorityResolver;
  readonly modelAvailability: ModelAvailability;
  readonly memory: ManagerConversationMemory;
  readonly traceSink: LocalTraceSink;
  readonly approvalCheckpoints: ApprovalCheckpointGateway;
  readonly disclosureGateway: ModelDisclosureGateway;
  readonly costCalculator: OpenAiAgentCostCalculator;
  readonly spendGuard: Pick<
    SpendGuard,
    'reserve' | 'markDispatched' | 'settle' | 'release'
  >;
}

export interface ProductionAgentRuntime {
  readonly orchestrator: AgentOrchestrator;
  readonly agentIds: readonly ['manager', 'scheduler', 'finance', 'shopping'];
  readonly capabilityIds: readonly string[];
  readonly agentGraphHash: string;
  readonly sdkVersion: typeof SDK_VERSION;
}

const graphDefinitions = Object.freeze([
  managerAgentDefinition,
  schedulerAgentDefinition,
  financeAgentDefinition,
  shoppingAgentDefinition,
] as const);

const graphHashInput = (
  capabilityRuntime: ReturnType<typeof createProductionCapabilityRuntime>,
) => ({
  schemaVersion: 1,
  sdkVersion: SDK_VERSION,
  agents: graphDefinitions.map((definition) => ({
    manifest: definition.manifest,
    instructions: definition.instructions,
    skills: definition.skills,
    capabilityReferences: definition.capabilityReferences,
    capabilityDescriptors: capabilityRuntime.registry
      .resolveForAgent({
        manifest: definition.manifest,
        requestedCapabilityIds: definition.manifest.capabilityAllowlist,
      })
      .map(({ descriptor }) => descriptor),
  })),
});

/**
 * Constructs the real @openai/agents graph from request-scoped, server-owned
 * adapters. No repository, fixture, provider result, or credential is created
 * here; callers must supply every durable boundary explicitly.
 */
export const createProductionAgentRuntime = (
  dependencies: ProductionAgentRuntimeDependencies,
): ProductionAgentRuntime => {
  const bindings = createProductionCapabilityBindings(
    dependencies.capabilityServices,
  );
  const capabilityRuntime = createProductionCapabilityRuntime({
    bindings,
    providerWriteApprovalStore: dependencies.proposals.approvalStore,
    trustedProviderWriteAuthorityResolver:
      dependencies.trustedProviderWriteAuthorityResolver,
    trustedProviderProposalAuthorityResolver:
      dependencies.trustedProviderProposalAuthorityResolver,
  });
  const proposalGateway =
    dependencies.proposals.createGateway(capabilityRuntime);
  const sdk = createOpenAiAgentsSdkFacade({
    proposalGateway,
  });
  const factory = new AgentFactory<OpenAiSdkAgent, OpenAiSdkFunctionTool>({
    validateManifest: (value) => AgentManifestSchema.parse(value),
    capabilityRegistry: capabilityRuntime.registry,
    schemaResolver: capabilityRuntime.schemaResolver,
    sharedSkills: FOUNDATIONAL_SKILLS,
    sdk,
  });
  const [manager, scheduler, finance, shopping] = graphDefinitions.map(
    (definition) => factory.compile(definition),
  ) as [
    ReturnType<typeof factory.compile>,
    ReturnType<typeof factory.compile>,
    ReturnType<typeof factory.compile>,
    ReturnType<typeof factory.compile>,
  ];

  // Materialization is local and performs no provider I/O. Doing it at boot
  // rejects an SDK/schema/tool mismatch before readiness can turn green.
  for (const compiled of [manager, scheduler, finance, shopping]) {
    compiled.materialize(compiled.manifest.modelPolicy.defaultModel);
  }

  const executionProvider = new OpenAiAgentsExecutionProvider({
    proposalGateway,
    costCalculator: dependencies.costCalculator,
    spendGuard: dependencies.spendGuard,
  });
  if (executionProvider.sdkVersion !== SDK_VERSION) {
    throw new Error('api-agent-sdk-version-mismatch');
  }
  const agentGraphHash = hashCanonicalJson(graphHashInput(capabilityRuntime));
  const orchestrator = new AgentOrchestrator({
    manager,
    specialists: [scheduler, finance, shopping],
    executionProvider,
    modelRouter: new ModelRouter(dependencies.modelAvailability),
    memory: dependencies.memory,
    traceRecorder: new LocalTraceRecorder(dependencies.traceSink),
    approvalCheckpoints: dependencies.approvalCheckpoints,
    proposalGateway,
    disclosureGateway: dependencies.disclosureGateway,
    agentGraphHash,
    sdkVersion: SDK_VERSION,
  });
  return Object.freeze({
    orchestrator,
    agentIds: Object.freeze([
      'manager',
      'scheduler',
      'finance',
      'shopping',
    ] as const),
    capabilityIds: Object.freeze([
      ...ALL_MANAGER_DELEGATION_CAPABILITY_IDS,
      ...ALL_SPECIALIST_CAPABILITY_IDS,
    ]),
    agentGraphHash,
    sdkVersion: SDK_VERSION,
  });
};

export type DurableManagerTurnClaim =
  | Readonly<{
      status: 'replay';
      runId: string;
      conversationId: string;
    }>
  | Readonly<{
      status: 'claimed';
      claimId: string;
      ownershipToken: string;
      runId: string;
      conversationId: string;
      disclosureGrantId?: string;
      authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
      escalationTriggers: readonly RequestedModelEscalationTrigger[];
    }>;

const DurableManagerTurnClaimSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('replay'),
    runId: UuidSchema,
    conversationId: UuidSchema,
  }),
  z.strictObject({
    status: z.literal('claimed'),
    claimId: OpaqueReferenceSchema,
    ownershipToken: OpaqueReferenceSchema,
    runId: UuidSchema,
    conversationId: UuidSchema,
    disclosureGrantId: UuidSchema.optional(),
    authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprintSchema,
    escalationTriggers: z
      .array(z.enum(REQUESTED_MODEL_ESCALATION_TRIGGERS))
      .max(REQUESTED_MODEL_ESCALATION_TRIGGERS.length)
      .refine((values) => new Set(values).size === values.length),
  }),
]);

const parseDurableManagerTurnClaim = (
  value: unknown,
): DurableManagerTurnClaim => {
  const parsed = DurableManagerTurnClaimSchema.safeParse(value);
  if (!parsed.success) throw new Error('api-agent-turn-claim-invalid');
  return Object.freeze({
    ...parsed.data,
    ...(parsed.data.status === 'claimed'
      ? {
          escalationTriggers: Object.freeze([
            ...parsed.data.escalationTriggers,
          ]),
        }
      : {}),
  }) as DurableManagerTurnClaim;
};

export interface DurableManagerTurnStore {
  /**
   * Atomically binds principal, request, payload, and idempotency key before
   * any runtime construction or model I/O. A replay never owns execution.
   */
  claim(input: {
    readonly request: TurnRequest;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<DurableManagerTurnClaim>;
  /** Commits the exact terminal/approval result under the claim CAS. */
  complete(input: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly runId: string;
    readonly result: TurnResult;
  }): Promise<
    | Readonly<{
        status: 'completed' | 'replay';
        /** Sequence of the terminal event appended atomically with the CAS. */
        terminalEventSequence: number;
      }>
    | Readonly<{ status: 'conflict' }>
  >;
  /**
   * Conservative crash boundary. It must never release the claim for a second
   * dispatch; an operator/reconciler owns any later recovery.
   */
  markIndeterminate(input: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly runId: string;
    readonly reasonCode: 'agent-runtime-failed';
  }): Promise<
    | Readonly<{
        status: 'indeterminate' | 'replay';
        /** Sequence of the durable reconciliation-required terminal event. */
        terminalEventSequence: number;
      }>
    | Readonly<{ status: 'conflict' }>
  >;
  check(): Promise<boolean>;
}

export interface DurableRunEventSource extends PersistedRunEventGateway {
  check(): Promise<boolean>;
}

export interface ProductionAgentRuntimeFactory {
  create(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly runId: string;
    readonly conversationId: string;
    readonly approvalResume?: Readonly<{
      checkpointId: string;
      proposalId: string;
      approvalDecisionId: string;
      authenticatedSessionId: string;
      disclosureGrantId: string;
      disclosureGrantVersion: string;
      collectionAuthorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
      authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
    }>;
  }): Promise<ProductionAgentRuntime>;
  check(): Promise<boolean>;
}

export interface ProductionAgentServiceDependencies {
  readonly turns: DurableManagerTurnStore;
  readonly runEvents: DurableRunEventSource;
  readonly runtimeFactory: ProductionAgentRuntimeFactory;
  readonly approvalResume?: DurableApprovalDecisionResumeBoundary;
}

const accepted = (runId: string, replayed: boolean): ManagerTurnAcceptance =>
  Object.freeze({
    schemaVersion: 1,
    runId,
    status: 'accepted',
    replayed,
    eventsPath: `/api/v1/runs/${runId}/events`,
  });

const safeCheck = async (
  ...checks: ReadonlyArray<() => Promise<boolean>>
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

export const createProductionAgentServiceBindingsFromDependencies = (
  dependencies: ProductionAgentServiceDependencies,
) => {
  if (
    typeof dependencies?.turns?.claim !== 'function' ||
    typeof dependencies.turns.complete !== 'function' ||
    typeof dependencies.turns.markIndeterminate !== 'function' ||
    typeof dependencies.turns.check !== 'function' ||
    typeof dependencies.runEvents?.open !== 'function' ||
    typeof dependencies.runEvents.check !== 'function' ||
    typeof dependencies.runtimeFactory?.create !== 'function' ||
    typeof dependencies.runtimeFactory.check !== 'function'
  ) {
    throw new Error('api-production-agent-service-dependency-invalid');
  }
  const turns = dependencies.turns;
  const runtimeFactory = dependencies.runtimeFactory;
  const eventSource = dependencies.runEvents;
  const approvalResume =
    dependencies.approvalResume === undefined
      ? undefined
      : createProductionApprovalResumeBinding({
          boundary: dependencies.approvalResume,
          runtimeFactory,
        });
  const startManagerTurn: ManagerTurnGateway['start'] = async (input) => {
    const claim = parseDurableManagerTurnClaim(await turns.claim(input));
    if (claim.status === 'replay') return accepted(claim.runId, true);
    let replayed = false;
    try {
      const runtime = await runtimeFactory.create({
        principal: input.principal,
        requestId: input.requestId,
        runId: claim.runId,
        conversationId: claim.conversationId,
      });
      const result = await runtime.orchestrator.runTurn({
        requestId: input.requestId,
        runId: claim.runId,
        householdId: input.principal.householdId,
        userId: input.principal.userId,
        authenticatedSessionId: input.principal.sessionId,
        conversationId: claim.conversationId,
        spaceAccessGrantId: input.principal.spaceAccessGrantId,
        authorizationScopeFingerprint: claim.authorizationScopeFingerprint,
        ...(claim.disclosureGrantId === undefined
          ? {}
          : { disclosureGrantId: claim.disclosureGrantId }),
        message: input.request.message,
        escalationTriggers: claim.escalationTriggers,
        abortSignal: new AbortController().signal,
      });
      const completion = await turns.complete({
        claimId: claim.claimId,
        ownershipToken: claim.ownershipToken,
        runId: claim.runId,
        result,
      });
      if (
        completion.status !== 'completed' &&
        completion.status !== 'replay' &&
        completion.status !== 'conflict'
      ) {
        throw new Error('api-agent-turn-completion-invalid');
      }
      if (completion.status === 'conflict') {
        throw new Error('api-agent-turn-completion-conflict');
      }
      if (
        !Number.isSafeInteger(completion.terminalEventSequence) ||
        completion.terminalEventSequence <= 0
      ) {
        throw new Error('api-agent-turn-completion-invalid');
      }
      replayed = completion.status === 'replay';
    } catch {
      const marked = await turns.markIndeterminate({
        claimId: claim.claimId,
        ownershipToken: claim.ownershipToken,
        runId: claim.runId,
        reasonCode: 'agent-runtime-failed',
      });
      if (
        marked.status !== 'indeterminate' &&
        marked.status !== 'replay' &&
        marked.status !== 'conflict'
      ) {
        throw new Error('api-agent-turn-indeterminate-invalid');
      }
      if (marked.status === 'conflict') {
        throw new Error('api-agent-turn-indeterminate-conflict');
      }
      if (
        !Number.isSafeInteger(marked.terminalEventSequence) ||
        marked.terminalEventSequence <= 0
      ) {
        throw new Error('api-agent-turn-indeterminate-invalid');
      }
      replayed = marked.status === 'replay';
    }
    return accepted(claim.runId, replayed);
  };
  const managerTurns: ManagerTurnGateway = Object.freeze({
    start: startManagerTurn,
  });
  const runEvents: PersistedRunEventGateway = Object.freeze({
    open: (input: Parameters<PersistedRunEventGateway['open']>[0]) =>
      eventSource.open(input),
  });
  return Object.freeze({
    bindings: Object.freeze({
      managerTurns: Object.freeze({
        service: managerTurns,
        check: () =>
          safeCheck(
            turns.check.bind(turns),
            runtimeFactory.check.bind(runtimeFactory),
          ),
      }),
      runEvents: Object.freeze({
        service: runEvents,
        check: () => safeCheck(eventSource.check.bind(eventSource)),
      }),
      ...(approvalResume === undefined ? {} : { proposals: approvalResume }),
    }),
  });
};

export interface ProductionAgentEnvironmentComposition {
  readonly bindings: Readonly<Record<string, never>>;
  readonly blockers: typeof PRODUCTION_AGENT_RUNTIME_BLOCKERS;
  readonly close?: undefined;
}

/**
 * The current repository has no complete environment-to-request-scope adapter:
 * in particular there is no durable turn-idempotency store or complete set of
 * scheduler/finance/shopping/provider services. Environment credentials alone
 * can never authorize substitutes, so this default remains explicitly empty.
 */
export const createProductionAgentServiceBindings = async (
  environment: Readonly<Record<string, string | undefined>>,
): Promise<ProductionAgentEnvironmentComposition> => {
  // The values are deliberately not inspected until all adapters exist. This
  // also prevents an incomplete composition from treating secret presence as
  // authority or health evidence.
  void environment;
  return Object.freeze({
    bindings: Object.freeze({}),
    blockers: PRODUCTION_AGENT_RUNTIME_BLOCKERS,
    close: undefined,
  });
};

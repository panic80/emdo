import { randomUUID } from 'node:crypto';

import {
  ApprovalCheckpointService,
  type ApprovalCheckpointCipher,
  type LocalTraceSink,
} from '@emdo/agent-core';
import {
  ActionDecisionSchema,
  ActionProposalSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
  JsonValueSchema,
  ProviderWriteAuthorityBindingSchema,
  SemanticVersionSchema,
  UuidSchema,
  deepFreeze,
} from '@emdo/contracts';
import {
  CanonicalRecordEnvelopeDisclosureFilter,
  PostgresAgentMemoryRepository,
  PostgresApprovalCheckpointRepository,
  PostgresDataDisclosureGrantIssuer,
  PostgresGoogleCalendarProviderAuthorityResolver,
  PostgresGoogleCalendarProposalAuthorityResolver,
  PostgresModelDisclosureGateway,
  PostgresProposalRepository,
  PostgresSchedulerDisclosureGrantResolver,
  type DurableRepositoryPrincipal,
  type EmdoDatabaseClient,
  type ProposalRepository,
} from '@emdo/db/api';
import {
  ProposalService,
  createProposalLifecycleService,
  hashActionProposalApproval,
  type ProposalPreparationBinding,
  type TrustedDisclosureGrantResolver,
  type TrustedProposalMaterializer,
} from '@emdo/domains/server/provider-proposals';
import {
  CalendarCanonicalArgumentsSchema,
  ScopedCalendarProposalMaterializer,
} from '@emdo/domains/scheduler';
import {
  hashCanonicalJson,
  hashCapabilityDescriptorBinding,
} from '@emdo/toolbox';
import { z } from 'zod';

import type { TrustedProviderProposalAuthorityResolver } from '../agents/capability-runtime.js';
import type { TrustedProviderWriteCapabilityBinding } from '../agents/production-bindings.js';
import {
  createCoreProductionAgentRuntime,
  type CoreProductionAgentRuntime,
} from '../agents/production-runtime.js';
import {
  createPostgresCoreModelDisclosureGateway,
  createPostgresManagerConversationMemory,
} from '../agents/production-runtime-foundations.js';
import {
  createProductionProviderProposalComposition,
  type TrustedProviderWriteDecisionPresenter,
} from '../agents/proposal-gateway.js';
import { AuthenticatedPrincipalSchema } from '../schemas.js';
import {
  createRequestScopedGoogleCalendarEventCreateBinding,
  createPostgresGoogleCalendarProposalAuthorityResolver,
  createRequestScopedGoogleCalendarCoreRuntime,
} from './core-agent-composition.js';
import {
  createRequestScopedModelSpendGuard,
  type ProductionOpenAiAgentServiceBundle,
} from './core-openai-services.js';
import type {
  RequestScopedGoogleCalendarConditionalGatewayFactory,
  RequestScopedGoogleCalendarProposalReaderFactory,
} from './google-services.js';

type DatabasePool = EmdoDatabaseClient['scopedPool'];

const PrincipalWithPrivateSpaceSchema = AuthenticatedPrincipalSchema.extend({
  privateSpaceId: UuidSchema,
});
const MaterializationContextSchema = z.strictObject({
  requestId: UuidSchema,
  runId: UuidSchema,
  householdId: UuidSchema,
  userId: UuidSchema,
  authenticatedSessionId: UuidSchema,
  spaceAccessGrantId: UuidSchema,
  authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprintSchema,
  disclosureGrantId: UuidSchema,
  disclosureGrantVersion: SemanticVersionSchema,
  sdkCallId: z.string().trim().min(1).max(512),
  abortSignal: z.custom<AbortSignal>(
    (value) =>
      value !== null &&
      typeof value === 'object' &&
      typeof (value as AbortSignal).aborted === 'boolean',
  ),
});

type PrincipalWithPrivateSpace = z.output<typeof PrincipalWithPrivateSpaceSchema>;
type MaterializeProposal = TrustedProviderWriteCapabilityBinding['materializeProposal'];

const PROPOSAL_LIFETIME_MS = 300_000;

type CoreProposalService = Pick<ProposalService, 'create'>;
type RequestScopedGoogleCalendarCoreFactory =
  RequestScopedGoogleCalendarProposalReaderFactory &
    RequestScopedGoogleCalendarConditionalGatewayFactory;

export interface RequestScopedCoreCalendarProposalAdapterDependencies {
  readonly createProposalAuthorityResolver: (input: {
    readonly pool: DatabasePool;
    readonly principal: DurableRepositoryPrincipal;
  }) => TrustedProviderProposalAuthorityResolver;
  readonly createDisclosureGrantResolver: (input: {
    readonly pool: DatabasePool;
    readonly principal: DurableRepositoryPrincipal;
    readonly runId: string;
    readonly householdId: string;
    readonly userId: string;
    readonly spaceAccessGrantId: string;
  }) => TrustedDisclosureGrantResolver;
  readonly createProposalRepository: (input: {
    readonly readPool: DatabasePool;
    readonly workflowPool: DatabasePool;
    readonly principal: DurableRepositoryPrincipal;
  }) => ProposalRepository;
  readonly createProposalService: (input: {
    readonly materializer: TrustedProposalMaterializer;
    readonly disclosureGrantResolver: TrustedDisclosureGrantResolver;
    readonly repository: ProposalRepository;
  }) => CoreProposalService;
  readonly createProposalId: () => string;
  readonly now: () => Date;
}

const defaultDependencies: RequestScopedCoreCalendarProposalAdapterDependencies =
  Object.freeze({
    createProposalAuthorityResolver: ({
      pool,
      principal,
    }: {
      readonly pool: DatabasePool;
      readonly principal: DurableRepositoryPrincipal;
    }) =>
      createPostgresGoogleCalendarProposalAuthorityResolver({
        resolver: new PostgresGoogleCalendarProposalAuthorityResolver(
          pool,
          principal,
        ),
      }),
    createDisclosureGrantResolver: ({
      pool,
      principal,
      runId,
      householdId,
      userId,
      spaceAccessGrantId,
    }: {
      readonly pool: DatabasePool;
      readonly principal: DurableRepositoryPrincipal;
      readonly runId: string;
      readonly householdId: string;
      readonly userId: string;
      readonly spaceAccessGrantId: string;
    }) =>
      new PostgresSchedulerDisclosureGrantResolver(pool, principal, {
        runId,
        householdId,
        userId,
        spaceAccessGrantId,
        agentId: 'scheduler',
        phasePurpose: 'specialist-execution',
        provider: 'openai',
      }),
    createProposalRepository: ({
      readPool,
      workflowPool,
      principal,
    }: {
      readonly readPool: DatabasePool;
      readonly workflowPool: DatabasePool;
      readonly principal: DurableRepositoryPrincipal;
    }) =>
      new PostgresProposalRepository({
        readPool,
        workflowPool,
        principal,
      }),
    createProposalService: ({
      materializer,
      disclosureGrantResolver,
      repository,
    }: {
      readonly materializer: TrustedProposalMaterializer;
      readonly disclosureGrantResolver: TrustedDisclosureGrantResolver;
      readonly repository: ProposalRepository;
    }) => new ProposalService(materializer, disclosureGrantResolver, repository),
    createProposalId: randomUUID,
    now: () => new Date(),
  });

const durablePrincipalFor = (
  principal: PrincipalWithPrivateSpace,
  requestId: string,
): DurableRepositoryPrincipal =>
  Object.freeze({
    userId: principal.userId,
    householdId: principal.householdId,
    sessionId: principal.sessionId,
    requestId,
  });

const sameAuthorityBinding = (left: unknown, right: unknown): boolean => {
  const parsedLeft = ProviderWriteAuthorityBindingSchema.safeParse(left);
  const parsedRight = ProviderWriteAuthorityBindingSchema.safeParse(right);
  return (
    parsedLeft.success &&
    parsedRight.success &&
    hashCanonicalJson(parsedLeft.data) === hashCanonicalJson(parsedRight.data)
  );
};

const proposalExpiry = (now: Date, grantExpiresAt: string): string => {
  const nowMs = now.getTime();
  const grantExpiryMs = Date.parse(grantExpiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(grantExpiryMs)) {
    throw new Error('api-core-calendar-proposal-time-invalid');
  }
  const expiresAtMs = Math.min(nowMs + PROPOSAL_LIFETIME_MS, grantExpiryMs);
  if (expiresAtMs <= nowMs) {
    throw new Error('api-core-calendar-proposal-disclosure-expired');
  }
  return new Date(expiresAtMs).toISOString();
};

const createPresenter = (): TrustedProviderWriteDecisionPresenter =>
  Object.freeze({
    present: async (
      rawInput: Parameters<TrustedProviderWriteDecisionPresenter['present']>[0],
    ) => {
      const proposal = ActionProposalSchema.parse(rawInput.proposal);
      const decision = ActionDecisionSchema.parse(rawInput.visualDecision);
      const expectedDecision =
        rawInput.decision === 'approve' ? 'approved' : 'rejected';
      if (
        proposal.capabilityId !== 'google-calendar.event.create' ||
        decision.proposalId !== proposal.id ||
        decision.decision !== expectedDecision ||
        decision.payloadHash !== proposal.payloadHash ||
        decision.approvalHash !== proposal.approvalHash
      ) {
        throw new Error('api-core-calendar-proposal-presentation-invalid');
      }
      return JsonValueSchema.parse({
        summary:
          rawInput.decision === 'approve'
            ? `Calendar event proposal ${proposal.id} was approved and executed.`
            : `Calendar event proposal ${proposal.id} was rejected.`,
        clarificationQuestion: null,
        evidenceReferences: [],
        derivedValueReferences: [],
        actionProposalReferences: [proposal.id],
      });
    },
  });

/**
 * Request-scoped preparation for the exact Calendar-create proposal path.
 * It owns only server-minted proposal material and the post-decision internal
 * presentation; authentication, provider reads, durable storage, and model
 * execution remain on their already-established boundaries.
 */
export const createRequestScopedCoreCalendarProposalAdapter = (
  rawInput: Readonly<{
    readonly principal: unknown;
    readonly requestId: unknown;
    readonly runId: unknown;
    readonly readPool: DatabasePool;
    readonly workflowPool: DatabasePool;
    readonly google: RequestScopedGoogleCalendarProposalReaderFactory;
  }>,
  dependencies: RequestScopedCoreCalendarProposalAdapterDependencies = defaultDependencies,
): Readonly<{
  readonly materializeProposal: MaterializeProposal;
  readonly presenter: TrustedProviderWriteDecisionPresenter;
}> => {
  const principal = PrincipalWithPrivateSpaceSchema.safeParse(rawInput.principal);
  const requestId = UuidSchema.safeParse(rawInput.requestId);
  const runId = UuidSchema.safeParse(rawInput.runId);
  if (
    !principal.success ||
    !requestId.success ||
    !runId.success ||
    typeof rawInput.readPool?.connect !== 'function' ||
    typeof rawInput.workflowPool?.connect !== 'function' ||
    typeof rawInput.google?.createProposalTargetReader !== 'function' ||
    typeof dependencies.createProposalAuthorityResolver !== 'function' ||
    typeof dependencies.createDisclosureGrantResolver !== 'function' ||
    typeof dependencies.createProposalRepository !== 'function' ||
    typeof dependencies.createProposalService !== 'function' ||
    typeof dependencies.createProposalId !== 'function' ||
    typeof dependencies.now !== 'function'
  ) {
    throw new Error('api-core-calendar-proposal-adapter-unavailable');
  }

  const fixedPrincipal = principal.data;
  const fixedRequestId = requestId.data;
  const fixedRunId = runId.data;
  const durablePrincipal = durablePrincipalFor(fixedPrincipal, fixedRequestId);
  const authorityResolver = dependencies.createProposalAuthorityResolver({
    pool: rawInput.readPool,
    principal: durablePrincipal,
  });
  const disclosureGrantResolver = dependencies.createDisclosureGrantResolver({
    pool: rawInput.readPool,
    principal: durablePrincipal,
    runId: fixedRunId,
    householdId: fixedPrincipal.householdId,
    userId: fixedPrincipal.userId,
    spaceAccessGrantId: fixedPrincipal.spaceAccessGrantId,
  });
  const repository = dependencies.createProposalRepository({
    readPool: rawInput.readPool,
    workflowPool: rawInput.workflowPool,
    principal: durablePrincipal,
  });
  if (
    typeof authorityResolver?.resolve !== 'function' ||
    typeof disclosureGrantResolver?.resolve !== 'function' ||
    typeof repository?.transaction !== 'function'
  ) {
    throw new Error('api-core-calendar-proposal-adapter-unavailable');
  }

  const materializeProposal: MaterializeProposal = async (rawMaterialization) => {
    const context = MaterializationContextSchema.parse(rawMaterialization.context);
    const argumentsValue = CalendarCanonicalArgumentsSchema.parse(
      rawMaterialization.arguments,
    );
    if (
      rawMaterialization.capabilityId !== 'google-calendar.event.create' ||
      argumentsValue.operation !== 'create' ||
      context.requestId !== fixedRequestId ||
      context.runId !== fixedRunId ||
      context.householdId !== fixedPrincipal.householdId ||
      context.userId !== fixedPrincipal.userId ||
      context.authenticatedSessionId !== fixedPrincipal.sessionId ||
      context.spaceAccessGrantId !== fixedPrincipal.spaceAccessGrantId ||
      context.authorizationScopeFingerprint !==
        fixedPrincipal.collectionAuthorizationScopeFingerprint
    ) {
      throw new Error('api-core-calendar-proposal-request-binding-invalid');
    }
    const capabilityFingerprint = hashCapabilityDescriptorBinding(
      rawMaterialization.descriptor,
    );
    const authority = await authorityResolver.resolve({
      requestId: fixedRequestId,
      runId: fixedRunId,
      householdId: fixedPrincipal.householdId,
      userId: fixedPrincipal.userId,
      authenticatedSessionId: fixedPrincipal.sessionId,
      agentId: 'scheduler',
      spaceAccessGrantId: fixedPrincipal.spaceAccessGrantId,
      authorizationScopeFingerprint:
        fixedPrincipal.collectionAuthorizationScopeFingerprint,
      disclosureGrantId: context.disclosureGrantId,
      sdkCallId: context.sdkCallId,
      capabilityId: rawMaterialization.capabilityId,
      capabilityFingerprint,
    });
    if (
      authority === undefined ||
      !sameAuthorityBinding(
        authority.authorityBinding,
        rawMaterialization.authorityBinding,
      )
    ) {
      throw new Error('api-core-calendar-proposal-authority-invalid');
    }
    const calendarRuntime = createRequestScopedGoogleCalendarCoreRuntime({
      principal: fixedPrincipal,
      requestId: fixedRequestId,
      authorityResolution: authority,
      google: rawInput.google,
    });
    const materializer = new ScopedCalendarProposalMaterializer(
      calendarRuntime.proposalStateReader,
      authority.authorityBinding,
    );
    const disclosureGrant = await disclosureGrantResolver.resolve(
      context.disclosureGrantId,
    );
    if (disclosureGrant === undefined) {
      throw new Error('api-core-calendar-proposal-disclosure-invalid');
    }
    const now = new Date(dependencies.now());
    if (
      !Number.isFinite(now.getTime()) ||
      now.getTime() < Date.parse(disclosureGrant.createdAt)
    ) {
      throw new Error('api-core-calendar-proposal-time-invalid');
    }
    const material = await materializer.materialize({
      capabilityId: rawMaterialization.capabilityId,
      capabilityFingerprint,
      canonicalArguments: argumentsValue,
      disclosureGrant,
      now,
    });
    const id = UuidSchema.parse(dependencies.createProposalId());
    const createdAt = now.toISOString();
    const idempotencyKey = hashCanonicalJson({
      domain: 'emdo.core-calendar-proposal.v1',
      runId: fixedRunId,
      sdkCallId: context.sdkCallId,
      capabilityId: rawMaterialization.capabilityId,
      capabilityFingerprint,
      authorizationScopeFingerprint:
        fixedPrincipal.collectionAuthorizationScopeFingerprint,
      disclosureGrantId: disclosureGrant.id,
      authorityBinding: authority.authorityBinding,
      canonicalArguments: argumentsValue,
    });
    const proposalBase = {
      schemaVersion: 1 as const,
      id,
      version: 1,
      runId: fixedRunId,
      capabilityId: rawMaterialization.capabilityId,
      capabilityFingerprint,
      authorizationScopeFingerprint:
        fixedPrincipal.collectionAuthorizationScopeFingerprint,
      canonicalArguments: argumentsValue,
      ...material,
      providerSdkCallId: context.sdkCallId,
      payloadHash: hashCanonicalJson(argumentsValue),
      disclosureGrant,
      createdAt,
      expiresAt: proposalExpiry(now, disclosureGrant.expiresAt),
      idempotencyKey,
      state: 'pending' as const,
    };
    const proposal = ActionProposalSchema.parse({
      ...proposalBase,
      approvalHash: hashActionProposalApproval(proposalBase),
    });
    const preparation: ProposalPreparationBinding = {
      proposalId: proposal.id,
      originRequestId: fixedRequestId,
      runId: fixedRunId,
      householdId: fixedPrincipal.householdId,
      userId: fixedPrincipal.userId,
      originSessionId: fixedPrincipal.sessionId,
      agentId: 'scheduler',
      originSpaceAccessGrantId: fixedPrincipal.spaceAccessGrantId,
      disclosureGrantId: disclosureGrant.id,
      disclosurePolicyVersion: context.disclosureGrantVersion,
      capabilityId: proposal.capabilityId,
      sdkCallId: context.sdkCallId,
      providerAuthorityBindingHash: material.providerAuthorityBindingHash,
    };
    const proposalService = dependencies.createProposalService({
      materializer,
      disclosureGrantResolver,
      repository,
    });
    if (typeof proposalService?.create !== 'function') {
      throw new Error('api-core-calendar-proposal-adapter-unavailable');
    }
    const persisted = ActionProposalSchema.parse(
      await proposalService.create(proposal, preparation),
    );
    if (
      persisted.id !== proposal.id ||
      persisted.runId !== proposal.runId ||
      persisted.capabilityId !== proposal.capabilityId ||
      persisted.capabilityFingerprint !== proposal.capabilityFingerprint ||
      persisted.authorizationScopeFingerprint !==
        proposal.authorizationScopeFingerprint ||
      persisted.payloadHash !== proposal.payloadHash ||
      persisted.approvalHash !== proposal.approvalHash ||
      persisted.providerAuthorityBindingHash !==
        proposal.providerAuthorityBindingHash ||
      persisted.providerSdkCallId !== proposal.providerSdkCallId ||
      persisted.disclosureGrant.id !== proposal.disclosureGrant.id
    ) {
      throw new Error('api-core-calendar-proposal-persistence-invalid');
    }
    return deepFreeze({ sdkCallId: context.sdkCallId, proposal: persisted });
  };

  return Object.freeze({
    materializeProposal,
    presenter: createPresenter(),
  });
};

export interface RequestScopedCoreAgentRuntimeFactory {
  readonly scope: Readonly<{
    readonly principal: PrincipalWithPrivateSpace;
    readonly requestId: string;
    readonly runId: string;
    readonly conversationId: string;
  }>;
  readonly runtime: CoreProductionAgentRuntime;
  /**
   * Checks only globally configured dependencies. Request authority, provider
   * authority, and provider state remain operation-time checks.
   */
  check(): Promise<boolean>;
}

const noOpTraceSink: LocalTraceSink = Object.freeze({
  append: async () => undefined,
});

/*
 * Manager delegation is declarative: AgentOrchestrator validates the manager
 * plan and dispatches the selected specialist itself. The SDK-facing executor
 * therefore rejects any direct invocation instead of presenting a second
 * delegation transport or an accidental capability backdoor.
 */
const denyDirectSchedulerDelegation = async (): Promise<never> => {
  throw new Error('api-core-scheduler-delegation-direct-invocation-denied');
};

const validCheckpointCipher = (
  value: unknown,
): value is ApprovalCheckpointCipher => {
  if (value === null || typeof value !== 'object') return false;
  const cipher = value as Partial<ApprovalCheckpointCipher>;
  return (
    cipher.security?.atRest === 'authenticated-encryption' &&
    cipher.security.algorithm === 'AES-256-GCM' &&
    cipher.security.keyRotation === 'versioned-keyring' &&
    typeof cipher.seal === 'function' &&
    typeof cipher.open === 'function'
  );
};

/**
 * Composes the narrow manager+scheduler runtime for one authenticated request.
 * It constructs no provider clients or calls; all Calendar and OpenAI checks
 * remain deferred to their existing operation/readiness boundaries.
 */
export const createRequestScopedCoreAgentRuntimeFactory = (rawInput: Readonly<{
  readonly principal: unknown;
  readonly requestId: unknown;
  readonly runId: unknown;
  readonly conversationId: unknown;
  readonly readPool: DatabasePool;
  readonly workflowPool: DatabasePool;
  readonly google: RequestScopedGoogleCalendarCoreFactory;
  readonly openAi: ProductionOpenAiAgentServiceBundle;
  readonly checkpointCipher: ApprovalCheckpointCipher;
  readonly checkGlobalDependencies: () => Promise<boolean>;
}>): RequestScopedCoreAgentRuntimeFactory | undefined => {
  const principal = PrincipalWithPrivateSpaceSchema.safeParse(rawInput.principal);
  const requestId = UuidSchema.safeParse(rawInput.requestId);
  const runId = UuidSchema.safeParse(rawInput.runId);
  const conversationId = UuidSchema.safeParse(rawInput.conversationId);
  if (
    !principal.success ||
    !requestId.success ||
    !runId.success ||
    !conversationId.success ||
    rawInput.readPool === rawInput.workflowPool ||
    typeof rawInput.readPool?.connect !== 'function' ||
    typeof rawInput.workflowPool?.connect !== 'function' ||
    typeof rawInput.google?.createProposalTargetReader !== 'function' ||
    typeof rawInput.google?.createConditionalGateway !== 'function' ||
    typeof rawInput.openAi?.modelAvailability?.isAvailable !== 'function' ||
    typeof rawInput.openAi.costCalculator?.calculateCadMinor !== 'function' ||
    typeof rawInput.openAi.runner?.run !== 'function' ||
    typeof rawInput.openAi.close !== 'function' ||
    !validCheckpointCipher(rawInput.checkpointCipher) ||
    typeof rawInput.checkGlobalDependencies !== 'function'
  ) {
    return undefined;
  }

  try {
    const fixedPrincipal = deepFreeze(principal.data);
    const fixedRequestId = requestId.data;
    const fixedRunId = runId.data;
    const durablePrincipal = durablePrincipalFor(fixedPrincipal, fixedRequestId);
    const proposalRepository = new PostgresProposalRepository({
      readPool: rawInput.readPool,
      workflowPool: rawInput.workflowPool,
      principal: durablePrincipal,
    });
    const disclosureGrantResolver = new PostgresSchedulerDisclosureGrantResolver(
      rawInput.readPool,
      durablePrincipal,
      {
        runId: fixedRunId,
        householdId: fixedPrincipal.householdId,
        userId: fixedPrincipal.userId,
        spaceAccessGrantId: fixedPrincipal.spaceAccessGrantId,
        agentId: 'scheduler',
        phasePurpose: 'specialist-execution',
        provider: 'openai',
      },
    );
    const proposalAuthorityResolver =
      createPostgresGoogleCalendarProposalAuthorityResolver({
        resolver: new PostgresGoogleCalendarProposalAuthorityResolver(
          rawInput.readPool,
          durablePrincipal,
        ),
      });
    const calendarProposals = createRequestScopedCoreCalendarProposalAdapter(
      {
        principal: fixedPrincipal,
        requestId: fixedRequestId,
        runId: fixedRunId,
        readPool: rawInput.readPool,
        workflowPool: rawInput.workflowPool,
        google: rawInput.google,
      },
      {
        createProposalAuthorityResolver: () => proposalAuthorityResolver,
        createDisclosureGrantResolver: () => disclosureGrantResolver,
        createProposalRepository: () => proposalRepository,
        createProposalService: ({
          materializer,
          disclosureGrantResolver: resolver,
          repository,
        }) => new ProposalService(materializer, resolver, repository),
        createProposalId: randomUUID,
        now: () => new Date(),
      },
    );
    const proposalLifecycle = createProposalLifecycleService({
      repository: proposalRepository,
      disclosureGrantResolver,
    });
    const proposals = createProductionProviderProposalComposition({
      proposalService: proposalLifecycle,
      lookup: proposalRepository,
      presenter: calendarProposals.presenter,
      authenticatedSessionId: fixedPrincipal.sessionId,
    });
    const calendarEventCreate =
      createRequestScopedGoogleCalendarEventCreateBinding({
        principal: fixedPrincipal,
        pool: rawInput.readPool,
        google: rawInput.google,
        materializeProposal: calendarProposals.materializeProposal,
      });
    const memoryRepository = new PostgresAgentMemoryRepository(
      rawInput.readPool,
      durablePrincipal,
    );
    const memory = createPostgresManagerConversationMemory({
      repository: {
        listConversation: async (conversationId) =>
          (await memoryRepository.listConversation(conversationId)).map(
            (event) => ({
              ...event,
              payload: JsonValueSchema.parse(event.payload),
            }),
          ),
        appendConversationEvent: async (input) => {
          const event = await memoryRepository.appendConversationEvent(input);
          return {
            ...event,
            payload: JsonValueSchema.parse(event.payload),
          };
        },
      },
      principal: {
        householdId: fixedPrincipal.householdId,
        userId: fixedPrincipal.userId,
      },
      privateSpaceId: fixedPrincipal.privateSpaceId,
    });
    const approvalCheckpoints = new ApprovalCheckpointService(
      new PostgresApprovalCheckpointRepository(
        rawInput.readPool,
        durablePrincipal,
      ),
      rawInput.checkpointCipher,
    );
    const modelDisclosureGateway = new PostgresModelDisclosureGateway(
      rawInput.readPool,
      durablePrincipal,
      new CanonicalRecordEnvelopeDisclosureFilter(),
    );
    const disclosureGateway = createPostgresCoreModelDisclosureGateway({
      issuer: new PostgresDataDisclosureGrantIssuer(
        rawInput.readPool,
        durablePrincipal,
      ),
      gateway: {
        authorize: async (input) =>
          modelDisclosureGateway.authorize({
            ...input,
            requestedDataClasses: [...input.requestedDataClasses],
          }),
      },
      privateSpaceId: fixedPrincipal.privateSpaceId,
    });
    const runtime = createCoreProductionAgentRuntime({
      capabilityServices: {
        schedulerDelegation: denyDirectSchedulerDelegation,
        calendarEventCreate,
      },
      proposals,
      trustedProviderWriteAuthorityResolver:
        new PostgresGoogleCalendarProviderAuthorityResolver(
          rawInput.readPool,
          durablePrincipal,
        ),
      trustedProviderProposalAuthorityResolver: proposalAuthorityResolver,
      modelAvailability: rawInput.openAi.modelAvailability,
      memory,
      traceSink: noOpTraceSink,
      approvalCheckpoints,
      disclosureGateway,
      costCalculator: rawInput.openAi.costCalculator,
      spendGuard: createRequestScopedModelSpendGuard({
        pool: rawInput.readPool,
        principal: durablePrincipal,
        runId: fixedRunId,
      }),
      executionRunner: rawInput.openAi.runner,
    });
    const check = async (): Promise<boolean> => {
      try {
        const global = await rawInput.checkGlobalDependencies();
        if (global !== true) return false;
        const [luna, terra] = await Promise.all([
          rawInput.openAi.modelAvailability.isAvailable('gpt-5.6-luna'),
          rawInput.openAi.modelAvailability.isAvailable('gpt-5.6-terra'),
        ]);
        return luna === true && terra === true;
      } catch {
        return false;
      }
    };
    return Object.freeze({
      scope: Object.freeze({
        principal: fixedPrincipal,
        requestId: fixedRequestId,
        runId: fixedRunId,
        conversationId: conversationId.data,
      }),
      runtime,
      check,
    });
  } catch {
    return undefined;
  }
};

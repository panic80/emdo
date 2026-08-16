import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolConstructorCalls = vi.hoisted(() => ({
  proposal: [] as unknown[],
  calendarBinding: [] as unknown[],
  memory: [] as unknown[],
  checkpoints: [] as unknown[],
  disclosureIssuer: [] as unknown[],
  modelDisclosure: [] as unknown[],
  spendGuard: [] as unknown[],
}));

vi.mock('@emdo/db/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@emdo/db/api')>();
  return {
    ...actual,
    PostgresProposalRepository: class {
      constructor(input: unknown) {
        poolConstructorCalls.proposal.push(input);
      }

      async transaction() {
        return undefined;
      }

      async resolvePreparedBySdkBinding() {
        return undefined;
      }

      async resolveDecisionById() {
        return undefined;
      }

      async resolveProviderWriteCompletionByDecisionId() {
        return undefined;
      }
    },
    PostgresSchedulerDisclosureGrantResolver: class {
      async resolve() {
        return undefined;
      }
    },
    PostgresGoogleCalendarProposalAuthorityResolver: class {
      async resolve() {
        return undefined;
      }
    },
    PostgresGoogleCalendarProviderAuthorityResolver: class {
      async resolve() {
        return undefined;
      }
    },
    PostgresAgentMemoryRepository: class {
      constructor(pool: unknown, principal: unknown) {
        poolConstructorCalls.memory.push({ pool, principal });
      }

      async listConversation() {
        return [];
      }

      async appendConversationEvent() {
        return undefined;
      }
    },
    PostgresApprovalCheckpointRepository: class {
      constructor(pool: unknown, principal: unknown) {
        poolConstructorCalls.checkpoints.push({ pool, principal });
      }

      async create() {
        return 'already-exists' as const;
      }

      async get() {
        return undefined;
      }

      async consume() {
        return { status: 'not-found' as const };
      }

      async cancel() {
        return 'not-found' as const;
      }
    },
    PostgresDataDisclosureGrantIssuer: class {
      constructor(pool: unknown, principal: unknown) {
        poolConstructorCalls.disclosureIssuer.push({ pool, principal });
      }

      async issue() {
        throw new Error('test-disclosure-issuer-must-not-run');
      }
    },
    PostgresModelDisclosureGateway: class {
      constructor(pool: unknown, principal: unknown) {
        poolConstructorCalls.modelDisclosure.push({ pool, principal });
      }

      async authorize() {
        throw new Error('test-model-disclosure-must-not-run');
      }
    },
  };
});

vi.mock('./core-agent-composition.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('./core-agent-composition.js')
  >();
  return {
    ...actual,
    createRequestScopedGoogleCalendarEventCreateBinding: (input: unknown) => {
      poolConstructorCalls.calendarBinding.push(input);
      return {
        materializeProposal: async () => {
          throw new Error('test-calendar-materialization-must-not-run');
        },
        executeProviderWrite: async () => ({
          application: 'not-applied' as const,
          reason: 'approval-policy-mismatch' as const,
          evidence: { calendarWrite: 'test-only' },
        }),
        providerWriteSafety: {
          atomicConditions: 'provider-native-single-request' as const,
          idempotency: 'provider-key' as const,
          retryOwnership: 'adapter-bounded-within-invocation' as const,
          reconciliation: 'required' as const,
        },
      };
    },
  };
});

vi.mock('./core-openai-services.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./core-openai-services.js')>();
  return {
    ...actual,
    createRequestScopedModelSpendGuard: (input: unknown) => {
      poolConstructorCalls.spendGuard.push(input);
      return {
        reserve: async () => ({ status: 'denied' as const }),
        markDispatched: async () => ({ status: 'not-found' as const }),
        settle: async () => ({ status: 'not-found' as const }),
        release: async () => ({ status: 'not-found' as const }),
      };
    },
  };
});

import {
  DataDisclosureGrantSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
} from '@emdo/contracts';
import { hashCanonicalJson } from '@emdo/toolbox';

import { parseProductionProviderWriteCapabilityId } from '../agents/capability-runtime.js';
import type { ProductionOpenAiAgentServiceBundle } from './core-openai-services.js';
import {
  createRequestScopedCoreAgentRuntimeFactory,
  createRequestScopedCoreCalendarProposalAdapter,
} from './core-agent-services.js';

const ids = Object.freeze({
  request: '52000000-0000-4000-8000-000000000001',
  run: '52000000-0000-4000-8000-000000000002',
  household: '52000000-0000-4000-8000-000000000003',
  user: '52000000-0000-4000-8000-000000000004',
  session: '52000000-0000-4000-8000-000000000005',
  privateSpace: '52000000-0000-4000-8000-000000000006',
  spaceGrant: '52000000-0000-4000-8000-000000000007',
  disclosureGrant: '52000000-0000-4000-8000-000000000008',
  proposal: '52000000-0000-4000-8000-000000000009',
  conversation: '52000000-0000-4000-8000-000000000010',
});

const authorizationScopeFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse('a'.repeat(64));
const capabilityId = parseProductionProviderWriteCapabilityId(
  'google-calendar.event.create',
);
const canonicalArguments = Object.freeze({
  operation: 'create' as const,
  calendarId: 'primary',
  expectedCalendarVersion: 'calendar-v1',
  event: {
    eventId: 'event-a1',
    summary: 'Dentist appointment',
    start: '2026-08-15T15:00:00.000Z',
    end: '2026-08-15T16:00:00.000Z',
    timeZone: 'America/Toronto' as const,
  },
});
const principal = Object.freeze({
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  privateSpaceId: ids.privateSpace,
  role: 'owner' as const,
  emailVerified: true as const,
  spaceAccessGrantId: ids.spaceGrant,
  collectionAuthorizationScopeFingerprint: authorizationScopeFingerprint,
});
const authorityBinding = Object.freeze({
  kind: 'google-calendar-grant-v2' as const,
  householdId: ids.household,
  privateSpaceId: ids.privateSpace,
  authorizationScopeFingerprint,
  providerGrantReference: 'calendar-grant-reference',
  authorizationEpoch: 1,
});
const disclosureGrant = DataDisclosureGrantSchema.parse({
  schemaVersion: 1,
  id: ids.disclosureGrant,
  version: 1,
  userId: ids.user,
  householdId: ids.household,
  agentId: 'scheduler',
  purpose: 'Run one scheduler delegation.',
  runId: ids.run,
  recordAllowlist: [
    {
      dataClass: 'agent.delegations',
      recordId: 'scheduler-delegation-1',
      fields: ['delegation'],
    },
  ],
  provider: 'openai',
  createdAt: '2026-08-15T12:00:00.000Z',
  expiresAt: '2026-08-15T12:10:00.000Z',
  oneRunOnly: true,
});

beforeEach(() => {
  for (const calls of Object.values(poolConstructorCalls)) {
    calls.length = 0;
  }
});

describe('request-scoped core Calendar proposal adapter', () => {
  it('mints and persists one exact visual Calendar-create proposal without provider I/O at construction', async () => {
    const readPool = { connect: vi.fn() } as never;
    const workflowPool = { connect: vi.fn() } as never;
    const createProposalTargetReader = vi.fn(() => ({
      readTargetState: vi.fn(async () => ({
        calendarId: canonicalArguments.calendarId,
        queriedEventId: canonicalArguments.event.eventId,
        calendarVersion: canonicalArguments.expectedCalendarVersion,
        event: null,
      })),
    }));
    const resolveAuthority = vi.fn(async () => ({
      authorityBinding,
      operationScope: {
        requestId: ids.request,
        sessionId: ids.session,
        householdId: ids.household,
        userId: ids.user,
        spaceAccessGrantId: ids.spaceGrant,
        authorizationScopeFingerprint,
      },
    }));
    const resolveDisclosureGrant = vi.fn(async () => disclosureGrant);
    const create = vi.fn(async (proposal) => proposal);
    const createProposalService = vi.fn(() => ({ create }));
    const createProposalRepository = vi.fn(() =>
      ({ transaction: vi.fn() }) as never,
    );

    const adapter = createRequestScopedCoreCalendarProposalAdapter(
      {
        principal,
        requestId: ids.request,
        runId: ids.run,
        readPool,
        workflowPool,
        google: { createProposalTargetReader },
      },
      {
        createProposalAuthorityResolver: () => ({ resolve: resolveAuthority }),
        createDisclosureGrantResolver: () => ({
          resolve: resolveDisclosureGrant,
        }),
        createProposalRepository,
        createProposalService,
        createProposalId: () => ids.proposal,
        now: () => new Date('2026-08-15T12:05:00.000Z'),
      },
    );

    expect(createProposalTargetReader).not.toHaveBeenCalled();
    expect(resolveAuthority).not.toHaveBeenCalled();
    expect(createProposalService).not.toHaveBeenCalled();

    const materialized = await adapter.materializeProposal({
      capabilityId,
      descriptor: { id: capabilityId } as never,
      arguments: canonicalArguments,
      authorityBinding,
      context: {
        requestId: ids.request,
        runId: ids.run,
        householdId: ids.household,
        userId: ids.user,
        authenticatedSessionId: ids.session,
        spaceAccessGrantId: ids.spaceGrant,
        authorizationScopeFingerprint,
        disclosureGrantId: ids.disclosureGrant,
        sdkCallId: 'calendar-sdk-call-1',
        disclosureGrantVersion: '7.2.5',
        abortSignal: new AbortController().signal,
      } as never,
    });

    expect(createProposalTargetReader).toHaveBeenCalledOnce();
    expect(resolveAuthority).toHaveBeenCalledOnce();
    expect(resolveDisclosureGrant).toHaveBeenCalledWith(ids.disclosureGrant);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ids.proposal,
        runId: ids.run,
        capabilityId: 'google-calendar.event.create',
        canonicalArguments,
        authorizationScopeFingerprint,
        disclosureGrant,
        providerAuthorityBindingHash: hashCanonicalJson(authorityBinding),
        createdAt: '2026-08-15T12:05:00.000Z',
        expiresAt: '2026-08-15T12:10:00.000Z',
        state: 'pending',
      }),
      expect.objectContaining({
        proposalId: ids.proposal,
        originRequestId: ids.request,
        runId: ids.run,
        householdId: ids.household,
        userId: ids.user,
        originSessionId: ids.session,
        originSpaceAccessGrantId: ids.spaceGrant,
        disclosureGrantId: ids.disclosureGrant,
        disclosurePolicyVersion: '7.2.5',
        capabilityId: 'google-calendar.event.create',
        sdkCallId: 'calendar-sdk-call-1',
        providerAuthorityBindingHash: hashCanonicalJson(authorityBinding),
      }),
    );
    expect(createProposalRepository).toHaveBeenCalledWith({
      readPool,
      workflowPool,
      principal: {
        userId: ids.user,
        householdId: ids.household,
        sessionId: ids.session,
        requestId: ids.request,
      },
    });
    expect(materialized.sdkCallId).toBe('calendar-sdk-call-1');
    expect(materialized.proposal).toMatchObject({ id: ids.proposal });

    await expect(
      adapter.presenter.present({
        decision: 'approve',
        proposal: materialized.proposal,
        visualDecision: {
          schemaVersion: 1,
          id: '52000000-0000-4000-8000-000000000010',
          proposalId: ids.proposal,
          userId: ids.user,
          authenticatedSessionId: ids.session,
          payloadHash: materialized.proposal.payloadHash,
          approvalHash: materialized.proposal.approvalHash,
          decision: 'approved',
          channel: 'authenticated-visual',
          decidedAt: '2026-08-15T12:06:00.000Z',
          idempotencyKey: 'visual-decision-idempotency-000001',
        },
        capabilityOutput: { status: 'created' },
        context: {} as never,
      }),
    ).resolves.toEqual({
      summary: `Calendar event proposal ${ids.proposal} was approved and executed.`,
      clarificationQuestion: null,
      evidenceReferences: [],
      derivedValueReferences: [],
      actionProposalReferences: [ids.proposal],
    });
  });
});

describe('request-scoped core agent runtime factory', () => {
  it('constructs the exact scoped manager+scheduler graph without provider I/O', async () => {
    const readPool = { connect: vi.fn() } as never;
    const workflowPool = { connect: vi.fn() } as never;
    const createProposalTargetReader = vi.fn();
    const createConditionalGateway = vi.fn();
    const isAvailable = vi.fn(async () => true);
    const checkGlobalDependencies = vi.fn(async () => true);
    const openAi: ProductionOpenAiAgentServiceBundle = {
      modelAvailability: { isAvailable },
      costCalculator: { calculateCadMinor: () => 1 },
      runner: { run: vi.fn(async () => ({ state: {} }) as never) },
      close: vi.fn(async () => undefined),
    };

    const factory = createRequestScopedCoreAgentRuntimeFactory({
      principal,
      requestId: ids.request,
      runId: ids.run,
      conversationId: ids.conversation,
      readPool,
      workflowPool,
      google: { createProposalTargetReader, createConditionalGateway },
      openAi,
      checkpointCipher: {
        security: {
          atRest: 'authenticated-encryption',
          algorithm: 'AES-256-GCM',
          keyRotation: 'versioned-keyring',
        },
        seal: vi.fn(),
        open: vi.fn(),
      },
      checkGlobalDependencies,
    });

    expect(factory).toBeDefined();
    expect(factory?.scope).toEqual({
      principal,
      requestId: ids.request,
      runId: ids.run,
      conversationId: ids.conversation,
    });
    expect(factory?.runtime.agentIds).toEqual(['manager', 'scheduler']);
    expect(factory?.runtime.capabilityIds).toEqual([
      'agent.scheduler.delegate',
      'google-calendar.event.create',
    ]);
    expect(poolConstructorCalls.proposal).toEqual([
      {
        readPool,
        workflowPool,
        principal: {
          userId: ids.user,
          householdId: ids.household,
          sessionId: ids.session,
          requestId: ids.request,
        },
      },
    ]);
    expect(poolConstructorCalls.calendarBinding).toEqual([
      expect.objectContaining({ pool: readPool }),
    ]);
    expect(poolConstructorCalls.memory).toEqual([
      expect.objectContaining({ pool: readPool }),
    ]);
    expect(poolConstructorCalls.checkpoints).toEqual([
      expect.objectContaining({ pool: readPool }),
    ]);
    expect(poolConstructorCalls.disclosureIssuer).toEqual([
      expect.objectContaining({ pool: readPool }),
    ]);
    expect(poolConstructorCalls.modelDisclosure).toEqual([
      expect.objectContaining({ pool: readPool }),
    ]);
    expect(poolConstructorCalls.spendGuard).toEqual([
      expect.objectContaining({ pool: readPool }),
    ]);
    expect(createProposalTargetReader).not.toHaveBeenCalled();
    expect(createConditionalGateway).not.toHaveBeenCalled();
    expect(isAvailable).not.toHaveBeenCalled();

    await expect(factory?.check()).resolves.toBe(true);
    expect(checkGlobalDependencies).toHaveBeenCalledOnce();
    expect(isAvailable).toHaveBeenNthCalledWith(1, 'gpt-5.6-luna');
    expect(isAvailable).toHaveBeenNthCalledWith(2, 'gpt-5.6-terra');
  });

  it('fails closed for incomplete dependencies or a shared read/workflow pool', () => {
    const pool = { connect: vi.fn() } as never;
    const complete = {
      principal,
      requestId: ids.request,
      runId: ids.run,
      conversationId: ids.conversation,
      readPool: pool,
      workflowPool: pool,
      google: {
        createProposalTargetReader: vi.fn(),
        createConditionalGateway: vi.fn(),
      },
      openAi: {
        modelAvailability: { isAvailable: vi.fn(async () => true) },
        costCalculator: { calculateCadMinor: () => 1 },
        runner: { run: vi.fn(async () => ({ state: {} }) as never) },
        close: vi.fn(async () => undefined),
      } satisfies ProductionOpenAiAgentServiceBundle,
      checkpointCipher: {
        security: {
          atRest: 'authenticated-encryption' as const,
          algorithm: 'AES-256-GCM' as const,
          keyRotation: 'versioned-keyring' as const,
        },
        seal: vi.fn(),
        open: vi.fn(),
      },
      checkGlobalDependencies: async () => true,
    };

    expect(createRequestScopedCoreAgentRuntimeFactory(complete)).toBeUndefined();
    expect(
      createRequestScopedCoreAgentRuntimeFactory({
        ...complete,
        workflowPool: { connect: vi.fn() } as never,
        google: { createProposalTargetReader: vi.fn() },
      } as never),
    ).toBeUndefined();
  });
});

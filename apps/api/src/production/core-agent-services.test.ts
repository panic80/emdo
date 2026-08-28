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
  const actual =
    await importOriginal<typeof import('./core-agent-composition.js')>();
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
  const actual =
    await importOriginal<typeof import('./core-openai-services.js')>();
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
  CapabilityDescriptorSchema,
  DataDisclosureGrantSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
} from '@emdo/contracts';
import {
  hashCanonicalJson,
  hashCapabilityDescriptorBinding,
} from '@emdo/toolbox';

import { parseProductionProviderWriteCapabilityId } from '../agents/capability-runtime.js';
import type { ProductionOpenAiAgentServiceBundle } from './core-openai-services.js';
import { hashFinanceGuardedActionExecutionBinding } from './finance-agent-services.js';
import {
  createRequestScopedCoreAgentRuntimeFactory,
  createRequestScopedCoreCalendarProposalAdapter,
  createFinanceGuardedActionPresenter,
  createRequestScopedFinanceGuardedActionProposalAdapter,
  createRequestScopedManagerFinanceAgentRuntimeFactory,
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
  document: '52000000-0000-4000-8000-000000000011',
  otherDocument: '52000000-0000-4000-8000-000000000012',
  match: '52000000-0000-4000-8000-000000000013',
  otherMatch: '52000000-0000-4000-8000-000000000014',
});

const authorizationScopeFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse('a'.repeat(64));
const operationAuthorizationScopeFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse('b'.repeat(64));
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
    const createProposalRepository = vi.fn(
      () => ({ transaction: vi.fn() }) as never,
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

describe('request-scoped Finance guarded action proposal adapter', () => {
  const financeDisclosureGrant = DataDisclosureGrantSchema.parse({
    ...disclosureGrant,
    agentId: 'finance',
    purpose: 'Execute one Finance specialist action.',
    recordAllowlist: [
      {
        dataClass: 'finance.transactions',
        recordId: 'transaction-1',
        fields: ['ledger'],
      },
    ],
  });
  const financeWriteDescriptor = CapabilityDescriptorSchema.parse({
    schemaVersion: 1,
    id: 'finance.records.write',
    version: '1.0.0',
    capabilityKind: 'local-write',
    inputSchema: { id: 'finance.records.write.input', version: '1.0.0' },
    outputSchema: { id: 'finance.records.write.output', version: '1.0.0' },
    requiredScopes: [],
    requiredDataClasses: ['finance.transactions'],
    riskClass: 'local-write',
    timeoutMs: 15_000,
    freshness: {
      required: false,
      maxAgeMs: 60_000,
      revalidateBeforeExecution: false,
    },
    idempotency: { required: true, scope: 'actor', ttlMs: 86_400_000 },
    approval: {
      rule: 'authenticated-visual-proposal',
      expiresInSeconds: 600,
    },
    audit: {
      required: true,
      eventType: 'finance.records.write.invoked',
      redactFields: [],
    },
    executorId: 'finance.records.write.v1',
  });
  const financeImportDescriptor = CapabilityDescriptorSchema.parse({
    schemaVersion: 1,
    id: 'finance.statement.import',
    version: '1.0.0',
    capabilityKind: 'import',
    inputSchema: { id: 'finance.statement.import.input', version: '1.0.0' },
    outputSchema: { id: 'finance.statement.import.output', version: '1.0.0' },
    requiredScopes: [],
    requiredDataClasses: ['finance.transactions'],
    riskClass: 'local-write',
    timeoutMs: 15_000,
    freshness: {
      required: false,
      maxAgeMs: 60_000,
      revalidateBeforeExecution: false,
    },
    idempotency: { required: true, scope: 'actor', ttlMs: 86_400_000 },
    approval: {
      rule: 'authenticated-visual-proposal',
      expiresInSeconds: 600,
    },
    audit: {
      required: true,
      eventType: 'finance.statement.import.invoked',
      redactFields: [],
    },
    executorId: 'finance.statement.import.v1',
  });

  const materializeFinancePresentationProposal = async (input: {
    readonly capabilityId: 'finance.records.write' | 'finance.statement.import';
    readonly descriptor: unknown;
    readonly arguments: unknown;
    readonly operation: string;
    readonly target?: Readonly<{
      readonly targetBindingHash: string;
      readonly preview: Readonly<{
        readonly documentId: string;
        readonly beforeState: string;
        readonly afterState: string;
        readonly extractionRevision: number | null;
        readonly matchId?: string;
      }>;
    }>;
  }) => {
    const adapter = createRequestScopedFinanceGuardedActionProposalAdapter(
      {
        principal,
        requestId: ids.request,
        runId: ids.run,
        authorizationScopeFingerprint: operationAuthorizationScopeFingerprint,
        readPool: { connect: vi.fn() } as never,
        workflowPool: { connect: vi.fn() } as never,
        ...(input.target === undefined
          ? {}
          : {
              guardedDocumentActions: {
                materializeTarget: async () => input.target!,
                executeApproved: async () => {
                  throw new Error('test-document-execution-must-not-run');
                },
              },
            }),
      },
      {
        createDisclosureGrantResolver: () => ({
          resolve: vi.fn(async () => financeDisclosureGrant),
        }),
        createProposalRepository: () => ({ transaction: vi.fn() }) as never,
        createProposalService: () => ({
          create: async (proposal) => proposal,
        }),
        createProposalId: () => ids.proposal,
        now: () => new Date('2026-08-15T12:05:00.000Z'),
      },
    );
    const materialized = await adapter.materializeProposal({
      capabilityId: input.capabilityId,
      descriptor: input.descriptor as never,
      arguments: input.arguments,
      operation: input.operation,
      context: {
        requestId: ids.request,
        runId: ids.run,
        householdId: ids.household,
        userId: ids.user,
        authenticatedSessionId: ids.session,
        spaceAccessGrantId: ids.spaceGrant,
        authorizationScopeFingerprint: operationAuthorizationScopeFingerprint,
        disclosureGrantId: ids.disclosureGrant,
        disclosureGrantVersion: '7.2.5',
        sdkCallId: `finance-presentation-${input.operation}`,
        agentId: 'finance',
        abortSignal: new AbortController().signal,
      },
    });
    if (materialized === undefined) {
      throw new Error('test-finance-presentation-materialization-missing');
    }
    return materialized.proposal;
  };

  const approvedFinanceDecision = (proposal: {
    readonly id: string;
    readonly payloadHash: string;
    readonly approvalHash: string;
  }) => ({
    schemaVersion: 1 as const,
    id: ids.conversation,
    proposalId: proposal.id,
    userId: ids.user,
    authenticatedSessionId: ids.session,
    payloadHash: proposal.payloadHash,
    approvalHash: proposal.approvalHash,
    decision: 'approved' as const,
    channel: 'authenticated-visual' as const,
    decidedAt: '2026-08-15T12:06:00.000Z',
    idempotencyKey: 'finance-presentation-approval-000001',
  });

  const presentApprovedFinanceProposal = (
    proposal: {
      readonly id: string;
      readonly payloadHash: string;
      readonly approvalHash: string;
    },
    capabilityOutput: unknown,
  ) =>
    createFinanceGuardedActionPresenter().present({
      decision: 'approve',
      proposal: proposal as never,
      visualDecision: approvedFinanceDecision(proposal),
      capabilityOutput: capabilityOutput as never,
      context: {} as never,
    });

  it('persists one Finance-local approval proposal and binds it to the exact action and disclosure scope', async () => {
    const readPool = { connect: vi.fn() } as never;
    const workflowPool = { connect: vi.fn() } as never;
    const resolve = vi.fn(async () => financeDisclosureGrant);
    const create = vi.fn(async (proposal) => proposal);
    const createProposalService = vi.fn(() => ({ create }));
    const createProposalRepository = vi.fn(
      () => ({ transaction: vi.fn() }) as never,
    );
    const adapter = createRequestScopedFinanceGuardedActionProposalAdapter(
      {
        principal,
        requestId: ids.request,
        runId: ids.run,
        authorizationScopeFingerprint: operationAuthorizationScopeFingerprint,
        readPool,
        workflowPool,
      },
      {
        createDisclosureGrantResolver: () => ({ resolve }),
        createProposalRepository,
        createProposalService,
        createProposalId: () => ids.proposal,
        now: () => new Date('2026-08-15T12:05:00.000Z'),
      },
    );
    const argumentsValue = {
      schemaVersion: 1 as const,
      mutation: {
        kind: 'adjust' as const,
        transactionId: 'transaction-1',
        amountCadMinor: 50,
        reason: 'Correct the receipt total.',
      },
    };
    const capabilityFingerprint = hashCapabilityDescriptorBinding(
      financeWriteDescriptor,
    );
    const actionHash = hashCanonicalJson(argumentsValue);
    const executionBindingHash = hashFinanceGuardedActionExecutionBinding({
      proposalId: ids.proposal,
      scope: {
        runId: ids.run,
        householdId: ids.household,
        userId: ids.user,
        sessionId: ids.session,
        privateSpaceId: ids.privateSpace,
        collectionAuthorizationScopeFingerprint: authorizationScopeFingerprint,
        disclosureGrantId: ids.disclosureGrant,
      },
      capabilityId: 'finance.records.write',
      capabilityVersion: '1.0.0',
      capabilityFingerprint,
      operation: 'finance-adjustment',
      actionHash,
    });

    const materialized = await adapter.materializeProposal({
      capabilityId: 'finance.records.write',
      descriptor: financeWriteDescriptor,
      arguments: argumentsValue,
      operation: 'finance-adjustment',
      context: {
        requestId: ids.request,
        runId: ids.run,
        householdId: ids.household,
        userId: ids.user,
        authenticatedSessionId: ids.session,
        spaceAccessGrantId: ids.spaceGrant,
        authorizationScopeFingerprint: operationAuthorizationScopeFingerprint,
        disclosureGrantId: ids.disclosureGrant,
        disclosureGrantVersion: '7.2.5',
        sdkCallId: 'finance-sdk-call-1',
        agentId: 'finance',
        abortSignal: new AbortController().signal,
      },
    });
    if (materialized === undefined) {
      throw new Error('test-finance-materialization-missing');
    }

    expect(resolve).toHaveBeenCalledWith(ids.disclosureGrant);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ids.proposal,
        runId: ids.run,
        capabilityId: 'finance.records.write',
        canonicalArguments: argumentsValue,
        authorizationScopeFingerprint: operationAuthorizationScopeFingerprint,
        disclosureGrant: financeDisclosureGrant,
        providerAuthorityBindingHash: executionBindingHash,
        guardedAction: expect.objectContaining({
          capabilityVersion: '1.0.0',
          operation: 'finance-adjustment',
          actionHash,
          executionBindingHash,
        }),
        idempotencyKey: hashCanonicalJson({
          domain: 'emdo.finance-guarded-action-proposal.v1',
          requestId: ids.request,
          runId: ids.run,
          sdkCallId: 'finance-sdk-call-1',
          householdId: ids.household,
          userId: ids.user,
          authenticatedSessionId: ids.session,
          spaceAccessGrantId: ids.spaceGrant,
          authorizationScopeFingerprint: operationAuthorizationScopeFingerprint,
          disclosureGrantId: ids.disclosureGrant,
          capabilityId: 'finance.records.write',
          capabilityVersion: '1.0.0',
          capabilityFingerprint,
          operation: 'finance-adjustment',
          actionHash,
        }),
        expiresAt: '2026-08-15T12:10:00.000Z',
        state: 'pending',
      }),
      expect.objectContaining({
        agentId: 'finance',
        originRequestId: ids.request,
        runId: ids.run,
        originSessionId: ids.session,
        originSpaceAccessGrantId: ids.spaceGrant,
        disclosureGrantId: ids.disclosureGrant,
        capabilityId: 'finance.records.write',
        sdkCallId: 'finance-sdk-call-1',
      }),
    );
    expect(materialized).toMatchObject({
      sdkCallId: 'finance-sdk-call-1',
      proposal: {
        id: ids.proposal,
        authorizationScopeFingerprint: operationAuthorizationScopeFingerprint,
        guardedAction: {
          operation: 'finance-adjustment',
        },
      },
    });
    expect(materialized.proposal.guardedAction).not.toHaveProperty(
      'targetBindingHash',
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
  });

  it('presents approved Finance guarded actions only when their successful output matches the canonical mutation', async () => {
    const recordOutput = (
      transactionId: string,
      outcome = 'applied',
      recordState = 'active',
    ) => ({
      schemaVersion: 1,
      result: {
        status: outcome,
        record: {
          id: transactionId,
          recordType: 'transaction',
          label: 'Corrected receipt',
          currency: 'CAD',
          amountCadMinor: -1_250,
          effectiveOn: '2026-08-15',
          status: recordState,
          revision: 2,
          updatedAt: '2026-08-15T12:06:00.000Z',
        },
      },
    });
    const documentTarget = (input: {
      readonly documentId: string;
      readonly afterState: string;
      readonly matchId?: string;
    }) => ({
      targetBindingHash: 'b'.repeat(64),
      preview: {
        documentId: input.documentId,
        beforeState: 'awaiting-review',
        afterState: input.afterState,
        extractionRevision: 1,
        ...(input.matchId === undefined ? {} : { matchId: input.matchId }),
      },
    });
    const adjustment = await materializeFinancePresentationProposal({
      capabilityId: 'finance.records.write',
      descriptor: financeWriteDescriptor,
      arguments: {
        schemaVersion: 1,
        mutation: {
          kind: 'adjust',
          transactionId: 'transaction-1',
          amountCadMinor: 50,
          reason: 'Correct the receipt total.',
        },
      },
      operation: 'finance-adjustment',
    });
    const reversal = await materializeFinancePresentationProposal({
      capabilityId: 'finance.records.write',
      descriptor: financeWriteDescriptor,
      arguments: {
        schemaVersion: 1,
        mutation: {
          kind: 'reverse',
          transactionId: 'transaction-1',
          reason: 'Reverse duplicate entry.',
        },
      },
      operation: 'finance-reversal',
    });
    const imported = await materializeFinancePresentationProposal({
      capabilityId: 'finance.statement.import',
      descriptor: financeImportDescriptor,
      arguments: {
        schemaVersion: 1,
        request: { kind: 'commit', planId: 'import-plan-1' },
      },
      operation: 'finance-statement-import-commit',
    });
    const committed = await materializeFinancePresentationProposal({
      capabilityId: 'finance.records.write',
      descriptor: financeWriteDescriptor,
      arguments: {
        schemaVersion: 1,
        mutation: { kind: 'commit-document-review', documentId: ids.document },
      },
      operation: 'finance-document-review-commit',
      target: documentTarget({
        documentId: ids.document,
        afterState: 'committed',
      }),
    });
    const acceptedMatch = await materializeFinancePresentationProposal({
      capabilityId: 'finance.records.write',
      descriptor: financeWriteDescriptor,
      arguments: {
        schemaVersion: 1,
        mutation: { kind: 'accept-document-match', matchId: ids.match },
      },
      operation: 'finance-document-match-accept',
      target: documentTarget({
        documentId: ids.document,
        afterState: 'accepted',
        matchId: ids.match,
      }),
    });
    const deleted = await materializeFinancePresentationProposal({
      capabilityId: 'finance.records.write',
      descriptor: financeWriteDescriptor,
      arguments: {
        schemaVersion: 1,
        mutation: { kind: 'delete-document', documentId: ids.document },
      },
      operation: 'finance-document-delete',
      target: documentTarget({
        documentId: ids.document,
        afterState: 'deleted',
      }),
    });
    expect(committed.guardedAction).toMatchObject({
      targetBindingHash: 'b'.repeat(64),
    });

    await expect(
      presentApprovedFinanceProposal(adjustment, recordOutput('transaction-1')),
    ).resolves.toMatchObject({
      summary: `Finance action proposal ${ids.proposal} was approved and executed.`,
    });
    await expect(
      presentApprovedFinanceProposal(
        reversal,
        recordOutput('transaction-1', 'duplicate', 'reversed'),
      ),
    ).resolves.toMatchObject({
      actionProposalReferences: [ids.proposal],
    });
    await expect(
      presentApprovedFinanceProposal(imported, {
        schemaVersion: 1,
        result: {
          status: 'replayed',
          receipt: {
            id: 'import-receipt-1',
            planId: 'import-plan-1',
            transactionCount: 2,
            verified: true,
          },
          sourceDeletionAuthorized: true,
        },
      }),
    ).resolves.toMatchObject({
      actionProposalReferences: [ids.proposal],
    });
    await expect(
      presentApprovedFinanceProposal(committed, {
        schemaVersion: 1,
        result: {
          status: 'document-committed',
          documentId: ids.document,
          extractionRevision: 1,
        },
      }),
    ).resolves.toMatchObject({
      actionProposalReferences: [ids.proposal],
    });
    await expect(
      presentApprovedFinanceProposal(acceptedMatch, {
        schemaVersion: 1,
        result: {
          status: 'match-accepted',
          documentId: ids.document,
          matchId: ids.match,
        },
      }),
    ).resolves.toMatchObject({
      actionProposalReferences: [ids.proposal],
    });
    await expect(
      presentApprovedFinanceProposal(deleted, {
        schemaVersion: 1,
        result: { status: 'document-deleted', documentId: ids.document },
      }),
    ).resolves.toMatchObject({
      actionProposalReferences: [ids.proposal],
    });
    await expect(
      presentApprovedFinanceProposal(deleted, {
        schemaVersion: 1,
        result: {
          status: 'document-purge-pending',
          documentId: ids.document,
        },
      }),
    ).resolves.toMatchObject({
      summary: `Finance action proposal ${ids.proposal} was approved. Access was revoked, but verified deletion finalization is pending and requires a retry.`,
      actionProposalReferences: [ids.proposal],
    });
  });

  it('refuses rejection, review, confirmation, and target-mismatched outputs for approved Finance guarded actions', async () => {
    const recordOutput = (input: {
      readonly outcome?: string;
      readonly recordType?: string;
      readonly recordState?: string;
    }) => ({
      schemaVersion: 1,
      result: {
        status: input.outcome ?? 'applied',
        record: {
          id: 'transaction-1',
          recordType: input.recordType ?? 'transaction',
          label: 'Corrected receipt',
          currency: 'CAD',
          amountCadMinor: -1_250,
          effectiveOn: '2026-08-15',
          status: input.recordState ?? 'active',
          revision: 2,
          updatedAt: '2026-08-15T12:06:00.000Z',
        },
      },
    });
    const documentTarget = (input: {
      readonly documentId: string;
      readonly afterState: string;
      readonly matchId?: string;
    }) => ({
      targetBindingHash: 'c'.repeat(64),
      preview: {
        documentId: input.documentId,
        beforeState: 'awaiting-review',
        afterState: input.afterState,
        extractionRevision: 1,
        ...(input.matchId === undefined ? {} : { matchId: input.matchId }),
      },
    });
    const adjustment = await materializeFinancePresentationProposal({
      capabilityId: 'finance.records.write',
      descriptor: financeWriteDescriptor,
      arguments: {
        schemaVersion: 1,
        mutation: {
          kind: 'adjust',
          transactionId: 'transaction-1',
          amountCadMinor: 50,
          reason: 'Correct the receipt total.',
        },
      },
      operation: 'finance-adjustment',
    });
    const reversal = await materializeFinancePresentationProposal({
      capabilityId: 'finance.records.write',
      descriptor: financeWriteDescriptor,
      arguments: {
        schemaVersion: 1,
        mutation: {
          kind: 'reverse',
          transactionId: 'transaction-1',
          reason: 'Reverse duplicate entry.',
        },
      },
      operation: 'finance-reversal',
    });
    const committed = await materializeFinancePresentationProposal({
      capabilityId: 'finance.records.write',
      descriptor: financeWriteDescriptor,
      arguments: {
        schemaVersion: 1,
        mutation: { kind: 'commit-document-review', documentId: ids.document },
      },
      operation: 'finance-document-review-commit',
      target: documentTarget({
        documentId: ids.document,
        afterState: 'committed',
      }),
    });
    const acceptedMatch = await materializeFinancePresentationProposal({
      capabilityId: 'finance.records.write',
      descriptor: financeWriteDescriptor,
      arguments: {
        schemaVersion: 1,
        mutation: { kind: 'accept-document-match', matchId: ids.match },
      },
      operation: 'finance-document-match-accept',
      target: documentTarget({
        documentId: ids.document,
        afterState: 'accepted',
        matchId: ids.match,
      }),
    });
    const deleted = await materializeFinancePresentationProposal({
      capabilityId: 'finance.records.write',
      descriptor: financeWriteDescriptor,
      arguments: {
        schemaVersion: 1,
        mutation: { kind: 'delete-document', documentId: ids.document },
      },
      operation: 'finance-document-delete',
      target: documentTarget({
        documentId: ids.document,
        afterState: 'deleted',
      }),
    });
    const rejected = {
      schemaVersion: 1,
      result: {
        status: 'rejected',
        record: null,
        safeError: {
          code: 'operation-rejected',
          message: 'The operation was rejected.',
          retryable: false,
        },
      },
    };
    const needsReview = {
      ...rejected,
      result: { ...rejected.result, status: 'needs-review' },
    };
    const confirmationRequired = {
      schemaVersion: 1,
      result: {
        status: 'confirmation-required',
        proposal: {
          state: 'proposed',
          operation: 'finance-adjustment',
          channel: 'emdo-authenticated-visual',
          canonicalHash: 'd'.repeat(64),
        },
      },
    };

    for (const capabilityOutput of [
      rejected,
      needsReview,
      confirmationRequired,
    ]) {
      await expect(
        presentApprovedFinanceProposal(adjustment, capabilityOutput),
      ).rejects.toThrow('api-finance-guarded-action-presentation-invalid');
    }
    for (const capabilityOutput of [
      recordOutput({ outcome: 'ignored' }),
      recordOutput({ recordType: 'budget' }),
      recordOutput({ recordState: 'reversed' }),
    ]) {
      await expect(
        presentApprovedFinanceProposal(adjustment, capabilityOutput),
      ).rejects.toThrow('api-finance-guarded-action-presentation-invalid');
    }
    await expect(
      presentApprovedFinanceProposal(reversal, recordOutput({})),
    ).rejects.toThrow('api-finance-guarded-action-presentation-invalid');
    await expect(
      presentApprovedFinanceProposal(committed, {
        schemaVersion: 1,
        result: {
          status: 'document-committed',
          documentId: ids.otherDocument,
          extractionRevision: 1,
        },
      }),
    ).rejects.toThrow('api-finance-guarded-action-presentation-invalid');
    await expect(
      presentApprovedFinanceProposal(committed, {
        schemaVersion: 1,
        result: {
          status: 'document-committed',
          documentId: ids.document,
          extractionRevision: 2,
        },
      }),
    ).rejects.toThrow('api-finance-guarded-action-presentation-invalid');
    await expect(
      presentApprovedFinanceProposal(acceptedMatch, {
        schemaVersion: 1,
        result: {
          status: 'match-accepted',
          documentId: ids.document,
          matchId: ids.otherMatch,
        },
      }),
    ).rejects.toThrow('api-finance-guarded-action-presentation-invalid');
    await expect(
      presentApprovedFinanceProposal(acceptedMatch, {
        schemaVersion: 1,
        result: {
          status: 'match-accepted',
          documentId: ids.otherDocument,
          matchId: ids.match,
        },
      }),
    ).rejects.toThrow('api-finance-guarded-action-presentation-invalid');
    await expect(
      presentApprovedFinanceProposal(deleted, {
        schemaVersion: 1,
        result: { status: 'document-deleted', documentId: ids.otherDocument },
      }),
    ).rejects.toThrow('api-finance-guarded-action-presentation-invalid');
  });

  it('fails closed before persistence when the Finance disclosure grant cannot be resolved', async () => {
    const create = vi.fn(async (proposal) => proposal);
    const adapter = createRequestScopedFinanceGuardedActionProposalAdapter(
      {
        principal,
        requestId: ids.request,
        runId: ids.run,
        authorizationScopeFingerprint: operationAuthorizationScopeFingerprint,
        readPool: { connect: vi.fn() } as never,
        workflowPool: { connect: vi.fn() } as never,
      },
      {
        createDisclosureGrantResolver: () => ({
          resolve: vi.fn(async () => undefined),
        }),
        createProposalRepository: () => ({ transaction: vi.fn() }) as never,
        createProposalService: () => ({ create }),
        createProposalId: () => ids.proposal,
        now: () => new Date('2026-08-15T12:05:00.000Z'),
      },
    );

    await expect(
      adapter.materializeProposal({
        capabilityId: 'finance.records.write',
        descriptor: financeWriteDescriptor,
        arguments: {
          schemaVersion: 1,
          mutation: {
            kind: 'reverse',
            transactionId: 'transaction-1',
            reason: 'Reverse duplicate entry.',
          },
        },
        operation: 'finance-reversal',
        context: {
          requestId: ids.request,
          runId: ids.run,
          householdId: ids.household,
          userId: ids.user,
          authenticatedSessionId: ids.session,
          spaceAccessGrantId: ids.spaceGrant,
          authorizationScopeFingerprint: operationAuthorizationScopeFingerprint,
          disclosureGrantId: ids.disclosureGrant,
          disclosureGrantVersion: '7.2.5',
          sdkCallId: 'finance-sdk-call-2',
          agentId: 'finance',
          abortSignal: new AbortController().signal,
        },
      }),
    ).rejects.toThrow('api-finance-guarded-action-disclosure-invalid');
    expect(create).not.toHaveBeenCalled();
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
      authorizationScopeFingerprint: operationAuthorizationScopeFingerprint,
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
      authorizationScopeFingerprint: operationAuthorizationScopeFingerprint,
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
    expect(isAvailable).toHaveBeenCalledOnce();
    expect(isAvailable).toHaveBeenCalledWith('gpt-5.6-terra');
  });

  it('composes a manager-only fallback without Google, and a guarded Finance graph only with workflow persistence', async () => {
    const readPool = { connect: vi.fn() } as never;
    const workflowPool = { connect: vi.fn() } as never;
    const isAvailable = vi.fn(async () => true);
    const openAi: ProductionOpenAiAgentServiceBundle = {
      modelAvailability: { isAvailable },
      costCalculator: { calculateCadMinor: () => 1 },
      runner: { run: vi.fn(async () => ({ state: {} }) as never) },
      close: vi.fn(async () => undefined),
    };
    const common = {
      principal,
      requestId: ids.request,
      runId: ids.run,
      conversationId: ids.conversation,
      authorizationScopeFingerprint: operationAuthorizationScopeFingerprint,
      readPool,
      openAi,
      checkpointCipher: {
        security: {
          atRest: 'authenticated-encryption' as const,
          algorithm: 'AES-256-GCM' as const,
          keyRotation: 'versioned-keyring' as const,
        },
        seal: vi.fn(),
        open: vi.fn(),
      },
      checkGlobalDependencies: vi.fn(async () => true),
    };
    const managerOnly =
      createRequestScopedManagerFinanceAgentRuntimeFactory(common);
    expect(managerOnly?.runtime.agentIds).toEqual(['manager']);
    expect(managerOnly?.runtime.capabilityIds).toEqual([]);

    const unavailable = async () => {
      throw new Error('test-finance-service-must-not-run');
    };
    const financeOnly = createRequestScopedManagerFinanceAgentRuntimeFactory({
      ...common,
      workflowPool,
      finance: {
        readFinanceRecords: unavailable,
        writeFinanceRecord: unavailable,
        executeStatementImport: unavailable,
        loadFinanceBudgetInputs: unavailable,
        searchFinanceDocuments: unavailable,
        readFinanceDocument: unavailable,
        readFinanceMatches: unavailable,
      },
    });
    expect(financeOnly?.runtime.agentIds).toEqual(['manager', 'finance']);
    expect(financeOnly?.runtime.capabilityIds).toEqual([
      'agent.finance.delegate',
      'finance.records.read',
      'finance.records.write',
      'finance.statement.import',
      'finance.analytics.calculate',
      'finance.documents.search',
      'finance.documents.read',
      'finance.matches.read',
    ]);
    expect(poolConstructorCalls.proposal).toEqual([
      expect.objectContaining({ readPool, workflowPool }),
    ]);
    expect(poolConstructorCalls.calendarBinding).toEqual([]);
    await expect(managerOnly?.check()).resolves.toBe(true);
    await expect(financeOnly?.check()).resolves.toBe(true);
  });

  it('treats Terra as the required ready model when Luna is unavailable', async () => {
    const readPool = { connect: vi.fn() } as never;
    const isAvailable = vi.fn(
      async (model: string) => model === 'gpt-5.6-terra',
    );
    const factory = createRequestScopedManagerFinanceAgentRuntimeFactory({
      principal,
      requestId: ids.request,
      runId: ids.run,
      conversationId: ids.conversation,
      authorizationScopeFingerprint: operationAuthorizationScopeFingerprint,
      readPool,
      openAi: {
        modelAvailability: { isAvailable },
        costCalculator: { calculateCadMinor: () => 1 },
        runner: { run: vi.fn(async () => ({ state: {} }) as never) },
        close: vi.fn(async () => undefined),
      },
      checkpointCipher: {
        security: {
          atRest: 'authenticated-encryption' as const,
          algorithm: 'AES-256-GCM' as const,
          keyRotation: 'versioned-keyring' as const,
        },
        seal: vi.fn(),
        open: vi.fn(),
      },
      checkGlobalDependencies: vi.fn(async () => true),
    });

    await expect(factory?.check()).resolves.toBe(true);
    expect(isAvailable).toHaveBeenCalledOnce();
    expect(isAvailable).toHaveBeenCalledWith('gpt-5.6-terra');
  });

  it('adds Finance to the registered Scheduler graph without exposing Shopping', () => {
    const readPool = { connect: vi.fn() } as never;
    const unavailable = async () => {
      throw new Error('test-finance-service-must-not-run');
    };
    const factory = createRequestScopedCoreAgentRuntimeFactory({
      principal,
      requestId: ids.request,
      runId: ids.run,
      conversationId: ids.conversation,
      authorizationScopeFingerprint: operationAuthorizationScopeFingerprint,
      readPool,
      workflowPool: { connect: vi.fn() } as never,
      google: {
        createProposalTargetReader: vi.fn(),
        createConditionalGateway: vi.fn(),
      },
      openAi: {
        modelAvailability: { isAvailable: vi.fn(async () => true) },
        costCalculator: { calculateCadMinor: () => 1 },
        runner: { run: vi.fn(async () => ({ state: {} }) as never) },
        close: vi.fn(async () => undefined),
      },
      checkpointCipher: {
        security: {
          atRest: 'authenticated-encryption',
          algorithm: 'AES-256-GCM',
          keyRotation: 'versioned-keyring',
        },
        seal: vi.fn(),
        open: vi.fn(),
      },
      checkGlobalDependencies: async () => true,
      finance: {
        readFinanceRecords: unavailable,
        writeFinanceRecord: unavailable,
        executeStatementImport: unavailable,
        loadFinanceBudgetInputs: unavailable,
        searchFinanceDocuments: unavailable,
        readFinanceDocument: unavailable,
        readFinanceMatches: unavailable,
      },
    });
    expect(factory?.runtime.agentIds).toEqual([
      'manager',
      'scheduler',
      'finance',
    ]);
    expect(factory?.runtime.capabilityIds).not.toContain(
      'agent.shopping.delegate',
    );
  });

  it('fails closed for incomplete dependencies or a shared read/workflow pool', () => {
    const pool = { connect: vi.fn() } as never;
    const complete = {
      principal,
      requestId: ids.request,
      runId: ids.run,
      conversationId: ids.conversation,
      authorizationScopeFingerprint: operationAuthorizationScopeFingerprint,
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

    expect(
      createRequestScopedCoreAgentRuntimeFactory(complete),
    ).toBeUndefined();
    expect(
      createRequestScopedCoreAgentRuntimeFactory({
        ...complete,
        workflowPool: { connect: vi.fn() } as never,
        google: { createProposalTargetReader: vi.fn() },
      } as never),
    ).toBeUndefined();
  });
});

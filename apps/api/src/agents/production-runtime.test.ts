import { describe, expect, it, vi } from 'vitest';

import type {
  ApprovalCheckpointGateway,
  ManagerConversationMemory,
  ModelDisclosureGateway,
  ModelAvailability,
  OpenAiAgentCostCalculator,
  OpenAiAgentsRunnerPort,
  ProviderWriteProposalGateway,
} from '@emdo/agent-core';
import {
  AgentInvocationContextSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
} from '@emdo/contracts';
import type {
  ProviderWriteApprovalStore,
  TrustedProviderWriteAuthorityResolver,
} from '@emdo/toolbox';
import { hashCanonicalJson } from '@emdo/toolbox';

import type {
  AuthenticatedPrincipal,
  RunEvent,
} from '../services/contracts.js';
import {
  PRODUCTION_AGENT_RUNTIME_BLOCKERS,
  createCoreProductionAgentRuntime,
  createFinanceOnlyProductionAgentRuntime,
  createFinanceV1ProductionAgentRuntime,
  createManagerOnlyProductionAgentRuntime,
  createProductionAgentRuntime,
  createProductionAgentServiceBindings,
  createProductionAgentServiceBindingsFromDependencies,
  type CoreProductionAgentRuntime,
  type DurableManagerTurnStore,
  type DurableRunEventSource,
  type ProductionAgentRuntimeDependencies,
  type ProductionAgentRuntimeFactory,
} from './production-runtime.js';
import { parseProductionProviderWriteCapabilityId } from './capability-runtime.js';
import type { TrustedProductionCapabilityServices } from './production-bindings.js';
import type { ProductionProviderProposalComposition } from './proposal-gateway.js';

const ids = Object.freeze({
  request: '018f1f5e-2000-7000-8000-000000000001',
  run: '018f1f5e-2000-7000-8000-000000000002',
  conversation: '018f1f5e-2000-7000-8000-000000000003',
  user: '018f1f5e-2000-7000-8000-000000000004',
  session: '018f1f5e-2000-7000-8000-000000000005',
  household: '018f1f5e-2000-7000-8000-000000000006',
  spaceGrant: '018f1f5e-2000-7000-8000-000000000007',
  privateSpace: '018f1f5e-2000-7000-8000-000000000008',
  rootManagerInvocation: '018f1f5e-2000-7000-8000-000000000009',
});

const principal: AuthenticatedPrincipal = Object.freeze({
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: ids.spaceGrant,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('f'.repeat(64)),
});
const runScopeFingerprint = EffectiveAuthorizationScopeFingerprintSchema.parse(
  'e'.repeat(64),
);

const providerWriteSafety = Object.freeze({
  atomicConditions: 'provider-native-single-request' as const,
  idempotency: 'deterministic-resource-id' as const,
  retryOwnership: 'adapter-bounded-within-invocation' as const,
  reconciliation: 'required' as const,
});

const notInvoked = vi.fn(async () => {
  throw new Error('test-capability-must-not-run');
});

const calendarEventCreate = {
  executeProviderWrite: notInvoked,
  materializeProposal: notInvoked,
  providerWriteSafety,
};

const capabilityServices = (): TrustedProductionCapabilityServices => ({
  specialists: {
    readCalendarFreeBusy: notInvoked,
    readTasks: notInvoked,
    writeTask: notInvoked,
    resolveTravelTime: notInvoked,
    readFinanceRecords: notInvoked,
    writeFinanceRecord: notInvoked,
    executeStatementImport: notInvoked,
    loadFinanceBudgetInputs: notInvoked,
    searchFinanceDocuments: notInvoked,
    readFinanceDocument: notInvoked,
    readFinanceMatches: notInvoked,
    readShoppingItems: notInvoked,
    writeShoppingItem: notInvoked,
    readOffers: notInvoked,
    refreshOffers: notInvoked,
    prepareLinkOut: notInvoked,
  },
  providerWrites: {
    'google-calendar.event.create': calendarEventCreate,
    'google-calendar.event.update': {
      executeProviderWrite: notInvoked,
      materializeProposal: notInvoked,
      providerWriteSafety,
    },
    'google-calendar.event.delete': {
      executeProviderWrite: notInvoked,
      materializeProposal: notInvoked,
      providerWriteSafety,
    },
  },
  delegations: {
    'agent.scheduler.delegate': notInvoked,
    'agent.finance.delegate': notInvoked,
    'agent.shopping.delegate': notInvoked,
  },
});

const calendarCreateBinding = (rawCapabilityId: unknown) => {
  const capabilityId =
    parseProductionProviderWriteCapabilityId(rawCapabilityId);
  if (capabilityId !== 'google-calendar.event.create') {
    throw new Error('test-provider-write-capability-missing');
  }
  return calendarEventCreate;
};

const approvalStore: ProviderWriteApprovalStore = {
  acquire: async () => ({ status: 'not-found' }),
  markDispatching: async () => ({ status: 'not-found' }),
  finalize: async () => 'not-found',
  reconcile: async () => 'not-found',
};

const authorityResolver: TrustedProviderWriteAuthorityResolver = {
  resolve: async () => undefined,
};

const proposalAuthorityResolver = {
  resolve: async () => undefined,
};

const proposalGateway: ProviderWriteProposalGateway = {
  prepare: async () => {
    throw new Error('test-proposal-must-not-run');
  },
  resolvePrepared: async () => undefined,
  abandonPrepared: async () => ({ status: 'not-abandonable' }),
  validateDecision: async () => false,
  executeDecision: async () => {
    throw new Error('test-proposal-must-not-run');
  },
};

const proposalComposition = (): ProductionProviderProposalComposition => ({
  approvalStore,
  createGateway: () => proposalGateway,
});

const modelAvailability: ModelAvailability = {
  isAvailable: vi.fn(async () => false),
};

const memory: ManagerConversationMemory = {
  retrieveForManager: async () => ({ entries: [] }),
  appendManagerMessage: async (input) => ({
    id: '018f1f5e-1000-7000-8000-000000000011',
    conversationId: input.conversationId,
    householdId: input.householdId,
    userId: input.userId,
    role: input.role,
    content: input.content,
    createdAt: '2026-08-09T22:30:00.000Z',
  }),
};

const approvalCheckpoints: ApprovalCheckpointGateway = {
  create: async () => {
    throw new Error('test-checkpoint-must-not-run');
  },
  consumeForResume: async () => ({ status: 'not-found' }),
  cancel: async () => ({ status: 'not-found' }),
};

const disclosureGateway: ModelDisclosureGateway = {
  authorize: async () => ({ status: 'denied', reason: 'no-active-grant' }),
};

const costCalculator: OpenAiAgentCostCalculator = {
  calculateCadMinor: () => 1,
};

const runtimeDependencies = (): ProductionAgentRuntimeDependencies & {
  readonly registeredAgentReadiness: Readonly<{
    scheduler: () => Promise<{ readonly status: 'ready' }>;
    finance: () => Promise<{ readonly status: 'ready' }>;
  }>;
} => ({
  capabilityServices: capabilityServices(),
  proposals: proposalComposition(),
  trustedProviderWriteAuthorityResolver: authorityResolver,
  trustedProviderProposalAuthorityResolver: proposalAuthorityResolver,
  modelAvailability,
  memory,
  traceSink: { append: async () => undefined },
  approvalCheckpoints,
  disclosureGateway,
  costCalculator,
  registeredAgentReadiness: {
    scheduler: async () => ({ status: 'ready' }),
    finance: async () => ({ status: 'ready' }),
  },
  spendGuard: {
    reserve: async () => ({
      status: 'blocked',
      warning: true,
      period: '2026-08',
      currentCadMinor: 7_500,
      safeError: {
        code: 'monthly-ai-spend-limit-reached',
        message: 'The monthly AI spend limit has been reached.',
        retryable: false,
      },
    }),
    markDispatched: async () => {
      throw new Error('test-spend-must-not-run');
    },
    settle: async () => {
      throw new Error('test-spend-must-not-run');
    },
    release: async () => {
      throw new Error('test-spend-must-not-run');
    },
  },
});

describe('production agent runtime', () => {
  it('accepts the narrow core runtime as a persistence factory result', () => {
    const fromCoreRuntime = (
      runtime: CoreProductionAgentRuntime,
    ): ProductionAgentRuntimeFactory =>
      Object.freeze({
        create: async () => runtime,
        check: async () => true,
      });

    expect(fromCoreRuntime).toBeTypeOf('function');
  });

  it('executes the core graph through its injected runner without a process-global API key', async () => {
    const fullServices = capabilityServices();
    const outputs = [
      {
        delegations: [
          {
            id: 'schedule-once',
            specialistId: 'scheduler',
            input: { request: 'Schedule one dentist appointment.' },
            dependsOn: [],
          },
        ],
        directResponse: null,
      },
      {
        summary: 'The appointment proposal is ready for review.',
        clarificationQuestion: null,
        evidenceReferences: [],
        derivedValueReferences: [],
        actionProposalReferences: [],
      },
      {
        summary: 'The appointment proposal is ready for visual approval.',
        clarificationQuestion: null,
        evidenceReferences: [],
        derivedValueReferences: [],
        actionProposalReferences: [],
      },
    ] as const;
    let outputIndex = 0;
    const executionRunner: OpenAiAgentsRunnerPort = {
      run: vi.fn(async () => {
        const finalOutput = outputs[outputIndex];
        outputIndex += 1;
        if (finalOutput === undefined) {
          throw new Error('test-runner-unexpected-invocation');
        }
        return {
          finalOutput,
          state: {
            usage: { inputTokens: 12, outputTokens: 6 },
            getInterruptions: () => [],
            approve: () => undefined,
            reject: () => undefined,
            toString: () => JSON.stringify({ status: 'completed' }),
          },
        };
      }),
    };
    const runtime = createCoreProductionAgentRuntime({
      ...runtimeDependencies(),
      capabilityServices: {
        schedulerDelegation:
          fullServices.delegations['agent.scheduler.delegate'],
        calendarEventCreate: calendarCreateBinding(
          'google-calendar.event.create',
        ),
      },
      executionRunner,
      modelAvailability: { isAvailable: async () => true },
      disclosureGateway: {
        authorize: async (input) => {
          const records = input.sources
            .map((source, index) => ({
              dataClass:
                source.kind === 'conversation-message'
                  ? 'conversation.messages'
                  : source.kind === 'manager-plan'
                    ? 'agent.manager-plans'
                    : source.kind === 'specialist-delegation'
                      ? 'agent.delegations'
                      : 'agent.specialist-outcomes',
              recordId: `test-record-${index + 1}`,
              fields: ['value'],
            }))
            .sort((left, right) =>
              `${left.dataClass}\0${left.recordId}`.localeCompare(
                `${right.dataClass}\0${right.recordId}`,
              ),
            );
          const invocationContext = AgentInvocationContextSchema.parse({
            ...input.invocation,
            disclosedContextRefs: records
              .map(
                ({ dataClass, recordId }) =>
                  `context-ref-${hashCanonicalJson({ dataClass, recordId })}`,
              )
              .sort(),
            deadline: '2099-01-01T00:00:00.000Z',
            idempotencyScope: 'c'.repeat(64),
          });
          return {
            status: 'authorized' as const,
            grantId: '018f1f5e-2000-7000-8000-000000000008',
            grantVersion: '1.0.0',
            runId: input.runId,
            householdId: input.householdId,
            userId: input.userId,
            agentId: input.agentId,
            phasePurpose: input.phasePurpose,
            phaseInvocationId: input.phaseInvocationId,
            invocationContext,
            invocationContextHash: hashCanonicalJson(invocationContext),
            disclosurePurpose: 'test-core-runner-injection',
            provider: 'openai' as const,
            expiresAt: '2099-01-01T00:00:00.000Z',
            records,
            payload: {
              schemaVersion: 1,
              records: records.map((record) => ({
                ...record,
                fields: { value: 'test' },
              })),
            },
          };
        },
      },
      spendGuard: {
        reserve: async ({ reservationId }) => ({
          status: 'reserved',
          warning: false,
          period: '2026-08',
          projectedCadMinor: 1,
          reservationId,
        }),
        markDispatched: async ({ reservationId }) => ({
          status: 'dispatched',
          period: '2026-08',
          reservationId,
        }),
        settle: async ({ reservationId, actualCadMinor }) => ({
          status: 'settled',
          period: '2026-08',
          reservationId,
          actualCadMinor,
          reservationExceeded: false,
        }),
        release: async ({ reservationId }) => ({
          status: 'released',
          period: '2026-08',
          reservationId,
        }),
      },
    });

    vi.stubEnv('OPENAI_API_KEY', 'process-global-key-must-not-be-used');
    try {
      const result = await runtime.orchestrator.runTurn({
        requestId: ids.request,
        runId: ids.run,
        householdId: ids.household,
        userId: ids.user,
        authenticatedSessionId: ids.session,
        conversationId: ids.conversation,
        rootManagerInvocationId: ids.rootManagerInvocation,
        spaceAccessGrantId: ids.spaceGrant,
        authorizationScopeFingerprint: runScopeFingerprint,
        locale: 'en-CA',
        message: 'Schedule a dentist appointment.',
        escalationTriggers: [],
        abortSignal: new AbortController().signal,
      });
      expect(executionRunner.run).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({
        status: 'completed',
        output: {
          summary: 'The appointment proposal is ready for visual approval.',
        },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('constructs only the manager-scheduler approved-calendar-create graph', () => {
    const fullServices = capabilityServices();
    const createGateway = vi.fn(() => proposalGateway);
    const dependencies = runtimeDependencies();

    const runtime = createCoreProductionAgentRuntime({
      ...dependencies,
      capabilityServices: {
        schedulerDelegation:
          fullServices.delegations['agent.scheduler.delegate'],
        calendarEventCreate: calendarCreateBinding(
          'google-calendar.event.create',
        ),
      },
      executionRunner: {
        run: async () => {
          throw new Error('test-core-runner-must-not-run');
        },
      },
      proposals: { approvalStore, createGateway },
    });

    expect(runtime.agentIds).toEqual(['manager', 'scheduler']);
    expect(runtime.capabilityIds).toEqual([
      'agent.scheduler.delegate',
      'google-calendar.event.create',
    ]);
    expect(runtime.capabilityIds).not.toEqual(
      expect.arrayContaining([
        'agent.finance.delegate',
        'agent.shopping.delegate',
        'scheduler.calendar.freebusy.read',
        'google-calendar.event.update',
        'google-calendar.event.delete',
        'maps.travel-time.read',
      ]),
    );
    expect(createGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        registry: expect.objectContaining({ size: 2 }),
        manifests: {
          manager: expect.objectContaining({
            capabilityAllowlist: ['agent.scheduler.delegate'],
          }),
          scheduler: expect.objectContaining({
            capabilityAllowlist: ['google-calendar.event.create'],
          }),
        },
      }),
    );
  });

  it('constructs the finite manager-scheduler-finance registered graph', () => {
    const fullServices = capabilityServices();
    const createGateway = vi.fn(() => proposalGateway);
    const dependencies = runtimeDependencies();

    const runtime = createFinanceV1ProductionAgentRuntime({
      ...dependencies,
      capabilityServices: {
        schedulerDelegation:
          fullServices.delegations['agent.scheduler.delegate'],
        financeDelegation: fullServices.delegations['agent.finance.delegate'],
        calendarEventCreate: calendarCreateBinding(
          'google-calendar.event.create',
        ),
        finance: {
          readFinanceRecords: fullServices.specialists.readFinanceRecords,
          writeFinanceRecord: fullServices.specialists.writeFinanceRecord,
          executeStatementImport:
            fullServices.specialists.executeStatementImport,
          loadFinanceBudgetInputs:
            fullServices.specialists.loadFinanceBudgetInputs,
          searchFinanceDocuments:
            fullServices.specialists.searchFinanceDocuments,
          readFinanceDocument: fullServices.specialists.readFinanceDocument,
          readFinanceMatches: fullServices.specialists.readFinanceMatches,
        },
      },
      executionRunner: {
        run: async () => {
          throw new Error('test-finance-v1-runner-must-not-run');
        },
      },
      proposals: { approvalStore, createGateway },
    });

    expect(runtime.agentIds).toEqual(['manager', 'scheduler', 'finance']);
    expect(runtime.capabilityIds).toEqual([
      'agent.scheduler.delegate',
      'agent.finance.delegate',
      'google-calendar.event.create',
      'finance.records.read',
      'finance.records.write',
      'finance.statement.import',
      'finance.analytics.calculate',
      'finance.documents.search',
      'finance.documents.read',
      'finance.matches.read',
    ]);
    expect(runtime.capabilityIds).not.toContain('agent.shopping.delegate');
    expect(createGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        registry: expect.objectContaining({ size: 10 }),
        manifests: {
          manager: expect.objectContaining({
            capabilityAllowlist: [
              'agent.scheduler.delegate',
              'agent.finance.delegate',
            ],
          }),
          scheduler: expect.objectContaining({
            capabilityAllowlist: ['google-calendar.event.create'],
          }),
          finance: expect.objectContaining({
            capabilityAllowlist: expect.arrayContaining([
              'finance.records.read',
              'finance.documents.search',
            ]),
          }),
        },
      }),
    );
  });

  it.each(['finance', 'scheduler'] as const)(
    'strips the %s structural route hint before the strict model-backed orchestrator',
    async (routeHint) => {
      const fullServices = capabilityServices();
      const executionRunner: OpenAiAgentsRunnerPort = {
        run: vi.fn(async () => {
          throw new Error('test-model-runner-must-not-run');
        }),
      };
      const runtime = createFinanceV1ProductionAgentRuntime({
        ...runtimeDependencies(),
        capabilityServices: {
          schedulerDelegation:
            fullServices.delegations['agent.scheduler.delegate'],
          financeDelegation: fullServices.delegations['agent.finance.delegate'],
          calendarEventCreate: calendarCreateBinding(
            'google-calendar.event.create',
          ),
          finance: {
            readFinanceRecords: fullServices.specialists.readFinanceRecords,
            writeFinanceRecord: fullServices.specialists.writeFinanceRecord,
            executeStatementImport:
              fullServices.specialists.executeStatementImport,
            loadFinanceBudgetInputs:
              fullServices.specialists.loadFinanceBudgetInputs,
            searchFinanceDocuments:
              fullServices.specialists.searchFinanceDocuments,
            readFinanceDocument: fullServices.specialists.readFinanceDocument,
            readFinanceMatches: fullServices.specialists.readFinanceMatches,
          },
        },
        executionRunner,
      });

      await expect(
        runtime.orchestrator.runTurn({
          requestId: ids.request,
          runId: ids.run,
          householdId: ids.household,
          userId: ids.user,
          authenticatedSessionId: ids.session,
          conversationId: ids.conversation,
          rootManagerInvocationId: ids.rootManagerInvocation,
          spaceAccessGrantId: ids.spaceGrant,
          authorizationScopeFingerprint: runScopeFingerprint,
          locale: 'en-CA',
          message: 'Review this request.',
          escalationTriggers: [],
          routeHint,
          abortSignal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        status: 'failed',
        safeError: { code: 'agent-model-unavailable' },
      });
      expect(executionRunner.run).not.toHaveBeenCalled();
    },
  );

  it('constructs the manager-only and manager-finance startup combinations', () => {
    const fullServices = capabilityServices();
    const dependencies = runtimeDependencies();
    const managerGateway = vi.fn(() => proposalGateway);
    const managerOnly = createManagerOnlyProductionAgentRuntime({
      ...dependencies,
      executionRunner: {
        run: async () => {
          throw new Error('test-manager-only-runner-must-not-run');
        },
      },
      proposals: { approvalStore, createGateway: managerGateway },
    });
    expect(managerOnly.agentIds).toEqual(['manager']);
    expect(managerOnly.capabilityIds).toEqual([]);
    expect(managerGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        registry: expect.objectContaining({ size: 0 }),
        manifests: {
          manager: expect.objectContaining({ capabilityAllowlist: [] }),
        },
      }),
    );

    const financeGateway = vi.fn(() => proposalGateway);
    const financeOnly = createFinanceOnlyProductionAgentRuntime({
      ...dependencies,
      capabilityServices: {
        financeDelegation: fullServices.delegations['agent.finance.delegate'],
        finance: {
          readFinanceRecords: fullServices.specialists.readFinanceRecords,
          writeFinanceRecord: fullServices.specialists.writeFinanceRecord,
          executeStatementImport:
            fullServices.specialists.executeStatementImport,
          loadFinanceBudgetInputs:
            fullServices.specialists.loadFinanceBudgetInputs,
          searchFinanceDocuments:
            fullServices.specialists.searchFinanceDocuments,
          readFinanceDocument: fullServices.specialists.readFinanceDocument,
          readFinanceMatches: fullServices.specialists.readFinanceMatches,
        },
      },
      executionRunner: {
        run: async () => {
          throw new Error('test-finance-only-runner-must-not-run');
        },
      },
      proposals: { approvalStore, createGateway: financeGateway },
    });
    expect(financeOnly.agentIds).toEqual(['manager', 'finance']);
    expect(financeOnly.capabilityIds).toHaveLength(8);
    expect(financeOnly.capabilityIds).not.toContain('agent.scheduler.delegate');
    expect(financeOnly.capabilityIds).not.toContain('agent.shopping.delegate');
    expect(financeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        registry: expect.objectContaining({ size: 8 }),
        manifests: {
          manager: expect.objectContaining({
            capabilityAllowlist: ['agent.finance.delegate'],
          }),
          finance: expect.objectContaining({
            capabilityAllowlist: expect.arrayContaining([
              'finance.records.read',
              'finance.documents.search',
            ]),
          }),
        },
      }),
    );
  });

  it('constructs the canonical four-agent OpenAI SDK graph with all 22 capabilities', () => {
    const createGateway = vi.fn(() => proposalGateway);
    const dependencies = runtimeDependencies();
    const runtime = createProductionAgentRuntime({
      ...dependencies,
      proposals: { approvalStore, createGateway },
    });

    expect(runtime.agentIds).toEqual([
      'manager',
      'scheduler',
      'finance',
      'shopping',
    ]);
    expect(runtime.capabilityIds).toHaveLength(22);
    expect(new Set(runtime.capabilityIds).size).toBe(22);
    expect(runtime.capabilityIds).toEqual(
      expect.arrayContaining([
        'agent.scheduler.delegate',
        'scheduler.tasks.read',
        'finance.statement.import',
        'finance.analytics.calculate',
        'finance.documents.search',
        'finance.documents.read',
        'finance.matches.read',
        'commerce.offers.refresh',
        'google-calendar.event.create',
      ]),
    );
    expect(runtime.agentGraphHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(runtime.sdkVersion).toBe('0.14.3');
    expect(createGateway).toHaveBeenCalledOnce();
    expect(createGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        registry: expect.objectContaining({ size: 22 }),
        manifests: expect.objectContaining({
          manager: expect.objectContaining({ id: 'manager' }),
          scheduler: expect.objectContaining({ id: 'scheduler' }),
          finance: expect.objectContaining({ id: 'finance' }),
          shopping: expect.objectContaining({ id: 'shopping' }),
        }),
      }),
    );
  });

  it('runs a manager turn only after a durable exact-scope claim and persists its result', async () => {
    const runtime = createProductionAgentRuntime(runtimeDependencies());
    const claim = vi.fn<DurableManagerTurnStore['claim']>(async () => ({
      status: 'claimed',
      claimId: 'turn-claim-00000001',
      ownershipToken: 'turn-owner-00000001',
      runId: ids.run,
      conversationId: ids.conversation,
      rootManagerInvocationId: ids.rootManagerInvocation,
      authorizationScopeFingerprint: runScopeFingerprint,
      escalationTriggers: [],
    }));
    const complete = vi.fn<DurableManagerTurnStore['complete']>(async () => ({
      status: 'completed',
      terminalEventSequence: 1,
    }));
    const turns: DurableManagerTurnStore = {
      claim,
      complete,
      markIndeterminate: async () => ({
        status: 'indeterminate',
        terminalEventSequence: 1,
      }),
      check: async () => true,
    };
    const events: RunEvent[] = [
      {
        schemaVersion: 1,
        runId: ids.run,
        sequence: 1,
        type: 'run.failed',
        occurredAt: '2026-08-10T12:00:00.000Z',
        data: { code: 'agent-model-unavailable' },
      },
    ];
    const source: DurableRunEventSource = {
      open: async () =>
        (async function* () {
          yield* events;
        })(),
      check: async () => true,
    };
    const create = vi.fn(async () => runtime);
    const services = createProductionAgentServiceBindingsFromDependencies({
      turns,
      runEvents: source,
      runtimeFactory: {
        create,
        check: async () => true,
      },
    });

    await expect(
      services.bindings.managerTurns.service.start({
        request: {
          schemaVersion: 1,
          locale: 'en-CA',
          message: 'What is on my schedule?',
        },
        principal,
        requestId: ids.request,
        idempotencyKey: 'turn-idempotency-00000001',
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      runId: ids.run,
      status: 'accepted',
      replayed: false,
      eventsPath: `/api/v1/runs/${ids.run}/events`,
    });
    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({
        principal,
        requestId: ids.request,
        idempotencyKey: 'turn-idempotency-00000001',
      }),
    );
    expect(create).toHaveBeenCalledWith({
      principal,
      requestId: ids.request,
      runId: ids.run,
      conversationId: ids.conversation,
      rootManagerInvocationId: ids.rootManagerInvocation,
      authorizationScopeFingerprint: runScopeFingerprint,
    });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: 'turn-claim-00000001',
        ownershipToken: 'turn-owner-00000001',
        runId: ids.run,
        result: expect.objectContaining({
          status: 'failed',
          safeError: expect.objectContaining({
            code: 'agent-model-unavailable',
          }),
        }),
      }),
    );
    await expect(services.bindings.managerTurns.check()).resolves.toBe(true);
    await expect(services.bindings.runEvents.check()).resolves.toBe(true);
    const replay = await services.bindings.runEvents.service.open({
      runId: ids.run,
      afterSequence: 0,
      principal,
      requestId: ids.request,
      abortSignal: new AbortController().signal,
    });
    const received: RunEvent[] = [];
    for await (const event of replay) received.push(event);
    expect(received).toEqual(events);
  });

  it('projects a built authenticated private-space principal only for strict durable stores', async () => {
    const authenticatedPrincipal: AuthenticatedPrincipal = Object.freeze({
      ...principal,
      privateSpaceId: ids.privateSpace,
    });
    const claim = vi.fn(async (input: { readonly principal: unknown }) => {
      expect(input.principal).toEqual(principal);
      expect(input.principal).not.toHaveProperty('privateSpaceId');
      return {
        status: 'replay' as const,
        runId: ids.run,
        conversationId: ids.conversation,
        rootManagerInvocationId: ids.rootManagerInvocation,
      };
    });
    const open = vi.fn(async (input: { readonly principal: unknown }) => {
      expect(input.principal).toEqual(principal);
      expect(input.principal).not.toHaveProperty('privateSpaceId');
      return (async function* () {
        yield* [] as RunEvent[];
      })();
    });
    const create = vi.fn(async (input: { readonly principal: unknown }) => {
      expect(input.principal).toBe(authenticatedPrincipal);
      throw new Error('runtime factory must not run for a replayed turn');
    });
    const turns: DurableManagerTurnStore = {
      claim,
      complete: vi.fn(),
      markIndeterminate: vi.fn(),
      check: async () => true,
    };
    const source: DurableRunEventSource = { open, check: async () => true };
    const services = createProductionAgentServiceBindingsFromDependencies({
      turns,
      runEvents: source,
      runtimeFactory: { create, check: async () => true },
    });

    await expect(
      services.bindings.managerTurns.service.start({
        request: {
          schemaVersion: 1,
          locale: 'en-CA',
          message: 'Schedule a meeting',
        },
        principal: authenticatedPrincipal,
        requestId: ids.request,
        idempotencyKey: 'turn-idempotency-00000011',
      }),
    ).resolves.toMatchObject({ status: 'accepted', replayed: true });
    expect(create).not.toHaveBeenCalled();

    const replay = await services.bindings.runEvents.service.open({
      runId: ids.run,
      afterSequence: 0,
      principal: authenticatedPrincipal,
      requestId: ids.request,
      abortSignal: new AbortController().signal,
    });
    for await (const event of replay) {
      void event;
      throw new Error('The strict test source must be empty');
    }
  });

  it('preserves wrong authenticated scope when projecting to durable stores', async () => {
    const wrongHousehold = '018f1f5e-2000-7000-8000-000000000009';
    const authenticatedPrincipal: AuthenticatedPrincipal = Object.freeze({
      ...principal,
      householdId: wrongHousehold,
      privateSpaceId: ids.privateSpace,
    });
    const claim = vi.fn(async (input: { readonly principal: unknown }) => {
      expect(input.principal).toMatchObject({
        householdId: wrongHousehold,
        userId: ids.user,
        sessionId: ids.session,
        spaceAccessGrantId: ids.spaceGrant,
      });
      expect(input.principal).not.toHaveProperty('privateSpaceId');
      return {
        status: 'replay' as const,
        runId: ids.run,
        conversationId: ids.conversation,
        rootManagerInvocationId: ids.rootManagerInvocation,
      };
    });
    const services = createProductionAgentServiceBindingsFromDependencies({
      turns: {
        claim,
        complete: vi.fn(),
        markIndeterminate: vi.fn(),
        check: async () => true,
      },
      runEvents: {
        open: async () =>
          (async function* () {
            yield* [] as RunEvent[];
          })(),
        check: async () => true,
      },
      runtimeFactory: {
        create: vi.fn(),
        check: async () => true,
      },
    });

    await expect(
      services.bindings.managerTurns.service.start({
        request: {
          schemaVersion: 1,
          locale: 'en-CA',
          message: 'Schedule a meeting',
        },
        principal: authenticatedPrincipal,
        requestId: ids.request,
        idempotencyKey: 'turn-idempotency-00000012',
      }),
    ).resolves.toMatchObject({ status: 'accepted', replayed: true });
  });

  it('keeps the bundled environment composition fail-closed with exact blockers', async () => {
    const composed = await createProductionAgentServiceBindings({
      EMDO_API_DATABASE_URL: 'postgresql://api:secret@postgres/emdo_app',
      OPENAI_API_KEY: 'must-not-be-consumed-by-an-incomplete-graph',
    });

    expect(composed.bindings).toEqual({});
    expect(composed.blockers).toEqual([
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
    ]);
    expect(composed.blockers).toBe(PRODUCTION_AGENT_RUNTIME_BLOCKERS);
    expect(composed.close).toBeUndefined();
  });

  it('rejects a malformed durable claim before runtime construction or model I/O', async () => {
    const create = vi.fn(async () =>
      createProductionAgentRuntime(runtimeDependencies()),
    );
    const markIndeterminate = vi.fn(async () => ({
      status: 'indeterminate' as const,
      terminalEventSequence: 1,
    }));
    const services = createProductionAgentServiceBindingsFromDependencies({
      turns: {
        claim: async () =>
          ({
            status: 'claimed',
            claimId: 'turn-claim-00000001',
            ownershipToken: 'turn-owner-00000001',
            runId: 'model-controlled-run-id',
            conversationId: ids.conversation,
            rootManagerInvocationId: ids.rootManagerInvocation,
            escalationTriggers: ['unknown-model-escalation'],
          }) as never,
        complete: async () => ({
          status: 'completed',
          terminalEventSequence: 1,
        }),
        markIndeterminate,
        check: async () => true,
      },
      runEvents: {
        open: async () =>
          (async function* () {
            yield* [] as RunEvent[];
          })(),
        check: async () => true,
      },
      runtimeFactory: { create, check: async () => true },
    });

    await expect(
      services.bindings.managerTurns.service.start({
        request: { schemaVersion: 1, locale: 'en-CA', message: 'Hello' },
        principal,
        requestId: ids.request,
        idempotencyKey: 'turn-idempotency-00000001',
      }),
    ).rejects.toThrow('api-agent-turn-claim-invalid');
    expect(create).not.toHaveBeenCalled();
    expect(markIndeterminate).not.toHaveBeenCalled();
  });

  it('terminalizes a malformed durable completion conservatively instead of accepting it as committed', async () => {
    const markIndeterminate = vi.fn(async () => ({
      status: 'indeterminate' as const,
      terminalEventSequence: 1,
    }));
    const runTurn = vi.fn(async () => ({
      status: 'failed' as const,
      safeError: {
        code: 'agent-model-unavailable',
        message: 'The requested model is unavailable.',
        retryable: false,
      },
    }));
    const services = createProductionAgentServiceBindingsFromDependencies({
      turns: {
        claim: async () => ({
          status: 'claimed',
          claimId: 'turn-claim-00000001',
          ownershipToken: 'turn-owner-00000001',
          runId: ids.run,
          conversationId: ids.conversation,
          rootManagerInvocationId: ids.rootManagerInvocation,
          authorizationScopeFingerprint: runScopeFingerprint,
          escalationTriggers: [],
        }),
        complete: async () => ({ status: 'model-controlled' }) as never,
        markIndeterminate,
        check: async () => true,
      },
      runEvents: {
        open: async () =>
          (async function* () {
            yield* [] as RunEvent[];
          })(),
        check: async () => true,
      },
      runtimeFactory: {
        create: async () => ({ orchestrator: { runTurn } }) as never,
        check: async () => true,
      },
    });

    await expect(
      services.bindings.managerTurns.service.start({
        request: { schemaVersion: 1, locale: 'en-CA', message: 'Hello' },
        principal,
        requestId: ids.request,
        idempotencyKey: 'turn-idempotency-00000001',
      }),
    ).resolves.toMatchObject({ status: 'accepted', replayed: false });
    expect(runTurn).toHaveBeenCalledOnce();
    expect(markIndeterminate).toHaveBeenCalledWith({
      claimId: 'turn-claim-00000001',
      ownershipToken: 'turn-owner-00000001',
      runId: ids.run,
      reasonCode: 'agent-runtime-failed',
    });
  });

  it('reports a claimed completion CAS replay truthfully', async () => {
    const services = createProductionAgentServiceBindingsFromDependencies({
      turns: {
        claim: async () => ({
          status: 'claimed',
          claimId: 'turn-claim-00000001',
          ownershipToken: 'turn-owner-00000001',
          runId: ids.run,
          conversationId: ids.conversation,
          rootManagerInvocationId: ids.rootManagerInvocation,
          authorizationScopeFingerprint: runScopeFingerprint,
          escalationTriggers: [],
        }),
        complete: async () => ({
          status: 'replay',
          terminalEventSequence: 7,
        }),
        markIndeterminate: async () => ({ status: 'conflict' }),
        check: async () => true,
      },
      runEvents: {
        open: async () =>
          (async function* () {
            yield* [] as RunEvent[];
          })(),
        check: async () => true,
      },
      runtimeFactory: {
        create: async () =>
          ({
            orchestrator: {
              runTurn: async () => ({
                status: 'failed',
                safeError: {
                  code: 'agent-model-unavailable',
                  message: 'The requested model is unavailable.',
                  retryable: false,
                },
              }),
            },
          }) as never,
        check: async () => true,
      },
    });

    await expect(
      services.bindings.managerTurns.service.start({
        request: { schemaVersion: 1, locale: 'en-CA', message: 'Hello' },
        principal,
        requestId: ids.request,
        idempotencyKey: 'turn-idempotency-00000001',
      }),
    ).resolves.toMatchObject({ status: 'accepted', replayed: true });
  });

  it('forwards the optional shopping route hint only through the structural runtime input', async () => {
    const runTurn = vi.fn(async () => ({
      status: 'failed' as const,
      runId: ids.run,
      localTraceReference: 'provider-free:test',
      safeError: {
        code: 'provider-free-command-unsupported',
        message: 'unsupported',
        retryable: false,
      },
      specialistOutcomes: [],
      usage: { inputTokens: 0, outputTokens: 0, modelCostCadMinor: 0 },
    }));
    const received = vi.fn<(input: { readonly routeHint?: string }) => void>();
    const services = createProductionAgentServiceBindingsFromDependencies({
      turns: {
        claim: async () => ({
          status: 'claimed' as const,
          claimId: 'turn-claim-00000001',
          ownershipToken: 'turn-owner-00000001',
          runId: ids.run,
          conversationId: ids.conversation,
          rootManagerInvocationId: ids.rootManagerInvocation,
          authorizationScopeFingerprint: runScopeFingerprint,
          escalationTriggers: [],
        }),
        complete: async () => ({
          status: 'completed' as const,
          terminalEventSequence: 1,
        }),
        markIndeterminate: async () => ({
          status: 'indeterminate' as const,
          terminalEventSequence: 1,
        }),
        check: async () => true,
      },
      runEvents: {
        open: async () =>
          (async function* () {
            yield* [] as RunEvent[];
          })(),
        check: async () => true,
      },
      runtimeFactory: {
        create: async () =>
          ({
            orchestrator: {
              runTurn: async (input: { readonly routeHint?: string }) => {
                received(input);
                return runTurn();
              },
            },
          }) as never,
        check: async () => true,
      },
    });

    await services.bindings.managerTurns.service.start({
      request: {
        schemaVersion: 1,
        locale: 'en-CA',
        message: 'add 2 each apples to shopping list',
        routeHint: 'shopping',
      },
      principal,
      requestId: ids.request,
      idempotencyKey: 'turn-idempotency-route-hint',
    });
    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({ routeHint: 'shopping' }),
    );
  });
});

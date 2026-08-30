import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  AgentOrchestrator,
  LocalTraceRecorder,
  type AgentExecutionProvider,
  type AgentProviderRequest,
  type CompiledAgent,
  type JsonValue,
  type ManagerConversationMemory,
  type ModelDisclosureAuthorization,
  type ModelDisclosureGateway,
  type ModelDisclosureSource,
  type ProviderWriteProposalGateway,
  type TurnInput,
  type ValidatedAgentManifest,
} from '@emdo/agent-core';
import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { hashCanonicalJson } from '@emdo/toolbox';

import {
  FINANCE_V1_REGISTERED_SPECIALIST_IDS,
  createFinanceV1RegisteredAgentProfile,
} from './registered-agent-profile.js';

const ids = Object.freeze({
  request: '018f1f5e-4000-7000-8000-000000000001',
  run: '018f1f5e-4000-7000-8000-000000000002',
  household: '018f1f5e-4000-7000-8000-000000000003',
  user: '018f1f5e-4000-7000-8000-000000000004',
  session: '018f1f5e-4000-7000-8000-000000000005',
  conversation: '018f1f5e-4000-7000-8000-000000000006',
  spaceGrant: '018f1f5e-4000-7000-8000-000000000007',
  managerGrant: '018f1f5e-4000-7000-8000-000000000008',
  financeGrant: '018f1f5e-4000-7000-8000-000000000009',
  schedulerGrant: '018f1f5e-4000-7000-8000-00000000000a',
  rootManagerInvocation: '018f1f5e-4000-7000-8000-00000000000b',
});

const scope = EffectiveAuthorizationScopeFingerprintSchema.parse(
  'e'.repeat(64),
);
const graphHash = 'a'.repeat(64);
const usage = Object.freeze({
  inputTokens: 1,
  outputTokens: 1,
  modelCostCadMinor: 1,
});

const completed = (output: JsonValue) =>
  Object.freeze({ status: 'completed' as const, output, usage });

const turn = (): TurnInput =>
  Object.freeze({
    requestId: ids.request,
    runId: ids.run,
    householdId: ids.household,
    userId: ids.user,
    authenticatedSessionId: ids.session,
    conversationId: ids.conversation,
    rootManagerInvocationId: ids.rootManagerInvocation,
    spaceAccessGrantId: ids.spaceGrant,
    authorizationScopeFingerprint: scope,
    locale: 'en-CA',
    message: 'Review my budget and schedule a follow-up.',
    escalationTriggers: [],
    abortSignal: new AbortController().signal,
  });

const agent = (
  id: string,
  kind: 'manager' | 'specialist',
  capabilities: readonly string[],
): CompiledAgent<Readonly<{ readonly id: string }>> => {
  const manifest: ValidatedAgentManifest = Object.freeze({
    schemaVersion: 1,
    id,
    version: '1.0.0',
    kind,
    instructionIds: [`${id}.instructions.v1`],
    skillIds: ['privacy.v1'],
    capabilityAllowlist: capabilities,
    readableDataClasses:
      kind === 'manager'
        ? [
            'conversation.messages',
            'agent.manager-plans',
            'agent.specialist-outcomes',
          ]
        : ['agent.delegations', 'agent.specialist-outcomes'],
    riskCeiling: 'none',
    modelPolicy: Object.freeze({
      defaultModel: 'gpt-5.6-luna',
      complexModel: 'gpt-5.6-terra',
      escalationReasons: [
        'dependent-cross-domain',
        'failed-output-validation',
        'low-confidence-reconciliation',
        'luna-unavailable',
        'complex-reasoning',
      ] as const,
    }),
    executionBudget: Object.freeze({
      maxTurns: 4,
      maxCapabilityCalls: 16,
      maxParallelCalls: 3,
      timeoutMs: 30_000,
      maxInputTokens: 20_000,
      maxOutputTokens: 4_000,
    }),
    schemaRefs: Object.freeze({
      input: Object.freeze({ id: `${id}.input`, version: '1.0.0' }),
      output: Object.freeze({ id: `${id}.output`, version: '1.0.0' }),
    }),
  });
  return Object.freeze({
    manifest,
    instructions: `${id} instructions`,
    capabilities: [],
    inputSchema: z.looseObject({}),
    outputSchema: z.looseObject({}),
    materialize: () => Object.freeze({ id }),
  });
};

const projection = (
  sources: readonly ModelDisclosureSource[],
): Pick<ModelDisclosureAuthorization, 'records' | 'payload'> => {
  const records = sources.map((source, index) => {
    if (source.kind === 'conversation-message') {
      return {
        dataClass: 'conversation.messages',
        recordId: source.entry.id,
        fields: { message: source.entry.content },
      };
    }
    if (source.kind === 'manager-plan') {
      return {
        dataClass: 'agent.manager-plans',
        recordId: 'manager-plan',
        fields: { plan: source.plan },
      };
    }
    if (source.kind === 'specialist-delegation') {
      return {
        dataClass: 'agent.delegations',
        recordId: `delegation-${index}`,
        fields: { delegation: source.delegation },
      };
    }
    return {
      dataClass: 'agent.specialist-outcomes',
      recordId: `outcome-${index}`,
      fields: { outcome: source.outcome },
    };
  });
  const normalized = records.sort((left, right) =>
    `${left.dataClass}\0${left.recordId}`.localeCompare(
      `${right.dataClass}\0${right.recordId}`,
    ),
  );
  return {
    records: normalized.map(({ dataClass, recordId, fields }) => ({
      dataClass,
      recordId,
      fields: Object.keys(fields),
    })),
    payload: { schemaVersion: 1, records: normalized } as unknown as JsonValue,
  };
};

const setup = (execute: AgentExecutionProvider['execute']) => {
  const requests: AgentProviderRequest[] = [];
  const appendManagerMessage = vi.fn<
    ManagerConversationMemory['appendManagerMessage']
  >(async (input) => ({
    id: input.role === 'user' ? ids.request : ids.managerGrant,
    conversationId: input.conversationId,
    householdId: input.householdId,
    userId: input.userId,
    role: input.role,
    content: input.content,
    createdAt: '2026-08-26T12:00:00.000Z',
  }));
  const disclosureGateway: ModelDisclosureGateway = {
    authorize: vi.fn(async (input) => {
      const projected = projection(input.sources);
      const expiresAt = '2099-01-01T00:00:00.000Z';
      const invocationContext = Object.freeze({
        ...input.invocation,
        disclosedContextRefs: Object.freeze(
          projected.records
            .map(
              ({ dataClass, recordId }) =>
                `context-ref-${hashCanonicalJson({ dataClass, recordId })}`,
            )
            .sort(),
        ),
        deadline: expiresAt,
        idempotencyScope: hashCanonicalJson({
          domain: 'registered-orchestration-test.v1',
          invocation: input.invocation,
          records: projected.records,
        }),
      });
      return {
        status: 'authorized' as const,
        grantId:
          input.agentId === 'manager'
            ? ids.managerGrant
            : input.agentId === 'finance'
              ? ids.financeGrant
              : ids.schedulerGrant,
        grantVersion: '1.0.0',
        runId: input.runId,
        householdId: input.householdId,
        userId: input.userId,
        agentId: input.agentId,
        phasePurpose: input.phasePurpose,
        phaseInvocationId: input.phaseInvocationId,
        invocationContext,
        invocationContextHash: hashCanonicalJson(invocationContext),
        disclosurePurpose: 'registered-orchestration-test',
        provider: 'openai' as const,
        expiresAt,
        ...projected,
      };
    }),
  };
  const proposalGateway: ProviderWriteProposalGateway = {
    prepare: async () => {
      throw new Error('provider-write-not-used-by-orchestration-contract');
    },
    resolvePrepared: async () => undefined,
    abandonPrepared: async () => ({ status: 'not-abandonable' }),
    validateDecision: async () => false,
    executeDecision: async () => {
      throw new Error('provider-write-not-used-by-orchestration-contract');
    },
  };
  const orchestrator = new AgentOrchestrator({
    manager: agent('manager', 'manager', [
      'agent.scheduler.delegate',
      'agent.finance.delegate',
    ]),
    specialists: [
      agent('scheduler', 'specialist', []),
      agent('finance', 'specialist', []),
    ],
    executionProvider: {
      execute: async (request) => {
        requests.push(request);
        await request.beforeModelDispatch?.();
        const result = await execute(request);
        await request.onModelDispatch?.();
        return result;
      },
    },
    modelRouter: {
      resolve: async () => ({
        status: 'resolved' as const,
        requestedModel: 'gpt-5.6-luna' as const,
        resolvedModel: 'gpt-5.6-luna' as const,
        reason: 'default' as const,
      }),
    },
    memory: {
      retrieveForManager: async () => ({ entries: [] }),
      appendManagerMessage,
    },
    traceRecorder: new LocalTraceRecorder(
      { append: async () => undefined },
      () => new Date('2026-08-26T12:00:00.000Z'),
      () => 'registered-orchestration-trace',
    ),
    approvalCheckpoints: {
      create: async () => {
        throw new Error('approval-not-used-by-orchestration-contract');
      },
      consumeForResume: async () => ({ status: 'not-found' }),
      cancel: async () => ({ status: 'not-found' }),
    },
    proposalGateway,
    disclosureGateway,
    agentGraphHash: graphHash,
    sdkVersion: '0.14.3',
  });
  return { appendManagerMessage, disclosureGateway, orchestrator, requests };
};

describe('registered Finance v1 orchestration contract', () => {
  it('registers only Manager, Scheduler, and Finance, and rejects duplicate or unapproved delegation edges', () => {
    const profile = createFinanceV1RegisteredAgentProfile({
      schedulerReadiness: async () => ({ status: 'ready' }),
      financeReadiness: async () => ({ status: 'ready' }),
    });
    expect(FINANCE_V1_REGISTERED_SPECIALIST_IDS).toEqual([
      'scheduler',
      'finance',
    ]);
    expect(profile.manager.manifest.capabilityAllowlist).toEqual([
      'agent.scheduler.delegate',
      'agent.finance.delegate',
    ]);
    expect(profile.specialists.map(({ manifest }) => manifest.id)).toEqual([
      'scheduler',
      'finance',
    ]);
    expect(
      profile.registrations.map(({ allowedChildren }) => allowedChildren),
    ).toEqual([[], []]);
    expect(profile.manager.manifest.capabilityAllowlist).not.toContain(
      'agent.shopping.delegate',
    );
    expect(
      () =>
        new AgentOrchestrator({
          ...orchestratorDependencies(),
          specialists: [
            agent('scheduler', 'specialist', []),
            agent('scheduler', 'specialist', []),
          ],
        }),
    ).toThrow('duplicate-specialist-agent');
    expect(
      () =>
        new AgentOrchestrator({
          ...orchestratorDependencies(),
          manager: agent('manager', 'manager', ['agent.scheduler.delegate']),
          specialists: [agent('finance', 'specialist', [])],
        }),
    ).toThrow('manager-specialist-delegation-denied');
  });

  it.each([
    ['finance', 'finance-only', 'Finance summary.'],
    ['scheduler', 'schedule-only', 'Schedule summary.'],
  ] as const)(
    'routes a %s request through its specialist and exposes only the manager synthesis as output',
    async (specialistId, delegationId, summary) => {
      const { appendManagerMessage, orchestrator, requests } = setup(
        async (request) => {
          if (request.phase === 'plan') {
            return completed({
              delegations: [
                { id: delegationId, specialistId, input: {}, dependsOn: [] },
              ],
            });
          }
          if (request.phase === 'specialist') {
            return completed({ internalSpecialistResult: specialistId });
          }
          return completed({ summary });
        },
      );

      const result = await orchestrator.runTurn(turn());

      if (result.status !== 'completed') {
        throw new Error(`expected completed turn, received ${result.status}`);
      }
      expect(result).toMatchObject({
        status: 'completed',
        output: { summary },
      });
      expect(
        requests.map(({ phase, agent }) => [phase, agent.manifest.id]),
      ).toEqual([
        ['plan', 'manager'],
        ['specialist', specialistId],
        ['synthesize', 'manager'],
      ]);
      expect(result.output).not.toHaveProperty('internalSpecialistResult');
      expect(appendManagerMessage.mock.calls.at(-1)?.[0]).toMatchObject({
        role: 'assistant',
        content: summary,
      });
    },
  );

  it('runs independent Finance and Scheduler work before exactly one manager synthesis', async () => {
    const { orchestrator, requests } = setup(async (request) => {
      if (request.phase === 'plan') {
        return completed({
          delegations: [
            {
              id: 'finance',
              specialistId: 'finance',
              input: {},
              dependsOn: [],
            },
            {
              id: 'schedule',
              specialistId: 'scheduler',
              input: {},
              dependsOn: [],
            },
          ],
        });
      }
      if (request.phase === 'specialist') {
        return completed({ from: request.agent.manifest.id });
      }
      return completed({ summary: 'Finance and schedule are ready.' });
    });

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'completed',
      hasPartialFailures: false,
      specialistOutcomes: [
        { specialistId: 'finance', status: 'completed' },
        { specialistId: 'scheduler', status: 'completed' },
      ],
    });
    expect(requests.filter(({ phase }) => phase === 'synthesize')).toHaveLength(
      1,
    );
    expect(
      requests
        .filter(({ phase }) => phase === 'specialist')
        .map(({ agent }) => agent.manifest.id),
    ).toEqual(expect.arrayContaining(['finance', 'scheduler']));
  });

  it('honors dependent order and discloses a dependent specialist only its delegation plus dependency outcome', async () => {
    const lifecycle: string[] = [];
    const { orchestrator, requests } = setup(async (request) => {
      if (request.phase === 'plan') {
        return completed({
          delegations: [
            {
              id: 'finance-first',
              specialistId: 'finance',
              input: {},
              dependsOn: [],
            },
            {
              id: 'schedule-after-finance',
              specialistId: 'scheduler',
              input: {},
              dependsOn: ['finance-first'],
            },
          ],
        });
      }
      if (request.phase === 'specialist') {
        lifecycle.push(`start:${request.agent.manifest.id}`);
        lifecycle.push(`finish:${request.agent.manifest.id}`);
        return completed({ completedBy: request.agent.manifest.id });
      }
      return completed({ summary: 'Follow-up scheduled from finance result.' });
    });

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'completed',
    });
    expect(lifecycle).toEqual([
      'start:finance',
      'finish:finance',
      'start:scheduler',
      'finish:scheduler',
    ]);
    const schedulerInput = requests.find(
      ({ phase, agent }) =>
        phase === 'specialist' && agent.manifest.id === 'scheduler',
    )?.input as { records: readonly { dataClass: string }[] };
    expect(schedulerInput.records.map(({ dataClass }) => dataClass)).toEqual([
      'agent.delegations',
      'agent.specialist-outcomes',
    ]);
    expect(JSON.stringify(schedulerInput)).not.toContain(turn().message);
  });

  it('synthesizes truthful structured partial failure without exposing the specialist exception', async () => {
    const { orchestrator, requests } = setup(async (request) => {
      if (request.phase === 'plan') {
        return completed({
          delegations: [
            {
              id: 'finance',
              specialistId: 'finance',
              input: {},
              dependsOn: [],
            },
            {
              id: 'schedule',
              specialistId: 'scheduler',
              input: {},
              dependsOn: [],
            },
          ],
        });
      }
      if (
        request.phase === 'specialist' &&
        request.agent.manifest.id === 'finance'
      ) {
        throw new Error('raw finance provider exception');
      }
      if (request.phase === 'specialist')
        return completed({ schedule: 'ready' });
      return completed({
        summary: 'Scheduling succeeded; finance is unavailable.',
      });
    });

    const result = await orchestrator.runTurn(turn());

    expect(result).toMatchObject({
      status: 'completed',
      output: { summary: 'Scheduling succeeded; finance is unavailable.' },
      hasPartialFailures: true,
      specialistOutcomes: expect.arrayContaining([
        expect.objectContaining({
          specialistId: 'finance',
          status: 'unavailable',
          reasonCode: 'specialist-dispatch-unavailable',
        }),
        expect.objectContaining({
          specialistId: 'scheduler',
          status: 'completed',
        }),
      ]),
    });
    expect(JSON.stringify(result)).not.toContain(
      'raw finance provider exception',
    );
    expect(requests.filter(({ phase }) => phase === 'synthesize')).toHaveLength(
      1,
    );
  });

  it.each(['shopping', 'unregistered-specialist'] as const)(
    'fails closed before specialist dispatch for %s',
    async (specialistId) => {
      const { orchestrator, requests } = setup(async () =>
        completed({
          delegations: [
            { id: 'forbidden', specialistId, input: {}, dependsOn: [] },
          ],
        }),
      );

      await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
        status: 'failed',
        safeError: { code: 'invalid-manager-plan', retryable: false },
      });
      expect(
        requests.filter(({ phase }) => phase === 'specialist'),
      ).toHaveLength(0);
      expect(
        requests.filter(({ phase }) => phase === 'synthesize'),
      ).toHaveLength(0);
    },
  );

  it('rejects recursive dependency plans before any specialist dispatch', async () => {
    const { orchestrator, requests } = setup(async () =>
      completed({
        delegations: [
          {
            id: 'finance-first',
            specialistId: 'finance',
            input: {},
            dependsOn: ['schedule-second'],
          },
          {
            id: 'schedule-second',
            specialistId: 'scheduler',
            input: {},
            dependsOn: ['finance-first'],
          },
        ],
      }),
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: { code: 'invalid-manager-plan', retryable: false },
    });
    expect(requests.filter(({ phase }) => phase === 'specialist')).toHaveLength(
      0,
    );
  });

  it('rejects duplicate section invocations before any specialist dispatch', async () => {
    const { orchestrator, requests } = setup(async (request) => {
      if (request.phase === 'plan') {
        return completed({
          delegations: [
            {
              id: 'finance-first',
              specialistId: 'finance',
              input: {},
              dependsOn: [],
            },
            {
              id: 'finance-second',
              specialistId: 'finance',
              input: {},
              dependsOn: [],
            },
          ],
        });
      }
      throw new Error(`unexpected ${request.phase} dispatch`);
    });

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: { code: 'invalid-manager-plan', retryable: false },
    });
    expect(requests.filter(({ phase }) => phase === 'specialist')).toHaveLength(
      0,
    );
    expect(requests.filter(({ phase }) => phase === 'synthesize')).toHaveLength(
      0,
    );
  });
});

const orchestratorDependencies = () => ({
  manager: agent('manager', 'manager', [
    'agent.scheduler.delegate',
    'agent.finance.delegate',
  ]),
  specialists: [agent('scheduler', 'specialist', [])],
  executionProvider: { execute: async () => completed({}) },
  modelRouter: {
    resolve: async () => ({
      status: 'resolved' as const,
      requestedModel: 'gpt-5.6-luna' as const,
      resolvedModel: 'gpt-5.6-luna' as const,
      reason: 'default' as const,
    }),
  },
  memory: {
    retrieveForManager: async () => ({ entries: [] }),
    appendManagerMessage: async () => ({
      id: ids.request,
      conversationId: ids.conversation,
      householdId: ids.household,
      userId: ids.user,
      role: 'assistant' as const,
      content: '',
      createdAt: '2026-08-26T12:00:00.000Z',
    }),
  },
  traceRecorder: new LocalTraceRecorder(
    { append: async () => undefined },
    () => new Date('2026-08-26T12:00:00.000Z'),
    () => 'registered-orchestration-guard-trace',
  ),
  approvalCheckpoints: {
    create: async () => {
      throw new Error('not-used');
    },
    consumeForResume: async () => ({ status: 'not-found' as const }),
    cancel: async () => ({ status: 'not-found' as const }),
  },
  proposalGateway: {
    prepare: async () => {
      throw new Error('not-used');
    },
    resolvePrepared: async () => undefined,
    abandonPrepared: async () => ({ status: 'not-abandonable' as const }),
    validateDecision: async () => false,
    executeDecision: async () => {
      throw new Error('not-used');
    },
  } satisfies ProviderWriteProposalGateway,
  disclosureGateway: {
    authorize: async (
      input: Parameters<ModelDisclosureGateway['authorize']>[0],
    ) => {
      const projected = projection(input.sources);
      const expiresAt = '2099-01-01T00:00:00.000Z';
      const invocationContext = Object.freeze({
        ...input.invocation,
        disclosedContextRefs: Object.freeze(
          projected.records
            .map(
              ({ dataClass, recordId }) =>
                `context-ref-${hashCanonicalJson({ dataClass, recordId })}`,
            )
            .sort(),
        ),
        deadline: expiresAt,
        idempotencyScope: hashCanonicalJson({
          domain: 'registered-orchestration-guard-test.v1',
          invocation: input.invocation,
          records: projected.records,
        }),
      });
      return {
        status: 'authorized' as const,
        grantId: ids.managerGrant,
        grantVersion: '1.0.0',
        runId: input.runId,
        householdId: input.householdId,
        userId: input.userId,
        agentId: input.agentId,
        phasePurpose: input.phasePurpose,
        phaseInvocationId: input.phaseInvocationId,
        invocationContext,
        invocationContextHash: hashCanonicalJson(invocationContext),
        disclosurePurpose: 'guard-test',
        provider: 'openai' as const,
        expiresAt,
        ...projected,
      };
    },
  } satisfies ModelDisclosureGateway,
  agentGraphHash: graphHash,
  sdkVersion: '0.14.3',
});

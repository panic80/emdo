import { describe, expect, it } from 'vitest';

import {
  AesGcmApprovalCheckpointCipher,
  ApprovalCheckpointService,
  InMemoryApprovalCheckpointRepository,
} from '../packages/agent-core/src/approval-state.js';
import type {
  CompiledAgent,
  ValidatedAgentManifest,
} from '../packages/agent-core/src/factory.js';
import type {
  EmdoModelId,
  ModelResolution,
} from '../packages/agent-core/src/model-router.js';
import {
  InMemoryModelAvailability,
  ModelRouter,
} from '../packages/agent-core/src/model-router.js';
import {
  AgentOrchestrator,
  createOpenAiAgentsSdkFacade,
  OpenAiAgentsExecutionProvider,
  type AgentExecutionProvider,
  type AgentProviderResult,
  type AgentProviderRequest,
  type ModelDisclosureGateway,
  type OpenAiAgentsRunnerPort,
  type ProviderWriteProposalGateway,
} from '../packages/agent-core/src/runner.js';
import {
  LocalTraceRecorder,
  type LocalTraceEvent,
  type LocalTraceSink,
} from '../packages/agent-core/src/trace.js';
import { sumCadMinorUnits } from '../packages/domains/src/finance/money.js';
import {
  managerInputSchema,
  managerOutputSchema,
} from '../packages/agents/manager/src/schemas.js';
import {
  calendarApprovalFixture,
  disclosureFixture,
  EVAL_NOW,
  expiringDisclosureFixture,
  multipleCalendarWriteFixture,
} from './fixtures/scenario-data.js';
import { emdoAgentEvalCases } from './src/cases.js';
import {
  createAgentOrchestratorEvalDriver,
  type EvalLocalTraceSource,
} from './src/orchestrator-driver.js';
import { createAgentEvalRunner, type AgentEvalCase } from './src/runner.js';

const evalCase = (id: string): AgentEvalCase => {
  const found = emdoAgentEvalCases.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing eval case: ${id}`);
  return found;
};

class TraceBuffer implements LocalTraceSink, EvalLocalTraceSource {
  readonly #events = new Map<string, LocalTraceEvent[]>();

  async append(event: LocalTraceEvent): Promise<void> {
    const events = this.#events.get(event.traceReference) ?? [];
    events.push(event);
    this.#events.set(event.traceReference, events);
  }

  take(reference: string): readonly LocalTraceEvent[] {
    const events = this.#events.get(reference) ?? [];
    this.#events.set(reference, []);
    return events;
  }
}

const compiledAgent = (
  id: 'manager' | 'scheduler' | 'finance' | 'shopping',
): CompiledAgent<Readonly<{ id: string; model: string }>> => {
  const kind = id === 'manager' ? 'manager' : 'specialist';
  const manifest: ValidatedAgentManifest = Object.freeze({
    schemaVersion: 1,
    id,
    version: '1.0.0',
    kind,
    instructionIds: [`${id}.instructions.v1`],
    skillIds: ['privacy.v1'],
    capabilityAllowlist:
      kind === 'manager'
        ? [
            'agent.scheduler.delegate',
            'agent.finance.delegate',
            'agent.shopping.delegate',
          ]
        : [`${id}.read`],
    readableDataClasses:
      id === 'manager'
        ? []
        : id === 'scheduler'
          ? ['calendar.events']
          : id === 'finance'
            ? ['finance.transactions']
            : ['shopping.items'],
    riskCeiling: kind === 'manager' ? 'none' : 'read',
    modelPolicy: Object.freeze({
      defaultModel: 'gpt-5.6-luna',
      complexModel: 'gpt-5.6-terra',
      escalationReasons: Object.freeze([
        'dependent-cross-domain',
        'failed-output-validation',
        'low-confidence-reconciliation',
        'luna-unavailable',
        'complex-reasoning',
      ] as const),
    }),
    executionBudget: Object.freeze({
      maxTurns: 12,
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
    capabilities: Object.freeze([]),
    inputSchema: managerInputSchema.schema,
    outputSchema: managerOutputSchema.schema,
    materialize: (model: EmdoModelId) => Object.freeze({ id, model }),
  });
};

const compiledSdkScheduler = (
  proposalGateway: ProviderWriteProposalGateway,
  executeProviderWrite: () => Promise<unknown>,
): CompiledAgent => {
  const base = compiledAgent('scheduler');
  const capabilityId = multipleCalendarWriteFixture.capabilityId;
  const facade = createOpenAiAgentsSdkFacade({ proposalGateway });
  const sdkTool = facade.createTool({
    canonicalCapabilityId: capabilityId,
    capabilityKind: 'provider-write',
    name: 'google_calendar_event_create',
    description: 'Create one exact Google Calendar event proposal.',
    parameters: managerInputSchema.schema,
    outputSchema: managerOutputSchema.schema,
    needsApproval: true,
    timeoutMs: 30_000,
    execute: executeProviderWrite,
  });
  return Object.freeze({
    ...base,
    manifest: Object.freeze({
      ...base.manifest,
      capabilityAllowlist: Object.freeze([capabilityId]),
      riskCeiling: 'provider-write' as const,
    }),
    capabilities: Object.freeze([
      Object.freeze({
        descriptor: Object.freeze({
          id: capabilityId,
          version: '1.0.0',
          capabilityKind: 'provider-write' as const,
          requiredDataClasses: Object.freeze(['calendar.events']),
          riskClass: 'provider-write' as const,
          description: 'Create one exact Google Calendar event proposal.',
          inputSchema: Object.freeze({
            id: `${capabilityId}.input`,
            version: '1.0.0',
          }),
          outputSchema: Object.freeze({
            id: `${capabilityId}.output`,
            version: '1.0.0',
          }),
          timeoutMs: 30_000,
          approval: Object.freeze({
            rule: 'authenticated-visual-proposal' as const,
          }),
        }),
        invoke: executeProviderWrite,
      }),
    ]),
    materialize: (
      model: EmdoModelId,
      options?: Parameters<CompiledAgent['materialize']>[1],
    ) =>
      facade.createAgent({
        name: 'scheduler',
        instructions: base.instructions,
        model,
        tools: options?.exposeCapabilities === false ? [] : [sdkTool],
        outputType: options?.outputType ?? managerOutputSchema.schema,
        maxOutputTokens: base.manifest.executionBudget.maxOutputTokens,
      }),
  });
};

const acceptingSpendGuard = Object.freeze({
  reserve: async ({ reservationId }: { readonly reservationId: string }) =>
    Object.freeze({
      status: 'reserved' as const,
      warning: false,
      period: '2026-08',
      projectedCadMinor: 1,
      reservationId,
    }),
  markDispatched: async ({
    reservationId,
  }: {
    readonly reservationId: string;
  }) =>
    Object.freeze({
      status: 'dispatched' as const,
      period: '2026-08',
      reservationId,
    }),
  settle: async ({
    reservationId,
    actualCadMinor,
  }: {
    readonly reservationId: string;
    readonly actualCadMinor: number;
  }) =>
    Object.freeze({
      status: 'settled' as const,
      period: '2026-08',
      reservationId,
      actualCadMinor,
      reservationExceeded: false,
    }),
  release: async ({ reservationId }: { readonly reservationId: string }) =>
    Object.freeze({
      status: 'released' as const,
      period: '2026-08',
      reservationId,
    }),
});

type EvalJson =
  | null
  | boolean
  | number
  | string
  | readonly EvalJson[]
  | Readonly<{ [key: string]: EvalJson }>;

const completed = (
  output: EvalJson,
): Extract<AgentProviderResult, { readonly status: 'completed' }> =>
  Object.freeze({
    status: 'completed' as const,
    output,
    usage: Object.freeze({
      inputTokens: 10,
      outputTokens: 5,
      modelCostCadMinor: 1,
    }),
  });

const managerOutput = (summary: string): EvalJson =>
  Object.freeze({
    summary,
    clarificationQuestion: null,
    evidenceReferences: Object.freeze([]),
    derivedValueReferences: Object.freeze([]),
    actionProposalReferences: Object.freeze([]),
  });

const rejectingProposalGateway: ProviderWriteProposalGateway = Object.freeze({
  prepare: async () => {
    throw new Error('proposal preparation not expected');
  },
  resolvePrepared: async () => undefined,
  abandonPrepared: async () => Object.freeze({ status: 'abandoned' as const }),
  validateDecision: async () => false,
  executeDecision: async () => {
    throw new Error('proposal execution not expected');
  },
});

const checkpointCancellationNotExpected = async (): Promise<never> => {
  throw new Error('checkpoint cancellation not expected');
};

const defaultDisclosureGateway: ModelDisclosureGateway = Object.freeze({
  authorize: async (
    input: Parameters<ModelDisclosureGateway['authorize']>[0],
  ) =>
    Object.freeze({
      status: 'authorized' as const,
      grantId: input.requestedGrantId ?? disclosureFixture.grantId,
      grantVersion: '1.0.0',
      runId: input.runId,
      householdId: input.householdId,
      userId: input.userId,
      agentId: input.agentId,
      phasePurpose: input.phasePurpose,
      disclosurePurpose: 'no-records-required',
      provider: input.provider,
      expiresAt: '2026-08-09T16:10:00.000Z',
      records: Object.freeze([]),
      payload: input.payload,
    }),
});

const executionProvider = (
  execute: AgentExecutionProvider['execute'],
): AgentExecutionProvider =>
  Object.freeze({
    execute: async (request: AgentProviderRequest) => {
      await request.beforeModelDispatch?.();
      await request.onModelDispatch?.();
      return execute(request);
    },
  });

const localFeatureProbe = Object.freeze({
  verifyOperational: async () => {
    const result = sumCadMinorUnits([12_345, 67_890]);
    return result.status === 'calculated' && result.money.minorUnits === 80_235;
  },
});

describe('real AgentOrchestrator eval path', () => {
  it('passes central orchestration cases through the production runner and local trace adapter', async () => {
    const cases = [
      evalCase('route-scheduler-intent'),
      evalCase('independent-three-specialists-parallel'),
      evalCase('dependent-cross-domain-waves'),
      evalCase('partial-specialist-failure'),
    ];
    const byRunId = new Map(cases.map((item) => [item.turn.runId, item.id]));
    let active = 0;
    let maximumActive = 0;
    const lifecycle: string[] = [];
    const execute: AgentExecutionProvider['execute'] = async (
      request: AgentProviderRequest,
    ) => {
      const caseId = byRunId.get(request.context.runId);
      if (caseId === undefined) throw new Error('unknown integration run');
      if (request.phase === 'plan') {
        const delegations =
          caseId === 'route-scheduler-intent'
            ? [
                {
                  id: 'scheduler',
                  specialistId: 'scheduler',
                  input: { request: 'Run the scheduler eval.' },
                  dependsOn: [],
                },
              ]
            : caseId === 'dependent-cross-domain-waves'
              ? [
                  {
                    id: 'scheduler-plan',
                    specialistId: 'scheduler',
                    input: { request: 'Run the scheduler eval.' },
                    dependsOn: [],
                  },
                  {
                    id: 'shopping-plan',
                    specialistId: 'shopping',
                    input: { request: 'Run the shopping eval.' },
                    dependsOn: ['scheduler-plan'],
                  },
                ]
              : ['scheduler', 'finance', 'shopping'].map((specialistId) => ({
                  id: specialistId,
                  specialistId,
                  input: { request: `Run the ${specialistId} eval.` },
                  dependsOn: [],
                }));
        return completed({ delegations });
      }
      if (request.phase === 'specialist') {
        const input = request.input as {
          readonly delegation: {
            readonly id: string;
            readonly specialistId: string;
          };
        };
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        lifecycle.push(`start:${caseId}:${input.delegation.id}`);
        await new Promise((resolve) => setTimeout(resolve, 4));
        active -= 1;
        if (
          caseId === 'partial-specialist-failure' &&
          input.delegation.specialistId === 'finance'
        ) {
          throw new Error('database password must remain redacted');
        }
        lifecycle.push(`finish:${caseId}:${input.delegation.id}`);
        return completed(
          managerOutput(`${input.delegation.specialistId} eval completed.`),
        );
      }
      return completed(
        managerOutput('The requested specialist work completed.'),
      );
    };
    let traceNumber = 0;
    const traces = new TraceBuffer();
    const traceRecorder = new LocalTraceRecorder(
      traces,
      () => new Date('2026-08-09T16:00:00.000Z'),
      () => `trace-real-eval-${String(++traceNumber).padStart(2, '0')}`,
    );
    const orchestrator = new AgentOrchestrator({
      manager: compiledAgent('manager'),
      specialists: [
        compiledAgent('scheduler'),
        compiledAgent('finance'),
        compiledAgent('shopping'),
      ],
      executionProvider: executionProvider(execute),
      modelRouter: {
        resolve: async ({ triggers }): Promise<ModelResolution> => {
          const dependent = triggers.includes('dependent-cross-domain');
          return Object.freeze({
            status: 'resolved',
            requestedModel: dependent ? 'gpt-5.6-terra' : 'gpt-5.6-luna',
            resolvedModel: dependent ? 'gpt-5.6-terra' : 'gpt-5.6-luna',
            reason: dependent ? 'dependent-cross-domain' : 'default',
          });
        },
      },
      memory: {
        retrieveForManager: async () => Object.freeze({ entries: [] }),
        appendManagerMessage: async () => undefined,
      },
      traceRecorder,
      approvalCheckpoints: {
        create: async () => {
          throw new Error('approval not expected');
        },
        consumeForResume: async () => ({ status: 'not-found' as const }),
        cancel: checkpointCancellationNotExpected,
      },
      proposalGateway: rejectingProposalGateway,
      disclosureGateway: defaultDisclosureGateway,
      agentGraphHash: 'a'.repeat(64),
      sdkVersion: '0.14.3',
      clock: () => new Date('2026-08-09T16:00:00.000Z'),
    });
    const runner = createAgentEvalRunner({
      driver: createAgentOrchestratorEvalDriver({
        orchestrator,
        traces,
        localFeatures: localFeatureProbe,
      }),
    });

    const report = await runner.runSuite(cases);

    expect(report.summary).toEqual({ total: 4, passed: 4, failed: 0 });
    expect(maximumActive).toBe(3);
    expect(
      lifecycle.indexOf('start:dependent-cross-domain-waves:shopping-plan'),
    ).toBeGreaterThan(
      lifecycle.indexOf('finish:dependent-cross-domain-waves:scheduler-plan'),
    );
    expect(JSON.stringify(report)).not.toContain('database password');
  });

  it('passes Luna fallback and fail-closed model cases through the production runner', async () => {
    const cases = [
      evalCase('luna-unavailable-terra-fallback'),
      evalCase('required-terra-unavailable'),
      evalCase('dual-model-unavailable'),
    ];
    const results = [];

    for (const item of cases) {
      const availability = item.fixture.modelAvailability as Readonly<
        Record<EmdoModelId, boolean>
      >;
      const traces = new TraceBuffer();
      const orchestrator = new AgentOrchestrator({
        manager: compiledAgent('manager'),
        specialists: [
          compiledAgent('scheduler'),
          compiledAgent('finance'),
          compiledAgent('shopping'),
        ],
        executionProvider: executionProvider(async (request) => {
          if (request.phase === 'synthesize') {
            return completed(managerOutput('Local summary ready.'));
          }
          if (request.phase !== 'plan') {
            throw new Error('unexpected model-policy eval phase');
          }
          return completed({
            delegations: [],
            directResponse: managerOutput('Local summary ready.'),
          });
        }),
        modelRouter: new ModelRouter(
          new InMemoryModelAvailability(availability),
        ),
        memory: {
          retrieveForManager: async () => Object.freeze({ entries: [] }),
          appendManagerMessage: async () => undefined,
        },
        traceRecorder: new LocalTraceRecorder(
          traces,
          () => new Date('2026-08-09T16:00:00.000Z'),
          () => `trace-model-policy-${item.id}`,
        ),
        approvalCheckpoints: {
          create: async () => {
            throw new Error('approval not expected');
          },
          consumeForResume: async () => ({ status: 'not-found' as const }),
          cancel: checkpointCancellationNotExpected,
        },
        proposalGateway: rejectingProposalGateway,
        disclosureGateway: defaultDisclosureGateway,
        agentGraphHash: 'b'.repeat(64),
        sdkVersion: '0.14.3',
        clock: () => new Date('2026-08-09T16:00:00.000Z'),
      });
      results.push(
        await createAgentEvalRunner({
          driver: createAgentOrchestratorEvalDriver({
            orchestrator,
            traces,
            localFeatures: localFeatureProbe,
          }),
        }).runCase(item),
      );
    }

    expect(results.map((result) => [result.caseId, result.passed])).toEqual(
      cases.map((item) => [item.id, true]),
    );
  });

  it('enforces exact disclosure scope, cross-run denial, and dispatch-time expiry through the production runner', async () => {
    const cases = [
      evalCase('one-run-field-scoped-disclosure'),
      evalCase('cross-run-disclosure-reuse-denied'),
      evalCase('disclosure-expires-before-model-dispatch'),
    ];

    for (const item of cases) {
      let currentTimeMs = Date.parse(EVAL_NOW);
      let traceNumber = 0;
      let financeProviderInvocations = 0;
      let financeModelIoCalls = 0;
      const traces = new TraceBuffer();
      const fixture =
        item.id === 'disclosure-expires-before-model-dispatch'
          ? expiringDisclosureFixture
          : disclosureFixture;
      const filteredSpecialistPayload = Object.freeze({
        delegation: Object.freeze({
          id: 'finance-disclosure',
          specialistId: 'finance',
          input: Object.freeze({
            request:
              'merchant=Example Market amount-cad-minor=1234 posted-at=2026-08-08',
          }),
          dependsOn: Object.freeze([]),
        }),
        dependencyOutcomes: Object.freeze([]),
      });
      const disclosureGateway: ModelDisclosureGateway = Object.freeze({
        authorize: async (
          input: Parameters<ModelDisclosureGateway['authorize']>[0],
        ) => {
          if (input.agentId === 'manager') {
            expect(input.requestedGrantId).toBeUndefined();
            return Object.freeze({
              status: 'authorized' as const,
              grantId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f399',
              grantVersion: '1.0.0',
              runId: input.runId,
              householdId: input.householdId,
              userId: input.userId,
              agentId: input.agentId,
              phasePurpose: input.phasePurpose,
              disclosurePurpose: 'manager-orchestration-no-private-records',
              provider: input.provider,
              expiresAt: '2026-08-09T16:10:00.000Z',
              records: Object.freeze([]),
              payload: input.payload,
            });
          }
          expect(input).toMatchObject({
            runId: item.turn.runId,
            householdId: item.turn.householdId,
            userId: item.turn.userId,
            agentId: 'finance',
            phasePurpose: 'specialist-execution',
            provider: 'openai',
            requestedGrantId: fixture.grantId,
            requestedDataClasses: [
              'conversation.messages',
              'finance.transactions',
            ],
          });
          if (item.id === 'cross-run-disclosure-reuse-denied') {
            return Object.freeze({
              status: 'denied' as const,
              grantId: fixture.grantId,
              reason: 'grant-run-mismatch' as const,
            });
          }
          return Object.freeze({
            status: 'authorized' as const,
            grantId: fixture.grantId,
            grantVersion: fixture.grantVersion,
            runId: item.turn.runId,
            householdId: item.turn.householdId,
            userId: item.turn.userId,
            agentId: fixture.agentId,
            phasePurpose: fixture.phasePurpose,
            disclosurePurpose: fixture.purpose,
            provider: 'openai' as const,
            expiresAt: fixture.expiresAt,
            records: Object.freeze([
              Object.freeze({
                dataClass: fixture.dataClass,
                recordId: fixture.recordId,
                fields: fixture.fields,
              }),
            ]),
            payload: filteredSpecialistPayload,
          });
        },
      });
      const orchestrator = new AgentOrchestrator({
        manager: compiledAgent('manager'),
        specialists: [
          compiledAgent('scheduler'),
          compiledAgent('finance'),
          compiledAgent('shopping'),
        ],
        executionProvider: {
          execute: async (request) => {
            if (request.phase === 'specialist') {
              financeProviderInvocations += 1;
              if (item.id === 'disclosure-expires-before-model-dispatch') {
                currentTimeMs = Date.parse(fixture.expiresAt) + 1;
              }
            }
            await request.beforeModelDispatch?.();
            if (request.phase === 'specialist') financeModelIoCalls += 1;
            await request.onModelDispatch?.();
            if (request.phase === 'plan') {
              return completed({
                delegations: [
                  {
                    id: 'finance-disclosure',
                    specialistId: 'finance',
                    input: {
                      request:
                        'merchant=Example Market amount-cad-minor=1234 posted-at=2026-08-08 account-number=must-not-reach-model',
                    },
                    dependsOn: [],
                  },
                ],
              });
            }
            if (request.phase === 'specialist') {
              expect(request.context).toMatchObject({
                disclosureGrantId: fixture.grantId,
                disclosureGrantVersion: fixture.grantVersion,
                agentId: 'finance',
              });
              expect(request.input).toEqual(filteredSpecialistPayload);
              expect(JSON.stringify(request.input)).not.toContain(
                'account-number',
              );
              return completed(
                managerOutput('The transaction category was suggested.'),
              );
            }
            return completed(
              managerOutput('The disclosure-scoped request completed.'),
            );
          },
        },
        modelRouter: new ModelRouter(
          new InMemoryModelAvailability({
            'gpt-5.6-luna': true,
            'gpt-5.6-terra': true,
          }),
        ),
        memory: {
          retrieveForManager: async () => Object.freeze({ entries: [] }),
          appendManagerMessage: async () => undefined,
        },
        traceRecorder: new LocalTraceRecorder(
          traces,
          () => new Date(currentTimeMs),
          () =>
            `trace-real-disclosure-${item.id}-${String(++traceNumber).padStart(2, '0')}`,
        ),
        approvalCheckpoints: {
          create: async () => {
            throw new Error('approval not expected');
          },
          consumeForResume: async () => ({ status: 'not-found' as const }),
          cancel: checkpointCancellationNotExpected,
        },
        proposalGateway: rejectingProposalGateway,
        disclosureGateway,
        agentGraphHash: 'e'.repeat(64),
        sdkVersion: '0.14.3',
        clock: () => new Date(currentTimeMs),
      });

      const result = await createAgentEvalRunner({
        driver: createAgentOrchestratorEvalDriver({
          orchestrator,
          traces,
          localFeatures: localFeatureProbe,
        }),
      }).runCase(item);

      expect(result.failures, `${item.id}: ${JSON.stringify(result)}`).toEqual(
        [],
      );
      expect(result.passed, item.id).toBe(true);
      if (item.id === 'one-run-field-scoped-disclosure') {
        expect(financeProviderInvocations).toBe(1);
        expect(financeModelIoCalls).toBe(1);
      } else if (item.id === 'cross-run-disclosure-reuse-denied') {
        expect(financeProviderInvocations).toBe(0);
        expect(financeModelIoCalls).toBe(0);
      } else {
        expect(financeProviderInvocations).toBe(1);
        expect(financeModelIoCalls).toBe(0);
      }
    }
  });

  it('requires separate turns for multiple provider writes before checkpoint or action dispatch', async () => {
    const item = evalCase('multiple-provider-writes-require-separate-turns');
    const traces = new TraceBuffer();
    const providerPhases: string[] = [];
    let checkpointCreates = 0;
    let decisionExecutions = 0;
    let proposalAbandonments = 0;
    let proposalPreparations = 0;
    let providerActionExecutions = 0;
    let modelIoCalls = 0;
    const providerAuthorityBindingHash = 'a'.repeat(64);
    const abandonmentInputs: Parameters<
      ProviderWriteProposalGateway['abandonPrepared']
    >[0][] = [];
    const proposalGateway: ProviderWriteProposalGateway = Object.freeze({
      prepare: async (
        input: Parameters<ProviderWriteProposalGateway['prepare']>[0],
      ) => {
        proposalPreparations += 1;
        expect(input).toMatchObject({
          capabilityId: multipleCalendarWriteFixture.capabilityId,
          sdkCallId: 'call-calendar-first',
          canonicalArguments: { request: 'Dentist' },
          context: {
            runId: item.turn.runId,
            householdId: item.turn.householdId,
            userId: item.turn.userId,
            authenticatedSessionId: item.turn.authenticatedSessionId,
            authorizationScopeFingerprint:
              item.turn.authorizationScopeFingerprint,
            agentId: 'scheduler',
          },
        });
        return Object.freeze({
          proposalId: multipleCalendarWriteFixture.firstProposalId,
          providerAuthorityBindingHash,
          authorizationScopeFingerprint:
            item.turn.authorizationScopeFingerprint,
          preview: Object.freeze({
            before: null,
            after: Object.freeze({ title: 'Dentist' }),
          }),
        });
      },
      resolvePrepared: async () => undefined,
      abandonPrepared: async (
        input: Parameters<ProviderWriteProposalGateway['abandonPrepared']>[0],
      ) => {
        proposalAbandonments += 1;
        abandonmentInputs.push(input);
        return Object.freeze({ status: 'abandoned' as const });
      },
      validateDecision: async () => false,
      executeDecision: async () => {
        decisionExecutions += 1;
        throw new Error('multiple writes must not execute');
      },
    });
    const scheduler = compiledSdkScheduler(proposalGateway, async () => {
      providerActionExecutions += 1;
      throw new Error('provider write must not dispatch before approval');
    });
    const sdkRunner: OpenAiAgentsRunnerPort = Object.freeze({
      run: async (
        sdkAgent: Parameters<OpenAiAgentsRunnerPort['run']>[0],
        _input: Parameters<OpenAiAgentsRunnerPort['run']>[1],
        options: Parameters<OpenAiAgentsRunnerPort['run']>[2],
      ) => {
        modelIoCalls += 1;
        const functionTool = sdkAgent.tools[0];
        if (functionTool?.type !== 'function') {
          throw new Error('expected provider-write function tool');
        }
        const runContext = Object.freeze({ context: options.context });
        await functionTool.needsApproval(
          runContext as never,
          { request: 'Dentist' },
          'call-calendar-first',
        );
        await functionTool.needsApproval(
          runContext as never,
          { request: 'Optometrist' },
          'call-calendar-second',
        );
        throw new Error('second write must stop the SDK run');
      },
    });
    const sdkProvider = new OpenAiAgentsExecutionProvider({
      proposalGateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: acceptingSpendGuard,
      inputTokenCounter: { countUpperBound: () => 1 },
      runner: sdkRunner,
    });
    const orchestrator = new AgentOrchestrator({
      manager: compiledAgent('manager'),
      specialists: [
        scheduler,
        compiledAgent('finance'),
        compiledAgent('shopping'),
      ],
      executionProvider: {
        execute: async (request) => {
          providerPhases.push(request.phase);
          if (request.phase === 'specialist') {
            return sdkProvider.execute(request);
          }
          await request.beforeModelDispatch?.();
          await request.onModelDispatch?.();
          if (request.phase === 'plan') {
            return completed({
              delegations: [
                {
                  id: 'two-calendar-writes',
                  specialistId: 'scheduler',
                  input: { request: 'Create two calendar events.' },
                  dependsOn: [],
                },
              ],
            });
          }
          return completed(
            managerOutput(
              'Create and approve one calendar event in a new turn.',
            ),
          );
        },
      },
      modelRouter: new ModelRouter(
        new InMemoryModelAvailability({
          'gpt-5.6-luna': true,
          'gpt-5.6-terra': true,
        }),
      ),
      memory: {
        retrieveForManager: async () => Object.freeze({ entries: [] }),
        appendManagerMessage: async () => undefined,
      },
      traceRecorder: new LocalTraceRecorder(
        traces,
        () => new Date(EVAL_NOW),
        () => 'trace-real-multiple-provider-writes',
      ),
      approvalCheckpoints: {
        create: async () => {
          checkpointCreates += 1;
          throw new Error('multiple writes must not create a checkpoint');
        },
        consumeForResume: async () => ({ status: 'not-found' as const }),
        cancel: checkpointCancellationNotExpected,
      },
      proposalGateway,
      disclosureGateway: defaultDisclosureGateway,
      agentGraphHash: 'f'.repeat(64),
      sdkVersion: '0.14.3',
      clock: () => new Date(EVAL_NOW),
    });

    const result = await createAgentEvalRunner({
      driver: createAgentOrchestratorEvalDriver({
        orchestrator,
        traces,
        localFeatures: localFeatureProbe,
      }),
    }).runCase(item);

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(providerPhases).toEqual(['plan', 'specialist']);
    expect(checkpointCreates).toBe(0);
    expect(decisionExecutions).toBe(0);
    expect(proposalPreparations).toBe(1);
    expect(proposalAbandonments).toBe(1);
    expect(providerActionExecutions).toBe(0);
    expect(modelIoCalls).toBe(1);
    expect(abandonmentInputs).toEqual([
      {
        proposalId: multipleCalendarWriteFixture.firstProposalId,
        capabilityId: multipleCalendarWriteFixture.capabilityId,
        sdkCallId: 'call-calendar-first',
        providerAuthorityBindingHash,
        reason: 'multiple-provider-writes-require-separate-turns',
        scope: {
          authenticatedSessionId: item.turn.authenticatedSessionId,
          requestId: item.turn.requestId,
          runId: item.turn.runId,
          householdId: item.turn.householdId,
          userId: item.turn.userId,
          spaceAccessGrantId: item.turn.spaceAccessGrantId,
          disclosureGrantId: disclosureFixture.grantId,
          disclosurePolicyVersion: disclosureFixture.grantVersion,
          agentId: 'scheduler',
        },
      },
    ]);
    expect(result.phases.flatMap(({ events }) => events)).not.toContainEqual(
      expect.objectContaining({ type: 'approval-interrupted' }),
    );
    expect(result.phases.flatMap(({ events }) => events)).not.toContainEqual(
      expect.objectContaining({ type: 'action-executed' }),
    );
  });

  it('fails the whole turn when parallel delegations each attempt a provider write', async () => {
    const item = evalCase('multiple-provider-writes-require-separate-turns');
    const traces = new TraceBuffer();
    const providerAuthorityBindingHash = 'b'.repeat(64);
    let proposalPreparations = 0;
    let proposalAbandonments = 0;
    let providerActionExecutions = 0;
    let checkpointCreates = 0;
    let runnerCalls = 0;
    let releaseSecond: (() => void) | undefined;
    const secondBarrier = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const proposalGateway: ProviderWriteProposalGateway = Object.freeze({
      prepare: async () => {
        proposalPreparations += 1;
        return Object.freeze({
          proposalId: multipleCalendarWriteFixture.firstProposalId,
          providerAuthorityBindingHash,
          authorizationScopeFingerprint:
            item.turn.authorizationScopeFingerprint,
          preview: Object.freeze({
            before: null,
            after: Object.freeze({ title: 'Dentist' }),
          }),
        });
      },
      resolvePrepared: async () => undefined,
      abandonPrepared: async (
        input: Parameters<ProviderWriteProposalGateway['abandonPrepared']>[0],
      ) => {
        proposalAbandonments += 1;
        expect(input).toMatchObject({
          proposalId: multipleCalendarWriteFixture.firstProposalId,
          capabilityId: multipleCalendarWriteFixture.capabilityId,
          sdkCallId: 'call-calendar-parallel-first',
          providerAuthorityBindingHash,
          reason: 'multiple-provider-writes-require-separate-turns',
          scope: {
            requestId: item.turn.requestId,
            runId: item.turn.runId,
            householdId: item.turn.householdId,
            userId: item.turn.userId,
            spaceAccessGrantId: item.turn.spaceAccessGrantId,
            disclosureGrantId: disclosureFixture.grantId,
            agentId: 'scheduler',
          },
        });
        return Object.freeze({ status: 'abandoned' as const });
      },
      validateDecision: async () => false,
      executeDecision: async () => {
        throw new Error('parallel writes must not execute');
      },
    });
    const scheduler = compiledSdkScheduler(proposalGateway, async () => {
      providerActionExecutions += 1;
      throw new Error('provider write must not dispatch before approval');
    });
    const sdkRunner: OpenAiAgentsRunnerPort = Object.freeze({
      run: async (
        sdkAgent: Parameters<OpenAiAgentsRunnerPort['run']>[0],
        _input: Parameters<OpenAiAgentsRunnerPort['run']>[1],
        options: Parameters<OpenAiAgentsRunnerPort['run']>[2],
      ) => {
        runnerCalls += 1;
        const currentCall = runnerCalls;
        const functionTool = sdkAgent.tools[0];
        if (functionTool?.type !== 'function') {
          throw new Error('expected provider-write function tool');
        }
        if (currentCall === 2) await secondBarrier;
        const callId =
          currentCall === 1
            ? 'call-calendar-parallel-first'
            : 'call-calendar-parallel-second';
        await functionTool.needsApproval(
          Object.freeze({ context: options.context }) as never,
          {
            request: currentCall === 1 ? 'Dentist' : 'Optometrist',
          },
          callId,
        );
        if (currentCall === 1) releaseSecond?.();
        const state = Object.freeze({
          usage: Object.freeze({ inputTokens: 10, outputTokens: 2 }),
          getInterruptions: () => [],
          approve: () => undefined,
          reject: () => undefined,
          toString: () => JSON.stringify({ sdk: callId }),
        });
        return Object.freeze({
          state,
          interruptions: Object.freeze([
            Object.freeze({
              agent: sdkAgent,
              arguments: JSON.stringify({ request: 'Dentist' }),
              name: 'google_calendar_event_create',
              rawItem: Object.freeze({
                type: 'function_call' as const,
                callId,
                name: 'google_calendar_event_create',
                arguments: JSON.stringify({ request: 'Dentist' }),
              }),
            }),
          ]),
        });
      },
    });
    const sdkProvider = new OpenAiAgentsExecutionProvider({
      proposalGateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: acceptingSpendGuard,
      inputTokenCounter: { countUpperBound: () => 1 },
      runner: sdkRunner,
    });
    const orchestrator = new AgentOrchestrator({
      manager: compiledAgent('manager'),
      specialists: [
        scheduler,
        compiledAgent('finance'),
        compiledAgent('shopping'),
      ],
      executionProvider: {
        execute: async (request) => {
          if (request.phase === 'specialist') {
            return sdkProvider.execute(request);
          }
          await request.beforeModelDispatch?.();
          await request.onModelDispatch?.();
          if (request.phase === 'plan') {
            return completed({
              delegations: [
                {
                  id: 'calendar-write-first',
                  specialistId: 'scheduler',
                  input: { request: 'Create the dentist event.' },
                  dependsOn: [],
                },
                {
                  id: 'calendar-write-second',
                  specialistId: 'scheduler',
                  input: { request: 'Create the optometrist event.' },
                  dependsOn: [],
                },
              ],
            });
          }
          throw new Error('multi-write turn must not synthesize');
        },
      },
      modelRouter: new ModelRouter(
        new InMemoryModelAvailability({
          'gpt-5.6-luna': true,
          'gpt-5.6-terra': true,
        }),
      ),
      memory: {
        retrieveForManager: async () => Object.freeze({ entries: [] }),
        appendManagerMessage: async () => undefined,
      },
      traceRecorder: new LocalTraceRecorder(
        traces,
        () => new Date(EVAL_NOW),
        () => 'trace-real-parallel-provider-writes',
      ),
      approvalCheckpoints: {
        create: async () => {
          checkpointCreates += 1;
          throw new Error('parallel writes must not create a checkpoint');
        },
        consumeForResume: async () => ({ status: 'not-found' as const }),
        cancel: checkpointCancellationNotExpected,
      },
      proposalGateway,
      disclosureGateway: defaultDisclosureGateway,
      agentGraphHash: '9'.repeat(64),
      sdkVersion: '0.14.3',
      clock: () => new Date(EVAL_NOW),
    });

    const result = await orchestrator.runTurn({
      ...item.turn,
      abortSignal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'failed',
      safeError: {
        code: 'multiple-provider-writes-require-separate-turns',
        retryable: false,
      },
    });
    expect(result.specialistOutcomes).toHaveLength(2);
    expect(
      result.specialistOutcomes.every(
        (outcome) =>
          outcome.status === 'failed' &&
          outcome.safeError?.code ===
            'multiple-provider-writes-require-separate-turns',
      ),
    ).toBe(true);
    expect(proposalPreparations).toBe(1);
    expect(proposalAbandonments).toBe(1);
    expect(providerActionExecutions).toBe(0);
    expect(checkpointCreates).toBe(0);
    expect(runnerCalls).toBe(2);
    expect(
      traces
        .take(result.localTraceReference)
        .filter(
          ({ type }) =>
            type === 'approval.interrupted' || type === 'action.executed',
        ),
    ).toEqual([]);
  });

  it('cancels the checkpoint and abandons the proposal when interruption audit persistence fails', async () => {
    const item = evalCase('calendar-write-authenticated-visual-resume');
    const bufferedTraces = new TraceBuffer();
    let failedAuditWrites = 0;
    const failingTraceSink: LocalTraceSink = Object.freeze({
      append: async (event: LocalTraceEvent) => {
        if (event.type === 'approval.interrupted') {
          failedAuditWrites += 1;
          throw new Error('audit persistence unavailable');
        }
        await bufferedTraces.append(event);
      },
    });
    const clock = () => new Date(EVAL_NOW);
    const cipher = new AesGcmApprovalCheckpointCipher({
      activeKeyId: 'eval-v1',
      keys: { 'eval-v1': new Uint8Array(32).fill(9) },
    });
    const checkpointService = new ApprovalCheckpointService(
      new InMemoryApprovalCheckpointRepository(clock),
      cipher,
      clock,
    );
    let checkpointCreates = 0;
    let checkpointCancellations = 0;
    let proposalPreparations = 0;
    let proposalAbandonments = 0;
    let providerActionExecutions = 0;
    const providerAuthorityBindingHash = 'c'.repeat(64);
    const preparedProposal = Object.freeze({
      proposalId: calendarApprovalFixture.proposalId,
      providerAuthorityBindingHash,
      authorizationScopeFingerprint: item.turn.authorizationScopeFingerprint,
      preview: Object.freeze({
        before: null,
        after: Object.freeze({ title: 'Dentist' }),
      }),
    });
    const proposalGateway: ProviderWriteProposalGateway = Object.freeze({
      prepare: async () => {
        proposalPreparations += 1;
        return preparedProposal;
      },
      resolvePrepared: async () => preparedProposal,
      abandonPrepared: async (
        input: Parameters<ProviderWriteProposalGateway['abandonPrepared']>[0],
      ) => {
        proposalAbandonments += 1;
        expect(input).toMatchObject({
          proposalId: calendarApprovalFixture.proposalId,
          capabilityId: calendarApprovalFixture.capabilityId,
          sdkCallId: 'call-calendar-audit-failure',
          providerAuthorityBindingHash,
          reason: 'execution-ended-before-checkpoint',
          scope: {
            requestId: item.turn.requestId,
            runId: item.turn.runId,
            householdId: item.turn.householdId,
            userId: item.turn.userId,
            spaceAccessGrantId: item.turn.spaceAccessGrantId,
            disclosureGrantId: disclosureFixture.grantId,
            agentId: 'scheduler',
          },
        });
        return Object.freeze({ status: 'abandoned' as const });
      },
      validateDecision: async () => false,
      executeDecision: async () => {
        throw new Error('cancelled proposal must not execute');
      },
    });
    const scheduler = compiledSdkScheduler(proposalGateway, async () => {
      providerActionExecutions += 1;
      throw new Error('provider write must not dispatch before approval');
    });
    const sdkRunner: OpenAiAgentsRunnerPort = Object.freeze({
      run: async (
        sdkAgent: Parameters<OpenAiAgentsRunnerPort['run']>[0],
        _input: Parameters<OpenAiAgentsRunnerPort['run']>[1],
        options: Parameters<OpenAiAgentsRunnerPort['run']>[2],
      ) => {
        const functionTool = sdkAgent.tools[0];
        if (functionTool?.type !== 'function') {
          throw new Error('expected provider-write function tool');
        }
        const callId = 'call-calendar-audit-failure';
        await functionTool.needsApproval(
          Object.freeze({ context: options.context }) as never,
          { request: 'Dentist' },
          callId,
        );
        const approval = Object.freeze({
          agent: sdkAgent,
          arguments: JSON.stringify({ request: 'Dentist' }),
          name: 'google_calendar_event_create',
          rawItem: Object.freeze({
            type: 'function_call' as const,
            callId,
            name: 'google_calendar_event_create',
            arguments: JSON.stringify({ request: 'Dentist' }),
          }),
        });
        return Object.freeze({
          state: Object.freeze({
            usage: Object.freeze({ inputTokens: 10, outputTokens: 2 }),
            getInterruptions: () => [approval],
            approve: () => undefined,
            reject: () => undefined,
            toString: () => JSON.stringify({ sdk: callId }),
          }),
          interruptions: Object.freeze([approval]),
        });
      },
    });
    const sdkProvider = new OpenAiAgentsExecutionProvider({
      proposalGateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: acceptingSpendGuard,
      inputTokenCounter: { countUpperBound: () => 1 },
      runner: sdkRunner,
    });
    const graphHash = '8'.repeat(64);
    const orchestrator = new AgentOrchestrator({
      manager: compiledAgent('manager'),
      specialists: [
        scheduler,
        compiledAgent('finance'),
        compiledAgent('shopping'),
      ],
      executionProvider: {
        execute: async (request) => {
          if (request.phase === 'specialist') {
            return sdkProvider.execute(request);
          }
          await request.beforeModelDispatch?.();
          await request.onModelDispatch?.();
          if (request.phase === 'plan') {
            return completed({
              delegations: [
                {
                  id: 'calendar-write',
                  specialistId: 'scheduler',
                  input: { request: 'Create the dentist event.' },
                  dependsOn: [],
                },
              ],
            });
          }
          throw new Error('failed approval audit must not synthesize');
        },
      },
      modelRouter: new ModelRouter(
        new InMemoryModelAvailability({
          'gpt-5.6-luna': true,
          'gpt-5.6-terra': true,
        }),
      ),
      memory: {
        retrieveForManager: async () => Object.freeze({ entries: [] }),
        appendManagerMessage: async () => undefined,
      },
      traceRecorder: new LocalTraceRecorder(
        failingTraceSink,
        clock,
        () => 'trace-real-approval-audit-failure',
      ),
      approvalCheckpoints: {
        create: async (input) => {
          checkpointCreates += 1;
          return checkpointService.create(input);
        },
        consumeForResume: (identity, validate) =>
          checkpointService.consumeForResume(identity, validate),
        cancel: async (input) => {
          checkpointCancellations += 1;
          expect(input).toEqual({
            checkpointId: calendarApprovalFixture.checkpointId,
            householdId: item.turn.householdId,
            userId: item.turn.userId,
          });
          return checkpointService.cancel(input);
        },
      },
      proposalGateway,
      disclosureGateway: defaultDisclosureGateway,
      agentGraphHash: graphHash,
      sdkVersion: '0.14.3',
      createCheckpointId: () => calendarApprovalFixture.checkpointId,
      checkpointTtlMs: 600_000,
      clock,
    });

    try {
      const result = await orchestrator.runTurn({
        ...item.turn,
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: 'failed',
        safeError: {
          code: 'approval-interruption-audit-failed',
          retryable: false,
        },
      });
      expect(checkpointCreates).toBe(1);
      expect(failedAuditWrites).toBe(1);
      expect(checkpointCancellations).toBe(1);
      expect(proposalPreparations).toBe(1);
      expect(proposalAbandonments).toBe(1);
      expect(providerActionExecutions).toBe(0);
      await expect(
        checkpointService.consumeForResume({
          checkpointId: calendarApprovalFixture.checkpointId,
          householdId: item.turn.householdId,
          userId: item.turn.userId,
          runId: item.turn.runId,
          agentGraphHash: graphHash,
          sdkVersion: '0.14.3',
        }),
      ).resolves.toEqual({ status: 'already-consumed' });
      expect(
        bufferedTraces
          .take(result.localTraceReference)
          .filter(
            ({ type }) =>
              type === 'approval.interrupted' || type === 'action.executed',
          ),
      ).toEqual([]);
    } finally {
      cipher.dispose();
    }
  });

  it('persists and resumes the exact approved proposal through the production runner', async () => {
    const item = evalCase('calendar-write-authenticated-visual-resume');
    const traces = new TraceBuffer();
    let traceNumber = 0;
    let currentTimeMs = Date.parse(EVAL_NOW);
    const clock = () => new Date(currentTimeMs);
    const traceRecorder = new LocalTraceRecorder(
      traces,
      clock,
      () => `trace-real-approval-${String(++traceNumber).padStart(2, '0')}`,
    );
    const cipher = new AesGcmApprovalCheckpointCipher({
      activeKeyId: 'eval-v1',
      keys: { 'eval-v1': new Uint8Array(32).fill(7) },
    });
    const checkpoints = new ApprovalCheckpointService(
      new InMemoryApprovalCheckpointRepository(clock),
      cipher,
      clock,
    );
    const phases: string[] = [];
    let decisionValidations = 0;
    let decisionExecutions = 0;
    const scheduler = compiledSdkScheduler(
      rejectingProposalGateway,
      async () => {
        throw new Error('approved action uses the decision gateway');
      },
    );
    const execute: AgentExecutionProvider['execute'] = async (request) => {
      phases.push(request.phase);
      if (request.phase === 'plan') {
        return completed({
          delegations: [
            {
              id: 'calendar-write',
              specialistId: 'scheduler',
              input: { request: 'Create the dentist appointment proposal.' },
              dependsOn: [],
            },
          ],
        });
      }
      if (request.phase === 'specialist') {
        return Object.freeze({
          status: 'interrupted' as const,
          serializedState: JSON.stringify({ sdk: 'pending-calendar-write' }),
          interruptions: Object.freeze([
            Object.freeze({
              id: 'approval-calendar-1',
              agentId: 'scheduler',
              capabilityId: calendarApprovalFixture.capabilityId,
              proposalId: calendarApprovalFixture.proposalId,
              sdkCallId: 'call-calendar-approved',
              providerAuthorityBindingHash: 'd'.repeat(64),
              authorizationScopeFingerprint:
                item.turn.authorizationScopeFingerprint,
              argumentsPreview: Object.freeze({
                proposalId: calendarApprovalFixture.proposalId,
                arguments: Object.freeze({ title: 'Dentist' }),
              }),
            }),
          ]),
          usage: Object.freeze({
            inputTokens: 10,
            outputTokens: 2,
            modelCostCadMinor: 1,
          }),
        });
      }
      if (request.phase === 'resume') {
        expect(request.context.approvalDecisionId).toBe(
          item.approvalDecision?.approvalDecisionId,
        );
        expect(request.resume).toMatchObject({
          serializedState: JSON.stringify({ sdk: 'pending-calendar-write' }),
          decision: {
            interruptionId: 'approval-calendar-1',
            decision: 'approve',
          },
        });
        return completed(managerOutput('The approved write was executed.'));
      }
      return completed(
        managerOutput('The approved calendar event was created.'),
      );
    };
    const orchestrator = new AgentOrchestrator({
      manager: compiledAgent('manager'),
      specialists: [
        scheduler,
        compiledAgent('finance'),
        compiledAgent('shopping'),
      ],
      executionProvider: executionProvider(execute),
      modelRouter: new ModelRouter(
        new InMemoryModelAvailability({
          'gpt-5.6-luna': true,
          'gpt-5.6-terra': true,
        }),
      ),
      memory: {
        retrieveForManager: async () => Object.freeze({ entries: [] }),
        appendManagerMessage: async () => undefined,
      },
      traceRecorder,
      approvalCheckpoints: checkpoints,
      proposalGateway: {
        ...rejectingProposalGateway,
        validateDecision: async (input) => {
          decisionValidations += 1;
          expect(input).toMatchObject({
            proposalId: calendarApprovalFixture.proposalId,
            approvalDecisionId: item.approvalDecision?.approvalDecisionId,
            capabilityId: calendarApprovalFixture.capabilityId,
            decision: 'approve',
            context: {
              runId: item.turn.runId,
              householdId: item.turn.householdId,
              userId: item.turn.userId,
              authenticatedSessionId: item.turn.authenticatedSessionId,
              authorizationScopeFingerprint:
                item.turn.authorizationScopeFingerprint,
              agentId: 'scheduler',
            },
          });
          currentTimeMs = Date.parse(item.approvalDecision!.decidedAt);
          return true;
        },
        executeDecision: async (input) => {
          decisionExecutions += 1;
          expect(input).toMatchObject({
            proposalId: calendarApprovalFixture.proposalId,
            approvalDecisionId: item.approvalDecision?.approvalDecisionId,
            capabilityId: calendarApprovalFixture.capabilityId,
            decision: 'approve',
            context: {
              runId: item.turn.runId,
              householdId: item.turn.householdId,
              userId: item.turn.userId,
              authenticatedSessionId: item.turn.authenticatedSessionId,
              authorizationScopeFingerprint:
                item.turn.authorizationScopeFingerprint,
              agentId: 'scheduler',
            },
          });
          return Object.freeze({
            outcome: 'executed-readback-verified' as const,
            output: managerOutput('The approved write was executed.'),
            idempotencyKey: calendarApprovalFixture.idempotencyKey,
          });
        },
      },
      disclosureGateway: defaultDisclosureGateway,
      agentGraphHash: 'c'.repeat(64),
      sdkVersion: '0.14.3',
      createCheckpointId: () => calendarApprovalFixture.checkpointId,
      checkpointTtlMs: 600_000,
      clock,
    });

    try {
      const result = await createAgentEvalRunner({
        driver: createAgentOrchestratorEvalDriver({
          orchestrator,
          traces,
          localFeatures: localFeatureProbe,
        }),
      }).runCase(item);

      expect(result.failures).toEqual([]);
      expect(result.passed).toBe(true);
      expect(phases).toEqual(['plan', 'specialist', 'synthesize']);
      expect(decisionValidations).toBe(1);
      expect(decisionExecutions).toBe(1);
      expect(JSON.stringify(result)).not.toContain('pending-calendar-write');
    } finally {
      cipher.dispose();
    }
  });

  it('rejects typed approval at the production resume boundary without executing the action', async () => {
    const item = evalCase('typed-yes-cannot-approve');
    const traces = new TraceBuffer();
    let traceNumber = 0;
    const clock = () => new Date('2026-08-09T16:00:00.000Z');
    const cipher = new AesGcmApprovalCheckpointCipher({
      activeKeyId: 'eval-v1',
      keys: { 'eval-v1': new Uint8Array(32).fill(8) },
    });
    const checkpoints = new ApprovalCheckpointService(
      new InMemoryApprovalCheckpointRepository(clock),
      cipher,
      clock,
    );
    const providerPhases: string[] = [];
    const scheduler = compiledSdkScheduler(
      rejectingProposalGateway,
      async () => {
        throw new Error('typed approval must not execute provider write');
      },
    );
    const orchestrator = new AgentOrchestrator({
      manager: compiledAgent('manager'),
      specialists: [
        scheduler,
        compiledAgent('finance'),
        compiledAgent('shopping'),
      ],
      executionProvider: executionProvider(async (request) => {
        providerPhases.push(request.phase);
        if (request.phase === 'plan') {
          return completed({
            delegations: [
              {
                id: 'calendar-write',
                specialistId: 'scheduler',
                input: { request: 'Create the dentist appointment.' },
                dependsOn: [],
              },
            ],
          });
        }
        if (request.phase === 'specialist') {
          return Object.freeze({
            status: 'interrupted' as const,
            serializedState: JSON.stringify({
              sdk: 'pending-calendar-write',
            }),
            interruptions: Object.freeze([
              Object.freeze({
                id: 'approval-calendar-typed',
                agentId: 'scheduler',
                capabilityId: calendarApprovalFixture.capabilityId,
                proposalId: calendarApprovalFixture.proposalId,
                sdkCallId: 'call-calendar-typed',
                providerAuthorityBindingHash: 'e'.repeat(64),
                authorizationScopeFingerprint:
                  item.turn.authorizationScopeFingerprint,
                argumentsPreview: Object.freeze({
                  proposalId: calendarApprovalFixture.proposalId,
                  arguments: Object.freeze({ title: 'Dentist' }),
                }),
              }),
            ]),
            usage: Object.freeze({
              inputTokens: 10,
              outputTokens: 2,
              modelCostCadMinor: 1,
            }),
          });
        }
        throw new Error('typed approval must not reach provider resume');
      }),
      modelRouter: new ModelRouter(
        new InMemoryModelAvailability({
          'gpt-5.6-luna': true,
          'gpt-5.6-terra': true,
        }),
      ),
      memory: {
        retrieveForManager: async () => Object.freeze({ entries: [] }),
        appendManagerMessage: async () => undefined,
      },
      traceRecorder: new LocalTraceRecorder(
        traces,
        clock,
        () =>
          `trace-real-typed-approval-${String(++traceNumber).padStart(2, '0')}`,
      ),
      approvalCheckpoints: checkpoints,
      proposalGateway: rejectingProposalGateway,
      disclosureGateway: defaultDisclosureGateway,
      agentGraphHash: 'd'.repeat(64),
      sdkVersion: '0.14.3',
      createCheckpointId: () => calendarApprovalFixture.checkpointId,
      checkpointTtlMs: 600_000,
      clock,
    });

    try {
      const driver = createAgentOrchestratorEvalDriver({
        orchestrator,
        untrustedApproval: {
          resumeTurn: (input) =>
            orchestrator.resumeTurn(
              input as unknown as Parameters<
                AgentOrchestrator['resumeTurn']
              >[0],
            ),
        },
        traces,
        localFeatures: localFeatureProbe,
      });
      const result = await createAgentEvalRunner({ driver }).runCase(item);

      expect(result.failures).toEqual([]);
      expect(result.passed).toBe(true);
      expect(providerPhases).toEqual(['plan', 'specialist']);
      expect(result.phases.flatMap(({ events }) => events)).not.toContainEqual(
        expect.objectContaining({ type: 'action-executed' }),
      );
    } finally {
      cipher.dispose();
    }
  });
});

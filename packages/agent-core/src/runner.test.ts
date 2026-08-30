import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';

import { parseProviderWriteCapabilityDescriptor } from '@emdo/contracts';

import {
  AesGcmApprovalCheckpointCipher,
  ApprovalCheckpointService,
  InMemoryApprovalCheckpointRepository,
} from './approval-state.js';
import type {
  AgentCapabilityReference,
  CompiledAgent,
  ResolvedAgentCapability,
  ValidatedAgentManifest,
} from './factory.js';
import type { ManagerConversationMemory } from './memory.js';
import type { ModelResolution } from './model-router.js';
import {
  AgentOrchestrator,
  type ApprovalCheckpointGateway,
  type AgentExecutionProvider,
  type AgentProviderRequest,
  type JsonValue,
  type ModelDisclosureAuthorization,
  type ModelDisclosureGateway,
  type ModelDisclosureSource,
  type ProviderWriteProposalGateway,
  type RegisteredSpecialistRuntimeDescriptor,
  type TurnInput,
} from './runner.js';
import { LocalTraceRecorder, type LocalTraceEvent } from './trace.js';

const ids = Object.freeze({
  requestId: '018f1f5e-1000-7000-8000-000000000001',
  runId: '018f1f5e-1000-7000-8000-000000000002',
  householdId: '018f1f5e-1000-7000-8000-000000000003',
  userId: '018f1f5e-1000-7000-8000-000000000004',
  authenticatedSessionId: '018f1f5e-1000-7000-8000-000000000008',
  conversationId: '018f1f5e-1000-7000-8000-000000000005',
  spaceAccessGrantId: '018f1f5e-1000-7000-8000-000000000006',
  authorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('e'.repeat(64)),
  disclosureGrantId: '018f1f5e-1000-7000-8000-000000000007',
  rootManagerInvocationId: '018f1f5e-1000-7000-8000-000000000009',
});

const graphHash = 'a'.repeat(64);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const providerAuthorityBindingHash = 'b'.repeat(64);
const sdkVersion = '0.14.3';
const proposalId = '018f1f5e-1000-7000-8000-000000000060';
const approvalDecisionId = '018f1f5e-1000-7000-8000-000000000061';
const resumeAuthority = Object.freeze({
  authenticatedSessionId: ids.authenticatedSessionId,
  collectionAuthorizationScopeFingerprint: ids.authorizationScopeFingerprint,
  authorizationScopeFingerprint: ids.authorizationScopeFingerprint,
  disclosureGrantId: ids.disclosureGrantId,
  disclosureGrantVersion: '1.0.0',
});

const agent = (
  id: string,
  kind: 'manager' | 'specialist',
  inputSchema: z.ZodObject = z.looseObject({}),
  outputSchema: z.ZodObject = z.looseObject({}),
  capabilities: readonly ResolvedAgentCapability[] = Object.freeze([]),
): CompiledAgent<Readonly<{ readonly id: string; readonly model: string }>> => {
  const manifest: ValidatedAgentManifest = Object.freeze({
    schemaVersion: 1,
    id,
    version: '1.0.0',
    kind,
    instructionIds: [`${id}.instructions.v1`],
    skillIds: ['privacy.v1'],
    capabilityAllowlist: [
      ...(kind === 'manager'
        ? [
            'agent.scheduler.delegate',
            'agent.finance.delegate',
            'agent.shopping.delegate',
          ]
        : capabilities.length === 0
          ? [`${id}.read`]
          : capabilities.map(({ descriptor }) => descriptor.id)),
    ],
    readableDataClasses:
      kind === 'manager'
        ? [
            'conversation.messages',
            'agent.manager-plans',
            'agent.specialist-outcomes',
          ]
        : ['agent.delegations', 'agent.specialist-outcomes', `${id}.records`],
    riskCeiling: kind === 'manager' ? 'none' : 'provider-write',
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
    capabilities: Object.freeze([...capabilities]),
    inputSchema,
    outputSchema,
    materialize: (model: 'gpt-5.6-luna' | 'gpt-5.6-terra') =>
      Object.freeze({ id, model }),
  });
};

const defaultResolution: ModelResolution = Object.freeze({
  status: 'resolved',
  requestedModel: 'gpt-5.6-luna',
  resolvedModel: 'gpt-5.6-luna',
  reason: 'default',
});

const completed = (output: JsonValue, replaySafety?: 'safe' | 'unsafe') =>
  Object.freeze({
    status: 'completed' as const,
    output,
    usage: Object.freeze({
      inputTokens: 10,
      outputTokens: 5,
      modelCostCadMinor: 1,
    }),
    ...(replaySafety === undefined ? {} : { replaySafety }),
  });

const failedProviderResult = (
  replaySafety: 'safe' | 'unsafe',
  reason: 'execution-failed' | 'timeout' = 'execution-failed',
) =>
  Object.freeze({
    status: 'failed' as const,
    reason,
    replaySafety,
    usage: Object.freeze({
      inputTokens: 0,
      outputTokens: 0,
      modelCostCadMinor: 0,
    }),
  });

const providerWriteCapabilityId = (id: string) =>
  parseProviderWriteCapabilityDescriptor({
    schemaVersion: 1,
    id,
    version: '1.0.0',
    capabilityKind: 'provider-write',
    inputSchema: { id: `${id}.input`, version: '1.0.0' },
    outputSchema: { id: `${id}.output`, version: '1.0.0' },
    requiredScopes: [],
    requiredDataClasses: [],
    riskClass: 'provider-write',
    timeoutMs: 10_000,
    freshness: {
      required: true,
      maxAgeMs: 0,
      revalidateBeforeExecution: true,
    },
    idempotency: {
      required: true,
      scope: 'provider-target',
      ttlMs: 86_400_000,
    },
    approval: {
      rule: 'authenticated-visual-proposal',
      expiresInSeconds: 600,
    },
    audit: {
      required: true,
      eventType: `${id}.provider-write`,
      redactFields: [],
    },
    executorId: `${id}.v1`,
  }).id;

const capability = (
  id: string,
  kind: AgentCapabilityReference['kind'],
): ResolvedAgentCapability => {
  const invoke = vi.fn(async () => ({ ok: true }));
  const common = {
    version: '1.0.0' as const,
    requiredDataClasses: Object.freeze([]),
    inputSchema: Object.freeze({ id: `${id}.input`, version: '1.0.0' }),
    timeoutMs: 10_000,
  };
  if (kind === 'provider-write') {
    return Object.freeze({
      descriptor: Object.freeze({
        ...common,
        id: providerWriteCapabilityId(id),
        capabilityKind: 'provider-write',
        riskClass: 'provider-write',
        approval: Object.freeze({
          rule: 'authenticated-visual-proposal' as const,
        }),
      }),
      invoke,
    });
  }
  return Object.freeze({
    descriptor: Object.freeze({
      ...common,
      id,
      capabilityKind: kind,
      riskClass:
        kind === 'delegation'
          ? ('none' as const)
          : kind === 'import'
            ? ('local-write' as const)
            : kind,
      approval: Object.freeze({ rule: 'none' as const }),
    }),
    invoke,
  });
};

const turn = (overrides: Partial<TurnInput> = {}): TurnInput => {
  return {
    requestId: ids.requestId,
    runId: ids.runId,
    householdId: ids.householdId,
    userId: ids.userId,
    authenticatedSessionId: ids.authenticatedSessionId,
    conversationId: ids.conversationId,
    spaceAccessGrantId: ids.spaceAccessGrantId,
    authorizationScopeFingerprint: ids.authorizationScopeFingerprint,
    locale: 'en-CA',
    rootManagerInvocationId: ids.rootManagerInvocationId,
    message: 'Schedule a dentist visit and update my shopping plan.',
    escalationTriggers: [],
    abortSignal: new AbortController().signal,
    ...overrides,
  };
};

const canonicalProjection = (
  sources: readonly ModelDisclosureSource[],
): Pick<ModelDisclosureAuthorization, 'records' | 'payload'> => {
  const records = sources.map((source) => {
    if (source.kind === 'conversation-message') {
      return {
        dataClass: 'conversation.messages',
        recordId: source.entry.id,
        fields: {
          content: source.entry.content,
          createdAt: source.entry.createdAt,
          role: source.entry.role,
        },
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
      const delegation = source.delegation as Readonly<{ id?: JsonValue }>;
      return {
        dataClass: 'agent.delegations',
        recordId: String(delegation.id),
        fields: { delegation: source.delegation },
      };
    }
    const outcome = source.outcome as Readonly<{ delegationId?: JsonValue }>;
    return {
      dataClass: 'agent.specialist-outcomes',
      recordId: String(outcome.delegationId),
      fields: { outcome: source.outcome },
    };
  });
  const normalized = records
    .map(({ dataClass, recordId, fields }) => ({
      dataClass,
      recordId,
      fields: Object.fromEntries(
        Object.entries(fields).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    }))
    .sort((left, right) =>
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

const canonicalHash = (value: unknown): string => {
  const canonicalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonicalize);
    if (entry !== null && typeof entry === 'object') {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)]),
      );
    }
    return entry;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
};

const authorizedInvocation = (
  input: Parameters<ModelDisclosureGateway['authorize']>[0],
  records: ModelDisclosureAuthorization['records'],
) => {
  const invocationContext = {
    ...input.invocation,
    disclosedContextRefs: records
      .map(
        ({ dataClass, recordId }) =>
          `context-ref-${canonicalHash({ dataClass, recordId })}`,
      )
      .sort(),
    deadline: '2026-08-09T22:35:00.000Z',
    idempotencyScope: 'd'.repeat(64),
  } as const;
  return {
    invocationContext,
    invocationContextHash: canonicalHash(invocationContext),
  } as const;
};

const setup = (
  execute: AgentExecutionProvider['execute'],
  overrides: {
    readonly modelResolution?: ModelResolution;
    readonly modelResolutions?: readonly ModelResolution[];
    readonly createCheckpointId?: () => string;
    readonly validateDecision?: ProviderWriteProposalGateway['validateDecision'];
    readonly executeDecision?: ProviderWriteProposalGateway['executeDecision'];
    readonly abandonPrepared?: ProviderWriteProposalGateway['abandonPrepared'];
    readonly failCheckpointCreate?: boolean;
    readonly failCheckpointCreateAfterPersist?: boolean;
    readonly checkpointCreate?: ApprovalCheckpointGateway['create'];
    readonly traceAppend?: (event: LocalTraceEvent) => Promise<void>;
    readonly disclosureGateway?: ModelDisclosureGateway;
    readonly schedulerInputSchema?: z.ZodObject;
    readonly schedulerOutputSchema?: z.ZodObject;
    readonly schedulerCapabilities?: readonly ResolvedAgentCapability[];
    readonly financeCapabilities?: readonly ResolvedAgentCapability[];
    readonly managerOutputSchema?: z.ZodObject;
    readonly clock?: () => Date;
    readonly createInvocationId?: () => string;
    readonly registeredSpecialists?: readonly RegisteredSpecialistRuntimeDescriptor[];
  } = {},
) => {
  const retrieveForManager = vi.fn(async () =>
    Object.freeze({
      entries: Object.freeze([
        Object.freeze({
          id: '018f1f5e-1000-7000-8000-000000000010',
          conversationId: ids.conversationId,
          householdId: ids.householdId,
          userId: ids.userId,
          role: 'assistant' as const,
          content: 'The user prefers afternoon appointments.',
          createdAt: '2026-08-09T18:00:00.000Z',
        }),
      ]),
    }),
  );
  const appendManagerMessage = vi.fn(
    async (
      input: Parameters<ManagerConversationMemory['appendManagerMessage']>[0],
    ) =>
      Object.freeze({
        id:
          input.role === 'user'
            ? '018f1f5e-1000-7000-8000-000000000011'
            : '018f1f5e-1000-7000-8000-000000000012',
        conversationId: input.conversationId,
        householdId: input.householdId,
        userId: input.userId,
        role: input.role,
        content: input.content,
        createdAt: '2026-08-09T22:30:00.000Z',
      }),
  );
  const traceEvents: LocalTraceEvent[] = [];
  const traceRecorder = new LocalTraceRecorder(
    {
      append: async (event) => {
        await overrides.traceAppend?.(event);
        traceEvents.push(event);
      },
    },
    () => new Date('2026-08-09T22:30:00.000Z'),
    () => 'trace-018f1f5e-1000-7000-8000-000000000020',
  );
  const clock = () => new Date('2026-08-09T22:30:00.000Z');
  const checkpoints = new ApprovalCheckpointService(
    new InMemoryApprovalCheckpointRepository(clock),
    new AesGcmApprovalCheckpointCipher({
      activeKeyId: 'runtime-v1',
      keys: { 'runtime-v1': new Uint8Array(32).fill(7) },
    }),
    clock,
  );
  const cancelCheckpoint = vi.fn<ApprovalCheckpointGateway['cancel']>((input) =>
    checkpoints.cancel(input),
  );
  const memory: ManagerConversationMemory = {
    appendManagerMessage,
    retrieveForManager,
  };
  let resolutionIndex = 0;
  const resolveModel = vi.fn(async () => {
    const configured = overrides.modelResolutions;
    if (configured === undefined) {
      return overrides.modelResolution ?? defaultResolution;
    }
    const resolution =
      configured[Math.min(resolutionIndex, configured.length - 1)];
    resolutionIndex += 1;
    if (resolution === undefined) throw new Error('missing resolution');
    return resolution;
  });
  const orchestrator = new AgentOrchestrator({
    manager: agent(
      'manager',
      'manager',
      z.looseObject({}),
      overrides.managerOutputSchema ?? z.looseObject({}),
    ),
    specialists: [
      agent(
        'scheduler',
        'specialist',
        overrides.schedulerInputSchema ?? z.looseObject({}),
        overrides.schedulerOutputSchema ?? z.looseObject({}),
        overrides.schedulerCapabilities ??
          Object.freeze([
            capability('google-calendar.event.create', 'provider-write'),
          ]),
      ),
      agent(
        'finance',
        'specialist',
        z.looseObject({}),
        z.looseObject({}),
        overrides.financeCapabilities,
      ),
      agent('shopping', 'specialist'),
    ],
    registeredSpecialists: overrides.registeredSpecialists,
    executionProvider: {
      execute: async (request) => {
        await request.beforeModelDispatch?.();
        const result = execute(request);
        await request.onModelDispatch?.();
        return result;
      },
    },
    modelRouter: {
      resolve: resolveModel,
    },
    memory,
    traceRecorder,
    approvalCheckpoints:
      overrides.checkpointCreate !== undefined
        ? {
            create: overrides.checkpointCreate,
            consumeForResume: (identity, predicate) =>
              checkpoints.consumeForResume(identity, predicate),
            cancel: cancelCheckpoint,
          }
        : overrides.failCheckpointCreate
          ? {
              create: async () => {
                throw new Error('checkpoint persistence unavailable');
              },
              consumeForResume: (identity, predicate) =>
                checkpoints.consumeForResume(identity, predicate),
              cancel: cancelCheckpoint,
            }
          : overrides.failCheckpointCreateAfterPersist
            ? {
                create: async (input) => {
                  await checkpoints.create(input);
                  throw new Error(
                    'checkpoint response unavailable after commit',
                  );
                },
                consumeForResume: (identity, predicate) =>
                  checkpoints.consumeForResume(identity, predicate),
                cancel: cancelCheckpoint,
              }
            : {
                create: (input) => checkpoints.create(input),
                consumeForResume: (identity, predicate) =>
                  checkpoints.consumeForResume(identity, predicate),
                cancel: cancelCheckpoint,
              },
    proposalGateway: {
      prepare: async () => ({
        proposalId,
        providerAuthorityBindingHash,
        authorizationScopeFingerprint: ids.authorizationScopeFingerprint,
        preview: {},
      }),
      resolvePrepared: async () => ({
        proposalId,
        providerAuthorityBindingHash,
        authorizationScopeFingerprint: ids.authorizationScopeFingerprint,
        preview: {},
      }),
      abandonPrepared:
        overrides.abandonPrepared ??
        (async () => ({ status: 'abandoned' as const })),
      validateDecision: overrides.validateDecision ?? (async () => true),
      executeDecision:
        overrides.executeDecision ??
        (async ({ decision }) => {
          const output: JsonValue =
            decision === 'approve'
              ? { eventProposal: 'ready' }
              : { rejected: true };
          return {
            outcome:
              decision === 'approve'
                ? ('executed-readback-verified' as const)
                : ('rejected' as const),
            output,
            idempotencyKey: 'calendar-write-idempotency-1',
          };
        }),
    },
    disclosureGateway: overrides.disclosureGateway ?? {
      authorize: vi.fn(
        async (input: Parameters<ModelDisclosureGateway['authorize']>[0]) => {
          const projection = canonicalProjection(input.sources);
          const grantIds: Readonly<Record<string, string>> = {
            manager: '018f1f5e-1000-7000-8000-000000000008',
            scheduler: ids.disclosureGrantId,
            finance: '018f1f5e-1000-7000-8000-000000000009',
            shopping: '018f1f5e-1000-7000-8000-00000000000a',
          };
          return {
            status: 'authorized' as const,
            grantId: grantIds[input.agentId] ?? ids.disclosureGrantId,
            grantVersion: '1.0.0',
            runId: input.runId,
            householdId: input.householdId,
            userId: input.userId,
            agentId: input.agentId,
            phasePurpose: input.phasePurpose,
            phaseInvocationId: input.phaseInvocationId,
            ...authorizedInvocation(input, projection.records),
            disclosurePurpose:
              input.agentId === 'scheduler'
                ? 'schedule one appointment'
                : 'manage this assistant turn',
            provider: input.provider,
            expiresAt: '2026-08-09T22:40:00.000Z',
            records: projection.records,
            payload: projection.payload,
          };
        },
      ),
    },
    agentGraphHash: graphHash,
    sdkVersion,
    createCheckpointId:
      overrides.createCheckpointId ??
      (() => '018f1f5e-1000-7000-8000-000000000030'),
    createInvocationId: overrides.createInvocationId,
    clock: overrides.clock ?? (() => new Date('2026-08-09T22:30:00.000Z')),
  });
  return {
    appendManagerMessage,
    cancelCheckpoint,
    checkpoints,
    orchestrator,
    retrieveForManager,
    resolveModel,
    traceEvents,
  };
};

describe('AgentOrchestrator', () => {
  it('keeps conversation memory manager-owned and synthesizes specialist output', async () => {
    const requests: AgentProviderRequest[] = [];
    const { appendManagerMessage, orchestrator, retrieveForManager } = setup(
      async (request) => {
        requests.push(request);
        if (request.phase === 'plan') {
          return completed({
            delegations: [
              {
                id: 'schedule-appointment',
                specialistId: 'scheduler',
                input: { request: 'dentist appointment' },
                dependsOn: [],
              },
            ],
          });
        }
        if (request.phase === 'specialist') {
          return completed({ alternatives: ['Tuesday at 2 PM'] });
        }
        return completed({ message: 'Tuesday at 2 PM is the best option.' });
      },
    );

    const result = await orchestrator.runTurn(turn());

    expect(result).toMatchObject({
      status: 'completed',
      output: { message: 'Tuesday at 2 PM is the best option.' },
      hasPartialFailures: false,
      localTraceReference: 'trace-018f1f5e-1000-7000-8000-000000000020',
    });
    expect(requests.map((request) => request.phase)).toEqual([
      'plan',
      'specialist',
      'synthesize',
    ]);
    expect(requests.map((request) => request.context.locale)).toEqual([
      'en-CA',
      'en-CA',
      'en-CA',
    ]);
    expect(requests[0]!.input).toMatchObject({
      schemaVersion: 1,
      records: [
        {
          dataClass: 'conversation.messages',
          fields: { content: 'The user prefers afternoon appointments.' },
        },
        {
          dataClass: 'conversation.messages',
          fields: { content: turn().message, role: 'user' },
        },
      ],
    });
    expect(retrieveForManager).toHaveBeenCalledOnce();
    expect(appendManagerMessage).toHaveBeenCalledTimes(2);
    expect(appendManagerMessage.mock.calls[0]![0]).toMatchObject({
      role: 'user',
      content: turn().message,
    });
    expect(appendManagerMessage.mock.calls[1]![0]).toMatchObject({
      role: 'assistant',
      content: 'Tuesday at 2 PM is the best option.',
    });
  });

  it('binds every model call to a distinct phase invocation and canonical durable records', async () => {
    const authorizationInputs: Array<
      Parameters<ModelDisclosureGateway['authorize']>[0]
    > = [];
    const providerInputs: AgentProviderRequest[] = [];
    const authorize = vi.fn<ModelDisclosureGateway['authorize']>(
      async (input) => {
        authorizationInputs.push(input);
        const projection = canonicalProjection(input.sources);
        return {
          status: 'authorized',
          grantId:
            input.agentId === 'manager'
              ? '018f1f5e-1000-7000-8000-000000000008'
              : ids.disclosureGrantId,
          grantVersion: '1.0.0',
          runId: input.runId,
          householdId: input.householdId,
          userId: input.userId,
          agentId: input.agentId,
          phasePurpose: input.phasePurpose,
          phaseInvocationId: input.phaseInvocationId,
          ...authorizedInvocation(input, projection.records),
          disclosurePurpose: 'authorize one exact model dispatch',
          provider: input.provider,
          expiresAt: '2026-08-09T22:40:00.000Z',
          records: projection.records,
          payload: projection.payload,
        };
      },
    );
    const { orchestrator } = setup(
      async (request) => {
        providerInputs.push(request);
        if (request.phase === 'plan') {
          return completed({
            delegations: [
              {
                id: 'schedule-dentist',
                specialistId: 'scheduler',
                input: { request: 'dentist' },
                dependsOn: [],
              },
              {
                id: 'schedule-optometrist',
                specialistId: 'finance',
                input: { request: 'optometrist' },
                dependsOn: [],
              },
            ],
          });
        }
        if (request.phase === 'specialist') {
          return completed({ alternatives: ['Tuesday'] });
        }
        return completed({ message: 'Both requests are ready.' });
      },
      { disclosureGateway: { authorize } },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'completed',
    });

    expect(
      authorizationInputs
        .map((input) => input.phaseInvocationId)
        .every((id) => UUID_PATTERN.test(String(id))),
    ).toBe(true);
    expect(
      new Set(authorizationInputs.map((input) => input.phaseInvocationId)).size,
    ).toBe(4);
    expect(
      authorizationInputs
        .filter((input) => input.agentId === 'manager')
        .every(
          (input) =>
            input.invocation.parentInvocationId === ids.runId &&
            input.invocation.agentInvocationId === ids.rootManagerInvocationId,
        ),
    ).toBe(true);
    expect(
      authorizationInputs
        .filter((input) => input.agentId !== 'manager')
        .every(
          (input) =>
            input.invocation.parentInvocationId ===
              ids.rootManagerInvocationId &&
            input.invocation.agentInvocationId !== input.phaseInvocationId,
        ),
    ).toBe(true);
    expect(
      authorizationInputs.every(
        (input) => !Object.hasOwn(input, 'requestedGrantId'),
      ),
    ).toBe(true);
    expect(providerInputs[0]?.input).toEqual({
      schemaVersion: 1,
      records: [
        {
          dataClass: 'conversation.messages',
          recordId: '018f1f5e-1000-7000-8000-000000000010',
          fields: {
            content: 'The user prefers afternoon appointments.',
            createdAt: '2026-08-09T18:00:00.000Z',
            role: 'assistant',
          },
        },
        {
          dataClass: 'conversation.messages',
          recordId: '018f1f5e-1000-7000-8000-000000000011',
          fields: {
            content: turn().message,
            createdAt: '2026-08-09T22:30:00.000Z',
            role: 'user',
          },
        },
      ],
    });
  });

  it('uses server-minted child identities and readiness without provider dispatch', async () => {
    const providerCalls: AgentProviderRequest[] = [];
    const invocationIds = [
      '018f1f5e-1000-7000-8000-000000000101',
      '018f1f5e-1000-7000-8000-000000000102',
      '018f1f5e-1000-7000-8000-000000000103',
      '018f1f5e-1000-7000-8000-000000000104',
    ];
    const { orchestrator } = setup(
      async (request) => {
        providerCalls.push(request);
        if (request.phase === 'plan') {
          return completed({
            delegations: [
              {
                id: 'finance-ready-check',
                specialistId: 'finance',
                input: { request: 'review documents' },
                dependsOn: [],
              },
            ],
          });
        }
        return completed({ message: 'Finance is unavailable.' });
      },
      {
        createInvocationId: () => invocationIds.shift()!,
        registeredSpecialists: [
          {
            id: 'finance',
            readiness: async () => ({
              status: 'unavailable' as const,
              reasonCode: 'finance-not-ready',
            }),
          },
        ],
      },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'completed',
      specialistOutcomes: [
        {
          delegationId: 'finance-ready-check',
          status: 'unavailable',
          reasonCode: 'finance-not-ready',
          invocationContext: {
            parentInvocationId: ids.rootManagerInvocationId,
            agentInvocationId: '018f1f5e-1000-7000-8000-000000000102',
            phaseInvocationId: '018f1f5e-1000-7000-8000-000000000103',
            disclosedContextRefs: [],
          },
        },
      ],
    });
    expect(providerCalls.filter(({ phase }) => phase === 'specialist')).toEqual(
      [],
    );
  });

  it('sends only the gateway-filtered payload and audits authoritative record fields at dispatch', async () => {
    const providerInputs: AgentProviderRequest[] = [];
    const authorize = vi.fn<ModelDisclosureGateway['authorize']>(
      async (input) => {
        const projection = canonicalProjection(input.sources);
        const specialistRecord = projection.records[0];
        return {
          status: 'authorized',
          grantId:
            input.agentId === 'scheduler'
              ? ids.disclosureGrantId
              : '018f1f5e-1000-7000-8000-000000000008',
          grantVersion: '1.0.0',
          runId: input.runId,
          householdId: input.householdId,
          userId: input.userId,
          agentId: input.agentId,
          phasePurpose: input.phasePurpose,
          phaseInvocationId: input.phaseInvocationId,
          ...authorizedInvocation(input, projection.records),
          disclosurePurpose:
            input.agentId === 'scheduler'
              ? 'schedule one appointment'
              : 'manage this assistant turn',
          provider: input.provider,
          expiresAt: '2026-08-09T22:40:00.000Z',
          records: projection.records,
          payload:
            input.agentId === 'scheduler' && specialistRecord !== undefined
              ? {
                  schemaVersion: 1,
                  records: [
                    {
                      ...specialistRecord,
                      fields: { delegation: { authorizedOnly: true } },
                    },
                  ],
                }
              : projection.payload,
        };
      },
    );
    const { orchestrator, traceEvents } = setup(
      async (request) => {
        providerInputs.push(request);
        if (request.phase === 'plan') {
          return completed({
            delegations: [
              {
                id: 'schedule-safe',
                specialistId: 'scheduler',
                input: { request: 'dentist' },
                dependsOn: [],
              },
            ],
          });
        }
        if (request.phase === 'specialist') {
          return completed({ alternatives: ['Tuesday'] });
        }
        return completed({ message: 'Tuesday works.' });
      },
      { disclosureGateway: { authorize } },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'completed',
    });

    expect(
      providerInputs.find((request) => request.phase === 'specialist')?.input,
    ).toEqual({
      schemaVersion: 1,
      records: [
        {
          dataClass: 'agent.delegations',
          recordId: 'schedule-safe',
          fields: { delegation: { authorizedOnly: true } },
        },
      ],
    });
    const specialistAuthorization = authorize.mock.calls
      .map(([input]) => input)
      .find((input) => input.agentId === 'scheduler');
    expect(specialistAuthorization).toMatchObject({
      phasePurpose: 'specialist-execution',
      phaseInvocationId: expect.stringMatching(UUID_PATTERN),
      provider: 'openai',
      sources: [{ kind: 'specialist-delegation' }],
    });
    expect(
      traceEvents.filter((event) => event.type === 'disclosure.sent'),
    ).toContainEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          grantId: ids.disclosureGrantId,
          agentId: 'scheduler',
          purpose: 'schedule one appointment',
          phasePurpose: 'specialist-execution',
          phaseInvocationId: expect.stringMatching(UUID_PATTERN),
          dataClass: 'agent.delegations',
          recordId: 'schedule-safe',
          fields: ['delegation'],
          expiresAt: '2026-08-09T22:40:00.000Z',
        }),
      }),
    );
  });

  it('fails closed on a typed cross-run disclosure denial before specialist provider dispatch', async () => {
    const providerCalls: AgentProviderRequest[] = [];
    const authorize = vi.fn<ModelDisclosureGateway['authorize']>(
      async (input) =>
        input.agentId === 'scheduler'
          ? {
              status: 'denied',
              grantId: ids.disclosureGrantId,
              reason: 'grant-run-mismatch',
            }
          : {
              ...canonicalProjection(input.sources),
              status: 'authorized',
              grantId: '018f1f5e-1000-7000-8000-000000000008',
              grantVersion: '1.0.0',
              runId: input.runId,
              householdId: input.householdId,
              userId: input.userId,
              agentId: input.agentId,
              phasePurpose: input.phasePurpose,
              phaseInvocationId: input.phaseInvocationId,
              ...authorizedInvocation(
                input,
                canonicalProjection(input.sources).records,
              ),
              disclosurePurpose: 'manage this assistant turn',
              provider: input.provider,
              expiresAt: '2026-08-09T22:40:00.000Z',
              records: canonicalProjection(input.sources).records,
              payload: canonicalProjection(input.sources).payload,
            },
    );
    const { orchestrator, traceEvents } = setup(
      async (request) => {
        providerCalls.push(request);
        if (request.phase === 'plan') {
          return completed({
            delegations: [
              {
                id: 'schedule-denied',
                specialistId: 'scheduler',
                input: { request: 'dentist' },
                dependsOn: [],
              },
            ],
          });
        }
        return completed({ message: 'I could not access that record.' });
      },
      { disclosureGateway: { authorize } },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'completed',
      hasPartialFailures: true,
      specialistOutcomes: [
        {
          specialistId: 'scheduler',
          status: 'unavailable',
          reasonCode: 'model-disclosure-denied',
        },
      ],
    });
    expect(
      providerCalls.filter((request) => request.phase === 'specialist'),
    ).toHaveLength(0);
    expect(
      traceEvents.find((event) => event.type === 'disclosure.denied'),
    ).toMatchObject({
      metadata: {
        grantId: ids.disclosureGrantId,
        agentId: 'scheduler',
        reason: 'grant-run-mismatch',
      },
    });
    expect(
      traceEvents.find(
        (event) =>
          event.type === 'specialist.outcome' &&
          event.metadata.delegationId === 'schedule-denied',
      ),
    ).toMatchObject({
      metadata: {
        status: 'unavailable',
        reasonCode: 'model-disclosure-denied',
      },
    });
  });

  it('fails closed when no active disclosure grant exists without fabricating a grant ID', async () => {
    const providerIo = vi.fn();
    const { orchestrator, traceEvents } = setup(
      async () => {
        providerIo();
        return completed({ delegations: [] });
      },
      {
        disclosureGateway: {
          authorize: async () => ({
            status: 'denied' as const,
            reason: 'no-active-grant' as const,
          }),
        },
      },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: { code: 'model-disclosure-denied', retryable: false },
    });
    expect(providerIo).not.toHaveBeenCalled();
    expect(
      traceEvents.find((event) => event.type === 'disclosure.denied'),
    ).toMatchObject({
      metadata: {
        agentId: 'manager',
        reason: 'no-active-grant',
      },
    });
    expect(
      traceEvents.find((event) => event.type === 'disclosure.denied')?.metadata,
    ).not.toHaveProperty('grantId');
  });

  it('rejects a non-canonical authorized payload before any provider I/O', async () => {
    const providerIo = vi.fn();
    const { orchestrator } = setup(
      async () => {
        providerIo();
        return completed({ delegations: [] });
      },
      {
        disclosureGateway: {
          authorize: async (input) => {
            const projection = canonicalProjection(input.sources);
            return {
              status: 'authorized' as const,
              grantId: '018f1f5e-1000-7000-8000-000000000008',
              grantVersion: '1.0.0',
              runId: input.runId,
              householdId: input.householdId,
              userId: input.userId,
              agentId: input.agentId,
              phasePurpose: input.phasePurpose,
              phaseInvocationId: input.phaseInvocationId,
              ...authorizedInvocation(input, projection.records),
              disclosurePurpose: 'manage this assistant turn',
              provider: input.provider,
              expiresAt: '2026-08-09T22:40:00.000Z',
              records: projection.records,
              payload: { arbitraryUnprovenPayload: true },
            };
          },
        },
      },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: { code: 'model-disclosure-denied', retryable: false },
    });
    expect(providerIo).not.toHaveBeenCalled();
  });

  it('rejects a grant-bound disclosure denial that omits its grant ID', async () => {
    const providerIo = vi.fn();
    const { orchestrator, traceEvents } = setup(
      async () => {
        providerIo();
        return completed({ delegations: [] });
      },
      {
        disclosureGateway: {
          authorize: async () =>
            ({
              status: 'denied',
              reason: 'grant-run-mismatch',
            }) as never,
        },
      },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: { code: 'model-disclosure-denied', retryable: false },
    });
    expect(providerIo).not.toHaveBeenCalled();
    expect(
      traceEvents.find((event) => event.type === 'disclosure.denied'),
    ).toMatchObject({
      metadata: {
        agentId: 'manager',
        reason: 'inactive-or-mismatched-disclosure-grant',
      },
    });
  });

  it('rechecks disclosure expiry at dispatch and performs no provider I/O after expiry', async () => {
    const providerIo = vi.fn();
    let now = new Date('2026-08-09T22:30:00.000Z');
    const authorize = vi.fn<ModelDisclosureGateway['authorize']>(
      async (input) => {
        now = new Date('2026-08-09T22:41:00.000Z');
        const projection = canonicalProjection(input.sources);
        return {
          status: 'authorized',
          grantId: ids.disclosureGrantId,
          grantVersion: '1.0.0',
          runId: input.runId,
          householdId: input.householdId,
          userId: input.userId,
          agentId: input.agentId,
          phasePurpose: input.phasePurpose,
          phaseInvocationId: input.phaseInvocationId,
          ...authorizedInvocation(input, projection.records),
          disclosurePurpose: 'manage this assistant turn',
          provider: input.provider,
          expiresAt: '2026-08-09T22:40:00.000Z',
          records: projection.records,
          payload: projection.payload,
        };
      },
    );
    const { orchestrator, traceEvents } = setup(
      async () => {
        providerIo();
        return completed({ delegations: [] });
      },
      { disclosureGateway: { authorize }, clock: () => now },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: { code: 'model-disclosure-denied', retryable: false },
    });
    expect(providerIo).not.toHaveBeenCalled();
    expect(
      traceEvents.find((event) => event.type === 'disclosure.denied'),
    ).toMatchObject({
      metadata: {
        grantId: ids.disclosureGrantId,
        agentId: 'manager',
        reason: 'grant-expired',
      },
    });
    expect(
      traceEvents.filter((event) => event.type === 'disclosure.sent'),
    ).toHaveLength(0);
  });

  it('filters sensitive specialist output before downstream and manager model calls', async () => {
    const providerInputs: AgentProviderRequest[] = [];
    const authorize = vi.fn<ModelDisclosureGateway['authorize']>(
      async (input) => {
        const projection = canonicalProjection(input.sources);
        const payload = JSON.parse(
          JSON.stringify(projection.payload),
          (key: string, value: unknown) =>
            key === 'privateAccountNumber' ? undefined : value,
        ) as JsonValue;
        return {
          status: 'authorized',
          grantId:
            input.agentId === 'manager'
              ? '018f1f5e-1000-7000-8000-000000000008'
              : input.agentId === 'finance'
                ? '018f1f5e-1000-7000-8000-000000000009'
                : '018f1f5e-1000-7000-8000-00000000000a',
          grantVersion: '1.0.0',
          runId: input.runId,
          householdId: input.householdId,
          userId: input.userId,
          agentId: input.agentId,
          phasePurpose: input.phasePurpose,
          phaseInvocationId: input.phaseInvocationId,
          ...authorizedInvocation(input, projection.records),
          disclosurePurpose: 'prepare a redacted household plan',
          provider: input.provider,
          expiresAt: '2026-08-09T22:40:00.000Z',
          records: projection.records,
          payload,
        };
      },
    );
    const { orchestrator, traceEvents } = setup(
      async (request) => {
        providerInputs.push(request);
        if (request.phase === 'plan') {
          return completed({
            delegations: [
              {
                id: 'finance-first',
                specialistId: 'finance',
                input: { request: 'review spending' },
                dependsOn: [],
              },
              {
                id: 'shopping-second',
                specialistId: 'shopping',
                input: { request: 'make a shopping plan' },
                dependsOn: ['finance-first'],
              },
            ],
          });
        }
        if (
          request.phase === 'specialist' &&
          request.agent.manifest.id === 'finance'
        ) {
          return completed({
            privateAccountNumber: '9999-PRIVATE',
            total: 12500,
          });
        }
        if (request.phase === 'specialist') {
          return completed({ plan: 'Use the safe total only.' });
        }
        return completed({ message: 'Here is the redacted household plan.' });
      },
      { disclosureGateway: { authorize } },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'completed',
      hasPartialFailures: false,
    });
    const shoppingInput = providerInputs.find(
      (request) =>
        request.phase === 'specialist' &&
        request.agent.manifest.id === 'shopping',
    )?.input;
    const synthesisInput = providerInputs.find(
      (request) => request.phase === 'synthesize',
    )?.input;
    expect(JSON.stringify(shoppingInput)).not.toContain('9999-PRIVATE');
    expect(JSON.stringify(synthesisInput)).not.toContain('9999-PRIVATE');
    const shoppingAuthorization = authorize.mock.calls
      .map(([input]) => input)
      .find((input) => input.agentId === 'shopping');
    const synthesisAuthorization = authorize.mock.calls
      .map(([input]) => input)
      .find((input) => input.phasePurpose === 'manager-synthesis');
    expect(shoppingAuthorization?.sources.map(({ kind }) => kind)).toEqual([
      'specialist-delegation',
      'specialist-outcome',
    ]);
    expect(synthesisAuthorization?.sources.map(({ kind }) => kind)).toEqual([
      'conversation-message',
      'manager-plan',
      'specialist-outcome',
      'specialist-outcome',
    ]);
    expect(
      traceEvents
        .filter((event) => event.type === 'disclosure.sent')
        .flatMap((event) => event.metadata.fields as readonly string[]),
    ).not.toContain('privateAccountNumber');
  });

  it('runs three unique specialists concurrently within the ceiling', async () => {
    let active = 0;
    let maximumActive = 0;
    const { orchestrator, traceEvents } = setup(async (request) => {
      if (request.phase === 'plan') {
        return completed({
          delegations: ['one', 'two', 'three'].map((id) => ({
            id,
            specialistId:
              id === 'one'
                ? 'scheduler'
                : id === 'two'
                  ? 'finance'
                  : 'shopping',
            input: { id },
            dependsOn: [],
          })),
        });
      }
      if (request.phase === 'specialist') {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 8));
        active -= 1;
        return completed({ ok: true });
      }
      return completed({ message: 'All three tasks completed.' });
    });

    const result = await orchestrator.runTurn(turn());

    expect(result.status).toBe('completed');
    expect(maximumActive).toBe(3);
    expect(
      traceEvents.filter((event) => event.type === 'specialist.dispatched'),
    ).toHaveLength(3);
  });

  it('sequences dependencies and synthesizes independent partial failures', async () => {
    const lifecycle: string[] = [];
    let synthesisInput: unknown;
    const { orchestrator, traceEvents } = setup(async (request) => {
      if (request.phase === 'plan') {
        return completed({
          delegations: [
            {
              id: 'calendar',
              specialistId: 'scheduler',
              input: {},
              dependsOn: [],
            },
            {
              id: 'budget',
              specialistId: 'finance',
              input: {},
              dependsOn: [],
            },
            {
              id: 'shop-after-calendar',
              specialistId: 'shopping',
              input: {},
              dependsOn: ['calendar'],
            },
          ],
        });
      }
      if (request.phase === 'specialist') {
        const input = request.input as unknown as {
          readonly records: readonly [
            {
              readonly fields: {
                readonly delegation: { readonly id: string };
              };
            },
          ];
        };
        const delegation = input.records[0].fields.delegation;
        lifecycle.push(`start:${delegation.id}`);
        if (delegation.id === 'budget') {
          throw new Error('database password should never be exposed');
        }
        lifecycle.push(`finish:${delegation.id}`);
        return completed({ delegation: delegation.id });
      }
      synthesisInput = request.input;
      return completed({
        message: 'Calendar and shopping succeeded; finance did not.',
      });
    });

    const result = await orchestrator.runTurn(turn());

    expect(result).toMatchObject({
      status: 'completed',
      hasPartialFailures: true,
      specialistOutcomes: [
        { delegationId: 'calendar', status: 'completed' },
        { delegationId: 'budget', status: 'unavailable' },
        { delegationId: 'shop-after-calendar', status: 'completed' },
      ],
    });
    expect(lifecycle.indexOf('start:shop-after-calendar')).toBeGreaterThan(
      lifecycle.indexOf('finish:calendar'),
    );
    expect(synthesisInput).toMatchObject({
      schemaVersion: 1,
      records: expect.arrayContaining([
        expect.objectContaining({
          dataClass: 'agent.specialist-outcomes',
          fields: expect.objectContaining({
            outcome: expect.objectContaining({
              delegationId: 'budget',
              status: 'unavailable',
              reasonCode: 'specialist-dispatch-unavailable',
            }),
          }),
        }),
      ]),
    });
    expect(JSON.stringify(synthesisInput)).not.toContain('database password');
    expect(
      traceEvents.find(
        (event) =>
          event.type === 'specialist.dispatched' &&
          event.metadata.delegationId === 'shop-after-calendar',
      )?.metadata,
    ).toMatchObject({ wave: 2, dependsOn: ['calendar'] });
  });

  it('fails a cyclic or unknown dependency plan before any specialist call', async () => {
    let specialistCalls = 0;
    const { orchestrator } = setup(async (request) => {
      if (request.phase === 'plan') {
        return completed({
          delegations: [
            {
              id: 'first',
              specialistId: 'scheduler',
              input: {},
              dependsOn: ['second'],
            },
            {
              id: 'second',
              specialistId: 'shopping',
              input: {},
              dependsOn: ['first'],
            },
          ],
        });
      }
      specialistCalls += 1;
      return completed({ message: 'must not run' });
    });

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: {
        code: 'invalid-manager-plan',
        retryable: false,
      },
    });
    expect(specialistCalls).toBe(0);
  });

  it.each(['invalid-output', 'provider-failure'] as const)(
    'retries a side-effect-free Luna plan once on Terra after %s',
    async (failureMode) => {
      const terraResolution: ModelResolution = Object.freeze({
        status: 'resolved',
        requestedModel: 'gpt-5.6-terra',
        resolvedModel: 'gpt-5.6-terra',
        reason: 'failed-output-validation',
      });
      const planModels: string[] = [];
      let specialistCalls = 0;
      const { orchestrator, resolveModel, traceEvents } = setup(
        async (request) => {
          if (request.phase === 'plan') {
            planModels.push(request.model);
            if (request.model === 'gpt-5.6-luna') {
              if (failureMode === 'provider-failure') {
                throw new Error('Luna provider failed');
              }
              return completed({ unexpected: true });
            }
            return completed({
              delegations: [
                {
                  id: 'schedule-once',
                  specialistId: 'scheduler',
                  input: { request: 'dentist' },
                  dependsOn: [],
                },
              ],
            });
          }
          if (request.phase === 'specialist') {
            specialistCalls += 1;
            return completed({ alternatives: ['Tuesday'] });
          }
          return completed({ message: 'Tuesday works.' });
        },
        { modelResolutions: [defaultResolution, terraResolution] },
      );

      await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
        status: 'completed',
        modelResolution: terraResolution,
      });
      expect(planModels).toEqual(['gpt-5.6-luna', 'gpt-5.6-terra']);
      expect(specialistCalls).toBe(1);
      expect(resolveModel).toHaveBeenNthCalledWith(2, {
        triggers: [
          failureMode === 'provider-failure'
            ? 'luna-unavailable'
            : 'failed-output-validation',
        ],
        policy: expect.objectContaining({
          defaultModel: 'gpt-5.6-luna',
          complexModel: 'gpt-5.6-terra',
        }),
      });
      expect(
        traceEvents.filter(
          (event) =>
            event.type === 'model.resolved' &&
            event.metadata.resolvedModel === 'gpt-5.6-terra',
        ),
      ).toHaveLength(1);
    },
  );

  it('fails clearly after the single Terra planning retry also fails', async () => {
    const terraResolution: ModelResolution = Object.freeze({
      status: 'resolved',
      requestedModel: 'gpt-5.6-terra',
      resolvedModel: 'gpt-5.6-terra',
      reason: 'failed-output-validation',
    });
    let specialistCalls = 0;
    const { orchestrator } = setup(
      async (request) => {
        if (request.phase === 'plan') {
          if (request.model === 'gpt-5.6-luna') {
            return completed({ invalid: true });
          }
          throw new Error('Terra failed');
        }
        specialistCalls += 1;
        return completed({ message: 'must not run' });
      },
      { modelResolutions: [defaultResolution, terraResolution] },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: { code: 'manager-execution-failed' },
      modelResolution: terraResolution,
    });
    expect(specialistCalls).toBe(0);
  });

  it('retries only synthesis on Terra after invalid Luna output without repeating specialists', async () => {
    const terraResolution: ModelResolution = Object.freeze({
      status: 'resolved',
      requestedModel: 'gpt-5.6-terra',
      resolvedModel: 'gpt-5.6-terra',
      reason: 'failed-output-validation',
    });
    let specialistCalls = 0;
    const synthesisModels: string[] = [];
    const { orchestrator } = setup(
      async (request) => {
        if (request.phase === 'plan') {
          return completed({
            delegations: [
              {
                id: 'schedule-once',
                specialistId: 'scheduler',
                input: { request: 'dentist' },
                dependsOn: [],
              },
            ],
          });
        }
        if (request.phase === 'specialist') {
          specialistCalls += 1;
          return completed({ alternatives: ['Tuesday'] });
        }
        synthesisModels.push(request.model);
        return request.model === 'gpt-5.6-luna'
          ? completed({ wrong: true })
          : completed({ message: 'Tuesday works.' });
      },
      {
        modelResolutions: [defaultResolution, terraResolution],
        managerOutputSchema: z.strictObject({ message: z.string() }),
      },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'completed',
      output: { message: 'Tuesday works.' },
      modelResolution: terraResolution,
    });
    expect(specialistCalls).toBe(1);
    expect(synthesisModels).toEqual(['gpt-5.6-luna', 'gpt-5.6-terra']);
  });

  it.each(['invalid-output', 'provider-failure'] as const)(
    'retries a mixed-capability specialist on Terra after a replay-safe Luna %s',
    async (failureMode) => {
      const terraResolution: ModelResolution = Object.freeze({
        status: 'resolved',
        requestedModel: 'gpt-5.6-terra',
        resolvedModel: 'gpt-5.6-terra',
        reason: 'failed-output-validation',
      });
      const specialistModels: string[] = [];
      const { orchestrator } = setup(
        async (request) => {
          if (request.phase === 'plan') {
            return completed({
              delegations: [
                {
                  id: 'schedule-once',
                  specialistId: 'scheduler',
                  input: { request: 'dentist' },
                  dependsOn: [],
                },
              ],
            });
          }
          if (request.phase === 'specialist') {
            specialistModels.push(request.model);
            if (request.model === 'gpt-5.6-luna') {
              return failureMode === 'invalid-output'
                ? completed({ wrong: true }, 'safe')
                : failedProviderResult('safe');
            }
            return completed({ alternatives: ['Tuesday'] }, 'safe');
          }
          return completed({ message: 'Tuesday works.' });
        },
        {
          modelResolutions: [defaultResolution, terraResolution],
          schedulerOutputSchema: z.strictObject({
            alternatives: z.array(z.string()),
          }),
          schedulerCapabilities: Object.freeze([
            capability('scheduler.events.read', 'read'),
            capability('google-calendar.event.create', 'provider-write'),
          ]),
        },
      );

      await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
        status: 'completed',
        modelResolution: terraResolution,
        specialistOutcomes: [
          {
            delegationId: 'schedule-once',
            status: 'completed',
            facts: { alternatives: ['Tuesday'] },
          },
        ],
      });
      expect(specialistModels).toEqual(['gpt-5.6-luna', 'gpt-5.6-terra']);
    },
  );

  it('never retries a specialist after the provider reports a consequential invocation', async () => {
    const specialistModels: string[] = [];
    const { orchestrator, resolveModel } = setup(
      async (request) => {
        if (request.phase === 'plan') {
          return completed({
            delegations: [
              {
                id: 'schedule-once',
                specialistId: 'scheduler',
                input: { request: 'dentist' },
                dependsOn: [],
              },
            ],
          });
        }
        if (request.phase === 'specialist') {
          specialistModels.push(request.model);
          return completed({ wrong: true }, 'unsafe');
        }
        return completed({ message: 'The schedule needs review.' });
      },
      {
        schedulerOutputSchema: z.strictObject({
          alternatives: z.array(z.string()),
        }),
        schedulerCapabilities: Object.freeze([
          capability('scheduler.events.read', 'read'),
          capability('scheduler.task.update', 'local-write'),
        ]),
      },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'completed',
      hasPartialFailures: true,
      specialistOutcomes: [
        {
          delegationId: 'schedule-once',
          status: 'unavailable',
          reasonCode: 'specialist-dispatch-unavailable',
        },
      ],
    });
    expect(specialistModels).toEqual(['gpt-5.6-luna']);
    expect(resolveModel).toHaveBeenCalledOnce();
  });

  it('rejects delegation inputs that do not match the selected specialist schema', async () => {
    let specialistCalls = 0;
    const { orchestrator } = setup(
      async (request) => {
        if (request.phase === 'plan') {
          return completed({
            delegations: [
              {
                id: 'forged-schedule',
                specialistId: 'scheduler',
                input: { request: 'dentist', userId: ids.userId },
                dependsOn: [],
              },
            ],
          });
        }
        specialistCalls += 1;
        return completed({ message: 'must not run' });
      },
      {
        schedulerInputSchema: z.strictObject({
          request: z.string().min(1),
        }),
      },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: { code: 'invalid-manager-plan' },
    });
    expect(specialistCalls).toBe(0);
  });

  it('fails clearly when the configured model is unavailable while local memory stays untouched', async () => {
    const unavailable = Object.freeze({
      status: 'unavailable',
      requestedModel: 'gpt-5.6-luna',
      attemptedModels: Object.freeze([
        'gpt-5.6-luna' as const,
        'gpt-5.6-terra' as const,
      ]),
      reason: 'no-configured-model-available',
      safeError: Object.freeze({
        code: 'agent-model-unavailable',
        message: 'AI is temporarily unavailable. Local features still work.',
        retryable: true as const,
      }),
    }) satisfies ModelResolution;
    const execute = vi.fn<AgentExecutionProvider['execute']>();
    const {
      appendManagerMessage,
      orchestrator,
      resolveModel,
      retrieveForManager,
    } = setup(execute, { modelResolution: unavailable });

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      modelResolution: unavailable,
      safeError: unavailable.safeError,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(retrieveForManager).not.toHaveBeenCalled();
    expect(appendManagerMessage).not.toHaveBeenCalled();
    expect(resolveModel).toHaveBeenCalledWith({
      triggers: [],
      policy: expect.objectContaining({
        defaultModel: 'gpt-5.6-luna',
        complexModel: 'gpt-5.6-terra',
        escalationReasons: expect.arrayContaining(['luna-unavailable']),
      }),
    });
  });

  it('does no provider or memory I/O when manifest policy forbids the required escalation', async () => {
    const unavailable = Object.freeze({
      status: 'unavailable',
      requestedModel: 'gpt-5.6-terra',
      attemptedModels: Object.freeze([] as const),
      reason: 'configured-model-escalation-not-allowed',
      escalationTrigger: 'failed-output-validation',
      safeError: Object.freeze({
        code: 'agent-model-escalation-not-allowed',
        message:
          'The active agent policy does not allow the required model escalation.',
        retryable: false as const,
      }),
    }) satisfies ModelResolution;
    const execute = vi.fn<AgentExecutionProvider['execute']>();
    const { appendManagerMessage, orchestrator, retrieveForManager } = setup(
      execute,
      { modelResolution: unavailable },
    );

    await expect(
      orchestrator.runTurn(
        turn({ escalationTriggers: ['failed-output-validation'] }),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      modelResolution: unavailable,
      safeError: unavailable.safeError,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(retrieveForManager).not.toHaveBeenCalled();
    expect(appendManagerMessage).not.toHaveBeenCalled();
  });

  it('rejects multiple provider-write interruptions before checkpointing or action dispatch', async () => {
    const executeDecision =
      vi.fn<ProviderWriteProposalGateway['executeDecision']>();
    const abandonPrepared = vi.fn<
      ProviderWriteProposalGateway['abandonPrepared']
    >(async () => ({ status: 'abandoned' as const }));
    const secondProposalId = '018f1f5e-1000-7000-8000-000000000062';
    const secondAuthorityHash = 'c'.repeat(64);
    const { orchestrator, traceEvents } = setup(
      async (request) => {
        if (request.phase === 'plan') {
          return completed({
            delegations: [
              {
                id: 'two-calendar-writes',
                specialistId: 'scheduler',
                input: { request: 'create two events' },
                dependsOn: [],
              },
            ],
          });
        }
        if (request.phase === 'specialist') {
          return Object.freeze({
            status: 'interrupted' as const,
            serializedState: JSON.stringify({ sdk: 'two-pending-writes' }),
            interruptions: Object.freeze([
              Object.freeze({
                id: 'approval-calendar-1',
                agentId: 'scheduler',
                capabilityId: 'google-calendar.event.create',
                proposalId,
                argumentsPreview: Object.freeze({ title: 'Dentist' }),
                sdkCallId: 'call-calendar-single-provider-1',
                providerAuthorityBindingHash,
                authorizationScopeFingerprint:
                  ids.authorizationScopeFingerprint,
              }),
              Object.freeze({
                id: 'approval-calendar-2',
                agentId: 'scheduler',
                capabilityId: 'google-calendar.event.create',
                proposalId: secondProposalId,
                argumentsPreview: Object.freeze({ title: 'Optometrist' }),
                sdkCallId: 'call-calendar-single-provider-2',
                providerAuthorityBindingHash: secondAuthorityHash,
                authorizationScopeFingerprint:
                  ids.authorizationScopeFingerprint,
              }),
            ]),
            usage: Object.freeze({
              inputTokens: 10,
              outputTokens: 2,
              modelCostCadMinor: 1,
            }),
          });
        }
        return completed({
          message: 'Please create and approve one calendar event at a time.',
        });
      },
      { abandonPrepared, executeDecision },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: {
        code: 'multiple-provider-writes-require-separate-turns',
        retryable: false,
      },
      specialistOutcomes: [
        {
          status: 'failed',
          safeMessage:
            'Each provider write requires a separate assistant turn and visual approval.',
        },
      ],
    });
    expect(abandonPrepared).toHaveBeenCalledTimes(2);
    expect(abandonPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId,
        sdkCallId: 'call-calendar-single-provider-1',
        providerAuthorityBindingHash,
        reason: 'multiple-provider-writes-require-separate-turns',
      }),
    );
    expect(abandonPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: secondProposalId,
        sdkCallId: 'call-calendar-single-provider-2',
        providerAuthorityBindingHash: secondAuthorityHash,
        reason: 'multiple-provider-writes-require-separate-turns',
      }),
    );
    expect(executeDecision).not.toHaveBeenCalled();
    expect(
      traceEvents.filter(
        (event) =>
          event.type === 'approval.interrupted' ||
          event.type === 'action.executed',
      ),
    ).toHaveLength(0);
  });

  it('refuses to checkpoint a provider-write interruption without exact SDK and authority binding', async () => {
    const checkpointCreate = vi.fn<ApprovalCheckpointGateway['create']>(
      async () => {
        throw new Error('must-not-checkpoint-unbound-proposal');
      },
    );
    const abandonPrepared = vi.fn<
      ProviderWriteProposalGateway['abandonPrepared']
    >(async () => ({ status: 'abandoned' as const }));
    const { orchestrator, traceEvents } = setup(
      async (request) => {
        if (request.phase === 'plan') {
          return completed({
            delegations: [
              {
                id: 'unbound-calendar-write',
                specialistId: 'scheduler',
                input: { request: 'create dentist event' },
                dependsOn: [],
              },
            ],
          });
        }
        if (request.phase === 'specialist') {
          return Object.freeze({
            status: 'interrupted' as const,
            serializedState: JSON.stringify({ sdk: 'unbound-proposal' }),
            interruptions: Object.freeze([
              Object.freeze({
                id: 'approval-calendar-unbound',
                agentId: 'scheduler',
                capabilityId: 'google-calendar.event.create',
                proposalId,
                argumentsPreview: Object.freeze({ title: 'Dentist' }),
              }),
            ]),
            usage: Object.freeze({
              inputTokens: 10,
              outputTokens: 2,
              modelCostCadMinor: 1,
            }),
          });
        }
        return completed({ message: 'must not synthesize' });
      },
      { abandonPrepared, checkpointCreate },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: {
        code: 'provider-write-proposal-finalization-pending',
        retryable: false,
      },
    });
    expect(checkpointCreate).not.toHaveBeenCalled();
    expect(abandonPrepared).not.toHaveBeenCalled();
    expect(
      traceEvents.filter((event) => event.type === 'approval.interrupted'),
    ).toHaveLength(0);
  });

  it('abandons every exact proposal when a provider also returns an unbound interruption', async () => {
    const checkpointCreate = vi.fn<ApprovalCheckpointGateway['create']>(
      async () => {
        throw new Error('must-not-checkpoint-mixed-bindings');
      },
    );
    const abandonPrepared = vi.fn<
      ProviderWriteProposalGateway['abandonPrepared']
    >(async () => ({ status: 'abandoned' as const }));
    const { orchestrator, traceEvents } = setup(
      async (request) => {
        if (request.phase === 'plan') {
          return completed({
            delegations: [
              {
                id: 'mixed-bound-calendar-write',
                specialistId: 'scheduler',
                input: { request: 'create two events' },
                dependsOn: [],
              },
            ],
          });
        }
        if (request.phase === 'specialist') {
          return Object.freeze({
            status: 'interrupted' as const,
            serializedState: JSON.stringify({ sdk: 'mixed-bindings' }),
            interruptions: Object.freeze([
              Object.freeze({
                id: 'approval-calendar-bound',
                agentId: 'scheduler',
                capabilityId: 'google-calendar.event.create',
                proposalId,
                argumentsPreview: Object.freeze({ title: 'Dentist' }),
                sdkCallId: 'call-calendar-mixed-bound',
                providerAuthorityBindingHash,
                authorizationScopeFingerprint:
                  ids.authorizationScopeFingerprint,
              }),
              Object.freeze({
                id: 'approval-calendar-unbound-second',
                agentId: 'scheduler',
                capabilityId: 'google-calendar.event.create',
                proposalId: '018f1f5e-1000-7000-8000-000000000062',
                argumentsPreview: Object.freeze({ title: 'Optometrist' }),
              }),
            ]),
            usage: Object.freeze({
              inputTokens: 10,
              outputTokens: 2,
              modelCostCadMinor: 1,
            }),
          });
        }
        return completed({ message: 'must not synthesize' });
      },
      { abandonPrepared, checkpointCreate },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: {
        code: 'provider-write-proposal-finalization-pending',
        retryable: false,
      },
    });
    expect(checkpointCreate).not.toHaveBeenCalled();
    expect(abandonPrepared).toHaveBeenCalledOnce();
    expect(abandonPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId,
        sdkCallId: 'call-calendar-mixed-bound',
        providerAuthorityBindingHash,
        reason: 'execution-ended-before-checkpoint',
      }),
    );
    expect(
      traceEvents.filter(
        (event) =>
          event.type === 'approval.interrupted' ||
          event.type === 'action.executed',
      ),
    ).toHaveLength(0);
  });

  it.each([
    {
      label: 'manager planning',
      interruptedPhase: 'plan' as const,
      interruptionAgentId: 'manager',
      capabilityId: 'google-calendar.event.create',
      schedulerCapabilities: undefined,
    },
    {
      label: 'manager synthesis',
      interruptedPhase: 'synthesize' as const,
      interruptionAgentId: 'manager',
      capabilityId: 'google-calendar.event.create',
      schedulerCapabilities: undefined,
    },
    {
      label: 'a mismatched specialist agent',
      interruptedPhase: 'specialist' as const,
      interruptionAgentId: 'finance',
      capabilityId: 'google-calendar.event.create',
      schedulerCapabilities: Object.freeze([
        capability('google-calendar.event.create', 'provider-write'),
      ]),
    },
    {
      label: 'a non-provider-write capability',
      interruptedPhase: 'specialist' as const,
      interruptionAgentId: 'scheduler',
      capabilityId: 'scheduler.events.read',
      schedulerCapabilities: Object.freeze([
        capability('scheduler.events.read', 'read'),
      ]),
    },
  ])(
    'rejects an exact-bound interruption from $label before checkpoint persistence',
    async ({
      interruptedPhase,
      interruptionAgentId,
      capabilityId,
      schedulerCapabilities,
    }) => {
      const checkpointCreate = vi.fn<ApprovalCheckpointGateway['create']>(
        async () => {
          throw new Error('must-not-checkpoint-invalid-interruption');
        },
      );
      const abandonPrepared = vi.fn<
        ProviderWriteProposalGateway['abandonPrepared']
      >(async () => ({ status: 'abandoned' as const }));
      const interrupted = () =>
        Object.freeze({
          status: 'interrupted' as const,
          serializedState: JSON.stringify({ sdk: interruptedPhase }),
          interruptions: Object.freeze([
            Object.freeze({
              id: `approval-invalid-${interruptedPhase}`,
              agentId: interruptionAgentId,
              capabilityId,
              proposalId,
              argumentsPreview: Object.freeze({ title: 'Dentist' }),
              sdkCallId: `call-invalid-${interruptedPhase}`,
              providerAuthorityBindingHash,
              authorizationScopeFingerprint: ids.authorizationScopeFingerprint,
            }),
          ]),
          usage: Object.freeze({
            inputTokens: 10,
            outputTokens: 2,
            modelCostCadMinor: 1,
          }),
        });
      const { orchestrator, traceEvents } = setup(
        async (request) => {
          if (request.phase === interruptedPhase) return interrupted();
          if (request.phase === 'plan') {
            return completed({
              delegations:
                interruptedPhase === 'synthesize'
                  ? []
                  : [
                      {
                        id: 'invalid-approval-source',
                        specialistId: 'scheduler',
                        input: { request: 'dentist' },
                        dependsOn: [],
                      },
                    ],
            });
          }
          return completed({ message: 'must not complete' });
        },
        {
          abandonPrepared,
          checkpointCreate,
          ...(schedulerCapabilities === undefined
            ? {}
            : { schedulerCapabilities }),
        },
      );

      await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
        status: 'failed',
        safeError: {
          code: 'invalid-provider-write-approval-interruption',
          retryable: false,
        },
      });
      expect(checkpointCreate).not.toHaveBeenCalled();
      expect(abandonPrepared).toHaveBeenCalledOnce();
      expect(abandonPrepared).toHaveBeenCalledWith(
        expect.objectContaining({
          proposalId,
          capabilityId,
          sdkCallId: `call-invalid-${interruptedPhase}`,
          providerAuthorityBindingHash,
          reason: 'execution-ended-before-checkpoint',
          scope: expect.objectContaining({
            agentId:
              interruptedPhase === 'specialist' ? 'scheduler' : 'manager',
          }),
        }),
      );
      expect(
        traceEvents.filter((event) => event.type === 'approval.interrupted'),
      ).toHaveLength(0);
    },
  );

  it('fails the whole turn and abandons every exact-bound proposal from parallel delegations', async () => {
    const secondProposalId = '018f1f5e-1000-7000-8000-000000000062';
    const secondAuthorityHash = 'c'.repeat(64);
    const checkpointCreate = vi.fn<ApprovalCheckpointGateway['create']>(
      async () => {
        throw new Error('must-not-checkpoint-multiple-writes');
      },
    );
    const abandonPrepared = vi.fn<
      ProviderWriteProposalGateway['abandonPrepared']
    >(async () => ({ status: 'abandoned' as const }));
    let specialistIndex = 0;
    const { orchestrator, traceEvents } = setup(
      async (request) => {
        if (request.phase === 'plan') {
          return completed({
            delegations: [
              {
                id: 'calendar-write-a',
                specialistId: 'scheduler',
                input: { request: 'create dentist event' },
                dependsOn: [],
              },
              {
                id: 'calendar-write-b',
                specialistId: 'finance',
                input: { request: 'create optometrist event' },
                dependsOn: [],
              },
            ],
          });
        }
        if (request.phase === 'specialist') {
          const current = specialistIndex;
          specialistIndex += 1;
          const currentProposalId =
            current === 0 ? proposalId : secondProposalId;
          const currentHash =
            current === 0 ? providerAuthorityBindingHash : secondAuthorityHash;
          return Object.freeze({
            status: 'interrupted' as const,
            serializedState: JSON.stringify({ sdk: `pending-${current}` }),
            interruptions: Object.freeze([
              Object.freeze({
                id: `approval-calendar-${current}`,
                agentId: 'scheduler',
                capabilityId: 'google-calendar.event.create',
                proposalId: currentProposalId,
                argumentsPreview: Object.freeze({ index: current }),
                sdkCallId: `call-calendar-parallel-${current}`,
                providerAuthorityBindingHash: currentHash,
                authorizationScopeFingerprint:
                  ids.authorizationScopeFingerprint,
              }),
            ]),
            usage: Object.freeze({
              inputTokens: 10,
              outputTokens: 2,
              modelCostCadMinor: 1,
            }),
          });
        }
        return completed({ message: 'must not synthesize' });
      },
      {
        abandonPrepared,
        checkpointCreate,
        financeCapabilities: Object.freeze([
          capability('google-calendar.event.create', 'provider-write'),
        ]),
      },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: {
        code: 'multiple-provider-writes-require-separate-turns',
        retryable: false,
      },
    });
    expect(checkpointCreate).not.toHaveBeenCalled();
    expect(abandonPrepared).toHaveBeenCalledTimes(2);
    expect(abandonPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId,
        sdkCallId: 'call-calendar-parallel-0',
        providerAuthorityBindingHash,
        reason: 'multiple-provider-writes-require-separate-turns',
      }),
    );
    expect(abandonPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: secondProposalId,
        sdkCallId: 'call-calendar-parallel-1',
        providerAuthorityBindingHash: secondAuthorityHash,
        reason: 'multiple-provider-writes-require-separate-turns',
      }),
    );
    expect(
      traceEvents.filter(
        (event) =>
          event.type === 'approval.interrupted' ||
          event.type === 'action.executed',
      ),
    ).toHaveLength(0);
  });

  it('abandons a collected proposal when result tracing fails before checkpoint persistence', async () => {
    const checkpointCreate = vi.fn<ApprovalCheckpointGateway['create']>(
      async () => {
        throw new Error('must-not-checkpoint-after-trace-failure');
      },
    );
    const abandonPrepared = vi.fn<
      ProviderWriteProposalGateway['abandonPrepared']
    >(async () => ({ status: 'abandoned' as const }));
    let failedTrace = false;
    const { orchestrator } = setup(
      async (request) => {
        if (request.phase === 'plan') {
          return completed({
            delegations: [
              {
                id: 'calendar-write',
                specialistId: 'scheduler',
                input: { request: 'create one event' },
                dependsOn: [],
              },
              {
                id: 'finance-read',
                specialistId: 'finance',
                input: { request: 'summarize budget' },
                dependsOn: [],
              },
            ],
          });
        }
        if (
          request.phase === 'specialist' &&
          request.context.agentId === 'scheduler'
        ) {
          return Object.freeze({
            status: 'interrupted' as const,
            serializedState: JSON.stringify({ sdk: 'pending-calendar-write' }),
            interruptions: Object.freeze([
              Object.freeze({
                id: 'approval-calendar-1',
                agentId: 'scheduler',
                capabilityId: 'google-calendar.event.create',
                proposalId,
                argumentsPreview: Object.freeze({ title: 'Dentist' }),
                sdkCallId: 'call-calendar-trace-failure',
                providerAuthorityBindingHash,
                authorizationScopeFingerprint:
                  ids.authorizationScopeFingerprint,
              }),
            ]),
            usage: Object.freeze({
              inputTokens: 10,
              outputTokens: 2,
              modelCostCadMinor: 1,
            }),
          });
        }
        return completed({ summary: 'Budget is on track.' });
      },
      {
        abandonPrepared,
        checkpointCreate,
        traceAppend: async (event) => {
          if (!failedTrace && event.type === 'specialist.outcome') {
            failedTrace = true;
            throw new Error('trace unavailable');
          }
        },
      },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: {
        code: 'specialist-result-processing-failed',
        retryable: false,
      },
    });
    expect(checkpointCreate).not.toHaveBeenCalled();
    expect(abandonPrepared).toHaveBeenCalledOnce();
    expect(abandonPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId,
        sdkCallId: 'call-calendar-trace-failure',
        providerAuthorityBindingHash,
        reason: 'execution-ended-before-checkpoint',
      }),
    );
  });

  it('requires a new turn when a dependent delegation requests a second write after approval', async () => {
    let specialistCalls = 0;
    const executeDecision = vi.fn<
      ProviderWriteProposalGateway['executeDecision']
    >(async () => ({
      outcome: 'executed-readback-verified' as const,
      output: Object.freeze({ eventProposal: 'created' }),
      idempotencyKey: 'calendar-write-idempotency-sequential',
    }));
    const execute = vi.fn(async (request: AgentProviderRequest) => {
      if (request.phase === 'plan') {
        return completed({
          delegations: [
            {
              id: 'calendar-write-first',
              specialistId: 'scheduler',
              input: { request: 'create dentist event' },
              dependsOn: [],
            },
            {
              id: 'calendar-write-second',
              specialistId: 'finance',
              input: { request: 'create optometrist event' },
              dependsOn: ['calendar-write-first'],
            },
          ],
        });
      }
      if (request.phase === 'specialist') {
        specialistCalls += 1;
        if (specialistCalls === 1) {
          return Object.freeze({
            status: 'interrupted' as const,
            serializedState: JSON.stringify({ sdk: 'pending-first-write' }),
            interruptions: Object.freeze([
              Object.freeze({
                id: 'approval-calendar-first',
                agentId: 'scheduler',
                capabilityId: 'google-calendar.event.create',
                proposalId,
                argumentsPreview: Object.freeze({ title: 'Dentist' }),
                sdkCallId: 'call-calendar-sequential-first',
                providerAuthorityBindingHash,
                authorizationScopeFingerprint:
                  ids.authorizationScopeFingerprint,
              }),
            ]),
            usage: Object.freeze({
              inputTokens: 10,
              outputTokens: 2,
              modelCostCadMinor: 1,
            }),
          });
        }
        expect(request.turnProviderWriteLedger?.priorWriteTerminal).toBe(true);
        return Object.freeze({
          status: 'failed' as const,
          reason: 'multiple-provider-writes' as const,
          replaySafety: 'unsafe' as const,
          usage: Object.freeze({
            inputTokens: 2,
            outputTokens: 0,
            modelCostCadMinor: 1,
          }),
          capabilityCalls: 0,
        });
      }
      return completed({ message: 'must not synthesize' });
    });
    const { orchestrator, traceEvents } = setup(execute, {
      executeDecision,
      financeCapabilities: Object.freeze([
        capability('google-calendar.event.create', 'provider-write'),
      ]),
    });

    const paused = await orchestrator.runTurn(turn());
    if (paused.status !== 'needs-approval') throw new Error('expected pause');
    await expect(
      orchestrator.resumeTurn({
        requestId: '018f1f5e-1000-7000-8000-000000000045',
        runId: ids.runId,
        householdId: ids.householdId,
        userId: ids.userId,
        conversationId: ids.conversationId,
        spaceAccessGrantId: ids.spaceAccessGrantId,
        ...resumeAuthority,
        checkpointId: paused.checkpoint.checkpointId,
        interruptionId: paused.interruptions[0]!.id,
        proposalId,
        approvalDecisionId,
        decision: 'approve',
        approvalChannel: 'authenticated-visual',
        abortSignal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      safeError: {
        code: 'multiple-provider-writes-require-separate-turns',
        retryable: false,
      },
    });
    expect(specialistCalls).toBe(2);
    expect(executeDecision).toHaveBeenCalledOnce();
    expect(
      traceEvents.filter((event) => event.type === 'approval.interrupted'),
    ).toHaveLength(1);
    expect(
      traceEvents.filter((event) => event.type === 'action.executed'),
    ).toHaveLength(1);
    expect(
      execute.mock.calls.filter(([request]) => request.phase === 'synthesize'),
    ).toHaveLength(0);
  });

  it('requires nonretryable reconciliation when prepared-proposal terminalization is unconfirmed', async () => {
    const execute = vi.fn(async (request: AgentProviderRequest) => {
      if (request.phase === 'plan') {
        return completed({
          delegations: [
            {
              id: 'calendar-write',
              specialistId: 'scheduler',
              input: { request: 'create two events' },
              dependsOn: [],
            },
          ],
        });
      }
      if (request.phase === 'specialist') {
        return Object.freeze({
          status: 'failed' as const,
          reason: 'proposal-finalization-pending' as const,
          replaySafety: 'unsafe' as const,
          usage: Object.freeze({
            inputTokens: 0,
            outputTokens: 0,
            modelCostCadMinor: 0,
          }),
          capabilityCalls: 1,
        });
      }
      return completed({ message: 'Proposal reconciliation is required.' });
    });
    const { orchestrator, traceEvents } = setup(execute);

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: {
        code: 'provider-write-proposal-finalization-pending',
        retryable: false,
      },
      specialistOutcomes: [
        {
          status: 'failed',
          safeMessage:
            'A prepared external action could not be terminalized safely. Reconciliation is required before retrying.',
        },
      ],
    });
    expect(
      traceEvents.find((event) => event.type === 'specialist.outcome')
        ?.metadata,
    ).toMatchObject({
      status: 'failed',
      errorCode: 'provider-write-proposal-finalization-pending',
    });
    expect(
      execute.mock.calls.filter(([request]) => request.phase === 'specialist'),
    ).toHaveLength(1);
  });

  it('terminalizes an invocation-bound proposal when checkpoint persistence fails', async () => {
    const abandonPrepared = vi.fn<
      ProviderWriteProposalGateway['abandonPrepared']
    >(async () => ({ status: 'abandoned' as const }));
    const execute = vi.fn(async (request: AgentProviderRequest) => {
      if (request.phase === 'plan') {
        return completed({
          delegations: [
            {
              id: 'calendar-write',
              specialistId: 'scheduler',
              input: { request: 'create one event' },
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
              capabilityId: 'google-calendar.event.create',
              proposalId,
              argumentsPreview: Object.freeze({ title: 'Dentist' }),
              sdkCallId: 'call-calendar-checkpoint-failure',
              providerAuthorityBindingHash,
              authorizationScopeFingerprint: ids.authorizationScopeFingerprint,
            }),
          ]),
          usage: Object.freeze({
            inputTokens: 10,
            outputTokens: 2,
            modelCostCadMinor: 1,
          }),
        });
      }
      return completed({ message: 'unreachable' });
    });
    const { orchestrator, traceEvents } = setup(execute, {
      failCheckpointCreate: true,
      abandonPrepared,
    });

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: {
        code: 'approval-checkpoint-persistence-failed',
        retryable: true,
      },
    });
    expect(abandonPrepared).toHaveBeenCalledWith({
      proposalId,
      capabilityId: 'google-calendar.event.create',
      sdkCallId: 'call-calendar-checkpoint-failure',
      providerAuthorityBindingHash,
      reason: 'execution-ended-before-checkpoint',
      scope: {
        requestId: ids.requestId,
        runId: ids.runId,
        householdId: ids.householdId,
        userId: ids.userId,
        authenticatedSessionId: ids.authenticatedSessionId,
        spaceAccessGrantId: ids.spaceAccessGrantId,
        disclosureGrantId: ids.disclosureGrantId,
        disclosurePolicyVersion: '1.0.0',
        agentId: 'scheduler',
      },
    });
    expect(
      traceEvents.filter((event) => event.type === 'approval.interrupted'),
    ).toHaveLength(0);
  });

  it('cancels a checkpoint whose create committed before reporting failure', async () => {
    const abandonPrepared = vi.fn<
      ProviderWriteProposalGateway['abandonPrepared']
    >(async () => ({ status: 'abandoned' as const }));
    const execute = vi.fn(async (request: AgentProviderRequest) => {
      if (request.phase === 'plan') {
        return completed({
          delegations: [
            {
              id: 'calendar-write',
              specialistId: 'scheduler',
              input: { request: 'create one event' },
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
              id: 'approval-calendar-create-ambiguous',
              agentId: 'scheduler',
              capabilityId: 'google-calendar.event.create',
              proposalId,
              argumentsPreview: Object.freeze({ title: 'Dentist' }),
              sdkCallId: 'call-calendar-create-ambiguous',
              providerAuthorityBindingHash,
              authorizationScopeFingerprint: ids.authorizationScopeFingerprint,
            }),
          ]),
          usage: Object.freeze({
            inputTokens: 10,
            outputTokens: 2,
            modelCostCadMinor: 1,
          }),
        });
      }
      return completed({ message: 'unreachable' });
    });
    const { cancelCheckpoint, checkpoints, orchestrator } = setup(execute, {
      abandonPrepared,
      failCheckpointCreateAfterPersist: true,
    });

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: {
        code: 'approval-checkpoint-persistence-failed',
        retryable: true,
      },
    });
    expect(cancelCheckpoint).toHaveBeenCalledWith({
      checkpointId: '018f1f5e-1000-7000-8000-000000000030',
      householdId: ids.householdId,
      userId: ids.userId,
    });
    expect(abandonPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId,
        sdkCallId: 'call-calendar-create-ambiguous',
        providerAuthorityBindingHash,
        reason: 'execution-ended-before-checkpoint',
      }),
    );
    await expect(
      checkpoints.consumeForResume({
        checkpointId: '018f1f5e-1000-7000-8000-000000000030',
        householdId: ids.householdId,
        userId: ids.userId,
        runId: ids.runId,
        agentGraphHash: graphHash,
        sdkVersion,
      }),
    ).resolves.toEqual({ status: 'already-consumed' });
  });

  it('cancels the checkpoint and proposal when interruption audit persistence fails', async () => {
    const abandonPrepared = vi.fn<
      ProviderWriteProposalGateway['abandonPrepared']
    >(async () => ({ status: 'abandoned' as const }));
    const executeDecision =
      vi.fn<ProviderWriteProposalGateway['executeDecision']>();
    const { cancelCheckpoint, checkpoints, orchestrator, traceEvents } = setup(
      async (request) => {
        if (request.phase === 'plan') {
          return completed({
            delegations: [
              {
                id: 'calendar-write',
                specialistId: 'scheduler',
                input: { request: 'create one event' },
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
                id: 'approval-calendar-audit-failure',
                agentId: 'scheduler',
                capabilityId: 'google-calendar.event.create',
                proposalId,
                argumentsPreview: Object.freeze({ title: 'Dentist' }),
                sdkCallId: 'call-calendar-audit-failure',
                providerAuthorityBindingHash,
                authorizationScopeFingerprint:
                  ids.authorizationScopeFingerprint,
              }),
            ]),
            usage: Object.freeze({
              inputTokens: 10,
              outputTokens: 2,
              modelCostCadMinor: 1,
            }),
          });
        }
        return completed({ message: 'must not synthesize' });
      },
      {
        abandonPrepared,
        executeDecision,
        traceAppend: async (event) => {
          if (event.type === 'approval.interrupted') {
            throw new Error('approval audit unavailable');
          }
        },
      },
    );

    await expect(orchestrator.runTurn(turn())).resolves.toMatchObject({
      status: 'failed',
      safeError: {
        code: 'approval-interruption-audit-failed',
        retryable: false,
      },
    });
    expect(cancelCheckpoint).toHaveBeenCalledWith({
      checkpointId: '018f1f5e-1000-7000-8000-000000000030',
      householdId: ids.householdId,
      userId: ids.userId,
    });
    expect(abandonPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId,
        sdkCallId: 'call-calendar-audit-failure',
        providerAuthorityBindingHash,
        reason: 'execution-ended-before-checkpoint',
      }),
    );
    await expect(
      checkpoints.consumeForResume({
        checkpointId: '018f1f5e-1000-7000-8000-000000000030',
        householdId: ids.householdId,
        userId: ids.userId,
        runId: ids.runId,
        agentGraphHash: graphHash,
        sdkVersion,
      }),
    ).resolves.toEqual({ status: 'already-consumed' });
    expect(executeDecision).not.toHaveBeenCalled();
    expect(
      traceEvents.filter(
        (event) =>
          event.type === 'approval.interrupted' ||
          event.type === 'action.executed',
      ),
    ).toHaveLength(0);
  });

  it('rejects a legacy authenticated checkpoint containing multiple paused writes without dispatch', async () => {
    const execute = vi.fn<AgentExecutionProvider['execute']>();
    const executeDecision =
      vi.fn<ProviderWriteProposalGateway['executeDecision']>();
    const validateDecision =
      vi.fn<ProviderWriteProposalGateway['validateDecision']>();
    const { checkpoints, orchestrator, traceEvents } = setup(execute, {
      executeDecision,
      validateDecision,
    });
    const secondProposalId = '018f1f5e-1000-7000-8000-000000000062';
    const checkpointId = '018f1f5e-1000-7000-8000-000000000030';
    const pausedExecution = (
      executionKey: string,
      interruptionId: string,
      boundProposalId: string,
      sdkCallId: string,
      authorityHash: string,
    ) => ({
      phase: 'specialist',
      executionKey,
      agentId: 'scheduler',
      serializedState: JSON.stringify({ sdk: executionKey }),
      interruptions: [
        {
          id: interruptionId,
          agentId: 'scheduler',
          capabilityId: 'google-calendar.event.create',
          proposalId: boundProposalId,
          argumentsPreview: { title: executionKey },
          sdkCallId,
          providerAuthorityBindingHash: authorityHash,
          authorizationScopeFingerprint: ids.authorizationScopeFingerprint,
        },
      ],
      usage: { inputTokens: 10, outputTokens: 2, modelCostCadMinor: 1 },
      capabilityCalls: 1,
      disclosureGrantId: ids.disclosureGrantId,
      disclosureGrantVersion: '1.0.0',
    });
    await checkpoints.create({
      checkpointId,
      householdId: ids.householdId,
      userId: ids.userId,
      runId: ids.runId,
      agentGraphHash: graphHash,
      sdkVersion,
      ttlMs: 10 * 60 * 1_000,
      serializedState: JSON.stringify({
        version: 1,
        turn: {
          runId: ids.runId,
          householdId: ids.householdId,
          userId: ids.userId,
          conversationId: ids.conversationId,
          spaceAccessGrantId: ids.spaceAccessGrantId,
          disclosureGrantId: ids.disclosureGrantId,
          message: 'create two events',
        },
        modelResolution: defaultResolution,
        plan: {
          delegations: [
            {
              id: 'legacy-calendar-a',
              specialistId: 'scheduler',
              input: { request: 'dentist' },
              dependsOn: [],
            },
            {
              id: 'legacy-calendar-b',
              specialistId: 'scheduler',
              input: { request: 'optometrist' },
              dependsOn: [],
            },
          ],
        },
        outcomes: [],
        paused: [
          pausedExecution(
            'legacy-calendar-a',
            'legacy-approval-a',
            proposalId,
            'call-legacy-calendar-a',
            providerAuthorityBindingHash,
          ),
          pausedExecution(
            'legacy-calendar-b',
            'legacy-approval-b',
            secondProposalId,
            'call-legacy-calendar-b',
            'c'.repeat(64),
          ),
        ],
        usage: { inputTokens: 20, outputTokens: 4, modelCostCadMinor: 2 },
      }),
    });

    await expect(
      orchestrator.resumeTurn({
        requestId: '018f1f5e-1000-7000-8000-000000000046',
        runId: ids.runId,
        householdId: ids.householdId,
        userId: ids.userId,
        conversationId: ids.conversationId,
        spaceAccessGrantId: ids.spaceAccessGrantId,
        ...resumeAuthority,
        checkpointId,
        interruptionId: 'legacy-calendar-a:legacy-approval-a',
        proposalId,
        approvalDecisionId,
        decision: 'approve',
        approvalChannel: 'authenticated-visual',
        abortSignal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      safeError: {
        code: 'approval-checkpoint-mismatch',
        retryable: false,
      },
    });
    expect(validateDecision).not.toHaveBeenCalled();
    expect(executeDecision).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(
      traceEvents.filter((event) => event.type === 'action.executed'),
    ).toHaveLength(0);
  });

  it('persists encrypted SDK interruption state and resumes only from authenticated visual approval', async () => {
    const resumeRequestId = '018f1f5e-1000-7000-8000-000000000041';
    const resumeSpaceAccessGrantId = '018f1f5e-1000-7000-8000-000000000064';
    const execute = vi.fn(async (request: AgentProviderRequest) => {
      if (request.phase === 'plan') {
        return completed({
          delegations: [
            {
              id: 'calendar-write',
              specialistId: 'scheduler',
              input: { title: 'Dentist' },
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
              capabilityId: 'google-calendar.event.create',
              proposalId,
              argumentsPreview: Object.freeze({
                proposalId,
                arguments: Object.freeze({ title: 'Dentist' }),
              }),
              sdkCallId: 'call-calendar-resume-binding',
              providerAuthorityBindingHash,
              authorizationScopeFingerprint: ids.authorizationScopeFingerprint,
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
        expect(request.resume).toMatchObject({
          serializedState: JSON.stringify({ sdk: 'pending-calendar-write' }),
          decision: {
            interruptionId: 'approval-calendar-1',
            decision: 'approve',
          },
        });
        expect(request.context.approvalDecisionId).toBe(approvalDecisionId);
        expect(request.context.locale).toBe('en-CA');
        return completed({ eventProposal: 'ready' });
      }
      if (request.phase === 'synthesize') {
        expect(request.context.requestId).toBe(resumeRequestId);
        expect(request.context.spaceAccessGrantId).toBe(
          resumeSpaceAccessGrantId,
        );
        expect(request.context.locale).toBe('en-CA');
      }
      return completed({
        message: 'The calendar proposal is ready to review.',
      });
    });
    const { appendManagerMessage, orchestrator, traceEvents } = setup(execute, {
      validateDecision: async (input) => {
        expect(input.context.requestId).toBe(resumeRequestId);
        expect(input.context.spaceAccessGrantId).toBe(resumeSpaceAccessGrantId);
        expect(input.preparationContext.requestId).toBe(ids.requestId);
        expect(input.preparationContext.spaceAccessGrantId).toBe(
          ids.spaceAccessGrantId,
        );
        return (
          input.approvalDecisionId === approvalDecisionId &&
          input.proposalId === proposalId
        );
      },
    });

    const paused = await orchestrator.runTurn(turn());

    expect(paused).toMatchObject({
      status: 'needs-approval',
      interruptions: [
        {
          id: 'calendar-write:approval-calendar-1',
          agentId: 'scheduler',
          capabilityId: 'google-calendar.event.create',
          proposalId,
        },
      ],
      checkpoint: {
        checkpointId: '018f1f5e-1000-7000-8000-000000000030',
        runId: ids.runId,
        householdId: ids.householdId,
        userId: ids.userId,
        agentGraphHash: graphHash,
        sdkVersion,
        state: 'pending',
      },
    });
    expect(JSON.stringify(paused)).not.toContain('serializedState');
    expect(JSON.stringify(paused)).not.toContain('pending-calendar-write');

    if (paused.status !== 'needs-approval') throw new Error('not paused');
    await expect(
      orchestrator.resumeTurn({
        requestId: '018f1f5e-1000-7000-8000-000000000040',
        runId: ids.runId,
        householdId: ids.householdId,
        userId: ids.userId,
        conversationId: ids.conversationId,
        spaceAccessGrantId: ids.spaceAccessGrantId,
        ...resumeAuthority,
        checkpointId: paused.checkpoint.checkpointId,
        interruptionId: paused.interruptions[0]!.id,
        proposalId,
        approvalDecisionId,
        decision: 'approve',
        approvalChannel: 'typed' as never,
        abortSignal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      safeError: { code: 'invalid-approval-channel' },
    });

    for (const tampered of [
      {
        interruptionId: 'calendar-write:approval-calendar-2',
        proposalId,
        approvalDecisionId,
      },
      {
        interruptionId: paused.interruptions[0]!.id,
        proposalId: '018f1f5e-1000-7000-8000-000000000062',
        approvalDecisionId,
      },
      {
        interruptionId: paused.interruptions[0]!.id,
        proposalId,
        approvalDecisionId: '018f1f5e-1000-7000-8000-000000000063',
      },
    ]) {
      await expect(
        orchestrator.resumeTurn({
          requestId: '018f1f5e-1000-7000-8000-000000000043',
          runId: ids.runId,
          householdId: ids.householdId,
          userId: ids.userId,
          conversationId: ids.conversationId,
          spaceAccessGrantId: ids.spaceAccessGrantId,
          ...resumeAuthority,
          checkpointId: paused.checkpoint.checkpointId,
          ...tampered,
          decision: 'approve',
          approvalChannel: 'authenticated-visual',
          abortSignal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        status: 'failed',
        safeError: { code: 'approval-checkpoint-mismatch' },
      });
    }

    const resumed = await orchestrator.resumeTurn({
      requestId: resumeRequestId,
      runId: ids.runId,
      householdId: ids.householdId,
      userId: ids.userId,
      conversationId: ids.conversationId,
      spaceAccessGrantId: resumeSpaceAccessGrantId,
      ...resumeAuthority,
      checkpointId: paused.checkpoint.checkpointId,
      interruptionId: paused.interruptions[0]!.id,
      proposalId,
      approvalDecisionId,
      decision: 'approve',
      approvalChannel: 'authenticated-visual',
      abortSignal: new AbortController().signal,
    });

    expect(resumed).toMatchObject({
      status: 'completed',
      output: { message: 'The calendar proposal is ready to review.' },
    });
    expect(appendManagerMessage).toHaveBeenCalledTimes(2);
    expect(traceEvents.map((event) => event.type)).toContain(
      'approval.interrupted',
    );
    expect(
      traceEvents.find((event) => event.type === 'approval.interrupted')
        ?.metadata,
    ).toMatchObject({
      checkpointId: '018f1f5e-1000-7000-8000-000000000030',
      proposalId,
      capabilityId: 'google-calendar.event.create',
      channel: 'authenticated-visual',
    });
    expect(execute.mock.calls.map(([request]) => request.phase)).toEqual([
      'plan',
      'specialist',
      'synthesize',
    ]);

    await expect(
      orchestrator.resumeTurn({
        requestId: '018f1f5e-1000-7000-8000-000000000042',
        runId: ids.runId,
        householdId: ids.householdId,
        userId: ids.userId,
        conversationId: ids.conversationId,
        spaceAccessGrantId: ids.spaceAccessGrantId,
        ...resumeAuthority,
        checkpointId: paused.checkpoint.checkpointId,
        interruptionId: paused.interruptions[0]!.id,
        proposalId,
        approvalDecisionId,
        decision: 'approve',
        approvalChannel: 'authenticated-visual',
        abortSignal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      safeError: { code: 'approval-checkpoint-already-consumed' },
    });
  });

  it('resumes an approved write by dispatching its ready dependent specialist', async () => {
    const requests: AgentProviderRequest[] = [];
    const execute = vi.fn(async (request: AgentProviderRequest) => {
      requests.push(request);
      if (request.phase === 'plan') {
        return completed({
          delegations: [
            {
              id: 'calendar-write',
              specialistId: 'scheduler',
              input: { title: 'Dentist' },
              dependsOn: [],
            },
            {
              id: 'finance-after-calendar',
              specialistId: 'finance',
              input: { request: 'update the monthly budget' },
              dependsOn: ['calendar-write'],
            },
          ],
        });
      }
      if (request.phase === 'specialist') {
        const records = (
          request.input as Readonly<{
            readonly records: readonly Readonly<{
              readonly fields: Readonly<{
                readonly delegation?: Readonly<{ readonly id: string }>;
              }>;
            }>[];
          }>
        ).records;
        const delegationId = records.find(
          (record) => record.fields.delegation !== undefined,
        )?.fields.delegation?.id;
        if (delegationId === 'calendar-write') {
          return Object.freeze({
            status: 'interrupted' as const,
            serializedState: JSON.stringify({ sdk: 'pending-calendar-write' }),
            interruptions: Object.freeze([
              Object.freeze({
                id: 'approval-calendar-1',
                agentId: 'scheduler',
                capabilityId: 'google-calendar.event.create',
                proposalId,
                argumentsPreview: Object.freeze({ title: 'Dentist' }),
                sdkCallId: 'call-calendar-approved-dependency',
                providerAuthorityBindingHash,
                authorizationScopeFingerprint:
                  ids.authorizationScopeFingerprint,
              }),
            ]),
            usage: Object.freeze({
              inputTokens: 10,
              outputTokens: 2,
              modelCostCadMinor: 1,
            }),
          });
        }
        expect(delegationId).toBe('finance-after-calendar');
        expect(records).toHaveLength(2);
        expect(records).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              dataClass: 'agent.delegations',
              fields: expect.objectContaining({
                delegation: expect.objectContaining({
                  id: 'finance-after-calendar',
                }),
              }),
            }),
            expect.objectContaining({
              dataClass: 'agent.specialist-outcomes',
              fields: expect.objectContaining({
                outcome: expect.objectContaining({
                  delegationId: 'calendar-write',
                  status: 'completed',
                  facts: { eventProposal: 'ready' },
                }),
              }),
            }),
          ]),
        );
        return completed({ budgetUpdated: true });
      }
      return completed({ message: 'Calendar and budget are up to date.' });
    });
    const { orchestrator } = setup(execute);

    const paused = await orchestrator.runTurn(turn());
    if (paused.status !== 'needs-approval') throw new Error('not paused');

    await expect(
      orchestrator.resumeTurn({
        requestId: '018f1f5e-1000-7000-8000-000000000071',
        runId: ids.runId,
        householdId: ids.householdId,
        userId: ids.userId,
        conversationId: ids.conversationId,
        spaceAccessGrantId: ids.spaceAccessGrantId,
        ...resumeAuthority,
        checkpointId: paused.checkpoint.checkpointId,
        interruptionId: paused.interruptions[0]!.id,
        proposalId,
        approvalDecisionId,
        decision: 'approve',
        approvalChannel: 'authenticated-visual',
        abortSignal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      specialistOutcomes: [
        { delegationId: 'calendar-write', status: 'completed' },
        { delegationId: 'finance-after-calendar', status: 'completed' },
      ],
    });
    expect(requests.map((request) => request.phase)).toEqual([
      'plan',
      'specialist',
      'specialist',
      'synthesize',
    ]);
  });

  it('synthesizes rejected and blocked delegations without dispatching unfinished specialists', async () => {
    let synthesisInput: JsonValue | undefined;
    const execute = vi.fn(async (request: AgentProviderRequest) => {
      if (request.phase === 'plan') {
        return completed({
          delegations: [
            {
              id: 'calendar-write',
              specialistId: 'scheduler',
              input: { title: 'Dentist' },
              dependsOn: [],
            },
            {
              id: 'finance-after-calendar',
              specialistId: 'finance',
              input: { request: 'update the monthly budget' },
              dependsOn: ['calendar-write'],
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
              capabilityId: 'google-calendar.event.create',
              proposalId,
              argumentsPreview: Object.freeze({ title: 'Dentist' }),
              sdkCallId: 'call-calendar-rejected-dependency',
              providerAuthorityBindingHash,
              authorizationScopeFingerprint: ids.authorizationScopeFingerprint,
            }),
          ]),
          usage: Object.freeze({
            inputTokens: 10,
            outputTokens: 2,
            modelCostCadMinor: 1,
          }),
        });
      }
      synthesisInput = request.input;
      return completed({ message: 'The calendar action was not approved.' });
    });
    const { orchestrator, traceEvents } = setup(execute);

    const paused = await orchestrator.runTurn(turn());
    if (paused.status !== 'needs-approval') throw new Error('not paused');

    const result = await orchestrator.resumeTurn({
      requestId: '018f1f5e-1000-7000-8000-000000000072',
      runId: ids.runId,
      householdId: ids.householdId,
      userId: ids.userId,
      conversationId: ids.conversationId,
      spaceAccessGrantId: ids.spaceAccessGrantId,
      ...resumeAuthority,
      checkpointId: paused.checkpoint.checkpointId,
      interruptionId: paused.interruptions[0]!.id,
      proposalId,
      approvalDecisionId,
      decision: 'reject',
      approvalChannel: 'authenticated-visual',
      abortSignal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'completed',
      hasPartialFailures: true,
      specialistOutcomes: [
        {
          delegationId: 'calendar-write',
          status: 'failed',
          safeMessage: 'The requested provider action was not approved.',
        },
        {
          delegationId: 'finance-after-calendar',
          status: 'unavailable',
          reasonCode: 'approval-rejected-dependency-unavailable',
        },
      ],
    });
    expect(execute.mock.calls.map(([request]) => request.phase)).toEqual([
      'plan',
      'specialist',
      'synthesize',
    ]);
    expect(
      traceEvents.filter((event) => event.type === 'action.executed'),
    ).toHaveLength(0);
    expect(synthesisInput).toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({
          dataClass: 'agent.specialist-outcomes',
          fields: expect.objectContaining({
            outcome: expect.objectContaining({
              delegationId: 'calendar-write',
              status: 'failed',
              safeMessage: 'The requested provider action was not approved.',
            }),
          }),
        }),
        expect.objectContaining({
          dataClass: 'agent.specialist-outcomes',
          fields: expect.objectContaining({
            outcome: expect.objectContaining({
              delegationId: 'finance-after-calendar',
              status: 'unavailable',
              reasonCode: 'approval-rejected-dependency-unavailable',
            }),
          }),
        }),
      ]),
    });
  });

  it('requires reconciliation and never redispatches after an approved write has an indeterminate SDK failure', async () => {
    let resumeCalls = 0;
    const execute = vi.fn(async (request: AgentProviderRequest) => {
      if (request.phase === 'plan') {
        return completed({
          delegations: [
            {
              id: 'calendar-write',
              specialistId: 'scheduler',
              input: { request: 'dentist' },
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
              capabilityId: 'google-calendar.event.create',
              proposalId,
              argumentsPreview: Object.freeze({ title: 'Dentist' }),
              sdkCallId: 'call-calendar-indeterminate-binding',
              providerAuthorityBindingHash,
              authorizationScopeFingerprint: ids.authorizationScopeFingerprint,
            }),
          ]),
          usage: Object.freeze({
            inputTokens: 10,
            outputTokens: 2,
            modelCostCadMinor: 1,
          }),
        });
      }
      throw new Error('synthesis must not run after an indeterminate write');
    });
    const { orchestrator } = setup(execute, {
      validateDecision: async () => true,
      executeDecision: async () => {
        resumeCalls += 1;
        throw new Error('provider failed after the approved write');
      },
    });
    const paused = await orchestrator.runTurn(turn());
    if (paused.status !== 'needs-approval') throw new Error('not paused');
    const resumeInput = {
      requestId: '018f1f5e-1000-7000-8000-000000000041',
      runId: ids.runId,
      householdId: ids.householdId,
      userId: ids.userId,
      conversationId: ids.conversationId,
      spaceAccessGrantId: ids.spaceAccessGrantId,
      ...resumeAuthority,
      checkpointId: paused.checkpoint.checkpointId,
      interruptionId: paused.interruptions[0]!.id,
      proposalId,
      approvalDecisionId,
      decision: 'approve' as const,
      approvalChannel: 'authenticated-visual' as const,
      abortSignal: new AbortController().signal,
    };

    await expect(orchestrator.resumeTurn(resumeInput)).resolves.toMatchObject({
      status: 'failed',
      safeError: {
        code: 'approved-action-outcome-unknown',
        retryable: false,
      },
    });
    await expect(
      orchestrator.resumeTurn({
        ...resumeInput,
        requestId: '018f1f5e-1000-7000-8000-000000000042',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      safeError: { code: 'approval-checkpoint-already-consumed' },
    });
    expect(resumeCalls).toBe(1);
  });
});

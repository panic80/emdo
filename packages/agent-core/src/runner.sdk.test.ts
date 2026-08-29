import { Agent, RunContext, RunToolApprovalItem } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  EffectiveAuthorizationScopeFingerprintSchema,
  parseProviderWriteCapabilityDescriptor,
} from '@emdo/contracts';

import type { AgentCapabilityReference, CompiledAgent } from './factory.js';
import {
  createOpenAiAgentsSdkFacade,
  MANAGER_PLAN_OUTPUT_SCHEMA,
  OpenAiAgentsExecutionProvider,
  type AgentExecutionContext,
  type AgentProviderRequest,
  type OpenAiAgentsRunnerPort,
  type ProviderWriteProposalGateway,
} from './runner.js';

const modelPolicy = Object.freeze({
  defaultModel: 'gpt-5.6-luna' as const,
  complexModel: 'gpt-5.6-terra' as const,
  escalationReasons: Object.freeze([
    'dependent-cross-domain',
    'failed-output-validation',
    'low-confidence-reconciliation',
    'luna-unavailable',
    'complex-reasoning',
  ] as const),
});

const proposalId = '018f1f5e-1000-7000-8000-000000000070';
const providerAuthorityBindingHash = 'a'.repeat(64);
const authorizationScopeFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse('e'.repeat(64));
const providerWriteCapabilityDescriptor =
  parseProviderWriteCapabilityDescriptor({
    schemaVersion: 1,
    id: 'google-calendar.event.create',
    version: '1.0.0',
    capabilityKind: 'provider-write',
    inputSchema: {
      id: 'google-calendar.event.create.input',
      version: '1.0.0',
    },
    outputSchema: {
      id: 'google-calendar.event.create.output',
      version: '1.0.0',
    },
    requiredScopes: ['google-calendar.events.write'],
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
      eventType: 'google-calendar.event.create.provider-write',
      redactFields: [],
    },
    executorId: 'google-calendar.event.create.v1',
  });
const providerWriteCapabilityId = providerWriteCapabilityDescriptor.id;

const context: AgentExecutionContext = Object.freeze({
  requestId: '018f1f5e-1000-7000-8000-000000000001',
  runId: '018f1f5e-1000-7000-8000-000000000002',
  householdId: '018f1f5e-1000-7000-8000-000000000003',
  userId: '018f1f5e-1000-7000-8000-000000000004',
  authenticatedSessionId: '018f1f5e-1000-7000-8000-000000000008',
  spaceAccessGrantId: '018f1f5e-1000-7000-8000-000000000006',
  authorizationScopeFingerprint,
  locale: 'en-CA',
  disclosureGrantId: '018f1f5e-1000-7000-8000-000000000007',
  disclosureGrantVersion: '1.0.0',
  agentId: 'scheduler',
  abortSignal: new AbortController().signal,
});

const proposalGateway = (): ProviderWriteProposalGateway => ({
  prepare: vi.fn(async () => ({
    proposalId,
    providerAuthorityBindingHash,
    authorizationScopeFingerprint,
    preview: { before: null, after: { title: 'Dentist' } },
  })),
  resolvePrepared: vi.fn(async () => ({
    proposalId,
    providerAuthorityBindingHash,
    authorizationScopeFingerprint,
    preview: { before: null, after: { title: 'Dentist' } },
  })),
  abandonPrepared: vi.fn(async () => ({ status: 'abandoned' as const })),
  validateDecision: vi.fn(async () => true),
  executeDecision: vi.fn(async ({ decision }) => ({
    outcome:
      decision === 'approve'
        ? ('executed-readback-verified' as const)
        : ('rejected' as const),
    output: { summary: 'Provider decision recorded.' },
    idempotencyKey: 'calendar-write-idempotency-1',
  })),
});

const spendGuard = (
  reserveStatus: 'reserved' | 'blocked' = 'reserved',
  warning = false,
) => ({
  reserve: vi.fn(async ({ reservationId }: { reservationId: string }) =>
    reserveStatus === 'blocked'
      ? {
          status: 'blocked' as const,
          warning: true as const,
          period: '2026-08',
          currentCadMinor: 7_500,
          safeError: {
            code: 'monthly-ai-spend-limit-reached' as const,
            message: 'The monthly AI spend limit has been reached.' as const,
            retryable: false as const,
          },
        }
      : {
          status: 'reserved' as const,
          warning,
          period: '2026-08',
          projectedCadMinor: warning ? 5_000 : 1,
          reservationId,
        },
  ),
  markDispatched: vi.fn(
    async ({ reservationId }: { reservationId: string }) => ({
      status: 'dispatched' as const,
      period: '2026-08',
      reservationId,
    }),
  ),
  settle: vi.fn(
    async ({
      reservationId,
      actualCadMinor,
    }: {
      reservationId: string;
      actualCadMinor: number;
    }) => ({
      status: 'settled' as const,
      period: '2026-08',
      reservationId,
      actualCadMinor,
      reservationExceeded: false,
    }),
  ),
  release: vi.fn(async ({ reservationId }: { reservationId: string }) => ({
    status: 'released' as const,
    period: '2026-08',
    reservationId,
  })),
});

const compiledAgentWithCapability = (
  capabilityKind: AgentCapabilityReference['kind'],
  gateway: ProviderWriteProposalGateway,
): CompiledAgent<Agent<AgentExecutionContext, z.ZodObject>> => {
  const capabilityId =
    capabilityKind === 'provider-write'
      ? providerWriteCapabilityId
      : `scheduler.${capabilityKind}`;
  const facade = createOpenAiAgentsSdkFacade({ proposalGateway: gateway });
  const parameters = z.strictObject({ request: z.string() });
  const outputSchema = z.strictObject({ summary: z.string() });
  const sdkTool =
    capabilityKind === 'provider-write'
      ? facade.createTool({
          canonicalCapabilityId: providerWriteCapabilityId,
          capabilityKind: 'provider-write',
          name: providerWriteCapabilityId
            .replaceAll('.', '_')
            .replaceAll('-', '_'),
          description: 'Exercise one scoped capability.',
          parameters,
          needsApproval: true,
          timeoutMs: 10_000,
          execute: vi.fn(async () => ({ ok: true })),
        })
      : facade.createTool({
          canonicalCapabilityId: capabilityId,
          capabilityKind,
          name: capabilityId.replaceAll('.', '_').replaceAll('-', '_'),
          description: 'Exercise one scoped capability.',
          parameters,
          needsApproval: false,
          timeoutMs: 10_000,
          execute: vi.fn(async () => ({ ok: true })),
        });
  const resolvedCapability =
    capabilityKind === 'provider-write'
      ? {
          descriptor: providerWriteCapabilityDescriptor,
          invoke: vi.fn(async () => ({ ok: true })),
        }
      : {
          descriptor: {
            id: capabilityId,
            version: '1.0.0',
            capabilityKind,
            requiredDataClasses: [],
            riskClass:
              capabilityKind === 'delegation'
                ? ('none' as const)
                : capabilityKind === 'import'
                  ? ('local-write' as const)
                  : capabilityKind,
            inputSchema: {
              id: `${capabilityId}.input`,
              version: '1.0.0',
            },
            timeoutMs: 10_000,
            approval: { rule: 'none' as const },
          },
          invoke: vi.fn(async () => ({ ok: true })),
        };
  return {
    manifest: {
      schemaVersion: 1,
      id: 'scheduler',
      version: '1.0.0',
      kind: 'specialist',
      instructionIds: ['scheduler.instructions.v1'],
      skillIds: ['privacy.v1'],
      capabilityAllowlist: [capabilityId],
      readableDataClasses: ['scheduler.records'],
      riskCeiling: 'provider-write',
      modelPolicy,
      executionBudget: {
        maxTurns: 12,
        maxCapabilityCalls: 8,
        maxParallelCalls: 3,
        timeoutMs: 30_000,
        maxInputTokens: 20_000,
        maxOutputTokens: 4_000,
      },
      schemaRefs: {
        input: { id: 'scheduler.input', version: '1.0.0' },
        output: { id: 'scheduler.output', version: '1.0.0' },
      },
    },
    instructions: 'Schedule safely.',
    capabilities: [resolvedCapability],
    inputSchema: parameters,
    outputSchema,
    materialize: (model, options) =>
      facade.createAgent({
        name: 'scheduler',
        instructions: 'Schedule safely.',
        model,
        tools: options?.exposeCapabilities === false ? [] : [sdkTool],
        outputType: options?.outputType ?? outputSchema,
        maxOutputTokens: 1_000,
      }),
  };
};

const withBudget = (
  compiled: CompiledAgent<Agent<AgentExecutionContext, z.ZodObject>>,
  overrides: Partial<CompiledAgent['manifest']['executionBudget']>,
): CompiledAgent<Agent<AgentExecutionContext, z.ZodObject>> => ({
  ...compiled,
  manifest: {
    ...compiled.manifest,
    executionBudget: {
      ...compiled.manifest.executionBudget,
      ...overrides,
    },
  },
});

const turnProviderWriteLedger = (
  priorWriteTerminal = false,
): NonNullable<AgentProviderRequest['turnProviderWriteLedger']> => ({
  abortController: new AbortController(),
  providerWriteProposalCount: priorWriteTerminal ? 1 : 0,
  multipleProviderWritesRequested: false,
  proposalFinalizationPending: false,
  proposalAbandonmentAttempted: false,
  proposalAbandonmentConfirmed: false,
  priorWriteTerminal,
});

describe('OpenAI Agents SDK boundary', () => {
  it('mints fixed synthesis locale guidance while preserving evidence source language', async () => {
    const gateway = proposalGateway();
    const base = compiledAgentWithCapability('read', gateway);
    const materialize = vi.fn(base.materialize);
    const agent: CompiledAgent<Agent<AgentExecutionContext, z.ZodObject>> = {
      ...base,
      materialize,
    };
    const runner: OpenAiAgentsRunnerPort = {
      run: vi.fn(async () => ({
        state: {
          usage: { inputTokens: 1, outputTokens: 1 },
          getInterruptions: () => [],
          approve: vi.fn(),
          reject: vi.fn(),
          toString: () => JSON.stringify({ sdk: 'complete' }),
        },
        finalOutput: { summary: '完了しました。' },
      })),
    };
    const provider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: spendGuard(),
      inputTokenCounter: { countUpperBound: () => 1 },
      runner,
    });

    await expect(
      provider.execute({
        phase: 'synthesize',
        agent,
        model: 'gpt-5.6-luna',
        input: { sourceExcerpt: 'facture originale' },
        context: { ...context, locale: 'ja-JP' },
        maxTurns: 12,
      }),
    ).resolves.toMatchObject({ status: 'completed' });

    expect(materialize).toHaveBeenCalledWith(
      'gpt-5.6-luna',
      expect.objectContaining({
        trustedInstructions: [
          'Write the final EMDO synthesis in ja-JP. Keep evidence excerpts in their source language; do not translate those excerpts.',
        ],
      }),
    );
  });

  it('materializes real SDK agents and strict approval-aware function tools', async () => {
    const execute = vi.fn(
      async (input: unknown, capabilityContext: unknown) => {
        void input;
        void capabilityContext;
        return { ok: true };
      },
    );
    const executionContext: AgentExecutionContext = Object.freeze({
      ...context,
      approvalDecisionId: '018f1f5e-1000-7000-8000-000000000009',
    });
    const facade = createOpenAiAgentsSdkFacade();
    const parameters = z.strictObject({ request: z.string().min(1) });
    const toolOutputSchema = z.strictObject({ ok: z.boolean() });
    const outputType = z.strictObject({ summary: z.string() });
    const sdkTool = facade.createTool({
      canonicalCapabilityId: 'scheduler.events.read',
      capabilityKind: 'read',
      name: 'scheduler_events_read',
      description: 'Read scoped events.',
      parameters,
      outputSchema: toolOutputSchema,
      needsApproval: false,
      timeoutMs: 10_000,
      execute,
    });
    const sdkAgent = facade.createAgent({
      name: 'scheduler',
      instructions: 'Use scoped data only.',
      model: 'gpt-5.6-luna',
      tools: [sdkTool],
      outputType,
      maxOutputTokens: 1_000,
    });

    expect(sdkAgent).toBeInstanceOf(Agent);
    expect(sdkAgent.outputType).toBe(outputType);
    expect(sdkAgent.modelSettings.maxTokens).toBe(1_000);
    expect(sdkAgent.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        name: 'scheduler_events_read',
        strict: true,
        outputSchema: expect.any(Object),
      }),
    ]);
    const functionTool = sdkAgent.tools[0];
    if (functionTool?.type !== 'function')
      throw new Error('not a function tool');
    await expect(functionTool.needsApproval({} as never, {})).resolves.toBe(
      false,
    );
    await expect(
      functionTool.invoke(
        new RunContext(executionContext),
        JSON.stringify({ request: 'appointments' }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      { request: 'appointments' },
      {
        requestId: executionContext.requestId,
        runId: executionContext.runId,
        userId: executionContext.userId,
        householdId: executionContext.householdId,
        sessionId: executionContext.authenticatedSessionId,
        agentId: executionContext.agentId,
        spaceAccessGrantId: executionContext.spaceAccessGrantId,
        locale: executionContext.locale,
        disclosureGrantId: executionContext.disclosureGrantId,
        approvalDecisionId: executionContext.approvalDecisionId,
        abortSignal: executionContext.abortSignal,
      },
    );
    const capabilityContext = execute.mock.calls[0]?.[1];
    expect(capabilityContext).not.toHaveProperty('authenticatedSessionId');
    expect(capabilityContext).not.toHaveProperty(
      'authorizationScopeFingerprint',
    );
    expect(capabilityContext).not.toHaveProperty('disclosureGrantVersion');
  });

  it('rejects capability results that violate the SDK-facing output schema', async () => {
    const facade = createOpenAiAgentsSdkFacade();
    const sdkTool = facade.createTool({
      canonicalCapabilityId: 'scheduler.events.read',
      capabilityKind: 'read',
      name: 'scheduler_events_read',
      description: 'Read scoped events.',
      parameters: z.strictObject({ request: z.string() }),
      outputSchema: z.strictObject({ ok: z.boolean() }),
      needsApproval: false,
      timeoutMs: 10_000,
      execute: vi.fn(async () => ({ unexpected: true })),
    });

    await expect(
      sdkTool.invoke(
        new RunContext(context),
        JSON.stringify({ request: 'appointments' }),
      ),
    ).rejects.toThrow();
  });

  it('exports a strict, phase-specific manager plan schema', () => {
    expect(
      MANAGER_PLAN_OUTPUT_SCHEMA.parse({
        delegations: [
          {
            id: 'schedule',
            specialistId: 'scheduler',
            input: { request: 'dentist' },
            dependsOn: [],
          },
        ],
        directResponse: null,
      }),
    ).toMatchObject({
      delegations: [{ specialistId: 'scheduler' }],
      directResponse: null,
    });
    expect(() =>
      MANAGER_PLAN_OUTPUT_SCHEMA.parse({
        delegations: [],
        directResponse: null,
        rawCredential: 'forbidden',
      }),
    ).toThrow();
  });

  it('refuses provider-write preparation outside a live provider execution ledger', async () => {
    const gateway = proposalGateway();
    const facade = createOpenAiAgentsSdkFacade({ proposalGateway: gateway });
    const sdkTool = facade.createTool({
      canonicalCapabilityId: providerWriteCapabilityId,
      capabilityKind: 'provider-write',
      name: 'google_calendar_event_create',
      description: 'Create an approved event.',
      parameters: z.strictObject({
        title: z.string(),
        privateNotes: z.string(),
      }),
      needsApproval: true,
      timeoutMs: 10_000,
      execute: vi.fn(async () => ({ ok: true })),
    });

    await expect(
      sdkTool.needsApproval(
        new RunContext(context),
        { title: 'Dentist', privateNotes: 'not for the visual preview' },
        'call-calendar-1',
      ),
    ).rejects.toThrow('provider-write-live-execution-ledger-required');
    expect(gateway.prepare).not.toHaveBeenCalled();
    await expect(
      sdkTool.needsApproval(new RunContext(context), {
        title: 'Dentist',
        privateNotes: 'hidden',
      }),
    ).rejects.toThrow('provider-write-call-id-required');
  });

  it('rejects a detached provider-write callback after the SDK run has settled', async () => {
    const gateway = proposalGateway();
    const compiled = compiledAgentWithCapability('provider-write', gateway);
    let invokeLateApproval: (() => Promise<boolean>) | undefined;
    const state = {
      usage: { inputTokens: 10, outputTokens: 2 },
      getInterruptions: () => [],
      approve: vi.fn(),
      reject: vi.fn(),
      toString: () => JSON.stringify({ sdk: 'complete' }),
    };
    const runner: OpenAiAgentsRunnerPort = {
      run: vi.fn(async (sdkAgent, _input, options) => {
        const functionTool = sdkAgent.tools[0];
        if (functionTool?.type !== 'function') {
          throw new Error('expected function tool');
        }
        const runContext =
          options.context instanceof RunContext
            ? options.context
            : new RunContext(options.context ?? context);
        invokeLateApproval = () =>
          functionTool.needsApproval(
            runContext,
            { request: 'dentist' },
            'call-calendar-detached',
          );
        return { state, finalOutput: { summary: 'No action requested.' } };
      }),
    };
    const provider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: spendGuard(),
      inputTokenCounter: { countUpperBound: () => 1 },
      runner,
    });

    await expect(
      provider.execute({
        phase: 'specialist',
        agent: compiled,
        model: 'gpt-5.6-luna',
        input: { request: 'dentist' },
        context,
        maxTurns: 12,
      }),
    ).resolves.toMatchObject({ status: 'completed' });
    if (invokeLateApproval === undefined)
      throw new Error('missing late callback');
    await expect(invokeLateApproval()).rejects.toThrow(
      'provider-write-live-execution-ledger-required',
    );
    expect(gateway.prepare).not.toHaveBeenCalled();
    expect(gateway.abandonPrepared).not.toHaveBeenCalled();
  });

  it('maps SDK approval interruptions back to canonical capabilities and server-owned safe previews', async () => {
    const gateway = proposalGateway();
    const facade = createOpenAiAgentsSdkFacade({ proposalGateway: gateway });
    const parameters = z.strictObject({
      title: z.string(),
      privateNotes: z.string(),
    });
    const sdkTool = facade.createTool({
      canonicalCapabilityId: providerWriteCapabilityId,
      capabilityKind: 'provider-write',
      name: 'google_calendar_event_create',
      description: 'Create an approved event.',
      parameters,
      needsApproval: true,
      timeoutMs: 10_000,
      execute: vi.fn(async () => ({ ok: true })),
    });
    const outputSchema = z.strictObject({ eventId: z.string() });
    const materialize = vi.fn((model, options) =>
      facade.createAgent({
        name: 'scheduler',
        instructions: 'Schedule safely.',
        model,
        tools: options?.exposeCapabilities === false ? [] : [sdkTool],
        outputType: options?.outputType ?? outputSchema,
        maxOutputTokens: 1_000,
      }),
    );
    const compiled = {
      manifest: {
        schemaVersion: 1,
        id: 'scheduler',
        version: '1.0.0',
        kind: 'specialist',
        instructionIds: ['scheduler.instructions.v1'],
        skillIds: ['privacy.v1'],
        capabilityAllowlist: ['google-calendar.event.create'],
        readableDataClasses: ['scheduler.records'],
        riskCeiling: 'provider-write',
        modelPolicy,
        executionBudget: {
          maxTurns: 12,
          maxCapabilityCalls: 8,
          maxParallelCalls: 3,
          timeoutMs: 30_000,
          maxInputTokens: 20_000,
          maxOutputTokens: 4_000,
        },
        schemaRefs: {
          input: { id: 'scheduler.input', version: '1.0.0' },
          output: { id: 'scheduler.output', version: '1.0.0' },
        },
      },
      instructions: 'Schedule safely.',
      capabilities: [
        {
          descriptor: {
            id: providerWriteCapabilityId,
            version: '1.0.0',
            capabilityKind: 'provider-write',
            requiredDataClasses: [],
            riskClass: 'provider-write',
            inputSchema: {
              id: 'google-calendar.event.create.input',
              version: '1.0.0',
            },
            timeoutMs: 10_000,
            approval: { rule: 'authenticated-visual-proposal' },
          },
          invoke: vi.fn(async () => ({ ok: true })),
        },
      ],
      inputSchema: parameters,
      outputSchema,
      materialize,
    } satisfies CompiledAgent<Agent<AgentExecutionContext, z.ZodObject>>;
    const state = {
      usage: { inputTokens: 10, outputTokens: 2 },
      getInterruptions: vi.fn(() => []),
      approve: vi.fn(),
      reject: vi.fn(),
      toString: () => JSON.stringify({ sdk: 'pending' }),
    };
    const runner: OpenAiAgentsRunnerPort = {
      run: vi.fn(async (agent) => {
        const approval = new RunToolApprovalItem(
          {
            type: 'function_call',
            callId: 'call-calendar-1',
            name: 'google_calendar_event_create',
            arguments: JSON.stringify({
              title: 'Dentist',
              privateNotes: 'must not be disclosed',
            }),
          },
          agent,
        );
        return { state, interruptions: [approval] };
      }),
    };
    const provider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: spendGuard(),
      runner,
    });
    const request: AgentProviderRequest = {
      phase: 'specialist',
      agent: compiled,
      model: 'gpt-5.6-luna',
      input: { title: 'Dentist' },
      context,
      maxTurns: 12,
    };

    const result = await provider.execute(request);

    expect(result).toMatchObject({
      status: 'interrupted',
      interruptions: [
        {
          agentId: 'scheduler',
          capabilityId: 'google-calendar.event.create',
          proposalId,
          argumentsPreview: {
            before: null,
            after: { title: 'Dentist' },
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('privateNotes');
    expect(materialize).toHaveBeenCalledWith('gpt-5.6-luna', {
      exposeCapabilities: true,
      outputType: outputSchema,
    });
    expect(gateway.abandonPrepared).not.toHaveBeenCalled();
  });

  it.each([
    ['read', 'safe'],
    ['local-write', 'unsafe'],
    ['import', 'unsafe'],
    ['provider-write', 'unsafe'],
  ] as const)(
    'reports a failed %s execution as %s to prevent unsafe model replay',
    async (capabilityKind, expectedReplaySafety) => {
      const gateway = proposalGateway();
      const compiled = compiledAgentWithCapability(capabilityKind, gateway);
      const runner: OpenAiAgentsRunnerPort = {
        run: vi.fn(async (sdkAgent, _input, options) => {
          const functionTool = sdkAgent.tools[0];
          if (functionTool?.type !== 'function') {
            throw new Error('expected function tool');
          }
          const runContext =
            options.context instanceof RunContext
              ? options.context
              : new RunContext(options.context ?? context);
          if (capabilityKind === 'provider-write') {
            await functionTool.needsApproval(
              runContext,
              { request: 'dentist' },
              'call-effect-ledger-1',
            );
          } else {
            await functionTool.invoke(
              runContext,
              JSON.stringify({ request: 'dentist' }),
            );
          }
          throw new Error('provider failed after capability processing');
        }),
      };
      const provider = new OpenAiAgentsExecutionProvider({
        proposalGateway: gateway,
        costCalculator: { calculateCadMinor: () => 1 },
        spendGuard: spendGuard(),
        runner,
      });

      await expect(
        provider.execute({
          phase: 'specialist',
          agent: compiled,
          model: 'gpt-5.6-luna',
          input: { request: 'dentist' },
          context,
          maxTurns: 12,
        }),
      ).resolves.toEqual({
        status: 'failed',
        reason: 'execution-failed',
        replaySafety: expectedReplaySafety,
        capabilityCalls: 1,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          modelCostCadMinor: 0,
        },
      });
      if (capabilityKind === 'provider-write') {
        expect(gateway.abandonPrepared).toHaveBeenCalledWith(
          expect.objectContaining({
            proposalId,
            providerAuthorityBindingHash,
            reason: 'execution-ended-before-checkpoint',
          }),
        );
      } else {
        expect(gateway.abandonPrepared).not.toHaveBeenCalled();
      }
    },
  );

  it('terminalizes the first prepared proposal when a second SDK provider write is requested', async () => {
    const gateway = proposalGateway();
    const compiled = compiledAgentWithCapability('provider-write', gateway);
    const runner: OpenAiAgentsRunnerPort = {
      run: vi.fn(async (sdkAgent, _input, options) => {
        const functionTool = sdkAgent.tools[0];
        if (functionTool?.type !== 'function') {
          throw new Error('expected function tool');
        }
        const runContext =
          options.context instanceof RunContext
            ? options.context
            : new RunContext(options.context ?? context);
        await functionTool.needsApproval(
          runContext,
          { request: 'dentist' },
          'call-calendar-first',
        );
        await functionTool.needsApproval(
          runContext,
          { request: 'optometrist' },
          'call-calendar-second',
        );
        throw new Error('second provider write should stop the SDK run');
      }),
    };
    const provider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: spendGuard(),
      inputTokenCounter: { countUpperBound: () => 1 },
      runner,
    });

    await expect(
      provider.execute({
        phase: 'specialist',
        agent: compiled,
        model: 'gpt-5.6-luna',
        input: { request: 'schedule two events' },
        context,
        maxTurns: 12,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'multiple-provider-writes',
      replaySafety: 'unsafe',
      capabilityCalls: 1,
    });
    expect(gateway.prepare).toHaveBeenCalledOnce();
    expect(gateway.abandonPrepared).toHaveBeenCalledWith({
      proposalId,
      capabilityId: 'google-calendar.event.create',
      sdkCallId: 'call-calendar-first',
      providerAuthorityBindingHash,
      reason: 'multiple-provider-writes-require-separate-turns',
      scope: expect.objectContaining({
        requestId: context.requestId,
        runId: context.runId,
        householdId: context.householdId,
        userId: context.userId,
        agentId: context.agentId,
      }),
    });
  });

  it('fails closed when the first prepared proposal cannot be terminalized', async () => {
    const gateway = proposalGateway();
    vi.mocked(gateway.abandonPrepared).mockResolvedValue({
      status: 'not-abandonable',
    });
    const compiled = compiledAgentWithCapability('provider-write', gateway);
    const runner: OpenAiAgentsRunnerPort = {
      run: vi.fn(async (sdkAgent, _input, options) => {
        const functionTool = sdkAgent.tools[0];
        if (functionTool?.type !== 'function') {
          throw new Error('expected function tool');
        }
        const runContext =
          options.context instanceof RunContext
            ? options.context
            : new RunContext(options.context ?? context);
        await functionTool.needsApproval(
          runContext,
          { request: 'dentist' },
          'call-calendar-first',
        );
        await functionTool.needsApproval(
          runContext,
          { request: 'optometrist' },
          'call-calendar-second',
        );
        throw new Error('second provider write should stop the SDK run');
      }),
    };
    const provider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: spendGuard(),
      inputTokenCounter: { countUpperBound: () => 1 },
      runner,
    });

    await expect(
      provider.execute({
        phase: 'specialist',
        agent: compiled,
        model: 'gpt-5.6-luna',
        input: { request: 'schedule two events' },
        context,
        maxTurns: 12,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'proposal-finalization-pending',
      replaySafety: 'unsafe',
      capabilityCalls: 1,
    });
    expect(gateway.prepare).toHaveBeenCalledOnce();
    expect(gateway.abandonPrepared).toHaveBeenCalledOnce();
  });

  it('serializes concurrent SDK write preparation before terminalizing the first proposal', async () => {
    const gateway = proposalGateway();
    let releasePreparation: (() => void) | undefined;
    const preparationBarrier = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    vi.mocked(gateway.prepare).mockImplementation(async () => {
      await preparationBarrier;
      return {
        proposalId,
        providerAuthorityBindingHash,
        authorizationScopeFingerprint,
        preview: { before: null, after: { title: 'Dentist' } },
      };
    });
    const compiled = compiledAgentWithCapability('provider-write', gateway);
    const runner: OpenAiAgentsRunnerPort = {
      run: vi.fn(async (sdkAgent, _input, options) => {
        const functionTool = sdkAgent.tools[0];
        if (functionTool?.type !== 'function') {
          throw new Error('expected function tool');
        }
        const runContext =
          options.context instanceof RunContext
            ? options.context
            : new RunContext(options.context ?? context);
        const first = functionTool.needsApproval(
          runContext,
          { request: 'dentist' },
          'call-calendar-first',
        );
        const second = functionTool.needsApproval(
          runContext,
          { request: 'optometrist' },
          'call-calendar-second',
        );
        releasePreparation?.();
        const decisions = await Promise.allSettled([first, second]);
        expect(decisions[0]).toMatchObject({
          status: 'fulfilled',
          value: true,
        });
        expect(decisions[1]).toMatchObject({ status: 'rejected' });
        throw new Error('multiple writes rejected');
      }),
    };
    const provider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: spendGuard(),
      inputTokenCounter: { countUpperBound: () => 1 },
      runner,
    });

    await expect(
      provider.execute({
        phase: 'specialist',
        agent: compiled,
        model: 'gpt-5.6-luna',
        input: { request: 'schedule two events' },
        context,
        maxTurns: 12,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'multiple-provider-writes',
      replaySafety: 'unsafe',
      capabilityCalls: 1,
    });
    expect(gateway.prepare).toHaveBeenCalledOnce();
    expect(gateway.abandonPrepared).toHaveBeenCalledOnce();
  });

  it('reuses an exact concurrent SDK call binding without creating a second proposal', async () => {
    const gateway = proposalGateway();
    let releasePreparation: (() => void) | undefined;
    const preparationBarrier = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    vi.mocked(gateway.prepare).mockImplementation(async () => {
      await preparationBarrier;
      return {
        proposalId,
        providerAuthorityBindingHash,
        authorizationScopeFingerprint,
        preview: { before: null, after: { title: 'Dentist' } },
      };
    });
    const compiled = compiledAgentWithCapability('provider-write', gateway);
    const state = {
      usage: { inputTokens: 10, outputTokens: 2 },
      getInterruptions: () => [],
      approve: vi.fn(),
      reject: vi.fn(),
      toString: () => JSON.stringify({ sdk: 'same-call' }),
    };
    const runner: OpenAiAgentsRunnerPort = {
      run: vi.fn(async (sdkAgent, _input, options) => {
        const functionTool = sdkAgent.tools[0];
        if (functionTool?.type !== 'function') {
          throw new Error('expected function tool');
        }
        const runContext =
          options.context instanceof RunContext
            ? options.context
            : new RunContext(options.context ?? context);
        const first = functionTool.needsApproval(
          runContext,
          { request: 'dentist' },
          'call-calendar-same',
        );
        const duplicate = functionTool.needsApproval(
          runContext,
          { request: 'dentist' },
          'call-calendar-same',
        );
        releasePreparation?.();
        await expect(Promise.all([first, duplicate])).resolves.toEqual([
          true,
          true,
        ]);
        const approval = new RunToolApprovalItem(
          {
            type: 'function_call',
            callId: 'call-calendar-same',
            name: 'google_calendar_event_create',
            arguments: JSON.stringify({ request: 'dentist' }),
          },
          sdkAgent,
        );
        return { state, interruptions: [approval] };
      }),
    };
    const provider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: spendGuard(),
      inputTokenCounter: { countUpperBound: () => 1 },
      runner,
    });

    await expect(
      provider.execute({
        phase: 'specialist',
        agent: compiled,
        model: 'gpt-5.6-luna',
        input: { request: 'dentist' },
        context,
        maxTurns: 12,
      }),
    ).resolves.toMatchObject({ status: 'interrupted' });
    expect(gateway.prepare).toHaveBeenCalledOnce();
    expect(gateway.abandonPrepared).not.toHaveBeenCalled();
  });

  it('shares the exact-one write guard across parallel specialist executions', async () => {
    const gateway = proposalGateway();
    const compiled = compiledAgentWithCapability('provider-write', gateway);
    const sharedLedger = turnProviderWriteLedger();
    let releaseSecond: (() => void) | undefined;
    const secondBarrier = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let runnerCall = 0;
    const runner: OpenAiAgentsRunnerPort = {
      run: vi.fn(async (sdkAgent, _input, options) => {
        runnerCall += 1;
        const currentCall = runnerCall;
        const functionTool = sdkAgent.tools[0];
        if (functionTool?.type !== 'function') {
          throw new Error('expected function tool');
        }
        const runContext =
          options.context instanceof RunContext
            ? options.context
            : new RunContext(options.context ?? context);
        if (currentCall === 2) await secondBarrier;
        const callId =
          currentCall === 1
            ? 'call-calendar-parallel-first'
            : 'call-calendar-parallel-second';
        await functionTool.needsApproval(
          runContext,
          { request: currentCall === 1 ? 'dentist' : 'optometrist' },
          callId,
        );
        const state = {
          usage: { inputTokens: 10, outputTokens: 2 },
          getInterruptions: () => [],
          approve: vi.fn(),
          reject: vi.fn(),
          toString: () => JSON.stringify({ sdk: callId }),
        };
        const approval = new RunToolApprovalItem(
          {
            type: 'function_call',
            callId,
            name: 'google_calendar_event_create',
            arguments: JSON.stringify({ request: 'dentist' }),
          },
          sdkAgent,
        );
        return { state, interruptions: [approval] };
      }),
    };
    const provider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: spendGuard(),
      inputTokenCounter: { countUpperBound: () => 1 },
      runner,
    });
    const first = provider
      .execute({
        phase: 'specialist',
        agent: compiled,
        model: 'gpt-5.6-luna',
        input: { request: 'dentist' },
        context,
        maxTurns: 12,
        turnProviderWriteLedger: sharedLedger,
      })
      .then((result) => {
        releaseSecond?.();
        return result;
      });
    const second = provider.execute({
      phase: 'specialist',
      agent: compiled,
      model: 'gpt-5.6-luna',
      input: { request: 'optometrist' },
      context,
      maxTurns: 12,
      turnProviderWriteLedger: sharedLedger,
    });

    await expect(first).resolves.toMatchObject({ status: 'interrupted' });
    await expect(second).resolves.toMatchObject({
      status: 'failed',
      reason: 'multiple-provider-writes',
      replaySafety: 'unsafe',
    });
    expect(gateway.prepare).toHaveBeenCalledOnce();
    expect(gateway.abandonPrepared).toHaveBeenCalledOnce();
    expect(sharedLedger.multipleProviderWritesRequested).toBe(true);
  });

  it('rejects a sequential second write after the first approved proposal is terminal', async () => {
    const gateway = proposalGateway();
    const compiled = compiledAgentWithCapability('provider-write', gateway);
    const sharedLedger = turnProviderWriteLedger(true);
    const runner: OpenAiAgentsRunnerPort = {
      run: vi.fn(async (sdkAgent, _input, options) => {
        const functionTool = sdkAgent.tools[0];
        if (functionTool?.type !== 'function') {
          throw new Error('expected function tool');
        }
        const runContext =
          options.context instanceof RunContext
            ? options.context
            : new RunContext(options.context ?? context);
        await functionTool.needsApproval(
          runContext,
          { request: 'optometrist' },
          'call-calendar-after-approved-first',
        );
        throw new Error('second write must not continue');
      }),
    };
    const provider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: spendGuard(),
      inputTokenCounter: { countUpperBound: () => 1 },
      runner,
    });

    await expect(
      provider.execute({
        phase: 'specialist',
        agent: compiled,
        model: 'gpt-5.6-luna',
        input: { request: 'optometrist' },
        context,
        maxTurns: 12,
        turnProviderWriteLedger: sharedLedger,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'multiple-provider-writes',
      replaySafety: 'unsafe',
    });
    expect(gateway.prepare).not.toHaveBeenCalled();
    expect(gateway.abandonPrepared).not.toHaveBeenCalled();
  });

  it('terminalizes a prepared proposal when the SDK returns no durable interruption', async () => {
    const gateway = proposalGateway();
    const compiled = compiledAgentWithCapability('provider-write', gateway);
    const state = {
      usage: { inputTokens: 10, outputTokens: 2 },
      getInterruptions: () => [],
      approve: vi.fn(),
      reject: vi.fn(),
      toString: () => JSON.stringify({ sdk: 'invalid-completion' }),
    };
    const runner: OpenAiAgentsRunnerPort = {
      run: vi.fn(async (sdkAgent, _input, options) => {
        const functionTool = sdkAgent.tools[0];
        if (functionTool?.type !== 'function') {
          throw new Error('expected function tool');
        }
        const runContext =
          options.context instanceof RunContext
            ? options.context
            : new RunContext(options.context ?? context);
        await functionTool.needsApproval(
          runContext,
          { request: 'dentist' },
          'call-calendar-invalid-output',
        );
        return {
          state,
          finalOutput: { summary: 'write was not checkpointed' },
        };
      }),
    };
    const provider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: spendGuard(),
      inputTokenCounter: { countUpperBound: () => 1 },
      runner,
    });

    await expect(
      provider.execute({
        phase: 'specialist',
        agent: compiled,
        model: 'gpt-5.6-luna',
        input: { request: 'dentist' },
        context,
        maxTurns: 12,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'execution-failed',
      replaySafety: 'unsafe',
    });
    expect(gateway.abandonPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId,
        reason: 'execution-ended-before-checkpoint',
      }),
    );
  });

  it('terminalizes a prepared proposal on timeout before returning the timeout', async () => {
    const gateway = proposalGateway();
    const compiled = withBudget(
      compiledAgentWithCapability('provider-write', gateway),
      { timeoutMs: 5 },
    );
    const runner: OpenAiAgentsRunnerPort = {
      run: vi.fn(async (sdkAgent, _input, options) => {
        const functionTool = sdkAgent.tools[0];
        if (functionTool?.type !== 'function') {
          throw new Error('expected function tool');
        }
        const runContext =
          options.context instanceof RunContext
            ? options.context
            : new RunContext(options.context ?? context);
        await functionTool.needsApproval(
          runContext,
          { request: 'dentist' },
          'call-calendar-timeout',
        );
        return new Promise<never>((_, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(new Error('timed out after preparation')),
            { once: true },
          );
        });
      }),
    };
    const provider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: spendGuard(),
      inputTokenCounter: { countUpperBound: () => 1 },
      runner,
    });

    await expect(
      provider.execute({
        phase: 'specialist',
        agent: compiled,
        model: 'gpt-5.6-luna',
        input: { request: 'dentist' },
        context,
        maxTurns: 12,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'timeout',
      replaySafety: 'unsafe',
    });
    expect(gateway.abandonPrepared).toHaveBeenCalledOnce();
  });

  it('terminalizes a prepared proposal before surfacing caller cancellation', async () => {
    const gateway = proposalGateway();
    const compiled = compiledAgentWithCapability('provider-write', gateway);
    const controller = new AbortController();
    const cancelledContext: AgentExecutionContext = Object.freeze({
      ...context,
      abortSignal: controller.signal,
    });
    const runner: OpenAiAgentsRunnerPort = {
      run: vi.fn(async (sdkAgent, _input, options) => {
        const functionTool = sdkAgent.tools[0];
        if (functionTool?.type !== 'function') {
          throw new Error('expected function tool');
        }
        const runContext =
          options.context instanceof RunContext
            ? options.context
            : new RunContext(options.context ?? cancelledContext);
        await functionTool.needsApproval(
          runContext,
          { request: 'dentist' },
          'call-calendar-cancelled',
        );
        controller.abort(new Error('caller cancelled'));
        throw new Error('cancelled after preparation');
      }),
    };
    const provider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: spendGuard(),
      inputTokenCounter: { countUpperBound: () => 1 },
      runner,
    });

    await expect(
      provider.execute({
        phase: 'specialist',
        agent: compiled,
        model: 'gpt-5.6-luna',
        input: { request: 'dentist' },
        context: cancelledContext,
        maxTurns: 12,
      }),
    ).rejects.toThrow('agent-run-aborted');
    expect(gateway.abandonPrepared).toHaveBeenCalledOnce();
  });

  it('blocks an over-limit input before spend reservation or SDK dispatch', async () => {
    const gateway = proposalGateway();
    const guard = spendGuard();
    const compiled = withBudget(compiledAgentWithCapability('read', gateway), {
      maxInputTokens: 100,
    });
    const runner: OpenAiAgentsRunnerPort = { run: vi.fn() };
    const provider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: guard,
      inputTokenCounter: { countUpperBound: () => 101 },
      runner,
    });

    await expect(
      provider.execute({
        phase: 'specialist',
        agent: compiled,
        model: 'gpt-5.6-luna',
        input: { request: 'dentist' },
        context,
        maxTurns: 12,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'token-budget-exceeded',
      replaySafety: 'safe',
    });
    expect(guard.reserve).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('blocks new model work at the monthly limit before SDK dispatch', async () => {
    const gateway = proposalGateway();
    const guard = spendGuard('blocked');
    const runner: OpenAiAgentsRunnerPort = { run: vi.fn() };
    const provider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: guard,
      inputTokenCounter: { countUpperBound: () => 1 },
      runner,
    });

    await expect(
      provider.execute({
        phase: 'specialist',
        agent: compiledAgentWithCapability('read', gateway),
        model: 'gpt-5.6-luna',
        input: { request: 'dentist' },
        context,
        maxTurns: 12,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'monthly-spend-limit-reached',
      replaySafety: 'safe',
    });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('surfaces the monthly warning and settles actual model usage', async () => {
    const gateway = proposalGateway();
    const guard = spendGuard('reserved', true);
    const state = {
      usage: { inputTokens: 10, outputTokens: 2 },
      getInterruptions: () => [],
      approve: vi.fn(),
      reject: vi.fn(),
      toString: () => JSON.stringify({ sdk: 'complete' }),
    };
    const runner: OpenAiAgentsRunnerPort = {
      run: vi.fn(async () => ({
        state,
        finalOutput: { summary: 'Done.' },
      })),
    };
    const provider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 3 },
      spendGuard: guard,
      inputTokenCounter: { countUpperBound: () => 1 },
      runner,
    });

    await expect(
      provider.execute({
        phase: 'specialist',
        agent: compiledAgentWithCapability('read', gateway),
        model: 'gpt-5.6-luna',
        input: { request: 'dentist' },
        context,
        maxTurns: 12,
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      usage: { modelCostCadMinor: 3, spendWarning: true },
    });
    expect(guard.markDispatched).toHaveBeenCalledOnce();
    expect(guard.settle).toHaveBeenCalledWith(
      expect.objectContaining({ actualCadMinor: 3 }),
    );
  });

  it('releases reserved spend when disclosure revalidation fails before model dispatch', async () => {
    const gateway = proposalGateway();
    const guard = spendGuard();
    const runner: OpenAiAgentsRunnerPort = { run: vi.fn() };
    const provider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: guard,
      inputTokenCounter: { countUpperBound: () => 1 },
      runner,
    });

    await expect(
      provider.execute({
        phase: 'specialist',
        agent: compiledAgentWithCapability('read', gateway),
        model: 'gpt-5.6-luna',
        input: { request: 'dentist' },
        context,
        maxTurns: 12,
        beforeModelDispatch: async () => {
          throw new Error('disclosure expired');
        },
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'execution-failed',
      replaySafety: 'safe',
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect(guard.markDispatched).not.toHaveBeenCalled();
    expect(guard.release).toHaveBeenCalledOnce();
    expect(guard.settle).not.toHaveBeenCalled();
  });

  it('aborts and awaits an initiated SDK run when dispatch audit persistence fails', async () => {
    const gateway = proposalGateway();
    const guard = spendGuard();
    const sideEffect = vi.fn();
    const cancelled = vi.fn();
    const runner: OpenAiAgentsRunnerPort = {
      run: vi.fn(
        async (_agent, _input, options) =>
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => {
              sideEffect();
              reject(new Error('unexpected model completion'));
            }, 50);
            options.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                cancelled();
                reject(new Error('cancelled after audit failure'));
              },
              { once: true },
            );
          }),
      ),
    };
    const provider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: guard,
      inputTokenCounter: { countUpperBound: () => 1 },
      runner,
    });

    await expect(
      provider.execute({
        phase: 'specialist',
        agent: compiledAgentWithCapability('read', gateway),
        model: 'gpt-5.6-luna',
        input: { request: 'dentist' },
        context,
        maxTurns: 12,
        onModelDispatch: async () => {
          throw new Error('trace persistence failed');
        },
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'execution-failed',
    });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(sideEffect).not.toHaveBeenCalled();
    expect(guard.settle).toHaveBeenCalledOnce();
  });

  it('enforces capability-call and wall-clock budgets inside the SDK boundary', async () => {
    const gateway = proposalGateway();
    const guard = spendGuard();
    const noCalls = withBudget(compiledAgentWithCapability('read', gateway), {
      maxCapabilityCalls: 0,
    });
    const capabilityRunner: OpenAiAgentsRunnerPort = {
      run: vi.fn(async (sdkAgent, _input, options) => {
        const functionTool = sdkAgent.tools[0];
        if (functionTool?.type !== 'function') throw new Error('missing tool');
        const runContext =
          options.context instanceof RunContext
            ? options.context
            : new RunContext(options.context ?? context);
        await functionTool.invoke(
          runContext,
          JSON.stringify({ request: 'dentist' }),
        );
        throw new Error('unreachable');
      }),
    };
    const capabilityProvider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: guard,
      inputTokenCounter: { countUpperBound: () => 1 },
      runner: capabilityRunner,
    });
    await expect(
      capabilityProvider.execute({
        phase: 'specialist',
        agent: noCalls,
        model: 'gpt-5.6-luna',
        input: { request: 'dentist' },
        context,
        maxTurns: 12,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'capability-budget-exceeded',
      capabilityCalls: 0,
    });

    const timed = withBudget(compiledAgentWithCapability('read', gateway), {
      timeoutMs: 5,
    });
    const timeoutRunner: OpenAiAgentsRunnerPort = {
      run: vi.fn(
        async (_agent, _input, options) =>
          new Promise<never>((_, reject) => {
            options.signal.addEventListener(
              'abort',
              () => reject(new Error('timed out')),
              { once: true },
            );
          }),
      ),
    };
    const timeoutProvider = new OpenAiAgentsExecutionProvider({
      proposalGateway: gateway,
      costCalculator: { calculateCadMinor: () => 1 },
      spendGuard: spendGuard(),
      inputTokenCounter: { countUpperBound: () => 1 },
      runner: timeoutRunner,
    });
    await expect(
      timeoutProvider.execute({
        phase: 'specialist',
        agent: timed,
        model: 'gpt-5.6-luna',
        input: { request: 'dentist' },
        context,
        maxTurns: 12,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'timeout',
      replaySafety: 'safe',
    });
  });
});

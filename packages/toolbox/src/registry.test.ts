import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  AgentManifestSchema,
  CapabilityDescriptorSchema,
  createRuntimeSchemaRegistry,
  type AgentManifest,
  type CapabilityDescriptor,
} from '@emdo/contracts';

import {
  FOUNDATIONAL_SKILLS,
  ToolboxPolicyError,
  createCapabilityRegistry,
  hashCanonicalJson,
  hashCapabilityDescriptorBinding,
  hashProviderWriteApprovalBinding,
  type ProviderWriteApprovalBinding,
  type ProviderWriteApprovalStore,
} from './index.js';

const specialistManifest = AgentManifestSchema.parse({
  schemaVersion: 1,
  id: 'scheduler',
  version: '1.0.0',
  kind: 'specialist',
  intents: ['schedule.appointment'],
  instructionIds: ['scheduler.instructions.v1'],
  skillIds: ['privacy.v1', 'approvals.v1'],
  capabilityAllowlist: ['calendar.events.read'],
  readableDataClasses: ['calendar.events'],
  modelPolicy: {
    defaultModel: 'gpt-5.6-luna',
    complexModel: 'gpt-5.6-terra',
    escalationReasons: ['failed-output-validation'],
  },
  executionBudget: {
    maxTurns: 8,
    maxCapabilityCalls: 12,
    maxParallelCalls: 3,
    timeoutMs: 60_000,
    maxInputTokens: 20_000,
    maxOutputTokens: 4_000,
  },
  schemaRefs: {
    input: { id: 'scheduler.input', version: '1.0.0' },
    output: { id: 'scheduler.output', version: '1.0.0' },
  },
  riskCeiling: 'read',
  evalSuite: { id: 'scheduler.evals', version: '1.0.0' },
});

const descriptor = (overrides: Partial<CapabilityDescriptor> = {}) =>
  CapabilityDescriptorSchema.parse({
    schemaVersion: 1,
    id: 'calendar.events.read',
    version: '1.0.0',
    capabilityKind: 'read',
    inputSchema: { id: 'calendar.events-read.input', version: '1.0.0' },
    outputSchema: { id: 'calendar.events-read.output', version: '1.0.0' },
    requiredScopes: ['google-calendar.events.read'],
    requiredDataClasses: ['calendar.events'],
    riskClass: 'read',
    timeoutMs: 15_000,
    freshness: {
      required: true,
      maxAgeMs: 60_000,
      revalidateBeforeExecution: false,
    },
    idempotency: {
      required: false,
      scope: 'request',
      ttlMs: 60_000,
    },
    approval: { rule: 'none', expiresInSeconds: 0 },
    audit: {
      required: true,
      eventType: 'calendar.external-read',
      redactFields: [],
    },
    executorId: 'calendar.events-read.v1',
    ...overrides,
  });

const providerDescriptor = (overrides: Partial<CapabilityDescriptor> = {}) =>
  descriptor({
    capabilityKind: 'provider-write',
    riskClass: 'provider-write',
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
    ...overrides,
  });

const providerWriteSafety = {
  atomicConditions: 'provider-native-single-request',
  idempotency: 'provider-key',
  retryOwnership: 'adapter-bounded-within-invocation',
  reconciliation: 'required',
} as const;

const disclosureGrantId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f106';
const providerPermit = (capability: CapabilityDescriptor) => {
  const issuedAt = '2026-08-09T16:02:00.000Z';
  const binding = {
    decisionId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f103',
    userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f101',
    agentId: 'scheduler',
    runId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f102',
    capabilityId: capability.id,
    capabilityFingerprint: hashCapabilityDescriptorBinding(capability),
    disclosureGrantId,
    payloadHash: hashCanonicalJson({ query: 'create the approved event' }),
    idempotencyTtlMs: capability.idempotency.ttlMs,
  };
  return {
    proposalId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f104',
    approvalHash: 'a'.repeat(64),
    approvalBindingHash: hashProviderWriteApprovalBinding(binding),
    capabilityFingerprint: hashCapabilityDescriptorBinding(capability),
    proposalCreatedAt: '2026-08-09T16:00:00.000Z',
    expiresAt: '2026-08-09T16:10:00.000Z',
    disclosureGrantId,
    disclosureGrantHash: 'd'.repeat(64),
    providerIdempotencyKey: 'b'.repeat(64),
    idempotencyExpiresAt: new Date(
      Date.parse(issuedAt) + capability.idempotency.ttlMs,
    ).toISOString(),
    attemptId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f105',
    attemptVersion: 1,
    issuedAt,
    targets: [
      {
        kind: 'google-calendar.event',
        id: 'primary',
        expectedVersion: 'etag-v1',
      },
    ],
    providerPreconditions: [
      {
        kind: 'calendar-version',
        targetId: 'primary',
        expectedValue: 'etag-v1',
      },
    ],
  } as const;
};

const markDispatching = (capability: CapabilityDescriptor) => ({
  status: 'dispatch-authorized' as const,
  authorization: providerPermit(capability),
});

const providerManifest = () =>
  AgentManifestSchema.parse({
    ...specialistManifest,
    capabilityAllowlist: ['google-calendar.event.create'],
    riskCeiling: 'provider-write',
  });

const providerInvocationContext = {
  requestId: 'request-1',
  runId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f102',
  userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f101',
  agentId: 'untrusted-caller-agent',
  spaceAccessGrantId: 'space-grant-1',
  disclosureGrantId,
  approvalDecisionId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f103',
  abortSignal: new AbortController().signal,
} as const;

const capabilityInputSchema = z.strictObject({ query: z.string() });
const capabilityOutputSchema = z.strictObject({
  count: z.number().int().nonnegative(),
});
const runtimeSchemas = createRuntimeSchemaRegistry([
  {
    reference: { id: 'calendar.events-read.input', version: '1.0.0' },
    schema: capabilityInputSchema,
  },
  {
    reference: { id: 'calendar.events-read.output', version: '1.0.0' },
    schema: capabilityOutputSchema,
  },
]);

const registration = (capability: CapabilityDescriptor = descriptor()) =>
  capability.capabilityKind === 'provider-write'
    ? {
        descriptor: capability,
        executeProviderWrite: async () => ({
          application: 'applied' as const,
          output: { count: 0 },
        }),
        providerWriteSafety,
      }
    : {
        descriptor: capability,
        execute: async () => ({ count: 0 }),
      };

const expectPolicyCode = (operation: () => unknown, code: string) => {
  try {
    operation();
    throw new Error('Expected operation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ToolboxPolicyError);
    expect((error as ToolboxPolicyError).code).toBe(code);
  }
};

describe('deny-by-default capability registry', () => {
  it('resolves only capabilities present in a parsed manifest allowlist', async () => {
    const registry = createCapabilityRegistry([registration()], runtimeSchemas);

    const [resolved] = registry.resolveForAgent({
      manifest: specialistManifest,
      requestedCapabilityIds: ['calendar.events.read'],
    });

    expect(resolved?.descriptor.id).toBe('calendar.events.read');
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(resolved).not.toHaveProperty('execute');
    expect(resolved).not.toHaveProperty('input');
    expect(resolved).not.toHaveProperty('output');
    await expect(
      resolved?.invoke(
        { query: 'next week' },
        {
          requestId: 'request-1',
          runId: 'run-1',
          userId: 'user-1',
          agentId: 'scheduler',
          spaceAccessGrantId: 'space-grant-1',
          abortSignal: new AbortController().signal,
        },
      ),
    ).resolves.toEqual({ count: 0 });
    await expect(
      resolved?.invoke(
        { query: 123 },
        {
          requestId: 'request-1',
          runId: 'run-1',
          userId: 'user-1',
          agentId: 'scheduler',
          spaceAccessGrantId: 'space-grant-1',
          abortSignal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow();
    expectPolicyCode(
      () =>
        registry.resolveForAgent({
          manifest: specialistManifest,
          requestedCapabilityIds: ['shopping.offers.read'],
        }),
      'unknown-capability',
    );
  });

  it('validates executor output before returning it to an agent', async () => {
    const unsafeRegistration = {
      ...registration(),
      execute: async () => ({ count: -1 }),
    };
    const registry = createCapabilityRegistry(
      [unsafeRegistration],
      runtimeSchemas,
    );
    const [resolved] = registry.resolveForAgent({
      manifest: specialistManifest,
      requestedCapabilityIds: ['calendar.events.read'],
    });

    await expect(
      resolved?.invoke(
        { query: 'next week' },
        {
          requestId: 'request-1',
          runId: 'run-1',
          userId: 'user-1',
          agentId: 'scheduler',
          spaceAccessGrantId: 'space-grant-1',
          abortSignal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow();
  });

  it('captures trusted schema parsers instead of exposing mutable schema instances', async () => {
    const registry = createCapabilityRegistry([registration()], runtimeSchemas);
    const [resolved] = registry.resolveForAgent({
      manifest: specialistManifest,
      requestedCapabilityIds: ['calendar.events.read'],
    });
    const mutableSchema =
      capabilityInputSchema as typeof capabilityInputSchema & {
        parse: (value: unknown) => { query: string };
      };
    const originalParse = mutableSchema.parse;
    mutableSchema.parse = () => ({ query: 'forged' });

    try {
      await expect(
        resolved?.invoke(
          { query: 123 },
          {
            requestId: 'request-1',
            runId: 'run-1',
            userId: 'user-1',
            agentId: 'scheduler',
            spaceAccessGrantId: 'space-grant-1',
            abortSignal: new AbortController().signal,
          },
        ),
      ).rejects.toThrow();
    } finally {
      mutableSchema.parse = originalParse;
    }
  });

  it('binds provider writes to a fresh single-use visual approval', async () => {
    const providerWrite = providerDescriptor({
      id: 'google-calendar.event.create',
      approval: {
        rule: 'authenticated-visual-proposal',
        expiresInSeconds: 600,
      },
      executorId: 'google-calendar.event-create.v1',
    });
    const manifest = AgentManifestSchema.parse({
      ...specialistManifest,
      capabilityAllowlist: ['google-calendar.event.create'],
      riskCeiling: 'provider-write',
    });
    const userId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f101';
    const runId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f102';
    const decisionId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f103';
    const input = { query: 'create the approved event' };
    let consumed = false;
    let consumedBinding: ProviderWriteApprovalBinding | undefined;
    let finalized = false;
    let observedExpectedVersion: string | undefined;
    const providerRegistration = {
      descriptor: providerWrite,
      executeProviderWrite: async (
        _input: unknown,
        context: {
          providerWritePermit: {
            targets: readonly { expectedVersion: string }[];
          };
        },
      ) => {
        observedExpectedVersion =
          context.providerWritePermit.targets[0]?.expectedVersion;
        return { application: 'applied' as const, output: { count: 0 } };
      },
      providerWriteSafety,
    };
    const registry = createCapabilityRegistry(
      [providerRegistration],
      runtimeSchemas,
      {
        providerWriteApprovalStore: {
          acquire: async (binding) => {
            consumedBinding = binding;
            if (
              binding.decisionId !== decisionId ||
              binding.userId !== userId ||
              binding.runId !== runId ||
              binding.capabilityId !== 'google-calendar.event.create' ||
              binding.payloadHash !== hashCanonicalJson(input)
            ) {
              return { status: 'mismatch' };
            }
            if (consumed) {
              return {
                status: 'existing-attempt',
                attemptState: 'executed',
                authorization: providerPermit(providerWrite),
                completion: {
                  state: 'executed',
                  application: 'applied',
                  outputStatus: 'valid',
                  resultHash: hashCanonicalJson({ count: 0 }),
                },
              };
            }
            consumed = true;
            return {
              status: 'authorized',
              authorization: providerPermit(providerWrite),
            };
          },
          markDispatching: async () => markDispatching(providerWrite),
          finalize: async () => {
            finalized = true;
            return 'finalized';
          },
          reconcile: async () => 'mismatch',
        },
        now: () => new Date('2026-08-09T16:02:01.000Z'),
      },
    );
    const [resolved] = registry.resolveForAgent({
      manifest,
      requestedCapabilityIds: ['google-calendar.event.create'],
    });
    const context = {
      requestId: 'request-1',
      runId,
      userId,
      agentId: 'scheduler',
      spaceAccessGrantId: 'space-grant-1',
      disclosureGrantId,
      abortSignal: new AbortController().signal,
    };

    await expect(resolved?.invoke(input, context)).rejects.toMatchObject({
      code: 'provider-write-approval-missing',
    });

    const approvedContext = {
      ...context,
      approvalDecisionId: decisionId,
    };

    await expect(resolved?.invoke(input, approvedContext)).resolves.toEqual({
      count: 0,
    });
    expect(consumedBinding).toMatchObject({
      decisionId,
      userId,
      agentId: 'scheduler',
      runId,
      capabilityId: 'google-calendar.event.create',
      capabilityFingerprint: hashCapabilityDescriptorBinding(providerWrite),
      disclosureGrantId,
      payloadHash: hashCanonicalJson(input),
    });
    expect(observedExpectedVersion).toBe('etag-v1');
    expect(finalized).toBe(true);
    await expect(
      resolved?.invoke(input, approvedContext),
    ).rejects.toMatchObject({
      code: 'provider-write-recovery-required',
    });
  });

  it('does not redispatch an existing provider attempt during recovery', async () => {
    const providerWrite = providerDescriptor({
      id: 'google-calendar.event.create',
      executorId: 'google-calendar.event-create.v1',
    });
    let dispatches = 0;
    const registry = createCapabilityRegistry(
      [
        {
          descriptor: providerWrite,
          executeProviderWrite: async () => {
            dispatches += 1;
            return { application: 'applied' as const, output: { count: 0 } };
          },
          providerWriteSafety,
        },
      ],
      runtimeSchemas,
      {
        providerWriteApprovalStore: {
          acquire: async () => ({
            status: 'existing-attempt' as const,
            attemptState: 'executing' as const,
            authorization: providerPermit(providerWrite),
          }),
          markDispatching: async () => markDispatching(providerWrite),
          finalize: async () => 'mismatch',
          reconcile: async () => 'mismatch',
        },
        now: () => new Date('2026-08-09T16:02:01.000Z'),
      },
    );
    const [resolved] = registry.resolveForAgent({
      manifest: providerManifest(),
      requestedCapabilityIds: ['google-calendar.event.create'],
    });

    await expect(
      resolved?.invoke(
        { query: 'create the approved event' },
        providerInvocationContext,
      ),
    ).rejects.toMatchObject({ code: 'provider-write-recovery-required' });
    expect(dispatches).toBe(0);
  });

  it('rejects a cross-wired permit from another approved proposal before dispatch', async () => {
    const providerWrite = providerDescriptor({
      id: 'google-calendar.event.create',
      executorId: 'google-calendar.event-create.v1',
    });
    let dispatches = 0;
    let dispatchMarks = 0;
    const crossWiredPermit = {
      ...providerPermit(providerWrite),
      proposalId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f199',
      approvalHash: '9'.repeat(64),
      approvalBindingHash: '7'.repeat(64),
      providerIdempotencyKey: '8'.repeat(64),
      targets: [
        {
          kind: 'google-calendar.event',
          id: 'someone-elses-calendar',
          expectedVersion: 'etag-other',
        },
      ],
    };
    const registry = createCapabilityRegistry(
      [
        {
          descriptor: providerWrite,
          executeProviderWrite: async () => {
            dispatches += 1;
            return { application: 'applied' as const, output: { count: 1 } };
          },
          providerWriteSafety,
        },
      ],
      runtimeSchemas,
      {
        providerWriteApprovalStore: {
          acquire: async () => ({
            status: 'authorized',
            authorization: crossWiredPermit,
          }),
          markDispatching: async () => {
            dispatchMarks += 1;
            return {
              status: 'dispatch-authorized' as const,
              authorization: crossWiredPermit,
            };
          },
          finalize: async () => 'finalized',
          reconcile: async () => 'mismatch',
        },
        now: () => new Date('2026-08-09T16:02:01.000Z'),
      },
    );
    const [resolved] = registry.resolveForAgent({
      manifest: providerManifest(),
      requestedCapabilityIds: ['google-calendar.event.create'],
    });

    await expect(
      resolved?.invoke(
        { query: 'create the approved event' },
        providerInvocationContext,
      ),
    ).rejects.toMatchObject({ code: 'provider-write-approval-invalid' });
    expect(dispatchMarks).toBe(0);
    expect(dispatches).toBe(0);
  });

  it('passes provider executors only the permit-bound security context', async () => {
    const providerWrite = providerDescriptor({
      id: 'google-calendar.event.create',
      executorId: 'google-calendar.event-create.v1',
    });
    let contextKeys: string[] = [];
    const registry = createCapabilityRegistry(
      [
        {
          descriptor: providerWrite,
          executeProviderWrite: async (_input, context) => {
            contextKeys = Object.keys(context).sort();
            return { application: 'applied' as const, output: { count: 1 } };
          },
          providerWriteSafety,
        },
      ],
      runtimeSchemas,
      {
        providerWriteApprovalStore: {
          acquire: async () => ({
            status: 'authorized',
            authorization: providerPermit(providerWrite),
          }),
          markDispatching: async () => markDispatching(providerWrite),
          finalize: async () => 'finalized',
          reconcile: async () => 'mismatch',
        },
        now: () => new Date('2026-08-09T16:02:01.000Z'),
      },
    );
    const [resolved] = registry.resolveForAgent({
      manifest: providerManifest(),
      requestedCapabilityIds: ['google-calendar.event.create'],
    });

    await resolved?.invoke(
      { query: 'create the approved event' },
      providerInvocationContext,
    );

    expect(contextKeys).toEqual([
      'abortSignal',
      'agentId',
      'providerWritePermit',
      'requestId',
      'runId',
      'userId',
    ]);
  });

  it('enters the provider adapter in the dispatch-mark continuation without another microtask gap', async () => {
    const providerWrite = providerDescriptor({
      id: 'google-calendar.event.create',
      executorId: 'google-calendar.event-create.v1',
    });
    let dispatchEntered = false;
    let authorizeDispatch:
      ((result: ReturnType<typeof markDispatching>) => void) | undefined;
    const dispatchGate = new Promise<ReturnType<typeof markDispatching>>(
      (resolve) => {
        authorizeDispatch = resolve;
      },
    );
    const registry = createCapabilityRegistry(
      [
        {
          descriptor: providerWrite,
          executeProviderWrite: async () => {
            dispatchEntered = true;
            return { application: 'applied' as const, output: { count: 1 } };
          },
          providerWriteSafety,
        },
      ],
      runtimeSchemas,
      {
        providerWriteApprovalStore: {
          acquire: async () => ({
            status: 'authorized',
            authorization: providerPermit(providerWrite),
          }),
          markDispatching: () => dispatchGate,
          finalize: async () => 'finalized',
          reconcile: async () => 'mismatch',
        },
        now: () => new Date('2026-08-09T16:02:01.000Z'),
      },
    );
    const [resolved] = registry.resolveForAgent({
      manifest: providerManifest(),
      requestedCapabilityIds: ['google-calendar.event.create'],
    });

    const invocation = resolved?.invoke(
      { query: 'create the approved event' },
      providerInvocationContext,
    );
    await Promise.resolve();
    expect(dispatchEntered).toBe(false);
    authorizeDispatch?.(markDispatching(providerWrite));
    await Promise.resolve();

    expect(dispatchEntered).toBe(true);
    await expect(invocation).resolves.toEqual({ count: 1 });
  });

  it('fails and finalizes a provider write when approved versions drift', async () => {
    const providerWrite = providerDescriptor({
      id: 'google-calendar.event.create',
      approval: {
        rule: 'authenticated-visual-proposal',
        expiresInSeconds: 600,
      },
      executorId: 'google-calendar.event-create.v1',
    });
    const manifest = AgentManifestSchema.parse({
      ...specialistManifest,
      capabilityAllowlist: ['google-calendar.event.create'],
      riskCeiling: 'provider-write',
    });
    let finalState: string | undefined;
    let conditionalCommitCalled = false;
    const registry = createCapabilityRegistry(
      [
        {
          descriptor: providerWrite,
          executeProviderWrite: async () => {
            conditionalCommitCalled = true;
            return {
              application: 'not-applied' as const,
              reason: 'provider-precondition-failed' as const,
            };
          },
          providerWriteSafety,
        },
      ],
      runtimeSchemas,
      {
        providerWriteApprovalStore: {
          acquire: async () => ({
            status: 'authorized',
            authorization: providerPermit(providerWrite),
          }),
          markDispatching: async () => markDispatching(providerWrite),
          finalize: async (_binding, completion) => {
            finalState = completion.state;
            return 'finalized';
          },
          reconcile: async () => 'mismatch',
        },
        now: () => new Date('2026-08-09T16:02:01.000Z'),
      },
    );
    const [resolved] = registry.resolveForAgent({
      manifest,
      requestedCapabilityIds: ['google-calendar.event.create'],
    });

    await expect(
      resolved?.invoke(
        { query: 'create the approved event' },
        {
          requestId: 'request-1',
          runId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f102',
          userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f101',
          agentId: 'scheduler',
          spaceAccessGrantId: 'space-grant-1',
          disclosureGrantId,
          approvalDecisionId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f103',
          abortSignal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'provider-write-precondition-stale' });
    expect(finalState).toBe('not-applied');
    expect(conditionalCommitCalled).toBe(true);
  });

  it('records timeout and thrown post-dispatch outcomes as indeterminate', async () => {
    const providerWrite = providerDescriptor({
      id: 'google-calendar.event.create',
      timeoutMs: 5,
      executorId: 'google-calendar.event-create.v1',
    });
    let completion: unknown;
    const registry = createCapabilityRegistry(
      [
        {
          descriptor: providerWrite,
          executeProviderWrite: async () => new Promise<never>(() => undefined),
          providerWriteSafety,
        },
      ],
      runtimeSchemas,
      {
        providerWriteApprovalStore: {
          acquire: async () => ({
            status: 'authorized',
            authorization: providerPermit(providerWrite),
          }),
          markDispatching: async () => markDispatching(providerWrite),
          finalize: async (_binding, value) => {
            completion = value;
            return 'finalized';
          },
          reconcile: async () => 'mismatch',
        },
        now: () => new Date('2026-08-09T16:02:01.000Z'),
      },
    );
    const [resolved] = registry.resolveForAgent({
      manifest: providerManifest(),
      requestedCapabilityIds: ['google-calendar.event.create'],
    });

    await expect(
      resolved?.invoke(
        { query: 'create the approved event' },
        providerInvocationContext,
      ),
    ).rejects.toMatchObject({ code: 'provider-write-outcome-indeterminate' });
    expect(completion).toMatchObject({
      state: 'indeterminate',
      reason: 'timeout-after-dispatch',
      reconciliationRequired: true,
    });
  });

  it('records an applied write with invalid output as executed, not retryable', async () => {
    const providerWrite = providerDescriptor({
      id: 'google-calendar.event.create',
      executorId: 'google-calendar.event-create.v1',
    });
    let completion: unknown;
    const registry = createCapabilityRegistry(
      [
        {
          descriptor: providerWrite,
          executeProviderWrite: async () => ({
            application: 'applied' as const,
            output: { count: -1 },
          }),
          providerWriteSafety,
        },
      ],
      runtimeSchemas,
      {
        providerWriteApprovalStore: {
          acquire: async () => ({
            status: 'authorized',
            authorization: providerPermit(providerWrite),
          }),
          markDispatching: async () => markDispatching(providerWrite),
          finalize: async (_binding, value) => {
            completion = value;
            return 'finalized';
          },
          reconcile: async () => 'mismatch',
        },
        now: () => new Date('2026-08-09T16:02:01.000Z'),
      },
    );
    const [resolved] = registry.resolveForAgent({
      manifest: providerManifest(),
      requestedCapabilityIds: ['google-calendar.event.create'],
    });

    await expect(
      resolved?.invoke(
        { query: 'create the approved event' },
        providerInvocationContext,
      ),
    ).rejects.toMatchObject({ code: 'provider-write-output-invalid' });
    expect(completion).toMatchObject({
      state: 'executed',
      application: 'applied',
      outputStatus: 'invalid',
    });
  });

  it('fails closed on cyclic evidence after dispatch and stores only a safe outcome', async () => {
    const providerWrite = providerDescriptor({
      id: 'google-calendar.event.create',
      executorId: 'google-calendar.event-create.v1',
    });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    let completion: unknown;
    const registry = createCapabilityRegistry(
      [
        {
          descriptor: providerWrite,
          executeProviderWrite: async () =>
            ({
              application: 'applied',
              output: { count: 1 },
              evidence: cyclic,
            }) as never,
          providerWriteSafety,
        },
      ],
      runtimeSchemas,
      {
        providerWriteApprovalStore: {
          acquire: async () => ({
            status: 'authorized',
            authorization: providerPermit(providerWrite),
          }),
          markDispatching: async () => markDispatching(providerWrite),
          finalize: async (_binding, value) => {
            completion = value;
            return 'finalized';
          },
          reconcile: async () => 'mismatch',
        },
        now: () => new Date('2026-08-09T16:02:01.000Z'),
      },
    );
    const [resolved] = registry.resolveForAgent({
      manifest: providerManifest(),
      requestedCapabilityIds: ['google-calendar.event.create'],
    });

    await expect(
      resolved?.invoke(
        { query: 'create the approved event' },
        providerInvocationContext,
      ),
    ).rejects.toMatchObject({ code: 'provider-write-outcome-indeterminate' });
    expect(completion).toEqual({
      state: 'indeterminate',
      application: 'indeterminate',
      reason: 'provider-outcome-envelope-invalid',
      reconciliationRequired: true,
    });
  });

  it('rejects provider registrations without an atomic idempotent safety contract', () => {
    const providerWrite = providerDescriptor({
      id: 'google-calendar.event.create',
      executorId: 'google-calendar.event-create.v1',
    });
    expectPolicyCode(
      () =>
        createCapabilityRegistry(
          [
            {
              descriptor: providerWrite,
              executeProviderWrite: async () => ({
                application: 'applied' as const,
                output: { count: 1 },
              }),
            },
          ],
          runtimeSchemas,
        ),
      'capability-registration-invalid',
    );
  });

  it('snapshots trusted executors, approval-store methods, and manifest identity', async () => {
    const providerWrite = providerDescriptor({
      id: 'google-calendar.event.create',
      executorId: 'google-calendar.event-create.v1',
    });
    let originalExecutorCalled = false;
    let swappedExecutorCalled = false;
    let acquiredAgentId: string | undefined;
    let executorAgentId: string | undefined;
    const mutableRegistration = {
      descriptor: providerWrite,
      executeProviderWrite: async (
        _input: unknown,
        context: { agentId: string },
      ) => {
        originalExecutorCalled = true;
        executorAgentId = context.agentId;
        return {
          application: 'applied' as const,
          output: { count: 1 },
        };
      },
      providerWriteSafety,
    };
    const mutableStore: ProviderWriteApprovalStore = {
      acquire: async (binding: ProviderWriteApprovalBinding) => {
        acquiredAgentId = binding.agentId;
        return {
          status: 'authorized' as const,
          authorization: providerPermit(providerWrite),
        };
      },
      markDispatching: async () => markDispatching(providerWrite),
      finalize: async () => 'already-finalized' as const,
      reconcile: async () => 'mismatch' as const,
    };
    const registry = createCapabilityRegistry(
      [mutableRegistration],
      runtimeSchemas,
      {
        providerWriteApprovalStore: mutableStore,
        now: () => new Date('2026-08-09T16:02:01.000Z'),
      },
    );
    mutableRegistration.executeProviderWrite = async () => {
      swappedExecutorCalled = true;
      return { application: 'applied' as const, output: { count: 9 } };
    };
    mutableStore.acquire = async () => ({ status: 'mismatch' as const });
    const [resolved] = registry.resolveForAgent({
      manifest: providerManifest(),
      requestedCapabilityIds: ['google-calendar.event.create'],
    });

    await expect(
      resolved?.invoke(
        { query: 'create the approved event' },
        providerInvocationContext,
      ),
    ).resolves.toEqual({ count: 1 });
    expect(originalExecutorCalled).toBe(true);
    expect(swappedExecutorCalled).toBe(false);
    expect(acquiredAgentId).toBe('scheduler');
    expect(executorAgentId).toBe('scheduler');
  });

  it('denies duplicates and known capabilities absent from the allowlist', () => {
    expectPolicyCode(
      () =>
        createCapabilityRegistry(
          [registration(), registration()],
          runtimeSchemas,
        ),
      'duplicate-capability',
    );

    const extra = descriptor({
      id: 'calendar.freebusy.read',
      executorId: 'calendar.freebusy-read.v1',
    });
    const registry = createCapabilityRegistry(
      [registration(), registration(extra)],
      runtimeSchemas,
    );

    expectPolicyCode(
      () =>
        registry.resolveForAgent({
          manifest: specialistManifest,
          requestedCapabilityIds: ['calendar.freebusy.read'],
        }),
      'capability-not-allowlisted',
    );
  });

  it('limits the manager to delegation capabilities', () => {
    const manager = AgentManifestSchema.parse({
      ...specialistManifest,
      id: 'manager',
      kind: 'manager',
      intents: ['delegate.request'],
      capabilityAllowlist: ['calendar.events.read'],
      readableDataClasses: ['calendar.events'],
    });
    const registry = createCapabilityRegistry([registration()], runtimeSchemas);

    expectPolicyCode(
      () =>
        registry.resolveForAgent({
          manifest: manager,
          requestedCapabilityIds: ['calendar.events.read'],
        }),
      'manager-capability-denied',
    );
  });

  it('enforces risk ceilings and readable data classes', () => {
    const providerWrite = providerDescriptor({
      id: 'google-calendar.event.create',
      approval: {
        rule: 'authenticated-visual-proposal',
        expiresInSeconds: 600,
      },
      executorId: 'google-calendar.event-create.v1',
    });
    const riskManifest = AgentManifestSchema.parse({
      ...specialistManifest,
      capabilityAllowlist: ['google-calendar.event.create'],
    });
    const riskRegistry = createCapabilityRegistry(
      [registration(providerWrite)],
      runtimeSchemas,
    );

    expectPolicyCode(
      () =>
        riskRegistry.resolveForAgent({
          manifest: riskManifest,
          requestedCapabilityIds: ['google-calendar.event.create'],
        }),
      'risk-ceiling-exceeded',
    );

    const financeRead = descriptor({
      id: 'finance.transactions.read',
      requiredDataClasses: ['finance.transactions'],
      executorId: 'finance.transactions-read.v1',
    });
    const dataManifest = AgentManifestSchema.parse({
      ...specialistManifest,
      capabilityAllowlist: ['finance.transactions.read'],
    });
    const dataRegistry = createCapabilityRegistry(
      [registration(financeRead)],
      runtimeSchemas,
    );

    expectPolicyCode(
      () =>
        dataRegistry.resolveForAgent({
          manifest: dataManifest,
          requestedCapabilityIds: ['finance.transactions.read'],
        }),
      'data-class-denied',
    );
  });

  it('rejects provider writes that do not require an authenticated visual proposal', () => {
    const unsafeWrite = providerDescriptor({
      id: 'google-calendar.event.create',
      approval: { rule: 'none', expiresInSeconds: 0 },
      executorId: 'google-calendar.event-create.v1',
    });
    const manifest = AgentManifestSchema.parse({
      ...specialistManifest,
      capabilityAllowlist: ['google-calendar.event.create'],
      riskCeiling: 'provider-write',
    });
    const registry = createCapabilityRegistry(
      [registration(unsafeWrite)],
      runtimeSchemas,
    );

    expectPolicyCode(
      () =>
        registry.resolveForAgent({
          manifest,
          requestedCapabilityIds: ['google-calendar.event.create'],
        }),
      'provider-write-approval-required',
    );
  });

  it('rejects untrusted evidence or model fields that try to broaden access', () => {
    const registry = createCapabilityRegistry([registration()], runtimeSchemas);

    expect(() =>
      registry.resolveForAgent({
        manifest: specialistManifest,
        requestedCapabilityIds: ['calendar.events.read'],
        evidenceCapabilityIds: ['google-calendar.event.create'],
      } as unknown as {
        manifest: AgentManifest;
        requestedCapabilityIds: string[];
      }),
    ).toThrow();
  });

  it('publishes frozen versioned instruction-only foundational skills', () => {
    expect(FOUNDATIONAL_SKILLS.map((skill) => skill.id)).toEqual([
      'privacy.v1',
      'clarification.v1',
      'provenance.v1',
      'toronto-time.v1',
      'cad-normalization.v1',
      'safe-errors.v1',
      'approvals.v1',
    ]);
    expect(FOUNDATIONAL_SKILLS.every(Object.isFrozen)).toBe(true);
    expect(
      FOUNDATIONAL_SKILLS.every(
        (skill) => !('execute' in skill) && !('executor' in skill),
      ),
    ).toBe(true);
  });
});

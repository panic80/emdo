import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentManifestSchema,
  CapabilityDescriptorSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
  createRuntimeSchemaRegistry,
  parseProviderWriteCapabilityDescriptor,
  type AgentManifest,
  type CapabilityDescriptor,
  type ProviderWriteCapabilityDescriptor,
  type ProviderWriteOperationScope,
  type ProviderWriteRegisteredCapability,
  type RegisteredCapability,
  type StandardCapabilityDescriptor,
  type StandardRegisteredCapability,
} from '@emdo/contracts';

import {
  FOUNDATIONAL_SKILLS,
  ToolboxPolicyError,
  createCapabilityRegistry,
  hashCanonicalJson,
  hashCapabilityDescriptorBinding,
  hashProviderWriteApprovalBinding,
  type ProviderWriteApprovalBinding,
  type ProviderWriteCompletion,
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

const descriptor = (
  overrides: Readonly<Record<string, unknown>> = {},
): CapabilityDescriptor =>
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

const providerDescriptor = (
  overrides: Readonly<Record<string, unknown>> = {},
): ProviderWriteCapabilityDescriptor =>
  parseProviderWriteCapabilityDescriptor({
    ...descriptor(),
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
const providerRequestId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f109';
const providerSessionId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f110';
const providerHouseholdId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f107';
const providerSpaceAccessGrantId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f111';
const authorizationScopeFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse('f'.repeat(64));
const providerAuthorityBinding = {
  kind: 'google-calendar-grant-v2',
  householdId: providerHouseholdId,
  privateSpaceId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f108',
  authorizationScopeFingerprint,
  providerGrantReference: 'google-grant-reference-1',
  authorizationEpoch: 1,
} as const;
const providerOperationScope = {
  requestId: providerRequestId,
  sessionId: providerSessionId,
  householdId: providerHouseholdId,
  userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f101',
  spaceAccessGrantId: providerSpaceAccessGrantId,
  authorizationScopeFingerprint,
} as const;
const trustedProviderWriteAuthorityResolver = {
  resolve: async () => ({
    authorityBinding: providerAuthorityBinding,
    operationScope: providerOperationScope,
  }),
};
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
    authorityBinding: providerAuthorityBinding,
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
    approvalBinding: binding,
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
  requestId: providerRequestId,
  runId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f102',
  sessionId: providerSessionId,
  householdId: providerHouseholdId,
  userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f101',
  agentId: 'untrusted-caller-agent',
  spaceAccessGrantId: providerSpaceAccessGrantId,
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

function registration(): StandardRegisteredCapability;
function registration(
  capability: ProviderWriteCapabilityDescriptor,
): ProviderWriteRegisteredCapability;
function registration(
  capability: StandardCapabilityDescriptor,
): StandardRegisteredCapability;
function registration(capability: CapabilityDescriptor): RegisteredCapability;
function registration(
  capability: CapabilityDescriptor = descriptor(),
): RegisteredCapability {
  return capability.capabilityKind === 'provider-write'
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
}

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
  it('fails closed before approval consumption when trusted provider authority is unavailable', async () => {
    const providerWrite = providerDescriptor({
      id: 'google-calendar.event.create',
      executorId: 'google-calendar.event-create.v1',
    });
    let approvalConsumed = false;
    const registry = createCapabilityRegistry(
      [registration(providerWrite)],
      runtimeSchemas,
      {
        providerWriteApprovalStore: {
          acquire: async () => {
            approvalConsumed = true;
            return { status: 'mismatch' };
          },
          markDispatching: async () => ({ status: 'mismatch' }),
          finalize: async () => 'mismatch',
          reconcile: async () => 'mismatch',
        },
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
    ).rejects.toMatchObject({
      code: 'provider-write-authority-binding-required',
    });
    expect(approvalConsumed).toBe(false);
  });

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
          householdId: providerHouseholdId,
          sessionId: providerSessionId,
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
          householdId: providerHouseholdId,
          sessionId: providerSessionId,
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
          householdId: providerHouseholdId,
          sessionId: providerSessionId,
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
            householdId: providerHouseholdId,
            sessionId: providerSessionId,
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
    let acquiredScope: ProviderWriteOperationScope | undefined;
    let dispatchScope: ProviderWriteOperationScope | undefined;
    let executedScope: ProviderWriteOperationScope | undefined;
    let finalized = false;
    let observedExpectedVersion: string | undefined;
    const resolverInputs: unknown[] = [];
    const resolveAuthority = vi.fn(async (input: unknown) => {
      resolverInputs.push(input);
      return {
        authorityBinding: providerAuthorityBinding,
        operationScope: providerOperationScope,
      };
    });
    const providerRegistration = {
      descriptor: providerWrite,
      executeProviderWrite: async (
        _input: unknown,
        context: {
          providerWritePermit: {
            targets: readonly { expectedVersion: string }[];
          };
          providerWriteOperationScope: ProviderWriteOperationScope;
        },
      ) => {
        observedExpectedVersion =
          context.providerWritePermit.targets[0]?.expectedVersion;
        executedScope = context.providerWriteOperationScope;
        return { application: 'applied' as const, output: { count: 0 } };
      },
      providerWriteSafety,
    };
    const registry = createCapabilityRegistry(
      [providerRegistration],
      runtimeSchemas,
      {
        trustedProviderWriteAuthorityResolver: {
          resolve: resolveAuthority,
        },
        providerWriteApprovalStore: {
          acquire: async (binding, currentScope) => {
            consumedBinding = binding;
            acquiredScope = currentScope;
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
          markDispatching: async (_binding, _attemptId, currentScope) => {
            dispatchScope = currentScope;
            return markDispatching(providerWrite);
          },
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
      requestId: providerRequestId,
      runId,
      sessionId: providerSessionId,
      householdId: providerHouseholdId,
      userId,
      agentId: 'scheduler',
      spaceAccessGrantId: providerSpaceAccessGrantId,
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
      authorityBinding: providerAuthorityBinding,
    });
    expect(acquiredScope).toEqual(providerOperationScope);
    expect(dispatchScope).toEqual(providerOperationScope);
    expect(executedScope).toEqual(providerOperationScope);
    expect(resolveAuthority).toHaveBeenCalledTimes(2);
    const exactResolverInput = {
      requestId: providerRequestId,
      runId,
      sessionId: providerSessionId,
      userId,
      householdId: providerHouseholdId,
      agentId: 'scheduler',
      spaceAccessGrantId: providerSpaceAccessGrantId,
      disclosureGrantId,
      decisionId,
      capabilityId: providerWrite.id,
      capabilityFingerprint: hashCapabilityDescriptorBinding(providerWrite),
    };
    expect(resolverInputs).toEqual([exactResolverInput, exactResolverInput]);
    expect(Object.keys(resolverInputs[0] as object).sort()).toEqual(
      Object.keys(exactResolverInput).sort(),
    );
    expect(Object.isFrozen(resolverInputs[0])).toBe(true);
    expect(Object.isFrozen(resolverInputs[1])).toBe(true);
    expect(resolverInputs[0]).not.toBe(resolverInputs[1]);
    expect(
      hashProviderWriteApprovalBinding({
        ...consumedBinding!,
        authorityBinding: {
          ...providerAuthorityBinding,
          providerGrantReference: 'google-grant-reference-2',
          authorizationEpoch: 2,
        },
      }),
    ).not.toBe(hashProviderWriteApprovalBinding(consumedBinding!));
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
        trustedProviderWriteAuthorityResolver,
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

  it.each([
    {
      name: 'provider grant instance',
      dispatchResolution: {
        authorityBinding: {
          ...providerAuthorityBinding,
          providerGrantReference: 'google-grant-reference-reconnected',
          authorizationEpoch: 2,
        },
        operationScope: providerOperationScope,
      },
    },
    {
      name: 'current invocation scope',
      dispatchResolution: {
        authorityBinding: providerAuthorityBinding,
        operationScope: {
          ...providerOperationScope,
          requestId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f199',
        },
      },
    },
  ])(
    'fails closed when the $name changes during pre-dispatch revalidation',
    async ({ dispatchResolution }) => {
      const providerWrite = providerDescriptor({
        id: 'google-calendar.event.create',
        executorId: 'google-calendar.event-create.v1',
      });
      let resolutionCount = 0;
      let dispatchMarks = 0;
      let providerDispatches = 0;
      let completion: ProviderWriteCompletion | undefined;
      const registry = createCapabilityRegistry(
        [
          {
            descriptor: providerWrite,
            executeProviderWrite: async () => {
              providerDispatches += 1;
              return { application: 'applied' as const, output: { count: 1 } };
            },
            providerWriteSafety,
          },
        ],
        runtimeSchemas,
        {
          trustedProviderWriteAuthorityResolver: {
            resolve: async () => {
              resolutionCount += 1;
              return resolutionCount === 1
                ? {
                    authorityBinding: providerAuthorityBinding,
                    operationScope: providerOperationScope,
                  }
                : dispatchResolution;
            },
          },
          providerWriteApprovalStore: {
            acquire: async () => ({
              status: 'authorized',
              authorization: providerPermit(providerWrite),
            }),
            markDispatching: async () => {
              dispatchMarks += 1;
              return markDispatching(providerWrite);
            },
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
      ).rejects.toMatchObject({
        code: 'provider-write-authority-binding-invalid',
      });
      expect(resolutionCount).toBe(2);
      expect(dispatchMarks).toBe(0);
      expect(providerDispatches).toBe(0);
      expect(completion).toMatchObject({
        state: 'not-applied',
        reason: 'approval-policy-mismatch',
      });
    },
  );

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
        trustedProviderWriteAuthorityResolver,
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
        trustedProviderWriteAuthorityResolver,
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
      'householdId',
      'providerWriteOperationScope',
      'providerWritePermit',
      'requestId',
      'runId',
      'sessionId',
      'userId',
    ]);
  });

  it('enters the provider adapter in the dispatch-mark continuation without another microtask gap', async () => {
    const providerWrite = providerDescriptor({
      id: 'google-calendar.event.create',
      executorId: 'google-calendar.event-create.v1',
    });
    let dispatchEntered = false;
    let dispatchClaimEntered = false;
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
        trustedProviderWriteAuthorityResolver,
        providerWriteApprovalStore: {
          acquire: async () => ({
            status: 'authorized',
            authorization: providerPermit(providerWrite),
          }),
          markDispatching: () => {
            dispatchClaimEntered = true;
            return dispatchGate;
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

    const invocation = resolved?.invoke(
      { query: 'create the approved event' },
      providerInvocationContext,
    );
    await vi.waitFor(() => expect(dispatchClaimEntered).toBe(true));
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
        trustedProviderWriteAuthorityResolver,
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
          ...providerInvocationContext,
          agentId: 'scheduler',
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
        trustedProviderWriteAuthorityResolver,
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
        trustedProviderWriteAuthorityResolver,
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
        trustedProviderWriteAuthorityResolver,
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
            } as unknown as RegisteredCapability,
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
        trustedProviderWriteAuthorityResolver,
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

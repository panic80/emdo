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
  type ProviderWriteApprovalBinding,
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

const registration = (capability: CapabilityDescriptor = descriptor()) => ({
  descriptor: capability,
  execute: async () => ({ count: 0 }),
});

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
    const providerWrite = descriptor({
      id: 'google-calendar.event.create',
      capabilityKind: 'provider-write',
      riskClass: 'provider-write',
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
    const registry = createCapabilityRegistry(
      [registration(providerWrite)],
      runtimeSchemas,
      {
        providerWriteApprovalStore: {
          consume: async (binding) => {
            consumedBinding = binding;
            if (
              binding.decisionId !== decisionId ||
              binding.userId !== userId ||
              binding.runId !== runId ||
              binding.capabilityId !== 'google-calendar.event.create' ||
              binding.payloadHash !== hashCanonicalJson(input)
            ) {
              return 'mismatch';
            }
            if (consumed) return 'consumed';
            consumed = true;
            return 'authorized';
          },
        },
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
      runId,
      capabilityId: 'google-calendar.event.create',
      payloadHash: hashCanonicalJson(input),
    });
    await expect(
      resolved?.invoke(input, approvedContext),
    ).rejects.toMatchObject({
      code: 'provider-write-approval-consumed',
    });
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
    const providerWrite = descriptor({
      id: 'google-calendar.event.create',
      capabilityKind: 'provider-write',
      riskClass: 'provider-write',
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
    const unsafeWrite = descriptor({
      id: 'google-calendar.event.create',
      capabilityKind: 'provider-write',
      riskClass: 'provider-write',
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

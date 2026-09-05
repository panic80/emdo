import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { parseProviderWriteCapabilityDescriptor } from '@emdo/contracts';

import {
  AgentFactory,
  type AgentPackageDefinition,
  type AgentSdkFacade,
  type ProviderWriteResolvedAgentCapability,
  type ResolvedAgentCapability,
  type StandardResolvedAgentCapability,
  type ValidatedAgentManifest,
} from './factory.js';

const manifest = (
  kind: 'manager' | 'specialist',
  id = kind === 'manager' ? 'manager' : 'scheduler',
): ValidatedAgentManifest =>
  Object.freeze({
    schemaVersion: 1,
    id,
    version: '1.0.0',
    kind,
    instructionIds: [`${id}.instructions.v1`],
    skillIds: ['privacy.v1', `${id}.specialty.v1`],
    capabilityAllowlist: [kind === 'manager' ? `delegate.${id}` : `${id}.read`],
    readableDataClasses: [],
    riskCeiling: kind === 'manager' ? 'none' : 'read',
    schemaRefs: Object.freeze({
      input: Object.freeze({ id: `${id}.input`, version: '1.0.0' }),
      output: Object.freeze({ id: `${id}.output`, version: '1.0.0' }),
    }),
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
  });

const definition = (
  kind: 'manager' | 'specialist',
  id?: string,
): AgentPackageDefinition => {
  const agentManifest = manifest(kind, id);
  return Object.freeze({
    manifest: agentManifest,
    instructions: Object.freeze([
      Object.freeze({
        id: agentManifest.instructionIds[0]!,
        version: '1.0.0',
        content: `Instructions for ${agentManifest.id}`,
      }),
    ]),
    skills: Object.freeze([
      Object.freeze({
        id: `${agentManifest.id}.specialty.v1`,
        version: '1.0.0',
        title: `${agentManifest.id} specialty`,
        instructions: `Specialty guidance for ${agentManifest.id}`,
      }),
    ]),
    capabilityReferences: Object.freeze(
      agentManifest.capabilityAllowlist.map((capabilityId) =>
        Object.freeze({
          id: capabilityId,
          version: '1.0.0',
          kind:
            kind === 'manager' ? ('delegation' as const) : ('read' as const),
        }),
      ),
    ),
  });
};

type TestCapabilityKind =
  ResolvedAgentCapability['descriptor']['capabilityKind'];

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

function capability(
  id: string,
  capabilityKind: 'provider-write',
): ProviderWriteResolvedAgentCapability;
function capability(
  id: string,
  capabilityKind?: Exclude<TestCapabilityKind, 'provider-write'>,
): StandardResolvedAgentCapability;
function capability(
  id: string,
  capabilityKind: TestCapabilityKind,
): ResolvedAgentCapability;
function capability(
  id: string,
  capabilityKind: TestCapabilityKind = 'read',
): ResolvedAgentCapability {
  const invoke = vi.fn(async () => Object.freeze({ ok: true }));
  const common = {
    version: '1.0.0' as const,
    requiredDataClasses: Object.freeze([]),
    description: `${id} capability`,
    inputSchema: Object.freeze({ id: `${id}.input`, version: '1.0.0' }),
    timeoutMs: 10_000,
  };
  if (capabilityKind === 'provider-write') {
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
      capabilityKind,
      riskClass:
        capabilityKind === 'delegation'
          ? ('none' as const)
          : capabilityKind === 'import'
            ? ('local-write' as const)
            : capabilityKind,
      approval: Object.freeze({ rule: 'none' as const }),
    }),
    invoke,
  });
}

const setup = (
  capabilityKind: ResolvedAgentCapability['descriptor']['capabilityKind'] = 'read',
  sharedSkills: readonly {
    readonly id: string;
    readonly version: 1;
    readonly title: string;
    readonly instructions: string;
  }[] = [
    Object.freeze({
      id: 'privacy.v1',
      version: 1,
      title: 'Privacy',
      instructions: 'Use only scoped records.',
    }),
  ],
) => {
  const createTool = vi.fn((input) =>
    Object.freeze({ type: 'tool', ...input }),
  );
  const createAgent = vi.fn((input) =>
    Object.freeze({ type: 'agent', ...input }),
  );
  const sdk: AgentSdkFacade = { createAgent, createTool };
  const resolveForAgent = vi.fn(
    ({
      requestedCapabilityIds,
    }: {
      requestedCapabilityIds: readonly string[];
    }) => requestedCapabilityIds.map((id) => capability(id, capabilityKind)),
  );
  const validateManifest = vi.fn((value: unknown) => {
    if (value === null || typeof value !== 'object' || !('id' in value)) {
      throw new Error('invalid manifest');
    }
    return value as ValidatedAgentManifest;
  });
  const factory = new AgentFactory({
    capabilityRegistry: { resolveForAgent },
    sdk,
    schemaResolver: {
      resolve: (reference) =>
        reference.id.endsWith('.output')
          ? z.strictObject({ message: z.string() })
          : z.strictObject({ input: z.unknown() }),
    },
    sharedSkills,
    validateManifest,
  });

  return {
    createAgent,
    createTool,
    factory,
    resolveForAgent,
    validateManifest,
  };
};

describe('AgentFactory', () => {
  it.each([
    ['manager', 'manager'],
    ['specialist', 'scheduler'],
    ['specialist', 'finance'],
    ['specialist', 'shopping'],
  ] as const)('compiles the uniform %s package template for %s', (kind, id) => {
    const { createAgent, createTool, factory, resolveForAgent } = setup(
      kind === 'manager' ? 'delegation' : 'read',
    );

    const compiled = factory.compile(definition(kind, id));
    const sdkAgent = compiled.materialize('gpt-5.6-terra');

    expect(resolveForAgent).toHaveBeenCalledWith({
      manifest: compiled.manifest,
      requestedCapabilityIds: compiled.manifest.capabilityAllowlist,
    });
    expect(compiled.instructions).toContain('Use only scoped records.');
    expect(compiled.instructions).toContain(`Instructions for ${id}`);
    expect(compiled.instructions).toContain(`Specialty guidance for ${id}`);
    expect(createTool).toHaveBeenCalledTimes(1);
    expect(createTool).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalCapabilityId: compiled.capabilities[0]!.descriptor.id,
        name: compiled.capabilities[0]!.descriptor.id.replaceAll('.', '_'),
        needsApproval: false,
        parameters: expect.any(z.ZodObject),
      }),
    );
    expect(createAgent).toHaveBeenCalledWith({
      name: id,
      instructions: compiled.instructions,
      model: 'gpt-5.6-terra',
      maxOutputTokens: 4_000,
      outputType: expect.any(z.ZodObject),
      tools: [
        expect.objectContaining({
          name: compiled.capabilities[0]!.descriptor.id.replaceAll('.', '_'),
        }),
      ],
    });
    expect(sdkAgent).toEqual(expect.objectContaining({ type: 'agent' }));
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.capabilities)).toBe(true);
  });

  it('appends server-owned response guidance without changing the compiled agent instructions', () => {
    const { createAgent, factory } = setup('delegation');
    const compiled = factory.compile(definition('manager', 'manager'));
    const trustedInstruction =
      'Write the final EMDO synthesis in ja-JP. Keep evidence excerpts in their source language; do not translate those excerpts.';

    compiled.materialize('gpt-5.6-luna', {
      exposeCapabilities: false,
      trustedInstructions: [trustedInstruction],
    });

    expect(compiled.instructions).not.toContain('ja-JP');
    expect(createAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        instructions: `${compiled.instructions}\n\n${trustedInstruction}`,
        tools: [],
      }),
    );
  });

  it('rejects malformed manifests through the canonical validator', () => {
    const { factory, validateManifest } = setup();
    const malformed = {
      ...definition('specialist'),
      manifest: Object.freeze({ version: '1.0.0' }),
    } as never;

    expect(() => factory.compile(malformed)).toThrow('invalid manifest');
    expect(validateManifest).toHaveBeenCalledOnce();
  });

  it('rejects missing, duplicate, and unrequested versioned instructions or skills', () => {
    const { factory } = setup();
    const valid = definition('specialist');

    expect(() => factory.compile({ ...valid, instructions: [] })).toThrow(
      'agent-instruction-resolution-failed',
    );
    expect(() =>
      factory.compile({
        ...valid,
        skills: [...valid.skills, valid.skills[0]!],
      }),
    ).toThrow('duplicate-agent-skill');
    expect(() =>
      factory.compile({
        ...valid,
        instructions: [
          ...valid.instructions,
          {
            id: 'unrequested.instructions.v1',
            version: '1.0.0',
            content: 'Injected instructions',
          },
        ],
      }),
    ).toThrow('unrequested-agent-instruction');
    expect(() =>
      factory.compile({
        ...valid,
        skills: [
          ...valid.skills,
          {
            id: 'unrequested.skill.v1',
            version: '1.0.0',
            title: 'Injected',
            instructions: 'Injected skill',
          },
        ],
      }),
    ).toThrow('unrequested-agent-skill');
  });

  it('binds every requested skill ID to its exact canonical semantic version', () => {
    const { factory } = setup();
    const valid = definition('specialist');
    const specialty = valid.skills[0]!;

    expect(() =>
      factory.compile({
        ...valid,
        skills: [{ ...specialty, version: '2.0.0' }],
      }),
    ).toThrow('agent-skill-version-mismatch');

    const unversionedManifest = Object.freeze({
      ...(valid.manifest as ValidatedAgentManifest),
      skillIds: ['privacy.v1', 'scheduler.specialty'],
    }) as ValidatedAgentManifest;
    expect(() =>
      factory.compile({
        ...valid,
        manifest: unversionedManifest,
        skills: [
          {
            ...specialty,
            id: 'scheduler.specialty',
            version: '1.0.0',
          },
        ],
      }),
    ).toThrow('invalid-agent-skill-version-binding');
  });

  it('supports exact multi-digit canonical skill majors', () => {
    const { factory } = setup();
    const valid = definition('specialist');
    const multiDigitManifest = Object.freeze({
      ...(valid.manifest as ValidatedAgentManifest),
      skillIds: ['privacy.v1', 'scheduler.specialty.v12'],
    }) as ValidatedAgentManifest;

    expect(() =>
      factory.compile({
        ...valid,
        manifest: multiDigitManifest,
        skills: [
          {
            id: 'scheduler.specialty.v12',
            version: '12.0.0',
            title: 'Scheduler specialty',
            instructions: 'Version twelve guidance.',
          },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects raw definition tools and manager capabilities other than delegation', () => {
    const { factory } = setup('read');
    const managerDefinition = definition('manager');

    expect(() =>
      factory.compile({
        ...managerDefinition,
        tools: [{ name: 'raw-calendar-client' }],
      } as never),
    ).toThrow('invalid-agent-package-definition');
    expect(() => factory.compile(managerDefinition)).toThrow(
      'manager-capability-denied',
    );
  });

  it('binds every capability reference to the exact registry version and kind', () => {
    const valid = definition('specialist');
    const makeFactory = (resolved: ResolvedAgentCapability) =>
      new AgentFactory({
        capabilityRegistry: { resolveForAgent: () => [resolved] },
        sdk: {
          createAgent: (input) => input,
          createTool: (input) => input,
        },
        schemaResolver: {
          resolve: () => z.strictObject({ input: z.unknown() }),
        },
        sharedSkills: [
          {
            id: 'privacy.v1',
            version: 1,
            title: 'Privacy',
            instructions: 'Scoped data only.',
          },
        ],
        validateManifest: (value) => value as ValidatedAgentManifest,
      });

    expect(() =>
      makeFactory({
        ...capability('scheduler.read'),
        descriptor: {
          ...capability('scheduler.read').descriptor,
          version: '2.0.0',
        },
      }).compile(valid),
    ).toThrow('agent-capability-binding-mismatch');
    expect(() =>
      makeFactory(capability('scheduler.read', 'local-write')).compile(valid),
    ).toThrow('agent-capability-binding-mismatch');
  });

  it('enforces manifest risk ceilings and readable data classes after registry resolution', () => {
    const valid = definition('specialist');
    const localWriteDefinition: AgentPackageDefinition = Object.freeze({
      ...valid,
      capabilityReferences: Object.freeze([
        Object.freeze({
          ...valid.capabilityReferences[0]!,
          kind: 'local-write' as const,
        }),
      ]),
    });
    const makeFactory = (resolved: ResolvedAgentCapability) =>
      new AgentFactory({
        capabilityRegistry: { resolveForAgent: () => [resolved] },
        sdk: {
          createAgent: (input) => input,
          createTool: (input) => input,
        },
        schemaResolver: {
          resolve: () => z.strictObject({ input: z.unknown() }),
        },
        sharedSkills: [
          {
            id: 'privacy.v1',
            version: 1,
            title: 'Privacy',
            instructions: 'Scoped data only.',
          },
        ],
        validateManifest: (value) => value as ValidatedAgentManifest,
      });

    expect(() =>
      makeFactory({
        ...capability('scheduler.read', 'local-write'),
        descriptor: {
          ...capability('scheduler.read', 'local-write').descriptor,
          riskClass: 'local-write',
        },
      }).compile(localWriteDefinition),
    ).toThrow('risk-ceiling-exceeded');

    expect(() =>
      makeFactory({
        ...capability('scheduler.read'),
        descriptor: {
          ...capability('scheduler.read').descriptor,
          requiredDataClasses: ['calendar.private-notes'],
        },
      }).compile(valid),
    ).toThrow('data-class-denied');
  });

  it('rejects resolved capabilities without canonical risk and data-class metadata', () => {
    const valid = definition('specialist');
    const unsafe = capability('scheduler.read') as {
      readonly descriptor: Record<string, unknown>;
      readonly invoke: ResolvedAgentCapability['invoke'];
    };
    const missingRisk = { ...unsafe.descriptor };
    const missingData = { ...unsafe.descriptor };
    Reflect.deleteProperty(missingRisk, 'riskClass');
    Reflect.deleteProperty(missingData, 'requiredDataClasses');
    const makeFactory = (descriptor: Record<string, unknown>) =>
      new AgentFactory({
        capabilityRegistry: {
          resolveForAgent: () => [
            { descriptor, invoke: unsafe.invoke } as ResolvedAgentCapability,
          ],
        },
        sdk: {
          createAgent: (input) => input,
          createTool: (input) => input,
        },
        schemaResolver: {
          resolve: () => z.strictObject({ input: z.unknown() }),
        },
        sharedSkills: [
          {
            id: 'privacy.v1',
            version: 1,
            title: 'Privacy',
            instructions: 'Scoped data only.',
          },
        ],
        validateManifest: (value) => value as ValidatedAgentManifest,
      });

    expect(() => makeFactory(missingRisk).compile(valid)).toThrow(
      'agent-capability-policy-metadata-invalid',
    );
    expect(() => makeFactory(missingData).compile(valid)).toThrow(
      'agent-capability-policy-metadata-invalid',
    );
  });

  it('passes exact input schemas and visual approval rules to the SDK facade', () => {
    const { createTool, factory } = setup('provider-write');
    const valid = definition('specialist');
    const providerDefinition: AgentPackageDefinition = Object.freeze({
      ...valid,
      manifest: Object.freeze({
        ...(valid.manifest as ValidatedAgentManifest),
        riskCeiling: 'provider-write' as const,
      }),
      capabilityReferences: Object.freeze([
        Object.freeze({
          ...valid.capabilityReferences[0]!,
          kind: 'provider-write' as const,
        }),
      ]),
    });

    factory.compile(providerDefinition).materialize('gpt-5.6-luna');

    expect(createTool).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalCapabilityId: 'scheduler.read',
        needsApproval: true,
        parameters: expect.any(z.ZodObject),
        timeoutMs: 10_000,
      }),
    );
    const sdkParameters = createTool.mock.calls[0]![0].parameters;
    expect(
      sdkParameters.parse({
        input: 'safe',
      }),
    ).toEqual({
      input: 'safe',
    });
  });

  it('rejects canonical capability IDs that collide after SDK name normalization', () => {
    const valid = definition('specialist');
    const collisionManifest = Object.freeze({
      ...(valid.manifest as ValidatedAgentManifest),
      capabilityAllowlist: ['scheduler.read', 'scheduler-read'],
    }) as ValidatedAgentManifest;
    const collisionDefinition: AgentPackageDefinition = {
      ...valid,
      manifest: collisionManifest,
      capabilityReferences: [
        valid.capabilityReferences[0]!,
        { id: 'scheduler-read', version: '1.0.0', kind: 'read' },
      ],
    };
    const factory = new AgentFactory({
      validateManifest: (value) => value as ValidatedAgentManifest,
      capabilityRegistry: {
        resolveForAgent: () => [
          capability('scheduler.read'),
          capability('scheduler-read'),
        ],
      },
      schemaResolver: {
        resolve: () => z.strictObject({ input: z.unknown() }),
      },
      sharedSkills: [
        {
          id: 'privacy.v1',
          version: 1,
          title: 'Privacy',
          instructions: 'Scoped data only.',
        },
      ],
      sdk: {
        createTool: (input) => input,
        createAgent: (input) => input,
      },
    });

    expect(() => factory.compile(collisionDefinition)).toThrow(
      'sdk-tool-name-collision',
    );
  });

  it('rejects registry omissions, substitutions, and duplicate capability IDs', () => {
    const valid = definition('specialist');
    const makeFactory = (resolved: readonly ResolvedAgentCapability[]) =>
      new AgentFactory({
        capabilityRegistry: { resolveForAgent: () => resolved },
        sdk: {
          createAgent: (input) => input,
          createTool: (input) => input,
        },
        schemaResolver: {
          resolve: () => z.strictObject({ input: z.unknown() }),
        },
        sharedSkills: [
          {
            id: 'privacy.v1',
            version: 1,
            title: 'Privacy',
            instructions: 'Scoped data only.',
          },
        ],
        validateManifest: (value) => value as ValidatedAgentManifest,
      });

    expect(() => makeFactory([]).compile(valid)).toThrow(
      'agent-capability-resolution-failed',
    );
    expect(() =>
      makeFactory([capability('shopping.read')]).compile(valid),
    ).toThrow('agent-capability-resolution-failed');
    expect(() =>
      makeFactory([
        capability('scheduler.read'),
        capability('scheduler.read'),
      ]).compile(valid),
    ).toThrow('duplicate-agent-capability');
  });
});

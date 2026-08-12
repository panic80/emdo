import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AgentFactory,
  type ResolvedAgentCapability,
  type ValidatedAgentManifest,
} from '@emdo/agent-core';
import {
  AgentManifestSchema,
  CapabilityDescriptorSchema,
  createRuntimeSchemaRegistry,
  parseProviderWriteCapabilityDescriptor,
  type CapabilityDescriptor,
} from '@emdo/contracts';
import { FOUNDATIONAL_SKILLS } from '@emdo/toolbox';

import {
  financeAgentDefinition,
  financeCapabilityReferences,
  financeInputSchema,
  financeOutputSchema,
  financeSchemaRegistrations,
} from '../../finance/src/index.js';
import { agentEvalCatalog as financeAgentEvalCatalog } from '../../finance/src/evals/index.js';
import { agentFixtureCatalog as financeAgentFixtureCatalog } from '../../finance/src/fixtures/index.js';
import {
  schedulerAgentDefinition,
  schedulerCapabilityReferences,
  schedulerInputSchema,
  schedulerOutputSchema,
  schedulerSchemaRegistrations,
} from '../../scheduler/src/index.js';
import { agentEvalCatalog as schedulerAgentEvalCatalog } from '../../scheduler/src/evals/index.js';
import { agentFixtureCatalog as schedulerAgentFixtureCatalog } from '../../scheduler/src/fixtures/index.js';
import {
  shoppingAgentDefinition,
  shoppingCapabilityReferences,
  shoppingInputSchema,
  shoppingOutputSchema,
  shoppingSchemaRegistrations,
} from '../../shopping/src/index.js';
import { agentEvalCatalog as shoppingAgentEvalCatalog } from '../../shopping/src/evals/index.js';
import { agentFixtureCatalog as shoppingAgentFixtureCatalog } from '../../shopping/src/fixtures/index.js';
import {
  managerAgentDefinition,
  managerCapabilityReferences,
  managerInputSchema,
  managerOutputSchema,
  managerSchemaRegistrations,
} from './index.js';
import { agentEvalCatalog as managerAgentEvalCatalog } from './evals/index.js';
import { agentFixtureCatalog as managerAgentFixtureCatalog } from './fixtures/index.js';

const specialists = [
  schedulerAgentDefinition,
  financeAgentDefinition,
  shoppingAgentDefinition,
] as const;

const foundationalSkillIds = [
  'privacy.v1',
  'clarification.v1',
  'provenance.v1',
  'toronto-time.v1',
  'cad-normalization.v1',
  'safe-errors.v1',
  'approvals.v1',
] as const;

const definitionKeys = [
  'capabilityReferences',
  'instructions',
  'manifest',
  'skills',
] as const;

const packages = [
  {
    definition: managerAgentDefinition,
    capabilityReferences: managerCapabilityReferences,
    inputSchema: managerInputSchema,
    outputSchema: managerOutputSchema,
    schemaRegistrations: managerSchemaRegistrations,
  },
  {
    definition: schedulerAgentDefinition,
    capabilityReferences: schedulerCapabilityReferences,
    inputSchema: schedulerInputSchema,
    outputSchema: schedulerOutputSchema,
    schemaRegistrations: schedulerSchemaRegistrations,
  },
  {
    definition: financeAgentDefinition,
    capabilityReferences: financeCapabilityReferences,
    inputSchema: financeInputSchema,
    outputSchema: financeOutputSchema,
    schemaRegistrations: financeSchemaRegistrations,
  },
  {
    definition: shoppingAgentDefinition,
    capabilityReferences: shoppingCapabilityReferences,
    inputSchema: shoppingInputSchema,
    outputSchema: shoppingOutputSchema,
    schemaRegistrations: shoppingSchemaRegistrations,
  },
] as const;

const packageCatalogs = [
  {
    definition: managerAgentDefinition,
    evals: managerAgentEvalCatalog,
    fixtures: managerAgentFixtureCatalog,
  },
  {
    definition: schedulerAgentDefinition,
    evals: schedulerAgentEvalCatalog,
    fixtures: schedulerAgentFixtureCatalog,
  },
  {
    definition: financeAgentDefinition,
    evals: financeAgentEvalCatalog,
    fixtures: financeAgentFixtureCatalog,
  },
  {
    definition: shoppingAgentDefinition,
    evals: shoppingAgentEvalCatalog,
    fixtures: shoppingAgentFixtureCatalog,
  },
] as const;

const assertPlainInstructionData = (value: unknown): void => {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(Object.getOwnPropertySymbols(value)).toEqual([]);
  for (const key of Object.keys(value as object)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    expect(descriptor).toHaveProperty('value');
    expect(typeof descriptor?.value).not.toBe('function');
  }
};

const descriptorForReference = (reference: {
  readonly id: string;
  readonly version: string;
  readonly kind:
    'delegation' | 'read' | 'local-write' | 'provider-write' | 'import';
  readonly inputSchema: {
    readonly id: string;
    readonly version: string;
  };
}): CapabilityDescriptor => {
  const descriptor = {
    schemaVersion: 1,
    id: reference.id,
    version: reference.version,
    capabilityKind: reference.kind,
    inputSchema: reference.inputSchema,
    outputSchema: reference.inputSchema,
    requiredScopes: [],
    requiredDataClasses: [],
    riskClass:
      reference.kind === 'delegation'
        ? 'none'
        : reference.kind === 'import'
          ? 'local-write'
          : reference.kind,
    timeoutMs: 30_000,
    freshness:
      reference.kind === 'provider-write'
        ? {
            required: true,
            maxAgeMs: 0,
            revalidateBeforeExecution: true,
          }
        : {
            required: false,
            maxAgeMs: 0,
            revalidateBeforeExecution: false,
          },
    idempotency:
      reference.kind === 'provider-write'
        ? {
            required: true,
            scope: 'provider-target',
            ttlMs: 86_400_000,
          }
        : {
            required: false,
            scope: 'request',
            ttlMs: 0,
          },
    approval:
      reference.kind === 'provider-write'
        ? { rule: 'authenticated-visual-proposal', expiresInSeconds: 600 }
        : { rule: 'none', expiresInSeconds: 0 },
    audit: {
      required: reference.kind === 'provider-write',
      eventType: 'agent.runtime.capability',
      redactFields: [],
    },
    executorId: 'agent-runtime.test',
  } as const;
  return reference.kind === 'provider-write'
    ? parseProviderWriteCapabilityDescriptor(descriptor)
    : CapabilityDescriptorSchema.parse(descriptor);
};

describe('uniform agent package template', () => {
  it('keeps runtime roots free of eval and fixture catalogs', async () => {
    for (const packageUrl of [
      new URL('../package.json', import.meta.url),
      new URL('../../scheduler/package.json', import.meta.url),
      new URL('../../finance/package.json', import.meta.url),
      new URL('../../shopping/package.json', import.meta.url),
    ]) {
      const packageJson = JSON.parse(readFileSync(packageUrl, 'utf8')) as {
        readonly exports: Readonly<Record<string, string>>;
      };
      expect(packageJson.exports).toMatchObject({
        './evals': './src/evals/index.ts',
        './fixtures': './src/fixtures/index.ts',
      });
    }

    const [manager, scheduler, finance, shopping] = await Promise.all([
      import('./index.js'),
      import('../../scheduler/src/index.js'),
      import('../../finance/src/index.js'),
      import('../../shopping/src/index.js'),
    ]);
    for (const runtime of [manager, scheduler, finance, shopping]) {
      expect(runtime).not.toHaveProperty('agentEvalCatalog');
      expect(runtime).not.toHaveProperty('agentFixtureCatalog');
    }

    const developmentCatalogs = await Promise.all([
      import('./evals/index.js'),
      import('./fixtures/index.js'),
      import('../../scheduler/src/evals/index.js'),
      import('../../scheduler/src/fixtures/index.js'),
      import('../../finance/src/evals/index.js'),
      import('../../finance/src/fixtures/index.js'),
      import('../../shopping/src/evals/index.js'),
      import('../../shopping/src/fixtures/index.js'),
    ]);
    for (const [index, development] of developmentCatalogs.entries()) {
      expect(development).toHaveProperty(
        index % 2 === 0 ? 'agentEvalCatalog' : 'agentFixtureCatalog',
      );
    }
  });

  it('exports parsed immutable manifests for one manager and three specialists', () => {
    const definitions = [managerAgentDefinition, ...specialists];

    for (const definition of definitions) {
      expect(() =>
        AgentManifestSchema.parse(definition.manifest),
      ).not.toThrow();
      expect(Object.isFrozen(definition.manifest)).toBe(true);
      expect(Object.keys(definition).sort()).toEqual([...definitionKeys]);
    }

    expect(managerAgentDefinition.manifest.kind).toBe('manager');
    expect(specialists.map(({ manifest }) => manifest.kind)).toEqual([
      'specialist',
      'specialist',
      'specialist',
    ]);
  });

  it('keeps every specialist on the same foundational toolbox', () => {
    for (const definition of specialists) {
      expect(definition.manifest.skillIds.slice(0, -1)).toEqual(
        foundationalSkillIds,
      );
      expect(definition.manifest.skillIds.at(-1)).toBe(
        definition.skills.at(-1)?.id,
      );
      expect(definition.skills).toHaveLength(1);
    }

    expect(
      new Set(specialists.map((item) => item.skills.at(-1)?.id)).size,
    ).toBe(3);
  });

  it('binds instructions, schemas, and capabilities exactly to each manifest', () => {
    for (const item of packages) {
      const { definition } = item;
      expect(definition.instructions.map(({ id }) => id)).toEqual(
        definition.manifest.instructionIds,
      );
      expect(definition.manifest.instructionIds).toHaveLength(1);
      expect(definition.manifest.schemaRefs.input).toEqual(
        item.inputSchema.reference,
      );
      expect(definition.manifest.schemaRefs.output).toEqual(
        item.outputSchema.reference,
      );
      expect(item.schemaRegistrations).toEqual([
        item.inputSchema,
        item.outputSchema,
      ]);
      expect(Object.isFrozen(item.schemaRegistrations)).toBe(true);
      expect(item.capabilityReferences.map(({ id }) => id)).toEqual(
        definition.manifest.capabilityAllowlist,
      );
      expect(definition.capabilityReferences).toEqual(
        item.capabilityReferences,
      );
      expect(new Set(item.capabilityReferences.map(({ id }) => id)).size).toBe(
        item.capabilityReferences.length,
      );
    }
  });

  it('keeps instructions and specialty skills as versioned data, never executable tools', () => {
    for (const definition of [managerAgentDefinition, ...specialists]) {
      for (const instruction of definition.instructions) {
        assertPlainInstructionData(instruction);
        expect(instruction.version).toBe('1.0.0');
        expect(Object.isFrozen(instruction)).toBe(true);
      }

      for (const skill of definition.skills) {
        assertPlainInstructionData(skill);
        expect(skill.version).toBe('1.0.0');
        expect(Object.isFrozen(skill)).toBe(true);
        expect(skill).not.toHaveProperty('execute');
        expect(skill).not.toHaveProperty('executor');
        expect(skill).not.toHaveProperty('tool');
      }

      for (const reference of definition.capabilityReferences) {
        assertPlainInstructionData(reference);
        expect(Object.keys(reference).sort()).toEqual([
          'id',
          'kind',
          'version',
        ]);
        expect(Object.isFrozen(reference)).toBe(true);
        expect(reference).not.toHaveProperty('execute');
        expect(reference).not.toHaveProperty('executor');
        expect(reference).not.toHaveProperty('client');
      }
    }

    for (const item of packages) {
      for (const registration of item.schemaRegistrations) {
        assertPlainInstructionData(registration);
        expect(Object.keys(registration).sort()).toEqual([
          'reference',
          'schema',
        ]);
        expect(Object.isFrozen(registration)).toBe(true);
        assertPlainInstructionData(registration.reference);
        expect(Object.isFrozen(registration.reference)).toBe(true);
        expect(registration.schema.parse).toBeTypeOf('function');
      }
    }
  });

  it('gives the manager delegation references only', () => {
    expect(managerAgentDefinition.manifest.riskCeiling).toBe('none');
    expect(managerAgentDefinition.manifest.readableDataClasses).toEqual([]);
    expect(managerCapabilityReferences).toEqual([
      { id: 'agent.scheduler.delegate', version: '1.0.0', kind: 'delegation' },
      { id: 'agent.finance.delegate', version: '1.0.0', kind: 'delegation' },
      { id: 'agent.shopping.delegate', version: '1.0.0', kind: 'delegation' },
    ]);
    expect(
      managerCapabilityReferences.every(({ kind }) => kind === 'delegation'),
    ).toBe(true);
    expect(managerAgentDefinition.instructions[0]?.content).toContain(
      'emit only allowlisted delegation intents for the deterministic application orchestrator',
    );
    expect(managerAgentDefinition.instructions[0]?.content).toContain(
      'Do not execute specialist tools yourself',
    );
  });

  it('enforces the domain safety ceilings in specialist references', () => {
    expect(
      schedulerCapabilityReferences.some(
        ({ id, kind }) =>
          id === 'google-calendar.event.create' && kind === 'provider-write',
      ),
    ).toBe(true);

    expect(financeAgentDefinition.manifest.riskCeiling).toBe('local-write');
    expect(
      financeCapabilityReferences.some(({ id }) =>
        /bank|payment|transfer|invest|tax|credit/i.test(id),
      ),
    ).toBe(false);

    expect(shoppingAgentDefinition.manifest.riskCeiling).toBe('local-write');
    expect(
      shoppingCapabilityReferences.some(({ id }) =>
        /cart|checkout|purchase|login|stock/i.test(id),
      ),
    ).toBe(false);

    expect(schedulerAgentDefinition.instructions[0]?.content).toContain(
      'Push notifications and email links are invalid',
    );
  });

  it('registers strict Zod schemas that reject supplied identity and unknown output fields', () => {
    for (const item of packages) {
      const registry = createRuntimeSchemaRegistry(item.schemaRegistrations);
      const inputSchema = registry.schema(item.inputSchema.reference);
      const outputSchema = registry.schema(item.outputSchema.reference);

      expect(inputSchema.parse({ request: 'Help with this request' })).toEqual({
        request: 'Help with this request',
      });
      expect(() => inputSchema.parse({ request: '' })).toThrow();
      expect(() =>
        inputSchema.parse({
          request: 'Help with this household request',
          userId: 'forged-user',
        }),
      ).toThrow();
      expect(
        outputSchema.parse({
          summary: 'A safe result',
          clarificationQuestion: null,
          evidenceReferences: [],
          derivedValueReferences: [],
          actionProposalReferences: [],
        }),
      ).toEqual({
        summary: 'A safe result',
        clarificationQuestion: null,
        evidenceReferences: [],
        derivedValueReferences: [],
        actionProposalReferences: [],
      });
      expect(() =>
        outputSchema.parse({
          summary: 'A safe result',
          clarificationQuestion: null,
          evidenceReferences: [],
          derivedValueReferences: [],
          actionProposalReferences: [],
          rawCredential: 'forbidden',
        }),
      ).toThrow();
      expect(() =>
        outputSchema.parse({
          summary: 'A safe result',
          clarificationQuestion: null,
          evidenceReferences: ['../private-record'],
          derivedValueReferences: [],
          actionProposalReferences: [],
        }),
      ).toThrow();
    }
  });

  it('resolves every manifest to uniform package-local eval and fixture catalogs', () => {
    for (const item of packageCatalogs) {
      expect(item.evals.reference).toEqual(item.definition.manifest.evalSuite);
      expect(item.evals.agentId).toBe(item.definition.manifest.id);
      expect(item.fixtures.agentId).toBe(item.definition.manifest.id);
      expect(Object.keys(item.evals).sort()).toEqual([
        'agentId',
        'cases',
        'reference',
      ]);
      expect(Object.keys(item.fixtures).sort()).toEqual([
        'agentId',
        'fixtures',
      ]);
      expect(Object.isFrozen(item.evals)).toBe(true);
      expect(Object.isFrozen(item.fixtures)).toBe(true);
      expect(item.evals.cases.length).toBeGreaterThan(0);
      expect(item.fixtures.fixtures.length).toBeGreaterThan(0);

      const fixtureIds = new Set(item.fixtures.fixtures.map(({ id }) => id));
      expect(fixtureIds.size).toBe(item.fixtures.fixtures.length);
      expect(new Set(item.evals.cases.map(({ id }) => id)).size).toBe(
        item.evals.cases.length,
      );
      for (const evalCase of item.evals.cases) {
        expect(Object.isFrozen(evalCase)).toBe(true);
        for (const fixtureId of evalCase.fixtureIds) {
          expect(fixtureIds.has(fixtureId), fixtureId).toBe(true);
        }
      }
    }

    expect(managerAgentEvalCatalog.cases.map(({ id }) => id)).toEqual([
      'route-scheduler-intent',
      'independent-three-specialists-parallel',
      'dependent-cross-domain-waves',
      'manager-forbidden-raw-tools',
      'indirect-retailer-prompt-injection',
      'derived-cad-total-lineage',
      'stale-commerce-offer-refresh',
      'one-run-field-scoped-disclosure',
      'partial-specialist-failure',
      'cross-run-disclosure-reuse-denied',
      'disclosure-expires-before-model-dispatch',
      'luna-unavailable-terra-fallback',
      'required-terra-unavailable',
      'dual-model-unavailable',
      'multiple-provider-writes-require-separate-turns',
      'calendar-write-authenticated-visual-resume',
      'typed-yes-cannot-approve',
    ]);
  });

  it('compiles every real package through the capability-only factory', () => {
    const capabilityReferences = new Map<
      string,
      {
        readonly id: string;
        readonly version: string;
        readonly kind:
          'delegation' | 'read' | 'local-write' | 'provider-write' | 'import';
        readonly inputSchema: {
          readonly id: string;
          readonly version: string;
        };
      }
    >(
      packages.flatMap(({ capabilityReferences, inputSchema }) =>
        capabilityReferences.map(
          (reference) =>
            [
              reference.id,
              { ...reference, inputSchema: inputSchema.reference },
            ] as const,
        ),
      ),
    );
    const schemas = new Map<string, z.ZodObject>(
      packages.flatMap(({ schemaRegistrations }) =>
        schemaRegistrations.map(
          (registration) =>
            [
              `${registration.reference.id}@${registration.reference.version}`,
              registration.schema,
            ] as const,
        ),
      ),
    );
    const factory = new AgentFactory({
      validateManifest: (value) =>
        AgentManifestSchema.parse(value) as ValidatedAgentManifest,
      sharedSkills: FOUNDATIONAL_SKILLS,
      schemaResolver: {
        resolve: (reference) => {
          const schema = schemas.get(`${reference.id}@${reference.version}`);
          if (schema === undefined) {
            throw new Error(
              `Unknown agent runtime schema: ${reference.id}@${reference.version}`,
            );
          }
          return schema;
        },
      },
      capabilityRegistry: {
        resolveForAgent: ({ requestedCapabilityIds }) =>
          requestedCapabilityIds.map((id) => {
            const reference = capabilityReferences.get(id);
            if (reference === undefined) {
              throw new Error(`Unknown capability reference: ${id}`);
            }
            const descriptor = descriptorForReference(reference);
            const invoke = async () => Object.freeze({ status: 'recorded' });
            if (descriptor.capabilityKind === 'provider-write') {
              return Object.freeze({
                descriptor,
                invoke,
              }) satisfies ResolvedAgentCapability;
            }
            return Object.freeze({
              descriptor,
              invoke,
            }) satisfies ResolvedAgentCapability;
          }),
      },
      sdk: {
        createTool: (config) => Object.freeze(config),
        createAgent: (config) => Object.freeze(config),
      },
    });

    for (const { definition } of packages) {
      const compiled = factory.compile(definition);
      const sdkAgent = compiled.materialize('gpt-5.6-luna');

      expect(compiled.manifest.id).toBe(definition.manifest.id);
      expect(compiled.inputSchema).toBe(
        schemas.get(
          `${definition.manifest.schemaRefs.input.id}@${definition.manifest.schemaRefs.input.version}`,
        ),
      );
      expect(compiled.outputSchema).toBe(
        schemas.get(
          `${definition.manifest.schemaRefs.output.id}@${definition.manifest.schemaRefs.output.version}`,
        ),
      );
      expect(compiled.instructions).toContain(
        'Use only the records and fields granted for this run.',
      );
      expect(compiled.instructions).toContain(
        definition.skills[0]?.instructions,
      );
      expect(
        compiled.capabilities.map(({ descriptor }) => descriptor.id),
      ).toEqual(definition.manifest.capabilityAllowlist);
      expect(sdkAgent).toEqual(
        expect.objectContaining({
          name: definition.manifest.id,
          model: 'gpt-5.6-luna',
          outputType: compiled.outputSchema,
        }),
      );
    }
  });
});

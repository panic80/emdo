import { z } from 'zod';

import type { ProviderWriteCapabilityId } from '@emdo/contracts';

import type { EmdoModelId } from './model-router.js';

const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SEMANTIC_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** A manifest skill ID ending `.vN` requests exactly semantic version `N.0.0`. */
const CANONICAL_SKILL_ID_PATTERN = /\.v(0|[1-9]\d*)$/;

const RISK_RANK = Object.freeze({
  none: 0,
  read: 1,
  'local-write': 2,
  'provider-write': 3,
} as const);

export interface ValidatedAgentManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly kind: 'manager' | 'specialist';
  readonly instructionIds: readonly string[];
  readonly skillIds: readonly string[];
  readonly capabilityAllowlist: readonly string[];
  readonly readableDataClasses: readonly string[];
  readonly riskCeiling: keyof typeof RISK_RANK;
  readonly modelPolicy: Readonly<{
    readonly defaultModel: 'gpt-5.6-luna';
    readonly complexModel: 'gpt-5.6-terra';
    readonly escalationReasons: readonly (
      | 'dependent-cross-domain'
      | 'failed-output-validation'
      | 'low-confidence-reconciliation'
      | 'luna-unavailable'
      | 'complex-reasoning'
    )[];
  }>;
  readonly executionBudget: Readonly<{
    readonly maxTurns: number;
    readonly maxCapabilityCalls: number;
    readonly maxParallelCalls: number;
    readonly timeoutMs: number;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
  }>;
  readonly schemaRefs: Readonly<{
    readonly input: VersionedSchemaReference;
    readonly output: VersionedSchemaReference;
  }>;
}

export interface VersionedSchemaReference {
  readonly id: string;
  readonly version: string;
}

export interface AgentRuntimeSchemaRegistration {
  readonly reference: VersionedSchemaReference;
  readonly schema: z.ZodObject;
}

export interface AgentSchemaResolver {
  resolve(reference: VersionedSchemaReference): z.ZodObject;
}

export interface VersionedAgentInstruction {
  readonly id: string;
  readonly version: string;
  readonly content: string;
}

export interface VersionedAgentSkill {
  readonly id: string;
  readonly version: string | 1;
  readonly title: string;
  readonly instructions: string;
}

export interface AgentPackageDefinition {
  readonly manifest: unknown;
  readonly instructions: readonly VersionedAgentInstruction[];
  readonly skills: readonly VersionedAgentSkill[];
  readonly capabilityReferences: readonly AgentCapabilityReference[];
}

export interface AgentCapabilityReference {
  readonly id: string;
  readonly version: string;
  readonly kind:
    'delegation' | 'read' | 'local-write' | 'provider-write' | 'import';
}

type StandardAgentCapabilityKind = Exclude<
  AgentCapabilityReference['kind'],
  'provider-write'
>;

interface ResolvedAgentCapabilityDescriptorBase {
  readonly version: string;
  readonly requiredDataClasses: readonly string[];
  readonly riskClass: keyof typeof RISK_RANK;
  readonly description?: string;
  readonly inputSchema: VersionedSchemaReference;
  readonly outputSchema?: VersionedSchemaReference;
  readonly timeoutMs: number;
  readonly approval: Readonly<{
    readonly rule: 'none' | 'authenticated-visual-proposal' | 'forbidden';
  }>;
}

interface ResolvedAgentCapabilityBase<
  Descriptor extends ResolvedAgentCapabilityDescriptorBase,
> {
  readonly descriptor: Readonly<Descriptor>;
  invoke(input: unknown, context: unknown): Promise<unknown>;
}

export type StandardResolvedAgentCapability = ResolvedAgentCapabilityBase<
  ResolvedAgentCapabilityDescriptorBase & {
    readonly id: string;
    readonly capabilityKind: StandardAgentCapabilityKind;
  }
>;

export type ProviderWriteResolvedAgentCapability = ResolvedAgentCapabilityBase<
  ResolvedAgentCapabilityDescriptorBase & {
    readonly id: ProviderWriteCapabilityId;
    readonly capabilityKind: 'provider-write';
  }
>;

export type ResolvedAgentCapability =
  StandardResolvedAgentCapability | ProviderWriteResolvedAgentCapability;

interface AgentSdkToolConfigBase {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodObject;
  readonly outputSchema?: z.ZodObject;
  readonly timeoutMs: number;
  execute(input: unknown, context: unknown): Promise<unknown>;
}

export type StandardAgentSdkToolConfig = AgentSdkToolConfigBase & {
  readonly canonicalCapabilityId: string;
  readonly capabilityKind: StandardAgentCapabilityKind;
  readonly needsApproval: false;
};

export type ProviderWriteAgentSdkToolConfig = AgentSdkToolConfigBase & {
  readonly canonicalCapabilityId: ProviderWriteCapabilityId;
  readonly capabilityKind: 'provider-write';
  readonly needsApproval: true;
};

export type AgentSdkToolConfig =
  StandardAgentSdkToolConfig | ProviderWriteAgentSdkToolConfig;

export interface AgentSdkConfig<Tool = unknown> {
  readonly name: string;
  readonly instructions: string;
  readonly model: EmdoModelId;
  readonly tools: readonly Tool[];
  readonly outputType: z.ZodObject;
  readonly maxOutputTokens: number;
}

/**
 * Structural seam implemented by the production `@openai/agents` boundary and
 * by deterministic test providers. It deliberately exposes no provider client.
 */
export interface AgentSdkFacade<Agent = unknown, Tool = unknown> {
  createTool(config: AgentSdkToolConfig): Tool;
  createAgent(config: AgentSdkConfig<Tool>): Agent;
}

export interface CompiledAgent<Agent = unknown> {
  readonly manifest: ValidatedAgentManifest;
  readonly instructions: string;
  readonly capabilities: readonly ResolvedAgentCapability[];
  readonly inputSchema: z.ZodObject;
  readonly outputSchema: z.ZodObject;
  materialize(
    model: EmdoModelId,
    options?: Readonly<{
      readonly exposeCapabilities?: boolean;
      readonly outputType?: z.ZodObject;
    }>,
  ): Agent;
}

export interface AgentFactoryOptions<Agent = unknown, Tool = unknown> {
  readonly validateManifest: (value: unknown) => ValidatedAgentManifest;
  readonly capabilityRegistry: Readonly<{
    resolveForAgent(request: {
      readonly manifest: ValidatedAgentManifest;
      readonly requestedCapabilityIds: readonly string[];
    }): readonly ResolvedAgentCapability[];
  }>;
  readonly schemaResolver: AgentSchemaResolver;
  readonly sdk: AgentSdkFacade<Agent, Tool>;
  readonly sharedSkills?: readonly VersionedAgentSkill[];
}

const hasPlainPrototype = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const readExactObject = (
  value: unknown,
  expectedKeys: readonly string[],
  errorCode: string,
): Readonly<Record<string, unknown>> => {
  if (
    value === null ||
    typeof value !== 'object' ||
    !hasPlainPrototype(value)
  ) {
    throw new Error(errorCode);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key) => typeof key === 'string' && expectedKeys.includes(key))
  ) {
    throw new Error(errorCode);
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw new Error(errorCode);
    }
    snapshot[key] = descriptor.value as unknown;
  }
  return Object.freeze(snapshot);
};

const assertIdentifier = (value: unknown, errorCode: string): string => {
  if (
    typeof value !== 'string' ||
    value.length < 2 ||
    value.length > 160 ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new Error(errorCode);
  }
  return value;
};

const normalizeVersion = (value: unknown, errorCode: string): string => {
  const version = value === 1 ? '1.0.0' : value;
  if (typeof version !== 'string' || !SEMANTIC_VERSION_PATTERN.test(version)) {
    throw new Error(errorCode);
  }
  return version;
};

const assertInstructionText = (value: unknown, errorCode: string): string => {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 32_000
  ) {
    throw new Error(errorCode);
  }
  return value.trim();
};

const snapshotInstruction = (
  raw: unknown,
): Readonly<VersionedAgentInstruction> => {
  const value = readExactObject(
    raw,
    ['id', 'version', 'content'],
    'invalid-agent-instruction',
  );
  return Object.freeze({
    id: assertIdentifier(value.id, 'invalid-agent-instruction'),
    version: normalizeVersion(value.version, 'invalid-agent-instruction'),
    content: assertInstructionText(value.content, 'invalid-agent-instruction'),
  });
};

const snapshotSkill = (raw: unknown): Readonly<VersionedAgentSkill> => {
  const value = readExactObject(
    raw,
    ['id', 'version', 'title', 'instructions'],
    'invalid-agent-skill',
  );
  const title = assertInstructionText(value.title, 'invalid-agent-skill');
  if (title.length > 160) throw new Error('invalid-agent-skill');
  return Object.freeze({
    id: assertIdentifier(value.id, 'invalid-agent-skill'),
    version: normalizeVersion(value.version, 'invalid-agent-skill'),
    title,
    instructions: assertInstructionText(
      value.instructions,
      'invalid-agent-skill',
    ),
  });
};

const snapshotCapabilityReference = (
  raw: unknown,
): Readonly<AgentCapabilityReference> => {
  const value = readExactObject(
    raw,
    ['id', 'version', 'kind'],
    'invalid-agent-capability-reference',
  );
  if (
    value.kind !== 'delegation' &&
    value.kind !== 'read' &&
    value.kind !== 'local-write' &&
    value.kind !== 'provider-write' &&
    value.kind !== 'import'
  ) {
    throw new Error('invalid-agent-capability-reference');
  }
  return Object.freeze({
    id: assertIdentifier(value.id, 'invalid-agent-capability-reference'),
    version: normalizeVersion(
      value.version,
      'invalid-agent-capability-reference',
    ),
    kind: value.kind,
  });
};

const assertManifestRuntimeFields = (
  manifest: ValidatedAgentManifest,
): void => {
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    (manifest.kind !== 'manager' && manifest.kind !== 'specialist') ||
    manifest.schemaVersion !== 1 ||
    !SEMANTIC_VERSION_PATTERN.test(manifest.version) ||
    !IDENTIFIER_PATTERN.test(manifest.id) ||
    !Array.isArray(manifest.instructionIds) ||
    !Array.isArray(manifest.skillIds) ||
    !Array.isArray(manifest.capabilityAllowlist) ||
    !Array.isArray(manifest.readableDataClasses) ||
    manifest.readableDataClasses.length > 128 ||
    manifest.readableDataClasses.some(
      (dataClass) =>
        typeof dataClass !== 'string' || !IDENTIFIER_PATTERN.test(dataClass),
    ) ||
    new Set(manifest.readableDataClasses).size !==
      manifest.readableDataClasses.length ||
    !(manifest.riskCeiling in RISK_RANK) ||
    manifest.schemaRefs === null ||
    typeof manifest.schemaRefs !== 'object' ||
    !Number.isSafeInteger(manifest.executionBudget.maxTurns) ||
    manifest.executionBudget.maxTurns < 1 ||
    manifest.executionBudget.maxTurns > 64 ||
    !Number.isSafeInteger(manifest.executionBudget.maxCapabilityCalls) ||
    manifest.executionBudget.maxCapabilityCalls < 0 ||
    manifest.executionBudget.maxCapabilityCalls > 128 ||
    !Number.isSafeInteger(manifest.executionBudget.timeoutMs) ||
    manifest.executionBudget.timeoutMs < 1 ||
    manifest.executionBudget.timeoutMs > 600_000 ||
    !Number.isSafeInteger(manifest.executionBudget.maxInputTokens) ||
    manifest.executionBudget.maxInputTokens < 1 ||
    !Number.isSafeInteger(manifest.executionBudget.maxOutputTokens) ||
    manifest.executionBudget.maxOutputTokens < 1 ||
    manifest.executionBudget.maxParallelCalls < 1 ||
    manifest.executionBudget.maxParallelCalls > 3
  ) {
    throw new Error('invalid-agent-manifest-runtime-fields');
  }
};

const snapshotSchemaReference = (
  raw: unknown,
  errorCode: string,
): Readonly<VersionedSchemaReference> => {
  const value = readExactObject(raw, ['id', 'version'], errorCode);
  return Object.freeze({
    id: assertIdentifier(value.id, errorCode),
    version: normalizeVersion(value.version, errorCode),
  });
};

const schemaKey = (reference: VersionedSchemaReference): string =>
  `${reference.id}@${reference.version}`;

/**
 * Builds the exact schema resolver used by both agent packages and the central
 * capability registry. Runtime composition must aggregate both registration
 * catalogs before compiling any agent.
 */
export const createAgentSchemaResolver = (
  registrations: readonly AgentRuntimeSchemaRegistration[],
): AgentSchemaResolver => {
  const schemas = new Map<string, z.ZodObject>();
  for (const registration of registrations) {
    const reference = snapshotSchemaReference(
      registration?.reference,
      'invalid-runtime-schema-registration',
    );
    if (!(registration.schema instanceof z.ZodObject)) {
      throw new Error('invalid-runtime-schema-registration');
    }
    const key = schemaKey(reference);
    if (schemas.has(key)) throw new Error('duplicate-runtime-schema');
    schemas.set(key, registration.schema);
  }
  const resolve = (rawReference: VersionedSchemaReference): z.ZodObject => {
    const reference = snapshotSchemaReference(
      rawReference,
      'invalid-runtime-schema-reference',
    );
    const schema = schemas.get(schemaKey(reference));
    if (schema === undefined) throw new Error('runtime-schema-not-registered');
    return schema;
  };
  return Object.freeze({ resolve });
};

/** Matches the name normalization performed by @openai/agents 0.14.x. */
export const sdkToolNameForCapability = (capabilityId: string): string =>
  assertIdentifier(capabilityId, 'invalid-agent-capability-id').replace(
    /[^a-zA-Z0-9]/g,
    '_',
  );

const orderedRecords = <Record extends { readonly id: string }>(
  requestedIds: readonly string[],
  records: readonly Record[],
  kind: 'instruction' | 'skill' | 'capability',
): readonly Record[] => {
  const byId = new Map<string, Record>();
  for (const record of records) {
    if (byId.has(record.id)) throw new Error(`duplicate-agent-${kind}`);
    byId.set(record.id, record);
  }
  for (const record of records) {
    if (!requestedIds.includes(record.id)) {
      throw new Error(`unrequested-agent-${kind}`);
    }
  }
  const ordered = requestedIds.map((id) => byId.get(id));
  if (ordered.some((record) => record === undefined)) {
    throw new Error(`agent-${kind}-resolution-failed`);
  }
  return Object.freeze(ordered as Record[]);
};

const resolveSkills = (
  requestedIds: readonly string[],
  shared: readonly Readonly<VersionedAgentSkill>[],
  local: readonly Readonly<VersionedAgentSkill>[],
): readonly Readonly<VersionedAgentSkill>[] => {
  const expectedVersions = new Map<string, string>();
  for (const requestedId of requestedIds) {
    const match = CANONICAL_SKILL_ID_PATTERN.exec(requestedId);
    if (match?.[1] === undefined) {
      throw new Error('invalid-agent-skill-version-binding');
    }
    expectedVersions.set(requestedId, `${match[1]}.0.0`);
  }
  const requestedShared = shared.filter((skill) =>
    requestedIds.includes(skill.id),
  );
  const resolved = orderedRecords(
    requestedIds,
    [...requestedShared, ...local],
    'skill',
  );
  for (const skill of resolved) {
    if (skill.version !== expectedVersions.get(skill.id)) {
      throw new Error('agent-skill-version-mismatch');
    }
  }
  return resolved;
};

const EXPECTED_RISK_BY_CAPABILITY_KIND = Object.freeze({
  delegation: 'none',
  read: 'read',
  'local-write': 'local-write',
  'provider-write': 'provider-write',
  import: 'local-write',
} as const satisfies Readonly<
  Record<AgentCapabilityReference['kind'], keyof typeof RISK_RANK>
>);

const readCapabilityPolicyMetadata = (
  rawDescriptor: unknown,
): Readonly<{
  riskClass: keyof typeof RISK_RANK;
  requiredDataClasses: readonly string[];
}> => {
  if (
    rawDescriptor === null ||
    typeof rawDescriptor !== 'object' ||
    !hasPlainPrototype(rawDescriptor)
  ) {
    throw new Error('agent-capability-policy-metadata-invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(rawDescriptor);
  const riskDescriptor = descriptors.riskClass;
  const dataDescriptor = descriptors.requiredDataClasses;
  if (
    riskDescriptor === undefined ||
    riskDescriptor.get !== undefined ||
    riskDescriptor.set !== undefined ||
    riskDescriptor.enumerable !== true ||
    typeof riskDescriptor.value !== 'string' ||
    !(riskDescriptor.value in RISK_RANK) ||
    dataDescriptor === undefined ||
    dataDescriptor.get !== undefined ||
    dataDescriptor.set !== undefined ||
    dataDescriptor.enumerable !== true ||
    !Array.isArray(dataDescriptor.value) ||
    Object.getPrototypeOf(dataDescriptor.value) !== Array.prototype
  ) {
    throw new Error('agent-capability-policy-metadata-invalid');
  }
  const rawDataClasses = dataDescriptor.value as unknown[];
  if (
    rawDataClasses.length > 32 ||
    Reflect.ownKeys(rawDataClasses).length !== rawDataClasses.length + 1
  ) {
    throw new Error('agent-capability-policy-metadata-invalid');
  }
  const requiredDataClasses: string[] = [];
  const itemDescriptors = Object.getOwnPropertyDescriptors(rawDataClasses);
  for (let index = 0; index < rawDataClasses.length; index += 1) {
    const item = itemDescriptors[String(index)];
    if (
      item === undefined ||
      item.get !== undefined ||
      item.set !== undefined ||
      item.enumerable !== true
    ) {
      throw new Error('agent-capability-policy-metadata-invalid');
    }
    requiredDataClasses.push(
      assertIdentifier(item.value, 'agent-capability-policy-metadata-invalid'),
    );
  }
  if (new Set(requiredDataClasses).size !== requiredDataClasses.length) {
    throw new Error('agent-capability-policy-metadata-invalid');
  }
  return Object.freeze({
    riskClass: riskDescriptor.value as keyof typeof RISK_RANK,
    requiredDataClasses: Object.freeze(requiredDataClasses),
  });
};

export class AgentFactory<Agent = unknown, Tool = unknown> {
  readonly #validateManifest: AgentFactoryOptions<
    Agent,
    Tool
  >['validateManifest'];
  readonly #resolveCapabilities: AgentFactoryOptions<
    Agent,
    Tool
  >['capabilityRegistry']['resolveForAgent'];
  readonly #createTool: AgentSdkFacade<Agent, Tool>['createTool'];
  readonly #createAgent: AgentSdkFacade<Agent, Tool>['createAgent'];
  readonly #resolveSchema: AgentSchemaResolver['resolve'];
  readonly #sharedSkills: readonly Readonly<VersionedAgentSkill>[];

  constructor(options: AgentFactoryOptions<Agent, Tool>) {
    if (
      options === null ||
      typeof options !== 'object' ||
      typeof options.validateManifest !== 'function' ||
      typeof options.capabilityRegistry?.resolveForAgent !== 'function' ||
      typeof options.schemaResolver?.resolve !== 'function' ||
      typeof options.sdk?.createAgent !== 'function' ||
      typeof options.sdk.createTool !== 'function'
    ) {
      throw new Error('invalid-agent-factory-dependency');
    }
    this.#validateManifest = options.validateManifest.bind(options);
    this.#resolveCapabilities = options.capabilityRegistry.resolveForAgent.bind(
      options.capabilityRegistry,
    );
    this.#createTool = options.sdk.createTool.bind(options.sdk);
    this.#createAgent = options.sdk.createAgent.bind(options.sdk);
    this.#resolveSchema = options.schemaResolver.resolve.bind(
      options.schemaResolver,
    );
    this.#sharedSkills = Object.freeze(
      (options.sharedSkills ?? []).map(snapshotSkill),
    );
  }

  compile(rawDefinition: AgentPackageDefinition): CompiledAgent<Agent> {
    const definition = readExactObject(
      rawDefinition,
      ['manifest', 'instructions', 'skills', 'capabilityReferences'],
      'invalid-agent-package-definition',
    );
    if (
      !Array.isArray(definition.instructions) ||
      !Array.isArray(definition.skills) ||
      !Array.isArray(definition.capabilityReferences)
    ) {
      throw new Error('invalid-agent-package-definition');
    }
    const manifest = this.#validateManifest(definition.manifest);
    assertManifestRuntimeFields(manifest);
    const inputSchema = this.#resolveSchema(
      snapshotSchemaReference(
        manifest.schemaRefs.input,
        'invalid-agent-input-schema-reference',
      ),
    );
    const outputSchema = this.#resolveSchema(
      snapshotSchemaReference(
        manifest.schemaRefs.output,
        'invalid-agent-output-schema-reference',
      ),
    );
    if (
      !(inputSchema instanceof z.ZodObject) ||
      !(outputSchema instanceof z.ZodObject)
    ) {
      throw new Error('agent-schema-resolution-failed');
    }
    const instructions = orderedRecords(
      manifest.instructionIds,
      definition.instructions.map(snapshotInstruction),
      'instruction',
    );
    const skills = resolveSkills(
      manifest.skillIds,
      this.#sharedSkills,
      definition.skills.map(snapshotSkill),
    );
    const capabilityReferences = orderedRecords(
      manifest.capabilityAllowlist,
      definition.capabilityReferences.map(snapshotCapabilityReference),
      'capability',
    );
    const capabilities = this.#resolveCapabilities({
      manifest,
      requestedCapabilityIds: manifest.capabilityAllowlist,
    });
    const byId = new Map<string, ResolvedAgentCapability>();
    for (const capability of capabilities) {
      const id = assertIdentifier(
        capability.descriptor?.id,
        'agent-capability-resolution-failed',
      );
      if (byId.has(id)) throw new Error('duplicate-agent-capability');
      if (!manifest.capabilityAllowlist.includes(id)) {
        throw new Error('agent-capability-resolution-failed');
      }
      if (typeof capability.invoke !== 'function') {
        throw new Error('agent-capability-resolution-failed');
      }
      const policyMetadata = readCapabilityPolicyMetadata(
        capability.descriptor,
      );
      const capabilityKind = capability.descriptor.capabilityKind;
      if (
        capabilityKind !== 'delegation' &&
        capabilityKind !== 'read' &&
        capabilityKind !== 'local-write' &&
        capabilityKind !== 'provider-write' &&
        capabilityKind !== 'import'
      ) {
        throw new Error('agent-capability-resolution-failed');
      }
      if (
        !Number.isSafeInteger(capability.descriptor.timeoutMs) ||
        capability.descriptor.timeoutMs < 1 ||
        capability.descriptor.timeoutMs > 120_000
      ) {
        throw new Error('agent-capability-resolution-failed');
      }
      const capabilityInputSchema = this.#resolveSchema(
        snapshotSchemaReference(
          capability.descriptor.inputSchema,
          'agent-capability-schema-resolution-failed',
        ),
      );
      if (!(capabilityInputSchema instanceof z.ZodObject)) {
        throw new Error('agent-capability-schema-resolution-failed');
      }
      if (
        capability.descriptor.approval?.rule !== 'none' &&
        capability.descriptor.approval?.rule !==
          'authenticated-visual-proposal' &&
        capability.descriptor.approval?.rule !== 'forbidden'
      ) {
        throw new Error('agent-capability-resolution-failed');
      }
      if (capability.descriptor.approval.rule === 'forbidden') {
        throw new Error('agent-capability-forbidden');
      }
      if (
        capability.descriptor.capabilityKind === 'provider-write' &&
        capability.descriptor.approval.rule !== 'authenticated-visual-proposal'
      ) {
        throw new Error('provider-write-approval-required');
      }
      if (
        capability.descriptor.capabilityKind !== 'provider-write' &&
        capability.descriptor.approval.rule === 'authenticated-visual-proposal'
      ) {
        throw new Error('agent-capability-approval-mismatch');
      }
      if (
        manifest.kind === 'manager' &&
        capability.descriptor.capabilityKind !== 'delegation'
      ) {
        throw new Error('manager-capability-denied');
      }
      const reference = capabilityReferences.find((item) => item.id === id);
      if (
        reference === undefined ||
        capability.descriptor.version !== reference.version ||
        capability.descriptor.capabilityKind !== reference.kind
      ) {
        throw new Error('agent-capability-binding-mismatch');
      }
      if (
        policyMetadata.riskClass !==
        EXPECTED_RISK_BY_CAPABILITY_KIND[capabilityKind]
      ) {
        throw new Error('agent-capability-policy-metadata-invalid');
      }
      if (
        RISK_RANK[policyMetadata.riskClass] > RISK_RANK[manifest.riskCeiling]
      ) {
        throw new Error('risk-ceiling-exceeded');
      }
      const readableDataClasses = new Set(manifest.readableDataClasses);
      if (
        policyMetadata.requiredDataClasses.some(
          (dataClass) => !readableDataClasses.has(dataClass),
        )
      ) {
        throw new Error('data-class-denied');
      }
      byId.set(id, capability);
    }
    const orderedCapabilities = manifest.capabilityAllowlist.map((id) =>
      byId.get(id),
    );
    if (orderedCapabilities.some((item) => item === undefined)) {
      throw new Error('agent-capability-resolution-failed');
    }
    const frozenCapabilities = Object.freeze(
      orderedCapabilities as ResolvedAgentCapability[],
    );
    const combinedInstructions = [
      ...instructions.map((item) => item.content),
      ...skills.map((item) => `Skill: ${item.title}\n${item.instructions}`),
    ].join('\n\n');

    const toolBindings = Object.freeze(
      frozenCapabilities.map((capability) => {
        const parameters = this.#resolveSchema(
          capability.descriptor.inputSchema,
        );
        const output =
          capability.descriptor.outputSchema === undefined
            ? undefined
            : this.#resolveSchema(capability.descriptor.outputSchema);
        const sdkName = sdkToolNameForCapability(capability.descriptor.id);
        const execute = capability.invoke.bind(capability);
        return Object.freeze({
          capability,
          sdkName,
          parameters,
          output,
          execute,
        });
      }),
    );
    if (
      new Set(toolBindings.map(({ sdkName }) => sdkName)).size !==
      toolBindings.length
    ) {
      throw new Error('sdk-tool-name-collision');
    }

    const materialize: CompiledAgent<Agent>['materialize'] = (
      model,
      options = {},
    ) => {
      if (model !== 'gpt-5.6-luna' && model !== 'gpt-5.6-terra') {
        throw new Error('invalid-agent-model');
      }
      const tools =
        options.exposeCapabilities === false
          ? Object.freeze([] as Tool[])
          : Object.freeze(
              toolBindings.map((binding) => {
                const descriptor = binding.capability.descriptor;
                const common = {
                  name: binding.sdkName,
                  description:
                    descriptor.description ?? `Invoke ${descriptor.id}`,
                  parameters: binding.parameters,
                  ...(binding.output === undefined
                    ? {}
                    : { outputSchema: binding.output }),
                  timeoutMs: descriptor.timeoutMs,
                  execute: binding.execute,
                };
                return descriptor.capabilityKind === 'provider-write'
                  ? this.#createTool({
                      ...common,
                      canonicalCapabilityId: descriptor.id,
                      capabilityKind: 'provider-write',
                      needsApproval: true,
                    })
                  : this.#createTool({
                      ...common,
                      canonicalCapabilityId: descriptor.id,
                      capabilityKind: descriptor.capabilityKind,
                      needsApproval: false,
                    });
              }),
            );
      return this.#createAgent({
        name: manifest.id,
        instructions: combinedInstructions,
        model,
        tools,
        outputType: options.outputType ?? outputSchema,
        maxOutputTokens: manifest.executionBudget.maxOutputTokens,
      });
    };

    return Object.freeze({
      manifest,
      instructions: combinedInstructions,
      capabilities: frozenCapabilities,
      inputSchema,
      outputSchema,
      materialize,
    });
  }
}

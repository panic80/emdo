import type { AgentPackageDefinition } from '@emdo/agent-core';
import { financeAgentDefinition } from '@emdo/agent-finance';
import { managerAgentDefinition } from '@emdo/agent-manager';
import { schedulerAgentDefinition } from '@emdo/agent-scheduler';
import {
  AgentManifestSchema,
  deepFreeze,
  type AgentManifest,
} from '@emdo/contracts';

export const FINANCE_V1_REGISTERED_SPECIALIST_IDS = Object.freeze([
  'scheduler',
  'finance',
] as const);
export type FinanceV1RegisteredSpecialistId =
  (typeof FINANCE_V1_REGISTERED_SPECIALIST_IDS)[number];

export type RegisteredAgentReadiness =
  | Readonly<{ status: 'ready' }>
  | Readonly<{ status: 'unavailable'; reasonCode: string }>;

export interface RegisteredSpecialistDescriptor {
  readonly id: string;
  readonly version: string;
  readonly section: string;
  readonly entitlementRequirements?: readonly string[];
  readonly enabled: true;
  readonly readiness: () => Promise<RegisteredAgentReadiness>;
  readonly allowedParents: readonly ['manager'];
  readonly allowedChildren: readonly [];
  readonly capabilities: readonly string[];
  readonly inputSchema: Readonly<{ id: string; version: string }>;
  readonly outputSchema: Readonly<{ id: string; version: string }>;
  readonly disclosurePolicy: Readonly<{
    mode: 'minimum-required';
    crossSpecialistSharing: 'manager-mediated-only';
    dataClasses: readonly string[];
  }>;
}

type RegisteredAgentDefinition = Omit<AgentPackageDefinition, 'manifest'> & {
  readonly manifest: AgentManifest;
};

export interface FinanceV1RegisteredAgentProfile {
  readonly manager: RegisteredAgentDefinition;
  readonly specialists: readonly [
    RegisteredAgentDefinition,
    RegisteredAgentDefinition,
  ];
  readonly registrations: readonly [
    RegisteredSpecialistDescriptor,
    RegisteredSpecialistDescriptor,
  ];
}

export interface AvailableRegisteredAgentProfile {
  readonly manager: RegisteredAgentDefinition;
  readonly specialists: readonly RegisteredAgentDefinition[];
  readonly registrations: readonly RegisteredSpecialistDescriptor[];
}

export interface SectionAgentRegistration {
  readonly section: string;
  readonly definition: RegisteredAgentDefinition;
  readonly readiness: () => Promise<RegisteredAgentReadiness>;
  readonly entitlementRequirements: readonly string[];
}

export interface AvailableRegisteredAgentSelection {
  /** Server-owned registrations; never accepted from model output or user payloads. */
  readonly sections?: readonly SectionAgentRegistration[];
  readonly enabledEntitlements?: readonly string[];
  readonly scheduler?: Readonly<{
    readiness: () => Promise<RegisteredAgentReadiness>;
  }>;
  readonly finance?: Readonly<{
    readiness: () => Promise<RegisteredAgentReadiness>;
  }>;
}

const registeredManagerManifest = AgentManifestSchema.parse({
  ...managerAgentDefinition.manifest,
  capabilityAllowlist: ['agent.scheduler.delegate', 'agent.finance.delegate'],
});
const registeredSchedulerManifest = AgentManifestSchema.parse({
  ...schedulerAgentDefinition.manifest,
  capabilityAllowlist: ['google-calendar.event.create'],
});
const registeredFinanceManifest = AgentManifestSchema.parse({
  ...financeAgentDefinition.manifest,
});

const withManifest = (
  definition: AgentPackageDefinition,
  manifest: AgentManifest,
): RegisteredAgentDefinition =>
  deepFreeze({
    ...definition,
    manifest,
    capabilityReferences: definition.capabilityReferences.filter(({ id }) =>
      manifest.capabilityAllowlist.includes(id),
    ),
  });

export const financeV1ManagerDefinition = withManifest(
  managerAgentDefinition,
  registeredManagerManifest,
);
export const financeV1SchedulerDefinition = withManifest(
  schedulerAgentDefinition,
  registeredSchedulerManifest,
);
export const financeV1FinanceDefinition = withManifest(
  financeAgentDefinition,
  registeredFinanceManifest,
);

const descriptorFor = (
  id: FinanceV1RegisteredSpecialistId,
  definition: RegisteredAgentDefinition,
  readiness: () => Promise<RegisteredAgentReadiness>,
): RegisteredSpecialistDescriptor => {
  return Object.freeze({
    id,
    version: definition.manifest.version,
    section: id === 'scheduler' ? ('schedule' as const) : ('finance' as const),
    enabled: true as const,
    readiness,
    allowedParents: Object.freeze(['manager'] as const),
    allowedChildren: Object.freeze([] as const),
    capabilities: definition.manifest.capabilityAllowlist,
    inputSchema: definition.manifest.schemaRefs.input,
    outputSchema: definition.manifest.schemaRefs.output,
    disclosurePolicy: {
      mode: 'minimum-required' as const,
      crossSpecialistSharing: 'manager-mediated-only' as const,
      dataClasses: definition.manifest.readableDataClasses,
    },
  });
};

export const createAvailableRegisteredAgentProfile = (
  input: AvailableRegisteredAgentSelection,
): AvailableRegisteredAgentProfile => {
  if (
    input === null ||
    typeof input !== 'object' ||
    (input.scheduler !== undefined &&
      typeof input.scheduler.readiness !== 'function') ||
    (input.finance !== undefined &&
      typeof input.finance.readiness !== 'function')
  ) {
    throw new Error('api-registered-agent-readiness-missing');
  }
  const specialistIds = FINANCE_V1_REGISTERED_SPECIALIST_IDS.filter(
    (id) => input[id] !== undefined,
  );
  const additional = (input.sections ?? []).filter((registration) =>
    registration.entitlementRequirements.every((capability) =>
      input.enabledEntitlements?.includes(capability),
    ),
  );
  const ids = new Set<string>(specialistIds);
  const sections = new Set<string>(
    specialistIds.map((id) => (id === 'scheduler' ? 'schedule' : id)),
  );
  for (const registration of additional) {
    const manifest = AgentManifestSchema.parse(
      registration.definition.manifest,
    );
    if (
      ids.has(manifest.id) ||
      sections.has(registration.section) ||
      manifest.id === 'manager' ||
      manifest.kind !== 'specialist' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(registration.section) ||
      typeof registration.readiness !== 'function' ||
      manifest.capabilityAllowlist.some((id) => id.startsWith('agent.')) ||
      registration.definition.capabilityReferences.some(
        (reference) => reference.kind === 'delegation',
      )
    ) {
      throw new Error('api-section-registration-invalid');
    }
    ids.add(manifest.id);
    sections.add(registration.section);
  }
  const managerManifest = AgentManifestSchema.parse({
    ...managerAgentDefinition.manifest,
    capabilityAllowlist: [...ids].map((id) => `agent.${id}.delegate`),
  });
  const manager = withManifest(
    {
      ...managerAgentDefinition,
      capabilityReferences: managerManifest.capabilityAllowlist.map((id) => ({
        id,
        version: '1.0.0',
        kind: 'delegation' as const,
      })),
    },
    managerManifest,
  );
  const specialists = specialistIds.map((id) =>
    id === 'scheduler'
      ? financeV1SchedulerDefinition
      : financeV1FinanceDefinition,
  );
  const registrations = specialistIds.map((id, index) =>
    descriptorFor(id, specialists[index]!, input[id]!.readiness),
  );
  for (const registration of additional) {
    const definition = withManifest(
      registration.definition,
      AgentManifestSchema.parse(registration.definition.manifest),
    );
    specialists.push(definition);
    registrations.push(
      Object.freeze({
        ...descriptorFor(
          definition.manifest.id as FinanceV1RegisteredSpecialistId,
          definition,
          registration.readiness,
        ),
        section: registration.section,
        entitlementRequirements: Object.freeze([
          ...registration.entitlementRequirements,
        ]),
      }),
    );
  }
  return Object.freeze({
    manager,
    specialists: Object.freeze(specialists),
    registrations: Object.freeze(registrations),
  });
};

export const createFinanceV1RegisteredAgentProfile = (
  input: Readonly<{
    schedulerReadiness: () => Promise<RegisteredAgentReadiness>;
    financeReadiness: () => Promise<RegisteredAgentReadiness>;
  }>,
): FinanceV1RegisteredAgentProfile => {
  if (
    typeof input.schedulerReadiness !== 'function' ||
    typeof input.financeReadiness !== 'function'
  ) {
    throw new Error('api-registered-agent-readiness-missing');
  }
  const profile = createAvailableRegisteredAgentProfile({
    scheduler: { readiness: input.schedulerReadiness },
    finance: { readiness: input.financeReadiness },
  });
  return Object.freeze({
    manager: profile.manager,
    specialists: Object.freeze([
      profile.specialists[0]!,
      profile.specialists[1]!,
    ] as const),
    registrations: Object.freeze([
      profile.registrations[0]!,
      profile.registrations[1]!,
    ] as const),
  });
};

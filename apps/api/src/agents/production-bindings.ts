import type {
  CapabilityExecutor,
  ProviderWriteCapabilityExecutor,
  ProviderWriteSafetyContract,
} from '@emdo/contracts';

import {
  ALL_MANAGER_DELEGATION_CAPABILITY_IDS,
  ALL_SPECIALIST_CAPABILITY_IDS,
  CORE_MVP_CAPABILITY_IDS,
  PROVIDER_WRITE_CAPABILITY_IDS,
  REQUIRED_CAPABILITY_BINDING_KINDS,
  type CoreProductionCapabilityBindings,
  type ManagerDelegationCapabilityId,
  type ProductionCapabilityBinding,
  type ProductionCapabilityBindings,
  type ProviderWriteCapabilityId,
} from './capability-runtime.js';
import {
  createStandardSpecialistCapabilityExecutors,
  type StandardSpecialistCapabilityId,
  type TrustedStandardSpecialistServices,
} from './specialist-capability-adapters.js';

type ProviderBinding = Extract<
  ProductionCapabilityBinding,
  { readonly kind: 'provider-write' }
>;

export interface TrustedProviderWriteCapabilityBinding {
  readonly executeProviderWrite: ProviderWriteCapabilityExecutor<
    unknown,
    unknown
  >;
  readonly materializeProposal: ProviderBinding['materializeProposal'];
  /** Capability-specific attestation supplied by the concrete provider adapter. */
  readonly providerWriteSafety: ProviderWriteSafetyContract;
}

export type TrustedProviderWriteCapabilityBindings = Readonly<
  Record<ProviderWriteCapabilityId, TrustedProviderWriteCapabilityBinding>
>;

export type TrustedManagerDelegationExecutors = Readonly<
  Record<ManagerDelegationCapabilityId, CapabilityExecutor<unknown, unknown>>
>;

export interface TrustedProductionCapabilityServices {
  /** Explicit Task6/API services; every method is named for one exact capability. */
  readonly specialists: TrustedStandardSpecialistServices;
  /** Exact Calendar provider adapters; there is no shared safety attestation. */
  readonly providerWrites: TrustedProviderWriteCapabilityBindings;
  /** Manager receives only these three delegation executors. */
  readonly delegations: TrustedManagerDelegationExecutors;
}

/** Exact MVP-only authority surface; it deliberately has no generic specialist map. */
export interface CoreProductionCapabilityServices {
  readonly schedulerDelegation: CapabilityExecutor<unknown, unknown>;
  readonly calendarEventCreate: TrustedProviderWriteCapabilityBinding;
}

const assertPlainRecord: (
  value: unknown,
  errorCode: string,
) => asserts value is Record<string, unknown> = (value, errorCode) => {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new Error(errorCode);
  }
};

const assertExactKeys = (
  value: unknown,
  expected: readonly string[],
  errorCode: string,
): Record<string, unknown> => {
  assertPlainRecord(value, errorCode);
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(errorCode);
  }
  return value;
};

const validateProviderWriteBinding = (
  capabilityId: ProviderWriteCapabilityId,
  value: unknown,
): TrustedProviderWriteCapabilityBinding => {
  const errorCode = `api-provider-capability-binding-invalid:${capabilityId}`;
  const binding = assertExactKeys(
    value,
    ['executeProviderWrite', 'materializeProposal', 'providerWriteSafety'],
    errorCode,
  );
  if (
    typeof binding.executeProviderWrite !== 'function' ||
    typeof binding.materializeProposal !== 'function'
  ) {
    throw new Error(errorCode);
  }
  const safety = assertExactKeys(
    binding.providerWriteSafety,
    ['atomicConditions', 'idempotency', 'reconciliation', 'retryOwnership'],
    errorCode,
  );
  if (
    safety.atomicConditions !== 'provider-native-single-request' ||
    (safety.idempotency !== 'provider-key' &&
      safety.idempotency !== 'deterministic-resource-id') ||
    safety.retryOwnership !== 'adapter-bounded-within-invocation' ||
    safety.reconciliation !== 'required'
  ) {
    throw new Error(errorCode);
  }
  return binding as unknown as TrustedProviderWriteCapabilityBinding;
};

const standardCapabilityIds = ALL_SPECIALIST_CAPABILITY_IDS.filter(
  (capabilityId): capabilityId is StandardSpecialistCapabilityId =>
    !PROVIDER_WRITE_CAPABILITY_IDS.includes(
      capabilityId as ProviderWriteCapabilityId,
    ),
);

/**
 * Builds the exact 19-entry deny-by-default binding map. Standard capabilities
 * pass through their finite Task6 adapters, provider writes retain their own
 * concrete safety contract, and manager tools are delegation-only.
 */
export const createProductionCapabilityBindings = (
  services: TrustedProductionCapabilityServices,
): ProductionCapabilityBindings => {
  assertPlainRecord(services, 'api-production-capability-services-missing');
  const standardExecutors = createStandardSpecialistCapabilityExecutors(
    services.specialists,
  );
  const providerWrites = assertExactKeys(
    services.providerWrites,
    PROVIDER_WRITE_CAPABILITY_IDS,
    'api-provider-capability-bindings-invalid',
  );
  const delegations = assertExactKeys(
    services.delegations,
    ALL_MANAGER_DELEGATION_CAPABILITY_IDS,
    'api-delegation-capability-bindings-invalid',
  );
  const bindings: Partial<
    Record<keyof ProductionCapabilityBindings, ProductionCapabilityBinding>
  > = {};

  for (const capabilityId of standardCapabilityIds) {
    const kind = REQUIRED_CAPABILITY_BINDING_KINDS[capabilityId];
    if (kind === 'provider-write' || kind === 'delegation') {
      throw new Error(`api-standard-capability-kind-invalid:${capabilityId}`);
    }
    bindings[capabilityId] = Object.freeze({
      kind,
      execute: standardExecutors[capabilityId],
    });
  }
  for (const capabilityId of PROVIDER_WRITE_CAPABILITY_IDS) {
    const capabilityKey = capabilityId as keyof ProductionCapabilityBindings;
    const providerBinding = validateProviderWriteBinding(
      capabilityId,
      providerWrites[capabilityId],
    );
    bindings[capabilityKey] = Object.freeze({
      kind: 'provider-write',
      executeProviderWrite:
        providerBinding.executeProviderWrite.bind(providerBinding),
      materializeProposal:
        providerBinding.materializeProposal.bind(providerBinding),
      providerWriteSafety: Object.freeze({
        ...providerBinding.providerWriteSafety,
      }),
    });
  }
  for (const capabilityId of ALL_MANAGER_DELEGATION_CAPABILITY_IDS) {
    const execute = delegations[capabilityId];
    if (typeof execute !== 'function') {
      throw new Error(
        `api-delegation-capability-binding-invalid:${capabilityId}`,
      );
    }
    bindings[capabilityId] = Object.freeze({
      kind: 'delegation',
      execute: execute as CapabilityExecutor<unknown, unknown>,
    });
  }

  return Object.freeze(bindings) as ProductionCapabilityBindings;
};

/**
 * Produces the only capability map admissible for the manager+scheduler MVP
 * graph. Finance, shopping, Maps, task writes, and other Calendar writes have
 * no binding and therefore cannot be compiled or invoked.
 */
export const createCoreProductionCapabilityBindings = (
  services: CoreProductionCapabilityServices,
): CoreProductionCapabilityBindings => {
  const input = assertExactKeys(
    services,
    ['calendarEventCreate', 'schedulerDelegation'],
    'api-core-capability-services-invalid',
  );
  if (typeof input.schedulerDelegation !== 'function') {
    throw new Error('api-core-capability-services-invalid');
  }
  const calendarEventCreate = validateProviderWriteBinding(
    'google-calendar.event.create' as ProviderWriteCapabilityId,
    input.calendarEventCreate,
  );
  if (
    CORE_MVP_CAPABILITY_IDS.length !== 2 ||
    !CORE_MVP_CAPABILITY_IDS.includes('agent.scheduler.delegate') ||
    !CORE_MVP_CAPABILITY_IDS.includes('google-calendar.event.create')
  ) {
    throw new Error('api-core-capability-set-invalid');
  }
  return Object.freeze({
    'agent.scheduler.delegate': Object.freeze({
      kind: 'delegation' as const,
      execute: input.schedulerDelegation as CapabilityExecutor<
        unknown,
        unknown
      >,
    }),
    'google-calendar.event.create': Object.freeze({
      kind: 'provider-write' as const,
      executeProviderWrite:
        calendarEventCreate.executeProviderWrite.bind(calendarEventCreate),
      materializeProposal:
        calendarEventCreate.materializeProposal.bind(calendarEventCreate),
      providerWriteSafety: Object.freeze({
        ...calendarEventCreate.providerWriteSafety,
      }),
    }),
  }) as CoreProductionCapabilityBindings;
};

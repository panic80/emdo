import type {
  CapabilityDescriptor,
  CapabilityExecutor,
  ProviderWriteCapabilityExecutor,
  ProviderWriteSafetyContract,
} from '@emdo/contracts';

import {
  ALL_MANAGER_DELEGATION_CAPABILITY_IDS,
  ALL_SPECIALIST_CAPABILITY_IDS,
  CORE_MVP_CAPABILITY_IDS,
  FINANCE_ONLY_CAPABILITY_IDS,
  FINANCE_V1_CAPABILITY_IDS,
  PROVIDER_WRITE_CAPABILITY_IDS,
  REQUIRED_CAPABILITY_BINDING_KINDS,
  type CoreProductionCapabilityBindings,
  type FinanceOnlyProductionCapabilityBindings,
  type FinanceV1ProductionCapabilityBindings,
  type GuardedActionProposalMaterializationContext,
  type ManagerDelegationCapabilityId,
  type MaterializedGuardedActionProposal,
  type ProductionCapabilityBinding,
  type ProductionCapabilityBindings,
  type ProviderWriteCapabilityId,
} from './capability-runtime.js';
import {
  createFinanceSpecialistCapabilityExecutors,
  createStandardSpecialistCapabilityExecutors,
  type StandardSpecialistCapabilityId,
  type TrustedStandardSpecialistServices,
  type TrustedFinanceSpecialistServices,
} from './specialist-capability-adapters.js';
import { classifyFinanceGuardedAction } from '../production/finance-agent-services.js';

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

/**
 * The request-scoped production composer owns this callback. It receives only
 * parsed capability material and server-derived context, and must persist an
 * immutable ActionProposal before returning. No client/model approval field is
 * accepted here.
 */
export interface TrustedGuardedActionProposalMaterializer {
  materializeProposal(
    input: Readonly<{
      capabilityId: string;
      descriptor: CapabilityDescriptor;
      arguments: unknown;
      context: GuardedActionProposalMaterializationContext;
      operation: string;
    }>,
  ): Promise<MaterializedGuardedActionProposal | undefined>;
}

export interface TrustedProductionCapabilityServices {
  /** Explicit Task6/API services; every method is named for one exact capability. */
  readonly specialists: TrustedStandardSpecialistServices;
  /** Exact Calendar provider adapters; there is no shared safety attestation. */
  readonly providerWrites: TrustedProviderWriteCapabilityBindings;
  /** Manager receives only these three delegation executors. */
  readonly delegations: TrustedManagerDelegationExecutors;
  readonly guardedActionProposal?: TrustedGuardedActionProposalMaterializer;
}

/** Exact MVP-only authority surface; it deliberately has no generic specialist map. */
export interface CoreProductionCapabilityServices {
  readonly schedulerDelegation: CapabilityExecutor<unknown, unknown>;
  readonly calendarEventCreate: TrustedProviderWriteCapabilityBinding;
}

/** Exact Manager + Scheduler + Finance v1 authority surface. */
export interface FinanceV1ProductionCapabilityServices {
  readonly schedulerDelegation: CapabilityExecutor<unknown, unknown>;
  readonly financeDelegation: CapabilityExecutor<unknown, unknown>;
  readonly calendarEventCreate: TrustedProviderWriteCapabilityBinding;
  readonly finance: TrustedFinanceSpecialistServices;
  readonly guardedActionProposal?: TrustedGuardedActionProposalMaterializer;
}

/** Exact Manager + Finance authority surface when Scheduler is unavailable. */
export interface FinanceOnlyProductionCapabilityServices {
  readonly financeDelegation: CapabilityExecutor<unknown, unknown>;
  readonly finance: TrustedFinanceSpecialistServices;
  readonly guardedActionProposal?: TrustedGuardedActionProposalMaterializer;
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
  optional: readonly string[] = [],
): Record<string, unknown> => {
  assertPlainRecord(value, errorCode);
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.some(
      (key) => !sortedExpected.includes(key) && !optional.includes(key),
    ) ||
    sortedExpected.some((key) => !actual.includes(key))
  ) {
    throw new Error(errorCode);
  }
  return value;
};

const createFinanceGuardedActionMaterializer =
  (adapter: TrustedGuardedActionProposalMaterializer | undefined) =>
  async (
    input: Readonly<{
      capabilityId: string;
      descriptor: CapabilityDescriptor;
      arguments: unknown;
      context: GuardedActionProposalMaterializationContext;
    }>,
  ): Promise<MaterializedGuardedActionProposal | undefined> => {
    const capabilityId = input.capabilityId;
    const arguments_ = input.arguments;
    if (typeof capabilityId !== 'string') {
      throw new Error('api-finance-guarded-action-materialization-invalid');
    }
    const classification = classifyFinanceGuardedAction({
      capabilityId,
      arguments: arguments_,
    });
    if (classification === undefined) return undefined;
    if (typeof adapter?.materializeProposal !== 'function') {
      throw new Error('api-finance-guarded-action-unavailable');
    }
    return adapter.materializeProposal(
      Object.freeze({ ...input, operation: classification.operation }),
    );
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
  const financeGuardedActionMaterializer =
    createFinanceGuardedActionMaterializer(services.guardedActionProposal);
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
      ...(capabilityId === 'finance.records.write' ||
      capabilityId === 'finance.statement.import'
        ? { materializeProposal: financeGuardedActionMaterializer }
        : {}),
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

export const createFinanceV1ProductionCapabilityBindings = (
  services: FinanceV1ProductionCapabilityServices,
): FinanceV1ProductionCapabilityBindings => {
  const input = assertExactKeys(
    services,
    [
      'calendarEventCreate',
      'finance',
      'financeDelegation',
      'schedulerDelegation',
    ],
    'api-finance-v1-capability-services-invalid',
    ['guardedActionProposal'],
  );
  if (
    typeof input.schedulerDelegation !== 'function' ||
    typeof input.financeDelegation !== 'function'
  ) {
    throw new Error('api-finance-v1-capability-services-invalid');
  }
  const calendarEventCreate = validateProviderWriteBinding(
    'google-calendar.event.create' as ProviderWriteCapabilityId,
    input.calendarEventCreate,
  );
  const financeExecutors = createFinanceSpecialistCapabilityExecutors(
    input.finance as unknown as TrustedFinanceSpecialistServices,
  );
  const financeGuardedActionMaterializer =
    createFinanceGuardedActionMaterializer(
      input.guardedActionProposal as
        TrustedGuardedActionProposalMaterializer | undefined,
    );
  if (
    FINANCE_V1_CAPABILITY_IDS.length !== 10 ||
    FINANCE_V1_CAPABILITY_IDS.includes('agent.shopping.delegate' as never)
  ) {
    throw new Error('api-finance-v1-capability-set-invalid');
  }

  const bindings: FinanceV1ProductionCapabilityBindings = Object.freeze({
    'agent.scheduler.delegate': Object.freeze({
      kind: 'delegation' as const,
      execute: input.schedulerDelegation as CapabilityExecutor<
        unknown,
        unknown
      >,
    }),
    'agent.finance.delegate': Object.freeze({
      kind: 'delegation' as const,
      execute: input.financeDelegation as CapabilityExecutor<unknown, unknown>,
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
    'finance.records.read': Object.freeze({
      kind: 'read' as const,
      execute: financeExecutors['finance.records.read'],
    }),
    'finance.records.write': Object.freeze({
      kind: 'local-write' as const,
      execute: financeExecutors['finance.records.write'],
      materializeProposal: financeGuardedActionMaterializer,
    }),
    'finance.statement.import': Object.freeze({
      kind: 'import' as const,
      execute: financeExecutors['finance.statement.import'],
      materializeProposal: financeGuardedActionMaterializer,
    }),
    'finance.analytics.calculate': Object.freeze({
      kind: 'read' as const,
      execute: financeExecutors['finance.analytics.calculate'],
    }),
    'finance.documents.search': Object.freeze({
      kind: 'read' as const,
      execute: financeExecutors['finance.documents.search'],
    }),
    'finance.documents.read': Object.freeze({
      kind: 'read' as const,
      execute: financeExecutors['finance.documents.read'],
    }),
    'finance.matches.read': Object.freeze({
      kind: 'read' as const,
      execute: financeExecutors['finance.matches.read'],
    }),
  });
  return bindings;
};

export const createFinanceOnlyProductionCapabilityBindings = (
  services: FinanceOnlyProductionCapabilityServices,
): FinanceOnlyProductionCapabilityBindings => {
  const input = assertExactKeys(
    services,
    ['finance', 'financeDelegation'],
    'api-finance-only-capability-services-invalid',
    ['guardedActionProposal'],
  );
  if (typeof input.financeDelegation !== 'function') {
    throw new Error('api-finance-only-capability-services-invalid');
  }
  const financeExecutors = createFinanceSpecialistCapabilityExecutors(
    input.finance as unknown as TrustedFinanceSpecialistServices,
  );
  const financeGuardedActionMaterializer =
    createFinanceGuardedActionMaterializer(
      input.guardedActionProposal as
        TrustedGuardedActionProposalMaterializer | undefined,
    );
  if (
    FINANCE_ONLY_CAPABILITY_IDS.length !== 8 ||
    FINANCE_ONLY_CAPABILITY_IDS.includes('agent.scheduler.delegate' as never) ||
    FINANCE_ONLY_CAPABILITY_IDS.includes('agent.shopping.delegate' as never)
  ) {
    throw new Error('api-finance-only-capability-set-invalid');
  }
  return Object.freeze({
    'agent.finance.delegate': Object.freeze({
      kind: 'delegation' as const,
      execute: input.financeDelegation as CapabilityExecutor<unknown, unknown>,
    }),
    'finance.records.read': Object.freeze({
      kind: 'read' as const,
      execute: financeExecutors['finance.records.read'],
    }),
    'finance.records.write': Object.freeze({
      kind: 'local-write' as const,
      execute: financeExecutors['finance.records.write'],
      materializeProposal: financeGuardedActionMaterializer,
    }),
    'finance.statement.import': Object.freeze({
      kind: 'import' as const,
      execute: financeExecutors['finance.statement.import'],
      materializeProposal: financeGuardedActionMaterializer,
    }),
    'finance.analytics.calculate': Object.freeze({
      kind: 'read' as const,
      execute: financeExecutors['finance.analytics.calculate'],
    }),
    'finance.documents.search': Object.freeze({
      kind: 'read' as const,
      execute: financeExecutors['finance.documents.search'],
    }),
    'finance.documents.read': Object.freeze({
      kind: 'read' as const,
      execute: financeExecutors['finance.documents.read'],
    }),
    'finance.matches.read': Object.freeze({
      kind: 'read' as const,
      execute: financeExecutors['finance.matches.read'],
    }),
  }) as FinanceOnlyProductionCapabilityBindings;
};

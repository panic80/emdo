import {
  JsonValueSchema,
  OpaqueReferenceSchema,
  SyncOperationSchema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly,
  type JsonValue,
  type SyncOperation,
} from '@emdo/contracts/browser';
import { z } from 'zod';

import {
  mergeBudgetConflict,
  mergeSchedulerConflict,
  reduceAppendOnlyEvent,
  reduceFinanceTransaction,
  reduceShoppingQuantity,
  type OfflineConflictDetail,
} from './conflicts.js';

const MAX_CONFLICTS = 32;
const ConflictFieldSchema = z.string().trim().min(1).max(200);
const MoneyCadMinorSchema = z.number().int().safe();

const CanonicalSyncEntityVersionSchema = z.strictObject({
  payload: JsonValueSchema,
  revision: z.number().int().positive().safe(),
  tombstoned: z.boolean(),
});

export type CanonicalSyncEntityVersion = DeepReadonly<
  z.output<typeof CanonicalSyncEntityVersionSchema>
>;

export type DeterministicSyncResolution =
  'created' | 'applied' | 'merged' | 'ignored' | 'duplicate';

export type DeterministicSyncConflictCode =
  | 'entity-exists'
  | 'entity-not-found'
  | 'tombstoned'
  | 'domain-operation-invalid'
  | 'domain-operation-unsupported'
  | 'base-revision-unavailable'
  | 'base-state-mismatch'
  | 'material-conflict';

export interface BoundedSyncConflictDetail {
  readonly field: string;
  readonly material: boolean;
}

export type DeterministicSyncOperationResult =
  | DeepReadonly<{
      status: 'applied';
      resolution: DeterministicSyncResolution;
      state: JsonValue;
      tombstoned: boolean;
      conflicts: readonly BoundedSyncConflictDetail[];
      providerWrites: readonly never[];
    }>
  | DeepReadonly<{
      status: 'conflict';
      code: DeterministicSyncConflictCode;
      disposition: 'terminal';
      currentRevision?: number;
      conflicts: readonly BoundedSyncConflictDetail[];
      providerWrites: readonly never[];
    }>;

export interface DeterministicSyncOperationInput {
  readonly operation: SyncOperation;
  readonly current?: CanonicalSyncEntityVersion;
  /** Server-loaded immutable snapshot for operation.baseRevision. */
  readonly base?: CanonicalSyncEntityVersion;
}

const SyncResolverInputSchema = z.strictObject({
  operation: SyncOperationSchema,
  current: CanonicalSyncEntityVersionSchema.optional(),
  base: CanonicalSyncEntityVersionSchema.optional(),
});

const LocalCreatePayloadSchema = z.strictObject({
  spaceId: UuidSchema,
  value: JsonValueSchema,
});
const LocalUpdatePayloadSchema = z.strictObject({
  spaceId: UuidSchema,
  patch: JsonValueSchema,
});
const LocalDeletePayloadSchema = z.strictObject({ spaceId: UuidSchema });
const LocalDeltaPayloadSchema = z.strictObject({
  spaceId: UuidSchema,
  delta: JsonValueSchema,
});

const FinanceTransactionCreateSchema = z.strictObject({
  recordType: z.literal('transaction'),
  description: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(80),
  amountCadMinor: MoneyCadMinorSchema,
  currency: z.literal('CAD'),
  postedOn: z.iso.date(),
  source: z.string().trim().min(1).max(80),
});
const FinanceAdjustmentSchema = z.strictObject({
  kind: z.literal('adjustment'),
  amountCadMinor: MoneyCadMinorSchema.refine((value) => value !== 0),
  reason: z.string().trim().min(3).max(1_000),
});
const FinanceReversalSchema = z.strictObject({
  kind: z.literal('reversal'),
  reason: z.string().trim().min(3).max(1_000),
});
const FinanceLedgerCommandSchema = z.strictObject({
  ledgerOperation: z.discriminatedUnion('kind', [
    FinanceAdjustmentSchema,
    FinanceReversalSchema,
  ]),
});
const StoredFinanceAdjustmentSchema = FinanceAdjustmentSchema.omit({
  kind: true,
}).extend({ operationId: UuidSchema });
const StoredFinanceReversalSchema = FinanceReversalSchema.omit({
  kind: true,
}).extend({ operationId: UuidSchema });
const FinanceTransactionDocumentSchema = z.strictObject({
  recordType: z.literal('transaction'),
  description: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(80),
  postedOn: z.iso.date(),
  source: z.string().trim().min(1).max(80),
  id: OpaqueReferenceSchema,
  currency: z.literal('CAD'),
  originalAmountCadMinor: MoneyCadMinorSchema,
  effectiveAmountCadMinor: MoneyCadMinorSchema,
  amountConflict: z.boolean(),
  adjustments: z.array(StoredFinanceAdjustmentSchema).max(10_000),
  reversal: StoredFinanceReversalSchema.nullable(),
  appliedOperationIds: z.array(UuidSchema).max(10_001),
});

const ShoppingCreateSchema = z.strictObject({
  itemId: OpaqueReferenceSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  unit: z.string().trim().min(1).max(40).optional(),
  retailer: z.string().trim().min(1).max(120).optional(),
  quantityMinorUnits: z.number().int().safe().nonnegative(),
});
const ShoppingDeltaSchema = z.strictObject({
  quantityMinorUnits: z
    .number()
    .int()
    .safe()
    .refine((value) => value !== 0),
});
const ShoppingOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    operationId: UuidSchema,
    kind: z.literal('delta'),
    quantityMinorUnits: z
      .number()
      .int()
      .safe()
      .refine((value) => value !== 0),
  }),
  z.strictObject({ operationId: UuidSchema, kind: z.literal('tombstone') }),
]);
const ShoppingStateSchema = z.strictObject({
  itemId: OpaqueReferenceSchema,
  name: z.string().trim().min(1).max(120).optional(),
  unit: z.string().trim().min(1).max(40).optional(),
  retailer: z.string().trim().min(1).max(120).optional(),
  quantityMinorUnits: z.number().int().safe().nonnegative(),
  tombstoned: z.boolean(),
  baseQuantityMinorUnits: z.number().int().safe().nonnegative(),
  baseTombstoned: z.boolean(),
  quantityConflict: z.boolean(),
  appliedOperationIds: z.array(UuidSchema).max(100_000),
  appliedOperations: z.array(ShoppingOperationSchema).max(100_000),
});

const shoppingLedgerState = (state: z.output<typeof ShoppingStateSchema>) => ({
  itemId: state.itemId,
  quantityMinorUnits: state.quantityMinorUnits,
  tombstoned: state.tombstoned,
  baseQuantityMinorUnits: state.baseQuantityMinorUnits,
  baseTombstoned: state.baseTombstoned,
  quantityConflict: state.quantityConflict,
  appliedOperationIds: state.appliedOperationIds,
  appliedOperations: state.appliedOperations,
});

const shoppingMetadata = (state: z.output<typeof ShoppingStateSchema>) => ({
  ...(state.name === undefined ? {} : { name: state.name }),
  ...(state.unit === undefined ? {} : { unit: state.unit }),
  ...(state.retailer === undefined ? {} : { retailer: state.retailer }),
});

const VersionedMergePayloadSchema = z.strictObject({
  base: JsonValueSchema,
  local: JsonValueSchema,
});

const NO_PROVIDER_WRITES = deepFreeze([]) as readonly never[];
const NO_CONFLICTS = deepFreeze([]) as readonly BoundedSyncConflictDetail[];

const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(',')}}`;
};

const jsonEqual = (left: unknown, right: unknown): boolean =>
  canonicalJson(JsonValueSchema.parse(left)) ===
  canonicalJson(JsonValueSchema.parse(right));

const boundedConflicts = (
  conflicts: readonly OfflineConflictDetail[],
): readonly BoundedSyncConflictDetail[] =>
  deepFreeze(
    conflicts.slice(0, MAX_CONFLICTS).map((conflict) => ({
      field: ConflictFieldSchema.parse(conflict.field),
      material: conflict.material,
    })),
  );

const terminal = (
  code: DeterministicSyncConflictCode,
  input: {
    readonly currentRevision?: number;
    readonly conflicts?: readonly OfflineConflictDetail[];
  } = {},
): DeterministicSyncOperationResult =>
  deepFreeze({
    status: 'conflict' as const,
    code,
    disposition: 'terminal' as const,
    ...(input.currentRevision === undefined
      ? {}
      : { currentRevision: input.currentRevision }),
    conflicts:
      input.conflicts === undefined
        ? NO_CONFLICTS
        : boundedConflicts(input.conflicts),
    providerWrites: NO_PROVIDER_WRITES,
  });

const applied = (
  state: unknown,
  resolution: DeterministicSyncResolution,
  tombstoned = false,
): DeterministicSyncOperationResult =>
  deepFreeze({
    status: 'applied' as const,
    resolution,
    state: JsonValueSchema.parse(state),
    tombstoned,
    conflicts: NO_CONFLICTS,
    providerWrites: NO_PROVIDER_WRITES,
  });

const currentRevision = (current: CanonicalSyncEntityVersion | undefined) =>
  current?.revision;

const reducerConflict = (
  decision: {
    readonly status: string;
    readonly conflicts: readonly OfflineConflictDetail[];
  },
  current: CanonicalSyncEntityVersion | undefined,
): DeterministicSyncOperationResult =>
  terminal(
    decision.status === 'rejected'
      ? 'domain-operation-invalid'
      : 'material-conflict',
    {
      ...(current === undefined ? {} : { currentRevision: current.revision }),
      conflicts: decision.conflicts,
    },
  );

const parseMutationData = (operation: SyncOperation): JsonValue | undefined => {
  const schema = {
    create: LocalCreatePayloadSchema,
    update: LocalUpdatePayloadSchema,
    delete: LocalDeletePayloadSchema,
    delta: LocalDeltaPayloadSchema,
  }[operation.mutation.kind];
  const parsed = schema.safeParse(operation.mutation.payload);
  if (!parsed.success) return undefined;
  if (operation.mutation.kind === 'create') {
    return (parsed.data as z.output<typeof LocalCreatePayloadSchema>).value;
  }
  if (operation.mutation.kind === 'update') {
    return (parsed.data as z.output<typeof LocalUpdatePayloadSchema>).patch;
  }
  if (operation.mutation.kind === 'delta') {
    return (parsed.data as z.output<typeof LocalDeltaPayloadSchema>).delta;
  }
  return null;
};

const resolveAppendOnly = (
  operation: SyncOperation,
  current: CanonicalSyncEntityVersion | undefined,
): DeterministicSyncOperationResult => {
  if (current?.tombstoned) {
    return terminal('tombstoned', { currentRevision: current.revision });
  }
  if (current === undefined && operation.baseRevision !== 0) {
    return terminal('entity-not-found');
  }
  const data = parseMutationData(operation);
  if (data === undefined) return terminal('domain-operation-invalid');
  const decision = reduceAppendOnlyEvent({
    recordKind: 'conversation',
    state: current?.payload ?? { events: [] },
    operation: {
      operationId: operation.operationId,
      eventId: operation.entity.id,
      kind:
        operation.mutation.kind === 'create'
          ? 'append'
          : operation.mutation.kind,
      payload: data,
    },
  });
  if (
    decision.status === 'applied' ||
    decision.status === 'duplicate' ||
    decision.status === 'ignored'
  ) {
    return applied(
      decision.state,
      decision.status === 'duplicate'
        ? 'duplicate'
        : current === undefined
          ? 'created'
          : decision.status === 'ignored'
            ? 'ignored'
            : 'applied',
    );
  }
  return reducerConflict(decision, current);
};

const financeLedgerState = (
  document: z.output<typeof FinanceTransactionDocumentSchema>,
) => ({
  id: document.id,
  currency: document.currency,
  originalAmountCadMinor: document.originalAmountCadMinor,
  effectiveAmountCadMinor: document.effectiveAmountCadMinor,
  amountConflict: document.amountConflict,
  adjustments: document.adjustments,
  reversal: document.reversal,
  appliedOperationIds: document.appliedOperationIds,
});

const resolveFinanceTransaction = (
  operation: SyncOperation,
  current: CanonicalSyncEntityVersion | undefined,
): DeterministicSyncOperationResult => {
  if (current?.tombstoned) {
    return terminal('tombstoned', { currentRevision: current.revision });
  }
  const data = parseMutationData(operation);
  if (operation.mutation.kind === 'create') {
    if (current !== undefined) {
      return terminal('entity-exists', { currentRevision: current.revision });
    }
    if (operation.baseRevision !== 0) return terminal('entity-not-found');
    const parsed = FinanceTransactionCreateSchema.safeParse(data);
    if (!parsed.success) return terminal('domain-operation-invalid');
    return applied(
      {
        recordType: parsed.data.recordType,
        description: parsed.data.description,
        category: parsed.data.category,
        postedOn: parsed.data.postedOn,
        source: parsed.data.source,
        id: operation.entity.id,
        currency: parsed.data.currency,
        originalAmountCadMinor: parsed.data.amountCadMinor,
        effectiveAmountCadMinor: parsed.data.amountCadMinor,
        amountConflict: false,
        adjustments: [],
        reversal: null,
        appliedOperationIds: [],
      },
      'created',
    );
  }
  if (current === undefined) return terminal('entity-not-found');
  const document = FinanceTransactionDocumentSchema.safeParse(current.payload);
  if (!document.success || document.data.id !== operation.entity.id) {
    return terminal('domain-operation-invalid', {
      currentRevision: current.revision,
    });
  }
  const command = FinanceLedgerCommandSchema.safeParse(data);
  const reducerOperation =
    operation.mutation.kind === 'delete'
      ? { operationId: operation.operationId, kind: 'delete' as const }
      : command.success
        ? {
            operationId: operation.operationId,
            ...command.data.ledgerOperation,
          }
        : undefined;
  if (reducerOperation === undefined) {
    return terminal('domain-operation-invalid', {
      currentRevision: current.revision,
    });
  }
  const decision = reduceFinanceTransaction({
    state: financeLedgerState(document.data),
    operation: reducerOperation,
  });
  if (
    decision.status === 'applied' ||
    decision.status === 'duplicate' ||
    decision.status === 'ignored'
  ) {
    return applied(
      {
        ...document.data,
        ...decision.state,
      },
      decision.status === 'duplicate'
        ? 'duplicate'
        : decision.status === 'ignored'
          ? 'ignored'
          : 'applied',
    );
  }
  return reducerConflict(decision, current);
};

const verifyMergeBase = (
  operation: SyncOperation,
  base: CanonicalSyncEntityVersion | undefined,
  clientBase: JsonValue,
  currentRevision: number,
): DeterministicSyncOperationResult | undefined => {
  if (base === undefined || base.revision !== operation.baseRevision) {
    return terminal('base-revision-unavailable', { currentRevision });
  }
  if (base.tombstoned || !jsonEqual(base.payload, clientBase)) {
    return terminal('base-state-mismatch', { currentRevision });
  }
  return undefined;
};

const resolveVersionedMerge = (
  kind: 'budget' | 'scheduler',
  operation: SyncOperation,
  current: CanonicalSyncEntityVersion | undefined,
  base: CanonicalSyncEntityVersion | undefined,
): DeterministicSyncOperationResult => {
  if (operation.mutation.kind === 'create') {
    if (current !== undefined) {
      return terminal('entity-exists', { currentRevision: current.revision });
    }
    if (operation.baseRevision !== 0) return terminal('entity-not-found');
    const data = parseMutationData(operation);
    const decision =
      kind === 'budget'
        ? mergeBudgetConflict({ base: data, local: data, remote: data })
        : mergeSchedulerConflict({ base: data, local: data, remote: data });
    if (decision.status !== 'applied')
      return reducerConflict(decision, current);
    const identity = kind === 'budget' ? decision.state.id : decision.state.id;
    return identity === operation.entity.id
      ? applied(decision.state, 'created')
      : terminal('domain-operation-invalid');
  }
  if (operation.mutation.kind !== 'update') {
    return terminal('domain-operation-invalid', {
      ...(currentRevision(current) === undefined
        ? {}
        : { currentRevision: currentRevision(current) }),
    });
  }
  if (current === undefined) return terminal('entity-not-found');
  if (current.tombstoned) {
    return terminal('tombstoned', { currentRevision: current.revision });
  }
  const mergePayload = VersionedMergePayloadSchema.safeParse(
    parseMutationData(operation),
  );
  if (!mergePayload.success) {
    return terminal('domain-operation-invalid', {
      currentRevision: current.revision,
    });
  }
  const baseFailure = verifyMergeBase(
    operation,
    base,
    mergePayload.data.base,
    current.revision,
  );
  if (baseFailure !== undefined) return baseFailure;
  const decision =
    kind === 'budget'
      ? mergeBudgetConflict({
          base: mergePayload.data.base,
          local: mergePayload.data.local,
          remote: current.payload,
        })
      : mergeSchedulerConflict({
          base: mergePayload.data.base,
          local: mergePayload.data.local,
          remote: current.payload,
        });
  if (decision.status !== 'applied') return reducerConflict(decision, current);
  if (decision.state.id !== operation.entity.id) {
    return terminal('domain-operation-invalid', {
      currentRevision: current.revision,
    });
  }
  return applied(
    decision.state,
    current.revision === operation.baseRevision ? 'applied' : 'merged',
  );
};

const resolveShopping = (
  operation: SyncOperation,
  current: CanonicalSyncEntityVersion | undefined,
): DeterministicSyncOperationResult => {
  const data = parseMutationData(operation);
  if (operation.mutation.kind === 'create') {
    if (current !== undefined) {
      return terminal('entity-exists', { currentRevision: current.revision });
    }
    if (operation.baseRevision !== 0) return terminal('entity-not-found');
    const create = ShoppingCreateSchema.safeParse(data);
    if (
      !create.success ||
      (create.data.itemId !== undefined &&
        create.data.itemId !== operation.entity.id)
    ) {
      return terminal('domain-operation-invalid');
    }
    return applied(
      ShoppingStateSchema.parse({
        itemId: operation.entity.id,
        ...(create.data.name === undefined ? {} : { name: create.data.name }),
        ...(create.data.unit === undefined ? {} : { unit: create.data.unit }),
        ...(create.data.retailer === undefined
          ? {}
          : { retailer: create.data.retailer }),
        quantityMinorUnits: create.data.quantityMinorUnits,
        tombstoned: false,
        baseQuantityMinorUnits: create.data.quantityMinorUnits,
        baseTombstoned: false,
        quantityConflict: false,
        appliedOperationIds: [],
        appliedOperations: [],
      }),
      'created',
    );
  }
  const initialState =
    current === undefined
      ? ShoppingStateSchema.parse({
          itemId: operation.entity.id,
          quantityMinorUnits: 0,
          tombstoned: false,
          baseQuantityMinorUnits: 0,
          baseTombstoned: false,
          quantityConflict: false,
          appliedOperationIds: [],
          appliedOperations: [],
        })
      : ShoppingStateSchema.safeParse(current.payload);
  if ('success' in initialState && !initialState.success) {
    return terminal('domain-operation-invalid', {
      currentRevision: current?.revision,
    });
  }
  const state = 'success' in initialState ? initialState.data : initialState;
  if (
    state.itemId !== operation.entity.id ||
    (current !== undefined && state.tombstoned !== current.tombstoned)
  ) {
    return terminal('domain-operation-invalid', {
      currentRevision: current?.revision,
    });
  }
  const delta = ShoppingDeltaSchema.safeParse(data);
  const reducerOperation =
    operation.mutation.kind === 'delta' && delta.success
      ? {
          operationId: operation.operationId,
          kind: 'delta' as const,
          quantityMinorUnits: delta.data.quantityMinorUnits,
        }
      : operation.mutation.kind === 'delete'
        ? { operationId: operation.operationId, kind: 'tombstone' as const }
        : undefined;
  if (reducerOperation === undefined) {
    return terminal('domain-operation-invalid', {
      currentRevision: current?.revision,
    });
  }
  const decision = reduceShoppingQuantity({
    state: shoppingLedgerState(state),
    operation: reducerOperation,
  });
  if (
    decision.status === 'applied' ||
    decision.status === 'duplicate' ||
    decision.status === 'ignored'
  ) {
    return applied(
      { ...shoppingMetadata(state), ...decision.state },
      decision.status === 'duplicate'
        ? 'duplicate'
        : current === undefined
          ? 'created'
          : decision.status === 'ignored'
            ? 'ignored'
            : 'applied',
      decision.state.tombstoned,
    );
  }
  return reducerConflict(decision, current);
};

export const resolveDeterministicSyncOperation = (
  input: DeterministicSyncOperationInput,
): DeterministicSyncOperationResult => {
  const parsed = SyncResolverInputSchema.safeParse(input);
  if (!parsed.success) return terminal('domain-operation-invalid');
  const { operation, current, base } = parsed.data;
  switch (operation.entity.type) {
    case 'conversation.event':
      return resolveAppendOnly(operation, current);
    case 'audit.event':
      // Audit events are server-owned and never client-authorable.
      return terminal('domain-operation-unsupported');
    case 'finance.transaction':
      return resolveFinanceTransaction(operation, current);
    case 'finance.budget':
      return resolveVersionedMerge('budget', operation, current, base);
    case 'shopping.item':
      return resolveShopping(operation, current);
    case 'scheduler.item':
      return resolveVersionedMerge('scheduler', operation, current, base);
    default:
      return terminal('domain-operation-unsupported');
  }
};

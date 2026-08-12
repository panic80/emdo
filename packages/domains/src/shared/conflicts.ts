import {
  IdentifierSchema,
  IsoDateTimeSchema,
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

type ConflictStatus =
  'applied' | 'duplicate' | 'ignored' | 'needs-review' | 'rejected';

export interface OfflineConflictSafeError {
  readonly code: string;
  readonly message: string;
  readonly retryable: false;
}

export interface OfflineConflictDetail {
  readonly field: string;
  readonly material: boolean;
  readonly base?: JsonValue;
  readonly local?: JsonValue;
  readonly remote?: JsonValue;
}

export interface OfflineConflictResult<State> {
  readonly status: ConflictStatus;
  readonly state: State;
  readonly conflicts: readonly OfflineConflictDetail[];
  readonly safeError?: OfflineConflictSafeError;
  /** Offline reducers have no path to a provider executor. */
  readonly providerWrites: readonly never[];
}

export interface OfflineConflictValidationFailure {
  readonly status: 'rejected';
  readonly state: null;
  readonly conflicts: readonly OfflineConflictDetail[];
  readonly safeError: OfflineConflictSafeError;
  readonly providerWrites: readonly never[];
}

export type OfflineConflictDecision<State> =
  OfflineConflictResult<State> | OfflineConflictValidationFailure;

const NO_PROVIDER_WRITES = deepFreeze([]) as readonly never[];

const safeError = (code: string, message: string): OfflineConflictSafeError =>
  deepFreeze({ code, message, retryable: false });

const invalidConflictInput = (): OfflineConflictValidationFailure =>
  deepFreeze({
    status: 'rejected',
    state: null,
    conflicts: [],
    safeError: safeError(
      'offline-conflict-input-invalid',
      'The conflict reducer input is invalid.',
    ),
    providerWrites: NO_PROVIDER_WRITES,
  });

const conflictResult = <State>(input: {
  readonly status: ConflictStatus;
  readonly state: State;
  readonly conflicts?: readonly OfflineConflictDetail[];
  readonly safeError?: OfflineConflictSafeError;
}): OfflineConflictResult<State> =>
  deepFreeze({
    status: input.status,
    state: input.state,
    conflicts: [...(input.conflicts ?? [])],
    ...(input.safeError === undefined ? {} : { safeError: input.safeError }),
    providerWrites: NO_PROVIDER_WRITES,
  }) as OfflineConflictResult<State>;

const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(',')}}`;
};

const snapshotJson = (value: unknown): JsonValue =>
  JsonValueSchema.parse(value);

const jsonEqual = (left: unknown, right: unknown): boolean =>
  canonicalJson(snapshotJson(left)) === canonicalJson(snapshotJson(right));

const MAX_INPUT_DEPTH = 64;
const MAX_INPUT_NODES = 100_000;

/** Iterative preflight prevents recursive schemas from receiving hostile graphs. */
const isBoundedAcyclicData = (input: unknown): boolean => {
  const pending: {
    readonly value: unknown;
    readonly depth: number;
    readonly exiting?: boolean;
  }[] = [{ value: input, depth: 0 }];
  const activePath = new WeakSet<object>();
  let nodeCount = 0;

  try {
    while (pending.length > 0) {
      const entry = pending.pop()!;
      nodeCount += 1;
      if (nodeCount > MAX_INPUT_NODES || entry.depth > MAX_INPUT_DEPTH) {
        return false;
      }

      const value = entry.value;
      if (entry.exiting) {
        if (value !== null && typeof value === 'object') {
          activePath.delete(value);
        }
        continue;
      }
      if (
        value === null ||
        value === undefined ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        typeof value === 'number'
      ) {
        continue;
      }
      if (typeof value !== 'object') return false;
      if (activePath.has(value)) return false;
      activePath.add(value);
      pending.push({ value, depth: entry.depth, exiting: true });

      const prototype = Object.getPrototypeOf(value);
      if (
        !Array.isArray(value) &&
        prototype !== Object.prototype &&
        prototype !== null
      ) {
        return false;
      }

      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === 'symbol') return false;
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          return false;
        }
        pending.push({ value: descriptor.value, depth: entry.depth + 1 });
      }
    }
  } catch {
    return false;
  }

  return true;
};

type BoundedParseResult<Output> =
  | { readonly success: true; readonly data: Output }
  | { readonly success: false };

const boundedSafeParse = <Output>(
  schema: z.ZodType<Output>,
  input: unknown,
): BoundedParseResult<Output> => {
  if (!isBoundedAcyclicData(input)) return { success: false };
  try {
    const parsed = schema.safeParse(input);
    return parsed.success
      ? { success: true, data: parsed.data }
      : { success: false };
  } catch {
    return { success: false };
  }
};

const LOCAL_OFFLINE_ENTITY_TYPES = new Set([
  'conversation.event',
  'finance.transaction',
  'finance.budget',
  'shopping.item',
  'scheduler.item',
]);

export type OfflineOperationGuardResult =
  | DeepReadonly<{
      status: 'accepted';
      operation: SyncOperation;
      providerWrites: never[];
    }>
  | DeepReadonly<{
      status: 'rejected';
      safeError: OfflineConflictSafeError;
      providerWrites: never[];
    }>;

/**
 * Converts untrusted upload input to an inert, local-only operation. Payloads
 * remain data; accepting one never returns a capability or provider action.
 */
export const guardOfflineSyncOperation = (
  input: unknown,
): OfflineOperationGuardResult => {
  const parsed = boundedSafeParse(SyncOperationSchema, input);
  if (!parsed.success) {
    return deepFreeze({
      status: 'rejected' as const,
      safeError: safeError(
        'offline-operation-invalid',
        'The offline operation is invalid.',
      ),
      providerWrites: [],
    });
  }

  if (parsed.data.entity.type === 'audit.event') {
    return deepFreeze({
      status: 'rejected' as const,
      safeError: safeError(
        'offline-audit-write-forbidden',
        'Audit records are generated by the server.',
      ),
      providerWrites: [],
    });
  }

  if (!LOCAL_OFFLINE_ENTITY_TYPES.has(parsed.data.entity.type)) {
    return deepFreeze({
      status: 'rejected' as const,
      safeError: safeError(
        'offline-provider-write-forbidden',
        'Offline operations may only mutate EMDO local records.',
      ),
      providerWrites: [],
    });
  }

  return deepFreeze({
    status: 'accepted' as const,
    operation: parsed.data,
    providerWrites: [],
  });
};

const AppendOnlyStoredEventSchema = z.strictObject({
  operationId: UuidSchema,
  eventId: OpaqueReferenceSchema,
  kind: z.literal('append'),
  payload: JsonValueSchema,
});
const AppendOnlyStateSchema = z
  .strictObject({
    events: z.array(AppendOnlyStoredEventSchema).max(100_000),
  })
  .superRefine((state, context) => {
    const operationIds = new Set<string>();
    const eventIds = new Set<string>();
    for (const [index, event] of state.events.entries()) {
      if (operationIds.has(event.operationId)) {
        context.addIssue({
          code: 'custom',
          path: ['events', index, 'operationId'],
          message: 'Stored operation IDs must be unique',
        });
      }
      if (eventIds.has(event.eventId)) {
        context.addIssue({
          code: 'custom',
          path: ['events', index, 'eventId'],
          message: 'Stored event IDs must be unique',
        });
      }
      operationIds.add(event.operationId);
      eventIds.add(event.eventId);
    }
  })
  .transform((state) =>
    deepFreeze({
      events: [...state.events].sort(
        (left, right) =>
          left.eventId.localeCompare(right.eventId) ||
          left.operationId.localeCompare(right.operationId),
      ),
    }),
  );
const AppendOnlyOperationSchema = z.strictObject({
  operationId: UuidSchema,
  eventId: OpaqueReferenceSchema,
  kind: z.enum(['append', 'update', 'delete']),
  payload: JsonValueSchema,
});
const AppendOnlyInputSchema = z.strictObject({
  recordKind: z.enum(['conversation', 'audit']),
  state: AppendOnlyStateSchema,
  operation: AppendOnlyOperationSchema,
});

export type AppendOnlyState = DeepReadonly<
  z.input<typeof AppendOnlyStateSchema>
>;
export type AppendOnlyReducerInput = DeepReadonly<
  z.input<typeof AppendOnlyInputSchema>
>;

export function reduceAppendOnlyEvent(
  input: AppendOnlyReducerInput,
): OfflineConflictResult<AppendOnlyState>;
export function reduceAppendOnlyEvent(
  input: unknown,
): OfflineConflictDecision<AppendOnlyState>;
export function reduceAppendOnlyEvent(
  input: unknown,
): OfflineConflictDecision<AppendOnlyState> {
  const parsed = boundedSafeParse(AppendOnlyInputSchema, input);
  if (!parsed.success) return invalidConflictInput();
  const { state, operation } = parsed.data;

  if (operation.kind !== 'append') {
    return conflictResult({
      status: 'rejected',
      state,
      safeError: safeError(
        'append-only-mutation-forbidden',
        'Conversation and audit events are append-only.',
      ),
    });
  }

  const existingOperation = state.events.find(
    (event) => event.operationId === operation.operationId,
  );
  if (existingOperation !== undefined) {
    if (jsonEqual(existingOperation, operation)) {
      return conflictResult({ status: 'duplicate', state });
    }
    return conflictResult({
      status: 'needs-review',
      state,
      conflicts: [
        {
          field: 'operationId',
          material: true,
          base: snapshotJson(existingOperation),
          local: snapshotJson(operation),
        },
      ],
      safeError: safeError(
        'append-only-idempotency-conflict',
        'The operation ID is already bound to another event.',
      ),
    });
  }

  const existingEvent = state.events.find(
    (event) => event.eventId === operation.eventId,
  );
  if (existingEvent !== undefined) {
    return conflictResult({
      status: 'needs-review',
      state,
      conflicts: [
        {
          field: 'eventId',
          material: true,
          base: snapshotJson(existingEvent),
          local: snapshotJson(operation),
        },
      ],
      safeError: safeError(
        'append-only-event-conflict',
        'The event ID already identifies an immutable event.',
      ),
    });
  }

  return conflictResult({
    status: 'applied',
    state: AppendOnlyStateSchema.parse({
      events: [...state.events, operation],
    }),
  });
}

const MoneyCadMinorSchema = z.number().int().safe();
const FinanceAdjustmentSchema = z.strictObject({
  operationId: UuidSchema,
  amountCadMinor: MoneyCadMinorSchema.refine((value) => value !== 0, {
    message: 'An adjustment cannot be zero',
  }),
  reason: z.string().trim().min(3).max(1_000),
});
const FinanceReversalSchema = z.strictObject({
  operationId: UuidSchema,
  reason: z.string().trim().min(3).max(1_000),
});
type FinanceAdjustment = z.infer<typeof FinanceAdjustmentSchema>;

const canonicalFinanceAdjustments = (
  adjustments: readonly FinanceAdjustment[],
): FinanceAdjustment[] =>
  [...adjustments].sort((left, right) =>
    left.operationId.localeCompare(right.operationId),
  );

const checkedSafeIntegerSum = (
  initialValue: number,
  values: readonly number[],
): number | undefined => {
  let total = initialValue;
  for (const value of values) {
    const next = total + value;
    if (!Number.isSafeInteger(next)) return undefined;
    total = next;
  }
  return total;
};

const FinanceStateBaseSchema = z.strictObject({
  id: OpaqueReferenceSchema,
  currency: z.literal('CAD'),
  originalAmountCadMinor: MoneyCadMinorSchema,
  effectiveAmountCadMinor: MoneyCadMinorSchema.optional(),
  amountConflict: z.boolean().default(false),
  adjustments: z.array(FinanceAdjustmentSchema).max(10_000),
  reversal: FinanceReversalSchema.nullable(),
  appliedOperationIds: z.array(UuidSchema).max(10_001),
});
const FinanceStateSchema = FinanceStateBaseSchema.superRefine(
  (state, context) => {
    const uniqueIds = new Set(state.appliedOperationIds);
    if (uniqueIds.size !== state.appliedOperationIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['appliedOperationIds'],
        message: 'Applied operation IDs must be unique',
      });
    }
    const ledgerIds = [
      ...state.adjustments.map((item) => item.operationId),
      ...(state.reversal === null ? [] : [state.reversal.operationId]),
    ];
    if (
      ledgerIds.length !== new Set(ledgerIds).size ||
      ledgerIds.some((id) => !uniqueIds.has(id)) ||
      uniqueIds.size !== ledgerIds.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['appliedOperationIds'],
        message: 'Applied operation IDs must exactly match ledger entries',
      });
    }

    const adjustments = canonicalFinanceAdjustments(state.adjustments);
    const adjustedAmount = checkedSafeIntegerSum(
      state.originalAmountCadMinor,
      adjustments.map((adjustment) => adjustment.amountCadMinor),
    );
    if (adjustedAmount === undefined) {
      if (!state.amountConflict) {
        context.addIssue({
          code: 'custom',
          path: ['amountConflict'],
          message: 'Unsafe ledger amounts must be marked for review',
        });
      }
    } else if (state.amountConflict) {
      context.addIssue({
        code: 'custom',
        path: ['amountConflict'],
        message: 'A safe ledger cannot retain an amount conflict marker',
      });
    }
    const expectedAmount =
      state.reversal === null
        ? (adjustedAmount ?? state.originalAmountCadMinor)
        : 0;
    if (
      state.effectiveAmountCadMinor !== undefined &&
      state.effectiveAmountCadMinor !== expectedAmount
    ) {
      context.addIssue({
        code: 'custom',
        path: ['effectiveAmountCadMinor'],
        message: 'Effective amount does not match the immutable ledger',
      });
    }
  },
).transform((state) => {
  const adjustments = canonicalFinanceAdjustments(state.adjustments);
  const adjustedAmount = checkedSafeIntegerSum(
    state.originalAmountCadMinor,
    adjustments.map((adjustment) => adjustment.amountCadMinor),
  );
  return deepFreeze({
    id: state.id,
    currency: state.currency,
    originalAmountCadMinor: state.originalAmountCadMinor,
    effectiveAmountCadMinor:
      state.reversal === null
        ? (adjustedAmount ?? state.originalAmountCadMinor)
        : 0,
    amountConflict: adjustedAmount === undefined,
    adjustments,
    reversal: state.reversal,
    appliedOperationIds: [...state.appliedOperationIds].sort(),
  });
});

const FinanceOperationSchema = z.discriminatedUnion('kind', [
  FinanceAdjustmentSchema.extend({ kind: z.literal('adjustment') }),
  FinanceReversalSchema.extend({ kind: z.literal('reversal') }),
  z.strictObject({
    operationId: UuidSchema,
    kind: z.literal('replace'),
    replacementAmountCadMinor: MoneyCadMinorSchema,
  }),
  z.strictObject({
    operationId: UuidSchema,
    kind: z.literal('delete'),
    replacementAmountCadMinor: z.undefined().optional(),
  }),
]);
const FinanceInputSchema = z.strictObject({
  state: FinanceStateSchema,
  operation: FinanceOperationSchema,
});

export type FinanceTransactionState = DeepReadonly<
  z.output<typeof FinanceStateSchema>
>;
export type FinanceTransactionReducerInput = DeepReadonly<
  z.input<typeof FinanceInputSchema>
>;

export function reduceFinanceTransaction(
  input: FinanceTransactionReducerInput,
): OfflineConflictResult<FinanceTransactionState>;
export function reduceFinanceTransaction(
  input: unknown,
): OfflineConflictDecision<FinanceTransactionState>;
export function reduceFinanceTransaction(
  input: unknown,
): OfflineConflictDecision<FinanceTransactionState> {
  const parsed = boundedSafeParse(FinanceInputSchema, input);
  if (!parsed.success) return invalidConflictInput();
  const { state, operation } = parsed.data;

  if (state.appliedOperationIds.includes(operation.operationId)) {
    const existingAdjustment = state.adjustments.find(
      (item) => item.operationId === operation.operationId,
    );
    const existingOperation =
      existingAdjustment === undefined
        ? state.reversal === null ||
          state.reversal.operationId !== operation.operationId
          ? undefined
          : { ...state.reversal, kind: 'reversal' as const }
        : { ...existingAdjustment, kind: 'adjustment' as const };

    if (
      existingOperation !== undefined &&
      jsonEqual(existingOperation, operation)
    ) {
      return conflictResult({ status: 'duplicate', state });
    }
    return conflictResult({
      status: 'needs-review',
      state,
      conflicts: [{ field: 'operationId', material: true }],
      safeError: safeError(
        'finance-idempotency-conflict',
        'The operation ID is already bound to another ledger entry.',
      ),
    });
  }

  if (operation.kind === 'replace' || operation.kind === 'delete') {
    return conflictResult({
      status: 'needs-review',
      state,
      conflicts: [{ field: 'transaction', material: true }],
      safeError: safeError(
        'finance-mutation-requires-ledger-entry',
        'Use an adjustment or reversal instead of changing transaction history.',
      ),
    });
  }

  if (operation.kind === 'adjustment') {
    const adjustments = canonicalFinanceAdjustments([
      ...state.adjustments,
      {
        operationId: operation.operationId,
        amountCadMinor: operation.amountCadMinor,
        reason: operation.reason,
      },
    ]);
    const adjustedAmount = checkedSafeIntegerSum(
      state.originalAmountCadMinor,
      adjustments.map((adjustment) => adjustment.amountCadMinor),
    );
    const nextState = FinanceStateSchema.parse({
      ...state,
      effectiveAmountCadMinor: undefined,
      amountConflict: adjustedAmount === undefined,
      adjustments,
      appliedOperationIds: [
        ...state.appliedOperationIds,
        operation.operationId,
      ],
    });
    if (adjustedAmount === undefined) {
      return conflictResult({
        status: 'needs-review',
        state: nextState,
        conflicts: [{ field: 'effectiveAmountCadMinor', material: true }],
        safeError: safeError(
          'finance-amount-overflow',
          'The adjustment exceeds the supported ledger amount range.',
        ),
      });
    }
    if (state.reversal !== null) {
      return conflictResult({
        status: 'ignored',
        state: nextState,
        safeError: safeError(
          'finance-reversal-dominates',
          'The reversal keeps this adjustment from changing the effective amount.',
        ),
      });
    }

    return conflictResult({
      status: 'applied',
      state: nextState,
    });
  }

  if (state.reversal !== null) {
    return conflictResult({
      status: 'needs-review',
      state,
      conflicts: [{ field: 'reversal', material: true }],
      safeError: safeError(
        'finance-reversal-conflict',
        'The transaction already has a different reversal.',
      ),
    });
  }

  const nextState = FinanceStateSchema.parse({
    ...state,
    effectiveAmountCadMinor: undefined,
    reversal: {
      operationId: operation.operationId,
      reason: operation.reason,
    },
    appliedOperationIds: [...state.appliedOperationIds, operation.operationId],
  });
  if (nextState.amountConflict) {
    return conflictResult({
      status: 'needs-review',
      state: nextState,
      conflicts: [{ field: 'effectiveAmountCadMinor', material: true }],
      safeError: safeError(
        'finance-amount-overflow',
        'The ledger amount remains outside the supported range.',
      ),
    });
  }
  return conflictResult({
    status: 'applied',
    state: nextState,
  });
}

const BudgetStateSchema = z
  .strictObject({
    id: OpaqueReferenceSchema,
    currency: z.literal('CAD'),
    allocationsCadMinor: z.record(
      IdentifierSchema,
      MoneyCadMinorSchema.nonnegative(),
    ),
  })
  .transform((state) =>
    deepFreeze({
      ...state,
      allocationsCadMinor: Object.fromEntries(
        Object.entries(state.allocationsCadMinor).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    }),
  );
const BudgetInputSchema = z.strictObject({
  base: BudgetStateSchema,
  local: BudgetStateSchema,
  remote: BudgetStateSchema,
});
export type BudgetState = DeepReadonly<z.output<typeof BudgetStateSchema>>;
export type BudgetConflictInput = DeepReadonly<
  z.input<typeof BudgetInputSchema>
>;

const optionalNumberEqual = (
  left: number | undefined,
  right: number | undefined,
): boolean => left === right;

export function mergeBudgetConflict(
  input: BudgetConflictInput,
): OfflineConflictResult<BudgetState>;
export function mergeBudgetConflict(
  input: unknown,
): OfflineConflictDecision<BudgetState>;
export function mergeBudgetConflict(
  input: unknown,
): OfflineConflictDecision<BudgetState> {
  const parsed = boundedSafeParse(BudgetInputSchema, input);
  if (!parsed.success) return invalidConflictInput();
  const { base, local, remote } = parsed.data;
  if (
    local.id !== base.id ||
    remote.id !== base.id ||
    local.currency !== base.currency ||
    remote.currency !== base.currency
  ) {
    return conflictResult({
      status: 'needs-review',
      state: base,
      conflicts: [{ field: 'budgetIdentity', material: true }],
      safeError: safeError(
        'budget-identity-conflict',
        'Budget versions do not identify the same CAD budget.',
      ),
    });
  }

  const categories = [
    ...new Set([
      ...Object.keys(base.allocationsCadMinor),
      ...Object.keys(local.allocationsCadMinor),
      ...Object.keys(remote.allocationsCadMinor),
    ]),
  ].sort();
  const merged: Record<string, number> = {};
  const conflicts: OfflineConflictDetail[] = [];

  for (const category of categories) {
    const baseValue = base.allocationsCadMinor[category];
    const localValue = local.allocationsCadMinor[category];
    const remoteValue = remote.allocationsCadMinor[category];
    let selected: number | undefined;

    if (optionalNumberEqual(localValue, remoteValue)) {
      selected = localValue;
    } else if (optionalNumberEqual(localValue, baseValue)) {
      selected = remoteValue;
    } else if (optionalNumberEqual(remoteValue, baseValue)) {
      selected = localValue;
    } else {
      selected = baseValue;
      conflicts.push({
        field: `allocationsCadMinor.${category}`,
        material: true,
        base: baseValue ?? null,
        local: localValue ?? null,
        remote: remoteValue ?? null,
      });
    }

    if (selected !== undefined) merged[category] = selected;
  }

  const state = BudgetStateSchema.parse({
    id: base.id,
    currency: 'CAD',
    allocationsCadMinor: merged,
  });
  return conflictResult({
    status: conflicts.length === 0 ? 'applied' : 'needs-review',
    state,
    conflicts,
    ...(conflicts.length === 0
      ? {}
      : {
          safeError: safeError(
            'budget-concurrent-edit-conflict',
            'Concurrent edits to the same budget category require review.',
          ),
        }),
  });
}

const ShoppingOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    operationId: UuidSchema,
    kind: z.literal('delta'),
    quantityMinorUnits: z
      .number()
      .int()
      .safe()
      .refine((value) => value !== 0, { message: 'A delta cannot be zero' }),
  }),
  z.strictObject({
    operationId: UuidSchema,
    kind: z.literal('tombstone'),
  }),
]);
type ShoppingOperation = z.infer<typeof ShoppingOperationSchema>;

const canonicalShoppingOperations = (
  operations: readonly ShoppingOperation[],
): ShoppingOperation[] =>
  [...operations].sort((left, right) =>
    left.operationId.localeCompare(right.operationId),
  );

const deriveShoppingLedger = (input: {
  readonly baseQuantityMinorUnits: number;
  readonly baseTombstoned: boolean;
  readonly operations: readonly ShoppingOperation[];
}) => {
  const operations = canonicalShoppingOperations(input.operations);
  const tombstoned =
    input.baseTombstoned ||
    operations.some((operation) => operation.kind === 'tombstone');
  const quantity = operations.reduce(
    (total, operation) =>
      operation.kind === 'delta'
        ? total + BigInt(operation.quantityMinorUnits)
        : total,
    BigInt(input.baseQuantityMinorUnits),
  );
  const quantityConflict =
    !tombstoned &&
    (quantity < 0n || quantity > BigInt(Number.MAX_SAFE_INTEGER));

  return {
    operations,
    tombstoned,
    quantityConflict,
    quantityMinorUnits: tombstoned
      ? 0
      : quantityConflict
        ? input.baseQuantityMinorUnits
        : Number(quantity),
  } as const;
};

const ShoppingStateSchema = z
  .strictObject({
    itemId: OpaqueReferenceSchema,
    quantityMinorUnits: z.number().int().safe().nonnegative(),
    tombstoned: z.boolean(),
    baseQuantityMinorUnits: z.number().int().safe().nonnegative().optional(),
    baseTombstoned: z.boolean().optional(),
    quantityConflict: z.boolean().default(false),
    appliedOperationIds: z.array(UuidSchema).max(100_000),
    appliedOperations: z
      .array(ShoppingOperationSchema)
      .max(100_000)
      .default([]),
  })
  .superRefine((state, context) => {
    if (
      state.appliedOperations.length > 0 &&
      (state.baseQuantityMinorUnits === undefined ||
        state.baseTombstoned === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['baseQuantityMinorUnits'],
        message: 'Operation ledgers require an immutable base quantity',
      });
      return;
    }
    if (
      new Set(state.appliedOperationIds).size !==
      state.appliedOperationIds.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['appliedOperationIds'],
        message: 'Applied operation IDs must be unique',
      });
    }
    const operationIds = state.appliedOperations.map(
      (operation) => operation.operationId,
    );
    if (
      new Set(operationIds).size !== operationIds.length ||
      operationIds.some((id) => !state.appliedOperationIds.includes(id)) ||
      operationIds.length !== state.appliedOperationIds.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['appliedOperations'],
        message: 'Applied operations must exactly match applied operation IDs',
      });
    }
    const derived = deriveShoppingLedger({
      baseQuantityMinorUnits:
        state.baseQuantityMinorUnits ?? state.quantityMinorUnits,
      baseTombstoned: state.baseTombstoned ?? state.tombstoned,
      operations: state.appliedOperations,
    });
    if (
      state.tombstoned !== derived.tombstoned ||
      state.quantityMinorUnits !== derived.quantityMinorUnits ||
      state.quantityConflict !== derived.quantityConflict
    ) {
      context.addIssue({
        code: 'custom',
        path: ['quantityMinorUnits'],
        message: 'Shopping quantity must match its immutable operation ledger',
      });
    }
  })
  .transform((state) => {
    const baseQuantityMinorUnits =
      state.baseQuantityMinorUnits ?? state.quantityMinorUnits;
    const baseTombstoned = state.baseTombstoned ?? state.tombstoned;
    const derived = deriveShoppingLedger({
      baseQuantityMinorUnits,
      baseTombstoned,
      operations: state.appliedOperations,
    });
    return deepFreeze({
      ...state,
      baseQuantityMinorUnits,
      baseTombstoned,
      quantityMinorUnits: derived.quantityMinorUnits,
      tombstoned: derived.tombstoned,
      quantityConflict: derived.quantityConflict,
      appliedOperationIds: [...state.appliedOperationIds].sort(),
      appliedOperations: derived.operations,
    });
  });
const ShoppingInputSchema = z.strictObject({
  state: ShoppingStateSchema,
  operation: ShoppingOperationSchema,
});
export type ShoppingQuantityState = DeepReadonly<
  z.output<typeof ShoppingStateSchema>
>;
export type ShoppingQuantityReducerInput = DeepReadonly<
  z.input<typeof ShoppingInputSchema>
>;

export function reduceShoppingQuantity(
  input: ShoppingQuantityReducerInput,
): OfflineConflictResult<ShoppingQuantityState>;
export function reduceShoppingQuantity(
  input: unknown,
): OfflineConflictDecision<ShoppingQuantityState>;
export function reduceShoppingQuantity(
  input: unknown,
): OfflineConflictDecision<ShoppingQuantityState> {
  const parsed = boundedSafeParse(ShoppingInputSchema, input);
  if (!parsed.success) return invalidConflictInput();
  const { state, operation } = parsed.data;
  if (state.appliedOperationIds.includes(operation.operationId)) {
    const existingOperation = state.appliedOperations.find(
      (item) => item.operationId === operation.operationId,
    );
    if (
      existingOperation !== undefined &&
      jsonEqual(existingOperation, operation)
    ) {
      return conflictResult({ status: 'duplicate', state });
    }
    return conflictResult({
      status: 'needs-review',
      state,
      conflicts: [{ field: 'operationId', material: true }],
      safeError: safeError(
        'shopping-idempotency-conflict',
        'The operation ID is already bound to another shopping mutation.',
      ),
    });
  }

  const appliedOperationIds = [
    ...state.appliedOperationIds,
    operation.operationId,
  ];
  const appliedOperations = [...state.appliedOperations, operation];
  const derived = deriveShoppingLedger({
    baseQuantityMinorUnits: state.baseQuantityMinorUnits,
    baseTombstoned: state.baseTombstoned,
    operations: appliedOperations,
  });
  const nextState = ShoppingStateSchema.parse({
    ...state,
    quantityMinorUnits: derived.quantityMinorUnits,
    tombstoned: derived.tombstoned,
    quantityConflict: derived.quantityConflict,
    appliedOperationIds,
    appliedOperations,
  });
  if (operation.kind === 'tombstone') {
    return conflictResult({
      status: 'applied',
      state: nextState,
    });
  }

  if (nextState.tombstoned) {
    return conflictResult({
      status: 'ignored',
      state: nextState,
      safeError: safeError(
        'shopping-item-tombstoned',
        'A quantity delta cannot revive a tombstoned item.',
      ),
    });
  }

  if (nextState.quantityConflict) {
    return conflictResult({
      status: 'needs-review',
      state: nextState,
      conflicts: [
        {
          field: 'quantityMinorUnits',
          material: true,
          base: state.baseQuantityMinorUnits,
          local: operation.quantityMinorUnits,
        },
      ],
      safeError: safeError(
        'shopping-negative-quantity-conflict',
        'The quantity delta cannot be applied safely.',
      ),
    });
  }

  return conflictResult({
    status: 'applied',
    state: nextState,
  });
}

const SchedulerItemBaseSchema = z.strictObject({
  id: OpaqueReferenceSchema,
  title: z.string().trim().min(1).max(500),
  notes: z.string().trim().max(10_000).nullable(),
  location: z.string().trim().max(1_000).nullable(),
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema,
  recurrence: z.string().trim().min(1).max(2_000).nullable(),
  attendees: z.array(OpaqueReferenceSchema).max(512),
  completion: z.enum(['open', 'completed', 'skipped']),
});
const SchedulerItemSchema = SchedulerItemBaseSchema.superRefine(
  (item, context) => {
    if (Date.parse(item.startsAt) >= Date.parse(item.endsAt)) {
      context.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'Scheduler item end must be after its start',
      });
    }
  },
).transform((item) =>
  deepFreeze({
    ...item,
    attendees: [...new Set(item.attendees)].sort(),
  }),
);
const SchedulerMergeInputSchema = z.strictObject({
  base: SchedulerItemSchema,
  local: SchedulerItemSchema,
  remote: SchedulerItemSchema,
});
export type SchedulerItemState = DeepReadonly<
  z.output<typeof SchedulerItemSchema>
>;
export type SchedulerConflictInput = DeepReadonly<
  z.input<typeof SchedulerMergeInputSchema>
>;

const mergeJsonField = (input: {
  readonly field: string;
  readonly material: boolean;
  readonly base: JsonValue;
  readonly local: JsonValue;
  readonly remote: JsonValue;
  readonly conflicts: OfflineConflictDetail[];
}): JsonValue => {
  if (jsonEqual(input.local, input.remote)) return input.local;
  if (jsonEqual(input.local, input.base)) return input.remote;
  if (jsonEqual(input.remote, input.base)) return input.local;
  input.conflicts.push({
    field: input.field,
    material: input.material,
    base: input.base,
    local: input.local,
    remote: input.remote,
  });
  return input.base;
};

export function mergeSchedulerConflict(
  input: SchedulerConflictInput,
): OfflineConflictResult<SchedulerItemState>;
export function mergeSchedulerConflict(
  input: unknown,
): OfflineConflictDecision<SchedulerItemState>;
export function mergeSchedulerConflict(
  input: unknown,
): OfflineConflictDecision<SchedulerItemState> {
  const parsed = boundedSafeParse(SchedulerMergeInputSchema, input);
  if (!parsed.success) return invalidConflictInput();
  const { base, local, remote } = parsed.data;
  if (local.id !== base.id || remote.id !== base.id) {
    return conflictResult({
      status: 'needs-review',
      state: base,
      conflicts: [
        {
          field: 'id',
          material: true,
          base: base.id,
          local: local.id,
          remote: remote.id,
        },
      ],
      safeError: safeError(
        'scheduler-identity-conflict',
        'Scheduler versions do not identify the same item.',
      ),
    });
  }

  const conflicts: OfflineConflictDetail[] = [];
  const time = mergeJsonField({
    field: 'time',
    material: true,
    base: { startsAt: base.startsAt, endsAt: base.endsAt },
    local: { startsAt: local.startsAt, endsAt: local.endsAt },
    remote: { startsAt: remote.startsAt, endsAt: remote.endsAt },
    conflicts,
  }) as { startsAt: string; endsAt: string };

  const state = SchedulerItemSchema.parse({
    id: base.id,
    title: mergeJsonField({
      field: 'title',
      material: false,
      base: base.title,
      local: local.title,
      remote: remote.title,
      conflicts,
    }),
    notes: mergeJsonField({
      field: 'notes',
      material: false,
      base: base.notes,
      local: local.notes,
      remote: remote.notes,
      conflicts,
    }),
    location: mergeJsonField({
      field: 'location',
      material: false,
      base: base.location,
      local: local.location,
      remote: remote.location,
      conflicts,
    }),
    startsAt: time.startsAt,
    endsAt: time.endsAt,
    recurrence: mergeJsonField({
      field: 'recurrence',
      material: true,
      base: base.recurrence,
      local: local.recurrence,
      remote: remote.recurrence,
      conflicts,
    }),
    attendees: mergeJsonField({
      field: 'attendees',
      material: true,
      base: [...base.attendees],
      local: [...local.attendees],
      remote: [...remote.attendees],
      conflicts,
    }),
    completion: mergeJsonField({
      field: 'completion',
      material: true,
      base: base.completion,
      local: local.completion,
      remote: remote.completion,
      conflicts,
    }),
  });

  return conflictResult({
    status: conflicts.length === 0 ? 'applied' : 'needs-review',
    state,
    conflicts,
    ...(conflicts.length === 0
      ? {}
      : {
          safeError: safeError(
            'scheduler-concurrent-edit-conflict',
            'Concurrent scheduler edits require review.',
          ),
        }),
  });
}

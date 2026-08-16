import {
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  deepFreeze,
  type DeepReadonly,
} from '@emdo/contracts';
import { z } from 'zod';

import { reduceFinanceTransaction } from '../shared/conflicts.js';
import {
  boundedFinanceParse,
  financeSafeError,
  type FinanceSafeError,
} from './guard.js';
import { NonnegativeCadMinorUnitsSchema } from './money.js';
import {
  validateFinanceRecord,
  type FinanceBudgetRecord,
  type FinanceTransactionRecord,
} from './records.js';

const NO_PROVIDER_WRITES = deepFreeze([]) as readonly never[];

const LedgerEnvelopeSchema = z.strictObject({
  transaction: z.unknown(),
  operation: z.unknown(),
  updatedAt: IsoDateTimeSchema,
});

export type FinanceLedgerApplicationResult = DeepReadonly<{
  status: 'applied' | 'duplicate' | 'ignored' | 'needs-review' | 'rejected';
  transaction: FinanceTransactionRecord | null;
  providerWrites: never[];
  safeError?:
    FinanceSafeError | { code: string; message: string; retryable: false };
}>;

const invalidLedgerInput = (): FinanceLedgerApplicationResult =>
  deepFreeze({
    status: 'rejected' as const,
    transaction: null,
    providerWrites: [],
    safeError: financeSafeError(
      'invalid-finance-ledger-input',
      'The finance ledger operation is invalid.',
    ),
  });

export const applyTransactionLedgerOperation = (
  input: unknown,
): FinanceLedgerApplicationResult => {
  const envelope = boundedFinanceParse(LedgerEnvelopeSchema, input);
  if (!envelope.success) return invalidLedgerInput();

  const validated = validateFinanceRecord(envelope.data.transaction);
  if (
    validated.status !== 'accepted' ||
    validated.record.recordType !== 'transaction' ||
    Date.parse(envelope.data.updatedAt) < Date.parse(validated.record.updatedAt)
  ) {
    return invalidLedgerInput();
  }

  const transaction = validated.record;
  const reduced = reduceFinanceTransaction({
    state: {
      id: transaction.id,
      currency: transaction.currency,
      originalAmountCadMinor: transaction.originalAmountCadMinor,
      effectiveAmountCadMinor: transaction.effectiveAmountCadMinor,
      adjustments: transaction.adjustments,
      reversal: transaction.reversal,
      appliedOperationIds: transaction.appliedOperationIds,
    },
    operation: envelope.data.operation,
  });
  if (reduced.state === null) return invalidLedgerInput();
  if (
    reduced.status === 'needs-review' &&
    reduced.safeError?.code === 'finance-amount-overflow'
  ) {
    return deepFreeze({
      status: 'needs-review' as const,
      transaction,
      providerWrites: NO_PROVIDER_WRITES,
      safeError: reduced.safeError,
    });
  }

  const ledgerChanged =
    reduced.state.appliedOperationIds.length !==
    transaction.appliedOperationIds.length;
  const nextRecord = validateFinanceRecord({
    ...transaction,
    updatedAt: ledgerChanged ? envelope.data.updatedAt : transaction.updatedAt,
    effectiveAmountCadMinor: reduced.state.effectiveAmountCadMinor,
    adjustments: reduced.state.adjustments,
    reversal: reduced.state.reversal,
    appliedOperationIds: reduced.state.appliedOperationIds,
  });
  if (
    nextRecord.status !== 'accepted' ||
    nextRecord.record.recordType !== 'transaction'
  ) {
    return invalidLedgerInput();
  }

  return deepFreeze({
    status: reduced.status,
    transaction: nextRecord.record,
    providerWrites: NO_PROVIDER_WRITES,
    ...(reduced.safeError === undefined
      ? {}
      : { safeError: reduced.safeError }),
  }) as FinanceLedgerApplicationResult;
};

const TotalsEnvelopeSchema = z.strictObject({
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
  timezone: z.literal('America/Toronto'),
  spaceId: OpaqueReferenceSchema,
  transactions: z.array(z.unknown()).max(100_000),
});

interface CategoryAccumulator {
  inflow: bigint;
  outflow: bigint;
}

const isSafeBigInt = (value: bigint): boolean =>
  value <= BigInt(Number.MAX_SAFE_INTEGER) &&
  value >= BigInt(Number.MIN_SAFE_INTEGER);

export type MonthlyCategoryTotalsResult =
  | DeepReadonly<{
      status: 'calculated';
      month: string;
      timezone: 'America/Toronto';
      currency: 'CAD';
      categoryTotals: {
        categoryId: string | null;
        inflowCadMinor: number;
        outflowCadMinor: number;
        netCadMinor: number;
      }[];
      totals: {
        inflowCadMinor: number;
        outflowCadMinor: number;
        netCadMinor: number;
      };
    }>
  | DeepReadonly<{ status: 'rejected'; safeError: FinanceSafeError }>;

const rejectedTotals = (
  code = 'invalid-finance-total-input',
  message = 'The finance totals could not be calculated safely.',
): MonthlyCategoryTotalsResult =>
  deepFreeze({
    status: 'rejected' as const,
    safeError: financeSafeError(code, message),
  });

export const calculateMonthlyCategoryTotals = (
  input: unknown,
): MonthlyCategoryTotalsResult => {
  const envelope = boundedFinanceParse(TotalsEnvelopeSchema, input);
  if (!envelope.success) return rejectedTotals();

  const transactions: FinanceTransactionRecord[] = [];
  for (const candidate of envelope.data.transactions) {
    const validated = validateFinanceRecord(candidate);
    if (
      validated.status !== 'accepted' ||
      validated.record.recordType !== 'transaction' ||
      validated.record.spaceId !== envelope.data.spaceId
    ) {
      return rejectedTotals();
    }
    transactions.push(validated.record);
  }

  const categoryAccumulators = new Map<string | null, CategoryAccumulator>();
  let totalInflow = 0n;
  let totalOutflow = 0n;
  for (const transaction of transactions) {
    if (!transaction.postedOn.startsWith(`${envelope.data.month}-`)) continue;
    const amount = BigInt(transaction.effectiveAmountCadMinor);
    const accumulator = categoryAccumulators.get(transaction.categoryId) ?? {
      inflow: 0n,
      outflow: 0n,
    };
    if (amount >= 0n) {
      accumulator.inflow += amount;
      totalInflow += amount;
    } else {
      const outflow = -amount;
      accumulator.outflow += outflow;
      totalOutflow += outflow;
    }
    categoryAccumulators.set(transaction.categoryId, accumulator);
  }

  const totalsToCheck = [totalInflow, totalOutflow, totalInflow - totalOutflow];
  for (const accumulator of categoryAccumulators.values()) {
    totalsToCheck.push(
      accumulator.inflow,
      accumulator.outflow,
      accumulator.inflow - accumulator.outflow,
    );
  }
  if (totalsToCheck.some((value) => !isSafeBigInt(value))) {
    return rejectedTotals(
      'finance-total-out-of-range',
      'The finance total is outside the supported range.',
    );
  }

  const categoryTotals = [...categoryAccumulators.entries()]
    .sort(([left], [right]) => {
      if (left === right) return 0;
      if (left === null) return -1;
      if (right === null) return 1;
      return left.localeCompare(right);
    })
    .map(([categoryId, accumulator]) => ({
      categoryId,
      inflowCadMinor: Number(accumulator.inflow),
      outflowCadMinor: Number(accumulator.outflow),
      netCadMinor: Number(accumulator.inflow - accumulator.outflow),
    }));

  return deepFreeze({
    status: 'calculated' as const,
    month: envelope.data.month,
    timezone: envelope.data.timezone,
    currency: 'CAD' as const,
    categoryTotals,
    totals: {
      inflowCadMinor: Number(totalInflow),
      outflowCadMinor: Number(totalOutflow),
      netCadMinor: Number(totalInflow - totalOutflow),
    },
  });
};

const BudgetChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('set'),
    categoryId: OpaqueReferenceSchema,
    amountCadMinor: NonnegativeCadMinorUnitsSchema,
  }),
  z.strictObject({
    kind: z.literal('remove'),
    categoryId: OpaqueReferenceSchema,
  }),
]);

const BudgetEditEnvelopeSchema = z.strictObject({
  budget: z.unknown(),
  expectedRevision: z.number().int().safe().nonnegative(),
  updatedAt: IsoDateTimeSchema,
  changes: z.array(BudgetChangeSchema).max(1_000),
});

export type BudgetEditResult =
  | DeepReadonly<{
      status: 'applied';
      budget: FinanceBudgetRecord;
      totalAllocatedCadMinor: number;
      providerWrites: never[];
    }>
  | DeepReadonly<{
      status: 'needs-review' | 'rejected';
      budget: FinanceBudgetRecord | null;
      providerWrites: never[];
      safeError: FinanceSafeError;
    }>;

const rejectedBudget = (): BudgetEditResult =>
  deepFreeze({
    status: 'rejected' as const,
    budget: null,
    providerWrites: [],
    safeError: financeSafeError(
      'invalid-finance-budget-input',
      'The budget edit is invalid.',
    ),
  });

export const editFinanceBudget = (input: unknown): BudgetEditResult => {
  const envelope = boundedFinanceParse(BudgetEditEnvelopeSchema, input);
  if (!envelope.success) return rejectedBudget();
  const validated = validateFinanceRecord(envelope.data.budget);
  if (
    validated.status !== 'accepted' ||
    validated.record.recordType !== 'budget' ||
    Date.parse(envelope.data.updatedAt) < Date.parse(validated.record.updatedAt)
  ) {
    return rejectedBudget();
  }
  const budget = validated.record;

  const changedCategories = envelope.data.changes.map(
    (change) => change.categoryId,
  );
  if (new Set(changedCategories).size !== changedCategories.length) {
    return rejectedBudget();
  }
  if (envelope.data.expectedRevision !== budget.revision) {
    return deepFreeze({
      status: 'needs-review' as const,
      budget,
      providerWrites: NO_PROVIDER_WRITES,
      safeError: financeSafeError(
        'finance-budget-revision-conflict',
        'The budget changed before this edit could be applied.',
      ),
    });
  }

  const allocations = new Map(
    budget.allocations.map((allocation) => [
      allocation.categoryId,
      allocation.amountCadMinor,
    ]),
  );
  for (const change of envelope.data.changes) {
    if (change.kind === 'remove') allocations.delete(change.categoryId);
    else allocations.set(change.categoryId, change.amountCadMinor);
  }
  const total = [...allocations.values()].reduce(
    (running, value) => running + BigInt(value),
    0n,
  );
  if (!isSafeBigInt(total)) {
    return deepFreeze({
      status: 'rejected' as const,
      budget,
      providerWrites: NO_PROVIDER_WRITES,
      safeError: financeSafeError(
        'finance-budget-total-out-of-range',
        'The budget total is outside the supported range.',
      ),
    });
  }

  const next = validateFinanceRecord({
    ...budget,
    updatedAt: envelope.data.updatedAt,
    revision: budget.revision + 1,
    allocations: [...allocations.entries()].map(
      ([categoryId, amountCadMinor]) => ({ categoryId, amountCadMinor }),
    ),
  });
  if (next.status !== 'accepted' || next.record.recordType !== 'budget') {
    return rejectedBudget();
  }
  return deepFreeze({
    status: 'applied' as const,
    budget: next.record,
    totalAllocatedCadMinor: Number(total),
    providerWrites: NO_PROVIDER_WRITES,
  });
};

import {
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  SchemaVersionSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly,
} from '@emdo/contracts';
import { z } from 'zod';

import {
  boundedFinanceParse,
  financeSafeError,
  type FinanceSafeError,
} from './guard.js';
import {
  CadMinorUnitsSchema,
  NonnegativeCadMinorUnitsSchema,
} from './money.js';

const DateOnlySchema = z.iso.date();
const MonthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/);
const RecordNameSchema = z.string().trim().min(1).max(200);
const DescriptionSchema = z.string().trim().min(1).max(2_000);

const BaseRecordFields = {
  schemaVersion: SchemaVersionSchema,
  id: OpaqueReferenceSchema,
  spaceId: OpaqueReferenceSchema,
  ownerUserId: OpaqueReferenceSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
} as const;

const AccountRecordSchema = z.strictObject({
  ...BaseRecordFields,
  recordType: z.literal('account'),
  name: RecordNameSchema,
  accountKind: z.enum(['cash', 'chequing', 'savings', 'credit', 'other']),
  currency: z.literal('CAD'),
  openingBalanceCadMinor: CadMinorUnitsSchema,
  active: z.boolean(),
  source: z.literal('manual'),
});

const CategoryRecordSchema = z.strictObject({
  ...BaseRecordFields,
  recordType: z.literal('category'),
  name: RecordNameSchema,
  categoryKind: z.enum(['income', 'expense']),
  parentCategoryId: OpaqueReferenceSchema.nullable(),
  active: z.boolean(),
});

const FinanceAdjustmentSchema = z.strictObject({
  operationId: UuidSchema,
  amountCadMinor: CadMinorUnitsSchema.refine((value) => value !== 0),
  reason: z.string().trim().min(3).max(1_000),
});

const FinanceReversalSchema = z.strictObject({
  operationId: UuidSchema,
  reason: z.string().trim().min(3).max(1_000),
});

export const FinanceTransactionSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({
    kind: z.literal('import'),
    sourceHash: Sha256Schema,
    sourceRow: z.number().int().positive().max(100_000),
    fingerprint: Sha256Schema,
    externalId: z.string().trim().min(1).max(512).nullable(),
  }),
]);

const TransactionRecordSchema = z.strictObject({
  ...BaseRecordFields,
  recordType: z.literal('transaction'),
  accountId: OpaqueReferenceSchema,
  categoryId: OpaqueReferenceSchema.nullable(),
  postedOn: DateOnlySchema,
  description: DescriptionSchema,
  currency: z.literal('CAD'),
  originalAmountCadMinor: CadMinorUnitsSchema,
  effectiveAmountCadMinor: CadMinorUnitsSchema,
  adjustments: z.array(FinanceAdjustmentSchema).max(10_000),
  reversal: FinanceReversalSchema.nullable(),
  appliedOperationIds: z.array(UuidSchema).max(10_001),
  source: FinanceTransactionSourceSchema,
});

export const BudgetAllocationSchema = z.strictObject({
  categoryId: OpaqueReferenceSchema,
  amountCadMinor: NonnegativeCadMinorUnitsSchema,
});

const BudgetRecordSchema = z.strictObject({
  ...BaseRecordFields,
  recordType: z.literal('budget'),
  month: MonthSchema,
  currency: z.literal('CAD'),
  allocations: z.array(BudgetAllocationSchema).max(1_000),
  revision: z.number().int().safe().nonnegative(),
});

const BillRecordSchema = z.strictObject({
  ...BaseRecordFields,
  recordType: z.literal('bill'),
  name: RecordNameSchema,
  dueOn: DateOnlySchema,
  expectedAmountCadMinor: NonnegativeCadMinorUnitsSchema,
  currency: z.literal('CAD'),
  status: z.enum(['planned', 'paid', 'skipped']),
});

const SubscriptionRecordSchema = z.strictObject({
  ...BaseRecordFields,
  recordType: z.literal('subscription'),
  name: RecordNameSchema,
  nextDueOn: DateOnlySchema,
  expectedAmountCadMinor: NonnegativeCadMinorUnitsSchema,
  currency: z.literal('CAD'),
  cadence: z.enum(['weekly', 'monthly', 'quarterly', 'yearly', 'other']),
  active: z.boolean(),
});

const GoalRecordSchema = z.strictObject({
  ...BaseRecordFields,
  recordType: z.literal('goal'),
  name: RecordNameSchema,
  targetAmountCadMinor: NonnegativeCadMinorUnitsSchema.positive(),
  currentAmountCadMinor: NonnegativeCadMinorUnitsSchema,
  currency: z.literal('CAD'),
  targetOn: DateOnlySchema.nullable(),
  status: z.enum(['active', 'achieved', 'paused']),
});

const FinanceRecordBaseSchema = z.discriminatedUnion('recordType', [
  AccountRecordSchema,
  TransactionRecordSchema,
  CategoryRecordSchema,
  BudgetRecordSchema,
  BillRecordSchema,
  SubscriptionRecordSchema,
  GoalRecordSchema,
]);

const checkedLedgerAmount = (input: {
  readonly originalAmountCadMinor: number;
  readonly adjustments: readonly { readonly amountCadMinor: number }[];
  readonly reversal: unknown;
}): number | undefined => {
  if (input.reversal !== null) return 0;
  let total = BigInt(input.originalAmountCadMinor);
  for (const adjustment of input.adjustments) {
    total += BigInt(adjustment.amountCadMinor);
  }
  return total <= BigInt(Number.MAX_SAFE_INTEGER) &&
    total >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(total)
    : undefined;
};

export const FinanceRecordSchema = FinanceRecordBaseSchema.superRefine(
  (record, context) => {
    const createdAt = Date.parse(record.createdAt);
    const updatedAt = Date.parse(record.updatedAt);
    if (!Number.isFinite(createdAt) || updatedAt < createdAt) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'updatedAt must not precede createdAt',
      });
    }

    if (record.recordType === 'transaction') {
      const ledgerIds = [
        ...record.adjustments.map((entry) => entry.operationId),
        ...(record.reversal === null ? [] : [record.reversal.operationId]),
      ];
      const ledgerIdSet = new Set(ledgerIds);
      const appliedOperationIdSet = new Set(record.appliedOperationIds);
      if (
        ledgerIds.length !== ledgerIdSet.size ||
        record.appliedOperationIds.length !== ledgerIds.length ||
        appliedOperationIdSet.size !== record.appliedOperationIds.length ||
        ledgerIds.some((id) => !appliedOperationIdSet.has(id))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['appliedOperationIds'],
          message: 'Applied IDs must exactly identify the immutable ledger',
        });
      }

      const expectedAmount = checkedLedgerAmount(record);
      if (
        expectedAmount === undefined ||
        expectedAmount !== record.effectiveAmountCadMinor
      ) {
        context.addIssue({
          code: 'custom',
          path: ['effectiveAmountCadMinor'],
          message: 'Effective amount must match the immutable ledger',
        });
      }
    }

    if (record.recordType === 'budget') {
      const categories = record.allocations.map((item) => item.categoryId);
      if (new Set(categories).size !== categories.length) {
        context.addIssue({
          code: 'custom',
          path: ['allocations'],
          message: 'Budget categories must be unique',
        });
      }
    }
  },
).transform((record) => {
  if (record.recordType === 'budget') {
    return deepFreeze({
      ...record,
      allocations: [...record.allocations].sort((left, right) =>
        left.categoryId.localeCompare(right.categoryId),
      ),
    });
  }
  if (record.recordType === 'transaction') {
    return deepFreeze({
      ...record,
      adjustments: [...record.adjustments].sort((left, right) =>
        left.operationId.localeCompare(right.operationId),
      ),
      appliedOperationIds: [...record.appliedOperationIds].sort(),
    });
  }
  return deepFreeze({ ...record });
});

export type FinanceRecord = DeepReadonly<z.output<typeof FinanceRecordSchema>>;
export type FinanceTransactionRecord = Extract<
  FinanceRecord,
  { readonly recordType: 'transaction' }
>;
export type FinanceBudgetRecord = Extract<
  FinanceRecord,
  { readonly recordType: 'budget' }
>;

export type FinanceRecordValidationResult =
  | DeepReadonly<{ status: 'accepted'; record: FinanceRecord }>
  | DeepReadonly<{ status: 'rejected'; safeError: FinanceSafeError }>;

export const validateFinanceRecord = (
  input: unknown,
): FinanceRecordValidationResult => {
  const parsed = boundedFinanceParse(FinanceRecordSchema, input);
  if (!parsed.success) {
    return deepFreeze({
      status: 'rejected' as const,
      safeError: financeSafeError(
        'invalid-finance-record',
        'The finance record is invalid.',
      ),
    });
  }
  return deepFreeze({ status: 'accepted' as const, record: parsed.data });
};

export const validateFinanceRecordCreate = (
  input: unknown,
): FinanceRecordValidationResult => {
  const validated = validateFinanceRecord(input);
  if (validated.status === 'rejected') return validated;

  const record = validated.record;
  if (
    record.recordType === 'transaction' &&
    (record.source.kind !== 'manual' ||
      record.adjustments.length !== 0 ||
      record.reversal !== null ||
      record.appliedOperationIds.length !== 0)
  ) {
    return deepFreeze({
      status: 'rejected' as const,
      safeError: financeSafeError(
        'invalid-finance-record-create',
        'Imported or ledger-modified transactions require their dedicated operation.',
      ),
    });
  }

  return validated;
};

const ALLOWED_FINANCE_OPERATIONS = new Set([
  'finance.record.read',
  'finance.account.create',
  'finance.category.create',
  'finance.budget.create',
  'finance.bill.create',
  'finance.subscription.create',
  'finance.goal.create',
  'finance.transaction.create-manual',
  'finance.account.update',
  'finance.category.update',
  'finance.budget.edit',
  'finance.bill.update',
  'finance.subscription.update',
  'finance.goal.update',
  'finance.transaction.adjust',
  'finance.transaction.reverse',
  'finance.statement.import',
  'finance.budget.calculate',
  'finance.categorization.suggest',
  'finance.explain',
]);

export const FINANCE_FORBIDDEN_OPERATION_FAMILIES = deepFreeze([
  'banking-credentials',
  'account-aggregation',
  'payments',
  'transfers',
  'investing',
  'tax-filing',
  'credit-decisions',
] as const);

export type FinanceOperationDecision =
  | DeepReadonly<{ decision: 'allowed' }>
  | DeepReadonly<{ decision: 'forbidden'; safeError: FinanceSafeError }>;

export const evaluateFinanceOperation = (
  operationId: unknown,
): FinanceOperationDecision => {
  if (
    typeof operationId === 'string' &&
    ALLOWED_FINANCE_OPERATIONS.has(operationId)
  ) {
    return deepFreeze({ decision: 'allowed' as const });
  }
  return deepFreeze({
    decision: 'forbidden' as const,
    safeError: financeSafeError(
      'finance-operation-forbidden',
      'This finance operation is unavailable.',
    ),
  });
};

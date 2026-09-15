import { z } from 'zod';
import { UuidSchema } from './primitives.js';
import {
  FinanceCurrencySchema,
  FinanceDecimalSchema,
  FinanceMoneySchema,
} from './finance-v2.js';
import {
  FinanceStockSplitActionSchema,
  PlanInvestmentStockSplitSchema,
} from './finance-corporate-actions.js';

/** Exact nonnegative share quantity. Outputs are reduced; input need not be. */
export const FinanceCorporateActionRationalQuantitySchema = z.strictObject({
  numerator: z
    .string()
    .regex(/^(?:0|[1-9]\d*)$/)
    .max(120),
  denominator: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(120),
});
const NonnegativeCost = FinanceDecimalSchema.refine(
  (value) => !value.startsWith('-'),
  'Must be nonnegative',
);
const PositiveMoney = FinanceMoneySchema.refine(
  (value) =>
    !value.amount.startsWith('-') && !/^0(?:\.0+)?$/.test(value.amount),
  'Must be positive',
);

export const FinanceStockSplitSettlementAllocationSchema = z.strictObject({
  sourceLotId: UuidSchema,
  retainedQuantity: FinanceCorporateActionRationalQuantitySchema,
  cashDisposedQuantity: FinanceCorporateActionRationalQuantitySchema,
  retainedNativeCost: NonnegativeCost,
  retainedFunctionalCost: NonnegativeCost,
  disposedNativeCost: NonnegativeCost,
  disposedFunctionalCost: NonnegativeCost,
});

export const FinanceStockSplitCashConsiderationSchema = z.strictObject({
  native: PositiveMoney,
  functional: PositiveMoney,
  evidenceId: UuidSchema,
  sourceReference: z.string().trim().min(1).max(500),
  settledOn: z.iso.date(),
  fx: z
    .strictObject({
      rate: FinanceDecimalSchema.refine(
        (value) => !value.startsWith('-') && !/^0(?:\.0+)?$/.test(value),
        'Must be positive',
      ),
      source: z.string().trim().min(1).max(200),
    })
    .nullable(),
});

/** Reviewed book allocations, not an automatic tax-basis method or posting command. */
export const PlanInvestmentStockSplitSettlementSchema = z.strictObject({
  source: PlanInvestmentStockSplitSchema,
  deliveredQuantity: FinanceCorporateActionRationalQuantitySchema,
  cashDisposedQuantity: FinanceCorporateActionRationalQuantitySchema,
  allocations: z
    .array(FinanceStockSplitSettlementAllocationSchema)
    .min(1)
    .max(10000),
  cashConsideration: FinanceStockSplitCashConsiderationSchema,
  allocationReview: z.strictObject({
    evidenceId: UuidSchema,
    sourceReference: z.string().trim().min(1).max(500),
  }),
});

export const FinanceStockSplitSettlementPlanSchema = z.strictObject({
  calculationVersion: z.literal('investment-corporate-action-settlement.v1'),
  actionId: UuidSchema,
  financialAccountId: UuidSchema,
  instrumentId: UuidSchema,
  effectiveOn: z.iso.date(),
  settledOn: z.iso.date(),
  accountEntitlement: FinanceCorporateActionRationalQuantitySchema,
  deliveredQuantity: FinanceCorporateActionRationalQuantitySchema,
  cashDisposedQuantity: FinanceCorporateActionRationalQuantitySchema,
  nativeCurrency: FinanceCurrencySchema,
  functionalCurrency: FinanceCurrencySchema,
  sourceNativeCost: NonnegativeCost,
  sourceFunctionalCost: NonnegativeCost,
  retainedNativeCost: NonnegativeCost,
  retainedFunctionalCost: NonnegativeCost,
  disposedNativeCost: NonnegativeCost,
  disposedFunctionalCost: NonnegativeCost,
  nativeBookGainLoss: FinanceDecimalSchema,
  functionalBookGainLoss: FinanceDecimalSchema,
  allocations: z
    .array(FinanceStockSplitSettlementAllocationSchema)
    .min(1)
    .max(10000),
  cashConsideration: FinanceStockSplitCashConsiderationSchema,
  allocationReview: z.strictObject({
    evidenceId: UuidSchema,
    sourceReference: z.string().trim().min(1).max(500),
  }),
  status: z.literal('validated-plan'),
  persistence: z.literal('not-implemented'),
  taxTreatment: z.literal('not-assessed'),
});

export type PlanInvestmentStockSplitSettlement = z.infer<
  typeof PlanInvestmentStockSplitSettlementSchema
>;
/** The server loads source lots; callers may only bind their reviewed snapshot. */
export const PreviewInvestmentStockSplitSettlementSchema =
  PlanInvestmentStockSplitSettlementSchema.omit({ source: true }).extend({
    action: FinanceStockSplitActionSchema,
    expectedSourceRevision: z.number().int().nonnegative().safe(),
    sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  });

export const PreviewInvestmentStockSplitSettlementResultSchema = z.strictObject(
  {
    sourceRevision: z.number().int().nonnegative().safe(),
    sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    plan: FinanceStockSplitSettlementPlanSchema,
  },
);

export const FinanceStockSplitSettlementLedgerSchema = z.strictObject({
  cashLedgerAccountId: UuidSchema,
  investmentLedgerAccountId: UuidSchema,
  gainLedgerAccountId: UuidSchema,
  lossLedgerAccountId: UuidSchema,
  receivableLedgerAccountId: UuidSchema.nullable(),
  fxGainLedgerAccountId: UuidSchema.nullable(),
  fxLossLedgerAccountId: UuidSchema.nullable(),
});

export const FinanceStockSplitActionDateConsiderationSchema =
  FinanceStockSplitCashConsiderationSchema.omit({ settledOn: true });

export const CommitInvestmentStockSplitSettlementSchema = z.strictObject({
  settlement: PlanInvestmentStockSplitSettlementSchema,
  ledger: FinanceStockSplitSettlementLedgerSchema,
  actionDateConsideration:
    FinanceStockSplitActionDateConsiderationSchema.nullable(),
  expectedSourceRevision: z.number().int().nonnegative().safe(),
  sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  receipt: z.strictObject({
    sourceRowId: UuidSchema,
    expectedRevision: z.number().int().positive().safe(),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  evidenceHashes: z
    .array(
      z.strictObject({
        evidenceId: UuidSchema,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1)
    .max(4),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export const FinanceStockSplitSettlementCommitResultSchema = z.strictObject({
  actionId: UuidSchema,
  workspaceId: UuidSchema,
  bookId: UuidSchema,
  sourceRevision: z.number().int().nonnegative().safe(),
  nextSourceRevision: z.number().int().positive().safe(),
  sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  successorLotIds: z.array(UuidSchema).max(10000),
  effectCount: z.number().int().nonnegative().max(10000),
  settlementId: UuidSchema,
  economicTransactionId: UuidSchema,
  journalIds: z.array(UuidSchema).min(1).max(2),
  status: z.literal('committed'),
  replayed: z.boolean(),
});

export type CommitInvestmentStockSplitSettlement = z.infer<
  typeof CommitInvestmentStockSplitSettlementSchema
>;

export const FinanceStockSplitSettlementAccountingSummarySchema = z.object({
  actionDateFunctionalConsideration: FinanceDecimalSchema,
  settlementDateFunctionalConsideration: FinanceDecimalSchema,
  bookGainLoss: FinanceDecimalSchema,
  fxGainLoss: FinanceDecimalSchema,
});

export const SavedFinanceStockSplitSettlementSchema = z.strictObject({
  result: FinanceStockSplitSettlementCommitResultSchema,
  settlement: FinanceStockSplitSettlementPlanSchema,
  accounting: FinanceStockSplitSettlementAccountingSummarySchema,
  createdAt: z.iso.datetime(),
});
export type FinanceStockSplitSettlementPlan = z.infer<
  typeof FinanceStockSplitSettlementPlanSchema
>;

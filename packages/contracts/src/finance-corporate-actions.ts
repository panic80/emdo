import { z } from 'zod';
import { UuidSchema } from './primitives.js';
import {
  FinanceCurrencySchema,
  FinanceDecimalSchema,
  FinanceMoneySchema,
} from './finance-v2.js';
import { InvestmentLotStateSchema } from './finance-lots.js';

const PositiveDecimal = FinanceDecimalSchema.refine(
  (value) => !value.startsWith('-') && !/^0(?:\.0+)?$/.test(value),
  'Must be positive',
);

/**
 * A stock split action is a mechanical quantity transformation. It does not
 * assert a tax treatment or authorize a ledger posting.
 */
export const FinanceStockSplitActionSchema = z.strictObject({
  id: UuidSchema,
  actionType: z.enum(['split', 'reverse-split']),
  financialAccountId: UuidSchema,
  instrumentId: UuidSchema,
  effectiveOn: z.iso.date(),
  numerator: PositiveDecimal,
  denominator: PositiveDecimal,
  /** Unknown is fail-closed; retain is an explicit broker-supported policy. */
  fractionalTreatment: z
    .enum(['unknown', 'retain', 'cash-in-lieu'])
    .default('unknown'),
  evidenceId: UuidSchema,
  sourceReference: z.string().trim().min(1).max(500),
  cashInLieu: z
    .strictObject({
      consideration: FinanceMoneySchema,
      evidenceId: UuidSchema,
      sourceReference: z.string().trim().min(1).max(500),
    })
    .nullable()
    .default(null),
});

export const PlanInvestmentStockSplitSchema = z.strictObject({
  action: FinanceStockSplitActionSchema,
  /** The source lot state must be an explicit snapshot on the action date. */
  sourceAsOf: z.iso.date(),
  /** Persistence must prove this lineage before any future commit workflow. */
  sourceBoundary: z.literal('immediately-before-action'),
  sourceLots: z.array(InvestmentLotStateSchema).min(1).max(10000),
});

/** A reviewed commit must name the source revision observed by the planner. */
export const CommitInvestmentStockSplitSchema =
  PlanInvestmentStockSplitSchema.extend({
    expectedSourceRevision: z.number().int().nonnegative().safe(),
    idempotencyKey: z.string().trim().min(1).max(200),
  });

/**
 * The whole quantity is the representable twelve-decimal quantity. The
 * numerator/denominator pair is the exact fractional share remainder; it is
 * independent of the storage scale and never silently discarded.
 */
export const FinanceStockSplitFractionalEntitlementSchema = z.strictObject({
  /** Quantity representable at the system's twelve-decimal storage scale. */
  wholeQuantity: FinanceDecimalSchema,
  /** The exact whole-share portion is exposed separately for review. */
  wholeShareQuantity: FinanceDecimalSchema,
  remainderNumerator: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(120),
  remainderDenominator: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(120),
  fractionalUnit: z.literal('share'),
  representable: z.boolean(),
  scale: z.literal('1000000000000'),
});

export const FinanceStockSplitSuccessorLotSchema = z.strictObject({
  successorLotKey: z.string().trim().min(1).max(300),
  sourceLotId: UuidSchema,
  financialAccountId: UuidSchema,
  instrumentId: UuidSchema,
  acquiredOn: z.iso.date(),
  acquisitionSequence: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  originalQuantity: PositiveDecimal,
  disposedQuantity: z.literal('0'),
  originalNativeCost: z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
    .max(40),
  allocatedNativeCost: z.literal('0'),
  originalFunctionalCost: z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
    .max(40),
  allocatedFunctionalCost: z.literal('0'),
  nativeCurrency: FinanceCurrencySchema,
  functionalCurrency: FinanceCurrencySchema,
  sourceReference: z.string().trim().min(1).max(500),
});

export const FinanceStockSplitLotEffectSchema = z.strictObject({
  actionId: UuidSchema,
  evidenceId: UuidSchema,
  financialAccountId: UuidSchema,
  instrumentId: UuidSchema,
  sourceLotId: UuidSchema,
  acquiredOn: z.iso.date(),
  acquisitionSequence: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  sourceOriginalQuantity: FinanceDecimalSchema,
  sourceDisposedQuantity: FinanceDecimalSchema,
  sourceRemainingQuantity: FinanceDecimalSchema,
  sourceNativeCostBasis: FinanceDecimalSchema,
  sourceFunctionalCostBasis: FinanceDecimalSchema,
  successorQuantity: FinanceDecimalSchema.nullable(),
  successorNativeCostBasis: FinanceDecimalSchema,
  successorFunctionalCostBasis: FinanceDecimalSchema,
  fractionalEntitlement:
    FinanceStockSplitFractionalEntitlementSchema.nullable(),
  successorLot: FinanceStockSplitSuccessorLotSchema.nullable(),
});

export const FinanceStockSplitPlanSchema = z.strictObject({
  calculationVersion: z.literal('investment-corporate-actions.v1'),
  /** Exact account aggregate; per-lot fractions are not cash settlement instructions. */
  accountEntitlement: z
    .strictObject({
      numerator: z
        .string()
        .regex(/^(?:0|[1-9]\d*)$/)
        .max(120),
      denominator: z
        .string()
        .regex(/^[1-9]\d*$/)
        .max(120),
      wholeShares: z
        .string()
        .regex(/^(?:0|[1-9]\d*)$/)
        .max(120),
      remainderNumerator: z
        .string()
        .regex(/^(?:0|[1-9]\d*)$/)
        .max(120),
      remainderDenominator: z
        .string()
        .regex(/^[1-9]\d*$/)
        .max(120),
      decimalQuantity: FinanceDecimalSchema.nullable(),
    })
    .optional(),
  action: FinanceStockSplitActionSchema,
  sourceAsOf: z.iso.date(),
  sourceBoundary: z.literal('immediately-before-action'),
  commitReadiness: z.enum(['ready', 'blocked']),
  blockedReasons: z.array(
    z.enum([
      'fractional-entitlement-review-required',
      'fractional-quantity-not-representable',
      'fractional-policy-required',
      'cash-in-lieu-consideration-missing',
      'cash-in-lieu-basis-treatment-unsupported',
    ]),
  ),
  sourceLotCount: z.number().int().nonnegative(),
  successorLotCount: z.number().int().nonnegative(),
  sourceRemainingNativeCost: FinanceDecimalSchema,
  sourceRemainingFunctionalCost: FinanceDecimalSchema,
  successorNativeCostBasis: FinanceDecimalSchema,
  successorFunctionalCostBasis: FinanceDecimalSchema,
  effects: z.array(FinanceStockSplitLotEffectSchema).max(10000),
  persistence: z.literal('not-implemented'),
});

export const FinanceStockSplitCommitResultSchema = z.strictObject({
  actionId: UuidSchema,
  workspaceId: UuidSchema,
  bookId: UuidSchema,
  sourceRevision: z.number().int().nonnegative().safe(),
  nextSourceRevision: z.number().int().positive().safe(),
  sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  successorLotIds: z.array(UuidSchema).max(10000),
  effectCount: z.number().int().nonnegative().max(10000),
  status: z.literal('committed'),
  replayed: z.boolean(),
});

export type FinanceStockSplitAction = z.infer<
  typeof FinanceStockSplitActionSchema
>;
export type PlanInvestmentStockSplit = z.infer<
  typeof PlanInvestmentStockSplitSchema
>;
export type CommitInvestmentStockSplit = z.infer<
  typeof CommitInvestmentStockSplitSchema
>;
export type FinanceStockSplitPlan = z.infer<typeof FinanceStockSplitPlanSchema>;
export type FinanceStockSplitCommitResult = z.infer<
  typeof FinanceStockSplitCommitResultSchema
>;

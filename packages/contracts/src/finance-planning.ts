import { z } from 'zod';

import {
  FinanceCurrencySchema,
  FinanceDecimalSchema,
  FinanceMoneySchema,
} from './finance-v2.js';
import {
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  UuidSchema,
} from './primitives.js';

/**
 * Contracts for normalized book planning. These records deliberately carry
 * the book and workspace scope so a caller cannot accidentally combine a
 * household budget with another legal entity's ledger.
 */

export const FinancePlanningRevisionSchema = z
  .number()
  .int()
  .safe()
  .positive()
  .max(2_147_483_646);
/** A zero revision is the compare-and-swap value for a new logical record. */
export const FinancePlanningExpectedRevisionSchema = z
  .number()
  .int()
  .safe()
  .nonnegative()
  .max(2_147_483_646);

export const FINANCE_PLANNING_SCHEMA_VERSION = 1 as const;
export const FINANCE_PLANNING_CAPABILITY_VERSION = 1 as const;
export const FinancePlanningCapabilitySchema = z.enum([
  'finance.planning.budget-vs-actuals',
  'finance.planning.forecast',
]);
export const FinancePlanningAutomationIntentSchema = z.strictObject({
  schemaVersion: z.literal(FINANCE_PLANNING_CAPABILITY_VERSION),
  capability: FinancePlanningCapabilitySchema,
  budgetId: UuidSchema,
  budgetRevision: FinancePlanningRevisionSchema,
  asOf: z.iso.date().nullable(),
  currency: FinanceCurrencySchema,
  itemCount: z.number().int().positive().safe(),
});

export const FinancePlanningSignBasisSchema = z.enum([
  'debit-minus-credit',
  'credit-minus-debit',
]);

export const FinancePlanningLabelSchema = z.enum([
  'opening-balance-unavailable',
  'future-assumption-unavailable',
]);

const financeMoneyFields = {
  currency: FinanceCurrencySchema,
  amount: FinanceDecimalSchema,
} as const;

const validateMoneyPrecision = (
  value: {
    readonly currency: z.infer<typeof FinanceCurrencySchema>;
    readonly amount: string;
  },
  context: z.RefinementCtx,
) => {
  if (
    !FinanceMoneySchema.safeParse({
      currency: value.currency,
      amount: value.amount,
    }).success
  ) {
    context.addIssue({
      code: 'custom',
      path: ['amount'],
      message: 'Amount exceeds the currency precision',
    });
  }
};

export const FinanceBudgetLineSchema = z
  .strictObject({
    periodId: UuidSchema,
    accountId: UuidSchema,
    ...financeMoneyFields,
  })
  .superRefine(validateMoneyPrecision);

export const SaveFinanceBudgetSchema = z
  .strictObject({
    budgetId: UuidSchema.optional(),
    expectedRevision: FinancePlanningExpectedRevisionSchema.optional(),
    name: z.string().trim().min(1).max(200),
    lines: z.array(FinanceBudgetLineSchema).min(1).max(10_000),
  })
  .superRefine((value, context) => {
    const identities = value.lines.map(
      (line) => `${line.periodId}:${line.accountId}:${line.currency}`,
    );
    if (new Set(identities).size !== identities.length) {
      context.addIssue({
        code: 'custom',
        path: ['lines'],
        message: 'Budget line identities must be unique',
      });
    }
  });

export const FinanceBudgetLineRecordSchema = FinanceBudgetLineSchema.extend({
  budgetId: UuidSchema,
  revision: FinancePlanningRevisionSchema,
});

export const FinanceBudgetRevisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: UuidSchema,
  bookId: UuidSchema,
  budgetId: UuidSchema,
  revision: FinancePlanningRevisionSchema,
  name: z.string().trim().min(1).max(200),
  functionalCurrency: FinanceCurrencySchema,
  createdBy: UuidSchema,
  createdAt: IsoDateTimeSchema,
  lines: z.array(FinanceBudgetLineRecordSchema).min(1).max(10_000),
});

export const FinanceBudgetSummarySchema = FinanceBudgetRevisionSchema.omit({
  lines: true,
});

export const FinanceBudgetListSchema = z.strictObject({
  budgets: z.array(FinanceBudgetSummarySchema).max(100),
  nextOffset: z.number().int().nonnegative().nullable(),
});

/** One aggregate from the authoritative posted journal lines. */
export const FinancePostedLedgerAggregateSchema = z.strictObject({
  periodId: UuidSchema,
  accountId: UuidSchema,
  currency: FinanceCurrencySchema,
  accountKind: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
  debitAmount: FinanceDecimalSchema,
  creditAmount: FinanceDecimalSchema,
  journalCount: z.number().int().nonnegative().safe(),
  lineCount: z.number().int().nonnegative().safe(),
});

export const FinanceBudgetActualRowSchema = z.strictObject({
  periodId: UuidSchema,
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  accountId: UuidSchema,
  accountKind: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
  currency: FinanceCurrencySchema,
  budgetAmount: FinanceDecimalSchema,
  postedActualAmount: FinanceDecimalSchema,
  varianceAmount: FinanceDecimalSchema,
  actualSignBasis: FinancePlanningSignBasisSchema,
  sourceJournalCount: z.number().int().nonnegative().safe(),
  sourceLineCount: z.number().int().nonnegative().safe(),
});

export const FinanceBudgetVsActualsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: UuidSchema,
  bookId: UuidSchema,
  budgetId: UuidSchema,
  budgetRevision: FinancePlanningRevisionSchema,
  functionalCurrency: FinanceCurrencySchema,
  snapshotAt: IsoDateTimeSchema,
  actualSource: z.strictObject({
    kind: z.literal('authoritative-posted-ledger'),
    coverage: z.literal('posted-journals-in-budget-periods'),
    signBasis: z.literal('account-kind'),
  }),
  rows: z.array(FinanceBudgetActualRowSchema).max(10_000),
});

export const FinanceForecastOpeningInputSchema = z.discriminatedUnion(
  'status',
  [
    z
      .strictObject({
        status: z.literal('available'),
        ...financeMoneyFields,
        sourceReference: z.string().trim().min(1).max(200),
        reviewedBy: UuidSchema,
        reviewedAt: IsoDateTimeSchema,
      })
      .superRefine(validateMoneyPrecision),
    z.strictObject({
      status: z.literal('unavailable'),
      label: z.literal('opening-balance-unavailable'),
    }),
  ],
);

export const FinanceForecastAssumptionInputSchema = z
  .strictObject({
    periodId: UuidSchema,
    accountId: UuidSchema,
    ...financeMoneyFields,
    label: z.string().trim().min(1).max(200),
    sourceReference: z.string().trim().min(1).max(200),
    reviewedBy: UuidSchema,
    reviewedAt: IsoDateTimeSchema,
  })
  .superRefine(validateMoneyPrecision);

export const SaveFinanceForecastSchema = z.strictObject({
  forecastId: UuidSchema.optional(),
  expectedRevision: FinancePlanningExpectedRevisionSchema.optional(),
  budgetId: UuidSchema,
  budgetRevision: FinancePlanningRevisionSchema,
  asOf: z.iso.date(),
  openingBalance: FinanceForecastOpeningInputSchema,
  assumptions: z.array(FinanceForecastAssumptionInputSchema).max(10_000),
});

export const FinanceForecastOpeningSchema = z.discriminatedUnion('status', [
  z
    .strictObject({
      status: z.literal('available'),
      ...financeMoneyFields,
      sourceReference: z.string().trim().min(1).max(200),
      reviewedBy: UuidSchema,
      reviewedAt: IsoDateTimeSchema,
    })
    .superRefine(validateMoneyPrecision),
  z.strictObject({
    status: z.literal('unavailable'),
    label: z.literal('opening-balance-unavailable'),
  }),
]);

export const FinanceForecastLineSchema = z.strictObject({
  periodId: UuidSchema,
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  accountId: UuidSchema,
  accountKind: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
  currency: FinanceCurrencySchema,
  budgetAmount: FinanceDecimalSchema,
  postedActualAmount: FinanceDecimalSchema,
  forecastAmount: FinanceDecimalSchema.nullable(),
  basis: z.enum(['posted-actual', 'reviewed-assumption', 'unavailable']),
  actualSignBasis: FinancePlanningSignBasisSchema,
  label: FinancePlanningLabelSchema.nullable(),
});

export const FinanceForecastAssumptionSchema =
  FinanceForecastAssumptionInputSchema.extend({
    forecastId: UuidSchema,
    revision: FinancePlanningRevisionSchema,
  });

export const FinanceForecastSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: UuidSchema,
  bookId: UuidSchema,
  forecastId: UuidSchema,
  revision: FinancePlanningRevisionSchema,
  budgetId: UuidSchema,
  budgetRevision: FinancePlanningRevisionSchema,
  functionalCurrency: FinanceCurrencySchema,
  asOf: z.iso.date(),
  snapshotAt: IsoDateTimeSchema,
  openingBalance: FinanceForecastOpeningSchema,
  futureAssumptionsStatus: z.enum([
    'not-applicable',
    'provided',
    'partial',
    'unavailable',
  ]),
  labels: z.array(FinancePlanningLabelSchema).max(2),
  actualSource: z.strictObject({
    kind: z.literal('authoritative-posted-ledger'),
    coverage: z.literal('posted-journals-through-as-of'),
    signBasis: z.literal('account-kind'),
  }),
  assumptionsSource: z.literal('reviewed-inputs-only'),
  createdBy: UuidSchema,
  createdAt: IsoDateTimeSchema,
  lines: z.array(FinanceForecastLineSchema).max(10_000),
  assumptions: z.array(FinanceForecastAssumptionSchema).max(10_000),
});

export const FinanceForecastSummarySchema = FinanceForecastSnapshotSchema.omit({
  lines: true,
  assumptions: true,
  openingBalance: true,
});

export const FinanceForecastListSchema = z.strictObject({
  forecasts: z.array(FinanceForecastSummarySchema).max(100),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export const FinancePlanningPageQuerySchema = z.strictObject({
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const FinancePlanningIdempotencyKeySchema = IdempotencyKeySchema;

export type FinanceBudgetLine = z.infer<typeof FinanceBudgetLineSchema>;
export type FinancePlanningExpectedRevision = z.infer<
  typeof FinancePlanningExpectedRevisionSchema
>;
export type FinancePlanningCapability = z.infer<
  typeof FinancePlanningCapabilitySchema
>;
export type FinancePlanningAutomationIntent = z.infer<
  typeof FinancePlanningAutomationIntentSchema
>;
export type SaveFinanceBudget = z.infer<typeof SaveFinanceBudgetSchema>;
export type FinanceBudgetRevision = z.infer<typeof FinanceBudgetRevisionSchema>;
export type FinanceBudgetSummary = z.infer<typeof FinanceBudgetSummarySchema>;
export type FinanceBudgetActualRow = z.infer<
  typeof FinanceBudgetActualRowSchema
>;
export type FinanceBudgetVsActuals = z.infer<
  typeof FinanceBudgetVsActualsSchema
>;
export type FinanceForecastOpeningInput = z.infer<
  typeof FinanceForecastOpeningInputSchema
>;
export type FinanceForecastAssumptionInput = z.infer<
  typeof FinanceForecastAssumptionInputSchema
>;
export type SaveFinanceForecast = z.infer<typeof SaveFinanceForecastSchema>;
export type FinanceForecastSnapshot = z.infer<
  typeof FinanceForecastSnapshotSchema
>;
export type FinanceForecastSummary = z.infer<
  typeof FinanceForecastSummarySchema
>;

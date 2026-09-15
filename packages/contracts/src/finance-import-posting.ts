import { z } from 'zod';
import { UuidSchema } from './primitives.js';
import { FinanceCurrencySchema, FinanceDecimalSchema } from './finance-v2.js';

/** Persisted accounting result, never a review target or model proposal. */
export const FinanceNormalizedImportPostingSchema = z.strictObject({
  economicTransactionId: UuidSchema,
  journalId: UuidSchema,
  functionalCurrency: FinanceCurrencySchema,
  effectiveOn: z.iso.date(),
  description: z.string(),
  sourceReference: z.string().nullable(),
  reversalOf: UuidSchema.nullable(),
  lines: z
    .array(
      z.strictObject({
        lineNumber: z.number().int().positive(),
        accountId: UuidSchema,
        side: z.enum(['debit', 'credit']),
        amount: FinanceDecimalSchema,
        currency: FinanceCurrencySchema,
        nativeAmount: FinanceDecimalSchema,
        fxRate: FinanceDecimalSchema,
        fxSource: z.string(),
        description: z.string().nullable(),
      }),
    )
    .min(2),
});
export type FinanceNormalizedImportPosting = z.infer<
  typeof FinanceNormalizedImportPostingSchema
>;

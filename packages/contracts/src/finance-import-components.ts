import { z } from 'zod';
import { UuidSchema } from './primitives.js';

/*
 * Keep this module independent from finance-v2.ts. finance-v2 imports the
 * review list below, so importing its currency/decimal schemas here would
 * create an ESM initialization cycle. These constraints intentionally mirror
 * the canonical Finance schemas and are kept local to this additive contract.
 */
const FinanceDecimalSchema = z
  .string()
  .max(40)
  .regex(/^-?(?:0|[1-9]\d{0,25})(?:\.\d{1,12})?$/);
const FinanceCurrencySchema = z.enum([
  'CAD',
  'USD',
  'MXN',
  'EUR',
  'KRW',
  'JPY',
]);

export const FinanceNormalizedAmountComponentKindSchema = z.enum([
  'fee',
  'commission',
  'tax',
  'principal',
  'interest',
]);
export type FinanceNormalizedAmountComponentKind = z.infer<
  typeof FinanceNormalizedAmountComponentKindSchema
>;

export const FinanceNormalizedAmountComponentInclusionSchema = z.enum([
  'included-in-net',
  'excluded-from-net',
]);
export type FinanceNormalizedAmountComponentInclusion = z.infer<
  typeof FinanceNormalizedAmountComponentInclusionSchema
>;

export const FinanceNormalizedAmountComponentSideSchema = z.enum([
  'debit',
  'credit',
]);
export type FinanceNormalizedAmountComponentSide = z.infer<
  typeof FinanceNormalizedAmountComponentSideSchema
>;

/** Immutable source location retained beside every typed component value. */
export const FinanceNormalizedAmountComponentProvenanceSchema = z.strictObject({
  sourceRow: z.number().int().positive(),
  field: FinanceNormalizedAmountComponentKindSchema,
  column: z.string().max(200).nullable(),
  raw: z.string().max(10_000),
  contextAnchor: z.string().max(300).nullable(),
  // PDF extraction may attach a source span/line proof. Keep the original
  // adapter payload alongside the normalized coordinates; it is evidence,
  // never posting authority.
  pdfSource: z.unknown().optional(),
});
export type FinanceNormalizedAmountComponentProvenance = z.infer<
  typeof FinanceNormalizedAmountComponentProvenanceSchema
>;

/** A normalized observation. It contains no posting authority. */
export const FinanceNormalizedAmountComponentSourceSchema = z.strictObject({
  kind: FinanceNormalizedAmountComponentKindSchema,
  nativeAmount: FinanceDecimalSchema,
  currency: FinanceCurrencySchema,
  provenance: FinanceNormalizedAmountComponentProvenanceSchema,
});
export type FinanceNormalizedAmountComponentSource = z.infer<
  typeof FinanceNormalizedAmountComponentSourceSchema
>;

/**
 * A reviewer must explicitly confirm every posting fact. `nativeAmount` and
 * `currency` are repeated here so a correction remains explicit while the
 * original source observation stays immutable. The side is never inferred
 * from the sign of the source value.
 */
export const FinanceNormalizedAmountComponentReviewSchema = z.strictObject({
  kind: FinanceNormalizedAmountComponentKindSchema,
  nativeAmount: FinanceDecimalSchema,
  currency: FinanceCurrencySchema,
  inclusion: FinanceNormalizedAmountComponentInclusionSchema,
  postingSide: FinanceNormalizedAmountComponentSideSchema,
  ledgerAccountId: UuidSchema,
  fxRate: FinanceDecimalSchema,
  fxSource: z.string().trim().min(1).max(200),
});
export type FinanceNormalizedAmountComponentReview = z.infer<
  typeof FinanceNormalizedAmountComponentReviewSchema
>;

export const FinanceNormalizedAmountComponentReviewListSchema = z
  .array(FinanceNormalizedAmountComponentReviewSchema)
  .max(5)
  .superRefine((values, ctx) => {
    if (new Set(values.map((value) => value.kind)).size !== values.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Review each normalized amount component kind once',
      });
  });
export type FinanceNormalizedAmountComponentReviewList = z.infer<
  typeof FinanceNormalizedAmountComponentReviewListSchema
>;

/** Read model returned with a normalized import row. */
export const FinanceNormalizedAmountComponentViewSchema = z.strictObject({
  id: UuidSchema,
  rowId: UuidSchema,
  kind: FinanceNormalizedAmountComponentKindSchema,
  nativeAmount: FinanceDecimalSchema,
  currency: FinanceCurrencySchema,
  provenance: FinanceNormalizedAmountComponentProvenanceSchema,
  revision: z.number().int().positive(),
  reviewedNativeAmount: FinanceDecimalSchema.nullable(),
  reviewedCurrency: FinanceCurrencySchema.nullable(),
  inclusion: FinanceNormalizedAmountComponentInclusionSchema.nullable(),
  postingSide: FinanceNormalizedAmountComponentSideSchema.nullable(),
  ledgerAccountId: UuidSchema.nullable(),
  fxRate: FinanceDecimalSchema.nullable(),
  fxSource: z.string().nullable(),
});
export type FinanceNormalizedAmountComponentView = z.infer<
  typeof FinanceNormalizedAmountComponentViewSchema
>;

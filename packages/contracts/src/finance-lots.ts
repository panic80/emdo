import { z } from 'zod';
import { UuidSchema } from './primitives.js';
import { FinanceCurrencySchema, FinanceDecimalSchema } from './finance-v2.js';
const NonNegative = FinanceDecimalSchema.refine(
  (v) => !v.startsWith('-'),
  'Must be nonnegative',
);
const Positive = NonNegative.refine(
  (v) => !/^0(?:\.0+)?$/.test(v),
  'Must be positive',
);
/** This is cost tracking input, not a jurisdictional tax-method election. */
export const InvestmentLotStateSchema = z.strictObject({
  id: UuidSchema,
  financialAccountId: UuidSchema,
  instrumentId: UuidSchema,
  acquiredOn: z.iso.date(),
  acquisitionSequence: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  originalQuantity: Positive,
  disposedQuantity: NonNegative,
  originalNativeCost: NonNegative,
  allocatedNativeCost: NonNegative,
  originalFunctionalCost: NonNegative,
  allocatedFunctionalCost: NonNegative,
  nativeCurrency: FinanceCurrencySchema,
  functionalCurrency: FinanceCurrencySchema,
  sourceReference: z.string().trim().min(1).max(500),
});
const AmountPair = z.strictObject({
  native: NonNegative,
  functional: NonNegative,
});
export const AllocateInvestmentDisposalSchema = z.strictObject({
  financialAccountId: UuidSchema,
  instrumentId: UuidSchema,
  effectiveOn: z.iso.date(),
  quantity: Positive,
  nativeCurrency: FinanceCurrencySchema,
  functionalCurrency: FinanceCurrencySchema,
  method: z.enum(['fifo', 'specific']),
  selections: z
    .array(z.strictObject({ lotId: UuidSchema, quantity: Positive }))
    .max(10000),
  lots: z.array(InvestmentLotStateSchema).min(1).max(10000),
  grossProceeds: AmountPair,
  fees: AmountPair,
  commissions: AmountPair,
  taxes: AmountPair,
  taxTreatment: z.enum(['disposal-cost', 'withholding']),
  fxSourceReference: z.string().trim().min(1).max(500).nullable(),
  sourceReference: z.string().trim().min(1).max(500),
});

export const RecordInvestmentLotSchema = z.strictObject({
  movementId: UuidSchema,
  nativeCurrency: FinanceCurrencySchema,
  nativeCost: NonNegative,
  functionalCost: NonNegative,
  sourceReference: z.string().trim().min(1).max(500),
});
export const RecordLotDisposalSchema = AllocateInvestmentDisposalSchema.omit({
  financialAccountId: true,
  instrumentId: true,
  effectiveOn: true,
  quantity: true,
  functionalCurrency: true,
  lots: true,
}).extend({ movementId: UuidSchema });

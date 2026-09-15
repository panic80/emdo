import { z } from 'zod';
import { UuidSchema } from './primitives.js';
import { FinanceCurrencySchema, FinanceDecimalSchema } from './finance-v2.js';

const PositiveDecimal = FinanceDecimalSchema.refine(
  (value) => !value.startsWith('-') && !/^0(?:\.0+)?$/.test(value),
  'Must be positive',
);
export const CreateFinanceInstrumentSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['equity', 'fund', 'bond', 'option', 'future', 'other']),
  quantityUnit: z.enum(['share', 'unit', 'face-value', 'contract']),
  // Explicit quote conversion: e.g. 0.01 for price per 100 face value or 100 shares per contract.
  valuationMultiplier: PositiveDecimal,
  identifiers: z
    .array(
      z.strictObject({
        scheme: z.enum(['ISIN', 'CUSIP', 'SEDOL', 'ticker', 'provider']),
        value: z.string().trim().min(1).max(100),
        namespace: z.string().trim().min(1).max(100),
      }),
    )
    .max(20),
});
export const InvestmentMovementSchema = z.strictObject({
  id: UuidSchema,
  financialAccountId: UuidSchema,
  instrumentId: UuidSchema,
  effectiveOn: z.iso.date(),
  quantity: FinanceDecimalSchema,
  sourceReference: z.string().trim().min(1).max(200),
});
export const InvestmentOpeningSchema = z.strictObject({
  financialAccountId: UuidSchema,
  instrumentId: UuidSchema,
  asOf: z.iso.date(),
  quantity: FinanceDecimalSchema,
  sourceReference: z.string().trim().min(1).max(200),
});
export const ObservedInvestmentPositionSchema = z
  .strictObject({
    id: UuidSchema,
    financialAccountId: UuidSchema,
    instrumentId: UuidSchema,
    asOf: z.iso.date(),
    quantity: FinanceDecimalSchema,
    reportedMarketValue: FinanceDecimalSchema.nullable(),
    currency: FinanceCurrencySchema.nullable(),
    evidenceId: UuidSchema,
    sourceRow: z.number().int().positive(),
  })
  .refine(
    (v) => v.reportedMarketValue === null || v.currency !== null,
    'Reported value requires its currency',
  );
export const InvestmentPriceSchema = z.strictObject({
  id: UuidSchema,
  instrumentId: UuidSchema,
  asOf: z.iso.date(),
  price: FinanceDecimalSchema.refine(
    (value) => !value.startsWith('-'),
    'Price must be nonnegative',
  ),
  currency: FinanceCurrencySchema,
  sourceReference: z.string().trim().min(1).max(200),
});
export const InvestmentFxSchema = z
  .strictObject({
    id: UuidSchema,
    asOf: z.iso.date(),
    fromCurrency: FinanceCurrencySchema,
    toCurrency: FinanceCurrencySchema,
    rate: PositiveDecimal,
    sourceReference: z.string().trim().min(1).max(200),
  })
  .refine(
    (v) => v.fromCurrency !== v.toCurrency,
    'Identity conversion does not require an FX observation',
  );
export const CalculateInvestmentPositionSchema = z.strictObject({
  financialAccountId: UuidSchema,
  instrumentId: UuidSchema,
  asOf: z.iso.date(),
  opening: InvestmentOpeningSchema.nullable(),
  movements: z.array(InvestmentMovementSchema).max(100000),
});
export const ValueInvestmentPositionSchema = z.strictObject({
  financialAccountId: UuidSchema,
  instrumentId: UuidSchema,
  asOf: z.iso.date(),
  quantity: FinanceDecimalSchema.nullable(),
  valuationMultiplier: PositiveDecimal,
  functionalCurrency: FinanceCurrencySchema,
  price: InvestmentPriceSchema.nullable(),
  fx: InvestmentFxSchema.nullable(),
});
export type ObservedInvestmentPosition = z.infer<
  typeof ObservedInvestmentPositionSchema
>;

export const RecordInvestmentPriceSchema = InvestmentPriceSchema.omit({
  id: true,
});
export const RecordInvestmentFxSchema = z
  .strictObject(InvestmentFxSchema.shape)
  .omit({ id: true })
  .refine(
    (v) => v.fromCurrency !== v.toCurrency,
    'Identity conversion does not require an FX observation',
  );
export const RecordInvestmentOpeningSchema = InvestmentOpeningSchema.extend({
  evidenceId: UuidSchema,
});
export const PreviewInvestmentValuationSchema = z.strictObject({
  asOf: z.iso.date(),
  positions: z
    .array(
      z.strictObject({
        financialAccountId: UuidSchema,
        instrumentId: UuidSchema,
        openingId: UuidSchema.nullable(),
        priceId: UuidSchema.nullable(),
        fxId: UuidSchema.nullable(),
        observedPositionId: UuidSchema.nullable(),
      }),
    )
    .min(1)
    .max(500),
});

export const RecordObservedInvestmentPositionSchema = z
  .strictObject(ObservedInvestmentPositionSchema.shape)
  .omit({ id: true })
  .refine(
    (v) => v.reportedMarketValue === null || v.currency !== null,
    'Reported value requires its currency',
  );

export const SaveInvestmentValuationSchema =
  PreviewInvestmentValuationSchema.extend({
    expectedInputHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  });

export const RecordInvestmentMovementSchema = InvestmentMovementSchema.omit({
  id: true,
}).extend({ journalId: UuidSchema });

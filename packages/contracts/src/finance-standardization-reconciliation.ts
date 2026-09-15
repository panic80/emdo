import { z } from 'zod';
import { UuidSchema, IsoDateTimeSchema, Sha256Schema } from './primitives.js';
const Revision = z.number().int().positive().max(2147483647);
export const FinanceStandardizationPricingSchema = z.strictObject({
  inputCadMinorPerMillionTokens: z.number().int().safe().positive(),
  outputCadMinorPerMillionTokens: z.number().int().safe().positive(),
});
export const FinanceStandardizationReceiptSchema = z.strictObject({
  id: UuidSchema,
  reservationId: UuidSchema,
  providerResponseId: z.string().min(1).max(200),
  status: z.enum(['pending', 'verified', 'unavailable', 'mismatch']),
  receiptDigest: Sha256Schema.nullable(),
  inputTokens: z.number().int().safe().nonnegative().nullable(),
  outputTokens: z.number().int().safe().nonnegative().nullable(),
  actualCadMinor: z.number().int().safe().nonnegative().nullable(),
  observedAt: IsoDateTimeSchema,
});
export const FinanceStandardizationReconciliationSchema = z.strictObject({
  runId: UuidSchema,
  workspaceId: UuidSchema,
  bookId: UuidSchema,
  sourceDigest: Sha256Schema,
  revision: Revision,
  status: z.string().min(1).max(40),
  hasLiveLease: z.boolean(),
  canResolve: z.boolean(),
  spend: z
    .array(
      z.strictObject({
        id: UuidSchema,
        attempt: Revision,
        status: z.enum(['reserved', 'completed', 'not-sent', 'indeterminate']),
        dispatchPhase: z.enum([
          'unknown',
          'not-dispatched',
          'dispatch-started',
        ]),
        pricingVersion: z.string().min(1).max(128),
        pricing: FinanceStandardizationPricingSchema.nullable(),
        reservedCadMinor: z.number().int().safe().positive(),
        actualCadMinor: z.number().int().safe().nonnegative().nullable(),
        providerResponseId: z.string().min(1).max(200).nullable(),
        lineage: z.unknown(),
      }),
    )
    .max(3),
  receipts: z.array(FinanceStandardizationReceiptSchema).max(30),
  resolutions: z
    .array(
      z.strictObject({
        id: UuidSchema,
        reservationId: UuidSchema.nullable(),
        decision: z.enum([
          'confirm-not-sent',
          'accept-actual-cost',
          'retain-reserved-cost',
        ]),
        reviewedBy: UuidSchema,
        reviewedAt: IsoDateTimeSchema,
        receiptId: UuidSchema.nullable(),
      }),
    )
    .max(30),
});
export const LookupFinanceStandardizationReceiptSchema = z.strictObject({
  expectedRevision: Revision,
  reservationId: UuidSchema,
});
export const ResolveFinanceStandardizationSchema = z
  .strictObject({
    expectedRevision: Revision,
    reservationId: UuidSchema.nullable(),
    decision: z.enum([
      'confirm-not-sent',
      'accept-actual-cost',
      'retain-reserved-cost',
    ]),
    receiptId: UuidSchema.nullable(),
    acknowledgeNoApproval: z.literal(true),
  })
  .refine(
    (value) =>
      value.decision !== 'retain-reserved-cost' ||
      (value.reservationId !== null && value.receiptId === null),
    'Retaining reserved cost requires the exact reservation and no cost receipt.',
  );

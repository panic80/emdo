import { z } from 'zod';
import { UuidSchema } from './primitives.js';
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const StructuredInvoiceFactSchema = z.strictObject({
  path: z.string().max(4096),
  namespace: z.string().max(300),
  name: z.string().max(200),
  text: z.string().max(16384),
  attributes: z
    .array(
      z.strictObject({
        name: z.string().max(400),
        value: z.string().max(4096),
      }),
    )
    .max(30),
});
export const StructuredInvoiceFieldSchema = z.strictObject({
  value: z.string().max(16384),
  path: z.string().max(4096),
});
const Field = StructuredInvoiceFieldSchema;
export const StructuredInvoiceExtractionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  adapterVersion: z.literal('structured-invoice.v1'),
  format: z.enum(['ubl', 'cii']),
  sourceDigest: Digest,
  conformance: z.literal('not-validated'),
  documentInstructions: z.literal('untrusted-source-data'),
  invoiceId: Field.nullable(),
  issueDate: Field.nullable(),
  dueDate: Field.nullable(),
  currency: Field.nullable(),
  typeCode: Field.nullable(),
  profile: Field.nullable(),
  seller: z.array(StructuredInvoiceFactSchema).max(1000),
  buyer: z.array(StructuredInvoiceFactSchema).max(1000),
  lines: z
    .array(
      z.strictObject({
        id: Field.nullable(),
        description: Field.nullable(),
        netAmount: Field.nullable(),
        quantity: Field.nullable(),
        facts: z.array(StructuredInvoiceFactSchema).max(1000),
      }),
    )
    .max(250),
  adjustments: z
    .array(
      z.strictObject({
        scope: z.enum(['document', 'line']),
        charge: Field.nullable(),
        amount: Field.nullable(),
        facts: z.array(StructuredInvoiceFactSchema).max(1000),
      }),
    )
    .max(1000),
  taxGroups: z
    .array(
      z.strictObject({
        key: z.string().max(4096),
        category: Field.nullable(),
        rate: Field.nullable(),
        basis: Field.nullable(),
        tax: Field.nullable(),
      }),
    )
    .max(100),
  totals: z.strictObject({
    lineNet: Field.nullable(),
    net: Field.nullable(),
    tax: Field.nullable(),
    gross: Field.nullable(),
    payable: Field.nullable(),
    allowances: Field.nullable(),
    charges: Field.nullable(),
    prepaid: Field.nullable(),
    rounding: Field.nullable(),
  }),
  facts: z.array(StructuredInvoiceFactSchema).max(10000),
  blockingIssues: z.array(z.string().max(500)).max(100),
  reviewRequired: z.literal(true),
});
export type StructuredInvoiceExtraction = z.infer<
  typeof StructuredInvoiceExtractionSchema
>;
export const ReviewStructuredInvoiceSchema = z.strictObject({
  expectedSourceDigest: Digest,
  expectedAdapterVersion: z.literal('structured-invoice.v1'),
  kind: z.enum(['supplier-bill', 'sales-invoice']),
  partyId: UuidSchema,
  controlAccountId: UuidSchema,
  acknowledgedSourceParties: z.literal(true),
  acknowledgedTaxGroupAggregation: z.literal(true),
  acknowledgedNoConformanceValidation: z.literal(true),
  groups: z
    .array(
      z.strictObject({
        key: z.string().min(1).max(4096),
        accountId: UuidSchema,
        taxAccountId: UuidSchema.nullable(),
      }),
    )
    .min(1)
    .max(100),
});

/** Incomplete accounting decisions can be saved without granting posting authority. */
export const StructuredInvoiceReviewDraftSchema =
  ReviewStructuredInvoiceSchema.extend({
    partyId: UuidSchema.nullable(),
    controlAccountId: UuidSchema.nullable(),
    acknowledgedSourceParties: z.boolean(),
    acknowledgedTaxGroupAggregation: z.boolean(),
    acknowledgedNoConformanceValidation: z.boolean(),
    groups: z
      .array(
        z.strictObject({
          key: z.string().min(1).max(4096),
          accountId: UuidSchema.nullable(),
          taxAccountId: UuidSchema.nullable(),
        }),
      )
      .max(100),
  });
export const SaveStructuredInvoiceReviewDraftSchema = z.strictObject({
  expectedRevision: z.number().int().min(0).max(2147483646),
  draft: StructuredInvoiceReviewDraftSchema,
});
export const PostReviewedStructuredInvoiceSchema =
  ReviewStructuredInvoiceSchema.extend({
    expectedReviewRevision: z.number().int().positive().max(2147483647),
  });
export const StructuredInvoiceReviewDraftRecordSchema = z.strictObject({
  id: UuidSchema,
  evidenceId: UuidSchema,
  revision: z.number().int().positive(),
  draft: StructuredInvoiceReviewDraftSchema,
});

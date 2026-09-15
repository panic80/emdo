import { z } from 'zod';
import { FinanceImagePromptProjectionReceiptSchema } from './finance-image.js';
import { IsoDateTimeSchema, Sha256Schema, UuidSchema } from './primitives.js';
import { FinanceReportMappingDefinitionSchema } from './finance-report-mappings.js';

export const FinancePdfPromptProjectionReceiptSchema = z.strictObject({
  kind: z.literal('pdf-text.v1'),
  extractionDigest: Sha256Schema,
  projectionDigest: Sha256Schema,
  pageCount: z.number().int().positive().max(25),
  spanCount: z.number().int().nonnegative().max(20000),
  textCharacters: z.number().int().nonnegative().max(262144),
  omittedPages: z.literal(0),
});
export const FinancePromptProjectionReceiptSchema = z.union([
  FinanceImagePromptProjectionReceiptSchema,
  FinancePdfPromptProjectionReceiptSchema,
]);
export type FinancePromptProjectionReceipt = z.infer<
  typeof FinancePromptProjectionReceiptSchema
>;

const Revision = z.number().int().positive().max(2147483647);
export const FinanceExtractionAdapterSchema = z.strictObject({
  id: z.string().min(1).max(100),
  version: z.string().min(1).max(50),
  formats: z
    .array(
      z.enum([
        'csv',
        'xlsx',
        'pdf',
        'ofx',
        'qfx',
        'ubl',
        'cii',
        'png',
        'jpeg',
        'webp',
      ]),
    )
    .min(1)
    .max(10),
  availability: z.enum(['implemented', 'unavailable']),
  workflow: z.enum(['dynamic-mapping', 'native-review', 'unsupported']),
  facts: z
    .array(
      z.enum([
        'source-rows',
        'source-cells',
        'sheet-names',
        'page-spans',
        'structured-fields',
        'cached-formulas',
        'machine-transcription',
        'pixel-regions',
      ]),
    )
    .max(6),
  limitations: z.array(z.string().min(1).max(500)).max(20),
  maxBytes: z.number().int().positive().max(10485760),
});
export const FinanceExtractionRegistrySchema = z.strictObject({
  version: z.literal('finance-extraction-registry.v1'),
  adapters: z.array(FinanceExtractionAdapterSchema).min(1).max(20),
});
export const FinanceStandardizationStatusSchema = z.enum([
  'queued',
  'extracting',
  'proposing',
  'needs-review',
  'extracted',
  'blocked',
  'authority-revoked',
  'cancelled',
  'indeterminate',
]);
export const FinanceStandardizationExtractionSchema = z.strictObject({
  revision: Revision,
  adapterId: z.string().min(1).max(100),
  adapterVersion: z.string().min(1).max(50),
  sourceDigest: Sha256Schema,
  extractionDigest: Sha256Schema,
  status: z.enum([
    'extracted',
    'needs-source-review',
    'needs-ocr',
    'unsupported',
  ]),
  tableCount: z.number().int().nonnegative().max(1000),
  sheetCount: z.number().int().nonnegative().max(100),
  pageCount: z.number().int().nonnegative().max(1000),
  truncated: z.boolean(),
  issues: z.array(z.string().min(1).max(500)).max(100),
});
/** Returned only by the trusted EMDO orchestration boundary, never accepted from UI/model output. */
export const FinanceStandardizationModelProvenanceSchema = z.strictObject({
  controller: z.literal('emdo'),
  orchestrationMode: z.literal('registered-workflow'),
  managerInvocationId: UuidSchema,
  financeInvocationId: UuidSchema,
  providerResponseId: z.string().min(1).max(200),
  model: z.literal('gpt-6-astra'),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  promptVersion: z.enum([
    'finance-standardization-proposal.v1',
    'finance-standardization-proposal.v2',
    'finance-standardization-proposal.v3',
    'finance-standardization-proposal.v4',
    'finance-standardization-proposal.v5',
  ]),
  promptProjection: FinancePromptProjectionReceiptSchema.optional(),
  completedAt: IsoDateTimeSchema,
});
export const FinanceStandardizationRunSchema = z.strictObject({
  executionMode: z.enum(['proposal', 'extraction-only']).default('proposal'),
  id: UuidSchema,
  workspaceId: UuidSchema,
  bookId: UuidSchema,
  evidenceId: UuidSchema,
  filename: z.string().min(1).max(200),
  format: z.string().min(1).max(20),
  sourceDigest: Sha256Schema,
  revision: Revision,
  attempt: z.number().int().nonnegative().max(3),
  status: FinanceStandardizationStatusSchema,
  authorizedByUserId: UuidSchema,
  authorizationExpiresAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  extraction: FinanceStandardizationExtractionSchema.nullable(),
  proposal: z
    .strictObject({
      mappingId: UuidSchema.nullable(),
      mappingVersion: Revision,
      definition: FinanceReportMappingDefinitionSchema,
      rationale: z.string().min(1).max(3000),
      status: z.literal('candidate'),
      unresolvedQuestions: z.array(z.string().min(1).max(500)).max(30),
    })
    .nullable(),
  reviewedMapping: z
    .strictObject({
      mappingId: UuidSchema,
      mappingVersion: Revision,
      status: z.enum(['candidate', 'approved', 'retired']),
    })
    .nullable()
    .default(null),
  modelProvenance: FinanceStandardizationModelProvenanceSchema.nullable(),
  blockers: z.array(z.string().min(1).max(500)).max(100),
  allowedActions: z
    .array(z.enum(['retry', 'cancel', 'review-source', 'open-mapping']))
    .max(4),
  approval: z.literal('not-granted'),
  posting: z.literal('not-performed'),
});
export type FinanceStandardizationRun = z.infer<
  typeof FinanceStandardizationRunSchema
>;
export const StartFinanceStandardizationSchema = z.strictObject({
  evidenceId: UuidSchema,
  expectedSourceDigest: Sha256Schema,
});
export const ChangeFinanceStandardizationSchema = z.strictObject({
  expectedRevision: Revision,
});
export const FinanceStandardizationListSchema = z.strictObject({
  runs: z.array(FinanceStandardizationRunSchema).max(50),
  nextOffset: z.number().int().nonnegative().nullable(),
});

/** A DB claim attests only this bounded run; no browser session or general delegation is carried. */
export const FinanceStandardizationClaimSchema = z.strictObject({
  runId: UuidSchema,
  workspaceId: UuidSchema,
  bookId: UuidSchema,
  evidenceId: UuidSchema,
  sourceDigest: Sha256Schema,
  revision: Revision,
  leaseToken: UuidSchema,
  leaseExpiresAt: IsoDateTimeSchema,
  authorizedByUserId: UuidSchema,
  authorizationRevision: z.strictObject({
    membership: Revision,
    bookAccess: Revision,
    entitlement: Revision,
  }),
});
export const FinanceStandardizationExtractionEnvelopeSchema = z
  .strictObject({
    revision: Revision,
    adapterId: z.string().min(1).max(100),
    adapterVersion: z.string().min(1).max(50),
    sourceDigest: Sha256Schema,
    extractionDigest: Sha256Schema,
    kind: z.enum([
      'csv-table',
      'xlsx-regions',
      'pdf-layout',
      'image-ocr',
      'pdf-ocr',
    ]),
    factsJson: z.string().min(2).max(2097152),
    issues: z.array(z.string().min(1).max(500)).max(100),
    complete: z.boolean(),
    documentInstructions: z.literal('untrusted-source-data'),
  })
  .superRefine((envelope, context) => {
    const maxBytes = envelope.kind === 'pdf-layout' ? 2097152 : 262144;
    if (new TextEncoder().encode(envelope.factsJson).byteLength > maxBytes) {
      context.addIssue({
        code: 'custom',
        path: ['factsJson'],
        message: `Extraction facts exceed ${maxBytes} UTF-8 bytes.`,
      });
    }
  });
export type FinanceStandardizationClaim = z.infer<
  typeof FinanceStandardizationClaimSchema
>;
export type FinanceStandardizationExtractionEnvelope = z.infer<
  typeof FinanceStandardizationExtractionEnvelopeSchema
>;
export const FinanceStandardizationAvailabilitySchema = z.strictObject({
  registry: FinanceExtractionRegistrySchema,
  ready: z.boolean(),
  reason: z.string().min(1).max(500).nullable(),
});

export const LinkFinanceStandardizationMappingSchema =
  ChangeFinanceStandardizationSchema.extend({ mappingId: UuidSchema });

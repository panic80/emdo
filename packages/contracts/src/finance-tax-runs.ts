import { z } from 'zod';
import { UuidSchema } from './primitives.js';
import { FinanceTaxScopeSchema } from './finance-tax.js';
import { FinanceTaxDeclarationSourceBindingSchema } from './finance-tax-questionnaire.js';
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Revision = z.number().int().positive().max(2147483647);
export const FinanceTaxWorkingPaperWorkflowSchema = z.enum([
  'ca-on-2025-personal-working-papers',
  'ca-on-2025-corporate-working-papers',
  'us-fed-2025-working-papers',
  'us-ny-2025-working-papers',
  'mx-fed-2025-working-papers',
]);
const Binding = z.strictObject({
  expectedCaseRevision: Revision,
  expectedSnapshotHash: Hash,
  workflowId: FinanceTaxWorkingPaperWorkflowSchema,
  expectedPackageVersion: z.string().min(1).max(160),
});
/** Authenticated owner/reviewer approves exact saved input versions, never submitted values or outputs. */
export const ReviewPrivateTaxWorkingInputsSchema = Binding.extend({
  inputs: z.array(FinanceTaxDeclarationSourceBindingSchema).min(1).max(512),
}).superRefine((v, c) => {
  if (new Set(v.inputs.map((i) => i.sourceId)).size !== v.inputs.length)
    c.addIssue({
      code: 'custom',
      path: ['inputs'],
      message: 'Duplicate input binding',
    });
});
export const CreatePrivateTaxCalculationRunSchema = Binding;
export const ReviewPrivateTaxCalculationRunSchema = z.strictObject({
  expectedOutputHash: Hash,
  acknowledgement: z.literal('reviewed-incomplete-working-papers-not-fileable'),
});
export const FinanceTaxCalculationRunSummarySchema = z.strictObject({
  runId: UuidSchema,
  caseId: UuidSchema,
  taxSubjectId: UuidSchema,
  snapshotRevision: Revision,
  snapshotHash: Hash,
  workflowId: FinanceTaxWorkingPaperWorkflowSchema,
  packageVersion: z.string().min(1),
  packageHash: Hash,
  inputHash: Hash,
  outputHash: Hash,
  status: z.enum(['blocked-input', 'incomplete-working-papers']),
  complete: z.literal(false),
  createdBy: UuidSchema,
  createdAt: z.iso.datetime(),
});
export type FinanceTaxCalculationRunSummary = z.infer<
  typeof FinanceTaxCalculationRunSummarySchema
>;

export const FinanceTaxWorkingInputReviewSchema =
  FinanceTaxDeclarationSourceBindingSchema.extend({
    reviewedBy: UuidSchema,
    reviewedAt: z.iso.datetime(),
  });
export const FinanceTaxWorkingPaperPreparationSchema = z.strictObject({
  scopeSupported: z.boolean(),
  supportedScopes: z.array(FinanceTaxScopeSchema).max(100),
  caseId: UuidSchema,
  taxSubjectId: UuidSchema,
  snapshotRevision: Revision,
  snapshotHash: Hash,
  workflowId: FinanceTaxWorkingPaperWorkflowSchema,
  packageVersion: z.string().min(1).max(160),
  packageHash: Hash,
  complete: z.literal(false),
  questions: z
    .array(
      z.strictObject({
        key: z.string(),
        label: z.string(),
        type: z.enum(['boolean', 'date', 'decimal', 'text']),
        required: z.boolean(),
        locator: z.string(),
      }),
    )
    .max(512),
  inputReviews: z.array(FinanceTaxWorkingInputReviewSchema).max(512),
});
export const FinanceTaxRunFieldSchema = z.strictObject({
  id: z.string().min(1).max(1000),
  form: z.string().min(1).max(200),
  line: z.string().min(1).max(1000),
  label: z.string().max(1000),
  dependencies: z.array(z.string().max(1000)).max(10000),
  sourceId: z.string().max(200),
  locator: z.string().max(1000),
  exactRational: z.strictObject({
    numerator: z.string().regex(/^-?\d+$/),
    denominator: z.string().regex(/^[1-9]\d*$/),
  }),
  exactDecimal: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .nullable(),
  reportableAmount: z
    .string()
    .regex(/^-?\d+(\.\d{1,2})?$/)
    .nullable(),
  reporting: z.strictObject({
    target: z.enum([
      'cra-2025-fillable-paper-field',
      'irs-2025-paper-field',
      'sat-2025-working-paper-field',
    ]),
    policyVersion: z.string().max(160),
    status: z.enum([
      'lossless-cents',
      'lossless-at-proven-precision',
      'official-whole-dollar-rounding',
      'blocked-input',
      'field-proof-missing',
      'dependency-unresolved',
      'rounding-unproven',
      'field-width-exceeded',
    ]),
    rounding: z.enum(['none-lossless', 'irs-whole-dollar-half-up']).nullable(),
    blockedDependencies: z.array(z.string().max(1000)).max(10000),
    sourceId: z.string().max(200).nullable(),
    fieldPath: z.string().max(2000).nullable(),
  }),
});
export const FinanceTaxRunScheduleSchema = z.strictObject({
  formId: z.string().min(1).max(200),
  contentHash: Hash,
  content: z
    .array(
      z.strictObject({
        ordinal: z.number().int().min(0),
        field: FinanceTaxRunFieldSchema,
      }),
    )
    .max(10000),
});
export const FinanceTaxRunReviewSchema = z.strictObject({
  reviewId: UuidSchema,
  outputHash: Hash,
  acknowledgement: z.literal('reviewed-incomplete-working-papers-not-fileable'),
  reviewedBy: UuidSchema,
  reviewedAt: z.iso.datetime(),
});
export const FinanceTaxFormAuditSummarySchema = z.strictObject({
  version: z.string().min(1),
  runHash: Hash,
  packageVersion: z.string().min(1),
  formDataReady: z.literal(false),
  fieldCount: z.number().int().nonnegative(),
  unresolvedCount: z.number().int().nonnegative(),
  signature: z.strictObject({
    status: z.literal('manual-unperformed'),
    blocksCalculation: z.literal(false),
  }),
  requirements: z
    .array(
      z.strictObject({
        key: z.string(),
        type: z.enum(['text', 'date', 'boolean', 'decimal']),
        required: z.boolean(),
        satisfied: z.boolean(),
        sourceId: z.string(),
        sourceBinding: z
          .strictObject({
            kind: z.enum(['declaration', 'ledger-snapshot', 'evidence']),
            reference: z.string(),
            revision: Revision,
            contentHash: Hash,
            sourceBookId: UuidSchema.optional(),
          })
          .nullable(),
      }),
    )
    .max(100),
  issues: z.array(z.string().max(2000)).max(1000),
  remainingProof: z.array(z.string()).max(100),
});
export const FinanceTaxRunOutputSchema = z.strictObject({
  status: z.enum(['blocked', 'review-calculation-produced']),
  complete: z.literal(false),
  enabled: z.literal(false),
  reportable: z.literal(false),
  runHash: Hash,
  reportingPolicyVersion: z.string().min(1).max(160),
  issues: z
    .array(
      z.strictObject({
        code: z.string().max(200),
        path: z.string().max(1000),
        message: z.string().max(2000),
      }),
    )
    .max(10000),
  releaseBlockers: z.array(z.string().max(1000)).max(1000),
  finalAmounts: z.strictObject({ refund: z.null(), balanceOwing: z.null() }),
  formAudit: FinanceTaxFormAuditSummarySchema.optional(),
});
export const FinanceTaxCalculationRunDetailSchema = z.strictObject({
  summary: FinanceTaxCalculationRunSummarySchema,
  inputBinding: z.strictObject({
    snapshotRevision: Revision,
    snapshotHash: Hash,
    declarations: z.array(FinanceTaxDeclarationSourceBindingSchema).max(10000),
    inputReviews: z.array(FinanceTaxWorkingInputReviewSchema).max(512),
    sourceBooks: z
      .array(
        z.strictObject({
          authorizationId: UuidSchema,
          authorizationRevision: Revision,
          bookId: UuidSchema,
          snapshotRevision: Revision,
          snapshotHash: Hash,
        }),
      )
      .max(100),
  }),
  authorities: z
    .array(
      z.strictObject({
        id: z.string(),
        url: z.url(),
        formVersion: z.string(),
        documentHash: Hash,
        retrievedAt: z.iso.datetime({ offset: true }),
      }),
    )
    .max(1000),
  output: FinanceTaxRunOutputSchema,
  schedules: z.array(FinanceTaxRunScheduleSchema).max(1000),
  reviews: z.array(FinanceTaxRunReviewSchema).max(1000),
});
export type FinanceTaxCalculationRunDetail = z.infer<
  typeof FinanceTaxCalculationRunDetailSchema
>;

export const FinanceTaxWorkingInputReviewReceiptSchema = z.strictObject({
  caseId: UuidSchema,
  snapshotRevision: Revision,
  snapshotHash: Hash,
  reviewedInputCount: z.number().int().min(1).max(512),
  complete: z.literal(false),
});
export const FinanceTaxRunReviewReceiptSchema = z.strictObject({
  caseId: UuidSchema,
  runId: UuidSchema,
  reviewId: UuidSchema,
  outputHash: Hash,
  complete: z.literal(false),
});
export const FinanceTaxRunExportSchema =
  FinanceTaxRunReviewReceiptSchema.extend({
    snapshotHash: Hash,
    filename: z.string().min(1).max(200),
    mimeType: z.literal('text/csv'),
    content: z.string().max(8000000),
    sha256: Hash,
  });

/** Saved human extraction only. Approval and original-byte authority are server derived. */
export const FinanceTaxWageExtractionV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    documents: z
      .array(
        z.strictObject({
          bookId: UuidSchema,
          evidenceId: UuidSchema,
          form: z.enum(['W-2', 'W-2c']),
          originalEvidenceId: UuidSchema.nullable(),
          boxes: z.strictObject({
            box1: z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/),
            box2: z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/),
            box3: z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/),
            box5: z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/),
            box6: z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/),
            box7: z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/),
          }),
        }),
      )
      .max(5),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.documents.map((d) => d.evidenceId)).size !==
      value.documents.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate wage document' });
    if (JSON.stringify(value).length > 2000)
      ctx.addIssue({
        code: 'custom',
        message: 'Wage extraction exceeds saved input limit',
      });
  });
const WageAmount = z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/);
const WageBoxes = z.strictObject({
  box1: WageAmount,
  box2: WageAmount,
  box3: WageAmount,
  box5: WageAmount,
  box6: WageAmount,
  box7: WageAmount,
});
const WageCorrection = z.strictObject({
  box: z.enum(['box1', 'box2', 'box3', 'box5', 'box6', 'box7']),
  previous: WageAmount,
  correct: WageAmount,
});
const WageDocumentV2 = z.discriminatedUnion('form', [
  z.strictObject({
    bookId: UuidSchema,
    evidenceId: UuidSchema,
    form: z.literal('W-2'),
    originalEvidenceId: z.null(),
    boxes: WageBoxes,
  }),
  z.strictObject({
    bookId: UuidSchema,
    evidenceId: UuidSchema,
    form: z.literal('W-2c'),
    originalEvidenceId: UuidSchema,
    supersedesEvidenceId: UuidSchema,
    corrections: z.array(WageCorrection).max(6),
    boxes: WageBoxes,
  }),
]);
/** Version 2 preserves the original and every immediate correction. This schema
 * describes saved inputs only; trusted original review validates the entire chain. */
export const FinanceTaxWageExtractionV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    documents: z.array(WageDocumentV2).max(5),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.documents.map((d) => d.evidenceId)).size !==
      value.documents.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate wage document' });
    if (JSON.stringify(value).length > 2000)
      ctx.addIssue({
        code: 'custom',
        message: 'Wage extraction exceeds saved input limit',
      });
    for (const d of value.documents)
      if (
        d.form === 'W-2c' &&
        new Set(d.corrections.map((c) => c.box)).size !== d.corrections.length
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Duplicate corrected wage box',
        });
  });
export const FinanceTaxWageExtractionSchema = z.union([
  FinanceTaxWageExtractionV1Schema,
  FinanceTaxWageExtractionV2Schema,
]);
export const ReviewPrivateTaxWageEvidenceSchema = Binding.extend({
  input: FinanceTaxDeclarationSourceBindingSchema,
  acknowledgement: z.literal('verified-saved-boxes-against-original-documents'),
});
export const FinanceTaxWageEvidenceReviewSchema = z.strictObject({
  reviewId: UuidSchema,
  caseId: UuidSchema,
  snapshotRevision: Revision,
  snapshotHash: Hash,
  sourceId: UuidSchema,
  sourceRevision: Revision,
  contentHash: Hash,
  manifestHash: Hash,
  documentCount: z.number().int().min(0).max(5),
  reviewedBy: UuidSchema,
  reviewedAt: z.iso.datetime(),
});
export const FinanceTaxWageEvidencePreparationSchema = z.strictObject({
  caseId: UuidSchema,
  snapshotRevision: Revision,
  snapshotHash: Hash,
  documents: z
    .array(
      z.strictObject({
        bookId: UuidSchema,
        evidenceId: UuidSchema,
        filename: z.string().max(500),
        format: z.enum(['pdf', 'png', 'jpeg']),
        contentHash: Hash,
        byteSize: z.number().int().positive(),
      }),
    )
    .max(100),
  review: FinanceTaxWageEvidenceReviewSchema.nullable(),
});

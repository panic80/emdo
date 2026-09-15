import {
  ReviewedFinancePdfOcrSelectionSchema,
  FinancePdfPageRenderSchema,
} from './finance-pdf-ocr.js';
import { z } from 'zod';
import { Sha256Schema, UuidSchema } from './primitives.js';
import { FinanceDecimalSchema } from './finance-v2.js';
import {
  ReviewedFinancePdfSelectionSchema,
  FinancePdfCellProvenanceSchema,
} from './finance-pdf.js';
import {
  ReviewedFinanceImageSelectionSchema,
  FinanceImageCellProvenanceSchema,
} from './finance-image.js';
import { ReviewedFinanceXlsxSelectionSchema } from './finance-xlsx.js';

export const CanonicalReportFieldSchema = z.enum([
  'transactionDate',
  'description',
  'amount',
  'currency',
  'externalId',
  'asOf',
  'instrumentIdentifier',
  'quantity',
  'bookCost',
  'marketValue',
  'price',
  'accruedInterest',
  'fee',
  'commission',
  'tax',
  'principal',
  'interest',
]);
export const ReportFieldBindingSchema = z.strictObject({
  field: CanonicalReportFieldSchema,
  column: z.string().min(1).max(200).nullable(),
  context: z.enum(['asOf', 'currency']).nullable(),
});
/** Declarative data only: no executable transforms, scripts, regexes, or model-supplied authority. */
export const FinanceReportMappingDefinitionSchema = z
  .strictObject({
    providerKey: z.string().trim().min(1).max(100),
    reportName: z.string().trim().min(1).max(200),
    reportType: z.enum(['bank-transactions', 'investment-positions']),
    layoutVersion: z.string().trim().min(1).max(100),
    xlsxSelection: ReviewedFinanceXlsxSelectionSchema.nullable().optional(),
    pdfSelection: ReviewedFinancePdfSelectionSchema.nullable().optional(),
    imageSelection: ReviewedFinanceImageSelectionSchema.nullable().optional(),
    pdfOcrSelection: ReviewedFinancePdfOcrSelectionSchema.nullable().optional(),
    headers: z.array(z.string().min(1).max(200)).min(1).max(100),
    bindings: z.array(ReportFieldBindingSchema).min(1).max(30),
    dateFormat: z.enum([
      'yyyy-mm-dd',
      'mm/dd/yyyy',
      'dd/mm/yyyy',
      'dd.mm.yyyy',
      'yyyy/mm/dd',
    ]),
    decimalSeparator: z.enum(['.', ',']),
    groupingSeparator: z.enum(['', ',', '.', ' ']),
    quantityUnit: z
      .enum(['share', 'unit', 'face-value', 'contract'])
      .nullable(),
    valuationMultiplier: FinanceDecimalSchema.nullable(),
    identifierScheme: z
      .enum(['ISIN', 'CUSIP', 'SEDOL', 'ticker', 'provider'])
      .nullable(),
    identifierNamespace: z.string().trim().min(1).max(100).nullable(),
  })
  .superRefine((value, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    if (
      [
        value.xlsxSelection,
        value.pdfSelection,
        value.imageSelection,
        value.pdfOcrSelection,
      ].filter(Boolean).length > 1
    )
      issue('Select exactly one reviewed source format');
    if (
      value.xlsxSelection?.dateColumns.length &&
      value.dateFormat !== 'yyyy-mm-dd'
    )
      issue('Reviewed XLSX date conversion requires yyyy-mm-dd mapping dates');
    if (new Set(value.headers).size !== value.headers.length)
      issue('Duplicate source headings are ambiguous');
    if (value.decimalSeparator === value.groupingSeparator)
      issue('Decimal and grouping separators must differ');
    const fields = value.bindings.map((b) => b.field);
    if (new Set(fields).size !== fields.length)
      issue('Map each canonical field once');
    const columns = value.bindings.flatMap((b) => (b.column ? [b.column] : []));
    if (new Set(columns).size !== columns.length)
      issue(
        'One source column cannot silently serve different financial meanings',
      );
    for (const binding of value.bindings) {
      if ((binding.column === null) === (binding.context === null))
        issue('Select exactly one source column or report context');
      if (binding.column !== null && !value.headers.includes(binding.column))
        issue('Mapped source heading is absent');
      if (binding.context !== null && binding.field !== binding.context)
        issue('Context can supply only its declared canonical meaning');
    }
    const position = value.reportType === 'investment-positions';
    const required = position
      ? ['asOf', 'instrumentIdentifier', 'quantity', 'currency']
      : ['transactionDate', 'description', 'amount', 'currency'];
    const allowed = position
      ? [
          'asOf',
          'instrumentIdentifier',
          'quantity',
          'currency',
          'description',
          'bookCost',
          'marketValue',
          'price',
          'accruedInterest',
        ]
      : [
          'transactionDate',
          'description',
          'amount',
          'currency',
          'externalId',
          'fee',
          'commission',
          'tax',
          'principal',
          'interest',
        ];
    if (required.some((f) => !fields.includes(f as (typeof fields)[number])))
      issue('Required canonical fields are missing');
    if (fields.some((f) => !allowed.includes(f)))
      issue('Field belongs to a different report section');
    if (
      position &&
      (!value.quantityUnit ||
        !value.identifierScheme ||
        !value.identifierNamespace)
    )
      issue('Position identity and quantity units must be explicit');
    if (
      fields.includes('price') &&
      (value.valuationMultiplier === null ||
        value.valuationMultiplier.startsWith('-') ||
        /^0(?:\.0+)?$/.test(value.valuationMultiplier))
    )
      issue('Price requires an explicit positive quote multiplier');
    if (
      !position &&
      (value.quantityUnit !== null ||
        value.valuationMultiplier !== null ||
        value.identifierScheme !== null ||
        value.identifierNamespace !== null)
    )
      issue('Transaction sections cannot inherit instrument quote conventions');
  });
const ContextFieldSchema = z.strictObject({
  value: z.string().min(1).max(200),
  sourceAnchor: z.string().min(1).max(300),
});
export const ExtractedFinanceReportTableSchema = z.strictObject({
  extractionReview: z
    .discriminatedUnion('version', [
      z.strictObject({
        version: z.literal('reviewed-pdf-ocr.v1'),
        sourceDigest: Sha256Schema,
        selectionDigest: Sha256Schema,
        standardizationRunId: UuidSchema,
        ocrExtractionRevision: z.number().int().positive().max(3),
        ocrExtractionDigest: Sha256Schema,
        render: FinancePdfPageRenderSchema,
        coverage: z.literal('selected-page-regions-only'),
        rowNumbering: z.literal('logical-selection-order-not-pdf-row-numbers'),
        textBasis: z.literal('human-reviewed-visual-transcription'),
      }),
      z.strictObject({
        version: z.literal('reviewed-image.v1'),
        sourceDigest: Sha256Schema,
        selectionDigest: Sha256Schema,
        standardizationRunId: UuidSchema,
        ocrExtractionRevision: z.number().int().positive().max(3),
        ocrExtractionDigest: Sha256Schema,
        coverage: z.literal('selected-regions-only'),
        rowNumbering: z.literal(
          'logical-selection-order-not-image-row-numbers',
        ),
        textBasis: z.literal('human-reviewed-visual-transcription'),
      }),
      z.strictObject({
        version: z.literal('reviewed-xlsx.v1'),
        sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
        selectionDigest: z.string().regex(/^[a-f0-9]{64}$/),
      }),
      z.strictObject({
        version: z.literal('reviewed-pdf.v1'),
        sourceDigest: Sha256Schema,
        selectionDigest: Sha256Schema,
        coverage: z.literal('selected-spans-only'),
        rowNumbering: z.literal('logical-selection-order-not-pdf-row-numbers'),
      }),
      z.strictObject({
        /** CSV has no interactive range selection; the parser descriptor is
         * hashed so a saved candidate remains bound to the exact adapter. */
        version: z.literal('reviewed-csv.v1'),
        sourceDigest: Sha256Schema,
        selectionDigest: Sha256Schema,
      }),
    ])
    .optional(),
  pdfOcrCellProvenance: z
    .array(
      z.strictObject({
        originalPageNumber: z.number().int().min(1).max(25),
        sourceAnchor: z.string().min(1).max(300),
        rasterCell: FinanceImageCellProvenanceSchema,
      }),
    )
    .max(2200)
    .optional(),
  imageCellProvenance: z
    .array(FinanceImageCellProvenanceSchema)
    .max(2200)
    .optional(),
  pdfCellProvenance: z
    .array(FinancePdfCellProvenanceSchema)
    .max(2200)
    .optional(),
  documentId: UuidSchema,
  extractionRevision: z.number().int().positive(),
  tableId: z.string().min(1).max(100),
  page: z.number().int().positive().nullable(),
  sheet: z.string().min(1).max(200).nullable(),
  providerKey: z.string().trim().min(1).max(100),
  reportType: z.enum(['bank-transactions', 'investment-positions']),
  headers: z.array(z.string().min(1).max(200)).min(1).max(100),
  context: z.strictObject({
    asOf: ContextFieldSchema.nullable(),
    currency: ContextFieldSchema.nullable(),
  }),
  rows: z
    .array(
      z.strictObject({
        sourceRow: z.number().int().positive(),
        cells: z.array(z.string().max(10000)).max(100),
      }),
    )
    .min(1)
    .max(2000),
});
export const ProposedFinanceReportMappingSchema = z.strictObject({
  definition: FinanceReportMappingDefinitionSchema,
  rationale: z.string().min(1).max(3000),
  unresolvedQuestions: z.array(z.string().min(1).max(500)).max(30),
});
export type FinanceReportMappingDefinition = z.infer<
  typeof FinanceReportMappingDefinitionSchema
>;
export const SaveFinanceReportMappingSchema = z
  .strictObject({
    proposal: ProposedFinanceReportMappingSchema,
    example: ExtractedFinanceReportTableSchema,
  })
  .refine(
    (value) =>
      !value.proposal.definition.pdfSelection &&
      !value.proposal.definition.imageSelection &&
      !value.proposal.definition.pdfOcrSelection,
    'Reviewed PDF/image candidates require source-only evidenceId payloads',
  );
export const SaveReviewedFinanceSourceMappingSchema = z
  .strictObject({
    evidenceId: UuidSchema,
    proposal: ProposedFinanceReportMappingSchema,
  })
  .refine(
    (value) =>
      !!(
        value.proposal.definition.xlsxSelection ||
        value.proposal.definition.pdfSelection ||
        value.proposal.definition.imageSelection ||
        value.proposal.definition.pdfOcrSelection
      ),
    'Reviewed source selection is required',
  );
export const SaveReviewedFinanceXlsxMappingSchema =
  SaveReviewedFinanceSourceMappingSchema.refine(
    (value) => !!value.proposal.definition.xlsxSelection,
    'Reviewed XLSX selection is required',
  );
export const SaveReviewedFinancePdfMappingSchema =
  SaveReviewedFinanceSourceMappingSchema.refine(
    (value) =>
      !!value.proposal.definition.pdfSelection &&
      !value.proposal.definition.imageSelection &&
      !value.proposal.definition.pdfOcrSelection,
    'Reviewed PDF selection is required',
  );
export const SaveReviewedFinanceImageMappingSchema =
  SaveReviewedFinanceSourceMappingSchema.refine(
    (value) =>
      !!value.proposal.definition.imageSelection &&
      !value.proposal.definition.pdfOcrSelection,
    'Reviewed image selection is required',
  );
export const SaveReviewedFinancePdfOcrMappingSchema =
  SaveReviewedFinanceSourceMappingSchema.refine(
    (value) => !!value.proposal.definition.pdfOcrSelection,
    'Reviewed PDF OCR selection is required',
  );
/** Source-only CSV proposal. The server re-reads the encrypted evidence and
 * creates the example table; callers cannot provide extracted rows. */
export const SaveFinanceReportMappingFromSourceSchema = z
  .strictObject({
    evidenceId: UuidSchema,
    expectedSourceDigest: Sha256Schema,
    proposal: ProposedFinanceReportMappingSchema,
  })
  .refine(
    (value) =>
      !value.proposal.definition.xlsxSelection &&
      !value.proposal.definition.pdfSelection &&
      !value.proposal.definition.imageSelection &&
      !value.proposal.definition.pdfOcrSelection,
    'CSV source mappings cannot include another source selection',
  );
export const ReviewFinanceReportMappingSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  decision: z.enum(['approve', 'retire']),
  reason: z.string().trim().min(3).max(1000),
});
export const InspectFinanceReportSourceSchema = z.strictObject({
  standardizationRunId: UuidSchema.nullable().optional(),
  extractionRevision: z.number().int().positive().max(3).nullable().optional(),
  imageTextOffset: z.number().int().min(0).max(65536).default(0),
  pdfPage: z.number().int().min(1).max(25).default(1),
  pdfTextOffset: z.number().int().min(0).max(262144).default(0),
  tableId: z.string().min(1).max(100).nullable().default(null),
  candidateOffset: z.number().int().min(0).max(2000).default(0),
  provenanceOffset: z.number().int().min(0).max(100000).default(0),
  schemaVersion: z.literal(1),
  bookId: UuidSchema,
  evidenceId: UuidSchema,
  offset: z.number().int().min(0).max(2000).default(0),
});
export const ProposeFinanceMappingFromSourceSchema = z.strictObject({
  tableId: z.string().min(1).max(100).nullable().default(null),
  schemaVersion: z.literal(1),
  bookId: UuidSchema,
  evidenceId: UuidSchema,
  proposal: ProposedFinanceReportMappingSchema,
});
export const UploadFinanceBookEvidenceSchema = z.discriminatedUnion('format', [
  z.strictObject({
    filename: z.string().trim().min(1).max(200),
    format: z.enum(['csv', 'ofx', 'qfx', 'ubl', 'cii']),
    sourceText: z.string().min(1).max(2097152),
  }),
  z.strictObject({
    filename: z.string().trim().min(1).max(200),
    format: z.enum(['xlsx', 'pdf', 'png', 'jpeg', 'webp']),
    sourceBase64: z
      .string()
      .min(4)
      .max(2796204)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ),
  }),
]);

/** Reuse loads the original server-side; caller cannot substitute extracted rows. */
export const ImportMappedFinanceReportSchema = z.strictObject({
  evidenceId: UuidSchema,
  financialAccountId: UuidSchema,
  expectedMappingVersion: z.number().int().positive(),
  providerKey: z.string().trim().min(1).max(100),
});

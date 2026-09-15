import { z } from 'zod';
import { Sha256Schema, UuidSchema } from './primitives.js';
export const FinanceImageBoxSchema = z.strictObject({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export const FinanceImageOcrWordSchema = z.strictObject({
  id: z.string().min(1).max(100),
  text: z.string().min(1).max(10000),
  page: z.literal(1),
  block: z.number().int().nonnegative(),
  paragraph: z.number().int().nonnegative(),
  line: z.number().int().nonnegative(),
  word: z.number().int().positive(),
  coordinateSpace: z.literal('image-pixels-top-left'),
  confidence: z.number().finite().min(0).max(1).nullable(),
  confidenceStatus: z.enum(['high', 'uncertain', 'unreadable']),
  sourceAnchor: z.string().min(1).max(240),
  box: FinanceImageBoxSchema,
});
/** This is a machine observation of pixels, never authoritative document text. */
export const FinanceImageOcrFactsSchema = z
  .strictObject({
    status: z.enum(['extracted', 'no-text']),
    qualityStatus: z.enum(['high-confidence', 'uncertain', 'unreadable']),
    sourceDigest: Sha256Schema,
    format: z.enum(['png', 'jpeg', 'webp']),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    coordinateSpace: z.literal('image-pixels-top-left'),
    engine: z.strictObject({
      id: z.string().min(1).max(100),
      version: z.string().min(1).max(100),
      languages: z.array(z.string().min(1).max(30)).min(1).max(5),
      trainedData: z
        .array(
          z.strictObject({
            language: z.string().min(1).max(30),
            sha256: Sha256Schema,
          }),
        )
        .min(1)
        .max(5),
    }),
    text: z.string().max(65536),
    words: z.array(FinanceImageOcrWordSchema).max(5000),
    issues: z.array(z.string().min(1).max(500)).max(100),
    truncated: z.literal(false),
    textBasis: z.literal('machine-transcription-requires-review'),
  })
  .superRefine((v, c) => {
    if ((v.status === 'no-text') !== (v.words.length === 0))
      c.addIssue({
        code: 'custom',
        message: 'OCR text status must match the saved word inventory',
      });
    if (v.words.reduce((n, word) => n + word.text.length, 0) > 65536)
      c.addIssue({
        code: 'custom',
        message: 'OCR raw word text exceeds the bounded inventory',
      });
    if (
      new Set(v.engine.languages).size !== v.engine.languages.length ||
      new Set(v.engine.trainedData.map((data) => data.language)).size !==
        v.engine.trainedData.length ||
      v.engine.languages.length !== v.engine.trainedData.length ||
      v.engine.languages.some(
        (language) =>
          !v.engine.trainedData.some((data) => data.language === language),
      )
    )
      c.addIssue({
        code: 'custom',
        message: 'OCR languages require exact traineddata provenance',
      });
    if (v.width * v.height > 16000000)
      c.addIssue({ code: 'custom', message: 'Image pixel limit exceeded' });
    if (new Set(v.words.map((w) => w.id)).size !== v.words.length)
      c.addIssue({
        code: 'custom',
        message: 'OCR word identity must be unique',
      });
    if (
      v.words.some(
        (w) =>
          w.box.x + w.box.width > v.width || w.box.y + w.box.height > v.height,
      )
    )
      c.addIssue({
        code: 'custom',
        message: 'OCR word box is outside the image',
      });
  });
export const ReviewedFinanceImageCellSchema = z
  .strictObject({
    region: FinanceImageBoxSchema,
    words: z.array(FinanceImageOcrWordSchema).max(40),
    joiner: z.enum(['', ' ']),
    reviewedText: z.string().min(1).max(10000),
    correctionReason: z.string().trim().min(1).max(500).nullable(),
    confirmedAgainstOriginal: z.literal(true),
  })
  .superRefine((cell, c) => {
    const raw = cell.words.map((w) => w.text).join(cell.joiner);
    if (cell.reviewedText !== raw && !cell.correctionReason)
      c.addIssue({
        code: 'custom',
        message:
          'Visual transcription changes require an explicit correction reason',
      });
    if (!cell.words.length && !cell.correctionReason)
      c.addIssue({
        code: 'custom',
        message: 'Transcription of an OCR-missed region requires a reason',
      });
  });
export const ReviewedFinanceImageSelectionSchema = z
  .strictObject({
    expectedSourceDigest: Sha256Schema,
    standardizationRunId: UuidSchema,
    extractionRevision: z.number().int().positive().max(3),
    expectedExtractionDigest: Sha256Schema,
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    coordinateSpace: z.literal('image-pixels-top-left'),
    reviewedWordInventoryDigest: Sha256Schema,
    headerCells: z.array(ReviewedFinanceImageCellSchema).min(1).max(100),
    rows: z
      .array(
        z.strictObject({
          cells: z.array(ReviewedFinanceImageCellSchema).min(1).max(100),
        }),
      )
      .min(1)
      .max(2000),
    context: z.strictObject({
      asOf: ReviewedFinanceImageCellSchema.nullable(),
      currency: ReviewedFinanceImageCellSchema.nullable(),
    }),
    acknowledgeOcrUncertainty: z.literal(true),
    acknowledgeUnselectedContent: z.literal(true),
    confirmedHeaderAndContext: z.literal(true),
  })
  .superRefine((v, c) => {
    if (v.rows.some((row) => row.cells.length !== v.headerCells.length))
      c.addIssue({
        code: 'custom',
        message: 'Every reviewed row must have one cell for each header',
      });
    const cells = [
      ...v.headerCells,
      ...v.rows.flatMap((r) => r.cells),
      ...[v.context.asOf, v.context.currency].filter((x) => x !== null),
    ];
    if (
      cells.length > 2200 ||
      cells.reduce((n, x) => n + x.words.length, 0) > 5000
    )
      c.addIssue({
        code: 'custom',
        message: 'Reviewed selection exceeds cell or word bounds',
      });
  });
export const FinanceImageCellProvenanceSchema = z.strictObject({
  role: z.enum(['header', 'data', 'context-asOf', 'context-currency']),
  logicalRow: z.number().int().min(0).max(2000).nullable(),
  column: z.number().int().min(1).max(100).nullable(),
  sourceAnchor: z.string().min(1).max(300),
  region: FinanceImageBoxSchema,
  ocrWords: z.array(FinanceImageOcrWordSchema).max(40),
  ocrText: z.string().max(10000),
  reviewedText: z.string().min(1).max(10000),
  correctionReason: z.string().min(1).max(500).nullable(),
  textBasis: z.literal('human-reviewed-visual-transcription'),
});
export type FinanceImageOcrFacts = z.infer<typeof FinanceImageOcrFactsSchema>;
export type ReviewedFinanceImageSelection = z.infer<
  typeof ReviewedFinanceImageSelectionSchema
>;
export const FinanceImageInspectionSchema = z
  .strictObject({
    evidenceId: UuidSchema,
    standardizationRunId: UuidSchema,
    extractionRevision: z.number().int().positive().max(3),
    extractionDigest: Sha256Schema,
    sourceDigest: Sha256Schema,
    wordInventoryDigest: Sha256Schema,
    facts: FinanceImageOcrFactsSchema,
  })
  .superRefine((value, context) => {
    if (value.sourceDigest !== value.facts.sourceDigest)
      context.addIssue({
        code: 'custom',
        message: 'Image inspection source binding mismatch',
      });
  });

export const FinanceImagePromptProjectionReceiptSchema = z.strictObject({
  version: z.literal('finance-image-lines-prefix.v1'),
  extractionDigest: Sha256Schema,
  digest: Sha256Schema,
  selectedWordCount: z.number().int().nonnegative().max(5000),
  omittedWordCount: z.number().int().nonnegative().max(5000),
  selectedLineCount: z.number().int().nonnegative().max(5000),
  omittedLineCount: z.number().int().nonnegative().max(5000),
  selectedTextCharacterCount: z.number().int().nonnegative().max(65536),
  omittedTextCharacterCount: z.number().int().nonnegative().max(65536),
  textCounting: z.literal('sum-of-raw-word-text-utf16-units'),
});

import { z } from 'zod';

/** A full inspected source span. Preview truncation or character-level selections
 * are not accepted: a span containing several columns cannot be split here.
 */
export const ReviewedFinancePdfSpanSchema = z.strictObject({
  index: z.number().int().min(0).max(19999),
  text: z.string().min(1).max(10000),
  textLength: z.number().int().min(1).max(10000),
  transform: z.array(z.number().finite()).length(6),
  width: z.number().finite(),
  height: z.number().finite(),
  direction: z.string().min(1).max(10),
  fontName: z.string().min(1).max(200),
  hasEOL: z.boolean(),
  textOffset: z.number().int().min(0).max(262144),
  truncated: z.literal(false),
});
export const ReviewedFinancePdfCellSchema = z.strictObject({
  spans: z.array(ReviewedFinancePdfSpanSchema).min(1).max(20),
  joiner: z.enum(['', ' ']),
});
export const ReviewedFinancePdfPageInventorySchema = z.strictObject({
  page: z.number().int().min(1).max(25),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  rotation: z.number().finite(),
  textStatus: z.enum(['text-extracted', 'no-extractable-text']),
  textLength: z.number().int().min(0).max(262144),
  spanCount: z.number().int().min(0).max(20000),
});
/** Declarative source-selection facts, not authenticated approval. Callers must
 * bind actual user review separately. Every row number is a logical selection
 * ordinal; PDF page/span anchors remain the authoritative source locations.
 */
export const ReviewedFinancePdfSelectionSchema = z
  .strictObject({
    expectedSourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    page: z.number().int().min(1).max(25),
    reviewedPageInventory: z
      .array(ReviewedFinancePdfPageInventorySchema)
      .min(1)
      .max(25),
    headerCells: z.array(ReviewedFinancePdfCellSchema).min(1).max(100),
    rows: z
      .array(
        z.strictObject({
          cells: z.array(ReviewedFinancePdfCellSchema).min(1).max(100),
        }),
      )
      .min(1)
      .max(2000),
    context: z.strictObject({
      asOf: ReviewedFinancePdfCellSchema.nullable(),
      currency: ReviewedFinancePdfCellSchema.nullable(),
    }),
    confirmedHeaderAndCellSelection: z.literal(true),
    confirmedContextSelection: z.literal(true),
    acknowledgeUnselectedContent: z.boolean(),
  })
  .superRefine((selection, context) => {
    if (
      selection.rows.some(
        (row) => row.cells.length !== selection.headerCells.length,
      )
    )
      context.addIssue({
        code: 'custom',
        message:
          'Each explicitly selected row must have exactly one source cell per header',
      });
    const cells = [
      ...selection.headerCells,
      ...selection.rows.flatMap((row) => row.cells),
      ...[selection.context.asOf, selection.context.currency].filter(
        (cell) => cell !== null,
      ),
    ];
    if (cells.reduce((count, cell) => count + cell.spans.length, 0) > 2000)
      context.addIssue({
        code: 'custom',
        message:
          'At most 2000 complete source spans may be selected per reviewed table',
      });
    if (
      new Set(selection.reviewedPageInventory.map((page) => page.page)).size !==
      selection.reviewedPageInventory.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Page inventory must identify every source page exactly once',
      });
  });
export type ReviewedFinancePdfSelection = z.infer<
  typeof ReviewedFinancePdfSelectionSchema
>;
export type ReviewedFinancePdfCell = z.infer<
  typeof ReviewedFinancePdfCellSchema
>;
export type ReviewedFinancePdfSpan = z.infer<
  typeof ReviewedFinancePdfSpanSchema
>;
export type ReviewedFinancePdfPageInventory = z.infer<
  typeof ReviewedFinancePdfPageInventorySchema
>;

/** Exact source facts retained with each normalized field; no financial interpretation. */
export const FinancePdfCellProvenanceSchema = z.strictObject({
  role: z.enum(['header', 'data', 'context-asOf', 'context-currency']),
  logicalRow: z.number().int().min(0).max(2000).nullable(),
  column: z.number().int().min(1).max(100).nullable(),
  page: z.number().int().min(1).max(25),
  sourceAnchor: z.string().min(1).max(300),
  sourceSpans: z
    .array(
      ReviewedFinancePdfSpanSchema.omit({ textLength: true, truncated: true }),
    )
    .min(1)
    .max(20),
  joiner: z.enum(['', ' ']),
  value: z.string().max(10000),
});

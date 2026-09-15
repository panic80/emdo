import { z } from 'zod';

const row = z.number().int().min(1).max(1_048_576);
const column = z.number().int().min(1).max(100);
/** Selection facts only. The caller must establish that an authorized user reviewed
 * these exact facts against these exact bytes; model-supplied booleans are not approval.
 */
export const ReviewedFinanceXlsxSelectionSchema = z
  .strictObject({
    sheet: z.string().min(1).max(200),
    headerRow: row,
    firstColumn: column,
    lastColumn: column,
    firstDataRow: row,
    lastDataRow: row,
    dateColumns: z.array(column).max(100),
    confirmedHeaderAndDataRange: z.literal(true),
    confirmedDateSystem: z.enum(['1900', '1904']),
    acknowledgeCachedFormulaValues: z.boolean(),
    acknowledgeHiddenContent: z.boolean(),
  })
  .superRefine((selection, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: 'custom', message });
    if (
      selection.firstColumn > selection.lastColumn ||
      selection.headerRow >= selection.firstDataRow ||
      selection.firstDataRow > selection.lastDataRow
    )
      issue('Select ordered columns, then a header above the data rows');
    const rows = selection.lastDataRow - selection.firstDataRow + 1;
    if (
      rows > 2000 ||
      (rows + 1) * (selection.lastColumn - selection.firstColumn + 1) > 100_000
    )
      issue('Selected rectangle exceeds the bounded extraction size');
    if (
      new Set(selection.dateColumns).size !== selection.dateColumns.length ||
      selection.dateColumns.some(
        (c) => c < selection.firstColumn || c > selection.lastColumn,
      )
    )
      issue(
        'Date columns must be unique columns inside the selected rectangle',
      );
  });
export type ReviewedFinanceXlsxSelection = z.infer<
  typeof ReviewedFinanceXlsxSelectionSchema
>;

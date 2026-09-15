import { createHash } from 'node:crypto';
import {
  ExtractedFinanceReportTableSchema,
  ReviewedFinancePdfSelectionSchema,
  type ReviewedFinancePdfCell,
} from '@emdo/contracts';
import type { z } from 'zod';
import {
  FINANCE_PDF_REPORT_LIMITS,
  extractFinancePdfReport,
  type FinancePdfTextSpan,
  type FinancePdfReportLimits,
} from './pdf-report-extraction.js';

export { ReviewedFinancePdfSelectionSchema } from '@emdo/contracts';
export type { ReviewedFinancePdfSelection } from '@emdo/contracts';

function fail(reason: string): never {
  throw new Error(`finance-reviewed-pdf-${reason}`);
}
export interface ReviewedPdfCellProvenance {
  role: 'header' | 'data' | 'context-asOf' | 'context-currency';
  logicalRow: number | null;
  column: number | null;
  page: number;
  sourceAnchor: string;
  sourceSpans: FinancePdfTextSpan[];
  joiner: '' | ' ';
  value: string;
}
type SourceMetadata = Pick<
  z.infer<typeof ExtractedFinanceReportTableSchema>,
  'documentId' | 'extractionRevision' | 'providerKey' | 'reportType'
>;

/** Re-extracts original PDF bytes and validates complete inspected spans. No OCR,
 * inferred columns/rows, financial coercion or user-approval authority exists here.
 * Coverage is always selected-spans-only, even when all extracted text is selected.
 */
export async function extractReviewedFinancePdfTable(
  bytes: Uint8Array,
  selectionInput: unknown,
  source: SourceMetadata,
  options: {
    signal?: AbortSignal;
    limits?: Partial<FinancePdfReportLimits>;
  } = {},
) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength)
    fail('invalid-source-bytes');
  if (
    bytes.byteLength >
    Math.min(
      options.limits?.maxBytes ?? FINANCE_PDF_REPORT_LIMITS.maxBytes,
      FINANCE_PDF_REPORT_LIMITS.maxBytes,
    )
  )
    fail('extraction-bytes-limit');
  if (Buffer.byteLength(JSON.stringify(selectionInput) ?? '') > 4 * 1024 * 1024)
    fail('selection-bytes-limit');
  const selection = ReviewedFinancePdfSelectionSchema.parse(selectionInput);
  const sourceDigest = createHash('sha256').update(bytes).digest('hex');
  if (sourceDigest !== selection.expectedSourceDigest)
    fail('source-digest-mismatch');
  const extraction = await extractFinancePdfReport(bytes, options);
  if (extraction.status === 'unavailable')
    fail(`extraction-${extraction.reason}`);
  if (extraction.issues.includes('text-decoding-needs-review'))
    fail('text-decoding-unavailable');
  const pageInventory = extraction.pages.map(
    ({ page, width, height, rotation, textStatus, text, spans }) => ({
      page,
      width,
      height,
      rotation,
      textStatus,
      textLength: text.length,
      spanCount: spans.length,
    }),
  );
  if (
    JSON.stringify(selection.reviewedPageInventory) !==
    JSON.stringify(pageInventory)
  )
    fail('page-inventory-mismatch');
  const page = extraction.pages.find((page) => page.page === selection.page);
  if (!page || page.textStatus !== 'text-extracted')
    fail('selected-page-text-unavailable');
  // Conservative support for horizontal LTR text on an unrotated origin-aligned
  // page. Unsupported frames are not silently projected into guessed cell boxes.
  if (
    page.rotation !== 0 ||
    JSON.stringify(page.viewportTransform) !==
      JSON.stringify([1, 0, 0, -1, 0, page.height])
  )
    fail('page-geometry-unsupported');
  const used = new Set<number>();
  const boxes: {
    index: number;
    x1: number;
    x2: number;
    y1: number;
    y2: number;
  }[] = [];
  const provenance: ReviewedPdfCellProvenance[] = [];
  const valueOf = (
    cell: ReviewedFinancePdfCell,
    role: ReviewedPdfCellProvenance['role'],
    logicalRow: number | null,
    column: number | null,
  ) => {
    const spans = cell.spans.map((expected) => {
      const actual = page.spans[expected.index];
      if (!actual || actual.index !== expected.index)
        fail('source-span-missing');
      const { truncated, textLength, ...facts } = expected;
      if (
        truncated !== false ||
        textLength !== actual.text.length ||
        JSON.stringify(facts) !== JSON.stringify(actual)
      )
        fail('source-span-facts-mismatch');
      if (!actual.text.trim()) fail('source-span-text-missing');
      if (used.has(actual.index)) fail('source-span-used-more-than-once');
      used.add(actual.index);
      const [a, b, c, d, x, y] = actual.transform;
      if (
        actual.direction !== 'ltr' ||
        b !== 0 ||
        c !== 0 ||
        a <= 0 ||
        d <= 0 ||
        actual.width <= 0 ||
        actual.height <= 0
      )
        fail('span-geometry-unsupported');
      const box = {
        index: actual.index,
        x1: x,
        x2: x + actual.width,
        y1: y,
        y2: y + actual.height,
      };
      if (
        box.x1 < 0 ||
        box.y1 < 0 ||
        box.x2 > page.width ||
        box.y2 > page.height
      )
        fail('span-outside-visible-page');
      // PDF.js text extents are a conservative ambiguity guard, not exact glyph
      // outlines. Overlapping selected extents require a different review method.
      if (
        boxes.some(
          (other) =>
            Math.min(box.x2, other.x2) - Math.max(box.x1, other.x1) >
              0.000001 &&
            Math.min(box.y2, other.y2) - Math.max(box.y1, other.y1) > 0.000001,
        )
      )
        fail('selected-span-overlap');
      boxes.push(box);
      return actual;
    });
    const value = spans.map((span) => span.text).join(cell.joiner);
    if (!value.trim() || value.length > 10000)
      fail('cell-text-missing-or-too-long');
    const sourceAnchor = `pdf-page-${page.page}:spans-${spans.map((span) => span.index).join(',')}`;
    provenance.push({
      role,
      logicalRow,
      column,
      page: page.page,
      sourceAnchor,
      sourceSpans: spans,
      joiner: cell.joiner,
      value,
    });
    return { value, sourceAnchor };
  };
  const headers = selection.headerCells.map(
    (cell, index) => valueOf(cell, 'header', 0, index + 1).value,
  );
  if (
    headers.some((header) => header.length > 200) ||
    new Set(headers).size !== headers.length
  )
    fail('headings-ambiguous');
  const rows = selection.rows.map((row, index) => ({
    sourceRow: index + 1,
    cells: row.cells.map(
      (cell, column) => valueOf(cell, 'data', index + 1, column + 1).value,
    ),
  }));
  const context = {
    asOf: selection.context.asOf
      ? valueOf(selection.context.asOf, 'context-asOf', null, null)
      : null,
    currency: selection.context.currency
      ? valueOf(selection.context.currency, 'context-currency', null, null)
      : null,
  };
  if (
    [context.asOf, context.currency].some(
      (field) => field !== null && field.value.length > 200,
    )
  )
    fail('context-text-too-long');
  const unselectedSpanInventory = extraction.pages.map((sourcePage) => ({
    page: sourcePage.page,
    textStatus: sourcePage.textStatus,
    spans: sourcePage.spans.filter(
      (span) => sourcePage.page !== page.page || !used.has(span.index),
    ),
  }));
  const omittedPages = extraction.pages
    .filter((sourcePage) => sourcePage.page !== page.page)
    .map((sourcePage) => sourcePage.page);
  if (
    (omittedPages.length ||
      unselectedSpanInventory.some((sourcePage) =>
        sourcePage.spans.some((span) => span.text.trim()),
      )) &&
    !selection.acknowledgeUnselectedContent
  )
    fail('unselected-content-acknowledgement-required');
  const selectionDigest = createHash('sha256')
    .update(JSON.stringify(selection))
    .digest('hex');
  const table = ExtractedFinanceReportTableSchema.parse({
    ...source,
    tableId: `pdf-reviewed-${selectionDigest.slice(0, 32)}`,
    page: page.page,
    sheet: null,
    headers,
    context,
    rows,
  });
  if (Buffer.byteLength(JSON.stringify(table)) > 8 * 1024 * 1024)
    fail('table-bytes-limit');
  if (options.signal?.aborted) fail('extraction-aborted');
  return {
    table,
    cellProvenance: provenance,
    reviewFacts: {
      selection,
      sourceDigest,
      selectionDigest,
      extractionVersion: 'pdfjs-5.4.296.whole-spans.v1' as const,
      coverage: 'selected-spans-only' as const,
      rowNumbering: 'logical-selection-order-not-pdf-row-numbers' as const,
      pageInventory,
      unselectedSpanInventory,
      omittedPages,
      sourceIssues: extraction.issues,
    },
  };
}

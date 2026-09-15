import {
  FinancePdfInspectionSchema,
  ReviewedFinancePdfSelectionSchema,
  ReviewedFinancePdfSpanSchema,
  type FinancePdfInspection,
  type ReviewedFinancePdfCell,
  type ReviewedFinancePdfSelection,
} from '@emdo/contracts/browser';

export type PdfReviewCell = ReviewedFinancePdfCell;
export type PdfReviewDraft = {
  headers: PdfReviewCell[];
  rows: PdfReviewCell[][];
  context: { asOf: PdfReviewCell; currency: PdfReviewCell };
};
export const emptyPdfCell = (): PdfReviewCell => ({ spans: [], joiner: ' ' });
export const pdfCellText = (cell: PdfReviewCell) =>
  cell.spans.map((span) => span.text).join(cell.joiner);
export function pdfReviewCells(draft: PdfReviewDraft) {
  return [
    ...draft.headers.map((cell, column) => ({ key: `h:${column}`, cell })),
    ...draft.rows.flatMap((row, index) =>
      row.map((cell, column) => ({ key: `r:${index}:${column}`, cell })),
    ),
    { key: 'c:asOf', cell: draft.context.asOf },
    { key: 'c:currency', cell: draft.context.currency },
  ];
}
export function pdfTargetLabel(key: string) {
  const [kind, index, column] = key.split(':');
  return kind === 'h'
    ? `Heading ${Number(index) + 1}`
    : kind === 'r'
      ? `Row ${Number(index) + 1}, column ${Number(column) + 1}`
      : index === 'asOf'
        ? 'As-of date context'
        : 'Currency context';
}
export function updatePdfCell(
  draft: PdfReviewDraft,
  key: string,
  cell: PdfReviewCell,
): PdfReviewDraft {
  const [kind, index, column] = key.split(':');
  if (kind === 'h')
    return {
      ...draft,
      headers: draft.headers.map((old, i) =>
        i === Number(index) ? cell : old,
      ),
    };
  if (kind === 'r')
    return {
      ...draft,
      rows: draft.rows.map((row, i) =>
        i === Number(index)
          ? row.map((old, c) => (c === Number(column) ? cell : old))
          : row,
      ),
    };
  return {
    ...draft,
    context: { ...draft.context, [index!]: cell },
  };
}
export function blankPdfDraft(columns = 0): PdfReviewDraft {
  return {
    headers: Array.from({ length: columns }, emptyPdfCell),
    rows: columns ? [Array.from({ length: columns }, emptyPdfCell)] : [],
    context: { asOf: emptyPdfCell(), currency: emptyPdfCell() },
  };
}
export function draftFromPdfSelection(
  selection: ReviewedFinancePdfSelection,
): PdfReviewDraft {
  return structuredClone({
    headers: selection.headerCells,
    // Proposals are suggestions, never evidence of a human blank-cell confirmation.
    rows: selection.rows.map((row) =>
      row.cells.map((cell) => (cell.confirmedBlank ? emptyPdfCell() : cell)),
    ),
    context: {
      asOf: selection.context.asOf ?? emptyPdfCell(),
      currency: selection.context.currency ?? emptyPdfCell(),
    },
  });
}

export function verifiedPdfInspection(
  raw: unknown,
  expected: { bookId: string; evidenceId: string; page: number },
): FinancePdfInspection {
  const value = FinancePdfInspectionSchema.parse(raw);
  if (
    value.bookId !== expected.bookId ||
    value.evidenceId !== expected.evidenceId
  )
    throw new Error('The inspection belongs to a different book or original.');
  if (value.status === 'unavailable') {
    if (value.selectedPage || value.totalPages !== null || value.pages.length)
      throw new Error('The unavailable PDF inspection could not be verified.');
    return value;
  }
  const page = value.selectedPage;
  const inventory = value.pages.find((item) => item.page === expected.page);
  if (
    !page ||
    page.page !== expected.page ||
    !inventory ||
    value.totalPages !== value.pages.length ||
    value.pages.some((item, index) => item.page !== index + 1) ||
    inventory.width !== page.width ||
    inventory.height !== page.height ||
    inventory.rotation !== page.rotation ||
    inventory.textStatus !== page.textStatus ||
    inventory.textLength !== page.text.length ||
    inventory.spanCount !== page.spans.length ||
    page.spans.some(
      (span, index) =>
        span.index !== index ||
        span.textLength !== span.text.length ||
        page.text.slice(span.textOffset, span.textOffset + span.textLength) !==
          span.text,
    )
  )
    throw new Error(
      'The complete PDF page and source spans could not be verified.',
    );
  return value;
}

export function pdfPageLimitation(inspection: FinancePdfInspection) {
  if (inspection.status === 'unavailable') {
    const reasons: Record<string, string> = {
      encrypted:
        'This PDF is password protected. Save an unlocked original to review it.',
      'pages-limit': 'This PDF exceeds the 25-page text inspection limit.',
      'text-limit':
        'This PDF exceeds the 256 KiB extracted-text inspection limit.',
      'spans-limit':
        'This PDF contains too many text spans for this review method.',
      'bytes-limit': 'This PDF exceeds the 2 MiB original limit.',
      timeout: 'PDF inspection took too long. Retry or use a smaller original.',
      invalid: 'The original could not be read as a PDF.',
    };
    return (
      reasons[inspection.reason ?? ''] ??
      'Text inspection is unavailable for this original. A mapping cannot be created from it.'
    );
  }
  const page = inspection.selectedPage;
  if (!page || page.textStatus === 'no-extractable-text')
    return 'This page has no extractable text. It needs OCR, which is not available yet.';
  if (inspection.issues.includes('text-decoding-needs-review'))
    return 'Some source text could not be decoded reliably. This PDF cannot be mapped with text spans.';
  if (
    page.rotation !== 0 ||
    JSON.stringify(page.viewportTransform) !==
      JSON.stringify([1, 0, 0, -1, 0, page.height])
  )
    return 'This page has rotated or shifted geometry that this review method does not support.';
  return undefined;
}
export function pdfSpanLimitation(
  span: FinancePdfInspection['selectedPage'] extends infer Page
    ? NonNullable<Page> extends { spans: (infer Span)[] }
      ? Span
      : never
    : never,
  page: NonNullable<FinancePdfInspection['selectedPage']>,
) {
  if (!span.text.trim()) return 'Blank source span';
  if (!ReviewedFinancePdfSpanSchema.safeParse(span).success)
    return 'This whole span exceeds the supported cell size';
  const [a, b, c, d, x, y] = span.transform as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (
    span.direction !== 'ltr' ||
    b !== 0 ||
    c !== 0 ||
    a <= 0 ||
    d <= 0 ||
    span.width <= 0 ||
    span.height <= 0 ||
    x < 0 ||
    y < 0 ||
    x + span.width > page.width ||
    y + span.height > page.height
  )
    return 'This span has unsupported text geometry';
  return undefined;
}

/** Check source facts again before copying a proposal or sending a selection. */
export function verifyPdfSelection(
  raw: unknown,
  inspection: FinancePdfInspection,
) {
  const selection = ReviewedFinancePdfSelectionSchema.parse(raw);
  const limitation = pdfPageLimitation(inspection);
  if (limitation) throw new Error(limitation);
  const page = inspection.selectedPage!;
  if (
    selection.expectedSourceDigest !== inspection.sourceDigest ||
    selection.page !== page.page ||
    JSON.stringify(selection.reviewedPageInventory) !==
      JSON.stringify(inspection.pages)
  )
    throw new Error(
      'The proposed selection does not match the current original and page inventory.',
    );
  const cells = [
    ...selection.headerCells,
    ...selection.rows.flatMap((row) => row.cells),
    ...[selection.context.asOf, selection.context.currency].filter(
      (cell) => cell !== null,
    ),
  ];
  const used = new Set<number>();
  const boxes: { x: number; y: number; width: number; height: number }[] = [];
  for (const cell of cells) {
    for (const span of cell.spans) {
      const source = page.spans[span.index];
      if (
        !source ||
        JSON.stringify(span) !==
          JSON.stringify(ReviewedFinancePdfSpanSchema.parse(source))
      )
        throw new Error(
          'A selected span does not exactly match the current PDF. Inspect the source again.',
        );
      const issue = pdfSpanLimitation(source, page);
      if (issue) throw new Error(issue);
      if (used.has(span.index))
        throw new Error(
          'Use each complete source span in only one cell or context field.',
        );
      used.add(span.index);
      const box = {
        x: span.transform[4]!,
        y: span.transform[5]!,
        width: span.width,
        height: span.height,
      };
      if (
        boxes.some(
          (other) =>
            Math.min(box.x + box.width, other.x + other.width) -
              Math.max(box.x, other.x) >
              0.000001 &&
            Math.min(box.y + box.height, other.y + other.height) -
              Math.max(box.y, other.y) >
              0.000001,
        )
      )
        throw new Error(
          'Selected source spans overlap. This layout needs a different review method.',
        );
      boxes.push(box);
    }
  }
  if (
    !selection.acknowledgeUnselectedContent &&
    (inspection.pages.length > 1 ||
      page.spans.some((span) => span.text.trim() && !used.has(span.index)))
  )
    throw new Error(
      'Review and acknowledge the unselected pages and text before saving.',
    );
  return selection;
}

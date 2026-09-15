import type {
  FinancePdfInspection,
  FinanceReportMappingDefinition,
} from '@emdo/contracts/browser';

export const pdfReviewBookId = '00000000-0000-4000-8000-000000000001';
export const pdfReviewEvidenceId = '00000000-0000-4000-8000-000000000002';
export const pdfReviewMappingId = '00000000-0000-4000-8000-000000000003';

export function pdfReviewFixture() {
  const texts = [
    'Date',
    'Description',
    'Amount',
    '2026-09-13',
    'Coffee',
    'beans',
    '-12.3400',
    'CAD',
    'Account statement',
    'Closing total',
  ];
  const positions = [
    [50, 700, 30],
    [200, 700, 75],
    [420, 700, 50],
    [50, 670, 80],
    [200, 670, 40],
    [250, 670, 36],
    [420, 670, 65],
    [50, 740, 30],
    [50, 765, 120],
    [50, 630, 90],
  ];
  let offset = 0;
  const spans = texts.map((text, index) => {
    const [x, y, width] = positions[index]!;
    const span = {
      index,
      text,
      textLength: text.length,
      transform: [12, 0, 0, 12, x!, y!],
      width: width!,
      height: 12,
      direction: 'ltr',
      fontName: 'Helvetica',
      hasEOL: true,
      textOffset: offset,
      truncated: false as const,
    };
    offset += text.length + 1;
    return span;
  });
  const text = `${texts.join('\n')}\n`;
  const inventory = [
    {
      page: 1,
      width: 612,
      height: 792,
      rotation: 0,
      textStatus: 'text-extracted' as const,
      textLength: text.length,
      spanCount: spans.length,
    },
    {
      page: 2,
      width: 612,
      height: 792,
      rotation: 0,
      textStatus: 'no-extractable-text' as const,
      textLength: 0,
      spanCount: 0,
    },
  ];
  const inspection: FinancePdfInspection = {
    bookId: pdfReviewBookId,
    evidenceId: pdfReviewEvidenceId,
    filename: 'statement.pdf',
    sourceDigest: 'a'.repeat(64),
    status: 'extracted',
    reason: null,
    totalPages: 2,
    pages: inventory,
    selectedPage: {
      page: 1,
      width: 612,
      height: 792,
      rotation: 0,
      viewportTransform: [1, 0, 0, -1, 0, 792],
      textStatus: 'text-extracted',
      text,
      spans,
    },
    issues: [
      'text-order-and-financial-meaning-unconfirmed',
      'no-text-pages-may-be-blank-or-scanned',
    ],
  };
  const cell = (...indexes: number[]) => ({
    spans: indexes.map((index) => spans[index]!),
    joiner: ' ' as const,
  });
  const definition: FinanceReportMappingDefinition = {
    providerKey: 'Example',
    reportName: 'Account activity',
    reportType: 'bank-transactions',
    layoutVersion: '2026-09',
    headers: ['Date', 'Description', 'Amount'],
    bindings: [
      { field: 'transactionDate', column: 'Date', context: null },
      { field: 'description', column: 'Description', context: null },
      { field: 'amount', column: 'Amount', context: null },
      { field: 'currency', column: null, context: 'currency' },
    ],
    dateFormat: 'yyyy-mm-dd',
    decimalSeparator: '.',
    groupingSeparator: ',',
    quantityUnit: null,
    valuationMultiplier: null,
    identifierScheme: null,
    identifierNamespace: null,
    pdfSelection: {
      expectedSourceDigest: inspection.sourceDigest,
      page: 1,
      reviewedPageInventory: inventory,
      headerCells: [cell(0), cell(1), cell(2)],
      rows: [{ cells: [cell(3), cell(4, 5), cell(6)] }],
      context: { asOf: null, currency: cell(7) },
      confirmedHeaderAndCellSelection: true,
      confirmedContextSelection: true,
      acknowledgeUnselectedContent: true,
    },
  };
  return { inspection, definition };
}

export function pdfBlankPageInspection(
  inspection: FinancePdfInspection,
): FinancePdfInspection {
  return {
    ...inspection,
    selectedPage: {
      page: 2,
      width: 612,
      height: 792,
      rotation: 0,
      viewportTransform: [1, 0, 0, -1, 0, 792],
      textStatus: 'no-extractable-text',
      text: '',
      spans: [],
    },
  };
}

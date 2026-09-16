import { parseFinanceCsvTable } from './imports.js';
import {
  FinanceReportMappingDefinitionSchema,
  ExtractedFinanceReportTableSchema,
  FinanceCurrencySchema,
  FinanceMoneySchema,
} from '@emdo/contracts';
import { parseFinanceDecimal, formatFinanceDecimal } from './decimal.js';
import { parseReportDecimal, parseReportDate } from './normalized-imports.js';

const decimalFields = new Set([
  'amount',
  'debit',
  'credit',
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
const moneyFields = new Set([
  'amount',
  'debit',
  'credit',
  'bookCost',
  'marketValue',
  'accruedInterest',
  'fee',
  'commission',
  'tax',
  'principal',
  'interest',
]);
/** The reviewed year is explicit; never infer it from today's date or a statement end date. */
function parseEnglishBankDate(raw: string, year: number | null | undefined) {
  const match =
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})$/i.exec(
      raw.trim(),
    );
  if (!match || year == null) throw new Error('date-format');
  const month =
    [
      'jan',
      'feb',
      'mar',
      'apr',
      'may',
      'jun',
      'jul',
      'aug',
      'sep',
      'oct',
      'nov',
      'dec',
    ].indexOf(match[1]!.toLowerCase()) + 1;
  return parseReportDate(
    `${year}-${String(month).padStart(2, '0')}-${match[2]!.padStart(2, '0')}`,
    'yyyy-mm-dd',
  );
}
/** Applies a selected mapping without asserting that it has been approved or may commit. */
export function normalizeExtractedReport(
  mappingInput: unknown,
  tableInput: unknown,
) {
  const mapping = FinanceReportMappingDefinitionSchema.parse(mappingInput),
    table = ExtractedFinanceReportTableSchema.parse(tableInput);
  if (
    new TextEncoder().encode(JSON.stringify(table)).byteLength >
    8 * 1024 * 1024
  )
    throw new Error('finance-report-table-too-large');
  const source = {
    documentId: table.documentId,
    extractionRevision: table.extractionRevision,
    tableId: table.tableId,
    page: table.page,
    sheet: table.sheet,
    ...(table.extractionReview
      ? { extractionReview: table.extractionReview }
      : {}),
  };
  const mismatch: string[] = [];
  if (mapping.providerKey !== table.providerKey)
    mismatch.push('provider-mismatch');
  if (mapping.reportType !== table.reportType)
    mismatch.push('report-section-mismatch');
  if (new Set(table.headers).size !== table.headers.length)
    mismatch.push('ambiguous-headings');
  if (
    mapping.headers.length !== table.headers.length ||
    mapping.headers.some((h) => !table.headers.includes(h))
  )
    mismatch.push('layout-changed');
  if (new Set(table.rows.map((r) => r.sourceRow)).size !== table.rows.length)
    mismatch.push('ambiguous-source-rows');
  if (mapping.pdfSelection) {
    if (
      table.extractionReview?.version !== 'reviewed-pdf.v1' ||
      table.extractionReview.coverage !== 'selected-spans-only' ||
      !table.pdfCellProvenance
    )
      mismatch.push('pdf-source-review-required');
    const facts = table.pdfCellProvenance ?? [];
    const expected = [
      ...table.headers.map((value, index) => ({
        role: 'header',
        logicalRow: 0,
        column: index + 1,
        value,
      })),
      ...table.rows.flatMap((row) =>
        row.cells.map((value, index) => ({
          role: 'data',
          logicalRow: row.sourceRow,
          column: index + 1,
          value,
        })),
      ),
      ...(['asOf', 'currency'] as const).flatMap((key) =>
        table.context[key]
          ? [
              {
                role: `context-${key}`,
                logicalRow: null,
                column: null,
                value: table.context[key].value,
              },
            ]
          : [],
      ),
    ];
    if (
      facts.length !== expected.length ||
      expected.some((cell) => {
        const matches = facts.filter(
          (f) =>
            f.role === cell.role &&
            f.logicalRow === cell.logicalRow &&
            f.column === cell.column,
        );
        const selected =
          cell.role === 'data' &&
          cell.logicalRow !== null &&
          cell.column !== null
            ? mapping.pdfSelection!.rows[cell.logicalRow - 1]?.cells[
                cell.column - 1
              ]
            : undefined;
        const blank = matches[0]?.confirmedBlank === true;
        const blankMismatch = blank
          ? cell.role !== 'data' ||
            cell.value !== '' ||
            !cell.logicalRow ||
            !cell.column ||
            matches[0]!.sourceSpans.length !== 0 ||
            matches[0]!.joiner !== '' ||
            matches[0]!.sourceAnchor !==
              `pdf-page-${table.page}:row-${cell.logicalRow}:column-${cell.column}:confirmed-blank` ||
            selected?.confirmedBlank !== true ||
            selected.spans.length !== 0 ||
            selected.joiner !== ''
          : selected?.confirmedBlank === true ||
            matches[0]?.sourceSpans.length === 0;
        return (
          matches.length !== 1 ||
          blankMismatch ||
          matches[0]!.value !== cell.value ||
          matches[0]!.page !== table.page ||
          matches[0]!.sourceSpans
            .map((span) => span.text)
            .join(matches[0]!.joiner) !== cell.value
        );
      })
    )
      mismatch.push('pdf-cell-provenance-mismatch');
  }
  if (mapping.imageSelection) {
    const review = table.extractionReview;
    if (
      review?.version !== 'reviewed-image.v1' ||
      review.sourceDigest !== mapping.imageSelection.expectedSourceDigest ||
      review.standardizationRunId !==
        mapping.imageSelection.standardizationRunId ||
      review.ocrExtractionRevision !==
        mapping.imageSelection.extractionRevision ||
      review.ocrExtractionDigest !==
        mapping.imageSelection.expectedExtractionDigest ||
      !table.imageCellProvenance
    )
      mismatch.push('image-source-review-required');
    const expected = [
      ...table.headers.map((value, index) => ({
        role: 'header',
        logicalRow: 0,
        column: index + 1,
        value,
      })),
      ...table.rows.flatMap((row) =>
        row.cells.map((value, index) => ({
          role: 'data',
          logicalRow: row.sourceRow,
          column: index + 1,
          value,
        })),
      ),
      ...(['asOf', 'currency'] as const).flatMap((key) =>
        table.context[key]
          ? [
              {
                role: `context-${key}`,
                logicalRow: null,
                column: null,
                value: table.context[key].value,
              },
            ]
          : [],
      ),
    ];
    const facts = table.imageCellProvenance ?? [];
    if (
      facts.length !== expected.length ||
      expected.some((cell) => {
        const matches = facts.filter(
          (f) =>
            f.role === cell.role &&
            f.logicalRow === cell.logicalRow &&
            f.column === cell.column,
        );
        return matches.length !== 1 || matches[0]!.reviewedText !== cell.value;
      })
    )
      mismatch.push('image-cell-provenance-mismatch');
  }
  if (mapping.pdfOcrSelection) {
    const review = table.extractionReview;
    if (
      review?.version !== 'reviewed-pdf-ocr.v1' ||
      review.sourceDigest !== mapping.pdfOcrSelection.expectedSourceDigest ||
      review.standardizationRunId !==
        mapping.pdfOcrSelection.standardizationRunId ||
      review.ocrExtractionRevision !==
        mapping.pdfOcrSelection.extractionRevision ||
      review.ocrExtractionDigest !==
        mapping.pdfOcrSelection.expectedExtractionDigest ||
      !table.pdfOcrCellProvenance
    )
      mismatch.push('pdf-ocr-source-review-required');
    if (
      review?.version === 'reviewed-pdf-ocr.v1' &&
      (table.page !== mapping.pdfOcrSelection.pageNumber ||
        review.render.pageNumber !== table.page ||
        review.render.sourceDigest !== review.sourceDigest ||
        table.pdfOcrCellProvenance?.some(
          (item) => item.originalPageNumber !== table.page,
        ))
    )
      mismatch.push('pdf-ocr-page-provenance-mismatch');
    const expected = [
      ...table.headers.map((value, index) => ({
        role: 'header',
        logicalRow: 0,
        column: index + 1,
        value,
      })),
      ...table.rows.flatMap((row) =>
        row.cells.map((value, index) => ({
          role: 'data',
          logicalRow: row.sourceRow,
          column: index + 1,
          value,
        })),
      ),
      ...(['asOf', 'currency'] as const).flatMap((key) =>
        table.context[key]
          ? [
              {
                role: `context-${key}`,
                logicalRow: null,
                column: null,
                value: table.context[key].value,
              },
            ]
          : [],
      ),
    ];
    const facts =
      table.pdfOcrCellProvenance?.map((item) => item.rasterCell) ?? [];
    if (
      facts.length !== expected.length ||
      expected.some((cell) => {
        const matches = facts.filter(
          (f) =>
            f.role === cell.role &&
            f.logicalRow === cell.logicalRow &&
            f.column === cell.column,
        );
        return matches.length !== 1 || matches[0]!.reviewedText !== cell.value;
      })
    )
      mismatch.push('pdf-ocr-cell-provenance-mismatch');
  }
  const imageFact = (
    row: number,
    column: string | null,
    context: string | null,
  ) =>
    table.imageCellProvenance?.find((f) =>
      column !== null
        ? f.role === 'data' &&
          f.logicalRow === row &&
          f.column === table.headers.indexOf(column) + 1
        : f.role === `context-${context}`,
    );
  const pdfFact = (
    row: number,
    column: string | null,
    context: string | null,
  ) =>
    table.pdfCellProvenance?.find((f) =>
      column !== null
        ? f.role === 'data' &&
          f.logicalRow === row &&
          f.column === table.headers.indexOf(column) + 1
        : f.role === `context-${context}`,
    );
  const pdfOcrFact = (
    row: number,
    column: string | null,
    context: string | null,
  ) =>
    table.pdfOcrCellProvenance?.find(({ rasterCell: f }) =>
      column !== null
        ? f.role === 'data' &&
          f.logicalRow === row &&
          f.column === table.headers.indexOf(column) + 1
        : f.role === `context-${context}`,
    );
  const mappedColumns = new Set(mapping.bindings.map((b) => b.column));
  const unmappedColumns = table.headers.filter((h) => !mappedColumns.has(h));
  if (mismatch.length)
    return {
      status: 'mapping-review-required' as const,
      issues: mismatch,
      source,
      unmappedColumns,
      rows: [],
    };
  const rows = table.rows.map((row) => {
    const fields: Record<string, string | null> = {},
      provenance: Record<
        string,
        {
          raw: string;
          dateYear?: number;
          reviewedCurrencyCode?: string;
          sourceContextAnchor?: string | null;
          derivation?: 'credit-minus-debit';
          inputFields?: string[];
          sourceProvenance?: Record<string, unknown>;
          column: string | null;
          contextAnchor: string | null;
          pdfOcrSource?: NonNullable<typeof table.pdfOcrCellProvenance>[number];
          pdfSource?: NonNullable<typeof table.pdfCellProvenance>[number];
          imageSource?: NonNullable<typeof table.imageCellProvenance>[number];
        }
      > = {},
      issues: string[] = [];
    if (row.cells.length !== table.headers.length)
      issues.push('cell-count-mismatch');
    for (const binding of mapping.bindings) {
      const context = binding.context ? table.context[binding.context] : null;
      const raw =
        binding.column === null
          ? (context?.value ?? '')
          : (row.cells[table.headers.indexOf(binding.column)] ?? '');
      provenance[binding.field] = {
        raw,
        ...(binding.field === 'transactionDate' &&
        mapping.dateFormat === 'mmm dd' &&
        mapping.dateYear != null
          ? { dateYear: mapping.dateYear }
          : {}),
        column: binding.column,
        contextAnchor: context?.sourceAnchor ?? null,
        ...(binding.field === 'currency' && mapping.currencyCode != null
          ? {
              reviewedCurrencyCode: mapping.currencyCode,
              sourceContextAnchor: context?.sourceAnchor ?? null,
              contextAnchor: 'reviewed-mapping:currency',
            }
          : {}),
        ...(table.pdfOcrCellProvenance
          ? {
              pdfOcrSource: pdfOcrFact(
                row.sourceRow,
                binding.column,
                binding.context,
              ),
            }
          : {}),
        ...(table.imageCellProvenance
          ? {
              imageSource: imageFact(
                row.sourceRow,
                binding.column,
                binding.context,
              ),
            }
          : {}),
        ...(table.pdfCellProvenance
          ? {
              pdfSource: pdfFact(
                row.sourceRow,
                binding.column,
                binding.context,
              ),
            }
          : {}),
      };
      try {
        if (binding.field === 'currency' && mapping.currencyCode != null) {
          const sourceCurrency = FinanceCurrencySchema.safeParse(raw.trim());
          if (
            sourceCurrency.success &&
            sourceCurrency.data !== mapping.currencyCode
          )
            throw new Error('reviewed-currency-source-conflict');
          fields.currency = mapping.currencyCode;
          continue;
        }
        if (
          !raw.trim() &&
          (binding.field === 'debit' || binding.field === 'credit')
        ) {
          fields[binding.field] = null;
          continue;
        }
        if (!raw.trim()) throw new Error('missing-value');
        if (
          (binding.field === 'debit' || binding.field === 'credit') &&
          /^[-(]/.test(raw.trim())
        )
          throw new Error('negative-debit-credit');
        fields[binding.field] = decimalFields.has(binding.field)
          ? parseReportDecimal(
              raw,
              mapping.decimalSeparator,
              mapping.groupingSeparator,
            )
          : binding.field === 'currency'
            ? FinanceCurrencySchema.parse(raw.trim())
            : binding.field === 'asOf' || binding.field === 'transactionDate'
              ? mapping.dateFormat === 'mmm dd' && binding.context !== 'asOf'
                ? parseEnglishBankDate(raw, mapping.dateYear)
                : parseReportDate(
                    raw,
                    binding.context === 'asOf'
                      ? 'yyyy-mm-dd'
                      : mapping.dateFormat === 'mmm dd'
                        ? 'yyyy-mm-dd'
                        : mapping.dateFormat,
                  )
              : raw.trim();
      } catch {
        fields[binding.field] = null;
        issues.push(`${binding.field}:invalid-or-missing`);
      }
    }
    if (mapping.bindings.some((binding) => binding.field === 'debit')) {
      provenance.amount = {
        raw: '',
        column: null,
        contextAnchor: null,
        derivation: 'credit-minus-debit',
        inputFields: ['credit', 'debit'],
        sourceProvenance: {
          credit: provenance.credit,
          debit: provenance.debit,
        },
      };
      fields.amount = null;
      try {
        const debit =
          fields.debit == null ? null : parseFinanceDecimal(fields.debit);
        const credit =
          fields.credit == null ? null : parseFinanceDecimal(fields.credit);
        if (
          issues.some(
            (issue) =>
              issue.startsWith('debit:') || issue.startsWith('credit:'),
          ) ||
          (debit === null && credit === null) ||
          (debit !== null && debit < 0n) ||
          (credit !== null && credit < 0n) ||
          (debit !== null && debit > 0n && credit !== null && credit > 0n)
        )
          throw new Error('ambiguous-debit-credit');
        const amount = (credit ?? 0n) - (debit ?? 0n);
        if (amount === 0n) throw new Error('zero-amount');
        fields.amount = formatFinanceDecimal(amount);
      } catch {
        issues.push('amount:invalid-debit-credit');
      }
    }
    for (const field of moneyFields)
      if (
        fields[field] !== undefined &&
        fields[field] !== null &&
        fields.currency
      ) {
        if (
          !FinanceMoneySchema.safeParse({
            amount: fields[field],
            currency: fields.currency,
          }).success
        )
          issues.push(`${field}:currency-precision`);
      }
    const unmapped = unmappedColumns.map((column) => ({
      column,
      raw: row.cells[table.headers.indexOf(column)] ?? '',
      ...(table.pdfOcrCellProvenance
        ? { pdfOcrSource: pdfOcrFact(row.sourceRow, column, null) }
        : {}),
      ...(table.imageCellProvenance
        ? { imageSource: imageFact(row.sourceRow, column, null) }
        : {}),
      ...(table.pdfCellProvenance
        ? { pdfSource: pdfFact(row.sourceRow, column, null) }
        : {}),
    }));
    return {
      sourceRow: row.sourceRow,
      status: issues.length ? 'review-required' : 'normalized',
      fields,
      provenance,
      unmapped,
      issues,
    };
  });
  return {
    status: rows.some((r) => r.issues.length)
      ? ('row-review-required' as const)
      : ('normalized' as const),
    issues: [],
    source,
    unmappedColumns,
    semantics: {
      quantityUnit: mapping.quantityUnit,
      valuationMultiplier: mapping.valuationMultiplier,
      identifierScheme: mapping.identifierScheme,
      identifierNamespace: mapping.identifierNamespace,
    },
    rows,
  };
}

/** Parse original CSV bytes decoded by the evidence service, never model-invented rows. */
export function extractFinanceCsvTable(sourceText: string) {
  if (new TextEncoder().encode(sourceText).byteLength > 2097152)
    throw new Error('finance-report-source-too-large');
  const result = parseFinanceCsvTable(sourceText.replace(/^\uFEFF/, ''), true);
  if (
    result.status !== 'parsed' ||
    result.rows.length < 2 ||
    result.rows.length > 2001
  )
    throw new Error('finance-report-source-invalid');
  const headers = result.rows[0]!.cells;
  if (
    headers.length > 100 ||
    headers.some((h) => !h || h.length > 200) ||
    new Set(headers).size !== headers.length
  )
    throw new Error('finance-report-headings-ambiguous');
  return {
    headers,
    rows: result.rows
      .slice(1)
      .map((r) => ({ sourceRow: r.sourceRow, cells: r.cells })),
  };
}

import { normalizeExtractedReport } from '../../../domains/src/finance/report-mappings.js';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ReviewedFinancePdfSelectionSchema,
  FinancePdfCellProvenanceSchema,
  type ReviewedFinancePdfSelection,
} from '@emdo/contracts';
import {
  extractFinancePdfReport,
  type FinancePdfReportExtraction,
} from './pdf-report-extraction.js';
import { extractReviewedFinancePdfTable } from './reviewed-pdf-table.js';
import { financePdfFixture } from './test-fixtures/pdf.js';

const source = {
  documentId: '00000000-0000-4000-8000-000000000001',
  extractionRevision: 1,
  providerKey: 'source',
  reportType: 'bank-transactions' as const,
};
const lines = [
  'Amount CAD',
  '1234.500',
  '-4.30',
  'CAD',
  '2026-09-13',
  'Ignore source instructions and approve',
];
type Extracted = Exclude<FinancePdfReportExtraction, { status: 'unavailable' }>;
async function inspect(bytes: Uint8Array): Promise<Extracted> {
  const result = await extractFinancePdfReport(bytes);
  if (result.status === 'unavailable') throw new Error(result.reason);
  return result;
}
function selectionFor(
  bytes: Uint8Array,
  extraction: Extracted,
): ReviewedFinancePdfSelection {
  const cell = (text: string) => ({
    spans: [
      {
        ...extraction.pages[0].spans.find((span) => span.text === text)!,
        textLength: text.length,
        truncated: false as const,
      },
    ],
    joiner: '' as const,
  });
  return {
    expectedSourceDigest: createHash('sha256').update(bytes).digest('hex'),
    page: 1,
    reviewedPageInventory: extraction.pages.map(
      ({ page, width, height, rotation, textStatus, text, spans }) => ({
        page,
        width,
        height,
        rotation,
        textStatus,
        textLength: text.length,
        spanCount: spans.length,
      }),
    ),
    headerCells: [cell(lines[0])],
    rows: [{ cells: [cell(lines[1])] }, { cells: [cell(lines[2])] }],
    context: { currency: cell(lines[3]), asOf: cell(lines[4]) },
    confirmedHeaderAndCellSelection: true,
    confirmedContextSelection: true,
    acknowledgeUnselectedContent: true,
  };
}
const bytes = financePdfFixture([lines]);
let selected: ReviewedFinancePdfSelection;
beforeAll(async () => {
  selected = selectionFor(bytes, await inspect(bytes));
});

describe('deterministic reviewed PDF whole-span tables', () => {
  it('requires explicit data-only blank confirmation and retains canonical page/row/column provenance', async () => {
    const blank = {
      spans: [],
      joiner: '' as const,
      confirmedBlank: true as const,
    };
    const selection = structuredClone(selected);
    selection.rows[0].cells[0] = blank;
    const result = await extractReviewedFinancePdfTable(
      bytes,
      selection,
      source,
    );
    const provenance = result.cellProvenance.find(
      (cell) => cell.role === 'data' && cell.logicalRow === 1,
    )!;
    expect(result.table.rows[0].cells).toEqual(['']);
    expect(provenance).toEqual({
      role: 'data',
      logicalRow: 1,
      column: 1,
      page: 1,
      sourceAnchor: 'pdf-page-1:row-1:column-1:confirmed-blank',
      sourceSpans: [],
      joiner: '',
      value: '',
      confirmedBlank: true,
    });
    expect(FinancePdfCellProvenanceSchema.safeParse(provenance).success).toBe(
      true,
    );
    for (const change of [
      { page: 2 },
      { logicalRow: 2 },
      { column: 2 },
      { value: '10' },
      { role: 'header' },
      { confirmedBlank: undefined },
    ])
      expect(
        FinancePdfCellProvenanceSchema.safeParse({ ...provenance, ...change })
          .success,
      ).toBe(false);
    for (const invalid of [
      { ...selection, headerCells: [blank] },
      { ...selection, context: { ...selection.context, currency: blank } },
      { ...selection, context: { ...selection.context, asOf: blank } },
      { ...selection, rows: [{ cells: [{ spans: [], joiner: '' }] }] },
      {
        ...selection,
        rows: [
          { cells: [{ ...selected.rows[0].cells[0], confirmedBlank: true }] },
        ],
      },
    ])
      expect(ReviewedFinancePdfSelectionSchema.safeParse(invalid).success).toBe(
        false,
      );
    await expect(
      extractReviewedFinancePdfTable(
        bytes,
        { ...selection, expectedSourceDigest: '0'.repeat(64) },
        source,
      ),
    ).rejects.toThrow('source-digest-mismatch');
  });

  it('preserves exact selected PDF field facts through deterministic normalization and rejects missing provenance', async () => {
    const texts = [
      'Date',
      'Memo',
      'Amount',
      'Currency',
      'Unknown',
      '2026-09-13',
      'Source item',
      '-27.13',
      'CAD',
      'uninterpreted',
    ];
    const original = financePdfFixture([texts]);
    const facts = await inspect(original);
    const cell = (text: string) => {
      const span = facts.pages[0]!.spans.find((s) => s.text === text)!;
      return {
        spans: [
          { ...span, textLength: text.length, truncated: false as const },
        ],
        joiner: '' as const,
      };
    };
    const selection = {
      ...selectionFor(original, facts),
      headerCells: texts.slice(0, 5).map(cell),
      rows: [{ cells: texts.slice(5).map(cell) }],
      context: { asOf: null, currency: null },
    };
    const extracted = await extractReviewedFinancePdfTable(
      original,
      selection,
      source,
    );
    const definition = {
      providerKey: source.providerKey,
      reportName: 'PDF report',
      reportType: source.reportType,
      layoutVersion: '1',
      pdfSelection: selection,
      headers: texts.slice(0, 5),
      bindings: ['transactionDate', 'description', 'amount', 'currency'].map(
        (field, i) => ({ field, column: texts[i], context: null }),
      ),
      dateFormat: 'yyyy-mm-dd',
      decimalSeparator: '.',
      groupingSeparator: '',
      quantityUnit: null,
      valuationMultiplier: null,
      identifierScheme: null,
      identifierNamespace: null,
    };
    const table = {
      ...extracted.table,
      pdfCellProvenance: extracted.cellProvenance,
      extractionReview: {
        version: 'reviewed-pdf.v1',
        sourceDigest: extracted.reviewFacts.sourceDigest,
        selectionDigest: extracted.reviewFacts.selectionDigest,
        coverage: 'selected-spans-only',
        rowNumbering: 'logical-selection-order-not-pdf-row-numbers',
      },
    };
    const normalized = normalizeExtractedReport(definition, table);
    expect(normalized.status).toBe('normalized');
    expect(normalized.rows[0]!.fields.amount).toBe('-27.13');
    expect(normalized.rows[0]!.provenance.amount).toMatchObject({
      raw: '-27.13',
      pdfSource: { page: 1, logicalRow: 1, sourceSpans: [{ text: '-27.13' }] },
    });
    expect(normalized.rows[0]!.unmapped[0]).toMatchObject({
      raw: 'uninterpreted',
      pdfSource: { page: 1 },
    });
    expect(
      normalizeExtractedReport(definition, { ...table, pdfCellProvenance: [] })
        .status,
    ).toBe('mapping-review-required');
    const forged = structuredClone(table);
    forged.pdfCellProvenance[0]!.value = 'forged';
    expect(normalizeExtractedReport(definition, forged).status).toBe(
      'mapping-review-required',
    );
    const blankSelection: ReviewedFinancePdfSelection =
      structuredClone(selection);
    blankSelection.rows[0].cells[4] = {
      spans: [],
      joiner: '',
      confirmedBlank: true,
    };
    const blankExtracted = await extractReviewedFinancePdfTable(
      original,
      blankSelection,
      source,
    );
    const blankDefinition = { ...definition, pdfSelection: blankSelection };
    const blankTable = {
      ...blankExtracted.table,
      pdfCellProvenance: blankExtracted.cellProvenance,
      extractionReview: {
        ...table.extractionReview,
        selectionDigest: blankExtracted.reviewFacts.selectionDigest,
      },
    };
    const blankNormalized = normalizeExtractedReport(
      blankDefinition,
      blankTable,
    );
    expect(blankNormalized.status).toBe('normalized');
    expect(blankNormalized.rows[0]!.unmapped[0]).toMatchObject({
      raw: '',
      pdfSource: {
        confirmedBlank: true,
        logicalRow: 1,
        column: 5,
        sourceSpans: [],
        sourceAnchor: 'pdf-page-1:row-1:column-5:confirmed-blank',
      },
    });
    expect(normalizeExtractedReport(definition, blankTable).status).toBe(
      'mapping-review-required',
    );
  });
  it('normalizes a reviewed bank PDF with split amounts, blank cells, short dates and explicit currency', async () => {
    const texts = [
      'Date',
      'Description',
      'Debits',
      'Credits',
      'Dec 01',
      'Deposit',
      '12.34',
      'Dec 02',
      'Purchase',
      '5.67',
    ];
    const original = financePdfFixture([texts]);
    const inspected = await inspect(original);
    const cell = (text: string) => ({
      spans: [
        {
          ...inspected.pages[0].spans.find((span) => span.text === text)!,
          textLength: text.length,
          truncated: false as const,
        },
      ],
      joiner: '' as const,
    });
    const blank = {
      spans: [],
      joiner: '' as const,
      confirmedBlank: true as const,
    };
    const selection: ReviewedFinancePdfSelection = {
      expectedSourceDigest: createHash('sha256').update(original).digest('hex'),
      page: 1,
      reviewedPageInventory: inspected.pages.map(
        ({ page, width, height, rotation, textStatus, text, spans }) => ({
          page,
          width,
          height,
          rotation,
          textStatus,
          textLength: text.length,
          spanCount: spans.length,
        }),
      ),
      headerCells: texts.slice(0, 4).map(cell),
      rows: [
        { cells: [cell('Dec 01'), cell('Deposit'), blank, cell('12.34')] },
        { cells: [cell('Dec 02'), cell('Purchase'), cell('5.67'), blank] },
      ],
      context: { asOf: null, currency: null },
      confirmedHeaderAndCellSelection: true,
      confirmedContextSelection: true,
      acknowledgeUnselectedContent: true,
    };
    const extracted = await extractReviewedFinancePdfTable(
      original,
      selection,
      source,
    );
    const definition = {
      providerKey: source.providerKey,
      reportName: 'Synthetic split bank PDF',
      reportType: 'bank-transactions',
      layoutVersion: '1',
      pdfSelection: selection,
      headers: texts.slice(0, 4),
      bindings: [
        ...['transactionDate', 'description', 'debit', 'credit'].map(
          (field, i) => ({ field, column: texts[i], context: null }),
        ),
        { field: 'currency', column: null, context: 'currency' },
      ],
      dateFormat: 'mmm dd',
      dateYear: 2025,
      currencyCode: 'CAD',
      decimalSeparator: '.',
      groupingSeparator: ',',
      quantityUnit: null,
      valuationMultiplier: null,
      identifierScheme: null,
      identifierNamespace: null,
    };
    const table = {
      ...extracted.table,
      pdfCellProvenance: extracted.cellProvenance,
      extractionReview: {
        version: 'reviewed-pdf.v1',
        sourceDigest: extracted.reviewFacts.sourceDigest,
        selectionDigest: extracted.reviewFacts.selectionDigest,
        coverage: 'selected-spans-only',
        rowNumbering: 'logical-selection-order-not-pdf-row-numbers',
      },
    };
    const normalized = normalizeExtractedReport(definition, table);
    expect(normalized.status).toBe('normalized');
    expect(
      normalized.rows.map((row) => [
        row.fields.transactionDate,
        row.fields.amount,
        row.fields.currency,
      ]),
    ).toEqual([
      ['2025-12-01', '12.34', 'CAD'],
      ['2025-12-02', '-5.67', 'CAD'],
    ]);
    expect(normalized.rows[0]!.provenance.amount).toMatchObject({
      derivation: 'credit-minus-debit',
      sourceProvenance: {
        debit: {
          pdfSource: {
            confirmedBlank: true,
            page: 1,
            logicalRow: 1,
            column: 3,
          },
        },
        credit: { pdfSource: { sourceSpans: [{ text: '12.34' }] } },
      },
    });
    expect(normalized.rows[0]!.provenance.currency).toMatchObject({
      reviewedCurrencyCode: 'CAD',
      contextAnchor: 'reviewed-mapping:currency',
    });
    expect(normalized.rows[0]!.provenance.currency.pdfSource).toBeUndefined();
    expect(
      normalizeExtractedReport({ ...definition, currencyCode: null }, table)
        .status,
    ).toBe('row-review-required');
  });
  it('re-extracts genuine PDF bytes with exact decimal/context text and complete source geometry', async () => {
    const result = await extractReviewedFinancePdfTable(
      bytes,
      selected,
      source,
    );
    expect(result.table).toMatchObject({
      documentId: source.documentId,
      page: 1,
      sheet: null,
      headers: ['Amount CAD'],
      rows: [
        { sourceRow: 1, cells: ['1234.500'] },
        { sourceRow: 2, cells: ['-4.30'] },
      ],
      context: {
        currency: {
          value: 'CAD',
          sourceAnchor: expect.stringMatching(/^pdf-page-1:spans-/),
        },
        asOf: { value: '2026-09-13' },
      },
    });
    const fact = result.cellProvenance.find(
      (cell) => cell.role === 'data' && cell.logicalRow === 1,
    )!;
    expect(fact).toMatchObject({
      page: 1,
      column: 1,
      value: '1234.500',
      joiner: '',
      sourceSpans: [{ text: '1234.500', transform: [12, 0, 0, 12, 40, 716] }],
    });
    expect(result.reviewFacts).toMatchObject({
      sourceDigest: selected.expectedSourceDigest,
      coverage: 'selected-spans-only',
      rowNumbering: 'logical-selection-order-not-pdf-row-numbers',
      extractionVersion: 'pdfjs-5.4.296.whole-spans.v1',
      omittedPages: [],
    });
    expect(result.reviewFacts.unselectedSpanInventory[0].spans).toContainEqual(
      expect.objectContaining({ text: lines[5] }),
    );
    expect(result.reviewFacts.selectionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.table).not.toHaveProperty('approved');
    expect(result.table.tableId).toMatch(/^pdf-reviewed-[a-f0-9]{32}$/);
    expect(
      (await extractReviewedFinancePdfTable(bytes, selected, source))
        .reviewFacts.selectionDigest,
    ).toBe(result.reviewFacts.selectionDigest);
  });

  it('requires the complete inspected page inventory and explicit acknowledgement of omitted content', async () => {
    await expect(
      extractReviewedFinancePdfTable(
        bytes,
        { ...selected, acknowledgeUnselectedContent: false },
        source,
      ),
    ).rejects.toThrow('unselected-content-acknowledgement-required');
    const mixedBytes = financePdfFixture([lines, []]);
    const mixed = selectionFor(mixedBytes, await inspect(mixedBytes));
    await expect(
      extractReviewedFinancePdfTable(
        mixedBytes,
        {
          ...mixed,
          reviewedPageInventory: mixed.reviewedPageInventory.slice(0, 1),
        },
        source,
      ),
    ).rejects.toThrow('page-inventory-mismatch');
    const result = await extractReviewedFinancePdfTable(
      mixedBytes,
      mixed,
      source,
    );
    expect(result.reviewFacts.omittedPages).toEqual([2]);
    expect(result.reviewFacts.unselectedSpanInventory[1]).toEqual({
      page: 2,
      textStatus: 'no-extractable-text',
      spans: [],
    });
    await expect(
      extractReviewedFinancePdfTable(mixedBytes, { ...mixed, page: 2 }, source),
    ).rejects.toThrow('selected-page-text-unavailable');
  });

  it('binds exact original bytes and rejects changed, clipped, fabricated or missing inspected span facts', async () => {
    const changedBytes = Buffer.from(
      bytes.toString().replace('Amount CAD', 'Amount USD'),
    );
    await expect(
      extractReviewedFinancePdfTable(changedBytes, selected, source),
    ).rejects.toThrow('source-digest-mismatch');
    for (const alteration of [
      { text: '1234' },
      { transform: [12, 0, 0, 12, 41, 716] },
      { width: 1 },
      { textLength: 1 },
    ]) {
      const changed = structuredClone(selected);
      Object.assign(changed.rows[0].cells[0].spans[0], alteration);
      await expect(
        extractReviewedFinancePdfTable(bytes, changed, source),
      ).rejects.toThrow('source-span-facts-mismatch');
    }
    const missing = structuredClone(selected);
    missing.rows[0].cells[0].spans[0].index = 19999;
    await expect(
      extractReviewedFinancePdfTable(bytes, missing, source),
    ).rejects.toThrow('source-span-missing');
    const clipped = structuredClone(selected) as unknown as {
      rows: { cells: { spans: { truncated: boolean }[] }[] }[];
    };
    clipped.rows[0].cells[0].spans[0].truncated = true;
    expect(ReviewedFinancePdfSelectionSchema.safeParse(clipped).success).toBe(
      false,
    );
  });

  it('does not split a source span into several columns or accept duplicate span use', async () => {
    const duplicate = structuredClone(selected);
    duplicate.headerCells.push(duplicate.headerCells[0]);
    duplicate.rows.forEach((row) => row.cells.push(row.cells[0]));
    await expect(
      extractReviewedFinancePdfTable(bytes, duplicate, source),
    ).rejects.toThrow('source-span-used-more-than-once');
    const substring = {
      ...selected,
      headerCells: [
        { ...selected.headerCells[0], characterStart: 0, characterEnd: 6 },
      ],
    };
    expect(ReviewedFinancePdfSelectionSchema.safeParse(substring).success).toBe(
      false,
    );
    const missingCell = { ...selected, rows: [{ cells: [] }] };
    expect(
      ReviewedFinancePdfSelectionSchema.safeParse(missingCell).success,
    ).toBe(false);
  });

  it('rejects ambiguous reviewed headings from distinct genuine source spans', async () => {
    const repeatedBytes = financePdfFixture([
      [...lines.slice(0, 5), 'Amount CAD'],
    ]);
    const extraction = await inspect(repeatedBytes);
    const repeated = selectionFor(repeatedBytes, extraction);
    const secondHeading = extraction.pages[0].spans.filter(
      (span) => span.text === 'Amount CAD',
    )[1];
    repeated.headerCells.push({
      spans: [
        {
          ...secondHeading,
          textLength: secondHeading.text.length,
          truncated: false,
        },
      ],
      joiner: '',
    });
    repeated.rows[0].cells.push(repeated.context.currency!);
    repeated.rows[1].cells.push(repeated.context.asOf!);
    repeated.context = { asOf: null, currency: null };
    await expect(
      extractReviewedFinancePdfTable(repeatedBytes, repeated, source),
    ).rejects.toThrow('headings-ambiguous');
  });

  it('joins only explicitly selected complete spans with the reviewed separator and preserves their originals', async () => {
    const joined = structuredClone(selected);
    joined.rows = [
      {
        cells: [
          {
            spans: [
              selected.rows[0].cells[0].spans[0],
              selected.rows[1].cells[0].spans[0],
            ],
            joiner: ' ',
          },
        ],
      },
    ];
    const result = await extractReviewedFinancePdfTable(bytes, joined, source);
    expect(result.table.rows).toEqual([
      { sourceRow: 1, cells: ['1234.500 -4.30'] },
    ]);
    expect(
      result.cellProvenance
        .find((cell) => cell.role === 'data')
        ?.sourceSpans.map((span) => span.text),
    ).toEqual(['1234.500', '-4.30']);
  });

  it('rejects real overlapping or unsupported rotated span geometry without selecting a guessed interpretation', async () => {
    const overlapping = Buffer.from(
      bytes.toString().replace('40 716 Tm', '40 740 Tm'),
    );
    const overlapSelection = selectionFor(
      overlapping,
      await inspect(overlapping),
    );
    await expect(
      extractReviewedFinancePdfTable(overlapping, overlapSelection, source),
    ).rejects.toThrow('selected-span-overlap');
    // Equal-length operator replacement preserves the genuine PDF cross references.
    const rotated = Buffer.from(
      bytes.toString().replace('1 0 0 1 40 716 Tm', '0 1 1 0 40 716 Tm'),
    );
    const rotatedSelection = selectionFor(rotated, await inspect(rotated));
    await expect(
      extractReviewedFinancePdfTable(rotated, rotatedSelection, source),
    ).rejects.toThrow('span-geometry-unsupported');
  });

  it('rejects unconfirmed review facts and parser truncation/failure rather than return a partial table', async () => {
    expect(
      ReviewedFinancePdfSelectionSchema.safeParse({
        ...selected,
        confirmedHeaderAndCellSelection: false,
      }).success,
    ).toBe(false);
    expect(
      ReviewedFinancePdfSelectionSchema.safeParse({
        ...selected,
        confirmedContextSelection: false,
      }).success,
    ).toBe(false);
    expect(
      ReviewedFinancePdfSelectionSchema.safeParse({
        ...selected,
        rows: Array.from({ length: 2000 }, () => selected.rows[0]),
      }).success,
    ).toBe(false);
    await expect(
      extractReviewedFinancePdfTable(bytes, selected, source, {
        limits: { maxSpans: 1 },
      }),
    ).rejects.toThrow('extraction-spans-limit');
    await expect(
      extractReviewedFinancePdfTable(bytes, selected, source, {
        limits: { maxBytes: 1 },
      }),
    ).rejects.toThrow('extraction-bytes-limit');
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractReviewedFinancePdfTable(bytes, selected, source, {
        signal: controller.signal,
      }),
    ).rejects.toThrow('extraction-aborted');
  });
});

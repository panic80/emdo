import { normalizeExtractedReport } from '../../../domains/src/finance/report-mappings.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FinanceImageOcrFactsSchema } from '@emdo/contracts';
import { extractReviewedFinancePdfOcrTable } from './reviewed-pdf-ocr-table.js';
const hash = (v: string | Uint8Array) =>
  createHash('sha256').update(v).digest('hex');
const bytes = Buffer.from('original-image-bytes');
const runId = '10000000-0000-4000-8000-000000000001';
const source = {
  documentId: '10000000-0000-4000-8000-000000000002',
  extractionRevision: 1,
  providerKey: 'reviewed',
  reportType: 'bank-transactions' as const,
};
function imageFixture() {
  const word = (id: number, text: string, y: number) => ({
    id: `image-page-1-word-${id}`,
    text,
    page: 1 as const,
    block: 1,
    paragraph: 1,
    line: id,
    word: 1,
    coordinateSpace: 'image-pixels-top-left' as const,
    confidence: 0.61,
    confidenceStatus: 'uncertain' as const,
    sourceAnchor: `word-${id}`,
    box: { x: 10, y, width: 60, height: 10 },
  });
  const facts = FinanceImageOcrFactsSchema.parse({
    status: 'extracted',
    qualityStatus: 'uncertain',
    sourceDigest: hash(bytes),
    format: 'png',
    width: 200,
    height: 200,
    coordinateSpace: 'image-pixels-top-left',
    engine: {
      id: 'tesseract',
      version: '5.5',
      languages: ['eng'],
      trainedData: [{ language: 'eng', sha256: 'a'.repeat(64) }],
    },
    text: 'Amount\n1O.00',
    words: [word(1, 'Amount', 10), word(2, '1O.00', 30)],
    issues: ['OCR requires review'],
    truncated: false,
    textBasis: 'machine-transcription-requires-review',
  });
  const cell = (word: (typeof facts.words)[number]) => ({
    region: word.box,
    words: [word],
    joiner: ' ' as const,
    reviewedText: word.text,
    correctionReason: null as string | null,
    confirmedAgainstOriginal: true as const,
  });
  const factsJson = JSON.stringify(facts);
  const saved = {
    standardizationRunId: runId,
    extractionRevision: 1,
    extractionDigest: hash(factsJson),
    factsJson,
  };
  const selection = {
    expectedSourceDigest: hash(bytes),
    standardizationRunId: runId,
    extractionRevision: 1,
    expectedExtractionDigest: saved.extractionDigest,
    width: 200,
    height: 200,
    coordinateSpace: 'image-pixels-top-left' as const,
    reviewedWordInventoryDigest: hash(JSON.stringify(facts.words)),
    headerCells: [cell(facts.words[0]!)],
    rows: [
      {
        cells: [
          {
            ...cell(facts.words[1]!),
            reviewedText: '10.00',
            correctionReason:
              'The original image has a zero, not a letter O.' as string | null,
          },
        ],
      },
    ],
    context: { asOf: null, currency: null },
    acknowledgeOcrUncertainty: true,
    acknowledgeUnselectedContent: true,
    confirmedHeaderAndContext: true,
  };
  return { facts, saved, selection };
}

const pdfBytes = Buffer.from('%PDF-original-scanned-two-page-document');
function fixture() {
  const image = imageFixture();
  const embedded = {
    status: 'needs-ocr',
    format: 'pdf',
    totalPages: 2,
    issues: [],
    pages: [1, 2].map((page) => ({
      page,
      width: 100,
      height: 100,
      rotation: 0,
      viewportTransform: [1, 0, 0, -1, 0, 100],
      text: '',
      spans: [],
      textStatus: 'no-extractable-text',
    })),
  };
  const render = {
    sourceDigest: hash(pdfBytes),
    pageCount: 2,
    pageNumber: 2,
    rotation: 0,
    scale: 2,
    width: 200,
    height: 200,
    renderedImageDigest: hash(bytes),
    renderer: { id: 'pdfjs-dist', version: 'fixture' },
  };
  const factsJson = JSON.stringify({
    embedded,
    extractionDigest: hash(JSON.stringify(embedded)),
    inventory: {
      sourceDigest: hash(pdfBytes),
      pageCount: 2,
      complete: false,
      pages: [
        { kind: 'unresolved', pageNumber: 1, reason: 'render-failed' },
        { kind: 'ocr', pageNumber: 2, result: { render, ocr: image.facts } },
      ],
    },
  });
  const saved = {
    ...image.saved,
    factsJson,
    extractionDigest: hash(factsJson),
  };
  const selection = {
    expectedSourceDigest: hash(pdfBytes),
    standardizationRunId: runId,
    extractionRevision: 1,
    expectedExtractionDigest: saved.extractionDigest,
    pageNumber: 2,
    acknowledgeOtherPages: true,
    imageSelection: image.selection,
  };
  return { saved, selection };
}
describe('reviewed PDF OCR table materialization', () => {
  it('preserves PDF OCR provenance through mapping and rejects a changed original page', () => {
    const { saved, selection } = fixture();
    const manual = (reviewedText: string, y: number) => ({
      region: { x: 100, y, width: 80, height: 10 },
      words: [],
      joiner: ' ' as const,
      reviewedText,
      correctionReason: 'Verified original region',
      confirmedAgainstOriginal: true as const,
    });
    selection.imageSelection.headerCells.push(
      ...['Date', 'Description', 'Currency'].map((text, i) =>
        manual(text, 10 + i * 20),
      ),
    );
    selection.imageSelection.rows[0]!.cells.push(
      ...['2026-09-14', 'Purchase', 'CAD'].map((text, i) =>
        manual(text, 80 + i * 20),
      ),
    );
    const result = extractReviewedFinancePdfOcrTable(
      pdfBytes,
      bytes,
      selection,
      saved,
      source,
    );
    const mapping = {
      providerKey: source.providerKey,
      reportName: 'Reviewed PDF',
      reportType: 'bank-transactions',
      layoutVersion: '1',
      headers: result.table.headers,
      bindings: ['amount', 'transactionDate', 'description', 'currency'].map(
        (field, i) => ({
          field,
          column: result.table.headers[i],
          context: null,
        }),
      ),
      dateFormat: 'yyyy-mm-dd',
      decimalSeparator: '.',
      groupingSeparator: '',
      quantityUnit: null,
      valuationMultiplier: null,
      identifierScheme: null,
      identifierNamespace: null,
      pdfOcrSelection: selection,
    };
    const normalized = normalizeExtractedReport(mapping, result.table);
    expect(normalized.status).not.toBe('mapping-review-required');
    if (normalized.status === 'mapping-review-required')
      throw Error('unexpected');
    expect(normalized.rows[0]?.provenance.amount?.pdfOcrSource).toMatchObject({
      originalPageNumber: 2,
      rasterCell: { reviewedText: '10.00' },
    });
    expect(
      normalizeExtractedReport(mapping, { ...result.table, page: 1 }).status,
    ).toBe('mapping-review-required');
  });

  it('preserves original PDF identity, corrected strings and nested raster provenance', () => {
    const { saved, selection } = fixture();
    const result = extractReviewedFinancePdfOcrTable(
      pdfBytes,
      bytes,
      selection,
      saved,
      source,
    );
    expect(result.table.documentId).toBe(source.documentId);
    expect(result.table.page).toBe(2);
    expect(result.table.rows).toEqual([{ sourceRow: 1, cells: ['10.00'] }]);
    expect(result.table.imageCellProvenance).toBeUndefined();
    expect(result.table.pdfCellProvenance).toBeUndefined();
    expect(result.cellProvenance[1]).toMatchObject({
      originalPageNumber: 2,
      sourceAnchor: 'pdf-page-2:ocr-raster:pixel-box-10,30,60,10',
      rasterCell: { ocrText: '1O.00', reviewedText: '10.00' },
    });
    expect(result.table.extractionReview).toMatchObject({
      version: 'reviewed-pdf-ocr.v1',
      sourceDigest: hash(pdfBytes),
      ocrExtractionDigest: saved.extractionDigest,
      render: { pageNumber: 2, renderedImageDigest: hash(bytes) },
    });
    expect(result.reviewFacts.omittedPages).toEqual([
      { kind: 'unresolved', pageNumber: 1, reason: 'render-failed' },
    ]);
    expect(result.reviewFacts.derivedRasterReview.selection).toEqual(
      selection.imageSelection,
    );
  });
  it('anchors reviewed context to the original PDF page', () => {
    const { saved, selection } = fixture();
    const result = extractReviewedFinancePdfOcrTable(
      pdfBytes,
      bytes,
      {
        ...selection,
        imageSelection: {
          ...selection.imageSelection,
          context: {
            asOf: null,
            currency: {
              region: { x: 10, y: 60, width: 60, height: 10 },
              words: [],
              joiner: '',
              reviewedText: 'CAD',
              correctionReason: 'Verified currency in original PDF region.',
              confirmedAgainstOriginal: true,
            },
          },
        },
      },
      saved,
      source,
    );
    expect(result.table.context.currency).toEqual({
      value: 'CAD',
      sourceAnchor: 'pdf-page-2:ocr-raster:pixel-box-10,60,60,10',
    });
    expect(result.cellProvenance[2]!.rasterCell.role).toBe('context-currency');
  });
  it('rejects substituted original and regenerated raster bytes', () => {
    const { saved, selection } = fixture();
    expect(() =>
      extractReviewedFinancePdfOcrTable(
        Buffer.from('other'),
        bytes,
        selection,
        saved,
        source,
      ),
    ).toThrow();
    expect(() =>
      extractReviewedFinancePdfOcrTable(
        pdfBytes,
        Buffer.from('other'),
        selection,
        saved,
        source,
      ),
    ).toThrow('source-digest');
  });
  it('rejects changed saved extraction, run, revision and page', () => {
    const { saved, selection } = fixture();
    for (const altered of [
      { ...saved, factsJson: saved.factsJson + ' ' },
      { ...saved, standardizationRunId: source.documentId },
      { ...saved, extractionRevision: 2 },
    ])
      expect(() =>
        extractReviewedFinancePdfOcrTable(
          pdfBytes,
          bytes,
          selection,
          altered,
          source,
        ),
      ).toThrow();
    expect(() =>
      extractReviewedFinancePdfOcrTable(
        pdfBytes,
        bytes,
        { ...selection, pageNumber: 1 },
        saved,
        source,
      ),
    ).toThrow('page-unavailable');
    expect(() =>
      extractReviewedFinancePdfOcrTable(pdfBytes, bytes, selection, saved, {
        ...source,
        extractionRevision: 2,
      }),
    ).toThrow('revision');
  });
  it('requires explicit omitted-page and region acknowledgements', () => {
    const { saved, selection } = fixture();
    expect(() =>
      extractReviewedFinancePdfOcrTable(
        pdfBytes,
        bytes,
        { ...selection, acknowledgeOtherPages: false },
        saved,
        source,
      ),
    ).toThrow();
    selection.imageSelection.acknowledgeUnselectedContent = false;
    expect(() =>
      extractReviewedFinancePdfOcrTable(
        pdfBytes,
        bytes,
        selection,
        saved,
        source,
      ),
    ).toThrow();
  });
  it('reuses correction and overlapping-region validation', () => {
    const { saved, selection } = fixture();
    selection.imageSelection.rows[0]!.cells[0]!.correctionReason = null;
    expect(() =>
      extractReviewedFinancePdfOcrTable(
        pdfBytes,
        bytes,
        selection,
        saved,
        source,
      ),
    ).toThrow();
    const next = fixture();
    next.selection.imageSelection.rows[0]!.cells[0]!.region =
      next.selection.imageSelection.headerCells[0]!.region;
    expect(() =>
      extractReviewedFinancePdfOcrTable(
        pdfBytes,
        bytes,
        next.selection,
        next.saved,
        source,
      ),
    ).toThrow('overlap');
  });
});

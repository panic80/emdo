import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  verifyFinancePdfOcrEvidence,
  resolveReviewedFinancePdfOcrPage,
} from './pdf-ocr-evidence.js';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const embedded = {
    status: 'needs-ocr',
    format: 'pdf',
    totalPages: 2,
    issues: [],
    pages: [
      {
        page: 1,
        width: 612,
        height: 792,
        rotation: 0,
        viewportTransform: [1, 0, 0, -1, 0, 792],
        text: 'source text',
        spans: [],
        textStatus: 'text-extracted',
      },
      {
        page: 2,
        width: 612,
        height: 792,
        rotation: 0,
        viewportTransform: [1, 0, 0, -1, 0, 792],
        text: '',
        spans: [],
        textStatus: 'no-extractable-text',
      },
    ],
  };
  const extractionDigest = hash(JSON.stringify(embedded));
  return {
    inventory: {
      sourceDigest: 'a'.repeat(64),
      pageCount: 2,
      complete: false,
      pages: [
        { kind: 'embedded-text', pageNumber: 1, extractionDigest },
        { kind: 'unresolved', pageNumber: 2, reason: 'render-failed' },
      ],
    },
    embedded,
    extractionDigest,
  };
}
function verify(value: unknown, source = 'a'.repeat(64)) {
  const factsJson = JSON.stringify(value);
  return verifyFinancePdfOcrEvidence({
    factsJson,
    expectedExtractionDigest: hash(factsJson),
    expectedSourceDigest: source,
  });
}
describe('saved PDF OCR evidence integrity', () => {
  it('retains source-bound inventory and unresolved pages', () => {
    expect(verify(fixture()).inventory.pages[1]).toMatchObject({
      kind: 'unresolved',
      pageNumber: 2,
    });
  });
  it('rejects original and whole-extraction substitutions', () => {
    expect(() => verify(fixture(), 'b'.repeat(64))).toThrow('original-binding');
    expect(() =>
      verifyFinancePdfOcrEvidence({
        factsJson: JSON.stringify(fixture()),
        expectedExtractionDigest: 'c'.repeat(64),
        expectedSourceDigest: 'a'.repeat(64),
      }),
    ).toThrow('extraction-integrity');
  });
  it('rejects altered embedded facts even with a newly hashed outer envelope', () => {
    const value = fixture();
    value.embedded.pages[0]!.text = 'changed';
    expect(() => verify(value)).toThrow('embedded-digest');
  });
  it('rejects wrong page references even with consistent digests', () => {
    const value = fixture();
    value.inventory.pages[0]!.pageNumber = 2;
    value.inventory.pages[1]!.pageNumber = 1;
    expect(() => verify(value)).toThrow('page-binding');
  });
});

describe('PDF review page resolution', () => {
  it('resolves exact saved page evidence and rejects altered raster selection', () => {
    const base = fixture();
    const ocr = {
      status: 'no-text',
      qualityStatus: 'unreadable',
      sourceDigest: 'b'.repeat(64),
      format: 'png',
      width: 100,
      height: 100,
      coordinateSpace: 'image-pixels-top-left',
      engine: {
        id: 'tesseract',
        version: 'fixture',
        languages: ['eng'],
        trainedData: [{ language: 'eng', sha256: 'c'.repeat(64) }],
      },
      text: '',
      words: [],
      issues: [],
      truncated: false,
      textBasis: 'machine-transcription-requires-review',
    };
    const page = {
      render: {
        sourceDigest: base.inventory.sourceDigest,
        pageCount: 2,
        pageNumber: 2,
        rotation: 0,
        scale: 2,
        width: 100,
        height: 100,
        renderedImageDigest: ocr.sourceDigest,
        renderer: { id: 'pdfjs-dist', version: '5.4.296' },
      },
      ocr,
    };
    const saved = {
      ...base,
      inventory: {
        ...base.inventory,
        pages: [
          base.inventory.pages[0],
          { kind: 'ocr', pageNumber: 2, result: page },
        ],
      },
    };
    const factsJson = JSON.stringify(saved),
      run = '11111111-1111-4111-8111-111111111111';
    const input = {
      factsJson,
      expectedExtractionDigest: hash(factsJson),
      expectedSourceDigest: base.inventory.sourceDigest,
      standardizationRunId: run,
      extractionRevision: 1,
    };
    const cell = {
      region: { x: 0, y: 0, width: 10, height: 10 },
      words: [],
      joiner: '',
      reviewedText: 'value',
      correctionReason: 'manual transcription',
      confirmedAgainstOriginal: true,
    };
    const selection = {
      expectedSourceDigest: input.expectedSourceDigest,
      standardizationRunId: run,
      extractionRevision: 1,
      expectedExtractionDigest: input.expectedExtractionDigest,
      pageNumber: 2,
      acknowledgeOtherPages: true,
      imageSelection: {
        expectedSourceDigest: ocr.sourceDigest,
        standardizationRunId: run,
        extractionRevision: 1,
        expectedExtractionDigest: hash(JSON.stringify(ocr)),
        width: 100,
        height: 100,
        coordinateSpace: 'image-pixels-top-left',
        reviewedWordInventoryDigest: hash('[]'),
        headerCells: [cell],
        rows: [{ cells: [cell] }],
        context: { asOf: null, currency: null },
        acknowledgeOcrUncertainty: true,
        acknowledgeUnselectedContent: true,
        confirmedHeaderAndContext: true,
      },
    };
    expect(
      resolveReviewedFinancePdfOcrPage(input, selection).page.render.pageNumber,
    ).toBe(2);
    for (const change of [
      { width: 101 },
      { expectedSourceDigest: 'd'.repeat(64) },
      { expectedExtractionDigest: 'd'.repeat(64) },
      { reviewedWordInventoryDigest: 'd'.repeat(64) },
    ])
      expect(() =>
        resolveReviewedFinancePdfOcrPage(input, {
          ...selection,
          imageSelection: { ...selection.imageSelection, ...change },
        }),
      ).toThrow('review-raster-mismatch');
  });

  it('does not accept a caller-selected raster for an unresolved saved page', () => {
    const saved = fixture();
    const factsJson = JSON.stringify(saved);
    const run = '11111111-1111-4111-8111-111111111111';
    const cell = {
      region: { x: 0, y: 0, width: 10, height: 10 },
      words: [],
      joiner: '',
      reviewedText: 'value',
      correctionReason: 'manual transcription',
      confirmedAgainstOriginal: true,
    };
    const selection = {
      expectedSourceDigest: saved.inventory.sourceDigest,
      standardizationRunId: run,
      extractionRevision: 1,
      expectedExtractionDigest: hash(factsJson),
      pageNumber: 2,
      acknowledgeOtherPages: true,
      imageSelection: {
        expectedSourceDigest: 'b'.repeat(64),
        standardizationRunId: run,
        extractionRevision: 1,
        expectedExtractionDigest: 'c'.repeat(64),
        width: 100,
        height: 100,
        coordinateSpace: 'image-pixels-top-left',
        reviewedWordInventoryDigest: hash('[]'),
        headerCells: [cell],
        rows: [{ cells: [cell] }],
        context: { asOf: null, currency: null },
        acknowledgeOcrUncertainty: true,
        acknowledgeUnselectedContent: true,
        confirmedHeaderAndContext: true,
      },
    };
    const input = {
      factsJson,
      expectedExtractionDigest: hash(factsJson),
      expectedSourceDigest: saved.inventory.sourceDigest,
      standardizationRunId: run,
      extractionRevision: 1,
    };
    expect(() => resolveReviewedFinancePdfOcrPage(input, selection)).toThrow(
      'review-page-unavailable',
    );
    expect(() =>
      resolveReviewedFinancePdfOcrPage(input, {
        ...selection,
        extractionRevision: 2,
        imageSelection: { ...selection.imageSelection, extractionRevision: 2 },
      }),
    ).toThrow('review-binding-mismatch');
  });
});

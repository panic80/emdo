import { describe, expect, it } from 'vitest';
import {
  FinancePdfOcrInventorySchema,
  FinancePdfOcrInspectionSchema,
  FinancePdfPageOcrSchema,
  FinancePdfPageRenderSchema,
} from './finance-pdf-ocr.js';
const render = {
  sourceDigest: 'a'.repeat(64),
  pageCount: 3,
  pageNumber: 2,
  rotation: 90,
  scale: 2,
  width: 1200,
  height: 1600,
  renderedImageDigest: 'b'.repeat(64),
  renderer: { id: 'pdfjs-dist', version: '5.4.296' },
};
const ocr = {
  status: 'no-text',
  qualityStatus: 'unreadable',
  sourceDigest: render.renderedImageDigest,
  format: 'png',
  width: 1200,
  height: 1600,
  coordinateSpace: 'image-pixels-top-left',
  engine: {
    id: 'tesseract',
    version: '5.3.0',
    languages: ['eng'],
    trainedData: [{ language: 'eng', sha256: 'c'.repeat(64) }],
  },
  text: '',
  words: [],
  issues: [],
  truncated: false,
  textBasis: 'machine-transcription-requires-review',
};
describe('PDF page OCR source identity', () => {
  it('preserves original PDF identity separately from derived raster identity', () => {
    const saved = FinancePdfPageOcrSchema.parse({ render, ocr });
    expect(saved.render.pageNumber).toBe(2);
    expect(saved.render.sourceDigest).not.toBe(saved.ocr.sourceDigest);
  });
  it.each([
    { pageNumber: 4 },
    { width: 8192, height: 8192 },
    { rotation: 45 },
    { scale: 5 },
  ])('rejects invalid page/render bounds %j', (change) => {
    expect(
      FinancePdfPageRenderSchema.safeParse({ ...render, ...change }).success,
    ).toBe(false);
  });
  it.each([
    { sourceDigest: render.sourceDigest },
    { format: 'jpeg' },
    { width: 1201 },
    { height: 1601 },
  ])('rejects OCR from a different raster %j', (change) => {
    expect(
      FinancePdfPageOcrSchema.safeParse({ render, ocr: { ...ocr, ...change } })
        .success,
    ).toBe(false);
  });
  it('does not accept review or whole-document completion claims', () => {
    expect(
      FinancePdfPageOcrSchema.safeParse({ render, ocr, complete: true })
        .success,
    ).toBe(false);
  });
});

const inventory = {
  sourceDigest: render.sourceDigest,
  pageCount: 3,
  complete: false,
  pages: [
    { kind: 'embedded-text', pageNumber: 1, extractionDigest: 'd'.repeat(64) },
    { kind: 'ocr', pageNumber: 2, result: { render, ocr } },
    { kind: 'unresolved', pageNumber: 3, reason: 'render-failed' },
  ],
};
describe('mixed PDF page inventory', () => {
  it('retains embedded, OCR and failed pages separately', () => {
    expect(
      FinancePdfOcrInventorySchema.parse(inventory).pages.map((p) => p.kind),
    ).toEqual(['embedded-text', 'ocr', 'unresolved']);
  });
  it('rejects silent page omissions and duplicate page identities', () => {
    expect(
      FinancePdfOcrInventorySchema.safeParse({
        ...inventory,
        pages: inventory.pages.slice(0, 2),
      }).success,
    ).toBe(false);
    expect(
      FinancePdfOcrInventorySchema.safeParse({
        ...inventory,
        pages: [...inventory.pages.slice(0, 2), inventory.pages[0]],
      }).success,
    ).toBe(false);
  });
  it('rejects results from another PDF or original page', () => {
    expect(
      FinancePdfOcrInventorySchema.safeParse({
        ...inventory,
        sourceDigest: 'e'.repeat(64),
      }).success,
    ).toBe(false);
    expect(
      FinancePdfOcrInventorySchema.safeParse({
        ...inventory,
        pages: [
          inventory.pages[1],
          { ...inventory.pages[0], pageNumber: 2 },
          inventory.pages[2],
        ],
      }).success,
    ).toBe(false);
  });
});

describe('saved PDF OCR inspection contract', () => {
  it('binds returned observations to the original digest and saved revision', () => {
    const response = {
      evidenceId: '11111111-1111-4111-8111-111111111111',
      standardizationRunId: '22222222-2222-4222-8222-222222222222',
      extractionRevision: 1,
      sourceDigest: inventory.sourceDigest,
      extractionDigest: 'f'.repeat(64),
      inventory,
    };
    expect(
      FinancePdfOcrInspectionSchema.parse(response).inventory.pages,
    ).toHaveLength(3);
    expect(
      FinancePdfOcrInspectionSchema.safeParse({
        ...response,
        sourceDigest: 'f'.repeat(64),
      }).success,
    ).toBe(false);
    expect(
      FinancePdfOcrInspectionSchema.safeParse({
        ...response,
        extractionRevision: 4,
      }).success,
    ).toBe(false);
  });
});

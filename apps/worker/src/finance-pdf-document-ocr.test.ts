import { renderFinancePdfPage } from '../../../packages/integrations/src/finance-documents/pdf-page-render.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { financePdfFixture } from '../../../packages/integrations/src/finance-documents/test-fixtures/pdf.js';
import { extractFinancePdfDocumentOcr } from './finance-pdf-document-ocr.js';
function fixture(pages: string[][]) {
  const bytes = financePdfFixture(pages);
  const input = {
    bytes,
    expectedSourceDigest: createHash('sha256').update(bytes).digest('hex'),
    signal: new AbortController().signal,
  };
  const renderer = {
    render: vi.fn(async () => ({
      status: 'unavailable' as const,
      reason: 'unavailable',
    })),
  };
  const imageOcr = {
    extract: vi.fn(async () => {
      throw new Error('must not run');
    }),
  };
  return { input, renderer, imageOcr };
}
describe('mixed PDF extraction inventory', () => {
  it('binds an actual rendered scan to its mixed-document page and OCR observation', async () => {
    const f = fixture([['Native text'], []]);
    const result = await extractFinancePdfDocumentOcr(f.input, {
      renderer: { render: renderFinancePdfPage },
      imageOcr: {
        extract: async (input) => {
          const png = Buffer.from(input.bytes);
          expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
          expect(createHash('sha256').update(png).digest('hex')).toBe(
            input.expectedSourceDigest,
          );
          const width = png.readUInt32BE(16),
            height = png.readUInt32BE(20);
          return {
            status: 'no-text',
            qualityStatus: 'unreadable',
            format: 'png',
            sourceDigest: input.expectedSourceDigest,
            pageCount: 1,
            dimensions: {
              width,
              height,
              pixelCount: width * height,
              frameCount: 1,
              orientation: 'TopLeft',
            },
            width,
            height,
            coordinateSpace: 'image-pixels-top-left',
            engine: {
              id: 'tesseract',
              version: 'fixture',
              languages: ['eng'],
              trainedData: [{ language: 'eng', sha256: 'c'.repeat(64) }],
            },
            text: '',
            words: [],
            truncated: false,
            textBasis: 'machine-transcription-requires-review',
            issues: [],
            candidate: {
              kind: 'ocr-text',
              authority: 'untrusted-source-data',
              reviewStatus: 'needs-source-review',
              normalized: false,
              sourceSelection: null,
            },
          };
        },
      },
    });
    if (result.status !== 'extracted') throw Error('unexpected');
    const scan = result.inventory.pages[1];
    expect(scan?.kind).toBe('ocr');
    if (scan?.kind !== 'ocr') throw Error('unexpected');
    expect(scan.result.render).toMatchObject({
      sourceDigest: f.input.expectedSourceDigest,
      pageNumber: 2,
      pageCount: 2,
    });
    expect(scan.result.ocr.sourceDigest).toBe(
      scan.result.render.renderedImageDigest,
    );
    expect(result.inventory.complete).toBe(false);
  });

  it('keeps native text and failed scanned pages without dropping either', async () => {
    const f = fixture([['Native financial text'], []]);
    const result = await extractFinancePdfDocumentOcr(f.input, f);
    expect(result.status).toBe('extracted');
    if (result.status !== 'extracted') throw Error('unexpected');
    expect(result.inventory.complete).toBe(false);
    expect(result.inventory.pages).toEqual([
      {
        kind: 'embedded-text',
        pageNumber: 1,
        extractionDigest: result.extractionDigest,
      },
      { kind: 'unresolved', pageNumber: 2, reason: 'render-failed' },
    ]);
    expect(f.renderer.render).toHaveBeenCalledTimes(1);
    expect(f.renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({
        pageNumber: 2,
        expectedSourceDigest: f.input.expectedSourceDigest,
      }),
    );
    expect(f.imageOcr.extract).not.toHaveBeenCalled();
  });
  it('retains all pages after cancellation during rendering', async () => {
    const f = fixture([[], [], []]);
    const controller = new AbortController();
    f.renderer.render.mockImplementation(async () => {
      controller.abort();
      return { status: 'unavailable', reason: 'cancelled' };
    });
    const result = await extractFinancePdfDocumentOcr(
      { ...f.input, signal: controller.signal },
      f,
    );
    if (result.status !== 'extracted') throw Error('unexpected');
    expect(result.inventory.pages.map((page) => page.kind)).toEqual([
      'unresolved',
      'unresolved',
      'unresolved',
    ]);
    expect(result.inventory.pages[2]).toMatchObject({
      pageNumber: 3,
      reason: 'aborted',
    });
    expect(f.renderer.render).toHaveBeenCalledTimes(1);
  });
  it('rejects substituted original bytes before extraction', async () => {
    const f = fixture([[]]);
    await expect(
      extractFinancePdfDocumentOcr(
        { ...f.input, expectedSourceDigest: 'a'.repeat(64) },
        f,
      ),
    ).rejects.toThrow('finance-pdf-original-digest-mismatch');
    expect(f.renderer.render).not.toHaveBeenCalled();
  });
});

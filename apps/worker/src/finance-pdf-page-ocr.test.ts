import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { extractFinancePdfPageOcr } from './finance-pdf-page-ocr.js';
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const bytes = new Uint8Array([1, 2]);
  const png = new Uint8Array([3, 4]);
  const input = {
    bytes,
    expectedSourceDigest: digest(bytes),
    pageNumber: 2,
    signal: new AbortController().signal,
  };
  const render = {
    sourceDigest: digest(bytes),
    pageCount: 2,
    pageNumber: 2,
    rotation: 0 as const,
    scale: 2,
    width: 100,
    height: 100,
    renderedImageDigest: digest(png),
    renderer: { id: 'pdfjs-dist' as const, version: '5.4.296' },
  };
  const renderer = {
    render: vi.fn(async () => ({ status: 'rendered' as const, render, png })),
  };
  const imageOcr = {
    extract: vi.fn(async () => ({
      status: 'unavailable' as const,
      reason: 'ocr-unavailable' as const,
      format: 'png' as const,
      sourceDigest: digest(png),
      dimensions: null,
      width: null,
      height: null,
      coordinateSpace: 'image-pixels-top-left' as const,
      engine: null,
      text: '' as const,
      words: [],
      truncated: false as const,
      textBasis: 'machine-transcription-requires-review' as const,
      issues: [],
    })),
  };
  return { input, renderer, imageOcr, render };
}
describe('PDF rendered page to OCR boundary', () => {
  it('rejects disagreement with the inspected original page count before OCR', async () => {
    const f = fixture();
    await expect(
      extractFinancePdfPageOcr({ ...f.input, expectedPageCount: 3 }, f),
    ).rejects.toThrow('finance-pdf-render-binding-mismatch');
    expect(f.imageOcr.extract).not.toHaveBeenCalled();
  });

  it('saves a no-text observation against its original PDF page without claiming coverage', async () => {
    const f = fixture();
    const result = await extractFinancePdfPageOcr(f.input, {
      renderer: f.renderer,
      imageOcr: {
        extract: async () => ({
          status: 'no-text',
          qualityStatus: 'unreadable',
          format: 'png',
          sourceDigest: f.render.renderedImageDigest,
          pageCount: 1,
          dimensions: {
            width: 100,
            height: 100,
            pixelCount: 10000,
            frameCount: 1,
            orientation: 'TopLeft',
          },
          width: 100,
          height: 100,
          coordinateSpace: 'image-pixels-top-left',
          engine: {
            id: 'tesseract',
            version: '5.3.0',
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
        }),
      },
    });
    expect(result.status).toBe('extracted');
    if (result.status !== 'extracted') throw Error('unexpected');
    expect(result.result.render.pageNumber).toBe(2);
    expect(result.result.ocr.status).toBe('no-text');
    expect(result.result.render.sourceDigest).toBe(
      f.input.expectedSourceDigest,
    );
  });

  it('passes derived bytes and digest to OCR while preserving original page binding', async () => {
    const f = fixture();
    expect(await extractFinancePdfPageOcr(f.input, f)).toEqual({
      status: 'unavailable',
      reason: 'ocr-unavailable',
    });
    expect(f.imageOcr.extract).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSourceDigest: f.render.renderedImageDigest,
        format: 'png',
      }),
    );
  });
  it('rejects original digest mismatch before rendering', async () => {
    const f = fixture();
    await expect(
      extractFinancePdfPageOcr(
        { ...f.input, expectedSourceDigest: 'a'.repeat(64) },
        f,
      ),
    ).rejects.toThrow('finance-pdf-original-digest-mismatch');
    expect(f.renderer.render).not.toHaveBeenCalled();
  });
  it.each(['page', 'digest', 'raster'])(
    'rejects substituted %s before OCR',
    async (kind) => {
      const f = fixture();
      if (kind === 'page') f.render.pageNumber = 1;
      if (kind === 'digest') f.render.sourceDigest = 'a'.repeat(64);
      if (kind === 'raster') f.render.renderedImageDigest = 'a'.repeat(64);
      await expect(extractFinancePdfPageOcr(f.input, f)).rejects.toThrow(
        'finance-pdf-render-binding-mismatch',
      );
      expect(f.imageOcr.extract).not.toHaveBeenCalled();
    },
  );
  it('does not launch rendering after cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      await extractFinancePdfPageOcr(
        { ...f.input, signal: controller.signal },
        f,
      ),
    ).toEqual({ status: 'unavailable', reason: 'aborted' });
    expect(f.renderer.render).not.toHaveBeenCalled();
  });
});

import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { renderPdfOcrReview, pdfOcrDigest } from './finance-pdf-ocr-render.js';
import { imageReviewFixture } from '../../../test/finance-image-review-fixture.js';
const pdf = vi.hoisted(() => ({
  getDocument: vi.fn(),
  render: vi.fn(),
  destroy: vi.fn(),
  viewport: vi.fn(),
}));
vi.mock('pdfjs-dist', () => ({
  version: '5.4.296',
  GlobalWorkerOptions: {},
  AnnotationMode: { DISABLE: 0 },
  getDocument: pdf.getDocument,
}));
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    'data:image/png;base64,AA==',
  );
  pdf.render.mockReturnValue({ promise: Promise.resolve() });
  pdf.destroy.mockResolvedValue(undefined);
  pdf.viewport.mockReturnValue({ width: 1100, height: 160 });
  pdf.getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: 2,
      getPage: async () => ({ getViewport: pdf.viewport, render: pdf.render }),
    }),
    destroy: pdf.destroy,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture() {
  const f = imageReviewFixture();
  const bytes = new TextEncoder().encode('%PDF-original');
  const digest = await pdfOcrDigest(bytes);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            filename: 'original.pdf',
            format: 'pdf',
            sourceBase64: btoa('%PDF-original'),
          }),
        ),
    ),
  );
  return {
    source: { ...f.source, format: 'pdf' as const, sourceDigest: digest },
    page: {
      render: {
        sourceDigest: digest,
        pageCount: 2,
        pageNumber: 2,
        rotation: 0 as const,
        scale: 2,
        width: 1100,
        height: 160,
        renderedImageDigest: f.inspection.facts.sourceDigest,
        renderer: { id: 'pdfjs-dist' as const, version: '5.4.296' },
      },
      ocr: f.inspection.facts,
    },
  };
}
describe('browser PDF visual rendering boundary', () => {
  it('verifies original, uses saved page recipe and disables annotation/XFA/system fonts', async () => {
    const f = await fixture();
    const result = await renderPdfOcrReview(
      f.source,
      f.page,
      new AbortController().signal,
    );
    expect(result.inspection.facts).toEqual(f.page.ocr);
    expect(result.original.mime).toBe('application/pdf');
    expect(pdf.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        enableXfa: false,
        useSystemFonts: false,
        disableFontFace: true,
        isEvalSupported: false,
      }),
    );
    expect(pdf.viewport).toHaveBeenCalledWith({ scale: 2, rotation: 0 });
    expect(pdf.render).toHaveBeenCalledWith(
      expect.objectContaining({ annotationMode: 0 }),
    );
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });
  it('rejects changed source, renderer version and dimensions', async () => {
    const f = await fixture();
    await expect(
      renderPdfOcrReview(
        { ...f.source, sourceDigest: 'a'.repeat(64) },
        f.page,
        new AbortController().signal,
      ),
    ).rejects.toThrow('does not match');
    await expect(
      renderPdfOcrReview(
        f.source,
        {
          ...f.page,
          render: {
            ...f.page.render,
            renderer: { ...f.page.render.renderer, version: 'other' },
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('version');
    pdf.viewport.mockReturnValue({ width: 1000, height: 160 });
    await expect(
      renderPdfOcrReview(f.source, f.page, new AbortController().signal),
    ).rejects.toThrow('dimensions');
  });
});

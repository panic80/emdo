import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  FinanceImageInspectionSchema,
  UploadFinanceBookEvidenceSchema,
  type FinancePdfPageOcr,
} from '@emdo/contracts/browser';
import {
  ImageReviewApiError,
  type ImageReviewSource,
} from './finance-image-review-api.js';
export async function pdfOcrDigest(bytes: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
export async function loadPdfOcrOriginal(
  source: ImageReviewSource,
  signal: AbortSignal,
) {
  const response = await fetch(
    `/api/v2/finance/books/${source.bookId}/evidence/${source.evidenceId}`,
    { credentials: 'same-origin', cache: 'no-store', signal },
  );
  if (!response.ok) throw new ImageReviewApiError(response.status);
  const original = UploadFinanceBookEvidenceSchema.parse(await response.json());
  if (original.format !== 'pdf' || !('sourceBase64' in original))
    throw new Error('The saved original is not a PDF.');
  const binary = atob(original.sourceBase64);
  if (
    !binary.length ||
    binary.length > 2097152 ||
    btoa(binary) !== original.sourceBase64
  )
    throw new Error('Invalid original PDF bytes.');
  const bytes = Uint8Array.from(binary, (v) => v.charCodeAt(0));
  if ((await pdfOcrDigest(bytes)) !== source.sourceDigest)
    throw new Error('The original PDF does not match this saved analysis.');
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return { bytes, filename: original.filename, mime: 'application/pdf' };
}
/** Browser rendering is for visual review only. The server independently
 * regenerates the saved raster and validates its exact digest before saving. */
export async function renderPdfOcrReview(
  source: ImageReviewSource,
  page: FinancePdfPageOcr,
  signal: AbortSignal,
) {
  const original = await loadPdfOcrOriginal(source, signal);
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  if (page.render.renderer.version !== pdfjs.version)
    throw new Error(
      'The saved PDF renderer version differs. Re-extract this source before reviewing it.',
    );
  const task = pdfjs.getDocument({
    data: original.bytes.slice(),
    isEvalSupported: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    stopAtErrors: true,
    isImageDecoderSupported: false,
  });
  const abort = () => {
    void task.destroy();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const document = await task.promise;
    if (document.numPages !== page.render.pageCount)
      throw new Error('PDF page inventory changed.');
    const pdfPage = await document.getPage(page.render.pageNumber);
    const viewport = pdfPage.getViewport({
      scale: page.render.scale,
      rotation: page.render.rotation,
    });
    if (
      Math.ceil(viewport.width) !== page.render.width ||
      Math.ceil(viewport.height) !== page.render.height
    )
      throw new Error(
        'PDF page dimensions do not match the saved OCR coordinates.',
      );
    const canvas = documentGlobal().createElement('canvas');
    canvas.width = page.render.width;
    canvas.height = page.render.height;
    await pdfPage.render({
      canvas,
      viewport,
      background: 'rgb(255,255,255)',
      annotationMode: pdfjs.AnnotationMode.DISABLE,
    }).promise;
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const imageUrl = canvas.toDataURL('image/png');
    canvas.width = canvas.height = 0;
    const inspection = FinanceImageInspectionSchema.parse({
      evidenceId: source.evidenceId,
      standardizationRunId: source.id,
      extractionRevision: source.extraction.revision,
      sourceDigest: page.ocr.sourceDigest,
      extractionDigest: await pdfOcrDigest(
        new TextEncoder().encode(JSON.stringify(page.ocr)),
      ),
      wordInventoryDigest: await pdfOcrDigest(
        new TextEncoder().encode(JSON.stringify(page.ocr.words)),
      ),
      facts: page.ocr,
    });
    return { inspection, original: { ...original, imageUrl } };
  } finally {
    signal.removeEventListener('abort', abort);
    await task.destroy();
  }
}
function documentGlobal() {
  return document;
}

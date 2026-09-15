import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type {
  RenderParameters,
  PDFDocumentLoadingTask,
} from 'pdfjs-dist/types/src/display/api.js';
import type {
  FinancePdfPageRenderLimits,
  FinancePdfPageRenderResult,
} from './pdf-page-render.js';

const unavailablePdfPageRender = (
  reason: Extract<
    FinancePdfPageRenderResult,
    { status: 'unavailable' }
  >['reason'],
): FinancePdfPageRenderResult => ({ status: 'unavailable', reason });

// Only the disposable worker may execute this renderer. No URL, executable,
// filesystem path, font source or command can be selected by the document.
async function renderOwnedPage(input: {
  bytes: Uint8Array;
  expectedSourceDigest: string;
  pageNumber: number;
  scale: number;
  limits: FinancePdfPageRenderLimits;
}): Promise<FinancePdfPageRenderResult> {
  let task: PDFDocumentLoadingTask | undefined;
  let diagnostic = false;
  // PDF.js warns when it drops oversized/unsupported images. Reject any such
  // rendering instead of returning a plausible but incomplete page raster.
  console.log =
    console.warn =
    console.error =
      (...values: unknown[]) => {
        if (
          values.some(
            (value) =>
              typeof value === 'string' && value.startsWith('Warning:'),
          )
        )
          diagnostic = true;
      };
  globalThis.fetch = async () => {
    throw new Error('external-resource-forbidden');
  };
  try {
    if (
      createHash('sha256').update(input.bytes).digest('hex') !==
      input.expectedSourceDigest
    )
      return unavailablePdfPageRender('source-digest-mismatch');
    const require = createRequire(import.meta.url);
    const pdfPackage = require.resolve('pdfjs-dist/package.json');
    const root = dirname(pdfPackage);
    const canvasRuntime = createRequire(pdfPackage)('@napi-rs/canvas') as {
      createCanvas(
        width: number,
        height: number,
      ): {
        getContext(kind: '2d'): RenderParameters['canvasContext'];
        toBuffer(format: 'image/png'): Buffer;
      };
    };
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    if (pdfjs.version !== '5.4.296')
      return unavailablePdfPageRender('unsupported');
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      join(root, 'legacy/build/pdf.worker.mjs'),
    ).href;
    task = pdfjs.getDocument({
      data: input.bytes,
      verbosity: 1,
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
      isOffscreenCanvasSupported: false,
      enableHWA: false,
      maxImageSize: input.limits.maxPixels,
      canvasMaxAreaInBytes: input.limits.maxPixels * 4,
      cMapUrl: join(root, 'cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: join(root, 'standard_fonts/'),
    });
    const document = await task.promise;
    if (document.numPages > input.limits.maxPages)
      return unavailablePdfPageRender('pages-limit');
    if (input.pageNumber > document.numPages)
      return unavailablePdfPageRender('page-unavailable');
    const page = await document.getPage(input.pageNumber);
    const viewport = page.getViewport({ scale: input.scale });
    const width = Math.ceil(viewport.width),
      height = Math.ceil(viewport.height);
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > input.limits.maxDimension ||
      height > input.limits.maxDimension ||
      width * height > input.limits.maxPixels
    )
      return unavailablePdfPageRender('pixels-limit');
    const canvas = canvasRuntime.createCanvas(width, height);
    await page.render({
      canvas: null,
      canvasContext: canvas.getContext('2d'),
      viewport,
      annotationMode: pdfjs.AnnotationMode.DISABLE,
      background: 'rgb(255,255,255)',
    }).promise;
    if (diagnostic) return unavailablePdfPageRender('unsupported');
    const png = new Uint8Array(canvas.toBuffer('image/png'));
    if (png.length > input.limits.maxOutputBytes)
      return unavailablePdfPageRender('output-limit');
    return {
      status: 'rendered',
      png,
      render: {
        sourceDigest: input.expectedSourceDigest,
        pageCount: document.numPages,
        pageNumber: input.pageNumber,
        rotation: viewport.rotation as 0 | 90 | 180 | 270,
        scale: input.scale,
        width,
        height,
        renderedImageDigest: createHash('sha256').update(png).digest('hex'),
        renderer: { id: 'pdfjs-dist', version: '5.4.296' },
      },
    };
  } catch (error) {
    return unavailablePdfPageRender(
      error instanceof Error && error.name === 'PasswordException'
        ? 'encrypted'
        : 'invalid',
    );
  } finally {
    await task?.destroy().catch(() => undefined);
    if (input.bytes.byteLength) input.bytes.fill(0);
  }
}
if (!isMainThread && parentPort) {
  void renderOwnedPage(workerData).then((result) =>
    parentPort!.postMessage(result),
  );
}

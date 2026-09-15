import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  FinancePdfReportExtraction,
  FinancePdfReportLimits,
  FinancePdfTextPage,
  FinancePdfTextSpan,
  FinancePdfUnavailableReason,
} from './pdf-report-extraction.js';

const rejected = (
  reason: FinancePdfUnavailableReason,
): FinancePdfReportExtraction => ({
  status: 'unavailable',
  format: 'pdf',
  reason,
});
class LimitError extends Error {
  readonly reason: FinancePdfUnavailableReason;
  constructor(reason: FinancePdfUnavailableReason) {
    super(reason);
    this.reason = reason;
  }
}

/** Public PDF.js APIs from the exact version used by pdf-parse v2. No private parser
 * members, document JavaScript, annotations/actions, attachments or rendering APIs.
 */
export async function extractOwnedFinancePdf(
  bytes: Uint8Array,
  limits: FinancePdfReportLimits,
): Promise<FinancePdfReportExtraction> {
  let loadingTask:
    | import('pdfjs-dist/types/src/display/api.js').PDFDocumentLoadingTask
    | undefined;
  try {
    if (
      !(bytes instanceof Uint8Array) ||
      !bytes.byteLength ||
      bytes.byteLength > limits.maxBytes
    )
      return rejected('bytes-limit');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // Resolve all optional font/CMap assets from the installed package, never the PDF.
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve('pdfjs-dist/package.json'));
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      join(root, 'legacy/build/pdf.worker.mjs'),
    ).href;
    loadingTask = pdfjs.getDocument({
      data: bytes,
      verbosity: 0,
      isEvalSupported: false,
      enableXfa: false,
      disableAutoFetch: true,
      disableFontFace: true,
      disableRange: true,
      disableStream: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      useWasm: false,
      stopAtErrors: true,
      isImageDecoderSupported: false,
      isOffscreenCanvasSupported: false,
      maxImageSize: 0,
      cMapUrl: join(root, 'cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: join(root, 'standard_fonts/'),
    });
    const document = await loadingTask.promise;
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1)
      return rejected('invalid');
    if (document.numPages > limits.maxPages) return rejected('pages-limit');
    const pages: FinancePdfTextPage[] = [];
    let spanCount = 0,
      textCharacters = 0,
      outputBytes = 0;
    let decodingIssue = false;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const reader = page
        .streamTextContent({
          includeMarkedContent: false,
          disableNormalization: true,
        })
        .getReader();
      const spans: FinancePdfTextSpan[] = [];
      let text = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (!('str' in item)) continue;
            if (++spanCount > limits.maxSpans)
              throw new LimitError('spans-limit');
            textCharacters += item.str.length + (item.hasEOL ? 1 : 0);
            if (textCharacters > limits.maxTextCharacters)
              throw new LimitError('text-limit');
            if (
              !Array.isArray(item.transform) ||
              item.transform.length !== 6 ||
              item.transform.some(
                (n: unknown) => typeof n !== 'number' || !Number.isFinite(n),
              )
            )
              return rejected('unsupported');
            const span: FinancePdfTextSpan = {
              index: spans.length,
              text: item.str,
              transform: [...item.transform],
              width: item.width,
              height: item.height,
              direction: item.dir,
              fontName: item.fontName,
              hasEOL: item.hasEOL,
              textOffset: text.length,
            };
            outputBytes +=
              Buffer.byteLength(JSON.stringify(span)) +
              Buffer.byteLength(item.str) +
              1;
            if (outputBytes > limits.maxOutputBytes)
              throw new LimitError('output-limit');
            if (
              [...item.str].some((character) => {
                const code = character.charCodeAt(0);
                return (
                  code === 0xfffd || (code < 32 && ![9, 10, 13].includes(code))
                );
              })
            )
              decodingIssue = true;
            spans.push(span);
            text += item.str + (item.hasEOL ? '\n' : '');
          }
        }
      } finally {
        // The whole loading task is destroyed below, including active streams.
        // Cancelling here races PDF.js queued stream-close messages against an
        // already closed controller and can replace a bounded limit result with
        // an uncaught worker error. Release the lock without cancelling twice.
        reader.releaseLock();
      }
      pages.push({
        page: pageNumber,
        width: viewport.width,
        height: viewport.height,
        rotation: viewport.rotation,
        viewportTransform: [...viewport.transform],
        text,
        spans,
        textStatus: text.trim() ? 'text-extracted' : 'no-extractable-text',
      });
      page.cleanup();
    }
    const noTextPages = pages.filter(
      (page) => page.textStatus === 'no-extractable-text',
    );
    const result: FinancePdfReportExtraction = {
      status: noTextPages.length === pages.length ? 'needs-ocr' : 'extracted',
      format: 'pdf',
      totalPages: document.numPages,
      pages,
      issues: [
        'text-order-and-financial-meaning-unconfirmed',
        ...(noTextPages.length
          ? ['no-text-pages-may-be-blank-or-scanned']
          : []),
        ...(decodingIssue ? ['text-decoding-needs-review'] : []),
      ],
    };
    if (Buffer.byteLength(JSON.stringify(result)) > limits.maxOutputBytes)
      return rejected('output-limit');
    return result;
  } catch (error) {
    if (error instanceof LimitError) return rejected(error.reason);
    if (error instanceof Error && error.name === 'PasswordException')
      return rejected('encrypted');
    if (error instanceof Error && error.name === 'InvalidPDFException')
      return rejected('invalid');
    return rejected('unsupported');
  } finally {
    await loadingTask?.destroy().catch(() => undefined);
    try {
      bytes.fill(0);
    } catch {
      /* Transferred PDF.js buffers are already detached. */
    }
  }
}

if (!isMainThread && parentPort) {
  const input = workerData as {
    bytes: Uint8Array;
    limits: FinancePdfReportLimits;
  };
  void extractOwnedFinancePdf(input.bytes, input.limits).then((result) =>
    parentPort!.postMessage(result),
  );
}

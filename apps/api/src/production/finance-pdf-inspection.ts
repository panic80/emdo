import type { PDFParse } from 'pdf-parse';

import { FINANCE_DOCUMENT_LIMITS } from '@emdo/domains/finance';

export interface FinancePdfInspector {
  /**
   * Returns the parser-authenticated page count, or `undefined` when the
   * bytes are not a usable PDF inside the approved Finance v1 boundary.
   */
  pageCount(document: Uint8Array): Promise<number | undefined>;
}

const destroyQuietly = async (
  parser: InstanceType<typeof PDFParse>,
): Promise<void> => {
  try {
    await parser.destroy();
  } catch {
    // Invalid documents can also make parser teardown reject.
  }
};

/**
 * Uses PDF.js document metadata rather than scanning plaintext object tokens.
 * This matters for compressed object streams and prevents disguised PDFs from
 * bypassing the 250-page upload boundary.
 */
export const createFinancePdfInspector = (): FinancePdfInspector =>
  Object.freeze({
    async pageCount(document: Uint8Array): Promise<number | undefined> {
      if (
        !(document instanceof Uint8Array) ||
        document.byteLength < 1 ||
        document.byteLength > FINANCE_DOCUMENT_LIMITS.maximumBytesPerFile
      ) {
        return undefined;
      }

      const parserInput = new Uint8Array(document);
      let parser: InstanceType<typeof PDFParse> | undefined;
      try {
        const { PDFParse: Parser } = await import('pdf-parse');
        parser = new Parser({
          data: parserInput,
          disableAutoFetch: true,
          disableFontFace: true,
          disableRange: true,
          disableStream: true,
          isEvalSupported: false,
          stopAtErrors: true,
          useSystemFonts: false,
          useWasm: false,
        });
        const info = await parser.getInfo({ parsePageInfo: false });
        return Number.isSafeInteger(info.total) &&
          info.total >= 1 &&
          info.total <= FINANCE_DOCUMENT_LIMITS.maximumPdfPages
          ? info.total
          : undefined;
      } catch {
        return undefined;
      } finally {
        if (parser !== undefined) await destroyQuietly(parser);
        try {
          parserInput.fill(0);
        } catch {
          // PDF.js may transfer the owned buffer to its worker.
        }
      }
    },
  });

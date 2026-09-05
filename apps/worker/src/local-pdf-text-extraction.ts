import type { PDFParse } from 'pdf-parse';

import { FINANCE_DOCUMENT_LIMITS } from '@emdo/domains/finance';

/**
 * This is deliberately a text-only, best-effort path. PDF parsing failures,
 * inaccessible text layers, and unsuitable output all return `unusable` so
 * the caller can use the existing bounded PDF-file extraction path instead.
 */
export const LOCAL_PDF_TEXT_EXTRACTION_LIMITS = Object.freeze({
  maxPdfPages: FINANCE_DOCUMENT_LIMITS.maximumPdfPages,
  maxExtractedTextBytes: 512 * 1024,
  maxExtractedTextCharacters: 256 * 1024,
  minimumNonWhitespaceCharacters: 64,
  minimumReadableCharacters: 32,
  minimumTokenCount: 3,
} as const);

export type LocalPdfTextExtractionResult = Readonly<
  | { readonly status: 'usable'; readonly text: string }
  | { readonly status: 'unusable' }
>;

export interface LocalPdfTextExtractor {
  /**
   * `document` is a copy of authenticated source bytes. Implementations must
   * never retain it, log it, or persist it, and must honor `signal` by tearing
   * down parser work promptly.
   */
  extract(input: {
    readonly document: Uint8Array;
    readonly pageCount: number;
    readonly signal: AbortSignal;
  }): Promise<LocalPdfTextExtractionResult>;
}

const unusable = (): LocalPdfTextExtractionResult =>
  Object.freeze({ status: 'unusable' as const });

const utf8ByteLength = (value: string): number => {
  const bytes = new TextEncoder().encode(value);
  try {
    return bytes.byteLength;
  } finally {
    bytes.fill(0);
  }
};

const hasSafeTextShape = (value: string): boolean => {
  if (
    value.length >
      LOCAL_PDF_TEXT_EXTRACTION_LIMITS.maxExtractedTextCharacters ||
    utf8ByteLength(value) >
      LOCAL_PDF_TEXT_EXTRACTION_LIMITS.maxExtractedTextBytes
  ) {
    return false;
  }

  let nonWhitespace = 0;
  let readable = 0;
  let tokenCount = 0;
  let inToken = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 8) ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        (codePoint >= 127 && codePoint <= 159))
    ) {
      return false;
    }
    if (!/^\s$/u.test(character)) nonWhitespace += 1;
    if (/^[\p{L}\p{N}]$/u.test(character)) {
      readable += 1;
      if (!inToken) tokenCount += 1;
      inToken = true;
    } else {
      inToken = false;
    }
  }
  return (
    nonWhitespace >=
      LOCAL_PDF_TEXT_EXTRACTION_LIMITS.minimumNonWhitespaceCharacters &&
    readable >= LOCAL_PDF_TEXT_EXTRACTION_LIMITS.minimumReadableCharacters &&
    tokenCount >= LOCAL_PDF_TEXT_EXTRACTION_LIMITS.minimumTokenCount
  );
};

/** A second validation at the worker boundary also protects injected tests. */
export const usableLocalPdfText = (value: unknown): string | undefined =>
  typeof value === 'string' && hasSafeTextShape(value) ? value : undefined;

const textFromParserResult = (value: unknown): string | undefined => {
  try {
    if (value === null || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'text');
    return descriptor?.get === undefined && descriptor?.set === undefined
      ? usableLocalPdfText(descriptor?.value)
      : undefined;
  } catch {
    return undefined;
  }
};

const destroyQuietly = (parser: InstanceType<typeof PDFParse>): void => {
  void parser.destroy().catch(() => undefined);
};

/**
 * `pdf-parse` is a maintained, Node 20-24-compatible TypeScript PDF.js
 * wrapper. It is dynamically loaded so normal image work never initializes a
 * PDF parser. Its input may be transferred to its worker, hence the owned copy
 * and best-effort zeroing below.
 */
export const createLocalPdfTextExtractor = (): LocalPdfTextExtractor =>
  Object.freeze({
    async extract(
      input: Parameters<LocalPdfTextExtractor['extract']>[0],
    ): Promise<LocalPdfTextExtractionResult> {
      if (
        input.signal.aborted ||
        !(input.document instanceof Uint8Array) ||
        !Number.isSafeInteger(input.pageCount) ||
        input.pageCount < 1 ||
        input.pageCount > LOCAL_PDF_TEXT_EXTRACTION_LIMITS.maxPdfPages
      ) {
        return unusable();
      }

      const parserInput = new Uint8Array(input.document);
      let parser: InstanceType<typeof PDFParse> | undefined;
      let abortParser: (() => void) | undefined;
      try {
        const { PDFParse: Parser } = await import('pdf-parse');
        if (input.signal.aborted) return unusable();
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
        abortParser = () => destroyQuietly(parser!);
        input.signal.addEventListener('abort', abortParser, { once: true });
        if (input.signal.aborted) return unusable();
        const result = await parser.getText({
          first: input.pageCount,
          includeMarkedContent: false,
          lineEnforce: true,
          parseHyperlinks: false,
          pageJoiner: '\n',
        });
        if (input.signal.aborted) return unusable();
        const text = textFromParserResult(result);
        return text === undefined
          ? unusable()
          : Object.freeze({ status: 'usable' as const, text });
      } catch {
        return unusable();
      } finally {
        if (abortParser !== undefined) {
          input.signal.removeEventListener('abort', abortParser);
        }
        if (parser !== undefined) destroyQuietly(parser);
        try {
          // `pdf-parse` may transfer the owned buffer to its worker; detached
          // buffers cannot be overwritten, and parser.destroy() owns release.
          parserInput.fill(0);
        } catch {
          // A detached ArrayBuffer contains no accessible local bytes.
        }
      }
    },
  });

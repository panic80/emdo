import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';

export const FINANCE_PDF_REPORT_LIMITS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxPages: 25,
  maxSpans: 20_000,
  maxTextCharacters: 256 * 1024,
  maxOutputBytes: 2 * 1024 * 1024,
  timeoutMs: 10_000,
});
export type FinancePdfReportLimits = {
  [K in keyof typeof FINANCE_PDF_REPORT_LIMITS]: number;
};
const SpanSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  text: z.string(),
  /** PDF.js text-content coordinates, not inferred table/cell coordinates. */
  transform: z.array(z.number().finite()).length(6),
  width: z.number().finite(),
  height: z.number().finite(),
  direction: z.string(),
  fontName: z.string(),
  hasEOL: z.boolean(),
  textOffset: z.number().int().nonnegative(),
});
const PageSchema = z.strictObject({
  page: z.number().int().positive(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  rotation: z.number().finite(),
  viewportTransform: z.array(z.number().finite()).length(6),
  text: z.string(),
  spans: z.array(SpanSchema),
  textStatus: z.enum(['text-extracted', 'no-extractable-text']),
});
const ReasonSchema = z.enum([
  'encrypted',
  'invalid',
  'unsupported',
  'bytes-limit',
  'pages-limit',
  'spans-limit',
  'text-limit',
  'output-limit',
  'timeout',
  'aborted',
  'worker-failed',
]);
export const FinancePdfReportExtractionSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.enum(['extracted', 'needs-ocr']),
    format: z.literal('pdf'),
    totalPages: z.number().int().positive(),
    pages: z.array(PageSchema),
    issues: z.array(z.string()),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    format: z.literal('pdf'),
    reason: ReasonSchema,
  }),
]);
export type FinancePdfReportExtraction = z.infer<
  typeof FinancePdfReportExtractionSchema
>;
export type FinancePdfTextSpan = z.infer<typeof SpanSchema>;
export type FinancePdfTextPage = z.infer<typeof PageSchema>;
export type FinancePdfUnavailableReason = z.infer<typeof ReasonSchema>;
const unavailable = (
  reason: FinancePdfUnavailableReason,
): FinancePdfReportExtraction => ({
  status: 'unavailable',
  format: 'pdf',
  reason,
});

/** Copies source bytes into a disposable, memory-limited worker. No OCR, tables,
 * financial interpretation, actions, scripts or network resources are executed.
 * Text is PDF.js-decoded source text, not a claim about visual reading order.
 */
export async function extractFinancePdfReport(
  bytes: Uint8Array,
  options: {
    limits?: Partial<FinancePdfReportLimits>;
    signal?: AbortSignal;
  } = {},
): Promise<FinancePdfReportExtraction> {
  const limits = { ...FINANCE_PDF_REPORT_LIMITS, ...options.limits };
  for (const key of Object.keys(
    FINANCE_PDF_REPORT_LIMITS,
  ) as (keyof FinancePdfReportLimits)[]) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > FINANCE_PDF_REPORT_LIMITS[key]
    )
      throw new Error('finance-pdf-invalid-limits');
  }
  if (options.signal?.aborted) return unavailable('aborted');
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength)
    return unavailable('invalid');
  if (bytes.byteLength > limits.maxBytes) return unavailable('bytes-limit');
  // Conservative PDF-only sniff; accepting arbitrary containers is not this adapter's job.
  if (
    !/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n|\s)/.test(
      Buffer.from(bytes.subarray(0, 16)).toString('latin1'),
    )
  )
    return unavailable('unsupported');
  const owned = new Uint8Array(bytes);
  const compiledWorker = new URL('./pdf-report-worker.js', import.meta.url);
  // Node >=24 strips types for source checkout execution; production ships compiled JS.
  const workerUrl = existsSync(compiledWorker)
    ? compiledWorker
    : new URL('./pdf-report-worker.ts', import.meta.url);
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl, {
        workerData: { bytes: owned, limits },
        transferList: [owned.buffer],
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 192,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4,
        },
        stdout: true,
        stderr: true,
      });
    } catch {
      owned.fill(0);
      resolve(unavailable('worker-failed'));
      return;
    }
    // Drain diagnostics without logging source content or retaining output.
    worker.stdout?.resume();
    worker.stderr?.resume();
    let settled = false;
    const finish = (result: FinancePdfReportExtraction) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      worker.removeAllListeners();
      worker.on('error', () => undefined);
      void worker
        .terminate()
        .catch(() => undefined)
        .then(() => resolve(result));
    };
    const abort = () => finish(unavailable('aborted'));
    const timer = setTimeout(
      () => finish(unavailable('timeout')),
      limits.timeoutMs,
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (message: unknown) => {
      const parsed = FinancePdfReportExtractionSchema.safeParse(message);
      if (
        !parsed.success ||
        Buffer.byteLength(JSON.stringify(parsed.data)) > limits.maxOutputBytes
      )
        finish(unavailable('worker-failed'));
      else finish(parsed.data);
    });
    worker.once('error', () => finish(unavailable('worker-failed')));
    worker.once('exit', () => finish(unavailable('worker-failed')));
    if (options.signal?.aborted) abort();
  });
}

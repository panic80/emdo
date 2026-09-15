import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { FinancePdfPageRenderSchema } from '@emdo/contracts';
import type { z } from 'zod';

export const FINANCE_PDF_PAGE_RENDER_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxPages: 25,
  maxDimension: 8192,
  maxPixels: 16000000,
  maxOutputBytes: 2 * 1024 * 1024,
  timeoutMs: 15000,
});
export type FinancePdfPageRenderLimits = {
  [K in keyof typeof FINANCE_PDF_PAGE_RENDER_LIMITS]: number;
};
export const FinancePdfPageRenderMetadataSchema = FinancePdfPageRenderSchema;
export type FinancePdfPageRenderMetadata = z.infer<
  typeof FinancePdfPageRenderMetadataSchema
>;
export type FinancePdfPageRenderReason =
  | 'invalid'
  | 'source-digest-mismatch'
  | 'bytes-limit'
  | 'pages-limit'
  | 'page-unavailable'
  | 'pixels-limit'
  | 'output-limit'
  | 'encrypted'
  | 'unsupported'
  | 'timeout'
  | 'aborted'
  | 'worker-failed';
export type FinancePdfPageRenderResult =
  | {
      status: 'rendered';
      render: FinancePdfPageRenderMetadata;
      png: Uint8Array;
    }
  | { status: 'unavailable'; reason: FinancePdfPageRenderReason };
export const unavailablePdfPageRender = (
  reason: FinancePdfPageRenderReason,
): FinancePdfPageRenderResult => ({ status: 'unavailable', reason });
const reasons = new Set<FinancePdfPageRenderReason>([
  'invalid',
  'source-digest-mismatch',
  'bytes-limit',
  'pages-limit',
  'page-unavailable',
  'pixels-limit',
  'output-limit',
  'encrypted',
  'unsupported',
  'timeout',
  'aborted',
  'worker-failed',
]);

/** One explicit page, never whole-document coverage. Native rendering must also
 * run inside the release-owned OS sandbox before accepting production uploads. */
export async function renderFinancePdfPage(input: {
  bytes: Uint8Array;
  expectedSourceDigest: string;
  pageNumber: number;
  scale?: number;
  signal?: AbortSignal;
  limits?: Partial<FinancePdfPageRenderLimits>;
}): Promise<FinancePdfPageRenderResult> {
  const limits = { ...FINANCE_PDF_PAGE_RENDER_LIMITS, ...input.limits };
  for (const key of Object.keys(
    limits,
  ) as (keyof FinancePdfPageRenderLimits)[]) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > FINANCE_PDF_PAGE_RENDER_LIMITS[key]
    )
      throw new Error('finance-pdf-page-render-invalid-limits');
  }
  if (input.signal?.aborted) return unavailablePdfPageRender('aborted');
  if (
    !(input.bytes instanceof Uint8Array) ||
    !input.bytes.length ||
    !Number.isInteger(input.pageNumber) ||
    input.pageNumber < 1 ||
    input.pageNumber > limits.maxPages
  )
    return unavailablePdfPageRender('invalid');
  if (input.bytes.length > limits.maxBytes)
    return unavailablePdfPageRender('bytes-limit');
  const scale = input.scale ?? 2;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4)
    return unavailablePdfPageRender('invalid');
  if (
    createHash('sha256').update(input.bytes).digest('hex') !==
    input.expectedSourceDigest
  )
    return unavailablePdfPageRender('source-digest-mismatch');
  if (
    !/^%PDF-(?:1\.[0-7]|2\.0)\s/u.test(
      Buffer.from(input.bytes.subarray(0, 16)).toString('latin1'),
    )
  )
    return unavailablePdfPageRender('unsupported');
  const bytes = new Uint8Array(input.bytes);
  const compiled = new URL('./pdf-page-render-worker.js', import.meta.url);
  const workerUrl = existsSync(compiled)
    ? compiled
    : new URL('./pdf-page-render-worker.ts', import.meta.url);
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl, {
        workerData: {
          bytes,
          expectedSourceDigest: input.expectedSourceDigest,
          pageNumber: input.pageNumber,
          scale,
          limits,
        },
        transferList: [bytes.buffer],
        execArgv: [],
        stdout: true,
        stderr: true,
        resourceLimits: {
          maxOldGenerationSizeMb: 192,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4,
        },
      });
    } catch {
      bytes.fill(0);
      resolve(unavailablePdfPageRender('worker-failed'));
      return;
    }
    worker.stdout?.resume();
    worker.stderr?.resume();
    let settled = false;
    const finish = (result: FinancePdfPageRenderResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      worker.removeAllListeners();
      worker.on('error', () => undefined);
      void worker
        .terminate()
        .catch(() => undefined)
        .then(() => resolve(result));
    };
    const abort = () => finish(unavailablePdfPageRender('aborted'));
    const timer = setTimeout(
      () => finish(unavailablePdfPageRender('timeout')),
      limits.timeoutMs,
    );
    input.signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (message: FinancePdfPageRenderResult) => {
      if (message?.status === 'unavailable' && reasons.has(message.reason)) {
        finish(message);
        return;
      }
      if (message?.status !== 'rendered') {
        finish(unavailablePdfPageRender('worker-failed'));
        return;
      }
      const metadata = FinancePdfPageRenderMetadataSchema.safeParse(
        message.render,
      );
      const png = message.png;
      if (
        !metadata.success ||
        !(png instanceof Uint8Array) ||
        png.length < 24 ||
        png.length > limits.maxOutputBytes ||
        metadata.data.sourceDigest !== input.expectedSourceDigest ||
        metadata.data.pageNumber !== input.pageNumber ||
        metadata.data.pageCount > limits.maxPages ||
        metadata.data.pageNumber > metadata.data.pageCount ||
        metadata.data.scale !== scale ||
        metadata.data.width > limits.maxDimension ||
        metadata.data.height > limits.maxDimension ||
        metadata.data.width * metadata.data.height > limits.maxPixels ||
        Buffer.from(png.subarray(0, 8)).toString('hex') !==
          '89504e470d0a1a0a' ||
        Buffer.from(png).readUInt32BE(16) !== metadata.data.width ||
        Buffer.from(png).readUInt32BE(20) !== metadata.data.height ||
        createHash('sha256').update(png).digest('hex') !==
          metadata.data.renderedImageDigest
      ) {
        finish(unavailablePdfPageRender('worker-failed'));
        return;
      }
      finish({ status: 'rendered', render: metadata.data, png });
    });
    worker.once('error', () =>
      finish(unavailablePdfPageRender('worker-failed')),
    );
    worker.once('exit', () =>
      finish(unavailablePdfPageRender('worker-failed')),
    );
    if (input.signal?.aborted) abort();
  });
}

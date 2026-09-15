import {
  createFinanceImageOcrRuntime,
  extractFinanceImageOcr,
  type FinanceImageOcrExtraction,
  type FinanceImageOcrApprovedRuntimeManifest,
  type FinanceImageOcrLimits,
  type FinanceImageOcrRuntime,
  parseFinanceImageFormat,
} from '@emdo/integrations/finance-documents';
import type {
  FinanceImageOcrHelperChannel,
  FinanceImageOcrHelperLanguage,
  FinanceImageOcrHelperSpawn,
  FinanceImageOcrUnixSocketConnect,
} from './finance-image-ocr-isolated.js';

/**
 * Worker-side boundary for one image source read. It owns no model, posting,
 * approval, or mapping capability. The returned text remains an OCR candidate
 * until a separate human review binds exact words/regions to the original.
 */
export const FINANCE_IMAGE_OCR_WORKER_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxPixels: 40_000_000,
  maxDimension: 100_000,
  maxWords: 20_000,
  maxTextCharacters: 256 * 1024,
  maxDecodedBytes: 48 * 1024 * 1024,
  maxOutputBytes: 2 * 1024 * 1024,
  defaultTimeoutMs: 15_000,
  maximumTimeoutMs: 15_000,
  minimumConfidence: 0.8,
});

export interface FinanceImageOcrWorkerInput {
  readonly format: string;
  readonly bytes: Uint8Array;
  readonly expectedSourceDigest: string;
  readonly signal: AbortSignal;
  readonly limits?: Partial<FinanceImageOcrLimits>;
}

export interface FinanceImageOcrWorkerAdapter {
  /** Extracts one bounded candidate and performs no downstream mutation. */
  extract(
    input: FinanceImageOcrWorkerInput,
  ): Promise<FinanceImageOcrExtraction>;
}

export interface FinanceImageOcrIsolatedHelperOptions {
  /** Release-owned manifest returned by the helper and checked per stage. */
  readonly approvedManifest: FinanceImageOcrApprovedRuntimeManifest;
  readonly language?: FinanceImageOcrHelperLanguage;
  /** Test-only process injection; production uses the fixed Unix socket. */
  readonly spawnProcess?: FinanceImageOcrHelperSpawn;
  /** Trusted supervisor channel; production defaults to the fixed Unix socket. */
  readonly helperChannel?: FinanceImageOcrHelperChannel;
  readonly socketPath?: string;
  readonly connectUnixSocket?: FinanceImageOcrUnixSocketConnect;
  /** Only the fixed release helper path is accepted when testing stdio. */
  readonly helperExecutable?: string;
}

const mergedLimits = (
  requested: Partial<FinanceImageOcrLimits> | undefined,
): Partial<FinanceImageOcrLimits> => ({
  ...(requested ?? {}),
});

export function createFinanceImageOcrWorkerAdapter(
  options: {
    readonly runtime?: FinanceImageOcrRuntime;
    readonly approvedManifest?: FinanceImageOcrApprovedRuntimeManifest;
    readonly isolatedHelper?: FinanceImageOcrIsolatedHelperOptions;
    readonly limits?: Partial<FinanceImageOcrLimits>;
  } = {},
): FinanceImageOcrWorkerAdapter {
  if (options.runtime && options.isolatedHelper)
    throw new Error('finance-image-ocr-worker-runtime-conflict');
  return {
    async extract(input) {
      if (!(input.signal instanceof AbortSignal))
        throw new Error('finance-image-ocr-worker-signal-invalid');
      const runtime = options.isolatedHelper
        ? await import('./finance-image-ocr-isolated.js').then(
            ({ createFinanceImageOcrIsolatedRuntime }) =>
              createFinanceImageOcrIsolatedRuntime({
                format: parseFinanceImageFormat(input.format),
                expectedSourceDigest: input.expectedSourceDigest,
                approvedManifest: options.isolatedHelper!.approvedManifest,
                language: options.isolatedHelper!.language,
                spawnProcess: options.isolatedHelper!.spawnProcess,
                helperChannel: options.isolatedHelper!.helperChannel,
                socketPath: options.isolatedHelper!.socketPath,
                connectUnixSocket: options.isolatedHelper!.connectUnixSocket,
                helperExecutable: options.isolatedHelper!.helperExecutable,
              }),
          )
        : (options.runtime ??
          createFinanceImageOcrRuntime({
            approvedManifest: options.approvedManifest,
            requireApprovedManifest: true,
          }));
      return extractFinanceImageOcr(input.bytes, {
        format: input.format,
        expectedSourceDigest: input.expectedSourceDigest,
        signal: input.signal,
        runtime,
        limits: mergedLimits({
          ...(options.limits ?? {}),
          ...(input.limits ?? {}),
        }),
      });
    },
  };
}

/** Convenient source-compatible function for worker call sites. */
export async function extractFinanceImageOcrForWorker(
  input: FinanceImageOcrWorkerInput,
  options: {
    readonly runtime?: FinanceImageOcrRuntime;
    readonly approvedManifest?: FinanceImageOcrApprovedRuntimeManifest;
    readonly isolatedHelper?: FinanceImageOcrIsolatedHelperOptions;
    readonly limits?: Partial<FinanceImageOcrLimits>;
  } = {},
): Promise<FinanceImageOcrExtraction> {
  return createFinanceImageOcrWorkerAdapter(options).extract(input);
}

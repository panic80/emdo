import { createHash, timingSafeEqual } from 'node:crypto';

import { UuidSchema } from '@emdo/contracts';
import {
  FINANCE_DOCUMENT_LIMITS,
  FinanceDocumentEnvelopeV1Schema,
  redactFinanceDocumentEnvelopeForReview,
  type FinanceDocumentEnvelopeV1,
  type FinanceDocumentMimeType,
} from '@emdo/domains/finance';
import {
  FINANCE_DOCUMENT_MAX_UPLOAD_BYTES,
  FinanceDocumentPayloadScopeSchema,
  financeDocumentOriginalAssociatedData,
  parseFinanceDocumentMetadata,
  type EncryptedFinanceDocumentPayload,
  type FinanceDocumentMetadata,
  type FinanceDocumentPayloadScope,
} from '@emdo/integrations/finance-documents';
import {
  OPENAI_FINANCE_DOCUMENT_EXTRACTION_LIMITS,
  OPENAI_FINANCE_DOCUMENT_EXTRACTION_MODEL,
  OpenAiFinanceDocumentExtractionError,
  type FinanceDocumentOutputContract,
  type OpenAiFinanceDocumentExtractionInput,
  type OpenAiFinanceDocumentExtractionRequest,
  type OpenAiFinanceDocumentExtractionResult,
} from '@emdo/integrations/openai';
import { z } from 'zod';

import {
  createLocalPdfTextExtractor,
  usableLocalPdfText,
  type LocalPdfTextExtractor,
} from './local-pdf-text-extraction.js';

/**
 * This leaf processes exactly one durable claim. It deliberately has no job
 * scheduling, agent, provider-tool, filesystem, environment, or logging
 * surface; composition owns those boundaries.
 */
export const FINANCE_DOCUMENT_EXTRACTION_WORKER_LIMITS = Object.freeze({
  defaultTimeoutMs: OPENAI_FINANCE_DOCUMENT_EXTRACTION_LIMITS.defaultTimeoutMs,
  maximumTimeoutMs: OPENAI_FINANCE_DOCUMENT_EXTRACTION_LIMITS.maxTimeoutMs,
  settlementTimeoutMs: 5_000,
  maximumUsageTokens: 10_000_000,
} as const);

export type FinanceDocumentExtractionSafeErrorCode =
  | 'worker-completion-rejected'
  | 'worker-document-metadata-invalid'
  | 'worker-extraction-failed'
  | 'worker-extraction-invalid'
  | 'worker-interrupted'
  | 'worker-invalid-claim'
  | 'worker-original-integrity-invalid'
  | 'worker-original-unavailable'
  | 'worker-payload-encryption-failed'
  | 'worker-provider-credential-unavailable'
  | 'worker-provider-rejected'
  | 'worker-provider-request-invalid'
  | 'worker-provider-response-invalid'
  | 'worker-provider-unavailable'
  | 'worker-timeout';

export interface FinanceDocumentExtractionClaim {
  readonly schemaVersion: 1;
  readonly documentId: string;
  readonly extractionRevision: number;
  readonly attempt: 1 | 2;
  /**
   * The composition boundary materializes this from the executor claim plus
   * authenticated document metadata. The worker derives original AAD from the
   * authenticated payload scope below; `metadata` is accepted by
   * FinanceDocumentStorage.read, which verifies GCM authentication and both
   * object hashes before yielding any plaintext.
   */
  readonly original: Readonly<{
    readonly mimeType: FinanceDocumentMimeType;
    readonly byteSize: number;
    readonly pageCount: number | null;
    readonly imageWidth: number | null;
    readonly imageHeight: number | null;
    readonly metadata: FinanceDocumentMetadata;
  }>;
  /** Exact document/revision AAD for the unreviewed extraction payload. */
  readonly payloadScope: FinanceDocumentPayloadScope;
}

export interface FinanceDocumentExtractionExecutor {
  /** Calls emdo.claim_next_finance_document_extraction() at most once. */
  claimNextFinanceDocumentExtraction(input: {
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  /** Calls emdo.complete_finance_document_extraction(...), returning true. */
  completeFinanceDocumentExtraction(input: {
    readonly documentId: string;
    readonly extractionRevision: number;
    readonly attempt: 1 | 2;
    readonly encryptedPayload: EncryptedFinanceDocumentPayload;
    readonly redactedSummary: Readonly<{
      readonly documentType: FinanceDocumentEnvelopeV1['documentType'];
      readonly sourceLocale: FinanceDocumentEnvelopeV1['sourceLocale'];
      readonly currency: string | null;
      readonly factCount: number;
      readonly chunkCount: 0;
      readonly evidenceCount: number;
      readonly safeStatus: 'ready-for-review' | 'no-readable-facts';
    }>;
    readonly responseHash: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly documentType: FinanceDocumentEnvelopeV1['documentType'];
    readonly sourceLocale: FinanceDocumentEnvelopeV1['sourceLocale'];
    readonly currency: string | null;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  /** Calls emdo.fail_finance_document_extraction(...), returning true. */
  failFinanceDocumentExtraction(input: {
    readonly documentId: string;
    readonly extractionRevision: number;
    readonly attempt: 1 | 2;
    readonly safeErrorCode: FinanceDocumentExtractionSafeErrorCode;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

/** Narrow structural surface of FinanceDocumentStorage used by this worker. */
export interface FinanceDocumentAuthenticatedOriginalStore {
  read(input: {
    readonly metadata: FinanceDocumentMetadata;
    readonly aad: Uint8Array;
    readonly signal: AbortSignal;
  }): AsyncIterable<Uint8Array>;
}

/** Narrow structural surface of FinanceDocumentPayloadCrypto used here. */
export interface FinanceDocumentExtractionPayloadCrypto {
  encrypt(
    value: unknown,
    scope: FinanceDocumentPayloadScope,
  ): Promise<EncryptedFinanceDocumentPayload>;
}

/** Narrow structural surface of the fixed OpenAI Responses extraction adapter. */
export interface FinanceDocumentExtractionAdapter {
  extract<Extraction>(
    request: OpenAiFinanceDocumentExtractionRequest<Extraction>,
  ): Promise<OpenAiFinanceDocumentExtractionResult<Extraction>>;
}

export interface FinanceDocumentExtractionWorkerDependencies {
  readonly executor: FinanceDocumentExtractionExecutor;
  readonly originals: FinanceDocumentAuthenticatedOriginalStore;
  readonly payloadCrypto: FinanceDocumentExtractionPayloadCrypto;
  readonly extractor: FinanceDocumentExtractionAdapter;
  /**
   * Optional only to make bounded local-PDF behavior deterministic in tests.
   * The production default is the local, text-only parser in this package.
   */
  readonly pdfTextExtractor?: LocalPdfTextExtractor;
  /** Defaults to 60 seconds and cannot exceed the adapter's two-minute cap. */
  readonly timeoutMs?: number;
}

export type FinanceDocumentExtractionRunResult = Readonly<
  | { readonly status: 'idle' }
  | {
      readonly status: 'completed';
      readonly documentId: string;
      readonly extractionRevision: number;
      readonly providerAttempts: 1 | 2;
    }
  | {
      readonly status: 'failed';
      readonly documentId: string;
      readonly extractionRevision: number;
      readonly safeErrorCode: FinanceDocumentExtractionSafeErrorCode;
    }
>;

export interface FinanceDocumentExtractionWorker {
  /** Claims and settles at most one extraction; callers own all polling. */
  runOnce(input: {
    readonly signal: AbortSignal;
  }): Promise<FinanceDocumentExtractionRunResult>;
}

/** Only a generic error crosses this worker's trust boundary. */
export class FinanceDocumentExtractionWorkerError extends Error {
  constructor() {
    super('Finance document extraction worker failed.');
    this.name = 'FinanceDocumentExtractionWorkerError';
  }
}

type Method = (...arguments_: never[]) => unknown;

type Deadline = Readonly<{
  signal: AbortSignal;
  didTimeout(): boolean;
  dispose(): void;
}>;

type ClaimIdentity = Readonly<{
  documentId: string;
  extractionRevision: number;
  attempt: 1 | 2;
}>;

type ExtractedProviderResult = Readonly<{
  envelope: FinanceDocumentEnvelopeV1;
  redactedEnvelope: FinanceDocumentEnvelopeV1;
  attempts: 1 | 2;
  inputTokens: number;
  outputTokens: number;
}>;

interface WorkerBindings {
  readonly claimNext: FinanceDocumentExtractionExecutor['claimNextFinanceDocumentExtraction'];
  readonly complete: FinanceDocumentExtractionExecutor['completeFinanceDocumentExtraction'];
  readonly fail: FinanceDocumentExtractionExecutor['failFinanceDocumentExtraction'];
  readonly read: FinanceDocumentAuthenticatedOriginalStore['read'];
  readonly encrypt: FinanceDocumentExtractionPayloadCrypto['encrypt'];
  readonly extract: FinanceDocumentExtractionAdapter['extract'];
  readonly extractPdfText: LocalPdfTextExtractor['extract'];
}

class SafeWorkerFailure extends Error {
  constructor(readonly safeErrorCode: FinanceDocumentExtractionSafeErrorCode) {
    super('Finance document extraction did not complete.');
    this.name = 'SafeWorkerFailure';
  }
}

/** A failed completion call may have committed before its response was lost. */
class CompletionIndeterminate extends Error {
  constructor() {
    super('Finance document extraction completion is indeterminate.');
    this.name = 'CompletionIndeterminate';
  }
}

class WorkerAbort extends Error {
  constructor() {
    super('Finance document extraction was interrupted.');
    this.name = 'WorkerAbort';
  }
}

const outputJsonSchema = (() => {
  const generated = z.toJSONSchema(FinanceDocumentEnvelopeV1Schema, {
    io: 'input',
    target: 'draft-2020-12',
  }) as Record<string, unknown>;
  const portable = { ...generated };
  delete portable.$schema;
  return Object.freeze(portable);
})();

export const FINANCE_DOCUMENT_EXTRACTION_OUTPUT_CONTRACT: FinanceDocumentOutputContract<FinanceDocumentEnvelopeV1> =
  Object.freeze({
    name: 'finance_document_v1',
    jsonSchema: outputJsonSchema,
    parse(value: unknown): FinanceDocumentEnvelopeV1 {
      return FinanceDocumentEnvelopeV1Schema.parse(value);
    },
  });

const isObject = (value: unknown): value is object =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

const isPlainRecord = (value: unknown): value is object =>
  isObject(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const snapshotRecord = (
  input: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Readonly<Record<string, unknown>> | undefined => {
  try {
    if (!isPlainRecord(input)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some((key) => descriptors[key] === undefined)
    ) {
      return undefined;
    }
    const result: Record<string, unknown> = {};
    for (const key of allowed) {
      const descriptor = descriptors[key];
      if (descriptor === undefined) continue;
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        return undefined;
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
};

const captureMethod = (target: unknown, name: string): Method | undefined => {
  if (!isObject(target)) return undefined;
  try {
    let current: object | null = target;
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor !== undefined) {
        if (
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          typeof descriptor.value !== 'function'
        ) {
          return undefined;
        }
        return descriptor.value.bind(target) as Method;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const captureBindings = (
  input: unknown,
): Readonly<{
  readonly bindings: WorkerBindings;
  readonly timeoutMs: number;
}> => {
  const values = snapshotRecord(
    input,
    [
      'executor',
      'originals',
      'payloadCrypto',
      'extractor',
      'pdfTextExtractor',
      'timeoutMs',
    ],
    ['executor', 'originals', 'payloadCrypto', 'extractor'],
  );
  if (values === undefined) {
    throw new FinanceDocumentExtractionWorkerError();
  }
  const timeoutCandidate =
    values.timeoutMs ??
    FINANCE_DOCUMENT_EXTRACTION_WORKER_LIMITS.defaultTimeoutMs;
  if (
    typeof timeoutCandidate !== 'number' ||
    !Number.isSafeInteger(timeoutCandidate) ||
    timeoutCandidate < 1 ||
    timeoutCandidate >
      FINANCE_DOCUMENT_EXTRACTION_WORKER_LIMITS.maximumTimeoutMs
  ) {
    throw new FinanceDocumentExtractionWorkerError();
  }
  const timeoutMs = timeoutCandidate;
  const claimNext = captureMethod(
    values.executor,
    'claimNextFinanceDocumentExtraction',
  );
  const complete = captureMethod(
    values.executor,
    'completeFinanceDocumentExtraction',
  );
  const fail = captureMethod(values.executor, 'failFinanceDocumentExtraction');
  const read = captureMethod(values.originals, 'read');
  const encrypt = captureMethod(values.payloadCrypto, 'encrypt');
  const extract = captureMethod(values.extractor, 'extract');
  const extractPdfText = captureMethod(
    values.pdfTextExtractor ?? createLocalPdfTextExtractor(),
    'extract',
  );
  if (
    claimNext === undefined ||
    complete === undefined ||
    fail === undefined ||
    read === undefined ||
    encrypt === undefined ||
    extract === undefined ||
    extractPdfText === undefined
  ) {
    throw new FinanceDocumentExtractionWorkerError();
  }
  return Object.freeze({
    bindings: Object.freeze({
      claimNext:
        claimNext as FinanceDocumentExtractionExecutor['claimNextFinanceDocumentExtraction'],
      complete:
        complete as FinanceDocumentExtractionExecutor['completeFinanceDocumentExtraction'],
      fail: fail as FinanceDocumentExtractionExecutor['failFinanceDocumentExtraction'],
      read: read as FinanceDocumentAuthenticatedOriginalStore['read'],
      encrypt: encrypt as FinanceDocumentExtractionPayloadCrypto['encrypt'],
      extract: extract as FinanceDocumentExtractionAdapter['extract'],
      extractPdfText: extractPdfText as LocalPdfTextExtractor['extract'],
    }),
    timeoutMs,
  });
};

const isAbortSignal = (value: unknown): value is AbortSignal =>
  isObject(value) &&
  typeof (value as { readonly aborted?: unknown }).aborted === 'boolean' &&
  typeof (value as { readonly addEventListener?: unknown }).addEventListener ===
    'function' &&
  typeof (value as { readonly removeEventListener?: unknown })
    .removeEventListener === 'function';

const parseRunSignal = (input: unknown): AbortSignal => {
  const values = snapshotRecord(input, ['signal']);
  if (values === undefined || !isAbortSignal(values.signal)) {
    throw new FinanceDocumentExtractionWorkerError();
  }
  return values.signal;
};

const createDeadline = (signal: AbortSignal, timeoutMs: number): Deadline => {
  const controller = new AbortController();
  let timedOut = false;
  const abortForCaller = () => controller.abort();
  signal.addEventListener('abort', abortForCaller, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abortForCaller);
    },
  });
};

const awaitWithAbort = async <Value>(
  signal: AbortSignal,
  operation: () => Value | Promise<Value>,
  onLateResolve?: (value: Value) => void,
): Promise<Value> => {
  if (signal.aborted) throw new WorkerAbort();
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => finish(() => reject(new WorkerAbort()));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          if (settled) {
            try {
              onLateResolve?.(value);
            } catch {
              // A late result must never re-enter the worker path.
            }
            return;
          }
          finish(() => resolve(value));
        },
        (error: unknown) => finish(() => reject(error)),
      );
  });
};

const parseClaimIdentity = (input: unknown): ClaimIdentity | undefined => {
  try {
    if (!isPlainRecord(input)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const documentId = descriptors.documentId;
    const extractionRevision = descriptors.extractionRevision;
    const attempt = descriptors.attempt;
    if (
      documentId === undefined ||
      extractionRevision === undefined ||
      attempt === undefined ||
      documentId.get !== undefined ||
      documentId.set !== undefined ||
      extractionRevision.get !== undefined ||
      extractionRevision.set !== undefined ||
      attempt.get !== undefined ||
      attempt.set !== undefined
    ) {
      return undefined;
    }
    const parsedDocumentId = UuidSchema.safeParse(documentId.value);
    if (
      !parsedDocumentId.success ||
      !Number.isSafeInteger(extractionRevision.value) ||
      extractionRevision.value < 1 ||
      (attempt.value !== 1 && attempt.value !== 2)
    ) {
      return undefined;
    }
    return Object.freeze({
      documentId: parsedDocumentId.data,
      extractionRevision: extractionRevision.value,
      attempt: attempt.value,
    });
  } catch {
    return undefined;
  }
};

const parsePayloadScope = (input: unknown): FinanceDocumentPayloadScope => {
  const values = snapshotRecord(input, [
    'householdId',
    'privateSpaceId',
    'ownerUserId',
    'documentId',
    'extractionRevision',
    'purpose',
  ]);
  if (values === undefined) {
    throw new SafeWorkerFailure('worker-invalid-claim');
  }
  try {
    return FinanceDocumentPayloadScopeSchema.parse(values);
  } catch {
    throw new SafeWorkerFailure('worker-invalid-claim');
  }
};

const isDocumentMimeType = (value: unknown): value is FinanceDocumentMimeType =>
  value === 'application/pdf' ||
  value === 'image/jpeg' ||
  value === 'image/png';

const validInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= minimum &&
  value <= maximum;

const validateOriginalBounds = (input: {
  readonly mimeType: FinanceDocumentMimeType;
  readonly byteSize: number;
  readonly pageCount: number | null;
  readonly imageWidth: number | null;
  readonly imageHeight: number | null;
  readonly metadata: FinanceDocumentMetadata;
}): void => {
  if (
    !validInteger(input.byteSize, 1, FINANCE_DOCUMENT_MAX_UPLOAD_BYTES) ||
    input.byteSize !== input.metadata.plaintextBytes ||
    input.byteSize !== input.metadata.ciphertextBytes
  ) {
    throw new SafeWorkerFailure('worker-document-metadata-invalid');
  }
  if (input.mimeType === 'application/pdf') {
    if (
      !validInteger(
        input.pageCount,
        1,
        FINANCE_DOCUMENT_LIMITS.maximumPdfPages,
      ) ||
      input.imageWidth !== null ||
      input.imageHeight !== null
    ) {
      throw new SafeWorkerFailure('worker-document-metadata-invalid');
    }
    return;
  }
  // The document schema permits a narrow-but-tall image as long as the
  // product is bounded, so enforce the individual 40k-pixel cap separately.
  const maximumDimension = 40_000;
  if (
    input.pageCount !== null ||
    !validInteger(input.imageWidth, 1, maximumDimension) ||
    !validInteger(input.imageHeight, 1, maximumDimension) ||
    input.imageWidth * input.imageHeight >
      FINANCE_DOCUMENT_LIMITS.maximumImageMegapixels * 1_000_000
  ) {
    throw new SafeWorkerFailure('worker-document-metadata-invalid');
  }
};

const parseClaim = (input: unknown): FinanceDocumentExtractionClaim => {
  const values = snapshotRecord(input, [
    'schemaVersion',
    'documentId',
    'extractionRevision',
    'attempt',
    'original',
    'payloadScope',
  ]);
  const identity = parseClaimIdentity(input);
  if (
    values === undefined ||
    values.schemaVersion !== 1 ||
    identity === undefined
  ) {
    throw new SafeWorkerFailure('worker-invalid-claim');
  }
  const original = snapshotRecord(values.original, [
    'mimeType',
    'byteSize',
    'pageCount',
    'imageWidth',
    'imageHeight',
    'metadata',
  ]);
  if (
    original === undefined ||
    !isDocumentMimeType(original.mimeType) ||
    typeof original.byteSize !== 'number' ||
    (original.pageCount !== null && typeof original.pageCount !== 'number') ||
    (original.imageWidth !== null && typeof original.imageWidth !== 'number') ||
    (original.imageHeight !== null && typeof original.imageHeight !== 'number')
  ) {
    throw new SafeWorkerFailure('worker-document-metadata-invalid');
  }
  let metadata: FinanceDocumentMetadata;
  try {
    metadata = parseFinanceDocumentMetadata(original.metadata);
  } catch {
    throw new SafeWorkerFailure('worker-document-metadata-invalid');
  }
  const payloadScope = parsePayloadScope(values.payloadScope);
  if (
    payloadScope.documentId !== identity.documentId ||
    payloadScope.extractionRevision !== identity.extractionRevision
  ) {
    throw new SafeWorkerFailure('worker-invalid-claim');
  }
  validateOriginalBounds({
    mimeType: original.mimeType,
    byteSize: original.byteSize,
    pageCount: original.pageCount,
    imageWidth: original.imageWidth,
    imageHeight: original.imageHeight,
    metadata,
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    documentId: identity.documentId,
    extractionRevision: identity.extractionRevision,
    attempt: identity.attempt,
    original: Object.freeze({
      mimeType: original.mimeType,
      byteSize: original.byteSize,
      pageCount: original.pageCount,
      imageWidth: original.imageWidth,
      imageHeight: original.imageHeight,
      metadata,
    }),
    payloadScope,
  });
};

const asAsyncIterator = (
  value: unknown,
): AsyncIterator<Uint8Array, void, undefined> => {
  try {
    if (!isObject(value)) throw new Error('invalid');
    const iteratorFactory = (
      value as {
        readonly [Symbol.asyncIterator]?: unknown;
      }
    )[Symbol.asyncIterator];
    if (typeof iteratorFactory !== 'function') throw new Error('invalid');
    const iterator = iteratorFactory.call(value) as unknown;
    if (
      !isObject(iterator) ||
      typeof (iterator as { readonly next?: unknown }).next !== 'function'
    ) {
      throw new Error('invalid');
    }
    return iterator as AsyncIterator<Uint8Array, void, undefined>;
  } catch {
    throw new SafeWorkerFailure('worker-original-unavailable');
  }
};

const discardLateIteratorResult = (
  result: IteratorResult<Uint8Array, void>,
): void => {
  if (result.done !== false || !(result.value instanceof Uint8Array)) return;
  result.value.fill(0);
};

const closeIterator = async (
  iterator: AsyncIterator<Uint8Array, void, undefined>,
): Promise<void> => {
  if (typeof iterator.return !== 'function') return;
  const cleanup = createDeadline(
    new AbortController().signal,
    FINANCE_DOCUMENT_EXTRACTION_WORKER_LIMITS.settlementTimeoutMs,
  );
  try {
    await awaitWithAbort(
      cleanup.signal,
      () => iterator.return!(),
      discardLateIteratorResult,
    );
  } catch {
    // Cleanup is best effort and must not replace a safe terminal result.
  } finally {
    cleanup.dispose();
  }
};

const hasExpectedHash = (document: Uint8Array, expected: string): boolean => {
  const actual = createHash('sha256').update(document).digest();
  const expectedBytes = Buffer.from(expected, 'hex');
  try {
    return (
      actual.byteLength === expectedBytes.byteLength &&
      timingSafeEqual(actual, expectedBytes)
    );
  } finally {
    actual.fill(0);
    expectedBytes.fill(0);
  }
};

const readAuthenticatedOriginal = async (
  bindings: WorkerBindings,
  claim: FinanceDocumentExtractionClaim,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  let aad: Uint8Array;
  try {
    aad = financeDocumentOriginalAssociatedData({
      householdId: claim.payloadScope.householdId,
      privateSpaceId: claim.payloadScope.privateSpaceId,
      ownerUserId: claim.payloadScope.ownerUserId,
    });
  } catch {
    throw new SafeWorkerFailure('worker-invalid-claim');
  }
  try {
    const source = await awaitWithAbort(signal, () =>
      bindings.read({
        metadata: claim.original.metadata,
        aad,
        signal,
      }),
    );
    const iterator = asAsyncIterator(source);
    const chunks: Uint8Array[] = [];
    let document: Uint8Array | undefined;
    let total = 0;
    try {
      while (true) {
        const next = await awaitWithAbort(
          signal,
          () => iterator.next(),
          discardLateIteratorResult,
        );
        if (!isObject(next) || typeof next.done !== 'boolean') {
          throw new SafeWorkerFailure('worker-original-unavailable');
        }
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) {
          throw new SafeWorkerFailure('worker-original-unavailable');
        }
        total += next.value.byteLength;
        if (total > claim.original.byteSize) {
          next.value.fill(0);
          throw new SafeWorkerFailure('worker-original-integrity-invalid');
        }
        const copied = new Uint8Array(next.value);
        next.value.fill(0);
        chunks.push(copied);
      }
      if (total !== claim.original.byteSize) {
        throw new SafeWorkerFailure('worker-original-integrity-invalid');
      }
      document = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        document.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (!hasExpectedHash(document, claim.original.metadata.plaintextSha256)) {
        document.fill(0);
        document = undefined;
        throw new SafeWorkerFailure('worker-original-integrity-invalid');
      }
      return document;
    } finally {
      for (const chunk of chunks) chunk.fill(0);
      await closeIterator(iterator);
    }
  } finally {
    aad.fill(0);
  }
};

const providerInputForOriginal = async (
  bindings: WorkerBindings,
  claim: FinanceDocumentExtractionClaim,
  original: Uint8Array,
  signal: AbortSignal,
): Promise<OpenAiFinanceDocumentExtractionInput> => {
  const file = (): OpenAiFinanceDocumentExtractionInput =>
    Object.freeze({
      kind: 'file' as const,
      document: original,
      mimeType: claim.original.mimeType,
    });
  if (claim.original.mimeType !== 'application/pdf') return file();

  let localResult: unknown;
  try {
    localResult = await awaitWithAbort(signal, () =>
      bindings.extractPdfText({
        document: original,
        pageCount: claim.original.pageCount!,
        signal,
      }),
    );
  } catch (error) {
    if (error instanceof WorkerAbort) throw error;
    return file();
  }
  const parsed = snapshotRecord(localResult, ['status', 'text'], ['status']);
  const text =
    parsed?.status === 'usable' ? usableLocalPdfText(parsed.text) : undefined;
  return text === undefined
    ? file()
    : Object.freeze({
        kind: 'text' as const,
        mimeType: 'application/pdf' as const,
        text,
      });
};

const parseUsage = (
  input: unknown,
): Readonly<{
  readonly inputTokens: number;
  readonly outputTokens: number;
}> => {
  if (input === undefined) {
    return Object.freeze({ inputTokens: 0, outputTokens: 0 });
  }
  const values = snapshotRecord(input, [
    'inputTokens',
    'outputTokens',
    'totalTokens',
  ]);
  if (
    values === undefined ||
    !validInteger(
      values.inputTokens,
      0,
      FINANCE_DOCUMENT_EXTRACTION_WORKER_LIMITS.maximumUsageTokens,
    ) ||
    !validInteger(
      values.outputTokens,
      0,
      FINANCE_DOCUMENT_EXTRACTION_WORKER_LIMITS.maximumUsageTokens,
    ) ||
    !validInteger(
      values.totalTokens,
      0,
      FINANCE_DOCUMENT_EXTRACTION_WORKER_LIMITS.maximumUsageTokens,
    ) ||
    values.totalTokens < values.inputTokens ||
    values.totalTokens < values.outputTokens
  ) {
    throw new SafeWorkerFailure('worker-provider-response-invalid');
  }
  return Object.freeze({
    inputTokens: values.inputTokens,
    outputTokens: values.outputTokens,
  });
};

const parseProviderResult = (input: unknown): ExtractedProviderResult => {
  const result = snapshotRecord(input, ['extraction', 'provider']);
  const provider =
    result === undefined
      ? undefined
      : snapshotRecord(
          result.provider,
          [
            'provider',
            'model',
            'attempts',
            'providerRequestIds',
            'retryReason',
            'usage',
          ],
          ['provider', 'model', 'attempts', 'providerRequestIds'],
        );
  if (
    result === undefined ||
    provider === undefined ||
    provider.provider !== 'openai' ||
    provider.model !== OPENAI_FINANCE_DOCUMENT_EXTRACTION_MODEL ||
    (provider.attempts !== 1 && provider.attempts !== 2) ||
    !Array.isArray(provider.providerRequestIds) ||
    provider.providerRequestIds.length > 2 ||
    provider.providerRequestIds.some(
      (value) =>
        typeof value !== 'string' || value.length < 1 || value.length > 512,
    ) ||
    (provider.retryReason !== undefined &&
      provider.retryReason !== 'low-confidence-scan' &&
      provider.retryReason !== 'unreadable-scan')
  ) {
    throw new SafeWorkerFailure('worker-provider-response-invalid');
  }
  let envelope: FinanceDocumentEnvelopeV1;
  let redactedEnvelope: FinanceDocumentEnvelopeV1;
  try {
    envelope = FinanceDocumentEnvelopeV1Schema.parse(result.extraction);
    redactedEnvelope = redactFinanceDocumentEnvelopeForReview(envelope);
  } catch {
    throw new SafeWorkerFailure('worker-extraction-invalid');
  }
  const usage = parseUsage(provider.usage);
  return Object.freeze({
    envelope,
    redactedEnvelope,
    attempts: provider.attempts,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
};

const stableJson = (value: unknown): string => {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SafeWorkerFailure('worker-extraction-invalid');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isPlainRecord(value)) {
    throw new SafeWorkerFailure('worker-extraction-invalid');
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
};

const responseHashFor = (envelope: FinanceDocumentEnvelopeV1): string =>
  createHash('sha256').update(stableJson(envelope), 'utf8').digest('hex');

const hasReadableValue = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return true;
  if (Array.isArray(value)) return value.length > 0;
  return isPlainRecord(value) && Object.keys(value).length > 0;
};

const redactedSummaryFor = (
  envelope: FinanceDocumentEnvelopeV1,
): Readonly<{
  readonly documentType: FinanceDocumentEnvelopeV1['documentType'];
  readonly sourceLocale: FinanceDocumentEnvelopeV1['sourceLocale'];
  readonly currency: string | null;
  readonly factCount: number;
  readonly chunkCount: 0;
  readonly evidenceCount: number;
  readonly safeStatus: 'ready-for-review' | 'no-readable-facts';
}> => {
  const evidenceCount = Math.min(
    512,
    envelope.facts.reduce((total, fact) => total + fact.evidence.length, 0),
  );
  const fields = Object.entries(envelope).filter(
    ([field]) =>
      ![
        'schemaVersion',
        'documentType',
        'sourceLocale',
        'currency',
        'facts',
      ].includes(field),
  );
  const hasReadableFacts =
    envelope.facts.length > 0 ||
    fields.some(([, value]) => hasReadableValue(value));
  return Object.freeze({
    documentType: envelope.documentType,
    sourceLocale: envelope.sourceLocale,
    currency: envelope.currency,
    factCount: envelope.facts.length,
    chunkCount: 0 as const,
    evidenceCount,
    safeStatus: hasReadableFacts ? 'ready-for-review' : 'no-readable-facts',
  });
};

const codeForError = (
  error: unknown,
  deadline: Deadline,
  callerSignal: AbortSignal,
): FinanceDocumentExtractionSafeErrorCode => {
  if (error instanceof SafeWorkerFailure) return error.safeErrorCode;
  if (deadline.didTimeout()) return 'worker-timeout';
  if (callerSignal.aborted || error instanceof WorkerAbort) {
    return 'worker-interrupted';
  }
  if (error instanceof OpenAiFinanceDocumentExtractionError) {
    switch (error.kind) {
      case 'credential-unavailable':
        return 'worker-provider-credential-unavailable';
      case 'invalid-request':
        return 'worker-provider-request-invalid';
      case 'provider-rejected':
        return 'worker-provider-rejected';
      case 'network':
      case 'provider-unavailable':
        return 'worker-provider-unavailable';
      case 'request-aborted':
      case 'timeout':
        return 'worker-timeout';
      case 'response-invalid':
      case 'response-too-large':
        return 'worker-provider-response-invalid';
    }
  }
  return 'worker-extraction-failed';
};

const settlementDeadline = (): Deadline =>
  createDeadline(
    new AbortController().signal,
    FINANCE_DOCUMENT_EXTRACTION_WORKER_LIMITS.settlementTimeoutMs,
  );

const recordFailure = async (
  bindings: WorkerBindings,
  identity: ClaimIdentity,
  safeErrorCode: FinanceDocumentExtractionSafeErrorCode,
): Promise<boolean> => {
  const deadline = settlementDeadline();
  try {
    const result = await awaitWithAbort(deadline.signal, () =>
      bindings.fail({
        ...identity,
        safeErrorCode,
        signal: deadline.signal,
      }),
    );
    return result === true;
  } catch {
    return false;
  } finally {
    deadline.dispose();
  }
};

const recordCompletion = async (
  bindings: WorkerBindings,
  input: Omit<
    Parameters<
      FinanceDocumentExtractionExecutor['completeFinanceDocumentExtraction']
    >[0],
    'signal'
  >,
): Promise<void> => {
  const deadline = settlementDeadline();
  try {
    const result = await awaitWithAbort(deadline.signal, () =>
      bindings.complete({ ...input, signal: deadline.signal }),
    );
    if (result !== true) {
      throw new SafeWorkerFailure('worker-completion-rejected');
    }
  } catch (error) {
    if (error instanceof SafeWorkerFailure) throw error;
    throw new CompletionIndeterminate();
  } finally {
    deadline.dispose();
  }
};

const runOnce = async (
  bindings: WorkerBindings,
  timeoutMs: number,
  input: unknown,
): Promise<FinanceDocumentExtractionRunResult> => {
  const callerSignal = parseRunSignal(input);
  if (callerSignal.aborted) throw new FinanceDocumentExtractionWorkerError();
  const deadline = createDeadline(callerSignal, timeoutMs);
  let claim: FinanceDocumentExtractionClaim | undefined;
  let identity: ClaimIdentity | undefined;
  let latestAttempt: 1 | 2 = 1;
  try {
    const rawClaim = await awaitWithAbort(deadline.signal, () =>
      bindings.claimNext({ signal: deadline.signal }),
    );
    if (rawClaim === undefined || rawClaim === null) {
      return Object.freeze({ status: 'idle' as const });
    }
    identity = parseClaimIdentity(rawClaim);
    claim = parseClaim(rawClaim);
    identity = Object.freeze({
      documentId: claim.documentId,
      extractionRevision: claim.extractionRevision,
      attempt: claim.attempt,
    });
    latestAttempt = claim.attempt;

    const original = await readAuthenticatedOriginal(
      bindings,
      claim,
      deadline.signal,
    );
    try {
      const providerInput = await providerInputForOriginal(
        bindings,
        claim,
        original,
        deadline.signal,
      );
      const rawExtraction = await awaitWithAbort(deadline.signal, () =>
        bindings.extract({
          input: providerInput,
          output: FINANCE_DOCUMENT_EXTRACTION_OUTPUT_CONTRACT,
          signal: deadline.signal,
          model: OPENAI_FINANCE_DOCUMENT_EXTRACTION_MODEL,
          timeoutMs,
        }),
      );
      const extraction = parseProviderResult(rawExtraction);
      latestAttempt = extraction.attempts;
      let encryptedPayload: EncryptedFinanceDocumentPayload;
      try {
        encryptedPayload = await awaitWithAbort(deadline.signal, () =>
          bindings.encrypt(extraction.redactedEnvelope, claim!.payloadScope),
        );
      } catch (error) {
        if (error instanceof WorkerAbort) throw error;
        throw new SafeWorkerFailure('worker-payload-encryption-failed');
      }
      const redactedSummary = redactedSummaryFor(extraction.redactedEnvelope);
      await recordCompletion(bindings, {
        documentId: claim.documentId,
        extractionRevision: claim.extractionRevision,
        attempt: extraction.attempts,
        encryptedPayload,
        redactedSummary,
        responseHash: responseHashFor(extraction.envelope),
        inputTokens: extraction.inputTokens,
        outputTokens: extraction.outputTokens,
        documentType: extraction.redactedEnvelope.documentType,
        sourceLocale: extraction.redactedEnvelope.sourceLocale,
        currency: extraction.redactedEnvelope.currency,
      });
      return Object.freeze({
        status: 'completed' as const,
        documentId: claim.documentId,
        extractionRevision: claim.extractionRevision,
        providerAttempts: extraction.attempts,
      });
    } finally {
      original.fill(0);
    }
  } catch (error) {
    if (error instanceof CompletionIndeterminate || identity === undefined) {
      throw new FinanceDocumentExtractionWorkerError();
    }
    const safeErrorCode = codeForError(error, deadline, callerSignal);
    const settled = await recordFailure(
      bindings,
      Object.freeze({ ...identity, attempt: latestAttempt }),
      safeErrorCode,
    );
    if (!settled) throw new FinanceDocumentExtractionWorkerError();
    return Object.freeze({
      status: 'failed' as const,
      documentId: identity.documentId,
      extractionRevision: identity.extractionRevision,
      safeErrorCode,
    });
  } finally {
    deadline.dispose();
  }
};

export const createFinanceDocumentExtractionWorker = (
  dependencies: FinanceDocumentExtractionWorkerDependencies,
): FinanceDocumentExtractionWorker => {
  const { bindings, timeoutMs } = captureBindings(dependencies);
  return Object.freeze({
    runOnce(input: { readonly signal: AbortSignal }) {
      return runOnce(bindings, timeoutMs, input);
    },
  });
};

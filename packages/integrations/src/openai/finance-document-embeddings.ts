import type { OpenAiFetch } from './fetch-transport.js';
import {
  isAbortSignal,
  isSafeProviderRequestId,
  snapshotPlainRecord,
} from './safety.js';

const OPENAI_API_BASE_URL = 'https://api.openai.com';
const EMBEDDINGS_ENDPOINT = '/v1/embeddings';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_USAGE_TOKENS = 100_000_000;

export const OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_MODEL =
  'text-embedding-3-small' as const;
export const OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_DIMENSIONS = 1_536 as const;

/**
 * These are deliberately tighter than the committed-chunk storage limits.
 * The caller must split reviewed text before committing it when necessary;
 * this adapter never creates or mutates document chunks.
 */
export const OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS = Object.freeze({
  maxChunksPerRequest: 32,
  maxInputCharactersPerChunk: 8_000,
  maxInputBytesPerChunk: 16 * 1024,
  maxInputCharactersPerRequest: 64_000,
  maxInputBytesPerRequest: 128 * 1024,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 60_000,
  /** Provider retry policy lives in the server job; this adapter dispatches once. */
  maxAttempts: 1,
} as const);

export type OpenAiFinanceDocumentEmbeddingsErrorKind =
  | 'invalid-request'
  | 'credential-unavailable'
  | 'request-aborted'
  | 'timeout'
  | 'network'
  | 'provider-rejected'
  | 'provider-unavailable'
  | 'response-too-large'
  | 'response-invalid';

/**
 * The caller may supply only text already committed after redaction and
 * review. This provider boundary intentionally has no document/file/storage
 * identifiers, so its result cannot be used to reconstruct source content.
 */
export interface OpenAiCommittedRedactedFinanceChunk {
  readonly content: string;
}

export interface OpenAiFinanceDocumentEmbeddingsRequest {
  readonly chunks: readonly OpenAiCommittedRedactedFinanceChunk[];
  readonly signal: AbortSignal;
  /** Defaults to 30 seconds and is bounded to one minute. */
  readonly timeoutMs?: number;
}

export type OpenAiFinanceDocumentEmbeddingsUsage = Readonly<{
  inputTokens: number;
  totalTokens: number;
}>;

/** This object contains identifiers, counts, and usage only; never chunk text. */
export type OpenAiFinanceDocumentEmbeddingsMetadata = Readonly<{
  provider: 'openai';
  model: typeof OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_MODEL;
  dimensions: typeof OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_DIMENSIONS;
  inputCount: number;
  attempts: 1;
  providerRequestIds: readonly string[];
  usage?: OpenAiFinanceDocumentEmbeddingsUsage;
}>;

export type OpenAiFinanceDocumentEmbeddingsResult = Readonly<{
  /** Positional correspondence with request.chunks is guaranteed. */
  vectors: readonly (readonly number[])[];
  provider: OpenAiFinanceDocumentEmbeddingsMetadata;
}>;

export class OpenAiFinanceDocumentEmbeddingsError extends Error {
  readonly kind: OpenAiFinanceDocumentEmbeddingsErrorKind;
  readonly httpStatus?: number;
  readonly retryable: boolean;
  readonly providerRequestId?: string;

  constructor(input: {
    readonly kind: OpenAiFinanceDocumentEmbeddingsErrorKind;
    readonly retryable: boolean;
    readonly httpStatus?: number;
    readonly providerRequestId?: string;
  }) {
    super('OpenAI finance document embeddings failed.');
    this.name = 'OpenAiFinanceDocumentEmbeddingsError';
    this.kind = input.kind;
    this.retryable = input.retryable;
    this.httpStatus = input.httpStatus;
    this.providerRequestId = input.providerRequestId;
    Object.freeze(this);
  }
}

type Deadline = Readonly<{
  signal: AbortSignal;
  didTimeout: () => boolean;
  dispose: () => void;
}>;

type ValidRequest = Readonly<{
  contents: readonly string[];
  signal: AbortSignal;
  timeoutMs: number;
}>;

type ParsedResponse = Readonly<{
  vectors: readonly (readonly number[])[];
  usage?: OpenAiFinanceDocumentEmbeddingsUsage;
}>;

const transportError = (
  kind: OpenAiFinanceDocumentEmbeddingsErrorKind,
  retryable: boolean,
  input: Readonly<{
    httpStatus?: number;
    providerRequestId?: string;
  }> = {},
) =>
  new OpenAiFinanceDocumentEmbeddingsError({
    kind,
    retryable,
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    ...(input.providerRequestId === undefined
      ? {}
      : { providerRequestId: input.providerRequestId }),
  });

const abortError = (deadline: Deadline) =>
  transportError(deadline.didTimeout() ? 'timeout' : 'request-aborted', true);

const isSafeTimeout = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxTimeoutMs;

const snapshotArray = (
  input: unknown,
  maximumLength: number,
): readonly unknown[] | undefined => {
  try {
    if (
      !Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > maximumLength
    ) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const length = Object.getOwnPropertyDescriptor(input, 'length');
    if (
      length === undefined ||
      typeof length.value !== 'number' ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      length.value > maximumLength
    ) {
      return undefined;
    }
    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.length !== length.value + 1 || !ownKeys.includes('length')) {
      return undefined;
    }
    const values: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const key = String(index);
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        return undefined;
      }
      values.push(descriptor.value as unknown);
    }
    return Object.freeze(values);
  } catch {
    return undefined;
  }
};

const validateRequest = (input: unknown): ValidRequest | undefined => {
  const request = snapshotPlainRecord(
    input,
    ['chunks', 'signal', 'timeoutMs'],
    ['chunks', 'signal'],
  );
  if (request === undefined || !isAbortSignal(request.signal)) return undefined;
  const chunks = snapshotArray(
    request.chunks,
    OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxChunksPerRequest,
  );
  if (chunks === undefined || chunks.length === 0) return undefined;
  let characterCount = 0;
  let byteCount = 0;
  const contents: string[] = [];
  for (const chunk of chunks) {
    const snapshot = snapshotPlainRecord(chunk, ['content']);
    const content = snapshot?.content;
    if (
      typeof content !== 'string' ||
      content.trim().length === 0 ||
      content.length >
        OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxInputCharactersPerChunk
    ) {
      return undefined;
    }
    const contentBytes = new TextEncoder().encode(content).byteLength;
    if (
      contentBytes >
      OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxInputBytesPerChunk
    ) {
      return undefined;
    }
    characterCount += content.length;
    byteCount += contentBytes;
    if (
      characterCount >
        OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxInputCharactersPerRequest ||
      byteCount >
        OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxInputBytesPerRequest
    ) {
      return undefined;
    }
    contents.push(content);
  }
  if (request.timeoutMs !== undefined && !isSafeTimeout(request.timeoutMs)) {
    return undefined;
  }
  return Object.freeze({
    contents: Object.freeze(contents),
    signal: request.signal,
    timeoutMs:
      request.timeoutMs ??
      OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.defaultTimeoutMs,
  });
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

const awaitWithDeadline = async <Value>(
  deadline: Deadline,
  operation: () => Value | Promise<Value>,
  onLateResolve?: (value: Value) => void,
): Promise<Value> => {
  if (deadline.signal.aborted) throw abortError(deadline);
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      deadline.signal.removeEventListener('abort', rejectAborted);
      callback();
    };
    const rejectAborted = () => finish(() => reject(abortError(deadline)));
    deadline.signal.addEventListener('abort', rejectAborted, { once: true });
    if (deadline.signal.aborted) {
      rejectAborted();
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
              // A response that resolved after cancellation is disposal-only.
            }
            return;
          }
          finish(() => resolve(value));
        },
        (error: unknown) => finish(() => reject(error)),
      );
  });
};

const cancelLateResponse = (value: unknown): void => {
  try {
    if (
      !(value instanceof Response) ||
      Object.getPrototypeOf(value) !== Response.prototype
    ) {
      return;
    }
    const cancellation = value.body?.cancel();
    if (cancellation !== undefined) void cancellation.catch(() => undefined);
  } catch {
    // Never read a response which won the race after cancellation.
  }
};

const zeroLateReadChunk = (value: unknown): void => {
  try {
    const snapshot = snapshotPlainRecord(value, ['done', 'value'], ['done']);
    const chunk = snapshot?.value;
    if (
      snapshot?.done === false &&
      chunk instanceof Uint8Array &&
      Object.getPrototypeOf(chunk) === Uint8Array.prototype
    ) {
      chunk.fill(0);
    }
  } catch {
    // Best-effort disposal of data received after cancellation.
  }
};

const safeRequestId = (response: Response): string | undefined => {
  const value = response.headers.get('x-request-id');
  return isSafeProviderRequestId(value) ? value : undefined;
};

const readBoundedBody = async (
  response: Response,
  deadline: Deadline,
): Promise<Uint8Array> => {
  const rawContentLength = response.headers.get('content-length');
  if (rawContentLength !== null) {
    const contentLength = Number(rawContentLength);
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxResponseBytes
    ) {
      try {
        if (response.body !== null) {
          await awaitWithDeadline(deadline, () => response.body!.cancel());
        }
      } catch {
        // Provider response data remains discarded on cancellation failure.
      }
      throw transportError('response-too-large', false);
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await awaitWithDeadline(
        deadline,
        () => reader.read(),
        zeroLateReadChunk,
      );
      if (next.done) break;
      total += next.value.byteLength;
      if (total > OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxResponseBytes) {
        await awaitWithDeadline(deadline, () => reader.cancel());
        throw transportError('response-too-large', false);
      }
      chunks.push(next.value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
      chunk.fill(0);
    }
    return result;
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    if (deadline.signal.aborted) void reader.cancel().catch(() => undefined);
    if (error instanceof OpenAiFinanceDocumentEmbeddingsError) throw error;
    throw transportError('network', true);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A late native read can temporarily retain its reader lock.
    }
  }
};

const parseBoundedJson = async (
  response: Response,
  deadline: Deadline,
): Promise<unknown> => {
  const contentType = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    try {
      if (response.body !== null) {
        await awaitWithDeadline(deadline, () => response.body!.cancel());
      }
    } catch {
      // Mismatched provider bodies are intentionally never read.
    }
    throw transportError('response-invalid', false);
  }
  const bytes = await readBoundedBody(response, deadline);
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw transportError('response-invalid', false);
  } finally {
    bytes.fill(0);
  }
};

const throwForResponse = async (
  response: Response,
  deadline: Deadline,
): Promise<never> => {
  try {
    if (response.body !== null) {
      await awaitWithDeadline(deadline, () => response.body!.cancel());
    }
  } catch {
    // Error response bodies are never parsed, logged, or returned.
  }
  if (deadline.signal.aborted) throw abortError(deadline);
  const httpStatus = response.status;
  const providerRequestId = safeRequestId(response);
  if (httpStatus === 408 || httpStatus === 504) {
    throw transportError('timeout', true, { httpStatus, providerRequestId });
  }
  if (httpStatus === 429 || httpStatus >= 500) {
    throw transportError('provider-unavailable', true, {
      httpStatus,
      providerRequestId,
    });
  }
  throw transportError('provider-rejected', false, {
    httpStatus,
    providerRequestId,
  });
};

const validUsage = (
  value: unknown,
): OpenAiFinanceDocumentEmbeddingsUsage | undefined => {
  const usage = snapshotPlainRecord(value, ['prompt_tokens', 'total_tokens']);
  const inputTokens = usage?.prompt_tokens;
  const totalTokens = usage?.total_tokens;
  if (
    ![inputTokens, totalTokens].every(
      (item) =>
        typeof item === 'number' &&
        Number.isSafeInteger(item) &&
        item >= 0 &&
        item <= MAX_USAGE_TOKENS,
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    inputTokens: inputTokens as number,
    totalTokens: totalTokens as number,
  });
};

const parseResponse = (
  body: unknown,
  expectedCount: number,
): ParsedResponse | undefined => {
  const response = snapshotPlainRecord(
    body,
    ['object', 'data', 'model', 'usage'],
    ['object', 'data', 'model'],
  );
  if (
    response?.object !== 'list' ||
    response.model !== OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_MODEL
  ) {
    return undefined;
  }
  const data = snapshotArray(response.data, expectedCount);
  if (data === undefined || data.length !== expectedCount) return undefined;
  const vectors: Array<readonly number[] | undefined> = Array.from(
    { length: expectedCount },
    () => undefined,
  );
  for (const item of data) {
    const entry = snapshotPlainRecord(item, ['object', 'embedding', 'index']);
    const index = entry?.index;
    const embedding = snapshotArray(
      entry?.embedding,
      OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_DIMENSIONS,
    );
    if (
      entry?.object !== 'embedding' ||
      typeof index !== 'number' ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= expectedCount ||
      vectors[index] !== undefined ||
      embedding === undefined ||
      embedding.length !== OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_DIMENSIONS ||
      !embedding.every(
        (value) => typeof value === 'number' && Number.isFinite(value),
      )
    ) {
      return undefined;
    }
    vectors[index] = Object.freeze([...embedding] as number[]);
  }
  if (vectors.some((value) => value === undefined)) return undefined;
  const usage =
    response.usage === undefined ? undefined : validUsage(response.usage);
  if (response.usage !== undefined && usage === undefined) return undefined;
  return Object.freeze({
    vectors: Object.freeze(vectors as readonly (readonly number[])[]),
    ...(usage === undefined ? {} : { usage }),
  });
};

const requestBody = (contents: readonly string[]): string =>
  JSON.stringify({
    model: OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_MODEL,
    input: contents,
    dimensions: OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_DIMENSIONS,
    encoding_format: 'float',
  });

export class OpenAiFetchFinanceDocumentEmbeddingsAdapter {
  readonly #fetch: OpenAiFetch;
  readonly #apiKey: string;

  constructor(input: { readonly fetch: OpenAiFetch; readonly apiKey: string }) {
    const options = snapshotPlainRecord(input, ['fetch', 'apiKey']);
    if (
      options === undefined ||
      typeof options.fetch !== 'function' ||
      typeof options.apiKey !== 'string' ||
      options.apiKey.length < 16 ||
      options.apiKey.length > 512 ||
      !/^[A-Za-z0-9_-]+$/u.test(options.apiKey)
    ) {
      throw new Error('invalid-openai-finance-document-embeddings-adapter');
    }
    this.#fetch = options.fetch as OpenAiFetch;
    this.#apiKey = options.apiKey;
  }

  async #dispatch(body: string, deadline: Deadline): Promise<Response> {
    try {
      return await awaitWithDeadline(
        deadline,
        () =>
          this.#fetch(`${OPENAI_API_BASE_URL}${EMBEDDINGS_ENDPOINT}`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.#apiKey}`,
              'content-type': 'application/json',
            },
            body,
            signal: deadline.signal,
          }),
        cancelLateResponse,
      );
    } catch (error) {
      if (error instanceof OpenAiFinanceDocumentEmbeddingsError) throw error;
      throw transportError(
        deadline.signal.aborted
          ? deadline.didTimeout()
            ? 'timeout'
            : 'request-aborted'
          : 'network',
        true,
      );
    }
  }

  async embed(
    request: OpenAiFinanceDocumentEmbeddingsRequest,
  ): Promise<OpenAiFinanceDocumentEmbeddingsResult> {
    const valid = validateRequest(request);
    if (valid === undefined) {
      throw transportError('invalid-request', false);
    }
    const deadline = createDeadline(valid.signal, valid.timeoutMs);
    try {
      if (deadline.signal.aborted) throw abortError(deadline);
      const response = await this.#dispatch(
        requestBody(valid.contents),
        deadline,
      );
      if (!response.ok) await throwForResponse(response, deadline);
      if (deadline.signal.aborted) throw abortError(deadline);
      const parsed = parseResponse(
        await parseBoundedJson(response, deadline),
        valid.contents.length,
      );
      if (parsed === undefined) throw transportError('response-invalid', false);
      const providerRequestId = safeRequestId(response);
      return Object.freeze({
        vectors: parsed.vectors,
        provider: Object.freeze({
          provider: 'openai' as const,
          model: OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_MODEL,
          dimensions: OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_DIMENSIONS,
          inputCount: valid.contents.length,
          attempts: 1 as const,
          providerRequestIds: Object.freeze(
            providerRequestId === undefined ? [] : [providerRequestId],
          ),
          ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
        }),
      });
    } finally {
      deadline.dispose();
    }
  }
}

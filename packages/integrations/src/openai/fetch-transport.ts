import {
  OPENAI_AUDIO_ENDPOINTS,
  OPENAI_AUDIO_LIMITS,
  OPENAI_ENDPOINT_SPEECH_MODELS,
  OPENAI_SPEECH_FORMATS,
  OPENAI_SPEECH_VOICES,
  OPENAI_TRANSCRIPTION_MIME_TYPES,
  OPENAI_TRANSCRIPTION_MODELS,
  type OpenAiAudioTransport,
  type OpenAiModelAvailabilityTransportResult,
  type OpenAiSpeechTransportRequest,
  type OpenAiSpeechTransportResponse,
  type OpenAiTranscriptionTransportRequest,
  type OpenAiTranscriptionTransportResponse,
} from './contracts.js';
import {
  isAbortSignal,
  isSafeProviderRequestId,
  snapshotPlainRecord,
} from './safety.js';
import { OpenAiAudioTransportError } from './transport-error.js';

const OPENAI_API_BASE_URL = 'https://api.openai.com';
const MAX_MODEL_RESPONSE_BYTES = 64 * 1024;

export type OpenAiFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

type ApiKeyProvider = () => string | Promise<string>;

const transportError = (
  kind: ConstructorParameters<typeof OpenAiAudioTransportError>[0]['kind'],
  retryable: boolean,
  input: Readonly<{
    httpStatus?: number;
    providerRequestId?: string;
  }> = {},
) =>
  new OpenAiAudioTransportError({
    kind,
    retryable,
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    ...(input.providerRequestId === undefined
      ? {}
      : { providerRequestId: input.providerRequestId }),
  });

const safeRequestId = (response: Response): string | undefined => {
  const value = response.headers.get('x-request-id');
  return isSafeProviderRequestId(value) ? value : undefined;
};

const awaitWithAbortSignal = async <Value>(
  signal: AbortSignal,
  operation: () => Value | Promise<Value>,
  onLateResolve?: (value: Value) => void,
): Promise<Value> => {
  if (signal.aborted) throw transportError('request-aborted', true);
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', rejectAborted);
      callback();
    };
    const rejectAborted = () =>
      finish(() => reject(transportError('request-aborted', true)));
    signal.addEventListener('abort', rejectAborted, { once: true });
    if (signal.aborted) {
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
              // A late value is disposal-only and never re-enters the request.
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
    // A late provider response is discarded without reading its body.
  }
};

const zeroLateReadChunk = (value: unknown): void => {
  try {
    const snapshot = snapshotPlainRecord(value, ['done', 'value'], ['done']);
    const chunk = snapshot?.value;
    if (snapshot?.done === false && isNormalUint8Array(chunk)) chunk.fill(0);
  } catch {
    // Disposal is best effort and never reflects late provider bytes.
  }
};

const throwForResponse = async (
  response: Response,
  signal: AbortSignal,
): Promise<never> => {
  try {
    if (response.body !== null) {
      await awaitWithAbortSignal(signal, () => response.body!.cancel());
    }
  } catch {
    // Error bodies are intentionally never read, logged, or returned.
  }
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

const readBoundedBody = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  const rawContentLength = response.headers.get('content-length');
  if (rawContentLength !== null) {
    const contentLength = Number(rawContentLength);
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > maxBytes
    ) {
      try {
        if (response.body !== null) {
          await awaitWithAbortSignal(signal, () => response.body!.cancel());
        }
      } catch {
        // Cancellation is best effort; no body bytes are retained here.
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
      const result = await awaitWithAbortSignal(
        signal,
        () => reader.read(),
        zeroLateReadChunk,
      );
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await awaitWithAbortSignal(signal, () => reader.cancel());
        throw transportError('response-too-large', false);
      }
      chunks.push(result.value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
      chunk.fill(0);
    }
    return body;
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    if (signal.aborted) void reader.cancel().catch(() => undefined);
    if (error instanceof OpenAiAudioTransportError) throw error;
    throw transportError('network', true);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A still-pending native read owns the lock until its late resolution.
    }
  }
};

const parseBoundedJson = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> => {
  const contentType = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    try {
      if (response.body !== null) {
        await awaitWithAbortSignal(signal, () => response.body!.cancel());
      }
    } catch {
      // Never inspect a mismatched response body.
    }
    throw transportError('response-invalid', false);
  }
  const bytes = await readBoundedBody(response, maxBytes, signal);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw transportError('response-invalid', false);
  } finally {
    bytes.fill(0);
  }
};

const isNormalUint8Array = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array &&
  Object.getPrototypeOf(value) === Uint8Array.prototype &&
  value.buffer instanceof ArrayBuffer;

const validTranscriptionRequest = (
  input: unknown,
): input is OpenAiTranscriptionTransportRequest => {
  const request = snapshotPlainRecord(
    input,
    [
      'model',
      'audio',
      'mimeType',
      'fileName',
      'language',
      'prompt',
      'responseFormat',
      'signal',
      'onDispatch',
    ],
    [
      'model',
      'audio',
      'mimeType',
      'fileName',
      'responseFormat',
      'signal',
      'onDispatch',
    ],
  );
  return (
    request !== undefined &&
    typeof request.model === 'string' &&
    (OPENAI_TRANSCRIPTION_MODELS as readonly string[]).includes(
      request.model,
    ) &&
    isNormalUint8Array(request.audio) &&
    request.audio.byteLength >= 1 &&
    request.audio.byteLength <= OPENAI_AUDIO_LIMITS.maxTranscriptionBytes &&
    typeof request.mimeType === 'string' &&
    (OPENAI_TRANSCRIPTION_MIME_TYPES as readonly string[]).includes(
      request.mimeType,
    ) &&
    typeof request.fileName === 'string' &&
    /^voice\.(?:flac|mp3|mp4|ogg|wav|webm)$/.test(request.fileName) &&
    (request.language === undefined ||
      (typeof request.language === 'string' &&
        /^[a-z]{2}$/.test(request.language))) &&
    (request.prompt === undefined ||
      (typeof request.prompt === 'string' && request.prompt.length <= 1_000)) &&
    request.responseFormat === 'json' &&
    isAbortSignal(request.signal) &&
    typeof request.onDispatch === 'function'
  );
};

const validSpeechRequest = (
  input: unknown,
): input is OpenAiSpeechTransportRequest => {
  const request = snapshotPlainRecord(
    input,
    [
      'model',
      'input',
      'voice',
      'instructions',
      'responseFormat',
      'speed',
      'signal',
      'onDispatch',
    ],
    ['model', 'input', 'voice', 'responseFormat', 'signal', 'onDispatch'],
  );
  return (
    request !== undefined &&
    typeof request.model === 'string' &&
    (OPENAI_ENDPOINT_SPEECH_MODELS as readonly string[]).includes(
      request.model,
    ) &&
    typeof request.input === 'string' &&
    request.input.length >= 1 &&
    request.input.length <= OPENAI_AUDIO_LIMITS.maxSpeechCharacters &&
    typeof request.voice === 'string' &&
    (OPENAI_SPEECH_VOICES as readonly string[]).includes(request.voice) &&
    typeof request.responseFormat === 'string' &&
    (OPENAI_SPEECH_FORMATS as readonly string[]).includes(
      request.responseFormat,
    ) &&
    (request.instructions === undefined ||
      (typeof request.instructions === 'string' &&
        request.instructions.length <=
          OPENAI_AUDIO_LIMITS.maxSpeechInstructionCharacters &&
        request.model !== 'tts-1' &&
        request.model !== 'tts-1-hd')) &&
    (request.speed === undefined ||
      (typeof request.speed === 'number' &&
        Number.isFinite(request.speed) &&
        request.speed >= 0.25 &&
        request.speed <= 4)) &&
    isAbortSignal(request.signal) &&
    typeof request.onDispatch === 'function'
  );
};

const knownAudioModel = (model: unknown): model is string =>
  typeof model === 'string' &&
  [...OPENAI_TRANSCRIPTION_MODELS, ...OPENAI_ENDPOINT_SPEECH_MODELS].includes(
    model as never,
  );

export class OpenAiFetchAudioTransport implements OpenAiAudioTransport {
  readonly #fetch: OpenAiFetch;
  readonly #getApiKey: ApiKeyProvider;

  constructor(input: {
    readonly fetch: OpenAiFetch;
    readonly getApiKey: ApiKeyProvider;
  }) {
    const options = snapshotPlainRecord(input, ['fetch', 'getApiKey']);
    if (
      options === undefined ||
      typeof options.fetch !== 'function' ||
      typeof options.getApiKey !== 'function'
    ) {
      throw new Error('invalid-openai-fetch-transport');
    }
    this.#fetch = options.fetch as OpenAiFetch;
    this.#getApiKey = options.getApiKey as ApiKeyProvider;
  }

  async #authorizationHeader(signal: AbortSignal): Promise<string> {
    if (signal.aborted) {
      throw transportError('request-aborted', true);
    }
    let apiKey: unknown;
    try {
      apiKey = await awaitWithAbortSignal(signal, () => this.#getApiKey());
    } catch (error) {
      if (error instanceof OpenAiAudioTransportError) throw error;
      throw transportError('credential-unavailable', false);
    }
    if (
      typeof apiKey !== 'string' ||
      apiKey.length < 16 ||
      apiKey.length > 512 ||
      !/^[A-Za-z0-9_-]+$/.test(apiKey)
    ) {
      throw transportError('credential-unavailable', false);
    }
    return `Bearer ${apiKey}`;
  }

  async #dispatchFetch(
    input: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    try {
      return await awaitWithAbortSignal(
        signal,
        () => this.#fetch(input, init),
        cancelLateResponse,
      );
    } catch (error) {
      if (error instanceof OpenAiAudioTransportError) throw error;
      throw transportError(
        signal.aborted ? 'request-aborted' : 'network',
        true,
      );
    }
  }

  async transcribe(
    request: OpenAiTranscriptionTransportRequest,
  ): Promise<OpenAiTranscriptionTransportResponse> {
    if (!validTranscriptionRequest(request)) {
      throw transportError('invalid-request', false);
    }
    const authorization = await this.#authorizationHeader(request.signal);
    const ownedAudio = new Uint8Array(request.audio);
    try {
      const form = new FormData();
      const arrayBuffer = ownedAudio.buffer.slice(
        ownedAudio.byteOffset,
        ownedAudio.byteOffset + ownedAudio.byteLength,
      );
      form.append(
        'file',
        new Blob([arrayBuffer], { type: request.mimeType }),
        request.fileName,
      );
      form.append('model', request.model);
      form.append('response_format', request.responseFormat);
      if (request.language !== undefined) {
        form.append('language', request.language);
      }
      if (request.prompt !== undefined) form.append('prompt', request.prompt);
      if (request.signal.aborted) {
        throw transportError('request-aborted', true);
      }
      await awaitWithAbortSignal(request.signal, request.onDispatch);
      const response = await this.#dispatchFetch(
        `${OPENAI_API_BASE_URL}${OPENAI_AUDIO_ENDPOINTS.transcription}`,
        {
          method: 'POST',
          headers: { authorization },
          body: form,
          signal: request.signal,
        },
        request.signal,
      );
      if (!response.ok) await throwForResponse(response, request.signal);
      return {
        body: await parseBoundedJson(
          response,
          OPENAI_AUDIO_LIMITS.maxTranscriptionResponseBytes,
          request.signal,
        ),
        ...(safeRequestId(response) === undefined
          ? {}
          : { providerRequestId: safeRequestId(response)! }),
      };
    } finally {
      ownedAudio.fill(0);
    }
  }

  async createSpeech(
    request: OpenAiSpeechTransportRequest,
  ): Promise<OpenAiSpeechTransportResponse> {
    if (!validSpeechRequest(request)) {
      throw transportError('invalid-request', false);
    }
    const authorization = await this.#authorizationHeader(request.signal);
    const body = JSON.stringify({
      model: request.model,
      input: request.input,
      voice: request.voice,
      ...(request.instructions === undefined
        ? {}
        : { instructions: request.instructions }),
      response_format: request.responseFormat,
      ...(request.speed === undefined ? {} : { speed: request.speed }),
    });
    if (request.signal.aborted) {
      throw transportError('request-aborted', true);
    }
    await awaitWithAbortSignal(request.signal, request.onDispatch);
    const response = await this.#dispatchFetch(
      `${OPENAI_API_BASE_URL}${OPENAI_AUDIO_ENDPOINTS.speech}`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
        },
        body,
        signal: request.signal,
      },
      request.signal,
    );
    if (!response.ok) await throwForResponse(response, request.signal);
    return {
      audio: await readBoundedBody(
        response,
        OPENAI_AUDIO_LIMITS.maxSpeechBytes,
        request.signal,
      ),
      contentType: response.headers.get('content-type') ?? '',
      ...(safeRequestId(response) === undefined
        ? {}
        : { providerRequestId: safeRequestId(response)! }),
    };
  }

  async checkModel(
    model: string,
    signal: AbortSignal,
  ): Promise<OpenAiModelAvailabilityTransportResult> {
    if (!knownAudioModel(model) || !isAbortSignal(signal)) {
      throw transportError('invalid-request', false);
    }
    const authorization = await this.#authorizationHeader(signal);
    const response = await this.#dispatchFetch(
      `${OPENAI_API_BASE_URL}/v1/models/${encodeURIComponent(model)}`,
      {
        method: 'GET',
        headers: { authorization },
        signal,
      },
      signal,
    );
    if (!response.ok) {
      try {
        if (response.body !== null) {
          await awaitWithAbortSignal(signal, () => response.body!.cancel());
        }
      } catch {
        // Provider error content is intentionally discarded.
      }
      const reason =
        response.status === 404
          ? ('not-found' as const)
          : response.status === 401 || response.status === 403
            ? ('access-denied' as const)
            : response.status === 429
              ? ('rate-limited' as const)
              : ('provider-unavailable' as const);
      return Object.freeze({ status: 'unavailable' as const, reason });
    }
    const body = await parseBoundedJson(
      response,
      MAX_MODEL_RESPONSE_BYTES,
      signal,
    );
    const snapshot = snapshotPlainRecord(
      body,
      ['id', 'object', 'created', 'owned_by'],
      ['id'],
    );
    if (snapshot?.id !== model) {
      throw transportError('response-invalid', false);
    }
    return Object.freeze({
      status: 'available' as const,
      resolvedModel: model,
    });
  }
}

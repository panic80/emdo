import {
  GoogleOAuthTransportFailure,
  type GoogleOAuthTransport,
} from './service.js';

export const GOOGLE_OAUTH_ENDPOINTS = Object.freeze({
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
} as const);

export const GOOGLE_OAUTH_FETCH_LIMITS = Object.freeze({
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 30_000,
  maxResponseBytes: 32 * 1024,
} as const);

export type GoogleOAuthFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

type PlainRecord = Readonly<Record<string, unknown>>;

const snapshotPlainRecord = (
  input: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = allowedKeys,
): PlainRecord | undefined => {
  try {
    if (input === null || typeof input !== 'object') return undefined;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(input);
    if (
      keys.some(
        (key) => typeof key !== 'string' || !allowedKeys.includes(key),
      ) ||
      requiredKeys.some((key) => !keys.includes(key))
    ) {
      return undefined;
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== 'string') return undefined;
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        return undefined;
      }
      result[key] = descriptor.value as unknown;
    }
    return Object.freeze(result);
  } catch {
    return undefined;
  }
};

const isBoundedPlainData = (input: unknown): boolean => {
  const pending: Array<{ value: unknown; depth: number; exit?: true }> = [
    { value: input, depth: 0 },
  ];
  const active = new WeakSet<object>();
  let nodes = 0;
  try {
    while (pending.length > 0) {
      const item = pending.pop()!;
      nodes += 1;
      if (nodes > 1_024 || item.depth > 16) return false;
      if (item.exit) {
        if (item.value !== null && typeof item.value === 'object') {
          active.delete(item.value);
        }
        continue;
      }
      if (item.value === null || typeof item.value !== 'object') continue;
      if (active.has(item.value)) return false;
      const prototype = Object.getPrototypeOf(item.value);
      if (
        !Array.isArray(item.value) &&
        prototype !== Object.prototype &&
        prototype !== null
      ) {
        return false;
      }
      active.add(item.value);
      pending.push({ value: item.value, depth: item.depth, exit: true });
      for (const key of Reflect.ownKeys(
        Object.getOwnPropertyDescriptors(item.value),
      )) {
        if (typeof key !== 'string') return false;
        const descriptor = Object.getOwnPropertyDescriptor(item.value, key);
        if (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          return false;
        }
        pending.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    }
  } catch {
    return false;
  }
  return true;
};

const failure = (
  reason: ConstructorParameters<typeof GoogleOAuthTransportFailure>[0],
): GoogleOAuthTransportFailure => new GoogleOAuthTransportFailure(reason);

const cancelBody = (response: Response): void => {
  try {
    const result = response.body?.cancel();
    if (result !== undefined) void result.catch(() => undefined);
  } catch {
    // Provider response bodies and cancellation failures are never exposed.
  }
};

const isExactResponse = (input: unknown): input is Response =>
  input instanceof Response &&
  Object.getPrototypeOf(input) === Response.prototype;

const isAbortSignal = (input: unknown): input is AbortSignal =>
  input instanceof AbortSignal;

const isString = (
  input: unknown,
  minimum: number,
  maximum: number,
): input is string =>
  typeof input === 'string' &&
  input.length >= minimum &&
  input.length <= maximum;

const isExactHttpsUrl = (input: unknown): input is string => {
  if (!isString(input, 1, 2_048)) return false;
  try {
    const url = new URL(input);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.toString() === input
    );
  } catch {
    return false;
  }
};

const validCommonTokenInput = (
  input: PlainRecord,
): input is PlainRecord & {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly signal?: AbortSignal;
} =>
  isString(input.clientId, 8, 512) &&
  isString(input.clientSecret, 16, 1_024) &&
  (input.signal === undefined || isAbortSignal(input.signal));

const awaitAbortable = async <Value>(input: {
  readonly signal: AbortSignal;
  readonly operation: () => Value | Promise<Value>;
  readonly disposeLate?: (value: Value) => void;
}): Promise<Value> => {
  if (input.signal.aborted) throw failure('temporarily-unavailable');
  let pending: Promise<Value>;
  try {
    pending = Promise.resolve(input.operation());
  } catch {
    throw failure('temporarily-unavailable');
  }
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): boolean => {
      if (settled) return false;
      settled = true;
      input.signal.removeEventListener('abort', abort);
      callback();
      return true;
    };
    const abort = () =>
      finish(() => reject(failure('temporarily-unavailable')));
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    pending.then(
      (value) => {
        if (!finish(() => resolve(value))) input.disposeLate?.(value);
      },
      () => finish(() => reject(failure('temporarily-unavailable'))),
    );
  });
};

const readBoundedJson = async (
  response: Response,
  signal: AbortSignal,
): Promise<unknown> => {
  const contentType = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    cancelBody(response);
    throw failure('provider-rejected');
  }
  const rawLength = response.headers.get('content-length');
  if (
    rawLength !== null &&
    (!/^[0-9]+$/.test(rawLength) ||
      Number(rawLength) > GOOGLE_OAUTH_FETCH_LIMITS.maxResponseBytes)
  ) {
    cancelBody(response);
    throw failure('provider-rejected');
  }
  if (response.body === null) throw failure('provider-rejected');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await awaitAbortable({
        signal,
        operation: () => reader.read(),
        disposeLate: (late) => {
          if (!late.done) late.value.fill(0);
          void reader.cancel().catch(() => undefined);
        },
      });
      if (part.done) break;
      total += part.value.byteLength;
      if (total > GOOGLE_OAUTH_FETCH_LIMITS.maxResponseBytes) {
        part.value.fill(0);
        void reader.cancel().catch(() => undefined);
        throw failure('provider-rejected');
      }
      const owned = new Uint8Array(part.value);
      part.value.fill(0);
      chunks.push(owned);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
      chunk.fill(0);
    }
    try {
      const parsed = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as unknown;
      if (!isBoundedPlainData(parsed)) throw failure('provider-rejected');
      return parsed;
    } catch {
      throw failure('provider-rejected');
    } finally {
      bytes.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    try {
      reader.releaseLock();
    } catch {
      // The response body is already detached or cancelled.
    }
  }
};

const providerErrorCode = (input: unknown): string | undefined => {
  const record = snapshotPlainRecord(
    input,
    ['error', 'error_description'],
    ['error'],
  );
  return record !== undefined && isString(record.error, 1, 160)
    ? record.error
    : undefined;
};

export class FetchGoogleOAuthTransport implements GoogleOAuthTransport {
  readonly #fetch: GoogleOAuthFetch;
  readonly #timeoutMs: number;

  constructor(input: {
    readonly fetch: GoogleOAuthFetch;
    readonly timeoutMs?: number;
  }) {
    const options = snapshotPlainRecord(
      input,
      ['fetch', 'timeoutMs'],
      ['fetch'],
    );
    if (
      options === undefined ||
      typeof options.fetch !== 'function' ||
      (options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) ||
          (options.timeoutMs as number) < 1 ||
          (options.timeoutMs as number) >
            GOOGLE_OAUTH_FETCH_LIMITS.maxTimeoutMs))
    ) {
      throw new Error('invalid-google-oauth-fetch-transport');
    }
    this.#fetch = options.fetch as GoogleOAuthFetch;
    this.#timeoutMs =
      (options.timeoutMs as number | undefined) ??
      GOOGLE_OAUTH_FETCH_LIMITS.defaultTimeoutMs;
  }

  async exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly signal?: AbortSignal;
  }): Promise<unknown> {
    const request = snapshotPlainRecord(
      input,
      [
        'code',
        'codeVerifier',
        'clientId',
        'clientSecret',
        'redirectUri',
        'signal',
      ],
      ['code', 'codeVerifier', 'clientId', 'clientSecret', 'redirectUri'],
    );
    if (
      request === undefined ||
      !validCommonTokenInput(request) ||
      !isString(request.code, 1, 512) ||
      !isString(request.codeVerifier, 43, 128) ||
      !/^[A-Za-z0-9._~-]+$/.test(request.codeVerifier) ||
      !isExactHttpsUrl(request.redirectUri)
    ) {
      throw failure('provider-rejected');
    }
    return this.#tokenRequest(
      new URLSearchParams({
        code: request.code,
        code_verifier: request.codeVerifier,
        client_id: request.clientId,
        client_secret: request.clientSecret,
        redirect_uri: request.redirectUri,
        grant_type: 'authorization_code',
      }),
      request.signal,
    );
  }

  async refreshAccessToken(input: {
    readonly refreshToken: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly signal?: AbortSignal;
  }): Promise<unknown> {
    const request = snapshotPlainRecord(
      input,
      ['refreshToken', 'clientId', 'clientSecret', 'signal'],
      ['refreshToken', 'clientId', 'clientSecret'],
    );
    if (
      request === undefined ||
      !validCommonTokenInput(request) ||
      !isString(request.refreshToken, 1, 2_048)
    ) {
      throw failure('provider-rejected');
    }
    return this.#tokenRequest(
      new URLSearchParams({
        refresh_token: request.refreshToken,
        client_id: request.clientId,
        client_secret: request.clientSecret,
        grant_type: 'refresh_token',
      }),
      request.signal,
    );
  }

  async revokeToken(input: {
    readonly token: string;
    readonly signal?: AbortSignal;
  }): Promise<unknown> {
    const request = snapshotPlainRecord(input, ['token', 'signal'], ['token']);
    if (
      request === undefined ||
      !isString(request.token, 1, 8_192) ||
      (request.signal !== undefined && !isAbortSignal(request.signal))
    ) {
      throw failure('provider-rejected');
    }
    await this.#request(
      GOOGLE_OAUTH_ENDPOINTS.revoke,
      new URLSearchParams({ token: request.token }),
      request.signal as AbortSignal | undefined,
      false,
    );
    return Object.freeze({ status: 'revoked' as const });
  }

  async #tokenRequest(
    body: URLSearchParams,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    return this.#request(
      GOOGLE_OAUTH_ENDPOINTS.token,
      body,
      callerSignal,
      true,
    );
  }

  async #request(
    endpoint: (typeof GOOGLE_OAUTH_ENDPOINTS)[keyof typeof GOOGLE_OAUTH_ENDPOINTS],
    form: URLSearchParams,
    callerSignal: AbortSignal | undefined,
    expectJson: boolean,
  ): Promise<unknown> {
    if (callerSignal?.aborted === true) {
      throw failure('temporarily-unavailable');
    }
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await awaitAbortable({
        signal: controller.signal,
        operation: () =>
          this.#fetch(endpoint, {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: form.toString(),
            cache: 'no-store',
            redirect: 'error',
            signal: controller.signal,
          }),
        disposeLate: (late) => {
          if (isExactResponse(late)) cancelBody(late);
        },
      });
      if (!isExactResponse(response)) {
        throw failure('temporarily-unavailable');
      }
      if (!response.ok) {
        if (
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500
        ) {
          cancelBody(response);
          throw failure('temporarily-unavailable');
        }
        if (expectJson && response.status === 400) {
          const body = await readBoundedJson(response, controller.signal);
          if (providerErrorCode(body) === 'invalid_grant') {
            throw failure('invalid-grant');
          }
        } else {
          cancelBody(response);
        }
        throw failure('provider-rejected');
      }
      if (!expectJson) {
        cancelBody(response);
        return Object.freeze({ status: 'ok' as const });
      }
      return await readBoundedJson(response, controller.signal);
    } catch (error) {
      if (error instanceof GoogleOAuthTransportFailure) throw error;
      throw failure('temporarily-unavailable');
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

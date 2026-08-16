import { deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

import {
  MapsTravelQuerySchema,
  MapsTravelResponseSchema,
  type MapsTravelQuery,
  type MapsTravelResponse,
} from './recorded.js';

export const GOOGLE_ROUTES_MATRIX_ENDPOINT =
  'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

export const GOOGLE_ROUTES_FIELD_MASK =
  'originIndex,destinationIndex,status,condition,duration';

export const GOOGLE_ROUTES_LIMITS = deepFreeze({
  maxResponseBytes: 64 * 1024,
  defaultTimeoutMs: 5_000,
  maxTimeoutMs: 30_000,
  maxDurationSeconds: 604_800,
});

export type GoogleRoutesFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type GoogleRoutesApiKeyProvider = () => string | Promise<string>;

const capturedGlobalFetch: GoogleRoutesFetch =
  globalThis.fetch.bind(globalThis);

export interface GoogleRoutesTravelTimeClientOptions {
  readonly fetch: GoogleRoutesFetch;
  readonly getApiKey: GoogleRoutesApiKeyProvider;
  readonly clock?: () => Date;
  readonly timeoutMs?: number;
  readonly endpoint?: typeof GOOGLE_ROUTES_MATRIX_ENDPOINT;
}

export interface GoogleRoutesLookupOptions {
  readonly signal?: AbortSignal;
}

export interface GoogleRoutesDeploymentClientOptions {
  readonly getApiKey: GoogleRoutesApiKeyProvider;
  readonly clock?: () => Date;
  readonly timeoutMs?: number;
}

const GoogleRouteElementSchema = z.looseObject({
  originIndex: z.literal(0),
  destinationIndex: z.literal(0),
  status: z.looseObject({
    code: z.number().int().safe().optional(),
  }),
  condition: z.enum([
    'ROUTE_MATRIX_ELEMENT_CONDITION_UNSPECIFIED',
    'ROUTE_EXISTS',
    'ROUTE_NOT_FOUND',
  ]),
  duration: z.string().max(64).optional(),
});

const GoogleRouteMatrixSchema = z.array(GoogleRouteElementSchema).length(1);

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
    const snapshot: Record<string, unknown> = {};
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
      snapshot[key] = descriptor.value as unknown;
    }
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
};

const isBoundedAcyclicPlainData = (input: unknown): boolean => {
  const pending: Array<{ value: unknown; depth: number; exit?: true }> = [
    { value: input, depth: 0 },
  ];
  const active = new WeakSet<object>();
  let nodes = 0;
  try {
    while (pending.length > 0) {
      const item = pending.pop()!;
      nodes += 1;
      if (nodes > 256 || item.depth > 16) return false;
      if (item.exit) {
        if (item.value !== null && typeof item.value === 'object') {
          active.delete(item.value);
        }
        continue;
      }
      if (item.value === null || typeof item.value !== 'object') {
        if (
          item.value === undefined ||
          typeof item.value === 'bigint' ||
          typeof item.value === 'function' ||
          typeof item.value === 'symbol'
        ) {
          return false;
        }
        continue;
      }
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
      const descriptors = Object.getOwnPropertyDescriptors(item.value);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') return false;
        const descriptor = descriptors[key];
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

const isAbortSignal = (value: unknown): value is AbortSignal =>
  value instanceof AbortSignal;

const safeUnavailable = (
  reason: 'no-route' | 'provider-unavailable' | 'timeout',
): MapsTravelResponse =>
  deepFreeze(MapsTravelResponseSchema.parse({ status: 'unavailable', reason }));

const isValidApiKey = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 20 &&
  value.length <= 512 &&
  /^[A-Za-z0-9_-]+$/.test(value);

const isExactResponse = (value: unknown): value is Response =>
  value instanceof Response &&
  Object.getPrototypeOf(value) === Response.prototype;

const cancelBody = (response: Response): void => {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation !== undefined) void cancellation.catch(() => undefined);
  } catch {
    // Provider bodies and cancellation errors are intentionally ignored.
  }
};

const awaitWithAbort = async <Value>(
  signal: AbortSignal,
  operation: () => Value | Promise<Value>,
): Promise<Value> => {
  if (signal.aborted) throw new Error('google-routes-aborted');
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', rejectAborted);
      callback();
    };
    const rejectAborted = () =>
      finish(() => reject(new Error('google-routes-aborted')));
    signal.addEventListener('abort', rejectAborted, { once: true });
    if (signal.aborted) {
      rejectAborted();
      return;
    }
    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish(() => resolve(value)),
        () => finish(() => reject(new Error('google-routes-operation-failed'))),
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
    throw new Error('google-routes-invalid-response');
  }

  const rawContentLength = response.headers.get('content-length');
  if (
    rawContentLength !== null &&
    (!/^[0-9]+$/.test(rawContentLength) ||
      Number(rawContentLength) > GOOGLE_ROUTES_LIMITS.maxResponseBytes)
  ) {
    cancelBody(response);
    throw new Error('google-routes-invalid-response');
  }

  if (response.body === null) {
    throw new Error('google-routes-invalid-response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const part = await awaitWithAbort(signal, () => reader.read());
      if (part.done) break;
      if (
        !(part.value instanceof Uint8Array) ||
        !(part.value.buffer instanceof ArrayBuffer)
      ) {
        throw new Error('google-routes-invalid-response');
      }
      totalBytes += part.value.byteLength;
      if (totalBytes > GOOGLE_ROUTES_LIMITS.maxResponseBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error('google-routes-invalid-response');
      }
      const owned = new Uint8Array(part.value.byteLength);
      owned.set(part.value);
      chunks.push(owned);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
      chunk.fill(0);
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return JSON.parse(text) as unknown;
    } finally {
      bytes.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
};

const parseDurationSeconds = (value: string): number | undefined => {
  const match = /^([0-9]+)(?:\.([0-9]{1,9}))?s$/.exec(value);
  if (match === null || match[1] === undefined) return undefined;
  try {
    let seconds = BigInt(match[1]);
    if (match[2] !== undefined && /[1-9]/.test(match[2])) seconds += 1n;
    if (seconds > BigInt(GOOGLE_ROUTES_LIMITS.maxDurationSeconds)) {
      return undefined;
    }
    return Number(seconds);
  } catch {
    return undefined;
  }
};

const providerMode = (
  mode: MapsTravelQuery['mode'],
): 'DRIVE' | 'TRANSIT' | 'WALK' => {
  if (mode === 'driving') return 'DRIVE';
  if (mode === 'transit') return 'TRANSIT';
  return 'WALK';
};

const buildProviderBody = (query: MapsTravelQuery): string => {
  const body: Record<string, unknown> = {
    origins: [{ waypoint: { address: query.origin } }],
    destinations: [{ waypoint: { address: query.destination } }],
    travelMode: providerMode(query.mode),
    departureTime: query.departureAt,
    languageCode: 'en-CA',
    regionCode: 'ca',
    units: 'METRIC',
  };
  if (query.mode === 'driving') body.routingPreference = 'TRAFFIC_AWARE';
  return JSON.stringify(body);
};

const validClockValue = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());

const hasBoundedQueryPrimitives = (input: PlainRecord): boolean =>
  typeof input.origin === 'string' &&
  input.origin.length >= 1 &&
  input.origin.length <= 512 &&
  typeof input.destination === 'string' &&
  input.destination.length >= 1 &&
  input.destination.length <= 512 &&
  typeof input.mode === 'string' &&
  input.mode.length <= 16 &&
  typeof input.departureAt === 'string' &&
  input.departureAt.length >= 1 &&
  input.departureAt.length <= 64;

/**
 * Production Google Routes adapter. It accepts only the fixed Routes API
 * matrix endpoint, obtains credentials from a server-side provider, and maps
 * every provider detail to the existing safe travel-time response contract.
 */
export class GoogleRoutesTravelTimeClient {
  readonly #fetch: GoogleRoutesFetch;
  readonly #getApiKey: GoogleRoutesApiKeyProvider;
  readonly #clock: () => Date;
  readonly #timeoutMs: number;
  readonly #endpoint: typeof GOOGLE_ROUTES_MATRIX_ENDPOINT;
  #deploymentLive = false;

  static createDeploymentClient(
    input: GoogleRoutesDeploymentClientOptions,
  ): GoogleRoutesTravelTimeClient {
    const options = snapshotPlainRecord(
      input,
      ['getApiKey', 'clock', 'timeoutMs'],
      ['getApiKey'],
    );
    if (options === undefined) {
      throw new Error('invalid-google-routes-configuration');
    }
    const client = new GoogleRoutesTravelTimeClient({
      fetch: capturedGlobalFetch,
      getApiKey: options.getApiKey as GoogleRoutesApiKeyProvider,
      ...(options.clock === undefined
        ? {}
        : { clock: options.clock as () => Date }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs as number }),
    });
    client.#deploymentLive = true;
    return client;
  }

  constructor(input: GoogleRoutesTravelTimeClientOptions) {
    const options = snapshotPlainRecord(
      input,
      ['fetch', 'getApiKey', 'clock', 'timeoutMs', 'endpoint'],
      ['fetch', 'getApiKey'],
    );
    if (
      options === undefined ||
      typeof options.fetch !== 'function' ||
      typeof options.getApiKey !== 'function' ||
      (options.clock !== undefined && typeof options.clock !== 'function') ||
      (options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) ||
          (options.timeoutMs as number) < 1 ||
          (options.timeoutMs as number) > GOOGLE_ROUTES_LIMITS.maxTimeoutMs))
    ) {
      throw new Error('invalid-google-routes-configuration');
    }
    if (
      options.endpoint !== undefined &&
      options.endpoint !== GOOGLE_ROUTES_MATRIX_ENDPOINT
    ) {
      throw new Error('invalid-google-routes-endpoint');
    }
    this.#fetch = options.fetch as GoogleRoutesFetch;
    this.#getApiKey = options.getApiKey as GoogleRoutesApiKeyProvider;
    this.#clock =
      (options.clock as (() => Date) | undefined) ?? (() => new Date());
    this.#timeoutMs =
      (options.timeoutMs as number | undefined) ??
      GOOGLE_ROUTES_LIMITS.defaultTimeoutMs;
    this.#endpoint = GOOGLE_ROUTES_MATRIX_ENDPOINT;
  }

  async lookup(
    input: unknown,
    rawOptions?: GoogleRoutesLookupOptions,
  ): Promise<MapsTravelResponse> {
    const querySnapshot = snapshotPlainRecord(input, [
      'origin',
      'destination',
      'mode',
      'departureAt',
    ]);
    if (
      querySnapshot === undefined ||
      !hasBoundedQueryPrimitives(querySnapshot)
    ) {
      return safeUnavailable('provider-unavailable');
    }
    const queryResult = MapsTravelQuerySchema.safeParse(querySnapshot);
    if (!queryResult.success) {
      return safeUnavailable('provider-unavailable');
    }

    let callerSignal: AbortSignal | undefined;
    if (rawOptions !== undefined) {
      const options = snapshotPlainRecord(rawOptions, ['signal'], []);
      if (
        options === undefined ||
        (options.signal !== undefined && !isAbortSignal(options.signal))
      ) {
        return safeUnavailable('provider-unavailable');
      }
      callerSignal = options.signal as AbortSignal | undefined;
    }
    if (callerSignal?.aborted === true) {
      return safeUnavailable('provider-unavailable');
    }

    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    const onCallerAbort = () => {
      callerAborted = true;
      controller.abort();
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);

    try {
      const apiKey = await awaitWithAbort(controller.signal, this.#getApiKey);
      if (!isValidApiKey(apiKey)) {
        return safeUnavailable('provider-unavailable');
      }
      const response = await awaitWithAbort(controller.signal, () =>
        this.#fetch(this.#endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': apiKey,
            'x-goog-fieldmask': GOOGLE_ROUTES_FIELD_MASK,
          },
          body: buildProviderBody(queryResult.data),
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
        }),
      );
      if (!isExactResponse(response)) {
        return safeUnavailable('provider-unavailable');
      }
      if (!response.ok) {
        cancelBody(response);
        return safeUnavailable(
          response.status === 408 || response.status === 504
            ? 'timeout'
            : 'provider-unavailable',
        );
      }

      const payload = await readBoundedJson(response, controller.signal);
      if (!isBoundedAcyclicPlainData(payload)) {
        return safeUnavailable('provider-unavailable');
      }
      const matrix = GoogleRouteMatrixSchema.safeParse(payload);
      if (!matrix.success) {
        return safeUnavailable('provider-unavailable');
      }
      const element = matrix.data[0]!;
      if (element.condition === 'ROUTE_NOT_FOUND') {
        return safeUnavailable('no-route');
      }
      if (
        element.condition !== 'ROUTE_EXISTS' ||
        (element.status.code !== undefined && element.status.code !== 0) ||
        element.duration === undefined
      ) {
        return safeUnavailable('provider-unavailable');
      }
      const durationSeconds = parseDurationSeconds(element.duration);
      if (durationSeconds === undefined) {
        return safeUnavailable('provider-unavailable');
      }
      const fetchedAt = this.#clock();
      if (!validClockValue(fetchedAt)) {
        return safeUnavailable('provider-unavailable');
      }
      return deepFreeze(
        MapsTravelResponseSchema.parse({
          status: 'available',
          durationSeconds,
          fetchedAt: new Date(fetchedAt.getTime()).toISOString(),
        }),
      );
    } catch {
      if (timedOut) return safeUnavailable('timeout');
      if (callerAborted) return safeUnavailable('provider-unavailable');
      return safeUnavailable('provider-unavailable');
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /** @internal Called through the module helper to prevent method shadowing. */
  isDeploymentLiveClient(): boolean {
    return this.#deploymentLive;
  }

  /** @internal Called through the module helper to prevent method shadowing. */
  lookupForDeploymentSmoke(
    input: MapsTravelQuery,
    options: GoogleRoutesLookupOptions,
  ): Promise<MapsTravelResponse> {
    if (!this.#deploymentLive) {
      throw new Error('google-routes-live-client-required');
    }
    return GoogleRoutesTravelTimeClient.prototype.lookup.call(
      this,
      input,
      options,
    );
  }
}

export const isGoogleRoutesDeploymentClient = (
  input: unknown,
): input is GoogleRoutesTravelTimeClient => {
  try {
    return (
      input instanceof GoogleRoutesTravelTimeClient &&
      Object.getPrototypeOf(input) === GoogleRoutesTravelTimeClient.prototype &&
      GoogleRoutesTravelTimeClient.prototype.isDeploymentLiveClient.call(input)
    );
  } catch {
    return false;
  }
};

export const lookupWithGoogleRoutesDeploymentClient = (
  client: GoogleRoutesTravelTimeClient,
  input: MapsTravelQuery,
  options: GoogleRoutesLookupOptions,
): Promise<MapsTravelResponse> =>
  GoogleRoutesTravelTimeClient.prototype.lookupForDeploymentSmoke.call(
    client,
    input,
    options,
  );

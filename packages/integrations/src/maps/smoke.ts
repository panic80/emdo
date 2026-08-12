import { deepFreeze } from '@emdo/contracts';

import {
  GoogleRoutesTravelTimeClient,
  isGoogleRoutesDeploymentClient,
  lookupWithGoogleRoutesDeploymentClient,
  type GoogleRoutesLookupOptions,
} from './google-routes.js';
import {
  MapsTravelResponseSchema,
  type MapsTravelQuery,
  type MapsTravelResponse,
} from './recorded.js';

const TORONTO_TIME_ZONE = 'America/Toronto';
const PUBLIC_SMOKE_ORIGIN = 'Toronto City Hall, 100 Queen St W, Toronto, ON';
const PUBLIC_SMOKE_DESTINATION = 'CN Tower, 290 Bremner Blvd, Toronto, ON';
const DEFAULT_SMOKE_TIMEOUT_MS = 10_000;
const MAX_SMOKE_TIMEOUT_MS = 30_000;

export const GOOGLE_ROUTES_DEPLOYMENT_SMOKE_CONTRACT = deepFreeze({
  schemaVersion: 1 as const,
  liveProviderRequired: true as const,
  fixturePolicy: 'public-toronto-landmarks' as const,
  readyEvidenceClass: 'credentialed-live-endpoint' as const,
  persistedFields: [
    'provider',
    'operation',
    'checkedAt',
    'status',
    'evidenceClass',
    'latencyMs',
  ] as const,
});

export interface GoogleRoutesSmokeClient {
  lookup(
    input: MapsTravelQuery,
    options?: GoogleRoutesLookupOptions,
  ): Promise<MapsTravelResponse>;
}

interface GoogleRoutesSmokeTimingOptions {
  readonly clock?: () => Date;
  readonly monotonicNowMs?: () => number;
  readonly timeoutMs?: number;
}

export interface GoogleRoutesFixtureSmokeOptions extends GoogleRoutesSmokeTimingOptions {
  readonly client: GoogleRoutesSmokeClient;
}

export interface GoogleRoutesDeploymentSmokeOptions extends GoogleRoutesSmokeTimingOptions {
  readonly client: GoogleRoutesTravelTimeClient;
}

type GoogleRoutesSmokeSafeReason =
  | 'no-route'
  | 'provider-unavailable'
  | 'timeout'
  | 'live-client-required'
  | 'smoke-run-failed';

export type GoogleRoutesDeploymentSmokeResult = Readonly<
  | {
      schemaVersion: 1;
      provider: 'google-routes';
      operation: 'travel-time';
      checkedAt: string;
      status: 'ready';
      evidenceClass: 'credentialed-live-endpoint';
      latencyMs: number;
    }
  | {
      schemaVersion: 1;
      provider: 'google-routes';
      operation: 'travel-time';
      checkedAt: string;
      status: 'unavailable';
      evidenceClass: 'credentialed-live-endpoint' | 'not-live';
      latencyMs: number;
      safeReason: GoogleRoutesSmokeSafeReason;
    }
>;

export type GoogleRoutesFixtureSmokeResult = Readonly<
  | {
      schemaVersion: 1;
      provider: 'google-routes';
      operation: 'travel-time';
      checkedAt: string;
      status: 'simulated';
      evidenceClass: 'recorded-fixture';
      latencyMs: number;
    }
  | {
      schemaVersion: 1;
      provider: 'google-routes';
      operation: 'travel-time';
      checkedAt: string;
      status: 'unavailable';
      evidenceClass: 'recorded-fixture';
      latencyMs: number;
      safeReason: GoogleRoutesSmokeSafeReason;
    }
>;

class SmokeDeadlineError extends Error {}

type SmokeOptionsSnapshot = Readonly<{
  client: unknown;
  clock?: unknown;
  monotonicNowMs?: unknown;
  timeoutMs?: unknown;
}>;

const snapshotSmokeOptions = (
  input: unknown,
): SmokeOptionsSnapshot | undefined => {
  try {
    if (input === null || typeof input !== 'object') return undefined;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const allowedKeys = ['client', 'clock', 'monotonicNowMs', 'timeoutMs'];
    const keys = Reflect.ownKeys(input);
    if (
      !keys.includes('client') ||
      keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))
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
    return Object.freeze(snapshot) as SmokeOptionsSnapshot;
  } catch {
    return undefined;
  }
};

const validDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());

const safeMonotonicValue = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

const validTimeout = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= MAX_SMOKE_TIMEOUT_MS;

const formatTorontoInstant = (date: Date): string => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TORONTO_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    timeZoneName: 'longOffset',
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const offset = parts.timeZoneName?.replace(/^GMT/, '');
  if (
    !/^\d{4}$/.test(parts.year ?? '') ||
    !/^\d{2}$/.test(parts.month ?? '') ||
    !/^\d{2}$/.test(parts.day ?? '') ||
    !/^\d{2}$/.test(parts.hour ?? '') ||
    !/^\d{2}$/.test(parts.minute ?? '') ||
    !/^\d{2}$/.test(parts.second ?? '') ||
    !/^\d{3}$/.test(parts.fractionalSecond ?? '') ||
    !/^[+-]\d{2}:\d{2}$/.test(offset ?? '')
  ) {
    throw new Error('google-routes-time-zone-unavailable');
  }
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}`;
};

const safeLatency = (startedAt: number, finishedAt: number): number => {
  const latency = Math.ceil(finishedAt - startedAt);
  return Number.isSafeInteger(latency) && latency >= 0
    ? Math.min(latency, 86_400_000)
    : 0;
};

const bindLookup = (client: unknown): GoogleRoutesSmokeClient['lookup'] => {
  if (client === null || typeof client !== 'object') {
    throw new Error('invalid-google-routes-smoke-client');
  }
  let cursor: object | null = client;
  while (cursor !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, 'lookup');
    if (descriptor !== undefined) {
      if (
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        typeof descriptor.value !== 'function'
      ) {
        throw new Error('invalid-google-routes-smoke-client');
      }
      return descriptor.value.bind(client) as GoogleRoutesSmokeClient['lookup'];
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  throw new Error('invalid-google-routes-smoke-client');
};

const awaitWithDeadline = async <Value>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<Value>,
): Promise<Value> => {
  const controller = new AbortController();
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(new SmokeDeadlineError()));
    }, timeoutMs);
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => finish(() => resolve(value)),
        () => finish(() => reject(new Error('google-routes-smoke-failed'))),
      );
  });
};

const makeSmokeContext = (options: GoogleRoutesSmokeTimingOptions) => {
  const clock = options.clock ?? (() => new Date());
  const monotonicNowMs = options.monotonicNowMs ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS;
  if (typeof clock !== 'function' || typeof monotonicNowMs !== 'function') {
    throw new Error('invalid-google-routes-smoke-options');
  }
  if (!validTimeout(timeoutMs)) {
    throw new Error('invalid-google-routes-smoke-timeout');
  }
  const checkedDate = clock();
  if (!validDate(checkedDate)) {
    throw new Error('google-routes-invalid-smoke-clock');
  }
  const checkedInstant = new Date(checkedDate.getTime());
  const query: MapsTravelQuery = {
    origin: PUBLIC_SMOKE_ORIGIN,
    destination: PUBLIC_SMOKE_DESTINATION,
    mode: 'walking',
    departureAt: formatTorontoInstant(
      new Date(checkedInstant.getTime() + 5 * 60 * 1_000),
    ),
  };
  return {
    checkedAt: checkedInstant.toISOString(),
    monotonicNowMs,
    query,
    timeoutMs,
  };
};

const failedFixtureResult = (
  checkedAt: string,
  latencyMs: number,
  safeReason: GoogleRoutesSmokeSafeReason,
): GoogleRoutesFixtureSmokeResult =>
  deepFreeze({
    schemaVersion: 1 as const,
    provider: 'google-routes' as const,
    operation: 'travel-time' as const,
    checkedAt,
    status: 'unavailable' as const,
    evidenceClass: 'recorded-fixture' as const,
    latencyMs,
    safeReason,
  });

export const runGoogleRoutesFixtureSmoke = async (
  input: GoogleRoutesFixtureSmokeOptions,
): Promise<GoogleRoutesFixtureSmokeResult> => {
  let checkedAt = new Date().toISOString();
  let startedAt = 0;
  let monotonicNowMs = () => 0;
  try {
    const options = snapshotSmokeOptions(input);
    if (options === undefined) {
      throw new Error('invalid-google-routes-smoke-options');
    }
    const context = makeSmokeContext(options as GoogleRoutesSmokeTimingOptions);
    checkedAt = context.checkedAt;
    monotonicNowMs = context.monotonicNowMs;
    const lookup = bindLookup(options.client);
    startedAt = safeMonotonicValue(monotonicNowMs());
    const rawResult = await awaitWithDeadline(context.timeoutMs, (signal) =>
      lookup(context.query, { signal }),
    );
    const finishedAt = safeMonotonicValue(monotonicNowMs());
    const result = MapsTravelResponseSchema.safeParse(rawResult);
    if (!result.success) {
      return failedFixtureResult(
        checkedAt,
        safeLatency(startedAt, finishedAt),
        'smoke-run-failed',
      );
    }
    if (result.data.status === 'available') {
      return deepFreeze({
        schemaVersion: 1 as const,
        provider: 'google-routes' as const,
        operation: 'travel-time' as const,
        checkedAt,
        status: 'simulated' as const,
        evidenceClass: 'recorded-fixture' as const,
        latencyMs: safeLatency(startedAt, finishedAt),
      });
    }
    return failedFixtureResult(
      checkedAt,
      safeLatency(startedAt, finishedAt),
      result.data.reason,
    );
  } catch (error) {
    let finishedAt = startedAt;
    try {
      finishedAt = safeMonotonicValue(monotonicNowMs());
    } catch {
      // Operational timing failure is reduced to a safe zero latency.
    }
    return failedFixtureResult(
      checkedAt,
      safeLatency(startedAt, finishedAt),
      error instanceof SmokeDeadlineError ? 'timeout' : 'smoke-run-failed',
    );
  }
};

/**
 * Credentialed deployment-only smoke. A ready result is possible only for a
 * client created by `createDeploymentClient`, which captures the runtime's
 * global fetch and accepts only a server-side API key provider.
 */
export const runGoogleRoutesDeploymentSmoke = async (
  input: GoogleRoutesDeploymentSmokeOptions,
): Promise<GoogleRoutesDeploymentSmokeResult> => {
  let checkedAt = new Date().toISOString();
  let startedAt = 0;
  let monotonicNowMs = () => 0;
  const options = snapshotSmokeOptions(input);
  if (
    options === undefined ||
    !isGoogleRoutesDeploymentClient(options.client)
  ) {
    return deepFreeze({
      schemaVersion: 1 as const,
      provider: 'google-routes' as const,
      operation: 'travel-time' as const,
      checkedAt,
      status: 'unavailable' as const,
      evidenceClass: 'not-live' as const,
      latencyMs: 0,
      safeReason: 'live-client-required' as const,
    });
  }
  try {
    const context = makeSmokeContext(options as GoogleRoutesSmokeTimingOptions);
    checkedAt = context.checkedAt;
    monotonicNowMs = context.monotonicNowMs;
    startedAt = safeMonotonicValue(monotonicNowMs());
    const rawResult = await awaitWithDeadline(context.timeoutMs, (signal) =>
      lookupWithGoogleRoutesDeploymentClient(
        options.client as GoogleRoutesTravelTimeClient,
        context.query,
        { signal },
      ),
    );
    const finishedAt = safeMonotonicValue(monotonicNowMs());
    const latencyMs = safeLatency(startedAt, finishedAt);
    const result = MapsTravelResponseSchema.safeParse(rawResult);
    if (!result.success) throw new Error('google-routes-invalid-smoke-result');
    if (result.data.status === 'available') {
      return deepFreeze({
        schemaVersion: 1 as const,
        provider: 'google-routes' as const,
        operation: 'travel-time' as const,
        checkedAt,
        status: 'ready' as const,
        evidenceClass: 'credentialed-live-endpoint' as const,
        latencyMs,
      });
    }
    return deepFreeze({
      schemaVersion: 1 as const,
      provider: 'google-routes' as const,
      operation: 'travel-time' as const,
      checkedAt,
      status: 'unavailable' as const,
      evidenceClass: 'credentialed-live-endpoint' as const,
      latencyMs,
      safeReason: result.data.reason,
    });
  } catch (error) {
    let finishedAt = startedAt;
    try {
      finishedAt = safeMonotonicValue(monotonicNowMs());
    } catch {
      // Operational timing failure is reduced to a safe zero latency.
    }
    return deepFreeze({
      schemaVersion: 1 as const,
      provider: 'google-routes' as const,
      operation: 'travel-time' as const,
      checkedAt,
      status: 'unavailable' as const,
      evidenceClass: 'credentialed-live-endpoint' as const,
      latencyMs: safeLatency(startedAt, finishedAt),
      safeReason:
        error instanceof SmokeDeadlineError
          ? ('timeout' as const)
          : ('smoke-run-failed' as const),
    });
  }
};

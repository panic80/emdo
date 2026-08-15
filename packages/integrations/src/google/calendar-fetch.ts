import { createHash } from 'node:crypto';

import {
  EffectiveAuthorizationScopeFingerprintSchema,
  deepFreeze,
  type DeepReadonly,
  type EffectiveAuthorizationScopeFingerprint,
} from '@emdo/contracts';
import { z } from 'zod';

import {
  isGoogleCalendarWriteAuthorized,
  type ApprovedCalendarWriteContext,
  type GoogleCalendarConditionalGateway,
  type GoogleCalendarProviderState,
  type GoogleCalendarWriteCommand,
} from './calendar-write.js';
import type {
  GoogleCalendarAuthorizationPurpose,
  GoogleCalendarOAuthActor,
} from './oauth/service.js';

const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

export const GOOGLE_CALENDAR_API_ENDPOINTS = Object.freeze({
  calendarList: `${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList`,
  freeBusy: `${GOOGLE_CALENDAR_API_BASE}/freeBusy`,
} as const);

export const GOOGLE_CALENDAR_FETCH_LIMITS = Object.freeze({
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 30_000,
  maxResponseBytes: 512 * 1024,
  maxPages: 10,
  pageSize: 250,
  maxCalendars: 1_000,
  maxEvents: 2_500,
  maxFreeBusyCalendars: 50,
  maxBusyIntervalsPerCalendar: 1_000,
  maxFreeBusyWindowMs: 31 * 24 * 60 * 60 * 1_000,
  maxEventWindowMs: 366 * 24 * 60 * 60 * 1_000,
  credentialExpirySkewMs: 60_000,
} as const);

export type GoogleCalendarFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface GoogleCalendarCredentialBroker {
  acquireAccessTokenForCapability(input: {
    readonly actor: GoogleCalendarOAuthActor;
    readonly capability: GoogleCalendarAuthorizationPurpose;
  }): Promise<unknown>;
}

const ReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      }),
    'Reference contains control characters',
  );
// Provider-created and recurring-instance IDs are opaque. The base32hex
// restriction is enforced separately only when EMDO supplies an ID on create.
const EventIdSchema = ReferenceSchema;
const VersionSchema = z.string().trim().min(1).max(512);
const DateTimeSchema = z.iso.datetime({ offset: true });
const ActorSchema: z.ZodType<GoogleCalendarOAuthActor> = z.strictObject({
  userId: ReferenceSchema,
  householdId: ReferenceSchema,
  privateSpaceId: ReferenceSchema,
  sessionId: ReferenceSchema,
});
const AccessTokenLeaseSchema = z.strictObject({
  accessToken: z.string().min(1).max(8_192),
  grantReference: z.string().min(16).max(160),
  authorizationEpoch: z.number().int().safe().nonnegative(),
  expiresAt: DateTimeSchema,
});

type AccessTokenLease = z.infer<typeof AccessTokenLeaseSchema>;
interface CredentialSession {
  readonly actor: GoogleCalendarOAuthActor;
  readonly capability: GoogleCalendarAuthorizationPurpose;
  readonly grantReference: string;
  readonly authorizationEpoch: number;
  currentLease: AccessTokenLease;
}
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

const snapshotDataMethod = (
  input: unknown,
  name: string,
): ((...arguments_: unknown[]) => unknown) | undefined => {
  try {
    if (
      input === null ||
      (typeof input !== 'object' && typeof input !== 'function')
    ) {
      return undefined;
    }
    let current: object | null = input as object;
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
        return descriptor.value.bind(input) as (
          ...arguments_: unknown[]
        ) => unknown;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return undefined;
  }
  return undefined;
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
      if (nodes > 20_000 || item.depth > 24) return false;
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

const snapshotBoundedInput = (
  input: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = allowedKeys,
): PlainRecord | undefined => {
  const snapshot = snapshotPlainRecord(input, allowedKeys, requiredKeys);
  if (snapshot === undefined) return undefined;
  const withoutSignal = Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => key !== 'signal'),
  );
  return isBoundedPlainData(withoutSignal) ? snapshot : undefined;
};

const isExactResponse = (input: unknown): input is Response =>
  input instanceof Response &&
  Object.getPrototypeOf(input) === Response.prototype;

const isAbortSignal = (input: unknown): input is AbortSignal =>
  input instanceof AbortSignal;

const cancelBody = (response: Response): void => {
  try {
    const result = response.body?.cancel();
    if (result !== undefined) void result.catch(() => undefined);
  } catch {
    // Provider bodies and cancellation errors are intentionally discarded.
  }
};

type GoogleCalendarFetchErrorKind =
  | 'credential-unavailable'
  | 'dispatch-not-authorized'
  | 'request-aborted'
  | 'timeout'
  | 'provider-unavailable'
  | 'provider-rejected'
  | 'response-invalid'
  | 'response-too-large';

export class GoogleCalendarFetchError extends Error {
  override readonly name = 'GoogleCalendarFetchError';

  constructor(
    readonly kind: GoogleCalendarFetchErrorKind,
    readonly dispatched: boolean,
  ) {
    super('Google Calendar provider request failed');
  }
}

const awaitAbortable = async <Value>(input: {
  readonly signal: AbortSignal;
  readonly operation: () => Value | Promise<Value>;
  readonly error: () => GoogleCalendarFetchError;
  readonly disposeLate?: (value: Value) => void;
}): Promise<Value> => {
  if (input.signal.aborted) throw input.error();
  let pending: Promise<Value>;
  try {
    pending = Promise.resolve(input.operation());
  } catch {
    throw input.error();
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
    const abort = () => finish(() => reject(input.error()));
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    pending.then(
      (value) => {
        if (!finish(() => resolve(value))) input.disposeLate?.(value);
      },
      () => finish(() => reject(input.error())),
    );
  });
};

const readBoundedJson = async (
  response: Response,
  signal: AbortSignal,
  errorKind: () => GoogleCalendarFetchError,
): Promise<unknown> => {
  const contentType = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    cancelBody(response);
    throw new GoogleCalendarFetchError('response-invalid', true);
  }
  const rawLength = response.headers.get('content-length');
  if (
    rawLength !== null &&
    (!/^[0-9]+$/.test(rawLength) ||
      Number(rawLength) > GOOGLE_CALENDAR_FETCH_LIMITS.maxResponseBytes)
  ) {
    cancelBody(response);
    throw new GoogleCalendarFetchError('response-too-large', true);
  }
  if (response.body === null) {
    throw new GoogleCalendarFetchError('response-invalid', true);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await awaitAbortable({
        signal,
        operation: () => reader.read(),
        error: errorKind,
        disposeLate: (late) => {
          if (!late.done) late.value.fill(0);
          void reader.cancel().catch(() => undefined);
        },
      });
      if (part.done) break;
      total += part.value.byteLength;
      if (total > GOOGLE_CALENDAR_FETCH_LIMITS.maxResponseBytes) {
        part.value.fill(0);
        void reader.cancel().catch(() => undefined);
        throw new GoogleCalendarFetchError('response-too-large', true);
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
      const value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as unknown;
      if (!isBoundedPlainData(value)) {
        throw new GoogleCalendarFetchError('response-invalid', true);
      }
      return value;
    } catch (error) {
      if (error instanceof GoogleCalendarFetchError) throw error;
      throw new GoogleCalendarFetchError('response-invalid', true);
    } finally {
      bytes.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    try {
      reader.releaseLock();
    } catch {
      // The body may already be cancelled.
    }
  }
};

const safeRequestReference = (response: Response): string | undefined => {
  for (const name of ['x-goog-request-id', 'x-request-id']) {
    const value = response.headers.get(name);
    if (
      value !== null &&
      value.length >= 1 &&
      value.length <= 240 &&
      /^[A-Za-z0-9._:-]+$/.test(value)
    ) {
      return value;
    }
  }
  return undefined;
};

interface HttpResult {
  readonly status: number;
  readonly body?: unknown;
  readonly requestReference?: string;
}

interface HttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly parseJsonStatuses?: readonly number[];
  readonly signal?: AbortSignal;
  /** Forces the trusted broker to revalidate the grant immediately pre-write. */
  readonly revalidateCredentialAtDispatch?: boolean;
  /** Synchronous trusted-policy guard evaluated at the dispatch boundary. */
  readonly authorizeDispatch?: (lease: AccessTokenLease) => boolean;
}

class GoogleCalendarHttpClient {
  readonly #fetch: GoogleCalendarFetch;
  readonly #broker: GoogleCalendarCredentialBroker;
  readonly #timeoutMs: number;
  readonly #clock: () => Date;

  constructor(options: {
    readonly fetch: GoogleCalendarFetch;
    readonly broker: GoogleCalendarCredentialBroker;
    readonly timeoutMs: number;
    readonly clock: () => Date;
  }) {
    this.#fetch = options.fetch;
    this.#broker = options.broker;
    this.#timeoutMs = options.timeoutMs;
    this.#clock = options.clock;
  }

  async withCredential<Value>(input: {
    readonly actor: GoogleCalendarOAuthActor;
    readonly capability: GoogleCalendarAuthorizationPurpose;
    readonly signal?: AbortSignal;
    readonly operation: (session: CredentialSession) => Promise<Value>;
  }): Promise<Value> {
    if (input.signal?.aborted === true) {
      throw new GoogleCalendarFetchError('request-aborted', false);
    }
    const lease = await this.#acquireLease(
      input.actor,
      input.capability,
      input.signal,
    );
    return input.operation({
      actor: input.actor,
      capability: input.capability,
      grantReference: lease.grantReference,
      authorizationEpoch: lease.authorizationEpoch,
      currentLease: lease,
    });
  }

  async request(
    session: CredentialSession,
    input: HttpRequest,
  ): Promise<HttpResult> {
    if (
      input.revalidateCredentialAtDispatch === true &&
      input.authorizeDispatch === undefined
    ) {
      throw new GoogleCalendarFetchError('dispatch-not-authorized', false);
    }
    const lease = await this.#leaseForDispatch(
      session,
      input.signal,
      input.revalidateCredentialAtDispatch === true,
    );
    if (input.authorizeDispatch !== undefined) {
      let authorized = false;
      try {
        authorized = input.authorizeDispatch(lease) === true;
      } catch {
        authorized = false;
      }
      if (!authorized) {
        throw new GoogleCalendarFetchError('dispatch-not-authorized', false);
      }
    }
    return this.#boundedOperation(true, input.signal, async (signal) => {
      const response = await awaitAbortable({
        signal,
        operation: () =>
          this.#fetch(input.url, {
            method: input.method,
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${lease.accessToken}`,
              ...(input.headers ?? {}),
            },
            ...(input.body === undefined ? {} : { body: input.body }),
            cache: 'no-store',
            redirect: 'error',
            signal,
          }),
        error: () => new GoogleCalendarFetchError('provider-unavailable', true),
        disposeLate: (late) => {
          if (isExactResponse(late)) cancelBody(late);
        },
      });
      if (!isExactResponse(response)) {
        throw new GoogleCalendarFetchError('provider-unavailable', true);
      }
      const result: {
        status: number;
        body?: unknown;
        requestReference?: string;
      } = { status: response.status };
      const requestReference = safeRequestReference(response);
      if (requestReference !== undefined) {
        result.requestReference = requestReference;
      }
      if (input.parseJsonStatuses?.includes(response.status) === true) {
        result.body = await readBoundedJson(
          response,
          signal,
          () => new GoogleCalendarFetchError('provider-unavailable', true),
        );
      } else {
        cancelBody(response);
      }
      return Object.freeze(result);
    });
  }

  #leaseIsCurrent(lease: AccessTokenLease): boolean {
    let now: Date;
    try {
      now = this.#clock();
    } catch {
      return false;
    }
    const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
    const expiresAt = Date.parse(lease.expiresAt);
    return !(
      !Number.isFinite(nowMs) ||
      !Number.isFinite(expiresAt) ||
      expiresAt - nowMs <= GOOGLE_CALENDAR_FETCH_LIMITS.credentialExpirySkewMs
    );
  }

  async #leaseForDispatch(
    session: CredentialSession,
    signal: AbortSignal | undefined,
    forceRevalidation = false,
  ): Promise<AccessTokenLease> {
    if (!forceRevalidation && this.#leaseIsCurrent(session.currentLease)) {
      return session.currentLease;
    }
    const replacement = await this.#acquireLease(
      session.actor,
      session.capability,
      signal,
    );
    if (
      replacement.grantReference !== session.grantReference ||
      replacement.authorizationEpoch !== session.authorizationEpoch ||
      !this.#leaseIsCurrent(replacement)
    ) {
      throw new GoogleCalendarFetchError(
        forceRevalidation
          ? 'dispatch-not-authorized'
          : 'credential-unavailable',
        false,
      );
    }
    session.currentLease = replacement;
    return replacement;
  }

  async #acquireLease(
    actor: GoogleCalendarOAuthActor,
    capability: GoogleCalendarAuthorizationPurpose,
    signal: AbortSignal | undefined,
  ): Promise<AccessTokenLease> {
    let rawLease: unknown;
    try {
      rawLease = await this.#boundedOperation(false, signal, () =>
        this.#broker.acquireAccessTokenForCapability({ actor, capability }),
      );
    } catch (error) {
      if (
        error instanceof GoogleCalendarFetchError &&
        (error.kind === 'request-aborted' || error.kind === 'timeout')
      ) {
        throw error;
      }
      throw new GoogleCalendarFetchError('credential-unavailable', false);
    }
    const parsed = AccessTokenLeaseSchema.safeParse(rawLease);
    if (!parsed.success) {
      throw new GoogleCalendarFetchError('credential-unavailable', false);
    }
    return deepFreeze(parsed.data);
  }

  async #boundedOperation<Value>(
    dispatched: boolean,
    callerSignal: AbortSignal | undefined,
    operation:
      | (() => Value | Promise<Value>)
      | ((signal: AbortSignal) => Value | Promise<Value>),
  ): Promise<Value> {
    if (callerSignal?.aborted === true) {
      throw new GoogleCalendarFetchError('request-aborted', dispatched);
    }
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    const abortFromCaller = () => {
      callerAborted = true;
      controller.abort();
    };
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    try {
      return await awaitAbortable({
        signal: controller.signal,
        operation: () => operation(controller.signal),
        error: () =>
          new GoogleCalendarFetchError(
            callerAborted
              ? 'request-aborted'
              : timedOut
                ? 'timeout'
                : 'provider-unavailable',
            dispatched,
          ),
      });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

const parseOptions = (
  input: unknown,
): {
  fetch: GoogleCalendarFetch;
  broker: GoogleCalendarCredentialBroker;
  timeoutMs: number;
  clock: () => Date;
} => {
  const options = snapshotPlainRecord(
    input,
    ['fetch', 'broker', 'timeoutMs', 'clock'],
    ['fetch', 'broker'],
  );
  const acquireAccessTokenForCapability =
    options === undefined
      ? undefined
      : snapshotDataMethod(options.broker, 'acquireAccessTokenForCapability');
  if (
    options === undefined ||
    typeof options.fetch !== 'function' ||
    acquireAccessTokenForCapability === undefined ||
    (options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) ||
        (options.timeoutMs as number) < 1 ||
        (options.timeoutMs as number) >
          GOOGLE_CALENDAR_FETCH_LIMITS.maxTimeoutMs)) ||
    (options.clock !== undefined && typeof options.clock !== 'function')
  ) {
    throw new Error('invalid-google-calendar-fetch-client');
  }
  return {
    fetch: options.fetch as GoogleCalendarFetch,
    broker: {
      acquireAccessTokenForCapability: (input) =>
        Promise.resolve(acquireAccessTokenForCapability(input)),
    },
    timeoutMs:
      (options.timeoutMs as number | undefined) ??
      GOOGLE_CALENDAR_FETCH_LIMITS.defaultTimeoutMs,
    clock: (options.clock as (() => Date) | undefined) ?? (() => new Date()),
  };
};

const validClockIso = (clock: () => Date): string => {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new GoogleCalendarFetchError('response-invalid', false);
  }
  return new Date(value.getTime()).toISOString();
};

const assertSuccess = (result: HttpResult): unknown => {
  if (result.status === 200 && result.body !== undefined) return result.body;
  if (result.status === 408 || result.status === 429 || result.status >= 500) {
    throw new GoogleCalendarFetchError('provider-unavailable', true);
  }
  throw new GoogleCalendarFetchError('provider-rejected', true);
};

const CalendarListItemSchema = z.looseObject({
  id: ReferenceSchema,
  summary: z.string().trim().min(1).max(2_000),
  accessRole: z.enum([
    'freeBusyReader',
    'reader',
    'writerWithoutPrivateAccess',
    'writer',
    'owner',
  ]),
  primary: z.boolean().optional(),
  timeZone: z.string().trim().min(1).max(120).optional(),
});
const CalendarListPageSchema = z.looseObject({
  nextPageToken: z.string().min(1).max(2_048).optional(),
  items: z.array(CalendarListItemSchema).max(250).optional(),
});

const GoogleEventTimeSchema = z.union([
  z.looseObject({
    dateTime: DateTimeSchema,
    timeZone: z.string().trim().min(1).max(120).optional(),
  }),
  z.looseObject({ date: z.iso.date() }),
]);
const GoogleReadEventSchema = z.looseObject({
  id: ReferenceSchema,
  etag: VersionSchema,
  status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
  summary: z.string().max(2_000).optional(),
  description: z.string().max(8_000).optional(),
  location: z.string().max(2_000).optional(),
  start: GoogleEventTimeSchema,
  end: GoogleEventTimeSchema,
  attendees: z
    .array(z.looseObject({ email: z.email().max(320) }))
    .max(100)
    .optional(),
  recurrence: z.array(z.string().min(1).max(1_000)).max(10).optional(),
});
const GoogleEventsPageSchema = z.looseObject({
  etag: VersionSchema,
  nextPageToken: z.string().min(1).max(2_048).optional(),
  items: z.array(GoogleReadEventSchema).max(250).optional(),
});

export type GoogleCalendarSummary = DeepReadonly<{
  id: string;
  summary: string;
  accessRole:
    | 'freeBusyReader'
    | 'reader'
    | 'writerWithoutPrivateAccess'
    | 'writer'
    | 'owner';
  primary?: boolean;
  timeZone?: string;
}>;

export type GoogleCalendarEventEvidence = DeepReadonly<{
  id: string;
  eventVersion: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  start: z.infer<typeof GoogleEventTimeSchema>;
  end: z.infer<typeof GoogleEventTimeSchema>;
  attendees: readonly string[];
  recurrence?: readonly string[];
}>;

const normalizeReadEvent = (
  event: z.infer<typeof GoogleReadEventSchema>,
): GoogleCalendarEventEvidence =>
  deepFreeze({
    id: event.id,
    eventVersion: event.etag,
    status: event.status ?? 'confirmed',
    ...(event.summary === undefined ? {} : { summary: event.summary }),
    ...(event.description === undefined
      ? {}
      : { description: event.description }),
    ...(event.location === undefined ? {} : { location: event.location }),
    start: event.start,
    end: event.end,
    attendees: (event.attendees ?? []).map(({ email }) => email),
    ...(event.recurrence === undefined ? {} : { recurrence: event.recurrence }),
  });

const CalendarListInputSchema = z.strictObject({ actor: ActorSchema });
const EventListInputSchema = z
  .strictObject({
    actor: ActorSchema,
    calendarId: ReferenceSchema,
    timeMin: DateTimeSchema,
    timeMax: DateTimeSchema,
    signal: z.custom<AbortSignal>(isAbortSignal).optional(),
  })
  .superRefine((value, context) => {
    const duration = Date.parse(value.timeMax) - Date.parse(value.timeMin);
    if (
      duration <= 0 ||
      duration > GOOGLE_CALENDAR_FETCH_LIMITS.maxEventWindowMs
    ) {
      context.addIssue({
        code: 'custom',
        path: ['timeMax'],
        message: 'Event window must have positive duration',
      });
    }
  });

export class GoogleCalendarReadClient {
  readonly #http: GoogleCalendarHttpClient;
  readonly #clock: () => Date;

  constructor(input: {
    readonly fetch: GoogleCalendarFetch;
    readonly broker: GoogleCalendarCredentialBroker;
    readonly timeoutMs?: number;
    readonly clock?: () => Date;
  }) {
    const options = parseOptions(input);
    this.#http = new GoogleCalendarHttpClient(options);
    this.#clock = options.clock;
  }

  async listCalendars(input: unknown) {
    const snapshot = snapshotBoundedInput(input, ['actor']);
    const parsedInput = CalendarListInputSchema.safeParse(snapshot);
    if (!parsedInput.success) {
      throw new GoogleCalendarFetchError('provider-rejected', false);
    }
    const parsed = parsedInput.data;
    return this.#http.withCredential({
      actor: parsed.actor,
      capability: 'calendar-read',
      operation: async (session) => {
        const calendars: GoogleCalendarSummary[] = [];
        const seenTokens = new Set<string>();
        let pageToken: string | undefined;
        for (
          let page = 0;
          page < GOOGLE_CALENDAR_FETCH_LIMITS.maxPages;
          page += 1
        ) {
          const url = new URL(GOOGLE_CALENDAR_API_ENDPOINTS.calendarList);
          url.searchParams.set('maxResults', '250');
          url.searchParams.set('minAccessRole', 'freeBusyReader');
          url.searchParams.set('showDeleted', 'false');
          url.searchParams.set(
            'fields',
            'nextPageToken,items(id,summary,accessRole,primary,timeZone)',
          );
          if (pageToken !== undefined)
            url.searchParams.set('pageToken', pageToken);
          const raw = assertSuccess(
            await this.#http.request(session, {
              url: url.toString(),
              method: 'GET',
              parseJsonStatuses: [200],
            }),
          );
          const providerPage = CalendarListPageSchema.safeParse(raw);
          if (!providerPage.success) {
            throw new GoogleCalendarFetchError('response-invalid', true);
          }
          for (const calendar of providerPage.data.items ?? []) {
            calendars.push(deepFreeze(calendar));
            if (calendars.length > GOOGLE_CALENDAR_FETCH_LIMITS.maxCalendars) {
              throw new GoogleCalendarFetchError('response-too-large', true);
            }
          }
          pageToken = providerPage.data.nextPageToken;
          if (pageToken === undefined) {
            return deepFreeze({
              calendars,
              fetchedAt: validClockIso(this.#clock),
              grantReference: session.grantReference,
            });
          }
          if (seenTokens.has(pageToken)) {
            throw new GoogleCalendarFetchError('response-invalid', true);
          }
          seenTokens.add(pageToken);
        }
        throw new GoogleCalendarFetchError('response-too-large', true);
      },
    });
  }

  async listEvents(input: unknown) {
    const snapshot = snapshotBoundedInput(
      input,
      ['actor', 'calendarId', 'timeMin', 'timeMax', 'signal'],
      ['actor', 'calendarId', 'timeMin', 'timeMax'],
    );
    const parsedInput = EventListInputSchema.safeParse(snapshot);
    if (!parsedInput.success) {
      throw new GoogleCalendarFetchError('provider-rejected', false);
    }
    const parsed = parsedInput.data;
    return this.#http.withCredential({
      actor: parsed.actor,
      capability: 'calendar-read',
      signal: parsed.signal,
      operation: async (session) => {
        const events: GoogleCalendarEventEvidence[] = [];
        const seenTokens = new Set<string>();
        let pageToken: string | undefined;
        let calendarVersion: string | undefined;
        for (
          let page = 0;
          page < GOOGLE_CALENDAR_FETCH_LIMITS.maxPages;
          page += 1
        ) {
          const url = calendarEventsUrl(parsed.calendarId);
          url.searchParams.set('timeMin', parsed.timeMin);
          url.searchParams.set('timeMax', parsed.timeMax);
          url.searchParams.set('timeZone', 'America/Toronto');
          url.searchParams.set('singleEvents', 'true');
          url.searchParams.set('orderBy', 'startTime');
          url.searchParams.set('showDeleted', 'false');
          url.searchParams.set('maxResults', '250');
          url.searchParams.set(
            'fields',
            'etag,nextPageToken,items(id,etag,status,summary,description,location,start,end,attendees(email),recurrence)',
          );
          if (pageToken !== undefined)
            url.searchParams.set('pageToken', pageToken);
          const raw = assertSuccess(
            await this.#http.request(session, {
              url: url.toString(),
              method: 'GET',
              parseJsonStatuses: [200],
              signal: parsed.signal,
            }),
          );
          const providerPage = GoogleEventsPageSchema.safeParse(raw);
          if (!providerPage.success) {
            throw new GoogleCalendarFetchError('response-invalid', true);
          }
          calendarVersion ??= providerPage.data.etag;
          for (const event of providerPage.data.items ?? []) {
            events.push(normalizeReadEvent(event));
            if (events.length > GOOGLE_CALENDAR_FETCH_LIMITS.maxEvents) {
              throw new GoogleCalendarFetchError('response-too-large', true);
            }
          }
          pageToken = providerPage.data.nextPageToken;
          if (pageToken === undefined) {
            return deepFreeze({
              calendarId: parsed.calendarId,
              calendarVersion: calendarVersion!,
              events,
              fetchedAt: validClockIso(this.#clock),
              grantReference: session.grantReference,
            });
          }
          if (seenTokens.has(pageToken)) {
            throw new GoogleCalendarFetchError('response-invalid', true);
          }
          seenTokens.add(pageToken);
        }
        throw new GoogleCalendarFetchError('response-too-large', true);
      },
    });
  }
}

const BusyIntervalSchema = z
  .strictObject({ start: DateTimeSchema, end: DateTimeSchema })
  .superRefine((value, context) => {
    if (Date.parse(value.end) <= Date.parse(value.start)) {
      context.addIssue({
        code: 'custom',
        path: ['end'],
        message: 'Busy interval must have positive duration',
      });
    }
  });
const FreeBusyCalendarSchema = z.looseObject({
  busy: z
    .array(BusyIntervalSchema)
    .max(GOOGLE_CALENDAR_FETCH_LIMITS.maxBusyIntervalsPerCalendar),
  errors: z.array(z.unknown()).max(20).optional(),
});
const FreeBusyResponseSchema = z.looseObject({
  calendars: z.record(z.string().max(512), FreeBusyCalendarSchema),
});
const FreeBusyInputSchema = z
  .strictObject({
    actor: ActorSchema,
    calendarIds: z
      .array(ReferenceSchema)
      .min(1)
      .max(GOOGLE_CALENDAR_FETCH_LIMITS.maxFreeBusyCalendars)
      .refine((values) => new Set(values).size === values.length),
    timeMin: DateTimeSchema,
    timeMax: DateTimeSchema,
    timeZone: z.literal('America/Toronto'),
    signal: z.custom<AbortSignal>(isAbortSignal).optional(),
  })
  .superRefine((value, context) => {
    const duration = Date.parse(value.timeMax) - Date.parse(value.timeMin);
    if (
      duration <= 0 ||
      duration > GOOGLE_CALENDAR_FETCH_LIMITS.maxFreeBusyWindowMs
    ) {
      context.addIssue({
        code: 'custom',
        path: ['timeMax'],
        message: 'Free/busy window is outside the supported range',
      });
    }
  });

export class GoogleCalendarFreeBusyClient {
  readonly #http: GoogleCalendarHttpClient;
  readonly #clock: () => Date;

  constructor(input: {
    readonly fetch: GoogleCalendarFetch;
    readonly broker: GoogleCalendarCredentialBroker;
    readonly timeoutMs?: number;
    readonly clock?: () => Date;
  }) {
    const options = parseOptions(input);
    this.#http = new GoogleCalendarHttpClient(options);
    this.#clock = options.clock;
  }

  async query(input: unknown) {
    const snapshot = snapshotBoundedInput(
      input,
      ['actor', 'calendarIds', 'timeMin', 'timeMax', 'timeZone', 'signal'],
      ['actor', 'calendarIds', 'timeMin', 'timeMax', 'timeZone'],
    );
    const parsedInput = FreeBusyInputSchema.safeParse(snapshot);
    if (!parsedInput.success) {
      throw new GoogleCalendarFetchError('provider-rejected', false);
    }
    const parsed = parsedInput.data;
    return this.#http.withCredential({
      actor: parsed.actor,
      capability: 'calendar-read',
      signal: parsed.signal,
      operation: async (session) => {
        const result = await this.#http.request(session, {
          url: GOOGLE_CALENDAR_API_ENDPOINTS.freeBusy,
          method: 'POST',
          body: JSON.stringify({
            timeMin: parsed.timeMin,
            timeMax: parsed.timeMax,
            timeZone: parsed.timeZone,
            items: parsed.calendarIds.map((id) => ({ id })),
          }),
          headers: { 'content-type': 'application/json' },
          parseJsonStatuses: [200],
          signal: parsed.signal,
        });
        const raw = assertSuccess(result);
        const provider = FreeBusyResponseSchema.safeParse(raw);
        if (!provider.success) {
          throw new GoogleCalendarFetchError('response-invalid', true);
        }
        return deepFreeze({
          calendars: parsed.calendarIds.map((calendarId) => {
            const value = provider.data.calendars[calendarId];
            if (value === undefined || (value.errors?.length ?? 0) > 0) {
              return { calendarId, status: 'unavailable' as const, busy: [] };
            }
            return {
              calendarId,
              status: 'available' as const,
              busy: value.busy,
            };
          }),
          fetchedAt: validClockIso(this.#clock),
          grantReference: session.grantReference,
        });
      },
    });
  }
}

const calendarEventsUrl = (calendarId: string): URL =>
  new URL(
    `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
  );

const calendarEventUrl = (calendarId: string, eventId: string): URL =>
  new URL(
    `${calendarEventsUrl(calendarId).toString()}/${encodeURIComponent(eventId)}`,
  );

export const deriveGoogleCalendarEventId = (idempotencyKey: string): string => {
  if (!/^[a-f0-9]{64}$/.test(idempotencyKey)) {
    throw new Error('invalid-google-calendar-idempotency-key');
  }
  return `emdo${createHash('sha256')
    .update('emdo.google-calendar.event-id.v1\0')
    .update(idempotencyKey)
    .digest('hex')}`;
};

const GoogleProviderEventIdentitySchema = z.looseObject({
  id: EventIdSchema,
  etag: VersionSchema,
  status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
});

const GoogleProviderEventSchema = GoogleProviderEventIdentitySchema.extend({
  summary: z.string().trim().min(1).max(2_000),
  description: z.string().trim().min(1).max(8_000).optional(),
  location: z.string().trim().min(1).max(2_000).optional(),
  start: z.looseObject({
    dateTime: DateTimeSchema,
    timeZone: z.literal('America/Toronto'),
  }),
  end: z.looseObject({
    dateTime: DateTimeSchema,
    timeZone: z.literal('America/Toronto'),
  }),
  attendees: z
    .array(z.looseObject({ email: z.email().max(320) }))
    .max(100)
    .optional(),
  recurrence: z.array(z.string().min(1).max(1_000)).max(10).optional(),
  extendedProperties: z
    .looseObject({
      private: z.record(z.string().max(120), z.string().max(512)).optional(),
    })
    .optional(),
});
const CollectionVersionSchema = z.looseObject({ etag: VersionSchema });

const parseRrule = (
  recurrence: readonly string[] | undefined,
  disambiguation: string | undefined,
):
  | {
      frequency: 'daily' | 'weekly';
      interval: number;
      count: number;
      disambiguation: 'reject' | 'earlier' | 'later';
      byWeekday?: Array<'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'>;
    }
  | undefined => {
  if (recurrence === undefined) return undefined;
  if (recurrence.length !== 1 || disambiguation === undefined) {
    throw new GoogleCalendarFetchError('response-invalid', true);
  }
  const parsedDisambiguation = z
    .enum(['reject', 'earlier', 'later'])
    .safeParse(disambiguation);
  const rule =
    /^RRULE:FREQ=(DAILY|WEEKLY);INTERVAL=([0-9]+);COUNT=([0-9]+)(?:;BYDAY=(MO|TU|WE|TH|FR|SA|SU)(?:,(MO|TU|WE|TH|FR|SA|SU))*)?$/.exec(
      recurrence[0]!,
    );
  if (!parsedDisambiguation.success || rule === null) {
    throw new GoogleCalendarFetchError('response-invalid', true);
  }
  const interval = Number(rule[2]);
  const count = Number(rule[3]);
  if (
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    interval > 52 ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 366
  ) {
    throw new GoogleCalendarFetchError('response-invalid', true);
  }
  const byDaySegment = recurrence[0]!.split(';BYDAY=', 2)[1];
  const byWeekday =
    byDaySegment === undefined
      ? undefined
      : (byDaySegment.split(',') as Array<
          'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'
        >);
  return {
    frequency: rule[1] === 'DAILY' ? 'daily' : 'weekly',
    interval,
    count,
    disambiguation: parsedDisambiguation.data,
    ...(byWeekday === undefined ? {} : { byWeekday }),
  };
};

const normalizeProviderEvent = (
  input: unknown,
  command: GoogleCalendarWriteCommand,
  requireExactPayload: boolean,
  requireEmdoBinding: boolean,
): GoogleCalendarProviderState['event'] => {
  const identity = GoogleProviderEventIdentitySchema.safeParse(input);
  if (!identity.success || identity.data.status === 'cancelled') {
    throw new GoogleCalendarFetchError('response-invalid', true);
  }
  if (!requireExactPayload) {
    return deepFreeze({
      eventId: identity.data.id,
      eventVersion: identity.data.etag,
    });
  }
  const event = GoogleProviderEventSchema.safeParse(input);
  if (!event.success) {
    throw new GoogleCalendarFetchError('response-invalid', true);
  }
  if (
    requireEmdoBinding &&
    (event.data.extendedProperties?.private?.emdoPayloadHash !==
      command.payloadHash ||
      event.data.extendedProperties?.private?.emdoIdempotencyKey !==
        command.idempotencyKey)
  ) {
    throw new GoogleCalendarFetchError('response-invalid', true);
  }
  const recurrence = parseRrule(
    event.data.recurrence,
    requireEmdoBinding
      ? event.data.extendedProperties?.private?.emdoDisambiguation
      : command.payload?.recurrence?.disambiguation,
  );
  return deepFreeze({
    eventId: event.data.id,
    summary: event.data.summary,
    start: event.data.start.dateTime,
    end: event.data.end.dateTime,
    timeZone: 'America/Toronto' as const,
    ...(event.data.location === undefined
      ? {}
      : { location: event.data.location }),
    ...(event.data.description === undefined
      ? {}
      : { description: event.data.description }),
    ...(event.data.attendees === undefined
      ? {}
      : { attendees: event.data.attendees.map(({ email }) => email) }),
    ...(recurrence === undefined ? {} : { recurrence }),
    eventVersion: event.data.etag,
  });
};

const providerEventBody = (command: GoogleCalendarWriteCommand): string => {
  if (command.payload === null) {
    throw new Error('google-calendar-write-payload-missing');
  }
  const payload = command.payload;
  const recurrence =
    payload.recurrence === undefined
      ? undefined
      : [
          `RRULE:FREQ=${payload.recurrence.frequency.toUpperCase()};INTERVAL=${payload.recurrence.interval};COUNT=${payload.recurrence.count}${
            payload.recurrence.byWeekday === undefined
              ? ''
              : `;BYDAY=${payload.recurrence.byWeekday.join(',')}`
          }`,
        ];
  return JSON.stringify({
    ...(command.operation === 'create' ? { id: command.eventId } : {}),
    summary: payload.summary,
    start: { dateTime: payload.start, timeZone: payload.timeZone },
    end: { dateTime: payload.end, timeZone: payload.timeZone },
    ...(command.operation === 'create'
      ? {
          ...(payload.location === undefined
            ? {}
            : { location: payload.location }),
          ...(payload.description === undefined
            ? {}
            : { description: payload.description }),
          ...(payload.attendees === undefined
            ? {}
            : { attendees: payload.attendees.map((email) => ({ email })) }),
          ...(recurrence === undefined ? {} : { recurrence }),
          extendedProperties: {
            private: {
              emdoPayloadHash: command.payloadHash,
              emdoIdempotencyKey: command.idempotencyKey,
              ...(payload.recurrence === undefined
                ? {}
                : { emdoDisambiguation: payload.recurrence.disambiguation }),
            },
          },
        }
      : {
          // PATCH is intentionally field-scoped. Null/empty values clear only
          // fields represented in the exact visual replacement while provider-
          // only fields (reminders, conferenceData, attachments, visibility,
          // transparency, color, and unrelated private metadata) are retained.
          location: payload.location ?? null,
          description: payload.description ?? null,
          attendees: payload.attendees?.map((email) => ({ email })) ?? [],
          recurrence: recurrence ?? [],
        }),
  });
};

const isGatewayAuthorizationValid = (
  actor: GoogleCalendarOAuthActor,
  authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint,
  command: GoogleCalendarWriteCommand,
  authorization: ApprovedCalendarWriteContext,
): boolean => {
  try {
    const authority = authorization.approvalBinding.authorityBinding;
    const operationScope = authorization.providerWriteOperationScope;
    return (
      authorization.approvalBinding.userId === actor.userId &&
      authority.householdId === actor.householdId &&
      authority.privateSpaceId === actor.privateSpaceId &&
      operationScope.userId === actor.userId &&
      operationScope.householdId === actor.householdId &&
      operationScope.sessionId === actor.sessionId &&
      operationScope.authorizationScopeFingerprint ===
        authorizationScopeFingerprint &&
      authority.authorizationScopeFingerprint ===
        authorizationScopeFingerprint &&
      isGoogleCalendarWriteAuthorized(command, authorization)
    );
  } catch {
    return false;
  }
};

const assertGatewayAuthorization = (
  actor: GoogleCalendarOAuthActor,
  authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint,
  command: GoogleCalendarWriteCommand,
  authorization: ApprovedCalendarWriteContext,
): void => {
  if (
    !isGatewayAuthorizationValid(
      actor,
      authorizationScopeFingerprint,
      command,
      authorization,
    )
  ) {
    throw new Error('google-calendar-write-authorization-invalid');
  }
};

export class FetchGoogleCalendarConditionalGateway implements GoogleCalendarConditionalGateway {
  readonly #actor: GoogleCalendarOAuthActor;
  readonly #authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
  readonly #http: GoogleCalendarHttpClient;
  readonly #clock: () => Date;

  constructor(input: {
    readonly actor: GoogleCalendarOAuthActor;
    readonly authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
    readonly fetch: GoogleCalendarFetch;
    readonly broker: GoogleCalendarCredentialBroker;
    readonly timeoutMs?: number;
    readonly clock?: () => Date;
  }) {
    const snapshot = snapshotPlainRecord(
      input,
      [
        'actor',
        'authorizationScopeFingerprint',
        'fetch',
        'broker',
        'timeoutMs',
        'clock',
      ],
      ['actor', 'authorizationScopeFingerprint', 'fetch', 'broker'],
    );
    if (snapshot === undefined) {
      throw new Error('invalid-google-calendar-conditional-gateway');
    }
    const actorSnapshot = snapshotPlainRecord(snapshot.actor, [
      'userId',
      'householdId',
      'privateSpaceId',
      'sessionId',
    ]);
    const actorResult = ActorSchema.safeParse(actorSnapshot);
    if (!actorResult.success) {
      throw new Error('invalid-google-calendar-conditional-gateway');
    }
    const authorizationScopeFingerprintResult =
      EffectiveAuthorizationScopeFingerprintSchema.safeParse(
        snapshot.authorizationScopeFingerprint,
      );
    if (!authorizationScopeFingerprintResult.success) {
      throw new Error('invalid-google-calendar-conditional-gateway');
    }
    const options = parseOptions({
      fetch: snapshot.fetch,
      broker: snapshot.broker,
      ...(snapshot.timeoutMs === undefined
        ? {}
        : { timeoutMs: snapshot.timeoutMs }),
      ...(snapshot.clock === undefined ? {} : { clock: snapshot.clock }),
    });
    this.#actor = deepFreeze(actorResult.data);
    this.#authorizationScopeFingerprint =
      authorizationScopeFingerprintResult.data;
    this.#http = new GoogleCalendarHttpClient(options);
    this.#clock = options.clock;
  }

  async readCurrent(
    command: GoogleCalendarWriteCommand,
    authorization: ApprovedCalendarWriteContext,
  ): Promise<GoogleCalendarProviderState> {
    assertGatewayAuthorization(
      this.#actor,
      this.#authorizationScopeFingerprint,
      command,
      authorization,
    );
    return this.#readProviderState(command, authorization, 'precondition');
  }

  async readBack(
    command: GoogleCalendarWriteCommand,
    authorization: ApprovedCalendarWriteContext,
  ): Promise<GoogleCalendarProviderState> {
    assertGatewayAuthorization(
      this.#actor,
      this.#authorizationScopeFingerprint,
      command,
      authorization,
    );
    return this.#readProviderState(command, authorization, 'readback');
  }

  async applyConditionalExactlyOnce(
    command: GoogleCalendarWriteCommand,
    authorization: ApprovedCalendarWriteContext,
  ): Promise<unknown> {
    assertGatewayAuthorization(
      this.#actor,
      this.#authorizationScopeFingerprint,
      command,
      authorization,
    );
    if (
      command.operation === 'create' &&
      command.eventId !== deriveGoogleCalendarEventId(command.idempotencyKey)
    ) {
      return deepFreeze({
        status: 'not-applied' as const,
        reason: 'conditional-rejected' as const,
      });
    }
    if (!this.#permitIsCurrent(authorization)) {
      return deepFreeze({
        status: 'not-applied' as const,
        reason: 'conditional-rejected' as const,
      });
    }
    let mutationDispatched = false;
    try {
      return await this.#http.withCredential({
        actor: this.#actor,
        capability: 'calendar-event-write',
        operation: async (session) => {
          if (
            !this.#sessionMatchesApproval(session, authorization) ||
            !this.#permitIsCurrent(authorization)
          ) {
            return deepFreeze({
              status: 'not-applied' as const,
              reason: 'conditional-rejected' as const,
            });
          }
          // Google supports atomic If-Match only for an existing event. It has
          // no collection-version precondition for insert, so this trusted
          // dispatch-boundary re-read narrows (but cannot eliminate) the race;
          // deterministic create IDs still prevent duplicate creates.
          const collectionUrl = calendarEventsUrl(command.calendarId);
          collectionUrl.searchParams.set('maxResults', '1');
          collectionUrl.searchParams.set('showDeleted', 'true');
          collectionUrl.searchParams.set('fields', 'etag');
          const versionResult = await this.#http.request(session, {
            url: collectionUrl.toString(),
            method: 'GET',
            parseJsonStatuses: [200],
          });
          const rawVersion = assertSuccess(versionResult);
          const currentVersion = CollectionVersionSchema.safeParse(rawVersion);
          if (
            !currentVersion.success ||
            currentVersion.data.etag !== command.expectedCalendarVersion
          ) {
            return deepFreeze({
              status: 'not-applied' as const,
              reason: 'conditional-rejected' as const,
            });
          }
          const url = calendarEventUrl(command.calendarId, command.eventId);
          url.searchParams.set('sendUpdates', 'none');
          url.searchParams.set('supportsAttachments', 'false');
          const method =
            command.operation === 'create'
              ? 'POST'
              : command.operation === 'update'
                ? 'PATCH'
                : 'DELETE';
          const targetUrl =
            command.operation === 'create'
              ? (() => {
                  const collection = calendarEventsUrl(command.calendarId);
                  collection.search = url.search;
                  return collection.toString();
                })()
              : url.toString();
          const result = await this.#http.request(session, {
            url: targetUrl,
            method,
            revalidateCredentialAtDispatch: true,
            ...(command.operation === 'delete'
              ? {}
              : { body: providerEventBody(command) }),
            headers: {
              ...(command.operation === 'delete'
                ? {}
                : { 'content-type': 'application/json' }),
              ...(command.operation === 'create'
                ? {}
                : { 'if-match': command.expectedEventVersion }),
            },
            authorizeDispatch: (lease) => {
              const authorized =
                this.#permitIsCurrent(authorization) &&
                this.#leaseMatchesApproval(lease, authorization) &&
                isGatewayAuthorizationValid(
                  this.#actor,
                  this.#authorizationScopeFingerprint,
                  command,
                  authorization,
                );
              if (authorized) mutationDispatched = true;
              return authorized;
            },
          });
          const requestReference =
            result.requestReference ??
            `emdo-calendar-${command.idempotencyKey.slice(0, 32)}`;
          const expectedStatus =
            (command.operation === 'create' &&
              (result.status === 200 || result.status === 201)) ||
            (command.operation === 'update' && result.status === 200) ||
            (command.operation === 'delete' && result.status === 204);
          if (expectedStatus) {
            return deepFreeze({
              status: 'applied' as const,
              providerRequestId: requestReference,
            });
          }
          if (
            result.status === 412 ||
            (command.operation !== 'create' && result.status === 404)
          ) {
            return deepFreeze({
              status: 'not-applied' as const,
              reason: 'conditional-rejected' as const,
            });
          }
          if (
            (command.operation === 'create' && result.status === 409) ||
            result.status === 408 ||
            result.status === 429 ||
            result.status >= 500 ||
            (result.status >= 200 && result.status < 300)
          ) {
            return deepFreeze({
              status: 'indeterminate' as const,
              providerRequestId: requestReference,
            });
          }
          return deepFreeze({
            status: 'not-applied' as const,
            reason: 'provider-rejected' as const,
          });
        },
      });
    } catch (error) {
      const providerRequestId = `emdo-calendar-${command.idempotencyKey.slice(0, 32)}`;
      if (
        error instanceof GoogleCalendarFetchError &&
        error.kind === 'dispatch-not-authorized'
      ) {
        return deepFreeze({
          status: 'not-applied' as const,
          reason: 'conditional-rejected' as const,
        });
      }
      if (
        mutationDispatched &&
        error instanceof GoogleCalendarFetchError &&
        error.dispatched
      ) {
        return deepFreeze({
          status: 'indeterminate' as const,
          providerRequestId,
        });
      }
      return deepFreeze({
        status: 'not-applied' as const,
        reason: 'provider-rejected' as const,
      });
    }
  }

  async #readProviderState(
    command: GoogleCalendarWriteCommand,
    authorization: ApprovedCalendarWriteContext,
    mode: 'precondition' | 'readback',
  ): Promise<GoogleCalendarProviderState> {
    return this.#http.withCredential({
      actor: this.#actor,
      capability: 'calendar-event-write',
      operation: async (session) => {
        if (!this.#sessionMatchesApproval(session, authorization)) {
          throw new GoogleCalendarFetchError('credential-unavailable', false);
        }
        const collectionUrl = calendarEventsUrl(command.calendarId);
        collectionUrl.searchParams.set('maxResults', '1');
        collectionUrl.searchParams.set('showDeleted', 'true');
        collectionUrl.searchParams.set('fields', 'etag');
        const versionResult = await this.#http.request(session, {
          url: collectionUrl.toString(),
          method: 'GET',
          parseJsonStatuses: [200],
        });
        const rawVersion = assertSuccess(versionResult);
        const version = CollectionVersionSchema.safeParse(rawVersion);
        if (!version.success) {
          throw new GoogleCalendarFetchError('response-invalid', true);
        }

        const eventUrl = calendarEventUrl(command.calendarId, command.eventId);
        eventUrl.searchParams.set(
          'fields',
          'id,etag,status,summary,description,location,start,end,attendees(email),recurrence,extendedProperties(private)',
        );
        const eventResult = await this.#http.request(session, {
          url: eventUrl.toString(),
          method: 'GET',
          parseJsonStatuses: [200],
        });
        if (eventResult.status === 404) {
          return deepFreeze({
            calendarId: command.calendarId,
            queriedEventId: command.eventId,
            calendarVersion: version.data.etag,
            event: null,
          });
        }
        const rawEvent = assertSuccess(eventResult);
        return deepFreeze({
          calendarId: command.calendarId,
          queriedEventId: command.eventId,
          calendarVersion: version.data.etag,
          event: normalizeProviderEvent(
            rawEvent,
            command,
            mode === 'readback' && command.operation !== 'delete',
            mode === 'readback' && command.operation === 'create',
          ),
        });
      },
    });
  }

  #permitIsCurrent(authorization: ApprovedCalendarWriteContext): boolean {
    try {
      const now = this.#clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
        return false;
      const nowMs = now.getTime();
      return (
        nowMs < Date.parse(authorization.providerWritePermit.expiresAt) &&
        nowMs <
          Date.parse(authorization.providerWritePermit.idempotencyExpiresAt)
      );
    } catch {
      return false;
    }
  }

  #leaseMatchesApproval(
    lease: AccessTokenLease,
    authorization: ApprovedCalendarWriteContext,
  ): boolean {
    const authority = authorization.approvalBinding.authorityBinding;
    return (
      lease.authorizationEpoch === authority.authorizationEpoch &&
      this.#grantReferenceMatchesApproval(lease.grantReference, authorization)
    );
  }

  #sessionMatchesApproval(
    session: CredentialSession,
    authorization: ApprovedCalendarWriteContext,
  ): boolean {
    const authority = authorization.approvalBinding.authorityBinding;
    return (
      session.authorizationEpoch === authority.authorizationEpoch &&
      this.#grantReferenceMatchesApproval(session.grantReference, authorization)
    );
  }

  #grantReferenceMatchesApproval(
    grantReference: string,
    authorization: ApprovedCalendarWriteContext,
  ): boolean {
    try {
      return (
        grantReference ===
        authorization.approvalBinding.authorityBinding.providerGrantReference
      );
    } catch {
      return false;
    }
  }
}

import { deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

import {
  GoogleCalendarFetchError,
  GoogleCalendarFreeBusyClient,
  GoogleCalendarReadClient,
} from './calendar-fetch.js';
import type { GoogleCalendarOAuthActor } from './oauth/service.js';

interface GoogleCalendarListSmokePort {
  listCalendars(input: unknown): Promise<unknown>;
}

interface GoogleCalendarFreeBusySmokePort {
  query(input: unknown): Promise<unknown>;
}

const ActorSchema: z.ZodType<GoogleCalendarOAuthActor> = z.strictObject({
  userId: z.string().trim().min(1).max(512),
  householdId: z.string().trim().min(1).max(512),
  privateSpaceId: z.string().trim().min(1).max(512),
  sessionId: z.string().trim().min(1).max(512),
});

const CalendarListSmokeResponseSchema = z.looseObject({
  calendars: z
    .array(
      z.looseObject({
        id: z.string().trim().min(1).max(512),
        primary: z.boolean().optional(),
      }),
    )
    .max(1_000),
});

const FreeBusySmokeResponseSchema = z.looseObject({
  calendars: z
    .array(
      z.looseObject({
        calendarId: z.string().trim().min(1).max(512),
        status: z.enum(['available', 'unavailable']),
      }),
    )
    .length(1),
});

const smokeTargetBrand: unique symbol = Symbol(
  'GoogleCalendarCredentialedLiveSmokeTarget',
);

/**
 * Opaque server-composition target. The runtime brand is held only in this
 * module's WeakMap; a structural object or type assertion cannot mint it.
 */
export type GoogleCalendarCredentialedLiveSmokeTarget = Readonly<{
  readonly [smokeTargetBrand]: true;
}>;

type CredentialedLiveClients = Readonly<{
  readClient: GoogleCalendarReadClient;
  freeBusyClient: GoogleCalendarFreeBusyClient;
}>;

const credentialedLiveTargets = new WeakMap<
  GoogleCalendarCredentialedLiveSmokeTarget,
  CredentialedLiveClients
>();

const listCalendarsWithProductionClient =
  GoogleCalendarReadClient.prototype.listCalendars;
const listEventsWithProductionClient =
  GoogleCalendarReadClient.prototype.listEvents;
const queryFreeBusyWithProductionClient =
  GoogleCalendarFreeBusyClient.prototype.query;

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
): ((input: unknown) => Promise<unknown>) | undefined => {
  try {
    if (input === null || typeof input !== 'object') return undefined;
    let current: object | null = input;
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
          methodInput: unknown,
        ) => Promise<unknown>;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const snapshotActor = (
  input: unknown,
): GoogleCalendarOAuthActor | undefined => {
  const snapshot = snapshotPlainRecord(input, [
    'userId',
    'householdId',
    'privateSpaceId',
    'sessionId',
  ]);
  const actor = ActorSchema.safeParse(snapshot);
  return actor.success ? deepFreeze(actor.data) : undefined;
};

const exactProductionClient = <Client extends object>(
  input: unknown,
  constructor: abstract new (...arguments_: never[]) => Client,
  prototype: Client,
): input is Client => {
  try {
    return (
      input instanceof constructor && Object.getPrototypeOf(input) === prototype
    );
  } catch {
    return false;
  }
};

/**
 * Internal Node composition factory. It accepts only exact production client
 * instances. The public Google Calendar facade intentionally does not export
 * this factory or the opaque target type.
 */
export const createGoogleCalendarCredentialedLiveSmokeTarget = (input: {
  readonly readClient: GoogleCalendarReadClient;
  readonly freeBusyClient: GoogleCalendarFreeBusyClient;
}): GoogleCalendarCredentialedLiveSmokeTarget => {
  const clients = snapshotPlainRecord(input, ['readClient', 'freeBusyClient']);
  if (
    clients === undefined ||
    !exactProductionClient(
      clients.readClient,
      GoogleCalendarReadClient,
      GoogleCalendarReadClient.prototype,
    ) ||
    !exactProductionClient(
      clients.freeBusyClient,
      GoogleCalendarFreeBusyClient,
      GoogleCalendarFreeBusyClient.prototype,
    )
  ) {
    throw new Error('invalid-google-calendar-live-smoke-clients');
  }
  const target = Object.freeze(
    Object.create(null),
  ) as GoogleCalendarCredentialedLiveSmokeTarget;
  credentialedLiveTargets.set(
    target,
    Object.freeze({
      readClient: clients.readClient,
      freeBusyClient: clients.freeBusyClient,
    }),
  );
  return target;
};

type SmokeEvidenceBase = Readonly<{
  schemaVersion: 1;
  provider: 'google-calendar';
  operation: 'calendar-list-free-busy';
}>;

export type GoogleCalendarReadOnlySmokeResult = SmokeEvidenceBase &
  Readonly<
    | {
        status: 'skipped';
        evidenceClass: 'not-run';
        releaseEligible: false;
        reason: 'not-enabled';
      }
    | {
        status: 'ready';
        evidenceClass: 'credentialed-live';
        releaseEligible: true;
        calendarCount: number;
        freeBusy: 'available' | 'unavailable';
        checkedAt: string;
      }
    | {
        status: 'unavailable';
        evidenceClass: 'credentialed-live';
        releaseEligible: false;
        safeCode: 'google-calendar-smoke-failed';
        checkedAt: string;
      }
    | {
        status: 'unavailable';
        evidenceClass: 'not-live';
        releaseEligible: false;
        safeCode: 'google-calendar-live-target-required';
        checkedAt: string;
      }
  >;

export type GoogleCalendarReadOnlyFixtureSmokeResult = SmokeEvidenceBase &
  Readonly<
    | {
        status: 'simulated';
        evidenceClass: 'recorded-or-simulated';
        releaseEligible: false;
        calendarCount: number;
        freeBusy: 'available' | 'unavailable';
        checkedAt: string;
      }
    | {
        status: 'unavailable';
        evidenceClass: 'recorded-or-simulated';
        releaseEligible: false;
        safeCode: 'google-calendar-smoke-failed';
        checkedAt: string;
      }
  >;

const smokeEvidenceBase = deepFreeze({
  schemaVersion: 1 as const,
  provider: 'google-calendar' as const,
  operation: 'calendar-list-free-busy' as const,
});

const checkedAtFrom = (clock: unknown): { now: Date; checkedAt: string } => {
  if (typeof clock !== 'function') throw new Error('invalid-smoke-clock');
  const value = (clock as () => unknown)();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('invalid-smoke-clock');
  }
  const now = new Date(value.getTime());
  return { now, checkedAt: now.toISOString() };
};

const executeReadOnlyCheck = async (input: {
  actor: GoogleCalendarOAuthActor;
  now: Date;
  listCalendars: (input: unknown) => Promise<unknown>;
  queryFreeBusy: (input: unknown) => Promise<unknown>;
}): Promise<{
  calendarCount: number;
  freeBusy: 'available' | 'unavailable';
}> => {
  const rawCalendars = await input.listCalendars({ actor: input.actor });
  const calendars = CalendarListSmokeResponseSchema.parse(rawCalendars);
  const target =
    calendars.calendars.find((calendar) => calendar.primary === true) ??
    calendars.calendars[0];
  if (target === undefined) throw new Error('no-calendar');
  const rawFreeBusy = await input.queryFreeBusy({
    actor: input.actor,
    calendarIds: [target.id],
    timeMin: input.now.toISOString(),
    timeMax: new Date(input.now.getTime() + 5 * 60_000).toISOString(),
    timeZone: 'America/Toronto',
  });
  const freeBusy = FreeBusySmokeResponseSchema.parse(rawFreeBusy);
  if (freeBusy.calendars[0]!.calendarId !== target.id) {
    throw new Error('free-busy-target-mismatch');
  }
  return {
    calendarCount: calendars.calendars.length,
    freeBusy: freeBusy.calendars[0]!.status,
  };
};

const isAbortProbeResult = (result: PromiseSettledResult<unknown>): boolean =>
  result.status === 'rejected' &&
  result.reason instanceof GoogleCalendarFetchError &&
  result.reason.kind === 'request-aborted' &&
  result.reason.dispatched === false;

/**
 * Confirms the exact instances also hold the JavaScript private slots created
 * by their constructors. The already-aborted signal guarantees this probe
 * cannot request a credential or dispatch a provider call.
 */
const proveProductionClientPrivateSlots = async (
  clients: CredentialedLiveClients,
  actor: GoogleCalendarOAuthActor,
  now: Date,
): Promise<boolean> => {
  const controller = new AbortController();
  controller.abort();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 60_000).toISOString();
  const results = await Promise.allSettled([
    listEventsWithProductionClient.call(clients.readClient, {
      actor,
      calendarId: 'emdo-smoke-private-slot-probe',
      timeMin,
      timeMax,
      signal: controller.signal,
    }),
    queryFreeBusyWithProductionClient.call(clients.freeBusyClient, {
      actor,
      calendarIds: ['emdo-smoke-private-slot-probe'],
      timeMin,
      timeMax,
      timeZone: 'America/Toronto',
      signal: controller.signal,
    }),
  ]);
  return results.every(isAbortProbeResult);
};

/**
 * Recorded/simulated verification for deterministic tests. Its result is
 * permanently release-ineligible and cannot be confused with live evidence.
 */
export const runGoogleCalendarReadOnlyFixtureSmoke = async (input: {
  readonly actor: GoogleCalendarOAuthActor;
  readonly readClient: GoogleCalendarListSmokePort;
  readonly freeBusyClient: GoogleCalendarFreeBusySmokePort;
  readonly clock?: () => Date;
}): Promise<GoogleCalendarReadOnlyFixtureSmokeResult> => {
  const options = snapshotPlainRecord(
    input,
    ['actor', 'readClient', 'freeBusyClient', 'clock'],
    ['actor', 'readClient', 'freeBusyClient'],
  );
  let checkedAt = new Date(0).toISOString();
  try {
    if (options === undefined) throw new Error('invalid-smoke-options');
    const timing = checkedAtFrom(options.clock ?? (() => new Date()));
    checkedAt = timing.checkedAt;
    const actor = snapshotActor(options.actor);
    const listCalendars = snapshotDataMethod(
      options.readClient,
      'listCalendars',
    );
    const queryFreeBusy = snapshotDataMethod(options.freeBusyClient, 'query');
    if (
      actor === undefined ||
      listCalendars === undefined ||
      queryFreeBusy === undefined
    ) {
      throw new Error('invalid-smoke-options');
    }
    const result = await executeReadOnlyCheck({
      actor,
      now: timing.now,
      listCalendars,
      queryFreeBusy,
    });
    return deepFreeze({
      ...smokeEvidenceBase,
      status: 'simulated' as const,
      evidenceClass: 'recorded-or-simulated' as const,
      releaseEligible: false as const,
      ...result,
      checkedAt,
    });
  } catch {
    return deepFreeze({
      ...smokeEvidenceBase,
      status: 'unavailable' as const,
      evidenceClass: 'recorded-or-simulated' as const,
      releaseEligible: false as const,
      safeCode: 'google-calendar-smoke-failed' as const,
      checkedAt,
    });
  }
};

/**
 * Explicit, read-only credentialed production smoke. It never reads
 * environment variables, returns tokens/calendar names/events, or exercises
 * provider writes. Only an opaque target minted by the internal server
 * composition factory can produce release-eligible evidence.
 */
export const runGoogleCalendarReadOnlySmoke = async (input: {
  readonly enabled: boolean;
  readonly actor: GoogleCalendarOAuthActor;
  readonly target: GoogleCalendarCredentialedLiveSmokeTarget;
  readonly clock?: () => Date;
}): Promise<GoogleCalendarReadOnlySmokeResult> => {
  const options = snapshotPlainRecord(
    input,
    ['enabled', 'actor', 'target', 'clock'],
    ['enabled', 'actor', 'target'],
  );
  if (options?.enabled !== true) {
    return deepFreeze({
      ...smokeEvidenceBase,
      status: 'skipped' as const,
      evidenceClass: 'not-run' as const,
      releaseEligible: false as const,
      reason: 'not-enabled' as const,
    });
  }
  let checkedAt = new Date(0).toISOString();
  let now: Date;
  try {
    const timing = checkedAtFrom(options.clock ?? (() => new Date()));
    checkedAt = timing.checkedAt;
    now = timing.now;
  } catch {
    return deepFreeze({
      ...smokeEvidenceBase,
      status: 'unavailable' as const,
      evidenceClass: 'not-live' as const,
      releaseEligible: false as const,
      safeCode: 'google-calendar-live-target-required' as const,
      checkedAt,
    });
  }
  const clients = credentialedLiveTargets.get(
    options.target as GoogleCalendarCredentialedLiveSmokeTarget,
  );
  const actor = snapshotActor(options.actor);
  if (
    clients === undefined ||
    actor === undefined ||
    !(await proveProductionClientPrivateSlots(clients, actor, now))
  ) {
    return deepFreeze({
      ...smokeEvidenceBase,
      status: 'unavailable' as const,
      evidenceClass: 'not-live' as const,
      releaseEligible: false as const,
      safeCode: 'google-calendar-live-target-required' as const,
      checkedAt,
    });
  }
  try {
    const result = await executeReadOnlyCheck({
      actor,
      now,
      listCalendars: (methodInput) =>
        listCalendarsWithProductionClient.call(clients.readClient, methodInput),
      queryFreeBusy: (methodInput) =>
        queryFreeBusyWithProductionClient.call(
          clients.freeBusyClient,
          methodInput,
        ),
    });
    return deepFreeze({
      ...smokeEvidenceBase,
      status: 'ready' as const,
      evidenceClass: 'credentialed-live' as const,
      releaseEligible: true as const,
      ...result,
      checkedAt,
    });
  } catch {
    return deepFreeze({
      ...smokeEvidenceBase,
      status: 'unavailable' as const,
      evidenceClass: 'credentialed-live' as const,
      releaseEligible: false as const,
      safeCode: 'google-calendar-smoke-failed' as const,
      checkedAt,
    });
  }
};

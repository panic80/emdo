import { createHmac } from 'node:crypto';

import { deepFreeze } from '@emdo/contracts';
import { hashCanonicalJson } from '@emdo/toolbox';
import { z } from 'zod';

import { SchedulerDomainError } from './errors.js';
import { boundedSafeParse } from './validation.js';

const IsoInstantSchema = z.iso.datetime({ offset: true });
const SafeReferenceSchema = z
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
const EvidenceTextSchema = z.string().trim().min(1).max(2_000);

const AuthorizationSchema = z.strictObject({
  calendarId: SafeReferenceSchema,
  access: z.enum(['events', 'free-busy']),
  detailSharing: z.enum(['private', 'household-full']),
});

const BusyIntervalSchema = z.strictObject({
  start: IsoInstantSchema,
  end: IsoInstantSchema,
});

const CalendarEventEvidenceSchema = BusyIntervalSchema.extend({
  eventId: SafeReferenceSchema,
  eventVersion: z.string().trim().min(1).max(512),
  visibility: z.enum(['default', 'public', 'private', 'confidential']),
  summary: EvidenceTextSchema.optional(),
  location: EvidenceTextSchema.optional(),
});

const CalendarSnapshotSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('events'),
    calendarId: SafeReferenceSchema,
    calendarVersion: z.string().trim().min(1).max(512),
    fetchedAt: IsoInstantSchema,
    events: z.array(CalendarEventEvidenceSchema).max(10_000),
  }),
  z.strictObject({
    kind: z.literal('free-busy'),
    calendarId: SafeReferenceSchema,
    calendarVersion: z.string().trim().min(1).max(512),
    fetchedAt: IsoInstantSchema,
    busy: z.array(BusyIntervalSchema).max(10_000),
  }),
]);

const CalendarSnapshotInputSchema = z.strictObject({
  snapshots: z.array(CalendarSnapshotSchema).max(64),
});

type CalendarAuthorization = z.infer<typeof AuthorizationSchema>;

export interface TrustedCalendarAuthorizationResolver {
  /** Implemented by the authenticated, server-scoped calendar repository. */
  listAuthorizedCalendars(): Promise<unknown>;
}

declare const authorizationContextBrand: unique symbol;
export interface TrustedCalendarAuthorizationContext {
  readonly [authorizationContextBrand]: true;
}

const trustedAuthorizationStates = new WeakMap<
  object,
  readonly CalendarAuthorization[]
>();

/** Authorization data is resolved outside all model/client/provider payloads. */
export const resolveTrustedCalendarAuthorizationContext = async (
  resolver: TrustedCalendarAuthorizationResolver,
): Promise<TrustedCalendarAuthorizationContext> => {
  let raw: unknown;
  try {
    raw = await resolver.listAuthorizedCalendars();
  } catch {
    throw new SchedulerDomainError(
      'calendar-authorization-invalid',
      'Authorized calendars could not be resolved.',
    );
  }
  const parsed = boundedSafeParse(
    z.array(AuthorizationSchema).min(1).max(64),
    raw,
  );
  if (!parsed.success) {
    throw new SchedulerDomainError(
      'calendar-authorization-invalid',
      'Authorized calendar policy is invalid or exceeds its bounds.',
    );
  }
  const seen = new Set<string>();
  for (const authorization of parsed.data) {
    if (seen.has(authorization.calendarId)) {
      throw new SchedulerDomainError(
        'calendar-evidence-duplicate',
        'An authorized calendar was supplied more than once.',
      );
    }
    seen.add(authorization.calendarId);
  }
  const context = Object.freeze({}) as TrustedCalendarAuthorizationContext;
  trustedAuthorizationStates.set(context, deepFreeze(parsed.data));
  return context;
};

export interface CalendarPlanningBlock {
  readonly calendarRef: string;
  readonly eventRef: string | null;
  readonly fetchedAt: string;
  readonly start: string;
  readonly end: string;
  readonly details: {
    readonly summary: string;
    readonly location?: string;
  } | null;
  readonly maskReason:
    'calendar-private' | 'event-private' | 'free-busy-only' | null;
}

export interface CalendarPlanningSnapshot {
  readonly calendarRef: string;
  readonly snapshotFingerprint: string;
  readonly fetchedAt: string;
  readonly blockCount: number;
}

export interface CalendarEvidencePolicy {
  readonly now: Date;
  readonly maxSnapshotAgeMs: number;
  readonly referenceNamespace: string;
  /** Server-only random key; never include it in model or client payloads. */
  readonly referenceKey: Uint8Array;
}

const assertPositiveInterval = (start: string, end: string): void => {
  if (Date.parse(end) <= Date.parse(start)) {
    throw new SchedulerDomainError(
      'calendar-evidence-invalid',
      'Calendar evidence contains a non-positive interval.',
    );
  }
};

/**
 * Converts provider evidence to inert planning blocks. Event strings remain
 * display-only evidence; they cannot add capabilities or authorize actions.
 */
export const normalizeAuthorizedCalendarEvidence = (
  authorizationContext: TrustedCalendarAuthorizationContext,
  input: unknown,
  policy: CalendarEvidencePolicy,
): {
  readonly calendarRefs: readonly string[];
  readonly snapshots: readonly CalendarPlanningSnapshot[];
  readonly blocks: readonly CalendarPlanningBlock[];
} => {
  const authorizations = trustedAuthorizationStates.get(authorizationContext);
  if (authorizations === undefined) {
    throw new SchedulerDomainError(
      'calendar-authorization-invalid',
      'Calendar authorization context is not server-issued.',
    );
  }
  if (
    !Number.isSafeInteger(policy.now.getTime()) ||
    !Number.isSafeInteger(policy.maxSnapshotAgeMs) ||
    policy.maxSnapshotAgeMs < 0 ||
    policy.maxSnapshotAgeMs > 86_400_000 ||
    policy.referenceNamespace.length < 16 ||
    policy.referenceNamespace.length > 200 ||
    !(policy.referenceKey instanceof Uint8Array) ||
    policy.referenceKey.byteLength < 32 ||
    policy.referenceKey.byteLength > 64
  ) {
    throw new SchedulerDomainError(
      'calendar-evidence-invalid',
      'Calendar evidence policy is invalid.',
    );
  }
  const parsed = boundedSafeParse(CalendarSnapshotInputSchema, input);
  if (!parsed.success) {
    throw new SchedulerDomainError(
      'calendar-evidence-invalid',
      'Calendar evidence is invalid or exceeds its bounds.',
    );
  }
  const authorizationById = new Map(
    authorizations.map((authorization) => [
      authorization.calendarId,
      authorization,
    ]),
  );

  const snapshots = new Map<string, (typeof parsed.data.snapshots)[number]>();
  for (const snapshot of parsed.data.snapshots) {
    const authorization = authorizationById.get(snapshot.calendarId);
    if (authorization === undefined) {
      throw new SchedulerDomainError(
        'calendar-evidence-unauthorized',
        'Evidence was supplied for a calendar outside the authorized set.',
      );
    }
    if (snapshots.has(snapshot.calendarId)) {
      throw new SchedulerDomainError(
        'calendar-evidence-duplicate',
        'A calendar snapshot was supplied more than once.',
      );
    }
    if (authorization.access === 'free-busy' && snapshot.kind !== 'free-busy') {
      throw new SchedulerDomainError(
        'calendar-evidence-unauthorized',
        'Detailed events cannot be accepted under free-busy-only access.',
      );
    }
    const ageMs = policy.now.getTime() - Date.parse(snapshot.fetchedAt);
    if (ageMs < -300_000 || ageMs > policy.maxSnapshotAgeMs) {
      throw new SchedulerDomainError(
        'calendar-evidence-stale',
        'Calendar evidence is stale or excessively future-dated.',
      );
    }
    snapshots.set(snapshot.calendarId, snapshot);
  }
  for (const calendarId of authorizationById.keys()) {
    if (!snapshots.has(calendarId)) {
      throw new SchedulerDomainError(
        'calendar-evidence-missing',
        'Every authorized calendar requires one planning snapshot.',
      );
    }
  }

  const blocks: CalendarPlanningBlock[] = [];
  const planningSnapshots: CalendarPlanningSnapshot[] = [];
  const opaqueReference = (kind: 'calendar' | 'event', value: string): string =>
    createHmac('sha256', policy.referenceKey)
      .update(
        hashCanonicalJson({
          namespace: policy.referenceNamespace,
          kind,
          value,
        }),
      )
      .digest('hex');
  for (const [calendarId, authorization] of authorizationById) {
    const snapshot = snapshots.get(calendarId)!;
    const calendarRef = opaqueReference('calendar', calendarId);
    let blockCount = 0;
    if (snapshot.kind === 'free-busy') {
      for (const interval of snapshot.busy) {
        assertPositiveInterval(interval.start, interval.end);
        blockCount += 1;
        blocks.push(
          deepFreeze({
            calendarRef,
            eventRef: null,
            fetchedAt: snapshot.fetchedAt,
            start: interval.start,
            end: interval.end,
            details: null,
            maskReason: 'free-busy-only' as const,
          }),
        );
      }
    } else {
      const eventIds = new Set<string>();
      for (const event of snapshot.events) {
        if (eventIds.has(event.eventId)) {
          throw new SchedulerDomainError(
            'calendar-evidence-duplicate',
            'A calendar event was supplied more than once.',
          );
        }
        eventIds.add(event.eventId);
        assertPositiveInterval(event.start, event.end);
        blockCount += 1;
        const calendarPrivate =
          authorization.detailSharing !== 'household-full';
        const eventPrivate =
          event.visibility === 'private' || event.visibility === 'confidential';
        const details =
          calendarPrivate || eventPrivate
            ? null
            : {
                summary: event.summary ?? 'Busy',
                ...(event.location === undefined
                  ? {}
                  : { location: event.location }),
              };
        blocks.push(
          deepFreeze({
            calendarRef,
            eventRef: opaqueReference(
              'event',
              `${calendarId}\u0000${event.eventId}`,
            ),
            fetchedAt: snapshot.fetchedAt,
            start: event.start,
            end: event.end,
            details,
            maskReason: calendarPrivate
              ? ('calendar-private' as const)
              : eventPrivate
                ? ('event-private' as const)
                : null,
          }),
        );
      }
    }
    planningSnapshots.push(
      deepFreeze({
        calendarRef,
        snapshotFingerprint: hashCanonicalJson({
          calendarVersion: snapshot.calendarVersion,
          fetchedAt: snapshot.fetchedAt,
          kind: snapshot.kind,
        }),
        fetchedAt: snapshot.fetchedAt,
        blockCount,
      }),
    );
  }

  const compareCodePoints = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  blocks.sort(
    (left, right) =>
      Date.parse(left.start) - Date.parse(right.start) ||
      compareCodePoints(left.calendarRef, right.calendarRef) ||
      compareCodePoints(left.eventRef ?? '', right.eventRef ?? ''),
  );
  planningSnapshots.sort((left, right) =>
    compareCodePoints(left.calendarRef, right.calendarRef),
  );
  return deepFreeze({
    calendarRefs: planningSnapshots.map((snapshot) => snapshot.calendarRef),
    snapshots: planningSnapshots,
    blocks,
  });
};

const TravelModeSchema = z.enum(['driving', 'transit', 'walking']);
const TravelQuerySchema = z.strictObject({
  origin: SafeReferenceSchema,
  destination: SafeReferenceSchema,
  mode: TravelModeSchema,
  departureAt: IsoInstantSchema,
});
const TravelEvidenceSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    durationSeconds: z.number().int().safe().min(0).max(604_800),
    fetchedAt: IsoInstantSchema,
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.string().trim().min(1).max(160),
  }),
]);

export type TravelMode = z.infer<typeof TravelModeSchema>;

export interface TravelLookup {
  lookup(
    query: z.infer<typeof TravelQuerySchema>,
    options?: { readonly signal: AbortSignal },
  ): Promise<unknown>;
}

export interface TravelBufferPolicy {
  readonly lookup: TravelLookup['lookup'];
  readonly now: Date;
  readonly fixedBufferMinutes: number;
  readonly fallbackMinutes: Readonly<Record<TravelMode, number>>;
  readonly maxEvidenceAgeMs?: number;
  readonly lookupTimeoutMs?: number;
  readonly maxLookupCalls?: number;
}

export interface DeterministicTravelBuffer {
  readonly travelMinutes: number;
  readonly totalBufferMinutes: number;
  readonly source: 'google-maps' | 'fallback' | 'same-location';
  readonly fetchedAt: string | null;
}

const validateTravelPolicy = (policy: TravelBufferPolicy): void => {
  const values = [
    policy.fixedBufferMinutes,
    policy.fallbackMinutes.driving,
    policy.fallbackMinutes.transit,
    policy.fallbackMinutes.walking,
  ];
  if (
    !Number.isSafeInteger(policy.now.getTime()) ||
    values.some(
      (value) => !Number.isSafeInteger(value) || value < 0 || value > 1_440,
    ) ||
    (policy.maxEvidenceAgeMs !== undefined &&
      (!Number.isSafeInteger(policy.maxEvidenceAgeMs) ||
        policy.maxEvidenceAgeMs < 0 ||
        policy.maxEvidenceAgeMs > 86_400_000)) ||
    (policy.lookupTimeoutMs !== undefined &&
      (!Number.isSafeInteger(policy.lookupTimeoutMs) ||
        policy.lookupTimeoutMs < 50 ||
        policy.lookupTimeoutMs > 30_000)) ||
    (policy.maxLookupCalls !== undefined &&
      (!Number.isSafeInteger(policy.maxLookupCalls) ||
        policy.maxLookupCalls < 1 ||
        policy.maxLookupCalls > 64))
  ) {
    throw new SchedulerDomainError(
      'travel-input-invalid',
      'The travel policy is invalid or exceeds its bounds.',
    );
  }
};

const fallbackTravelBuffer = (
  mode: TravelMode,
  policy: TravelBufferPolicy,
): DeterministicTravelBuffer => {
  const travelMinutes = policy.fallbackMinutes[mode];
  return deepFreeze({
    travelMinutes,
    totalBufferMinutes: travelMinutes + policy.fixedBufferMinutes,
    source: 'fallback' as const,
    fetchedAt: null,
  });
};

export const resolveDeterministicTravelBuffer = async (
  input: unknown,
  policy: TravelBufferPolicy,
): Promise<DeterministicTravelBuffer> => {
  const parsed = boundedSafeParse(TravelQuerySchema, input);
  validateTravelPolicy(policy);
  if (!parsed.success) {
    throw new SchedulerDomainError(
      'travel-input-invalid',
      'The travel query is invalid or exceeds its bounds.',
    );
  }
  const query = parsed.data;
  if (
    query.origin.trim().toLocaleLowerCase('en-CA') ===
    query.destination.trim().toLocaleLowerCase('en-CA')
  ) {
    return deepFreeze({
      travelMinutes: 0,
      totalBufferMinutes: policy.fixedBufferMinutes,
      source: 'same-location' as const,
      fetchedAt: null,
    });
  }

  let rawEvidence: unknown;
  const abortController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookup = Promise.resolve().then(() =>
      policy.lookup(query, { signal: abortController.signal }),
    );
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        abortController.abort();
        reject(new Error('Maps lookup timed out'));
      }, policy.lookupTimeoutMs ?? 5_000);
    });
    rawEvidence = await Promise.race([lookup, timedOut]);
  } catch {
    return fallbackTravelBuffer(query.mode, policy);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  const evidence = boundedSafeParse(TravelEvidenceSchema, rawEvidence);
  if (!evidence.success || evidence.data.status === 'unavailable') {
    return fallbackTravelBuffer(query.mode, policy);
  }
  const fetchedAtMs = Date.parse(evidence.data.fetchedAt);
  const ageMs = policy.now.getTime() - fetchedAtMs;
  if (ageMs < -300_000 || ageMs > (policy.maxEvidenceAgeMs ?? 15 * 60_000)) {
    return fallbackTravelBuffer(query.mode, policy);
  }

  const travelMinutes = Math.ceil(evidence.data.durationSeconds / 60);
  return deepFreeze({
    travelMinutes,
    totalBufferMinutes: travelMinutes + policy.fixedBufferMinutes,
    source: 'google-maps' as const,
    fetchedAt: evidence.data.fetchedAt,
  });
};

const PlanningBusySchema = BusyIntervalSchema.extend({
  location: SafeReferenceSchema.optional(),
});
const RankingInputSchema = z.strictObject({
  windowStart: IsoInstantSchema,
  windowEnd: IsoInstantSchema,
  durationMinutes: z.number().int().safe().min(1).max(10_080),
  stepMinutes: z.number().int().safe().min(5).max(1_440),
  preferredStart: IsoInstantSchema,
  appointmentLocation: SafeReferenceSchema.optional(),
  travelMode: TravelModeSchema,
  maxAlternatives: z.number().int().safe().min(1).max(20),
  busy: z.array(PlanningBusySchema).max(2_000),
});

export interface RankedScheduleAlternative {
  readonly start: string;
  readonly end: string;
  readonly score: number;
  readonly travelBeforeMinutes: number;
  readonly travelAfterMinutes: number;
  readonly travelEvidence: readonly (
    'google-maps' | 'fallback' | 'same-location'
  )[];
}

const overlaps = (
  startMs: number,
  endMs: number,
  busyStartMs: number,
  busyEndMs: number,
): boolean => startMs < busyEndMs && endMs > busyStartMs;

export const rankScheduleAlternatives = async (
  input: unknown,
  travelPolicy: TravelBufferPolicy,
): Promise<readonly RankedScheduleAlternative[]> => {
  const parsed = boundedSafeParse(RankingInputSchema, input);
  validateTravelPolicy(travelPolicy);
  if (!parsed.success) {
    throw new SchedulerDomainError(
      'planning-input-invalid',
      'The planning request is invalid or exceeds its bounds.',
    );
  }
  const request = parsed.data;
  const windowStartMs = Date.parse(request.windowStart);
  const windowEndMs = Date.parse(request.windowEnd);
  const preferredStartMs = Date.parse(request.preferredStart);
  if (
    windowEndMs <= windowStartMs ||
    windowEndMs - windowStartMs > 7 * 86_400_000
  ) {
    throw new SchedulerDomainError(
      'planning-input-invalid',
      'The planning window must be positive and no longer than seven days.',
    );
  }
  const busy = request.busy
    .map((block) => {
      assertPositiveInterval(block.start, block.end);
      return {
        ...block,
        startMs: Date.parse(block.start),
        endMs: Date.parse(block.end),
      };
    })
    .sort((left, right) => left.startMs - right.startMs);
  const durationMs = request.durationMinutes * 60_000;
  const stepMs = request.stepMinutes * 60_000;
  const candidateCount = Math.floor((windowEndMs - windowStartMs) / stepMs) + 1;
  if (candidateCount > 2_100) {
    throw new SchedulerDomainError(
      'planning-input-invalid',
      'The planning request contains too many candidate slots.',
    );
  }

  const alternatives: RankedScheduleAlternative[] = [];
  const travelCache = new Map<string, Promise<DeterministicTravelBuffer>>();
  let lookupCalls = 0;
  const travel = async (
    origin: string | undefined,
    destination: string | undefined,
    departureAt: string,
  ): Promise<DeterministicTravelBuffer> => {
    if (origin === undefined || destination === undefined) {
      return fallbackTravelBuffer(request.travelMode, travelPolicy);
    }
    const key = JSON.stringify([
      origin,
      destination,
      request.travelMode,
      departureAt,
    ]);
    const existing = travelCache.get(key);
    if (existing !== undefined) return existing;
    if (lookupCalls >= (travelPolicy.maxLookupCalls ?? 16)) {
      return fallbackTravelBuffer(request.travelMode, travelPolicy);
    }
    lookupCalls += 1;
    const pending = resolveDeterministicTravelBuffer(
      {
        origin,
        destination,
        mode: request.travelMode,
        departureAt,
      },
      travelPolicy,
    );
    travelCache.set(key, pending);
    return pending;
  };

  for (
    let candidateStartMs = windowStartMs;
    candidateStartMs + durationMs <= windowEndMs;
    candidateStartMs += stepMs
  ) {
    const candidateEndMs = candidateStartMs + durationMs;
    if (
      busy.some((block) =>
        overlaps(candidateStartMs, candidateEndMs, block.startMs, block.endMs),
      )
    ) {
      continue;
    }
    const previous = busy.reduce<(typeof busy)[number] | undefined>(
      (latest, block) =>
        block.endMs <= candidateStartMs &&
        (latest === undefined || block.endMs > latest.endMs)
          ? block
          : latest,
      undefined,
    );
    const next = busy.reduce<(typeof busy)[number] | undefined>(
      (earliest, block) =>
        block.startMs >= candidateEndMs &&
        (earliest === undefined || block.startMs < earliest.startMs)
          ? block
          : earliest,
      undefined,
    );
    const [before, after] = await Promise.all([
      previous === undefined
        ? null
        : travel(previous.location, request.appointmentLocation, previous.end),
      next === undefined
        ? null
        : travel(
            request.appointmentLocation,
            next.location,
            new Date(candidateEndMs).toISOString(),
          ),
    ]);
    if (
      (previous !== undefined &&
        previous.endMs + (before?.totalBufferMinutes ?? 0) * 60_000 >
          candidateStartMs) ||
      (next !== undefined &&
        candidateEndMs + (after?.totalBufferMinutes ?? 0) * 60_000 >
          next.startMs)
    ) {
      continue;
    }

    const sources = [before?.source, after?.source].filter(
      (source): source is DeterministicTravelBuffer['source'] =>
        source !== undefined,
    );
    const fallbackPenalty =
      sources.filter((source) => source === 'fallback').length * 120;
    alternatives.push(
      deepFreeze({
        start: new Date(candidateStartMs).toISOString(),
        end: new Date(candidateEndMs).toISOString(),
        score:
          Math.ceil(Math.abs(candidateStartMs - preferredStartMs) / 60_000) +
          fallbackPenalty,
        travelBeforeMinutes: before?.totalBufferMinutes ?? 0,
        travelAfterMinutes: after?.totalBufferMinutes ?? 0,
        travelEvidence: sources,
      }),
    );
  }

  alternatives.sort(
    (left, right) =>
      left.score - right.score ||
      Date.parse(left.start) - Date.parse(right.start),
  );
  return deepFreeze(alternatives.slice(0, request.maxAlternatives));
};

import { deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

import {
  GOOGLE_CALENDAR_PURPOSE_SCOPES,
  GOOGLE_CALENDAR_SCOPES,
  type GoogleCalendarOAuthActor,
  type GoogleOAuthFlowRecord,
  type GoogleOAuthFlowStore,
  type GoogleOAuthFlowConsumeResult,
} from './service.js';

const StateIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const ActorSchema = z.strictObject({
  userId: z.string().trim().min(1).max(512),
  householdId: z.string().trim().min(1).max(512),
  privateSpaceId: z.string().trim().min(1).max(512),
  sessionId: z.string().trim().min(1).max(512),
});
const CalendarScopeSchema = z.enum([
  GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
  GOOGLE_CALENDAR_SCOPES.eventsReadonly,
  GOOGLE_CALENDAR_SCOPES.freeBusy,
  GOOGLE_CALENDAR_SCOPES.events,
]);
const FlowSchema = z
  .strictObject({
    id: StateIdSchema,
    actor: ActorSchema,
    redirectUri: z
      .url()
      .refine((value) => new URL(value).protocol === 'https:'),
    purpose: z.enum(['calendar-read', 'calendar-event-write']),
    requestedScopes: z.array(CalendarScopeSchema).min(1).max(4),
    credentialRevisionAtStart: z.number().int().safe().positive().nullable(),
    authorizationEpochAtStart: z.number().int().safe().nonnegative(),
    codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    createdAt: z.date().refine((value) => Number.isFinite(value.getTime())),
    expiresAt: z.date().refine((value) => Number.isFinite(value.getTime())),
  })
  .superRefine((value, context) => {
    if (value.expiresAt.getTime() <= value.createdAt.getTime()) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'OAuth flow expiry must follow creation',
      });
    }
    if (value.expiresAt.getTime() - value.createdAt.getTime() > 600_000) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'OAuth flow lifetime cannot exceed ten minutes',
      });
    }
    if (new Set(value.requestedScopes).size !== value.requestedScopes.length) {
      context.addIssue({
        code: 'custom',
        path: ['requestedScopes'],
        message: 'OAuth scopes must be unique',
      });
    }
    const allowed = new Set(GOOGLE_CALENDAR_PURPOSE_SCOPES[value.purpose]);
    if (value.requestedScopes.some((scope) => !allowed.has(scope))) {
      context.addIssue({
        code: 'custom',
        path: ['requestedScopes'],
        message: 'OAuth scope exceeds the flow purpose',
      });
    }
  });

const ConsumeInputSchema = z.strictObject({
  id: StateIdSchema,
  actor: ActorSchema,
});

const isBoundedPlainData = (input: unknown): boolean => {
  const pending: Array<{ value: unknown; depth: number; exit?: true }> = [
    { value: input, depth: 0 },
  ];
  const active = new WeakSet<object>();
  let count = 0;
  try {
    while (pending.length > 0) {
      const item = pending.pop()!;
      count += 1;
      if (count > 256 || item.depth > 8) return false;
      if (item.exit) {
        if (item.value !== null && typeof item.value === 'object') {
          active.delete(item.value);
        }
        continue;
      }
      if (item.value === null || typeof item.value !== 'object') continue;
      const prototype = Object.getPrototypeOf(item.value);
      if (prototype === Date.prototype) {
        if (!Number.isFinite(Date.prototype.getTime.call(item.value))) {
          return false;
        }
        continue;
      }
      if (active.has(item.value)) return false;
      if (
        !Array.isArray(item.value) &&
        prototype !== Object.prototype &&
        prototype !== null
      ) {
        return false;
      }
      active.add(item.value);
      pending.push({ value: item.value, depth: item.depth, exit: true });
      for (const descriptor of Object.values(
        Object.getOwnPropertyDescriptors(item.value),
      )) {
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
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

const cloneFlow = (input: unknown): GoogleOAuthFlowRecord => {
  if (!isBoundedPlainData(input))
    throw new Error('OAuth flow must be plain data');
  const flow = FlowSchema.parse(input);
  return deepFreeze({
    id: flow.id,
    actor: { ...flow.actor },
    redirectUri: flow.redirectUri,
    purpose: flow.purpose,
    requestedScopes: [...flow.requestedScopes],
    credentialRevisionAtStart: flow.credentialRevisionAtStart,
    authorizationEpochAtStart: flow.authorizationEpochAtStart,
    codeVerifier: flow.codeVerifier,
    createdAt: new Date(flow.createdAt),
    expiresAt: new Date(flow.expiresAt),
  });
};

const sameActor = (
  left: GoogleCalendarOAuthActor,
  right: GoogleCalendarOAuthActor,
): boolean =>
  left.userId === right.userId &&
  left.householdId === right.householdId &&
  left.privateSpaceId === right.privateSpaceId &&
  left.sessionId === right.sessionId;

export class InMemoryGoogleOAuthFlowStore implements GoogleOAuthFlowStore {
  readonly #records = new Map<string, GoogleOAuthFlowRecord>();

  constructor(private readonly clock: () => Date) {}

  async put(record: GoogleOAuthFlowRecord): Promise<boolean> {
    const candidate = cloneFlow(record);
    if (this.#records.has(candidate.id)) return false;
    this.#records.set(candidate.id, candidate);
    return true;
  }

  async consume(input: {
    readonly id: string;
    readonly actor: GoogleCalendarOAuthActor;
  }): Promise<GoogleOAuthFlowConsumeResult> {
    if (!isBoundedPlainData(input)) {
      throw new Error('OAuth flow consume input must be plain data');
    }
    const parsed = ConsumeInputSchema.parse(input);
    const record = this.#records.get(parsed.id);
    if (record === undefined) return deepFreeze({ status: 'missing' as const });
    if (!sameActor(record.actor, parsed.actor)) {
      return deepFreeze({ status: 'binding-mismatch' as const });
    }
    const now = this.clock();
    if (!Number.isFinite(now.getTime()))
      throw new Error('Invalid OAuth flow clock');
    this.#records.delete(parsed.id);
    if (now.getTime() >= record.expiresAt.getTime()) {
      return deepFreeze({ status: 'expired' as const });
    }
    return deepFreeze({ status: 'consumed' as const, flow: cloneFlow(record) });
  }

  async invalidateActor(actorInput: GoogleCalendarOAuthActor): Promise<number> {
    if (!isBoundedPlainData(actorInput)) {
      throw new Error('OAuth flow invalidation actor must be plain data');
    }
    const actor = ActorSchema.parse(actorInput);
    let invalidated = 0;
    for (const [id, record] of this.#records) {
      if (
        record.actor.userId === actor.userId &&
        record.actor.householdId === actor.householdId &&
        record.actor.privateSpaceId === actor.privateSpaceId
      ) {
        this.#records.delete(id);
        invalidated += 1;
      }
    }
    return invalidated;
  }
}

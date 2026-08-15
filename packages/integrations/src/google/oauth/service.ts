import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  IdempotencyKeySchema,
  OpaqueReferenceSchema,
  deepFreeze,
  type DeepReadonly,
} from '@emdo/contracts';
import { z } from 'zod';

export const GOOGLE_CALENDAR_SCOPES = Object.freeze({
  calendarListReadonly:
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  eventsReadonly: 'https://www.googleapis.com/auth/calendar.events.readonly',
  freeBusy: 'https://www.googleapis.com/auth/calendar.freebusy',
  events: 'https://www.googleapis.com/auth/calendar.events',
} as const);

export type GoogleCalendarScope =
  (typeof GOOGLE_CALENDAR_SCOPES)[keyof typeof GOOGLE_CALENDAR_SCOPES];

export type GoogleCalendarAuthorizationPurpose =
  'calendar-read' | 'calendar-event-write';

const CalendarScopeSchema = z.enum([
  GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
  GOOGLE_CALENDAR_SCOPES.eventsReadonly,
  GOOGLE_CALENDAR_SCOPES.freeBusy,
  GOOGLE_CALENDAR_SCOPES.events,
]);

export const GoogleCalendarCredentialSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    grantReference: OpaqueReferenceSchema.min(16).max(160),
    accessToken: z.string().min(1).max(8_192),
    refreshToken: z.string().min(1).max(2_048),
    tokenType: z.literal('Bearer'),
    scopes: z.array(CalendarScopeSchema).min(1).max(4),
    expiresAt: z.iso.datetime({ offset: true }),
    connectedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((value, context) => {
    if (new Set(value.scopes).size !== value.scopes.length) {
      context.addIssue({
        code: 'custom',
        path: ['scopes'],
        message: 'Calendar credential scopes must be unique',
      });
    }
  });

export type GoogleCalendarCredential = DeepReadonly<
  z.infer<typeof GoogleCalendarCredentialSchema>
>;

const VersionedCredentialSchema = z.strictObject({
  revision: z.number().int().safe().positive(),
  authorizationEpoch: z.number().int().safe().nonnegative(),
  credential: GoogleCalendarCredentialSchema,
});

export interface VersionedGoogleCalendarCredential {
  readonly revision: number;
  readonly authorizationEpoch: number;
  readonly credential: GoogleCalendarCredential;
}

const ActorSchema = z.strictObject({
  userId: z.string().trim().min(1).max(512),
  householdId: z.string().trim().min(1).max(512),
  privateSpaceId: z.string().trim().min(1).max(512),
  sessionId: z.string().trim().min(1).max(512),
});

export const GoogleCalendarAuthorizationStartInputSchema = z.strictObject({
  actor: ActorSchema,
  purpose: z.enum(['calendar-read', 'calendar-event-write']),
  idempotencyKey: IdempotencyKeySchema,
});

const CONFIGURATION_SCHEMA = z
  .strictObject({
    calendarClientId: z.string().trim().min(8).max(512),
    calendarClientSecret: z.string().min(16).max(1_024),
    identityClientId: z.string().trim().min(8).max(512),
    redirectUri: z.url(),
    stateSigningKey: z.instanceof(Uint8Array),
  })
  .superRefine((configuration, context) => {
    if (configuration.calendarClientId === configuration.identityClientId) {
      context.addIssue({
        code: 'custom',
        path: ['calendarClientId'],
        message: 'Calendar and identity OAuth clients must be distinct',
      });
    }
    const redirect = new URL(configuration.redirectUri);
    if (
      redirect.protocol !== 'https:' ||
      redirect.username !== '' ||
      redirect.password !== '' ||
      redirect.search !== '' ||
      redirect.hash !== ''
    ) {
      context.addIssue({
        code: 'custom',
        path: ['redirectUri'],
        message: 'Calendar OAuth redirect must be an exact HTTPS URL',
      });
    }
    if (configuration.stateSigningKey.byteLength < 32) {
      context.addIssue({
        code: 'custom',
        path: ['stateSigningKey'],
        message: 'OAuth state signing key must be at least 32 bytes',
      });
    }
  });

export const GOOGLE_CALENDAR_PURPOSE_SCOPES: Readonly<
  Record<GoogleCalendarAuthorizationPurpose, readonly GoogleCalendarScope[]>
> = Object.freeze({
  'calendar-read': Object.freeze([
    GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
    GOOGLE_CALENDAR_SCOPES.eventsReadonly,
    GOOGLE_CALENDAR_SCOPES.freeBusy,
  ]),
  'calendar-event-write': Object.freeze([
    GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
    GOOGLE_CALENDAR_SCOPES.events,
  ]),
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
      if (count > 512 || item.depth > 10) return false;
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

const assertPlainRouteInput = (input: unknown): void => {
  if (!isBoundedPlainData(input)) {
    throw new Error('Google Calendar OAuth route input must be plain data');
  }
};

export interface GoogleCalendarOAuthActor {
  readonly userId: string;
  readonly householdId: string;
  readonly privateSpaceId: string;
  readonly sessionId: string;
}

export interface GoogleOAuthFlowRecord {
  readonly id: string;
  readonly actor: GoogleCalendarOAuthActor;
  readonly redirectUri: string;
  readonly purpose: GoogleCalendarAuthorizationPurpose;
  readonly requestedScopes: readonly GoogleCalendarScope[];
  readonly credentialRevisionAtStart: number | null;
  readonly authorizationEpochAtStart: number;
  readonly codeVerifier: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface GoogleOAuthFlowStore {
  storeAuthorizationStart(input: {
    readonly actor: GoogleCalendarOAuthActor;
    readonly purpose: GoogleCalendarAuthorizationPurpose;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
    readonly result: GoogleCalendarAuthorizationRouteResult;
    readonly flow?: GoogleOAuthFlowRecord;
  }): Promise<
    | {
        readonly status: 'stored' | 'replayed';
        readonly result: GoogleCalendarAuthorizationRouteResult;
      }
    | { readonly status: 'conflict' | 'expired' }
  >;
  consume(input: {
    readonly id: string;
    readonly actor: GoogleCalendarOAuthActor;
  }): Promise<GoogleOAuthFlowConsumeResult>;
  invalidateActor(actor: GoogleCalendarOAuthActor): Promise<number>;
}

export type GoogleOAuthFlowConsumeResult =
  | { readonly status: 'consumed'; readonly flow: GoogleOAuthFlowRecord }
  | { readonly status: 'missing' | 'expired' | 'binding-mismatch' };

export class GoogleOAuthAuthorizationStartFailure extends Error {
  override readonly name = 'GoogleOAuthAuthorizationStartFailure';

  constructor(readonly reason: 'conflict' | 'expired') {
    super(`Google Calendar OAuth authorization start ${reason}`);
  }
}

export class GoogleOAuthDisconnectFailure extends Error {
  override readonly name = 'GoogleOAuthDisconnectFailure';

  constructor(readonly reason: 'conflict') {
    super('Google Calendar OAuth disconnect idempotency conflict');
  }
}

/**
 * Durable per-private-grant tombstone. Epoch zero represents a grant that has
 * never been invalidated. Advancing must be atomic and survive credential
 * deletion so a stale OAuth flow cannot exploit credential revision ABA.
 */
export interface GoogleOAuthAuthorizationEpochStore {
  load(actor: GoogleCalendarOAuthActor): Promise<number>;
  advance(input: {
    readonly actor: GoogleCalendarOAuthActor;
    readonly expectedEpoch: number;
  }): Promise<
    | { readonly status: 'advanced'; readonly authorizationEpoch: number }
    | { readonly status: 'conflict' }
  >;
}

const DisconnectResultSchema = z.strictObject({
  status: z.literal('disconnected'),
  providerRevocation: z.enum(['not-applicable', 'confirmed', 'unconfirmed']),
});
const DisconnectClaimResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('claimed'),
    operationId: OpaqueReferenceSchema.min(16).max(160),
    credentialRevision: z.number().int().safe().positive().nullable(),
    authorizationEpoch: z.number().int().safe().nonnegative(),
  }),
  z.strictObject({
    status: z.literal('dispatching'),
    operationId: OpaqueReferenceSchema.min(16).max(160),
  }),
  z.strictObject({
    status: z.literal('replayed'),
    result: DisconnectResultSchema,
  }),
  z.strictObject({ status: z.literal('conflict') }),
]);
const DisconnectDispatchResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('dispatching') }),
  z.strictObject({
    status: z.literal('replayed'),
    result: DisconnectResultSchema,
  }),
  z.strictObject({ status: z.literal('conflict') }),
]);
const DisconnectSettlementResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.enum(['stored', 'replayed']),
    result: DisconnectResultSchema,
  }),
  z.strictObject({ status: z.literal('conflict') }),
]);

/**
 * Durable external-side-effect fence. A production implementation must make
 * each transition transactional and must never move dispatching back to
 * claimed. Marking dispatching atomically revokes the local grant and advances
 * its authorization epoch before provider I/O; a dispatching retry records an
 * unconfirmed outcome without another provider call.
 */
export interface GoogleOAuthDisconnectOperationStore {
  claim(input: {
    readonly actor: GoogleCalendarOAuthActor;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
  }): Promise<z.output<typeof DisconnectClaimResultSchema>>;
  markDispatching(input: {
    readonly actor: GoogleCalendarOAuthActor;
    readonly operationId: string;
  }): Promise<z.output<typeof DisconnectDispatchResultSchema>>;
  settle(input: {
    readonly actor: GoogleCalendarOAuthActor;
    readonly operationId: string;
    readonly providerRevocation: 'not-applicable' | 'confirmed' | 'unconfirmed';
  }): Promise<z.output<typeof DisconnectSettlementResultSchema>>;
}

export interface GoogleCalendarCredentialVault {
  load(
    actor: GoogleCalendarOAuthActor,
  ): Promise<VersionedGoogleCalendarCredential | undefined>;
  compareAndSet(input: {
    readonly actor: GoogleCalendarOAuthActor;
    readonly expectedRevision: number | null;
    readonly authorizationEpoch: number;
    readonly credential: GoogleCalendarCredential;
  }): Promise<
    | { readonly status: 'stored'; readonly revision: number }
    | { readonly status: 'conflict' }
  >;
  delete(input: {
    readonly actor: GoogleCalendarOAuthActor;
    readonly expectedRevision: number;
  }): Promise<boolean>;
}

export interface GoogleOAuthTransport {
  exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
  }): Promise<unknown>;
  refreshAccessToken(input: {
    readonly refreshToken: string;
    readonly clientId: string;
    readonly clientSecret: string;
  }): Promise<unknown>;
  revokeToken(input: { readonly token: string }): Promise<unknown>;
}

export type GoogleOAuthAuditEvent = Readonly<{
  event:
    | 'google-calendar.oauth-authorization-started'
    | 'google-calendar.oauth-exchange-started'
    | 'google-calendar.oauth-connected'
    | 'google-calendar.oauth-failed'
    | 'google-calendar.oauth-refresh-started'
    | 'google-calendar.oauth-refreshed'
    | 'google-calendar.oauth-disconnect-started'
    | 'google-calendar.oauth-disconnected';
  userId: string;
  householdId: string;
  purpose?: GoogleCalendarAuthorizationPurpose;
  outcome: 'started' | 'success' | 'denied' | 'failed' | 'unconfirmed';
  safeCode?: GoogleCalendarOAuthErrorCode;
}>;

export interface GoogleOAuthAuditSink {
  record(event: GoogleOAuthAuditEvent): Promise<void>;
}

/**
 * The production implementation must serialize by the exact private Calendar
 * grant across API and worker processes (for example, with a PostgreSQL
 * advisory lock). The callback may include provider I/O, so it must not be a
 * transaction that holds RLS state or unrelated database locks.
 */
export interface GoogleOAuthGrantLease {
  runExclusive<Value>(
    actor: GoogleCalendarOAuthActor,
    operation: () => Promise<Value>,
  ): Promise<Value>;
}

export type GoogleOAuthTransportFailureReason =
  'invalid-grant' | 'temporarily-unavailable' | 'provider-rejected';

export class GoogleOAuthTransportFailure extends Error {
  override readonly name = 'GoogleOAuthTransportFailure';

  constructor(readonly reason: GoogleOAuthTransportFailureReason) {
    super('Google OAuth transport failed');
  }
}

export type GoogleCalendarOAuthErrorCode =
  | 'invalid-oauth-state'
  | 'oauth-state-binding-mismatch'
  | 'oauth-state-expired'
  | 'oauth-grant-invalidated'
  | 'authorization-denied'
  | 'provider-unavailable'
  | 'invalid-provider-response'
  | 'required-scope-not-granted'
  | 'unexpected-provider-scope'
  | 'scope-reconciliation-required'
  | 'offline-grant-unavailable'
  | 'credential-write-conflict'
  | 'calendar-reconnect-required'
  | 'calendar-not-connected'
  | 'connector-unavailable';

const SAFE_MESSAGES: Readonly<Record<GoogleCalendarOAuthErrorCode, string>> =
  Object.freeze({
    'invalid-oauth-state':
      'Google Calendar authorization could not be verified.',
    'oauth-state-binding-mismatch':
      'Google Calendar authorization belongs to a different session.',
    'oauth-state-expired': 'Google Calendar authorization has expired.',
    'oauth-grant-invalidated':
      'Google Calendar authorization was invalidated. Please reconnect.',
    'authorization-denied': 'Google Calendar authorization was not completed.',
    'provider-unavailable':
      'Google Calendar authorization is temporarily unavailable.',
    'invalid-provider-response':
      'Google Calendar returned an invalid authorization response.',
    'required-scope-not-granted':
      'Google Calendar did not grant the required permission.',
    'unexpected-provider-scope':
      'Google Calendar returned an unexpected permission.',
    'scope-reconciliation-required':
      'Google Calendar permissions changed and must be reconciled.',
    'offline-grant-unavailable':
      'Google Calendar offline access was not granted.',
    'credential-write-conflict':
      'Google Calendar authorization changed concurrently. Please retry.',
    'calendar-reconnect-required': 'Google Calendar must be reconnected.',
    'calendar-not-connected': 'Google Calendar is not connected.',
    'connector-unavailable': 'Google Calendar is not configured.',
  });

export class GoogleCalendarOAuthError extends Error {
  override readonly name = 'GoogleCalendarOAuthError';

  constructor(readonly code: GoogleCalendarOAuthErrorCode) {
    super(SAFE_MESSAGES[code]);
  }
}

const CallbackSuccessSchema = z.strictObject({
  actor: ActorSchema,
  state: z.string().min(1).max(256),
  code: z.string().min(1).max(512),
});

const CallbackErrorSchema = z.strictObject({
  actor: ActorSchema,
  state: z.string().min(1).max(256),
  error: z.string().min(1).max(160),
  errorDescription: z.string().max(2_048).optional(),
});

export const GoogleCalendarOAuthCallbackInputSchema = z.union([
  CallbackSuccessSchema,
  CallbackErrorSchema,
]);

const TokenResponseSchema = z.strictObject({
  access_token: z.string().min(1).max(8_192),
  refresh_token: z.string().min(1).max(2_048).optional(),
  expires_in: z.number().int().safe().positive().max(604_800),
  token_type: z.literal('Bearer'),
  scope: z.string().trim().min(1).max(8_192),
  refresh_token_expires_in: z.number().int().safe().positive().optional(),
});

const RefreshTokenResponseSchema = z.strictObject({
  access_token: z.string().min(1).max(8_192),
  refresh_token: z.string().min(1).max(2_048).optional(),
  expires_in: z.number().int().safe().positive().max(604_800),
  token_type: z.literal('Bearer'),
  scope: z.string().trim().min(1).max(8_192).optional(),
  refresh_token_expires_in: z.number().int().safe().positive().optional(),
});

export const GoogleCalendarConnectionActorInputSchema = z.strictObject({
  actor: ActorSchema,
});
export const GoogleCalendarDisconnectInputSchema = z.strictObject({
  actor: ActorSchema,
  idempotencyKey: IdempotencyKeySchema,
});
export const GoogleCalendarCapabilityLeaseInputSchema = z.strictObject({
  actor: ActorSchema,
  capability: z.enum(['calendar-read', 'calendar-event-write']),
});

export interface GoogleCalendarOAuthServiceOptions {
  readonly configuration: {
    readonly calendarClientId: string;
    readonly calendarClientSecret: string;
    readonly identityClientId: string;
    readonly redirectUri: string;
    readonly stateSigningKey: Uint8Array;
  };
  readonly flowStore: GoogleOAuthFlowStore;
  readonly credentialVault: GoogleCalendarCredentialVault;
  readonly authorizationEpochStore: GoogleOAuthAuthorizationEpochStore;
  readonly disconnectOperationStore: GoogleOAuthDisconnectOperationStore;
  readonly transport: GoogleOAuthTransport;
  readonly audit: GoogleOAuthAuditSink;
  readonly grantLease: GoogleOAuthGrantLease;
  readonly clock: () => Date;
  readonly entropy: (length: number) => Uint8Array;
}

export class GoogleCalendarOAuthService {
  readonly #configuration: Omit<
    GoogleCalendarOAuthServiceOptions['configuration'],
    'stateSigningKey'
  >;
  readonly #stateSigningKey: Buffer;
  readonly #flowStore: GoogleOAuthFlowStore;
  readonly #credentialVault: GoogleCalendarCredentialVault;
  readonly #authorizationEpochStore: GoogleOAuthAuthorizationEpochStore;
  readonly #disconnectOperationStore: GoogleOAuthDisconnectOperationStore;
  readonly #transport: GoogleOAuthTransport;
  readonly #audit: GoogleOAuthAuditSink;
  readonly #grantLease: GoogleOAuthGrantLease;
  readonly #clock: () => Date;
  readonly #entropy: (length: number) => Uint8Array;
  #available = true;

  constructor(options: GoogleCalendarOAuthServiceOptions) {
    const configuration = CONFIGURATION_SCHEMA.parse(options.configuration);
    this.#configuration = Object.freeze({
      calendarClientId: configuration.calendarClientId,
      calendarClientSecret: configuration.calendarClientSecret,
      identityClientId: configuration.identityClientId,
      redirectUri: configuration.redirectUri,
    });
    this.#stateSigningKey = Buffer.from(configuration.stateSigningKey);
    this.#flowStore = options.flowStore;
    this.#credentialVault = options.credentialVault;
    this.#authorizationEpochStore = options.authorizationEpochStore;
    this.#disconnectOperationStore = options.disconnectOperationStore;
    this.#transport = options.transport;
    this.#audit = options.audit;
    this.#grantLease = options.grantLease;
    this.#clock = options.clock;
    this.#entropy = options.entropy;
  }

  async beginAuthorization(input: unknown) {
    this.#assertAvailable();
    assertPlainRouteInput(input);
    const parsed = GoogleCalendarAuthorizationStartInputSchema.parse(input);
    return this.#grantLease.runExclusive(parsed.actor, async () => {
      const requestFingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            domain: 'emdo.google-calendar.oauth-start.v1',
            purpose: parsed.purpose,
          }),
        )
        .digest('hex');
      const now = this.#now();
      const authorizationEpoch = await this.#loadAuthorizationEpoch(
        parsed.actor,
      );
      const current = await this.#credentialVault.load(parsed.actor);
      const parsedCurrent =
        current === undefined
          ? undefined
          : VersionedCredentialSchema.parse(current);
      const activeCurrent =
        parsedCurrent?.authorizationEpoch === authorizationEpoch
          ? parsedCurrent
          : undefined;
      const grantedScopes = new Set(activeCurrent?.credential.scopes ?? []);
      const requestedScopes = GOOGLE_CALENDAR_PURPOSE_SCOPES[
        parsed.purpose
      ].filter((scope) => !grantedScopes.has(scope));
      if (requestedScopes.length === 0) {
        const result = deepFreeze({
          status: 'already-authorized' as const,
          grantedPurposes: [parsed.purpose],
        });
        const stored = await this.#flowStore.storeAuthorizationStart({
          actor: parsed.actor,
          purpose: parsed.purpose,
          idempotencyKey: parsed.idempotencyKey,
          requestFingerprint,
          result,
        });
        if (!('result' in stored)) {
          throw new GoogleOAuthAuthorizationStartFailure(stored.status);
        }
        return deepFreeze(stored.result);
      }

      const stateId = this.#randomBase64Url(32, 'OAuth state');
      const codeVerifier = this.#randomBase64Url(32, 'PKCE verifier');
      const createdAt = new Date(now);
      const expiresAt = new Date(now.getTime() + 10 * 60 * 1_000);
      const flow = deepFreeze({
        id: stateId,
        actor: parsed.actor,
        redirectUri: this.#configuration.redirectUri,
        purpose: parsed.purpose,
        requestedScopes,
        credentialRevisionAtStart: parsedCurrent?.revision ?? null,
        authorizationEpochAtStart: authorizationEpoch,
        codeVerifier,
        createdAt,
        expiresAt,
      });
      const signature = createHmac('sha256', this.#stateSigningKey)
        .update('emdo.google-calendar.oauth-state.v1\0')
        .update(stateId)
        .digest('base64url');
      const state = `v1.${stateId}.${signature}`;
      const authorizationUrl = new URL(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
      authorizationUrl.searchParams.set(
        'client_id',
        this.#configuration.calendarClientId,
      );
      authorizationUrl.searchParams.set(
        'redirect_uri',
        this.#configuration.redirectUri,
      );
      authorizationUrl.searchParams.set('response_type', 'code');
      authorizationUrl.searchParams.set('access_type', 'offline');
      authorizationUrl.searchParams.set('include_granted_scopes', 'true');
      authorizationUrl.searchParams.set('scope', requestedScopes.join(' '));
      authorizationUrl.searchParams.set('state', state);
      authorizationUrl.searchParams.set(
        'code_challenge',
        createHash('sha256').update(codeVerifier).digest('base64url'),
      );
      authorizationUrl.searchParams.set('code_challenge_method', 'S256');
      if (grantedScopes.size === 0) {
        authorizationUrl.searchParams.set('prompt', 'consent');
      }
      const result = deepFreeze({
        status: 'authorization-required' as const,
        authorizationUrl: authorizationUrl.toString(),
        expiresAt: expiresAt.toISOString(),
      });
      const stored = await this.#flowStore.storeAuthorizationStart({
        actor: parsed.actor,
        purpose: parsed.purpose,
        idempotencyKey: parsed.idempotencyKey,
        requestFingerprint,
        result,
        flow,
      });
      if (!('result' in stored)) {
        throw new GoogleOAuthAuthorizationStartFailure(stored.status);
      }
      if (stored.status === 'stored') {
        await this.#recordAudit({
          event: 'google-calendar.oauth-authorization-started',
          userId: parsed.actor.userId,
          householdId: parsed.actor.householdId,
          purpose: parsed.purpose,
          outcome: 'started',
        });
      }
      return deepFreeze(stored.result);
    });
  }

  async handleCallback(input: unknown) {
    this.#assertAvailable();
    assertPlainRouteInput(input);
    const parsedInput = GoogleCalendarOAuthCallbackInputSchema.parse(input);
    const stateId = this.#verifyState(parsedInput.state);
    const consumed = await this.#flowStore.consume({
      id: stateId,
      actor: parsedInput.actor,
    });
    if (consumed.status !== 'consumed') {
      if (consumed.status === 'binding-mismatch') {
        throw new GoogleCalendarOAuthError('oauth-state-binding-mismatch');
      }
      if (consumed.status === 'expired') {
        throw new GoogleCalendarOAuthError('oauth-state-expired');
      }
      throw new GoogleCalendarOAuthError('invalid-oauth-state');
    }
    const { flow } = consumed;
    if ('error' in parsedInput) {
      await this.#recordAudit({
        event: 'google-calendar.oauth-failed',
        userId: flow.actor.userId,
        householdId: flow.actor.householdId,
        purpose: flow.purpose,
        outcome: 'denied',
        safeCode: 'authorization-denied',
      });
      throw new GoogleCalendarOAuthError('authorization-denied');
    }

    return this.#grantLease.runExclusive(flow.actor, () =>
      this.#completeAuthorizationCode(flow, parsedInput.code),
    );
  }

  async #completeAuthorizationCode(flow: GoogleOAuthFlowRecord, code: string) {
    await this.#recordAudit({
      event: 'google-calendar.oauth-exchange-started',
      userId: flow.actor.userId,
      householdId: flow.actor.householdId,
      purpose: flow.purpose,
      outcome: 'started',
    });

    const nowAtBoundary = this.#now();
    if (nowAtBoundary.getTime() >= flow.expiresAt.getTime()) {
      await this.#recordFailure(flow, 'oauth-state-expired');
      throw new GoogleCalendarOAuthError('oauth-state-expired');
    }
    const authorizationEpoch = await this.#loadAuthorizationEpoch(flow.actor);
    if (authorizationEpoch !== flow.authorizationEpochAtStart) {
      await this.#recordFailure(flow, 'oauth-grant-invalidated');
      throw new GoogleCalendarOAuthError('oauth-grant-invalidated');
    }
    const current = await this.#credentialVault.load(flow.actor);
    const parsedCurrent =
      current === undefined
        ? undefined
        : VersionedCredentialSchema.parse(current);
    if ((parsedCurrent?.revision ?? null) !== flow.credentialRevisionAtStart) {
      await this.#recordFailure(flow, 'credential-write-conflict');
      throw new GoogleCalendarOAuthError('credential-write-conflict');
    }
    const activeCurrent =
      parsedCurrent?.authorizationEpoch === authorizationEpoch
        ? parsedCurrent
        : undefined;
    if (this.#now().getTime() >= flow.expiresAt.getTime()) {
      await this.#recordFailure(flow, 'oauth-state-expired');
      throw new GoogleCalendarOAuthError('oauth-state-expired');
    }

    let rawTokenResponse: unknown;
    try {
      rawTokenResponse = await this.#transport.exchangeAuthorizationCode({
        code,
        codeVerifier: flow.codeVerifier,
        clientId: this.#configuration.calendarClientId,
        clientSecret: this.#configuration.calendarClientSecret,
        redirectUri: flow.redirectUri,
      });
    } catch {
      await this.#recordFailure(flow, 'provider-unavailable');
      throw new GoogleCalendarOAuthError('provider-unavailable');
    }

    const tokenResponse = TokenResponseSchema.safeParse(rawTokenResponse);
    if (!tokenResponse.success) {
      await this.#recordFailure(flow, 'invalid-provider-response');
      throw new GoogleCalendarOAuthError('invalid-provider-response');
    }
    let providerGrantedScopes: GoogleCalendarScope[];
    try {
      providerGrantedScopes = this.#parseGrantedScopes(
        tokenResponse.data.scope,
      );
    } catch {
      await this.#recordFailure(flow, 'unexpected-provider-scope');
      throw new GoogleCalendarOAuthError('unexpected-provider-scope');
    }
    const appOwnedScopes = this.#orderedScopeUnion(
      activeCurrent?.credential.scopes ?? [],
      flow.requestedScopes,
    );
    for (const requiredScope of appOwnedScopes) {
      if (!providerGrantedScopes.includes(requiredScope)) {
        await this.#recordFailure(flow, 'required-scope-not-granted');
        throw new GoogleCalendarOAuthError('required-scope-not-granted');
      }
    }
    if (
      providerGrantedScopes.some((scope) => !appOwnedScopes.includes(scope))
    ) {
      await this.#recordFailure(flow, 'scope-reconciliation-required');
      throw new GoogleCalendarOAuthError('scope-reconciliation-required');
    }

    const refreshToken =
      tokenResponse.data.refresh_token ??
      activeCurrent?.credential.refreshToken;
    if (refreshToken === undefined) {
      await this.#recordFailure(flow, 'offline-grant-unavailable');
      throw new GoogleCalendarOAuthError('offline-grant-unavailable');
    }
    const now = this.#now();
    const nowIso = now.toISOString();
    const credential = deepFreeze(
      GoogleCalendarCredentialSchema.parse({
        schemaVersion: 1,
        // A grant reference identifies one concrete authorization instance,
        // not merely the EMDO actor. Rotating it for every completed consent
        // flow prevents an approval captured for one Google account/grant from
        // surviving reconnect or account switching under the same actor.
        grantReference: `gcal-${createHash('sha256')
          .update('emdo.google-calendar.grant-instance.v1\0')
          .update(flow.id)
          .digest('hex')
          .slice(0, 40)}`,
        accessToken: tokenResponse.data.access_token,
        refreshToken,
        tokenType: tokenResponse.data.token_type,
        scopes: appOwnedScopes,
        expiresAt: new Date(
          now.getTime() + tokenResponse.data.expires_in * 1_000,
        ).toISOString(),
        connectedAt: activeCurrent?.credential.connectedAt ?? nowIso,
        updatedAt: nowIso,
      }),
    );
    const stored = await this.#credentialVault.compareAndSet({
      actor: flow.actor,
      expectedRevision: flow.credentialRevisionAtStart,
      authorizationEpoch,
      credential,
    });
    if (stored.status === 'conflict') {
      await this.#recordFailure(flow, 'credential-write-conflict');
      throw new GoogleCalendarOAuthError('credential-write-conflict');
    }
    await this.#recordAudit({
      event: 'google-calendar.oauth-connected',
      userId: flow.actor.userId,
      householdId: flow.actor.householdId,
      purpose: flow.purpose,
      outcome: 'success',
    });
    return deepFreeze({
      status: 'connected' as const,
      grantReference: credential.grantReference,
      grantedPurposes: this.#grantedPurposes(credential.scopes),
    });
  }

  async getConnectionStatus(input: unknown) {
    this.#assertAvailable();
    assertPlainRouteInput(input);
    const parsed = GoogleCalendarConnectionActorInputSchema.parse(input);
    const [authorizationEpoch, current] = await Promise.all([
      this.#loadAuthorizationEpoch(parsed.actor),
      this.#credentialVault.load(parsed.actor),
    ]);
    if (current === undefined) {
      return deepFreeze({ status: 'disconnected' as const });
    }
    const validated = VersionedCredentialSchema.parse(current);
    if (validated.authorizationEpoch !== authorizationEpoch) {
      return deepFreeze({ status: 'disconnected' as const });
    }
    return deepFreeze({
      status: 'connected' as const,
      grantedPurposes: this.#grantedPurposes(validated.credential.scopes),
      expiresAt: validated.credential.expiresAt,
    });
  }

  async acquireAccessTokenForCapability(input: unknown) {
    this.#assertAvailable();
    assertPlainRouteInput(input);
    const parsed = GoogleCalendarCapabilityLeaseInputSchema.parse(input);
    return this.#grantLease.runExclusive(parsed.actor, async () => {
      const authorizationEpoch = await this.#loadAuthorizationEpoch(
        parsed.actor,
      );
      const current = await this.#credentialVault.load(parsed.actor);
      if (current === undefined) {
        throw new GoogleCalendarOAuthError('calendar-not-connected');
      }
      const validated = VersionedCredentialSchema.parse(current);
      if (validated.authorizationEpoch !== authorizationEpoch) {
        throw new GoogleCalendarOAuthError('calendar-reconnect-required');
      }
      this.#assertPurposeGranted(
        parsed.capability,
        validated.credential.scopes,
      );
      const now = this.#now();
      if (Date.parse(validated.credential.expiresAt) > now.getTime() + 60_000) {
        return this.#accessTokenLease(
          validated.credential,
          validated.authorizationEpoch,
        );
      }
      await this.#recordAudit({
        event: 'google-calendar.oauth-refresh-started',
        userId: parsed.actor.userId,
        householdId: parsed.actor.householdId,
        purpose: parsed.capability,
        outcome: 'started',
      });

      let rawRefreshResponse: unknown;
      try {
        rawRefreshResponse = await this.#transport.refreshAccessToken({
          refreshToken: validated.credential.refreshToken,
          clientId: this.#configuration.calendarClientId,
          clientSecret: this.#configuration.calendarClientSecret,
        });
      } catch (error) {
        if (
          error instanceof GoogleOAuthTransportFailure &&
          error.reason === 'invalid-grant'
        ) {
          const invalidated = await this.#invalidateGrant({
            actor: parsed.actor,
            authorizationEpoch,
            credentialRevision: validated.revision,
          });
          const safeCode = invalidated
            ? 'calendar-reconnect-required'
            : 'credential-write-conflict';
          await this.#recordBrokerFailure(
            parsed.actor,
            parsed.capability,
            safeCode,
          );
          throw new GoogleCalendarOAuthError(safeCode);
        }
        await this.#recordBrokerFailure(
          parsed.actor,
          parsed.capability,
          'provider-unavailable',
        );
        throw new GoogleCalendarOAuthError('provider-unavailable');
      }

      const refreshResponse =
        RefreshTokenResponseSchema.safeParse(rawRefreshResponse);
      if (!refreshResponse.success) {
        await this.#recordBrokerFailure(
          parsed.actor,
          parsed.capability,
          'invalid-provider-response',
        );
        throw new GoogleCalendarOAuthError('invalid-provider-response');
      }
      let scopes = [...validated.credential.scopes];
      if (refreshResponse.data.scope !== undefined) {
        try {
          scopes = this.#parseGrantedScopes(refreshResponse.data.scope);
        } catch {
          await this.#recordBrokerFailure(
            parsed.actor,
            parsed.capability,
            'unexpected-provider-scope',
          );
          throw new GoogleCalendarOAuthError('unexpected-provider-scope');
        }
        if (
          scopes.some((scope) => !validated.credential.scopes.includes(scope))
        ) {
          await this.#recordBrokerFailure(
            parsed.actor,
            parsed.capability,
            'scope-reconciliation-required',
          );
          throw new GoogleCalendarOAuthError('scope-reconciliation-required');
        }
      }
      try {
        this.#assertPurposeGranted(parsed.capability, scopes);
      } catch {
        await this.#recordBrokerFailure(
          parsed.actor,
          parsed.capability,
          'required-scope-not-granted',
        );
        throw new GoogleCalendarOAuthError('required-scope-not-granted');
      }
      const nowIso = now.toISOString();
      const refreshed = deepFreeze(
        GoogleCalendarCredentialSchema.parse({
          ...validated.credential,
          accessToken: refreshResponse.data.access_token,
          refreshToken:
            refreshResponse.data.refresh_token ??
            validated.credential.refreshToken,
          tokenType: refreshResponse.data.token_type,
          scopes,
          expiresAt: new Date(
            now.getTime() + refreshResponse.data.expires_in * 1_000,
          ).toISOString(),
          updatedAt: nowIso,
        }),
      );
      const stored = await this.#credentialVault.compareAndSet({
        actor: parsed.actor,
        expectedRevision: validated.revision,
        authorizationEpoch,
        credential: refreshed,
      });
      if (stored.status === 'conflict') {
        await this.#recordBrokerFailure(
          parsed.actor,
          parsed.capability,
          'credential-write-conflict',
        );
        throw new GoogleCalendarOAuthError('credential-write-conflict');
      }
      await this.#recordAudit({
        event: 'google-calendar.oauth-refreshed',
        userId: parsed.actor.userId,
        householdId: parsed.actor.householdId,
        purpose: parsed.capability,
        outcome: 'success',
      });
      return this.#accessTokenLease(refreshed, authorizationEpoch);
    });
  }

  async disconnect(input: unknown) {
    this.#assertAvailable();
    assertPlainRouteInput(input);
    const parsed = GoogleCalendarDisconnectInputSchema.parse(input);
    return this.#grantLease.runExclusive(parsed.actor, async () => {
      const requestFingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            domain: 'emdo.google-calendar.oauth-disconnect.v1',
          }),
        )
        .digest('hex');
      const claim = DisconnectClaimResultSchema.parse(
        await this.#disconnectOperationStore.claim({
          actor: parsed.actor,
          idempotencyKey: parsed.idempotencyKey,
          requestFingerprint,
        }),
      );
      if (claim.status === 'conflict') {
        throw new GoogleOAuthDisconnectFailure('conflict');
      }
      if (claim.status === 'replayed') {
        return deepFreeze(claim.result);
      }

      const settle = async (
        operationId: string,
        providerRevocation: 'not-applicable' | 'confirmed' | 'unconfirmed',
      ): Promise<GoogleCalendarDisconnectRouteResult> => {
        const settlement = DisconnectSettlementResultSchema.parse(
          await this.#disconnectOperationStore.settle({
            actor: parsed.actor,
            operationId,
            providerRevocation,
          }),
        );
        if (settlement.status === 'conflict') {
          throw new GoogleCalendarOAuthError('credential-write-conflict');
        }
        if (settlement.status === 'stored') {
          await this.#recordAudit({
            event: 'google-calendar.oauth-disconnected',
            userId: parsed.actor.userId,
            householdId: parsed.actor.householdId,
            outcome:
              settlement.result.providerRevocation === 'unconfirmed'
                ? 'unconfirmed'
                : 'success',
          });
        }
        return deepFreeze(settlement.result);
      };

      if (claim.status === 'dispatching') {
        return settle(claim.operationId, 'unconfirmed');
      }

      await this.#recordAudit({
        event: 'google-calendar.oauth-disconnect-started',
        userId: parsed.actor.userId,
        householdId: parsed.actor.householdId,
        outcome: 'started',
      });
      const current = await this.#credentialVault.load(parsed.actor);
      const validated =
        current === undefined
          ? undefined
          : VersionedCredentialSchema.parse(current);
      if (
        (claim.credentialRevision === null) !== (validated === undefined) ||
        (validated !== undefined &&
          validated.revision !== claim.credentialRevision)
      ) {
        await this.#recordBrokerFailure(
          parsed.actor,
          undefined,
          'credential-write-conflict',
        );
        throw new GoogleCalendarOAuthError('credential-write-conflict');
      }

      if (validated === undefined) {
        return settle(claim.operationId, 'not-applicable');
      }

      const dispatched = DisconnectDispatchResultSchema.parse(
        await this.#disconnectOperationStore.markDispatching({
          actor: parsed.actor,
          operationId: claim.operationId,
        }),
      );
      if (dispatched.status === 'conflict') {
        throw new GoogleCalendarOAuthError('credential-write-conflict');
      }
      if (dispatched.status === 'replayed') {
        return deepFreeze(dispatched.result);
      }

      let providerRevocation: 'confirmed' | 'unconfirmed' = 'confirmed';
      try {
        await this.#transport.revokeToken({
          token: validated.credential.refreshToken,
        });
      } catch {
        providerRevocation = 'unconfirmed';
      }
      return settle(claim.operationId, providerRevocation);
    });
  }

  #assertPurposeGranted(
    purpose: GoogleCalendarAuthorizationPurpose,
    scopes: readonly GoogleCalendarScope[],
  ): void {
    const granted = new Set(scopes);
    if (
      !GOOGLE_CALENDAR_PURPOSE_SCOPES[purpose].every((scope) =>
        granted.has(scope),
      )
    ) {
      throw new GoogleCalendarOAuthError('required-scope-not-granted');
    }
  }

  #accessTokenLease(
    credential: GoogleCalendarCredential,
    authorizationEpoch: number,
  ) {
    return deepFreeze({
      accessToken: credential.accessToken,
      grantReference: credential.grantReference,
      authorizationEpoch,
      expiresAt: credential.expiresAt,
    });
  }

  async #loadAuthorizationEpoch(
    actor: GoogleCalendarOAuthActor,
  ): Promise<number> {
    const authorizationEpoch = await this.#authorizationEpochStore.load(actor);
    if (!Number.isSafeInteger(authorizationEpoch) || authorizationEpoch < 0) {
      throw new Error('Invalid Google Calendar authorization epoch');
    }
    return authorizationEpoch;
  }

  async #invalidateGrant(input: {
    readonly actor: GoogleCalendarOAuthActor;
    readonly authorizationEpoch: number;
    readonly credentialRevision: number;
  }): Promise<boolean> {
    const advanced = await this.#authorizationEpochStore.advance({
      actor: input.actor,
      expectedEpoch: input.authorizationEpoch,
    });
    if (
      advanced.status !== 'advanced' ||
      advanced.authorizationEpoch !== input.authorizationEpoch + 1
    ) {
      return false;
    }
    try {
      await this.#flowStore.invalidateActor(input.actor);
    } catch {
      // The durable epoch is authoritative, so retained flow rows are unusable.
    }
    return this.#credentialVault.delete({
      actor: input.actor,
      expectedRevision: input.credentialRevision,
    });
  }

  #orderedScopeUnion(
    left: readonly GoogleCalendarScope[],
    right: readonly GoogleCalendarScope[],
  ): GoogleCalendarScope[] {
    const included = new Set<GoogleCalendarScope>([...left, ...right]);
    return Object.values(GOOGLE_CALENDAR_SCOPES).filter((scope) =>
      included.has(scope),
    );
  }

  async #recordBrokerFailure(
    actor: GoogleCalendarOAuthActor,
    purpose: GoogleCalendarAuthorizationPurpose | undefined,
    safeCode: GoogleCalendarOAuthErrorCode,
  ): Promise<void> {
    await this.#recordAudit({
      event: 'google-calendar.oauth-failed',
      userId: actor.userId,
      householdId: actor.householdId,
      ...(purpose === undefined ? {} : { purpose }),
      outcome: 'failed',
      safeCode,
    });
  }

  #verifyState(state: string): string {
    const match = /^v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(state);
    if (match === null) {
      throw new GoogleCalendarOAuthError('invalid-oauth-state');
    }
    const stateId = match[1]!;
    const encodedSignature = match[2]!;
    const supplied = Buffer.from(encodedSignature, 'base64url');
    if (supplied.toString('base64url') !== encodedSignature) {
      throw new GoogleCalendarOAuthError('invalid-oauth-state');
    }
    const expected = createHmac('sha256', this.#stateSigningKey)
      .update('emdo.google-calendar.oauth-state.v1\0')
      .update(stateId)
      .digest();
    if (
      supplied.byteLength !== expected.byteLength ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new GoogleCalendarOAuthError('invalid-oauth-state');
    }
    return stateId;
  }

  #parseGrantedScopes(scopeText: string): GoogleCalendarScope[] {
    const values = scopeText.split(/\s+/u).filter((value) => value.length > 0);
    const unique = new Set<string>();
    for (const value of values) {
      if (!CalendarScopeSchema.safeParse(value).success) {
        throw new GoogleCalendarOAuthError('unexpected-provider-scope');
      }
      unique.add(value);
    }
    return Object.values(GOOGLE_CALENDAR_SCOPES).filter((scope) =>
      unique.has(scope),
    );
  }

  #grantedPurposes(
    scopes: readonly GoogleCalendarScope[],
  ): GoogleCalendarAuthorizationPurpose[] {
    const granted = new Set(scopes);
    return (['calendar-read', 'calendar-event-write'] as const).filter(
      (purpose) =>
        GOOGLE_CALENDAR_PURPOSE_SCOPES[purpose].every((scope) =>
          granted.has(scope),
        ),
    );
  }

  async #recordFailure(
    flow: GoogleOAuthFlowRecord,
    safeCode: GoogleCalendarOAuthErrorCode,
  ): Promise<void> {
    await this.#recordAudit({
      event: 'google-calendar.oauth-failed',
      userId: flow.actor.userId,
      householdId: flow.actor.householdId,
      purpose: flow.purpose,
      outcome: 'failed',
      safeCode,
    });
  }

  async #recordAudit(event: GoogleOAuthAuditEvent): Promise<void> {
    await this.#audit.record(deepFreeze({ ...event }));
  }

  #now(): Date {
    const now = this.#clock();
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid OAuth clock');
    return now;
  }

  dispose(): void {
    if (!this.#available) return;
    this.#available = false;
    this.#stateSigningKey.fill(0);
  }

  #assertAvailable(): void {
    if (!this.#available) {
      throw new GoogleCalendarOAuthError('connector-unavailable');
    }
  }

  #randomBase64Url(length: number, name: string): string {
    const bytes = this.#entropy(length);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
      throw new Error(`${name} entropy has an invalid length`);
    }
    return Buffer.from(bytes).toString('base64url');
  }
}

export type GoogleCalendarAuthorizationRouteResult = Readonly<
  | {
      status: 'already-authorized';
      grantedPurposes: readonly GoogleCalendarAuthorizationPurpose[];
    }
  | {
      status: 'authorization-required';
      authorizationUrl: string;
      expiresAt: string;
    }
>;

export type GoogleCalendarCallbackRouteResult = Readonly<{
  status: 'connected';
  grantReference: string;
  grantedPurposes: readonly GoogleCalendarAuthorizationPurpose[];
}>;

export type GoogleCalendarConnectionStatusRouteResult = Readonly<
  | { status: 'disconnected' }
  | {
      status: 'connected';
      grantedPurposes: readonly GoogleCalendarAuthorizationPurpose[];
      expiresAt: string;
    }
>;

export type GoogleCalendarDisconnectRouteResult = Readonly<{
  status: 'disconnected';
  providerRevocation: 'not-applicable' | 'confirmed' | 'unconfirmed';
}>;

/** Minimal API/BFF port. Capability token brokerage is intentionally absent. */
export interface GoogleCalendarOAuthRouteService {
  beginAuthorization(
    input: unknown,
  ): Promise<GoogleCalendarAuthorizationRouteResult>;
  handleCallback(input: unknown): Promise<GoogleCalendarCallbackRouteResult>;
  getConnectionStatus(
    input: unknown,
  ): Promise<GoogleCalendarConnectionStatusRouteResult>;
  disconnect(input: unknown): Promise<GoogleCalendarDisconnectRouteResult>;
}

/** API/BFF-safe view. The raw access-token broker is intentionally omitted. */
export const createGoogleCalendarOAuthRouteService = (
  service: GoogleCalendarOAuthRouteService,
): GoogleCalendarOAuthRouteService =>
  Object.freeze({
    beginAuthorization: (input: unknown) => service.beginAuthorization(input),
    handleCallback: (input: unknown) => service.handleCallback(input),
    getConnectionStatus: (input: unknown) => service.getConnectionStatus(input),
    disconnect: (input: unknown) => service.disconnect(input),
  });

/** Fail-closed API surface for deployments without Calendar credentials. */
export const createUnavailableGoogleCalendarOAuthRouteService =
  (): GoogleCalendarOAuthRouteService => {
    const unavailable = async (): Promise<never> => {
      throw new GoogleCalendarOAuthError('connector-unavailable');
    };
    return Object.freeze({
      beginAuthorization: unavailable,
      handleCallback: unavailable,
      getConnectionStatus: unavailable,
      disconnect: unavailable,
    });
  };

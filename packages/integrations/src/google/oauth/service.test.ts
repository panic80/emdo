import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  GOOGLE_CALENDAR_SCOPES,
  GoogleCalendarCredentialSchema,
  GoogleCalendarOAuthError,
  GoogleCalendarOAuthService,
  GoogleOAuthTransportFailure,
  createGoogleCalendarOAuthRouteService,
  createUnavailableGoogleCalendarOAuthRouteService,
  type GoogleCalendarAuthorizationRouteResult,
  type GoogleCalendarCredential,
  type GoogleCalendarCredentialVault,
  type GoogleCalendarOAuthActor,
  type GoogleOAuthAuthorizationEpochStore,
  type GoogleOAuthDisconnectOperationStore,
  type GoogleOAuthGrantLease,
  type GoogleOAuthAuditSink,
  type GoogleOAuthAuditEvent,
  type GoogleOAuthFlowStore,
  type GoogleOAuthTransport,
} from './service.js';
import { InMemoryGoogleOAuthFlowStore } from './state.js';

const actor = Object.freeze({
  userId: 'user-1',
  householdId: 'household-1',
  privateSpaceId: 'space-private-user-1',
  sessionId: 'session-1',
});

const redirectUri = 'https://emdo.example/api/v1/connectors/google/callback';

describe('GoogleCalendarCredentialSchema', () => {
  it('rejects provider grant references containing control characters', () => {
    expect(
      GoogleCalendarCredentialSchema.safeParse({
        schemaVersion: 1,
        grantReference: 'gcal-grant-reference\u0000poison',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        tokenType: 'Bearer',
        scopes: [GOOGLE_CALENDAR_SCOPES.events],
        expiresAt: '2026-08-09T17:00:00.000Z',
        connectedAt: '2026-08-09T16:00:00.000Z',
        updatedAt: '2026-08-09T16:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

class CapturingFlowStore implements GoogleOAuthFlowStore {
  readonly records = new Map<
    string,
    NonNullable<
      Parameters<GoogleOAuthFlowStore['storeAuthorizationStart']>[0]['flow']
    >
  >();
  readonly starts = new Map<
    string,
    Readonly<{
      requestFingerprint: string;
      result: GoogleCalendarAuthorizationRouteResult;
    }>
  >();
  async storeAuthorizationStart(
    input: Parameters<GoogleOAuthFlowStore['storeAuthorizationStart']>[0],
  ) {
    const key = [
      input.actor.userId,
      input.actor.householdId,
      input.actor.privateSpaceId,
      input.actor.sessionId,
      input.idempotencyKey,
    ].join(':');
    const existing = this.starts.get(key);
    if (existing !== undefined) {
      if (existing.requestFingerprint !== input.requestFingerprint) {
        return { status: 'conflict' as const };
      }
      return { status: 'replayed' as const, result: existing.result };
    }
    if (input.flow !== undefined) {
      if (this.records.has(input.flow.id)) {
        return { status: 'conflict' as const };
      }
      this.records.set(input.flow.id, input.flow);
    }
    this.starts.set(key, {
      requestFingerprint: input.requestFingerprint,
      result: input.result,
    });
    return { status: 'stored' as const, result: input.result };
  }

  async consume() {
    return { status: 'missing' as const };
  }

  async invalidateActor(inputActor: typeof actor) {
    let invalidated = 0;
    for (const [id, record] of this.records) {
      if (
        record.actor.userId === inputActor.userId &&
        record.actor.householdId === inputActor.householdId &&
        record.actor.privateSpaceId === inputActor.privateSpaceId
      ) {
        this.records.delete(id);
        invalidated += 1;
      }
    }
    return invalidated;
  }
}

class MemoryAuthorizationEpochStore implements GoogleOAuthAuthorizationEpochStore {
  epoch = 0;

  async load() {
    return this.epoch;
  }

  async advance(input: { readonly expectedEpoch: number }) {
    if (input.expectedEpoch !== this.epoch) {
      return { status: 'conflict' as const };
    }
    this.epoch += 1;
    return { status: 'advanced' as const, authorizationEpoch: this.epoch };
  }
}

const unusedVault: GoogleCalendarCredentialVault = {
  async load() {
    return undefined;
  },
  async compareAndSet() {
    throw new Error('not used');
  },
  async delete() {
    throw new Error('not used');
  },
};

const unusedTransport: GoogleOAuthTransport = {
  async exchangeAuthorizationCode() {
    throw new Error('not used');
  },
  async refreshAccessToken() {
    throw new Error('not used');
  },
  async revokeToken() {
    throw new Error('not used');
  },
};

const unusedDisconnectOperationStore: GoogleOAuthDisconnectOperationStore = {
  async claim() {
    throw new Error('not used');
  },
  async markDispatching() {
    throw new Error('not used');
  },
  async settle() {
    throw new Error('not used');
  },
};

const noAudit: GoogleOAuthAuditSink = {
  async record() {},
};

const directLease: GoogleOAuthGrantLease = {
  async runExclusive(_actor, operation) {
    return operation();
  },
};

const credentialWithScopes = (
  scopes: GoogleCalendarCredential['scopes'],
): GoogleCalendarCredential => ({
  schemaVersion: 1,
  grantReference: 'gcal-existing-grant-reference',
  accessToken: 'existing-access-token-sensitive',
  refreshToken: 'existing-refresh-token-sensitive',
  tokenType: 'Bearer',
  scopes,
  expiresAt: '2026-08-09T17:00:00.000Z',
  connectedAt: '2026-08-08T16:00:00.000Z',
  updatedAt: '2026-08-09T15:00:00.000Z',
});

class MemoryCredentialVault implements GoogleCalendarCredentialVault {
  stored:
    | {
        readonly revision: number;
        readonly authorizationEpoch: number;
        readonly credential: GoogleCalendarCredential;
      }
    | undefined;

  async load() {
    return this.stored;
  }

  async compareAndSet(input: {
    readonly expectedRevision: number | null;
    readonly authorizationEpoch: number;
    readonly credential: GoogleCalendarCredential;
  }) {
    const currentRevision = this.stored?.revision ?? null;
    if (currentRevision !== input.expectedRevision) {
      return { status: 'conflict' as const };
    }
    const revision = (currentRevision ?? 0) + 1;
    this.stored = {
      revision,
      authorizationEpoch: input.authorizationEpoch,
      credential: input.credential,
    };
    return { status: 'stored' as const, revision };
  }

  async delete(input: { readonly expectedRevision: number }) {
    const existed = this.stored?.revision === input.expectedRevision;
    if (!existed) return false;
    this.stored = undefined;
    return true;
  }
}

type MemoryDisconnectOperation = {
  readonly operationId: string;
  readonly requestFingerprint: string;
  readonly credentialRevision: number | null;
  readonly authorizationEpoch: number;
  state: 'claimed' | 'dispatching' | 'completed';
  result?: {
    readonly status: 'disconnected';
    readonly providerRevocation: 'not-applicable' | 'confirmed' | 'unconfirmed';
  };
};

class MemoryDisconnectOperationStore implements GoogleOAuthDisconnectOperationStore {
  readonly #operations = new Map<string, MemoryDisconnectOperation>();
  #sequence = 0;

  constructor(
    private readonly credentialVault: MemoryCredentialVault,
    private readonly authorizationEpochStore: MemoryAuthorizationEpochStore,
    private readonly invalidateFlows:
      (() => Promise<unknown>) | undefined = undefined,
  ) {}

  async claim(
    input: Parameters<GoogleOAuthDisconnectOperationStore['claim']>[0],
  ) {
    const key = this.#key(input.actor, input.idempotencyKey);
    const existing = this.#operations.get(key);
    if (existing !== undefined) {
      if (existing.requestFingerprint !== input.requestFingerprint) {
        return { status: 'conflict' as const };
      }
      if (existing.state === 'completed') {
        return {
          status: 'replayed' as const,
          result: existing.result!,
        };
      }
      if (existing.state === 'dispatching') {
        return {
          status: 'dispatching' as const,
          operationId: existing.operationId,
        };
      }
      return {
        status: 'claimed' as const,
        operationId: existing.operationId,
        credentialRevision: existing.credentialRevision,
        authorizationEpoch: existing.authorizationEpoch,
      };
    }
    const active = this.#findActiveCredential(input.actor);
    if (active !== undefined) {
      this.#operations.set(key, active);
      return active.state === 'dispatching'
        ? {
            status: 'dispatching' as const,
            operationId: active.operationId,
          }
        : {
            status: 'claimed' as const,
            operationId: active.operationId,
            credentialRevision: active.credentialRevision,
            authorizationEpoch: active.authorizationEpoch,
          };
    }
    this.#sequence += 1;
    const operation: MemoryDisconnectOperation = {
      operationId: `google-disconnect-operation-${this.#sequence}`,
      requestFingerprint: input.requestFingerprint,
      credentialRevision: this.credentialVault.stored?.revision ?? null,
      authorizationEpoch: this.authorizationEpochStore.epoch,
      state: 'claimed',
    };
    this.#operations.set(key, operation);
    return {
      status: 'claimed' as const,
      operationId: operation.operationId,
      credentialRevision: operation.credentialRevision,
      authorizationEpoch: operation.authorizationEpoch,
    };
  }

  async markDispatching(
    input: Parameters<
      GoogleOAuthDisconnectOperationStore['markDispatching']
    >[0],
  ) {
    const operation = this.#find(input.actor, input.operationId);
    if (operation === undefined) return { status: 'conflict' as const };
    if (operation.state === 'completed') {
      return { status: 'replayed' as const, result: operation.result! };
    }
    if (operation.credentialRevision === null) {
      return { status: 'conflict' as const };
    }
    if (
      this.credentialVault.stored?.revision !== operation.credentialRevision ||
      this.authorizationEpochStore.epoch !== operation.authorizationEpoch
    ) {
      return { status: 'conflict' as const };
    }
    operation.state = 'dispatching';
    this.authorizationEpochStore.epoch += 1;
    this.credentialVault.stored = undefined;
    await this.invalidateFlows?.();
    return { status: 'dispatching' as const };
  }

  async settle(
    input: Parameters<GoogleOAuthDisconnectOperationStore['settle']>[0],
  ) {
    const operation = this.#find(input.actor, input.operationId);
    if (operation === undefined) return { status: 'conflict' as const };
    if (operation.state === 'completed') {
      return { status: 'replayed' as const, result: operation.result! };
    }
    const noCredentialSettlement =
      operation.credentialRevision === null &&
      this.credentialVault.stored === undefined &&
      operation.state === 'claimed' &&
      input.providerRevocation === 'not-applicable' &&
      this.authorizationEpochStore.epoch === operation.authorizationEpoch;
    const dispatchedSettlement =
      operation.credentialRevision !== null &&
      this.credentialVault.stored === undefined &&
      operation.state === 'dispatching' &&
      input.providerRevocation !== 'not-applicable' &&
      this.authorizationEpochStore.epoch === operation.authorizationEpoch + 1;
    if (!noCredentialSettlement && !dispatchedSettlement) {
      return { status: 'conflict' as const };
    }
    if (noCredentialSettlement) {
      this.authorizationEpochStore.epoch += 1;
      await this.invalidateFlows?.();
    }
    operation.state = 'completed';
    operation.result = {
      status: 'disconnected',
      providerRevocation: input.providerRevocation,
    };
    return { status: 'stored' as const, result: operation.result };
  }

  async seedDispatching(input: {
    readonly actor: GoogleCalendarOAuthActor;
    readonly idempotencyKey: string;
  }): Promise<void> {
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          domain: 'emdo.google-calendar.oauth-disconnect.v1',
        }),
      )
      .digest('hex');
    const claimed = await this.claim({ ...input, requestFingerprint });
    if (claimed.status !== 'claimed') throw new Error('claim unavailable');
    const dispatched = await this.markDispatching({
      actor: input.actor,
      operationId: claimed.operationId,
    });
    if (dispatched.status !== 'dispatching') {
      throw new Error('dispatch unavailable');
    }
  }

  #key(inputActor: GoogleCalendarOAuthActor, idempotencyKey: string): string {
    return [
      inputActor.userId,
      inputActor.householdId,
      inputActor.privateSpaceId,
      inputActor.sessionId,
      idempotencyKey,
    ].join(':');
  }

  #find(inputActor: GoogleCalendarOAuthActor, operationId: string) {
    for (const [key, operation] of this.#operations) {
      if (
        operation.operationId === operationId &&
        key.startsWith(
          [
            inputActor.userId,
            inputActor.householdId,
            inputActor.privateSpaceId,
          ].join(':') + ':',
        )
      ) {
        return operation;
      }
    }
    return undefined;
  }

  #findActiveCredential(inputActor: GoogleCalendarOAuthActor) {
    const stablePrefix = [
      inputActor.userId,
      inputActor.householdId,
      inputActor.privateSpaceId,
    ].join(':');
    for (const [key, operation] of this.#operations) {
      if (
        key.startsWith(`${stablePrefix}:`) &&
        operation.state !== 'completed'
      ) {
        return operation;
      }
    }
    return undefined;
  }
}

class CapturingAudit implements GoogleOAuthAuditSink {
  readonly events: GoogleOAuthAuditEvent[] = [];
  onRecord?: (event: GoogleOAuthAuditEvent) => void;

  async record(event: GoogleOAuthAuditEvent) {
    this.events.push(event);
    this.onRecord?.(event);
  }
}

class CapturingTransport implements GoogleOAuthTransport {
  readonly exchangeCalls: unknown[] = [];
  readonly refreshCalls: unknown[] = [];
  readonly revokeCalls: unknown[] = [];
  refreshFailure: unknown;
  revokeFailure: unknown;
  exchangeResult: unknown = {
    access_token: 'access-token-sensitive',
    refresh_token: 'refresh-token-sensitive',
    expires_in: 3_600,
    token_type: 'Bearer',
    scope: [
      GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
      GOOGLE_CALENDAR_SCOPES.eventsReadonly,
      GOOGLE_CALENDAR_SCOPES.freeBusy,
    ].join(' '),
  };
  refreshResult: unknown = {
    access_token: 'refreshed-access-token-sensitive',
    refresh_token: 'rotated-refresh-token-sensitive',
    expires_in: 3_600,
    token_type: 'Bearer',
  };

  async exchangeAuthorizationCode(input: unknown) {
    this.exchangeCalls.push(input);
    return this.exchangeResult;
  }

  async refreshAccessToken(input: unknown) {
    this.refreshCalls.push(input);
    if (this.refreshFailure !== undefined) throw this.refreshFailure;
    return this.refreshResult;
  }

  async revokeToken(input: unknown) {
    this.revokeCalls.push(input);
    if (this.revokeFailure !== undefined) throw this.revokeFailure;
    return { status: 'revoked' };
  }
}

const createService = (options?: {
  flowStore?: CapturingFlowStore;
  credentialVault?: GoogleCalendarCredentialVault;
  authorizationEpochStore?: GoogleOAuthAuthorizationEpochStore;
  configuration?: Partial<
    ConstructorParameters<typeof GoogleCalendarOAuthService>[0]['configuration']
  >;
}) => {
  const flowStore = options?.flowStore ?? new CapturingFlowStore();
  return {
    flowStore,
    service: new GoogleCalendarOAuthService({
      configuration: {
        calendarClientId: 'calendar-client.apps.googleusercontent.com',
        calendarClientSecret: 'calendar-client-secret-value',
        identityClientId: 'identity-client.apps.googleusercontent.com',
        redirectUri,
        stateSigningKey: Buffer.alloc(32, 7),
        ...options?.configuration,
      },
      flowStore,
      credentialVault: options?.credentialVault ?? unusedVault,
      authorizationEpochStore:
        options?.authorizationEpochStore ?? new MemoryAuthorizationEpochStore(),
      disconnectOperationStore: unusedDisconnectOperationStore,
      transport: unusedTransport,
      audit: noAudit,
      grantLease: directLease,
      clock: () => new Date('2026-08-09T16:00:00.000Z'),
      entropy: (length) => Buffer.alloc(length, 9),
    }),
  };
};

describe('GoogleCalendarOAuthService authorization start', () => {
  it('replays the exact authorization start for one idempotency key', async () => {
    const { service, flowStore } = createService();
    const input = {
      actor,
      purpose: 'calendar-read' as const,
      idempotencyKey: 'google-oauth-start-replay-0001',
    };

    const first = await service.beginAuthorization(input);
    const replay = await service.beginAuthorization(input);

    expect(replay).toEqual(first);
    expect(flowStore.records.size).toBe(1);
  });

  it('uses the distinct Calendar client, exact redirect, opaque signed state, and PKCE', async () => {
    const { service, flowStore } = createService();

    const result = await service.beginAuthorization({
      actor,
      purpose: 'calendar-read',
      idempotencyKey: 'google-oauth-start-read-0001',
    });

    expect(result.status).toBe('authorization-required');
    if (result.status !== 'authorization-required')
      throw new Error('expected URL');
    const authorizationUrl = new URL(result.authorizationUrl);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(authorizationUrl.searchParams.get('client_id')).toBe(
      'calendar-client.apps.googleusercontent.com',
    );
    expect(authorizationUrl.searchParams.get('client_id')).not.toBe(
      'identity-client.apps.googleusercontent.com',
    );
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizationUrl.searchParams.get('access_type')).toBe('offline');
    expect(authorizationUrl.searchParams.get('include_granted_scopes')).toBe(
      'true',
    );
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe(
      'S256',
    );

    const state = authorizationUrl.searchParams.get('state');
    expect(state).toMatch(/^v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    expect(state).not.toContain(actor.userId);
    expect(state).not.toContain(actor.sessionId);

    const flow = [...flowStore.records.values()][0];
    expect(flow).toBeDefined();
    expect(flow?.actor).toEqual(actor);
    expect(flow?.redirectUri).toBe(redirectUri);
    expect(flow?.requestedScopes).toEqual([
      GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
      GOOGLE_CALENDAR_SCOPES.eventsReadonly,
      GOOGLE_CALENDAR_SCOPES.freeBusy,
    ]);
    expect(flow?.authorizationEpochAtStart).toBe(0);
    expect(authorizationUrl.searchParams.get('scope')?.split(' ')).toEqual(
      flow?.requestedScopes,
    );
    expect(authorizationUrl.searchParams.get('scope')).not.toMatch(
      /openid|userinfo|profile|email/,
    );
    expect(authorizationUrl.searchParams.get('code_challenge')).toBe(
      createHash('sha256')
        .update(flow?.codeVerifier ?? '')
        .digest('base64url'),
    );
    expect(result.expiresAt).toBe('2026-08-09T16:10:00.000Z');
    expect(authorizationUrl.searchParams.get('prompt')).toBe('consent');
  });

  it('rejects identity-client reuse, weak state keys, and non-exact HTTPS redirects', () => {
    expect(() =>
      createService({
        configuration: {
          identityClientId: 'calendar-client.apps.googleusercontent.com',
        },
      }),
    ).toThrow(/distinct/);
    expect(() =>
      createService({ configuration: { stateSigningKey: Buffer.alloc(31) } }),
    ).toThrow(/32 bytes/);
    expect(() =>
      createService({
        configuration: {
          redirectUri: 'http://emdo.example/api/v1/connectors/google/callback',
        },
      }),
    ).toThrow(/exact HTTPS/);
    expect(() =>
      createService({
        configuration: {
          redirectUri: `${redirectUri}?next=https://attacker.example`,
        },
      }),
    ).toThrow(/exact HTTPS/);
  });

  it('requests only missing server-mapped scopes and short-circuits complete grants', async () => {
    const existingReadGrant = {
      revision: 4,
      authorizationEpoch: 0,
      credential: credentialWithScopes([
        GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
        GOOGLE_CALENDAR_SCOPES.eventsReadonly,
        GOOGLE_CALENDAR_SCOPES.freeBusy,
      ]),
    };
    const credentialVault: GoogleCalendarCredentialVault = {
      ...unusedVault,
      async load() {
        return existingReadGrant;
      },
    };
    const { service, flowStore } = createService({ credentialVault });

    const writeResult = await service.beginAuthorization({
      actor,
      purpose: 'calendar-event-write',
      idempotencyKey: 'google-oauth-start-write-0001',
    });

    expect(writeResult.status).toBe('authorization-required');
    if (writeResult.status !== 'authorization-required') {
      throw new Error('expected incremental authorization URL');
    }
    const authorizationUrl = new URL(writeResult.authorizationUrl);
    expect(authorizationUrl.searchParams.get('scope')).toBe(
      GOOGLE_CALENDAR_SCOPES.events,
    );
    expect(authorizationUrl.searchParams.has('prompt')).toBe(false);
    expect([...flowStore.records.values()][0]?.requestedScopes).toEqual([
      GOOGLE_CALENDAR_SCOPES.events,
    ]);

    const completeVault: GoogleCalendarCredentialVault = {
      ...unusedVault,
      async load() {
        return {
          revision: 5,
          authorizationEpoch: 0,
          credential: credentialWithScopes([
            GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
            GOOGLE_CALENDAR_SCOPES.events,
          ]),
        };
      },
    };
    const complete = createService({ credentialVault: completeVault });
    await expect(
      complete.service.beginAuthorization({
        actor,
        purpose: 'calendar-event-write',
        idempotencyKey: 'google-oauth-start-complete-0001',
      }),
    ).resolves.toEqual({
      status: 'already-authorized',
      grantedPurposes: ['calendar-event-write'],
    });
  });

  it('rejects arbitrary scope authority and accessor-backed route input without invoking it', async () => {
    const { service } = createService();
    await expect(
      service.beginAuthorization({
        actor,
        purpose: 'calendar-read',
        idempotencyKey: 'google-oauth-start-hostile-0001',
        scopes: ['https://www.googleapis.com/auth/calendar'],
      }),
    ).rejects.toThrow();
    let getterCalls = 0;
    const hostile = Object.defineProperties(
      { actor, purpose: 'calendar-read' },
      {
        purpose: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return 'calendar-read';
          },
        },
      },
    );
    await expect(service.beginAuthorization(hostile)).rejects.toThrow(
      /plain data/,
    );
    expect(getterCalls).toBe(0);
  });

  it('exposes an API route facade without the internal access-token broker', () => {
    const { service } = createService();
    const routes = createGoogleCalendarOAuthRouteService(service);
    expect(Object.keys(routes).sort()).toEqual([
      'beginAuthorization',
      'disconnect',
      'getConnectionStatus',
      'handleCallback',
    ]);
    expect('acquireAccessTokenForCapability' in routes).toBe(false);
    expect(Object.isFrozen(routes)).toBe(true);
  });

  it('provides a stable fail-closed route facade when Calendar is not configured', async () => {
    const routes = createUnavailableGoogleCalendarOAuthRouteService();
    expect(Object.keys(routes).sort()).toEqual([
      'beginAuthorization',
      'disconnect',
      'getConnectionStatus',
      'handleCallback',
    ]);
    await expect(
      routes.beginAuthorization({
        actor,
        purpose: 'calendar-read',
        idempotencyKey: 'google-oauth-start-unavailable-0001',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'connector-unavailable',
        message: 'Google Calendar is not configured.',
      }),
    );
    expect('acquireAccessTokenForCapability' in routes).toBe(false);
    expect(Object.isFrozen(routes)).toBe(true);
  });
});

describe('GoogleCalendarOAuthService callback', () => {
  const createCallbackFixture = () => {
    let now = new Date('2026-08-09T16:00:00.000Z');
    const clock = () => new Date(now);
    const flowStore = new InMemoryGoogleOAuthFlowStore(clock);
    const credentialVault = new MemoryCredentialVault();
    const authorizationEpochStore = new MemoryAuthorizationEpochStore();
    const transport = new CapturingTransport();
    const audit = new CapturingAudit();
    const disconnectOperationStore = new MemoryDisconnectOperationStore(
      credentialVault,
      authorizationEpochStore,
      () => flowStore.invalidateActor(actor),
    );
    const service = new GoogleCalendarOAuthService({
      configuration: {
        calendarClientId: 'calendar-client.apps.googleusercontent.com',
        calendarClientSecret: 'calendar-client-secret-value',
        identityClientId: 'identity-client.apps.googleusercontent.com',
        redirectUri,
        stateSigningKey: Buffer.alloc(32, 7),
      },
      flowStore,
      credentialVault,
      authorizationEpochStore,
      disconnectOperationStore,
      transport,
      audit,
      grantLease: directLease,
      clock,
      entropy: (length) => Buffer.alloc(length, 11),
    });
    return {
      service,
      credentialVault,
      authorizationEpochStore,
      flowStore,
      transport,
      audit,
      setNow(value: string) {
        now = new Date(value);
      },
    };
  };

  const beginAndGetState = async (
    service: GoogleCalendarOAuthService,
    callbackActor = actor,
  ) => {
    const started = await service.beginAuthorization({
      actor: callbackActor,
      purpose: 'calendar-read',
      idempotencyKey: `google-oauth-callback-${callbackActor.sessionId}`,
    });
    if (started.status !== 'authorization-required') {
      throw new Error('expected authorization URL');
    }
    return new URL(started.authorizationUrl).searchParams.get('state')!;
  };

  it('exchanges the code with the stored PKCE verifier and persists only an encrypted-vault credential boundary', async () => {
    const fixture = createCallbackFixture();
    const state = await beginAndGetState(fixture.service);

    const result = await fixture.service.handleCallback({
      actor,
      state,
      code: 'provider-authorization-code',
    });

    expect(result).toMatchObject({
      status: 'connected',
      grantedPurposes: ['calendar-read'],
    });
    expect(JSON.stringify(result)).not.toMatch(/access-token|refresh-token/);
    expect(fixture.transport.exchangeCalls).toHaveLength(1);
    expect(fixture.transport.exchangeCalls[0]).toMatchObject({
      code: 'provider-authorization-code',
      clientId: 'calendar-client.apps.googleusercontent.com',
      clientSecret: 'calendar-client-secret-value',
      redirectUri,
      codeVerifier: Buffer.alloc(32, 11).toString('base64url'),
    });
    expect(fixture.credentialVault.stored).toMatchObject({
      revision: 1,
      credential: {
        schemaVersion: 1,
        accessToken: 'access-token-sensitive',
        refreshToken: 'refresh-token-sensitive',
        tokenType: 'Bearer',
        expiresAt: '2026-08-09T17:00:00.000Z',
        scopes: [
          GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
          GOOGLE_CALENDAR_SCOPES.eventsReadonly,
          GOOGLE_CALENDAR_SCOPES.freeBusy,
        ],
      },
    });
    const serializedAudit = JSON.stringify(fixture.audit.events);
    expect(serializedAudit).not.toMatch(
      /provider-authorization-code|access-token-sensitive|refresh-token-sensitive|calendar-client-secret-value/,
    );
    expect(fixture.audit.events).toContainEqual(
      expect.objectContaining({
        event: 'google-calendar.oauth-connected',
        outcome: 'success',
      }),
    );
    expect(fixture.audit.events.map(({ event }) => event)).toEqual([
      'google-calendar.oauth-authorization-started',
      'google-calendar.oauth-exchange-started',
      'google-calendar.oauth-connected',
    ]);
  });

  it('rejects tampered, expired, replayed, and cross-session state before transport', async () => {
    const fixture = createCallbackFixture();
    const state = await beginAndGetState(fixture.service);
    const tampered = `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`;

    await expect(
      fixture.service.handleCallback({
        actor,
        state: tampered,
        code: 'must-not-exchange',
      }),
    ).rejects.toMatchObject({ code: 'invalid-oauth-state' });
    await expect(
      fixture.service.handleCallback({
        actor: { ...actor, sessionId: 'session-2' },
        state,
        code: 'must-not-exchange',
      }),
    ).rejects.toMatchObject({ code: 'oauth-state-binding-mismatch' });

    fixture.setNow('2026-08-09T16:10:00.000Z');
    await expect(
      fixture.service.handleCallback({
        actor,
        state,
        code: 'must-not-exchange',
      }),
    ).rejects.toMatchObject({ code: 'oauth-state-expired' });
    await expect(
      fixture.service.handleCallback({
        actor,
        state,
        code: 'must-not-exchange',
      }),
    ).rejects.toMatchObject({ code: 'invalid-oauth-state' });
    expect(fixture.transport.exchangeCalls).toHaveLength(0);
  });

  it('rechecks expiry and the durable authorization epoch under the grant lease immediately before exchange', async () => {
    const expired = createCallbackFixture();
    const expiredState = await beginAndGetState(expired.service);
    expired.setNow('2026-08-09T16:09:59.999Z');
    expired.audit.onRecord = (event) => {
      if (event.event === 'google-calendar.oauth-exchange-started') {
        expired.setNow('2026-08-09T16:10:00.000Z');
      }
    };
    await expect(
      expired.service.handleCallback({
        actor,
        state: expiredState,
        code: 'must-not-exchange',
      }),
    ).rejects.toMatchObject({ code: 'oauth-state-expired' });
    expect(expired.transport.exchangeCalls).toHaveLength(0);

    const invalidated = createCallbackFixture();
    const invalidatedState = await beginAndGetState(invalidated.service);
    invalidated.audit.onRecord = (event) => {
      if (event.event === 'google-calendar.oauth-exchange-started') {
        invalidated.authorizationEpochStore.epoch += 1;
      }
    };
    await expect(
      invalidated.service.handleCallback({
        actor,
        state: invalidatedState,
        code: 'must-not-exchange',
      }),
    ).rejects.toMatchObject({ code: 'oauth-grant-invalidated' });
    expect(invalidated.transport.exchangeCalls).toHaveLength(0);
  });

  it('rejects non-canonical base64url aliases of an otherwise valid state signature', async () => {
    const fixture = createCallbackFixture();
    const state = await beginAndGetState(fixture.service);
    const [version, stateId, signature] = state.split('.');
    const signatureBytes = Buffer.from(signature!, 'base64url');
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const aliasLastCharacter = [...alphabet].find(
      (candidate) =>
        candidate !== signature!.at(-1) &&
        Buffer.from(
          `${signature!.slice(0, -1)}${candidate}`,
          'base64url',
        ).equals(signatureBytes),
    );
    expect(aliasLastCharacter).toBeDefined();
    const aliasedState = `${version}.${stateId}.${signature!.slice(0, -1)}${aliasLastCharacter}`;

    await expect(
      fixture.service.handleCallback({
        actor,
        state: aliasedState,
        code: 'must-not-exchange',
      }),
    ).rejects.toMatchObject({ code: 'invalid-oauth-state' });
    expect(fixture.transport.exchangeCalls).toHaveLength(0);
  });

  it('fails closed for missing, unknown, or identity scopes and for absent offline refresh authority', async () => {
    const cases: Array<{ result: unknown; code: string }> = [
      {
        result: {
          access_token: 'access-token-sensitive',
          refresh_token: 'refresh-token-sensitive',
          expires_in: 3_600,
          token_type: 'Bearer',
          scope: GOOGLE_CALENDAR_SCOPES.eventsReadonly,
        },
        code: 'required-scope-not-granted',
      },
      {
        result: {
          access_token: 'access-token-sensitive',
          refresh_token: 'refresh-token-sensitive',
          expires_in: 3_600,
          token_type: 'Bearer',
          scope: `${GOOGLE_CALENDAR_SCOPES.eventsReadonly} openid`,
        },
        code: 'unexpected-provider-scope',
      },
      {
        result: {
          access_token: 'access-token-sensitive',
          refresh_token: 'refresh-token-sensitive',
          expires_in: 3_600,
          token_type: 'Bearer',
          scope: [
            GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
            GOOGLE_CALENDAR_SCOPES.eventsReadonly,
            GOOGLE_CALENDAR_SCOPES.freeBusy,
            GOOGLE_CALENDAR_SCOPES.events,
          ].join(' '),
        },
        code: 'scope-reconciliation-required',
      },
      {
        result: {
          access_token: 'access-token-sensitive',
          expires_in: 3_600,
          token_type: 'Bearer',
          scope: [
            GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
            GOOGLE_CALENDAR_SCOPES.eventsReadonly,
            GOOGLE_CALENDAR_SCOPES.freeBusy,
          ].join(' '),
        },
        code: 'offline-grant-unavailable',
      },
    ];

    for (const testCase of cases) {
      const fixture = createCallbackFixture();
      fixture.transport.exchangeResult = testCase.result;
      const state = await beginAndGetState(fixture.service);
      await expect(
        fixture.service.handleCallback({
          actor,
          state,
          code: 'provider-authorization-code',
        }),
      ).rejects.toMatchObject({ code: testCase.code });
      expect(fixture.credentialVault.stored).toBeUndefined();
    }
  });

  it('consumes provider denial and exposes only a stable safe error', async () => {
    const fixture = createCallbackFixture();
    const state = await beginAndGetState(fixture.service);

    await expect(
      fixture.service.handleCallback({
        actor,
        state,
        error: 'access_denied',
        errorDescription: 'sensitive-provider-description',
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GoogleCalendarOAuthError>>({
        code: 'authorization-denied',
        message: 'Google Calendar authorization was not completed.',
      }),
    );
    await expect(
      fixture.service.handleCallback({
        actor,
        state,
        code: 'must-not-exchange',
      }),
    ).rejects.toMatchObject({ code: 'invalid-oauth-state' });
    expect(fixture.transport.exchangeCalls).toHaveLength(0);
    expect(JSON.stringify(fixture.audit.events)).not.toContain(
      'sensitive-provider-description',
    );
  });

  it('binds callback persistence to the credential revision present when authorization began', async () => {
    const fixture = createCallbackFixture();
    const state = await beginAndGetState(fixture.service);
    fixture.credentialVault.stored = {
      revision: 1,
      authorizationEpoch: 0,
      credential: credentialWithScopes([
        GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
        GOOGLE_CALENDAR_SCOPES.eventsReadonly,
        GOOGLE_CALENDAR_SCOPES.freeBusy,
      ]),
    };

    await expect(
      fixture.service.handleCallback({
        actor,
        state,
        code: 'must-not-exchange',
      }),
    ).rejects.toMatchObject({ code: 'credential-write-conflict' });
    expect(fixture.transport.exchangeCalls).toHaveLength(0);
    expect(fixture.credentialVault.stored.revision).toBe(1);
  });

  it('rejects a pre-disconnect flow even if the credential revision undergoes ABA', async () => {
    const fixture = createCallbackFixture();
    fixture.credentialVault.stored = {
      revision: 1,
      authorizationEpoch: 0,
      credential: credentialWithScopes([
        GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
        GOOGLE_CALENDAR_SCOPES.eventsReadonly,
        GOOGLE_CALENDAR_SCOPES.freeBusy,
      ]),
    };
    const started = await fixture.service.beginAuthorization({
      actor,
      purpose: 'calendar-event-write',
      idempotencyKey: 'google-oauth-start-aba-0001',
    });
    if (started.status !== 'authorization-required') {
      throw new Error('expected incremental authorization');
    }
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;

    fixture.authorizationEpochStore.epoch = 1;
    fixture.credentialVault.stored = {
      revision: 1,
      authorizationEpoch: 1,
      credential: credentialWithScopes([
        GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
        GOOGLE_CALENDAR_SCOPES.eventsReadonly,
        GOOGLE_CALENDAR_SCOPES.freeBusy,
      ]),
    };

    await expect(
      fixture.service.handleCallback({
        actor,
        state,
        code: 'must-not-exchange',
      }),
    ).rejects.toMatchObject({ code: 'oauth-grant-invalidated' });
    expect(fixture.transport.exchangeCalls).toHaveLength(0);
  });

  it('preserves an existing refresh token during incremental write authorization', async () => {
    const fixture = createCallbackFixture();
    fixture.credentialVault.stored = {
      revision: 4,
      authorizationEpoch: 0,
      credential: credentialWithScopes([
        GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
        GOOGLE_CALENDAR_SCOPES.eventsReadonly,
        GOOGLE_CALENDAR_SCOPES.freeBusy,
      ]),
    };
    fixture.transport.exchangeResult = {
      access_token: 'upgraded-access-token-sensitive',
      expires_in: 3_600,
      token_type: 'Bearer',
      scope: [
        GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
        GOOGLE_CALENDAR_SCOPES.eventsReadonly,
        GOOGLE_CALENDAR_SCOPES.freeBusy,
        GOOGLE_CALENDAR_SCOPES.events,
      ].join(' '),
    };
    const started = await fixture.service.beginAuthorization({
      actor,
      purpose: 'calendar-event-write',
      idempotencyKey: 'google-oauth-start-refresh-0001',
    });
    if (started.status !== 'authorization-required') {
      throw new Error('expected incremental authorization');
    }
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;

    await expect(
      fixture.service.handleCallback({
        actor,
        state,
        code: 'incremental-authorization-code',
      }),
    ).resolves.toMatchObject({
      status: 'connected',
      grantedPurposes: ['calendar-read', 'calendar-event-write'],
    });
    expect(fixture.credentialVault.stored).toMatchObject({
      revision: 5,
      credential: {
        refreshToken: 'existing-refresh-token-sensitive',
        connectedAt: '2026-08-08T16:00:00.000Z',
      },
    });
    expect(fixture.credentialVault.stored?.credential.grantReference).not.toBe(
      'gcal-existing-grant-reference',
    );
  });

  it('advances the durable tombstone and invalidates pending flows even when no credential exists', async () => {
    const fixture = createCallbackFixture();
    const state = await beginAndGetState(fixture.service);

    await expect(
      fixture.service.disconnect({
        actor,
        idempotencyKey: 'google-oauth-disconnect-empty-0001',
      }),
    ).resolves.toEqual({
      status: 'disconnected',
      providerRevocation: 'not-applicable',
    });
    expect(fixture.authorizationEpochStore.epoch).toBe(1);
    await expect(
      fixture.service.handleCallback({
        actor,
        state,
        code: 'must-not-exchange',
      }),
    ).rejects.toMatchObject({ code: 'invalid-oauth-state' });
    expect(fixture.transport.exchangeCalls).toHaveLength(0);
  });
});

describe('GoogleCalendarOAuthService credential broker and disconnect', () => {
  const createConnectedFixture = (expiresAt = '2026-08-09T17:00:00.000Z') => {
    let now = new Date('2026-08-09T16:00:00.000Z');
    const credentialVault = new MemoryCredentialVault();
    const authorizationEpochStore = new MemoryAuthorizationEpochStore();
    credentialVault.stored = {
      revision: 1,
      authorizationEpoch: 0,
      credential: {
        ...credentialWithScopes([
          GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
          GOOGLE_CALENDAR_SCOPES.eventsReadonly,
          GOOGLE_CALENDAR_SCOPES.freeBusy,
        ]),
        expiresAt,
      },
    };
    const transport = new CapturingTransport();
    const audit = new CapturingAudit();
    const disconnectOperationStore = new MemoryDisconnectOperationStore(
      credentialVault,
      authorizationEpochStore,
    );
    const service = new GoogleCalendarOAuthService({
      configuration: {
        calendarClientId: 'calendar-client.apps.googleusercontent.com',
        calendarClientSecret: 'calendar-client-secret-value',
        identityClientId: 'identity-client.apps.googleusercontent.com',
        redirectUri,
        stateSigningKey: Buffer.alloc(32, 7),
      },
      flowStore: new InMemoryGoogleOAuthFlowStore(() => new Date(now)),
      credentialVault,
      authorizationEpochStore,
      disconnectOperationStore,
      transport,
      audit,
      grantLease: directLease,
      clock: () => new Date(now),
      entropy: (length) => Buffer.alloc(length, 13),
    });
    return {
      service,
      credentialVault,
      authorizationEpochStore,
      disconnectOperationStore,
      transport,
      audit,
      setNow(value: string) {
        now = new Date(value);
      },
    };
  };

  it('returns safe status and leases an unexpired access token only for a server-mapped capability', async () => {
    const fixture = createConnectedFixture();

    await expect(
      fixture.service.getConnectionStatus({ actor }),
    ).resolves.toEqual({
      status: 'connected',
      grantedPurposes: ['calendar-read'],
      expiresAt: '2026-08-09T17:00:00.000Z',
    });
    await expect(
      fixture.service.acquireAccessTokenForCapability({
        actor,
        capability: 'calendar-read',
      }),
    ).resolves.toEqual({
      accessToken: 'existing-access-token-sensitive',
      grantReference: 'gcal-existing-grant-reference',
      authorizationEpoch: 0,
      expiresAt: '2026-08-09T17:00:00.000Z',
    });
    expect(fixture.transport.refreshCalls).toHaveLength(0);
    await expect(
      fixture.service.acquireAccessTokenForCapability({
        actor,
        capability: 'calendar-read',
        scopes: ['https://www.googleapis.com/auth/calendar'] as never,
      } as never),
    ).rejects.toThrow();
  });

  it('refreshes near expiry under an exclusive grant lease and persists token rotation', async () => {
    const fixture = createConnectedFixture('2026-08-09T16:00:30.000Z');

    await expect(
      fixture.service.acquireAccessTokenForCapability({
        actor,
        capability: 'calendar-read',
      }),
    ).resolves.toEqual({
      accessToken: 'refreshed-access-token-sensitive',
      grantReference: 'gcal-existing-grant-reference',
      authorizationEpoch: 0,
      expiresAt: '2026-08-09T17:00:00.000Z',
    });
    expect(fixture.transport.refreshCalls).toEqual([
      {
        refreshToken: 'existing-refresh-token-sensitive',
        clientId: 'calendar-client.apps.googleusercontent.com',
        clientSecret: 'calendar-client-secret-value',
      },
    ]);
    expect(fixture.credentialVault.stored).toMatchObject({
      revision: 2,
      credential: {
        accessToken: 'refreshed-access-token-sensitive',
        refreshToken: 'rotated-refresh-token-sensitive',
      },
    });
    expect(JSON.stringify(fixture.audit.events)).not.toMatch(
      /existing-refresh-token|rotated-refresh-token|refreshed-access-token/,
    );
    expect(fixture.audit.events.map(({ event }) => event)).toEqual([
      'google-calendar.oauth-refresh-started',
      'google-calendar.oauth-refreshed',
    ]);
  });

  it('never widens app-owned authority from extra scopes in a refresh response', async () => {
    const fixture = createConnectedFixture('2026-08-09T16:00:30.000Z');
    fixture.transport.refreshResult = {
      access_token: 'refreshed-access-token-sensitive',
      expires_in: 3_600,
      token_type: 'Bearer',
      scope: [
        GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
        GOOGLE_CALENDAR_SCOPES.eventsReadonly,
        GOOGLE_CALENDAR_SCOPES.freeBusy,
        GOOGLE_CALENDAR_SCOPES.events,
      ].join(' '),
    };

    await expect(
      fixture.service.acquireAccessTokenForCapability({
        actor,
        capability: 'calendar-read',
      }),
    ).rejects.toMatchObject({ code: 'scope-reconciliation-required' });
    expect(fixture.credentialVault.stored).toMatchObject({
      revision: 1,
      authorizationEpoch: 0,
      credential: {
        accessToken: 'existing-access-token-sensitive',
        scopes: [
          GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
          GOOGLE_CALENDAR_SCOPES.eventsReadonly,
          GOOGLE_CALENDAR_SCOPES.freeBusy,
        ],
      },
    });
  });

  it('deletes invalid grants and sanitizes arbitrary refresh failures', async () => {
    const invalid = createConnectedFixture('2026-08-09T16:00:30.000Z');
    invalid.transport.refreshFailure = new GoogleOAuthTransportFailure(
      'invalid-grant',
    );
    await expect(
      invalid.service.acquireAccessTokenForCapability({
        actor,
        capability: 'calendar-read',
      }),
    ).rejects.toMatchObject({ code: 'calendar-reconnect-required' });
    expect(invalid.credentialVault.stored).toBeUndefined();

    const unavailable = createConnectedFixture('2026-08-09T16:00:30.000Z');
    unavailable.transport.refreshFailure = new Error(
      'provider leaked refresh-token-sensitive and stack',
    );
    await expect(
      unavailable.service.acquireAccessTokenForCapability({
        actor,
        capability: 'calendar-read',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'provider-unavailable',
        message: 'Google Calendar authorization is temporarily unavailable.',
      }),
    );
    expect(unavailable.credentialVault.stored).toBeDefined();
    expect(JSON.stringify(unavailable.audit.events)).not.toContain(
      'refresh-token-sensitive',
    );
  });

  it('revokes the refresh token, deletes locally, and reports unconfirmed provider revocation safely', async () => {
    const confirmed = createConnectedFixture();
    await expect(
      confirmed.service.disconnect({
        actor,
        idempotencyKey: 'google-oauth-disconnect-confirmed-0001',
      }),
    ).resolves.toEqual({
      status: 'disconnected',
      providerRevocation: 'confirmed',
    });
    expect(confirmed.transport.revokeCalls).toEqual([
      { token: 'existing-refresh-token-sensitive' },
    ]);
    expect(confirmed.credentialVault.stored).toBeUndefined();
    expect(confirmed.audit.events.map(({ event }) => event)).toEqual([
      'google-calendar.oauth-disconnect-started',
      'google-calendar.oauth-disconnected',
    ]);

    const unconfirmed = createConnectedFixture();
    unconfirmed.transport.revokeFailure = new Error(
      'provider leaked refresh-token-sensitive',
    );
    await expect(
      unconfirmed.service.disconnect({
        actor,
        idempotencyKey: 'google-oauth-disconnect-unconfirmed-0001',
      }),
    ).resolves.toEqual({
      status: 'disconnected',
      providerRevocation: 'unconfirmed',
    });
    expect(unconfirmed.credentialVault.stored).toBeUndefined();
    expect(JSON.stringify(unconfirmed.audit.events)).not.toContain(
      'refresh-token-sensitive',
    );
  });

  it('replays one durable disconnect receipt without repeating provider revocation', async () => {
    const fixture = createConnectedFixture();
    const input = {
      actor,
      idempotencyKey: 'google-oauth-disconnect-replay-0001',
    };

    const first = await fixture.service.disconnect(input);
    await expect(fixture.service.disconnect(input)).resolves.toEqual(first);
    expect(fixture.transport.revokeCalls).toEqual([
      { token: 'existing-refresh-token-sensitive' },
    ]);
    expect(fixture.authorizationEpochStore.epoch).toBe(1);
  });

  it('settles a recovered dispatching fence as unconfirmed without another provider call', async () => {
    const fixture = createConnectedFixture();
    const idempotencyKey = 'google-oauth-disconnect-recover-0001';
    await fixture.disconnectOperationStore.seedDispatching({
      actor,
      idempotencyKey,
    });
    expect(fixture.credentialVault.stored).toBeUndefined();
    expect(fixture.authorizationEpochStore.epoch).toBe(1);

    await expect(
      fixture.service.disconnect({ actor, idempotencyKey }),
    ).resolves.toEqual({
      status: 'disconnected',
      providerRevocation: 'unconfirmed',
    });
    expect(fixture.transport.revokeCalls).toHaveLength(0);
    expect(fixture.credentialVault.stored).toBeUndefined();
    expect(fixture.authorizationEpochStore.epoch).toBe(1);
    await expect(
      fixture.service.disconnect({ actor, idempotencyKey }),
    ).resolves.toEqual({
      status: 'disconnected',
      providerRevocation: 'unconfirmed',
    });
    expect(fixture.transport.revokeCalls).toHaveLength(0);
  });

  it('adopts one dispatching credential fence across a rotated session and idempotency key', async () => {
    const fixture = createConnectedFixture();
    await fixture.disconnectOperationStore.seedDispatching({
      actor,
      idempotencyKey: 'google-oauth-disconnect-origin-0001',
    });
    const rotatedActor = {
      ...actor,
      sessionId: '10000000-0000-4000-8000-000000000099',
    };
    const rotatedKey = 'google-oauth-disconnect-rotated-0001';

    await expect(
      fixture.service.disconnect({
        actor: rotatedActor,
        idempotencyKey: rotatedKey,
      }),
    ).resolves.toEqual({
      status: 'disconnected',
      providerRevocation: 'unconfirmed',
    });
    expect(fixture.transport.revokeCalls).toHaveLength(0);
    expect(fixture.credentialVault.stored).toBeUndefined();
    expect(fixture.authorizationEpochStore.epoch).toBe(1);
    await expect(
      fixture.service.disconnect({
        actor: rotatedActor,
        idempotencyKey: rotatedKey,
      }),
    ).resolves.toEqual({
      status: 'disconnected',
      providerRevocation: 'unconfirmed',
    });
    expect(fixture.transport.revokeCalls).toHaveLength(0);
  });

  it('retries revocation after a crash left a credential behind a newer tombstone epoch', async () => {
    const confirmed = createConnectedFixture();
    confirmed.authorizationEpochStore.epoch = 1;
    await expect(
      confirmed.service.disconnect({
        actor,
        idempotencyKey: 'google-oauth-disconnect-stale-confirmed-0001',
      }),
    ).resolves.toEqual({
      status: 'disconnected',
      providerRevocation: 'confirmed',
    });
    expect(confirmed.authorizationEpochStore.epoch).toBe(2);
    expect(confirmed.transport.revokeCalls).toEqual([
      { token: 'existing-refresh-token-sensitive' },
    ]);
    expect(confirmed.credentialVault.stored).toBeUndefined();

    const unconfirmed = createConnectedFixture();
    unconfirmed.authorizationEpochStore.epoch = 1;
    unconfirmed.transport.revokeFailure = new Error('sensitive provider text');
    await expect(
      unconfirmed.service.disconnect({
        actor,
        idempotencyKey: 'google-oauth-disconnect-stale-unconfirmed-0001',
      }),
    ).resolves.toEqual({
      status: 'disconnected',
      providerRevocation: 'unconfirmed',
    });
    expect(unconfirmed.credentialVault.stored).toBeUndefined();
  });
});

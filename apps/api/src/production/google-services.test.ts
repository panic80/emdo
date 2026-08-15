import {
  GoogleCalendarOAuthError,
  GoogleOAuthAuthorizationStartFailure,
} from '@emdo/integrations/google-oauth-routes';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedPrincipal } from '../services/contracts.js';
import { createProductionGoogleCalendarVaultKeyProvider } from './google-calendar-vault-keyring.js';
import {
  createProductionGoogleConnectorBinding,
  type ProductionGoogleConnectorDependencies,
} from './google-services.js';

const ids = Object.freeze({
  userA: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
  userB: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002',
  householdA: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003',
  householdB: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004',
  privateA: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f005',
  privateB: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f006',
  sessionA: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f007',
  sessionB: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f008',
  grantA: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f009',
  grantB: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f00a',
  requestA: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f00b',
  requestB: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f00c',
});

const principal = (suffix: 'A' | 'B'): AuthenticatedPrincipal => ({
  userId: ids[`user${suffix}`],
  householdId: ids[`household${suffix}`],
  privateSpaceId: ids[`private${suffix}`],
  sessionId: ids[`session${suffix}`],
  spaceAccessGrantId: ids[`grant${suffix}`],
  collectionAuthorizationScopeFingerprint: (suffix === 'A'
    ? 'a'.repeat(64)
    : 'b'.repeat(
        64,
      )) as AuthenticatedPrincipal['collectionAuthorizationScopeFingerprint'],
  role: 'owner',
  emailVerified: true,
});

const encodeVaultKeyring = (key = Buffer.alloc(32, 11)): string =>
  Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      current: {
        keyVersion: 'calendar-vault.current-1',
        keyB64url: key.toString('base64url'),
      },
      previous: [],
    }),
    'utf8',
  ).toString('base64url');

const environment = () => ({
  EMDO_API_DATABASE_URL:
    'postgresql://emdo_api_login:secret@postgres:5432/emdo_app?sslmode=disable',
  EMDO_PUBLIC_ORIGIN: 'https://emdo.example',
  EMDO_GOOGLE_IDENTITY_CLIENT_ID:
    '1234567890-identity.apps.googleusercontent.com',
  EMDO_GOOGLE_CALENDAR_OAUTH_CLIENT_ID:
    '1234567890-calendar.apps.googleusercontent.com',
  EMDO_GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: 'GOCSPX-calendar-secret-value',
  EMDO_GOOGLE_CALENDAR_OAUTH_STATE_SIGNING_KEY_B64URL: Buffer.alloc(
    32,
    17,
  ).toString('base64url'),
  EMDO_GOOGLE_CALENDAR_VAULT_KEYRING_B64URL: encodeVaultKeyring(),
});

const dependencies = () => {
  const authorities: unknown[] = [];
  const runtimes: Array<Record<string, unknown>> = [];
  const disposeVault = vi.fn();
  const closeLeaseDatabase = vi.fn(async () => undefined);
  const leasePool = Object.freeze({ connect: vi.fn() }) as never;
  const fetch = vi.fn(async () => {
    throw new Error('provider fetch must not run during construction');
  });
  const routes = {
    beginAuthorization: vi.fn(async () => ({
      status: 'authorization-required' as const,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=x',
      expiresAt: '2026-08-15T12:10:00.000Z',
    })),
    handleCallback: vi.fn(async () => ({
      status: 'connected' as const,
      grantReference: 'gcal-0123456789abcdef0123456789abcdef01234567',
      grantedPurposes: ['calendar-read' as const],
    })),
    getConnectionStatus: vi.fn(),
    disconnect: vi.fn(async () => ({
      status: 'disconnected' as const,
      providerRevocation: 'confirmed' as const,
    })),
  };
  const createRuntime = vi.fn((options: Record<string, unknown>) => {
    runtimes.push(options);
    return {
      routes,
      calendar: {},
      dispose: vi.fn(),
    };
  });
  const captureAuthority = vi.fn((_pool, authority) => {
    authorities.push(authority);
    return {};
  });
  const createGrantLease = vi.fn((_pool, authority) => {
    authorities.push(authority);
    return {};
  });
  const result = {
    fetch,
    createLeaseDatabase: vi.fn(() => ({
      scopedPool: leasePool,
      close: closeLeaseDatabase,
    })),
    createVaultKeyProvider: vi.fn(() => ({ dispose: disposeVault })),
    createOAuthTransport: vi.fn(() => ({})),
    createRuntime,
    createFlowStore: captureAuthority,
    createAuthorizationEpochStore: captureAuthority,
    createDisconnectOperationStore: captureAuthority,
    createGrantStore: captureAuthority,
    createGrantLease,
    createAuditSink: vi.fn((_pool, durablePrincipal, privateSpaceId) => {
      authorities.push({ ...durablePrincipal, privateSpaceId });
      return {};
    }),
    checkReady: vi.fn(async () => true),
    clock: () => new Date('2026-08-15T12:00:00.000Z'),
    entropy: (length: number) => new Uint8Array(length).fill(3),
  } as unknown as ProductionGoogleConnectorDependencies;
  return {
    result,
    authorities,
    runtimes,
    routes,
    disposeVault,
    closeLeaseDatabase,
    leasePool,
    fetch,
  };
};

describe('production Google connector composition', () => {
  it('keeps the connector absent for incomplete, malformed, or reused secrets', () => {
    const pool = {} as never;
    const missing = dependencies();
    expect(
      createProductionGoogleConnectorBinding(
        { environment: {}, pool },
        missing.result,
      ),
    ).toEqual({});
    expect(missing.result.createVaultKeyProvider).not.toHaveBeenCalled();
    expect(missing.result.createLeaseDatabase).not.toHaveBeenCalled();

    const equalClients = dependencies();
    expect(
      createProductionGoogleConnectorBinding(
        {
          environment: {
            ...environment(),
            EMDO_GOOGLE_CALENDAR_OAUTH_CLIENT_ID:
              environment().EMDO_GOOGLE_IDENTITY_CLIENT_ID,
          },
          pool,
        },
        equalClients.result,
      ),
    ).toEqual({});
    expect(equalClients.result.createLeaseDatabase).not.toHaveBeenCalled();

    const reusedSecret = Buffer.alloc(32, 17);
    const reused = dependencies();
    let forbiddenSnapshot: Uint8Array | undefined;
    reused.result.createVaultKeyProvider = vi.fn(
      (encoded, forbiddenKeyMaterials) => {
        forbiddenSnapshot = Uint8Array.from(forbiddenKeyMaterials[0]!);
        return createProductionGoogleCalendarVaultKeyProvider(
          encoded,
          forbiddenKeyMaterials,
        );
      },
    );
    expect(
      createProductionGoogleConnectorBinding(
        {
          environment: {
            ...environment(),
            EMDO_GOOGLE_CALENDAR_VAULT_KEYRING_B64URL:
              encodeVaultKeyring(reusedSecret),
          },
          pool,
        },
        reused.result,
      ),
    ).toEqual({});
    expect(reused.result.createVaultKeyProvider).toHaveBeenCalledOnce();
    expect(Buffer.from(forbiddenSnapshot!)).toEqual(reusedSecret);

    const unavailableLease = dependencies();
    unavailableLease.result.createLeaseDatabase = vi.fn(() => {
      throw new Error('lease database unavailable');
    });
    expect(
      createProductionGoogleConnectorBinding(
        { environment: environment(), pool },
        unavailableLease.result,
      ),
    ).toEqual({});
    expect(unavailableLease.disposeVault).toHaveBeenCalledOnce();
  });

  it('constructs no provider call and creates fresh actor-bound stores per request', async () => {
    const fixture = dependencies();
    const pool = {} as never;
    const composition = createProductionGoogleConnectorBinding(
      { environment: environment(), pool },
      fixture.result,
    );

    expect(composition.binding).toBeDefined();
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.result.createRuntime).not.toHaveBeenCalled();
    expect(fixture.result.createLeaseDatabase).toHaveBeenCalledWith({
      applicationName: 'emdo-api-google-oauth-lease',
      connectionString: environment().EMDO_API_DATABASE_URL,
      max: 2,
    });
    await expect(composition.binding!.check()).resolves.toBe(true);
    expect(vi.mocked(fixture.result.checkReady).mock.calls).toEqual([
      [pool],
      [fixture.leasePool],
    ]);

    await expect(
      composition.binding!.service.beginAuthorization({
        principal: principal('A'),
        purpose: 'calendar-read',
        requestId: ids.requestA,
        idempotencyKey: 'google-start-a-01',
      }),
    ).resolves.toMatchObject({ status: 'authorization-required' });
    await expect(
      composition.binding!.service.disconnect({
        principal: principal('B'),
        requestId: ids.requestB,
        idempotencyKey: 'google-disconnect-b-01',
      }),
    ).resolves.toEqual({
      status: 'disconnected',
      providerRevocation: 'confirmed',
    });

    expect(fixture.runtimes).toHaveLength(2);
    for (const [leasePoolInput] of vi.mocked(fixture.result.createGrantLease)
      .mock.calls) {
      expect(leasePoolInput).toBe(fixture.leasePool);
      expect(leasePoolInput).not.toBe(pool);
    }
    expect(fixture.authorities.slice(0, 6)).toEqual(
      Array.from({ length: 6 }, () => ({
        userId: ids.userA,
        householdId: ids.householdA,
        privateSpaceId: ids.privateA,
        sessionId: ids.sessionA,
        requestId: ids.requestA,
      })),
    );
    expect(fixture.authorities.slice(6)).toEqual(
      Array.from({ length: 6 }, () => ({
        userId: ids.userB,
        householdId: ids.householdB,
        privateSpaceId: ids.privateB,
        sessionId: ids.sessionB,
        requestId: ids.requestB,
      })),
    );
    expect(fixture.runtimes.map((runtime) => runtime.configuration)).toEqual([
      expect.objectContaining({
        redirectUri: 'https://emdo.example/api/v1/connectors/google/callback',
      }),
      expect.objectContaining({
        redirectUri: 'https://emdo.example/api/v1/connectors/google/callback',
      }),
    ]);
    for (const runtime of vi.mocked(fixture.result.createRuntime).mock
      .results) {
      expect(runtime.value.dispose).toHaveBeenCalledOnce();
    }
    expect(fixture.routes.disconnect).toHaveBeenCalledWith({
      actor: {
        userId: ids.userB,
        householdId: ids.householdB,
        privateSpaceId: ids.privateB,
        sessionId: ids.sessionB,
      },
      idempotencyKey: 'google-disconnect-b-01',
    });
  });

  it('fails closed without private-space authority and when readiness is false', async () => {
    const fixture = dependencies();
    fixture.result.checkReady = vi.fn(async () => false);
    const composition = createProductionGoogleConnectorBinding(
      { environment: environment(), pool: {} as never },
      fixture.result,
    );
    const incomplete = { ...principal('A'), privateSpaceId: undefined };

    await expect(composition.binding!.check()).resolves.toBe(false);
    await expect(
      composition.binding!.service.beginAuthorization({
        principal: incomplete,
        purpose: 'calendar-read',
        requestId: ids.requestA,
        idempotencyKey: 'google-start-a-01',
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: 'google-calendar-authority-unavailable',
    });
    expect(fixture.result.createRuntime).not.toHaveBeenCalled();
  });

  it('maps only reviewed OAuth outcomes to the public gateway contract', async () => {
    const fixture = dependencies();
    const composition = createProductionGoogleConnectorBinding(
      { environment: environment(), pool: {} as never },
      fixture.result,
    );

    fixture.routes.handleCallback.mockRejectedValueOnce(
      new GoogleCalendarOAuthError('authorization-denied'),
    );
    await expect(
      composition.binding!.service.completeAuthorization({
        principal: principal('A'),
        state: `v1.${'x'.repeat(43)}.${'y'.repeat(43)}`,
        error: 'access_denied',
        requestId: ids.requestA,
      }),
    ).resolves.toEqual({ status: 'denied' });

    fixture.routes.beginAuthorization.mockRejectedValueOnce(
      new GoogleOAuthAuthorizationStartFailure('conflict'),
    );
    await expect(
      composition.binding!.service.beginAuthorization({
        principal: principal('A'),
        purpose: 'calendar-read',
        requestId: ids.requestA,
        idempotencyKey: 'google-start-a-01',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'google-oauth-idempotency-conflict',
    });

    await expect(
      composition.binding!.service.completeAuthorization({
        principal: principal('A'),
        state: `v1.${'x'.repeat(43)}.${'y'.repeat(43)}`,
        code: 'provider-code',
        requestId: ids.requestA,
      }),
    ).resolves.toEqual({
      status: 'connected',
      connectionId: 'gcal-0123456789abcdef0123456789abcdef01234567',
      grantedPurposes: ['calendar-read'],
    });
  });

  it('disposes secrets once and rejects operations after shutdown', async () => {
    const fixture = dependencies();
    const composition = createProductionGoogleConnectorBinding(
      { environment: environment(), pool: {} as never },
      fixture.result,
    );

    await composition.close?.();
    await composition.close?.();
    expect(fixture.disposeVault).toHaveBeenCalledOnce();
    expect(fixture.closeLeaseDatabase).toHaveBeenCalledOnce();
    await expect(
      composition.binding!.service.beginAuthorization({
        principal: principal('A'),
        purpose: 'calendar-read',
        requestId: ids.requestA,
        idempotencyKey: 'google-start-a-01',
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: 'connector-unavailable',
    });
  });

  it('drains in-flight routes before erasing shared secrets and rejects late work', async () => {
    const fixture = dependencies();
    let releaseAuthorization:
      | ((value: {
          status: 'authorization-required';
          authorizationUrl: string;
          expiresAt: string;
        }) => void)
      | undefined;
    fixture.routes.beginAuthorization.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseAuthorization = resolve;
        }),
    );
    const composition = createProductionGoogleConnectorBinding(
      { environment: environment(), pool: {} as never },
      fixture.result,
    );

    const active = composition.binding!.service.beginAuthorization({
      principal: principal('A'),
      purpose: 'calendar-read',
      requestId: ids.requestA,
      idempotencyKey: 'google-start-a-drain-01',
    });
    await vi.waitFor(() => {
      expect(fixture.routes.beginAuthorization).toHaveBeenCalledOnce();
    });

    const closing = composition.close!();
    await Promise.resolve();
    expect(fixture.disposeVault).not.toHaveBeenCalled();
    expect(fixture.closeLeaseDatabase).not.toHaveBeenCalled();
    await expect(
      composition.binding!.service.disconnect({
        principal: principal('A'),
        requestId: ids.requestA,
        idempotencyKey: 'google-disconnect-after-close-01',
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: 'connector-unavailable',
    });

    releaseAuthorization!({
      status: 'authorization-required',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=x',
      expiresAt: '2026-08-15T12:10:00.000Z',
    });
    await expect(active).resolves.toMatchObject({
      status: 'authorization-required',
    });
    await closing;
    expect(fixture.disposeVault).toHaveBeenCalledOnce();
    expect(fixture.closeLeaseDatabase).toHaveBeenCalledOnce();
  });
});

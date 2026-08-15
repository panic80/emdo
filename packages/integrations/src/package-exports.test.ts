import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import type { GoogleCalendarOAuthRouteService } from '@emdo/integrations/google-oauth-routes';
import {
  createGoogleCalendarOAuthServerRuntime,
  type GoogleCalendarOAuthServerRuntimeOptions,
} from '@emdo/integrations/google-oauth-server';
import { FetchGoogleCalendarConditionalGateway } from '@emdo/integrations/google-calendar';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { GoogleCalendarOAuthService } from './google/oauth/service.js';

describe('integration package subpath exports', () => {
  it('keeps the package root credential-free', async () => {
    const root = await import('@emdo/integrations');

    expect(Object.keys(root)).toEqual([]);
    expect(root).not.toHaveProperty('VaultCrypto');
    expect(root).not.toHaveProperty('InMemoryVaultKeyProvider');
    expect(root).not.toHaveProperty('InMemoryVaultRepository');
  });

  it('exposes production OpenAI, Maps, Calendar, and commerce facades', async () => {
    const [openai, maps, calendar, commerce] = await Promise.all([
      import('@emdo/integrations/openai'),
      import('@emdo/integrations/maps'),
      import('@emdo/integrations/google-calendar'),
      import('@emdo/integrations/commerce'),
    ]);

    expect(openai).toHaveProperty('OpenAiAudioAdapter');
    expect(openai).toHaveProperty('OpenAiFetchAudioTransport');
    expect(maps).toHaveProperty('GoogleRoutesTravelTimeClient');
    expect(maps).toHaveProperty('runGoogleRoutesDeploymentSmoke');
    expect(maps).not.toHaveProperty('RecordedMapsTravelTimeClient');
    expect(maps).not.toHaveProperty('runGoogleRoutesFixtureSmoke');
    expect(maps).not.toHaveProperty('lookupWithGoogleRoutesDeploymentClient');
    expect(calendar).toHaveProperty('CalendarWriteExecutor');
    expect(calendar).toHaveProperty('GoogleCalendarFreeBusyClient');
    expect(calendar).toHaveProperty('GoogleCalendarReadClient');
    expect(calendar).toHaveProperty('FetchGoogleCalendarConditionalGateway');
    expect(calendar).toHaveProperty('runGoogleCalendarReadOnlySmoke');
    expect(calendar).not.toHaveProperty('RecordedGoogleCalendarGateway');
    expect(calendar).not.toHaveProperty('InMemoryCalendarWriteReceiptStore');
    expect(commerce).toHaveProperty('CommerceConnectorRegistry');
    expect(commerce).toHaveProperty('normalizeCommerceOfferCandidate');
    expect(commerce).toHaveProperty('refreshOffersBeforeHandoff');
    expect(commerce).not.toHaveProperty('resolveApprovedCommerceConnector');
    expect(commerce).not.toHaveProperty('runFixtureConnectorConformance');
  });

  it('exposes only the API-safe Google OAuth route facade', async () => {
    const oauth = await import('@emdo/integrations/google-oauth-routes');

    expect(oauth).toHaveProperty('createGoogleCalendarOAuthRouteService');
    expect(oauth).toHaveProperty(
      'createUnavailableGoogleCalendarOAuthRouteService',
    );
    expect(oauth).toHaveProperty('GoogleCalendarOAuthCallbackInputSchema');
    expect(oauth).toHaveProperty('GoogleCalendarOAuthError');

    expect(oauth).not.toHaveProperty('GoogleCalendarOAuthService');
    expect(oauth).not.toHaveProperty('GOOGLE_CALENDAR_SCOPES');
    expect(oauth).not.toHaveProperty('GoogleCalendarCredentialSchema');
    expect(oauth).not.toHaveProperty('EncryptedGoogleCalendarCredentialVault');
    expect(oauth).not.toHaveProperty('FetchGoogleOAuthTransport');
    expect(oauth).not.toHaveProperty('RecordedGoogleOAuthTransport');
    expect(oauth).not.toHaveProperty('InMemoryGoogleOAuthFlowStore');
  });

  it('keeps the Node-only OAuth composition facade narrow', async () => {
    const server = await import('@emdo/integrations/google-oauth-server');

    expect(server).toHaveProperty('createGoogleCalendarOAuthServerRuntime');
    expect(server).toHaveProperty('FetchGoogleOAuthTransport');
    expect(server).toHaveProperty('RotatingVaultKeyProvider');
    expect(server).not.toHaveProperty(
      'createGoogleCalendarCredentialedLiveSmokeTarget',
    );
    expect(server).not.toHaveProperty('GoogleCalendarOAuthService');
    expect(server).not.toHaveProperty('EncryptedGoogleCalendarCredentialVault');
    expect(server).not.toHaveProperty('VaultCrypto');
    expect(server).not.toHaveProperty('GoogleCalendarCredentialSchema');
    expect(server).not.toHaveProperty('RecordedGoogleOAuthTransport');
    expect(server).not.toHaveProperty('InMemoryGoogleOAuthFlowStore');
    expect(server).not.toHaveProperty('InMemoryVaultKeyProvider');
    expect(server).not.toHaveProperty('InMemoryVaultRepository');
  });

  it('composes Calendar clients without returning a token broker or vault', () => {
    const options = {
      configuration: {
        calendarClientId: 'calendar-client-id',
        calendarClientSecret: 'calendar-client-secret-value',
        identityClientId: 'identity-client-id',
        redirectUri: 'https://emdo.example/api/v1/connectors/google/callback',
        stateSigningKey: new Uint8Array(32).fill(7),
      },
      flowStore: {
        storeAuthorizationStart: async (input) => ({
          status: 'stored' as const,
          result: input.result,
        }),
        consume: async () => ({ status: 'missing' as const }),
        invalidateActor: async () => 0,
      },
      authorizationEpochStore: {
        load: async () => 0,
        advance: async () => ({ status: 'conflict' as const }),
      },
      grantStore: {
        load: async () => undefined,
        compareAndSet: async () => ({ status: 'conflict' as const }),
        delete: async () => false,
      },
      keyProvider: {
        wrap: async () => ({ wrappedKey: 'unused', keyVersion: 'v1' }),
        unwrap: async () => new Uint8Array(32),
      },
      transport: {
        exchangeAuthorizationCode: async () => ({}),
        refreshAccessToken: async () => ({}),
        revokeToken: async () => ({}),
      },
      calendarFetch: async () => new Response('{}'),
      audit: { record: async () => undefined },
      grantLease: {
        runExclusive: async <Value>(
          _actor: unknown,
          operation: () => Promise<Value>,
        ) => operation(),
      },
      clock: () => new Date('2026-08-09T16:00:00.000Z'),
      entropy: (length: number) => new Uint8Array(length).fill(3),
    } satisfies GoogleCalendarOAuthServerRuntimeOptions;

    const runtime = createGoogleCalendarOAuthServerRuntime(options);

    expect(Object.keys(runtime).sort()).toEqual(['calendar', 'routes']);
    expect(Object.keys(runtime.routes).sort()).toEqual([
      'beginAuthorization',
      'disconnect',
      'getConnectionStatus',
      'handleCallback',
    ]);
    expect(Object.keys(runtime.calendar).sort()).toEqual([
      'createConditionalGateway',
      'freeBusy',
      'read',
      'smokeTarget',
    ]);
    expect(runtime).not.toHaveProperty('calendarCredentialBroker');
    expect(runtime).not.toHaveProperty('credentialVault');
    expect(runtime.calendar).not.toHaveProperty(
      'acquireAccessTokenForCapability',
    );
    expect(runtime.calendar.smokeTarget).toBeTypeOf('object');
    expect(Object.keys(runtime.calendar.smokeTarget)).toEqual([]);

    const trustedScope = {
      actor: {
        userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f101',
        householdId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f102',
        privateSpaceId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f103',
        sessionId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f104',
      },
      authorizationScopeFingerprint:
        EffectiveAuthorizationScopeFingerprintSchema.parse('5'.repeat(64)),
    } as const;
    expect(
      runtime.calendar.createConditionalGateway(trustedScope),
    ).toBeInstanceOf(FetchGoogleCalendarConditionalGateway);
    expect(() =>
      runtime.calendar.createConditionalGateway(trustedScope.actor as never),
    ).toThrow('invalid-google-calendar-conditional-gateway-scope');
    expect(() =>
      runtime.calendar.createConditionalGateway({
        ...trustedScope,
        accessToken: 'must-never-enter-the-server-facade',
      } as never),
    ).toThrow('invalid-google-calendar-conditional-gateway-scope');

    let accessorReads = 0;
    const accessorScope = Object.defineProperty(
      {
        authorizationScopeFingerprint:
          trustedScope.authorizationScopeFingerprint,
      },
      'actor',
      {
        enumerable: true,
        get: () => {
          accessorReads += 1;
          return trustedScope.actor;
        },
      },
    );
    expect(() =>
      runtime.calendar.createConditionalGateway(accessorScope as never),
    ).toThrow('invalid-google-calendar-conditional-gateway-scope');
    expect(accessorReads).toBe(0);
  });

  it('keeps the OAuth route type structurally compatible and broker-free', () => {
    expectTypeOf<GoogleCalendarOAuthService>().toMatchTypeOf<GoogleCalendarOAuthRouteService>();
    expectTypeOf<keyof GoogleCalendarOAuthRouteService>().toEqualTypeOf<
      | 'beginAuthorization'
      | 'handleCallback'
      | 'getConnectionStatus'
      | 'disconnect'
    >();
  });
});

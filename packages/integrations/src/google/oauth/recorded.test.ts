import { describe, expect, it } from 'vitest';

import {
  GoogleOAuthTransportFailure,
  type GoogleOAuthTransport,
} from './service.js';
import { RecordedGoogleOAuthTransport } from './recorded.js';

const exchangeRequest = {
  code: 'recorded-authorization-code',
  codeVerifier: 'v'.repeat(43),
  clientId: 'calendar-client.apps.googleusercontent.com',
  clientSecret: 'recorded-client-secret',
  redirectUri: 'https://emdo.example/api/v1/connectors/google/callback',
};

const refreshRequest = {
  refreshToken: 'recorded-refresh-token',
  clientId: 'calendar-client.apps.googleusercontent.com',
  clientSecret: 'recorded-client-secret',
};

describe('RecordedGoogleOAuthTransport', () => {
  it('serves exact one-shot exchange, refresh, and revocation fixtures without networking', async () => {
    const transport: GoogleOAuthTransport = new RecordedGoogleOAuthTransport([
      {
        operation: 'exchange',
        request: exchangeRequest,
        outcome: {
          status: 'success',
          response: {
            access_token: 'recorded-access-token',
            refresh_token: 'recorded-refresh-token',
            expires_in: 3_600,
            token_type: 'Bearer',
            scope: 'https://www.googleapis.com/auth/calendar.events.readonly',
          },
        },
      },
      {
        operation: 'refresh',
        request: refreshRequest,
        outcome: {
          status: 'success',
          response: {
            access_token: 'recorded-refreshed-access-token',
            expires_in: 3_600,
            token_type: 'Bearer',
          },
        },
      },
      {
        operation: 'revoke',
        request: { token: 'recorded-refresh-token' },
        outcome: { status: 'success', response: null },
      },
    ]);

    await expect(
      transport.exchangeAuthorizationCode(exchangeRequest),
    ).resolves.toMatchObject({ access_token: 'recorded-access-token' });
    await expect(
      transport.refreshAccessToken(refreshRequest),
    ).resolves.toMatchObject({
      access_token: 'recorded-refreshed-access-token',
    });
    await expect(
      transport.revokeToken({ token: 'recorded-refresh-token' }),
    ).resolves.toBeNull();
    expect((transport as RecordedGoogleOAuthTransport).counts).toEqual({
      exchange: 1,
      refresh: 1,
      revoke: 1,
    });
    await expect(
      transport.exchangeAuthorizationCode(exchangeRequest),
    ).rejects.toMatchObject({ reason: 'temporarily-unavailable' });
  });

  it('does not consume or approximate a fixture when any security-bound field differs', async () => {
    const transport = new RecordedGoogleOAuthTransport([
      {
        operation: 'exchange',
        request: exchangeRequest,
        outcome: { status: 'success', response: { ok: true } },
      },
    ]);

    await expect(
      transport.exchangeAuthorizationCode({
        ...exchangeRequest,
        redirectUri: `${exchangeRequest.redirectUri}/attacker`,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GoogleOAuthTransportFailure>>({
        reason: 'temporarily-unavailable',
        message: 'Google OAuth transport failed',
      }),
    );
    await expect(
      transport.exchangeAuthorizationCode(exchangeRequest),
    ).resolves.toEqual({ ok: true });
  });

  it('replays only typed safe failures and rejects hostile fixture objects without invoking accessors', async () => {
    const transport = new RecordedGoogleOAuthTransport([
      {
        operation: 'refresh',
        request: refreshRequest,
        outcome: { status: 'failure', reason: 'invalid-grant' },
      },
    ]);
    await expect(transport.refreshAccessToken(refreshRequest)).rejects.toEqual(
      expect.objectContaining({
        reason: 'invalid-grant',
        message: 'Google OAuth transport failed',
      }),
    );

    let getterCalls = 0;
    const hostile = Object.defineProperty({}, 'operation', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'exchange';
      },
    });
    expect(() => new RecordedGoogleOAuthTransport([hostile])).toThrow(
      /plain data/,
    );
    expect(getterCalls).toBe(0);
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => new RecordedGoogleOAuthTransport(cyclic)).toThrow(
      /plain data/,
    );
  });
});

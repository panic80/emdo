import { describe, expect, it, vi } from 'vitest';

import {
  GOOGLE_OAUTH_ENDPOINTS,
  FetchGoogleOAuthTransport,
} from './fetch-transport.js';
import {
  GoogleOAuthTransportFailure,
  type GoogleOAuthTransport,
} from './service.js';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const tokenResponse = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_in: 3_600,
  token_type: 'Bearer',
  scope: 'https://www.googleapis.com/auth/calendar.events.readonly',
};

describe('FetchGoogleOAuthTransport', () => {
  it('posts an authorization-code exchange to the exact Google token endpoint', async () => {
    const fetch = vi.fn(async () => jsonResponse(tokenResponse));
    const transport: GoogleOAuthTransport = new FetchGoogleOAuthTransport({
      fetch,
    });

    await expect(
      transport.exchangeAuthorizationCode({
        code: 'provider-code',
        codeVerifier: 'v'.repeat(64),
        clientId: 'calendar-client.apps.googleusercontent.com',
        clientSecret: 'calendar-client-secret',
        redirectUri: 'https://emdo.example/api/v1/connectors/google/callback',
      }),
    ).resolves.toEqual(tokenResponse);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(GOOGLE_OAUTH_ENDPOINTS.token);
    expect(init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    expect(new URLSearchParams(init.body as string)).toEqual(
      new URLSearchParams({
        code: 'provider-code',
        code_verifier: 'v'.repeat(64),
        client_id: 'calendar-client.apps.googleusercontent.com',
        client_secret: 'calendar-client-secret',
        redirect_uri: 'https://emdo.example/api/v1/connectors/google/callback',
        grant_type: 'authorization_code',
      }),
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('posts refresh and revocation secrets in form bodies, never URLs', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'new-access-token',
          expires_in: 3_600,
          token_type: 'Bearer',
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const transport = new FetchGoogleOAuthTransport({ fetch });

    await transport.refreshAccessToken({
      refreshToken: 'refresh-token',
      clientId: 'calendar-client.apps.googleusercontent.com',
      clientSecret: 'calendar-client-secret',
    });
    await transport.revokeToken({ token: 'refresh-token' });

    const [refreshUrl, refreshInit] = fetch.mock.calls[0]!;
    expect(refreshUrl).toBe(GOOGLE_OAUTH_ENDPOINTS.token);
    expect(refreshUrl).not.toContain('refresh-token');
    expect(new URLSearchParams(refreshInit.body as string)).toEqual(
      new URLSearchParams({
        refresh_token: 'refresh-token',
        client_id: 'calendar-client.apps.googleusercontent.com',
        client_secret: 'calendar-client-secret',
        grant_type: 'refresh_token',
      }),
    );

    const [revokeUrl, revokeInit] = fetch.mock.calls[1]!;
    expect(revokeUrl).toBe(GOOGLE_OAUTH_ENDPOINTS.revoke);
    expect(revokeUrl).not.toContain('refresh-token');
    expect(new URLSearchParams(revokeInit.body as string)).toEqual(
      new URLSearchParams({ token: 'refresh-token' }),
    );
  });

  it('maps invalid_grant without exposing the provider response body', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        {
          error: 'invalid_grant',
          error_description: 'contains provider details and secrets',
        },
        400,
      ),
    );
    const transport = new FetchGoogleOAuthTransport({ fetch });

    const failure = await transport
      .refreshAccessToken({
        refreshToken: 'refresh-token',
        clientId: 'calendar-client.apps.googleusercontent.com',
        clientSecret: 'calendar-client-secret',
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GoogleOAuthTransportFailure);
    expect(failure).toMatchObject({
      reason: 'invalid-grant',
      message: 'Google OAuth transport failed',
    });
    expect(JSON.stringify(failure)).not.toContain('provider details');
    expect(JSON.stringify(failure)).not.toContain('refresh-token');
  });

  it.each([
    [408, 'temporarily-unavailable'],
    [429, 'temporarily-unavailable'],
    [500, 'temporarily-unavailable'],
    [403, 'provider-rejected'],
  ] as const)('maps HTTP %i to %s', async (status, reason) => {
    const response = new Response('provider-body-must-not-escape', { status });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const transport = new FetchGoogleOAuthTransport({
      fetch: async () => response,
    });

    await expect(
      transport.revokeToken({ token: 'refresh-token' }),
    ).rejects.toMatchObject({ reason });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects oversized JSON before reading it', async () => {
    const response = new Response('{}', {
      headers: {
        'content-type': 'application/json',
        'content-length': `${128 * 1024}`,
      },
    });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const transport = new FetchGoogleOAuthTransport({
      fetch: async () => response,
    });

    await expect(
      transport.exchangeAuthorizationCode({
        code: 'provider-code',
        codeVerifier: 'v'.repeat(64),
        clientId: 'calendar-client.apps.googleusercontent.com',
        clientSecret: 'calendar-client-secret',
        redirectUri: 'https://emdo.example/callback',
      }),
    ).rejects.toMatchObject({ reason: 'provider-rejected' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('aborts at its deadline and disposes a response that resolves late', async () => {
    let resolveFetch!: (response: Response) => void;
    let seenSignal: AbortSignal | undefined;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const transport = new FetchGoogleOAuthTransport({
      timeoutMs: 5,
      fetch: async (_url, init) => {
        seenSignal = init?.signal as AbortSignal;
        return pending;
      },
    });

    const result = transport.refreshAccessToken({
      refreshToken: 'refresh-token',
      clientId: 'calendar-client.apps.googleusercontent.com',
      clientSecret: 'calendar-client-secret',
    });
    await expect(result).rejects.toMatchObject({
      reason: 'temporarily-unavailable',
    });
    expect(seenSignal?.aborted).toBe(true);

    const lateResponse = new Response('late-provider-body');
    const cancel = vi.spyOn(lateResponse.body!, 'cancel');
    resolveFetch(lateResponse);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects accessor-backed input before any network request', async () => {
    const fetch = vi.fn();
    const transport = new FetchGoogleOAuthTransport({ fetch });
    const hostile = Object.defineProperty({}, 'token', {
      enumerable: true,
      get: () => 'refresh-token',
    });

    await expect(transport.revokeToken(hostile as never)).rejects.toMatchObject(
      { reason: 'provider-rejected' },
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

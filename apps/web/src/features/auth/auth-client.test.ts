import { describe, expect, it, vi } from 'vitest';

import { AuthClientError, createEmdoAuthClient } from './auth-client.js';

const sessionPayload = {
  session: { id: 'session-1', expiresAt: '2026-08-16T12:00:00.000Z' },
  user: {
    id: 'user-1',
    email: 'member@example.ca',
    emailVerified: true,
    name: 'Member',
  },
};

describe('EMDO browser auth client', () => {
  it('distinguishes a session transport failure from an authoritative server response', async () => {
    const client = createEmdoAuthClient({
      fetcher: vi.fn<typeof fetch>(async () => {
        throw new TypeError('Failed to fetch provider detail');
      }),
    });

    await expect(client.getSession()).rejects.toMatchObject({
      code: 'session-network-unavailable',
      message: 'EMDO could not reach the secure session endpoint.',
    });
  });

  it('reads the cookie-backed session with no-store and never accepts a raw token as session state', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ ...sessionPayload, token: 'must-not-be-used' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    const client = createEmdoAuthClient({ fetcher });

    await expect(client.getSession()).resolves.toEqual(sessionPayload);
    expect(fetcher).toHaveBeenCalledWith('/api/auth/get-session', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    expect(client).not.toHaveProperty('token');
  });

  it('issues an authenticated mutation proof into memory without reading cookies', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            token: 'csrf-token-01234567890123456789',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const client = createEmdoAuthClient({ fetcher });

    await expect(client.getMutationCsrf()).resolves.toBe(
      'csrf-token-01234567890123456789',
    );
    expect(fetcher).toHaveBeenCalledWith('/api/v1/auth/csrf', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
  });

  it('normalizes email sign-in and does not read the returned raw token', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ token: 'server-only', user: sessionPayload.user }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    const client = createEmdoAuthClient({ fetcher });

    await client.signInEmail({
      email: '  MEMBER@Example.CA ',
      password: 'correct horse battery staple',
      rememberMe: true,
    });

    const init = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      email: 'member@example.ca',
      password: 'correct horse battery staple',
      rememberMe: true,
    });
  });

  it.each([
    [401, 'INVALID_EMAIL_OR_PASSWORD'],
    [403, 'EMAIL_NOT_VERIFIED'],
  ])(
    'collapses %s sign-in errors to a generic safe message',
    async (status, code) => {
      const client = createEmdoAuthClient({
        fetcher: vi.fn<typeof fetch>(
          async () =>
            new Response(
              JSON.stringify({ code, message: 'sensitive provider detail' }),
              {
                status,
                headers: { 'content-type': 'application/json' },
              },
            ),
        ),
      });

      await expect(
        client.signInEmail({
          email: 'member@example.ca',
          password: 'wrong',
          rememberMe: false,
        }),
      ).rejects.toMatchObject({
        code: 'sign-in-failed',
        message:
          'We could not sign you in. Check your details or verify your email, then try again.',
      });
    },
  );

  it('sends only the Google identity allowlist and navigates to a validated HTTPS URL', async () => {
    const navigate = vi.fn();
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            redirect: true,
            url: 'https://accounts.google.com/o/oauth2/v2/auth',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    const client = createEmdoAuthClient({ fetcher, navigate });

    await client.signInGoogle('/today');

    const init = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      provider: 'google',
      callbackURL: '/today',
    });
    expect(navigate).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
  });

  it('delegates passkey ceremonies and treats user cancellation as nonfatal', async () => {
    const passkeys = {
      signIn: vi.fn(async () => ({ status: 'cancelled' as const })),
      register: vi.fn(async () => ({ status: 'registered' as const })),
    };
    const client = createEmdoAuthClient({
      fetcher: vi.fn<typeof fetch>(),
      passkeys,
    });

    await expect(client.signInPasskey()).resolves.toBe('cancelled');
    await expect(
      client.registerPasskey('This Mac', 'csrf-token-0123456789012345'),
    ).resolves.toBeUndefined();
    expect(passkeys.register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'This Mac',
        authenticatorAttachment: 'platform',
        csrfToken: 'csrf-token-0123456789012345',
      }),
    );
  });

  it('redeems only the strict invite-bound onboarding payload and never auto-signs in', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            token: 'invitation-csrf-token-0123456789',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            userId: '22222222-2222-4222-8222-222222222222',
            householdId: '33333333-3333-4333-8333-333333333333',
            role: 'member',
            emailVerified: true,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      );
    const client = createEmdoAuthClient({ fetcher });
    const request = {
      schemaVersion: 1 as const,
      displayName: 'Household Member',
      email: 'member@example.ca',
      invitationId: '11111111-1111-4111-8111-111111111111',
      invitationToken: 'single-use-secret-012345',
      password: 'correct horse battery staple',
    };

    await expect(client.redeemInvitation(request)).resolves.toEqual({
      email: 'member@example.ca',
      role: 'member',
      status: 'provisioned',
    });
    const init = fetcher.mock.calls[1]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual(request);
  });

  it('reports invitation failures without exposing household or token existence', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            token: 'invitation-csrf-token-0123456789',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ detail: 'token already used for secret household' }),
          {
            status: 409,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
      );
    const client = createEmdoAuthClient({ fetcher });

    await expect(
      client.redeemInvitation({
        schemaVersion: 1,
        displayName: 'Member',
        email: 'member@example.ca',
        invitationId: '11111111-1111-4111-8111-111111111111',
        invitationToken: 'single-use-secret-012345',
        password: 'correct horse battery staple',
      }),
    ).rejects.toEqual(
      new AuthClientError(
        'invitation-invalid',
        'This invitation is invalid, expired, or already used. Ask the household owner for a new invitation.',
        409,
      ),
    );
  });
});

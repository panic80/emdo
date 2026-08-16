import { CsrfProtector } from '@emdo/auth/server';
import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { describe, expect, it } from 'vitest';

import { createProductionAuthenticationBoundary } from './auth-boundary.js';

const USER_ID = '018f1f5e-2000-7000-8000-000000000001';
const SESSION_ID = '018f1f5e-2000-7000-8000-000000000002';
const HOUSEHOLD_ID = '018f1f5e-2000-7000-8000-000000000003';
const MEMBERSHIP_ID = '018f1f5e-2000-7000-8000-000000000004';
const SPACE_GRANT_ID = '018f1f5e-2000-7000-8000-000000000005';
const REQUEST_ID = '018f1f5e-2000-7000-8000-000000000006';
const PRIVATE_SPACE_ID = '018f1f5e-2000-7000-8000-000000000007';
const COLLECTION_SCOPE_FINGERPRINT =
  EffectiveAuthorizationScopeFingerprintSchema.parse('c'.repeat(64));

const createCsrfProtector = () =>
  new CsrfProtector({
    secret: Buffer.alloc(32, 17),
    trustedOrigins: ['https://emdo.example'],
  });

const createInvitationRedemptionCoordinator = () => ({
  redeem: async () => ({
    status: 'provisioned' as const,
    result: {
      schemaVersion: 1 as const,
      userId: USER_ID,
      householdId: HOUSEHOLD_ID,
      role: 'member' as const,
      emailVerified: true as const,
    },
  }),
});

describe('production Better Auth boundary', () => {
  it('derives a principal from one verified session, its active member, and a server scope resolver', async () => {
    const sessionInputs: unknown[] = [];
    const activeMemberInputs: unknown[] = [];
    const scopeInputs: unknown[] = [];
    const auth = {
      api: {
        getSession: async (input: unknown) => {
          sessionInputs.push(input);
          return {
            session: { id: SESSION_ID, userId: USER_ID },
            user: { id: USER_ID, emailVerified: true },
          };
        },
        getActiveMember: async (input: unknown) => {
          activeMemberInputs.push(input);
          return {
            id: MEMBERSHIP_ID,
            organizationId: HOUSEHOLD_ID,
            userId: USER_ID,
            role: 'owner',
          };
        },
      },
      handler: async () => new Response(null, { status: 204 }),
    };
    const boundary = createProductionAuthenticationBoundary({
      auth,
      csrfProtector: createCsrfProtector(),
      invitationRedemptions: createInvitationRedemptionCoordinator(),
      publicOrigin: 'https://emdo.example',
      scopeResolver: {
        resolveActivePrincipalScope: async (input) => {
          scopeInputs.push(input);
          return {
            collectionAuthorizationScopeFingerprint:
              COLLECTION_SCOPE_FINGERPRINT,
            householdId: HOUSEHOLD_ID,
            privateSpaceId: PRIVATE_SPACE_ID,
            role: 'owner',
            spaceAccessGrantId: SPACE_GRANT_ID,
          };
        },
      },
    });

    const principal = await boundary.authenticate({
      requestId: REQUEST_ID,
      method: 'GET',
      path: '/api/v1/turns',
      cookie: '__Secure-emdo.session_token=opaque-session-cookie',
    });

    expect(principal).toEqual({
      collectionAuthorizationScopeFingerprint: COLLECTION_SCOPE_FINGERPRINT,
      userId: USER_ID,
      sessionId: SESSION_ID,
      householdId: HOUSEHOLD_ID,
      privateSpaceId: PRIVATE_SPACE_ID,
      role: 'owner',
      emailVerified: true,
      spaceAccessGrantId: SPACE_GRANT_ID,
    });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(sessionInputs).toHaveLength(1);
    expect(sessionInputs[0]).toMatchObject({
      query: { disableCookieCache: true, disableRefresh: true },
    });
    const credentialHeaders = (
      sessionInputs[0] as { readonly headers: Headers }
    ).headers;
    expect(credentialHeaders.get('cookie')).toBe(
      '__Secure-emdo.session_token=opaque-session-cookie',
    );
    expect(credentialHeaders.get('authorization')).toBeNull();
    expect(activeMemberInputs).toHaveLength(1);
    expect(scopeInputs).toEqual([
      {
        activeMembershipId: MEMBERSHIP_ID,
        householdId: HOUSEHOLD_ID,
        requestId: REQUEST_ID,
        role: 'owner',
        sessionId: SESSION_ID,
        userId: USER_ID,
      },
    ]);
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'not-a-fingerprint'],
  ])(
    'rejects a server scope result with a %s collection fingerprint',
    async (_kind, collectionAuthorizationScopeFingerprint) => {
      const boundary = createProductionAuthenticationBoundary({
        auth: {
          api: {
            getSession: async () => ({
              session: { id: SESSION_ID, userId: USER_ID },
              user: { id: USER_ID, emailVerified: true },
            }),
            getActiveMember: async () => ({
              id: MEMBERSHIP_ID,
              organizationId: HOUSEHOLD_ID,
              userId: USER_ID,
              role: 'owner',
            }),
          },
          handler: async () => new Response(null, { status: 204 }),
        },
        csrfProtector: createCsrfProtector(),
        invitationRedemptions: createInvitationRedemptionCoordinator(),
        publicOrigin: 'https://emdo.example',
        scopeResolver: {
          resolveActivePrincipalScope: async () => ({
            ...(collectionAuthorizationScopeFingerprint === undefined
              ? {}
              : { collectionAuthorizationScopeFingerprint }),
            householdId: HOUSEHOLD_ID,
            privateSpaceId: PRIVATE_SPACE_ID,
            role: 'owner',
            spaceAccessGrantId: SPACE_GRANT_ID,
          }),
        },
      });

      await expect(
        boundary.authenticate({
          requestId: REQUEST_ID,
          method: 'GET',
          path: '/api/v1/proposals',
          cookie: '__Secure-emdo.session_token=opaque-session-cookie',
        }),
      ).resolves.toBeUndefined();
    },
  );

  it('fails construction when the mandatory server scope resolver is absent', () => {
    expect(() =>
      createProductionAuthenticationBoundary({
        auth: {
          api: {
            getSession: async () => undefined,
            getActiveMember: async () => undefined,
          },
          handler: async () => new Response(null, { status: 204 }),
        },
        csrfProtector: createCsrfProtector(),
        invitationRedemptions: createInvitationRedemptionCoordinator(),
        publicOrigin: 'https://emdo.example',
        scopeResolver: undefined as never,
      }),
    ).toThrow(/scope resolver/iu);
  });

  it('does not issue a principal for an invalid server request identifier', async () => {
    let scopeCalls = 0;
    const boundary = createProductionAuthenticationBoundary({
      auth: {
        api: {
          getSession: async () => ({
            session: { id: SESSION_ID, userId: USER_ID },
            user: { id: USER_ID, emailVerified: true },
          }),
          getActiveMember: async () => ({
            id: MEMBERSHIP_ID,
            organizationId: HOUSEHOLD_ID,
            userId: USER_ID,
            role: 'owner',
          }),
        },
        handler: async () => new Response(null, { status: 204 }),
      },
      csrfProtector: createCsrfProtector(),
      invitationRedemptions: createInvitationRedemptionCoordinator(),
      publicOrigin: 'https://emdo.example',
      scopeResolver: {
        resolveActivePrincipalScope: async () => {
          scopeCalls += 1;
          return {
            collectionAuthorizationScopeFingerprint:
              COLLECTION_SCOPE_FINGERPRINT,
            householdId: HOUSEHOLD_ID,
            privateSpaceId: PRIVATE_SPACE_ID,
            role: 'owner',
            spaceAccessGrantId: SPACE_GRANT_ID,
          };
        },
      },
    });

    await expect(
      boundary.authenticate({
        requestId: 'client-selected-request-id',
        method: 'GET',
        path: '/api/v1/turns',
      }),
    ).resolves.toBeUndefined();
    expect(scopeCalls).toBe(0);
  });

  it('issues a secure session-bound CSRF cookie and verifies only exact-origin unsafe requests', async () => {
    const boundary = createProductionAuthenticationBoundary({
      auth: {
        api: {
          getSession: async () => undefined,
          getActiveMember: async () => undefined,
        },
        handler: async () => new Response(null, { status: 204 }),
      },
      csrfProtector: createCsrfProtector(),
      invitationRedemptions: createInvitationRedemptionCoordinator(),
      publicOrigin: 'https://emdo.example',
      scopeResolver: {
        resolveActivePrincipalScope: async () => undefined,
      },
    });
    const principal = {
      collectionAuthorizationScopeFingerprint: COLLECTION_SCOPE_FINGERPRINT,
      emailVerified: true as const,
      householdId: HOUSEHOLD_ID,
      role: 'owner' as const,
      sessionId: SESSION_ID,
      spaceAccessGrantId: SPACE_GRANT_ID,
      userId: USER_ID,
    };

    const issued = await boundary.issueMutationCsrf({
      principal,
      requestId: REQUEST_ID,
    });

    expect(issued.cookie).toBe(
      `emdo.csrf_token=${issued.token}; Path=/api/; Max-Age=600; Secure; HttpOnly; SameSite=Strict`,
    );
    await expect(
      boundary.verifyMutation({
        principal,
        requestId: REQUEST_ID,
        method: 'POST',
        path: '/api/v1/turns',
        origin: 'https://emdo.example',
        cookie: issued.cookie,
        csrfToken: issued.token,
      }),
    ).resolves.toBe(true);

    const invalidInputs = [
      { method: 'GET', origin: 'https://emdo.example', cookie: issued.cookie },
      {
        method: 'POST',
        origin: 'https://emdo.example/',
        cookie: issued.cookie,
      },
      {
        method: 'POST',
        origin: 'https://emdo.example',
        cookie: `${issued.cookie}; emdo.csrf_token=${issued.token}`,
      },
      {
        method: 'POST',
        origin: 'https://emdo.example.evil.test',
        cookie: issued.cookie,
      },
    ] as const;
    for (const invalid of invalidInputs) {
      await expect(
        boundary.verifyMutation({
          principal,
          requestId: REQUEST_ID,
          path: '/api/v1/turns',
          csrfToken: issued.token,
          ...invalid,
        }),
      ).resolves.toBe(false);
    }
    await expect(
      boundary.verifyMutation({
        principal: { ...principal, sessionId: MEMBERSHIP_ID },
        requestId: REQUEST_ID,
        method: 'POST',
        path: '/api/v1/turns',
        origin: 'https://emdo.example',
        cookie: issued.cookie,
        csrfToken: issued.token,
      }),
    ).resolves.toBe(false);
  });

  it('forwards only the bounded exact-origin Better Auth HTTP surface through the same runtime', async () => {
    const handledRequests: Request[] = [];
    const boundary = createProductionAuthenticationBoundary({
      auth: {
        api: {
          getSession: async () => undefined,
          getActiveMember: async () => undefined,
        },
        handler: async (request) => {
          handledRequests.push(request);
          return Response.json({ path: new URL(request.url).pathname });
        },
      },
      csrfProtector: createCsrfProtector(),
      invitationRedemptions: createInvitationRedemptionCoordinator(),
      publicOrigin: 'https://emdo.example',
      scopeResolver: {
        resolveActivePrincipalScope: async () => undefined,
      },
    });

    const response = await boundary.handleBrowserRequest({
      request: new Request('https://emdo.example/api/auth/get-session', {
        headers: {
          authorization: 'Bearer must-not-cross-the-browser-boundary',
          cookie: '__Secure-emdo.session_token=opaque',
          'x-emdo-edge-proxy': 'edge-proof-must-not-cross-the-browser-boundary',
          'x-forwarded-for': '2001:0db8:0000:0000:0000:0000:0000:0001',
          'x-upstream-secret': 'must-not-cross-the-browser-boundary',
        },
      }),
      requestId: REQUEST_ID,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      path: '/api/auth/get-session',
    });
    expect(handledRequests).toHaveLength(1);
    expect(handledRequests[0]?.headers.get('cookie')).toBe(
      '__Secure-emdo.session_token=opaque',
    );
    expect(handledRequests[0]?.headers.get('x-forwarded-for')).toBe(
      '2001:db8::1',
    );
    expect(handledRequests[0]?.headers.get('authorization')).toBeNull();
    expect(handledRequests[0]?.headers.get('x-emdo-edge-proxy')).toBeNull();
    expect(handledRequests[0]?.headers.get('x-upstream-secret')).toBeNull();

    for (const headers of [
      undefined,
      new Headers({
        'x-forwarded-for': '198.51.100.9, 203.0.113.8',
      }),
      new Headers({
        forwarded: 'for=198.51.100.9',
        'x-forwarded-for': '198.51.100.9',
      }),
      new Headers({
        'x-forwarded-for': '198.51.100.9',
        'x-real-ip': '198.51.100.9',
      }),
    ]) {
      await expect(
        boundary.handleBrowserRequest({
          request: new Request('https://emdo.example/api/auth/get-session', {
            headers,
          }),
          requestId: REQUEST_ID,
        }),
      ).rejects.toThrow(/Better Auth request boundary/iu);
    }

    for (const url of [
      'https://emdo.example.evil.test/api/auth/get-session',
      'https://emdo.example/api/private',
      'https://emdo.example/api/auth/list-sessions',
      'https://emdo.example/api/auth/get-session/',
    ]) {
      await expect(
        boundary.handleBrowserRequest({
          request: new Request(url),
          requestId: REQUEST_ID,
        }),
      ).rejects.toThrow(/Better Auth request boundary/iu);
    }
    await expect(
      boundary.handleBrowserRequest({
        request: new Request('https://emdo.example/api/auth/get-session', {
          method: 'POST',
        }),
        requestId: REQUEST_ID,
      }),
    ).rejects.toThrow(/Better Auth request boundary/iu);
    expect(handledRequests).toHaveLength(1);
  });

  it('uses a separate invitation CSRF context before atomic invite-only onboarding', async () => {
    const redemptionInputs: unknown[] = [];
    const boundary = createProductionAuthenticationBoundary({
      auth: {
        api: {
          getSession: async () => undefined,
          getActiveMember: async () => undefined,
        },
        handler: async () => new Response(null, { status: 204 }),
      },
      csrfProtector: createCsrfProtector(),
      invitationRedemptions: {
        redeem: async (input) => {
          redemptionInputs.push(input);
          return {
            status: 'provisioned' as const,
            result: {
              schemaVersion: 1 as const,
              userId: USER_ID,
              householdId: HOUSEHOLD_ID,
              role: 'member' as const,
              emailVerified: true as const,
            },
          };
        },
      },
      publicOrigin: 'https://emdo.example',
      scopeResolver: {
        resolveActivePrincipalScope: async () => undefined,
      },
    });
    const csrf = await boundary.issueInvitationCsrf({
      requestId: REQUEST_ID,
    });
    expect(csrf.cookie).toBe(
      `emdo.invitation_csrf=${csrf.token}; Path=/api/v1/auth/invitations/; Max-Age=600; Secure; HttpOnly; SameSite=Strict`,
    );
    const request = {
      schemaVersion: 1 as const,
      displayName: 'New Member',
      email: 'member@example.com',
      invitationId: MEMBERSHIP_ID,
      invitationToken: 'invitation-token-at-least-twenty-characters',
      password: 'correct horse battery staple',
    };

    await expect(
      boundary.redeemInvitation({
        request,
        origin: 'https://emdo.example',
        cookie: csrf.cookie,
        invitationCsrfToken: csrf.token,
        idempotencyKey: 'invitation:018f1f5e-2000-7000',
        requestId: REQUEST_ID,
        principal: undefined,
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      userId: USER_ID,
      householdId: HOUSEHOLD_ID,
      role: 'member',
      emailVerified: true,
    });
    expect(redemptionInputs).toEqual([
      {
        idempotencyKey: 'invitation:018f1f5e-2000-7000',
        request,
        requestId: REQUEST_ID,
      },
    ]);

    await expect(
      boundary.redeemInvitation({
        request,
        origin: 'https://emdo.example.evil.test',
        cookie: csrf.cookie,
        invitationCsrfToken: csrf.token,
        idempotencyKey: 'invitation:018f1f5e-2000-7001',
        requestId: REQUEST_ID,
        principal: undefined,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: 'invitation-csrf-invalid',
    });
    expect(redemptionInputs).toHaveLength(1);
  });

  it('maps invitation rejection and infrastructure failure to safe API problems', async () => {
    const createFailingBoundary = (
      failure: 'invitation-invalid' | 'onboarding-unavailable' | 'unexpected',
    ) =>
      createProductionAuthenticationBoundary({
        auth: {
          api: {
            getSession: async () => undefined,
            getActiveMember: async () => undefined,
          },
          handler: async () => new Response(null, { status: 204 }),
        },
        csrfProtector: createCsrfProtector(),
        invitationRedemptions: {
          redeem: async () => {
            if (failure === 'invitation-invalid') {
              return { status: 'invalid' as const };
            }
            throw new Error(
              failure === 'unexpected'
                ? 'database details'
                : 'sensitive infrastructure reason',
            );
          },
        },
        publicOrigin: 'https://emdo.example',
        scopeResolver: {
          resolveActivePrincipalScope: async () => undefined,
        },
      });
    const request = {
      schemaVersion: 1 as const,
      displayName: 'New Member',
      email: 'member@example.com',
      invitationId: MEMBERSHIP_ID,
      invitationToken: 'invitation-token-at-least-twenty-characters',
      password: 'correct horse battery staple',
    };

    for (const [failure, expected] of [
      ['invitation-invalid', { status: 400, code: 'invitation-invalid' }],
      [
        'onboarding-unavailable',
        { status: 503, code: 'invitation-onboarding-unavailable' },
      ],
      [
        'unexpected',
        { status: 503, code: 'invitation-onboarding-unavailable' },
      ],
    ] as const) {
      const boundary = createFailingBoundary(failure);
      const csrf = await boundary.issueInvitationCsrf({
        requestId: REQUEST_ID,
      });
      let caught: unknown;
      try {
        await boundary.redeemInvitation({
          request,
          origin: 'https://emdo.example',
          cookie: csrf.cookie,
          invitationCsrfToken: csrf.token,
          idempotencyKey: `invitation:018f1f5e-2000-${failure}`,
          requestId: REQUEST_ID,
          principal: undefined,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject(expected);
      expect(caught).not.toMatchObject({
        message: expect.stringContaining('sensitive'),
      });
      expect(caught).not.toMatchObject({
        message: expect.stringContaining('database details'),
      });
    }
  });

  it('uses independent immutable credential snapshots for session and active-member reads', async () => {
    let activeMemberCookie: string | null = null;
    const boundary = createProductionAuthenticationBoundary({
      auth: {
        api: {
          getSession: async ({ headers }) => {
            headers.set('cookie', '__Secure-emdo.session_token=mutated');
            return {
              session: { id: SESSION_ID, userId: USER_ID },
              user: { id: USER_ID, emailVerified: true },
            };
          },
          getActiveMember: async ({ headers }) => {
            activeMemberCookie = headers.get('cookie');
            return {
              id: MEMBERSHIP_ID,
              organizationId: HOUSEHOLD_ID,
              userId: USER_ID,
              role: 'member',
            };
          },
        },
        handler: async () => new Response(null, { status: 204 }),
      },
      csrfProtector: createCsrfProtector(),
      invitationRedemptions: createInvitationRedemptionCoordinator(),
      publicOrigin: 'https://emdo.example',
      scopeResolver: {
        resolveActivePrincipalScope: async () => ({
          collectionAuthorizationScopeFingerprint: COLLECTION_SCOPE_FINGERPRINT,
          householdId: HOUSEHOLD_ID,
          privateSpaceId: PRIVATE_SPACE_ID,
          role: 'member',
          spaceAccessGrantId: SPACE_GRANT_ID,
        }),
      },
    });

    await boundary.authenticate({
      requestId: REQUEST_ID,
      method: 'GET',
      path: '/api/v1/turns',
      cookie: '__Secure-emdo.session_token=original',
    });

    expect(activeMemberCookie).toBe('__Secure-emdo.session_token=original');
  });

  it('returns an exact durable invitation replay without any API-side onboarding step', async () => {
    const redemptionInputs: unknown[] = [];
    const boundary = createProductionAuthenticationBoundary({
      auth: {
        api: {
          getSession: async () => undefined,
          getActiveMember: async () => undefined,
        },
        handler: async () => new Response(null, { status: 204 }),
      },
      csrfProtector: createCsrfProtector(),
      invitationRedemptions: {
        redeem: async (input: unknown) => {
          redemptionInputs.push(input);
          return {
            status: 'replay',
            result: {
              schemaVersion: 1,
              userId: USER_ID,
              householdId: HOUSEHOLD_ID,
              role: 'member',
              emailVerified: true,
            },
          };
        },
      },
      publicOrigin: 'https://emdo.example',
      scopeResolver: {
        resolveActivePrincipalScope: async () => undefined,
      },
    });
    const csrf = await boundary.issueInvitationCsrf({ requestId: REQUEST_ID });

    await expect(
      boundary.redeemInvitation({
        request: {
          schemaVersion: 1,
          displayName: 'New Member',
          email: 'member@example.com',
          invitationId: MEMBERSHIP_ID,
          invitationToken: 'invitation-token-at-least-twenty-characters',
          password: 'correct horse battery staple',
        },
        origin: 'https://emdo.example',
        cookie: csrf.cookie,
        invitationCsrfToken: csrf.token,
        idempotencyKey: 'invitation:018f1f5e-2000-replay',
        requestId: REQUEST_ID,
        principal: undefined,
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      userId: USER_ID,
      householdId: HOUSEHOLD_ID,
      role: 'member',
      emailVerified: true,
    });
    expect(redemptionInputs).toEqual([
      {
        idempotencyKey: 'invitation:018f1f5e-2000-replay',
        request: {
          schemaVersion: 1,
          displayName: 'New Member',
          email: 'member@example.com',
          invitationId: MEMBERSHIP_ID,
          invitationToken: 'invitation-token-at-least-twenty-characters',
          password: 'correct horse battery staple',
        },
        requestId: REQUEST_ID,
      },
    ]);
  });

  it('preserves the durable coordinator in-progress result for a racing request', async () => {
    let redemptionCalls = 0;
    let signalRedemptionStarted: (() => void) | undefined;
    const redemptionStarted = new Promise<void>((resolve) => {
      signalRedemptionStarted = resolve;
    });
    let allowRedemptionToFinish: (() => void) | undefined;
    const redemptionMayFinish = new Promise<void>((resolve) => {
      allowRedemptionToFinish = resolve;
    });
    const boundary = createProductionAuthenticationBoundary({
      auth: {
        api: {
          getSession: async () => undefined,
          getActiveMember: async () => undefined,
        },
        handler: async () => new Response(null, { status: 204 }),
      },
      csrfProtector: createCsrfProtector(),
      invitationRedemptions: {
        redeem: async () => {
          redemptionCalls += 1;
          if (redemptionCalls > 1) {
            return { status: 'in-progress' as const, retryAfterMs: 250 };
          }
          signalRedemptionStarted?.();
          await redemptionMayFinish;
          return {
            status: 'provisioned' as const,
            result: {
              schemaVersion: 1 as const,
              userId: USER_ID,
              householdId: HOUSEHOLD_ID,
              role: 'member' as const,
              emailVerified: true as const,
            },
          };
        },
      },
      publicOrigin: 'https://emdo.example',
      scopeResolver: {
        resolveActivePrincipalScope: async () => undefined,
      },
    });
    const csrf = await boundary.issueInvitationCsrf({ requestId: REQUEST_ID });
    const redemption = {
      request: {
        schemaVersion: 1 as const,
        displayName: 'New Member',
        email: 'member@example.com',
        invitationId: MEMBERSHIP_ID,
        invitationToken: 'invitation-token-at-least-twenty-characters',
        password: 'correct horse battery staple',
      },
      origin: 'https://emdo.example',
      cookie: csrf.cookie,
      invitationCsrfToken: csrf.token,
      idempotencyKey: 'invitation:018f1f5e-2000-race',
      requestId: REQUEST_ID,
      principal: undefined,
    };

    const ownerRequest = boundary.redeemInvitation(redemption);
    await redemptionStarted;
    await expect(boundary.redeemInvitation(redemption)).rejects.toMatchObject({
      status: 409,
      code: 'invitation-onboarding-in-progress',
      extensions: { retryAfterMs: 250 },
    });
    allowRedemptionToFinish?.();
    await expect(ownerRequest).resolves.toMatchObject({ userId: USER_ID });
    expect(redemptionCalls).toBe(2);
  });

  it('maps durable rejection and infrastructure failure without API-side recovery writes', async () => {
    for (const failure of [
      'invitation-invalid',
      'onboarding-unavailable',
    ] as const) {
      const boundary = createProductionAuthenticationBoundary({
        auth: {
          api: {
            getSession: async () => undefined,
            getActiveMember: async () => undefined,
          },
          handler: async () => new Response(null, { status: 204 }),
        },
        csrfProtector: createCsrfProtector(),
        invitationRedemptions: {
          redeem: async () => {
            if (failure === 'invitation-invalid') {
              return { status: 'invalid' as const };
            }
            throw new Error('safe test failure');
          },
        },
        publicOrigin: 'https://emdo.example',
        scopeResolver: {
          resolveActivePrincipalScope: async () => undefined,
        },
      });
      const csrf = await boundary.issueInvitationCsrf({
        requestId: REQUEST_ID,
      });

      await expect(
        boundary.redeemInvitation({
          request: {
            schemaVersion: 1,
            displayName: 'New Member',
            email: 'member@example.com',
            invitationId: MEMBERSHIP_ID,
            invitationToken: 'invitation-token-at-least-twenty-characters',
            password: 'correct horse battery staple',
          },
          origin: 'https://emdo.example',
          cookie: csrf.cookie,
          invitationCsrfToken: csrf.token,
          idempotencyKey: `invitation:018f1f5e-2000-${failure}`,
          requestId: REQUEST_ID,
          principal: undefined,
        }),
      ).rejects.toMatchObject({
        code:
          failure === 'invitation-invalid'
            ? 'invitation-invalid'
            : 'invitation-onboarding-unavailable',
      });
    }
  });

  it('delegates invitation onboarding to one atomic durable redemption command', async () => {
    const redemptionInputs: unknown[] = [];
    const boundary = createProductionAuthenticationBoundary({
      auth: {
        api: {
          getSession: async () => undefined,
          getActiveMember: async () => undefined,
        },
        handler: async () => new Response(null, { status: 204 }),
      },
      csrfProtector: createCsrfProtector(),
      invitationRedemptions: {
        redeem: async (input: unknown) => {
          redemptionInputs.push(input);
          return {
            status: 'provisioned' as const,
            result: {
              schemaVersion: 1 as const,
              userId: USER_ID,
              householdId: HOUSEHOLD_ID,
              role: 'member' as const,
              emailVerified: true as const,
            },
          };
        },
      },
      publicOrigin: 'https://emdo.example',
      scopeResolver: {
        resolveActivePrincipalScope: async () => undefined,
      },
    });
    const csrf = await boundary.issueInvitationCsrf({ requestId: REQUEST_ID });
    const request = {
      schemaVersion: 1 as const,
      displayName: 'New Member',
      email: 'member@example.com',
      invitationId: MEMBERSHIP_ID,
      invitationToken: 'invitation-token-at-least-twenty-characters',
      password: 'correct horse battery staple',
    };

    await expect(
      boundary.redeemInvitation({
        request,
        origin: 'https://emdo.example',
        cookie: csrf.cookie,
        invitationCsrfToken: csrf.token,
        idempotencyKey: 'invitation:018f1f5e-atomic-command',
        requestId: REQUEST_ID,
        principal: undefined,
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      userId: USER_ID,
      householdId: HOUSEHOLD_ID,
      role: 'member',
      emailVerified: true,
    });
    expect(redemptionInputs).toEqual([
      {
        idempotencyKey: 'invitation:018f1f5e-atomic-command',
        request,
        requestId: REQUEST_ID,
      },
    ]);
  });
});

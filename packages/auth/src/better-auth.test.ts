import { createHash } from 'node:crypto';
import type {
  BetterAuthOptions,
  DBAdapter,
  DBAdapterInstance,
  DBTransactionAdapter,
} from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { organization } from 'better-auth/plugins';
import { describe, expect, it, vi } from 'vitest';

import {
  createEmdoBetterAuth,
  EmdoRotatingSessionBoundary,
  InvitedAccountOnboardingService,
  type BetterAuthOrganizationClaimBridge,
  type InvitedAccountProvisioner,
} from './better-auth.js';
import {
  InMemorySessionRepository,
  RotatingSessionService,
} from './session.js';

const WEEK_SECONDS = 7 * 24 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;

const emptyAuthStorage = () => ({
  account: [],
  invitation: [],
  member: [],
  organization: [],
  passkey: [],
  rateLimit: [],
  session: [],
  user: [],
  verification: [],
});

const createHarness = () => {
  const captured: {
    auth?: Record<string, unknown>;
    organization?: Record<string, unknown>;
    passkey?: Record<string, unknown>;
  } = {};
  const authInstance = {
    api: { getSession: vi.fn(async () => null) },
    handler: vi.fn(async () => new Response(null, { status: 404 })),
    kind: 'fake-auth-instance',
  };
  const database = memoryAdapter(emptyAuthStorage());
  const organizationClaimBridge: BetterAuthOrganizationClaimBridge = {
    database,
    run: async <Result>(
      options: BetterAuthOptions,
      work: (transaction: {
        adapter: DBTransactionAdapter;
        revalidateAndActivateClaims(identity: {
          userId: string;
          sessionId: string;
        }): Promise<void>;
      }) => Promise<Result>,
    ) =>
      database(options).transaction((adapter) =>
        work({ revalidateAndActivateClaims: async () => undefined, adapter }),
      ),
  };
  const sendVerificationEmail = vi.fn(async () => undefined);
  const sendPasswordResetEmail = vi.fn(async () => undefined);
  const sendInvitationEmail = vi.fn(async () => undefined);

  const result = createEmdoBetterAuth(
    {
      appName: 'EMDO',
      baseURL: 'https://assistant.emdo.test',
      googleIdentity: {
        clientId: 'identity-client-id',
        clientSecret: 'identity-client-secret',
      },
      organizationClaimBridge,
      secret: 'test-secret-that-is-at-least-thirty-two-bytes',
      sendInvitationEmail,
      sendPasswordResetEmail,
      sendVerificationEmail,
      trustedOrigins: [
        'https://assistant.emdo.test',
        'https://household.emdo.test',
      ],
    },
    {
      authFactory: (options) => {
        captured.auth = options as unknown as Record<string, unknown>;
        return authInstance;
      },
      organizationFactory: (options) => {
        captured.organization = options as unknown as Record<string, unknown>;
        return { id: 'organization' } as never;
      },
      passkeyFactory: (options) => {
        captured.passkey = options as unknown as Record<string, unknown>;
        return { id: 'passkey' } as never;
      },
    },
  );

  return {
    authInstance,
    captured,
    database,
    result,
    sendInvitationEmail,
    sendPasswordResetEmail,
    sendVerificationEmail,
  };
};

const createRealAuth = () =>
  (() => {
    const database = memoryAdapter(emptyAuthStorage());
    return createEmdoBetterAuth({
      appName: 'EMDO',
      baseURL: 'https://assistant.emdo.test',
      googleIdentity: {
        clientId: 'identity-client-id',
        clientSecret: 'identity-client-secret',
      },
      organizationClaimBridge: {
        database,
        run: async <Result>(
          options: BetterAuthOptions,
          work: (transaction: {
            adapter: DBTransactionAdapter;
            revalidateAndActivateClaims(identity: {
              userId: string;
              sessionId: string;
            }): Promise<void>;
          }) => Promise<Result>,
        ) =>
          database(options).transaction((adapter) =>
            work({
              adapter,
              revalidateAndActivateClaims: async () => undefined,
            }),
          ),
      },
      secret: 'test-secret-that-is-at-least-thirty-two-bytes',
      sendInvitationEmail: async () => undefined,
      sendPasswordResetEmail: async () => undefined,
      sendVerificationEmail: async () => undefined,
      trustedOrigins: ['https://assistant.emdo.test'],
    });
  })();

describe('createEmdoBetterAuth', () => {
  it('creates verified invite-only email/password auth with server-backed rolling sessions', () => {
    const { authInstance, captured, database, result } = createHarness();

    expect(result).not.toBe(authInstance);
    expect(result).toMatchObject({ kind: 'fake-auth-instance' });
    expect(captured.auth?.database).not.toBe(database);
    expect(captured.auth?.database).toBeTypeOf('function');
    expect(captured.auth?.emailAndPassword).toMatchObject({
      autoSignIn: false,
      disableSignUp: true,
      enabled: true,
      maxPasswordLength: 128,
      minPasswordLength: 12,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
    });
    expect(captured.auth?.emailVerification).toMatchObject({
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
      sendOnSignIn: true,
      sendOnSignUp: false,
    });
    expect(captured.auth?.session).toEqual({
      cookieCache: { enabled: false },
      disableSessionRefresh: false,
      expiresIn: WEEK_SECONDS,
      freshAge: 5 * 60,
      storeSessionInDatabase: true,
      updateAge: DAY_SECONDS,
    });
  });

  it('limits Google sign-in to a separate identity-only grant', () => {
    const { captured } = createHarness();
    const providers = captured.auth?.socialProviders as Record<
      string,
      Record<string, unknown>
    >;

    expect(providers.google).toMatchObject({
      clientId: 'identity-client-id',
      clientSecret: 'identity-client-secret',
      disableDefaultScope: true,
      disableIdTokenSignIn: true,
      disableImplicitSignUp: true,
      disableSignUp: true,
      scope: ['openid', 'email', 'profile'],
    });
    expect(providers.google).not.toHaveProperty('accessType');
    expect(JSON.stringify(providers.google)).not.toContain('/auth/calendar');
    expect(captured.auth?.account).toMatchObject({
      encryptOAuthTokens: true,
      storeStateStrategy: 'database',
      accountLinking: {
        allowDifferentEmails: false,
        disableImplicitLinking: true,
        enabled: true,
      },
    });
  });

  it('requires authenticated passkey registration at the configured HTTPS origin', () => {
    const { captured } = createHarness();

    expect(captured.passkey).toEqual({
      origin: 'https://assistant.emdo.test',
      registration: { requireSession: true },
      rpID: 'assistant.emdo.test',
      rpName: 'EMDO',
    });
  });

  it('restricts households to owner/member roles and seven-day verified invitations', () => {
    const { captured, sendInvitationEmail } = createHarness();

    expect(captured.organization).toMatchObject({
      allowUserToCreateOrganization: false,
      cancelPendingInvitationsOnReInvite: false,
      creatorRole: 'owner',
      disableOrganizationDeletion: true,
      invitationExpiresIn: WEEK_SECONDS,
      requireEmailVerificationOnInvitation: true,
      sendInvitationEmail,
    });
    expect(
      Object.keys(captured.organization?.roles as Record<string, unknown>),
    ).toEqual(['owner', 'member']);
    expect(captured.organization?.dynamicAccessControl).toEqual({
      enabled: false,
    });
  });

  it('maps Better Auth organization reads onto the canonical household tables', () => {
    const { captured } = createHarness();

    expect(captured.organization?.schema).toEqual({
      invitation: {},
      member: {},
      organization: {},
      session: {
        fields: { activeOrganizationId: 'activeHouseholdId' },
      },
    });
  });

  it('fails closed for every Better Auth organization mutation hook', async () => {
    const { captured } = createHarness();
    const hooks = captured.organization?.organizationHooks as Record<
      string,
      (input: Record<string, unknown>) => Promise<void>
    >;
    const mutationInputs = {
      beforeAcceptInvitation: {
        invitation: { role: 'member' },
      },
      beforeAddMember: { member: { role: 'member' } },
      beforeCancelInvitation: {},
      beforeCreateInvitation: {
        invitation: { role: 'member' },
      },
      beforeCreateOrganization: {},
      beforeDeleteOrganization: {},
      beforeRejectInvitation: {},
      beforeRemoveMember: {},
      beforeUpdateMemberRole: { newRole: 'member' },
      beforeUpdateOrganization: {},
    } as const;

    expect(Object.keys(hooks).sort()).toEqual(
      Object.keys(mutationInputs).sort(),
    );
    for (const [hookName, input] of Object.entries(mutationInputs)) {
      await expect(hooks[hookName]?.(input)).rejects.toThrow(
        /canonical household writer/i,
      );
    }
  });

  it('disables organization write routes while retaining reads and active-household selection', () => {
    const { captured } = createHarness();
    const disabledPaths = captured.auth?.disabledPaths as string[];

    expect(disabledPaths).toEqual([
      '/organization/accept-invitation',
      '/organization/cancel-invitation',
      '/organization/create',
      '/organization/delete',
      '/organization/get-invitation',
      '/organization/invite-member',
      '/organization/leave',
      '/organization/list-user-invitations',
      '/organization/reject-invitation',
      '/organization/remove-member',
      '/organization/update',
      '/organization/update-member-role',
    ]);
    expect(disabledPaths).not.toContain('/organization/set-active');
    expect(disabledPaths).not.toContain('/organization/list');
    expect(disabledPaths).not.toContain('/organization/get-full-organization');
  });

  it('classifies every real Better Auth organization HTTP endpoint as claimed or disabled', () => {
    const { captured } = createHarness();
    const plugin = organization(
      captured.organization as NonNullable<Parameters<typeof organization>[0]>,
    );
    const actualPaths = Object.values(plugin.endpoints)
      .map((endpoint) => (endpoint as { path?: unknown }).path)
      .filter(
        (path): path is string =>
          typeof path === 'string' && path.startsWith('/organization/'),
      )
      .sort();

    expect(actualPaths).toEqual(
      [
        '/organization/accept-invitation',
        '/organization/cancel-invitation',
        '/organization/check-slug',
        '/organization/create',
        '/organization/delete',
        '/organization/get-active-member',
        '/organization/get-active-member-role',
        '/organization/get-full-organization',
        '/organization/get-invitation',
        '/organization/has-permission',
        '/organization/invite-member',
        '/organization/leave',
        '/organization/list',
        '/organization/list-invitations',
        '/organization/list-members',
        '/organization/list-user-invitations',
        '/organization/reject-invitation',
        '/organization/remove-member',
        '/organization/set-active',
        '/organization/update',
        '/organization/update-member-role',
      ].sort(),
    );
  });

  it('rejects Better Auth built-in admin through every membership role mutation hook', async () => {
    const { captured } = createHarness();
    const hooks = captured.organization?.organizationHooks as {
      beforeAcceptInvitation(input: unknown): Promise<void>;
      beforeAddMember(input: unknown): Promise<void>;
      beforeCreateInvitation(input: unknown): Promise<void>;
      beforeUpdateMemberRole(input: unknown): Promise<void>;
    };

    await expect(
      hooks.beforeCreateInvitation({ invitation: { role: 'admin' } }),
    ).rejects.toThrow(/owner or member/i);
    await expect(
      hooks.beforeAcceptInvitation({ invitation: { role: 'admin' } }),
    ).rejects.toThrow(/owner or member/i);
    await expect(
      hooks.beforeAddMember({ member: { role: 'admin' } }),
    ).rejects.toThrow(/owner or member/i);
    await expect(
      hooks.beforeUpdateMemberRole({ newRole: 'admin' }),
    ).rejects.toThrow(/owner or member/i);
  });

  it('keeps CSRF/origin checks enabled, pins origins, and stores rate limits in the database', () => {
    const { captured } = createHarness();

    expect(captured.auth).toMatchObject({
      basePath: '/api/auth',
      baseURL: 'https://assistant.emdo.test',
      rateLimit: { enabled: true, storage: 'database' },
      trustedOrigins: [
        'https://assistant.emdo.test',
        'https://household.emdo.test',
      ],
    });
    expect(captured.auth?.advanced).toMatchObject({
      cookiePrefix: 'emdo',
      database: { generateId: 'uuid' },
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
      },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      useSecureCookies: true,
    });
  });

  it('fails startup when Better Auth environment origins broaden the allowlist', () => {
    vi.stubEnv(
      'BETTER_AUTH_TRUSTED_ORIGINS',
      'https://assistant.emdo.test,https://attacker.example',
    );
    try {
      expect(() => createHarness()).toThrow(/BETTER_AUTH_TRUSTED_ORIGINS/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('uses the real Better Auth 1.6.26 route to refuse public email signup', async () => {
    const auth = createRealAuth();
    const response = await auth.handler(
      new Request('https://assistant.emdo.test/api/auth/sign-up/email', {
        body: JSON.stringify({
          email: 'public@example.com',
          name: 'Public User',
          password: 'a-strong-password',
        }),
        headers: {
          'content-type': 'application/json',
          origin: 'https://assistant.emdo.test',
        },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED',
    });
  });

  it('rejects direct Better Auth organization writer dispatch before repository access', async () => {
    const auth = createRealAuth();
    const organizationApi = auth.api as unknown as {
      leaveOrganization(input: {
        body: { organizationId: string };
        headers: Headers;
      }): Promise<unknown>;
    };

    await expect(
      organizationApi.leaveOrganization({
        body: { organizationId: 'household-1' },
        headers: new Headers({ origin: 'https://assistant.emdo.test' }),
      }),
    ).rejects.toThrow(/canonical household writer/i);
  });

  it('rejects Better Auth recipient invitation APIs in favor of canonical onboarding', async () => {
    const auth = createRealAuth();
    const organizationApi = auth.api as unknown as {
      getInvitation(input: {
        headers: Headers;
        query: { id: string };
      }): Promise<unknown>;
      listUserInvitations(input: { headers: Headers }): Promise<unknown>;
    };

    await expect(
      organizationApi.getInvitation({
        headers: new Headers(),
        query: { id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004' },
      }),
    ).rejects.toThrow(/canonical invitation onboarding/i);
    await expect(
      organizationApi.listUserInvitations({ headers: new Headers() }),
    ).rejects.toThrow(/canonical invitation onboarding/i);
  });

  it('returns not found for disabled Better Auth organization mutation routes', async () => {
    const auth = createRealAuth();
    const response = await auth.handler(
      new Request('https://assistant.emdo.test/api/auth/organization/leave', {
        body: JSON.stringify({ organizationId: 'household-1' }),
        headers: {
          'content-type': 'application/json',
          origin: 'https://assistant.emdo.test',
        },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(404);
  });

  it('keeps Better Auth organization reads and active-household selection registered', async () => {
    const auth = createRealAuth();
    const [readResponse, selectionResponse] = await Promise.all([
      auth.handler(
        new Request('https://assistant.emdo.test/api/auth/organization/list'),
      ),
      auth.handler(
        new Request(
          'https://assistant.emdo.test/api/auth/organization/set-active',
          {
            body: JSON.stringify({ organizationId: null }),
            headers: {
              'content-type': 'application/json',
              origin: 'https://assistant.emdo.test',
            },
            method: 'POST',
          },
        ),
      ),
    ]);

    expect(readResponse.status).toBe(401);
    expect(selectionResponse.status).toBe(401);
  });

  it('binds verified-session lookup, SET LOCAL, and organization reads to one adapter transaction', async () => {
    const userId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001';
    const sessionId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002';
    const householdId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003';
    const now = new Date('2026-08-09T18:00:00.000Z');
    const storage: Record<string, Record<string, unknown>[]> = {
      ...emptyAuthStorage(),
      organization: [
        {
          createdAt: now,
          id: householdId,
          logo: null,
          metadata: null,
          name: 'Home',
          slug: 'home',
        },
      ],
      session: [
        {
          activeHouseholdId: null,
          createdAt: now,
          expiresAt: new Date('2026-08-16T18:00:00.000Z'),
          id: sessionId,
          ipAddress: null,
          token: 'verified-session-token',
          updatedAt: now,
          userAgent: null,
          userId,
        },
      ],
    };
    const events: string[] = [];
    const rawDatabase = memoryAdapter(storage);
    const instrumentAdapter = <
      Adapter extends DBAdapter | DBTransactionAdapter,
    >(
      adapter: Adapter,
      scope: string,
    ): Adapter =>
      new Proxy(adapter, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (
            typeof property === 'string' &&
            ['count', 'findMany', 'findOne'].includes(property) &&
            typeof value === 'function'
          ) {
            return async (input: { model: string }) => {
              events.push(`${scope}:${input.model}`);
              return Reflect.apply(value, target, [input]);
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const database: DBAdapterInstance = (options) =>
      instrumentAdapter(rawDatabase(options), 'unscoped');
    const organizationClaimBridge: BetterAuthOrganizationClaimBridge = {
      database,
      run: async <Result>(
        options: BetterAuthOptions,
        work: (transaction: {
          adapter: DBTransactionAdapter;
          revalidateAndActivateClaims(identity: {
            userId: string;
            sessionId: string;
          }): Promise<void>;
        }) => Promise<Result>,
      ) =>
        rawDatabase(options).transaction(async (adapter) => {
          events.push('begin');
          return work({
            revalidateAndActivateClaims: async (identity) => {
              events.push(`set-local:${identity.userId}:${identity.sessionId}`);
            },
            adapter: instrumentAdapter(adapter, 'transaction'),
          });
        }),
    };
    let runtimeAdapter: DBAdapter | undefined;

    const auth = createEmdoBetterAuth(
      {
        appName: 'EMDO',
        baseURL: 'https://assistant.emdo.test',
        googleIdentity: {
          clientId: 'identity-client-id',
          clientSecret: 'identity-client-secret',
        },
        organizationClaimBridge,
        secret: 'test-secret-that-is-at-least-thirty-two-bytes',
        sendInvitationEmail: async () => undefined,
        sendPasswordResetEmail: async () => undefined,
        sendVerificationEmail: async () => undefined,
        trustedOrigins: ['https://assistant.emdo.test'],
      },
      {
        authFactory: (options) => {
          runtimeAdapter = (options.database as DBAdapterInstance)(options);
          return {
            api: {
              getSession: async () => {
                const session = await runtimeAdapter?.findOne({
                  model: 'session',
                  where: [{ field: 'id', value: sessionId }],
                });
                expect(session).not.toBeNull();
                return {
                  session: { id: sessionId, userId },
                  user: { emailVerified: true, id: userId },
                };
              },
              listOrganizations: async (input: { headers: Headers }) => {
                void input;
                return runtimeAdapter?.findMany({ model: 'organization' });
              },
            },
            handler: async (request: Request) => {
              void request;
              const households = await runtimeAdapter?.findMany({
                model: 'organization',
              });
              return Response.json(households);
            },
          };
        },
        organizationFactory: (options) => organization(options),
        passkeyFactory: () => ({ id: 'passkey' }) as never,
      },
    );

    const response = await auth.handler(
      new Request('https://assistant.emdo.test/api/auth/organization/list'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({ id: householdId }),
    ]);
    expect(events).toEqual([
      'begin',
      'transaction:session',
      `set-local:${userId}:${sessionId}`,
      'transaction:organization',
    ]);

    events.length = 0;
    await expect(
      auth.api.listOrganizations({ headers: new Headers() }),
    ).resolves.toEqual([expect.objectContaining({ id: householdId })]);
    expect(events).toEqual([
      'begin',
      'transaction:session',
      `set-local:${userId}:${sessionId}`,
      'transaction:organization',
    ]);

    expect(() => runtimeAdapter?.findMany({ model: 'organization' })).toThrow(
      /verified session claim/i,
    );
    expect(() =>
      runtimeAdapter?.create({
        data: { name: 'Bypass', slug: 'bypass' },
        model: 'organization',
      }),
    ).toThrow(/canonical household writer/i);
  });

  it('captures the validated transaction runner before serving requests', async () => {
    const userId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001';
    const sessionId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002';
    const database = memoryAdapter(emptyAuthStorage());
    let originalRunCalls = 0;
    const originalRun: BetterAuthOrganizationClaimBridge['run'] = async <
      Result,
    >(
      options: BetterAuthOptions,
      work: (transaction: {
        adapter: DBTransactionAdapter;
        revalidateAndActivateClaims(identity: {
          userId: string;
          sessionId: string;
        }): Promise<void>;
      }) => Promise<Result>,
    ) => {
      originalRunCalls += 1;
      return database(options).transaction((adapter) =>
        work({ revalidateAndActivateClaims: async () => undefined, adapter }),
      );
    };
    const replacementRun = vi.fn(async () => {
      throw new Error('replacement runner must never execute');
    });
    const organizationClaimBridge: BetterAuthOrganizationClaimBridge = {
      database,
      run: originalRun,
    };
    const auth = createEmdoBetterAuth(
      {
        appName: 'EMDO',
        baseURL: 'https://assistant.emdo.test',
        googleIdentity: {
          clientId: 'identity-client-id',
          clientSecret: 'identity-client-secret',
        },
        organizationClaimBridge,
        secret: 'test-secret-that-is-at-least-thirty-two-bytes',
        sendInvitationEmail: async () => undefined,
        sendPasswordResetEmail: async () => undefined,
        sendVerificationEmail: async () => undefined,
        trustedOrigins: ['https://assistant.emdo.test'],
      },
      {
        authFactory: () => ({
          api: {
            getSession: async () => ({
              session: { id: sessionId, userId },
              user: { emailVerified: true, id: userId },
            }),
          },
          handler: async (request: Request) => {
            void request;
            return Response.json([]);
          },
        }),
        organizationFactory: (options) => organization(options),
        passkeyFactory: () => ({ id: 'passkey' }) as never,
      },
    );

    (organizationClaimBridge as { run: unknown }).run = replacementRun;

    await expect(
      auth.handler(
        new Request('https://assistant.emdo.test/api/auth/organization/list'),
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(originalRunCalls).toBe(1);
    expect(replacementRun).not.toHaveBeenCalled();
  });

  it('does not establish an organization claim for an unverified session', async () => {
    const revalidateAndActivateClaims = vi.fn(async () => undefined);
    const database = memoryAdapter(emptyAuthStorage());
    const organizationClaimBridge = {
      database,
      run: vi.fn(
        async <Result>(
          _options: BetterAuthOptions,
          work: (transaction: {
            adapter: DBTransactionAdapter;
            revalidateAndActivateClaims: typeof revalidateAndActivateClaims;
          }) => Promise<Result>,
        ) =>
          database({} as BetterAuthOptions).transaction((adapter) =>
            work({ adapter, revalidateAndActivateClaims }),
          ),
      ),
    };
    const handler = vi.fn(async (request: Request) => {
      void request;
      return Response.json([]);
    });
    const auth = createEmdoBetterAuth(
      {
        appName: 'EMDO',
        baseURL: 'https://assistant.emdo.test',
        googleIdentity: {
          clientId: 'identity-client-id',
          clientSecret: 'identity-client-secret',
        },
        organizationClaimBridge: organizationClaimBridge as never,
        secret: 'test-secret-that-is-at-least-thirty-two-bytes',
        sendInvitationEmail: async () => undefined,
        sendPasswordResetEmail: async () => undefined,
        sendVerificationEmail: async () => undefined,
        trustedOrigins: ['https://assistant.emdo.test'],
      },
      {
        authFactory: () => ({
          api: {
            getSession: async () => ({
              session: {
                id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002',
                userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
              },
              user: {
                emailVerified: false,
                id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
              },
            }),
          },
          handler,
        }),
        organizationFactory: (options) => organization(options),
        passkeyFactory: () => ({ id: 'passkey' }) as never,
      },
    );

    const response = await auth.handler(
      new Request('https://assistant.emdo.test/api/auth/organization/list'),
    );

    expect(response.status).toBe(401);
    expect(organizationClaimBridge.run).toHaveBeenCalledOnce();
    expect(revalidateAndActivateClaims).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('forwards only the injected mail adapters into Better Auth callbacks', () => {
    const {
      captured,
      sendInvitationEmail,
      sendPasswordResetEmail,
      sendVerificationEmail,
    } = createHarness();
    const emailAndPassword = captured.auth?.emailAndPassword as Record<
      string,
      unknown
    >;
    const emailVerification = captured.auth?.emailVerification as Record<
      string,
      unknown
    >;

    expect(emailAndPassword.sendResetPassword).toBe(sendPasswordResetEmail);
    expect(emailVerification.sendVerificationEmail).toBe(sendVerificationEmail);
    expect(captured.organization?.sendInvitationEmail).toBe(
      sendInvitationEmail,
    );
  });

  it.each([
    {
      change: { baseURL: 'http://assistant.emdo.test' },
      label: 'an insecure production base URL',
    },
    {
      change: { trustedOrigins: ['https://*.emdo.test'] },
      label: 'a wildcard trusted origin',
    },
    {
      change: { trustedOrigins: ['https://assistant.emdo.test/path'] },
      label: 'a trusted origin containing a path',
    },
    {
      change: { secret: 'too-short' },
      label: 'a short secret',
    },
    {
      change: { secret: ' '.repeat(32) },
      label: 'a whitespace-only secret',
    },
    {
      change: { googleIdentity: { clientId: '', clientSecret: 'secret' } },
      label: 'empty Google identity credentials',
    },
  ])('rejects $label before invoking Better Auth', ({ change }) => {
    const authFactory = vi.fn();
    const database = memoryAdapter(emptyAuthStorage());

    expect(() =>
      createEmdoBetterAuth(
        {
          appName: 'EMDO',
          baseURL: 'https://assistant.emdo.test',
          googleIdentity: {
            clientId: 'identity-client-id',
            clientSecret: 'identity-client-secret',
          },
          organizationClaimBridge: {
            database,
            run: async <Result>(
              options: BetterAuthOptions,
              work: (transaction: {
                adapter: DBTransactionAdapter;
                revalidateAndActivateClaims(identity: {
                  userId: string;
                  sessionId: string;
                }): Promise<void>;
              }) => Promise<Result>,
            ) =>
              database(options).transaction((adapter) =>
                work({
                  adapter,
                  revalidateAndActivateClaims: async () => undefined,
                }),
              ),
          },
          secret: 'test-secret-that-is-at-least-thirty-two-bytes',
          sendInvitationEmail: vi.fn(async () => undefined),
          sendPasswordResetEmail: vi.fn(async () => undefined),
          sendVerificationEmail: vi.fn(async () => undefined),
          trustedOrigins: ['https://assistant.emdo.test'],
          ...change,
        },
        {
          authFactory,
          organizationFactory: () => ({ id: 'organization' }) as never,
          passkeyFactory: () => ({ id: 'passkey' }) as never,
        },
      ),
    ).toThrow();
    expect(authFactory).not.toHaveBeenCalled();
  });
});

describe('InvitedAccountOnboardingService', () => {
  it('provisions one verified account only for the active email-bound invitation', async () => {
    const invitationToken = 'active-email-bound-invitation-token';
    const invitation = {
      consumed: false,
      email: 'member@example.com',
      expiresAt: new Date('2026-08-16T16:00:00.000Z'),
      householdId: 'household-1',
      id: 'invitation-1',
      role: 'member' as const,
      tokenHash: createHash('sha256').update(invitationToken).digest('hex'),
    };
    const provisionedEmails: string[] = [];
    const provisioner: InvitedAccountProvisioner = {
      async provisionInvitedAccount(input) {
        if (
          invitation.consumed ||
          input.invitationId !== invitation.id ||
          input.invitationTokenHash !== invitation.tokenHash ||
          input.email !== invitation.email ||
          input.now.getTime() >= invitation.expiresAt.getTime()
        ) {
          return { status: 'rejected' };
        }
        invitation.consumed = true;
        provisionedEmails.push(input.email);
        return {
          email: input.email,
          emailVerified: true,
          householdId: invitation.householdId,
          role: invitation.role,
          status: 'provisioned',
          userId: 'user-1',
        };
      },
    };
    const service = new InvitedAccountOnboardingService(
      provisioner,
      () => new Date('2026-08-09T16:00:00.000Z'),
    );

    await expect(
      service.registerWithInvitation({
        displayName: 'Uninvited Person',
        email: 'uninvited@example.com',
        invitationId: invitation.id,
        invitationToken,
        password: 'a-strong-password',
      }),
    ).rejects.toMatchObject({ code: 'invitation-invalid' });

    await expect(
      service.registerWithInvitation({
        displayName: 'Household Member',
        email: ' MEMBER@EXAMPLE.COM ',
        invitationId: invitation.id,
        invitationToken,
        password: 'a-strong-password',
      }),
    ).resolves.toEqual({
      email: 'member@example.com',
      emailVerified: true,
      householdId: 'household-1',
      role: 'member',
      userId: 'user-1',
    });

    await expect(
      service.registerWithInvitation({
        displayName: 'Household Member',
        email: 'member@example.com',
        invitationId: invitation.id,
        invitationToken,
        password: 'a-strong-password',
      }),
    ).rejects.toMatchObject({ code: 'invitation-invalid' });
    expect(provisionedEmails).toEqual(['member@example.com']);
  });
});

describe('EmdoRotatingSessionBoundary', () => {
  it('invalidates the prior token when a rotation is accepted', async () => {
    const sessions = new RotatingSessionService(
      new InMemorySessionRepository(),
    );
    const boundary = new EmdoRotatingSessionBoundary(sessions);
    const issued = await sessions.issue({
      expiresAt: new Date('2026-08-10T16:00:00.000Z'),
      now: new Date('2026-08-09T16:00:00.000Z'),
      userId: 'user-1',
    });
    const rotated = await boundary.rotate({
      expiresAt: new Date('2026-08-10T17:00:00.000Z'),
      now: new Date('2026-08-09T17:00:00.000Z'),
      token: issued.token,
    });

    await expect(
      boundary.authenticate(issued.token, new Date('2026-08-09T17:00:01.000Z')),
    ).resolves.toBeUndefined();
    await expect(
      boundary.authenticate(
        rotated.token,
        new Date('2026-08-09T17:00:01.000Z'),
      ),
    ).resolves.toMatchObject({ rotation: 1, userId: 'user-1' });
  });
});

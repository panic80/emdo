import { describe, expect, it, vi } from 'vitest';

import type { EmdoBetterAuthConfiguration } from '@emdo/auth/server';

import type { AuthenticationBoundary } from '../services/contracts.js';
import type { ProductionAuthenticationBoundaryOptions } from './auth-boundary.js';
import {
  createProductionAuthenticationServiceBinding,
  type ProductionAuthenticationDependencies,
} from './auth-services.js';

const encodedSecret = (byte: number): string =>
  Buffer.alloc(32, byte).toString('base64url');

const validEnvironment = () => ({
  EMDO_API_AUTH_SECRET: encodedSecret(11),
  EMDO_API_DATABASE_URL:
    'postgresql://emdo_api_login:secret@postgres:5432/emdo_app?sslmode=disable',
  EMDO_AUTH_DATABASE_URL:
    'postgresql://emdo_auth_login:secret@postgres:5432/emdo_app?sslmode=disable',
  EMDO_GOOGLE_IDENTITY_CLIENT_ID: '1234567890-emdo.apps.googleusercontent.com',
  EMDO_GOOGLE_IDENTITY_CLIENT_SECRET: 'GOCSPX-fixture_identity_secret',
  EMDO_ONBOARDING_DATABASE_URL:
    'postgresql://emdo_onboarding_login:secret@postgres:5432/emdo_app?sslmode=disable',
  EMDO_PUBLIC_ORIGIN: 'https://emdo.example',
  EMDO_RESEND_AUTH_API_KEY: 're_fixture_transactional_email_key',
  EMDO_RESEND_FROM_EMAIL: 'auth@emdo.example',
  EMDO_SESSION_SECRET: encodedSecret(23),
  EMDO_TRANSACTIONAL_EMAIL_PROVIDER: 'resend',
});

const coreEnvironment = () => ({
  EMDO_API_AUTH_SECRET: encodedSecret(11),
  EMDO_API_DATABASE_URL:
    'postgresql://emdo_api_login:secret@postgres:5432/emdo_app?sslmode=disable',
  EMDO_AUTH_DATABASE_URL:
    'postgresql://emdo_auth_login:secret@postgres:5432/emdo_app?sslmode=disable',
  EMDO_PUBLIC_ORIGIN: 'https://emdo.example',
  EMDO_SESSION_SECRET: encodedSecret(23),
});

const authenticationBoundary = (): AuthenticationBoundary => ({
  authenticate: vi.fn(),
  handleBrowserRequest: vi.fn(),
  issueInvitationCsrf: vi.fn(),
  issueMutationCsrf: vi.fn(),
  redeemInvitation: vi.fn(),
  verifyMutation: vi.fn(),
});

const dependencies = () => {
  const closes = [
    vi.fn(async () => undefined),
    vi.fn(async () => undefined),
    vi.fn(async () => undefined),
  ];
  let databaseIndex = 0;
  const claimBridge = {
    checkReady: vi.fn(async () => true),
    database: vi.fn(),
    resolveExactlyOneActiveHousehold: vi.fn(async () => undefined),
    run: vi.fn(),
  };
  const scopeResolver = {
    checkReady: vi.fn(async () => true),
    resolveActivePrincipalScope: vi.fn(),
  };
  const invitationRedemptions = {
    checkReady: vi.fn(async () => true),
    redeem: vi.fn(),
  };
  const transport = {
    checkReady: vi.fn(async () => true),
    send: vi.fn(),
  };
  const emailCallbacks = {
    sendInvitationEmail: vi.fn(),
    sendPasswordResetEmail: vi.fn(),
    sendVerificationEmail: vi.fn(),
  };
  const auth = {
    api: {
      getActiveMember: vi.fn(async () => undefined),
      getSession: vi.fn(async () => undefined),
    },
    handler: vi.fn(async () => new Response(null, { status: 204 })),
  };
  const csrfProtector = { issue: vi.fn(), verify: vi.fn() };
  const boundary = authenticationBoundary();
  const captured: {
    authenticationBoundaryOptions?: ProductionAuthenticationBoundaryOptions;
    betterAuthConfiguration?: EmdoBetterAuthConfiguration;
  } = {};

  const adapters = {
    createAuthenticationBoundary: vi.fn(
      (options: ProductionAuthenticationBoundaryOptions) => {
        captured.authenticationBoundaryOptions = options;
        return boundary;
      },
    ),
    createBetterAuth: vi.fn((configuration: EmdoBetterAuthConfiguration) => {
      captured.betterAuthConfiguration = configuration;
      return auth;
    }),
    createCsrfProtector: vi.fn(() => csrfProtector as never),
    createDatabaseClient: vi.fn((input) => {
      const close = closes[databaseIndex++];
      if (close === undefined) throw new Error('unexpected database');
      return {
        close,
        pool: { applicationName: input.applicationName },
        scopedPool: { applicationName: input.applicationName },
      } as never;
    }),
    createEmailCallbacks: vi.fn(() => emailCallbacks),
    createInvitationRedemptions: vi.fn(() => invitationRedemptions),
    createOrganizationClaimBridge: vi.fn(async () => claimBridge),
    createScopeResolver: vi.fn(() => scopeResolver),
    createTransactionalEmailTransport: vi.fn(() => transport),
  } satisfies ProductionAuthenticationDependencies;

  return {
    adapters,
    auth,
    boundary,
    captured,
    claimBridge,
    closes,
    csrfProtector,
    emailCallbacks,
    invitationRedemptions,
    scopeResolver,
    transport,
  };
};

describe('production authentication service composition', () => {
  it.each([
    ['missing configuration', {}],
    [
      'wrong API database identity',
      {
        ...validEnvironment(),
        EMDO_API_DATABASE_URL:
          'postgresql://emdo_auth_login:secret@postgres:5432/emdo_app',
      },
    ],
    [
      'non-canonical authentication secret',
      { ...validEnvironment(), EMDO_API_AUTH_SECRET: `${encodedSecret(11)}=` },
    ],
    [
      'reused authentication and CSRF secret',
      {
        ...validEnvironment(),
        EMDO_SESSION_SECRET: encodedSecret(11),
      },
    ],
  ])('opens no database for %s', async (_label, environment) => {
    const harness = dependencies();

    const result = await createProductionAuthenticationServiceBinding(
      environment,
      harness.adapters,
    );

    expect(result).toEqual({});
    expect(harness.adapters.createDatabaseClient).not.toHaveBeenCalled();
    expect(
      harness.adapters.createTransactionalEmailTransport,
    ).not.toHaveBeenCalled();
  });

  it('disables an invalid optional provider bundle without disabling core authentication', async () => {
    const harness = dependencies();

    const result = await createProductionAuthenticationServiceBinding(
      {
        ...validEnvironment(),
        EMDO_TRANSACTIONAL_EMAIL_PROVIDER: 'smtp',
      },
      harness.adapters,
    );

    expect(result.binding?.service).toBe(harness.boundary);
    expect(harness.adapters.createDatabaseClient).toHaveBeenCalledTimes(2);
    expect(
      harness.adapters.createTransactionalEmailTransport,
    ).not.toHaveBeenCalled();
    expect(harness.adapters.createInvitationRedemptions).not.toHaveBeenCalled();
  });

  it('composes verified password/session authentication without optional identity, mail, or onboarding providers', async () => {
    const harness = dependencies();

    const result = await createProductionAuthenticationServiceBinding(
      coreEnvironment(),
      harness.adapters,
    );

    expect(harness.adapters.createDatabaseClient.mock.calls).toEqual([
      [
        expect.objectContaining({
          applicationName: 'emdo-api-auth-scope',
          connectionString: coreEnvironment().EMDO_API_DATABASE_URL,
          max: 5,
        }),
      ],
      [
        expect.objectContaining({
          applicationName: 'emdo-api-better-auth',
          connectionString: coreEnvironment().EMDO_AUTH_DATABASE_URL,
          max: 10,
        }),
      ],
    ]);
    expect(
      harness.adapters.createTransactionalEmailTransport,
    ).not.toHaveBeenCalled();
    expect(harness.adapters.createEmailCallbacks).not.toHaveBeenCalled();
    expect(harness.adapters.createInvitationRedemptions).not.toHaveBeenCalled();
    expect(harness.adapters.createBetterAuth).toHaveBeenCalledWith(
      expect.not.objectContaining({ googleIdentity: expect.anything() }),
    );
    await expect(
      harness.captured.betterAuthConfiguration?.sendPasswordResetEmail(
        {} as never,
      ),
    ).rejects.toThrow('authentication-email-unavailable');
    await expect(
      harness.captured.betterAuthConfiguration?.sendVerificationEmail(
        {} as never,
      ),
    ).rejects.toThrow('authentication-email-unavailable');
    await expect(
      harness.captured.authenticationBoundaryOptions?.invitationRedemptions.redeem(
        {} as never,
      ),
    ).rejects.toThrow('invitation-onboarding-unavailable');
    await expect(result.binding?.check()).resolves.toBe(true);
    expect(harness.transport.checkReady).not.toHaveBeenCalled();
    expect(harness.invitationRedemptions.checkReady).not.toHaveBeenCalled();
    expect(result.binding?.service).toBe(harness.boundary);
  });

  it('constructs the complete durable boundary from exact purpose-specific inputs', async () => {
    const harness = dependencies();

    const result = await createProductionAuthenticationServiceBinding(
      validEnvironment(),
      harness.adapters,
    );

    expect(harness.adapters.createDatabaseClient.mock.calls).toEqual([
      [
        expect.objectContaining({
          applicationName: 'emdo-api-auth-scope',
          connectionString: validEnvironment().EMDO_API_DATABASE_URL,
          max: 5,
        }),
      ],
      [
        expect.objectContaining({
          applicationName: 'emdo-api-better-auth',
          connectionString: validEnvironment().EMDO_AUTH_DATABASE_URL,
          max: 10,
        }),
      ],
      [
        expect.objectContaining({
          applicationName: 'emdo-api-onboarding',
          connectionString: validEnvironment().EMDO_ONBOARDING_DATABASE_URL,
          max: 2,
        }),
      ],
    ]);
    expect(
      harness.adapters.createTransactionalEmailTransport,
    ).toHaveBeenCalledWith({
      apiKey: validEnvironment().EMDO_RESEND_AUTH_API_KEY,
      fromEmail: validEnvironment().EMDO_RESEND_FROM_EMAIL,
    });
    expect(harness.adapters.createBetterAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: 'EMDO',
        baseURL: 'https://emdo.example',
        googleIdentity: {
          clientId: validEnvironment().EMDO_GOOGLE_IDENTITY_CLIENT_ID,
          clientSecret: validEnvironment().EMDO_GOOGLE_IDENTITY_CLIENT_SECRET,
        },
        organizationClaimBridge: harness.claimBridge,
        secret: validEnvironment().EMDO_API_AUTH_SECRET,
        trustedOrigins: ['https://emdo.example'],
        ...harness.emailCallbacks,
      }),
    );
    expect(harness.adapters.createCsrfProtector).toHaveBeenCalledWith({
      secret: expect.any(Uint8Array),
      trustedOrigins: ['https://emdo.example'],
    });
    expect(harness.adapters.createAuthenticationBoundary).toHaveBeenCalledWith({
      auth: harness.auth,
      csrfProtector: harness.csrfProtector,
      invitationRedemptions: harness.invitationRedemptions,
      publicOrigin: 'https://emdo.example',
      scopeResolver: harness.scopeResolver,
    });
    expect(result.binding?.service).toBe(harness.boundary);
    expect(result.close).toEqual(expect.any(Function));
  });

  it('reports healthy only when every exact durable and provider probe returns true', async () => {
    const harness = dependencies();
    const result = await createProductionAuthenticationServiceBinding(
      validEnvironment(),
      harness.adapters,
    );

    await expect(result.binding?.check()).resolves.toBe(true);
    harness.transport.checkReady.mockResolvedValueOnce(false);
    await expect(result.binding?.check()).resolves.toBe(false);
    harness.claimBridge.checkReady.mockRejectedValueOnce(
      new Error('private failure'),
    );
    await expect(result.binding?.check()).resolves.toBe(false);
    expect(harness.scopeResolver.checkReady).toHaveBeenCalledTimes(3);
    expect(harness.invitationRedemptions.checkReady).toHaveBeenCalledTimes(3);
  });

  it('closes every opened database if construction fails', async () => {
    const harness = dependencies();
    harness.adapters.createOrganizationClaimBridge.mockRejectedValueOnce(
      new Error('preflight rejected'),
    );

    const result = await createProductionAuthenticationServiceBinding(
      validEnvironment(),
      harness.adapters,
    );

    expect(result).toEqual({});
    expect(harness.closes[0]).toHaveBeenCalledOnce();
    expect(harness.closes[1]).toHaveBeenCalledOnce();
    expect(harness.closes[2]).not.toHaveBeenCalled();
  });

  it('closes all purpose-specific databases exactly once', async () => {
    const harness = dependencies();
    const result = await createProductionAuthenticationServiceBinding(
      validEnvironment(),
      harness.adapters,
    );

    await result.close?.();
    await result.close?.();

    for (const close of harness.closes) expect(close).toHaveBeenCalledOnce();
  });
});

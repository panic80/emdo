import {
  CsrfProtector,
  createEmdoBetterAuth,
  type EmdoBetterAuthConfiguration,
} from '@emdo/auth/server';
import {
  PostgresInvitationRedemptionCoordinator,
  PostgresSpaceAccessGrantService,
  createDatabaseClient,
  createPostgresBetterAuthOrganizationClaimBridge,
  type EmdoDatabaseClient,
  type PostgresBetterAuthOrganizationClaimBridge,
} from '@emdo/db/api';
import {
  ResendTransactionalEmailTransport,
  createBetterAuthEmailCallbacks,
  type TransactionalEmailTransport,
} from '@emdo/integrations/email';
import { z } from 'zod';

import type { AuthenticationBoundary } from '../services/contracts.js';
import {
  createProductionAuthenticationBoundary,
  type ActivePrincipalScopeResolver,
  type BetterAuthBoundaryRuntime,
  type InvitationRedemptionCoordinator,
  type ProductionAuthenticationBoundaryOptions,
} from './auth-boundary.js';
import type { ProductionApiServiceBinding } from './unavailable-services.js';

type DatabaseRuntime = Pick<
  EmdoDatabaseClient,
  'close' | 'pool' | 'scopedPool'
>;
type ReadyScopeResolver = ActivePrincipalScopeResolver & {
  readonly checkReady: () => Promise<boolean>;
};
type ReadyInvitationRedemptions = InvitationRedemptionCoordinator & {
  readonly checkReady: () => Promise<boolean>;
};
type ReadyTransactionalEmailTransport = TransactionalEmailTransport & {
  readonly checkReady: () => Promise<boolean>;
};
type BetterAuthEmailCallbacks = ReturnType<
  typeof createBetterAuthEmailCallbacks
>;

const ExactHttpsOriginSchema = z
  .url({ protocol: /^https$/u })
  .max(512)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.origin === value &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  });

const databaseUrlSchema = (expectedUsername: string) =>
  z
    .url()
    .max(2_048)
    .refine((value) => {
      const url = new URL(value);
      return (
        (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
        url.username === expectedUsername &&
        url.password.length > 0 &&
        url.hostname.length > 0 &&
        url.pathname === '/emdo_app' &&
        url.hash === ''
      );
    });

const CanonicalSecretSchema = z
  .string()
  .min(43)
  .max(86)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .refine((value) => {
    const bytes = Buffer.from(value, 'base64url');
    const valid =
      bytes.byteLength >= 32 &&
      bytes.byteLength <= 64 &&
      bytes.toString('base64url') === value;
    bytes.fill(0);
    return valid;
  });

const CoreEnvironmentSchema = z.strictObject({
  authSecret: CanonicalSecretSchema,
  apiDatabaseUrl: databaseUrlSchema('emdo_api_login'),
  authDatabaseUrl: databaseUrlSchema('emdo_auth_login'),
  publicOrigin: ExactHttpsOriginSchema,
  sessionSecret: CanonicalSecretSchema,
});

const OptionalProviderEnvironmentSchema = z.strictObject({
  googleClientId: z
    .string()
    .min(20)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/u),
  googleClientSecret: z
    .string()
    .min(16)
    .max(512)
    .regex(/^\S+$/u)
    .refine((value) =>
      [...value].every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return !(code <= 31 || (code >= 127 && code <= 159));
      }),
    ),
  onboardingDatabaseUrl: databaseUrlSchema('emdo_onboarding_login'),
  resendApiKey: z
    .string()
    .min(23)
    .max(512)
    .regex(/^re_[A-Za-z0-9_-]+$/u),
  resendFromEmail: z
    .email()
    .max(320)
    .refine((value) => value === value.toLowerCase())
    .refine((value) => value.slice(value.lastIndexOf('@') + 1).includes('.')),
  transactionalEmailProvider: z.literal('resend'),
});

const FinanceSyntheticOnboardingEnvironmentSchema = z.strictObject({
  allowLoopbackApiIngress: z.literal('true'),
  environment: z.literal('staging'),
  financeSyntheticStaging: z.literal('true'),
  googleClientId: z.undefined(),
  googleClientSecret: z.undefined(),
  onboardingDatabaseUrl: databaseUrlSchema('emdo_onboarding_login'),
  resendApiKey: z.undefined(),
  resendFromEmail: z.undefined(),
  syntheticDataOnly: z.literal('true'),
  transactionalEmailProvider: z.undefined(),
});

interface ParsedEnvironment extends z.output<typeof CoreEnvironmentSchema> {
  readonly optionalProviders?: z.output<
    typeof OptionalProviderEnvironmentSchema
  >;
  readonly financeSyntheticOnboardingDatabaseUrl?: string;
  readonly sessionSecretBytes: Uint8Array;
}

const parseEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): ParsedEnvironment | undefined => {
  const core = CoreEnvironmentSchema.safeParse({
    authSecret: environment.EMDO_API_AUTH_SECRET,
    apiDatabaseUrl: environment.EMDO_API_DATABASE_URL,
    authDatabaseUrl: environment.EMDO_AUTH_DATABASE_URL,
    publicOrigin: environment.EMDO_PUBLIC_ORIGIN,
    sessionSecret: environment.EMDO_SESSION_SECRET,
  });
  if (!core.success || core.data.authSecret === core.data.sessionSecret) {
    return undefined;
  }
  const optionalProviders = OptionalProviderEnvironmentSchema.safeParse({
    googleClientId: environment.EMDO_GOOGLE_IDENTITY_CLIENT_ID,
    googleClientSecret: environment.EMDO_GOOGLE_IDENTITY_CLIENT_SECRET,
    onboardingDatabaseUrl: environment.EMDO_ONBOARDING_DATABASE_URL,
    resendApiKey: environment.EMDO_RESEND_AUTH_API_KEY,
    resendFromEmail: environment.EMDO_RESEND_FROM_EMAIL,
    transactionalEmailProvider: environment.EMDO_TRANSACTIONAL_EMAIL_PROVIDER,
  });
  const financeSyntheticOnboarding =
    FinanceSyntheticOnboardingEnvironmentSchema.safeParse({
      allowLoopbackApiIngress: environment.EMDO_ALLOW_LOOPBACK_API_INGRESS,
      environment: environment.EMDO_ENVIRONMENT,
      financeSyntheticStaging: environment.EMDO_FINANCE_SYNTHETIC_STAGING,
      googleClientId: environment.EMDO_GOOGLE_IDENTITY_CLIENT_ID,
      googleClientSecret: environment.EMDO_GOOGLE_IDENTITY_CLIENT_SECRET,
      onboardingDatabaseUrl: environment.EMDO_ONBOARDING_DATABASE_URL,
      resendApiKey: environment.EMDO_RESEND_AUTH_API_KEY,
      resendFromEmail: environment.EMDO_RESEND_FROM_EMAIL,
      syntheticDataOnly: environment.EMDO_SYNTHETIC_DATA_ONLY,
      transactionalEmailProvider: environment.EMDO_TRANSACTIONAL_EMAIL_PROVIDER,
    });
  const sessionSecretBytes = Buffer.from(core.data.sessionSecret, 'base64url');
  return Object.freeze({
    ...core.data,
    ...(optionalProviders.success
      ? { optionalProviders: optionalProviders.data }
      : {}),
    ...(financeSyntheticOnboarding.success && !optionalProviders.success
      ? {
          financeSyntheticOnboardingDatabaseUrl:
            financeSyntheticOnboarding.data.onboardingDatabaseUrl,
        }
      : {}),
    sessionSecretBytes,
  });
};

const unavailableEmailCallbacks: BetterAuthEmailCallbacks = Object.freeze({
  sendInvitationEmail: async () => {
    throw new Error('authentication-email-unavailable');
  },
  sendPasswordResetEmail: async () => {
    throw new Error('authentication-email-unavailable');
  },
  sendVerificationEmail: async () => {
    throw new Error('authentication-email-unavailable');
  },
});

const unavailableInvitationRedemptions: InvitationRedemptionCoordinator =
  Object.freeze({
    redeem: async () => {
      throw new Error('invitation-onboarding-unavailable');
    },
  });

export interface ProductionAuthenticationDependencies {
  readonly createAuthenticationBoundary: (
    options: ProductionAuthenticationBoundaryOptions,
  ) => AuthenticationBoundary;
  readonly createBetterAuth: (
    configuration: EmdoBetterAuthConfiguration,
  ) => BetterAuthBoundaryRuntime;
  readonly createCsrfProtector: (options: {
    readonly secret: Uint8Array;
    readonly trustedOrigins: readonly string[];
  }) => CsrfProtector;
  readonly createDatabaseClient: (input: {
    readonly connectionString: string;
    readonly applicationName: string;
    readonly max: number;
  }) => DatabaseRuntime;
  readonly createEmailCallbacks: (
    transport: TransactionalEmailTransport,
    configuration: { readonly applicationOrigin: string },
  ) => BetterAuthEmailCallbacks;
  readonly createInvitationRedemptions: (
    pool: DatabaseRuntime['scopedPool'],
  ) => ReadyInvitationRedemptions;
  readonly createOrganizationClaimBridge: (
    pool: DatabaseRuntime['pool'],
  ) => Promise<PostgresBetterAuthOrganizationClaimBridge>;
  readonly createScopeResolver: (
    pool: DatabaseRuntime['scopedPool'],
  ) => ReadyScopeResolver;
  readonly createTransactionalEmailTransport: (configuration: {
    readonly apiKey: string;
    readonly fromEmail: string;
  }) => ReadyTransactionalEmailTransport;
}

const defaultDependencies: ProductionAuthenticationDependencies = Object.freeze(
  {
    createAuthenticationBoundary: createProductionAuthenticationBoundary,
    createBetterAuth: (configuration: EmdoBetterAuthConfiguration) =>
      createEmdoBetterAuth(
        configuration,
      ) as unknown as BetterAuthBoundaryRuntime,
    createCsrfProtector: (
      options: ConstructorParameters<typeof CsrfProtector>[0],
    ) => new CsrfProtector(options),
    createDatabaseClient,
    createEmailCallbacks: createBetterAuthEmailCallbacks,
    createInvitationRedemptions: (pool: DatabaseRuntime['scopedPool']) =>
      new PostgresInvitationRedemptionCoordinator(pool),
    createOrganizationClaimBridge:
      createPostgresBetterAuthOrganizationClaimBridge,
    createScopeResolver: (pool: DatabaseRuntime['scopedPool']) =>
      new PostgresSpaceAccessGrantService(pool),
    createTransactionalEmailTransport: (configuration: {
      readonly apiKey: string;
      readonly fromEmail: string;
    }) => new ResendTransactionalEmailTransport(configuration),
  },
);

const createClose = (databases: readonly DatabaseRuntime[]) => {
  let closePromise: Promise<void> | undefined;
  return (): Promise<void> => {
    closePromise ??= (async () => {
      const outcomes = await Promise.allSettled(
        [...databases]
          .reverse()
          .map((database) => Promise.resolve().then(() => database.close())),
      );
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === 'rejected' ? [outcome.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          'Production authentication databases could not all close',
        );
      }
    })();
    return closePromise;
  };
};

const coalesceProbe = (probe: () => Promise<boolean>) => {
  let inFlight: Promise<boolean> | undefined;
  return (): Promise<boolean> => {
    inFlight ??= Promise.resolve()
      .then(probe)
      .then(
        (ready) => ready === true,
        () => false,
      )
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
};

export interface ProductionAuthenticationComposition {
  readonly binding?: ProductionApiServiceBinding<AuthenticationBoundary>;
  readonly close?: () => Promise<void>;
}

export const createProductionAuthenticationServiceBinding = async (
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: ProductionAuthenticationDependencies = defaultDependencies,
): Promise<ProductionAuthenticationComposition> => {
  const parsed = parseEnvironment(environment);
  if (parsed === undefined) return Object.freeze({});

  const databases: DatabaseRuntime[] = [];
  const close = createClose(databases);
  try {
    const scopeDatabase = dependencies.createDatabaseClient({
      applicationName: 'emdo-api-auth-scope',
      connectionString: parsed.apiDatabaseUrl,
      max: 5,
    });
    databases.push(scopeDatabase);
    const authDatabase = dependencies.createDatabaseClient({
      applicationName: 'emdo-api-better-auth',
      connectionString: parsed.authDatabaseUrl,
      max: 10,
    });
    databases.push(authDatabase);

    const organizationClaimBridge =
      await dependencies.createOrganizationClaimBridge(authDatabase.pool);
    const scopeResolver = dependencies.createScopeResolver(
      scopeDatabase.scopedPool,
    );
    let emailCallbacks = unavailableEmailCallbacks;
    let invitationRedemptions: InvitationRedemptionCoordinator =
      unavailableInvitationRedemptions;
    let transport: ReadyTransactionalEmailTransport | undefined;
    let invitationReadiness: (() => Promise<boolean>) | undefined;
    let optionalDatabase: DatabaseRuntime | undefined;
    const onboardingDatabaseUrl =
      parsed.optionalProviders?.onboardingDatabaseUrl ??
      parsed.financeSyntheticOnboardingDatabaseUrl;
    if (onboardingDatabaseUrl !== undefined) {
      try {
        if (parsed.optionalProviders !== undefined) {
          transport = dependencies.createTransactionalEmailTransport({
            apiKey: parsed.optionalProviders.resendApiKey,
            fromEmail: parsed.optionalProviders.resendFromEmail,
          });
          emailCallbacks = dependencies.createEmailCallbacks(transport, {
            applicationOrigin: parsed.publicOrigin,
          });
        }
        optionalDatabase = dependencies.createDatabaseClient({
          applicationName: 'emdo-api-onboarding',
          connectionString: onboardingDatabaseUrl,
          max: 2,
        });
        const readyInvitationRedemptions =
          dependencies.createInvitationRedemptions(optionalDatabase.scopedPool);
        invitationRedemptions = readyInvitationRedemptions;
        invitationReadiness = readyInvitationRedemptions.checkReady.bind(
          readyInvitationRedemptions,
        );
        databases.push(optionalDatabase);
        optionalDatabase = undefined;
      } catch {
        transport = undefined;
        emailCallbacks = unavailableEmailCallbacks;
        invitationRedemptions = unavailableInvitationRedemptions;
        if (optionalDatabase !== undefined) {
          try {
            await optionalDatabase.close();
          } catch {
            databases.push(optionalDatabase);
          }
          optionalDatabase = undefined;
        }
      }
    }
    const csrfProtector = dependencies.createCsrfProtector({
      secret: parsed.sessionSecretBytes,
      trustedOrigins: [parsed.publicOrigin],
    });
    parsed.sessionSecretBytes.fill(0);
    const auth = dependencies.createBetterAuth({
      appName: 'EMDO',
      baseURL: parsed.publicOrigin,
      ...(parsed.optionalProviders === undefined || transport === undefined
        ? {}
        : {
            googleIdentity: {
              clientId: parsed.optionalProviders.googleClientId,
              clientSecret: parsed.optionalProviders.googleClientSecret,
            },
          }),
      organizationClaimBridge,
      secret: parsed.authSecret,
      ...emailCallbacks,
      trustedOrigins: [parsed.publicOrigin],
    });
    const boundary = dependencies.createAuthenticationBoundary({
      auth,
      csrfProtector,
      invitationRedemptions,
      publicOrigin: parsed.publicOrigin,
      scopeResolver,
    });

    const probes: Array<() => Promise<boolean>> = [
      organizationClaimBridge.checkReady.bind(organizationClaimBridge),
      scopeResolver.checkReady.bind(scopeResolver),
    ];
    if (invitationReadiness !== undefined) {
      probes.push(invitationReadiness);
    }
    if (transport !== undefined) {
      probes.push(transport.checkReady.bind(transport));
    }
    const check = coalesceProbe(async () => {
      const results = await Promise.all(
        probes.map((probe) =>
          Promise.resolve()
            .then(probe)
            .catch(() => false),
        ),
      );
      return results.every((result) => result === true);
    });

    return Object.freeze({
      binding: Object.freeze({ service: boundary, check }),
      close,
    });
  } catch {
    parsed.sessionSecretBytes.fill(0);
    await close().catch(() => undefined);
    return Object.freeze({});
  }
};

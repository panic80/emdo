import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { passkey } from '@better-auth/passkey';
import {
  betterAuth,
  type BetterAuthOptions,
  type DBAdapter,
  type DBAdapterInstance,
  type DBTransactionAdapter,
} from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import {
  defaultStatements,
  memberAc,
  ownerAc,
} from 'better-auth/plugins/organization/access';
import { z } from 'zod';

import type { RotatingSessionService } from './session.js';

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const WEEK_SECONDS = 7 * DAY_SECONDS;
const MINIMUM_SECRET_BYTES = 32;
const ALLOWED_HOUSEHOLD_ROLES = new Set(['owner', 'member']);
// disabledPaths closes HTTP routes; the global before hook below closes the
// same routes when invoked through auth.api.*. Organization hooks remain a
// third veto for server-only methods such as addMember.
const BLOCKED_ORGANIZATION_MUTATION_PATHS = Object.freeze([
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

const CLAIMED_ORGANIZATION_PATHS = new Set([
  '/organization/check-slug',
  '/organization/get-active-member',
  '/organization/get-active-member-role',
  '/organization/get-full-organization',
  '/organization/has-permission',
  '/organization/list',
  '/organization/list-invitations',
  '/organization/list-members',
  '/organization/set-active',
]);
const CLAIMED_ORGANIZATION_API_METHODS = new Set([
  'checkOrganizationSlug',
  'getActiveMember',
  'getActiveMemberRole',
  'getFullOrganization',
  'hasPermission',
  'listInvitations',
  'listMembers',
  'listOrganizations',
  'setActiveOrganization',
]);
const RECIPIENT_INVITATION_API_METHODS = new Set([
  'getInvitation',
  'listUserInvitations',
]);
const CLAIM_PROTECTED_MODELS = new Set([
  'invitation',
  'member',
  'organization',
]);
const ADAPTER_READ_METHODS = new Set(['count', 'findMany', 'findOne']);
const ADAPTER_WRITE_METHODS = new Set([
  'consumeOne',
  'create',
  'delete',
  'deleteMany',
  'incrementOne',
  'update',
  'updateMany',
]);

export const GOOGLE_IDENTITY_SCOPES = Object.freeze([
  'openid',
  'email',
  'profile',
] as const);

type EmailAndPasswordOptions = NonNullable<
  BetterAuthOptions['emailAndPassword']
>;
type EmailVerificationOptions = NonNullable<
  BetterAuthOptions['emailVerification']
>;
type OrganizationOptions = NonNullable<Parameters<typeof organization>[0]>;
type PasskeyOptions = NonNullable<Parameters<typeof passkey>[0]>;

export interface EmdoBetterAuthConfiguration {
  readonly appName: string;
  readonly baseURL: string;
  /**
   * The PostgreSQL/Drizzle slice supplies this single bridge so the ordinary
   * adapter and claimed transaction runner cannot be assembled from different
   * pools or schemas. This module never reaches through the adapter.
   */
  readonly organizationClaimBridge: BetterAuthOrganizationClaimBridge;
  /**
   * Identity-only Google OAuth client. Calendar OAuth uses a different grant
   * and credential-vault integration outside Better Auth. Better Auth 1.6.26
   * always enables Google's incremental granted-scope behavior, so this client
   * must never be reused for the Calendar connector.
   */
  readonly googleIdentity?: {
    readonly clientId: string;
    readonly clientSecret: string;
  };
  readonly secret: string;
  readonly sendInvitationEmail: NonNullable<
    OrganizationOptions['sendInvitationEmail']
  >;
  readonly sendPasswordResetEmail: NonNullable<
    EmailAndPasswordOptions['sendResetPassword']
  >;
  readonly sendVerificationEmail: NonNullable<
    EmailVerificationOptions['sendVerificationEmail']
  >;
  readonly trustedOrigins: readonly string[];
}

export interface BetterAuthOrganizationClaimIdentity {
  readonly sessionId: string;
  readonly userId: string;
}

export interface BetterAuthOrganizationClaimTransaction {
  readonly adapter: DBTransactionAdapter;
  /**
   * On the pinned connection, re-read and lock the exact session/user, verify
   * the expected IDs, expiry, and verified email, then issue parameterized,
   * transaction-local PostgreSQL claims. It must resolve only after every
   * check and claim succeeds.
   */
  readonly revalidateAndActivateClaims: (
    identity: BetterAuthOrganizationClaimIdentity,
  ) => Promise<void>;
}

export interface BetterAuthOrganizationClaimBridge {
  readonly database: DBAdapterInstance;
  readonly resolveExactlyOneActiveHousehold: (
    userId: string,
  ) => Promise<string | undefined>;
  readonly run: <Result>(
    options: BetterAuthOptions,
    work: (
      transaction: BetterAuthOrganizationClaimTransaction,
    ) => Promise<Result>,
  ) => Promise<Result>;
}

export interface EmdoBetterAuthDependencies<TAuth> {
  readonly authFactory: (options: BetterAuthOptions) => TAuth;
  readonly organizationFactory: (
    options: OrganizationOptions,
  ) => ReturnType<typeof organization>;
  readonly passkeyFactory: (
    options: PasskeyOptions,
  ) => ReturnType<typeof passkey>;
}

export interface InvitedAccountProvisioner {
  /**
   * Atomically verifies the pending invitation ID, token hash, normalized
   * email, and expiry; creates a Better Auth credential with verified email;
   * creates the authoritative household membership; and consumes the
   * invitation. A durable implementation must commit all four effects in one
   * database transaction, so concurrent calls can provision at most once.
   */
  provisionInvitedAccount(input: {
    readonly displayName: string;
    readonly email: string;
    readonly invitationId: string;
    readonly invitationTokenHash: string;
    readonly now: Date;
    readonly password: string;
  }): Promise<
    | { readonly status: 'rejected' }
    | {
        readonly status: 'provisioned';
        readonly userId: string;
        readonly email: string;
        readonly emailVerified: true;
        readonly householdId: string;
        readonly role: 'owner' | 'member';
      }
  >;
}

export type InvitedAccountOnboardingErrorCode =
  'invitation-invalid' | 'onboarding-unavailable';

export class InvitedAccountOnboardingError extends Error {
  constructor(
    readonly code: InvitedAccountOnboardingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InvitedAccountOnboardingError';
  }
}

const InvitedAccountRegistrationSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(100),
  email: z.string().trim().min(3).max(320),
  invitationId: z.string().trim().min(1).max(200),
  invitationToken: z.string().min(20).max(512),
  password: z.string().min(12).max(128),
});

const InvitedAccountProvisionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('rejected') }),
  z.strictObject({
    email: z.string().trim().min(3).max(320),
    emailVerified: z.literal(true),
    householdId: z.string().trim().min(1),
    role: z.enum(['owner', 'member']),
    status: z.literal('provisioned'),
    userId: z.string().trim().min(1),
  }),
]);

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const invitationTokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export class InvitedAccountOnboardingService {
  private readonly provisionInvitedAccount: InvitedAccountProvisioner['provisionInvitedAccount'];
  private readonly clock: () => Date;

  constructor(
    provisioner: InvitedAccountProvisioner,
    clock: () => Date = () => new Date(),
  ) {
    this.provisionInvitedAccount =
      provisioner.provisionInvitedAccount.bind(provisioner);
    this.clock = clock;
  }

  async registerWithInvitation(input: {
    readonly displayName: string;
    readonly email: string;
    readonly invitationId: string;
    readonly invitationToken: string;
    readonly password: string;
  }) {
    const parsedInput = InvitedAccountRegistrationSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new InvitedAccountOnboardingError(
        'invitation-invalid',
        'Invitation onboarding could not be completed',
      );
    }
    const email = normalizeEmail(parsedInput.data.email);
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      throw new InvitedAccountOnboardingError(
        'invitation-invalid',
        'Invitation onboarding could not be completed',
      );
    }
    const now = new Date(this.clock());
    if (!Number.isFinite(now.getTime())) {
      throw new InvitedAccountOnboardingError(
        'onboarding-unavailable',
        'Invitation onboarding is temporarily unavailable',
      );
    }

    let rawResult: Awaited<
      ReturnType<InvitedAccountProvisioner['provisionInvitedAccount']>
    >;
    try {
      rawResult = await this.provisionInvitedAccount(
        Object.freeze({
          displayName: parsedInput.data.displayName,
          email,
          invitationId: parsedInput.data.invitationId,
          invitationTokenHash: invitationTokenHash(
            parsedInput.data.invitationToken,
          ),
          now,
          password: parsedInput.data.password,
        }),
      );
    } catch {
      throw new InvitedAccountOnboardingError(
        'onboarding-unavailable',
        'Invitation onboarding is temporarily unavailable',
      );
    }

    const result = InvitedAccountProvisionResultSchema.safeParse(rawResult);
    if (
      !result.success ||
      result.data.status === 'rejected' ||
      normalizeEmail(result.data.email) !== email
    ) {
      throw new InvitedAccountOnboardingError(
        'invitation-invalid',
        'Invitation onboarding could not be completed',
      );
    }
    return Object.freeze({
      email,
      emailVerified: true as const,
      householdId: result.data.householdId,
      role: result.data.role,
      userId: result.data.userId,
    });
  }
}

type SessionRotationService = Pick<
  RotatingSessionService,
  'authenticate' | 'rotate'
>;

/**
 * API-facing boundary for app-owned token rotation. Better Auth's updateAge
 * only rolls the expiry of the same token; it is not token rotation.
 */
export class EmdoRotatingSessionBoundary {
  private readonly authenticateSession: SessionRotationService['authenticate'];
  private readonly rotateSession: SessionRotationService['rotate'];

  constructor(service: SessionRotationService) {
    this.authenticateSession = service.authenticate.bind(service);
    this.rotateSession = service.rotate.bind(service);
  }

  authenticate(token: string, now: Date) {
    return this.authenticateSession(token, new Date(now));
  }

  async rotate(input: Parameters<SessionRotationService['rotate']>[0]) {
    const snapshot = Object.freeze({
      expiresAt: new Date(input.expiresAt),
      now: new Date(input.now),
      token: input.token,
    });
    const rotated = await this.rotateSession(snapshot);
    if (
      rotated.token === snapshot.token ||
      (await this.authenticateSession(snapshot.token, snapshot.now)) !==
        undefined
    ) {
      throw new Error('Session rotation did not invalidate the prior token');
    }
    return rotated;
  }
}

const defaultDependencies: EmdoBetterAuthDependencies<
  ReturnType<typeof betterAuth>
> = {
  authFactory: betterAuth,
  organizationFactory: organization,
  passkeyFactory: passkey,
};

const assertNonEmpty = (value: string, label: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} is required`);
  }
  return normalized;
};

const assertExactHttpsOrigin = (value: string, label: string): string => {
  if (value.includes('*')) {
    throw new Error(`${label} must not contain wildcards`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }

  if (
    url.protocol !== 'https:' ||
    url.origin !== value ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`${label} must be an exact HTTPS origin`);
  }
  return url.origin;
};

const validateConfiguration = (configuration: EmdoBetterAuthConfiguration) => {
  const appName = assertNonEmpty(configuration.appName, 'App name');
  const baseURL = assertExactHttpsOrigin(configuration.baseURL, 'Base URL');
  if (
    !isRecord(configuration.organizationClaimBridge) ||
    typeof configuration.organizationClaimBridge.database !== 'function' ||
    typeof configuration.organizationClaimBridge
      .resolveExactlyOneActiveHousehold !== 'function' ||
    typeof configuration.organizationClaimBridge.run !== 'function'
  ) {
    throw new Error(
      'A transaction-bound Better Auth organization claim bridge is required',
    );
  }
  const googleIdentity =
    configuration.googleIdentity === undefined
      ? undefined
      : Object.freeze({
          clientId: assertNonEmpty(
            configuration.googleIdentity.clientId,
            'Google identity client ID',
          ),
          clientSecret: assertNonEmpty(
            configuration.googleIdentity.clientSecret,
            'Google identity client secret',
          ),
        });
  if (
    configuration.secret.trim().length === 0 ||
    Buffer.byteLength(configuration.secret, 'utf8') < MINIMUM_SECRET_BYTES
  ) {
    throw new Error('Better Auth secret must contain at least 32 bytes');
  }
  if (configuration.trustedOrigins.length === 0) {
    throw new Error('At least one trusted origin is required');
  }
  const trustedOrigins = configuration.trustedOrigins.map((origin, index) =>
    assertExactHttpsOrigin(origin, `Trusted origin ${index + 1}`),
  );
  if (new Set(trustedOrigins).size !== trustedOrigins.length) {
    throw new Error('Trusted origins must be unique');
  }
  const environmentOrigins = process.env.BETTER_AUTH_TRUSTED_ORIGINS;
  if (environmentOrigins !== undefined && environmentOrigins.length > 0) {
    const configuredOrigins = new Set([baseURL, ...trustedOrigins]);
    const broadensAllowlist = environmentOrigins
      .split(',')
      .filter((origin) => origin.length > 0)
      .some((origin) => !configuredOrigins.has(origin));
    if (broadensAllowlist) {
      throw new Error(
        'BETTER_AUTH_TRUSTED_ORIGINS must not broaden configured origins',
      );
    }
  }
  for (const [callback, label] of [
    [configuration.sendInvitationEmail, 'Invitation email adapter'],
    [configuration.sendPasswordResetEmail, 'Password reset email adapter'],
    [configuration.sendVerificationEmail, 'Verification email adapter'],
  ] as const) {
    if (typeof callback !== 'function') {
      throw new Error(`${label} is required`);
    }
  }

  return {
    appName,
    baseURL,
    googleIdentity,
    trustedOrigins,
  };
};

const createHouseholdAuthorization = () => {
  const accessControl = createAccessControl(defaultStatements);
  return {
    accessControl,
    roles: {
      owner: accessControl.newRole(ownerAc.statements),
      member: accessControl.newRole(memberAc.statements),
    },
  };
};

const assertSingleHouseholdRole = (role: string) => {
  const roles = role.split(',');
  if (roles.length !== 1 || !ALLOWED_HOUSEHOLD_ROLES.has(roles[0] ?? '')) {
    throw new APIError('FORBIDDEN', {
      message: 'Household role must be owner or member',
    });
  }
};

const denyBetterAuthOrganizationMutation = (): never => {
  throw new APIError('FORBIDDEN', {
    message:
      'Better Auth organization mutations are disabled; use the canonical household writer',
  });
};

const denyBetterAuthRecipientInvitationRead = (): never => {
  throw new APIError('FORBIDDEN', {
    message:
      'Better Auth recipient invitation reads are disabled; use the canonical invitation onboarding flow',
  });
};

type OrganizationClaimBridgeErrorCode =
  | 'claim-required'
  | 'runtime-invalid'
  | 'session-unverified'
  | 'transaction-unavailable';

class OrganizationClaimBridgeError extends Error {
  constructor(
    readonly code: OrganizationClaimBridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OrganizationClaimBridgeError';
  }
}

interface OrganizationClaimScope {
  readonly adapter: DBTransactionAdapter;
  identity?: BetterAuthOrganizationClaimIdentity;
}

interface BetterAuthRuntime {
  readonly api: Record<string, unknown> & {
    readonly getSession: (input: {
      readonly headers: Headers;
      readonly query?: {
        readonly disableCookieCache?: boolean;
        readonly disableRefresh?: boolean;
      };
    }) => Promise<unknown>;
  };
  readonly handler: (request: Request) => Promise<Response>;
}

const VerifiedOrganizationSessionSchema = z.object({
  session: z.object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
  }),
  user: z.object({
    emailVerified: z.literal(true),
    id: z.string().uuid(),
  }),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const readsClaimProtectedModel = (input: unknown): boolean => {
  if (!isRecord(input)) {
    return false;
  }
  if (
    typeof input.model === 'string' &&
    CLAIM_PROTECTED_MODELS.has(input.model)
  ) {
    return true;
  }
  return (
    isRecord(input.join) &&
    Object.keys(input.join).some((model) => CLAIM_PROTECTED_MODELS.has(model))
  );
};

const writtenModelIsClaimProtected = (input: unknown): boolean =>
  isRecord(input) &&
  typeof input.model === 'string' &&
  CLAIM_PROTECTED_MODELS.has(input.model);

const assertOrganizationAdapterAccess = (
  method: string,
  input: unknown,
  scope: OrganizationClaimScope | undefined,
) => {
  if (
    ADAPTER_WRITE_METHODS.has(method) &&
    writtenModelIsClaimProtected(input)
  ) {
    denyBetterAuthOrganizationMutation();
  }
  if (
    ADAPTER_READ_METHODS.has(method) &&
    readsClaimProtectedModel(input) &&
    scope?.identity === undefined
  ) {
    throw new OrganizationClaimBridgeError(
      'claim-required',
      'A verified session claim is required for household identity reads',
    );
  }
};

const asBetterAuthRuntime = (auth: unknown): BetterAuthRuntime => {
  if (
    !isRecord(auth) ||
    typeof auth.handler !== 'function' ||
    !isRecord(auth.api) ||
    typeof auth.api.getSession !== 'function'
  ) {
    throw new OrganizationClaimBridgeError(
      'runtime-invalid',
      'Better Auth did not expose the required server runtime',
    );
  }
  return auth as unknown as BetterAuthRuntime;
};

const headersFromDirectApiInput = (input: unknown): Headers => {
  if (!isRecord(input) || !(input.headers instanceof Headers)) {
    throw new APIError('UNAUTHORIZED', {
      message: 'A verified server session is required',
    });
  }
  return input.headers;
};

const organizationClaimFailureResponse = (status: 401 | 503) =>
  Response.json(
    {
      code:
        status === 401
          ? 'ORGANIZATION_SESSION_REQUIRED'
          : 'ORGANIZATION_AUTHORIZATION_UNAVAILABLE',
      message:
        status === 401
          ? 'A verified server session is required'
          : 'Organization authorization is temporarily unavailable',
      status,
      title: status === 401 ? 'Unauthorized' : 'Service Unavailable',
      type: 'about:blank',
    },
    {
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/problem+json',
      },
      status,
    },
  );

const requestOrganizationPath = (request: Request, basePath: string) => {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith(`${basePath}/`)) {
    return undefined;
  }
  const path = pathname.slice(basePath.length);
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
};

const createOrganizationClaimBridge = (
  database: DBAdapterInstance,
  transactionRunner: BetterAuthOrganizationClaimBridge,
) => {
  const scopes = new AsyncLocalStorage<OrganizationClaimScope>();
  const runClaimTransaction = transactionRunner.run.bind(transactionRunner);

  const wrapAdapter = <Adapter extends DBAdapter | DBTransactionAdapter>(
    fallbackAdapter: Adapter,
  ): Adapter =>
    new Proxy(fallbackAdapter, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (property === 'transaction' && typeof value === 'function') {
          return async (
            work: (adapter: DBTransactionAdapter) => Promise<unknown>,
          ) => {
            const scope = scopes.getStore();
            if (scope !== undefined) {
              return work(wrapAdapter(scope.adapter));
            }
            return Reflect.apply(value, target, [
              (adapter: DBTransactionAdapter) => work(wrapAdapter(adapter)),
            ]) as Promise<unknown>;
          };
        }
        if (
          typeof property === 'string' &&
          (ADAPTER_READ_METHODS.has(property) ||
            ADAPTER_WRITE_METHODS.has(property)) &&
          typeof value === 'function'
        ) {
          return (...args: unknown[]) => {
            const scope = scopes.getStore();
            assertOrganizationAdapterAccess(property, args[0], scope);
            const selectedAdapter = scope?.adapter ?? target;
            const selectedMethod = Reflect.get(
              selectedAdapter,
              property,
              selectedAdapter,
            ) as unknown;
            if (typeof selectedMethod !== 'function') {
              throw new OrganizationClaimBridgeError(
                'transaction-unavailable',
                'The transaction-bound Better Auth adapter is unavailable',
              );
            }
            return Reflect.apply(selectedMethod, selectedAdapter, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  const wrappedDatabase: DBAdapterInstance = (options) =>
    wrapAdapter(database(options));

  const wrapRuntime = <TAuth>(
    auth: TAuth,
    options: BetterAuthOptions,
    basePath: string,
  ): TAuth => {
    const runtime = asBetterAuthRuntime(auth);
    const baseApi = runtime.api;
    const baseGetSession = baseApi.getSession.bind(baseApi);
    const baseHandler = runtime.handler.bind(auth);

    const runWithVerifiedOrganizationClaim = async <Result>(
      headers: Headers,
      work: () => Promise<Result>,
    ): Promise<Result> => {
      try {
        return await runClaimTransaction(options, async (transaction) => {
          if (
            !isRecord(transaction) ||
            !isRecord(transaction.adapter) ||
            typeof transaction.revalidateAndActivateClaims !== 'function'
          ) {
            throw new OrganizationClaimBridgeError(
              'transaction-unavailable',
              'The transaction-bound Better Auth adapter is unavailable',
            );
          }
          const scope: OrganizationClaimScope = {
            adapter: transaction.adapter,
          };
          return scopes.run(scope, async () => {
            let rawSession: unknown;
            try {
              rawSession = await baseGetSession({
                headers,
                query: {
                  disableCookieCache: true,
                  disableRefresh: true,
                },
              });
            } catch {
              throw new OrganizationClaimBridgeError(
                'session-unverified',
                'A verified server session is required',
              );
            }
            const verified =
              VerifiedOrganizationSessionSchema.safeParse(rawSession);
            if (
              !verified.success ||
              verified.data.session.userId !== verified.data.user.id
            ) {
              throw new OrganizationClaimBridgeError(
                'session-unverified',
                'A verified server session is required',
              );
            }
            const identity = Object.freeze({
              sessionId: verified.data.session.id,
              userId: verified.data.user.id,
            });
            await transaction.revalidateAndActivateClaims(identity);
            scope.identity = identity;
            return work();
          });
        });
      } catch (error) {
        if (error instanceof OrganizationClaimBridgeError) {
          throw error;
        }
        if (error instanceof APIError) {
          throw error;
        }
        throw new OrganizationClaimBridgeError(
          'transaction-unavailable',
          'Organization authorization is temporarily unavailable',
        );
      }
    };

    const api = new Proxy(baseApi, {
      get(target, property, receiver) {
        if (
          typeof property === 'string' &&
          RECIPIENT_INVITATION_API_METHODS.has(property)
        ) {
          return async () => denyBetterAuthRecipientInvitationRead();
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        if (
          typeof property !== 'string' ||
          !CLAIMED_ORGANIZATION_API_METHODS.has(property) ||
          typeof value !== 'function'
        ) {
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (input: unknown) =>
          runWithVerifiedOrganizationClaim(
            headersFromDirectApiInput(input),
            () => Reflect.apply(value, target, [input]) as Promise<unknown>,
          );
      },
    });

    const handler = async (request: Request): Promise<Response> => {
      const path = requestOrganizationPath(request, basePath);
      if (path === undefined || !CLAIMED_ORGANIZATION_PATHS.has(path)) {
        return baseHandler(request);
      }
      try {
        return await runWithVerifiedOrganizationClaim(request.headers, () =>
          baseHandler(request),
        );
      } catch (error) {
        if (
          error instanceof OrganizationClaimBridgeError &&
          error.code === 'session-unverified'
        ) {
          return organizationClaimFailureResponse(401);
        }
        return organizationClaimFailureResponse(503);
      }
    };

    return new Proxy(auth as object, {
      get(target, property, receiver) {
        if (property === 'api') {
          return api;
        }
        if (property === 'handler') {
          return handler;
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TAuth;
  };

  return Object.freeze({ database: wrappedDatabase, wrapRuntime });
};

export function createEmdoBetterAuth(
  configuration: EmdoBetterAuthConfiguration,
): ReturnType<typeof betterAuth>;
export function createEmdoBetterAuth<TAuth>(
  configuration: EmdoBetterAuthConfiguration,
  dependencies: EmdoBetterAuthDependencies<TAuth>,
): TAuth;
export function createEmdoBetterAuth<TAuth>(
  configuration: EmdoBetterAuthConfiguration,
  dependencies: EmdoBetterAuthDependencies<TAuth> = defaultDependencies as EmdoBetterAuthDependencies<TAuth>,
): TAuth {
  const validated = validateConfiguration(configuration);
  const organizationClaimBridge = createOrganizationClaimBridge(
    configuration.organizationClaimBridge.database,
    configuration.organizationClaimBridge,
  );
  const householdAuthorization = createHouseholdAuthorization();
  const passkeyPlugin = dependencies.passkeyFactory({
    origin: validated.baseURL,
    registration: { requireSession: true },
    rpID: new URL(validated.baseURL).hostname,
    rpName: validated.appName,
  });
  const organizationPlugin = dependencies.organizationFactory({
    ac: householdAuthorization.accessControl,
    allowUserToCreateOrganization: false,
    cancelPendingInvitationsOnReInvite: false,
    creatorRole: 'owner',
    disableOrganizationDeletion: true,
    dynamicAccessControl: { enabled: false },
    invitationExpiresIn: WEEK_SECONDS,
    organizationHooks: {
      beforeAcceptInvitation: async ({ invitation }) => {
        assertSingleHouseholdRole(invitation.role);
        denyBetterAuthOrganizationMutation();
      },
      beforeAddMember: async ({ member }) => {
        assertSingleHouseholdRole(member.role);
        denyBetterAuthOrganizationMutation();
      },
      beforeCancelInvitation: async () => {
        denyBetterAuthOrganizationMutation();
      },
      beforeCreateInvitation: async ({ invitation }) => {
        assertSingleHouseholdRole(invitation.role);
        denyBetterAuthOrganizationMutation();
      },
      beforeCreateOrganization: async () => {
        denyBetterAuthOrganizationMutation();
      },
      beforeDeleteOrganization: async () => {
        denyBetterAuthOrganizationMutation();
      },
      beforeRejectInvitation: async () => {
        denyBetterAuthOrganizationMutation();
      },
      beforeRemoveMember: async () => {
        denyBetterAuthOrganizationMutation();
      },
      beforeUpdateMemberRole: async ({ newRole }) => {
        assertSingleHouseholdRole(newRole);
        denyBetterAuthOrganizationMutation();
      },
      beforeUpdateOrganization: async () => {
        denyBetterAuthOrganizationMutation();
      },
    },
    requireEmailVerificationOnInvitation: true,
    roles: householdAuthorization.roles,
    // The DB adapter maps these default model keys to security-barrier read
    // views. Only the auth session stores an EMDO-specific physical field.
    schema: {
      invitation: {},
      member: {},
      organization: {},
      session: {
        fields: { activeOrganizationId: 'activeHouseholdId' },
      },
    },
    sendInvitationEmail: configuration.sendInvitationEmail,
  });

  const authOptions: BetterAuthOptions = {
    account: {
      accountLinking: {
        allowDifferentEmails: false,
        disableImplicitLinking: true,
        enabled: true,
      },
      encryptOAuthTokens: true,
      storeStateStrategy: 'database',
    },
    advanced: {
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
    },
    appName: validated.appName,
    basePath: '/api/auth',
    baseURL: validated.baseURL,
    database: organizationClaimBridge.database,
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const householdId =
              await configuration.organizationClaimBridge.resolveExactlyOneActiveHousehold(
                session.userId,
              );
            const parsedHouseholdId = z.uuid().safeParse(householdId);
            if (!parsedHouseholdId.success) return false;
            return {
              data: {
                ...session,
                activeOrganizationId: parsedHouseholdId.data.toLowerCase(),
              },
            };
          },
        },
      },
    },
    disabledPaths: [...BLOCKED_ORGANIZATION_MUTATION_PATHS],
    emailAndPassword: {
      autoSignIn: false,
      disableSignUp: true,
      enabled: true,
      maxPasswordLength: 128,
      minPasswordLength: 12,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: configuration.sendPasswordResetEmail,
    },
    emailVerification: {
      autoSignInAfterVerification: false,
      expiresIn: HOUR_SECONDS,
      sendOnSignIn: true,
      sendOnSignUp: false,
      sendVerificationEmail: configuration.sendVerificationEmail,
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (
          context.path !== undefined &&
          BLOCKED_ORGANIZATION_MUTATION_PATHS.includes(context.path)
        ) {
          denyBetterAuthOrganizationMutation();
        }
      }),
    },
    plugins: [passkeyPlugin, organizationPlugin],
    rateLimit: {
      enabled: true,
      storage: 'database',
    },
    secret: configuration.secret,
    session: {
      cookieCache: { enabled: false },
      disableSessionRefresh: false,
      // Rolling expiry only. EMDO APIs must use EmdoRotatingSessionBoundary
      // for the locked token-rotation requirement.
      expiresIn: WEEK_SECONDS,
      freshAge: 5 * 60,
      storeSessionInDatabase: true,
      updateAge: DAY_SECONDS,
    },
    socialProviders:
      validated.googleIdentity === undefined
        ? {}
        : {
            google: {
              clientId: validated.googleIdentity.clientId,
              clientSecret: validated.googleIdentity.clientSecret,
              disableDefaultScope: true,
              disableIdTokenSignIn: true,
              disableImplicitSignUp: true,
              disableSignUp: true,
              scope: [...GOOGLE_IDENTITY_SCOPES],
            },
          },
    trustedOrigins: validated.trustedOrigins,
  };
  const auth = dependencies.authFactory(authOptions);
  return organizationClaimBridge.wrapRuntime(auth, authOptions, '/api/auth');
}

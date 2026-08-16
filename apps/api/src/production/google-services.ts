import { randomBytes } from 'node:crypto';

import {
  PostgresEncryptedGoogleCalendarGrantStore,
  PostgresGoogleOAuthAuditSink,
  PostgresGoogleOAuthAuthorizationEpochStore,
  PostgresGoogleOAuthDisconnectOperationStore,
  PostgresGoogleOAuthFlowStore,
  PostgresGoogleOAuthGrantLease,
  checkPostgresGoogleOAuthRuntimeReadiness,
  createDatabaseClient,
  type DurableRepositoryPrincipal,
  type EmdoDatabaseClient,
  type PostgresGoogleOAuthRequestAuthority,
} from '@emdo/db/api';
import {
  GoogleCalendarOAuthError,
  GoogleOAuthAuthorizationStartFailure,
  GoogleOAuthDisconnectFailure,
} from '@emdo/integrations/google-oauth-routes';
import {
  FetchGoogleOAuthTransport,
  createGoogleCalendarOAuthServerRuntime,
  type GoogleCalendarOAuthServerRuntime,
  type GoogleCalendarOAuthServerRuntimeOptions,
  type VaultKeyProvider,
} from '@emdo/integrations/google-oauth-server';
import {
  IdempotencyKeySchema,
  ProviderWriteApprovalBindingSchema,
  ProviderWriteOperationScopeSchema,
  TrustedProviderWriteAuthorityResolutionSchema,
  UuidSchema,
  type ProviderWriteApprovalBinding,
  type ProviderWriteOperationScope,
  type TrustedProviderWriteAuthorityResolution,
} from '@emdo/contracts';
import type { CalendarProposalStateReader } from '@emdo/domains/scheduler';
import type {
  ApprovedCalendarWriteContext,
  GoogleCalendarConditionalGateway,
  GoogleCalendarWriteCommand,
} from '@emdo/integrations/google-calendar';
import { z } from 'zod';

import { ApiProblem } from '../problem.js';
import { AuthenticatedPrincipalSchema } from '../schemas.js';
import type { ApiServices, AuthenticatedPrincipal } from '../services/contracts.js';
import { createProductionGoogleCalendarVaultKeyProvider } from './google-calendar-vault-keyring.js';
import type { ProductionApiServiceBinding } from './unavailable-services.js';

type DatabasePool = EmdoDatabaseClient['scopedPool'];
type LeaseDatabaseRuntime = Pick<EmdoDatabaseClient, 'scopedPool' | 'close'>;
type DisposableVaultKeyProvider = VaultKeyProvider & { dispose(): void };

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
const GoogleClientIdSchema = z
  .string()
  .min(20)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/u);
const GoogleClientSecretSchema = z
  .string()
  .min(16)
  .max(1_024)
  .regex(/^\S+$/u)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return !(code <= 31 || (code >= 127 && code <= 159));
    }),
  );
const CanonicalSecretSchema = z
  .string()
  .min(43)
  .max(86)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .refine((value) => {
    const decoded = Buffer.from(value, 'base64url');
    const valid =
      decoded.byteLength >= 32 &&
      decoded.byteLength <= 64 &&
      decoded.toString('base64url') === value;
    decoded.fill(0);
    return valid;
  });
const EnvironmentSchema = z
  .strictObject({
    databaseUrl: z
      .url()
      .max(2_048)
      .refine((value) =>
        ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
      ),
    publicOrigin: ExactHttpsOriginSchema,
    identityClientId: GoogleClientIdSchema,
    calendarClientId: GoogleClientIdSchema,
    calendarClientSecret: GoogleClientSecretSchema,
    stateSigningKey: CanonicalSecretSchema,
    vaultKeyring: z.string().min(1).max(8_192),
  })
  .refine(
    (value) => value.identityClientId !== value.calendarClientId,
    'Calendar and identity OAuth clients must be distinct',
  );

const PrincipalWithPrivateSpaceSchema = AuthenticatedPrincipalSchema.extend({
  privateSpaceId: UuidSchema,
});
const BeginInputSchema = z.strictObject({
  principal: PrincipalWithPrivateSpaceSchema,
  purpose: z.enum(['calendar-read', 'calendar-event-write']),
  requestId: UuidSchema,
  idempotencyKey: IdempotencyKeySchema,
});
const CallbackInputSchema = z
  .strictObject({
    principal: PrincipalWithPrivateSpaceSchema,
    code: z.string().min(1).max(8_192).optional(),
    state: z.string().min(16).max(8_192),
    error: z.string().min(1).max(160).optional(),
    errorDescription: z.string().max(1_000).optional(),
    requestId: UuidSchema,
  })
  .superRefine((value, context) => {
    if ((value.code === undefined) === (value.error === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['code'],
        message: 'OAuth callback requires exactly one provider outcome',
      });
    }
  });
const DisconnectInputSchema = z.strictObject({
  principal: PrincipalWithPrivateSpaceSchema,
  requestId: UuidSchema,
  idempotencyKey: IdempotencyKeySchema,
});
const ProposalTargetReaderFactoryInputSchema = z.strictObject({
  principal: PrincipalWithPrivateSpaceSchema,
  requestId: UuidSchema,
  authorityResolution: TrustedProviderWriteAuthorityResolutionSchema,
});
const ConditionalGatewayFactoryInputSchema = z.strictObject({
  principal: PrincipalWithPrivateSpaceSchema,
  operationScope: ProviderWriteOperationScopeSchema,
  approvalBinding: ProviderWriteApprovalBindingSchema,
});

const unavailable = (): ApiProblem =>
  new ApiProblem({
    status: 503,
    code: 'connector-unavailable',
    title: 'Google Calendar connector unavailable',
    detail: 'Google Calendar is not available for this request.',
  });

const authorityUnavailable = (): ApiProblem =>
  new ApiProblem({
    status: 403,
    code: 'google-calendar-authority-unavailable',
    title: 'Google Calendar authority unavailable',
    detail: 'The current authenticated private-space authority is unavailable.',
  });

const googleProblem = (error: unknown): ApiProblem => {
  if (error instanceof GoogleOAuthDisconnectFailure) {
    return new ApiProblem({
      status: 409,
      code: 'google-oauth-idempotency-conflict',
      title: 'Google Calendar disconnect unavailable',
      detail:
        'The idempotency key is already bound to another disconnect request.',
    });
  }
  if (error instanceof GoogleOAuthAuthorizationStartFailure) {
    return new ApiProblem({
      status: error.reason === 'conflict' ? 409 : 410,
      code:
        error.reason === 'conflict'
          ? 'google-oauth-idempotency-conflict'
          : 'google-oauth-start-expired',
      title: 'Google Calendar authorization unavailable',
      detail:
        error.reason === 'conflict'
          ? 'The idempotency key is already bound to another authorization request.'
          : 'The authorization start is no longer available.',
    });
  }
  if (!(error instanceof GoogleCalendarOAuthError)) return unavailable();
  const mapping: Readonly<
    Record<GoogleCalendarOAuthError['code'], readonly [number, string, string]>
  > = {
    'invalid-oauth-state': [400, 'invalid-oauth-state', 'Invalid OAuth state'],
    'oauth-state-binding-mismatch': [
      403,
      'oauth-state-binding-mismatch',
      'OAuth state authority mismatch',
    ],
    'oauth-state-expired': [410, 'oauth-state-expired', 'OAuth state expired'],
    'oauth-grant-invalidated': [
      409,
      'oauth-grant-invalidated',
      'Google Calendar authorization changed',
    ],
    'authorization-denied': [
      403,
      'authorization-denied',
      'Google Calendar authorization denied',
    ],
    'provider-unavailable': [
      502,
      'google-provider-unavailable',
      'Google provider unavailable',
    ],
    'invalid-provider-response': [
      502,
      'invalid-provider-response',
      'Invalid Google provider response',
    ],
    'required-scope-not-granted': [
      409,
      'required-scope-not-granted',
      'Required Google Calendar permission missing',
    ],
    'unexpected-provider-scope': [
      409,
      'unexpected-provider-scope',
      'Unexpected Google Calendar permission',
    ],
    'scope-reconciliation-required': [
      409,
      'scope-reconciliation-required',
      'Google Calendar permissions require reconciliation',
    ],
    'offline-grant-unavailable': [
      409,
      'offline-grant-unavailable',
      'Offline Google Calendar authorization unavailable',
    ],
    'credential-write-conflict': [
      409,
      'credential-write-conflict',
      'Google Calendar credential changed',
    ],
    'calendar-reconnect-required': [
      409,
      'calendar-reconnect-required',
      'Google Calendar reconnection required',
    ],
    'calendar-not-connected': [
      409,
      'calendar-not-connected',
      'Google Calendar is not connected',
    ],
    'connector-unavailable': [
      503,
      'connector-unavailable',
      'Google Calendar connector unavailable',
    ],
  };
  const selected = mapping[error.code];
  return new ApiProblem({
    status: selected[0],
    code: selected[1],
    title: selected[2],
    detail: error.message,
  });
};

export interface ProductionGoogleConnectorDependencies {
  fetch: typeof globalThis.fetch;
  createLeaseDatabase(input: {
    readonly connectionString: string;
    readonly applicationName: string;
    readonly max: number;
  }): LeaseDatabaseRuntime;
  createVaultKeyProvider(
    encoded: string,
    forbiddenKeyMaterials: readonly Uint8Array[],
  ): DisposableVaultKeyProvider;
  createOAuthTransport(
    fetch: typeof globalThis.fetch,
  ): GoogleCalendarOAuthServerRuntimeOptions['transport'];
  createRuntime(
    options: GoogleCalendarOAuthServerRuntimeOptions,
  ): GoogleCalendarOAuthServerRuntime;
  createFlowStore(
    pool: DatabasePool,
    authority: PostgresGoogleOAuthRequestAuthority,
  ): GoogleCalendarOAuthServerRuntimeOptions['flowStore'];
  createAuthorizationEpochStore(
    pool: DatabasePool,
    authority: PostgresGoogleOAuthRequestAuthority,
  ): GoogleCalendarOAuthServerRuntimeOptions['authorizationEpochStore'];
  createDisconnectOperationStore(
    pool: DatabasePool,
    authority: PostgresGoogleOAuthRequestAuthority,
  ): GoogleCalendarOAuthServerRuntimeOptions['disconnectOperationStore'];
  createGrantStore(
    pool: DatabasePool,
    authority: PostgresGoogleOAuthRequestAuthority,
  ): GoogleCalendarOAuthServerRuntimeOptions['grantStore'];
  createGrantLease(
    pool: DatabasePool,
    authority: PostgresGoogleOAuthRequestAuthority,
  ): GoogleCalendarOAuthServerRuntimeOptions['grantLease'];
  createAuditSink(
    pool: DatabasePool,
    principal: DurableRepositoryPrincipal,
    privateSpaceId: string,
  ): GoogleCalendarOAuthServerRuntimeOptions['audit'];
  checkReady(pool: DatabasePool): Promise<boolean>;
  clock(): Date;
  entropy(length: number): Uint8Array;
}

const defaultDependencies: ProductionGoogleConnectorDependencies =
  Object.freeze({
    fetch: globalThis.fetch.bind(globalThis),
    createLeaseDatabase: (input: {
      readonly connectionString: string;
      readonly applicationName: string;
      readonly max: number;
    }) => createDatabaseClient(input),
    createVaultKeyProvider: (
      encoded: string,
      forbiddenKeyMaterials: readonly Uint8Array[],
    ) =>
      createProductionGoogleCalendarVaultKeyProvider(
        encoded,
        forbiddenKeyMaterials,
      ),
    createOAuthTransport: (fetch: typeof globalThis.fetch) =>
      new FetchGoogleOAuthTransport({ fetch }),
    createRuntime: (options: GoogleCalendarOAuthServerRuntimeOptions) =>
      createGoogleCalendarOAuthServerRuntime(options),
    createFlowStore: (
      pool: DatabasePool,
      authority: PostgresGoogleOAuthRequestAuthority,
    ) => new PostgresGoogleOAuthFlowStore(pool, authority),
    createAuthorizationEpochStore: (
      pool: DatabasePool,
      authority: PostgresGoogleOAuthRequestAuthority,
    ) => new PostgresGoogleOAuthAuthorizationEpochStore(pool, authority),
    createDisconnectOperationStore: (
      pool: DatabasePool,
      authority: PostgresGoogleOAuthRequestAuthority,
    ) => new PostgresGoogleOAuthDisconnectOperationStore(pool, authority),
    createGrantStore: (
      pool: DatabasePool,
      authority: PostgresGoogleOAuthRequestAuthority,
    ) => new PostgresEncryptedGoogleCalendarGrantStore(pool, authority),
    createGrantLease: (
      pool: DatabasePool,
      authority: PostgresGoogleOAuthRequestAuthority,
    ) => new PostgresGoogleOAuthGrantLease(pool, authority),
    createAuditSink: (
      pool: DatabasePool,
      principal: DurableRepositoryPrincipal,
      privateSpaceId: string,
    ) => new PostgresGoogleOAuthAuditSink(pool, principal, privateSpaceId),
    checkReady: (pool: DatabasePool) =>
      checkPostgresGoogleOAuthRuntimeReadiness(pool),
    clock: () => new Date(),
    entropy: (length: number) => randomBytes(length),
  });

export interface ProductionGoogleConnectorComposition {
  readonly binding?: ProductionApiServiceBinding<ApiServices['google']>;
  readonly calendarProposalTargetReaders?: RequestScopedGoogleCalendarProposalReaderFactory;
  readonly calendarConditionalGateways?: RequestScopedGoogleCalendarConditionalGatewayFactory;
  readonly close?: () => Promise<void>;
}

export interface RequestScopedGoogleCalendarProposalReaderFactory {
  createProposalTargetReader(input: Readonly<{
    principal: AuthenticatedPrincipal;
    requestId: string;
    authorityResolution: TrustedProviderWriteAuthorityResolution;
  }>): CalendarProposalStateReader | undefined;
}

type ProposalTargetReaderFactoryInput = Parameters<
  RequestScopedGoogleCalendarProposalReaderFactory['createProposalTargetReader']
>[0];

export interface RequestScopedGoogleCalendarConditionalGatewayFactory {
  createConditionalGateway(input: Readonly<{
    principal: AuthenticatedPrincipal;
    operationScope: ProviderWriteOperationScope;
    approvalBinding: ProviderWriteApprovalBinding;
  }>): GoogleCalendarConditionalGateway | undefined;
}

type ConditionalGatewayFactoryInput = Parameters<
  RequestScopedGoogleCalendarConditionalGatewayFactory['createConditionalGateway']
>[0];

const operationScopesMatch = (
  left: ProviderWriteOperationScope,
  right: ProviderWriteOperationScope,
): boolean =>
  left.requestId === right.requestId &&
  left.sessionId === right.sessionId &&
  left.householdId === right.householdId &&
  left.userId === right.userId &&
  left.spaceAccessGrantId === right.spaceAccessGrantId &&
  left.authorizationScopeFingerprint === right.authorizationScopeFingerprint;

const approvalBindingsMatch = (
  left: ProviderWriteApprovalBinding,
  right: ProviderWriteApprovalBinding,
): boolean =>
  left.decisionId === right.decisionId &&
  left.userId === right.userId &&
  left.agentId === right.agentId &&
  left.runId === right.runId &&
  left.capabilityId === right.capabilityId &&
  left.capabilityFingerprint === right.capabilityFingerprint &&
  left.disclosureGrantId === right.disclosureGrantId &&
  left.payloadHash === right.payloadHash &&
  left.idempotencyTtlMs === right.idempotencyTtlMs &&
  left.authorityBinding.kind === right.authorityBinding.kind &&
  left.authorityBinding.householdId === right.authorityBinding.householdId &&
  left.authorityBinding.privateSpaceId === right.authorityBinding.privateSpaceId &&
  left.authorityBinding.authorizationScopeFingerprint ===
    right.authorityBinding.authorizationScopeFingerprint &&
  left.authorityBinding.providerGrantReference ===
    right.authorityBinding.providerGrantReference &&
  left.authorityBinding.authorizationEpoch ===
    right.authorityBinding.authorizationEpoch;

export const createProductionGoogleConnectorBinding = (
  input: {
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly pool: DatabasePool;
  },
  dependencies: ProductionGoogleConnectorDependencies = defaultDependencies,
): ProductionGoogleConnectorComposition => {
  const parsed = EnvironmentSchema.safeParse({
    databaseUrl: input.environment.EMDO_API_DATABASE_URL,
    publicOrigin: input.environment.EMDO_PUBLIC_ORIGIN,
    identityClientId: input.environment.EMDO_GOOGLE_IDENTITY_CLIENT_ID,
    calendarClientId: input.environment.EMDO_GOOGLE_CALENDAR_OAUTH_CLIENT_ID,
    calendarClientSecret:
      input.environment.EMDO_GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET,
    stateSigningKey:
      input.environment.EMDO_GOOGLE_CALENDAR_OAUTH_STATE_SIGNING_KEY_B64URL,
    vaultKeyring: input.environment.EMDO_GOOGLE_CALENDAR_VAULT_KEYRING_B64URL,
  });
  if (!parsed.success) return Object.freeze({});

  const stateSigningKey = Buffer.from(parsed.data.stateSigningKey, 'base64url');
  let keyProvider: DisposableVaultKeyProvider | undefined;
  let transport: GoogleCalendarOAuthServerRuntimeOptions['transport'];
  let leaseDatabase: LeaseDatabaseRuntime;
  try {
    keyProvider = dependencies.createVaultKeyProvider(
      parsed.data.vaultKeyring,
      [stateSigningKey],
    );
    transport = dependencies.createOAuthTransport(dependencies.fetch);
    // The session advisory lease is held across provider I/O while the route's
    // durable stores need independent clients. Keeping it off the main API pool
    // prevents a full set of leases from circularly starving those stores.
    leaseDatabase = dependencies.createLeaseDatabase({
      connectionString: parsed.data.databaseUrl,
      applicationName: 'emdo-api-google-oauth-lease',
      max: 2,
    });
  } catch {
    keyProvider?.dispose();
    stateSigningKey.fill(0);
    return Object.freeze({});
  }

  let closing = false;
  let activeOperations = 0;
  let resolveDrain: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;
  const configuration = Object.freeze({
    calendarClientId: parsed.data.calendarClientId,
    calendarClientSecret: parsed.data.calendarClientSecret,
    identityClientId: parsed.data.identityClientId,
    redirectUri: `${parsed.data.publicOrigin}/api/v1/connectors/google/callback`,
  });

  const isReady = async (): Promise<boolean> => {
    if (closing || (await dependencies.checkReady(input.pool)) !== true) {
      return false;
    }
    return (
      !closing &&
      (await dependencies.checkReady(leaseDatabase.scopedPool)) === true
    );
  };

  const withRuntime = async <Value>(
    principalInput: unknown,
    requestIdInput: unknown,
    operation: (runtime: GoogleCalendarOAuthServerRuntime) => Promise<Value>,
  ): Promise<Value> => {
    if (closing) throw unavailable();
    activeOperations += 1;
    try {
      const parsedPrincipal =
        PrincipalWithPrivateSpaceSchema.safeParse(principalInput);
      if (!parsedPrincipal.success) throw authorityUnavailable();
      const requestId = UuidSchema.safeParse(requestIdInput);
      if (!requestId.success) throw authorityUnavailable();
      const principal = parsedPrincipal.data;
      const actor = Object.freeze({
        userId: principal.userId,
        householdId: principal.householdId,
        privateSpaceId: principal.privateSpaceId,
        sessionId: principal.sessionId,
      });
      const authority = Object.freeze({ ...actor, requestId: requestId.data });
      const durablePrincipal = Object.freeze({
        userId: principal.userId,
        householdId: principal.householdId,
        sessionId: principal.sessionId,
        requestId: requestId.data,
      });
      let runtime: GoogleCalendarOAuthServerRuntime;
      try {
        runtime = dependencies.createRuntime({
          configuration: {
            ...configuration,
            stateSigningKey,
          },
          flowStore: dependencies.createFlowStore(input.pool, authority),
          authorizationEpochStore: dependencies.createAuthorizationEpochStore(
            input.pool,
            authority,
          ),
          disconnectOperationStore: dependencies.createDisconnectOperationStore(
            input.pool,
            authority,
          ),
          grantStore: dependencies.createGrantStore(input.pool, authority),
          keyProvider: keyProvider!,
          transport,
          calendarFetch: dependencies.fetch,
          audit: dependencies.createAuditSink(
            input.pool,
            durablePrincipal,
            principal.privateSpaceId,
          ),
          grantLease: dependencies.createGrantLease(
            leaseDatabase.scopedPool,
            authority,
          ),
          clock: dependencies.clock,
          entropy: dependencies.entropy,
        });
      } catch (error) {
        throw googleProblem(error);
      }
      try {
        return await operation(runtime);
      } finally {
        runtime.dispose();
      }
    } finally {
      activeOperations -= 1;
      if (closing && activeOperations === 0) {
        const resolve = resolveDrain;
        resolveDrain = undefined;
        resolve?.();
      }
    }
  };

  const calendarProposalTargetReaders: RequestScopedGoogleCalendarProposalReaderFactory =
    Object.freeze({
      createProposalTargetReader: (rawInput: ProposalTargetReaderFactoryInput) => {
        const request = ProposalTargetReaderFactoryInputSchema.safeParse(rawInput);
        if (!request.success || closing) return undefined;
        const principal = request.data.principal;
        const operationScope = request.data.authorityResolution.operationScope;
        const authorityBinding = request.data.authorityResolution.authorityBinding;
        if (
          operationScope.requestId !== request.data.requestId ||
          operationScope.sessionId !== principal.sessionId ||
          operationScope.householdId !== principal.householdId ||
          operationScope.userId !== principal.userId ||
          operationScope.spaceAccessGrantId !== principal.spaceAccessGrantId ||
          operationScope.authorizationScopeFingerprint !==
            principal.collectionAuthorizationScopeFingerprint ||
          authorityBinding.householdId !== principal.householdId ||
          authorityBinding.privateSpaceId !== principal.privateSpaceId ||
          authorityBinding.authorizationScopeFingerprint !==
            principal.collectionAuthorizationScopeFingerprint
        ) {
          return undefined;
        }
        return Object.freeze({
          readTargetState: async (
            target: Parameters<CalendarProposalStateReader['readTargetState']>[0],
          ) => {
            if (!(await isReady())) throw unavailable();
            try {
              return await withRuntime(
                principal,
                request.data.requestId,
                (runtime) =>
                  runtime.calendar
                    .createProposalTargetReader({
                      actor: {
                        userId: principal.userId,
                        householdId: principal.householdId,
                        privateSpaceId: principal.privateSpaceId,
                        sessionId: principal.sessionId,
                      },
                      request: {
                        requestId: request.data.requestId,
                        spaceAccessGrantId: principal.spaceAccessGrantId,
                        authorizationScopeFingerprint:
                          principal.collectionAuthorizationScopeFingerprint,
                      },
                      authorityResolution: request.data.authorityResolution,
                    })
                    .readTargetState(target),
              );
            } catch (error) {
              if (error instanceof ApiProblem) throw error;
              throw googleProblem(error);
            }
          },
        });
      },
    });

  const calendarConditionalGateways: RequestScopedGoogleCalendarConditionalGatewayFactory =
    Object.freeze({
      createConditionalGateway: (rawInput: ConditionalGatewayFactoryInput) => {
        const request = ConditionalGatewayFactoryInputSchema.safeParse(rawInput);
        if (!request.success || closing) return undefined;
        const principal = request.data.principal;
        const operationScope = request.data.operationScope;
        const approvalBinding = request.data.approvalBinding;
        const authorityBinding = approvalBinding.authorityBinding;
        if (
          operationScope.sessionId !== principal.sessionId ||
          operationScope.householdId !== principal.householdId ||
          operationScope.userId !== principal.userId ||
          operationScope.spaceAccessGrantId !== principal.spaceAccessGrantId ||
          operationScope.authorizationScopeFingerprint !==
            principal.collectionAuthorizationScopeFingerprint ||
          approvalBinding.userId !== principal.userId ||
          approvalBinding.agentId !== 'scheduler' ||
          approvalBinding.capabilityId !== 'google-calendar.event.create' ||
          authorityBinding.householdId !== principal.householdId ||
          authorityBinding.privateSpaceId !== principal.privateSpaceId ||
          authorityBinding.authorizationScopeFingerprint !==
            principal.collectionAuthorizationScopeFingerprint
        ) {
          return undefined;
        }
        const withConditionalGateway = async <Value>(
          command: GoogleCalendarWriteCommand,
          authorization: ApprovedCalendarWriteContext,
          operation: (
            gateway: GoogleCalendarConditionalGateway,
          ) => Promise<Value>,
        ): Promise<Value> => {
          if (
            !operationScopesMatch(
              authorization.providerWriteOperationScope,
              operationScope,
            ) ||
            !approvalBindingsMatch(
              authorization.approvalBinding,
              approvalBinding,
            )
          ) {
            throw authorityUnavailable();
          }
          if (!(await isReady())) throw unavailable();
          try {
            return await withRuntime(
              principal,
              operationScope.requestId,
              (runtime) =>
                operation(
                  runtime.calendar.createConditionalGateway({
                    actor: {
                      userId: principal.userId,
                      householdId: principal.householdId,
                      privateSpaceId: principal.privateSpaceId,
                      sessionId: principal.sessionId,
                    },
                    authorizationScopeFingerprint:
                      principal.collectionAuthorizationScopeFingerprint,
                  }),
                ),
            );
          } catch (error) {
            if (error instanceof ApiProblem) throw error;
            throw googleProblem(error);
          }
        };
        return Object.freeze({
          readCurrent: (
            command: GoogleCalendarWriteCommand,
            authorization: ApprovedCalendarWriteContext,
          ) =>
            withConditionalGateway(command, authorization, (gateway) =>
              gateway.readCurrent(command, authorization),
            ),
          applyConditionalExactlyOnce: (
            command: GoogleCalendarWriteCommand,
            authorization: ApprovedCalendarWriteContext,
          ) =>
            withConditionalGateway(command, authorization, (gateway) =>
              gateway.applyConditionalExactlyOnce(command, authorization),
            ),
          readBack: (
            command: GoogleCalendarWriteCommand,
            authorization: ApprovedCalendarWriteContext,
          ) =>
            withConditionalGateway(command, authorization, (gateway) =>
              gateway.readBack(command, authorization),
            ),
        });
      },
    });

  const service: ApiServices['google'] = Object.freeze({
    beginAuthorization: async (
      rawInput: Parameters<ApiServices['google']['beginAuthorization']>[0],
    ) => {
      const request = BeginInputSchema.safeParse(rawInput);
      if (!request.success) {
        const hasPrivateSpace =
          rawInput !== null &&
          typeof rawInput === 'object' &&
          'principal' in rawInput &&
          rawInput.principal !== null &&
          typeof rawInput.principal === 'object' &&
          'privateSpaceId' in rawInput.principal &&
          rawInput.principal.privateSpaceId !== undefined;
        throw hasPrivateSpace ? unavailable() : authorityUnavailable();
      }
      try {
        return await withRuntime(
          request.data.principal,
          request.data.requestId,
          (runtime) =>
            runtime.routes.beginAuthorization({
              actor: {
                userId: request.data.principal.userId,
                householdId: request.data.principal.householdId,
                privateSpaceId: request.data.principal.privateSpaceId,
                sessionId: request.data.principal.sessionId,
              },
              purpose: request.data.purpose,
              idempotencyKey: request.data.idempotencyKey,
            }),
        );
      } catch (error) {
        if (error instanceof ApiProblem) throw error;
        throw googleProblem(error);
      }
    },
    completeAuthorization: async (
      rawInput: Parameters<ApiServices['google']['completeAuthorization']>[0],
    ) => {
      const request = CallbackInputSchema.safeParse(rawInput);
      if (!request.success) {
        const principal =
          rawInput !== null && typeof rawInput === 'object'
            ? (rawInput as { principal?: { privateSpaceId?: unknown } })
                .principal
            : undefined;
        throw principal?.privateSpaceId === undefined
          ? authorityUnavailable()
          : unavailable();
      }
      try {
        const result = await withRuntime(
          request.data.principal,
          request.data.requestId,
          (runtime) =>
            runtime.routes.handleCallback({
              actor: {
                userId: request.data.principal.userId,
                householdId: request.data.principal.householdId,
                privateSpaceId: request.data.principal.privateSpaceId,
                sessionId: request.data.principal.sessionId,
              },
              state: request.data.state,
              ...(request.data.code === undefined
                ? {
                    error: request.data.error!,
                    ...(request.data.errorDescription === undefined
                      ? {}
                      : { errorDescription: request.data.errorDescription }),
                  }
                : { code: request.data.code }),
            }),
        );
        return Object.freeze({
          status: 'connected' as const,
          connectionId: result.grantReference,
          grantedPurposes: result.grantedPurposes,
        });
      } catch (error) {
        if (
          error instanceof GoogleCalendarOAuthError &&
          error.code === 'authorization-denied'
        ) {
          return Object.freeze({ status: 'denied' as const });
        }
        if (error instanceof ApiProblem) throw error;
        throw googleProblem(error);
      }
    },
    disconnect: async (
      rawInput: Parameters<ApiServices['google']['disconnect']>[0],
    ) => {
      const request = DisconnectInputSchema.safeParse(rawInput);
      if (!request.success) {
        const principal =
          rawInput !== null && typeof rawInput === 'object'
            ? (rawInput as { principal?: { privateSpaceId?: unknown } })
                .principal
            : undefined;
        throw principal?.privateSpaceId === undefined
          ? authorityUnavailable()
          : unavailable();
      }
      try {
        return await withRuntime(
          request.data.principal,
          request.data.requestId,
          (runtime) =>
            runtime.routes.disconnect({
              actor: {
                userId: request.data.principal.userId,
                householdId: request.data.principal.householdId,
                privateSpaceId: request.data.principal.privateSpaceId,
                sessionId: request.data.principal.sessionId,
              },
              idempotencyKey: request.data.idempotencyKey,
            }),
        );
      } catch (error) {
        if (error instanceof ApiProblem) throw error;
        throw googleProblem(error);
      }
    },
  });

  const close = (): Promise<void> => {
    if (closePromise === undefined) {
      closing = true;
      closePromise = (async () => {
        if (activeOperations > 0) {
          await new Promise<void>((resolve) => {
            resolveDrain = resolve;
          });
        }
        try {
          keyProvider!.dispose();
        } finally {
          stateSigningKey.fill(0);
          await leaseDatabase.close();
        }
      })();
    }
    return closePromise;
  };

  return Object.freeze({
    binding: Object.freeze({
      service,
      check: isReady,
    }),
    calendarProposalTargetReaders,
    calendarConditionalGateways,
    close,
  });
};

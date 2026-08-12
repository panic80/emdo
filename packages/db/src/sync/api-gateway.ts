import { createHash, createPublicKey, KeyObject } from 'node:crypto';

import {
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  SyncOperationSchema,
  UuidSchema,
  deepFreeze,
  type SyncOperation,
} from '@emdo/contracts';
import { z } from 'zod';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  DurableRepositoryError,
  firstResultRow,
  lockDurableScope,
  parseDurablePrincipal,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';
import { CanonicalSyncUploadValidator } from './operations.js';
import { PostgresSyncRepository } from './postgres-repository.js';
import { SyncUploadProcessor } from './processor.js';
import { SyncTokenService } from './token.js';

const MAXIMUM_TOKEN_TTL_SECONDS = 300;
const TOKEN_CLOCK_SKEW_SECONDS = 5;
const MAXIMUM_PREVIOUS_KEYS = 2;

const KeyIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const PublicOriginSchema = z
  .url({ protocol: /^https$/u })
  .max(512)
  .refine((value) => new URL(value).origin === value);
const PowerSyncEndpointSchema = z
  .url({ protocol: /^https$/u })
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  });
const PrincipalSchema = z.strictObject({
  userId: UuidSchema,
  sessionId: UuidSchema,
  householdId: UuidSchema,
  role: z.enum(['owner', 'member']),
  emailVerified: z.literal(true),
  spaceAccessGrantId: UuidSchema,
});
const RegistrationInputSchema = z.strictObject({
  clientId: UuidSchema,
  displayName: z.string().trim().min(1).max(120),
  principal: PrincipalSchema,
  requestId: UuidSchema,
  idempotencyKey: IdempotencyKeySchema,
});
const TokenInputSchema = z.strictObject({
  clientId: UuidSchema,
  principal: PrincipalSchema,
  requestId: UuidSchema,
});
const ApplyInputSchema = z.strictObject({
  clientId: UuidSchema,
  operations: z.array(SyncOperationSchema).max(1_000),
  principal: PrincipalSchema,
  requestId: UuidSchema,
  idempotencyKey: IdempotencyKeySchema,
});
const ConflictDetailSchema = z.strictObject({
  field: z.string().trim().min(1).max(200),
  material: z.boolean(),
});
const AppliedOutcomeSchema = z.strictObject({
  operationId: UuidSchema,
  status: z.literal('applied'),
  revision: z.number().int().positive().safe(),
  resolution: z.enum(['created', 'applied', 'merged', 'ignored', 'duplicate']),
  conflicts: z.array(ConflictDetailSchema).max(0),
  replayed: z.boolean(),
});
const ConflictOutcomeSchema = z
  .strictObject({
    operationId: UuidSchema,
    status: z.literal('conflict'),
    code: z.enum([
      'entity-exists',
      'entity-not-found',
      'revision-mismatch',
      'tombstoned',
      'mutation-invalid',
      'repository-rejected',
      'domain-operation-invalid',
      'domain-operation-unsupported',
      'base-revision-unavailable',
      'base-state-mismatch',
      'material-conflict',
      'idempotency-key-reused',
      'operation-in-progress',
    ]),
    disposition: z.enum(['terminal', 'retryable']),
    currentRevision: z.number().int().positive().safe().optional(),
    conflicts: z.array(ConflictDetailSchema).max(32),
    replayed: z.boolean(),
  })
  .superRefine((value, context) => {
    const expectedDisposition =
      value.code === 'operation-in-progress' ? 'retryable' : 'terminal';
    if (value.disposition !== expectedDisposition) {
      context.addIssue({
        code: 'custom',
        path: ['disposition'],
        message: 'Sync conflict disposition does not match its code',
      });
    }
  });
const BlockedOutcomeSchema = z
  .strictObject({
    operationId: UuidSchema,
    status: z.literal('blocked'),
    code: z.enum([
      'authorization-revoked',
      'dependency-missing',
      'dependency-failed',
      'dependency-cycle',
    ]),
    dependencyOperationId: UuidSchema.optional(),
    disposition: z.enum(['terminal', 'retryable']),
    conflicts: z.array(ConflictDetailSchema).max(0),
    replayed: z.literal(false),
  })
  .superRefine((value, context) => {
    const expectedDisposition =
      value.code === 'dependency-missing' ? 'retryable' : 'terminal';
    if (value.disposition !== expectedDisposition) {
      context.addIssue({
        code: 'custom',
        path: ['disposition'],
        message: 'Sync block disposition does not match its code',
      });
    }
  });
const OperationOutcomeSchema = z.discriminatedUnion('status', [
  AppliedOutcomeSchema,
  ConflictOutcomeSchema,
  BlockedOutcomeSchema,
]);
const RegistrationResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  clientId: UuidSchema,
  status: z.literal('registered'),
  replayed: z.boolean(),
});
const UploadResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  clientId: UuidSchema,
  results: z.array(OperationOutcomeSchema).max(1_000),
});
const RegisteredClientRowSchema = z.strictObject({
  id: UuidSchema,
  household_id: UuidSchema,
  user_id: UuidSchema,
  display_name: z.string().trim().min(1).max(120),
});

export type PostgresSyncGatewayErrorCode =
  | 'sync-authorization-revoked'
  | 'sync-configuration-invalid'
  | 'sync-idempotency-conflict'
  | 'sync-operation-in-progress'
  | 'sync-result-invalid';

class PostgresSyncGatewayError extends Error {
  constructor(
    readonly code: PostgresSyncGatewayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PostgresSyncGatewayError';
  }
}

export interface SyncGatewayPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly householdId: string;
  readonly role: 'owner' | 'member';
  readonly emailVerified: true;
  readonly spaceAccessGrantId: string;
}

export interface PostgresSyncGatewayKeyRing {
  readonly current: {
    readonly kid: string;
    readonly privateKey: KeyObject;
  };
  readonly previous: readonly {
    readonly kid: string;
    readonly publicKey: KeyObject;
    readonly retiredAt: string;
    readonly verifyUntil: string;
  }[];
}

export interface PostgresSyncGatewayRuntimeOptions {
  /** Structural pg pool; lifecycle/close ownership stays with API composition. */
  readonly pool: DatabasePool;
  readonly publicOrigin: string;
  /** Must be exactly `${publicOrigin}/powersync`. */
  readonly powerSyncEndpoint: string;
  /** Already-decoded and bounded by the API environment adapter. */
  readonly keyRing: PostgresSyncGatewayKeyRing;
  readonly clock?: { now(): Date };
  readonly tokenIdFactory?: () => string;
}

export interface PostgresSyncGatewayRuntime {
  readonly gateway: {
    registerClient(input: {
      readonly clientId: string;
      readonly displayName: string;
      readonly principal: SyncGatewayPrincipal;
      readonly requestId: string;
      readonly idempotencyKey: string;
    }): Promise<z.output<typeof RegistrationResponseSchema>>;
    issueToken(input: {
      readonly clientId: string;
      readonly principal: SyncGatewayPrincipal;
      readonly requestId: string;
    }): Promise<{
      readonly schemaVersion: 1;
      readonly endpoint: string;
      readonly token: string;
      readonly expiresAt: string;
      readonly writeScope: {
        readonly clientId: string;
        readonly spaces: readonly {
          readonly id: string;
          readonly visibility: 'private' | 'shared';
          readonly originalOwnerUserId: string;
        }[];
      };
    }>;
    applyOperations(input: {
      readonly clientId: string;
      readonly operations: readonly SyncOperation[];
      readonly principal: SyncGatewayPrincipal;
      readonly requestId: string;
      readonly idempotencyKey: string;
    }): Promise<z.output<typeof UploadResponseSchema>>;
  };
  readonly jwks: { getPublicJwks(): Promise<unknown> };
  readonly checkReady: () => Promise<boolean>;
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
};

const fingerprint = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

const asDurablePrincipal = (input: {
  readonly principal: z.output<typeof PrincipalSchema>;
  readonly requestId: string;
}): Readonly<DurableRepositoryPrincipal> =>
  parseDurablePrincipal({
    userId: input.principal.userId,
    sessionId: input.principal.sessionId,
    requestId: input.requestId,
    householdId: input.principal.householdId,
  });

const rollbackQuietly = async (client: DatabaseClient) => {
  try {
    await client.query('rollback');
  } catch {
    // Preserve the authoritative failure.
  }
};

const beginScopedTransaction = async (
  client: DatabaseClient,
  principal: Readonly<DurableRepositoryPrincipal>,
) => {
  await client.query('begin');
  await client.query('set local row_security = on');
  await client.query("set local statement_timeout = '30s'");
  await client.query("set local lock_timeout = '5s'");
  await client.query(
    `select set_config('emdo.user_id', $1, true),
            set_config('emdo.session_id', $2, true),
            set_config('emdo.request_id', $3, true)`,
    [principal.userId, principal.sessionId, principal.requestId],
  );
  await lockDurableScope(client, { householdId: principal.householdId });
};

type RequestKind = 'apply-operations' | 'register-client';

const isTerminalUpload = (response: z.output<typeof UploadResponseSchema>) =>
  response.results.every(
    (result) =>
      result.status === 'applied' || result.disposition === 'terminal',
  );

const executePayloadBound = async <Response>(input: {
  readonly pool: DatabasePool;
  readonly principal: Readonly<DurableRepositoryPrincipal>;
  readonly clientId: string;
  readonly requestKind: RequestKind;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly responseSchema: z.ZodType<Response>;
  readonly isTerminal: (response: Response) => boolean;
  readonly execute: () => Promise<Response>;
}): Promise<{ readonly response: Response; readonly replayed: boolean }> => {
  const client = await input.pool.connect();
  const lockIdentity = `${input.principal.householdId}:${input.principal.userId}:${input.clientId}:${input.requestKind}:${input.idempotencyKey}`;
  let transactionActive = false;
  let sessionLocked = false;
  let destroyConnection = false;
  try {
    await beginScopedTransaction(client, input.principal);
    transactionActive = true;
    const lock = firstResultRow(
      await client.query(
        `select pg_catalog.pg_try_advisory_lock(
           pg_catalog.hashtextextended($1, 0)
         ) as locked`,
        [lockIdentity],
      ),
    );
    if (lock?.locked !== true) {
      throw new PostgresSyncGatewayError(
        'sync-operation-in-progress',
        'An exact synchronization request is already in progress',
      );
    }
    sessionLocked = true;
    const stored = firstResultRow(
      await client.query(
        `select request_fingerprint, response
           from emdo.sync_api_request_receipts
          where household_id = $1 and user_id = $2 and client_id = $3
            and request_kind = $4 and idempotency_key = $5`,
        [
          input.principal.householdId,
          input.principal.userId,
          input.clientId,
          input.requestKind,
          input.idempotencyKey,
        ],
      ),
    );
    if (stored !== undefined) {
      if (
        !Sha256Schema.safeParse(stored.request_fingerprint).success ||
        stored.request_fingerprint !== input.requestFingerprint
      ) {
        throw new PostgresSyncGatewayError(
          'sync-idempotency-conflict',
          'The synchronization idempotency key is already bound',
        );
      }
      if (stored.response !== null && stored.response !== undefined) {
        const parsed = input.responseSchema.safeParse(stored.response);
        if (!parsed.success) {
          throw new PostgresSyncGatewayError(
            'sync-result-invalid',
            'Stored synchronization response is malformed',
          );
        }
        await client.query('commit');
        transactionActive = false;
        return { response: parsed.data, replayed: true };
      }
    } else {
      const inserted = firstResultRow(
        await client.query(
          `insert into emdo.sync_api_request_receipts
             (household_id, user_id, client_id, request_kind, idempotency_key,
              initial_request_id, latest_request_id, request_fingerprint,
              response, recorded_at, completed_at, retain_until)
           values ($1, $2, $3, $4, $5, $6, $6, $7, null,
                   pg_catalog.statement_timestamp(), null,
                   pg_catalog.statement_timestamp() + interval '90 days')
           returning id`,
          [
            input.principal.householdId,
            input.principal.userId,
            input.clientId,
            input.requestKind,
            input.idempotencyKey,
            input.principal.requestId,
            input.requestFingerprint,
          ],
        ),
      );
      if (inserted === undefined) {
        throw new PostgresSyncGatewayError(
          'sync-result-invalid',
          'Synchronization request binding could not be persisted',
        );
      }
    }
    await client.query('commit');
    transactionActive = false;

    const parsedResponse = input.responseSchema.safeParse(
      await input.execute(),
    );
    if (!parsedResponse.success) {
      throw new PostgresSyncGatewayError(
        'sync-result-invalid',
        'Synchronization service returned a malformed result',
      );
    }
    if (input.isTerminal(parsedResponse.data)) {
      await beginScopedTransaction(client, input.principal);
      transactionActive = true;
      const completed = firstResultRow(
        await client.query(
          `update emdo.sync_api_request_receipts
              set latest_request_id = $7, response = $8::jsonb,
                  completed_at = pg_catalog.clock_timestamp()
            where household_id = $1 and user_id = $2 and client_id = $3
              and request_kind = $4 and idempotency_key = $5
              and request_fingerprint = $6 and response is null
            returning id`,
          [
            input.principal.householdId,
            input.principal.userId,
            input.clientId,
            input.requestKind,
            input.idempotencyKey,
            input.requestFingerprint,
            input.principal.requestId,
            parsedResponse.data,
          ],
        ),
      );
      if (completed === undefined) {
        throw new PostgresSyncGatewayError(
          'sync-result-invalid',
          'Synchronization response could not be completed',
        );
      }
      await client.query('commit');
      transactionActive = false;
    }
    return { response: parsedResponse.data, replayed: false };
  } catch (error) {
    if (transactionActive) await rollbackQuietly(client);
    if (
      error instanceof DurableRepositoryError &&
      error.code === 'authorization-revoked'
    ) {
      throw new PostgresSyncGatewayError(
        'sync-authorization-revoked',
        'Synchronization authority is no longer active',
      );
    }
    throw error;
  } finally {
    if (sessionLocked) {
      try {
        const unlocked = firstResultRow(
          await client.query(
            `select pg_catalog.pg_advisory_unlock(
               pg_catalog.hashtextextended($1, 0)
             ) as unlocked`,
            [lockIdentity],
          ),
        );
        destroyConnection = unlocked?.unlocked !== true;
      } catch {
        destroyConnection = true;
      }
    }
    client.release(destroyConnection);
  }
};

const validateKeyRing = (input: PostgresSyncGatewayKeyRing, now: Date) => {
  const currentKid = KeyIdSchema.safeParse(input.current.kid);
  if (
    !currentKid.success ||
    !(input.current.privateKey instanceof KeyObject) ||
    input.current.privateKey.type !== 'private' ||
    input.current.privateKey.asymmetricKeyType !== 'rsa' ||
    (input.current.privateKey.asymmetricKeyDetails?.modulusLength ?? 0) <
      2_048 ||
    input.previous.length > MAXIMUM_PREVIOUS_KEYS ||
    !Number.isFinite(now.getTime())
  ) {
    throw new PostgresSyncGatewayError(
      'sync-configuration-invalid',
      'Synchronization key ring is invalid',
    );
  }
  const seen = new Set([currentKid.data]);
  const previous = input.previous.map((entry) => {
    const kid = KeyIdSchema.safeParse(entry.kid);
    const retiredAt = IsoDateTimeSchema.safeParse(entry.retiredAt);
    const verifyUntil = IsoDateTimeSchema.safeParse(entry.verifyUntil);
    if (
      !kid.success ||
      seen.has(kid.data) ||
      !(entry.publicKey instanceof KeyObject) ||
      entry.publicKey.type !== 'public' ||
      entry.publicKey.asymmetricKeyType !== 'rsa' ||
      (entry.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2_048 ||
      !retiredAt.success ||
      !verifyUntil.success ||
      Date.parse(entry.retiredAt) > now.getTime() ||
      Date.parse(entry.verifyUntil) <= now.getTime() ||
      Date.parse(entry.verifyUntil) - Date.parse(entry.retiredAt) <
        (MAXIMUM_TOKEN_TTL_SECONDS + TOKEN_CLOCK_SKEW_SECONDS) * 1_000
    ) {
      throw new PostgresSyncGatewayError(
        'sync-configuration-invalid',
        'Synchronization key ring is invalid',
      );
    }
    seen.add(kid.data);
    return {
      kid: kid.data,
      publicKey: entry.publicKey,
      verifyUntil: entry.verifyUntil,
    };
  });
  return {
    current: {
      kid: currentKid.data,
      privateKey: input.current.privateKey,
      publicKey: createPublicKey(input.current.privateKey),
    },
    previous,
  };
};

export const createPostgresSyncGatewayRuntime = (
  options: PostgresSyncGatewayRuntimeOptions,
): PostgresSyncGatewayRuntime => {
  const publicOrigin = PublicOriginSchema.safeParse(options.publicOrigin);
  const endpoint = PowerSyncEndpointSchema.safeParse(options.powerSyncEndpoint);
  const clock = options.clock ?? { now: () => new Date() };
  let now: Date;
  try {
    now = clock.now();
  } catch {
    now = new Date(Number.NaN);
  }
  if (
    !publicOrigin.success ||
    !endpoint.success ||
    endpoint.data !== `${publicOrigin.data}/powersync`
  ) {
    throw new PostgresSyncGatewayError(
      'sync-configuration-invalid',
      'Synchronization endpoint configuration is invalid',
    );
  }
  const keyRing = validateKeyRing(options.keyRing, now);
  const repository = new PostgresSyncRepository(options.pool);
  const tokenService = new SyncTokenService({
    issuer: publicOrigin.data,
    keyId: keyRing.current.kid,
    privateKey: keyRing.current.privateKey,
    verificationKeys: new Map([
      [keyRing.current.kid, keyRing.current.publicKey],
      ...keyRing.previous.map((entry) => [entry.kid, entry.publicKey] as const),
    ]),
    repository,
    clock,
    ttlSeconds: MAXIMUM_TOKEN_TTL_SECONDS,
    maximumTtlSeconds: MAXIMUM_TOKEN_TTL_SECONDS,
    clockSkewSeconds: TOKEN_CLOCK_SKEW_SECONDS,
    ...(options.tokenIdFactory === undefined
      ? {}
      : { idFactory: options.tokenIdFactory }),
  });
  const processor = new SyncUploadProcessor({
    validator: new CanonicalSyncUploadValidator({
      currentSchemaVersion: 1,
      clock,
    }),
    repository,
  });

  const gateway: PostgresSyncGatewayRuntime['gateway'] = {
    registerClient: async (rawInput) => {
      const input = RegistrationInputSchema.parse(rawInput);
      const principal = asDurablePrincipal(input);
      const result = await executePayloadBound({
        pool: options.pool,
        principal,
        clientId: input.clientId,
        requestKind: 'register-client',
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint({
          schemaVersion: 1,
          clientId: input.clientId,
          displayName: input.displayName,
        }),
        responseSchema: RegistrationResponseSchema,
        isTerminal: () => true,
        execute: async () => {
          const registered = RegisteredClientRowSchema.safeParse(
            await repository.registerClient({
              principal: {
                userId: input.principal.userId,
                sessionId: input.principal.sessionId,
                requestId: input.requestId,
                householdId: input.principal.householdId,
              },
              clientId: input.clientId,
              displayName: input.displayName,
            }),
          );
          if (
            !registered.success ||
            registered.data.id !== input.clientId ||
            registered.data.user_id !== input.principal.userId ||
            registered.data.household_id !== input.principal.householdId ||
            registered.data.display_name !== input.displayName
          ) {
            throw new PostgresSyncGatewayError(
              'sync-idempotency-conflict',
              'Sync client registration is bound to different data',
            );
          }
          return {
            schemaVersion: 1 as const,
            clientId: input.clientId,
            status: 'registered' as const,
            replayed: false,
          };
        },
      });
      if (result.replayed) {
        const access = await repository.resolveSyncAccess({
          sessionId: input.principal.sessionId,
          clientId: input.clientId,
        });
        if (
          access === undefined ||
          access.userId !== input.principal.userId ||
          access.householdId !== input.principal.householdId
        ) {
          throw new PostgresSyncGatewayError(
            'sync-authorization-revoked',
            'Registered sync client is no longer active',
          );
        }
      }
      return deepFreeze({ ...result.response, replayed: result.replayed });
    },
    issueToken: async (rawInput) => {
      const input = TokenInputSchema.parse(rawInput);
      const issued = await tokenService.issue({
        sessionId: input.principal.sessionId,
        clientId: input.clientId,
      });
      if (
        issued.claims.userId !== input.principal.userId ||
        issued.claims.householdId !== input.principal.householdId ||
        issued.claims.role !== input.principal.role ||
        issued.claims.clientId !== input.clientId
      ) {
        throw new PostgresSyncGatewayError(
          'sync-authorization-revoked',
          'Synchronization token scope no longer matches the request',
        );
      }
      return deepFreeze({
        schemaVersion: 1 as const,
        endpoint: endpoint.data,
        token: issued.token,
        expiresAt: issued.expiresAt,
        writeScope: {
          clientId: input.clientId,
          spaces: issued.claims.spaces,
        },
      });
    },
    applyOperations: async (rawInput) => {
      const input = ApplyInputSchema.parse(rawInput);
      const principal = asDurablePrincipal(input);
      const result = await executePayloadBound({
        pool: options.pool,
        principal,
        clientId: input.clientId,
        requestKind: 'apply-operations',
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint({
          schemaVersion: 1,
          clientId: input.clientId,
          operations: input.operations,
        }),
        responseSchema: UploadResponseSchema,
        isTerminal: isTerminalUpload,
        execute: async () =>
          UploadResponseSchema.parse(
            await processor.process(
              { operations: input.operations },
              {
                authenticatedClientId: input.clientId,
                authenticatedSessionId: input.principal.sessionId,
                requestId: input.requestId,
              },
            ),
          ),
      });
      return result.response;
    },
  };

  return Object.freeze({
    gateway,
    jwks: Object.freeze({
      getPublicJwks: async () => {
        const nowMs = clock.now().getTime();
        if (!Number.isFinite(nowMs)) {
          throw new PostgresSyncGatewayError(
            'sync-configuration-invalid',
            'Synchronization clock is invalid',
          );
        }
        const permittedKids = new Set([
          keyRing.current.kid,
          ...keyRing.previous
            .filter((entry) => Date.parse(entry.verifyUntil) > nowMs)
            .map((entry) => entry.kid),
        ]);
        return deepFreeze({
          keys: tokenService
            .getPublicJwks()
            .keys.filter((key) => permittedKids.has(key.kid)),
        });
      },
    }),
    checkReady: async () => {
      let client: DatabaseClient | undefined;
      let ready = false;
      try {
        client = await options.pool.connect();
        const row = firstResultRow(
          await client.query(
            `/* sync_gateway_ready */
             select (
               session_user = 'emdo_api_login'
               and current_user = session_user
               and pg_catalog.pg_has_role(
                 session_user, 'emdo_app', 'USAGE'
               )
               and not pg_catalog.pg_has_role(
                 session_user, 'emdo_sync_revision_executor', 'USAGE'
               )
               and exists (
                 select
                   from pg_catalog.pg_auth_members as membership
                   join pg_catalog.pg_roles as granted_role
                     on granted_role.oid = membership.roleid
                   join pg_catalog.pg_roles as member_role
                     on member_role.oid = membership.member
                  where member_role.rolname = session_user
                    and granted_role.rolname = 'emdo_app'
                    and membership.inherit_option is true
                    and membership.set_option is true
                    and membership.admin_option is false
               )
               and exists (
                 select
                   from pg_catalog.pg_roles as role
                  where role.rolname = session_user
                    and role.rolcanlogin is true
                    and role.rolinherit is true
                    and role.rolsuper is false
                    and role.rolbypassrls is false
                    and role.rolcreatedb is false
                    and role.rolcreaterole is false
                    and role.rolreplication is false
               )
               and pg_catalog.has_schema_privilege(
                 session_user, 'emdo', 'USAGE'
               )
               and pg_catalog.has_function_privilege(
                 session_user,
                 pg_catalog.to_regprocedure(
                   'emdo.lock_active_request_scope(uuid,uuid,uuid)'
                 ),
                 'EXECUTE'
               )
               and pg_catalog.has_function_privilege(
                 session_user,
                 pg_catalog.to_regprocedure(
                   'emdo.resolve_sync_access(uuid,uuid)'
                 ),
                 'EXECUTE'
               )
               and not pg_catalog.has_function_privilege(
                 session_user,
                 pg_catalog.to_regprocedure(
                   'emdo.capture_sync_entity_revision()'
                 ),
                 'EXECUTE'
               )
               and not pg_catalog.has_function_privilege(
                 session_user,
                 pg_catalog.to_regprocedure(
                   'emdo.complete_sync_api_request_receipt()'
                 ),
                 'EXECUTE'
               )
               and not exists (
                 select
                   from (
                     values
                       ('emdo.sync_clients', 'SELECT'),
                       ('emdo.sync_clients', 'INSERT'),
                       ('emdo.sync_clients', 'UPDATE'),
                       ('emdo.sync_entities', 'SELECT'),
                       ('emdo.sync_entities', 'INSERT'),
                       ('emdo.sync_entities', 'UPDATE'),
                       ('emdo.sync_entity_revisions', 'SELECT'),
                       ('emdo.sync_operation_receipts', 'SELECT'),
                       ('emdo.sync_api_request_receipts', 'SELECT')
                   ) as required(relation_name, privilege_name)
                   left join pg_catalog.pg_class as relation
                     on relation.oid = pg_catalog.to_regclass(
                       required.relation_name
                     )
                  where relation.oid is null
                     or relation.relrowsecurity is not true
                     or relation.relforcerowsecurity is not true
                     or not pg_catalog.has_table_privilege(
                       session_user,
                       relation.oid,
                       required.privilege_name
                     )
               )
               and not exists (
                 select
                   from (
                     values
                       ('emdo.sync_clients', 'DELETE'),
                       ('emdo.sync_clients', 'TRUNCATE'),
                       ('emdo.sync_clients', 'REFERENCES'),
                       ('emdo.sync_clients', 'TRIGGER'),
                       ('emdo.sync_clients', 'MAINTAIN'),
                       ('emdo.sync_entities', 'DELETE'),
                       ('emdo.sync_entities', 'TRUNCATE'),
                       ('emdo.sync_entities', 'REFERENCES'),
                       ('emdo.sync_entities', 'TRIGGER'),
                       ('emdo.sync_entities', 'MAINTAIN'),
                       ('emdo.sync_entity_revisions', 'INSERT'),
                       ('emdo.sync_entity_revisions', 'UPDATE'),
                       ('emdo.sync_entity_revisions', 'DELETE'),
                       ('emdo.sync_entity_revisions', 'TRUNCATE'),
                       ('emdo.sync_entity_revisions', 'REFERENCES'),
                       ('emdo.sync_entity_revisions', 'TRIGGER'),
                       ('emdo.sync_entity_revisions', 'MAINTAIN'),
                       ('emdo.sync_operation_receipts', 'UPDATE'),
                       ('emdo.sync_operation_receipts', 'DELETE'),
                       ('emdo.sync_operation_receipts', 'TRUNCATE'),
                       ('emdo.sync_operation_receipts', 'REFERENCES'),
                       ('emdo.sync_operation_receipts', 'TRIGGER'),
                       ('emdo.sync_operation_receipts', 'MAINTAIN'),
                       ('emdo.sync_api_request_receipts', 'DELETE'),
                       ('emdo.sync_api_request_receipts', 'TRUNCATE'),
                       ('emdo.sync_api_request_receipts', 'REFERENCES'),
                       ('emdo.sync_api_request_receipts', 'TRIGGER'),
                       ('emdo.sync_api_request_receipts', 'MAINTAIN')
                   ) as denied(relation_name, privilege_name)
                  where pg_catalog.has_table_privilege(
                    session_user,
                    denied.relation_name,
                    denied.privilege_name
                  )
               )
               and not exists (
                 select
                   from (
                     values
                       ('emdo.sync_operation_receipts', 'household_id', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'space_id', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'original_owner_user_id', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'client_id', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'operation_id', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'fingerprint', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'entity_type', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'entity_id', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'mutation_kind', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'base_revision', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'outcome_status', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'outcome_code', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'outcome_resolution', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'outcome_disposition', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'conflict_details', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'current_revision', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'resulting_revision', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'recorded_at', 'INSERT'),
                       ('emdo.sync_operation_receipts', 'retain_until', 'INSERT'),
                       ('emdo.sync_api_request_receipts', 'household_id', 'INSERT'),
                       ('emdo.sync_api_request_receipts', 'user_id', 'INSERT'),
                       ('emdo.sync_api_request_receipts', 'client_id', 'INSERT'),
                       ('emdo.sync_api_request_receipts', 'request_kind', 'INSERT'),
                       ('emdo.sync_api_request_receipts', 'idempotency_key', 'INSERT'),
                       ('emdo.sync_api_request_receipts', 'initial_request_id', 'INSERT'),
                       ('emdo.sync_api_request_receipts', 'latest_request_id', 'INSERT'),
                       ('emdo.sync_api_request_receipts', 'request_fingerprint', 'INSERT'),
                       ('emdo.sync_api_request_receipts', 'response', 'INSERT'),
                       ('emdo.sync_api_request_receipts', 'recorded_at', 'INSERT'),
                       ('emdo.sync_api_request_receipts', 'completed_at', 'INSERT'),
                       ('emdo.sync_api_request_receipts', 'retain_until', 'INSERT'),
                       ('emdo.sync_api_request_receipts', 'latest_request_id', 'UPDATE'),
                       ('emdo.sync_api_request_receipts', 'response', 'UPDATE'),
                       ('emdo.sync_api_request_receipts', 'completed_at', 'UPDATE')
                   ) as required(relation_name, column_name, privilege_name)
                  where not pg_catalog.has_column_privilege(
                    session_user,
                    required.relation_name,
                    required.column_name,
                    required.privilege_name
                  )
               )
               and not exists (
                 select
                   from (
                     values
                       ('id'),
                       ('household_id'),
                       ('user_id'),
                       ('client_id'),
                       ('request_kind'),
                       ('idempotency_key'),
                       ('initial_request_id'),
                       ('request_fingerprint'),
                       ('recorded_at'),
                       ('retain_until'),
                       ('compaction_after'),
                       ('compaction_policy')
                   ) as denied(column_name)
                  where pg_catalog.has_column_privilege(
                    session_user,
                    'emdo.sync_api_request_receipts',
                    denied.column_name,
                    'UPDATE'
                  )
               )
             ) as ready`,
          ),
        );
        ready = row?.ready === true;
      } catch {
        ready = false;
      }
      try {
        client?.release();
      } catch {
        return false;
      }
      return ready;
    },
  });
};

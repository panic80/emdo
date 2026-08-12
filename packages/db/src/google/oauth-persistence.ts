import { randomUUID } from 'node:crypto';

import {
  OpaqueReferenceSchema,
  Sha256Schema,
  TrustedProviderWriteAuthorityResolutionSchema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly,
  type JsonValue,
} from '@emdo/contracts';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import {
  beginDurableTransaction,
  firstResultRow,
  lockDurableScope,
  parseDurablePrincipal,
  withDurableTransaction,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';

const ActorSchema = z.strictObject({
  userId: UuidSchema,
  householdId: UuidSchema,
  privateSpaceId: UuidSchema,
  sessionId: UuidSchema,
});
const StateIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const CalendarScopeSchema = z.enum([
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events',
]);
const FlowSchema = z
  .strictObject({
    id: StateIdSchema,
    actor: ActorSchema,
    redirectUri: z
      .url()
      .refine((value) => new URL(value).protocol === 'https:'),
    purpose: z.enum(['calendar-read', 'calendar-event-write']),
    requestedScopes: z.array(CalendarScopeSchema).min(1).max(4),
    credentialRevisionAtStart: z.number().int().safe().positive().nullable(),
    authorizationEpochAtStart: z.number().int().safe().nonnegative(),
    codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u),
    createdAt: z.date(),
    expiresAt: z.date(),
  })
  .superRefine((flow, context) => {
    const lifetime = flow.expiresAt.getTime() - flow.createdAt.getTime();
    if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 600_000) {
      context.addIssue({
        code: 'custom',
        message: 'OAuth flow lifetime is invalid',
      });
    }
    if (new Set(flow.requestedScopes).size !== flow.requestedScopes.length) {
      context.addIssue({
        code: 'custom',
        message: 'OAuth scopes must be unique',
      });
    }
  });
const EpochAdvanceSchema = z.strictObject({
  actor: ActorSchema,
  expectedEpoch: z.number().int().safe().nonnegative(),
});
const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]*$/u);
const ProviderGrantReferenceSchema = OpaqueReferenceSchema.min(16).max(160);
const EncryptedPayloadSchema = z.strictObject({
  algorithm: z.literal('aes-256-gcm'),
  aadVersion: z.literal(1),
  ciphertext: Base64UrlSchema.max(43_691),
  nonce: Base64UrlSchema.min(1).max(64),
  authenticationTag: Base64UrlSchema.min(1).max(64),
  wrappedKey: Base64UrlSchema.min(1).max(4_096),
  keyVersion: z.string().trim().min(1).max(512),
});
const VaultScopeSchema = z.strictObject({
  householdId: UuidSchema,
  spaceId: UuidSchema,
  recordId: z.string().trim().min(1).max(512),
  provider: z.literal('google'),
  grantType: z.literal('calendar-authorization'),
});
const GrantLookupSchema = z.strictObject({
  scope: VaultScopeSchema,
  ownerUserId: UuidSchema,
});
const GrantCasSchema = GrantLookupSchema.extend({
  expectedRevision: z.number().int().safe().positive().nullable(),
  authorizationEpoch: z.number().int().safe().nonnegative(),
  providerGrantReference: ProviderGrantReferenceSchema,
  payload: EncryptedPayloadSchema,
  now: z.date(),
});
const GrantDeleteSchema = GrantLookupSchema.extend({
  expectedRevision: z.number().int().safe().positive(),
});
const ProviderAuthorityResolverInputSchema = z.strictObject({
  requestId: UuidSchema,
  runId: UuidSchema,
  sessionId: UuidSchema,
  userId: UuidSchema,
  householdId: UuidSchema,
  agentId: z.literal('scheduler'),
  spaceAccessGrantId: UuidSchema,
  disclosureGrantId: UuidSchema,
  decisionId: UuidSchema,
  capabilityId: z.enum([
    'google-calendar.event.create',
    'google-calendar.event.update',
    'google-calendar.event.delete',
  ]),
  capabilityFingerprint: Sha256Schema,
});

export type PostgresGoogleOAuthActor = Readonly<z.output<typeof ActorSchema>>;
export type PostgresGoogleOAuthFlowRecord = DeepReadonly<
  z.output<typeof FlowSchema>
>;
export type PostgresEncryptedVaultPayload = Readonly<
  z.output<typeof EncryptedPayloadSchema>
>;
export type PostgresGoogleCalendarVaultScope = Readonly<
  z.output<typeof VaultScopeSchema>
>;

const principalForActor = (
  actor: PostgresGoogleOAuthActor,
): DurableRepositoryPrincipal => ({
  userId: actor.userId,
  householdId: actor.householdId,
  sessionId: actor.sessionId,
  requestId: randomUUID(),
});

const parseFlowRow = (
  row: Record<string, unknown>,
): PostgresGoogleOAuthFlowRecord =>
  deepFreeze(
    FlowSchema.parse({
      id: row.id,
      actor: {
        userId: row.original_owner_user_id,
        householdId: row.household_id,
        privateSpaceId: row.private_space_id,
        sessionId: row.session_id,
      },
      redirectUri: row.redirect_uri,
      purpose: row.purpose,
      requestedScopes: row.requested_scopes,
      credentialRevisionAtStart: row.credential_revision_at_start,
      authorizationEpochAtStart: row.authorization_epoch_at_start,
      codeVerifier: row.code_verifier,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at
          : new Date(String(row.created_at)),
      expiresAt:
        row.expires_at instanceof Date
          ? row.expires_at
          : new Date(String(row.expires_at)),
    }),
  ) as PostgresGoogleOAuthFlowRecord;

export type PostgresGoogleOAuthFlowConsumeResult =
  | Readonly<{ status: 'consumed'; flow: PostgresGoogleOAuthFlowRecord }>
  | Readonly<{ status: 'missing' | 'expired' | 'binding-mismatch' }>;

/** Atomic, single-use PKCE flow persistence. */
export class PostgresGoogleOAuthFlowStore {
  constructor(private readonly pool: DatabasePool) {}

  async put(recordInput: PostgresGoogleOAuthFlowRecord): Promise<boolean> {
    const record = FlowSchema.parse(recordInput);
    return withDurableTransaction(
      this.pool,
      principalForActor(record.actor),
      {
        householdId: record.actor.householdId,
        spaceId: record.actor.privateSpaceId,
      },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `insert into emdo.google_oauth_flows
               (id, household_id, private_space_id, original_owner_user_id,
                session_id, redirect_uri, purpose, requested_scopes,
                credential_revision_at_start, authorization_epoch_at_start,
                code_verifier, created_at, expires_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
             on conflict (id) do nothing returning id`,
            [
              record.id,
              record.actor.householdId,
              record.actor.privateSpaceId,
              record.actor.userId,
              record.actor.sessionId,
              record.redirectUri,
              record.purpose,
              record.requestedScopes,
              record.credentialRevisionAtStart,
              record.authorizationEpochAtStart,
              record.codeVerifier,
              record.createdAt,
              record.expiresAt,
            ],
          ),
        );
        return row?.id === record.id;
      },
    );
  }

  async consume(input: {
    readonly id: string;
    readonly actor: PostgresGoogleOAuthActor;
  }): Promise<PostgresGoogleOAuthFlowConsumeResult> {
    const request = z
      .strictObject({ id: StateIdSchema, actor: ActorSchema })
      .parse(input);
    return withDurableTransaction(
      this.pool,
      principalForActor(request.actor),
      {
        householdId: request.actor.householdId,
        spaceId: request.actor.privateSpaceId,
      },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select status, flow
               from emdo.consume_google_oauth_flow($1, $2, $3, $4, $5)`,
            [
              request.id,
              request.actor.userId,
              request.actor.householdId,
              request.actor.privateSpaceId,
              request.actor.sessionId,
            ],
          ),
        );
        const status = z
          .enum(['consumed', 'missing', 'expired', 'binding-mismatch'])
          .parse(row?.status);
        if (status !== 'consumed') return deepFreeze({ status });
        const flow = z.record(z.string(), z.unknown()).parse(row?.flow);
        return deepFreeze({ status, flow: parseFlowRow(flow) });
      },
    );
  }

  async invalidateActor(actorInput: PostgresGoogleOAuthActor): Promise<number> {
    const actor = ActorSchema.parse(actorInput);
    return withDurableTransaction(
      this.pool,
      principalForActor(actor),
      { householdId: actor.householdId, spaceId: actor.privateSpaceId },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select emdo.invalidate_google_oauth_flows($1, $2, $3) as deleted`,
            [actor.userId, actor.householdId, actor.privateSpaceId],
          ),
        );
        return z.number().int().safe().nonnegative().parse(row?.deleted);
      },
    );
  }
}

/** Durable monotonic tombstone, independent of credential row lifetime. */
export class PostgresGoogleOAuthAuthorizationEpochStore {
  constructor(private readonly pool: DatabasePool) {}

  async load(actorInput: PostgresGoogleOAuthActor): Promise<number> {
    const actor = ActorSchema.parse(actorInput);
    return withDurableTransaction(
      this.pool,
      principalForActor(actor),
      { householdId: actor.householdId, spaceId: actor.privateSpaceId },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select emdo.load_google_oauth_authorization_epoch(
                      $1, $2, $3
                    ) as authorization_epoch`,
            [actor.userId, actor.householdId, actor.privateSpaceId],
          ),
        );
        return z
          .number()
          .int()
          .safe()
          .nonnegative()
          .parse(row?.authorization_epoch);
      },
    );
  }

  async advance(input: {
    readonly actor: PostgresGoogleOAuthActor;
    readonly expectedEpoch: number;
  }): Promise<
    | Readonly<{ status: 'advanced'; authorizationEpoch: number }>
    | Readonly<{ status: 'conflict' }>
  > {
    const request = EpochAdvanceSchema.parse(input);
    return withDurableTransaction(
      this.pool,
      principalForActor(request.actor),
      {
        householdId: request.actor.householdId,
        spaceId: request.actor.privateSpaceId,
      },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select emdo.advance_google_oauth_authorization_epoch(
                      $1, $2, $3, $4
                    ) as authorization_epoch`,
            [
              request.actor.userId,
              request.actor.householdId,
              request.actor.privateSpaceId,
              request.expectedEpoch,
            ],
          ),
        );
        if (row?.authorization_epoch == null) {
          return deepFreeze({ status: 'conflict' as const });
        }
        return deepFreeze({
          status: 'advanced' as const,
          authorizationEpoch: z
            .number()
            .int()
            .safe()
            .positive()
            .parse(row.authorization_epoch),
        });
      },
    );
  }
}

export interface PostgresEncryptedGoogleCalendarGrantRecord {
  readonly scope: PostgresGoogleCalendarVaultScope;
  readonly ownerUserId: string;
  readonly revision: number;
  readonly authorizationEpoch: number;
  readonly providerGrantReference: string;
  readonly payload: PostgresEncryptedVaultPayload;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Encrypted payload store; token material is never represented in columns. */
export class PostgresEncryptedGoogleCalendarGrantStore {
  readonly #principal: DurableRepositoryPrincipal;

  constructor(
    private readonly pool: DatabasePool,
    principal: DurableRepositoryPrincipal,
  ) {
    this.#principal = parseDurablePrincipal(principal);
  }

  async load(
    input: z.input<typeof GrantLookupSchema>,
  ): Promise<PostgresEncryptedGoogleCalendarGrantRecord | undefined> {
    const request = GrantLookupSchema.parse(input);
    this.#assertScope(request.scope, request.ownerUserId);
    return withDurableTransaction(
      this.pool,
      this.#principal,
      {
        householdId: request.scope.householdId,
        spaceId: request.scope.spaceId,
      },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select *
               from emdo.load_encrypted_google_calendar_grant(
                 $1, $2, $3, $4
               )`,
            [
              request.scope.recordId,
              request.scope.householdId,
              request.scope.spaceId,
              request.ownerUserId,
            ],
          ),
        );
        return row === undefined ? undefined : this.#parseGrant(row);
      },
    );
  }

  async compareAndSet(
    input: z.input<typeof GrantCasSchema>,
  ): Promise<
    | Readonly<{ status: 'stored'; revision: number }>
    | Readonly<{ status: 'conflict' }>
  > {
    const request = GrantCasSchema.parse(input);
    this.#assertScope(request.scope, request.ownerUserId);
    return withDurableTransaction(
      this.pool,
      this.#principal,
      {
        householdId: request.scope.householdId,
        spaceId: request.scope.spaceId,
      },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select emdo.compare_and_set_encrypted_google_calendar_grant(
                      $1, $2, $3, $4, $5, $6, $7, $8::jsonb
                    ) as revision`,
            [
              request.scope.recordId,
              request.scope.householdId,
              request.scope.spaceId,
              request.ownerUserId,
              request.expectedRevision,
              request.authorizationEpoch,
              request.providerGrantReference,
              request.payload as unknown as JsonValue,
            ],
          ),
        );
        if (row?.revision == null) {
          return deepFreeze({ status: 'conflict' as const });
        }
        return deepFreeze({
          status: 'stored' as const,
          revision: z.number().int().positive().parse(row.revision),
        });
      },
    );
  }

  async delete(input: z.input<typeof GrantDeleteSchema>): Promise<boolean> {
    const request = GrantDeleteSchema.parse(input);
    this.#assertScope(request.scope, request.ownerUserId);
    return withDurableTransaction(
      this.pool,
      this.#principal,
      {
        householdId: request.scope.householdId,
        spaceId: request.scope.spaceId,
      },
      async (client) => {
        const result = await client.query(
          `select emdo.delete_encrypted_google_calendar_grant(
                    $1, $2, $3, $4, $5
                  ) as deleted`,
          [
            request.scope.recordId,
            request.scope.householdId,
            request.scope.spaceId,
            request.ownerUserId,
            request.expectedRevision,
          ],
        );
        return firstResultRow(result)?.deleted === true;
      },
    );
  }

  #assertScope(
    scope: PostgresGoogleCalendarVaultScope,
    ownerUserId: string,
  ): void {
    if (
      scope.householdId !== this.#principal.householdId ||
      ownerUserId !== this.#principal.userId
    ) {
      throw new Error('Encrypted Calendar grant scope is unavailable');
    }
  }

  #parseGrant(
    row: Record<string, unknown>,
  ): PostgresEncryptedGoogleCalendarGrantRecord {
    return deepFreeze({
      scope: VaultScopeSchema.parse({
        householdId: row.household_id,
        spaceId: row.private_space_id,
        recordId: row.record_id,
        provider: row.provider,
        grantType: row.grant_type,
      }),
      ownerUserId: UuidSchema.parse(row.original_owner_user_id),
      revision: z.number().int().safe().positive().parse(row.revision),
      authorizationEpoch: z
        .number()
        .int()
        .safe()
        .nonnegative()
        .parse(row.authorization_epoch),
      providerGrantReference: ProviderGrantReferenceSchema.parse(
        row.provider_grant_reference,
      ),
      payload: EncryptedPayloadSchema.parse(row.encrypted_payload),
      createdAt: z.coerce.date().parse(row.created_at),
      updatedAt: z.coerce.date().parse(row.updated_at),
    });
  }
}

/** Resolves only the current request-bound, non-secret Calendar authority. */
export class PostgresGoogleCalendarProviderAuthorityResolver {
  readonly #principal: DurableRepositoryPrincipal;

  constructor(
    private readonly pool: DatabasePool,
    principal: DurableRepositoryPrincipal,
  ) {
    this.#principal = parseDurablePrincipal(principal);
  }

  async resolve(input: {
    readonly requestId: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly userId: string;
    readonly householdId: string;
    readonly agentId: string;
    readonly spaceAccessGrantId: string;
    readonly disclosureGrantId: string;
    readonly decisionId: string;
    readonly capabilityId: string;
    readonly capabilityFingerprint: string;
  }) {
    const request = ProviderAuthorityResolverInputSchema.parse(input);
    if (
      request.requestId !== this.#principal.requestId ||
      request.sessionId !== this.#principal.sessionId ||
      request.userId !== this.#principal.userId ||
      request.householdId !== this.#principal.householdId
    ) {
      return undefined;
    }
    return withDurableTransaction(
      this.pool,
      this.#principal,
      { householdId: this.#principal.householdId },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select household_id, private_space_id, request_id, session_id,
                    user_id, space_access_grant_id,
                    authorization_scope_fingerprint,
                    provider_grant_reference, authorization_epoch
               from emdo.resolve_current_google_calendar_authority(
                 $1, $2
               )`,
            [request.spaceAccessGrantId, request.runId],
          ),
        );
        if (row === undefined) return undefined;
        if (
          row.request_id !== request.requestId ||
          row.session_id !== this.#principal.sessionId ||
          row.household_id !== this.#principal.householdId ||
          row.user_id !== request.userId ||
          row.space_access_grant_id !== request.spaceAccessGrantId
        ) {
          return undefined;
        }
        return TrustedProviderWriteAuthorityResolutionSchema.parse({
          authorityBinding: {
            kind: 'google-calendar-grant-v2',
            householdId: row.household_id,
            privateSpaceId: row.private_space_id,
            authorizationScopeFingerprint: row.authorization_scope_fingerprint,
            providerGrantReference: row.provider_grant_reference,
            authorizationEpoch: row.authorization_epoch,
          },
          operationScope: {
            requestId: row.request_id,
            sessionId: row.session_id,
            householdId: row.household_id,
            userId: row.user_id,
            spaceAccessGrantId: row.space_access_grant_id,
            authorizationScopeFingerprint: row.authorization_scope_fingerprint,
          },
        });
      },
    );
  }
}

/** Session-level advisory lock held across provider I/O, with scope validation first. */
export class PostgresGoogleOAuthGrantLease {
  constructor(private readonly pool: DatabasePool) {}

  async runExclusive<Value>(
    actorInput: PostgresGoogleOAuthActor,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const actor = ActorSchema.parse(actorInput);
    const client = await beginDurableTransaction(
      this.pool,
      principalForActor(actor),
    );
    const lockKey = `${actor.userId}:${actor.householdId}:${actor.privateSpaceId}`;
    let locked = false;
    let transactionOpen = true;
    let destroyClient = false;
    try {
      await lockDurableScope(client, {
        householdId: actor.householdId,
        spaceId: actor.privateSpaceId,
      });
      await client.query('commit');
      transactionOpen = false;
      await client.query(
        `select pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1, 0))`,
        [lockKey],
      );
      locked = true;
      return await operation();
    } finally {
      if (transactionOpen) {
        try {
          await client.query('rollback');
        } catch {
          destroyClient = true;
        }
      }
      if (locked) {
        try {
          await client.query(
            `select pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1, 0))`,
            [lockKey],
          );
        } catch {
          // Releasing the connection also drops its session advisory lock.
          destroyClient = true;
        }
      }
      client.release(destroyClient);
    }
  }
}

const OAuthAuditEventSchema = z.strictObject({
  event: z.enum([
    'google-calendar.oauth-authorization-started',
    'google-calendar.oauth-exchange-started',
    'google-calendar.oauth-connected',
    'google-calendar.oauth-failed',
    'google-calendar.oauth-refresh-started',
    'google-calendar.oauth-refreshed',
    'google-calendar.oauth-disconnect-started',
    'google-calendar.oauth-disconnected',
  ]),
  userId: UuidSchema,
  householdId: UuidSchema,
  purpose: z.enum(['calendar-read', 'calendar-event-write']).optional(),
  outcome: z.enum(['started', 'success', 'denied', 'failed', 'unconfirmed']),
  safeCode: z.string().trim().min(1).max(100).optional(),
});

/** Appends only the reviewed safe OAuth metadata shape to the audit ledger. */
export class PostgresGoogleOAuthAuditSink {
  readonly #principal: DurableRepositoryPrincipal;

  constructor(
    private readonly pool: DatabasePool,
    principal: DurableRepositoryPrincipal,
    private readonly privateSpaceId: string,
  ) {
    this.#principal = parseDurablePrincipal(principal);
    this.privateSpaceId = UuidSchema.parse(privateSpaceId);
  }

  async record(
    eventInput: z.input<typeof OAuthAuditEventSchema>,
  ): Promise<void> {
    const event = OAuthAuditEventSchema.parse(eventInput);
    if (
      event.userId !== this.#principal.userId ||
      event.householdId !== this.#principal.householdId
    ) {
      throw new Error('OAuth audit event authority mismatch');
    }
    await withDurableTransaction(
      this.pool,
      this.#principal,
      { householdId: event.householdId, spaceId: this.privateSpaceId },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `insert into emdo.audit_events
               (id, household_id, space_id, original_owner_user_id,
                actor_user_id, session_id, request_id, event_type, payload,
                occurred_at)
             values (pg_catalog.gen_random_uuid(), $1, $2, $3, $3, $4, $5,
                     $6, $7::jsonb, pg_catalog.clock_timestamp())
             returning id`,
            [
              event.householdId,
              this.privateSpaceId,
              event.userId,
              this.#principal.sessionId,
              this.#principal.requestId,
              event.event,
              {
                outcome: event.outcome,
                ...(event.purpose === undefined
                  ? {}
                  : { purpose: event.purpose }),
                ...(event.safeCode === undefined
                  ? {}
                  : { safeCode: event.safeCode }),
              },
            ],
          ),
        );
        if (row?.id === undefined) throw new Error('OAuth audit append failed');
      },
    );
  }
}

import {
  JsonValueSchema,
  SyncOperationSchema,
  UuidSchema,
  deepFreeze,
  type JsonValue,
  type SyncOperation,
} from '@emdo/contracts';
import {
  resolveDeterministicSyncOperation,
  type CanonicalSyncEntityVersion,
  type DeterministicSyncOperationResult,
} from '@emdo/domains/conflicts';
import { z } from 'zod';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  DurableRepositoryError,
  firstResultRow,
  parseDurablePrincipal,
  withDurableTransaction,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';
import type {
  OfflineSyncExecutionContext,
  ResolvedSyncWriteScope,
  StoredSyncOperationOutcome,
  SyncExecuteOnceInput,
  SyncExecuteOnceResult,
  SyncOperationProcessorRepository,
  SyncRepositoryPrincipalContext,
} from './processor.js';
import type { ResolvedSyncAccess, SyncAccessRepository } from './token.js';

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ResolveScopeSchema = z.strictObject({
  sessionId: UuidSchema,
  clientId: UuidSchema,
});
const RegisterClientSchema = z.strictObject({
  principal: z.strictObject({
    userId: UuidSchema,
    sessionId: UuidSchema,
    requestId: UuidSchema,
    householdId: UuidSchema,
  }),
  clientId: UuidSchema,
  displayName: z.string().trim().min(1).max(120),
});
const ProcessorContextSchema = z.strictObject({
  source: z.literal('offline-sync-api'),
  externalEffects: z.literal('forbidden'),
  mayEnqueueProviderWrites: z.literal(false),
  authorizationRevalidation: z.literal('required-in-transaction'),
  authenticatedUserId: UuidSchema,
  authenticatedSessionId: UuidSchema,
  householdId: UuidSchema,
  role: z.enum(['owner', 'member']),
  requestId: UuidSchema,
  writableSpaceIds: z.array(UuidSchema).min(1).max(256),
  targetSpaceId: UuidSchema,
});
const PrincipalContextSchema = z.strictObject({
  authenticatedUserId: UuidSchema,
  authenticatedSessionId: UuidSchema,
  householdId: UuidSchema,
  role: z.enum(['owner', 'member']),
  requestId: UuidSchema,
  writableSpaceIds: z.array(UuidSchema).min(1).max(256),
});

const StoredOutcomeCodeSchema = z.enum([
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
]);
const LegacyStoredOutcomeCodeSchema = z.enum([
  'entity-exists',
  'entity-not-found',
  'revision-mismatch',
  'tombstoned',
  'mutation-invalid',
  'repository-rejected',
]);
const StoredOutcomeResolutionSchema = z.enum([
  'created',
  'applied',
  'merged',
  'ignored',
  'duplicate',
]);
const StoredConflictDetailsSchema = z
  .array(
    z.strictObject({
      field: z.string().trim().min(1).max(200),
      material: z.boolean(),
    }),
  )
  .max(32);

const parseStoredOutcome = (
  row: Record<string, unknown>,
): StoredSyncOperationOutcome => {
  const revision = (value: unknown) => {
    if (value === null || value === undefined) return undefined;
    const parsed = typeof value === 'string' ? Number(value) : value;
    if (!Number.isSafeInteger(parsed) || Number(parsed) <= 0) {
      throw new DurableRepositoryError(
        'invalid-result',
        'Sync receipt contains an invalid revision',
      );
    }
    return Number(parsed);
  };
  const contractVersion =
    typeof row.outcome_contract_version === 'string'
      ? Number(row.outcome_contract_version)
      : row.outcome_contract_version;
  if (contractVersion === 0) {
    const conflicts = StoredConflictDetailsSchema.safeParse(
      row.conflict_details ?? [],
    );
    if (
      !conflicts.success ||
      conflicts.data.length !== 0 ||
      (row.outcome_resolution !== null &&
        row.outcome_resolution !== undefined) ||
      (row.outcome_disposition !== null &&
        row.outcome_disposition !== undefined)
    ) {
      throw new DurableRepositoryError(
        'invalid-result',
        'Legacy sync receipt is malformed',
      );
    }
    if (row.outcome_status === 'applied') {
      const resultingRevision = revision(row.resulting_revision);
      if (resultingRevision === undefined) {
        throw new DurableRepositoryError(
          'invalid-result',
          'Legacy applied sync receipt is malformed',
        );
      }
      return deepFreeze({
        status: 'applied' as const,
        revision: resultingRevision,
        resolution: 'applied' as const,
        conflicts: [],
      });
    }
    const legacyCode = LegacyStoredOutcomeCodeSchema.safeParse(
      row.outcome_code,
    );
    if (row.outcome_status !== 'conflict' || !legacyCode.success) {
      throw new DurableRepositoryError(
        'invalid-result',
        'Legacy sync receipt outcome is malformed',
      );
    }
    const currentRevision = revision(row.current_revision);
    return deepFreeze({
      status: 'conflict' as const,
      code: legacyCode.data,
      disposition: 'terminal' as const,
      conflicts: [],
      ...(currentRevision === undefined ? {} : { currentRevision }),
    });
  }
  if (contractVersion !== 1) {
    throw new DurableRepositoryError(
      'invalid-result',
      'Sync receipt contract version is unsupported',
    );
  }
  if (row.outcome_status === 'applied') {
    const resultingRevision = revision(row.resulting_revision);
    const resolution = StoredOutcomeResolutionSchema.safeParse(
      row.outcome_resolution,
    );
    const conflicts = StoredConflictDetailsSchema.safeParse(
      row.conflict_details ?? [],
    );
    if (
      resultingRevision === undefined ||
      !resolution.success ||
      !conflicts.success ||
      conflicts.data.length !== 0 ||
      (row.outcome_disposition !== null &&
        row.outcome_disposition !== undefined)
    ) {
      throw new DurableRepositoryError(
        'invalid-result',
        'Applied sync receipt is malformed',
      );
    }
    return deepFreeze({
      status: 'applied' as const,
      revision: resultingRevision,
      resolution: resolution.data,
      conflicts: [],
    });
  }
  const code = StoredOutcomeCodeSchema.safeParse(row.outcome_code);
  const conflicts = StoredConflictDetailsSchema.safeParse(
    row.conflict_details ?? [],
  );
  if (
    row.outcome_status !== 'conflict' ||
    !code.success ||
    !conflicts.success ||
    row.outcome_disposition !== 'terminal' ||
    (row.outcome_resolution !== null && row.outcome_resolution !== undefined)
  ) {
    throw new DurableRepositoryError(
      'invalid-result',
      'Sync receipt outcome is malformed',
    );
  }
  const currentRevision = revision(row.current_revision);
  return deepFreeze({
    status: 'conflict' as const,
    code: code.data,
    disposition: 'terminal' as const,
    conflicts: conflicts.data,
    ...(currentRevision === undefined ? {} : { currentRevision }),
  });
};

const parseScopeRow = (
  row: Record<string, unknown>,
): ResolvedSyncWriteScope | undefined => {
  const spaces = z
    .array(
      z.strictObject({
        id: UuidSchema,
        householdId: UuidSchema,
        visibility: z.enum(['private', 'shared']),
        originalOwnerUserId: UuidSchema,
      }),
    )
    .min(1)
    .max(256)
    .safeParse(row.writable_spaces);
  const base = z
    .strictObject({
      userId: UuidSchema,
      householdId: UuidSchema,
      role: z.enum(['owner', 'member']),
    })
    .safeParse({
      userId: row.user_id,
      householdId: row.household_id,
      role: row.role,
    });
  if (!base.success || !spaces.success) return undefined;
  if (
    spaces.data.some(
      (space) =>
        space.householdId !== base.data.householdId ||
        (space.visibility === 'private' &&
          space.originalOwnerUserId !== base.data.userId),
    )
  ) {
    return undefined;
  }
  return deepFreeze({ ...base.data, writableSpaces: spaces.data });
};

const asPrincipal = (
  context: SyncRepositoryPrincipalContext | OfflineSyncExecutionContext,
): Readonly<DurableRepositoryPrincipal> =>
  parseDurablePrincipal({
    userId: context.authenticatedUserId,
    sessionId: context.authenticatedSessionId,
    requestId: context.requestId,
    householdId: context.householdId,
  });

interface EntityRow {
  readonly payload: JsonValue;
  readonly revision: number;
  readonly tombstoned: boolean;
}

const parseEntityRow = (
  row: Record<string, unknown> | undefined,
  source: 'current' | 'snapshot' = 'current',
): EntityRow | undefined => {
  if (row === undefined) return undefined;
  const revision =
    typeof row.revision === 'string' ? Number(row.revision) : row.revision;
  const payload = JsonValueSchema.safeParse(row.payload);
  const tombstoned =
    source === 'snapshot'
      ? row.tombstoned
      : row.tombstoned_at !== null && row.tombstoned_at !== undefined;
  if (
    !Number.isSafeInteger(revision) ||
    Number(revision) <= 0 ||
    !payload.success ||
    typeof tombstoned !== 'boolean'
  ) {
    throw new DurableRepositoryError(
      'invalid-result',
      'Canonical sync entity is malformed',
    );
  }
  return {
    payload: payload.data,
    revision: Number(revision),
    tombstoned,
  };
};

const receiptColumns = `fingerprint, outcome_contract_version, outcome_status, outcome_code,
  outcome_resolution, outcome_disposition, conflict_details, current_revision,
  resulting_revision`;

export class PostgresSyncRepository
  implements SyncOperationProcessorRepository, SyncAccessRepository
{
  constructor(private readonly pool: DatabasePool) {}

  async resolveWriteScope(input: {
    readonly authenticatedSessionId: string;
    readonly clientId: string;
  }): Promise<ResolvedSyncWriteScope | undefined> {
    return this.#resolveScope({
      sessionId: input.authenticatedSessionId,
      clientId: input.clientId,
    });
  }

  async resolveSyncAccess(input: {
    readonly sessionId: string;
    readonly clientId: string;
  }): Promise<ResolvedSyncAccess | undefined> {
    const scope = await this.#resolveScope(input);
    if (scope === undefined) return undefined;
    return deepFreeze({
      userId: scope.userId,
      householdId: scope.householdId,
      role: scope.role,
      schemaVersion: 1 as const,
      spaces: scope.writableSpaces.map(
        ({ id, visibility, originalOwnerUserId }) => ({
          id,
          visibility,
          originalOwnerUserId,
        }),
      ),
    });
  }

  async #resolveScope(input: {
    readonly sessionId: string;
    readonly clientId: string;
  }) {
    const parsed = ResolveScopeSchema.safeParse(input);
    if (!parsed.success) return undefined;
    const client = await this.pool.connect();
    try {
      const row = firstResultRow(
        await client.query(
          `select user_id, household_id, role, writable_spaces
             from emdo.resolve_sync_access($1, $2)`,
          [parsed.data.sessionId, parsed.data.clientId],
        ),
      );
      return row === undefined ? undefined : parseScopeRow(row);
    } finally {
      client.release();
    }
  }

  async registerClient(input: z.input<typeof RegisterClientSchema>) {
    const parsed = RegisterClientSchema.parse(input);
    const principal = parseDurablePrincipal(parsed.principal);
    return withDurableTransaction(
      this.pool,
      principal,
      { householdId: principal.householdId },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `with database_time as (
               select pg_catalog.clock_timestamp() as now
             )
             insert into emdo.sync_clients
               (id, household_id, user_id, display_name, registered_at,
                last_seen_at)
             select $1, $2, emdo.current_user_id(), $3,
                    database_time.now, database_time.now
               from database_time
             on conflict (id) do update
               set last_seen_at = pg_catalog.clock_timestamp()
             where emdo.sync_clients.household_id = excluded.household_id
               and emdo.sync_clients.user_id = excluded.user_id
               and emdo.sync_clients.revoked_at is null
             returning id, household_id, user_id, display_name`,
            [parsed.clientId, principal.householdId, parsed.displayName],
          ),
        );
        if (row === undefined) {
          throw new DurableRepositoryError(
            'conflict',
            'Sync client ID is already bound or revoked',
          );
        }
        return deepFreeze({ ...row });
      },
    );
  }

  async getStoredOutcomes(input: {
    readonly clientId: string;
    readonly operationIds: readonly string[];
    readonly context: SyncRepositoryPrincipalContext;
  }) {
    const clientId = UuidSchema.parse(input.clientId);
    const operationIds = z
      .array(UuidSchema)
      .max(1_000)
      .parse(input.operationIds);
    const context = PrincipalContextSchema.parse(input.context);
    const principal = asPrincipal(context);
    if (operationIds.length === 0) return new Map();
    return withDurableTransaction(
      this.pool,
      principal,
      { householdId: context.householdId, clientId },
      async (client) => {
        const result = await client.query(
          `select operation_id, ${receiptColumns}
             from emdo.sync_operation_receipts
            where client_id = $1 and operation_id = any($2::uuid[])
            order by operation_id`,
          [clientId, operationIds],
        );
        const outcomes = new Map<
          string,
          { fingerprint: string; outcome: StoredSyncOperationOutcome }
        >();
        for (const row of result.rows) {
          if (
            typeof row.operation_id !== 'string' ||
            !HashSchema.safeParse(row.fingerprint).success
          ) {
            throw new DurableRepositoryError(
              'invalid-result',
              'Stored sync receipt is malformed',
            );
          }
          outcomes.set(row.operation_id, {
            fingerprint: row.fingerprint as string,
            outcome: parseStoredOutcome(row),
          });
        }
        return outcomes;
      },
    );
  }

  async executeOnce(
    input: SyncExecuteOnceInput,
  ): Promise<SyncExecuteOnceResult> {
    const operation = SyncOperationSchema.parse(input.operation);
    const fingerprint = HashSchema.parse(input.fingerprint);
    const context = ProcessorContextSchema.parse(input.context);
    if (!context.writableSpaceIds.includes(context.targetSpaceId)) {
      return { kind: 'authorization-revoked' };
    }
    const principal = asPrincipal(context);
    try {
      return await withDurableTransaction(
        this.pool,
        principal,
        {
          householdId: context.householdId,
          spaceId: context.targetSpaceId,
          clientId: operation.clientId,
        },
        async (client) => {
          await client.query(
            `select pg_catalog.pg_advisory_xact_lock(
               pg_catalog.hashtextextended($1 || ':' || $2, 0)
             )`,
            [operation.clientId, operation.operationId],
          );
          const prior = firstResultRow(
            await client.query(
              `select ${receiptColumns}
                 from emdo.sync_operation_receipts
                where client_id = $1 and operation_id = $2`,
              [operation.clientId, operation.operationId],
            ),
          );
          if (prior !== undefined) {
            return prior.fingerprint === fingerprint
              ? {
                  kind: 'replay' as const,
                  outcome: parseStoredOutcome(prior),
                }
              : ({ kind: 'idempotency-key-reused' } as const);
          }

          await client.query(
            `select pg_catalog.pg_advisory_xact_lock(
               pg_catalog.hashtextextended($1 || ':' || $2 || ':' || $3 || ':' || $4, 0)
             )`,
            [
              context.householdId,
              context.targetSpaceId,
              operation.entity.type,
              operation.entity.id,
            ],
          );
          const entity = parseEntityRow(
            firstResultRow(
              await client.query(
                `select payload, revision, tombstoned_at
                   from emdo.sync_entities
                  where household_id = $1 and space_id = $2
                    and entity_type = $3 and entity_id = $4
                  for update`,
                [
                  context.householdId,
                  context.targetSpaceId,
                  operation.entity.type,
                  operation.entity.id,
                ],
              ),
            ),
          );
          const base = await this.#loadMergeBase(
            client,
            operation,
            context,
            entity,
          );
          const resolved = resolveDeterministicSyncOperation({
            operation,
            ...(entity === undefined ? {} : { current: entity }),
            ...(base === undefined ? {} : { base }),
          });
          const outcome = await this.#persistResolution(
            client,
            operation,
            context,
            entity,
            resolved,
          );
          await this.#storeReceipt(
            client,
            operation,
            context,
            fingerprint,
            outcome,
          );
          return { kind: 'executed' as const, outcome };
        },
      );
    } catch (error) {
      if (
        error instanceof DurableRepositoryError &&
        error.code === 'authorization-revoked'
      ) {
        return { kind: 'authorization-revoked' };
      }
      throw error;
    }
  }

  async #loadMergeBase(
    client: DatabaseClient,
    operation: SyncOperation,
    context: z.infer<typeof ProcessorContextSchema>,
    entity: EntityRow | undefined,
  ): Promise<CanonicalSyncEntityVersion | undefined> {
    if (
      operation.mutation.kind !== 'update' ||
      (operation.entity.type !== 'finance.budget' &&
        operation.entity.type !== 'scheduler.item')
    ) {
      return undefined;
    }
    if (entity?.revision === operation.baseRevision) return entity;
    return parseEntityRow(
      firstResultRow(
        await client.query(
          `select payload, revision, tombstoned
             from emdo.sync_entity_revisions
            where household_id = $1 and space_id = $2
              and entity_type = $3 and entity_id = $4 and revision = $5`,
          [
            context.householdId,
            context.targetSpaceId,
            operation.entity.type,
            operation.entity.id,
            operation.baseRevision,
          ],
        ),
      ),
      'snapshot',
    );
  }

  async #persistResolution(
    client: DatabaseClient,
    operation: SyncOperation,
    context: z.infer<typeof ProcessorContextSchema>,
    entity: EntityRow | undefined,
    resolved: DeterministicSyncOperationResult,
  ): Promise<StoredSyncOperationOutcome> {
    if (resolved.status === 'conflict') {
      return deepFreeze({
        status: 'conflict' as const,
        code: resolved.code,
        disposition: 'terminal' as const,
        conflicts: resolved.conflicts,
        ...(resolved.currentRevision === undefined
          ? {}
          : { currentRevision: resolved.currentRevision }),
      });
    }
    if (resolved.providerWrites.length !== 0) {
      throw new DurableRepositoryError(
        'invalid-result',
        'Offline sync resolver attempted to return provider authority',
      );
    }
    const canonicalState = JsonValueSchema.parse(resolved.state);
    let payloadBytes: number;
    try {
      payloadBytes = Buffer.byteLength(JSON.stringify(canonicalState), 'utf8');
    } catch {
      payloadBytes = Number.POSITIVE_INFINITY;
    }
    if (payloadBytes > 1_000_000) {
      return deepFreeze({
        status: 'conflict' as const,
        code: 'repository-rejected' as const,
        disposition: 'terminal' as const,
        conflicts: [],
        ...(entity === undefined ? {} : { currentRevision: entity.revision }),
      });
    }

    if (resolved.resolution === 'duplicate') {
      if (entity === undefined) {
        throw new DurableRepositoryError(
          'invalid-result',
          'A duplicate sync resolution has no canonical entity',
        );
      }
      return deepFreeze({
        status: 'applied' as const,
        revision: entity.revision,
        resolution: resolved.resolution,
        conflicts: [],
      });
    }

    const nextRevision = entity === undefined ? 1 : entity.revision + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      return deepFreeze({
        status: 'conflict' as const,
        code: 'repository-rejected' as const,
        disposition: 'terminal' as const,
        conflicts: [],
        ...(entity === undefined ? {} : { currentRevision: entity.revision }),
      });
    }

    const written =
      entity === undefined
        ? firstResultRow(
            await client.query(
              `with database_time as (
                 select pg_catalog.clock_timestamp() as now
               )
               insert into emdo.sync_entities
                 (household_id, space_id, original_owner_user_id, entity_type,
                  entity_id, payload, actor_intent, revision, tombstoned_at,
                  created_at, updated_at)
               select $1, $2, emdo.current_user_id(), $3, $4, $5::jsonb, $6,
                      1, case when $7 then database_time.now else null end,
                      database_time.now, database_time.now
                 from database_time
               returning revision`,
              [
                context.householdId,
                context.targetSpaceId,
                operation.entity.type,
                operation.entity.id,
                canonicalState,
                operation.actorIntent,
                resolved.tombstoned,
              ],
            ),
          )
        : firstResultRow(
            await client.query(
              `update emdo.sync_entities
                  set payload = $6::jsonb, actor_intent = $7,
                      revision = revision + 1,
                      tombstoned_at = case
                        when $8 then pg_catalog.clock_timestamp()
                        else null
                      end,
                      updated_at = pg_catalog.clock_timestamp()
                where household_id = $1 and space_id = $2
                  and entity_type = $3 and entity_id = $4
                  and revision = $5
                returning revision`,
              [
                context.householdId,
                context.targetSpaceId,
                operation.entity.type,
                operation.entity.id,
                entity.revision,
                canonicalState,
                operation.actorIntent,
                resolved.tombstoned,
              ],
            ),
          );
    if (written === undefined || Number(written.revision) !== nextRevision) {
      return deepFreeze({
        status: 'conflict' as const,
        code: 'repository-rejected' as const,
        disposition: 'terminal' as const,
        conflicts: [],
        ...(entity === undefined ? {} : { currentRevision: entity.revision }),
      });
    }

    return deepFreeze({
      status: 'applied' as const,
      revision: nextRevision,
      resolution: resolved.resolution,
      conflicts: [],
    });
  }

  async #storeReceipt(
    client: DatabaseClient,
    operation: SyncOperation,
    context: z.infer<typeof ProcessorContextSchema>,
    fingerprint: string,
    outcome: StoredSyncOperationOutcome,
  ) {
    const row = firstResultRow(
      await client.query(
        `with database_time as (
           select pg_catalog.clock_timestamp() as now
         )
         insert into emdo.sync_operation_receipts
           (household_id, space_id, original_owner_user_id, client_id,
            operation_id, fingerprint, entity_type, entity_id, mutation_kind,
            base_revision, outcome_status, outcome_code, outcome_resolution,
            outcome_disposition, conflict_details, current_revision,
            resulting_revision, recorded_at, retain_until)
         select $1, $2, emdo.current_user_id(), $3, $4, $5, $6, $7, $8,
                $9, $10, $11, $12, $13, $14::jsonb, $15, $16,
                database_time.now,
                database_time.now + interval '90 days'
           from database_time
         returning operation_id`,
        [
          context.householdId,
          context.targetSpaceId,
          operation.clientId,
          operation.operationId,
          fingerprint,
          operation.entity.type,
          operation.entity.id,
          operation.mutation.kind,
          operation.baseRevision,
          outcome.status,
          outcome.status === 'conflict' ? outcome.code : null,
          outcome.status === 'applied' ? outcome.resolution : null,
          outcome.status === 'conflict' ? outcome.disposition : null,
          JSON.stringify(outcome.conflicts),
          outcome.status === 'conflict'
            ? (outcome.currentRevision ?? null)
            : null,
          outcome.status === 'applied' ? outcome.revision : null,
        ],
      ),
    );
    if (row === undefined) {
      throw new DurableRepositoryError(
        'conflict',
        'Sync operation receipt could not be persisted',
      );
    }
  }
}

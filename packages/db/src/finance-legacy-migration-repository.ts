import { createHash, randomUUID } from 'node:crypto';

import {
  FinanceLegacyMigrationBackfillInputSchema,
  FinanceLegacyMigrationBackfillResultSchema,
  FinanceLegacyMigrationComparisonCalculationSchema,
  FinanceLegacyMigrationComparisonSchema,
  FinanceLegacyMigrationCompareInputSchema,
  FinanceLegacyMigrationCutoverInputSchema,
  FinanceLegacyMigrationCutoverSchema,
  FinanceLegacyMigrationInspectInputSchema,
  FinanceLegacyMigrationInspectionSchema,
  FinanceLegacyMigrationMappingSchema,
  FinanceLegacyMigrationRecordSchema,
  FinanceLegacyMigrationReviewInputSchema,
  FinanceLegacyMigrationReviewSchema,
  FinanceLegacyMigrationRunSchema,
  FinanceLegacySourceProvenanceSchema,
  FinanceLegacySourceRecordSchema,
  UuidSchema,
  WorkspaceContextSchema,
  type FinanceLegacyMigrationComparison,
  type FinanceLegacyMigrationMapping,
  type FinanceLegacyMigrationPlan,
  type FinanceLegacyMigrationRecord,
  type FinanceLegacyMigrationRun,
  type FinanceLegacySourceRecord,
  type WorkspaceContext,
} from '@emdo/contracts';
import {
  compareLegacyFinanceMigration,
  evaluateLegacyFinanceCutover,
  formatFinanceDecimal,
  parseFinanceDecimal,
  planLegacyFinanceMigration,
} from '@emdo/domains/finance';
import { z } from 'zod';

import {
  beginDurableTransaction,
  lockDurableScope,
} from './durable/scoped-transaction.js';
import type { DatabaseClient, DatabasePool } from './scoped-repository.js';

const LegacyEntityTypes = [
  'finance.account',
  'finance.transaction',
  'finance.category',
  'finance.budget',
  'finance.bill',
  'finance.subscription',
  'finance.goal',
] as const;

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
};

const hash = (value: unknown): string =>
  createHash('sha256').update(stableJson(value), 'utf8').digest('hex');

const iso = (value: unknown): string => {
  const result = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(result.getTime())) throw new Error('invalid-date');
  return result.toISOString();
};

const nullableString = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

const canonicalDecimal = (value: unknown): string =>
  formatFinanceDecimal(parseFinanceDecimal(String(value)));

const deterministicUuid = (seed: string): string => {
  const bytes = createHash('sha256').update(seed, 'utf8').digest('hex');
  return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-4${bytes.slice(13, 16)}-${((Number.parseInt(bytes.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')}${bytes.slice(18, 20)}-${bytes.slice(20, 32)}`;
};

const sourceKey = (record: {
  readonly entityType: string;
  readonly entityId: string;
}) => `${record.entityType}\u0000${record.entityId}`;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const deriveProvenance = (
  entityType: string,
  payload: unknown,
): unknown | null => {
  if (entityType !== 'finance.transaction') return null;
  const source = asRecord(payload)?.source;
  const parsed = FinanceLegacySourceProvenanceSchema.safeParse(source);
  return parsed.success ? parsed.data : null;
};

const sourceRecordFromRow = (row: Record<string, unknown>) =>
  FinanceLegacySourceRecordSchema.parse({
    source: {
      householdId: String(row.household_id),
      privateSpaceId: String(row.space_id),
      originalOwnerUserId: String(row.original_owner_user_id),
    },
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    legacyRowId: String(row.id),
    revision: Number(row.revision),
    tombstoned: row.tombstoned_at !== null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    payload: row.payload,
    payloadHash: hash(row.payload),
    provenance: deriveProvenance(String(row.entity_type), row.payload),
  });

const sourceRecordFromMigrationRow = (row: Record<string, unknown>) =>
  FinanceLegacySourceRecordSchema.parse({
    source: {
      householdId: String(row.source_household_id),
      privateSpaceId: String(row.source_space_id),
      originalOwnerUserId: String(row.source_owner_user_id),
    },
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    legacyRowId: String(row.legacy_row_id),
    revision: Number(row.source_revision),
    tombstoned: row.tombstoned === true,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    payload: row.payload,
    payloadHash: String(row.payload_hash),
    provenance: row.provenance,
  });

const stableTargetIds = (
  records: readonly FinanceLegacySourceRecord[],
  targetBookId: string,
) =>
  records.map((record) => {
    // Entity IDs are private-source local, while normalized IDs are global.
    const seed = JSON.stringify([
      'legacy-target-v2',
      record.source.householdId,
      record.source.privateSpaceId,
      record.source.originalOwnerUserId,
      targetBookId,
      record.entityType,
      record.entityId,
    ]);
    const targetRecordId = deterministicUuid(`legacy-record:${seed}`);
    const isTransaction = record.entityType === 'finance.transaction';
    return {
      entityType: record.entityType,
      entityId: record.entityId,
      targetRecordId,
      targetBatchId: isTransaction
        ? deterministicUuid(`legacy-batch:${seed}`)
        : null,
      targetRowId: isTransaction
        ? deterministicUuid(`legacy-row:${seed}`)
        : null,
    };
  });

const recordViewFromRow = (row: Record<string, unknown>) =>
  FinanceLegacyMigrationRecordSchema.parse({
    id: String(row.id),
    migrationId: String(row.migration_id),
    workspaceId: String(row.workspace_id),
    bookId: String(row.book_id),
    source: {
      householdId: String(row.source_household_id),
      privateSpaceId: String(row.source_space_id),
      originalOwnerUserId: String(row.source_owner_user_id),
    },
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    legacyRowId: String(row.legacy_row_id),
    sourceRevision: Number(row.source_revision),
    tombstoned: row.tombstoned === true,
    payload: row.payload,
    payloadHash: String(row.payload_hash),
    provenance: row.provenance,
    status: String(row.candidate_status),
    disposition: String(row.disposition),
    normalized: row.normalized,
    classification: row.classification,
    blockers: row.blockers,
    targetRecordId: String(row.target_record_id),
    targetBatchId: nullableString(row.target_batch_id),
    targetRowId: nullableString(row.target_row_id),
    backfillState: String(row.backfill_state),
    backfilledAt: row.backfilled_at === null ? null : iso(row.backfilled_at),
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });

const runFromRow = (row: Record<string, unknown>) =>
  FinanceLegacyMigrationRunSchema.parse({
    id: String(row.id),
    mapping: row.mapping,
    status: String(row.status),
    revision: Number(row.revision),
    sourceSnapshotHash: String(row.source_snapshot_hash),
    mappingHash: String(row.mapping_hash),
    sourceCount: Number(row.source_count),
    readyCount: Number(row.ready_count),
    blockedCount: Number(row.blocked_count),
    backfilledCount: Number(row.backfilled_count),
    unresolvedCount: Number(row.unresolved_count),
    createdBy: String(row.created_by),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });

export class FinanceLegacyMigrationPersistenceError extends Error {
  constructor(
    readonly code:
      'forbidden' | 'conflict' | 'invalid-input' | 'blocked' | 'unavailable',
    message: string,
  ) {
    super(`finance-legacy-migration-${message}`);
    this.name = 'FinanceLegacyMigrationPersistenceError';
  }
}

const mapError = (cause: unknown): never => {
  if (cause instanceof FinanceLegacyMigrationPersistenceError) throw cause;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? String((cause as { readonly code?: unknown }).code)
      : '';
  if (code === '42501')
    throw new FinanceLegacyMigrationPersistenceError(
      'forbidden',
      'scope-forbidden',
    );
  if (['23505', '23514', '40P01', '55P03'].includes(code))
    throw new FinanceLegacyMigrationPersistenceError(
      'conflict',
      'revision-or-constraint-conflict',
    );
  if (['23503', '23502', '22P02', '22003', '22001'].includes(code))
    throw new FinanceLegacyMigrationPersistenceError(
      'invalid-input',
      'invalid-input',
    );
  throw new FinanceLegacyMigrationPersistenceError(
    'unavailable',
    'database-unavailable',
  );
};

export interface FinanceLegacyMigrationInspection {
  readonly run: FinanceLegacyMigrationRun;
  readonly plan: FinanceLegacyMigrationPlan;
  readonly records: readonly FinanceLegacyMigrationRecord[];
}

export interface FinanceLegacyMigrationReviewResult extends FinanceLegacyMigrationInspection {
  readonly review: z.output<typeof FinanceLegacyMigrationReviewSchema>;
}

const inspection = (
  run: FinanceLegacyMigrationRun,
  records: readonly FinanceLegacyMigrationRecord[],
): FinanceLegacyMigrationInspection => {
  const sourceRecords = records.map((record) =>
    sourceRecordFromMigrationRow({
      source_household_id: record.source.householdId,
      source_space_id: record.source.privateSpaceId,
      source_owner_user_id: record.source.originalOwnerUserId,
      entity_type: record.entityType,
      entity_id: record.entityId,
      legacy_row_id: record.legacyRowId,
      source_revision: record.sourceRevision,
      tombstoned: record.tombstoned,
      payload: record.payload,
      payload_hash: record.payloadHash,
      provenance: record.provenance,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    }),
  );
  const plan = planLegacyFinanceMigration({
    schemaVersion: 1,
    mapping: run.mapping,
    sourceRecords,
    stableTargetIds: records.map((record) => ({
      entityType: record.entityType,
      entityId: record.entityId,
      targetRecordId: record.targetRecordId,
      targetBatchId: record.targetBatchId,
      targetRowId: record.targetRowId,
    })),
  });
  return FinanceLegacyMigrationInspectionSchema.parse({
    run,
    plan,
    records,
  }) as FinanceLegacyMigrationInspection;
};

export class PostgresFinanceLegacyMigrationRepository {
  constructor(private readonly pool: DatabasePool) {}

  async checkReady(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "select count(*)=5 and bool_and(c.relrowsecurity and c.relforcerowsecurity) as ready from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='emdo' and c.relname=any($1::text[])",
        [
          [
            'finance_legacy_migration_runs',
            'finance_legacy_migration_records',
            'finance_legacy_migration_reviews',
            'finance_legacy_migration_comparisons',
            'finance_legacy_migration_cutovers',
          ],
        ],
      );
      const role = await client.query(
        'select rolsuper,rolbypassrls from pg_roles where rolname=current_user',
      );
      return (
        result.rows[0]?.ready === true &&
        role.rows[0]?.rolsuper === false &&
        role.rows[0]?.rolbypassrls === false
      );
    } finally {
      client.release();
    }
  }

  private async transaction<T>(
    contextInput: WorkspaceContext,
    work: (client: DatabaseClient, context: WorkspaceContext) => Promise<T>,
  ): Promise<T> {
    const context = WorkspaceContextSchema.parse(contextInput);
    const client = await beginDurableTransaction(this.pool, {
      ...context,
      householdId: context.workspaceId,
    });
    try {
      await lockDurableScope(client, { householdId: context.workspaceId });
      const result = await work(client, context);
      await client.query('commit');
      return result;
    } catch (cause) {
      try {
        await client.query('rollback');
      } catch {
        // Preserve the original failure.
      }
      return mapError(cause);
    } finally {
      client.release();
    }
  }

  private async assertBook(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    roles: readonly string[],
  ): Promise<void> {
    UuidSchema.parse(bookId);
    const locked = await client.query(
      'select emdo.lock_finance_book_grant($1,$2) as allowed',
      [context.workspaceId, bookId],
    );
    if (locked.rows[0]?.allowed !== true)
      throw new FinanceLegacyMigrationPersistenceError(
        'forbidden',
        'book-forbidden',
      );
    const grant = await client.query(
      'select role from emdo.finance_book_grants where workspace_id=$1 and book_id=$2 and user_id=$3 and revoked_at is null',
      [context.workspaceId, bookId, context.userId],
    );
    if (!roles.includes(String(grant.rows[0]?.role)))
      throw new FinanceLegacyMigrationPersistenceError(
        'forbidden',
        'book-forbidden',
      );
  }

  private async assertSourceScope(
    client: DatabaseClient,
    source: FinanceLegacyMigrationMapping['source'],
  ): Promise<void> {
    await lockDurableScope(client, {
      householdId: source.householdId,
      spaceId: source.privateSpaceId,
    });
    // Match activation and source writers: source lock precedes book locks.
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `legacy-finance:${source.householdId}:${source.privateSpaceId}:${source.originalOwnerUserId}`,
    ]);
  }

  private async readSourceRecords(
    client: DatabaseClient,
    source: FinanceLegacyMigrationMapping['source'],
  ): Promise<readonly FinanceLegacySourceRecord[]> {
    const result = await client.query(
      `select id,household_id,space_id,original_owner_user_id,entity_type,entity_id,payload,revision,tombstoned_at,created_at,updated_at
         from emdo.sync_entities
        where household_id=$1 and space_id=$2 and original_owner_user_id=$3
          and entity_type=any($4::text[])
        order by entity_type,entity_id,id`,
      [
        source.householdId,
        source.privateSpaceId,
        source.originalOwnerUserId,
        LegacyEntityTypes,
      ],
    );
    return Object.freeze(result.rows.map(sourceRecordFromRow));
  }

  private async readRun(
    client: DatabaseClient,
    context: WorkspaceContext,
    migrationId: string,
    lock = false,
  ): Promise<Record<string, unknown>> {
    const result = await client.query(
      `select * from emdo.finance_legacy_migration_runs where workspace_id=$1 and id=$2${lock ? ' for update' : ''}`,
      [context.workspaceId, migrationId],
    );
    const row = result.rows[0];
    if (!row)
      throw new FinanceLegacyMigrationPersistenceError(
        'forbidden',
        'migration-forbidden',
      );
    return row;
  }

  private async readRecords(
    client: DatabaseClient,
    context: WorkspaceContext,
    migrationId: string,
  ): Promise<readonly FinanceLegacyMigrationRecord[]> {
    const result = await client.query(
      `select * from emdo.finance_legacy_migration_records where workspace_id=$1 and migration_id=$2 order by entity_type,entity_id,id`,
      [context.workspaceId, migrationId],
    );
    return Object.freeze(result.rows.map(recordViewFromRow));
  }

  private async validateTargetMappings(
    client: DatabaseClient,
    context: WorkspaceContext,
    mapping: FinanceLegacyMigrationMapping,
  ): Promise<void> {
    const accountIds = mapping.financialAccounts.map(
      (entry) => entry.targetFinancialAccountId,
    );
    const ledgerIds = mapping.categories.map(
      (entry) => entry.targetLedgerAccountId,
    );
    const evidenceIds = mapping.evidence.map((entry) => entry.targetEvidenceId);
    const check = async (
      table: string,
      ids: readonly string[],
      label: string,
    ) => {
      if (ids.length === 0) return;
      const result = await client.query(
        `select id from emdo.${table} where workspace_id=$1 and book_id=$2 and id=any($3::uuid[])`,
        [context.workspaceId, mapping.target.bookId, ids],
      );
      if (result.rows.length !== new Set(ids).size)
        throw new FinanceLegacyMigrationPersistenceError(
          'invalid-input',
          `${label}-mapping-unavailable`,
        );
    };
    await check('finance_financial_accounts', accountIds, 'financial-account');
    await check('finance_ledger_accounts', ledgerIds, 'ledger-account');
    await check('finance_book_evidence', evidenceIds, 'evidence');
  }

  private async insertRecords(
    client: DatabaseClient,
    context: WorkspaceContext,
    runId: string,
    sourceRecords: readonly FinanceLegacySourceRecord[],
    plan: FinanceLegacyMigrationPlan,
  ): Promise<void> {
    const candidates = new Map(
      plan.candidates.map((candidate) => [sourceKey(candidate), candidate]),
    );
    for (const source of sourceRecords) {
      const candidate = candidates.get(sourceKey(source));
      if (!candidate) throw new Error('migration-candidate-missing');
      const recordId = deterministicUuid(
        `legacy-migration-record:${runId}:${sourceKey(source)}`,
      );
      await client.query(
        `insert into emdo.finance_legacy_migration_records(id,workspace_id,book_id,migration_id,source_household_id,source_space_id,source_owner_user_id,legacy_row_id,entity_type,entity_id,source_revision,tombstoned,payload,payload_hash,provenance,candidate_status,disposition,normalized,classification,blockers,target_record_id,target_batch_id,target_row_id,native_amount,currency,source_row,external_id,source_hash,fingerprint,target_financial_account_id,target_ledger_account_id,target_evidence_id,backfill_state) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16,$17,$18::jsonb,$19::jsonb,$20::jsonb,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)`,
        [
          recordId,
          context.workspaceId,
          plan.mapping.target.bookId,
          runId,
          source.source.householdId,
          source.source.privateSpaceId,
          source.source.originalOwnerUserId,
          source.legacyRowId,
          source.entityType,
          source.entityId,
          source.revision,
          source.tombstoned,
          JSON.stringify(source.payload),
          source.payloadHash,
          source.provenance === null ? null : JSON.stringify(source.provenance),
          candidate.status,
          candidate.disposition,
          JSON.stringify(candidate.normalized),
          JSON.stringify(candidate.classification),
          JSON.stringify(candidate.blockers),
          candidate.targetRecordId,
          candidate.targetBatchId,
          candidate.targetRowId,
          candidate.normalized.nativeAmount,
          candidate.normalized.currency,
          candidate.normalized.sourceRow,
          candidate.normalized.externalId,
          candidate.normalized.sourceHash,
          candidate.normalized.fingerprint,
          candidate.classification.targetFinancialAccountId,
          candidate.classification.targetLedgerAccountId,
          candidate.classification.targetEvidenceId,
          candidate.status === 'preserved' ? 'preserved' : 'pending',
        ],
      );
    }
  }

  private async readInspection(
    client: DatabaseClient,
    context: WorkspaceContext,
    runRow: Record<string, unknown>,
  ): Promise<FinanceLegacyMigrationInspection> {
    const run = runFromRow(runRow);
    const records = await this.readRecords(client, context, run.id);
    return inspection(run, records);
  }

  inspect(
    contextInput: WorkspaceContext,
    input: unknown,
  ): Promise<FinanceLegacyMigrationInspection> {
    const request = FinanceLegacyMigrationInspectInputSchema.parse(input);
    return this.transaction(contextInput, async (client, context) => {
      const mapping = FinanceLegacyMigrationMappingSchema.parse(
        request.mapping,
      );
      if (
        mapping.target.workspaceId !== context.workspaceId ||
        mapping.target.ownerUserId !== context.userId
      )
        throw new FinanceLegacyMigrationPersistenceError(
          'forbidden',
          'mapping-owner-forbidden',
        );
      await this.assertSourceScope(client, mapping.source);
      await this.assertBook(client, context, mapping.target.bookId, [
        'administrator',
        'preparer',
        'approver',
      ]);
      await this.validateTargetMappings(client, context, mapping);
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [
          `legacy-migration:${mapping.source.privateSpaceId}:${mapping.source.originalOwnerUserId}:${mapping.target.bookId}:${request.idempotencyKey}`,
        ],
      );
      const sourceRecords = await this.readSourceRecords(
        client,
        mapping.source,
      );
      const plan = planLegacyFinanceMigration({
        schemaVersion: 1,
        mapping,
        sourceRecords,
        stableTargetIds: stableTargetIds(sourceRecords, mapping.target.bookId),
      });
      const existingResult = await client.query(
        'select * from emdo.finance_legacy_migration_runs where workspace_id=$1 and source_space_id=$2 and source_owner_user_id=$3 and book_id=$4 and inspect_idempotency_key=$5 for update',
        [
          context.workspaceId,
          mapping.source.privateSpaceId,
          mapping.source.originalOwnerUserId,
          mapping.target.bookId,
          request.idempotencyKey,
        ],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (
          String(existing.source_snapshot_hash) !== plan.sourceSnapshotHash ||
          String(existing.mapping_hash) !== plan.mappingHash
        )
          throw new FinanceLegacyMigrationPersistenceError(
            'conflict',
            'inspect-idempotency-conflict',
          );
        return this.readInspection(client, context, existing);
      }
      const migrationId = randomUUID();
      await client.query(
        `insert into emdo.finance_legacy_migration_runs(id,workspace_id,book_id,source_household_id,source_space_id,source_owner_user_id,target_owner_user_id,mapping,source_snapshot_hash,mapping_hash,inspect_idempotency_key,status,revision,source_count,ready_count,blocked_count,backfilled_count,unresolved_count,created_by) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,1,$13,$14,$15,0,$16,$17)`,
        [
          migrationId,
          context.workspaceId,
          mapping.target.bookId,
          mapping.source.householdId,
          mapping.source.privateSpaceId,
          mapping.source.originalOwnerUserId,
          mapping.target.ownerUserId,
          JSON.stringify(mapping),
          plan.sourceSnapshotHash,
          plan.mappingHash,
          request.idempotencyKey,
          plan.status === 'ready' ? 'review' : 'blocked',
          plan.counts.source,
          plan.counts.ready,
          plan.counts.blocked,
          plan.counts.unresolved,
          context.userId,
        ],
      );
      await this.insertRecords(
        client,
        context,
        migrationId,
        sourceRecords,
        plan,
      );
      const runRow = (
        await client.query(
          'select * from emdo.finance_legacy_migration_runs where workspace_id=$1 and id=$2',
          [context.workspaceId, migrationId],
        )
      ).rows[0];
      if (!runRow) throw new Error('legacy-migration-run-not-found');
      return this.readInspection(client, context, runRow);
    });
  }

  get(
    contextInput: WorkspaceContext,
    migrationId: string,
  ): Promise<FinanceLegacyMigrationInspection> {
    UuidSchema.parse(migrationId);
    return this.transaction(contextInput, async (client, context) => {
      const row = await this.readRun(client, context, migrationId);
      await this.assertSourceScope(client, {
        householdId: String(row.source_household_id),
        privateSpaceId: String(row.source_space_id),
        originalOwnerUserId: String(row.source_owner_user_id),
      });
      await this.assertBook(client, context, String(row.book_id), [
        'administrator',
        'preparer',
        'approver',
        'viewer',
      ]);
      return this.readInspection(client, context, row);
    });
  }

  listSources(contextInput: WorkspaceContext, bookId: string) {
    UuidSchema.parse(bookId);
    return this.transaction(contextInput, async (client, context) => {
      await this.assertBook(client, context, bookId, [
        'administrator',
        'preparer',
        'approver',
        'viewer',
      ]);
      const result = await client.query(
        `select id,name from emdo.spaces where household_id=$1 and original_owner_user_id=$2 and visibility='private' and tombstoned_at is null order by id limit 1001`,
        [context.workspaceId, context.userId],
      );
      if (result.rows.length > 1000)
        throw new Error('legacy-source-catalog-limit');
      return result.rows.map((row) => ({
        name: String(row.name),
        source: {
          householdId: context.workspaceId,
          privateSpaceId: UuidSchema.parse(row.id),
          originalOwnerUserId: context.userId,
        },
      }));
    });
  }

  list(
    contextInput: WorkspaceContext,
    bookId: string,
  ): Promise<readonly FinanceLegacyMigrationRun[]> {
    UuidSchema.parse(bookId);
    return this.transaction(contextInput, async (client, context) => {
      await this.assertBook(client, context, bookId, [
        'administrator',
        'preparer',
        'approver',
        'viewer',
      ]);
      const result = await client.query(
        'select * from emdo.finance_legacy_migration_runs where workspace_id=$1 and book_id=$2 order by created_at,id',
        [context.workspaceId, bookId],
      );
      return Object.freeze(result.rows.map(runFromRow));
    });
  }

  review(
    contextInput: WorkspaceContext,
    input: unknown,
  ): Promise<FinanceLegacyMigrationReviewResult> {
    const request = FinanceLegacyMigrationReviewInputSchema.parse(input);
    return this.transaction(contextInput, async (client, context) => {
      const runRow = await this.readRun(
        client,
        context,
        request.migrationId,
        true,
      );
      const run = runFromRow(runRow);
      if (!['review', 'blocked'].includes(run.status))
        throw new FinanceLegacyMigrationPersistenceError(
          'conflict',
          'review-closed',
        );
      await this.assertSourceScope(client, {
        householdId: String(runRow.source_household_id),
        privateSpaceId: String(runRow.source_space_id),
        originalOwnerUserId: String(runRow.source_owner_user_id),
      });
      await this.assertBook(client, context, String(runRow.book_id), [
        'administrator',
        'preparer',
        'approver',
      ]);
      const records = await this.readRecords(client, context, run.id);
      const record = records.find((entry) => entry.id === request.recordId);
      if (!record)
        throw new FinanceLegacyMigrationPersistenceError(
          'forbidden',
          'record-forbidden',
        );
      if (record.revision !== request.expectedRevision)
        throw new FinanceLegacyMigrationPersistenceError(
          'conflict',
          'record-revision-conflict',
        );

      const mapping = FinanceLegacyMigrationMappingSchema.parse(run.mapping);
      const nextMapping = {
        ...mapping,
        financialAccounts: [...mapping.financialAccounts],
        categories: [...mapping.categories],
        evidence: [...mapping.evidence],
        openings: [...mapping.openings],
      };
      if (request.decision.classificationConfirmed) {
        const payload = asRecord(record.payload);
        const accountLegacyId =
          record.entityType === 'finance.account'
            ? record.entityId
            : String(payload?.accountId ?? '');
        if (request.decision.targetFinancialAccountId && accountLegacyId) {
          nextMapping.financialAccounts = [
            ...nextMapping.financialAccounts.filter(
              (entry) => entry.legacyAccountId !== accountLegacyId,
            ),
            {
              legacyAccountId: accountLegacyId,
              targetFinancialAccountId:
                request.decision.targetFinancialAccountId,
            },
          ];
        }
        const categoryLegacyId =
          record.entityType === 'finance.category'
            ? record.entityId
            : String(payload?.categoryId ?? '');
        if (request.decision.targetLedgerAccountId && categoryLegacyId) {
          nextMapping.categories = [
            ...nextMapping.categories.filter(
              (entry) => entry.legacyCategoryId !== categoryLegacyId,
            ),
            {
              legacyCategoryId: categoryLegacyId,
              targetLedgerAccountId: request.decision.targetLedgerAccountId,
            },
          ];
        }
        if (request.decision.targetEvidenceId) {
          nextMapping.evidence = [
            ...nextMapping.evidence.filter(
              (entry) => entry.legacyEntityId !== record.entityId,
            ),
            {
              legacyEntityId: record.entityId,
              targetEvidenceId: request.decision.targetEvidenceId,
            },
          ];
        }
        if (record.entityType === 'finance.account') {
          nextMapping.openings = [
            ...nextMapping.openings.filter(
              (entry) => entry.legacyAccountId !== record.entityId,
            ),
            {
              legacyAccountId: record.entityId,
              disposition: request.decision.openingDisposition,
              openingEffectiveOn:
                request.decision.openingDisposition === 'explicit-opening'
                  ? request.decision.openingEffectiveOn
                  : null,
              targetLedgerAccountId:
                request.decision.openingDisposition === 'explicit-opening'
                  ? request.decision.openingLedgerAccountId
                  : null,
              targetEvidenceId:
                request.decision.openingDisposition === 'explicit-opening'
                  ? request.decision.openingEvidenceId
                  : null,
            },
          ];
        }
      }
      const next = FinanceLegacyMigrationMappingSchema.parse(nextMapping);
      await this.validateTargetMappings(client, context, next);
      const sourceRecords = records.map((entry) =>
        sourceRecordFromMigrationRow({
          source_household_id: entry.source.householdId,
          source_space_id: entry.source.privateSpaceId,
          source_owner_user_id: entry.source.originalOwnerUserId,
          entity_type: entry.entityType,
          entity_id: entry.entityId,
          legacy_row_id: entry.legacyRowId,
          source_revision: entry.sourceRevision,
          tombstoned: entry.tombstoned,
          payload: entry.payload,
          payload_hash: entry.payloadHash,
          provenance: entry.provenance,
          created_at: entry.createdAt,
          updated_at: entry.updatedAt,
        }),
      );
      const plan = planLegacyFinanceMigration({
        schemaVersion: 1,
        mapping: next,
        sourceRecords,
        stableTargetIds: records.map((entry) => ({
          entityType: entry.entityType,
          entityId: entry.entityId,
          targetRecordId: entry.targetRecordId,
          targetBatchId: entry.targetBatchId,
          targetRowId: entry.targetRowId,
        })),
      });
      const candidates = new Map(
        plan.candidates.map((candidate) => [sourceKey(candidate), candidate]),
      );
      const previousState = JSON.parse(JSON.stringify(record));
      for (const existingRecord of records) {
        const candidate = candidates.get(sourceKey(existingRecord));
        if (!candidate)
          throw new FinanceLegacyMigrationPersistenceError(
            'conflict',
            'migration-candidate-missing',
          );
        // A review can change an account/category mapping used by many
        // transactions. Persist the complete recalculated candidate set so a
        // later backfill never mixes the old and new mapping revisions.
        const updated = await client.query(
          `update emdo.finance_legacy_migration_records set candidate_status=$4,disposition=$5,normalized=$6::jsonb,classification=$7::jsonb,blockers=$8::jsonb,native_amount=$9,currency=$10,source_row=$11,external_id=$12,source_hash=$13,fingerprint=$14,target_financial_account_id=$15,target_ledger_account_id=$16,target_evidence_id=$17,revision=revision+1 where workspace_id=$1 and migration_id=$2 and id=$3 and revision=$18 returning revision`,
          [
            context.workspaceId,
            run.id,
            existingRecord.id,
            candidate.status,
            candidate.disposition,
            JSON.stringify(candidate.normalized),
            JSON.stringify(candidate.classification),
            JSON.stringify(candidate.blockers),
            candidate.normalized.nativeAmount,
            candidate.normalized.currency,
            candidate.normalized.sourceRow,
            candidate.normalized.externalId,
            candidate.normalized.sourceHash,
            candidate.normalized.fingerprint,
            candidate.classification.targetFinancialAccountId,
            candidate.classification.targetLedgerAccountId,
            candidate.classification.targetEvidenceId,
            existingRecord.revision,
          ],
        );
        if (updated.rowCount !== 1)
          throw new FinanceLegacyMigrationPersistenceError(
            'conflict',
            'record-revision-conflict',
          );
      }
      const review = FinanceLegacyMigrationReviewSchema.parse({
        id: randomUUID(),
        migrationId: run.id,
        recordId: record.id,
        revision: request.expectedRevision + 1,
        decision: request.decision,
        previousState,
        reviewedBy: context.userId,
        createdAt: new Date().toISOString(),
      });
      await client.query(
        'insert into emdo.finance_legacy_migration_reviews(id,workspace_id,book_id,migration_id,record_id,revision,decision,previous_state,reviewed_by) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)',
        [
          review.id,
          context.workspaceId,
          runRow.book_id,
          run.id,
          record.id,
          review.revision,
          JSON.stringify(review.decision),
          JSON.stringify(review.previousState),
          context.userId,
        ],
      );
      const updatedRun = await client.query(
        `update emdo.finance_legacy_migration_runs set mapping=$3::jsonb,mapping_hash=$4,status=$5,source_count=$6,ready_count=$7,blocked_count=$8,unresolved_count=$9,revision=revision+1 where workspace_id=$1 and id=$2 and revision=$10`,
        [
          context.workspaceId,
          run.id,
          JSON.stringify(next),
          plan.mappingHash,
          plan.status === 'ready' ? 'review' : 'blocked',
          plan.counts.source,
          plan.counts.ready,
          plan.counts.blocked,
          plan.counts.unresolved,
          run.revision,
        ],
      );
      if (updatedRun.rowCount !== 1)
        throw new FinanceLegacyMigrationPersistenceError(
          'conflict',
          'run-revision-conflict',
        );
      const refreshed = await this.readRun(client, context, run.id);
      const result = await this.readInspection(client, context, refreshed);
      return { ...result, review };
    });
  }

  backfill(
    contextInput: WorkspaceContext,
    input: unknown,
  ): Promise<z.output<typeof FinanceLegacyMigrationBackfillResultSchema>> {
    const request = FinanceLegacyMigrationBackfillInputSchema.parse(input);
    return this.transaction(contextInput, async (client, context) => {
      const runRow = await this.readRun(
        client,
        context,
        request.migrationId,
        true,
      );
      const run = runFromRow(runRow);
      await this.assertSourceScope(client, {
        householdId: String(runRow.source_household_id),
        privateSpaceId: String(runRow.source_space_id),
        originalOwnerUserId: String(runRow.source_owner_user_id),
      });
      await this.assertBook(client, context, String(runRow.book_id), [
        'administrator',
        'preparer',
        'approver',
      ]);
      const operation = 'finance-legacy-migration.backfill';
      const commandHash = hash({ operation, request });
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [
          `legacy-migration:${context.workspaceId}:${context.userId}:${request.idempotencyKey}`,
        ],
      );
      const previous = (
        await client.query(
          'select operation,payload_hash,result from emdo.finance_command_receipts where workspace_id=$1 and user_id=$2 and idempotency_key=$3',
          [context.workspaceId, context.userId, request.idempotencyKey],
        )
      ).rows[0];
      if (previous) {
        if (
          String(previous.operation) !== operation ||
          String(previous.payload_hash) !== commandHash
        )
          throw new FinanceLegacyMigrationPersistenceError(
            'conflict',
            'backfill-idempotency-conflict',
          );
        return FinanceLegacyMigrationBackfillResultSchema.parse(
          previous.result,
        );
      }
      if (run.revision !== request.expectedRevision)
        throw new FinanceLegacyMigrationPersistenceError(
          'conflict',
          'run-revision-conflict',
        );
      if (request.sourceSnapshotHash !== run.sourceSnapshotHash)
        throw new FinanceLegacyMigrationPersistenceError(
          'conflict',
          'source-snapshot-changed',
        );
      const sourceRecords = await this.readSourceRecords(
        client,
        run.mapping.source,
      );
      const records = await this.readRecords(client, context, run.id);
      const plan = planLegacyFinanceMigration({
        schemaVersion: 1,
        mapping: run.mapping,
        sourceRecords,
        stableTargetIds: records.map((entry) => ({
          entityType: entry.entityType,
          entityId: entry.entityId,
          targetRecordId: entry.targetRecordId,
          targetBatchId: entry.targetBatchId,
          targetRowId: entry.targetRowId,
        })),
      });
      if (plan.sourceSnapshotHash !== run.sourceSnapshotHash)
        throw new FinanceLegacyMigrationPersistenceError(
          'conflict',
          'source-snapshot-changed',
        );
      if (plan.mappingHash !== run.mappingHash)
        throw new FinanceLegacyMigrationPersistenceError(
          'conflict',
          'mapping-changed',
        );
      if (plan.status !== 'ready')
        throw new FinanceLegacyMigrationPersistenceError(
          'blocked',
          'review-required',
        );
      const candidates = new Map(
        plan.candidates.map((candidate) => [sourceKey(candidate), candidate]),
      );
      const sourceByKey = new Map(
        sourceRecords.map((record) => [sourceKey(record), record]),
      );
      const targetBatchIds = new Set<string>();
      const targetRowIds = new Set<string>();
      let replayed = true;
      const markBackfillState = async (
        record: FinanceLegacyMigrationRecord,
        state: 'backfilled' | 'preserved',
      ): Promise<void> => {
        if (record.backfillState === state) return;
        if (record.backfillState !== 'pending')
          throw new FinanceLegacyMigrationPersistenceError(
            'conflict',
            'record-backfill-state-conflict',
          );
        const updated = await client.query(
          `update emdo.finance_legacy_migration_records set backfill_state=$4,backfilled_at=case when $4='backfilled' then clock_timestamp() else null end,revision=revision+1 where workspace_id=$1 and migration_id=$2 and id=$3 and revision=$5 returning id`,
          [context.workspaceId, run.id, record.id, state, record.revision],
        );
        if (updated.rowCount !== 1)
          throw new FinanceLegacyMigrationPersistenceError(
            'conflict',
            'record-revision-conflict',
          );
      };
      for (const record of records) {
        const candidate = candidates.get(sourceKey(record));
        const source = sourceByKey.get(sourceKey(record));
        if (!candidate || !source) throw new Error('migration-record-missing');
        if (record.backfillState === 'pending') replayed = false;
        if (candidate.status === 'preserved') {
          await markBackfillState(record, 'preserved');
          continue;
        }
        // Account and category candidates point to explicitly selected
        // normalized targets. They have no new import row to create, but their
        // mapping is still an additive backfill and must be marked complete.
        if (candidate.entityType !== 'finance.transaction') {
          await markBackfillState(record, 'backfilled');
          continue;
        }
        if (
          candidate.targetBatchId === null ||
          candidate.targetRowId === null ||
          candidate.classification.targetFinancialAccountId === null ||
          candidate.classification.targetEvidenceId === null
        )
          throw new FinanceLegacyMigrationPersistenceError(
            'blocked',
            'target-mapping-required',
          );
        const batchId = candidate.targetBatchId;
        const rowId = candidate.targetRowId;
        targetBatchIds.add(batchId);
        targetRowIds.add(rowId);
        const sourcePayload = asRecord(source.payload);
        const sourceRow = candidate.normalized.sourceRow ?? 1;
        const batchMapping = {
          schemaVersion: 1,
          kind: 'legacy-finance-migration',
          migrationId: run.id,
          legacyEntityType: source.entityType,
          legacyEntityId: source.entityId,
          sourceRevision: source.revision,
        };
        await client.query(
          `insert into emdo.finance_normalized_imports(id,workspace_id,book_id,financial_account_id,evidence_id,mapping,parser_version,status,revision) values($1,$2,$3,$4,$5,$6::jsonb,'legacy-finance-migration.v1','review',1) on conflict (workspace_id,book_id,id) do nothing`,
          [
            batchId,
            context.workspaceId,
            runRow.book_id,
            candidate.classification.targetFinancialAccountId,
            candidate.classification.targetEvidenceId,
            JSON.stringify(batchMapping),
          ],
        );
        const batch = (
          await client.query(
            'select financial_account_id,evidence_id,mapping,parser_version from emdo.finance_normalized_imports where workspace_id=$1 and book_id=$2 and id=$3',
            [context.workspaceId, runRow.book_id, batchId],
          )
        ).rows[0];
        if (
          !batch ||
          String(batch.financial_account_id) !==
            candidate.classification.targetFinancialAccountId ||
          String(batch.evidence_id) !==
            candidate.classification.targetEvidenceId ||
          String(batch.parser_version) !== 'legacy-finance-migration.v1' ||
          stableJson(batch.mapping) !== stableJson(batchMapping)
        )
          throw new FinanceLegacyMigrationPersistenceError(
            'conflict',
            'target-batch-integrity-conflict',
          );
        const sourceFacts = {
          schemaVersion: 1,
          legacyMigration: {
            migrationId: run.id,
            migrationRecordId: record.id,
            legacyRowId: source.legacyRowId,
            entityType: source.entityType,
            entityId: source.entityId,
            sourceRevision: source.revision,
            payloadHash: source.payloadHash,
            provenance: source.provenance,
          },
          payload: source.payload,
        };
        const payloadDescription = String(
          sourcePayload?.description ?? source.entityId,
        );
        const payloadDate = String(sourcePayload?.postedOn ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(payloadDate))
          throw new FinanceLegacyMigrationPersistenceError(
            'blocked',
            'transaction-date-required',
          );
        await client.query(
          `insert into emdo.finance_normalized_import_rows(id,workspace_id,book_id,batch_id,source_row,source_facts,effective_on,description,native_amount,external_id,issues,status,revision) values($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,'[]'::jsonb,'review',1) on conflict (workspace_id,book_id,id) do nothing`,
          [
            rowId,
            context.workspaceId,
            runRow.book_id,
            batchId,
            sourceRow,
            JSON.stringify(sourceFacts),
            payloadDate,
            payloadDescription,
            candidate.normalized.nativeAmount,
            candidate.normalized.externalId,
          ],
        );
        const row = (
          await client.query(
            'select batch_id,source_row,source_facts,effective_on::text as effective_on,description,native_amount::text as native_amount,external_id from emdo.finance_normalized_import_rows where workspace_id=$1 and book_id=$2 and id=$3',
            [context.workspaceId, runRow.book_id, rowId],
          )
        ).rows[0];
        if (
          !row ||
          String(row.batch_id) !== batchId ||
          Number(row.source_row) !== sourceRow ||
          stableJson(row.source_facts) !== stableJson(sourceFacts) ||
          String(row.effective_on) !== payloadDate ||
          String(row.description) !== payloadDescription ||
          canonicalDecimal(row.native_amount) !==
            canonicalDecimal(candidate.normalized.nativeAmount) ||
          nullableString(row.external_id) !== candidate.normalized.externalId
        )
          throw new FinanceLegacyMigrationPersistenceError(
            'conflict',
            'target-row-integrity-conflict',
          );
        await markBackfillState(record, 'backfilled');
      }
      const preservedCount = records.filter(
        (record) => candidates.get(sourceKey(record))?.status === 'preserved',
      ).length;
      const alreadyBackfilled = records.every(
        (record) => record.backfillState !== 'pending',
      );
      const updatedRun = await client.query(
        `update emdo.finance_legacy_migration_runs set status='backfilled',backfilled_count=$3,revision=revision+1 where workspace_id=$1 and id=$2 and revision=$4 returning id`,
        [context.workspaceId, run.id, plan.counts.ready, run.revision],
      );
      if (updatedRun.rowCount !== 1)
        throw new FinanceLegacyMigrationPersistenceError(
          'conflict',
          'run-revision-conflict',
        );
      const result = FinanceLegacyMigrationBackfillResultSchema.parse({
        migrationId: run.id,
        status: 'backfilled',
        targetBatchIds: [...targetBatchIds].sort(),
        targetRowIds: [...targetRowIds].sort(),
        backfilledCount: plan.counts.ready,
        preservedCount,
        sourceSnapshotHash: plan.sourceSnapshotHash,
        replayed: alreadyBackfilled && replayed,
      });
      await client.query(
        `insert into emdo.finance_command_receipts(workspace_id,user_id,idempotency_key,operation,payload_hash,result)
         values($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          context.workspaceId,
          context.userId,
          request.idempotencyKey,
          operation,
          commandHash,
          JSON.stringify(result),
        ],
      );
      return result;
    });
  }

  compare(
    contextInput: WorkspaceContext,
    input: unknown,
  ): Promise<FinanceLegacyMigrationComparison> {
    const request = FinanceLegacyMigrationCompareInputSchema.parse(input);
    return this.transaction(contextInput, async (client, context) => {
      const runRow = await this.readRun(
        client,
        context,
        request.migrationId,
        true,
      );
      const run = runFromRow(runRow);
      await this.assertSourceScope(client, {
        householdId: String(runRow.source_household_id),
        privateSpaceId: String(runRow.source_space_id),
        originalOwnerUserId: String(runRow.source_owner_user_id),
      });
      await this.assertBook(client, context, String(runRow.book_id), [
        'administrator',
        'preparer',
        'approver',
      ]);
      if (run.revision !== request.expectedRevision)
        throw new FinanceLegacyMigrationPersistenceError(
          'conflict',
          'run-revision-conflict',
        );
      const sourceRecords = await this.readSourceRecords(
        client,
        run.mapping.source,
      );
      const records = await this.readRecords(client, context, run.id);
      const plan = planLegacyFinanceMigration({
        schemaVersion: 1,
        mapping: run.mapping,
        sourceRecords,
        stableTargetIds: records.map((entry) => ({
          entityType: entry.entityType,
          entityId: entry.entityId,
          targetRecordId: entry.targetRecordId,
          targetBatchId: entry.targetBatchId,
          targetRowId: entry.targetRowId,
        })),
      });
      const targetTransactions = await this.readCurrentTargetTransactions(
        client,
        context,
        run.id,
      );
      let calculation = compareLegacyFinanceMigration({
        sourceRecords,
        candidates: plan.candidates,
        targetTransactions,
      });
      if (plan.sourceSnapshotHash !== run.sourceSnapshotHash) {
        calculation = FinanceLegacyMigrationComparisonCalculationSchema.parse({
          ...calculation,
          status: 'failed',
          mismatches: [
            ...new Set([...calculation.mismatches, 'source-snapshot-changed']),
          ].sort(),
        });
      }
      const comparisonId = randomUUID();
      await client.query(
        `insert into emdo.finance_legacy_migration_comparisons(id,workspace_id,book_id,migration_id,source_snapshot_hash,target_snapshot_hash,status,source_transaction_count,target_transaction_count,source_cad_minor_total,target_cad_decimal_total,unresolved_count,mismatches,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,
        [
          comparisonId,
          context.workspaceId,
          runRow.book_id,
          run.id,
          calculation.sourceSnapshotHash,
          calculation.targetSnapshotHash,
          calculation.status,
          calculation.sourceTransactionCount,
          calculation.targetTransactionCount,
          calculation.sourceCadMinorTotal,
          calculation.targetCadDecimalTotal,
          calculation.unresolvedCount,
          JSON.stringify(calculation.mismatches),
          context.userId,
        ],
      );
      const updatedRun = await client.query(
        `update emdo.finance_legacy_migration_runs set status=$3,revision=revision+1 where workspace_id=$1 and id=$2 and revision=$4`,
        [
          context.workspaceId,
          run.id,
          calculation.status === 'passed' ? 'comparison-passed' : 'blocked',
          run.revision,
        ],
      );
      if (updatedRun.rowCount !== 1)
        throw new FinanceLegacyMigrationPersistenceError(
          'conflict',
          'run-revision-conflict',
        );
      return FinanceLegacyMigrationComparisonSchema.parse({
        id: comparisonId,
        migrationId: run.id,
        sourceSnapshotHash: calculation.sourceSnapshotHash,
        targetSnapshotHash: calculation.targetSnapshotHash,
        status: calculation.status,
        sourceTransactionCount: calculation.sourceTransactionCount,
        targetTransactionCount: calculation.targetTransactionCount,
        sourceCadMinorTotal: calculation.sourceCadMinorTotal,
        targetCadDecimalTotal: calculation.targetCadDecimalTotal,
        unresolvedCount: calculation.unresolvedCount,
        mismatches: calculation.mismatches,
        createdBy: context.userId,
        createdAt: new Date().toISOString(),
      });
    });
  }

  private async readCurrentTargetTransactions(
    client: DatabaseClient,
    context: WorkspaceContext,
    migrationId: string,
  ) {
    const targetResult = await client.query(
      `select m.entity_type,m.entity_id,m.target_row_id,m.backfill_state,n.id as normalized_row_id,n.native_amount::text as native_amount,a.currency
           from emdo.finance_legacy_migration_records m
           left join emdo.finance_normalized_import_rows n on n.workspace_id=m.workspace_id and n.book_id=m.book_id and n.id=m.target_row_id
           left join emdo.finance_normalized_imports i on i.workspace_id=n.workspace_id and i.book_id=n.book_id and i.id=n.batch_id
           left join emdo.finance_financial_accounts a on a.workspace_id=i.workspace_id and a.book_id=i.book_id and a.id=i.financial_account_id
          where m.workspace_id=$1 and m.migration_id=$2 and m.entity_type='finance.transaction'`,
      [context.workspaceId, migrationId],
    );
    return targetResult.rows.flatMap((row) => {
      // A blocked candidate may have no stable target row. Omitting it
      // makes the deterministic comparison report the source as missing;
      // manufacturing a UUID here would conceal an unresolved mapping.
      if (row.target_row_id === null) return [];
      return [
        {
          entityType: 'finance.transaction' as const,
          entityId: String(row.entity_id),
          targetRowId: String(row.target_row_id),
          status:
            row.backfill_state === 'backfilled' &&
            row.normalized_row_id !== null
              ? ('backfilled' as const)
              : ('missing' as const),
          nativeAmount: nullableString(row.native_amount),
          currency: nullableString(row.currency) as
            'CAD' | 'USD' | 'MXN' | 'EUR' | 'KRW' | 'JPY' | null,
        },
      ];
    });
  }

  approveCutover(
    contextInput: WorkspaceContext,
    input: unknown,
  ): Promise<z.output<typeof FinanceLegacyMigrationCutoverSchema>> {
    const request = FinanceLegacyMigrationCutoverInputSchema.parse(input);
    return this.transaction(contextInput, async (client, context) => {
      const runRow = await this.readRun(
        client,
        context,
        request.migrationId,
        true,
      );
      const run = runFromRow(runRow);
      await this.assertSourceScope(client, {
        householdId: String(runRow.source_household_id),
        privateSpaceId: String(runRow.source_space_id),
        originalOwnerUserId: String(runRow.source_owner_user_id),
      });
      await this.assertBook(client, context, String(runRow.book_id), [
        'administrator',
        'approver',
      ]);
      const existing = (
        await client.query(
          'select * from emdo.finance_legacy_migration_cutovers where workspace_id=$1 and migration_id=$2',
          [context.workspaceId, run.id],
        )
      ).rows[0];
      if (existing) {
        if (
          String(existing.comparison_id) !== request.comparisonId ||
          String(existing.source_snapshot_hash) !== request.sourceSnapshotHash
        )
          throw new FinanceLegacyMigrationPersistenceError(
            'conflict',
            'cutover-idempotency-conflict',
          );
        return FinanceLegacyMigrationCutoverSchema.parse({
          id: String(existing.id),
          migrationId: run.id,
          source: run.mapping.source,
          target: run.mapping.target,
          comparisonId: String(existing.comparison_id),
          status: 'approved',
          approvedBy: String(existing.approved_by),
          approvedAt: iso(existing.approved_at),
        });
      }
      // A cutover approval is an idempotent command. A retry may carry the
      // revision observed before the first approval committed, so resolve an
      // existing matching approval before applying the optimistic run CAS.
      if (run.revision !== request.expectedRevision)
        throw new FinanceLegacyMigrationPersistenceError(
          'conflict',
          'run-revision-conflict',
        );
      if (run.status !== 'comparison-passed')
        throw new FinanceLegacyMigrationPersistenceError(
          'blocked',
          'comparison-required',
        );
      const comparisonRow = (
        await client.query(
          'select * from emdo.finance_legacy_migration_comparisons where workspace_id=$1 and migration_id=$2 and id=$3',
          [context.workspaceId, run.id, request.comparisonId],
        )
      ).rows[0];
      if (!comparisonRow)
        throw new FinanceLegacyMigrationPersistenceError(
          'blocked',
          'comparison-not-found',
        );
      const comparison =
        FinanceLegacyMigrationComparisonCalculationSchema.parse({
          sourceSnapshotHash: String(comparisonRow.source_snapshot_hash),
          targetSnapshotHash: String(comparisonRow.target_snapshot_hash),
          status: String(comparisonRow.status),
          sourceTransactionCount: Number(
            comparisonRow.source_transaction_count,
          ),
          targetTransactionCount: Number(
            comparisonRow.target_transaction_count,
          ),
          sourceCadMinorTotal: String(comparisonRow.source_cad_minor_total),
          targetCadDecimalTotal: String(comparisonRow.target_cad_decimal_total),
          unresolvedCount: Number(comparisonRow.unresolved_count),
          mismatches: comparisonRow.mismatches,
        });
      if (
        comparison.sourceSnapshotHash !== run.sourceSnapshotHash ||
        comparison.sourceSnapshotHash !== request.sourceSnapshotHash
      )
        throw new FinanceLegacyMigrationPersistenceError(
          'conflict',
          'source-snapshot-changed',
        );
      const records = await this.readRecords(client, context, run.id);
      const currentSourceRecords = await this.readSourceRecords(
        client,
        run.mapping.source,
      );
      const currentSourcePlan = planLegacyFinanceMigration({
        schemaVersion: 1,
        mapping: run.mapping,
        sourceRecords: currentSourceRecords,
        stableTargetIds: records.map((record) => ({
          entityType: record.entityType,
          entityId: record.entityId,
          targetRecordId: record.targetRecordId,
          targetBatchId: record.targetBatchId,
          targetRowId: record.targetRowId,
        })),
      });
      if (currentSourcePlan.sourceSnapshotHash !== run.sourceSnapshotHash)
        throw new FinanceLegacyMigrationPersistenceError(
          'conflict',
          'source-snapshot-changed',
        );

      const currentComparison = compareLegacyFinanceMigration({
        sourceRecords: currentSourceRecords,
        candidates: currentSourcePlan.candidates,
        targetTransactions: await this.readCurrentTargetTransactions(
          client,
          context,
          run.id,
        ),
      });
      if (
        currentComparison.status !== 'passed' ||
        currentComparison.targetSnapshotHash !== comparison.targetSnapshotHash
      )
        throw new FinanceLegacyMigrationPersistenceError(
          'conflict',
          'target-snapshot-changed',
        );
      const decision = evaluateLegacyFinanceCutover({
        plan: planLegacyFinanceMigration({
          schemaVersion: 1,
          mapping: run.mapping,
          sourceRecords: records.map((record) =>
            sourceRecordFromMigrationRow({
              source_household_id: record.source.householdId,
              source_space_id: record.source.privateSpaceId,
              source_owner_user_id: record.source.originalOwnerUserId,
              entity_type: record.entityType,
              entity_id: record.entityId,
              legacy_row_id: record.legacyRowId,
              source_revision: record.sourceRevision,
              tombstoned: record.tombstoned,
              payload: record.payload,
              payload_hash: record.payloadHash,
              provenance: record.provenance,
              created_at: record.createdAt,
              updated_at: record.updatedAt,
            }),
          ),
          stableTargetIds: records.map((record) => ({
            entityType: record.entityType,
            entityId: record.entityId,
            targetRecordId: record.targetRecordId,
            targetBatchId: record.targetBatchId,
            targetRowId: record.targetRowId,
          })),
        }),
        comparison,
      });
      if (!decision.ready)
        throw new FinanceLegacyMigrationPersistenceError(
          'blocked',
          decision.blockers.join(','),
        );
      const id = randomUUID();
      const approvedAt = new Date().toISOString();
      await client.query(
        "insert into emdo.finance_legacy_migration_cutovers(id,workspace_id,book_id,migration_id,comparison_id,source_snapshot_hash,status,approved_by,approved_at) values($1,$2,$3,$4,$5,$6,'approved',$7,$8)",
        [
          id,
          context.workspaceId,
          runRow.book_id,
          run.id,
          request.comparisonId,
          request.sourceSnapshotHash,
          context.userId,
          approvedAt,
        ],
      );
      const updatedRun = await client.query(
        "update emdo.finance_legacy_migration_runs set status='cutover-approved',revision=revision+1 where workspace_id=$1 and id=$2 and revision=$3",
        [context.workspaceId, run.id, run.revision],
      );
      if (updatedRun.rowCount !== 1)
        throw new FinanceLegacyMigrationPersistenceError(
          'conflict',
          'run-revision-conflict',
        );
      return FinanceLegacyMigrationCutoverSchema.parse({
        id,
        migrationId: run.id,
        source: run.mapping.source,
        target: run.mapping.target,
        comparisonId: request.comparisonId,
        status: 'approved',
        approvedBy: context.userId,
        approvedAt,
      });
    });
  }
}

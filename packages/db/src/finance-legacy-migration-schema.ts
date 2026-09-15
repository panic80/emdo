import { sql } from 'drizzle-orm';

import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
  boolean,
} from 'drizzle-orm/pg-core';

import { authUsers, householdMemberships, spaces } from './schema.js';

import {
  financeBooks,
  financeFinancialAccounts,
  financeLedgerAccounts,
  financeBookEvidence,
} from './finance-v2-schema.js';

const schema = pgSchema('emdo');

export const financeLegacyMigrationRuns = schema.table(
  'finance_legacy_migration_runs',
  {
    id: uuid('id').primaryKey().notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    sourceHouseholdId: uuid('source_household_id').notNull(),
    sourceSpaceId: uuid('source_space_id').notNull(),
    sourceOwnerUserId: uuid('source_owner_user_id').notNull(),
    targetOwnerUserId: uuid('target_owner_user_id').notNull(),
    mapping: jsonb('mapping').notNull(),
    sourceSnapshotHash: text('source_snapshot_hash').notNull(),
    mappingHash: text('mapping_hash').notNull(),
    inspectIdempotencyKey: text('inspect_idempotency_key').notNull(),
    status: text('status').notNull().default(sql.raw("'review'")),
    revision: integer('revision').notNull().default(sql.raw('1')),
    sourceCount: integer('source_count').notNull().default(sql.raw('0')),
    readyCount: integer('ready_count').notNull().default(sql.raw('0')),
    blockedCount: integer('blocked_count').notNull().default(sql.raw('0')),
    backfilledCount: integer('backfilled_count')
      .notNull()
      .default(sql.raw('0')),
    unresolvedCount: integer('unresolved_count')
      .notNull()
      .default(sql.raw('0')),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql.raw('now()')),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql.raw('now()')),
  },
  (t) => [
    unique('finance_legacy_migration_runs_scope').on(t.workspaceId, t.id),
    unique('finance_legacy_migration_runs_book_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    unique('finance_legacy_migration_runs_idempotency').on(
      t.workspaceId,
      t.sourceSpaceId,
      t.sourceOwnerUserId,
      t.bookId,
      t.inspectIdempotencyKey,
    ),
    check(
      'finance_legacy_migration_runs_source_scope',
      sql.raw('"source_household_id" = "workspace_id"'),
    ),
    check(
      'finance_legacy_migration_runs_hashes',
      sql.raw(
        '"source_snapshot_hash" ~ \'^[0-9a-f]{64}$\' AND "mapping_hash" ~ \'^[0-9a-f]{64}$\'',
      ),
    ),
    check(
      'finance_legacy_migration_runs_key',
      sql.raw(
        'length("inspect_idempotency_key") BETWEEN 16 AND 200 AND "inspect_idempotency_key" ~ \'^[A-Za-z0-9:._-]+$\'',
      ),
    ),
    check(
      'finance_legacy_migration_runs_state',
      sql.raw(
        "\"status\" IN ('review','backfilled','comparison-passed','blocked','cutover-approved') AND \"revision\" > 0",
      ),
    ),
    check(
      'finance_legacy_migration_runs_counts',
      sql.raw(
        '"source_count" >= 0 AND "ready_count" >= 0 AND "blocked_count" >= 0 AND "backfilled_count" >= 0 AND "unresolved_count" >= 0 AND "ready_count" + "blocked_count" <= "source_count" AND "backfilled_count" <= "ready_count" AND "unresolved_count" <= "blocked_count"',
      ),
    ),
    check(
      'finance_legacy_migration_runs_mapping_size',
      sql.raw(
        'jsonb_typeof("mapping") = \'object\' AND octet_length("mapping"::text) <= 1048576',
      ),
    ),
    check(
      'finance_legacy_migration_runs_mapping_scope',
      sql.raw(
        '(\n\t\t"mapping"->\'source\'->>\'householdId\' = "source_household_id"::text AND\n\t\t"mapping"->\'source\'->>\'privateSpaceId\' = "source_space_id"::text AND\n\t\t"mapping"->\'source\'->>\'originalOwnerUserId\' = "source_owner_user_id"::text AND\n\t\t"mapping"->\'target\'->>\'workspaceId\' = "workspace_id"::text AND\n\t\t"mapping"->\'target\'->>\'bookId\' = "book_id"::text AND\n\t\t"mapping"->\'target\'->>\'ownerUserId\' = "target_owner_user_id"::text\n\t) IS TRUE',
      ),
    ),
    foreignKey({
      name: 'finance_legacy_migration_runs_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_legacy_migration_runs_source_space',
      columns: [t.sourceHouseholdId, t.sourceSpaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_legacy_migration_runs_source_owner',
      columns: [t.sourceHouseholdId, t.sourceOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_legacy_migration_runs_target_owner',
      columns: [t.workspaceId, t.targetOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_legacy_migration_runs_creator',
      columns: [t.createdBy],
      foreignColumns: [authUsers.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('finance_legacy_migration_runs_status').on(
      t.workspaceId,
      t.bookId,
      t.status,
      t.updatedAt,
    ),
  ],
);

export const financeLegacyMigrationRecords = schema.table(
  'finance_legacy_migration_records',
  {
    id: uuid('id').primaryKey().notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    migrationId: uuid('migration_id').notNull(),
    sourceHouseholdId: uuid('source_household_id').notNull(),
    sourceSpaceId: uuid('source_space_id').notNull(),
    sourceOwnerUserId: uuid('source_owner_user_id').notNull(),
    legacyRowId: uuid('legacy_row_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    sourceRevision: integer('source_revision').notNull(),
    tombstoned: boolean('tombstoned').notNull(),
    payload: jsonb('payload').notNull(),
    payloadHash: text('payload_hash').notNull(),
    provenance: jsonb('provenance'),
    candidateStatus: text('candidate_status').notNull(),
    disposition: text('disposition').notNull(),
    normalized: jsonb('normalized').notNull(),
    classification: jsonb('classification').notNull(),
    blockers: jsonb('blockers').notNull(),
    targetRecordId: uuid('target_record_id').notNull(),
    targetBatchId: uuid('target_batch_id'),
    targetRowId: uuid('target_row_id'),
    nativeAmount: numeric('native_amount', { precision: 38, scale: 12 }),
    currency: text('currency'),
    sourceRow: integer('source_row'),
    externalId: text('external_id'),
    sourceHash: text('source_hash'),
    fingerprint: text('fingerprint'),
    targetFinancialAccountId: uuid('target_financial_account_id'),
    targetLedgerAccountId: uuid('target_ledger_account_id'),
    targetEvidenceId: uuid('target_evidence_id'),
    backfillState: text('backfill_state')
      .notNull()
      .default(sql.raw("'pending'")),
    backfilledAt: timestamp('backfilled_at', { withTimezone: true }),
    revision: integer('revision').notNull().default(sql.raw('1')),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql.raw('now()')),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql.raw('now()')),
  },
  (t) => [
    unique('finance_legacy_migration_records_scope').on(t.workspaceId, t.id),
    unique('finance_legacy_migration_records_run_scope').on(
      t.workspaceId,
      t.migrationId,
      t.id,
    ),
    unique('finance_legacy_migration_records_book_run_scope').on(
      t.workspaceId,
      t.bookId,
      t.migrationId,
      t.id,
    ),
    unique('finance_legacy_migration_records_identity').on(
      t.migrationId,
      t.entityType,
      t.entityId,
    ),
    check(
      'finance_legacy_migration_records_source_scope',
      sql.raw('"source_household_id" = "workspace_id"'),
    ),
    check(
      'finance_legacy_migration_records_entity_type',
      sql.raw(
        "\"entity_type\" IN ('finance.account','finance.transaction','finance.category','finance.budget','finance.bill','finance.subscription','finance.goal')",
      ),
    ),
    check(
      'finance_legacy_migration_records_entity_id',
      sql.raw(
        'length("entity_id") BETWEEN 1 AND 512 AND "entity_id" !~ \'[[:cntrl:]]\'',
      ),
    ),
    check(
      'finance_legacy_migration_records_revision',
      sql.raw('"source_revision" > 0 AND "revision" > 0'),
    ),
    check(
      'finance_legacy_migration_records_payload',
      sql.raw(
        'jsonb_typeof("payload") IS NOT NULL AND octet_length("payload"::text) BETWEEN 2 AND 1048576 AND "payload_hash" ~ \'^[0-9a-f]{64}$\'',
      ),
    ),
    check(
      'finance_legacy_migration_records_candidate',
      sql.raw(
        "\"candidate_status\" IN ('ready','blocked','preserved') AND \"disposition\" IN ('backfill','preserve-only','unresolved') AND jsonb_typeof(\"normalized\") = 'object' AND jsonb_typeof(\"classification\") = 'object' AND jsonb_typeof(\"blockers\") = 'array' AND octet_length(\"blockers\"::text) <= 65536",
      ),
    ),
    check(
      'finance_legacy_migration_records_tombstone',
      sql.raw(
        '("tombstoned" AND "candidate_status" = \'preserved\' AND "disposition" = \'preserve-only\' AND "backfill_state" = \'preserved\') OR NOT "tombstoned"',
      ),
    ),
    check(
      'finance_legacy_migration_records_backfill',
      sql.raw(
        '"backfill_state" IN (\'pending\',\'backfilled\',\'preserved\') AND (("backfill_state" = \'backfilled\' AND "backfilled_at" IS NOT NULL) OR ("backfill_state" <> \'backfilled\' AND "backfilled_at" IS NULL))',
      ),
    ),
    check(
      'finance_legacy_migration_records_currency',
      sql.raw(
        "\"currency\" IS NULL OR \"currency\" IN ('CAD','USD','MXN','EUR','KRW','JPY')",
      ),
    ),
    check(
      'finance_legacy_migration_records_amount',
      sql.raw(
        '("native_amount" IS NULL AND "currency" IS NULL) OR ("native_amount" IS NOT NULL AND "currency" IS NOT NULL AND "native_amount" <> \'NaN\'::numeric AND "native_amount" = round("native_amount", CASE WHEN "currency" IN (\'JPY\',\'KRW\') THEN 0 ELSE 2 END))',
      ),
    ),
    check(
      'finance_legacy_migration_records_source_row',
      sql.raw('"source_row" IS NULL OR "source_row" BETWEEN 1 AND 100000'),
    ),
    check(
      'finance_legacy_migration_records_source_hashes',
      sql.raw(
        '("source_hash" IS NULL AND "fingerprint" IS NULL) OR ("source_hash" IS NOT NULL AND "fingerprint" IS NOT NULL AND "source_hash" ~ \'^[0-9a-f]{64}$\' AND "fingerprint" ~ \'^[0-9a-f]{64}$\')',
      ),
    ),
    check(
      'finance_legacy_migration_records_provenance_size',
      sql.raw(
        '"provenance" IS NULL OR octet_length("provenance"::text) <= 65536',
      ),
    ),
    foreignKey({
      name: 'finance_legacy_migration_records_run',
      columns: [t.workspaceId, t.bookId, t.migrationId],
      foreignColumns: [
        financeLegacyMigrationRuns.workspaceId,
        financeLegacyMigrationRuns.bookId,
        financeLegacyMigrationRuns.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_legacy_migration_records_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_legacy_migration_records_source_space',
      columns: [t.sourceHouseholdId, t.sourceSpaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_legacy_migration_records_source_owner',
      columns: [t.sourceHouseholdId, t.sourceOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_legacy_migration_records_financial_account',
      columns: [t.workspaceId, t.bookId, t.targetFinancialAccountId],
      foreignColumns: [
        financeFinancialAccounts.workspaceId,
        financeFinancialAccounts.bookId,
        financeFinancialAccounts.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_legacy_migration_records_ledger_account',
      columns: [t.workspaceId, t.bookId, t.targetLedgerAccountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_legacy_migration_records_evidence',
      columns: [t.workspaceId, t.bookId, t.targetEvidenceId],
      foreignColumns: [
        financeBookEvidence.workspaceId,
        financeBookEvidence.bookId,
        financeBookEvidence.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('finance_legacy_migration_records_run').on(
      t.workspaceId,
      t.migrationId,
      t.candidateStatus,
      t.backfillState,
    ),
    index('finance_legacy_migration_records_source').on(
      t.sourceHouseholdId,
      t.sourceSpaceId,
      t.sourceOwnerUserId,
      t.entityType,
      t.entityId,
    ),
  ],
);

export const financeLegacyMigrationReviews = schema.table(
  'finance_legacy_migration_reviews',
  {
    id: uuid('id').primaryKey().notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    migrationId: uuid('migration_id').notNull(),
    recordId: uuid('record_id').notNull(),
    revision: integer('revision').notNull(),
    decision: jsonb('decision').notNull(),
    previousState: jsonb('previous_state').notNull(),
    reviewedBy: uuid('reviewed_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql.raw('now()')),
  },
  (t) => [
    unique('finance_legacy_migration_reviews_identity').on(
      t.workspaceId,
      t.migrationId,
      t.recordId,
      t.revision,
    ),
    check(
      'finance_legacy_migration_reviews_revision',
      sql.raw('"revision" > 0'),
    ),
    check(
      'finance_legacy_migration_reviews_decision',
      sql.raw(
        'jsonb_typeof("decision") = \'object\' AND octet_length("decision"::text) <= 65536 AND jsonb_typeof("previous_state") = \'object\' AND octet_length("previous_state"::text) <= 1048576',
      ),
    ),
    foreignKey({
      name: 'finance_legacy_migration_reviews_run',
      columns: [t.workspaceId, t.bookId, t.migrationId],
      foreignColumns: [
        financeLegacyMigrationRuns.workspaceId,
        financeLegacyMigrationRuns.bookId,
        financeLegacyMigrationRuns.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_legacy_migration_reviews_record',
      columns: [t.workspaceId, t.bookId, t.migrationId, t.recordId],
      foreignColumns: [
        financeLegacyMigrationRecords.workspaceId,
        financeLegacyMigrationRecords.bookId,
        financeLegacyMigrationRecords.migrationId,
        financeLegacyMigrationRecords.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_legacy_migration_reviews_reviewer',
      columns: [t.reviewedBy],
      foreignColumns: [authUsers.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('finance_legacy_migration_reviews_record').on(
      t.workspaceId,
      t.migrationId,
      t.recordId,
      t.revision,
    ),
  ],
);

export const financeLegacyMigrationComparisons = schema.table(
  'finance_legacy_migration_comparisons',
  {
    id: uuid('id').primaryKey().notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    migrationId: uuid('migration_id').notNull(),
    sourceSnapshotHash: text('source_snapshot_hash').notNull(),
    targetSnapshotHash: text('target_snapshot_hash').notNull(),
    status: text('status').notNull(),
    sourceTransactionCount: integer('source_transaction_count').notNull(),
    targetTransactionCount: integer('target_transaction_count').notNull(),
    sourceCadMinorTotal: numeric('source_cad_minor_total', {
      precision: 38,
      scale: 0,
    }).notNull(),
    targetCadDecimalTotal: numeric('target_cad_decimal_total', {
      precision: 38,
      scale: 12,
    }).notNull(),
    unresolvedCount: integer('unresolved_count').notNull(),
    mismatches: jsonb('mismatches').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql.raw('now()')),
  },
  (t) => [
    unique('finance_legacy_migration_comparisons_scope').on(
      t.workspaceId,
      t.id,
    ),
    unique('finance_legacy_migration_comparisons_run_scope').on(
      t.workspaceId,
      t.migrationId,
      t.id,
    ),
    unique('finance_legacy_migration_comparisons_book_run_scope').on(
      t.workspaceId,
      t.bookId,
      t.migrationId,
      t.id,
    ),
    check(
      'finance_legacy_migration_comparisons_hashes',
      sql.raw(
        '"source_snapshot_hash" ~ \'^[0-9a-f]{64}$\' AND "target_snapshot_hash" ~ \'^[0-9a-f]{64}$\'',
      ),
    ),
    check(
      'finance_legacy_migration_comparisons_state',
      sql.raw(
        '"status" IN (\'passed\',\'failed\') AND "source_transaction_count" >= 0 AND "target_transaction_count" >= 0 AND "unresolved_count" >= 0 AND jsonb_typeof("mismatches") = \'array\' AND octet_length("mismatches"::text) <= 65536',
      ),
    ),
    foreignKey({
      name: 'finance_legacy_migration_comparisons_run',
      columns: [t.workspaceId, t.bookId, t.migrationId],
      foreignColumns: [
        financeLegacyMigrationRuns.workspaceId,
        financeLegacyMigrationRuns.bookId,
        financeLegacyMigrationRuns.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_legacy_migration_comparisons_creator',
      columns: [t.createdBy],
      foreignColumns: [authUsers.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('finance_legacy_migration_comparisons_run').on(
      t.workspaceId,
      t.migrationId,
      t.createdAt,
    ),
  ],
);

export const financeLegacyMigrationCutovers = schema.table(
  'finance_legacy_migration_cutovers',
  {
    id: uuid('id').primaryKey().notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    migrationId: uuid('migration_id').notNull(),
    comparisonId: uuid('comparison_id').notNull(),
    sourceSnapshotHash: text('source_snapshot_hash').notNull(),
    status: text('status').notNull(),
    approvedBy: uuid('approved_by').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql.raw('now()')),
  },
  (t) => [
    unique('finance_legacy_migration_cutovers_migration').on(
      t.workspaceId,
      t.migrationId,
    ),
    check(
      'finance_legacy_migration_cutovers_hash',
      sql.raw(
        '"source_snapshot_hash" ~ \'^[0-9a-f]{64}$\' AND "status" = \'approved\'',
      ),
    ),
    foreignKey({
      name: 'finance_legacy_migration_cutovers_run',
      columns: [t.workspaceId, t.bookId, t.migrationId],
      foreignColumns: [
        financeLegacyMigrationRuns.workspaceId,
        financeLegacyMigrationRuns.bookId,
        financeLegacyMigrationRuns.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_legacy_migration_cutovers_comparison',
      columns: [t.workspaceId, t.bookId, t.migrationId, t.comparisonId],
      foreignColumns: [
        financeLegacyMigrationComparisons.workspaceId,
        financeLegacyMigrationComparisons.bookId,
        financeLegacyMigrationComparisons.migrationId,
        financeLegacyMigrationComparisons.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_legacy_migration_cutovers_approver',
      columns: [t.approvedBy],
      foreignColumns: [authUsers.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  ],
);

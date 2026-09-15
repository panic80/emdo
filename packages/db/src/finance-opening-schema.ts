import { sql } from 'drizzle-orm';
import {
  pgSchema,
  uuid,
  text,
  integer,
  numeric,
  date,
  timestamp,
  unique,
  index,
  check,
  foreignKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  financeFinancialAccounts,
  financeBookEvidence,
} from './finance-v2-schema.js';
import { financeJournals } from './finance-v2-schema.js';
import { authUsers } from './schema.js';
import {
  financeLegacyMigrationRecords,
  financeLegacyMigrationReviews,
} from './finance-legacy-migration-schema.js';
const schema = pgSchema('emdo');
export const financeOpeningProofs = schema.table(
  'finance_opening_proofs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    financialAccountId: uuid('financial_account_id').notNull(),
    sourceSpaceId: uuid('source_space_id').notNull(),
    sourceOwnerUserId: uuid('source_owner_user_id').notNull(),
    sourceKind: text('source_kind').notNull(),
    migrationId: uuid('migration_id').notNull(),
    sourceRecordId: uuid('source_record_id').notNull(),
    sourceRevision: integer('source_revision').notNull(),
    sourceSnapshotHash: text('source_snapshot_hash').notNull(),
    reviewId: uuid('review_id').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    evidenceDigest: text('evidence_digest').notNull(),
    effectiveOn: date('effective_on').notNull(),
    amountCadMinor: numeric('amount_cad_minor', {
      precision: 20,
      scale: 0,
    }).notNull(),
    ledgerAccountId: uuid('ledger_account_id').notNull(),
    counterpartLedgerAccountId: uuid('counterpart_ledger_account_id').notNull(),
    journalId: uuid('journal_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    postedBy: uuid('posted_by')
      .notNull()
      .references(() => authUsers.id),
    postedAt: timestamp('posted_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    supersedesProofId: uuid('supersedes_proof_id').references(
      (): AnyPgColumn => financeOpeningProofs.id,
    ),
  },
  (t) => [
    unique('finance_opening_scope').on(t.workspaceId, t.bookId, t.id),
    unique('finance_opening_key').on(t.workspaceId, t.bookId, t.idempotencyKey),
    unique('finance_opening_journal').on(t.workspaceId, t.bookId, t.journalId),
    index('finance_opening_account').on(
      t.workspaceId,
      t.bookId,
      t.financialAccountId,
      t.postedAt,
    ),
    check(
      'finance_opening_proofs_source_kind_check',
      sql`${t.sourceKind}='legacy-migration'`,
    ),
    check(
      'finance_opening_proofs_source_revision_check',
      sql`${t.sourceRevision}>0`,
    ),
    check(
      'finance_opening_proofs_source_snapshot_hash_check',
      sql`${t.sourceSnapshotHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'finance_opening_proofs_evidence_digest_check',
      sql`${t.evidenceDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'finance_opening_proofs_amount_cad_minor_check',
      sql`${t.amountCadMinor}<>0 AND abs(${t.amountCadMinor})<=9007199254740991`,
    ),
    check(
      'finance_opening_proofs_idempotency_key_check',
      sql`${t.idempotencyKey} ~ '^[A-Za-z0-9._:-]{1,128}$'`,
    ),
    check(
      'finance_opening_proofs_request_hash_check',
      sql`${t.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    foreignKey({
      name: 'finance_opening_account_fk',
      columns: [t.workspaceId, t.bookId, t.financialAccountId],
      foreignColumns: [
        financeFinancialAccounts.workspaceId,
        financeFinancialAccounts.bookId,
        financeFinancialAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_opening_journal_fk',
      columns: [t.workspaceId, t.bookId, t.journalId],
      foreignColumns: [
        financeJournals.workspaceId,
        financeJournals.bookId,
        financeJournals.id,
      ],
    }),
    foreignKey({
      name: 'finance_opening_record_fk',
      columns: [t.workspaceId, t.bookId, t.migrationId, t.sourceRecordId],
      foreignColumns: [
        financeLegacyMigrationRecords.workspaceId,
        financeLegacyMigrationRecords.bookId,
        financeLegacyMigrationRecords.migrationId,
        financeLegacyMigrationRecords.id,
      ],
    }),
    foreignKey({
      name: 'finance_opening_evidence_fk',
      columns: [t.workspaceId, t.bookId, t.evidenceId],
      foreignColumns: [
        financeBookEvidence.workspaceId,
        financeBookEvidence.bookId,
        financeBookEvidence.id,
      ],
    }),
    foreignKey({
      name: 'finance_opening_review_fk',
      columns: [t.reviewId],
      foreignColumns: [financeLegacyMigrationReviews.id],
    }),
  ],
);

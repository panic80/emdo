import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers, householdMemberships, spaces } from './schema.js';
import { financeFinancialAccounts } from './finance-v2-schema.js';
import { financeLegacyMigrationRuns } from './finance-legacy-migration-schema.js';
const schema = pgSchema('emdo');
export const financeAccountSourceAssignments = schema.table(
  'finance_account_source_assignments',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    accountId: uuid('account_id').notNull(),
    sourceSpaceId: uuid('source_space_id').notNull(),
    sourceOwnerUserId: uuid('source_owner_user_id').notNull(),
    revision: integer('revision').notNull(),
    status: text('status').notNull(),
    compatibilityAccountKind: text('compatibility_account_kind').notNull(),
    migrationId: uuid('migration_id'),
    legacyEntityId: text('legacy_entity_id'),
    reason: text('reason').notNull(),
    changedBy: uuid('changed_by').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({
      name: 'finance_account_source_assignments_pk',
      columns: [t.workspaceId, t.bookId, t.accountId],
    }),
    foreignKey({
      name: 'finance_account_source_assignments_account_fk',
      columns: [t.workspaceId, t.bookId, t.accountId],
      foreignColumns: [
        financeFinancialAccounts.workspaceId,
        financeFinancialAccounts.bookId,
        financeFinancialAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_account_source_assignments_space_fk',
      columns: [t.workspaceId, t.sourceSpaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    }),
    foreignKey({
      name: 'finance_account_source_assignments_owner_fk',
      columns: [t.workspaceId, t.sourceOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    }),
    foreignKey({
      name: 'finance_account_source_assignments_migration_fk',
      columns: [t.workspaceId, t.bookId, t.migrationId],
      foreignColumns: [
        financeLegacyMigrationRuns.workspaceId,
        financeLegacyMigrationRuns.bookId,
        financeLegacyMigrationRuns.id,
      ],
    }),
    foreignKey({
      name: 'finance_account_source_assignments_actor_fk',
      columns: [t.changedBy],
      foreignColumns: [authUsers.id],
    }),
    check(
      'finance_account_source_assignments_revision_check',
      sql`${t.revision}>0`,
    ),
    check(
      'finance_account_source_assignments_status_check',
      sql`${t.status} in ('active','revoked')`,
    ),
    check(
      'finance_account_source_assignments_kind',
      sql`${t.compatibilityAccountKind} in ('cash','chequing','savings','credit','other')`,
    ),
    check(
      'finance_account_source_assignments_reason_check',
      sql`length(btrim(${t.reason})) between 1 and 1000`,
    ),
    check(
      'finance_account_source_assignments_legacy_pair',
      sql`(${t.migrationId} is null)=(${t.legacyEntityId} is null)`,
    ),
  ],
);
export const financeAccountSourceAssignmentEvents = schema.table(
  'finance_account_source_assignment_events',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    accountId: uuid('account_id').notNull(),
    revision: integer('revision').notNull(),
    sourceSpaceId: uuid('source_space_id').notNull(),
    sourceOwnerUserId: uuid('source_owner_user_id').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    changedBy: uuid('changed_by').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({
      name: 'finance_account_source_assignment_events_pk',
      columns: [t.workspaceId, t.bookId, t.accountId, t.revision],
    }),
    foreignKey({
      name: 'finance_account_source_assignment_events_head_fk',
      columns: [t.workspaceId, t.bookId, t.accountId],
      foreignColumns: [
        financeAccountSourceAssignments.workspaceId,
        financeAccountSourceAssignments.bookId,
        financeAccountSourceAssignments.accountId,
      ],
    }),
    foreignKey({
      name: 'finance_account_source_assignment_events_actor_fk',
      columns: [t.changedBy],
      foreignColumns: [authUsers.id],
    }),
    foreignKey({
      name: 'finance_account_source_assignment_events_space_fk',
      columns: [t.workspaceId, t.sourceSpaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    }),
    foreignKey({
      name: 'finance_account_source_assignment_events_owner_fk',
      columns: [t.workspaceId, t.sourceOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    }),
    check(
      'finance_account_source_assignment_events_revision_check',
      sql`${t.revision}>0`,
    ),
    check(
      'finance_account_source_assignment_events_snapshot_check',
      sql`jsonb_typeof(${t.snapshot})='object'`,
    ),
  ],
);

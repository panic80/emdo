import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { financeLegacyMigrationRuns } from './finance-legacy-migration-schema.js';
import { authUsers } from './schema.js';
const schema = pgSchema('emdo');
export const financeLegacyActivations = schema.table(
  'finance_legacy_activations',
  {
    workspaceId: uuid('workspace_id').notNull(),
    sourceSpaceId: uuid('source_space_id').notNull(),
    sourceOwnerUserId: uuid('source_owner_user_id').notNull(),
    bookId: uuid('book_id').notNull(),
    migrationId: uuid('migration_id').notNull(),
    sourceHash: text('source_hash').notNull(),
    targetHash: text('target_hash').notNull(),
    activatedBy: uuid('activated_by').notNull(),
    activatedAt: timestamp('activated_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({
      name: 'finance_legacy_activations_pk',
      columns: [t.workspaceId, t.sourceSpaceId, t.sourceOwnerUserId],
    }),
    unique('finance_legacy_activations_run').on(t.workspaceId, t.migrationId),
    foreignKey({
      name: 'finance_legacy_activations_run_fk',
      columns: [t.workspaceId, t.bookId, t.migrationId],
      foreignColumns: [
        financeLegacyMigrationRuns.workspaceId,
        financeLegacyMigrationRuns.bookId,
        financeLegacyMigrationRuns.id,
      ],
    }),
    foreignKey({
      name: 'finance_legacy_activations_actor',
      columns: [t.activatedBy],
      foreignColumns: [authUsers.id],
    }),
    check(
      'finance_legacy_activations_source_hash_check',
      sql`${t.sourceHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'finance_legacy_activations_target_hash_check',
      sql`${t.targetHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

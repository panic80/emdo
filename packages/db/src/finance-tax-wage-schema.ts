import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './schema.js';
import {
  financeTaxCaseSnapshots,
  financeTaxFactSources,
} from './finance-tax-schema.js';
const s = pgSchema('emdo');
export const financeTaxWageReviews = s.table(
  'finance_tax_wage_reviews',
  {
    workspaceId: uuid('workspace_id').notNull(),
    caseId: uuid('case_id').notNull(),
    taxSubjectId: uuid('tax_subject_id').notNull(),
    snapshotRevision: integer('snapshot_revision').notNull(),
    id: uuid('id').primaryKey(),
    snapshotHash: text('snapshot_hash').notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceRevision: integer('source_revision').notNull(),
    sourceHash: text('source_hash').notNull(),
    packageHash: text('package_hash').notNull(),
    manifest: jsonb('manifest').notNull(),
    manifestHash: text('manifest_hash').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => authUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('tax_wage_review_scope').on(
      t.workspaceId,
      t.caseId,
      t.snapshotRevision,
      t.id,
    ),
    foreignKey({
      name: 'tax_wage_review_snapshot_fk',
      columns: [t.workspaceId, t.caseId, t.snapshotRevision],
      foreignColumns: [
        financeTaxCaseSnapshots.workspaceId,
        financeTaxCaseSnapshots.caseId,
        financeTaxCaseSnapshots.revision,
      ],
    }),
    foreignKey({
      name: 'tax_wage_review_source_fk',
      columns: [t.workspaceId, t.caseId, t.sourceId, t.sourceRevision],
      foreignColumns: [
        financeTaxFactSources.workspaceId,
        financeTaxFactSources.caseId,
        financeTaxFactSources.id,
        financeTaxFactSources.revision,
      ],
    }),
    check(
      'tax_wage_review_hashes',
      sql`${t.snapshotHash} ~ '^[a-f0-9]{64}$' and ${t.sourceHash} ~ '^[a-f0-9]{64}$' and ${t.packageHash} ~ '^[a-f0-9]{64}$' and ${t.manifestHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

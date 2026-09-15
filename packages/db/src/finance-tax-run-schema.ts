import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
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
const scope = () => ({
  workspaceId: uuid('workspace_id').notNull(),
  caseId: uuid('case_id').notNull(),
  taxSubjectId: uuid('tax_subject_id').notNull(),
  snapshotRevision: integer('snapshot_revision').notNull(),
});
const created = () => ({
  createdBy: uuid('created_by')
    .notNull()
    .references(() => authUsers.id),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const financeTaxWorkingInputReviews = s.table(
  'finance_tax_working_input_reviews',
  {
    ...scope(),
    sourceId: uuid('source_id').notNull(),
    sourceRevision: integer('source_revision').notNull(),
    sourceHash: text('source_hash').notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    workflowId: text('workflow_id').notNull(),
    packageVersion: text('package_version').notNull(),
    packageHash: text('package_hash').notNull(),
    ...created(),
  },
  (t) => [
    primaryKey({
      name: 'tax_working_input_review_pk',
      columns: [
        t.workspaceId,
        t.caseId,
        t.snapshotRevision,
        t.sourceId,
        t.sourceRevision,
        t.packageHash,
      ],
    }),
    foreignKey({
      name: 'tax_working_review_snapshot_fk',
      columns: [t.workspaceId, t.caseId, t.snapshotRevision],
      foreignColumns: [
        financeTaxCaseSnapshots.workspaceId,
        financeTaxCaseSnapshots.caseId,
        financeTaxCaseSnapshots.revision,
      ],
    }),
    foreignKey({
      name: 'tax_working_review_source_fk',
      columns: [t.workspaceId, t.caseId, t.sourceId, t.sourceRevision],
      foreignColumns: [
        financeTaxFactSources.workspaceId,
        financeTaxFactSources.caseId,
        financeTaxFactSources.id,
        financeTaxFactSources.revision,
      ],
    }),
    check(
      'tax_working_input_hashes',
      sql`${t.sourceHash} ~ '^[a-f0-9]{64}$' and ${t.snapshotHash} ~ '^[a-f0-9]{64}$' and ${t.packageHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
export const financeTaxCalculationRuns = s.table(
  'finance_tax_calculation_runs',
  {
    ...scope(),
    id: uuid('id').primaryKey(),
    snapshotHash: text('snapshot_hash').notNull(),
    workflowId: text('workflow_id').notNull(),
    packageVersion: text('package_version').notNull(),
    packageHash: text('package_hash').notNull(),
    inputHash: text('input_hash').notNull(),
    outputHash: text('output_hash').notNull(),
    status: text('status').notNull(),
    complete: boolean('complete').notNull().default(false),
    input: jsonb('input').notNull(),
    output: jsonb('output').notNull(),
    ...created(),
  },
  (t) => [
    unique('tax_run_identity').on(t.workspaceId, t.caseId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.caseId, t.snapshotRevision],
      foreignColumns: [
        financeTaxCaseSnapshots.workspaceId,
        financeTaxCaseSnapshots.caseId,
        financeTaxCaseSnapshots.revision,
      ],
    }),
    check(
      'tax_run_incomplete_only',
      sql`${t.complete}=false and ${t.status} in ('blocked-input','incomplete-working-papers') and ${t.output}->'complete'='false'::jsonb and ${t.output}->'enabled'='false'::jsonb and ${t.output}->'reportable'='false'::jsonb`,
    ),
    check(
      'tax_run_hashes',
      sql`${t.snapshotHash} ~ '^[a-f0-9]{64}$' and ${t.packageHash} ~ '^[a-f0-9]{64}$' and ${t.inputHash} ~ '^[a-f0-9]{64}$' and ${t.outputHash} ~ '^[a-f0-9]{64}$' and octet_length(${t.input}::text)<=8000000 and octet_length(${t.output}::text)<=8000000`,
    ),
  ],
);
export const financeTaxRunSchedules = s.table(
  'finance_tax_run_schedules',
  {
    workspaceId: uuid('workspace_id').notNull(),
    caseId: uuid('case_id').notNull(),
    runId: uuid('run_id').notNull(),
    formId: text('form_id').notNull(),
    content: jsonb('content').notNull(),
    contentHash: text('content_hash').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.caseId, t.runId, t.formId] }),
    foreignKey({
      columns: [t.workspaceId, t.caseId, t.runId],
      foreignColumns: [
        financeTaxCalculationRuns.workspaceId,
        financeTaxCalculationRuns.caseId,
        financeTaxCalculationRuns.id,
      ],
    }),
    check(
      'tax_schedule_hash',
      sql`${t.contentHash} ~ '^[a-f0-9]{64}$' and jsonb_typeof(${t.content})='array' and octet_length(${t.content}::text)<=8000000`,
    ),
  ],
);
export const financeTaxRunReviews = s.table(
  'finance_tax_run_reviews',
  {
    workspaceId: uuid('workspace_id').notNull(),
    caseId: uuid('case_id').notNull(),
    runId: uuid('run_id').notNull(),
    id: uuid('id').primaryKey(),
    outputHash: text('output_hash').notNull(),
    acknowledgement: text('acknowledgement').notNull(),
    ...created(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.caseId, t.runId],
      foreignColumns: [
        financeTaxCalculationRuns.workspaceId,
        financeTaxCalculationRuns.caseId,
        financeTaxCalculationRuns.id,
      ],
    }),
    check(
      'tax_run_review_not_fileable',
      sql`${t.acknowledgement}='reviewed-incomplete-working-papers-not-fileable' and ${t.outputHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

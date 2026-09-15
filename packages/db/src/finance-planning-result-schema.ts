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
import { financeAutomationRuns } from './finance-automation-schema.js';
import { financeBudgetRevisions } from './finance-planning-schema.js';
const schema = pgSchema('emdo');
export const financePlanningResults = schema.table(
  'finance_planning_results',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    automationRunId: uuid('automation_run_id').notNull(),
    schemaVersion: integer('schema_version').default(1).notNull(),
    capability: text('capability').notNull(),
    budgetId: uuid('budget_id').notNull(),
    budgetRevision: integer('budget_revision').notNull(),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true }).notNull(),
    payload: jsonb('payload').notNull(),
    sourceLineage: jsonb('source_lineage').notNull(),
    sourceHash: text('source_hash').notNull(),
  },
  (t) => [
    unique('planning_result_run').on(t.automationRunId),
    unique('planning_result_scope').on(t.workspaceId, t.bookId, t.id),
    foreignKey({
      name: 'planning_result_run_scope',
      columns: [t.workspaceId, t.bookId, t.automationRunId],
      foreignColumns: [
        financeAutomationRuns.workspaceId,
        financeAutomationRuns.bookId,
        financeAutomationRuns.id,
      ],
    }),
    foreignKey({
      name: 'planning_result_budget_scope',
      columns: [t.workspaceId, t.bookId, t.budgetId, t.budgetRevision],
      foreignColumns: [
        financeBudgetRevisions.workspaceId,
        financeBudgetRevisions.bookId,
        financeBudgetRevisions.budgetId,
        financeBudgetRevisions.revision,
      ],
    }),
    check(
      'planning_result_version',
      sql`${t.schemaVersion}=1 and ${t.capability} in ('finance.planning.budget-vs-actuals','finance.planning.forecast')`,
    ),
    check(
      'planning_result_payload',
      sql`jsonb_typeof(${t.payload})='object' and octet_length(${t.payload}::text)<=8000000 and jsonb_typeof(${t.sourceLineage})='object' and octet_length(${t.sourceLineage}::text)<=8000000`,
    ),
    check('planning_result_hash', sql`${t.sourceHash} ~ '^[a-f0-9]{64}$'`),
  ],
);

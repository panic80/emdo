import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  date,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { financeAutomationRuns } from './finance-automation-schema.js';
import {
  financeBooks,
  financeLedgerAccounts,
  financePeriods,
} from './finance-v2-schema.js';
import { authUsers } from './schema.js';
const schema = pgSchema('emdo');
export const financeGeneratedReports = schema.table(
  'finance_generated_reports',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    automationRunId: uuid('automation_run_id').notNull(),
    reportVersion: integer('report_version').notNull().default(1),
    kind: text('kind').notNull().default('posted-ledger-trial-balance'),
    coverage: text('coverage')
      .notNull()
      .default('all-posted-journals-at-snapshot'),
    currency: text('currency').notNull(),
    periodId: uuid('period_id'),
    periodStart: date('period_start'),
    periodEnd: date('period_end'),
    asOf: date('as_of'),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true }).notNull(),
    snapshot: jsonb('snapshot').notNull(),
  },
  (t) => [
    unique('generated_report_run').on(t.automationRunId),
    unique('generated_report_scope').on(t.workspaceId, t.bookId, t.id),
    foreignKey({
      name: 'generated_report_run_scope',
      columns: [t.workspaceId, t.bookId, t.automationRunId],
      foreignColumns: [
        financeAutomationRuns.workspaceId,
        financeAutomationRuns.bookId,
        financeAutomationRuns.id,
      ],
    }),
    foreignKey({
      name: 'generated_report_period_scope',
      columns: [t.workspaceId, t.bookId, t.periodId],
      foreignColumns: [
        financePeriods.workspaceId,
        financePeriods.bookId,
        financePeriods.id,
      ],
    }),
    check(
      'generated_report_version',
      sql`${t.reportVersion}=1 and ((
        ${t.kind}='posted-ledger-trial-balance' and ${t.coverage}='all-posted-journals-at-snapshot' and ${t.periodId} is null and ${t.periodStart} is null and ${t.periodEnd} is null and ${t.asOf} is null
      ) or (
        ${t.kind}='income-statement' and ${t.coverage}='period-posted-journals-at-snapshot' and ${t.periodId} is not null and ${t.periodStart} is not null and ${t.periodEnd} is not null and ${t.asOf} is null
      ) or (
        ${t.kind}='balance-sheet' and ${t.coverage}='posted-journals-through-as-of' and ${t.periodId} is null and ${t.periodStart} is null and ${t.periodEnd} is null and ${t.asOf} is not null
      ))`,
    ),
    check(
      'generated_report_currency',
      sql`${t.currency} in ('CAD','USD','MXN','EUR','KRW','JPY')`,
    ),
    check(
      'generated_report_bounded_snapshot',
      sql`jsonb_typeof(${t.snapshot})='object' and octet_length(${t.snapshot}::text)<=8000000`,
    ),
  ],
);

/** Immutable, book-scoped statement mapping history. A report stores the
 * selected revision on every row, so later remapping cannot rewrite a saved
 * financial statement. */
export const financeLedgerAccountClassifications = schema.table(
  'finance_ledger_account_classifications',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    accountId: uuid('account_id').notNull(),
    revision: integer('revision').notNull(),
    statement: text('statement').notNull(),
    section: text('section').notNull(),
    displayOrder: integer('display_order').notNull().default(0),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({
      name: 'finance_ledger_account_classifications_pk',
      columns: [t.workspaceId, t.bookId, t.accountId, t.revision],
    }),
    foreignKey({
      name: 'finance_ledger_account_classification_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    foreignKey({
      name: 'finance_ledger_account_classification_account',
      columns: [t.workspaceId, t.bookId, t.accountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_ledger_account_classification_creator',
      columns: [t.createdBy],
      foreignColumns: [authUsers.id],
    }),
    check(
      'finance_ledger_account_classification_statement',
      sql`${t.statement} in ('balance-sheet','income-statement')`,
    ),
    check(
      'finance_ledger_account_classification_section',
      sql`${t.section} ~ '^[a-z0-9]+([_-][a-z0-9]+)*$' and length(${t.section}) between 1 and 80`,
    ),
    check(
      'finance_ledger_account_classification_revision',
      sql`${t.revision}>0 and ${t.displayOrder} between 0 and 10000`,
    ),
    index('finance_ledger_account_classifications_current').on(
      t.workspaceId,
      t.bookId,
      t.accountId,
      t.revision,
    ),
  ],
);

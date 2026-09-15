import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { financeBooks } from './finance-v2-schema.js';
const schema = pgSchema('emdo');
export const financeInvestmentReconciliationCases = schema.table(
  'finance_investment_reconciliation_cases',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    revision: integer('revision').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique('finance_investment_reconciliation_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    foreignKey({
      name: 'finance_investment_reconciliation_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    check(
      'finance_investment_reconciliation_state',
      sql`${t.revision}>0 and ${t.status} in ('open','resolved')`,
    ),
    index('finance_investment_reconciliation_lookup').on(
      t.workspaceId,
      t.bookId,
      t.createdAt,
      t.id,
    ),
  ],
);
export const financeInvestmentReconciliationEvents = schema.table(
  'finance_investment_reconciliation_events',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    caseId: uuid('case_id').notNull(),
    revision: integer('revision').notNull(),
    event: jsonb('event').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.caseId, t.revision] }),
    foreignKey({
      name: 'finance_investment_reconciliation_event_case',
      columns: [t.workspaceId, t.bookId, t.caseId],
      foreignColumns: [
        financeInvestmentReconciliationCases.workspaceId,
        financeInvestmentReconciliationCases.bookId,
        financeInvestmentReconciliationCases.id,
      ],
    }),
    check(
      'finance_investment_reconciliation_event_shape',
      sql`${t.revision}>0 and jsonb_typeof(${t.event})='object' and octet_length(${t.event}::text)<=1048576`,
    ),
  ],
);

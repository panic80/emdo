import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  financeBooks,
  financeLedgerAccounts,
  financePeriods,
} from './finance-v2-schema.js';
import { authUsers } from './schema.js';

const schema = pgSchema('emdo');
const transactionId = customType<{ data: string }>({ dataType: () => 'xid8' });
const decimal = (name: string) => numeric(name, { precision: 38, scale: 12 });
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).defaultNow().notNull();

/** Immutable logical-budget revisions; each save appends one revision. */
export const financeBudgetRevisions = schema.table(
  'finance_budget_revisions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    budgetId: uuid('budget_id').notNull(),
    revision: integer('revision').notNull(),
    name: text('name').notNull(),
    functionalCurrency: text('functional_currency').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => authUsers.id),
    planningConstructionTxid: transactionId('planning_construction_txid')
      .notNull()
      .default(sql`pg_current_xact_id()`),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'finance_budget_revisions_pk',
      columns: [t.workspaceId, t.bookId, t.budgetId, t.revision],
    }),
    foreignKey({
      name: 'finance_budget_revisions_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    check(
      'finance_budget_revisions_revision',
      sql`${t.revision} > 0 and ${t.revision} = trunc(${t.revision})`,
    ),
    check(
      'finance_budget_revisions_currency',
      sql`${t.functionalCurrency} in ('CAD','USD','MXN','EUR','KRW','JPY')`,
    ),
    index('finance_budget_revisions_book').on(
      t.workspaceId,
      t.bookId,
      t.budgetId,
      t.revision,
    ),
  ],
);

/** Budget values are always explicit book-currency decimal strings. */
export const financeBudgetLines = schema.table(
  'finance_budget_lines',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    budgetId: uuid('budget_id').notNull(),
    revision: integer('revision').notNull(),
    periodId: uuid('period_id').notNull(),
    accountId: uuid('account_id').notNull(),
    currency: text('currency').notNull(),
    amount: decimal('amount').notNull(),
  },
  (t) => [
    primaryKey({
      name: 'finance_budget_lines_pk',
      columns: [
        t.workspaceId,
        t.bookId,
        t.budgetId,
        t.revision,
        t.periodId,
        t.accountId,
        t.currency,
      ],
    }),
    foreignKey({
      name: 'finance_budget_lines_revision',
      columns: [t.workspaceId, t.bookId, t.budgetId, t.revision],
      foreignColumns: [
        financeBudgetRevisions.workspaceId,
        financeBudgetRevisions.bookId,
        financeBudgetRevisions.budgetId,
        financeBudgetRevisions.revision,
      ],
    }),
    foreignKey({
      name: 'finance_budget_lines_period',
      columns: [t.workspaceId, t.bookId, t.periodId],
      foreignColumns: [
        financePeriods.workspaceId,
        financePeriods.bookId,
        financePeriods.id,
      ],
    }),
    foreignKey({
      name: 'finance_budget_lines_account',
      columns: [t.workspaceId, t.bookId, t.accountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    }),
    check(
      'finance_budget_lines_currency',
      sql`${t.currency} in ('CAD','USD','MXN','EUR','KRW','JPY')`,
    ),
    check(
      'finance_budget_lines_amount',
      sql`${t.amount} <> 'NaN'::numeric and ${t.amount} = round(${t.amount}, case when ${t.currency} in ('JPY','KRW') then 0 else 2 end)`,
    ),
    index('finance_budget_lines_period_account').on(
      t.workspaceId,
      t.bookId,
      t.periodId,
      t.accountId,
    ),
  ],
);

/**
 * Append-only forecast snapshot history. A logical forecast may have many
 * revisions, each pinned to an immutable budget revision and as-of date.
 */
export const financeForecastSnapshots = schema.table(
  'finance_forecast_snapshots',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    forecastId: uuid('forecast_id').notNull(),
    revision: integer('revision').notNull(),
    budgetId: uuid('budget_id').notNull(),
    budgetRevision: integer('budget_revision').notNull(),
    functionalCurrency: text('functional_currency').notNull(),
    asOf: date('as_of').notNull(),
    openingStatus: text('opening_status').notNull(),
    openingAmount: decimal('opening_amount'),
    openingCurrency: text('opening_currency'),
    openingSourceReference: text('opening_source_reference'),
    openingReviewedBy: uuid('opening_reviewed_by').references(
      () => authUsers.id,
    ),
    openingReviewedAt: timestamp('opening_reviewed_at', { withTimezone: true }),
    futureAssumptionStatus: text('future_assumption_status').notNull(),
    labels: jsonb('labels').notNull().default([]),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => authUsers.id),
    planningConstructionTxid: transactionId('planning_construction_txid')
      .notNull()
      .default(sql`pg_current_xact_id()`),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'finance_forecast_snapshots_pk',
      columns: [t.workspaceId, t.bookId, t.forecastId, t.revision],
    }),
    foreignKey({
      name: 'finance_forecast_snapshots_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    foreignKey({
      name: 'finance_forecast_snapshots_budget',
      columns: [t.workspaceId, t.bookId, t.budgetId, t.budgetRevision],
      foreignColumns: [
        financeBudgetRevisions.workspaceId,
        financeBudgetRevisions.bookId,
        financeBudgetRevisions.budgetId,
        financeBudgetRevisions.revision,
      ],
    }),
    check(
      'finance_forecast_snapshots_revision',
      sql`${t.revision} > 0 and ${t.revision} = trunc(${t.revision}) and ${t.budgetRevision} > 0 and ${t.budgetRevision} = trunc(${t.budgetRevision})`,
    ),
    check(
      'finance_forecast_snapshots_currency',
      sql`${t.functionalCurrency} in ('CAD','USD','MXN','EUR','KRW','JPY')`,
    ),
    check(
      'finance_forecast_snapshots_opening',
      sql`(${t.openingStatus} = 'unavailable' and ${t.openingAmount} is null and ${t.openingCurrency} is null and ${t.openingSourceReference} is null and ${t.openingReviewedBy} is null and ${t.openingReviewedAt} is null) or (${t.openingStatus} = 'available' and ${t.openingAmount} is not null and ${t.openingCurrency} is not null and ${t.openingSourceReference} is not null and ${t.openingReviewedBy} is not null and ${t.openingReviewedAt} is not null)`,
    ),
    check(
      'finance_forecast_snapshots_status',
      sql`${t.openingStatus} in ('available','unavailable') and ${t.futureAssumptionStatus} in ('not-applicable','provided','partial','unavailable') and jsonb_typeof(${t.labels}) = 'array'`,
    ),
    index('finance_forecast_snapshots_book').on(
      t.workspaceId,
      t.bookId,
      t.forecastId,
      t.revision,
    ),
  ],
);

export const financeForecastLines = schema.table(
  'finance_forecast_lines',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    forecastId: uuid('forecast_id').notNull(),
    revision: integer('revision').notNull(),
    periodId: uuid('period_id').notNull(),
    accountId: uuid('account_id').notNull(),
    currency: text('currency').notNull(),
    budgetAmount: decimal('budget_amount').notNull(),
    postedActualAmount: decimal('posted_actual_amount').notNull(),
    forecastAmount: decimal('forecast_amount'),
    basis: text('basis').notNull(),
    actualSignBasis: text('actual_sign_basis').notNull(),
    label: text('label'),
  },
  (t) => [
    primaryKey({
      name: 'finance_forecast_lines_pk',
      columns: [
        t.workspaceId,
        t.bookId,
        t.forecastId,
        t.revision,
        t.periodId,
        t.accountId,
        t.currency,
      ],
    }),
    foreignKey({
      name: 'finance_forecast_lines_snapshot',
      columns: [t.workspaceId, t.bookId, t.forecastId, t.revision],
      foreignColumns: [
        financeForecastSnapshots.workspaceId,
        financeForecastSnapshots.bookId,
        financeForecastSnapshots.forecastId,
        financeForecastSnapshots.revision,
      ],
    }),
    foreignKey({
      name: 'finance_forecast_lines_period',
      columns: [t.workspaceId, t.bookId, t.periodId],
      foreignColumns: [
        financePeriods.workspaceId,
        financePeriods.bookId,
        financePeriods.id,
      ],
    }),
    foreignKey({
      name: 'finance_forecast_lines_account',
      columns: [t.workspaceId, t.bookId, t.accountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    }),
    check(
      'finance_forecast_lines_currency',
      sql`${t.currency} in ('CAD','USD','MXN','EUR','KRW','JPY')`,
    ),
    check(
      'finance_forecast_lines_amount',
      sql`${t.budgetAmount} <> 'NaN'::numeric and ${t.postedActualAmount} <> 'NaN'::numeric and (${t.forecastAmount} is null or ${t.forecastAmount} <> 'NaN'::numeric)`,
    ),
    check(
      'finance_forecast_lines_basis',
      sql`${t.basis} in ('posted-actual','reviewed-assumption','unavailable') and ((${t.basis} = 'unavailable' and ${t.forecastAmount} is null and ${t.label} = 'future-assumption-unavailable') or (${t.basis} <> 'unavailable' and ${t.forecastAmount} is not null and ${t.label} is null))`,
    ),
    check(
      'finance_forecast_lines_sign_basis',
      sql`${t.actualSignBasis} in ('debit-minus-credit','credit-minus-debit')`,
    ),
  ],
);

export const financeForecastAssumptions = schema.table(
  'finance_forecast_assumptions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    forecastId: uuid('forecast_id').notNull(),
    revision: integer('revision').notNull(),
    periodId: uuid('period_id').notNull(),
    accountId: uuid('account_id').notNull(),
    currency: text('currency').notNull(),
    amount: decimal('amount').notNull(),
    label: text('label').notNull(),
    sourceReference: text('source_reference').notNull(),
    reviewedBy: uuid('reviewed_by')
      .notNull()
      .references(() => authUsers.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({
      name: 'finance_forecast_assumptions_pk',
      columns: [
        t.workspaceId,
        t.bookId,
        t.forecastId,
        t.revision,
        t.periodId,
        t.accountId,
        t.currency,
      ],
    }),
    foreignKey({
      name: 'finance_forecast_assumptions_snapshot',
      columns: [t.workspaceId, t.bookId, t.forecastId, t.revision],
      foreignColumns: [
        financeForecastSnapshots.workspaceId,
        financeForecastSnapshots.bookId,
        financeForecastSnapshots.forecastId,
        financeForecastSnapshots.revision,
      ],
    }),
    foreignKey({
      name: 'finance_forecast_assumptions_period',
      columns: [t.workspaceId, t.bookId, t.periodId],
      foreignColumns: [
        financePeriods.workspaceId,
        financePeriods.bookId,
        financePeriods.id,
      ],
    }),
    foreignKey({
      name: 'finance_forecast_assumptions_account',
      columns: [t.workspaceId, t.bookId, t.accountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    }),
    check(
      'finance_forecast_assumptions_currency',
      sql`${t.currency} in ('CAD','USD','MXN','EUR','KRW','JPY')`,
    ),
    check(
      'finance_forecast_assumptions_amount',
      sql`${t.amount} <> 'NaN'::numeric and ${t.amount} = round(${t.amount}, case when ${t.currency} in ('JPY','KRW') then 0 else 2 end)`,
    ),
    index('finance_forecast_assumptions_source').on(
      t.workspaceId,
      t.bookId,
      t.forecastId,
      t.revision,
    ),
  ],
);

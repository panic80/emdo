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
} from 'drizzle-orm/pg-core';
import {
  financeBooks,
  financeEconomicTransactions,
  financeFinancialAccounts,
  financeJournalLines,
  financeLedgerAccounts,
  financeNormalizedImportRows,
  workspaces,
} from './finance-v2-schema.js';

const schema = pgSchema('emdo');
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const decimal = (name: string) => numeric(name, { precision: 38, scale: 12 });

/** Immutable source facts plus the latest explicitly reviewed posting mapping. */
export const financeNormalizedImportAmountComponents = schema.table(
  'finance_normalized_import_amount_components',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    createdAt: createdAt(),
    bookId: uuid('book_id').notNull(),
    rowId: uuid('row_id').notNull(),
    componentKind: text('component_kind').notNull(),
    nativeAmount: decimal('native_amount').notNull(),
    currency: text('currency').notNull(),
    sourceProvenance: jsonb('source_provenance').notNull(),
    revision: integer('revision').default(1).notNull(),
    reviewedNativeAmount: decimal('reviewed_native_amount'),
    reviewedCurrency: text('reviewed_currency'),
    inclusion: text('inclusion'),
    postingSide: text('posting_side'),
    ledgerAccountId: uuid('ledger_account_id'),
    fxRate: decimal('fx_rate'),
    fxSource: text('fx_source'),
  },
  (t) => [
    unique('finance_normalized_import_amount_components_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    unique('finance_normalized_import_amount_components_kind').on(
      t.workspaceId,
      t.bookId,
      t.rowId,
      t.componentKind,
    ),
    foreignKey({
      name: 'finance_normalized_import_amount_components_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    foreignKey({
      name: 'finance_normalized_import_amount_components_row',
      columns: [t.workspaceId, t.bookId, t.rowId],
      foreignColumns: [
        financeNormalizedImportRows.workspaceId,
        financeNormalizedImportRows.bookId,
        financeNormalizedImportRows.id,
      ],
    }),
    foreignKey({
      name: 'finance_normalized_import_amount_components_account',
      columns: [t.workspaceId, t.bookId, t.ledgerAccountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    }),
    check(
      'finance_normalized_import_amount_components_kind_check',
      sql`${t.componentKind} in ('fee','commission','tax','principal','interest')`,
    ),
    check(
      'finance_normalized_import_amount_components_currency_check',
      sql`${t.currency} in ('CAD','USD','MXN','EUR','KRW','JPY') and (${t.reviewedCurrency} is null or ${t.reviewedCurrency} in ('CAD','USD','MXN','EUR','KRW','JPY'))`,
    ),
    check(
      'finance_normalized_import_amount_components_source_amount_check',
      sql`${t.nativeAmount}<>'NaN'::numeric and ${t.nativeAmount}=round(${t.nativeAmount},case when ${t.currency} in ('JPY','KRW') then 0 else 2 end)`,
    ),
    check(
      'finance_normalized_import_amount_components_revision_check',
      sql`${t.revision}>0`,
    ),
    check(
      'finance_normalized_import_amount_components_mapping_check',
      sql`(
        (${t.reviewedNativeAmount} is null and ${t.reviewedCurrency} is null and ${t.inclusion} is null and ${t.postingSide} is null and ${t.ledgerAccountId} is null and ${t.fxRate} is null and ${t.fxSource} is null)
        or
        (${t.reviewedNativeAmount} is not null and ${t.reviewedNativeAmount}<>'NaN'::numeric and ${t.reviewedCurrency} is not null and ${t.reviewedNativeAmount}=round(${t.reviewedNativeAmount},case when ${t.reviewedCurrency} in ('JPY','KRW') then 0 else 2 end) and ${t.inclusion} in ('included-in-net','excluded-from-net') and ${t.postingSide} in ('debit','credit') and ${t.ledgerAccountId} is not null and ${t.fxRate} is not null and ${t.fxRate}>0 and ${t.fxRate}<>'NaN'::numeric and length(${t.fxSource}) between 1 and 200)
      )`,
    ),
    index('finance_normalized_import_amount_components_row_idx').on(
      t.workspaceId,
      t.bookId,
      t.rowId,
    ),
  ],
);

/** Immutable component facts copied onto the committed economic transaction. */
export const financeEconomicTransactionAmountComponents = schema.table(
  'finance_economic_transaction_amount_components',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    createdAt: createdAt(),
    bookId: uuid('book_id').notNull(),
    economicTransactionId: uuid('economic_transaction_id').notNull(),
    sourceComponentId: uuid('source_component_id').notNull(),
    componentKind: text('component_kind').notNull(),
    nativeAmount: decimal('native_amount').notNull(),
    currency: text('currency').notNull(),
    functionalAmount: decimal('functional_amount').notNull(),
    inclusion: text('inclusion').notNull(),
    postingSide: text('posting_side').notNull(),
    ledgerAccountId: uuid('ledger_account_id').notNull(),
    fxRate: decimal('fx_rate').notNull(),
    fxSource: text('fx_source').notNull(),
    journalId: uuid('journal_id').notNull(),
    journalLineNumber: integer('journal_line_number'),
    sourceProvenance: jsonb('source_provenance').notNull(),
  },
  (t) => [
    unique('finance_economic_transaction_amount_components_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    unique('finance_economic_transaction_amount_components_kind').on(
      t.workspaceId,
      t.bookId,
      t.economicTransactionId,
      t.componentKind,
    ),
    unique('finance_economic_transaction_amount_components_source').on(
      t.workspaceId,
      t.bookId,
      t.sourceComponentId,
    ),
    foreignKey({
      name: 'finance_economic_transaction_amount_components_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    foreignKey({
      name: 'finance_economic_transaction_amount_components_transaction',
      columns: [t.workspaceId, t.bookId, t.economicTransactionId],
      foreignColumns: [
        financeEconomicTransactions.workspaceId,
        financeEconomicTransactions.bookId,
        financeEconomicTransactions.id,
      ],
    }),
    foreignKey({
      name: 'finance_economic_transaction_amount_components_source_fk',
      columns: [t.workspaceId, t.bookId, t.sourceComponentId],
      foreignColumns: [
        financeNormalizedImportAmountComponents.workspaceId,
        financeNormalizedImportAmountComponents.bookId,
        financeNormalizedImportAmountComponents.id,
      ],
    }),
    foreignKey({
      name: 'finance_economic_transaction_amount_components_account',
      columns: [t.workspaceId, t.bookId, t.ledgerAccountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_economic_transaction_amount_components_journal_line',
      columns: [t.workspaceId, t.bookId, t.journalId, t.journalLineNumber],
      foreignColumns: [
        financeJournalLines.workspaceId,
        financeJournalLines.bookId,
        financeJournalLines.journalId,
        financeJournalLines.lineNumber,
      ],
    }),
    check(
      'finance_economic_transaction_amount_components_kind_check',
      sql`${t.componentKind} in ('fee','commission','tax','principal','interest')`,
    ),
    check(
      'finance_economic_transaction_amount_components_currency_check',
      sql`${t.currency} in ('CAD','USD','MXN','EUR','KRW','JPY')`,
    ),
    check(
      'finance_economic_transaction_amount_components_amounts_check',
      sql`${t.nativeAmount}<>'NaN'::numeric and ${t.nativeAmount}=round(${t.nativeAmount},case when ${t.currency} in ('JPY','KRW') then 0 else 2 end) and ${t.functionalAmount}<>'NaN'::numeric and ${t.fxRate}>0 and ${t.fxRate}<>'NaN'::numeric`,
    ),
    check(
      'finance_economic_transaction_amount_components_mapping_check',
      sql`${t.inclusion}='included-in-net' and ${t.postingSide} in ('debit','credit') and (${t.functionalAmount}=0 and ${t.journalLineNumber} is null or ${t.functionalAmount}<>0 and ${t.journalLineNumber} is not null)`,
    ),
    index('finance_economic_transaction_amount_components_transaction_idx').on(
      t.workspaceId,
      t.bookId,
      t.economicTransactionId,
    ),
  ],
);

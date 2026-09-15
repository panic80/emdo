import { sql } from 'drizzle-orm';
import {
  check,
  date,
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
import { authUsers } from './schema.js';
import {
  financeBookEvidence,
  financeBooks,
  financeEconomicTransactions,
  financeFinancialAccounts,
  financeInstruments,
  financeJournalLines,
  financeJournals,
  financeLedgerAccounts,
  financeNormalizedImportRows,
} from './finance-v2-schema.js';

const schema = pgSchema('emdo');
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const decimal = (name: string) => numeric(name, { precision: 38, scale: 12 });

/** Immutable reviewed cash-dividend action linked to its normalized receipt. */
export const financeInvestmentCashDividends = schema.table(
  'finance_investment_cash_dividends',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    createdAt: createdAt(),
    bookId: uuid('book_id').notNull(),
    actionType: text('action_type').notNull(),
    financialAccountId: uuid('financial_account_id').notNull(),
    instrumentId: uuid('instrument_id').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    sourceRowId: uuid('source_row_id').notNull(),
    declaredOn: date('declared_on').notNull(),
    exDate: date('ex_date'),
    payableOn: date('payable_on').notNull(),
    sourceReference: text('source_reference').notNull(),
    reviewReason: text('review_reason').notNull(),
    cashLedgerAccountId: uuid('cash_ledger_account_id').notNull(),
    dividendIncomeLedgerAccountId: uuid(
      'dividend_income_ledger_account_id',
    ).notNull(),
    withholdingLedgerAccountId: uuid('withholding_ledger_account_id').notNull(),
    sourceRevision: integer('source_revision').notNull(),
    sourceSnapshotHash: text('source_snapshot_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    commandHash: text('command_hash').notNull(),
    economicTransactionId: uuid('economic_transaction_id').notNull(),
    journalId: uuid('journal_id').notNull(),
    status: text('status').default('committed').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => authUsers.id),
  },
  (t) => [
    unique('finance_investment_cash_dividends_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    unique('finance_investment_cash_dividends_idempotency').on(
      t.workspaceId,
      t.bookId,
      t.idempotencyKey,
    ),
    unique('finance_investment_cash_dividends_source_row_identity').on(
      t.workspaceId,
      t.bookId,
      t.sourceRowId,
    ),
    foreignKey({
      name: 'finance_investment_cash_dividends_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    foreignKey({
      name: 'finance_investment_cash_dividends_account',
      columns: [t.workspaceId, t.bookId, t.financialAccountId],
      foreignColumns: [
        financeFinancialAccounts.workspaceId,
        financeFinancialAccounts.bookId,
        financeFinancialAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_cash_dividends_instrument',
      columns: [t.workspaceId, t.bookId, t.instrumentId],
      foreignColumns: [
        financeInstruments.workspaceId,
        financeInstruments.bookId,
        financeInstruments.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_cash_dividends_evidence',
      columns: [t.workspaceId, t.bookId, t.evidenceId],
      foreignColumns: [
        financeBookEvidence.workspaceId,
        financeBookEvidence.bookId,
        financeBookEvidence.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_cash_dividends_source_row',
      columns: [t.workspaceId, t.bookId, t.sourceRowId],
      foreignColumns: [
        financeNormalizedImportRows.workspaceId,
        financeNormalizedImportRows.bookId,
        financeNormalizedImportRows.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_cash_dividends_cash_account',
      columns: [t.workspaceId, t.bookId, t.cashLedgerAccountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_cash_dividends_income_account',
      columns: [t.workspaceId, t.bookId, t.dividendIncomeLedgerAccountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_cash_dividends_withholding_account',
      columns: [t.workspaceId, t.bookId, t.withholdingLedgerAccountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_cash_dividends_transaction',
      columns: [t.workspaceId, t.bookId, t.economicTransactionId],
      foreignColumns: [
        financeEconomicTransactions.workspaceId,
        financeEconomicTransactions.bookId,
        financeEconomicTransactions.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_cash_dividends_journal',
      columns: [t.workspaceId, t.bookId, t.journalId],
      foreignColumns: [
        financeJournals.workspaceId,
        financeJournals.bookId,
        financeJournals.id,
      ],
    }),
    check(
      'finance_investment_cash_dividends_valid',
      sql`${t.actionType}='cash-dividend' and ${t.status}='committed' and ${t.declaredOn}<=${t.payableOn} and (${t.exDate} is null or (${t.exDate}>=${t.declaredOn} and ${t.exDate}<=${t.payableOn})) and ${t.sourceRevision}>0 and ${t.sourceSnapshotHash} ~ '^[a-f0-9]{64}$' and ${t.commandHash} ~ '^[a-f0-9]{64}$' and length(trim(${t.sourceReference})) between 1 and 500 and length(trim(${t.reviewReason})) between 1 and 2000 and length(trim(${t.idempotencyKey})) between 1 and 200`,
    ),
    check(
      'finance_investment_cash_dividends_distinct_accounts',
      sql`${t.cashLedgerAccountId}<>${t.dividendIncomeLedgerAccountId} and ${t.cashLedgerAccountId}<>${t.withholdingLedgerAccountId} and ${t.dividendIncomeLedgerAccountId}<>${t.withholdingLedgerAccountId}`,
    ),
    index('finance_investment_cash_dividends_lookup').on(
      t.workspaceId,
      t.bookId,
      t.payableOn,
      t.financialAccountId,
      t.instrumentId,
    ),
  ],
);

/** Gross, withholding, and net are retained as separate immutable proofs. */
export const financeInvestmentCashDividendAmounts = schema.table(
  'finance_investment_cash_dividend_amounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    createdAt: createdAt(),
    bookId: uuid('book_id').notNull(),
    actionId: uuid('action_id').notNull(),
    kind: text('kind').notNull(),
    nativeAmount: decimal('native_amount').notNull(),
    currency: text('currency').notNull(),
    functionalAmount: decimal('functional_amount').notNull(),
    fxRate: decimal('fx_rate').notNull(),
    fxSource: text('fx_source').notNull(),
    ledgerAccountId: uuid('ledger_account_id').notNull(),
    postingSide: text('posting_side').notNull(),
    journalId: uuid('journal_id').notNull(),
    journalLineNumber: integer('journal_line_number'),
    sourceProvenance: jsonb('source_provenance').notNull(),
  },
  (t) => [
    unique('finance_investment_cash_dividend_amounts_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    unique('finance_investment_cash_dividend_amounts_kind').on(
      t.workspaceId,
      t.bookId,
      t.actionId,
      t.kind,
    ),
    foreignKey({
      name: 'finance_investment_cash_dividend_amounts_action',
      columns: [t.workspaceId, t.bookId, t.actionId],
      foreignColumns: [
        financeInvestmentCashDividends.workspaceId,
        financeInvestmentCashDividends.bookId,
        financeInvestmentCashDividends.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_cash_dividend_amounts_account',
      columns: [t.workspaceId, t.bookId, t.ledgerAccountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_cash_dividend_amounts_journal',
      columns: [t.workspaceId, t.bookId, t.journalId],
      foreignColumns: [
        financeJournals.workspaceId,
        financeJournals.bookId,
        financeJournals.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_cash_dividend_amounts_journal_line',
      columns: [t.workspaceId, t.bookId, t.journalId, t.journalLineNumber],
      foreignColumns: [
        financeJournalLines.workspaceId,
        financeJournalLines.bookId,
        financeJournalLines.journalId,
        financeJournalLines.lineNumber,
      ],
    }),
    check(
      'finance_investment_cash_dividend_amounts_valid',
      sql`${t.kind} in ('gross','withholding','net') and ${t.currency} in ('CAD','USD','MXN','EUR','KRW','JPY') and ${t.nativeAmount}>=0 and ${t.nativeAmount}<>'NaN'::numeric and ${t.nativeAmount}=round(${t.nativeAmount},case when ${t.currency} in ('JPY','KRW') then 0 else 2 end) and ${t.functionalAmount}>=0 and ${t.functionalAmount}<>'NaN'::numeric and ${t.fxRate}>0 and ${t.fxRate}<>'NaN'::numeric and length(trim(${t.fxSource})) between 1 and 200 and ${t.postingSide} in ('debit','credit') and (${t.functionalAmount}=0 and ${t.journalLineNumber} is null or ${t.functionalAmount}>0 and ${t.journalLineNumber} is not null) and jsonb_typeof(${t.sourceProvenance})='object'`,
    ),
    index('finance_investment_cash_dividend_amounts_lookup').on(
      t.workspaceId,
      t.bookId,
      t.actionId,
    ),
  ],
);

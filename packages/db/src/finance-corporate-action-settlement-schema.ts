import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './schema.js';
import {
  financeBookEvidence,
  financeEconomicTransactions,
  financeInvestmentCorporateActions,
  financeInvestmentCorporateActionEffects,
  financeJournals,
  financeNormalizedImportRows,
} from './finance-v2-schema.js';

const schema = pgSchema('emdo');
export const financeInvestmentCorporateActionSettlements = schema.table(
  'finance_investment_corporate_action_settlements',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    actionId: uuid('action_id').notNull(),
    sourceRowId: uuid('source_row_id').notNull(),
    receiptRevision: integer('receipt_revision').notNull(),
    receiptSnapshotHash: text('receipt_snapshot_hash').notNull(),
    economicTransactionId: uuid('economic_transaction_id').notNull(),
    actionJournalId: uuid('action_journal_id').notNull(),
    receiptJournalId: uuid('receipt_journal_id').notNull(),
    commandHash: text('command_hash').notNull(),
    proof: jsonb('proof').notNull(),
    proofHash: text('proof_hash').notNull(),
    result: jsonb('result').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    unique('finance_ca_settlement_scope').on(t.workspaceId, t.bookId, t.id),
    unique('finance_ca_settlement_action').on(
      t.workspaceId,
      t.bookId,
      t.actionId,
    ),
    unique('finance_ca_settlement_receipt').on(
      t.workspaceId,
      t.bookId,
      t.sourceRowId,
    ),
    unique('finance_ca_settlement_economic').on(
      t.workspaceId,
      t.bookId,
      t.economicTransactionId,
    ),
    foreignKey({
      name: 'finance_ca_settlement_creator_fk',
      columns: [t.createdBy],
      foreignColumns: [authUsers.id],
    }),
    foreignKey({
      name: 'finance_ca_settlement_action_fk',
      columns: [t.workspaceId, t.bookId, t.actionId],
      foreignColumns: [
        financeInvestmentCorporateActions.workspaceId,
        financeInvestmentCorporateActions.bookId,
        financeInvestmentCorporateActions.id,
      ],
    }),
    foreignKey({
      name: 'finance_ca_settlement_receipt_fk',
      columns: [t.workspaceId, t.bookId, t.sourceRowId],
      foreignColumns: [
        financeNormalizedImportRows.workspaceId,
        financeNormalizedImportRows.bookId,
        financeNormalizedImportRows.id,
      ],
    }),
    foreignKey({
      name: 'finance_ca_settlement_economic_fk',
      columns: [t.workspaceId, t.bookId, t.economicTransactionId],
      foreignColumns: [
        financeEconomicTransactions.workspaceId,
        financeEconomicTransactions.bookId,
        financeEconomicTransactions.id,
      ],
    }),
    foreignKey({
      name: 'finance_ca_settlement_action_journal_fk',
      columns: [t.workspaceId, t.bookId, t.actionJournalId],
      foreignColumns: [
        financeJournals.workspaceId,
        financeJournals.bookId,
        financeJournals.id,
      ],
    }),
    foreignKey({
      name: 'finance_ca_settlement_receipt_journal_fk',
      columns: [t.workspaceId, t.bookId, t.receiptJournalId],
      foreignColumns: [
        financeJournals.workspaceId,
        financeJournals.bookId,
        financeJournals.id,
      ],
    }),
    check(
      'finance_ca_settlement_receipt_revision_check',
      sql`${t.receiptRevision}>=0`,
    ),
    check(
      'finance_ca_settlement_receipt_hash_check',
      sql`${t.receiptSnapshotHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'finance_ca_settlement_command_hash_check',
      sql`${t.commandHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'finance_ca_settlement_proof_hash_check',
      sql`${t.proofHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'finance_ca_settlement_proof_check',
      sql`jsonb_typeof(${t.proof})='object'`,
    ),
    check(
      'finance_ca_settlement_result_check',
      sql`jsonb_typeof(${t.result})='object'`,
    ),
  ],
);
export const financeInvestmentCorporateActionSettlementEvidence = schema.table(
  'finance_investment_corporate_action_settlement_evidence',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    settlementId: uuid('settlement_id').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    plaintextSha256: text('plaintext_sha256').notNull(),
  },
  (t) => [
    primaryKey({
      name: 'finance_ca_settlement_evidence_pk',
      columns: [t.workspaceId, t.bookId, t.settlementId, t.evidenceId],
    }),
    foreignKey({
      name: 'finance_ca_settlement_evidence_settlement_fk',
      columns: [t.workspaceId, t.bookId, t.settlementId],
      foreignColumns: [
        financeInvestmentCorporateActionSettlements.workspaceId,
        financeInvestmentCorporateActionSettlements.bookId,
        financeInvestmentCorporateActionSettlements.id,
      ],
    }),
    foreignKey({
      name: 'finance_ca_settlement_evidence_evidence_fk',
      columns: [t.workspaceId, t.bookId, t.evidenceId],
      foreignColumns: [
        financeBookEvidence.workspaceId,
        financeBookEvidence.bookId,
        financeBookEvidence.id,
      ],
    }),
    check(
      'finance_ca_settlement_evidence_hash_check',
      sql`${t.plaintextSha256} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
const cost = (name: string) =>
  numeric(name, { precision: 38, scale: 12 }).notNull();
export const financeInvestmentCorporateActionSettlementAllocations =
  schema.table(
    'finance_investment_corporate_action_settlement_allocations',
    {
      workspaceId: uuid('workspace_id').notNull(),
      bookId: uuid('book_id').notNull(),
      settlementId: uuid('settlement_id').notNull(),
      actionId: uuid('action_id').notNull(),
      sourceLotId: uuid('source_lot_id').notNull(),
      retainedNumerator: text('retained_numerator').notNull(),
      retainedDenominator: text('retained_denominator').notNull(),
      disposedNumerator: text('disposed_numerator').notNull(),
      disposedDenominator: text('disposed_denominator').notNull(),
      retainedNativeCost: cost('retained_native_cost'),
      retainedFunctionalCost: cost('retained_functional_cost'),
      disposedNativeCost: cost('disposed_native_cost'),
      disposedFunctionalCost: cost('disposed_functional_cost'),
    },
    (t) => [
      primaryKey({
        name: 'finance_ca_settlement_allocation_pk',
        columns: [t.workspaceId, t.bookId, t.settlementId, t.sourceLotId],
      }),
      foreignKey({
        name: 'finance_ca_settlement_allocation_settlement_fk',
        columns: [t.workspaceId, t.bookId, t.settlementId],
        foreignColumns: [
          financeInvestmentCorporateActionSettlements.workspaceId,
          financeInvestmentCorporateActionSettlements.bookId,
          financeInvestmentCorporateActionSettlements.id,
        ],
      }),
      foreignKey({
        name: 'finance_ca_settlement_allocation_effect_fk',
        columns: [t.workspaceId, t.bookId, t.actionId, t.sourceLotId],
        foreignColumns: [
          financeInvestmentCorporateActionEffects.workspaceId,
          financeInvestmentCorporateActionEffects.bookId,
          financeInvestmentCorporateActionEffects.actionId,
          financeInvestmentCorporateActionEffects.sourceLotId,
        ],
      }),
      check(
        'finance_ca_settlement_retained_numerator_check',
        sql`${t.retainedNumerator} ~ '^(0|[1-9][0-9]{0,119})$'`,
      ),
      check(
        'finance_ca_settlement_retained_denominator_check',
        sql`${t.retainedDenominator} ~ '^[1-9][0-9]{0,119}$'`,
      ),
      check(
        'finance_ca_settlement_disposed_numerator_check',
        sql`${t.disposedNumerator} ~ '^(0|[1-9][0-9]{0,119})$'`,
      ),
      check(
        'finance_ca_settlement_disposed_denominator_check',
        sql`${t.disposedDenominator} ~ '^[1-9][0-9]{0,119}$'`,
      ),
      check(
        'finance_ca_settlement_retained_native_cost_check',
        sql`${t.retainedNativeCost}>=0 AND ${t.retainedNativeCost}<>'NaN'::numeric`,
      ),
      check(
        'finance_ca_settlement_retained_functional_cost_check',
        sql`${t.retainedFunctionalCost}>=0 AND ${t.retainedFunctionalCost}<>'NaN'::numeric`,
      ),
      check(
        'finance_ca_settlement_disposed_native_cost_check',
        sql`${t.disposedNativeCost}>=0 AND ${t.disposedNativeCost}<>'NaN'::numeric`,
      ),
      check(
        'finance_ca_settlement_disposed_functional_cost_check',
        sql`${t.disposedFunctionalCost}>=0 AND ${t.disposedFunctionalCost}<>'NaN'::numeric`,
      ),
    ],
  );

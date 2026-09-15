import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  customType,
} from 'drizzle-orm/pg-core';

import {
  financeBooks,
  financeJournals,
  financeLedgerAccounts,
} from './finance-v2-schema.js';
import { authUsers } from './schema.js';

const schema = pgSchema('emdo');
const transactionId = customType<{ data: string }>({
  dataType: () => 'xid8',
});

const actor = (name: string) =>
  uuid(name)
    .notNull()
    .default(sql`emdo.current_user_id()`)
    .references(() => authUsers.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    });
const reviewedAt = (name: string) =>
  timestamp(name, { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`);
const createdAt = () =>
  timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`);
const constructionTxid = () =>
  transactionId('fec_construction_txid')
    .notNull()
    .default(sql`pg_current_xact_id()`);

/** One complete, immutable legal-entity/opening policy review for a book. */
export const financeFecBookMappingRevisions = schema.table(
  'finance_fec_book_mapping_revisions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    revision: integer('revision').notNull(),
    siren: text('siren').notNull(),
    sirenSourceReference: text('siren_source_reference').notNull(),
    sirenSourceDigest: text('siren_source_digest').notNull(),
    openingStatus: text('opening_status').notNull(),
    openingSourceReference: text('opening_source_reference').notNull(),
    openingSourceDigest: text('opening_source_digest').notNull(),
    reviewedBy: actor('reviewed_by'),
    reviewedAt: reviewedAt('reviewed_at'),
    createdBy: actor('created_by'),
    createdAt: createdAt(),
    fecConstructionTxid: constructionTxid(),
  },
  (t) => [
    primaryKey({
      name: 'finance_fec_book_mapping_revisions_pk',
      columns: [t.workspaceId, t.bookId, t.revision],
    }),
    foreignKey({
      name: 'finance_fec_book_mapping_revisions_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'finance_fec_book_mapping_revisions_revision',
      sql`${t.revision} > 0`,
    ),
    check(
      'finance_fec_book_mapping_revisions_siren',
      sql`${t.siren} ~ '^[0-9]{9}$'`,
    ),
    check(
      'finance_fec_book_mapping_revisions_sources',
      sql`length(btrim(${t.sirenSourceReference})) between 1 and 500
        and ${t.sirenSourceReference} !~ '[[:cntrl:]]'
        and ${t.sirenSourceDigest} ~ '^[a-f0-9]{64}$'
        and ${t.openingStatus} in ('included','not-applicable')
        and length(btrim(${t.openingSourceReference})) between 1 and 500
        and ${t.openingSourceReference} !~ '[[:cntrl:]]'
        and ${t.openingSourceDigest} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/** Entry-level reviewed values, constructed with the header in one transaction. */
export const financeFecJournalMappings = schema.table(
  'finance_fec_journal_mappings',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    journalId: uuid('journal_id').notNull(),
    revision: integer('revision').notNull(),
    entrySequence: integer('entry_sequence').notNull(),
    entryNumber: text('entry_number').notNull(),
    entryKind: text('entry_kind').notNull(),
    journalCode: text('journal_code').notNull(),
    journalLabel: text('journal_label').notNull(),
    pieceReference: text('piece_reference').notNull(),
    pieceDate: date('piece_date').notNull(),
    entryLabel: text('entry_label').notNull(),
    validationDate: date('validation_date').notNull(),
    reviewedBy: actor('reviewed_by'),
    reviewedAt: reviewedAt('reviewed_at'),
    createdBy: actor('created_by'),
    createdAt: createdAt(),
    fecConstructionTxid: constructionTxid(),
  },
  (t) => [
    primaryKey({
      name: 'finance_fec_journal_mappings_pk',
      columns: [t.workspaceId, t.bookId, t.journalId, t.revision],
    }),
    foreignKey({
      name: 'finance_fec_journal_mappings_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_fec_journal_mappings_header',
      columns: [t.workspaceId, t.bookId, t.revision],
      foreignColumns: [
        financeFecBookMappingRevisions.workspaceId,
        financeFecBookMappingRevisions.bookId,
        financeFecBookMappingRevisions.revision,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_fec_journal_mappings_journal',
      columns: [t.workspaceId, t.bookId, t.journalId],
      foreignColumns: [
        financeJournals.workspaceId,
        financeJournals.bookId,
        financeJournals.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('finance_fec_journal_mappings_revision', sql`${t.revision} > 0`),
    check(
      'finance_fec_journal_mappings_entry_sequence',
      sql`${t.entrySequence} > 0`,
    ),
    check(
      'finance_fec_journal_mappings_kind',
      sql`${t.entryKind} in ('opening','normal','inventory')`,
    ),
    check(
      'finance_fec_journal_mappings_text',
      sql`length(btrim(${t.entryNumber})) between 1 and 200
        and ${t.entryNumber} !~ '[[:cntrl:]]'
        and length(btrim(${t.journalCode})) between 1 and 200
        and ${t.journalCode} !~ '[[:cntrl:]]'
        and length(btrim(${t.journalLabel})) between 1 and 500
        and ${t.journalLabel} !~ '[[:cntrl:]]'
        and length(btrim(${t.pieceReference})) between 1 and 500
        and ${t.pieceReference} !~ '[[:cntrl:]]'
        and length(btrim(${t.entryLabel})) between 1 and 2000
        and ${t.entryLabel} !~ '[[:cntrl:]]'`,
    ),
    uniqueIndex('finance_fec_journal_mappings_entry_sequence').on(
      t.workspaceId,
      t.bookId,
      t.revision,
      t.entrySequence,
    ),
    uniqueIndex('finance_fec_journal_mappings_entry_number').on(
      t.workspaceId,
      t.bookId,
      t.revision,
      sql`btrim(${t.entryNumber})`,
    ),
    index('finance_fec_journal_mappings_revision').on(
      t.workspaceId,
      t.bookId,
      t.revision,
      t.journalId,
    ),
  ],
);

/** Account-level reviewed values used for FEC account and auxiliary columns. */
export const financeFecAccountMappings = schema.table(
  'finance_fec_account_mappings',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    accountId: uuid('account_id').notNull(),
    revision: integer('revision').notNull(),
    accountNumber: text('account_number').notNull(),
    accountLabel: text('account_label').notNull(),
    auxiliaryAccountNumber: text('auxiliary_account_number'),
    auxiliaryAccountLabel: text('auxiliary_account_label'),
    reviewedBy: actor('reviewed_by'),
    reviewedAt: reviewedAt('reviewed_at'),
    createdBy: actor('created_by'),
    createdAt: createdAt(),
    fecConstructionTxid: constructionTxid(),
  },
  (t) => [
    primaryKey({
      name: 'finance_fec_account_mappings_pk',
      columns: [t.workspaceId, t.bookId, t.accountId, t.revision],
    }),
    foreignKey({
      name: 'finance_fec_account_mappings_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_fec_account_mappings_header',
      columns: [t.workspaceId, t.bookId, t.revision],
      foreignColumns: [
        financeFecBookMappingRevisions.workspaceId,
        financeFecBookMappingRevisions.bookId,
        financeFecBookMappingRevisions.revision,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_fec_account_mappings_account_fk',
      columns: [t.workspaceId, t.bookId, t.accountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('finance_fec_account_mappings_revision', sql`${t.revision} > 0`),
    check(
      'finance_fec_account_mappings_account',
      sql`length(btrim(${t.accountNumber})) between 3 and 100
        and btrim(${t.accountNumber}) ~ '^[0-9]{3}'
        and ${t.accountNumber} !~ '[[:cntrl:]]'
        and length(btrim(${t.accountLabel})) between 1 and 500
        and ${t.accountLabel} !~ '[[:cntrl:]]'`,
    ),
    check(
      'finance_fec_account_mappings_auxiliary_pair',
      sql`((${t.auxiliaryAccountNumber} is null and ${t.auxiliaryAccountLabel} is null)
        or (length(btrim(${t.auxiliaryAccountNumber})) between 1 and 100
          and ${t.auxiliaryAccountNumber} !~ '[[:cntrl:]]'
          and length(btrim(${t.auxiliaryAccountLabel})) between 1 and 500
          and ${t.auxiliaryAccountLabel} !~ '[[:cntrl:]]')) is true`,
    ),
    index('finance_fec_account_mappings_revision').on(
      t.workspaceId,
      t.bookId,
      t.revision,
      t.accountId,
    ),
  ],
);

/** Immutable, content-hashed export receipts keyed by scoped idempotency key. */
export const financeFecExportReceipts = schema.table(
  'finance_fec_export_receipts',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    mappingRevision: integer('mapping_revision').notNull(),
    periodStartsOn: date('period_starts_on').notNull(),
    periodEndsOn: date('period_ends_on').notNull(),
    requestHash: text('request_hash').notNull(),
    resultHash: text('result_hash').notNull(),
    result: jsonb('result').notNull(),
    createdBy: actor('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'finance_fec_export_receipts_pk',
      columns: [t.workspaceId, t.bookId, t.idempotencyKey],
    }),
    foreignKey({
      name: 'finance_fec_export_receipts_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_fec_export_receipts_header',
      columns: [t.workspaceId, t.bookId, t.mappingRevision],
      foreignColumns: [
        financeFecBookMappingRevisions.workspaceId,
        financeFecBookMappingRevisions.bookId,
        financeFecBookMappingRevisions.revision,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'finance_fec_export_receipts_key',
      sql`${t.idempotencyKey} ~ '^[A-Za-z0-9._:-]{1,128}$'`,
    ),
    check(
      'finance_fec_export_receipts_revision',
      sql`${t.mappingRevision} > 0`,
    ),
    check(
      'finance_fec_export_receipts_period',
      sql`${t.periodStartsOn} <= ${t.periodEndsOn}`,
    ),
    check(
      'finance_fec_export_receipts_hashes',
      sql`${t.requestHash} ~ '^[a-f0-9]{64}$' and ${t.resultHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'finance_fec_export_receipts_shape',
      sql`(
        pg_catalog.jsonb_typeof(${t.result}) = 'object'
        and ${t.result}->>'status' = 'ready'
        and pg_catalog.jsonb_typeof(${t.result}->'review') = 'object'
        and ${t.result}->'review'->>'status' = 'ready'
        and pg_catalog.jsonb_typeof(${t.result}->'review'->'errors') = 'array'
        and case when pg_catalog.jsonb_typeof(${t.result}->'review'->'errors') = 'array'
          then pg_catalog.jsonb_array_length(${t.result}->'review'->'errors') = 0
          else false end
        and pg_catalog.jsonb_typeof(${t.result}->'review'->'entryCount') = 'number'
        and pg_catalog.jsonb_typeof(${t.result}->'review'->'lineCount') = 'number'
        and pg_catalog.jsonb_typeof(${t.result}->'review'->'fileName') = 'string'
        and pg_catalog.jsonb_typeof(${t.result}->'review'->'sourceLineage') = 'array'
        and pg_catalog.jsonb_typeof(${t.result}->'review'->'standard') = 'object'
        and pg_catalog.jsonb_typeof(${t.result}->'file') = 'object'
        and pg_catalog.jsonb_typeof(${t.result}->'file'->'fileName') = 'string'
        and pg_catalog.jsonb_typeof(${t.result}->'file'->'content') = 'string'
        and pg_catalog.jsonb_typeof(${t.result}->'file'->'byteLength') = 'number'
        and pg_catalog.jsonb_typeof(${t.result}->'file'->'columns') = 'array'
        and case when pg_catalog.jsonb_typeof(${t.result}->'file'->'columns') = 'array'
          then pg_catalog.jsonb_array_length(${t.result}->'file'->'columns') = 18
          else false end
        and ${t.result}->'file'->>'encoding' = 'UTF-8'
        and ${t.result}->'file'->>'separator' = E'\\t'
        and ${t.result}->'file'->>'lineEnding' = E'\\r\\n'
        and pg_catalog.jsonb_typeof(${t.result}->'sourceLineage') = 'array'
        and ${t.result}->'sourceLineage' = ${t.result}->'review'->'sourceLineage'
        and pg_catalog.octet_length(${t.result}::text) <= 8000000
      ) is true`,
    ),
  ],
);

export const financeFecSchema = {
  financeFecBookMappingRevisions,
  financeFecJournalMappings,
  financeFecAccountMappings,
  financeFecExportReceipts,
};

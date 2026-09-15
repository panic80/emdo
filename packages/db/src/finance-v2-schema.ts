import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers, households, householdMemberships } from './schema.js';

const schema = pgSchema('emdo');
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const decimal = (name: string) => numeric(name, { precision: 38, scale: 12 });
const owned = () => ({
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  createdAt: createdAt(),
});
const booked = () => ({ ...owned(), bookId: uuid('book_id').notNull() });

/** Stable 1:1 extension of legacy tenant identities; memberships retain one authority. */
export const workspaces = schema.table(
  'workspaces',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => households.id, { onDelete: 'restrict' }),
    usageType: text('usage_type').default('household').notNull(),
    tierCode: text('tier_code').default('pilot').notNull(),
    timezone: text('timezone').default('America/Toronto').notNull(),
    locale: text('locale').default('en-CA').notNull(),
    revision: integer('revision').default(0).notNull(),
  },
  (t) => [
    check(
      'workspaces_usage_type',
      sql`${t.usageType} in ('personal','household','organization')`,
    ),
    check('workspaces_revision', sql`${t.revision} >= 0`),
  ],
);

export const workspaceEntitlements = schema.table(
  'workspace_entitlements',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    capability: text('capability').notNull(),
    enabled: boolean('enabled').notNull(),
    limit: integer('limit'),
    revision: integer('revision').default(1).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.capability] }),
    check(
      'workspace_entitlement_limit',
      sql`${t.limit} is null or ${t.limit} >= 0`,
    ),
  ],
);

export const financeEntities = schema.table(
  'finance_entities',
  {
    ...owned(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    country: text('country').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => authUsers.id),
  },
  (t) => [
    unique('finance_entities_scope').on(t.workspaceId, t.id),
    check(
      'finance_entities_kind',
      sql`${t.kind} in ('individual','sole-proprietor','corporation')`,
    ),
    check(
      'finance_entities_country',
      sql`${t.country} in ('CA','US','MX','DE','KR','JP','FR')`,
    ),
  ],
);

export const financeBooks = schema.table(
  'finance_books',
  {
    ...owned(),
    entityId: uuid('entity_id').notNull(),
    name: text('name').notNull(),
    functionalCurrency: text('functional_currency').notNull(),
    fiscalYearStartMonth: integer('fiscal_year_start_month')
      .default(1)
      .notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => authUsers.id),
    revision: integer('revision').default(0).notNull(),
  },
  (t) => [
    unique('finance_books_scope').on(t.workspaceId, t.id),
    foreignKey({
      name: 'finance_books_entity',
      columns: [t.workspaceId, t.entityId],
      foreignColumns: [financeEntities.workspaceId, financeEntities.id],
    }),
    check(
      'finance_books_currency',
      sql`${t.functionalCurrency} in ('CAD','USD','MXN','EUR','KRW','JPY')`,
    ),
    check(
      'finance_books_fiscal_month',
      sql`${t.fiscalYearStartMonth} between 1 and 12`,
    ),
  ],
);

export const financeBookGrants = schema.table(
  'finance_book_grants',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull(),
    revision: integer('revision').default(1).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.bookId, t.userId] }),
    foreignKey({
      name: 'finance_book_grants_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    foreignKey({
      name: 'finance_book_grants_member',
      columns: [t.workspaceId, t.userId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    }),
    index('finance_book_grants_user').on(t.userId, t.workspaceId),
    check(
      'finance_book_grants_role',
      sql`${t.role} in ('administrator','preparer','approver','viewer')`,
    ),
  ],
);

export const financeLedgerAccounts = schema.table(
  'finance_ledger_accounts',
  {
    ...booked(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    active: boolean('active').default(true).notNull(),
  },
  (t) => [
    unique('finance_ledger_accounts_scope').on(t.workspaceId, t.bookId, t.id),
    unique('finance_ledger_accounts_code').on(t.workspaceId, t.bookId, t.code),
    foreignKey({
      name: 'finance_ledger_accounts_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    check(
      'finance_ledger_accounts_kind',
      sql`${t.kind} in ('asset','liability','equity','income','expense')`,
    ),
  ],
);

export const financePeriods = schema.table(
  'finance_periods',
  {
    ...booked(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    status: text('status').default('open').notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => authUsers.id),
  },
  (t) => [
    unique('finance_periods_scope').on(t.workspaceId, t.bookId, t.id),
    foreignKey({
      name: 'finance_periods_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    check('finance_periods_dates', sql`${t.startsOn} <= ${t.endsOn}`),
    check(
      'finance_periods_state',
      sql`(${t.status} = 'open' and ${t.closedAt} is null and ${t.closedBy} is null) or (${t.status} = 'closed' and ${t.closedAt} is not null and ${t.closedBy} is not null)`,
    ),
  ],
);

export const financeJournals = schema.table(
  'finance_journals',
  {
    ...booked(),
    effectiveOn: date('effective_on').notNull(),
    description: text('description').notNull(),
    sourceReference: text('source_reference').notNull(),
    periodId: uuid('period_id').notNull(),
    status: text('status').default('draft').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => authUsers.id),
    reversalOf: uuid('reversal_of'),
  },
  (t) => [
    unique('finance_journals_scope').on(t.workspaceId, t.bookId, t.id),
    unique('finance_journals_idempotency').on(
      t.workspaceId,
      t.bookId,
      t.idempotencyKey,
    ),
    unique('finance_journals_reversal').on(
      t.workspaceId,
      t.bookId,
      t.reversalOf,
    ),
    foreignKey({
      name: 'finance_journals_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    foreignKey({
      name: 'finance_journals_period',
      columns: [t.workspaceId, t.bookId, t.periodId],
      foreignColumns: [
        financePeriods.workspaceId,
        financePeriods.bookId,
        financePeriods.id,
      ],
    }),
    index('finance_journals_date').on(
      t.workspaceId,
      t.bookId,
      t.effectiveOn,
      t.id,
    ),
    check(
      'finance_journals_state',
      sql`(${t.status} = 'draft' and ${t.postedAt} is null) or (${t.status} = 'posted' and ${t.postedAt} is not null)`,
    ),
    check('finance_journals_hash', sql`${t.payloadHash} ~ '^[a-f0-9]{64}$'`),
  ],
);

export const financeJournalLines = schema.table(
  'finance_journal_lines',
  {
    ...booked(),
    journalId: uuid('journal_id').notNull(),
    accountId: uuid('account_id').notNull(),
    lineNumber: integer('line_number').notNull(),
    side: text('side').notNull(),
    amount: decimal('amount').notNull(),
    currency: text('currency').notNull(),
    nativeAmount: decimal('native_amount').notNull(),
    fxRate: decimal('fx_rate').notNull(),
    fxSource: text('fx_source').notNull(),
    description: text('description').default('').notNull(),
  },
  (t) => [
    unique('finance_journal_lines_number').on(
      t.workspaceId,
      t.bookId,
      t.journalId,
      t.lineNumber,
    ),
    foreignKey({
      name: 'finance_journal_lines_journal',
      columns: [t.workspaceId, t.bookId, t.journalId],
      foreignColumns: [
        financeJournals.workspaceId,
        financeJournals.bookId,
        financeJournals.id,
      ],
    }),
    foreignKey({
      name: 'finance_journal_lines_account',
      columns: [t.workspaceId, t.bookId, t.accountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    }),
    index('finance_journal_lines_account_idx').on(
      t.workspaceId,
      t.bookId,
      t.accountId,
    ),
    check(
      'finance_journal_lines_amounts',
      sql`${t.amount} > 0 and ${t.nativeAmount} > 0 and ${t.fxRate} > 0 and ${t.amount} <> 'NaN'::numeric and ${t.nativeAmount} <> 'NaN'::numeric and ${t.fxRate} <> 'NaN'::numeric`,
    ),
    check('finance_journal_lines_side', sql`${t.side} in ('debit','credit')`),
    check(
      'finance_journal_lines_currency',
      sql`${t.currency} in ('CAD','USD','MXN','EUR','KRW','JPY')`,
    ),
  ],
);

export const financeCommandReceipts = schema.table(
  'finance_command_receipts',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id),
    idempotencyKey: text('idempotency_key').notNull(),
    operation: text('operation').notNull(),
    payloadHash: text('payload_hash').notNull(),
    result: jsonb('result').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId, t.idempotencyKey] })],
);

export const financeV2Audit = schema.table(
  'finance_v2_audit',
  {
    ...owned(),
    bookId: uuid('book_id'),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => authUsers.id),
    requestId: uuid('request_id').notNull(),
    operation: text('operation').notNull(),
    recordId: uuid('record_id').notNull(),
    details: jsonb('details').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'finance_v2_audit_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    index('finance_v2_audit_book_idx').on(t.workspaceId, t.bookId, t.createdAt),
  ],
);

export const financeParties = schema.table(
  'finance_parties',
  {
    ...booked(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    reference: text('reference').notNull(),
  },
  (t) => [
    unique('finance_parties_scope').on(t.workspaceId, t.bookId, t.id),
    unique('finance_parties_reference').on(
      t.workspaceId,
      t.bookId,
      t.reference,
    ),
    foreignKey({
      name: 'finance_parties_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    check('finance_parties_kind', sql`${t.kind} in ('person','organization')`),
  ],
);
export const financeCommercialDocuments = schema.table(
  'finance_commercial_documents',
  {
    ...booked(),
    kind: text('kind').notNull(),
    partyId: uuid('party_id').notNull(),
    reference: text('reference').notNull(),
    issuedOn: date('issued_on').notNull(),
    dueOn: date('due_on').notNull(),
    controlAccountId: uuid('control_account_id').notNull(),
    sourceReference: text('source_reference').notNull(),
    status: text('status').default('draft').notNull(),
    journalId: uuid('journal_id'),
    voidJournalId: uuid('void_journal_id'),
    total: decimal('total').notNull().default('0'),
  },
  (t) => [
    unique('finance_commercial_documents_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    unique('finance_commercial_documents_reference').on(
      t.workspaceId,
      t.bookId,
      t.kind,
      t.partyId,
      t.reference,
    ),
    unique('finance_commercial_documents_journal').on(
      t.workspaceId,
      t.bookId,
      t.journalId,
    ),
    foreignKey({
      name: 'finance_commercial_documents_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    foreignKey({
      name: 'finance_commercial_documents_party',
      columns: [t.workspaceId, t.bookId, t.partyId],
      foreignColumns: [
        financeParties.workspaceId,
        financeParties.bookId,
        financeParties.id,
      ],
    }),
    foreignKey({
      name: 'finance_commercial_documents_control',
      columns: [t.workspaceId, t.bookId, t.controlAccountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_commercial_documents_journal_fk',
      columns: [t.workspaceId, t.bookId, t.journalId],
      foreignColumns: [
        financeJournals.workspaceId,
        financeJournals.bookId,
        financeJournals.id,
      ],
    }),
    foreignKey({
      name: 'finance_commercial_documents_void_fk',
      columns: [t.workspaceId, t.bookId, t.voidJournalId],
      foreignColumns: [
        financeJournals.workspaceId,
        financeJournals.bookId,
        financeJournals.id,
      ],
    }),
    check(
      'finance_commercial_documents_kind',
      sql`${t.kind} in ('sales-invoice','supplier-bill')`,
    ),
    check(
      'finance_commercial_documents_status',
      sql`${t.status} in ('draft','issued','void')`,
    ),
    check(
      'finance_commercial_documents_dates',
      sql`${t.dueOn} >= ${t.issuedOn}`,
    ),
    check(
      'finance_commercial_documents_total',
      sql`${t.total} >= 0 and ${t.total} <> 'NaN'::numeric`,
    ),
  ],
);
export const financeCommercialLines = schema.table(
  'finance_commercial_lines',
  {
    ...booked(),
    documentId: uuid('document_id').notNull(),
    lineNumber: integer('line_number').notNull(),
    description: text('description').notNull(),
    accountId: uuid('account_id').notNull(),
    netAmount: decimal('net_amount').notNull(),
    taxAmount: decimal('tax_amount').notNull().default('0'),
    taxAccountId: uuid('tax_account_id'),
  },
  (t) => [
    unique('finance_commercial_lines_number').on(
      t.workspaceId,
      t.bookId,
      t.documentId,
      t.lineNumber,
    ),
    foreignKey({
      name: 'finance_commercial_lines_document',
      columns: [t.workspaceId, t.bookId, t.documentId],
      foreignColumns: [
        financeCommercialDocuments.workspaceId,
        financeCommercialDocuments.bookId,
        financeCommercialDocuments.id,
      ],
    }),
    foreignKey({
      name: 'finance_commercial_lines_account',
      columns: [t.workspaceId, t.bookId, t.accountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_commercial_lines_tax',
      columns: [t.workspaceId, t.bookId, t.taxAccountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    }),
    check(
      'finance_commercial_lines_amounts',
      sql`${t.lineNumber}>0 and ${t.netAmount}>0 and ${t.taxAmount}>=0 and ${t.netAmount}<>'NaN'::numeric and ${t.taxAmount}<>'NaN'::numeric and ((${t.taxAmount}=0 and ${t.taxAccountId} is null) or (${t.taxAmount}>0 and ${t.taxAccountId} is not null))`,
    ),
  ],
);
export const financePayments = schema.table(
  'finance_payments',
  {
    ...booked(),
    direction: text('direction').notNull(),
    partyId: uuid('party_id').notNull(),
    cashAccountId: uuid('cash_account_id').notNull(),
    effectiveOn: date('effective_on').notNull(),
    reference: text('reference').notNull(),
    sourceReference: text('source_reference').notNull(),
    status: text('status').default('draft').notNull(),
    journalId: uuid('journal_id'),
    voidJournalId: uuid('void_journal_id'),
    total: decimal('total').notNull().default('0'),
  },
  (t) => [
    unique('finance_payments_scope').on(t.workspaceId, t.bookId, t.id),
    unique('finance_payments_reference').on(
      t.workspaceId,
      t.bookId,
      t.direction,
      t.reference,
    ),
    unique('finance_payments_journal').on(t.workspaceId, t.bookId, t.journalId),
    foreignKey({
      name: 'finance_payments_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    foreignKey({
      name: 'finance_payments_party',
      columns: [t.workspaceId, t.bookId, t.partyId],
      foreignColumns: [
        financeParties.workspaceId,
        financeParties.bookId,
        financeParties.id,
      ],
    }),
    foreignKey({
      name: 'finance_payments_cash',
      columns: [t.workspaceId, t.bookId, t.cashAccountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_payments_journal_fk',
      columns: [t.workspaceId, t.bookId, t.journalId],
      foreignColumns: [
        financeJournals.workspaceId,
        financeJournals.bookId,
        financeJournals.id,
      ],
    }),
    foreignKey({
      name: 'finance_payments_void_fk',
      columns: [t.workspaceId, t.bookId, t.voidJournalId],
      foreignColumns: [
        financeJournals.workspaceId,
        financeJournals.bookId,
        financeJournals.id,
      ],
    }),
    check(
      'finance_payments_direction',
      sql`${t.direction} in ('receipt','disbursement')`,
    ),
    check(
      'finance_payments_status',
      sql`${t.status} in ('draft','posted','void')`,
    ),
    check(
      'finance_payments_total',
      sql`${t.total}>=0 and ${t.total}<>'NaN'::numeric`,
    ),
  ],
);
export const financePaymentAllocations = schema.table(
  'finance_payment_allocations',
  {
    ...booked(),
    paymentId: uuid('payment_id').notNull(),
    documentId: uuid('document_id').notNull(),
    amount: decimal('amount').notNull(),
  },
  (t) => [
    unique('finance_payment_allocations_document').on(
      t.workspaceId,
      t.bookId,
      t.paymentId,
      t.documentId,
    ),
    foreignKey({
      name: 'finance_payment_allocations_payment',
      columns: [t.workspaceId, t.bookId, t.paymentId],
      foreignColumns: [
        financePayments.workspaceId,
        financePayments.bookId,
        financePayments.id,
      ],
    }),
    foreignKey({
      name: 'finance_payment_allocations_document_fk',
      columns: [t.workspaceId, t.bookId, t.documentId],
      foreignColumns: [
        financeCommercialDocuments.workspaceId,
        financeCommercialDocuments.bookId,
        financeCommercialDocuments.id,
      ],
    }),
    check(
      'finance_payment_allocations_amount',
      sql`${t.amount}>0 and ${t.amount}<>'NaN'::numeric`,
    ),
    index('finance_payment_allocations_lookup').on(
      t.workspaceId,
      t.bookId,
      t.documentId,
    ),
  ],
);

export const financeFinancialAccounts = schema.table(
  'finance_financial_accounts',
  {
    ...booked(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    currency: text('currency').notNull(),
    ledgerAccountId: uuid('ledger_account_id').notNull(),
    active: boolean('active').default(true).notNull(),
  },
  (t) => [
    unique('finance_financial_accounts_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    unique('finance_financial_accounts_ledger').on(
      t.workspaceId,
      t.bookId,
      t.ledgerAccountId,
    ),
    foreignKey({
      name: 'finance_financial_accounts_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    foreignKey({
      name: 'finance_financial_accounts_ledger_fk',
      columns: [t.workspaceId, t.bookId, t.ledgerAccountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    }),
    check(
      'finance_financial_accounts_kind',
      sql`${t.kind} in ('bank','brokerage','credit-card','cash')`,
    ),
    check(
      'finance_financial_accounts_currency',
      sql`${t.currency} in ('CAD','USD','MXN','EUR','JPY','KRW')`,
    ),
  ],
);
export const financeBookEvidence = schema.table(
  'finance_book_evidence',
  {
    ...booked(),
    filename: text('filename').notNull(),
    format: text('format').notNull(),
    plaintextSha256: text('plaintext_sha256').notNull(),
    byteSize: integer('byte_size').notNull(),
    encryptedOriginal: jsonb('encrypted_original').notNull(),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => authUsers.id),
  },
  (t) => [
    unique('finance_book_evidence_scope').on(t.workspaceId, t.bookId, t.id),
    foreignKey({
      name: 'finance_book_evidence_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    check(
      'finance_book_evidence_hash',
      sql`${t.plaintextSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'finance_book_evidence_size',
      sql`${t.byteSize}>0 and ${t.byteSize}<=2097152`,
    ),
  ],
);
export const financeNormalizedImports = schema.table(
  'finance_normalized_imports',
  {
    ...booked(),
    financialAccountId: uuid('financial_account_id').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    mapping: jsonb('mapping').notNull(),
    parserVersion: text('parser_version').notNull(),
    status: text('status').default('review').notNull(),
    revision: integer('revision').default(1).notNull(),
  },
  (t) => [
    unique('finance_normalized_imports_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    foreignKey({
      name: 'finance_normalized_imports_account',
      columns: [t.workspaceId, t.bookId, t.financialAccountId],
      foreignColumns: [
        financeFinancialAccounts.workspaceId,
        financeFinancialAccounts.bookId,
        financeFinancialAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_normalized_imports_evidence',
      columns: [t.workspaceId, t.bookId, t.evidenceId],
      foreignColumns: [
        financeBookEvidence.workspaceId,
        financeBookEvidence.bookId,
        financeBookEvidence.id,
      ],
    }),
    check(
      'finance_normalized_imports_status',
      sql`${t.status} in ('review','committed')`,
    ),
    check('finance_normalized_imports_revision', sql`${t.revision}>0`),
  ],
);
export const financeNormalizedImportRows = schema.table(
  'finance_normalized_import_rows',
  {
    ...booked(),
    batchId: uuid('batch_id').notNull(),
    sourceRow: integer('source_row').notNull(),
    sourceFacts: jsonb('source_facts').notNull(),
    effectiveOn: date('effective_on'),
    description: text('description').notNull(),
    nativeAmount: decimal('native_amount'),
    externalId: text('external_id'),
    issues: jsonb('issues').notNull(),
    status: text('status').default('review').notNull(),
    revision: integer('revision').default(1).notNull(),
    counterAccountId: uuid('counter_account_id'),
    matchJournalId: uuid('match_journal_id'),
    fxRate: decimal('fx_rate'),
    fxSource: text('fx_source'),
    economicTransactionId: uuid('economic_transaction_id'),
  },
  (t) => [
    unique('finance_normalized_import_rows_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    unique('finance_normalized_import_rows_source').on(
      t.workspaceId,
      t.bookId,
      t.batchId,
      t.sourceRow,
    ),
    foreignKey({
      name: 'finance_normalized_import_rows_batch',
      columns: [t.workspaceId, t.bookId, t.batchId],
      foreignColumns: [
        financeNormalizedImports.workspaceId,
        financeNormalizedImports.bookId,
        financeNormalizedImports.id,
      ],
    }),
    foreignKey({
      name: 'finance_normalized_import_rows_counter',
      columns: [t.workspaceId, t.bookId, t.counterAccountId],
      foreignColumns: [
        financeLedgerAccounts.workspaceId,
        financeLedgerAccounts.bookId,
        financeLedgerAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_normalized_import_rows_journal',
      columns: [t.workspaceId, t.bookId, t.matchJournalId],
      foreignColumns: [
        financeJournals.workspaceId,
        financeJournals.bookId,
        financeJournals.id,
      ],
    }),
    foreignKey({
      name: 'finance_normalized_import_rows_transaction',
      columns: [t.workspaceId, t.bookId, t.economicTransactionId],
      foreignColumns: [
        financeEconomicTransactions.workspaceId,
        financeEconomicTransactions.bookId,
        financeEconomicTransactions.id,
      ],
    }),
    check(
      'finance_normalized_import_rows_status',
      sql`${t.status} in ('invalid','review','ready','ignored','committed','matched')`,
    ),
    check(
      'finance_normalized_import_rows_revision',
      sql`${t.revision}>0 and ${t.sourceRow}>0`,
    ),
  ],
);
export const financeImportRowReviews = schema.table(
  'finance_import_row_reviews',
  {
    ...booked(),
    rowId: uuid('row_id').notNull(),
    revision: integer('revision').notNull(),
    decision: jsonb('decision').notNull(),
    previousFacts: jsonb('previous_facts').notNull(),
    reviewedBy: uuid('reviewed_by')
      .notNull()
      .references(() => authUsers.id),
  },
  (t) => [
    unique('finance_import_row_reviews_revision').on(
      t.workspaceId,
      t.bookId,
      t.rowId,
      t.revision,
    ),
    foreignKey({
      name: 'finance_import_row_reviews_row',
      columns: [t.workspaceId, t.bookId, t.rowId],
      foreignColumns: [
        financeNormalizedImportRows.workspaceId,
        financeNormalizedImportRows.bookId,
        financeNormalizedImportRows.id,
      ],
    }),
    check('finance_import_row_reviews_version', sql`${t.revision}>1`),
  ],
);
export const financeEconomicTransactions = schema.table(
  'finance_economic_transactions',
  {
    ...booked(),
    financialAccountId: uuid('financial_account_id').notNull(),
    effectiveOn: date('effective_on').notNull(),
    description: text('description').notNull(),
    nativeAmount: decimal('native_amount').notNull(),
    functionalAmount: decimal('functional_amount').notNull(),
    fxRate: decimal('fx_rate').notNull(),
    fxSource: text('fx_source').notNull(),
    journalId: uuid('journal_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    factsHash: text('facts_hash').notNull(),
    externalId: text('external_id'),
  },
  (t) => [
    unique('finance_economic_transactions_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    unique('finance_economic_transactions_identity').on(
      t.workspaceId,
      t.bookId,
      t.financialAccountId,
      t.fingerprint,
    ),
    foreignKey({
      name: 'finance_economic_transactions_account',
      columns: [t.workspaceId, t.bookId, t.financialAccountId],
      foreignColumns: [
        financeFinancialAccounts.workspaceId,
        financeFinancialAccounts.bookId,
        financeFinancialAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_economic_transactions_journal',
      columns: [t.workspaceId, t.bookId, t.journalId],
      foreignColumns: [
        financeJournals.workspaceId,
        financeJournals.bookId,
        financeJournals.id,
      ],
    }),
    check(
      'finance_economic_transactions_amounts',
      sql`${t.nativeAmount}<>0 and ${t.functionalAmount}<>0 and ${t.fxRate}>0 and ${t.nativeAmount}<>'NaN'::numeric and ${t.functionalAmount}<>'NaN'::numeric and ${t.fxRate}<>'NaN'::numeric`,
    ),
    check(
      'finance_economic_transactions_hashes',
      sql`${t.fingerprint} ~ '^[0-9a-f]{64}$' and ${t.factsHash} ~ '^[0-9a-f]{64}$'`,
    ),
    index('finance_economic_transactions_match').on(
      t.workspaceId,
      t.bookId,
      t.financialAccountId,
      t.effectiveOn,
    ),
  ],
);

export const financeInstruments = schema.table(
  'finance_instruments',
  {
    ...booked(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    quantityUnit: text('quantity_unit').notNull(),
    valuationMultiplier: decimal('valuation_multiplier').notNull(),
  },
  (t) => [
    unique('finance_instruments_scope').on(t.workspaceId, t.bookId, t.id),
    foreignKey({
      name: 'finance_instruments_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    check(
      'finance_instruments_valid',
      sql`kind in ('equity','fund','bond','option','future','other') and quantity_unit in ('share','unit','face-value','contract') and valuation_multiplier>0 and valuation_multiplier<>'NaN'::numeric`,
    ),
    index('finance_instruments_book_lookup').on(t.workspaceId, t.bookId),
  ],
);

export const financeInstrumentIdentifiers = schema.table(
  'finance_instrument_identifiers',
  {
    ...booked(),
    instrumentId: uuid('instrument_id').notNull(),
    scheme: text('scheme').notNull(),
    value: text('value').notNull(),
    namespace: text('namespace').notNull(),
  },
  (t) => [
    unique('finance_instrument_identifiers_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    foreignKey({
      name: 'finance_instrument_identifiers_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    foreignKey({
      name: 'finance_instrument_identifiers_instrumentId',
      columns: [t.workspaceId, t.bookId, t.instrumentId],
      foreignColumns: [
        financeInstruments.workspaceId,
        financeInstruments.bookId,
        financeInstruments.id,
      ],
    }),
    check(
      'finance_instrument_identifiers_valid',
      sql`scheme in ('ISIN','CUSIP','SEDOL','ticker','provider')`,
    ),
    index('finance_instrument_identifiers_book_lookup').on(
      t.workspaceId,
      t.bookId,
    ),
  ],
);

export const financeInvestmentOpenings = schema.table(
  'finance_investment_openings',
  {
    ...booked(),
    financialAccountId: uuid('financial_account_id').notNull(),
    instrumentId: uuid('instrument_id').notNull(),
    asOf: date('as_of').notNull(),
    quantity: decimal('quantity').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    sourceReference: text('source_reference').notNull(),
  },
  (t) => [
    unique('finance_investment_openings_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    foreignKey({
      name: 'finance_investment_openings_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    foreignKey({
      name: 'finance_investment_openings_financialAccountId',
      columns: [t.workspaceId, t.bookId, t.financialAccountId],
      foreignColumns: [
        financeFinancialAccounts.workspaceId,
        financeFinancialAccounts.bookId,
        financeFinancialAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_openings_instrumentId',
      columns: [t.workspaceId, t.bookId, t.instrumentId],
      foreignColumns: [
        financeInstruments.workspaceId,
        financeInstruments.bookId,
        financeInstruments.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_openings_evidenceId',
      columns: [t.workspaceId, t.bookId, t.evidenceId],
      foreignColumns: [
        financeBookEvidence.workspaceId,
        financeBookEvidence.bookId,
        financeBookEvidence.id,
      ],
    }),
    check('finance_investment_openings_valid', sql`quantity<>'NaN'::numeric`),
    index('finance_investment_openings_book_lookup').on(
      t.workspaceId,
      t.bookId,
    ),
  ],
);

export const financeInvestmentMovements = schema.table(
  'finance_investment_movements',
  {
    ...booked(),
    financialAccountId: uuid('financial_account_id').notNull(),
    instrumentId: uuid('instrument_id').notNull(),
    effectiveOn: date('effective_on').notNull(),
    quantity: decimal('quantity').notNull(),
    journalId: uuid('journal_id').notNull(),
    sourceReference: text('source_reference').notNull(),
  },
  (t) => [
    unique('finance_investment_movements_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    foreignKey({
      name: 'finance_investment_movements_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    foreignKey({
      name: 'finance_investment_movements_financialAccountId',
      columns: [t.workspaceId, t.bookId, t.financialAccountId],
      foreignColumns: [
        financeFinancialAccounts.workspaceId,
        financeFinancialAccounts.bookId,
        financeFinancialAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_movements_instrumentId',
      columns: [t.workspaceId, t.bookId, t.instrumentId],
      foreignColumns: [
        financeInstruments.workspaceId,
        financeInstruments.bookId,
        financeInstruments.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_movements_journalId',
      columns: [t.workspaceId, t.bookId, t.journalId],
      foreignColumns: [
        financeJournals.workspaceId,
        financeJournals.bookId,
        financeJournals.id,
      ],
    }),
    check(
      'finance_investment_movements_valid',
      sql`quantity<>0 and quantity<>'NaN'::numeric`,
    ),
    index('finance_investment_movements_book_lookup').on(
      t.workspaceId,
      t.bookId,
    ),
  ],
);

export const financeObservedPositions = schema.table(
  'finance_observed_positions',
  {
    ...booked(),
    financialAccountId: uuid('financial_account_id').notNull(),
    instrumentId: uuid('instrument_id').notNull(),
    asOf: date('as_of').notNull(),
    quantity: decimal('quantity').notNull(),
    reportedMarketValue: decimal('reported_market_value'),
    reportedBookCost: decimal('reported_book_cost'),
    reportedPrice: decimal('reported_price'),
    reportedAccruedInterest: decimal('reported_accrued_interest'),
    mappingId: uuid('mapping_id'),
    sourceFacts: jsonb('source_facts'),
    currency: text('currency'),
    evidenceId: uuid('evidence_id').notNull(),
    sourceRow: integer('source_row').notNull(),
  },
  (t) => [
    unique('finance_observed_positions_mapped_source').on(
      t.workspaceId,
      t.bookId,
      t.financialAccountId,
      t.evidenceId,
      t.mappingId,
      t.sourceRow,
    ),
    foreignKey({
      name: 'finance_observed_positions_mapping',
      columns: [t.workspaceId, t.bookId, t.mappingId],
      foreignColumns: [
        financeReportMappingVersions.workspaceId,
        financeReportMappingVersions.bookId,
        financeReportMappingVersions.id,
      ],
    }),
    check(
      'finance_observed_positions_source_facts',
      sql`(mapping_id is null and source_facts is null) or (mapping_id is not null and source_facts is not null and jsonb_typeof(source_facts)='object')`,
    ),
    check(
      'finance_observed_positions_reported_amounts',
      sql`(reported_book_cost is null or (reported_book_cost<>'NaN'::numeric and currency is not null)) and (reported_price is null or (reported_price<>'NaN'::numeric and currency is not null)) and (reported_accrued_interest is null or (reported_accrued_interest<>'NaN'::numeric and currency is not null))`,
    ),
    unique('finance_observed_positions_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    foreignKey({
      name: 'finance_observed_positions_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    foreignKey({
      name: 'finance_observed_positions_financialAccountId',
      columns: [t.workspaceId, t.bookId, t.financialAccountId],
      foreignColumns: [
        financeFinancialAccounts.workspaceId,
        financeFinancialAccounts.bookId,
        financeFinancialAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_observed_positions_instrumentId',
      columns: [t.workspaceId, t.bookId, t.instrumentId],
      foreignColumns: [
        financeInstruments.workspaceId,
        financeInstruments.bookId,
        financeInstruments.id,
      ],
    }),
    foreignKey({
      name: 'finance_observed_positions_evidenceId',
      columns: [t.workspaceId, t.bookId, t.evidenceId],
      foreignColumns: [
        financeBookEvidence.workspaceId,
        financeBookEvidence.bookId,
        financeBookEvidence.id,
      ],
    }),
    check(
      'finance_observed_positions_valid',
      sql`quantity<>'NaN'::numeric and source_row>0 and (reported_market_value is null or (reported_market_value<>'NaN'::numeric and currency is not null)) and (currency is null or currency in ('CAD','USD','MXN','EUR','JPY','KRW'))`,
    ),
    index('finance_observed_positions_book_lookup').on(t.workspaceId, t.bookId),
  ],
);

export const financeInvestmentPrices = schema.table(
  'finance_investment_prices',
  {
    ...booked(),
    instrumentId: uuid('instrument_id').notNull(),
    asOf: date('as_of').notNull(),
    price: decimal('price').notNull(),
    currency: text('currency').notNull(),
    sourceReference: text('source_reference').notNull(),
  },
  (t) => [
    unique('finance_investment_prices_scope').on(t.workspaceId, t.bookId, t.id),
    foreignKey({
      name: 'finance_investment_prices_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    foreignKey({
      name: 'finance_investment_prices_instrumentId',
      columns: [t.workspaceId, t.bookId, t.instrumentId],
      foreignColumns: [
        financeInstruments.workspaceId,
        financeInstruments.bookId,
        financeInstruments.id,
      ],
    }),
    check(
      'finance_investment_prices_valid',
      sql`price>=0 and price<>'NaN'::numeric and currency in ('CAD','USD','MXN','EUR','JPY','KRW')`,
    ),
    index('finance_investment_prices_book_lookup').on(t.workspaceId, t.bookId),
  ],
);

export const financeFxObservations = schema.table(
  'finance_fx_observations',
  {
    ...booked(),
    asOf: date('as_of').notNull(),
    fromCurrency: text('from_currency').notNull(),
    toCurrency: text('to_currency').notNull(),
    rate: decimal('rate').notNull(),
    sourceReference: text('source_reference').notNull(),
  },
  (t) => [
    unique('finance_fx_observations_scope').on(t.workspaceId, t.bookId, t.id),
    foreignKey({
      name: 'finance_fx_observations_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    check(
      'finance_fx_observations_valid',
      sql`rate>0 and rate<>'NaN'::numeric and from_currency<>to_currency and from_currency in ('CAD','USD','MXN','EUR','JPY','KRW') and to_currency in ('CAD','USD','MXN','EUR','JPY','KRW')`,
    ),
    index('finance_fx_observations_book_lookup').on(t.workspaceId, t.bookId),
  ],
);

export const financeReportMappingVersions = schema.table(
  'finance_report_mapping_versions',
  {
    ...booked(),
    providerKey: text('provider_key').notNull(),
    reportName: text('report_name').notNull(),
    reportType: text('report_type').notNull(),
    layoutVersion: text('layout_version').notNull(),
    version: integer('version').notNull(),
    revision: integer('revision').default(1).notNull(),
    status: text('status').default('candidate').notNull(),
    definition: jsonb('definition').notNull(),
    rationale: text('rationale').notNull(),
    unresolvedQuestions: jsonb('unresolved_questions').notNull(),
    example: jsonb('example').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    validation: jsonb('validation').notNull(),
    proposedByModel: text('proposed_by_model'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => authUsers.id),
  },
  (t) => [
    unique('finance_report_mapping_versions_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    unique('finance_report_mapping_versions_identity').on(
      t.workspaceId,
      t.bookId,
      t.providerKey,
      t.reportName,
      t.reportType,
      t.version,
    ),
    foreignKey({
      name: 'finance_report_mapping_versions_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    foreignKey({
      name: 'finance_report_mapping_versions_evidence',
      columns: [t.workspaceId, t.bookId, t.evidenceId],
      foreignColumns: [
        financeBookEvidence.workspaceId,
        financeBookEvidence.bookId,
        financeBookEvidence.id,
      ],
    }),
    check(
      'finance_report_mapping_versions_state',
      sql`version>0 and revision>0 and status in ('candidate','approved','retired') and report_type in ('bank-transactions','investment-positions') and (proposed_by_model is null or proposed_by_model='gpt-6-astra')`,
    ),
    index('finance_report_mapping_versions_lookup').on(
      t.workspaceId,
      t.bookId,
      t.providerKey,
      t.reportType,
      t.status,
    ),
  ],
);
export const financeReportMappingReviews = schema.table(
  'finance_report_mapping_reviews',
  {
    ...booked(),
    mappingId: uuid('mapping_id').notNull(),
    revision: integer('revision').notNull(),
    decision: text('decision').notNull(),
    reason: text('reason').notNull(),
    reviewedBy: uuid('reviewed_by')
      .notNull()
      .references(() => authUsers.id),
  },
  (t) => [
    unique('finance_report_mapping_reviews_revision').on(
      t.workspaceId,
      t.bookId,
      t.mappingId,
      t.revision,
    ),
    foreignKey({
      name: 'finance_report_mapping_reviews_mapping',
      columns: [t.workspaceId, t.bookId, t.mappingId],
      foreignColumns: [
        financeReportMappingVersions.workspaceId,
        financeReportMappingVersions.bookId,
        financeReportMappingVersions.id,
      ],
    }),
    check(
      'finance_report_mapping_reviews_valid',
      sql`revision>1 and decision in ('approve','retire') and length(trim(reason))>=3`,
    ),
  ],
);

export const financeValuationRuns = schema.table(
  'finance_valuation_runs',
  {
    ...booked(),
    asOf: date('as_of').notNull(),
    calculationVersion: text('calculation_version').notNull(),
    inputSnapshot: jsonb('input_snapshot').notNull(),
    result: jsonb('result').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => authUsers.id),
  },
  (t) => [
    foreignKey({
      name: 'finance_valuation_runs_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    index('finance_valuation_runs_lookup').on(
      t.workspaceId,
      t.bookId,
      t.createdAt,
      t.id,
    ),
    check(
      'finance_valuation_runs_shape',
      sql`jsonb_typeof(input_snapshot)='object' and jsonb_typeof(result)='object' and length(calculation_version)>0`,
    ),
  ],
);

export const financeInvestmentLots = schema.table(
  'finance_investment_lots',
  {
    ...booked(),
    movementId: uuid('movement_id').notNull(),
    acquisitionSequence: integer('acquisition_sequence').notNull(),
    nativeCurrency: text('native_currency').notNull(),
    nativeCost: decimal('native_cost').notNull(),
    functionalCost: decimal('functional_cost').notNull(),
    sourceReference: text('source_reference').notNull(),
  },
  (t) => [
    unique('finance_investment_lots_scope').on(t.workspaceId, t.bookId, t.id),
    unique('finance_investment_lots_movement').on(
      t.workspaceId,
      t.bookId,
      t.movementId,
    ),
    foreignKey({
      name: 'finance_investment_lots_movement_fk',
      columns: [t.workspaceId, t.bookId, t.movementId],
      foreignColumns: [
        financeInvestmentMovements.workspaceId,
        financeInvestmentMovements.bookId,
        financeInvestmentMovements.id,
      ],
    }),
    check(
      'finance_investment_lots_valid',
      sql`native_cost>=0 and native_cost<>'NaN'::numeric and functional_cost>=0 and functional_cost<>'NaN'::numeric and acquisition_sequence>=0 and native_currency in ('CAD','USD','MXN','EUR','JPY','KRW') and length(trim(source_reference))>0`,
    ),
  ],
);
export const financeLotDisposals = schema.table(
  'finance_lot_disposals',
  {
    ...booked(),
    movementId: uuid('movement_id').notNull(),
    method: text('method').notNull(),
    nativeCurrency: text('native_currency').notNull(),
    inputSnapshot: jsonb('input_snapshot').notNull(),
    result: jsonb('result').notNull(),
  },
  (t) => [
    unique('finance_lot_disposals_scope').on(t.workspaceId, t.bookId, t.id),
    unique('finance_lot_disposals_movement').on(
      t.workspaceId,
      t.bookId,
      t.movementId,
    ),
    foreignKey({
      name: 'finance_lot_disposals_movement_fk',
      columns: [t.workspaceId, t.bookId, t.movementId],
      foreignColumns: [
        financeInvestmentMovements.workspaceId,
        financeInvestmentMovements.bookId,
        financeInvestmentMovements.id,
      ],
    }),
    check(
      'finance_lot_disposals_valid',
      sql`method in ('fifo','specific') and native_currency in ('CAD','USD','MXN','EUR','JPY','KRW') and jsonb_typeof(input_snapshot)='object' and jsonb_typeof(result)='object'`,
    ),
  ],
);
export const financeLotAllocations = schema.table(
  'finance_lot_allocations',
  {
    ...booked(),
    lotId: uuid('lot_id').notNull(),
    disposalId: uuid('disposal_id').notNull(),
    quantity: decimal('quantity').notNull(),
    nativeCost: decimal('native_cost').notNull(),
    functionalCost: decimal('functional_cost').notNull(),
  },
  (t) => [
    unique('finance_lot_allocations_identity').on(
      t.workspaceId,
      t.bookId,
      t.disposalId,
      t.lotId,
    ),
    foreignKey({
      name: 'finance_lot_allocations_lot',
      columns: [t.workspaceId, t.bookId, t.lotId],
      foreignColumns: [
        financeInvestmentLots.workspaceId,
        financeInvestmentLots.bookId,
        financeInvestmentLots.id,
      ],
    }),
    foreignKey({
      name: 'finance_lot_allocations_disposal',
      columns: [t.workspaceId, t.bookId, t.disposalId],
      foreignColumns: [
        financeLotDisposals.workspaceId,
        financeLotDisposals.bookId,
        financeLotDisposals.id,
      ],
    }),
    check(
      'finance_lot_allocations_valid',
      sql`quantity>0 and quantity<>'NaN'::numeric and native_cost>=0 and native_cost<>'NaN'::numeric and functional_cost>=0 and functional_cost<>'NaN'::numeric`,
    ),
    index('finance_lot_allocations_lot_lookup').on(
      t.workspaceId,
      t.bookId,
      t.lotId,
    ),
  ],
);

/** Monotonic source-state CAS boundary for investment lot mutations. */
export const financeInvestmentLotRevisions = schema.table(
  'finance_investment_lot_revisions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    revision: integer('revision').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.bookId] }),
    foreignKey({
      name: 'finance_investment_lot_revisions_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    check(
      'finance_investment_lot_revisions_valid',
      sql`${t.revision} >= 0`,
    ),
  ],
);

export const financeInvestmentCorporateActions = schema.table(
  'finance_investment_corporate_actions',
  {
    ...booked(),
    actionType: text('action_type').notNull(),
    financialAccountId: uuid('financial_account_id').notNull(),
    instrumentId: uuid('instrument_id').notNull(),
    effectiveOn: date('effective_on').notNull(),
    numerator: decimal('numerator').notNull(),
    denominator: decimal('denominator').notNull(),
    fractionalTreatment: text('fractional_treatment').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    sourceReference: text('source_reference').notNull(),
    cashInLieu: jsonb('cash_in_lieu'),
    sourceAsOf: date('source_as_of').notNull(),
    sourceBoundary: text('source_boundary').notNull(),
    sourceRevision: integer('source_revision').notNull(),
    sourceSnapshotHash: text('source_snapshot_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    commandHash: text('command_hash').notNull(),
    status: text('status').default('committed').notNull(),
    createdBy: uuid('created_by').notNull().references(() => authUsers.id),
  },
  (t) => [
    unique('finance_investment_corporate_actions_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    unique('finance_investment_corporate_actions_idempotency').on(
      t.workspaceId,
      t.bookId,
      t.idempotencyKey,
    ),
    foreignKey({
      name: 'finance_investment_corporate_actions_book',
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    foreignKey({
      name: 'finance_investment_corporate_actions_account',
      columns: [t.workspaceId, t.bookId, t.financialAccountId],
      foreignColumns: [
        financeFinancialAccounts.workspaceId,
        financeFinancialAccounts.bookId,
        financeFinancialAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_corporate_actions_instrument',
      columns: [t.workspaceId, t.bookId, t.instrumentId],
      foreignColumns: [
        financeInstruments.workspaceId,
        financeInstruments.bookId,
        financeInstruments.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_corporate_actions_evidence',
      columns: [t.workspaceId, t.bookId, t.evidenceId],
      foreignColumns: [
        financeBookEvidence.workspaceId,
        financeBookEvidence.bookId,
        financeBookEvidence.id,
      ],
    }),
    check(
      'finance_investment_corporate_actions_valid',
      sql`${t.actionType} in ('split','reverse-split') and ${t.numerator}>0 and ${t.denominator}>0 and ${t.fractionalTreatment} in ('unknown','retain','cash-in-lieu') and ${t.sourceAsOf}=${t.effectiveOn} and ${t.sourceBoundary}='immediately-before-action' and ${t.sourceRevision}>=0 and ${t.status}='committed' and ${t.sourceSnapshotHash} ~ '^[a-f0-9]{64}$' and length(trim(${t.idempotencyKey}))>0 and ${t.commandHash} ~ '^[a-f0-9]{64}$' and (${t.cashInLieu} is null or jsonb_typeof(${t.cashInLieu})='object')`,
    ),
    index('finance_investment_corporate_actions_lookup').on(
      t.workspaceId,
      t.bookId,
      t.effectiveOn,
      t.financialAccountId,
      t.instrumentId,
    ),
  ],
);

export const financeInvestmentCorporateActionLots = schema.table(
  'finance_investment_corporate_action_lots',
  {
    ...booked(),
    actionId: uuid('action_id').notNull(),
    sourceLotId: uuid('source_lot_id').notNull(),
    successorLotKey: text('successor_lot_key').notNull(),
    financialAccountId: uuid('financial_account_id').notNull(),
    instrumentId: uuid('instrument_id').notNull(),
    acquiredOn: date('acquired_on').notNull(),
    acquisitionSequence: integer('acquisition_sequence').notNull(),
    quantity: decimal('quantity').notNull(),
    nativeCost: decimal('native_cost').notNull(),
    functionalCost: decimal('functional_cost').notNull(),
    nativeCurrency: text('native_currency').notNull(),
    functionalCurrency: text('functional_currency').notNull(),
    sourceReference: text('source_reference').notNull(),
  },
  (t) => [
    unique('finance_investment_corporate_action_lots_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    unique('finance_investment_corporate_action_lots_identity').on(
      t.workspaceId,
      t.bookId,
      t.actionId,
      t.sourceLotId,
    ),
    unique('finance_investment_corporate_action_lots_key').on(
      t.workspaceId,
      t.bookId,
      t.successorLotKey,
    ),
    foreignKey({
      name: 'finance_investment_corporate_action_lots_action',
      columns: [t.workspaceId, t.bookId, t.actionId],
      foreignColumns: [
        financeInvestmentCorporateActions.workspaceId,
        financeInvestmentCorporateActions.bookId,
        financeInvestmentCorporateActions.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_corporate_action_lots_source',
      columns: [t.workspaceId, t.bookId, t.sourceLotId],
      foreignColumns: [
        financeInvestmentLots.workspaceId,
        financeInvestmentLots.bookId,
        financeInvestmentLots.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_corporate_action_lots_account',
      columns: [t.workspaceId, t.bookId, t.financialAccountId],
      foreignColumns: [
        financeFinancialAccounts.workspaceId,
        financeFinancialAccounts.bookId,
        financeFinancialAccounts.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_corporate_action_lots_instrument',
      columns: [t.workspaceId, t.bookId, t.instrumentId],
      foreignColumns: [
        financeInstruments.workspaceId,
        financeInstruments.bookId,
        financeInstruments.id,
      ],
    }),
    check(
      'finance_investment_corporate_action_lots_valid',
      sql`${t.quantity}>0 and ${t.quantity}<>'NaN'::numeric and ${t.nativeCost}>=0 and ${t.nativeCost}<>'NaN'::numeric and ${t.functionalCost}>=0 and ${t.functionalCost}<>'NaN'::numeric and ${t.acquisitionSequence}>=0 and ${t.nativeCurrency} in ('CAD','USD','MXN','EUR','JPY','KRW') and ${t.functionalCurrency} in ('CAD','USD','MXN','EUR','JPY','KRW') and length(trim(${t.successorLotKey}))>0 and length(trim(${t.sourceReference}))>0`,
    ),
    index('finance_investment_corporate_action_lots_lookup').on(
      t.workspaceId,
      t.bookId,
      t.financialAccountId,
      t.instrumentId,
    ),
  ],
);

export const financeInvestmentCorporateActionEffects = schema.table(
  'finance_investment_corporate_action_effects',
  {
    ...booked(),
    actionId: uuid('action_id').notNull(),
    sourceLotId: uuid('source_lot_id').notNull(),
    successorLotId: uuid('successor_lot_id'),
    financialAccountId: uuid('financial_account_id').notNull(),
    instrumentId: uuid('instrument_id').notNull(),
    sourceOriginalQuantity: decimal('source_original_quantity').notNull(),
    sourceDisposedQuantity: decimal('source_disposed_quantity').notNull(),
    sourceRemainingQuantity: decimal('source_remaining_quantity').notNull(),
    sourceNativeCostBasis: decimal('source_native_cost_basis').notNull(),
    sourceFunctionalCostBasis: decimal(
      'source_functional_cost_basis',
    ).notNull(),
    successorQuantity: decimal('successor_quantity').notNull(),
    successorNativeCostBasis: decimal('successor_native_cost_basis').notNull(),
    successorFunctionalCostBasis: decimal(
      'successor_functional_cost_basis',
    ).notNull(),
  },
  (t) => [
    unique('finance_investment_corporate_action_effects_scope').on(
      t.workspaceId,
      t.bookId,
      t.id,
    ),
    unique('finance_investment_corporate_action_effects_identity').on(
      t.workspaceId,
      t.bookId,
      t.actionId,
      t.sourceLotId,
    ),
    foreignKey({
      name: 'finance_investment_corporate_action_effects_action',
      columns: [t.workspaceId, t.bookId, t.actionId],
      foreignColumns: [
        financeInvestmentCorporateActions.workspaceId,
        financeInvestmentCorporateActions.bookId,
        financeInvestmentCorporateActions.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_corporate_action_effects_source',
      columns: [t.workspaceId, t.bookId, t.sourceLotId],
      foreignColumns: [
        financeInvestmentLots.workspaceId,
        financeInvestmentLots.bookId,
        financeInvestmentLots.id,
      ],
    }),
    foreignKey({
      name: 'finance_investment_corporate_action_effects_successor',
      columns: [t.workspaceId, t.bookId, t.successorLotId],
      foreignColumns: [
        financeInvestmentCorporateActionLots.workspaceId,
        financeInvestmentCorporateActionLots.bookId,
        financeInvestmentCorporateActionLots.id,
      ],
    }),
    check(
      'finance_investment_corporate_action_effects_valid',
      sql`${t.sourceOriginalQuantity}>0 and ${t.sourceDisposedQuantity}>=0 and ${t.sourceRemainingQuantity}>=0 and ${t.sourceNativeCostBasis}>=0 and ${t.sourceFunctionalCostBasis}>=0 and ${t.successorQuantity}>=0 and ${t.successorNativeCostBasis}>=0 and ${t.successorFunctionalCostBasis}>=0 and (${t.successorLotId} is null and ${t.successorQuantity}=0 or ${t.successorLotId} is not null and ${t.successorQuantity}>0) and ${t.sourceOriginalQuantity}<>'NaN'::numeric and ${t.sourceDisposedQuantity}<>'NaN'::numeric and ${t.sourceRemainingQuantity}<>'NaN'::numeric and ${t.sourceNativeCostBasis}<>'NaN'::numeric and ${t.sourceFunctionalCostBasis}<>'NaN'::numeric and ${t.successorQuantity}<>'NaN'::numeric and ${t.successorNativeCostBasis}<>'NaN'::numeric and ${t.successorFunctionalCostBasis}<>'NaN'::numeric`,
    ),
    index('finance_investment_corporate_action_effects_lookup').on(
      t.workspaceId,
      t.bookId,
      t.actionId,
    ),
  ],
);

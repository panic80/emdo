import { createHash, randomUUID } from 'node:crypto';

import {
  CommitInvestmentStockSplitSchema,
  CommitInvestmentStockSplitSettlementSchema,
  FinanceStockSplitSettlementCommitResultSchema,
  FinanceStockSplitSettlementAccountingSummarySchema,
  SavedFinanceStockSplitSettlementSchema,
  CommitInvestmentCashDividendSchema,
  FinanceCashDividendCommitResultSchema,
  FinanceCashDividendListSchema,
  FinanceCashDividendSavedActionSchema,
  FinanceCashDividendSavedAmountSchema,
  FinanceCashDividendSavedSourceSchema,
  FinanceCashDividendSourceSnapshotSchema,
  FinanceStockSplitActionSchema,
  FinanceStockSplitCommitResultSchema,
  InvestmentLotStateSchema,
  ReadInvestmentCashDividendSourceSchema,
  ListInvestmentCashDividendsSchema,
  UuidSchema,
  WorkspaceContextSchema,
  type CommitInvestmentCashDividend,
  type CommitInvestmentStockSplit,
  type FinanceCashDividendCommitResult,
  type FinanceCashDividendList,
  type FinanceCashDividendSavedAction,
  type FinanceCashDividendSavedAmount,
  type FinanceCashDividendSourceSnapshot,
  type ReadInvestmentCashDividendSource,
  type WorkspaceContext,
} from '@emdo/contracts';
import {
  formatFinanceDecimal,
  parseFinanceDecimal,
  planInvestmentStockSplit,
  planInvestmentStockSplitSettlement,
  planStockSplitSettlementJournals,
  planInvestmentCashDividend,
  validateJournal,
} from '@emdo/domains/finance';

import { hashSettlementProof } from './finance-corporate-action-settlement-proof.js';

import type { DatabaseClient, DatabasePool } from './scoped-repository.js';
import {
  beginDurableTransaction,
  lockDurableScope,
} from './durable/scoped-transaction.js';

/**
 * A corporate action is committed only after the caller has reviewed the
 * deterministic planner output. The repository never mutates a source lot;
 * it appends an action, its effects, and successor-lot projections together.
 */
export class FinanceCorporateActionPersistenceError extends Error {
  constructor(
    readonly code:
      'authorization-revoked' | 'invalid-input' | 'conflict' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'FinanceCorporateActionPersistenceError';
  }
}

type SourceLot = ReturnType<typeof InvestmentLotStateSchema.parse>;

type SourceLotRow = Record<string, unknown>;

const SHA256 = /^[a-f0-9]{64}$/u;

const hashJson = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const uuidFromSeed = (seed: string): string => {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  // UUIDv8 is used for deterministic projection IDs. These IDs are scoped by
  // the action and source lot in the database as a second safety boundary.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const decimal = (value: unknown, label: string): string => {
  if (typeof value !== 'string')
    throw new FinanceCorporateActionPersistenceError(
      'unavailable',
      `Corporate-action source ${label} is not a decimal string`,
    );
  return formatFinanceDecimal(parseFinanceDecimal(value));
};

const rowString = (row: SourceLotRow, key: string): string => {
  const value = row[key];
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new FinanceCorporateActionPersistenceError(
      'unavailable',
      `Corporate-action source column ${key} is unavailable`,
    );
  return String(value);
};

const rowNumber = (row: SourceLotRow, key: string): number => {
  const value = row[key];
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new FinanceCorporateActionPersistenceError(
      'unavailable',
      `Corporate-action source column ${key} is not a safe integer`,
    );
  return number;
};

const rowNullableString = (row: SourceLotRow, key: string): string | null => {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new FinanceCorporateActionPersistenceError(
      'unavailable',
      `Corporate-action source column ${key} is unavailable`,
    );
  return String(value);
};

const rowIssues = (row: SourceLotRow): string[] => {
  const value = row.issues;
  if (!Array.isArray(value))
    throw new FinanceCorporateActionPersistenceError(
      'unavailable',
      'Corporate-action source issues are unavailable',
    );
  return value.map((issue) => String(issue));
};

const sortLots = (lots: readonly SourceLot[]): SourceLot[] =>
  [...lots].sort(
    (left, right) =>
      left.acquiredOn.localeCompare(right.acquiredOn) ||
      left.acquisitionSequence - right.acquisitionSequence ||
      left.id.localeCompare(right.id),
  );

const dividendSourceSnapshot = (
  row: SourceLotRow,
  source: ReadInvestmentCashDividendSource,
): FinanceCashDividendSourceSnapshot => {
  const base = {
    sourceRowId: rowString(row, 'sourceRowId'),
    batchId: rowString(row, 'batchId'),
    sourceRow: rowNumber(row, 'sourceRow'),
    evidenceId: rowString(row, 'evidenceId'),
    financialAccountId: rowString(row, 'financialAccountId'),
    instrumentId: source.instrumentId,
    sourceRevision: rowNumber(row, 'revision'),
    status: String(row.status),
    effectiveOn: rowNullableString(row, 'effectiveOn'),
    description: rowString(row, 'description'),
    nativeAmount: rowNullableString(row, 'nativeAmount'),
    currency: rowString(row, 'currency'),
    fxRate: rowNullableString(row, 'fxRate'),
    fxSource: rowNullableString(row, 'fxSource'),
    issues: rowIssues(row),
    financialAccountLedgerId: rowString(row, 'financialAccountLedgerId'),
    functionalCurrency: rowString(row, 'functionalCurrency'),
  };
  return FinanceCashDividendSourceSnapshotSchema.parse({
    ...base,
    sourceSnapshotHash: hashJson(base),
  });
};

const canonicalLot = (value: unknown): SourceLot => {
  const lot = InvestmentLotStateSchema.parse(value);
  return {
    ...lot,
    originalQuantity: decimal(lot.originalQuantity, 'originalQuantity'),
    disposedQuantity: decimal(lot.disposedQuantity, 'disposedQuantity'),
    originalNativeCost: decimal(lot.originalNativeCost, 'originalNativeCost'),
    allocatedNativeCost: decimal(
      lot.allocatedNativeCost,
      'allocatedNativeCost',
    ),
    originalFunctionalCost: decimal(
      lot.originalFunctionalCost,
      'originalFunctionalCost',
    ),
    allocatedFunctionalCost: decimal(
      lot.allocatedFunctionalCost,
      'allocatedFunctionalCost',
    ),
  };
};

const canonicalAction = (
  input: CommitInvestmentStockSplit,
): CommitInvestmentStockSplit['action'] => {
  const action = input.action;
  return {
    ...action,
    numerator: decimal(action.numerator, 'ratio numerator'),
    denominator: decimal(action.denominator, 'ratio denominator'),
    cashInLieu:
      action.cashInLieu === null
        ? null
        : {
            ...action.cashInLieu,
            consideration: {
              ...action.cashInLieu.consideration,
              amount: decimal(
                action.cashInLieu.consideration.amount,
                'cash-in-lieu consideration',
              ),
            },
          },
  };
};

const sourceLotFromRow = (row: SourceLotRow): SourceLot =>
  InvestmentLotStateSchema.parse({
    id: rowString(row, 'id'),
    financialAccountId: rowString(row, 'financialAccountId'),
    instrumentId: rowString(row, 'instrumentId'),
    acquiredOn: rowString(row, 'acquiredOn'),
    acquisitionSequence: rowNumber(row, 'acquisitionSequence'),
    originalQuantity: decimal(rowString(row, 'originalQuantity'), 'quantity'),
    disposedQuantity: decimal(rowString(row, 'disposedQuantity'), 'quantity'),
    originalNativeCost: decimal(
      rowString(row, 'originalNativeCost'),
      'native cost',
    ),
    allocatedNativeCost: decimal(
      rowString(row, 'allocatedNativeCost'),
      'allocated native cost',
    ),
    originalFunctionalCost: decimal(
      rowString(row, 'originalFunctionalCost'),
      'functional cost',
    ),
    allocatedFunctionalCost: decimal(
      rowString(row, 'allocatedFunctionalCost'),
      'allocated functional cost',
    ),
    nativeCurrency: rowString(row, 'nativeCurrency'),
    functionalCurrency: rowString(row, 'functionalCurrency'),
    sourceReference: rowString(row, 'sourceReference'),
  });

const conflict = (message: string): never => {
  throw new FinanceCorporateActionPersistenceError('conflict', message);
};

const unavailable = (message: string): never => {
  throw new FinanceCorporateActionPersistenceError('unavailable', message);
};

const mapDatabaseError = (error: unknown): unknown => {
  if (
    error instanceof FinanceCorporateActionPersistenceError ||
    !(error instanceof Error) ||
    error.name === 'ZodError'
  )
    return error;
  const code = 'code' in error ? String(error.code) : '';
  if (
    code === '42501' ||
    code === 'authorization-revoked' ||
    error.message === 'finance-book-forbidden'
  )
    return new FinanceCorporateActionPersistenceError(
      'authorization-revoked',
      error.message,
    );
  if (['22P02', '22003', '23502', '23503'].includes(code))
    return new FinanceCorporateActionPersistenceError(
      'invalid-input',
      error.message,
    );
  if (
    ['23505', '23514', '40P01', '55P03'].includes(code) ||
    error.message.startsWith('finance-corporate-action-')
  )
    return new FinanceCorporateActionPersistenceError(
      'conflict',
      error.message,
    );
  return error;
};

const rollbackQuietly = async (client: DatabaseClient) => {
  try {
    await client.query('rollback');
  } catch {
    // Preserve the original failure.
  }
};

interface RevisionRow {
  readonly revision: number;
}

interface ActionRow {
  readonly id: string;
  readonly sourceRevision: number;
  readonly sourceSnapshotHash: string;
  readonly commandHash: string;
}

interface DividendActionRow {
  readonly id: string;
  readonly sourceRowId: string;
  readonly sourceRevision: number;
  readonly sourceSnapshotHash: string;
  readonly commandHash: string;
  readonly economicTransactionId: string;
  readonly journalId: string;
  readonly grossFunctionalAmount: string;
  readonly withholdingFunctionalAmount: string;
  readonly netFunctionalAmount: string;
}

/** Durable persistence for reviewed stock-split and reverse-split actions. */
export class PostgresFinanceCorporateActionRepository {
  constructor(private readonly pool: DatabasePool) {}

  private async transaction<T>(
    context: WorkspaceContext,
    work: (client: DatabaseClient) => Promise<T>,
  ): Promise<T> {
    const scope = WorkspaceContextSchema.parse(context);
    const client = await beginDurableTransaction(this.pool, {
      ...scope,
      householdId: scope.workspaceId,
    });
    try {
      await lockDurableScope(client, { householdId: scope.workspaceId });
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  }

  private async book(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    readOnly = false,
  ): Promise<Record<string, unknown>> {
    UuidSchema.parse(bookId);
    const locked = await client.query(
      'select emdo.lock_finance_book_grant($1,$2) as allowed',
      [context.workspaceId, bookId],
    );
    if (locked.rows[0]?.allowed !== true)
      throw new Error('finance-book-forbidden');
    const result = await client.query(
      `select b.*,g.role
         from emdo.finance_books b
         join emdo.finance_book_grants g
           on g.workspace_id=b.workspace_id and g.book_id=b.id
        where b.workspace_id=$1 and b.id=$2 and g.user_id=$3 and g.revoked_at is null`,
      [context.workspaceId, bookId, context.userId],
    );
    const book = result.rows[0];
    if (
      !book ||
      !(
        readOnly
          ? ['administrator', 'approver', 'preparer', 'viewer']
          : ['administrator', 'approver']
      ).includes(String(book.role))
    )
      throw new Error('finance-book-forbidden');
    return book;
  }

  /** Returns the CAS revision that must be echoed into a commit command. */
  getInvestmentLotRevision(context: WorkspaceContext, bookId: string) {
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      const row = (
        await client.query(
          `select revision
             from emdo.finance_investment_lot_revisions
            where workspace_id=$1 and book_id=$2`,
          [context.workspaceId, bookId],
        )
      ).rows[0];
      if (!row)
        unavailable('finance-corporate-action-source-revision-unavailable');
      const revision = Number(row.revision);
      if (!Number.isSafeInteger(revision) || revision < 0)
        unavailable('finance-corporate-action-source-revision-invalid');
      return Object.freeze({ revision });
    });
  }

  /**
   * Reads the exact source snapshot used by a later reviewed commit. The
   * snapshot and revision are read under the same book lock used by commit;
   * callers must still expect a CAS conflict if another writer commits first.
   */
  readInvestmentStockSplitSource(
    context: WorkspaceContext,
    bookId: string,
    input: unknown,
  ) {
    const action = FinanceStockSplitActionSchema.parse(input);
    UuidSchema.parse(bookId);
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${context.workspaceId}:${bookId}`],
      );
      const revision = await this.currentRevision(client, context, bookId);
      const sourceLots = await this.sourceLots(client, context, bookId, action);
      return Object.freeze({
        sourceRevision: revision.revision,
        sourceSnapshotHash: hashJson(sourceLots),
        sourceAsOf: action.effectiveOn,
        sourceBoundary: 'immediately-before-action' as const,
        sourceLots: Object.freeze(sourceLots),
      });
    });
  }

  /**
   * Reads a normalized cash receipt together with the account/book/evidence
   * coordinates that a reviewed dividend must echo. This snapshot is read
   * under the same book lock used by commit, so a preview cannot combine a row
   * revision with a different account or evidence revision.
   */
  readInvestmentCashDividendSource(
    context: WorkspaceContext,
    bookId: string,
    input: unknown,
  ) {
    const source = ReadInvestmentCashDividendSourceSchema.parse(input);
    UuidSchema.parse(bookId);
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${context.workspaceId}:${bookId}`],
      );
      const row = (
        await client.query(
          `select r.id as "sourceRowId",r.batch_id as "batchId",r.source_row as "sourceRow",
                  r.status,r.revision,r.effective_on::text as "effectiveOn",
                  r.description,r.external_id as "externalId",
                  r.native_amount::text as "nativeAmount",r.issues,
                  r.fx_rate::text as "fxRate",r.fx_source as "fxSource",
                  i.evidence_id as "evidenceId",
                  i.financial_account_id as "financialAccountId",
                  a.currency,a.ledger_account_id as "financialAccountLedgerId",
                  b.functional_currency as "functionalCurrency"
             from emdo.finance_normalized_import_rows r
             join emdo.finance_normalized_imports i
               on i.workspace_id=r.workspace_id and i.book_id=r.book_id
              and i.id=r.batch_id
             join emdo.finance_financial_accounts a
               on a.workspace_id=i.workspace_id and a.book_id=i.book_id
              and a.id=i.financial_account_id and a.active
             join emdo.finance_books b
               on b.workspace_id=r.workspace_id and b.id=r.book_id
             join emdo.finance_book_evidence e
               on e.workspace_id=i.workspace_id and e.book_id=i.book_id
              and e.id=i.evidence_id
            where r.workspace_id=$1 and r.book_id=$2 and r.id=$3
              and i.financial_account_id=$4 and i.evidence_id=$5
              and exists (
                select 1 from emdo.finance_instruments ins
                 where ins.workspace_id=r.workspace_id and ins.book_id=r.book_id
                   and ins.id=$6
              )`,
          [
            context.workspaceId,
            bookId,
            source.sourceRowId,
            source.financialAccountId,
            source.evidenceId,
            source.instrumentId,
          ],
        )
      ).rows[0] as SourceLotRow | undefined;
      if (!row) unavailable('finance-cash-dividend-source-unavailable');
      return Object.freeze(dividendSourceSnapshot(row!, source));
    });
  }

  /**
   * Reads one committed dividend together with its immutable component,
   * journal, economic-transaction, evidence, and source-row proofs. The
   * action tables are append-only; the source row is returned at its current
   * claimed revision while `sourceRevision` identifies the reviewed input
   * revision that the action committed.
   */
  getInvestmentCashDividend(
    context: WorkspaceContext,
    bookId: string,
    actionId: string,
  ): Promise<FinanceCashDividendSavedAction | null> {
    UuidSchema.parse(bookId);
    UuidSchema.parse(actionId);
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      return this.readSavedDividendAction(client, context, bookId, actionId);
    });
  }

  /** Lists committed dividend proofs in a bounded, stable page. */
  listInvestmentCashDividends(
    context: WorkspaceContext,
    bookId: string,
    input: unknown = {},
  ): Promise<FinanceCashDividendList> {
    const page = ListInvestmentCashDividendsSchema.parse(input);
    UuidSchema.parse(bookId);
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      const rows = (
        await client.query(
          `select id
             from emdo.finance_investment_cash_dividends
            where workspace_id=$1 and book_id=$2 and status='committed'
            order by payable_on desc,created_at desc,id desc
            offset $3 limit $4`,
          [context.workspaceId, bookId, page.offset, page.limit + 1],
        )
      ).rows;
      const records: FinanceCashDividendSavedAction[] = [];
      for (const row of rows.slice(0, page.limit)) {
        const id = rowString(row, 'id');
        const record = await this.readSavedDividendAction(
          client,
          context,
          bookId,
          id,
        );
        if (!record) unavailable('finance-cash-dividend-unavailable');
        records.push(record!);
      }
      return FinanceCashDividendListSchema.parse({
        actions: records,
        nextOffset: rows.length > page.limit ? page.offset + page.limit : null,
      });
    });
  }

  private async readSavedDividendAction(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    actionId: string,
  ): Promise<FinanceCashDividendSavedAction | null> {
    const actionRow = (
      await client.query(
        `select id,workspace_id as "workspaceId",book_id as "bookId",
                action_type as "actionType",financial_account_id as "financialAccountId",
                instrument_id as "instrumentId",evidence_id as "evidenceId",
                source_row_id as "sourceRowId",declared_on::text as "declaredOn",
                ex_date::text as "exDate",payable_on::text as "payableOn",
                source_reference as "sourceReference",review_reason as "reviewReason",
                cash_ledger_account_id as "cashLedgerAccountId",
                dividend_income_ledger_account_id as "dividendIncomeLedgerAccountId",
                withholding_ledger_account_id as "withholdingLedgerAccountId",
                source_revision as "sourceRevision",source_snapshot_hash as "sourceSnapshotHash",
                idempotency_key as "idempotencyKey",command_hash as "commandHash",
                economic_transaction_id as "economicTransactionId",journal_id as "journalId",
                status,created_by as "createdBy",created_at as "createdAt"
           from emdo.finance_investment_cash_dividends
          where workspace_id=$1 and book_id=$2 and id=$3 and status='committed'`,
        [context.workspaceId, bookId, actionId],
      )
    ).rows[0];
    if (!actionRow) return null;

    const sourceRow = (
      await client.query(
        `select r.id as "sourceRowId",r.batch_id as "batchId",
                r.source_row as "sourceRow",r.status,r.revision as "currentRevision",
                r.effective_on::text as "effectiveOn",r.description,
                r.native_amount::text as "nativeAmount",r.issues,
                r.fx_rate::text as "fxRate",r.fx_source as "fxSource",
                i.evidence_id as "evidenceId",i.financial_account_id as "financialAccountId",
                a.currency,a.ledger_account_id as "financialAccountLedgerId",
                b.functional_currency as "functionalCurrency"
           from emdo.finance_normalized_import_rows r
           join emdo.finance_normalized_imports i
             on i.workspace_id=r.workspace_id and i.book_id=r.book_id and i.id=r.batch_id
           join emdo.finance_financial_accounts a
             on a.workspace_id=i.workspace_id and a.book_id=i.book_id
            and a.id=i.financial_account_id
           join emdo.finance_books b
             on b.workspace_id=r.workspace_id and b.id=r.book_id
          where r.workspace_id=$1 and r.book_id=$2 and r.id=$3`,
        [context.workspaceId, bookId, rowString(actionRow, 'sourceRowId')],
      )
    ).rows[0];
    if (!sourceRow) unavailable('finance-cash-dividend-source-unavailable');

    const sourceRevision = rowNumber(actionRow, 'sourceRevision');
    const currentRevision = rowNumber(sourceRow!, 'currentRevision');
    if (currentRevision !== sourceRevision + 1)
      unavailable('finance-cash-dividend-source-revision-invalid');
    const source = FinanceCashDividendSavedSourceSchema.parse({
      sourceRowId: rowString(sourceRow!, 'sourceRowId'),
      batchId: rowString(sourceRow!, 'batchId'),
      sourceRow: rowNumber(sourceRow!, 'sourceRow'),
      evidenceId: rowString(sourceRow!, 'evidenceId'),
      financialAccountId: rowString(sourceRow!, 'financialAccountId'),
      instrumentId: rowString(actionRow, 'instrumentId'),
      sourceRevision,
      currentRevision,
      sourceSnapshotHash: rowString(actionRow, 'sourceSnapshotHash'),
      status: rowString(sourceRow!, 'status'),
      effectiveOn: rowNullableString(sourceRow!, 'effectiveOn'),
      description: rowString(sourceRow!, 'description'),
      nativeAmount: rowNullableString(sourceRow!, 'nativeAmount'),
      currency: rowString(sourceRow!, 'currency'),
      fxRate: rowNullableString(sourceRow!, 'fxRate'),
      fxSource: rowNullableString(sourceRow!, 'fxSource'),
      issues: rowIssues(sourceRow!),
      financialAccountLedgerId: rowString(
        sourceRow!,
        'financialAccountLedgerId',
      ),
      functionalCurrency: rowString(sourceRow!, 'functionalCurrency'),
    });

    const amountRows = (
      await client.query(
        `select id,kind,native_amount::text as "nativeAmount",currency,
                functional_amount::text as "functionalAmount",fx_rate::text as "fxRate",
                fx_source as "fxSource",ledger_account_id as "ledgerAccountId",
                posting_side as "postingSide",journal_id as "journalId",
                journal_line_number as "journalLineNumber",
                source_provenance as provenance
           from emdo.finance_investment_cash_dividend_amounts
          where workspace_id=$1 and book_id=$2 and action_id=$3
          order by kind`,
        [context.workspaceId, bookId, actionId],
      )
    ).rows;
    if (amountRows.length !== 3)
      unavailable('finance-cash-dividend-replay-amounts-unavailable');
    const amounts = new Map<string, FinanceCashDividendSavedAmount>();
    for (const row of amountRows) {
      const amount = FinanceCashDividendSavedAmountSchema.parse(row);
      if (amounts.has(amount.kind))
        unavailable('finance-cash-dividend-replay-amounts-unavailable');
      amounts.set(amount.kind, amount);
    }
    const gross = amounts.get('gross');
    const withholding = amounts.get('withholding');
    const net = amounts.get('net');
    if (!gross || !withholding || !net)
      unavailable('finance-cash-dividend-replay-amounts-unavailable');

    return Object.freeze(
      FinanceCashDividendSavedActionSchema.parse({
        id: rowString(actionRow, 'id'),
        workspaceId: rowString(actionRow, 'workspaceId'),
        bookId: rowString(actionRow, 'bookId'),
        actionType: rowString(actionRow, 'actionType'),
        financialAccountId: rowString(actionRow, 'financialAccountId'),
        instrumentId: rowString(actionRow, 'instrumentId'),
        evidenceId: rowString(actionRow, 'evidenceId'),
        sourceRowId: rowString(actionRow, 'sourceRowId'),
        declaredOn: rowString(actionRow, 'declaredOn'),
        exDate: rowNullableString(actionRow, 'exDate'),
        payableOn: rowString(actionRow, 'payableOn'),
        sourceReference: rowString(actionRow, 'sourceReference'),
        reviewReason: rowString(actionRow, 'reviewReason'),
        cashLedgerAccountId: rowString(actionRow, 'cashLedgerAccountId'),
        dividendIncomeLedgerAccountId: rowString(
          actionRow,
          'dividendIncomeLedgerAccountId',
        ),
        withholdingLedgerAccountId: rowString(
          actionRow,
          'withholdingLedgerAccountId',
        ),
        sourceRevision,
        nextSourceRevision: currentRevision,
        sourceSnapshotHash: rowString(actionRow, 'sourceSnapshotHash'),
        idempotencyKey: rowString(actionRow, 'idempotencyKey'),
        commandHash: rowString(actionRow, 'commandHash'),
        economicTransactionId: rowString(actionRow, 'economicTransactionId'),
        journalId: rowString(actionRow, 'journalId'),
        status: rowString(actionRow, 'status'),
        createdBy: rowString(actionRow, 'createdBy'),
        createdAt: new Date(rowString(actionRow, 'createdAt')).toISOString(),
        source,
        gross,
        withholding,
        net,
      }),
    );
  }

  /**
   * Atomically posts a reviewed dividend receipt and claims its normalized
   * statement row. The source row, economic transaction, journal, action, and
   * amount proofs are committed in one transaction under the book lock.
   */
  commitInvestmentCashDividend(
    context: WorkspaceContext,
    bookId: string,
    input: unknown,
  ) {
    const data = CommitInvestmentCashDividendSchema.parse(input);
    UuidSchema.parse(bookId);
    const action = data.action;
    const commandHash = hashJson({
      bookId,
      action,
      expectedSourceRevision: data.expectedSourceRevision,
      sourceSnapshotHash: data.sourceSnapshotHash,
      idempotencyKey: data.idempotencyKey,
    });
    const sourceRequest: ReadInvestmentCashDividendSource = {
      sourceRowId: action.sourceRowId,
      financialAccountId: action.financialAccountId,
      instrumentId: action.instrumentId,
      evidenceId: action.evidenceId,
    };
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${context.workspaceId}:${bookId}`],
      );
      const existing = await this.existingDividendAction(
        client,
        context,
        bookId,
        action.id,
        action.sourceRowId,
        data.idempotencyKey,
        commandHash,
      );
      if (existing)
        return this.replayDividendResult(context, bookId, existing.result);

      const row = (
        await client.query(
          `select r.id as "sourceRowId",r.batch_id as "batchId",r.source_row as "sourceRow",
                  r.status,r.revision,r.effective_on::text as "effectiveOn",
                  r.description,r.external_id as "externalId",
                  r.native_amount::text as "nativeAmount",r.issues,
                  r.fx_rate::text as "fxRate",r.fx_source as "fxSource",
                  i.evidence_id as "evidenceId",
                  i.financial_account_id as "financialAccountId",
                  a.currency,a.ledger_account_id as "financialAccountLedgerId",
                  b.functional_currency as "functionalCurrency"
             from emdo.finance_normalized_import_rows r
             join emdo.finance_normalized_imports i
               on i.workspace_id=r.workspace_id and i.book_id=r.book_id
              and i.id=r.batch_id
             join emdo.finance_financial_accounts a
               on a.workspace_id=i.workspace_id and a.book_id=i.book_id
              and a.id=i.financial_account_id and a.active
             join emdo.finance_books b
               on b.workspace_id=r.workspace_id and b.id=r.book_id
             join emdo.finance_book_evidence e
               on e.workspace_id=i.workspace_id and e.book_id=i.book_id
              and e.id=i.evidence_id
            where r.workspace_id=$1 and r.book_id=$2 and r.id=$3
              and i.financial_account_id=$4 and i.evidence_id=$5
              and exists (
                select 1 from emdo.finance_instruments ins
                 where ins.workspace_id=r.workspace_id and ins.book_id=r.book_id
                   and ins.id=$6
              )`,
          [
            context.workspaceId,
            bookId,
            sourceRequest.sourceRowId,
            sourceRequest.financialAccountId,
            sourceRequest.evidenceId,
            sourceRequest.instrumentId,
          ],
        )
      ).rows[0] as SourceLotRow | undefined;
      const sourceRow =
        row ?? unavailable('finance-cash-dividend-source-unavailable');
      const source = dividendSourceSnapshot(sourceRow, sourceRequest);
      if (source.sourceRevision !== data.expectedSourceRevision)
        conflict('finance-cash-dividend-source-revision-conflict');
      if (source.sourceSnapshotHash !== data.sourceSnapshotHash)
        conflict('finance-cash-dividend-source-snapshot-conflict');

      const plan = planInvestmentCashDividend({ action, source });
      if (plan.commitReadiness !== 'ready')
        conflict(
          `finance-cash-dividend-not-ready:${plan.blockedReasons.join(',')}`,
        );
      await this.validateDividendAccounts(
        client,
        context,
        bookId,
        action,
        source,
      );

      const journalId = await this.insertDividendJournal(
        client,
        context,
        bookId,
        action,
        plan,
      );
      const transactionId = randomUUID();
      const fingerprint = hashJson([
        'investment-cash-dividend-source',
        context.workspaceId,
        bookId,
        action.sourceRowId,
      ]);
      const factsHash = hashJson({
        action,
        source,
        plan: {
          calculationVersion: plan.calculationVersion,
          grossFunctionalAmount: plan.grossFunctionalAmount,
          withholdingFunctionalAmount: plan.withholdingFunctionalAmount,
          netFunctionalAmount: plan.netFunctionalAmount,
        },
      });
      await client.query(
        `insert into emdo.finance_economic_transactions
           (id,workspace_id,book_id,financial_account_id,effective_on,
            description,native_amount,functional_amount,fx_rate,fx_source,
            journal_id,fingerprint,facts_hash,external_id)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          transactionId,
          context.workspaceId,
          bookId,
          action.financialAccountId,
          action.payableOn,
          action.sourceReference,
          action.net.nativeAmount,
          plan.netFunctionalAmount,
          action.net.fxRate,
          action.net.fxSource,
          journalId,
          fingerprint,
          factsHash,
          action.sourceReference,
        ],
      );

      await client.query(
        `insert into emdo.finance_investment_cash_dividends
           (id,workspace_id,book_id,action_type,financial_account_id,
            instrument_id,evidence_id,source_row_id,declared_on,ex_date,
            payable_on,source_reference,review_reason,cash_ledger_account_id,
            dividend_income_ledger_account_id,withholding_ledger_account_id,
            source_revision,source_snapshot_hash,idempotency_key,command_hash,
            economic_transaction_id,journal_id,status,created_by)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                $18,$19,$20,$21,$22,'committed',$23)`,
        [
          action.id,
          context.workspaceId,
          bookId,
          action.actionType,
          action.financialAccountId,
          action.instrumentId,
          action.evidenceId,
          action.sourceRowId,
          action.declaredOn,
          action.exDate,
          action.payableOn,
          action.sourceReference,
          action.reviewReason,
          action.ledger.cashLedgerAccountId,
          action.ledger.dividendIncomeLedgerAccountId,
          action.ledger.withholdingLedgerAccountId,
          source.sourceRevision,
          source.sourceSnapshotHash,
          data.idempotencyKey,
          commandHash,
          transactionId,
          journalId,
          context.userId,
        ],
      );

      const lineByKind = new Map(
        plan.journalLines.map((line, index) => [line.kind, { line, index }]),
      );
      for (const [kind, amount] of [
        ['gross', action.gross],
        ['withholding', action.withholding],
        ['net', action.net],
      ] as const) {
        const line = lineByKind.get(kind);
        await client.query(
          `insert into emdo.finance_investment_cash_dividend_amounts
             (id,workspace_id,book_id,action_id,kind,native_amount,currency,
              functional_amount,fx_rate,fx_source,ledger_account_id,
              posting_side,journal_id,journal_line_number,source_provenance)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
          [
            randomUUID(),
            context.workspaceId,
            bookId,
            action.id,
            kind,
            amount.nativeAmount,
            amount.currency,
            amount.functionalAmount,
            amount.fxRate,
            amount.fxSource,
            kind === 'gross'
              ? action.ledger.dividendIncomeLedgerAccountId
              : kind === 'withholding'
                ? action.ledger.withholdingLedgerAccountId
                : action.ledger.cashLedgerAccountId,
            kind === 'gross' ? 'credit' : 'debit',
            journalId,
            line?.index === undefined ? null : line.index + 1,
            JSON.stringify(amount.provenance),
          ],
        );
      }

      await client.query(
        `insert into emdo.finance_import_row_reviews
           (workspace_id,book_id,row_id,revision,decision,previous_facts,reviewed_by)
         values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
        [
          context.workspaceId,
          bookId,
          action.sourceRowId,
          source.sourceRevision + 1,
          JSON.stringify({
            action: 'cash-dividend',
            dividendActionId: action.id,
            sourceSnapshotHash: source.sourceSnapshotHash,
            reason: action.reviewReason,
          }),
          JSON.stringify({
            date: source.effectiveOn,
            description: source.description,
            amount: source.nativeAmount,
            externalId: rowNullableString(sourceRow, 'externalId'),
          }),
          context.userId,
        ],
      );
      const updated = await client.query(
        `update emdo.finance_normalized_import_rows
            set status='committed',economic_transaction_id=$4,revision=revision+1
          where workspace_id=$1 and book_id=$2 and id=$3
            and revision=$5 and status='ready'`,
        [
          context.workspaceId,
          bookId,
          action.sourceRowId,
          transactionId,
          source.sourceRevision,
        ],
      );
      if (updated.rowCount !== 1)
        conflict('finance-cash-dividend-source-revision-conflict');

      return FinanceCashDividendCommitResultSchema.parse({
        actionId: action.id,
        workspaceId: context.workspaceId,
        bookId,
        sourceRowId: action.sourceRowId,
        sourceRevision: source.sourceRevision,
        nextSourceRevision: source.sourceRevision + 1,
        sourceSnapshotHash: source.sourceSnapshotHash,
        economicTransactionId: transactionId,
        journalId,
        grossFunctionalAmount: plan.grossFunctionalAmount,
        withholdingFunctionalAmount: plan.withholdingFunctionalAmount,
        netFunctionalAmount: plan.netFunctionalAmount,
        status: 'committed',
        replayed: false,
      });
    });
  }

  private async currentRevision(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
  ): Promise<RevisionRow> {
    const row = (
      await client.query(
        `select revision
           from emdo.finance_investment_lot_revisions
          where workspace_id=$1 and book_id=$2`,
        [context.workspaceId, bookId],
      )
    ).rows[0];
    if (!row)
      unavailable('finance-corporate-action-source-revision-unavailable');
    const revision = Number(row.revision);
    if (!Number.isSafeInteger(revision) || revision < 0)
      unavailable('finance-corporate-action-source-revision-invalid');
    return { revision };
  }

  private async existingAction(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    actionId: string,
    idempotencyKey: string,
    commandHash: string,
  ): Promise<
    { readonly result: ActionRow; readonly replayed: boolean } | undefined
  > {
    const byKey = (
      await client.query(
        `select id,source_revision as "sourceRevision",
                source_snapshot_hash as "sourceSnapshotHash",command_hash as "commandHash"
           from emdo.finance_investment_corporate_actions
          where workspace_id=$1 and book_id=$2 and idempotency_key=$3`,
        [context.workspaceId, bookId, idempotencyKey],
      )
    ).rows[0] as unknown as ActionRow | undefined;
    if (byKey) {
      if (byKey.commandHash !== commandHash)
        conflict('finance-corporate-action-idempotency-conflict');
      if (byKey.id !== actionId)
        conflict('finance-corporate-action-idempotency-action-mismatch');
      return { result: byKey, replayed: true };
    }
    const byId = (
      await client.query(
        `select id,source_revision as "sourceRevision",
                source_snapshot_hash as "sourceSnapshotHash",command_hash as "commandHash"
           from emdo.finance_investment_corporate_actions
          where workspace_id=$1 and book_id=$2 and id=$3`,
        [context.workspaceId, bookId, actionId],
      )
    ).rows[0] as unknown as ActionRow | undefined;
    if (byId) conflict('finance-corporate-action-action-id-conflict');
    return undefined;
  }

  private async existingDividendAction(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    actionId: string,
    sourceRowId: string,
    idempotencyKey: string,
    commandHash: string,
  ): Promise<
    | { readonly result: DividendActionRow; readonly replayed: boolean }
    | undefined
  > {
    const select = `select id,source_row_id as "sourceRowId",source_revision as "sourceRevision",
                           source_snapshot_hash as "sourceSnapshotHash",command_hash as "commandHash",
                           economic_transaction_id as "economicTransactionId",journal_id as "journalId"
                      from emdo.finance_investment_cash_dividends`;
    const byKey = (
      await client.query(
        `${select} where workspace_id=$1 and book_id=$2 and idempotency_key=$3`,
        [context.workspaceId, bookId, idempotencyKey],
      )
    ).rows[0] as unknown as DividendActionRow | undefined;
    if (byKey) {
      if (byKey.commandHash !== commandHash)
        conflict('finance-cash-dividend-idempotency-conflict');
      if (byKey.id !== actionId)
        conflict('finance-cash-dividend-idempotency-action-mismatch');
      return {
        result: await this.withDividendAmounts(client, context, bookId, byKey),
        replayed: true,
      };
    }
    const byId = (
      await client.query(
        `${select} where workspace_id=$1 and book_id=$2 and id=$3`,
        [context.workspaceId, bookId, actionId],
      )
    ).rows[0] as unknown as DividendActionRow | undefined;
    if (byId) conflict('finance-cash-dividend-action-id-conflict');
    const bySource = (
      await client.query(
        `${select} where workspace_id=$1 and book_id=$2 and source_row_id=$3`,
        [context.workspaceId, bookId, sourceRowId],
      )
    ).rows[0] as unknown as DividendActionRow | undefined;
    if (bySource) conflict('finance-cash-dividend-duplicate-source-row');
    return undefined;
  }

  private async withDividendAmounts(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    row: DividendActionRow,
  ): Promise<DividendActionRow> {
    const amounts = (
      await client.query(
        `select kind,functional_amount::text as "functionalAmount"
           from emdo.finance_investment_cash_dividend_amounts
          where workspace_id=$1 and book_id=$2 and action_id=$3
          order by kind`,
        [context.workspaceId, bookId, row.id],
      )
    ).rows;
    const values = new Map(
      amounts.map((amount) => [
        String(amount.kind),
        String(amount.functionalAmount),
      ]),
    );
    if (
      !values.has('gross') ||
      !values.has('withholding') ||
      !values.has('net')
    )
      unavailable('finance-cash-dividend-replay-amounts-unavailable');
    return {
      ...row,
      grossFunctionalAmount: values.get('gross')!,
      withholdingFunctionalAmount: values.get('withholding')!,
      netFunctionalAmount: values.get('net')!,
    };
  }

  private async replayDividendResult(
    context: WorkspaceContext,
    bookId: string,
    row: DividendActionRow,
  ): Promise<FinanceCashDividendCommitResult> {
    return FinanceCashDividendCommitResultSchema.parse({
      actionId: row.id,
      workspaceId: context.workspaceId,
      bookId,
      sourceRowId: row.sourceRowId,
      sourceRevision: row.sourceRevision,
      nextSourceRevision: row.sourceRevision + 1,
      sourceSnapshotHash: row.sourceSnapshotHash,
      economicTransactionId: row.economicTransactionId,
      journalId: row.journalId,
      grossFunctionalAmount: row.grossFunctionalAmount,
      withholdingFunctionalAmount: row.withholdingFunctionalAmount,
      netFunctionalAmount: row.netFunctionalAmount,
      status: 'committed',
      replayed: true,
    });
  }

  private async validateDividendAccounts(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    action: CommitInvestmentCashDividend['action'],
    source: FinanceCashDividendSourceSnapshot,
  ): Promise<void> {
    if (action.ledger.cashLedgerAccountId !== source.financialAccountLedgerId)
      conflict('finance-cash-dividend-cash-ledger-mismatch');
    const ids = [
      action.ledger.cashLedgerAccountId,
      action.ledger.dividendIncomeLedgerAccountId,
      action.ledger.withholdingLedgerAccountId,
    ];
    const rows = (
      await client.query(
        `select id,kind,active
           from emdo.finance_ledger_accounts
          where workspace_id=$1 and book_id=$2 and id=any($3::uuid[])`,
        [context.workspaceId, bookId, ids],
      )
    ).rows;
    if (
      rows.length !== ids.length ||
      rows.some((row) => row.active !== true) ||
      new Set(rows.map((row) => String(row.id))).size !== ids.length
    )
      conflict('finance-cash-dividend-ledger-account-unavailable');
    const cash = rows.find(
      (row) => String(row.id) === action.ledger.cashLedgerAccountId,
    );
    const income = rows.find(
      (row) => String(row.id) === action.ledger.dividendIncomeLedgerAccountId,
    );
    if (String(cash?.kind) !== 'asset' || String(income?.kind) !== 'income')
      conflict('finance-cash-dividend-ledger-account-kind-mismatch');
  }

  private async insertDividendJournal(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    action: CommitInvestmentCashDividend['action'],
    plan: ReturnType<typeof planInvestmentCashDividend>,
  ): Promise<string> {
    const book = await this.book(client, context, bookId);
    const journalInput = {
      effectiveOn: action.payableOn,
      description: `Cash dividend · ${action.sourceReference}`.slice(0, 500),
      sourceReference: `investment-cash-dividend:${action.id}`,
      lines: plan.journalLines.map(({ kind: _kind, ...line }) => ({
        ...line,
        description: `${action.sourceReference} · ${_kind}`.slice(0, 500),
      })),
    };
    const validated = validateJournal(
      journalInput,
      String(book.functional_currency) as Parameters<typeof validateJournal>[1],
    );
    const period = (
      await client.query(
        `select id from emdo.finance_periods
          where workspace_id=$1 and book_id=$2 and status='open'
            and $3::date between starts_on and ends_on`,
        [context.workspaceId, bookId, validated.effectiveOn],
      )
    ).rows[0];
    if (!period) conflict('finance-open-period-required');
    const journalId = randomUUID();
    await client.query(
      `insert into emdo.finance_journals
         (id,workspace_id,book_id,effective_on,description,source_reference,
          period_id,idempotency_key,payload_hash,created_by)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        journalId,
        context.workspaceId,
        bookId,
        validated.effectiveOn,
        validated.description,
        validated.sourceReference,
        period.id,
        `cash-dividend:${action.id}`,
        hashJson(validated),
        context.userId,
      ],
    );
    for (const [index, line] of validated.lines.entries())
      await client.query(
        `insert into emdo.finance_journal_lines
           (workspace_id,book_id,journal_id,account_id,line_number,side,amount,
            currency,native_amount,fx_rate,fx_source,description)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          context.workspaceId,
          bookId,
          journalId,
          line.accountId,
          index + 1,
          line.side,
          line.amount,
          line.currency,
          line.nativeAmount,
          line.fxRate,
          line.fxSource,
          line.description,
        ],
      );
    await client.query(
      `update emdo.finance_journals
          set status='posted',posted_at=clock_timestamp()
        where workspace_id=$1 and book_id=$2 and id=$3`,
      [context.workspaceId, bookId, journalId],
    );
    return journalId;
  }

  private async sourceLots(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    action: CommitInvestmentStockSplit['action'],
  ): Promise<SourceLot[]> {
    const ordered = (
      await client.query(
        `select exists(
           select 1
             from emdo.finance_investment_corporate_actions
            where workspace_id=$1 and book_id=$2
              and financial_account_id=$3 and instrument_id=$4
              and status='committed' and effective_on >= $5
         ) as "hasOutOfOrderAction"`,
        [
          context.workspaceId,
          bookId,
          action.financialAccountId,
          action.instrumentId,
          action.effectiveOn,
        ],
      )
    ).rows[0];
    if (ordered?.hasOutOfOrderAction === true)
      conflict('finance-corporate-action-source-action-order-conflict');

    const rows = (
      await client.query(
        `with source_state as (
           select l.id,
                  m.financial_account_id as "financialAccountId",
                  m.instrument_id as "instrumentId",
                  m.effective_on::text as "acquiredOn",
                  l.acquisition_sequence as "acquisitionSequence",
                  coalesce(cal.quantity,e.successor_quantity,m.quantity)::text as "originalQuantity",
                  l.native_currency as "nativeCurrency",
                  coalesce(cal.native_cost,e.successor_native_cost_basis,l.native_cost)::text as "originalNativeCost",
                  coalesce(cal.functional_cost,e.successor_functional_cost_basis,l.functional_cost)::text as "originalFunctionalCost",
                  b.functional_currency as "functionalCurrency",
                  l.source_reference as "sourceReference",
                  ca.effective_on as "actionEffectiveOn"
             from emdo.finance_investment_lots l
             join emdo.finance_investment_movements m
               on m.workspace_id=l.workspace_id and m.book_id=l.book_id and m.id=l.movement_id
             join emdo.finance_books b
               on b.workspace_id=l.workspace_id and b.id=l.book_id
             left join lateral (
               select ca.id,ca.effective_on
                 from emdo.finance_investment_corporate_actions ca
               where ca.workspace_id=l.workspace_id and ca.book_id=l.book_id
                  and ca.financial_account_id=m.financial_account_id
                  and ca.instrument_id=m.instrument_id and ca.status='committed'
                  and ca.effective_on >= m.effective_on
                  and ca.effective_on < $5
                order by ca.effective_on desc,ca.created_at desc,ca.id desc
                limit 1
             ) ca on true
             left join emdo.finance_investment_corporate_action_effects e
               on e.workspace_id=l.workspace_id and e.book_id=l.book_id
              and e.action_id=ca.id and e.source_lot_id=l.id
             left join emdo.finance_investment_corporate_action_lots cal
               on cal.workspace_id=e.workspace_id and cal.book_id=e.book_id
              and cal.action_id=e.action_id and cal.source_lot_id=e.source_lot_id
            where l.workspace_id=$1 and l.book_id=$2
              and m.financial_account_id=$3 and m.instrument_id=$4
         )
         select s.id,s."financialAccountId",s."instrumentId",s."acquiredOn",
                s."acquisitionSequence",s."originalQuantity",s."originalNativeCost",
                s."originalFunctionalCost",s."nativeCurrency",s."functionalCurrency",
                s."sourceReference",
                coalesce(sum(a.quantity) filter (where dm.effective_on < $5 and (s."actionEffectiveOn" is null or dm.effective_on >= s."actionEffectiveOn")),0)::text as "disposedQuantity",
                coalesce(sum(a.native_cost) filter (where dm.effective_on < $5 and (s."actionEffectiveOn" is null or dm.effective_on >= s."actionEffectiveOn")),0)::text as "allocatedNativeCost",
                coalesce(sum(a.functional_cost) filter (where dm.effective_on < $5 and (s."actionEffectiveOn" is null or dm.effective_on >= s."actionEffectiveOn")),0)::text as "allocatedFunctionalCost",
                bool_or(dm.effective_on >= $5) as "hasAfterDisposal"
           from source_state s
           left join emdo.finance_lot_allocations a
             on a.workspace_id=$1 and a.book_id=$2 and a.lot_id=s.id
           left join emdo.finance_lot_disposals d
             on d.workspace_id=a.workspace_id and d.book_id=a.book_id and d.id=a.disposal_id
           left join emdo.finance_investment_movements dm
             on dm.workspace_id=d.workspace_id and dm.book_id=d.book_id and dm.id=d.movement_id
          where s."originalQuantity"::numeric > 0
          group by s.id,s."financialAccountId",s."instrumentId",s."acquiredOn",
                   s."acquisitionSequence",s."originalQuantity",s."originalNativeCost",
                   s."originalFunctionalCost",s."nativeCurrency",s."functionalCurrency",
                   s."sourceReference",s."actionEffectiveOn"
          order by s."acquiredOn",s."acquisitionSequence",s.id`,
        [
          context.workspaceId,
          bookId,
          action.financialAccountId,
          action.instrumentId,
          action.effectiveOn,
        ],
      )
    ).rows;
    if (rows.length === 0)
      conflict('finance-corporate-action-source-lots-empty');
    if (rows.some((row) => row.hasAfterDisposal === true))
      conflict('finance-corporate-action-source-after-action-disposal');
    return sortLots(rows.map(sourceLotFromRow));
  }

  private async replayResult(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    row: ActionRow,
  ) {
    const successors = (
      await client.query(
        `select id
           from emdo.finance_investment_corporate_action_lots
          where workspace_id=$1 and book_id=$2 and action_id=$3
          order by successor_lot_key,id`,
        [context.workspaceId, bookId, row.id],
      )
    ).rows.map((value) => UuidSchema.parse(String(value.id)));
    const effects = (
      await client.query(
        `select count(*)::int as count
           from emdo.finance_investment_corporate_action_effects
          where workspace_id=$1 and book_id=$2 and action_id=$3`,
        [context.workspaceId, bookId, row.id],
      )
    ).rows[0];
    const effectCount = Number(effects?.count);
    if (!Number.isSafeInteger(effectCount) || effectCount < 1)
      unavailable('finance-corporate-action-replay-effects-unavailable');
    return FinanceStockSplitCommitResultSchema.parse({
      actionId: row.id,
      workspaceId: context.workspaceId,
      bookId,
      sourceRevision: row.sourceRevision,
      nextSourceRevision: row.sourceRevision + 1,
      sourceSnapshotHash: row.sourceSnapshotHash,
      successorLotIds: successors,
      effectCount,
      status: 'committed',
      replayed: true,
    });
  }

  /**
   * Commits a previously reviewed planner result using compare-and-swap on
   * the exact source lot revision. The action is intentionally separate from
   * finance_investment_lots: the source history stays immutable, while the
   * finance_investment_lot_positions view exposes successors as the active
   * nodes consumed by lot readers and disposal allocation.
   */
  commitInvestmentStockSplit(
    context: WorkspaceContext,
    bookId: string,
    input: unknown,
  ) {
    const data = CommitInvestmentStockSplitSchema.parse(input);
    UuidSchema.parse(bookId);
    const action = canonicalAction(data);
    const inputLots = sortLots(data.sourceLots.map(canonicalLot));
    const commandHash = hashJson({
      bookId,
      action,
      sourceAsOf: data.sourceAsOf,
      sourceBoundary: data.sourceBoundary,
      sourceLots: inputLots,
    });
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      // Existing lot/disposal writes take this same book lock in their
      // insert triggers. The CAS revision below is therefore a serialization
      // point for every source-lot mutation, including legacy writers.
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${context.workspaceId}:${bookId}`],
      );
      const existing = await this.existingAction(
        client,
        context,
        bookId,
        action.id,
        data.idempotencyKey,
        commandHash,
      );
      if (existing)
        return this.replayResult(client, context, bookId, existing.result);

      const revision = await this.currentRevision(client, context, bookId);
      if (revision.revision !== data.expectedSourceRevision)
        conflict('finance-corporate-action-source-revision-conflict');

      const currentLots = await this.sourceLots(
        client,
        context,
        bookId,
        action,
      );
      const sourceSnapshotHash = hashJson(currentLots);
      if (JSON.stringify(currentLots) !== JSON.stringify(inputLots))
        conflict('finance-corporate-action-source-snapshot-conflict');
      if (!SHA256.test(sourceSnapshotHash))
        unavailable('finance-corporate-action-source-snapshot-hash-invalid');

      // The domain planner is the sole authority for quantity and basis
      // mechanics. In particular, it blocks unknown fractions and cash-in-lieu
      // until a supported basis allocation workflow exists.
      const plan = planInvestmentStockSplit({
        action,
        sourceAsOf: data.sourceAsOf,
        sourceBoundary: data.sourceBoundary,
        sourceLots: currentLots,
      });
      if (plan.commitReadiness !== 'ready')
        conflict(
          `finance-corporate-action-not-ready:${plan.blockedReasons.join(',')}`,
        );
      if (action.cashInLieu !== null)
        conflict('finance-corporate-action-cash-in-lieu-unsupported');

      const actionId = UuidSchema.parse(action.id);
      await client.query(
        `insert into emdo.finance_investment_corporate_actions
          (id,workspace_id,book_id,action_type,financial_account_id,instrument_id,
           effective_on,numerator,denominator,fractional_treatment,evidence_id,
           source_reference,cash_in_lieu,source_as_of,source_boundary,source_revision,
           source_snapshot_hash,idempotency_key,command_hash,status,created_by)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,'committed',$20)`,
        [
          actionId,
          context.workspaceId,
          bookId,
          action.actionType,
          action.financialAccountId,
          action.instrumentId,
          action.effectiveOn,
          action.numerator,
          action.denominator,
          action.fractionalTreatment,
          action.evidenceId,
          action.sourceReference,
          action.cashInLieu === null ? null : JSON.stringify(action.cashInLieu),
          data.sourceAsOf,
          data.sourceBoundary,
          revision.revision,
          sourceSnapshotHash,
          data.idempotencyKey,
          commandHash,
          context.userId,
        ],
      );

      const successorLotIds: string[] = [];
      for (const effect of plan.effects) {
        const successor = effect.successorLot;
        let successorLotId: string | null = null;
        if (successor !== null) {
          successorLotId = uuidFromSeed(
            `${context.workspaceId}:${bookId}:corporate-action:${actionId}:successor:${effect.sourceLotId}`,
          );
          successorLotIds.push(successorLotId);
          await client.query(
            `insert into emdo.finance_investment_corporate_action_lots
              (id,workspace_id,book_id,action_id,source_lot_id,successor_lot_key,
               financial_account_id,instrument_id,acquired_on,acquisition_sequence,
               quantity,native_cost,functional_cost,native_currency,functional_currency,
               source_reference)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [
              successorLotId,
              context.workspaceId,
              bookId,
              actionId,
              successor.sourceLotId,
              successor.successorLotKey,
              successor.financialAccountId,
              successor.instrumentId,
              successor.acquiredOn,
              successor.acquisitionSequence,
              successor.originalQuantity,
              successor.originalNativeCost,
              successor.originalFunctionalCost,
              successor.nativeCurrency,
              successor.functionalCurrency,
              successor.sourceReference,
            ],
          );
        }
        const effectId = uuidFromSeed(
          `${context.workspaceId}:${bookId}:corporate-action:${actionId}:effect:${effect.sourceLotId}`,
        );
        await client.query(
          `insert into emdo.finance_investment_corporate_action_effects
            (id,workspace_id,book_id,action_id,source_lot_id,successor_lot_id,
             financial_account_id,instrument_id,source_original_quantity,
             source_disposed_quantity,source_remaining_quantity,source_native_cost_basis,
             source_functional_cost_basis,successor_quantity,successor_native_cost_basis,
             successor_functional_cost_basis)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            effectId,
            context.workspaceId,
            bookId,
            actionId,
            effect.sourceLotId,
            successorLotId,
            effect.financialAccountId,
            effect.instrumentId,
            effect.sourceOriginalQuantity,
            effect.sourceDisposedQuantity,
            effect.sourceRemainingQuantity,
            effect.sourceNativeCostBasis,
            effect.sourceFunctionalCostBasis,
            effect.successorQuantity ?? '0',
            effect.successorNativeCostBasis,
            effect.successorFunctionalCostBasis,
          ],
        );
      }

      const next = (
        await client.query(
          `select revision
             from emdo.finance_investment_lot_revisions
            where workspace_id=$1 and book_id=$2`,
          [context.workspaceId, bookId],
        )
      ).rows[0];
      const nextRevision = Number(next?.revision);
      if (nextRevision !== revision.revision + 1)
        conflict('finance-corporate-action-source-revision-advance-invalid');

      // Keep this read in the transaction so the result proves the exact
      // action/effect set that was committed under the source lock.
      return FinanceStockSplitCommitResultSchema.parse({
        actionId,
        workspaceId: context.workspaceId,
        bookId,
        sourceRevision: revision.revision,
        nextSourceRevision: nextRevision,
        sourceSnapshotHash,
        successorLotIds,
        effectCount: plan.effects.length,
        status: 'committed',
        replayed: false,
      });
    });
  }
  getInvestmentStockSplitSettlement(
    context: WorkspaceContext,
    bookId: string,
    settlementId: string,
  ) {
    UuidSchema.parse(settlementId);
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId, true);
      const row = (
        await client.query(
          `select result,proof,proof_hash,created_at from emdo.finance_investment_corporate_action_settlements where workspace_id=$1 and book_id=$2 and id=$3`,
          [context.workspaceId, bookId, settlementId],
        )
      ).rows[0];
      if (!row) return null;
      if (
        row.proof === null ||
        typeof row.proof !== 'object' ||
        hashSettlementProof(row.proof) !== row.proof_hash
      )
        unavailable('finance-settlement-proof-unavailable');
      const journals = (row.proof as Record<string, unknown>).journals;
      if (journals === null || typeof journals !== 'object')
        unavailable('finance-settlement-accounting-proof-unavailable');
      const storedAccounting = journals as Record<string, unknown>;
      const accounting =
        FinanceStockSplitSettlementAccountingSummarySchema.safeParse({
          actionDateFunctionalConsideration:
            storedAccounting.actionDateFunctionalConsideration,
          settlementDateFunctionalConsideration:
            storedAccounting.settlementDateFunctionalConsideration,
          bookGainLoss: storedAccounting.bookGainLoss,
          fxGainLoss: storedAccounting.fxGainLoss,
        });
      if (!accounting.success)
        unavailable('finance-settlement-accounting-proof-unavailable');
      const saved = SavedFinanceStockSplitSettlementSchema.parse({
        result: row.result,
        accounting: accounting.data,
        settlement: (row.proof as Record<string, unknown>).settlement,
        createdAt: rowString(row, 'created_at'),
      });
      if (
        saved.result.workspaceId !== context.workspaceId ||
        saved.result.bookId !== bookId ||
        saved.result.settlementId !== settlementId ||
        saved.settlement.actionId !== saved.result.actionId
      )
        unavailable('finance-settlement-proof-scope-mismatch');
      return saved;
    });
  }

  async checkStockSplitSettlementReady(): Promise<boolean> {
    let client: DatabaseClient | undefined;
    try {
      client = await this.pool.connect();
      const result = await client.query(
        `select
        not r.rolsuper and not r.rolbypassrls and
        (select count(*)=3 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='emdo' and c.relname=any($1::text[]) and c.relrowsecurity and c.relforcerowsecurity) and
        (select count(*)=3 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='emdo' and c.relname=any($1::text[]) and t.tgname='settlement_immutable' and t.tgenabled='O') and
        (select count(*)=4 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='emdo' and c.relname=any($1::text[]) and t.tgname in ('settlement_binding','settlement_evidence_binding','settlement_allocation_binding','settlement_complete') and t.tgenabled='O') and exists(select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='emdo' and c.relname='finance_normalized_import_rows' and t.tgname='settlement_receipt_complete' and t.tgenabled='O') as ready
        from pg_roles r where r.rolname=current_user`,
        [
          [
            'finance_investment_corporate_action_settlements',
            'finance_investment_corporate_action_settlement_evidence',
            'finance_investment_corporate_action_settlement_allocations',
          ],
        ],
      );
      return result.rows[0]?.ready === true;
    } catch {
      return false;
    } finally {
      client?.release();
    }
  }

  /** Commits reviewed exact allocations, receipt claim, and journals atomically. */
  commitInvestmentStockSplitSettlement(
    context: WorkspaceContext,
    bookId: string,
    input: unknown,
  ) {
    const data = CommitInvestmentStockSplitSettlementSchema.parse(input);
    UuidSchema.parse(bookId);
    const action = FinanceStockSplitActionSchema.parse(
      data.settlement.source.action,
    );
    const commandHash = hashSettlementProof(data);
    return this.transaction(context, async (client) => {
      const book = await this.book(client, context, bookId);
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${context.workspaceId}:${bookId}`],
      );
      const prior = (
        await client.query(
          `select s.command_hash,s.result,s.proof,s.proof_hash
        from emdo.finance_investment_corporate_action_settlements s
        join emdo.finance_investment_corporate_actions a on a.workspace_id=s.workspace_id and a.book_id=s.book_id and a.id=s.action_id
        where s.workspace_id=$1 and s.book_id=$2 and (a.idempotency_key=$3 or a.id=$4 or s.source_row_id=$5)`,
          [
            context.workspaceId,
            bookId,
            data.idempotencyKey,
            action.id,
            data.receipt.sourceRowId,
          ],
        )
      ).rows;
      if (prior.length) {
        if (prior.length !== 1 || prior[0]!.command_hash !== commandHash)
          conflict('finance-settlement-idempotency-conflict');
        // Canonical hashing survives PostgreSQL JSONB object-key ordering.
        const saved = prior[0]!;
        if (
          typeof saved.proof !== 'object' ||
          saved.proof === null ||
          hashSettlementProof(saved.proof) !== saved.proof_hash
        )
          unavailable('finance-settlement-proof-unavailable');
        return FinanceStockSplitSettlementCommitResultSchema.parse({
          ...(saved.result as object),
          replayed: true,
        });
      }
      const revision = await this.currentRevision(client, context, bookId);
      if (revision.revision !== data.expectedSourceRevision)
        conflict('finance-corporate-action-source-revision-conflict');
      const currentLots = await this.sourceLots(
        client,
        context,
        bookId,
        action,
      );
      const sourceSnapshotHash = hashJson(currentLots);
      if (
        sourceSnapshotHash !== data.sourceSnapshotHash ||
        JSON.stringify(currentLots) !==
          JSON.stringify(
            sortLots(data.settlement.source.sourceLots.map(canonicalLot)),
          )
      )
        conflict('finance-corporate-action-source-snapshot-conflict');
      const settlement = planInvestmentStockSplitSettlement({
        ...data.settlement,
        source: { ...data.settlement.source, sourceLots: currentLots },
      });
      const journals = planStockSplitSettlementJournals({
        settlement,
        ledger: data.ledger,
        actionDateConsideration: data.actionDateConsideration,
      });
      const requiredEvidence = [
        ...new Set([
          action.evidenceId,
          settlement.cashConsideration.evidenceId,
          settlement.allocationReview.evidenceId,
          ...(data.actionDateConsideration
            ? [data.actionDateConsideration.evidenceId]
            : []),
        ]),
      ].sort();
      const suppliedEvidence = data.evidenceHashes
        .map((e) => e.evidenceId)
        .sort();
      if (JSON.stringify(requiredEvidence) !== JSON.stringify(suppliedEvidence))
        conflict('finance-settlement-evidence-set-mismatch');
      for (const evidence of data.evidenceHashes) {
        const row = (
          await client.query(
            'select plaintext_sha256 from emdo.finance_book_evidence where workspace_id=$1 and book_id=$2 and id=$3',
            [context.workspaceId, bookId, evidence.evidenceId],
          )
        ).rows[0];
        if (!row || row.plaintext_sha256 !== evidence.sha256)
          conflict('finance-settlement-evidence-hash-conflict');
      }
      const sourceRequest: ReadInvestmentCashDividendSource = {
        sourceRowId: data.receipt.sourceRowId,
        financialAccountId: action.financialAccountId,
        instrumentId: action.instrumentId,
        evidenceId: settlement.cashConsideration.evidenceId,
      };
      const row = (
        await client.query(
          `select r.id as "sourceRowId",r.batch_id as "batchId",r.source_row as "sourceRow",
                  r.status,r.revision,r.effective_on::text as "effectiveOn",
                  r.description,r.external_id as "externalId",
                  r.native_amount::text as "nativeAmount",r.issues,
                  r.fx_rate::text as "fxRate",r.fx_source as "fxSource",
                  i.evidence_id as "evidenceId",
                  i.financial_account_id as "financialAccountId",
                  a.currency,a.ledger_account_id as "financialAccountLedgerId",
                  b.functional_currency as "functionalCurrency"
             from emdo.finance_normalized_import_rows r
             join emdo.finance_normalized_imports i
               on i.workspace_id=r.workspace_id and i.book_id=r.book_id
              and i.id=r.batch_id
             join emdo.finance_financial_accounts a
               on a.workspace_id=i.workspace_id and a.book_id=i.book_id
              and a.id=i.financial_account_id and a.active
             join emdo.finance_books b
               on b.workspace_id=r.workspace_id and b.id=r.book_id
             join emdo.finance_book_evidence e
               on e.workspace_id=i.workspace_id and e.book_id=i.book_id
              and e.id=i.evidence_id
            where r.workspace_id=$1 and r.book_id=$2 and r.id=$3
              and i.financial_account_id=$4 and i.evidence_id=$5
              and exists (
                select 1 from emdo.finance_instruments ins
                 where ins.workspace_id=r.workspace_id and ins.book_id=r.book_id
                   and ins.id=$6
              )`,
          [
            context.workspaceId,
            bookId,
            sourceRequest.sourceRowId,
            sourceRequest.financialAccountId,
            sourceRequest.evidenceId,
            sourceRequest.instrumentId,
          ],
        )
      ).rows[0] as SourceLotRow | undefined;

      const sourceRow =
        row ?? unavailable('finance-settlement-receipt-unavailable');
      const receipt = dividendSourceSnapshot(sourceRow, sourceRequest);
      if (
        receipt.sourceRevision !== data.receipt.expectedRevision ||
        receipt.sourceSnapshotHash !== data.receipt.snapshotHash
      )
        conflict('finance-settlement-receipt-revision-conflict');
      const cash = settlement.cashConsideration;
      if (
        receipt.status !== 'ready' ||
        receipt.issues.length ||
        receipt.effectiveOn !== cash.settledOn ||
        receipt.nativeAmount === null ||
        parseFinanceDecimal(receipt.nativeAmount) !==
          parseFinanceDecimal(cash.native.amount) ||
        receipt.currency !== cash.native.currency ||
        receipt.functionalCurrency !== cash.functional.currency ||
        receipt.financialAccountLedgerId !== data.ledger.cashLedgerAccountId
      )
        conflict('finance-settlement-receipt-mismatch');
      if (
        cash.native.currency !== cash.functional.currency &&
        (receipt.fxRate === null ||
          cash.fx === null ||
          parseFinanceDecimal(receipt.fxRate) !==
            parseFinanceDecimal(cash.fx.rate) ||
          receipt.fxSource !== cash.fx.source)
      )
        conflict('finance-settlement-receipt-fx-mismatch');
      const accountKinds: Record<string, string> = {
        cashLedgerAccountId: 'asset',
        investmentLedgerAccountId: 'asset',
        gainLedgerAccountId: 'income',
        lossLedgerAccountId: 'expense',
        receivableLedgerAccountId: 'asset',
        fxGainLedgerAccountId: 'income',
        fxLossLedgerAccountId: 'expense',
      };
      for (const [key, id] of Object.entries(data.ledger)) {
        if (id === null) continue;
        const account = (
          await client.query(
            'select kind from emdo.finance_ledger_accounts where workspace_id=$1 and book_id=$2 and id=$3 and active',
            [context.workspaceId, bookId, id],
          )
        ).rows[0];
        if (!account || account.kind !== accountKinds[key])
          conflict('finance-settlement-ledger-account-mismatch');
      }
      // No rational is rounded or floored for a numeric successor projection.
      const exactQuantity = (q: { numerator: string; denominator: string }) => {
        const scaled = BigInt(q.numerator) * 1000000000000n,
          denominator = BigInt(q.denominator);
        if (scaled % denominator !== 0n)
          conflict('finance-settlement-retained-quantity-not-representable');
        if (scaled / denominator >= 10n ** 38n)
          conflict('finance-settlement-retained-quantity-overflow');
        return formatFinanceDecimal(scaled / denominator);
      };
      const allocations = new Map(
        settlement.allocations.map((a) => [a.sourceLotId, a]),
      );
      const plan = {
        effects: currentLots.map((lot) => {
          const allocation = allocations.get(lot.id) ?? {
            retainedQuantity: { numerator: '0', denominator: '1' },
            retainedNativeCost: '0',
            retainedFunctionalCost: '0',
          };
          const qty = exactQuantity(allocation.retainedQuantity);
          return {
            sourceLotId: lot.id,
            financialAccountId: lot.financialAccountId,
            instrumentId: lot.instrumentId,
            sourceOriginalQuantity: lot.originalQuantity,
            sourceDisposedQuantity: lot.disposedQuantity,
            sourceRemainingQuantity: formatFinanceDecimal(
              parseFinanceDecimal(lot.originalQuantity) -
                parseFinanceDecimal(lot.disposedQuantity),
            ),
            sourceNativeCostBasis: formatFinanceDecimal(
              parseFinanceDecimal(lot.originalNativeCost) -
                parseFinanceDecimal(lot.allocatedNativeCost),
            ),
            sourceFunctionalCostBasis: formatFinanceDecimal(
              parseFinanceDecimal(lot.originalFunctionalCost) -
                parseFinanceDecimal(lot.allocatedFunctionalCost),
            ),
            successorQuantity: qty,
            successorNativeCostBasis: allocation.retainedNativeCost,
            successorFunctionalCostBasis: allocation.retainedFunctionalCost,
            successorLot:
              parseFinanceDecimal(qty) === 0n
                ? null
                : {
                    ...lot,
                    sourceLotId: lot.id,
                    successorLotKey: `${action.id}:${lot.id}`,
                    originalQuantity: qty,
                    originalNativeCost: allocation.retainedNativeCost,
                    originalFunctionalCost: allocation.retainedFunctionalCost,
                  },
          };
        }),
      };
      const journalIds: string[] = [];
      for (const item of journals.journals) {
        const validated = validateJournal(
          item.journal,
          String(book.functional_currency) as Parameters<
            typeof validateJournal
          >[1],
        );
        const period = (
          await client.query(
            `select id from emdo.finance_periods where workspace_id=$1 and book_id=$2 and status='open' and $3::date between starts_on and ends_on`,
            [context.workspaceId, bookId, validated.effectiveOn],
          )
        ).rows[0];
        if (!period) conflict('finance-open-period-required');
        const journalId = randomUUID();
        journalIds.push(journalId);
        await client.query(
          `insert into emdo.finance_journals(id,workspace_id,book_id,effective_on,description,source_reference,period_id,idempotency_key,payload_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            journalId,
            context.workspaceId,
            bookId,
            validated.effectiveOn,
            validated.description,
            validated.sourceReference,
            period.id,
            `cash-in-lieu:${action.id}:${item.kind}`,
            hashJson(validated),
            context.userId,
          ],
        );
        for (const [index, line] of validated.lines.entries())
          await client.query(
            `insert into emdo.finance_journal_lines(workspace_id,book_id,journal_id,account_id,line_number,side,amount,currency,native_amount,fx_rate,fx_source,description) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              context.workspaceId,
              bookId,
              journalId,
              line.accountId,
              index + 1,
              line.side,
              line.amount,
              line.currency,
              line.nativeAmount,
              line.fxRate,
              line.fxSource,
              line.description,
            ],
          );
        await client.query(
          `update emdo.finance_journals set status='posted',posted_at=clock_timestamp() where workspace_id=$1 and book_id=$2 and id=$3`,
          [context.workspaceId, bookId, journalId],
        );
      }
      const actionId = UuidSchema.parse(action.id);
      await client.query(
        `insert into emdo.finance_investment_corporate_actions
          (id,workspace_id,book_id,action_type,financial_account_id,instrument_id,
           effective_on,numerator,denominator,fractional_treatment,evidence_id,
           source_reference,cash_in_lieu,source_as_of,source_boundary,source_revision,
           source_snapshot_hash,idempotency_key,command_hash,status,created_by)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,'committed',$20)`,
        [
          actionId,
          context.workspaceId,
          bookId,
          action.actionType,
          action.financialAccountId,
          action.instrumentId,
          action.effectiveOn,
          action.numerator,
          action.denominator,
          action.fractionalTreatment,
          action.evidenceId,
          action.sourceReference,
          action.cashInLieu === null ? null : JSON.stringify(action.cashInLieu),
          data.settlement.source.sourceAsOf,
          data.settlement.source.sourceBoundary,
          revision.revision,
          sourceSnapshotHash,
          data.idempotencyKey,
          commandHash,
          context.userId,
        ],
      );

      const successorLotIds: string[] = [];
      for (const effect of plan.effects) {
        const successor = effect.successorLot;
        let successorLotId: string | null = null;
        if (successor !== null) {
          successorLotId = uuidFromSeed(
            `${context.workspaceId}:${bookId}:corporate-action:${actionId}:successor:${effect.sourceLotId}`,
          );
          successorLotIds.push(successorLotId);
          await client.query(
            `insert into emdo.finance_investment_corporate_action_lots
              (id,workspace_id,book_id,action_id,source_lot_id,successor_lot_key,
               financial_account_id,instrument_id,acquired_on,acquisition_sequence,
               quantity,native_cost,functional_cost,native_currency,functional_currency,
               source_reference)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [
              successorLotId,
              context.workspaceId,
              bookId,
              actionId,
              successor.sourceLotId,
              successor.successorLotKey,
              successor.financialAccountId,
              successor.instrumentId,
              successor.acquiredOn,
              successor.acquisitionSequence,
              successor.originalQuantity,
              successor.originalNativeCost,
              successor.originalFunctionalCost,
              successor.nativeCurrency,
              successor.functionalCurrency,
              successor.sourceReference,
            ],
          );
        }
        const effectId = uuidFromSeed(
          `${context.workspaceId}:${bookId}:corporate-action:${actionId}:effect:${effect.sourceLotId}`,
        );
        await client.query(
          `insert into emdo.finance_investment_corporate_action_effects
            (id,workspace_id,book_id,action_id,source_lot_id,successor_lot_id,
             financial_account_id,instrument_id,source_original_quantity,
             source_disposed_quantity,source_remaining_quantity,source_native_cost_basis,
             source_functional_cost_basis,successor_quantity,successor_native_cost_basis,
             successor_functional_cost_basis)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            effectId,
            context.workspaceId,
            bookId,
            actionId,
            effect.sourceLotId,
            successorLotId,
            effect.financialAccountId,
            effect.instrumentId,
            effect.sourceOriginalQuantity,
            effect.sourceDisposedQuantity,
            effect.sourceRemainingQuantity,
            effect.sourceNativeCostBasis,
            effect.sourceFunctionalCostBasis,
            effect.successorQuantity ?? '0',
            effect.successorNativeCostBasis,
            effect.successorFunctionalCostBasis,
          ],
        );
      }

      const economicTransactionId = randomUUID();
      await client.query(
        `insert into emdo.finance_economic_transactions(id,workspace_id,book_id,financial_account_id,effective_on,description,native_amount,functional_amount,fx_rate,fx_source,journal_id,fingerprint,facts_hash,external_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          economicTransactionId,
          context.workspaceId,
          bookId,
          action.financialAccountId,
          cash.settledOn,
          cash.sourceReference,
          cash.native.amount,
          cash.functional.amount,
          cash.fx?.rate ?? '1',
          cash.fx?.source ?? 'same-currency',
          journalIds.at(-1),
          hashJson([
            'cash-in-lieu',
            context.workspaceId,
            bookId,
            receipt.sourceRowId,
          ]),
          hashJson({ settlement, receipt, journals }),
          cash.sourceReference,
        ],
      );
      await client.query(
        `insert into emdo.finance_import_row_reviews(workspace_id,book_id,row_id,revision,decision,previous_facts,reviewed_by) values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
        [
          context.workspaceId,
          bookId,
          receipt.sourceRowId,
          receipt.sourceRevision + 1,
          JSON.stringify({
            action: 'cash-in-lieu',
            reason: settlement.allocationReview.sourceReference,
            actionId,
            sourceSnapshotHash: receipt.sourceSnapshotHash,
          }),
          JSON.stringify({
            date: receipt.effectiveOn,
            description: receipt.description,
            amount: receipt.nativeAmount,
            externalId: rowNullableString(sourceRow, 'externalId'),
          }),
          context.userId,
        ],
      );
      const claimed = await client.query(
        `update emdo.finance_normalized_import_rows set status='committed',economic_transaction_id=$4,revision=revision+1 where workspace_id=$1 and book_id=$2 and id=$3 and revision=$5 and status='ready'`,
        [
          context.workspaceId,
          bookId,
          receipt.sourceRowId,
          economicTransactionId,
          receipt.sourceRevision,
        ],
      );
      if (claimed.rowCount !== 1)
        conflict('finance-settlement-receipt-revision-conflict');
      const nextRevision = (await this.currentRevision(client, context, bookId))
        .revision;
      if (nextRevision !== revision.revision + 1)
        conflict('finance-corporate-action-source-revision-advance-invalid');
      const settlementId = randomUUID();
      const result = FinanceStockSplitSettlementCommitResultSchema.parse({
        actionId,
        workspaceId: context.workspaceId,
        bookId,
        sourceRevision: revision.revision,
        nextSourceRevision: nextRevision,
        sourceSnapshotHash,
        successorLotIds,
        effectCount: plan.effects.length,
        settlementId,
        economicTransactionId,
        journalIds,
        status: 'committed',
        replayed: false,
      });
      const proof = {
        settlement,
        journals,
        receipt,
        evidenceHashes: data.evidenceHashes,
        sourceLots: currentLots,
      };
      await client.query(
        `insert into emdo.finance_investment_corporate_action_settlements(id,workspace_id,book_id,action_id,source_row_id,receipt_revision,receipt_snapshot_hash,economic_transaction_id,action_journal_id,receipt_journal_id,command_hash,proof,proof_hash,result,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15)`,
        [
          settlementId,
          context.workspaceId,
          bookId,
          actionId,
          receipt.sourceRowId,
          receipt.sourceRevision,
          receipt.sourceSnapshotHash,
          economicTransactionId,
          journalIds[0],
          journalIds.at(-1),
          commandHash,
          JSON.stringify(proof),
          hashSettlementProof(proof),
          JSON.stringify(result),
          context.userId,
        ],
      );
      for (const evidence of data.evidenceHashes)
        await client.query(
          `insert into emdo.finance_investment_corporate_action_settlement_evidence(workspace_id,book_id,settlement_id,evidence_id,plaintext_sha256) values($1,$2,$3,$4,$5)`,
          [
            context.workspaceId,
            bookId,
            settlementId,
            evidence.evidenceId,
            evidence.sha256,
          ],
        );
      for (const allocation of settlement.allocations)
        await client.query(
          `insert into emdo.finance_investment_corporate_action_settlement_allocations(workspace_id,book_id,settlement_id,action_id,source_lot_id,retained_numerator,retained_denominator,disposed_numerator,disposed_denominator,retained_native_cost,retained_functional_cost,disposed_native_cost,disposed_functional_cost) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            context.workspaceId,
            bookId,
            settlementId,
            actionId,
            allocation.sourceLotId,
            allocation.retainedQuantity.numerator,
            allocation.retainedQuantity.denominator,
            allocation.cashDisposedQuantity.numerator,
            allocation.cashDisposedQuantity.denominator,
            allocation.retainedNativeCost,
            allocation.retainedFunctionalCost,
            allocation.disposedNativeCost,
            allocation.disposedFunctionalCost,
          ],
        );
      return result;
    });
  }
}

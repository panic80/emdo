import { loadInvestmentValuationSources } from './finance-investment-sources.js';
import { listLegacyFinanceAssignmentSources } from './finance-account-source-assignment-repository.js';
import {
  normalizeFinanceOfxStatement,
  assertFinanceOfxRowReviewable,
} from '../../domains/src/finance/ofx-normalization.js';
import {
  FinanceOfxStatementSchema,
  type FinanceOfxStatement,
  FinanceImageInspectionSchema,
  FinancePdfOcrInspectionSchema,
  FinancePdfOcrInventorySchema,
  FinancePdfPageRenderSchema,
  FinanceImageOcrFactsSchema,
  StructuredInvoiceExtractionSchema,
  ReviewStructuredInvoiceSchema,
  StructuredInvoiceReviewDraftSchema,
  SaveStructuredInvoiceReviewDraftSchema,
  StructuredInvoiceReviewDraftRecordSchema,
  PostReviewedStructuredInvoiceSchema,
} from '@emdo/contracts';
import {
  prepareReviewedStructuredInvoice,
  validateStructuredInvoiceForReview,
} from '@emdo/domains/finance';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  UploadNormalizedStatementSchema,
  RecordInvestmentLotSchema,
  RecordInvestmentMovementSchema,
  RecordLotDisposalSchema,
  ImportMappedFinanceReportSchema,
  FinanceReportMappingDefinitionSchema,
  ReviewNormalizedImportRowSchema,
  FinanceNormalizedAmountComponentReviewListSchema,
  FinanceNormalizedAmountComponentSourceSchema,
  CommitNormalizedImportSchema,
  RecordObservedInvestmentPositionSchema,
  CreateFinanceInstrumentSchema,
  RecordInvestmentPriceSchema,
  RecordInvestmentFxSchema,
  RecordInvestmentOpeningSchema,
  PreviewInvestmentValuationSchema,
  SaveInvestmentValuationSchema,
  UploadFinanceBookEvidenceSchema,
  SaveFinanceReportMappingSchema,
  SaveFinanceReportMappingFromSourceSchema,
  SaveReviewedFinanceSourceMappingSchema,
  ReviewFinanceReportMappingSchema,
  ExtractedFinanceReportTableSchema,
  CreateFinanceBookSchema,
  CreateFinancialAccountSchema,
  CreateFinancePartySchema,
  IssueCommercialDocumentSchema,
  RecordFinancePaymentSchema,
  VoidCommercialDocumentSchema,
  CreateLedgerAccountSchema,
  FiscalPeriodInputSchema,
  ReverseJournalSchema,
  UuidSchema,
  Sha256Schema,
  WorkspaceContextSchema,
  type WorkspaceContext,
  type FinanceCurrency,
} from '@emdo/contracts';
import {
  normalizeStatement,
  allocateInvestmentDisposal,
  convertBookAmount,
  parseFinanceDecimal,
  calculateInvestmentPosition,
  valueInvestmentPortfolio,
  reconcileInvestmentPosition,
  normalizeExtractedReport,
  extractFinanceCsvTable,
  validateJournal,
  prepareCommercialDocument,
  moneyValue,
  formatFinanceDecimal,
  extractFinanceNormalizedAmountComponents,
  prepareFinanceNormalizedAmountComponents,
} from '@emdo/domains/finance';
import type { DatabasePool, DatabaseClient } from './scoped-repository.js';
import { PostgresFinanceCorporateActionRepository } from './finance-corporate-action-repository.js';
import {
  beginDurableTransaction,
  lockDurableScope,
} from './durable/scoped-transaction.js';

export class FinanceV2PersistenceError extends Error {
  constructor(
    readonly code:
      'authorization-revoked' | 'invalid-input' | 'conflict' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'FinanceV2PersistenceError';
  }
}
function persistenceError(error: unknown): unknown {
  if (
    error instanceof FinanceV2PersistenceError ||
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
    return new FinanceV2PersistenceError(
      'authorization-revoked',
      error.message,
    );
  if (['23503', '23502', '22P02', '22003'].includes(code))
    return new FinanceV2PersistenceError('invalid-input', error.message);
  if (
    ['23505', '23514', '40P01', '55P03'].includes(code) ||
    error.message.startsWith('finance-')
  )
    return new FinanceV2PersistenceError('conflict', error.message);
  return error;
}

export interface FinanceImportEvidenceCipher {
  encrypt(
    value: unknown,
    scope: { workspaceId: string; bookId: string; documentId: string },
  ): Promise<unknown>;
  decrypt(
    value: unknown,
    scope: { workspaceId: string; bookId: string; documentId: string },
  ): Promise<unknown>;
}
export interface ReviewedFinanceXlsxExtractor {
  (
    bytes: Uint8Array,
    selection: unknown,
    source: {
      documentId: string;
      extractionRevision: number;
      providerKey: string;
      reportType: 'bank-transactions' | 'investment-positions';
    },
  ): {
    table: unknown;
    reviewFacts: { sourceDigest: string; selectionDigest: string };
  };
}
export interface ReviewedFinancePdfExtractor {
  (
    ...args: Parameters<ReviewedFinanceXlsxExtractor>
  ): Promise<
    ReturnType<ReviewedFinanceXlsxExtractor> & { cellProvenance: unknown }
  >;
}
export interface ReviewedFinanceImageExtractor {
  (
    bytes: Uint8Array,
    selection: unknown,
    saved: {
      standardizationRunId: string;
      extractionRevision: number;
      extractionDigest: string;
      factsJson: string;
    },
    source: Parameters<ReviewedFinanceXlsxExtractor>[2],
  ): ReturnType<ReviewedFinanceXlsxExtractor>;
}
const importHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

type ReportMappingModelProvenance = {
  runId: string;
  agentInvocationId: string;
  phaseInvocationId: string;
};
type ParsedReportMappingData =
  | ReturnType<typeof SaveFinanceReportMappingSchema.parse>
  | ReturnType<typeof SaveReviewedFinanceSourceMappingSchema.parse>
  | ReturnType<typeof SaveFinanceReportMappingFromSourceSchema.parse>;

/** All calls require a trusted server-authenticated workspace context. */
export class PostgresFinanceV2Repository {
  private readonly corporateActions: Pick<
    PostgresFinanceCorporateActionRepository,
    | 'getInvestmentLotRevision'
    | 'readInvestmentStockSplitSource'
    | 'commitInvestmentStockSplit'
    | 'commitInvestmentStockSplitSettlement'
    | 'checkStockSplitSettlementReady'
    | 'getInvestmentStockSplitSettlement'
    | 'readInvestmentCashDividendSource'
    | 'commitInvestmentCashDividend'
    | 'listInvestmentCashDividends'
    | 'getInvestmentCashDividend'
  >;

  constructor(
    private readonly pool: DatabasePool,
    private readonly options: {
      evidenceCipher?: FinanceImportEvidenceCipher;
      structuredInvoiceExtractor?: (
        bytes: Uint8Array,
        format: 'ubl' | 'cii',
      ) => unknown;
      reviewedXlsxExtractor?: ReviewedFinanceXlsxExtractor;
      reviewedPdfExtractor?: ReviewedFinancePdfExtractor;
      reviewedImageExtractor?: ReviewedFinanceImageExtractor;
      reviewedPdfOcrExtractor?: (
        bytes: Uint8Array,
        raster: Uint8Array,
        selection: unknown,
        saved: Parameters<ReviewedFinanceImageExtractor>[2],
        source: Parameters<ReviewedFinanceImageExtractor>[3],
      ) => ReturnType<ReviewedFinanceImageExtractor>;
      pdfOcrPageRenderer?: (input: {
        bytes: Uint8Array;
        expectedSourceDigest: string;
        pageNumber: number;
        scale: number;
        signal: AbortSignal;
      }) => Promise<
        | {
            status: 'rendered';
            render: ReturnType<typeof FinancePdfPageRenderSchema.parse>;
            png: Uint8Array;
          }
        | { status: 'unavailable'; reason: string }
      >;

      pdfOcrEvidenceVerifier?: (input: {
        factsJson: string;
        expectedExtractionDigest: string;
        expectedSourceDigest: string;
      }) => {
        inventory: ReturnType<typeof FinancePdfOcrInventorySchema.parse>;
      };
      ofxStatementExtractor?: (
        bytes: Uint8Array,
        format: 'ofx' | 'qfx',
      ) => FinanceOfxStatement | Promise<FinanceOfxStatement>;
      corporateActions?: Pick<
        PostgresFinanceCorporateActionRepository,
        | 'getInvestmentLotRevision'
        | 'readInvestmentStockSplitSource'
        | 'commitInvestmentStockSplit'
        | 'commitInvestmentStockSplitSettlement'
        | 'checkStockSplitSettlementReady'
        | 'getInvestmentStockSplitSettlement'
        | 'readInvestmentCashDividendSource'
        | 'commitInvestmentCashDividend'
        | 'listInvestmentCashDividends'
        | 'getInvestmentCashDividend'
      >;
    } = {},
  ) {
    this.corporateActions =
      this.options.corporateActions ??
      new PostgresFinanceCorporateActionRepository(this.pool);
  }

  async checkReady(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "select to_regclass('emdo.finance_journals') is not null and to_regclass('emdo.finance_payment_allocations') is not null and to_regclass('emdo.finance_financial_accounts') is not null and to_regclass('emdo.finance_investment_prices') is not null and to_regclass('emdo.finance_report_mapping_versions') is not null and to_regclass('emdo.finance_investment_lot_revisions') is not null and to_regclass('emdo.finance_investment_corporate_actions') is not null and to_regclass('emdo.finance_investment_corporate_action_lots') is not null and to_regclass('emdo.finance_investment_corporate_action_effects') is not null and to_regclass('emdo.finance_investment_lot_positions') is not null and to_regclass('emdo.finance_normalized_import_amount_components') is not null and to_regclass('emdo.finance_economic_transaction_amount_components') is not null and to_regclass('emdo.finance_investment_cash_dividends') is not null and to_regclass('emdo.finance_investment_cash_dividend_amounts') is not null as ready, current_user as role",
      );
      const role = await client.query(
        'select rolbypassrls,rolsuper from pg_roles where rolname=current_user',
      );
      return (
        result.rows[0]?.ready === true &&
        role.rows[0]?.rolbypassrls === false &&
        role.rows[0]?.rolsuper === false
      );
    } finally {
      client.release();
    }
  }

  getInvestmentLotRevision(context: WorkspaceContext, bookId: string) {
    return this.corporateActions.getInvestmentLotRevision(context, bookId);
  }

  readInvestmentStockSplitSource(
    context: WorkspaceContext,
    bookId: string,
    input: unknown,
  ) {
    return this.corporateActions.readInvestmentStockSplitSource(
      context,
      bookId,
      input,
    );
  }

  commitInvestmentStockSplit(
    context: WorkspaceContext,
    bookId: string,
    input: unknown,
  ) {
    return this.corporateActions.commitInvestmentStockSplit(
      context,
      bookId,
      input,
    );
  }

  checkStockSplitSettlementReady() {
    return this.corporateActions.checkStockSplitSettlementReady();
  }

  getInvestmentStockSplitSettlement(
    context: WorkspaceContext,
    bookId: string,
    settlementId: string,
  ) {
    return this.corporateActions.getInvestmentStockSplitSettlement(
      context,
      bookId,
      settlementId,
    );
  }

  commitInvestmentStockSplitSettlement(
    context: WorkspaceContext,
    bookId: string,
    input: unknown,
  ) {
    return this.corporateActions.commitInvestmentStockSplitSettlement(
      context,
      bookId,
      input,
    );
  }

  readInvestmentCashDividendSource(
    context: WorkspaceContext,
    bookId: string,
    input: unknown,
  ) {
    return this.corporateActions.readInvestmentCashDividendSource(
      context,
      bookId,
      input,
    );
  }

  commitInvestmentCashDividend(
    context: WorkspaceContext,
    bookId: string,
    input: unknown,
  ) {
    return this.corporateActions.commitInvestmentCashDividend(
      context,
      bookId,
      input,
    );
  }

  listInvestmentCashDividends(
    context: WorkspaceContext,
    bookId: string,
    input: unknown = {},
  ) {
    return this.corporateActions.listInvestmentCashDividends(
      context,
      bookId,
      input,
    );
  }

  getInvestmentCashDividend(
    context: WorkspaceContext,
    bookId: string,
    actionId: string,
  ) {
    return this.corporateActions.getInvestmentCashDividend(
      context,
      bookId,
      actionId,
    );
  }

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
      await client.query('rollback');
      throw persistenceError(error);
    } finally {
      client.release();
    }
  }

  private async book(
    client: Pick<DatabaseClient, 'query'>,
    context: WorkspaceContext,
    bookId: string,
    write = false,
  ) {
    UuidSchema.parse(bookId);
    // Lock the current grant for the transaction. Revocation wins if it commits first;
    // otherwise it waits for the already authorized transaction to complete.
    const locked = await client.query(
      'select emdo.lock_finance_book_grant($1,$2) as allowed',
      [context.workspaceId, bookId],
    );
    if (locked.rows[0]?.allowed !== true)
      throw new Error('finance-book-forbidden');
    const result = await client.query(
      `select b.*,g.role from emdo.finance_books b
      join emdo.finance_book_grants g on g.workspace_id=b.workspace_id and g.book_id=b.id
      where b.workspace_id=$1 and b.id=$2 and g.user_id=$3 and g.revoked_at is null`,
      [context.workspaceId, bookId, context.userId],
    );
    const book = result.rows[0];
    if (
      !book ||
      (write &&
        !['administrator', 'preparer', 'approver'].includes(String(book.role)))
    )
      throw new Error('finance-book-forbidden');
    return book;
  }

  private async command(
    context: WorkspaceContext,
    key: string,
    operation: string,
    payload: unknown,
    bookId: string | undefined,
    work: (client: DatabaseClient) => Promise<Record<string, unknown>>,
    beforeBook?: (client: DatabaseClient) => Promise<void>,
  ) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key))
      throw new Error('finance-idempotency-key-invalid');
    const hash = createHash('sha256')
      .update(JSON.stringify({ operation, bookId, payload }))
      .digest('hex');
    return this.transaction(context, async (client) => {
      if (beforeBook) await beforeBook(client);
      if (bookId) await this.book(client, context, bookId, true);
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${context.workspaceId}:${context.userId}:${key}`],
      );
      const previous = (
        await client.query(
          `select payload_hash,result from emdo.finance_command_receipts
        where workspace_id=$1 and user_id=$2 and idempotency_key=$3`,
          [context.workspaceId, context.userId, key],
        )
      ).rows[0];
      if (previous) {
        if (previous.payload_hash !== hash)
          throw new Error('finance-idempotency-conflict');
        return previous.result as Record<string, unknown>;
      }
      if (bookId)
        await client.query(
          'select pg_advisory_xact_lock(hashtextextended($1,0))',
          [`${context.workspaceId}:${bookId}`],
        );
      const result = await work(client);
      await client.query(
        `insert into emdo.finance_command_receipts(workspace_id,user_id,idempotency_key,operation,payload_hash,result)
        values($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          context.workspaceId,
          context.userId,
          key,
          operation,
          hash,
          JSON.stringify(result),
        ],
      );
      await client.query(
        `insert into emdo.finance_v2_audit(workspace_id,book_id,actor_id,request_id,operation,record_id,details)
        values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          context.workspaceId,
          bookId ?? null,
          context.userId,
          context.requestId,
          operation,
          result.id ?? null,
          JSON.stringify({ payloadHash: hash }),
        ],
      );
      return result;
    });
  }

  workspace(context: WorkspaceContext) {
    return this.transaction(context, async (client) => ({
      workspace: (
        await client.query(
          `select w.*,h.name from emdo.workspaces w join emdo.households h on h.id=w.id where w.id=$1`,
          [context.workspaceId],
        )
      ).rows[0],
      entitlements: (
        await client.query(
          'select capability,enabled,"limit",revision from emdo.workspace_entitlements where workspace_id=$1',
          [context.workspaceId],
        )
      ).rows,
    }));
  }

  listBooks(context: WorkspaceContext) {
    return this.transaction(
      context,
      async (client) =>
        (
          await client.query(
            `select b.id,b.name,e.id as "legalEntityId",e.name as "entityName",e.country,
      b.functional_currency as "functionalCurrency",g.role from emdo.finance_books b
      join emdo.finance_entities e on e.workspace_id=b.workspace_id and e.id=b.entity_id
      join emdo.finance_book_grants g on g.workspace_id=b.workspace_id and g.book_id=b.id and g.user_id=$2
      where b.workspace_id=$1 and g.revoked_at is null order by b.created_at,b.id`,
            [context.workspaceId, context.userId],
          )
        ).rows,
    );
  }

  createBook(context: WorkspaceContext, key: string, input: unknown) {
    const data = CreateFinanceBookSchema.parse(input);
    return this.command(
      context,
      key,
      'book.create',
      data,
      undefined,
      async (client) => {
        const entityId = randomUUID(),
          id = randomUUID();
        await client.query(
          `insert into emdo.finance_entities(id,workspace_id,name,kind,country,created_by) values($1,$2,$3,$4,$5,$6)`,
          [
            entityId,
            context.workspaceId,
            data.entityName,
            data.entityKind,
            data.country,
            context.userId,
          ],
        );
        await client.query(
          `insert into emdo.finance_books(id,workspace_id,entity_id,name,functional_currency,fiscal_year_start_month,created_by)
        values($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            context.workspaceId,
            entityId,
            data.name,
            data.functionalCurrency,
            data.fiscalYearStartMonth,
            context.userId,
          ],
        );
        return { id, entityId };
      },
    );
  }

  createAccount(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = CreateLedgerAccountSchema.parse(input);
    return this.command(
      context,
      key,
      'account.create',
      data,
      bookId,
      async (client) => {
        const id = randomUUID();
        await client.query(
          `insert into emdo.finance_ledger_accounts(id,workspace_id,book_id,code,name,kind) values($1,$2,$3,$4,$5,$6)`,
          [id, context.workspaceId, bookId, data.code, data.name, data.kind],
        );
        return { id };
      },
    );
  }

  createPeriod(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = FiscalPeriodInputSchema.parse(input);
    return this.command(
      context,
      key,
      'period.create',
      data,
      bookId,
      async (client) => {
        const id = randomUUID();
        await client.query(
          `insert into emdo.finance_periods(id,workspace_id,book_id,starts_on,ends_on) values($1,$2,$3,$4,$5)`,
          [id, context.workspaceId, bookId, data.startsOn, data.endsOn],
        );
        return { id };
      },
    );
  }

  private async insertJournal(
    client: Pick<DatabaseClient, 'query'>,
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
    reversalOf: string | null = null,
  ) {
    const book = await this.book(client, context, bookId, true);
    const data = validateJournal(
      input,
      book.functional_currency as FinanceCurrency,
    );
    const period = (
      await client.query(
        `select id from emdo.finance_periods where workspace_id=$1 and book_id=$2
      and status='open' and $3::date between starts_on and ends_on`,
        [context.workspaceId, bookId, data.effectiveOn],
      )
    ).rows[0];
    if (!period) throw new Error('finance-open-period-required');
    const id = randomUUID();
    await client.query(
      `insert into emdo.finance_journals(id,workspace_id,book_id,effective_on,description,source_reference,period_id,idempotency_key,payload_hash,created_by,reversal_of)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        context.workspaceId,
        bookId,
        data.effectiveOn,
        data.description,
        data.sourceReference,
        period.id,
        key,
        createHash('sha256').update(JSON.stringify(data)).digest('hex'),
        context.userId,
        reversalOf,
      ],
    );
    for (const [index, line] of data.lines.entries())
      await client.query(
        `insert into emdo.finance_journal_lines(workspace_id,book_id,journal_id,account_id,line_number,side,amount,currency,native_amount,fx_rate,fx_source,description)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          context.workspaceId,
          bookId,
          id,
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
      [context.workspaceId, bookId, id],
    );
    return { id };
  }

  postJournal(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    return this.command(context, key, 'journal.post', input, bookId, (client) =>
      this.insertJournal(client, context, bookId, key, input),
    );
  }

  reverseJournal(
    context: WorkspaceContext,
    bookId: string,
    journalId: string,
    key: string,
    input: unknown,
  ) {
    UuidSchema.parse(journalId);
    const data = ReverseJournalSchema.parse(input);
    return this.command(
      context,
      key,
      'journal.reverse',
      { ...data, journalId },
      bookId,
      async (client) => {
        const lines = (
          await client.query(
            `select l.account_id as "accountId",case l.side when 'debit' then 'credit' else 'debit' end as side,
        l.amount,l.currency,l.native_amount as "nativeAmount",l.fx_rate as "fxRate",l.fx_source as "fxSource",l.description
        from emdo.finance_journal_lines l join emdo.finance_journals j on j.id=l.journal_id and j.workspace_id=l.workspace_id and j.book_id=l.book_id
        where j.workspace_id=$1 and j.book_id=$2 and j.id=$3 and j.status='posted' order by l.line_number`,
            [context.workspaceId, bookId, journalId],
          )
        ).rows;
        return this.insertJournal(
          client,
          context,
          bookId,
          key,
          {
            effectiveOn: data.effectiveOn,
            description: data.reason,
            sourceReference: `reversal:${journalId}`,
            lines,
          },
          journalId,
        );
      },
    );
  }

  closePeriod(
    context: WorkspaceContext,
    bookId: string,
    periodId: string,
    key: string,
  ) {
    UuidSchema.parse(periodId);
    return this.command(
      context,
      key,
      'period.close',
      { periodId },
      bookId,
      async (client) => {
        const result = await client.query(
          `update emdo.finance_periods set status='closed',closed_at=clock_timestamp(),closed_by=$4
        where workspace_id=$1 and book_id=$2 and id=$3 and status='open' returning id`,
          [context.workspaceId, bookId, periodId, context.userId],
        );
        if (!result.rows[0]) throw new Error('finance-open-period-required');
        return { id: periodId };
      },
    );
  }

  overview(context: WorkspaceContext, bookId: string) {
    return this.transaction(context, async (client) => {
      const book = await this.book(client, context, bookId);
      const accounts = (
        await client.query(
          `select id,code,name,kind,active from emdo.finance_ledger_accounts where workspace_id=$1 and book_id=$2 order by code`,
          [context.workspaceId, bookId],
        )
      ).rows;
      const periods = (
        await client.query(
          `select id,starts_on::text as "startsOn",ends_on::text as "endsOn",status from emdo.finance_periods where workspace_id=$1 and book_id=$2 order by starts_on`,
          [context.workspaceId, bookId],
        )
      ).rows;
      const journals = (
        await client.query(
          `select id,effective_on::text as "effectiveOn",description,source_reference as "sourceReference",reversal_of as "reversalOf"
        from emdo.finance_journals where workspace_id=$1 and book_id=$2 and status='posted' order by effective_on,id`,
          [context.workspaceId, bookId],
        )
      ).rows;
      const trialBalance = (
        await client.query(
          `select a.id,a.code,a.name,a.kind,
        coalesce(sum(l.amount) filter(where l.side='debit'),0)::text debit,
        coalesce(sum(l.amount) filter(where l.side='credit'),0)::text credit,
        coalesce(sum(case l.side when 'debit' then l.amount else -l.amount end),0)::text balance
        from emdo.finance_ledger_accounts a left join
        (emdo.finance_journal_lines l join emdo.finance_journals j on j.workspace_id=l.workspace_id and j.book_id=l.book_id and j.id=l.journal_id and j.status='posted')
        on l.workspace_id=a.workspace_id and l.book_id=a.book_id and l.account_id=a.id
        where a.workspace_id=$1 and a.book_id=$2 group by a.id order by a.code`,
          [context.workspaceId, bookId],
        )
      ).rows;
      return { book, accounts, periods, journals, trialBalance };
    });
  }
  createParty(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = CreateFinancePartySchema.parse(input);
    return this.command(
      context,
      key,
      'party.create',
      data,
      bookId,
      async (client) => {
        const id = randomUUID();
        await client.query(
          `insert into emdo.finance_parties(id,workspace_id,book_id,name,kind,reference) values($1,$2,$3,$4,$5,$6)`,
          [
            id,
            context.workspaceId,
            bookId,
            data.name,
            data.kind,
            data.reference,
          ],
        );
        return { id };
      },
    );
  }

  issueCommercialDocument(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = IssueCommercialDocumentSchema.parse(input);
    return this.command(
      context,
      key,
      'commercial.issue',
      data,
      bookId,
      async (client) => {
        return this.insertCommercialDocument(
          client,
          context,
          bookId,
          key,
          data,
        );
      },
    );
  }

  private async insertCommercialDocument(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    key: string,
    data: ReturnType<typeof IssueCommercialDocumentSchema.parse>,
  ) {
    const book = await this.book(client, context, bookId, true);
    const prepared = prepareCommercialDocument(
      data,
      book.functional_currency as FinanceCurrency,
    );
    const id = randomUUID();
    await client.query(
      `insert into emdo.finance_commercial_documents(id,workspace_id,book_id,kind,party_id,reference,issued_on,due_on,control_account_id,source_reference)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        context.workspaceId,
        bookId,
        data.kind,
        data.partyId,
        data.reference,
        data.issuedOn,
        data.dueOn,
        data.controlAccountId,
        data.sourceReference,
      ],
    );
    for (const [index, line] of data.lines.entries())
      await client.query(
        `insert into emdo.finance_commercial_lines(workspace_id,book_id,document_id,line_number,description,account_id,net_amount,tax_amount,tax_account_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          context.workspaceId,
          bookId,
          id,
          index + 1,
          line.description,
          line.accountId,
          line.netAmount,
          line.taxAmount,
          line.taxAccountId,
        ],
      );
    const journal = await this.insertJournal(
      client,
      context,
      bookId,
      key,
      prepared.journal,
    );
    await client.query(
      `update emdo.finance_commercial_documents set status='issued',journal_id=$4,total=$5 where workspace_id=$1 and book_id=$2 and id=$3`,
      [context.workspaceId, bookId, id, journal.id, prepared.total],
    );
    return {
      id,
      journalId: journal.id,
      total: prepared.total,
      currency: book.functional_currency,
    };
  }

  private async structuredInvoiceSource(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    evidenceId: string,
  ) {
    const row = (
      await client.query(
        'select * from emdo.finance_book_evidence where workspace_id=$1 and book_id=$2 and id=$3',
        [context.workspaceId, bookId, evidenceId],
      )
    ).rows[0];
    if (!row || !['ubl', 'cii'].includes(String(row.format)))
      throw new Error('finance-structured-invoice-evidence-required');
    const cipher = this.options.evidenceCipher,
      extract = this.options.structuredInvoiceExtractor;
    if (!cipher || !extract)
      throw new FinanceV2PersistenceError(
        'unavailable',
        'Structured invoice extraction unavailable',
      );
    const value = await cipher.decrypt(row.encrypted_original, {
      workspaceId: context.workspaceId,
      bookId,
      documentId: evidenceId,
    });
    if (
      !value ||
      typeof value !== 'object' ||
      !('sourceText' in value) ||
      typeof value.sourceText !== 'string'
    )
      throw new Error('finance-evidence-integrity-failed');
    const bytes = Buffer.from(value.sourceText, 'utf8');
    if (
      bytes.length !== row.byte_size ||
      createHash('sha256').update(bytes).digest('hex') !== row.plaintext_sha256
    )
      throw new Error('finance-evidence-integrity-failed');
    let extraction;
    try {
      extraction = StructuredInvoiceExtractionSchema.parse(
        extract(bytes, row.format as 'ubl' | 'cii'),
      );
    } catch {
      throw new FinanceV2PersistenceError(
        'invalid-input',
        'Structured invoice XML is unsafe, malformed, oversized or unsupported',
      );
    }
    if (
      extraction.sourceDigest !== row.plaintext_sha256 ||
      extraction.format !== row.format
    )
      throw new Error('finance-extractor-source-integrity-failed');
    return extraction;
  }
  inspectStructuredInvoice(
    context: WorkspaceContext,
    bookId: string,
    evidenceId: string,
  ) {
    UuidSchema.parse(evidenceId);
    return this.transaction(context, async (client) => {
      const book = await this.book(client, context, bookId);
      const source = await this.structuredInvoiceSource(
        client,
        context,
        bookId,
        evidenceId,
      );
      if (source.blockingIssues.length === 0) {
        try {
          validateStructuredInvoiceForReview(
            source,
            String(book.functional_currency),
          );
        } catch (error) {
          source.blockingIssues.push(
            error instanceof Error &&
              error.message.startsWith('finance-invoice-')
              ? error.message
              : 'Unsupported monetary precision or currency',
          );
        }
      }
      return source;
    });
  }
  private async invoiceDraft(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    evidenceId: string,
  ) {
    const row = (
      await client.query(
        'select id,evidence_id as "evidenceId",revision,draft from emdo.finance_invoice_review_drafts where workspace_id=$1 and book_id=$2 and evidence_id=$3 and user_id=$4 order by revision desc limit 1',
        [context.workspaceId, bookId, evidenceId, context.userId],
      )
    ).rows[0];
    return row ? StructuredInvoiceReviewDraftRecordSchema.parse(row) : null;
  }
  getStructuredInvoiceReviewDraft(
    context: WorkspaceContext,
    bookId: string,
    evidenceId: string,
  ) {
    UuidSchema.parse(evidenceId);
    return this.transaction(context, async (client) => {
      const book = await this.book(client, context, bookId),
        source = await this.structuredInvoiceSource(
          client,
          context,
          bookId,
          evidenceId,
        );
      const draft = await this.invoiceDraft(
        client,
        context,
        bookId,
        evidenceId,
      );
      const posting = (
        await client.query(
          'select id,journal_id as "journalId",status,total::text from emdo.finance_commercial_documents where workspace_id=$1 and book_id=$2 and source_reference=$3',
          [
            context.workspaceId,
            bookId,
            `structured-invoice:${source.sourceDigest}`,
          ],
        )
      ).rows[0];
      return {
        review: draft,
        posting: posting
          ? { ...posting, currency: String(book.functional_currency) }
          : null,
      };
    });
  }
  saveStructuredInvoiceReviewDraft(
    context: WorkspaceContext,
    bookId: string,
    evidenceId: string,
    key: string,
    raw: unknown,
  ) {
    UuidSchema.parse(evidenceId);
    const input = SaveStructuredInvoiceReviewDraftSchema.parse(raw);
    return this.command(
      context,
      key,
      'structured-invoice.review-draft',
      { evidenceId, ...input },
      bookId,
      async (client) => {
        const source = await this.structuredInvoiceSource(
            client,
            context,
            bookId,
            evidenceId,
          ),
          previous = await this.invoiceDraft(
            client,
            context,
            bookId,
            evidenceId,
          );
        if (
          (previous?.revision ?? 0) !== input.expectedRevision ||
          source.sourceDigest !== input.draft.expectedSourceDigest ||
          source.adapterVersion !== input.draft.expectedAdapterVersion
        )
          throw new Error('finance-invoice-review-draft-conflict');
        if (
          new Set(input.draft.groups.map((g) => g.key)).size !==
            input.draft.groups.length ||
          input.draft.groups.some(
            (g) => !source.taxGroups.some((s) => s.key === g.key),
          )
        )
          throw new Error('finance-invoice-review-group-conflict');
        const id = randomUUID(),
          revision = input.expectedRevision + 1;
        await client.query(
          'insert into emdo.finance_invoice_review_drafts(id,workspace_id,book_id,evidence_id,user_id,revision,draft) values($1,$2,$3,$4,$5,$6,$7::jsonb)',
          [
            id,
            context.workspaceId,
            bookId,
            evidenceId,
            context.userId,
            revision,
            JSON.stringify(input.draft),
          ],
        );
        return { id, evidenceId, revision, draft: input.draft };
      },
    );
  }

  postReviewedStructuredInvoice(
    context: WorkspaceContext,
    bookId: string,
    evidenceId: string,
    key: string,
    raw: unknown,
  ) {
    UuidSchema.parse(evidenceId);
    const { expectedReviewRevision, ...reviewInput } =
      PostReviewedStructuredInvoiceSchema.parse(raw);
    const review = ReviewStructuredInvoiceSchema.parse(reviewInput);
    return this.command(
      context,
      key,
      'structured-invoice.reviewed-issue',
      { evidenceId, review, expectedReviewRevision },
      bookId,
      async (client) => {
        const book = await this.book(client, context, bookId, true),
          extraction = await this.structuredInvoiceSource(
            client,
            context,
            bookId,
            evidenceId,
          );
        const savedReview = await this.invoiceDraft(
          client,
          context,
          bookId,
          evidenceId,
        );
        if (
          !savedReview ||
          savedReview.revision !== expectedReviewRevision ||
          JSON.stringify(StructuredInvoiceReviewDraftSchema.parse(review)) !==
            JSON.stringify(savedReview.draft)
        )
          throw new Error('finance-invoice-saved-review-revision-conflict');
        const document = prepareReviewedStructuredInvoice(
          extraction,
          review,
          String(book.functional_currency),
        );
        const duplicate = (
          await client.query(
            'select id from emdo.finance_commercial_documents where workspace_id=$1 and book_id=$2 and source_reference=$3',
            [context.workspaceId, bookId, document.sourceReference],
          )
        ).rows[0];
        if (duplicate)
          throw new Error('finance-structured-invoice-already-posted');
        const result = await this.insertCommercialDocument(
          client,
          context,
          bookId,
          key,
          document,
        );
        await client.query(
          'insert into emdo.finance_v2_audit(workspace_id,book_id,actor_id,request_id,operation,record_id,details) values($1,$2,$3,$4,$5,$6,$7::jsonb)',
          [
            context.workspaceId,
            bookId,
            context.userId,
            context.requestId,
            'structured-invoice.review',
            result.id,
            JSON.stringify({
              evidenceId,
              review,
              expectedReviewRevision,
              sourceDigest: extraction.sourceDigest,
              adapterVersion: extraction.adapterVersion,
              groupSources: extraction.taxGroups,
              conformance: 'not-validated',
            }),
          ],
        );
        return {
          ...result,
          evidenceId,
          sourceDigest: extraction.sourceDigest,
          adapterVersion: extraction.adapterVersion,
        };
      },
    );
  }

  recordPayment(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = RecordFinancePaymentSchema.parse(input);
    return this.command(
      context,
      key,
      'payment.record',
      data,
      bookId,
      async (client) => {
        const book = await this.book(client, context, bookId, true);
        const currency = book.functional_currency as FinanceCurrency;
        const id = randomUUID();
        let total = 0n;
        const lines = [];
        await client.query(
          `insert into emdo.finance_payments(id,workspace_id,book_id,direction,party_id,cash_account_id,effective_on,reference,source_reference)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            context.workspaceId,
            bookId,
            data.direction,
            data.partyId,
            data.cashAccountId,
            data.effectiveOn,
            data.reference,
            data.sourceReference,
          ],
        );
        for (const allocation of data.allocations) {
          const amount = moneyValue(allocation.amount, currency);
          if (amount <= 0n) throw new Error('finance-payment-amount-invalid');
          total += amount;
          const document = (
            await client.query(
              `select control_account_id from emdo.finance_commercial_documents where workspace_id=$1 and book_id=$2 and id=$3 and status='issued'`,
              [context.workspaceId, bookId, allocation.documentId],
            )
          ).rows[0];
          if (!document)
            throw new Error('finance-commercial-document-unavailable');
          await client.query(
            `insert into emdo.finance_payment_allocations(workspace_id,book_id,payment_id,document_id,amount) values($1,$2,$3,$4,$5)`,
            [
              context.workspaceId,
              bookId,
              id,
              allocation.documentId,
              allocation.amount,
            ],
          );
          lines.push({
            accountId: document.control_account_id,
            side: data.direction === 'receipt' ? 'credit' : 'debit',
            amount: allocation.amount,
            nativeAmount: allocation.amount,
            currency,
            fxRate: '1',
            fxSource: 'functional-currency',
          });
        }
        const amount = formatFinanceDecimal(total);
        moneyValue(amount, currency);
        lines.unshift({
          accountId: data.cashAccountId,
          side: data.direction === 'receipt' ? 'debit' : 'credit',
          amount,
          nativeAmount: amount,
          currency,
          fxRate: '1',
          fxSource: 'functional-currency',
        });
        const journal = await this.insertJournal(client, context, bookId, key, {
          effectiveOn: data.effectiveOn,
          description: `${data.direction}: ${data.reference}`,
          sourceReference: data.sourceReference,
          lines,
        });
        await client.query(
          `update emdo.finance_payments set status='posted',total=$4,journal_id=$5 where workspace_id=$1 and book_id=$2 and id=$3`,
          [context.workspaceId, bookId, id, amount, journal.id],
        );
        return { id, journalId: journal.id, total: amount, currency };
      },
    );
  }

  voidCommercialDocument(
    context: WorkspaceContext,
    bookId: string,
    documentId: string,
    key: string,
    input: unknown,
  ) {
    UuidSchema.parse(documentId);
    const data = VoidCommercialDocumentSchema.parse(input);
    return this.command(
      context,
      key,
      'commercial.void',
      { ...data, documentId },
      bookId,
      async (client) => {
        const document = (
          await client.query(
            `select journal_id from emdo.finance_commercial_documents where workspace_id=$1 and book_id=$2 and id=$3 and status='issued'`,
            [context.workspaceId, bookId, documentId],
          )
        ).rows[0];
        if (!document)
          throw new Error('finance-commercial-document-unavailable');
        await client.query(
          `update emdo.finance_commercial_documents set status='void' where workspace_id=$1 and book_id=$2 and id=$3`,
          [context.workspaceId, bookId, documentId],
        );
        const lines = (
          await client.query(
            `select account_id as "accountId",case side when 'debit' then 'credit' else 'debit' end side,amount,currency,native_amount as "nativeAmount",fx_rate as "fxRate",fx_source as "fxSource",description
        from emdo.finance_journal_lines where workspace_id=$1 and book_id=$2 and journal_id=$3 order by line_number`,
            [context.workspaceId, bookId, document.journal_id],
          )
        ).rows;
        const journal = await this.insertJournal(
          client,
          context,
          bookId,
          key,
          {
            effectiveOn: data.effectiveOn,
            description: data.reason,
            sourceReference: `void:${documentId}`,
            lines,
          },
          String(document.journal_id),
        );
        await client.query(
          `update emdo.finance_commercial_documents set void_journal_id=$4 where workspace_id=$1 and book_id=$2 and id=$3`,
          [context.workspaceId, bookId, documentId, journal.id],
        );
        return { id: documentId, journalId: journal.id };
      },
    );
  }

  voidPayment(
    context: WorkspaceContext,
    bookId: string,
    paymentId: string,
    key: string,
    input: unknown,
  ) {
    UuidSchema.parse(paymentId);
    const data = VoidCommercialDocumentSchema.parse(input);
    return this.command(
      context,
      key,
      'payment.void',
      { ...data, paymentId },
      bookId,
      async (client) => {
        const payment = (
          await client.query(
            `select journal_id from emdo.finance_payments where workspace_id=$1 and book_id=$2 and id=$3 and status='posted'`,
            [context.workspaceId, bookId, paymentId],
          )
        ).rows[0];
        if (!payment) throw new Error('finance-payment-unavailable');
        await client.query(
          `update emdo.finance_payments set status='void' where workspace_id=$1 and book_id=$2 and id=$3`,
          [context.workspaceId, bookId, paymentId],
        );
        const lines = (
          await client.query(
            `select account_id as "accountId",case side when 'debit' then 'credit' else 'debit' end side,amount,currency,native_amount as "nativeAmount",fx_rate as "fxRate",fx_source as "fxSource",description from emdo.finance_journal_lines where workspace_id=$1 and book_id=$2 and journal_id=$3 order by line_number`,
            [context.workspaceId, bookId, payment.journal_id],
          )
        ).rows;
        const journal = await this.insertJournal(
          client,
          context,
          bookId,
          key,
          {
            effectiveOn: data.effectiveOn,
            description: data.reason,
            sourceReference: `payment-void:${paymentId}`,
            lines,
          },
          String(payment.journal_id),
        );
        await client.query(
          `update emdo.finance_payments set void_journal_id=$4 where workspace_id=$1 and book_id=$2 and id=$3`,
          [context.workspaceId, bookId, paymentId, journal.id],
        );
        return { id: paymentId, journalId: journal.id };
      },
    );
  }

  commercialOverview(context: WorkspaceContext, bookId: string) {
    return this.transaction(context, async (client) => {
      const book = await this.book(client, context, bookId);
      const parties = (
        await client.query(
          `select id,name,kind,reference from emdo.finance_parties where workspace_id=$1 and book_id=$2 order by name,id`,
          [context.workspaceId, bookId],
        )
      ).rows;
      const documents = (
        await client.query(
          `select d.id,d.kind,d.party_id as "partyId",p.name as "partyName",d.reference,d.issued_on::text as "issuedOn",d.due_on::text as "dueOn",d.status,d.total::text,d.journal_id as "journalId",d.void_journal_id as "voidJournalId",d.source_reference as "sourceReference",
        coalesce(paid.amount,0)::text as paid,case when d.status='issued' then d.total-coalesce(paid.amount,0) else 0 end::text as outstanding
        from emdo.finance_commercial_documents d join emdo.finance_parties p on p.workspace_id=d.workspace_id and p.book_id=d.book_id and p.id=d.party_id
        left join lateral (select sum(a.amount) amount from emdo.finance_payment_allocations a join emdo.finance_payments pay on pay.workspace_id=a.workspace_id and pay.book_id=a.book_id and pay.id=a.payment_id
          where a.workspace_id=d.workspace_id and a.book_id=d.book_id and a.document_id=d.id and pay.status='posted') paid on true
        where d.workspace_id=$1 and d.book_id=$2 order by d.issued_on,d.id`,
          [context.workspaceId, bookId],
        )
      ).rows;
      const payments = (
        await client.query(
          `select id,direction,party_id as "partyId",effective_on::text as "effectiveOn",reference,total::text,status,journal_id as "journalId",void_journal_id as "voidJournalId",source_reference as "sourceReference"
        from emdo.finance_payments where workspace_id=$1 and book_id=$2 and status in ('posted','void') order by effective_on,id`,
          [context.workspaceId, bookId],
        )
      ).rows;
      return {
        currency: book.functional_currency,
        parties,
        documents,
        payments,
      };
    });
  }
  listBookEvidence(context: WorkspaceContext, bookId: string, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
      throw new FinanceV2PersistenceError(
        'invalid-input',
        'Invalid evidence page',
      );
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      const rows: readonly Record<string, unknown>[] = (
        await client.query(
          `select id,filename,format,plaintext_sha256 as "sourceDigest",byte_size as "byteSize",created_at as "createdAt" from emdo.finance_book_evidence where workspace_id=$1 and book_id=$2 order by created_at,id limit 51 offset $3`,
          [context.workspaceId, bookId, offset],
        )
      ).rows;
      return {
        documents: rows.slice(0, 50),
        nextOffset: rows.length > 50 ? offset + 50 : null,
      };
    });
  }

  uploadBookEvidence(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = UploadFinanceBookEvidenceSchema.parse(input);
    const bytes =
      'sourceBase64' in data
        ? Buffer.from(data.sourceBase64, 'base64')
        : Buffer.from(data.sourceText, 'utf8');
    if (
      'sourceBase64' in data &&
      bytes.toString('base64') !== data.sourceBase64
    )
      throw new FinanceV2PersistenceError(
        'invalid-input',
        'Invalid binary evidence encoding',
      );
    if (bytes.length === 0 || bytes.length > 2097152)
      throw new FinanceV2PersistenceError(
        'invalid-input',
        'Evidence exceeds upload limit',
      );
    if (['png', 'jpeg', 'webp'].includes(data.format)) {
      const valid =
        data.format === 'png'
          ? bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : data.format === 'jpeg'
            ? bytes.length >= 4 &&
              bytes[0] === 255 &&
              bytes[1] === 216 &&
              bytes[2] === 255
            : bytes.length >= 12 &&
              bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
              bytes.subarray(8, 12).toString('ascii') === 'WEBP';
      if (!valid)
        throw new FinanceV2PersistenceError(
          'invalid-input',
          'Image format does not match original bytes',
        );
    }
    if (data.format === 'ubl' || data.format === 'cii') {
      const extract = this.options.structuredInvoiceExtractor;
      if (!extract)
        throw new FinanceV2PersistenceError(
          'unavailable',
          'Structured invoice extraction unavailable',
        );
      try {
        StructuredInvoiceExtractionSchema.parse(extract(bytes, data.format));
      } catch {
        throw new FinanceV2PersistenceError(
          'invalid-input',
          'Structured invoice XML is unsafe, malformed, oversized or unsupported',
        );
      }
    }
    return this.command(
      context,
      key,
      'evidence.upload',
      data,
      bookId,
      async (client) => {
        const cipher = this.options.evidenceCipher;
        if (!cipher)
          throw new FinanceV2PersistenceError(
            'unavailable',
            'Encrypted evidence storage unavailable',
          );
        const id = randomUUID();
        const encrypted = await cipher.encrypt(
          'sourceBase64' in data
            ? { sourceBase64: data.sourceBase64 }
            : { sourceText: data.sourceText },
          { workspaceId: context.workspaceId, bookId, documentId: id },
        );
        await client.query(
          `insert into emdo.finance_book_evidence(id,workspace_id,book_id,filename,format,plaintext_sha256,byte_size,encrypted_original,uploaded_by) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
          [
            id,
            context.workspaceId,
            bookId,
            data.filename,
            data.format,
            createHash('sha256').update(bytes).digest('hex'),
            bytes.length,
            JSON.stringify(encrypted),
            context.userId,
          ],
        );
        return {
          id,
          sourceDigest: createHash('sha256').update(bytes).digest('hex'),
        };
      },
    );
  }

  uploadNormalizedStatement(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = UploadNormalizedStatementSchema.parse(input);
    return this.command(
      context,
      key,
      'import.upload',
      data,
      bookId,
      async (client) => {
        const cipher = this.options.evidenceCipher;
        if (!cipher)
          throw new FinanceV2PersistenceError(
            'unavailable',
            'Encrypted evidence storage is unavailable',
          );
        const account = (
          await client.query(
            'select * from emdo.finance_financial_accounts where workspace_id=$1 and book_id=$2 and id=$3 and active',
            [context.workspaceId, bookId, data.financialAccountId],
          )
        ).rows[0];
        if (!account) throw new Error('finance-financial-account-unavailable');
        let rows: ReturnType<typeof normalizeStatement>;
        if (data.format !== 'csv' && !this.options.ofxStatementExtractor)
          throw new FinanceV2PersistenceError(
            'unavailable',
            'Source-preserving OFX/QFX extraction is unavailable',
          );
        try {
          if (data.format === 'csv')
            rows = normalizeStatement(
              data,
              account.currency as FinanceCurrency,
            );
          else {
            const bytes = Buffer.from(data.sourceText, 'utf8');
            const source = FinanceOfxStatementSchema.parse(
              await this.options.ofxStatementExtractor!(bytes, data.format),
            );
            if (
              source.sourceDigest !==
                createHash('sha256').update(bytes).digest('hex') ||
              source.format !== data.format
            )
              throw new Error('finance-ofx-source-binding-mismatch');
            rows = normalizeFinanceOfxStatement(
              source,
              account.currency as FinanceCurrency,
            );
          }
        } catch {
          throw new FinanceV2PersistenceError(
            'invalid-input',
            'Statement format or mapping is invalid',
          );
        }
        const id = randomUUID(),
          evidenceId = randomUUID();
        const encrypted = await cipher.encrypt(
          { sourceText: data.sourceText },
          { workspaceId: context.workspaceId, bookId, documentId: evidenceId },
        );
        await client.query(
          `insert into emdo.finance_book_evidence(id,workspace_id,book_id,filename,format,plaintext_sha256,byte_size,encrypted_original,uploaded_by) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
          [
            evidenceId,
            context.workspaceId,
            bookId,
            data.filename,
            data.format,
            createHash('sha256').update(data.sourceText).digest('hex'),
            Buffer.byteLength(data.sourceText),
            JSON.stringify(encrypted),
            context.userId,
          ],
        );
        await client.query(
          `insert into emdo.finance_normalized_imports(id,workspace_id,book_id,financial_account_id,evidence_id,mapping,parser_version) values($1,$2,$3,$4,$5,$6::jsonb,$7)`,
          [
            id,
            context.workspaceId,
            bookId,
            data.financialAccountId,
            evidenceId,
            JSON.stringify(data.mapping ?? {}),
            data.format === 'csv'
              ? 'normalized-statement.v1'
              : 'finance-ofx-normalized.v1',
          ],
        );
        for (const row of rows)
          await client.query(
            `insert into emdo.finance_normalized_import_rows(workspace_id,book_id,batch_id,source_row,source_facts,effective_on,description,native_amount,external_id,issues,status) values($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11)`,
            [
              context.workspaceId,
              bookId,
              id,
              row.sourceRow,
              JSON.stringify(row),
              row.date,
              row.description,
              row.amount,
              row.externalId,
              JSON.stringify(row.issues),
              row.issues.length ? 'invalid' : 'review',
            ],
          );
        return { id, evidenceId, rowCount: rows.length, revision: 1 };
      },
    );
  }

  listNormalizedImports(context: WorkspaceContext, bookId: string) {
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      return (
        await client.query(
          `select i.id,i.financial_account_id as "financialAccountId",i.evidence_id as "evidenceId",i.status,i.revision,e.filename,i.created_at as "createdAt" from emdo.finance_normalized_imports i join emdo.finance_book_evidence e on e.workspace_id=i.workspace_id and e.book_id=i.book_id and e.id=i.evidence_id where i.workspace_id=$1 and i.book_id=$2 order by i.created_at desc,i.id`,
          [context.workspaceId, bookId],
        )
      ).rows;
    });
  }

  getNormalizedImport(
    context: WorkspaceContext,
    bookId: string,
    batchId: string,
  ) {
    UuidSchema.parse(batchId);
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      // Keep the row revision and its component mappings from being read
      // across a concurrent review command. Mutations take this same book
      // lock before changing either record family.
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${context.workspaceId}:${bookId}`],
      );
      const batch = (
        await client.query(
          `select * from emdo.finance_normalized_imports where workspace_id=$1 and book_id=$2 and id=$3`,
          [context.workspaceId, bookId, batchId],
        )
      ).rows[0];
      if (!batch) throw new Error('finance-import-unavailable');
      const rows = (
        await client.query(
          `select r.*,effective_on::text as date,native_amount::text as amount,fx_rate::text as "fxRate",(select decision from emdo.finance_import_row_reviews v where v.workspace_id=r.workspace_id and v.book_id=r.book_id and v.row_id=r.id and v.revision=r.revision) as decision from emdo.finance_normalized_import_rows r where workspace_id=$1 and book_id=$2 and batch_id=$3 order by source_row`,
          [context.workspaceId, bookId, batchId],
        )
      ).rows;
      const components = rows.length
        ? (
            await client.query(
              `select c.id,c.row_id as "rowId",c.component_kind as kind,c.native_amount::text as "nativeAmount",c.currency,c.source_provenance as provenance,c.revision,c.reviewed_native_amount::text as "reviewedNativeAmount",c.reviewed_currency as "reviewedCurrency",c.inclusion,c.posting_side as "postingSide",c.ledger_account_id as "ledgerAccountId",c.fx_rate::text as "fxRate",c.fx_source as "fxSource" from emdo.finance_normalized_import_amount_components c where c.workspace_id=$1 and c.book_id=$2 and c.row_id = any($3::uuid[]) order by c.row_id,c.component_kind`,
              [context.workspaceId, bookId, rows.map((row) => row.id)],
            )
          ).rows
        : [];
      const byRow = new Map<string, unknown[]>();
      for (const component of components) {
        const rowId = String(component.rowId);
        const existing = byRow.get(rowId) ?? [];
        existing.push(component);
        byRow.set(rowId, existing);
      }
      // Only the persisted economic transaction proves posting. A review's
      // match target alone is not a committed relationship.
      const postings = (
        await client.query(
          `select r.id as "rowId",t.id as "economicTransactionId",j.id as "journalId",b.functional_currency as "functionalCurrency",j.effective_on::text as "effectiveOn",j.description,j.source_reference as "sourceReference",j.reversal_of as "reversalOf"
          from emdo.finance_normalized_import_rows r
          join emdo.finance_books b on b.workspace_id=r.workspace_id and b.id=r.book_id
          join emdo.finance_economic_transactions t on t.workspace_id=r.workspace_id and t.book_id=r.book_id and t.id=r.economic_transaction_id
          join emdo.finance_journals j on j.workspace_id=t.workspace_id and j.book_id=t.book_id and j.id=t.journal_id and j.status='posted'
          where r.workspace_id=$1 and r.book_id=$2 and r.batch_id=$3 order by r.source_row`,
          [context.workspaceId, bookId, batchId],
        )
      ).rows;
      const lines = postings.length
        ? (
            await client.query(
              `select journal_id as "journalId",line_number as "lineNumber",account_id as "accountId",side,amount::text as amount,currency,native_amount::text as "nativeAmount",fx_rate::text as "fxRate",fx_source as "fxSource",description from emdo.finance_journal_lines where workspace_id=$1 and book_id=$2 and journal_id=any($3::uuid[]) order by journal_id,line_number`,
              [
                context.workspaceId,
                bookId,
                postings.map((posting) => posting.journalId),
              ],
            )
          ).rows
        : [];
      const linesByJournal = new Map<string, Record<string, unknown>[]>();
      for (const line of lines) {
        const journalId = String(line.journalId);
        const result = { ...line };
        delete result.journalId;
        const journalLines = linesByJournal.get(journalId) ?? [];
        journalLines.push(result);
        linesByJournal.set(journalId, journalLines);
      }
      const postingByRow = new Map(
        postings.map(({ rowId, ...posting }) => [
          String(rowId),
          {
            ...posting,
            lines: linesByJournal.get(String(posting.journalId)) ?? [],
          },
        ]),
      );
      return {
        batch,
        rows: rows.map((row): Record<string, unknown> => ({
          ...row,
          amountComponents: byRow.get(String(row.id)) ?? [],
          posting: postingByRow.get(String(row.id)) ?? null,
        })),
      };
    });
  }

  private async normalizedImportAmountComponents(
    client: Pick<DatabaseClient, 'query'>,
    context: WorkspaceContext,
    bookId: string,
    rowId: string,
  ) {
    return (
      await client.query(
        `select c.id,c.row_id as "rowId",c.component_kind as kind,c.native_amount::text as "nativeAmount",c.currency,c.source_provenance as provenance,c.revision,c.reviewed_native_amount::text as "reviewedNativeAmount",c.reviewed_currency as "reviewedCurrency",c.inclusion,c.posting_side as "postingSide",c.ledger_account_id as "ledgerAccountId",c.fx_rate::text as "fxRate",c.fx_source as "fxSource" from emdo.finance_normalized_import_amount_components c where c.workspace_id=$1 and c.book_id=$2 and c.row_id=$3 order by c.component_kind`,
        [context.workspaceId, bookId, rowId],
      )
    ).rows;
  }

  private async validateNormalizedAmountComponentAccounts(
    client: Pick<DatabaseClient, 'query'>,
    context: WorkspaceContext,
    bookId: string,
    accountIds: readonly string[],
    financialAccountLedgerId: string,
  ) {
    const ids = [...new Set(accountIds)];
    if (!ids.length || ids.includes(financialAccountLedgerId))
      throw new Error('finance-import-component-account-unavailable');
    const accounts = (
      await client.query(
        `select id,active from emdo.finance_ledger_accounts where workspace_id=$1 and book_id=$2 and id = any($3::uuid[])`,
        [context.workspaceId, bookId, ids],
      )
    ).rows;
    if (
      accounts.length !== ids.length ||
      accounts.some((account) => account.active !== true)
    )
      throw new Error('finance-import-component-account-unavailable');
  }

  reviewNormalizedImportRow(
    context: WorkspaceContext,
    bookId: string,
    rowId: string,
    key: string,
    input: unknown,
  ) {
    UuidSchema.parse(rowId);
    const data = ReviewNormalizedImportRowSchema.parse(input);
    return this.command(
      context,
      key,
      'import.review',
      { rowId, ...data },
      bookId,
      async (client) => {
        const book = await this.book(client, context, bookId, true);
        const row = (
          await client.query(
            `select r.*,r.effective_on::text as date,r.native_amount::text as amount,a.currency,a.ledger_account_id as "financialAccountLedgerId" from emdo.finance_normalized_import_rows r join emdo.finance_normalized_imports i on i.workspace_id=r.workspace_id and i.book_id=r.book_id and i.id=r.batch_id join emdo.finance_financial_accounts a on a.workspace_id=i.workspace_id and a.book_id=i.book_id and a.id=i.financial_account_id where r.workspace_id=$1 and r.book_id=$2 and r.id=$3 and i.status='review'`,
            [context.workspaceId, bookId, rowId],
          )
        ).rows[0];
        if (!row || row.revision !== data.expectedRevision)
          throw new Error('finance-import-revision-conflict');
        const correction = data.correction ?? {},
          date = correction.date ?? row.date,
          amount = correction.amount ?? row.amount,
          description = correction.description ?? row.description,
          externalId = Object.hasOwn(correction, 'externalId')
            ? correction.externalId
            : row.external_id;
        const ignored = data.action === 'ignore';
        if (!ignored)
          assertFinanceOfxRowReviewable(row.source_facts, externalId);
        const fxRate = ignored
          ? null
          : row.currency === book.functional_currency
            ? '1'
            : data.fxRate;
        const fxSource = ignored
          ? null
          : row.currency === book.functional_currency
            ? 'identity'
            : data.fxSource;
        const componentRows = await this.normalizedImportAmountComponents(
          client,
          context,
          bookId,
          rowId,
        );
        const componentSources = componentRows.map((component) =>
          FinanceNormalizedAmountComponentSourceSchema.parse({
            kind: component.kind,
            nativeAmount: component.nativeAmount,
            currency: component.currency,
            provenance: component.provenance,
          }),
        );
        let preparedComponents: ReturnType<
          typeof prepareFinanceNormalizedAmountComponents
        > = [];
        if (componentSources.length && data.action === 'match')
          throw new Error('finance-import-component-match-unsupported');
        if (componentSources.length && data.action === 'post') {
          if (!data.componentMappings?.length)
            throw new Error('finance-import-components-review-required');
          preparedComponents = prepareFinanceNormalizedAmountComponents({
            sources: componentSources,
            reviews: data.componentMappings,
            rowAmount: String(amount),
            rowCurrency: row.currency as FinanceCurrency,
            rowFxRate: String(fxRate),
            functionalCurrency: book.functional_currency as FinanceCurrency,
          });
          await this.validateNormalizedAmountComponentAccounts(
            client,
            context,
            bookId,
            preparedComponents.map((component) =>
              String(component.review.ledgerAccountId),
            ),
            String(row.financialAccountLedgerId),
          );
        } else if (!componentSources.length && data.componentMappings?.length)
          throw new Error('finance-import-component-kind-mismatch');
        if (!ignored) {
          if (
            !date ||
            !amount ||
            !description ||
            !fxRate ||
            !fxSource ||
            moneyValue(String(amount), row.currency as FinanceCurrency) ===
              0n ||
            parseFinanceDecimal(fxRate) <= 0n
          )
            throw new Error('finance-import-missing-facts-or-fx');
        }
        await client.query(
          `insert into emdo.finance_import_row_reviews(workspace_id,book_id,row_id,revision,decision,previous_facts,reviewed_by) values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
          [
            context.workspaceId,
            bookId,
            rowId,
            data.expectedRevision + 1,
            JSON.stringify(data),
            JSON.stringify({
              date: row.date,
              description: row.description,
              amount: row.amount,
              externalId: row.external_id,
            }),
            context.userId,
          ],
        );
        for (const component of preparedComponents)
          await client
            .query(
              `update emdo.finance_normalized_import_amount_components set reviewed_native_amount=$4,reviewed_currency=$5,inclusion=$6,posting_side=$7,ledger_account_id=$8,fx_rate=$9,fx_source=$10,revision=revision+1 where workspace_id=$1 and book_id=$2 and row_id=$3 and component_kind=$11 and revision=$12 returning id`,
              [
                context.workspaceId,
                bookId,
                rowId,
                component.review.nativeAmount,
                component.review.currency,
                component.review.inclusion,
                component.review.postingSide,
                component.review.ledgerAccountId,
                component.review.fxRate,
                component.review.fxSource,
                component.review.kind,
                componentRows.find(
                  (source) => source.kind === component.review.kind,
                )?.revision,
              ],
            )
            .then((result) => {
              if (result.rowCount !== 1)
                throw new Error('finance-import-component-revision-conflict');
            });
        await client.query(
          `update emdo.finance_normalized_import_rows set effective_on=$4,description=$5,native_amount=$6,external_id=$7,status=$8,revision=revision+1,counter_account_id=$9,match_journal_id=$10,fx_rate=$11,fx_source=$12,issues=$13::jsonb where workspace_id=$1 and book_id=$2 and id=$3`,
          [
            context.workspaceId,
            bookId,
            rowId,
            date,
            description,
            amount,
            externalId,
            ignored ? 'ignored' : 'ready',
            data.counterAccountId,
            data.matchJournalId,
            fxRate,
            fxSource,
            JSON.stringify(ignored ? row.issues : []),
          ],
        );
        const batch = (
          await client.query(
            `update emdo.finance_normalized_imports set revision=revision+1 where workspace_id=$1 and book_id=$2 and id=$3 returning revision`,
            [context.workspaceId, bookId, row.batch_id],
          )
        ).rows[0];
        return {
          id: rowId,
          revision: data.expectedRevision + 1,
          batchRevision: batch!.revision,
        };
      },
    );
  }

  commitNormalizedImport(
    context: WorkspaceContext,
    bookId: string,
    batchId: string,
    key: string,
    input: unknown,
  ) {
    UuidSchema.parse(batchId);
    const data = CommitNormalizedImportSchema.parse(input);
    return this.command(
      context,
      key,
      'import.commit',
      { batchId, ...data },
      bookId,
      (client) =>
        this.commitNormalizedImportInTransaction(
          client,
          context,
          bookId,
          batchId,
          data,
        ),
    );
  }

  /**
   * Only call inside an existing authenticated, scoped durable transaction;
   * this hook does not initialize session context or start a transaction. The caller
   * owns its command receipt, audit/event writes, and transaction completion.
   * Current book authorization and the canonical posting lock remain mandatory.
   */
  async commitNormalizedImportInTransaction(
    client: Pick<DatabaseClient, 'query'>,
    context: WorkspaceContext,
    bookId: string,
    batchId: string,
    input: unknown,
  ) {
    WorkspaceContextSchema.parse(context);
    UuidSchema.parse(batchId);
    const data = CommitNormalizedImportSchema.parse(input);
    const book = await this.book(client, context, bookId, true);
    if (!['administrator', 'approver'].includes(String(book.role)))
      throw new Error('finance-book-forbidden');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `${context.workspaceId}:${bookId}`,
    ]);
    const batch = (
      await client.query(
        `select i.*,a.currency,a.ledger_account_id,e.plaintext_sha256 from emdo.finance_normalized_imports i join emdo.finance_financial_accounts a on a.workspace_id=i.workspace_id and a.book_id=i.book_id and a.id=i.financial_account_id and a.active join emdo.finance_book_evidence e on e.workspace_id=i.workspace_id and e.book_id=i.book_id and e.id=i.evidence_id where i.workspace_id=$1 and i.book_id=$2 and i.id=$3`,
        [context.workspaceId, bookId, batchId],
      )
    ).rows[0];
    if (
      !batch ||
      batch.status !== 'review' ||
      batch.revision !== data.expectedRevision
    )
      throw new Error('finance-import-revision-conflict');
    const rows = (
      await client.query(
        `select r.*,effective_on::text as date,native_amount::text as amount,fx_rate::text as rate,v.decision from emdo.finance_normalized_import_rows r left join emdo.finance_import_row_reviews v on v.workspace_id=r.workspace_id and v.book_id=r.book_id and v.row_id=r.id and v.revision=r.revision where r.workspace_id=$1 and r.book_id=$2 and r.batch_id=$3 order by source_row`,
        [context.workspaceId, bookId, batchId],
      )
    ).rows;
    if (
      !rows.length ||
      rows.some(
        (r) => !['ready', 'ignored', 'committed'].includes(String(r.status)),
      )
    )
      throw new Error('finance-import-unresolved-rows');
    let posted = 0,
      matched = 0;
    for (const row of rows) {
      // A reviewed corporate action may already have claimed this cash
      // receipt. It is part of the batch's immutable history and must not
      // be posted a second time by the generic importer.
      if (row.status === 'ignored' || row.status === 'committed') continue;
      assertFinanceOfxRowReviewable(row.source_facts, row.external_id);
      const ofxSource = (
        row.source_facts as {
          ofxSource?: { sourceDigest: string; rawFitid: string | null };
        } | null
      )?.ofxSource;
      if (ofxSource && ofxSource.sourceDigest !== batch.plaintext_sha256)
        throw new Error('finance-ofx-source-binding-mismatch');
      const componentRows = await this.normalizedImportAmountComponents(
        client,
        context,
        bookId,
        String(row.id),
      );
      const componentSources = componentRows.map((component) =>
        FinanceNormalizedAmountComponentSourceSchema.parse({
          kind: component.kind,
          nativeAmount: component.nativeAmount,
          currency: component.currency,
          provenance: component.provenance,
        }),
      );
      const amount = formatFinanceDecimal(
          parseFinanceDecimal(String(row.amount)),
        ),
        rate = String(row.rate);
      let preparedComponents: ReturnType<
        typeof prepareFinanceNormalizedAmountComponents
      > = [];
      if (componentSources.length) {
        if (row.counter_account_id || row.match_journal_id)
          throw new Error('finance-import-component-target-conflict');
        if (
          componentRows.some(
            (component) =>
              component.reviewedNativeAmount === null ||
              component.reviewedNativeAmount === undefined ||
              component.reviewedCurrency === null ||
              component.reviewedCurrency === undefined ||
              component.inclusion === null ||
              component.inclusion === undefined ||
              component.postingSide === null ||
              component.postingSide === undefined ||
              component.ledgerAccountId === null ||
              component.ledgerAccountId === undefined ||
              component.fxRate === null ||
              component.fxRate === undefined ||
              component.fxSource === null ||
              component.fxSource === undefined,
          )
        )
          throw new Error('finance-import-components-review-required');
        const componentReviews =
          FinanceNormalizedAmountComponentReviewListSchema.parse(
            componentRows.map((component) => ({
              kind: component.kind,
              nativeAmount: component.reviewedNativeAmount,
              currency: component.reviewedCurrency,
              inclusion: component.inclusion,
              postingSide: component.postingSide,
              ledgerAccountId: component.ledgerAccountId,
              fxRate: component.fxRate,
              fxSource: component.fxSource,
            })),
          );
        preparedComponents = prepareFinanceNormalizedAmountComponents({
          sources: componentSources,
          reviews: componentReviews,
          rowAmount: amount,
          rowCurrency: batch.currency as FinanceCurrency,
          rowFxRate: rate,
          functionalCurrency: book.functional_currency as FinanceCurrency,
        });
        await this.validateNormalizedAmountComponentAccounts(
          client,
          context,
          bookId,
          preparedComponents.map((component) =>
            String(component.review.ledgerAccountId),
          ),
          String(batch.ledger_account_id),
        );
      }
      const factsHash = importHash([
        row.date,
        batch.currency,
        amount,
        String(row.description)
          .normalize('NFC')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase(),
        ...(componentSources.length
          ? [
              preparedComponents.map((component) => ({
                source: component.source,
                review: component.review,
              })),
            ]
          : []),
      ]);
      const fingerprint = importHash(
        row.external_id
          ? ['external', batch.financial_account_id, row.external_id]
          : [
              'source',
              batch.financial_account_id,
              batch.plaintext_sha256,
              row.source_row,
            ],
      );
      // Historical raw-FITID receipts retain their original identity. A source-scoped
      // import must explicitly match that prior journal before reusing the receipt.
      const legacyFingerprint = ofxSource?.rawFitid
        ? importHash([
            'external',
            batch.financial_account_id,
            ofxSource.rawFitid,
          ])
        : null;
      if (legacyFingerprint) {
        const legacy = (
          await client.query(
            'select journal_id from emdo.finance_economic_transactions where workspace_id=$1 and book_id=$2 and financial_account_id=$3 and fingerprint=$4',
            [
              context.workspaceId,
              bookId,
              batch.financial_account_id,
              legacyFingerprint,
            ],
          )
        ).rows[0];
        if (legacy && row.match_journal_id !== legacy.journal_id)
          throw new Error('finance-ofx-legacy-identity-match-required');
      }
      const existing = (
        await client.query(
          `select * from emdo.finance_economic_transactions where workspace_id=$1 and book_id=$2 and financial_account_id=$3 and (fingerprint=$4 or journal_id=$5::uuid) order by (fingerprint=$4) desc limit 1`,
          [
            context.workspaceId,
            bookId,
            batch.financial_account_id,
            fingerprint,
            row.match_journal_id,
          ],
        )
      ).rows[0];
      let transactionId = existing?.id,
        journalId = row.match_journal_id,
        status = 'matched';
      if (existing) {
        if (
          (existing.fingerprint === fingerprint &&
            existing.facts_hash !== factsHash) ||
          parseFinanceDecimal(String(existing.native_amount)) !==
            parseFinanceDecimal(amount) ||
          parseFinanceDecimal(String(existing.fx_rate)) !==
            parseFinanceDecimal(rate) ||
          (journalId && journalId !== existing.journal_id)
        )
          throw new Error('finance-import-duplicate-facts-conflict');
        if (componentSources.length) {
          const componentCount = (
            await client.query(
              `select count(*)::int as count from emdo.finance_economic_transaction_amount_components where workspace_id=$1 and book_id=$2 and economic_transaction_id=$3`,
              [context.workspaceId, bookId, existing.id],
            )
          ).rows[0]?.count;
          // A component-bearing duplicate may be safely classified as a
          // match only when its original committed component proof is
          // present. Otherwise this import would silently lose the
          // reviewed fee/tax/principal detail.
          if (Number(componentCount) !== componentSources.length)
            throw new Error(
              'finance-import-component-duplicate-facts-conflict',
            );
        }
      } else {
        const possible = (
          await client.query(
            `select id from emdo.finance_economic_transactions where workspace_id=$1 and book_id=$2 and financial_account_id=$3 and facts_hash=$4 limit 1`,
            [
              context.workspaceId,
              bookId,
              batch.financial_account_id,
              factsHash,
            ],
          )
        ).rows[0];
        const decision = row.decision as {
          acknowledgePossibleDuplicate?: boolean;
        } | null;
        if (!journalId && possible && !decision?.acknowledgePossibleDuplicate)
          throw new Error('finance-import-possible-duplicate-review-required');
        const functional = convertBookAmount(
          amount,
          rate,
          book.functional_currency as FinanceCurrency,
        );
        if (parseFinanceDecimal(functional) === 0n)
          throw new Error('finance-import-zero-functional-amount');
        if (!journalId) {
          const positive = parseFinanceDecimal(amount) > 0n,
            absolute = (v: string) => (v.startsWith('-') ? v.slice(1) : v),
            lines = [
              {
                accountId: batch.ledger_account_id,
                side: positive ? ('debit' as const) : ('credit' as const),
                amount: absolute(functional),
                currency: batch.currency,
                nativeAmount: absolute(amount),
                fxRate: rate,
                fxSource: row.fx_source,
                description: row.description,
              },
              ...preparedComponents
                .filter(
                  (component) =>
                    parseFinanceDecimal(component.functionalAmount) !== 0n,
                )
                .map((component) => ({
                  accountId: component.review.ledgerAccountId,
                  side: component.review.postingSide,
                  amount: absolute(component.functionalAmount),
                  currency: component.review.currency,
                  nativeAmount: absolute(component.review.nativeAmount),
                  fxRate: component.review.fxRate,
                  fxSource: component.review.fxSource,
                  description: `${row.description} · ${component.source.kind}`,
                })),
            ];
          journalId = (
            await this.insertJournal(
              client,
              context,
              bookId,
              `import:${row.id}`,
              {
                effectiveOn: row.date,
                description: row.description,
                sourceReference: `import:${batchId}:${row.source_row}`,
                lines: componentSources.length
                  ? lines
                  : [
                      lines[0]!,
                      {
                        accountId: row.counter_account_id,
                        side: positive
                          ? ('credit' as const)
                          : ('debit' as const),
                        amount: absolute(functional),
                        currency: book.functional_currency,
                        nativeAmount: absolute(functional),
                        fxRate: '1',
                        fxSource: 'identity',
                        description: row.description,
                      },
                    ],
              },
            )
          ).id;
          status = 'committed';
          posted++;
        }
        transactionId = randomUUID();
        await client.query(
          `insert into emdo.finance_economic_transactions(id,workspace_id,book_id,financial_account_id,effective_on,description,native_amount,functional_amount,fx_rate,fx_source,journal_id,fingerprint,facts_hash,external_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            transactionId,
            context.workspaceId,
            bookId,
            batch.financial_account_id,
            row.date,
            row.description,
            amount,
            functional,
            rate,
            row.fx_source,
            journalId,
            fingerprint,
            factsHash,
            row.external_id,
          ],
        );
        if (componentSources.length) {
          let lineNumber = 2;
          for (const component of preparedComponents) {
            const functionalAmount = parseFinanceDecimal(
                component.functionalAmount,
              ),
              sourceComponent = componentRows.find(
                (source) => source.kind === component.source.kind,
              );
            if (!sourceComponent)
              throw new Error('finance-import-component-kind-mismatch');
            await client.query(
              `insert into emdo.finance_economic_transaction_amount_components(id,workspace_id,book_id,economic_transaction_id,source_component_id,component_kind,native_amount,currency,functional_amount,inclusion,posting_side,ledger_account_id,fx_rate,fx_source,journal_id,journal_line_number,source_provenance) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
              [
                randomUUID(),
                context.workspaceId,
                bookId,
                transactionId,
                sourceComponent.id,
                component.source.kind,
                component.review.nativeAmount,
                component.review.currency,
                component.functionalAmount,
                component.review.inclusion,
                component.review.postingSide,
                component.review.ledgerAccountId,
                component.review.fxRate,
                component.review.fxSource,
                journalId,
                functionalAmount === 0n ? null : lineNumber,
                JSON.stringify(component.source.provenance),
              ],
            );
            if (functionalAmount !== 0n) lineNumber++;
          }
        }
      }
      if (status === 'matched') matched++;
      await client.query(
        `update emdo.finance_normalized_import_rows set status=$4,economic_transaction_id=$5 where workspace_id=$1 and book_id=$2 and id=$3`,
        [context.workspaceId, bookId, row.id, status, transactionId],
      );
    }
    await client.query(
      `update emdo.finance_normalized_imports set status='committed',revision=revision+1 where workspace_id=$1 and book_id=$2 and id=$3`,
      [context.workspaceId, bookId, batchId],
    );
    return {
      id: batchId,
      revision: data.expectedRevision + 1,
      posted,
      matched,
    };
  }

  downloadBookEvidence(
    context: WorkspaceContext,
    bookId: string,
    evidenceId: string,
  ) {
    UuidSchema.parse(evidenceId);
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      const cipher = this.options.evidenceCipher;
      if (!cipher)
        throw new FinanceV2PersistenceError(
          'unavailable',
          'Encrypted evidence storage is unavailable',
        );
      const row = (
        await client.query(
          `select * from emdo.finance_book_evidence where workspace_id=$1 and book_id=$2 and id=$3`,
          [context.workspaceId, bookId, evidenceId],
        )
      ).rows[0];
      if (!row) throw new Error('finance-evidence-unavailable');
      const value = await cipher.decrypt(row.encrypted_original, {
        workspaceId: context.workspaceId,
        bookId,
        documentId: evidenceId,
      });
      if (['xlsx', 'pdf', 'png', 'jpeg', 'webp'].includes(String(row.format))) {
        if (
          !value ||
          typeof value !== 'object' ||
          !('sourceBase64' in value) ||
          typeof value.sourceBase64 !== 'string'
        )
          throw new Error('finance-evidence-integrity-failed');
        const bytes = Buffer.from(value.sourceBase64, 'base64');
        if (
          bytes.toString('base64') !== value.sourceBase64 ||
          bytes.length !== row.byte_size ||
          createHash('sha256').update(bytes).digest('hex') !==
            row.plaintext_sha256
        )
          throw new Error('finance-evidence-integrity-failed');
        return {
          filename: String(row.filename),
          format: row.format as 'xlsx' | 'pdf' | 'png' | 'jpeg' | 'webp',
          sourceBase64: value.sourceBase64,
        };
      }
      if (!['csv', 'ofx', 'qfx', 'ubl', 'cii'].includes(String(row.format)))
        throw new Error('finance-evidence-format-unavailable');
      if (
        !value ||
        typeof value !== 'object' ||
        !('sourceText' in value) ||
        typeof value.sourceText !== 'string' ||
        Buffer.byteLength(value.sourceText) !== row.byte_size ||
        createHash('sha256').update(value.sourceText).digest('hex') !==
          row.plaintext_sha256
      )
        throw new Error('finance-evidence-integrity-failed');
      return {
        filename: row.filename,
        format: row.format as 'csv' | 'ofx' | 'qfx' | 'ubl' | 'cii',
        sourceText: value.sourceText,
      };
    });
  }

  private async savedImageInspection(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    evidenceId: string,
    selection: { standardizationRunId: string; extractionRevision: number },
  ) {
    UuidSchema.parse(evidenceId);
    UuidSchema.parse(selection.standardizationRunId);
    if (
      !Number.isInteger(selection.extractionRevision) ||
      selection.extractionRevision < 1 ||
      selection.extractionRevision > 3
    )
      throw new Error('finance-image-extraction-revision-invalid');
    const resultRow = (
      await client.query(
        'select emdo.read_finance_image_extraction($1,$2,$3,$4,$5) as value',
        [
          context.workspaceId,
          bookId,
          evidenceId,
          selection.standardizationRunId,
          selection.extractionRevision,
        ],
      )
    ).rows[0]?.value;
    const result = z
      .strictObject({
        factsJson: z.string().max(262144),
        sourceDigest: Sha256Schema,
        extractionDigest: Sha256Schema,
      })
      .parse(resultRow);
    if (
      !result ||
      typeof result.factsJson !== 'string' ||
      Buffer.byteLength(result.factsJson) > 262144 ||
      createHash('sha256').update(result.factsJson).digest('hex') !==
        result.extractionDigest
    )
      throw new Error('finance-image-extraction-integrity-failed');
    const facts = FinanceImageOcrFactsSchema.parse(
      JSON.parse(result.factsJson),
    );
    const inspection = FinanceImageInspectionSchema.parse({
      evidenceId,
      standardizationRunId: selection.standardizationRunId,
      extractionRevision: selection.extractionRevision,
      extractionDigest: result.extractionDigest,
      sourceDigest: result.sourceDigest,
      wordInventoryDigest: importHash(facts.words),
      facts,
    });
    return {
      inspection,
      saved: {
        standardizationRunId: selection.standardizationRunId,
        extractionRevision: selection.extractionRevision,
        extractionDigest: result.extractionDigest as string,
        factsJson: result.factsJson as string,
      },
    };
  }

  readImageInspection(
    context: WorkspaceContext,
    bookId: string,
    evidenceId: string,
    selection: { standardizationRunId: string; extractionRevision: number },
  ) {
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      return (
        await this.savedImageInspection(
          client,
          context,
          bookId,
          evidenceId,
          selection,
        )
      ).inspection;
    });
  }

  readPdfOcrInspection(
    context: WorkspaceContext,
    bookId: string,
    evidenceId: string,
    selection: { standardizationRunId: string; extractionRevision: number },
  ) {
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      UuidSchema.parse(evidenceId);
      UuidSchema.parse(selection.standardizationRunId);
      z.number().int().min(1).max(3).parse(selection.extractionRevision);
      const verify = this.options.pdfOcrEvidenceVerifier;
      if (!verify) throw new Error('finance-pdf-ocr-verifier-unavailable');
      const result = z
        .strictObject({
          factsJson: z.string().max(262144),
          sourceDigest: Sha256Schema,
          extractionDigest: Sha256Schema,
        })
        .parse(
          (
            await client.query(
              'select emdo.read_finance_pdf_ocr_extraction($1,$2,$3,$4,$5) as value',
              [
                context.workspaceId,
                bookId,
                evidenceId,
                selection.standardizationRunId,
                selection.extractionRevision,
              ],
            )
          ).rows[0]?.value,
        );
      if (
        Buffer.byteLength(result.factsJson) > 262144 ||
        createHash('sha256').update(result.factsJson).digest('hex') !==
          result.extractionDigest
      )
        throw new Error('finance-pdf-ocr-extraction-integrity-failed');
      const { inventory } = verify({
        factsJson: result.factsJson,
        expectedExtractionDigest: result.extractionDigest,
        expectedSourceDigest: result.sourceDigest,
      });
      return FinancePdfOcrInspectionSchema.parse({
        evidenceId,
        ...selection,
        sourceDigest: result.sourceDigest,
        extractionDigest: result.extractionDigest,
        inventory,
      });
    });
  }

  private async reviewedPdfOcrTable(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    evidenceId: string,
    definition: ReturnType<typeof FinanceReportMappingDefinitionSchema.parse>,
  ) {
    const selection = definition.pdfOcrSelection;
    const {
      evidenceCipher: cipher,
      pdfOcrEvidenceVerifier: verify,
      pdfOcrPageRenderer: render,
      reviewedPdfOcrExtractor: extract,
    } = this.options;
    if (!selection || !cipher || !verify || !render || !extract)
      throw new FinanceV2PersistenceError(
        'unavailable',
        'Reviewed PDF OCR extraction is unavailable',
      );
    const evidence = (
      await client.query(
        'select * from emdo.finance_book_evidence where workspace_id=$1 and book_id=$2 and id=$3',
        [context.workspaceId, bookId, evidenceId],
      )
    ).rows[0];
    if (!evidence || evidence.format !== 'pdf')
      throw new Error('finance-reviewed-pdf-ocr-evidence-required');
    const saved = z
      .strictObject({
        factsJson: z.string().max(262144),
        sourceDigest: Sha256Schema,
        extractionDigest: Sha256Schema,
      })
      .parse(
        (
          await client.query(
            'select emdo.read_finance_pdf_ocr_extraction($1,$2,$3,$4,$5) as value',
            [
              context.workspaceId,
              bookId,
              evidenceId,
              selection.standardizationRunId,
              selection.extractionRevision,
            ],
          )
        ).rows[0]?.value,
      );
    if (
      Buffer.byteLength(saved.factsJson) > 262144 ||
      createHash('sha256').update(saved.factsJson).digest('hex') !==
        saved.extractionDigest
    )
      throw new Error('finance-pdf-ocr-extraction-integrity-failed');
    const { inventory } = verify({
      factsJson: saved.factsJson,
      expectedExtractionDigest: saved.extractionDigest,
      expectedSourceDigest: saved.sourceDigest,
    });
    const page = inventory.pages.find(
      (page) => page.pageNumber === selection.pageNumber,
    );
    if (
      page?.kind !== 'ocr' ||
      inventory.sourceDigest !== saved.sourceDigest ||
      selection.expectedSourceDigest !== saved.sourceDigest ||
      selection.expectedExtractionDigest !== saved.extractionDigest
    )
      throw new Error('finance-pdf-ocr-review-binding-mismatch');
    const original = z.object({ sourceBase64: z.string() }).parse(
      await cipher.decrypt(evidence.encrypted_original, {
        workspaceId: context.workspaceId,
        bookId,
        documentId: evidenceId,
      }),
    );
    const bytes = Buffer.from(original.sourceBase64, 'base64');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (
      !bytes.length ||
      bytes.length > 2097152 ||
      bytes.length !== evidence.byte_size ||
      bytes.toString('base64') !== original.sourceBase64 ||
      digest !== evidence.plaintext_sha256 ||
      digest !== saved.sourceDigest
    )
      throw new Error('finance-evidence-integrity-failed');
    const rendered = await render({
      bytes,
      expectedSourceDigest: digest,
      pageNumber: selection.pageNumber,
      scale: page.result.render.scale,
      signal: AbortSignal.timeout(15000),
    });
    if (rendered.status !== 'rendered')
      throw new FinanceV2PersistenceError(
        'unavailable',
        'PDF page regeneration is unavailable',
      );
    const regenerated = FinancePdfPageRenderSchema.parse(rendered.render);
    if (
      importHash(regenerated) !== importHash(page.result.render) ||
      createHash('sha256').update(rendered.png).digest('hex') !==
        regenerated.renderedImageDigest
    )
      throw new Error('finance-pdf-ocr-regenerated-raster-mismatch');
    const table = ExtractedFinanceReportTableSchema.parse(
      extract(
        bytes,
        rendered.png,
        selection,
        {
          ...saved,
          standardizationRunId: selection.standardizationRunId,
          extractionRevision: selection.extractionRevision,
        },
        {
          documentId: evidenceId,
          extractionRevision: selection.extractionRevision,
          providerKey: definition.providerKey,
          reportType: definition.reportType,
        },
      ).table,
    );
    const review = table.extractionReview;
    if (
      table.documentId !== evidenceId ||
      table.extractionRevision !== selection.extractionRevision ||
      table.page !== selection.pageNumber ||
      table.providerKey !== definition.providerKey ||
      table.reportType !== definition.reportType ||
      review?.version !== 'reviewed-pdf-ocr.v1' ||
      review.sourceDigest !== digest ||
      review.selectionDigest !== importHash(selection) ||
      review.standardizationRunId !== selection.standardizationRunId ||
      review.ocrExtractionRevision !== selection.extractionRevision ||
      review.ocrExtractionDigest !== saved.extractionDigest ||
      importHash(review.render) !== importHash(regenerated) ||
      !table.pdfOcrCellProvenance ||
      table.imageCellProvenance ||
      table.pdfCellProvenance
    )
      throw new Error('finance-evidence-integrity-failed');
    return table;
  }

  private async reviewedImageTable(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    evidenceId: string,
    definition: ReturnType<typeof FinanceReportMappingDefinitionSchema.parse>,
  ) {
    const selection = definition.imageSelection;
    if (!selection) throw new Error('finance-image-source-review-required');
    const evidence = (
      await client.query(
        'select * from emdo.finance_book_evidence where workspace_id=$1 and book_id=$2 and id=$3',
        [context.workspaceId, bookId, evidenceId],
      )
    ).rows[0];
    if (!evidence || !['png', 'jpeg', 'webp'].includes(String(evidence.format)))
      throw new Error('finance-reviewed-image-evidence-required');
    const cipher = this.options.evidenceCipher,
      extract = this.options.reviewedImageExtractor;
    if (!cipher || !extract)
      throw new FinanceV2PersistenceError(
        'unavailable',
        'Reviewed image extraction is unavailable',
      );
    const { inspection, saved } = await this.savedImageInspection(
      client,
      context,
      bookId,
      evidenceId,
      selection,
    );
    const original = await cipher.decrypt(evidence.encrypted_original, {
      workspaceId: context.workspaceId,
      bookId,
      documentId: evidenceId,
    });
    if (
      !original ||
      typeof original !== 'object' ||
      !('sourceBase64' in original) ||
      typeof original.sourceBase64 !== 'string'
    )
      throw new Error('finance-evidence-integrity-failed');
    const bytes = Buffer.from(original.sourceBase64, 'base64');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (
      bytes.length !== evidence.byte_size ||
      bytes.toString('base64') !== original.sourceBase64 ||
      digest !== evidence.plaintext_sha256 ||
      inspection.sourceDigest !== digest ||
      inspection.facts.format !== evidence.format
    )
      throw new Error('finance-evidence-integrity-failed');
    const result = extract(bytes, selection, saved, {
      documentId: evidenceId,
      extractionRevision: 1,
      providerKey: definition.providerKey,
      reportType: definition.reportType,
    });
    const table = ExtractedFinanceReportTableSchema.parse(result.table);
    if (
      table.documentId !== evidenceId ||
      table.extractionRevision !== 1 ||
      table.providerKey !== definition.providerKey ||
      table.reportType !== definition.reportType ||
      table.extractionReview?.version !== 'reviewed-image.v1' ||
      table.extractionReview.sourceDigest !== digest ||
      table.extractionReview.selectionDigest !== importHash(selection) ||
      table.extractionReview.ocrExtractionDigest !== saved.extractionDigest ||
      !table.imageCellProvenance
    )
      throw new Error('finance-evidence-integrity-failed');
    return table;
  }

  private async reviewedSourceTable(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    evidenceId: string,
    definition: ReturnType<typeof FinanceReportMappingDefinitionSchema.parse>,
  ) {
    if (definition.pdfOcrSelection)
      return this.reviewedPdfOcrTable(
        client,
        context,
        bookId,
        evidenceId,
        definition,
      );
    if (definition.imageSelection)
      return this.reviewedImageTable(
        client,
        context,
        bookId,
        evidenceId,
        definition,
      );
    const evidence = (
      await client.query(
        'select * from emdo.finance_book_evidence where workspace_id=$1 and book_id=$2 and id=$3',
        [context.workspaceId, bookId, evidenceId],
      )
    ).rows[0];
    const format = definition.pdfSelection ? 'pdf' : 'xlsx';
    const selection = definition.pdfSelection ?? definition.xlsxSelection;
    if (!evidence || evidence.format !== format || !selection)
      throw new Error(`finance-reviewed-${format}-evidence-required`);
    const cipher = this.options.evidenceCipher,
      extract =
        format === 'pdf'
          ? this.options.reviewedPdfExtractor
          : this.options.reviewedXlsxExtractor;
    if (!cipher || !extract)
      throw new FinanceV2PersistenceError(
        'unavailable',
        `Reviewed ${format.toUpperCase()} extraction is unavailable`,
      );
    const original = await cipher.decrypt(evidence.encrypted_original, {
      workspaceId: context.workspaceId,
      bookId,
      documentId: evidenceId,
    });
    if (
      !original ||
      typeof original !== 'object' ||
      !('sourceBase64' in original) ||
      typeof original.sourceBase64 !== 'string'
    )
      throw new Error('finance-evidence-integrity-failed');
    const bytes = Buffer.from(original.sourceBase64, 'base64');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (
      bytes.length !== evidence.byte_size ||
      bytes.toString('base64') !== original.sourceBase64 ||
      digest !== evidence.plaintext_sha256
    )
      throw new Error('finance-evidence-integrity-failed');
    const result = await extract(bytes, selection, {
      documentId: evidenceId,
      extractionRevision: 1,
      providerKey: definition.providerKey,
      reportType: definition.reportType,
    });
    if (
      result.reviewFacts.sourceDigest !== digest ||
      result.reviewFacts.selectionDigest !== importHash(selection)
    )
      throw new Error('finance-evidence-integrity-failed');
    const table = ExtractedFinanceReportTableSchema.parse(result.table);
    if (
      table.documentId !== evidenceId ||
      table.extractionRevision !== 1 ||
      table.providerKey !== definition.providerKey ||
      table.reportType !== definition.reportType
    )
      throw new Error('finance-evidence-integrity-failed');
    return ExtractedFinanceReportTableSchema.parse({
      ...table,
      ...(format === 'pdf' && 'cellProvenance' in result
        ? { pdfCellProvenance: result.cellProvenance }
        : {}),
      extractionReview: {
        version: format === 'pdf' ? 'reviewed-pdf.v1' : 'reviewed-xlsx.v1',
        ...(format === 'pdf'
          ? {
              coverage: 'selected-spans-only',
              rowNumbering: 'logical-selection-order-not-pdf-row-numbers',
            }
          : {}),
        sourceDigest: digest,
        selectionDigest: result.reviewFacts.selectionDigest,
      },
    });
  }

  private saveReportMappingCandidate(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    data: ParsedReportMappingData,
    proposedByModel: 'gpt-6-astra' | null,
    modelProvenance: ReportMappingModelProvenance | undefined,
    resolveExample: (
      client: DatabaseClient,
      definition: ReturnType<typeof FinanceReportMappingDefinitionSchema.parse>,
      data: ParsedReportMappingData,
    ) => Promise<unknown | undefined>,
  ) {
    if (modelProvenance)
      for (const value of Object.values(modelProvenance))
        UuidSchema.parse(value);
    return this.command(
      context,
      key,
      'report.mapping.propose',
      { data, proposedByModel, modelProvenance },
      bookId,
      async (client) => {
        const definition = data.proposal.definition,
          id = randomUUID(),
          example = await resolveExample(client, definition, data);
        if (!example) throw new Error('finance-report-example-required');
        const validation = normalizeExtractedReport(definition, example);
        const version = Number(
          (
            await client.query(
              `select coalesce(max(version),0)+1 as version from emdo.finance_report_mapping_versions where workspace_id=$1 and book_id=$2 and provider_key=$3 and report_name=$4 and report_type=$5`,
              [
                context.workspaceId,
                bookId,
                definition.providerKey,
                definition.reportName,
                definition.reportType,
              ],
            )
          ).rows[0]!.version,
        );
        await client.query(
          `insert into emdo.finance_report_mapping_versions(id,workspace_id,book_id,provider_key,report_name,report_type,layout_version,version,definition,rationale,unresolved_questions,example,evidence_id,validation,proposed_by_model,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13,$14::jsonb,$15,$16)`,
          [
            id,
            context.workspaceId,
            bookId,
            definition.providerKey,
            definition.reportName,
            definition.reportType,
            definition.layoutVersion,
            version,
            JSON.stringify(definition),
            data.proposal.rationale,
            JSON.stringify(data.proposal.unresolvedQuestions),
            JSON.stringify(example),
            (example as { documentId: string }).documentId,
            JSON.stringify(validation),
            proposedByModel,
            context.userId,
          ],
        );
        return {
          id,
          version,
          revision: 1,
          status: 'candidate',
          validationStatus: validation.status,
          modelProvenance: modelProvenance ?? null,
        };
      },
    );
  }

  saveReportMapping(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
    proposedByModel: 'gpt-6-astra' | null = null,
    modelProvenance?: ReportMappingModelProvenance,
  ) {
    const legacy = SaveFinanceReportMappingSchema.safeParse(input);
    const data = legacy.success
      ? legacy.data
      : SaveReviewedFinanceSourceMappingSchema.parse(input);
    return this.saveReportMappingCandidate(
      context,
      bookId,
      key,
      data,
      proposedByModel,
      modelProvenance,
      async (client, definition, candidate) =>
        definition.xlsxSelection ||
        definition.pdfSelection ||
        definition.imageSelection ||
        definition.pdfOcrSelection
          ? await this.reviewedSourceTable(
              client,
              context,
              bookId,
              'example' in candidate
                ? candidate.example.documentId
                : candidate.evidenceId,
              definition,
            )
          : 'example' in candidate
            ? candidate.example
            : undefined,
    );
  }

  /**
   * Saves a CSV mapping candidate from the encrypted evidence itself. This
   * boundary deliberately accepts no extracted rows or model example: the
   * stored source digest is checked before the trusted parser runs.
   */
  saveSourceReportMapping(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
    proposedByModel: 'gpt-6-astra' | null = null,
    modelProvenance?: ReportMappingModelProvenance,
  ) {
    const data = SaveFinanceReportMappingFromSourceSchema.parse(input);
    return this.saveReportMappingCandidate(
      context,
      bookId,
      key,
      data,
      proposedByModel,
      modelProvenance,
      async (client, definition) => {
        const evidence = (
          await client.query(
            `select * from emdo.finance_book_evidence where workspace_id=$1 and book_id=$2 and id=$3`,
            [context.workspaceId, bookId, data.evidenceId],
          )
        ).rows[0];
        if (!evidence || evidence.format !== 'csv')
          throw new Error('finance-csv-report-evidence-required');
        const cipher = this.options.evidenceCipher;
        if (!cipher)
          throw new FinanceV2PersistenceError(
            'unavailable',
            'Encrypted evidence storage is unavailable',
          );
        const original = await cipher.decrypt(evidence.encrypted_original, {
          workspaceId: context.workspaceId,
          bookId,
          documentId: data.evidenceId,
        });
        if (
          !original ||
          typeof original !== 'object' ||
          !('sourceText' in original) ||
          typeof original.sourceText !== 'string'
        )
          throw new Error('finance-evidence-integrity-failed');
        const bytes = Buffer.from(original.sourceText, 'utf8');
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (
          bytes.length !== evidence.byte_size ||
          digest !== evidence.plaintext_sha256
        )
          throw new Error('finance-evidence-integrity-failed');
        if (digest !== data.expectedSourceDigest)
          throw new FinanceV2PersistenceError(
            'invalid-input',
            'Expected source digest does not match the stored evidence',
          );
        const extracted = extractFinanceCsvTable(original.sourceText);
        return ExtractedFinanceReportTableSchema.parse({
          ...extracted,
          documentId: data.evidenceId,
          extractionRevision: 1,
          tableId: 'csv-table-1',
          page: null,
          sheet: 'CSV',
          providerKey: definition.providerKey,
          reportType: definition.reportType,
          context: { asOf: null, currency: null },
          extractionReview: {
            version: 'reviewed-csv.v1',
            sourceDigest: digest,
            selectionDigest: importHash({
              adapter: 'finance.csv-table',
              version: 1,
            }),
          },
        });
      },
    );
  }

  reviewReportMapping(
    context: WorkspaceContext,
    bookId: string,
    mappingId: string,
    key: string,
    input: unknown,
  ) {
    UuidSchema.parse(mappingId);
    const data = ReviewFinanceReportMappingSchema.parse(input);
    return this.command(
      context,
      key,
      'report.mapping.review',
      { mappingId, ...data },
      bookId,
      async (client) => {
        const mapping = (
          await client.query(
            `select revision from emdo.finance_report_mapping_versions where workspace_id=$1 and book_id=$2 and id=$3`,
            [context.workspaceId, bookId, mappingId],
          )
        ).rows[0];
        if (!mapping || mapping.revision !== data.expectedRevision)
          throw new Error('finance-mapping-revision-conflict');
        await client.query(
          `insert into emdo.finance_report_mapping_reviews(workspace_id,book_id,mapping_id,revision,decision,reason,reviewed_by) values($1,$2,$3,$4,$5,$6,$7)`,
          [
            context.workspaceId,
            bookId,
            mappingId,
            data.expectedRevision + 1,
            data.decision,
            data.reason,
            context.userId,
          ],
        );
        const status = data.decision === 'approve' ? 'approved' : 'retired';
        await client.query(
          `update emdo.finance_report_mapping_versions set status=$4,revision=revision+1 where workspace_id=$1 and book_id=$2 and id=$3`,
          [context.workspaceId, bookId, mappingId, status],
        );
        return { id: mappingId, revision: data.expectedRevision + 1, status };
      },
    );
  }

  listReportMappings(context: WorkspaceContext, bookId: string, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
      throw new FinanceV2PersistenceError(
        'invalid-input',
        'Invalid mapping page',
      );
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      const rows = (
        await client.query(
          `select id,provider_key as "providerKey",report_name as "reportName",report_type as "reportType",layout_version as "layoutVersion",version,revision,status,proposed_by_model as "proposedByModel",validation->>'status' as "validationStatus" from emdo.finance_report_mapping_versions where workspace_id=$1 and book_id=$2 order by created_at,id limit 51 offset $3`,
          [context.workspaceId, bookId, offset],
        )
      ).rows;
      return {
        mappings: rows.slice(0, 50),
        nextOffset: rows.length > 50 ? offset + 50 : null,
      };
    });
  }

  getReportMapping(
    context: WorkspaceContext,
    bookId: string,
    mappingId: string,
  ) {
    UuidSchema.parse(mappingId);
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      const mapping = (
        await client.query(
          `select m.*,e.format as evidence_format,e.filename as evidence_filename from emdo.finance_report_mapping_versions m join emdo.finance_book_evidence e on e.workspace_id=m.workspace_id and e.book_id=m.book_id and e.id=m.evidence_id where m.workspace_id=$1 and m.book_id=$2 and m.id=$3`,
          [context.workspaceId, bookId, mappingId],
        )
      ).rows[0];
      if (!mapping) throw new Error('finance-mapping-unavailable');
      const reviews = (
        await client.query(
          `select revision,decision,reason,reviewed_by as "reviewedBy",created_at as "createdAt" from emdo.finance_report_mapping_reviews where workspace_id=$1 and book_id=$2 and mapping_id=$3 order by revision`,
          [context.workspaceId, bookId, mappingId],
        )
      ).rows;
      return { mapping, reviews };
    });
  }

  applyReportMapping(
    context: WorkspaceContext,
    bookId: string,
    mappingId: string,
    input: unknown,
  ) {
    UuidSchema.parse(mappingId);
    let table = ExtractedFinanceReportTableSchema.parse(input);
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${context.workspaceId}:${bookId}`],
      );
      const mapping = (
        await client.query(
          `select version,definition,example from emdo.finance_report_mapping_versions where workspace_id=$1 and book_id=$2 and id=$3 and status='approved'`,
          [context.workspaceId, bookId, mappingId],
        )
      ).rows[0];
      if (!mapping) throw new Error('finance-approved-mapping-required');
      const evidence = (
        await client.query(
          `select id from emdo.finance_book_evidence where workspace_id=$1 and book_id=$2 and id=$3`,
          [context.workspaceId, bookId, table.documentId],
        )
      ).rows[0];
      if (!evidence) throw new Error('finance-evidence-unavailable');
      const definition = FinanceReportMappingDefinitionSchema.parse(
        mapping.definition,
      );
      if (
        definition.pdfSelection ||
        definition.imageSelection ||
        definition.pdfOcrSelection
      ) {
        const saved = ExtractedFinanceReportTableSchema.parse(mapping.example);
        if (saved.documentId !== table.documentId)
          throw new Error('finance-pdf-source-review-required');
        table = await this.reviewedSourceTable(
          client,
          context,
          bookId,
          table.documentId,
          definition,
        );
        if (
          table.extractionReview?.sourceDigest !==
            saved.extractionReview?.sourceDigest ||
          table.extractionReview?.selectionDigest !==
            saved.extractionReview?.selectionDigest
        )
          throw new Error('finance-pdf-source-review-required');
      }
      return {
        mappingId,
        mappingVersion: mapping.version,
        commitAuthority: 'none' as const,
        ...normalizeExtractedReport(mapping.definition, table),
      };
    });
  }

  importMappedReport(
    context: WorkspaceContext,
    bookId: string,
    mappingId: string,
    key: string,
    input: unknown,
  ) {
    UuidSchema.parse(mappingId);
    const data = ImportMappedFinanceReportSchema.parse(input);
    return this.command(
      context,
      key,
      'import.mapped-report',
      { mappingId, ...data },
      bookId,
      async (client) => {
        const mapping = (
          await client.query(
            `select version,definition,example from emdo.finance_report_mapping_versions where workspace_id=$1 and book_id=$2 and id=$3 and status='approved'`,
            [context.workspaceId, bookId, mappingId],
          )
        ).rows[0];
        if (!mapping || mapping.version !== data.expectedMappingVersion)
          throw new Error('finance-approved-mapping-required');
        const definition = FinanceReportMappingDefinitionSchema.parse(
          mapping.definition,
        );
        const account = (
          await client.query(
            `select currency,kind from emdo.finance_financial_accounts where workspace_id=$1 and book_id=$2 and id=$3 and active`,
            [context.workspaceId, bookId, data.financialAccountId],
          )
        ).rows[0];
        if (!account) throw new Error('finance-financial-account-unavailable');
        const evidence = (
          await client.query(
            `select * from emdo.finance_book_evidence where workspace_id=$1 and book_id=$2 and id=$3`,
            [context.workspaceId, bookId, data.evidenceId],
          )
        ).rows[0];
        if (
          !evidence ||
          (definition.xlsxSelection
            ? evidence.format !== 'xlsx'
            : definition.pdfSelection || definition.pdfOcrSelection
              ? evidence.format !== 'pdf'
              : definition.imageSelection
                ? !['png', 'jpeg', 'webp'].includes(String(evidence.format))
                : evidence.format !== 'csv')
        )
          throw new Error('finance-report-evidence-format-mismatch');
        let table;
        if (
          definition.xlsxSelection ||
          definition.pdfSelection ||
          definition.imageSelection ||
          definition.pdfOcrSelection
        ) {
          table = await this.reviewedSourceTable(
            client,
            context,
            bookId,
            data.evidenceId,
            definition,
          );
          const reviewedExample = ExtractedFinanceReportTableSchema.parse(
            mapping.example,
          );
          if (
            reviewedExample.documentId !== data.evidenceId ||
            reviewedExample.extractionReview?.sourceDigest !==
              table.extractionReview?.sourceDigest ||
            reviewedExample.extractionReview?.selectionDigest !==
              table.extractionReview?.selectionDigest
          )
            throw new Error(
              definition.pdfSelection || definition.pdfOcrSelection
                ? 'finance-pdf-source-review-required'
                : definition.imageSelection
                  ? 'finance-image-source-review-required'
                  : 'finance-xlsx-source-review-required',
            );
          // Each new original needs its own reviewed selection, even when headings match.
          // Provider identity remains caller-declared and is checked by normalization.
          table = { ...table, providerKey: data.providerKey };
        } else {
          const cipher = this.options.evidenceCipher;
          if (!cipher)
            throw new FinanceV2PersistenceError(
              'unavailable',
              'Encrypted evidence storage is unavailable',
            );
          const original = await cipher.decrypt(evidence.encrypted_original, {
            workspaceId: context.workspaceId,
            bookId,
            documentId: data.evidenceId,
          });
          if (
            !original ||
            typeof original !== 'object' ||
            !('sourceText' in original) ||
            typeof original.sourceText !== 'string' ||
            Buffer.byteLength(original.sourceText) !== evidence.byte_size ||
            createHash('sha256').update(original.sourceText).digest('hex') !==
              evidence.plaintext_sha256
          )
            throw new Error('finance-evidence-integrity-failed');
          table = {
            ...extractFinanceCsvTable(original.sourceText),
            documentId: data.evidenceId,
            extractionRevision: 1,
            tableId: 'csv:1',
            page: null,
            sheet: 'CSV',
            providerKey: data.providerKey,
            reportType: definition.reportType,
            context: { asOf: null, currency: null },
          };
        }
        const normalized = normalizeExtractedReport(mapping.definition, table);
        if (normalized.status !== 'normalized')
          throw new Error('finance-report-revalidation-required');
        if (definition.reportType === 'investment-positions') {
          if (account.kind !== 'brokerage')
            throw new Error('finance-brokerage-account-required');
          const observedPositionIds: string[] = [];
          const seen = new Set<string>();
          for (const row of normalized.rows) {
            const instrument = (
              await client.query(
                `select i.id,i.quantity_unit,i.valuation_multiplier::text as multiplier from emdo.finance_instrument_identifiers n join emdo.finance_instruments i on i.workspace_id=n.workspace_id and i.book_id=n.book_id and i.id=n.instrument_id where n.workspace_id=$1 and n.book_id=$2 and n.scheme=$3 and n.namespace=$4 and n.value=$5`,
                [
                  context.workspaceId,
                  bookId,
                  definition.identifierScheme,
                  definition.identifierNamespace,
                  row.fields.instrumentIdentifier,
                ],
              )
            ).rows[0];
            if (!instrument)
              throw new Error('finance-report-instrument-unresolved');
            if (
              instrument.quantity_unit !== definition.quantityUnit ||
              (row.fields.price !== undefined &&
                row.fields.price !== null &&
                parseFinanceDecimal(String(instrument.multiplier)) !==
                  parseFinanceDecimal(definition.valuationMultiplier!))
            )
              throw new Error('finance-report-instrument-units-mismatch');
            const identity = `${String(instrument.id)}:${row.fields.asOf}`;
            if (seen.has(identity))
              throw new Error(
                'finance-report-duplicate-position-review-required',
              );
            seen.add(identity);
            const existing = (
              await client.query(
                `select id from emdo.finance_observed_positions where workspace_id=$1 and book_id=$2 and financial_account_id=$3 and evidence_id=$4 and mapping_id=$5 and source_row=$6`,
                [
                  context.workspaceId,
                  bookId,
                  data.financialAccountId,
                  data.evidenceId,
                  mappingId,
                  row.sourceRow,
                ],
              )
            ).rows[0];
            if (existing) {
              observedPositionIds.push(String(existing.id));
              continue;
            }
            const observationId = randomUUID();
            await client.query(
              `insert into emdo.finance_observed_positions(id,workspace_id,book_id,financial_account_id,instrument_id,as_of,quantity,reported_market_value,reported_book_cost,reported_price,reported_accrued_interest,currency,evidence_id,source_row,mapping_id,source_facts) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
              [
                observationId,
                context.workspaceId,
                bookId,
                data.financialAccountId,
                instrument.id,
                row.fields.asOf,
                row.fields.quantity,
                row.fields.marketValue ?? null,
                row.fields.bookCost ?? null,
                row.fields.price ?? null,
                row.fields.accruedInterest ?? null,
                row.fields.currency,
                data.evidenceId,
                row.sourceRow,
                mappingId,
                JSON.stringify({
                  ...row,
                  source: normalized.source,
                  mappingVersion: mapping.version,
                  quantityUnit: definition.quantityUnit,
                  valuationMultiplier: definition.valuationMultiplier,
                }),
              ],
            );
            observedPositionIds.push(observationId);
          }
          return {
            id: observedPositionIds[0]!,
            evidenceId: data.evidenceId,
            mappingId,
            mappingVersion: mapping.version,
            rowCount: observedPositionIds.length,
            observedPositionIds,
            status: 'observed',
            revision: 1,
          };
        }
        if (
          normalized.rows.some(
            (row) => row.fields.currency !== account.currency,
          )
        )
          throw new Error('finance-report-account-currency-mismatch');
        const id = randomUUID();
        await client.query(
          `insert into emdo.finance_normalized_imports(id,workspace_id,book_id,financial_account_id,evidence_id,mapping,parser_version) values($1,$2,$3,$4,$5,$6::jsonb,'approved-report.v1')`,
          [
            id,
            context.workspaceId,
            bookId,
            data.financialAccountId,
            data.evidenceId,
            JSON.stringify({
              mappingId,
              mappingVersion: mapping.version,
              definition: mapping.definition,
              providerKey: data.providerKey,
            }),
          ],
        );
        for (const row of normalized.rows) {
          const components = extractFinanceNormalizedAmountComponents(row),
            rowId = randomUUID();
          await client.query(
            `insert into emdo.finance_normalized_import_rows(id,workspace_id,book_id,batch_id,source_row,source_facts,effective_on,description,native_amount,external_id,issues,status) values($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb,'review')`,
            [
              rowId,
              context.workspaceId,
              bookId,
              id,
              row.sourceRow,
              JSON.stringify({
                ...row,
                source: normalized.source,
                mappingId,
                mappingVersion: mapping.version,
              }),
              row.fields.transactionDate,
              row.fields.description,
              row.fields.amount,
              row.fields.externalId ?? null,
              JSON.stringify(row.issues),
            ],
          );
          for (const component of components)
            await client.query(
              `insert into emdo.finance_normalized_import_amount_components(id,workspace_id,book_id,row_id,component_kind,native_amount,currency,source_provenance) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
              [
                randomUUID(),
                context.workspaceId,
                bookId,
                rowId,
                component.kind,
                component.nativeAmount,
                component.currency,
                JSON.stringify(component.provenance),
              ],
            );
        }
        return {
          id,
          evidenceId: data.evidenceId,
          mappingId,
          mappingVersion: mapping.version,
          rowCount: normalized.rows.length,
          revision: 1,
          status: 'review',
        };
      },
    );
  }

  recordInvestmentMovement(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = RecordInvestmentMovementSchema.parse(input);
    return this.command(
      context,
      key,
      'investment.movement.record',
      data,
      bookId,
      async (client) => {
        const book = await this.book(client, context, bookId, true);
        if (!['administrator', 'approver'].includes(String(book.role)))
          throw new Error('finance-book-forbidden');
        const id = randomUUID();
        await client.query(
          `insert into emdo.finance_investment_movements(id,workspace_id,book_id,financial_account_id,instrument_id,effective_on,quantity,journal_id,source_reference) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            context.workspaceId,
            bookId,
            data.financialAccountId,
            data.instrumentId,
            data.effectiveOn,
            data.quantity,
            data.journalId,
            data.sourceReference,
          ],
        );
        return { id };
      },
    );
  }

  listInvestmentLots(
    context: WorkspaceContext,
    bookId: string,
    offset = 0,
    limit = 50,
  ) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 1000000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new FinanceV2PersistenceError('invalid-input', 'Invalid lot page');
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      const rows = (
        await client.query(
          `select p.id,p.movement_id as "movementId",p.native_currency as "nativeCurrency",
        p.functional_currency as "functionalCurrency",p.original_native_cost::text as "originalNativeCost",
        p.original_functional_cost::text as "originalFunctionalCost",p.source_reference as "sourceReference",
        p.original_quantity::text as "originalQuantity",p.acquired_on::text as "acquiredOn",
        p.financial_account_id as "financialAccountId",p.instrument_id as "instrumentId",p.journal_id as "journalId",
        p.remaining_quantity::text as "remainingQuantity",
        p.remaining_native_cost::text as "remainingNativeCost",
        p.remaining_functional_cost::text as "remainingFunctionalCost"
        from emdo.finance_investment_lot_positions p
        where p.workspace_id=$1 and p.book_id=$2
        order by p.acquired_on,p.acquisition_sequence,p.id limit $3 offset $4`,
          [context.workspaceId, bookId, limit + 1, offset],
        )
      ).rows;
      return {
        lots: rows.slice(0, limit),
        nextOffset: rows.length > limit ? offset + limit : null,
      };
    });
  }

  getInvestmentLot(context: WorkspaceContext, bookId: string, id: string) {
    UuidSchema.parse(id);
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      const lot = (
        await client.query(
          `select p.id,p.movement_id as "movementId",p.native_currency as "nativeCurrency",p.original_native_cost::text as "originalNativeCost",p.original_functional_cost::text as "originalFunctionalCost",p.source_reference as "sourceReference",p.original_quantity::text as "originalQuantity",p.acquired_on::text as "acquiredOn",p.financial_account_id as "financialAccountId",p.instrument_id as "instrumentId",p.journal_id as "journalId" from emdo.finance_investment_lot_positions p where p.workspace_id=$1 and p.book_id=$2 and p.id=$3`,
          [context.workspaceId, bookId, id],
        )
      ).rows[0];
      if (!lot) throw new Error('finance-lot-unavailable');
      const allocations = (
        await client.query(
          `select a.id,a.disposal_id as "disposalId",a.quantity::text,a.native_cost::text as "nativeCost",a.functional_cost::text as "functionalCost",d.method,d.movement_id as "movementId",m.effective_on::text as "effectiveOn" from emdo.finance_lot_allocations a join emdo.finance_lot_disposals d on d.workspace_id=a.workspace_id and d.book_id=a.book_id and d.id=a.disposal_id join emdo.finance_investment_movements m on m.workspace_id=d.workspace_id and m.book_id=d.book_id and m.id=d.movement_id where a.workspace_id=$1 and a.book_id=$2 and a.lot_id=$3 order by m.effective_on,a.created_at,a.id`,
          [context.workspaceId, bookId, id],
        )
      ).rows;
      return { lot, allocations };
    });
  }

  recordInvestmentLot(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = RecordInvestmentLotSchema.parse(input);
    return this.command(
      context,
      key,
      'investment.lot.record',
      data,
      bookId,
      async (client) => {
        const book = await this.book(client, context, bookId, true);
        if (!['administrator', 'approver'].includes(String(book.role)))
          throw new Error('finance-book-forbidden');
        moneyValue(data.nativeCost, data.nativeCurrency);
        moneyValue(
          data.functionalCost,
          book.functional_currency as FinanceCurrency,
        );
        const id = randomUUID();
        await client.query(
          `insert into emdo.finance_investment_lots(id,workspace_id,book_id,movement_id,acquisition_sequence,native_currency,native_cost,functional_cost,source_reference) values($1,$2,$3,$4,(select coalesce(max(acquisition_sequence),-1)+1 from emdo.finance_investment_lots where workspace_id=$2 and book_id=$3),$5,$6,$7,$8)`,
          [
            id,
            context.workspaceId,
            bookId,
            data.movementId,
            data.nativeCurrency,
            data.nativeCost,
            data.functionalCost,
            data.sourceReference,
          ],
        );
        return { id };
      },
    );
  }

  recordLotDisposal(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = RecordLotDisposalSchema.parse(input);
    return this.command(
      context,
      key,
      'investment.lot.dispose',
      data,
      bookId,
      async (client) => {
        const book = await this.book(client, context, bookId, true);
        if (!['administrator', 'approver'].includes(String(book.role)))
          throw new Error('finance-book-forbidden');
        const movement = (
          await client.query(
            `select financial_account_id as "financialAccountId",instrument_id as "instrumentId",effective_on::text as "effectiveOn",quantity::text from emdo.finance_investment_movements where workspace_id=$1 and book_id=$2 and id=$3`,
            [context.workspaceId, bookId, data.movementId],
          )
        ).rows[0];
        if (!movement || parseFinanceDecimal(String(movement.quantity)) >= 0n)
          throw new Error('finance-disposal-movement-required');
        const lots = (
          await client.query(
            `with source_state as (
             select l.id,m.financial_account_id as "financialAccountId",m.instrument_id as "instrumentId",
                    m.effective_on::text as "acquiredOn",l.acquisition_sequence as "acquisitionSequence",
                    coalesce(cal.quantity,e.successor_quantity,m.quantity)::text as "originalQuantity",
                    l.native_currency as "nativeCurrency",
                    coalesce(cal.native_cost,e.successor_native_cost_basis,l.native_cost)::text as "originalNativeCost",
                    coalesce(cal.functional_cost,e.successor_functional_cost_basis,l.functional_cost)::text as "originalFunctionalCost",
                    b.functional_currency as "functionalCurrency",l.source_reference as "sourceReference",
                    ca.effective_on as "actionEffectiveOn"
               from emdo.finance_investment_lots l
               join emdo.finance_investment_movements m on m.workspace_id=l.workspace_id and m.book_id=l.book_id and m.id=l.movement_id
               join emdo.finance_books b on b.workspace_id=l.workspace_id and b.id=l.book_id
               left join lateral (
                 select ca.id,ca.effective_on from emdo.finance_investment_corporate_actions ca
                  where ca.workspace_id=l.workspace_id and ca.book_id=l.book_id
                    and ca.financial_account_id=m.financial_account_id and ca.instrument_id=m.instrument_id
                    and ca.status='committed' and ca.effective_on<= $5
                    and ca.effective_on>=m.effective_on
                  order by ca.effective_on desc,ca.created_at desc,ca.id desc limit 1
               ) ca on true
               left join emdo.finance_investment_corporate_action_effects e on e.workspace_id=l.workspace_id and e.book_id=l.book_id and e.action_id=ca.id and e.source_lot_id=l.id
               left join emdo.finance_investment_corporate_action_lots cal on cal.workspace_id=e.workspace_id and cal.book_id=e.book_id and cal.action_id=e.action_id and cal.source_lot_id=e.source_lot_id
              where l.workspace_id=$1 and l.book_id=$2 and m.financial_account_id=$3 and m.instrument_id=$4
           )
           select s.id,s."financialAccountId",s."instrumentId",s."acquiredOn",s."acquisitionSequence",
                  s."originalQuantity",s."originalNativeCost",s."originalFunctionalCost",s."nativeCurrency",
                  s."functionalCurrency",s."sourceReference",
                  coalesce(sum(a.quantity) filter(where s."actionEffectiveOn" is null or dm.effective_on>=s."actionEffectiveOn"),0)::text as "disposedQuantity",
                  coalesce(sum(a.native_cost) filter(where s."actionEffectiveOn" is null or dm.effective_on>=s."actionEffectiveOn"),0)::text as "allocatedNativeCost",
                  coalesce(sum(a.functional_cost) filter(where s."actionEffectiveOn" is null or dm.effective_on>=s."actionEffectiveOn"),0)::text as "allocatedFunctionalCost"
             from source_state s
             left join emdo.finance_lot_allocations a on a.workspace_id=$1 and a.book_id=$2 and a.lot_id=s.id
             left join emdo.finance_lot_disposals d on d.workspace_id=a.workspace_id and d.book_id=a.book_id and d.id=a.disposal_id
             left join emdo.finance_investment_movements dm on dm.workspace_id=d.workspace_id and dm.book_id=d.book_id and dm.id=d.movement_id
            where s."originalQuantity"::numeric>0
            group by s.id,s."financialAccountId",s."instrumentId",s."acquiredOn",s."acquisitionSequence",
                     s."originalQuantity",s."originalNativeCost",s."originalFunctionalCost",s."nativeCurrency",
                     s."functionalCurrency",s."sourceReference",s."actionEffectiveOn"
            having (s."originalQuantity"::numeric-coalesce(sum(a.quantity) filter(where s."actionEffectiveOn" is null or dm.effective_on>=s."actionEffectiveOn"),0))>0
            order by s."acquiredOn",s."acquisitionSequence",s.id`,
            [
              context.workspaceId,
              bookId,
              movement.financialAccountId,
              movement.instrumentId,
              movement.effectiveOn,
            ],
          )
        ).rows;
        const { movementId, ...terms } = data;
        const snapshot = {
          ...terms,
          financialAccountId: movement.financialAccountId,
          instrumentId: movement.instrumentId,
          effectiveOn: movement.effectiveOn,
          quantity: formatFinanceDecimal(
            -parseFinanceDecimal(String(movement.quantity)),
          ),
          functionalCurrency: book.functional_currency,
          lots,
        };
        const result = allocateInvestmentDisposal(snapshot),
          id = randomUUID();
        await client.query(
          `insert into emdo.finance_lot_disposals(id,workspace_id,book_id,movement_id,method,native_currency,input_snapshot,result) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
          [
            id,
            context.workspaceId,
            bookId,
            movementId,
            data.method,
            data.nativeCurrency,
            JSON.stringify(snapshot),
            JSON.stringify(result),
          ],
        );
        for (const row of result.allocations)
          await client.query(
            `insert into emdo.finance_lot_allocations(workspace_id,book_id,lot_id,disposal_id,quantity,native_cost,functional_cost) values($1,$2,$3,$4,$5,$6,$7)`,
            [
              context.workspaceId,
              bookId,
              row.lotId,
              id,
              row.quantity,
              row.nativeCost,
              row.functionalCost,
            ],
          );
        return { id, result };
      },
    );
  }

  createInstrument(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = CreateFinanceInstrumentSchema.parse(input);
    return this.command(
      context,
      key,
      'investment.instrument.create',
      data,
      bookId,
      async (client) => {
        const id = randomUUID();
        await client.query(
          `insert into emdo.finance_instruments(id,workspace_id,book_id,name,kind,quantity_unit,valuation_multiplier) values($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            context.workspaceId,
            bookId,
            data.name,
            data.kind,
            data.quantityUnit,
            data.valuationMultiplier,
          ],
        );
        for (const identifier of data.identifiers)
          await client.query(
            `insert into emdo.finance_instrument_identifiers(workspace_id,book_id,instrument_id,scheme,value,namespace) values($1,$2,$3,$4,$5,$6)`,
            [
              context.workspaceId,
              bookId,
              id,
              identifier.scheme,
              identifier.value,
              identifier.namespace,
            ],
          );
        return { id };
      },
    );
  }

  recordInvestmentPrice(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = RecordInvestmentPriceSchema.parse(input);
    return this.command(
      context,
      key,
      'investment.price.record',
      data,
      bookId,
      async (client) => {
        const id = randomUUID();
        await client.query(
          `insert into emdo.finance_investment_prices(id,workspace_id,book_id,instrument_id,as_of,price,currency,source_reference) values($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            context.workspaceId,
            bookId,
            data.instrumentId,
            data.asOf,
            data.price,
            data.currency,
            data.sourceReference,
          ],
        );
        return { id };
      },
    );
  }

  recordInvestmentFx(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = RecordInvestmentFxSchema.parse(input);
    return this.command(
      context,
      key,
      'investment.fx.record',
      data,
      bookId,
      async (client) => {
        const id = randomUUID();
        await client.query(
          `insert into emdo.finance_fx_observations(id,workspace_id,book_id,as_of,from_currency,to_currency,rate,source_reference) values($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            context.workspaceId,
            bookId,
            data.asOf,
            data.fromCurrency,
            data.toCurrency,
            data.rate,
            data.sourceReference,
          ],
        );
        return { id };
      },
    );
  }

  recordInvestmentOpening(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = RecordInvestmentOpeningSchema.parse(input);
    return this.command(
      context,
      key,
      'investment.opening.record',
      data,
      bookId,
      async (client) => {
        const id = randomUUID();
        await client.query(
          `insert into emdo.finance_investment_openings(id,workspace_id,book_id,financial_account_id,instrument_id,as_of,quantity,evidence_id,source_reference) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            context.workspaceId,
            bookId,
            data.financialAccountId,
            data.instrumentId,
            data.asOf,
            data.quantity,
            data.evidenceId,
            data.sourceReference,
          ],
        );
        return { id };
      },
    );
  }

  recordObservedPosition(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = RecordObservedInvestmentPositionSchema.parse(input);
    return this.command(
      context,
      key,
      'investment.position.observe',
      data,
      bookId,
      async (client) => {
        const id = randomUUID();
        await client.query(
          `insert into emdo.finance_observed_positions(id,workspace_id,book_id,financial_account_id,instrument_id,as_of,quantity,reported_market_value,currency,evidence_id,source_row) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            context.workspaceId,
            bookId,
            data.financialAccountId,
            data.instrumentId,
            data.asOf,
            data.quantity,
            data.reportedMarketValue,
            data.currency,
            data.evidenceId,
            data.sourceRow,
          ],
        );
        return { id };
      },
    );
  }

  investmentOverview(context: WorkspaceContext, bookId: string) {
    return this.transaction(context, async (client) => {
      const book = await this.book(client, context, bookId);
      const instruments = (
        await client.query(
          `select id,name,kind,quantity_unit as "quantityUnit",valuation_multiplier::text as "valuationMultiplier" from emdo.finance_instruments where workspace_id=$1 and book_id=$2 order by name,id`,
          [context.workspaceId, bookId],
        )
      ).rows;
      const identifiers = (
        await client.query(
          `select id,instrument_id as "instrumentId",scheme,value,namespace from emdo.finance_instrument_identifiers where workspace_id=$1 and book_id=$2 order by instrument_id,scheme,namespace,value`,
          [context.workspaceId, bookId],
        )
      ).rows;
      const prices = (
        await client.query(
          `select id,instrument_id as "instrumentId",as_of::text as "asOf",price::text,currency,source_reference as "sourceReference" from emdo.finance_investment_prices where workspace_id=$1 and book_id=$2 order by as_of desc,id`,
          [context.workspaceId, bookId],
        )
      ).rows;
      const fx = (
        await client.query(
          `select id,as_of::text as "asOf",from_currency as "fromCurrency",to_currency as "toCurrency",rate::text,source_reference as "sourceReference" from emdo.finance_fx_observations where workspace_id=$1 and book_id=$2 order by as_of desc,id`,
          [context.workspaceId, bookId],
        )
      ).rows;
      const openings = (
        await client.query(
          `select id,financial_account_id as "financialAccountId",instrument_id as "instrumentId",as_of::text as "asOf",quantity::text,evidence_id as "evidenceId",source_reference as "sourceReference" from emdo.finance_investment_openings where workspace_id=$1 and book_id=$2 order by as_of desc,id`,
          [context.workspaceId, bookId],
        )
      ).rows;
      const observedPositions = (
        await client.query(
          `select id,financial_account_id as "financialAccountId",instrument_id as "instrumentId",as_of::text as "asOf",quantity::text,reported_market_value::text as "reportedMarketValue",reported_book_cost::text as "reportedBookCost",reported_price::text as "reportedPrice",reported_accrued_interest::text as "reportedAccruedInterest",mapping_id as "mappingId",source_facts as "sourceFacts",currency,evidence_id as "evidenceId",source_row as "sourceRow" from emdo.finance_observed_positions where workspace_id=$1 and book_id=$2 order by as_of desc,id`,
          [context.workspaceId, bookId],
        )
      ).rows;
      return {
        currency: book.functional_currency,
        instruments,
        identifiers,
        prices,
        fx,
        openings,
        observedPositions,
      };
    });
  }

  previewInvestmentValuation(
    context: WorkspaceContext,
    bookId: string,
    input: unknown,
  ) {
    const data = PreviewInvestmentValuationSchema.parse(input);
    return this.transaction(context, (client) =>
      this.calculateValuation(client, context, bookId, data),
    );
  }

  saveInvestmentValuation(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = SaveInvestmentValuationSchema.parse(input);
    return this.command(
      context,
      key,
      'investment.valuation.save',
      data,
      bookId,
      async (client) => {
        const preview = await this.calculateValuation(
          client,
          context,
          bookId,
          data,
        );
        if (
          data.expectedInputHash &&
          data.expectedInputHash !== preview.inputHash
        )
          throw new FinanceV2PersistenceError(
            'conflict',
            'Valuation inputs changed; preview again before saving',
          );
        const id = randomUUID();
        const { inputSnapshot, ...calculation } = preview;
        const result = { ...calculation, mode: 'saved' as const, id };
        await client.query(
          `insert into emdo.finance_valuation_runs(id,workspace_id,book_id,as_of,calculation_version,input_snapshot,result,created_by) values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
          [
            id,
            context.workspaceId,
            bookId,
            data.asOf,
            preview.calculationVersion,
            JSON.stringify(inputSnapshot),
            JSON.stringify(result),
            context.userId,
          ],
        );
        return { id, result };
      },
    );
  }

  listInvestmentValuations(
    context: WorkspaceContext,
    bookId: string,
    offset = 0,
    limit = 50,
  ) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 1000000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new FinanceV2PersistenceError(
        'invalid-input',
        'Invalid valuation page',
      );
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      const rows = (
        await client.query(
          `select id,as_of::text as "asOf",calculation_version as "calculationVersion",result->>'status' as status,result->>'currency' as currency,result->>'total' as total,result->>'valuationScope' as "valuationScope",created_at as "createdAt" from emdo.finance_valuation_runs where workspace_id=$1 and book_id=$2 order by created_at,id limit $3 offset $4`,
          [context.workspaceId, bookId, limit + 1, offset],
        )
      ).rows;
      return {
        runs: rows.slice(0, limit),
        nextOffset: rows.length > limit ? offset + limit : null,
      };
    });
  }

  getInvestmentValuation(
    context: WorkspaceContext,
    bookId: string,
    id: string,
  ) {
    UuidSchema.parse(id);
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      const row = (
        await client.query(
          `select id,as_of::text as "asOf",calculation_version as "calculationVersion",input_snapshot as "inputSnapshot",result,created_at as "createdAt" from emdo.finance_valuation_runs where workspace_id=$1 and book_id=$2 and id=$3`,
          [context.workspaceId, bookId, id],
        )
      ).rows[0];
      if (!row) throw new Error('finance-valuation-unavailable');
      return row;
    });
  }

  private async calculateValuation(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    data: ReturnType<typeof PreviewInvestmentValuationSchema.parse>,
  ) {
    const book = await this.book(client, context, bookId);
    // Hold the book mutation lock across all source reads, so this preview has one coherent state.
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `${context.workspaceId}:${bookId}`,
    ]);
    const sourceSnapshots: unknown[] = [];
    const values: unknown[] = [],
      reconciliations: ReturnType<typeof reconcileInvestmentPosition>[] = [],
      calculations: ReturnType<typeof calculateInvestmentPosition>[] = [];
    for (const selected of data.positions) {
      const { instrument, opening, movements, price, fx, observed } =
        await loadInvestmentValuationSources(
          client,
          context,
          bookId,
          selected,
          data.asOf,
        );
      const calculated = calculateInvestmentPosition({
        financialAccountId: selected.financialAccountId,
        instrumentId: selected.instrumentId,
        asOf: data.asOf,
        opening,
        movements,
      });
      calculations.push(calculated);
      values.push({
        financialAccountId: selected.financialAccountId,
        instrumentId: selected.instrumentId,
        asOf: data.asOf,
        quantity: calculated.quantity,
        valuationMultiplier: instrument.multiplier,
        functionalCurrency: book.functional_currency,
        price,
        fx,
      });
      if (observed) {
        const row = observed;
        reconciliations.push(
          reconcileInvestmentPosition(
            {
              id: row.id,
              financialAccountId: row.financialAccountId,
              instrumentId: row.instrumentId,
              asOf: row.asOf,
              quantity: row.quantity,
              reportedMarketValue: row.reportedMarketValue,
              currency: row.currency,
              evidenceId: row.evidenceId,
              sourceRow: row.sourceRow,
            },
            calculated,
          ),
        );
      }
      sourceSnapshots.push({
        selected,
        instrument,
        opening,
        movements,
        price,
        fx,
        observed,
      });
    }
    const inputSnapshot = {
      asOf: data.asOf,
      functionalCurrency: book.functional_currency,
      positions: sourceSnapshots,
    };
    const inputHash = createHash('sha256')
      .update(
        JSON.stringify({
          calculationVersion: 'investment-valuation.v1',
          inputSnapshot,
        }),
      )
      .digest('hex');
    return {
      mode: 'preview' as const,
      inputHash,
      inputSnapshot,
      valuationScope: 'selected-positions' as const,
      calculationVersion: 'investment-valuation.v1',
      bookId,
      selections: data.positions,
      ...valueInvestmentPortfolio(values),
      calculations,
      reconciliations,
    };
  }

  createFinancialAccount(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = CreateFinancialAccountSchema.parse(input);
    return this.command(
      context,
      key,
      'financial-account.create',
      data,
      bookId,
      async (client) => {
        const id = randomUUID();
        await client.query(
          `insert into emdo.finance_financial_accounts(id,workspace_id,book_id,name,kind,currency,ledger_account_id) values($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            context.workspaceId,
            bookId,
            data.name,
            data.kind,
            data.currency,
            data.ledgerAccountId,
          ],
        );
        if (data.privateSourceAssignment) {
          const assignment = data.privateSourceAssignment;
          await client.query(
            'select emdo.set_legacy_finance_account_assignment($1,$2,$3,0,$4,$5,$6,false)',
            [
              context.workspaceId,
              bookId,
              id,
              assignment.sourceSpaceId,
              assignment.compatibilityAccountKind,
              assignment.reason,
            ],
          );
        }
        return { id };
      },
      data.privateSourceAssignment
        ? async (client) => {
            await client.query(
              'select emdo.lock_legacy_finance_source($1,$2,$3)',
              [
                context.workspaceId,
                data.privateSourceAssignment!.sourceSpaceId,
                context.userId,
              ],
            );
          }
        : undefined,
    );
  }
  listFinancialAccountSources(context: WorkspaceContext, bookId: string) {
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      return listLegacyFinanceAssignmentSources(client, {
        workspaceId: context.workspaceId,
        bookId,
      });
    });
  }
  listFinancialAccounts(context: WorkspaceContext, bookId: string) {
    return this.transaction(context, async (client) => {
      await this.book(client, context, bookId);
      return (
        await client.query(
          `select f.id,f.name,f.kind,f.currency,f.ledger_account_id as "ledgerAccountId",a.code as "ledgerCode",f.active
        from emdo.finance_financial_accounts f join emdo.finance_ledger_accounts a on a.workspace_id=f.workspace_id and a.book_id=f.book_id and a.id=f.ledger_account_id
        where f.workspace_id=$1 and f.book_id=$2 order by f.name,f.id`,
          [context.workspaceId, bookId],
        )
      ).rows;
    });
  }
}

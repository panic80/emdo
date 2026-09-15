import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  CommitInvestmentStockSplitSettlement,
  WorkspaceContext,
} from '@emdo/contracts';
import { PostgresFinanceCorporateActionRepository } from './finance-corporate-action-repository.js';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';

const url = process.env.FINANCE_V2_TEST_DATABASE_URL;

describe.skipIf(!url)('Finance cash-in-lieu settlement persistence', () => {
  const admin = new pg.Pool({ connectionString: url });
  const login = `settlement_${randomUUID().replaceAll('-', '')}`;
  let app: pg.Pool;
  const pool = {
    async connect() {
      const client = await app.connect();
      await client.query('set role emdo_app');
      return client;
    },
  };
  const repository = new PostgresFinanceV2Repository(pool, {
    evidenceCipher: {
      async encrypt() {
        return {
          algorithm: 'aes-256-gcm',
          schemaVersion: '1',
          aadVersion: '1',
          ciphertext: 'ciphertext',
          nonce: '1234567890abcdef',
          authenticationTag: '1234567890123456789012',
          wrappedKey: 'wrapped-key',
          keyVersion: 'finance-documents.v1',
        };
      },
      async decrypt() {
        return { sourceText: 'cash dividend evidence' };
      },
    },
  });
  const settlements = new PostgresFinanceCorporateActionRepository(pool);
  let command: CommitInvestmentStockSplitSettlement;
  let investmentId: string;
  let lotId: string;
  let closedLotId: string;
  const context: WorkspaceContext = {
    workspaceId: randomUUID(),
    userId: randomUUID(),
    sessionId: randomUUID(),
    requestId: randomUUID(),
  };
  let bookId: string;
  let cashLedgerId: string;
  let incomeLedgerId: string;
  let withholdingLedgerId: string;
  let financialAccountId: string;
  let instrumentId: string;
  let evidenceId: string;
  let sourceRowId: string;

  async function sql(text: string, values: unknown[] = []) {
    const client = await admin.connect();
    try {
      await client.query('reset role');
      return await client.query(text, values);
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    await admin.query(
      `create role "${login}" login nosuperuser nobypassrls noinherit`,
    );
    await admin.query(`grant emdo_app to "${login}"`);
    const connection = new URL(url!);
    connection.username = login;
    app = new pg.Pool({ connectionString: connection.toString() });
    const probe = await pool.connect();
    try {
      expect(
        (
          await probe.query(
            "select current_user='emdo_app' and not rolsuper and not rolbypassrls as restricted from pg_roles where rolname=current_user",
          )
        ).rows[0].restricted,
      ).toBe(true);
      await expect(probe.query('set role postgres')).rejects.toThrow();
    } finally {
      probe.release();
    }

    await sql(
      `insert into emdo.auth_users(id,name,email,email_verified)
       values($1,'Dividend test owner',$2,true)`,
      [context.userId, `${context.userId}@example.test`],
    );
    await sql(
      `insert into emdo.households(id,name,slug,created_by_user_id)
       values($1,'Dividend test workspace',$2,$3)`,
      [context.workspaceId, context.workspaceId, context.userId],
    );
    await sql(
      `insert into emdo.household_memberships(household_id,user_id,role)
       values($1,$2,'owner')`,
      [context.workspaceId, context.userId],
    );
    await sql(
      `insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id)
       values($1,$2,$3,now()+interval '1 day',$4)`,
      [
        context.sessionId,
        context.userId,
        context.sessionId,
        context.workspaceId,
      ],
    );
    bookId = String(
      (
        await repository.createBook(context, 'dividend-book', {
          name: 'Dividend book',
          entityName: 'Dividend owner',
          entityKind: 'corporation',
          country: 'CA',
          functionalCurrency: 'CAD',
        })
      ).id,
    );
    cashLedgerId = String(
      (
        await repository.createAccount(context, bookId, 'dividend-cash', {
          code: '1000',
          name: 'Cash',
          kind: 'asset',
        })
      ).id,
    );
    incomeLedgerId = String(
      (
        await repository.createAccount(context, bookId, 'dividend-income', {
          code: '4100',
          name: 'Dividend income',
          kind: 'income',
        })
      ).id,
    );
    withholdingLedgerId = String(
      (
        await repository.createAccount(context, bookId, 'dividend-tax', {
          code: '2200',
          name: 'Withholding tax',
          kind: 'expense',
        })
      ).id,
    );
    financialAccountId = String(
      (
        await repository.createFinancialAccount(
          context,
          bookId,
          'dividend-bank',
          {
            name: 'Dividend bank',
            kind: 'brokerage',
            currency: 'CAD',
            ledgerAccountId: cashLedgerId,
          },
        )
      ).id,
    );
    instrumentId = String(
      (
        await repository.createInstrument(context, bookId, 'dividend-stock', {
          name: 'Dividend stock',
          kind: 'equity',
          quantityUnit: 'share',
          valuationMultiplier: '1',
          identifiers: [],
        })
      ).id,
    );
    await repository.createPeriod(context, bookId, 'dividend-period', {
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
    });
    const imported = await repository.uploadNormalizedStatement(
      context,
      bookId,
      'dividend-import',
      {
        financialAccountId,
        filename: 'dividend.csv',
        format: 'csv',
        sourceText:
          'Date,Description,Amount,Reference\n2026-09-10,Dividend payment,85,DIV-1',
        mapping: {
          dateFormat: 'yyyy-mm-dd',
          decimalSeparator: '.',
          groupingSeparator: '',
          columns: {
            date: 'Date',
            description: 'Description',
            amount: 'Amount',
            externalId: 'Reference',
          },
        },
      },
    );
    evidenceId = String(imported.evidenceId);
    const batch = await repository.getNormalizedImport(
      context,
      bookId,
      String(imported.id),
    );
    sourceRowId = String(batch.rows[0]!.id);
    await repository.reviewNormalizedImportRow(
      context,
      bookId,
      sourceRowId,
      'dividend-review',
      {
        expectedRevision: 1,
        action: 'post',
        counterAccountId: incomeLedgerId,
        reason: 'Reviewed dividend receipt',
      },
    );

    investmentId = String(
      (
        await repository.createAccount(context, bookId, 'investment', {
          code: '1200',
          name: 'Investment',
          kind: 'asset',
        })
      ).id,
    );
    const capitalId = String(
      (
        await repository.createAccount(context, bookId, 'capital', {
          code: '3000',
          name: 'Capital',
          kind: 'equity',
        })
      ).id,
    );
    const journal = await repository.postJournal(context, bookId, 'opening', {
      effectiveOn: '2026-01-01',
      description: 'Opening investment',
      sourceReference: 'opening',
      lines: [
        {
          accountId: investmentId,
          side: 'debit',
          amount: '100',
          currency: 'CAD',
          nativeAmount: '100',
          fxRate: '1',
          fxSource: 'identity',
        },
        {
          accountId: capitalId,
          side: 'credit',
          amount: '100',
          currency: 'CAD',
          nativeAmount: '100',
          fxRate: '1',
          fxSource: 'identity',
        },
      ],
    });
    const movement = await repository.recordInvestmentMovement(
      context,
      bookId,
      'opening-movement',
      {
        financialAccountId,
        instrumentId,
        effectiveOn: '2026-01-01',
        quantity: '10',
        sourceReference: 'opening',
        journalId: String(journal.id),
      },
    );
    lotId = String(
      (
        await repository.recordInvestmentLot(context, bookId, 'opening-lot', {
          movementId: String(movement.id),
          nativeCurrency: 'CAD',
          nativeCost: '100',
          functionalCost: '100',
          sourceReference: 'opening',
        })
      ).id,
    );

    const closedMovement = await repository.recordInvestmentMovement(
      context,
      bookId,
      'closed-lot-movement',
      {
        financialAccountId,
        instrumentId,
        effectiveOn: '2026-01-01',
        quantity: '2',
        sourceReference: 'closed lot',
        journalId: String(journal.id),
      },
    );
    closedLotId = String(
      (
        await repository.recordInvestmentLot(context, bookId, 'closed-lot', {
          movementId: String(closedMovement.id),
          nativeCurrency: 'CAD',
          nativeCost: '20',
          functionalCost: '20',
          sourceReference: 'closed lot',
        })
      ).id,
    );
    const disposalMovement = await repository.recordInvestmentMovement(
      context,
      bookId,
      'closed-sale-movement',
      {
        financialAccountId,
        instrumentId,
        effectiveOn: '2026-01-01',
        quantity: '-2',
        sourceReference: 'closed sale',
        journalId: String(journal.id),
      },
    );
    await repository.recordLotDisposal(context, bookId, 'closed-sale', {
      movementId: String(disposalMovement.id),
      nativeCurrency: 'CAD',
      method: 'specific',
      selections: [{ lotId: closedLotId, quantity: '2' }],
      grossProceeds: { native: '20', functional: '20' },
      fees: { native: '0', functional: '0' },
      commissions: { native: '0', functional: '0' },
      taxes: { native: '0', functional: '0' },
      taxTreatment: 'disposal-cost',
      fxSourceReference: null,
      sourceReference: 'closed sale',
    });
    const action = {
      id: randomUUID(),
      actionType: 'reverse-split' as const,
      financialAccountId,
      instrumentId,
      effectiveOn: '2026-09-10',
      numerator: '1',
      denominator: '3',
      fractionalTreatment: 'cash-in-lieu' as const,
      evidenceId,
      sourceReference: 'Reviewed cash in lieu',
      cashInLieu: null,
    };
    const source = await settlements.readInvestmentStockSplitSource(
      context,
      bookId,
      action,
    );
    const receipt = await settlements.readInvestmentCashDividendSource(
      context,
      bookId,
      { sourceRowId, financialAccountId, instrumentId, evidenceId },
    );
    const digest = String(
      (
        await sql(
          'select plaintext_sha256 from emdo.finance_book_evidence where id=$1',
          [evidenceId],
        )
      ).rows[0].plaintext_sha256,
    );
    command = {
      settlement: {
        source: {
          action,
          sourceAsOf: action.effectiveOn,
          sourceBoundary: 'immediately-before-action',
          sourceLots: [...source.sourceLots],
        },
        deliveredQuantity: { numerator: '3', denominator: '1' },
        cashDisposedQuantity: { numerator: '1', denominator: '3' },
        allocations: [
          {
            sourceLotId: lotId,
            retainedQuantity: { numerator: '3', denominator: '1' },
            cashDisposedQuantity: { numerator: '1', denominator: '3' },
            retainedNativeCost: '90',
            retainedFunctionalCost: '90',
            disposedNativeCost: '10',
            disposedFunctionalCost: '10',
          },
        ],
        cashConsideration: {
          native: { amount: '85', currency: 'CAD' },
          functional: { amount: '85', currency: 'CAD' },
          evidenceId,
          sourceReference: 'Receipt',
          settledOn: '2026-09-10',
          fx: null,
        },
        allocationReview: {
          evidenceId,
          sourceReference: 'Reviewed allocation',
        },
      },
      ledger: {
        cashLedgerAccountId: cashLedgerId,
        investmentLedgerAccountId: investmentId,
        gainLedgerAccountId: incomeLedgerId,
        lossLedgerAccountId: withholdingLedgerId,
        receivableLedgerAccountId: null,
        fxGainLedgerAccountId: null,
        fxLossLedgerAccountId: null,
      },
      actionDateConsideration: null,
      expectedSourceRevision: source.sourceRevision,
      sourceSnapshotHash: source.sourceSnapshotHash,
      receipt: {
        sourceRowId,
        expectedRevision: receipt.sourceRevision,
        snapshotHash: receipt.sourceSnapshotHash,
      },
      evidenceHashes: [{ evidenceId, sha256: digest }],
      idempotencyKey: 'settlement',
    };
  });

  afterAll(async () => {
    await app?.end();
    await admin.query(`drop role if exists "${login}"`);
    await admin.end();
  });

  it('rejects stale source, receipt, evidence, and unrepresentable retained fractions before any posting', async () => {
    for (const bad of [
      {
        ...command,
        expectedSourceRevision: command.expectedSourceRevision + 1,
      },
      { ...command, sourceSnapshotHash: '0'.repeat(64) },
      {
        ...command,
        receipt: {
          ...command.receipt,
          expectedRevision: command.receipt.expectedRevision + 1,
        },
      },
      { ...command, evidenceHashes: [{ evidenceId, sha256: '0'.repeat(64) }] },
      {
        ...command,
        settlement: {
          ...command.settlement,
          deliveredQuantity: { numerator: '8', denominator: '3' },
          cashDisposedQuantity: { numerator: '2', denominator: '3' },
          allocations: [
            {
              ...command.settlement.allocations[0]!,
              retainedQuantity: { numerator: '8', denominator: '3' },
              cashDisposedQuantity: { numerator: '2', denominator: '3' },
            },
          ],
        },
      },
    ])
      await expect(
        settlements.commitInvestmentStockSplitSettlement(context, bookId, bad),
      ).rejects.toThrow();
    expect(
      (
        await sql(
          'select count(*) from emdo.finance_investment_corporate_action_settlements where book_id=$1',
          [bookId],
        )
      ).rows[0].count,
    ).toBe('0');
    expect(
      (
        await sql(
          'select count(*) from emdo.finance_journals where book_id=$1',
          [bookId],
        )
      ).rows[0].count,
    ).toBe('1');
  });
  it('commits balanced journal, claims receipt, preserves retained basis, and replays immutable proof', async () => {
    expect(await settlements.checkStockSplitSettlementReady()).toBe(true);
    const concurrent = await Promise.all([
      settlements.commitInvestmentStockSplitSettlement(
        context,
        bookId,
        command,
      ),
      settlements.commitInvestmentStockSplitSettlement(
        context,
        bookId,
        command,
      ),
    ]);
    expect(concurrent.map((x) => x.replayed).sort()).toEqual([false, true]);
    const result = concurrent.find((x) => !x.replayed)!;
    expect(
      (
        await sql(
          'select remaining_quantity::text as quantity,remaining_native_cost::text as cost from emdo.finance_investment_lot_positions where id=$1',
          [closedLotId],
        )
      ).rows[0],
    ).toEqual({ quantity: '0.000000000000', cost: '0.000000000000' });
    expect(result).toMatchObject({
      status: 'committed',
      replayed: false,
      effectCount: 2,
      nextSourceRevision: command.expectedSourceRevision + 1,
    });
    expect(result.journalIds).toHaveLength(1);
    const saved = await settlements.getInvestmentStockSplitSettlement(
      context,
      bookId,
      result.settlementId,
    );
    expect(saved?.result).toEqual(result);
    expect(saved?.accounting).toEqual({
      actionDateFunctionalConsideration: '85',
      settlementDateFunctionalConsideration: '85',
      bookGainLoss: '75',
      fxGainLoss: '0',
    });
    expect(saved?.settlement).toMatchObject({
      actionId: result.actionId,
      retainedNativeCost: '90',
      disposedNativeCost: '10',
    });
    expect(
      await settlements.getInvestmentStockSplitSettlement(
        context,
        bookId,
        randomUUID(),
      ),
    ).toBeNull();
    const otherBook = String(
      (
        await repository.createBook(context, 'other-book', {
          name: 'Other book',
          entityName: 'Other',
          entityKind: 'corporation',
          country: 'CA',
          functionalCurrency: 'CAD',
        })
      ).id,
    );
    expect(
      await settlements.getInvestmentStockSplitSettlement(
        context,
        otherBook,
        result.settlementId,
      ),
    ).toBeNull();

    const positions = (
      await sql(
        'select original_quantity::text,original_native_cost::text from emdo.finance_investment_lot_positions where book_id=$1 and id=$2',
        [bookId, lotId],
      )
    ).rows[0];
    expect(positions).toEqual({
      original_quantity: '3.000000000000',
      original_native_cost: '90.000000000000',
    });
    const receipt = (
      await sql(
        'select status,revision,economic_transaction_id from emdo.finance_normalized_import_rows where id=$1',
        [sourceRowId],
      )
    ).rows[0];
    expect(receipt).toMatchObject({
      status: 'committed',
      revision: command.receipt.expectedRevision + 1,
      economic_transaction_id: result.economicTransactionId,
    });
    const balance = (
      await sql(
        "select sum(case when side='debit' then amount else -amount end)::text as amount from emdo.finance_journal_lines where journal_id=$1",
        [result.journalIds[0]],
      )
    ).rows[0];
    expect(Number(balance.amount)).toBe(0);
    expect(
      await settlements.commitInvestmentStockSplitSettlement(
        context,
        bookId,
        command,
      ),
    ).toEqual({ ...result, replayed: true });
    await expect(
      settlements.commitInvestmentStockSplitSettlement(context, bookId, {
        ...command,
        idempotencyKey: 'changed',
      }),
    ).rejects.toThrow('idempotency-conflict');
    await expect(
      sql(
        "update emdo.finance_investment_corporate_action_settlements set proof='{}' where id=$1",
        [result.settlementId],
      ),
    ).rejects.toThrow('immutable');
  });
  it('posts separate action-date recognition and receipt-date settlement journals', async () => {
    const receivable = String(
      (
        await repository.createAccount(context, bookId, 'receivable', {
          code: '1300',
          name: 'Cash in lieu receivable',
          kind: 'asset',
        })
      ).id,
    );
    const imported = await repository.uploadNormalizedStatement(
      context,
      bookId,
      'later-receipt',
      {
        financialAccountId,
        filename: 'later.csv',
        format: 'csv',
        sourceText:
          'Date,Description,Amount,Reference\n2026-09-12,Later cash in lieu,10,CIL2',
        mapping: {
          dateFormat: 'yyyy-mm-dd',
          decimalSeparator: '.',
          groupingSeparator: '',
          columns: {
            date: 'Date',
            description: 'Description',
            amount: 'Amount',
            externalId: 'Reference',
          },
        },
      },
    );
    const laterEvidence = String(imported.evidenceId);
    const batch = await repository.getNormalizedImport(
      context,
      bookId,
      String(imported.id),
    );
    const laterRow = String(batch.rows[0]!.id);
    await repository.reviewNormalizedImportRow(
      context,
      bookId,
      laterRow,
      'later-review',
      {
        expectedRevision: 1,
        action: 'post',
        counterAccountId: incomeLedgerId,
        reason: 'Reviewed later receipt',
      },
    );
    const action = {
      ...command.settlement.source.action,
      id: randomUUID(),
      effectiveOn: '2026-09-11',
      numerator: '1',
      denominator: '2',
    };
    const source = await settlements.readInvestmentStockSplitSource(
      context,
      bookId,
      action,
    );
    expect(source.sourceLots).toHaveLength(1);
    const receipt = await settlements.readInvestmentCashDividendSource(
      context,
      bookId,
      {
        sourceRowId: laterRow,
        financialAccountId,
        instrumentId,
        evidenceId: laterEvidence,
      },
    );
    const cash = {
      ...command.settlement.cashConsideration,
      native: { amount: '10', currency: 'CAD' as const },
      functional: { amount: '10', currency: 'CAD' as const },
      evidenceId: laterEvidence,
      settledOn: '2026-09-12',
    };
    const later: CommitInvestmentStockSplitSettlement = {
      ...command,
      idempotencyKey: 'later',
      expectedSourceRevision: source.sourceRevision,
      sourceSnapshotHash: source.sourceSnapshotHash,
      receipt: {
        sourceRowId: laterRow,
        expectedRevision: receipt.sourceRevision,
        snapshotHash: receipt.sourceSnapshotHash,
      },
      ledger: {
        ...command.ledger,
        receivableLedgerAccountId: receivable,
        fxGainLedgerAccountId: incomeLedgerId,
        fxLossLedgerAccountId: withholdingLedgerId,
      },
      actionDateConsideration: {
        native: cash.native,
        functional: cash.functional,
        fx: null,
        evidenceId,
        sourceReference: 'Action date value',
      },
      evidenceHashes: [
        ...command.evidenceHashes,
        {
          evidenceId: laterEvidence,
          sha256: String(
            (
              await sql(
                'select plaintext_sha256 from emdo.finance_book_evidence where id=$1',
                [laterEvidence],
              )
            ).rows[0].plaintext_sha256,
          ),
        },
      ],
      settlement: {
        ...command.settlement,
        source: {
          action,
          sourceAsOf: action.effectiveOn,
          sourceBoundary: 'immediately-before-action',
          sourceLots: [...source.sourceLots],
        },
        deliveredQuantity: { numerator: '1', denominator: '1' },
        cashDisposedQuantity: { numerator: '1', denominator: '2' },
        allocations: [
          {
            sourceLotId: lotId,
            retainedQuantity: { numerator: '1', denominator: '1' },
            cashDisposedQuantity: { numerator: '1', denominator: '2' },
            retainedNativeCost: '60',
            retainedFunctionalCost: '60',
            disposedNativeCost: '30',
            disposedFunctionalCost: '30',
          },
        ],
        cashConsideration: cash,
      },
    };
    await expect(
      settlements.commitInvestmentStockSplitSettlement(context, bookId, {
        ...later,
        actionDateConsideration: null,
      }),
    ).rejects.toThrow();
    const result = await settlements.commitInvestmentStockSplitSettlement(
      context,
      bookId,
      later,
    );
    expect(result.journalIds).toHaveLength(2);
    const saved = await settlements.getInvestmentStockSplitSettlement(
      context,
      bookId,
      result.settlementId,
    );
    expect(saved?.accounting).toEqual({
      actionDateFunctionalConsideration: '10',
      settlementDateFunctionalConsideration: '10',
      bookGainLoss: '-20',
      fxGainLoss: '0',
    });
    const storedJournals = (
      await sql(
        "select proof->'journals' as journals from emdo.finance_investment_corporate_action_settlements where id=$1",
        [result.settlementId],
      )
    ).rows[0].journals;
    expect(storedJournals).toMatchObject(saved!.accounting);

    const dates = (
      await sql(
        'select effective_on::text as date from emdo.finance_journals where id=any($1::uuid[]) order by effective_on',
        [result.journalIds],
      )
    ).rows;
    expect(dates).toEqual([{ date: '2026-09-11' }, { date: '2026-09-12' }]);
    const balance = (
      await sql(
        "select sum(case when side='debit' then amount else -amount end)::text as amount,sum(case when side='debit' then native_amount else -native_amount end)::text as native from emdo.finance_journal_lines where journal_id=any($1::uuid[]) and account_id=$2",
        [result.journalIds, receivable],
      )
    ).rows[0];
    expect(Number(balance.amount)).toBe(0);
    expect(Number(balance.native)).toBe(0);
    expect(
      (
        await sql(
          'select retained_numerator,disposed_numerator,disposed_denominator,disposed_native_cost::text from emdo.finance_investment_corporate_action_settlement_allocations where settlement_id=$1',
          [result.settlementId],
        )
      ).rows[0],
    ).toEqual({
      retained_numerator: '1',
      disposed_numerator: '1',
      disposed_denominator: '2',
      disposed_native_cost: '30.000000000000',
    });
    await sql(
      'update emdo.finance_book_grants set role=$3 where book_id=$1 and user_id=$2',
      [bookId, context.userId, 'viewer'],
    );
    expect(
      (
        await settlements.getInvestmentStockSplitSettlement(
          context,
          bookId,
          result.settlementId,
        )
      )?.result,
    ).toEqual(result);
    await expect(
      settlements.commitInvestmentStockSplitSettlement(context, bookId, later),
    ).rejects.toMatchObject({ code: 'authorization-revoked' });
    await expect(
      settlements.commitInvestmentStockSplitSettlement(context, bookId, {
        ...later,
        idempotencyKey: 'viewer-cannot-post',
      }),
    ).rejects.toMatchObject({ code: 'authorization-revoked' });
    await sql(
      'update emdo.finance_book_grants set revoked_at=clock_timestamp() where book_id=$1 and user_id=$2',
      [bookId, context.userId],
    );
    await expect(
      settlements.commitInvestmentStockSplitSettlement(
        context,
        bookId,
        command,
      ),
    ).rejects.toThrow();
    await expect(
      settlements.getInvestmentStockSplitSettlement(
        context,
        bookId,
        result.settlementId,
      ),
    ).rejects.toMatchObject({ code: 'authorization-revoked' });
  });
  it('hides all settlement tables from an authenticated owner of another workspace', async () => {
    const other: WorkspaceContext = {
      userId: randomUUID(),
      workspaceId: randomUUID(),
      sessionId: randomUUID(),
      requestId: randomUUID(),
    };
    await sql(
      "insert into emdo.auth_users(id,name,email,email_verified) values($1,'Other workspace owner',$2,true)",
      [other.userId, `${other.userId}@example.test`],
    );
    await sql(
      "insert into emdo.households(id,name,slug,created_by_user_id) values($1,'Other workspace',$2,$3)",
      [other.workspaceId, other.workspaceId, other.userId],
    );
    await sql(
      "insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,'owner')",
      [other.workspaceId, other.userId],
    );
    await sql(
      "insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1,$2,$3,now()+interval '1 day',$4)",
      [other.sessionId, other.userId, other.sessionId, other.workspaceId],
    );
    const ownBook = String(
      (
        await repository.createBook(other, 'other-workspace-book', {
          name: 'Own book',
          entityName: 'Other owner',
          entityKind: 'corporation',
          country: 'CA',
          functionalCurrency: 'CAD',
        })
      ).id,
    );
    const savedId = String(
      (
        await sql(
          'select id from emdo.finance_investment_corporate_action_settlements where book_id=$1 limit 1',
          [bookId],
        )
      ).rows[0].id,
    );
    expect(
      await settlements.getInvestmentStockSplitSettlement(
        other,
        ownBook,
        savedId,
      ),
    ).toBeNull();
    await expect(
      settlements.getInvestmentStockSplitSettlement(
        { ...other, workspaceId: context.workspaceId },
        bookId,
        savedId,
      ),
    ).rejects.toThrow();
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        "select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)",
        [other.userId, other.sessionId, other.requestId],
      );
      expect(
        (
          await client.query('select id from emdo.finance_books where id=$1', [
            ownBook,
          ])
        ).rows,
      ).toHaveLength(1);
      for (const table of [
        'finance_investment_corporate_action_settlements',
        'finance_investment_corporate_action_settlement_evidence',
        'finance_investment_corporate_action_settlement_allocations',
      ]) {
        expect(
          Number(
            (
              await sql(
                `select count(*) as count from emdo.${table} where workspace_id=$1 and book_id=$2`,
                [context.workspaceId, bookId],
              )
            ).rows[0].count,
          ),
        ).toBeGreaterThan(0);
        expect(
          (
            await client.query(
              `select * from emdo.${table} where workspace_id=$1 and book_id=$2`,
              [context.workspaceId, bookId],
            )
          ).rows,
        ).toHaveLength(0);
      }
      await client.query('rollback');
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});

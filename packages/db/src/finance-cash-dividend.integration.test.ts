import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WorkspaceContext } from '@emdo/contracts';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';

const url = process.env.FINANCE_V2_TEST_DATABASE_URL;

describe.skipIf(!url)('Finance cash-dividend persistence', () => {
  const admin = new pg.Pool({ connectionString: url });
  const login = `dividend_${randomUUID().replaceAll('-', '')}`;
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
            kind: 'bank',
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
  });

  afterAll(async () => {
    await app?.end();
    await admin.query(`drop role if exists "${login}"`);
    await admin.end();
  });

  it('commits exact gross, withholding, and net proofs and reads them back', async () => {
    const source = await repository.readInvestmentCashDividendSource(
      context,
      bookId,
      { sourceRowId, financialAccountId, instrumentId, evidenceId },
    );
    expect(source).toMatchObject({
      sourceRowId,
      status: 'ready',
      nativeAmount: '85.000000000000',
      currency: 'CAD',
      fxRate: '1.000000000000',
      fxSource: 'identity',
    });
    const actionId = randomUUID();
    const provenance = (field: 'gross' | 'withholding' | 'net', raw: string) =>
      ({
        sourceRow: source.sourceRow,
        field,
        column: field,
        raw,
        contextAnchor: null,
      }) as const;
    const commit = await repository.commitInvestmentCashDividend(
      context,
      bookId,
      {
        action: {
          id: actionId,
          actionType: 'cash-dividend',
          financialAccountId,
          instrumentId,
          evidenceId,
          sourceRowId,
          declaredOn: '2026-09-01',
          exDate: '2026-09-05',
          payableOn: '2026-09-10',
          sourceReference: 'DIV-1',
          reviewReason: 'Reviewed gross and withholding facts',
          gross: {
            nativeAmount: '100',
            currency: 'CAD',
            functionalAmount: '100',
            fxRate: '1',
            fxSource: 'identity',
            provenance: provenance('gross', '100'),
          },
          withholding: {
            nativeAmount: '15',
            currency: 'CAD',
            functionalAmount: '15',
            fxRate: '1',
            fxSource: 'identity',
            provenance: provenance('withholding', '15'),
          },
          net: {
            nativeAmount: '85',
            currency: 'CAD',
            functionalAmount: '85',
            fxRate: '1',
            fxSource: 'identity',
            provenance: provenance('net', '85'),
          },
          ledger: {
            cashLedgerAccountId: cashLedgerId,
            dividendIncomeLedgerAccountId: incomeLedgerId,
            withholdingLedgerAccountId: withholdingLedgerId,
          },
        },
        expectedSourceRevision: source.sourceRevision,
        sourceSnapshotHash: source.sourceSnapshotHash,
        idempotencyKey: 'dividend-commit',
      },
    );
    expect(commit).toMatchObject({
      actionId,
      replayed: false,
      status: 'committed',
    });
    await expect(
      repository.commitInvestmentCashDividend(context, bookId, {
        action: {
          ...commitAction(
            actionId,
            financialAccountId,
            instrumentId,
            evidenceId,
            sourceRowId,
            cashLedgerId,
            incomeLedgerId,
            withholdingLedgerId,
          ),
        },
        expectedSourceRevision: source.sourceRevision,
        sourceSnapshotHash: source.sourceSnapshotHash,
        idempotencyKey: 'dividend-commit',
      }),
    ).resolves.toMatchObject({ replayed: true, actionId });
    const saved = await repository.getInvestmentCashDividend(
      context,
      bookId,
      actionId,
    );
    expect(saved).toMatchObject({
      id: actionId,
      source: {
        status: 'committed',
        currentRevision: source.sourceRevision + 1,
      },
      gross: {
        nativeAmount: '100.000000000000',
        functionalAmount: '100.000000000000',
      },
      withholding: {
        nativeAmount: '15.000000000000',
        functionalAmount: '15.000000000000',
      },
      net: {
        nativeAmount: '85.000000000000',
        functionalAmount: '85.000000000000',
      },
    });
    expect(
      (
        await repository.listInvestmentCashDividends(context, bookId, {
          offset: 0,
          limit: 10,
        })
      ).actions,
    ).toEqual([saved]);
    expect(
      (
        await sql(
          `select status,revision,economic_transaction_id from emdo.finance_normalized_import_rows where id=$1`,
          [sourceRowId],
        )
      ).rows[0],
    ).toMatchObject({
      status: 'committed',
      revision: source.sourceRevision + 1,
    });
  });

  it('does not allow a second dividend claim for the same normalized source row', async () => {
    const source = await repository.readInvestmentCashDividendSource(
      context,
      bookId,
      { sourceRowId, financialAccountId, instrumentId, evidenceId },
    );
    await expect(
      repository.commitInvestmentCashDividend(context, bookId, {
        action: commitAction(
          randomUUID(),
          financialAccountId,
          instrumentId,
          evidenceId,
          sourceRowId,
          cashLedgerId,
          incomeLedgerId,
          withholdingLedgerId,
        ),
        expectedSourceRevision: source.sourceRevision,
        sourceSnapshotHash: source.sourceSnapshotHash,
        idempotencyKey: 'dividend-second-claim',
      }),
    ).rejects.toThrow();
    const result = await sql(
      `select count(*)::int as count from emdo.finance_investment_cash_dividends where workspace_id=$1 and book_id=$2 and source_row_id=$3`,
      [context.workspaceId, bookId, sourceRowId],
    );
    expect(result.rows[0]?.count).toBe(1);
  });
});

function commitAction(
  actionId: string,
  financialAccountId: string,
  instrumentId: string,
  evidenceId: string,
  sourceRowId: string,
  cashLedgerId: string,
  incomeLedgerId: string,
  withholdingLedgerId: string,
) {
  const amount = (
    nativeAmount: string,
    field: 'gross' | 'withholding' | 'net',
  ) => ({
    nativeAmount,
    currency: 'CAD' as const,
    functionalAmount: nativeAmount,
    fxRate: '1',
    fxSource: 'identity',
    provenance: {
      sourceRow: 2,
      field,
      column: field,
      raw: nativeAmount,
      contextAnchor: null,
    },
  });
  return {
    id: actionId,
    actionType: 'cash-dividend' as const,
    financialAccountId,
    instrumentId,
    evidenceId,
    sourceRowId,
    declaredOn: '2026-09-01',
    exDate: '2026-09-05',
    payableOn: '2026-09-10',
    sourceReference: 'DIV-1',
    reviewReason: 'Reviewed gross and withholding facts',
    gross: amount('100', 'gross'),
    withholding: amount('15', 'withholding'),
    net: amount('85', 'net'),
    ledger: {
      cashLedgerAccountId: cashLedgerId,
      dividendIncomeLedgerAccountId: incomeLedgerId,
      withholdingLedgerAccountId: withholdingLedgerId,
    },
  };
}

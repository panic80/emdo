import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkspaceContext } from '@emdo/contracts';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';

const url = process.env.FINANCE_V2_TEST_DATABASE_URL;

/**
 * This suite exercises the 0041 revision trigger with an existing book. The
 * verifier supplies a disposable PostgreSQL database with the full migration
 * chain; no production database is ever used here.
 */
describe.skipIf(!url)('Finance corporate-action revision guard', () => {
  const admin = new pg.Pool({ connectionString: url });
  const pool = {
    async connect() {
      const client = await admin.connect();
      await client.query('set role emdo_app');
      return client;
    },
  };
  const repository = new PostgresFinanceV2Repository(pool);
  const context: WorkspaceContext = {
    workspaceId: randomUUID(),
    userId: randomUUID(),
    sessionId: randomUUID(),
    requestId: randomUUID(),
  };
  let bookId: string;
  let brokerageId: string;
  let instrumentId: string;
  let periodId: string;
  let journalId: string;

  async function sql(query: string, values: unknown[] = []) {
    const client = await admin.connect();
    try {
      await client.query('reset role');
      return await client.query(query, values);
    } finally {
      client.release();
    }
  }

  async function asApp(query: string, values: unknown[] = []) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)`,
        [context.userId, context.sessionId, randomUUID()],
      );
      const result = await client.query(query, values);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function asExecutor(query: string, values: unknown[] = []) {
    const client = await admin.connect();
    try {
      await client.query('set role emdo_finance_corporate_action_executor');
      return await client.query(query, values);
    } finally {
      await client.query('reset role');
      client.release();
    }
  }

  beforeAll(async () => {
    const { workspaceId, userId, sessionId } = context;
    await sql(
      `insert into emdo.auth_users(id,name,email,email_verified) values($1,'Corporate-action tester',$2,true)`,
      [userId, `${userId}@example.test`],
    );
    await sql(
      `insert into emdo.households(id,name,slug,created_by_user_id) values($1,'Corporate-action test',$2,$3)`,
      [workspaceId, workspaceId, userId],
    );
    await sql(
      `insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,'owner')`,
      [workspaceId, userId],
    );
    await sql(
      `insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1,$2,$3,now()+interval '1 day',$4)`,
      [sessionId, userId, sessionId, workspaceId],
    );

    bookId = String(
      (
        await repository.createBook(context, 'revision-book', {
          name: 'Revision test book',
          entityName: 'Revision test entity',
          entityKind: 'corporation',
          country: 'CA',
          functionalCurrency: 'CAD',
        })
      ).id,
    );
    const ledgerId = String(
      (
        await repository.createAccount(context, bookId, 'brokerage-ledger', {
          code: '1200',
          name: 'Brokerage',
          kind: 'asset',
        })
      ).id,
    );
    const equityId = String(
      (
        await repository.createAccount(context, bookId, 'equity-ledger', {
          code: '3200',
          name: 'Equity',
          kind: 'equity',
        })
      ).id,
    );
    brokerageId = String(
      (
        await repository.createFinancialAccount(
          context,
          bookId,
          'brokerage-account',
          {
            name: 'Synthetic brokerage',
            kind: 'brokerage',
            currency: 'CAD',
            ledgerAccountId: ledgerId,
          },
        )
      ).id,
    );
    instrumentId = String(
      (
        await repository.createInstrument(context, bookId, 'synthetic-equity', {
          name: 'Synthetic equity',
          kind: 'equity',
          quantityUnit: 'share',
          valuationMultiplier: '1',
          identifiers: [],
        })
      ).id,
    );
    periodId = String(
      (
        await repository.createPeriod(context, bookId, 'revision-period', {
          startsOn: '2026-01-01',
          endsOn: '2026-12-31',
        })
      ).id,
    );
    journalId = String(
      (
        await repository.postJournal(context, bookId, 'revision-journal', {
          effectiveOn: '2026-09-13',
          description: 'Synthetic investment funding',
          sourceReference: 'revision-test:journal',
          lines: [
            {
              accountId: ledgerId,
              side: 'debit',
              amount: '100',
              currency: 'CAD',
              nativeAmount: '100',
              fxRate: '1',
              fxSource: 'identity',
            },
            {
              accountId: equityId,
              side: 'credit',
              amount: '100',
              currency: 'CAD',
              nativeAmount: '100',
              fxRate: '1',
              fxSource: 'identity',
            },
          ],
        })
      ).id,
    );
  });

  afterAll(async () => {
    await admin.end();
  });

  it('bumps a backfilled existing-book revision on the first investment mutation', async () => {
    expect(
      (
        await sql(
          `select revision from emdo.finance_investment_lot_revisions where workspace_id=$1 and book_id=$2`,
          [context.workspaceId, bookId],
        )
      ).rows[0]?.revision,
    ).toBe(1);

    // Reproduce a book that existed before migration 0041 backfilled its
    // revision row at zero. The temporary trigger disable is test setup only.
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query(
        `alter table emdo.finance_investment_lot_revisions disable trigger finance_corporate_action_revision_immutable`,
      );
      await client.query(
        `update emdo.finance_investment_lot_revisions set revision=0 where workspace_id=$1 and book_id=$2`,
        [context.workspaceId, bookId],
      );
      await client.query(
        `alter table emdo.finance_investment_lot_revisions enable trigger finance_corporate_action_revision_immutable`,
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    const movement = await repository.recordInvestmentMovement(
      context,
      bookId,
      'first-investment-mutation',
      {
        financialAccountId: brokerageId,
        instrumentId,
        effectiveOn: '2026-09-13',
        quantity: '10',
        journalId,
        sourceReference: 'revision-test:movement',
      },
    );
    expect(movement.id).toBeDefined();
    expect(
      (
        await sql(
          `select revision from emdo.finance_investment_lot_revisions where workspace_id=$1 and book_id=$2`,
          [context.workspaceId, bookId],
        )
      ).rows[0]?.revision,
    ).toBe(1);
  });

  it('rejects direct revision writes for both the app and executor roles', async () => {
    await expect(
      asApp(
        `update emdo.finance_investment_lot_revisions set revision=99 where workspace_id=$1 and book_id=$2`,
        [context.workspaceId, bookId],
      ),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      asExecutor(
        `update emdo.finance_investment_lot_revisions set revision=99 where workspace_id=$1 and book_id=$2`,
        [context.workspaceId, bookId],
      ),
    ).rejects.toThrow('finance-corporate-action-immutable');
  });
});

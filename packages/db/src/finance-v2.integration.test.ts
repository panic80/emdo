import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';
import type { WorkspaceContext } from '@emdo/contracts';

const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
// Requires a disposable database with the complete migration chain already applied.
describe.skipIf(!url)('Finance v2 restricted PostgreSQL accounting', () => {
  const admin = new pg.Pool({ connectionString: url });
  const pool = {
    async connect() {
      const client = await admin.connect();
      await client.query('set role emdo_app');
      return client;
    },
  };
  const repository = new PostgresFinanceV2Repository(pool);
  const userId = randomUUID(),
    workspaceId = randomUUID(),
    sessionId = randomUUID();
  const otherUser = randomUUID(),
    otherSession = randomUUID();
  const context: WorkspaceContext = {
    userId,
    workspaceId,
    sessionId,
    requestId: randomUUID(),
  };
  const other: WorkspaceContext = {
    ...context,
    userId: otherUser,
    sessionId: otherSession,
    requestId: randomUUID(),
  };
  let bookId: string,
    bankId: string,
    equityId: string,
    periodId: string,
    journalId: string;
  async function sql(query: string, values: unknown[] = []) {
    const c = await admin.connect();
    try {
      await c.query('reset role');
      return await c.query(query, values);
    } finally {
      c.release();
    }
  }
  async function asApp(query: string, values: unknown[] = []) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)`,
        [userId, sessionId, randomUUID()],
      );
      const result = await c.query(query, values);
      await c.query('commit');
      return result;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }
  beforeAll(async () => {
    await sql(
      `insert into emdo.auth_users(id,name,email,email_verified) values($1,'Test owner',$2,true),($3,'Other member',$4,true)`,
      [
        userId,
        `${userId}@example.test`,
        otherUser,
        `${otherUser}@example.test`,
      ],
    );
    await sql(
      `insert into emdo.households(id,name,created_by_user_id,slug) values($1::uuid,'Synthetic finance test',$2,$3)`,
      [workspaceId, userId, workspaceId],
    );
    await sql(
      `insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,'owner'),($1,$3,'member')`,
      [workspaceId, userId, otherUser],
    );
    await sql(
      `insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1::uuid,$2,$1::text,now()+interval '1 day',$3),($4::uuid,$5,$4::text,now()+interval '1 day',$3)`,
      [sessionId, userId, workspaceId, otherSession, otherUser],
    );
  });
  afterAll(async () => {
    await admin.end();
  });
  it('creates a private book with an idempotent receipt', async () => {
    const input = {
      name: 'Operating',
      entityName: 'Example',
      entityKind: 'corporation',
      country: 'CA',
      functionalCurrency: 'CAD',
    };
    const result = await repository.createBook(context, 'book', input);
    bookId = String(result.id);
    expect(await repository.createBook(context, 'book', input)).toEqual(result);
    await expect(
      repository.createBook(context, 'book', { ...input, name: 'Changed' }),
    ).rejects.toThrow('idempotency-conflict');
    expect(await repository.listBooks(other)).toEqual([]);
    await expect(repository.overview(other, bookId)).rejects.toThrow(
      'forbidden',
    );
  });
  it('creates chart and period; posts exactly once under concurrent retries', async () => {
    bankId = String(
      (
        await repository.createAccount(context, bookId, 'bank', {
          code: '1000',
          name: 'Cash',
          kind: 'asset',
        })
      ).id,
    );
    equityId = String(
      (
        await repository.createAccount(context, bookId, 'equity', {
          code: '3000',
          name: 'Capital',
          kind: 'equity',
        })
      ).id,
    );
    periodId = String(
      (
        await repository.createPeriod(context, bookId, 'period', {
          startsOn: '2026-01-01',
          endsOn: '2026-12-31',
        })
      ).id,
    );
    const input = {
      effectiveOn: '2026-09-13',
      description: 'Opening capital',
      sourceReference: 'synthetic:1',
      lines: [
        {
          accountId: bankId,
          side: 'debit',
          amount: '100.01',
          currency: 'CAD',
          nativeAmount: '100.01',
          fxRate: '1',
          fxSource: 'identity',
        },
        {
          accountId: equityId,
          side: 'credit',
          amount: '100.01',
          currency: 'CAD',
          nativeAmount: '100.01',
          fxRate: '1',
          fxSource: 'identity',
        },
      ],
    };
    const results = await Promise.all([
      repository.postJournal(context, bookId, 'post', input),
      repository.postJournal(context, bookId, 'post', input),
    ]);
    expect(results[0]).toEqual(results[1]);
    journalId = String(results[0]!.id);
    const overview = await repository.overview(context, bookId);
    expect(overview.journals).toHaveLength(1);
    expect(overview.trialBalance.map((row) => String(row.balance))).toEqual([
      '100.010000000000',
      '-100.010000000000',
    ]);
  });
  it('rejects an unbalanced posting through SQL and rolls back the draft', async () => {
    const id = randomUUID();
    await expect(
      asApp(`
      insert into emdo.finance_journals(id,workspace_id,book_id,effective_on,description,source_reference,period_id,idempotency_key,payload_hash,created_by)
      values('${id}','${workspaceId}','${bookId}','2026-09-13','Invalid','synthetic-unbalanced','${periodId}','unbalanced','${'a'.repeat(64)}','${userId}');
      insert into emdo.finance_journal_lines(workspace_id,book_id,journal_id,account_id,line_number,side,amount,currency,native_amount,fx_rate,fx_source)
      values('${workspaceId}','${bookId}','${id}','${bankId}',1,'debit',10,'CAD',10,1,'identity'),
      ('${workspaceId}','${bookId}','${id}','${equityId}',2,'credit',9,'CAD',9,1,'identity');
      update emdo.finance_journals set status='posted',posted_at=now() where id='${id}';
    `),
    ).rejects.toThrow('unbalanced');
    expect(
      (await sql('select id from emdo.finance_journals where id=$1', [id]))
        .rows,
    ).toHaveLength(0);
  });
  it('database rejects direct changes to posted history and account identity', async () => {
    await expect(
      asApp(
        `update emdo.finance_journal_lines set amount=200 where journal_id=$1`,
        [journalId],
      ),
    ).rejects.toThrow('immutable');
    await expect(
      asApp(
        `update emdo.finance_journals set description='tamper' where id=$1`,
        [journalId],
      ),
    ).rejects.toThrow('immutable');
    await expect(
      asApp(
        `update emdo.finance_ledger_accounts set kind='income' where id=$1`,
        [bankId],
      ),
    ).rejects.toThrow('immutable');
    await expect(
      asApp(`delete from emdo.finance_journals where id=$1`, [journalId]),
    ).rejects.toThrow('permission denied');
  });
  it('allows explicitly granted viewers to read but not write', async () => {
    await sql(
      `insert into emdo.finance_book_grants(workspace_id,book_id,user_id,role) values($1,$2,$3,'viewer')`,
      [workspaceId, bookId, otherUser],
    );
    expect((await repository.overview(other, bookId)).journals).toHaveLength(1);
    await expect(
      repository.createAccount(other, bookId, 'viewer-write', {
        code: '9999',
        name: 'Forbidden',
        kind: 'asset',
      }),
    ).rejects.toThrow('forbidden');
    await sql(
      `update emdo.finance_book_grants set role='preparer' where workspace_id=$1 and book_id=$2 and user_id=$3`,
      [workspaceId, bookId, otherUser],
    );
    expect(
      (
        await repository.createAccount(other, bookId, 'preparer-account', {
          code: '2000',
          name: 'Payables',
          kind: 'liability',
        })
      ).id,
    ).toBeDefined();
    await expect(
      repository.closePeriod(other, bookId, periodId, 'preparer-close'),
    ).rejects.toThrow('approval authority');
  });
  it('reverses with preserved FX and closes a period', async () => {
    await repository.reverseJournal(context, bookId, journalId, 'reverse', {
      effectiveOn: '2026-09-14',
      reason: 'Reverse synthetic capital',
    });
    const overview = await repository.overview(context, bookId);
    expect(overview.journals).toHaveLength(2);
    expect(
      overview.trialBalance.every((row) => Number(row.balance) === 0),
    ).toBe(true);
    await repository.closePeriod(context, bookId, periodId, 'close');
    await expect(
      repository.reverseJournal(context, bookId, journalId, 'reverse-again', {
        effectiveOn: '2026-09-15',
        reason: 'Must reject',
      }),
    ).rejects.toThrow('open-period-required');
  });
  it('enforces creation entitlements without removing existing reads', async () => {
    await sql(
      `update emdo.workspace_entitlements set enabled=false where workspace_id=$1`,
      [workspaceId],
    );
    await expect(
      repository.createBook(context, 'disabled', {
        name: 'Blocked',
        entityName: 'Example',
        entityKind: 'individual',
        country: 'JP',
        functionalCurrency: 'JPY',
      }),
    ).rejects.toThrow('entitlement');
    expect(await repository.listBooks(context)).toHaveLength(1);
  });
  it('denies access after grant or session revocation, including receipt retries', async () => {
    await sql(
      `update emdo.finance_book_grants set revoked_at=now() where workspace_id=$1 and book_id=$2 and user_id=$3`,
      [workspaceId, bookId, userId],
    );
    await expect(
      repository.closePeriod(context, bookId, periodId, 'close'),
    ).rejects.toThrow('forbidden');
    expect(await repository.listBooks(context)).toEqual([]);
    await sql(
      `update emdo.auth_sessions set expires_at=now()-interval '1 minute' where id=$1`,
      [sessionId],
    );
    await expect(repository.listBooks(context)).rejects.toThrow();
  });
});

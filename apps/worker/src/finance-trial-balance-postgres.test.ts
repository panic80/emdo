import {
  dispatchFinanceDeliveries,
  enqueueFinanceDelivery,
  financeDeliveryPayloadHash,
} from './finance-delivery.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgresFinanceV2Repository,
  PostgresFinanceAutomationRepository,
  PostgresFinanceGeneratedReportRepository,
} from '@emdo/db/api';
import {
  createDatabaseClient as createWorkerDatabaseClient,
  PostgresFinanceDeliveryRepository,
  PostgresFinanceAutomationExecutionRepository,
  PostgresFinanceGeneratedReportExecutionRepository,
} from '@emdo/db/worker';
import {
  createFinanceAutomationDispatcher,
  registerFinanceAutomationWorker,
  FINANCE_AUTOMATION_QUEUE,
  financeAutomationQueueJobId,
} from './finance-automation-worker.js';
import { createFinanceAccountingReportLeaf } from './finance-accounting-report-leaf.js';
import { createProductionFinanceAutomationDispatcher } from './finance-automation-production.js';

const url = process.env.FINANCE_GENERATED_REPORT_TEST_DATABASE_URL;
describe.skipIf(!url)(
  'Generated posted-ledger report through restricted worker PostgreSQL',
  () => {
    const admin = new pg.Pool({ connectionString: url });
    const rolePool = (role: string) => ({
      async connect() {
        const client = await admin.connect();
        await client.query(`set role ${role}`);
        return client;
      },
    });
    const workerUrl = new URL(url ?? 'postgresql://localhost/unused');
    workerUrl.username = 'emdo_worker_executor_login';
    workerUrl.password = 'synthetic-finance-report-test-only';
    const workerDatabase = createWorkerDatabaseClient({
      connectionString: workerUrl.href,
      fixedRole: 'emdo_worker_executor',
    });
    const dispatcherUrl = new URL(workerUrl.href);
    dispatcherUrl.username = 'emdo_worker_dispatcher_login';
    const dispatcherDatabase = createWorkerDatabaseClient({
      connectionString: dispatcherUrl.href,
      fixedRole: 'emdo_worker_dispatch_executor',
    });
    const deliveries = new PostgresFinanceDeliveryRepository(
      dispatcherDatabase.scopedPool,
    );
    const appPool = rolePool('emdo_app'),
      workerPool = workerDatabase.scopedPool;
    const finance = new PostgresFinanceV2Repository(appPool),
      management = new PostgresFinanceAutomationRepository(appPool),
      reports = new PostgresFinanceGeneratedReportRepository(appPool);
    const executions = new PostgresFinanceAutomationExecutionRepository(
        workerPool,
      ),
      reportExecution = new PostgresFinanceGeneratedReportExecutionRepository(
        workerPool,
      );
    const dispatch = createFinanceAutomationDispatcher({
      executions,
      leaves: [createFinanceAccountingReportLeaf(reportExecution)],
      now: () => new Date().toISOString(),
    });
    async function sql(query: string, values: unknown[] = []) {
      const c = await admin.connect();
      try {
        await c.query('reset role');
        return await c.query(query, values);
      } finally {
        c.release();
      }
    }
    beforeAll(async () => {
      await sql(
        "do $$ begin if not exists(select from pg_roles where rolname='emdo_worker_executor_login') then create role emdo_worker_executor_login login nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication; end if; end $$",
      );
      await sql(
        "alter role emdo_worker_executor_login password 'synthetic-finance-report-test-only'",
      );
      await sql(
        'grant emdo_worker_executor to emdo_worker_executor_login with inherit false, set true',
      );
      await sql(
        "do $$ begin if not exists(select from pg_roles where rolname='emdo_worker_dispatcher_login') then create role emdo_worker_dispatcher_login login nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication; end if; end $$",
      );
      await sql(
        "alter role emdo_worker_dispatcher_login password 'synthetic-finance-report-test-only'",
      );
      await sql(
        'grant emdo_worker_dispatch_executor to emdo_worker_dispatcher_login with inherit false, set true',
      );
      await workerDatabase.checkReady({ signal: AbortSignal.timeout(3000) });
      await dispatcherDatabase.checkReady({
        signal: AbortSignal.timeout(3000),
      });
      await deliveries.checkReady();
      for (
        let batch = 0;
        batch < 100 && (await deliveries.reconcileStalled(20)) > 0;
        batch++
      ) {
        /* Drain earlier synthetic fixtures when rerunning locally. */
      }
    });
    afterAll(async () => {
      await dispatcherDatabase.close();
      await workerDatabase.close();
      await admin.end();
    });
    async function fixture() {
      const userId = randomUUID(),
        workspaceId = randomUUID(),
        sessionId = randomUUID();
      await sql(
        "insert into emdo.auth_users(id,name,email,email_verified) values($1,'Report test',$2,true)",
        [userId, `${userId}@example.test`],
      );
      await sql(
        "insert into emdo.households(id,name,created_by_user_id,slug) values($1::uuid,'Report test',$2,$1::text)",
        [workspaceId, userId],
      );
      await sql(
        "insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,'owner')",
        [workspaceId, userId],
      );
      await sql(
        "insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1::uuid,$2,$1::text,now()+interval '1 day',$3)",
        [sessionId, userId, workspaceId],
      );
      const context = {
        userId,
        workspaceId,
        sessionId,
        requestId: randomUUID(),
      };
      const bookId = String(
        (
          await finance.createBook(context, randomUUID(), {
            name: 'Report book',
            entityName: 'Example',
            entityKind: 'corporation',
            country: 'CA',
            functionalCurrency: 'CAD',
          })
        ).id,
      );
      const cashId = String(
        (
          await finance.createAccount(context, bookId, randomUUID(), {
            code: '1000',
            name: 'Cash snapshot label',
            kind: 'asset',
          })
        ).id,
      );
      const equityId = String(
        (
          await finance.createAccount(context, bookId, randomUUID(), {
            code: '3000',
            name: 'Equity',
            kind: 'equity',
          })
        ).id,
      );
      const periodId = String(
        (
          await finance.createPeriod(context, bookId, randomUUID(), {
            startsOn: '2026-01-01',
            endsOn: '2026-12-31',
          })
        ).id,
      );
      const journals = [] as string[];
      for (const amount of ['0.10', '0.20']) {
        const result = await finance.postJournal(
          context,
          bookId,
          randomUUID(),
          {
            effectiveOn: '2026-09-13',
            description: 'Synthetic contribution',
            sourceReference: `synthetic:${amount}`,
            lines: [
              {
                accountId: cashId,
                side: 'debit',
                amount,
                currency: 'CAD',
                nativeAmount: amount,
                fxRate: '1',
                fxSource: 'identity',
              },
              {
                accountId: equityId,
                side: 'credit',
                amount,
                currency: 'CAD',
                nativeAmount: amount,
                fxRate: '1',
                fxSource: 'identity',
              },
            ],
          },
        );
        journals.push(String(result.id));
      }
      const client = await appPool.connect();
      const draftId = randomUUID();
      try {
        await client.query('begin');
        await client.query(
          "select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)",
          [userId, sessionId, randomUUID()],
        );
        await client.query(
          "insert into emdo.finance_journals(id,workspace_id,book_id,effective_on,description,source_reference,period_id,idempotency_key,payload_hash,created_by) values($1,$2,$3,'2026-09-13','Unposted draft','synthetic:draft',$4,$5,$6,$7)",
          [
            draftId,
            workspaceId,
            bookId,
            periodId,
            randomUUID(),
            'a'.repeat(64),
            userId,
          ],
        );
        await client.query(
          "insert into emdo.finance_journal_lines(workspace_id,book_id,journal_id,account_id,line_number,side,amount,currency,native_amount,fx_rate,fx_source) values($1,$2,$3,$4,1,'debit',999,'CAD',999,1,'identity'),($1,$2,$3,$5,2,'credit',999,'CAD',999,1,'identity')",
          [workspaceId, bookId, draftId, cashId, equityId],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      await sql(
        "insert into emdo.workspace_entitlements(workspace_id,capability,enabled) values($1,'finance.automations.run',true)",
        [workspaceId],
      );
      // This readiness change exists only in the disposable test database.
      await sql(
        "update emdo.finance_automation_capabilities set ready=true where capability='finance.reports.generate'",
      );
      const grant = await management.createGrant(context, bookId, {
        capabilities: ['finance.reports.generate'],
        limits: {
          maxRuns: 5,
          maxAttemptsPerRun: 2,
          maxItemsPerRun: 1,
          maxTotalItems: 5,
          currency: 'CAD',
          maxAmountPerRun: '0',
          maxTotalAmount: '0',
        },
        validFrom: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      const request = {
        operationId: randomUUID(),
        grantId: grant.id,
        capability: 'finance.reports.generate',
        targets: [bookId],
        currency: 'CAD',
        amount: '0',
      };
      await management.enqueueRun(context, bookId, request);
      return {
        context,
        bookId,
        cashId,
        equityId,
        periodId,
        journals,
        draftId,
        grant,
        request,
      };
    }
    it('persists exact posted movements and completes atomically, with immutable snapshot labels', async () => {
      const f = await fixture();
      expect(await reports.checkReady()).toBe(true);
      const result = await dispatch(
        f.request.operationId,
        1,
        new AbortController().signal,
      );
      if (result.status !== 'completed')
        throw Error(`Expected completed report, got ${result.status}`);
      const report = await reports.get(
        f.context,
        f.bookId,
        result.outcomeReference,
      );
      expect(report).toMatchObject({
        reportVersion: 1,
        kind: 'posted-ledger-trial-balance',
        coverage: 'all-posted-journals-at-snapshot',
        currency: 'CAD',
        totalDebit: '0.3',
        totalCredit: '0.3',
      });
      expect(
        report?.rows.find((row) => row.accountId === f.cashId),
      ).toMatchObject({
        name: 'Cash snapshot label',
        debit: '0.3',
        credit: '0',
        balance: '0.3',
      });
      expect(report?.sourceJournals.map((row) => row.journalId).sort()).toEqual(
        f.journals.sort(),
      );
      expect(
        report?.sourceJournals.some((row) => row.journalId === f.draftId),
      ).toBe(false);
      expect(
        (
          await sql(
            'select status,outcome_reference from emdo.finance_automation_runs where id=$1',
            [f.request.operationId],
          )
        ).rows[0],
      ).toEqual({
        status: 'completed',
        outcome_reference: result.outcomeReference,
      });
      expect(
        await dispatch(f.request.operationId, 1, new AbortController().signal),
      ).toEqual({
        status: 'duplicate',
        outcomeReference: result.outcomeReference,
      });
      expect(
        (await reports.list(f.context, f.bookId, 0, 1)).reports,
      ).toHaveLength(1);
      await expect(
        sql(
          "update emdo.finance_generated_reports set currency='USD' where id=$1",
          [result.outcomeReference],
        ),
      ).rejects.toThrow('immutable');
      const other = await fixture();
      await expect(
        reports.get(other.context, f.bookId, result.outcomeReference),
      ).rejects.toMatchObject({ code: 'authorization-revoked' });
      // A later account label edit cannot rewrite the saved snapshot.
      const c = await appPool.connect();
      try {
        await c.query('begin');
        await c.query(
          "select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true)",
          [f.context.userId, f.context.sessionId],
        );
        await c.query(
          "update emdo.finance_ledger_accounts set name='Renamed later' where id=$1",
          [f.cashId],
        );
        await c.query('commit');
      } finally {
        c.release();
      }
      expect(
        (
          await reports.get(f.context, f.bookId, result.outcomeReference)
        )?.rows.find((row) => row.accountId === f.cashId)?.name,
      ).toBe('Cash snapshot label');
    });
    it('generates scoped income and balance statements with exact reconciliation', async () => {
      const f = await fixture();
      const revenueId = String(
        (
          await finance.createAccount(f.context, f.bookId, randomUUID(), {
            code: '4000',
            name: 'Revenue',
            kind: 'income',
          })
        ).id,
      );
      const expenseId = String(
        (
          await finance.createAccount(f.context, f.bookId, randomUUID(), {
            code: '5000',
            name: 'Operating expense',
            kind: 'expense',
          })
        ).id,
      );
      await finance.postJournal(f.context, f.bookId, randomUUID(), {
        effectiveOn: '2026-09-14',
        description: 'Revenue',
        sourceReference: 'synthetic:revenue',
        lines: [
          {
            accountId: f.cashId,
            side: 'debit',
            amount: '100',
            currency: 'CAD',
            nativeAmount: '100',
            fxRate: '1',
            fxSource: 'identity',
          },
          {
            accountId: revenueId,
            side: 'credit',
            amount: '100',
            currency: 'CAD',
            nativeAmount: '100',
            fxRate: '1',
            fxSource: 'identity',
          },
        ],
      });
      await finance.postJournal(f.context, f.bookId, randomUUID(), {
        effectiveOn: '2026-09-15',
        description: 'Operating expense',
        sourceReference: 'synthetic:expense',
        lines: [
          {
            accountId: expenseId,
            side: 'debit',
            amount: '30',
            currency: 'CAD',
            nativeAmount: '30',
            fxRate: '1',
            fxSource: 'identity',
          },
          {
            accountId: f.cashId,
            side: 'credit',
            amount: '30',
            currency: 'CAD',
            nativeAmount: '30',
            fxRate: '1',
            fxSource: 'identity',
          },
        ],
      });
      // A reversal exercises source history while keeping a non-income
      // contribution out of current-year earnings.
      await finance.reverseJournal(
        f.context,
        f.bookId,
        f.journals[0]!,
        randomUUID(),
        { effectiveOn: '2026-09-16', reason: 'Correct contribution' },
      );
      await reports.setClassification(f.context, f.bookId, f.cashId, {
        statement: 'balance-sheet',
        section: 'current-assets',
      });
      await reports.setClassification(f.context, f.bookId, f.equityId, {
        statement: 'balance-sheet',
        section: 'equity',
      });
      await reports.setClassification(f.context, f.bookId, revenueId, {
        statement: 'income-statement',
        section: 'revenue',
      });
      await reports.setClassification(f.context, f.bookId, expenseId, {
        statement: 'income-statement',
        section: 'operating-expenses',
      });
      const incomeRequest = {
        ...f.request,
        operationId: randomUUID(),
        report: { kind: 'income-statement' as const, periodId: f.periodId },
      };
      await management.enqueueRun(f.context, f.bookId, incomeRequest);
      const incomeResult = await dispatch(
        incomeRequest.operationId,
        1,
        new AbortController().signal,
      );
      if (incomeResult.status !== 'completed')
        throw Error(`Expected income statement, got ${incomeResult.status}`);
      const income = await reports.get(
        f.context,
        f.bookId,
        incomeResult.outcomeReference,
      );
      expect(income).toMatchObject({
        kind: 'income-statement',
        periodId: f.periodId,
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
        totalDebit: '30',
        totalCredit: '100',
      });
      expect(
        income?.rows.find((row) => row.accountId === revenueId),
      ).toMatchObject({
        debit: '0',
        credit: '100',
        balance: '-100',
        balanceBasis: 'debit-minus-credit',
        classification: {
          statement: 'income-statement',
          section: 'revenue',
          revision: 1,
        },
      });
      expect(
        income?.rows.find((row) => row.accountId === expenseId),
      ).toMatchObject({
        debit: '30',
        credit: '0',
        balance: '30',
        balanceBasis: 'debit-minus-credit',
      });
      expect(income?.reconciliation).toMatchObject({
        statementTotalDebit: '30',
        statementTotalCredit: '100',
        sourceTotalDebit: '130.4',
        sourceTotalCredit: '130.4',
        balanced: true,
      });
      const balanceRequest = {
        ...f.request,
        operationId: randomUUID(),
        report: { kind: 'balance-sheet' as const, asOf: '2026-09-16' },
      };
      await management.enqueueRun(f.context, f.bookId, balanceRequest);
      const balanceResult = await dispatch(
        balanceRequest.operationId,
        1,
        new AbortController().signal,
      );
      if (balanceResult.status !== 'completed')
        throw Error(`Expected balance sheet, got ${balanceResult.status}`);
      const balance = await reports.get(
        f.context,
        f.bookId,
        balanceResult.outcomeReference,
      );
      expect(balance).toMatchObject({
        kind: 'balance-sheet',
        asOf: '2026-09-16',
      });
      expect(
        balance?.rows.find((row) => row.accountId === f.cashId),
      ).toMatchObject({
        debit: '70.2',
        credit: '0',
        balance: '70.2',
        balanceBasis: 'debit-minus-credit',
      });
      expect(
        balance?.rows.find((row) => row.accountId === f.equityId),
      ).toMatchObject({
        debit: '0',
        credit: '0.2',
        balance: '0.2',
        balanceBasis: 'credit-minus-debit',
      });
      expect(balance?.reconciliation).toMatchObject({
        balanceSheetAssets: '70.2',
        balanceSheetLiabilities: '0',
        balanceSheetEquity: '0.2',
        currentYearEarnings: '70',
        difference: '0',
        balanced: true,
      });
      expect(
        balance?.sourceJournals.some(
          (source) => source.sourceReference === 'synthetic:expense',
        ),
      ).toBe(true);
    });
    it('blocks a statement run until every natural account is classified', async () => {
      const f = await fixture();
      const request = {
        ...f.request,
        operationId: randomUUID(),
        report: { kind: 'income-statement' as const, periodId: f.periodId },
      };
      await management.enqueueRun(f.context, f.bookId, request);
      const result = await dispatch(
        request.operationId,
        1,
        new AbortController().signal,
      );
      expect(result).toEqual({
        status: 'blocked',
        reason: 'report-missing-account-classification',
      });
      expect(
        (
          await sql(
            'select status,blocked_reason,outcome_reference from emdo.finance_automation_runs where id=$1',
            [request.operationId],
          )
        ).rows[0],
      ).toEqual({
        status: 'blocked',
        blocked_reason: 'report-missing-account-classification',
        outcome_reference: null,
      });
      expect((await reports.list(f.context, f.bookId)).reports).toHaveLength(0);
    });
    it('preserves exact aggregates beyond the individual source amount range', async () => {
      const f = await fixture();
      const amount = '99999999999999999999999999.99';
      await finance.postJournal(f.context, f.bookId, randomUUID(), {
        effectiveOn: '2026-09-13',
        description: 'Large exact contribution',
        sourceReference: 'synthetic:large',
        lines: [
          {
            accountId: f.cashId,
            side: 'debit',
            amount,
            currency: 'CAD',
            nativeAmount: amount,
            fxRate: '1',
            fxSource: 'identity',
          },
          {
            accountId: f.equityId,
            side: 'credit',
            amount,
            currency: 'CAD',
            nativeAmount: amount,
            fxRate: '1',
            fxSource: 'identity',
          },
        ],
      });
      const result = await dispatch(
        f.request.operationId,
        1,
        new AbortController().signal,
      );
      if (result.status !== 'completed') throw Error('Missing large report');
      const report = await reports.get(
        f.context,
        f.bookId,
        result.outcomeReference,
      );
      expect(report?.totalDebit).toBe('100000000000000000000000000.29');
      expect(report?.totalCredit).toBe(report?.totalDebit);
    });
    it('rejects revoked or expired leases before any snapshot save', async () => {
      const f = await fixture();
      const claim = await executions.claimDelivery(f.request.operationId, 1);
      if (claim.status !== 'claimed') throw Error('Missing claim');
      await management.revokeGrant(f.context, f.bookId, f.grant.id);
      await expect(
        reportExecution.generateTrialBalance({
          operationId: f.request.operationId,
          expectedRevision: claim.run.revision,
          leaseToken: claim.leaseToken,
        }),
      ).rejects.toThrow('authority-denied');
      expect((await reports.list(f.context, f.bookId)).reports).toHaveLength(0);
      const other = await fixture();
      const next = await executions.claimDelivery(other.request.operationId, 1);
      if (next.status !== 'claimed') throw Error('Missing next claim');
      await sql(
        "update emdo.finance_automation_runs set lease_expires_at=now()-interval '1 second' where id=$1",
        [other.request.operationId],
      );
      await expect(
        reportExecution.generateTrialBalance({
          operationId: other.request.operationId,
          expectedRevision: next.run.revision,
          leaseToken: next.leaseToken,
        }),
      ).rejects.toThrow('authority-denied');
      expect(
        (await reports.list(other.context, other.bookId)).reports,
      ).toHaveLength(0);
    });
    it('fails visibly at source caps and saves no partial report', async () => {
      const f = await fixture();
      const c = await appPool.connect();
      try {
        await c.query('begin');
        await c.query(
          "select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)",
          [f.context.userId, f.context.sessionId, randomUUID()],
        );
        await c.query(
          "insert into emdo.finance_ledger_accounts(workspace_id,book_id,code,name,kind) select $1,$2,'CAP'||n::text,'Synthetic capped account','asset' from generate_series(1,9999) n",
          [f.context.workspaceId, f.bookId],
        );
        await c.query('commit');
      } catch (error) {
        await c.query('rollback');
        throw error;
      } finally {
        c.release();
      }
      const claim = await executions.claimDelivery(f.request.operationId, 1);
      if (claim.status !== 'claimed') throw Error('Missing capped claim');
      await expect(
        reportExecution.generateTrialBalance({
          operationId: f.request.operationId,
          expectedRevision: claim.run.revision,
          leaseToken: claim.leaseToken,
        }),
      ).rejects.toThrow('source-limit-exceeded');
      expect((await reports.list(f.context, f.bookId)).reports).toHaveLength(0);
    }, 20000);
    it('paginates complete immutable snapshots and keeps ordinary reads after entitlement removal', async () => {
      const f = await fixture();
      const first = await dispatch(
        f.request.operationId,
        1,
        new AbortController().signal,
      );
      if (first.status !== 'completed') throw Error('Missing first report');
      const next = { ...f.request, operationId: randomUUID() };
      await management.enqueueRun(f.context, f.bookId, next);
      const second = await dispatch(
        next.operationId,
        1,
        new AbortController().signal,
      );
      if (second.status !== 'completed') throw Error('Missing second report');
      const page = await reports.list(f.context, f.bookId, 0, 1);
      expect(page.reports[0]?.id).toBe(second.outcomeReference);
      expect(page.nextOffset).toBe(1);
      const tail = await reports.list(f.context, f.bookId, 1, 1);
      expect(tail.reports[0]?.id).toBe(first.outcomeReference);
      expect(tail.nextOffset).toBeNull();
      await sql(
        "update emdo.workspace_entitlements set enabled=false where workspace_id=$1 and capability='finance.automations.run'",
        [f.context.workspaceId],
      );
      expect(
        (await reports.get(f.context, f.bookId, first.outcomeReference))
          ?.totalDebit,
      ).toBe('0.3');
    });
    it('rolls back both the run and its delivery and denies direct dispatcher mutations', async () => {
      const f = await fixture();
      const rid = randomUUID();
      const c = await appPool.connect();
      try {
        await c.query('begin');
        await c.query(
          "select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)",
          [f.context.userId, f.context.sessionId, randomUUID()],
        );
        await c.query(
          'select emdo.enqueue_finance_automation_run($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            f.context.workspaceId,
            f.bookId,
            f.grant.id,
            rid,
            'finance.reports.generate',
            JSON.stringify([f.bookId]),
            'CAD',
            '0',
          ],
        );
        await c.query('rollback');
      } finally {
        c.release();
      }
      expect(
        (
          await sql('select id from emdo.finance_automation_runs where id=$1', [
            rid,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (
          await sql(
            'select id from emdo.finance_deliveries where operation_id=$1',
            [rid],
          )
        ).rows,
      ).toEqual([]);
      const restricted = await dispatcherDatabase.scopedPool.connect();
      try {
        await expect(
          restricted.query(
            "update emdo.finance_deliveries set state='enqueued'",
          ),
        ).rejects.toThrow('permission denied');
      } finally {
        restricted.release();
      }
    });
    it('atomically persists initial/retry deliveries and claims each revision once across dispatchers', async () => {
      await sql(
        "update emdo.finance_deliveries set state='cancelled' where state in ('pending','leased')",
      );
      const f = await fixture();
      await management.enqueueRun(f.context, f.bookId, f.request);
      expect(
        (
          await sql(
            'select * from emdo.finance_deliveries where operation_id=$1',
            [f.request.operationId],
          )
        ).rows,
      ).toHaveLength(1);
      const [a, b] = await Promise.all([
        deliveries.claim(),
        deliveries.claim(),
      ]);
      const claimed = [...a, ...b].filter(
        (d) => d.operationId === f.request.operationId,
      );
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.id).toBe(
        financeAutomationQueueJobId(f.request.operationId, 1),
      );
      expect(claimed[0]?.payloadHash).toBe(
        financeDeliveryPayloadHash({
          operationId: f.request.operationId,
          deliveryRevision: 1,
        }),
      );
      const first = await executions.claimDelivery(f.request.operationId, 1);
      if (first.status !== 'claimed') throw Error('Missing initial claim');
      const retry = await executions.settle({
        operationId: f.request.operationId,
        expectedRevision: first.run.revision,
        leaseToken: first.leaseToken,
        result: 'not-applied',
      });
      expect(retry.status).toBe('retryable');
      expect(
        (
          await sql(
            'select delivery_revision from emdo.finance_deliveries where operation_id=$1 order by delivery_revision',
            [f.request.operationId],
          )
        ).rows,
      ).toEqual([{ delivery_revision: 1 }, { delivery_revision: 3 }]);
      expect(
        await executions.claimDelivery(f.request.operationId, 1),
      ).toMatchObject({
        status: 'denied',
        reason: 'delivery-revision-conflict',
      });
      const next = await executions.claimDelivery(f.request.operationId, 3);
      if (next.status !== 'claimed') throw Error('Missing retry claim');
      await executions.settle({
        operationId: f.request.operationId,
        expectedRevision: next.run.revision,
        leaseToken: next.leaseToken,
        result: 'indeterminate',
      });
      expect(
        (
          await sql(
            'select count(*)::int as n from emdo.finance_deliveries where operation_id=$1',
            [f.request.operationId],
          )
        ).rows[0]?.n,
      ).toBe(2);
      expect(await deliveries.claim()).toEqual([]);
    });
    it('cancels revoked authority and fences lost acknowledgement leases', async () => {
      await sql(
        "update emdo.finance_deliveries set state='cancelled' where state in ('pending','leased')",
      );
      const f = await fixture();
      const [d] = await deliveries.claim();
      if (!d) throw Error('Missing delivery');
      // A successful broker send with no database ack must retry this exact identity.
      await sql(
        "update emdo.finance_deliveries set lease_expires_at=now()-interval '1 second' where id=$1",
        [d.id],
      );
      const [reclaimed] = await deliveries.claim();
      expect(reclaimed?.id).toBe(d.id);
      expect(reclaimed?.leaseToken).not.toBe(d.leaseToken);
      expect(await deliveries.acknowledge(d, 'enqueued')).toBe(false);
      if (!reclaimed) throw Error('Missing reclaimed delivery');
      expect(await deliveries.acknowledge(reclaimed, 'enqueued')).toBe(true);
      expect(await deliveries.acknowledge(reclaimed, 'enqueued')).toBe(true);
      const denied = await fixture();
      await management.revokeGrant(
        denied.context,
        denied.bookId,
        denied.grant.id,
      );
      expect(await deliveries.claim()).toEqual([]);
      expect(
        (
          await sql(
            'select state from emdo.finance_deliveries where operation_id=$1',
            [denied.request.operationId],
          )
        ).rows[0]?.state,
      ).toBe('cancelled');
      await expect(
        sql('update emdo.finance_deliveries set payload_hash=$1 where id=$2', [
          'f'.repeat(64),
          d.id,
        ]),
      ).rejects.toThrow('immutable');
      expect(
        (
          await sql(
            'select attempts from emdo.finance_automation_runs where id=$1',
            [f.request.operationId],
          )
        ).rows[0]?.attempts,
      ).toBe(0);
    });
    it('exposes authority denial and transport quarantine on the canonical run', async () => {
      await sql(
        "update emdo.finance_deliveries set state='cancelled' where state in ('pending','leased')",
      );
      const revoked = await fixture();
      await management.revokeGrant(
        revoked.context,
        revoked.bookId,
        revoked.grant.id,
      );
      expect(await deliveries.claim()).toEqual([]);
      expect(
        (
          await sql(
            'select status,blocked_reason from emdo.finance_automation_runs where id=$1',
            [revoked.request.operationId],
          )
        ).rows[0],
      ).toEqual({ status: 'blocked', blocked_reason: 'grant-revoked' });
      const exhausted = await fixture();
      await sql(
        'update emdo.finance_deliveries set attempts=20 where operation_id=$1',
        [exhausted.request.operationId],
      );
      expect(await deliveries.claim()).toEqual([]);
      expect(
        (
          await sql(
            'select status,blocked_reason from emdo.finance_automation_runs where id=$1',
            [exhausted.request.operationId],
          )
        ).rows[0],
      ).toEqual({
        status: 'requires-reconciliation',
        blocked_reason: 'delivery-transport-exhausted',
      });
      const conflict = await fixture();
      const [d] = await deliveries.claim();
      if (!d) throw Error('Missing delivery');
      expect(await deliveries.acknowledge(d, 'quarantined')).toBe(true);
      expect(
        (
          await sql(
            'select status,blocked_reason from emdo.finance_automation_runs where id=$1',
            [conflict.request.operationId],
          )
        ).rows[0],
      ).toEqual({
        status: 'requires-reconciliation',
        blocked_reason: 'delivery-broker-conflict',
      });
      // An ack arriving after execution has started must not reopen or overwrite it.
      const active = await fixture();
      const [next] = await deliveries.claim();
      if (!next) throw Error('Missing active delivery');
      await executions.claimDelivery(active.request.operationId, 1);
      expect(await deliveries.acknowledge(next, 'quarantined')).toBe(true);
      expect(
        (
          await sql(
            'select status from emdo.finance_automation_runs where id=$1',
            [active.request.operationId],
          )
        ).rows[0]?.status,
      ).toBe('executing');
    });
    it('recovers broker-accepted runs never claimed and denies late handlers', async () => {
      await sql(
        "update emdo.finance_deliveries set state='cancelled' where state in ('pending','leased')",
      );
      const f = await fixture();
      const [d] = await deliveries.claim();
      if (!d) throw Error('Missing delivery');
      await deliveries.acknowledge(d, 'enqueued');
      await sql(
        "update emdo.finance_automation_runs set created_at=now()-interval '31 minutes' where id=$1",
        [f.request.operationId],
      );
      expect(await deliveries.reconcileStalled(20)).toBeGreaterThan(0);
      expect(
        (
          await sql(
            'select status,blocked_reason,attempts from emdo.finance_automation_runs where id=$1',
            [f.request.operationId],
          )
        ).rows[0],
      ).toEqual({
        status: 'requires-reconciliation',
        blocked_reason: 'delivery-deadline-exceeded',
        attempts: 0,
      });
      expect(
        (
          await sql('select state from emdo.finance_deliveries where id=$1', [
            d.id,
          ])
        ).rows[0]?.state,
      ).toBe('quarantined');
      expect(
        await executions.claimDelivery(f.request.operationId, 1),
      ).toMatchObject({ status: 'denied' });
    });
    it('recovers expired execution even after its transport delivery was cancelled', async () => {
      const f = await fixture();
      const claim = await executions.claimDelivery(f.request.operationId, 1);
      if (claim.status !== 'claimed') throw Error('Missing claim');
      await sql(
        "update emdo.finance_deliveries set state='cancelled' where operation_id=$1",
        [f.request.operationId],
      );
      await sql(
        "update emdo.finance_automation_runs set lease_expires_at=now()-interval '1 second' where id=$1",
        [f.request.operationId],
      );
      await deliveries.reconcileStalled(20);
      expect(
        (
          await sql(
            'select status,blocked_reason from emdo.finance_automation_runs where id=$1',
            [f.request.operationId],
          )
        ).rows[0],
      ).toEqual({
        status: 'requires-reconciliation',
        blocked_reason: 'execution-lease-expired',
      });
      await expect(
        reportExecution.generateTrialBalance({
          operationId: f.request.operationId,
          expectedRevision: claim.run.revision,
          leaseToken: claim.leaseToken,
        }),
      ).rejects.toThrow();
      expect((await reports.list(f.context, f.bookId)).reports).toHaveLength(0);
    });
    it('skips a live SQL report transaction and preserves its completed outcome', async () => {
      await deliveries.reconcileStalled(20);
      const f = await fixture();
      const claim = await executions.claimDelivery(f.request.operationId, 1);
      if (claim.status !== 'claimed') throw Error('Missing claim');
      await sql(
        "update emdo.finance_automation_runs set lease_expires_at=now()+interval '500 milliseconds',created_at=now()-interval '31 minutes' where id=$1",
        [f.request.operationId],
      );
      const connection = await workerDatabase.scopedPool.connect();
      try {
        await connection.query('begin');
        await connection.query(
          'select emdo.generate_finance_trial_balance($1,$2,$3)',
          [f.request.operationId, claim.run.revision, claim.leaseToken],
        );
        // The report result is saved inside this still-uncommitted SQL transaction.
        // Another snapshot sees the old executing row with an expired lease.
        await new Promise((resolve) => setTimeout(resolve, 550));
        await deliveries.reconcileStalled(20);
        expect(
          (
            await sql(
              'select status from emdo.finance_automation_runs where id=$1',
              [f.request.operationId],
            )
          ).rows[0]?.status,
        ).toBe('executing');
        await connection.query('commit');
      } catch (error) {
        await connection.query('rollback');
        throw error;
      } finally {
        connection.release();
      }
      await deliveries.reconcileStalled(20);
      expect(
        (
          await sql(
            'select status from emdo.finance_automation_runs where id=$1',
            [f.request.operationId],
          )
        ).rows[0]?.status,
      ).toBe('completed');
      expect((await reports.list(f.context, f.bookId)).reports).toHaveLength(1);
    });
    it('runs a real pg-boss delivery after browser expiry and returns the saved report outcome', async () => {
      await sql(
        "update emdo.finance_deliveries set state='cancelled' where state in ('pending','leased')",
      );
      const f = await fixture();
      await sql(
        "update emdo.auth_sessions set expires_at=now()-interval '1 second' where id=$1",
        [f.context.sessionId],
      );
      const boss = new PgBoss({
        connectionString: url!,
        schema: `report_queue_${randomUUID().replaceAll('-', '')}`,
      });
      boss.on('error', () => {});
      try {
        await boss.start();
        await boss.createQueue(FINANCE_AUTOMATION_QUEUE, {
          retryLimit: 0,
          expireInSeconds: 120,
          retentionSeconds: 2592000,
          deleteAfterSeconds: 604800,
        });
        const productionDispatch =
          await createProductionFinanceAutomationDispatcher(workerDatabase);
        const id = financeAutomationQueueJobId(f.request.operationId, 1);
        // Broker accepted, response was lost, exact readback recovered it; then
        // the outbox acknowledgement itself is lost before commit.
        await dispatchFinanceDeliveries({
          repository: {
            reconcileStalled: () => deliveries.reconcileStalled(),
            claim: () => deliveries.claim(),
            acknowledge: async () => {
              throw Error('synthetic lost ack');
            },
          },
          signal: new AbortController().signal,
          enqueue: (delivery) =>
            enqueueFinanceDelivery(
              {
                send: async (...args) => {
                  await boss.send(...args);
                  throw Error('synthetic lost broker response');
                },
                getJobById: boss.getJobById.bind(boss),
              },
              delivery,
            ),
        });
        expect(
          (
            await sql(
              'select state from emdo.finance_deliveries where operation_id=$1',
              [f.request.operationId],
            )
          ).rows[0]?.state,
        ).toBe('leased');
        await sql(
          "update emdo.finance_deliveries set lease_expires_at=now()-interval '1 second' where operation_id=$1",
          [f.request.operationId],
        );
        await Promise.all(
          [1, 2].map(() =>
            dispatchFinanceDeliveries({
              repository: deliveries,
              signal: new AbortController().signal,
              enqueue: (delivery) => enqueueFinanceDelivery(boss, delivery),
            }),
          ),
        );
        expect(
          (
            await sql(
              'select state,attempts from emdo.finance_deliveries where operation_id=$1',
              [f.request.operationId],
            )
          ).rows[0],
        ).toEqual({ state: 'enqueued', attempts: 2 });
        await registerFinanceAutomationWorker({
          boss,
          dispatch: productionDispatch,
        });
        let completed = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          const row = await boss.getJobById(FINANCE_AUTOMATION_QUEUE, id);
          if (row?.state === 'completed') {
            completed = true;
            break;
          }
          if (row?.state === 'failed') throw Error('Report queue job failed');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(completed).toBe(true);
        const stored = (
          await sql(
            'select id from emdo.finance_generated_reports where automation_run_id=$1',
            [f.request.operationId],
          )
        ).rows;
        expect(stored).toHaveLength(1);
        expect(
          (
            await sql(
              'select status,outcome_reference from emdo.finance_automation_runs where id=$1',
              [f.request.operationId],
            )
          ).rows[0],
        ).toEqual({ status: 'completed', outcome_reference: stored[0]?.id });
      } finally {
        await boss.stop({ graceful: true, timeout: 1000 });
      }
    }, 15000);
  },
);

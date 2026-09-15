import { createProductionFinanceAutomationDispatcher } from '../../../apps/worker/src/finance-automation-production.js';
import {
  PostgresFinanceScheduleRepository,
  PostgresFinanceScheduleDueRepository,
} from './finance-schedule-repository.js';
import { planFinanceAutomationDue } from '@emdo/domains/finance';
import { parseFinanceDecimal } from '@emdo/domains/finance/decimal';
import {
  FinanceBudgetVsActualsSchema,
  FinanceForecastSnapshotSchema,
} from '@emdo/contracts';
import { withDurableTransaction } from './durable/scoped-transaction.js';
import { PostgresFinanceAutomationRepository } from './finance-automation-repository.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PostgresFinancePlanningRepository } from './finance-planning-repository.js';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';

const databaseUrl = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'atomic planning automation restricted PostgreSQL',
  () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const login = `planning_${randomUUID().replaceAll('-', '')}`;
    let app: pg.Pool;
    let workerPool: pg.Pool;
    let planning: PostgresFinancePlanningRepository;
    let finance: PostgresFinanceV2Repository;
    const context = {
      workspaceId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      requestId: randomUUID(),
    };
    let bookId: string,
      cash: string,
      capital: string,
      unused: string,
      period: string,
      budgetId: string;
    const sourceKey = randomUUID();
    const journal = () => ({
      effectiveOn: '2026-03-08',
      description: 'Synthetic capital',
      sourceReference: sourceKey,
      lines: [
        {
          accountId: cash,
          side: 'debit',
          amount: '12.50',
          currency: 'CAD',
          nativeAmount: '12.50',
          fxRate: '1',
          fxSource: 'identity',
        },
        {
          accountId: capital,
          side: 'credit',
          amount: '12.50',
          currency: 'CAD',
          nativeAmount: '12.50',
          fxRate: '1',
          fxSource: 'identity',
        },
      ],
    });
    beforeAll(async () => {
      await admin.query(
        `create role "${login}" login nosuperuser nobypassrls noinherit`,
      );
      await admin.query(
        `grant emdo_app,emdo_worker_executor,emdo_finance_scheduler to "${login}"`,
      );
      const url = new URL(databaseUrl!);
      url.username = login;
      app = new pg.Pool({
        connectionString: url.toString(),
        application_name: login,
      });
      const pool = {
        async connect() {
          const client = await app.connect();
          await client.query('set role emdo_app');
          return client;
        },
      };
      workerPool = new pg.Pool({
        connectionString: url.toString(),
        application_name: login,
      });
      planning = new PostgresFinancePlanningRepository(pool);
      finance = new PostgresFinanceV2Repository(pool);
      await admin.query(
        'insert into emdo.auth_users(id,name,email,email_verified) values($1,$2,$3,true)',
        [
          context.userId,
          'Planning synthetic',
          `${context.userId}@example.test`,
        ],
      );
      await admin.query(
        'insert into emdo.households(id,name,created_by_user_id,slug) values($1,$2,$3,$4)',
        [
          context.workspaceId,
          'Planning synthetic',
          context.userId,
          context.workspaceId,
        ],
      );
      await admin.query(
        "insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,'owner')",
        [context.workspaceId, context.userId],
      );
      await admin.query(
        "insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1::uuid,$2,$1::text,now()+interval '1 day',$3)",
        [context.sessionId, context.userId, context.workspaceId],
      );
      bookId = String(
        (
          await finance.createBook(context, randomUUID(), {
            name: 'Planning',
            entityName: 'Synthetic entity',
            entityKind: 'corporation',
            country: 'CA',
            functionalCurrency: 'CAD',
          })
        ).id,
      );
      cash = String(
        (
          await finance.createAccount(context, bookId, randomUUID(), {
            code: '1000',
            name: 'Cash',
            kind: 'asset',
          })
        ).id,
      );
      capital = String(
        (
          await finance.createAccount(context, bookId, randomUUID(), {
            code: '3000',
            name: 'Capital',
            kind: 'equity',
          })
        ).id,
      );
      unused = String(
        (
          await finance.createAccount(context, bookId, randomUUID(), {
            code: '5000',
            name: 'Unused expense',
            kind: 'expense',
          })
        ).id,
      );
      period = String(
        (
          await finance.createPeriod(context, bookId, randomUUID(), {
            startsOn: '2026-01-01',
            endsOn: '2026-12-31',
          })
        ).id,
      );
    });
    afterAll(async () => {
      await app?.end();
      await workerPool?.end();
      await admin.query(`drop role if exists "${login}"`);
      await admin.end();
    });

    const appPool = {
      async connect() {
        const c = await app.connect();
        await c.query('set role emdo_app');
        return c;
      },
    };
    let grantId: string;
    let otherBookId: string;
    let savedOutcomeId: string;
    const baseIntent = () => ({
      schemaVersion: 1,
      capability: 'finance.planning.budget-vs-actuals',
      budgetId,
      budgetRevision: 1,
      asOf: null,
      currency: 'CAD',
      itemCount: 3,
    });
    async function enqueue(
      p: Record<string, unknown>,
      id = randomUUID(),
      amount = '0',
    ) {
      return withDurableTransaction(
        appPool,
        { ...context, householdId: context.workspaceId },
        { householdId: context.workspaceId },
        async (c) =>
          (
            await c.query(
              'select emdo.enqueue_finance_automation_run($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10::jsonb) as result',
              [
                context.workspaceId,
                bookId,
                grantId,
                id,
                p.capability,
                JSON.stringify([p.budgetId]),
                'CAD',
                amount,
                null,
                JSON.stringify(p),
              ],
            )
          ).rows[0]!.result as Record<string, unknown>,
      );
    }
    async function worker(query: string, args: unknown[]) {
      const c = await workerPool.connect();
      try {
        await c.query('set role emdo_worker_executor');
        return await c.query(query, args);
      } finally {
        c.release();
      }
    }
    async function claim(id: string) {
      const row = (
        await worker(
          'select emdo.claim_finance_automation_delivery($1,1) as result',
          [id],
        )
      ).rows[0].result;
      expect(row.status).toBe('claimed');
      return row;
    }
    beforeAll(async () => {
      otherBookId = String(
        (
          await finance.createBook(context, randomUUID(), {
            name: 'Other authorized book',
            entityName: 'Separate entity',
            entityKind: 'corporation',
            country: 'CA',
            functionalCurrency: 'CAD',
          })
        ).id,
      );
      const budget = await planning.saveBudget(context, bookId, randomUUID(), {
        name: 'Atomic budget',
        lines: [cash, capital, unused].map((accountId) => ({
          accountId,
          periodId: period,
          currency: 'CAD',
          amount: '9007199254740993.01',
        })),
      });
      budgetId = budget.budgetId;
      await finance.postJournal(context, bookId, randomUUID(), journal());
      await admin.query(
        "insert into emdo.workspace_entitlements(workspace_id,capability,enabled) values($1,'finance.automations.run',true)",
        [context.workspaceId],
      );
      await admin.query(
        "update emdo.finance_automation_capabilities set ready=true where capability like 'finance.planning.%'",
      );
      const grant = await new PostgresFinanceAutomationRepository(
        appPool,
      ).createGrant(context, bookId, {
        capabilities: [
          'finance.planning.budget-vs-actuals',
          'finance.planning.forecast',
        ],
        limits: {
          maxRuns: 30,
          maxAttemptsPerRun: 2,
          maxItemsPerRun: 3,
          maxTotalItems: 90,
          currency: 'CAD',
          maxAmountPerRun: '0',
          maxTotalAmount: '0',
        },
        validFrom: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      grantId = grant.id;
    });
    it('persists exact budget actuals and lineage atomically and replays one outcome', async () => {
      const run = await enqueue(baseIntent());
      const claimed = await claim(String(run.id));
      const args = [run.id, claimed.run.revision, claimed.run.lease_token];
      const result = (
        await worker(
          'select emdo.generate_finance_planning_result($1,$2,$3) as id',
          args,
        )
      ).rows[0].id;
      const saved = (
        await admin.query(
          'select * from emdo.finance_planning_results where id=$1',
          [result],
        )
      ).rows[0];
      const payload = FinanceBudgetVsActualsSchema.parse(saved.payload);
      savedOutcomeId = result;
      expect(
        await planning.getAutomationResult(context, otherBookId, result),
      ).toBeNull();
      const publicResult = await planning.getAutomationResult(
        context,
        bookId,
        result,
      );
      expect(publicResult).toMatchObject({
        id: result,
        automationRunId: run.id,
        payload: saved.payload,
        sourceHash: saved.source_hash,
      });
      expect(payload.rows.find((r) => r.accountId === cash)).toMatchObject({
        postedActualAmount: '12.5',
        varianceAmount: '-9007199254740980.51',
        sourceJournalCount: 1,
      });
      expect(payload.rows.find((r) => r.accountId === capital)).toMatchObject({
        postedActualAmount: '12.5',
        actualSignBasis: 'credit-minus-debit',
      });
      expect(payload.rows.find((r) => r.accountId === unused)).toMatchObject({
        postedActualAmount: '0',
        sourceJournalCount: 0,
      });
      expect(saved.source_lineage.sourceJournals).toHaveLength(1);
      expect(saved.source_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(
        (
          await worker(
            'select emdo.generate_finance_planning_result($1,$2,$3) as id',
            args,
          )
        ).rows[0].id,
      ).toBe(result);
      expect(
        (
          await admin.query(
            'select status,revision,outcome_reference from emdo.finance_automation_runs where id=$1',
            [run.id],
          )
        ).rows[0],
      ).toEqual({
        status: 'completed',
        revision: claimed.run.revision + 1,
        outcome_reference: result,
      });
      await expect(
        admin.query(
          "update emdo.finance_planning_results set payload='{}' where id=$1",
          [result],
        ),
      ).rejects.toThrow('finance-planning-history-immutable');
    });
    it('rejects queue count lies and unpersisted forecast review claims', async () => {
      await expect(enqueue({ ...baseIntent(), itemCount: 1 })).rejects.toThrow(
        'planning-item-count-mismatch',
      );
      await expect(
        enqueue({
          ...baseIntent(),
          capability: 'finance.planning.forecast',
          asOf: '2026-06-30',
          openingBalance: {
            status: 'unavailable',
            label: 'opening-balance-unavailable',
          },
          assumptions: [],
        }),
      ).rejects.toThrow('planning-reviewed-input-unavailable');
    });
    it('accepts decimal zero formatting and rejects nonzero planning amounts', async () => {
      const zero = await enqueue(baseIntent(), randomUUID(), '0.00');
      expect((zero.intent as Record<string, unknown>).amount).toBe('0');
      await expect(enqueue(baseIntent(), randomUUID(), '0.01')).rejects.toThrow(
        'planning-invalid-intent',
      );
    });
    it('overwrites a supplied planning construction transaction marker', async () => {
      const forgedBudgetId = randomUUID();
      await withDurableTransaction(
        appPool,
        { ...context, householdId: context.workspaceId },
        { householdId: context.workspaceId },
        async (c) => {
          await c.query(
            `insert into emdo.finance_budget_revisions
              (workspace_id,book_id,budget_id,revision,name,functional_currency,created_by,
               planning_construction_txid)
             values($1,$2,$3,1,'Server marker','CAD',$4,$5::xid8)`,
            [context.workspaceId, bookId, forgedBudgetId, context.userId, '1'],
          );
          await c.query(
            `insert into emdo.finance_budget_lines
              (workspace_id,book_id,budget_id,revision,period_id,account_id,currency,amount)
             values($1,$2,$3,1,$4,$5,'CAD','1.00')`,
            [context.workspaceId, bookId, forgedBudgetId, period, cash],
          );
        },
      );
      const row = (
        await admin.query(
          'select planning_construction_txid::text as txid from emdo.finance_budget_revisions where workspace_id=$1 and book_id=$2 and budget_id=$3 and revision=1',
          [context.workspaceId, bookId, forgedBudgetId],
        )
      ).rows[0];
      expect(row.txid).not.toBe('1');
    });
    it('serializes a direct planning append behind the canonical book lock', async () => {
      const blocker = await admin.connect();
      await blocker.query('begin');
      await blocker.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${context.workspaceId}:${bookId}`],
      );
      const append = withDurableTransaction(
        appPool,
        { ...context, householdId: context.workspaceId },
        { householdId: context.workspaceId },
        async (c) =>
          c.query(
            `insert into emdo.finance_budget_lines
              (workspace_id,book_id,budget_id,revision,period_id,account_id,currency,amount)
             values($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              context.workspaceId,
              bookId,
              budgetId,
              1,
              period,
              cash,
              'CAD',
              '9007199254740993.01',
            ],
          ),
      );
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
          const activity = await admin.query(
            "select count(*)::int as count from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and lower(wait_event)='advisory'",
            [login],
          );
          waiting = activity.rows[0]?.count > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
      } finally {
        await blocker.query('commit');
        blocker.release();
      }
      await expect(append).rejects.toThrow(
        'finance-planning-history-append-forbidden',
      );
    });
    it('matches reviewed forecast inputs and retains unavailable future lines', async () => {
      const openingBalance = {
        status: 'unavailable',
        label: 'opening-balance-unavailable',
      };
      const assumptions = [
        {
          periodId: period,
          accountId: cash,
          currency: 'CAD',
          amount: '25.50',
          label: 'Reviewed annual cash',
          sourceReference: 'synthetic-review',
          reviewedBy: context.userId,
          reviewedAt: new Date().toISOString(),
        },
      ];
      const expected = await planning.saveForecast(
        context,
        bookId,
        randomUUID(),
        {
          budgetId,
          budgetRevision: 1,
          asOf: '2026-06-30',
          openingBalance,
          assumptions,
        },
      );
      const p = {
        ...baseIntent(),
        capability: 'finance.planning.forecast',
        asOf: '2026-06-30',
        openingBalance,
        assumptions,
      };
      await expect(
        enqueue({ ...p, assumptions: [{ ...assumptions[0], amount: '26' }] }),
      ).rejects.toThrow('planning-reviewed-input-unavailable');
      const run = await enqueue(p);
      const claimed = await claim(String(run.id));
      const id = (
        await worker(
          'select emdo.generate_finance_planning_result($1,$2,$3) as id',
          [run.id, claimed.run.revision, claimed.run.lease_token],
        )
      ).rows[0].id;
      const saved = (
        await admin.query(
          'select * from emdo.finance_planning_results where id=$1',
          [id],
        )
      ).rows[0];
      const actual = FinanceForecastSnapshotSchema.parse(saved.payload);
      expect(
        actual.lines.map((l) => ({
          ...l,
          budgetAmount: parseFinanceDecimal(l.budgetAmount),
          postedActualAmount: parseFinanceDecimal(l.postedActualAmount),
          forecastAmount:
            l.forecastAmount === null
              ? null
              : parseFinanceDecimal(l.forecastAmount),
        })),
      ).toEqual(
        expected.lines.map((l) => ({
          ...l,
          budgetAmount: parseFinanceDecimal(l.budgetAmount),
          postedActualAmount: parseFinanceDecimal(l.postedActualAmount),
          forecastAmount:
            l.forecastAmount === null
              ? null
              : parseFinanceDecimal(l.forecastAmount),
        })),
      );
      expect(actual.futureAssumptionsStatus).toBe('partial');
      expect(actual.labels).toEqual(expected.labels);
      expect(saved.source_lineage.review.reviewForecastId).toBe(
        expected.forecastId,
      );
    });
    it('rejects child appends to an existing saved forecast', async () => {
      const expected = await planning.saveForecast(
        context,
        bookId,
        randomUUID(),
        {
          budgetId,
          budgetRevision: 1,
          asOf: '2026-06-30',
          openingBalance: {
            status: 'unavailable',
            label: 'opening-balance-unavailable',
          },
          assumptions: [],
        },
      );
      const line = expected.lines[0]!;
      await expect(
        withDurableTransaction(
          appPool,
          { ...context, householdId: context.workspaceId },
          { householdId: context.workspaceId },
          async (c) =>
            c.query(
              `insert into emdo.finance_forecast_lines
                (workspace_id,book_id,forecast_id,revision,period_id,account_id,currency,
                 budget_amount,posted_actual_amount,forecast_amount,basis,actual_sign_basis,label)
               values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
              [
                context.workspaceId,
                bookId,
                expected.forecastId,
                expected.revision,
                line.periodId,
                line.accountId,
                line.currency,
                line.budgetAmount,
                line.postedActualAmount,
                line.forecastAmount,
                line.basis,
                line.actualSignBasis,
                line.label,
              ],
            ),
        ),
      ).rejects.toThrow('finance-planning-history-append-forbidden');
    });
    it('rejects a restricted app saved forecast header without complete lines', async () => {
      const forecastId = randomUUID();
      await expect(
        withDurableTransaction(
          appPool,
          { ...context, householdId: context.workspaceId },
          { householdId: context.workspaceId },
          async (c) =>
            c.query(
              `insert into emdo.finance_forecast_snapshots
                (workspace_id,book_id,forecast_id,revision,budget_id,budget_revision,
                 functional_currency,as_of,opening_status,opening_amount,opening_currency,
                 opening_source_reference,opening_reviewed_by,opening_reviewed_at,
                 future_assumption_status,labels,created_by,created_at)
               values($1,$2,$3,1,$4,1,'CAD',$5,'unavailable',null,null,null,null,null,
                      'unavailable','["opening-balance-unavailable"]'::jsonb,$6,clock_timestamp())`,
              [
                context.workspaceId,
                bookId,
                forecastId,
                budgetId,
                '2026-06-30',
                context.userId,
              ],
            ),
        ),
      ).rejects.toThrow('finance-forecast-snapshot-incomplete');
      expect(
        (
          await admin.query(
            'select count(*)::int as n from emdo.finance_forecast_snapshots where workspace_id=$1 and book_id=$2 and forecast_id=$3',
            [context.workspaceId, bookId, forecastId],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it('fails closed when a legacy header-only forecast is selected as review evidence', async () => {
      const forecastId = randomUUID();
      const runId = randomUUID();
      const fixture = await admin.connect();
      try {
        await fixture.query('begin');
        await fixture.query(
          `select set_config('emdo.user_id',$1,true),
                  set_config('emdo.session_id',$2,true),
                  set_config('emdo.request_id',$3,true)`,
          [context.userId, context.sessionId, randomUUID()],
        );
        // Simulate a row written before the deferred completeness constraint
        // existed. Only the constraint trigger is disabled for this fixture.
        await fixture.query(
          'alter table emdo.finance_forecast_snapshots disable trigger finance_forecast_snapshot_complete',
        );
        await fixture.query(
          `insert into emdo.finance_forecast_snapshots
            (workspace_id,book_id,forecast_id,revision,budget_id,budget_revision,
             functional_currency,as_of,opening_status,opening_amount,opening_currency,
             opening_source_reference,opening_reviewed_by,opening_reviewed_at,
             future_assumption_status,labels,created_by,created_at)
           values($1,$2,$3,1,$4,1,'CAD',$5,'unavailable',null,null,null,null,null,
                  'unavailable','["opening-balance-unavailable"]'::jsonb,$6,clock_timestamp())`,
          [
            context.workspaceId,
            bookId,
            forecastId,
            budgetId,
            '2026-07-31',
            context.userId,
          ],
        );
        await fixture.query(
          'alter table emdo.finance_forecast_snapshots enable trigger finance_forecast_snapshot_complete',
        );
        await fixture.query('commit');
      } catch (error) {
        await fixture.query('rollback');
        throw error;
      } finally {
        fixture.release();
      }
      await expect(
        enqueue(
          {
            ...baseIntent(),
            capability: 'finance.planning.forecast',
            asOf: '2026-07-31',
            openingBalance: {
              status: 'unavailable',
              label: 'opening-balance-unavailable',
            },
            assumptions: [],
          },
          runId,
        ),
      ).rejects.toThrow('planning-reviewed-input-unavailable');
      expect(
        (
          await admin.query(
            'select count(*)::int as n from emdo.finance_automation_runs where id=$1',
            [runId],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it('binds a reviewed opening balance and uses actuals for a completed period', async () => {
      const openingBalance = {
        status: 'available',
        currency: 'CAD',
        amount: '100.25',
        sourceReference: 'verified-opening',
        reviewedBy: context.userId,
        reviewedAt: new Date().toISOString(),
      };
      const input = {
        ...baseIntent(),
        capability: 'finance.planning.forecast',
        asOf: '2026-12-31',
        openingBalance,
        assumptions: [],
      };
      await planning.saveForecast(context, bookId, randomUUID(), {
        budgetId,
        budgetRevision: 1,
        asOf: input.asOf,
        openingBalance,
        assumptions: [],
      });
      await expect(
        enqueue({
          ...input,
          openingBalance: { ...openingBalance, amount: '101.25' },
        }),
      ).rejects.toThrow('planning-reviewed-input-unavailable');
      const run = await enqueue(input);
      const claimed = await claim(String(run.id));
      const id = (
        await worker(
          'select emdo.generate_finance_planning_result($1,$2,$3) as id',
          [run.id, claimed.run.revision, claimed.run.lease_token],
        )
      ).rows[0].id;
      const actual = FinanceForecastSnapshotSchema.parse(
        (
          await admin.query(
            'select payload from emdo.finance_planning_results where id=$1',
            [id],
          )
        ).rows[0].payload,
      );
      expect(actual.openingBalance).toEqual(openingBalance);
      expect(actual.futureAssumptionsStatus).toBe('not-applicable');
      expect(actual.labels).toEqual([]);
      expect(actual.lines.find((l) => l.accountId === cash)).toMatchObject({
        forecastAmount: '12.5',
        basis: 'posted-actual',
      });
    });
    it('rejects wrong lease and leaves no partial outcome', async () => {
      const run = await enqueue(baseIntent());
      const claimed = await claim(String(run.id));
      await expect(
        worker('select emdo.generate_finance_planning_result($1,$2,$3)', [
          run.id,
          claimed.run.revision,
          randomUUID(),
        ]),
      ).rejects.toThrow('planning-lease-conflict');
      expect(
        (
          await admin.query(
            'select count(*)::int as n from emdo.finance_planning_results where automation_run_id=$1',
            [run.id],
          )
        ).rows[0].n,
      ).toBe(0);
      await expect(
        worker('select * from emdo.finance_planning_results', []),
      ).rejects.toThrow('permission denied');
    });
    it('waits for an uncommitted accounting writer before reading its posted snapshot', async () => {
      let releaseCommit!: () => void, markStaged!: () => void;
      const commitGate = new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });
      const staged = new Promise<void>((resolve) => {
        markStaged = resolve;
      });
      const writer = new PostgresFinanceV2Repository({
        async connect() {
          const client = await app.connect();
          await client.query('set role emdo_app');
          return {
            release: () => client.release(),
            query: async (query: string, values?: readonly unknown[]) => {
              if (query.toLowerCase() === 'commit') {
                markStaged();
                await commitGate;
              }
              return client.query(query, values ? [...values] : undefined);
            },
          };
        },
      });
      const run = await enqueue(baseIntent());
      const claimed = await claim(String(run.id));
      const posting = writer.postJournal(context, bookId, randomUUID(), {
        ...journal(),
        sourceReference: randomUUID(),
      });
      let reading: ReturnType<typeof worker> | undefined;
      try {
        await Promise.race([
          staged,
          posting.then(() => {
            throw new Error('writer did not pause before commit');
          }),
        ]);
        reading = worker(
          'select emdo.generate_finance_planning_result($1,$2,$3) as id',
          [run.id, claimed.run.revision, claimed.run.lease_token],
        );
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
          const activity = await admin.query(
            "select count(*)::int as count from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and lower(wait_event)='advisory'",
            [login],
          );
          waiting = activity.rows[0]?.count > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        releaseCommit();
        await posting;
        const result = await reading;
        const snapshot = FinanceBudgetVsActualsSchema.parse(
          (
            await admin.query(
              'select payload from emdo.finance_planning_results where id=$1',
              [result.rows[0].id],
            )
          ).rows[0].payload,
        );
        expect(
          snapshot.rows.find((row) => row.accountId === cash),
        ).toMatchObject({
          postedActualAmount: '25',
          sourceJournalCount: 2,
          sourceLineCount: 2,
        });
      } finally {
        releaseCommit();
        await posting;
        if (reading) await reading;
      }
    });

    it('materializes a scheduled planning run with authoritative usage and EMDO lineage', async () => {
      const management = new PostgresFinanceScheduleRepository(appPool);
      const scheduler = new PostgresFinanceScheduleDueRepository({
        async connect() {
          const c = await workerPool.connect();
          await c.query('set role emdo_finance_scheduler');
          return c;
        },
      });
      const scheduleId = randomUUID();
      await management.createSchedule(context, bookId, scheduleId, {
        workspaceId: context.workspaceId,
        bookId,
        grantId,
        grantRevision: 1,
        capability: 'finance.planning.budget-vs-actuals',
        targets: [budgetId],
        planning: baseIntent(),
        money: { currency: 'CAD', amount: '0' },
        startAt: new Date(Date.now() - 1000).toISOString(),
        endAt: null,
        cadence: {
          kind: 'interval',
          everySeconds: 60,
          timeZone: 'UTC',
          clock: 'elapsed-utc',
        },
        misfire: { policy: 'coalesce-latest', maxLatenessSeconds: 86400 },
        concurrency: { policy: 'forbid', onBusy: 'defer' },
      });
      const c = (await scheduler.claimDue(20)).find(
        (c) => c.input.schedule.id === scheduleId,
      );
      expect(c).toBeDefined();
      const plan = planFinanceAutomationDue(c!.input);
      const result = await scheduler.commit(c, plan);
      expect(result.status).toBe('due');
      expect(await scheduler.commit(c, plan)).toMatchObject({
        status: 'duplicate',
        operationId: result.operationId,
      });
      const row = (
        await admin.query(
          'select r.item_count,r.intent,p.lineage from emdo.finance_automation_runs r join emdo.finance_schedule_plans p on p.operation_id=r.id where r.id=$1',
          [result.operationId],
        )
      ).rows[0];
      expect(row.item_count).toBe(3);
      expect(row.intent.planning).toEqual(baseIntent());
      expect(row.lineage.controller).toBe('emdo');
      const run = await claim(String(result.operationId));
      const outcome = (
        await worker(
          'select emdo.generate_finance_planning_result($1,$2,$3) as id',
          [result.operationId, run.run.revision, run.run.lease_token],
        )
      ).rows[0].id;
      expect(outcome).toMatch(/^[a-f0-9-]{36}$/);
    });
    it('checks lease expiry again after waiting for the book lock', async () => {
      const run = await enqueue(baseIntent());
      const claimed = await claim(String(run.id));
      await admin.query(
        "update emdo.finance_automation_runs set lease_expires_at=clock_timestamp()+interval '500 milliseconds' where id=$1",
        [run.id],
      );
      const blocker = await admin.connect();
      await blocker.query('begin');
      await blocker.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${context.workspaceId}:${bookId}`],
      );
      const executing = worker(
        'select emdo.generate_finance_planning_result($1,$2,$3)',
        [run.id, claimed.run.revision, claimed.run.lease_token],
      );
      // Attach the rejection handler before releasing a potentially expired run.
      const rejected = expect(executing).rejects.toThrow(
        'planning-lease-expired',
      );
      try {
        let waiting = false;
        for (let i = 0; i < 100 && !waiting; i++) {
          waiting =
            (
              await admin.query(
                "select count(*)::int as n from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and lower(wait_event)='advisory'",
                [login],
              )
            ).rows[0].n > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(waiting).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 550));
      } finally {
        await blocker.query('commit');
        blocker.release();
      }
      await rejected;
      expect(
        (
          await admin.query(
            'select count(*)::int as n from emdo.finance_planning_results where automation_run_id=$1',
            [run.id],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it('does not complete an outcome outside the exact decimal contract', async () => {
      const large = await planning.saveBudget(context, bookId, randomUUID(), {
        name: 'Decimal boundary',
        lines: [cash, capital, unused].map((accountId) => ({
          accountId,
          periodId: period,
          currency: 'CAD',
          amount: '-99999999999999999999999999.99',
        })),
      });
      const run = await enqueue({ ...baseIntent(), budgetId: large.budgetId });
      const claimed = await claim(String(run.id));
      await expect(
        worker('select emdo.generate_finance_planning_result($1,$2,$3)', [
          run.id,
          claimed.run.revision,
          claimed.run.lease_token,
        ]),
      ).rejects.toThrow('planning-result-decimal-overflow');
      expect(
        (
          await admin.query(
            'select count(*)::int as n from emdo.finance_planning_results where automation_run_id=$1',
            [run.id],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it('executes through the production dispatcher with the fixed executor role', async () => {
      const dispatch = await createProductionFinanceAutomationDispatcher({
        scopedPool: {
          async connect() {
            const c = await workerPool.connect();
            await c.query('set role emdo_worker_executor');
            return c;
          },
        },
        async checkReady() {},
        async close() {},
      });
      const run = await enqueue(baseIntent());
      const outcome = await dispatch(
        String(run.id),
        1,
        new AbortController().signal,
      );
      expect(outcome.status).toBe('completed');
      if (outcome.status !== 'completed')
        throw new Error('completed planning outcome required');
      expect(
        await planning.getAutomationResult(
          context,
          bookId,
          outcome.outcomeReference,
        ),
      ).toMatchObject({ automationRunId: run.id });
      expect(
        await dispatch(String(run.id), 1, new AbortController().signal),
      ).toEqual({
        status: 'duplicate',
        outcomeReference: outcome.outcomeReference,
      });
      expect(
        (
          await admin.query(
            'select count(*)::int as n from emdo.finance_planning_results where automation_run_id=$1',
            [run.id],
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it('rereads revoked authority after claim', async () => {
      const run = await enqueue(baseIntent());
      const claimed = await claim(String(run.id));
      await admin.query(
        'update emdo.finance_book_grants set revoked_at=now() where workspace_id=$1 and book_id=$2 and user_id=$3',
        [context.workspaceId, bookId, context.userId],
      );
      await expect(
        worker('select emdo.generate_finance_planning_result($1,$2,$3)', [
          run.id,
          claimed.run.revision,
          claimed.run.lease_token,
        ]),
      ).rejects.toThrow('planning-authority-revoked');
      await expect(
        planning.getAutomationResult(context, bookId, savedOutcomeId),
      ).rejects.toThrow('finance-planning-book-forbidden');
      expect(
        (
          await admin.query(
            'select count(*)::int as n from emdo.finance_planning_results where automation_run_id=$1',
            [run.id],
          )
        ).rows[0].n,
      ).toBe(0);
    });
  },
);

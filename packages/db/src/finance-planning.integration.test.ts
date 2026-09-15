import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PostgresFinancePlanningRepository } from './finance-planning-repository.js';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';

const databaseUrl = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'normalized planning restricted PostgreSQL',
  () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const login = `planning_${randomUUID().replaceAll('-', '')}`;
    let app: pg.Pool;
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
      await admin.query(`grant emdo_app to "${login}"`);
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
      await admin.query(`drop role if exists "${login}"`);
      await admin.end();
    });
    it('saves an exact immutable budget revision with same-key replay', async () => {
      expect(await planning.checkReady()).toBe(true);
      const key = randomUUID(),
        input = {
          name: 'Plan',
          lines: [cash, capital, unused].map((accountId) => ({
            accountId,
            periodId: period,
            currency: 'CAD',
            amount: '9007199254740993.01',
          })),
        };
      const saved = await planning.saveBudget(context, bookId, key, input);
      budgetId = saved.budgetId;
      expect(await planning.saveBudget(context, bookId, key, input)).toEqual(
        saved,
      );
      expect(saved.lines[0]?.amount).toBe('9007199254740993.010000000000');
    });
    it('counts only journals contributing to each account and preserves sign basis', async () => {
      await finance.postJournal(context, bookId, randomUUID(), journal());
      const actuals = await planning.budgetVsActuals(
        context,
        bookId,
        budgetId,
        1,
      );
      expect(
        actuals.rows.find((row) => row.accountId === unused),
      ).toMatchObject({
        postedActualAmount: '0',
        sourceJournalCount: 0,
        sourceLineCount: 0,
      });
      expect(actuals.rows.find((row) => row.accountId === cash)).toMatchObject({
        postedActualAmount: '12.5',
        sourceJournalCount: 1,
        actualSignBasis: 'debit-minus-credit',
      });
      expect(
        actuals.rows.find((row) => row.accountId === capital),
      ).toMatchObject({
        postedActualAmount: '12.5',
        sourceJournalCount: 1,
        actualSignBasis: 'credit-minus-debit',
      });
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
      const posting = writer.postJournal(context, bookId, randomUUID(), {
        ...journal(),
        sourceReference: randomUUID(),
      });
      let reading: ReturnType<typeof planning.budgetVsActuals> | undefined;
      try {
        await Promise.race([
          staged,
          posting.then(() => {
            throw new Error('writer did not pause before commit');
          }),
        ]);
        reading = planning.budgetVsActuals(context, bookId, budgetId, 1);
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
        const snapshot = await reading;
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

    it('preserves missing forecast inputs and replays the saved snapshot after later posts', async () => {
      const key = randomUUID(),
        input = {
          budgetId,
          budgetRevision: 1,
          asOf: '2026-03-08',
          openingBalance: {
            status: 'unavailable',
            label: 'opening-balance-unavailable',
          },
          assumptions: [],
        };
      const saved = await planning.saveForecast(context, bookId, key, input);
      expect(saved.openingBalance.status).toBe('unavailable');
      expect(saved.labels).toContain('opening-balance-unavailable');
      await finance.postJournal(context, bookId, randomUUID(), {
        ...journal(),
        sourceReference: randomUUID(),
      });
      expect(await planning.saveForecast(context, bookId, key, input)).toEqual(
        saved,
      );
      expect(
        await planning.getForecast(
          context,
          bookId,
          saved.forecastId,
          saved.revision,
        ),
      ).toEqual(saved);
    });
    it('denies saved results after grant revocation', async () => {
      await admin.query(
        'update emdo.finance_book_grants set revoked_at=now(),revision=revision+1 where workspace_id=$1 and book_id=$2 and user_id=$3',
        [context.workspaceId, bookId, context.userId],
      );
      await expect(
        planning.getBudget(context, bookId, budgetId, 1),
      ).rejects.toThrow();
    });
  },
);

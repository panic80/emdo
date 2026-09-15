import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { PostgresFinanceAutomationRepository } from '../../../packages/db/src/finance-automation-repository.js';
import { PostgresFinanceScheduleRepository } from '../../../packages/db/src/finance-schedule-repository.js';
import { PostgresFinanceV2Repository } from '../../../packages/db/src/finance-v2-repository.js';

const run = (args: string[], input?: string) =>
  spawnSync('docker', args, {
    input,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
it.skipIf(process.env.EMDO_FINANCE_AUTOMATION_WORKER_DRILL !== '1')(
  'runs emitted scheduler through real pg-boss to saved trial balance and blocks revoked follow-up',
  async () => {
    const name = `emdo-automation-worker-${randomUUID()}`;
    let pool: pg.Pool | undefined;
    let worker: ChildProcess | undefined;
    let appPool: pg.Pool | undefined;
    try {
      expect(
        run([
          'run',
          '--detach',
          '--rm',
          '--name',
          name,
          '--publish',
          '127.0.0.1::5432',
          '--env',
          'POSTGRES_HOST_AUTH_METHOD=trust',
          'pgvector/pgvector@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a',
        ]).status,
      ).toBe(0);
      for (let i = 0; i < 40; i++) {
        if (run(['exec', name, 'pg_isready', '-U', 'postgres']).status === 0)
          break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const port = run(['port', name, '5432/tcp'])
        .stdout.trim()
        .split(':')
        .at(-1)!;
      pool = new pg.Pool({
        connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`,
      });
      const journal = JSON.parse(
        await readFile(
          new URL(
            '../../../packages/db/drizzle/meta/_journal.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as { entries: { tag: string }[] };
      for (const { tag } of journal.entries) {
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query(
            await readFile(
              new URL(
                `../../../packages/db/drizzle/${tag}.sql`,
                import.meta.url,
              ),
              'utf8',
            ),
          );
          await client.query('commit');
        } catch (error) {
          await client.query('rollback');
          throw error;
        } finally {
          client.release();
        }
      }
      const workspaceId = randomUUID(),
        userId = randomUUID(),
        sessionId = randomUUID();
      await pool.query(
        "insert into emdo.auth_users(id,name,email,email_verified) values($1,'Synthetic owner','synthetic-owner@emdo.invalid',true)",
        [userId],
      );
      await pool.query(
        "insert into emdo.households(id,name,created_by_user_id,slug) values($1,'Synthetic household',$2,'synthetic-household')",
        [workspaceId, userId],
      );
      await pool.query(
        "insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,'owner')",
        [workspaceId, userId],
      );
      await pool.query(
        "insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1::uuid,$2,$1::text,now()+interval '1 day',$3)",
        [sessionId, userId, workspaceId],
      );
      appPool = new pg.Pool({
        connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`,
        options: '-c role=emdo_app',
      });
      expect(
        (await appPool.query('select current_user')).rows[0].current_user,
      ).toBe('emdo_app');
      const repository = new PostgresFinanceV2Repository(appPool);
      const context = {
        workspaceId,
        userId,
        sessionId,
        requestId: randomUUID(),
      };
      const book = (await repository.createBook(
        context,
        'synthetic-normalized-book-v1',
        {
          name: 'Synthetic normalized staging',
          entityName: 'Synthetic staging household',
          entityKind: 'individual',
          country: 'CA',
          functionalCurrency: 'CAD',
          fiscalYearStartMonth: 1,
        },
      )) as { id: string };
      const cash = (await repository.createAccount(context, book.id, 'cash', {
        code: '1000',
        name: 'Cash',
        kind: 'asset',
      })) as { id: string };
      const equity = (await repository.createAccount(
        context,
        book.id,
        'equity',
        { code: '3000', name: 'Equity', kind: 'equity' },
      )) as { id: string };
      await repository.createPeriod(context, book.id, 'period', {
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
      });
      await repository.postJournal(context, book.id, 'opening', {
        effectiveOn: '2026-09-15',
        sourceReference: 'synthetic-worker-drill',
        description: 'Synthetic opening',
        lines: [
          {
            accountId: cash.id,
            side: 'debit',
            amount: '12.34',
            currency: 'CAD',
            nativeAmount: '12.34',
            fxRate: '1',
            fxSource: 'synthetic',
            description: '',
          },
          {
            accountId: equity.id,
            side: 'credit',
            amount: '12.34',
            currency: 'CAD',
            nativeAmount: '12.34',
            fxRate: '1',
            fxSource: 'synthetic',
            description: '',
          },
        ],
      });
      const grantRepository = new PostgresFinanceAutomationRepository(appPool);
      const schedules = new PostgresFinanceScheduleRepository(
        appPool,
        process.versions.tz!,
      );
      await pool.query(
        "insert into emdo.workspace_entitlements(workspace_id,capability,enabled) values($1,'finance.automations.run',true)",
        [workspaceId],
      );
      await pool.query(
        "update emdo.finance_automation_capabilities set ready=true where capability='finance.reports.generate'",
      );
      const grant = await grantRepository.createGrant(context, book.id, {
        capabilities: ['finance.reports.generate'],
        limits: {
          maxRuns: 3,
          maxAttemptsPerRun: 2,
          maxItemsPerRun: 1,
          maxTotalItems: 3,
          currency: 'CAD',
          maxAmountPerRun: '0',
          maxTotalAmount: '0',
        },
        validFrom: new Date(Date.now() - 86400000).toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      });
      const scheduleId = randomUUID();
      const definition = {
        workspaceId,
        bookId: book.id,
        grantId: grant.id,
        grantRevision: grant.revision,
        capability: 'finance.reports.generate',
        targets: [book.id],
        money: { currency: 'CAD', amount: '0' },
        startAt: new Date(Date.now() - 120000).toISOString(),
        endAt: null,
        cadence: {
          kind: 'interval',
          everySeconds: 60,
          timeZone: 'UTC',
          clock: 'elapsed-utc',
        },
        misfire: { policy: 'coalesce-latest', maxLatenessSeconds: 86400 },
        concurrency: { policy: 'forbid', onBusy: 'defer' },
      };
      await schedules.createSchedule(context, book.id, scheduleId, definition);
      for (const [login, role] of [
        ['emdo_worker_login', null],
        ['emdo_worker_executor_login', 'emdo_worker_executor'],
        ['emdo_worker_dispatcher_login', 'emdo_worker_dispatch_executor'],
        ['emdo_finance_scheduler_login', 'emdo_finance_scheduler'],
      ] as const) {
        await pool.query(
          `create role ${login} login nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication`,
        );
        if (role)
          await pool.query(
            `grant ${role} to ${login} with inherit false, set true`,
          );
      }
      const boss = new PgBoss({
        connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`,
        schema: 'pgboss',
      });
      await boss.start();
      await boss.stop();
      await pool.query(
        'grant usage on schema pgboss to emdo_worker_login; grant all on all tables in schema pgboss to emdo_worker_login; grant all on all sequences in schema pgboss to emdo_worker_login; grant execute on all functions in schema pgboss to emdo_worker_login',
      );
      const healthPort = await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          const port =
            typeof address === 'object' && address ? address.port : 0;
          server.close(() => resolve(port));
        });
      });
      const root = fileURLToPath(new URL('../../../', import.meta.url));
      const built = spawnSync(process.execPath, ['build.mjs'], {
        cwd: `${root}/apps/worker`,
        encoding: 'utf8',
        timeout: 60000,
      });
      expect(built.status, built.stderr).toBe(0);
      const db = (login: string) =>
        `postgresql://${login}:synthetic-local@127.0.0.1:${port}/postgres`;
      await pool.query(
        "update emdo.auth_sessions set expires_at=now()-interval '1 second' where id=$1",
        [sessionId],
      );
      let diagnostic = '';
      worker = spawn(process.execPath, [`${root}/apps/worker/dist/index.js`], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          EMDO_ENVIRONMENT: 'staging',
          EMDO_SYNTHETIC_DATA_ONLY: 'true',
          EMDO_EXTERNAL_PROVIDERS_ENABLED: 'false',
          EMDO_APPLICATION_ORIGIN: 'https://synthetic.emdo.invalid',
          EMDO_WORKER_DATABASE_URL: db('emdo_worker_login'),
          EMDO_WORKER_EXECUTOR_DATABASE_URL: db('emdo_worker_executor_login'),
          EMDO_WORKER_DISPATCHER_DATABASE_URL: db(
            'emdo_worker_dispatcher_login',
          ),
          EMDO_FINANCE_SCHEDULER_DATABASE_URL: db(
            'emdo_finance_scheduler_login',
          ),
          EMDO_WORKER_DISPATCHER_ID: 'synthetic-worker-drill',
          EMDO_FINANCE_V2_ENABLED: 'true',
          EMDO_FINANCE_SCHEDULES_ENABLED: 'true',
          EMDO_FINANCE_STANDARDIZATION_ENABLED: 'false',
          HEALTH_HOST: '127.0.0.1',
          HEALTH_PORT: String(healthPort),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      worker.stdout!.on('data', (chunk) => {
        diagnostic = (diagnostic + String(chunk)).slice(-8000);
      });
      worker.stderr!.on('data', (chunk) => {
        diagnostic = (diagnostic + String(chunk)).slice(-8000);
      });
      const waitFor = async (check: () => Promise<boolean>, label: string) => {
        for (let i = 0; i < 120; i++) {
          if (await check()) return;
          if (worker!.exitCode !== null)
            throw new Error(`${label}: emitted worker exited: ${diagnostic}`);
          await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error(`${label}: timeout: ${diagnostic}`);
      };
      await waitFor(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${healthPort}/readyz`)).ok;
        } catch {
          return false;
        }
      }, 'ready');
      await waitFor(
        async () =>
          Number(
            (
              await pool!.query(
                'select count(*) from emdo.finance_generated_reports where book_id=$1',
                [book.id],
              )
            ).rows[0].count,
          ) === 1,
        'saved-report',
      );
      const report = (
        await pool.query(
          'select * from emdo.finance_generated_reports where book_id=$1',
          [book.id],
        )
      ).rows[0];
      expect(report.snapshot).toMatchObject({
        totalDebit: '12.34',
        totalCredit: '12.34',
        rows: [
          { accountId: cash.id, debit: '12.34', credit: '0', balance: '12.34' },
          {
            accountId: equity.id,
            debit: '0',
            credit: '12.34',
            balance: '-12.34',
          },
        ],
      });
      const runs = (
        await pool.query(
          'select id,status,outcome_reference from emdo.finance_automation_runs where book_id=$1',
          [book.id],
        )
      ).rows;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        status: 'completed',
        outcome_reference: report.id,
      });
      expect(
        Number(
          (
            await pool.query(
              "select count(*) from pgboss.job where name='emdo.finance.automation.v1'",
            )
          ).rows[0].count,
        ),
      ).toBe(1);
      const queued = (
        await pool.query(
          "select id,data from pgboss.job where name='emdo.finance.automation.v1'",
        )
      ).rows[0];
      const replayBoss = new PgBoss({
        connectionString: db('emdo_worker_login'),
        schema: 'pgboss',
        migrate: false,
        createSchema: false,
      });
      await replayBoss.start();
      try {
        expect(
          await replayBoss.send('emdo.finance.automation.v1', queued.data, {
            id: queued.id,
            singletonKey: queued.id,
            singletonSeconds: 2592000,
            retryLimit: 0,
            expireInSeconds: 120,
          }),
        ).toBeNull();
      } finally {
        await replayBoss.stop();
      }
      const freshSessionId = randomUUID();
      await pool.query(
        "insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1::uuid,$2,$1::text,now()+interval '1 day',$3)",
        [freshSessionId, userId, workspaceId],
      );
      await grantRepository.revokeGrant(
        { ...context, sessionId: freshSessionId },
        book.id,
        grant.id,
      );
      // Force only the disposable controller wake-up timestamp, not its pinned occurrence intent.
      await pool.query(
        'update emdo.finance_schedules set next_due_at=now(),next_poll_at=now() where id=$1',
        [scheduleId],
      );
      await waitFor(
        async () =>
          Boolean(
            (
              await pool!.query(
                'select blocked_reason from emdo.finance_schedules where id=$1',
                [scheduleId],
              )
            ).rows[0].blocked_reason,
          ),
        'revoked-schedule',
      );
      expect(
        (
          await pool.query(
            'select blocked_reason from emdo.finance_schedules where id=$1',
            [scheduleId],
          )
        ).rows[0].blocked_reason,
      ).toBe('grant-revoked');
      expect(
        Number(
          (
            await pool.query(
              'select count(*) from emdo.finance_generated_reports where book_id=$1',
              [book.id],
            )
          ).rows[0].count,
        ),
      ).toBe(1);
      expect(
        Number(
          (
            await pool.query(
              'select count(*) from emdo.finance_automation_runs where book_id=$1',
              [book.id],
            )
          ).rows[0].count,
        ),
      ).toBe(1);
      expect(
        (
          await pool.query(
            'select snapshot from emdo.finance_generated_reports where id=$1',
            [report.id],
          )
        ).rows[0].snapshot,
      ).toEqual(report.snapshot);
      console.info(
        `emitted automation worker drill: ${journal.entries.length} migrations, real scheduler/pg-boss/executor, one saved report, revoked follow-up denied`,
      );
    } finally {
      if (worker && worker.exitCode === null) {
        worker.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          worker!.once('exit', () => resolve());
          setTimeout(() => {
            worker!.kill('SIGKILL');
            resolve();
          }, 5000).unref();
        });
      }
      await appPool?.end();
      await pool?.end();
      run(['rm', '--force', name]);
    }
  },
  120000,
);

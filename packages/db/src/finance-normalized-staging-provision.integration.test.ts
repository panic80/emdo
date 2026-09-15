import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import pg from 'pg';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';

const run = (args: string[], input?: string) =>
  spawnSync('docker', args, {
    input,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
it.skipIf(process.env.EMDO_FINANCE_NORMALIZED_PROVISION_DRILL !== '1')(
  'executes the actual provisioning script after all migrations and rolls back denied synthetic boundaries',
  async () => {
    const name = `emdo-normalized-provision-${randomUUID()}`;
    let pool: pg.Pool | undefined;
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
          new URL('../drizzle/meta/_journal.json', import.meta.url),
          'utf8',
        ),
      ) as { entries: { tag: string }[] };
      for (const { tag } of journal.entries) {
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query(
            await readFile(
              new URL(`../drizzle/${tag}.sql`, import.meta.url),
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
      const repository = new PostgresFinanceV2Repository(pool);
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
      const script = await readFile(
        new URL(
          '../../../infra/scripts/finance-normalized-staging-provision.sql',
          import.meta.url,
        ),
        'utf8',
      );
      const defaults = {
        normalized_staging: 'true',
        environment: 'staging',
        synthetic_only: 'true',
        book_id: book.id,
        workspace_id: workspaceId,
        household_slug: 'synthetic-household',
        synthetic_owner_email: 'synthetic-owner@emdo.invalid',
        max_run_cad_minor: '25',
        max_day_cad_minor: '100',
      };
      const provision = (overrides: Record<string, string> = {}) =>
        run(
          [
            'exec',
            '-i',
            name,
            'psql',
            '-X',
            '-U',
            'postgres',
            '--set=ON_ERROR_STOP=1',
            ...Object.entries({ ...defaults, ...overrides }).flatMap(
              ([key, value]) => ['--set', `${key}=${value}`],
            ),
          ],
          script,
        );
      const state = async () => ({
        config: (
          await pool!.query(
            'select * from emdo.finance_standardization_configuration order by id',
          )
        ).rows,
        entitlements: (
          await pool!.query(
            "select * from emdo.workspace_entitlements where capability='finance.standardizations.run'",
          )
        ).rows,
      });
      const deniedInputs: Record<string, string>[] = [
        { workspace_id: randomUUID() },
        { synthetic_owner_email: 'other@emdo.invalid' },
        { synthetic_owner_email: 'synthetic-owner@example.com' },
        { household_slug: 'wrong-household' },
        { environment: 'production' },
        { max_run_cad_minor: '101' },
      ];
      for (const overrides of deniedInputs) {
        const before = await state();
        const denied = provision(overrides);
        expect(denied.status, denied.stderr).not.toBe(0);
        expect(await state()).toEqual(before);
      }
      const success = provision();
      expect(success.status, success.stderr).toBe(0);
      expect((await state()).config).toEqual([
        {
          id: 'v1',
          ready: true,
          max_run_cad_minor: 25,
          max_workspace_day_cad_minor: 100,
        },
      ]);
      expect((await state()).entitlements[0]).toMatchObject({
        workspace_id: workspaceId,
        capability: 'finance.standardizations.run',
        enabled: true,
      });
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
      await repository.postJournal(context, book.id, 'journal', {
        effectiveOn: '2026-09-15',
        description: 'Synthetic opening',
        sourceReference: 'synthetic-provision-drill',
        lines: [
          {
            accountId: cash.id,
            side: 'debit',
            amount: '1',
            currency: 'CAD',
            nativeAmount: '1',
            fxRate: '1',
            fxSource: 'synthetic',
            description: '',
          },
          {
            accountId: equity.id,
            side: 'credit',
            amount: '1',
            currency: 'CAD',
            nativeAmount: '1',
            fxRate: '1',
            fxSource: 'synthetic',
            description: '',
          },
        ],
      });
      const before = await state();
      const denied = provision({ max_run_cad_minor: '50' });
      expect(denied.status, denied.stderr).not.toBe(0);
      expect(await state()).toEqual(before);
      console.info(
        `normalized provisioning drill: ${journal.entries.length} migrations; success, 7 denied boundaries, rollback verified`,
      );
    } finally {
      await pool?.end();
      run(['rm', '--force', name]);
    }
  },
  120000,
);

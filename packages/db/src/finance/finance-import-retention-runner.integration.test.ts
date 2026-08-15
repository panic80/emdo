import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from '../migrations.js';

const databaseUrl = process.env.TEST_FINANCE_RETENTION_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const ids = Object.freeze({
  household: 'fb000000-0000-4000-8000-000000000001',
  owner: 'fb000000-0000-4000-8000-000000000002',
  privateSpace: 'fb000000-0000-4000-8000-000000000003',
  expiredPlan: 'fb000000-0000-4000-8000-000000000004',
  retainedPlan: 'fb000000-0000-4000-8000-000000000005',
  receipt: 'fb000000-0000-4000-8000-000000000006',
  request: 'fb000000-0000-4000-8000-000000000007',
  session: 'fb000000-0000-4000-8000-000000000008',
  grant: 'fb000000-0000-4000-8000-000000000009',
});

describeDatabase(
  'PostgreSQL 17 finance import retention runner (requires isolated canonical TEST_FINANCE_RETENTION_DATABASE_URL)',
  () => {
    let admin: import('pg').Pool;
    let runner: import('pg').Pool;
    const loginPassword = `retention_${randomUUID().replaceAll('-', '')}`;

    beforeAll(async () => {
      const url = new URL(databaseUrl!);
      expect(url.pathname).toBe('/emdo_app');

      const { Pool } = await import('pg');
      admin = new Pool({
        allowExitOnIdle: true,
        application_name: 'emdo-finance-retention-live-admin',
        connectionString: databaseUrl,
        max: 1,
      });
      const server = await admin.query<{
        is_superuser: boolean;
        server_version_num: string;
      }>(`select role.rolsuper as is_superuser,
                 pg_catalog.current_setting('server_version_num') as server_version_num
            from pg_catalog.pg_roles as role
           where role.rolname = current_user`);
      expect(server.rows[0]).toMatchObject({ is_superuser: true });
      expect(Number(server.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(
        170_000,
      );
      expect(Number(server.rows[0]?.server_version_num)).toBeLessThan(180_000);
      const existing = await admin.query<{ emdo: string | null }>(
        "select pg_catalog.to_regnamespace('emdo')::text as emdo",
      );
      if (existing.rows[0]?.emdo !== null) {
        throw new Error(
          'TEST_FINANCE_RETENTION_DATABASE_URL must point at an isolated empty emdo_app database.',
        );
      }

      const migrations = await loadOrderedMigrations();
      expect(migrations).toHaveLength(12);
      expect(migrations.at(-1)?.id).toBe(
        '0011_finance_import_retention_runner',
      );
      for (const migration of migrations) await admin.query(migration.sql);

      await expect(
        admin.query('select emdo.finance_imports_ready() as ready'),
      ).resolves.toMatchObject({ rows: [{ ready: true }] });
      await expect(
        admin.query(
          `select rolcanlogin, rolinherit, rolbypassrls
             from pg_catalog.pg_roles
            where rolname = 'emdo_finance_import_retention_login'`,
        ),
      ).resolves.toMatchObject({
        rows: [{ rolbypassrls: false, rolcanlogin: false, rolinherit: false }],
      });

      await admin.query(
        `insert into emdo.auth_users (id, name, email, email_verified)
         values ($1, 'Retention Owner', 'retention-owner@example.test', true)`,
        [ids.owner],
      );
      await admin.query(
        `insert into emdo.households (id, name, slug, created_by_user_id)
         values ($1, 'Retention Household', 'retention-household', $2)`,
        [ids.household, ids.owner],
      );
      await admin.query(
        `insert into emdo.household_memberships
           (household_id, user_id, role, status, joined_at)
         values ($1, $2, 'owner', 'active', pg_catalog.clock_timestamp())`,
        [ids.household, ids.owner],
      );
      await admin.query(
        `insert into emdo.spaces
           (id, household_id, original_owner_user_id, name, visibility)
         values ($1, $2, $3, 'Retention private', 'private')`,
        [ids.privateSpace, ids.household, ids.owner],
      );
      await admin.query(
        `insert into emdo.finance_import_plans
          (plan_id, household_id, space_id, owner_user_id, account_id,
           source_hash, plan_hash, canonical_plan, diagnostics, mapping_metadata,
           scope_fingerprint, origin_session_id, origin_request_id,
           origin_space_access_grant_id, created_at, expires_at)
         values
          ($1, $3, $4, $5, 'account::expired', repeat('a', 64), repeat('b', 64),
           '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, repeat('c', 64), $6, $7, $8,
           pg_catalog.clock_timestamp() - interval '2 hours',
           pg_catalog.clock_timestamp() - interval '100 minutes'),
          ($2, $3, $4, $5, 'account::retained', repeat('d', 64), repeat('e', 64),
           '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, repeat('f', 64), $6, $7, $8,
           pg_catalog.clock_timestamp() - interval '2 hours',
           pg_catalog.clock_timestamp() - interval '100 minutes')`,
        [
          ids.expiredPlan,
          ids.retainedPlan,
          ids.household,
          ids.privateSpace,
          ids.owner,
          ids.session,
          ids.request,
          ids.grant,
        ],
      );
      await admin.query(
        `insert into emdo.finance_import_receipts
          (receipt_id, household_id, space_id, owner_user_id, account_id,
           plan_id, plan_hash, idempotency_key, scope_fingerprint,
           origin_space_access_grant_id, transaction_count, committed_at)
         values ($1, $2, $3, $4, 'account::retained', $5, repeat('e', 64),
                 'retention-receipt-0001', repeat('f', 64), $6, 1,
                 pg_catalog.clock_timestamp() - interval '90 minutes')`,
        [
          ids.receipt,
          ids.household,
          ids.privateSpace,
          ids.owner,
          ids.retainedPlan,
          ids.grant,
        ],
      );

      await admin.query('revoke connect on database emdo_app from public');
      await admin.query(
        `alter role emdo_finance_import_retention_login login password '${loginPassword}'`,
      );
      await admin.query(
        'grant connect on database emdo_app to emdo_finance_import_retention_login',
      );

      const runnerUrl = new URL(databaseUrl!);
      runnerUrl.username = 'emdo_finance_import_retention_login';
      runnerUrl.password = loginPassword;
      runner = new Pool({
        allowExitOnIdle: true,
        application_name: 'emdo-finance-retention-live-runner',
        connectionString: runnerUrl.toString(),
        max: 1,
      });
    }, 60_000);

    afterAll(async () => {
      await runner?.end();
      if (admin !== undefined) {
        await admin
          .query(
            'alter role emdo_finance_import_retention_login nologin password null',
          )
          .catch(() => undefined);
        await admin.end();
      }
    });

    it('admits only the canonical login and a deliberate SET ROLE purge', async () => {
      await expect(
        admin.query(
          'select emdo.finance_import_retention_runner_ready() as ready',
        ),
      ).resolves.toMatchObject({ rows: [{ ready: false }] });
      await expect(
        runner.query(
          'select emdo.finance_import_retention_runner_ready() as ready',
        ),
      ).resolves.toMatchObject({ rows: [{ ready: true }] });
      await expect(
        runner.query('select * from emdo.finance_import_plans'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runner.query(
          'select emdo.purge_expired_finance_import_plans(10) as purged',
        ),
      ).rejects.toMatchObject({ code: '42501' });

      const client = await runner.connect();
      try {
        await client.query('begin');
        await client.query('set local role emdo_finance_import_retention');
        await expect(
          client.query<{
            current_role_name: string;
            session_role_name: string;
          }>(
            `select current_user as current_role_name,
                    session_user as session_role_name`,
          ),
        ).resolves.toMatchObject({
          rows: [
            {
              current_role_name: 'emdo_finance_import_retention',
              session_role_name: 'emdo_finance_import_retention_login',
            },
          ],
        });
        await expect(
          client.query<{ purged: number }>(
            'select emdo.purge_expired_finance_import_plans(10) as purged',
          ),
        ).resolves.toMatchObject({ rows: [{ purged: 1 }] });
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      await expect(
        admin.query<{ plan_id: string }>(
          `select plan_id::text from emdo.finance_import_plans
            where plan_id = any($1::uuid[]) order by plan_id`,
          [[ids.expiredPlan, ids.retainedPlan]],
        ),
      ).resolves.toMatchObject({ rows: [{ plan_id: ids.retainedPlan }] });
    });

    it('fails readiness closed under reversible membership, role, and ACL drift', async () => {
      const ready = () =>
        runner.query<{ ready: boolean }>(
          'select emdo.finance_import_retention_runner_ready() as ready',
        );

      await admin.query(
        'grant emdo_app to emdo_finance_import_retention_login with inherit false, set true, admin false',
      );
      await expect(ready()).resolves.toMatchObject({
        rows: [{ ready: false }],
      });
      await admin.query(
        'revoke emdo_app from emdo_finance_import_retention_login',
      );
      await expect(ready()).resolves.toMatchObject({
        rows: [{ ready: true }],
      });

      await admin.query(
        'alter role emdo_finance_import_retention_login bypassrls',
      );
      await expect(ready()).resolves.toMatchObject({
        rows: [{ ready: false }],
      });
      await admin.query(
        'alter role emdo_finance_import_retention_login nobypassrls',
      );

      await admin.query(
        'grant execute on function emdo.purge_expired_finance_import_plans(integer) to emdo_finance_import_retention_login',
      );
      await expect(ready()).resolves.toMatchObject({
        rows: [{ ready: false }],
      });
      await admin.query(
        'revoke execute on function emdo.purge_expired_finance_import_plans(integer) from emdo_finance_import_retention_login',
      );

      await admin.query(
        'grant select on emdo.finance_import_plans to emdo_finance_import_retention_login',
      );
      await expect(ready()).resolves.toMatchObject({
        rows: [{ ready: false }],
      });
      await admin.query(
        'revoke select on emdo.finance_import_plans from emdo_finance_import_retention_login',
      );
      await expect(ready()).resolves.toMatchObject({
        rows: [{ ready: true }],
      });

      await admin.query(
        'revoke emdo_finance_import_retention from emdo_finance_import_retention_login',
      );
      await expect(ready()).resolves.toMatchObject({
        rows: [{ ready: false }],
      });
      await admin.query(
        'grant emdo_finance_import_retention to emdo_finance_import_retention_login with inherit false, set true, admin false',
      );
      await expect(ready()).resolves.toMatchObject({
        rows: [{ ready: true }],
      });
    });
  },
);

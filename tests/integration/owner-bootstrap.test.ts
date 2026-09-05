import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signInBootstrapOwner } from '../../packages/db/deployment/bootstrap-owner-auth-probe.js';
import {
  OWNER_BOOTSTRAP_CONFIRMATION,
  runOwnerBootstrapCommand,
  type BootstrapOwnerEnvironment,
} from '../../packages/db/deployment/bootstrap-owner-command.js';
import {
  createDatabaseClient,
  type EmdoDatabaseClient,
} from '../../packages/db/src/client.js';
import { loadOrderedMigrations } from '../../packages/db/src/migrations.js';

const databaseUrl = process.env.TEST_BOOTSTRAP_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const bootstrapLogin = 'emdo_bootstrap_test_login';
const bootstrapLoginPassword = 'bootstrap-test-login-password';
const authLogin = 'emdo_auth_test_login';
const authLoginPassword = 'auth-test-login-password';

const connectionStringFor = (username: string, password: string) => {
  if (databaseUrl === undefined) {
    throw new Error('TEST_BOOTSTRAP_DATABASE_URL is required');
  }
  const url = new URL(databaseUrl);
  url.username = username;
  url.password = password;
  return url.toString();
};

describeDatabase(
  'initial owner bootstrap on a disposable PostgreSQL 18 database (requires TEST_BOOTSTRAP_DATABASE_URL)',
  () => {
    let adminDatabase: EmdoDatabaseClient;
    let admin: EmdoDatabaseClient['pool'];
    let bootstrapConnectionString: string;
    let authConnectionString: string;

    beforeAll(async () => {
      adminDatabase = createDatabaseClient({
        applicationName: 'emdo-owner-bootstrap-integration-admin',
        connectionString: databaseUrl ?? '',
        max: 1,
      });
      admin = adminDatabase.pool;

      const preflight = await admin.query<{
        emdo_roles: string;
        emdo_schema_exists: boolean;
        server_version_num: number;
      }>(`select
        pg_catalog.current_setting('server_version_num')::integer
          as server_version_num,
        pg_catalog.to_regnamespace('emdo') is not null as emdo_schema_exists,
        (
          select pg_catalog.count(*)::text
          from pg_catalog.pg_roles
          where rolname like 'emdo\\_%' escape '\\'
        ) as emdo_roles`);
      expect(preflight.rows[0]).toMatchObject({
        emdo_roles: '0',
        emdo_schema_exists: false,
      });
      expect(preflight.rows[0]?.server_version_num).toBeGreaterThanOrEqual(
        180_000,
      );
      expect(preflight.rows[0]?.server_version_num).toBeLessThan(190_000);

      const migrations = await loadOrderedMigrations();
      expect(migrations[2]?.id).toBe('0002_owner_bootstrap');
      for (const migration of migrations) {
        await admin.query(migration.sql);
      }

      await admin.query(`create role ${bootstrapLogin}
        login nosuperuser nocreatedb nocreaterole inherit nobypassrls
        noreplication password '${bootstrapLoginPassword}'`);
      await admin.query(`grant emdo_owner_bootstrap to ${bootstrapLogin}`);
      await admin.query(`create role ${authLogin}
        login nosuperuser nocreatedb nocreaterole inherit nobypassrls
        noreplication password '${authLoginPassword}'`);
      await admin.query(`grant emdo_auth to ${authLogin}`);
      bootstrapConnectionString = connectionStringFor(
        bootstrapLogin,
        bootstrapLoginPassword,
      );
      authConnectionString = connectionStringFor(authLogin, authLoginPassword);
    }, 60_000);

    afterAll(async () => {
      if (admin === undefined) return;
      for (const [membership, login] of [
        ['emdo_owner_bootstrap', bootstrapLogin],
        ['emdo_auth', authLogin],
      ] as const) {
        try {
          await admin.query(`revoke ${membership} from ${login}`);
          await admin.query(`drop role if exists ${login}`);
        } catch {
          // The disposable database preflight prevents cleanup from hiding the
          // original failure or touching a shared EMDO installation.
        }
      }
      await adminDatabase.close();
    });

    const command = async (input: {
      readonly email: string;
      readonly householdSlug: string;
      readonly password: string;
    }) => {
      const messages: string[] = [];
      const environment: BootstrapOwnerEnvironment = {
        EMDO_BOOTSTRAP_CONFIRM: OWNER_BOOTSTRAP_CONFIRMATION,
        EMDO_BOOTSTRAP_DATABASE_URL: bootstrapConnectionString,
        EMDO_BOOTSTRAP_HOUSEHOLD_NAME: 'Initial Household',
        EMDO_BOOTSTRAP_HOUSEHOLD_SLUG: input.householdSlug,
        EMDO_BOOTSTRAP_OWNER_EMAIL: input.email,
        EMDO_BOOTSTRAP_OWNER_NAME: 'Initial Owner',
        EMDO_BOOTSTRAP_OWNER_PASSWORD: input.password,
      };
      const code = await runOwnerBootstrapCommand({
        environment,
        logger: {
          error: (message) => messages.push(message),
          info: (message) => messages.push(message),
        },
      });
      return { code, messages };
    };

    it('refuses a populated identity database and leaves no singleton marker', async () => {
      const fixtureUserId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f090';
      await admin.query(
        `insert into emdo.auth_users (id, name, email, email_verified)
         values ($1::uuid, 'Existing User', 'existing@example.test', true)`,
        [fixtureUserId],
      );

      const result = await command({
        email: 'blocked-owner@example.test',
        householdSlug: 'blocked-household',
        password: 'blocked correct horse battery staple',
      });
      expect(result).toEqual({
        code: 4,
        messages: [
          'EMDO initial owner bootstrap requires an empty identity database.',
        ],
      });
      const marker = await admin.query<{ count: string }>(
        'select count(*)::text as count from emdo.deployment_bootstraps',
      );
      expect(marker.rows[0]?.count).toBe('0');

      await admin.query('delete from emdo.auth_users where id = $1::uuid', [
        fixtureUserId,
      ]);
    }, 60_000);

    it('creates one owner graph, supports Better Auth sign-in, and rejects concurrency/replay', async () => {
      const candidates = [
        {
          email: 'first-owner@example.test',
          householdSlug: 'first-household',
          password: 'first correct horse battery staple',
        },
        {
          email: 'second-owner@example.test',
          householdSlug: 'second-household',
          password: 'second correct horse battery staple',
        },
      ] as const;
      const attempts = await Promise.all(candidates.map(command));
      expect(attempts.map(({ code }) => code).sort()).toEqual([0, 2]);

      const winnerIndex = attempts.findIndex(({ code }) => code === 0);
      const winner = candidates[winnerIndex];
      expect(winner).toBeDefined();

      const graph = await admin.query<{
        account_count: string;
        audit_count: string;
        audit_payload: Record<string, unknown>;
        household_count: string;
        marker_count: string;
        membership_count: string;
        password: string;
        space_count: string;
        user_count: string;
        user_id: string;
      }>(`select
        (select count(*)::text from emdo.deployment_bootstraps
          where state = 'complete') as marker_count,
        (select count(*)::text from emdo.auth_users
          where email_verified) as user_count,
        (select count(*)::text from emdo.auth_accounts
          where provider_id = 'credential') as account_count,
        (select count(*)::text from emdo.households) as household_count,
        (select count(*)::text from emdo.household_memberships
          where role = 'owner' and status = 'active') as membership_count,
        (select count(*)::text from emdo.spaces
          where visibility = 'private') as space_count,
        (select count(*)::text from emdo.audit_events
          where event_type = 'identity.owner-bootstrapped') as audit_count,
        (select password from emdo.auth_accounts
          where provider_id = 'credential') as password,
        (select id::text from emdo.auth_users) as user_id,
        (select payload from emdo.audit_events
          where event_type = 'identity.owner-bootstrapped') as audit_payload`);
      expect(graph.rows[0]).toMatchObject({
        account_count: '1',
        audit_count: '1',
        household_count: '1',
        marker_count: '1',
        membership_count: '1',
        space_count: '1',
        user_count: '1',
      });
      expect(graph.rows[0]?.password).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/);
      expect(graph.rows[0]?.audit_payload).toEqual({
        bootstrapKey: 'initial-owner-v1',
        commandVersion: 1,
      });
      expect(JSON.stringify(graph.rows[0]?.audit_payload)).not.toContain(
        winner?.email,
      );

      const signedIn = await signInBootstrapOwner({
        connectionString: authConnectionString,
        email: winner?.email ?? '',
        password: winner?.password ?? '',
      });
      expect(signedIn).toMatchObject({
        redirect: false,
        token: expect.any(String),
        user: {
          email: winner?.email,
          emailVerified: true,
          id: graph.rows[0]?.user_id,
          name: 'Initial Owner',
        },
      });

      await expect(command(winner ?? candidates[0])).resolves.toEqual({
        code: 2,
        messages: ['EMDO initial owner bootstrap is already complete.'],
      });
    }, 60_000);

    it('gives the bootstrap login no table access and runtime roles no execute access', async () => {
      const caller = createDatabaseClient({
        applicationName: 'emdo-owner-bootstrap-integration-caller',
        connectionString: bootstrapConnectionString,
        max: 1,
      });
      try {
        await expect(
          caller.pool.query('select * from emdo.auth_users'),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await caller.close();
      }

      const runtime = await admin.connect();
      try {
        await runtime.query('begin');
        await runtime.query('set local role emdo_app');
        await expect(
          runtime.query(
            `select * from emdo.bootstrap_initial_owner(
               'blocked@example.test', 'Blocked', $1,
               'Blocked Household', 'blocked-household'
             )`,
            [`${'a'.repeat(32)}:${'b'.repeat(128)}`],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await runtime.query('rollback');
      } finally {
        runtime.release();
      }
    });
  },
);

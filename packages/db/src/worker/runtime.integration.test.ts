import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from '../migrations.js';
import {
  createDatabaseClient,
  type EmdoWorkerDatabaseClient,
} from './runtime.js';

const databaseUrl = process.env.TEST_WORKER_ROLE_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const executorLogin = 'emdo_worker_executor_login';
const dispatcherLogin = 'emdo_worker_dispatcher_login';
const extraRole = 'emdo_worker_integration_extra';

describeDatabase(
  'worker fixed PostgreSQL roles (requires isolated TEST_WORKER_ROLE_DATABASE_URL)',
  () => {
    let admin: import('pg').Client;
    const clients: EmdoWorkerDatabaseClient[] = [];

    const urlFor = (login: string) => {
      const url = new URL(databaseUrl!);
      url.username = login;
      url.password = '';
      return url.toString();
    };
    const clientFor = (
      login: string,
      fixedRole: 'emdo_worker_executor' | 'emdo_worker_dispatch_executor',
    ) => {
      const client = createDatabaseClient({
        connectionString: urlFor(login),
        applicationName: `emdo-worker-role-${fixedRole}`,
        fixedRole,
      });
      clients.push(client);
      return client;
    };

    beforeAll(async () => {
      const { Client } = await import('pg');
      admin = new Client({ connectionString: databaseUrl });
      await admin.connect();
      const existingSchema = await admin.query(
        `select 1 from pg_catalog.pg_namespace where nspname = 'emdo'`,
      );
      if (existingSchema.rowCount !== 0) {
        throw new Error(
          'TEST_WORKER_ROLE_DATABASE_URL must point at an isolated empty database',
        );
      }
      for (const migration of await loadOrderedMigrations()) {
        await admin.query(migration.sql);
      }
      await admin.query(
        `create role ${executorLogin} login nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication`,
      );
      await admin.query(
        `create role ${dispatcherLogin} login nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication`,
      );
      await admin.query(
        `create role ${extraRole} nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication`,
      );
      await admin.query(
        `grant emdo_worker_executor to ${executorLogin} with inherit false, set true`,
      );
      await admin.query(
        `grant emdo_worker_dispatch_executor to ${dispatcherLogin} with inherit false, set true`,
      );
    }, 30_000);

    afterAll(async () => {
      await Promise.all(clients.map(async (client) => client.close()));
      if (admin !== undefined) {
        await admin.query(
          `revoke emdo_worker_executor from ${executorLogin};
           revoke emdo_worker_dispatch_executor from ${dispatcherLogin};
           drop role if exists ${executorLogin};
           drop role if exists ${dispatcherLogin};
           drop role if exists ${extraRole};`,
        );
        await admin.end();
      }
    });

    it('activates only the exact fixed role and destroys the session on release', async () => {
      const database = clientFor(executorLogin, 'emdo_worker_executor');
      const first = await database.scopedPool.connect();
      const firstIdentity = await first.query(
        `select session_user::text as session_user_name,
                current_user::text as current_user_name,
                pg_catalog.pg_backend_pid() as backend_pid`,
      );
      first.release();
      const second = await database.scopedPool.connect();
      const secondIdentity = await second.query(
        `select session_user::text as session_user_name,
                current_user::text as current_user_name,
                pg_catalog.pg_backend_pid() as backend_pid`,
      );
      second.release();

      expect(firstIdentity.rows[0]).toMatchObject({
        session_user_name: executorLogin,
        current_user_name: 'emdo_worker_executor',
      });
      expect(secondIdentity.rows[0]).toMatchObject({
        session_user_name: executorLogin,
        current_user_name: 'emdo_worker_executor',
      });
      expect(secondIdentity.rows[0]?.backend_pid).not.toBe(
        firstIdentity.rows[0]?.backend_pid,
      );
    });

    it('rejects an unsafe login and every extra direct or transitive role path', async () => {
      await admin.query(`alter role ${executorLogin} bypassrls`);
      await expect(
        clientFor(executorLogin, 'emdo_worker_executor').scopedPool.connect(),
      ).rejects.toThrow('Worker database role activation failed');
      await admin.query(`alter role ${executorLogin} nobypassrls`);

      await admin.query(
        `grant ${extraRole} to ${executorLogin} with inherit false, set true`,
      );
      await expect(
        clientFor(executorLogin, 'emdo_worker_executor').scopedPool.connect(),
      ).rejects.toThrow('Worker database role activation failed');
      await admin.query(`revoke ${extraRole} from ${executorLogin}`);

      await admin.query(
        `grant ${extraRole} to emdo_worker_executor with inherit false, set true`,
      );
      await expect(
        clientFor(executorLogin, 'emdo_worker_executor').scopedPool.connect(),
      ).rejects.toThrow('Worker database role activation failed');
      await admin.query(`revoke ${extraRole} from emdo_worker_executor`);
    });

    it('rejects missing SET authority and an inheriting fixed policy role', async () => {
      await admin.query(`revoke emdo_worker_executor from ${executorLogin}`);
      await expect(
        clientFor(executorLogin, 'emdo_worker_executor').scopedPool.connect(),
      ).rejects.toThrow('Worker database role activation failed');
      await admin.query(
        `grant emdo_worker_executor to ${executorLogin} with inherit false, set true`,
      );

      await admin.query(`alter role emdo_worker_executor inherit`);
      await expect(
        clientFor(executorLogin, 'emdo_worker_executor').scopedPool.connect(),
      ).rejects.toThrow('Worker database role activation failed');
      await admin.query(`alter role emdo_worker_executor noinherit`);
    });
  },
);

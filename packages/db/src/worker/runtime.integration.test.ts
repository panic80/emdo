import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from '../migrations.js';
import { PostgresNotificationDeliveryRepository } from './notifications.js';
import {
  createDatabaseClient,
  type EmdoWorkerDatabaseClient,
} from './runtime.js';

const databaseUrl = process.env.TEST_WORKER_ROLE_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const executorLogin = 'emdo_worker_executor_login';
const dispatcherLogin = 'emdo_worker_dispatcher_login';
const extraRole = 'emdo_worker_integration_extra';
const executorPassword = `emdo-test-${randomUUID()}`;
const dispatcherPassword = `emdo-test-${randomUUID()}`;
const notificationFixture = Object.freeze({
  household: '82000000-0000-4000-8000-000000000001',
  notification: '82000000-0000-4000-8000-000000000002',
  outbox: '82000000-0000-4000-8000-000000000003',
  privateSpace: '82000000-0000-4000-8000-000000000004',
  queueJob: '82000000-0000-4000-8000-000000000005',
  request: '82000000-0000-4000-8000-000000000006',
  user: '82000000-0000-4000-8000-000000000007',
  lease: '82000000-0000-4000-8000-000000000008',
  operationId: 'notification-delivery:integration:0001',
  payloadHash: 'a'.repeat(64),
});

describeDatabase(
  'worker fixed PostgreSQL roles (requires isolated TEST_WORKER_ROLE_DATABASE_URL)',
  () => {
    let admin: import('pg').Client;
    const clients: EmdoWorkerDatabaseClient[] = [];

    const urlFor = (login: string, password: string) => {
      const url = new URL(databaseUrl!);
      url.username = login;
      url.password = password;
      return url.toString();
    };
    const clientFor = (
      login: string,
      fixedRole: 'emdo_worker_executor' | 'emdo_worker_dispatch_executor',
    ) => {
      const client = createDatabaseClient({
        connectionString: urlFor(
          login,
          login === executorLogin ? executorPassword : dispatcherPassword,
        ),
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
        `create role ${executorLogin} login nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication password '${executorPassword}'`,
      );
      await admin.query(
        `create role ${dispatcherLogin} login nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication password '${dispatcherPassword}'`,
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
      await admin.query(
        `insert into emdo.auth_users (id, name, email, email_verified)
         values ($1, 'Notification owner', 'owner@example.ca', true)`,
        [notificationFixture.user],
      );
      await admin.query(
        `insert into emdo.households (id, name, slug, created_by_user_id)
         values ($1, 'Notification household', 'notification-household', $2)`,
        [notificationFixture.household, notificationFixture.user],
      );
      await admin.query(
        `insert into emdo.household_memberships
           (household_id, user_id, role, status)
         values ($1, $2, 'owner', 'active')`,
        [notificationFixture.household, notificationFixture.user],
      );
      await admin.query(
        `insert into emdo.spaces
           (id, household_id, original_owner_user_id, name, visibility)
         values ($1, $2, $3, 'Private', 'private')`,
        [
          notificationFixture.privateSpace,
          notificationFixture.household,
          notificationFixture.user,
        ],
      );
      await admin.query(
        `insert into emdo.notifications
           (notification_id, household_id, space_id, original_owner_user_id,
            source_type, source_id, source_revision, revision, sensitivity,
            title, body, in_app, email_recipient, push_subscription_reference,
            created_at, updated_at)
         values
           ($1, $2, $3, $4, 'integration', 'notification-scope', 1, 1,
            'sensitive', 'Private title', 'Private body', true,
            'frozen-target@example.ca', 'push-frozen-reference',
            pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp())`,
        [
          notificationFixture.notification,
          notificationFixture.household,
          notificationFixture.privateSpace,
          notificationFixture.user,
        ],
      );
      await admin.query(
        `insert into emdo.notification_preferences
           (household_id, user_id, in_app, push, email, spoken_replies,
            version, created_at, updated_at)
         values
           ($1, $2, true, true, false, false, 1,
            pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp())`,
        [notificationFixture.household, notificationFixture.user],
      );
      await admin.query(
        `insert into emdo.worker_operation_outbox
           (outbox_id, household_id, space_id, original_owner_user_id,
            request_id, job_name, operation_id, target_type, target_id,
            target_revision, payload, payload_hash, state, available_at,
            lease_token, lease_owner, lease_expires_at, queue_job_id,
            created_at, updated_at, retain_until)
         values
           ($1, $2, $3, $4, $5, 'emdo.notification.delivery.v1', $6,
            'notification', $7::text, 1,
            jsonb_build_object(
              'schemaVersion', 1,
              'origin', 'deterministic-worker',
              'operationId', $6::text,
              'notificationId', $7::text
            ),
            $8, 'enqueued', pg_catalog.statement_timestamp(), $9,
            'integration-worker', pg_catalog.statement_timestamp() + interval '5 minutes',
            $10, pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
            pg_catalog.statement_timestamp() + interval '90 days')`,
        [
          notificationFixture.outbox,
          notificationFixture.household,
          notificationFixture.privateSpace,
          notificationFixture.user,
          notificationFixture.request,
          notificationFixture.operationId,
          notificationFixture.notification,
          notificationFixture.payloadHash,
          notificationFixture.lease,
          notificationFixture.queueJob,
        ],
      );
      await admin.query(
        `insert into emdo.worker_job_executions
           (outbox_id, household_id, space_id, original_owner_user_id,
            job_id, job_name, operation_id, payload_hash, state,
            attempt_count, lease_token, lease_expires_at, started_at,
            updated_at, retain_until)
         values
           ($1, $2, $3, $4, $5, 'emdo.notification.delivery.v1', $6,
            $7, 'leased', 1, $8,
            pg_catalog.statement_timestamp() + interval '5 minutes',
            pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
            pg_catalog.statement_timestamp() + interval '90 days')`,
        [
          notificationFixture.outbox,
          notificationFixture.household,
          notificationFixture.privateSpace,
          notificationFixture.user,
          notificationFixture.queueJob,
          notificationFixture.operationId,
          notificationFixture.payloadHash,
          notificationFixture.lease,
        ],
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

    it('limits notification delivery to fresh opted-in aggregate targets and no raw endpoint columns', async () => {
      const database = clientFor(executorLogin, 'emdo_worker_executor');
      const repository = new PostgresNotificationDeliveryRepository(
        database.scopedPool,
      );
      const context = {
        execution: {
          jobName: 'emdo.notification.delivery.v1' as const,
          operationId: notificationFixture.operationId,
          queueJobId: notificationFixture.queueJob,
          payloadHash: notificationFixture.payloadHash,
          leaseToken: notificationFixture.lease,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        signal: new AbortController().signal,
      };

      await expect(
        repository.loadForDelivery(
          {
            operationId: notificationFixture.operationId,
            notificationId: notificationFixture.notification,
          },
          context,
        ),
      ).resolves.toMatchObject({
        notificationId: notificationFixture.notification,
        channels: { inApp: true, email: null, push: null },
      });

      const rawClient = await database.scopedPool.connect();
      try {
        await expect(
          rawClient.query(
            `select email_recipient, push_subscription_reference
               from emdo.notifications
              where notification_id = $1`,
            [notificationFixture.notification],
          ),
        ).rejects.toThrow(/permission denied/u);
      } finally {
        rawClient.release();
      }

      await admin.query(
        `update emdo.auth_users
            set email_verified = false
          where id = $1`,
        [notificationFixture.user],
      );
      await expect(
        repository.loadForDelivery(
          {
            operationId: notificationFixture.operationId,
            notificationId: notificationFixture.notification,
          },
          context,
        ),
      ).rejects.toMatchObject({ code: 'operation-unavailable' });
    });
  },
);

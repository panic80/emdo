import { Pool, type PoolConfig } from 'pg';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';

export {
  PostgresCalendarMaintenanceService,
  type CalendarProviderAttemptReconciler,
  type CalendarProviderWriteCompletion,
  type CalendarMaintenanceReadGateway,
} from './calendar-maintenance.js';
export * from '../proposals/postgres-proposal-reconciliation-repository.js';
export {
  PostgresDeterministicJobExecutionStore,
  type DurableJobExecutionInput,
  type DurableJobExecutionResult,
} from './execution-store.js';
export {
  PostgresNotificationDeliveryRepository,
  type PostgresNotificationDeliveryRecord,
} from './notifications.js';
export {
  PostgresInvitationDeliveryRepository,
  type PostgresInvitationDeliveryCapture,
  type PostgresInvitationDeliverySettlement,
} from './invitation-delivery.js';
export {
  PostgresWorkerOutboxRepository,
  type WorkerOutboxDispatchItem,
  type WorkerOutboxListDueInput,
} from './outbox.js';
export { PostgresReminderDeliveryService } from './reminders.js';
export {
  WORKER_JOB_NAMES,
  WorkerPersistenceError,
  type DurableWorkerJobName,
  type DurableWorkerJobPayload,
} from './scope.js';

const WorkerDatabaseClientConfigSchema = z.strictObject({
  connectionString: z
    .string()
    .url()
    .refine((value) =>
      ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
    ),
  max: z.number().int().positive().max(50).default(10),
  idleTimeoutMillis: z.number().int().positive().max(300_000).default(30_000),
  connectionTimeoutMillis: z
    .number()
    .int()
    .positive()
    .max(60_000)
    .default(10_000),
  applicationName: z.string().trim().min(1).max(63).default('emdo-worker'),
  fixedRole: z.enum(['emdo_worker_executor', 'emdo_worker_dispatch_executor']),
});

export interface EmdoWorkerDatabaseClient {
  readonly scopedPool: DatabasePool;
  checkReady(input: { readonly signal: AbortSignal }): Promise<void>;
  close(): Promise<void>;
}

const fixedRoleBindings = Object.freeze({
  emdo_worker_executor: Object.freeze({
    login: 'emdo_worker_executor_login',
    statement: 'set role emdo_worker_executor',
  }),
  emdo_worker_dispatch_executor: Object.freeze({
    login: 'emdo_worker_dispatcher_login',
    statement: 'set role emdo_worker_dispatch_executor',
  }),
});

/** Worker-only PostgreSQL client; deliberately excludes Drizzle/API schema imports. */
export const createDatabaseClient = (input: {
  readonly connectionString: string;
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
  readonly applicationName?: string;
  readonly fixedRole: 'emdo_worker_executor' | 'emdo_worker_dispatch_executor';
}): EmdoWorkerDatabaseClient => {
  const config = WorkerDatabaseClientConfigSchema.parse(input);
  const poolConfig: PoolConfig = {
    connectionString: config.connectionString,
    max: config.max,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    application_name: config.applicationName,
    allowExitOnIdle: true,
  };
  const pool = new Pool(poolConfig);
  const scopedPool: DatabasePool = {
    async connect() {
      const client = await pool.connect();
      const role = fixedRoleBindings[config.fixedRole];
      try {
        await client.query(role.statement);
        const identity = await client.query<{
          session_user_name: string;
          current_user_name: string;
          session_is_safe: boolean;
          role_is_safe: boolean;
          exact_membership: boolean;
          role_has_no_parents: boolean;
        }>(
          `select session_user::text as session_user_name,
                  current_user::text as current_user_name,
                  not login.rolsuper and not login.rolbypassrls
                    and not login.rolinherit as session_is_safe,
                  not role.rolsuper and not role.rolbypassrls
                    and not role.rolcanlogin and not role.rolinherit
                    as role_is_safe,
                  (
                    select pg_catalog.count(*) = 1
                      and pg_catalog.bool_and(
                        parent.rolname = current_user
                        and not membership.admin_option
                        and not membership.inherit_option
                        and membership.set_option
                      )
                    from pg_catalog.pg_auth_members membership
                    join pg_catalog.pg_roles parent
                      on parent.oid = membership.roleid
                    where membership.member = login.oid
                  ) as exact_membership,
                  not exists (
                    select 1
                    from pg_catalog.pg_auth_members role_parent
                    where role_parent.member = role.oid
                  ) as role_has_no_parents
             from pg_catalog.pg_roles login
             join pg_catalog.pg_roles role on role.rolname = current_user
            where login.rolname = session_user`,
        );
        const row = identity.rows[0];
        if (
          row?.session_user_name !== role.login ||
          row.current_user_name !== config.fixedRole ||
          row.session_is_safe !== true ||
          row.role_is_safe !== true ||
          row.exact_membership !== true ||
          row.role_has_no_parents !== true
        ) {
          throw new Error('invalid worker database role');
        }
      } catch {
        client.release(true);
        throw new Error('Worker database role activation failed');
      }
      return {
        async query(text, values) {
          const result = await client.query(
            text,
            values === undefined ? [] : [...values],
          );
          return {
            rowCount: result.rowCount,
            rows: result.rows as readonly Record<string, unknown>[],
          };
        },
        // SET ROLE is session scoped. Destroy on release so a privileged role
        // can never bleed into a later pool checkout.
        release: () => client.release(true),
      };
    },
  };
  return Object.freeze({
    scopedPool,
    async checkReady(input: { readonly signal: AbortSignal }): Promise<void> {
      input.signal.throwIfAborted();
      let client: Awaited<ReturnType<DatabasePool['connect']>> | undefined;
      try {
        client = await scopedPool.connect();
        input.signal.throwIfAborted();
        const result = await client.query(
          `select true as ready
           where pg_catalog.current_setting('transaction_read_only') in ('on', 'off')`,
        );
        if (result.rows[0]?.ready !== true) {
          throw new Error('invalid');
        }
      } catch {
        throw new Error('Worker database readiness failed');
      } finally {
        client?.release();
      }
    },
    close: () => pool.end(),
  });
};

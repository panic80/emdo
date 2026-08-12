import { createRequire } from 'node:module';

import { deepFreeze } from '@emdo/contracts';
import type { ConstructorOptions } from 'pg-boss';

import {
  WORKER_JOB_NAMES,
  enqueueWorkerJob,
  registerWorkerJobs,
  type PgBossCompatible,
  type WorkerJobEnqueueResult,
  type WorkerJobDependencies,
  type WorkerJobName,
  type WorkerJobSchedulingOptions,
} from './jobs.js';

export interface PgBossRuntime extends PgBossCompatible {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  start(): Promise<unknown>;
  getDb(): {
    executeSql(
      text: string,
      values?: readonly unknown[],
    ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  };
  offWork(
    name: string,
    options: { readonly id: string; readonly wait: boolean },
  ): Promise<unknown>;
  stop(options?: { readonly graceful?: boolean }): Promise<unknown>;
}

export interface PgBossRuntimeModule {
  readonly PgBoss: new (options: unknown) => PgBossRuntime;
}

export interface DeterministicWorkerHandle {
  enqueue(
    name: WorkerJobName,
    input: unknown,
    options?: WorkerJobSchedulingOptions,
  ): Promise<WorkerJobEnqueueResult>;
  stop(): Promise<void>;
}

export interface WorkerOperationalEvent {
  readonly code: 'queue-runtime-error' | 'outbox-runtime-error';
}

const isSafeDatabaseUrl = (input: string): boolean => {
  try {
    if (input !== input.trim() || input.length > 4_096) return false;
    if (
      Array.from(input).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      })
    ) {
      return false;
    }
    const url = new URL(input);
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      decodeURIComponent(url.username) === 'emdo_worker_login' &&
      url.password.length > 0 &&
      url.hostname.length > 0 &&
      url.pathname.length > 1 &&
      url.hash === ''
    );
  } catch {
    return false;
  }
};

const defaultPgBossModuleLoader = async (): Promise<unknown> => {
  const require = createRequire(import.meta.url);
  return require('pg-boss') as unknown;
};

const createPgBossOptions = (databaseUrl: string): ConstructorOptions => ({
  connectionString: databaseUrl,
  schema: 'pgboss',
  application_name: 'emdo-worker',
  migrate: false,
  createSchema: false,
  supervise: true,
  schedule: true,
  useListenNotify: true,
});

const parsePgBossModule = (
  input: unknown,
): new (options: unknown) => PgBossRuntime => {
  try {
    if (input === null || typeof input !== 'object') throw new Error('invalid');
    const descriptor = Object.getOwnPropertyDescriptor(input, 'PgBoss');
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      typeof descriptor.value !== 'function'
    ) {
      throw new Error('invalid');
    }
    return descriptor.value as new (options: unknown) => PgBossRuntime;
  } catch {
    throw new Error('pg-boss runtime is unavailable');
  }
};

const isPgBossRuntime = (input: unknown): input is PgBossRuntime => {
  if (input === null || typeof input !== 'object') return false;
  for (const method of [
    'on',
    'start',
    'getDb',
    'createQueue',
    'work',
    'send',
    'getJobById',
    'offWork',
    'stop',
  ]) {
    try {
      if (typeof Reflect.get(input, method) !== 'function') return false;
    } catch {
      return false;
    }
  }
  return true;
};

const QUEUE_PROBE_TIMED_OUT = Symbol('queue-probe-timed-out');

const verifyQueuePrincipal = async (boss: PgBossRuntime): Promise<void> => {
  const signal = AbortSignal.timeout(5_000);
  let resolveTimeout:
    ((value: typeof QUEUE_PROBE_TIMED_OUT) => void) | undefined;
  const timedOut = new Promise<typeof QUEUE_PROBE_TIMED_OUT>((resolve) => {
    resolveTimeout = resolve;
  });
  const onAbort = (): void => resolveTimeout?.(QUEUE_PROBE_TIMED_OUT);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const pending = Promise.resolve().then(() =>
    boss.getDb().executeSql(
      `select session_user::text as session_user_name,
              current_user::text as current_user_name,
              login.rolcanlogin and not login.rolsuper
                and not login.rolcreatedb and not login.rolcreaterole
                and not login.rolinherit and not login.rolbypassrls
                and not login.rolreplication as role_is_safe,
              not exists (
                select 1 from pg_catalog.pg_auth_members membership
                 where membership.member = login.oid
              ) as has_no_memberships,
              not exists (
                select 1 from pg_catalog.pg_auth_members membership
                 where membership.roleid = login.oid
              ) as has_no_children,
              not pg_catalog.has_schema_privilege(
                session_user, 'emdo', 'USAGE'
              ) as emdo_schema_denied,
              pg_catalog.has_schema_privilege(
                session_user, 'pgboss', 'USAGE'
              ) as pgboss_schema_allowed
         from pg_catalog.pg_roles login
        where login.rolname = session_user
          and session_user = 'emdo_worker_login'`,
    ),
  );
  let raw: Awaited<typeof pending> | typeof QUEUE_PROBE_TIMED_OUT;
  try {
    raw = await Promise.race([pending, timedOut]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (raw === QUEUE_PROBE_TIMED_OUT) {
    void pending.catch(() => undefined);
    throw new Error('invalid');
  }
  const row = raw.rows[0];
  if (
    row?.session_user_name !== 'emdo_worker_login' ||
    row.current_user_name !== 'emdo_worker_login' ||
    row.role_is_safe !== true ||
    row.has_no_memberships !== true ||
    row.has_no_children !== true ||
    row.emdo_schema_denied !== true ||
    row.pgboss_schema_allowed !== true
  ) {
    throw new Error('invalid');
  }
};

export const startDeterministicWorker = async (input: {
  readonly databaseUrl: string;
  readonly dependencies: WorkerJobDependencies;
  readonly onOperationalEvent: (event: WorkerOperationalEvent) => void;
  readonly moduleLoader?: () => Promise<unknown>;
}): Promise<DeterministicWorkerHandle> => {
  if (!isSafeDatabaseUrl(input.databaseUrl)) {
    throw new Error('Worker database configuration is invalid');
  }

  let rawModule: unknown;
  try {
    rawModule = await (input.moduleLoader ?? defaultPgBossModuleLoader)();
  } catch {
    throw new Error('pg-boss runtime is unavailable');
  }
  const PgBoss = parsePgBossModule(rawModule);
  let boss: PgBossRuntime;
  try {
    const candidate: unknown = new PgBoss(
      createPgBossOptions(input.databaseUrl),
    );
    if (!isPgBossRuntime(candidate)) throw new Error('invalid');
    boss = candidate;
  } catch {
    throw new Error('pg-boss runtime is unavailable');
  }

  let workerIds: Readonly<Record<WorkerJobName, string>>;
  try {
    boss.on('error', () => {
      try {
        input.onOperationalEvent(
          deepFreeze({ code: 'queue-runtime-error' as const }),
        );
      } catch {
        // Operational reporting must never terminate the queue event loop.
      }
    });
    await boss.start();
    await verifyQueuePrincipal(boss);
    workerIds = await registerWorkerJobs(boss, input.dependencies);
  } catch {
    try {
      await boss.stop({ graceful: true });
    } catch {
      // Preserve only the sanitized startup failure at this boundary.
    }
    throw new Error('Worker startup failed');
  }

  let stopPromise: Promise<void> | undefined;
  let acceptingEnqueues = true;
  const activeEnqueues = new Set<Promise<WorkerJobEnqueueResult>>();
  return Object.freeze({
    enqueue(
      name: WorkerJobName,
      payload: unknown,
      options?: WorkerJobSchedulingOptions,
    ): Promise<WorkerJobEnqueueResult> {
      if (!acceptingEnqueues) {
        return Promise.reject(new Error('Worker is stopping'));
      }
      const pending = enqueueWorkerJob(boss, name, payload, options);
      activeEnqueues.add(pending);
      void pending
        .finally(() => activeEnqueues.delete(pending))
        .catch(() => {
          // The original caller observes the rejection; cleanup is best effort.
        });
      return pending;
    },
    stop(): Promise<void> {
      stopPromise ??= (async () => {
        acceptingEnqueues = false;
        let failed = false;
        const enqueueResults = await Promise.allSettled(activeEnqueues);
        if (enqueueResults.some((result) => result.status === 'rejected')) {
          failed = true;
        }
        for (const name of Object.values(WORKER_JOB_NAMES).reverse()) {
          try {
            await boss.offWork(name, { id: workerIds[name], wait: true });
          } catch {
            failed = true;
          }
        }
        try {
          await boss.stop({ graceful: true });
        } catch {
          failed = true;
        }
        if (failed) throw new Error('Worker shutdown failed');
      })();
      return stopPromise;
    },
  });
};

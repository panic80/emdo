import { describe, expect, it } from 'vitest';

import {
  WORKER_JOB_NAMES,
  deriveWorkerQueueJobId,
  hashWorkerJobPayload,
  type PgBossCompatible,
  type PgBossJob,
  type WorkerJobDependencies,
} from './jobs.js';
import {
  startDeterministicWorker,
  type PgBossRuntime,
  type PgBossRuntimeModule,
} from './main.js';

const createDependencies = (): WorkerJobDependencies => ({
  executions: {
    async executeOnce(input, operation) {
      await operation({
        jobName: input.jobName,
        operationId: input.operationId,
        queueJobId: input.jobId,
        payloadHash: input.payloadHash,
        leaseToken: '30000000-0000-4000-8000-000000000001',
        leaseExpiresAt: '2026-08-10T12:05:00.000Z',
      });
      return { status: 'executed' };
    },
  },
  reminders: { async deliverReminder() {} },
  calendar: {
    async synchronize() {},
    async retrySynchronization() {},
    async reconcileProviderAttempt() {},
  },
  notifications: {
    async deliver() {
      return { status: 'delivered', attemptedChannels: 1 };
    },
  },
  invitations: {
    async deliver() {
      return { status: 'delivered' };
    },
  },
});

class FakePgBoss implements PgBossRuntime, PgBossCompatible {
  static instances: FakePgBoss[] = [];
  readonly events: string[] = [];
  readonly options: unknown;
  errorListener: ((error: unknown) => void) | undefined;

  constructor(options: unknown) {
    this.options = options;
    FakePgBoss.instances.push(this);
  }

  on(event: 'error', listener: (error: unknown) => void): this {
    this.events.push(`on:${event}`);
    this.errorListener = listener;
    return this;
  }

  async start(): Promise<void> {
    this.events.push('start');
  }

  getDb() {
    return {
      executeSql: async (sql: string) => {
        this.events.push('probe:queue-role');
        expect(sql).toContain('emdo_worker_login');
        expect(sql).toContain('pg_auth_members');
        return {
          rows: [
            {
              session_user_name: 'emdo_worker_login',
              current_user_name: 'emdo_worker_login',
              role_is_safe: true,
              has_no_memberships: true,
              has_no_children: true,
              emdo_schema_denied: true,
              pgboss_schema_allowed: true,
            },
          ],
        };
      },
    };
  }

  async createQueue(name: string): Promise<void> {
    this.events.push(`create:${name}`);
  }

  async work(
    name: string,
    options: unknown,
    handler: (jobs: readonly PgBossJob[]) => Promise<unknown>,
  ): Promise<string> {
    void options;
    void handler;
    this.events.push(`work:${name}`);
    return `worker-${name}`;
  }

  async send(
    name: string,
    _data: object,
    options: import('pg-boss').SendOptions,
  ): Promise<string | null> {
    this.events.push(`send:${name}`);
    return options.id ?? null;
  }

  async getJobById(): Promise<never> {
    throw new Error('unexpected duplicate lookup');
  }

  async offWork(
    name: string,
    options: { readonly id: string; readonly wait: boolean },
  ): Promise<void> {
    this.events.push(`off:${name}:${options.id}:${String(options.wait)}`);
  }

  async stop(options?: { readonly graceful?: boolean }): Promise<void> {
    this.events.push(`stop:${String(options?.graceful)}`);
  }
}

const moduleLoader = async (): Promise<PgBossRuntimeModule> => ({
  PgBoss: FakePgBoss,
});

describe('production pg-boss worker bootstrap', () => {
  it('uses the real pg-boss constructor boundary and registers only after startup', async () => {
    FakePgBoss.instances.length = 0;
    const operationalEvents: unknown[] = [];

    const handle = await startDeterministicWorker({
      databaseUrl: 'postgresql://emdo_worker_login:secret@db.example/emdo',
      dependencies: createDependencies(),
      onOperationalEvent(event) {
        operationalEvents.push(event);
      },
      moduleLoader,
    });

    const runtime = FakePgBoss.instances[0]!;
    expect(runtime.options).toEqual({
      connectionString: 'postgresql://emdo_worker_login:secret@db.example/emdo',
      schema: 'pgboss',
      application_name: 'emdo-worker',
      migrate: false,
      createSchema: false,
      supervise: true,
      schedule: true,
      useListenNotify: true,
    });
    expect(runtime.events[0]).toBe('on:error');
    expect(runtime.events[1]).toBe('start');
    expect(runtime.events[2]).toBe('probe:queue-role');
    expect(runtime.events[3]).toBe('create:emdo.worker.dead-letter.v1');
    expect(runtime.events.slice(4, 6)).toEqual([
      `create:${WORKER_JOB_NAMES.reminderDelivery}`,
      `work:${WORKER_JOB_NAMES.reminderDelivery}`,
    ]);

    runtime.errorListener?.(
      new Error('private connection string and provider response'),
    );
    expect(operationalEvents).toEqual([{ code: 'queue-runtime-error' }]);

    const payload = {
      schemaVersion: 1,
      origin: 'deterministic-worker',
      operationId: 'operation:reminder:1',
      reminderId: 'reminder-reference',
      dueRevision: 1,
    } as const;
    const expectedJobId = deriveWorkerQueueJobId(
      WORKER_JOB_NAMES.reminderDelivery,
      payload.operationId,
      hashWorkerJobPayload(WORKER_JOB_NAMES.reminderDelivery, payload),
    );
    await expect(
      handle.enqueue(WORKER_JOB_NAMES.reminderDelivery, payload),
    ).resolves.toEqual({ status: 'enqueued', jobId: expectedJobId });
    expect(runtime.events).toContain(
      `send:${WORKER_JOB_NAMES.reminderDelivery}`,
    );

    await handle.stop();
    await handle.stop();
    expect(runtime.events.filter((event) => event.startsWith('off:'))).toEqual(
      Object.values(WORKER_JOB_NAMES)
        .reverse()
        .map((name) => `off:${name}:worker-${name}:true`),
    );
    expect(runtime.events.filter((event) => event.startsWith('stop:'))).toEqual(
      ['stop:true'],
    );
  });

  it('rejects unsafe database URLs before loading pg-boss', async () => {
    let loads = 0;
    const load = async (): Promise<PgBossRuntimeModule> => {
      loads += 1;
      return { PgBoss: FakePgBoss };
    };

    await expect(
      startDeterministicWorker({
        databaseUrl: 'https://db.example/emdo?password=leaked',
        dependencies: createDependencies(),
        onOperationalEvent() {},
        moduleLoader: load,
      }),
    ).rejects.toThrow('Worker database configuration is invalid');
    expect(loads).toBe(0);
  });

  it('stops pg-boss when job registration fails', async () => {
    class FailingPgBoss extends FakePgBoss {
      override async work(
        name: string,
        options: unknown,
        handler: (jobs: readonly PgBossJob[]) => Promise<unknown>,
      ): Promise<string> {
        if (name === WORKER_JOB_NAMES.calendarSync) {
          this.events.push(`work-failed:${name}`);
          throw new Error('private database detail');
        }
        return super.work(name, options, handler);
      }
    }
    const instances: FailingPgBoss[] = [];
    const loader = async (): Promise<PgBossRuntimeModule> => ({
      PgBoss: class extends FailingPgBoss {
        constructor(options: unknown) {
          super(options);
          instances.push(this);
        }
      },
    });

    await expect(
      startDeterministicWorker({
        databaseUrl: 'postgres://emdo_worker_login:secret@db.example/emdo',
        dependencies: createDependencies(),
        onOperationalEvent() {},
        moduleLoader: loader,
      }),
    ).rejects.toThrow('Worker startup failed');
    expect(instances[0]?.events.at(-1)).toBe('stop:true');
  });

  it('fails before queue registration when the queue principal topology drifts', async () => {
    class UnsafeQueuePgBoss extends FakePgBoss {
      override getDb() {
        return {
          executeSql: async () => {
            this.events.push('probe:queue-role');
            return {
              rows: [
                {
                  session_user_name: 'emdo_worker_login',
                  current_user_name: 'emdo_worker_login',
                  role_is_safe: true,
                  has_no_memberships: false,
                  has_no_children: true,
                  emdo_schema_denied: true,
                  pgboss_schema_allowed: true,
                },
              ],
            };
          },
        };
      }
    }
    const instances: UnsafeQueuePgBoss[] = [];

    await expect(
      startDeterministicWorker({
        databaseUrl: 'postgresql://emdo_worker_login:secret@db.example/emdo',
        dependencies: createDependencies(),
        onOperationalEvent() {},
        moduleLoader: async () => ({
          PgBoss: class extends UnsafeQueuePgBoss {
            constructor(options: unknown) {
              super(options);
              instances.push(this);
            }
          },
        }),
      }),
    ).rejects.toThrow('Worker startup failed');
    expect(instances[0]?.events).toEqual([
      'on:error',
      'start',
      'probe:queue-role',
      'stop:true',
    ]);
  });

  it('fails closed when the installed module does not expose PgBoss', async () => {
    await expect(
      startDeterministicWorker({
        databaseUrl: 'postgres://emdo_worker_login:secret@db.example/emdo',
        dependencies: createDependencies(),
        onOperationalEvent() {},
        moduleLoader: async () => ({}) as PgBossRuntimeModule,
      }),
    ).rejects.toThrow('pg-boss runtime is unavailable');
  });
});

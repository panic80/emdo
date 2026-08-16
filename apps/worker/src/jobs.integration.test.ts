import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BACKGROUND_JOB_POLICY,
  WORKER_JOB_NAMES,
  createWorkerJobHandlers,
  deriveWorkerQueueJobId,
  enqueueWorkerJob,
  hashWorkerJobPayload,
  registerWorkerJobs,
  type DeterministicJobExecutionStore,
  type PgBossCompatible,
  type PgBossJob,
  type WorkerJobDependencies,
} from './jobs.js';

class FakeBoss implements PgBossCompatible {
  readonly queues: Array<{ readonly name: string; readonly options: unknown }> =
    [];
  readonly workers = new Map<
    string,
    {
      readonly options: unknown;
      readonly handler: (jobs: readonly PgBossJob[]) => Promise<unknown>;
    }
  >();
  readonly sends: Array<{
    readonly name: string;
    readonly data: unknown;
    readonly options: Record<string, unknown>;
  }> = [];
  readonly #jobs = new Map<string, string>();
  readonly #records = new Map<
    string,
    {
      readonly id: string;
      readonly name: string;
      readonly data: unknown;
      readonly singletonKey: string;
      readonly state: 'created' | 'completed';
    }
  >();

  async createQueue(name: string, options: unknown): Promise<void> {
    this.queues.push({ name, options });
  }

  async work(
    name: string,
    options: unknown,
    handler: (jobs: readonly PgBossJob[]) => Promise<unknown>,
  ): Promise<string> {
    this.workers.set(name, { options, handler });
    return `worker-${name}`;
  }

  async send(
    name: string,
    data: unknown,
    options: Record<string, unknown>,
  ): Promise<string | null> {
    this.sends.push({ name, data, options });
    const id = String(options.id);
    const key = `${name}:${String(options.singletonKey)}`;
    const existing = this.#jobs.get(key);
    if (existing !== undefined) {
      if (existing !== id) throw new Error('singleton binding changed');
      return null;
    }
    this.#jobs.set(key, id);
    this.#records.set(id, {
      id,
      name,
      data,
      singletonKey: String(options.singletonKey),
      state: 'created',
    });
    return id;
  }

  async getJobById<TData extends object>(
    _name: string,
    id: string,
  ): Promise<import('pg-boss').JobWithMetadata<TData> | null> {
    return (this.#records.get(id) as never) ?? null;
  }
}

const job = (
  id: string,
  name: string,
  data: unknown,
  signal = new AbortController().signal,
): PgBossJob => ({ id, name, data, signal });

const JOB_IDS = {
  reminder: '20000000-0000-4000-8000-000000000001',
  calendarSync: '20000000-0000-4000-8000-000000000002',
  calendarRetry: '20000000-0000-4000-8000-000000000003',
  reconciliation: '20000000-0000-4000-8000-000000000004',
  notification: '20000000-0000-4000-8000-000000000005',
  invitation: '20000000-0000-8000-8000-000000000006',
} as const;

const executionPermit = (input: {
  readonly jobId: string;
  readonly jobName: (typeof WORKER_JOB_NAMES)[keyof typeof WORKER_JOB_NAMES];
  readonly operationId: string;
  readonly payloadHash: string;
}) => ({
  jobName: input.jobName,
  operationId: input.operationId,
  queueJobId: input.jobId,
  payloadHash: input.payloadHash,
  leaseToken: '30000000-0000-4000-8000-000000000001',
  leaseExpiresAt: '2026-08-10T12:05:00.000Z',
});

const payloads = {
  [WORKER_JOB_NAMES.reminderDelivery]: {
    schemaVersion: 1,
    origin: 'deterministic-worker',
    operationId: 'reminder-operation:0001',
    reminderId: 'reminder-42',
    dueRevision: 7,
  },
  [WORKER_JOB_NAMES.calendarSync]: {
    schemaVersion: 1,
    origin: 'deterministic-worker',
    operationId: 'calendar-sync-operation:0001',
    connectionId: 'google-connection-42',
    syncGeneration: 9,
  },
  [WORKER_JOB_NAMES.calendarRetry]: {
    schemaVersion: 1,
    origin: 'deterministic-worker',
    operationId: 'calendar-retry-operation:0001',
    failedOperationId: 'calendar-sync-operation:0000',
    connectionId: 'google-connection-42',
    retrySequence: 2,
  },
  [WORKER_JOB_NAMES.calendarReconciliation]: {
    schemaVersion: 1,
    origin: 'deterministic-worker',
    operationId: 'calendar-reconcile-operation:0001',
    providerAttemptId: '90000000-0000-4000-8000-000000000001',
  },
  [WORKER_JOB_NAMES.notificationDelivery]: {
    schemaVersion: 1,
    origin: 'deterministic-worker',
    operationId: 'notification-operation:0001',
    notificationId: 'notification-42',
  },
  [WORKER_JOB_NAMES.invitationDelivery]: {
    schemaVersion: 1,
    origin: 'deterministic-worker',
    operationId: 'invitation:11111111-1111-4111-8111-111111111111',
    invitationId: '11111111-1111-4111-8111-111111111111',
    deliverySecretId: '22222222-2222-4222-8222-222222222222',
  },
} as const;

const createDependencies = (overrides?: {
  readonly executions?: DeterministicJobExecutionStore;
}): {
  readonly dependencies: WorkerJobDependencies;
  readonly calls: string[];
} => {
  const calls: string[] = [];
  const executions: DeterministicJobExecutionStore =
    overrides?.executions ??
    ({
      async executeOnce(input, operation) {
        calls.push(`execute:${input.jobName}:${input.operationId}`);
        await operation(executionPermit(input));
        return { status: 'executed' };
      },
    } satisfies DeterministicJobExecutionStore);

  return {
    calls,
    dependencies: {
      executions,
      reminders: {
        async deliverReminder(input, context) {
          expect(context.execution.operationId).toBe(input.operationId);
          expect(context.signal).toBeInstanceOf(AbortSignal);
          calls.push(`reminder:${input.reminderId}:${input.dueRevision}`);
        },
      },
      calendar: {
        async synchronize(input, context) {
          expect(context.execution.operationId).toBe(input.operationId);
          calls.push(`sync:${input.connectionId}:${input.syncGeneration}`);
        },
        async retrySynchronization(input, context) {
          expect(context.execution.operationId).toBe(input.operationId);
          calls.push(
            `retry:${input.connectionId}:${input.failedOperationId}:${input.retrySequence}`,
          );
        },
        async reconcileProviderAttempt(input, context) {
          expect(context.execution.operationId).toBe(input.operationId);
          calls.push(`reconcile:${input.providerAttemptId}`);
        },
      },
      notifications: {
        async deliver(input, context) {
          expect(context.execution.operationId).toBe(input.operationId);
          calls.push(`notification:${input.notificationId}`);
          return { status: 'delivered', attemptedChannels: 1 };
        },
      },
      invitations: {
        async deliver(input, context) {
          expect(context.execution.operationId).toBe(input.operationId);
          calls.push(`invitation:${input.invitationId}`);
          return { status: 'delivered' };
        },
      },
    },
  };
};

describe('deterministic worker job registry', () => {
  it('registers one-job pg-boss workers with bounded concurrency and explicit retries', async () => {
    const boss = new FakeBoss();
    const { dependencies } = createDependencies();

    await expect(registerWorkerJobs(boss, dependencies)).resolves.toEqual(
      Object.fromEntries(
        Object.values(WORKER_JOB_NAMES).map((name) => [name, `worker-${name}`]),
      ),
    );

    expect(boss.queues.map(({ name }) => name)).toEqual([
      'emdo.worker.dead-letter.v1',
      ...Object.values(WORKER_JOB_NAMES),
    ]);
    expect(boss.queues[0]?.options).toEqual({
      policy: 'standard',
      retryLimit: 0,
      retentionSeconds: 2_592_000,
      deleteAfterSeconds: 2_592_000,
    });
    expect([...boss.workers]).toHaveLength(6);
    for (const [name, worker] of boss.workers) {
      expect(worker.options).toMatchObject({
        batchSize: 1,
        localConcurrency: 1,
        pollingIntervalSeconds: 2,
      });
      const queue = boss.queues.find((candidate) => candidate.name === name);
      expect(queue?.options).toMatchObject({
        policy: 'short',
        retryBackoff: true,
        retryLimit: expect.any(Number),
        retryDelay: expect.any(Number),
        retryDelayMax: expect.any(Number),
        deadLetter: 'emdo.worker.dead-letter.v1',
      });
    }

    const retryLimitFor = (name: string): unknown => {
      const options = boss.queues.find(
        (candidate) => candidate.name === name,
      )?.options;
      return (options as Record<string, unknown> | undefined)?.retryLimit;
    };
    expect(retryLimitFor(WORKER_JOB_NAMES.calendarSync)).toBe(0);
    expect(retryLimitFor(WORKER_JOB_NAMES.calendarRetry)).toBe(0);
    expect(retryLimitFor(WORKER_JOB_NAMES.calendarReconciliation)).toBe(5);
  });

  it('enqueues unique jobs with one payload-bound canonical UUID across concurrent and terminal replays', async () => {
    const boss = new FakeBoss();
    const name = WORKER_JOB_NAMES.reminderDelivery;

    const payloadHash = hashWorkerJobPayload(name, payloads[name]);
    const canonicalJobId = deriveWorkerQueueJobId(
      name,
      payloads[name].operationId,
      payloadHash,
    );
    const concurrent = await Promise.all([
      enqueueWorkerJob(boss, name, payloads[name]),
      enqueueWorkerJob(boss, name, payloads[name]),
    ]);
    expect(concurrent).toEqual([
      { status: 'enqueued', jobId: canonicalJobId },
      { status: 'duplicate', jobId: canonicalJobId },
    ]);
    expect(canonicalJobId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    );
    expect(canonicalJobId).toBe('8b317831-a56c-8925-83e8-a573cc096bf8');

    const singletonKey = createHash('sha256')
      .update(`${name}\0${payloads[name].operationId}\0${payloadHash}`, 'utf8')
      .digest('hex');
    expect(boss.sends[0]).toEqual({
      name,
      data: payloads[name],
      options: {
        id: canonicalJobId,
        singletonKey,
        singletonSeconds: 2_592_000,
        retryLimit: 5,
        retryDelay: 30,
        retryBackoff: true,
        retryDelayMax: 900,
        expireInSeconds: 120,
        retentionSeconds: 2_592_000,
        deleteAfterSeconds: 604_800,
        deadLetter: 'emdo.worker.dead-letter.v1',
      },
    });
    expect(singletonKey).not.toContain('reminder-operation');

    await expect(
      enqueueWorkerJob(boss, name, {
        ...payloads[name],
        reminderId: 'different-reminder',
      }),
    ).resolves.toEqual({
      status: 'enqueued',
      jobId: expect.not.stringMatching(canonicalJobId),
    });
    expect(boss.sends[2]?.options.singletonKey).not.toBe(singletonKey);

    // A replay after the queue job has become active or terminal still has the
    // same caller-supplied UUID; no queue lookup or first-handler backfill is needed.
    const terminalReplayBoss: Pick<PgBossCompatible, 'send' | 'getJobById'> = {
      async send(_name, _data, options) {
        expect(options.id).toBe(canonicalJobId);
        return null;
      },
      async getJobById() {
        return {
          id: canonicalJobId,
          name,
          data: payloads[name],
          singletonKey,
          state: 'completed',
        } as never;
      },
    };
    await expect(
      enqueueWorkerJob(terminalReplayBoss, name, payloads[name]),
    ).resolves.toEqual({ status: 'duplicate', jobId: canonicalJobId });
  });

  it('defers reminders with a cloned start time and rejects retry-policy overrides', async () => {
    const boss = new FakeBoss();
    const name = WORKER_JOB_NAMES.reminderDelivery;
    const startAfter = new Date('2026-08-10T13:00:00.000Z');

    await enqueueWorkerJob(boss, name, payloads[name], { startAfter });
    const queuedStart = boss.sends[0]?.options.startAfter;
    expect(queuedStart).toEqual(startAfter);
    expect(queuedStart).not.toBe(startAfter);

    await expect(
      enqueueWorkerJob(
        boss,
        name,
        {
          ...payloads[name],
          operationId: 'reminder-operation:0002',
        },
        { startAfter: new Date(Number.NaN) },
      ),
    ).rejects.toThrow('Background job scheduling options are invalid');
    await expect(
      enqueueWorkerJob(
        boss,
        name,
        { ...payloads[name], operationId: 'reminder-operation:0003' },
        { retryLimit: 999 } as never,
      ),
    ).rejects.toThrow('Background job scheduling options are invalid');
    expect(boss.sends).toHaveLength(1);
  });

  it('refuses null-send recovery unless pg-boss readback proves the exact runnable or completed binding', async () => {
    const name = WORKER_JOB_NAMES.reminderDelivery;
    const payloadHash = hashWorkerJobPayload(name, payloads[name]);
    const expectedId = deriveWorkerQueueJobId(
      name,
      payloads[name].operationId,
      payloadHash,
    );
    const expectedKey = createHash('sha256')
      .update(`${name}\0${payloads[name].operationId}\0${payloadHash}`, 'utf8')
      .digest('hex');
    const candidates = [
      null,
      {
        id: expectedId,
        name,
        data: { ...payloads[name], reminderId: 'other-reminder' },
        singletonKey: expectedKey,
        state: 'created',
      },
      {
        id: expectedId,
        name,
        data: payloads[name],
        singletonKey: expectedKey,
        state: 'cancelled',
      },
      {
        id: expectedId,
        name,
        data: payloads[name],
        singletonKey: 'f'.repeat(64),
        state: 'completed',
      },
    ] as const;

    for (const candidate of candidates) {
      await expect(
        enqueueWorkerJob(
          {
            async send() {
              return null;
            },
            async getJobById() {
              return candidate as never;
            },
          },
          name,
          payloads[name],
        ),
      ).rejects.toMatchObject({
        message: 'Worker queue binding is invalid',
        code: 'invalid-operation',
      });
    }
  });

  it('recovers an applied-then-threw send only from the exact canonical queue readback', async () => {
    const name = WORKER_JOB_NAMES.reminderDelivery;
    const payloadHash = hashWorkerJobPayload(name, payloads[name]);
    const expectedId = deriveWorkerQueueJobId(
      name,
      payloads[name].operationId,
      payloadHash,
    );
    const expectedKey = createHash('sha256')
      .update(`${name}\0${payloads[name].operationId}\0${payloadHash}`, 'utf8')
      .digest('hex');

    await expect(
      enqueueWorkerJob(
        {
          async send() {
            throw new Error('connection closed after commit');
          },
          async getJobById() {
            return {
              id: expectedId,
              name,
              data: payloads[name],
              singletonKey: expectedKey,
              state: 'created',
            } as never;
          },
        },
        name,
        payloads[name],
      ),
    ).resolves.toEqual({ status: 'duplicate', jobId: expectedId });
  });

  it('dispatches reminder, Calendar sync/retry/reconciliation, notification, and invitation services', async () => {
    const { dependencies, calls } = createDependencies();
    const handlers = createWorkerJobHandlers(dependencies);

    const jobIds = [
      JOB_IDS.reminder,
      JOB_IDS.calendarSync,
      JOB_IDS.calendarRetry,
      JOB_IDS.reconciliation,
      JOB_IDS.notification,
      JOB_IDS.invitation,
    ];
    for (const [index, name] of Object.values(WORKER_JOB_NAMES).entries()) {
      await expect(
        handlers[name]([job(jobIds[index]!, name, payloads[name])]),
      ).resolves.toEqual({ status: 'executed' });
    }

    expect(calls).toEqual([
      `execute:${WORKER_JOB_NAMES.reminderDelivery}:reminder-operation:0001`,
      'reminder:reminder-42:7',
      `execute:${WORKER_JOB_NAMES.calendarSync}:calendar-sync-operation:0001`,
      'sync:google-connection-42:9',
      `execute:${WORKER_JOB_NAMES.calendarRetry}:calendar-retry-operation:0001`,
      'retry:google-connection-42:calendar-sync-operation:0000:2',
      `execute:${WORKER_JOB_NAMES.calendarReconciliation}:calendar-reconcile-operation:0001`,
      'reconcile:90000000-0000-4000-8000-000000000001',
      `execute:${WORKER_JOB_NAMES.notificationDelivery}:notification-operation:0001`,
      'notification:notification-42',
      `execute:${WORKER_JOB_NAMES.invitationDelivery}:invitation:11111111-1111-4111-8111-111111111111`,
      'invitation:11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('does not repeat a deterministic side effect after the execution store reports a duplicate', async () => {
    let escapedCallback:
      | ((permit: ReturnType<typeof executionPermit>) => Promise<void>)
      | undefined;
    const { dependencies, calls } = createDependencies({
      executions: {
        async executeOnce(input, operation) {
          escapedCallback = operation as typeof escapedCallback;
          expect(input.jobId).toBe(JOB_IDS.reminder);
          return { status: 'duplicate' };
        },
      },
    });
    const handlers = createWorkerJobHandlers(dependencies);
    const name = WORKER_JOB_NAMES.reminderDelivery;

    await expect(
      handlers[name]([job(JOB_IDS.reminder, name, payloads[name])]),
    ).resolves.toEqual({ status: 'duplicate' });
    expect(calls).toEqual([]);
    expect(escapedCallback).toBeTypeOf('function');
    await expect(
      escapedCallback!(
        executionPermit({
          jobId: JOB_IDS.reminder,
          jobName: name,
          operationId: payloads[name].operationId,
          payloadHash: hashWorkerJobPayload(name, payloads[name]),
        }),
      ),
    ).rejects.toThrow('invalid');
    expect(calls).toEqual([]);
  });

  it('terminates safely when the durable execution retry ceiling is exhausted', async () => {
    const exhausted = Object.assign(new Error('private persistence detail'), {
      code: 'attempt-exhausted' as const,
    });
    const { dependencies, calls } = createDependencies({
      executions: {
        async executeOnce() {
          throw exhausted;
        },
      },
    });
    const name = WORKER_JOB_NAMES.reminderDelivery;

    await expect(
      createWorkerJobHandlers(dependencies)[name]([
        job('20000000-0000-4000-8000-000000000010', name, payloads[name]),
      ]),
    ).resolves.toEqual({ status: 'exhausted' });
    expect(calls).toEqual([]);

    let accessorCalls = 0;
    const unsafeError = new Error('private persistence detail');
    Object.defineProperty(unsafeError, 'code', {
      get() {
        accessorCalls += 1;
        return 'attempt-exhausted';
      },
    });
    const unsafe = createDependencies({
      executions: {
        async executeOnce() {
          throw unsafeError;
        },
      },
    });
    await expect(
      createWorkerJobHandlers(unsafe.dependencies)[name]([
        job('20000000-0000-4000-8000-000000000011', name, payloads[name]),
      ]),
    ).rejects.toThrow('Background job execution failed');
    expect(accessorCalls).toBe(0);

    const trapped = createDependencies({
      executions: {
        async executeOnce() {
          throw new Proxy(new Error('private persistence detail'), {
            getOwnPropertyDescriptor() {
              throw new Error('SENSITIVE_DB_DETAIL');
            },
          });
        },
      },
    });
    let trappedFailure: unknown;
    try {
      await createWorkerJobHandlers(trapped.dependencies)[name]([
        job('20000000-0000-4000-8000-000000000012', name, payloads[name]),
      ]);
    } catch (error) {
      trappedFailure = error;
    }
    expect(trappedFailure).toEqual(
      new Error('Background job execution failed'),
    );
    expect(String(trappedFailure)).not.toContain('SENSITIVE_DB_DETAIL');
  });

  it('explicitly consumes durable notification reconciliation outcomes and rejects malformed results', async () => {
    const name = WORKER_JOB_NAMES.notificationDelivery;
    const first = createDependencies();
    first.dependencies.notifications.deliver = async () => ({
      status: 'requires-reconciliation',
      attemptedChannels: 2,
    });
    await expect(
      createWorkerJobHandlers(first.dependencies)[name]([
        job('20000000-0000-4000-8000-000000000013', name, payloads[name]),
      ]),
    ).resolves.toEqual({ status: 'executed' });

    const malformed = createDependencies();
    malformed.dependencies.notifications.deliver = async () =>
      ({ status: 'ignored', attemptedChannels: 0 }) as never;
    await expect(
      createWorkerJobHandlers(malformed.dependencies)[name]([
        job('20000000-0000-4000-8000-000000000014', name, payloads[name]),
      ]),
    ).rejects.toThrow('Background job execution failed');
  });

  it('binds an operation claim to the canonical payload and rejects conflicting reuse', async () => {
    const claims = new Map<string, string>();
    const { dependencies, calls } = createDependencies({
      executions: {
        async executeOnce(input, operation) {
          const key = `${input.jobName}:${input.operationId}`;
          const existing = claims.get(key);
          if (existing !== undefined) {
            if (existing !== input.payloadHash) throw new Error('conflict');
            return { status: 'duplicate' };
          }
          claims.set(key, input.payloadHash);
          await operation(executionPermit(input));
          return { status: 'executed' };
        },
      },
    });
    const handlers = createWorkerJobHandlers(dependencies);
    const name = WORKER_JOB_NAMES.reminderDelivery;

    await handlers[name]([job(JOB_IDS.reminder, name, payloads[name])]);
    await expect(
      handlers[name]([
        job('20000000-0000-4000-8000-000000000006', name, {
          ...payloads[name],
          reminderId: 'different-reminder',
        }),
      ]),
    ).rejects.toThrow('Background job execution failed');
    expect(calls).toEqual(['reminder:reminder-42:7']);
    expect(claims.get(`${name}:${payloads[name].operationId}`)).toBe(
      hashWorkerJobPayload(name, payloads[name]),
    );
  });

  it('rejects a store permit that is not exactly bound to the active queue job and payload', async () => {
    const name = WORKER_JOB_NAMES.reminderDelivery;
    const { dependencies, calls } = createDependencies({
      executions: {
        async executeOnce(input, operation) {
          await operation({
            ...executionPermit(input),
            queueJobId: '20000000-0000-4000-8000-000000000099',
          });
          return { status: 'executed' };
        },
      },
    });

    await expect(
      createWorkerJobHandlers(dependencies)[name]([
        job(JOB_IDS.reminder, name, payloads[name]),
      ]),
    ).rejects.toThrow('Background job execution failed');
    expect(calls).toEqual([]);

    let accessorCalls = 0;
    const accessor = createDependencies({
      executions: {
        async executeOnce(input, operation) {
          const permit = executionPermit(input);
          await operation(
            Object.defineProperty({ ...permit }, 'leaseToken', {
              enumerable: true,
              get() {
                accessorCalls += 1;
                return permit.leaseToken;
              },
            }) as never,
          );
          return { status: 'executed' };
        },
      },
    });
    await expect(
      createWorkerJobHandlers(accessor.dependencies)[name]([
        job(JOB_IDS.reminder, name, payloads[name]),
      ]),
    ).rejects.toThrow('Background job execution failed');
    expect(accessorCalls).toBe(0);
    expect(accessor.calls).toEqual([]);
  });

  it('rejects invalid batches, mismatched names, and payloads before any dependency call', async () => {
    const { dependencies, calls } = createDependencies();
    const handlers = createWorkerJobHandlers(dependencies);
    const name = WORKER_JOB_NAMES.reminderDelivery;

    await expect(handlers[name]([])).rejects.toThrow(
      'Background job batch is invalid',
    );
    await expect(
      handlers[name]([
        job(JOB_IDS.reminder, WORKER_JOB_NAMES.calendarSync, payloads[name]),
      ]),
    ).rejects.toThrow('Background job batch is invalid');
    await expect(
      handlers[name]([
        job(JOB_IDS.reminder, name, {
          ...payloads[name],
          agentInstruction: 'run the manager',
        }),
      ]),
    ).rejects.toThrow('Background job payload is invalid');
    const reconciliationName = WORKER_JOB_NAMES.calendarReconciliation;
    await expect(
      handlers[reconciliationName]([
        job(JOB_IDS.reconciliation, reconciliationName, {
          ...payloads[reconciliationName],
          providerAttemptId: 'provider-attempt-42',
        }),
      ]),
    ).rejects.toThrow('Background job payload is invalid');
    let accessorCalls = 0;
    const accessorJob = Object.defineProperty(
      {
        id: JOB_IDS.reminder,
        data: payloads[name],
        signal: new AbortController().signal,
      },
      'name',
      {
        enumerable: true,
        get() {
          accessorCalls += 1;
          return name;
        },
      },
    );
    await expect(handlers[name]([accessorJob as never])).rejects.toThrow(
      'Background job batch is invalid',
    );
    expect(accessorCalls).toBe(0);
    expect(calls).toEqual([]);
  });

  it('sanitizes dependency failures so provider or record details cannot enter pg-boss output', async () => {
    const { dependencies } = createDependencies();
    dependencies.calendar.synchronize = async () => {
      throw new Error('private calendar summary and OAuth token');
    };
    const handlers = createWorkerJobHandlers(dependencies);
    const name = WORKER_JOB_NAMES.calendarSync;

    let failure: unknown;
    try {
      await handlers[name]([job(JOB_IDS.calendarSync, name, payloads[name])]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(new Error('Background job execution failed'));
    expect(JSON.stringify(failure)).not.toMatch(/calendar summary|OAuth token/);
  });

  it('enforces an exact dependency allowlist that excludes every agent/model runtime', () => {
    const { dependencies } = createDependencies();
    let agentCalls = 0;
    const unsafe = {
      ...dependencies,
      agentRunner: {
        async run() {
          agentCalls += 1;
        },
      },
    };

    expect(BACKGROUND_JOB_POLICY).toEqual({
      agentExecution: 'forbidden',
      modelExecution: 'forbidden',
      externalApprovalExecution: 'forbidden',
    });
    expect(() => createWorkerJobHandlers(unsafe)).toThrow(
      'Worker dependency boundary is invalid',
    );
    expect(agentCalls).toBe(0);
  });

  it('has no agent, model, or OpenAI runtime dependency in the background deployable', () => {
    const workerRoot = resolve(import.meta.dirname, '..');
    const manifest = JSON.parse(
      readFileSync(resolve(workerRoot, 'package.json'), 'utf8'),
    ) as { readonly dependencies?: Readonly<Record<string, string>> };
    expect(manifest.dependencies).toMatchObject({
      'pg-boss': '12.27.0',
    });
    expect(Object.keys(manifest.dependencies ?? {})).not.toEqual(
      expect.arrayContaining([
        '@emdo/agent-core',
        '@emdo/agent-manager',
        '@openai/agents',
        'openai',
      ]),
    );

    for (const sourceFile of [
      'jobs.ts',
      'main.ts',
      'notifications.ts',
      'reconciliation.ts',
    ]) {
      const source = readFileSync(
        resolve(import.meta.dirname, sourceFile),
        'utf8',
      );
      expect(source).not.toMatch(
        /from\s+['"](?:@emdo\/agent|@openai\/agents|openai)['"]/,
      );
    }
  });
});

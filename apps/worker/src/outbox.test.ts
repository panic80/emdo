import { getEventListeners } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  WORKER_JOB_NAMES,
  enqueueWorkerJob,
  hashWorkerJobPayload,
  resolveWorkerJobQueueBinding,
} from './jobs.js';
import {
  dispatchWorkerOutboxOnce,
  startWorkerOutboxDispatcher,
  waitForWorkerPoll,
  type WorkerOutboxRepository,
} from './outbox.js';

const OUTBOX_ID = '10000000-0000-4000-8000-000000000001';
const LEASE_TOKEN = '10000000-0000-4000-8000-000000000002';

const reminderPayload = {
  schemaVersion: 1,
  origin: 'deterministic-worker',
  operationId: 'reminder-operation:0001',
  reminderId: 'reminder-42',
  dueRevision: 7,
} as const;
const REMINDER_PAYLOAD_HASH = hashWorkerJobPayload(
  WORKER_JOB_NAMES.reminderDelivery,
  reminderPayload,
);
const REMINDER_QUEUE_JOB_ID = resolveWorkerJobQueueBinding(
  WORKER_JOB_NAMES.reminderDelivery,
  reminderPayload,
).queueJobId;

describe('durable worker outbox dispatcher', () => {
  it('removes its abort listener after each completed poll wait', async () => {
    const controller = new AbortController();

    for (let iteration = 0; iteration < 12; iteration += 1) {
      await waitForWorkerPoll(1, controller.signal);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
  });

  it('claims due rows and durably records enqueued and singleton-duplicate dispositions', async () => {
    const calls: unknown[] = [];
    let enqueueCount = 0;
    const repository: WorkerOutboxRepository = {
      async listDue(input) {
        calls.push({ kind: 'list', input });
        return [
          {
            outboxId: OUTBOX_ID,
            jobName: WORKER_JOB_NAMES.reminderDelivery,
            payload: reminderPayload,
            payloadHash: REMINDER_PAYLOAD_HASH,
            startAfter: '2026-08-10T13:00:00.000Z',
            leaseToken: LEASE_TOKEN,
          },
          {
            outboxId: '10000000-0000-4000-8000-000000000003',
            jobName: WORKER_JOB_NAMES.reminderDelivery,
            payload: {
              ...reminderPayload,
              operationId: 'reminder-operation:0002',
            },
            payloadHash: hashWorkerJobPayload(
              WORKER_JOB_NAMES.reminderDelivery,
              {
                ...reminderPayload,
                operationId: 'reminder-operation:0002',
              },
            ),
            startAfter: null,
            leaseToken: '10000000-0000-4000-8000-000000000004',
          },
        ];
      },
      async bindQueueJob(input) {
        calls.push({ kind: 'bound', input });
      },
      async markEnqueued(input) {
        calls.push({ kind: 'enqueued', input });
      },
      async markDispatchFailed(input) {
        calls.push({ kind: 'failed', input });
      },
    };
    const signal = new AbortController().signal;

    await expect(
      dispatchWorkerOutboxOnce({
        repository,
        dispatcherId: 'worker-dispatcher-1',
        now: new Date('2026-08-10T12:00:00.000Z'),
        limit: 10,
        leaseMs: 30_000,
        signal,
        async enqueue(_name, _payload, options) {
          enqueueCount += 1;
          if (enqueueCount === 1) {
            expect(options?.startAfter).toEqual(
              new Date('2026-08-10T13:00:00.000Z'),
            );
            return { status: 'enqueued', jobId: REMINDER_QUEUE_JOB_ID };
          }
          expect(options).toBeUndefined();
          const secondJobId = resolveWorkerJobQueueBinding(
            WORKER_JOB_NAMES.reminderDelivery,
            {
              ...reminderPayload,
              operationId: 'reminder-operation:0002',
            },
          ).queueJobId;
          return {
            status: 'duplicate',
            jobId: secondJobId,
          };
        },
      }),
    ).resolves.toEqual({ claimed: 2, dispatched: 2, deferred: 0 });

    expect(
      calls.filter((call) => (call as { kind: string }).kind === 'enqueued'),
    ).toEqual([
      {
        kind: 'enqueued',
        input: expect.objectContaining({
          outboxId: OUTBOX_ID,
          leaseToken: LEASE_TOKEN,
          queueJobId: REMINDER_QUEUE_JOB_ID,
        }),
      },
      {
        kind: 'enqueued',
        input: expect.objectContaining({
          outboxId: '10000000-0000-4000-8000-000000000003',
          queueJobId: resolveWorkerJobQueueBinding(
            WORKER_JOB_NAMES.reminderDelivery,
            {
              ...reminderPayload,
              operationId: 'reminder-operation:0002',
            },
          ).queueJobId,
        }),
      },
    ]);
    expect(
      calls.some((call) => (call as { kind: string }).kind === 'failed'),
    ).toBe(false);
    expect(calls.map((call) => (call as { kind: string }).kind)).toEqual([
      'list',
      'bound',
      'enqueued',
      'bound',
      'enqueued',
    ]);
  });

  it('quarantines malformed names and payload-hash mismatches individually while continuing the batch', async () => {
    const failures: unknown[] = [];
    let enqueueCalls = 0;
    const repository: WorkerOutboxRepository = {
      async listDue() {
        return [
          {
            outboxId: OUTBOX_ID,
            jobName: 'emdo.unknown.poison.v1',
            payload: reminderPayload,
            payloadHash: REMINDER_PAYLOAD_HASH,
            startAfter: null,
            leaseToken: LEASE_TOKEN,
          },
          {
            outboxId: '10000000-0000-4000-8000-000000000003',
            jobName: WORKER_JOB_NAMES.reminderDelivery,
            payload: reminderPayload,
            payloadHash: 'f'.repeat(64),
            startAfter: null,
            leaseToken: '10000000-0000-4000-8000-000000000004',
          },
          {
            outboxId: '10000000-0000-4000-8000-000000000005',
            jobName: WORKER_JOB_NAMES.reminderDelivery,
            payload: {
              ...reminderPayload,
              operationId: 'reminder-operation:0003',
            },
            payloadHash: hashWorkerJobPayload(
              WORKER_JOB_NAMES.reminderDelivery,
              {
                ...reminderPayload,
                operationId: 'reminder-operation:0003',
              },
            ),
            startAfter: null,
            leaseToken: '10000000-0000-4000-8000-000000000006',
          },
        ];
      },
      async bindQueueJob() {},
      async markEnqueued() {
        throw new Error('must not enqueue');
      },
      async markDispatchFailed(input) {
        failures.push(input);
      },
    };

    await expect(
      dispatchWorkerOutboxOnce({
        repository,
        dispatcherId: 'worker-dispatcher-1',
        now: new Date('2026-08-10T12:00:00.000Z'),
        limit: 10,
        leaseMs: 30_000,
        signal: new AbortController().signal,
        async enqueue() {
          enqueueCalls += 1;
          throw new Error('private queue connection detail');
        },
      }),
    ).resolves.toEqual({ claimed: 3, dispatched: 0, deferred: 3 });

    expect(enqueueCalls).toBe(1);
    expect(failures).toEqual([
      expect.objectContaining({
        outboxId: OUTBOX_ID,
        safeCode: 'invalid-operation',
      }),
      expect.objectContaining({
        outboxId: '10000000-0000-4000-8000-000000000003',
        safeCode: 'invalid-operation',
      }),
    ]);
    for (const failure of failures as Array<{
      failedAt: Date;
      nextAttemptAt: Date;
      signal: AbortSignal;
    }>) {
      expect(failure.nextAttemptAt.getTime() - failure.failedAt.getTime()).toBe(
        30_000,
      );
      expect(failure.signal.aborted).toBe(false);
    }
  });

  it('quarantines a null-send whose queue readback is not the exact canonical job', async () => {
    const events: string[] = [];
    const repository: WorkerOutboxRepository = {
      async listDue() {
        return [
          {
            outboxId: OUTBOX_ID,
            jobName: WORKER_JOB_NAMES.reminderDelivery,
            payload: reminderPayload,
            payloadHash: REMINDER_PAYLOAD_HASH,
            startAfter: null,
            leaseToken: LEASE_TOKEN,
          },
        ];
      },
      async bindQueueJob() {
        events.push('bound');
      },
      async markEnqueued() {
        events.push('enqueued');
      },
      async markDispatchFailed(input) {
        events.push(`failed:${input.safeCode}`);
      },
    };

    await expect(
      dispatchWorkerOutboxOnce({
        repository,
        dispatcherId: 'worker-dispatcher-1',
        now: new Date('2026-08-10T12:00:00.000Z'),
        limit: 10,
        leaseMs: 30_000,
        signal: new AbortController().signal,
        enqueue: (name, payload, options) =>
          enqueueWorkerJob(
            {
              async send() {
                return null;
              },
              async getJobById() {
                return {
                  id: REMINDER_QUEUE_JOB_ID,
                  name,
                  data: { ...reminderPayload, dueRevision: 99 },
                  singletonKey: 'f'.repeat(64),
                  state: 'completed',
                } as never;
              },
            },
            name,
            payload,
            options,
          ),
      }),
    ).resolves.toEqual({ claimed: 1, dispatched: 0, deferred: 1 });
    expect(events).toEqual(['bound', 'failed:invalid-operation']);
  });

  it('retries an ambiguous exact bind and never marks a bound row queue-unavailable', async () => {
    const events: string[] = [];
    let bindCalls = 0;
    const repository: WorkerOutboxRepository = {
      async listDue() {
        return [
          {
            outboxId: OUTBOX_ID,
            jobName: WORKER_JOB_NAMES.reminderDelivery,
            payload: reminderPayload,
            payloadHash: REMINDER_PAYLOAD_HASH,
            startAfter: null,
            leaseToken: LEASE_TOKEN,
          },
        ];
      },
      async bindQueueJob() {
        bindCalls += 1;
        events.push(`bind:${bindCalls}`);
        if (bindCalls === 1) throw new Error('response lost after bind');
      },
      async markEnqueued() {
        events.push('enqueued');
      },
      async markDispatchFailed(input) {
        events.push(`failed:${input.safeCode}`);
      },
    };

    await expect(
      dispatchWorkerOutboxOnce({
        repository,
        dispatcherId: 'worker-dispatcher-1',
        now: new Date('2026-08-10T12:00:00.000Z'),
        limit: 10,
        leaseMs: 30_000,
        signal: new AbortController().signal,
        async enqueue() {
          events.push('enqueue');
          return { status: 'enqueued', jobId: REMINDER_QUEUE_JOB_ID };
        },
      }),
    ).resolves.toEqual({ claimed: 1, dispatched: 1, deferred: 0 });
    expect(events).toEqual(['bind:1', 'bind:2', 'enqueue', 'enqueued']);
  });

  it('keeps an ambiguously dispatched bound row leased for exact recovery', async () => {
    for (const readback of ['absent', 'unavailable'] as const) {
      const events: string[] = [];
      const repository: WorkerOutboxRepository = {
        async listDue() {
          return [
            {
              outboxId: OUTBOX_ID,
              jobName: WORKER_JOB_NAMES.reminderDelivery,
              payload: reminderPayload,
              payloadHash: REMINDER_PAYLOAD_HASH,
              startAfter: null,
              leaseToken: LEASE_TOKEN,
            },
          ];
        },
        async bindQueueJob() {
          events.push('bound');
        },
        async markEnqueued() {
          events.push('enqueued');
        },
        async markDispatchFailed(input) {
          events.push(`failed:${input.safeCode}`);
        },
      };

      await expect(
        dispatchWorkerOutboxOnce({
          repository,
          dispatcherId: 'worker-dispatcher-1',
          now: new Date('2026-08-10T12:00:00.000Z'),
          limit: 10,
          leaseMs: 30_000,
          signal: new AbortController().signal,
          enqueue: (name, payload, options) =>
            enqueueWorkerJob(
              {
                async send() {
                  throw new Error('connection closed after an unknown outcome');
                },
                async getJobById() {
                  if (readback === 'unavailable') {
                    throw new Error('queue readback unavailable');
                  }
                  return null;
                },
              },
              name,
              payload,
              options,
            ),
        }),
      ).resolves.toEqual({ claimed: 1, dispatched: 0, deferred: 1 });
      expect(events).toEqual(['bound']);
    }
  });

  it('gates startup on an initial claim and reports later poll failures as fatal', async () => {
    let polls = 0;
    let releaseWait: (() => void) | undefined;
    const fatal: string[] = [];
    const repository: WorkerOutboxRepository = {
      async listDue() {
        polls += 1;
        if (polls === 1) return [];
        throw new Error('private database outage');
      },
      async bindQueueJob() {},
      async markEnqueued() {},
      async markDispatchFailed() {},
    };
    const dispatcher = await startWorkerOutboxDispatcher({
      repository,
      async enqueue() {
        return {
          status: 'duplicate',
          jobId: '20000000-0000-4000-8000-000000000001',
        };
      },
      dispatcherId: 'worker-dispatcher-1',
      pollIntervalMs: 1_000,
      batchLimit: 10,
      leaseMs: 30_000,
      signal: new AbortController().signal,
      clock: () => new Date('2026-08-10T12:00:00.000Z'),
      wait: async () =>
        new Promise<void>((resolve) => {
          releaseWait = resolve;
        }),
      onFatalError() {
        fatal.push('fatal');
      },
    });
    expect(polls).toBe(1);

    releaseWait?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(polls).toBe(2);
    expect(fatal).toEqual(['fatal']);
    await dispatcher.stop();
    await dispatcher.stop();
  });

  it('does not report an abort-aware wait rejection as fatal during shutdown', async () => {
    const fatal: string[] = [];
    const dispatcher = await startWorkerOutboxDispatcher({
      repository: {
        async listDue() {
          return [];
        },
        async bindQueueJob() {},
        async markEnqueued() {},
        async markDispatchFailed() {},
      },
      async enqueue() {
        return {
          status: 'duplicate',
          jobId: '20000000-0000-4000-8000-000000000001',
        };
      },
      dispatcherId: 'worker-dispatcher-1',
      pollIntervalMs: 1_000,
      batchLimit: 10,
      leaseMs: 30_000,
      signal: new AbortController().signal,
      wait: async (_milliseconds, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('expected shutdown abort')),
            { once: true },
          );
        }),
      onFatalError() {
        fatal.push('fatal');
      },
    });

    await dispatcher.stop();
    expect(fatal).toEqual([]);
  });

  it('stops even when an injected poll wait does not cooperate with abort', async () => {
    const dispatcher = await startWorkerOutboxDispatcher({
      repository: {
        async listDue() {
          return [];
        },
        async bindQueueJob() {},
        async markEnqueued() {},
        async markDispatchFailed() {},
      },
      async enqueue() {
        return {
          status: 'duplicate',
          jobId: '20000000-0000-4000-8000-000000000001',
        };
      },
      dispatcherId: 'worker-dispatcher-1',
      pollIntervalMs: 1_000,
      batchLimit: 10,
      leaseMs: 30_000,
      signal: new AbortController().signal,
      wait: async () => new Promise<void>(() => {}),
      onFatalError() {
        throw new Error('must not report shutdown as fatal');
      },
    });

    const disposition = await Promise.race([
      dispatcher.stop().then(() => 'stopped' as const),
      new Promise<'timed-out'>((resolve) => {
        setTimeout(() => resolve('timed-out'), 50).unref();
      }),
    ]);
    expect(disposition).toBe('stopped');
  });
});

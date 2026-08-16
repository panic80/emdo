import { setTimeout as delay } from 'node:timers/promises';

import { Sha256Schema, UuidSchema, deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

import {
  isWorkerQueueBindingError,
  isWorkerQueueDispatchIndeterminateError,
  resolveWorkerJobQueueBinding,
  type WorkerJobEnqueueResult,
  type WorkerJobName,
  type WorkerJobSchedulingOptions,
} from './jobs.js';

const DispatchItemSchema = z.strictObject({
  outboxId: UuidSchema,
  jobName: z.string().trim().min(1).max(200),
  payload: z.unknown(),
  payloadHash: Sha256Schema,
  startAfter: z.iso.datetime({ offset: true }).nullable(),
  leaseToken: UuidSchema,
});

const DispatchIdentitySchema = z.looseObject({
  outboxId: UuidSchema,
  leaseToken: UuidSchema,
});

type DispatchIdentity = z.output<typeof DispatchIdentitySchema>;

export interface WorkerOutboxRepository {
  listDue(input: {
    readonly dispatcherId: string;
    readonly now: Date;
    readonly limit: number;
    readonly leaseMs: number;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  bindQueueJob(input: {
    readonly outboxId: string;
    readonly leaseToken: string;
    readonly queueJobId: string;
    readonly payloadHash: string;
    readonly boundAt: Date;
    readonly signal: AbortSignal;
  }): Promise<void>;
  markEnqueued(input: {
    readonly outboxId: string;
    readonly leaseToken: string;
    readonly queueJobId: string;
    readonly enqueuedAt: Date;
    readonly signal: AbortSignal;
  }): Promise<void>;
  markDispatchFailed(input: {
    readonly outboxId: string;
    readonly leaseToken: string;
    readonly failedAt: Date;
    readonly nextAttemptAt: Date;
    readonly safeCode: 'queue-unavailable' | 'invalid-operation';
    readonly signal: AbortSignal;
  }): Promise<void>;
}

export interface WorkerOutboxEnqueue {
  (
    name: WorkerJobName,
    payload: unknown,
    options?: WorkerJobSchedulingOptions,
  ): Promise<WorkerJobEnqueueResult>;
}

export interface WorkerOutboxDispatcherHandle {
  stop(): Promise<void>;
}

const cleanupSignal = (): AbortSignal => AbortSignal.timeout(5_000);

const deferDispatch = async (
  repository: WorkerOutboxRepository,
  item: DispatchIdentity,
  now: Date,
  safeCode: 'queue-unavailable' | 'invalid-operation',
): Promise<void> => {
  await repository.markDispatchFailed({
    outboxId: item.outboxId,
    leaseToken: item.leaseToken,
    failedAt: new Date(now.getTime()),
    nextAttemptAt: new Date(now.getTime() + 30_000),
    safeCode,
    signal: cleanupSignal(),
  });
};

export const dispatchWorkerOutboxOnce = async (input: {
  readonly repository: WorkerOutboxRepository;
  readonly enqueue: WorkerOutboxEnqueue;
  readonly dispatcherId: string;
  readonly now: Date;
  readonly limit: number;
  readonly leaseMs: number;
  readonly signal: AbortSignal;
}): Promise<{
  readonly claimed: number;
  readonly dispatched: number;
  readonly deferred: number;
}> => {
  input.signal.throwIfAborted();
  const rawItems = await input.repository.listDue({
    dispatcherId: input.dispatcherId,
    now: new Date(input.now.getTime()),
    limit: input.limit,
    leaseMs: input.leaseMs,
    signal: input.signal,
  });
  if (!Array.isArray(rawItems) || rawItems.length > input.limit) {
    throw new Error('Worker outbox returned invalid operations');
  }

  let dispatched = 0;
  let deferred = 0;
  for (const rawItem of rawItems) {
    const identity = DispatchIdentitySchema.safeParse(rawItem);
    if (!identity.success) {
      throw new Error('Worker outbox returned invalid operations');
    }
    const parsedItem = DispatchItemSchema.safeParse(rawItem);
    if (!parsedItem.success) {
      await deferDispatch(
        input.repository,
        identity.data,
        input.now,
        'invalid-operation',
      );
      deferred += 1;
      continue;
    }
    const item = parsedItem.data;
    let options: WorkerJobSchedulingOptions | undefined;
    let binding: ReturnType<typeof resolveWorkerJobQueueBinding>;
    try {
      binding = resolveWorkerJobQueueBinding(
        item.jobName as WorkerJobName,
        item.payload,
      );
      if (binding.payloadHash !== item.payloadHash) throw new Error('invalid');
      options =
        item.startAfter === null
          ? undefined
          : { startAfter: new Date(item.startAfter) };
    } catch {
      await deferDispatch(
        input.repository,
        item,
        input.now,
        'invalid-operation',
      );
      deferred += 1;
      continue;
    }

    const queueBinding = {
      outboxId: item.outboxId,
      leaseToken: item.leaseToken,
      queueJobId: binding.queueJobId,
      payloadHash: binding.payloadHash,
      boundAt: new Date(input.now.getTime()),
    } as const;
    let bound = false;
    try {
      await input.repository.bindQueueJob({
        ...queueBinding,
        signal: input.signal,
      });
      bound = true;
    } catch {
      // The first call may have committed before its response was lost. Retry
      // the same immutable binding; never translate ambiguity into absence.
      try {
        await input.repository.bindQueueJob({
          ...queueBinding,
          signal: cleanupSignal(),
        });
        bound = true;
      } catch {
        bound = false;
      }
    }
    if (!bound) {
      deferred += 1;
      continue;
    }
    input.signal.throwIfAborted();

    let result: WorkerJobEnqueueResult;
    try {
      result = await input.enqueue(item.jobName, item.payload, options);
    } catch (error) {
      if (
        isWorkerQueueDispatchIndeterminateError(error) ||
        !isWorkerQueueBindingError(error)
      ) {
        // The immutable queue binding stays leased. Reclaiming the expired
        // lease retries the same canonical queue id and resolves by readback.
        deferred += 1;
        continue;
      }
      await deferDispatch(
        input.repository,
        item,
        input.now,
        'invalid-operation',
      );
      deferred += 1;
      continue;
    }
    if (result.jobId !== binding.queueJobId) {
      await deferDispatch(
        input.repository,
        item,
        input.now,
        'invalid-operation',
      );
      deferred += 1;
      continue;
    }
    await input.repository.markEnqueued({
      outboxId: item.outboxId,
      leaseToken: item.leaseToken,
      queueJobId: result.jobId,
      enqueuedAt: new Date(input.now.getTime()),
      signal: cleanupSignal(),
    });
    dispatched += 1;
  }

  return deepFreeze({
    claimed: rawItems.length,
    dispatched,
    deferred,
  });
};

export const waitForWorkerPoll = async (
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) return;
  try {
    await delay(milliseconds, undefined, { signal, ref: false });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
};

const waitForPollOrAbort = async (
  wait: Promise<void>,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) return;
  let resolveAbort: (() => void) | undefined;
  const abort = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = (): void => resolveAbort?.();
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    await Promise.race([wait, abort]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};

export const startWorkerOutboxDispatcher = async (input: {
  readonly repository: WorkerOutboxRepository;
  readonly enqueue: WorkerOutboxEnqueue;
  readonly dispatcherId: string;
  readonly pollIntervalMs: number;
  readonly batchLimit: number;
  readonly leaseMs: number;
  readonly signal: AbortSignal;
  readonly clock?: () => Date;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly onFatalError: () => void;
}): Promise<WorkerOutboxDispatcherHandle> => {
  if (
    !Number.isSafeInteger(input.pollIntervalMs) ||
    input.pollIntervalMs < 250 ||
    input.pollIntervalMs > 60_000 ||
    !Number.isSafeInteger(input.batchLimit) ||
    input.batchLimit < 1 ||
    input.batchLimit > 100 ||
    !Number.isSafeInteger(input.leaseMs) ||
    input.leaseMs < 1_000 ||
    input.leaseMs > 300_000 ||
    typeof input.onFatalError !== 'function'
  ) {
    throw new Error('Worker outbox dispatcher configuration is invalid');
  }
  const localAbort = new AbortController();
  const signal = AbortSignal.any([input.signal, localAbort.signal]);
  const clock = input.clock ?? (() => new Date());
  const wait = input.wait ?? waitForWorkerPoll;
  const runCycle = () =>
    dispatchWorkerOutboxOnce({
      repository: input.repository,
      enqueue: input.enqueue,
      dispatcherId: input.dispatcherId,
      now: clock(),
      limit: input.batchLimit,
      leaseMs: input.leaseMs,
      signal,
    });

  try {
    await runCycle();
  } catch {
    localAbort.abort(new Error('Worker outbox dispatcher failed'));
    throw new Error('Worker outbox dispatcher failed to start');
  }

  const loop = (async () => {
    try {
      while (!signal.aborted) {
        await waitForPollOrAbort(
          Promise.resolve().then(() => wait(input.pollIntervalMs, signal)),
          signal,
        );
        if (signal.aborted) return;
        await runCycle();
      }
    } catch {
      if (signal.aborted) return;
      localAbort.abort(new Error('Worker outbox dispatcher failed'));
      try {
        input.onFatalError();
      } catch {
        // The process lifecycle still observes the stopped dispatcher.
      }
    }
  })();

  let stopPromise: Promise<void> | undefined;
  return Object.freeze({
    stop(): Promise<void> {
      localAbort.abort(new Error('Worker outbox dispatcher is stopping'));
      stopPromise ??= loop;
      return stopPromise;
    },
  });
};

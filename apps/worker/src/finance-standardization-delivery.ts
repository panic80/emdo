import { setTimeout as pause } from 'node:timers/promises';
import type { PgBossCompatible, PgBossJob } from './jobs.js';
import {
  FINANCE_STANDARDIZATION_QUEUE,
  FinanceStandardizationJobSchema,
  standardizationQueueId,
  type createFinanceStandardizationWorker,
} from './finance-standardization-worker.js';
export interface StandardizationDelivery {
  runId: string;
  deliveryRevision: number;
  token: string;
}
export type StandardizationEnqueue = (
  delivery: StandardizationDelivery,
  signal?: AbortSignal,
) => Promise<boolean>;
/**
 * Reconciles one bounded provider-receipt lookup. The implementation must use
 * the fixed executor boundary; this is deliberately not exposed as an app RPC.
 */
export type StandardizationReceiptReconciler = (
  signal?: AbortSignal,
) => Promise<void>;
export interface StandardizationDeliveryStore {
  claim(limit?: number): Promise<StandardizationDelivery[]>;
  /**
   * Retained for compatibility with callers of the original delivery API.
   * Production dispatch no longer acknowledges at enqueue time: the worker's
   * database claim clears delivery_pending atomically with its lease.
   */
  acknowledge(delivery: StandardizationDelivery): Promise<boolean>;
}
export async function registerStandardizationWorker(
  boss: Pick<PgBossCompatible, 'createQueue' | 'work'>,
  dispatch: ReturnType<typeof createFinanceStandardizationWorker>,
) {
  await boss.createQueue(FINANCE_STANDARDIZATION_QUEUE, {
    retryLimit: 0,
    expireInSeconds: 180,
    retentionSeconds: 2592000,
    deleteAfterSeconds: 604800,
  });
  return boss.work(
    FINANCE_STANDARDIZATION_QUEUE,
    { batchSize: 1, localConcurrency: 1 },
    async (jobs: readonly PgBossJob[]) => {
      const job = jobs[0];
      if (
        jobs.length !== 1 ||
        !job ||
        job.name !== FINANCE_STANDARDIZATION_QUEUE ||
        !(job.signal instanceof AbortSignal)
      )
        throw new Error('standardization-invalid-delivery');
      const payload = FinanceStandardizationJobSchema.parse(job.data);
      if (
        job.id !==
        standardizationQueueId(
          payload.runId,
          payload.deliveryRevision,
          payload.deliveryToken,
        )
      )
        throw new Error('standardization-delivery-identity-mismatch');
      return dispatch(payload, job.signal);
    },
  );
}
async function sendStandardization(
  boss: Pick<PgBossCompatible, 'send' | 'getJobById'>,
  delivery: StandardizationDelivery,
  signal?: AbortSignal,
) {
  const payload = FinanceStandardizationJobSchema.parse({
      schemaVersion: 1,
      runId: delivery.runId,
      deliveryRevision: delivery.deliveryRevision,
      deliveryToken: delivery.token,
    }),
    id = standardizationQueueId(
      payload.runId,
      payload.deliveryRevision,
      payload.deliveryToken,
    );
  if (signal?.aborted) return false;
  try {
    const sent = await boss.send(FINANCE_STANDARDIZATION_QUEUE, payload, {
      id,
      singletonKey: id,
      singletonSeconds: 2592000,
      retryLimit: 0,
      expireInSeconds: 180,
    });
    if (sent === id && !signal?.aborted) return true;
  } catch {
    /* Resolve uncertain enqueue only by exact stable-identity readback. */
  }
  if (signal?.aborted) return false;
  try {
    const saved = await boss.getJobById(FINANCE_STANDARDIZATION_QUEUE, id);
    return (
      saved?.id === id &&
      saved.name === FINANCE_STANDARDIZATION_QUEUE &&
      saved.singletonKey === id &&
      JSON.stringify(FinanceStandardizationJobSchema.parse(saved.data)) ===
        JSON.stringify(payload) &&
      ['created', 'retry', 'active', 'completed'].includes(saved.state)
    );
  } catch {
    return false;
  }
}
export async function enqueueStandardization(
  boss: Pick<PgBossCompatible, 'send' | 'getJobById'>,
  delivery: StandardizationDelivery,
  parent?: AbortSignal,
) {
  const controller = new AbortController(),
    signal = parent
      ? AbortSignal.any([parent, controller.signal])
      : controller.signal;
  if (signal.aborted) return false;
  let aborted = () => {};
  const stopped = new Promise<false>((resolve) => {
    aborted = () => resolve(false);
    signal.addEventListener('abort', aborted, { once: true });
  });
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    return await Promise.race([
      sendStandardization(boss, delivery, signal).catch(() => false),
      stopped,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', aborted);
    controller.abort();
  }
}
/**
 * Dispatch one bounded batch. A successful broker enqueue is intentionally not
 * a database acknowledgement: only claim_finance_standardization can clear
 * delivery_pending after acquiring the run lease. If the job is accepted but
 * never claimed, the database delivery token expires and the next batch gets a
 * fresh token and broker identity.
 */
export async function dispatchStandardizationDeliveries(input: {
  repository: Pick<StandardizationDeliveryStore, 'claim'>;
  enqueue: StandardizationEnqueue;
  reconcileReceipts?: StandardizationReceiptReconciler;
  signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  if (input.reconcileReceipts) {
    try {
      await input.reconcileReceipts(input.signal);
    } catch {
      // A missing or unavailable provider receipt is inconclusive. The
      // reconciler owns its durable retry lease; delivery must keep polling.
    }
    if (input.signal.aborted) return;
  }
  for (const delivery of await input.repository.claim(10)) {
    if (input.signal.aborted) return;
    try {
      await input.enqueue(delivery, input.signal);
    } catch {
      // Keep delivery_pending set. The database lease is the retry boundary.
    }
  }
}
export function startStandardizationDeliveryDispatcher(input: {
  repository: StandardizationDeliveryStore;
  enqueue: StandardizationEnqueue;
  reconcileReceipts?: StandardizationReceiptReconciler;
  signal: AbortSignal;
  onFatalError(error: unknown): void;
}) {
  const own = new AbortController(),
    signal = AbortSignal.any([input.signal, own.signal]);
  const run = (async () => {
    try {
      while (!signal.aborted) {
        await dispatchStandardizationDeliveries({
          repository: input.repository,
          enqueue: input.enqueue,
          reconcileReceipts: input.reconcileReceipts,
          signal,
        });
        await pause(1000, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) input.onFatalError(error);
    }
  })();
  return {
    async stop() {
      own.abort();
      await run;
    },
  };
}

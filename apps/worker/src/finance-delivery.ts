import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import {
  FinanceDeliverySchema,
  type FinanceDelivery,
  type PostgresFinanceDeliveryRepository,
} from '@emdo/db/worker';
import {
  FINANCE_AUTOMATION_QUEUE,
  FinanceAutomationJobSchema,
  financeAutomationQueueJobId,
} from './finance-automation-worker.js';
import type { PgBossCompatible } from './jobs.js';
export type FinanceDeliveryEnqueue = (
  delivery: FinanceDelivery,
  signal?: AbortSignal,
) => Promise<'enqueued' | 'indeterminate' | 'quarantined'>;
export function financeDeliveryPayload(
  delivery: Pick<FinanceDelivery, 'operationId' | 'deliveryRevision'>,
) {
  // Ordered to match the database-owned canonical hash, independent of JSONB formatting.
  return {
    deliveryRevision: delivery.deliveryRevision,
    operationId: delivery.operationId,
    origin: 'emdo-managed' as const,
    schemaVersion: 1 as const,
  };
}
export const financeDeliveryPayloadHash = (
  delivery: Pick<FinanceDelivery, 'operationId' | 'deliveryRevision'>,
) =>
  createHash('sha256')
    .update(JSON.stringify(financeDeliveryPayload(delivery)))
    .digest('hex');
/** One 10-second budget covers send plus readback, inside the 30-second DB
 * lease. Timed-out work cannot acknowledge later; a late broker acceptance uses
 * the same identity when the durable lease is reclaimed. */
async function boundedEnqueue(
  operation: (signal: AbortSignal) => ReturnType<FinanceDeliveryEnqueue>,
  parent?: AbortSignal,
): ReturnType<FinanceDeliveryEnqueue> {
  const controller = new AbortController();
  const signal = parent
    ? AbortSignal.any([parent, controller.signal])
    : controller.signal;
  if (signal.aborted) return 'indeterminate';
  let finish: () => void = () => {};
  const aborted = new Promise<'indeterminate'>((resolve) => {
    finish = () => resolve('indeterminate');
    signal.addEventListener('abort', finish, { once: true });
  });
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    return await Promise.race([
      operation(signal).catch(() => 'indeterminate' as const),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', finish);
  }
}
export function enqueueFinanceDelivery(
  boss: Pick<PgBossCompatible, 'send' | 'getJobById'>,
  input: FinanceDelivery,
  signal?: AbortSignal,
): ReturnType<FinanceDeliveryEnqueue> {
  return boundedEnqueue(
    (deadline) => sendFinanceDelivery(boss, input, deadline),
    signal,
  );
}
async function sendFinanceDelivery(
  boss: Pick<PgBossCompatible, 'send' | 'getJobById'>,
  input: FinanceDelivery,
  signal: AbortSignal,
): ReturnType<FinanceDeliveryEnqueue> {
  const d = FinanceDeliverySchema.parse(input);
  if (
    d.id !== financeAutomationQueueJobId(d.operationId, d.deliveryRevision) ||
    d.payloadHash !== financeDeliveryPayloadHash(d)
  )
    return 'quarantined';
  const payload = financeDeliveryPayload(d);
  try {
    const sent = await boss.send(FINANCE_AUTOMATION_QUEUE, payload, {
      id: d.id,
      singletonKey: d.id,
      singletonSeconds: 2592000,
      retryLimit: 0,
      expireInSeconds: 120,
    });
    if (signal.aborted) return 'indeterminate';
    if (sent === d.id) return 'enqueued';
    if (sent !== null) return 'quarantined';
  } catch {
    /* Transport uncertainty requires exact readback, never a new ID. */
  }
  if (signal.aborted) return 'indeterminate';
  try {
    const job = await boss.getJobById(FINANCE_AUTOMATION_QUEUE, d.id);
    if (job === null) return 'indeterminate';
    const parsed = FinanceAutomationJobSchema.safeParse(job.data);
    if (
      job.id !== d.id ||
      job.name !== FINANCE_AUTOMATION_QUEUE ||
      job.singletonKey !== d.id ||
      !parsed.success ||
      financeDeliveryPayloadHash(parsed.data) !== d.payloadHash
    )
      return 'quarantined';
    return ['created', 'retry', 'active', 'completed'].includes(job.state)
      ? 'enqueued'
      : 'quarantined';
  } catch {
    return 'indeterminate';
  }
}
export type FinanceDeliveryStore = Pick<
  PostgresFinanceDeliveryRepository,
  'claim' | 'acknowledge' | 'reconcileStalled'
>;
export async function dispatchFinanceDeliveries(input: {
  repository: FinanceDeliveryStore;
  enqueue: FinanceDeliveryEnqueue;
  signal: AbortSignal;
}): Promise<void> {
  input.signal.throwIfAborted();
  await input.repository.reconcileStalled(5);
  input.signal.throwIfAborted();
  const deliveries = await input.repository.claim(1);
  if (deliveries.length > 1) throw new Error('Invalid Finance delivery batch');
  for (const delivery of deliveries) {
    if (input.signal.aborted) return;
    let disposition: Awaited<ReturnType<FinanceDeliveryEnqueue>>;
    try {
      disposition = await boundedEnqueue(
        (signal) => input.enqueue(delivery, signal),
        input.signal,
      );
    } catch {
      continue;
    }
    if (disposition === 'indeterminate' || input.signal.aborted) continue;
    // Lost acknowledgement leaves the stable binding reclaimable after its lease.
    try {
      await input.repository.acknowledge(delivery, disposition);
    } catch {
      /* Reclaim the same identity. */
    }
  }
}
export function startFinanceDeliveryDispatcher(input: {
  repository: FinanceDeliveryStore;
  enqueue: FinanceDeliveryEnqueue;
  signal: AbortSignal;
  onFatalError: () => void;
}) {
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const running = (async () => {
    while (!signal.aborted) {
      try {
        await dispatchFinanceDeliveries({ ...input, signal });
      } catch {
        if (!signal.aborted) {
          input.onFatalError();
          return;
        }
      }
      try {
        await pause(1000, undefined, { signal });
      } catch {
        return;
      }
    }
  })();
  return {
    async stop() {
      controller.abort();
      await running;
    },
  };
}

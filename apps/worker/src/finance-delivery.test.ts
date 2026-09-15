import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FinanceDelivery } from '@emdo/db/worker';
import type { PgBossCompatible } from './jobs.js';
import {
  FINANCE_AUTOMATION_QUEUE,
  financeAutomationQueueJobId,
} from './finance-automation-worker.js';
import {
  dispatchFinanceDeliveries,
  enqueueFinanceDelivery,
  financeDeliveryPayload,
  financeDeliveryPayloadHash,
} from './finance-delivery.js';
const fixture = (): FinanceDelivery => {
  const operationId = randomUUID(),
    deliveryRevision = 1;
  return {
    id: financeAutomationQueueJobId(operationId, deliveryRevision),
    operationId,
    deliveryRevision,
    payloadHash: financeDeliveryPayloadHash({ operationId, deliveryRevision }),
    leaseToken: randomUUID(),
  };
};
const transport = (send: unknown, job: unknown) =>
  ({
    send: vi.fn(async () => {
      if (send instanceof Error) throw send;
      return send;
    }),
    getJobById: vi.fn(async () => job),
  }) as unknown as Pick<PgBossCompatible, 'send' | 'getJobById'>;
describe('Finance durable delivery transport', () => {
  it('keeps lost send responses bound to an exact persisted job', async () => {
    const d = fixture();
    const boss = transport(new Error('lost'), {
      id: d.id,
      name: FINANCE_AUTOMATION_QUEUE,
      singletonKey: d.id,
      data: financeDeliveryPayload(d),
      state: 'created',
    });
    expect(await enqueueFinanceDelivery(boss, d)).toBe('enqueued');
    expect(boss.send).toHaveBeenCalledWith(
      FINANCE_AUTOMATION_QUEUE,
      financeDeliveryPayload(d),
      expect.objectContaining({ id: d.id, retryLimit: 0 }),
    );
  });
  it('does not interpret absent readback after a transport failure as no effects', async () => {
    expect(
      await enqueueFinanceDelivery(
        transport(new Error('lost'), null),
        fixture(),
      ),
    ).toBe('indeterminate');
  });
  it('quarantines forged binding, wrong revision, and failed broker records', async () => {
    const d = fixture();
    const boss = transport(d.id, null);
    expect(
      await enqueueFinanceDelivery(boss, { ...d, payloadHash: 'f'.repeat(64) }),
    ).toBe('quarantined');
    expect(boss.send).not.toHaveBeenCalled();
    for (const data of [
      { ...financeDeliveryPayload(d), deliveryRevision: 2 },
      financeDeliveryPayload(d),
    ]) {
      expect(
        await enqueueFinanceDelivery(
          transport(null, {
            id: d.id,
            name: FINANCE_AUTOMATION_QUEUE,
            singletonKey: d.id,
            data,
            state: 'failed',
          }),
          d,
        ),
      ).toBe('quarantined');
    }
  });
  it('leaves ambiguous sends and lost acknowledgements reclaimable without changing identity', async () => {
    const d = fixture();
    const repository = {
      reconcileStalled: async () => 0,
      claim: vi.fn(async () => [d]),
      acknowledge: vi.fn(async () => {
        throw Error('lost ack');
      }),
    };
    const enqueue = vi.fn(async () => 'indeterminate' as const);
    await dispatchFinanceDeliveries({
      repository,
      enqueue,
      signal: new AbortController().signal,
    });
    expect(repository.acknowledge).not.toHaveBeenCalled();
    await dispatchFinanceDeliveries({
      repository,
      enqueue: async () => 'enqueued',
      signal: new AbortController().signal,
    });
    expect(repository.acknowledge).toHaveBeenCalledWith(d, 'enqueued');
  });
  it('bounds hung sends and readbacks and never acknowledges a late result', async () => {
    vi.useFakeTimers();
    try {
      const d = fixture();
      let resolveSend!: (
        value: 'enqueued' | 'indeterminate' | 'quarantined',
      ) => void;
      const repository = {
        reconcileStalled: async () => 0,
        claim: vi.fn(async () => [d]),
        acknowledge: vi.fn(async () => true),
      };
      const task = dispatchFinanceDeliveries({
        repository,
        enqueue: () =>
          new Promise((resolve) => {
            resolveSend = resolve;
          }),
        signal: new AbortController().signal,
      });
      await vi.advanceTimersByTimeAsync(10001);
      await task;
      expect(repository.claim).toHaveBeenCalledWith(1);
      resolveSend('enqueued');
      await Promise.resolve();
      expect(repository.acknowledge).not.toHaveBeenCalled();
      const boss = transport(null, null);
      boss.getJobById = () => new Promise(() => {});
      const readback = enqueueFinanceDelivery(boss, d);
      await vi.advanceTimersByTimeAsync(10001);
      expect(await readback).toBe('indeterminate');
    } finally {
      vi.useRealTimers();
    }
  });
  it('aborts an in-flight transport without acknowledging or waiting for its response', async () => {
    const d = fixture(),
      controller = new AbortController();
    const repository = {
      reconcileStalled: async () => 0,
      claim: vi.fn(async () => [d]),
      acknowledge: vi.fn(async () => true),
    };
    const task = dispatchFinanceDeliveries({
      repository,
      enqueue: async () => new Promise(() => {}),
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await task;
    expect(repository.acknowledge).not.toHaveBeenCalled();
  });
});

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  dispatchStandardizationDeliveries,
  enqueueStandardization,
  registerStandardizationWorker,
} from './finance-standardization-delivery.js';
import {
  FINANCE_STANDARDIZATION_QUEUE,
  standardizationQueueId,
} from './finance-standardization-worker.js';
import type { PgBossCompatible, PgBossJob } from './jobs.js';

describe('saved standardization delivery boundary', () => {
  const delivery = {
    runId: randomUUID(),
    deliveryRevision: 1,
    token: randomUUID(),
  };
  const id = standardizationQueueId(delivery.runId, 1, delivery.token);
  const payload = {
    schemaVersion: 1,
    runId: delivery.runId,
    deliveryRevision: 1,
    deliveryToken: delivery.token,
  };
  it('confirms an uncertain send only from exact persisted queue identity and payload', async () => {
    const send = vi.fn().mockRejectedValue(new Error('response lost'));
    const getJobById = vi.fn().mockResolvedValue({
      id,
      name: FINANCE_STANDARDIZATION_QUEUE,
      singletonKey: id,
      data: payload,
      state: 'created',
    });
    expect(
      await enqueueStandardization(
        { send, getJobById } as Pick<PgBossCompatible, 'send' | 'getJobById'>,
        delivery,
      ),
    ).toBe(true);
    expect(send).toHaveBeenCalledWith(
      FINANCE_STANDARDIZATION_QUEUE,
      payload,
      expect.objectContaining({ id, retryLimit: 0, singletonKey: id }),
    );
    getJobById.mockResolvedValueOnce({
      id,
      name: FINANCE_STANDARDIZATION_QUEUE,
      singletonKey: id,
      data: { ...payload, runId: randomUUID() },
      state: 'created',
    });
    expect(
      await enqueueStandardization(
        { send, getJobById } as Pick<PgBossCompatible, 'send' | 'getJobById'>,
        delivery,
      ),
    ).toBe(false);
  });
  it('does not acknowledge a pending queue operation after cancellation', async () => {
    const controller = new AbortController();
    const send = vi.fn(() => new Promise<string>(() => {}));
    const pending = enqueueStandardization(
      { send, getJobById: vi.fn() } as Pick<
        PgBossCompatible,
        'send' | 'getJobById'
      >,
      delivery,
      controller.signal,
    );
    controller.abort();
    expect(await pending).toBe(false);
  });
  it('rejects mismatched delivery identity and forwards the real worker signal', async () => {
    let handler: ((jobs: readonly PgBossJob[]) => Promise<unknown>) | undefined;
    const dispatch = vi.fn().mockResolvedValue('duplicate');
    const createQueue = vi.fn().mockResolvedValue(undefined);
    const work = vi.fn(async (_name, _options, callback) => {
      handler = callback;
      return 'worker';
    });
    await registerStandardizationWorker(
      { createQueue, work } as Pick<PgBossCompatible, 'createQueue' | 'work'>,
      dispatch,
    );
    const signal = new AbortController().signal;
    const job = {
      id,
      name: FINANCE_STANDARDIZATION_QUEUE,
      data: payload,
      signal,
    } as PgBossJob;
    await expect(handler!([{ ...job, id: randomUUID() }])).rejects.toThrow(
      'identity-mismatch',
    );
    expect(dispatch).not.toHaveBeenCalled();
    await handler!([job]);
    expect(dispatch).toHaveBeenCalledWith(payload, signal);
    expect(createQueue).toHaveBeenCalledWith(
      FINANCE_STANDARDIZATION_QUEUE,
      expect.objectContaining({ retryLimit: 0 }),
    );
  });
  it('keeps legacy payloads readable while binding new jobs to each delivery token', async () => {
    let handler: ((jobs: readonly PgBossJob[]) => Promise<unknown>) | undefined;
    const dispatch = vi.fn().mockResolvedValue('duplicate');
    const work = vi.fn(async (_name, _options, callback) => {
      handler = callback;
      return 'worker';
    });
    await registerStandardizationWorker(
      { createQueue: vi.fn(), work } as Pick<
        PgBossCompatible,
        'createQueue' | 'work'
      >,
      dispatch,
    );
    const legacyPayload = {
      schemaVersion: 1 as const,
      runId: delivery.runId,
      deliveryRevision: 1,
    };
    await handler!([
      {
        id: standardizationQueueId(delivery.runId, 1),
        name: FINANCE_STANDARDIZATION_QUEUE,
        data: legacyPayload,
        signal: new AbortController().signal,
      },
    ]);
    expect(dispatch).toHaveBeenCalledWith(
      legacyPayload,
      expect.any(AbortSignal),
    );
    expect(standardizationQueueId(delivery.runId, 1, randomUUID())).not.toBe(
      standardizationQueueId(delivery.runId, 1, randomUUID()),
    );
  });
  it('uses a new broker identity when the database delivery lease is reclaimed', async () => {
    const send = vi.fn(
      async (_name: string, _payload: object, options: { id: string }) =>
        options.id,
    );
    const getJobById = vi.fn();
    const reclaimed = { ...delivery, token: randomUUID() };
    expect(
      await enqueueStandardization(
        { send, getJobById } as Pick<PgBossCompatible, 'send' | 'getJobById'>,
        delivery,
      ),
    ).toBe(true);
    expect(
      await enqueueStandardization(
        { send, getJobById } as Pick<PgBossCompatible, 'send' | 'getJobById'>,
        reclaimed,
      ),
    ).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[2].id).not.toBe(send.mock.calls[1]?.[2].id);
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      deliveryToken: delivery.token,
    });
    expect(send.mock.calls[1]?.[1]).toMatchObject({
      deliveryToken: reclaimed.token,
    });
  });
  it('does not acknowledge broker acceptance before the worker claims the database lease', async () => {
    const claim = vi.fn().mockResolvedValue([delivery]);
    const enqueue = vi.fn().mockResolvedValue(true);
    await dispatchStandardizationDeliveries({
      repository: { claim },
      enqueue,
      signal: new AbortController().signal,
    });
    expect(enqueue).toHaveBeenCalledWith(delivery, expect.any(AbortSignal));
  });
  it('runs bounded fixed-executor receipt reconciliation before delivery polling', async () => {
    const calls: string[] = [];
    const reconcileReceipts = vi.fn(async (signal?: AbortSignal) => {
      expect(signal?.aborted).toBe(false);
      calls.push('reconcile');
    });
    const claim = vi.fn(async () => {
      calls.push('claim');
      return [];
    });
    await dispatchStandardizationDeliveries({
      repository: { claim },
      enqueue: vi.fn(),
      reconcileReceipts,
      signal: new AbortController().signal,
    });
    expect(calls).toEqual(['reconcile', 'claim']);
    expect(reconcileReceipts).toHaveBeenCalledTimes(1);
  });
});

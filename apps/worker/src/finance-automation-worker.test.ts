import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  FinanceAutomationRunSchema,
  type FinanceAutomationRun,
} from '@emdo/contracts';
import {
  createFinanceAutomationDispatcher,
  financeAutomationQueueJobId,
  FINANCE_AUTOMATION_QUEUE,
  registerFinanceAutomationWorker,
  type FinanceAutomationExecutionStore,
  type FinanceAutomationLeaf,
  type FinanceAutomationLeafResult,
} from './finance-automation-worker.js';
import type { PgBossJob } from './jobs.js';

const now = '2026-09-13T12:00:00.000Z';
function fixture() {
  const operationId = randomUUID(),
    target = randomUUID();
  const request = {
    operationId,
    grantId: randomUUID(),
    grantRevision: 1,
    workspaceId: randomUUID(),
    bookId: randomUUID(),
    capability: 'finance.reports.generate' as const,
    requestHash: 'a'.repeat(64),
    itemCount: 1,
    currency: 'CAD' as const,
    amount: '0.30',
  };
  const run: FinanceAutomationRun = {
    request,
    revision: 2,
    attempts: 1,
    status: 'executing',
    outcomeReference: null,
  };
  const claim = {
    status: 'claimed' as const,
    run,
    intent: {
      workspaceId: request.workspaceId,
      bookId: request.bookId,
      grantId: request.grantId,
      grantRevision: 1,
      capability: request.capability,
      targets: [target],
      currency: 'CAD',
      amount: '0.3',
    },
    leaseToken: randomUUID(),
    leaseExpiresAt: '2026-09-13T12:02:00.000Z',
  };
  const executions = {
    claimDelivery: vi.fn(async (): Promise<unknown> => claim),
    settle: vi.fn(
      async (
        input: Parameters<FinanceAutomationExecutionStore['settle']>[0],
      ): Promise<unknown> => ({
        ...run,
        revision: run.revision + 1,
        status:
          input.result === 'applied'
            ? 'completed'
            : input.result === 'not-applied'
              ? 'retryable'
              : 'requires-reconciliation',
        outcomeReference: input.outcomeReference ?? null,
      }),
    ),
  };
  const outcomeReference = randomUUID();
  const execute = vi.fn(async (): Promise<FinanceAutomationLeafResult> => ({
    application: 'applied',
    outcomeReference,
  }));
  const leaf: FinanceAutomationLeaf = {
    capability: request.capability,
    readiness: 'implemented',
    execute,
  };
  const dispatch = createFinanceAutomationDispatcher({
    executions,
    leaves: [leaf],
    now: () => now,
  });
  return {
    operationId,
    run,
    claim,
    executions,
    outcomeReference,
    execute,
    leaf,
    dispatch,
  };
}
describe('EMDO-managed Finance worker dispatch', () => {
  it('dispatches only the canonical scoped intent and CAS-settles the stored outcome', async () => {
    const f = fixture();
    expect(
      await f.dispatch(f.operationId, 1, new AbortController().signal),
    ).toEqual({ status: 'completed', outcomeReference: f.outcomeReference });
    expect(f.executions.claimDelivery).toHaveBeenCalledWith(f.operationId, 1);
    expect(f.execute).toHaveBeenCalledTimes(1);
    const input = f.execute.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(Object.keys(input[0]).sort()).toEqual([
      'leaseExpiresAt',
      'leaseToken',
      'run',
      'signal',
      'targets',
    ]);
    expect(f.executions.settle).toHaveBeenCalledWith({
      operationId: f.operationId,
      expectedRevision: 2,
      leaseToken: f.claim.leaseToken,
      result: 'applied',
      outcomeReference: f.outcomeReference,
    });
  });
  it('binds planning item counts to the canonical planning intent and run CAS revision', async () => {
    const operationId = randomUUID();
    const grantId = randomUUID();
    const workspaceId = randomUUID();
    const bookId = randomUUID();
    const budgetId = randomUUID();
    const planning = {
      schemaVersion: 1 as const,
      capability: 'finance.planning.budget-vs-actuals' as const,
      budgetId,
      budgetRevision: 2,
      asOf: null,
      currency: 'CAD' as const,
      itemCount: 3,
    };
    const run: FinanceAutomationRun = FinanceAutomationRunSchema.parse({
      request: {
        operationId,
        grantId,
        grantRevision: 1,
        workspaceId,
        bookId,
        capability: planning.capability,
        requestHash: 'b'.repeat(64),
        itemCount: planning.itemCount,
        currency: 'CAD',
        amount: '0',
        planning,
      },
      revision: 2,
      attempts: 1,
      status: 'executing',
      outcomeReference: null,
    });
    const leaseToken = randomUUID();
    const outcomeReference = randomUUID();
    const claim = {
      status: 'claimed' as const,
      run,
      intent: {
        workspaceId,
        bookId,
        grantId,
        grantRevision: 1,
        capability: planning.capability,
        targets: [budgetId],
        currency: 'CAD',
        amount: '0',
        planning,
        planningReview: {
          itemCount: planning.itemCount,
          currency: planning.currency,
          reviewForecastId: null,
          reviewForecastRevision: null,
        },
      },
      leaseToken,
      leaseExpiresAt: '2026-09-13T12:02:00.000Z',
    };
    const execute = vi.fn(async () => ({
      application: 'applied' as const,
      outcomeReference,
    }));
    const executions: FinanceAutomationExecutionStore = {
      claimDelivery: vi.fn(async () => claim),
      settle: vi.fn(async (input) => ({
        ...run,
        revision: run.revision + 1,
        status: 'completed' as const,
        outcomeReference: input.outcomeReference ?? null,
      })),
    };
    const dispatch = createFinanceAutomationDispatcher({
      executions,
      leaves: [
        {
          capability: planning.capability,
          readiness: 'implemented',
          execute,
        },
      ],
      now: () => now,
    });

    await expect(
      dispatch(operationId, 1, new AbortController().signal),
    ).resolves.toEqual({ status: 'completed', outcomeReference });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(executions.settle).toHaveBeenCalledWith({
      operationId,
      expectedRevision: run.revision,
      leaseToken,
      result: 'applied',
      outcomeReference,
    });
  });
  it('does not invoke leaves for revoked authority or duplicate outcomes', async () => {
    const f = fixture();
    f.executions.claimDelivery.mockResolvedValueOnce({
      status: 'denied',
      reason: 'grant-revoked',
    });
    expect(
      await f.dispatch(f.operationId, 1, new AbortController().signal),
    ).toEqual({ status: 'denied' });
    f.executions.claimDelivery.mockResolvedValueOnce({
      status: 'duplicate',
      outcomeReference: f.outcomeReference,
    });
    expect(
      await f.dispatch(f.operationId, 1, new AbortController().signal),
    ).toEqual({ status: 'duplicate', outcomeReference: f.outcomeReference });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.executions.settle).not.toHaveBeenCalled();
  });
  it('fails closed when the claimed capability lacks an implemented leaf', async () => {
    const f = fixture();
    const dispatch = createFinanceAutomationDispatcher({
      executions: f.executions,
      leaves: [],
      now: () => now,
    });
    expect(
      await dispatch(f.operationId, 1, new AbortController().signal),
    ).toEqual({ status: 'retryable', nextDeliveryRevision: 3 });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.executions.settle).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'not-applied' }),
    );
  });
  it('rejects expanded authority, unknown capabilities and cross-book claims', async () => {
    const f = fixture();
    f.executions.claimDelivery.mockResolvedValueOnce({
      ...f.claim,
      sessionId: randomUUID(),
    });
    await expect(
      f.dispatch(f.operationId, 1, new AbortController().signal),
    ).rejects.toThrow('invalid-claim');
    f.executions.claimDelivery.mockResolvedValueOnce({
      ...f.claim,
      intent: { ...f.claim.intent, capability: 'scheduler.delegate' },
    });
    await expect(
      f.dispatch(f.operationId, 1, new AbortController().signal),
    ).rejects.toThrow('invalid-claim');
    f.executions.claimDelivery.mockResolvedValueOnce({
      ...f.claim,
      intent: { ...f.claim.intent, bookId: randomUUID() },
    });
    await expect(
      f.dispatch(f.operationId, 1, new AbortController().signal),
    ).rejects.toThrow('binding-invalid');
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.executions.settle).not.toHaveBeenCalled();
  });
  it('rejects a claim that does not advance the expected delivery revision', async () => {
    const f = fixture();
    await expect(
      f.dispatch(f.operationId, 3, new AbortController().signal),
    ).rejects.toThrow('binding-invalid');
    expect(f.executions.claimDelivery).toHaveBeenCalledWith(f.operationId, 3);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.executions.settle).not.toHaveBeenCalled();
  });
  it('treats exceptions and malformed leaf outputs as unknown effects', async () => {
    const f = fixture();
    f.execute.mockRejectedValueOnce(new Error('provider secret not for logs'));
    expect(
      await f.dispatch(f.operationId, 1, new AbortController().signal),
    ).toEqual({ status: 'requires-reconciliation' });
    expect(f.executions.settle).toHaveBeenLastCalledWith(
      expect.objectContaining({ result: 'indeterminate' }),
    );
    f.execute.mockResolvedValueOnce({
      application: 'applied',
      outcomeReference: 'bad',
    });
    expect(
      await f.dispatch(f.operationId, 1, new AbortController().signal),
    ).toEqual({ status: 'requires-reconciliation' });
    expect(f.executions.settle).toHaveBeenLastCalledWith(
      expect.objectContaining({ result: 'indeterminate' }),
    );
  });
  it('never retries a leaf when settlement fails or returns a mismatched outcome', async () => {
    const f = fixture();
    f.executions.settle.mockRejectedValueOnce(
      new Error('connection lost after commit'),
    );
    expect(
      await f.dispatch(f.operationId, 1, new AbortController().signal),
    ).toEqual({ status: 'requires-reconciliation' });
    expect(f.execute).toHaveBeenCalledTimes(1);
    f.executions.settle.mockResolvedValueOnce({
      ...f.run,
      revision: 3,
      status: 'completed',
      outcomeReference: randomUUID(),
    });
    expect(
      await f.dispatch(f.operationId, 1, new AbortController().signal),
    ).toEqual({ status: 'requires-reconciliation' });
  });
  it('does not dispatch an expired lease', async () => {
    const f = fixture();
    f.claim.leaseExpiresAt = now;
    expect(
      await f.dispatch(f.operationId, 1, new AbortController().signal),
    ).toEqual({ status: 'requires-reconciliation' });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.executions.settle).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'indeterminate' }),
    );
  });
  it('rechecks authorization on a later retry after explicit not-applied', async () => {
    const f = fixture();
    f.execute.mockResolvedValueOnce({ application: 'not-applied' });
    expect(
      await f.dispatch(f.operationId, 1, new AbortController().signal),
    ).toEqual({ status: 'retryable', nextDeliveryRevision: 3 });
    f.executions.claimDelivery.mockResolvedValueOnce({
      status: 'denied',
      reason: 'grant-revoked',
    });
    expect(
      await f.dispatch(f.operationId, 1, new AbortController().signal),
    ).toEqual({ status: 'denied' });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.executions.claimDelivery).toHaveBeenCalledTimes(2);
  });
  it('classifies timeout as indeterminate and ignores late leaf completion', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let finish: ((value: FinanceAutomationLeafResult) => void) | undefined;
      f.execute.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const dispatch = createFinanceAutomationDispatcher({
        executions: f.executions,
        leaves: [f.leaf],
        now: () => now,
        maxExecutionMs: 10,
      });
      const pending = dispatch(f.operationId, 1, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(11);
      expect(await pending).toEqual({ status: 'requires-reconciliation' });
      finish?.({
        application: 'applied',
        outcomeReference: f.outcomeReference,
      });
      await Promise.resolve();
      expect(f.executions.settle).toHaveBeenCalledTimes(1);
      expect(f.executions.settle).toHaveBeenCalledWith(
        expect.objectContaining({ result: 'indeterminate' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps post-dispatch cancellation indeterminate and pre-claim cancellation inert', async () => {
    const f = fixture();
    const controller = new AbortController();
    const canceled = new AbortController();
    canceled.abort();
    expect(await f.dispatch(f.operationId, 1, canceled.signal)).toEqual({
      status: 'retryable',
      nextDeliveryRevision: 1,
    });
    expect(f.executions.claimDelivery).not.toHaveBeenCalled();
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.execute.mockImplementation(() => {
      started();
      return new Promise(() => {});
    });
    const pending = f.dispatch(f.operationId, 1, controller.signal);
    await ready;
    controller.abort();
    expect(await pending).toEqual({ status: 'requires-reconciliation' });
  });
  it('bounds database waits without replaying an uncertain claim or settlement', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.executions.claimDelivery.mockImplementationOnce(
        () => new Promise(() => {}),
      );
      const pending = f.dispatch(
        f.operationId,
        1,
        new AbortController().signal,
      );
      const rejected = expect(pending).rejects.toThrow(
        'automation-claim-unavailable',
      );
      await vi.advanceTimersByTimeAsync(10001);
      await rejected;
      expect(f.execute).not.toHaveBeenCalled();
      f.executions.settle.mockImplementationOnce(() => new Promise(() => {}));
      const settlement = f.dispatch(
        f.operationId,
        1,
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(5001);
      expect(await settlement).toEqual({ status: 'requires-reconciliation' });
      expect(f.execute).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('registers revision-bound pg-boss references with queue retries disabled', async () => {
    const f = fixture();
    let handler: ((jobs: readonly PgBossJob[]) => Promise<unknown>) | undefined;
    const boss = {
      createQueue: vi.fn(async () => undefined),
      work: vi.fn(
        async (
          _name: string,
          _options: unknown,
          work: (jobs: readonly PgBossJob[]) => Promise<unknown>,
        ) => {
          handler = work;
          return 'worker';
        },
      ),
    };
    expect(financeAutomationQueueJobId(f.operationId, 1)).not.toBe(
      financeAutomationQueueJobId(f.operationId, 3),
    );
    await registerFinanceAutomationWorker({ boss, dispatch: f.dispatch });
    expect(boss.createQueue).toHaveBeenCalledWith(
      FINANCE_AUTOMATION_QUEUE,
      expect.objectContaining({ retryLimit: 0 }),
    );
    const job = {
      id: financeAutomationQueueJobId(f.operationId, 1),
      name: FINANCE_AUTOMATION_QUEUE,
      data: {
        schemaVersion: 1,
        origin: 'emdo-managed',
        operationId: f.operationId,
        deliveryRevision: 1,
      },
      signal: new AbortController().signal,
    };
    await expect(
      handler?.([{ ...job, data: { ...job.data, sessionId: randomUUID() } }]),
    ).rejects.toThrow('invalid-job');
    await expect(handler?.([{ ...job, id: randomUUID() }])).rejects.toThrow(
      'invalid-job',
    );
    expect(f.executions.claimDelivery).not.toHaveBeenCalled();
    expect(await handler?.([job])).toEqual({
      status: 'completed',
      outcomeReference: f.outcomeReference,
    });
  });
});

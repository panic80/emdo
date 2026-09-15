import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FinanceGeneratedReportNotAppliedError } from '@emdo/db/worker';
import type { FinanceAutomationLeafInput } from './finance-automation-worker.js';
import { createFinanceTrialBalanceLeaf } from './finance-trial-balance-leaf.js';
function fixture() {
  const bookId = randomUUID();
  const input: FinanceAutomationLeafInput = {
    run: {
      request: {
        operationId: randomUUID(),
        grantId: randomUUID(),
        grantRevision: 1,
        workspaceId: randomUUID(),
        bookId,
        capability: 'finance.reports.generate',
        requestHash: 'a'.repeat(64),
        itemCount: 1,
        currency: 'CAD',
        amount: '0',
      },
      revision: 2,
      attempts: 1,
      status: 'executing',
      outcomeReference: null,
    },
    targets: [bookId],
    leaseToken: randomUUID(),
    leaseExpiresAt: '2026-09-13T12:00:00.000Z',
    signal: new AbortController().signal,
  };
  const reportId = randomUUID();
  const reports = { generateTrialBalance: vi.fn(async () => ({ reportId })) };
  return {
    input,
    reports,
    reportId,
    leaf: createFinanceTrialBalanceLeaf(reports),
  };
}
describe('Concrete trial-balance leaf', () => {
  it('passes only canonical operation and lease to the SQL snapshot boundary', async () => {
    const f = fixture();
    expect(await f.leaf.execute(f.input)).toEqual({
      application: 'applied',
      outcomeReference: f.reportId,
    });
    expect(f.reports.generateTrialBalance).toHaveBeenCalledWith({
      operationId: f.input.run.request.operationId,
      expectedRevision: 2,
      leaseToken: f.input.leaseToken,
    });
  });
  it('rejects cross-book, multiple-target or monetary intent before any effect', async () => {
    const f = fixture();
    for (const targets of [
      [randomUUID()],
      [f.input.run.request.bookId, randomUUID()],
    ])
      expect(await f.leaf.execute({ ...f.input, targets })).toEqual({
        application: 'not-applied',
      });
    expect(
      await f.leaf.execute({
        ...f.input,
        run: {
          ...f.input.run,
          request: { ...f.input.run.request, amount: '0.01' },
        },
      }),
    ).toEqual({ application: 'not-applied' });
    expect(f.reports.generateTrialBalance).not.toHaveBeenCalled();
  });
  it('distinguishes confirmed rollback from commit uncertainty', async () => {
    const f = fixture();
    f.reports.generateTrialBalance.mockRejectedValueOnce(
      new FinanceGeneratedReportNotAppliedError('authority-denied'),
    );
    expect(await f.leaf.execute(f.input)).toEqual({
      application: 'not-applied',
    });
    f.reports.generateTrialBalance.mockRejectedValueOnce(
      new Error('transport lost'),
    );
    await expect(f.leaf.execute(f.input)).rejects.toThrow('transport lost');
  });
});

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FinanceGeneratedReportNotAppliedError } from '@emdo/db/worker';
import type { FinanceAutomationLeafInput } from './finance-automation-worker.js';
import { createFinanceAccountingReportLeaf } from './finance-accounting-report-leaf.js';

const id = () => randomUUID();
function fixture(report?: FinanceAutomationLeafInput['run']['request']['report']) {
  const bookId = id();
  const input: FinanceAutomationLeafInput = {
    run: {
      request: {
        operationId: id(),
        grantId: id(),
        grantRevision: 1,
        workspaceId: id(),
        bookId,
        capability: 'finance.reports.generate',
        requestHash: 'a'.repeat(64),
        itemCount: 1,
        currency: 'CAD',
        amount: '0',
        ...(report ? { report } : {}),
      },
      revision: 2,
      attempts: 1,
      status: 'executing',
      outcomeReference: null,
    },
    targets: [bookId],
    leaseToken: id(),
    leaseExpiresAt: '2026-09-13T12:00:00.000Z',
    signal: new AbortController().signal,
  };
  const reports = {
    generateTrialBalance: vi.fn(async () => ({ reportId: id() })),
    generateAccountingReport: vi.fn(async () => ({ reportId: id() })),
  };
  return { input, reports, leaf: createFinanceAccountingReportLeaf(reports) };
}

describe('Concrete accounting-report leaf', () => {
  it('keeps legacy omitted-report runs on the trial-balance function', async () => {
    const f = fixture();
    const result = await f.leaf.execute(f.input);
    expect(result.application).toBe('applied');
    expect(f.reports.generateTrialBalance).toHaveBeenCalledTimes(1);
    expect(f.reports.generateAccountingReport).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'income-statement' as const, periodId: id() },
    { kind: 'balance-sheet' as const, asOf: '2026-09-13' },
  ])('routes a $kind selection through the statement SQL boundary', async (report) => {
    const f = fixture(report);
    const result = await f.leaf.execute(f.input);
    expect(result.application).toBe('applied');
    expect(f.reports.generateAccountingReport).toHaveBeenCalledWith({
      operationId: f.input.run.request.operationId,
      expectedRevision: f.input.run.revision,
      leaseToken: f.input.leaseToken,
    });
    expect(f.reports.generateTrialBalance).not.toHaveBeenCalled();
  });

  it('turns missing classifications into a durable blocked result', async () => {
    const f = fixture({ kind: 'income-statement', periodId: id() });
    f.reports.generateAccountingReport.mockRejectedValueOnce(
      new FinanceGeneratedReportNotAppliedError('missing-classification'),
    );
    await expect(f.leaf.execute(f.input)).resolves.toEqual({
      application: 'blocked',
      reason: 'report-missing-account-classification',
    });
  });

  it('fails closed before any SQL call for cross-book or monetary intent', async () => {
    const f = fixture({ kind: 'balance-sheet', asOf: '2026-09-13' });
    expect(
      await f.leaf.execute({ ...f.input, targets: [id()] }),
    ).toEqual({ application: 'not-applied' });
    expect(
      await f.leaf.execute({
        ...f.input,
        run: {
          ...f.input.run,
          request: { ...f.input.run.request, amount: '0.01' },
        },
      }),
    ).toEqual({ application: 'not-applied' });
    expect(f.reports.generateAccountingReport).not.toHaveBeenCalled();
  });

  it('leaves uncertain SQL errors to dispatcher reconciliation', async () => {
    const f = fixture({ kind: 'income-statement', periodId: id() });
    f.reports.generateAccountingReport.mockRejectedValueOnce(
      new Error('connection lost after commit'),
    );
    await expect(f.leaf.execute(f.input)).rejects.toThrow(
      'connection lost after commit',
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  FinanceAutomationGrantSchema,
  FinanceAutomationRunRequestSchema,
} from '@emdo/contracts';
import {
  evaluateFinanceAutomationExecution,
  transitionFinanceAutomationRun,
} from './automations.js';

const id = (suffix: number) =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const now = '2026-09-13T12:00:00.000Z';
const authorityRevision = { membership: 1, bookAccess: 1, entitlement: 1 };
function fixture() {
  const request = {
    operationId: id(1),
    grantId: id(2),
    grantRevision: 1,
    workspaceId: id(3),
    bookId: id(4),
    capability: 'finance.journals.draft' as const,
    journal: {
      schemaVersion: 1 as const,
      batchId: id(6),
      expectedBatchRevision: 1,
      expectedSnapshotHash: 'b'.repeat(64),
    },
    requestHash: 'a'.repeat(64),
    itemCount: 2,
    currency: 'CAD' as const,
    amount: '9007199254740993',
  };
  const grant = {
    id: id(2),
    revision: 1,
    workspaceId: id(3),
    bookId: id(4),
    grantedByUserId: id(5),
    executor: 'emdo-managed' as const,
    specialist: 'finance' as const,
    status: 'active' as 'active' | 'revoked',
    allowedCapabilities: [request.capability],
    authorityRevision,
    limits: {
      maxRuns: 2,
      maxAttemptsPerRun: 2,
      maxItemsPerRun: 2,
      maxTotalItems: 4,
      currency: 'CAD',
      maxAmountPerRun: request.amount,
      maxTotalAmount: '18014398509481986',
    },
    validFrom: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-10-01T00:00:00.000Z',
  };
  const authority = {
    checkedAt: now,
    workspaceId: id(3),
    bookId: id(4),
    userId: id(5),
    membershipStatus: 'active',
    bookStatus: 'active',
    bookRole: 'preparer',
    automationEntitled: true,
    allowedCapabilities: [request.capability],
    authorityRevision: { ...authorityRevision },
  };
  const run = {
    request,
    revision: 1,
    attempts: 0,
    status: 'queued',
    outcomeReference: null,
  };
  return {
    now,
    grant,
    authority,
    run,
    usage: {
      grantId: id(2),
      runs: 1,
      items: 2,
      amount: request.amount,
      currency: 'CAD',
    },
  };
}

describe('Finance automation execution authority', () => {
  it('authorizes exact integer bounds beyond floating point precision', () => {
    expect(evaluateFinanceAutomationExecution(fixture())).toMatchObject({
      status: 'authorized',
      nextAttempt: 1,
    });
    const input = fixture();
    input.usage.amount = '9007199254740994';
    expect(evaluateFinanceAutomationExecution(input)).toEqual({
      status: 'denied',
      reason: 'limit-exceeded',
    });
  });
  it('aligns approver writes and validates exact decimal currency limits', () => {
    const input = fixture();
    input.authority.bookRole = 'approver';
    input.run.request.amount = '0.10';
    input.usage.amount = '0.20';
    input.grant.limits.maxAmountPerRun = '0.10';
    input.grant.limits.maxTotalAmount = '0.30';
    expect(evaluateFinanceAutomationExecution(input).status).toBe('authorized');
    input.usage.amount = '0.21';
    expect(evaluateFinanceAutomationExecution(input)).toMatchObject({
      status: 'denied',
      reason: 'limit-exceeded',
    });
  });
  it.each(['membership', 'bookAccess', 'entitlement'] as const)(
    'blocks queued authority after %s revision changes',
    (key) => {
      const input = fixture();
      input.authority.authorityRevision[key]++;
      expect(evaluateFinanceAutomationExecution(input)).toEqual({
        status: 'denied',
        reason: 'authority-changed',
      });
    },
  );
  it.each([
    ['revoked', 'grant-revoked'],
    ['expired', 'grant-expired'],
    ['revised', 'grant-revised'],
    ['inactive', 'membership-inactive'],
    ['archived', 'book-unavailable'],
    ['entitlement', 'entitlement-disabled'],
    ['role', 'capability-forbidden'],
    ['stale', 'authority-not-fresh'],
    ['book', 'scope-mismatch'],
  ])('rejects %s queued authority', (mutation, reason) => {
    const input = fixture();
    if (mutation === 'revoked') input.grant.status = 'revoked';
    if (mutation === 'expired') input.grant.expiresAt = now;
    if (mutation === 'revised') input.grant.revision++;
    if (mutation === 'inactive') input.authority.membershipStatus = 'inactive';
    if (mutation === 'archived') input.authority.bookStatus = 'archived';
    if (mutation === 'entitlement') input.authority.automationEntitled = false;
    if (mutation === 'role') input.authority.bookRole = 'viewer';
    if (mutation === 'stale')
      input.authority.checkedAt = '2026-09-13T11:59:59.000Z';
    if (mutation === 'book') input.run.request.bookId = id(9);
    expect(evaluateFinanceAutomationExecution(input)).toEqual({
      status: 'denied',
      reason,
    });
  });
  it.each(['runs', 'items', 'per-run-items', 'attempts', 'currency', 'amount'])(
    'enforces %s bounds',
    (kind) => {
      const input = fixture();
      if (kind === 'runs') input.usage.runs = 2;
      if (kind === 'items') input.usage.items = 3;
      if (kind === 'per-run-items') input.run.request.itemCount = 3;
      if (kind === 'attempts') input.run.attempts = 2;
      if (kind === 'currency') input.grant.limits.currency = 'USD';
      if (kind === 'amount') input.run.request.amount = '9007199254740994';
      expect(evaluateFinanceAutomationExecution(input)).toMatchObject({
        status: 'denied',
        reason: kind === 'attempts' ? 'attempts-exhausted' : 'limit-exceeded',
      });
    },
  );
  it('rejects browser authority, sibling invocation, grant editing and excess currency precision', () => {
    const { grant, run } = fixture();
    expect(
      FinanceAutomationGrantSchema.safeParse({ ...grant, sessionId: id(9) })
        .success,
    ).toBe(false);
    expect(
      FinanceAutomationGrantSchema.safeParse({ ...grant, executor: 'browser' })
        .success,
    ).toBe(false);
    for (const capability of [
      'scheduler.delegate',
      'finance.grants.expand',
      'finance.journals.post',
    ]) {
      expect(
        FinanceAutomationRunRequestSchema.safeParse({
          ...run.request,
          capability,
        }).success,
      ).toBe(false);
    }
    expect(
      FinanceAutomationRunRequestSchema.safeParse({
        ...run.request,
        amount: '1.005',
      }).success,
    ).toBe(false);
  });
  it('rechecks revocation on retry and blocks it durably', () => {
    const input = fixture();
    const started = transitionFinanceAutomationRun(input.run, 1, {
      type: 'execute',
      ...input,
    });
    expect(started.status).toBe('changed');
    if (started.status !== 'changed') return;
    const retry = transitionFinanceAutomationRun(started.run, 2, {
      type: 'not-applied',
    });
    if (retry.status !== 'changed') throw new Error('Expected retryable run');
    const blocked = transitionFinanceAutomationRun(retry.run, 3, {
      type: 'execute',
      ...input,
      grant: { ...input.grant, status: 'revoked' },
    });
    expect(blocked).toMatchObject({
      status: 'changed',
      run: { status: 'blocked', attempts: 1, revision: 4 },
    });
  });
  it('replays the same canonical outcome but never retries an indeterminate result', () => {
    const input = fixture();
    const executing = { ...input.run, status: 'executing', attempts: 1 };
    const done = transitionFinanceAutomationRun(executing, 1, {
      type: 'applied',
      outcomeReference: id(8),
    });
    if (done.status !== 'changed') throw new Error('Expected completed run');
    expect(
      evaluateFinanceAutomationExecution({ ...input, run: done.run }),
    ).toEqual({ status: 'duplicate', outcomeReference: id(8) });
    expect(
      transitionFinanceAutomationRun(done.run, 2, {
        type: 'applied',
        outcomeReference: id(8),
      }).status,
    ).toBe('unchanged');
    expect(
      transitionFinanceAutomationRun(done.run, 2, {
        type: 'applied',
        outcomeReference: id(9),
      }).status,
    ).toBe('rejected');
    const uncertain = transitionFinanceAutomationRun(executing, 1, {
      type: 'indeterminate',
    });
    if (uncertain.status !== 'changed')
      throw new Error('Expected reconciliation');
    expect(
      evaluateFinanceAutomationExecution({ ...input, run: uncertain.run }),
    ).toEqual({ status: 'denied', reason: 'run-not-runnable' });
    expect(
      transitionFinanceAutomationRun(executing, 2, { type: 'not-applied' }),
    ).toEqual({ status: 'rejected', reason: 'revision-conflict' });
  });
});

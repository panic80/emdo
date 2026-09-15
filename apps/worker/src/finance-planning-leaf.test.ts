import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  FinanceAutomationRunSchema,
  type FinanceAutomationRun,
} from '@emdo/contracts';
import { FinancePlanningResultNotAppliedError } from '@emdo/db/worker';
import {
  createFinancePlanningLeaf,
  createFinancePlanningLeaves,
} from './finance-planning-leaf.js';

function fixture(
  capability:
    | 'finance.planning.budget-vs-actuals'
    | 'finance.planning.forecast' = 'finance.planning.budget-vs-actuals',
) {
  const workspaceId = randomUUID();
  const bookId = randomUUID();
  const budgetId = randomUUID();
  const operationId = randomUUID();
  const planning =
    capability === 'finance.planning.budget-vs-actuals'
      ? {
          schemaVersion: 1 as const,
          capability,
          budgetId,
          budgetRevision: 2,
          asOf: null,
          currency: 'CAD' as const,
          itemCount: 3,
        }
      : {
          schemaVersion: 1 as const,
          capability,
          budgetId,
          budgetRevision: 2,
          asOf: '2026-09-14',
          currency: 'CAD' as const,
          itemCount: 3,
          openingBalance: {
            status: 'unavailable' as const,
            label: 'opening-balance-unavailable' as const,
          },
          assumptions: [],
        };
  const run: FinanceAutomationRun = FinanceAutomationRunSchema.parse({
    request: {
      operationId,
      grantId: randomUUID(),
      grantRevision: 1,
      workspaceId,
      bookId,
      capability,
      requestHash: 'a'.repeat(64),
      itemCount: planning.itemCount,
      currency: 'CAD',
      amount: '0',
      planning,
    },
    revision: 4,
    attempts: 1,
    status: 'executing',
    outcomeReference: null,
  });
  return {
    run,
    operationId,
    planning,
    targets: [budgetId],
    leaseToken: randomUUID(),
    leaseExpiresAt: '2026-09-14T12:02:00.000Z',
  };
}

describe('Finance planning automation leaves', () => {
  it('calls the deterministic SQL store with the automation run revision', async () => {
    const f = fixture();
    const resultId = randomUUID();
    const store = {
      generatePlanningResult: vi.fn(async () => ({ resultId })),
    };
    const leaf = createFinancePlanningLeaf(
      store,
      'finance.planning.budget-vs-actuals',
    );
    await expect(
      leaf.execute({
        run: f.run,
        targets: f.targets,
        leaseToken: f.leaseToken,
        leaseExpiresAt: f.leaseExpiresAt,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ application: 'applied', outcomeReference: resultId });
    expect(store.generatePlanningResult).toHaveBeenCalledWith({
      operationId: f.operationId,
      expectedRevision: 4,
      leaseToken: f.leaseToken,
    });
  });

  it('registers both planning capabilities and rejects a mismatched target', async () => {
    const f = fixture('finance.planning.forecast');
    const store = {
      generatePlanningResult: vi.fn(async () => ({ resultId: randomUUID() })),
    };
    const leaves = createFinancePlanningLeaves(store);
    expect(leaves.map((leaf) => leaf.capability)).toEqual([
      'finance.planning.budget-vs-actuals',
      'finance.planning.forecast',
    ]);
    const result = await leaves[1]!.execute({
      run: f.run,
      targets: [randomUUID()],
      leaseToken: f.leaseToken,
      leaseExpiresAt: f.leaseExpiresAt,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ application: 'not-applied' });
    expect(store.generatePlanningResult).not.toHaveBeenCalled();
  });

  it('keeps known SQL rejection retry-safe while unknown errors stay indeterminate', async () => {
    const f = fixture();
    const known = {
      generatePlanningResult: vi.fn(async () => {
        throw new FinancePlanningResultNotAppliedError('authority-denied');
      }),
    };
    await expect(
      createFinancePlanningLeaf(
        known,
        'finance.planning.budget-vs-actuals',
      ).execute({
        run: f.run,
        targets: f.targets,
        leaseToken: f.leaseToken,
        leaseExpiresAt: f.leaseExpiresAt,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ application: 'not-applied' });
    const unknown = {
      generatePlanningResult: vi.fn(async () => {
        throw new Error('connection lost after commit');
      }),
    };
    await expect(
      createFinancePlanningLeaf(
        unknown,
        'finance.planning.budget-vs-actuals',
      ).execute({
        run: f.run,
        targets: f.targets,
        leaseToken: f.leaseToken,
        leaseExpiresAt: f.leaseExpiresAt,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('connection lost after commit');
  });
});

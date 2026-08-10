import { describe, expect, it } from 'vitest';

import {
  applyTransactionLedgerOperation,
  calculateMonthlyCategoryTotals,
  editFinanceBudget,
} from './ledger.js';

const base = {
  schemaVersion: 1 as const,
  id: 'transaction-1',
  spaceId: 'private-space-1',
  ownerUserId: 'user-1',
  createdAt: '2026-08-01T12:00:00.000Z',
  updatedAt: '2026-08-01T12:00:00.000Z',
  recordType: 'transaction' as const,
  accountId: 'account-1',
  categoryId: 'category-groceries',
  postedOn: '2026-08-01',
  description: 'Market',
  currency: 'CAD' as const,
  originalAmountCadMinor: -1_000,
  effectiveAmountCadMinor: -1_000,
  adjustments: [],
  reversal: null,
  appliedOperationIds: [],
  source: { kind: 'manual' as const },
};

const operationIds = {
  adjustment: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f101',
  reversal: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f102',
  replace: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f103',
} as const;

describe('immutable finance transaction ledger', () => {
  it('applies an adjustment exactly once', () => {
    const operation = {
      operationId: operationIds.adjustment,
      kind: 'adjustment' as const,
      amountCadMinor: 125,
      reason: 'Correct the statement amount.',
    };
    const adjusted = applyTransactionLedgerOperation({
      transaction: base,
      operation,
      updatedAt: '2026-08-02T12:00:00.000Z',
    });

    expect(adjusted).toMatchObject({
      status: 'applied',
      transaction: {
        originalAmountCadMinor: -1_000,
        effectiveAmountCadMinor: -875,
        adjustments: [{ amountCadMinor: 125 }],
      },
      providerWrites: [],
    });
    expect(
      adjusted.transaction === null
        ? null
        : applyTransactionLedgerOperation({
            transaction: adjusted.transaction,
            operation,
            updatedAt: '2026-08-02T12:00:00.000Z',
          }).status,
    ).toBe('duplicate');
  });

  it('uses a reversal instead of destructive replacement or deletion', () => {
    const reversed = applyTransactionLedgerOperation({
      transaction: base,
      operation: {
        operationId: operationIds.reversal,
        kind: 'reversal',
        reason: 'Reverse a duplicate import.',
      },
      updatedAt: '2026-08-02T12:00:00.000Z',
    });
    expect(reversed).toMatchObject({
      status: 'applied',
      transaction: { effectiveAmountCadMinor: 0 },
    });

    expect(
      applyTransactionLedgerOperation({
        transaction: base,
        operation: {
          operationId: operationIds.replace,
          kind: 'replace',
          replacementAmountCadMinor: 500,
        },
        updatedAt: '2026-08-02T12:00:00.000Z',
      }),
    ).toMatchObject({
      status: 'needs-review',
      safeError: { code: 'finance-mutation-requires-ledger-entry' },
    });
  });

  it('surfaces an unsafe adjustment for review without corrupting the ledger', () => {
    const maximum = {
      ...base,
      originalAmountCadMinor: Number.MAX_SAFE_INTEGER,
      effectiveAmountCadMinor: Number.MAX_SAFE_INTEGER,
    };

    expect(
      applyTransactionLedgerOperation({
        transaction: maximum,
        operation: {
          operationId: operationIds.adjustment,
          kind: 'adjustment',
          amountCadMinor: 1,
          reason: 'Unsafe boundary adjustment.',
        },
        updatedAt: '2026-08-02T12:00:00.000Z',
      }),
    ).toMatchObject({
      status: 'needs-review',
      transaction: maximum,
      safeError: { code: 'finance-amount-overflow' },
      providerWrites: [],
    });
  });

  it('fails closed for an invalid or cyclic transaction envelope', () => {
    const input: Record<string, unknown> = {
      transaction: base,
      operation: {
        operationId: operationIds.adjustment,
        kind: 'adjustment',
        amountCadMinor: 1,
        reason: 'Correct it.',
      },
      updatedAt: '2026-08-02T12:00:00.000Z',
    };
    input.self = input;

    expect(applyTransactionLedgerOperation(input)).toEqual({
      status: 'rejected',
      transaction: null,
      providerWrites: [],
      safeError: {
        code: 'invalid-finance-ledger-input',
        message: 'The finance ledger operation is invalid.',
      },
    });
  });
});

describe('exact category totals', () => {
  it('calculates Toronto monthly inflow, outflow, and net to the cent', () => {
    const transactions = [
      base,
      {
        ...base,
        id: 'transaction-2',
        originalAmountCadMinor: -2_005,
        effectiveAmountCadMinor: -2_005,
        description: 'Second market visit',
      },
      {
        ...base,
        id: 'transaction-3',
        originalAmountCadMinor: 500,
        effectiveAmountCadMinor: 500,
        description: 'Market refund',
      },
      {
        ...base,
        id: 'transaction-4',
        categoryId: null,
        originalAmountCadMinor: -99,
        effectiveAmountCadMinor: -99,
        description: 'Uncategorized',
      },
      {
        ...base,
        id: 'transaction-other-month',
        postedOn: '2026-09-01',
        originalAmountCadMinor: -10_000,
        effectiveAmountCadMinor: -10_000,
      },
    ];

    expect(
      calculateMonthlyCategoryTotals({
        month: '2026-08',
        timezone: 'America/Toronto',
        spaceId: 'private-space-1',
        transactions,
      }),
    ).toEqual({
      status: 'calculated',
      month: '2026-08',
      timezone: 'America/Toronto',
      currency: 'CAD',
      categoryTotals: [
        {
          categoryId: null,
          inflowCadMinor: 0,
          outflowCadMinor: 99,
          netCadMinor: -99,
        },
        {
          categoryId: 'category-groceries',
          inflowCadMinor: 500,
          outflowCadMinor: 3_005,
          netCadMinor: -2_505,
        },
      ],
      totals: {
        inflowCadMinor: 500,
        outflowCadMinor: 3_104,
        netCadMinor: -2_604,
      },
    });
  });

  it('rejects wrong timezone, cross-space records, and unsafe totals', () => {
    expect(
      calculateMonthlyCategoryTotals({
        month: '2026-08',
        timezone: 'UTC',
        spaceId: 'private-space-1',
        transactions: [base],
      }),
    ).toMatchObject({ status: 'rejected' });
    expect(
      calculateMonthlyCategoryTotals({
        month: '2026-08',
        timezone: 'America/Toronto',
        spaceId: 'another-space',
        transactions: [base],
      }),
    ).toMatchObject({ status: 'rejected' });
    expect(
      calculateMonthlyCategoryTotals({
        month: '2026-08',
        timezone: 'America/Toronto',
        spaceId: 'private-space-1',
        transactions: [
          {
            ...base,
            effectiveAmountCadMinor: Number.MIN_SAFE_INTEGER,
            originalAmountCadMinor: Number.MIN_SAFE_INTEGER,
          },
          {
            ...base,
            id: 'transaction-overflow',
            effectiveAmountCadMinor: -1,
            originalAmountCadMinor: -1,
          },
        ],
      }),
    ).toMatchObject({
      status: 'rejected',
      safeError: { code: 'finance-total-out-of-range' },
    });
  });
});

describe('editable budgets', () => {
  const budget = {
    schemaVersion: 1 as const,
    id: 'budget-2026-08',
    spaceId: 'private-space-1',
    ownerUserId: 'user-1',
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    recordType: 'budget' as const,
    month: '2026-08',
    currency: 'CAD' as const,
    allocations: [
      { categoryId: 'category-groceries', amountCadMinor: 40_000 },
      { categoryId: 'category-transit', amountCadMinor: 10_000 },
    ],
    revision: 2,
  };

  it('sets and removes categories under an expected revision', () => {
    expect(
      editFinanceBudget({
        budget,
        expectedRevision: 2,
        updatedAt: '2026-08-03T12:00:00.000Z',
        changes: [
          {
            kind: 'set',
            categoryId: 'category-groceries',
            amountCadMinor: 45_000,
          },
          { kind: 'remove', categoryId: 'category-transit' },
        ],
      }),
    ).toMatchObject({
      status: 'applied',
      budget: {
        revision: 3,
        allocations: [
          { categoryId: 'category-groceries', amountCadMinor: 45_000 },
        ],
      },
      totalAllocatedCadMinor: 45_000,
      providerWrites: [],
    });
  });

  it('surfaces stale revisions and rejects fractional budgets', () => {
    expect(
      editFinanceBudget({
        budget,
        expectedRevision: 1,
        updatedAt: '2026-08-03T12:00:00.000Z',
        changes: [],
      }),
    ).toMatchObject({
      status: 'needs-review',
      safeError: { code: 'finance-budget-revision-conflict' },
    });
    expect(
      editFinanceBudget({
        budget,
        expectedRevision: 2,
        updatedAt: '2026-08-03T12:00:00.000Z',
        changes: [
          {
            kind: 'set',
            categoryId: 'category-groceries',
            amountCadMinor: 1.25,
          },
        ],
      }),
    ).toMatchObject({ status: 'rejected' });
  });
});

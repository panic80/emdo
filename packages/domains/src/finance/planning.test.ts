import { describe, expect, it } from 'vitest';

import type {
  FinanceBudgetRevision,
  FinanceForecastAssumptionInput,
} from '@emdo/contracts';

import {
  buildFinanceForecast,
  deriveFinanceBudgetVsActuals,
  type FinanceBudgetPeriodInput,
  type FinancePostedLedgerAggregateInput,
} from './planning.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const bookId = '00000000-0000-4000-8000-000000000002';
const budgetId = '00000000-0000-4000-8000-000000000003';
const forecastId = '00000000-0000-4000-8000-000000000004';
const userId = '00000000-0000-4000-8000-000000000005';
const assetId = '00000000-0000-4000-8000-000000000006';
const liabilityId = '00000000-0000-4000-8000-000000000007';
const equityId = '00000000-0000-4000-8000-000000000010';
const periodOne = '00000000-0000-4000-8000-000000000008';
const periodTwo = '00000000-0000-4000-8000-000000000009';

const periods: readonly FinanceBudgetPeriodInput[] = [
  {
    periodId: periodOne,
    startsOn: '2026-01-01',
    endsOn: '2026-01-31',
  },
  {
    periodId: periodTwo,
    startsOn: '2026-02-01',
    endsOn: '2026-02-28',
  },
];

const budget: FinanceBudgetRevision = {
  schemaVersion: 1,
  workspaceId,
  bookId,
  budgetId,
  revision: 1,
  name: 'Operating plan',
  functionalCurrency: 'CAD',
  createdBy: userId,
  createdAt: '2026-01-01T00:00:00.000Z',
  lines: [
    {
      budgetId,
      revision: 1,
      periodId: periodOne,
      accountId: assetId,
      currency: 'CAD',
      amount: '100000000000000000000000.01',
    },
    {
      budgetId,
      revision: 1,
      periodId: periodTwo,
      accountId: liabilityId,
      currency: 'CAD',
      amount: '200.00',
    },
  ],
};

const aggregate = (
  value: Partial<FinancePostedLedgerAggregateInput> &
    Pick<
      FinancePostedLedgerAggregateInput,
      'periodId' | 'accountId' | 'accountKind'
    >,
): FinancePostedLedgerAggregateInput => ({
  currency: 'CAD',
  debitAmount: '0',
  creditAmount: '0',
  journalCount: 1,
  lineCount: 1,
  ...value,
});

describe('normalized Finance planning arithmetic', () => {
  it('uses account sign basis and exact decimal strings for actuals and variance', () => {
    const result = deriveFinanceBudgetVsActuals({
      budget,
      periods,
      snapshotAt: '2026-02-01T12:00:00.000Z',
      postedAggregates: [
        aggregate({
          periodId: periodOne,
          accountId: assetId,
          accountKind: 'asset',
          debitAmount: '100000000000000000000000.03',
          creditAmount: '0.02',
        }),
        aggregate({
          periodId: periodTwo,
          accountId: liabilityId,
          accountKind: 'liability',
          debitAmount: '20.00',
          creditAmount: '250.00',
        }),
      ],
    });
    expect(result.actualSource).toEqual({
      kind: 'authoritative-posted-ledger',
      coverage: 'posted-journals-in-budget-periods',
      signBasis: 'account-kind',
    });
    expect(result.rows).toMatchObject([
      {
        postedActualAmount: '100000000000000000000000.01',
        varianceAmount: '0',
        actualSignBasis: 'debit-minus-credit',
        sourceJournalCount: 1,
      },
      {
        postedActualAmount: '230',
        varianceAmount: '30',
        actualSignBasis: 'credit-minus-debit',
      },
    ]);
  });

  it('rejects duplicate aggregates instead of multiplying source rows', () => {
    const row = aggregate({
      periodId: periodOne,
      accountId: assetId,
      accountKind: 'asset',
      debitAmount: '1.00',
    });
    expect(() =>
      deriveFinanceBudgetVsActuals({
        budget,
        periods,
        snapshotAt: '2026-02-01T12:00:00.000Z',
        postedAggregates: [row, row],
      }),
    ).toThrow('finance-planning-actuals-duplicate');
  });

  it('requires an authoritative account kind instead of inventing expense for a missing aggregate', () => {
    expect(() =>
      deriveFinanceBudgetVsActuals({
        budget,
        periods,
        snapshotAt: '2026-02-01T12:00:00.000Z',
        postedAggregates: [
          aggregate({
            periodId: periodOne,
            accountId: assetId,
            accountKind: 'asset',
          }),
        ],
      }),
    ).toThrow('finance-planning-account-kind-unavailable');
  });

  it('preserves liability and equity sign basis when posted activity is zero', () => {
    const zeroActivityBudget: FinanceBudgetRevision = {
      ...budget,
      lines: [
        {
          budgetId,
          revision: 1,
          periodId: periodOne,
          accountId: liabilityId,
          currency: 'CAD',
          amount: '100.00',
        },
        {
          budgetId,
          revision: 1,
          periodId: periodTwo,
          accountId: equityId,
          currency: 'CAD',
          amount: '200.00',
        },
      ],
    };
    const result = deriveFinanceBudgetVsActuals({
      budget: zeroActivityBudget,
      periods,
      snapshotAt: '2026-02-01T12:00:00.000Z',
      postedAggregates: [
        aggregate({
          periodId: periodOne,
          accountId: liabilityId,
          accountKind: 'liability',
          journalCount: 0,
          lineCount: 0,
        }),
        aggregate({
          periodId: periodTwo,
          accountId: equityId,
          accountKind: 'equity',
          journalCount: 0,
          lineCount: 0,
        }),
      ],
    });
    expect(result.rows).toMatchObject([
      {
        accountKind: 'liability',
        postedActualAmount: '0',
        varianceAmount: '-100',
        actualSignBasis: 'credit-minus-debit',
        sourceJournalCount: 0,
        sourceLineCount: 0,
      },
      {
        accountKind: 'equity',
        postedActualAmount: '0',
        varianceAmount: '-200',
        actualSignBasis: 'credit-minus-debit',
        sourceJournalCount: 0,
        sourceLineCount: 0,
      },
    ]);
  });
});

describe('normalized Finance forecast snapshots', () => {
  it('uses posted actuals for closed periods and only reviewed assumptions for future periods', () => {
    const assumptions: FinanceForecastAssumptionInput[] = [
      {
        periodId: periodTwo,
        accountId: liabilityId,
        currency: 'CAD',
        amount: '212.25',
        label: 'Approved February liability assumption',
        sourceReference: 'reviewed-plan:2026-02',
        reviewedBy: userId,
        reviewedAt: '2026-01-15T12:00:00.000Z',
      },
    ];
    const result = buildFinanceForecast({
      budget,
      periods,
      asOf: '2026-01-31',
      forecastId,
      revision: 1,
      createdBy: userId,
      snapshotAt: '2026-02-01T12:00:00.000Z',
      openingBalance: {
        status: 'unavailable',
        label: 'opening-balance-unavailable',
      },
      assumptions,
      postedAggregates: [
        aggregate({
          periodId: periodOne,
          accountId: assetId,
          accountKind: 'asset',
          debitAmount: '1.11',
        }),
        aggregate({
          periodId: periodTwo,
          accountId: liabilityId,
          accountKind: 'liability',
          journalCount: 0,
          lineCount: 0,
        }),
      ],
    });
    expect(result.labels).toEqual(['opening-balance-unavailable']);
    expect(result.futureAssumptionsStatus).toBe('provided');
    expect(result.lines).toMatchObject([
      {
        basis: 'posted-actual',
        postedActualAmount: '1.11',
        forecastAmount: '1.11',
      },
      {
        basis: 'reviewed-assumption',
        forecastAmount: '212.25',
        label: null,
      },
    ]);
    expect(result.assumptions).toEqual([
      expect.objectContaining({ forecastId, revision: 1 }),
    ]);
  });

  it('leaves an unprovided future amount null with an explicit label', () => {
    const result = buildFinanceForecast({
      budget,
      periods,
      asOf: '2026-01-31',
      forecastId,
      revision: 2,
      createdBy: userId,
      snapshotAt: '2026-02-01T12:00:00.000Z',
      openingBalance: {
        status: 'available',
        currency: 'CAD',
        amount: '1000.00',
        sourceReference: 'reviewed-opening:2026-01-31',
        reviewedBy: userId,
        reviewedAt: '2026-02-01T11:00:00.000Z',
      },
      assumptions: [],
      postedAggregates: [
        aggregate({
          periodId: periodOne,
          accountId: assetId,
          accountKind: 'asset',
          journalCount: 0,
          lineCount: 0,
        }),
        aggregate({
          periodId: periodTwo,
          accountId: liabilityId,
          accountKind: 'liability',
          journalCount: 0,
          lineCount: 0,
        }),
      ],
    });
    expect(result.futureAssumptionsStatus).toBe('unavailable');
    expect(result.labels).toContain('future-assumption-unavailable');
    expect(result.lines[1]).toMatchObject({
      basis: 'unavailable',
      forecastAmount: null,
      label: 'future-assumption-unavailable',
    });
  });

  it('keeps manual forecast unavailable while retaining zero-activity liability and equity kinds', () => {
    const zeroActivityBudget: FinanceBudgetRevision = {
      ...budget,
      lines: [
        {
          budgetId,
          revision: 1,
          periodId: periodOne,
          accountId: liabilityId,
          currency: 'CAD',
          amount: '100.00',
        },
        {
          budgetId,
          revision: 1,
          periodId: periodTwo,
          accountId: equityId,
          currency: 'CAD',
          amount: '200.00',
        },
      ],
    };
    const result = buildFinanceForecast({
      budget: zeroActivityBudget,
      periods,
      asOf: '2026-01-31',
      forecastId,
      revision: 1,
      createdBy: userId,
      snapshotAt: '2026-02-01T12:00:00.000Z',
      openingBalance: {
        status: 'unavailable',
        label: 'opening-balance-unavailable',
      },
      assumptions: [],
      postedAggregates: [
        aggregate({
          periodId: periodOne,
          accountId: liabilityId,
          accountKind: 'liability',
          journalCount: 0,
          lineCount: 0,
        }),
        aggregate({
          periodId: periodTwo,
          accountId: equityId,
          accountKind: 'equity',
          journalCount: 0,
          lineCount: 0,
        }),
      ],
    });
    expect(result.lines).toMatchObject([
      {
        accountKind: 'liability',
        postedActualAmount: '0',
        forecastAmount: '0',
        basis: 'posted-actual',
        actualSignBasis: 'credit-minus-debit',
      },
      {
        accountKind: 'equity',
        postedActualAmount: '0',
        forecastAmount: null,
        basis: 'unavailable',
        actualSignBasis: 'credit-minus-debit',
        label: 'future-assumption-unavailable',
      },
    ]);
    expect(result.labels).toContain('future-assumption-unavailable');
  });

  it('rejects assumptions that do not belong to a future budget line', () => {
    expect(() =>
      buildFinanceForecast({
        budget,
        periods,
        asOf: '2026-01-31',
        forecastId,
        revision: 1,
        createdBy: userId,
        snapshotAt: '2026-02-01T12:00:00.000Z',
        openingBalance: {
          status: 'unavailable',
          label: 'opening-balance-unavailable',
        },
        assumptions: [
          {
            periodId: periodOne,
            accountId: assetId,
            currency: 'CAD',
            amount: '2.00',
            label: 'Stale assumption',
            sourceReference: 'reviewed-stale',
            reviewedBy: userId,
            reviewedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        postedAggregates: [],
      }),
    ).toThrow('finance-planning-assumption-for-posted-period');
  });
});

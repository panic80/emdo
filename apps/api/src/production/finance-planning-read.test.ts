import { describe, expect, it, vi } from 'vitest';
import {
  readFinancePlanning,
  type FinancePlanningReadPort,
} from './finance-planning-read.js';

const id = (suffix: number) =>
  `72000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const context = {
  workspaceId: id(1),
  userId: id(2),
  sessionId: id(3),
  requestId: id(4),
};
const input = {
  view: 'budget',
  bookId: id(5),
  budgetId: id(6),
  planningRevision: 2,
  offset: 0,
  limit: 10,
};
const header = {
  schemaVersion: 1,
  workspaceId: id(1),
  bookId: id(5),
  budgetId: id(6),
  revision: 2,
  name: 'Operations',
  functionalCurrency: 'CAD',
  createdBy: id(2),
  createdAt: '2026-09-14T12:00:00.000Z',
};
const line = {
  budgetId: id(6),
  revision: 2,
  periodId: id(7),
  accountId: id(8),
  currency: 'CAD',
  amount: '9007199254740993.01',
};
const port = (
  overrides: Partial<FinancePlanningReadPort> = {},
): FinancePlanningReadPort => ({
  listBudgets: vi.fn(),
  getBudget: vi.fn(),
  budgetVsActuals: vi.fn(),
  listForecasts: vi.fn(),
  getForecast: vi.fn(),
  getAutomationResult: vi.fn(),
  ...overrides,
});

describe('normalized planning model reads', () => {
  it('binds saved revision and preserves exact amounts without exposing creator identities', async () => {
    const getBudget = vi.fn().mockResolvedValue({ ...header, lines: [line] });
    const result = await readFinancePlanning(
      port({ getBudget }),
      context,
      input,
    );
    expect(getBudget).toHaveBeenCalledWith(context, id(5), id(6), 2);
    expect(result.records[0]).toMatchObject({
      amount: line.amount,
      revision: 2,
      recordType: 'budget-line',
    });
    expect(result.records[0]).not.toHaveProperty('createdBy');
  });
  it('rejects foreign scope, substituted revision and duplicate line identities', async () => {
    for (const value of [
      { ...header, workspaceId: id(99), lines: [line] },
      { ...header, revision: 3, lines: [line] },
      { ...header, lines: [line, line] },
      { ...header, lines: [{ ...line, revision: 3 }] },
    ])
      await expect(
        readFinancePlanning(
          port({ getBudget: vi.fn().mockResolvedValue(value) }),
          context,
          input,
        ),
      ).rejects.toThrow();
  });
  it('does not replace unavailable saved budgets with empty or zero results', async () => {
    await expect(
      readFinancePlanning(
        port({ getBudget: vi.fn().mockResolvedValue(undefined) }),
        context,
        input,
      ),
    ).rejects.toThrow('api-finance-planning-unavailable');
  });
  it('retains authoritative snapshot coverage when a budget has no actual rows', async () => {
    const actuals = {
      schemaVersion: 1,
      workspaceId: id(1),
      bookId: id(5),
      budgetId: id(6),
      budgetRevision: 2,
      functionalCurrency: 'CAD',
      snapshotAt: header.createdAt,
      actualSource: {
        kind: 'authoritative-posted-ledger',
        coverage: 'posted-journals-in-budget-periods',
        signBasis: 'account-kind',
      },
      rows: [],
    };
    const result = await readFinancePlanning(
      port({ budgetVsActuals: vi.fn().mockResolvedValue(actuals) }),
      context,
      { ...input, view: 'budget-vs-actuals' },
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      snapshotAt: header.createdAt,
      actualSource: actuals.actualSource,
      id: id(6),
      recordType: 'budget-actual-snapshot',
      rowCount: 0,
    });
    expect(result.records[0]).not.toHaveProperty('total');
  });

  it('pages saved result records while retaining provenance and redacting identities', async () => {
    const resultId = id(10);
    const automationRunId = id(11);
    const saved = {
      id: resultId,
      workspaceId: id(1),
      bookId: id(5),
      automationRunId,
      schemaVersion: 1,
      capability: 'finance.planning.budget-vs-actuals',
      budgetId: id(6),
      budgetRevision: 2,
      snapshotAt: header.createdAt,
      payload: {
        schemaVersion: 1,
        workspaceId: id(1),
        bookId: id(5),
        budgetId: id(6),
        budgetRevision: 2,
        functionalCurrency: 'CAD',
        snapshotAt: header.createdAt,
        actualSource: {
          kind: 'authoritative-posted-ledger',
          coverage: 'posted-journals-in-budget-periods',
          signBasis: 'account-kind',
        },
        rows: [
          {
            periodId: id(7),
            periodStart: '2026-09-01',
            periodEnd: '2026-09-30',
            accountId: id(8),
            accountKind: 'expense',
            currency: 'CAD',
            budgetAmount: line.amount,
            postedActualAmount: '0.00',
            varianceAmount: `-${line.amount}`,
            actualSignBasis: 'debit-minus-credit',
            sourceJournalCount: 0,
            sourceLineCount: 0,
          },
        ],
      },
      sourceLineage: {
        budgetId: id(6),
        budgetRevision: 2,
        review: {
          itemCount: 1,
          currency: 'CAD',
          reviewForecastId: null,
          reviewForecastRevision: null,
        },
        sourceJournals: [
          {
            journalId: id(12),
            effectiveOn: '2026-09-15',
            sourceReference: 'journal:12',
            payloadHash: 'a'.repeat(64),
          },
        ],
        canonicalIntentHash: 'b'.repeat(64),
      },
      sourceHash: 'c'.repeat(64),
    };
    const getAutomationResult = vi.fn().mockResolvedValue(saved);
    const output = await readFinancePlanning(
      port({ getAutomationResult }),
      context,
      {
        view: 'planning-result',
        bookId: id(5),
        planningResultId: resultId,
        offset: 0,
        limit: 1,
      },
    );
    expect(getAutomationResult).toHaveBeenCalledWith(
      context,
      id(5),
      resultId,
    );
    expect(output.currency).toBe('CAD');
    expect(output.records[0]).toMatchObject({
      id: resultId,
      recordType: 'planning-result-budget-vs-actuals',
      sourceHash: 'c'.repeat(64),
      sourceLineage: saved.sourceLineage,
      rowCount: 1,
    });
    expect(output.records[1]).toMatchObject({
      budgetAmount: line.amount,
      recordType: 'planning-result-budget-actual-row',
    });
    expect(output.records[2]).toMatchObject({
      recordType: 'planning-result-source-journal',
      payloadHash: 'a'.repeat(64),
    });
    expect(output.records.every((record) => !('createdBy' in record))).toBe(
      true,
    );
    expect(output.records.every((record) => !('reviewedBy' in record))).toBe(
      true,
    );
  });

  it('preserves missing forecast inputs and exact saved amounts without synthesizing totals', async () => {
    const snapshot = {
      schemaVersion: 1,
      workspaceId: id(1),
      bookId: id(5),
      forecastId: id(9),
      revision: 2,
      budgetId: id(6),
      budgetRevision: 2,
      functionalCurrency: 'CAD',
      asOf: '2026-09-14',
      snapshotAt: header.createdAt,
      openingBalance: {
        status: 'unavailable',
        label: 'opening-balance-unavailable',
      },
      futureAssumptionsStatus: 'unavailable',
      labels: ['opening-balance-unavailable', 'future-assumption-unavailable'],
      actualSource: {
        kind: 'authoritative-posted-ledger',
        coverage: 'posted-journals-through-as-of',
        signBasis: 'account-kind',
      },
      assumptionsSource: 'reviewed-inputs-only',
      createdBy: id(2),
      createdAt: header.createdAt,
      lines: [
        {
          periodId: id(7),
          periodStart: '2026-10-01',
          periodEnd: '2026-10-31',
          accountId: id(8),
          accountKind: 'expense',
          currency: 'CAD',
          budgetAmount: line.amount,
          postedActualAmount: '0.00',
          forecastAmount: null,
          basis: 'unavailable',
          actualSignBasis: 'debit-minus-credit',
          label: 'future-assumption-unavailable',
        },
      ],
      assumptions: [],
    };
    const result = await readFinancePlanning(
      port({ getForecast: vi.fn().mockResolvedValue(snapshot) }),
      context,
      { ...input, view: 'forecast', budgetId: null, forecastId: id(9) },
    );
    expect(result.records[0]).toMatchObject({
      openingBalance: snapshot.openingBalance,
      labels: snapshot.labels,
    });
    expect(result.records[1]).toMatchObject({
      forecastAmount: null,
      budgetAmount: line.amount,
    });
    expect(result.records.every((record) => !('createdBy' in record))).toBe(
      true,
    );
  });
});

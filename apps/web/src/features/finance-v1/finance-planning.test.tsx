import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinancePlanning } from './finance-planning.js';

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const bookId = id(1);
const workspaceId = id(2);
const budgetId = id(3);
const periodId = id(4);
const accountId = id(5);
const budgetSummary = {
  schemaVersion: 1 as const,
  workspaceId,
  bookId,
  budgetId,
  revision: 2,
  name: 'Operating plan',
  functionalCurrency: 'CAD' as const,
  createdBy: id(6),
  createdAt: '2026-09-01T00:00:00.000Z',
};
const budget = {
  ...budgetSummary,
  lines: [
    {
      budgetId,
      revision: 2,
      periodId,
      accountId,
      currency: 'CAD' as const,
      amount: '100.00',
    },
  ],
};
const actuals = {
  schemaVersion: 1 as const,
  workspaceId,
  bookId,
  budgetId,
  budgetRevision: 2,
  functionalCurrency: 'CAD' as const,
  snapshotAt: '2026-10-01T00:00:00.000Z',
  actualSource: {
    kind: 'authoritative-posted-ledger' as const,
    coverage: 'posted-journals-in-budget-periods' as const,
    signBasis: 'account-kind' as const,
  },
  rows: [
    {
      periodId,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      accountId,
      accountKind: 'expense' as const,
      currency: 'CAD' as const,
      budgetAmount: '100.00',
      postedActualAmount: '80.00',
      varianceAmount: '20.00',
      actualSignBasis: 'debit-minus-credit' as const,
      sourceJournalCount: 1,
      sourceLineCount: 2,
    },
  ],
};
const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('normalized book planning view', () => {
  it('opens a budget revision and displays service supplied actuals', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/planning/budgets/') && url.includes('vs-actuals'))
        return response(actuals);
      if (url.includes('/planning/budgets/')) return response(budget);
      if (url.includes('/planning/budgets?'))
        return response({ budgets: [budgetSummary], nextOffset: null });
      if (url.includes('/planning/forecasts?'))
        return response({ forecasts: [], nextOffset: null });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    render(<FinancePlanning bookId={bookId} bookName="Operations" />);
    expect(await screen.findByText('Operating plan')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Operating plan/ }));
    expect(await screen.findByText('80.00 CAD')).toBeInTheDocument();
    expect(screen.getByText('20.00 CAD')).toBeInTheDocument();
    expect(
      screen.getByText(/Variances are supplied by the planning service/),
    ).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining(
        `/planning/budgets/${budgetId}/vs-actuals?revision=2`,
      ),
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });
});

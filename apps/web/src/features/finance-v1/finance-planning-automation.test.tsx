import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FinanceAutomationGrant } from '@emdo/contracts/browser';
import { FinancePlanningAutomation } from './finance-planning-automation.js';

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const bookId = id(1);
const workspaceId = id(2);
const budgetId = id(3);
const periodId = id(4);
const accountId = id(5);
const resultId = id(6);
const grant: FinanceAutomationGrant = {
  id: id(7),
  revision: 1,
  workspaceId,
  bookId,
  grantedByUserId: id(8),
  executor: 'emdo-managed',
  specialist: 'finance',
  status: 'active',
  allowedCapabilities: [
    'finance.planning.budget-vs-actuals',
    'finance.planning.forecast',
  ],
  authorityRevision: { membership: 1, bookAccess: 1, entitlement: 1 },
  limits: {
    maxRuns: 10,
    maxAttemptsPerRun: 3,
    maxItemsPerRun: 100,
    maxTotalItems: 1000,
    currency: 'CAD',
    maxAmountPerRun: '0',
    maxTotalAmount: '0',
  },
  validFrom: '2026-01-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const budgetSummary = {
  schemaVersion: 1 as const,
  workspaceId,
  bookId,
  budgetId,
  revision: 2,
  name: 'Operating plan',
  functionalCurrency: 'CAD' as const,
  createdBy: id(8),
  createdAt: '2026-09-01T00:00:00.000Z',
};
const budgetDetail = {
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
const run = {
  run: {
    request: {
      operationId: id(9),
      grantId: grant.id,
      grantRevision: grant.revision,
      workspaceId,
      bookId,
      capability: 'finance.planning.budget-vs-actuals' as const,
      requestHash: 'a'.repeat(64),
      itemCount: 1,
      currency: 'CAD' as const,
      amount: '0',
      planning: {
        schemaVersion: 1 as const,
        capability: 'finance.planning.budget-vs-actuals' as const,
        budgetId,
        budgetRevision: 2,
        asOf: null,
        currency: 'CAD' as const,
        itemCount: 1,
      },
    },
    revision: 1,
    attempts: 1,
    status: 'completed' as const,
    outcomeReference: resultId,
  },
  createdAt: '2026-10-01T00:00:00.000Z',
  blockedReason: null,
};
const result = {
  id: resultId,
  workspaceId,
  bookId,
  automationRunId: run.run.request.operationId,
  schemaVersion: 1 as const,
  capability: 'finance.planning.budget-vs-actuals' as const,
  budgetId,
  budgetRevision: 2,
  snapshotAt: '2026-10-01T00:00:00.000Z',
  payload: {
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
  },
  sourceLineage: {
    budgetId,
    budgetRevision: 2,
    review: {
      itemCount: 1,
      currency: 'CAD' as const,
      reviewForecastId: null,
      reviewForecastRevision: null,
    },
    sourceJournals: [],
    canonicalIntentHash: 'b'.repeat(64),
  },
  sourceHash: 'c'.repeat(64),
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('normalized planning automation UI', () => {
  it('loads saved revisions, opens a completed result, and sends a scoped run', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return response(run);
      if (url.includes('/planning/results/')) return response(result);
      if (url.includes('/planning/budgets/') && url.includes('revision=2'))
        return response(budgetDetail);
      if (url.includes('/planning/budgets?'))
        return response({ budgets: [budgetSummary], nextOffset: null });
      if (url.includes('/planning/forecasts?'))
        return response({ forecasts: [], nextOffset: null });
      if (url.includes('/automations/runs?'))
        return response({ runs: [run], nextOffset: null });
      if (url.endsWith('/automations/schedules/options'))
        return response({ tzdbVersion: '2026a' });
      if (url.includes('/automations/schedules?'))
        return response({ schedules: [] });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    render(
      <FinancePlanningAutomation
        bookId={bookId}
        bookName="Operations"
        grants={[grant]}
        csrfToken="csrf"
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Open planning workflows' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Run a planning workflow' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Operating plan · revision 2 · CAD'),
    ).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Open result' }));
    expect(
      await screen.findByRole('heading', { name: 'Saved result' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('80.00 CAD')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close result' }));
    fireEvent.click(
      screen.getByRole('button', { name: /Run budget versus actuals/ }),
    );
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(([, init]) => init?.method === 'POST'),
      ).toBe(true),
    );
    const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
    const body = JSON.parse(String(post?.[1]?.body));
    expect(body).toMatchObject({
      targets: [budgetId],
      currency: 'CAD',
      amount: '0',
      planning: {
        budgetId,
        budgetRevision: 2,
        itemCount: 1,
        asOf: null,
      },
    });
  });
});

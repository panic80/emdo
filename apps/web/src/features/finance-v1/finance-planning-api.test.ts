import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  FinanceAutomationGrant,
  FinanceBudgetRevision,
  FinanceForecastSnapshot,
} from '@emdo/contracts/browser';
import {
  enqueuePlanningRun,
  planningIntentFromBudget,
  planningIntentFromForecast,
  readPlanningCatalog,
} from './finance-planning-api.js';

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const bookId = id(1);
const workspaceId = id(2);
const budgetId = id(3);
const forecastId = id(4);
const periodId = id(5);
const accountId = id(6);
const grant: FinanceAutomationGrant = {
  id: id(7),
  revision: 2,
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
    maxRuns: 20,
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
const budget: FinanceBudgetRevision = {
  schemaVersion: 1,
  workspaceId,
  bookId,
  budgetId,
  revision: 2,
  name: 'Operating plan',
  functionalCurrency: 'CAD',
  createdBy: id(8),
  createdAt: '2026-09-01T00:00:00.000Z',
  lines: [
    {
      budgetId,
      revision: 2,
      periodId,
      accountId,
      currency: 'CAD',
      amount: '1200.00',
    },
  ],
};
const forecast: FinanceForecastSnapshot = {
  schemaVersion: 1,
  workspaceId,
  bookId,
  forecastId,
  revision: 1,
  budgetId,
  budgetRevision: 2,
  functionalCurrency: 'CAD',
  asOf: '2026-09-30',
  snapshotAt: '2026-10-01T00:00:00.000Z',
  openingBalance: {
    status: 'available',
    currency: 'CAD',
    amount: '10.00',
    sourceReference: 'review:opening',
    reviewedBy: id(8),
    reviewedAt: '2026-10-01T00:00:00.000Z',
  },
  futureAssumptionsStatus: 'provided',
  labels: [],
  actualSource: {
    kind: 'authoritative-posted-ledger',
    coverage: 'posted-journals-through-as-of',
    signBasis: 'account-kind',
  },
  assumptionsSource: 'reviewed-inputs-only',
  createdBy: id(8),
  createdAt: '2026-10-01T00:00:00.000Z',
  lines: [
    {
      periodId,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      accountId,
      accountKind: 'expense',
      currency: 'CAD',
      budgetAmount: '1200.00',
      postedActualAmount: '0.00',
      forecastAmount: '1250.00',
      basis: 'reviewed-assumption',
      actualSignBasis: 'debit-minus-credit',
      label: null,
    },
  ],
  assumptions: [
    {
      forecastId,
      revision: 1,
      periodId,
      accountId,
      currency: 'CAD',
      amount: '1250.00',
      label: 'Reviewed October spend',
      sourceReference: 'review:october',
      reviewedBy: id(8),
      reviewedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('normalized planning browser client', () => {
  it('loads the normalized catalog and creates exact budget and forecast intents', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/planning/budgets')
          ? response({
              budgets: [
                {
                  ...budget,
                  lines: undefined,
                },
              ],
              nextOffset: null,
            })
          : response({
              forecasts: [
                {
                  ...forecast,
                  lines: undefined,
                  assumptions: undefined,
                  openingBalance: undefined,
                },
              ],
              nextOffset: null,
            }),
      ),
    );
    const catalog = await readPlanningCatalog(
      bookId,
      new AbortController().signal,
    );
    expect(catalog.budgets[0]?.revision).toBe(2);
    expect(catalog.forecasts[0]?.budgetRevision).toBe(2);
    expect(planningIntentFromBudget(budget)).toMatchObject({
      capability: 'finance.planning.budget-vs-actuals',
      budgetRevision: 2,
      itemCount: 1,
      asOf: null,
    });
    expect(planningIntentFromForecast(budget, forecast)).toMatchObject({
      capability: 'finance.planning.forecast',
      budgetRevision: 2,
      itemCount: 1,
      asOf: '2026-09-30',
      openingBalance: forecast.openingBalance,
      assumptions: [
        expect.objectContaining({
          periodId,
          accountId,
          amount: '1250.00',
        }),
      ],
    });
  });

  it('posts a planning run with zero reserved amount and the full reviewed intent', async () => {
    const run = {
      run: {
        request: {
          operationId: id(9),
          grantId: grant.id,
          grantRevision: grant.revision,
          workspaceId,
          bookId,
          capability: 'finance.planning.forecast',
          requestHash: 'a'.repeat(64),
          itemCount: 1,
          currency: 'CAD',
          amount: '0',
          planning: planningIntentFromForecast(budget, forecast),
        },
        revision: 1,
        attempts: 0,
        status: 'queued',
        outcomeReference: null,
      },
      createdAt: '2026-10-01T00:00:00.000Z',
      blockedReason: null,
    };
    const fetcher = vi.fn(async (...args: [string, RequestInit?]) => {
      void args;
      return response(run);
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await enqueuePlanningRun(
      bookId,
      grant,
      planningIntentFromForecast(budget, forecast),
      'csrf',
      id(10),
      new AbortController().signal,
    );
    expect(result.run.request.planning?.budgetRevision).toBe(2);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      grantId: grant.id,
      capability: 'finance.planning.forecast',
      targets: [budgetId],
      currency: 'CAD',
      amount: '0',
      planning: {
        budgetId,
        budgetRevision: 2,
        asOf: '2026-09-30',
      },
    });
    expect(body.planning.openingBalance).toEqual(forecast.openingBalance);
    expect(body.planning.assumptions).toHaveLength(1);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-csrf-token': 'csrf',
      'idempotency-key': id(10),
    });
  });
});

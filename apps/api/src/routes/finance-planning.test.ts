import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  EffectiveAuthorizationScopeFingerprintSchema,
  type FinanceBudgetRevision,
  type FinanceBudgetVsActuals,
  type FinancePlanningAutomationResult,
} from '@emdo/contracts';

import { installProblemHandler } from '../problem.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';
import {
  registerFinancePlanningRoutes,
  type FinancePlanningRouteService,
} from './finance-planning.js';

const userId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70';
const sessionId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71';
const requestId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f78';
const workspaceId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f72';
const bookId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f73';
const budgetId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f74';
const periodId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f75';
const accountId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f76';
const idempotencyKey = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f77';
const automationRunId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f79';
const resultId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f80';

const principal: AuthenticatedPrincipal = {
  userId,
  sessionId,
  householdId: workspaceId,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: userId,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('7'.repeat(64)),
};

const budget: FinanceBudgetRevision = {
  schemaVersion: 1,
  workspaceId,
  bookId,
  budgetId,
  revision: 1,
  name: 'FY26 operating plan',
  functionalCurrency: 'CAD',
  createdBy: userId,
  createdAt: '2026-09-14T00:00:00.000Z',
  lines: [
    {
      budgetId,
      revision: 1,
      periodId,
      accountId,
      currency: 'CAD',
      amount: '4.25',
    },
  ],
};
const budgetSummary = (() => {
  const summary: Omit<FinanceBudgetRevision, 'lines'> & {
    lines?: FinanceBudgetRevision['lines'];
  } = { ...budget };
  delete summary.lines;
  return summary;
})();

const actuals: FinanceBudgetVsActuals = {
  schemaVersion: 1,
  workspaceId,
  bookId,
  budgetId,
  budgetRevision: 1,
  functionalCurrency: 'CAD',
  snapshotAt: '2026-09-14T00:00:00.000Z',
  actualSource: {
    kind: 'authoritative-posted-ledger',
    coverage: 'posted-journals-in-budget-periods',
    signBasis: 'account-kind',
  },
  rows: [],
};

const planningResult: FinancePlanningAutomationResult = {
  id: resultId,
  workspaceId,
  bookId,
  automationRunId,
  schemaVersion: 1,
  capability: 'finance.planning.budget-vs-actuals',
  budgetId,
  budgetRevision: 1,
  snapshotAt: '2026-09-14T00:00:00.000Z',
  payload: {
    schemaVersion: 1,
    workspaceId,
    bookId,
    budgetId,
    budgetRevision: 1,
    functionalCurrency: 'CAD',
    snapshotAt: '2026-09-14T00:00:00.000Z',
    actualSource: {
      kind: 'authoritative-posted-ledger',
      coverage: 'posted-journals-in-budget-periods',
      signBasis: 'account-kind',
    },
    rows: [
      {
        periodId,
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        accountId,
        accountKind: 'expense',
        currency: 'CAD',
        budgetAmount: '4.25',
        postedActualAmount: '0',
        varianceAmount: '-4.25',
        actualSignBasis: 'debit-minus-credit',
        sourceJournalCount: 0,
        sourceLineCount: 0,
      },
    ],
  },
  sourceLineage: {
    budgetId,
    budgetRevision: 1,
    review: {
      itemCount: 1,
      currency: 'CAD',
      reviewForecastId: null,
      reviewForecastRevision: null,
    },
    sourceJournals: [],
    canonicalIntentHash: 'a'.repeat(64),
  },
  sourceHash: 'b'.repeat(64),
};

async function fixture(
  options: { ready?: boolean; authenticated?: boolean; csrf?: boolean } = {},
) {
  const auth = {
    authenticate: vi.fn(async () =>
      options.authenticated === false ? undefined : principal,
    ),
    verifyMutation: vi.fn(async () => options.csrf !== false),
  } as unknown as ApiServices['auth'];
  const api: FinancePlanningRouteService = {
    checkReady: vi.fn(async () => options.ready !== false),
    listBudgets: vi.fn(async () => ({
      budgets: [budgetSummary],
      nextOffset: null,
    })),
    getBudget: vi.fn(async () => budget),
    saveBudget: vi.fn(async () => budget),
    budgetVsActuals: vi.fn(async () => actuals),
    getAutomationResult: vi.fn(async () => planningResult),
    listForecasts: vi.fn(async () => ({ forecasts: [], nextOffset: null })),
    getForecast: vi.fn(async () => null),
    saveForecast: vi.fn(async () => {
      throw new Error('unused');
    }),
  };
  const services = {
    ...createFailClosedApiServices({ auth }),
    financePlanning: api,
  };
  const app = Fastify({ logger: false, genReqId: () => requestId });
  installProblemHandler(app);
  registerFinancePlanningRoutes(app, services, 1_000_000);
  return { app, api };
}

describe('normalized Finance planning HTTP boundary', () => {
  it('reads only the current book scope and exposes authoritative actual metadata', async () => {
    const { app, api } = await fixture();
    try {
      const list = await app.inject({
        method: 'GET',
        url: `/api/v2/finance/books/${bookId}/planning/budgets`,
        headers: { cookie: '__Secure-emdo.session_token=current' },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({
        budgets: [budgetSummary],
        nextOffset: null,
      });
      expect(api.listBudgets).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId, userId }),
        bookId,
        0,
        50,
      );

      const comparison = await app.inject({
        method: 'GET',
        url: `/api/v2/finance/books/${bookId}/planning/budgets/${budgetId}/vs-actuals`,
        headers: { cookie: '__Secure-emdo.session_token=current' },
      });
      expect(comparison.statusCode).toBe(200);
      expect(comparison.json().actualSource).toEqual(actuals.actualSource);
    } finally {
      await app.close();
    }
  });

  it('reads one immutable saved planning result within the requested book scope', async () => {
    const { app, api } = await fixture();
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v2/finance/books/${bookId}/planning/results/${resultId}`,
        headers: { cookie: '__Secure-emdo.session_token=current' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(planningResult);
      expect(api.getAutomationResult).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId, userId }),
        bookId,
        resultId,
      );
    } finally {
      await app.close();
    }
  });

  it('requires mutation proof and forwards the idempotency key for budget saves', async () => {
    const { app, api } = await fixture();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v2/finance/books/${bookId}/planning/budgets`,
        headers: {
          cookie: '__Secure-emdo.session_token=current',
          'idempotency-key': idempotencyKey,
        },
        payload: {
          name: budget.name,
          lines: budget.lines.map(
            ({ periodId, accountId, currency, amount }) => ({
              periodId,
              accountId,
              currency,
              amount,
            }),
          ),
        },
      });
      expect(response.statusCode).toBe(200);
      expect(api.saveBudget).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId, userId }),
        bookId,
        idempotencyKey,
        expect.objectContaining({ name: budget.name }),
      );
    } finally {
      await app.close();
    }
  });

  it.each([
    { authenticated: false, status: 401 },
    { csrf: false, status: 403 },
    { ready: false, status: 503 },
  ])('fails closed for %j', async (options) => {
    const { app, api } = await fixture(options);
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v2/finance/books/${bookId}/planning/budgets`,
        headers: {
          cookie: '__Secure-emdo.session_token=current',
          'idempotency-key': idempotencyKey,
        },
        payload: {
          name: budget.name,
          lines: budget.lines.map(
            ({ periodId, accountId, currency, amount }) => ({
              periodId,
              accountId,
              currency,
              amount,
            }),
          ),
        },
      });
      expect(response.statusCode).toBe(options.status);
      expect(api.saveBudget).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

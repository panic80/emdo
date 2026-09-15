import { z } from 'zod';
import {
  FinanceAutomationPlanningIntentSchema,
  FinanceAutomationRunRecordSchema,
  FinanceBudgetVsActualsSchema,
  FinanceBudgetRevisionSchema,
  FinanceBudgetSummarySchema,
  FinanceForecastSnapshotSchema,
  FinanceForecastSummarySchema,
  FinancePlanningAutomationResultSchema,
  type FinanceAutomationGrant,
  type FinanceAutomationPlanningIntent,
  type FinanceBudgetRevision,
  type FinanceForecastSnapshot,
} from '@emdo/contracts/browser';

const PlanningPageSchema = z.strictObject({
  budgets: z.array(FinanceBudgetSummarySchema).max(100),
  nextOffset: z.number().int().nonnegative().nullable(),
});

const ForecastPageSchema = z.strictObject({
  forecasts: z.array(FinanceForecastSummarySchema).max(100),
  nextOffset: z.number().int().nonnegative().nullable(),
});

const RunPageSchema = z.strictObject({
  runs: z.array(FinanceAutomationRunRecordSchema).max(100),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export type FinancePlanningBudget = z.infer<typeof FinanceBudgetSummarySchema>;
export type FinancePlanningForecast = z.infer<
  typeof FinanceForecastSummarySchema
>;
export type FinancePlanningRunRecord = z.infer<
  typeof FinanceAutomationRunRecordSchema
>;
export type FinancePlanningResult = z.infer<
  typeof FinancePlanningAutomationResultSchema
>;

export class FinancePlanningRequestError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
  ) {
    super(
      status === 401 || status === 403
        ? 'Current access does not permit this planning operation.'
        : status === 404
          ? 'The selected planning record is no longer available. Refresh the book and choose it again.'
          : status === 409
            ? 'The selected planning revision changed. Refresh the book and try again.'
            : status === 503
              ? 'Normalized planning is not available in this environment yet.'
              : `Unable to ${operation}. Try again or refresh the book.`,
    );
  }
}

const base = (bookId: string) =>
  `/api/v2/finance/books/${encodeURIComponent(bookId)}`;

async function request(
  url: string,
  signal: AbortSignal,
  mutation?: { body: unknown; csrf: string; key: string },
) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    ...(mutation
      ? {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-csrf-token': mutation.csrf,
            'idempotency-key': mutation.key,
          },
          body: JSON.stringify(mutation.body),
        }
      : { headers: { accept: 'application/json' } }),
  });
  if (!response.ok)
    throw new FinancePlanningRequestError(
      response.status,
      'load planning data',
    );
  return response.json() as Promise<unknown>;
}

function assertBookScope<T extends { workspaceId: string; bookId: string }>(
  value: T,
  bookId: string,
) {
  if (value.bookId !== bookId)
    throw new Error('Unexpected planning book scope');
  return value;
}

export async function readPlanningCatalog(bookId: string, signal: AbortSignal) {
  const [budgetRaw, forecastRaw] = await Promise.all([
    request(`${base(bookId)}/planning/budgets?offset=0&limit=100`, signal),
    request(`${base(bookId)}/planning/forecasts?offset=0&limit=100`, signal),
  ]);
  const budgets = PlanningPageSchema.parse(budgetRaw);
  const forecasts = ForecastPageSchema.parse(forecastRaw);
  return {
    budgets: budgets.budgets.map((value) => assertBookScope(value, bookId)),
    forecasts: forecasts.forecasts.map((value) =>
      assertBookScope(value, bookId),
    ),
  };
}

export async function readPlanningBudget(
  bookId: string,
  budgetId: string,
  revision: number,
  signal: AbortSignal,
): Promise<FinanceBudgetRevision> {
  const result = FinanceBudgetRevisionSchema.parse(
    await request(
      `${base(bookId)}/planning/budgets/${encodeURIComponent(budgetId)}?revision=${revision}`,
      signal,
    ),
  );
  if (result.budgetId !== budgetId || result.revision !== revision)
    throw new Error('Unexpected planning budget revision');
  return assertBookScope(result, bookId);
}

export async function readBudgetVsActuals(
  bookId: string,
  budgetId: string,
  revision: number,
  signal: AbortSignal,
) {
  const result = FinanceBudgetVsActualsSchema.parse(
    await request(
      `${base(bookId)}/planning/budgets/${encodeURIComponent(budgetId)}/vs-actuals?revision=${revision}`,
      signal,
    ),
  );
  if (result.budgetId !== budgetId || result.budgetRevision !== revision)
    throw new Error('Unexpected budget versus actuals revision');
  return assertBookScope(result, bookId);
}

export async function readPlanningForecast(
  bookId: string,
  forecastId: string,
  revision: number,
  signal: AbortSignal,
): Promise<FinanceForecastSnapshot> {
  const result = FinanceForecastSnapshotSchema.parse(
    await request(
      `${base(bookId)}/planning/forecasts/${encodeURIComponent(forecastId)}?revision=${revision}`,
      signal,
    ),
  );
  if (result.forecastId !== forecastId || result.revision !== revision)
    throw new Error('Unexpected planning forecast revision');
  return assertBookScope(result, bookId);
}

export function planningIntentFromBudget(
  budget: FinanceBudgetRevision,
): FinanceAutomationPlanningIntent {
  return FinanceAutomationPlanningIntentSchema.parse({
    schemaVersion: 1,
    capability: 'finance.planning.budget-vs-actuals',
    budgetId: budget.budgetId,
    budgetRevision: budget.revision,
    asOf: null,
    currency: budget.functionalCurrency,
    itemCount: budget.lines.length,
  });
}

export function planningIntentFromForecast(
  budget: FinanceBudgetRevision,
  forecast: FinanceForecastSnapshot,
): FinanceAutomationPlanningIntent {
  if (
    forecast.budgetId !== budget.budgetId ||
    forecast.budgetRevision !== budget.revision ||
    forecast.functionalCurrency !== budget.functionalCurrency
  )
    throw new Error(
      'The reviewed forecast must use the selected budget revision and functional currency.',
    );
  return FinanceAutomationPlanningIntentSchema.parse({
    schemaVersion: 1,
    capability: 'finance.planning.forecast',
    budgetId: budget.budgetId,
    budgetRevision: budget.revision,
    asOf: forecast.asOf,
    currency: forecast.functionalCurrency,
    itemCount: budget.lines.length,
    openingBalance: forecast.openingBalance,
    assumptions: forecast.assumptions.map((assumption) => ({
      periodId: assumption.periodId,
      accountId: assumption.accountId,
      currency: assumption.currency,
      amount: assumption.amount,
      label: assumption.label,
      sourceReference: assumption.sourceReference,
      reviewedBy: assumption.reviewedBy,
      reviewedAt: assumption.reviewedAt,
    })),
  });
}

export async function enqueuePlanningRun(
  bookId: string,
  grant: FinanceAutomationGrant,
  planning: FinanceAutomationPlanningIntent,
  csrf: string,
  key: string,
  signal: AbortSignal,
) {
  const result = FinanceAutomationRunRecordSchema.parse(
    await request(`${base(bookId)}/automations/runs`, signal, {
      body: {
        grantId: grant.id,
        capability: planning.capability,
        targets: [planning.budgetId],
        currency: planning.currency,
        amount: '0',
        planning,
      },
      csrf,
      key,
    }),
  );
  if (result.run.request.bookId !== bookId)
    throw new Error('Unexpected automation book scope');
  if (result.run.request.planning?.budgetId !== planning.budgetId)
    throw new Error('Unexpected automation planning target');
  return result;
}

export async function readPlanningRuns(
  bookId: string,
  offset: number,
  signal: AbortSignal,
) {
  const result = RunPageSchema.parse(
    await request(
      `${base(bookId)}/automations/runs?offset=${offset}&limit=50`,
      signal,
    ),
  );
  if (result.runs.some((value) => value.run.request.bookId !== bookId))
    throw new Error('Unexpected planning run scope');
  return {
    ...result,
    runs: result.runs.filter(
      (value) => value.run.request.planning !== undefined,
    ),
  };
}

export async function readPlanningResult(
  bookId: string,
  resultId: string,
  signal: AbortSignal,
): Promise<FinancePlanningResult> {
  const result = FinancePlanningAutomationResultSchema.parse(
    await request(
      `${base(bookId)}/planning/results/${encodeURIComponent(resultId)}`,
      signal,
    ),
  );
  if (result.id !== resultId) throw new Error('Unexpected planning result id');
  return assertBookScope(result, bookId);
}

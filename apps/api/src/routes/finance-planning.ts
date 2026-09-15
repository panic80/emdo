import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  FinanceBudgetListSchema,
  FinanceBudgetRevisionSchema,
  FinanceBudgetVsActualsSchema,
  FinancePlanningAutomationResultSchema,
  FinanceForecastListSchema,
  FinanceForecastSnapshotSchema,
  FinancePlanningPageQuerySchema,
  SaveFinanceBudgetSchema,
  SaveFinanceForecastSchema,
  UuidSchema,
  workspaceContextFromLegacyPrincipal,
  type WorkspaceContext,
} from '@emdo/contracts';

import { ApiProblem, serviceContractProblem } from '../problem.js';
import {
  parseRequest,
  parseServiceResponse,
  prepareAuthenticatedMutation,
  requirePrincipal,
  takePreparedMutation,
} from '../request-context.js';
import type { ApiServices } from '../services/contracts.js';

export interface FinancePlanningRouteService {
  checkReady(): Promise<boolean>;
  listBudgets(
    context: WorkspaceContext,
    bookId: string,
    offset?: number,
    limit?: number,
  ): Promise<unknown>;
  getBudget(
    context: WorkspaceContext,
    bookId: string,
    budgetId: string,
    revision?: number,
  ): Promise<unknown>;
  saveBudget(
    context: WorkspaceContext,
    bookId: string,
    idempotencyKey: string,
    input: unknown,
  ): Promise<unknown>;
  budgetVsActuals(
    context: WorkspaceContext,
    bookId: string,
    budgetId: string,
    revision?: number,
  ): Promise<unknown>;
  getAutomationResult(
    context: WorkspaceContext,
    bookId: string,
    resultId: string,
  ): Promise<unknown>;
  listForecasts(
    context: WorkspaceContext,
    bookId: string,
    offset?: number,
    limit?: number,
  ): Promise<unknown>;
  getForecast(
    context: WorkspaceContext,
    bookId: string,
    forecastId: string,
    revision?: number,
  ): Promise<unknown>;
  saveForecast(
    context: WorkspaceContext,
    bookId: string,
    idempotencyKey: string,
    input: unknown,
  ): Promise<unknown>;
}

export type FinancePlanningRouteServices = ApiServices & {
  readonly financePlanning?: FinancePlanningRouteService;
};

const Params = z.strictObject({
  bookId: UuidSchema,
  budgetId: UuidSchema.optional(),
  forecastId: UuidSchema.optional(),
});

const RevisionQuery = z.strictObject({
  revision: z.coerce.number().int().positive().max(2_147_483_646).optional(),
});

const planningError = (cause: unknown): ApiProblem | undefined => {
  if (
    !(cause instanceof Error) ||
    cause.name !== 'FinancePlanningPersistenceError'
  )
    return undefined;
  const code = 'code' in cause ? String(cause.code) : 'unavailable';
  return new ApiProblem({
    status:
      code === 'authorization-revoked'
        ? 403
        : code === 'invalid-input'
          ? 400
          : code === 'conflict'
            ? 409
            : 503,
    code: `finance-planning-${code}`,
    title: 'Finance planning request could not be completed',
    detail:
      code === 'authorization-revoked'
        ? 'Current book access does not permit this planning operation.'
        : code === 'invalid-input'
          ? 'Check the selected periods, accounts, currencies, and reviewed inputs.'
          : code === 'conflict'
            ? 'The planning revision or source changed. Refresh the book and try again.'
            : 'The normalized planning service is unavailable or not ready.',
  });
};

const call = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (cause) {
    const problem = planningError(cause);
    if (problem) throw problem;
    throw cause;
  }
};

const requireReady = async (services: FinancePlanningRouteServices) => {
  const service = services.financePlanning;
  if (!service || !(await service.checkReady().catch(() => false)))
    throw new ApiProblem({
      status: 503,
      code: 'finance-planning-unavailable',
      title: 'Finance planning unavailable',
      detail: 'The normalized planning service is not enabled or ready.',
    });
  return service;
};

const scoped = <T extends { workspaceId: string; bookId: string }>(
  value: T,
  context: WorkspaceContext,
  bookId: string,
) => {
  if (value.workspaceId !== context.workspaceId || value.bookId !== bookId)
    throw serviceContractProblem();
  return value;
};

export function registerFinancePlanningRoutes(
  app: FastifyInstance,
  services: FinancePlanningRouteServices,
  bodyLimit: number,
) {
  const base = '/api/v2/finance/books/:bookId/planning';

  app.get(`${base}/budgets`, async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const { bookId } = parseRequest(Params, request.params);
    const page = parseRequest(FinancePlanningPageQuerySchema, request.query);
    const scope = workspaceContextFromLegacyPrincipal(principal, request.id);
    const result = parseServiceResponse(
      FinanceBudgetListSchema,
      await call(() =>
        requireReady(services).then((service) =>
          service.listBudgets(scope, bookId, page.offset, page.limit),
        ),
      ),
    );
    if (
      result.budgets.some(
        (budget) =>
          budget.workspaceId !== scope.workspaceId || budget.bookId !== bookId,
      )
    )
      throw serviceContractProblem();
    return reply.header('cache-control', 'no-store, private').send(result);
  });

  app.get(`${base}/budgets/:budgetId`, async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const { bookId, budgetId } = parseRequest(Params, request.params);
    const { revision } = parseRequest(RevisionQuery, request.query);
    const scope = workspaceContextFromLegacyPrincipal(principal, request.id);
    const raw = await call(() =>
      requireReady(services).then((service) =>
        service.getBudget(scope, bookId, budgetId!, revision),
      ),
    );
    if (raw === null) {
      throw new ApiProblem({
        status: 404,
        code: 'finance-budget-not-found',
        title: 'Budget not found',
        detail: 'The requested normalized budget is unavailable in this book.',
      });
    }
    const result = scoped(
      parseServiceResponse(FinanceBudgetRevisionSchema, raw),
      scope,
      bookId,
    );
    if (
      result.budgetId !== budgetId ||
      (revision !== undefined && result.revision !== revision)
    )
      throw serviceContractProblem();
    return reply.header('cache-control', 'no-store, private').send(result);
  });

  app.get(`${base}/budgets/:budgetId/vs-actuals`, async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const { bookId, budgetId } = parseRequest(Params, request.params);
    const { revision } = parseRequest(RevisionQuery, request.query);
    const scope = workspaceContextFromLegacyPrincipal(principal, request.id);
    const result = scoped(
      parseServiceResponse(
        FinanceBudgetVsActualsSchema,
        await call(() =>
          requireReady(services).then((service) =>
            service.budgetVsActuals(scope, bookId, budgetId!, revision),
          ),
        ),
      ),
      scope,
      bookId,
    );
    if (
      result.budgetId !== budgetId ||
      (revision !== undefined && result.budgetRevision !== revision)
    )
      throw serviceContractProblem();
    return reply.header('cache-control', 'no-store, private').send(result);
  });

  app.get(`${base}/results/:id`, async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const { bookId, id } = parseRequest(
      z.strictObject({ bookId: UuidSchema, id: UuidSchema }),
      request.params,
    );
    const scope = workspaceContextFromLegacyPrincipal(principal, request.id);
    const raw = await call(() =>
      requireReady(services).then((service) =>
        service.getAutomationResult(scope, bookId, id),
      ),
    );
    if (raw === null) {
      throw new ApiProblem({
        status: 404,
        code: 'finance-planning-result-not-found',
        title: 'Planning result not found',
        detail:
          'The requested saved planning result is unavailable in this book.',
      });
    }
    const result = parseServiceResponse(
      FinancePlanningAutomationResultSchema,
      raw,
    );
    if (
      result.id !== id ||
      result.workspaceId !== scope.workspaceId ||
      result.bookId !== bookId
    )
      throw serviceContractProblem();
    return reply.header('cache-control', 'no-store, private').send(result);
  });

  app.post(
    `${base}/budgets`,
    {
      bodyLimit,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      const { bookId } = parseRequest(Params, request.params);
      const input = parseRequest(SaveFinanceBudgetSchema, request.body);
      const scope = workspaceContextFromLegacyPrincipal(principal, request.id);
      const result = scoped(
        parseServiceResponse(
          FinanceBudgetRevisionSchema,
          await call(() =>
            requireReady(services).then((service) =>
              service.saveBudget(scope, bookId, idempotencyKey, input),
            ),
          ),
        ),
        scope,
        bookId,
      );
      return reply.header('cache-control', 'no-store, private').send(result);
    },
  );

  app.get(`${base}/forecasts`, async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const { bookId } = parseRequest(Params, request.params);
    const page = parseRequest(FinancePlanningPageQuerySchema, request.query);
    const scope = workspaceContextFromLegacyPrincipal(principal, request.id);
    const result = parseServiceResponse(
      FinanceForecastListSchema,
      await call(() =>
        requireReady(services).then((service) =>
          service.listForecasts(scope, bookId, page.offset, page.limit),
        ),
      ),
    );
    if (
      result.forecasts.some(
        (forecast) =>
          forecast.workspaceId !== scope.workspaceId ||
          forecast.bookId !== bookId,
      )
    )
      throw serviceContractProblem();
    return reply.header('cache-control', 'no-store, private').send(result);
  });

  app.get(`${base}/forecasts/:forecastId`, async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const { bookId, forecastId } = parseRequest(Params, request.params);
    const { revision } = parseRequest(RevisionQuery, request.query);
    const scope = workspaceContextFromLegacyPrincipal(principal, request.id);
    const raw = await call(() =>
      requireReady(services).then((service) =>
        service.getForecast(scope, bookId, forecastId!, revision),
      ),
    );
    if (raw === null)
      throw new ApiProblem({
        status: 404,
        code: 'finance-forecast-not-found',
        title: 'Forecast not found',
        detail: 'The requested forecast snapshot is unavailable in this book.',
      });
    const result = scoped(
      parseServiceResponse(FinanceForecastSnapshotSchema, raw),
      scope,
      bookId,
    );
    if (
      result.forecastId !== forecastId ||
      (revision !== undefined && result.revision !== revision)
    )
      throw serviceContractProblem();
    return reply.header('cache-control', 'no-store, private').send(result);
  });

  app.post(
    `${base}/forecasts`,
    {
      bodyLimit,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      const { bookId } = parseRequest(Params, request.params);
      const input = parseRequest(SaveFinanceForecastSchema, request.body);
      const scope = workspaceContextFromLegacyPrincipal(principal, request.id);
      const result = scoped(
        parseServiceResponse(
          FinanceForecastSnapshotSchema,
          await call(() =>
            requireReady(services).then((service) =>
              service.saveForecast(scope, bookId, idempotencyKey, input),
            ),
          ),
        ),
        scope,
        bookId,
      );
      return reply.header('cache-control', 'no-store, private').send(result);
    },
  );
}

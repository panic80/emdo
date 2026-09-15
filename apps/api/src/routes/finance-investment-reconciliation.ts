import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PreviewInvestmentReconciliationSchema,
  CreateInvestmentReconciliationSchema,
  ResolveInvestmentReconciliationSchema,
  ReopenInvestmentReconciliationSchema,
  InvestmentReconciliationPreviewSchema,
  InvestmentReconciliationCaseSchema,
  InvestmentReconciliationListSchema,
  InvestmentReconciliationCorrectiveRecordListSchema,
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

export interface FinanceInvestmentReconciliationRouteService {
  checkReady(): Promise<boolean>;
  correctiveRecords(
    context: WorkspaceContext,
    bookId: string,
    caseId: string,
    offset?: number,
    limit?: number,
  ): Promise<unknown>;
  preview(
    context: WorkspaceContext,
    bookId: string,
    input: unknown,
  ): Promise<unknown>;
  list(
    context: WorkspaceContext,
    bookId: string,
    offset?: number,
    limit?: number,
  ): Promise<unknown>;
  get(
    context: WorkspaceContext,
    bookId: string,
    caseId: string,
  ): Promise<unknown>;
  create(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ): Promise<unknown>;
  resolve(
    context: WorkspaceContext,
    bookId: string,
    caseId: string,
    key: string,
    input: unknown,
  ): Promise<unknown>;
  reopen(
    context: WorkspaceContext,
    bookId: string,
    caseId: string,
    key: string,
    input: unknown,
  ): Promise<unknown>;
}
const Params = z.strictObject({
  bookId: UuidSchema,
  caseId: UuidSchema.optional(),
});
const Page = z.strictObject({
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
async function call<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      cause.name !== 'FinanceInvestmentReconciliationPersistenceError'
    )
      throw cause;
    const candidate = 'code' in cause ? String(cause.code) : 'unavailable';
    const code = [
      'authorization-revoked',
      'invalid-input',
      'conflict',
    ].includes(candidate)
      ? candidate
      : 'unavailable';
    throw new ApiProblem({
      status:
        code === 'authorization-revoked'
          ? 403
          : code === 'invalid-input'
            ? 400
            : code === 'conflict'
              ? 409
              : 503,
      code: `finance-investment-reconciliation-${code}`,
      title: 'Investment reconciliation request could not be completed',
      detail:
        code === 'authorization-revoked'
          ? 'Current book access does not permit this operation.'
          : code === 'invalid-input'
            ? 'Check the selected comparison, evidence, and corrective records.'
            : code === 'conflict'
              ? 'The reconciliation revision or sources changed. Refresh and review the comparison.'
              : 'The saved reconciliation service is unavailable or not ready.',
    });
  }
}
export function registerFinanceInvestmentReconciliationRoutes(
  app: FastifyInstance,
  services: ApiServices,
  bodyLimit: number,
) {
  const base = '/api/v2/finance/books/:bookId/investments/reconciliations';
  const service = async () => {
    if (
      !services.financeInvestmentReconciliation ||
      !(await call(() =>
        services.financeInvestmentReconciliation!.checkReady(),
      ))
    )
      throw new ApiProblem({
        status: 503,
        code: 'finance-investment-reconciliation-unavailable',
        title: 'Investment reconciliation unavailable',
        detail: 'The saved reconciliation service is not enabled.',
      });
    return services.financeInvestmentReconciliation;
  };
  const scoped = (
    value: { workspaceId: string; bookId: string },
    context: WorkspaceContext,
    bookId: string,
  ) => {
    if (value.workspaceId !== context.workspaceId || value.bookId !== bookId)
      throw serviceContractProblem();
  };
  for (const detail of [false, true])
    app.get(`${base}${detail ? '/:caseId' : ''}`, async (request, reply) => {
      const principal = await requirePrincipal(request, services);
      const context = workspaceContextFromLegacyPrincipal(
        principal,
        request.id,
      );
      const { bookId, caseId } = parseRequest(Params, request.params);
      if (detail) {
        const raw = await call(async () =>
          (await service()).get(context, bookId, caseId!),
        );
        if (raw === null)
          throw new ApiProblem({
            status: 404,
            code: 'finance-investment-reconciliation-not-found',
            title: 'Reconciliation not found',
            detail: 'This reconciliation is unavailable in the current book.',
          });
        const result = parseServiceResponse(
          InvestmentReconciliationCaseSchema,
          raw,
        );
        scoped(result, context, bookId);
        if (result.id !== caseId) throw serviceContractProblem();
        return reply.header('cache-control', 'no-store, private').send(result);
      }
      const page = parseRequest(Page, request.query);
      const result = parseServiceResponse(
        InvestmentReconciliationListSchema,
        await call(async () =>
          (await service()).list(context, bookId, page.offset, page.limit),
        ),
      );
      result.items.forEach((item) => scoped(item, context, bookId));
      if (
        result.offset !== page.offset ||
        result.limit !== page.limit ||
        result.items.length > page.limit ||
        new Set(result.items.map((item) => item.id)).size !==
          result.items.length
      )
        throw serviceContractProblem();
      return reply.header('cache-control', 'no-store, private').send(result);
    });
  app.get(`${base}/:caseId/corrective-records`, async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const context = workspaceContextFromLegacyPrincipal(principal, request.id);
    const { bookId, caseId } = parseRequest(Params, request.params);
    const page = parseRequest(Page, request.query);
    const result = parseServiceResponse(
      InvestmentReconciliationCorrectiveRecordListSchema,
      await call(async () =>
        (await service()).correctiveRecords(
          context,
          bookId,
          caseId!,
          page.offset,
          page.limit,
        ),
      ),
    );
    if (
      result.offset !== page.offset ||
      result.limit !== page.limit ||
      result.items.length > page.limit ||
      new Set(result.items.map((item) => `${item.kind}:${item.id}`)).size !==
        result.items.length
    )
      throw serviceContractProblem();
    return reply.header('cache-control', 'no-store, private').send(result);
  });
  app.get(`${base}/preview`, async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const context = workspaceContextFromLegacyPrincipal(principal, request.id);
    const { bookId } = parseRequest(Params, request.params);
    const input = parseRequest(
      PreviewInvestmentReconciliationSchema,
      request.query,
    );
    const result = parseServiceResponse(
      InvestmentReconciliationPreviewSchema,
      await call(async () => (await service()).preview(context, bookId, input)),
    );
    scoped(result, context, bookId);
    if (
      result.comparison.valuationRunId !== input.valuationRunId ||
      result.comparison.observedPositionId !== input.observedPositionId
    )
      throw serviceContractProblem();
    return reply.header('cache-control', 'no-store, private').send(result);
  });
  for (const operation of ['create', 'resolve', 'reopen'] as const)
    app.post(
      `${base}${operation === 'create' ? '' : '/:caseId/' + operation}`,
      {
        bodyLimit,
        onRequest: (request) => prepareAuthenticatedMutation(request, services),
      },
      async (request, reply) => {
        const { principal, idempotencyKey } = takePreparedMutation(request);
        const context = workspaceContextFromLegacyPrincipal(
          principal,
          request.id,
        );
        const { bookId, caseId } = parseRequest(Params, request.params);
        const repo = await service();
        const input =
          operation === 'create'
            ? parseRequest(CreateInvestmentReconciliationSchema, request.body)
            : operation === 'resolve'
              ? parseRequest(
                  ResolveInvestmentReconciliationSchema,
                  request.body,
                )
              : parseRequest(
                  ReopenInvestmentReconciliationSchema,
                  request.body,
                );
        const raw = await call(async () =>
          operation === 'create'
            ? await repo.create(context, bookId, idempotencyKey, input)
            : operation === 'resolve'
              ? await repo.resolve(
                  context,
                  bookId,
                  caseId!,
                  idempotencyKey,
                  input,
                )
              : await repo.reopen(
                  context,
                  bookId,
                  caseId!,
                  idempotencyKey,
                  input,
                ),
        );
        const result = parseServiceResponse(
          InvestmentReconciliationCaseSchema,
          raw,
        );
        scoped(result, context, bookId);
        if (caseId && result.id !== caseId) throw serviceContractProblem();
        if (
          result.comparison.comparisonHash !== input.expectedComparisonHash ||
          ('valuationRunId' in input &&
            (result.comparison.valuationRunId !== input.valuationRunId ||
              result.comparison.observedPositionId !==
                input.observedPositionId))
        )
          throw serviceContractProblem();
        return reply.header('cache-control', 'no-store, private').send(result);
      },
    );
}

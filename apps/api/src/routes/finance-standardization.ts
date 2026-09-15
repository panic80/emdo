import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ChangeFinanceStandardizationSchema,
  FinanceStandardizationReconciliationSchema,
  LookupFinanceStandardizationReceiptSchema,
  ResolveFinanceStandardizationSchema,
  LinkFinanceStandardizationMappingSchema,
  FinanceStandardizationAvailabilitySchema,
  FinanceStandardizationListSchema,
  FinanceStandardizationRunSchema,
  StartFinanceStandardizationSchema,
  UuidSchema,
  workspaceContextFromLegacyPrincipal,
} from '@emdo/contracts';
import { FINANCE_EXTRACTION_REGISTRY } from '@emdo/domains/finance';
import { ApiProblem, serviceContractProblem } from '../problem.js';
import {
  parseRequest,
  parseServiceResponse,
  prepareAuthenticatedMutation,
  requirePrincipal,
  takePreparedMutation,
} from '../request-context.js';
import type { ApiServices } from '../services/contracts.js';
export function registerFinanceStandardizationRoutes(
  app: FastifyInstance,
  services: ApiServices,
  bodyLimit: number,
) {
  const params = z.strictObject({ bookId: UuidSchema }),
    runParams = params.extend({ runId: UuidSchema });
  const unavailable = () =>
    new ApiProblem({
      status: 503,
      code: 'finance-standardization-unavailable',
      title: 'Saved analysis unavailable',
      detail:
        'Saved standardization is not enabled and ready in this environment.',
    });
  const ready = async () => {
    if (
      !services.financeV2 ||
      !(await services.financeV2.checkReady().catch(() => false)) ||
      !services.financeStandardization ||
      !(await services.financeStandardization.checkReady().catch(() => false))
    )
      throw unavailable();
    return services.financeStandardization;
  };
  const safe = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'FinanceStandardizationPersistenceError' &&
        'code' in error
      )
        throw new ApiProblem({
          status:
            error.code === 'denied'
              ? 403
              : error.code === 'conflict'
                ? 409
                : 503,
          code: `finance-standardization-${String(error.code)}`,
          title: 'Saved analysis could not continue',
          detail:
            error.code === 'denied'
              ? 'Current book authorization does not permit this operation.'
              : error.code === 'conflict'
                ? 'The saved analysis or original changed. Refresh it before trying again.'
                : 'Saved standardization is unavailable.',
        });
      throw error;
    }
  };
  const scoped = (raw: unknown, bookId: string, runId?: string) => {
    const run = parseServiceResponse(FinanceStandardizationRunSchema, raw);
    if (run.bookId !== bookId || (runId && run.id !== runId))
      throw serviceContractProblem();
    return run;
  };
  const base = '/api/v2/finance/books/:bookId/standardizations';
  app.get(`${base}/options`, async (request, reply) => {
    const principal = await requirePrincipal(request, services),
      p = parseRequest(params, request.params),
      repo = await ready();
    const available = await safe(() =>
      repo.available(
        workspaceContextFromLegacyPrincipal(principal, request.id),
        p.bookId,
      ),
    );
    return reply.header('cache-control', 'no-store, private').send(
      FinanceStandardizationAvailabilitySchema.parse({
        registry: FINANCE_EXTRACTION_REGISTRY,
        ready: available,
        reason: available
          ? null
          : 'Saved analysis is disabled or not ready. Manual source review remains available.',
      }),
    );
  });
  app.get(base, async (request, reply) => {
    const principal = await requirePrincipal(request, services),
      p = parseRequest(params, request.params),
      query = parseRequest(
        z.strictObject({
          offset: z.coerce.number().int().min(0).max(1000000).default(0),
        }),
        request.query,
      );
    const result = parseServiceResponse(
      FinanceStandardizationListSchema,
      await safe(async () =>
        (await ready()).list(
          workspaceContextFromLegacyPrincipal(principal, request.id),
          p.bookId,
          query.offset,
        ),
      ),
    );
    if (
      result.runs.some(
        (r) => r.bookId !== p.bookId || r.workspaceId !== principal.householdId,
      )
    )
      throw serviceContractProblem();
    return reply.header('cache-control', 'no-store, private').send(result);
  });
  app.get(`${base}/:runId`, async (request, reply) => {
    const principal = await requirePrincipal(request, services),
      p = parseRequest(runParams, request.params);
    const result = scoped(
      await safe(async () =>
        (await ready()).get(
          workspaceContextFromLegacyPrincipal(principal, request.id),
          p.bookId,
          p.runId,
        ),
      ),
      p.bookId,
      p.runId,
    );
    if (result.workspaceId !== principal.householdId)
      throw serviceContractProblem();
    return reply.header('cache-control', 'no-store, private').send(result);
  });
  app.post(
    base,
    { bodyLimit, onRequest: (r) => prepareAuthenticatedMutation(r, services) },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request),
        p = parseRequest(params, request.params),
        input = parseRequest(StartFinanceStandardizationSchema, request.body);
      parseRequest(UuidSchema, idempotencyKey);
      const result = scoped(
        await safe(async () =>
          (await ready()).start(
            workspaceContextFromLegacyPrincipal(principal, request.id),
            p.bookId,
            idempotencyKey,
            input,
          ),
        ),
        p.bookId,
      );
      if (
        result.workspaceId !== principal.householdId ||
        result.evidenceId !== input.evidenceId ||
        result.sourceDigest !== input.expectedSourceDigest
      )
        throw serviceContractProblem();
      return reply.header('cache-control', 'no-store, private').send(result);
    },
  );
  app.post(
    `${base}/:runId/reviewed-mapping`,
    { bodyLimit, onRequest: (r) => prepareAuthenticatedMutation(r, services) },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request),
        p = parseRequest(runParams, request.params),
        input = parseRequest(
          LinkFinanceStandardizationMappingSchema,
          request.body,
        );
      parseRequest(UuidSchema, idempotencyKey);
      const result = scoped(
        await safe(async () =>
          (await ready()).linkMapping(
            workspaceContextFromLegacyPrincipal(principal, request.id),
            p.bookId,
            p.runId,
            idempotencyKey,
            input,
          ),
        ),
        p.bookId,
        p.runId,
      );
      if (
        result.workspaceId !== principal.householdId ||
        result.reviewedMapping?.mappingId !== input.mappingId
      )
        throw serviceContractProblem();
      return reply.header('cache-control', 'no-store, private').send(result);
    },
  );
  for (const action of ['retry', 'cancel'] as const)
    app.post(
      `${base}/:runId/${action}`,
      {
        bodyLimit,
        onRequest: (r) => prepareAuthenticatedMutation(r, services),
      },
      async (request, reply) => {
        const { principal, idempotencyKey } = takePreparedMutation(request),
          p = parseRequest(runParams, request.params),
          input = parseRequest(
            ChangeFinanceStandardizationSchema,
            request.body,
          );
        parseRequest(UuidSchema, idempotencyKey);
        const result = scoped(
          await safe(async () =>
            (await ready()).change(
              workspaceContextFromLegacyPrincipal(principal, request.id),
              p.bookId,
              p.runId,
              action,
              idempotencyKey,
              input,
            ),
          ),
          p.bookId,
          p.runId,
        );
        if (result.workspaceId !== principal.householdId)
          throw serviceContractProblem();
        return reply.header('cache-control', 'no-store, private').send(result);
      },
    );
  const checkedReconciliation = (
    raw: unknown,
    workspaceId: string,
    bookId: string,
    runId: string,
  ) => {
    const result = parseServiceResponse(
      FinanceStandardizationReconciliationSchema,
      raw,
    );
    if (
      result.workspaceId !== workspaceId ||
      result.bookId !== bookId ||
      result.runId !== runId
    )
      throw serviceContractProblem();
    return result;
  };
  app.get(`${base}/:runId/reconciliation`, async (request, reply) => {
    const principal = await requirePrincipal(request, services),
      p = parseRequest(runParams, request.params);
    const result = await safe(async () =>
      (await ready()).reconciliation(
        workspaceContextFromLegacyPrincipal(principal, request.id),
        p.bookId,
        p.runId,
      ),
    );
    return reply
      .header('cache-control', 'no-store, private')
      .send(
        checkedReconciliation(result, principal.householdId, p.bookId, p.runId),
      );
  });
  for (const operation of ['lookup', 'resolve'] as const)
    app.post(
      `${base}/:runId/reconciliation/${operation}`,
      {
        bodyLimit,
        onRequest: (r) => prepareAuthenticatedMutation(r, services),
      },
      async (request, reply) => {
        const { principal, idempotencyKey } = takePreparedMutation(request),
          p = parseRequest(runParams, request.params);
        parseRequest(UuidSchema, idempotencyKey);
        const context = workspaceContextFromLegacyPrincipal(
          principal,
          request.id,
        );
        const result = await safe(async () => {
          const service = await ready();
          return operation === 'lookup'
            ? service.requestReceiptLookup(
                context,
                p.bookId,
                p.runId,
                idempotencyKey,
                parseRequest(
                  LookupFinanceStandardizationReceiptSchema,
                  request.body,
                ),
              )
            : service.resolveOutcome(
                context,
                p.bookId,
                p.runId,
                idempotencyKey,
                parseRequest(ResolveFinanceStandardizationSchema, request.body),
              );
        });
        return reply
          .header('cache-control', 'no-store, private')
          .send(
            checkedReconciliation(
              result,
              principal.householdId,
              p.bookId,
              p.runId,
            ),
          );
      },
    );
}

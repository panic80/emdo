import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  UuidSchema,
  workspaceContextFromLegacyPrincipal,
  FinanceGeneratedReportSchema,
  FinanceGeneratedReportSummarySchema,
  FinanceLedgerAccountClassificationSchema,
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
export function registerFinanceGeneratedReportRoutes(
  app: FastifyInstance,
  services: ApiServices,
) {
  const params = z.strictObject({
    bookId: UuidSchema,
    reportId: UuidSchema.optional(),
  });
  const classificationParams = z.strictObject({
    bookId: UuidSchema,
    accountId: UuidSchema,
  });
  const ready = async () => {
    const repository = services.financeGeneratedReports;
    if (!repository || !(await repository.checkReady().catch(() => false)))
      throw new ApiProblem({
        status: 503,
        code: 'finance-generated-reports-unavailable',
        title: 'Saved reports unavailable',
        detail: 'The saved accounting report service is not enabled or ready.',
      });
    return repository;
  };
  for (const detail of [false, true])
    app.get(
      `/api/v2/finance/books/:bookId/reports${detail ? '/:reportId' : ''}`,
      async (request, reply) => {
        reply.header('cache-control', 'no-store, private');
        const principal = await requirePrincipal(request, services),
          { bookId, reportId } = parseRequest(params, request.params);
        const context = workspaceContextFromLegacyPrincipal(
            principal,
            request.id,
          ),
          repository = await ready();
        if (detail) {
          const report = await repository.get(context, bookId, reportId!);
          if (!report)
            throw new ApiProblem({
              status: 404,
              code: 'finance-generated-report-not-found',
              title: 'Report not found',
              detail: 'The requested saved report is unavailable in this book.',
            });
          const result = parseServiceResponse(
            FinanceGeneratedReportSchema,
            report,
          );
          if (
            result.workspaceId !== context.workspaceId ||
            result.bookId !== bookId ||
            result.id !== reportId
          )
            throw serviceContractProblem();
          return reply.send(result);
        }
        const page = parseRequest(
          z.object({
            offset: z.coerce.number().int().min(0).max(1000000).default(0),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
          request.query,
        );
        const result = await repository.list(
          context,
          bookId,
          page.offset,
          page.limit,
        );
        const output = parseServiceResponse(
          z.strictObject({
            reports: z
              .array(FinanceGeneratedReportSummarySchema)
              .max(page.limit),
            nextOffset: z.number().int().nonnegative().nullable(),
          }),
          result,
        );
        if (
          output.reports.some(
            (report) =>
              report.workspaceId !== context.workspaceId ||
              report.bookId !== bookId,
          ) ||
          new Set(output.reports.map((report) => report.id)).size !==
            output.reports.length ||
          (output.nextOffset !== null &&
            (output.reports.length !== page.limit ||
              output.nextOffset !== page.offset + page.limit))
        )
          throw serviceContractProblem();
        return reply.send(output);
      },
    );
  app.get(
    '/api/v2/finance/books/:bookId/report-classifications',
    async (request, reply) => {
      reply.header('cache-control', 'no-store, private');
      const principal = await requirePrincipal(request, services);
      const { bookId } = parseRequest(params, request.params);
      const repository = await ready();
      if (repository.listClassifications === undefined)
        throw new ApiProblem({
          status: 503,
          code: 'finance-report-classifications-unavailable',
          title: 'Report classifications unavailable',
          detail: 'Statement classification configuration is not enabled.',
        });
      const result = parseServiceResponse(
        z.array(FinanceLedgerAccountClassificationSchema),
        await repository.listClassifications(
          workspaceContextFromLegacyPrincipal(principal, request.id),
          bookId,
        ),
      );
      if (
        result.some(
          (row) =>
            row.workspaceId !== principal.householdId || row.bookId !== bookId,
        )
      )
        throw serviceContractProblem();
      return reply.send({ classifications: result });
    },
  );
  app.post(
    '/api/v2/finance/books/:bookId/report-classifications/:accountId',
    {
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal } = takePreparedMutation(request);
      const { bookId, accountId } = parseRequest(
        classificationParams,
        request.params,
      );
      const repository = await ready();
      if (repository.setClassification === undefined)
        throw new ApiProblem({
          status: 503,
          code: 'finance-report-classifications-unavailable',
          title: 'Report classifications unavailable',
          detail: 'Statement classification configuration is not enabled.',
        });
      const result = parseServiceResponse(
        FinanceLedgerAccountClassificationSchema,
        await repository.setClassification(
          workspaceContextFromLegacyPrincipal(principal, request.id),
          bookId,
          accountId,
          request.body,
        ),
      );
      if (
        result.workspaceId !== principal.householdId ||
        result.bookId !== bookId ||
        result.accountId !== accountId
      )
        throw serviceContractProblem();
      return reply.header('cache-control', 'no-store, private').send(result);
    },
  );
}

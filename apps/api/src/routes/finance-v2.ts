import {
  FINANCE_TAX_COUNTRY_CATALOG,
  FINANCE_TAX_PACKAGE_REGISTRY,
  planInvestmentCashDividend,
  planInvestmentStockSplitSettlement,
} from '@emdo/domains/finance';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  SaveFinanceReportMappingFromSourceSchema,
  PreviewInvestmentStockSplitSettlementSchema,
  CommitInvestmentStockSplitSettlementSchema,
  FinanceStockSplitSettlementCommitResultSchema,
  SavedFinanceStockSplitSettlementSchema,
  CommitInvestmentCashDividendSchema,
  FinanceCashDividendDraftSchema,
  FinanceCashDividendSourceSnapshotSchema,
  ReadInvestmentCashDividendSourceSchema,
  UuidSchema,
  workspaceContextFromLegacyPrincipal,
} from '@emdo/contracts';
import { ApiProblem } from '../problem.js';
import {
  parseRequest,
  prepareAuthenticatedMutation,
  requirePrincipal,
  takePreparedMutation,
} from '../request-context.js';
import type { ApiServices } from '../services/contracts.js';

const Params = z.object({
  bookId: UuidSchema,
  recordId: UuidSchema.optional(),
});
export function registerFinanceV2Routes(
  app: FastifyInstance,
  services: ApiServices,
  bodyLimit: number,
) {
  const service = async () => {
    const candidate = services.financeV2;
    if (!candidate || !(await candidate.checkReady().catch(() => false)))
      throw new ApiProblem({
        status: 503,
        code: 'finance-v2-unavailable',
        title: 'Accounting unavailable',
        detail: 'The normalized accounting service is not enabled or ready.',
      });
    return candidate;
  };
  const context = async (request: FastifyRequest) =>
    workspaceContextFromLegacyPrincipal(
      await requirePrincipal(request, services),
      request.id,
    );
  app.get('/api/v2/workspace', async (request, reply) => {
    const scope = await context(request);
    return reply
      .header('cache-control', 'no-store, private')
      .send(await (await service()).workspace(scope));
  });
  app.get('/api/v2/finance/books', async (request, reply) => {
    const scope = await context(request);
    return reply
      .header('cache-control', 'no-store, private')
      .send({ books: await (await service()).listBooks(scope) });
  });
  app.get('/api/v2/finance/books/:bookId', async (request, reply) => {
    const scope = await context(request);
    const { bookId } = parseRequest(Params, request.params);
    return reply
      .header('cache-control', 'no-store, private')
      .send(await (await service()).overview(scope, bookId));
  });
  app.get(
    '/api/v2/finance/books/:bookId/commercial',
    async (request, reply) => {
      const scope = await context(request);
      const { bookId } = parseRequest(Params, request.params);
      return reply
        .header('cache-control', 'no-store, private')
        .send(await (await service()).commercialOverview(scope, bookId));
    },
  );
  for (const operation of [
    'parties',
    'commercial-documents',
    'payments',
    'void',
  ] as const) {
    const path =
      operation === 'void'
        ? '/api/v2/finance/books/:bookId/commercial-documents/:recordId/void'
        : `/api/v2/finance/books/:bookId/${operation}`;
    app.post(
      path,
      {
        bodyLimit,
        onRequest: (request) => prepareAuthenticatedMutation(request, services),
      },
      async (request, reply) => {
        const { principal, idempotencyKey } = takePreparedMutation(request);
        const scope = workspaceContextFromLegacyPrincipal(
          principal,
          request.id,
        );
        const { bookId, recordId } = parseRequest(Params, request.params);
        const api = await service();
        const result =
          operation === 'parties'
            ? await api.createParty(scope, bookId, idempotencyKey, request.body)
            : operation === 'commercial-documents'
              ? await api.issueCommercialDocument(
                  scope,
                  bookId,
                  idempotencyKey,
                  request.body,
                )
              : operation === 'payments'
                ? await api.recordPayment(
                    scope,
                    bookId,
                    idempotencyKey,
                    request.body,
                  )
                : await api.voidCommercialDocument(
                    scope,
                    bookId,
                    recordId!,
                    idempotencyKey,
                    request.body,
                  );
        return reply.header('cache-control', 'no-store, private').send(result);
      },
    );
  }
  app.post(
    '/api/v2/finance/books/:bookId/payments/:recordId/void',
    {
      bodyLimit,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      const { bookId, recordId } = parseRequest(Params, request.params);
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (
            await service()
          ).voidPayment(
            workspaceContextFromLegacyPrincipal(principal, request.id),
            bookId,
            recordId!,
            idempotencyKey,
            request.body,
          ),
        );
    },
  );
  app.get(
    '/api/v2/finance/books/:bookId/financial-account-sources',
    async (request, reply) => {
      const scope = await context(request);
      const { bookId } = parseRequest(Params, request.params);
      const sources = await (
        await service()
      ).listFinancialAccountSources(scope, bookId);
      return reply.header('cache-control', 'no-store, private').send({
        sources: sources.map(({ sourceSpaceId, name }) => ({
          sourceSpaceId,
          name,
        })),
      });
    },
  );
  app.get(
    '/api/v2/finance/books/:bookId/financial-accounts',
    async (request, reply) => {
      const scope = await context(request);
      const { bookId } = parseRequest(Params, request.params);
      return reply.header('cache-control', 'no-store, private').send({
        accounts: await (await service()).listFinancialAccounts(scope, bookId),
      });
    },
  );
  app.post(
    '/api/v2/finance/books/:bookId/financial-accounts',
    {
      bodyLimit,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      const { bookId } = parseRequest(Params, request.params);
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (
            await service()
          ).createFinancialAccount(
            workspaceContextFromLegacyPrincipal(principal, request.id),
            bookId,
            idempotencyKey,
            request.body,
          ),
        );
    },
  );

  app.get('/api/v2/finance/books/:bookId/imports', async (request, reply) => {
    const scope = await context(request),
      { bookId } = parseRequest(Params, request.params);
    return reply.header('cache-control', 'no-store, private').send({
      imports: await (await service()).listNormalizedImports(scope, bookId),
    });
  });
  app.get(
    '/api/v2/finance/books/:bookId/imports/:recordId',
    async (request, reply) => {
      const scope = await context(request),
        { bookId, recordId } = parseRequest(Params, request.params);
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (await service()).getNormalizedImport(scope, bookId, recordId!),
        );
    },
  );
  app.get(
    '/api/v2/finance/books/:bookId/evidence/:recordId',
    async (request, reply) => {
      const scope = await context(request),
        { bookId, recordId } = parseRequest(Params, request.params);
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (
            await service()
          ).downloadBookEvidence(scope, bookId, recordId!),
        );
    },
  );
  for (const operation of ['upload', 'review', 'commit'] as const) {
    const path =
      operation === 'upload'
        ? '/imports'
        : operation === 'review'
          ? '/import-rows/:recordId/review'
          : '/imports/:recordId/commit';
    app.post(
      `/api/v2/finance/books/:bookId${path}`,
      {
        bodyLimit: operation === 'upload' ? 16 * 1024 * 1024 : bodyLimit,
        onRequest: (request) => prepareAuthenticatedMutation(request, services),
      },
      async (request, reply) => {
        const { principal, idempotencyKey } = takePreparedMutation(request),
          { bookId, recordId } = parseRequest(Params, request.params);
        const scope = workspaceContextFromLegacyPrincipal(
            principal,
            request.id,
          ),
          repository = await service();
        const result =
          operation === 'upload'
            ? await repository.uploadNormalizedStatement(
                scope,
                bookId,
                idempotencyKey,
                request.body,
              )
            : operation === 'review'
              ? await repository.reviewNormalizedImportRow(
                  scope,
                  bookId,
                  recordId!,
                  idempotencyKey,
                  request.body,
                )
              : await repository.commitNormalizedImport(
                  scope,
                  bookId,
                  recordId!,
                  idempotencyKey,
                  request.body,
                );
        return reply.header('cache-control', 'no-store, private').send(result);
      },
    );
  }

  app.get(
    '/api/v2/finance/books/:bookId/investments',
    async (request, reply) => {
      const scope = await context(request),
        { bookId } = parseRequest(Params, request.params);
      return reply
        .header('cache-control', 'no-store, private')
        .send(await (await service()).investmentOverview(scope, bookId));
    },
  );
  app.get(
    '/api/v2/finance/books/:bookId/investments/valuation-runs',
    async (request, reply) => {
      const scope = await context(request),
        { bookId } = parseRequest(Params, request.params);
      const page = parseRequest(
        z.object({
          offset: z.coerce.number().int().min(0).max(1000000).default(0),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        request.query,
      );
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (
            await service()
          ).listInvestmentValuations(scope, bookId, page.offset, page.limit),
        );
    },
  );
  app.get(
    '/api/v2/finance/books/:bookId/investments/valuation-runs/:recordId',
    async (request, reply) => {
      const scope = await context(request),
        { bookId, recordId } = parseRequest(Params, request.params);
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (
            await service()
          ).getInvestmentValuation(scope, bookId, recordId!),
        );
    },
  );
  app.get(
    '/api/v2/finance/books/:bookId/investments/lots',
    async (request, reply) => {
      const scope = await context(request),
        { bookId } = parseRequest(Params, request.params);
      const page = parseRequest(
        z.object({
          offset: z.coerce.number().int().min(0).max(1000000).default(0),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        request.query,
      );
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (
            await service()
          ).listInvestmentLots(scope, bookId, page.offset, page.limit),
        );
    },
  );
  app.get(
    '/api/v2/finance/books/:bookId/investments/lots/:recordId',
    async (request, reply) => {
      const scope = await context(request),
        { bookId, recordId } = parseRequest(Params, request.params);
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (await service()).getInvestmentLot(scope, bookId, recordId!),
        );
    },
  );
  app.get(
    '/api/v2/finance/books/:bookId/investments/cash-dividends',
    async (request, reply) => {
      const scope = await context(request),
        { bookId } = parseRequest(Params, request.params);
      const page = parseRequest(
        z.strictObject({
          offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        request.query,
      );
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (
            await service()
          ).listInvestmentCashDividends(scope, bookId, page),
        );
    },
  );
  app.get(
    '/api/v2/finance/books/:bookId/investments/cash-dividends/:recordId',
    async (request, reply) => {
      const scope = await context(request),
        { bookId, recordId } = parseRequest(Params, request.params);
      const saved = await (
        await service()
      ).getInvestmentCashDividend(scope, bookId, recordId!);
      if (!saved)
        throw new ApiProblem({
          status: 404,
          code: 'finance-dividend-not-found',
          title: 'Dividend unavailable',
          detail: 'The saved dividend was not found in this book.',
        });
      return reply.header('cache-control', 'no-store, private').send(saved);
    },
  );
  app.post(
    '/api/v2/finance/books/:bookId/investments/cash-dividends/source',
    { bodyLimit },
    async (request, reply) => {
      const scope = await context(request),
        { bookId } = parseRequest(Params, request.params);
      const input = parseRequest(
        ReadInvestmentCashDividendSourceSchema,
        request.body,
      );
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (
            await service()
          ).readInvestmentCashDividendSource(scope, bookId, input),
        );
    },
  );
  app.post(
    '/api/v2/finance/books/:bookId/investments/cash-dividends/preview',
    { bodyLimit },
    async (request, reply) => {
      const scope = await context(request),
        { bookId } = parseRequest(Params, request.params);
      const input = parseRequest(
        CommitInvestmentCashDividendSchema.omit({
          idempotencyKey: true,
        }).extend({ action: FinanceCashDividendDraftSchema }),
        request.body,
      );
      const { sourceRowId, financialAccountId, instrumentId, evidenceId } =
        input.action;
      const source = FinanceCashDividendSourceSnapshotSchema.parse(
        await (
          await service()
        ).readInvestmentCashDividendSource(scope, bookId, {
          sourceRowId,
          financialAccountId,
          instrumentId,
          evidenceId,
        }),
      );
      if (
        source.sourceRevision !== input.expectedSourceRevision ||
        source.sourceSnapshotHash !== input.sourceSnapshotHash
      )
        throw new ApiProblem({
          status: 409,
          code: 'finance-dividend-source-changed',
          title: 'Source changed',
          detail:
            'Reload the statement source and review the current dividend facts.',
        });
      return reply
        .header('cache-control', 'no-store, private')
        .send(planInvestmentCashDividend({ action: input.action, source }));
    },
  );
  app.post(
    '/api/v2/finance/books/:bookId/investments/cash-dividends/commit',
    {
      bodyLimit,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request),
        { bookId } = parseRequest(Params, request.params);
      const body = request.body;
      const input = parseRequest(
        CommitInvestmentCashDividendSchema,
        body !== null && typeof body === 'object' && !Array.isArray(body)
          ? { ...body, idempotencyKey }
          : body,
      );
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (
            await service()
          ).commitInvestmentCashDividend(
            workspaceContextFromLegacyPrincipal(principal, request.id),
            bookId,
            input,
          ),
        );
    },
  );
  app.get(
    '/api/v2/finance/books/:bookId/investments/corporate-actions/revision',
    async (request, reply) => {
      const scope = await context(request),
        { bookId } = parseRequest(Params, request.params);
      return reply
        .header('cache-control', 'no-store, private')
        .send(await (await service()).getInvestmentLotRevision(scope, bookId));
    },
  );
  app.post(
    '/api/v2/finance/books/:bookId/investments/corporate-actions/stock-splits/source',
    { bodyLimit },
    async (request, reply) => {
      const scope = await context(request),
        { bookId } = parseRequest(Params, request.params);
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (
            await service()
          ).readInvestmentStockSplitSource(scope, bookId, request.body),
        );
    },
  );
  app.post(
    '/api/v2/finance/books/:bookId/investments/corporate-actions/stock-splits/settlement-preview',
    { bodyLimit },
    async (request, reply) => {
      const scope = await context(request);
      const { bookId } = parseRequest(Params, request.params);
      const input = parseRequest(
        PreviewInvestmentStockSplitSettlementSchema,
        request.body,
      );
      const source = await (
        await service()
      ).readInvestmentStockSplitSource(scope, bookId, input.action);
      if (
        source.sourceRevision !== input.expectedSourceRevision ||
        source.sourceSnapshotHash !== input.sourceSnapshotHash
      )
        throw new ApiProblem({
          status: 409,
          code: 'finance-corporate-action-source-conflict',
          title: 'Investment source changed',
          detail: 'Refresh the source lots and review the settlement again.',
        });
      const {
        action,
        expectedSourceRevision,
        sourceSnapshotHash,
        ...settlement
      } = input;
      let plan;
      try {
        plan = planInvestmentStockSplitSettlement({
          ...settlement,
          source: {
            action,
            sourceAsOf: source.sourceAsOf,
            sourceBoundary: source.sourceBoundary,
            sourceLots: source.sourceLots,
          },
        });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.startsWith('finance-corporate-action-')
        )
          throw error;
        throw new ApiProblem({
          status: 400,
          code: 'finance-corporate-action-settlement-invalid',
          title: 'Settlement does not reconcile',
          detail:
            'Review the quantities, book costs, currencies and settlement evidence.',
        });
      }
      return reply.header('cache-control', 'no-store, private').send({
        sourceRevision: expectedSourceRevision,
        sourceSnapshotHash,
        plan,
      });
    },
  );
  app.post(
    '/api/v2/finance/books/:bookId/investments/corporate-actions/stock-splits/settlement-commit',
    {
      bodyLimit,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      const { bookId } = parseRequest(Params, request.params);
      const candidate = await service();
      if (
        !(await candidate.checkStockSplitSettlementReady().catch(() => false))
      )
        throw new ApiProblem({
          status: 503,
          code: 'finance-settlement-unavailable',
          title: 'Settlement posting unavailable',
          detail: 'The required settlement storage and controls are not ready.',
        });
      const body = request.body;
      if (
        body &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        'idempotencyKey' in body &&
        body.idempotencyKey !== idempotencyKey
      )
        throw new ApiProblem({
          status: 400,
          code: 'finance-settlement-idempotency-mismatch',
          title: 'Request identity mismatch',
          detail: 'The request and header must use the same idempotency key.',
        });
      const input = parseRequest(
        CommitInvestmentStockSplitSettlementSchema,
        body && typeof body === 'object' && !Array.isArray(body)
          ? { ...body, idempotencyKey }
          : body,
      );
      const scope = workspaceContextFromLegacyPrincipal(principal, request.id);
      const parsedResult =
        FinanceStockSplitSettlementCommitResultSchema.safeParse(
          await candidate.commitInvestmentStockSplitSettlement(
            scope,
            bookId,
            input,
          ),
        );
      if (
        !parsedResult.success ||
        parsedResult.data.workspaceId !== scope.workspaceId ||
        parsedResult.data.bookId !== bookId ||
        parsedResult.data.actionId !== input.settlement.source.action.id
      )
        throw new ApiProblem({
          status: 503,
          code: 'finance-settlement-result-unavailable',
          title: 'Settlement result unavailable',
          detail: 'Refresh the book before retrying the same request.',
        });
      return reply
        .header('cache-control', 'no-store, private')
        .send(parsedResult.data);
    },
  );
  app.get(
    '/api/v2/finance/books/:bookId/investments/corporate-actions/settlements/:recordId',
    async (request, reply) => {
      const scope = await context(request);
      const { bookId, recordId } = parseRequest(
        Params.extend({ recordId: UuidSchema }),
        request.params,
      );
      const candidate = await service();
      if (
        !(await candidate.checkStockSplitSettlementReady().catch(() => false))
      )
        throw new ApiProblem({
          status: 503,
          code: 'finance-settlement-unavailable',
          title: 'Settlement storage unavailable',
          detail: 'The settlement records are not ready.',
        });
      const saved = await candidate.getInvestmentStockSplitSettlement(
        scope,
        bookId,
        recordId,
      );
      if (!saved)
        throw new ApiProblem({
          status: 404,
          code: 'finance-settlement-not-found',
          title: 'Settlement not found',
          detail: 'No settlement is available in this book.',
        });
      const parsed = SavedFinanceStockSplitSettlementSchema.safeParse(saved);
      if (
        !parsed.success ||
        parsed.data.result.workspaceId !== scope.workspaceId ||
        parsed.data.result.bookId !== bookId ||
        parsed.data.result.settlementId !== recordId ||
        parsed.data.settlement.actionId !== parsed.data.result.actionId
      )
        throw new ApiProblem({
          status: 503,
          code: 'finance-settlement-result-unavailable',
          title: 'Settlement result unavailable',
          detail: 'The saved settlement could not be verified.',
        });
      return reply
        .header('cache-control', 'no-store, private')
        .send(parsed.data);
    },
  );
  app.post(
    '/api/v2/finance/books/:bookId/investments/corporate-actions/stock-splits/commit',
    {
      bodyLimit,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request),
        { bookId } = parseRequest(Params, request.params),
        body = request.body;
      const input =
        body !== null && typeof body === 'object' && !Array.isArray(body)
          ? { ...(body as Record<string, unknown>), idempotencyKey }
          : body;
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (
            await service()
          ).commitInvestmentStockSplit(
            workspaceContextFromLegacyPrincipal(principal, request.id),
            bookId,
            input,
          ),
        );
    },
  );
  for (const operation of [
    'instruments',
    'lots',
    'lot-disposals',
    'movements',
    'prices',
    'fx',
    'openings',
    'observed-positions',
    'valuation-preview',
    'valuation-runs',
  ] as const) {
    app.post(
      `/api/v2/finance/books/:bookId/investments/${operation}`,
      {
        bodyLimit,
        onRequest: (request) => prepareAuthenticatedMutation(request, services),
      },
      async (request, reply) => {
        const { principal, idempotencyKey } = takePreparedMutation(request),
          { bookId } = parseRequest(Params, request.params);
        const scope = workspaceContextFromLegacyPrincipal(
            principal,
            request.id,
          ),
          repository = await service();
        const result =
          operation === 'movements'
            ? await repository.recordInvestmentMovement(
                scope,
                bookId,
                idempotencyKey,
                request.body,
              )
            : operation === 'lots'
              ? await repository.recordInvestmentLot(
                  scope,
                  bookId,
                  idempotencyKey,
                  request.body,
                )
              : operation === 'lot-disposals'
                ? await repository.recordLotDisposal(
                    scope,
                    bookId,
                    idempotencyKey,
                    request.body,
                  )
                : operation === 'instruments'
                  ? await repository.createInstrument(
                      scope,
                      bookId,
                      idempotencyKey,
                      request.body,
                    )
                  : operation === 'prices'
                    ? await repository.recordInvestmentPrice(
                        scope,
                        bookId,
                        idempotencyKey,
                        request.body,
                      )
                    : operation === 'fx'
                      ? await repository.recordInvestmentFx(
                          scope,
                          bookId,
                          idempotencyKey,
                          request.body,
                        )
                      : operation === 'openings'
                        ? await repository.recordInvestmentOpening(
                            scope,
                            bookId,
                            idempotencyKey,
                            request.body,
                          )
                        : operation === 'observed-positions'
                          ? await repository.recordObservedPosition(
                              scope,
                              bookId,
                              idempotencyKey,
                              request.body,
                            )
                          : operation === 'valuation-runs'
                            ? await repository.saveInvestmentValuation(
                                scope,
                                bookId,
                                idempotencyKey,
                                request.body,
                              )
                            : await repository.previewInvestmentValuation(
                                scope,
                                bookId,
                                request.body,
                              );
        return reply.header('cache-control', 'no-store, private').send(result);
      },
    );
  }

  app.get(
    '/api/v2/finance/books/:bookId/report-mappings',
    async (request, reply) => {
      const scope = await context(request),
        { bookId } = parseRequest(Params, request.params);
      const { offset } = parseRequest(
        z.object({
          offset: z.coerce.number().int().min(0).max(1000000).default(0),
        }),
        request.query,
      );
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (await service()).listReportMappings(scope, bookId, offset),
        );
    },
  );
  app.get(
    '/api/v2/finance/books/:bookId/report-mappings/:recordId',
    async (request, reply) => {
      const scope = await context(request),
        { bookId, recordId } = parseRequest(Params, request.params);
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (await service()).getReportMapping(scope, bookId, recordId!),
        );
    },
  );
  app.post(
    '/api/v2/finance/books/:bookId/report-mappings/from-source',
    {
      bodyLimit,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request),
        { bookId } = parseRequest(Params, request.params),
        input = parseRequest(
          SaveFinanceReportMappingFromSourceSchema,
          request.body,
        );
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (
            await service()
          ).saveSourceReportMapping(
            workspaceContextFromLegacyPrincipal(principal, request.id),
            bookId,
            idempotencyKey,
            input,
          ),
        );
    },
  );
  for (const operation of ['propose', 'review', 'apply', 'import'] as const) {
    const path = operation === 'propose' ? '' : `/:recordId/${operation}`;
    app.post(
      `/api/v2/finance/books/:bookId/report-mappings${path}`,
      {
        bodyLimit: operation === 'review' ? bodyLimit : 16 * 1024 * 1024,
        onRequest: (request) => prepareAuthenticatedMutation(request, services),
      },
      async (request, reply) => {
        const { principal, idempotencyKey } = takePreparedMutation(request),
          { bookId, recordId } = parseRequest(Params, request.params);
        const scope = workspaceContextFromLegacyPrincipal(
            principal,
            request.id,
          ),
          repository = await service();
        const result =
          operation === 'propose'
            ? await repository.saveReportMapping(
                scope,
                bookId,
                idempotencyKey,
                request.body,
              )
            : operation === 'review'
              ? await repository.reviewReportMapping(
                  scope,
                  bookId,
                  recordId!,
                  idempotencyKey,
                  request.body,
                )
              : operation === 'import'
                ? await repository.importMappedReport(
                    scope,
                    bookId,
                    recordId!,
                    idempotencyKey,
                    request.body,
                  )
                : await repository.applyReportMapping(
                    scope,
                    bookId,
                    recordId!,
                    request.body,
                  );
        return reply.header('cache-control', 'no-store, private').send(result);
      },
    );
  }

  app.post(
    '/api/v2/finance/books/:bookId/evidence',
    {
      bodyLimit: 16 * 1024 * 1024,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request),
        { bookId } = parseRequest(Params, request.params);
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (
            await service()
          ).uploadBookEvidence(
            workspaceContextFromLegacyPrincipal(principal, request.id),
            bookId,
            idempotencyKey,
            request.body,
          ),
        );
    },
  );

  app.get('/api/v2/finance/books/:bookId/evidence', async (request, reply) => {
    const scope = await context(request),
      { bookId } = parseRequest(Params, request.params);
    const { offset } = parseRequest(
      z.object({
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
      }),
      request.query,
    );
    return reply
      .header('cache-control', 'no-store, private')
      .send(await (await service()).listBookEvidence(scope, bookId, offset));
  });
  app.get('/api/v2/finance/tax/coverage', async (request, reply) => {
    await context(request);
    return reply.header('cache-control', 'no-store, private').send({
      countries: FINANCE_TAX_COUNTRY_CATALOG.map(({ country }) => {
        const packages = FINANCE_TAX_PACKAGE_REGISTRY.list().filter(
          (entry) => entry.scope.country === country,
        );
        return {
          country,
          status: packages.length ? 'partial-coverage' : 'unavailable',
          jurisdictions: [
            ...new Set(packages.map((entry) => entry.scope.subdivision)),
          ],
          taxYears: [...new Set(packages.map((entry) => entry.scope.year))],
          forms: packages.flatMap((entry) =>
            entry.forms.map((form) => ({ id: form.id, version: form.version })),
          ),
          packages: packages.map((entry) => ({
            packageId: entry.packageId,
            version: entry.version,
            scope: entry.scope,
          })),
          reason: packages.length
            ? 'Only the explicitly listed return scopes are covered.'
            : 'Return-level rule packages have not passed release validation.',
        };
      }),
    });
  });
  for (const operation of [
    'books',
    'accounts',
    'periods',
    'journals',
    'reversals',
    'closing',
  ] as const) {
    const path =
      operation === 'books'
        ? '/api/v2/finance/books'
        : operation === 'reversals'
          ? '/api/v2/finance/books/:bookId/journals/:recordId/reverse'
          : operation === 'closing'
            ? '/api/v2/finance/books/:bookId/periods/:recordId/close'
            : `/api/v2/finance/books/:bookId/${operation}`;
    app.post(
      path,
      {
        bodyLimit,
        onRequest: (request) => prepareAuthenticatedMutation(request, services),
      },
      async (request, reply) => {
        const { principal, idempotencyKey } = takePreparedMutation(request);
        const scope = workspaceContextFromLegacyPrincipal(
          principal,
          request.id,
        );
        const api = await service();
        if (operation === 'books')
          return reply
            .header('cache-control', 'no-store, private')
            .send(await api.createBook(scope, idempotencyKey, request.body));
        const { bookId, recordId } = parseRequest(Params, request.params);
        const result =
          operation === 'accounts'
            ? await api.createAccount(
                scope,
                bookId,
                idempotencyKey,
                request.body,
              )
            : operation === 'periods'
              ? await api.createPeriod(
                  scope,
                  bookId,
                  idempotencyKey,
                  request.body,
                )
              : operation === 'journals'
                ? await api.postJournal(
                    scope,
                    bookId,
                    idempotencyKey,
                    request.body,
                  )
                : operation === 'reversals'
                  ? await api.reverseJournal(
                      scope,
                      bookId,
                      recordId!,
                      idempotencyKey,
                      request.body,
                    )
                  : await api.closePeriod(
                      scope,
                      bookId,
                      recordId!,
                      idempotencyKey,
                    );
        return reply.header('cache-control', 'no-store, private').send(result);
      },
    );
  }
}

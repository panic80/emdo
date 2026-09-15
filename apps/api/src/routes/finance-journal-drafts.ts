import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PrepareFinanceAutomationJournalDraftResultSchema,
  FinanceAutomationJournalDraftResultSchema,
  PrepareFinanceAutomationJournalDraftSchema,
  ReviewFinanceAutomationJournalDraftSchema,
  DiscardFinanceAutomationJournalDraftSchema,
  PostFinanceAutomationJournalDraftSchema,
  FinanceMoneySchema,
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

export interface FinanceJournalDraftRouteService {
  checkReady(): Promise<boolean>;
  prepareJournalDraft(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ): Promise<unknown>;
  readJournalDraftResult(
    context: WorkspaceContext,
    bookId: string,
    resultId: string,
  ): Promise<unknown>;
  listJournalDraftResults(
    context: WorkspaceContext,
    bookId: string,
    offset: number,
    limit: number,
  ): Promise<unknown>;
  reviewJournalDraft(
    context: WorkspaceContext,
    bookId: string,
    resultId: string,
    key: string,
    input: unknown,
  ): Promise<unknown>;
  discardJournalDraft(
    context: WorkspaceContext,
    bookId: string,
    resultId: string,
    key: string,
    input: unknown,
  ): Promise<unknown>;
  postJournalDraft(
    context: WorkspaceContext,
    bookId: string,
    resultId: string,
    key: string,
    input: unknown,
  ): Promise<unknown>;
}
const Params = z.strictObject({
  bookId: UuidSchema,
  resultId: UuidSchema.optional(),
});
const Page = z.strictObject({
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const Prepared = PrepareFinanceAutomationJournalDraftResultSchema.refine(
  (value) =>
    FinanceMoneySchema.safeParse({
      currency: value.currency,
      amount: value.amount,
    }).success,
);
const List = z.strictObject({
  items: z.array(FinanceAutomationJournalDraftResultSchema).max(100),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(100),
  total: z.number().int().nonnegative(),
});
async function call<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      ![
        'FinanceJournalDraftPersistenceError',
        'FinanceV2PersistenceError',
      ].includes(cause.name)
    )
      throw cause;
    const rawCode = 'code' in cause ? String(cause.code) : 'unavailable';
    const code = [
      'authorization-revoked',
      'invalid-input',
      'conflict',
    ].includes(rawCode)
      ? rawCode
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
      code: `finance-journal-draft-${code}`,
      title: 'Journal draft request could not be completed',
      detail:
        code === 'authorization-revoked'
          ? 'Current book access does not permit this operation.'
          : code === 'conflict'
            ? 'The draft or its source changed. Refresh and review the current records.'
            : code === 'invalid-input'
              ? 'Check the selected source and review decision.'
              : 'The journal draft service is unavailable or not ready.',
    });
  }
}
export function registerFinanceJournalDraftRoutes(
  app: FastifyInstance,
  services: ApiServices,
  bodyLimit: number,
) {
  const base = '/api/v2/finance/books/:bookId/automations/journal-drafts';
  const service = async () => {
    const repo = services.financeJournalDrafts;
    if (!repo || !(await call(() => repo.checkReady())))
      throw new ApiProblem({
        status: 503,
        code: 'finance-journal-drafts-unavailable',
        title: 'Journal drafts unavailable',
        detail: 'The journal draft service is not enabled or ready.',
      });
    return repo;
  };
  const scoped = (
    raw: unknown,
    context: WorkspaceContext,
    bookId: string,
    resultId?: string,
  ) => {
    const value = parseServiceResponse(
      FinanceAutomationJournalDraftResultSchema,
      raw,
    );
    if (
      value.workspaceId !== context.workspaceId ||
      value.bookId !== bookId ||
      (resultId !== undefined && value.id !== resultId)
    )
      throw serviceContractProblem();
    return value;
  };
  for (const detail of [false, true])
    app.get(`${base}${detail ? '/:resultId' : ''}`, async (request, reply) => {
      const principal = await requirePrincipal(request, services);
      const context = workspaceContextFromLegacyPrincipal(
        principal,
        request.id,
      );
      const { bookId, resultId } = parseRequest(Params, request.params);
      const repo = await service();
      if (detail) {
        const raw = await call(() =>
          repo.readJournalDraftResult(context, bookId, resultId!),
        );
        if (raw === null)
          throw new ApiProblem({
            status: 404,
            code: 'finance-journal-draft-not-found',
            title: 'Journal draft not found',
            detail: 'This draft is unavailable in the current book.',
          });
        return reply
          .header('cache-control', 'no-store, private')
          .send(scoped(raw, context, bookId, resultId));
      }
      const page = parseRequest(Page, request.query);
      const value = parseServiceResponse(
        List,
        await call(() =>
          repo.listJournalDraftResults(
            context,
            bookId,
            page.offset,
            page.limit,
          ),
        ),
      );
      value.items.forEach((item) => scoped(item, context, bookId));
      if (
        value.offset !== page.offset ||
        value.limit !== page.limit ||
        value.items.length > page.limit ||
        new Set(value.items.map((item) => item.id)).size !== value.items.length
      )
        throw serviceContractProblem();
      return reply.header('cache-control', 'no-store, private').send(value);
    });
  app.post(
    `${base}/prepare`,
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
      const { bookId } = parseRequest(Params, request.params);
      const input = parseRequest(
        PrepareFinanceAutomationJournalDraftSchema,
        request.body,
      );
      const repo = await service();
      const result = parseServiceResponse(
        Prepared,
        await call(() =>
          repo.prepareJournalDraft(context, bookId, idempotencyKey, input),
        ),
      );
      if (result.journal.batchId !== input.batchId)
        throw serviceContractProblem();
      return reply.header('cache-control', 'no-store, private').send(result);
    },
  );
  for (const operation of ['review', 'discard', 'post'] as const)
    app.post(
      `${base}/:resultId/${operation}`,
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
        const { bookId, resultId } = parseRequest(Params, request.params);
        const input =
          operation === 'review'
            ? parseRequest(
                ReviewFinanceAutomationJournalDraftSchema,
                request.body,
              )
            : operation === 'discard'
              ? parseRequest(
                  DiscardFinanceAutomationJournalDraftSchema,
                  request.body,
                )
              : parseRequest(
                  PostFinanceAutomationJournalDraftSchema,
                  request.body,
                );
        const repo = await service();
        const raw = await call(() =>
          operation === 'review'
            ? repo.reviewJournalDraft(
                context,
                bookId,
                resultId!,
                idempotencyKey,
                input,
              )
            : operation === 'discard'
              ? repo.discardJournalDraft(
                  context,
                  bookId,
                  resultId!,
                  idempotencyKey,
                  input,
                )
              : repo.postJournalDraft(
                  context,
                  bookId,
                  resultId!,
                  idempotencyKey,
                  input,
                ),
        );
        return reply
          .header('cache-control', 'no-store, private')
          .send(scoped(raw, context, bookId, resultId));
      },
    );
}

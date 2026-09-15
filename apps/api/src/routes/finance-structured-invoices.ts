import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  UuidSchema,
  FinanceCurrencySchema,
  FinanceDecimalSchema,
  PostReviewedStructuredInvoiceSchema,
  SaveStructuredInvoiceReviewDraftSchema,
  StructuredInvoiceReviewDraftRecordSchema,
  StructuredInvoiceExtractionSchema,
  workspaceContextFromLegacyPrincipal,
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
export function registerFinanceStructuredInvoiceRoutes(
  app: FastifyInstance,
  services: ApiServices,
  bodyLimit: number,
) {
  const params = z.strictObject({ bookId: UuidSchema, evidenceId: UuidSchema });
  const ready = async () => {
    if (
      !services.financeV2 ||
      !(await services.financeV2.checkReady().catch(() => false))
    )
      throw new ApiProblem({
        status: 503,
        code: 'finance-v2-unavailable',
        title: 'Accounting unavailable',
        detail: 'Normalized accounting is not enabled or ready.',
      });
    return services.financeV2;
  };
  const base =
    '/api/v2/finance/books/:bookId/evidence/:evidenceId/structured-invoice';
  app.get(base, async (request, reply) => {
    const principal = await requirePrincipal(request, services),
      p = parseRequest(params, request.params),
      scope = workspaceContextFromLegacyPrincipal(principal, request.id);
    return reply
      .header('cache-control', 'no-store, private')
      .send(
        parseServiceResponse(
          StructuredInvoiceExtractionSchema,
          await (
            await ready()
          ).inspectStructuredInvoice(scope, p.bookId, p.evidenceId),
        ),
      );
  });
  app.get(`${base}/review-draft`, async (request, reply) => {
    const principal = await requirePrincipal(request, services),
      p = parseRequest(params, request.params);
    const result = await (
      await ready()
    ).getStructuredInvoiceReviewDraft(
      workspaceContextFromLegacyPrincipal(principal, request.id),
      p.bookId,
      p.evidenceId,
    );
    const parsed = parseServiceResponse(
      z.strictObject({
        review: StructuredInvoiceReviewDraftRecordSchema.nullable(),
        posting: z
          .object({
            id: UuidSchema,
            journalId: UuidSchema,
            status: z.enum(['issued', 'void']),
            total: FinanceDecimalSchema,
            currency: FinanceCurrencySchema,
          })
          .nullable(),
      }),
      result,
    );
    if (parsed.review && parsed.review.evidenceId !== p.evidenceId)
      throw serviceContractProblem();
    return reply.header('cache-control', 'no-store, private').send(parsed);
  });
  app.post(
    `${base}/review-draft`,
    { bodyLimit, onRequest: (r) => prepareAuthenticatedMutation(r, services) },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request),
        p = parseRequest(params, request.params),
        input = parseRequest(
          SaveStructuredInvoiceReviewDraftSchema,
          request.body,
        );
      parseRequest(UuidSchema, idempotencyKey);
      const result = parseServiceResponse(
        StructuredInvoiceReviewDraftRecordSchema,
        await (
          await ready()
        ).saveStructuredInvoiceReviewDraft(
          workspaceContextFromLegacyPrincipal(principal, request.id),
          p.bookId,
          p.evidenceId,
          idempotencyKey,
          input,
        ),
      );
      if (
        result.evidenceId !== p.evidenceId ||
        result.revision !== input.expectedRevision + 1
      )
        throw serviceContractProblem();
      return reply.header('cache-control', 'no-store, private').send(result);
    },
  );
  app.post(
    `${base}/review-and-post`,
    {
      bodyLimit,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request),
        p = parseRequest(params, request.params),
        review = parseRequest(
          PostReviewedStructuredInvoiceSchema,
          request.body,
        );
      parseRequest(UuidSchema, idempotencyKey);
      const result = await (
        await ready()
      ).postReviewedStructuredInvoice(
        workspaceContextFromLegacyPrincipal(principal, request.id),
        p.bookId,
        p.evidenceId,
        idempotencyKey,
        review,
      );
      const parsed = parseServiceResponse(
        z.strictObject({
          id: UuidSchema,
          journalId: UuidSchema,
          total: FinanceDecimalSchema,
          currency: FinanceCurrencySchema,
          evidenceId: UuidSchema,
          sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
          adapterVersion: z.literal('structured-invoice.v1'),
        }),
        result,
      );
      if (
        parsed.evidenceId !== p.evidenceId ||
        parsed.sourceDigest !== review.expectedSourceDigest
      )
        throw serviceContractProblem();
      return reply.header('cache-control', 'no-store, private').send(parsed);
    },
  );
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  UuidSchema,
  ReviewPrivateTaxWageEvidenceSchema,
  CreatePrivateTaxCalculationRunSchema,
  ReviewPrivateTaxWorkingInputsSchema,
  ReviewPrivateTaxCalculationRunSchema,
  workspaceContextFromLegacyPrincipal,
  ResetPrivateTaxInputsSchema,
  CreatePrivateTaxCaseSchema,
  BindPrivateTaxLegalEntitySchema,
  RecordPrivateTaxDeclarationSchema,
  SavePrivateTaxAnswerSchema,
  ReviewPrivateTaxAnswerSchema,
  WithdrawPrivateTaxAnswerSchema,
  GrantPrivateTaxCaseSchema,
  RevokePrivateTaxCaseGrantSchema,
  AuthorizePrivateTaxBookSourceSchema,
} from '@emdo/contracts';
import { ApiProblem } from '../problem.js';
import {
  parseRequest,
  prepareAuthenticatedMutation,
  requirePrincipal,
  takePreparedMutation,
} from '../request-context.js';
import type { ApiServices } from '../services/contracts.js';

const Params = z.strictObject({
  caseId: UuidSchema,
  authorizationId: UuidSchema.optional(),
});
const Revision = z.number().int().positive().max(2147483647);
const ListQuery = z.strictObject({
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const CaseQuery = z.strictObject({
  revision: z.coerce.number().int().positive().max(2147483647).optional(),
});
const RevokeBook = z.strictObject({ expectedAuthorizationRevision: Revision });
const base = '/api/v2/finance/tax/cases';

/** Case grants are checked by persistence, independently of book membership. */
export function registerFinanceTaxRoutes(
  app: FastifyInstance,
  services: ApiServices,
  bodyLimit: number,
) {
  const service = async () => {
    if (
      !services.financeTax ||
      !services.financeV2 ||
      !(await services.financeV2.checkReady().catch(() => false)) ||
      !(await services.financeTax.checkReady().catch(() => false))
    )
      throw new ApiProblem({
        status: 503,
        code: 'finance-tax-unavailable',
        title: 'Private tax preparation unavailable',
        detail: 'The private tax preparation service is not enabled or ready.',
      });
    return services.financeTax;
  };
  const context = async (request: FastifyRequest) =>
    workspaceContextFromLegacyPrincipal(
      await requirePrincipal(request, services),
      request.id,
    );
  app.get(base, async (request, reply) => {
    const scope = await context(request),
      query = parseRequest(ListQuery, request.query);
    return reply.header('cache-control', 'no-store, private').send({
      cases: await (
        await service()
      ).listCases(scope, query.offset, query.limit),
    });
  });
  for (const operation of [
    'detail',
    'assessment',
    'declarations',
    'grants',
  ] as const) {
    app.get(
      `${base}/:caseId${operation === 'detail' ? '' : `/${operation}`}`,
      async (request, reply) => {
        const scope = await context(request),
          { caseId } = parseRequest(Params, request.params),
          api = await service();
        const query = parseRequest(
          operation === 'detail' ? CaseQuery : z.strictObject({}),
          request.query,
        );
        const result =
          operation === 'detail'
            ? await api.getCase(
                scope,
                caseId,
                'revision' in query ? query.revision : undefined,
              )
            : operation === 'assessment'
              ? await api.assessCase(scope, caseId)
              : operation === 'grants'
                ? await api.listCaseGrants(scope, caseId)
                : await api.listDeclarations(scope, caseId);
        return reply.header('cache-control', 'no-store, private').send(result);
      },
    );
  }
  app.post(
    base,
    {
      bodyLimit,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      const key = parseRequest(UuidSchema, idempotencyKey),
        input = parseRequest(CreatePrivateTaxCaseSchema, request.body);
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (
            await service()
          ).createCase(
            workspaceContextFromLegacyPrincipal(principal, request.id),
            key,
            input,
          ),
        );
    },
  );
  const mutations = [
    ['legal-entity', 'bindLegalEntity', BindPrivateTaxLegalEntitySchema],
    [
      'working-papers/input-reviews',
      'reviewWorkingPaperInputs',
      ReviewPrivateTaxWorkingInputsSchema,
    ],
    [
      'working-papers/wage-evidence-reviews',
      'reviewWageEvidence',
      ReviewPrivateTaxWageEvidenceSchema,
    ],
    ['runs', 'createCalculationRun', CreatePrivateTaxCalculationRunSchema],
    [
      'reset-after-source-revocation',
      'resetInputsAfterSourceRevocation',
      ResetPrivateTaxInputsSchema,
    ],
    ['declarations', 'recordDeclaration', RecordPrivateTaxDeclarationSchema],
    ['answers', 'saveAnswer', SavePrivateTaxAnswerSchema],
    ['answers/review', 'reviewAnswer', ReviewPrivateTaxAnswerSchema],
    ['answers/withdraw', 'withdrawAnswer', WithdrawPrivateTaxAnswerSchema],
    ['grants', 'grantCaseAccess', GrantPrivateTaxCaseSchema],
    ['grants/revoke', 'revokeCaseAccess', RevokePrivateTaxCaseGrantSchema],
    [
      'book-sources',
      'authorizeBookSource',
      AuthorizePrivateTaxBookSourceSchema,
    ],
  ] as const;
  for (const [path, method, schema] of mutations)
    app.post(
      `${base}/:caseId/${path}`,
      {
        bodyLimit,
        onRequest: (request) => prepareAuthenticatedMutation(request, services),
      },
      async (request, reply) => {
        const { principal, idempotencyKey } = takePreparedMutation(request),
          { caseId } = parseRequest(Params, request.params);
        const key = parseRequest(UuidSchema, idempotencyKey),
          input = parseRequest<unknown>(schema, request.body),
          api = await service();
        return reply
          .header('cache-control', 'no-store, private')
          .send(
            await api[method](
              workspaceContextFromLegacyPrincipal(principal, request.id),
              caseId,
              key,
              input,
            ),
          );
      },
    );
  app.post(
    `${base}/:caseId/book-sources/:authorizationId/revoke`,
    {
      bodyLimit,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request),
        { caseId, authorizationId } = parseRequest(Params, request.params);
      const key = parseRequest(UuidSchema, idempotencyKey),
        input = parseRequest(RevokeBook, request.body);
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (
            await service()
          ).revokeBookSource(
            workspaceContextFromLegacyPrincipal(principal, request.id),
            caseId,
            key,
            authorizationId!,
            input.expectedAuthorizationRevision,
          ),
        );
    },
  );
  app.get(`${base}/:caseId/working-papers`, async (request, reply) => {
    const scope = await context(request),
      { caseId } = parseRequest(Params, request.params);
    parseRequest(z.strictObject({}), request.query);
    return reply
      .header('cache-control', 'no-store, private')
      .send(await (await service()).getWorkingPaperPreparation(scope, caseId));
  });
  app.get(
    `${base}/:caseId/working-papers/wage-evidence`,
    async (request, reply) => {
      const scope = await context(request),
        { caseId } = parseRequest(Params, request.params);
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (await service()).getWageEvidencePreparation(scope, caseId),
        );
    },
  );
  app.get(
    `${base}/:caseId/working-papers/wage-original`,
    async (request, reply) => {
      const scope = await context(request),
        { caseId } = parseRequest(Params, request.params),
        query = parseRequest(
          z.strictObject({ bookId: UuidSchema, evidenceId: UuidSchema }),
          request.query,
        );
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (
            await service()
          ).getWageOriginal(scope, caseId, query.bookId, query.evidenceId),
        );
    },
  );
  app.get(`${base}/:caseId/runs`, async (request, reply) => {
    const scope = await context(request),
      { caseId } = parseRequest(Params, request.params),
      query = parseRequest(ListQuery, request.query);
    return reply.header('cache-control', 'no-store, private').send({
      runs: await (
        await service()
      ).listCalculationRuns(scope, caseId, query.offset, query.limit),
    });
  });
  const RunParams = z.strictObject({ caseId: UuidSchema, runId: UuidSchema });
  app.get(`${base}/:caseId/runs/:runId`, async (request, reply) => {
    const scope = await context(request),
      { caseId, runId } = parseRequest(RunParams, request.params);
    parseRequest(z.strictObject({}), request.query);
    return reply
      .header('cache-control', 'no-store, private')
      .send(await (await service()).getCalculationRun(scope, caseId, runId));
  });
  app.get(`${base}/:caseId/runs/:runId/export`, async (request, reply) => {
    const scope = await context(request),
      { caseId, runId } = parseRequest(RunParams, request.params),
      { reviewId } = parseRequest(
        z.strictObject({ reviewId: UuidSchema }),
        request.query,
      );
    return reply
      .header('cache-control', 'no-store, private')
      .send(
        await (
          await service()
        ).exportCalculationRun(scope, caseId, runId, reviewId),
      );
  });
  app.post(
    `${base}/:caseId/runs/:runId/reviews`,
    {
      bodyLimit,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request),
        { caseId, runId } = parseRequest(RunParams, request.params);
      return reply
        .header('cache-control', 'no-store, private')
        .send(
          await (
            await service()
          ).reviewCalculationRun(
            workspaceContextFromLegacyPrincipal(principal, request.id),
            caseId,
            runId,
            parseRequest(UuidSchema, idempotencyKey),
            parseRequest(ReviewPrivateTaxCalculationRunSchema, request.body),
          ),
        );
    },
  );
}

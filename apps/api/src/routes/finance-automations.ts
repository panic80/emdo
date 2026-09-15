import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FinanceAutomationCapabilitySchema,
  FinanceAutomationGrantSchema,
  FinanceAutomationJournalDraftIntentSchema,
  FinanceAutomationExtractionIntentSchema,
  FinanceAutomationExtractionResultSchema,
  FinanceAutomationPlanningIntentSchema,
  FinanceAutomationRunRecordSchema,
  FinanceAutomationLimitsSchema,
  FinanceMoneySchema,
  FinanceReportSelectionSchema,
  IsoDateTimeSchema,
  UuidSchema,
  Sha256Schema,
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

const Params = z.strictObject({
  bookId: UuidSchema,
  grantId: UuidSchema.optional(),
});
const Grant = z.strictObject({
  capabilities: FinanceAutomationGrantSchema.shape.allowedCapabilities,
  limits: FinanceAutomationLimitsSchema,
  validFrom: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
});
const Run = z
  .strictObject({
    grantId: UuidSchema,
    capability: FinanceAutomationCapabilitySchema,
    targets: z.array(UuidSchema).min(1).max(10000),
    currency: FinanceMoneySchema.shape.currency,
    amount: FinanceMoneySchema.shape.amount,
    report: FinanceReportSelectionSchema.optional(),
    planning: FinanceAutomationPlanningIntentSchema.optional(),
    extraction: FinanceAutomationExtractionIntentSchema.optional(),
    journal: FinanceAutomationJournalDraftIntentSchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      (value.capability === 'finance.journals.draft') !==
        (value.journal !== undefined) ||
      (value.journal &&
        (value.targets.length !== 1 ||
          value.targets[0] !== value.journal.batchId ||
          value.report !== undefined ||
          value.planning !== undefined ||
          value.extraction !== undefined))
    )
      context.addIssue({
        code: 'custom',
        path: ['journal'],
        message:
          'Journal drafting requires one exact import source and no other intent',
      });
    if (
      (value.capability === 'finance.documents.extract') !==
        (value.extraction !== undefined) ||
      (value.extraction &&
        (value.targets.length !== 1 ||
          value.targets[0] !== value.extraction.evidenceId ||
          !/^0(?:\.0+)?$/.test(value.amount) ||
          value.report !== undefined ||
          value.planning !== undefined ||
          value.journal !== undefined))
    )
      context.addIssue({
        code: 'custom',
        path: ['extraction'],
        message:
          'Document extraction requires one matching source, zero amount and no other intent',
      });
  });
/** UUIDv8 derived from authenticated scope and an opaque retry key, never from queue authority. */
function operationId(
  workspaceId: string,
  userId: string,
  bookId: string,
  operation: string,
  key: string,
) {
  const bytes = createHash('sha256')
    .update(
      JSON.stringify([
        'finance-automation.v1',
        workspaceId,
        userId,
        bookId,
        operation,
        key,
      ]),
    )
    .digest();
  bytes[6] = (bytes[6]! & 15) | 128;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function registerFinanceAutomationRoutes(
  app: FastifyInstance,
  services: ApiServices,
  bodyLimit: number,
) {
  const service = async () => {
    const repository = services.financeAutomations;
    if (!repository || !(await repository.checkReady().catch(() => false)))
      throw new ApiProblem({
        status: 503,
        code: 'finance-automations-unavailable',
        title: 'Finance automations unavailable',
        detail: 'The automation authority service is not enabled or ready.',
      });
    return repository;
  };
  app.get(
    '/api/v2/finance/books/:bookId/automations/grants',
    async (request, reply) => {
      const principal = await requirePrincipal(request, services),
        { bookId } = parseRequest(Params, request.params);
      const context = workspaceContextFromLegacyPrincipal(
        principal,
        request.id,
      );
      const grants = parseServiceResponse(
        z.array(FinanceAutomationGrantSchema),
        await (await service()).listGrants(context, bookId),
      );
      if (
        grants.some(
          (grant) =>
            grant.workspaceId !== context.workspaceId ||
            grant.bookId !== bookId,
        )
      )
        throw serviceContractProblem();
      return reply
        .header('cache-control', 'no-store, private')
        .send({ grants });
    },
  );
  for (const detail of [false, true])
    app.get(
      `/api/v2/finance/books/:bookId/automations/runs${detail ? '/:operationId' : ''}`,
      async (request, reply) => {
        reply.header('cache-control', 'no-store, private');
        const principal = await requirePrincipal(request, services);
        const params = parseRequest(
          z.strictObject({
            bookId: UuidSchema,
            operationId: UuidSchema.optional(),
          }),
          request.params,
        );
        const context = workspaceContextFromLegacyPrincipal(
          principal,
          request.id,
        );
        const repository = await service();
        const scopeMatches = (
          record: z.infer<typeof FinanceAutomationRunRecordSchema>,
        ) =>
          record.run.request.workspaceId === context.workspaceId &&
          record.run.request.bookId === params.bookId;
        if (detail) {
          const raw = await repository.getRun(
            context,
            params.bookId,
            params.operationId!,
          );
          if (!raw)
            throw new ApiProblem({
              status: 404,
              code: 'finance-automation-run-not-found',
              title: 'Run not found',
              detail: 'This run is unavailable in the selected book.',
            });
          const result = parseServiceResponse(
            FinanceAutomationRunRecordSchema,
            raw,
          );
          if (
            !scopeMatches(result) ||
            result.run.request.operationId !== params.operationId
          )
            throw serviceContractProblem();
          return reply.send(result);
        }
        const page = parseRequest(
          z.strictObject({
            offset: z.coerce.number().int().min(0).max(1000000).default(0),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
          request.query,
        );
        const result = parseServiceResponse(
          z.strictObject({
            runs: z.array(FinanceAutomationRunRecordSchema).max(page.limit),
            nextOffset: z.number().int().nonnegative().nullable(),
          }),
          await repository.listRuns(
            context,
            params.bookId,
            page.offset,
            page.limit,
          ),
        );
        if (
          result.runs.some((record) => !scopeMatches(record)) ||
          new Set(result.runs.map((record) => record.run.request.operationId))
            .size !== result.runs.length ||
          (result.nextOffset !== null &&
            (result.runs.length !== page.limit ||
              result.nextOffset !== page.offset + page.limit))
        )
          throw serviceContractProblem();
        return reply.send(result);
      },
    );
  app.get(
    '/api/v2/finance/books/:bookId/automations/extractions/results/:resultId',
    async (request, reply) => {
      const principal = await requirePrincipal(request, services);
      const { bookId, resultId } = parseRequest(
        z.strictObject({ bookId: UuidSchema, resultId: UuidSchema }),
        request.params,
      );
      const context = workspaceContextFromLegacyPrincipal(
        principal,
        request.id,
      );
      const repository = await service();
      const result = parseServiceResponse(
        FinanceAutomationExtractionResultSchema,
        await repository.readExtractionResult(context, bookId, resultId),
      );
      if (
        result.workspaceId !== context.workspaceId ||
        result.bookId !== bookId ||
        result.operationId !== resultId
      )
        throw serviceContractProblem();
      return reply.header('cache-control', 'no-store, private').send(result);
    },
  );
  app.post(
    '/api/v2/finance/books/:bookId/automations/extractions/prepare',
    {
      bodyLimit,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      const { bookId } = parseRequest(Params, request.params);
      const input = parseRequest(
        z.strictObject({
          evidenceId: UuidSchema,
          expectedSourceDigest: Sha256Schema,
        }),
        request.body,
      );
      const context = workspaceContextFromLegacyPrincipal(
        principal,
        request.id,
      );
      const repository = await service();
      const result = parseServiceResponse(
        FinanceAutomationExtractionIntentSchema,
        await repository.prepareExtraction(
          context,
          bookId,
          operationId(
            context.workspaceId,
            context.userId,
            bookId,
            'prepare-extraction',
            idempotencyKey,
          ),
          input,
        ),
      );
      if (
        result.evidenceId !== input.evidenceId ||
        result.expectedSourceDigest !== input.expectedSourceDigest
      )
        throw serviceContractProblem();
      return reply.header('cache-control', 'no-store, private').send(result);
    },
  );
  for (const operation of ['grant', 'revoke', 'enqueue'] as const) {
    const suffix =
      operation === 'grant'
        ? '/grants'
        : operation === 'revoke'
          ? '/grants/:grantId/revoke'
          : '/runs';
    app.post(
      `/api/v2/finance/books/:bookId/automations${suffix}`,
      {
        bodyLimit,
        onRequest: (request) => prepareAuthenticatedMutation(request, services),
      },
      async (request, reply) => {
        const { principal, idempotencyKey } = takePreparedMutation(request),
          { bookId, grantId } = parseRequest(Params, request.params);
        const context = workspaceContextFromLegacyPrincipal(
            principal,
            request.id,
          ),
          repository = await service();
        const id = operationId(
          context.workspaceId,
          context.userId,
          bookId,
          operation,
          idempotencyKey,
        );
        let result;
        if (operation === 'grant')
          result = await repository.createGrant(context, bookId, {
            ...parseRequest(Grant, request.body),
            id,
          });
        else if (operation === 'revoke') {
          parseRequest(z.strictObject({}), request.body ?? {});
          result = await repository.revokeGrant(context, bookId, grantId!);
        } else
          result = await repository.enqueueRun(context, bookId, {
            ...parseRequest(Run, request.body),
            operationId: id,
          });
        if (operation !== 'enqueue') {
          result = parseServiceResponse(FinanceAutomationGrantSchema, result);
          if (
            result.workspaceId !== context.workspaceId ||
            result.bookId !== bookId ||
            result.id !== (operation === 'grant' ? id : grantId) ||
            (operation === 'grant' &&
              result.grantedByUserId !== context.userId) ||
            (operation === 'revoke' && result.status !== 'revoked')
          )
            throw serviceContractProblem();
        }
        return reply.header('cache-control', 'no-store, private').send(result);
      },
    );
  }
}

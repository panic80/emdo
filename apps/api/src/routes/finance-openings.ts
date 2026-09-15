import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FinanceLegacyOpeningPostRequestSchema,
  FinanceOpeningProofSchema,
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

export interface FinanceOpeningRouteService {
  checkReady(): Promise<boolean>;
  postLegacyOpening(
    context: WorkspaceContext,
    bookId: string,
    migrationId: string,
    recordId: string,
    input: unknown,
  ): Promise<unknown>;
  getLatest(
    context: WorkspaceContext,
    bookId: string,
    accountId: string,
  ): Promise<unknown>;
}
const Params = z.strictObject({
  bookId: UuidSchema,
  migrationId: UuidSchema,
  recordId: UuidSchema,
});
const AccountParams = z.strictObject({
  bookId: UuidSchema,
  accountId: UuidSchema,
});
async function execute<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error
        ? String(error.code)
        : 'unavailable';
    throw new ApiProblem({
      status:
        code === 'authorization-revoked'
          ? 403
          : code === 'conflict'
            ? 409
            : code === 'invalid-input'
              ? 400
              : 503,
      code:
        'finance-opening-' +
        (['authorization-revoked', 'conflict', 'invalid-input'].includes(code)
          ? code
          : 'unavailable'),
      title: 'Opening balance unavailable',
      detail:
        'Check current access, reviewed evidence, revisions, and the accounting period.',
    });
  }
}
export function registerFinanceOpeningRoutes(
  app: FastifyInstance,
  services: ApiServices,
  bodyLimit: number,
) {
  const service = async () => {
    const candidate = services.financeOpenings;
    if (!candidate || !(await candidate.checkReady().catch(() => false)))
      throw new ApiProblem({
        status: 503,
        code: 'finance-openings-unavailable',
        title: 'Opening balances unavailable',
        detail: 'The opening balance service is not ready.',
      });
    return candidate;
  };
  app.post(
    '/api/v2/finance/books/:bookId/legacy-migrations/:migrationId/records/:recordId/opening',
    {
      bodyLimit,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      const params = parseRequest(Params, request.params);
      const input = parseRequest(
        FinanceLegacyOpeningPostRequestSchema,
        request.body,
      );
      if (input.idempotencyKey !== idempotencyKey)
        throw new ApiProblem({
          status: 400,
          code: 'finance-opening-key-mismatch',
          title: 'Opening request is invalid',
          detail: 'The request and idempotency header must match.',
        });
      const context = workspaceContextFromLegacyPrincipal(
        principal,
        request.id,
      );
      const repository = await service();
      const result = parseServiceResponse(
        FinanceOpeningProofSchema,
        await execute(() =>
          repository.postLegacyOpening(
            context,
            params.bookId,
            params.migrationId,
            params.recordId,
            input,
          ),
        ),
      );
      if (
        result.workspaceId !== context.workspaceId ||
        result.bookId !== params.bookId ||
        result.migrationId !== params.migrationId ||
        result.sourceRecordId !== params.recordId ||
        result.sourceOwnerUserId !== context.userId
      )
        throw serviceContractProblem();
      return reply.header('cache-control', 'no-store, private').send(result);
    },
  );
  app.get(
    '/api/v2/finance/books/:bookId/financial-accounts/:accountId/opening',
    async (request, reply) => {
      const principal = await requirePrincipal(request, services);
      const params = parseRequest(AccountParams, request.params);
      const context = workspaceContextFromLegacyPrincipal(
        principal,
        request.id,
      );
      const repository = await service();
      const result = parseServiceResponse(
        FinanceOpeningProofSchema.nullable(),
        await execute(() =>
          repository.getLatest(context, params.bookId, params.accountId),
        ),
      );
      if (
        result &&
        (result.workspaceId !== context.workspaceId ||
          result.bookId !== params.bookId ||
          result.financialAccountId !== params.accountId ||
          result.sourceOwnerUserId !== context.userId)
      )
        throw serviceContractProblem();
      return reply
        .header('cache-control', 'no-store, private')
        .send({ opening: result });
    },
  );
}

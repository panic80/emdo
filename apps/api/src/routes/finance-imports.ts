import type { FastifyInstance } from 'fastify';

import {
  parseRequest,
  parseServiceResponse,
  prepareAuthenticatedMutation,
  prepareAuthenticatedMutationProof,
  requirePrincipal,
  takePreparedMutationProof,
  takePreparedMutation,
} from '../request-context.js';
import {
  FinanceImportCommitRequestSchema,
  FinanceImportCommitResponseSchema,
  FinanceImportDestinationsSchema,
  FinanceImportPreviewRequestSchema,
  FinanceImportPreviewResponseSchema,
} from '../schemas.js';
import type { ApiServices } from '../services/contracts.js';

export const registerFinanceImportRoutes = (
  app: FastifyInstance,
  services: ApiServices,
  maximumJsonBodyBytes: number,
): void => {
  app.get('/api/v1/finance/imports/options', async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const result = parseServiceResponse(
      FinanceImportDestinationsSchema,
      await services.financeImports.listDestinations({
        principal,
        requestId: request.id,
      }),
    );
    return reply.header('cache-control', 'no-store, private').send(result);
  });

  app.post(
    '/api/v1/finance/imports/preview',
    {
      bodyLimit: maximumJsonBodyBytes,
      onRequest: (request) =>
        prepareAuthenticatedMutationProof(request, services),
    },
    async (request, reply) => {
      const { principal } = takePreparedMutationProof(request);
      const input = parseRequest(
        FinanceImportPreviewRequestSchema,
        request.body,
      );
      const result = parseServiceResponse(
        FinanceImportPreviewResponseSchema,
        await services.financeImports.preview({
          accountId: input.accountId,
          format: input.format,
          mapping: input.mapping,
          sourceText: input.sourceText,
          principal,
          requestId: request.id,
        }),
      );
      return reply.header('cache-control', 'no-store, private').send(result);
    },
  );

  app.post(
    '/api/v1/finance/imports/commit',
    {
      bodyLimit: maximumJsonBodyBytes,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      const input = parseRequest(
        FinanceImportCommitRequestSchema,
        request.body,
      );
      const result = parseServiceResponse(
        FinanceImportCommitResponseSchema,
        await services.financeImports.commit({
          planId: input.planId,
          idempotencyKey,
          principal,
          requestId: request.id,
        }),
      );
      return reply.header('cache-control', 'no-store, private').send(result);
    },
  );
};

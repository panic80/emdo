import type { FastifyInstance } from 'fastify';

import {
  parseRequest,
  parseServiceResponse,
  requireIdempotencyKey,
  requireMutationProof,
  requirePrincipal,
} from '../request-context.js';
import {
  GoogleAuthorizeResponseSchema,
  GoogleCallbackQuerySchema,
  GoogleCallbackResponseSchema,
  GoogleDisconnectRequestSchema,
  GoogleDisconnectResponseSchema,
  createGoogleAuthorizeRequestSchema,
} from '../schemas.js';
import type { ApiServices } from '../services/contracts.js';

export const registerGoogleRoutes = (
  app: FastifyInstance,
  services: ApiServices,
  maximumJsonBodyBytes: number,
): void => {
  const authorizeRequestSchema = createGoogleAuthorizeRequestSchema();
  app.post(
    '/api/v1/connectors/google/authorize',
    { bodyLimit: maximumJsonBodyBytes },
    async (request, reply) => {
      const principal = await requirePrincipal(request, services);
      await requireMutationProof(request, services, principal);
      const idempotencyKey = requireIdempotencyKey(request);
      const input = parseRequest(authorizeRequestSchema, request.body);
      const result = parseServiceResponse(
        GoogleAuthorizeResponseSchema,
        await services.google.beginAuthorization({
          principal,
          purpose: input.purpose,
          requestId: request.id,
          idempotencyKey,
        }),
      );
      return reply.header('cache-control', 'no-store').send(result);
    },
  );

  app.get('/api/v1/connectors/google/callback', async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const input = parseRequest(GoogleCallbackQuerySchema, request.query);
    const result = parseServiceResponse(
      GoogleCallbackResponseSchema,
      await services.google.completeAuthorization({
        code: input.code,
        state: input.state,
        error: input.error,
        errorDescription: input.error_description,
        principal,
        requestId: request.id,
      }),
    );
    return reply.header('cache-control', 'no-store').send(result);
  });

  app.post(
    '/api/v1/connectors/google/disconnect',
    { bodyLimit: maximumJsonBodyBytes },
    async (request, reply) => {
      const principal = await requirePrincipal(request, services);
      await requireMutationProof(request, services, principal);
      const idempotencyKey = requireIdempotencyKey(request);
      parseRequest(GoogleDisconnectRequestSchema, request.body);
      const result = parseServiceResponse(
        GoogleDisconnectResponseSchema,
        await services.google.disconnect({
          principal,
          requestId: request.id,
          idempotencyKey,
        }),
      );
      return reply.header('cache-control', 'no-store').send(result);
    },
  );
};

import type { FastifyInstance } from 'fastify';

import { ApiProblem, serviceContractProblem } from '../problem.js';
import {
  parseRequest,
  parseServiceResponse,
  requireIdempotencyKey,
  requireMutationProof,
  requirePrincipal,
} from '../request-context.js';
import {
  SyncClientRegistrationRequestSchema,
  SyncClientRegistrationResponseSchema,
  SyncTokenQuerySchema,
  SyncTokenResponseSchema,
  SyncUploadRequestSchema,
  SyncUploadResponseSchema,
} from '../schemas.js';
import type { ApiServices } from '../services/contracts.js';

const callSyncService = async <Result>(work: () => Promise<Result>) => {
  try {
    return await work();
  } catch (error) {
    const code =
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : undefined;
    if (code === 'sync-idempotency-conflict') {
      throw new ApiProblem({
        status: 409,
        code,
        title: 'Synchronization request conflict',
        detail: 'The idempotency key is already bound to another request.',
      });
    }
    if (code === 'sync-operation-in-progress') {
      throw new ApiProblem({
        status: 409,
        code,
        title: 'Synchronization request in progress',
        detail: 'An exact synchronization request is already in progress.',
      });
    }
    if (code === 'sync-authorization-revoked') {
      throw new ApiProblem({
        status: 403,
        code,
        title: 'Synchronization authority revoked',
        detail: 'The current session no longer has synchronization authority.',
      });
    }
    if (code === 'sync-configuration-invalid') {
      throw new ApiProblem({
        status: 503,
        code,
        title: 'Synchronization unavailable',
        detail: 'Synchronization is not configured safely.',
      });
    }
    if (code === 'sync-result-invalid') throw serviceContractProblem();
    throw error;
  }
};

export const registerSyncRoutes = (
  app: FastifyInstance,
  services: ApiServices,
  maximumJsonBodyBytes: number,
  publicOrigin: string,
): void => {
  app.post(
    '/api/v1/sync/clients',
    { bodyLimit: maximumJsonBodyBytes },
    async (request, reply) => {
      const principal = await requirePrincipal(request, services);
      await requireMutationProof(request, services, principal);
      const idempotencyKey = requireIdempotencyKey(request);
      const input = parseRequest(
        SyncClientRegistrationRequestSchema,
        request.body,
      );
      const result = parseServiceResponse(
        SyncClientRegistrationResponseSchema,
        await callSyncService(() =>
          services.sync.registerClient({
            clientId: input.clientId,
            displayName: input.displayName,
            principal,
            requestId: request.id,
            idempotencyKey,
          }),
        ),
      );
      if (result.clientId !== input.clientId) throw serviceContractProblem();
      return reply.status(201).send(result);
    },
  );

  app.get('/api/v1/sync/token', async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const { clientId } = parseRequest(SyncTokenQuerySchema, request.query);
    const token = parseServiceResponse(
      SyncTokenResponseSchema,
      await callSyncService(() =>
        services.sync.issueToken({
          clientId,
          principal,
          requestId: request.id,
        }),
      ),
    );
    const seenSpaces = new Set<string>();
    if (
      token.endpoint !== `${publicOrigin}/powersync` ||
      token.writeScope.clientId !== clientId ||
      token.writeScope.spaces.some((space) => {
        if (seenSpaces.has(space.id)) return true;
        seenSpaces.add(space.id);
        return (
          space.visibility === 'private' &&
          space.originalOwnerUserId !== principal.userId
        );
      })
    ) {
      throw serviceContractProblem();
    }
    return reply.header('cache-control', 'no-store').send(token);
  });

  app.post(
    '/api/v1/sync/ops',
    { bodyLimit: maximumJsonBodyBytes },
    async (request, reply) => {
      const principal = await requirePrincipal(request, services);
      await requireMutationProof(request, services, principal);
      const idempotencyKey = requireIdempotencyKey(request);
      const input = parseRequest(SyncUploadRequestSchema, request.body);
      const result = parseServiceResponse(
        SyncUploadResponseSchema,
        await callSyncService(() =>
          services.sync.applyOperations({
            clientId: input.clientId,
            operations: input.operations,
            principal,
            requestId: request.id,
            idempotencyKey,
          }),
        ),
      );
      const submittedOperationIds = new Set(
        input.operations.map((operation) => operation.operationId),
      );
      const resultOperationIds = new Set(
        result.results.map((operation) => operation.operationId),
      );
      if (
        result.clientId !== input.clientId ||
        resultOperationIds.size !== result.results.length ||
        resultOperationIds.size !== submittedOperationIds.size ||
        [...resultOperationIds].some((id) => !submittedOperationIds.has(id))
      ) {
        throw serviceContractProblem();
      }
      return reply.send(result);
    },
  );
};

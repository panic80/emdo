import type { FastifyInstance } from 'fastify';

import type { ApiLimits } from '../config.js';
import { ApiProblem } from '../problem.js';
import {
  parseRequest,
  parseServiceResponse,
  requireIdempotencyKey,
  requireMutationProof,
  requirePrincipal,
} from '../request-context.js';
import { TurnAcceptanceSchema, TurnRequestSchema } from '../schemas.js';
import type { ApiServices } from '../services/contracts.js';

export const registerTurnRoutes = (
  app: FastifyInstance,
  services: ApiServices,
  limits: ApiLimits,
): void => {
  app.post(
    '/api/v1/turns',
    { bodyLimit: limits.maximumJsonBodyBytes },
    async (request, reply) => {
      const principal = await requirePrincipal(request, services);
      await requireMutationProof(request, services, principal);
      const idempotencyKey = requireIdempotencyKey(request);
      const input = parseRequest(TurnRequestSchema, request.body);
      if (input.message.length > limits.maximumTurnCharacters) {
        throw new ApiProblem({
          status: 400,
          code: 'turn-message-too-long',
          title: 'Turn message too long',
          detail: 'The turn message exceeds the configured character limit.',
        });
      }
      const accepted = parseServiceResponse(
        TurnAcceptanceSchema,
        await services.managerTurns.start({
          request: input,
          principal,
          requestId: request.id,
          idempotencyKey,
        }),
      );
      return reply.status(202).send(accepted);
    },
  );
};

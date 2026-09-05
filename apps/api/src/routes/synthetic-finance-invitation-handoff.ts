import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ApiProblem } from '../problem.js';
import {
  prepareAuthenticatedMutation,
  takePreparedMutation,
} from '../request-context.js';
import type { ApiServices } from '../services/contracts.js';
import { isLoopbackIp } from '../trusted-ingress.js';
import type { SyntheticFinanceInvitationHandoff } from '../production/synthetic-finance-invitation-handoff.js';

const InvitationIdSchema = z.strictObject({
  invitationId: z.uuid(),
});

const HandoffResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  invitationToken: z
    .string()
    .length(43)
    .regex(/^[A-Za-z0-9_-]+$/u),
});

const unavailable = (): ApiProblem =>
  new ApiProblem({
    status: 404,
    code: 'route-unavailable',
    title: 'Route unavailable',
    detail: 'The requested route is unavailable.',
  });

const requireLoopback = (request: FastifyRequest): void => {
  if (!isLoopbackIp(request.ip)) throw unavailable();
};

/**
 * This route is registered only by the Finance synthetic-staging composition.
 * It is not an OpenAPI/browser capability and cannot receive proxy ingress.
 */
export const registerSyntheticFinanceInvitationHandoffRoute = (
  app: FastifyInstance,
  services: ApiServices,
  handoff: SyntheticFinanceInvitationHandoff,
): void => {
  app.post(
    '/api/internal/finance-synthetic/invitation-token',
    {
      onRequest: async (request) => {
        requireLoopback(request);
        await prepareAuthenticatedMutation(request, services);
      },
    },
    async (request, reply) => {
      const { principal } = takePreparedMutation(request);
      if (principal.role !== 'owner') throw unavailable();
      const input = InvitationIdSchema.safeParse(request.body);
      if (!input.success) throw unavailable();
      const result = handoff.take({
        invitationId: input.data.invitationId,
        principal,
      });
      if (result === undefined) throw unavailable();
      return reply
        .header('cache-control', 'no-store, private')
        .send(HandoffResponseSchema.parse({ schemaVersion: 1, ...result }));
    },
  );
};

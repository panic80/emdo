import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  type SyntheticFinanceAccountProvisioner,
  SYNTHETIC_FINANCE_ACCOUNT_ID,
} from '../production/synthetic-finance-account-provisioner.js';
import { ApiProblem } from '../problem.js';
import {
  prepareAuthenticatedMutation,
  takePreparedMutation,
} from '../request-context.js';
import type { ApiServices } from '../services/contracts.js';
import { isLoopbackIp } from '../trusted-ingress.js';

const AccountProvisionRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
});

const AccountProvisionResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  accountId: z.literal(SYNTHETIC_FINANCE_ACCOUNT_ID),
  status: z.enum(['applied', 'duplicate']),
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
 * This route is registered only by the exact Finance synthetic-staging
 * composition. It deliberately accepts no client-controlled account or scope
 * fields, and rejects inaccessible attempts as an unavailable capability.
 */
export const registerSyntheticFinanceAccountProvisionerRoute = (
  app: FastifyInstance,
  services: ApiServices,
  provisioner: SyntheticFinanceAccountProvisioner,
): void => {
  app.post(
    '/api/internal/finance-synthetic/account',
    {
      onRequest: async (request) => {
        requireLoopback(request);
        await prepareAuthenticatedMutation(request, services);
      },
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      if (
        principal.role !== 'owner' ||
        principal.privateSpaceId === undefined
      ) {
        throw unavailable();
      }
      const input = AccountProvisionRequestSchema.safeParse(request.body);
      if (!input.success) throw unavailable();
      const abortController = new AbortController();
      reply.raw.once('close', () => abortController.abort());
      const result = await provisioner.provision({
        principal,
        requestId: request.id,
        idempotencyKey,
        abortSignal: abortController.signal,
      });
      if (result === undefined) throw unavailable();
      return reply
        .header('cache-control', 'no-store, private')
        .send(AccountProvisionResponseSchema.parse(result));
    },
  );
};

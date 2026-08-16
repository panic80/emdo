import type { FastifyInstance } from 'fastify';

import { ApiProblem } from '../problem.js';
import { readHeader } from '../request-context.js';
import type { ApiServices } from '../services/contracts.js';

export const registerMetricsRoutes = (
  app: FastifyInstance,
  services: ApiServices,
): void => {
  app.get('/metrics', async (request, reply) => {
    let authorized = false;
    try {
      authorized = await services.metrics.authorize({
        authorization: readHeader(request, 'authorization', 4_096),
        requestId: request.id,
      });
    } catch {
      throw new ApiProblem({
        status: 503,
        code: 'metrics-auth-unavailable',
        title: 'Metrics unavailable',
        detail: 'Metrics authorization is temporarily unavailable.',
      });
    }
    if (!authorized) {
      throw new ApiProblem({
        status: 401,
        code: 'metrics-auth-required',
        title: 'Metrics authentication required',
        detail: 'A dedicated metrics credential is required.',
      });
    }
    const metrics = await services.metrics.render();
    if (
      typeof metrics !== 'string' ||
      Buffer.byteLength(metrics, 'utf8') > 2_097_152 ||
      metrics.includes('\0')
    ) {
      throw new ApiProblem({
        status: 502,
        code: 'metrics-output-invalid',
        title: 'Metrics unavailable',
        detail: 'The metrics output is invalid.',
      });
    }
    return reply
      .header('cache-control', 'no-store')
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(metrics);
  });
};

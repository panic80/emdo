import type { FastifyInstance } from 'fastify';

import { ApiProblem } from '../problem.js';
import {
  API_READINESS_SCHEMA_VERSION,
  ApiReadinessServiceResultSchema,
  ApiSyntheticHttpSubsetReadinessSuccessSchema,
  SYNTHETIC_HTTP_SUBSET_EXCLUDED_CHECKS,
  SYNTHETIC_HTTP_SUBSET_READINESS_SCHEMA_VERSION,
  SYNTHETIC_HTTP_SUBSET_REQUIRED_CHECKS,
} from '../readiness-contract.js';
import { parseServiceResponse } from '../request-context.js';
import { JwksSchema } from '../schemas.js';
import type { ApiServices } from '../services/contracts.js';

export const registerHealthRoutes = (
  app: FastifyInstance,
  services: ApiServices,
  enableSyntheticHttpSubsetReadiness = false,
): void => {
  app.get('/healthz', async (_request, reply) =>
    reply.header('cache-control', 'no-store').send({ status: 'ok' }),
  );

  app.get('/readyz', async (_request, reply) => {
    const readiness = parseServiceResponse(
      ApiReadinessServiceResultSchema,
      await services.readiness.check(),
    );
    if (!readiness.ready) {
      throw new ApiProblem({
        status: 503,
        code: 'service-not-ready',
        title: 'Service not ready',
        detail: 'One or more required dependencies are unavailable.',
        extensions: {
          readinessSchemaVersion: API_READINESS_SCHEMA_VERSION,
          checks: readiness.checks,
        },
      });
    }
    return reply.status(200).header('cache-control', 'no-store').send({
      schemaVersion: API_READINESS_SCHEMA_VERSION,
      status: 'ready',
      checks: readiness.checks,
    });
  });

  if (enableSyntheticHttpSubsetReadiness) {
    app.get('/synthetic-staging/readyz', async (_request, reply) => {
      const readiness = parseServiceResponse(
        ApiReadinessServiceResultSchema,
        await services.readiness.check(),
      );
      const subsetReady =
        SYNTHETIC_HTTP_SUBSET_REQUIRED_CHECKS.every(
          (name) => readiness.checks[name] === 'ok',
        ) &&
        SYNTHETIC_HTTP_SUBSET_EXCLUDED_CHECKS.every(
          (name) => readiness.checks[name] === 'unavailable',
        );
      if (!subsetReady) {
        throw new ApiProblem({
          status: 503,
          code: 'synthetic-http-subset-not-ready',
          title: 'Synthetic HTTP subset not ready',
          detail:
            'One or more synthetic HTTP subset dependencies are unavailable or excluded capabilities are enabled.',
          extensions: {
            readinessSchemaVersion:
              SYNTHETIC_HTTP_SUBSET_READINESS_SCHEMA_VERSION,
            readinessProfile: 'synthetic-http-subset',
            releaseEligible: false,
            checks: readiness.checks,
          },
        });
      }
      const response = parseServiceResponse(
        ApiSyntheticHttpSubsetReadinessSuccessSchema,
        {
          schemaVersion: SYNTHETIC_HTTP_SUBSET_READINESS_SCHEMA_VERSION,
          profile: 'synthetic-http-subset',
          status: 'ready',
          releaseEligible: false,
          checks: readiness.checks,
        },
      );
      return reply
        .status(200)
        .header('cache-control', 'no-store')
        .send(response);
    });
  }

  app.get('/.well-known/jwks.json', async (_request, reply) => {
    const jwks = parseServiceResponse(
      JwksSchema,
      await services.jwks.getPublicJwks(),
    );
    // A prior verification key can expire at an arbitrary instant. Prevent an
    // intermediary from serving it beyond its configured verifyUntil cutoff.
    return reply.header('cache-control', 'no-store').send(jwks);
  });
};

import { randomUUID } from 'node:crypto';

import Fastify, { LogController, type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';

import { FINANCE_DOCUMENT_LIMITS } from '@emdo/domains/finance';

import { resolveApiLimits, type ApiLimits } from './config.js';
import { createOpenApiDocument } from './openapi.js';
import { installProblemHandler } from './problem.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerExperienceRoutes } from './routes/experience.js';
import { registerFinanceImportRoutes } from './routes/finance-imports.js';
import { registerFinanceDocumentRoutes } from './routes/finance-documents.js';
import { registerGoogleRoutes } from './routes/google.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerHouseholdAdministrationRoutes } from './routes/household-admin.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { registerProposalRoutes } from './routes/proposals.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerSyntheticFinanceAccountProvisionerRoute } from './routes/synthetic-finance-account-provisioner.js';
import { registerSyntheticFinanceInvitationHandoffRoute } from './routes/synthetic-finance-invitation-handoff.js';
import { registerTurnRoutes } from './routes/turns.js';
import { registerVoiceRoutes } from './routes/voice.js';
import { CanonicalAppOriginSchema } from './schemas.js';
import type { SyntheticFinanceAccountProvisioner } from './production/synthetic-finance-account-provisioner.js';
import type { SyntheticFinanceInvitationHandoff } from './production/synthetic-finance-invitation-handoff.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
  RunEvent,
} from './services/contracts.js';
import {
  EdgeProxySecretSchema,
  resolveTrustedClientIp,
} from './trusted-ingress.js';

export type { ApiServices, AuthenticatedPrincipal, RunEvent };

export interface CreateAppOptions {
  readonly services: ApiServices;
  readonly limits?: Partial<ApiLimits>;
  readonly publicOrigin?: string;
  readonly edgeProxySecret?: string;
  readonly allowLoopbackApiIngress?: boolean;
  readonly enableSyntheticHttpSubsetReadiness?: boolean;
  readonly enableFinanceSyntheticStagingReadiness?: boolean;
  readonly syntheticFinanceAccountProvisioner?: SyntheticFinanceAccountProvisioner;
  readonly syntheticFinanceInvitationHandoff?: SyntheticFinanceInvitationHandoff;
}

const requestId = (request: { readonly headers: Record<string, unknown> }) => {
  const candidate = request.headers['x-request-id'];
  return typeof candidate === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      candidate,
    )
    ? candidate.toLowerCase()
    : randomUUID();
};

export const createApp = async (
  options: CreateAppOptions,
): Promise<FastifyInstance> => {
  const limits = resolveApiLimits(options.limits);
  const publicOrigin = CanonicalAppOriginSchema.parse(
    options.publicOrigin ?? 'https://emdo.invalid',
  );
  const edgeProxySecret =
    options.edgeProxySecret === undefined
      ? undefined
      : EdgeProxySecretSchema.parse(options.edgeProxySecret);
  const app = Fastify({
    bodyLimit: limits.maximumAudioBytes,
    genReqId: requestId,
    logController: new LogController({ disableRequestLogging: true }),
    logger: false,
    routerOptions: { maxParamLength: 512 },
    trustProxy: false,
  });

  app.addContentTypeParser(
    /^audio\/(?:mpeg|mp4|ogg|wav|webm|x-wav)(?:\s*;.*)?$/iu,
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    if (request.url.startsWith('/api/')) {
      resolveTrustedClientIp(
        request,
        edgeProxySecret,
        options.allowLoopbackApiIngress,
      );
    }
    done();
  });
  app.addHook('onSend', (request, reply, payload, done) => {
    if (request.url.startsWith('/api/') && !reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
    done(null, payload);
  });

  installProblemHandler(app);
  await app.register(multipart, {
    limits: {
      fieldNameSize: 100,
      fieldSize: 1,
      fields: 0,
      files: 1,
      parts: 1,
      headerPairs: 100,
      fileSize: FINANCE_DOCUMENT_LIMITS.maximumBytesPerFile,
    },
  });
  registerAuthRoutes(
    app,
    options.services,
    limits.maximumJsonBodyBytes,
    publicOrigin,
    edgeProxySecret,
    options.allowLoopbackApiIngress,
  );
  registerExperienceRoutes(app, options.services, limits.maximumJsonBodyBytes);
  registerFinanceImportRoutes(
    app,
    options.services,
    limits.maximumJsonBodyBytes,
  );
  registerFinanceDocumentRoutes(app, options.services);
  registerHealthRoutes(
    app,
    options.services,
    options.enableSyntheticHttpSubsetReadiness,
    options.enableFinanceSyntheticStagingReadiness,
  );
  registerMetricsRoutes(app, options.services);
  registerTurnRoutes(app, options.services, limits);
  registerRunRoutes(app, options.services);
  registerProposalRoutes(app, options.services, limits.maximumJsonBodyBytes);
  registerSyncRoutes(
    app,
    options.services,
    limits.maximumJsonBodyBytes,
    publicOrigin,
  );
  registerVoiceRoutes(app, options.services, limits);
  registerGoogleRoutes(app, options.services, limits.maximumJsonBodyBytes);
  registerHouseholdAdministrationRoutes(
    app,
    options.services,
    limits.maximumJsonBodyBytes,
  );
  if (options.syntheticFinanceAccountProvisioner !== undefined) {
    registerSyntheticFinanceAccountProvisionerRoute(
      app,
      options.services,
      options.syntheticFinanceAccountProvisioner,
    );
  }
  if (options.syntheticFinanceInvitationHandoff !== undefined) {
    registerSyntheticFinanceInvitationHandoffRoute(
      app,
      options.services,
      options.syntheticFinanceInvitationHandoff,
    );
  }
  app.get('/openapi.json', async (_request, reply) =>
    reply
      .header('cache-control', 'public, max-age=300')
      .send(createOpenApiDocument()),
  );

  await app.ready();
  return app;
};

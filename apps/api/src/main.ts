import { z } from 'zod';

import { createApp, type ApiServices } from './app.js';
import { createProductionApiServices } from './production/create-services.js';
import type { SyntheticFinanceInvitationHandoff } from './production/synthetic-finance-invitation-handoff.js';
import { CanonicalAppOriginSchema } from './schemas.js';
import { EdgeProxySecretSchema } from './trusted-ingress.js';

const ApiServerConfigSchema = z
  .strictObject({
    deploymentEnvironment: z.enum(['production', 'staging']),
    host: z.union([z.literal('127.0.0.1'), z.literal('0.0.0.0')]),
    port: z.number().int().min(1).max(65_535),
    allowLoopbackApiIngress: z.boolean(),
    enableSyntheticHttpSubsetReadiness: z.boolean(),
    enableFinanceSyntheticStagingReadiness: z.boolean(),
    edgeProxySecret: EdgeProxySecretSchema,
    publicOrigin: CanonicalAppOriginSchema,
  })
  .superRefine((value, context) => {
    if (
      value.allowLoopbackApiIngress &&
      value.deploymentEnvironment !== 'staging'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['allowLoopbackApiIngress'],
        message: 'loopback API ingress is staging-only',
      });
    }
    if (
      value.enableSyntheticHttpSubsetReadiness &&
      (value.deploymentEnvironment !== 'staging' ||
        !value.allowLoopbackApiIngress)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['enableSyntheticHttpSubsetReadiness'],
        message:
          'synthetic HTTP subset readiness requires staging loopback ingress',
      });
    }
    if (
      value.enableFinanceSyntheticStagingReadiness &&
      (value.deploymentEnvironment !== 'staging' ||
        !value.allowLoopbackApiIngress)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['enableFinanceSyntheticStagingReadiness'],
        message:
          'Finance synthetic staging readiness requires staging loopback ingress',
      });
    }
    if (
      value.enableSyntheticHttpSubsetReadiness &&
      value.enableFinanceSyntheticStagingReadiness
    ) {
      context.addIssue({
        code: 'custom',
        path: ['enableSyntheticHttpSubsetReadiness'],
        message: 'synthetic readiness profiles are mutually exclusive',
      });
    }
  });

export type ApiServerConfig = z.infer<typeof ApiServerConfigSchema>;

export const loadApiServerConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): ApiServerConfig => {
  const allowLoopbackApiIngress = z
    .enum(['true', 'false'])
    .default('false')
    .parse(environment.EMDO_ALLOW_LOOPBACK_API_INGRESS);
  const syntheticDataOnly = z
    .enum(['true', 'false'])
    .default('false')
    .parse(environment.EMDO_SYNTHETIC_DATA_ONLY);
  const financeSyntheticStagingRequested = z
    .enum(['true', 'false'])
    .default('false')
    .parse(environment.EMDO_FINANCE_SYNTHETIC_STAGING);
  const financeDocumentsEnabled = z
    .enum(['true', 'false'])
    .default('false')
    .parse(environment.EMDO_FINANCE_DOCUMENTS_ENABLED);
  const deploymentEnvironment = environment.EMDO_ENVIRONMENT ?? 'production';
  const loopbackEnabled = allowLoopbackApiIngress === 'true';
  const financeSyntheticStaging =
    financeSyntheticStagingRequested === 'true' &&
    deploymentEnvironment === 'staging' &&
    loopbackEnabled &&
    syntheticDataOnly === 'true' &&
    financeDocumentsEnabled === 'true';
  if (financeSyntheticStagingRequested === 'true' && !financeSyntheticStaging) {
    throw new Error('api-finance-synthetic-staging-configuration-invalid');
  }
  return Object.freeze(
    ApiServerConfigSchema.parse({
      deploymentEnvironment,
      host: environment.EMDO_API_HOST ?? environment.HOST ?? '127.0.0.1',
      port: Number(environment.EMDO_API_PORT ?? environment.PORT ?? '3000'),
      allowLoopbackApiIngress: loopbackEnabled,
      enableSyntheticHttpSubsetReadiness:
        deploymentEnvironment === 'staging' &&
        loopbackEnabled &&
        syntheticDataOnly === 'true' &&
        !financeSyntheticStaging,
      enableFinanceSyntheticStagingReadiness: financeSyntheticStaging,
      edgeProxySecret: environment.EMDO_EDGE_PROXY_SECRET,
      publicOrigin: environment.EMDO_PUBLIC_ORIGIN,
    }),
  );
};

const REQUIRED_SERVICE_METHODS = Object.freeze({
  auth: [
    'authenticate',
    'verifyMutation',
    'handleBrowserRequest',
    'issueMutationCsrf',
    'issueInvitationCsrf',
    'redeemInvitation',
  ],
  activityRead: ['list'],
  financeRead: ['list'],
  financeImports: ['listDestinations', 'preview', 'commit'],
  financeDocuments: [
    'list',
    'get',
    'upload',
    'downloadOriginal',
    'retry',
    'getReview',
    'updateReview',
    'commitReview',
    'listMatches',
    'decideMatch',
    'getEvidence',
    'delete',
    'readExperience',
  ],
  managerTurns: ['start'],
  notificationPreferences: ['get', 'update'],
  runEvents: ['open'],
  proposalQueries: ['list', 'getDetail'],
  visualProofs: ['issue'],
  proposals: ['decideWithVisualProof'],
  sync: ['registerClient', 'issueToken', 'applyOperations'],
  audioRequests: [
    'claim',
    'completeTranscription',
    'completeSpeech',
    'releaseKnownNoDispatch',
    'markIndeterminate',
    'checkReady',
  ],
  voice: ['inspectRecording', 'getSpeechConfiguration', 'transcribe', 'speak'],
  google: ['beginAuthorization', 'completeAuthorization', 'disconnect'],
  householdAdministration: [
    'issueInvitation',
    'listInvitations',
    'revokeInvitation',
    'listMemberships',
    'changeMembershipRole',
    'deactivateMembership',
  ],
  scheduleRead: ['list'],
  settingsRead: ['read'],
  shoppingRead: ['list'],
  todayRead: ['read'],
  jwks: ['getPublicJwks'],
  readiness: ['check'],
  metrics: ['authorize', 'render'],
} as const);

export const assertCompleteApiServices: (
  candidate: unknown,
) => asserts candidate is ApiServices = (candidate) => {
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('api-composition-missing');
  }
  for (const [serviceName, methods] of Object.entries(
    REQUIRED_SERVICE_METHODS,
  )) {
    const service = (candidate as Record<string, unknown>)[serviceName];
    if (service === null || typeof service !== 'object') {
      throw new Error(`api-service-missing:${serviceName}`);
    }
    for (const method of methods) {
      if (typeof (service as Record<string, unknown>)[method] !== 'function') {
        throw new Error(`api-service-method-missing:${serviceName}.${method}`);
      }
    }
  }
};

/**
 * Loads only the bundled production graph. Neither callers nor deployment
 * environment values can select executable code.
 */
export const loadProductionApiServices = async (
  environment: Readonly<Record<string, string | undefined>>,
): Promise<ApiServices> => {
  const services = await createProductionApiServices(
    Object.freeze({ ...environment }),
  );
  assertCompleteApiServices(services);
  return services;
};

/** Internal listener. Only the environment-owned graph may reach this seam. */
const startApiServer = async (input: {
  readonly services: unknown;
  readonly config?: ApiServerConfig;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}) => {
  const services = input.services;
  assertCompleteApiServices(services);
  const config = ApiServerConfigSchema.parse(
    input.config ?? loadApiServerConfig(input.environment ?? process.env),
  );
  const syntheticFinanceInvitationHandoff =
    input.services !== null && typeof input.services === 'object'
      ? (
          input.services as {
            readonly syntheticFinanceInvitationHandoff?: SyntheticFinanceInvitationHandoff;
          }
        ).syntheticFinanceInvitationHandoff
      : undefined;
  const app = await createApp({
    services,
    publicOrigin: config.publicOrigin,
    edgeProxySecret: config.edgeProxySecret,
    allowLoopbackApiIngress: config.allowLoopbackApiIngress,
    enableSyntheticHttpSubsetReadiness:
      config.enableSyntheticHttpSubsetReadiness,
    enableFinanceSyntheticStagingReadiness:
      config.enableFinanceSyntheticStagingReadiness,
    ...(syntheticFinanceInvitationHandoff === undefined
      ? {}
      : {
          syntheticFinanceInvitationHandoff: syntheticFinanceInvitationHandoff,
        }),
  });
  const close = (services as ApiServices & { readonly close?: unknown }).close;
  if (typeof close === 'function') {
    app.addHook('onClose', async () => {
      await (close as () => Promise<void>)();
    });
  }
  await app.listen({ host: config.host, port: config.port });
  return app;
};

export const startApiFromEnvironment = async (
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const config = loadApiServerConfig(environment);
  const services = await loadProductionApiServices(environment);
  return startApiServer({ services, config });
};

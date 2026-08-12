import { z } from 'zod';

import type { AuthenticationBoundary } from '../services/contracts.js';
import { createProductionDurableServiceBindings } from './durable-services.js';
import {
  createFailClosedApiServices,
  type ProductionApiServiceBindings,
} from './unavailable-services.js';

const CURRENT_DURABLE_SERVICE_NAMES = Object.freeze([
  'activityRead',
  'audioRequests',
  'financeRead',
  'householdAdministration',
  'notificationPreferences',
  'proposalQueries',
  'scheduleRead',
  'settingsRead',
  'shoppingRead',
  'sync',
  'todayRead',
  'jwks',
] as const satisfies readonly (keyof ProductionApiServiceBindings)[]);

type CurrentDurableServiceName = (typeof CURRENT_DURABLE_SERVICE_NAMES)[number];

const selectCurrentDurableBindings = (
  bindings: ProductionApiServiceBindings,
): Pick<ProductionApiServiceBindings, CurrentDurableServiceName> =>
  Object.freeze(
    Object.fromEntries(
      CURRENT_DURABLE_SERVICE_NAMES.flatMap((name) => {
        const binding = bindings[name];
        return binding === undefined ? [] : [[name, binding] as const];
      }),
    ),
  ) as Pick<ProductionApiServiceBindings, CurrentDurableServiceName>;

const OptionalMetricsTokenSchema = z
  .string()
  .min(32)
  .max(512)
  .regex(/^[A-Za-z0-9._~-]+$/u)
  .optional();

const unavailableAuthenticationBoundary: AuthenticationBoundary = Object.freeze(
  {
    authenticate: async () => undefined,
    verifyMutation: async () => false,
    handleBrowserRequest: async () =>
      new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'Authentication unavailable',
          status: 503,
          detail: 'Authentication authority is not configured.',
          code: 'authentication-unavailable',
        }),
        {
          status: 503,
          headers: {
            'cache-control': 'no-store',
            'content-type': 'application/problem+json',
          },
        },
      ),
    issueMutationCsrf: async () => {
      throw new Error('api-production-authority-binding-unavailable');
    },
    issueInvitationCsrf: async () => {
      throw new Error('api-production-authority-binding-unavailable');
    },
    redeemInvitation: async () => {
      throw Object.assign(
        new Error('Invitation onboarding is temporarily unavailable'),
        { code: 'onboarding-unavailable' },
      );
    },
  },
);

/** Bundled assembly with no caller-selected executable dependency seam. */
export const assembleProductionApiServices = async (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const frozenEnvironment = Object.freeze({ ...environment });
  const durableComposition =
    await createProductionDurableServiceBindings(frozenEnvironment);
  return createFailClosedApiServices({
    auth: unavailableAuthenticationBoundary,
    bindings: selectCurrentDurableBindings(durableComposition.bindings),
    metricsToken: OptionalMetricsTokenSchema.parse(
      frozenEnvironment.EMDO_METRICS_TOKEN,
    ),
    ...(durableComposition.close === undefined
      ? {}
      : { close: durableComposition.close }),
  });
};

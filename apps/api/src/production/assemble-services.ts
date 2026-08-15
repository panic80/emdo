import { z } from 'zod';

import type { AuthenticationBoundary } from '../services/contracts.js';
import { createProductionAuthenticationServiceBinding } from './auth-services.js';
import { createProductionDurableServiceBindings } from './durable-services.js';
import {
  createFailClosedApiServices,
  type ProductionApiServiceBindings,
} from './unavailable-services.js';

const CURRENT_DURABLE_SERVICE_NAMES = Object.freeze([
  'activityRead',
  'audioRequests',
  'financeRead',
  'financeImports',
  'google',
  'householdAdministration',
  'notificationPreferences',
  'proposalQueries',
  'proposals',
  'runEvents',
  'scheduleRead',
  'settingsRead',
  'shoppingRead',
  'sync',
  'todayRead',
  'visualProofs',
  'jwks',
] as const satisfies readonly (keyof ProductionApiServiceBindings)[]);

type CurrentDurableServiceName = (typeof CURRENT_DURABLE_SERVICE_NAMES)[number];

const selectCurrentDurableBindings = (
  bindings: ProductionApiServiceBindings,
  hasTrustedAuthentication: boolean,
): Pick<ProductionApiServiceBindings, CurrentDurableServiceName> =>
  Object.freeze(
    Object.fromEntries(
      CURRENT_DURABLE_SERVICE_NAMES.flatMap((name) => {
        if (
          !hasTrustedAuthentication &&
          (name === 'proposalQueries' ||
            name === 'proposals' ||
            name === 'runEvents' ||
            name === 'visualProofs' ||
            name === 'google')
        ) {
          return [];
        }
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

const combineCloses = (
  closes: readonly (undefined | (() => Promise<void>))[],
): (() => Promise<void>) | undefined => {
  const selected = closes.filter(
    (close): close is () => Promise<void> => close !== undefined,
  );
  if (selected.length === 0) return undefined;
  let closePromise: Promise<void> | undefined;
  return (): Promise<void> => {
    closePromise ??= (async () => {
      const outcomes = await Promise.allSettled(
        selected.map((close) => Promise.resolve().then(close)),
      );
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === 'rejected' ? [outcome.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          'Production API resources could not all close',
        );
      }
    })();
    return closePromise;
  };
};

/** Bundled assembly with no caller-selected executable dependency seam. */
export const assembleProductionApiServices = async (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const frozenEnvironment = Object.freeze({ ...environment });
  const metricsToken = OptionalMetricsTokenSchema.parse(
    frozenEnvironment.EMDO_METRICS_TOKEN,
  );
  let durableComposition:
    | Awaited<ReturnType<typeof createProductionDurableServiceBindings>>
    | undefined;
  let authenticationComposition:
    | Awaited<ReturnType<typeof createProductionAuthenticationServiceBinding>>
    | undefined;
  try {
    durableComposition =
      await createProductionDurableServiceBindings(frozenEnvironment);
    authenticationComposition =
      await createProductionAuthenticationServiceBinding(frozenEnvironment);
    const bindings = Object.freeze({
      ...selectCurrentDurableBindings(
        durableComposition.bindings,
        authenticationComposition.binding !== undefined,
      ),
      ...(authenticationComposition.binding === undefined
        ? {}
        : { auth: authenticationComposition.binding }),
    });
    const close = combineCloses([
      authenticationComposition.close,
      durableComposition.close,
    ]);
    return createFailClosedApiServices({
      auth: unavailableAuthenticationBoundary,
      bindings,
      metricsToken,
      ...(close === undefined ? {} : { close }),
    });
  } catch (error) {
    const close = combineCloses([
      authenticationComposition?.close,
      durableComposition?.close,
    ]);
    await close?.().catch(() => undefined);
    throw error;
  }
};

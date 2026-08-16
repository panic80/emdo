import { ApiProblem } from '../problem.js';
import {
  API_READINESS_GROUPS,
  type ApiReadinessComponentName,
  type ApiReadinessGroupName,
  type ApiReadinessStatus,
} from '../readiness-contract.js';
import type {
  ApiServices,
  AuthenticationBoundary,
  ReadinessGateway,
} from '../services/contracts.js';

type ConfigurableApiServiceName = Exclude<
  keyof ApiServices,
  'metrics' | 'readiness'
>;

export interface ProductionApiServiceBinding<Service> {
  /** A concrete production adapter; in-memory implementations are not valid here. */
  readonly service: Service;
  /** A bounded dependency probe. Only the literal value true reports healthy. */
  readonly check: () => Promise<boolean>;
}

export type ProductionApiServiceBindings = {
  -readonly [Name in ConfigurableApiServiceName]?: ProductionApiServiceBinding<
    ApiServices[Name]
  >;
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
} satisfies Readonly<Record<ConfigurableApiServiceName, readonly string[]>>);

const COMPONENT_BINDINGS = Object.freeze({
  'authority.authentication': 'auth',
  'authority.household-administration': 'householdAdministration',
  'authority.proposal-queries': 'proposalQueries',
  'authority.visual-decisions': 'proposals',
  'authority.visual-proof-issuance': 'visualProofs',
  'agents.manager-turns': 'managerTurns',
  'agents.run-events': 'runEvents',
  'experience.activity-read': 'activityRead',
  'experience.finance-read': 'financeRead',
  'experience.finance-imports': 'financeImports',
  'experience.notification-preferences': 'notificationPreferences',
  'experience.schedule-read': 'scheduleRead',
  'experience.settings-read': 'settingsRead',
  'experience.shopping-read': 'shoppingRead',
  'experience.today-read': 'todayRead',
  'google.connector': 'google',
  'sync.gateway': 'sync',
  'sync.jwks': 'jwks',
  'voice.audio-requests': 'audioRequests',
  'voice.provider': 'voice',
} satisfies Readonly<
  Record<ApiReadinessComponentName, ConfigurableApiServiceName | null>
>);

const READINESS_PROBE_TIMEOUT_MS = 2_000;

const runBoundedReadinessProbe = (
  check: () => Promise<boolean>,
): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => settle(false), READINESS_PROBE_TIMEOUT_MS);
    void Promise.resolve()
      .then(check)
      .then(
        (result) => settle(result === true),
        () => settle(false),
      );
  });

const isCompleteBinding = (
  name: ConfigurableApiServiceName,
  binding: ProductionApiServiceBinding<unknown> | undefined,
): boolean => {
  if (
    binding === undefined ||
    binding.service === null ||
    typeof binding.service !== 'object' ||
    typeof binding.check !== 'function'
  ) {
    return false;
  }
  const service = binding.service as unknown as Record<string, unknown>;
  return REQUIRED_SERVICE_METHODS[name].every(
    (method) => typeof service[method] === 'function',
  );
};

const unavailable = (code: string, title: string): ApiProblem =>
  new ApiProblem({
    status: 503,
    code,
    title,
    detail: `${title} is not configured for this deployment.`,
  });

/**
 * Safe deployment graph used only when optional/unfinished capability
 * adapters are absent. It keeps liveness and browser authentication
 * reachable, reports readiness false, and never substitutes an in-memory
 * authority, receipt store, approval store, provider, or agent runner.
 */
export const createFailClosedApiServices = (input: {
  readonly auth: AuthenticationBoundary;
  readonly bindings?: ProductionApiServiceBindings;
  readonly metricsToken?: string;
  readonly close?: () => Promise<void>;
}): ApiServices & { readonly close?: () => Promise<void> } => {
  if (input.auth === undefined) {
    throw new Error('api-production-auth-boundary-missing');
  }
  const fallbackServices: Omit<ApiServices, 'auth' | 'metrics' | 'readiness'> =
    {
      activityRead: {
        list: async () => {
          throw unavailable('activity-read-unavailable', 'Activity view');
        },
      },
      financeRead: {
        list: async () => {
          throw unavailable('finance-read-unavailable', 'Finance view');
        },
      },
      financeImports: {
        listDestinations: async () => {
          throw unavailable('finance-import-unavailable', 'Finance import');
        },
        preview: async () => {
          throw unavailable('finance-import-unavailable', 'Finance import');
        },
        commit: async () => {
          throw unavailable('finance-import-unavailable', 'Finance import');
        },
      },
      managerTurns: {
        start: async () => {
          throw unavailable('agent-runtime-unavailable', 'Agent runtime');
        },
      },
      runEvents: {
        open: async () => {
          throw unavailable('agent-runtime-unavailable', 'Agent runtime');
        },
      },
      notificationPreferences: {
        get: async () => {
          throw unavailable(
            'notification-preferences-unavailable',
            'Notification preferences',
          );
        },
        update: async () => {
          throw unavailable(
            'notification-preferences-unavailable',
            'Notification preferences',
          );
        },
      },
      proposalQueries: {
        list: async () => {
          throw unavailable('approval-runtime-unavailable', 'Approval runtime');
        },
        getDetail: async () => {
          throw unavailable('approval-runtime-unavailable', 'Approval runtime');
        },
      },
      visualProofs: {
        issue: async () => {
          throw unavailable('approval-runtime-unavailable', 'Approval runtime');
        },
      },
      proposals: {
        decideWithVisualProof: async () => {
          throw unavailable('approval-runtime-unavailable', 'Approval runtime');
        },
      },
      sync: {
        registerClient: async () => {
          throw unavailable('sync-unavailable', 'Synchronization');
        },
        issueToken: async () => {
          throw unavailable('sync-unavailable', 'Synchronization');
        },
        applyOperations: async () => {
          throw unavailable('sync-unavailable', 'Synchronization');
        },
      },
      audioRequests: {
        claim: async () => {
          throw unavailable('audio-provider-unavailable', 'Voice service');
        },
        completeTranscription: async () => {
          throw unavailable('audio-provider-unavailable', 'Voice service');
        },
        completeSpeech: async () => {
          throw unavailable('audio-provider-unavailable', 'Voice service');
        },
        releaseKnownNoDispatch: async () => {
          throw unavailable('audio-provider-unavailable', 'Voice service');
        },
        markIndeterminate: async () => {
          throw unavailable('audio-provider-unavailable', 'Voice service');
        },
        checkReady: async () => false,
      },
      voice: {
        inspectRecording: async () => ({
          status: 'rejected' as const,
          code: 'audio-inspector-unavailable' as const,
        }),
        getSpeechConfiguration: async () => ({
          model: 'tts-1' as const,
          configurationVersion: 'voice-disabled-v1',
        }),
        transcribe: async () => ({
          status: 'failed' as const,
          safeError: {
            code: 'audio-provider-unavailable' as const,
            message: 'Voice transcription is not configured.',
            retryable: false,
          },
          reconciliationRequired: false,
        }),
        speak: async () => ({
          status: 'failed' as const,
          safeError: {
            code: 'audio-provider-unavailable' as const,
            message: 'Speech generation is not configured.',
            retryable: false,
          },
          reconciliationRequired: false,
        }),
      },
      google: {
        beginAuthorization: async () => {
          throw unavailable(
            'connector-unavailable',
            'Google Calendar connector',
          );
        },
        completeAuthorization: async () => {
          throw unavailable(
            'connector-unavailable',
            'Google Calendar connector',
          );
        },
        disconnect: async () => {
          throw unavailable(
            'connector-unavailable',
            'Google Calendar connector',
          );
        },
      },
      householdAdministration: {
        issueInvitation: async () => {
          throw unavailable(
            'household-administration-unavailable',
            'Household administration',
          );
        },
        listInvitations: async () => {
          throw unavailable(
            'household-administration-unavailable',
            'Household administration',
          );
        },
        revokeInvitation: async () => {
          throw unavailable(
            'household-administration-unavailable',
            'Household administration',
          );
        },
        listMemberships: async () => {
          throw unavailable(
            'household-administration-unavailable',
            'Household administration',
          );
        },
        changeMembershipRole: async () => {
          throw unavailable(
            'household-administration-unavailable',
            'Household administration',
          );
        },
        deactivateMembership: async () => {
          throw unavailable(
            'household-administration-unavailable',
            'Household administration',
          );
        },
      },
      scheduleRead: {
        list: async () => {
          throw unavailable('schedule-read-unavailable', 'Schedule view');
        },
      },
      settingsRead: {
        read: async () => {
          throw unavailable('settings-read-unavailable', 'Settings view');
        },
      },
      shoppingRead: {
        list: async () => {
          throw unavailable('shopping-read-unavailable', 'Shopping view');
        },
      },
      todayRead: {
        read: async () => {
          throw unavailable('today-read-unavailable', 'Today view');
        },
      },
      jwks: {
        getPublicJwks: async () => {
          throw unavailable('sync-unavailable', 'Synchronization');
        },
      },
    };

  const completeBindings = new Map<
    ConfigurableApiServiceName,
    ProductionApiServiceBinding<ApiServices[ConfigurableApiServiceName]>
  >();
  for (const name of Object.keys(
    REQUIRED_SERVICE_METHODS,
  ) as ConfigurableApiServiceName[]) {
    const binding = input.bindings?.[name] as
      ProductionApiServiceBinding<unknown> | undefined;
    if (isCompleteBinding(name, binding)) {
      completeBindings.set(
        name,
        binding as ProductionApiServiceBinding<
          ApiServices[ConfigurableApiServiceName]
        >,
      );
    }
  }

  const selectedService = <Name extends ConfigurableApiServiceName>(
    name: Name,
    fallback: ApiServices[Name],
  ): ApiServices[Name] => {
    const binding = completeBindings.get(name);
    if (binding === undefined) return fallback;
    const service = binding.service as ApiServices[Name] &
      Record<string, (...arguments_: readonly unknown[]) => unknown>;
    const denied = fallback as ApiServices[Name] &
      Record<string, (...arguments_: readonly unknown[]) => unknown>;
    return Object.freeze(
      Object.fromEntries(
        REQUIRED_SERVICE_METHODS[name].map((method) => [
          method,
          async (...arguments_: readonly unknown[]) => {
            const target = (await runBoundedReadinessProbe(binding.check))
              ? service
              : denied;
            return Reflect.apply(target[method]!, target, arguments_);
          },
        ]),
      ),
    ) as unknown as ApiServices[Name];
  };

  const readiness: ReadinessGateway = Object.freeze({
    check: async () => {
      const componentEntries = await Promise.all(
        Object.entries(COMPONENT_BINDINGS).map(
          async ([checkName, serviceName]) => {
            const binding =
              serviceName === null
                ? undefined
                : completeBindings.get(serviceName);
            let status: ApiReadinessStatus = 'unavailable';
            if (binding !== undefined) {
              status = (await runBoundedReadinessProbe(binding.check))
                ? 'ok'
                : 'unavailable';
            }
            return [checkName, status] as const;
          },
        ),
      );
      const components = Object.fromEntries(componentEntries) as Record<
        ApiReadinessComponentName,
        ApiReadinessStatus
      >;
      const groupStatus = (
        names: readonly ApiReadinessComponentName[],
      ): ApiReadinessStatus =>
        names.every((name) => components[name] === 'ok') ? 'ok' : 'unavailable';
      const groups = Object.fromEntries(
        Object.entries(API_READINESS_GROUPS).map(([name, components]) => [
          name,
          groupStatus(components),
        ]),
      ) as Record<ApiReadinessGroupName, ApiReadinessStatus>;
      const checks = Object.freeze({
        ...groups,
        ...components,
      });
      return Object.freeze({
        ready: Object.values(groups).every((status) => status === 'ok'),
        checks,
      });
    },
  });

  const services: ApiServices & { readonly close?: () => Promise<void> } = {
    auth: selectedService('auth', input.auth),
    activityRead: selectedService(
      'activityRead',
      fallbackServices.activityRead,
    ),
    financeRead: selectedService('financeRead', fallbackServices.financeRead),
    financeImports: selectedService(
      'financeImports',
      fallbackServices.financeImports,
    ),
    managerTurns: selectedService(
      'managerTurns',
      fallbackServices.managerTurns,
    ),
    notificationPreferences: selectedService(
      'notificationPreferences',
      fallbackServices.notificationPreferences,
    ),
    runEvents: selectedService('runEvents', fallbackServices.runEvents),
    proposalQueries: selectedService(
      'proposalQueries',
      fallbackServices.proposalQueries,
    ),
    visualProofs: selectedService(
      'visualProofs',
      fallbackServices.visualProofs,
    ),
    proposals: selectedService('proposals', fallbackServices.proposals),
    sync: selectedService('sync', fallbackServices.sync),
    audioRequests: selectedService(
      'audioRequests',
      fallbackServices.audioRequests,
    ),
    voice: selectedService('voice', fallbackServices.voice),
    google: selectedService('google', fallbackServices.google),
    householdAdministration: selectedService(
      'householdAdministration',
      fallbackServices.householdAdministration,
    ),
    scheduleRead: selectedService(
      'scheduleRead',
      fallbackServices.scheduleRead,
    ),
    settingsRead: selectedService(
      'settingsRead',
      fallbackServices.settingsRead,
    ),
    shoppingRead: selectedService(
      'shoppingRead',
      fallbackServices.shoppingRead,
    ),
    todayRead: selectedService('todayRead', fallbackServices.todayRead),
    jwks: selectedService('jwks', fallbackServices.jwks),
    readiness,
    metrics: {
      authorize: async ({ authorization }) =>
        input.metricsToken !== undefined &&
        authorization === `Bearer ${input.metricsToken}`,
      render: async () => {
        const current = await readiness.check();
        return `# HELP emdo_api_ready Whether the complete API graph is ready.\n# TYPE emdo_api_ready gauge\nemdo_api_ready ${current.ready ? 1 : 0}\n`;
      },
    },
    ...(input.close === undefined ? {} : { close: input.close }),
  };
  return Object.freeze(services);
};

import { describe, expect, it } from 'vitest';

import type { EmdoWorkerDatabaseClient } from '@emdo/db/worker';

import {
  createDirectProductionWorkerComposition,
  createProductionWorkerComposition,
  loadProductionWorkerConfig,
} from './production.js';
import type { WorkerProviderRuntime } from './providers.js';

const environment = {
  EMDO_WORKER_DATABASE_URL:
    'postgresql://emdo_worker_login:queue-secret@postgres/emdo_app',
  EMDO_WORKER_EXECUTOR_DATABASE_URL:
    'postgresql://emdo_worker_executor_login:executor-secret@postgres/emdo_app',
  EMDO_WORKER_DISPATCHER_DATABASE_URL:
    'postgresql://emdo_worker_dispatcher_login:dispatcher-secret@postgres/emdo_app',
  EMDO_APPLICATION_ORIGIN: 'https://emdo.example',
  EMDO_WORKER_DISPATCHER_ID: 'emdo-worker-1',
  HEALTH_HOST: '127.0.0.1',
  HEALTH_PORT: '3001',
};

const providers = (events: string[]): WorkerProviderRuntime => ({
  status: {
    overall: 'available',
    email: 'available',
    push: 'available',
    calendar: 'available',
    blockers: [],
  },
  email: {
    async send() {
      return { status: 'duplicate' };
    },
  },
  push: {
    async send() {
      return { status: 'duplicate' };
    },
  },
  calendar: {
    async synchronize() {
      return {
        status: 'current',
        sealedCursor: null,
        providerVersion: 'fixture',
        evidenceHash: 'a'.repeat(64),
      };
    },
    async readBackAttempt() {
      return {
        state: 'not-applied',
        application: 'not-applied',
        reason: 'provider-rejected-before-apply',
        evidenceHash: 'c'.repeat(64),
      };
    },
  },
  invitationSecrets: {
    async withOpenedSecret(_input, useSecret) {
      const secret = new TextEncoder().encode('A'.repeat(43));
      try {
        return await useSecret(secret);
      } finally {
        secret.fill(0);
      }
    },
  },
  async checkEmailReadiness() {
    events.push('providers:check:email');
    return { status: 'available' };
  },
  async checkPushReadiness() {
    events.push('providers:check:push');
    return { status: 'available' };
  },
  async checkCalendarReadiness() {
    events.push('providers:check:calendar');
    return { status: 'available' };
  },
  async close() {
    events.push('providers:close');
  },
});

describe('production worker composition', () => {
  it('keeps the direct artifact provider-neutral and fails closed without external loader injection', async () => {
    let databaseCreations = 0;
    await expect(
      createDirectProductionWorkerComposition({
        environment: {
          ...environment,
          EMDO_EXTERNAL_PROVIDERS_ENABLED: 'true',
        },
        createDatabase() {
          databaseCreations += 1;
          throw new Error('must not be reached');
        },
      }),
    ).rejects.toMatchObject({
      message: 'Production worker providers are unavailable',
      blockers: [
        'worker-email-adapter-unavailable',
        'worker-push-adapter-unavailable',
        'worker-calendar-broker-unavailable',
      ],
    });
    expect(databaseCreations).toBe(0);
  });

  it('validates the dedicated runtime configuration and deterministic defaults', () => {
    expect(loadProductionWorkerConfig(environment)).toEqual({
      applicationOrigin: 'https://emdo.example',
      queueDatabaseUrl: environment.EMDO_WORKER_DATABASE_URL,
      executorDatabaseUrl: environment.EMDO_WORKER_EXECUTOR_DATABASE_URL,
      dispatcherDatabaseUrl: environment.EMDO_WORKER_DISPATCHER_DATABASE_URL,
      outbox: {
        dispatcherId: 'emdo-worker-1',
        pollIntervalMs: 1_000,
        batchLimit: 25,
        leaseMs: 30_000,
      },
      providers: {
        enabled: false,
        readinessTimeoutMs: 3_000,
      },
    });
    expect(() =>
      loadProductionWorkerConfig({
        ...environment,
        EMDO_APPLICATION_ORIGIN: 'http://emdo.example',
      }),
    ).toThrow('Production worker configuration is invalid');
    expect(() =>
      loadProductionWorkerConfig({
        ...environment,
        EMDO_WORKER_DISPATCHER_DATABASE_URL:
          environment.EMDO_WORKER_EXECUTOR_DATABASE_URL,
      }),
    ).toThrow('Production worker configuration is invalid');
    expect(() =>
      loadProductionWorkerConfig({
        ...environment,
        EMDO_WORKER_EXECUTOR_DATABASE_URL:
          'postgresql://emdo_worker_dispatcher_login:other@postgres/emdo_app',
      }),
    ).toThrow('Production worker configuration is invalid');
  });

  it('wires durable PostgreSQL repositories and closes every resource once', async () => {
    const events: string[] = [];
    const database = (name: 'executor' | 'dispatcher') =>
      ({
        pool: {},
        scopedPool: {
          async connect() {
            events.push(`${name}:probe:connect`);
            return {
              async query() {
                events.push(`${name}:probe:query`);
                return { rowCount: 1, rows: [{ ready: true }] };
              },
              release() {
                events.push(`${name}:probe:release`);
              },
            };
          },
        },
        async checkReady() {
          events.push(`${name}:probe:connect`);
          events.push(`${name}:probe:query`);
          events.push(`${name}:probe:release`);
        },
        async close() {
          events.push(`${name}:close`);
        },
      }) as unknown as EmdoWorkerDatabaseClient;

    const composition = await createProductionWorkerComposition({
      environment: {
        ...environment,
        EMDO_EXTERNAL_PROVIDERS_ENABLED: 'true',
      },
      createDatabase(input) {
        const name =
          input.applicationName === 'emdo-worker-executor'
            ? 'executor'
            : 'dispatcher';
        events.push(
          `${name}:create:${input.max}:${new URL(input.connectionString).username}:${input.fixedRole}`,
        );
        return database(name);
      },
      async loadProviders() {
        events.push('providers:load');
        return providers(events);
      },
    });

    expect(events).toEqual([
      'providers:load',
      'providers:check:email',
      'providers:check:push',
      'providers:check:calendar',
      'executor:create:7:emdo_worker_executor_login:emdo_worker_executor',
      'executor:probe:connect',
      'executor:probe:query',
      'executor:probe:release',
      'dispatcher:create:3:emdo_worker_dispatcher_login:emdo_worker_dispatch_executor',
      'dispatcher:probe:connect',
      'dispatcher:probe:query',
      'dispatcher:probe:release',
    ]);
    expect(Object.keys(composition.jobDependencies)).toEqual([
      'executions',
      'reminders',
      'calendar',
      'notifications',
      'invitations',
    ]);
    expect(composition.providerStatus.overall).toBe('available');
    expect(composition.jobDependencies).not.toHaveProperty('agentRunner');
    await composition.close();
    await composition.close();
    expect(events).toEqual([
      'providers:load',
      'providers:check:email',
      'providers:check:push',
      'providers:check:calendar',
      'executor:create:7:emdo_worker_executor_login:emdo_worker_executor',
      'executor:probe:connect',
      'executor:probe:query',
      'executor:probe:release',
      'dispatcher:create:3:emdo_worker_dispatcher_login:emdo_worker_dispatch_executor',
      'dispatcher:probe:connect',
      'dispatcher:probe:query',
      'dispatcher:probe:release',
      'providers:close',
      'executor:close',
      'dispatcher:close',
    ]);
  });

  it('never exposes raw database or invitation secrets to a provider loader', async () => {
    const events: string[] = [];
    let providerConfiguration: unknown;
    const database = () =>
      ({
        scopedPool: {
          async connect() {
            return {
              async query() {
                return { rowCount: 1, rows: [{ ready: true }] };
              },
              release() {},
            };
          },
        },
        async checkReady() {},
        async close() {},
      }) as unknown as EmdoWorkerDatabaseClient;

    const composition = await createProductionWorkerComposition({
      environment: {
        ...environment,
        EMDO_EXTERNAL_PROVIDERS_ENABLED: 'true',
        EMDO_WORKER_INVITATION_PRIVATE_KEYRING_B64URL: 'private-key-sentinel',
        UNRELATED_SECRET: 'unrelated-secret-sentinel',
      },
      createDatabase: database,
      async loadProviders(configuration) {
        providerConfiguration = configuration;
        return providers(events);
      },
    });

    expect(providerConfiguration).toEqual({
      schemaVersion: 1,
      applicationOrigin: 'https://emdo.example',
    });
    expect(JSON.stringify(providerConfiguration)).not.toMatch(
      /queue-secret|executor-secret|dispatcher-secret|private-key-sentinel|unrelated-secret-sentinel/u,
    );
    await composition.close();
  });

  it('uses bundled degraded adapters when optional providers are unconfigured', async () => {
    const database = () =>
      ({
        pool: {},
        scopedPool: {
          async connect() {
            return {
              async query() {
                return { rowCount: 1, rows: [{ ready: true }] };
              },
              release() {},
            };
          },
        },
        async checkReady() {},
        async close() {},
      }) as unknown as EmdoWorkerDatabaseClient;
    const composition = await createProductionWorkerComposition({
      environment,
      createDatabase: database,
    });
    expect(composition.providerStatus).toEqual({
      overall: 'degraded',
      email: 'unavailable',
      push: 'unavailable',
      calendar: 'unavailable',
      blockers: [
        'worker-email-adapter-unavailable',
        'worker-push-adapter-unavailable',
        'worker-calendar-broker-unavailable',
      ],
    });
    await composition.close();
  });

  it('closes initialized providers if database composition fails', async () => {
    const events: string[] = [];
    let creations = 0;
    await expect(
      createProductionWorkerComposition({
        environment: {
          ...environment,
          EMDO_EXTERNAL_PROVIDERS_ENABLED: 'true',
        },
        createDatabase() {
          creations += 1;
          if (creations === 2) throw new Error('private database detail');
          return {
            pool: {},
            scopedPool: {
              async connect() {
                throw new Error('not used');
              },
            },
            async checkReady() {},
            async close() {
              events.push('executor:close');
            },
          } as unknown as EmdoWorkerDatabaseClient;
        },
        async loadProviders() {
          return providers(events);
        },
      }),
    ).rejects.toThrow('Production worker composition is unavailable');
    expect(events).toEqual([
      'providers:check:email',
      'providers:check:push',
      'providers:check:calendar',
      'providers:close',
      'executor:close',
    ]);
  });

  it('fails closed with exact safe blockers when enabled adapters are absent', async () => {
    await expect(
      createProductionWorkerComposition({
        environment: {
          ...environment,
          EMDO_EXTERNAL_PROVIDERS_ENABLED: 'true',
        },
      }),
    ).rejects.toMatchObject({
      message: 'Production worker providers are unavailable',
      blockers: [
        'worker-email-adapter-unavailable',
        'worker-push-adapter-unavailable',
        'worker-calendar-adapter-unavailable',
      ],
    });
  });

  it('preserves exact credential blockers from an injected provider runtime', async () => {
    const events: string[] = [];
    const runtime = providers(events);
    await expect(
      createProductionWorkerComposition({
        environment: {
          ...environment,
          EMDO_EXTERNAL_PROVIDERS_ENABLED: 'true',
        },
        createDatabase() {
          events.push('database:create');
          throw new Error('must not be reached');
        },
        async loadProviders() {
          return {
            ...runtime,
            status: {
              overall: 'degraded',
              email: 'unavailable',
              push: 'available',
              calendar: 'available',
              blockers: ['worker-email-credentials-unavailable'],
            },
          };
        },
      }),
    ).rejects.toMatchObject({
      message: 'Production worker providers are unavailable',
      blockers: ['worker-email-credentials-unavailable'],
    });
    expect(events).toEqual(['providers:close']);
  });

  it('fails before opening database pools when a configured readiness probe is not exact', async () => {
    const events: string[] = [];
    const runtime = providers(events);
    await expect(
      createProductionWorkerComposition({
        environment: {
          ...environment,
          EMDO_EXTERNAL_PROVIDERS_ENABLED: 'true',
          EMDO_WORKER_PROVIDER_READINESS_TIMEOUT_MS: '250',
        },
        createDatabase() {
          events.push('database:create');
          throw new Error('must not be reached');
        },
        async loadProviders() {
          return {
            ...runtime,
            async checkPushReadiness() {
              events.push('providers:check:push');
              return { status: 'available', leakedDetail: 'invalid' };
            },
          };
        },
      }),
    ).rejects.toMatchObject({
      message: 'Production worker providers are unavailable',
      blockers: ['worker-push-readiness-failed'],
    });
    expect(events).not.toContain('database:create');
    expect(events).toContain('providers:close');
  });

  it('rejects malformed provider-mode configuration without loading adapters', async () => {
    let loads = 0;
    await expect(
      createProductionWorkerComposition({
        environment: {
          ...environment,
          EMDO_EXTERNAL_PROVIDERS_ENABLED: 'yes',
        },
        async loadProviders() {
          loads += 1;
          return providers([]);
        },
      }),
    ).rejects.toThrow('Production worker configuration is invalid');
    expect(loads).toBe(0);
  });

  it('hard-bounds adapter initialization that ignores cancellation', async () => {
    let databaseCreations = 0;
    let providerSignal: AbortSignal | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        Promise.race([
          createProductionWorkerComposition({
            environment: {
              ...environment,
              EMDO_EXTERNAL_PROVIDERS_ENABLED: 'true',
              EMDO_WORKER_PROVIDER_READINESS_TIMEOUT_MS: '100',
            },
            createDatabase() {
              databaseCreations += 1;
              throw new Error('must not be reached');
            },
            async loadProviders(
              _environment,
              context?: { readonly signal: AbortSignal },
            ) {
              providerSignal = context?.signal;
              return new Promise<WorkerProviderRuntime>(() => undefined);
            },
          }),
          new Promise<never>((_resolve, reject) => {
            watchdog = setTimeout(
              () => reject(new Error('provider-loader-was-not-bounded')),
              250,
            );
          }),
        ]),
      ).rejects.toMatchObject({
        message: 'Production worker providers are unavailable',
        blockers: [
          'worker-email-adapter-unavailable',
          'worker-push-adapter-unavailable',
          'worker-calendar-adapter-unavailable',
        ],
      });
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
    }
    expect(providerSignal?.aborted).toBe(true);
    expect(databaseCreations).toBe(0);
  });

  it('closes a late adapter runtime that resolves only after cancellation', async () => {
    const events: string[] = [];
    await expect(
      createProductionWorkerComposition({
        environment: {
          ...environment,
          EMDO_EXTERNAL_PROVIDERS_ENABLED: 'true',
          EMDO_WORKER_PROVIDER_READINESS_TIMEOUT_MS: '100',
        },
        async loadProviders(_environment, { signal }) {
          return new Promise<WorkerProviderRuntime>((resolve) => {
            signal.addEventListener('abort', () => resolve(providers(events)), {
              once: true,
            });
          });
        },
      }),
    ).rejects.toMatchObject({
      message: 'Production worker providers are unavailable',
      blockers: [
        'worker-email-adapter-unavailable',
        'worker-push-adapter-unavailable',
        'worker-calendar-adapter-unavailable',
      ],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(['providers:close']);
  });
});

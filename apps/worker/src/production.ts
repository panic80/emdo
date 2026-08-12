import {
  PostgresCalendarMaintenanceService,
  PostgresDeterministicJobExecutionStore,
  PostgresInvitationDeliveryRepository,
  PostgresNotificationDeliveryRepository,
  PostgresProposalReconciliationRepository,
  PostgresReminderDeliveryService,
  PostgresWorkerOutboxRepository,
  createDatabaseClient,
  type EmdoWorkerDatabaseClient,
} from '@emdo/db/worker';
import { createProviderWriteReconciliationService } from '@emdo/domains/server/provider-proposals';
import { z } from 'zod';

import { createWorkerComposition } from './composition.js';
import {
  checkWorkerProviderReadiness,
  createUnavailableWorkerProviderRuntime,
  normalizeWorkerProviderRuntime,
  type WorkerProviderBlockerCode,
  type WorkerProviderRuntime,
  type WorkerProviderStatus,
} from './providers.js';
import { loadWorkerProcessConfig } from './process.js';

const safeOrigin = (input: string): boolean => {
  try {
    const url = new URL(input);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.origin === input.replace(/\/$/u, '')
    );
  } catch {
    return false;
  }
};

const optionalInteger = (
  value: string | undefined,
  fallback: number,
): string | number => value ?? fallback;

const providerMode = (value: string | undefined): string => value ?? 'false';

const hasExpectedDatabaseIdentity = (
  input: string,
  expectedUsername: string,
): boolean => {
  try {
    if (
      input !== input.trim() ||
      input.length > 4_096 ||
      Array.from(input).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      })
    ) {
      return false;
    }
    const url = new URL(input);
    const forbiddenOverrides = [
      'user',
      'username',
      'password',
      'host',
      'port',
      'database',
      'dbname',
    ];
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      decodeURIComponent(url.username) === expectedUsername &&
      url.password.length > 0 &&
      url.hostname.length > 0 &&
      url.pathname.length > 1 &&
      url.hash === '' &&
      forbiddenOverrides.every((name) => !url.searchParams.has(name))
    );
  } catch {
    return false;
  }
};

const databaseTarget = (input: string): string => {
  const url = new URL(input);
  return `${url.hostname.toLowerCase()}:${url.port || '5432'}${url.pathname}`;
};

const ProductionWorkerConfigSchema = z
  .strictObject({
    applicationOrigin: z.string().max(2_048).refine(safeOrigin),
    queueDatabaseUrl: z
      .string()
      .min(1)
      .refine((value) =>
        hasExpectedDatabaseIdentity(value, 'emdo_worker_login'),
      ),
    executorDatabaseUrl: z
      .string()
      .min(1)
      .refine((value) =>
        hasExpectedDatabaseIdentity(value, 'emdo_worker_executor_login'),
      ),
    dispatcherDatabaseUrl: z
      .string()
      .min(1)
      .refine((value) =>
        hasExpectedDatabaseIdentity(value, 'emdo_worker_dispatcher_login'),
      ),
    outbox: z.strictObject({
      dispatcherId: z
        .string()
        .trim()
        .min(1)
        .max(240)
        .regex(/^[A-Za-z0-9:._-]+$/u),
      pollIntervalMs: z.coerce.number().int().min(250).max(60_000),
      batchLimit: z.coerce.number().int().min(1).max(100),
      leaseMs: z.coerce.number().int().min(1_000).max(300_000),
    }),
    providers: z.strictObject({
      enabled: z.enum(['true', 'false']).transform((value) => value === 'true'),
      readinessTimeoutMs: z.coerce.number().int().min(100).max(10_000),
    }),
  })
  .refine(
    ({ queueDatabaseUrl, executorDatabaseUrl, dispatcherDatabaseUrl }) =>
      new Set(
        [queueDatabaseUrl, executorDatabaseUrl, dispatcherDatabaseUrl].map(
          databaseTarget,
        ),
      ).size === 1,
    { message: 'Worker database targets must match' },
  );

export interface ProductionWorkerConfig {
  readonly applicationOrigin: string;
  readonly queueDatabaseUrl: string;
  readonly executorDatabaseUrl: string;
  readonly dispatcherDatabaseUrl: string;
  readonly outbox: Readonly<{
    dispatcherId: string;
    pollIntervalMs: number;
    batchLimit: number;
    leaseMs: number;
  }>;
  readonly providers: Readonly<{
    enabled: boolean;
    readinessTimeoutMs: number;
  }>;
}

export const loadProductionWorkerConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): ProductionWorkerConfig => {
  let databaseUrl: string;
  try {
    databaseUrl = loadWorkerProcessConfig(environment).databaseUrl;
  } catch {
    throw new Error('Production worker configuration is invalid');
  }
  const parsed = ProductionWorkerConfigSchema.safeParse({
    applicationOrigin: environment.EMDO_APPLICATION_ORIGIN,
    queueDatabaseUrl: databaseUrl,
    executorDatabaseUrl: environment.EMDO_WORKER_EXECUTOR_DATABASE_URL,
    dispatcherDatabaseUrl: environment.EMDO_WORKER_DISPATCHER_DATABASE_URL,
    outbox: {
      dispatcherId: environment.EMDO_WORKER_DISPATCHER_ID,
      pollIntervalMs: optionalInteger(
        environment.EMDO_WORKER_OUTBOX_POLL_MS,
        1_000,
      ),
      batchLimit: optionalInteger(
        environment.EMDO_WORKER_OUTBOX_BATCH_LIMIT,
        25,
      ),
      leaseMs: optionalInteger(environment.EMDO_WORKER_OUTBOX_LEASE_MS, 30_000),
    },
    providers: {
      enabled: providerMode(environment.EMDO_EXTERNAL_PROVIDERS_ENABLED),
      readinessTimeoutMs: optionalInteger(
        environment.EMDO_WORKER_PROVIDER_READINESS_TIMEOUT_MS,
        3_000,
      ),
    },
  });
  if (!parsed.success) {
    throw new Error('Production worker configuration is invalid');
  }
  return Object.freeze({
    applicationOrigin: parsed.data.applicationOrigin.replace(/\/$/u, ''),
    queueDatabaseUrl: parsed.data.queueDatabaseUrl,
    executorDatabaseUrl: parsed.data.executorDatabaseUrl,
    dispatcherDatabaseUrl: parsed.data.dispatcherDatabaseUrl,
    outbox: Object.freeze(parsed.data.outbox),
    providers: Object.freeze(parsed.data.providers),
  });
};

const ALL_ADAPTER_BLOCKERS = Object.freeze([
  'worker-email-adapter-unavailable',
  'worker-push-adapter-unavailable',
  'worker-calendar-adapter-unavailable',
] as const satisfies readonly WorkerProviderBlockerCode[]);

export class ProductionWorkerProviderError extends Error {
  readonly blockers: readonly WorkerProviderBlockerCode[];

  constructor(blockers: readonly WorkerProviderBlockerCode[]) {
    super('Production worker providers are unavailable');
    this.name = 'ProductionWorkerProviderError';
    this.blockers = Object.freeze([...blockers]);
  }
}

type DatabaseFactory = (input: {
  readonly connectionString: string;
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
  readonly applicationName?: string;
  readonly fixedRole: 'emdo_worker_executor' | 'emdo_worker_dispatch_executor';
}) => EmdoWorkerDatabaseClient;

type ResourceCloser = () => Promise<void>;

const captureCloser = (target: object): ResourceCloser => {
  let current: object | null = target;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'close');
    if (descriptor !== undefined) {
      if (
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        typeof descriptor.value !== 'function'
      ) {
        break;
      }
      return descriptor.value.bind(target) as ResourceCloser;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new Error('invalid');
};

const closeAll = async (closers: readonly ResourceCloser[]): Promise<void> => {
  const results = await Promise.allSettled(
    closers.map((close) => Promise.resolve().then(close)),
  );
  if (results.some((result) => result.status === 'rejected')) {
    throw new Error('Production worker resource shutdown failed');
  }
};

const PROVIDER_LOAD_TIMED_OUT = Symbol('provider-load-timed-out');

type ProviderLoader = (
  configuration: Readonly<{
    readonly schemaVersion: 1;
    readonly applicationOrigin: string;
  }>,
  context: { readonly signal: AbortSignal },
) => Promise<WorkerProviderRuntime>;

const loadProvidersBounded = async (input: {
  readonly loader: ProviderLoader;
  readonly configuration: Readonly<{
    readonly schemaVersion: 1;
    readonly applicationOrigin: string;
  }>;
  readonly timeoutMs: number;
}): Promise<WorkerProviderRuntime> => {
  const controller = new AbortController();
  let resolveAbort:
    ((value: typeof PROVIDER_LOAD_TIMED_OUT) => void) | undefined;
  const aborted = new Promise<typeof PROVIDER_LOAD_TIMED_OUT>((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = (): void => resolveAbort?.(PROVIDER_LOAD_TIMED_OUT);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const pending = Promise.resolve().then(() =>
    input.loader(input.configuration, { signal: controller.signal }),
  );
  let result: WorkerProviderRuntime | typeof PROVIDER_LOAD_TIMED_OUT;
  try {
    result = await Promise.race([pending, aborted]);
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener('abort', onAbort);
  }
  if (result !== PROVIDER_LOAD_TIMED_OUT) return result;

  void pending
    .then(async (lateRuntime) => {
      try {
        await captureCloser(lateRuntime)();
      } catch {
        // A provider that ignored cancellation is never admitted to runtime.
      }
    })
    .catch(() => {
      // Preserve only the safe, exact startup blocker codes below.
    });
  throw new ProductionWorkerProviderError(ALL_ADAPTER_BLOCKERS);
};

export const createProductionWorkerComposition = async (input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly createDatabase?: DatabaseFactory;
  readonly loadProviders?: ProviderLoader;
}) => {
  const config = loadProductionWorkerConfig(input.environment);
  let providers: WorkerProviderRuntime | undefined;
  let providerStatus: WorkerProviderStatus | undefined;
  let executorDatabase: EmdoWorkerDatabaseClient | undefined;
  let dispatcherDatabase: EmdoWorkerDatabaseClient | undefined;
  const closers: ResourceCloser[] = [];
  try {
    if (config.providers.enabled) {
      if (input.loadProviders === undefined) {
        throw new ProductionWorkerProviderError(ALL_ADAPTER_BLOCKERS);
      }
      let loaded: WorkerProviderRuntime;
      try {
        loaded = await loadProvidersBounded({
          loader: input.loadProviders,
          configuration: Object.freeze({
            schemaVersion: 1 as const,
            applicationOrigin: config.applicationOrigin,
          }),
          timeoutMs: config.providers.readinessTimeoutMs,
        });
        providers = normalizeWorkerProviderRuntime(loaded);
      } catch {
        throw new ProductionWorkerProviderError(ALL_ADAPTER_BLOCKERS);
      }
    } else {
      providers = createUnavailableWorkerProviderRuntime();
    }
    closers.push(captureCloser(providers));
    if (config.providers.enabled) {
      if (providers.status.overall !== 'available') {
        throw new ProductionWorkerProviderError(providers.status.blockers);
      }
      providerStatus = await checkWorkerProviderReadiness(providers, {
        timeoutMs: config.providers.readinessTimeoutMs,
      });
      if (providerStatus.overall !== 'available') {
        throw new ProductionWorkerProviderError(providerStatus.blockers);
      }
    } else {
      providerStatus = providers.status;
    }
    executorDatabase = (input.createDatabase ?? createDatabaseClient)({
      connectionString: config.executorDatabaseUrl,
      max: 7,
      applicationName: 'emdo-worker-executor',
      fixedRole: 'emdo_worker_executor',
    });
    closers.push(captureCloser(executorDatabase));
    await executorDatabase.checkReady({
      signal: AbortSignal.timeout(config.providers.readinessTimeoutMs),
    });
    dispatcherDatabase = (input.createDatabase ?? createDatabaseClient)({
      connectionString: config.dispatcherDatabaseUrl,
      max: 3,
      applicationName: 'emdo-worker-dispatcher',
      fixedRole: 'emdo_worker_dispatch_executor',
    });
    closers.push(captureCloser(dispatcherDatabase));
    await dispatcherDatabase.checkReady({
      signal: AbortSignal.timeout(config.providers.readinessTimeoutMs),
    });
    const executorPool = executorDatabase.scopedPool;
    const dispatcherPool = dispatcherDatabase.scopedPool;
    return createWorkerComposition({
      applicationOrigin: config.applicationOrigin,
      providerStatus,
      repositories: {
        executions: new PostgresDeterministicJobExecutionStore(executorPool),
        reminders: new PostgresReminderDeliveryService(executorPool),
        calendar: new PostgresCalendarMaintenanceService(
          executorPool,
          providers.calendar,
          {
            async reconcile({
              providerAttemptId,
              approvalBinding,
              completion,
              execution,
            }) {
              const repository = new PostgresProposalReconciliationRepository({
                workerPool: executorPool,
                execution,
                providerAttemptId,
              });
              return createProviderWriteReconciliationService(
                repository,
              ).reconcile(approvalBinding, completion);
            },
          },
        ),
        notifications: new PostgresNotificationDeliveryRepository(executorPool),
        invitations: new PostgresInvitationDeliveryRepository(executorPool),
        outbox: new PostgresWorkerOutboxRepository(dispatcherPool),
        close: () => closeAll(closers),
      },
      providers,
      outbox: config.outbox,
    });
  } catch (error) {
    try {
      await closeAll(closers);
    } catch {
      // Return one safe composition failure after all cleanup is attempted.
    }
    if (error instanceof ProductionWorkerProviderError) throw error;
    throw new Error('Production worker composition is unavailable');
  }
};

/**
 * Direct artifact boundary. The repository currently contains transport
 * interfaces and privacy-preserving senders, but no selected production email
 * or Web Push factory and no service-authenticated API-owned Calendar broker.
 * Keep those distinct absences explicit and fail closed if external providers
 * are enabled.
 */
export const createDirectProductionWorkerComposition = (input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly createDatabase?: DatabaseFactory;
}) =>
  createProductionWorkerComposition({
    environment: input.environment,
    ...(input.createDatabase === undefined
      ? {}
      : { createDatabase: input.createDatabase }),
    async loadProviders(_environment, { signal }) {
      signal.throwIfAborted();
      return createUnavailableWorkerProviderRuntime();
    },
  });

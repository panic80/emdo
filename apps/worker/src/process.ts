import { z } from 'zod';

import {
  type WorkerJobDependencies,
  type WorkerJobEnqueueResult,
  type WorkerJobName,
  type WorkerJobSchedulingOptions,
} from './jobs.js';
import {
  createWorkerHealthServer,
  loadWorkerHealthConfig,
  type WorkerHealthConfig,
  type WorkerHealthServer,
} from './health.js';
import {
  startDeterministicWorker,
  type DeterministicWorkerHandle,
  type WorkerOperationalEvent,
} from './main.js';
import type { WorkerProviderStatus } from './providers.js';

export interface WorkerOutboxDispatcherHandle {
  stop(): Promise<void>;
}

export interface WorkerProcessComposition {
  readonly providerStatus: WorkerProviderStatus;
  readonly jobDependencies: WorkerJobDependencies;
  startOutboxDispatcher(input: {
    readonly signal: AbortSignal;
    readonly enqueue: (
      name: WorkerJobName,
      payload: unknown,
      options?: WorkerJobSchedulingOptions,
    ) => Promise<WorkerJobEnqueueResult>;
    readonly onFatalError: () => void;
  }): Promise<WorkerOutboxDispatcherHandle>;
  close(): Promise<void>;
}

export interface WorkerProcessHandle {
  stop(): Promise<void>;
}

export interface WorkerProcessConfig {
  readonly databaseUrl: string;
  readonly health: WorkerHealthConfig;
}

const hasSafeDatabaseUrl = (input: string): boolean => {
  try {
    if (input !== input.trim() || input.length > 4_096) return false;
    if (
      Array.from(input).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      })
    ) {
      return false;
    }
    const url = new URL(input);
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      url.username.length > 0 &&
      url.hostname.length > 0 &&
      url.pathname.length > 1 &&
      url.hash === ''
    );
  } catch {
    return false;
  }
};

const WorkerProcessConfigSchema = z.strictObject({
  databaseUrl: z.string().refine(hasSafeDatabaseUrl),
  health: z.strictObject({
    host: z.enum(['127.0.0.1', '0.0.0.0']),
    port: z.number().int().min(1).max(65_535),
  }),
});

export const loadWorkerProcessConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): WorkerProcessConfig => {
  let health: WorkerHealthConfig;
  try {
    health = loadWorkerHealthConfig(environment);
  } catch {
    throw new Error('Worker process configuration is invalid');
  }
  const parsed = WorkerProcessConfigSchema.safeParse({
    databaseUrl: environment.EMDO_WORKER_DATABASE_URL,
    health,
  });
  if (!parsed.success) {
    throw new Error('Worker process configuration is invalid');
  }
  return Object.freeze({
    databaseUrl: parsed.data.databaseUrl,
    health: Object.freeze(parsed.data.health),
  });
};

type CreateComposition = (input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
}) => Promise<WorkerProcessComposition>;

type StartQueue = (input: {
  readonly databaseUrl: string;
  readonly dependencies: WorkerJobDependencies;
  readonly onOperationalEvent: (event: WorkerOperationalEvent) => void;
}) => Promise<DeterministicWorkerHandle>;

const stopAfterFailedStartup = async (input: {
  readonly dispatcher?: WorkerOutboxDispatcherHandle;
  readonly queue?: DeterministicWorkerHandle;
  readonly composition?: WorkerProcessComposition;
  readonly health: WorkerHealthServer;
  readonly abortController: AbortController;
}): Promise<void> => {
  input.health.setReady(false);
  input.abortController.abort(new Error('Worker process is stopping'));
  for (const stop of [
    input.dispatcher?.stop.bind(input.dispatcher),
    input.queue?.stop.bind(input.queue),
    input.composition?.close.bind(input.composition),
    input.health.close.bind(input.health),
  ]) {
    if (stop === undefined) continue;
    try {
      await stop();
    } catch {
      // Startup returns one safe failure after exhausting cleanup.
    }
  }
};

export const startWorkerProcess = async (input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly createComposition: CreateComposition;
  readonly createHealthServer?: (
    config: WorkerHealthConfig,
  ) => Promise<WorkerHealthServer>;
  readonly startQueue?: StartQueue;
  readonly onOperationalEvent?: (event: WorkerOperationalEvent) => void;
}): Promise<WorkerProcessHandle> => {
  const config = loadWorkerProcessConfig(input.environment);
  const health = await (input.createHealthServer ?? createWorkerHealthServer)(
    config.health,
  );
  const abortController = new AbortController();
  let composition: WorkerProcessComposition | undefined;
  let queue: DeterministicWorkerHandle | undefined;
  let dispatcher: WorkerOutboxDispatcherHandle | undefined;
  let operationallyHealthy = true;
  let startupComplete = false;
  let stopPromise: Promise<void> | undefined;

  const stopAcquiredResources = (): Promise<void> => {
    stopPromise ??= (async () => {
      health.setReady(false);
      abortController.abort(new Error('Worker process is stopping'));
      let failed = false;
      for (const stop of [
        dispatcher?.stop.bind(dispatcher),
        queue?.stop.bind(queue),
        composition?.close.bind(composition),
        health.close.bind(health),
      ]) {
        if (stop === undefined) continue;
        try {
          await stop();
        } catch {
          failed = true;
        }
      }
      if (failed) throw new Error('Worker process shutdown failed');
    })();
    return stopPromise;
  };

  const requestFatalShutdown = (event: WorkerOperationalEvent): void => {
    operationallyHealthy = false;
    try {
      input.onOperationalEvent?.(event);
    } catch {
      // Operational reporting cannot make shutdown unsafe.
    }
    if (startupComplete) {
      void stopAcquiredResources().catch(() => {
        // Readiness is already false and every cleanup step was attempted.
      });
    } else {
      health.setReady(false);
      abortController.abort(new Error('Worker process is stopping'));
    }
  };

  try {
    composition = await input.createComposition({
      environment: input.environment,
    });
    health.setProviderStatus(composition.providerStatus);
    queue = await (input.startQueue ?? startDeterministicWorker)({
      databaseUrl: config.databaseUrl,
      dependencies: composition.jobDependencies,
      onOperationalEvent(event) {
        requestFatalShutdown(event);
      },
    });
    dispatcher = await composition.startOutboxDispatcher({
      signal: abortController.signal,
      enqueue: (name, payload, options) =>
        queue!.enqueue(name, payload, options),
      onFatalError: () =>
        requestFatalShutdown({ code: 'outbox-runtime-error' }),
    });
    if (!operationallyHealthy) throw new Error('invalid');
    health.setReady(true);
    startupComplete = true;
  } catch {
    await stopAfterFailedStartup({
      dispatcher,
      queue,
      composition,
      health,
      abortController,
    });
    throw new Error('Worker process startup failed');
  }

  return Object.freeze({
    stop(): Promise<void> {
      return stopAcquiredResources();
    },
  });
};

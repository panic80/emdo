import { describe, expect, it } from 'vitest';

import { WORKER_JOB_NAMES, type WorkerJobDependencies } from './jobs.js';
import {
  loadWorkerProcessConfig,
  startWorkerProcess,
  type WorkerProcessComposition,
} from './process.js';

const dependencies = (): WorkerJobDependencies => ({
  executions: {
    async executeOnce(input, operation) {
      await operation({
        jobName: input.jobName,
        operationId: input.operationId,
        queueJobId: input.jobId,
        payloadHash: input.payloadHash,
        leaseToken: '30000000-0000-4000-8000-000000000001',
        leaseExpiresAt: '2026-08-10T12:05:00.000Z',
      });
      return { status: 'executed' };
    },
  },
  reminders: { async deliverReminder() {} },
  calendar: {
    async synchronize() {},
    async retrySynchronization() {},
    async reconcileProviderAttempt() {},
  },
  notifications: {
    async deliver() {
      return { status: 'delivered', attemptedChannels: 1 };
    },
  },
  invitations: {
    async deliver() {
      return { status: 'delivered' };
    },
  },
});

const environment = {
  EMDO_WORKER_DATABASE_URL: 'postgresql://worker:secret@postgres/emdo_app',
  HEALTH_HOST: '127.0.0.1',
  HEALTH_PORT: '3001',
};

describe('worker executable lifecycle', () => {
  it('becomes ready only after queue registration and outbox dispatch start', async () => {
    const events: string[] = [];
    let queueOperationalError: (() => void) | undefined;
    const composition: WorkerProcessComposition = {
      providerStatus: {
        overall: 'degraded',
        email: 'unavailable',
        push: 'unavailable',
        calendar: 'unavailable',
        blockers: [
          'worker-email-adapter-unavailable',
          'worker-push-adapter-unavailable',
          'worker-calendar-broker-unavailable',
        ],
      },
      jobDependencies: dependencies(),
      async startOutboxDispatcher({ enqueue, signal }) {
        events.push('dispatcher:start');
        expect(signal.aborted).toBe(false);
        await expect(
          enqueue(WORKER_JOB_NAMES.reminderDelivery, {
            schemaVersion: 1,
            origin: 'deterministic-worker',
            operationId: 'operation:outbox:1',
            reminderId: 'reminder-reference',
            dueRevision: 1,
          }),
        ).resolves.toEqual({
          status: 'duplicate',
          jobId: '20000000-0000-4000-8000-000000000001',
        });
        return {
          async stop() {
            events.push(`dispatcher:stop:${String(signal.aborted)}`);
          },
        };
      },
      async close() {
        events.push('composition:close');
      },
    };

    const handle = await startWorkerProcess({
      environment,
      createHealthServer: async () => {
        events.push('health:start');
        return {
          port: 3001,
          setReady(ready) {
            events.push(`ready:${String(ready)}`);
          },
          setProviderStatus(status) {
            events.push(`providers:${status.overall}`);
          },
          async close() {
            events.push('health:close');
          },
        };
      },
      createComposition: async () => {
        events.push('composition:create');
        return composition;
      },
      startQueue: async ({
        dependencies: queueDependencies,
        onOperationalEvent,
      }) => {
        events.push('queue:start');
        expect(queueDependencies).toBe(composition.jobDependencies);
        queueOperationalError = () =>
          onOperationalEvent({ code: 'queue-runtime-error' });
        return {
          async enqueue() {
            events.push('queue:enqueue');
            return {
              status: 'duplicate',
              jobId: '20000000-0000-4000-8000-000000000001',
            };
          },
          async stop() {
            events.push('queue:stop');
          },
        };
      },
    });

    expect(events).toEqual([
      'health:start',
      'composition:create',
      'providers:degraded',
      'queue:start',
      'dispatcher:start',
      'queue:enqueue',
      'ready:true',
    ]);

    queueOperationalError?.();
    expect(events).toContain('ready:false');

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events.slice(-5)).toEqual([
      'ready:false',
      'dispatcher:stop:true',
      'queue:stop',
      'composition:close',
      'health:close',
    ]);

    await handle.stop();
    await handle.stop();
    expect(events.slice(-5)).toEqual([
      'ready:false',
      'dispatcher:stop:true',
      'queue:stop',
      'composition:close',
      'health:close',
    ]);
    expect(events.filter((event) => event === 'queue:stop')).toHaveLength(1);
  });

  it('cleans every acquired resource and stays unready when startup fails', async () => {
    const events: string[] = [];
    const composition: WorkerProcessComposition = {
      providerStatus: {
        overall: 'degraded',
        email: 'unavailable',
        push: 'unavailable',
        calendar: 'unavailable',
        blockers: [
          'worker-email-adapter-unavailable',
          'worker-push-adapter-unavailable',
          'worker-calendar-broker-unavailable',
        ],
      },
      jobDependencies: dependencies(),
      async startOutboxDispatcher() {
        events.push('dispatcher:failed');
        throw new Error('private provider configuration');
      },
      async close() {
        events.push('composition:close');
      },
    };

    await expect(
      startWorkerProcess({
        environment,
        createHealthServer: async () => ({
          port: 3001,
          setReady(ready) {
            events.push(`ready:${String(ready)}`);
          },
          setProviderStatus() {},
          async close() {
            events.push('health:close');
          },
        }),
        createComposition: async () => composition,
        startQueue: async () => ({
          async enqueue() {
            return {
              status: 'duplicate',
              jobId: '20000000-0000-4000-8000-000000000001',
            };
          },
          async stop() {
            events.push('queue:stop');
          },
        }),
      }),
    ).rejects.toThrow('Worker process startup failed');

    expect(events).toEqual([
      'dispatcher:failed',
      'ready:false',
      'queue:stop',
      'composition:close',
      'health:close',
    ]);
  });

  it('loads only a dedicated runtime DSN and strict health configuration', () => {
    expect(loadWorkerProcessConfig(environment)).toEqual({
      databaseUrl: environment.EMDO_WORKER_DATABASE_URL,
      health: { host: '127.0.0.1', port: 3001 },
    });

    for (const unsafeEnvironment of [
      {},
      { ...environment, EMDO_WORKER_DATABASE_URL: '' },
      {
        ...environment,
        EMDO_WORKER_DATABASE_URL: 'https://postgres/emdo_app',
      },
      {
        ...environment,
        DATABASE_URL: environment.EMDO_WORKER_DATABASE_URL,
        EMDO_WORKER_DATABASE_URL: undefined,
      },
    ]) {
      expect(() => loadWorkerProcessConfig(unsafeEnvironment)).toThrow(
        'Worker process configuration is invalid',
      );
    }
  });
});

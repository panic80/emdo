import { describe, expect, it } from 'vitest';

import type {
  InvitationDeliverySecretOpeningBoundary,
  TransactionalEmailTransport,
} from '@emdo/integrations/email';
import type { WebPushTransport } from '@emdo/integrations/push';

import { createWorkerComposition } from './composition.js';
import type { WorkerJobDependencies } from './jobs.js';

const baseJobDependencies = (): Omit<
  WorkerJobDependencies,
  'notifications' | 'invitations'
> => ({
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
});

describe('production worker composition boundary', () => {
  it('composes only deterministic repositories, fixed-preview providers, and the durable outbox', async () => {
    const calls: string[] = [];
    const emailMessages: unknown[] = [];
    const email: TransactionalEmailTransport = {
      async send(message) {
        emailMessages.push(message);
        return { status: 'duplicate' };
      },
    };
    const push: WebPushTransport = {
      async send() {
        return { status: 'duplicate' };
      },
    };
    const openedBytes: Uint8Array[] = [];
    const invitationSecrets: InvitationDeliverySecretOpeningBoundary = {
      async withOpenedSecret(_input, useSecret) {
        const secret = new TextEncoder().encode('A'.repeat(43));
        openedBytes.push(secret);
        try {
          return await useSecret(secret);
        } finally {
          secret.fill(0);
        }
      },
    };
    const composition = createWorkerComposition({
      applicationOrigin: 'https://emdo.example',
      providerStatus: {
        overall: 'available',
        email: 'available',
        push: 'available',
        calendar: 'available',
        blockers: [],
      },
      repositories: {
        ...baseJobDependencies(),
        notifications: {
          async loadForDelivery() {
            throw new Error('not used');
          },
          async writeInApp() {
            return { status: 'created' };
          },
          async recordExternalOutcome() {},
        },
        invitations: {
          async captureForDelivery(input, context) {
            expect(context.execution.operationId).toBe(input.operationId);
            calls.push(`invitation:capture:${input.invitationId}`);
            return {
              schemaVersion: 1,
              status: 'active',
              invitationId: input.invitationId,
              deliverySecretId: input.deliverySecretId,
              recipient: 'member@example.ca',
              role: 'member',
              tokenHash: 'a'.repeat(64),
              templateVersion: 'invitation-redemption.v1',
              envelope: {
                schemaVersion: 1,
                algorithm: 'RSA-OAEP-256',
                keyId: 'invitation-delivery-key-2026-08',
                ciphertext: 'B'.repeat(342),
                bindingHash: 'b'.repeat(64),
              },
            };
          },
          async settleDelivery(input) {
            calls.push(`invitation:settle:${input.disposition}`);
            return { status: 'settled' };
          },
        },
        outbox: {
          async listDue() {
            calls.push('outbox:list');
            return [];
          },
          async bindQueueJob() {},
          async markEnqueued() {},
          async markDispatchFailed() {},
        },
        async close() {
          calls.push('database:close');
        },
      },
      providers: { email, push, invitationSecrets },
      outbox: {
        dispatcherId: 'worker-dispatcher-1',
        pollIntervalMs: 1_000,
        batchLimit: 10,
        leaseMs: 30_000,
      },
    });

    expect(Object.keys(composition.jobDependencies)).toEqual([
      'executions',
      'reminders',
      'calendar',
      'notifications',
      'invitations',
    ]);
    expect(composition.jobDependencies).not.toHaveProperty('agentRunner');
    await expect(
      composition.jobDependencies.invitations.deliver(
        {
          operationId: 'invitation:11111111-1111-4111-8111-111111111111',
          invitationId: '11111111-1111-4111-8111-111111111111',
          deliverySecretId: '22222222-2222-4222-8222-222222222222',
        },
        {
          execution: {
            jobName: 'emdo.invitation.delivery.v1',
            operationId: 'invitation:11111111-1111-4111-8111-111111111111',
            queueJobId: '20000000-0000-8000-8000-000000000006',
            payloadHash: 'a'.repeat(64),
            leaseToken: '30000000-0000-4000-8000-000000000001',
            leaseExpiresAt: '2026-08-10T12:05:00.000Z',
          },
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toEqual({ status: 'delivered' });
    expect(emailMessages).toEqual([
      expect.objectContaining({
        contentClassification: 'invitation-redemption-link',
        recipient: 'member@example.ca',
      }),
    ]);
    expect(openedBytes[0]?.every((value) => value === 0)).toBe(true);
    const dispatcher = await composition.startOutboxDispatcher({
      signal: new AbortController().signal,
      async enqueue() {
        return {
          status: 'duplicate',
          jobId: '20000000-0000-4000-8000-000000000001',
        };
      },
      onFatalError() {},
    });
    expect(calls).toEqual([
      'invitation:capture:11111111-1111-4111-8111-111111111111',
      'invitation:settle:confirmed',
      'outbox:list',
    ]);
    await dispatcher.stop();
    await composition.close();
    await composition.close();
    expect(calls).toEqual([
      'invitation:capture:11111111-1111-4111-8111-111111111111',
      'invitation:settle:confirmed',
      'outbox:list',
      'database:close',
    ]);
  });

  it('fails during composition when a provider method is an accessor', () => {
    const hostile = Object.defineProperty({}, 'send', {
      get() {
        throw new Error('getter must not execute');
      },
    });
    expect(() =>
      createWorkerComposition({
        applicationOrigin: 'https://emdo.example',
        providerStatus: {
          overall: 'available',
          email: 'available',
          push: 'available',
          calendar: 'available',
          blockers: [],
        },
        repositories: {
          ...baseJobDependencies(),
          notifications: {
            async loadForDelivery() {
              throw new Error('not used');
            },
            async writeInApp() {
              return { status: 'created' };
            },
            async recordExternalOutcome() {},
          },
          invitations: {
            async captureForDelivery() {
              throw new Error('not used');
            },
            async settleDelivery() {
              throw new Error('not used');
            },
          },
          outbox: {
            async listDue() {
              return [];
            },
            async bindQueueJob() {},
            async markEnqueued() {},
            async markDispatchFailed() {},
          },
          async close() {},
        },
        providers: {
          email: hostile as TransactionalEmailTransport,
          push: {
            async send() {
              return { status: 'duplicate' };
            },
          },
          invitationSecrets: {
            async withOpenedSecret() {
              throw new Error('not used');
            },
          },
        },
        outbox: {
          dispatcherId: 'worker-dispatcher-1',
          pollIntervalMs: 1_000,
          batchLimit: 10,
          leaseMs: 30_000,
        },
      }),
    ).toThrow('Email notification transport is invalid');
  });
});

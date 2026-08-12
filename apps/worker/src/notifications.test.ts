import { describe, expect, it } from 'vitest';

import {
  EmailNotificationSender,
  type TransactionalEmailTransport,
} from '@emdo/integrations/email';
import {
  PushNotificationSender,
  type WebPushTransport,
} from '@emdo/integrations/push';

import {
  createNotificationDeliveryService,
  type NotificationDeliveryRepository,
} from './notifications.js';
import { WORKER_JOB_NAMES, type WorkerExecutionContext } from './jobs.js';

const notification = {
  schemaVersion: 1,
  notificationId: 'notification-42',
  revision: 3,
  sensitivity: 'sensitive',
  title: 'Credit card payment is overdue',
  body: 'Card 1234 has a CAD 4,292.15 balance due tomorrow.',
  channels: {
    inApp: true,
    email: { recipient: 'member@example.ca' },
    push: { subscriptionReference: 'push-subscription-42' },
  },
} as const;

const executionContext = (
  operationId: string,
  signal = new AbortController().signal,
): WorkerExecutionContext => ({
  execution: {
    jobName: WORKER_JOB_NAMES.notificationDelivery,
    operationId,
    queueJobId: '20000000-0000-4000-8000-000000000005',
    payloadHash: 'a'.repeat(64),
    leaseToken: '30000000-0000-4000-8000-000000000001',
    leaseExpiresAt: '2026-08-10T12:05:00.000Z',
  },
  signal,
});

describe('notification delivery service', () => {
  it('keeps full content in-app but gives email and push only fixed redacted previews', async () => {
    const inApp: unknown[] = [];
    const outcomes: unknown[] = [];
    const emailCalls: unknown[] = [];
    const pushCalls: unknown[] = [];
    const repository: NotificationDeliveryRepository = {
      async loadForDelivery(_input, context) {
        expect(context.execution.operationId).toBe(
          'notification-operation:0001',
        );
        return notification;
      },
      async writeInApp(input, context) {
        expect(context.execution.queueJobId).toBe(
          '20000000-0000-4000-8000-000000000005',
        );
        inApp.push(input);
        return { status: 'created' };
      },
      async recordExternalOutcome(input, context) {
        expect(context.execution.leaseToken).toBe(
          '30000000-0000-4000-8000-000000000001',
        );
        outcomes.push(input);
      },
    };
    const emailTransport: TransactionalEmailTransport = {
      async send(message, context) {
        expect(context).not.toHaveProperty('execution');
        emailCalls.push(message);
        return { status: 'sent', providerMessageReference: 'email-provider-1' };
      },
    };
    const pushTransport: WebPushTransport = {
      async send(message, context) {
        expect(context).not.toHaveProperty('execution');
        pushCalls.push(message);
        return { status: 'sent', providerMessageReference: 'push-provider-1' };
      },
    };
    const service = createNotificationDeliveryService({
      repository,
      email: new EmailNotificationSender(emailTransport, {
        applicationOrigin: 'https://emdo.example',
      }),
      push: new PushNotificationSender(pushTransport),
    });

    await expect(
      service.deliver(
        {
          operationId: 'notification-operation:0001',
          notificationId: 'notification-42',
        },
        executionContext('notification-operation:0001'),
      ),
    ).resolves.toEqual({ status: 'delivered', attemptedChannels: 3 });

    expect(inApp).toEqual([
      expect.objectContaining({
        notificationId: 'notification-42',
        title: notification.title,
        body: notification.body,
        sensitivity: 'sensitive',
      }),
    ]);
    const external = JSON.stringify([emailCalls, pushCalls]);
    expect(external).not.toMatch(/Credit card|1234|4,292\.15|due tomorrow/);
    expect(emailCalls).toEqual([
      expect.objectContaining({
        contentClassification: 'redacted-notification-preview',
      }),
    ]);
    expect(pushCalls).toEqual([
      expect.objectContaining({
        contentClassification: 'redacted-notification-preview',
      }),
    ]);
    expect(outcomes).toEqual([
      expect.objectContaining({ channel: 'email', status: 'sent' }),
      expect.objectContaining({ channel: 'push', status: 'sent' }),
    ]);
  });

  it('derives stable channel idempotency keys from notification identity and revision', async () => {
    const deliveryIds: string[] = [];
    const repository: NotificationDeliveryRepository = {
      async loadForDelivery() {
        return notification;
      },
      async writeInApp(input) {
        deliveryIds.push(input.deliveryId);
        return { status: 'duplicate' };
      },
      async recordExternalOutcome(input) {
        deliveryIds.push(input.deliveryId);
      },
    };
    const email = new EmailNotificationSender(
      {
        async send(message) {
          deliveryIds.push(message.deliveryId);
          return { status: 'duplicate' };
        },
      },
      { applicationOrigin: 'https://emdo.example' },
    );
    const push = new PushNotificationSender({
      async send(message) {
        deliveryIds.push(message.deliveryId);
        return { status: 'duplicate' };
      },
    });
    const service = createNotificationDeliveryService({
      repository,
      email,
      push,
    });

    await service.deliver(
      {
        operationId: 'notification-operation:0001',
        notificationId: 'notification-42',
      },
      executionContext('notification-operation:0001'),
    );
    const first = [...deliveryIds];
    deliveryIds.length = 0;
    await service.deliver(
      {
        operationId: 'different-operation:0002',
        notificationId: 'notification-42',
      },
      executionContext('different-operation:0002'),
    );

    expect(deliveryIds).toEqual(first);
    expect(new Set(first)).toHaveLength(3);
    for (const deliveryId of first) {
      expect(deliveryId).toMatch(/^notification:[a-f0-9]{64}$/);
      expect(deliveryId).not.toContain('notification-42');
    }
  });

  it('fails closed when the authoritative record is missing, mismatched, or invalid', async () => {
    const noOp = async (): Promise<void> => undefined;
    const createService = (record: unknown) =>
      createNotificationDeliveryService({
        repository: {
          async loadForDelivery() {
            return record;
          },
          async writeInApp() {
            return { status: 'created' };
          },
          recordExternalOutcome: noOp,
        },
        email: new EmailNotificationSender(
          {
            async send() {
              return { status: 'duplicate' };
            },
          },
          { applicationOrigin: 'https://emdo.example' },
        ),
        push: new PushNotificationSender({
          async send() {
            return { status: 'duplicate' };
          },
        }),
      });
    const request = {
      operationId: 'notification-operation:0001',
      notificationId: 'notification-42',
    };

    await expect(
      createService(null).deliver(
        request,
        executionContext('notification-operation:0001'),
      ),
    ).rejects.toThrow('Notification is unavailable for delivery');
    await expect(
      createService({
        ...notification,
        notificationId: 'notification-other',
      }).deliver(request, executionContext('notification-operation:0001')),
    ).rejects.toThrow('Notification is unavailable for delivery');
    await expect(
      createService({
        ...notification,
        credentials: 'must never be accepted',
      }).deliver(request, executionContext('notification-operation:0001')),
    ).rejects.toThrow('Notification is unavailable for delivery');
  });

  it('attempts every configured channel and returns only a generic retry-safe failure', async () => {
    const attempts: string[] = [];
    const repository: NotificationDeliveryRepository = {
      async loadForDelivery() {
        return notification;
      },
      async writeInApp() {
        attempts.push('in-app');
        throw new Error('private in-app record detail');
      },
      async recordExternalOutcome(input) {
        attempts.push(`record-${input.channel}:${input.status}`);
      },
    };
    const service = createNotificationDeliveryService({
      repository,
      email: new EmailNotificationSender(
        {
          async send() {
            attempts.push('email');
            throw new Error('private email provider detail');
          },
        },
        { applicationOrigin: 'https://emdo.example' },
      ),
      push: new PushNotificationSender({
        async send() {
          attempts.push('push');
          return { status: 'sent', providerMessageReference: 'push-1' };
        },
      }),
    });

    let failure: unknown;
    try {
      await service.deliver(
        {
          operationId: 'notification-operation:0001',
          notificationId: 'notification-42',
        },
        executionContext('notification-operation:0001'),
      );
    } catch (error) {
      failure = error;
    }
    expect(attempts).toEqual([
      'in-app',
      'email',
      'push',
      'record-email:indeterminate',
      'record-push:sent',
    ]);
    expect(failure).toEqual(new Error('Notification delivery failed'));
    expect(JSON.stringify(failure)).not.toMatch(/private|provider detail/);
  });

  it('durably records indeterminate sends with an independent signal and does not blindly retry', async () => {
    const controller = new AbortController();
    const outcomes: unknown[] = [];
    const outcomeSignals: AbortSignal[] = [];
    const service = createNotificationDeliveryService({
      repository: {
        async loadForDelivery() {
          return {
            ...notification,
            channels: {
              inApp: false,
              email: notification.channels.email,
              push: null,
            },
          };
        },
        async writeInApp() {
          throw new Error('must not run');
        },
        async recordExternalOutcome(input, context) {
          outcomes.push(input);
          outcomeSignals.push(context.signal);
        },
      },
      email: new EmailNotificationSender(
        {
          async send() {
            controller.abort();
            throw new Error('provider acceptance unknown');
          },
        },
        { applicationOrigin: 'https://emdo.example' },
      ),
      push: new PushNotificationSender({
        async send() {
          throw new Error('must not run');
        },
      }),
    });

    await expect(
      service.deliver(
        {
          operationId: 'notification-operation:0001',
          notificationId: 'notification-42',
        },
        executionContext('notification-operation:0001', controller.signal),
      ),
    ).resolves.toEqual({
      status: 'requires-reconciliation',
      attemptedChannels: 1,
    });
    expect(outcomes).toEqual([
      expect.objectContaining({ channel: 'email', status: 'indeterminate' }),
    ]);
    expect(outcomeSignals[0]).not.toBe(controller.signal);
    expect(outcomeSignals[0]?.aborted).toBe(false);
  });

  it('records not-applied sends and returns a retryable generic failure', async () => {
    const outcomes: unknown[] = [];
    const service = createNotificationDeliveryService({
      repository: {
        async loadForDelivery() {
          return {
            ...notification,
            channels: {
              inApp: false,
              email: notification.channels.email,
              push: null,
            },
          };
        },
        async writeInApp() {
          throw new Error('must not run');
        },
        async recordExternalOutcome(input) {
          outcomes.push(input);
        },
      },
      email: new EmailNotificationSender(
        {
          async send() {
            return { status: 'not-applied' };
          },
        },
        { applicationOrigin: 'https://emdo.example' },
      ),
      push: new PushNotificationSender({
        async send() {
          throw new Error('must not run');
        },
      }),
    });

    await expect(
      service.deliver(
        {
          operationId: 'notification-operation:0001',
          notificationId: 'notification-42',
        },
        executionContext('notification-operation:0001'),
      ),
    ).rejects.toThrow('Notification delivery failed');
    expect(outcomes).toEqual([
      expect.objectContaining({ channel: 'email', status: 'not-applied' }),
    ]);
  });

  it('converges a mixed-channel retry through provider idempotency outcomes', async () => {
    const outcomes: Array<{ channel: string; status: string }> = [];
    let emailAttempts = 0;
    let pushAttempts = 0;
    const service = createNotificationDeliveryService({
      repository: {
        async loadForDelivery() {
          return {
            ...notification,
            channels: {
              inApp: false,
              email: notification.channels.email,
              push: notification.channels.push,
            },
          };
        },
        async writeInApp() {
          throw new Error('must not run');
        },
        async recordExternalOutcome(input) {
          outcomes.push({ channel: input.channel, status: input.status });
        },
      },
      email: new EmailNotificationSender(
        {
          async send() {
            emailAttempts += 1;
            return emailAttempts === 1
              ? { status: 'sent', providerMessageReference: 'email-1' }
              : { status: 'duplicate' };
          },
        },
        { applicationOrigin: 'https://emdo.example' },
      ),
      push: new PushNotificationSender({
        async send() {
          pushAttempts += 1;
          return pushAttempts === 1
            ? { status: 'not-applied' }
            : { status: 'sent', providerMessageReference: 'push-1' };
        },
      }),
    });
    const request = {
      operationId: 'notification-operation:0001',
      notificationId: 'notification-42',
    } as const;
    const context = executionContext('notification-operation:0001');

    await expect(service.deliver(request, context)).rejects.toThrow(
      'Notification delivery failed',
    );
    await expect(service.deliver(request, context)).resolves.toEqual({
      status: 'delivered',
      attemptedChannels: 2,
    });
    expect(outcomes).toEqual([
      { channel: 'email', status: 'sent' },
      { channel: 'push', status: 'not-applied' },
      { channel: 'email', status: 'duplicate' },
      { channel: 'push', status: 'sent' },
    ]);
  });

  it('never redispatches an indeterminate channel when a sibling channel is retryable', async () => {
    const durableOutcomes: {
      email: 'indeterminate' | null;
      push: 'not-applied' | 'sent' | null;
    } = { email: null, push: null };
    let emailAttempts = 0;
    let pushAttempts = 0;
    const service = createNotificationDeliveryService({
      repository: {
        async loadForDelivery() {
          return {
            ...notification,
            channels: {
              inApp: false,
              email: notification.channels.email,
              push: notification.channels.push,
            },
            externalOutcomes: { ...durableOutcomes },
          };
        },
        async writeInApp() {
          throw new Error('must not run');
        },
        async recordExternalOutcome(input) {
          if (input.channel === 'email') {
            durableOutcomes.email = input.status as 'indeterminate';
          } else {
            durableOutcomes.push = input.status as 'not-applied' | 'sent';
          }
        },
      },
      email: new EmailNotificationSender(
        {
          async send() {
            emailAttempts += 1;
            throw new Error('provider acceptance unknown');
          },
        },
        { applicationOrigin: 'https://emdo.example' },
      ),
      push: new PushNotificationSender({
        async send() {
          pushAttempts += 1;
          return pushAttempts === 1
            ? { status: 'not-applied' }
            : { status: 'sent', providerMessageReference: 'push-2' };
        },
      }),
    });
    const deliveryRequest = {
      operationId: 'notification-operation:0001',
      notificationId: 'notification-42',
    } as const;
    const workerContext = executionContext('notification-operation:0001');

    await expect(
      service.deliver(deliveryRequest, workerContext),
    ).rejects.toThrow('Notification delivery failed');
    await expect(
      service.deliver(deliveryRequest, workerContext),
    ).resolves.toEqual({
      status: 'requires-reconciliation',
      attemptedChannels: 2,
    });
    expect(emailAttempts).toBe(1);
    expect(pushAttempts).toBe(2);
  });

  it('captures repository methods before accepting notification jobs', async () => {
    const repository: NotificationDeliveryRepository = {
      async loadForDelivery() {
        return {
          ...notification,
          channels: { inApp: true, email: null, push: null },
        };
      },
      async writeInApp() {
        return { status: 'created' };
      },
      async recordExternalOutcome() {},
    };
    const service = createNotificationDeliveryService({
      repository,
      email: new EmailNotificationSender(
        {
          async send() {
            return { status: 'duplicate' };
          },
        },
        { applicationOrigin: 'https://emdo.example' },
      ),
      push: new PushNotificationSender({
        async send() {
          return { status: 'duplicate' };
        },
      }),
    });
    repository.loadForDelivery = async () => null;

    await expect(
      service.deliver(
        {
          operationId: 'notification-operation:0001',
          notificationId: 'notification-42',
        },
        executionContext('notification-operation:0001'),
      ),
    ).resolves.toEqual({ status: 'delivered', attemptedChannels: 1 });
  });
});

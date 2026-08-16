import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NOTIFICATION_TRANSPORT_TIMEOUT_MS,
  PushNotificationSender,
  type WebPushTransport,
} from './notification-push.js';

const createSignal = (): AbortSignal => new AbortController().signal;

afterEach(() => {
  vi.useRealTimers();
});

describe('PushNotificationSender', () => {
  it('sends only a fixed non-sensitive preview and never receives endpoint credentials', async () => {
    const calls: unknown[] = [];
    const transport: WebPushTransport = {
      async send(message) {
        calls.push(message);
        return { status: 'sent', providerMessageReference: 'provider-42' };
      },
    };
    const sender = new PushNotificationSender(transport);

    await expect(
      sender.send(
        {
          deliveryId: 'notification:018f1f5e:push',
          subscriptionReference: 'subscription-42',
        },
        { signal: createSignal() },
      ),
    ).resolves.toEqual({ status: 'sent' });

    expect(calls).toEqual([
      {
        schemaVersion: 1,
        deliveryId: 'notification:018f1f5e:push',
        subscriptionReference: 'subscription-42',
        title: 'EMDO update',
        body: 'Open EMDO to view the latest update.',
        url: '/activity',
        tag: 'emdo-notification',
        contentClassification: 'redacted-notification-preview',
      },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(
      /endpoint|auth|p256dh|provider-42/,
    );
  });

  it('rejects malformed references before transport', async () => {
    let calls = 0;
    const transport: WebPushTransport = {
      async send() {
        calls += 1;
        return { status: 'gone' };
      },
    };
    const sender = new PushNotificationSender(transport);

    await expect(
      sender.send(
        {
          deliveryId: 'short',
          subscriptionReference: 'subscription-42',
        },
        { signal: createSignal() },
      ),
    ).rejects.toThrow('Push notification request is invalid');
    expect(calls).toBe(0);
  });

  it('marks invalid or thrown provider outcomes indeterminate', async () => {
    const sender = new PushNotificationSender({
      async send() {
        return { status: 'unexpected', secret: 'do-not-surface' };
      },
    });

    await expect(
      sender.send(
        {
          deliveryId: 'notification:018f1f5e:push',
          subscriptionReference: 'subscription-42',
        },
        { signal: createSignal() },
      ),
    ).resolves.toEqual({ status: 'indeterminate' });

    const throwing = new PushNotificationSender({
      async send() {
        throw new Error('private provider response');
      },
    });
    await expect(
      throwing.send(
        {
          deliveryId: 'notification:018f1f5e:push',
          subscriptionReference: 'subscription-42',
        },
        { signal: createSignal() },
      ),
    ).resolves.toEqual({ status: 'indeterminate' });
  });

  it('accepts not-applied and captures the transport method at construction', async () => {
    const transport: WebPushTransport = {
      async send() {
        return { status: 'not-applied' };
      },
    };
    const sender = new PushNotificationSender(transport);
    transport.send = async () => {
      throw new Error('replacement must not run');
    };

    await expect(
      sender.send(
        {
          deliveryId: 'notification:018f1f5e:push',
          subscriptionReference: 'subscription-42',
        },
        { signal: createSignal() },
      ),
    ).resolves.toEqual({ status: 'not-applied' });

    expect(
      () =>
        new PushNotificationSender(
          Object.defineProperty({}, 'send', {
            get() {
              throw new Error('getter must not run');
            },
          }) as WebPushTransport,
        ),
    ).toThrow('Push notification transport is invalid');
  });

  it('does not call the transport after cancellation', async () => {
    let calls = 0;
    const sender = new PushNotificationSender({
      async send() {
        calls += 1;
        return { status: 'duplicate' };
      },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      sender.send(
        {
          deliveryId: 'notification:018f1f5e:push',
          subscriptionReference: 'subscription-42',
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
  });

  it('bounds a non-cooperative transport and marks the outcome indeterminate', async () => {
    vi.useFakeTimers();
    let transportSignal: AbortSignal | undefined;
    const sender = new PushNotificationSender({
      send(_message, context) {
        transportSignal = context.signal;
        return new Promise(() => {});
      },
    });

    const result = sender.send(
      {
        deliveryId: 'notification:018f1f5e:push',
        subscriptionReference: 'subscription-42',
      },
      { signal: createSignal() },
    );
    await vi.advanceTimersByTimeAsync(NOTIFICATION_TRANSPORT_TIMEOUT_MS);

    await expect(result).resolves.toEqual({ status: 'indeterminate' });
    expect(transportSignal?.aborted).toBe(true);
  });
});

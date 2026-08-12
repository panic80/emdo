import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EmailNotificationSender,
  NOTIFICATION_TRANSPORT_TIMEOUT_MS,
  type TransactionalEmailTransport,
} from './notification-email.js';

const createSignal = (): AbortSignal => new AbortController().signal;

afterEach(() => {
  vi.useRealTimers();
});

describe('EmailNotificationSender', () => {
  it('sends only a fixed non-sensitive preview with a stable idempotency key', async () => {
    const calls: unknown[] = [];
    const transport: TransactionalEmailTransport = {
      async send(message) {
        calls.push(message);
        return { status: 'sent', providerMessageReference: 'provider-42' };
      },
    };
    const sender = new EmailNotificationSender(transport, {
      applicationOrigin: 'https://emdo.example',
    });

    await expect(
      sender.send(
        {
          deliveryId: 'notification:018f1f5e:email',
          recipient: 'member@example.ca',
        },
        { signal: createSignal() },
      ),
    ).resolves.toEqual({ status: 'sent' });

    expect(calls).toEqual([
      {
        schemaVersion: 1,
        deliveryId: 'notification:018f1f5e:email',
        recipient: 'member@example.ca',
        subject: 'You have a new EMDO update',
        text: 'Open EMDO to view this update: https://emdo.example/activity',
        contentClassification: 'redacted-notification-preview',
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain('provider-42');
  });

  it('rejects malformed recipients and non-origin application URLs before transport', async () => {
    let calls = 0;
    const transport: TransactionalEmailTransport = {
      async send() {
        calls += 1;
        return { status: 'sent', providerMessageReference: 'provider-42' };
      },
    };

    expect(
      () =>
        new EmailNotificationSender(transport, {
          applicationOrigin: 'https://emdo.example/private?token=secret',
        }),
    ).toThrow('Email notification configuration is invalid');

    const sender = new EmailNotificationSender(transport, {
      applicationOrigin: 'https://emdo.example',
    });
    await expect(
      sender.send(
        {
          deliveryId: 'notification:018f1f5e:email',
          recipient: 'not-an-email',
        },
        { signal: createSignal() },
      ),
    ).rejects.toThrow('Email notification request is invalid');
    expect(calls).toBe(0);
  });

  it('marks invalid or thrown provider outcomes indeterminate without exposing detail', async () => {
    const transport: TransactionalEmailTransport = {
      async send() {
        return {
          status: 'mystery',
          rawProviderResponse: 'private provider diagnostic',
        };
      },
    };
    const sender = new EmailNotificationSender(transport, {
      applicationOrigin: 'https://emdo.example',
    });

    await expect(
      sender.send(
        {
          deliveryId: 'notification:018f1f5e:email',
          recipient: 'member@example.ca',
        },
        { signal: createSignal() },
      ),
    ).resolves.toEqual({ status: 'indeterminate' });

    const throwing = new EmailNotificationSender(
      {
        async send() {
          throw new Error('private provider response');
        },
      },
      { applicationOrigin: 'https://emdo.example' },
    );
    await expect(
      throwing.send(
        {
          deliveryId: 'notification:018f1f5e:email',
          recipient: 'member@example.ca',
        },
        { signal: createSignal() },
      ),
    ).resolves.toEqual({ status: 'indeterminate' });
  });

  it('accepts an explicit not-applied disposition and captures transport methods', async () => {
    const transport: TransactionalEmailTransport = {
      async send() {
        return { status: 'not-applied' };
      },
    };
    const sender = new EmailNotificationSender(transport, {
      applicationOrigin: 'https://emdo.example',
    });
    transport.send = async () => {
      throw new Error('replacement must not run');
    };

    await expect(
      sender.send(
        {
          deliveryId: 'notification:018f1f5e:email',
          recipient: 'member@example.ca',
        },
        { signal: createSignal() },
      ),
    ).resolves.toEqual({ status: 'not-applied' });

    expect(
      () =>
        new EmailNotificationSender(
          Object.defineProperty({}, 'send', {
            get() {
              throw new Error('getter must not run');
            },
          }) as TransactionalEmailTransport,
          { applicationOrigin: 'https://emdo.example' },
        ),
    ).toThrow('Email notification transport is invalid');
  });

  it('does not call the transport after cancellation', async () => {
    let calls = 0;
    const transport: TransactionalEmailTransport = {
      async send() {
        calls += 1;
        return { status: 'duplicate' };
      },
    };
    const sender = new EmailNotificationSender(transport, {
      applicationOrigin: 'https://emdo.example',
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      sender.send(
        {
          deliveryId: 'notification:018f1f5e:email',
          recipient: 'member@example.ca',
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
  });

  it('bounds a non-cooperative transport and marks the outcome indeterminate', async () => {
    vi.useFakeTimers();
    let transportSignal: AbortSignal | undefined;
    const sender = new EmailNotificationSender(
      {
        send(_message, context) {
          transportSignal = context.signal;
          return new Promise(() => {});
        },
      },
      { applicationOrigin: 'https://emdo.example' },
    );

    const result = sender.send(
      {
        deliveryId: 'notification:018f1f5e:email',
        recipient: 'member@example.ca',
      },
      { signal: createSignal() },
    );
    await vi.advanceTimersByTimeAsync(NOTIFICATION_TRANSPORT_TIMEOUT_MS);

    await expect(result).resolves.toEqual({ status: 'indeterminate' });
    expect(transportSignal?.aborted).toBe(true);
  });
});

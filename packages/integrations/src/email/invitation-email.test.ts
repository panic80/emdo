import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  INVITATION_TRANSPORT_TIMEOUT_MS,
  InvitationEmailSender,
  type TransactionalEmailTransport,
} from './index.js';

const invitationId = '11111111-1111-4111-8111-111111111111';
const token = 'A'.repeat(43);
const operationId = 'invitation-delivery:11111111-1111-4111-8111-111111111111';
const signal = (): AbortSignal => new AbortController().signal;
const tokenBytes = (): Uint8Array => new TextEncoder().encode(token);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('InvitationEmailSender', () => {
  it('sends the exact bounded HTTPS redemption message, zeroizes bytes, and returns no secret or provider detail', async () => {
    const messages: unknown[] = [];
    const transport: TransactionalEmailTransport = {
      async send(message) {
        messages.push(message);
        return {
          status: 'sent',
          providerMessageReference: 'private-provider-message-42',
        };
      },
    };
    const sender = new InvitationEmailSender(transport, {
      applicationOrigin: 'https://emdo.example',
    });
    const secret = tokenBytes();
    const consoleSpies = [
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    ];

    const result = await sender.send(
      {
        operationId,
        invitationId,
        invitationTokenBytes: secret,
        recipient: 'member@example.ca',
      },
      { signal: signal() },
    );

    expect(messages).toEqual([
      {
        schemaVersion: 1,
        deliveryId: operationId,
        recipient: 'member@example.ca',
        subject: "You're invited to EMDO",
        text:
          'Join your household in EMDO: https://emdo.example/invite' +
          `?invitationId=${invitationId}` +
          `&token=${token}` +
          '&email=member%40example.ca',
        contentClassification: 'invitation-redemption-link',
      },
    ]);
    expect(secret.every((value) => value === 0)).toBe(true);
    expect(result).toEqual({ status: 'sent' });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('private-provider-message-42');
    for (const consoleSpy of consoleSpies) {
      expect(consoleSpy).not.toHaveBeenCalled();
    }
  });

  it('rejects non-canonical configuration and strict invalid inputs before transport while zeroizing bytes', async () => {
    let calls = 0;
    const transport: TransactionalEmailTransport = {
      async send() {
        calls += 1;
        throw new Error('must not run');
      },
    };
    for (const applicationOrigin of [
      'http://emdo.example',
      'https://user:password@emdo.example',
      'https://emdo.example/base',
      'https://emdo.example?redirect=https://evil.example',
    ]) {
      expect(
        () => new InvitationEmailSender(transport, { applicationOrigin }),
      ).toThrow('Invitation email configuration is invalid');
    }

    const sender = new InvitationEmailSender(transport, {
      applicationOrigin: 'https://emdo.example',
    });
    const extraFieldSecret = tokenBytes();
    await expect(
      sender.send(
        {
          operationId,
          invitationId,
          invitationTokenBytes: extraFieldSecret,
          recipient: 'member@example.ca',
          subject: 'attacker-controlled',
        },
        { signal: signal() },
      ),
    ).rejects.toThrow('Invitation email request is invalid');
    expect(extraFieldSecret.every((value) => value === 0)).toBe(true);

    for (const invalid of [
      new TextEncoder().encode('contains/unsafe?characters'),
      new Uint8Array(39).fill(65),
      new Uint8Array(129).fill(65),
    ]) {
      await expect(
        sender.send(
          {
            operationId,
            invitationId,
            invitationTokenBytes: invalid,
            recipient: 'member@example.ca',
          },
          { signal: signal() },
        ),
      ).rejects.toThrow('Invitation email request is invalid');
      expect(invalid.every((value) => value === 0)).toBe(true);
    }
    expect(calls).toBe(0);
  });

  it('bounds provider execution and maps thrown, timed-out, or malformed results to a generic outcome', async () => {
    const privateProviderDetail = `${token}:private-provider-response`;
    const throwing = new InvitationEmailSender(
      {
        async send() {
          throw new Error(privateProviderDetail);
        },
      },
      { applicationOrigin: 'https://emdo.example' },
    );
    await expect(
      throwing.send(
        {
          operationId,
          invitationId,
          invitationTokenBytes: tokenBytes(),
          recipient: 'member@example.ca',
        },
        { signal: signal() },
      ),
    ).resolves.toEqual({ status: 'indeterminate' });

    const malformed = new InvitationEmailSender(
      {
        async send() {
          return { status: 'sent', detail: privateProviderDetail };
        },
      },
      { applicationOrigin: 'https://emdo.example' },
    );
    await expect(
      malformed.send(
        {
          operationId,
          invitationId,
          invitationTokenBytes: tokenBytes(),
          recipient: 'member@example.ca',
        },
        { signal: signal() },
      ),
    ).resolves.toEqual({ status: 'indeterminate' });

    vi.useFakeTimers();
    let providerSignal: AbortSignal | undefined;
    const hanging = new InvitationEmailSender(
      {
        async send(_message, context) {
          providerSignal = context.signal;
          return new Promise(() => {});
        },
      },
      { applicationOrigin: 'https://emdo.example' },
    );
    const hangingSecret = tokenBytes();
    const result = hanging.send(
      {
        operationId,
        invitationId,
        invitationTokenBytes: hangingSecret,
        recipient: 'member@example.ca',
      },
      { signal: signal() },
    );
    await vi.advanceTimersByTimeAsync(INVITATION_TRANSPORT_TIMEOUT_MS);
    await expect(result).resolves.toEqual({ status: 'indeterminate' });
    expect(providerSignal?.aborted).toBe(true);
    expect(hangingSecret.every((value) => value === 0)).toBe(true);
  });
});

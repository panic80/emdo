import { describe, expect, it, vi } from 'vitest';

import type { TransactionalEmailTransport } from './notification-email.js';
import { createBetterAuthEmailCallbacks } from './better-auth-email.js';

const USER_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f90';

const user = Object.freeze({
  id: USER_ID,
  email: 'member@example.net',
  name: 'Household Member',
  emailVerified: true,
  createdAt: new Date('2026-08-13T00:00:00.000Z'),
  updatedAt: new Date('2026-08-13T00:00:00.000Z'),
});

describe('Better Auth transactional email callbacks', () => {
  it('sends password reset and verification links through the bounded transport', async () => {
    const sent: unknown[] = [];
    const transport: TransactionalEmailTransport = {
      send: vi.fn(async (message) => {
        sent.push(message);
        return {
          status: 'sent',
          providerMessageReference: 'provider-message-1',
        };
      }),
    };
    const callbacks = createBetterAuthEmailCallbacks(transport, {
      applicationOrigin: 'https://emdo.example',
    });
    const resetToken = 'reset-token-012345678901234567890123';
    const verificationToken = 'verify-token-0123456789012345678901';

    await callbacks.sendPasswordResetEmail({
      user,
      token: resetToken,
      url: `https://emdo.example/api/auth/reset-password/${resetToken}?callbackURL=%2F`,
    });
    await callbacks.sendVerificationEmail({
      user,
      token: verificationToken,
      url: `https://emdo.example/api/auth/verify-email?token=${verificationToken}&callbackURL=%2F`,
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      schemaVersion: 1,
      recipient: user.email,
      subject: 'Reset your EMDO password',
      contentClassification: 'authentication-action-link',
    });
    expect(sent[1]).toMatchObject({
      schemaVersion: 1,
      recipient: user.email,
      subject: 'Verify your EMDO email',
      contentClassification: 'authentication-action-link',
    });
    const firstDeliveryId = (sent[0] as { deliveryId: string }).deliveryId;
    expect(firstDeliveryId).toMatch(
      /^auth-email:password-reset:[a-f0-9]{64}$/u,
    );
    expect(JSON.stringify(sent)).not.toContain(USER_ID);
    expect(firstDeliveryId).not.toContain(resetToken);
    expect((sent[0] as { text: string }).text).toContain(resetToken);
  });

  it('uses deterministic per-action idempotency and rejects provider uncertainty', async () => {
    const send = vi
      .fn<TransactionalEmailTransport['send']>()
      .mockResolvedValueOnce({ status: 'duplicate' })
      .mockResolvedValueOnce({ status: 'indeterminate' });
    const callbacks = createBetterAuthEmailCallbacks(
      { send },
      {
        applicationOrigin: 'https://emdo.example',
      },
    );
    const token = 'verify-token-0123456789012345678901';
    const input = {
      user,
      token,
      url: `https://emdo.example/api/auth/verify-email?token=${token}&callbackURL=%2F`,
    };

    await expect(
      callbacks.sendVerificationEmail(input),
    ).resolves.toBeUndefined();
    await expect(callbacks.sendVerificationEmail(input)).rejects.toThrow(
      'Authentication email delivery failed',
    );
    expect((send.mock.calls[0]?.[0] as { deliveryId: string }).deliveryId).toBe(
      (send.mock.calls[1]?.[0] as { deliveryId: string }).deliveryId,
    );
  });

  it('aborts and fails closed when the provider does not settle in time', async () => {
    vi.useFakeTimers();
    let providerSignal: AbortSignal | undefined;
    const send = vi.fn<TransactionalEmailTransport['send']>(
      async (_message, context) => {
        providerSignal = context.signal;
        return await new Promise(() => undefined);
      },
    );
    const callbacks = createBetterAuthEmailCallbacks(
      { send },
      { applicationOrigin: 'https://emdo.example', timeoutMs: 25 },
    );
    const token = 'verify-token-0123456789012345678901';

    const result = callbacks.sendVerificationEmail({
      user,
      token,
      url: `https://emdo.example/api/auth/verify-email?token=${token}&callbackURL=%2F`,
    });
    const rejected = expect(result).rejects.toThrow(
      'Authentication email delivery failed',
    );
    await vi.advanceTimersByTimeAsync(26);

    await rejected;
    expect(providerSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it.each([
    {
      token: 'verify-token-0123456789012345678901',
      url: 'https://evil.example/api/auth/verify-email?token=verify-token-0123456789012345678901',
    },
    {
      token: 'verify-token-0123456789012345678901',
      url: 'https://emdo.example/api/auth/verify-email?token=other-token',
    },
    {
      token: 'verify-token-0123456789012345678901',
      url: 'https://emdo.example/not-auth?token=verify-token-0123456789012345678901',
    },
    {
      token: 'verify-token-0123456789012345678901',
      url: 'https://emdo.example/api/auth/verify-email?token=verify-token-0123456789012345678901&callbackURL=https%3A%2F%2Fevil.example',
    },
    {
      token: 'verify-token-0123456789012345678901',
      url: 'https://emdo.example/api/auth/verify-email?token=verify-token-0123456789012345678901&callbackURL=%2F&unexpected=true',
    },
  ])('rejects mismatched or untrusted action URLs', async (input) => {
    const send = vi.fn();
    const callbacks = createBetterAuthEmailCallbacks(
      { send },
      {
        applicationOrigin: 'https://emdo.example',
      },
    );
    await expect(
      callbacks.sendVerificationEmail({ user, ...input }),
    ).rejects.toThrow('Authentication email request is invalid');
    expect(send).not.toHaveBeenCalled();
  });

  it('fails closed if the disabled Better Auth organization invitation callback is reached', async () => {
    const send = vi.fn();
    const callbacks = createBetterAuthEmailCallbacks(
      { send },
      {
        applicationOrigin: 'https://emdo.example',
      },
    );
    await expect(
      callbacks.sendInvitationEmail({
        id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f91',
        role: 'member',
        email: 'member@example.net',
        organization: {} as never,
        invitation: {} as never,
        inviter: {} as never,
      }),
    ).rejects.toThrow('Better Auth organization invitations are disabled');
    expect(send).not.toHaveBeenCalled();
  });
});

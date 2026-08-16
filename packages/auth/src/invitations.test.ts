import { describe, expect, it } from 'vitest';

import {
  InMemoryInvitationRepository,
  InvitationError,
  InvitationService,
} from './invitations.js';

const now = new Date('2026-08-09T16:00:00.000Z');
const issuer = {
  userId: 'owner-1',
  householdId: 'household-1',
  role: 'owner',
  activeMember: true,
} as const;
const identityProvider = {
  resolveAuthenticatedIdentity: async (sessionId: string) =>
    sessionId === 'verified-session'
      ? {
          userId: 'member-1',
          email: 'member@example.com',
          emailVerified: true as const,
        }
      : sessionId === 'exact-session'
        ? {
            userId: 'member-2',
            email: 'exact@example.com',
            emailVerified: true as const,
          }
        : sessionId === 'other-session'
          ? {
              userId: 'other-1',
              email: 'other@example.com',
              emailVerified: true as const,
            }
          : undefined,
};

describe('InvitationService', () => {
  it('issues an email-bound seven-day invitation and stores only its hash', async () => {
    const repository = new InMemoryInvitationRepository();
    const service = new InvitationService(repository, identityProvider);
    const issued = await service.issue({
      issuer,
      email: 'Member@Example.com',
      role: 'member',
      now,
      expiresAt: new Date('2026-08-16T16:00:00.000Z'),
    });

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const stored = await repository.get(issued.invitation.id);
    expect(stored?.email).toBe('member@example.com');
    expect(stored).toMatchObject({
      householdId: issuer.householdId,
      invitedByUserId: issuer.userId,
    });
    expect(stored?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(issued.token);
    issued.invitation.expiresAt.setUTCFullYear(2030);
    expect(
      (await repository.get(issued.invitation.id))?.expiresAt.getUTCFullYear(),
    ).toBe(2026);
  });

  it('consumes exactly once and rejects wrong email, expiry, and excessive lifetime', async () => {
    const service = new InvitationService(
      new InMemoryInvitationRepository(),
      identityProvider,
    );
    const issued = await service.issue({
      issuer,
      email: 'member@example.com',
      role: 'member',
      now,
      expiresAt: new Date('2026-08-10T16:00:00.000Z'),
    });

    await expect(
      service.consume({
        invitationId: issued.invitation.id,
        authenticatedSessionId: 'other-session',
        token: issued.token,
        now,
      }),
    ).rejects.toMatchObject({ code: 'invitation-invalid' });
    await expect(
      service.consume({
        invitationId: issued.invitation.id,
        authenticatedSessionId: 'verified-session',
        token: issued.token,
        now,
      }),
    ).resolves.toMatchObject({ consumedAt: now });
    await expect(
      service.consume({
        invitationId: issued.invitation.id,
        authenticatedSessionId: 'verified-session',
        token: issued.token,
        now,
      }),
    ).rejects.toBeInstanceOf(InvitationError);
    await expect(
      service.issue({
        issuer,
        email: 'member@example.com',
        role: 'member',
        now,
        expiresAt: new Date('2026-08-16T16:00:00.001Z'),
      }),
    ).rejects.toMatchObject({ code: 'invitation-expiry-invalid' });
    await expect(
      service.issue({
        issuer: { ...issuer, role: 'member' },
        email: 'member@example.com',
        role: 'member',
        now,
        expiresAt: new Date('2026-08-10T16:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'invitation-issuer-unauthorized' });
    await expect(
      service.issue({
        issuer,
        email: 'invalid-date@example.com',
        role: 'member',
        now: new Date('invalid'),
        expiresAt: new Date('invalid'),
      }),
    ).rejects.toMatchObject({ code: 'invitation-expiry-invalid' });
    const exactExpiry = await service.issue({
      issuer,
      email: 'exact@example.com',
      role: 'member',
      now,
      expiresAt: new Date('2026-08-10T16:00:00.000Z'),
    });
    await expect(
      service.consume({
        invitationId: exactExpiry.invitation.id,
        authenticatedSessionId: 'exact-session',
        token: exactExpiry.token,
        now: new Date('2026-08-10T16:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'invitation-expired' });
    await expect(
      service.consume({
        invitationId: exactExpiry.invitation.id,
        authenticatedSessionId: 'exact-session',
        token: exactExpiry.token,
        now: new Date('invalid'),
      }),
    ).rejects.toMatchObject({ code: 'invitation-expiry-invalid' });
    await expect(
      service.issue({
        issuer: { ...issuer, activeMember: 'false' as never },
        email: 'member@example.com',
        role: 'admin' as never,
        now,
        expiresAt: new Date('2026-08-10T16:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'invitation-issuer-unauthorized' });
    await expect(
      service.consume({
        invitationId: issued.invitation.id,
        authenticatedSessionId: 'unverified-session',
        token: issued.token,
        now,
      }),
    ).rejects.toMatchObject({ code: 'invitation-invalid' });
  });
});

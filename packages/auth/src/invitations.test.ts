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

describe('InvitationService', () => {
  it('issues an email-bound seven-day invitation and stores only its hash', async () => {
    const repository = new InMemoryInvitationRepository();
    const service = new InvitationService(repository);
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
    const service = new InvitationService(new InMemoryInvitationRepository());
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
        email: 'other@example.com',
        token: issued.token,
        now,
      }),
    ).rejects.toMatchObject({ code: 'invitation-invalid' });
    await expect(
      service.consume({
        invitationId: issued.invitation.id,
        email: 'member@example.com',
        token: issued.token,
        now,
      }),
    ).resolves.toMatchObject({ consumedAt: now });
    await expect(
      service.consume({
        invitationId: issued.invitation.id,
        email: 'member@example.com',
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
        email: 'exact@example.com',
        token: exactExpiry.token,
        now: new Date('2026-08-10T16:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'invitation-expired' });
  });
});

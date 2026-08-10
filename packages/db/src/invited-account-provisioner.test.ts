import { describe, expect, it, vi } from 'vitest';

import {
  PostgresInvitedAccountProvisioner,
  type PasswordHasher,
} from './invited-account-provisioner.js';

const invitationId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001';
const householdId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004';
const tokenHash = 'a'.repeat(64);
const password = 'correct horse battery staple';

const fakeDatabase = (invitationExists = true) => {
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    void values;
    if (text.includes('emdo.provision_invited_account')) {
      return {
        rowCount: invitationExists ? 1 : 0,
        rows: invitationExists
          ? [
              {
                status: 'provisioned',
                user_id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002',
                household_id: householdId,
                role: 'member',
                email: 'member@example.com',
                email_verified: true,
              },
            ]
          : [],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect }, connect, query, release };
};

const input = {
  displayName: 'Household Member',
  email: ' MEMBER@EXAMPLE.COM ',
  invitationId,
  invitationTokenHash: tokenHash,
  now: new Date('2026-08-09T19:00:00.000Z'),
  password,
};

describe('PostgresInvitedAccountProvisioner', () => {
  it('hashes with Better Auth before calling the atomic onboarding routine', async () => {
    const database = fakeDatabase();
    const hasher: PasswordHasher = vi.fn(
      async () => 'better-auth-password-hash',
    );
    const provisioner = new PostgresInvitedAccountProvisioner(
      database.pool,
      hasher,
    );

    const result = await provisioner.provisionInvitedAccount(input);

    expect(hasher).toHaveBeenCalledWith(password);
    expect(result).toMatchObject({
      status: 'provisioned',
      email: 'member@example.com',
      emailVerified: true,
      householdId,
      role: 'member',
    });
    expect(database.query).toHaveBeenNthCalledWith(1, 'begin');
    expect(
      database.query.mock.calls.some(([text]) =>
        String(text).includes('emdo.provision_invited_account'),
      ),
    ).toBe(true);
    expect(
      database.query.mock.calls.some(([text]) =>
        /insert|update|delete/i.test(String(text)),
      ),
    ).toBe(false);
    expect(database.query).toHaveBeenCalledWith('commit');
    expect(database.release).toHaveBeenCalledOnce();

    for (const [text, values] of database.query.mock.calls) {
      expect(String(text)).not.toContain(password);
      expect(values ?? []).not.toContain(password);
    }
    expect(
      database.query.mock.calls.some(([, values]) =>
        (values ?? []).includes('better-auth-password-hash'),
      ),
    ).toBe(true);
  });

  it('rejects an expired, consumed, revoked, token-mismatched, or email-mismatched invitation without table DML', async () => {
    const database = fakeDatabase(false);
    const provisioner = new PostgresInvitedAccountProvisioner(
      database.pool,
      async () => 'constant-time-hash',
    );

    await expect(provisioner.provisionInvitedAccount(input)).resolves.toEqual({
      status: 'rejected',
    });
    expect(
      database.query.mock.calls.some(([text]) =>
        /insert|update|delete/i.test(String(text)),
      ),
    ).toBe(false);
    expect(database.query).toHaveBeenCalledWith('commit');
  });

  it('rolls back and surfaces unexpected database uniqueness failures', async () => {
    const database = fakeDatabase();
    database.query.mockImplementation(async (text: string) => {
      if (text.includes('emdo.provision_invited_account')) {
        throw Object.assign(new Error('duplicate'), { code: '23505' });
      }
      return { rowCount: 1, rows: [] };
    });
    const provisioner = new PostgresInvitedAccountProvisioner(
      database.pool,
      async () => 'better-auth-password-hash',
    );

    await expect(
      provisioner.provisionInvitedAccount(input),
    ).rejects.toMatchObject({ code: '23505' });
    expect(database.query).toHaveBeenCalledWith('rollback');
    expect(database.query).not.toHaveBeenCalledWith('commit');
  });
});

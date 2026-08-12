import { createHash } from 'node:crypto';

import { verifyPassword } from 'better-auth/crypto';
import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  PostgresInvitationRedemptionCoordinator,
  deriveInvitationPasswordHash,
  type InvitationPasswordHasher,
} from './invitation-redemption-coordinator.js';
import type {
  DatabaseClient,
  DatabaseQueryResult,
} from './scoped-repository.js';

const invitationId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001';
const userId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002';
const requestId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003';
const householdId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004';
const invitationToken = 'invitation-token-secret-0001';
const password = 'correct horse battery staple';
const passwordHash = `${'a'.repeat(32)}:${'b'.repeat(128)}`;
const input = Object.freeze({
  idempotencyKey: 'invitation-redemption:0001',
  request: Object.freeze({
    schemaVersion: 1 as const,
    displayName: ' Household Member ',
    email: ' MEMBER@EXAMPLE.COM ',
    invitationId,
    invitationToken,
    password,
  }),
  requestId,
});
const provisioned = Object.freeze({
  status: 'provisioned',
  result: Object.freeze({
    schemaVersion: 1,
    userId,
    householdId,
    role: 'member',
    emailVerified: true,
  }),
});

interface FakeClient extends DatabaseClient {
  readonly query: Mock<DatabaseClient['query']>;
  readonly release: Mock<DatabaseClient['release']>;
  readonly values: () => readonly unknown[] | undefined;
}

const databaseResult = (
  rows: readonly Record<string, unknown>[],
): DatabaseQueryResult => ({ rowCount: rows.length, rows });

const fakeClient = (options?: {
  readonly commitError?: Error;
  readonly routineRow?: Record<string, unknown>;
  readonly ready?: boolean;
}): FakeClient => {
  const release = vi.fn<DatabaseClient['release']>();
  const query = vi.fn<DatabaseClient['query']>(
    async (text: string): Promise<DatabaseQueryResult> => {
      if (text === 'commit' && options?.commitError !== undefined) {
        throw options.commitError;
      }
      if (text.includes('redeem_household_invitation')) {
        return databaseResult([options?.routineRow ?? provisioned]);
      }
      if (text.includes('invitation_redemption_ready')) {
        return databaseResult([{ ready: options?.ready ?? true }]);
      }
      return databaseResult([]);
    },
  );
  return { query, release, values: () => query.mock.calls[1]?.[1] };
};

describe('PostgresInvitationRedemptionCoordinator', () => {
  it('derives a deterministic Better Auth-compatible invitation credential', async () => {
    const invitationTokenHash = createHash('sha256')
      .update(invitationToken, 'utf8')
      .digest('hex');
    const hashInput = {
      invitationId,
      invitationTokenHash,
      password,
    };

    const first = await deriveInvitationPasswordHash(hashInput);
    const second = await deriveInvitationPasswordHash(hashInput);

    expect(second).toBe(first);
    await expect(verifyPassword({ hash: first, password })).resolves.toBe(true);
  });

  it('pre-hashes secrets and invokes one atomic durable redemption command', async () => {
    const client = fakeClient();
    const hasher: InvitationPasswordHasher = vi.fn(async () => passwordHash);
    const coordinator = new PostgresInvitationRedemptionCoordinator(
      { connect: vi.fn(async () => client) },
      hasher,
    );

    await expect(coordinator.redeem(input)).resolves.toEqual(provisioned);

    const invitationTokenHash = createHash('sha256')
      .update(invitationToken, 'utf8')
      .digest('hex');
    expect(hasher).toHaveBeenCalledWith({
      invitationId,
      invitationTokenHash,
      password,
    });
    expect(client.query).toHaveBeenNthCalledWith(1, 'begin');
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('emdo.redeem_household_invitation'),
      [
        1,
        invitationId,
        invitationTokenHash,
        'member@example.com',
        'Household Member',
        passwordHash,
        'invitation-redemption:0001',
        requestId,
      ],
    );
    expect(client.query).toHaveBeenNthCalledWith(3, 'commit');
    expect(client.release).toHaveBeenCalledWith();
    const serializedCalls = JSON.stringify(client.query.mock.calls);
    expect(serializedCalls).not.toContain(invitationToken);
    expect(serializedCalls).not.toContain(password);
  });

  it('destroys an ambiguous session and proves the exact replay once', async () => {
    const first = fakeClient({ commitError: new Error('connection lost') });
    const second = fakeClient({
      routineRow: { ...provisioned, status: 'replay' },
    });
    const connect = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const coordinator = new PostgresInvitationRedemptionCoordinator(
      { connect },
      async () => passwordHash,
    );

    await expect(coordinator.redeem(input)).resolves.toMatchObject({
      status: 'replay',
      result: provisioned.result,
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(first.release).toHaveBeenCalledWith(true);
    expect(second.release).toHaveBeenCalledWith();
    expect(first.query.mock.calls[1]?.[1]).toEqual(
      second.query.mock.calls[1]?.[1],
    );
  });

  it('fails closed when the one fresh-session readback does not match', async () => {
    const first = fakeClient({ commitError: new Error('connection lost') });
    const second = fakeClient({
      routineRow: { status: 'conflict', result: null },
    });
    const connect = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const coordinator = new PostgresInvitationRedemptionCoordinator(
      { connect },
      async () => passwordHash,
    );

    await expect(coordinator.redeem(input)).rejects.toThrow(
      'Invitation redemption readback did not match',
    );
    expect(first.release).toHaveBeenCalledWith(true);
    expect(second.query).toHaveBeenCalledWith('rollback');
  });

  it.each(['invalid', 'conflict'] as const)(
    'maps the durable %s result without a public payload',
    async (status) => {
      const client = fakeClient({ routineRow: { status, result: null } });
      const coordinator = new PostgresInvitationRedemptionCoordinator(
        { connect: vi.fn(async () => client) },
        async () => passwordHash,
      );

      await expect(coordinator.redeem(input)).resolves.toEqual({ status });
    },
  );

  it('requires the exact purpose-scoped readiness probe', async () => {
    const client = fakeClient({ ready: false });
    const coordinator = new PostgresInvitationRedemptionCoordinator(
      { connect: vi.fn(async () => client) },
      async () => passwordHash,
    );

    await expect(coordinator.checkReady()).resolves.toBe(false);
    expect(client.query).toHaveBeenCalledWith(
      'select emdo.invitation_redemption_ready() as ready',
    );
  });
});

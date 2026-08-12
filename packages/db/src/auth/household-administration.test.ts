import { createHash } from 'node:crypto';

import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  HouseholdAdministrationError,
  PostgresHouseholdAdministrationService,
} from './household-administration.js';
import type { InvitationDeliverySecretSealer } from './household-administration.js';

const ids = {
  userId: '83000000-0000-4000-8000-000000000001',
  sessionId: '83000000-0000-4000-8000-000000000002',
  requestId: '83000000-0000-4000-8000-000000000003',
  householdId: '83000000-0000-4000-8000-000000000004',
  spaceAccessGrantId: '83000000-0000-4000-8000-000000000005',
  invitationId: '83000000-0000-4000-8000-000000000006',
  membershipId: '83000000-0000-4000-8000-000000000007',
  memberUserId: '83000000-0000-4000-8000-000000000008',
};

const principal = Object.freeze({
  userId: ids.userId,
  sessionId: ids.sessionId,
  householdId: ids.householdId,
  role: 'owner' as const,
  emailVerified: true as const,
  spaceAccessGrantId: ids.spaceAccessGrantId,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('8'.repeat(64)),
});

const invitationRow = {
  schema_version: 1,
  invitation_id: ids.invitationId,
  household_id: ids.householdId,
  email: 'member@example.ca',
  role: 'member',
  state: 'pending',
  version: 1,
  created_at: new Date('2026-08-10T14:00:00.000Z'),
  expires_at: new Date('2026-08-17T14:00:00.000Z'),
  replayed: false,
  delivery_queued: true,
};

const membershipRow = {
  schema_version: 1,
  membership_id: ids.membershipId,
  household_id: ids.householdId,
  user_id: ids.memberUserId,
  email: 'member@example.ca',
  role: 'member',
  status: 'active',
  version: 2,
  joined_at: new Date('2026-08-09T14:00:00.000Z'),
  ended_at: null,
  replayed: false,
};

const validEnvelope = Object.freeze({
  schemaVersion: 1 as const,
  algorithm: 'RSA-OAEP-256' as const,
  keyId: 'invitation-delivery-2026-08',
  ciphertext: 'A'.repeat(96),
  bindingHash: 'a'.repeat(64),
});

const defaultSealer: InvitationDeliverySecretSealer = Object.freeze({
  seal: vi.fn(async () => validEnvelope),
});

const poolFor = (
  respond: (
    sql: string,
    values: readonly unknown[],
  ) => readonly Record<string, unknown>[],
) => {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => ({
    rowCount: 1,
    rows: respond(sql, values),
  }));
  const client: DatabaseClient = { query, release: vi.fn() };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query, client };
};

describe('PostgresHouseholdAdministrationService', () => {
  it('seals, zeroizes, and queues a reference-only email-bound invitation', async () => {
    let borrowedSecret: Uint8Array | undefined;
    let copiedSecret: Uint8Array | undefined;
    let capturedBinding:
      | Parameters<InvitationDeliverySecretSealer['seal']>[0]['binding']
      | undefined;
    const sealer: InvitationDeliverySecretSealer = {
      seal: vi.fn(async ({ secret, binding }) => {
        borrowedSecret = secret;
        copiedSecret = Uint8Array.from(secret);
        capturedBinding = binding;
        return validEnvelope;
      }),
    };
    const { pool, query } = poolFor((sql) =>
      sql.includes('issue_household_invitation') ? [invitationRow] : [],
    );
    const service = new PostgresHouseholdAdministrationService(pool, sealer);

    const result = await service.issueInvitation({
      email: ' Member@Example.ca ',
      role: 'member',
      expiresInSeconds: 604_800,
      principal,
      requestId: ids.requestId,
      idempotencyKey: 'household-invitation:0001',
    });

    expect(result).toEqual({
      schemaVersion: 1,
      invitation: {
        id: ids.invitationId,
        email: 'member@example.ca',
        role: 'member',
        status: 'pending',
        version: 1,
        createdAt: '2026-08-10T14:00:00.000Z',
        expiresAt: '2026-08-17T14:00:00.000Z',
        deliveryStatus: 'queued',
      },
      replayed: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/token|hash|ciphertext/iu);

    expect(copiedSecret).toBeInstanceOf(Uint8Array);
    const token = new TextDecoder().decode(copiedSecret);
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    expect(borrowedSecret).toBeDefined();
    expect([...borrowedSecret!]).toEqual(
      Array.from({ length: borrowedSecret!.byteLength }, () => 0),
    );
    expect(capturedBinding).toMatchObject({
      invitationId: expect.stringMatching(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
      ),
      recipient: 'member@example.ca',
      role: 'member',
      tokenHash,
      templateVersion: 'invitation-redemption.v1',
    });

    const call = query.mock.calls.find(([sql]) =>
      sql.includes('issue_household_invitation'),
    );
    expect(call?.[1]).toHaveLength(12);
    expect(call?.[1]?.slice(0, 6)).toEqual([
      'member@example.ca',
      'member',
      604_800,
      tokenHash,
      'household-invitation:0001',
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    ]);
    expect(call?.[1]?.[6]).toBe(capturedBinding?.invitationId);
    expect(call?.[1]?.[7]).toBe(`invitation:${capturedBinding?.invitationId}`);
    expect(call?.[1]?.[8]).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    );
    expect(call?.[1]?.slice(9)).toEqual([
      'invitation-redemption.v1',
      validEnvelope,
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    ]);
    expect(JSON.stringify(query.mock.calls)).not.toContain(token);
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes("set_config('emdo.user_id'"),
      )?.[1],
    ).toEqual([ids.userId, ids.sessionId, ids.requestId]);
  });

  it('rejects a malformed delivery envelope after zeroizing the borrowed secret', async () => {
    let borrowedSecret: Uint8Array | undefined;
    const { pool, query } = poolFor(() => []);
    const service = new PostgresHouseholdAdministrationService(pool, {
      seal: async ({ secret }) => {
        borrowedSecret = secret;
        return { ...validEnvelope, unexpected: 'not-allowed' };
      },
    });

    await expect(
      service.issueInvitation({
        email: 'member@example.ca',
        role: 'member',
        expiresInSeconds: 3600,
        principal,
        requestId: ids.requestId,
        idempotencyKey: 'household-invitation:0002',
      }),
    ).rejects.toMatchObject({ code: 'invalid-result' });

    expect(borrowedSecret).toBeDefined();
    expect([...borrowedSecret!].every((value) => value === 0)).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('redacts a sealer failure that tries to expose the invitation token', async () => {
    let borrowedSecret: Uint8Array | undefined;
    let exposedToken = '';
    const { pool, query } = poolFor(() => []);
    const service = new PostgresHouseholdAdministrationService(pool, {
      seal: async ({ secret }) => {
        borrowedSecret = secret;
        exposedToken = new TextDecoder().decode(secret);
        throw new Error(`provider failed for ${exposedToken}`);
      },
    });

    const failure = await service
      .issueInvitation({
        email: 'member@example.ca',
        role: 'member',
        expiresInSeconds: 3600,
        principal,
        requestId: ids.requestId,
        idempotencyKey: 'household-invitation:sealer-failure',
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'invalid-result',
      message: 'Invitation delivery sealer failed',
    });
    expect(String(failure)).not.toContain(exposedToken);
    expect([...borrowedSecret!].every((value) => value === 0)).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('narrows issuance to a queued pending invitation', async () => {
    const { pool } = poolFor((sql) =>
      sql.includes('issue_household_invitation')
        ? [{ ...invitationRow, state: 'consumed' }]
        : [],
    );

    await expect(
      new PostgresHouseholdAdministrationService(
        pool,
        defaultSealer,
      ).issueInvitation({
        email: 'member@example.ca',
        role: 'member',
        expiresInSeconds: 3600,
        principal,
        requestId: ids.requestId,
        idempotencyKey: 'household-invitation:0003',
      }),
    ).rejects.toMatchObject({ code: 'invalid-result' });
  });

  it('lists only safe invitation metadata in the server-derived household', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('list_household_invitations')
        ? [
            invitationRow,
            {
              ...invitationRow,
              invitation_id: '83000000-0000-4000-8000-000000000009',
              state: 'expired',
              delivery_queued: false,
            },
          ]
        : [],
    );

    await expect(
      new PostgresHouseholdAdministrationService(
        pool,
        defaultSealer,
      ).listInvitations({
        principal,
        requestId: ids.requestId,
      }),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      invitations: [
        { id: ids.invitationId, status: 'pending' },
        { status: 'expired' },
      ],
    });
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes('list_household_invitations'),
      )?.[1],
    ).toEqual([]);
  });

  it('revokes by the exact next version and preserves durable replay', async () => {
    const revoked = {
      ...invitationRow,
      state: 'revoked',
      version: 2,
      replayed: true,
      delivery_queued: false,
    };
    const { pool, query } = poolFor((sql) =>
      sql.includes('revoke_household_invitation') ? [revoked] : [],
    );

    await expect(
      new PostgresHouseholdAdministrationService(
        pool,
        defaultSealer,
      ).revokeInvitation({
        invitationId: ids.invitationId,
        expectedVersion: 1,
        principal,
        requestId: ids.requestId,
        idempotencyKey: 'household-invitation-revoke:0001',
      }),
    ).resolves.toMatchObject({
      invitation: { id: ids.invitationId, status: 'revoked', version: 2 },
      replayed: true,
    });
    const call = query.mock.calls.find(([sql]) =>
      sql.includes('revoke_household_invitation'),
    );
    expect(call?.[1]).toEqual([
      ids.invitationId,
      1,
      'household-invitation-revoke:0001',
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    ]);
  });

  it('rejects a revocation receipt that skipped the expected version', async () => {
    const { pool } = poolFor((sql) =>
      sql.includes('revoke_household_invitation')
        ? [{ ...invitationRow, state: 'revoked', version: 3 }]
        : [],
    );

    await expect(
      new PostgresHouseholdAdministrationService(
        pool,
        defaultSealer,
      ).revokeInvitation({
        invitationId: ids.invitationId,
        expectedVersion: 1,
        principal,
        requestId: ids.requestId,
        idempotencyKey: 'household-invitation-revoke:0002',
      }),
    ).rejects.toMatchObject({ code: 'invalid-result' });
  });

  it('administers role and deactivation using exact membership versions', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('list_household_memberships')
        ? [membershipRow]
        : sql.includes('change_household_membership_role')
          ? [{ ...membershipRow, role: 'owner', version: 3 }]
          : sql.includes('deactivate_household_membership')
            ? [
                {
                  ...membershipRow,
                  status: 'inactive',
                  version: 3,
                  ended_at: new Date('2026-08-10T14:05:00.000Z'),
                },
              ]
            : [],
    );
    const service = new PostgresHouseholdAdministrationService(
      pool,
      defaultSealer,
    );

    await expect(
      service.listMemberships({ principal, requestId: ids.requestId }),
    ).resolves.toMatchObject({
      memberships: [{ id: ids.membershipId, version: 2, role: 'member' }],
    });
    await expect(
      service.changeMembershipRole({
        membershipId: ids.membershipId,
        expectedVersion: 2,
        role: 'owner',
        principal,
        requestId: ids.requestId,
        idempotencyKey: 'household-membership-role:0001',
      }),
    ).resolves.toMatchObject({
      membership: {
        id: ids.membershipId,
        version: 3,
        role: 'owner',
        status: 'active',
      },
    });
    await expect(
      service.deactivateMembership({
        membershipId: ids.membershipId,
        expectedVersion: 2,
        principal,
        requestId: ids.requestId,
        idempotencyKey: 'household-membership-deactivate:0001',
      }),
    ).resolves.toMatchObject({
      membership: {
        id: ids.membershipId,
        version: 3,
        status: 'inactive',
        endedAt: '2026-08-10T14:05:00.000Z',
      },
    });

    expect(
      query.mock.calls
        .find(([sql]) => sql.includes('change_household_membership_role'))?.[1]
        ?.slice(0, 4),
    ).toEqual([ids.membershipId, 2, 'owner', 'household-membership-role:0001']);
    expect(
      query.mock.calls
        .find(([sql]) => sql.includes('deactivate_household_membership'))?.[1]
        ?.slice(0, 3),
    ).toEqual([ids.membershipId, 2, 'household-membership-deactivate:0001']);
  });

  it.each([
    [
      'role change with an inactive receipt',
      'change' as const,
      { ...membershipRow, status: 'inactive', version: 3 },
    ],
    [
      'role change with a skipped version',
      'change' as const,
      { ...membershipRow, role: 'owner', version: 4 },
    ],
    [
      'deactivation with no end time',
      'deactivate' as const,
      { ...membershipRow, status: 'inactive', version: 3, ended_at: null },
    ],
    [
      'deactivation with a skipped version',
      'deactivate' as const,
      {
        ...membershipRow,
        status: 'inactive',
        version: 4,
        ended_at: new Date('2026-08-10T14:05:00.000Z'),
      },
    ],
  ])('rejects %s', async (_label, operation, row) => {
    const { pool } = poolFor((sql) =>
      sql.includes(
        operation === 'change'
          ? 'change_household_membership_role'
          : 'deactivate_household_membership',
      )
        ? [row]
        : [],
    );
    const service = new PostgresHouseholdAdministrationService(
      pool,
      defaultSealer,
    );

    const result =
      operation === 'change'
        ? service.changeMembershipRole({
            membershipId: ids.membershipId,
            expectedVersion: 2,
            role: 'owner',
            principal,
            requestId: ids.requestId,
            idempotencyKey: 'household-membership-role:invalid-result',
          })
        : service.deactivateMembership({
            membershipId: ids.membershipId,
            expectedVersion: 2,
            principal,
            requestId: ids.requestId,
            idempotencyKey: 'household-membership-deactivate:invalid-result',
          });

    await expect(result).rejects.toMatchObject({ code: 'invalid-result' });
  });

  it('fails closed before SQL for non-owner or malformed authority', async () => {
    const { pool, query } = poolFor(() => []);
    const service = new PostgresHouseholdAdministrationService(
      pool,
      defaultSealer,
    );

    await expect(
      service.listMemberships({
        principal: { ...principal, role: 'member' },
        requestId: ids.requestId,
      }),
    ).rejects.toBeInstanceOf(HouseholdAdministrationError);
    await expect(
      service.issueInvitation({
        email: 'member@example.ca',
        role: 'member',
        expiresInSeconds: 604_801,
        principal,
        requestId: ids.requestId,
        idempotencyKey: 'household-invitation:0001',
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(query).not.toHaveBeenCalled();
  });

  it('maps the exact durable authorization revocation sentinel on read paths', async () => {
    const { pool } = poolFor((sql) => {
      if (sql.includes('list_household_memberships')) {
        throw new Error('EMDO:authorization-revoked');
      }
      return [];
    });

    await expect(
      new PostgresHouseholdAdministrationService(
        pool,
        defaultSealer,
      ).listMemberships({ principal, requestId: ids.requestId }),
    ).rejects.toMatchObject({ code: 'authorization-revoked' });
  });

  it('returns safe authorization and conflict errors for mutation failures', async () => {
    const { pool } = poolFor((sql) => {
      if (sql.includes('change_household_membership_role')) {
        throw new Error('EMDO:authorization-revoked');
      }
      return [];
    });
    const service = new PostgresHouseholdAdministrationService(
      pool,
      defaultSealer,
    );

    await expect(
      service.changeMembershipRole({
        membershipId: ids.membershipId,
        expectedVersion: 2,
        role: 'owner',
        principal,
        requestId: ids.requestId,
        idempotencyKey: 'household-membership-role:authorization',
      }),
    ).rejects.toMatchObject({ code: 'authorization-revoked' });

    const empty = poolFor(() => []);
    await expect(
      new PostgresHouseholdAdministrationService(
        empty.pool,
        defaultSealer,
      ).revokeInvitation({
        invitationId: ids.invitationId,
        expectedVersion: 1,
        principal,
        requestId: ids.requestId,
        idempotencyKey: 'household-invitation-revoke:0001',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const durableConflict = poolFor((sql) => {
      if (sql.includes('revoke_household_invitation')) {
        throw new Error('EMDO:administration-conflict');
      }
      return [];
    });
    await expect(
      new PostgresHouseholdAdministrationService(
        durableConflict.pool,
        defaultSealer,
      ).revokeInvitation({
        invitationId: ids.invitationId,
        expectedVersion: 1,
        principal,
        requestId: ids.requestId,
        idempotencyKey: 'household-invitation-revoke:durable-conflict',
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: 'Household administration conflicted with durable state',
    });
  });

  it('reports ready only for the exact household-administration capability row', async () => {
    const { pool, query, client } = poolFor((sql) =>
      sql.includes('household_administration_ready') ? [{ ready: true }] : [],
    );

    await expect(
      new PostgresHouseholdAdministrationService(
        pool,
        defaultSealer,
      ).checkReady(),
    ).resolves.toBe(true);
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes('household_administration_ready'),
      )?.[1],
    ).toEqual([]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing row', []],
    ['wrong type', [{ ready: 'true' }]],
    ['unexpected fields', [{ ready: true, broadDatabaseReady: true }]],
  ])(
    'reports unavailable for a malformed readiness result: %s',
    async (_label, rows) => {
      const { pool } = poolFor((sql) =>
        sql.includes('household_administration_ready') ? rows : [],
      );

      await expect(
        new PostgresHouseholdAdministrationService(
          pool,
          defaultSealer,
        ).checkReady(),
      ).resolves.toBe(false);
    },
  );

  it('reports unavailable and releases the client when readiness throws', async () => {
    const { pool, client } = poolFor((sql) => {
      if (sql.includes('household_administration_ready')) {
        throw new Error('routine unavailable');
      }
      return [];
    });

    await expect(
      new PostgresHouseholdAdministrationService(
        pool,
        defaultSealer,
      ).checkReady(),
    ).resolves.toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('reports unavailable when the readiness client cannot be released', async () => {
    const { pool, client } = poolFor((sql) =>
      sql.includes('household_administration_ready') ? [{ ready: true }] : [],
    );
    client.release = vi.fn(() => {
      throw new Error('release failed');
    });

    await expect(
      new PostgresHouseholdAdministrationService(
        pool,
        defaultSealer,
      ).checkReady(),
    ).resolves.toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import { PostgresSpaceAccessGrantService } from './space-access-grants.js';

const ids = {
  userId: '81000000-0000-4000-8000-000000000001',
  sessionId: '81000000-0000-4000-8000-000000000002',
  requestId: '81000000-0000-4000-8000-000000000003',
  householdId: '81000000-0000-4000-8000-000000000004',
  membershipId: '81000000-0000-4000-8000-000000000005',
  grantId: '81000000-0000-4000-8000-000000000006',
  privateSpaceId: '81000000-0000-4000-8000-000000000007',
  sharedSpaceId: '81000000-0000-4000-8000-000000000008',
};
const collectionAuthorizationScopeFingerprint = 'a'.repeat(64);

const grantRow = {
  schema_version: 1,
  version: 1,
  grant_id: ids.grantId,
  household_id: ids.householdId,
  original_owner_user_id: ids.userId,
  session_id: ids.sessionId,
  request_id: ids.requestId,
  membership_id: ids.membershipId,
  role: 'member',
  private_space_id: ids.privateSpaceId,
  writable_space_ids: [ids.privateSpaceId, ids.sharedSpaceId],
  issued_at: new Date('2026-08-10T12:00:00.000Z'),
  expires_at: new Date('2026-08-10T12:15:00.000Z'),
};

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

describe('PostgresSpaceAccessGrantService', () => {
  it('issues an opaque request-current grant and DB-derived collection scope', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('issue_active_principal_scope')
        ? [
            {
              user_id: ids.userId,
              session_id: ids.sessionId,
              request_id: ids.requestId,
              household_id: ids.householdId,
              membership_id: ids.membershipId,
              role: 'member',
              email_verified: true,
              space_access_grant_id: ids.grantId,
              collection_authorization_scope_fingerprint:
                collectionAuthorizationScopeFingerprint,
            },
          ]
        : [],
    );

    await expect(
      new PostgresSpaceAccessGrantService(pool).resolveActivePrincipalScope({
        activeMembershipId: ids.membershipId,
        householdId: ids.householdId,
        requestId: ids.requestId,
        role: 'member',
        sessionId: ids.sessionId,
        userId: ids.userId,
      }),
    ).resolves.toEqual({
      collectionAuthorizationScopeFingerprint,
      emailVerified: true,
      householdId: ids.householdId,
      membershipId: ids.membershipId,
      requestId: ids.requestId,
      role: 'member',
      sessionId: ids.sessionId,
      spaceAccessGrantId: ids.grantId,
      userId: ids.userId,
    });
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes('issue_active_principal_scope'),
      )?.[1],
    ).toEqual([ids.householdId, ids.membershipId, 'member']);
  });

  it('fails closed when the canonical membership cannot issue a grant', async () => {
    const { pool } = poolFor(() => []);

    await expect(
      new PostgresSpaceAccessGrantService(pool).resolveActivePrincipalScope({
        activeMembershipId: ids.membershipId,
        householdId: ids.householdId,
        requestId: ids.requestId,
        role: 'owner',
        sessionId: ids.sessionId,
        userId: ids.userId,
      }),
    ).rejects.toMatchObject({
      code: 'authorization-revoked',
    });
  });

  it('verifies exact request, session, tenant, and requested-space binding', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('resolve_space_access_grant') ? [grantRow] : [],
    );

    await expect(
      new PostgresSpaceAccessGrantService(pool).verify({
        grantId: ids.grantId,
        householdId: ids.householdId,
        requestId: ids.requestId,
        sessionId: ids.sessionId,
        spaceId: ids.sharedSpaceId,
        userId: ids.userId,
      }),
    ).resolves.toMatchObject({
      grantId: ids.grantId,
      privateSpaceId: ids.privateSpaceId,
      writableSpaceIds: [ids.privateSpaceId, ids.sharedSpaceId],
    });
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes('resolve_space_access_grant'),
      )?.[1],
    ).toEqual([
      ids.grantId,
      ids.householdId,
      ids.userId,
      ids.sessionId,
      ids.requestId,
      ids.sharedSpaceId,
    ]);
  });

  it('rejects malformed or unbound database results', async () => {
    const { pool } = poolFor((sql) =>
      sql.includes('resolve_space_access_grant')
        ? [
            {
              ...grantRow,
              writable_space_ids: [ids.sharedSpaceId, ids.sharedSpaceId],
            },
          ]
        : [],
    );

    await expect(
      new PostgresSpaceAccessGrantService(pool).verify({
        grantId: ids.grantId,
        householdId: ids.householdId,
        requestId: ids.requestId,
        sessionId: ids.sessionId,
        spaceId: ids.sharedSpaceId,
        userId: ids.userId,
      }),
    ).rejects.toMatchObject({
      code: 'invalid-result',
    });
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  PostgresEncryptedGoogleCalendarGrantStore,
  PostgresGoogleCalendarProviderAuthorityResolver,
  PostgresGoogleOAuthAuthorizationEpochStore,
  PostgresGoogleOAuthFlowStore,
  PostgresGoogleOAuthGrantLease,
} from './oauth-persistence.js';

const actor = {
  userId: '70000000-0000-4000-8000-000000000001',
  householdId: '70000000-0000-4000-8000-000000000002',
  privateSpaceId: '70000000-0000-4000-8000-000000000003',
  sessionId: '70000000-0000-4000-8000-000000000004',
};
const principal = {
  userId: actor.userId,
  householdId: actor.householdId,
  sessionId: actor.sessionId,
  requestId: '70000000-0000-4000-8000-000000000005',
};

const poolFor = (
  respond: (
    sql: string,
    values: readonly unknown[],
  ) => readonly Record<string, unknown>[],
) => {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => ({
    rowCount: sql.startsWith('delete') ? 1 : 1,
    rows: respond(sql, values),
  }));
  const client: DatabaseClient = { query, release: vi.fn() };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query, client };
};

describe('durable Google OAuth persistence', () => {
  it('inserts each PKCE flow binding column exactly once', async () => {
    const { pool, query } = poolFor((sql, values) => {
      if (sql.includes('lock_active_request_scope')) {
        return [{ authorized: true }];
      }
      if (sql.includes('insert into emdo.google_oauth_flows')) {
        return [{ id: values[0] }];
      }
      return [];
    });
    const flowId = 'a'.repeat(43);

    await expect(
      new PostgresGoogleOAuthFlowStore(pool).put({
        id: flowId,
        actor,
        redirectUri: 'https://example.test/oauth/callback',
        purpose: 'calendar-event-write',
        requestedScopes: ['https://www.googleapis.com/auth/calendar.events'],
        credentialRevisionAtStart: 2,
        authorizationEpochAtStart: 3,
        codeVerifier: 'b'.repeat(43),
        createdAt: new Date('2026-08-10T12:00:00.000Z'),
        expiresAt: new Date('2026-08-10T12:10:00.000Z'),
      }),
    ).resolves.toBe(true);

    const insert = query.mock.calls.find(([sql]) =>
      sql.includes('insert into emdo.google_oauth_flows'),
    );
    expect(insert).toBeDefined();
    const normalized = insert![0].toLowerCase();
    expect(normalized.match(/credential_revision_at_start/gu)).toHaveLength(1);
    expect(normalized.match(/authorization_epoch_at_start/gu)).toHaveLength(1);
    expect(insert![1]).toHaveLength(13);
  });

  it('atomically consumes an exact actor-bound PKCE flow through the narrow function', async () => {
    const createdAt = new Date('2026-08-10T12:00:00.000Z');
    const expiresAt = new Date('2026-08-10T12:10:00.000Z');
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('consume_google_oauth_flow')) {
        return [
          {
            status: 'consumed',
            flow: {
              id: 'a'.repeat(43),
              household_id: actor.householdId,
              private_space_id: actor.privateSpaceId,
              original_owner_user_id: actor.userId,
              session_id: actor.sessionId,
              redirect_uri: 'https://example.test/oauth/callback',
              purpose: 'calendar-read',
              requested_scopes: [
                'https://www.googleapis.com/auth/calendar.freebusy',
              ],
              credential_revision_at_start: null,
              authorization_epoch_at_start: 0,
              code_verifier: 'b'.repeat(43),
              created_at: createdAt,
              expires_at: expiresAt,
            },
          },
        ];
      }
      return [];
    });

    await expect(
      new PostgresGoogleOAuthFlowStore(pool).consume({
        id: 'a'.repeat(43),
        actor,
      }),
    ).resolves.toMatchObject({ status: 'consumed', flow: { actor } });
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('consume_google_oauth_flow'),
      ),
    ).toBe(true);
  });

  it('invalidates pending flows with the SQL function exact user-household-space binding', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('invalidate_google_oauth_flows'))
        return [{ deleted: 2 }];
      return [];
    });

    await expect(
      new PostgresGoogleOAuthFlowStore(pool).invalidateActor(actor),
    ).resolves.toBe(2);
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes('invalidate_google_oauth_flows'),
      )?.[1],
    ).toEqual([actor.userId, actor.householdId, actor.privateSpaceId]);
  });

  it('advances the durable authorization epoch with compare-and-set semantics', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('advance_google_oauth_authorization_epoch')) {
        return [{ authorization_epoch: 4 }];
      }
      return [];
    });

    await expect(
      new PostgresGoogleOAuthAuthorizationEpochStore(pool).advance({
        actor,
        expectedEpoch: 3,
      }),
    ).resolves.toEqual({ status: 'advanced', authorizationEpoch: 4 });
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes('advance_google_oauth_authorization_epoch'),
      ),
    ).toBeDefined();
  });

  it('stores only encrypted Calendar grant payload through exact revision CAS', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('compare_and_set_encrypted_google_calendar_grant')) {
        return [{ revision: 2 }];
      }
      return [];
    });
    const store = new PostgresEncryptedGoogleCalendarGrantStore(
      pool,
      principal,
    );
    const payload = {
      algorithm: 'aes-256-gcm' as const,
      aadVersion: 1 as const,
      ciphertext: 'ciphertext',
      nonce: 'nonce',
      authenticationTag: 'tag',
      wrappedKey: 'wrapped',
      keyVersion: 'k1',
    };

    await expect(
      store.compareAndSet({
        scope: {
          householdId: actor.householdId,
          spaceId: actor.privateSpaceId,
          recordId: `google-calendar-oauth-v1-${'a'.repeat(64)}`,
          provider: 'google',
          grantType: 'calendar-authorization',
        },
        ownerUserId: actor.userId,
        expectedRevision: 1,
        authorizationEpoch: 3,
        providerGrantReference: 'gcal-grant-reference-current',
        payload,
        now: new Date(),
      }),
    ).resolves.toEqual({ status: 'stored', revision: 2 });
    const serialized = JSON.stringify(query.mock.calls);
    expect(serialized).toContain('gcal-grant-reference-current');
    expect(serialized).toContain(
      'compare_and_set_encrypted_google_calendar_grant',
    );
    expect(serialized).toContain('ciphertext');
    expect(serialized).not.toMatch(/access[_-]?token|refresh[_-]?token/i);
  });

  it('rejects provider grant references that the database constraint rejects', async () => {
    const { pool, query } = poolFor(() => []);
    const store = new PostgresEncryptedGoogleCalendarGrantStore(
      pool,
      principal,
    );

    await expect(
      store.compareAndSet({
        scope: {
          householdId: actor.householdId,
          spaceId: actor.privateSpaceId,
          recordId: `google-calendar-oauth-v1-${'a'.repeat(64)}`,
          provider: 'google',
          grantType: 'calendar-authorization',
        },
        ownerUserId: actor.userId,
        expectedRevision: null,
        authorizationEpoch: 0,
        providerGrantReference: 'gcal-grant-reference\u0000poison',
        payload: {
          algorithm: 'aes-256-gcm',
          aadVersion: 1,
          ciphertext: 'ciphertext',
          nonce: 'nonce',
          authenticationTag: 'tag',
          wrappedKey: 'wrapped',
          keyVersion: 'k1',
        },
        now: new Date('2026-08-10T12:00:00.000Z'),
      }),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('loads and advances authorization epochs only through narrow database functions', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('load_google_oauth_authorization_epoch')) {
        return [{ authorization_epoch: 3 }];
      }
      if (sql.includes('advance_google_oauth_authorization_epoch')) {
        return [{ authorization_epoch: 4 }];
      }
      return [];
    });
    const store = new PostgresGoogleOAuthAuthorizationEpochStore(pool);

    await expect(store.load(actor)).resolves.toBe(3);
    await expect(store.advance({ actor, expectedEpoch: 3 })).resolves.toEqual({
      status: 'advanced',
      authorizationEpoch: 4,
    });

    const statements = query.mock.calls.map(([sql]) => sql).join('\n');
    expect(statements).toContain('load_google_oauth_authorization_epoch');
    expect(statements).toContain('advance_google_oauth_authorization_epoch');
    expect(statements).not.toContain(
      'insert into emdo.google_oauth_authorization_epochs',
    );
  });

  it('resolves only the current request-bound non-secret provider authority', async () => {
    const spaceAccessGrantId = '70000000-0000-4000-8000-000000000006';
    const authorizationScopeFingerprint = 'b'.repeat(64);
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('resolve_current_google_calendar_authority')) {
        return [
          {
            household_id: actor.householdId,
            private_space_id: actor.privateSpaceId,
            request_id: principal.requestId,
            session_id: principal.sessionId,
            user_id: principal.userId,
            space_access_grant_id: spaceAccessGrantId,
            authorization_scope_fingerprint: authorizationScopeFingerprint,
            provider_grant_reference: 'gcal-grant-reference-current',
            authorization_epoch: 4,
          },
        ];
      }
      return [];
    });
    const resolver = new PostgresGoogleCalendarProviderAuthorityResolver(
      pool,
      principal,
    );
    const input = {
      requestId: principal.requestId,
      runId: '70000000-0000-4000-8000-000000000007',
      sessionId: principal.sessionId,
      userId: actor.userId,
      householdId: actor.householdId,
      agentId: 'scheduler',
      spaceAccessGrantId,
      disclosureGrantId: '70000000-0000-4000-8000-000000000008',
      decisionId: '70000000-0000-4000-8000-000000000009',
      capabilityId: 'google-calendar.event.create',
      capabilityFingerprint: 'a'.repeat(64),
    };

    await expect(resolver.resolve(input)).resolves.toEqual({
      authorityBinding: {
        kind: 'google-calendar-grant-v2',
        householdId: actor.householdId,
        privateSpaceId: actor.privateSpaceId,
        authorizationScopeFingerprint,
        providerGrantReference: 'gcal-grant-reference-current',
        authorizationEpoch: 4,
      },
      operationScope: {
        requestId: principal.requestId,
        sessionId: principal.sessionId,
        householdId: actor.householdId,
        userId: principal.userId,
        spaceAccessGrantId,
        authorizationScopeFingerprint,
      },
    });
    await expect(
      resolver.resolve({ ...input, requestId: actor.sessionId }),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolve({ ...input, sessionId: principal.requestId }),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolve({ ...input, householdId: actor.privateSpaceId }),
    ).resolves.toBeUndefined();
    expect(
      query.mock.calls.filter(([sql]) =>
        sql.includes('resolve_current_google_calendar_authority'),
      ),
    ).toHaveLength(1);
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes('resolve_current_google_calendar_authority'),
      )?.[1],
    ).toEqual([spaceAccessGrantId, input.runId]);
  });

  it('holds and releases one session advisory lease around provider I/O', async () => {
    const { pool, query, client } = poolFor((sql) =>
      sql.includes('lock_active_request_scope') ? [{ authorized: true }] : [],
    );
    const operation = vi.fn(async () => 'done');

    await expect(
      new PostgresGoogleOAuthGrantLease(pool).runExclusive(actor, operation),
    ).resolves.toBe('done');
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(
      statements.findIndex((sql) => sql.includes('pg_advisory_lock')),
    ).toBeLessThan(
      statements.findIndex((sql) => sql.includes('pg_advisory_unlock')),
    );
    expect(operation).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledOnce();
  });
});

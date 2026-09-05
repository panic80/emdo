import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresSpaceAccessGrantService } from '../auth/space-access-grants.js';
import { createDatabaseClient, type EmdoDatabaseClient } from '../client.js';
import { loadOrderedMigrations } from '../migrations.js';
import {
  PostgresEncryptedGoogleCalendarGrantStore,
  PostgresGoogleCalendarProviderAuthorityResolver,
  PostgresGoogleOAuthAuthorizationEpochStore,
  PostgresGoogleOAuthDisconnectOperationStore,
  PostgresGoogleOAuthFlowStore,
  checkPostgresGoogleOAuthRuntimeReadiness,
} from './oauth-persistence.js';

const databaseUrl = process.env.TEST_GOOGLE_OAUTH_AUTHORITY_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const ids = {
  user: '83900000-0000-4000-8000-000000000001',
  session: '83900000-0000-4000-8000-000000000002',
  request: '83900000-0000-4000-8000-000000000003',
  retryRequest: '83900000-0000-4000-8000-00000000000a',
  retrySession: '83900000-0000-4000-8000-00000000000b',
  household: '83900000-0000-4000-8000-000000000004',
  membership: '83900000-0000-4000-8000-000000000005',
  space: '83900000-0000-4000-8000-000000000006',
  run: '83900000-0000-4000-8000-000000000007',
  disclosureGrant: '83900000-0000-4000-8000-000000000008',
  decision: '83900000-0000-4000-8000-000000000009',
};
const principal = {
  userId: ids.user,
  sessionId: ids.session,
  requestId: ids.request,
  householdId: ids.household,
};
const requestAuthority = {
  ...principal,
  privateSpaceId: ids.space,
};
const actor = {
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  privateSpaceId: ids.space,
};
const loginRole = 'emdo_api_login';
const loginPassword = `emdo-test-${randomUUID()}`;
const reconciliationLogin = 'emdo_google_oauth_disconnect_reconciliation_login';
const reconciliationPassword = `emdo-reconciliation-${randomUUID()}`;
const retentionLogin = 'emdo_google_oauth_disconnect_retention_login';
const retentionPassword = `emdo-retention-${randomUUID()}`;
const providerReferenceA = 'gcal-provider-reference-integration-a';
const providerReferenceB = 'gcal-provider-reference-integration-b';
const payload = {
  algorithm: 'aes-256-gcm' as const,
  aadVersion: 1 as const,
  ciphertext: Buffer.from('encrypted-calendar-token').toString('base64url'),
  nonce: Buffer.alloc(12, 1).toString('base64url'),
  authenticationTag: Buffer.alloc(16, 2).toString('base64url'),
  wrappedKey: Buffer.alloc(60, 3).toString('base64url'),
  keyVersion: 'oauth-integration-key-v1',
};

const hashAuthority = (input: {
  readonly authorizationEpoch: number;
  readonly authorizationScopeFingerprint: string;
  readonly householdId: string;
  readonly privateSpaceId: string;
  readonly providerGrantReference: string;
}) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        authorizationEpoch: input.authorizationEpoch,
        authorizationScopeFingerprint: input.authorizationScopeFingerprint,
        householdId: input.householdId,
        kind: 'google-calendar-grant-v2',
        privateSpaceId: input.privateSpaceId,
        providerGrantReference: input.providerGrantReference,
      }),
    )
    .digest('hex');

describeDatabase(
  'PostgreSQL 18 Google Calendar authority binding (isolated canonical database only)',
  () => {
    let admin: import('pg').Client;
    let reconciliation: import('pg').Pool;
    let retention: import('pg').Pool;
    let runtime: EmdoDatabaseClient;
    let spaceAccessGrantId: string;

    beforeAll(async () => {
      const { Client } = await import('pg');
      expect(new URL(databaseUrl!).pathname).toBe('/emdo_app');
      admin = new Client({ connectionString: databaseUrl });
      await admin.connect();
      const existingSchema = await admin.query(
        `select 1 from pg_catalog.pg_namespace where nspname = 'emdo'`,
      );
      if (existingSchema.rowCount !== 0) {
        throw new Error(
          'TEST_GOOGLE_OAUTH_AUTHORITY_DATABASE_URL must use an isolated empty database',
        );
      }
      for (const migration of await loadOrderedMigrations()) {
        await admin.query(migration.sql);
      }
      await admin.query(
        `insert into emdo.auth_users(id, name, email, email_verified)
         values ($1, 'OAuth User', 'oauth-authority@example.test', true)`,
        [ids.user],
      );
      await admin.query(
        `insert into emdo.households(id, name, slug, created_by_user_id)
         values ($1, 'OAuth Household', 'oauth-authority', $2)`,
        [ids.household, ids.user],
      );
      await admin.query(
        `insert into emdo.household_memberships(
           id, household_id, user_id, role, status, joined_at
         ) values ($1, $2, $3, 'owner', 'active', pg_catalog.clock_timestamp())`,
        [ids.membership, ids.household, ids.user],
      );
      await admin.query(
        `insert into emdo.spaces(
           id, household_id, original_owner_user_id, name, visibility
         ) values ($1, $2, $3, 'Private Calendar', 'private')`,
        [ids.space, ids.household, ids.user],
      );
      await admin.query(
        `insert into emdo.auth_sessions(
           id, user_id, token, expires_at, active_household_id
         ) values
           ($1, $3, 'oauth-authority-token',
            pg_catalog.clock_timestamp() + interval '1 hour', $4),
           ($2, $3, 'oauth-authority-retry-token',
            pg_catalog.clock_timestamp() + interval '1 hour', $4)`,
        [ids.session, ids.retrySession, ids.user, ids.household],
      );
      await admin.query(
        `insert into emdo.agent_runs(
           id, household_id, space_id, original_owner_user_id, agent_id,
           agent_version, requested_model, status
         ) values ($1, $2, $3, $4, 'scheduler', '1.0.0', 'gpt-test', 'running')`,
        [ids.run, ids.household, ids.space, ids.user],
      );
      await admin.query(`drop role if exists ${loginRole}`);
      await admin.query(
        `create role ${loginRole} login nosuperuser nocreatedb nocreaterole inherit nobypassrls noreplication password '${loginPassword}'`,
      );
      await admin.query(`grant emdo_app to ${loginRole}`);
      await admin.query('revoke connect on database emdo_app from public');
      await admin.query(`grant connect on database emdo_app to ${loginRole}`);
      await admin.query(
        `alter role ${reconciliationLogin} login password '${reconciliationPassword}'`,
      );
      await admin.query(
        `grant connect on database emdo_app to ${reconciliationLogin}`,
      );
      await admin.query(
        `alter role ${retentionLogin} login password '${retentionPassword}'`,
      );
      await admin.query(
        `grant connect on database emdo_app to ${retentionLogin}`,
      );
      const runtimeUrl = new URL(databaseUrl!);
      runtimeUrl.username = loginRole;
      runtimeUrl.password = loginPassword;
      runtime = createDatabaseClient({
        connectionString: runtimeUrl.toString(),
        applicationName: 'emdo-oauth-authority-integration',
      });
      const reconciliationUrl = new URL(databaseUrl!);
      reconciliationUrl.username = reconciliationLogin;
      reconciliationUrl.password = reconciliationPassword;
      const { Pool } = await import('pg');
      reconciliation = new Pool({
        allowExitOnIdle: true,
        application_name: 'emdo-google-oauth-reconciliation-integration',
        connectionString: reconciliationUrl.toString(),
        max: 1,
      });
      const retentionUrl = new URL(databaseUrl!);
      retentionUrl.username = retentionLogin;
      retentionUrl.password = retentionPassword;
      retention = new Pool({
        allowExitOnIdle: true,
        application_name: 'emdo-google-oauth-retention-integration',
        connectionString: retentionUrl.toString(),
        max: 1,
      });
      const active = await new PostgresSpaceAccessGrantService(
        runtime.scopedPool,
      ).resolveActivePrincipalScope({
        activeMembershipId: ids.membership,
        householdId: ids.household,
        requestId: ids.request,
        role: 'owner',
        sessionId: ids.session,
        userId: ids.user,
      });
      spaceAccessGrantId = active.spaceAccessGrantId;
    }, 30_000);

    afterAll(async () => {
      await retention?.end();
      await reconciliation?.end();
      await runtime?.close();
      if (admin !== undefined) {
        await admin
          .query(`alter role ${reconciliationLogin} nologin password null`)
          .catch(() => undefined);
        await admin
          .query(`alter role ${retentionLogin} nologin password null`)
          .catch(() => undefined);
        const login = await admin.query(
          `select 1 from pg_catalog.pg_roles where rolname = $1`,
          [loginRole],
        );
        if (login.rowCount !== 0) {
          await admin.query(
            `revoke connect on database emdo_app from ${loginRole}`,
          );
          await admin.query(`revoke emdo_app from ${loginRole}`);
          await admin.query(`drop role ${loginRole}`);
        }
        await admin.end();
      }
    });

    it('stores and exactly replays one request-bound authorization start', async () => {
      await expect(
        checkPostgresGoogleOAuthRuntimeReadiness(runtime.scopedPool),
      ).resolves.toBe(true);

      const now = new Date();
      const expiresAt = new Date(now.getTime() + 10 * 60 * 1_000);
      const flowId = 'o'.repeat(43);
      const purpose = 'calendar-read' as const;
      const result = {
        status: 'authorization-required' as const,
        authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=v1.${flowId}.${'s'.repeat(43)}`,
        expiresAt: expiresAt.toISOString(),
      };
      const requestFingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            domain: 'emdo.google-calendar.oauth-start.v1',
            purpose,
          }),
        )
        .digest('hex');
      const input = {
        actor,
        purpose,
        idempotencyKey: 'google-oauth-integration-start-0001',
        requestFingerprint,
        result,
        flow: {
          id: flowId,
          actor,
          redirectUri: 'https://emdo.example/api/v1/connectors/google/callback',
          purpose,
          requestedScopes: [
            'https://www.googleapis.com/auth/calendar.freebusy' as const,
          ],
          credentialRevisionAtStart: null,
          authorizationEpochAtStart: 0,
          codeVerifier: 'v'.repeat(43),
          createdAt: now,
          expiresAt,
        },
      };
      const store = new PostgresGoogleOAuthFlowStore(
        runtime.scopedPool,
        requestAuthority,
      );

      await expect(store.storeAuthorizationStart(input)).resolves.toEqual({
        status: 'stored',
        result,
      });
      await expect(store.storeAuthorizationStart(input)).resolves.toEqual({
        status: 'replayed',
        result,
      });
      await expect(
        store.storeAuthorizationStart({
          actor,
          purpose: 'calendar-event-write',
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: createHash('sha256')
            .update(
              JSON.stringify({
                domain: 'emdo.google-calendar.oauth-start.v1',
                purpose: 'calendar-event-write',
              }),
            )
            .digest('hex'),
          result: {
            status: 'already-authorized',
            grantedPurposes: ['calendar-event-write'],
          },
        }),
      ).resolves.toEqual({ status: 'conflict' });

      const persisted = await admin.query(
        `select
           (select pg_catalog.count(*)::integer
              from emdo.google_oauth_authorization_starts) as starts,
           (select pg_catalog.count(*)::integer
              from emdo.google_oauth_flows where id = $1) as flows`,
        [flowId],
      );
      expect(persisted.rows[0]).toEqual({ starts: 1, flows: 1 });
    });

    it('atomically rotates the public reference and rejects the old same-epoch authority', async () => {
      const recordId = `google-calendar-oauth-v1-${createHash('sha256')
        .update(ids.user)
        .digest('hex')}`;
      const scope = {
        householdId: ids.household,
        spaceId: ids.space,
        recordId,
        provider: 'google' as const,
        grantType: 'calendar-authorization' as const,
      };
      const store = new PostgresEncryptedGoogleCalendarGrantStore(
        runtime.scopedPool,
        requestAuthority,
      );
      await expect(
        store.compareAndSet({
          scope,
          ownerUserId: ids.user,
          expectedRevision: null,
          authorizationEpoch: 0,
          providerGrantReference: providerReferenceA,
          payload,
          now: new Date(),
        }),
      ).resolves.toEqual({ status: 'stored', revision: 1 });

      const invalidPayloads = [
        'null',
        '[]',
        { ...payload, unexpected: true },
        { ...payload, keyVersion: ' Calendar Vault V1 ' },
        { ...payload, nonce: 'not-a-12-byte-nonce' },
      ];
      await admin.query('begin');
      try {
        await admin.query('set local role emdo_app');
        await admin.query(
          `select pg_catalog.set_config('emdo.user_id', $1, true),
                  pg_catalog.set_config('emdo.session_id', $2, true),
                  pg_catalog.set_config('emdo.request_id', $3, true)`,
          [ids.user, ids.session, ids.request],
        );
        for (const [index, invalidPayload] of invalidPayloads.entries()) {
          const rejected = await admin.query(
            `select emdo.compare_and_set_encrypted_google_calendar_grant(
               $1, $2, $3, $4, 1, 0, $5, $6::jsonb
             ) as revision`,
            [
              recordId,
              ids.household,
              ids.space,
              ids.user,
              `gcal-invalid-provider-reference-${index}`,
              invalidPayload,
            ],
          );
          expect(rejected.rows[0]).toEqual({ revision: null });
        }
      } finally {
        await admin.query('rollback');
      }

      const resolver = new PostgresGoogleCalendarProviderAuthorityResolver(
        runtime.scopedPool,
        principal,
      );
      const resolverInput = {
        requestId: ids.request,
        runId: ids.run,
        sessionId: ids.session,
        userId: ids.user,
        householdId: ids.household,
        agentId: 'scheduler',
        spaceAccessGrantId,
        disclosureGrantId: ids.disclosureGrant,
        decisionId: ids.decision,
        capabilityId: 'google-calendar.event.create',
        capabilityFingerprint: 'a'.repeat(64),
      };
      const resolvedA = await resolver.resolve(resolverInput);
      expect(resolvedA?.authorityBinding).toMatchObject({
        providerGrantReference: providerReferenceA,
        authorizationEpoch: 0,
      });
      expect(resolvedA?.operationScope).toMatchObject({
        requestId: ids.request,
        sessionId: ids.session,
        spaceAccessGrantId,
      });
      const authorizationScopeFingerprint =
        resolvedA!.operationScope.authorizationScopeFingerprint;

      const authorityA = hashAuthority({
        authorizationEpoch: 0,
        authorizationScopeFingerprint,
        householdId: ids.household,
        privateSpaceId: ids.space,
        providerGrantReference: providerReferenceA,
      });
      await expect(
        store.compareAndSet({
          scope,
          ownerUserId: ids.user,
          expectedRevision: 1,
          authorizationEpoch: 0,
          providerGrantReference: providerReferenceB,
          payload,
          now: new Date(),
        }),
      ).resolves.toEqual({ status: 'stored', revision: 2 });
      const authorityB = hashAuthority({
        authorizationEpoch: 0,
        authorizationScopeFingerprint,
        householdId: ids.household,
        privateSpaceId: ids.space,
        providerGrantReference: providerReferenceB,
      });

      await admin.query('begin');
      try {
        await admin.query(
          `select pg_catalog.set_config('emdo.user_id', $1, true),
                  pg_catalog.set_config('emdo.session_id', $2, true),
                  pg_catalog.set_config('emdo.request_id', $3, true)`,
          [ids.user, ids.session, ids.request],
        );
        const verified = await admin.query(
          `select
             emdo.lock_current_google_calendar_authority($1, $2, $3, $4, $5)
               as old_authority,
             emdo.lock_current_google_calendar_authority($1, $2, $3, $4, $6)
               as current_authority`,
          [
            ids.household,
            ids.space,
            ids.user,
            authorizationScopeFingerprint,
            authorityA,
            authorityB,
          ],
        );
        expect(verified.rows[0]).toEqual({
          old_authority: false,
          current_authority: true,
        });
      } finally {
        await admin.query('rollback');
      }

      await expect(resolver.resolve(resolverInput)).resolves.toMatchObject({
        authorityBinding: {
          providerGrantReference: providerReferenceB,
          authorizationEpoch: 0,
        },
        operationScope: { authorizationScopeFingerprint },
      });
      await expect(
        store.compareAndSet({
          scope,
          ownerUserId: ids.user,
          expectedRevision: 1,
          authorizationEpoch: 0,
          providerGrantReference: providerReferenceA,
          payload,
          now: new Date(),
        }),
      ).resolves.toEqual({ status: 'conflict' });

      await expect(
        new PostgresGoogleOAuthAuthorizationEpochStore(
          runtime.scopedPool,
          requestAuthority,
        ).advance({ actor, expectedEpoch: 0 }),
      ).resolves.toEqual({ status: 'advanced', authorizationEpoch: 1 });
      await expect(resolver.resolve(resolverInput)).resolves.toBeUndefined();
    });

    it('replays a dispatching disconnect under a fresh request without another provider phase', async () => {
      await admin.query('delete from emdo.google_oauth_disconnect_operations');
      await admin.query('delete from emdo.encrypted_google_calendar_grants');
      await admin.query('delete from emdo.google_oauth_authorization_epochs');

      const recordId = `google-calendar-oauth-v1-${createHash('sha256')
        .update(ids.user)
        .digest('hex')}`;
      const scope = {
        householdId: ids.household,
        spaceId: ids.space,
        recordId,
        provider: 'google' as const,
        grantType: 'calendar-authorization' as const,
      };
      await expect(
        new PostgresEncryptedGoogleCalendarGrantStore(
          runtime.scopedPool,
          requestAuthority,
        ).compareAndSet({
          scope,
          ownerUserId: ids.user,
          expectedRevision: null,
          authorizationEpoch: 0,
          providerGrantReference: providerReferenceA,
          payload,
          now: new Date(),
        }),
      ).resolves.toEqual({ status: 'stored', revision: 1 });

      const requestFingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            domain: 'emdo.google-calendar.oauth-disconnect.v1',
          }),
        )
        .digest('hex');
      const idempotencyKey = 'google-oauth-disconnect-integration-0001';
      const retryIdempotencyKey =
        'google-oauth-disconnect-integration-rotated-0001';
      const originalStore = new PostgresGoogleOAuthDisconnectOperationStore(
        runtime.scopedPool,
        requestAuthority,
      );
      const claim = await originalStore.claim({
        actor,
        idempotencyKey,
        requestFingerprint,
      });
      expect(claim).toMatchObject({
        status: 'claimed',
        credentialRevision: 1,
        authorizationEpoch: 0,
      });
      if (claim.status !== 'claimed') throw new Error('disconnect not claimed');
      await expect(
        originalStore.markDispatching({
          actor,
          operationId: claim.operationId,
        }),
      ).resolves.toEqual({ status: 'dispatching' });

      const dispatchAuthorityState = await admin.query(
        `select epoch.authorization_epoch,
                pg_catalog.count(grant_row.record_id)::integer as grants
           from emdo.google_oauth_authorization_epochs as epoch
           left join emdo.encrypted_google_calendar_grants as grant_row
             on grant_row.household_id = epoch.household_id
            and grant_row.private_space_id = epoch.private_space_id
            and grant_row.original_owner_user_id = epoch.original_owner_user_id
          where epoch.household_id = $1
            and epoch.private_space_id = $2
            and epoch.original_owner_user_id = $3
          group by epoch.authorization_epoch`,
        [ids.household, ids.space, ids.user],
      );
      expect(dispatchAuthorityState.rows[0]).toEqual({
        authorization_epoch: 1,
        grants: 0,
      });
      await expect(
        new PostgresEncryptedGoogleCalendarGrantStore(
          runtime.scopedPool,
          requestAuthority,
        ).compareAndSet({
          scope,
          ownerUserId: ids.user,
          expectedRevision: null,
          authorizationEpoch: 1,
          providerGrantReference: providerReferenceB,
          payload,
          now: new Date(),
        }),
      ).resolves.toEqual({ status: 'conflict' });

      await new PostgresSpaceAccessGrantService(
        runtime.scopedPool,
      ).resolveActivePrincipalScope({
        activeMembershipId: ids.membership,
        householdId: ids.household,
        requestId: ids.retryRequest,
        role: 'owner',
        sessionId: ids.retrySession,
        userId: ids.user,
      });
      const retryAuthority = {
        ...requestAuthority,
        requestId: ids.retryRequest,
        sessionId: ids.retrySession,
      };
      const retryActor = {
        ...actor,
        sessionId: ids.retrySession,
      };
      const retryStore = new PostgresGoogleOAuthDisconnectOperationStore(
        runtime.scopedPool,
        retryAuthority,
      );
      await expect(
        retryStore.claim({
          actor: retryActor,
          idempotencyKey: retryIdempotencyKey,
          requestFingerprint,
        }),
      ).resolves.toEqual({
        status: 'dispatching',
        operationId: claim.operationId,
      });
      const result = {
        status: 'disconnected' as const,
        providerRevocation: 'unconfirmed' as const,
      };
      await expect(
        retryStore.settle({
          actor: retryActor,
          operationId: claim.operationId,
          providerRevocation: 'unconfirmed',
        }),
      ).resolves.toEqual({ status: 'stored', result });
      await expect(
        retryStore.claim({
          actor: retryActor,
          idempotencyKey: retryIdempotencyKey,
          requestFingerprint,
        }),
      ).resolves.toEqual({ status: 'replayed', result });
      await expect(
        originalStore.claim({ actor, idempotencyKey, requestFingerprint }),
      ).resolves.toEqual({ status: 'replayed', result });

      const persisted = await admin.query(
        `select parent_operation_id, session_id, origin_request_id,
                dispatch_request_id, dispatch_session_id,
                completed_request_id, completed_session_id,
                completion_source, state, result
           from emdo.google_oauth_disconnect_operations
          where id = $1 or parent_operation_id = $1
          order by parent_operation_id nulls first`,
        [claim.operationId],
      );
      expect(persisted.rows).toEqual([
        {
          parent_operation_id: null,
          session_id: ids.session,
          origin_request_id: ids.request,
          dispatch_request_id: ids.request,
          dispatch_session_id: ids.session,
          completed_request_id: ids.retryRequest,
          completed_session_id: ids.retrySession,
          completion_source: 'interactive',
          state: 'completed',
          result,
        },
        {
          parent_operation_id: claim.operationId,
          session_id: ids.retrySession,
          origin_request_id: ids.retryRequest,
          dispatch_request_id: ids.request,
          dispatch_session_id: ids.session,
          completed_request_id: ids.retryRequest,
          completed_session_id: ids.retrySession,
          completion_source: 'interactive',
          state: 'completed',
          result,
        },
      ]);
      const authorityState = await admin.query(
        `select epoch.authorization_epoch,
                pg_catalog.count(grant_row.record_id)::integer as grants
           from emdo.google_oauth_authorization_epochs as epoch
           left join emdo.encrypted_google_calendar_grants as grant_row
             on grant_row.household_id = epoch.household_id
            and grant_row.private_space_id = epoch.private_space_id
            and grant_row.original_owner_user_id = epoch.original_owner_user_id
          where epoch.household_id = $1
            and epoch.private_space_id = $2
            and epoch.original_owner_user_id = $3
          group by epoch.authorization_epoch`,
        [ids.household, ids.space, ids.user],
      );
      expect(authorityState.rows[0]).toEqual({
        authorization_epoch: 1,
        grants: 0,
      });
    });

    it('reconciles an aged dispatch without provider authority or a user session', async () => {
      await admin.query('delete from emdo.google_oauth_disconnect_operations');
      await admin.query('delete from emdo.encrypted_google_calendar_grants');
      await admin.query('delete from emdo.google_oauth_authorization_epochs');
      const recordId = `google-calendar-oauth-v1-${createHash('sha256')
        .update(ids.user)
        .digest('hex')}`;
      const scope = {
        householdId: ids.household,
        spaceId: ids.space,
        recordId,
        provider: 'google' as const,
        grantType: 'calendar-authorization' as const,
      };
      await expect(
        new PostgresEncryptedGoogleCalendarGrantStore(
          runtime.scopedPool,
          requestAuthority,
        ).compareAndSet({
          scope,
          ownerUserId: ids.user,
          expectedRevision: null,
          authorizationEpoch: 0,
          providerGrantReference: providerReferenceA,
          payload,
          now: new Date(),
        }),
      ).resolves.toEqual({ status: 'stored', revision: 1 });
      const requestFingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            domain: 'emdo.google-calendar.oauth-disconnect.v1',
          }),
        )
        .digest('hex');
      const store = new PostgresGoogleOAuthDisconnectOperationStore(
        runtime.scopedPool,
        requestAuthority,
      );
      const claim = await store.claim({
        actor,
        idempotencyKey: 'google-oauth-disconnect-reconcile-0001',
        requestFingerprint,
      });
      if (claim.status !== 'claimed') throw new Error('disconnect not claimed');
      await expect(
        store.markDispatching({ actor, operationId: claim.operationId }),
      ).resolves.toEqual({ status: 'dispatching' });

      await admin.query(
        `alter table emdo.google_oauth_disconnect_operations
           disable trigger google_oauth_disconnect_operations_transition_guard`,
      );
      try {
        await admin.query(
          `update emdo.google_oauth_disconnect_operations
              set updated_at = pg_catalog.clock_timestamp() - interval '11 minutes'
            where id = $1`,
          [claim.operationId],
        );
      } finally {
        await admin.query(
          `alter table emdo.google_oauth_disconnect_operations
             enable trigger google_oauth_disconnect_operations_transition_guard`,
        );
      }

      await expect(
        admin.query(
          'select emdo.google_oauth_disconnect_reconciliation_runner_ready() as ready',
        ),
      ).resolves.toMatchObject({ rows: [{ ready: false }] });
      await expect(
        reconciliation.query(
          'select emdo.google_oauth_disconnect_reconciliation_runner_ready() as ready',
        ),
      ).resolves.toMatchObject({ rows: [{ ready: true }] });
      await expect(
        reconciliation.query(
          'select emdo.reconcile_stranded_google_oauth_disconnects(10)',
        ),
      ).rejects.toMatchObject({ code: '42501' });

      const blocker = new (await import('pg')).Client({
        connectionString: databaseUrl,
      });
      await blocker.connect();
      try {
        await blocker.query('begin');
        await blocker.query(
          `select pg_catalog.pg_advisory_xact_lock(
             pg_catalog.hashtextextended($1::text || ':' || $2::text || ':' || $3::text, 0)
           )`,
          [ids.user, ids.household, ids.space],
        );
        const busyClient = await reconciliation.connect();
        try {
          await busyClient.query('begin');
          await busyClient.query(
            'set local role emdo_google_oauth_disconnect_reconciliation',
          );
          await expect(
            busyClient.query(
              'select emdo.reconcile_stranded_google_oauth_disconnects(10) as count',
            ),
          ).resolves.toMatchObject({ rows: [{ count: 0 }] });
          await busyClient.query('commit');
        } catch (error) {
          await busyClient.query('rollback').catch(() => undefined);
          throw error;
        } finally {
          busyClient.release();
        }
        await blocker.query('rollback');
      } finally {
        await blocker.query('rollback').catch(() => undefined);
        await blocker.end();
      }

      const reconciliationClient = await reconciliation.connect();
      try {
        await reconciliationClient.query('begin');
        await reconciliationClient.query(
          'set local role emdo_google_oauth_disconnect_reconciliation',
        );
        await expect(
          reconciliationClient.query(
            'select emdo.reconcile_stranded_google_oauth_disconnects(0)',
          ),
        ).rejects.toMatchObject({ code: '22023' });
        await reconciliationClient.query('rollback');
        await reconciliationClient.query('begin');
        await reconciliationClient.query(
          'set local role emdo_google_oauth_disconnect_reconciliation',
        );
        const reconciled = await reconciliationClient.query(
          'select emdo.reconcile_stranded_google_oauth_disconnects(10) as count',
        );
        expect(reconciled.rows[0]).toEqual({ count: 1 });
        await reconciliationClient.query('commit');
      } catch (error) {
        await reconciliationClient.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        reconciliationClient.release();
      }

      const persisted = await admin.query(
        `select state, completion_source, completed_request_id,
                completed_session_id, result
           from emdo.google_oauth_disconnect_operations
          where id = $1`,
        [claim.operationId],
      );
      expect(persisted.rows[0]).toEqual({
        state: 'completed',
        completion_source: 'reconciliation',
        completed_request_id: null,
        completed_session_id: null,
        result: {
          status: 'disconnected',
          providerRevocation: 'unconfirmed',
        },
      });
      await admin.query('begin');
      try {
        await admin.query(
          'set local role emdo_google_oauth_disconnect_reconciliation',
        );
        await expect(
          admin.query('select * from emdo.google_oauth_disconnect_operations'),
        ).rejects.toThrow(/permission denied/u);
      } finally {
        await admin.query('rollback');
      }
    });

    it('fails reconciliation-runner readiness closed under reversible role and ACL drift', async () => {
      const ready = () =>
        reconciliation.query<{ ready: boolean }>(
          'select emdo.google_oauth_disconnect_reconciliation_runner_ready() as ready',
        );
      await expect(ready()).resolves.toMatchObject({
        rows: [{ ready: true }],
      });

      await admin.query(`grant emdo_app to ${reconciliationLogin}`);
      await expect(ready()).resolves.toMatchObject({
        rows: [{ ready: false }],
      });
      await admin.query(`revoke emdo_app from ${reconciliationLogin}`);

      await admin.query(`alter role ${reconciliationLogin} bypassrls`);
      await expect(ready()).resolves.toMatchObject({
        rows: [{ ready: false }],
      });
      await admin.query(`alter role ${reconciliationLogin} nobypassrls`);

      await admin.query(
        `grant execute on function
           emdo.reconcile_stranded_google_oauth_disconnects(integer)
         to ${reconciliationLogin}`,
      );
      await expect(ready()).resolves.toMatchObject({
        rows: [{ ready: false }],
      });
      await admin.query(
        `revoke execute on function
           emdo.reconcile_stranded_google_oauth_disconnects(integer)
         from ${reconciliationLogin}`,
      );

      await admin.query(
        `grant execute on function
           emdo.purge_completed_google_oauth_disconnects(integer)
         to ${reconciliationLogin}`,
      );
      await expect(ready()).resolves.toMatchObject({
        rows: [{ ready: false }],
      });
      await admin.query(
        `revoke execute on function
           emdo.purge_completed_google_oauth_disconnects(integer)
         from ${reconciliationLogin}`,
      );

      await admin.query(
        `grant select on emdo.google_oauth_disconnect_operations
         to ${reconciliationLogin}`,
      );
      await expect(ready()).resolves.toMatchObject({
        rows: [{ ready: false }],
      });
      await admin.query(
        `revoke select on emdo.google_oauth_disconnect_operations
         from ${reconciliationLogin}`,
      );

      await admin.query(
        `grant select on emdo.google_oauth_disconnect_operations
         to emdo_google_oauth_disconnect_reconciliation`,
      );
      await expect(ready()).resolves.toMatchObject({
        rows: [{ ready: false }],
      });
      await admin.query(
        `revoke select on emdo.google_oauth_disconnect_operations
         from emdo_google_oauth_disconnect_reconciliation`,
      );

      await admin.query(
        `grant execute on function
           emdo.purge_completed_google_oauth_disconnects(integer)
         to emdo_google_oauth_disconnect_reconciliation`,
      );
      await expect(ready()).resolves.toMatchObject({
        rows: [{ ready: false }],
      });
      await admin.query(
        `revoke execute on function
           emdo.purge_completed_google_oauth_disconnects(integer)
         from emdo_google_oauth_disconnect_reconciliation`,
      );
      await expect(ready()).resolves.toMatchObject({
        rows: [{ ready: true }],
      });
    });

    it('purges only expired completed disconnect receipts through the isolated retention login', async () => {
      await admin.query('delete from emdo.google_oauth_disconnect_operations');
      const expired = '83900000-0000-4000-8000-000000000031';
      const retained = '83900000-0000-4000-8000-000000000032';
      const active = '83900000-0000-4000-8000-000000000033';
      await admin.query(
        `insert into emdo.google_oauth_disconnect_operations(
           id, household_id, private_space_id, original_owner_user_id,
           session_id, origin_request_id, completed_request_id,
           completed_session_id, idempotency_key, request_fingerprint, state,
           authorization_epoch, result, completion_source, created_at,
           updated_at, completed_at, retain_until
         ) values
           ($1, $4, $5, $6, $7, $8, $8, $7,
            'google-oauth-retention-expired-0001', $9, 'completed', 1,
            '{"status":"disconnected","providerRevocation":"not-applicable"}'::jsonb,
            'interactive', pg_catalog.statement_timestamp() - interval '91 days',
            pg_catalog.statement_timestamp() - interval '91 days',
            pg_catalog.statement_timestamp() - interval '91 days',
            pg_catalog.statement_timestamp() - interval '1 day'),
           ($2, $4, $5, $6, $7, $8, $8, $7,
            'google-oauth-retention-current-0001', $9, 'completed', 1,
            '{"status":"disconnected","providerRevocation":"not-applicable"}'::jsonb,
            'interactive', pg_catalog.statement_timestamp(),
            pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
            pg_catalog.statement_timestamp() + interval '89 days'),
           ($3, $4, $5, $6, $7, $8, null, null,
            'google-oauth-retention-active-0001', $9, 'claimed', 1,
            null, null, pg_catalog.statement_timestamp(),
            pg_catalog.statement_timestamp(), null, null)`,
        [
          expired,
          retained,
          active,
          ids.household,
          ids.space,
          ids.user,
          ids.session,
          ids.request,
          'a'.repeat(64),
        ],
      );

      await expect(
        retention.query(
          'select emdo.google_oauth_disconnect_retention_runner_ready() as ready',
        ),
      ).resolves.toMatchObject({ rows: [{ ready: true }] });
      await expect(
        retention.query(
          'select emdo.purge_completed_google_oauth_disconnects(100)',
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        retention.query(
          'select * from emdo.google_oauth_disconnect_operations',
        ),
      ).rejects.toMatchObject({ code: '42501' });

      const client = await retention.connect();
      try {
        await client.query('begin');
        await client.query(
          'set local role emdo_google_oauth_disconnect_retention',
        );
        await expect(
          client.query(
            'select emdo.purge_completed_google_oauth_disconnects(100) as purged',
          ),
        ).resolves.toMatchObject({ rows: [{ purged: 1 }] });
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      await expect(
        admin.query(
          `select id, state from emdo.google_oauth_disconnect_operations
            where id = any($1::uuid[]) order by id`,
          [[expired, retained, active]],
        ),
      ).resolves.toMatchObject({
        rows: [
          { id: retained, state: 'completed' },
          { id: active, state: 'claimed' },
        ],
      });
      await expect(
        checkPostgresGoogleOAuthRuntimeReadiness(runtime.scopedPool),
      ).resolves.toBe(true);
      await expect(
        reconciliation.query(
          'select emdo.google_oauth_disconnect_reconciliation_runner_ready() as ready',
        ),
      ).resolves.toMatchObject({ rows: [{ ready: true }] });
    });

    it('fails retention-runner readiness closed under reversible role and ACL drift', async () => {
      const ready = () =>
        retention.query<{ ready: boolean }>(
          'select emdo.google_oauth_disconnect_retention_runner_ready() as ready',
        );
      await expect(ready()).resolves.toMatchObject({ rows: [{ ready: true }] });

      for (const [drift, restore] of [
        [
          `grant emdo_app to ${retentionLogin}`,
          `revoke emdo_app from ${retentionLogin}`,
        ],
        [
          `alter role ${retentionLogin} bypassrls`,
          `alter role ${retentionLogin} nobypassrls`,
        ],
        [
          'alter role emdo_google_oauth_disconnect_retention bypassrls',
          'alter role emdo_google_oauth_disconnect_retention nobypassrls',
        ],
        [
          `grant execute on function
             emdo.purge_completed_google_oauth_disconnects(integer)
           to ${retentionLogin}`,
          `revoke execute on function
             emdo.purge_completed_google_oauth_disconnects(integer)
           from ${retentionLogin}`,
        ],
        [
          `grant select on emdo.google_oauth_disconnect_operations
           to ${retentionLogin}`,
          `revoke select on emdo.google_oauth_disconnect_operations
           from ${retentionLogin}`,
        ],
        [
          `grant execute on function
             emdo.reconcile_stranded_google_oauth_disconnects(integer)
           to emdo_google_oauth_disconnect_retention`,
          `revoke execute on function
             emdo.reconcile_stranded_google_oauth_disconnects(integer)
           from emdo_google_oauth_disconnect_retention`,
        ],
        [
          `grant select on emdo.google_oauth_authorization_epochs
           to emdo_google_oauth_disconnect_retention`,
          `revoke select on emdo.google_oauth_authorization_epochs
           from emdo_google_oauth_disconnect_retention`,
        ],
      ] as const) {
        await admin.query(drift);
        try {
          await expect(ready()).resolves.toMatchObject({
            rows: [{ ready: false }],
          });
        } finally {
          await admin.query(restore);
        }
      }
      await admin.query(
        `grant truncate on emdo.google_oauth_disconnect_operations
         to emdo_google_oauth_disconnect_retention`,
      );
      try {
        await expect(ready()).resolves.toMatchObject({
          rows: [{ ready: false }],
        });
        await expect(
          checkPostgresGoogleOAuthRuntimeReadiness(runtime.scopedPool),
        ).resolves.toBe(false);
      } finally {
        await admin.query(
          `revoke truncate on emdo.google_oauth_disconnect_operations
           from emdo_google_oauth_disconnect_retention`,
        );
      }
      await expect(ready()).resolves.toMatchObject({ rows: [{ ready: true }] });
      await expect(
        checkPostgresGoogleOAuthRuntimeReadiness(runtime.scopedPool),
      ).resolves.toBe(true);
    });

    it('denies direct app-role reads and writes to encrypted authority rows', async () => {
      const expectAppDenied = async (
        sql: string,
        values: readonly unknown[] = [],
      ) => {
        await admin.query('begin');
        try {
          await admin.query('set local role emdo_app');
          await expect(admin.query(sql, [...values])).rejects.toThrow(
            /permission denied/u,
          );
        } finally {
          await admin.query('rollback');
        }
      };

      await expectAppDenied(
        'select * from emdo.encrypted_google_calendar_grants',
      );
      await expectAppDenied(
        'select emdo.is_valid_encrypted_google_calendar_grant_payload($1::jsonb)',
        [payload],
      );
      await expectAppDenied(
        `insert into emdo.encrypted_google_calendar_grants(
               record_id, household_id, private_space_id,
               original_owner_user_id, provider, grant_type, revision,
               authorization_epoch, provider_grant_reference,
               encrypted_payload, created_at, updated_at
             ) values (
               'forged-record', $1, $2, $3, 'google',
               'calendar-authorization', 1, 0,
               'gcal-forged-reference-value', '{}'::jsonb,
               pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
             )`,
        [ids.household, ids.space, ids.user],
      );
      await expectAppDenied(
        'select * from emdo.google_oauth_authorization_starts',
      );
      await expectAppDenied(
        'select * from emdo.google_oauth_disconnect_operations',
      );
      await expectAppDenied('select * from emdo.google_oauth_flows');
      await expectAppDenied(
        `insert into emdo.google_oauth_flows(
           id, household_id, private_space_id, original_owner_user_id,
           session_id, redirect_uri, purpose, requested_scopes,
           credential_revision_at_start, authorization_epoch_at_start,
           code_verifier, created_at, expires_at
         ) values (
           $1, $2, $3, $4, $5, 'https://attacker.example/callback',
           'calendar-read', '[]'::jsonb, null, 0, $6,
           pg_catalog.clock_timestamp(),
           pg_catalog.clock_timestamp() + interval '10 minutes'
         )`,
        [
          'x'.repeat(43),
          ids.household,
          ids.space,
          ids.user,
          ids.session,
          'y'.repeat(43),
        ],
      );
    });

    it('fails readiness closed under reversible aggregate ACL drift', async () => {
      await expect(
        checkPostgresGoogleOAuthRuntimeReadiness(runtime.scopedPool),
      ).resolves.toBe(true);
      await admin.query(
        `revoke execute on function
           emdo.commit_google_oauth_authorization_start(
             uuid, uuid, uuid, uuid, text, text, text, jsonb, jsonb
           ) from emdo_app`,
      );
      await expect(
        checkPostgresGoogleOAuthRuntimeReadiness(runtime.scopedPool),
      ).resolves.toBe(false);
      await admin.query(
        `grant execute on function
           emdo.commit_google_oauth_authorization_start(
             uuid, uuid, uuid, uuid, text, text, text, jsonb, jsonb
           ) to emdo_app`,
      );
      await expect(
        checkPostgresGoogleOAuthRuntimeReadiness(runtime.scopedPool),
      ).resolves.toBe(true);
      await admin.query(
        `revoke execute on function
           emdo.settle_google_oauth_disconnect(
             uuid, uuid, uuid, uuid, uuid, text
           ) from emdo_app`,
      );
      await expect(
        checkPostgresGoogleOAuthRuntimeReadiness(runtime.scopedPool),
      ).resolves.toBe(false);
      await admin.query(
        `grant execute on function
           emdo.settle_google_oauth_disconnect(
             uuid, uuid, uuid, uuid, uuid, text
           ) to emdo_app`,
      );
      await expect(
        checkPostgresGoogleOAuthRuntimeReadiness(runtime.scopedPool),
      ).resolves.toBe(true);
      await admin.query(
        `grant execute on function
           emdo.is_valid_encrypted_google_calendar_grant_payload(jsonb)
         to emdo_app`,
      );
      await expect(
        checkPostgresGoogleOAuthRuntimeReadiness(runtime.scopedPool),
      ).resolves.toBe(false);
      await admin.query(
        `revoke execute on function
           emdo.is_valid_encrypted_google_calendar_grant_payload(jsonb)
         from emdo_app`,
      );
      await expect(
        checkPostgresGoogleOAuthRuntimeReadiness(runtime.scopedPool),
      ).resolves.toBe(true);
      await admin.query(
        'grant emdo_google_oauth_disconnect_retention to emdo_api_login',
      );
      try {
        await expect(
          checkPostgresGoogleOAuthRuntimeReadiness(runtime.scopedPool),
        ).resolves.toBe(false);
      } finally {
        await admin.query(
          'revoke emdo_google_oauth_disconnect_retention from emdo_api_login',
        );
      }
      await expect(
        checkPostgresGoogleOAuthRuntimeReadiness(runtime.scopedPool),
      ).resolves.toBe(true);
    });
  },
);

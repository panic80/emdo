import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresSpaceAccessGrantService } from '../auth/space-access-grants.js';
import { createDatabaseClient, type EmdoDatabaseClient } from '../client.js';
import { loadOrderedMigrations } from '../migrations.js';
import {
  PostgresEncryptedGoogleCalendarGrantStore,
  PostgresGoogleCalendarProviderAuthorityResolver,
  PostgresGoogleOAuthAuthorizationEpochStore,
  PostgresGoogleOAuthFlowStore,
  checkPostgresGoogleOAuthRuntimeReadiness,
} from './oauth-persistence.js';

const databaseUrl = process.env.TEST_GOOGLE_OAUTH_AUTHORITY_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const ids = {
  user: '83900000-0000-4000-8000-000000000001',
  session: '83900000-0000-4000-8000-000000000002',
  request: '83900000-0000-4000-8000-000000000003',
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
  'PostgreSQL 17 Google Calendar authority binding (isolated database only)',
  () => {
    let admin: import('pg').Client;
    let runtime: EmdoDatabaseClient;
    let spaceAccessGrantId: string;

    beforeAll(async () => {
      const { Client } = await import('pg');
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
         ) values ($1, $2, 'oauth-authority-token',
                   pg_catalog.clock_timestamp() + interval '1 hour', $3)`,
        [ids.session, ids.user, ids.household],
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
      const runtimeUrl = new URL(databaseUrl!);
      runtimeUrl.username = loginRole;
      runtimeUrl.password = loginPassword;
      runtime = createDatabaseClient({
        connectionString: runtimeUrl.toString(),
        applicationName: 'emdo-oauth-authority-integration',
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
      await runtime?.close();
      if (admin !== undefined) {
        const login = await admin.query(
          `select 1 from pg_catalog.pg_roles where rolname = $1`,
          [loginRole],
        );
        if (login.rowCount !== 0) {
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
    });
  },
);

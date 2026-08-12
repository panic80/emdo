import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresSpaceAccessGrantService } from '../auth/space-access-grants.js';
import { createDatabaseClient, type EmdoDatabaseClient } from '../client.js';
import { loadOrderedMigrations } from '../migrations.js';
import {
  PostgresEncryptedGoogleCalendarGrantStore,
  PostgresGoogleCalendarProviderAuthorityResolver,
  PostgresGoogleOAuthAuthorizationEpochStore,
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
const actor = {
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  privateSpaceId: ids.space,
};
const loginRole = 'emdo_oauth_authority_integration_login';
const providerReferenceA = 'gcal-provider-reference-integration-a';
const providerReferenceB = 'gcal-provider-reference-integration-b';
const payload = {
  algorithm: 'aes-256-gcm' as const,
  aadVersion: 1 as const,
  ciphertext: 'ciphertext',
  nonce: 'nonce',
  authenticationTag: 'tag',
  wrappedKey: 'wrapped-key',
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
        `create role ${loginRole} login nosuperuser nocreatedb nocreaterole inherit nobypassrls noreplication`,
      );
      await admin.query(`grant emdo_app to ${loginRole}`);
      const runtimeUrl = new URL(databaseUrl!);
      runtimeUrl.username = loginRole;
      runtimeUrl.password = '';
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
        principal,
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
    });
  },
);

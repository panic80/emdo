import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type EmdoDatabaseClient } from '../client.js';
import { loadOrderedMigrations } from '../migrations.js';
import {
  AudioRequestCoordinatorError,
  PostgresAudioRequestCoordinator,
} from './postgres-audio-request-coordinator.js';

const databaseUrl = process.env.TEST_DURABLE_DATABASE_URL;
const describeDatabase = databaseUrl ? describe.sequential : describe.skip;

const ids = Object.freeze({
  grantOwner1: 'a7000000-0000-4000-8000-000000000011',
  grantOwner2: 'a7000000-0000-4000-8000-000000000012',
  grantOwner3: 'a7000000-0000-4000-8000-000000000013',
  grantMember: 'a7000000-0000-4000-8000-000000000014',
  household: 'a7000000-0000-4000-8000-000000000020',
  memberMembership: 'a7000000-0000-4000-8000-000000000031',
  ownerMembership: 'a7000000-0000-4000-8000-000000000030',
  requestOwner1: 'a7000000-0000-4000-8000-000000000041',
  requestOwner2: 'a7000000-0000-4000-8000-000000000042',
  requestOwner3: 'a7000000-0000-4000-8000-000000000043',
  requestMember: 'a7000000-0000-4000-8000-000000000044',
  sessionMember: 'a7000000-0000-4000-8000-000000000051',
  sessionOwner: 'a7000000-0000-4000-8000-000000000050',
  spaceMember: 'a7000000-0000-4000-8000-000000000061',
  spaceOwner: 'a7000000-0000-4000-8000-000000000060',
  userMember: 'a7000000-0000-4000-8000-000000000071',
  userOwner: 'a7000000-0000-4000-8000-000000000070',
});

const loginRole = 'emdo_audio_receipt_test_login';
const idempotencyKey = 'audio:live:durable:0001';
const requestFingerprint = 'a'.repeat(64);

const ownerPrincipal = (request: 'owner1' | 'owner2' | 'owner3') => ({
  userId: ids.userOwner,
  sessionId: ids.sessionOwner,
  householdId: ids.household,
  role: 'owner' as const,
  emailVerified: true as const,
  spaceAccessGrantId:
    request === 'owner1'
      ? ids.grantOwner1
      : request === 'owner2'
        ? ids.grantOwner2
        : ids.grantOwner3,
});

const ownerRequestId = (request: 'owner1' | 'owner2' | 'owner3') =>
  request === 'owner1'
    ? ids.requestOwner1
    : request === 'owner2'
      ? ids.requestOwner2
      : ids.requestOwner3;

const memberPrincipal = {
  userId: ids.userMember,
  sessionId: ids.sessionMember,
  householdId: ids.household,
  role: 'member' as const,
  emailVerified: true as const,
  spaceAccessGrantId: ids.grantMember,
};

const claimInput = (request: 'owner1' | 'owner2' | 'owner3') => ({
  kind: 'transcription' as const,
  model: 'gpt-4o-mini-transcribe' as const,
  inputUnits: 4_096,
  requestFingerprint,
  principal: ownerPrincipal(request),
  requestId: ownerRequestId(request),
  idempotencyKey,
});

describeDatabase(
  'durable audio request coordinator (requires TEST_DURABLE_DATABASE_URL)',
  () => {
    let admin: import('pg').Client;
    let createdApiLogin = false;
    let runtime: EmdoDatabaseClient;

    beforeAll(async () => {
      const { Client } = await import('pg');
      admin = new Client({ connectionString: databaseUrl });
      await admin.connect();
      for (const migration of await loadOrderedMigrations()) {
        if (migration.index > 4) break;
        await admin.query(migration.sql);
      }
      const apiLogin = await admin.query<{ exists: boolean }>(
        `select pg_catalog.count(*) = 1 as exists
           from pg_catalog.pg_roles
          where rolname = 'emdo_api_login'`,
      );
      if (apiLogin.rows[0]?.exists !== true) {
        await admin.query(
          `create role emdo_api_login nologin nosuperuser nocreatedb
             nocreaterole inherit nobypassrls noreplication`,
        );
        await admin.query('grant emdo_app to emdo_api_login');
        createdApiLogin = true;
      }

      await admin.query(
        `insert into emdo.auth_users
           (id, name, email, email_verified)
         values
           ($1, 'Audio Owner', 'audio-owner@example.test', true),
           ($2, 'Audio Member', 'audio-member@example.test', true)`,
        [ids.userOwner, ids.userMember],
      );
      await admin.query(
        `insert into emdo.households
           (id, name, slug, created_by_user_id)
         values ($1, 'Audio Household', 'audio-household', $2)`,
        [ids.household, ids.userOwner],
      );
      await admin.query(
        `insert into emdo.household_memberships
           (id, household_id, user_id, role, status, joined_at)
         values
           ($1, $2, $3, 'owner', 'active', pg_catalog.clock_timestamp()),
           ($4, $2, $5, 'member', 'active', pg_catalog.clock_timestamp())`,
        [
          ids.ownerMembership,
          ids.household,
          ids.userOwner,
          ids.memberMembership,
          ids.userMember,
        ],
      );
      await admin.query(
        `insert into emdo.spaces
           (id, household_id, original_owner_user_id, name, visibility)
         values
           ($1, $2, $3, 'Owner private', 'private'),
           ($4, $2, $5, 'Member private', 'private')`,
        [
          ids.spaceOwner,
          ids.household,
          ids.userOwner,
          ids.spaceMember,
          ids.userMember,
        ],
      );
      await admin.query(
        `insert into emdo.auth_sessions
           (id, user_id, token, expires_at, active_household_id)
         values
           ($1, $2, 'audio-owner-session-token',
            pg_catalog.clock_timestamp() + interval '1 hour', $3),
           ($4, $5, 'audio-member-session-token',
            pg_catalog.clock_timestamp() + interval '1 hour', $3)`,
        [
          ids.sessionOwner,
          ids.userOwner,
          ids.household,
          ids.sessionMember,
          ids.userMember,
        ],
      );

      for (const grant of [
        {
          grantId: ids.grantOwner1,
          membershipId: ids.ownerMembership,
          requestId: ids.requestOwner1,
          role: 'owner',
          sessionId: ids.sessionOwner,
          spaceId: ids.spaceOwner,
          userId: ids.userOwner,
        },
        {
          grantId: ids.grantOwner2,
          membershipId: ids.ownerMembership,
          requestId: ids.requestOwner2,
          role: 'owner',
          sessionId: ids.sessionOwner,
          spaceId: ids.spaceOwner,
          userId: ids.userOwner,
        },
        {
          grantId: ids.grantOwner3,
          membershipId: ids.ownerMembership,
          requestId: ids.requestOwner3,
          role: 'owner',
          sessionId: ids.sessionOwner,
          spaceId: ids.spaceOwner,
          userId: ids.userOwner,
        },
        {
          grantId: ids.grantMember,
          membershipId: ids.memberMembership,
          requestId: ids.requestMember,
          role: 'member',
          sessionId: ids.sessionMember,
          spaceId: ids.spaceMember,
          userId: ids.userMember,
        },
      ] as const) {
        await admin.query(
          `insert into emdo.space_access_grants
             (grant_id, schema_version, version, household_id,
              original_owner_user_id, session_id, request_id, membership_id,
              role, private_space_id, writable_space_ids, issued_at,
              expires_at, retain_until)
           values
             ($1, 1, 1, $2, $3, $4, $5, $6, $7, $8,
              array[$8]::uuid[], pg_catalog.clock_timestamp(),
              pg_catalog.clock_timestamp() + interval '10 minutes',
              pg_catalog.clock_timestamp() + interval '7 days')`,
          [
            grant.grantId,
            ids.household,
            grant.userId,
            grant.sessionId,
            grant.requestId,
            grant.membershipId,
            grant.role,
            grant.spaceId,
          ],
        );
      }

      await admin.query(`drop role if exists ${loginRole}`);
      const loginPassword = randomBytes(32).toString('base64url');
      const createRole = await admin.query<{ statement: string }>(
        `select pg_catalog.format(
           'create role %I login nosuperuser nocreatedb nocreaterole inherit nobypassrls noreplication password %L',
           $1::text, $2::text
         ) as statement`,
        [loginRole, loginPassword],
      );
      await admin.query(createRole.rows[0]!.statement);
      await admin.query(`grant emdo_app to ${loginRole}`);

      const runtimeUrl = new URL(databaseUrl!);
      runtimeUrl.username = loginRole;
      runtimeUrl.password = loginPassword;
      runtime = createDatabaseClient({
        connectionString: runtimeUrl.toString(),
        applicationName: 'emdo-audio-receipt-integration',
        max: 6,
      });
    }, 45_000);

    afterAll(async () => {
      await runtime?.close();
      if (admin !== undefined) {
        await admin.query(`drop role if exists ${loginRole}`);
        if (createdApiLogin) {
          await admin.query('drop role if exists emdo_api_login');
        }
        await admin.end();
      }
    });

    it('fences one owner, isolates conflicts/users, and replays only after fresh-grant reauthorization', async () => {
      const coordinator = new PostgresAudioRequestCoordinator(
        runtime.scopedPool,
      );
      const concurrent = await Promise.all([
        coordinator.claim(claimInput('owner1')),
        coordinator.claim(claimInput('owner1')),
      ]);
      expect(concurrent.map(({ status }) => status).sort()).toEqual([
        'claimed',
        'in-progress',
      ]);
      const firstOwner = concurrent.find(
        (result) => result.status === 'claimed',
      );
      if (firstOwner?.status !== 'claimed') {
        throw new Error('The live audio claim did not elect an owner');
      }

      await expect(
        coordinator.claim({
          ...claimInput('owner1'),
          requestFingerprint: 'b'.repeat(64),
        }),
      ).resolves.toEqual({ status: 'conflict' });

      await expect(
        coordinator.claim({
          ...claimInput('owner1'),
          principal: memberPrincipal,
          requestId: ids.requestMember,
        }),
      ).resolves.toMatchObject({ status: 'claimed' });

      await coordinator.releaseKnownNoDispatch({
        claimId: firstOwner.claimId,
        ownershipToken: firstOwner.ownershipToken,
        reasonCode: 'transcription-provider-not-dispatched',
        principal: ownerPrincipal('owner1'),
        requestId: ids.requestOwner1,
      });

      const reclaimed = await coordinator.claim(claimInput('owner2'));
      expect(reclaimed).toMatchObject({ status: 'claimed' });
      if (reclaimed.status !== 'claimed') {
        throw new Error('The safely released audio claim was not reclaimed');
      }
      expect(reclaimed.claimId).not.toBe(firstOwner.claimId);
      expect(reclaimed.ownershipToken).not.toBe(firstOwner.ownershipToken);

      await expect(
        coordinator.completeTranscription({
          claimId: firstOwner.claimId,
          ownershipToken: firstOwner.ownershipToken,
          transcript: 'must not settle',
          model: 'gpt-4o-mini-transcribe',
          spendWarning: false,
          principal: ownerPrincipal('owner2'),
          requestId: ids.requestOwner2,
        }),
      ).rejects.toMatchObject({
        name: 'AudioRequestCoordinatorError',
        code: 'stale-ownership',
      } satisfies Partial<AudioRequestCoordinatorError>);

      await coordinator.completeTranscription({
        claimId: reclaimed.claimId,
        ownershipToken: reclaimed.ownershipToken,
        transcript: 'durable live transcript',
        model: 'gpt-4o-mini-transcribe',
        spendWarning: true,
        principal: ownerPrincipal('owner2'),
        requestId: ids.requestOwner2,
      });

      await expect(coordinator.claim(claimInput('owner3'))).resolves.toEqual({
        status: 'replay',
        result: {
          kind: 'transcription',
          transcript: 'durable live transcript',
          model: 'gpt-4o-mini-transcribe',
          spendWarning: true,
        },
      });
      await expect(
        coordinator.markIndeterminate({
          claimId: reclaimed.claimId,
          ownershipToken: reclaimed.ownershipToken,
          reasonCode: 'transcription-settlement-state-unknown',
          principal: ownerPrincipal('owner3'),
          requestId: ids.requestOwner3,
        }),
      ).rejects.toMatchObject({ code: 'stale-ownership' });
    });

    it('exposes only function capabilities and stores no audio/result byte payload', async () => {
      const coordinator = new PostgresAudioRequestCoordinator(
        runtime.scopedPool,
      );
      // The production readiness capability is intentionally bound to the
      // exact emdo_api_login. A temporary integration login must fail closed.
      await expect(coordinator.checkReady()).resolves.toBe(false);

      const readProductionReadiness = async () => {
        await admin.query('set session authorization emdo_api_login');
        try {
          const result = await admin.query<{ ready: boolean }>(
            'select emdo.audio_request_receipts_ready() as ready',
          );
          return result.rows[0]?.ready === true;
        } finally {
          await admin.query('reset session authorization');
        }
      };
      await expect(readProductionReadiness()).resolves.toBe(true);

      await admin.query('begin');
      try {
        await admin.query(
          'grant select on emdo.audio_request_receipts to emdo_api_login',
        );
        await expect(readProductionReadiness()).resolves.toBe(false);
      } finally {
        await admin.query('rollback');
      }
      await expect(readProductionReadiness()).resolves.toBe(true);

      await admin.query('begin');
      try {
        await admin.query(
          `grant execute on function emdo.audio_request_receipts_ready()
             to ${loginRole}`,
        );
        await expect(readProductionReadiness()).resolves.toBe(false);
      } finally {
        await admin.query('rollback');
      }
      await expect(readProductionReadiness()).resolves.toBe(true);

      await admin.query('begin');
      try {
        await admin.query(
          `grant execute on function
             emdo.resolve_audio_request_reconciliation(uuid,text,uuid,bigint,text,text)
             to ${loginRole}`,
        );
        await expect(readProductionReadiness()).resolves.toBe(false);
      } finally {
        await admin.query('rollback');
      }
      await expect(readProductionReadiness()).resolves.toBe(true);

      await admin.query('begin');
      try {
        await admin.query(
          `grant emdo_audio_reconciliation to emdo_api_login
             with inherit false, set true`,
        );
        await expect(readProductionReadiness()).resolves.toBe(false);
      } finally {
        await admin.query('rollback');
      }
      await expect(readProductionReadiness()).resolves.toBe(true);

      await admin.query('begin');
      try {
        await admin.query(
          'grant execute on function emdo.audio_request_receipts_ready() to public',
        );
        await expect(readProductionReadiness()).resolves.toBe(false);
      } finally {
        await admin.query('rollback');
      }
      await expect(readProductionReadiness()).resolves.toBe(true);

      await admin.query('begin');
      try {
        await admin.query(
          'alter role emdo_audio_reconciliation_executor bypassrls',
        );
        await expect(readProductionReadiness()).resolves.toBe(false);
      } finally {
        await admin.query('rollback');
      }
      await expect(readProductionReadiness()).resolves.toBe(true);

      await expect(
        runtime.pool.query(
          'select receipt_id from emdo.audio_request_receipts limit 1',
        ),
      ).rejects.toMatchObject({ code: '42501' });

      const privileges = await admin.query<{
        app_operator: boolean;
        app_ready: boolean;
        app_table_dml: boolean;
      }>(
        `select
           pg_catalog.has_function_privilege(
             'emdo_app',
             'emdo.resolve_audio_request_reconciliation(uuid,text,uuid,bigint,text,text)',
             'EXECUTE'
           ) as app_operator,
           pg_catalog.has_function_privilege(
             'emdo_app', 'emdo.audio_request_receipts_ready()', 'EXECUTE'
           ) as app_ready,
           pg_catalog.has_table_privilege(
             'emdo_app', 'emdo.audio_request_receipts',
             'SELECT,INSERT,UPDATE,DELETE'
           ) as app_table_dml`,
      );
      expect(privileges.rows[0]).toEqual({
        app_operator: false,
        app_ready: true,
        app_table_dml: false,
      });

      const operatorCapability = await admin.query<{ allowed: boolean }>(
        `select pg_catalog.has_function_privilege(
           'emdo_audio_reconciliation',
           'emdo.resolve_audio_request_reconciliation(uuid,text,uuid,bigint,text,text)',
           'EXECUTE'
         ) as allowed`,
      );
      expect(operatorCapability.rows[0]?.allowed).toBe(true);

      const unsafeColumns = await admin.query(
        `select attribute.attname, pg_catalog.format_type(
                  attribute.atttypid, attribute.atttypmod
                ) as data_type
           from pg_catalog.pg_attribute as attribute
           join pg_catalog.pg_class as relation
             on relation.oid = attribute.attrelid
           join pg_catalog.pg_namespace as namespace
             on namespace.oid = relation.relnamespace
          where namespace.nspname = 'emdo'
            and relation.relname in (
              'audio_request_receipts',
              'audio_request_receipt_operations'
            )
            and attribute.attnum > 0
            and not attribute.attisdropped
            and attribute.atttypid in ('bytea'::regtype, 'jsonb'::regtype)`,
      );
      expect(unsafeColumns.rows).toEqual([]);

      const audioRoles = await admin.query<{
        child_memberships: string;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolinherit: boolean;
        rolname: string;
        rolreplication: boolean;
        rolsuper: boolean;
      }>(
        `select role.rolname, role.rolcanlogin, role.rolinherit,
                role.rolbypassrls, role.rolsuper, role.rolcreatedb,
                role.rolcreaterole, role.rolreplication,
                (select pg_catalog.count(*)::text
                   from pg_catalog.pg_auth_members as membership
                  where membership.member = role.oid) as child_memberships
           from pg_catalog.pg_roles as role
          where role.rolname in (
            'emdo_audio_executor',
            'emdo_audio_reconciliation_executor',
            'emdo_audio_reconciliation'
          )
          order by role.rolname`,
      );
      expect(audioRoles.rows).toEqual(
        [
          'emdo_audio_executor',
          'emdo_audio_reconciliation',
          'emdo_audio_reconciliation_executor',
        ].map((rolname) => ({
          rolname,
          rolcanlogin: false,
          rolinherit: false,
          rolbypassrls: false,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          child_memberships: '0',
        })),
      );
    });
  },
);

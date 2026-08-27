import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

import { makeSignature } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEmdoBetterAuth } from '../../auth/src/better-auth.js';
import {
  createPostgresBetterAuthOrganizationClaimBridge,
  type PostgresBetterAuthOrganizationClaimBridge,
} from './better-auth-claim-transaction.js';
import { loadOrderedMigrations } from './migrations.js';
import {
  createRlsCrossHouseholdProbe,
  POSTGRES_CI_WORKFLOW,
  POSTGRES_STAGING_WORKFLOW,
  type RlsCrossHouseholdProbeContext,
} from './rls-cross-household-probe.js';

const databaseUrl = process.env.TEST_RLS_ATTACK_DATABASE_URL;
const proofResultPath = process.env.RLS_ATTACK_PROBE_RESULT_PATH;
const probeEnvironment = process.env.RLS_ATTACK_PROBE_ENVIRONMENT;
const probeEvent = process.env.RLS_ATTACK_PROBE_EVENT;
const probeRunId = process.env.RLS_ATTACK_PROBE_RUN_ID;
const probeSourceSha = process.env.RLS_ATTACK_PROBE_SOURCE_SHA;
const probeWorkflow = process.env.RLS_ATTACK_PROBE_WORKFLOW;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const requiredDatabaseUrl =
  databaseUrl ?? 'postgresql://integration-test-unavailable.invalid/postgres';
const authSecret = 'rls-attack-signed-claim-secret-at-least-32-bytes';
const ids = Object.freeze({
  householdA: '83000000-0000-4000-8000-000000000001',
  householdB: '83000000-0000-4000-8000-000000000002',
  memberA: '83000000-0000-4000-8000-000000000003',
  ownerA: '83000000-0000-4000-8000-000000000004',
  ownerB: '83000000-0000-4000-8000-000000000005',
  ownerAPrivateSpace: '83000000-0000-4000-8000-000000000006',
  memberAPrivateSpace: '83000000-0000-4000-8000-000000000007',
  sharedSpace: '83000000-0000-4000-8000-000000000008',
  ownerBPrivateSpace: '83000000-0000-4000-8000-000000000009',
  ownerARecord: '83000000-0000-4000-8000-000000000010',
  memberARecord: '83000000-0000-4000-8000-000000000011',
  ownerBRecord: '83000000-0000-4000-8000-000000000012',
  sessionA: '83000000-0000-4000-8000-000000000013',
  sessionB: '83000000-0000-4000-8000-000000000014',
  requestA: '83000000-0000-4000-8000-000000000015',
  forgedSpace: '83000000-0000-4000-8000-000000000016',
  forgedRecord: '83000000-0000-4000-8000-000000000017',
});

interface LiveEmdoAuth {
  readonly handler: (request: Request) => Promise<Response>;
}

const requiredProbeContext = (): RlsCrossHouseholdProbeContext => {
  if (
    probeEnvironment === 'ci' &&
    (probeEvent === 'push' || probeEvent === 'pull_request') &&
    probeWorkflow === POSTGRES_CI_WORKFLOW &&
    probeRunId !== undefined &&
    probeSourceSha !== undefined
  ) {
    return {
      environment: probeEnvironment,
      event: probeEvent,
      runId: probeRunId,
      sourceSha: probeSourceSha,
      workflow: probeWorkflow,
    };
  }
  if (
    probeEnvironment === 'staging' &&
    probeEvent === 'workflow_dispatch' &&
    probeWorkflow === POSTGRES_STAGING_WORKFLOW &&
    probeRunId !== undefined &&
    probeSourceSha !== undefined
  ) {
    return {
      environment: probeEnvironment,
      event: probeEvent,
      runId: probeRunId,
      sourceSha: probeSourceSha,
      workflow: probeWorkflow,
    };
  }
  throw new Error('RLS attack probe workflow-run binding is invalid.');
};

const quoteIdentifier = (value: string): string => {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error('Unsafe test-only PostgreSQL identifier.');
  }
  return `"${value}"`;
};

const connectionStringFor = (role: string, password: string): string => {
  const url = new URL(requiredDatabaseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
};

describeDatabase(
  'live cross-household RLS and signed-claim attacks (requires isolated TEST_RLS_ATTACK_DATABASE_URL)',
  () => {
    let admin: import('pg').Client;
    let appPool: import('pg').Pool;
    let authPool: import('pg').Pool;
    let bridge: PostgresBetterAuthOrganizationClaimBridge;
    let emdoAuth: LiveEmdoAuth;
    let appRole = '';
    let authRole = '';
    let serverVersionNum = 0;
    let pgvectorExtensionVersion = '';

    beforeAll(async () => {
      const { Client, Pool } = await import('pg');
      admin = new Client({
        application_name: 'emdo-rls-attack-setup',
        connectionString: requiredDatabaseUrl,
      });
      await admin.connect();
      const preflight = await admin.query<{
        emdo_schema: string | null;
        server_version_num: string;
        vector_available: boolean;
      }>(`select
        pg_catalog.to_regnamespace('emdo')::text as emdo_schema,
        pg_catalog.current_setting('server_version_num') as server_version_num,
        exists (
          select 1 from pg_catalog.pg_available_extensions where name = 'vector'
        ) as vector_available`);
      expect(preflight.rows[0]).toMatchObject({
        emdo_schema: null,
        vector_available: true,
      });
      expect(
        Number(preflight.rows[0]?.server_version_num),
      ).toBeGreaterThanOrEqual(180_000);
      expect(Number(preflight.rows[0]?.server_version_num)).toBeLessThan(
        190_000,
      );
      serverVersionNum = Number(preflight.rows[0]?.server_version_num);

      for (const migration of await loadOrderedMigrations()) {
        await admin.query(migration.sql);
      }
      const vector = await admin.query<{ extension_version: string }>(
        `select extension.extversion as extension_version
           from pg_catalog.pg_extension as extension
          where extension.extname = 'vector'`,
      );
      expect(vector.rows).toHaveLength(1);
      expect(vector.rows[0]?.extension_version).toMatch(
        /^\d+\.\d+(?:\.\d+)?$/u,
      );
      pgvectorExtensionVersion = vector.rows[0]?.extension_version ?? '';
      await admin.query(
        `insert into emdo.auth_users (id, name, email, email_verified)
         values ($1, 'Owner A', 'rls-owner-a@example.test', true),
                ($2, 'Member A', 'rls-member-a@example.test', true),
                ($3, 'Owner B', 'rls-owner-b@example.test', true)`,
        [ids.ownerA, ids.memberA, ids.ownerB],
      );
      await admin.query(
        `insert into emdo.households (id, name, slug, created_by_user_id)
         values ($1, 'RLS Household A', 'rls-household-a', $2),
                ($3, 'RLS Household B', 'rls-household-b', $4)`,
        [ids.householdA, ids.ownerA, ids.householdB, ids.ownerB],
      );
      await admin.query(
        `insert into emdo.household_memberships
           (household_id, user_id, role, status, joined_at)
         values ($1, $2, 'owner', 'active', pg_catalog.clock_timestamp()),
                ($1, $3, 'member', 'active', pg_catalog.clock_timestamp()),
                ($4, $5, 'owner', 'active', pg_catalog.clock_timestamp())`,
        [ids.householdA, ids.ownerA, ids.memberA, ids.householdB, ids.ownerB],
      );
      await admin.query(
        `insert into emdo.spaces
           (id, household_id, original_owner_user_id, name, visibility)
         values ($1, $5, $6, 'Owner A private', 'private'),
                ($2, $5, $7, 'Member A private', 'private'),
                ($3, $5, $6, 'Household A shared', 'shared'),
                ($4, $8, $9, 'Owner B private', 'private')`,
        [
          ids.ownerAPrivateSpace,
          ids.memberAPrivateSpace,
          ids.sharedSpace,
          ids.ownerBPrivateSpace,
          ids.householdA,
          ids.ownerA,
          ids.memberA,
          ids.householdB,
          ids.ownerB,
        ],
      );
      await admin.query(
        `insert into emdo.space_records
           (id, household_id, space_id, original_owner_user_id,
            record_kind, payload, actor_intent)
         values ($1, $4, $5, $6, 'test.owner-a', '{}', 'RLS fixture'),
                ($2, $4, $7, $8, 'test.member-a', '{}', 'RLS fixture'),
                ($3, $9, $10, $11, 'test.owner-b', '{}', 'RLS fixture')`,
        [
          ids.ownerARecord,
          ids.memberARecord,
          ids.ownerBRecord,
          ids.householdA,
          ids.ownerAPrivateSpace,
          ids.ownerA,
          ids.memberAPrivateSpace,
          ids.memberA,
          ids.householdB,
          ids.ownerBPrivateSpace,
          ids.ownerB,
        ],
      );
      await admin.query(
        `insert into emdo.auth_sessions
           (id, user_id, token, expires_at, active_household_id)
         values ($1, $2, 'rls-signed-session-a',
                 pg_catalog.clock_timestamp() + interval '1 hour', $5),
                ($3, $4, 'rls-signed-session-b',
                 pg_catalog.clock_timestamp() + interval '1 hour', $6)`,
        [
          ids.sessionA,
          ids.ownerA,
          ids.sessionB,
          ids.ownerB,
          ids.householdA,
          ids.householdB,
        ],
      );

      const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
      appRole = `emdo_rls_app_${suffix}`;
      authRole = `emdo_rls_auth_${suffix}`;
      const appPassword = `app_${suffix}_${randomUUID().replaceAll('-', '')}`;
      const authPassword = `auth_${suffix}_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`create role ${quoteIdentifier(appRole)}
        login nosuperuser nocreatedb nocreaterole inherit nobypassrls
        noreplication password '${appPassword}'`);
      await admin.query(`grant emdo_app to ${quoteIdentifier(appRole)}
        with admin false, inherit true, set true`);
      await admin.query(`create role ${quoteIdentifier(authRole)}
        login nosuperuser nocreatedb nocreaterole inherit nobypassrls
        noreplication password '${authPassword}'`);
      await admin.query(`grant emdo_auth to ${quoteIdentifier(authRole)}
        with admin false, inherit true, set true`);

      appPool = new Pool({
        allowExitOnIdle: true,
        connectionString: connectionStringFor(appRole, appPassword),
        max: 1,
      });
      authPool = new Pool({
        allowExitOnIdle: true,
        connectionString: connectionStringFor(authRole, authPassword),
        max: 1,
      });
      bridge = await createPostgresBetterAuthOrganizationClaimBridge(authPool);
      emdoAuth = createEmdoBetterAuth({
        appName: 'EMDO RLS attack probe',
        baseURL: 'https://rls-attack.emdo.test',
        googleIdentity: {
          clientId: 'rls-attack-google-client',
          clientSecret: 'rls-attack-google-secret',
        },
        organizationClaimBridge: bridge,
        secret: authSecret,
        sendInvitationEmail: async () => undefined,
        sendPasswordResetEmail: async () => undefined,
        sendVerificationEmail: async () => undefined,
        trustedOrigins: ['https://rls-attack.emdo.test'],
      }) as unknown as LiveEmdoAuth;
    }, 90_000);

    afterAll(async () => {
      await appPool?.end();
      await authPool?.end();
      if (admin === undefined) return;
      for (const [role, membership] of [
        [appRole, 'emdo_app'],
        [authRole, 'emdo_auth'],
      ] as const) {
        if (role === '') continue;
        await admin
          .query(`revoke ${membership} from ${quoteIdentifier(role)}`)
          .catch(() => undefined);
        await admin
          .query(`drop role if exists ${quoteIdentifier(role)}`)
          .catch(() => undefined);
      }
      await admin.end();
    }, 60_000);

    it('denies cross-household reads and writes, private-owner bypass, and forged signed sessions', async () => {
      const passed = new Set<string>();
      const record = (name: string) => {
        expect(passed.has(name)).toBe(false);
        passed.add(name);
      };
      const runtime = await appPool.connect();
      try {
        await runtime.query('begin');
        await runtime.query('set local role emdo_app');
        await runtime.query(
          `select pg_catalog.set_config('emdo.user_id', $1, true),
                  pg_catalog.set_config('emdo.session_id', $2, true),
                  pg_catalog.set_config('emdo.request_id', $3, true)`,
          [ids.ownerA, ids.sessionA, ids.requestA],
        );

        const ownRecord = await runtime.query(
          'select id from emdo.space_records where id = $1::uuid',
          [ids.ownerARecord],
        );
        expect(ownRecord.rows).toEqual([{ id: ids.ownerARecord }]);
        record('own-private-record-read-control');
        const ownUpdate = await runtime.query(
          `update emdo.space_records
              set payload = '{"positiveControl":true}'::jsonb
            where id = $1::uuid`,
          [ids.ownerARecord],
        );
        expect(ownUpdate.rowCount).toBe(1);
        record('own-private-record-update-control');

        for (const [name, sql, values] of [
          [
            'foreign-household-read',
            'select id from emdo.households where id = $1::uuid',
            [ids.householdB],
          ],
          [
            'foreign-space-read',
            'select id from emdo.spaces where id = $1::uuid',
            [ids.ownerBPrivateSpace],
          ],
          [
            'foreign-record-read',
            'select id from emdo.space_records where id = $1::uuid',
            [ids.ownerBRecord],
          ],
        ] as const) {
          const result = await runtime.query(sql, [...values]);
          expect(result.rows, name).toEqual([]);
          record(name);
        }

        const expectPrivilegeDenial = async (
          name: string,
          sql: string,
          values: readonly string[],
        ) => {
          const savepoint = `probe_${passed.size}`;
          await runtime.query(`savepoint ${savepoint}`);
          let denial: unknown;
          try {
            await runtime.query(sql, [...values]);
          } catch (error) {
            denial = error;
          }
          await runtime.query(`rollback to savepoint ${savepoint}`);
          expect(denial, name).toMatchObject({ code: '42501' });
          record(name);
        };

        await expectPrivilegeDenial(
          'foreign-membership-read',
          'select user_id from emdo.household_memberships where household_id = $1::uuid',
          [ids.householdB],
        );
        await expectPrivilegeDenial(
          'foreign-space-insert',
          `insert into emdo.spaces
             (id, household_id, original_owner_user_id, name, visibility)
           values ($1::uuid, $2::uuid, $3::uuid, 'Forged', 'private')`,
          [ids.forgedSpace, ids.householdB, ids.ownerA],
        );
        await expectPrivilegeDenial(
          'foreign-record-insert',
          `insert into emdo.space_records
             (id, household_id, space_id, original_owner_user_id,
              record_kind, payload, actor_intent)
           values ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
                   'forged', '{}', 'Cross-household attack')`,
          [
            ids.forgedRecord,
            ids.householdB,
            ids.ownerBPrivateSpace,
            ids.ownerB,
          ],
        );
        const foreignUpdate = await runtime.query(
          `update emdo.space_records
              set payload = '{"forged":true}'::jsonb
            where id = $1::uuid`,
          [ids.ownerBRecord],
        );
        expect(foreignUpdate.rowCount).toBe(0);
        record('foreign-record-update');
        await expectPrivilegeDenial(
          'foreign-record-delete',
          'delete from emdo.space_records where id = $1::uuid',
          [ids.ownerBRecord],
        );

        const memberPrivateSpace = await runtime.query(
          'select id from emdo.spaces where id = $1::uuid',
          [ids.memberAPrivateSpace],
        );
        expect(memberPrivateSpace.rows).toEqual([]);
        record('member-private-space-read');
        const memberPrivateRecord = await runtime.query(
          'select id from emdo.space_records where id = $1::uuid',
          [ids.memberARecord],
        );
        expect(memberPrivateRecord.rows).toEqual([]);
        record('member-private-record-read');
        const memberPrivateUpdate = await runtime.query(
          `update emdo.space_records
              set payload = '{"ownerBypass":true}'::jsonb
            where id = $1::uuid`,
          [ids.memberARecord],
        );
        expect(memberPrivateUpdate.rowCount).toBe(0);
        record('member-private-record-update');
        await expectPrivilegeDenial(
          'member-private-record-delete',
          'delete from emdo.space_records where id = $1::uuid',
          [ids.memberARecord],
        );
      } finally {
        await runtime.query('rollback').catch(() => undefined);
        runtime.release();
      }

      const validSignature = await makeSignature(
        'rls-signed-session-a',
        authSecret,
      );
      const validHeaders = new Headers({
        cookie: `__Secure-emdo.session_token=rls-signed-session-a.${validSignature}`,
      });
      const validResponse = await emdoAuth.handler(
        new Request('https://rls-attack.emdo.test/api/auth/organization/list', {
          headers: validHeaders,
        }),
      );
      expect(validResponse.status).toBe(200);
      record('valid-signed-session');
      const organizations = (await validResponse.json()) as { id?: unknown }[];
      expect(organizations.map(({ id }) => id)).toEqual([ids.householdA]);
      record('signed-session-household-scope');

      const forgedSignature = `${validSignature.slice(0, -1)}${
        validSignature.endsWith('a') ? 'b' : 'a'
      }`;
      const forgedResponse = await emdoAuth.handler(
        new Request('https://rls-attack.emdo.test/api/auth/organization/list', {
          headers: {
            cookie: `__Secure-emdo.session_token=rls-signed-session-a.${forgedSignature}`,
          },
        }),
      );
      let forgedSessionDenied = [401, 403].includes(forgedResponse.status);
      if (forgedResponse.status === 200) {
        const body = await forgedResponse.json();
        forgedSessionDenied = Array.isArray(body) && body.length === 0;
      }
      expect(forgedSessionDenied).toBe(true);
      record('forged-signed-session');

      expect(passed.size).toBe(17);
      const positiveControlCount = 2;
      const proof = {
        crossHouseholdReadDenied: true,
        crossHouseholdWriteDenied: true,
        privateOwnerBypassDenied: true,
        signedClaimScope: 'passed',
        attackCaseCount: passed.size - positiveControlCount,
      } as const;
      if (proofResultPath !== undefined) {
        if (
          !isAbsolute(proofResultPath) ||
          basename(proofResultPath) !== 'rls-attack-proof.json'
        ) {
          throw new Error('RLS attack proof output path is invalid.');
        }
        const probe = createRlsCrossHouseholdProbe({
          context: requiredProbeContext(),
          database: {
            postgresqlMajor: 18,
            serverVersionNum,
            pgvectorExtensionVersion,
          },
          observedAt: new Date().toISOString(),
          proof,
        });
        await writeFile(proofResultPath, `${JSON.stringify(probe)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
      }
    }, 90_000);
  },
);

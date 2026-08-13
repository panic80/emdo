import { randomUUID } from 'node:crypto';

import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresSpaceAccessGrantService } from '../auth/space-access-grants.js';
import { createDatabaseClient, type EmdoDatabaseClient } from '../client.js';
import { loadOrderedMigrations } from '../migrations.js';
import { PostgresManagerTurnStore } from './manager-turn-store.js';
import { PostgresRunEventSource } from './run-event-source.js';

const databaseUrl = process.env.TEST_RUN_EVENT_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const ids = Object.freeze({
  user: '84900000-0000-4000-8000-000000000001',
  session: '84900000-0000-4000-8000-000000000002',
  firstRequest: '84900000-0000-4000-8000-000000000003',
  secondRequest: '84900000-0000-4000-8000-000000000004',
  household: '84900000-0000-4000-8000-000000000005',
  membership: '84900000-0000-4000-8000-000000000006',
  space: '84900000-0000-4000-8000-000000000007',
});

const loginRole = 'emdo_run_event_integration_login';
const loginPassword = `emdo-test-${randomUUID()}`;

const collect = async <Value>(
  input: AsyncIterable<Value>,
): Promise<Value[]> => {
  const values: Value[] = [];
  for await (const value of input) values.push(value);
  return values;
};

describeDatabase(
  'PostgreSQL 17 grant-bound manager run replay (isolated database only)',
  () => {
    let admin: import('pg').Client;
    let runtime: EmdoDatabaseClient;
    let firstPrincipal: Readonly<{
      userId: string;
      sessionId: string;
      householdId: string;
      role: 'owner' | 'member';
      emailVerified: true;
      spaceAccessGrantId: string;
      collectionAuthorizationScopeFingerprint: ReturnType<
        typeof EffectiveAuthorizationScopeFingerprintSchema.parse
      >;
    }>;
    let secondPrincipal: typeof firstPrincipal;
    let runId: string;

    beforeAll(async () => {
      const { Client } = await import('pg');
      admin = new Client({ connectionString: databaseUrl });
      await admin.connect();
      const version = await admin.query(
        `select current_setting('server_version_num')::integer as version`,
      );
      if (Math.trunc(Number(version.rows[0]?.version) / 10_000) !== 17) {
        throw new Error('TEST_RUN_EVENT_DATABASE_URL must use PostgreSQL 17');
      }
      const existingSchema = await admin.query(
        `select 1 from pg_catalog.pg_namespace where nspname = 'emdo'`,
      );
      if (existingSchema.rowCount !== 0) {
        throw new Error(
          'TEST_RUN_EVENT_DATABASE_URL must point at an isolated empty database',
        );
      }
      for (const migration of await loadOrderedMigrations()) {
        await admin.query(migration.sql);
      }
      await admin.query(
        `insert into emdo.auth_users(id, name, email, email_verified)
         values ($1, 'Run Event User', 'run-event@example.test', true)`,
        [ids.user],
      );
      await admin.query(
        `insert into emdo.households(id, name, slug, created_by_user_id)
         values ($1, 'Run Event Household', 'run-event-integration', $2)`,
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
         ) values ($1, $2, $3, 'Private', 'private')`,
        [ids.space, ids.household, ids.user],
      );
      await admin.query(
        `insert into emdo.auth_sessions(
           id, user_id, token, expires_at, active_household_id
         ) values ($1, $2, 'run-event-integration-token',
                   pg_catalog.clock_timestamp() + interval '1 hour', $3)`,
        [ids.session, ids.user, ids.household],
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
        max: 2,
        applicationName: 'emdo-run-event-integration',
      });
      const grants = new PostgresSpaceAccessGrantService(runtime.scopedPool);
      const firstScope = await grants.resolveActivePrincipalScope({
        activeMembershipId: ids.membership,
        householdId: ids.household,
        requestId: ids.firstRequest,
        role: 'owner',
        sessionId: ids.session,
        userId: ids.user,
      });
      firstPrincipal = Object.freeze({
        userId: firstScope.userId,
        sessionId: firstScope.sessionId,
        householdId: firstScope.householdId,
        role: firstScope.role,
        emailVerified: firstScope.emailVerified,
        spaceAccessGrantId: firstScope.spaceAccessGrantId,
        collectionAuthorizationScopeFingerprint:
          EffectiveAuthorizationScopeFingerprintSchema.parse(
            firstScope.collectionAuthorizationScopeFingerprint,
          ),
      });

      const store = new PostgresManagerTurnStore(runtime.scopedPool, {
        requestedModel: 'gpt-5.6-terra',
      });
      const claimed = await store.claim({
        request: {
          schemaVersion: 1,
          message: 'What is on my schedule?',
          routeHint: 'scheduler',
        },
        principal: firstPrincipal,
        requestId: ids.firstRequest,
        idempotencyKey: 'run-event-integration-claim-0001',
      });
      if (claimed.status !== 'claimed') {
        throw new Error(
          'Manager turn was not claimed in the isolated database',
        );
      }
      runId = claimed.runId;
      await expect(
        store.complete({
          claimId: claimed.claimId,
          ownershipToken: claimed.ownershipToken,
          runId,
          result: {
            status: 'failed',
            runId,
            localTraceReference: 'run-event-integration-trace',
            safeError: {
              code: 'agent-model-unavailable',
              message: 'The model was unavailable.',
              retryable: true,
            },
            specialistOutcomes: [],
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              modelCostCadMinor: 0,
            },
          },
        }),
      ).resolves.toMatchObject({ status: 'completed' });

      const secondScope = await grants.resolveActivePrincipalScope({
        activeMembershipId: ids.membership,
        householdId: ids.household,
        requestId: ids.secondRequest,
        role: 'owner',
        sessionId: ids.session,
        userId: ids.user,
      });
      secondPrincipal = Object.freeze({
        userId: secondScope.userId,
        sessionId: secondScope.sessionId,
        householdId: secondScope.householdId,
        role: secondScope.role,
        emailVerified: secondScope.emailVerified,
        spaceAccessGrantId: secondScope.spaceAccessGrantId,
        collectionAuthorizationScopeFingerprint:
          EffectiveAuthorizationScopeFingerprintSchema.parse(
            secondScope.collectionAuthorizationScopeFingerprint,
          ),
      });
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

    it('replays persisted events with a rotated fresh grant but denies the stale request grant', async () => {
      const source = new PostgresRunEventSource(runtime.scopedPool);
      const current = await collect(
        await source.open({
          runId,
          afterSequence: 0,
          principal: secondPrincipal,
          requestId: ids.secondRequest,
          abortSignal: new AbortController().signal,
        }),
      );
      expect(current.map(({ sequence, type }) => ({ sequence, type }))).toEqual(
        [
          { sequence: 1, type: 'run.accepted' },
          { sequence: 2, type: 'run.failed' },
        ],
      );
      expect(current.every((event) => !('id' in event))).toBe(true);

      await expect(
        collect(
          await source.open({
            runId,
            afterSequence: 0,
            principal: firstPrincipal,
            requestId: ids.secondRequest,
            abortSignal: new AbortController().signal,
          }),
        ),
      ).rejects.toMatchObject({ code: 'authorization-revoked' });
    });

    it('keeps the helper private and grants only the bounded aggregate', async () => {
      const privileges = await admin.query(
        `select
           pg_catalog.has_function_privilege(
             $1, 'emdo.read_agent_run_events(uuid,uuid,bigint,integer)',
             'EXECUTE'
           ) as can_read,
           pg_catalog.has_function_privilege(
             $1, 'emdo.lock_current_authorization_scope(uuid,uuid,uuid)',
             'EXECUTE'
           ) as can_lock_scope`,
        [loginRole],
      );
      expect(privileges.rows[0]).toEqual({
        can_read: true,
        can_lock_scope: false,
      });
    });
  },
);

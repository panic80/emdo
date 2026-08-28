import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type EmdoDatabaseClient } from '../client.js';
import { loadOrderedMigrations } from '../migrations.js';
import {
  PostgresSpendLedger,
  checkPostgresAudioSpendReadiness,
} from './spend-ledger.js';

const databaseUrl = process.env.TEST_AUDIO_SPEND_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const ids = Object.freeze({
  user: '87400000-0000-4000-8000-000000000001',
  session: '87400000-0000-4000-8000-000000000002',
  request: '87400000-0000-4000-8000-000000000003',
  household: '87400000-0000-4000-8000-000000000004',
  membership: '87400000-0000-4000-8000-000000000005',
  wrongHousehold: '87400000-0000-4000-8000-000000000006',
});
const loginRole = 'emdo_api_login';
const loginPassword = `emdo-audio-spend-${randomUUID()}`;

describeDatabase(
  'PostgreSQL 17 request-bound audio spend authority (isolated database only)',
  () => {
    let admin: import('pg').Client;
    let runtime: EmdoDatabaseClient;
    let period: string;

    beforeAll(async () => {
      const { Client } = await import('pg');
      admin = new Client({ connectionString: databaseUrl });
      await admin.connect();

      const server = await admin.query<{
        is_superuser: boolean;
        server_version_num: string;
      }>(`select role.rolsuper as is_superuser,
                 pg_catalog.current_setting('server_version_num') as server_version_num
            from pg_catalog.pg_roles as role
           where role.rolname = current_user`);
      expect(server.rows[0]).toMatchObject({ is_superuser: true });
      expect(Number(server.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(
        170_000,
      );
      expect(Number(server.rows[0]?.server_version_num)).toBeLessThan(180_000);

      const existing = await admin.query<{ emdo: string | null }>(
        "select pg_catalog.to_regnamespace('emdo')::text as emdo",
      );
      if (existing.rows[0]?.emdo !== null) {
        throw new Error(
          'TEST_AUDIO_SPEND_DATABASE_URL must point at an isolated empty database',
        );
      }

      const migrations = await loadOrderedMigrations();
      expect(migrations).toHaveLength(20);
      expect(migrations.at(-1)?.id).toBe('0019_manager_turn_spend_warning');
      for (const migration of migrations) await admin.query(migration.sql);

      await admin.query(
        `insert into emdo.auth_users(id, name, email, email_verified)
         values ($1, 'Audio Spend Owner', 'audio-spend@example.test', true)`,
        [ids.user],
      );
      await admin.query(
        `insert into emdo.households(id, name, slug, created_by_user_id)
         values ($1, 'Audio Spend Household', 'audio-spend-integration', $2)`,
        [ids.household, ids.user],
      );
      await admin.query(
        `insert into emdo.household_memberships(
           id, household_id, user_id, role, status, joined_at
         ) values ($1, $2, $3, 'owner', 'active', pg_catalog.clock_timestamp())`,
        [ids.membership, ids.household, ids.user],
      );
      await admin.query(
        `insert into emdo.auth_sessions(
           id, user_id, token, expires_at, active_household_id
         ) values ($1, $2, 'audio-spend-integration-token',
                   pg_catalog.clock_timestamp() + interval '1 hour', $3)`,
        [ids.session, ids.user, ids.household],
      );
      await admin.query(
        `create role ${loginRole} login nosuperuser nocreatedb nocreaterole
          inherit nobypassrls noreplication password '${loginPassword}'`,
      );
      await admin.query(`grant emdo_app to ${loginRole}`);

      const currentPeriod = await admin.query<{ period: string }>(
        `select pg_catalog.to_char(
           pg_catalog.clock_timestamp() at time zone 'America/Toronto',
           'YYYY-MM'
         ) as period`,
      );
      const resolvedPeriod = currentPeriod.rows[0]?.period;
      if (resolvedPeriod === undefined) {
        throw new Error('PostgreSQL did not return the current billing period');
      }
      period = resolvedPeriod;

      const runtimeUrl = new URL(databaseUrl!);
      runtimeUrl.username = loginRole;
      runtimeUrl.password = loginPassword;
      runtime = createDatabaseClient({
        connectionString: runtimeUrl.toString(),
        max: 1,
        applicationName: 'emdo-audio-spend-integration',
      });
    }, 60_000);

    afterAll(async () => {
      await runtime?.close();
      if (admin !== undefined) {
        await admin.query(
          `revoke emdo_metering_executor, emdo_app from ${loginRole}`,
        );
        await admin.query(`drop role if exists ${loginRole}`);
        await admin.end();
      }
    });

    it('reports ready only for the exact least-privilege API role', async () => {
      await expect(
        checkPostgresAudioSpendReadiness(runtime.scopedPool),
      ).resolves.toBe(true);
      await expect(
        runtime.pool.query('select count(*) from emdo.ai_spend_reservations'),
      ).rejects.toThrow(/permission denied/u);
    });

    it('reserves, releases, dispatches, and settles through request-bound aggregates', async () => {
      const ledger = new PostgresSpendLedger(runtime.scopedPool, {
        userId: ids.user,
        sessionId: ids.session,
        requestId: ids.request,
        householdId: ids.household,
      });
      const thresholds = {
        warningCadMinor: 5_000,
        limitCadMinor: 7_500,
      } as const;

      const released = {
        authorizationHash: 'a'.repeat(64),
        category: 'audio' as const,
        estimatedCadMinor: 2,
        executionId: 'audio-spend-release-execution-0001',
        householdId: ids.household,
        period,
        requestHash: 'b'.repeat(64),
        reservationId: 'audio-spend-release-reservation-0001',
      };
      await expect(ledger.reserve(released, thresholds)).resolves.toMatchObject(
        {
          status: 'reserved',
          projectedCadMinor: 2,
        },
      );
      await expect(
        ledger.release({
          reservationId: released.reservationId,
          authorizationHash: released.authorizationHash,
        }),
      ).resolves.toMatchObject({ status: 'released' });

      const settled = {
        authorizationHash: 'c'.repeat(64),
        category: 'audio' as const,
        estimatedCadMinor: 3,
        executionId: 'audio-spend-settle-execution-0001',
        householdId: ids.household,
        period,
        requestHash: 'd'.repeat(64),
        reservationId: 'audio-spend-settle-reservation-0001',
      };
      await expect(ledger.reserve(settled, thresholds)).resolves.toMatchObject({
        status: 'reserved',
        projectedCadMinor: 3,
      });
      await expect(
        ledger.markDispatched({
          reservationId: settled.reservationId,
          authorizationHash: settled.authorizationHash,
        }),
      ).resolves.toMatchObject({ status: 'dispatched' });
      await expect(
        ledger.settle({
          reservationId: settled.reservationId,
          executionId: settled.executionId,
          actualCadMinor: 4,
        }),
      ).resolves.toMatchObject({
        status: 'settled',
        actualCadMinor: 4,
        reservationExceeded: true,
      });
    });

    it('denies a request for a household outside the active membership', async () => {
      const ledger = new PostgresSpendLedger(runtime.scopedPool, {
        userId: ids.user,
        sessionId: ids.session,
        requestId: ids.request,
        householdId: ids.wrongHousehold,
      });

      await expect(
        ledger.reserve(
          {
            authorizationHash: 'e'.repeat(64),
            category: 'audio',
            estimatedCadMinor: 1,
            executionId: 'audio-spend-wrong-household-execution',
            householdId: ids.wrongHousehold,
            period,
            requestHash: 'f'.repeat(64),
            reservationId: 'audio-spend-wrong-household-reservation',
          },
          { warningCadMinor: 5_000, limitCadMinor: 7_500 },
        ),
      ).rejects.toThrow(/scope is no longer active/u);
    });

    it('fails readiness closed for reversible privilege, routine, role, and membership drift', async () => {
      const expectDrift = async (drift: string, restore: string) => {
        await admin.query(drift);
        try {
          await expect(
            checkPostgresAudioSpendReadiness(runtime.scopedPool),
          ).resolves.toBe(false);
        } finally {
          await admin.query(restore);
        }
        await expect(
          checkPostgresAudioSpendReadiness(runtime.scopedPool),
        ).resolves.toBe(true);
      };

      await expectDrift(
        `grant select on emdo.ai_spend_reservations to ${loginRole}`,
        `revoke select on emdo.ai_spend_reservations from ${loginRole}`,
      );
      await expectDrift(
        'revoke insert on emdo.ai_spend_reservations from emdo_metering_executor',
        'grant insert on emdo.ai_spend_reservations to emdo_metering_executor',
      );
      await expectDrift(
        'revoke usage on schema emdo from emdo_metering_executor',
        'grant usage on schema emdo to emdo_metering_executor',
      );
      await expectDrift(
        'drop policy ai_spend_metering_executor_update on emdo.ai_spend_reservations',
        `create policy ai_spend_metering_executor_update
           on emdo.ai_spend_reservations
          for all to emdo_metering_executor using (true) with check (true)`,
      );
      await expectDrift(
        `alter function emdo.reserve_ai_spend(
           text, uuid, text, text, text, text, text, bigint, bigint, bigint
         ) reset row_security`,
        `alter function emdo.reserve_ai_spend(
           text, uuid, text, text, text, text, text, bigint, bigint, bigint
         ) set row_security to on`,
      );
      await expectDrift(
        'alter role emdo_metering_executor inherit',
        'alter role emdo_metering_executor noinherit',
      );
      await expectDrift(
        `grant execute on function emdo.reserve_ai_spend(
           text, uuid, text, text, text, text, text, bigint, bigint, bigint
         ) to public`,
        `revoke execute on function emdo.reserve_ai_spend(
           text, uuid, text, text, text, text, text, bigint, bigint, bigint
         ) from public`,
      );
      await expectDrift(
        `grant emdo_metering_executor to ${loginRole}`,
        `revoke emdo_metering_executor from ${loginRole}`,
      );
    });
  },
);

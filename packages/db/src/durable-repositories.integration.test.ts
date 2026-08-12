import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresApprovalCheckpointRepository } from './agent/approval-checkpoint-repository.js';
import { PostgresAgentMemoryRepository } from './agent/memory-repository.js';
import { PostgresSpendLedger } from './agent/spend-ledger.js';
import { createDatabaseClient, type EmdoDatabaseClient } from './client.js';
import { loadOrderedMigrations } from './migrations.js';
import { PostgresCalendarWriteReceiptStore } from './scheduler/calendar-write-receipts.js';
import { PostgresSyncRepository } from './sync/postgres-repository.js';

const databaseUrl = process.env.TEST_DURABLE_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const ids = {
  user: '70000000-0000-4000-8000-000000000001',
  session: '70000000-0000-4000-8000-000000000002',
  request: '70000000-0000-4000-8000-000000000003',
  household: '70000000-0000-4000-8000-000000000004',
  space: '70000000-0000-4000-8000-000000000005',
  run: '70000000-0000-4000-8000-000000000006',
  checkpoint: '70000000-0000-4000-8000-000000000007',
  client: '70000000-0000-4000-8000-000000000008',
  operation: '70000000-0000-4000-8000-000000000009',
};
const principal = {
  userId: ids.user,
  sessionId: ids.session,
  requestId: ids.request,
  householdId: ids.household,
};
const loginRole = 'emdo_durable_repository_test_login';
const loginPassword = `durable_${randomUUID().replaceAll('-', '')}`;

describeDatabase(
  'durable PostgreSQL repositories (requires TEST_DURABLE_DATABASE_URL)',
  () => {
    let admin: import('pg').Client;
    let runtime: EmdoDatabaseClient;

    beforeAll(async () => {
      const { Client } = await import('pg');
      admin = new Client({ connectionString: databaseUrl });
      await admin.connect();
      for (const migration of await loadOrderedMigrations()) {
        await admin.query(migration.sql);
      }
      await admin.query(`
        insert into emdo.auth_users (id, name, email, email_verified)
        values ('${ids.user}', 'Durable User', 'durable@example.test', true);
        insert into emdo.households (id, name, slug, created_by_user_id)
        values ('${ids.household}', 'Durable Household', 'durable-household', '${ids.user}');
        insert into emdo.household_memberships
          (household_id, user_id, role, status, joined_at)
        values ('${ids.household}', '${ids.user}', 'owner', 'active', pg_catalog.clock_timestamp());
        insert into emdo.spaces
          (id, household_id, original_owner_user_id, name, visibility)
        values ('${ids.space}', '${ids.household}', '${ids.user}', 'Private', 'private');
        insert into emdo.auth_sessions
          (id, user_id, token, expires_at, active_household_id)
        values ('${ids.session}', '${ids.user}', 'durable-test-session-token',
                pg_catalog.clock_timestamp() + interval '1 hour', '${ids.household}');
      `);
      await admin.query(`drop role if exists ${loginRole}`);
      await admin.query(
        `create role ${loginRole} login nosuperuser nocreatedb nocreaterole
          inherit nobypassrls noreplication password '${loginPassword}'`,
      );
      await admin.query(`grant emdo_app to ${loginRole}`);

      const runtimeUrl = new URL(databaseUrl!);
      runtimeUrl.username = loginRole;
      runtimeUrl.password = loginPassword;
      runtime = createDatabaseClient({
        connectionString: runtimeUrl.toString(),
        applicationName: 'emdo-durable-integration',
      });
    }, 30_000);

    afterAll(async () => {
      await runtime?.close();
      if (admin !== undefined) {
        await admin.query(`revoke emdo_app from ${loginRole}`);
        await admin.query(`drop role if exists ${loginRole}`);
        await admin.end();
      }
    });

    it('persists spend, run memory, encrypted checkpoints, sync CAS, and Calendar reconciliation', async () => {
      const memory = new PostgresAgentMemoryRepository(
        runtime.scopedPool,
        principal,
      );
      await expect(
        memory.createRun({
          runId: ids.run,
          spaceId: ids.space,
          agentId: 'scheduler.agent',
          agentVersion: '1.0.0',
          requestedModel: 'gpt-5.6-luna',
        }),
      ).resolves.toMatchObject({ id: ids.run, status: 'queued' });
      await expect(
        memory.appendRunEvent({
          runId: ids.run,
          sequence: 1,
          eventType: 'response.started',
          payload: { durable: true },
        }),
      ).resolves.toMatchObject({ sequence: 1 });

      const spend = new PostgresSpendLedger(runtime.scopedPool, principal);
      const reservationId = 'durable-reservation-0001';
      const executionId = 'durable-execution-000001';
      await expect(
        spend.reserve(
          {
            reservationId,
            executionId,
            householdId: ids.household,
            period: '2026-08',
            category: 'model',
            estimatedCadMinor: 100,
            authorizationHash: 'a'.repeat(64),
            requestHash: 'b'.repeat(64),
          },
          { warningCadMinor: 5_000, limitCadMinor: 7_500 },
        ),
      ).resolves.toMatchObject({ status: 'reserved', projectedCadMinor: 100 });
      await spend.markDispatched({
        reservationId,
        authorizationHash: 'a'.repeat(64),
      });
      await expect(
        spend.settle({ reservationId, executionId, actualCadMinor: 125 }),
      ).resolves.toMatchObject({
        status: 'settled',
        actualCadMinor: 125,
        reservationExceeded: true,
      });

      const checkpoints = new PostgresApprovalCheckpointRepository(
        runtime.scopedPool,
        principal,
      );
      const createdAt = new Date();
      await expect(
        checkpoints.create({
          checkpointId: ids.checkpoint,
          householdId: ids.household,
          userId: ids.user,
          runId: ids.run,
          agentGraphHash: 'c'.repeat(64),
          sdkVersion: '0.14.3',
          formatVersion: 1,
          revision: 1,
          state: 'pending',
          createdAt: createdAt.toISOString(),
          expiresAt: new Date(createdAt.getTime() + 5 * 60_000).toISOString(),
          updatedAt: createdAt.toISOString(),
          sealedState: 'v1.key.nonce.tag.ciphertext',
        }),
      ).resolves.toBe('created');
      await expect(
        checkpoints.consume({
          checkpointId: ids.checkpoint,
          expectedRevision: 1,
          identity: {
            checkpointId: ids.checkpoint,
            householdId: ids.household,
            userId: ids.user,
            runId: ids.run,
            agentGraphHash: 'c'.repeat(64),
            sdkVersion: '0.14.3',
          },
        }),
      ).resolves.toMatchObject({ status: 'consumed' });

      const sync = new PostgresSyncRepository(runtime.scopedPool);
      await sync.registerClient({
        principal,
        clientId: ids.client,
        displayName: 'Integration device',
      });
      await expect(
        sync.resolveWriteScope({
          authenticatedSessionId: ids.session,
          clientId: ids.client,
        }),
      ).resolves.toMatchObject({
        userId: ids.user,
        householdId: ids.household,
      });
      await expect(
        sync.executeOnce({
          operation: {
            schemaVersion: 1,
            clientId: ids.client,
            operationId: ids.operation,
            entity: { type: 'shopping.item', id: 'milk' },
            mutation: {
              kind: 'create',
              payload: {
                spaceId: ids.space,
                value: {
                  name: 'Milk',
                  unit: 'carton',
                  quantityMinorUnits: 2_000,
                },
              },
            },
            baseRevision: 0,
            dependencies: [],
            actorIntent: 'Add milk to the list',
            createdAt: new Date().toISOString(),
          },
          fingerprint: 'd'.repeat(64),
          context: {
            source: 'offline-sync-api',
            externalEffects: 'forbidden',
            mayEnqueueProviderWrites: false,
            authorizationRevalidation: 'required-in-transaction',
            authenticatedUserId: ids.user,
            authenticatedSessionId: ids.session,
            householdId: ids.household,
            role: 'owner',
            requestId: ids.request,
            writableSpaceIds: [ids.space],
            targetSpaceId: ids.space,
          },
        }),
      ).resolves.toEqual({
        kind: 'executed',
        outcome: {
          status: 'applied',
          revision: 1,
          resolution: 'created',
          conflicts: [],
        },
      });

      const calendar = new PostgresCalendarWriteReceiptStore(
        runtime.scopedPool,
        principal,
        { spaceId: ids.space, runId: ids.run },
      );
      const receiptKey = 'e'.repeat(64);
      const commandHash = 'f'.repeat(64);
      await expect(calendar.acquire(receiptKey, commandHash)).resolves.toEqual({
        status: 'acquired',
      });
      await calendar.complete(receiptKey, commandHash, {
        status: 'indeterminate',
        reconciliationRequired: true,
        safeError: {
          code: 'calendar-provider-indeterminate',
          message: 'Provider state is unknown.',
          retryable: false,
        },
      });
      await expect(calendar.listReconciliationMarkers()).resolves.toHaveLength(
        1,
      );
    });

    it('fails closed for a revoked or unknown session claim', async () => {
      const denied = new PostgresApprovalCheckpointRepository(
        runtime.scopedPool,
        {
          ...principal,
          sessionId: '70000000-0000-4000-8000-000000000099',
        },
      );
      await expect(denied.get(ids.checkpoint)).resolves.toBeUndefined();
    });
  },
);

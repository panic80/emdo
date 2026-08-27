import { generateKeyPairSync } from 'node:crypto';

import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from '../migrations.js';
import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import { createPostgresSyncGatewayRuntime } from './api-gateway.js';

const databaseUrl = process.env.TEST_SYNC_CONFLICT_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const ids = Object.freeze({
  user: '89000000-0000-4000-8000-000000000001',
  session: '89000000-0000-4000-8000-000000000002',
  household: '89000000-0000-4000-8000-000000000003',
  space: '89000000-0000-4000-8000-000000000004',
  grant: '89000000-0000-4000-8000-000000000005',
  client: '89000000-0000-4000-8000-000000000006',
  registerRequest: '89000000-0000-4000-8000-000000000007',
  shoppingRequest: '89000000-0000-4000-8000-000000000008',
  shoppingOperation: '89000000-0000-4000-8000-000000000009',
  scheduleCreateRequest: '89000000-0000-4000-8000-000000000010',
  scheduleCreateOperation: '89000000-0000-4000-8000-000000000011',
  scheduleRemoteRequest: '89000000-0000-4000-8000-000000000012',
  scheduleRemoteOperation: '89000000-0000-4000-8000-000000000013',
  scheduleLocalRequest: '89000000-0000-4000-8000-000000000014',
  scheduleLocalOperation: '89000000-0000-4000-8000-000000000015',
  forgedRequest: '89000000-0000-4000-8000-000000000016',
  forgedOperation: '89000000-0000-4000-8000-000000000017',
  retryableRequest: '89000000-0000-4000-8000-000000000018',
  retryableOperation: '89000000-0000-4000-8000-000000000019',
  missingDependency: '89000000-0000-4000-8000-000000000020',
});

const principal = Object.freeze({
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  privateSpaceId: ids.space,
  role: 'owner' as const,
  emailVerified: true as const,
  spaceAccessGrantId: ids.grant,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('a'.repeat(64)),
});

const schedulerBase = Object.freeze({
  id: 'appointment',
  title: 'Dentist',
  notes: null,
  location: null,
  startsAt: '2026-08-11T14:00:00.000-04:00',
  endsAt: '2026-08-11T15:00:00.000-04:00',
  recurrence: null,
  attendees: Object.freeze([]),
  completion: 'open',
});

const applicationPool = (pool: import('pg').Pool): DatabasePool => ({
  connect: async () => {
    const client = await pool.connect();
    try {
      await client.query('set session authorization emdo_api_login');
    } catch (error) {
      client.release(true);
      throw error;
    }
    const scoped: DatabaseClient = {
      query: async (sql, parameters = []) => {
        const result = await client.query(sql, [...parameters]);
        return {
          rowCount: result.rowCount ?? result.rows.length,
          rows: result.rows as readonly Record<string, unknown>[],
        };
      },
      // Session authorization must never leak to another pool borrower.
      release: () => client.release(true),
    };
    return scoped;
  },
});

describeDatabase(
  'PostgreSQL 18 deterministic sync conflicts (requires isolated TEST_SYNC_CONFLICT_DATABASE_URL)',
  () => {
    let admin: import('pg').Client;
    let pool: import('pg').Pool;
    let runtime: ReturnType<typeof createPostgresSyncGatewayRuntime>;
    let createdApplicationRole = false;
    let grantedApplicationMembership = false;

    beforeAll(async () => {
      const { Client, Pool } = await import('pg');
      admin = new Client({ connectionString: databaseUrl });
      await admin.connect();
      const identity = await admin.query(
        `select pg_catalog.current_setting('server_version_num')::integer
                  as server_version_num,
                role.rolsuper as is_superuser
           from pg_catalog.pg_roles as role
          where role.rolname = current_user`,
      );
      const version = Number(identity.rows[0]?.server_version_num);
      if (version < 180_000 || version >= 190_000) {
        throw new Error(
          'TEST_SYNC_CONFLICT_DATABASE_URL must use PostgreSQL 18',
        );
      }
      if (identity.rows[0]?.is_superuser !== true) {
        throw new Error(
          'TEST_SYNC_CONFLICT_DATABASE_URL must use a disposable superuser database',
        );
      }
      const existingSchema = await admin.query(
        `select 1 from pg_catalog.pg_namespace where nspname = 'emdo'`,
      );
      if (existingSchema.rowCount !== 0) {
        throw new Error(
          'TEST_SYNC_CONFLICT_DATABASE_URL must point at an isolated empty database',
        );
      }
      for (const migration of await loadOrderedMigrations()) {
        await admin.query(migration.sql);
      }

      const existingApplicationRole = await admin.query(
        `select rolcanlogin, rolsuper, rolinherit, rolbypassrls,
                rolcreatedb, rolcreaterole, rolreplication
           from pg_catalog.pg_roles
          where rolname = 'emdo_api_login'`,
      );
      if (existingApplicationRole.rowCount === 0) {
        await admin.query(
          `create role emdo_api_login login nosuperuser nocreatedb
             nocreaterole inherit nobypassrls noreplication`,
        );
        createdApplicationRole = true;
      } else {
        const role = existingApplicationRole.rows[0];
        if (
          role?.rolcanlogin !== true ||
          role.rolsuper !== false ||
          role.rolinherit !== true ||
          role.rolbypassrls !== false ||
          role.rolcreatedb !== false ||
          role.rolcreaterole !== false ||
          role.rolreplication !== false
        ) {
          throw new Error(
            'Existing emdo_api_login role is unsafe for this test',
          );
        }
      }
      const existingMembership = await admin.query(
        `select membership.inherit_option, membership.set_option,
                membership.admin_option
           from pg_catalog.pg_auth_members as membership
           join pg_catalog.pg_roles as parent on parent.oid = membership.roleid
           join pg_catalog.pg_roles as child on child.oid = membership.member
          where parent.rolname = 'emdo_app'
            and child.rolname = 'emdo_api_login'`,
      );
      if (existingMembership.rowCount === 0) {
        await admin.query(
          `grant emdo_app to emdo_api_login
             with inherit true, set true, admin false`,
        );
        grantedApplicationMembership = true;
      } else if (
        existingMembership.rows[0]?.inherit_option !== true ||
        existingMembership.rows[0]?.set_option !== true ||
        existingMembership.rows[0]?.admin_option !== false
      ) {
        throw new Error('Existing emdo_api_login membership is unsafe');
      }

      await admin.query(
        `insert into emdo.auth_users (id, name, email, email_verified)
         values ($1, 'Sync User', 'sync-conflict@example.test', true)`,
        [ids.user],
      );
      await admin.query(
        `insert into emdo.households (id, name, slug, created_by_user_id)
         values ($1, 'Sync Household', 'sync-conflict-household', $2)`,
        [ids.household, ids.user],
      );
      await admin.query(
        `insert into emdo.household_memberships
           (household_id, user_id, role, status, joined_at)
         values ($1, $2, 'owner', 'active', pg_catalog.clock_timestamp())`,
        [ids.household, ids.user],
      );
      await admin.query(
        `insert into emdo.spaces
           (id, household_id, original_owner_user_id, name, visibility)
         values ($1, $2, $3, 'Private', 'private')`,
        [ids.space, ids.household, ids.user],
      );
      await admin.query(
        `insert into emdo.auth_sessions
           (id, user_id, token, expires_at, active_household_id)
         values ($1, $2, 'sync-conflict-session-token',
                 pg_catalog.clock_timestamp() + interval '1 hour', $3)`,
        [ids.session, ids.user, ids.household],
      );

      pool = new Pool({
        application_name: 'emdo-sync-conflict-integration',
        connectionString: databaseUrl,
        max: 8,
      });
      const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
      runtime = createPostgresSyncGatewayRuntime({
        pool: applicationPool(pool),
        publicOrigin: 'https://emdo.example',
        powerSyncEndpoint: 'https://emdo.example/powersync',
        keyRing: {
          current: {
            kid: 'sync-integration-v1',
            privateKey: keys.privateKey,
          },
          previous: [],
        },
      });
    }, 60_000);

    afterAll(async () => {
      await pool?.end();
      if (admin !== undefined) {
        if (grantedApplicationMembership) {
          await admin
            .query('revoke emdo_app from emdo_api_login')
            .catch(() => undefined);
        }
        if (createdApplicationRole) {
          await admin
            .query('drop role if exists emdo_api_login')
            .catch(() => undefined);
        }
        await admin.end();
      }
    });

    it('proves the exact API role and durable payload-bound registration', async () => {
      await expect(runtime.checkReady()).resolves.toBe(true);
      const request = {
        clientId: ids.client,
        displayName: 'Integration device',
        principal,
        requestId: ids.registerRequest,
        idempotencyKey: 'sync-register:integration-device',
      };
      await expect(
        runtime.gateway.registerClient(request),
      ).resolves.toMatchObject({ status: 'registered', replayed: false });
      await expect(
        runtime.gateway.registerClient(request),
      ).resolves.toMatchObject({ status: 'registered', replayed: true });
      await expect(
        runtime.gateway.registerClient({
          ...request,
          displayName: 'Changed integration device',
        }),
      ).rejects.toMatchObject({ code: 'sync-idempotency-conflict' });
    });

    it('captures immutable revisions and resolves only a verified stale scheduler base', async () => {
      await expect(
        runtime.gateway.applyOperations({
          clientId: ids.client,
          operations: [
            {
              schemaVersion: 1,
              clientId: ids.client,
              operationId: ids.shoppingOperation,
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
              actorIntent: 'Add milk to the household list',
              createdAt: '2026-08-10T14:00:00.000Z',
            },
          ],
          principal,
          requestId: ids.shoppingRequest,
          idempotencyKey: 'sync-upload:shopping-create',
        }),
      ).resolves.toMatchObject({
        results: [{ status: 'applied', revision: 1, resolution: 'created' }],
      });

      const scheduleCreate = {
        schemaVersion: 1 as const,
        clientId: ids.client,
        operationId: ids.scheduleCreateOperation,
        entity: { type: 'scheduler.item', id: 'appointment' },
        mutation: {
          kind: 'create' as const,
          payload: { spaceId: ids.space, value: schedulerBase },
        },
        baseRevision: 0,
        dependencies: [],
        actorIntent: 'Create the dentist appointment',
        createdAt: '2026-08-10T14:01:00.000Z',
      };
      await expect(
        runtime.gateway.applyOperations({
          clientId: ids.client,
          operations: [scheduleCreate],
          principal,
          requestId: ids.scheduleCreateRequest,
          idempotencyKey: 'sync-upload:schedule-create',
        }),
      ).resolves.toMatchObject({
        results: [{ status: 'applied', revision: 1, resolution: 'created' }],
      });

      const remote = { ...schedulerBase, location: 'Toronto clinic' };
      await expect(
        runtime.gateway.applyOperations({
          clientId: ids.client,
          operations: [
            {
              ...scheduleCreate,
              operationId: ids.scheduleRemoteOperation,
              mutation: {
                kind: 'update',
                payload: {
                  spaceId: ids.space,
                  patch: { base: schedulerBase, local: remote },
                },
              },
              baseRevision: 1,
              actorIntent: 'Add the clinic location',
              createdAt: '2026-08-10T14:02:00.000Z',
            },
          ],
          principal,
          requestId: ids.scheduleRemoteRequest,
          idempotencyKey: 'sync-upload:schedule-remote',
        }),
      ).resolves.toMatchObject({
        results: [{ status: 'applied', revision: 2, resolution: 'applied' }],
      });

      const local = { ...schedulerBase, notes: 'Bring insurance card.' };
      await expect(
        runtime.gateway.applyOperations({
          clientId: ids.client,
          operations: [
            {
              ...scheduleCreate,
              operationId: ids.scheduleLocalOperation,
              mutation: {
                kind: 'update',
                payload: {
                  spaceId: ids.space,
                  patch: { base: schedulerBase, local },
                },
              },
              baseRevision: 1,
              actorIntent: 'Add the appointment note from offline state',
              createdAt: '2026-08-10T14:03:00.000Z',
            },
          ],
          principal,
          requestId: ids.scheduleLocalRequest,
          idempotencyKey: 'sync-upload:schedule-local',
        }),
      ).resolves.toMatchObject({
        results: [{ status: 'applied', revision: 3, resolution: 'merged' }],
      });

      const forgedBase = { ...schedulerBase, title: 'Forged base' };
      await expect(
        runtime.gateway.applyOperations({
          clientId: ids.client,
          operations: [
            {
              ...scheduleCreate,
              operationId: ids.forgedOperation,
              mutation: {
                kind: 'update',
                payload: {
                  spaceId: ids.space,
                  patch: { base: forgedBase, local: schedulerBase },
                },
              },
              baseRevision: 1,
              actorIntent: 'Attempt a forged stale-base update',
              createdAt: '2026-08-10T14:04:00.000Z',
            },
          ],
          principal,
          requestId: ids.forgedRequest,
          idempotencyKey: 'sync-upload:schedule-forged',
        }),
      ).resolves.toMatchObject({
        results: [
          {
            status: 'conflict',
            code: 'base-state-mismatch',
            disposition: 'terminal',
            currentRevision: 3,
          },
        ],
      });

      const revisions = await admin.query(
        `select revision, payload
           from emdo.sync_entity_revisions
          where household_id = $1 and space_id = $2
            and entity_type = 'scheduler.item' and entity_id = 'appointment'
          order by revision`,
        [ids.household, ids.space],
      );
      expect(revisions.rows).toHaveLength(3);
      expect(revisions.rows.map(({ revision }) => revision)).toEqual([1, 2, 3]);
      expect(revisions.rows[0]?.payload).toEqual(schedulerBase);
      expect(revisions.rows[2]?.payload).toMatchObject({
        location: 'Toronto clinic',
        notes: 'Bring insurance card.',
      });
    });

    it('keeps retryable requests pending and denies raw revision or receipt mutation', async () => {
      const request = {
        clientId: ids.client,
        operations: [
          {
            schemaVersion: 1 as const,
            clientId: ids.client,
            operationId: ids.retryableOperation,
            entity: { type: 'shopping.item', id: 'bread' },
            mutation: {
              kind: 'create' as const,
              payload: {
                spaceId: ids.space,
                value: {
                  name: 'Bread',
                  unit: 'loaf',
                  quantityMinorUnits: 1_000,
                },
              },
            },
            baseRevision: 0,
            dependencies: [ids.missingDependency],
            actorIntent: 'Add bread after its missing prerequisite',
            createdAt: '2026-08-10T14:05:00.000Z',
          },
        ],
        principal,
        requestId: ids.retryableRequest,
        idempotencyKey: 'sync-upload:retryable-dependency',
      };
      await expect(
        runtime.gateway.applyOperations(request),
      ).resolves.toMatchObject({
        results: [
          {
            status: 'blocked',
            code: 'dependency-missing',
            disposition: 'retryable',
          },
        ],
      });
      await expect(
        runtime.gateway.applyOperations(request),
      ).resolves.toMatchObject({
        results: [
          {
            status: 'blocked',
            code: 'dependency-missing',
            disposition: 'retryable',
          },
        ],
      });
      await expect(
        admin.query(
          `select response, completed_at
             from emdo.sync_api_request_receipts
            where household_id = $1 and user_id = $2 and client_id = $3
              and request_kind = 'apply-operations'
              and idempotency_key = 'sync-upload:retryable-dependency'`,
          [ids.household, ids.user, ids.client],
        ),
      ).resolves.toMatchObject({
        rows: [{ response: null, completed_at: null }],
      });

      const application = await applicationPool(pool).connect();
      await expect(
        application.query(
          `insert into emdo.sync_entity_revisions
             (household_id, space_id, original_owner_user_id, entity_type,
              entity_id, revision, payload, tombstoned, actor_intent,
              recorded_at, retain_until, compaction_after, compaction_policy,
              payload_hash)
           values ($1, $2, $3, 'shopping.item', 'forged', 1, '{}'::jsonb,
                   false, 'Forge a revision', pg_catalog.clock_timestamp(),
                   pg_catalog.clock_timestamp() + interval '90 days',
                   pg_catalog.clock_timestamp() + interval '90 days',
                   'pending-client-aware-v1', repeat('a', 64))`,
          [ids.household, ids.space, ids.user],
        ),
      ).rejects.toBeDefined();
      await expect(
        application.query(
          `delete from emdo.sync_api_request_receipts
            where household_id = $1 and user_id = $2 and client_id = $3`,
          [ids.household, ids.user, ids.client],
        ),
      ).rejects.toBeDefined();
      application.release();

      await expect(
        admin.query(
          `update emdo.sync_api_request_receipts
              set response = response
            where household_id = $1 and user_id = $2 and client_id = $3
              and idempotency_key = 'sync-upload:shopping-create'`,
          [ids.household, ids.user, ids.client],
        ),
      ).rejects.toBeDefined();
    });
  },
);

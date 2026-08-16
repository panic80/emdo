import { randomUUID } from 'node:crypto';

import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresManagerTurnStore } from './agent/manager-turn-store.js';
import { PostgresRunEventSource } from './agent/run-event-source.js';
import { PostgresSpaceAccessGrantService } from './auth/space-access-grants.js';
import { createDatabaseClient, type EmdoDatabaseClient } from './client.js';
import { ExperienceQueryCursorCodec } from './experience/experience-query-cursor-codec.js';
import { createPostgresExperienceReadGateways } from './experience/postgres-experience-read.js';
import { loadOrderedMigrations } from './migrations.js';
import { PostgresProviderFreeShoppingService } from './shopping/postgres-provider-free-shopping-service.js';

const databaseUrl = process.env.TEST_PROVIDER_FREE_MVP_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const ids = Object.freeze({
  owner: '93000000-0000-4000-8000-000000000001',
  ownerSession: '93000000-0000-4000-8000-000000000002',
  ownerMembership: '93000000-0000-4000-8000-000000000003',
  ownerHousehold: '93000000-0000-4000-8000-000000000004',
  ownerPrivateSpace: '93000000-0000-4000-8000-000000000005',
  firstRequest: '93000000-0000-4000-8000-000000000006',
  secondRequest: '93000000-0000-4000-8000-000000000007',
  otherOwner: '93000000-0000-4000-8000-000000000008',
  otherSession: '93000000-0000-4000-8000-000000000009',
  otherMembership: '93000000-0000-4000-8000-000000000010',
  otherHousehold: '93000000-0000-4000-8000-000000000011',
  otherPrivateSpace: '93000000-0000-4000-8000-000000000012',
  otherRequest: '93000000-0000-4000-8000-000000000013',
});

const loginRole = 'emdo_provider_free_mvp_integration_login';
const loginPassword = `emdo-provider-free-${randomUUID().replaceAll('-', '')}`;

const collect = async <Value>(
  input: AsyncIterable<Value>,
): Promise<Value[]> => {
  const values: Value[] = [];
  for await (const value of input) values.push(value);
  return values;
};

const shoppingPrincipal = (principal: {
  readonly userId: string;
  readonly sessionId: string;
  readonly householdId: string;
  readonly spaceAccessGrantId: string;
}) =>
  Object.freeze({
    userId: principal.userId,
    sessionId: principal.sessionId,
    householdId: principal.householdId,
    spaceAccessGrantId: principal.spaceAccessGrantId,
  });

const cursorCodec = () =>
  new ExperienceQueryCursorCodec({
    current: {
      keyId: 'provider-free-mvp-integration',
      secret: new Uint8Array(32).fill(9),
    },
  });

describeDatabase(
  'provider-free shopping MVP persistence (isolated PostgreSQL 17 with pgvector only)',
  () => {
    let admin: import('pg').Client;
    let runtime: EmdoDatabaseClient;
    let ownerPrincipal: Readonly<{
      userId: string;
      sessionId: string;
      householdId: string;
      role: 'owner';
      emailVerified: true;
      spaceAccessGrantId: string;
      collectionAuthorizationScopeFingerprint: ReturnType<
        typeof EffectiveAuthorizationScopeFingerprintSchema.parse
      >;
    }>;
    let rotatedOwnerPrincipal: typeof ownerPrincipal;
    let otherPrincipal: typeof ownerPrincipal;
    let ownerRunId: string;

    const mintPrincipal = async (input: {
      readonly membershipId: string;
      readonly householdId: string;
      readonly requestId: string;
      readonly sessionId: string;
      readonly userId: string;
    }) => {
      const grants = new PostgresSpaceAccessGrantService(runtime.scopedPool);
      const scope = await grants.resolveActivePrincipalScope({
        activeMembershipId: input.membershipId,
        householdId: input.householdId,
        requestId: input.requestId,
        role: 'owner',
        sessionId: input.sessionId,
        userId: input.userId,
      });
      if (scope.role !== 'owner' || scope.emailVerified !== true) {
        throw new Error('provider-free MVP fixture requires a verified owner');
      }
      return Object.freeze({
        userId: scope.userId,
        sessionId: scope.sessionId,
        householdId: scope.householdId,
        role: scope.role,
        emailVerified: scope.emailVerified,
        spaceAccessGrantId: scope.spaceAccessGrantId,
        collectionAuthorizationScopeFingerprint:
          EffectiveAuthorizationScopeFingerprintSchema.parse(
            scope.collectionAuthorizationScopeFingerprint,
          ),
      });
    };

    beforeAll(async () => {
      const { Client } = await import('pg');
      admin = new Client({ connectionString: databaseUrl });
      await admin.connect();
      const [{ version }, { vector }] = await Promise.all([
        admin.query(
          `select current_setting('server_version_num')::integer as version`,
        ),
        admin.query(`select exists (
          select 1 from pg_catalog.pg_available_extensions where name = 'vector'
        ) as vector`),
      ]).then(([versionResult, vectorResult]) => [
        versionResult.rows[0] ?? {},
        vectorResult.rows[0] ?? {},
      ]);
      if (Math.trunc(Number(version) / 10_000) !== 17 || vector !== true) {
        throw new Error(
          'TEST_PROVIDER_FREE_MVP_DATABASE_URL must use PostgreSQL 17 with pgvector',
        );
      }
      const existing = await admin.query(
        `select 1 from pg_catalog.pg_namespace where nspname = 'emdo'`,
      );
      if (existing.rowCount !== 0) {
        throw new Error(
          'TEST_PROVIDER_FREE_MVP_DATABASE_URL must point at an isolated empty database',
        );
      }
      for (const migration of await loadOrderedMigrations()) {
        await admin.query(migration.sql);
      }
      await admin.query(
        `insert into emdo.auth_users (id, name, email, email_verified)
         values
           ($1, 'MVP Owner', 'mvp-owner@example.test', true),
           ($2, 'Other Owner', 'other-owner@example.test', true)`,
        [ids.owner, ids.otherOwner],
      );
      await admin.query(
        `insert into emdo.households (id, name, slug, created_by_user_id)
         values
           ($1, 'MVP Household', 'provider-free-mvp-household', $2),
           ($3, 'Other Household', 'provider-free-mvp-other-household', $4)`,
        [ids.ownerHousehold, ids.owner, ids.otherHousehold, ids.otherOwner],
      );
      await admin.query(
        `insert into emdo.household_memberships
           (id, household_id, user_id, role, status, joined_at)
         values
           ($1, $2, $3, 'owner', 'active', pg_catalog.clock_timestamp()),
           ($4, $5, $6, 'owner', 'active', pg_catalog.clock_timestamp())`,
        [
          ids.ownerMembership,
          ids.ownerHousehold,
          ids.owner,
          ids.otherMembership,
          ids.otherHousehold,
          ids.otherOwner,
        ],
      );
      await admin.query(
        `insert into emdo.spaces
           (id, household_id, original_owner_user_id, name, visibility)
         values
           ($1, $2, $3, 'Private', 'private'),
           ($4, $5, $6, 'Private', 'private')`,
        [
          ids.ownerPrivateSpace,
          ids.ownerHousehold,
          ids.owner,
          ids.otherPrivateSpace,
          ids.otherHousehold,
          ids.otherOwner,
        ],
      );
      await admin.query(
        `insert into emdo.auth_sessions
           (id, user_id, token, expires_at, active_household_id)
         values
           ($1, $2, 'provider-free-owner-session',
            pg_catalog.clock_timestamp() + interval '1 hour', $3),
           ($4, $5, 'provider-free-other-session',
            pg_catalog.clock_timestamp() + interval '1 hour', $6)`,
        [
          ids.ownerSession,
          ids.owner,
          ids.ownerHousehold,
          ids.otherSession,
          ids.otherOwner,
          ids.otherHousehold,
        ],
      );
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
        max: 2,
        applicationName: 'emdo-provider-free-mvp-integration',
      });
      ownerPrincipal = await mintPrincipal({
        membershipId: ids.ownerMembership,
        householdId: ids.ownerHousehold,
        requestId: ids.firstRequest,
        sessionId: ids.ownerSession,
        userId: ids.owner,
      });
    }, 60_000);

    afterAll(async () => {
      await runtime?.close();
      if (admin !== undefined) {
        const role = await admin.query(
          `select 1 from pg_catalog.pg_roles where rolname = $1`,
          [loginRole],
        );
        if (role.rowCount !== 0) {
          await admin.query(`revoke emdo_app from ${loginRole}`);
          await admin.query(`drop role ${loginRole}`);
        }
        await admin.end();
      }
    });

    it('creates one canonical shopping item, then completes and replays the provider-free manager turn', async () => {
      const turns = new PostgresManagerTurnStore(runtime.scopedPool, {
        requestedModel: 'provider-free-mvp-v1',
      });
      const claim = await turns.claim({
        request: {
          schemaVersion: 1,
          message: 'add 2 each Milk to shopping list',
          routeHint: 'shopping',
        },
        principal: ownerPrincipal,
        requestId: ids.firstRequest,
        idempotencyKey: 'provider-free-mvp-owner-claim-0001',
      });
      if (claim.status !== 'claimed') {
        throw new Error('Provider-free manager turn was not claimed');
      }
      ownerRunId = claim.runId;

      const shopping = new PostgresProviderFreeShoppingService(
        runtime.scopedPool,
      );
      await expect(shopping.checkReady()).resolves.toBe(true);
      const createInput = {
        principal: shoppingPrincipal(ownerPrincipal),
        requestId: ids.firstRequest,
        privateSpaceId: ids.ownerPrivateSpace,
        runId: ownerRunId,
        item: {
          id: 'provider-free-mvp-milk',
          name: 'Milk',
          quantityMinorUnits: 2_000,
          unit: 'each',
        },
      } as const;
      await expect(shopping.create(createInput)).resolves.toMatchObject({
        status: 'applied',
        item: {
          id: createInput.item.id,
          name: 'Milk',
          quantityMinorUnits: 2_000,
          unit: 'each',
          revision: 1,
        },
      });
      await expect(shopping.create(createInput)).resolves.toMatchObject({
        status: 'duplicate',
        item: { id: createInput.item.id, revision: 1 },
      });
      await expect(
        shopping.create({
          ...createInput,
          item: { ...createInput.item, quantityMinorUnits: 3 },
        }),
      ).resolves.toEqual({
        status: 'conflict',
        safeError: {
          code: 'shopping-item-id-conflict',
          message: 'A shopping item already exists with different data.',
        },
      });

      await expect(
        turns.complete({
          claimId: claim.claimId,
          ownershipToken: claim.ownershipToken,
          runId: ownerRunId,
          result: {
            status: 'completed',
            runId: ownerRunId,
            localTraceReference: 'provider-free-mvp-shopping-trace',
            output: { message: 'Added Milk to your shopping list.' },
            specialistOutcomes: [],
            hasPartialFailures: false,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              modelCostCadMinor: 0,
            },
            executionResolution: {
              status: 'provider-free',
              profile: 'shopping-list-v1',
              reason: 'provider-free-mvp',
            },
          },
        }),
      ).resolves.toMatchObject({ status: 'completed' });
    });

    it('uses a fresh grant to replay the terminal event and project the canonical shopping item', async () => {
      rotatedOwnerPrincipal = await mintPrincipal({
        membershipId: ids.ownerMembership,
        householdId: ids.ownerHousehold,
        requestId: ids.secondRequest,
        sessionId: ids.ownerSession,
        userId: ids.owner,
      });
      const source = new PostgresRunEventSource(runtime.scopedPool);
      const events = await collect(
        await source.open({
          runId: ownerRunId,
          afterSequence: 0,
          principal: rotatedOwnerPrincipal,
          requestId: ids.secondRequest,
          abortSignal: new AbortController().signal,
        }),
      );
      expect(events.map(({ sequence, type }) => ({ sequence, type }))).toEqual([
        { sequence: 1, type: 'run.accepted' },
        { sequence: 2, type: 'run.completed' },
      ]);

      const experience = createPostgresExperienceReadGateways(
        runtime.scopedPool,
        cursorCodec(),
      );
      await expect(
        experience.shoppingRead.list({
          limit: 10,
          principal: rotatedOwnerPrincipal,
          requestId: ids.secondRequest,
        }),
      ).resolves.toEqual({
        schemaVersion: 1,
        items: [
          {
            id: 'provider-free-mvp-milk',
            name: 'Milk',
            quantityMinorUnits: 2_000,
            unit: 'each',
            state: 'active',
          },
        ],
      });
    });

    it('keeps a second household current grant isolated from the first item and item ID', async () => {
      otherPrincipal = await mintPrincipal({
        membershipId: ids.otherMembership,
        householdId: ids.otherHousehold,
        requestId: ids.otherRequest,
        sessionId: ids.otherSession,
        userId: ids.otherOwner,
      });
      const turns = new PostgresManagerTurnStore(runtime.scopedPool, {
        requestedModel: 'provider-free-mvp-v1',
      });
      const claim = await turns.claim({
        request: {
          schemaVersion: 1,
          message: 'add 1 each Oat Milk to shopping list',
          routeHint: 'shopping',
        },
        principal: otherPrincipal,
        requestId: ids.otherRequest,
        idempotencyKey: 'provider-free-mvp-other-claim-0001',
      });
      if (claim.status !== 'claimed') {
        throw new Error('Second-household provider-free turn was not claimed');
      }
      const shopping = new PostgresProviderFreeShoppingService(
        runtime.scopedPool,
      );
      await expect(
        shopping.create({
          principal: shoppingPrincipal(otherPrincipal),
          requestId: ids.otherRequest,
          privateSpaceId: ids.otherPrivateSpace,
          runId: claim.runId,
          item: {
            id: 'provider-free-mvp-milk',
            name: 'Oat Milk',
            quantityMinorUnits: 1,
            unit: 'each',
          },
        }),
      ).resolves.toMatchObject({ status: 'applied', item: { revision: 1 } });

      const experience = createPostgresExperienceReadGateways(
        runtime.scopedPool,
        cursorCodec(),
      );
      await expect(
        experience.shoppingRead.list({
          limit: 10,
          principal: otherPrincipal,
          requestId: ids.otherRequest,
        }),
      ).resolves.toEqual({
        schemaVersion: 1,
        items: [
          {
            id: 'provider-free-mvp-milk',
            name: 'Oat Milk',
            quantityMinorUnits: 1,
            unit: 'each',
            state: 'active',
          },
        ],
      });
    });
  },
);

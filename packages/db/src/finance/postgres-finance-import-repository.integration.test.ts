import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type EmdoDatabaseClient } from '../client.js';
import { loadOrderedMigrations } from '../migrations.js';
import { PostgresFinanceImportRepository } from './postgres-finance-import-repository.js';

const databaseUrl = process.env.TEST_FINANCE_IMPORT_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const ids = Object.freeze({
  household: 'f1000000-0000-4000-8000-000000000001',
  owner: 'f1000000-0000-4000-8000-000000000002',
  ownerSession: 'f1000000-0000-4000-8000-000000000003',
  privateSpace: 'f1000000-0000-4000-8000-000000000004',
  secondarySpace: 'f1000000-0000-4000-8000-000000000008',
  otherHousehold: 'f1000000-0000-4000-8000-000000000005',
  otherOwner: 'f1000000-0000-4000-8000-000000000006',
  otherSpace: 'f1000000-0000-4000-8000-000000000007',
  requestA: 'f1000000-0000-4000-8000-000000000010',
  requestB: 'f1000000-0000-4000-8000-000000000011',
  requestC: 'f1000000-0000-4000-8000-000000000012',
  grantA: 'f1000000-0000-4000-8000-000000000020',
  grantB: 'f1000000-0000-4000-8000-000000000021',
  grantC: 'f1000000-0000-4000-8000-000000000022',
  plan: 'f1000000-0000-4000-8000-000000000030',
  abandonedPlan: 'f1000000-0000-4000-8000-000000000031',
  missingCategoryPlan: 'f1000000-0000-4000-8000-000000000032',
  tombstonedCategoryPlan: 'f1000000-0000-4000-8000-000000000033',
  crossSpaceCategoryPlan: 'f1000000-0000-4000-8000-000000000034',
  idempotencyConflictPlan: 'f1000000-0000-4000-8000-000000000035',
});

const accountId = 'bank-account::opaque/non-uuid';
const categoryId = 'category::groceries/non-uuid';
const otherCategoryId = 'category::other-space/non-uuid';
const destinationIds = Object.freeze({
  alphaCategoryA: 'category::alpha-a/non-uuid',
  alphaCategoryB: 'category::alpha-b/non-uuid',
  inactiveAccount: 'account::inactive/non-uuid',
  nonCadAccount: 'account::usd/non-uuid',
  nonManualAccount: 'account::connected/non-uuid',
  tombstonedCategory: 'category::tombstoned/non-uuid',
  crossSpaceCategory: 'category::same-household-other-space/non-uuid',
  crossOwnerCategory: 'category::other-owner/non-uuid',
  malformedCategory: 'category::malformed/non-uuid',
  capExcludedCategory: 'category::limit-098/non-uuid',
});
const fixtureTimestamp = '2026-08-13T12:00:00.000Z';

const financeAccountPayload = (input: {
  readonly id: string;
  readonly spaceId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly active?: boolean;
  readonly currency?: string;
  readonly source?: string;
}) => ({
  schemaVersion: 1,
  id: input.id,
  spaceId: input.spaceId,
  ownerUserId: input.ownerUserId,
  createdAt: fixtureTimestamp,
  updatedAt: fixtureTimestamp,
  recordType: 'account',
  name: input.name,
  active: input.active ?? true,
  currency: input.currency ?? 'CAD',
  openingBalanceCadMinor: 0,
  accountKind: 'chequing',
  source: input.source ?? 'manual',
});

const financeCategoryPayload = (input: {
  readonly id: string;
  readonly spaceId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly categoryKind?: 'income' | 'expense';
}) => ({
  schemaVersion: 1,
  id: input.id,
  spaceId: input.spaceId,
  ownerUserId: input.ownerUserId,
  createdAt: fixtureTimestamp,
  updatedAt: fixtureTimestamp,
  recordType: 'category',
  name: input.name,
  active: true,
  categoryKind: input.categoryKind ?? 'expense',
  parentCategoryId: null,
});
const sourceText = [
  'posted,description,amount,category',
  `2026-08-13,Groceries,-12.34,${categoryId}`,
].join('\n');
const sourceHash = createHash('sha256')
  .update(sourceText, 'utf8')
  .digest('hex');

describeDatabase(
  'PostgreSQL 18 finance import receipts (requires isolated empty TEST_FINANCE_IMPORT_DATABASE_URL)',
  () => {
    let admin: import('pg').Pool;
    let runtime: EmdoDatabaseClient;
    let loginRole = '';
    let loginPassword = '';
    let scopeFingerprint = '';
    let committedReceiptId = '';

    const principal = (input: {
      readonly requestId: string;
      readonly grantId: string;
    }) =>
      Object.freeze({
        userId: ids.owner,
        sessionId: ids.ownerSession,
        householdId: ids.household,
        role: 'owner' as const,
        emailVerified: true as const,
        spaceAccessGrantId: input.grantId,
        collectionAuthorizationScopeFingerprint: scopeFingerprint,
      });

    const seedGrant = async (grantId: string, requestId: string) => {
      await admin.query(
        `insert into emdo.space_access_grants
           (grant_id, household_id, original_owner_user_id, session_id,
            request_id, membership_id, role, private_space_id,
            writable_space_ids, issued_at, expires_at, retain_until)
         select $1::uuid, membership.household_id, membership.user_id, $2::uuid,
                $3::uuid, membership.id, membership.role, $4::uuid,
                array[$4::uuid, $7::uuid],
                pg_catalog.clock_timestamp() - interval '1 second',
                pg_catalog.clock_timestamp() + interval '10 minutes',
                pg_catalog.clock_timestamp() + interval '89 days'
           from emdo.household_memberships as membership
          where membership.household_id = $5::uuid and membership.user_id = $6::uuid`,
        [
          grantId,
          ids.ownerSession,
          requestId,
          ids.privateSpace,
          ids.household,
          ids.owner,
          ids.secondarySpace,
        ],
      );
    };

    const readScopeFingerprint = async (grantId: string, requestId: string) => {
      const client = await admin.connect();
      try {
        await client.query('begin');
        await client.query(
          `select pg_catalog.set_config('emdo.user_id', $1, true),
                  pg_catalog.set_config('emdo.session_id', $2, true),
                  pg_catalog.set_config('emdo.request_id', $3, true)`,
          [ids.owner, ids.ownerSession, requestId],
        );
        const result = await client.query<{
          authorization_scope_fingerprint: string;
        }>(
          `select authorization_scope_fingerprint
             from emdo.lock_current_authorization_scope($1::uuid, null, null)`,
          [grantId],
        );
        await client.query('commit');
        const value = result.rows[0]?.authorization_scope_fingerprint;
        if (typeof value !== 'string')
          throw new Error('Current grant scope was not resolved');
        return value;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };

    const resolveScopeWithClaims = async (input: {
      readonly grantId: string;
      readonly householdId: string;
      readonly sessionId?: string;
      readonly fingerprint: string;
    }) => {
      const client = await admin.connect();
      try {
        await client.query('begin');
        await client.query(
          `select pg_catalog.set_config('emdo.user_id', $1, true),
                  pg_catalog.set_config('emdo.session_id', $2, true),
                  pg_catalog.set_config('emdo.request_id', $3, true)`,
          [ids.owner, input.sessionId ?? ids.ownerSession, ids.requestC],
        );
        const result = await client.query<{ scope: unknown }>(
          `select emdo.resolve_finance_import_scope($1, $2::uuid, $3::uuid, $4, 'owner') as scope`,
          [accountId, input.householdId, input.grantId, input.fingerprint],
        );
        await client.query('commit');
        return result.rows[0]?.scope;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };

    const readinessWithClaims = async () => {
      const client = await runtime.pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `select pg_catalog.set_config('emdo.user_id', $1, true),
                  pg_catalog.set_config('emdo.session_id', $2, true),
                  pg_catalog.set_config('emdo.request_id', $3, true)`,
          [ids.owner, ids.ownerSession, ids.requestA],
        );
        const result = await client.query<{ ready: boolean }>(
          'select emdo.finance_imports_ready() as ready',
        );
        await client.query('commit');
        return result.rows[0]?.ready;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };

    beforeAll(async () => {
      const { Pool } = await import('pg');
      admin = new Pool({
        allowExitOnIdle: true,
        connectionString: databaseUrl,
        max: 1,
      });
      const server = await admin.query<{
        server_version_num: string;
        server_version: string;
      }>(
        `select current_setting('server_version_num') as server_version_num,
                version() as server_version`,
      );
      expect(Number(server.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(
        180_000,
      );
      expect(Number(server.rows[0]?.server_version_num)).toBeLessThan(190_000);
      expect(server.rows[0]?.server_version).toMatch(/PostgreSQL 18\./u);
      const existing = await admin.query<{ emdo: string | null }>(
        "select to_regnamespace('emdo')::text as emdo",
      );
      if (existing.rows[0]?.emdo !== null) {
        throw new Error(
          'TEST_FINANCE_IMPORT_DATABASE_URL must point at an isolated empty database',
        );
      }
      const migrations = (await loadOrderedMigrations()).filter(
        ({ index }) => index <= 8,
      );
      expect(migrations.map((migration) => migration.id)).toEqual([
        '0000_household_foundation',
        '0001_identity_onboarding',
        '0002_owner_bootstrap',
        '0003_durable_runtime_repositories',
        '0004_audio_request_receipts',
        '0005_household_administration',
        '0006_sync_conflict_outcomes',
        '0007_experience_notification_preferences',
        '0008_finance_import_receipts',
      ]);
      for (const migration of migrations) await admin.query(migration.sql);

      loginRole = `emdo_finance_live_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
      loginPassword = `finance_${randomUUID().replaceAll('-', '')}`;
      await admin.query(
        `create role ${loginRole} login nosuperuser nocreatedb nocreaterole
          inherit nobypassrls noreplication password '${loginPassword}'`,
      );
      await admin.query(`grant emdo_app to ${loginRole}`);

      await admin.query(
        `insert into emdo.auth_users (id, name, email, email_verified)
           values ($1, 'Finance Owner', 'finance-owner@example.test', true),
                  ($2, 'Other Owner', 'finance-other@example.test', true)`,
        [ids.owner, ids.otherOwner],
      );
      await admin.query(
        `insert into emdo.households (id, name, slug, created_by_user_id)
           values ($1, 'Finance Household', 'finance-household', $2),
                  ($3, 'Other Household', 'finance-other-household', $4)`,
        [ids.household, ids.owner, ids.otherHousehold, ids.otherOwner],
      );
      await admin.query(
        `insert into emdo.household_memberships
           (household_id, user_id, role, status, joined_at)
           values ($1, $2, 'owner', 'active', pg_catalog.clock_timestamp()),
                  ($3, $4, 'owner', 'active', pg_catalog.clock_timestamp()),
                  ($1, $4, 'member', 'active', pg_catalog.clock_timestamp())`,
        [ids.household, ids.owner, ids.otherHousehold, ids.otherOwner],
      );
      await admin.query(
        `insert into emdo.spaces
           (id, household_id, original_owner_user_id, name, visibility)
           values ($1, $2, $3, 'Finance private', 'private'),
                  ($4, $5, $6, 'Other private', 'private'),
                  ($7, $2, $3, 'Finance shared', 'shared')`,
        [
          ids.privateSpace,
          ids.household,
          ids.owner,
          ids.otherSpace,
          ids.otherHousehold,
          ids.otherOwner,
          ids.secondarySpace,
        ],
      );
      await admin.query(
        `insert into emdo.auth_sessions
           (id, user_id, token, expires_at, active_household_id)
           values ($1, $2, 'finance-owner-session',
                   pg_catalog.clock_timestamp() + interval '1 hour', $3)`,
        [ids.ownerSession, ids.owner, ids.household],
      );
      const destinationEntities = [
        {
          householdId: ids.household,
          spaceId: ids.privateSpace,
          ownerUserId: ids.owner,
          entityType: 'finance.account',
          entityId: accountId,
          payload: financeAccountPayload({
            id: accountId,
            spaceId: ids.privateSpace,
            ownerUserId: ids.owner,
            name: 'Everyday chequing',
          }),
        },
        {
          householdId: ids.household,
          spaceId: ids.privateSpace,
          ownerUserId: ids.owner,
          entityType: 'finance.account',
          entityId: destinationIds.inactiveAccount,
          payload: financeAccountPayload({
            id: destinationIds.inactiveAccount,
            spaceId: ids.privateSpace,
            ownerUserId: ids.owner,
            name: 'Inactive account',
            active: false,
          }),
        },
        {
          householdId: ids.household,
          spaceId: ids.privateSpace,
          ownerUserId: ids.owner,
          entityType: 'finance.account',
          entityId: destinationIds.nonCadAccount,
          payload: financeAccountPayload({
            id: destinationIds.nonCadAccount,
            spaceId: ids.privateSpace,
            ownerUserId: ids.owner,
            name: 'US account',
            currency: 'USD',
          }),
        },
        {
          householdId: ids.household,
          spaceId: ids.privateSpace,
          ownerUserId: ids.owner,
          entityType: 'finance.account',
          entityId: destinationIds.nonManualAccount,
          payload: financeAccountPayload({
            id: destinationIds.nonManualAccount,
            spaceId: ids.privateSpace,
            ownerUserId: ids.owner,
            name: 'Connected account',
            source: 'connected',
          }),
        },
        ...[
          financeCategoryPayload({
            id: destinationIds.alphaCategoryA,
            spaceId: ids.privateSpace,
            ownerUserId: ids.owner,
            name: 'Alpha',
          }),
          financeCategoryPayload({
            id: destinationIds.alphaCategoryB,
            spaceId: ids.privateSpace,
            ownerUserId: ids.owner,
            name: 'Alpha',
            categoryKind: 'income',
          }),
          financeCategoryPayload({
            id: categoryId,
            spaceId: ids.privateSpace,
            ownerUserId: ids.owner,
            name: 'Groceries',
          }),
          financeCategoryPayload({
            id: destinationIds.tombstonedCategory,
            spaceId: ids.privateSpace,
            ownerUserId: ids.owner,
            name: 'Tombstoned',
          }),
        ].map((payload) => ({
          householdId: ids.household,
          spaceId: ids.privateSpace,
          ownerUserId: ids.owner,
          entityType: 'finance.category',
          entityId: payload.id,
          payload,
        })),
        {
          householdId: ids.household,
          spaceId: ids.secondarySpace,
          ownerUserId: ids.owner,
          entityType: 'finance.category',
          entityId: destinationIds.crossSpaceCategory,
          payload: financeCategoryPayload({
            id: destinationIds.crossSpaceCategory,
            spaceId: ids.secondarySpace,
            ownerUserId: ids.owner,
            name: 'Elsewhere',
          }),
        },
        {
          householdId: ids.household,
          spaceId: ids.privateSpace,
          ownerUserId: ids.otherOwner,
          entityType: 'finance.category',
          entityId: destinationIds.crossOwnerCategory,
          payload: financeCategoryPayload({
            id: destinationIds.crossOwnerCategory,
            spaceId: ids.privateSpace,
            ownerUserId: ids.otherOwner,
            name: 'Other owner',
          }),
        },
        {
          householdId: ids.household,
          spaceId: ids.privateSpace,
          ownerUserId: ids.owner,
          entityType: 'finance.category',
          entityId: destinationIds.malformedCategory,
          payload: {
            schemaVersion: 1,
            id: destinationIds.malformedCategory,
            name: 'Malformed',
            active: true,
          },
        },
        {
          householdId: ids.otherHousehold,
          spaceId: ids.otherSpace,
          ownerUserId: ids.otherOwner,
          entityType: 'finance.category',
          entityId: otherCategoryId,
          payload: financeCategoryPayload({
            id: otherCategoryId,
            spaceId: ids.otherSpace,
            ownerUserId: ids.otherOwner,
            name: 'Other household',
          }),
        },
        ...Array.from({ length: 100 }, (_, index) => {
          const sequence = String(index + 1).padStart(3, '0');
          const entityId = `category::limit-${sequence}/non-uuid`;
          return {
            householdId: ids.household,
            spaceId: ids.privateSpace,
            ownerUserId: ids.owner,
            entityType: 'finance.category',
            entityId,
            payload: financeCategoryPayload({
              id: entityId,
              spaceId: ids.privateSpace,
              ownerUserId: ids.owner,
              name: `Limit ${sequence}`,
            }),
          };
        }),
      ];
      await admin.query(
        `insert into emdo.sync_entities
           (household_id, space_id, original_owner_user_id, entity_type, entity_id,
            payload, actor_intent, revision, created_at, updated_at)
         select (item ->> 'householdId')::uuid, (item ->> 'spaceId')::uuid,
                (item ->> 'ownerUserId')::uuid, item ->> 'entityType',
                item ->> 'entityId', item -> 'payload', 'finance fixture', 1,
                pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
           from pg_catalog.jsonb_array_elements($1::jsonb) as item`,
        [JSON.stringify(destinationEntities)],
      );
      await seedGrant(ids.grantA, ids.requestA);
      await seedGrant(ids.grantB, ids.requestB);
      await seedGrant(ids.grantC, ids.requestC);
      await admin.query(
        `update emdo.sync_entities
            set actor_intent = 'finance fixture tombstone',
                revision = revision + 1,
                tombstoned_at = pg_catalog.clock_timestamp(),
                updated_at = pg_catalog.clock_timestamp()
          where household_id = $1 and space_id = $2 and entity_id = 'category::tombstoned/non-uuid'`,
        [ids.household, ids.privateSpace],
      );
      scopeFingerprint = await readScopeFingerprint(ids.grantA, ids.requestA);
      expect(await readScopeFingerprint(ids.grantB, ids.requestB)).toBe(
        scopeFingerprint,
      );
      expect(await readScopeFingerprint(ids.grantC, ids.requestC)).toBe(
        scopeFingerprint,
      );

      const runtimeUrl = new URL(databaseUrl!);
      runtimeUrl.username = loginRole;
      runtimeUrl.password = loginPassword;
      runtime = createDatabaseClient({
        connectionString: runtimeUrl.toString(),
        applicationName: 'emdo-finance-import-live',
        max: 1,
      });
    }, 60_000);

    afterAll(async () => {
      await runtime?.close();
      if (admin !== undefined) {
        if (loginRole !== '') {
          await admin
            .query(`revoke emdo_app from ${loginRole}`)
            .catch(() => undefined);
          await admin
            .query(`drop role if exists ${loginRole}`)
            .catch(() => undefined);
        }
        await admin.end();
      }
    });

    it('applies 0000 through 0008 and commits, redacts, and replays an opaque-account import across fresh grants', async () => {
      const repository = new PostgresFinanceImportRepository(
        runtime.scopedPool,
        {
          generateUuid: () => ids.plan,
        },
      );
      await expect(repository.checkReady()).resolves.toBe(true);
      await expect(readinessWithClaims()).resolves.toBe(true);
      const destinations = await repository.listDestinations({
        principal: principal({ requestId: ids.requestA, grantId: ids.grantA }),
        requestId: ids.requestA,
      });
      expect(destinations.accounts).toEqual([
        {
          id: accountId,
          name: 'Everyday chequing',
          accountKind: 'chequing',
        },
      ]);
      expect(destinations.categories).toHaveLength(100);
      expect(destinations.categories.slice(0, 4)).toEqual([
        {
          id: destinationIds.alphaCategoryA,
          name: 'Alpha',
          categoryKind: 'expense',
        },
        {
          id: destinationIds.alphaCategoryB,
          name: 'Alpha',
          categoryKind: 'income',
        },
        { id: categoryId, name: 'Groceries', categoryKind: 'expense' },
        {
          id: 'category::limit-001/non-uuid',
          name: 'Limit 001',
          categoryKind: 'expense',
        },
      ]);
      const destinationIdsReturned = new Set(
        destinations.categories.map((category) => category.id),
      );
      for (const excluded of [
        destinationIds.tombstonedCategory,
        destinationIds.crossSpaceCategory,
        destinationIds.crossOwnerCategory,
        destinationIds.malformedCategory,
        otherCategoryId,
        destinationIds.capExcludedCategory,
      ]) {
        expect(destinationIdsReturned).not.toContain(excluded);
      }
      const destinationText = JSON.stringify(destinations);
      expect(destinationText).not.toContain('openingBalanceCadMinor');
      expect(destinationText).not.toContain('ownerUserId');
      expect(destinationText).not.toContain('spaceId');
      expect(destinationText).not.toContain('currency');
      expect(destinationText).not.toContain('source');
      for (const account of destinations.accounts) {
        expect(Object.keys(account).sort()).toEqual([
          'accountKind',
          'id',
          'name',
        ]);
      }
      for (const category of destinations.categories) {
        expect(Object.keys(category).sort()).toEqual([
          'categoryKind',
          'id',
          'name',
        ]);
      }
      await expect(
        repository.listDestinations({
          principal: principal({
            requestId: ids.requestA,
            grantId: ids.grantB,
          }),
          requestId: ids.requestA,
        }),
      ).rejects.toMatchObject({ code: 'authorization-revoked' });
      await expect(
        repository.listDestinations({
          principal: {
            ...principal({ requestId: ids.requestA, grantId: ids.grantA }),
            sessionId: ids.otherOwner,
          },
          requestId: ids.requestA,
        }),
      ).rejects.toMatchObject({ code: 'authorization-revoked' });
      await expect(
        repository.listDestinations({
          principal: {
            ...principal({ requestId: ids.requestA, grantId: ids.grantA }),
            collectionAuthorizationScopeFingerprint: '0'.repeat(64),
          },
          requestId: ids.requestA,
        }),
      ).rejects.toMatchObject({ code: 'authorization-revoked' });
      await expect(
        repository.listDestinations({
          principal: {
            ...principal({ requestId: ids.requestA, grantId: ids.grantA }),
            householdId: ids.otherHousehold,
          },
          requestId: ids.requestA,
        }),
      ).rejects.toMatchObject({ code: 'authorization-revoked' });
      const preview = await repository.preview({
        accountId,
        format: 'csv',
        mapping: {
          dateFormat: 'yyyy-mm-dd',
          defaultCategoryId: null,
          columns: {
            postedOn: 'posted',
            description: 'description',
            amount: 'amount',
            categoryId: 'category',
          },
        },
        sourceText,
        principal: principal({ requestId: ids.requestA, grantId: ids.grantA }),
        requestId: ids.requestA,
      });
      expect(preview).toMatchObject({ plan: { id: ids.plan, sourceHash } });

      const committed = await repository.commit({
        planId: ids.plan,
        idempotencyKey: 'finance-import:live:commit:0001',
        principal: principal({ requestId: ids.requestB, grantId: ids.grantB }),
        requestId: ids.requestB,
      });
      expect(committed).toMatchObject({
        status: 'committed',
        sourceDeletionAuthorized: true,
      });
      const receiptId = committed.receipt.id;
      committedReceiptId = receiptId;

      const entity = await admin.query<{
        entity_id: string;
        revision: number;
        payload: {
          source: { fingerprint: string; sourceHash: string };
          categoryId: string;
        };
      }>(
        `select entity_id, revision, payload from emdo.sync_entities
          where household_id = $1 and space_id = $2 and entity_type = 'finance.transaction'`,
        [ids.household, ids.privateSpace],
      );
      expect(entity.rows).toHaveLength(1);
      expect(entity.rows[0]).toMatchObject({
        revision: 1,
        payload: { accountId, categoryId, source: { sourceHash } },
      });
      expect(entity.rows[0]?.entity_id).toBe(
        `finance-import-${entity.rows[0]?.payload.source.fingerprint.slice(0, 40)}`,
      );
      const stored = await admin.query<{
        canonical_plan: unknown;
        diagnostics: unknown;
        mapping_metadata: unknown;
      }>(
        `select canonical_plan, diagnostics, mapping_metadata
           from emdo.finance_import_plans where plan_id = $1`,
        [ids.plan],
      );
      expect(stored.rows[0]).toEqual({
        canonical_plan: {},
        diagnostics: {},
        mapping_metadata: {},
      });
      expect(JSON.stringify(stored.rows[0])).not.toContain(sourceText);
      expect(JSON.stringify(stored.rows[0])).not.toContain('posted');

      await admin.query(
        'alter table emdo.finance_import_plans disable trigger finance_import_plans_redact_once',
      );
      await admin.query(
        `with expired_plan_time as (
           select pg_catalog.clock_timestamp() as now
         )
         update emdo.finance_import_plans
            set created_at = expired_plan_time.now - interval '31 minutes',
                expires_at = expired_plan_time.now - interval '2 minutes'
           from expired_plan_time
          where plan_id = $1`,
        [ids.plan],
      );
      await admin.query(
        'alter table emdo.finance_import_plans enable trigger finance_import_plans_redact_once',
      );
      const replayed = await repository.commit({
        planId: ids.plan,
        idempotencyKey: 'finance-import:live:commit:0001',
        principal: principal({ requestId: ids.requestC, grantId: ids.grantC }),
        requestId: ids.requestC,
      });
      expect(replayed).toMatchObject({
        status: 'replayed',
        receipt: { id: receiptId },
      });
      expect(
        (
          await admin.query(
            `select count(*)::integer as count from emdo.sync_entities where entity_type = 'finance.transaction'`,
          )
        ).rows[0]?.count,
      ).toBe(1);

      const conflictRepository = new PostgresFinanceImportRepository(
        runtime.scopedPool,
        { generateUuid: () => ids.idempotencyConflictPlan },
      );
      await conflictRepository.preview({
        accountId,
        format: 'csv',
        mapping: {
          dateFormat: 'yyyy-mm-dd',
          defaultCategoryId: null,
          columns: {
            postedOn: 'posted',
            description: 'description',
            amount: 'amount',
            categoryId: 'category',
          },
        },
        sourceText: sourceText.replace('Groceries', 'Idempotency conflict'),
        principal: principal({ requestId: ids.requestC, grantId: ids.grantC }),
        requestId: ids.requestC,
      });
      await expect(
        conflictRepository.commit({
          planId: ids.idempotencyConflictPlan,
          idempotencyKey: 'finance-import:live:commit:0001',
          principal: principal({
            requestId: ids.requestC,
            grantId: ids.grantC,
          }),
          requestId: ids.requestC,
        }),
      ).rejects.toMatchObject({ code: 'idempotency-conflict' });

      await expect(
        repository.commit({
          planId: ids.plan,
          idempotencyKey: 'finance-import:live:commit:0001',
          principal: {
            ...principal({ requestId: ids.requestC, grantId: ids.grantC }),
            sessionId: ids.otherOwner,
          },
          requestId: ids.requestC,
        }),
      ).rejects.toMatchObject({ code: 'authorization-revoked' });
      await expect(
        admin.query(
          `update emdo.finance_import_plans set diagnostics = '{"unexpected":true}'::jsonb where plan_id = $1`,
          [ids.plan],
        ),
      ).rejects.toMatchObject({ code: '55000' });
    });

    it('enforces category, raw-ACL, retention, and readiness boundaries', async () => {
      expect(
        await resolveScopeWithClaims({
          grantId: ids.grantC,
          householdId: ids.household,
          sessionId: ids.otherOwner,
          fingerprint: scopeFingerprint,
        }),
      ).toBeNull();
      expect(
        await resolveScopeWithClaims({
          grantId: ids.grantC,
          householdId: ids.household,
          fingerprint: '0'.repeat(64),
        }),
      ).toBeNull();
      expect(
        await resolveScopeWithClaims({
          grantId: ids.grantC,
          householdId: ids.otherHousehold,
          fingerprint: scopeFingerprint,
        }),
      ).toBeNull();
      expect(
        await resolveScopeWithClaims({
          grantId: 'f1000000-0000-4000-8000-000000000099',
          householdId: ids.household,
          fingerprint: scopeFingerprint,
        }),
      ).toBeNull();

      const rejectedCategoryCommit = async (
        planId: string,
        rejectedCategoryId: string,
      ) => {
        const statement = [
          'posted,description,amount,category',
          `2026-08-13,${planId},-12.34,${rejectedCategoryId}`,
        ].join('\n');
        const repository = new PostgresFinanceImportRepository(
          runtime.scopedPool,
          { generateUuid: () => planId },
        );
        await expect(
          repository.preview({
            accountId,
            format: 'csv',
            mapping: {
              dateFormat: 'yyyy-mm-dd',
              defaultCategoryId: null,
              columns: {
                postedOn: 'posted',
                description: 'description',
                amount: 'amount',
                categoryId: 'category',
              },
            },
            sourceText: statement,
            principal: principal({
              requestId: ids.requestA,
              grantId: ids.grantA,
            }),
            requestId: ids.requestA,
          }),
        ).resolves.toMatchObject({ plan: { id: planId } });
        await expect(
          repository.commit({
            planId,
            idempotencyKey: `finance-import:live:deny:${planId.slice(-4)}`,
            principal: principal({
              requestId: ids.requestB,
              grantId: ids.grantB,
            }),
            requestId: ids.requestB,
          }),
        ).rejects.toMatchObject({ code: 'authorization-revoked' });
      };
      await rejectedCategoryCommit(
        ids.missingCategoryPlan,
        'category::missing/non-uuid',
      );
      await rejectedCategoryCommit(
        ids.tombstonedCategoryPlan,
        'category::tombstoned/non-uuid',
      );
      await rejectedCategoryCommit(ids.crossSpaceCategoryPlan, otherCategoryId);

      const privileges = await admin.query<{
        app_select: boolean;
        app_insert: boolean;
        app_options: boolean;
        public_options: boolean;
        public_purge: boolean;
        app_purge: boolean;
      }>(`select
        has_table_privilege('emdo_app', 'emdo.finance_import_plans', 'SELECT') as app_select,
        has_table_privilege('emdo_app', 'emdo.finance_import_plans', 'INSERT') as app_insert,
        has_function_privilege('emdo_app', 'emdo.read_finance_import_destinations(uuid,uuid,text,text)', 'EXECUTE') as app_options,
        has_function_privilege('public', 'emdo.read_finance_import_destinations(uuid,uuid,text,text)', 'EXECUTE') as public_options,
        has_function_privilege('public', 'emdo.purge_expired_finance_import_plans(integer)', 'EXECUTE') as public_purge,
        has_function_privilege('emdo_app', 'emdo.purge_expired_finance_import_plans(integer)', 'EXECUTE') as app_purge`);
      expect(privileges.rows[0]).toEqual({
        app_select: false,
        app_insert: false,
        app_options: true,
        public_options: false,
        public_purge: false,
        app_purge: false,
      });
      await expect(
        runtime.pool.query('select * from emdo.finance_import_plans'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runtime.pool.query(
          `insert into emdo.finance_import_plans (plan_id) values ('f1000000-0000-4000-8000-000000000098')`,
        ),
      ).rejects.toMatchObject({ code: '42501' });

      await admin.query(
        `insert into emdo.finance_import_plans
          (plan_id, household_id, space_id, owner_user_id, account_id, source_hash, plan_hash,
           canonical_plan, diagnostics, mapping_metadata, scope_fingerprint, origin_session_id,
           origin_request_id, origin_space_access_grant_id, created_at, expires_at)
         values ($1, $2, $3, $4, $5, repeat('a', 64), repeat('b', 64), '{}'::jsonb,
                 '{}'::jsonb, '{}'::jsonb, $6, $7, $8, $9,
                 pg_catalog.clock_timestamp() - interval '2 hours',
                 pg_catalog.clock_timestamp() - interval '100 minutes')`,
        [
          ids.abandonedPlan,
          ids.household,
          ids.privateSpace,
          ids.owner,
          accountId,
          scopeFingerprint,
          ids.ownerSession,
          ids.requestA,
          ids.grantA,
        ],
      );
      await admin.query('set role emdo_finance_import_retention');
      await expect(
        admin.query<{ purged: number }>(
          'select emdo.purge_expired_finance_import_plans(10) as purged',
        ),
      ).resolves.toMatchObject({ rows: [{ purged: 1 }] });
      await admin.query('reset role');
      expect(
        (
          await admin.query(
            `select plan_id from emdo.finance_import_plans
              where plan_id = any($1::uuid[]) order by plan_id`,
            [[ids.plan, ids.abandonedPlan]],
          )
        ).rows.map((row) => row.plan_id),
      ).toEqual([ids.plan]);
      await expect(
        admin.query(
          'select receipt_id from emdo.finance_import_receipts where plan_id = $1',
          [ids.plan],
        ),
      ).resolves.toMatchObject({ rows: [{ receipt_id: committedReceiptId }] });

      await admin.query(
        'revoke execute on function emdo.read_finance_import_destinations(uuid, uuid, text, text) from emdo_app',
      );
      await expect(
        admin.query('select emdo.finance_imports_ready() as ready'),
      ).resolves.toMatchObject({ rows: [{ ready: false }] });
      await admin.query(
        'grant execute on function emdo.read_finance_import_destinations(uuid, uuid, text, text) to emdo_app',
      );
      await expect(
        admin.query('select emdo.finance_imports_ready() as ready'),
      ).resolves.toMatchObject({ rows: [{ ready: true }] });
    });
  },
);

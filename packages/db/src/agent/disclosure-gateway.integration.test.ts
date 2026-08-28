import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type EmdoDatabaseClient } from '../client.js';
import { loadOrderedMigrations } from '../migrations.js';
import { PostgresSpaceAccessGrantService } from '../auth/space-access-grants.js';
import {
  CanonicalRecordEnvelopeDisclosureFilter,
  hashDataDisclosureGrant,
  PostgresDataDisclosureGrantIssuer,
  PostgresModelDisclosureGateway,
} from './disclosure-gateway.js';

const databaseUrl = process.env.TEST_DISCLOSURE_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const ids = {
  user: '82900000-0000-4000-8000-000000000001',
  session: '82900000-0000-4000-8000-000000000002',
  request: '82900000-0000-4000-8000-000000000003',
  household: '82900000-0000-4000-8000-000000000004',
  membership: '82900000-0000-4000-8000-000000000005',
  space: '82900000-0000-4000-8000-000000000006',
  run: '82900000-0000-4000-8000-000000000007',
  managerRun: '82900000-0000-4000-8000-000000000008',
};
const principal = {
  userId: ids.user,
  sessionId: ids.session,
  requestId: ids.request,
  householdId: ids.household,
};
const loginRole = 'emdo_disclosure_integration_login';
const loginPassword = `emdo-test-${randomUUID()}`;

describeDatabase(
  'PostgreSQL 18 disclosure authority (requires isolated TEST_DISCLOSURE_DATABASE_URL)',
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
          'TEST_DISCLOSURE_DATABASE_URL must point at an isolated empty database',
        );
      }
      for (const migration of await loadOrderedMigrations()) {
        await admin.query(migration.sql);
      }
      await admin.query(
        `insert into emdo.auth_users(id, name, email, email_verified)
         values ($1, 'Disclosure User', 'disclosure-integration@example.test', true)`,
        [ids.user],
      );
      await admin.query(
        `insert into emdo.households(id, name, slug, created_by_user_id)
         values ($1, 'Disclosure Household', 'disclosure-integration', $2)`,
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
         ) values ($1, $2, 'disclosure-integration-token',
                   pg_catalog.clock_timestamp() + interval '1 hour', $3)`,
        [ids.session, ids.user, ids.household],
      );
      await admin.query(
        `insert into emdo.agent_runs(
           id, household_id, space_id, original_owner_user_id,
           agent_id, agent_version, requested_model, status
         ) values ($1, $2, $3, $4, 'finance', '1.0.0', 'luna', 'running')`,
        [ids.run, ids.household, ids.space, ids.user],
      );
      await admin.query(
        `insert into emdo.agent_runs(
           id, household_id, space_id, original_owner_user_id,
           agent_id, agent_version, requested_model, status
         ) values ($1, $2, $3, $4, 'manager', '1.0.0', 'luna', 'running')`,
        [ids.managerRun, ids.household, ids.space, ids.user],
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
        applicationName: 'emdo-disclosure-integration',
      });
      const spaceGrant = new PostgresSpaceAccessGrantService(
        runtime.scopedPool,
      );
      const active = await spaceGrant.resolveActivePrincipalScope({
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

    it('issues once, replays exactly, filters fields, and commits a safe audit', async () => {
      const issuer = new PostgresDataDisclosureGrantIssuer(
        runtime.scopedPool,
        principal,
      );
      const input = {
        requestId: ids.request,
        runId: ids.run,
        householdId: ids.household,
        userId: ids.user,
        spaceId: ids.space,
        spaceAccessGrantId,
        agentId: 'finance',
        phasePurpose: 'specialist-execution' as const,
        disclosurePurpose: 'Explain only the approved transaction fields.',
        provider: 'openai' as const,
        recordAllowlist: [
          {
            dataClass: 'finance.transactions',
            recordId: 'transaction-1',
            fields: ['merchant', 'amount-cad-minor'],
          },
        ],
      };
      const [issued, replay] = await Promise.all([
        issuer.issue(input),
        issuer.issue(input),
      ]);

      expect(replay).toEqual(issued);
      expect(issued.grantHash).toBe(hashDataDisclosureGrant(issued.grant));
      expect(issued.grant.expiresAt).toBe(
        new Date(Date.parse(issued.grant.createdAt) + 600_000).toISOString(),
      );

      const gateway = new PostgresModelDisclosureGateway(
        runtime.scopedPool,
        principal,
        new CanonicalRecordEnvelopeDisclosureFilter(),
      );
      await expect(
        gateway.authorize({
          requestId: ids.request,
          runId: ids.run,
          householdId: ids.household,
          userId: ids.user,
          spaceAccessGrantId,
          agentId: 'finance',
          phasePurpose: 'specialist-execution',
          provider: 'openai',
          requestedGrantId: issued.grant.id,
          requestedDataClasses: ['finance.transactions'],
          payload: {
            schemaVersion: 1,
            records: [
              {
                dataClass: 'finance.transactions',
                recordId: 'transaction-1',
                fields: {
                  merchant: 'Example Market',
                  'amount-cad-minor': 1_234,
                },
              },
            ],
          },
        }),
      ).resolves.toMatchObject({
        status: 'authorized',
        grantId: issued.grant.id,
        grantVersion: '1.0.0',
      });
      const audit = await admin.query(
        `select event_type, payload
           from emdo.audit_events
          where run_id = $1
          order by occurred_at`,
        [ids.run],
      );
      expect(audit.rows.map(({ event_type }) => event_type)).toEqual([
        'model.disclosure.granted',
        'model.disclosure.sent',
      ]);
      expect(JSON.stringify(audit.rows)).not.toContain('Example Market');
      expect(JSON.stringify(audit.rows)).not.toContain('1234');
    });

    it('allows manager-run disclosure only to registered child specialists during specialist execution', async () => {
      const issuer = new PostgresDataDisclosureGrantIssuer(
        runtime.scopedPool,
        principal,
      );
      const gateway = new PostgresModelDisclosureGateway(
        runtime.scopedPool,
        principal,
        new CanonicalRecordEnvelopeDisclosureFilter(),
      );
      const managerRunInput = {
        requestId: ids.request,
        runId: ids.managerRun,
        householdId: ids.household,
        userId: ids.user,
        spaceId: ids.space,
        spaceAccessGrantId,
        provider: 'openai' as const,
        recordAllowlist: [
          {
            dataClass: 'finance.transactions',
            recordId: 'manager-run-transaction',
            fields: ['merchant'],
          },
        ],
      };
      const payload = {
        schemaVersion: 1,
        records: [
          {
            dataClass: 'finance.transactions',
            recordId: 'manager-run-transaction',
            fields: { merchant: 'Manager Run Market' },
          },
        ],
      };

      const scheduler = await issuer.issue({
        ...managerRunInput,
        agentId: 'scheduler',
        phasePurpose: 'specialist-execution',
        disclosurePurpose: 'Prepare the delegated calendar context.',
      });
      const finance = await issuer.issue({
        ...managerRunInput,
        agentId: 'finance',
        phasePurpose: 'specialist-execution',
        disclosurePurpose: 'Prepare the delegated finance context.',
      });

      await expect(
        gateway.authorize({
          requestId: ids.request,
          runId: ids.managerRun,
          householdId: ids.household,
          userId: ids.user,
          spaceAccessGrantId,
          agentId: 'scheduler',
          phasePurpose: 'specialist-execution',
          provider: 'openai',
          requestedGrantId: scheduler.grant.id,
          requestedDataClasses: ['finance.transactions'],
          payload,
        }),
      ).resolves.toMatchObject({
        status: 'authorized',
        grantId: scheduler.grant.id,
        agentId: 'scheduler',
      });
      await expect(
        gateway.authorize({
          requestId: ids.request,
          runId: ids.managerRun,
          householdId: ids.household,
          userId: ids.user,
          spaceAccessGrantId,
          agentId: 'finance',
          phasePurpose: 'specialist-execution',
          provider: 'openai',
          requestedGrantId: finance.grant.id,
          requestedDataClasses: ['finance.transactions'],
          payload,
        }),
      ).resolves.toMatchObject({
        status: 'authorized',
        grantId: finance.grant.id,
        agentId: 'finance',
      });

      for (const [agentId, phasePurpose] of [
        ['shopping', 'specialist-execution'],
        ['unknown-agent', 'specialist-execution'],
        ['scheduler', 'manager-plan'],
        ['finance', 'manager-synthesis'],
      ] as const) {
        await expect(
          issuer.issue({
            ...managerRunInput,
            agentId,
            phasePurpose,
            disclosurePurpose: 'This delegated disclosure must be denied.',
          }),
        ).rejects.toMatchObject({ code: 'authorization-revoked' });
      }

      const deniedGrantId = randomUUID();
      await admin.query(
        `insert into emdo.disclosure_grants(
           id, schema_version, version, household_id, space_id, user_id,
           run_id, agent_id, purpose, phase_purpose, provider,
           record_allowlist, grant_hash, one_run_only, created_at, expires_at
         ) values (
           $1, 1, 1, $2, $3, $4, $5, 'shopping',
           'A forged manager-run disclosure.', 'specialist-execution', 'openai',
           '[{"dataClass":"finance.transactions","recordId":"manager-run-transaction","fields":["merchant"]}]'::jsonb,
           repeat('a', 64), true, pg_catalog.clock_timestamp(),
           pg_catalog.clock_timestamp() + interval '10 minutes'
         )`,
        [deniedGrantId, ids.household, ids.space, ids.user, ids.managerRun],
      );
      await expect(
        gateway.authorize({
          requestId: ids.request,
          runId: ids.managerRun,
          householdId: ids.household,
          userId: ids.user,
          spaceAccessGrantId,
          agentId: 'shopping',
          phasePurpose: 'specialist-execution',
          provider: 'openai',
          requestedGrantId: deniedGrantId,
          requestedDataClasses: ['finance.transactions'],
          payload,
        }),
      ).resolves.toEqual({
        status: 'denied',
        grantId: deniedGrantId,
        reason: 'grant-run-mismatch',
      });

      const delegatedAudit = await admin.query<{
        event_type: string;
        agent_id: string;
        payload: unknown;
      }>(
        `select event_type, payload ->> 'agentId' as agent_id, payload
           from emdo.audit_events
          where run_id = $1
          order by event_type, payload ->> 'agentId'`,
        [ids.managerRun],
      );
      expect(
        delegatedAudit.rows.map(({ event_type, agent_id }) => ({
          eventType: event_type,
          agentId: agent_id,
        })),
      ).toEqual([
        { eventType: 'model.disclosure.granted', agentId: 'finance' },
        { eventType: 'model.disclosure.granted', agentId: 'scheduler' },
        { eventType: 'model.disclosure.sent', agentId: 'finance' },
        { eventType: 'model.disclosure.sent', agentId: 'scheduler' },
      ]);
      expect(JSON.stringify(delegatedAudit.rows)).not.toContain(
        'Manager Run Market',
      );
    });

    it('denies direct app-role minting and a conflicting replay', async () => {
      const issuer = new PostgresDataDisclosureGrantIssuer(
        runtime.scopedPool,
        principal,
      );
      await expect(
        issuer.issue({
          requestId: ids.request,
          runId: ids.run,
          householdId: ids.household,
          userId: ids.user,
          spaceId: ids.space,
          spaceAccessGrantId,
          agentId: 'finance',
          phasePurpose: 'specialist-execution',
          disclosurePurpose: 'A conflicting replacement purpose.',
          provider: 'openai',
          recordAllowlist: [
            {
              dataClass: 'finance.transactions',
              recordId: 'transaction-1',
              fields: ['merchant'],
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'authorization-revoked' });

      await admin.query('begin');
      try {
        await admin.query('set local role emdo_app');
        await expect(
          admin.query(
            `insert into emdo.disclosure_grants(
               id, version, household_id, space_id, user_id, run_id,
               agent_id, purpose, phase_purpose, provider, record_allowlist,
               grant_hash, created_at, expires_at
             ) values (
               pg_catalog.gen_random_uuid(), 1, $1, $2, $3, $4,
               'finance', 'Forged grant', 'specialist-execution', 'openai',
               '[]'::jsonb, repeat('a', 64), pg_catalog.clock_timestamp(),
               pg_catalog.clock_timestamp() + interval '1 day'
             )`,
            [ids.household, ids.space, ids.user, ids.run],
          ),
        ).rejects.toThrow(/permission denied/u);
      } finally {
        await admin.query('rollback');
      }
    });

    it('omits grantId only for the durable no-active-grant denial without a hint', async () => {
      const gateway = new PostgresModelDisclosureGateway(
        runtime.scopedPool,
        principal,
        new CanonicalRecordEnvelopeDisclosureFilter(),
      );

      await expect(
        gateway.authorize({
          requestId: ids.request,
          runId: ids.run,
          householdId: ids.household,
          userId: ids.user,
          spaceAccessGrantId,
          agentId: 'finance',
          phasePurpose: 'specialist-execution',
          provider: 'openai',
          requestedDataClasses: [],
          payload: { schemaVersion: 1, records: [] },
        }),
      ).resolves.toEqual({
        status: 'denied',
        reason: 'no-active-grant',
      });
    });
  },
);

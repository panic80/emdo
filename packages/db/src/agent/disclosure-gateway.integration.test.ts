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
  blockedManagerRun: '82900000-0000-4000-8000-000000000009',
  resumeProposal: '82900000-0000-4000-8000-00000000000a',
  resumeDecision: '82900000-0000-4000-8000-00000000000b',
  resumeCheckpoint: '82900000-0000-4000-8000-00000000000c',
  resumeJob: '82900000-0000-4000-8000-00000000000d',
  resumeClaim: '82900000-0000-4000-8000-00000000000e',
  resumeConversation: '82900000-0000-4000-8000-00000000000f',
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
    let collectionAuthorizationScopeFingerprint: string;

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
      collectionAuthorizationScopeFingerprint =
        active.collectionAuthorizationScopeFingerprint;
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

    it('authorizes an approved dependent specialist from a live blocked-resume row', async () => {
      const authorizationScopeFingerprint = 'a'.repeat(64);
      const payloadHash = 'b'.repeat(64);
      const approvalHash = 'c'.repeat(64);
      const issuer = new PostgresDataDisclosureGrantIssuer(
        runtime.scopedPool,
        principal,
      );
      const baseInput = {
        requestId: ids.request,
        runId: ids.blockedManagerRun,
        householdId: ids.household,
        userId: ids.user,
        spaceId: ids.space,
        spaceAccessGrantId,
        provider: 'openai' as const,
      };

      await admin.query(
        `insert into emdo.agent_runs(
           id, household_id, space_id, original_owner_user_id,
           agent_id, agent_version, requested_model, status
         ) values ($1, $2, $3, $4, 'manager', '1.0.0', 'luna', 'running')`,
        [ids.blockedManagerRun, ids.household, ids.space, ids.user],
      );
      const selectedDisclosure = await issuer.issue({
        ...baseInput,
        agentId: 'scheduler',
        phasePurpose: 'specialist-execution',
        disclosurePurpose: 'Run the selected Scheduler action.',
        recordAllowlist: [
          {
            dataClass: 'agent.specialist-delegations',
            recordId: 'selected-scheduler-delegation',
            fields: ['request'],
          },
        ],
      });
      await admin.query(
        `insert into emdo.action_proposals(
           id, schema_version, household_id, space_id, original_owner_user_id,
           run_id, disclosure_grant_id, authorization_scope_fingerprint,
           provider_authority_binding_hash, provider_sdk_call_id,
           disclosure_grant, capability_id, capability_fingerprint,
           canonical_arguments, targets, before_preview, after_preview,
           approval_display, provider_preconditions, payload_hash, approval_hash,
           idempotency_key, created_at, expires_at
         ) values (
           $1, 1, $2, $3, $4, $5, $6, $7, $8,
           'blocked-resume-selected-scheduler',
           pg_catalog.jsonb_build_object(
             'id', $6::uuid, 'runId', $5::uuid,
             'householdId', $2::uuid, 'userId', $4::uuid
           ),
           'scheduler.calendar.write', $9,
           '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb,
           '{"schemaVersion":1,"title":"Review Scheduler action","summary":"Review the selected Scheduler action.","beforeSummary":"","afterSummary":"","fields":[]}'::jsonb,
           '{}'::jsonb, $10, $11,
           'blocked-resume-selected-scheduler-v1',
           pg_catalog.clock_timestamp() - interval '1 second',
           pg_catalog.clock_timestamp() + interval '5 minutes'
         )`,
        [
          ids.resumeProposal,
          ids.household,
          ids.space,
          ids.user,
          ids.blockedManagerRun,
          selectedDisclosure.grant.id,
          authorizationScopeFingerprint,
          'd'.repeat(64),
          'e'.repeat(64),
          payloadHash,
          approvalHash,
        ],
      );
      await admin.query(
        `insert into emdo.action_decisions(
           id, schema_version, proposal_id, household_id, space_id,
           original_owner_user_id, authenticated_session_id, payload_hash,
           approval_hash, decision, channel, decided_at, idempotency_key
         ) values (
           $1, 1, $2, $3, $4, $5, $6, $7, $8, 'approved',
           'authenticated-visual', pg_catalog.clock_timestamp() - interval '1 second',
           'blocked-resume-selected-scheduler-decision-v1'
         )`,
        [
          ids.resumeDecision,
          ids.resumeProposal,
          ids.household,
          ids.space,
          ids.user,
          ids.session,
          payloadHash,
          approvalHash,
        ],
      );
      await admin.query(
        `insert into emdo.approval_checkpoints(
           checkpoint_id, household_id, space_id, user_id, run_id,
           format_version, revision, state, agent_graph_hash, sdk_version,
           sealed_state, created_at, expires_at, updated_at, retain_until
         ) values (
           $1, $2, $3, $4, $5, 1, 1, 'pending', $6,
           'disclosure-integration', 'sealed blocked resume checkpoint',
           pg_catalog.clock_timestamp() - interval '1 second',
           pg_catalog.clock_timestamp() + interval '5 minutes',
           pg_catalog.clock_timestamp() - interval '1 second',
           pg_catalog.clock_timestamp() + interval '89 days'
         )`,
        [
          ids.resumeCheckpoint,
          ids.household,
          ids.space,
          ids.user,
          ids.blockedManagerRun,
          'f'.repeat(64),
        ],
      );
      await admin.query(
        `insert into emdo.agent_run_events(
           household_id, space_id, original_owner_user_id, run_id,
           sequence, event_type, payload, occurred_at, retain_until
         ) values (
           $1, $2, $3, $4, 1, 'approval.required',
           pg_catalog.jsonb_build_object(
             'status', 'needs-approval', 'runId', $4::uuid
           ),
           pg_catalog.clock_timestamp() - interval '1 second',
           pg_catalog.clock_timestamp() + interval '89 days'
         )`,
        [ids.household, ids.space, ids.user, ids.blockedManagerRun],
      );
      // The real decision-and-claim aggregate is covered by the Finance synthetic
      // runtime integration. This fixture isolates post-claim disclosure
      // issue, resolve, and commit against the live PostgreSQL predicates.
      await admin.query(
        `insert into emdo.approval_resume_jobs(
           job_id, household_id, space_id, user_id, run_id, conversation_id,
           checkpoint_id, interruption_id, proposal_id, capability_id,
           origin_session_id, origin_turn_request_id,
           origin_space_access_grant_id, authorization_scope_fingerprint,
           disclosure_grant_id, disclosure_grant_version,
           disclosure_policy_version, payload_hash, approval_hash,
           approval_event_sequence, state, revision, claim_id,
           ownership_token_digest, decision_id, decision_type,
           authenticated_session_id, resume_request_id,
           resume_space_access_grant_id,
           collection_authorization_scope_fingerprint, claimed_at,
           claim_expires_at, created_at, updated_at, expires_at, retain_until
         ) values (
           $1, $2, $3, $4, $5, $6, $7,
           'blocked-resume-selected-scheduler', $8, 'scheduler.calendar.write',
           $9, $10, $11, $12, $13, $14, '1.0.0', $15, $16,
           1, 'claimed', 3, $17, $18, $19, 'approved', $9, $10, $11,
           $20, pg_catalog.clock_timestamp() - interval '1 second',
           pg_catalog.clock_timestamp() + interval '4 minutes',
           pg_catalog.clock_timestamp() - interval '2 seconds',
           pg_catalog.clock_timestamp() - interval '1 second',
           pg_catalog.clock_timestamp() + interval '5 minutes',
           pg_catalog.clock_timestamp() + interval '89 days'
         )`,
        [
          ids.resumeJob,
          ids.household,
          ids.space,
          ids.user,
          ids.blockedManagerRun,
          ids.resumeConversation,
          ids.resumeCheckpoint,
          ids.resumeProposal,
          ids.session,
          ids.request,
          spaceAccessGrantId,
          authorizationScopeFingerprint,
          selectedDisclosure.grant.id,
          selectedDisclosure.grant.version,
          payloadHash,
          approvalHash,
          ids.resumeClaim,
          '1'.repeat(64),
          ids.resumeDecision,
          collectionAuthorizationScopeFingerprint,
        ],
      );
      await admin.query(
        `update emdo.agent_runs
            set status = 'blocked'
          where id = $1 and status = 'running'`,
        [ids.blockedManagerRun],
      );

      const dependentDisclosure = await issuer.issue({
        ...baseInput,
        agentId: 'finance',
        phasePurpose: 'specialist-execution',
        disclosurePurpose:
          'Run the dependent Finance specialist after the approved action.',
        recordAllowlist: [
          {
            dataClass: 'agent.specialist-outcomes',
            recordId: 'approved-scheduler-outcome',
            fields: ['summary'],
          },
        ],
      });
      const gateway = new PostgresModelDisclosureGateway(
        runtime.scopedPool,
        principal,
        new CanonicalRecordEnvelopeDisclosureFilter(),
      );
      await expect(
        gateway.authorize({
          requestId: ids.request,
          runId: ids.blockedManagerRun,
          householdId: ids.household,
          userId: ids.user,
          spaceAccessGrantId,
          agentId: 'finance',
          phasePurpose: 'specialist-execution',
          provider: 'openai',
          requestedGrantId: dependentDisclosure.grant.id,
          requestedDataClasses: ['agent.specialist-outcomes'],
          payload: {
            schemaVersion: 1,
            records: [
              {
                dataClass: 'agent.specialist-outcomes',
                recordId: 'approved-scheduler-outcome',
                fields: { summary: 'The approved Scheduler action completed.' },
              },
            ],
          },
        }),
      ).resolves.toMatchObject({
        status: 'authorized',
        grantId: dependentDisclosure.grant.id,
        agentId: 'finance',
      });
      await expect(
        issuer.issue({
          ...baseInput,
          agentId: 'manager',
          phasePurpose: 'manager-plan',
          disclosurePurpose: 'Planning must not restart on a blocked run.',
          recordAllowlist: [
            {
              dataClass: 'agent.specialist-outcomes',
              recordId: 'approved-scheduler-outcome',
              fields: ['summary'],
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'authorization-revoked' });

      const audit = await admin.query<{
        event_type: string;
        agent_id: string;
        phase_purpose: string;
        payload: unknown;
      }>(
        `select event_type, payload ->> 'agentId' as agent_id,
                payload ->> 'phasePurpose' as phase_purpose, payload
           from emdo.audit_events
          where run_id = $1 and payload ->> 'agentId' = 'finance'
          order by event_type`,
        [ids.blockedManagerRun],
      );
      expect(
        audit.rows.map(({ event_type, agent_id, phase_purpose }) => ({
          eventType: event_type,
          agentId: agent_id,
          phasePurpose: phase_purpose,
        })),
      ).toEqual([
        {
          eventType: 'model.disclosure.granted',
          agentId: 'finance',
          phasePurpose: 'specialist-execution',
        },
        {
          eventType: 'model.disclosure.sent',
          agentId: 'finance',
          phasePurpose: 'specialist-execution',
        },
      ]);
      expect(JSON.stringify(audit.rows)).not.toContain(
        'The approved Scheduler action completed.',
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

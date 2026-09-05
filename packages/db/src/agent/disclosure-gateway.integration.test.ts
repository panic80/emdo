import { createHash, randomUUID } from 'node:crypto';

import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type EmdoDatabaseClient } from '../client.js';
import { loadOrderedMigrations } from '../migrations.js';
import { PostgresSpaceAccessGrantService } from '../auth/space-access-grants.js';
import {
  CanonicalRecordEnvelopeDisclosureFilter,
  hashDataDisclosureGrant,
  PostgresDataDisclosureGrantIssuer,
  PostgresModelDisclosureGateway,
  PostgresSchedulerDisclosureGrantResolver,
} from './disclosure-gateway.js';
import {
  PostgresManagerTurnStore,
  type PostgresManagerTurnPrincipal,
} from './manager-turn-store.js';

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
  runRootInvocation: '82900000-0000-4000-8000-000000000010',
  runFinanceInvocation: '82900000-0000-4000-8000-000000000011',
  runFinancePhase: '82900000-0000-4000-8000-000000000012',
  managerRootInvocation: '82900000-0000-4000-8000-000000000013',
  managerSchedulerInvocation: '82900000-0000-4000-8000-000000000014',
  managerSchedulerPhase: '82900000-0000-4000-8000-000000000015',
  managerFinanceInvocation: '82900000-0000-4000-8000-000000000016',
  managerFinancePhase: '82900000-0000-4000-8000-000000000017',
  blockedRootInvocation: '82900000-0000-4000-8000-000000000018',
  blockedSchedulerInvocation: '82900000-0000-4000-8000-000000000019',
  blockedSchedulerPhase: '82900000-0000-4000-8000-00000000001a',
  blockedFinanceInvocation: '82900000-0000-4000-8000-00000000001b',
  blockedFinancePhase: '82900000-0000-4000-8000-00000000001c',
};
const principal = {
  userId: ids.user,
  sessionId: ids.session,
  requestId: ids.request,
  householdId: ids.household,
};
const loginRole = 'emdo_disclosure_integration_login';
const loginPassword = `emdo-test-${randomUUID()}`;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
};
const hashCanonicalJson = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

const financeCapabilities = [
  'finance.analytics.calculate',
  'finance.documents.read',
  'finance.documents.search',
  'finance.matches.read',
  'finance.records.read',
  'finance.records.write',
  'finance.statement.import',
] as const;
const schedulerCapabilities = ['google-calendar.event.create'] as const;
const managerFinanceCapabilities = ['agent.finance.delegate'] as const;
const managerSchedulerCapabilities = ['agent.scheduler.delegate'] as const;
const managerFinanceAndSchedulerCapabilities = [
  'agent.finance.delegate',
  'agent.scheduler.delegate',
] as const;
type ManagerCapabilities =
  | typeof managerFinanceCapabilities
  | typeof managerSchedulerCapabilities
  | typeof managerFinanceAndSchedulerCapabilities;

const managerInvocationIdentityFor = (
  runId: string,
  rootManagerInvocationId: string,
  phaseInvocationId: string,
  grantedCapabilities: ManagerCapabilities,
) => ({
  orchestrationRunId: runId,
  parentInvocationId: runId,
  agentInvocationId: rootManagerInvocationId,
  phaseInvocationId,
  actorId: ids.user,
  locale: 'en-CA' as const,
  grantedCapabilities,
});
const invocationIdentityFor = (
  runId: string,
  rootManagerInvocationId: string,
  agentId: 'finance' | 'scheduler',
  agentInvocationId: string,
  phaseInvocationId: string,
) => ({
  orchestrationRunId: runId,
  parentInvocationId: rootManagerInvocationId,
  agentInvocationId,
  phaseInvocationId,
  actorId: ids.user,
  locale: 'en-CA' as const,
  grantedCapabilities:
    agentId === 'finance' ? financeCapabilities : schedulerCapabilities,
});
// Invalid specialist fixtures preserve a structurally valid identity so their
// denial is specifically about the unregistered specialist or phase.
const invocationIdentityForInvalidAgent = (
  runId: string,
  rootManagerInvocationId: string,
  agentId: string,
) => ({
  orchestrationRunId: runId,
  parentInvocationId: rootManagerInvocationId,
  agentInvocationId: randomUUID(),
  phaseInvocationId: randomUUID(),
  actorId: ids.user,
  locale: 'en-CA' as const,
  grantedCapabilities:
    agentId === 'finance' ? financeCapabilities : schedulerCapabilities,
});

let invocation = {
  runManager: managerInvocationIdentityFor(
    ids.run,
    ids.runRootInvocation,
    ids.runFinancePhase,
    managerFinanceCapabilities,
  ),
  runFinance: invocationIdentityFor(
    ids.run,
    ids.runRootInvocation,
    'finance',
    ids.runFinanceInvocation,
    ids.runFinancePhase,
  ),
  managerRoot: managerInvocationIdentityFor(
    ids.managerRun,
    ids.managerRootInvocation,
    ids.managerSchedulerPhase,
    managerFinanceAndSchedulerCapabilities,
  ),
  managerScheduler: invocationIdentityFor(
    ids.managerRun,
    ids.managerRootInvocation,
    'scheduler',
    ids.managerSchedulerInvocation,
    ids.managerSchedulerPhase,
  ),
  managerFinance: invocationIdentityFor(
    ids.managerRun,
    ids.managerRootInvocation,
    'finance',
    ids.managerFinanceInvocation,
    ids.managerFinancePhase,
  ),
  blockedManager: managerInvocationIdentityFor(
    ids.blockedManagerRun,
    ids.blockedRootInvocation,
    ids.blockedSchedulerPhase,
    managerSchedulerCapabilities,
  ),
  blockedScheduler: invocationIdentityFor(
    ids.blockedManagerRun,
    ids.blockedRootInvocation,
    'scheduler',
    ids.blockedSchedulerInvocation,
    ids.blockedSchedulerPhase,
  ),
  blockedFinance: invocationIdentityFor(
    ids.blockedManagerRun,
    ids.blockedRootInvocation,
    'finance',
    ids.blockedFinanceInvocation,
    ids.blockedFinancePhase,
  ),
};

// These historical direct-SQL fixtures are configuration-gated. Keep their
// calls untyped while the isolated matrix is rewritten around manager roots;
// runtime repository parsing remains strict and therefore still fails closed
// if a fixture omits the new invocation identity.
const issueFixture = (
  issuer: PostgresDataDisclosureGrantIssuer,
  input: unknown,
) => issuer.issue(input as never);
const authorizeFixture = (
  gateway: PostgresModelDisclosureGateway,
  input: unknown,
) => gateway.authorize(input as never);

describeDatabase(
  'PostgreSQL 18 disclosure authority (requires isolated TEST_DISCLOSURE_DATABASE_URL)',
  () => {
    let admin: import('pg').Client;
    let runtime: EmdoDatabaseClient;
    let spaceAccessGrantId: string;
    let collectionAuthorizationScopeFingerprint: string;
    let managerTurnPrincipal: PostgresManagerTurnPrincipal;

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
      managerTurnPrincipal = {
        userId: active.userId,
        sessionId: active.sessionId,
        householdId: active.householdId,
        role: active.role,
        emailVerified: active.emailVerified,
        spaceAccessGrantId: active.spaceAccessGrantId,
        collectionAuthorizationScopeFingerprint:
          EffectiveAuthorizationScopeFingerprintSchema.parse(
            active.collectionAuthorizationScopeFingerprint,
          ),
      };
      const managerTurns = new PostgresManagerTurnStore(runtime.scopedPool, {
        requestedModel: 'gpt-5.6-luna',
      });
      const claimManagerTurn = async (
        idempotencyKey: string,
        routeHint: 'finance' | 'scheduler',
      ) => {
        const claim = await managerTurns.claim({
          request: {
            schemaVersion: 1,
            message: 'Prepare a disclosure authority fixture.',
            routeHint,
            locale: 'en-CA',
          },
          principal: managerTurnPrincipal,
          requestId: ids.request,
          idempotencyKey,
        });
        if (claim.status !== 'claimed') {
          throw new Error('Manager turn fixture was not claimed');
        }
        return claim;
      };
      const runTurn = await claimManagerTurn(
        'disclosure-integration-run-claim-v1',
        'finance',
      );
      const managerTurn = await claimManagerTurn(
        'disclosure-integration-manager-claim-v1',
        'scheduler',
      );
      ids.run = runTurn.runId;
      ids.runRootInvocation = runTurn.rootManagerInvocationId;
      ids.managerRun = managerTurn.runId;
      ids.managerRootInvocation = managerTurn.rootManagerInvocationId;
      invocation = {
        runManager: managerInvocationIdentityFor(
          ids.run,
          ids.runRootInvocation,
          ids.runFinancePhase,
          managerFinanceCapabilities,
        ),
        runFinance: invocationIdentityFor(
          ids.run,
          ids.runRootInvocation,
          'finance',
          ids.runFinanceInvocation,
          ids.runFinancePhase,
        ),
        managerRoot: managerInvocationIdentityFor(
          ids.managerRun,
          ids.managerRootInvocation,
          ids.managerSchedulerPhase,
          managerFinanceAndSchedulerCapabilities,
        ),
        managerScheduler: invocationIdentityFor(
          ids.managerRun,
          ids.managerRootInvocation,
          'scheduler',
          ids.managerSchedulerInvocation,
          ids.managerSchedulerPhase,
        ),
        managerFinance: invocationIdentityFor(
          ids.managerRun,
          ids.managerRootInvocation,
          'finance',
          ids.managerFinanceInvocation,
          ids.managerFinancePhase,
        ),
        blockedManager: invocation.blockedManager,
        blockedScheduler: invocation.blockedScheduler,
        blockedFinance: invocation.blockedFinance,
      };
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
        invocation: invocation.runFinance,
        recordAllowlist: [
          {
            dataClass: 'finance.transactions',
            recordId: 'transaction-1',
            fields: ['amount-cad-minor', 'merchant'],
          },
        ],
      };
      const [issued, replay] = await Promise.all([
        issueFixture(issuer, input),
        issueFixture(issuer, input),
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
      const authorizationInput = {
        requestId: ids.request,
        runId: ids.run,
        householdId: ids.household,
        userId: ids.user,
        spaceAccessGrantId,
        agentId: 'finance',
        phasePurpose: 'specialist-execution',
        phaseInvocationId: invocation.runFinance.phaseInvocationId,
        provider: 'openai',
        invocation: invocation.runFinance,
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
      };
      await expect(
        authorizeFixture(gateway, authorizationInput),
      ).resolves.toMatchObject({
        status: 'authorized',
        grantId: issued.grant.id,
        grantVersion: '1.0.0',
      });
      const proposalResolver = new PostgresSchedulerDisclosureGrantResolver(
        runtime.scopedPool,
        principal,
        {
          runId: ids.run,
          householdId: ids.household,
          userId: ids.user,
          spaceAccessGrantId,
          agentId: 'finance',
          phasePurpose: 'specialist-execution',
          provider: 'openai',
        },
      );
      await expect(
        proposalResolver.resolve(issued.grant.id, issued.grant),
      ).resolves.toEqual(issued.grant);
      await expect(
        authorizeFixture(gateway, authorizationInput),
      ).resolves.toEqual({
        status: 'denied',
        grantId: issued.grant.id,
        reason: 'grant-expired',
      });
      await admin.query(
        `update emdo.disclosure_grants
            set consumed_at = created_at,
                expires_at = created_at + interval '1 millisecond'
          where id = $1`,
        [issued.grant.id],
      );
      await expect(
        proposalResolver.resolve(issued.grant.id, issued.grant),
      ).resolves.toBeUndefined();
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

    it('fails closed for unconsumed, revoked, and mismatched proposal-grant bindings', async () => {
      const schedulerInvocation = invocationIdentityFor(
        ids.run,
        ids.runRootInvocation,
        'scheduler',
        randomUUID(),
        randomUUID(),
      );
      const issuer = new PostgresDataDisclosureGrantIssuer(
        runtime.scopedPool,
        principal,
      );
      const gateway = new PostgresModelDisclosureGateway(
        runtime.scopedPool,
        principal,
        new CanonicalRecordEnvelopeDisclosureFilter(),
      );
      const issued = await issueFixture(issuer, {
        requestId: ids.request,
        runId: ids.run,
        householdId: ids.household,
        userId: ids.user,
        spaceId: ids.space,
        spaceAccessGrantId,
        agentId: 'scheduler',
        phasePurpose: 'specialist-execution',
        disclosurePurpose: 'Prepare only the delegated scheduler record.',
        provider: 'openai',
        invocation: schedulerInvocation,
        recordAllowlist: [
          {
            dataClass: 'agent.delegations',
            recordId: 'proposal-scheduler-delegation',
            fields: ['delegation'],
          },
        ],
      });
      const resolver = new PostgresSchedulerDisclosureGrantResolver(
        runtime.scopedPool,
        principal,
        {
          runId: ids.run,
          householdId: ids.household,
          userId: ids.user,
          spaceAccessGrantId,
          agentId: 'scheduler',
          phasePurpose: 'specialist-execution',
          provider: 'openai',
        },
      );

      await expect(
        resolver.resolve(issued.grant.id, issued.grant),
      ).resolves.toBeUndefined();

      await expect(
        authorizeFixture(gateway, {
          requestId: ids.request,
          runId: ids.run,
          householdId: ids.household,
          userId: ids.user,
          spaceAccessGrantId,
          agentId: 'scheduler',
          phasePurpose: 'specialist-execution',
          phaseInvocationId: schedulerInvocation.phaseInvocationId,
          provider: 'openai',
          invocation: schedulerInvocation,
          requestedGrantId: issued.grant.id,
          requestedDataClasses: ['agent.delegations'],
          payload: {
            schemaVersion: 1,
            records: [
              {
                dataClass: 'agent.delegations',
                recordId: 'proposal-scheduler-delegation',
                fields: { delegation: 'calendar-event-create' },
              },
            ],
          },
        }),
      ).resolves.toMatchObject({
        status: 'authorized',
        grantId: issued.grant.id,
      });
      await expect(
        resolver.resolve(issued.grant.id, issued.grant),
      ).resolves.toEqual(issued.grant);

      const mismatchedContext = {
        ...issued.grant.invocationContext,
        phaseInvocationId: randomUUID(),
      };
      await expect(
        resolver.resolve(issued.grant.id, {
          invocationContext: mismatchedContext,
          invocationContextHash: hashCanonicalJson(mismatchedContext),
        }),
      ).resolves.toBeUndefined();
      await expect(
        resolver.resolve(issued.grant.id, {
          invocationContext: issued.grant.invocationContext,
          invocationContextHash: '0'.repeat(64),
        }),
      ).resolves.toBeUndefined();

      const mismatchedRunId = randomUUID();
      const mismatchedRunContext = {
        ...issued.grant.invocationContext,
        orchestrationRunId: mismatchedRunId,
      };
      const mismatchedRunResolver =
        new PostgresSchedulerDisclosureGrantResolver(
          runtime.scopedPool,
          principal,
          {
            runId: mismatchedRunId,
            householdId: ids.household,
            userId: ids.user,
            spaceAccessGrantId,
            agentId: 'scheduler',
            phasePurpose: 'specialist-execution',
            provider: 'openai',
          },
        );
      await expect(
        mismatchedRunResolver.resolve(issued.grant.id, {
          invocationContext: mismatchedRunContext,
          invocationContextHash: hashCanonicalJson(mismatchedRunContext),
        }),
      ).resolves.toBeUndefined();

      const mismatchedUserId = randomUUID();
      const mismatchedUserContext = {
        ...issued.grant.invocationContext,
        actorId: mismatchedUserId,
      };
      const mismatchedUserResolver =
        new PostgresSchedulerDisclosureGrantResolver(
          runtime.scopedPool,
          {
            ...principal,
            userId: mismatchedUserId,
          },
          {
            runId: ids.run,
            householdId: ids.household,
            userId: mismatchedUserId,
            spaceAccessGrantId,
            agentId: 'scheduler',
            phasePurpose: 'specialist-execution',
            provider: 'openai',
          },
        );
      await expect(
        mismatchedUserResolver.resolve(issued.grant.id, {
          invocationContext: mismatchedUserContext,
          invocationContextHash: hashCanonicalJson(mismatchedUserContext),
        }),
      ).resolves.toBeUndefined();

      await admin.query(
        `update emdo.disclosure_grants
            set revoked_at = pg_catalog.clock_timestamp()
          where id = $1`,
        [issued.grant.id],
      );
      await expect(
        resolver.resolve(issued.grant.id, issued.grant),
      ).resolves.toBeUndefined();
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

      const scheduler = await issueFixture(issuer, {
        ...managerRunInput,
        agentId: 'scheduler',
        phasePurpose: 'specialist-execution',
        disclosurePurpose: 'Prepare the delegated calendar context.',
        invocation: invocation.managerScheduler,
      });
      const finance = await issueFixture(issuer, {
        ...managerRunInput,
        agentId: 'finance',
        phasePurpose: 'specialist-execution',
        disclosurePurpose: 'Prepare the delegated finance context.',
        invocation: invocation.managerFinance,
      });

      await expect(
        authorizeFixture(gateway, {
          requestId: ids.request,
          runId: ids.managerRun,
          householdId: ids.household,
          userId: ids.user,
          spaceAccessGrantId,
          agentId: 'scheduler',
          phasePurpose: 'specialist-execution',
          phaseInvocationId: invocation.managerScheduler.phaseInvocationId,
          provider: 'openai',
          invocation: invocation.managerScheduler,
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
        authorizeFixture(gateway, {
          requestId: ids.request,
          runId: ids.managerRun,
          householdId: ids.household,
          userId: ids.user,
          spaceAccessGrantId,
          agentId: 'finance',
          phasePurpose: 'specialist-execution',
          phaseInvocationId: invocation.managerFinance.phaseInvocationId,
          provider: 'openai',
          invocation: invocation.managerFinance,
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
          issueFixture(issuer, {
            ...managerRunInput,
            agentId,
            phasePurpose,
            disclosurePurpose: 'This delegated disclosure must be denied.',
            invocation: invocationIdentityForInvalidAgent(
              ids.managerRun,
              ids.managerRootInvocation,
              agentId,
            ),
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
        [deniedGrantId, ids.household, ids.space, ids.user, ids.run],
      );
      const forgedInvocation = invocationIdentityForInvalidAgent(
        ids.managerRun,
        ids.managerRootInvocation,
        'shopping',
      );
      await expect(
        authorizeFixture(gateway, {
          requestId: ids.request,
          runId: ids.managerRun,
          householdId: ids.household,
          userId: ids.user,
          spaceAccessGrantId,
          agentId: 'shopping',
          phasePurpose: 'specialist-execution',
          phaseInvocationId: forgedInvocation.phaseInvocationId,
          provider: 'openai',
          invocation: forgedInvocation,
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
      const blockedTurn = await new PostgresManagerTurnStore(
        runtime.scopedPool,
        { requestedModel: 'gpt-5.6-luna' },
      ).claim({
        request: {
          schemaVersion: 1,
          message: 'Resume an approved Scheduler action.',
          routeHint: 'scheduler',
          locale: 'en-CA',
        },
        principal: managerTurnPrincipal,
        requestId: ids.request,
        idempotencyKey: 'disclosure-integration-blocked-claim-v1',
      });
      if (blockedTurn.status !== 'claimed') {
        throw new Error('Blocked manager turn fixture was not claimed');
      }
      ids.blockedManagerRun = blockedTurn.runId;
      ids.blockedRootInvocation = blockedTurn.rootManagerInvocationId;
      invocation = {
        ...invocation,
        blockedManager: managerInvocationIdentityFor(
          ids.blockedManagerRun,
          ids.blockedRootInvocation,
          ids.blockedSchedulerPhase,
          managerSchedulerCapabilities,
        ),
        blockedScheduler: invocationIdentityFor(
          ids.blockedManagerRun,
          ids.blockedRootInvocation,
          'scheduler',
          ids.blockedSchedulerInvocation,
          ids.blockedSchedulerPhase,
        ),
        blockedFinance: invocationIdentityFor(
          ids.blockedManagerRun,
          ids.blockedRootInvocation,
          'finance',
          ids.blockedFinanceInvocation,
          ids.blockedFinancePhase,
        ),
      };
      const baseInput = {
        requestId: ids.request,
        runId: ids.blockedManagerRun,
        householdId: ids.household,
        userId: ids.user,
        spaceId: ids.space,
        spaceAccessGrantId,
        provider: 'openai' as const,
      };

      const selectedDisclosure = await issueFixture(issuer, {
        ...baseInput,
        agentId: 'scheduler',
        phasePurpose: 'specialist-execution',
        disclosurePurpose: 'Run the selected Scheduler action.',
        invocation: invocation.blockedScheduler,
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
      const approvalEventSequence = (
        await admin.query<{ sequence: number }>(
          `select coalesce(max(sequence), 0) + 1 as sequence
             from emdo.agent_run_events
            where run_id = $1`,
          [ids.blockedManagerRun],
        )
      ).rows[0]!.sequence;
      await admin.query(
        `insert into emdo.agent_run_events(
           household_id, space_id, original_owner_user_id, run_id,
           sequence, event_type, payload, occurred_at, retain_until
         ) values (
           $1, $2, $3, $4, $5, 'approval.required',
           pg_catalog.jsonb_build_object(
             'status', 'needs-approval', 'runId', $4::uuid
           ),
           pg_catalog.clock_timestamp() - interval '1 second',
           pg_catalog.clock_timestamp() + interval '89 days'
         )`,
        [
          ids.household,
          ids.space,
          ids.user,
          ids.blockedManagerRun,
          approvalEventSequence,
        ],
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
           $21, 'claimed', 3, $17, $18, $19, 'approved', $9, $10, $11,
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
          approvalEventSequence,
        ],
      );
      await admin.query(
        `update emdo.agent_runs
            set status = 'blocked'
          where id = $1 and status = 'running'`,
        [ids.blockedManagerRun],
      );

      const dependentDisclosure = await issueFixture(issuer, {
        ...baseInput,
        agentId: 'finance',
        phasePurpose: 'specialist-execution',
        disclosurePurpose:
          'Run the dependent Finance specialist after the approved action.',
        invocation: invocation.blockedFinance,
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
        authorizeFixture(gateway, {
          requestId: ids.request,
          runId: ids.blockedManagerRun,
          householdId: ids.household,
          userId: ids.user,
          spaceAccessGrantId,
          agentId: 'finance',
          phasePurpose: 'specialist-execution',
          phaseInvocationId: invocation.blockedFinance.phaseInvocationId,
          provider: 'openai',
          invocation: invocation.blockedFinance,
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
        issueFixture(issuer, {
          ...baseInput,
          agentId: 'manager',
          phasePurpose: 'manager-plan',
          disclosurePurpose: 'Planning must not restart on a blocked run.',
          // This is a valid Scheduler-only manager identity. The only defect is
          // that a blocked run cannot start another manager planning phase.
          invocation: invocation.blockedManager,
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
        issueFixture(issuer, {
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
          invocation: invocation.runFinance,
          recordAllowlist: [
            {
              dataClass: 'finance.transactions',
              recordId: 'transaction-1',
              fields: ['merchant'],
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'authorization-revoked' });

      const privileges = await admin.query<{
        appDirectSelect: boolean;
        publicDirectSelect: boolean;
        appProposalResolverExecute: boolean;
        publicProposalResolverExecute: boolean;
      }>(
        `select pg_catalog.has_table_privilege(
                  'emdo_app', 'emdo.disclosure_grants', 'select'
                ) as "appDirectSelect",
                pg_catalog.has_table_privilege(
                  'public', 'emdo.disclosure_grants', 'select'
                ) as "publicDirectSelect",
                pg_catalog.has_function_privilege(
                  'emdo_app',
                  'emdo.resolve_consumed_disclosure_grant_for_proposal(uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text)'::regprocedure,
                  'execute'
                ) as "appProposalResolverExecute",
                pg_catalog.has_function_privilege(
                  'public',
                  'emdo.resolve_consumed_disclosure_grant_for_proposal(uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text)'::regprocedure,
                  'execute'
                ) as "publicProposalResolverExecute"`,
      );
      expect(privileges.rows).toEqual([
        {
          appDirectSelect: false,
          publicDirectSelect: false,
          appProposalResolverExecute: true,
          publicProposalResolverExecute: false,
        },
      ]);

      await admin.query('begin');
      try {
        await admin.query('set local role emdo_app');
        await admin.query('savepoint direct_disclosure_table_read');
        await expect(
          admin.query(`select * from emdo.disclosure_grants limit 1`),
        ).rejects.toThrow(/permission denied/u);
        await admin.query('rollback to savepoint direct_disclosure_table_read');
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
        authorizeFixture(gateway, {
          requestId: ids.request,
          runId: ids.run,
          householdId: ids.household,
          userId: ids.user,
          spaceAccessGrantId,
          agentId: 'finance',
          phasePurpose: 'specialist-execution',
          phaseInvocationId: invocation.runFinance.phaseInvocationId,
          provider: 'openai',
          invocation: invocation.runFinance,
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

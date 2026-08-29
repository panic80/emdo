import { createHash, randomUUID } from 'node:crypto';

import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresSpaceAccessGrantService } from '../auth/space-access-grants.js';
import { createDatabaseClient, type EmdoDatabaseClient } from '../client.js';
import {
  firstResultRow,
  withClaimedTransaction,
} from '../durable/scoped-transaction.js';
import { loadOrderedMigrations } from '../migrations.js';
import { PostgresManagerTurnStore } from './manager-turn-store.js';
import { PostgresRunEventSource } from './run-event-source.js';

const databaseUrl = process.env.TEST_RUN_EVENT_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const ids = Object.freeze({
  user: '84900000-0000-4000-8000-000000000001',
  session: '84900000-0000-4000-8000-000000000002',
  otherSession: '84900000-0000-4000-8000-00000000000e',
  firstRequest: '84900000-0000-4000-8000-000000000003',
  secondRequest: '84900000-0000-4000-8000-000000000004',
  household: '84900000-0000-4000-8000-000000000005',
  membership: '84900000-0000-4000-8000-000000000006',
  space: '84900000-0000-4000-8000-000000000007',
  disclosure: '84900000-0000-4000-8000-000000000008',
  proposal: '84900000-0000-4000-8000-000000000009',
  decision: '84900000-0000-4000-8000-00000000000a',
  checkpoint: '84900000-0000-4000-8000-00000000000b',
  approvalResumeJob: '84900000-0000-4000-8000-00000000000c',
  approvalResumeClaim: '84900000-0000-4000-8000-00000000000d',
});

const loginRole = 'emdo_run_event_integration_login';
const loginPassword = `emdo-test-${randomUUID()}`;
const approvalResumeOwnershipToken =
  'run-event-approval-resume-ownership-token-0001';
const hash = (input: string): string =>
  createHash('sha256').update(input).digest('hex');
const approvalResumeOwnershipTokenDigest = createHash('sha256')
  .update('emdo.approval-resume-owner.v1')
  .update('\0')
  .update(approvalResumeOwnershipToken)
  .digest('hex');
const approvalAuthorizationScopeFingerprint = hash(
  'run-event-approval-resume-operation-scope',
);
const approvalPayloadHash = hash('run-event-approval-resume-payload');
const approvalHash = hash('run-event-approval-resume-approval');

const collect = async <Value>(
  input: AsyncIterable<Value>,
): Promise<Value[]> => {
  const values: Value[] = [];
  for await (const value of input) values.push(value);
  return values;
};

const completedTurnResult = (
  runId: string,
  localTraceReference: string,
  hasPartialFailures = false,
) =>
  Object.freeze({
    status: 'completed',
    runId,
    localTraceReference,
    output: {
      message: 'The approved calendar action was completed.',
      mutation: { created: 1 },
    },
    specialistOutcomes: hasPartialFailures
      ? [
          {
            delegationId: 'finance-delegation-1',
            specialistId: 'finance',
            status: 'failed',
            safeError: {
              code: 'finance-document-unavailable',
              message: 'A Finance document could not be read safely.',
              retryable: false,
            },
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              modelCostCadMinor: 0,
            },
          },
        ]
      : [],
    hasPartialFailures,
    usage: {
      inputTokens: 7,
      outputTokens: 11,
      modelCostCadMinor: 13,
    },
    modelResolution: {
      status: 'resolved',
      requestedModel: 'gpt-5.6-terra',
      resolvedModel: 'gpt-5.6-terra',
      reason: 'default',
    },
  });

describeDatabase(
  'PostgreSQL 18 grant-bound manager run replay (isolated database only)',
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
    let approvalResumeRunId: string;
    let approvalResumeResult: ReturnType<typeof completedTurnResult>;
    let legacyCompletedResult: ReturnType<typeof completedTurnResult>;
    let legacyCompletedWrapper: Readonly<Record<string, unknown>>;

    const settleApprovalResumeAs = async (input: {
      readonly result: unknown;
      readonly ownershipToken?: string;
      readonly requestId?: string;
      readonly sessionId?: string;
    }): Promise<unknown> =>
      withClaimedTransaction(
        runtime.scopedPool,
        {
          userId: secondPrincipal.userId,
          sessionId: input.sessionId ?? secondPrincipal.sessionId,
          requestId: input.requestId ?? ids.secondRequest,
          householdId: secondPrincipal.householdId,
        },
        async (client) =>
          firstResultRow(
            await client.query(
              `select emdo.settle_approval_resume_job(
                 $1::uuid, $2::text, 'complete', null, $3::jsonb
               ) as settle_result`,
              [
                ids.approvalResumeClaim,
                input.ownershipToken ?? approvalResumeOwnershipToken,
                input.result,
              ],
            ),
          )?.settle_result,
      );

    const settleApprovalResume = async (result: unknown): Promise<unknown> =>
      settleApprovalResumeAs({ result });

    beforeAll(async () => {
      const { Client } = await import('pg');
      admin = new Client({ connectionString: databaseUrl });
      await admin.connect();
      const version = await admin.query(
        `select current_setting('server_version_num')::integer as version`,
      );
      const serverVersion = Number(version.rows[0]?.version);
      if (serverVersion < 180_000 || serverVersion >= 190_000) {
        throw new Error('TEST_RUN_EVENT_DATABASE_URL must use PostgreSQL 18');
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
      await admin.query(
        `insert into emdo.auth_sessions(
           id, user_id, token, expires_at, active_household_id
         ) values ($1, $2, 'run-event-other-session-token',
                   pg_catalog.clock_timestamp() + interval '1 hour', $3)`,
        [ids.otherSession, ids.user, ids.household],
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

      legacyCompletedResult = completedTurnResult(
        runId,
        'run-event-legacy-completed-trace',
      );
      legacyCompletedWrapper = Object.freeze({
        schemaVersion: 1,
        runId,
        proposalId: ids.proposal,
        approvalDecisionId: ids.decision,
        status: 'completed',
        result: legacyCompletedResult,
      });
      await admin.query(
        `insert into emdo.agent_run_events(
           household_id, space_id, original_owner_user_id, run_id,
           sequence, event_type, payload, occurred_at, retain_until
         ) values (
           $1, $2, $3, $4, 3, 'agent.turn.completed', $5::jsonb,
           pg_catalog.clock_timestamp(),
           pg_catalog.clock_timestamp() + interval '89 days'
         )`,
        [ids.household, ids.space, ids.user, runId, legacyCompletedWrapper],
      );

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

      const approvalResumeClaim = await store.claim({
        request: {
          schemaVersion: 1,
          message: 'Finish the approved calendar action.',
          routeHint: 'scheduler',
        },
        principal: secondPrincipal,
        requestId: ids.secondRequest,
        idempotencyKey: 'run-event-integration-claim-0002',
      });
      if (approvalResumeClaim.status !== 'claimed') {
        throw new Error(
          'Second manager turn was not claimed in the isolated database',
        );
      }
      approvalResumeRunId = approvalResumeClaim.runId;
      approvalResumeResult = completedTurnResult(
        approvalResumeRunId,
        'run-event-approval-resume-completed-trace',
        true,
      );

      await admin.query(
        `insert into emdo.disclosure_grants(
           id, schema_version, version, household_id, space_id, user_id,
           run_id, agent_id, purpose, phase_purpose, provider,
           record_allowlist, grant_hash, created_at, expires_at, one_run_only
         ) values (
           $1, 1, 1, $2, $3, $4, $5, 'scheduler',
           'Resume one approved calendar action.', 'specialist-execution',
           'openai', '[]'::jsonb, $6,
           pg_catalog.clock_timestamp() - interval '1 second',
           pg_catalog.clock_timestamp() + interval '5 minutes', true
         )`,
        [
          ids.disclosure,
          ids.household,
          ids.space,
          ids.user,
          approvalResumeRunId,
          hash('run-event-approval-resume-disclosure'),
        ],
      );
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
           'run-event-approval-resume-calendar-write',
           pg_catalog.jsonb_build_object(
             'id', $6::uuid, 'runId', $5::uuid,
             'householdId', $2::uuid, 'userId', $4::uuid
           ),
           'scheduler.calendar.write', $9,
           '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb,
           '{"schemaVersion":1,"title":"Review calendar action","summary":"Review the approved calendar action.","beforeSummary":"","afterSummary":"","fields":[]}'::jsonb,
           '{}'::jsonb, $10, $11,
           'run-event-approval-resume-proposal-0001',
           pg_catalog.clock_timestamp() - interval '1 second',
           pg_catalog.clock_timestamp() + interval '5 minutes'
         )`,
        [
          ids.proposal,
          ids.household,
          ids.space,
          ids.user,
          approvalResumeRunId,
          ids.disclosure,
          approvalAuthorizationScopeFingerprint,
          hash('run-event-approval-resume-provider-authority'),
          hash('run-event-approval-resume-capability'),
          approvalPayloadHash,
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
           'run-event-approval-resume-decision-0001'
         )`,
        [
          ids.decision,
          ids.proposal,
          ids.household,
          ids.space,
          ids.user,
          ids.session,
          approvalPayloadHash,
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
           'run-event-integration', 'sealed approval checkpoint',
           pg_catalog.clock_timestamp() - interval '1 second',
           pg_catalog.clock_timestamp() + interval '5 minutes',
           pg_catalog.clock_timestamp() - interval '1 second',
           pg_catalog.clock_timestamp() + interval '89 days'
         )`,
        [
          ids.checkpoint,
          ids.household,
          ids.space,
          ids.user,
          approvalResumeRunId,
          hash('run-event-approval-resume-graph'),
        ],
      );
      await admin.query(
        `insert into emdo.agent_run_events(
           household_id, space_id, original_owner_user_id, run_id,
           sequence, event_type, payload, occurred_at, retain_until
         ) values (
           $1, $2, $3, $4, 2, 'approval.required',
           pg_catalog.jsonb_build_object(
             'status', 'needs-approval', 'runId', $4::uuid
           ),
           pg_catalog.clock_timestamp() - interval '1 second',
           pg_catalog.clock_timestamp() + interval '89 days'
         )`,
        [ids.household, ids.space, ids.user, approvalResumeRunId],
      );
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
           'run-event-approval-resume', $8, 'scheduler.calendar.write',
           $9, $10, $11, $12, $13, 1, '1.0.0', $14, $15,
           2, 'claimed', 3, $16, $17, $18, 'approved', $9, $19, $20,
           $21, pg_catalog.statement_timestamp() - interval '7 minutes',
           pg_catalog.statement_timestamp() - interval '2 minutes',
           pg_catalog.statement_timestamp() - interval '11 minutes',
           pg_catalog.statement_timestamp() - interval '7 minutes',
           pg_catalog.statement_timestamp() - interval '1 minute',
           pg_catalog.statement_timestamp() + interval '89 days'
         )`,
        [
          ids.approvalResumeJob,
          ids.household,
          ids.space,
          ids.user,
          approvalResumeRunId,
          approvalResumeClaim.conversationId,
          ids.checkpoint,
          ids.proposal,
          ids.session,
          ids.firstRequest,
          firstPrincipal.spaceAccessGrantId,
          approvalAuthorizationScopeFingerprint,
          ids.disclosure,
          approvalPayloadHash,
          approvalHash,
          ids.approvalResumeClaim,
          approvalResumeOwnershipTokenDigest,
          ids.decision,
          ids.secondRequest,
          secondPrincipal.spaceAccessGrantId,
          secondPrincipal.collectionAuthorizationScopeFingerprint,
        ],
      );
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

    it('replays canonical and legacy persisted events with a rotated fresh grant but denies the stale request grant', async () => {
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
          { sequence: 3, type: 'run.completed' },
        ],
      );
      expect(current[2]?.data).toEqual(legacyCompletedResult);
      expect(current.every((event) => !('id' in event))).toBe(true);

      const rawLegacy = await admin.query<{
        event_type: string;
        payload: unknown;
      }>(
        `select event_type, payload
           from emdo.agent_run_events
          where run_id = $1 and sequence = 3`,
        [runId],
      );
      expect(rawLegacy.rows).toEqual([
        {
          event_type: 'agent.turn.completed',
          payload: legacyCompletedWrapper,
        },
      ]);

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

    it('rejects mismatched expired-claim settlement, then appends and replays one direct completed terminal event', async () => {
      const malformedUsage = {
        ...approvalResumeResult,
        usage: {
          inputTokens: -1,
          outputTokens: 11.5,
          modelCostCadMinor: 13,
        },
      };
      const incompleteModelResolution = {
        ...approvalResumeResult,
        modelResolution: { status: 'resolved' },
      };
      const nullSpecialistStatus = {
        ...approvalResumeResult,
        specialistOutcomes: [
          {
            delegationId: 'scheduler-delegation-1',
            specialistId: 'scheduler',
            status: null,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              modelCostCadMinor: 0,
            },
          },
        ],
      };

      await expect(settleApprovalResume(malformedUsage)).resolves.toEqual({
        status: 'conflict',
      });
      await expect(
        settleApprovalResume(incompleteModelResolution),
      ).resolves.toEqual({ status: 'conflict' });
      await expect(settleApprovalResume(nullSpecialistStatus)).resolves.toEqual(
        { status: 'conflict' },
      );
      await expect(
        settleApprovalResumeAs({
          result: approvalResumeResult,
          ownershipToken: 'run-event-wrong-ownership-token-0001',
        }),
      ).resolves.toEqual({ status: 'conflict' });
      await expect(
        settleApprovalResumeAs({
          result: approvalResumeResult,
          requestId: ids.firstRequest,
        }),
      ).resolves.toEqual({ status: 'conflict' });
      await expect(
        settleApprovalResumeAs({
          result: approvalResumeResult,
          sessionId: ids.otherSession,
        }),
      ).resolves.toEqual({ status: 'conflict' });

      const staleUsage = {
        inputTokens: 1,
        outputTokens: 2,
        modelCostCadMinor: 3,
      };
      const staleSafeError = {
        code: 'pre-resume-stale',
        message: 'Stale pre-resume error.',
        retryable: false,
      };
      const failedResumeResult = {
        status: 'failed',
        runId: approvalResumeRunId,
        localTraceReference: 'run-event-approval-resume-failed-trace',
        safeError: {
          code: 'approval-resume-provider-failed',
          message: 'The resumed provider action failed safely.',
          retryable: false,
        },
        specialistOutcomes: [],
        usage: {
          inputTokens: 17,
          outputTokens: 19,
          modelCostCadMinor: 23,
        },
        modelResolution: {
          status: 'unavailable',
          requestedModel: 'gpt-5.6-luna',
          attemptedModels: ['gpt-5.6-luna'],
          reason: 'configured-model-fallback-not-allowed',
          safeError: {
            code: 'agent-model-fallback-not-allowed',
            message: 'The active agent policy does not allow a model fallback.',
            retryable: false,
          },
        },
      };
      const probeSettlementMetadata = async (input: {
        readonly mode:
          'complete' | 'terminalize-not-dispatched' | 'indeterminate';
        readonly reasonCode: string | null;
        readonly result: unknown;
      }) => {
        await admin.query('begin');
        try {
          await admin.query(
            `update emdo.agent_runs
                set status = 'blocked', resolved_model = 'gpt-5.6-luna',
                    model_reason = 'luna-unavailable',
                    local_trace_reference = 'pre-resume-stale-trace',
                    safe_error = $2::jsonb, usage = $3::jsonb
              where id = $1 and status = 'running' and completed_at is null`,
            [approvalResumeRunId, staleSafeError, staleUsage],
          );
          await admin.query(
            `select pg_catalog.set_config('emdo.user_id', $1, true),
                    pg_catalog.set_config('emdo.session_id', $2, true),
                    pg_catalog.set_config('emdo.request_id', $3, true),
                    pg_catalog.set_config('emdo.household_id', $4, true)`,
            [ids.user, ids.session, ids.secondRequest, ids.household],
          );
          await admin.query('set local role emdo_app');
          const settlement = await admin.query<{ settle_result: unknown }>(
            `select emdo.settle_approval_resume_job(
               $1::uuid, $2::text, $3::text, $4::text, $5::jsonb
             ) as settle_result`,
            [
              ids.approvalResumeClaim,
              approvalResumeOwnershipToken,
              input.mode,
              input.reasonCode,
              input.result,
            ],
          );
          await admin.query('reset role');
          const projection = await admin.query<{
            resume_state: string;
            run_status: string;
            resolved_model: string | null;
            model_reason: string | null;
            local_trace_reference: string;
            safe_error: unknown;
            usage: unknown;
            completed_at: Date;
          }>(
            `select resume.state as resume_state, run.status as run_status,
                    run.resolved_model, run.model_reason,
                    run.local_trace_reference, run.safe_error, run.usage,
                    run.completed_at
               from emdo.approval_resume_jobs as resume
               join emdo.agent_runs as run on run.id = resume.run_id
              where resume.job_id = $1`,
            [ids.approvalResumeJob],
          );
          return {
            settlement: settlement.rows[0]?.settle_result,
            projection: projection.rows[0],
          };
        } finally {
          await admin.query('rollback');
        }
      };

      const failedProbe = await probeSettlementMetadata({
        mode: 'complete',
        reasonCode: null,
        result: failedResumeResult,
      });
      expect(failedProbe.settlement).toEqual({
        status: 'completed',
        terminalEventSequence: 3,
      });
      expect(failedProbe.projection).toMatchObject({
        resume_state: 'terminal',
        run_status: 'failed',
        resolved_model: null,
        model_reason: 'configured-model-fallback-not-allowed',
        local_trace_reference: failedResumeResult.localTraceReference,
        safe_error: failedResumeResult.safeError,
        usage: failedResumeResult.usage,
      });
      expect(failedProbe.projection?.completed_at).toBeInstanceOf(Date);

      for (const branch of [
        {
          mode: 'terminalize-not-dispatched' as const,
          reasonCode: 'approval-resume-binding-invalid',
          expectedState: 'terminal',
          expectedStatus: 'terminalized',
          expectedTrace: 'approval-resume-terminalized-before-dispatch',
          expectedSafeError: {
            code: 'approval-resume-binding-invalid',
            message: 'The approved action could not be resumed safely.',
            retryable: false,
          },
        },
        {
          mode: 'indeterminate' as const,
          reasonCode: 'approval-resume-failed',
          expectedState: 'indeterminate',
          expectedStatus: 'indeterminate',
          expectedTrace: 'approval-resume-indeterminate',
          expectedSafeError: {
            code: 'approval-resume-failed',
            message: 'The approved action could not be completed safely.',
            retryable: false,
          },
        },
      ]) {
        const probe = await probeSettlementMetadata({
          mode: branch.mode,
          reasonCode: branch.reasonCode,
          result: null,
        });
        expect(probe.settlement).toEqual({
          status: branch.expectedStatus,
          terminalEventSequence: 3,
        });
        expect(probe.projection).toMatchObject({
          resume_state: branch.expectedState,
          run_status: 'failed',
          resolved_model: 'gpt-5.6-luna',
          model_reason: 'luna-unavailable',
          local_trace_reference: branch.expectedTrace,
          safe_error: branch.expectedSafeError,
          usage: staleUsage,
        });
        expect(probe.projection?.completed_at).toBeInstanceOf(Date);
      }

      const expiredClaimOwnership = await admin.query<{
        claim_id: string;
        ownership_token_digest: string;
        revision: number;
        claim_expired: boolean;
        job_expired: boolean;
      }>(
        `select claim_id, ownership_token_digest, revision,
                claim_expires_at <= pg_catalog.clock_timestamp()
                  as claim_expired,
                expires_at <= pg_catalog.clock_timestamp() as job_expired
           from emdo.approval_resume_jobs
          where job_id = $1`,
        [ids.approvalResumeJob],
      );
      expect(expiredClaimOwnership.rows).toEqual([
        {
          claim_id: ids.approvalResumeClaim,
          ownership_token_digest: approvalResumeOwnershipTokenDigest,
          revision: 3,
          claim_expired: true,
          job_expired: true,
        },
      ]);

      await expect(
        settleApprovalResume(approvalResumeResult),
      ).rejects.toMatchObject({
        code: 'P0001',
        message: 'approval resume run lock failed',
      });

      const beforeValidSettlement = await admin.query<{
        state: string;
        terminal_event_sequence: number | null;
        terminal_result_hash: string | null;
        event_count: string;
        run_status: string;
        completed_at: Date | null;
        checkpoint_state: string;
      }>(
        `select resume.state, resume.terminal_event_sequence,
                resume.terminal_result_hash,
                run.status as run_status, run.completed_at,
                checkpoint.state as checkpoint_state,
                (select count(*)::text from emdo.agent_run_events
                  where run_id = $2) as event_count
           from emdo.approval_resume_jobs as resume
           join emdo.agent_runs as run on run.id = resume.run_id
           join emdo.approval_checkpoints as checkpoint
             on checkpoint.checkpoint_id = resume.checkpoint_id
          where resume.job_id = $1`,
        [ids.approvalResumeJob, approvalResumeRunId],
      );
      expect(beforeValidSettlement.rows).toEqual([
        {
          state: 'claimed',
          terminal_event_sequence: null,
          terminal_result_hash: null,
          event_count: '2',
          run_status: 'running',
          completed_at: null,
          checkpoint_state: 'pending',
        },
      ]);

      const pausedRun = await admin.query<{
        status: string;
        completed_at: Date | null;
      }>(
        `update emdo.agent_runs
            set status = 'blocked',
                resolved_model = 'gpt-5.6-luna',
                model_reason = 'luna-unavailable',
                local_trace_reference = 'pre-resume-stale-trace',
                safe_error = '{"code":"pre-resume-stale","message":"Stale pre-resume error.","retryable":false}'::jsonb,
                usage = '{"inputTokens":1,"outputTokens":2,"modelCostCadMinor":3}'::jsonb
          where id = $1 and status = 'running' and completed_at is null
          returning status, completed_at`,
        [approvalResumeRunId],
      );
      expect(pausedRun.rows).toEqual([
        { status: 'blocked', completed_at: null },
      ]);

      await expect(settleApprovalResume(approvalResumeResult)).resolves.toEqual(
        {
          status: 'completed',
          terminalEventSequence: 3,
        },
      );

      const storedEvents = await admin.query<{
        sequence: string;
        event_type: string;
        payload: unknown;
      }>(
        `select sequence, event_type, payload
           from emdo.agent_run_events
          where run_id = $1
          order by sequence`,
        [approvalResumeRunId],
      );
      expect(
        storedEvents.rows.filter(
          (event) => event.event_type === 'run.completed',
        ),
      ).toEqual([
        {
          sequence: '3',
          event_type: 'run.completed',
          payload: approvalResumeResult,
        },
      ]);

      const source = new PostgresRunEventSource(runtime.scopedPool);
      const replayed = await collect(
        await source.open({
          runId: approvalResumeRunId,
          afterSequence: 0,
          principal: secondPrincipal,
          requestId: ids.secondRequest,
          abortSignal: new AbortController().signal,
        }),
      );
      expect(
        replayed.map(({ sequence, type }) => ({ sequence, type })),
      ).toEqual([
        { sequence: 1, type: 'run.accepted' },
        { sequence: 2, type: 'approval.required' },
        { sequence: 3, type: 'run.completed' },
      ]);
      expect(replayed[2]?.data).toEqual(approvalResumeResult);

      const terminal = await admin.query<{
        state: string;
        terminal_event_sequence: string;
        terminal_result_hash: string;
        run_status: string;
        resolved_model: string;
        model_reason: string;
        local_trace_reference: string;
        safe_error: unknown;
        usage: unknown;
        completed_at: Date;
        checkpoint_state: string;
      }>(
        `select resume.state, resume.terminal_event_sequence,
                resume.terminal_result_hash, run.status as run_status,
                run.resolved_model, run.model_reason,
                run.local_trace_reference, run.safe_error, run.usage,
                run.completed_at, checkpoint.state as checkpoint_state
           from emdo.approval_resume_jobs as resume
           join emdo.agent_runs as run on run.id = resume.run_id
           join emdo.approval_checkpoints as checkpoint
             on checkpoint.checkpoint_id = resume.checkpoint_id
          where resume.job_id = $1`,
        [ids.approvalResumeJob],
      );
      const auditEnvelope = await admin.query<{ payload: string }>(
        `select pg_catalog.jsonb_strip_nulls(
           pg_catalog.jsonb_build_object(
             'schemaVersion', 1,
             'runId', $1::uuid,
             'proposalId', $2::uuid,
             'approvalDecisionId', $3::uuid,
             'status', 'completed',
             'reasonCode', null,
             'result', $4::jsonb
           )
         )::text as payload`,
        [approvalResumeRunId, ids.proposal, ids.decision, approvalResumeResult],
      );
      const auditPayload = auditEnvelope.rows[0]?.payload;
      if (auditPayload === undefined) {
        throw new Error('Approval-resume audit envelope was not rendered');
      }
      const expectedTerminalResultHash = createHash('sha256')
        .update('emdo.approval-resume-terminal.v1')
        .update('\0')
        .update(auditPayload)
        .digest('hex');
      expect(terminal.rows).toHaveLength(1);
      expect(terminal.rows[0]).toMatchObject({
        state: 'terminal',
        terminal_event_sequence: '3',
        terminal_result_hash: expectedTerminalResultHash,
        run_status: 'completed',
        resolved_model: approvalResumeResult.modelResolution.resolvedModel,
        model_reason: approvalResumeResult.modelResolution.reason,
        local_trace_reference: approvalResumeResult.localTraceReference,
        safe_error: null,
        usage: approvalResumeResult.usage,
        checkpoint_state: 'cancelled',
      });
      expect(terminal.rows[0]?.completed_at).toBeInstanceOf(Date);

      await expect(settleApprovalResume(approvalResumeResult)).resolves.toEqual(
        {
          status: 'replay',
          terminalEventSequence: 3,
        },
      );
      const terminalEventCount = await admin.query<{ count: string }>(
        `select count(*)::text as count
           from emdo.agent_run_events
          where run_id = $1 and event_type = 'run.completed'`,
        [approvalResumeRunId],
      );
      expect(terminalEventCount.rows).toEqual([{ count: '1' }]);
    });

    it('keeps the helpers private and grants only the bounded aggregates', async () => {
      const privileges = await admin.query(
        `select
           pg_catalog.has_function_privilege(
             $1, 'emdo.read_agent_run_events(uuid,uuid,bigint,integer)',
             'EXECUTE'
           ) as can_read,
           pg_catalog.has_function_privilege(
             $1, 'emdo.settle_approval_resume_job(uuid,text,text,text,jsonb)',
             'EXECUTE'
           ) as can_settle,
           pg_catalog.has_function_privilege(
             $1, 'emdo.lock_current_authorization_scope(uuid,uuid,uuid)',
             'EXECUTE'
           ) as can_lock_scope,
           pg_catalog.has_table_privilege(
             $1, 'emdo.approval_resume_jobs', 'SELECT'
           ) as can_read_resume_jobs`,
        [loginRole],
      );
      expect(privileges.rows[0]).toEqual({
        can_read: true,
        can_settle: true,
        can_lock_scope: false,
        can_read_resume_jobs: false,
      });
    });
  },
);

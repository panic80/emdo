import { createHash } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from './migrations.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe.sequential : describe.skip;

const ids = Object.freeze({
  auditA: '82000000-0000-4000-8000-000000000091',
  auditB: '82000000-0000-4000-8000-000000000092',
  decisionA: '82000000-0000-4000-8000-000000000071',
  decisionB: '82000000-0000-4000-8000-000000000072',
  decisionFuture: '82000000-0000-4000-8000-000000000073',
  decisionPrepare: '82000000-0000-4000-8000-000000000074',
  decisionRotated: '82000000-0000-4000-8000-000000000075',
  decisionNewSession: '82000000-0000-4000-8000-000000000076',
  decisionAdminDrift: '82000000-0000-4000-8000-000000000077',
  decisionSpaceDrift: '82000000-0000-4000-8000-000000000078',
  decisionProviderDrift: '82000000-0000-4000-8000-000000000079',
  disclosureA: '82000000-0000-4000-8000-000000000051',
  disclosureB: '82000000-0000-4000-8000-000000000052',
  household: '82000000-0000-4000-8000-000000000020',
  membershipA: '82000000-0000-4000-8000-000000000021',
  membershipB: '82000000-0000-4000-8000-000000000022',
  providerAttemptA: '82000000-0000-4000-8000-000000000081',
  providerAttemptB: '82000000-0000-4000-8000-000000000082',
  providerAttemptFuture: '82000000-0000-4000-8000-000000000083',
  proposalA: '82000000-0000-4000-8000-000000000061',
  proposalB: '82000000-0000-4000-8000-000000000062',
  proposalFuture: '82000000-0000-4000-8000-000000000063',
  proposalIssuedFuture: '82000000-0000-4000-8000-000000000064',
  proposalVisual: '82000000-0000-4000-8000-000000000068',
  proposalPrepare: '82000000-0000-4000-8000-000000000069',
  requestA: '82000000-0000-4000-8000-000000000013',
  requestB: '82000000-0000-4000-8000-000000000014',
  requestARotated: '82000000-0000-4000-8000-000000000015',
  requestANewSession: '82000000-0000-4000-8000-000000000017',
  runA: '82000000-0000-4000-8000-000000000041',
  runA2: '82000000-0000-4000-8000-000000000043',
  runB: '82000000-0000-4000-8000-000000000042',
  sessionA: '82000000-0000-4000-8000-000000000011',
  sessionB: '82000000-0000-4000-8000-000000000012',
  sessionANew: '82000000-0000-4000-8000-000000000016',
  spaceA: '82000000-0000-4000-8000-000000000031',
  spaceB: '82000000-0000-4000-8000-000000000032',
  spaceSharedDrift: '82000000-0000-4000-8000-000000000034',
  spaceAccessA: '82000000-0000-4000-8000-000000000101',
  spaceAccessB: '82000000-0000-4000-8000-000000000102',
  spaceAccessARotated: '82000000-0000-4000-8000-000000000103',
  spaceAccessANewSession: '82000000-0000-4000-8000-000000000104',
  userA: '82000000-0000-4000-8000-000000000001',
  userB: '82000000-0000-4000-8000-000000000002',
});

const bindingHash = '5'.repeat(64);
const preparationBindingHash = '8'.repeat(64);
const providerGrantReferenceA = 'google-grant-reference-workflow-a';
const providerGrantReferenceB = 'google-grant-reference-workflow-b';
const providerSdkCallId = 'sdk-call-workflow-calendar-create-1';
const providerPrepareSdkCallId = 'sdk-call-workflow-calendar-prepare-1';
const visualDecisionSdkCallId = 'sdk-call-workflow-calendar-visual-1';
const authorizationScopeFingerprint = (input: {
  householdId: string;
  membershipId: string;
  privateSpaceId: string;
  proposalSpaceId: string;
  role: 'member' | 'owner';
  sessionId: string;
  userId: string;
  writableSpaceIds: readonly string[];
}) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        domain: 'emdo.authorization-scope.v1',
        householdId: input.householdId,
        membershipAdministrationVersion: 1,
        membershipId: input.membershipId,
        privateSpaceId: input.privateSpaceId,
        proposalSpaceId: input.proposalSpaceId,
        role: input.role,
        sessionId: input.sessionId,
        userId: input.userId,
        writableSpaceIds: [...input.writableSpaceIds].sort(),
      }),
    )
    .digest('hex');
const authorizationScopeFingerprintA = authorizationScopeFingerprint({
  householdId: ids.household,
  membershipId: ids.membershipA,
  privateSpaceId: ids.spaceA,
  proposalSpaceId: ids.spaceA,
  role: 'owner',
  sessionId: ids.sessionA,
  userId: ids.userA,
  writableSpaceIds: [ids.spaceA],
});
const authorizationScopeFingerprintB = authorizationScopeFingerprint({
  householdId: ids.household,
  membershipId: ids.membershipB,
  privateSpaceId: ids.spaceB,
  proposalSpaceId: ids.spaceB,
  role: 'member',
  sessionId: ids.sessionB,
  userId: ids.userB,
  writableSpaceIds: [ids.spaceB],
});
const providerAuthorityHash = (input: {
  authorizationEpoch: number;
  authorizationScopeFingerprint: string;
  householdId: string;
  privateSpaceId: string;
  providerGrantReference: string;
}) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        authorizationEpoch: input.authorizationEpoch,
        authorizationScopeFingerprint: input.authorizationScopeFingerprint,
        householdId: input.householdId,
        kind: 'google-calendar-grant-v2',
        privateSpaceId: input.privateSpaceId,
        providerGrantReference: input.providerGrantReference,
      }),
    )
    .digest('hex');
const providerAuthorityHashA = providerAuthorityHash({
  authorizationEpoch: 0,
  authorizationScopeFingerprint: authorizationScopeFingerprintA,
  householdId: ids.household,
  privateSpaceId: ids.spaceA,
  providerGrantReference: providerGrantReferenceA,
});
const providerAuthorityHashB = providerAuthorityHash({
  authorizationEpoch: 0,
  authorizationScopeFingerprint: authorizationScopeFingerprintB,
  householdId: ids.household,
  privateSpaceId: ids.spaceB,
  providerGrantReference: providerGrantReferenceB,
});
const testOperationId = (marker: string): string => `wp_${marker.repeat(40)}`;

const seedAuthorityFixtures = async (client: import('pg').Client) => {
  await client.query(
    `insert into emdo.auth_users (id, name, email, email_verified)
     values ($1, 'Workflow User A', 'workflow-a@example.test', true),
            ($2, 'Workflow User B', 'workflow-b@example.test', true)`,
    [ids.userA, ids.userB],
  );
  await client.query(
    `insert into emdo.households (id, name, slug, created_by_user_id)
     values ($1, 'Workflow Household', 'workflow-household', $2)`,
    [ids.household, ids.userA],
  );
  await client.query(
    `insert into emdo.household_memberships
       (id, household_id, user_id, role, status, joined_at)
     values ($2, $1, $3, 'owner', 'active', pg_catalog.clock_timestamp()),
            ($4, $1, $5, 'member', 'active', pg_catalog.clock_timestamp())`,
    [ids.household, ids.membershipA, ids.userA, ids.membershipB, ids.userB],
  );
  await client.query(
    `insert into emdo.spaces
       (id, household_id, original_owner_user_id, name, visibility)
     values ($1, $3, $4, 'User A private', 'private'),
            ($2, $3, $5, 'User B private', 'private')`,
    [ids.spaceA, ids.spaceB, ids.household, ids.userA, ids.userB],
  );
  await client.query(
    `insert into emdo.auth_sessions
       (id, user_id, token, expires_at, active_household_id)
     values ($1, $2, 'workflow-session-token-a',
             pg_catalog.clock_timestamp() + interval '1 hour', $5),
            ($3, $4, 'workflow-session-token-b',
             pg_catalog.clock_timestamp() + interval '1 hour', $5),
            ($6, $2, 'workflow-session-token-a-new',
             pg_catalog.clock_timestamp() + interval '1 hour', $5)`,
    [
      ids.sessionA,
      ids.userA,
      ids.sessionB,
      ids.userB,
      ids.household,
      ids.sessionANew,
    ],
  );
  await client.query(
    `insert into emdo.agent_runs
       (id, household_id, space_id, original_owner_user_id, agent_id,
        agent_version, requested_model, status)
     values ($1, $3, $4, $5, 'scheduler.agent', '1.0.0',
             'gpt-5.6-luna', 'running'),
            ($2, $3, $6, $7, 'scheduler.agent', '1.0.0',
             'gpt-5.6-luna', 'running'),
            ($8, $3, $4, $5, 'scheduler.agent', '1.0.0',
             'gpt-5.6-luna', 'running')`,
    [
      ids.runA,
      ids.runB,
      ids.household,
      ids.spaceA,
      ids.userA,
      ids.spaceB,
      ids.userB,
      ids.runA2,
    ],
  );
  await client.query(
    `insert into emdo.space_access_grants
       (grant_id, household_id, original_owner_user_id, session_id,
        request_id, membership_id, role, private_space_id,
        writable_space_ids, issued_at, expires_at, retain_until)
     select $1::uuid, membership.household_id, membership.user_id,
            $2::uuid, $3::uuid, membership.id, membership.role,
            $4::uuid, array[$4::uuid],
            pg_catalog.clock_timestamp(),
            pg_catalog.clock_timestamp() + interval '10 minutes',
            pg_catalog.clock_timestamp() + interval '89 days'
       from emdo.household_memberships as membership
      where membership.household_id = $5::uuid
        and membership.user_id = $6::uuid
     union all
     select $7::uuid, membership.household_id, membership.user_id,
            $8::uuid, $9::uuid, membership.id, membership.role,
            $10::uuid, array[$10::uuid],
            pg_catalog.clock_timestamp(),
            pg_catalog.clock_timestamp() + interval '10 minutes',
            pg_catalog.clock_timestamp() + interval '89 days'
       from emdo.household_memberships as membership
      where membership.household_id = $5::uuid
        and membership.user_id = $11::uuid`,
    [
      ids.spaceAccessA,
      ids.sessionA,
      ids.requestA,
      ids.spaceA,
      ids.household,
      ids.userA,
      ids.spaceAccessB,
      ids.sessionB,
      ids.requestB,
      ids.spaceB,
      ids.userB,
    ],
  );
  await client.query(
    `insert into emdo.space_access_grants
       (grant_id, household_id, original_owner_user_id, session_id,
        request_id, membership_id, role, private_space_id,
        writable_space_ids, issued_at, expires_at, retain_until)
     select $1::uuid, membership.household_id, membership.user_id,
            $2::uuid, $3::uuid, membership.id, membership.role,
            $4::uuid, array[$4::uuid], pg_catalog.clock_timestamp(),
            pg_catalog.clock_timestamp() + interval '10 minutes',
            pg_catalog.clock_timestamp() + interval '89 days'
       from emdo.household_memberships as membership
      where membership.id = $5::uuid
     union all
     select $6::uuid, membership.household_id, membership.user_id,
            $7::uuid, $8::uuid, membership.id, membership.role,
            $4::uuid, array[$4::uuid], pg_catalog.clock_timestamp(),
            pg_catalog.clock_timestamp() + interval '10 minutes',
            pg_catalog.clock_timestamp() + interval '89 days'
       from emdo.household_memberships as membership
      where membership.id = $5::uuid`,
    [
      ids.spaceAccessARotated,
      ids.sessionA,
      ids.requestARotated,
      ids.spaceA,
      ids.membershipA,
      ids.spaceAccessANewSession,
      ids.sessionANew,
      ids.requestANewSession,
    ],
  );
  await client.query(
    `insert into emdo.google_oauth_authorization_epochs
       (household_id, private_space_id, original_owner_user_id,
        authorization_epoch, created_at, updated_at)
     values ($1, $2, $3, 0, pg_catalog.clock_timestamp(),
             pg_catalog.clock_timestamp()),
            ($1, $4, $5, 0, pg_catalog.clock_timestamp(),
             pg_catalog.clock_timestamp())`,
    [ids.household, ids.spaceA, ids.userA, ids.spaceB, ids.userB],
  );
  await client.query(
    `insert into emdo.encrypted_google_calendar_grants
       (record_id, household_id, private_space_id, original_owner_user_id,
        provider, grant_type, revision, authorization_epoch,
        provider_grant_reference, encrypted_payload, created_at, updated_at)
     values ($1, $3, $4, $5, 'google', 'calendar-authorization', 1, 0,
             $6, '{"ciphertext":"workflow-a"}'::jsonb,
             pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()),
            ($2, $3, $7, $8, 'google', 'calendar-authorization', 1, 0,
             $9, '{"ciphertext":"workflow-b"}'::jsonb,
             pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp())`,
    [
      `google-calendar-oauth-v1-${'a'.repeat(64)}`,
      `google-calendar-oauth-v1-${'b'.repeat(64)}`,
      ids.household,
      ids.spaceA,
      ids.userA,
      providerGrantReferenceA,
      ids.spaceB,
      ids.userB,
      providerGrantReferenceB,
    ],
  );
  await client.query(
    `insert into emdo.disclosure_grants
       (id, version, household_id, space_id, user_id, run_id, agent_id,
        purpose, provider, record_allowlist, grant_hash, created_at, expires_at)
     values ($1, 1, $3, $4, $5, $6, 'scheduler.agent',
             'Schedule approved event', 'google-calendar', '{}'::jsonb,
             $11, pg_catalog.clock_timestamp(),
             pg_catalog.clock_timestamp() + interval '1 hour'),
            ($2, 1, $3, $7, $8, $9, 'scheduler.agent',
             'Schedule private event', 'google-calendar', '{}'::jsonb,
             $10, pg_catalog.clock_timestamp(),
             pg_catalog.clock_timestamp() + interval '1 hour')`,
    [
      ids.disclosureA,
      ids.disclosureB,
      ids.household,
      ids.spaceA,
      ids.userA,
      ids.runA,
      ids.spaceB,
      ids.userB,
      ids.runB,
      'a'.repeat(64),
      '4'.repeat(64),
    ],
  );
  await client.query(
    `insert into emdo.action_proposals
       (id, household_id, space_id, original_owner_user_id, run_id,
        disclosure_grant_id, authorization_scope_fingerprint,
        provider_authority_binding_hash,
        provider_sdk_call_id, disclosure_grant,
        capability_id, capability_fingerprint,
        canonical_arguments, targets, before_preview, after_preview,
        approval_display, provider_preconditions, payload_hash, approval_hash,
        idempotency_key,
        created_at, expires_at)
     values ($1, $3, $4, $5, $6, $7, $22, $18, $19,
             pg_catalog.jsonb_build_object(
               'id', $7::uuid, 'runId', $6::uuid,
               'householdId', $3::uuid, 'userId', $5::uuid
             ),
             'scheduler.calendar.write', $11,
             '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb,
             '{"schemaVersion":1,"title":"Review calendar action","summary":"Review the approved calendar action.","beforeSummary":"","afterSummary":"","fields":[]}'::jsonb,
             '{}'::jsonb, $12, $13, 'workflow-proposal-a-0001',
             pg_catalog.clock_timestamp(),
             pg_catalog.clock_timestamp() + interval '9 minutes'),
            ($2, $3, $8, $9, $10, $14, $23, $20, $21,
             pg_catalog.jsonb_build_object(
               'id', $14::uuid, 'runId', $10::uuid,
               'householdId', $3::uuid, 'userId', $9::uuid
             ),
             'scheduler.calendar.write', $15,
             '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb,
             '{"schemaVersion":1,"title":"Review calendar action","summary":"Review the approved calendar action.","beforeSummary":"","afterSummary":"","fields":[]}'::jsonb,
             '{}'::jsonb, $16, $17, 'workflow-proposal-b-0001',
             pg_catalog.clock_timestamp(),
             pg_catalog.clock_timestamp() + interval '9 minutes')`,
    [
      ids.proposalA,
      ids.proposalB,
      ids.household,
      ids.spaceA,
      ids.userA,
      ids.runA,
      ids.disclosureA,
      ids.spaceB,
      ids.userB,
      ids.runB,
      '1'.repeat(64),
      '2'.repeat(64),
      '3'.repeat(64),
      ids.disclosureB,
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
      providerAuthorityHashA,
      providerSdkCallId,
      providerAuthorityHashB,
      'sdk-call-workflow-calendar-create-2',
      authorizationScopeFingerprintA,
      authorizationScopeFingerprintB,
    ],
  );
  await client.query(
    `insert into emdo.action_proposals
       (id, schema_version, household_id, space_id, original_owner_user_id,
        run_id, disclosure_grant_id, authorization_scope_fingerprint,
        provider_authority_binding_hash, provider_sdk_call_id,
        disclosure_grant, capability_id, capability_fingerprint,
        canonical_arguments, targets, before_preview, after_preview,
        approval_display, provider_preconditions, payload_hash, approval_hash,
        idempotency_key,
        created_at, expires_at)
     select $2::uuid, proposal.schema_version, proposal.household_id,
            proposal.space_id, proposal.original_owner_user_id,
            proposal.run_id, proposal.disclosure_grant_id,
            proposal.authorization_scope_fingerprint,
            proposal.provider_authority_binding_hash, $3::text,
            proposal.disclosure_grant, proposal.capability_id,
            proposal.capability_fingerprint, proposal.canonical_arguments,
            proposal.targets, proposal.before_preview, proposal.after_preview,
            proposal.approval_display, proposal.provider_preconditions,
            proposal.payload_hash,
            proposal.approval_hash, $4::text, proposal.created_at,
            proposal.expires_at
       from emdo.action_proposals as proposal
      where proposal.id = $1::uuid
     union all
     select $5::uuid, proposal.schema_version, proposal.household_id,
            proposal.space_id, proposal.original_owner_user_id,
            proposal.run_id, proposal.disclosure_grant_id,
            proposal.authorization_scope_fingerprint,
            proposal.provider_authority_binding_hash, $6::text,
            proposal.disclosure_grant, proposal.capability_id,
            proposal.capability_fingerprint, proposal.canonical_arguments,
            proposal.targets, proposal.before_preview, proposal.after_preview,
            proposal.approval_display, proposal.provider_preconditions,
            proposal.payload_hash,
            proposal.approval_hash, $7::text, proposal.created_at,
            proposal.expires_at
       from emdo.action_proposals as proposal
      where proposal.id = $1::uuid`,
    [
      ids.proposalA,
      ids.proposalVisual,
      visualDecisionSdkCallId,
      'workflow-proposal-visual-0001',
      ids.proposalPrepare,
      providerPrepareSdkCallId,
      'workflow-proposal-prepare-0001',
    ],
  );
  await client.query(
    `insert into emdo.proposal_preparations
       (proposal_id, household_id, space_id, original_owner_user_id,
        preparation_binding, preparation_binding_hash)
     values ($1, $3, $4, $5,
             pg_catalog.jsonb_build_object(
               'proposalId', $1::uuid, 'originRequestId', $6::uuid,
               'originSessionId', $22::uuid,
               'runId', $7::uuid, 'householdId', $3::uuid,
               'userId', $5::uuid, 'agentId', 'scheduler.agent',
               'originSpaceAccessGrantId', $8::uuid,
               'disclosureGrantId', $9::uuid,
               'capabilityId', 'scheduler.calendar.write',
               'sdkCallId', $10::text,
               'providerAuthorityBindingHash', $11::text
             ), $12),
            ($2, $3, $13, $14,
             pg_catalog.jsonb_build_object(
               'proposalId', $2::uuid, 'originRequestId', $15::uuid,
               'originSessionId', $23::uuid,
               'runId', $16::uuid, 'householdId', $3::uuid,
               'userId', $14::uuid, 'agentId', 'scheduler.agent',
               'originSpaceAccessGrantId', $17::uuid,
               'disclosureGrantId', $18::uuid,
               'capabilityId', 'scheduler.calendar.write',
               'sdkCallId', $19::text,
               'providerAuthorityBindingHash', $20::text
             ), $21)`,
    [
      ids.proposalA,
      ids.proposalB,
      ids.household,
      ids.spaceA,
      ids.userA,
      ids.requestA,
      ids.runA,
      ids.spaceAccessA,
      ids.disclosureA,
      providerSdkCallId,
      providerAuthorityHashA,
      preparationBindingHash,
      ids.spaceB,
      ids.userB,
      ids.requestB,
      ids.runB,
      ids.spaceAccessB,
      ids.disclosureB,
      'sdk-call-workflow-calendar-create-2',
      providerAuthorityHashB,
      '9'.repeat(64),
      ids.sessionA,
      ids.sessionB,
    ],
  );
  await client.query(
    `insert into emdo.proposal_preparations
       (proposal_id, household_id, space_id, original_owner_user_id,
        preparation_binding, preparation_binding_hash)
     select $2::uuid, preparation.household_id, preparation.space_id,
            preparation.original_owner_user_id,
            pg_catalog.jsonb_set(
              pg_catalog.jsonb_set(
                preparation.preparation_binding,
                '{proposalId}', pg_catalog.to_jsonb($2::text)
              ),
              '{sdkCallId}', pg_catalog.to_jsonb($3::text)
            ),
            preparation.preparation_binding_hash
       from emdo.proposal_preparations as preparation
      where preparation.proposal_id = $1::uuid
     union all
     select $4::uuid, preparation.household_id, preparation.space_id,
            preparation.original_owner_user_id,
            pg_catalog.jsonb_set(
              pg_catalog.jsonb_set(
                preparation.preparation_binding,
                '{proposalId}', pg_catalog.to_jsonb($4::text)
              ),
              '{sdkCallId}', pg_catalog.to_jsonb($5::text)
            ),
            preparation.preparation_binding_hash
       from emdo.proposal_preparations as preparation
      where preparation.proposal_id = $1::uuid`,
    [
      ids.proposalA,
      ids.proposalVisual,
      visualDecisionSdkCallId,
      ids.proposalPrepare,
      providerPrepareSdkCallId,
    ],
  );
  await client.query(
    `insert into emdo.proposal_states
       (proposal_id, household_id, space_id, original_owner_user_id, state)
     values ($1, $3, $4, $5, 'prepared'),
            ($2, $3, $6, $7, 'prepared'),
            ($8, $3, $4, $5, 'pending'),
            ($9, $3, $4, $5, 'approved')`,
    [
      ids.proposalA,
      ids.proposalB,
      ids.household,
      ids.spaceA,
      ids.userA,
      ids.spaceB,
      ids.userB,
      ids.proposalVisual,
      ids.proposalPrepare,
    ],
  );
  await client.query(
    `insert into emdo.action_decisions
       (id, proposal_id, household_id, space_id, original_owner_user_id,
        authenticated_session_id, payload_hash, approval_hash, decision,
        channel, decided_at, idempotency_key)
     values ($1, $3, $5, $6, $7, $8, $12, $13, 'approved',
             'authenticated-visual', pg_catalog.clock_timestamp(),
             'workflow-decision-a-0001'),
            ($2, $4, $5, $9, $10, $11, $14, $15, 'approved',
             'authenticated-visual', pg_catalog.clock_timestamp(),
             'workflow-decision-b-0001')`,
    [
      ids.decisionA,
      ids.decisionB,
      ids.proposalA,
      ids.proposalB,
      ids.household,
      ids.spaceA,
      ids.userA,
      ids.sessionA,
      ids.spaceB,
      ids.userB,
      ids.sessionB,
      '2'.repeat(64),
      '3'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
    ],
  );
  await client.query(
    `insert into emdo.action_decisions
       (id, proposal_id, household_id, space_id, original_owner_user_id,
        authenticated_session_id, payload_hash, approval_hash, decision,
        channel, decided_at, idempotency_key)
     select $2::uuid, $3::uuid, decision.household_id, decision.space_id,
            decision.original_owner_user_id,
            decision.authenticated_session_id, decision.payload_hash,
            decision.approval_hash, decision.decision, decision.channel,
            decision.decided_at, 'workflow-decision-prepare-0001'
       from emdo.action_decisions as decision
      where decision.id = $1::uuid`,
    [ids.decisionA, ids.decisionPrepare, ids.proposalPrepare],
  );
  await client.query(
    `insert into emdo.provider_attempts
       (id, proposal_id, decision_id, household_id, space_id,
        original_owner_user_id, attempt_version, attempt_state, binding_hash,
        capability_fingerprint, approval_hash, disclosure_grant_id,
        disclosure_grant_hash, provider_id, provider_idempotency_key,
        idempotency_expires_at, target_set_hash, targets,
        provider_preconditions, "authorization", approval_binding,
        provider_authority_binding_hash, provider_sdk_call_id,
        issued_at, expires_at)
     values ($1, $3, $5, $7, $8, $9, 1, 'prepared', $12, $13, $14, $15,
             $16, 'google-calendar', $17,
             pg_catalog.clock_timestamp() + interval '1 day', $18,
             '[]'::jsonb, '{}'::jsonb,
             pg_catalog.jsonb_build_object(
               'proposalId', $3::uuid, 'attemptId', $1::uuid,
               'attemptVersion', 1, 'approvalBindingHash', $12::text,
               'capabilityFingerprint', $13::text,
               'approvalHash', $14::text, 'disclosureGrantId', $15::uuid,
               'disclosureGrantHash', $16::text,
               'providerIdempotencyKey', $17::text,
               'approvalBinding', pg_catalog.jsonb_build_object(
                 'decisionId', $5::uuid
               )
             ),
             pg_catalog.jsonb_build_object('decisionId', $5::uuid),
             $26, $27, pg_catalog.clock_timestamp(),
             pg_catalog.clock_timestamp() + interval '8 minutes'),
            ($2, $4, $6, $7, $10, $11, 1, 'prepared', $19, $20, $21, $22,
             $23, 'google-calendar', $24,
             pg_catalog.clock_timestamp() + interval '1 day', $25,
             '[]'::jsonb, '{}'::jsonb,
             pg_catalog.jsonb_build_object(
               'proposalId', $4::uuid, 'attemptId', $2::uuid,
               'attemptVersion', 1, 'approvalBindingHash', $19::text,
               'capabilityFingerprint', $20::text,
               'approvalHash', $21::text, 'disclosureGrantId', $22::uuid,
               'disclosureGrantHash', $23::text,
               'providerIdempotencyKey', $24::text,
               'approvalBinding', pg_catalog.jsonb_build_object(
                 'decisionId', $6::uuid
               )
             ),
             pg_catalog.jsonb_build_object('decisionId', $6::uuid),
             $28, $29, pg_catalog.clock_timestamp(),
             pg_catalog.clock_timestamp() + interval '8 minutes')`,
    [
      ids.providerAttemptA,
      ids.providerAttemptB,
      ids.proposalA,
      ids.proposalB,
      ids.decisionA,
      ids.decisionB,
      ids.household,
      ids.spaceA,
      ids.userA,
      ids.spaceB,
      ids.userB,
      bindingHash,
      '1'.repeat(64),
      '3'.repeat(64),
      ids.disclosureA,
      '4'.repeat(64),
      '6'.repeat(64),
      '7'.repeat(64),
      'a'.repeat(64),
      'b'.repeat(64),
      'd'.repeat(64),
      ids.disclosureB,
      'a'.repeat(64),
      'c'.repeat(64),
      'e'.repeat(64),
      providerAuthorityHashA,
      providerSdkCallId,
      providerAuthorityHashB,
      'sdk-call-workflow-calendar-create-2',
    ],
  );
  await client.query(
    `insert into emdo.audit_events
       (id, household_id, space_id, original_owner_user_id, actor_user_id,
        session_id, request_id, run_id, proposal_id, event_type, payload)
     values ($1, $3, $4, $5, $5, $6, $7, $8, $9,
             'workflow.test-a', '{}'::jsonb),
            ($2, $3, $10, $11, $11, $12, $13, $14, $15,
             'workflow.test-b', '{}'::jsonb)`,
    [
      ids.auditA,
      ids.auditB,
      ids.household,
      ids.spaceA,
      ids.userA,
      ids.sessionA,
      ids.requestA,
      ids.runA,
      ids.proposalA,
      ids.spaceB,
      ids.userB,
      ids.sessionB,
      ids.requestB,
      ids.runB,
      ids.proposalB,
    ],
  );
};

describeDatabase(
  'PostgreSQL 17 workflow authority (requires isolated TEST_DATABASE_URL)',
  () => {
    let client: import('pg').Client;

    beforeAll(async () => {
      const { Client } = await import('pg');
      client = new Client({ connectionString: databaseUrl });
      await client.connect();

      const version = await client.query<{ server_version_num: string }>(
        `select pg_catalog.current_setting('server_version_num') as server_version_num`,
      );
      expect(
        Number(version.rows[0]?.server_version_num),
      ).toBeGreaterThanOrEqual(170_000);
      expect(Number(version.rows[0]?.server_version_num)).toBeLessThan(180_000);

      const existingSchema = await client.query<{ emdo_schema: string | null }>(
        `select pg_catalog.to_regnamespace('emdo')::text as emdo_schema`,
      );
      expect(
        existingSchema.rows[0]?.emdo_schema,
        'TEST_DATABASE_URL must point at an isolated database without an emdo schema',
      ).toBeNull();

      await client.query(`do $role$
        begin
          if exists (
            select 1 from pg_catalog.pg_roles
             where rolname = 'emdo_workflow_login'
          ) then
            alter role emdo_workflow_login login nosuperuser nocreatedb
              nocreaterole noinherit nobypassrls noreplication;
          else
            create role emdo_workflow_login login nosuperuser nocreatedb
              nocreaterole noinherit nobypassrls noreplication;
          end if;
        end
      $role$`);

      const workflowMigrations = (await loadOrderedMigrations()).filter(
        ({ index }) => index <= 3,
      );
      expect(workflowMigrations.at(-1)?.id).toBe(
        '0003_durable_runtime_repositories',
      );
      for (const migration of workflowMigrations) {
        try {
          await client.query(migration.sql);
        } catch (error) {
          throw new Error(`Migration ${migration.id} failed`, { cause: error });
        }
        if (migration.id === '0000_household_foundation') {
          await client.query('grant emdo_workflow to emdo_workflow_login');
        }
      }
      await seedAuthorityFixtures(client);
    }, 30_000);

    afterAll(async () => {
      if (client !== undefined) {
        await client.query('rollback').catch(() => undefined);
        await client.query('reset role').catch(() => undefined);
        await client
          .query('drop schema if exists emdo cascade')
          .catch(() => undefined);
        await client
          .query(
            `do $cleanup$
            begin
              if exists (
                select 1 from pg_catalog.pg_roles
                 where rolname = 'emdo_workflow_login'
              ) and exists (
                select 1 from pg_catalog.pg_roles
                 where rolname = 'emdo_workflow'
              ) then
                revoke emdo_workflow from emdo_workflow_login;
              end if;
            end
          $cleanup$`,
          )
          .catch(() => undefined);
        await client.end();
      }
    });

    afterEach(async () => {
      if (client !== undefined) {
        await client.query('rollback').catch(() => undefined);
        await client.query('reset role').catch(() => undefined);
      }
    });

    it('rehardens the login and keeps the raw claim primitive private', async () => {
      const result = await client.query<{
        can_create_schema_objects: boolean;
        can_execute_claim: boolean;
        can_execute_issuer: boolean;
        can_execute_space_policy: boolean;
        can_use_schema: boolean;
        executor_can_execute_claim: boolean;
        executor_membership: boolean;
        legacy_membership: boolean;
        owns_claim: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
        rolreplication: boolean;
        rolsuper: boolean;
        table_access: boolean;
      }>(`select
        login.rolcanlogin,
        login.rolsuper,
        login.rolcreatedb,
        login.rolcreaterole,
        login.rolinherit,
        login.rolbypassrls,
        login.rolreplication,
        pg_catalog.pg_has_role(
          'emdo_workflow_login', 'emdo_workflow', 'MEMBER'
        ) as legacy_membership,
        pg_catalog.pg_has_role(
          'emdo_workflow_login', 'emdo_workflow_executor', 'MEMBER'
        ) as executor_membership,
        pg_catalog.has_schema_privilege(
          'emdo_workflow_login', 'emdo', 'USAGE'
        ) as can_use_schema,
        pg_catalog.has_schema_privilege(
          'emdo_workflow_login', 'emdo', 'CREATE'
        ) as can_create_schema_objects,
        pg_catalog.has_function_privilege(
          'emdo_workflow_login',
          'emdo.claim_workflow_operation_scope(text)', 'EXECUTE'
        ) as can_execute_claim,
        pg_catalog.has_function_privilege(
          'emdo_workflow_login',
          'emdo.issue_workflow_operation_claim(text,jsonb,uuid,uuid,text,text,text,jsonb)',
          'EXECUTE'
        ) as can_execute_issuer,
        pg_catalog.has_function_privilege(
          'emdo_workflow_executor',
          'emdo.claim_workflow_operation_scope(text)', 'EXECUTE'
        ) as executor_can_execute_claim,
        pg_catalog.has_function_privilege(
          'emdo_workflow_login', 'emdo.can_access_space(uuid,uuid)', 'EXECUTE'
        ) as can_execute_space_policy,
        (
          pg_catalog.has_table_privilege(
            'emdo_workflow_login', 'emdo.action_proposals', 'SELECT'
          ) or pg_catalog.has_table_privilege(
            'emdo_workflow_login', 'emdo.action_proposals', 'UPDATE'
          ) or pg_catalog.has_table_privilege(
            'emdo_workflow_login', 'emdo.provider_attempts', 'SELECT'
          ) or pg_catalog.has_table_privilege(
            'emdo_workflow_login', 'emdo.provider_attempts', 'UPDATE'
          ) or pg_catalog.has_table_privilege(
            'emdo_workflow_login', 'emdo.audit_events', 'SELECT'
          ) or pg_catalog.has_table_privilege(
            'emdo_workflow_login', 'emdo.audit_events', 'INSERT'
          )
        ) as table_access,
        pg_catalog.pg_get_userbyid(routine.proowner)
          = 'emdo_workflow_executor' as owns_claim
      from pg_catalog.pg_roles as login
      cross join pg_catalog.pg_proc as routine
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = routine.pronamespace
      where login.rolname = 'emdo_workflow_login'
        and namespace.nspname = 'emdo'
        and routine.oid = pg_catalog.to_regprocedure(
          'emdo.claim_workflow_operation_scope(text)'
        )`);

      expect(result.rows).toEqual([
        {
          can_create_schema_objects: false,
          can_execute_claim: false,
          can_execute_issuer: false,
          can_execute_space_policy: false,
          can_use_schema: true,
          executor_can_execute_claim: true,
          executor_membership: false,
          legacy_membership: false,
          owns_claim: true,
          rolbypassrls: false,
          rolcanlogin: true,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolreplication: false,
          rolsuper: false,
          table_access: false,
        },
      ]);
      const legacy = await client.query<{
        can_execute_claim: boolean;
        table_access: boolean;
      }>(`select
        pg_catalog.has_function_privilege(
          'emdo_workflow', 'emdo.claim_workflow_operation_scope(text)',
          'EXECUTE'
        ) as can_execute_claim,
        (
          pg_catalog.has_table_privilege(
            'emdo_workflow', 'emdo.action_proposals', 'SELECT'
          ) or pg_catalog.has_table_privilege(
            'emdo_workflow', 'emdo.provider_attempts', 'UPDATE'
          ) or pg_catalog.has_table_privilege(
            'emdo_workflow', 'emdo.audit_events', 'INSERT'
          )
        ) as table_access`);
      expect(legacy.rows[0]).toEqual({
        can_execute_claim: false,
        table_access: false,
      });
    });

    it('keeps raw claim insertion and both private primitives unavailable to workflow principals', async () => {
      await client.query('begin');
      await client.query('set local role emdo_app');
      await expect(
        client.query(
          `insert into emdo.workflow_operation_claims (operation_id)
           values ($1)`,
          [testOperationId('I')],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback');

      const privileges = await client.query<{
        can_claim: boolean;
        can_issue: boolean;
      }>(`select
        pg_catalog.has_function_privilege(
          'emdo_workflow_login',
          'emdo.claim_workflow_operation_scope(text)', 'EXECUTE'
        ) as can_claim,
        pg_catalog.has_function_privilege(
          'emdo_workflow_login',
          'emdo.issue_workflow_operation_claim(text,jsonb,uuid,uuid,text,text,text,jsonb)',
          'EXECUTE'
        ) as can_issue`);
      expect(privileges.rows).toEqual([{ can_claim: false, can_issue: false }]);
    });

    it('does not let forged GUCs authorize reads or writes to another private aggregate', async () => {
      await client.query('begin');
      await client.query('set local role emdo_workflow_login');
      await client.query(
        `select pg_catalog.set_config('emdo.user_id', $1, true),
                pg_catalog.set_config('emdo.session_id', $2, true),
                pg_catalog.set_config('emdo.request_id', $3, true)`,
        [ids.userB, ids.sessionB, ids.requestB],
      );

      const deniedStatements = [
        {
          name: 'space_policy_denied',
          sql: 'select emdo.can_access_space($1::uuid, $2::uuid)',
          values: [ids.household, ids.spaceB],
        },
        {
          name: 'proposal_read_denied',
          sql: 'select id from emdo.action_proposals where id = $1::uuid',
          values: [ids.proposalB],
        },
        {
          name: 'attempt_read_denied',
          sql: 'select id from emdo.provider_attempts where id = $1::uuid',
          values: [ids.providerAttemptB],
        },
        {
          name: 'audit_read_denied',
          sql: 'select id from emdo.audit_events where id = $1::uuid',
          values: [ids.auditB],
        },
        {
          name: 'proposal_write_denied',
          sql: `update emdo.action_proposals
                   set after_preview = '{"forged":true}'::jsonb
                 where id = $1::uuid`,
          values: [ids.proposalB],
        },
        {
          name: 'attempt_write_denied',
          sql: `update emdo.provider_attempts
                   set attempt_state = 'executing',
                       dispatched_at = pg_catalog.clock_timestamp()
                 where id = $1::uuid`,
          values: [ids.providerAttemptB],
        },
        {
          name: 'audit_write_denied',
          sql: `update emdo.audit_events
                   set payload = '{"forged":true}'::jsonb
                 where id = $1::uuid`,
          values: [ids.auditB],
        },
      ] as const;

      for (const denied of deniedStatements) {
        await client.query(`savepoint ${denied.name}`);
        await expect(
          client.query(denied.sql, [...denied.values]),
        ).rejects.toMatchObject({ code: '42501' });
        await client.query(`rollback to savepoint ${denied.name}`);
        await client.query(`release savepoint ${denied.name}`);
      }
      await client.query('rollback');
    });
  },
);

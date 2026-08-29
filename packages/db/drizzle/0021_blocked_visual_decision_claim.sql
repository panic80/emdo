CREATE OR REPLACE FUNCTION "emdo"."issue_workflow_operation_claim_calendar"(
	p_operation_id text,
	p_scope jsonb,
	p_decision_id uuid,
	p_provider_attempt_id uuid,
	p_binding_hash text,
	p_create_preparation_binding_hash text,
	p_provider_authority_binding_hash text,
	p_mutation jsonb
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_user_id uuid := emdo.current_user_id();
	v_session_id uuid := emdo.current_session_id();
	v_current_request_id uuid := emdo.current_request_id();
	v_origin_request_id uuid;
	v_origin_space_access_grant_id uuid;
	v_origin_session_id uuid;
	v_phase text;
	v_request_id uuid;
	v_household_id uuid;
	v_run_id uuid;
	v_scope_user_id uuid;
	v_scope_session_id uuid;
	v_space_access_grant_id uuid;
	v_disclosure_grant_id uuid;
	v_disclosure_grant_version integer;
	v_disclosure_grant_hash text;
	v_proposal_id uuid;
	v_provider_sdk_call_id text;
	v_active_at timestamptz;
	v_require_active boolean;
	v_authenticated_session_id uuid;
	v_session_expires_at timestamptz;
	v_now timestamptz;
	v_expires_at timestamptz;
	v_scope_assertion jsonb;
	v_access emdo.space_access_grants%ROWTYPE;
	v_origin_access emdo.space_access_grants%ROWTYPE;
	v_run emdo.agent_runs%ROWTYPE;
	v_disclosure emdo.disclosure_grants%ROWTYPE;
	v_proposal emdo.action_proposals%ROWTYPE;
	v_state emdo.proposal_states%ROWTYPE;
	v_preparation emdo.proposal_preparations%ROWTYPE;
	v_decision emdo.action_decisions%ROWTYPE;
	v_attempt emdo.provider_attempts%ROWTYPE;
	v_existing emdo.workflow_operation_claims%ROWTYPE;
	v_locked RECORD;
	v_preparation_binding_hash text;
	v_expected_authorization_scope_fingerprint text;
	v_authorization_scope_fingerprint text;
	v_mutation_hash text;
	v_mutation_node_count bigint;
	v_mutation_max_depth integer;
	v_mutation_key_count bigint;
	v_scope_key_count bigint;
	v_has_existing_claim boolean := false;
BEGIN
	-- A failed issuance never leaves stale workflow authority in this transaction.
	PERFORM pg_catalog.set_config('emdo.workflow_operation_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_phase', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_household_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_space_id', '', true);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_original_owner_user_id', '', true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_run_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_proposal_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_decision_id', '', true);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_provider_attempt_id', '', true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_origin_request_id', '', true);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_origin_space_access_grant_id', '', true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_origin_session_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_current_request_id', '', true);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_current_space_access_grant_id', '', true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_current_session_id', '', true);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_authorization_scope_fingerprint', '', true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_binding_hash', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_mutation_hash', '', true);

	IF p_operation_id IS NULL
		OR pg_catalog.length(p_operation_id) NOT BETWEEN 32 AND 512
		OR p_operation_id !~ '^[A-Za-z0-9_-]+$'
		OR pg_catalog.jsonb_typeof(p_scope) <> 'object'
		OR pg_catalog.octet_length(p_scope::text) > 16384
		OR pg_catalog.jsonb_typeof(p_mutation) <> 'object'
		OR pg_catalog.octet_length(p_mutation::text) > 524288
		OR pg_catalog.jsonb_typeof(p_scope -> 'phase') <> 'string'
	THEN
		RETURN false;
	END IF;
	v_phase := p_scope ->> 'phase';
	IF v_phase NOT IN (
		'proposal-create', 'visual-decision',
		'provider-write-prepare', 'provider-write-dispatch'
	) THEN
		RETURN false;
	END IF;

	WITH RECURSIVE mutation_nodes(node, depth) AS (
		SELECT p_mutation, 0
		UNION ALL
		SELECT child.node, parent.depth + 1
		FROM mutation_nodes AS parent
		CROSS JOIN LATERAL (
			SELECT entry.value AS node
			FROM pg_catalog.jsonb_each(
				CASE WHEN pg_catalog.jsonb_typeof(parent.node) = 'object'
					THEN parent.node ELSE '{}'::jsonb END
			) AS entry
			UNION ALL
			SELECT entry.value AS node
			FROM pg_catalog.jsonb_array_elements(
				CASE WHEN pg_catalog.jsonb_typeof(parent.node) = 'array'
					THEN parent.node ELSE '[]'::jsonb END
			) AS entry(value)
		) AS child
		WHERE parent.depth < 13
	)
	SELECT pg_catalog.count(*), pg_catalog.max(depth)
	INTO v_mutation_node_count, v_mutation_max_depth
	FROM mutation_nodes;
	SELECT pg_catalog.count(*) INTO v_mutation_key_count
	FROM pg_catalog.jsonb_object_keys(p_mutation);
	IF v_mutation_node_count > 8192 OR v_mutation_max_depth > 12
		OR pg_catalog.jsonb_typeof(p_mutation -> 'scope') <> 'object'
		OR p_mutation -> 'scope' IS DISTINCT FROM p_scope
		OR (
			v_phase = 'proposal-create'
			AND (
				NOT (p_mutation ?& ARRAY[
					'proposal', 'preparation', 'scope', 'event'
				])
				OR v_mutation_key_count <> 4
				OR pg_catalog.jsonb_typeof(p_mutation -> 'proposal') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'preparation') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'event') <> 'object'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{proposal,id}'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{proposal,runId}'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{proposal,providerSdkCallId}'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{proposal,providerAuthorityBindingHash}'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{preparation,bindingHash}'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{preparation,binding}'
				) <> 'object'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{preparation,binding,disclosurePolicyVersion}'
				) <> 'string'
				OR p_mutation #>> '{proposal,id}'
					IS DISTINCT FROM p_scope ->> 'proposalId'
				OR p_mutation #>> '{proposal,runId}'
					IS DISTINCT FROM p_scope ->> 'runId'
				OR p_mutation #>> '{proposal,providerSdkCallId}'
					IS DISTINCT FROM p_scope ->> 'providerSdkCallId'
				OR p_mutation #>> '{proposal,providerAuthorityBindingHash}'
					IS DISTINCT FROM p_provider_authority_binding_hash
				OR p_mutation #>> '{preparation,bindingHash}'
					IS DISTINCT FROM p_create_preparation_binding_hash
				OR p_mutation #>> '{preparation,binding,proposalId}'
					IS DISTINCT FROM p_scope ->> 'proposalId'
				OR p_mutation #>> '{preparation,binding,originRequestId}'
					IS DISTINCT FROM p_scope ->> 'currentRequestId'
				OR p_mutation #>> '{preparation,binding,originSpaceAccessGrantId}'
					IS DISTINCT FROM p_scope ->> 'currentSpaceAccessGrantId'
				OR p_mutation #>> '{preparation,binding,originSessionId}'
					IS DISTINCT FROM p_scope ->> 'currentSessionId'
				OR p_mutation #>>
					'{preparation,binding,disclosurePolicyVersion}'
					!~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
			)
		)
		OR (
			v_phase = 'visual-decision'
			AND (
				NOT (p_mutation ?& ARRAY[
					'expected', 'next', 'decision', 'scope', 'event',
					'visualDecisionProofHash'
				])
				OR v_mutation_key_count <> 6
				OR pg_catalog.jsonb_typeof(p_mutation -> 'expected') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'next') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'decision') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'event') <> 'object'
				OR pg_catalog.jsonb_typeof(
					p_mutation -> 'visualDecisionProofHash'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{decision,id}'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{decision,authenticatedSessionId}'
				) <> 'string'
				OR p_mutation ->> 'visualDecisionProofHash'
					!~ '^[a-f0-9]{64}$'
				OR p_mutation #>> '{decision,id}'
					IS DISTINCT FROM p_decision_id::text
				OR p_mutation #>> '{decision,authenticatedSessionId}'
					IS DISTINCT FROM p_scope ->> 'currentSessionId'
			)
		)
		OR (
			v_phase = 'provider-write-prepare'
			AND (
				NOT (p_mutation ?& ARRAY[
					'expected', 'next', 'decisionId', 'bindingHash',
					'authorization', 'approvalBinding', 'scope', 'event'
				])
				OR v_mutation_key_count <> 8
				OR pg_catalog.jsonb_typeof(p_mutation -> 'expected') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'next') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'authorization') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'approvalBinding') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'event') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'decisionId') <> 'string'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'bindingHash') <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{authorization,attemptId}'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{authorization,approvalBindingHash}'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{authorization,approvalBinding}'
				) <> 'object'
				OR p_mutation ->> 'decisionId' IS DISTINCT FROM p_decision_id::text
				OR p_mutation ->> 'bindingHash' IS DISTINCT FROM p_binding_hash
				OR p_mutation #>> '{authorization,attemptId}'
					IS DISTINCT FROM p_provider_attempt_id::text
				OR p_mutation #>> '{authorization,approvalBindingHash}'
					IS DISTINCT FROM p_binding_hash
				OR p_mutation -> 'authorization' -> 'approvalBinding'
					IS DISTINCT FROM p_mutation -> 'approvalBinding'
			)
		)
		OR (
			v_phase = 'provider-write-dispatch'
			AND (
				NOT (p_mutation ?& ARRAY[
					'expected', 'next', 'decisionId', 'bindingHash', 'attemptId',
					'dispatchedAt', 'scope', 'event'
				])
				OR v_mutation_key_count <> 8
				OR pg_catalog.jsonb_typeof(p_mutation -> 'expected') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'next') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'event') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'decisionId') <> 'string'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'bindingHash') <> 'string'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'attemptId') <> 'string'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'dispatchedAt') <> 'string'
				OR p_mutation ->> 'decisionId' IS DISTINCT FROM p_decision_id::text
				OR p_mutation ->> 'bindingHash' IS DISTINCT FROM p_binding_hash
				OR p_mutation ->> 'attemptId'
					IS DISTINCT FROM p_provider_attempt_id::text
				OR p_mutation ->> 'dispatchedAt' !~
					'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
			)
		)
	THEN
		RETURN false;
	END IF;
	v_mutation_hash := pg_catalog.encode(
		pg_catalog.sha256(
			pg_catalog.convert_to('emdo.workflow-mutation.v1', 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(v_phase, 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_mutation::text, 'UTF8')
		),
		'hex'
	);

	SELECT pg_catalog.count(*) INTO v_scope_key_count
	FROM pg_catalog.jsonb_object_keys(p_scope);
	IF NOT (p_scope ?& ARRAY[
		'phase', 'currentRequestId', 'currentSessionId', 'runId',
		'householdId', 'userId', 'currentSpaceAccessGrantId',
		'authorizationScopeFingerprint', 'disclosureGrantId',
		'disclosureGrantVersion', 'disclosureGrantHash', 'proposalId',
		'providerSdkCallId', 'activeAt', 'requireActiveDisclosureGrant'
	]) OR v_scope_key_count <> 15
		OR pg_catalog.jsonb_typeof(p_scope -> 'currentRequestId') <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'currentSessionId') <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'runId') <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'householdId') <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'userId') <> 'string'
		OR pg_catalog.jsonb_typeof(
			p_scope -> 'currentSpaceAccessGrantId'
		) <> 'string'
		OR pg_catalog.jsonb_typeof(
			p_scope -> 'authorizationScopeFingerprint'
		) <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'disclosureGrantId') <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'disclosureGrantVersion') <> 'number'
		OR pg_catalog.jsonb_typeof(p_scope -> 'disclosureGrantHash') <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'proposalId') <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'providerSdkCallId') <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'activeAt') <> 'string'
		OR pg_catalog.jsonb_typeof(
			p_scope -> 'requireActiveDisclosureGrant'
		) <> 'boolean'
	THEN
		RETURN false;
	END IF;

	BEGIN
		v_request_id := (p_scope ->> 'currentRequestId')::uuid;
		v_scope_session_id := (p_scope ->> 'currentSessionId')::uuid;
		v_run_id := (p_scope ->> 'runId')::uuid;
		v_household_id := (p_scope ->> 'householdId')::uuid;
		v_scope_user_id := (p_scope ->> 'userId')::uuid;
		v_space_access_grant_id :=
			(p_scope ->> 'currentSpaceAccessGrantId')::uuid;
		v_expected_authorization_scope_fingerprint :=
			p_scope ->> 'authorizationScopeFingerprint';
		v_disclosure_grant_id := (p_scope ->> 'disclosureGrantId')::uuid;
		v_disclosure_grant_version :=
			(p_scope ->> 'disclosureGrantVersion')::integer;
		v_disclosure_grant_hash := p_scope ->> 'disclosureGrantHash';
		v_proposal_id := (p_scope ->> 'proposalId')::uuid;
		v_provider_sdk_call_id := p_scope ->> 'providerSdkCallId';
		v_active_at := (p_scope ->> 'activeAt')::timestamptz;
		v_require_active :=
			(p_scope ->> 'requireActiveDisclosureGrant')::boolean;
		IF v_phase <> 'proposal-create' THEN
			v_authenticated_session_id := v_scope_session_id;
		END IF;
	EXCEPTION
		WHEN invalid_text_representation OR invalid_datetime_format
			OR datetime_field_overflow OR numeric_value_out_of_range
		THEN
			RETURN false;
	END;

	IF p_scope ->> 'currentRequestId' <> v_request_id::text
		OR p_scope ->> 'currentSessionId' <> v_scope_session_id::text
		OR p_scope ->> 'runId' <> v_run_id::text
		OR p_scope ->> 'householdId' <> v_household_id::text
		OR p_scope ->> 'userId' <> v_scope_user_id::text
		OR p_scope ->> 'currentSpaceAccessGrantId'
			<> v_space_access_grant_id::text
		OR p_scope ->> 'disclosureGrantId' <> v_disclosure_grant_id::text
		OR p_scope ->> 'proposalId' <> v_proposal_id::text
		OR v_disclosure_grant_version <= 0
		OR v_disclosure_grant_hash !~ '^[a-f0-9]{64}$'
		OR v_expected_authorization_scope_fingerprint !~ '^[a-f0-9]{64}$'
		OR p_provider_authority_binding_hash !~ '^[a-f0-9]{64}$'
		OR pg_catalog.length(v_provider_sdk_call_id) NOT BETWEEN 1 AND 512
		OR pg_catalog.btrim(v_provider_sdk_call_id) <> v_provider_sdk_call_id
		OR v_provider_sdk_call_id ~ '[[:cntrl:]]'
		OR p_scope ->> 'activeAt' !~
			'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
		OR v_user_id IS NULL OR v_session_id IS NULL
		OR v_current_request_id IS NULL
		OR v_scope_user_id IS DISTINCT FROM v_user_id
		OR v_request_id IS DISTINCT FROM v_current_request_id
		OR v_scope_session_id IS DISTINCT FROM v_session_id
	THEN
		RETURN false;
	END IF;

	IF (v_phase = 'proposal-create' AND (
			p_decision_id IS NOT NULL
			OR p_provider_attempt_id IS NOT NULL
			OR p_binding_hash IS NOT NULL
			OR p_create_preparation_binding_hash !~ '^[a-f0-9]{64}$'
			OR v_require_active IS DISTINCT FROM true
		)) OR (v_phase = 'visual-decision' AND (
			p_decision_id IS NULL
			OR p_provider_attempt_id IS NOT NULL
			OR p_binding_hash IS NOT NULL
			OR p_create_preparation_binding_hash IS NOT NULL
		)) OR (v_phase = 'provider-write-prepare' AND (
			p_decision_id IS NULL
			OR p_provider_attempt_id IS NULL
			OR p_binding_hash !~ '^[a-f0-9]{64}$'
			OR p_create_preparation_binding_hash IS NOT NULL
			OR v_require_active IS DISTINCT FROM true
		)) OR (v_phase = 'provider-write-dispatch' AND (
			p_decision_id IS NULL
			OR p_provider_attempt_id IS NULL
			OR p_binding_hash !~ '^[a-f0-9]{64}$'
			OR p_create_preparation_binding_hash IS NOT NULL
			OR v_require_active IS DISTINCT FROM true
		)) THEN
		RETURN false;
	END IF;
	IF v_phase = 'visual-decision'
		AND v_require_active IS DISTINCT FROM true
		AND p_mutation #>> '{decision,decision}' IS DISTINCT FROM 'rejected'
	THEN
		RETURN false;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(p_operation_id, 0)
	);
	IF NOT emdo.lock_active_request_scope(v_household_id, NULL, NULL) THEN
		RETURN false;
	END IF;

	SELECT access.* INTO v_access
	FROM emdo.space_access_grants AS access
	JOIN emdo.household_memberships AS membership
		ON membership.id = access.membership_id
		AND membership.household_id = access.household_id
		AND membership.user_id = access.original_owner_user_id
	WHERE access.grant_id = v_space_access_grant_id
		AND access.schema_version = 1
		AND access.version = 1
		AND access.household_id = v_household_id
		AND access.original_owner_user_id = v_user_id
		AND access.session_id = v_session_id
		AND access.request_id = v_request_id
		AND membership.status = 'active'
		AND membership.ended_at IS NULL
		AND membership.role = access.role
	FOR UPDATE OF access, membership;
	IF NOT FOUND THEN
		RETURN false;
	END IF;

	SELECT run.* INTO v_run
	FROM emdo.agent_runs AS run
	JOIN emdo.spaces AS space
		ON space.household_id = run.household_id
		AND space.id = run.space_id
		AND space.original_owner_user_id = run.original_owner_user_id
	WHERE run.id = v_run_id
		AND run.household_id = v_household_id
		AND run.original_owner_user_id = v_user_id
		AND run.space_id = ANY(v_access.writable_space_ids)
		AND (
			run.status IN ('queued', 'running')
			OR (
				v_phase = 'visual-decision'
				AND run.status = 'blocked'
				AND EXISTS (
					SELECT 1
					FROM emdo.approval_resume_jobs AS resume
					WHERE resume.run_id = v_run_id
						AND resume.proposal_id = v_proposal_id
						AND resume.household_id = v_household_id
						AND resume.space_id = run.space_id
						AND resume.user_id = v_user_id
						AND resume.user_id = run.original_owner_user_id
						AND resume.state = 'awaiting-decision'
						AND resume.decision_id IS NULL
						AND resume.decision_type IS NULL
						AND resume.claim_id IS NULL
						AND resume.ownership_token_digest IS NULL
						AND resume.terminal_event_sequence IS NULL
						AND resume.expires_at > pg_catalog.clock_timestamp()
				)
			)
			OR (
				v_phase IN ('provider-write-prepare', 'provider-write-dispatch')
				AND run.status = 'blocked'
				AND EXISTS (
					SELECT 1
					FROM emdo.approval_resume_jobs AS resume
					WHERE resume.run_id = v_run_id
						AND resume.proposal_id = v_proposal_id
						AND resume.household_id = v_household_id
						AND resume.space_id = run.space_id
						AND resume.user_id = v_user_id
						AND resume.user_id = run.original_owner_user_id
						AND resume.state = 'claimed'
						AND resume.decision_id = p_decision_id
						AND resume.decision_type = 'approved'
						AND resume.authenticated_session_id = v_session_id
						AND resume.resume_request_id = v_request_id
						AND resume.resume_space_access_grant_id =
							v_space_access_grant_id
						AND resume.authorization_scope_fingerprint =
							v_expected_authorization_scope_fingerprint
						AND resume.disclosure_grant_id = v_disclosure_grant_id
						AND resume.disclosure_grant_version =
							v_disclosure_grant_version
						AND resume.approval_event_sequence IS NOT NULL
						AND resume.claim_id IS NOT NULL
						AND resume.ownership_token_digest ~ '^[a-f0-9]{64}$'
						AND resume.collection_authorization_scope_fingerprint ~
							'^[a-f0-9]{64}$'
						AND resume.claimed_at IS NOT NULL
						AND resume.claim_expires_at > pg_catalog.clock_timestamp()
						AND resume.terminal_event_sequence IS NULL
						AND resume.terminal_reason_code IS NULL
						AND resume.terminal_result_hash IS NULL
						AND resume.expires_at > pg_catalog.clock_timestamp()
				)
			)
		)
		AND space.tombstoned_at IS NULL
	FOR UPDATE OF run, space;
	IF NOT FOUND
		OR NOT emdo.lock_active_request_scope(
			v_household_id, v_run.space_id, NULL
		)
	THEN
		RETURN false;
	END IF;

	SELECT disclosure.* INTO v_disclosure
	FROM emdo.disclosure_grants AS disclosure
	WHERE disclosure.id = v_disclosure_grant_id
		AND disclosure.schema_version = 1
		AND disclosure.version = v_disclosure_grant_version
		AND disclosure.grant_hash = v_disclosure_grant_hash
		AND disclosure.household_id = v_household_id
		AND disclosure.space_id = v_run.space_id
		AND disclosure.user_id = v_user_id
		AND disclosure.run_id = v_run_id
		AND disclosure.one_run_only = true
		AND (
			NOT v_require_active
			OR disclosure.revoked_at IS NULL
		)
	FOR UPDATE OF disclosure;
	IF NOT FOUND THEN
		RETURN false;
	END IF;

	-- Presence is used only to bypass new-operation absence/pre-state checks.
	-- Exact binding, current authority, and expiry are still proved below
	-- before an existing claim is accepted for aggregate replay validation.
	SELECT claim.* INTO v_existing
	FROM emdo.workflow_operation_claims AS claim
	WHERE claim.operation_id = p_operation_id
	FOR UPDATE OF claim;
	v_has_existing_claim := FOUND;

	IF v_phase = 'proposal-create' THEN
		PERFORM 1 FROM emdo.action_proposals AS proposal
		WHERE proposal.id = v_proposal_id
		FOR UPDATE OF proposal;
		IF FOUND AND NOT v_has_existing_claim THEN
			RETURN false;
		END IF;
		v_preparation_binding_hash := p_create_preparation_binding_hash;
		v_origin_request_id := v_request_id;
		v_origin_space_access_grant_id := v_space_access_grant_id;
		v_origin_session_id := v_session_id;
	ELSE
		SELECT ROW(proposal.*)::emdo.action_proposals AS proposal_row,
			ROW(state.*)::emdo.proposal_states AS state_row,
			ROW(preparation.*)::emdo.proposal_preparations AS preparation_row
		INTO v_locked
		FROM emdo.action_proposals AS proposal
		JOIN emdo.proposal_states AS state
			ON state.proposal_id = proposal.id
			AND state.household_id = proposal.household_id
			AND state.space_id = proposal.space_id
			AND state.original_owner_user_id = proposal.original_owner_user_id
		JOIN emdo.proposal_preparations AS preparation
			ON preparation.proposal_id = proposal.id
			AND preparation.household_id = proposal.household_id
			AND preparation.space_id = proposal.space_id
			AND preparation.original_owner_user_id =
				proposal.original_owner_user_id
		WHERE proposal.id = v_proposal_id
			AND proposal.household_id = v_household_id
			AND proposal.space_id = v_run.space_id
			AND proposal.original_owner_user_id = v_user_id
			AND proposal.run_id = v_run_id
			AND proposal.disclosure_grant_id = v_disclosure_grant_id
			AND proposal.provider_sdk_call_id = v_provider_sdk_call_id
			AND proposal.provider_authority_binding_hash =
				p_provider_authority_binding_hash
			AND proposal.authorization_scope_fingerprint ~ '^[a-f0-9]{64}$'
			AND preparation.abandonment_reason IS NULL
			AND preparation.abandoned_at IS NULL
		FOR UPDATE OF proposal, state, preparation;
		IF NOT FOUND THEN
			RETURN false;
		END IF;
		v_proposal := v_locked.proposal_row;
		v_state := v_locked.state_row;
		v_preparation := v_locked.preparation_row;
		IF v_preparation.preparation_binding ->> 'proposalId'
				IS DISTINCT FROM v_proposal_id::text
			OR v_preparation.preparation_binding ->> 'runId'
				IS DISTINCT FROM v_run_id::text
			OR v_preparation.preparation_binding ->> 'householdId'
				IS DISTINCT FROM v_household_id::text
			OR v_preparation.preparation_binding ->> 'userId'
				IS DISTINCT FROM v_user_id::text
			OR v_preparation.preparation_binding ->> 'disclosureGrantId'
				IS DISTINCT FROM v_disclosure_grant_id::text
			OR v_preparation.preparation_binding ->> 'sdkCallId'
				IS DISTINCT FROM v_provider_sdk_call_id
			OR v_preparation.preparation_binding ->> 'providerAuthorityBindingHash'
				IS DISTINCT FROM p_provider_authority_binding_hash
		THEN
			RETURN false;
		END IF;
		BEGIN
			v_origin_request_id :=
				(v_preparation.preparation_binding ->> 'originRequestId')::uuid;
			v_origin_space_access_grant_id :=
				(v_preparation.preparation_binding
					->> 'originSpaceAccessGrantId')::uuid;
			v_origin_session_id :=
				(v_preparation.preparation_binding ->> 'originSessionId')::uuid;
		EXCEPTION WHEN invalid_text_representation THEN
			RETURN false;
		END;
		v_preparation_binding_hash := v_preparation.preparation_binding_hash;
	END IF;

	-- The immutable preparation records origin lineage. Only the fresh current
	-- request grant is authority-bearing for this phase.
	SELECT origin.* INTO v_origin_access
	FROM emdo.space_access_grants AS origin
	WHERE origin.grant_id = v_origin_space_access_grant_id
		AND origin.schema_version = 1
		AND origin.version = 1
		AND origin.household_id = v_household_id
		AND origin.original_owner_user_id = v_user_id
		AND origin.request_id = v_origin_request_id
		AND origin.private_space_id = v_access.private_space_id
		AND v_run.space_id = ANY(origin.writable_space_ids)
	FOR SHARE OF origin;
	IF NOT FOUND THEN
		RETURN false;
	END IF;
	IF v_origin_access.session_id IS DISTINCT FROM v_origin_session_id THEN
		RETURN false;
	END IF;

	SELECT authority.authorization_scope_fingerprint
	INTO v_authorization_scope_fingerprint
	FROM emdo.lock_current_authorization_scope(
		v_space_access_grant_id,
		CASE WHEN v_phase = 'proposal-create' THEN NULL ELSE v_proposal_id END,
		CASE WHEN v_phase = 'proposal-create' THEN v_run_id ELSE NULL END
	) AS authority;
	IF NOT FOUND
		OR v_authorization_scope_fingerprint !~ '^[a-f0-9]{64}$'
		OR v_authorization_scope_fingerprint IS DISTINCT FROM
			v_expected_authorization_scope_fingerprint
		OR (
			v_phase <> 'proposal-create'
			AND v_proposal.authorization_scope_fingerprint
				IS DISTINCT FROM v_authorization_scope_fingerprint
		)
	THEN
		RETURN false;
	END IF;

	-- The OAuth verifier locks the current provider reference and epoch. Its v2
	-- binding contains the DB-derived stable scope fingerprint, never a grant ID.
	IF NOT emdo.lock_current_google_calendar_authority(
		v_household_id,
		v_access.private_space_id,
		v_user_id,
		v_authorization_scope_fingerprint,
		p_provider_authority_binding_hash
	) THEN
		RETURN false;
	END IF;

	IF v_phase = 'visual-decision' THEN
		IF NOT v_has_existing_claim THEN
			IF v_state.state <> 'pending' THEN
				RETURN false;
			END IF;
			PERFORM 1 FROM emdo.action_decisions AS decision
			WHERE decision.id = p_decision_id
			FOR UPDATE OF decision;
			IF FOUND THEN
				RETURN false;
			END IF;
		END IF;
	ELSIF v_phase IN ('provider-write-prepare', 'provider-write-dispatch') THEN
		SELECT decision.* INTO v_decision
		FROM emdo.action_decisions AS decision
		WHERE decision.id = p_decision_id
			AND decision.proposal_id = v_proposal_id
			AND decision.household_id = v_household_id
			AND decision.space_id = v_run.space_id
			AND decision.original_owner_user_id = v_user_id
			AND decision.decision = 'approved'
			AND decision.channel = 'authenticated-visual'
			AND decision.authenticated_session_id = v_session_id
		FOR UPDATE OF decision;
		IF NOT FOUND THEN
			RETURN false;
		END IF;
		IF v_phase = 'provider-write-prepare' THEN
			IF NOT v_has_existing_claim THEN
				IF v_state.state <> 'approved' THEN
					RETURN false;
				END IF;
				PERFORM 1 FROM emdo.provider_attempts AS attempt
				WHERE attempt.id = p_provider_attempt_id
				FOR UPDATE OF attempt;
				IF FOUND THEN
					RETURN false;
				END IF;
			END IF;
		ELSE
			IF NOT v_has_existing_claim AND v_state.state <> 'prepared' THEN
				RETURN false;
			END IF;
			SELECT attempt.* INTO v_attempt
			FROM emdo.provider_attempts AS attempt
			WHERE attempt.id = p_provider_attempt_id
				AND attempt.proposal_id = v_proposal_id
				AND attempt.decision_id = p_decision_id
				AND attempt.household_id = v_household_id
				AND attempt.space_id = v_run.space_id
				AND attempt.original_owner_user_id = v_user_id
				AND (
					v_has_existing_claim
					OR attempt.attempt_state = 'prepared'
				)
				AND attempt.binding_hash = p_binding_hash
				AND attempt.disclosure_grant_id = v_disclosure_grant_id
				AND attempt.disclosure_grant_hash = v_disclosure_grant_hash
				AND attempt.provider_authority_binding_hash =
					p_provider_authority_binding_hash
				AND attempt.provider_sdk_call_id = v_provider_sdk_call_id
			FOR UPDATE OF attempt;
			IF NOT FOUND THEN
				RETURN false;
			END IF;
		END IF;
	END IF;

	SELECT session.expires_at INTO v_session_expires_at
	FROM emdo.auth_sessions AS session
	JOIN emdo.auth_users AS account_user ON account_user.id = session.user_id
	WHERE session.id = v_session_id
		AND session.user_id = v_user_id
		AND session.active_household_id = v_household_id
		AND account_user.email_verified = true
	FOR UPDATE OF session, account_user;
	-- Sample database time only after all authority-bearing rows are locked.
	v_now := pg_catalog.clock_timestamp();
	IF NOT FOUND
		OR v_session_expires_at <= v_now
		OR v_access.expires_at <= v_now
		OR v_active_at < v_now - interval '60 seconds'
		OR v_active_at > v_now + interval '5 seconds'
		OR (
			v_require_active
			AND (
				v_disclosure.revoked_at IS NOT NULL
				OR v_disclosure.created_at > v_active_at
				OR v_disclosure.expires_at <= v_active_at
				OR v_disclosure.expires_at <= v_now
			)
		)
		OR (
			v_phase <> 'proposal-create'
			AND v_proposal.expires_at <= v_now
		)
		OR (
			v_phase = 'provider-write-dispatch'
			AND v_attempt.expires_at <= v_now
		)
	THEN
		RETURN false;
	END IF;

	v_expires_at := LEAST(
		v_now + interval '60 seconds',
		v_session_expires_at,
		v_access.expires_at
	);
	IF v_require_active THEN
		v_expires_at := LEAST(
			v_expires_at, v_disclosure.expires_at
		);
	END IF;
	IF v_phase <> 'proposal-create' THEN
		v_expires_at := LEAST(v_expires_at, v_proposal.expires_at);
	END IF;
	IF v_phase = 'provider-write-dispatch' THEN
		v_expires_at := LEAST(v_expires_at, v_attempt.expires_at);
	END IF;
	IF v_expires_at <= v_now THEN
		RETURN false;
	END IF;

	v_scope_assertion := pg_catalog.jsonb_build_object(
		'phase', v_phase,
		'currentRequestId', v_request_id,
		'currentSessionId', v_session_id,
		'runId', v_run_id,
		'householdId', v_household_id,
		'userId', v_user_id,
		'currentSpaceAccessGrantId', v_space_access_grant_id,
		'authorizationScopeFingerprint', v_authorization_scope_fingerprint,
		'disclosureGrantId', v_disclosure_grant_id,
		'disclosureGrantVersion', v_disclosure_grant_version,
		'disclosureGrantHash', v_disclosure_grant_hash,
		'proposalId', v_proposal_id,
		'providerSdkCallId', v_provider_sdk_call_id,
		'activeAt', p_scope ->> 'activeAt',
		'requireActiveDisclosureGrant', v_require_active
	);
	SELECT claim.* INTO v_existing
	FROM emdo.workflow_operation_claims AS claim
	WHERE claim.operation_id = p_operation_id
	FOR UPDATE OF claim;
	IF FOUND THEN
		-- An already-claimed, byte-exact operation may reach the aggregate's
		-- duplicate validator. All current authority rows were re-locked above;
		-- stale, expired, or mismatched replays still fail closed here.
		RETURN v_existing.expires_at > v_now
			AND v_existing.phase = v_phase
			AND v_existing.scope_assertion = v_scope_assertion
			AND v_existing.origin_request_id = v_origin_request_id
			AND v_existing.origin_space_access_grant_id =
				v_origin_space_access_grant_id
			AND v_existing.origin_session_id = v_origin_session_id
			AND v_existing.current_request_id = v_request_id
			AND v_existing.current_space_access_grant_id =
				v_space_access_grant_id
			AND v_existing.current_session_id = v_session_id
			AND v_existing.authorization_scope_fingerprint =
				v_authorization_scope_fingerprint
			AND v_existing.disclosure_grant_id = v_disclosure_grant_id
			AND v_existing.disclosure_grant_version =
				v_disclosure_grant_version
			AND v_existing.disclosure_grant_hash = v_disclosure_grant_hash
			AND v_existing.provider_sdk_call_id = v_provider_sdk_call_id
			AND v_existing.active_at = v_active_at
			AND v_existing.require_active_disclosure_grant = v_require_active
			AND v_existing.authenticated_session_id IS NOT DISTINCT FROM
				v_authenticated_session_id
			AND v_existing.household_id = v_household_id
			AND v_existing.space_id = v_run.space_id
			AND v_existing.original_owner_user_id = v_user_id
			AND v_existing.user_id = v_user_id
			AND v_existing.run_id = v_run_id
			AND v_existing.proposal_id = v_proposal_id
			AND v_existing.decision_id IS NOT DISTINCT FROM p_decision_id
			AND v_existing.provider_attempt_id IS NOT DISTINCT FROM
				p_provider_attempt_id
			AND v_existing.provider_authority_binding_hash =
				p_provider_authority_binding_hash
			AND v_existing.preparation_binding_hash =
				v_preparation_binding_hash
			AND v_existing.binding_hash IS NOT DISTINCT FROM p_binding_hash
			AND v_existing.mutation_hash = v_mutation_hash;
	END IF;

	INSERT INTO emdo.workflow_operation_claims(
		operation_id, phase, scope_assertion,
		origin_request_id, origin_space_access_grant_id, origin_session_id,
		current_request_id, current_space_access_grant_id, current_session_id,
		authorization_scope_fingerprint,
		disclosure_grant_id, disclosure_grant_version,
		disclosure_grant_hash, provider_sdk_call_id, active_at,
		require_active_disclosure_grant, authenticated_session_id,
		household_id, space_id, original_owner_user_id, user_id,
		run_id, proposal_id, decision_id, provider_attempt_id,
		provider_authority_binding_hash, preparation_binding_hash,
		binding_hash, mutation_hash, issued_at, expires_at, claimed_at
	) VALUES (
		p_operation_id, v_phase, v_scope_assertion,
		v_origin_request_id, v_origin_space_access_grant_id, v_origin_session_id,
		v_request_id, v_space_access_grant_id, v_session_id,
		v_authorization_scope_fingerprint,
		v_disclosure_grant_id, v_disclosure_grant_version,
		v_disclosure_grant_hash, v_provider_sdk_call_id, v_active_at,
		v_require_active, v_authenticated_session_id,
		v_household_id, v_run.space_id, v_user_id, v_user_id,
		v_run_id, v_proposal_id, p_decision_id,
		p_provider_attempt_id, p_provider_authority_binding_hash,
		v_preparation_binding_hash, p_binding_hash, v_mutation_hash,
		v_now, v_expires_at, NULL
	);
	RETURN true;
END
$function$;

--> statement-breakpoint
ALTER FUNCTION "emdo"."issue_workflow_operation_claim_calendar"(text, jsonb, uuid, uuid, text, text, text, jsonb) OWNER TO emdo_workflow_executor;
REVOKE ALL ON FUNCTION "emdo"."issue_workflow_operation_claim_calendar"(text, jsonb, uuid, uuid, text, text, text, jsonb) FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_workflow_executor, emdo_workflow_login;
GRANT EXECUTE ON FUNCTION "emdo"."issue_workflow_operation_claim_calendar"(text, jsonb, uuid, uuid, text, text, text, jsonb) TO emdo_workflow_executor;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."issue_model_disclosure_grant"(
	p_run_id uuid,
	p_household_id uuid,
	p_user_id uuid,
	p_space_id uuid,
	p_space_access_grant_id uuid,
	p_agent_id text,
	p_phase_purpose text,
	p_purpose text,
	p_provider text,
	p_record_allowlist jsonb
)
RETURNS TABLE (
	schema_version smallint,
	version integer,
	grant_id uuid,
	household_id uuid,
	space_id uuid,
	original_owner_user_id uuid,
	run_id uuid,
	agent_id text,
	purpose text,
	phase_purpose text,
	provider text,
	record_allowlist jsonb,
	grant_hash text,
	one_run_only boolean,
	created_at timestamptz,
	expires_at timestamptz,
	database_time timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_user_id uuid := emdo.current_user_id();
	v_session_id uuid := emdo.current_session_id();
	v_request_id uuid := emdo.current_request_id();
	v_space_grant emdo.space_access_grants%ROWTYPE;
	v_grant emdo.disclosure_grants%ROWTYPE;
	v_record jsonb;
	v_canonical_record jsonb;
	v_canonical_allowlist jsonb := '[]'::jsonb;
	v_data_class text;
	v_record_id text;
	v_field text;
	v_fields jsonb;
	v_fields_text text;
	v_record_text text;
	v_record_texts text[] := ARRAY[]::text[];
	v_binding text;
	v_bindings text[] := ARRAY[]::text[];
	v_allowlist_text text;
	v_grant_text text;
	v_created_iso text;
	v_expires_iso text;
	v_expected_hash text;
	v_now timestamptz;
	v_created_at timestamptz;
	v_expires_at timestamptz;
	v_grant_id uuid;
	v_existing_grant boolean;
BEGIN
	IF p_run_id IS NULL OR p_household_id IS NULL OR p_user_id IS NULL
		OR p_space_id IS NULL OR p_space_access_grant_id IS NULL
		OR p_user_id IS DISTINCT FROM v_user_id
		OR v_session_id IS NULL OR v_request_id IS NULL
		OR p_agent_id IS NULL OR pg_catalog.btrim(p_agent_id) <> p_agent_id
		OR pg_catalog.length(p_agent_id) NOT BETWEEN 2 AND 160
		OR p_agent_id !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
		OR p_phase_purpose NOT IN (
			'manager-plan', 'specialist-execution', 'manager-synthesis'
		)
		OR p_purpose IS NULL OR pg_catalog.btrim(p_purpose) <> p_purpose
		OR pg_catalog.length(p_purpose) NOT BETWEEN 3 AND 500
		OR p_provider <> 'openai'
	THEN
		RETURN;
	END IF;
	IF pg_catalog.jsonb_typeof(p_record_allowlist) <> 'array' THEN
		RETURN;
	END IF;
	IF pg_catalog.jsonb_array_length(p_record_allowlist) NOT BETWEEN 1 AND 256
		OR pg_catalog.octet_length(p_record_allowlist::text) > 262144
	THEN
		RETURN;
	END IF;

	FOR v_record IN
		SELECT entry.value
		FROM pg_catalog.jsonb_array_elements(p_record_allowlist) AS entry(value)
		ORDER BY entry.value ->> 'dataClass', entry.value ->> 'recordId'
	LOOP
		IF pg_catalog.jsonb_typeof(v_record) <> 'object' THEN
			RETURN;
		END IF;
		IF NOT (v_record ?& ARRAY['dataClass', 'recordId', 'fields'])
			OR (
				SELECT pg_catalog.count(*)
				FROM pg_catalog.jsonb_object_keys(v_record)
			) <> 3
			OR pg_catalog.jsonb_typeof(v_record -> 'dataClass') <> 'string'
			OR pg_catalog.jsonb_typeof(v_record -> 'recordId') <> 'string'
			OR pg_catalog.jsonb_typeof(v_record -> 'fields') <> 'array'
		THEN
			RETURN;
		END IF;
		IF pg_catalog.jsonb_array_length(v_record -> 'fields') NOT BETWEEN 1 AND 128
		THEN
			RETURN;
		END IF;
		v_data_class := v_record ->> 'dataClass';
		v_record_id := v_record ->> 'recordId';
		IF pg_catalog.length(v_data_class) NOT BETWEEN 2 AND 160
			OR v_data_class !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
			OR pg_catalog.btrim(v_record_id) <> v_record_id
			OR pg_catalog.length(v_record_id) NOT BETWEEN 1 AND 512
			OR v_record_id ~ '[[:cntrl:]]'
		THEN
			RETURN;
		END IF;
		FOR v_field IN
			SELECT field.value
			FROM pg_catalog.jsonb_array_elements_text(v_record -> 'fields')
				AS field(value)
		LOOP
			IF pg_catalog.length(v_field) NOT BETWEEN 2 AND 160
				OR v_field !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
			THEN
				RETURN;
			END IF;
		END LOOP;
		IF (
			SELECT pg_catalog.count(*)
			FROM pg_catalog.jsonb_array_elements_text(v_record -> 'fields')
		) <> (
			SELECT pg_catalog.count(DISTINCT field.value)
			FROM pg_catalog.jsonb_array_elements_text(v_record -> 'fields')
				AS field(value)
		) THEN
			RETURN;
		END IF;
		v_binding := v_data_class || E'\x1f' || v_record_id;
		IF v_binding = ANY(v_bindings) THEN
			RETURN;
		END IF;
		v_bindings := pg_catalog.array_append(v_bindings, v_binding);
		SELECT
			pg_catalog.jsonb_agg(pg_catalog.to_jsonb(field.value) ORDER BY field.value),
			'[' || pg_catalog.string_agg(
				pg_catalog.to_jsonb(field.value)::text, ',' ORDER BY field.value
			) || ']'
		INTO v_fields, v_fields_text
		FROM pg_catalog.jsonb_array_elements_text(v_record -> 'fields')
			AS field(value);
		v_canonical_record := pg_catalog.jsonb_build_object(
			'dataClass', v_data_class,
			'fields', v_fields,
			'recordId', v_record_id
		);
		v_canonical_allowlist := v_canonical_allowlist
			|| pg_catalog.jsonb_build_array(v_canonical_record);
		v_record_text := '{"dataClass":'
			|| pg_catalog.to_jsonb(v_data_class)::text
			|| ',"fields":' || v_fields_text
			|| ',"recordId":' || pg_catalog.to_jsonb(v_record_id)::text || '}';
		v_record_texts := pg_catalog.array_append(v_record_texts, v_record_text);
	END LOOP;
	v_allowlist_text := '[' || pg_catalog.array_to_string(v_record_texts, ',') || ']';

	SELECT resolved.* INTO v_space_grant
	FROM emdo.resolve_space_access_grant(
		p_space_access_grant_id, p_household_id, p_user_id,
		v_session_id, v_request_id, p_space_id
	) AS resolved;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	PERFORM 1
	FROM emdo.agent_runs AS run
	WHERE run.id = p_run_id
		AND run.household_id = p_household_id
		AND run.space_id = p_space_id
		AND run.original_owner_user_id = p_user_id
		AND (
			run.agent_id = p_agent_id
			OR (
				run.agent_id = 'manager'
				AND p_agent_id IN ('scheduler', 'finance')
				AND p_phase_purpose = 'specialist-execution'
			)
		)
		AND (
			run.status IN ('queued', 'running')
			OR (
				run.status = 'blocked'
				AND p_phase_purpose IN (
					'specialist-execution', 'manager-synthesis'
				)
				AND EXISTS (
					SELECT 1
					FROM emdo.approval_resume_jobs AS resume
					WHERE resume.run_id = p_run_id
						AND resume.household_id = p_household_id
						AND resume.space_id = p_space_id
						AND resume.user_id = p_user_id
						AND resume.state = 'claimed'
						AND resume.decision_id IS NOT NULL
						AND (
							resume.decision_type = 'approved'
							OR (
								resume.decision_type = 'rejected'
								AND p_phase_purpose = 'manager-synthesis'
							)
						)
						AND resume.authenticated_session_id = v_session_id
						AND resume.resume_request_id = v_request_id
						AND resume.resume_space_access_grant_id =
							p_space_access_grant_id
						AND resume.approval_event_sequence IS NOT NULL
						AND resume.claim_id IS NOT NULL
						AND resume.ownership_token_digest ~ '^[a-f0-9]{64}$'
						AND resume.collection_authorization_scope_fingerprint ~
							'^[a-f0-9]{64}$'
						AND resume.claimed_at IS NOT NULL
						AND resume.claim_expires_at > pg_catalog.clock_timestamp()
						AND resume.terminal_event_sequence IS NULL
						AND resume.terminal_reason_code IS NULL
						AND resume.terminal_result_hash IS NULL
						AND resume.expires_at > pg_catalog.clock_timestamp()
				)
			)
		)
	FOR SHARE OF run;
	IF NOT FOUND THEN
		RETURN;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			p_household_id::text || ':' || p_space_id::text || ':'
			|| p_user_id::text || ':' || p_run_id::text || ':'
			|| p_agent_id || ':' || p_phase_purpose || ':' || p_provider,
			0
		)
	);
	SELECT stored.* INTO v_grant
	FROM emdo.disclosure_grants AS stored
	WHERE stored.household_id = p_household_id
		AND stored.space_id = p_space_id
		AND stored.user_id = p_user_id
		AND stored.run_id = p_run_id
		AND stored.agent_id = p_agent_id
		AND stored.phase_purpose = p_phase_purpose
		AND stored.provider = p_provider
	FOR UPDATE;
	v_existing_grant := FOUND;
	SELECT resolved.* INTO v_space_grant
	FROM emdo.resolve_space_access_grant(
		p_space_access_grant_id, p_household_id, p_user_id,
		v_session_id, v_request_id, p_space_id
	) AS resolved;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	v_now := pg_catalog.clock_timestamp();
	IF v_space_grant.issued_at > v_now OR v_space_grant.expires_at <= v_now THEN
		RETURN;
	END IF;
	IF v_existing_grant THEN
		v_created_iso := pg_catalog.to_char(
			v_grant.created_at AT TIME ZONE 'UTC',
			'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
		);
		v_expires_iso := pg_catalog.to_char(
			v_grant.expires_at AT TIME ZONE 'UTC',
			'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
		);
		v_grant_text := '{"agentId":' || pg_catalog.to_jsonb(v_grant.agent_id)::text
			|| ',"createdAt":' || pg_catalog.to_jsonb(v_created_iso)::text
			|| ',"expiresAt":' || pg_catalog.to_jsonb(v_expires_iso)::text
			|| ',"householdId":' || pg_catalog.to_jsonb(v_grant.household_id::text)::text
			|| ',"id":' || pg_catalog.to_jsonb(v_grant.id::text)::text
			|| ',"oneRunOnly":true'
			|| ',"provider":' || pg_catalog.to_jsonb(v_grant.provider)::text
			|| ',"purpose":' || pg_catalog.to_jsonb(v_grant.purpose)::text
			|| ',"recordAllowlist":' || v_allowlist_text
			|| ',"runId":' || pg_catalog.to_jsonb(v_grant.run_id::text)::text
			|| ',"schemaVersion":1'
			|| ',"userId":' || pg_catalog.to_jsonb(v_grant.user_id::text)::text
			|| ',"version":' || v_grant.version::text || '}';
		v_expected_hash := pg_catalog.encode(
			pg_catalog.sha256(pg_catalog.convert_to(v_grant_text, 'UTF8')),
			'hex'
		);
		IF v_grant.schema_version <> 1 OR v_grant.version <> 1
			OR v_grant.purpose IS DISTINCT FROM p_purpose
			OR v_grant.record_allowlist IS DISTINCT FROM v_canonical_allowlist
			OR v_grant.one_run_only IS DISTINCT FROM true
			OR v_grant.created_at IS DISTINCT FROM pg_catalog.date_trunc(
				'milliseconds', v_grant.created_at
			)
			OR v_grant.expires_at IS DISTINCT FROM
				v_grant.created_at + interval '10 minutes'
			OR v_grant.revoked_at IS NOT NULL
			OR v_grant.expires_at <= v_now
			OR v_grant.grant_hash IS DISTINCT FROM v_expected_hash
		THEN
			RETURN;
		END IF;
		RETURN QUERY SELECT
			v_grant.schema_version, v_grant.version, v_grant.id,
			v_grant.household_id, v_grant.space_id, v_grant.user_id,
			v_grant.run_id, v_grant.agent_id, v_grant.purpose,
			v_grant.phase_purpose, v_grant.provider,
			v_grant.record_allowlist, v_grant.grant_hash,
			v_grant.one_run_only, v_grant.created_at, v_grant.expires_at, v_now;
		RETURN;
	END IF;

	v_created_at := pg_catalog.date_trunc('milliseconds', v_now);
	v_expires_at := v_created_at + interval '10 minutes';
	v_grant_id := pg_catalog.gen_random_uuid();
	v_created_iso := pg_catalog.to_char(
		v_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
	);
	v_expires_iso := pg_catalog.to_char(
		v_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
	);
	v_grant_text := '{"agentId":' || pg_catalog.to_jsonb(p_agent_id)::text
		|| ',"createdAt":' || pg_catalog.to_jsonb(v_created_iso)::text
		|| ',"expiresAt":' || pg_catalog.to_jsonb(v_expires_iso)::text
		|| ',"householdId":' || pg_catalog.to_jsonb(p_household_id::text)::text
		|| ',"id":' || pg_catalog.to_jsonb(v_grant_id::text)::text
		|| ',"oneRunOnly":true'
		|| ',"provider":' || pg_catalog.to_jsonb(p_provider)::text
		|| ',"purpose":' || pg_catalog.to_jsonb(p_purpose)::text
		|| ',"recordAllowlist":' || v_allowlist_text
		|| ',"runId":' || pg_catalog.to_jsonb(p_run_id::text)::text
		|| ',"schemaVersion":1'
		|| ',"userId":' || pg_catalog.to_jsonb(p_user_id::text)::text
		|| ',"version":1}';
	v_expected_hash := pg_catalog.encode(
		pg_catalog.sha256(pg_catalog.convert_to(v_grant_text, 'UTF8')), 'hex'
	);
	INSERT INTO emdo.disclosure_grants(
		id, schema_version, version, household_id, space_id, user_id,
		run_id, agent_id, purpose, phase_purpose, provider, record_allowlist,
		grant_hash, one_run_only, created_at, expires_at
	) VALUES (
		v_grant_id, 1, 1, p_household_id, p_space_id, p_user_id,
		p_run_id, p_agent_id, p_purpose, p_phase_purpose, p_provider,
		v_canonical_allowlist, v_expected_hash, true, v_created_at, v_expires_at
	)
	ON CONFLICT ON CONSTRAINT disclosure_grants_run_phase_agent_unique
		DO NOTHING
	RETURNING * INTO v_grant;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	INSERT INTO emdo.audit_events(
		household_id, space_id, original_owner_user_id, actor_user_id,
		session_id, request_id, run_id, event_type, payload,
		occurred_at, retain_until
	) VALUES (
		p_household_id, p_space_id, p_user_id, p_user_id,
		v_session_id, v_request_id, p_run_id, 'model.disclosure.granted',
		pg_catalog.jsonb_build_object(
			'schemaVersion', 1, 'grantId', v_grant.id,
			'grantVersion', v_grant.version, 'agentId', p_agent_id,
			'phasePurpose', p_phase_purpose, 'provider', p_provider,
			'records', v_canonical_allowlist
		), v_now, v_now + interval '12 months'
	);
	RETURN QUERY SELECT
		v_grant.schema_version, v_grant.version, v_grant.id,
		v_grant.household_id, v_grant.space_id, v_grant.user_id,
		v_grant.run_id, v_grant.agent_id, v_grant.purpose,
		v_grant.phase_purpose, v_grant.provider,
		v_grant.record_allowlist, v_grant.grant_hash,
		v_grant.one_run_only, v_grant.created_at, v_grant.expires_at, v_now;
END
$function$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."resolve_model_disclosure_grant"(
	p_requested_grant_id uuid,
	p_run_id uuid,
	p_household_id uuid,
	p_user_id uuid,
	p_space_access_grant_id uuid,
	p_agent_id text,
	p_phase_purpose text,
	p_provider text,
	p_requested_data_classes jsonb
)
RETURNS TABLE (
	status text,
	schema_version smallint,
	version integer,
	grant_id uuid,
	household_id uuid,
	space_id uuid,
	original_owner_user_id uuid,
	run_id uuid,
	agent_id text,
	purpose text,
	provider text,
	record_allowlist jsonb,
	grant_hash text,
	created_at timestamptz,
	expires_at timestamptz,
	database_time timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_grant emdo.disclosure_grants%ROWTYPE;
	v_space_grant emdo.space_access_grants%ROWTYPE;
	v_now timestamptz;
	v_allowlist_valid boolean;
BEGIN
	IF p_run_id IS NULL OR p_household_id IS NULL OR p_user_id IS NULL
		OR p_space_access_grant_id IS NULL
		OR p_user_id IS DISTINCT FROM emdo.current_user_id()
		OR p_agent_id IS NULL OR pg_catalog.btrim(p_agent_id) <> p_agent_id
		OR pg_catalog.length(p_agent_id) NOT BETWEEN 2 AND 160
		OR p_phase_purpose NOT IN (
			'manager-plan', 'specialist-execution', 'manager-synthesis'
		)
		OR p_provider <> 'openai'
		OR pg_catalog.jsonb_typeof(p_requested_data_classes) <> 'array'
		OR pg_catalog.jsonb_array_length(p_requested_data_classes) > 64
		OR EXISTS (
			SELECT 1 FROM pg_catalog.jsonb_array_elements(p_requested_data_classes) AS requested(value)
			WHERE pg_catalog.jsonb_typeof(requested.value) <> 'string'
				OR pg_catalog.length(requested.value #>> '{}') NOT BETWEEN 2 AND 160
		)
		OR (
			SELECT pg_catalog.count(*)
			FROM pg_catalog.jsonb_array_elements_text(p_requested_data_classes)
		) <> (
			SELECT pg_catalog.count(DISTINCT requested)
			FROM pg_catalog.jsonb_array_elements_text(p_requested_data_classes) AS requested
		)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '22023',
			MESSAGE = 'invalid model disclosure request';
	END IF;

	v_now := pg_catalog.clock_timestamp();
	SELECT stored.* INTO v_space_grant
	FROM emdo.space_access_grants AS stored
	WHERE stored.grant_id = p_space_access_grant_id
		AND stored.household_id = p_household_id
		AND stored.original_owner_user_id = p_user_id
		AND stored.session_id = emdo.current_session_id()
		AND stored.request_id = emdo.current_request_id()
		AND stored.expires_at > v_now;
	IF NOT FOUND THEN
		RETURN QUERY SELECT 'no-active-grant'::text, NULL::smallint,
			NULL::integer, p_requested_grant_id, NULL::uuid, NULL::uuid,
			NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text,
			NULL::jsonb, NULL::text, NULL::timestamptz, NULL::timestamptz,
			v_now;
		RETURN;
	END IF;

	IF p_requested_grant_id IS NULL THEN
		RETURN QUERY SELECT 'no-active-grant'::text, NULL::smallint,
			NULL::integer, NULL::uuid, NULL::uuid, NULL::uuid,
			NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text,
			NULL::jsonb, NULL::text, NULL::timestamptz, NULL::timestamptz,
			v_now;
		RETURN;
	END IF;
	SELECT candidate.* INTO v_grant
	FROM emdo.disclosure_grants AS candidate
	WHERE candidate.id = p_requested_grant_id
		AND candidate.user_id = p_user_id
	FOR UPDATE;
	IF NOT FOUND THEN
		RETURN QUERY SELECT 'grant-not-found'::text, NULL::smallint,
			NULL::integer, p_requested_grant_id, NULL::uuid, NULL::uuid,
			NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text,
			NULL::jsonb, NULL::text, NULL::timestamptz, NULL::timestamptz,
			v_now;
		RETURN;
	END IF;

	v_now := pg_catalog.clock_timestamp();
	IF v_space_grant.issued_at > v_now OR v_space_grant.expires_at <= v_now THEN
		status := 'no-active-grant';
	ELSIF v_grant.household_id IS DISTINCT FROM p_household_id THEN
		status := 'grant-household-mismatch';
	ELSIF v_grant.user_id IS DISTINCT FROM p_user_id THEN
		status := 'grant-user-mismatch';
	ELSIF v_grant.run_id IS DISTINCT FROM p_run_id THEN
		status := 'grant-run-mismatch';
	ELSIF v_grant.agent_id IS DISTINCT FROM p_agent_id THEN
		status := 'grant-agent-mismatch';
	ELSIF v_grant.provider IS DISTINCT FROM p_provider THEN
		status := 'grant-provider-mismatch';
	ELSIF v_grant.phase_purpose IS DISTINCT FROM p_phase_purpose THEN
		status := 'grant-purpose-mismatch';
	ELSIF v_grant.revoked_at IS NOT NULL OR v_grant.expires_at <= v_now THEN
		status := 'grant-expired';
	ELSIF NOT (v_grant.space_id = ANY(v_space_grant.writable_space_ids))
		OR NOT EXISTS (
			SELECT 1
			FROM emdo.resolve_space_access_grant(
				p_space_access_grant_id, p_household_id, p_user_id,
				emdo.current_session_id(), emdo.current_request_id(),
				v_grant.space_id
			)
		)
	THEN
		status := 'no-active-grant';
	ELSE
		SELECT (
			pg_catalog.jsonb_typeof(v_grant.record_allowlist) = 'array'
			AND pg_catalog.jsonb_array_length(v_grant.record_allowlist) BETWEEN 1 AND 256
			AND NOT EXISTS (
				SELECT 1
				FROM pg_catalog.jsonb_array_elements(v_grant.record_allowlist) AS allowed(record)
				WHERE pg_catalog.jsonb_typeof(allowed.record) <> 'object'
					OR NOT (allowed.record ?& ARRAY['dataClass', 'recordId', 'fields'])
					OR (
						SELECT pg_catalog.count(*)
						FROM pg_catalog.jsonb_object_keys(allowed.record)
					) <> 3
					OR pg_catalog.jsonb_typeof(allowed.record -> 'dataClass') <> 'string'
					OR pg_catalog.jsonb_typeof(allowed.record -> 'recordId') <> 'string'
					OR pg_catalog.jsonb_typeof(allowed.record -> 'fields') <> 'array'
					OR pg_catalog.jsonb_array_length(allowed.record -> 'fields') NOT BETWEEN 1 AND 128
			)
		) INTO v_allowlist_valid;
		IF NOT v_allowlist_valid OR EXISTS (
			SELECT 1
			FROM pg_catalog.jsonb_array_elements_text(p_requested_data_classes) AS requested(data_class)
			WHERE NOT EXISTS (
				SELECT 1
				FROM pg_catalog.jsonb_array_elements(v_grant.record_allowlist) AS allowed(record)
				WHERE allowed.record ->> 'dataClass' = requested.data_class
			)
		) THEN
			status := 'record-not-allowed';
		ELSE
			PERFORM 1
			FROM emdo.agent_runs AS run
			WHERE run.id = v_grant.run_id
				AND run.household_id = v_grant.household_id
				AND run.space_id = v_grant.space_id
				AND run.original_owner_user_id = v_grant.user_id
					AND (
						run.agent_id = v_grant.agent_id
						OR (
							run.agent_id = 'manager'
							AND v_grant.phase_purpose = 'specialist-execution'
							AND v_grant.agent_id IN ('scheduler', 'finance')
						)
					)
					AND (
						(
							v_grant.phase_purpose IN (
								'manager-plan', 'specialist-execution',
								'manager-synthesis'
							)
							AND run.status IN ('queued', 'running')
						)
						OR (
							v_grant.phase_purpose IN (
								'specialist-execution', 'manager-synthesis'
							)
							AND run.status = 'blocked'
							AND EXISTS (
								SELECT 1
								FROM emdo.approval_resume_jobs AS resume
								WHERE resume.run_id = v_grant.run_id
									AND resume.household_id = v_grant.household_id
									AND resume.space_id = v_grant.space_id
									AND resume.user_id = v_grant.user_id
									AND resume.user_id = run.original_owner_user_id
									AND resume.state = 'claimed'
									AND resume.decision_id IS NOT NULL
									AND (
										resume.decision_type = 'approved'
										OR (
											resume.decision_type = 'rejected'
											AND v_grant.phase_purpose =
												'manager-synthesis'
										)
									)
									AND resume.authenticated_session_id =
										emdo.current_session_id()
									AND resume.resume_request_id =
										emdo.current_request_id()
									AND resume.resume_space_access_grant_id =
										p_space_access_grant_id
									AND resume.approval_event_sequence IS NOT NULL
									AND resume.claim_id IS NOT NULL
									AND resume.ownership_token_digest ~ '^[a-f0-9]{64}$'
									AND resume.collection_authorization_scope_fingerprint ~
										'^[a-f0-9]{64}$'
									AND resume.claimed_at IS NOT NULL
									AND resume.claim_expires_at > pg_catalog.clock_timestamp()
									AND resume.terminal_event_sequence IS NULL
									AND resume.terminal_reason_code IS NULL
									AND resume.terminal_result_hash IS NULL
									AND resume.expires_at > pg_catalog.clock_timestamp()
							)
						)
					);
			IF FOUND THEN
				status := 'active';
			ELSE
				status := 'grant-run-mismatch';
			END IF;
		END IF;
	END IF;

	IF status = 'active' THEN
		v_now := pg_catalog.clock_timestamp();
		IF v_space_grant.expires_at <= v_now THEN
			status := 'no-active-grant';
		ELSIF v_grant.expires_at <= v_now THEN
			status := 'grant-expired';
		END IF;
	END IF;
	IF status <> 'active' THEN
		RETURN QUERY SELECT status, NULL::smallint, NULL::integer,
			v_grant.id, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
			NULL::text, NULL::text, NULL::text, NULL::jsonb, NULL::text,
			NULL::timestamptz, NULL::timestamptz, v_now;
		RETURN;
	END IF;
	RETURN QUERY SELECT status, v_grant.schema_version, v_grant.version,
		v_grant.id, v_grant.household_id, v_grant.space_id, v_grant.user_id,
		v_grant.run_id, v_grant.agent_id, v_grant.purpose, v_grant.provider,
		v_grant.record_allowlist, v_grant.grant_hash, v_grant.created_at,
		v_grant.expires_at, v_now;
END
$function$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."commit_model_disclosure_authorization"(
	p_grant_id uuid,
	p_version integer,
	p_grant_hash text,
	p_space_access_grant_id uuid,
	p_phase_purpose text,
	p_records jsonb
)
RETURNS TABLE (committed boolean, database_time timestamptz, expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_grant emdo.disclosure_grants%ROWTYPE;
	v_space_grant emdo.space_access_grants%ROWTYPE;
	v_record jsonb;
	v_allowed jsonb;
	v_field text;
	v_binding text;
	v_bindings text[] := ARRAY[]::text[];
	v_now timestamptz;
BEGIN
	IF p_grant_id IS NULL OR p_version IS NULL OR p_version <= 0
		OR p_grant_hash !~ '^[a-f0-9]{64}$'
		OR p_space_access_grant_id IS NULL
		OR p_phase_purpose NOT IN (
			'manager-plan', 'specialist-execution', 'manager-synthesis'
		)
		OR pg_catalog.jsonb_typeof(p_records) <> 'array'
		OR pg_catalog.jsonb_array_length(p_records) > 256
	THEN
		RETURN;
	END IF;
	SELECT stored.* INTO v_grant
	FROM emdo.disclosure_grants AS stored
	WHERE stored.id = p_grant_id
		AND stored.version = p_version
		AND stored.grant_hash = p_grant_hash
		AND stored.phase_purpose = p_phase_purpose
		AND stored.user_id = emdo.current_user_id()
	FOR UPDATE;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	SELECT resolved.* INTO v_space_grant
	FROM emdo.resolve_space_access_grant(
		p_space_access_grant_id, v_grant.household_id, v_grant.user_id,
		emdo.current_session_id(), emdo.current_request_id(), v_grant.space_id
	) AS resolved;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	v_now := pg_catalog.clock_timestamp();
	IF v_grant.revoked_at IS NOT NULL OR v_grant.expires_at <= v_now
		OR v_space_grant.issued_at > v_now OR v_space_grant.expires_at <= v_now
	THEN
		RETURN;
	END IF;

	FOR v_record IN SELECT value FROM pg_catalog.jsonb_array_elements(p_records)
	LOOP
		IF pg_catalog.jsonb_typeof(v_record) <> 'object'
			OR NOT (v_record ?& ARRAY['dataClass', 'recordId', 'fields'])
			OR (
				SELECT pg_catalog.count(*)
				FROM pg_catalog.jsonb_object_keys(v_record)
			) <> 3
			OR pg_catalog.jsonb_typeof(v_record -> 'dataClass') <> 'string'
			OR pg_catalog.jsonb_typeof(v_record -> 'recordId') <> 'string'
			OR pg_catalog.jsonb_typeof(v_record -> 'fields') <> 'array'
			OR pg_catalog.jsonb_array_length(v_record -> 'fields') NOT BETWEEN 1 AND 128
		THEN
			RETURN;
		END IF;
		v_binding := (v_record ->> 'dataClass') || E'\x1f' || (v_record ->> 'recordId');
		IF v_binding = ANY(v_bindings) THEN
			RETURN;
		END IF;
		v_bindings := pg_catalog.array_append(v_bindings, v_binding);
		SELECT allowed.record INTO v_allowed
		FROM pg_catalog.jsonb_array_elements(v_grant.record_allowlist) AS allowed(record)
		WHERE allowed.record ->> 'dataClass' = v_record ->> 'dataClass'
			AND allowed.record ->> 'recordId' = v_record ->> 'recordId';
		IF NOT FOUND THEN
			RETURN;
		END IF;
		FOR v_field IN SELECT value FROM pg_catalog.jsonb_array_elements_text(v_record -> 'fields')
		LOOP
			IF NOT ((v_allowed -> 'fields') ? v_field) THEN
				RETURN;
			END IF;
		END LOOP;
		IF (
			SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements_text(v_record -> 'fields')
		) <> (
			SELECT pg_catalog.count(DISTINCT field_name)
			FROM pg_catalog.jsonb_array_elements_text(v_record -> 'fields') AS field_name
		) THEN
			RETURN;
		END IF;
	END LOOP;

	v_now := pg_catalog.clock_timestamp();
	IF v_grant.expires_at <= v_now OR v_space_grant.expires_at <= v_now
		OR NOT emdo.lock_active_request_scope(
			v_grant.household_id, v_grant.space_id, NULL
		)
	THEN
		RETURN;
	END IF;
	PERFORM 1
	FROM emdo.agent_runs AS run
	WHERE run.id = v_grant.run_id
		AND run.household_id = v_grant.household_id
		AND run.space_id = v_grant.space_id
		AND run.original_owner_user_id = v_grant.user_id
		AND (
			run.agent_id = v_grant.agent_id
			OR (
				run.agent_id = 'manager'
				AND v_grant.phase_purpose = 'specialist-execution'
				AND v_grant.agent_id IN ('scheduler', 'finance')
			)
		)
		AND (
			(
				v_grant.phase_purpose IN (
					'manager-plan', 'specialist-execution',
					'manager-synthesis'
				)
				AND run.status IN ('queued', 'running')
			)
			OR (
				v_grant.phase_purpose IN (
					'specialist-execution', 'manager-synthesis'
				)
				AND run.status = 'blocked'
				AND EXISTS (
					SELECT 1
					FROM emdo.approval_resume_jobs AS resume
					WHERE resume.run_id = v_grant.run_id
						AND resume.household_id = v_grant.household_id
						AND resume.space_id = v_grant.space_id
						AND resume.user_id = v_grant.user_id
						AND resume.user_id = run.original_owner_user_id
						AND resume.state = 'claimed'
						AND resume.decision_id IS NOT NULL
						AND (
							resume.decision_type = 'approved'
							OR (
								resume.decision_type = 'rejected'
								AND v_grant.phase_purpose =
									'manager-synthesis'
							)
						)
						AND resume.authenticated_session_id =
							emdo.current_session_id()
						AND resume.resume_request_id =
							emdo.current_request_id()
						AND resume.resume_space_access_grant_id =
							p_space_access_grant_id
						AND resume.approval_event_sequence IS NOT NULL
						AND resume.claim_id IS NOT NULL
						AND resume.ownership_token_digest ~ '^[a-f0-9]{64}$'
						AND resume.collection_authorization_scope_fingerprint ~
							'^[a-f0-9]{64}$'
						AND resume.claimed_at IS NOT NULL
						AND resume.claim_expires_at > pg_catalog.clock_timestamp()
						AND resume.terminal_event_sequence IS NULL
						AND resume.terminal_reason_code IS NULL
						AND resume.terminal_result_hash IS NULL
						AND resume.expires_at > pg_catalog.clock_timestamp()
				)
			)
		)
	FOR SHARE OF run;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	UPDATE emdo.disclosure_grants
	SET consumed_at = COALESCE(consumed_at, v_now)
	WHERE id = v_grant.id;
	INSERT INTO emdo.audit_events(
		household_id, space_id, original_owner_user_id, actor_user_id,
		session_id, request_id, run_id, event_type, payload,
		occurred_at, retain_until
	) VALUES (
		v_grant.household_id, v_grant.space_id, v_grant.user_id,
		v_grant.user_id, emdo.current_session_id(), emdo.current_request_id(),
		v_grant.run_id, 'model.disclosure.sent',
		pg_catalog.jsonb_build_object(
			'schemaVersion', 1, 'grantId', v_grant.id,
			'grantVersion', v_grant.version, 'agentId', v_grant.agent_id,
			'phasePurpose', p_phase_purpose, 'provider', v_grant.provider,
			'records', p_records
		), v_now, v_now + interval '12 months'
	);
	RETURN QUERY SELECT true, v_now, v_grant.expires_at;
END
$function$;

--> statement-breakpoint
ALTER FUNCTION "emdo"."issue_model_disclosure_grant"(uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb)
	OWNER TO emdo_disclosure_executor;
ALTER FUNCTION "emdo"."resolve_model_disclosure_grant"(uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb)
	OWNER TO emdo_disclosure_executor;
REVOKE ALL ON FUNCTION
	"emdo"."issue_model_disclosure_grant"(uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb),
	"emdo"."resolve_model_disclosure_grant"(uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."issue_model_disclosure_grant"(uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb),
	"emdo"."resolve_model_disclosure_grant"(uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb)
	TO emdo_app;

--> statement-breakpoint
GRANT SELECT ON TABLE "emdo"."approval_resume_jobs"
	TO emdo_disclosure_executor;
CREATE POLICY disclosure_approval_resume_jobs_select
	ON "emdo"."approval_resume_jobs"
	FOR SELECT TO emdo_disclosure_executor
	USING (
		user_id = emdo.current_user_id()
		AND authenticated_session_id = emdo.current_session_id()
		AND resume_request_id = emdo.current_request_id()
		AND state = 'claimed'
		AND decision_id IS NOT NULL
		AND decision_type IN ('approved', 'rejected')
		AND resume_space_access_grant_id IS NOT NULL
		AND approval_event_sequence IS NOT NULL
		AND claim_id IS NOT NULL
		AND ownership_token_digest IS NOT NULL
		AND ownership_token_digest ~ '^[a-f0-9]{64}$'
		AND collection_authorization_scope_fingerprint IS NOT NULL
		AND collection_authorization_scope_fingerprint ~ '^[a-f0-9]{64}$'
		AND claimed_at IS NOT NULL
		AND claim_expires_at > pg_catalog.clock_timestamp()
		AND terminal_event_sequence IS NULL
		AND terminal_reason_code IS NULL
		AND terminal_result_hash IS NULL
		AND expires_at > pg_catalog.clock_timestamp()
	);

--> statement-breakpoint
-- 0017 terminalized the resume row and event but left the manager run blocked.
-- Project only canonical terminal evidence; malformed or ambiguous legacy rows
-- remain blocked for explicit investigation.
WITH canonical_legacy_terminal_resume_events AS (
	SELECT resume.run_id, resume.household_id, resume.space_id,
		resume.user_id, event.occurred_at,
		CASE event.event_type
			WHEN 'run.completed' THEN 'completed'
			WHEN 'run.failed' THEN 'failed'
		END AS status
	FROM emdo.approval_resume_jobs AS resume
	JOIN emdo.agent_run_events AS event
		ON event.run_id = resume.run_id
		AND event.sequence = resume.terminal_event_sequence
		AND event.household_id = resume.household_id
		AND event.space_id = resume.space_id
		AND event.original_owner_user_id = resume.user_id
	WHERE resume.state IN ('terminal', 'indeterminate')
		AND resume.terminal_event_sequence IS NOT NULL
		AND pg_catalog.jsonb_typeof(event.payload) = 'object'
		AND event.payload ->> 'runId' = resume.run_id::text
		AND (
			(
				resume.state = 'terminal'
				AND (
					(
						event.event_type = 'run.completed'
						AND event.payload ->> 'status' = 'completed'
					)
					OR (
						event.event_type = 'run.failed'
						AND event.payload ->> 'status' IN (
							'failed', 'needs-approval'
						)
					)
				)
			)
			OR (
				resume.state = 'indeterminate'
				AND resume.terminal_reason_code = 'approval-resume-failed'
				AND event.event_type = 'run.failed'
				AND event.payload ->> 'status' = 'failed'
			)
		)
), legacy_terminal_resume_projection AS (
	SELECT run_id, household_id, space_id, user_id,
		pg_catalog.min(occurred_at) AS occurred_at,
		pg_catalog.min(status) AS status
	FROM canonical_legacy_terminal_resume_events
	GROUP BY run_id, household_id, space_id, user_id
	HAVING pg_catalog.count(*) = 1
		AND pg_catalog.count(DISTINCT status) = 1
		AND pg_catalog.count(DISTINCT occurred_at) = 1
)
UPDATE emdo.agent_runs AS run
SET status = legacy.status, completed_at = legacy.occurred_at
FROM legacy_terminal_resume_projection AS legacy
WHERE run.id = legacy.run_id
	AND run.household_id = legacy.household_id
	AND run.space_id = legacy.space_id
	AND run.original_owner_user_id = legacy.user_id
	AND run.agent_id = 'manager'
	AND run.status = 'blocked'
	AND run.completed_at IS NULL;

--> statement-breakpoint
-- Claim and job deadlines gate new dispatch authority, not terminal
-- settlement. A claimed row is never reclaimed, and only the exact
-- server-held token, session, and resume request may settle it.
CREATE OR REPLACE FUNCTION "emdo"."settle_approval_resume_job"(
	p_claim_id uuid,
	p_ownership_token text,
	p_mode text,
	p_reason_code text,
	p_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_job emdo.approval_resume_jobs%ROWTYPE;
	v_run emdo.agent_runs%ROWTYPE;
	v_ownership_token_digest text;
	v_terminal_state text;
	v_public_status text;
	v_event_type text;
	v_event_payload jsonb;
	v_terminal_audit_payload jsonb;
	v_terminal_result_hash text;
	v_terminal_sequence bigint;
	v_now timestamptz;
BEGIN
	IF p_claim_id IS NULL
		OR pg_catalog.length(p_ownership_token) NOT BETWEEN 16 AND 512
		OR p_ownership_token ~ '[[:cntrl:]]'
		OR p_mode IS NULL
		OR p_mode NOT IN ('complete', 'terminalize-not-dispatched', 'indeterminate')
		OR emdo.current_user_id() IS NULL
		OR emdo.current_session_id() IS NULL
		OR emdo.current_request_id() IS NULL
		OR (
			p_mode = 'complete'
			AND (
				p_reason_code IS NOT NULL
					OR emdo.approval_resume_turn_result_is_valid(p_result)
						IS DISTINCT FROM true
				)
			)
		OR (
			p_mode = 'terminalize-not-dispatched'
			AND (
				p_reason_code IS DISTINCT FROM
					'approval-resume-binding-invalid'
					OR p_result IS NOT NULL
			)
		)
		OR (
			p_mode = 'indeterminate'
			AND (
				p_reason_code IS DISTINCT FROM 'approval-resume-failed'
					OR p_result IS NOT NULL
			)
		)
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;

	v_ownership_token_digest := pg_catalog.encode(
		pg_catalog.sha256(
			pg_catalog.convert_to('emdo.approval-resume-owner.v1', 'UTF8')
				|| pg_catalog.decode('00', 'hex')
				|| pg_catalog.convert_to(p_ownership_token, 'UTF8')
		),
		'hex'
	);
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(p_claim_id::text, 0)
	);
	SELECT resume.* INTO v_job
	FROM emdo.approval_resume_jobs AS resume
	WHERE resume.claim_id = p_claim_id
		AND resume.user_id = emdo.current_user_id()
	FOR UPDATE OF resume;
	IF NOT FOUND
		OR v_job.ownership_token_digest IS DISTINCT FROM
			v_ownership_token_digest
		OR v_job.authenticated_session_id IS DISTINCT FROM
			emdo.current_session_id()
		OR v_job.resume_request_id IS DISTINCT FROM emdo.current_request_id()
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	IF v_job.state IN ('terminal', 'indeterminate') THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'replay',
			'terminalEventSequence', v_job.terminal_event_sequence
		);
	END IF;
	IF v_job.state IS DISTINCT FROM 'claimed'
		OR (
			p_mode = 'complete'
			AND p_result ->> 'runId' IS DISTINCT FROM v_job.run_id::text
		)
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;

	v_terminal_state := CASE p_mode
		WHEN 'indeterminate' THEN 'indeterminate' ELSE 'terminal' END;
	v_public_status := CASE p_mode
		WHEN 'complete' THEN 'completed'
		WHEN 'terminalize-not-dispatched' THEN 'terminalized'
		ELSE 'indeterminate'
	END;
	v_event_type := CASE p_mode
		WHEN 'complete' THEN CASE p_result ->> 'status'
			WHEN 'completed' THEN 'run.completed'
			ELSE 'run.failed'
		END
		ELSE 'run.failed'
	END;
	v_event_payload := CASE
		WHEN p_mode = 'complete' THEN p_result
		WHEN p_mode = 'terminalize-not-dispatched' THEN
			pg_catalog.jsonb_build_object(
				'status', 'failed',
				'runId', v_job.run_id,
				'localTraceReference',
					'approval-resume-terminalized-before-dispatch',
				'safeError', pg_catalog.jsonb_build_object(
					'code', 'approval-resume-binding-invalid',
					'message',
						'The approved action could not be resumed safely.',
					'retryable', false
				),
				'specialistOutcomes', '[]'::jsonb,
				'usage', pg_catalog.jsonb_build_object(
					'inputTokens', 0,
					'outputTokens', 0,
					'modelCostCadMinor', 0
				)
			)
		ELSE pg_catalog.jsonb_build_object(
			'status', 'failed',
			'runId', v_job.run_id,
			'localTraceReference', 'approval-resume-indeterminate',
			'safeError', pg_catalog.jsonb_build_object(
				'code', 'approval-resume-failed',
				'message',
					'The approved action could not be completed safely.',
				'retryable', false
			),
			'specialistOutcomes', '[]'::jsonb,
			'usage', pg_catalog.jsonb_build_object(
				'inputTokens', 0,
				'outputTokens', 0,
				'modelCostCadMinor', 0
			)
		)
	END;
	-- Preserve the established terminal lineage hash domain independently of
	-- the canonical public event representation.
	v_terminal_audit_payload := pg_catalog.jsonb_strip_nulls(
		pg_catalog.jsonb_build_object(
			'schemaVersion', 1,
			'runId', v_job.run_id,
			'proposalId', v_job.proposal_id,
			'approvalDecisionId', v_job.decision_id,
			'status', v_public_status,
			'reasonCode', p_reason_code,
			'result', p_result
		)
	);
	v_terminal_result_hash := pg_catalog.encode(
		pg_catalog.sha256(
			pg_catalog.convert_to('emdo.approval-resume-terminal.v1', 'UTF8')
				|| pg_catalog.decode('00', 'hex')
				|| pg_catalog.convert_to(v_terminal_audit_payload::text, 'UTF8')
		),
		'hex'
	);

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(v_job.run_id::text, 0)
	);
	SELECT run.* INTO v_run
	FROM emdo.agent_runs AS run
	WHERE run.id = v_job.run_id
		AND run.household_id = v_job.household_id
		AND run.space_id = v_job.space_id
		AND run.original_owner_user_id = v_job.user_id
		AND run.agent_id = 'manager'
		AND run.status = 'blocked'
		AND run.completed_at IS NULL
	FOR UPDATE OF run;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'approval resume run lock failed';
	END IF;
	SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
	INTO v_terminal_sequence
	FROM emdo.agent_run_events AS event
	WHERE event.run_id = v_job.run_id;
	v_now := pg_catalog.clock_timestamp();
	INSERT INTO emdo.agent_run_events(
		household_id, space_id, original_owner_user_id, run_id,
		sequence, event_type, payload, occurred_at, retain_until
	) VALUES (
		v_job.household_id, v_job.space_id, v_job.user_id, v_job.run_id,
		v_terminal_sequence, v_event_type, v_event_payload, v_now,
		v_now + interval '90 days'
	);
	UPDATE emdo.agent_runs AS run
	SET status = CASE
			WHEN v_event_payload ->> 'status' = 'completed'
				THEN 'completed'
			ELSE 'failed'
		END,
		resolved_model = CASE WHEN p_mode = 'complete'
			THEN v_event_payload #>> '{modelResolution,resolvedModel}'
			ELSE v_run.resolved_model END,
		model_reason = CASE WHEN p_mode = 'complete' THEN COALESCE(
			v_event_payload #>> '{modelResolution,reason}',
			v_event_payload #>> '{executionResolution,reason}'
		) ELSE v_run.model_reason END,
		local_trace_reference =
			v_event_payload ->> 'localTraceReference',
		safe_error = v_event_payload -> 'safeError',
		usage = CASE WHEN p_mode = 'complete'
			THEN v_event_payload -> 'usage' ELSE v_run.usage END,
		completed_at = v_now
	WHERE run.id = v_job.run_id
		AND run.household_id = v_job.household_id
		AND run.space_id = v_job.space_id
		AND run.original_owner_user_id = v_job.user_id
		AND run.agent_id = 'manager'
		AND run.status = 'blocked'
		AND run.completed_at IS NULL;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'approval resume run CAS failed';
	END IF;
	UPDATE emdo.approval_resume_jobs AS resume
	SET state = v_terminal_state, revision = resume.revision + 1,
		terminal_event_sequence = v_terminal_sequence,
		terminal_reason_code = p_reason_code,
		terminal_result_hash = v_terminal_result_hash,
		updated_at = v_now
	WHERE resume.job_id = v_job.job_id
		AND resume.revision = v_job.revision
		AND resume.state = 'claimed'
		AND resume.claim_id = p_claim_id
		AND resume.ownership_token_digest = v_ownership_token_digest;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'approval resume terminal CAS failed';
	END IF;
	UPDATE emdo.approval_checkpoints AS checkpoint
	SET state = 'cancelled', revision = checkpoint.revision + 1,
		updated_at = v_now
	WHERE checkpoint.checkpoint_id = v_job.checkpoint_id
		AND checkpoint.state = 'pending';

	RETURN pg_catalog.jsonb_build_object(
		'status', v_public_status,
		'terminalEventSequence', v_terminal_sequence
	);
END
$function$;
--> statement-breakpoint
ALTER FUNCTION "emdo"."settle_approval_resume_job"(
	uuid, text, text, text, jsonb
) OWNER TO emdo_approval_resume_executor;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
	"emdo"."settle_approval_resume_job"(uuid, text, text, text, jsonb)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login,
	emdo_proposal_reconciliation_executor, emdo_approval_resume_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."settle_approval_resume_job"(uuid, text, text, text, jsonb)
	TO emdo_app;

--> statement-breakpoint
GRANT SELECT ON "emdo"."agent_runs" TO emdo_approval_resume_executor;
GRANT UPDATE ("status", "completed_at") ON "emdo"."agent_runs"
	TO emdo_approval_resume_executor;
GRANT UPDATE (
	"resolved_model", "model_reason", "local_trace_reference",
	"safe_error", "usage"
) ON "emdo"."agent_runs"
	TO emdo_approval_resume_executor;
CREATE POLICY approval_resume_agent_runs_executor_select
	ON "emdo"."agent_runs"
	FOR SELECT TO emdo_approval_resume_executor
	USING (
		original_owner_user_id = emdo.current_user_id()
		AND EXISTS (
			SELECT 1
			FROM emdo.approval_resume_jobs AS resume
			WHERE resume.run_id = agent_runs.id
				AND resume.household_id = agent_runs.household_id
				AND resume.space_id = agent_runs.space_id
				AND resume.user_id = agent_runs.original_owner_user_id
				AND resume.user_id = emdo.current_user_id()
				AND resume.state = 'claimed'
				AND resume.decision_id IS NOT NULL
				AND resume.decision_type IN ('approved', 'rejected')
				AND resume.approval_event_sequence IS NOT NULL
				AND resume.claim_id IS NOT NULL
				AND resume.ownership_token_digest ~ '^[a-f0-9]{64}$'
				AND resume.authenticated_session_id = emdo.current_session_id()
				AND resume.resume_request_id = emdo.current_request_id()
				AND resume.resume_space_access_grant_id IS NOT NULL
				AND resume.claimed_at IS NOT NULL
				AND resume.terminal_event_sequence IS NULL
				AND resume.terminal_reason_code IS NULL
				AND resume.terminal_result_hash IS NULL
		)
	);
CREATE POLICY approval_resume_agent_runs_executor_update
	ON "emdo"."agent_runs"
	FOR UPDATE TO emdo_approval_resume_executor
	USING (
		original_owner_user_id = emdo.current_user_id()
		AND EXISTS (
			SELECT 1
			FROM emdo.approval_resume_jobs AS resume
			WHERE resume.run_id = agent_runs.id
				AND resume.household_id = agent_runs.household_id
				AND resume.space_id = agent_runs.space_id
				AND resume.user_id = agent_runs.original_owner_user_id
				AND resume.user_id = emdo.current_user_id()
				AND resume.state = 'claimed'
				AND resume.decision_id IS NOT NULL
				AND resume.decision_type IN ('approved', 'rejected')
				AND resume.approval_event_sequence IS NOT NULL
				AND resume.claim_id IS NOT NULL
				AND resume.ownership_token_digest ~ '^[a-f0-9]{64}$'
				AND resume.authenticated_session_id = emdo.current_session_id()
				AND resume.resume_request_id = emdo.current_request_id()
				AND resume.resume_space_access_grant_id IS NOT NULL
				AND resume.claimed_at IS NOT NULL
				AND resume.terminal_event_sequence IS NULL
				AND resume.terminal_reason_code IS NULL
				AND resume.terminal_result_hash IS NULL
		)
	)
	WITH CHECK (
		original_owner_user_id = emdo.current_user_id()
		AND EXISTS (
			SELECT 1
			FROM emdo.approval_resume_jobs AS resume
			WHERE resume.run_id = agent_runs.id
				AND resume.household_id = agent_runs.household_id
				AND resume.space_id = agent_runs.space_id
				AND resume.user_id = agent_runs.original_owner_user_id
				AND resume.user_id = emdo.current_user_id()
				AND resume.state = 'claimed'
				AND resume.decision_id IS NOT NULL
				AND resume.decision_type IN ('approved', 'rejected')
				AND resume.approval_event_sequence IS NOT NULL
				AND resume.claim_id IS NOT NULL
				AND resume.ownership_token_digest ~ '^[a-f0-9]{64}$'
				AND resume.authenticated_session_id = emdo.current_session_id()
				AND resume.resume_request_id = emdo.current_request_id()
				AND resume.resume_space_access_grant_id IS NOT NULL
				AND resume.claimed_at IS NOT NULL
				AND resume.terminal_event_sequence IS NULL
				AND resume.terminal_reason_code IS NULL
				AND resume.terminal_result_hash IS NULL
		)
	);

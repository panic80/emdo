CREATE OR REPLACE FUNCTION "emdo"."complete_manager_turn"(
	p_operation_id uuid,
	p_operation_hash text,
	p_claim_id uuid,
	p_ownership_token_hash text,
	p_run_id uuid,
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
	v_turn emdo.manager_turns%ROWTYPE;
	v_run emdo.agent_runs%ROWTYPE;
	v_operation emdo.manager_turn_operations%ROWTYPE;
	v_checkpoint emdo.approval_checkpoints%ROWTYPE;
	v_proposal emdo.action_proposals%ROWTYPE;
	v_proposal_state emdo.proposal_states%ROWTYPE;
	v_preparation emdo.proposal_preparations%ROWTYPE;
	v_disclosure emdo.disclosure_grants%ROWTYPE;
	v_interruption jsonb;
	v_result_hash text;
	v_expected_operation_hash text;
	v_public_result jsonb;
	v_status text;
	v_terminal_event_type text;
	v_next_sequence bigint;
	v_terminal_sequence bigint;
	v_now timestamptz;
	v_checkpoint_id uuid;
	v_proposal_id uuid;
	v_specialist_count integer;
BEGIN
	IF p_operation_id IS NULL
		OR p_operation_hash !~ '^[a-f0-9]{64}$'
		OR p_claim_id IS NULL
		OR p_ownership_token_hash !~ '^[a-f0-9]{64}$'
		OR p_run_id IS NULL
		OR pg_catalog.jsonb_typeof(p_result) IS DISTINCT FROM 'object'
		OR pg_catalog.octet_length(p_result::text) > 1400000
		OR NOT (p_result ?& ARRAY[
			'status', 'runId', 'localTraceReference',
			'specialistOutcomes', 'usage'
		]::text[])
		OR p_result ->> 'runId' IS DISTINCT FROM p_run_id::text
		OR p_result ->> 'status'
			NOT IN ('completed', 'needs-approval', 'failed')
		OR pg_catalog.jsonb_typeof(p_result -> 'specialistOutcomes')
			IS DISTINCT FROM 'array'
		OR pg_catalog.jsonb_array_length(p_result -> 'specialistOutcomes') > 64
	OR pg_catalog.jsonb_typeof(p_result -> 'usage')
			IS DISTINCT FROM 'object'
		OR (pg_catalog.length(p_result ->> 'localTraceReference')
			BETWEEN 1 AND 512) IS DISTINCT FROM true
		OR emdo.jsonb_object_has_exact_keys(
			p_result -> 'usage',
			CASE WHEN p_result -> 'usage' ? 'spendWarning' THEN ARRAY[
				'inputTokens', 'outputTokens', 'modelCostCadMinor', 'spendWarning'
			]::text[] ELSE ARRAY[
				'inputTokens', 'outputTokens', 'modelCostCadMinor'
			]::text[] END
		) IS DISTINCT FROM true
		OR pg_catalog.jsonb_typeof(p_result #> '{usage,inputTokens}')
			IS DISTINCT FROM 'number'
		OR pg_catalog.jsonb_typeof(p_result #> '{usage,outputTokens}')
			IS DISTINCT FROM 'number'
		OR pg_catalog.jsonb_typeof(p_result #> '{usage,modelCostCadMinor}')
			IS DISTINCT FROM 'number'
		OR (
			p_result -> 'usage' ? 'spendWarning'
			AND p_result -> 'usage' -> 'spendWarning'
				IS DISTINCT FROM 'true'::jsonb
		)
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	v_status := p_result ->> 'status';
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.jsonb_array_elements(
			p_result -> 'specialistOutcomes'
		) AS outcome(value)
		WHERE pg_catalog.jsonb_typeof(outcome.value) <> 'object'
			OR NOT (outcome.value ?& ARRAY[
				'delegationId', 'specialistId', 'status', 'usage'
			]::text[])
			OR (outcome.value ->> 'status'
				IN ('completed', 'failed', 'blocked')) IS DISTINCT FROM true
			OR (pg_catalog.length(outcome.value ->> 'delegationId')
				BETWEEN 1 AND 200) IS DISTINCT FROM true
			OR (pg_catalog.length(outcome.value ->> 'specialistId')
				BETWEEN 1 AND 200) IS DISTINCT FROM true
			OR pg_catalog.jsonb_typeof(outcome.value -> 'usage') <> 'object'
	) THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	IF (
		v_status = 'completed'
		AND NOT (
			(
				emdo.jsonb_object_has_exact_keys(
					p_result,
					ARRAY[
						'status', 'runId', 'localTraceReference', 'output',
						'specialistOutcomes', 'hasPartialFailures', 'usage',
						'modelResolution'
					]::text[]
				)
				AND pg_catalog.jsonb_typeof(p_result -> 'hasPartialFailures') = 'boolean'
				AND pg_catalog.jsonb_typeof(p_result -> 'modelResolution') = 'object'
				AND p_result #>> '{modelResolution,status}' = 'resolved'
			) OR (
				emdo.jsonb_object_has_exact_keys(
					p_result,
					ARRAY[
						'status', 'runId', 'localTraceReference', 'output',
						'specialistOutcomes', 'hasPartialFailures', 'usage',
						'executionResolution'
					]::text[]
				)
				AND pg_catalog.jsonb_typeof(p_result -> 'hasPartialFailures') = 'boolean'
				AND emdo.jsonb_object_has_exact_keys(
					p_result -> 'executionResolution',
					ARRAY['status', 'profile', 'reason']::text[]
				)
				AND p_result #>> '{executionResolution,status}' = 'provider-free'
				AND p_result #>> '{executionResolution,profile}' = 'shopping-list-v1'
				AND p_result #>> '{executionResolution,reason}' = 'provider-free-mvp'
			)
		)
	) OR (
		v_status = 'needs-approval'
		AND (
			NOT emdo.jsonb_object_has_exact_keys(
				p_result,
				ARRAY[
					'status', 'runId', 'localTraceReference', 'checkpoint',
					'interruptions', 'specialistOutcomes', 'usage',
					'modelResolution'
				]::text[]
			)
			OR pg_catalog.jsonb_typeof(p_result -> 'checkpoint')
				IS DISTINCT FROM 'object'
			OR pg_catalog.jsonb_typeof(p_result -> 'interruptions')
				IS DISTINCT FROM 'array'
			OR pg_catalog.jsonb_array_length(p_result -> 'interruptions') <> 1
			OR pg_catalog.jsonb_typeof(p_result -> 'modelResolution')
				IS DISTINCT FROM 'object'
			OR p_result #>> '{modelResolution,status}'
				IS DISTINCT FROM 'resolved'
		)
	) OR (
		v_status = 'failed'
		AND (
			NOT (p_result ? 'safeError')
			OR p_result - ARRAY[
				'status', 'runId', 'localTraceReference', 'safeError',
				'specialistOutcomes', 'usage', 'modelResolution'
			]::text[] <> '{}'::jsonb
			OR pg_catalog.jsonb_typeof(p_result -> 'safeError')
				IS DISTINCT FROM 'object'
		)
	) THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;

	v_result_hash := emdo.canonical_json_hash(p_result);
	v_expected_operation_hash := emdo.canonical_json_hash(
		pg_catalog.jsonb_build_object(
			'domain', 'emdo.manager-turn-operation.v1',
			'kind', 'complete',
			'operationId', p_operation_id,
			'claimId', p_claim_id,
			'ownershipTokenHash', p_ownership_token_hash,
			'runId', p_run_id,
			'resultHash', v_result_hash
		)
	);
	IF p_operation_hash IS DISTINCT FROM v_expected_operation_hash THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	SELECT operation.* INTO v_operation
	FROM emdo.manager_turn_operations AS operation
	WHERE operation.operation_id = p_operation_id;
	IF FOUND THEN
		RETURN CASE WHEN
			v_operation.run_id = p_run_id
			AND v_operation.operation_kind = 'complete'
			AND v_operation.operation_hash = p_operation_hash
			AND v_operation.request_claim_id = p_claim_id
			AND v_operation.request_ownership_token_hash =
				p_ownership_token_hash
			AND v_operation.result_hash = v_result_hash
		THEN v_operation.stored_result
		ELSE pg_catalog.jsonb_build_object('status', 'conflict') END;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(p_claim_id::text, 0)
	);
	SELECT turn.* INTO v_turn
	FROM emdo.manager_turns AS turn
	WHERE turn.run_id = p_run_id
	FOR UPDATE OF turn;
	IF NOT FOUND THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	IF v_turn.claim_id IS DISTINCT FROM p_claim_id
		OR v_turn.ownership_token_hash IS DISTINCT FROM p_ownership_token_hash
	THEN
		RETURN emdo.record_manager_turn_operation(
			p_operation_id, p_run_id, 'complete', p_operation_hash,
			p_claim_id, p_ownership_token_hash, v_result_hash,
			pg_catalog.jsonb_build_object('status', 'conflict')
		);
	END IF;
	IF v_turn.state <> 'claimed' THEN
		v_public_result := CASE WHEN
			v_turn.state <> 'indeterminate'
			AND v_turn.result_hash = v_result_hash
			AND v_turn.result = p_result
		THEN pg_catalog.jsonb_build_object(
			'status', 'replay',
			'terminalEventSequence', v_turn.terminal_event_sequence
		)
		ELSE pg_catalog.jsonb_build_object('status', 'conflict') END;
		RETURN emdo.record_manager_turn_operation(
			p_operation_id, p_run_id, 'complete', p_operation_hash,
			p_claim_id, p_ownership_token_hash, v_result_hash, v_public_result
		);
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(p_run_id::text, 0)
	);
	SELECT run.* INTO v_run
	FROM emdo.agent_runs AS run
	WHERE run.id = p_run_id
		AND run.household_id = v_turn.household_id
		AND run.space_id = v_turn.space_id
		AND run.original_owner_user_id = v_turn.user_id
	FOR UPDATE OF run;
	IF NOT FOUND OR v_run.status IS DISTINCT FROM 'running' THEN
		RETURN emdo.record_manager_turn_operation(
			p_operation_id, p_run_id, 'complete', p_operation_hash,
			p_claim_id, p_ownership_token_hash, v_result_hash,
			pg_catalog.jsonb_build_object('status', 'conflict')
		);
	END IF;
	SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
	INTO v_next_sequence
	FROM emdo.agent_run_events AS event
	WHERE event.run_id = p_run_id;
	v_specialist_count := pg_catalog.jsonb_array_length(
		p_result -> 'specialistOutcomes'
	);
	v_now := pg_catalog.clock_timestamp();
	INSERT INTO emdo.agent_run_events(
		household_id, space_id, original_owner_user_id, run_id,
		sequence, event_type, payload, occurred_at, retain_until
	)
	SELECT v_turn.household_id, v_turn.space_id, v_turn.user_id,
		v_turn.run_id, v_next_sequence + outcome.ordinality - 1,
		'specialist.' || COALESCE(outcome.value ->> 'status', 'failed'),
		outcome.value, v_now, v_now + interval '90 days'
	FROM pg_catalog.jsonb_array_elements(p_result -> 'specialistOutcomes')
		WITH ORDINALITY AS outcome(value, ordinality)
	ORDER BY outcome.ordinality;
	v_terminal_sequence := v_next_sequence + v_specialist_count;
	v_terminal_event_type := CASE v_status
		WHEN 'completed' THEN 'run.completed'
		WHEN 'failed' THEN 'run.failed'
		ELSE 'approval.required'
	END;
	INSERT INTO emdo.agent_run_events(
		household_id, space_id, original_owner_user_id, run_id,
		sequence, event_type, payload, occurred_at, retain_until
	) VALUES (
		v_turn.household_id, v_turn.space_id, v_turn.user_id,
		v_turn.run_id, v_terminal_sequence, v_terminal_event_type,
		p_result, v_now, v_now + interval '90 days'
	);

	IF v_status = 'needs-approval' THEN
		v_interruption := p_result -> 'interruptions' -> 0;
		IF NOT emdo.jsonb_object_has_exact_keys(
				v_interruption,
				ARRAY[
					'id', 'agentId', 'capabilityId', 'proposalId',
					'argumentsPreview'
				]::text[]
			)
			OR NOT emdo.jsonb_object_has_exact_keys(
				p_result -> 'checkpoint',
				ARRAY[
					'checkpointId', 'householdId', 'userId', 'runId',
					'agentGraphHash', 'sdkVersion', 'formatVersion',
					'revision', 'state', 'createdAt', 'expiresAt', 'updatedAt'
				]::text[]
			)
			OR p_result #>> '{checkpoint,householdId}'
				IS DISTINCT FROM v_turn.household_id::text
			OR p_result #>> '{checkpoint,userId}'
				IS DISTINCT FROM v_turn.user_id::text
			OR p_result #>> '{checkpoint,runId}'
				IS DISTINCT FROM v_turn.run_id::text
			OR p_result #>> '{checkpoint,state}' IS DISTINCT FROM 'pending'
			OR p_result #>> '{checkpoint,formatVersion}' IS DISTINCT FROM '1'
			OR p_result #>> '{checkpoint,revision}' IS DISTINCT FROM '1'
		THEN
			RAISE EXCEPTION USING
				ERRCODE = 'P0001', MESSAGE = 'invalid approval result binding';
		END IF;
		v_checkpoint_id := (p_result #>> '{checkpoint,checkpointId}')::uuid;
		v_proposal_id := (v_interruption ->> 'proposalId')::uuid;

		SELECT checkpoint.* INTO v_checkpoint
		FROM emdo.approval_checkpoints AS checkpoint
		WHERE checkpoint.checkpoint_id = v_checkpoint_id
		FOR UPDATE OF checkpoint;
		SELECT proposal.* INTO v_proposal
		FROM emdo.action_proposals AS proposal
		WHERE proposal.id = v_proposal_id
		FOR UPDATE OF proposal;
		SELECT state.* INTO v_proposal_state
		FROM emdo.proposal_states AS state
		WHERE state.proposal_id = v_proposal_id
		FOR UPDATE OF state;
		SELECT preparation.* INTO v_preparation
		FROM emdo.proposal_preparations AS preparation
		WHERE preparation.proposal_id = v_proposal_id
		FOR UPDATE OF preparation;
		SELECT disclosure.* INTO v_disclosure
		FROM emdo.disclosure_grants AS disclosure
		WHERE disclosure.id = v_proposal.disclosure_grant_id
		FOR UPDATE OF disclosure;
		IF v_checkpoint.checkpoint_id IS NULL
			OR v_proposal.id IS NULL
			OR v_proposal_state.proposal_id IS NULL
			OR v_preparation.proposal_id IS NULL
			OR v_disclosure.id IS NULL
			OR v_checkpoint.household_id <> v_turn.household_id
			OR v_checkpoint.space_id <> v_turn.space_id
			OR v_checkpoint.user_id <> v_turn.user_id
			OR v_checkpoint.run_id <> v_turn.run_id
			OR v_checkpoint.state <> 'pending'
			OR v_checkpoint.format_version <> 1
			OR v_checkpoint.revision <> 1
			OR v_checkpoint.agent_graph_hash IS DISTINCT FROM
				p_result #>> '{checkpoint,agentGraphHash}'
			OR v_checkpoint.sdk_version IS DISTINCT FROM
				p_result #>> '{checkpoint,sdkVersion}'
			OR v_checkpoint.created_at IS DISTINCT FROM
				(p_result #>> '{checkpoint,createdAt}')::timestamptz
			OR v_checkpoint.expires_at IS DISTINCT FROM
				(p_result #>> '{checkpoint,expiresAt}')::timestamptz
			OR v_checkpoint.updated_at IS DISTINCT FROM
				(p_result #>> '{checkpoint,updatedAt}')::timestamptz
			OR v_checkpoint.expires_at <= v_now
			OR v_proposal.household_id <> v_turn.household_id
			OR v_proposal.space_id <> v_turn.space_id
			OR v_proposal.original_owner_user_id <> v_turn.user_id
			OR v_proposal.run_id <> v_turn.run_id
			OR v_proposal.capability_id IS DISTINCT FROM
				v_interruption ->> 'capabilityId'
			OR v_proposal.authorization_scope_fingerprint IS DISTINCT FROM
				v_turn.origin_operation_authorization_scope_fingerprint
			OR v_proposal.expires_at <= v_now
			OR v_proposal_state.state <> 'pending'
			OR v_preparation.abandonment_reason IS NOT NULL
			OR v_preparation.abandoned_at IS NOT NULL
			OR v_preparation.preparation_binding_hash IS DISTINCT FROM
				emdo.canonical_json_hash(pg_catalog.jsonb_build_object(
					'domain', 'emdo.provider-proposal-preparation.v1',
					'binding', v_preparation.preparation_binding
				))
			OR v_preparation.preparation_binding ->> 'proposalId'
				IS DISTINCT FROM v_proposal.id::text
			OR v_preparation.preparation_binding ->> 'runId'
				IS DISTINCT FROM v_turn.run_id::text
			OR v_preparation.preparation_binding ->> 'householdId'
				IS DISTINCT FROM v_turn.household_id::text
			OR v_preparation.preparation_binding ->> 'userId'
				IS DISTINCT FROM v_turn.user_id::text
			OR v_preparation.preparation_binding ->> 'originSessionId'
				IS DISTINCT FROM v_turn.origin_session_id::text
			OR v_preparation.preparation_binding ->> 'originRequestId'
				IS DISTINCT FROM v_turn.origin_request_id::text
			OR v_preparation.preparation_binding ->> 'originSpaceAccessGrantId'
				IS DISTINCT FROM v_turn.origin_space_access_grant_id::text
			OR v_preparation.preparation_binding ->> 'agentId'
				IS DISTINCT FROM v_interruption ->> 'agentId'
			OR v_preparation.preparation_binding ->> 'capabilityId'
				IS DISTINCT FROM v_interruption ->> 'capabilityId'
			OR v_preparation.preparation_binding ->> 'disclosurePolicyVersion'
				!~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
			OR v_disclosure.schema_version <> 1
			OR v_disclosure.household_id <> v_turn.household_id
			OR v_disclosure.space_id <> v_turn.space_id
			OR v_disclosure.user_id <> v_turn.user_id
			OR v_disclosure.run_id <> v_turn.run_id
			OR v_disclosure.id <> v_proposal.disclosure_grant_id
			OR v_disclosure.id::text IS DISTINCT FROM
				v_preparation.preparation_binding ->> 'disclosureGrantId'
			OR v_disclosure.revoked_at IS NOT NULL
			OR v_disclosure.expires_at <= v_now
			OR v_proposal.disclosure_grant ->> 'id'
				IS DISTINCT FROM v_disclosure.id::text
			OR v_proposal.disclosure_grant ->> 'version'
				IS DISTINCT FROM v_disclosure.version::text
		THEN
			RAISE EXCEPTION USING
				ERRCODE = 'P0001', MESSAGE = 'approval staging binding mismatch';
		END IF;

		INSERT INTO emdo.approval_resume_jobs(
			job_id, household_id, space_id, user_id, run_id,
			conversation_id, checkpoint_id, interruption_id, proposal_id,
			capability_id, origin_session_id, origin_turn_request_id,
			origin_space_access_grant_id, authorization_scope_fingerprint,
			disclosure_grant_id, disclosure_grant_version,
			disclosure_policy_version, payload_hash, approval_hash,
			approval_event_sequence, state, revision, claim_id,
			ownership_token_digest, decision_id, decision_type,
			authenticated_session_id, resume_request_id,
			resume_space_access_grant_id,
			collection_authorization_scope_fingerprint, claimed_at,
			claim_expires_at, terminal_event_sequence, terminal_reason_code,
			terminal_result_hash, created_at, updated_at, expires_at,
			retain_until
		) VALUES (
			pg_catalog.gen_random_uuid(), v_turn.household_id, v_turn.space_id,
			v_turn.user_id, v_turn.run_id, v_turn.conversation_id,
			v_checkpoint.checkpoint_id, v_interruption ->> 'id',
			v_proposal.id, v_proposal.capability_id,
			v_turn.origin_session_id, v_turn.origin_request_id,
			v_turn.origin_space_access_grant_id,
			v_turn.origin_operation_authorization_scope_fingerprint,
			v_disclosure.id, v_disclosure.version,
			v_preparation.preparation_binding ->> 'disclosurePolicyVersion',
			v_proposal.payload_hash, v_proposal.approval_hash,
			v_terminal_sequence, 'awaiting-decision', 1, NULL, NULL,
			NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
			NULL,
			v_now, v_now,
			least(
				v_checkpoint.expires_at,
				v_proposal.expires_at,
				v_disclosure.expires_at,
				v_now + interval '10 minutes'
			),
			v_now + interval '90 days'
		);
	END IF;

	UPDATE emdo.manager_turns AS turn
	SET state = v_status, revision = turn.revision + 1,
		result = p_result, result_hash = v_result_hash,
		terminal_event_sequence = v_terminal_sequence,
		approval_checkpoint_id = CASE WHEN v_status = 'needs-approval'
			THEN v_checkpoint_id ELSE NULL END,
		updated_at = v_now
	WHERE turn.run_id = p_run_id
		AND turn.revision = v_turn.revision
		AND turn.state = 'claimed';
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001', MESSAGE = 'manager turn completion CAS failed';
	END IF;
	UPDATE emdo.agent_runs AS run
	SET status = CASE v_status
			WHEN 'completed' THEN 'completed'
			WHEN 'failed' THEN 'failed'
			ELSE 'blocked'
		END,
		resolved_model = p_result #>> '{modelResolution,resolvedModel}',
		model_reason = COALESCE(
			p_result #>> '{modelResolution,reason}',
			p_result #>> '{executionResolution,reason}'
		),
		local_trace_reference = p_result ->> 'localTraceReference',
		safe_error = CASE WHEN v_status = 'failed'
			THEN p_result -> 'safeError' ELSE NULL END,
		usage = p_result -> 'usage',
		completed_at = CASE WHEN v_status = 'needs-approval'
			THEN NULL ELSE v_now END
	WHERE run.id = p_run_id
		AND run.status = 'running';
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001', MESSAGE = 'manager run completion CAS failed';
	END IF;
	v_public_result := pg_catalog.jsonb_build_object(
		'status', 'completed',
		'terminalEventSequence', v_terminal_sequence
	);
	RETURN emdo.record_manager_turn_operation(
		p_operation_id, p_run_id, 'complete', p_operation_hash,
		p_claim_id, p_ownership_token_hash, v_result_hash, v_public_result
	);
EXCEPTION
	WHEN data_exception OR integrity_constraint_violation OR raise_exception THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
END
$function$;
--> statement-breakpoint
GRANT UPDATE (checkpoint_id) ON emdo.approval_checkpoints TO emdo_manager_turn_executor;
--> statement-breakpoint
GRANT UPDATE (id) ON emdo.action_proposals TO emdo_manager_turn_executor;
--> statement-breakpoint
GRANT UPDATE (proposal_id) ON emdo.proposal_states TO emdo_manager_turn_executor;
--> statement-breakpoint
GRANT UPDATE (proposal_id) ON emdo.proposal_preparations TO emdo_manager_turn_executor;
--> statement-breakpoint
GRANT UPDATE (id) ON emdo.disclosure_grants TO emdo_manager_turn_executor;
--> statement-breakpoint
CREATE POLICY manager_turn_checkpoints_update
ON emdo.approval_checkpoints
FOR UPDATE TO emdo_manager_turn_executor
USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY manager_turn_proposals_update
ON emdo.action_proposals
FOR UPDATE TO emdo_manager_turn_executor
USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY manager_turn_proposal_states_update
ON emdo.proposal_states
FOR UPDATE TO emdo_manager_turn_executor
USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY manager_turn_preparations_update
ON emdo.proposal_preparations
FOR UPDATE TO emdo_manager_turn_executor
USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY manager_turn_disclosures_update
ON emdo.disclosure_grants
FOR UPDATE TO emdo_manager_turn_executor
USING (true) WITH CHECK (true);

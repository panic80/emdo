-- Astra is the only model selected by the application. Preserve historic model
-- provenance and existing proposal/grant authority; never rewrite settled rows.
ALTER TABLE "emdo"."finance_document_extractions" DROP CONSTRAINT "finance_document_extractions_model_check";
--> statement-breakpoint

ALTER TABLE "emdo"."finance_document_extractions" ADD CONSTRAINT "finance_document_extractions_model_check" CHECK (model IS NULL OR model IN ('gpt-5.6-terra', 'gpt-6-astra'));
--> statement-breakpoint

ALTER TABLE "emdo"."manager_turns" DROP CONSTRAINT "manager_turns_runtime_check";
--> statement-breakpoint

ALTER TABLE "emdo"."manager_turns" ADD CONSTRAINT "manager_turns_runtime_check" CHECK (length("emdo"."manager_turns"."manager_agent_version") between 5 and 64 and "emdo"."manager_turns"."manager_agent_version" ~ '^[0-9]+.[0-9]+.[0-9]+(-[0-9A-Za-z.-]+)?$' and "emdo"."manager_turns"."requested_model" in ('gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-6-astra', 'provider-free-mvp-v1') and "emdo"."manager_turns"."ownership_token_hash" ~ '^[a-f0-9]{64}$');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."claim_manager_turn"(
	p_operation_id uuid,
	p_operation_hash text,
	p_candidate_run_id uuid,
	p_candidate_conversation_id uuid,
	p_request_claim_id uuid,
	p_request_ownership_token_hash text,
	p_idempotency_key text,
	p_request jsonb,
	p_household_id uuid,
	p_space_access_grant_id uuid,
	p_role text,
	p_manager_agent_version text,
	p_requested_model text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_collection_scope record;
	v_operation_scope record;
	v_existing_operation emdo.manager_turn_operations%ROWTYPE;
	v_existing_turn emdo.manager_turns%ROWTYPE;
	v_request_hash text;
	v_expected_operation_hash text;
	v_result jsonb;
	v_now timestamptz;
BEGIN
	IF p_operation_id IS NULL
		OR p_operation_hash !~ '^[a-f0-9]{64}$'
		OR p_candidate_run_id IS NULL
		OR p_candidate_conversation_id IS NULL
		OR p_request_claim_id IS NULL
		OR p_request_ownership_token_hash !~ '^[a-f0-9]{64}$'
		OR pg_catalog.length(p_idempotency_key) NOT BETWEEN 16 AND 200
		OR p_idempotency_key !~ '^[A-Za-z0-9:._-]+$'
		OR pg_catalog.jsonb_typeof(p_request) IS DISTINCT FROM 'object'
		OR pg_catalog.octet_length(p_request::text) > 131072
		OR NOT (p_request ?& ARRAY[
			'schemaVersion', 'message', 'locale', 'rootManagerInvocationId'
		]::text[])
		OR p_request - ARRAY[
			'schemaVersion', 'conversationId', 'message', 'routeHint',
			'locale', 'rootManagerInvocationId'
		]::text[] <> '{}'::jsonb
		OR p_request -> 'schemaVersion' IS DISTINCT FROM '1'::jsonb
		OR pg_catalog.jsonb_typeof(p_request -> 'message')
			IS DISTINCT FROM 'string'
		OR pg_catalog.length(p_request ->> 'message') NOT BETWEEN 1 AND 16000
		OR pg_catalog.btrim(p_request ->> 'message')
			IS DISTINCT FROM p_request ->> 'message'
		OR p_request ->> 'locale' NOT IN ('en-CA', 'fr-CA', 'ja-JP', 'ko-KR')
		OR p_request ->> 'rootManagerInvocationId' !~
			'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		OR (
			p_request ? 'routeHint'
			AND p_request ->> 'routeHint'
				NOT IN ('scheduler', 'finance', 'shopping')
		)
		OR (
			p_request ? 'conversationId'
			AND p_request ->> 'conversationId'
				IS DISTINCT FROM p_candidate_conversation_id::text
		)
		OR p_household_id IS NULL
		OR p_space_access_grant_id IS NULL
		OR p_role NOT IN ('owner', 'member')
		OR pg_catalog.length(p_manager_agent_version) NOT BETWEEN 5 AND 64
		OR p_manager_agent_version
			!~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
		OR p_requested_model NOT IN (
			'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-6-astra', 'provider-free-mvp-v1'
		)
		OR emdo.current_user_id() IS NULL
		OR emdo.current_session_id() IS NULL
		OR emdo.current_request_id() IS NULL
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;

	SELECT scope.* INTO v_collection_scope
	FROM emdo.lock_current_authorization_scope(
		p_space_access_grant_id, NULL, NULL
	) AS scope;
	IF NOT FOUND
		OR v_collection_scope.user_id IS DISTINCT FROM emdo.current_user_id()
		OR v_collection_scope.session_id IS DISTINCT FROM
			emdo.current_session_id()
		OR v_collection_scope.request_id IS DISTINCT FROM
			emdo.current_request_id()
		OR v_collection_scope.household_id IS DISTINCT FROM p_household_id
		OR v_collection_scope.role IS DISTINCT FROM p_role
		OR v_collection_scope.proposal_space_id IS NOT NULL
		OR v_collection_scope.authorization_scope_fingerprint
			!~ '^[a-f0-9]{64}$'
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;

	v_request_hash := emdo.canonical_json_hash(p_request);
	v_expected_operation_hash := emdo.canonical_json_hash(
		pg_catalog.jsonb_build_object(
			'domain', 'emdo.manager-turn-operation.v1',
			'kind', 'claim',
			'operationId', p_operation_id,
			'candidateRunId', p_candidate_run_id,
			'candidateConversationId', p_candidate_conversation_id,
			'requestClaimId', p_request_claim_id,
			'requestOwnershipTokenHash', p_request_ownership_token_hash,
			'idempotencyKey', p_idempotency_key,
			'request', p_request,
			'householdId', p_household_id,
			'userId', emdo.current_user_id(),
			'sessionId', emdo.current_session_id(),
			'requestId', emdo.current_request_id(),
			'spaceAccessGrantId', p_space_access_grant_id,
			'role', p_role,
			'managerAgentVersion', p_manager_agent_version,
			'requestedModel', p_requested_model
		)
	);
	IF p_operation_hash IS DISTINCT FROM v_expected_operation_hash THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;

	SELECT operation.* INTO v_existing_operation
	FROM emdo.manager_turn_operations AS operation
	WHERE operation.operation_id = p_operation_id;
	IF FOUND THEN
		RETURN CASE WHEN
			v_existing_operation.operation_kind = 'claim'
			AND v_existing_operation.operation_hash = p_operation_hash
			AND v_existing_operation.request_claim_id = p_request_claim_id
			AND v_existing_operation.request_ownership_token_hash =
				p_request_ownership_token_hash
			AND v_existing_operation.household_id = p_household_id
			AND v_existing_operation.user_id = emdo.current_user_id()
		THEN v_existing_operation.stored_result
		ELSE pg_catalog.jsonb_build_object('status', 'conflict') END;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			p_household_id::text || ':' || emdo.current_user_id()::text || ':' ||
			p_idempotency_key,
			0
		)
	);
	SELECT turn.* INTO v_existing_turn
	FROM emdo.manager_turns AS turn
	WHERE turn.household_id = p_household_id
		AND turn.user_id = emdo.current_user_id()
		AND turn.idempotency_key = p_idempotency_key
	FOR UPDATE OF turn;
	IF FOUND THEN
		IF v_existing_turn.request_payload - 'rootManagerInvocationId'
				IS DISTINCT FROM p_request - 'rootManagerInvocationId'
			OR v_existing_turn.request_payload ->> 'rootManagerInvocationId' !~
				'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
			OR v_existing_turn.manager_agent_version IS DISTINCT FROM
				p_manager_agent_version
			OR v_existing_turn.requested_model IS DISTINCT FROM p_requested_model
		THEN
			v_result := pg_catalog.jsonb_build_object('status', 'conflict');
		ELSE
			v_result := pg_catalog.jsonb_build_object(
				'status', 'replay',
				'runId', v_existing_turn.run_id,
				'conversationId', v_existing_turn.conversation_id,
				'rootManagerInvocationId',
					v_existing_turn.request_payload ->> 'rootManagerInvocationId'
			);
		END IF;
		RETURN emdo.record_manager_turn_operation(
			p_operation_id, v_existing_turn.run_id, 'claim',
			p_operation_hash, p_request_claim_id,
			p_request_ownership_token_hash, NULL, v_result
		);
	END IF;

	v_now := pg_catalog.clock_timestamp();
	INSERT INTO emdo.agent_runs(
		id, household_id, space_id, original_owner_user_id, parent_run_id,
		agent_id, agent_version, requested_model, resolved_model,
		model_reason, status, local_trace_reference, safe_error, usage,
		created_at, completed_at, retain_until
	) VALUES (
		p_candidate_run_id, p_household_id,
		v_collection_scope.private_space_id, emdo.current_user_id(), NULL,
		'manager', p_manager_agent_version, p_requested_model, NULL,
		NULL, 'running', NULL, NULL, NULL, v_now, NULL,
		v_now + interval '90 days'
	);
	SELECT scope.* INTO v_operation_scope
	FROM emdo.lock_current_authorization_scope(
		p_space_access_grant_id, NULL, p_candidate_run_id
	) AS scope;
	IF NOT FOUND
		OR v_operation_scope.user_id IS DISTINCT FROM
			v_collection_scope.user_id
		OR v_operation_scope.session_id IS DISTINCT FROM
			v_collection_scope.session_id
		OR v_operation_scope.request_id IS DISTINCT FROM
			v_collection_scope.request_id
		OR v_operation_scope.household_id IS DISTINCT FROM p_household_id
		OR v_operation_scope.proposal_space_id IS DISTINCT FROM
			v_collection_scope.private_space_id
		OR v_operation_scope.authorization_scope_fingerprint
			!~ '^[a-f0-9]{64}$'
	THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001', MESSAGE = 'manager run scope derivation failed';
	END IF;

	INSERT INTO emdo.manager_turns(
		run_id, schema_version, household_id, space_id, user_id,
		conversation_id, origin_session_id, origin_request_id,
		origin_space_access_grant_id,
		origin_collection_authorization_scope_fingerprint,
		origin_operation_authorization_scope_fingerprint,
		idempotency_key, request_payload, request_hash,
		manager_agent_version, requested_model, claim_id,
		ownership_token_hash, state, revision, result, result_hash,
		terminal_event_sequence, reason_code, created_at, updated_at,
		retain_until
	) VALUES (
		p_candidate_run_id, 1, p_household_id,
		v_collection_scope.private_space_id, emdo.current_user_id(),
		p_candidate_conversation_id, emdo.current_session_id(),
		emdo.current_request_id(), p_space_access_grant_id,
		v_collection_scope.authorization_scope_fingerprint,
		v_operation_scope.authorization_scope_fingerprint,
		p_idempotency_key, p_request, v_request_hash,
		p_manager_agent_version, p_requested_model, p_request_claim_id,
		p_request_ownership_token_hash, 'claimed', 1, NULL, NULL,
		NULL, NULL, v_now, v_now, v_now + interval '90 days'
	);
	INSERT INTO emdo.agent_run_events(
		household_id, space_id, original_owner_user_id, run_id,
		sequence, event_type, payload, occurred_at, retain_until
	) VALUES (
		p_household_id, v_collection_scope.private_space_id,
		emdo.current_user_id(), p_candidate_run_id, 1, 'run.accepted',
		pg_catalog.jsonb_build_object(
			'schemaVersion', 1,
			'runId', p_candidate_run_id,
			'conversationId', p_candidate_conversation_id,
			'rootManagerInvocationId', p_request ->> 'rootManagerInvocationId',
			'requestHash', v_request_hash,
			'originCollectionAuthorizationScopeFingerprint',
				v_collection_scope.authorization_scope_fingerprint,
			'originOperationAuthorizationScopeFingerprint',
				v_operation_scope.authorization_scope_fingerprint
		),
		v_now, v_now + interval '90 days'
	);
	v_result := pg_catalog.jsonb_build_object(
		'status', 'claimed',
		'claimId', p_request_claim_id,
		'runId', p_candidate_run_id,
		'conversationId', p_candidate_conversation_id,
		'rootManagerInvocationId', p_request ->> 'rootManagerInvocationId',
		'authorizationScopeFingerprint',
			v_operation_scope.authorization_scope_fingerprint,
		'escalationTriggers', '[]'::jsonb
	);
	RETURN emdo.record_manager_turn_operation(
		p_operation_id, p_candidate_run_id, 'claim', p_operation_hash,
		p_request_claim_id, p_request_ownership_token_hash, NULL, v_result
	);
EXCEPTION
	WHEN data_exception OR integrity_constraint_violation OR raise_exception THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION emdo.claim_next_finance_document_extraction()
RETURNS TABLE (
	household_id uuid,
	space_id uuid,
	original_owner_user_id uuid,
	document_id uuid,
	extraction_revision integer,
	extraction_attempt smallint,
	storage_object_id text,
	mime_type text,
	byte_size bigint,
	page_count integer,
	image_width integer,
	image_height integer,
	plaintext_sha256 text,
	ciphertext_sha256 text,
	wrapped_data_key jsonb,
	key_version text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_document emdo.finance_documents%ROWTYPE;
	v_revision integer;
	v_attempt smallint;
BEGIN
	IF NOT pg_catalog.pg_try_advisory_xact_lock(
		pg_catalog.hashtext('emdo.finance.document.extraction.v1')
	) THEN
		RETURN;
	END IF;

	UPDATE emdo.finance_document_extractions AS extraction
	SET state = 'failed',
		safe_error_code = 'worker-lease-expired',
		completed_at = pg_catalog.clock_timestamp()
	FROM emdo.finance_documents AS document
	WHERE document.id = extraction.document_id
		AND document.household_id = extraction.household_id
		AND document.space_id = extraction.space_id
		AND document.original_owner_user_id = extraction.original_owner_user_id
		AND document.state = 'extracting'
		AND extraction.state = 'extracting'
		AND document.updated_at < pg_catalog.clock_timestamp() - interval '10 minutes';
	UPDATE emdo.finance_documents AS document
	SET state = 'failed', updated_at = pg_catalog.clock_timestamp()
	WHERE document.state = 'extracting'
		AND document.updated_at < pg_catalog.clock_timestamp() - interval '10 minutes'
		AND EXISTS (
			SELECT 1 FROM emdo.finance_document_extractions AS extraction
			WHERE extraction.document_id = document.id
				AND extraction.revision = document.extraction_revision
				AND extraction.state = 'failed'
		);

	IF EXISTS (
		SELECT 1 FROM emdo.finance_document_extractions
		WHERE state = 'extracting'
	) THEN
		RETURN;
	END IF;

	SELECT document.* INTO v_document
	FROM emdo.finance_documents AS document
	WHERE document.state = 'uploaded'
		OR (
			document.state = 'extracting'
			AND EXISTS (
				SELECT 1
				FROM emdo.finance_document_extractions AS queued
				WHERE queued.document_id = document.id
					AND queued.household_id = document.household_id
					AND queued.space_id = document.space_id
					AND queued.original_owner_user_id = document.original_owner_user_id
					AND queued.revision = document.extraction_revision
					AND queued.state = 'queued'
			)
		)
	ORDER BY CASE WHEN document.state = 'extracting' THEN 0 ELSE 1 END,
		document.created_at, document.id
	LIMIT 1
	FOR UPDATE SKIP LOCKED;
	IF NOT FOUND THEN RETURN; END IF;

	IF v_document.state = 'uploaded' THEN
		v_revision := COALESCE(v_document.extraction_revision, 1);
		v_attempt := 1;
		INSERT INTO emdo.finance_document_extractions (
			document_id, household_id, space_id, original_owner_user_id,
			revision, attempt, state, model
		) VALUES (
			v_document.id, v_document.household_id, v_document.space_id,
			v_document.original_owner_user_id, v_revision, v_attempt,
			'extracting', 'gpt-6-astra'
		)
		ON CONFLICT (document_id, revision) DO UPDATE
		SET state = 'extracting', model = 'gpt-6-astra',
			safe_error_code = NULL, completed_at = NULL
		WHERE emdo.finance_document_extractions.state = 'queued';
		IF NOT FOUND THEN RETURN; END IF;
	ELSE
		UPDATE emdo.finance_document_extractions AS extraction
		SET state = 'extracting', model = 'gpt-6-astra',
			safe_error_code = NULL, completed_at = NULL
		WHERE extraction.document_id = v_document.id
			AND extraction.revision = v_document.extraction_revision
			AND extraction.state = 'queued'
		RETURNING extraction.revision, extraction.attempt
		INTO v_revision, v_attempt;
		IF NOT FOUND THEN RETURN; END IF;
	END IF;

	UPDATE emdo.finance_documents
	SET state = 'extracting', extraction_revision = v_revision,
		updated_at = pg_catalog.clock_timestamp()
	WHERE id = v_document.id;

	RETURN QUERY SELECT v_document.household_id, v_document.space_id,
		v_document.original_owner_user_id, v_document.id, v_revision, v_attempt,
		v_document.storage_object_id, v_document.mime_type, v_document.byte_size,
		v_document.page_count, v_document.image_width, v_document.image_height,
		v_document.plaintext_sha256, v_document.ciphertext_sha256,
		v_document.wrapped_data_key, v_document.key_version;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."approval_resume_turn_result_is_valid"(
	p_result jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, emdo
AS $function$
DECLARE
	v_status text;
	v_usage jsonb;
	v_outcome jsonb;
	v_safe_error jsonb;
	v_model_resolution jsonb;
	v_input_tokens numeric;
	v_output_tokens numeric;
	v_model_cost_cad_minor numeric;
BEGIN
	IF p_result IS NULL
		OR pg_catalog.jsonb_typeof(p_result) IS DISTINCT FROM 'object'
		OR pg_catalog.octet_length(p_result::text) > 1400000
	THEN
		RETURN false;
	END IF;

	v_status := p_result ->> 'status';
	IF v_status = 'completed' THEN
		IF emdo.jsonb_object_has_exact_keys(
				p_result,
				ARRAY[
					'status', 'runId', 'localTraceReference', 'output',
					'specialistOutcomes', 'hasPartialFailures', 'usage',
					'modelResolution'
				]::text[]
			) IS DISTINCT FROM true
			OR pg_catalog.jsonb_typeof(
				p_result -> 'hasPartialFailures'
			) IS DISTINCT FROM 'boolean'
		THEN
			RETURN false;
		END IF;
	ELSIF v_status = 'failed' THEN
		IF emdo.jsonb_object_has_exact_keys(
				p_result,
				CASE WHEN p_result ? 'modelResolution' THEN ARRAY[
					'status', 'runId', 'localTraceReference', 'safeError',
					'specialistOutcomes', 'usage', 'modelResolution'
				]::text[] ELSE ARRAY[
					'status', 'runId', 'localTraceReference', 'safeError',
					'specialistOutcomes', 'usage'
				]::text[] END
			) IS DISTINCT FROM true
		THEN
			RETURN false;
		END IF;
	ELSE
		-- Approval resumes are terminal-only; nested approval is never valid.
		RETURN false;
	END IF;

	IF pg_catalog.jsonb_typeof(p_result -> 'runId') IS DISTINCT FROM 'string'
		OR p_result ->> 'runId' !~
			'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		OR pg_catalog.jsonb_typeof(
			p_result -> 'localTraceReference'
		) IS DISTINCT FROM 'string'
		OR (
			emdo.json_text_utf16_length(
				p_result ->> 'localTraceReference'
			) BETWEEN 1 AND 512
		) IS DISTINCT FROM true
		OR pg_catalog.btrim(p_result ->> 'localTraceReference')
			IS DISTINCT FROM p_result ->> 'localTraceReference'
		OR (p_result ->> 'localTraceReference') ~ '[[:cntrl:]]'
		OR pg_catalog.jsonb_typeof(
			p_result -> 'specialistOutcomes'
		) IS DISTINCT FROM 'array'
		OR pg_catalog.jsonb_array_length(
			p_result -> 'specialistOutcomes'
		) > 128
	THEN
		RETURN false;
	END IF;

	FOR v_outcome IN
		SELECT value FROM pg_catalog.jsonb_array_elements(
			p_result -> 'specialistOutcomes'
		)
	LOOP
		IF emdo.registered_specialist_outcome_is_valid(v_outcome)
			IS DISTINCT FROM true
		THEN
			RETURN false;
		END IF;
	END LOOP;

	FOR v_safe_error IN
		SELECT p_result -> 'safeError'
		WHERE p_result ? 'safeError'
		UNION ALL
		SELECT (p_result -> 'modelResolution') -> 'safeError'
		WHERE p_result ? 'modelResolution'
			AND (p_result -> 'modelResolution') ? 'safeError'
	LOOP
		IF pg_catalog.jsonb_typeof(v_safe_error) IS DISTINCT FROM 'object'
			OR emdo.jsonb_object_has_exact_keys(
				v_safe_error, ARRAY['code', 'message', 'retryable']::text[]
			) IS DISTINCT FROM true
			OR pg_catalog.jsonb_typeof(
				v_safe_error -> 'code'
			) IS DISTINCT FROM 'string'
			OR (
				emdo.json_text_utf16_length(v_safe_error ->> 'code')
				BETWEEN 1 AND 256
			) IS DISTINCT FROM true
			OR pg_catalog.btrim(v_safe_error ->> 'code')
				IS DISTINCT FROM v_safe_error ->> 'code'
			OR (v_safe_error ->> 'code') ~ '[[:cntrl:]]'
			OR pg_catalog.jsonb_typeof(
				v_safe_error -> 'message'
			) IS DISTINCT FROM 'string'
			OR (
				emdo.json_text_utf16_length(v_safe_error ->> 'message')
				BETWEEN 1 AND 4096
			) IS DISTINCT FROM true
			OR pg_catalog.btrim(v_safe_error ->> 'message')
				IS DISTINCT FROM v_safe_error ->> 'message'
			OR (v_safe_error ->> 'message') ~ '[[:cntrl:]]'
			OR pg_catalog.jsonb_typeof(
				v_safe_error -> 'retryable'
			) IS DISTINCT FROM 'boolean'
		THEN
			RETURN false;
		END IF;
	END LOOP;

	FOR v_usage IN
		SELECT p_result -> 'usage'
		UNION ALL
		SELECT outcome.value -> 'usage'
		FROM pg_catalog.jsonb_array_elements(
			p_result -> 'specialistOutcomes'
		) AS outcome(value)
	LOOP
		IF pg_catalog.jsonb_typeof(v_usage) IS DISTINCT FROM 'object'
			OR emdo.jsonb_object_has_exact_keys(
				v_usage,
				CASE WHEN v_usage ? 'spendWarning' THEN ARRAY[
					'inputTokens', 'outputTokens', 'modelCostCadMinor', 'spendWarning'
				]::text[] ELSE ARRAY[
					'inputTokens', 'outputTokens', 'modelCostCadMinor'
				]::text[] END
			) IS DISTINCT FROM true
			OR pg_catalog.jsonb_typeof(
				v_usage -> 'inputTokens'
			) IS DISTINCT FROM 'number'
			OR pg_catalog.jsonb_typeof(
				v_usage -> 'outputTokens'
			) IS DISTINCT FROM 'number'
			OR pg_catalog.jsonb_typeof(
				v_usage -> 'modelCostCadMinor'
			) IS DISTINCT FROM 'number'
			OR pg_catalog.octet_length(v_usage ->> 'inputTokens') NOT BETWEEN 1 AND 64
			OR pg_catalog.octet_length(v_usage ->> 'outputTokens') NOT BETWEEN 1 AND 64
			OR pg_catalog.octet_length(
				v_usage ->> 'modelCostCadMinor'
			) NOT BETWEEN 1 AND 64
			OR (
				v_usage ? 'spendWarning'
				AND v_usage -> 'spendWarning' IS DISTINCT FROM 'true'::jsonb
			)
		THEN
			RETURN false;
		END IF;

		BEGIN
			v_input_tokens := (v_usage ->> 'inputTokens')::numeric;
			v_output_tokens := (v_usage ->> 'outputTokens')::numeric;
			v_model_cost_cad_minor :=
				(v_usage ->> 'modelCostCadMinor')::numeric;
		EXCEPTION
			WHEN data_exception THEN
				RETURN false;
		END;
		IF v_input_tokens < 0
			OR v_input_tokens > 9007199254740991::numeric
			OR v_input_tokens <> pg_catalog.trunc(v_input_tokens)
			OR v_output_tokens < 0
			OR v_output_tokens > 9007199254740991::numeric
			OR v_output_tokens <> pg_catalog.trunc(v_output_tokens)
			OR v_model_cost_cad_minor < 0
			OR v_model_cost_cad_minor > 9007199254740991::numeric
			OR v_model_cost_cad_minor <> pg_catalog.trunc(
				v_model_cost_cad_minor
			)
		THEN
			RETURN false;
		END IF;
	END LOOP;

	v_model_resolution := p_result -> 'modelResolution';
	IF v_model_resolution ->> 'requestedModel' = 'gpt-6-astra' THEN
		-- New Astra resolutions have one configured model and no legacy fallback.
		IF (
			(
				emdo.jsonb_object_has_exact_keys(v_model_resolution,
					ARRAY['status', 'requestedModel', 'resolvedModel', 'reason']::text[])
				AND v_model_resolution ->> 'status' = 'resolved'
				AND v_model_resolution ->> 'resolvedModel' = 'gpt-6-astra'
				AND v_model_resolution ->> 'reason' IN (
					'default', 'dependent-cross-domain', 'failed-output-validation',
					'low-confidence-reconciliation', 'complex-reasoning',
					'model-execution-failed'
				)
			) OR (
				v_status <> 'completed'
				AND v_model_resolution ->> 'status' = 'unavailable'
				AND (
					(
						emdo.jsonb_object_has_exact_keys(v_model_resolution,
							ARRAY['status', 'requestedModel', 'attemptedModels', 'reason', 'safeError']::text[])
						AND v_model_resolution -> 'attemptedModels' = '["gpt-6-astra"]'::jsonb
						AND v_model_resolution ->> 'reason' = 'no-configured-model-available'
						AND v_model_resolution -> 'safeError' = '{"code":"agent-model-unavailable","message":"AI is temporarily unavailable. Local features still work.","retryable":true}'::jsonb
					) OR (
						emdo.jsonb_object_has_exact_keys(v_model_resolution,
							ARRAY['status', 'requestedModel', 'attemptedModels', 'reason', 'escalationTrigger', 'safeError']::text[])
						AND v_model_resolution ->> 'escalationTrigger' IN (
							'dependent-cross-domain', 'failed-output-validation',
							'low-confidence-reconciliation', 'complex-reasoning',
							'model-execution-failed'
						)
						AND (
							(
								v_model_resolution -> 'attemptedModels' = '["gpt-6-astra"]'::jsonb
								AND v_model_resolution ->> 'reason' = 'required-complex-model-unavailable'
								AND v_model_resolution -> 'safeError' = '{"code":"required-agent-model-unavailable","message":"The model required to complete this request safely is temporarily unavailable.","retryable":true}'::jsonb
							) OR (
								v_model_resolution -> 'attemptedModels' = '[]'::jsonb
								AND v_model_resolution ->> 'reason' = 'configured-model-escalation-not-allowed'
								AND v_model_resolution -> 'safeError' = '{"code":"agent-model-escalation-not-allowed","message":"The active agent policy does not allow the required model escalation.","retryable":false}'::jsonb
							)
						)
					)
				)
			)
		) IS DISTINCT FROM true THEN
			RETURN false;
		END IF;
	ELSIF v_status = 'completed' THEN
		IF pg_catalog.jsonb_typeof(v_model_resolution) IS DISTINCT FROM 'object'
			OR (
				(
					emdo.jsonb_object_has_exact_keys(
						v_model_resolution,
						ARRAY[
							'status', 'requestedModel', 'resolvedModel', 'reason'
						]::text[]
						)
						AND v_model_resolution ->> 'status' = 'resolved'
						AND v_model_resolution ->> 'requestedModel' IN (
							'gpt-5.6-luna', 'gpt-5.6-terra'
						)
						AND v_model_resolution ->> 'resolvedModel' IN (
							'gpt-5.6-luna', 'gpt-5.6-terra'
						)
						AND v_model_resolution ->> 'reason' IN (
							'default', 'dependent-cross-domain',
							'failed-output-validation',
							'low-confidence-reconciliation', 'complex-reasoning',
							'luna-unavailable'
						)
					) OR (
						emdo.jsonb_object_has_exact_keys(
						v_model_resolution,
						ARRAY[
							'status', 'requestedModel', 'resolvedModel', 'reason',
							'escalationTrigger'
						]::text[]
						)
						AND v_model_resolution ->> 'status' = 'resolved'
						AND v_model_resolution ->> 'requestedModel' = 'gpt-5.6-terra'
						AND v_model_resolution ->> 'resolvedModel' = 'gpt-5.6-luna'
						AND v_model_resolution ->> 'reason' = 'terra-unavailable'
						AND v_model_resolution ->> 'escalationTrigger' =
							'complex-reasoning'
					)
				) IS DISTINCT FROM true
		THEN
			RETURN false;
		END IF;
	ELSIF p_result ? 'modelResolution' THEN
		IF pg_catalog.jsonb_typeof(v_model_resolution) IS DISTINCT FROM 'object'
			OR (
				(
					emdo.jsonb_object_has_exact_keys(
						v_model_resolution,
						ARRAY[
							'status', 'requestedModel', 'resolvedModel', 'reason'
						]::text[]
						)
						AND v_model_resolution ->> 'status' = 'resolved'
						AND v_model_resolution ->> 'requestedModel' IN (
							'gpt-5.6-luna', 'gpt-5.6-terra'
						)
						AND v_model_resolution ->> 'resolvedModel' IN (
							'gpt-5.6-luna', 'gpt-5.6-terra'
						)
						AND v_model_resolution ->> 'reason' IN (
							'default', 'dependent-cross-domain',
							'failed-output-validation',
							'low-confidence-reconciliation', 'complex-reasoning',
							'luna-unavailable'
						)
					) OR (
						emdo.jsonb_object_has_exact_keys(
						v_model_resolution,
						ARRAY[
							'status', 'requestedModel', 'resolvedModel', 'reason',
							'escalationTrigger'
						]::text[]
						)
						AND v_model_resolution ->> 'status' = 'resolved'
						AND v_model_resolution ->> 'requestedModel' = 'gpt-5.6-terra'
						AND v_model_resolution ->> 'resolvedModel' = 'gpt-5.6-luna'
						AND v_model_resolution ->> 'reason' = 'terra-unavailable'
						AND v_model_resolution ->> 'escalationTrigger' =
							'complex-reasoning'
					) OR (
						emdo.jsonb_object_has_exact_keys(
						v_model_resolution,
						ARRAY[
							'status', 'requestedModel', 'attemptedModels', 'reason',
							'safeError'
						]::text[]
						)
						AND v_model_resolution ->> 'status' = 'unavailable'
						AND v_model_resolution ->> 'requestedModel' IN (
							'gpt-5.6-luna', 'gpt-5.6-terra'
						)
						AND pg_catalog.jsonb_typeof(
							v_model_resolution -> 'attemptedModels'
						) = 'array'
						AND pg_catalog.jsonb_array_length(
							v_model_resolution -> 'attemptedModels'
						) = 2
						AND v_model_resolution #>> '{attemptedModels,0}' =
							v_model_resolution ->> 'requestedModel'
						AND v_model_resolution #>> '{attemptedModels,0}' IN (
							'gpt-5.6-luna', 'gpt-5.6-terra'
						)
						AND v_model_resolution #>> '{attemptedModels,1}' IN (
							'gpt-5.6-luna', 'gpt-5.6-terra'
						)
						AND v_model_resolution #>> '{attemptedModels,0}' IS DISTINCT FROM
							v_model_resolution #>> '{attemptedModels,1}'
						AND v_model_resolution ->> 'reason' =
							'no-configured-model-available'
						AND emdo.jsonb_object_has_exact_keys(
							v_model_resolution -> 'safeError',
							ARRAY['code', 'message', 'retryable']::text[]
						)
						AND v_model_resolution #>> '{safeError,code}' =
							'agent-model-unavailable'
						AND v_model_resolution #>> '{safeError,message}' =
							'AI is temporarily unavailable. Local features still work.'
						AND v_model_resolution #> '{safeError,retryable}' =
							'true'::jsonb
					) OR (
						emdo.jsonb_object_has_exact_keys(
						v_model_resolution,
						ARRAY[
							'status', 'requestedModel', 'attemptedModels', 'reason',
							'escalationTrigger', 'safeError'
						]::text[]
						)
						AND v_model_resolution ->> 'status' = 'unavailable'
						AND v_model_resolution ->> 'requestedModel' = 'gpt-5.6-terra'
						AND pg_catalog.jsonb_typeof(
							v_model_resolution -> 'attemptedModels'
						) = 'array'
						AND pg_catalog.jsonb_array_length(
							v_model_resolution -> 'attemptedModels'
						) = 1
						AND v_model_resolution #>> '{attemptedModels,0}' =
							'gpt-5.6-terra'
						AND v_model_resolution ->> 'reason' =
							'required-complex-model-unavailable'
						AND v_model_resolution ->> 'escalationTrigger' IN (
							'dependent-cross-domain',
							'failed-output-validation',
							'low-confidence-reconciliation', 'luna-unavailable'
						)
						AND emdo.jsonb_object_has_exact_keys(
							v_model_resolution -> 'safeError',
							ARRAY['code', 'message', 'retryable']::text[]
						)
						AND v_model_resolution #>> '{safeError,code}' =
							'required-agent-model-unavailable'
						AND v_model_resolution #>> '{safeError,message}' =
							'The model required to complete this request safely is temporarily unavailable.'
						AND v_model_resolution #> '{safeError,retryable}' =
							'true'::jsonb
					) OR (
						emdo.jsonb_object_has_exact_keys(
						v_model_resolution,
						ARRAY[
							'status', 'requestedModel', 'attemptedModels', 'reason',
							'escalationTrigger', 'safeError'
						]::text[]
						)
						AND v_model_resolution ->> 'status' = 'unavailable'
						AND v_model_resolution ->> 'requestedModel' = 'gpt-5.6-terra'
						AND pg_catalog.jsonb_typeof(
							v_model_resolution -> 'attemptedModels'
						) = 'array'
						AND pg_catalog.jsonb_array_length(
							v_model_resolution -> 'attemptedModels'
						) = 0
						AND v_model_resolution ->> 'reason' =
							'configured-model-escalation-not-allowed'
						AND v_model_resolution ->> 'escalationTrigger' IN (
							'dependent-cross-domain',
							'failed-output-validation',
							'low-confidence-reconciliation', 'luna-unavailable',
							'complex-reasoning'
						)
						AND emdo.jsonb_object_has_exact_keys(
							v_model_resolution -> 'safeError',
							ARRAY['code', 'message', 'retryable']::text[]
						)
						AND v_model_resolution #>> '{safeError,code}' =
							'agent-model-escalation-not-allowed'
						AND v_model_resolution #>> '{safeError,message}' =
							'The active agent policy does not allow the required model escalation.'
						AND v_model_resolution #> '{safeError,retryable}' =
							'false'::jsonb
					) OR (
						emdo.jsonb_object_has_exact_keys(
						v_model_resolution,
						ARRAY[
							'status', 'requestedModel', 'attemptedModels', 'reason',
							'safeError'
						]::text[]
						)
						AND v_model_resolution ->> 'status' = 'unavailable'
						AND v_model_resolution ->> 'requestedModel' = 'gpt-5.6-luna'
						AND pg_catalog.jsonb_typeof(
							v_model_resolution -> 'attemptedModels'
						) = 'array'
						AND pg_catalog.jsonb_array_length(
							v_model_resolution -> 'attemptedModels'
						) = 1
						AND v_model_resolution #>> '{attemptedModels,0}' =
							'gpt-5.6-luna'
						AND v_model_resolution ->> 'reason' =
							'configured-model-fallback-not-allowed'
						AND emdo.jsonb_object_has_exact_keys(
							v_model_resolution -> 'safeError',
							ARRAY['code', 'message', 'retryable']::text[]
						)
						AND v_model_resolution #>> '{safeError,code}' =
							'agent-model-fallback-not-allowed'
						AND v_model_resolution #>> '{safeError,message}' =
							'The active agent policy does not allow a model fallback.'
						AND v_model_resolution #> '{safeError,retryable}' =
							'false'::jsonb
					)
				) IS DISTINCT FROM true
		THEN
			RETURN false;
		END IF;
	END IF;

	RETURN true;
EXCEPTION
	WHEN data_exception THEN
		RETURN false;
END
$function$;

ALTER TABLE "emdo"."disclosure_grants" ADD COLUMN "invocation_context" jsonb;--> statement-breakpoint
ALTER TABLE "emdo"."disclosure_grants" ADD COLUMN "invocation_context_hash" text;--> statement-breakpoint

-- A caller may present only lineage identity. The remaining authority is
-- minted from canonical durable state below; these helpers keep every SQL
-- boundary strict without introducing a second invocation aggregate.
CREATE OR REPLACE FUNCTION "emdo"."registered_agent_invocation_identity_is_valid"(
	p_identity jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, emdo
AS $function$
DECLARE
	v_value text;
	v_previous text;
BEGIN
	IF p_identity IS NULL
		OR pg_catalog.jsonb_typeof(p_identity) IS DISTINCT FROM 'object'
		OR emdo.jsonb_object_has_exact_keys(
			p_identity,
			ARRAY[
				'orchestrationRunId', 'parentInvocationId', 'agentInvocationId',
				'phaseInvocationId', 'actorId', 'locale', 'grantedCapabilities'
			]::text[]
		) IS DISTINCT FROM true
		OR EXISTS (
			SELECT 1
			FROM unnest(ARRAY[
				'orchestrationRunId', 'parentInvocationId', 'agentInvocationId',
				'phaseInvocationId', 'actorId'
			]::text[]) AS required(key)
			WHERE pg_catalog.jsonb_typeof(p_identity -> required.key)
				IS DISTINCT FROM 'string'
		)
		OR (p_identity ->> 'orchestrationRunId') !~
			'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		OR (p_identity ->> 'parentInvocationId') !~
			'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		OR (p_identity ->> 'agentInvocationId') !~
			'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		OR (p_identity ->> 'phaseInvocationId') !~
			'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		OR (p_identity ->> 'actorId') !~
			'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		OR p_identity ->> 'locale' NOT IN ('en-CA', 'fr-CA', 'ja-JP', 'ko-KR')
		OR pg_catalog.jsonb_typeof(p_identity -> 'grantedCapabilities')
			IS DISTINCT FROM 'array'
		OR pg_catalog.jsonb_array_length(p_identity -> 'grantedCapabilities') > 128
		OR (p_identity ->> 'parentInvocationId') = (p_identity ->> 'agentInvocationId')
		OR (p_identity ->> 'parentInvocationId') = (p_identity ->> 'phaseInvocationId')
		OR (p_identity ->> 'agentInvocationId') = (p_identity ->> 'phaseInvocationId')
	THEN
		RETURN false;
	END IF;
	v_previous := NULL;
	FOR v_value IN
		SELECT entry.value
		FROM pg_catalog.jsonb_array_elements_text(
			p_identity -> 'grantedCapabilities'
		) WITH ORDINALITY AS entry(value, ordinality)
		ORDER BY entry.ordinality
	LOOP
		IF pg_catalog.length(v_value) NOT BETWEEN 2 AND 160
			OR v_value !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
			OR (v_previous IS NOT NULL AND v_previous >= v_value)
		THEN
			RETURN false;
		END IF;
		v_previous := v_value;
	END LOOP;
	RETURN true;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."registered_disclosure_allowlist_is_canonical"(
	p_allowlist jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, emdo
AS $function$
DECLARE
	v_record jsonb;
	v_data_class text;
	v_record_id text;
	v_field text;
	v_previous_binding text;
	v_previous_field text;
	v_binding text;
BEGIN
	IF p_allowlist IS NULL
		OR pg_catalog.jsonb_typeof(p_allowlist) IS DISTINCT FROM 'array'
		OR pg_catalog.jsonb_array_length(p_allowlist) NOT BETWEEN 1 AND 256
		OR pg_catalog.octet_length(p_allowlist::text) > 262144
	THEN
		RETURN false;
	END IF;
	v_previous_binding := NULL;
	FOR v_record IN
		SELECT entry.value
		FROM pg_catalog.jsonb_array_elements(p_allowlist)
			WITH ORDINALITY AS entry(value, ordinality)
		ORDER BY entry.ordinality
	LOOP
		IF pg_catalog.jsonb_typeof(v_record) IS DISTINCT FROM 'object'
			OR emdo.jsonb_object_has_exact_keys(
				v_record, ARRAY['dataClass', 'recordId', 'fields']::text[]
			) IS DISTINCT FROM true
			OR pg_catalog.jsonb_typeof(v_record -> 'dataClass') IS DISTINCT FROM 'string'
			OR pg_catalog.jsonb_typeof(v_record -> 'recordId') IS DISTINCT FROM 'string'
			OR pg_catalog.jsonb_typeof(v_record -> 'fields') IS DISTINCT FROM 'array'
			OR pg_catalog.jsonb_array_length(v_record -> 'fields') NOT BETWEEN 1 AND 128
		THEN
			RETURN false;
		END IF;
		v_data_class := v_record ->> 'dataClass';
		v_record_id := v_record ->> 'recordId';
		v_binding := v_data_class || E'\\x1f' || v_record_id;
		IF pg_catalog.length(v_data_class) NOT BETWEEN 2 AND 160
			OR v_data_class !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
			OR pg_catalog.length(v_record_id) NOT BETWEEN 1 AND 512
			OR pg_catalog.btrim(v_record_id) IS DISTINCT FROM v_record_id
			OR v_record_id ~ '[[:cntrl:]]'
			OR (v_previous_binding IS NOT NULL AND v_previous_binding >= v_binding)
		THEN
			RETURN false;
		END IF;
		v_previous_field := NULL;
		FOR v_field IN
			SELECT field.value
			FROM pg_catalog.jsonb_array_elements_text(v_record -> 'fields')
				WITH ORDINALITY AS field(value, ordinality)
			ORDER BY field.ordinality
		LOOP
			IF pg_catalog.length(v_field) NOT BETWEEN 2 AND 160
				OR v_field !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
				OR (v_previous_field IS NOT NULL AND v_previous_field >= v_field)
			THEN
				RETURN false;
			END IF;
			v_previous_field := v_field;
		END LOOP;
		v_previous_binding := v_binding;
	END LOOP;
	RETURN true;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."registered_agent_invocation_context_matches"(
	p_context jsonb,
	p_context_hash text,
	p_identity jsonb,
	p_record_allowlist jsonb,
	p_expires_at timestamptz,
	p_agent_id text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, emdo
AS $function$
DECLARE
	v_context_refs jsonb;
	v_scope text;
BEGIN
	IF p_context IS NULL
		OR p_context_hash !~ '^[a-f0-9]{64}$'
		OR NOT emdo.registered_agent_invocation_identity_is_valid(p_identity)
		OR NOT emdo.registered_disclosure_allowlist_is_canonical(p_record_allowlist)
		OR p_expires_at IS NULL
		OR p_agent_id !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
		OR pg_catalog.jsonb_typeof(p_context) IS DISTINCT FROM 'object'
		OR emdo.jsonb_object_has_exact_keys(
			p_context,
			ARRAY[
				'orchestrationRunId', 'parentInvocationId', 'agentInvocationId',
				'phaseInvocationId', 'actorId', 'locale', 'grantedCapabilities',
				'disclosedContextRefs', 'deadline', 'idempotencyScope'
			]::text[]
		) IS DISTINCT FROM true
		OR p_context_hash IS DISTINCT FROM emdo.canonical_json_hash(p_context)
		OR p_context ->> 'orchestrationRunId' IS DISTINCT FROM
			p_identity ->> 'orchestrationRunId'
		OR p_context ->> 'parentInvocationId' IS DISTINCT FROM
			p_identity ->> 'parentInvocationId'
		OR p_context ->> 'agentInvocationId' IS DISTINCT FROM
			p_identity ->> 'agentInvocationId'
		OR p_context ->> 'phaseInvocationId' IS DISTINCT FROM
			p_identity ->> 'phaseInvocationId'
		OR p_context ->> 'actorId' IS DISTINCT FROM p_identity ->> 'actorId'
		OR p_context ->> 'locale' IS DISTINCT FROM p_identity ->> 'locale'
		OR p_context -> 'grantedCapabilities' IS DISTINCT FROM
			p_identity -> 'grantedCapabilities'
		OR pg_catalog.jsonb_typeof(p_context -> 'deadline') IS DISTINCT FROM 'string'
		OR p_context ->> 'deadline' IS DISTINCT FROM pg_catalog.to_char(
			p_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
		)
		OR pg_catalog.jsonb_typeof(p_context -> 'idempotencyScope')
			IS DISTINCT FROM 'string'
		OR p_context ->> 'idempotencyScope' !~ '^[a-f0-9]{64}$'
	THEN
		RETURN false;
	END IF;
	SELECT COALESCE(
		pg_catalog.jsonb_agg(
			pg_catalog.to_jsonb(
				'context-ref-' || emdo.canonical_json_hash(
					pg_catalog.jsonb_build_object(
						'dataClass', record.value ->> 'dataClass',
						'recordId', record.value ->> 'recordId'
					)
				)
			) ORDER BY 'context-ref-' || emdo.canonical_json_hash(
				pg_catalog.jsonb_build_object(
					'dataClass', record.value ->> 'dataClass',
					'recordId', record.value ->> 'recordId'
				)
			)
		), '[]'::jsonb
	) INTO v_context_refs
	FROM pg_catalog.jsonb_array_elements(p_record_allowlist) AS record(value);
	IF p_context -> 'disclosedContextRefs' IS DISTINCT FROM v_context_refs THEN
		RETURN false;
	END IF;
	v_scope := emdo.canonical_json_hash(
		pg_catalog.jsonb_build_object(
			'domain', 'emdo.agent-invocation-scope.v1',
			'agentId', p_agent_id,
			'orchestrationRunId', p_context ->> 'orchestrationRunId',
			'parentInvocationId', p_context ->> 'parentInvocationId',
			'agentInvocationId', p_context ->> 'agentInvocationId',
			'phaseInvocationId', p_context ->> 'phaseInvocationId',
			'actorId', p_context ->> 'actorId',
			'locale', p_context ->> 'locale',
			'grantedCapabilities', p_context -> 'grantedCapabilities',
			'disclosedContextRefs', p_context -> 'disclosedContextRefs'
		)
	);
	RETURN p_context ->> 'idempotencyScope' = v_scope;
END
$function$;
--> statement-breakpoint

-- A blocked manager run may continue only through the one claimed approval
-- resume authority for this exact session/request/grant. All other blocked
-- runs remain closed to issuer, resolver, commit, and denial paths.
CREATE OR REPLACE FUNCTION "emdo"."registered_disclosure_run_is_current"(
	p_run_id uuid,
	p_household_id uuid,
	p_space_id uuid,
	p_user_id uuid,
	p_agent_id text,
	p_phase_purpose text,
	p_space_access_grant_id uuid
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
	SELECT EXISTS (
		SELECT 1
		FROM emdo.agent_runs AS run
		WHERE run.id = p_run_id
			AND run.household_id = p_household_id
			AND run.space_id = p_space_id
			AND run.original_owner_user_id = p_user_id
			AND run.agent_id = 'manager'
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
						WHERE resume.run_id = run.id
							AND resume.household_id = run.household_id
							AND resume.space_id = run.space_id
							AND resume.user_id = run.original_owner_user_id
							AND resume.state = 'claimed'
							AND resume.decision_id IS NOT NULL
							AND (
								resume.decision_type = 'approved'
								OR (
									resume.decision_type = 'rejected'
									AND p_phase_purpose = 'manager-synthesis'
								)
							)
							AND resume.authenticated_session_id = emdo.current_session_id()
							AND resume.resume_request_id = emdo.current_request_id()
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
	);
$function$;
--> statement-breakpoint

CREATE FUNCTION "emdo"."issue_model_disclosure_grant"(
	p_run_id uuid,
	p_household_id uuid,
	p_user_id uuid,
	p_space_id uuid,
	p_space_access_grant_id uuid,
	p_agent_id text,
	p_phase_purpose text,
	p_purpose text,
	p_provider text,
	p_invocation_identity jsonb,
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
	invocation_context jsonb,
	invocation_context_hash text,
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
	v_session_id uuid := emdo.current_session_id();
	v_request_id uuid := emdo.current_request_id();
	v_space_grant emdo.space_access_grants%ROWTYPE;
	v_run emdo.agent_runs%ROWTYPE;
	v_turn emdo.manager_turns%ROWTYPE;
	v_grant emdo.disclosure_grants%ROWTYPE;
	v_now timestamptz;
	v_created_at timestamptz;
	v_expires_at timestamptz;
	v_grant_id uuid;
	v_root_id uuid;
	v_context_refs jsonb;
	v_context jsonb;
	v_context_hash text;
	v_grant_document jsonb;
	v_expected_grant_hash text;
	v_existing boolean;
BEGIN
	IF p_run_id IS NULL OR p_household_id IS NULL OR p_user_id IS NULL
		OR p_space_id IS NULL OR p_space_access_grant_id IS NULL
		OR p_user_id IS DISTINCT FROM emdo.current_user_id()
		OR v_session_id IS NULL OR v_request_id IS NULL
		OR p_agent_id IS NULL OR p_agent_id !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
		OR p_phase_purpose NOT IN (
			'manager-plan', 'specialist-execution', 'manager-synthesis'
		)
		OR p_purpose IS NULL OR pg_catalog.btrim(p_purpose) IS DISTINCT FROM p_purpose
		OR pg_catalog.length(p_purpose) NOT BETWEEN 3 AND 500
		OR p_provider IS DISTINCT FROM 'openai'
		OR NOT emdo.registered_agent_invocation_identity_is_valid(
			p_invocation_identity
		)
		OR NOT emdo.registered_disclosure_allowlist_is_canonical(
			p_record_allowlist
		)
		OR p_invocation_identity ->> 'orchestrationRunId' IS DISTINCT FROM p_run_id::text
		OR p_invocation_identity ->> 'actorId' IS DISTINCT FROM p_user_id::text
	THEN
		RETURN;
	END IF;

	SELECT resolved.* INTO v_space_grant
	FROM emdo.resolve_space_access_grant(
		p_space_access_grant_id, p_household_id, p_user_id,
		v_session_id, v_request_id, p_space_id
	) AS resolved;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	SELECT run.* INTO v_run
	FROM emdo.agent_runs AS run
	WHERE run.id = p_run_id
		AND run.household_id = p_household_id
		AND run.space_id = p_space_id
		AND run.original_owner_user_id = p_user_id
		AND run.agent_id = 'manager'
	FOR SHARE OF run;
	IF NOT FOUND
		OR NOT emdo.registered_disclosure_run_is_current(
			p_run_id, p_household_id, p_space_id, p_user_id,
			p_agent_id, p_phase_purpose, p_space_access_grant_id
		)
	THEN
		RETURN;
	END IF;
	SELECT turn.* INTO v_turn
	FROM emdo.manager_turns AS turn
	WHERE turn.run_id = p_run_id
		AND turn.household_id = p_household_id
		AND turn.space_id = p_space_id
		AND turn.user_id = p_user_id
	FOR SHARE OF turn;
	IF NOT FOUND
		OR pg_catalog.jsonb_typeof(v_turn.request_payload) IS DISTINCT FROM 'object'
		OR NOT (v_turn.request_payload ?& ARRAY[
			'schemaVersion', 'message', 'locale', 'rootManagerInvocationId'
		]::text[])
		OR v_turn.request_payload - ARRAY[
			'schemaVersion', 'conversationId', 'message', 'routeHint',
			'locale', 'rootManagerInvocationId'
		]::text[] <> '{}'::jsonb
		OR v_turn.request_payload -> 'schemaVersion' IS DISTINCT FROM '1'::jsonb
		OR v_turn.request_payload ->> 'locale' NOT IN ('en-CA', 'fr-CA', 'ja-JP', 'ko-KR')
		OR v_turn.request_payload ->> 'rootManagerInvocationId' !~
			'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		OR v_turn.request_payload ->> 'locale' IS DISTINCT FROM
			p_invocation_identity ->> 'locale'
	THEN
		RETURN;
	END IF;
	v_root_id := (v_turn.request_payload ->> 'rootManagerInvocationId')::uuid;
	IF (
		p_phase_purpose IN ('manager-plan', 'manager-synthesis')
		AND (
			p_agent_id IS DISTINCT FROM 'manager'
			OR p_invocation_identity ->> 'parentInvocationId' IS DISTINCT FROM p_run_id::text
			OR p_invocation_identity ->> 'agentInvocationId' IS DISTINCT FROM v_root_id::text
			OR p_invocation_identity -> 'grantedCapabilities' NOT IN (
				'[]'::jsonb,
				'["agent.finance.delegate"]'::jsonb,
				'["agent.scheduler.delegate"]'::jsonb,
				'["agent.finance.delegate","agent.scheduler.delegate"]'::jsonb
			)
		)
	) OR (
		p_phase_purpose = 'specialist-execution'
		AND (
			p_agent_id NOT IN ('scheduler', 'finance')
			OR p_invocation_identity ->> 'parentInvocationId' IS DISTINCT FROM v_root_id::text
			OR (
				p_agent_id = 'scheduler'
				AND p_invocation_identity -> 'grantedCapabilities' IS DISTINCT FROM
					'["google-calendar.event.create"]'::jsonb
			) OR (
				p_agent_id = 'finance'
				AND p_invocation_identity -> 'grantedCapabilities' IS DISTINCT FROM
					'["finance.analytics.calculate","finance.documents.read","finance.documents.search","finance.matches.read","finance.records.read","finance.records.write","finance.statement.import"]'::jsonb
			)
		)
	) THEN
		RETURN;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			p_household_id::text || ':' || p_space_id::text || ':' ||
			p_user_id::text || ':' || p_run_id::text || ':' ||
			p_agent_id || ':' || p_phase_purpose || ':' || p_provider,
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
	v_existing := FOUND;
	v_now := pg_catalog.clock_timestamp();
	IF v_space_grant.issued_at > v_now OR v_space_grant.expires_at <= v_now THEN
		RETURN;
	END IF;

	IF v_existing THEN
		v_grant_document := pg_catalog.jsonb_build_object(
			'agentId', v_grant.agent_id,
			'createdAt', pg_catalog.to_char(v_grant.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
			'expiresAt', pg_catalog.to_char(v_grant.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
			'householdId', v_grant.household_id::text,
			'id', v_grant.id::text,
			'invocationContext', v_grant.invocation_context,
			'invocationContextHash', v_grant.invocation_context_hash,
			'oneRunOnly', true,
			'provider', v_grant.provider,
			'purpose', v_grant.purpose,
			'recordAllowlist', v_grant.record_allowlist,
			'runId', v_grant.run_id::text,
			'schemaVersion', 1,
			'userId', v_grant.user_id::text,
			'version', v_grant.version
		);
		v_expected_grant_hash := emdo.canonical_json_hash(v_grant_document);
		IF v_grant.schema_version <> 1 OR v_grant.version <> 1
			OR v_grant.purpose IS DISTINCT FROM p_purpose
			OR v_grant.record_allowlist IS DISTINCT FROM p_record_allowlist
			OR v_grant.one_run_only IS DISTINCT FROM true
			OR v_grant.created_at IS DISTINCT FROM pg_catalog.date_trunc('milliseconds', v_grant.created_at)
			OR v_grant.expires_at IS DISTINCT FROM v_grant.created_at + interval '10 minutes'
			OR v_grant.revoked_at IS NOT NULL
			OR v_grant.expires_at <= v_now
			OR NOT emdo.registered_agent_invocation_context_matches(
				v_grant.invocation_context, v_grant.invocation_context_hash,
				p_invocation_identity, v_grant.record_allowlist,
				v_grant.expires_at, p_agent_id
			)
			OR v_grant.grant_hash IS DISTINCT FROM v_expected_grant_hash
		THEN
			RETURN;
		END IF;
		RETURN QUERY SELECT
			v_grant.schema_version, v_grant.version, v_grant.id,
			v_grant.household_id, v_grant.space_id, v_grant.user_id,
			v_grant.run_id, v_grant.agent_id, v_grant.purpose,
			v_grant.phase_purpose, v_grant.provider, v_grant.record_allowlist,
			v_grant.invocation_context, v_grant.invocation_context_hash,
			v_grant.grant_hash, v_grant.one_run_only,
			v_grant.created_at, v_grant.expires_at, v_now;
		RETURN;
	END IF;

	v_created_at := pg_catalog.date_trunc('milliseconds', v_now);
	v_expires_at := v_created_at + interval '10 minutes';
	SELECT pg_catalog.jsonb_agg(
		pg_catalog.to_jsonb(
			'context-ref-' || emdo.canonical_json_hash(
				pg_catalog.jsonb_build_object(
					'dataClass', record.value ->> 'dataClass',
					'recordId', record.value ->> 'recordId'
				)
			)
		) ORDER BY 'context-ref-' || emdo.canonical_json_hash(
			pg_catalog.jsonb_build_object(
				'dataClass', record.value ->> 'dataClass',
				'recordId', record.value ->> 'recordId'
			)
		)
	) INTO v_context_refs
	FROM pg_catalog.jsonb_array_elements(p_record_allowlist) AS record(value);
	v_context := pg_catalog.jsonb_build_object(
		'orchestrationRunId', p_invocation_identity ->> 'orchestrationRunId',
		'parentInvocationId', p_invocation_identity ->> 'parentInvocationId',
		'agentInvocationId', p_invocation_identity ->> 'agentInvocationId',
		'phaseInvocationId', p_invocation_identity ->> 'phaseInvocationId',
		'actorId', p_invocation_identity ->> 'actorId',
		'locale', p_invocation_identity ->> 'locale',
		'grantedCapabilities', p_invocation_identity -> 'grantedCapabilities',
		'disclosedContextRefs', v_context_refs,
		'deadline', pg_catalog.to_char(v_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
	);
	v_context := v_context || pg_catalog.jsonb_build_object(
		'idempotencyScope', emdo.canonical_json_hash(
			pg_catalog.jsonb_build_object(
				'domain', 'emdo.agent-invocation-scope.v1',
				'agentId', p_agent_id,
				'orchestrationRunId', v_context ->> 'orchestrationRunId',
				'parentInvocationId', v_context ->> 'parentInvocationId',
				'agentInvocationId', v_context ->> 'agentInvocationId',
				'phaseInvocationId', v_context ->> 'phaseInvocationId',
				'actorId', v_context ->> 'actorId',
				'locale', v_context ->> 'locale',
				'grantedCapabilities', v_context -> 'grantedCapabilities',
				'disclosedContextRefs', v_context -> 'disclosedContextRefs'
			)
		)
	);
	v_context_hash := emdo.canonical_json_hash(v_context);
	IF NOT emdo.registered_agent_invocation_context_matches(
		v_context, v_context_hash, p_invocation_identity, p_record_allowlist,
		v_expires_at, p_agent_id
	) THEN
		RETURN;
	END IF;
	v_grant_id := pg_catalog.gen_random_uuid();
	v_grant_document := pg_catalog.jsonb_build_object(
		'agentId', p_agent_id,
		'createdAt', pg_catalog.to_char(v_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'expiresAt', pg_catalog.to_char(v_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'householdId', p_household_id::text,
		'id', v_grant_id::text,
		'invocationContext', v_context,
		'invocationContextHash', v_context_hash,
		'oneRunOnly', true,
		'provider', p_provider,
		'purpose', p_purpose,
		'recordAllowlist', p_record_allowlist,
		'runId', p_run_id::text,
		'schemaVersion', 1,
		'userId', p_user_id::text,
		'version', 1
	);
	v_expected_grant_hash := emdo.canonical_json_hash(v_grant_document);
	INSERT INTO emdo.disclosure_grants(
		id, schema_version, version, household_id, space_id, user_id,
		run_id, agent_id, purpose, phase_purpose, provider, record_allowlist,
		invocation_context, invocation_context_hash, grant_hash, one_run_only,
		created_at, expires_at
	) VALUES (
		v_grant_id, 1, 1, p_household_id, p_space_id, p_user_id,
		p_run_id, p_agent_id, p_purpose, p_phase_purpose, p_provider,
		p_record_allowlist, v_context, v_context_hash, v_expected_grant_hash,
		true, v_created_at, v_expires_at
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
			'invocationContextHash', v_context_hash,
			'recordRefs', v_context_refs
		), v_now, v_now + interval '12 months'
	);
	RETURN QUERY SELECT
		v_grant.schema_version, v_grant.version, v_grant.id,
		v_grant.household_id, v_grant.space_id, v_grant.user_id,
		v_grant.run_id, v_grant.agent_id, v_grant.purpose,
		v_grant.phase_purpose, v_grant.provider, v_grant.record_allowlist,
		v_grant.invocation_context, v_grant.invocation_context_hash,
		v_grant.grant_hash, v_grant.one_run_only,
		v_grant.created_at, v_grant.expires_at, v_now;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION "emdo"."resolve_model_disclosure_grant"(
	p_requested_grant_id uuid,
	p_run_id uuid,
	p_household_id uuid,
	p_user_id uuid,
	p_space_access_grant_id uuid,
	p_agent_id text,
	p_phase_purpose text,
	p_provider text,
	p_invocation_identity jsonb,
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
	phase_purpose text,
	provider text,
	record_allowlist jsonb,
	invocation_context jsonb,
	invocation_context_hash text,
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
	v_turn emdo.manager_turns%ROWTYPE;
	v_root_id uuid;
	v_now timestamptz;
	v_requested text;
	v_previous text;
	v_status text;
BEGIN
	IF p_run_id IS NULL OR p_household_id IS NULL OR p_user_id IS NULL
		OR p_space_access_grant_id IS NULL
		OR p_user_id IS DISTINCT FROM emdo.current_user_id()
		OR p_agent_id IS NULL OR p_agent_id !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
		OR p_phase_purpose NOT IN (
			'manager-plan', 'specialist-execution', 'manager-synthesis'
		)
		OR p_provider IS DISTINCT FROM 'openai'
		OR NOT emdo.registered_agent_invocation_identity_is_valid(
			p_invocation_identity
		)
		OR p_invocation_identity ->> 'orchestrationRunId' IS DISTINCT FROM p_run_id::text
		OR p_invocation_identity ->> 'actorId' IS DISTINCT FROM p_user_id::text
		OR pg_catalog.jsonb_typeof(p_requested_data_classes) IS DISTINCT FROM 'array'
		OR pg_catalog.jsonb_array_length(p_requested_data_classes) > 64
	THEN
		RAISE EXCEPTION USING ERRCODE = '22023',
			MESSAGE = 'invalid model disclosure request';
	END IF;
	v_previous := NULL;
	FOR v_requested IN
		SELECT entry.value
		FROM pg_catalog.jsonb_array_elements_text(p_requested_data_classes)
			WITH ORDINALITY AS entry(value, ordinality)
		ORDER BY entry.ordinality
	LOOP
		IF pg_catalog.length(v_requested) NOT BETWEEN 2 AND 160
			OR v_requested !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
			OR (v_previous IS NOT NULL AND v_previous >= v_requested)
		THEN
			RAISE EXCEPTION USING ERRCODE = '22023',
				MESSAGE = 'invalid model disclosure request';
		END IF;
		v_previous := v_requested;
	END LOOP;
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
			NULL::text, NULL::jsonb, NULL::jsonb, NULL::text, NULL::text,
			NULL::timestamptz, NULL::timestamptz, v_now;
		RETURN;
	END IF;
	IF p_requested_grant_id IS NULL THEN
		RETURN QUERY SELECT 'no-active-grant'::text, NULL::smallint,
			NULL::integer, NULL::uuid, NULL::uuid, NULL::uuid,
			NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text,
			NULL::text, NULL::jsonb, NULL::jsonb, NULL::text, NULL::text,
			NULL::timestamptz, NULL::timestamptz, v_now;
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
			NULL::text, NULL::jsonb, NULL::jsonb, NULL::text, NULL::text,
			NULL::timestamptz, NULL::timestamptz, v_now;
		RETURN;
	END IF;

	v_now := pg_catalog.clock_timestamp();
	IF v_space_grant.issued_at > v_now OR v_space_grant.expires_at <= v_now THEN
		v_status := 'no-active-grant';
	ELSIF v_grant.household_id IS DISTINCT FROM p_household_id THEN
		v_status := 'grant-household-mismatch';
	ELSIF v_grant.user_id IS DISTINCT FROM p_user_id THEN
		v_status := 'grant-user-mismatch';
	ELSIF v_grant.run_id IS DISTINCT FROM p_run_id THEN
		v_status := 'grant-run-mismatch';
	ELSIF v_grant.agent_id IS DISTINCT FROM p_agent_id THEN
		v_status := 'grant-agent-mismatch';
	ELSIF v_grant.phase_purpose IS DISTINCT FROM p_phase_purpose THEN
		v_status := 'grant-purpose-mismatch';
	ELSIF v_grant.provider IS DISTINCT FROM p_provider THEN
		v_status := 'grant-provider-mismatch';
	ELSIF v_grant.revoked_at IS NOT NULL OR v_grant.consumed_at IS NOT NULL
		OR v_grant.expires_at <= v_now THEN
		v_status := 'grant-expired';
	ELSIF NOT (v_grant.space_id = ANY(v_space_grant.writable_space_ids))
		OR NOT EXISTS (
			SELECT 1 FROM emdo.resolve_space_access_grant(
				p_space_access_grant_id, p_household_id, p_user_id,
				emdo.current_session_id(), emdo.current_request_id(), v_grant.space_id
			)
		) THEN
		v_status := 'no-active-grant';
	ELSIF NOT emdo.registered_agent_invocation_context_matches(
		v_grant.invocation_context, v_grant.invocation_context_hash,
		p_invocation_identity, v_grant.record_allowlist, v_grant.expires_at,
		v_grant.agent_id
	) THEN
		v_status := 'grant-invocation-mismatch';
	ELSE
		SELECT turn.* INTO v_turn
		FROM emdo.manager_turns AS turn
		WHERE turn.run_id = v_grant.run_id
			AND turn.household_id = v_grant.household_id
			AND turn.space_id = v_grant.space_id
			AND turn.user_id = v_grant.user_id
		FOR SHARE OF turn;
		IF NOT FOUND
			OR pg_catalog.jsonb_typeof(v_turn.request_payload) IS DISTINCT FROM 'object'
			OR v_turn.request_payload ->> 'locale' IS DISTINCT FROM
				p_invocation_identity ->> 'locale'
			OR v_turn.request_payload ->> 'rootManagerInvocationId' !~
				'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		THEN
			v_status := 'grant-invocation-mismatch';
		ELSE
			v_root_id := (v_turn.request_payload ->> 'rootManagerInvocationId')::uuid;
			IF (
				v_grant.phase_purpose IN ('manager-plan', 'manager-synthesis')
				AND (
					v_grant.agent_id IS DISTINCT FROM 'manager'
					OR p_invocation_identity ->> 'parentInvocationId' IS DISTINCT FROM v_grant.run_id::text
					OR p_invocation_identity ->> 'agentInvocationId' IS DISTINCT FROM v_root_id::text
				)
			) OR (
				v_grant.phase_purpose = 'specialist-execution'
				AND (
					v_grant.agent_id NOT IN ('scheduler', 'finance')
					OR p_invocation_identity ->> 'parentInvocationId' IS DISTINCT FROM v_root_id::text
				)
			) THEN
				v_status := 'grant-invocation-mismatch';
			ELSIF EXISTS (
				SELECT 1
				FROM pg_catalog.jsonb_array_elements_text(p_requested_data_classes)
					AS requested(data_class)
				WHERE NOT EXISTS (
					SELECT 1
					FROM pg_catalog.jsonb_array_elements(v_grant.record_allowlist)
						AS allowed(record)
					WHERE allowed.record ->> 'dataClass' = requested.data_class
				)
			) THEN
				v_status := 'record-not-allowed';
			ELSIF NOT emdo.registered_disclosure_run_is_current(
				v_grant.run_id, v_grant.household_id, v_grant.space_id,
				v_grant.user_id, v_grant.agent_id, v_grant.phase_purpose,
				p_space_access_grant_id
			) THEN
				v_status := 'grant-run-mismatch';
			ELSE
				v_status := 'active';
			END IF;
		END IF;
	END IF;
	IF v_status IS DISTINCT FROM 'active' THEN
		RETURN QUERY SELECT v_status, NULL::smallint, NULL::integer,
			v_grant.id, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
			NULL::text, NULL::text, NULL::text, NULL::text, NULL::jsonb,
			NULL::jsonb, NULL::text, NULL::text, NULL::timestamptz,
			NULL::timestamptz, v_now;
		RETURN;
	END IF;
	RETURN QUERY SELECT v_status, v_grant.schema_version, v_grant.version,
		v_grant.id, v_grant.household_id, v_grant.space_id, v_grant.user_id,
		v_grant.run_id, v_grant.agent_id, v_grant.purpose,
		v_grant.phase_purpose, v_grant.provider, v_grant.record_allowlist,
		v_grant.invocation_context, v_grant.invocation_context_hash,
		v_grant.grant_hash, v_grant.created_at, v_grant.expires_at, v_now;
END
$function$;
--> statement-breakpoint

-- Proposal materialization needs to read the immutable authority that was
-- already consumed by the single permitted model disclosure. This is not a
-- second disclosure authorization: it accepts only the exact consumed grant
-- and returns its persisted canonical snapshot without changing any row.
CREATE FUNCTION "emdo"."resolve_consumed_disclosure_grant_for_proposal"(
	p_requested_grant_id uuid,
	p_run_id uuid,
	p_household_id uuid,
	p_user_id uuid,
	p_space_access_grant_id uuid,
	p_agent_id text,
	p_phase_purpose text,
	p_provider text,
	p_invocation_context jsonb,
	p_invocation_context_hash text
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
	phase_purpose text,
	provider text,
	record_allowlist jsonb,
	invocation_context jsonb,
	invocation_context_hash text,
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
	v_turn emdo.manager_turns%ROWTYPE;
	v_root_id uuid;
	v_identity jsonb;
	v_grant_document jsonb;
	v_expected_grant_hash text;
	v_now timestamptz;
	v_status text;
BEGIN
	IF p_requested_grant_id IS NULL
		OR p_run_id IS NULL OR p_household_id IS NULL OR p_user_id IS NULL
		OR p_space_access_grant_id IS NULL
		OR p_user_id IS DISTINCT FROM emdo.current_user_id()
		OR p_agent_id NOT IN ('scheduler', 'finance')
		OR p_phase_purpose IS DISTINCT FROM 'specialist-execution'
		OR p_provider IS DISTINCT FROM 'openai'
		OR p_invocation_context IS NULL
		OR pg_catalog.jsonb_typeof(p_invocation_context) IS DISTINCT FROM 'object'
		OR p_invocation_context_hash IS NULL
		OR p_invocation_context_hash !~ '^[a-f0-9]{64}$'
	THEN
		RAISE EXCEPTION USING ERRCODE = '22023',
			MESSAGE = 'invalid consumed proposal disclosure request';
	END IF;
	v_identity := pg_catalog.jsonb_build_object(
		'orchestrationRunId', p_invocation_context ->> 'orchestrationRunId',
		'parentInvocationId', p_invocation_context ->> 'parentInvocationId',
		'agentInvocationId', p_invocation_context ->> 'agentInvocationId',
		'phaseInvocationId', p_invocation_context ->> 'phaseInvocationId',
		'actorId', p_invocation_context ->> 'actorId',
		'locale', p_invocation_context ->> 'locale',
		'grantedCapabilities', p_invocation_context -> 'grantedCapabilities'
	);
	IF NOT emdo.registered_agent_invocation_identity_is_valid(v_identity)
		OR p_invocation_context_hash IS DISTINCT FROM
			emdo.canonical_json_hash(p_invocation_context)
		OR p_invocation_context ->> 'orchestrationRunId' IS DISTINCT FROM
			p_run_id::text
		OR p_invocation_context ->> 'actorId' IS DISTINCT FROM p_user_id::text
	THEN
		RAISE EXCEPTION USING ERRCODE = '22023',
			MESSAGE = 'invalid consumed proposal disclosure request';
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
			NULL::text, NULL::jsonb, NULL::jsonb, NULL::text, NULL::text,
			NULL::timestamptz, NULL::timestamptz, v_now;
		RETURN;
	END IF;

	SELECT disclosure_grant.* INTO v_grant
	FROM emdo.disclosure_grants AS disclosure_grant
	WHERE disclosure_grant.id = p_requested_grant_id
		AND disclosure_grant.user_id = p_user_id
	FOR SHARE OF disclosure_grant;
	IF NOT FOUND THEN
		RETURN QUERY SELECT 'grant-not-found'::text, NULL::smallint,
			NULL::integer, p_requested_grant_id, NULL::uuid, NULL::uuid,
			NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text,
			NULL::text, NULL::jsonb, NULL::jsonb, NULL::text, NULL::text,
			NULL::timestamptz, NULL::timestamptz, v_now;
		RETURN;
	END IF;

	v_now := pg_catalog.clock_timestamp();
	v_grant_document := pg_catalog.jsonb_build_object(
		'agentId', v_grant.agent_id,
		'createdAt', pg_catalog.to_char(
			v_grant.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
		),
		'expiresAt', pg_catalog.to_char(
			v_grant.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
		),
		'householdId', v_grant.household_id::text,
		'id', v_grant.id::text,
		'invocationContext', v_grant.invocation_context,
		'invocationContextHash', v_grant.invocation_context_hash,
		'oneRunOnly', true,
		'provider', v_grant.provider,
		'purpose', v_grant.purpose,
		'recordAllowlist', v_grant.record_allowlist,
		'runId', v_grant.run_id::text,
		'schemaVersion', 1,
		'userId', v_grant.user_id::text,
		'version', v_grant.version
	);
	v_expected_grant_hash := emdo.canonical_json_hash(v_grant_document);
	IF v_space_grant.issued_at > v_now OR v_space_grant.expires_at <= v_now THEN
		v_status := 'no-active-grant';
	ELSIF v_grant.household_id IS DISTINCT FROM p_household_id THEN
		v_status := 'grant-household-mismatch';
	ELSIF v_grant.user_id IS DISTINCT FROM p_user_id THEN
		v_status := 'grant-user-mismatch';
	ELSIF v_grant.run_id IS DISTINCT FROM p_run_id THEN
		v_status := 'grant-run-mismatch';
	ELSIF v_grant.agent_id IS DISTINCT FROM p_agent_id THEN
		v_status := 'grant-agent-mismatch';
	ELSIF v_grant.phase_purpose IS DISTINCT FROM p_phase_purpose THEN
		v_status := 'grant-purpose-mismatch';
	ELSIF v_grant.provider IS DISTINCT FROM p_provider THEN
		v_status := 'grant-provider-mismatch';
	ELSIF v_grant.consumed_at IS NULL THEN
		v_status := 'grant-not-consumed';
	ELSIF v_grant.revoked_at IS NOT NULL OR v_grant.expires_at <= v_now THEN
		v_status := 'grant-expired';
	ELSIF NOT (v_grant.space_id = ANY(v_space_grant.writable_space_ids))
		OR NOT EXISTS (
			SELECT 1 FROM emdo.resolve_space_access_grant(
				p_space_access_grant_id, p_household_id, p_user_id,
				emdo.current_session_id(), emdo.current_request_id(), v_grant.space_id
			)
		) THEN
		v_status := 'no-active-grant';
	ELSIF v_grant.schema_version <> 1
		OR v_grant.version <> 1
		OR v_grant.one_run_only IS DISTINCT FROM true
		OR v_grant.created_at IS DISTINCT FROM
			pg_catalog.date_trunc('milliseconds', v_grant.created_at)
		OR v_grant.expires_at IS DISTINCT FROM
			v_grant.created_at + interval '10 minutes'
		OR NOT emdo.registered_disclosure_allowlist_is_canonical(
			v_grant.record_allowlist
		)
		OR v_grant.grant_hash IS DISTINCT FROM v_expected_grant_hash
		OR v_grant.invocation_context IS DISTINCT FROM p_invocation_context
		OR v_grant.invocation_context_hash IS DISTINCT FROM
			p_invocation_context_hash
		OR NOT emdo.registered_agent_invocation_context_matches(
			v_grant.invocation_context, v_grant.invocation_context_hash,
			v_identity, v_grant.record_allowlist, v_grant.expires_at,
			v_grant.agent_id
		)
	THEN
		v_status := 'grant-invocation-mismatch';
	ELSIF (v_grant.invocation_context ->> 'deadline')::timestamptz <= v_now
	THEN
		v_status := 'grant-expired';
	ELSE
		SELECT turn.* INTO v_turn
		FROM emdo.manager_turns AS turn
		WHERE turn.run_id = v_grant.run_id
			AND turn.household_id = v_grant.household_id
			AND turn.space_id = v_grant.space_id
			AND turn.user_id = v_grant.user_id
		FOR SHARE OF turn;
		IF NOT FOUND
			OR pg_catalog.jsonb_typeof(v_turn.request_payload) IS DISTINCT FROM 'object'
			OR NOT (v_turn.request_payload ?& ARRAY[
				'schemaVersion', 'message', 'locale', 'rootManagerInvocationId'
			]::text[])
			OR v_turn.request_payload - ARRAY[
				'schemaVersion', 'conversationId', 'message', 'routeHint',
				'locale', 'rootManagerInvocationId'
			]::text[] <> '{}'::jsonb
			OR v_turn.request_payload -> 'schemaVersion' IS DISTINCT FROM '1'::jsonb
			OR v_turn.request_payload ->> 'locale' IS DISTINCT FROM
				p_invocation_context ->> 'locale'
			OR v_turn.request_payload ->> 'rootManagerInvocationId' !~
				'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		THEN
			v_status := 'grant-invocation-mismatch';
		ELSE
			v_root_id := (v_turn.request_payload ->> 'rootManagerInvocationId')::uuid;
			IF p_invocation_context ->> 'parentInvocationId' IS DISTINCT FROM
				v_root_id::text
				OR (
					v_grant.agent_id = 'scheduler'
					AND p_invocation_context -> 'grantedCapabilities' IS DISTINCT FROM
						'["google-calendar.event.create"]'::jsonb
				) OR (
					v_grant.agent_id = 'finance'
					AND p_invocation_context -> 'grantedCapabilities' IS DISTINCT FROM
						'["finance.analytics.calculate","finance.documents.read","finance.documents.search","finance.matches.read","finance.records.read","finance.records.write","finance.statement.import"]'::jsonb
				) OR NOT emdo.registered_disclosure_run_is_current(
					v_grant.run_id, v_grant.household_id, v_grant.space_id,
					v_grant.user_id, v_grant.agent_id, v_grant.phase_purpose,
					p_space_access_grant_id
				)
			THEN
				v_status := 'grant-invocation-mismatch';
			ELSIF NOT EXISTS (
				SELECT 1
				FROM emdo.audit_events AS audit
				WHERE audit.household_id = v_grant.household_id
					AND audit.space_id = v_grant.space_id
					AND audit.original_owner_user_id = v_grant.user_id
					AND audit.actor_user_id = v_grant.user_id
					AND audit.run_id = v_grant.run_id
					AND audit.event_type = 'model.disclosure.sent'
					AND audit.payload -> 'schemaVersion' IS NOT DISTINCT FROM '1'::jsonb
					AND audit.payload ->> 'grantId' IS NOT DISTINCT FROM v_grant.id::text
					AND audit.payload ->> 'grantVersion' IS NOT DISTINCT FROM
						v_grant.version::text
					AND audit.payload ->> 'agentId' IS NOT DISTINCT FROM
						v_grant.agent_id
					AND audit.payload ->> 'phasePurpose' IS NOT DISTINCT FROM
						v_grant.phase_purpose
					AND audit.payload ->> 'provider' IS NOT DISTINCT FROM
						v_grant.provider
					AND audit.payload ->> 'invocationContextHash' IS NOT DISTINCT FROM
						v_grant.invocation_context_hash
					AND audit.payload -> 'recordRefs' IS NOT DISTINCT FROM
						v_grant.invocation_context -> 'disclosedContextRefs'
			) THEN
				v_status := 'grant-invocation-mismatch';
			ELSE
				v_status := 'consumed';
			END IF;
		END IF;
	END IF;
	IF v_status IS DISTINCT FROM 'consumed' THEN
		RETURN QUERY SELECT v_status, NULL::smallint, NULL::integer,
			v_grant.id, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
			NULL::text, NULL::text, NULL::text, NULL::text, NULL::jsonb,
			NULL::jsonb, NULL::text, NULL::text, NULL::timestamptz,
			NULL::timestamptz, v_now;
		RETURN;
	END IF;
	RETURN QUERY SELECT v_status, v_grant.schema_version, v_grant.version,
		v_grant.id, v_grant.household_id, v_grant.space_id, v_grant.user_id,
		v_grant.run_id, v_grant.agent_id, v_grant.purpose,
		v_grant.phase_purpose, v_grant.provider, v_grant.record_allowlist,
		v_grant.invocation_context, v_grant.invocation_context_hash,
		v_grant.grant_hash, v_grant.created_at, v_grant.expires_at, v_now;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION "emdo"."commit_model_disclosure_authorization"(
	p_grant_id uuid,
	p_version integer,
	p_grant_hash text,
	p_invocation_context jsonb,
	p_invocation_context_hash text,
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
	v_identity jsonb;
	v_record jsonb;
	v_allowed jsonb;
	v_field text;
	v_binding text;
	v_previous_binding text;
	v_previous_field text;
	v_now timestamptz;
BEGIN
	IF p_grant_id IS NULL OR p_version IS NULL OR p_version <= 0
		OR p_grant_hash IS NULL OR p_grant_hash !~ '^[a-f0-9]{64}$'
		OR p_invocation_context IS NULL
		OR p_invocation_context_hash IS NULL
		OR p_invocation_context_hash !~ '^[a-f0-9]{64}$'
		OR p_space_access_grant_id IS NULL
		OR p_phase_purpose NOT IN (
			'manager-plan', 'specialist-execution', 'manager-synthesis'
		)
		OR pg_catalog.jsonb_typeof(p_records) IS DISTINCT FROM 'array'
		OR pg_catalog.jsonb_array_length(p_records) > 256
	THEN
		RETURN;
	END IF;
	v_identity := pg_catalog.jsonb_build_object(
		'orchestrationRunId', p_invocation_context ->> 'orchestrationRunId',
		'parentInvocationId', p_invocation_context ->> 'parentInvocationId',
		'agentInvocationId', p_invocation_context ->> 'agentInvocationId',
		'phaseInvocationId', p_invocation_context ->> 'phaseInvocationId',
		'actorId', p_invocation_context ->> 'actorId',
		'locale', p_invocation_context ->> 'locale',
		'grantedCapabilities', p_invocation_context -> 'grantedCapabilities'
	);
	SELECT stored.* INTO v_grant
	FROM emdo.disclosure_grants AS stored
	WHERE stored.id = p_grant_id
		AND stored.version = p_version
		AND stored.grant_hash = p_grant_hash
		AND stored.phase_purpose = p_phase_purpose
		AND stored.user_id = emdo.current_user_id()
	FOR UPDATE;
	IF NOT FOUND
		OR v_grant.invocation_context IS DISTINCT FROM p_invocation_context
		OR v_grant.invocation_context_hash IS DISTINCT FROM p_invocation_context_hash
		OR NOT emdo.registered_agent_invocation_context_matches(
			v_grant.invocation_context, v_grant.invocation_context_hash,
			v_identity, v_grant.record_allowlist, v_grant.expires_at,
			v_grant.agent_id
		)
	THEN
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
	IF v_grant.revoked_at IS NOT NULL OR v_grant.consumed_at IS NOT NULL
		OR v_grant.expires_at <= v_now
		OR v_space_grant.issued_at > v_now OR v_space_grant.expires_at <= v_now
		OR NOT emdo.lock_active_request_scope(v_grant.household_id, v_grant.space_id, NULL)
		OR NOT emdo.registered_disclosure_run_is_current(
			v_grant.run_id, v_grant.household_id, v_grant.space_id,
			v_grant.user_id, v_grant.agent_id, v_grant.phase_purpose,
			p_space_access_grant_id
		)
	THEN
		RETURN;
	END IF;
	v_previous_binding := NULL;
	FOR v_record IN
		SELECT entry.value
		FROM pg_catalog.jsonb_array_elements(p_records)
			WITH ORDINALITY AS entry(value, ordinality)
		ORDER BY entry.ordinality
	LOOP
		IF pg_catalog.jsonb_typeof(v_record) IS DISTINCT FROM 'object'
			OR emdo.jsonb_object_has_exact_keys(
				v_record, ARRAY['dataClass', 'recordId', 'fields']::text[]
			) IS DISTINCT FROM true
			OR pg_catalog.jsonb_typeof(v_record -> 'dataClass') IS DISTINCT FROM 'string'
			OR pg_catalog.jsonb_typeof(v_record -> 'recordId') IS DISTINCT FROM 'string'
			OR pg_catalog.jsonb_typeof(v_record -> 'fields') IS DISTINCT FROM 'array'
			OR pg_catalog.jsonb_array_length(v_record -> 'fields') NOT BETWEEN 1 AND 128
		THEN
			RETURN;
		END IF;
		v_binding := (v_record ->> 'dataClass') || E'\\x1f' || (v_record ->> 'recordId');
		IF v_previous_binding IS NOT NULL AND v_previous_binding >= v_binding THEN
			RETURN;
		END IF;
		SELECT allowed.record INTO v_allowed
		FROM pg_catalog.jsonb_array_elements(v_grant.record_allowlist)
			AS allowed(record)
		WHERE allowed.record ->> 'dataClass' = v_record ->> 'dataClass'
			AND allowed.record ->> 'recordId' = v_record ->> 'recordId';
		IF NOT FOUND THEN
			RETURN;
		END IF;
		v_previous_field := NULL;
		FOR v_field IN
			SELECT field.value
			FROM pg_catalog.jsonb_array_elements_text(v_record -> 'fields')
				WITH ORDINALITY AS field(value, ordinality)
			ORDER BY field.ordinality
		LOOP
			IF v_field !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
				OR (v_previous_field IS NOT NULL AND v_previous_field >= v_field)
				OR NOT ((v_allowed -> 'fields') ? v_field)
			THEN
				RETURN;
			END IF;
			v_previous_field := v_field;
		END LOOP;
		v_previous_binding := v_binding;
	END LOOP;
	v_now := pg_catalog.clock_timestamp();
	UPDATE emdo.disclosure_grants AS disclosure_grant
	SET consumed_at = v_now
	WHERE disclosure_grant.id = v_grant.id
		AND disclosure_grant.consumed_at IS NULL
		AND disclosure_grant.revoked_at IS NULL
		AND disclosure_grant.expires_at > v_now;
	IF NOT FOUND THEN
		RETURN;
	END IF;
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
			'invocationContextHash', v_grant.invocation_context_hash,
			'recordRefs', v_grant.invocation_context -> 'disclosedContextRefs'
		), v_now, v_now + interval '12 months'
	);
	RETURN QUERY SELECT true, v_now, v_grant.expires_at;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION "emdo"."record_model_disclosure_denial"(
	p_grant_id uuid,
	p_version integer,
	p_grant_hash text,
	p_invocation_context jsonb,
	p_invocation_context_hash text,
	p_space_access_grant_id uuid,
	p_phase_purpose text,
	p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_grant emdo.disclosure_grants%ROWTYPE;
	v_space_grant emdo.space_access_grants%ROWTYPE;
	v_identity jsonb;
	v_now timestamptz;
BEGIN
	IF p_grant_id IS NULL OR p_version IS NULL OR p_version <= 0
		OR p_grant_hash IS NULL OR p_grant_hash !~ '^[a-f0-9]{64}$'
		OR p_invocation_context IS NULL
		OR p_invocation_context_hash IS NULL
		OR p_invocation_context_hash !~ '^[a-f0-9]{64}$'
		OR p_space_access_grant_id IS NULL
		OR p_phase_purpose NOT IN (
			'manager-plan', 'specialist-execution', 'manager-synthesis'
		)
		OR p_reason NOT IN ('record-not-allowed', 'field-not-allowed')
	THEN
		RETURN false;
	END IF;
	v_identity := pg_catalog.jsonb_build_object(
		'orchestrationRunId', p_invocation_context ->> 'orchestrationRunId',
		'parentInvocationId', p_invocation_context ->> 'parentInvocationId',
		'agentInvocationId', p_invocation_context ->> 'agentInvocationId',
		'phaseInvocationId', p_invocation_context ->> 'phaseInvocationId',
		'actorId', p_invocation_context ->> 'actorId',
		'locale', p_invocation_context ->> 'locale',
		'grantedCapabilities', p_invocation_context -> 'grantedCapabilities'
	);
	SELECT stored.* INTO v_grant
	FROM emdo.disclosure_grants AS stored
	WHERE stored.id = p_grant_id
		AND stored.version = p_version
		AND stored.grant_hash = p_grant_hash
		AND stored.phase_purpose = p_phase_purpose
		AND stored.user_id = emdo.current_user_id()
	FOR UPDATE;
	IF NOT FOUND
		OR v_grant.invocation_context IS DISTINCT FROM p_invocation_context
		OR v_grant.invocation_context_hash IS DISTINCT FROM p_invocation_context_hash
		OR NOT emdo.registered_agent_invocation_context_matches(
			v_grant.invocation_context, v_grant.invocation_context_hash,
			v_identity, v_grant.record_allowlist, v_grant.expires_at,
			v_grant.agent_id
		)
	THEN
		RETURN false;
	END IF;
	SELECT resolved.* INTO v_space_grant
	FROM emdo.resolve_space_access_grant(
		p_space_access_grant_id, v_grant.household_id, v_grant.user_id,
		emdo.current_session_id(), emdo.current_request_id(), v_grant.space_id
	) AS resolved;
	v_now := pg_catalog.clock_timestamp();
	IF NOT FOUND OR v_grant.revoked_at IS NOT NULL
		OR v_grant.expires_at <= v_now OR v_space_grant.expires_at <= v_now
		OR NOT emdo.lock_active_request_scope(v_grant.household_id, v_grant.space_id, NULL)
		OR NOT emdo.registered_disclosure_run_is_current(
			v_grant.run_id, v_grant.household_id, v_grant.space_id,
			v_grant.user_id, v_grant.agent_id, v_grant.phase_purpose,
			p_space_access_grant_id
		)
	THEN
		RETURN false;
	END IF;
	INSERT INTO emdo.audit_events(
		household_id, space_id, original_owner_user_id, actor_user_id,
		session_id, request_id, run_id, event_type, payload,
		occurred_at, retain_until
	) VALUES (
		v_grant.household_id, v_grant.space_id, v_grant.user_id,
		v_grant.user_id, emdo.current_session_id(), emdo.current_request_id(),
		v_grant.run_id, 'model.disclosure.denied',
		pg_catalog.jsonb_build_object(
			'schemaVersion', 1, 'grantId', v_grant.id,
			'grantVersion', v_grant.version, 'agentId', v_grant.agent_id,
			'phasePurpose', p_phase_purpose, 'provider', v_grant.provider,
			'reason', p_reason,
			'invocationContextHash', v_grant.invocation_context_hash,
			'recordRefs', v_grant.invocation_context -> 'disclosedContextRefs'
		), v_now, v_now + interval '12 months'
	);
	RETURN true;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."registered_specialist_outcome_is_valid"(
	p_outcome jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, emdo
AS $function$
DECLARE
	v_context jsonb;
	v_identity jsonb;
	v_ref text;
	v_previous_ref text;
	v_evidence text;
	v_usage jsonb;
	v_tokens numeric;
	v_scope text;
	v_status text;
BEGIN
	IF p_outcome IS NULL OR pg_catalog.jsonb_typeof(p_outcome) IS DISTINCT FROM 'object'
	THEN
		RETURN false;
	END IF;
	v_status := p_outcome ->> 'status';
	IF (v_status = 'completed' AND emdo.jsonb_object_has_exact_keys(
		p_outcome, ARRAY[
			'delegationId', 'specialistId', 'invocationContext',
			'invocationContextHash', 'usage', 'status', 'facts', 'evidence'
		]::text[]) IS DISTINCT FROM true)
		OR (v_status = 'needs_confirmation' AND emdo.jsonb_object_has_exact_keys(
		p_outcome, ARRAY[
			'delegationId', 'specialistId', 'invocationContext',
			'invocationContextHash', 'usage', 'status', 'proposedAction'
		]::text[]) IS DISTINCT FROM true)
		OR (v_status = 'needs_input' AND emdo.jsonb_object_has_exact_keys(
		p_outcome, ARRAY[
			'delegationId', 'specialistId', 'invocationContext',
			'invocationContextHash', 'usage', 'status', 'question'
		]::text[]) IS DISTINCT FROM true)
		OR (v_status = 'unavailable' AND emdo.jsonb_object_has_exact_keys(
		p_outcome, ARRAY[
			'delegationId', 'specialistId', 'invocationContext',
			'invocationContextHash', 'usage', 'status', 'reasonCode'
		]::text[]) IS DISTINCT FROM true)
		OR (v_status = 'failed' AND emdo.jsonb_object_has_exact_keys(
		p_outcome, ARRAY[
			'delegationId', 'specialistId', 'invocationContext',
			'invocationContextHash', 'usage', 'status', 'safeMessage'
		]::text[]) IS DISTINCT FROM true)
		OR v_status NOT IN (
			'completed', 'needs_confirmation', 'needs_input', 'unavailable', 'failed'
		)
		OR pg_catalog.jsonb_typeof(p_outcome -> 'delegationId') IS DISTINCT FROM 'string'
		OR pg_catalog.length(p_outcome ->> 'delegationId') NOT BETWEEN 1 AND 512
		OR pg_catalog.btrim(p_outcome ->> 'delegationId') IS DISTINCT FROM p_outcome ->> 'delegationId'
		OR (p_outcome ->> 'delegationId') ~ '[[:cntrl:]]'
		OR p_outcome ->> 'specialistId' NOT IN ('scheduler', 'finance')
		OR pg_catalog.jsonb_typeof(p_outcome -> 'invocationContext') IS DISTINCT FROM 'object'
		OR p_outcome ->> 'invocationContextHash' !~ '^[a-f0-9]{64}$'
		OR p_outcome ->> 'invocationContextHash' IS DISTINCT FROM
			emdo.canonical_json_hash(p_outcome -> 'invocationContext')
		OR pg_catalog.jsonb_typeof(p_outcome -> 'usage') IS DISTINCT FROM 'object'
	THEN
		RETURN false;
	END IF;
	v_context := p_outcome -> 'invocationContext';
	v_identity := pg_catalog.jsonb_build_object(
		'orchestrationRunId', v_context ->> 'orchestrationRunId',
		'parentInvocationId', v_context ->> 'parentInvocationId',
		'agentInvocationId', v_context ->> 'agentInvocationId',
		'phaseInvocationId', v_context ->> 'phaseInvocationId',
		'actorId', v_context ->> 'actorId',
		'locale', v_context ->> 'locale',
		'grantedCapabilities', v_context -> 'grantedCapabilities'
	);
	IF emdo.jsonb_object_has_exact_keys(
		v_context,
		ARRAY[
			'orchestrationRunId', 'parentInvocationId', 'agentInvocationId',
			'phaseInvocationId', 'actorId', 'locale', 'grantedCapabilities',
			'disclosedContextRefs', 'deadline', 'idempotencyScope'
		]::text[]
	) IS DISTINCT FROM true
		OR NOT emdo.registered_agent_invocation_identity_is_valid(v_identity)
		OR pg_catalog.jsonb_typeof(v_context -> 'disclosedContextRefs') IS DISTINCT FROM 'array'
		OR pg_catalog.jsonb_array_length(v_context -> 'disclosedContextRefs') > 256
		OR pg_catalog.jsonb_typeof(v_context -> 'deadline') IS DISTINCT FROM 'string'
		OR pg_catalog.jsonb_typeof(v_context -> 'idempotencyScope') IS DISTINCT FROM 'string'
		OR v_context ->> 'idempotencyScope' !~ '^[a-f0-9]{64}$'
	THEN
		RETURN false;
	END IF;
	v_previous_ref := NULL;
	FOR v_ref IN
		SELECT entry.value
		FROM pg_catalog.jsonb_array_elements_text(v_context -> 'disclosedContextRefs')
			WITH ORDINALITY AS entry(value, ordinality)
		ORDER BY entry.ordinality
	LOOP
		IF v_ref !~ '^context-ref-[a-f0-9]{64}$'
			OR (v_previous_ref IS NOT NULL AND v_previous_ref >= v_ref)
		THEN
			RETURN false;
		END IF;
		v_previous_ref := v_ref;
	END LOOP;
	v_scope := emdo.canonical_json_hash(
		pg_catalog.jsonb_build_object(
			'domain', 'emdo.agent-invocation-scope.v1',
			'agentId', p_outcome ->> 'specialistId',
			'orchestrationRunId', v_context ->> 'orchestrationRunId',
			'parentInvocationId', v_context ->> 'parentInvocationId',
			'agentInvocationId', v_context ->> 'agentInvocationId',
			'phaseInvocationId', v_context ->> 'phaseInvocationId',
			'actorId', v_context ->> 'actorId',
			'locale', v_context ->> 'locale',
			'grantedCapabilities', v_context -> 'grantedCapabilities',
			'disclosedContextRefs', v_context -> 'disclosedContextRefs'
		)
	);
	IF v_context ->> 'idempotencyScope' IS DISTINCT FROM v_scope
		OR (p_outcome ->> 'specialistId' = 'scheduler'
			AND v_context -> 'grantedCapabilities' IS DISTINCT FROM
				'["google-calendar.event.create"]'::jsonb)
		OR (p_outcome ->> 'specialistId' = 'finance'
			AND v_context -> 'grantedCapabilities' IS DISTINCT FROM
				'["finance.analytics.calculate","finance.documents.read","finance.documents.search","finance.matches.read","finance.records.read","finance.records.write","finance.statement.import"]'::jsonb)
	THEN
		RETURN false;
	END IF;
	v_usage := p_outcome -> 'usage';
	IF emdo.jsonb_object_has_exact_keys(
		v_usage,
		CASE WHEN v_usage ? 'spendWarning' THEN ARRAY[
			'inputTokens', 'outputTokens', 'modelCostCadMinor', 'spendWarning'
		]::text[] ELSE ARRAY[
			'inputTokens', 'outputTokens', 'modelCostCadMinor'
		]::text[] END
	) IS DISTINCT FROM true
		OR pg_catalog.jsonb_typeof(v_usage -> 'inputTokens') IS DISTINCT FROM 'number'
		OR pg_catalog.jsonb_typeof(v_usage -> 'outputTokens') IS DISTINCT FROM 'number'
		OR pg_catalog.jsonb_typeof(v_usage -> 'modelCostCadMinor') IS DISTINCT FROM 'number'
		OR (v_usage ? 'spendWarning' AND v_usage -> 'spendWarning' IS DISTINCT FROM 'true'::jsonb)
	THEN
		RETURN false;
	END IF;
	FOR v_tokens IN SELECT (v_usage ->> key)::numeric
		FROM unnest(ARRAY['inputTokens', 'outputTokens', 'modelCostCadMinor']::text[]) AS key
	LOOP
		IF v_tokens < 0 OR v_tokens > 9007199254740991::numeric
			OR v_tokens <> pg_catalog.trunc(v_tokens)
		THEN RETURN false; END IF;
	END LOOP;
	IF (v_status = 'completed' AND (
		pg_catalog.jsonb_typeof(p_outcome -> 'facts') IS NULL
		OR pg_catalog.jsonb_typeof(p_outcome -> 'evidence') IS DISTINCT FROM 'array'
		OR pg_catalog.jsonb_array_length(p_outcome -> 'evidence') > 512
	)) OR (v_status = 'needs_confirmation' AND (
		pg_catalog.jsonb_typeof(p_outcome -> 'proposedAction') IS DISTINCT FROM 'object'
		OR emdo.jsonb_object_has_exact_keys(p_outcome -> 'proposedAction',
			ARRAY['proposalId', 'capabilityId', 'argumentsPreview']::text[]) IS DISTINCT FROM true
		OR (p_outcome #>> '{proposedAction,proposalId}') !~
			'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		OR (p_outcome #>> '{proposedAction,capabilityId}') !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
	)) OR (v_status = 'needs_input' AND (
		pg_catalog.jsonb_typeof(p_outcome -> 'question') IS DISTINCT FROM 'string'
		OR pg_catalog.length(p_outcome ->> 'question') NOT BETWEEN 1 AND 500
		OR pg_catalog.btrim(p_outcome ->> 'question') IS DISTINCT FROM p_outcome ->> 'question'
	)) OR (v_status = 'unavailable' AND (
		pg_catalog.jsonb_typeof(p_outcome -> 'reasonCode') IS DISTINCT FROM 'string'
		OR p_outcome ->> 'reasonCode' !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
		OR v_context -> 'disclosedContextRefs' IS DISTINCT FROM '[]'::jsonb
	)) OR (v_status = 'failed' AND (
		pg_catalog.jsonb_typeof(p_outcome -> 'safeMessage') IS DISTINCT FROM 'string'
		OR pg_catalog.length(p_outcome ->> 'safeMessage') NOT BETWEEN 1 AND 4096
		OR pg_catalog.btrim(p_outcome ->> 'safeMessage') IS DISTINCT FROM p_outcome ->> 'safeMessage'
	)) THEN
		RETURN false;
	END IF;
	IF v_status = 'completed' THEN
		IF EXISTS (
			SELECT 1
			FROM pg_catalog.jsonb_array_elements(p_outcome -> 'evidence')
				AS evidence(value)
			WHERE pg_catalog.jsonb_typeof(evidence.value) IS DISTINCT FROM 'string'
		) THEN
			RETURN false;
		END IF;
		FOR v_evidence IN
			SELECT value FROM pg_catalog.jsonb_array_elements_text(p_outcome -> 'evidence')
		LOOP
			IF v_evidence !~ '^[a-z0-9]+([._-][a-z0-9]+)*$' THEN RETURN false; END IF;
		END LOOP;
	END IF;
	BEGIN
		PERFORM (v_context ->> 'deadline')::timestamptz;
	EXCEPTION WHEN data_exception THEN
		RETURN false;
	END;
	RETURN true;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."registered_specialist_outcomes_match_lineage"(
	p_run_id uuid,
	p_household_id uuid,
	p_user_id uuid,
	p_root_manager_invocation_id uuid,
	p_locale text,
	p_outcomes jsonb
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_outcome jsonb;
	v_context jsonb;
	v_identity jsonb;
	v_grant emdo.disclosure_grants%ROWTYPE;
	v_delegations text[] := ARRAY[]::text[];
	v_phase_ids text[] := ARRAY[]::text[];
	v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
	IF p_run_id IS NULL OR p_household_id IS NULL OR p_user_id IS NULL
		OR p_root_manager_invocation_id IS NULL
		OR p_locale NOT IN ('en-CA', 'fr-CA', 'ja-JP', 'ko-KR')
		OR pg_catalog.jsonb_typeof(p_outcomes) IS DISTINCT FROM 'array'
		OR pg_catalog.jsonb_array_length(p_outcomes) > 128
	THEN
		RETURN false;
	END IF;
	FOR v_outcome IN SELECT value FROM pg_catalog.jsonb_array_elements(p_outcomes)
	LOOP
		IF NOT emdo.registered_specialist_outcome_is_valid(v_outcome) THEN
			RETURN false;
		END IF;
		v_context := v_outcome -> 'invocationContext';
		IF v_outcome ->> 'delegationId' = ANY(v_delegations)
			OR v_context ->> 'phaseInvocationId' = ANY(v_phase_ids)
			OR v_context ->> 'orchestrationRunId' IS DISTINCT FROM p_run_id::text
			OR v_context ->> 'parentInvocationId' IS DISTINCT FROM p_root_manager_invocation_id::text
			OR v_context ->> 'actorId' IS DISTINCT FROM p_user_id::text
			OR v_context ->> 'locale' IS DISTINCT FROM p_locale
		THEN
			RETURN false;
		END IF;
		v_delegations := pg_catalog.array_append(v_delegations, v_outcome ->> 'delegationId');
		v_phase_ids := pg_catalog.array_append(v_phase_ids, v_context ->> 'phaseInvocationId');
		IF v_outcome ->> 'status' = 'unavailable' THEN
			CONTINUE;
		END IF;
		v_identity := pg_catalog.jsonb_build_object(
			'orchestrationRunId', v_context ->> 'orchestrationRunId',
			'parentInvocationId', v_context ->> 'parentInvocationId',
			'agentInvocationId', v_context ->> 'agentInvocationId',
			'phaseInvocationId', v_context ->> 'phaseInvocationId',
			'actorId', v_context ->> 'actorId',
			'locale', v_context ->> 'locale',
			'grantedCapabilities', v_context -> 'grantedCapabilities'
		);
		SELECT disclosure_grant.* INTO v_grant
		FROM emdo.disclosure_grants AS disclosure_grant
		WHERE disclosure_grant.household_id = p_household_id
			AND disclosure_grant.user_id = p_user_id
			AND disclosure_grant.run_id = p_run_id
			AND disclosure_grant.agent_id = v_outcome ->> 'specialistId'
			AND disclosure_grant.phase_purpose = 'specialist-execution'
			AND disclosure_grant.invocation_context IS NOT DISTINCT FROM v_context
			AND disclosure_grant.invocation_context_hash IS NOT DISTINCT FROM
				v_outcome ->> 'invocationContextHash'
		FOR SHARE OF disclosure_grant;
		IF NOT FOUND OR v_grant.revoked_at IS NOT NULL
			OR v_grant.expires_at <= v_now
			OR NOT emdo.registered_agent_invocation_context_matches(
				v_grant.invocation_context, v_grant.invocation_context_hash,
				v_identity, v_grant.record_allowlist, v_grant.expires_at,
				v_grant.agent_id
			)
		THEN
			RETURN false;
		END IF;
	END LOOP;
	RETURN true;
END
$function$;
--> statement-breakpoint

-- Root manager lineage is durable request data rather than a second aggregate.
-- The server may generate a fresh candidate on a transport retry, so replay
-- equality deliberately compares the user request after removing that private
-- candidate and always returns the durable stored root.
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
			'gpt-5.6-luna', 'gpt-5.6-terra', 'provider-free-mvp-v1'
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

CREATE OR REPLACE FUNCTION "emdo"."registered_manager_turn_result_is_valid"(
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
	v_outcome jsonb;
	v_usage jsonb;
	v_safe_error jsonb;
	v_provider_free boolean := false;
BEGIN
	IF p_result IS NULL
		OR pg_catalog.jsonb_typeof(p_result) IS DISTINCT FROM 'object'
		OR pg_catalog.octet_length(p_result::text) > 1400000
		OR pg_catalog.jsonb_typeof(p_result -> 'runId') IS DISTINCT FROM 'string'
		OR p_result ->> 'runId' !~
			'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		OR pg_catalog.jsonb_typeof(p_result -> 'localTraceReference')
			IS DISTINCT FROM 'string'
		OR pg_catalog.length(p_result ->> 'localTraceReference') NOT BETWEEN 1 AND 512
		OR pg_catalog.btrim(p_result ->> 'localTraceReference')
			IS DISTINCT FROM p_result ->> 'localTraceReference'
		OR (p_result ->> 'localTraceReference') ~ '[[:cntrl:]]'
		OR pg_catalog.jsonb_typeof(p_result -> 'specialistOutcomes')
			IS DISTINCT FROM 'array'
		OR pg_catalog.jsonb_array_length(p_result -> 'specialistOutcomes') > 128
		OR pg_catalog.jsonb_typeof(p_result -> 'usage') IS DISTINCT FROM 'object'
	THEN
		RETURN false;
	END IF;
	v_usage := p_result -> 'usage';
	IF emdo.jsonb_object_has_exact_keys(
		v_usage,
		CASE WHEN v_usage ? 'spendWarning' THEN ARRAY[
			'inputTokens', 'outputTokens', 'modelCostCadMinor', 'spendWarning'
		]::text[] ELSE ARRAY[
			'inputTokens', 'outputTokens', 'modelCostCadMinor'
		]::text[] END
	) IS DISTINCT FROM true
		OR pg_catalog.jsonb_typeof(v_usage -> 'inputTokens') IS DISTINCT FROM 'number'
		OR pg_catalog.jsonb_typeof(v_usage -> 'outputTokens') IS DISTINCT FROM 'number'
		OR pg_catalog.jsonb_typeof(v_usage -> 'modelCostCadMinor') IS DISTINCT FROM 'number'
		OR (v_usage ? 'spendWarning'
			AND v_usage -> 'spendWarning' IS DISTINCT FROM 'true'::jsonb)
		OR (v_usage ->> 'inputTokens') !~ '^[0-9]+$'
		OR (v_usage ->> 'outputTokens') !~ '^[0-9]+$'
		OR (v_usage ->> 'modelCostCadMinor') !~ '^[0-9]+$'
	THEN
		RETURN false;
	END IF;
	v_status := p_result ->> 'status';
	v_provider_free := p_result #>> '{executionResolution,profile}' =
		'shopping-list-v1';
	IF v_provider_free THEN
		IF v_status IS DISTINCT FROM 'completed'
			OR emdo.jsonb_object_has_exact_keys(
				p_result,
				ARRAY[
					'status', 'runId', 'localTraceReference', 'output',
					'specialistOutcomes', 'hasPartialFailures', 'usage',
					'executionResolution'
				]::text[]
			) IS DISTINCT FROM true
			OR pg_catalog.jsonb_typeof(p_result -> 'hasPartialFailures')
				IS DISTINCT FROM 'boolean'
			OR emdo.jsonb_object_has_exact_keys(
				p_result -> 'executionResolution',
				ARRAY['status', 'profile', 'reason']::text[]
			) IS DISTINCT FROM true
			OR p_result #>> '{executionResolution,status}' IS DISTINCT FROM 'provider-free'
			OR p_result #>> '{executionResolution,reason}' IS DISTINCT FROM 'provider-free-mvp'
		THEN
			RETURN false;
		END IF;
		FOR v_outcome IN
			SELECT value FROM pg_catalog.jsonb_array_elements(
				p_result -> 'specialistOutcomes'
			)
		LOOP
			IF pg_catalog.jsonb_typeof(v_outcome) IS DISTINCT FROM 'object'
				OR NOT (v_outcome ?& ARRAY[
					'delegationId', 'specialistId', 'status', 'usage'
				]::text[])
				OR v_outcome ->> 'status' NOT IN ('completed', 'failed', 'blocked')
				OR pg_catalog.jsonb_typeof(v_outcome -> 'usage')
					IS DISTINCT FROM 'object'
			THEN
				RETURN false;
			END IF;
		END LOOP;
		RETURN true;
	END IF;

	IF v_status = 'completed' THEN
		IF emdo.jsonb_object_has_exact_keys(
				p_result,
				ARRAY[
					'status', 'runId', 'localTraceReference', 'output',
					'specialistOutcomes', 'hasPartialFailures', 'usage',
					'modelResolution'
				]::text[]
			) IS DISTINCT FROM true
			OR pg_catalog.jsonb_typeof(p_result -> 'hasPartialFailures')
				IS DISTINCT FROM 'boolean'
			OR pg_catalog.jsonb_typeof(p_result -> 'modelResolution')
				IS DISTINCT FROM 'object'
			OR p_result #>> '{modelResolution,status}' IS DISTINCT FROM 'resolved'
		THEN
			RETURN false;
		END IF;
	ELSIF v_status = 'needs-approval' THEN
		IF emdo.jsonb_object_has_exact_keys(
				p_result,
				ARRAY[
					'status', 'runId', 'localTraceReference', 'checkpoint',
					'interruptions', 'specialistOutcomes', 'usage',
					'modelResolution'
				]::text[]
			) IS DISTINCT FROM true
			OR pg_catalog.jsonb_typeof(p_result -> 'checkpoint') IS DISTINCT FROM 'object'
			OR pg_catalog.jsonb_typeof(p_result -> 'interruptions') IS DISTINCT FROM 'array'
			OR pg_catalog.jsonb_array_length(p_result -> 'interruptions') <> 1
			OR pg_catalog.jsonb_typeof(p_result -> 'modelResolution')
				IS DISTINCT FROM 'object'
			OR p_result #>> '{modelResolution,status}' IS DISTINCT FROM 'resolved'
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
			OR pg_catalog.jsonb_typeof(p_result -> 'safeError') IS DISTINCT FROM 'object'
		THEN
			RETURN false;
		END IF;
		v_safe_error := p_result -> 'safeError';
		IF emdo.jsonb_object_has_exact_keys(
			v_safe_error, ARRAY['code', 'message', 'retryable']::text[]
		) IS DISTINCT FROM true
			OR pg_catalog.jsonb_typeof(v_safe_error -> 'code') IS DISTINCT FROM 'string'
			OR pg_catalog.jsonb_typeof(v_safe_error -> 'message') IS DISTINCT FROM 'string'
			OR pg_catalog.jsonb_typeof(v_safe_error -> 'retryable') IS DISTINCT FROM 'boolean'
			OR pg_catalog.length(v_safe_error ->> 'code') NOT BETWEEN 1 AND 256
			OR pg_catalog.length(v_safe_error ->> 'message') NOT BETWEEN 1 AND 4096
			OR pg_catalog.btrim(v_safe_error ->> 'code') IS DISTINCT FROM v_safe_error ->> 'code'
			OR pg_catalog.btrim(v_safe_error ->> 'message') IS DISTINCT FROM v_safe_error ->> 'message'
		THEN
			RETURN false;
		END IF;
	ELSE
		RETURN false;
	END IF;
	FOR v_outcome IN
		SELECT value FROM pg_catalog.jsonb_array_elements(p_result -> 'specialistOutcomes')
	LOOP
		IF NOT emdo.registered_specialist_outcome_is_valid(v_outcome) THEN
			RETURN false;
		END IF;
	END LOOP;
	RETURN true;
END
$function$;
--> statement-breakpoint

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
	v_confirmation jsonb;
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
	v_root_id uuid;
	v_specialist_count integer;
	v_confirmation_count integer;
BEGIN
	IF p_operation_id IS NULL
		OR p_operation_hash !~ '^[a-f0-9]{64}$'
		OR p_claim_id IS NULL
		OR p_ownership_token_hash !~ '^[a-f0-9]{64}$'
		OR p_run_id IS NULL
		OR NOT emdo.registered_manager_turn_result_is_valid(p_result)
		OR p_result ->> 'runId' IS DISTINCT FROM p_run_id::text
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	v_status := p_result ->> 'status';
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

	-- Provider-free shopping remains on its established result branch. Every
	-- model-backed completion is bound to the durable manager root and locale.
	IF p_result #>> '{executionResolution,profile}' = 'shopping-list-v1' THEN
		IF v_turn.requested_model IS DISTINCT FROM 'provider-free-mvp-v1' THEN
			RETURN emdo.record_manager_turn_operation(
				p_operation_id, p_run_id, 'complete', p_operation_hash,
				p_claim_id, p_ownership_token_hash, v_result_hash,
				pg_catalog.jsonb_build_object('status', 'conflict')
			);
		END IF;
	ELSE
		IF pg_catalog.jsonb_typeof(v_turn.request_payload) IS DISTINCT FROM 'object'
			OR v_turn.request_payload ->> 'locale' NOT IN (
				'en-CA', 'fr-CA', 'ja-JP', 'ko-KR'
			)
			OR v_turn.request_payload ->> 'rootManagerInvocationId' !~
				'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		THEN
			RETURN emdo.record_manager_turn_operation(
				p_operation_id, p_run_id, 'complete', p_operation_hash,
				p_claim_id, p_ownership_token_hash, v_result_hash,
				pg_catalog.jsonb_build_object('status', 'conflict')
			);
		END IF;
		v_root_id := (v_turn.request_payload ->> 'rootManagerInvocationId')::uuid;
		IF NOT emdo.registered_specialist_outcomes_match_lineage(
			p_run_id, v_turn.household_id, v_turn.user_id, v_root_id,
			v_turn.request_payload ->> 'locale', p_result -> 'specialistOutcomes'
		) THEN
			RETURN emdo.record_manager_turn_operation(
				p_operation_id, p_run_id, 'complete', p_operation_hash,
				p_claim_id, p_ownership_token_hash, v_result_hash,
				pg_catalog.jsonb_build_object('status', 'conflict')
			);
		END IF;
		IF v_status = 'needs-approval' THEN
			v_interruption := p_result -> 'interruptions' -> 0;
			SELECT count(*)
			INTO v_confirmation_count
			FROM pg_catalog.jsonb_array_elements(
				p_result -> 'specialistOutcomes'
			) AS outcome(value)
			WHERE outcome.value ->> 'status' = 'needs_confirmation';
			SELECT outcome.value INTO v_confirmation
			FROM pg_catalog.jsonb_array_elements(
				p_result -> 'specialistOutcomes'
			) AS outcome(value)
			WHERE outcome.value ->> 'status' = 'needs_confirmation'
			LIMIT 1;
			IF v_confirmation_count <> 1
				OR pg_catalog.jsonb_typeof(v_interruption) IS DISTINCT FROM 'object'
				OR emdo.jsonb_object_has_exact_keys(
					v_interruption,
					ARRAY[
						'id', 'agentId', 'capabilityId', 'proposalId',
						'argumentsPreview'
					]::text[]
				) IS DISTINCT FROM true
				OR v_confirmation ->> 'specialistId' IS DISTINCT FROM
					v_interruption ->> 'agentId'
				OR v_confirmation #>> '{proposedAction,proposalId}' IS DISTINCT FROM
					v_interruption ->> 'proposalId'
				OR v_confirmation #>> '{proposedAction,capabilityId}' IS DISTINCT FROM
					v_interruption ->> 'capabilityId'
				OR v_confirmation #> '{proposedAction,argumentsPreview}' IS DISTINCT FROM
					v_interruption -> 'argumentsPreview'
			THEN
				RETURN emdo.record_manager_turn_operation(
					p_operation_id, p_run_id, 'complete', p_operation_hash,
					p_claim_id, p_ownership_token_hash, v_result_hash,
					pg_catalog.jsonb_build_object('status', 'conflict')
				);
			END IF;
		END IF;
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
			OR v_checkpoint.expires_at <= v_now
			OR v_proposal.household_id <> v_turn.household_id
			OR v_proposal.space_id <> v_turn.space_id
			OR v_proposal.original_owner_user_id <> v_turn.user_id
			OR v_proposal.run_id <> v_turn.run_id
			OR v_proposal.capability_id IS DISTINCT FROM v_interruption ->> 'capabilityId'
			OR v_proposal_state.state <> 'pending'
			OR v_preparation.abandonment_reason IS NOT NULL
			OR v_preparation.abandoned_at IS NOT NULL
			OR v_disclosure.household_id <> v_turn.household_id
			OR v_disclosure.space_id <> v_turn.space_id
			OR v_disclosure.user_id <> v_turn.user_id
			OR v_disclosure.run_id <> v_turn.run_id
			OR v_disclosure.id <> v_proposal.disclosure_grant_id
			OR v_disclosure.revoked_at IS NOT NULL
			OR v_disclosure.expires_at <= v_now
			OR v_disclosure.invocation_context IS DISTINCT FROM
				v_confirmation -> 'invocationContext'
			OR v_disclosure.invocation_context_hash IS DISTINCT FROM
				v_confirmation ->> 'invocationContextHash'
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
			NULL, v_now, v_now,
			least(
				v_checkpoint.expires_at, v_proposal.expires_at,
				v_disclosure.expires_at, v_now + interval '10 minutes'
			), v_now + interval '90 days'
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

-- A resumable approval must have been created by the registered runtime. Old
-- null-context grants remain readable history but cannot mint resume authority.
CREATE OR REPLACE FUNCTION "emdo"."registered_approval_resume_binding_is_valid"(
	p_run_id uuid,
	p_household_id uuid,
	p_user_id uuid,
	p_root_manager_invocation_id uuid,
	p_locale text,
	p_disclosure_grant_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_grant emdo.disclosure_grants%ROWTYPE;
	v_identity jsonb;
BEGIN
	IF p_run_id IS NULL OR p_household_id IS NULL OR p_user_id IS NULL
		OR p_root_manager_invocation_id IS NULL
		OR p_locale NOT IN ('en-CA', 'fr-CA', 'ja-JP', 'ko-KR')
		OR p_disclosure_grant_id IS NULL
	THEN
		RETURN false;
	END IF;
	SELECT disclosure_grant.* INTO v_grant
	FROM emdo.disclosure_grants AS disclosure_grant
	WHERE disclosure_grant.id = p_disclosure_grant_id
		AND disclosure_grant.household_id = p_household_id
		AND disclosure_grant.user_id = p_user_id
		AND disclosure_grant.run_id = p_run_id
		AND disclosure_grant.agent_id IN ('scheduler', 'finance')
		AND disclosure_grant.phase_purpose = 'specialist-execution'
	FOR SHARE OF disclosure_grant;
	IF NOT FOUND OR v_grant.revoked_at IS NOT NULL
		OR v_grant.expires_at <= pg_catalog.clock_timestamp()
	THEN
		RETURN false;
	END IF;
	v_identity := pg_catalog.jsonb_build_object(
		'orchestrationRunId', v_grant.invocation_context ->> 'orchestrationRunId',
		'parentInvocationId', v_grant.invocation_context ->> 'parentInvocationId',
		'agentInvocationId', v_grant.invocation_context ->> 'agentInvocationId',
		'phaseInvocationId', v_grant.invocation_context ->> 'phaseInvocationId',
		'actorId', v_grant.invocation_context ->> 'actorId',
		'locale', v_grant.invocation_context ->> 'locale',
		'grantedCapabilities', v_grant.invocation_context -> 'grantedCapabilities'
	);
	RETURN v_grant.invocation_context ->> 'orchestrationRunId' = p_run_id::text
		AND v_grant.invocation_context ->> 'parentInvocationId' =
			p_root_manager_invocation_id::text
		AND v_grant.invocation_context ->> 'actorId' = p_user_id::text
		AND v_grant.invocation_context ->> 'locale' = p_locale
		AND emdo.registered_agent_invocation_context_matches(
			v_grant.invocation_context, v_grant.invocation_context_hash,
			v_identity, v_grant.record_allowlist, v_grant.expires_at,
			v_grant.agent_id
		);
END
$function$;
--> statement-breakpoint

ALTER FUNCTION "emdo"."claim_approval_resume_job"(uuid, uuid, uuid)
	RENAME TO "claim_approval_resume_job_legacy_v5";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."claim_approval_resume_job"(
	p_decision_id uuid,
	p_decision_request_id uuid,
	p_current_space_access_grant_id uuid
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
	v_turn emdo.manager_turns%ROWTYPE;
	v_root_id uuid;
	v_result jsonb;
BEGIN
	IF p_decision_id IS NULL OR p_decision_request_id IS NULL
		OR p_current_space_access_grant_id IS NULL
		OR emdo.current_user_id() IS NULL
		OR emdo.current_session_id() IS NULL
		OR emdo.current_request_id() IS DISTINCT FROM p_decision_request_id
	THEN
		RETURN NULL;
	END IF;
	SELECT resume.* INTO v_job
	FROM emdo.approval_resume_jobs AS resume
	WHERE resume.decision_id = p_decision_id
		AND resume.user_id = emdo.current_user_id()
	FOR SHARE OF resume;
	IF FOUND AND v_job.state = 'ready' THEN
		SELECT turn.* INTO v_turn
		FROM emdo.manager_turns AS turn
		WHERE turn.run_id = v_job.run_id
			AND turn.household_id = v_job.household_id
			AND turn.space_id = v_job.space_id
			AND turn.user_id = v_job.user_id
		FOR SHARE OF turn;
		IF NOT FOUND
			OR pg_catalog.jsonb_typeof(v_turn.request_payload) IS DISTINCT FROM 'object'
			OR v_turn.request_payload ->> 'locale' NOT IN (
				'en-CA', 'fr-CA', 'ja-JP', 'ko-KR'
			)
			OR v_turn.request_payload ->> 'rootManagerInvocationId' !~
				'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		THEN
			RETURN NULL;
		END IF;
		v_root_id := (v_turn.request_payload ->> 'rootManagerInvocationId')::uuid;
		IF NOT emdo.registered_approval_resume_binding_is_valid(
			v_job.run_id, v_job.household_id, v_job.user_id, v_root_id,
			v_turn.request_payload ->> 'locale', v_job.disclosure_grant_id
		) THEN
			RETURN NULL;
		END IF;
	END IF;
	v_result := emdo.claim_approval_resume_job_legacy_v5(
		p_decision_id, p_decision_request_id, p_current_space_access_grant_id
	);
	IF v_result ->> 'status' <> 'claimed' THEN
		RETURN v_result;
	END IF;
	IF v_root_id IS NULL THEN
		SELECT turn.* INTO v_turn
		FROM emdo.manager_turns AS turn
		WHERE turn.run_id = (v_result #>> '{binding,runId}')::uuid
		FOR SHARE OF turn;
		IF NOT FOUND
			OR v_turn.request_payload ->> 'rootManagerInvocationId' !~
				'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		THEN
			RAISE EXCEPTION USING ERRCODE = 'P0001',
				MESSAGE = 'approval resume lineage disappeared';
		END IF;
		v_root_id := (v_turn.request_payload ->> 'rootManagerInvocationId')::uuid;
	END IF;
	RETURN pg_catalog.jsonb_set(
		v_result, ARRAY['binding', 'rootManagerInvocationId'],
		pg_catalog.to_jsonb(v_root_id::text), true
	);
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
	IF v_status = 'completed' THEN
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
--> statement-breakpoint

ALTER FUNCTION "emdo"."settle_approval_resume_job"(uuid, text, text, text, jsonb)
	RENAME TO "settle_approval_resume_job_legacy_v5";
--> statement-breakpoint

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
	v_turn emdo.manager_turns%ROWTYPE;
	v_root_id uuid;
BEGIN
	IF p_claim_id IS NULL OR p_mode NOT IN (
		'complete', 'terminalize-not-dispatched', 'indeterminate'
	) THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	IF p_mode = 'complete'
		AND emdo.approval_resume_turn_result_is_valid(p_result)
			IS DISTINCT FROM true
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	SELECT resume.* INTO v_job
	FROM emdo.approval_resume_jobs AS resume
	WHERE resume.claim_id = p_claim_id
		AND resume.user_id = emdo.current_user_id()
	FOR SHARE OF resume;
	IF FOUND AND v_job.state = 'claimed' AND p_mode = 'complete' THEN
		SELECT turn.* INTO v_turn
		FROM emdo.manager_turns AS turn
		WHERE turn.run_id = v_job.run_id
			AND turn.household_id = v_job.household_id
			AND turn.space_id = v_job.space_id
			AND turn.user_id = v_job.user_id
		FOR SHARE OF turn;
		IF NOT FOUND
			OR pg_catalog.jsonb_typeof(v_turn.request_payload) IS DISTINCT FROM 'object'
			OR v_turn.request_payload ->> 'locale' NOT IN (
				'en-CA', 'fr-CA', 'ja-JP', 'ko-KR'
			)
			OR v_turn.request_payload ->> 'rootManagerInvocationId' !~
				'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		THEN
			RETURN pg_catalog.jsonb_build_object('status', 'conflict');
		END IF;
		v_root_id := (v_turn.request_payload ->> 'rootManagerInvocationId')::uuid;
		IF NOT emdo.registered_approval_resume_binding_is_valid(
			v_job.run_id, v_job.household_id, v_job.user_id, v_root_id,
			v_turn.request_payload ->> 'locale', v_job.disclosure_grant_id
		)
			OR NOT emdo.registered_specialist_outcomes_match_lineage(
				v_job.run_id, v_job.household_id, v_job.user_id, v_root_id,
				v_turn.request_payload ->> 'locale', p_result -> 'specialistOutcomes'
			)
		THEN
			RETURN pg_catalog.jsonb_build_object('status', 'conflict');
		END IF;
	END IF;
	RETURN emdo.settle_approval_resume_job_legacy_v5(
		p_claim_id, p_ownership_token, p_mode, p_reason_code, p_result
	);
END
$function$;
--> statement-breakpoint

-- Keep the new aggregates callable only through the application role. The
-- historic overloads remain only for migration-time internal delegation and
-- are never application entrypoints after this migration.
ALTER FUNCTION "emdo"."issue_model_disclosure_grant"(
	uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb
) OWNER TO emdo_disclosure_executor;
ALTER FUNCTION "emdo"."resolve_model_disclosure_grant"(
	uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, jsonb
) OWNER TO emdo_disclosure_executor;
ALTER FUNCTION "emdo"."resolve_consumed_disclosure_grant_for_proposal"(
	uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, text
) OWNER TO emdo_disclosure_executor;
ALTER FUNCTION "emdo"."commit_model_disclosure_authorization"(
	uuid, integer, text, jsonb, text, uuid, text, jsonb
) OWNER TO emdo_disclosure_executor;
ALTER FUNCTION "emdo"."record_model_disclosure_denial"(
	uuid, integer, text, jsonb, text, uuid, text, text
) OWNER TO emdo_disclosure_executor;
ALTER FUNCTION "emdo"."claim_manager_turn"(
	uuid, text, uuid, uuid, uuid, text, text, jsonb, uuid, uuid, text, text, text
) OWNER TO emdo_manager_turn_executor;
ALTER FUNCTION "emdo"."complete_manager_turn"(
	uuid, text, uuid, text, uuid, jsonb
) OWNER TO emdo_manager_turn_executor;
ALTER FUNCTION "emdo"."claim_approval_resume_job"(uuid, uuid, uuid)
	OWNER TO emdo_approval_resume_executor;
ALTER FUNCTION "emdo"."settle_approval_resume_job"(
	uuid, text, text, text, jsonb
) OWNER TO emdo_approval_resume_executor;
ALTER FUNCTION "emdo"."registered_agent_invocation_identity_is_valid"(jsonb)
	OWNER TO emdo_disclosure_executor;
ALTER FUNCTION "emdo"."registered_disclosure_allowlist_is_canonical"(jsonb)
	OWNER TO emdo_disclosure_executor;
ALTER FUNCTION "emdo"."registered_disclosure_run_is_current"(
	uuid, uuid, uuid, uuid, text, text, uuid
) OWNER TO emdo_disclosure_executor;
ALTER FUNCTION "emdo"."registered_agent_invocation_context_matches"(
	jsonb, text, jsonb, jsonb, timestamptz, text
) OWNER TO emdo_disclosure_executor;
ALTER FUNCTION "emdo"."registered_specialist_outcome_is_valid"(jsonb)
	OWNER TO emdo_manager_turn_executor;
ALTER FUNCTION "emdo"."registered_specialist_outcomes_match_lineage"(
	uuid, uuid, uuid, uuid, text, jsonb
) OWNER TO emdo_manager_turn_executor;
ALTER FUNCTION "emdo"."registered_manager_turn_result_is_valid"(jsonb)
	OWNER TO emdo_manager_turn_executor;
ALTER FUNCTION "emdo"."registered_approval_resume_binding_is_valid"(
	uuid, uuid, uuid, uuid, text, uuid
) OWNER TO emdo_approval_resume_executor;
ALTER FUNCTION "emdo"."approval_resume_turn_result_is_valid"(jsonb)
	OWNER TO emdo_approval_resume_executor;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
	"emdo"."issue_model_disclosure_grant"(
		uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb
	),
	"emdo"."resolve_model_disclosure_grant"(
		uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb
	),
	"emdo"."commit_model_disclosure_authorization"(
		uuid, integer, text, uuid, text, jsonb
	),
	"emdo"."record_model_disclosure_denial"(
		uuid, integer, text, uuid, text, text
	),
	"emdo"."claim_approval_resume_job_legacy_v5"(uuid, uuid, uuid),
	"emdo"."settle_approval_resume_job_legacy_v5"(
		uuid, text, text, text, jsonb
	)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login,
	emdo_proposal_reconciliation_executor, emdo_approval_resume_executor,
	emdo_manager_turn_executor;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
	"emdo"."issue_model_disclosure_grant"(
		uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb
	),
	"emdo"."resolve_model_disclosure_grant"(
		uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, jsonb
	),
	"emdo"."resolve_consumed_disclosure_grant_for_proposal"(
		uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, text
	),
	"emdo"."commit_model_disclosure_authorization"(
		uuid, integer, text, jsonb, text, uuid, text, jsonb
	),
	"emdo"."record_model_disclosure_denial"(
		uuid, integer, text, jsonb, text, uuid, text, text
	)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login,
	emdo_proposal_reconciliation_executor, emdo_approval_resume_executor,
	emdo_manager_turn_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."issue_model_disclosure_grant"(
		uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb
	),
	"emdo"."resolve_model_disclosure_grant"(
		uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, jsonb
	),
	"emdo"."resolve_consumed_disclosure_grant_for_proposal"(
		uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, text
	),
	"emdo"."commit_model_disclosure_authorization"(
		uuid, integer, text, jsonb, text, uuid, text, jsonb
	),
	"emdo"."record_model_disclosure_denial"(
		uuid, integer, text, jsonb, text, uuid, text, text
	)
	TO emdo_app;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
	"emdo"."registered_agent_invocation_identity_is_valid"(jsonb),
	"emdo"."registered_disclosure_allowlist_is_canonical"(jsonb),
	"emdo"."registered_disclosure_run_is_current"(
		uuid, uuid, uuid, uuid, text, text, uuid
	),
	"emdo"."registered_agent_invocation_context_matches"(
		jsonb, text, jsonb, jsonb, timestamptz, text
	),
	"emdo"."registered_specialist_outcome_is_valid"(jsonb),
	"emdo"."registered_specialist_outcomes_match_lineage"(
		uuid, uuid, uuid, uuid, text, jsonb
	),
	"emdo"."registered_manager_turn_result_is_valid"(jsonb),
	"emdo"."registered_approval_resume_binding_is_valid"(
		uuid, uuid, uuid, uuid, text, uuid
	),
	"emdo"."approval_resume_turn_result_is_valid"(jsonb)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login,
	emdo_proposal_reconciliation_executor, emdo_approval_resume_executor,
	emdo_manager_turn_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."registered_agent_invocation_identity_is_valid"(jsonb),
	"emdo"."registered_disclosure_allowlist_is_canonical"(jsonb),
	"emdo"."registered_agent_invocation_context_matches"(
		jsonb, text, jsonb, jsonb, timestamptz, text
	)
	TO emdo_disclosure_executor, emdo_manager_turn_executor,
	emdo_approval_resume_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."registered_disclosure_run_is_current"(
		uuid, uuid, uuid, uuid, text, text, uuid
	)
	TO emdo_disclosure_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."registered_specialist_outcome_is_valid"(jsonb),
	"emdo"."registered_specialist_outcomes_match_lineage"(
		uuid, uuid, uuid, uuid, text, jsonb
	),
	"emdo"."registered_manager_turn_result_is_valid"(jsonb)
	TO emdo_manager_turn_executor, emdo_approval_resume_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."registered_approval_resume_binding_is_valid"(
		uuid, uuid, uuid, uuid, text, uuid
	),
	"emdo"."approval_resume_turn_result_is_valid"(jsonb)
	TO emdo_approval_resume_executor;
--> statement-breakpoint

-- These shared SECURITY INVOKER helpers execute as the bounded aggregate
-- owner. The manager executor already has this chain; grant only the missing
-- transitive calls required by the new disclosure and approval-resume paths.
GRANT EXECUTE ON FUNCTION
	"emdo"."canonical_json_text"(jsonb),
	"emdo"."canonical_json_hash"(jsonb),
	"emdo"."jsonb_object_has_exact_keys"(jsonb, text[])
	TO emdo_disclosure_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."canonical_json_text"(jsonb),
	"emdo"."canonical_json_hash"(jsonb)
	TO emdo_approval_resume_executor;
--> statement-breakpoint

-- The replacement resume aggregates keep the established terminal CAS bodies
-- private, but their fixed SECURITY DEFINER owner must invoke them internally.
GRANT EXECUTE ON FUNCTION
	"emdo"."claim_approval_resume_job_legacy_v5"(uuid, uuid, uuid),
	"emdo"."settle_approval_resume_job_legacy_v5"(
		uuid, text, text, text, jsonb
	)
	TO emdo_approval_resume_executor;
--> statement-breakpoint

-- The proposal-only resolver verifies that the one permitted disclosure was
-- actually sent. The executor may inspect only this user-owned, metadata-only
-- audit event type; emdo_app still has no direct table privilege.
GRANT SELECT ON "emdo"."audit_events" TO emdo_disclosure_executor;
CREATE POLICY disclosure_sent_audit_executor_read
	ON "emdo"."audit_events"
	FOR SELECT TO emdo_disclosure_executor
	USING (
		event_type = 'model.disclosure.sent'
		AND original_owner_user_id = (SELECT emdo.current_user_id())
		AND actor_user_id = (SELECT emdo.current_user_id())
	);
--> statement-breakpoint

-- Issuance and resolution bind a disclosure to the persisted manager root
-- under FOR SHARE. Permit only the current owner's rows and the one column
-- privilege PostgreSQL requires for that lock; the executor never writes it.
GRANT SELECT, UPDATE (run_id) ON "emdo"."manager_turns"
	TO emdo_disclosure_executor;
CREATE POLICY disclosure_manager_turns_executor_select
	ON "emdo"."manager_turns"
	FOR SELECT TO emdo_disclosure_executor
	USING (user_id = (SELECT emdo.current_user_id()));
CREATE POLICY disclosure_manager_turns_executor_lock
	ON "emdo"."manager_turns"
	FOR UPDATE TO emdo_disclosure_executor
	USING (user_id = (SELECT emdo.current_user_id()))
	WITH CHECK (user_id = (SELECT emdo.current_user_id()));
--> statement-breakpoint

REVOKE ALL ON FUNCTION
	"emdo"."claim_manager_turn"(
		uuid, text, uuid, uuid, uuid, text, text, jsonb,
		uuid, uuid, text, text, text
	),
	"emdo"."complete_manager_turn"(
		uuid, text, uuid, text, uuid, jsonb
	),
	"emdo"."claim_approval_resume_job"(uuid, uuid, uuid),
	"emdo"."settle_approval_resume_job"(uuid, text, text, text, jsonb)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login,
	emdo_proposal_reconciliation_executor, emdo_approval_resume_executor,
	emdo_manager_turn_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."claim_manager_turn"(
		uuid, text, uuid, uuid, uuid, text, text, jsonb,
		uuid, uuid, text, text, text
	),
	"emdo"."complete_manager_turn"(
		uuid, text, uuid, text, uuid, jsonb
	),
	"emdo"."claim_approval_resume_job"(uuid, uuid, uuid),
	"emdo"."settle_approval_resume_job"(uuid, text, text, text, jsonb)
	TO emdo_app;
--> statement-breakpoint

-- SELECT ... FOR SHARE in the approval-resume validators needs a column
-- UPDATE privilege plus a matching UPDATE policy even though the validators
-- never modify these immutable rows. Scope the lock visibility to the one
-- user/session-bound ready or claimed resume job.
GRANT SELECT, UPDATE (run_id) ON "emdo"."manager_turns"
	TO emdo_approval_resume_executor;
GRANT UPDATE (id) ON "emdo"."disclosure_grants"
	TO emdo_approval_resume_executor;
CREATE POLICY approval_resume_manager_turns_executor_select
	ON "emdo"."manager_turns"
	FOR SELECT TO emdo_approval_resume_executor
	USING (
		user_id = (SELECT emdo.current_user_id())
		AND EXISTS (
			SELECT 1 FROM emdo.approval_resume_jobs AS resume
			WHERE resume.run_id = manager_turns.run_id
				AND resume.household_id = manager_turns.household_id
				AND resume.space_id = manager_turns.space_id
				AND resume.user_id = manager_turns.user_id
				AND resume.user_id = (SELECT emdo.current_user_id())
				AND resume.state IN ('ready', 'claimed', 'terminal', 'indeterminate')
		)
	);
CREATE POLICY approval_resume_manager_turns_executor_lock
	ON "emdo"."manager_turns"
	FOR UPDATE TO emdo_approval_resume_executor
	USING (
		user_id = (SELECT emdo.current_user_id())
		AND EXISTS (
			SELECT 1 FROM emdo.approval_resume_jobs AS resume
			WHERE resume.run_id = manager_turns.run_id
				AND resume.household_id = manager_turns.household_id
				AND resume.space_id = manager_turns.space_id
				AND resume.user_id = manager_turns.user_id
				AND resume.user_id = (SELECT emdo.current_user_id())
				AND (
					(
						resume.state = 'ready'
						AND resume.authenticated_session_id =
							(SELECT emdo.current_session_id())
					)
					OR (
						resume.state = 'claimed'
						AND resume.authenticated_session_id =
							(SELECT emdo.current_session_id())
						AND resume.resume_request_id =
							(SELECT emdo.current_request_id())
					)
				)
		)
	)
	WITH CHECK (
		user_id = (SELECT emdo.current_user_id())
		AND EXISTS (
			SELECT 1 FROM emdo.approval_resume_jobs AS resume
			WHERE resume.run_id = manager_turns.run_id
				AND resume.household_id = manager_turns.household_id
				AND resume.space_id = manager_turns.space_id
				AND resume.user_id = manager_turns.user_id
				AND resume.user_id = (SELECT emdo.current_user_id())
				AND (
					(
						resume.state = 'ready'
						AND resume.authenticated_session_id =
							(SELECT emdo.current_session_id())
					)
					OR (
						resume.state = 'claimed'
						AND resume.authenticated_session_id =
							(SELECT emdo.current_session_id())
						AND resume.resume_request_id =
							(SELECT emdo.current_request_id())
					)
				)
		)
	);
CREATE POLICY approval_resume_disclosures_executor_lock
	ON "emdo"."disclosure_grants"
	FOR UPDATE TO emdo_approval_resume_executor
	USING (
		EXISTS (
			SELECT 1 FROM emdo.approval_resume_jobs AS resume
			WHERE resume.disclosure_grant_id = disclosure_grants.id
				AND resume.household_id = disclosure_grants.household_id
				AND resume.space_id = disclosure_grants.space_id
				AND resume.user_id = disclosure_grants.user_id
				AND resume.user_id = (SELECT emdo.current_user_id())
				AND (
					(
						resume.state = 'ready'
						AND resume.authenticated_session_id =
							(SELECT emdo.current_session_id())
					)
					OR (
						resume.state = 'claimed'
						AND resume.authenticated_session_id =
							(SELECT emdo.current_session_id())
						AND resume.resume_request_id =
							(SELECT emdo.current_request_id())
					)
				)
		)
	)
	WITH CHECK (
		EXISTS (
			SELECT 1 FROM emdo.approval_resume_jobs AS resume
			WHERE resume.disclosure_grant_id = disclosure_grants.id
				AND resume.household_id = disclosure_grants.household_id
				AND resume.space_id = disclosure_grants.space_id
				AND resume.user_id = disclosure_grants.user_id
				AND resume.user_id = (SELECT emdo.current_user_id())
				AND (
					(
						resume.state = 'ready'
						AND resume.authenticated_session_id =
							(SELECT emdo.current_session_id())
					)
					OR (
						resume.state = 'claimed'
						AND resume.authenticated_session_id =
							(SELECT emdo.current_session_id())
						AND resume.resume_request_id =
							(SELECT emdo.current_request_id())
					)
				)
		)
	);


-- Proposal creation must compare the same immutable disclosure envelope that
-- was issued for this registered invocation. This forward replacement keeps
-- the guarded Finance contract fail-closed for both initial commits and
-- idempotent replays.
CREATE OR REPLACE FUNCTION "emdo"."commit_provider_proposal_create"(
	p_operation_id text,
	p_input jsonb
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_claim emdo.workflow_operation_claims%ROWTYPE;
	v_proposal emdo.action_proposals%ROWTYPE;
	v_state emdo.proposal_states%ROWTYPE;
	v_disclosure emdo.disclosure_grants%ROWTYPE;
	v_id uuid;
	v_created_at timestamptz;
	v_expires_at timestamptz;
	v_mutation_hash text;
	v_now timestamptz;
	v_locked record;
BEGIN
	IF p_operation_id IS NULL
		OR pg_catalog.jsonb_typeof(p_input) IS DISTINCT FROM 'object'
		OR pg_catalog.octet_length(p_input::text) > 524288
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input, ARRAY['proposal', 'preparation', 'scope', 'event']::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'proposal',
			CASE WHEN (p_input -> 'proposal') ? 'guardedAction' THEN ARRAY[
				'schemaVersion', 'id', 'version', 'runId', 'capabilityId',
				'capabilityFingerprint', 'authorizationScopeFingerprint',
				'canonicalArguments', 'targets', 'beforePreview', 'afterPreview',
				'providerPreconditions', 'approvalDisplay',
				'providerAuthorityBindingHash', 'providerSdkCallId',
				'guardedAction', 'payloadHash', 'approvalHash',
				'disclosureGrant', 'createdAt', 'expiresAt', 'idempotencyKey',
				'state'
			]::text[] ELSE ARRAY[
				'schemaVersion', 'id', 'version', 'runId', 'capabilityId',
				'capabilityFingerprint', 'authorizationScopeFingerprint',
				'canonicalArguments', 'targets', 'beforePreview', 'afterPreview',
				'providerPreconditions', 'approvalDisplay',
				'providerAuthorityBindingHash', 'providerSdkCallId', 'payloadHash',
				'approvalHash', 'disclosureGrant', 'createdAt', 'expiresAt',
				'idempotencyKey', 'state'
			]::text[] END
		)
		OR NOT emdo.proposal_approval_display_is_valid(
			p_input #> '{proposal,approvalDisplay}'
		)
		OR ((p_input -> 'proposal') ? 'guardedAction'
			AND NOT emdo.finance_guarded_action_proposal_is_valid(
				p_input #>> '{proposal,capabilityId}',
				p_input #>> '{proposal,payloadHash}',
				p_input #>> '{proposal,providerAuthorityBindingHash}',
				p_input #> '{proposal,canonicalArguments}',
				p_input #> '{proposal,guardedAction}'
			))
		OR (p_input #>> '{proposal,capabilityId}' IN (
			'finance.records.write', 'finance.statement.import'
		) AND NOT ((p_input -> 'proposal') ? 'guardedAction'))
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'preparation', ARRAY['binding', 'bindingHash']::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input #> '{preparation,binding}',
			ARRAY[
				'proposalId', 'originRequestId', 'originSpaceAccessGrantId',
				'originSessionId', 'runId', 'householdId', 'userId', 'agentId',
				'disclosureGrantId', 'disclosurePolicyVersion',
				'capabilityId', 'sdkCallId',
				'providerAuthorityBindingHash'
			]::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'event',
			ARRAY['proposalId', 'eventType', 'occurredAt']::text[]
		)
	THEN
		RETURN 'conflict';
	END IF;
	IF NOT emdo.issue_workflow_operation_claim(
		p_operation_id, p_input -> 'scope', NULL, NULL, NULL,
		p_input #>> '{preparation,bindingHash}',
		p_input #>> '{proposal,providerAuthorityBindingHash}', p_input
	) THEN
		RETURN 'conflict';
	END IF;
	v_mutation_hash := emdo.provider_proposal_mutation_hash(
		'proposal-create', p_input
	);
	SELECT claim.* INTO v_claim
	FROM emdo.workflow_operation_claims AS claim
	WHERE claim.operation_id = p_operation_id
	FOR UPDATE OF claim;
	IF NOT FOUND
		OR v_claim.phase IS DISTINCT FROM 'proposal-create'
		OR v_claim.mutation_hash IS DISTINCT FROM v_mutation_hash
	THEN
		RETURN 'conflict';
	END IF;
	v_id := (p_input #>> '{proposal,id}')::uuid;
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(v_id::text, 0)
	);
	IF v_claim.claimed_at IS NOT NULL THEN
		SELECT ROW(proposal.*)::emdo.action_proposals AS proposal_row,
			ROW(state.*)::emdo.proposal_states AS state_row
		INTO v_locked
		FROM emdo.action_proposals AS proposal
		JOIN emdo.proposal_states AS state ON state.proposal_id = proposal.id
		WHERE proposal.id = v_id
		FOR UPDATE OF proposal, state;
		IF FOUND THEN
			v_proposal := v_locked.proposal_row;
			v_state := v_locked.state_row;
		END IF;
		RETURN CASE WHEN FOUND
			AND v_proposal.authorization_scope_fingerprint =
				v_claim.authorization_scope_fingerprint
			AND emdo.proposal_row_matches_input(
				v_proposal, v_state.version, v_state.state,
				p_input -> 'proposal'
			)
			AND EXISTS (
				SELECT 1 FROM emdo.proposal_preparations AS preparation
				WHERE preparation.proposal_id = v_id
					AND preparation.preparation_binding =
						p_input #> '{preparation,binding}'
					AND preparation.preparation_binding_hash =
						p_input #>> '{preparation,bindingHash}'
					AND preparation.abandonment_reason IS NULL
			)
			AND EXISTS (
				SELECT 1 FROM emdo.proposal_events AS event
				WHERE event.proposal_id = v_id AND event.sequence = 1
					AND event.payload = p_input -> 'event'
			)
		THEN 'duplicate' ELSE 'conflict' END;
	END IF;
	IF NOT emdo.claim_workflow_operation_scope(p_operation_id) THEN
		RETURN 'conflict';
	END IF;
	IF p_input -> 'scope' IS DISTINCT FROM v_claim.scope_assertion
		OR p_input #>> '{proposal,id}' IS DISTINCT FROM v_claim.proposal_id::text
		OR p_input #>> '{proposal,runId}' IS DISTINCT FROM v_claim.run_id::text
		OR p_input #>> '{proposal,providerSdkCallId}' IS DISTINCT FROM
			v_claim.provider_sdk_call_id
		OR p_input #>> '{proposal,providerAuthorityBindingHash}' IS DISTINCT FROM
			v_claim.provider_authority_binding_hash
		OR p_input #>> '{proposal,authorizationScopeFingerprint}' IS DISTINCT FROM
			v_claim.authorization_scope_fingerprint
		OR p_input #>> '{proposal,disclosureGrant,id}' IS DISTINCT FROM
			v_claim.disclosure_grant_id::text
		OR p_input #>> '{proposal,disclosureGrant,version}' IS DISTINCT FROM
			v_claim.disclosure_grant_version::text
		OR p_input #>> '{preparation,bindingHash}' IS DISTINCT FROM
			v_claim.preparation_binding_hash
		OR p_input #>> '{preparation,binding,proposalId}' IS DISTINCT FROM
			v_claim.proposal_id::text
		OR p_input #>> '{preparation,binding,originRequestId}' IS DISTINCT FROM
			v_claim.origin_request_id::text
		OR p_input #>> '{preparation,binding,runId}' IS DISTINCT FROM
			v_claim.run_id::text
		OR p_input #>> '{preparation,binding,householdId}' IS DISTINCT FROM
			v_claim.household_id::text
		OR p_input #>> '{preparation,binding,userId}' IS DISTINCT FROM
			v_claim.user_id::text
		OR p_input #>> '{preparation,binding,originSpaceAccessGrantId}'
			IS DISTINCT FROM v_claim.origin_space_access_grant_id::text
		OR p_input #>> '{preparation,binding,originSessionId}'
			IS DISTINCT FROM v_claim.origin_session_id::text
		OR p_input #>> '{preparation,binding,disclosureGrantId}' IS DISTINCT FROM
			v_claim.disclosure_grant_id::text
		OR p_input #>> '{preparation,binding,disclosurePolicyVersion}' !~
			'^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
		OR p_input #>> '{preparation,binding,sdkCallId}' IS DISTINCT FROM
			v_claim.provider_sdk_call_id
		OR p_input #>> '{preparation,binding,providerAuthorityBindingHash}'
			IS DISTINCT FROM v_claim.provider_authority_binding_hash
		OR (p_input #>> '{proposal,schemaVersion}')::smallint IS DISTINCT FROM 1
		OR (p_input #>> '{proposal,version}')::integer IS DISTINCT FROM 1
		OR p_input #>> '{proposal,state}' IS DISTINCT FROM 'pending'
		OR p_input #>> '{event,proposalId}' IS DISTINCT FROM v_claim.proposal_id::text
		OR p_input #>> '{event,eventType}' IS DISTINCT FROM 'proposal.created'
	THEN
		RETURN 'conflict';
	END IF;
	SELECT disclosure.* INTO v_disclosure
	FROM emdo.disclosure_grants AS disclosure
	WHERE disclosure.id = v_claim.disclosure_grant_id
		AND disclosure.household_id = v_claim.household_id
		AND disclosure.space_id = v_claim.space_id
		AND disclosure.user_id = v_claim.user_id
		AND disclosure.run_id = v_claim.run_id
		AND disclosure.version = v_claim.disclosure_grant_version
		AND disclosure.grant_hash = v_claim.disclosure_grant_hash
	FOR SHARE OF disclosure;
	IF NOT FOUND
		OR p_input #> '{proposal,disclosureGrant}' IS DISTINCT FROM
			pg_catalog.jsonb_build_object(
				'schemaVersion', v_disclosure.schema_version,
				'id', v_disclosure.id,
				'version', v_disclosure.version,
				'userId', v_disclosure.user_id,
				'householdId', v_disclosure.household_id,
				'agentId', v_disclosure.agent_id,
				'purpose', v_disclosure.purpose,
				'runId', v_disclosure.run_id,
				'recordAllowlist', v_disclosure.record_allowlist,
				'provider', v_disclosure.provider,
				'createdAt', pg_catalog.to_char(
					v_disclosure.created_at AT TIME ZONE 'UTC',
					'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
				),
				'expiresAt', pg_catalog.to_char(
					v_disclosure.expires_at AT TIME ZONE 'UTC',
					'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
				),
				'oneRunOnly', v_disclosure.one_run_only,
				'invocationContext', v_disclosure.invocation_context,
				'invocationContextHash', v_disclosure.invocation_context_hash
			)
	THEN
		RETURN 'conflict';
	END IF;
	v_created_at := (p_input #>> '{proposal,createdAt}')::timestamptz;
	v_expires_at := (p_input #>> '{proposal,expiresAt}')::timestamptz;
	v_now := pg_catalog.clock_timestamp();
	IF v_created_at > v_now + interval '5 seconds' OR v_expires_at <= v_now
		OR v_expires_at > v_created_at + interval '10 minutes'
		OR (p_input #>> '{event,occurredAt}')::timestamptz
			IS DISTINCT FROM v_created_at
	THEN
		RETURN 'conflict';
	END IF;
	INSERT INTO emdo.action_proposals(
		id, schema_version, household_id, space_id, original_owner_user_id,
		run_id, disclosure_grant_id, capability_id, capability_fingerprint,
		canonical_arguments, targets, before_preview, after_preview,
		provider_preconditions, approval_display, guarded_action,
		provider_authority_binding_hash, authorization_scope_fingerprint,
		provider_sdk_call_id, payload_hash, approval_hash, disclosure_grant,
		idempotency_key, created_at, expires_at
	) VALUES (
		v_claim.proposal_id, 1, v_claim.household_id, v_claim.space_id,
		v_claim.user_id, v_claim.run_id, v_claim.disclosure_grant_id,
		p_input #>> '{proposal,capabilityId}',
		p_input #>> '{proposal,capabilityFingerprint}',
		p_input #> '{proposal,canonicalArguments}',
		p_input #> '{proposal,targets}', p_input #> '{proposal,beforePreview}',
		p_input #> '{proposal,afterPreview}',
		p_input #> '{proposal,providerPreconditions}',
		p_input #> '{proposal,approvalDisplay}',
		p_input #> '{proposal,guardedAction}',
		v_claim.provider_authority_binding_hash,
		v_claim.authorization_scope_fingerprint, v_claim.provider_sdk_call_id,
		p_input #>> '{proposal,payloadHash}',
		p_input #>> '{proposal,approvalHash}',
		p_input #> '{proposal,disclosureGrant}',
		p_input #>> '{proposal,idempotencyKey}', v_created_at, v_expires_at
	);
	INSERT INTO emdo.proposal_states(
		proposal_id, household_id, space_id, original_owner_user_id,
		version, state, updated_at
	) VALUES (
		v_claim.proposal_id, v_claim.household_id, v_claim.space_id,
		v_claim.user_id, 1, 'pending', v_now
	);
	INSERT INTO emdo.proposal_preparations(
		proposal_id, household_id, space_id, original_owner_user_id,
		preparation_binding, preparation_binding_hash
	) VALUES (
		v_claim.proposal_id, v_claim.household_id, v_claim.space_id,
		v_claim.user_id, p_input #> '{preparation,binding}',
		v_claim.preparation_binding_hash
	);
	INSERT INTO emdo.proposal_events(
		proposal_id, household_id, space_id, original_owner_user_id,
		proposal_version, sequence, event_type, payload, occurred_at
	) VALUES (
		v_claim.proposal_id, v_claim.household_id, v_claim.space_id,
		v_claim.user_id, 1, 1, 'proposal.created', p_input -> 'event',
		v_created_at
	);
	RETURN 'created';
EXCEPTION
	WHEN invalid_text_representation OR invalid_datetime_format
		OR datetime_field_overflow OR numeric_value_out_of_range
		OR not_null_violation OR check_violation OR foreign_key_violation
		OR unique_violation THEN
		RETURN 'conflict';
END
$function$;
--> statement-breakpoint

ALTER FUNCTION "emdo"."commit_provider_proposal_create"(text, jsonb)
	OWNER TO emdo_workflow_executor;
REVOKE ALL ON FUNCTION
	"emdo"."commit_provider_proposal_create"(text, jsonb)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login, emdo_visual_decision_login,
	emdo_proposal_reconciliation_executor, emdo_approval_resume_executor,
	emdo_manager_turn_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."commit_provider_proposal_create"(text, jsonb)
	TO emdo_workflow_login;

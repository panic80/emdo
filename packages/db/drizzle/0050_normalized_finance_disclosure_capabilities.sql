-- Permit the exact registered normalized Finance capability set.
-- Preserve the legacy exact set for saved invocation/proposal compatibility;
-- subsets, reordered arrays and extra capabilities remain rejected.

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
				AND (p_invocation_identity -> 'grantedCapabilities' IS DISTINCT FROM
					'["finance.analytics.calculate","finance.documents.read","finance.documents.search","finance.matches.read","finance.records.read","finance.records.write","finance.statement.import"]'::jsonb
 AND p_invocation_identity -> 'grantedCapabilities' IS DISTINCT FROM '["finance.analytics.calculate","finance.books.read","finance.documents.read","finance.documents.search","finance.matches.read","finance.records.read","finance.records.write","finance.reports.inspect","finance.reports.propose-mapping","finance.statement.import","finance.tax.read"]'::jsonb)
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

CREATE OR REPLACE FUNCTION "emdo"."resolve_consumed_disclosure_grant_for_proposal"(
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
					AND (p_invocation_context -> 'grantedCapabilities' IS DISTINCT FROM
						'["finance.analytics.calculate","finance.documents.read","finance.documents.search","finance.matches.read","finance.records.read","finance.records.write","finance.statement.import"]'::jsonb
 AND p_invocation_context -> 'grantedCapabilities' IS DISTINCT FROM '["finance.analytics.calculate","finance.books.read","finance.documents.read","finance.documents.search","finance.matches.read","finance.records.read","finance.records.write","finance.reports.inspect","finance.reports.propose-mapping","finance.statement.import","finance.tax.read"]'::jsonb)
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
			AND (v_context -> 'grantedCapabilities' IS DISTINCT FROM
				'["finance.analytics.calculate","finance.documents.read","finance.documents.search","finance.matches.read","finance.records.read","finance.records.write","finance.statement.import"]'::jsonb
 AND v_context -> 'grantedCapabilities' IS DISTINCT FROM '["finance.analytics.calculate","finance.books.read","finance.documents.read","finance.documents.search","finance.matches.read","finance.records.read","finance.records.write","finance.reports.inspect","finance.reports.propose-mapping","finance.statement.import","finance.tax.read"]'::jsonb))
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

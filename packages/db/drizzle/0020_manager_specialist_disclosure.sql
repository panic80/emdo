-- Manager-owned runs may disclose only to fixed registered specialists during execution.
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
		AND run.status IN ('queued', 'running')
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

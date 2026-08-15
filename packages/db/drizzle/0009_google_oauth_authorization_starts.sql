CREATE TABLE "emdo"."google_oauth_authorization_starts" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"private_space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"purpose" text NOT NULL,
	"result" jsonb NOT NULL,
	"flow_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "google_oauth_authorization_starts_scope_key_unique"
		UNIQUE("household_id", "private_space_id", "original_owner_user_id", "session_id", "idempotency_key"),
	CONSTRAINT "google_oauth_authorization_starts_household_space_fk"
		FOREIGN KEY ("household_id", "private_space_id")
		REFERENCES "emdo"."spaces"("household_id", "id")
		ON DELETE restrict ON UPDATE restrict,
	CONSTRAINT "google_oauth_authorization_starts_owner_membership_fk"
		FOREIGN KEY ("household_id", "original_owner_user_id")
		REFERENCES "emdo"."household_memberships"("household_id", "user_id")
		ON DELETE restrict ON UPDATE restrict,
	CONSTRAINT "google_oauth_authorization_starts_flow_fk"
		FOREIGN KEY ("flow_id") REFERENCES "emdo"."google_oauth_flows"("id")
		ON DELETE set null ON UPDATE restrict,
	CONSTRAINT "google_oauth_authorization_starts_key_check"
		CHECK (pg_catalog.length("idempotency_key") BETWEEN 16 AND 200
			AND "idempotency_key" ~ '^[A-Za-z0-9:._-]+$'),
	CONSTRAINT "google_oauth_authorization_starts_fingerprint_check"
		CHECK ("request_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "google_oauth_authorization_starts_purpose_check"
		CHECK ("purpose" IN ('calendar-read', 'calendar-event-write')),
	CONSTRAINT "google_oauth_authorization_starts_result_check"
		CHECK (pg_catalog.jsonb_typeof("result") = 'object'
			AND pg_catalog.octet_length("result"::text) BETWEEN 1 AND 8192),
	CONSTRAINT "google_oauth_authorization_starts_retention_check"
		CHECK ("retain_until" > "created_at"
			AND "retain_until" <= "created_at" + interval '24 hours')
);
--> statement-breakpoint
CREATE INDEX "google_oauth_authorization_starts_expiry_idx"
	ON "emdo"."google_oauth_authorization_starts" ("retain_until");
--> statement-breakpoint
ALTER TABLE "emdo"."google_oauth_authorization_starts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."google_oauth_authorization_starts" FORCE ROW LEVEL SECURITY;
CREATE POLICY google_oauth_authorization_starts_executor_scope
	ON "emdo"."google_oauth_authorization_starts"
	FOR ALL TO emdo_oauth_flow_executor USING (true) WITH CHECK (true);
CREATE POLICY google_oauth_flows_executor_insert
	ON "emdo"."google_oauth_flows"
	FOR INSERT TO emdo_oauth_flow_executor WITH CHECK (true);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.commit_google_oauth_authorization_start(
	p_user_id uuid,
	p_household_id uuid,
	p_private_space_id uuid,
	p_session_id uuid,
	p_idempotency_key text,
	p_request_fingerprint text,
	p_purpose text,
	p_result jsonb,
	p_flow jsonb
)
RETURNS TABLE (status text, result jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_now timestamp with time zone := pg_catalog.clock_timestamp();
	v_expected_fingerprint text;
	v_existing emdo.google_oauth_authorization_starts%ROWTYPE;
	v_created_at timestamp with time zone;
	v_expires_at timestamp with time zone;
	v_flow_id text;
	v_result_status text;
BEGIN
	IF p_user_id IS DISTINCT FROM emdo.current_user_id()
		OR p_session_id IS DISTINCT FROM emdo.current_session_id()
		OR p_household_id IS NULL
		OR p_private_space_id IS NULL
		OR NOT emdo.lock_active_request_scope(
			p_household_id, p_private_space_id, NULL
		)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '42501',
			MESSAGE = 'google oauth authorization scope is unavailable';
	END IF;

	IF p_idempotency_key IS NULL
		OR pg_catalog.length(p_idempotency_key) NOT BETWEEN 16 AND 200
		OR p_idempotency_key !~ '^[A-Za-z0-9:._-]+$'
		OR p_purpose NOT IN ('calendar-read', 'calendar-event-write')
		OR p_request_fingerprint !~ '^[a-f0-9]{64}$'
	THEN
		RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid google oauth authorization start';
	END IF;
	v_expected_fingerprint := emdo.canonical_json_hash(
		pg_catalog.jsonb_build_object(
			'domain', 'emdo.google-calendar.oauth-start.v1',
			'purpose', p_purpose
		)
	);
	IF p_request_fingerprint IS DISTINCT FROM v_expected_fingerprint THEN
		RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid google oauth request fingerprint';
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			p_household_id::text || ':' || p_private_space_id::text || ':' ||
			p_user_id::text || ':' || p_session_id::text || ':' || p_idempotency_key,
			0
		)
	);
	SELECT stored.* INTO v_existing
	FROM emdo.google_oauth_authorization_starts AS stored
	WHERE stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_user_id
		AND stored.session_id = p_session_id
		AND stored.idempotency_key = p_idempotency_key
	FOR UPDATE;
	IF FOUND THEN
		IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
			OR v_existing.purpose IS DISTINCT FROM p_purpose
		THEN
			RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
			RETURN;
		END IF;
		IF v_existing.result ->> 'status' = 'authorization-required'
			AND pg_catalog.pg_input_is_valid(
				v_existing.result ->> 'expiresAt', 'timestamp with time zone'
			)
			AND (v_existing.result ->> 'expiresAt')::timestamp with time zone <= v_now
		THEN
			RETURN QUERY SELECT 'expired'::text, NULL::jsonb;
			RETURN;
		END IF;
		RETURN QUERY SELECT 'replayed'::text, v_existing.result;
		RETURN;
	END IF;

	IF p_result IS NULL OR pg_catalog.jsonb_typeof(p_result) <> 'object'
		OR pg_catalog.octet_length(p_result::text) NOT BETWEEN 1 AND 8192
	THEN
		RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid google oauth authorization result';
	END IF;
	v_result_status := p_result ->> 'status';
	IF v_result_status = 'already-authorized' THEN
		IF p_flow IS NOT NULL
			OR NOT emdo.jsonb_object_has_exact_keys(
				p_result, ARRAY['status', 'grantedPurposes']::text[]
			)
			OR pg_catalog.jsonb_typeof(p_result -> 'grantedPurposes') <> 'array'
			OR pg_catalog.jsonb_array_length(p_result -> 'grantedPurposes') NOT BETWEEN 1 AND 2
			OR NOT (p_result -> 'grantedPurposes') ? p_purpose
			OR EXISTS (
				SELECT 1
				FROM pg_catalog.jsonb_array_elements_text(
					p_result -> 'grantedPurposes'
				) AS granted(purpose)
				WHERE granted.purpose NOT IN ('calendar-read', 'calendar-event-write')
			)
			OR (
				SELECT pg_catalog.count(*)
				FROM pg_catalog.jsonb_array_elements_text(
					p_result -> 'grantedPurposes'
				) AS granted(purpose)
			) IS DISTINCT FROM (
				SELECT pg_catalog.count(DISTINCT granted.purpose)
				FROM pg_catalog.jsonb_array_elements_text(
					p_result -> 'grantedPurposes'
				) AS granted(purpose)
			)
		THEN
			RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid already-authorized result';
		END IF;
	ELSIF v_result_status = 'authorization-required' THEN
		IF p_flow IS NULL
			OR NOT emdo.jsonb_object_has_exact_keys(
				p_result, ARRAY['status', 'authorizationUrl', 'expiresAt']::text[]
			)
			OR pg_catalog.jsonb_typeof(p_result -> 'authorizationUrl') <> 'string'
			OR NOT emdo.jsonb_object_has_exact_keys(
				p_flow,
				ARRAY[
					'id', 'actor', 'redirectUri', 'purpose', 'requestedScopes',
					'credentialRevisionAtStart', 'authorizationEpochAtStart',
					'codeVerifier', 'createdAt', 'expiresAt'
				]::text[]
			)
			OR NOT emdo.jsonb_object_has_exact_keys(
				p_flow -> 'actor',
				ARRAY['userId', 'householdId', 'privateSpaceId', 'sessionId']::text[]
			)
		THEN
			RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid google oauth flow shape';
		END IF;
		v_flow_id := p_flow ->> 'id';
		IF v_flow_id !~ '^[A-Za-z0-9_-]{43}$'
			OR p_flow #>> '{actor,userId}' IS DISTINCT FROM p_user_id::text
			OR p_flow #>> '{actor,householdId}' IS DISTINCT FROM p_household_id::text
			OR p_flow #>> '{actor,privateSpaceId}' IS DISTINCT FROM p_private_space_id::text
			OR p_flow #>> '{actor,sessionId}' IS DISTINCT FROM p_session_id::text
			OR p_flow ->> 'purpose' IS DISTINCT FROM p_purpose
			OR (p_flow ->> 'redirectUri') !~ '^https://[^?#]+(?:[?][^#]*)?$'
			OR pg_catalog.jsonb_typeof(p_flow -> 'requestedScopes') <> 'array'
			OR pg_catalog.jsonb_array_length(p_flow -> 'requestedScopes') NOT BETWEEN 1 AND 4
			OR (p_flow ->> 'codeVerifier') !~ '^[A-Za-z0-9._~-]{43,128}$'
			OR pg_catalog.jsonb_typeof(p_flow -> 'authorizationEpochAtStart') <> 'number'
			OR (p_flow ->> 'authorizationEpochAtStart')::integer < 0
			OR NOT pg_catalog.pg_input_is_valid(
				p_flow ->> 'createdAt', 'timestamp with time zone'
			)
			OR NOT pg_catalog.pg_input_is_valid(
				p_flow ->> 'expiresAt', 'timestamp with time zone'
			)
			OR NOT pg_catalog.pg_input_is_valid(
				p_result ->> 'expiresAt', 'timestamp with time zone'
			)
		THEN
			RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid google oauth flow binding';
		END IF;
		v_created_at := (p_flow ->> 'createdAt')::timestamp with time zone;
		v_expires_at := (p_flow ->> 'expiresAt')::timestamp with time zone;
		IF v_expires_at <= v_created_at
			OR v_expires_at > v_created_at + interval '10 minutes'
			OR (p_result ->> 'expiresAt')::timestamp with time zone IS DISTINCT FROM v_expires_at
			OR p_result ->> 'authorizationUrl' NOT LIKE
				'https://accounts.google.com/o/oauth2/v2/auth?%'
			OR pg_catalog.strpos(
				p_result ->> 'authorizationUrl',
				'state=v1.' || v_flow_id || '.'
			) = 0
		THEN
			RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid google oauth authorization binding';
		END IF;
		IF p_flow -> 'credentialRevisionAtStart' <> 'null'::jsonb
			AND (
				pg_catalog.jsonb_typeof(p_flow -> 'credentialRevisionAtStart') <> 'number'
				OR (p_flow ->> 'credentialRevisionAtStart')::integer <= 0
			)
		THEN
			RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid credential revision';
		END IF;
		IF EXISTS (
			SELECT 1
			FROM pg_catalog.jsonb_array_elements_text(
				p_flow -> 'requestedScopes'
			) AS requested(scope)
			WHERE requested.scope NOT IN (
				'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
				'https://www.googleapis.com/auth/calendar.events.readonly',
				'https://www.googleapis.com/auth/calendar.freebusy',
				'https://www.googleapis.com/auth/calendar.events'
			)
				OR (p_purpose = 'calendar-read'
					AND requested.scope = 'https://www.googleapis.com/auth/calendar.events')
				OR (p_purpose = 'calendar-event-write'
					AND requested.scope IN (
						'https://www.googleapis.com/auth/calendar.events.readonly',
						'https://www.googleapis.com/auth/calendar.freebusy'
					))
		) OR (
			SELECT pg_catalog.count(*)
			FROM pg_catalog.jsonb_array_elements_text(
				p_flow -> 'requestedScopes'
			) AS requested(scope)
		) IS DISTINCT FROM (
			SELECT pg_catalog.count(DISTINCT requested.scope)
			FROM pg_catalog.jsonb_array_elements_text(
				p_flow -> 'requestedScopes'
			) AS requested(scope)
		) THEN
			RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid google oauth requested scope';
		END IF;

		INSERT INTO emdo.google_oauth_flows(
			id, household_id, private_space_id, original_owner_user_id,
			session_id, redirect_uri, purpose, requested_scopes,
			credential_revision_at_start, authorization_epoch_at_start,
			code_verifier, created_at, expires_at
		) VALUES (
			v_flow_id, p_household_id, p_private_space_id, p_user_id,
			p_session_id, p_flow ->> 'redirectUri', p_purpose,
			p_flow -> 'requestedScopes',
			CASE WHEN p_flow -> 'credentialRevisionAtStart' = 'null'::jsonb
				THEN NULL
				ELSE (p_flow ->> 'credentialRevisionAtStart')::integer END,
			(p_flow ->> 'authorizationEpochAtStart')::integer,
			p_flow ->> 'codeVerifier', v_created_at, v_expires_at
		);
	ELSE
		RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid google oauth authorization status';
	END IF;

	INSERT INTO emdo.google_oauth_authorization_starts(
		household_id, private_space_id, original_owner_user_id, session_id,
		idempotency_key, request_fingerprint, purpose, result, flow_id,
		created_at, retain_until
	) VALUES (
		p_household_id, p_private_space_id, p_user_id, p_session_id,
		p_idempotency_key, p_request_fingerprint, p_purpose, p_result,
		v_flow_id, v_now, v_now + interval '24 hours'
	);
	RETURN QUERY SELECT 'stored'::text, p_result;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.purge_expired_google_oauth_state(
	p_limit integer
)
RETURNS TABLE (authorization_starts_deleted integer, flows_deleted integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_authorization_starts_deleted integer;
	v_flows_deleted integer;
	v_now timestamp with time zone := pg_catalog.clock_timestamp();
BEGIN
	IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
		RAISE EXCEPTION USING
			ERRCODE = '22023',
			MESSAGE = 'invalid google oauth purge limit';
	END IF;

	WITH candidates AS (
		SELECT stored.id
		FROM emdo.google_oauth_authorization_starts AS stored
		WHERE stored.retain_until <= v_now
		ORDER BY stored.retain_until, stored.id
		LIMIT p_limit
		FOR UPDATE SKIP LOCKED
	)
	DELETE FROM emdo.google_oauth_authorization_starts AS stored
	USING candidates
	WHERE stored.id = candidates.id;
	GET DIAGNOSTICS v_authorization_starts_deleted = ROW_COUNT;

	WITH candidates AS (
		SELECT stored.id
		FROM emdo.google_oauth_flows AS stored
		WHERE stored.expires_at <= v_now
		ORDER BY stored.expires_at, stored.id COLLATE "C"
		LIMIT p_limit
		FOR UPDATE SKIP LOCKED
	)
	DELETE FROM emdo.google_oauth_flows AS stored
	USING candidates
	WHERE stored.id = candidates.id;
	GET DIAGNOSTICS v_flows_deleted = ROW_COUNT;

	RETURN QUERY SELECT v_authorization_starts_deleted, v_flows_deleted;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.google_oauth_runtime_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
	SELECT
		session_user = 'emdo_api_login'
		AND pg_catalog.pg_has_role(session_user, 'emdo_app', 'MEMBER')
		AND NOT pg_catalog.pg_has_role(
			session_user, 'emdo_oauth_flow_executor', 'MEMBER'
		)
		AND NOT pg_catalog.pg_has_role(
			session_user, 'emdo_oauth_grant_executor', 'MEMBER'
		)
		AND (
			SELECT pg_catalog.count(*) = 2
			FROM pg_catalog.pg_roles AS role
			WHERE role.rolname IN (
				'emdo_oauth_flow_executor', 'emdo_oauth_grant_executor'
			)
				AND role.rolcanlogin = false
				AND role.rolinherit = false
				AND role.rolbypassrls = false
				AND role.rolsuper = false
				AND role.rolcreatedb = false
				AND role.rolcreaterole = false
				AND role.rolreplication = false
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_auth_members AS membership
			JOIN pg_catalog.pg_roles AS role
				ON role.oid IN (membership.roleid, membership.member)
			WHERE role.rolname IN (
				'emdo_oauth_flow_executor', 'emdo_oauth_grant_executor'
			)
		)
		AND (
			SELECT pg_catalog.count(*) = 4
			FROM pg_catalog.pg_class AS relation
			JOIN pg_catalog.pg_namespace AS namespace
				ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname = 'emdo'
				AND relation.relname IN (
					'google_oauth_authorization_starts',
					'google_oauth_flows',
					'google_oauth_authorization_epochs',
					'encrypted_google_calendar_grants'
				)
				AND relation.relrowsecurity
				AND relation.relforcerowsecurity
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user,
			'emdo.google_oauth_authorization_starts',
			'SELECT,INSERT,UPDATE,DELETE'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user,
			'emdo.google_oauth_flows',
			'SELECT,INSERT,UPDATE,DELETE'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user,
			'emdo.google_oauth_authorization_epochs',
			'SELECT,INSERT,UPDATE,DELETE'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user,
			'emdo.encrypted_google_calendar_grants',
			'SELECT,INSERT,UPDATE,DELETE'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_oauth_flow_executor',
			'emdo.google_oauth_authorization_starts',
			'SELECT,INSERT,UPDATE,DELETE'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_oauth_flow_executor',
			'emdo.google_oauth_flows',
			'SELECT,INSERT,DELETE'
		)
		AND (
			SELECT pg_catalog.count(*) = 5
			FROM pg_catalog.pg_proc AS proc
			WHERE proc.oid IN (
				'emdo.commit_google_oauth_authorization_start(uuid,uuid,uuid,uuid,text,text,text,jsonb,jsonb)'::regprocedure,
				'emdo.consume_google_oauth_flow(text,uuid,uuid,uuid,uuid)'::regprocedure,
				'emdo.invalidate_google_oauth_flows(uuid,uuid,uuid)'::regprocedure,
				'emdo.purge_expired_google_oauth_state(integer)'::regprocedure,
				'emdo.google_oauth_runtime_ready()'::regprocedure
			)
				AND proc.prosecdef
				AND proc.proowner = 'emdo_oauth_flow_executor'::regrole
				AND proc.proconfig @> ARRAY[
					'row_security=on', 'search_path=pg_catalog, emdo'
				]
		)
		AND (
			SELECT pg_catalog.count(*) = 5
			FROM pg_catalog.pg_proc AS proc
			WHERE proc.oid IN (
				'emdo.load_google_oauth_authorization_epoch(uuid,uuid,uuid)'::regprocedure,
				'emdo.advance_google_oauth_authorization_epoch(uuid,uuid,uuid,integer)'::regprocedure,
				'emdo.load_encrypted_google_calendar_grant(text,uuid,uuid,uuid)'::regprocedure,
				'emdo.compare_and_set_encrypted_google_calendar_grant(text,uuid,uuid,uuid,integer,integer,text,jsonb)'::regprocedure,
				'emdo.delete_encrypted_google_calendar_grant(text,uuid,uuid,uuid,integer)'::regprocedure
			)
				AND proc.prosecdef
				AND proc.proowner = 'emdo_oauth_grant_executor'::regrole
				AND proc.proconfig @> ARRAY[
					'row_security=on', 'search_path=pg_catalog, emdo'
				]
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS proc
			WHERE proc.oid =
				'emdo.is_valid_encrypted_google_calendar_grant_payload(jsonb)'::regprocedure
				AND NOT proc.prosecdef
				AND proc.provolatile = 'i'
				AND proc.proparallel = 's'
				AND proc.proowner = 'emdo_oauth_grant_executor'::regrole
				AND proc.proconfig @> ARRAY['search_path=pg_catalog']
		)
		AND pg_catalog.has_function_privilege(
			'emdo_oauth_grant_executor',
			'emdo.is_valid_encrypted_google_calendar_grant_payload(jsonb)',
			'EXECUTE'
		)
		AND NOT pg_catalog.has_function_privilege(
			session_user,
			'emdo.is_valid_encrypted_google_calendar_grant_payload(jsonb)',
			'EXECUTE'
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.unnest(ARRAY[
				'emdo.commit_google_oauth_authorization_start(uuid,uuid,uuid,uuid,text,text,text,jsonb,jsonb)'::regprocedure,
				'emdo.consume_google_oauth_flow(text,uuid,uuid,uuid,uuid)'::regprocedure,
				'emdo.invalidate_google_oauth_flows(uuid,uuid,uuid)'::regprocedure,
				'emdo.load_google_oauth_authorization_epoch(uuid,uuid,uuid)'::regprocedure,
				'emdo.advance_google_oauth_authorization_epoch(uuid,uuid,uuid,integer)'::regprocedure,
				'emdo.load_encrypted_google_calendar_grant(text,uuid,uuid,uuid)'::regprocedure,
				'emdo.compare_and_set_encrypted_google_calendar_grant(text,uuid,uuid,uuid,integer,integer,text,jsonb)'::regprocedure,
				'emdo.delete_encrypted_google_calendar_grant(text,uuid,uuid,uuid,integer)'::regprocedure,
				'emdo.google_oauth_runtime_ready()'::regprocedure
			]) AS routine(oid)
			WHERE NOT pg_catalog.has_function_privilege(
				session_user, routine.oid, 'EXECUTE'
				)
		)
		AND NOT pg_catalog.has_function_privilege(
			session_user,
			'emdo.purge_expired_google_oauth_state(integer)',
			'EXECUTE'
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS proc
			CROSS JOIN LATERAL pg_catalog.aclexplode(
				COALESCE(
					proc.proacl,
					pg_catalog.acldefault('f', proc.proowner)
				)
			) AS privilege
			WHERE proc.oid IN (
				'emdo.commit_google_oauth_authorization_start(uuid,uuid,uuid,uuid,text,text,text,jsonb,jsonb)'::regprocedure,
				'emdo.consume_google_oauth_flow(text,uuid,uuid,uuid,uuid)'::regprocedure,
				'emdo.invalidate_google_oauth_flows(uuid,uuid,uuid)'::regprocedure,
				'emdo.load_google_oauth_authorization_epoch(uuid,uuid,uuid)'::regprocedure,
				'emdo.advance_google_oauth_authorization_epoch(uuid,uuid,uuid,integer)'::regprocedure,
				'emdo.load_encrypted_google_calendar_grant(text,uuid,uuid,uuid)'::regprocedure,
				'emdo.compare_and_set_encrypted_google_calendar_grant(text,uuid,uuid,uuid,integer,integer,text,jsonb)'::regprocedure,
				'emdo.delete_encrypted_google_calendar_grant(text,uuid,uuid,uuid,integer)'::regprocedure,
				'emdo.is_valid_encrypted_google_calendar_grant_payload(jsonb)'::regprocedure,
				'emdo.purge_expired_google_oauth_state(integer)'::regprocedure,
				'emdo.google_oauth_runtime_ready()'::regprocedure
			)
				AND privilege.grantee = 0
				AND privilege.privilege_type = 'EXECUTE'
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.unnest(ARRAY[
				'emdo.current_user_id()'::regprocedure,
				'emdo.current_session_id()'::regprocedure,
				'emdo.lock_active_request_scope(uuid,uuid,uuid)'::regprocedure,
				'emdo.canonical_json_text(jsonb)'::regprocedure,
				'emdo.canonical_json_hash(jsonb)'::regprocedure,
				'emdo.jsonb_object_has_exact_keys(jsonb,text[])'::regprocedure
			]) AS helper(oid)
			WHERE NOT pg_catalog.has_function_privilege(
				'emdo_oauth_flow_executor', helper.oid, 'EXECUTE'
			)
		)
$function$;
--> statement-breakpoint
ALTER TABLE emdo.google_oauth_authorization_starts OWNER TO emdo_oauth_flow_executor;
ALTER FUNCTION emdo.commit_google_oauth_authorization_start(uuid, uuid, uuid, uuid, text, text, text, jsonb, jsonb)
	OWNER TO emdo_oauth_flow_executor;
ALTER FUNCTION emdo.purge_expired_google_oauth_state(integer)
	OWNER TO emdo_oauth_flow_executor;
ALTER FUNCTION emdo.google_oauth_runtime_ready()
	OWNER TO emdo_oauth_flow_executor;
REVOKE ALL ON emdo.google_oauth_authorization_starts FROM PUBLIC, emdo_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON emdo.google_oauth_flows FROM emdo_app;
REVOKE ALL ON FUNCTION emdo.commit_google_oauth_authorization_start(uuid, uuid, uuid, uuid, text, text, text, jsonb, jsonb)
	FROM PUBLIC;
REVOKE ALL ON FUNCTION emdo.purge_expired_google_oauth_state(integer)
	FROM PUBLIC, emdo_app;
REVOKE ALL ON FUNCTION emdo.google_oauth_runtime_ready() FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON emdo.google_oauth_authorization_starts
	TO emdo_oauth_flow_executor;
GRANT INSERT ON emdo.google_oauth_flows TO emdo_oauth_flow_executor;
GRANT EXECUTE ON FUNCTION
	emdo.canonical_json_text(jsonb),
	emdo.canonical_json_hash(jsonb),
	emdo.jsonb_object_has_exact_keys(jsonb, text[])
	TO emdo_oauth_flow_executor;
GRANT EXECUTE ON FUNCTION emdo.commit_google_oauth_authorization_start(uuid, uuid, uuid, uuid, text, text, text, jsonb, jsonb)
	TO emdo_app;
GRANT EXECUTE ON FUNCTION emdo.google_oauth_runtime_ready() TO emdo_app;

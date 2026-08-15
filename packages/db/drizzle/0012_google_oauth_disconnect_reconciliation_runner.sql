DO $role$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_google_oauth_disconnect_reconciliation_login'
	) THEN
		CREATE ROLE emdo_google_oauth_disconnect_reconciliation_login NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$role$;
--> statement-breakpoint
ALTER ROLE emdo_google_oauth_disconnect_reconciliation_login NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_oauth_grant_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_google_oauth_disconnect_retention NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_google_oauth_disconnect_reconciliation_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_google_oauth_disconnect_reconciliation NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
--> statement-breakpoint
DO $memberships$
DECLARE
	parent_role text;
	child_role text;
BEGIN
	FOR parent_role, child_role IN
		SELECT parent.rolname, child.rolname
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE child.rolname IN (
			'emdo_oauth_grant_executor',
			'emdo_google_oauth_disconnect_retention',
			'emdo_google_oauth_disconnect_reconciliation_executor',
			'emdo_google_oauth_disconnect_reconciliation',
			'emdo_google_oauth_disconnect_reconciliation_login'
		) OR parent.rolname IN (
			'emdo_oauth_grant_executor',
			'emdo_google_oauth_disconnect_retention',
			'emdo_google_oauth_disconnect_reconciliation_executor',
			'emdo_google_oauth_disconnect_reconciliation',
			'emdo_google_oauth_disconnect_reconciliation_login'
		)
	LOOP
		EXECUTE format('REVOKE %I FROM %I', parent_role, child_role);
	END LOOP;
END
$memberships$;
--> statement-breakpoint
GRANT emdo_google_oauth_disconnect_reconciliation
	TO emdo_google_oauth_disconnect_reconciliation_login
	WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
	emdo.enforce_finance_import_plan_transition(),
	emdo.is_bounded_finance_import_metadata(jsonb),
	emdo.is_bounded_finance_import_diagnostics(jsonb),
	emdo.is_valid_finance_import_date(text),
	emdo.is_valid_finance_import_timestamp(text),
	emdo.is_valid_finance_import_plan(jsonb, uuid, text, text, text, uuid, uuid)
	FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
	emdo.enforce_finance_import_plan_transition(),
	emdo.is_bounded_finance_import_metadata(jsonb),
	emdo.is_bounded_finance_import_diagnostics(jsonb),
	emdo.is_valid_finance_import_date(text),
	emdo.is_valid_finance_import_timestamp(text),
	emdo.is_valid_finance_import_plan(jsonb, uuid, text, text, text, uuid, uuid)
	TO emdo_finance_import_executor;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.reconcile_stranded_google_oauth_disconnects(
	p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_now timestamp with time zone := pg_catalog.clock_timestamp();
	v_completed_at timestamp with time zone;
	v_latest_linked_updated_at timestamp with time zone;
	v_candidate record;
	v_existing emdo.google_oauth_disconnect_operations%ROWTYPE;
	v_current_epoch integer;
	v_current_grants integer;
	v_reconciled integer := 0;
	v_result jsonb := pg_catalog.jsonb_build_object(
		'status', 'disconnected',
		'providerRevocation', 'unconfirmed'
	);
BEGIN
	IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
		RAISE EXCEPTION USING
			ERRCODE = '22023',
			MESSAGE = 'invalid google oauth disconnect reconciliation limit';
	END IF;
	FOR v_candidate IN
		SELECT stored.id, stored.household_id, stored.private_space_id,
			stored.original_owner_user_id
		FROM emdo.google_oauth_disconnect_operations AS stored
		WHERE stored.parent_operation_id IS NULL
			AND stored.state = 'dispatching'
			AND stored.updated_at <= v_now - interval '10 minutes'
		ORDER BY stored.updated_at, stored.id
		LIMIT p_limit
	LOOP
		IF NOT pg_catalog.pg_try_advisory_xact_lock(
			pg_catalog.hashtextextended(
				v_candidate.original_owner_user_id::text || ':' ||
				v_candidate.household_id::text || ':' ||
				v_candidate.private_space_id::text,
				0
			)
		) THEN
			CONTINUE;
		END IF;
		SELECT stored.* INTO v_existing
		FROM emdo.google_oauth_disconnect_operations AS stored
		WHERE stored.id = v_candidate.id
			AND stored.parent_operation_id IS NULL
			AND stored.state = 'dispatching'
			AND stored.updated_at <= v_now - interval '10 minutes'
		FOR UPDATE SKIP LOCKED;
		IF NOT FOUND THEN
			CONTINUE;
		END IF;
		SELECT stored.authorization_epoch INTO v_current_epoch
		FROM emdo.google_oauth_authorization_epochs AS stored
		WHERE stored.household_id = v_existing.household_id
			AND stored.private_space_id = v_existing.private_space_id
			AND stored.original_owner_user_id =
				v_existing.original_owner_user_id;
		SELECT pg_catalog.count(*)::integer INTO v_current_grants
		FROM emdo.encrypted_google_calendar_grants AS stored
		WHERE stored.household_id = v_existing.household_id
			AND stored.private_space_id = v_existing.private_space_id
			AND stored.original_owner_user_id =
				v_existing.original_owner_user_id
			AND stored.provider = 'google'
			AND stored.grant_type = 'calendar-authorization';
		IF v_current_epoch IS DISTINCT FROM v_existing.authorization_epoch + 1
			OR v_current_grants <> 0
		THEN
			CONTINUE;
		END IF;
		SELECT pg_catalog.max(linked.updated_at)
		INTO v_latest_linked_updated_at
		FROM emdo.google_oauth_disconnect_operations AS linked
		WHERE linked.parent_operation_id = v_existing.id
			AND linked.state = 'linked';
		v_completed_at := GREATEST(
			v_now,
			v_existing.updated_at + interval '1 microsecond',
			COALESCE(
				v_latest_linked_updated_at + interval '1 microsecond',
				v_now
			)
		);
		UPDATE emdo.google_oauth_disconnect_operations AS stored
		SET state = 'completed',
			completion_source = 'reconciliation',
			result = v_result,
			updated_at = v_completed_at,
			completed_at = v_completed_at,
			retain_until = v_completed_at + interval '90 days'
		WHERE stored.id = v_existing.id
			AND stored.state = 'dispatching';
		IF NOT FOUND THEN
			CONTINUE;
		END IF;
		UPDATE emdo.google_oauth_disconnect_operations AS linked
		SET state = 'completed',
			dispatch_request_id = v_existing.dispatch_request_id,
			dispatch_session_id = v_existing.dispatch_session_id,
			completion_source = 'reconciliation',
			result = v_result,
			updated_at = v_completed_at,
			completed_at = v_completed_at,
			retain_until = v_completed_at + interval '90 days'
		WHERE linked.parent_operation_id = v_existing.id
			AND linked.state = 'linked';
		v_reconciled := v_reconciled + 1;
	END LOOP;
	RETURN v_reconciled;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.google_oauth_disconnect_ready()
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
			session_user, 'emdo_oauth_grant_executor', 'MEMBER'
		)
		AND NOT pg_catalog.pg_has_role(
			session_user, 'emdo_google_oauth_disconnect_retention', 'MEMBER'
		)
		AND NOT pg_catalog.pg_has_role(
			session_user,
			'emdo_google_oauth_disconnect_reconciliation_executor', 'MEMBER'
		)
		AND NOT pg_catalog.pg_has_role(
			session_user,
			'emdo_google_oauth_disconnect_reconciliation', 'MEMBER'
		)
		AND (
			SELECT pg_catalog.count(*) = 4
			FROM pg_catalog.pg_roles AS role
			WHERE role.rolname IN (
				'emdo_oauth_grant_executor',
				'emdo_google_oauth_disconnect_retention',
				'emdo_google_oauth_disconnect_reconciliation_executor',
				'emdo_google_oauth_disconnect_reconciliation'
			)
				AND role.rolcanlogin = false
				AND role.rolinherit = false
				AND role.rolbypassrls = false
				AND role.rolsuper = false
				AND role.rolcreatedb = false
				AND role.rolcreaterole = false
				AND role.rolreplication = false
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_roles AS role
			WHERE role.rolname =
				'emdo_google_oauth_disconnect_reconciliation_login'
				AND role.rolinherit = false
				AND role.rolbypassrls = false
				AND role.rolsuper = false
				AND role.rolcreatedb = false
				AND role.rolcreaterole = false
				AND role.rolreplication = false
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_auth_members AS membership
			JOIN pg_catalog.pg_roles AS parent
				ON parent.oid = membership.roleid
			JOIN pg_catalog.pg_roles AS child
				ON child.oid = membership.member
			WHERE parent.rolname =
					'emdo_google_oauth_disconnect_reconciliation'
				AND child.rolname =
					'emdo_google_oauth_disconnect_reconciliation_login'
				AND membership.inherit_option = false
				AND membership.set_option = true
				AND membership.admin_option = false
		)
		AND (
			SELECT pg_catalog.count(*)
			FROM pg_catalog.pg_auth_members AS membership
			JOIN pg_catalog.pg_roles AS parent
				ON parent.oid = membership.roleid
			JOIN pg_catalog.pg_roles AS child
				ON child.oid = membership.member
			WHERE parent.rolname IN (
				'emdo_oauth_grant_executor',
				'emdo_google_oauth_disconnect_retention',
				'emdo_google_oauth_disconnect_reconciliation_executor',
				'emdo_google_oauth_disconnect_reconciliation',
				'emdo_google_oauth_disconnect_reconciliation_login'
			) OR child.rolname IN (
				'emdo_oauth_grant_executor',
				'emdo_google_oauth_disconnect_retention',
				'emdo_google_oauth_disconnect_reconciliation_executor',
				'emdo_google_oauth_disconnect_reconciliation',
				'emdo_google_oauth_disconnect_reconciliation_login'
			)
		) = 1
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_class AS relation
			JOIN pg_catalog.pg_namespace AS namespace
				ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname = 'emdo'
				AND relation.relname = 'google_oauth_disconnect_operations'
				AND relation.relrowsecurity
				AND relation.relforcerowsecurity
				AND relation.relowner = 'emdo_oauth_grant_executor'::regrole
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user,
			'emdo.google_oauth_disconnect_operations',
			'SELECT,INSERT,UPDATE,DELETE'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_oauth_grant_executor',
			'emdo.google_oauth_disconnect_operations',
			'SELECT,INSERT,UPDATE,DELETE'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_retention',
			'emdo.google_oauth_disconnect_operations',
			'SELECT,DELETE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_retention',
			'emdo.google_oauth_disconnect_operations',
			'INSERT,UPDATE'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_reconciliation_executor',
			'emdo.google_oauth_disconnect_operations',
			'SELECT,UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_reconciliation_executor',
			'emdo.google_oauth_disconnect_operations',
			'INSERT,DELETE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_reconciliation',
			'emdo.google_oauth_disconnect_operations',
			'SELECT,INSERT,UPDATE,DELETE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_reconciliation_login',
			'emdo.google_oauth_disconnect_operations',
			'SELECT,INSERT,UPDATE,DELETE'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_reconciliation_executor',
			'emdo.google_oauth_authorization_epochs',
			'SELECT'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_reconciliation_executor',
			'emdo.encrypted_google_calendar_grants',
			'SELECT'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_reconciliation_executor',
			'emdo.google_oauth_authorization_epochs',
			'INSERT,UPDATE,DELETE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_reconciliation_executor',
			'emdo.encrypted_google_calendar_grants',
			'INSERT,UPDATE,DELETE'
		)
		AND (
			SELECT pg_catalog.count(*) = 4
			FROM pg_catalog.pg_proc AS proc
			WHERE proc.oid IN (
				'emdo.claim_google_oauth_disconnect(uuid,uuid,uuid,uuid,text,text)'::regprocedure,
				'emdo.mark_google_oauth_disconnect_dispatching(uuid,uuid,uuid,uuid,uuid)'::regprocedure,
				'emdo.settle_google_oauth_disconnect(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure,
				'emdo.google_oauth_disconnect_ready()'::regprocedure
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
				'emdo.purge_completed_google_oauth_disconnects(integer)'::regprocedure
				AND proc.prosecdef
				AND proc.proowner =
					'emdo_google_oauth_disconnect_retention'::regrole
				AND proc.proconfig @> ARRAY[
					'row_security=on', 'search_path=pg_catalog, emdo'
				]
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS proc
			WHERE proc.oid =
				'emdo.reconcile_stranded_google_oauth_disconnects(integer)'::regprocedure
				AND proc.prosecdef
				AND proc.proowner =
					'emdo_google_oauth_disconnect_reconciliation_executor'::regrole
				AND proc.proconfig @> ARRAY[
					'row_security=on', 'search_path=pg_catalog, emdo'
				]
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS proc
			WHERE proc.oid = ANY (ARRAY[
				'emdo.enforce_google_oauth_disconnect_transition()'::regprocedure,
				'emdo.enforce_google_calendar_grant_disconnect_fence()'::regprocedure
			])
				AND NOT proc.prosecdef
				AND proc.proowner = 'emdo_oauth_grant_executor'::regrole
				AND proc.proconfig @> ARRAY['search_path=pg_catalog, emdo']
			GROUP BY proc.proowner
			HAVING pg_catalog.count(*) = 2
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.unnest(ARRAY[
				'emdo.claim_google_oauth_disconnect(uuid,uuid,uuid,uuid,text,text)'::regprocedure,
				'emdo.mark_google_oauth_disconnect_dispatching(uuid,uuid,uuid,uuid,uuid)'::regprocedure,
				'emdo.settle_google_oauth_disconnect(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure,
				'emdo.google_oauth_disconnect_ready()'::regprocedure
			]) AS routine(oid)
			WHERE NOT pg_catalog.has_function_privilege(
				session_user, routine.oid, 'EXECUTE'
			)
		)
		AND NOT pg_catalog.has_function_privilege(
			session_user,
			'emdo.purge_completed_google_oauth_disconnects(integer)',
			'EXECUTE'
		)
		AND NOT pg_catalog.has_function_privilege(
			session_user,
			'emdo.reconcile_stranded_google_oauth_disconnects(integer)',
			'EXECUTE'
		)
		AND NOT pg_catalog.has_function_privilege(
			'emdo_google_oauth_disconnect_reconciliation_login',
			'emdo.reconcile_stranded_google_oauth_disconnects(integer)',
			'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_google_oauth_disconnect_retention',
			'emdo.purge_completed_google_oauth_disconnects(integer)',
			'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_google_oauth_disconnect_reconciliation',
			'emdo.reconcile_stranded_google_oauth_disconnects(integer)',
			'EXECUTE'
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.unnest(ARRAY[
				'emdo.claim_google_oauth_disconnect(uuid,uuid,uuid,uuid,text,text)'::regprocedure,
				'emdo.mark_google_oauth_disconnect_dispatching(uuid,uuid,uuid,uuid,uuid)'::regprocedure,
				'emdo.settle_google_oauth_disconnect(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure,
				'emdo.google_oauth_disconnect_ready()'::regprocedure,
				'emdo.enforce_google_oauth_disconnect_transition()'::regprocedure,
				'emdo.enforce_google_calendar_grant_disconnect_fence()'::regprocedure,
				'emdo.reconcile_stranded_google_oauth_disconnects(integer)'::regprocedure
			]) AS routine(oid)
			WHERE pg_catalog.has_function_privilege(
				'emdo_google_oauth_disconnect_retention', routine.oid, 'EXECUTE'
			)
		)
		AND NOT pg_catalog.has_function_privilege(
			session_user,
			'emdo.enforce_google_oauth_disconnect_transition()',
			'EXECUTE'
		)
		AND NOT pg_catalog.has_function_privilege(
			session_user,
			'emdo.enforce_google_calendar_grant_disconnect_fence()',
			'EXECUTE'
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.unnest(ARRAY[
				'emdo.claim_google_oauth_disconnect(uuid,uuid,uuid,uuid,text,text)'::regprocedure,
				'emdo.mark_google_oauth_disconnect_dispatching(uuid,uuid,uuid,uuid,uuid)'::regprocedure,
				'emdo.settle_google_oauth_disconnect(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure,
				'emdo.purge_completed_google_oauth_disconnects(integer)'::regprocedure,
				'emdo.google_oauth_disconnect_ready()'::regprocedure,
				'emdo.enforce_google_oauth_disconnect_transition()'::regprocedure,
				'emdo.enforce_google_calendar_grant_disconnect_fence()'::regprocedure
			]) AS routine(oid)
			WHERE pg_catalog.has_function_privilege(
				'emdo_google_oauth_disconnect_reconciliation',
				routine.oid, 'EXECUTE'
			)
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS proc
			CROSS JOIN LATERAL pg_catalog.aclexplode(
				COALESCE(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
			) AS privilege
			WHERE proc.oid IN (
				'emdo.claim_google_oauth_disconnect(uuid,uuid,uuid,uuid,text,text)'::regprocedure,
				'emdo.mark_google_oauth_disconnect_dispatching(uuid,uuid,uuid,uuid,uuid)'::regprocedure,
				'emdo.settle_google_oauth_disconnect(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure,
				'emdo.purge_completed_google_oauth_disconnects(integer)'::regprocedure,
				'emdo.reconcile_stranded_google_oauth_disconnects(integer)'::regprocedure,
				'emdo.google_oauth_disconnect_ready()'::regprocedure,
				'emdo.enforce_google_oauth_disconnect_transition()'::regprocedure,
				'emdo.enforce_google_calendar_grant_disconnect_fence()'::regprocedure
			)
				AND privilege.grantee = 0
				AND privilege.privilege_type = 'EXECUTE'
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.unnest(ARRAY[
				'emdo.current_user_id()'::regprocedure,
				'emdo.current_session_id()'::regprocedure,
				'emdo.current_request_id()'::regprocedure,
				'emdo.lock_active_request_scope(uuid,uuid,uuid)'::regprocedure,
				'emdo.canonical_json_text(jsonb)'::regprocedure,
				'emdo.canonical_json_hash(jsonb)'::regprocedure,
				'emdo.invalidate_google_oauth_flows(uuid,uuid,uuid)'::regprocedure
			]) AS helper(oid)
			WHERE NOT pg_catalog.has_function_privilege(
				'emdo_oauth_grant_executor', helper.oid, 'EXECUTE'
			)
		)
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.google_oauth_disconnect_reconciliation_runner_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
	SELECT
		session_user =
			'emdo_google_oauth_disconnect_reconciliation_login'
		AND pg_catalog.current_database() = 'emdo_app'
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_roles AS login
			WHERE login.rolname =
				'emdo_google_oauth_disconnect_reconciliation_login'
				AND login.rolcanlogin = true
				AND login.rolinherit = false
				AND login.rolbypassrls = false
				AND login.rolsuper = false
				AND login.rolcreatedb = false
				AND login.rolcreaterole = false
				AND login.rolreplication = false
		)
		AND pg_catalog.pg_has_role(
			session_user,
			'emdo_google_oauth_disconnect_reconciliation', 'MEMBER'
		)
		AND pg_catalog.pg_has_role(
			session_user,
			'emdo_google_oauth_disconnect_reconciliation', 'SET'
		)
		AND NOT pg_catalog.pg_has_role(
			session_user, 'emdo_app', 'MEMBER'
		)
		AND NOT pg_catalog.pg_has_role(
			session_user, 'emdo_oauth_grant_executor', 'MEMBER'
		)
		AND NOT pg_catalog.pg_has_role(
			session_user,
			'emdo_google_oauth_disconnect_reconciliation_executor', 'MEMBER'
		)
		AND NOT pg_catalog.pg_has_role(
			session_user,
			'emdo_google_oauth_disconnect_retention', 'MEMBER'
		)
		AND (
			SELECT pg_catalog.count(*)
			FROM pg_catalog.pg_auth_members AS membership
			JOIN pg_catalog.pg_roles AS parent
				ON parent.oid = membership.roleid
			JOIN pg_catalog.pg_roles AS child
				ON child.oid = membership.member
			WHERE parent.rolname IN (
				'emdo_oauth_grant_executor',
				'emdo_google_oauth_disconnect_retention',
				'emdo_google_oauth_disconnect_reconciliation_executor',
				'emdo_google_oauth_disconnect_reconciliation',
				'emdo_google_oauth_disconnect_reconciliation_login'
			) OR child.rolname IN (
				'emdo_oauth_grant_executor',
				'emdo_google_oauth_disconnect_retention',
				'emdo_google_oauth_disconnect_reconciliation_executor',
				'emdo_google_oauth_disconnect_reconciliation',
				'emdo_google_oauth_disconnect_reconciliation_login'
			)
		) = 1
		AND pg_catalog.has_database_privilege(
			session_user, 'emdo_app', 'CONNECT'
		)
		AND pg_catalog.has_schema_privilege(session_user, 'emdo', 'USAGE')
		AND NOT pg_catalog.has_schema_privilege(session_user, 'emdo', 'CREATE')
		AND NOT pg_catalog.has_table_privilege(
			session_user,
			'emdo.google_oauth_disconnect_operations',
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
		AND NOT pg_catalog.has_function_privilege(
			session_user,
			'emdo.reconcile_stranded_google_oauth_disconnects(integer)',
			'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_google_oauth_disconnect_reconciliation',
			'emdo.reconcile_stranded_google_oauth_disconnects(integer)',
			'EXECUTE'
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS procedure
			WHERE procedure.oid =
				'emdo.google_oauth_disconnect_reconciliation_runner_ready()'::regprocedure
				AND procedure.prosecdef
				AND procedure.proowner =
					'emdo_google_oauth_disconnect_reconciliation_executor'::regrole
				AND procedure.proconfig @> ARRAY[
					'row_security=on', 'search_path=pg_catalog, emdo'
				]
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS procedure
			CROSS JOIN LATERAL pg_catalog.aclexplode(
				COALESCE(
					procedure.proacl,
					pg_catalog.acldefault('f', procedure.proowner)
				)
			) AS privilege
			JOIN pg_catalog.pg_roles AS grantee
				ON grantee.oid = privilege.grantee
			WHERE procedure.oid =
				'emdo.google_oauth_disconnect_reconciliation_runner_ready()'::regprocedure
				AND grantee.rolname =
					'emdo_google_oauth_disconnect_reconciliation_login'
				AND privilege.privilege_type = 'EXECUTE'
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS procedure
			WHERE procedure.pronamespace = 'emdo'::regnamespace
				AND procedure.oid <>
					'emdo.google_oauth_disconnect_reconciliation_runner_ready()'::regprocedure
				AND pg_catalog.has_function_privilege(
					session_user, procedure.oid, 'EXECUTE'
				)
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_class AS relation
			WHERE relation.relnamespace = 'emdo'::regnamespace
				AND CASE
					WHEN relation.relkind IN ('r', 'p', 'v', 'm', 'f') THEN
						pg_catalog.has_table_privilege(
							'emdo_google_oauth_disconnect_reconciliation',
							relation.oid,
							'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
						)
					ELSE false
				END
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_class AS relation
			WHERE relation.relnamespace = 'emdo'::regnamespace
				AND CASE
					WHEN relation.relkind = 'S' THEN
						pg_catalog.has_sequence_privilege(
							'emdo_google_oauth_disconnect_reconciliation',
							relation.oid,
							'USAGE,SELECT,UPDATE'
						)
					ELSE false
				END
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS procedure
			WHERE procedure.pronamespace = 'emdo'::regnamespace
				AND procedure.oid <>
					'emdo.reconcile_stranded_google_oauth_disconnects(integer)'::regprocedure
				AND pg_catalog.has_function_privilege(
					'emdo_google_oauth_disconnect_reconciliation',
					procedure.oid,
					'EXECUTE'
				)
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_class AS relation
			JOIN pg_catalog.pg_namespace AS namespace
				ON namespace.oid = relation.relnamespace
			CROSS JOIN LATERAL pg_catalog.aclexplode(
				COALESCE(
					relation.relacl,
					pg_catalog.acldefault(
						(
							CASE WHEN relation.relkind = 'S' THEN 'S' ELSE 'r' END
						)::"char",
						relation.relowner
					)
				)
			) AS privilege
			JOIN pg_catalog.pg_roles AS grantee
				ON grantee.oid = privilege.grantee
			WHERE namespace.nspname = 'emdo'
				AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')
				AND grantee.rolname =
					'emdo_google_oauth_disconnect_reconciliation_login'
		)
$function$;
--> statement-breakpoint
ALTER FUNCTION emdo.reconcile_stranded_google_oauth_disconnects(integer)
	OWNER TO emdo_google_oauth_disconnect_reconciliation_executor;
ALTER FUNCTION emdo.google_oauth_disconnect_ready()
	OWNER TO emdo_oauth_grant_executor;
ALTER FUNCTION emdo.google_oauth_disconnect_reconciliation_runner_ready()
	OWNER TO emdo_google_oauth_disconnect_reconciliation_executor;
REVOKE ALL PRIVILEGES ON SCHEMA emdo
	FROM emdo_google_oauth_disconnect_reconciliation_login;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA emdo
	FROM emdo_google_oauth_disconnect_reconciliation_login;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA emdo
	FROM emdo_google_oauth_disconnect_reconciliation_login;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA emdo
	FROM emdo_google_oauth_disconnect_reconciliation_login;
REVOKE ALL ON FUNCTION emdo.google_oauth_disconnect_reconciliation_runner_ready()
	FROM PUBLIC;
GRANT USAGE ON SCHEMA emdo
	TO emdo_google_oauth_disconnect_reconciliation_login;
GRANT EXECUTE ON FUNCTION emdo.google_oauth_disconnect_reconciliation_runner_ready()
	TO emdo_google_oauth_disconnect_reconciliation_login;

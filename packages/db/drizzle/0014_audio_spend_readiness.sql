ALTER ROLE emdo_metering_executor
	NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
--> statement-breakpoint
DO $membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname = 'emdo_metering_executor'
			OR child.rolname = 'emdo_metering_executor'
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'metering executor must not have role memberships';
	END IF;
END
$membership_guard$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE emdo.ai_spend_reservations
	FROM PUBLIC, emdo_app, emdo_metering_executor;
GRANT SELECT, INSERT, UPDATE ON TABLE emdo.ai_spend_reservations
	TO emdo_metering_executor;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
	emdo.reserve_ai_spend(text, uuid, text, text, text, text, text, bigint, bigint, bigint),
	emdo.transition_ai_spend(text, text, text),
	emdo.settle_ai_spend(text, text, bigint)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader;
GRANT EXECUTE ON FUNCTION
	emdo.reserve_ai_spend(text, uuid, text, text, text, text, text, bigint, bigint, bigint),
	emdo.transition_ai_spend(text, text, text),
	emdo.settle_ai_spend(text, text, bigint)
	TO emdo_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.audio_spend_ready()
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
			session_user, 'emdo_metering_executor', 'MEMBER'
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_roles AS role
			WHERE role.rolname = 'emdo_metering_executor'
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
			JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
			JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
			WHERE parent.rolname = 'emdo_metering_executor'
				OR child.rolname = 'emdo_metering_executor'
		)
		AND pg_catalog.has_schema_privilege(
			'emdo_metering_executor',
			'emdo',
			'USAGE'
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_class AS relation
			JOIN pg_catalog.pg_namespace AS namespace
				ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname = 'emdo'
				AND relation.relname = 'ai_spend_reservations'
				AND relation.relkind = 'r'
				AND relation.relrowsecurity
				AND relation.relforcerowsecurity
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_policy AS policy
			JOIN pg_catalog.pg_class AS relation
				ON relation.oid = policy.polrelid
			JOIN pg_catalog.pg_namespace AS namespace
				ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname = 'emdo'
				AND relation.relname = 'ai_spend_reservations'
				AND policy.polname = 'ai_spend_metering_executor_update'
				AND policy.polcmd = '*'
				AND policy.polpermissive
				AND policy.polroles =
					ARRAY['emdo_metering_executor'::regrole]::oid[]
				AND pg_catalog.pg_get_expr(
					policy.polqual, policy.polrelid
				) = 'true'
				AND pg_catalog.pg_get_expr(
					policy.polwithcheck, policy.polrelid
				) = 'true'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user,
			'emdo.ai_spend_reservations',
			'SELECT,INSERT,UPDATE,DELETE'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_metering_executor',
			'emdo.ai_spend_reservations',
			'SELECT'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_metering_executor',
			'emdo.ai_spend_reservations',
			'INSERT'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_metering_executor',
			'emdo.ai_spend_reservations',
			'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_metering_executor',
			'emdo.ai_spend_reservations',
			'DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
		)
		AND (
			SELECT pg_catalog.count(*) = 3
			FROM pg_catalog.pg_proc AS procedure
			WHERE procedure.oid IN (
				'emdo.reserve_ai_spend(text,uuid,text,text,text,text,text,bigint,bigint,bigint)'::regprocedure,
				'emdo.transition_ai_spend(text,text,text)'::regprocedure,
				'emdo.settle_ai_spend(text,text,bigint)'::regprocedure
			)
				AND procedure.proowner = 'emdo_metering_executor'::regrole
				AND procedure.prosecdef
				AND procedure.provolatile = 'v'
				AND procedure.proconfig @> ARRAY[
					'search_path=pg_catalog, emdo',
					'row_security=on'
				]::text[]
				AND pg_catalog.has_function_privilege(
					session_user, procedure.oid, 'EXECUTE'
				)
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS procedure
			CROSS JOIN LATERAL pg_catalog.aclexplode(
				COALESCE(
					procedure.proacl,
					pg_catalog.acldefault('f', procedure.proowner)
				)
			) AS privilege
			WHERE procedure.oid IN (
				'emdo.reserve_ai_spend(text,uuid,text,text,text,text,text,bigint,bigint,bigint)'::regprocedure,
				'emdo.transition_ai_spend(text,text,text)'::regprocedure,
				'emdo.settle_ai_spend(text,text,bigint)'::regprocedure
			)
				AND privilege.grantee = 0
				AND privilege.privilege_type = 'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_metering_executor',
			'emdo.lock_active_request_scope(uuid,uuid,uuid)',
			'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_metering_executor',
			'emdo.current_user_id()',
			'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_metering_executor',
			'emdo.current_session_id()',
			'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_metering_executor',
			'emdo.current_request_id()',
			'EXECUTE'
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS procedure
			WHERE procedure.oid = 'emdo.audio_spend_ready()'::regprocedure
				AND procedure.proowner = 'emdo_metering_executor'::regrole
				AND procedure.prosecdef
				AND procedure.provolatile = 's'
				AND procedure.proconfig @> ARRAY[
					'search_path=pg_catalog, emdo',
					'row_security=on'
				]::text[]
		)
$function$;
--> statement-breakpoint
ALTER FUNCTION emdo.audio_spend_ready()
	OWNER TO emdo_metering_executor;
REVOKE ALL ON FUNCTION emdo.audio_spend_ready()
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader;
GRANT EXECUTE ON FUNCTION emdo.audio_spend_ready()
	TO emdo_app;

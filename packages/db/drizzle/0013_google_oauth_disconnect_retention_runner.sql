DO $role$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_google_oauth_disconnect_retention_login'
	) THEN
		CREATE ROLE emdo_google_oauth_disconnect_retention_login NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$role$;
--> statement-breakpoint
ALTER ROLE emdo_google_oauth_disconnect_retention_login NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_oauth_grant_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_google_oauth_disconnect_retention NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_google_oauth_disconnect_reconciliation_login NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
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
			'emdo_google_oauth_disconnect_retention_login',
			'emdo_google_oauth_disconnect_reconciliation_executor',
			'emdo_google_oauth_disconnect_reconciliation',
			'emdo_google_oauth_disconnect_reconciliation_login'
		) OR parent.rolname IN (
			'emdo_oauth_grant_executor',
			'emdo_google_oauth_disconnect_retention',
			'emdo_google_oauth_disconnect_retention_login',
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
GRANT emdo_google_oauth_disconnect_retention
	TO emdo_google_oauth_disconnect_retention_login
	WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
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
			FROM pg_catalog.pg_roles AS role
			WHERE role.rolname =
				'emdo_google_oauth_disconnect_retention_login'
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
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_auth_members AS membership
			JOIN pg_catalog.pg_roles AS parent
				ON parent.oid = membership.roleid
			JOIN pg_catalog.pg_roles AS child
				ON child.oid = membership.member
			WHERE parent.rolname =
					'emdo_google_oauth_disconnect_retention'
				AND child.rolname =
					'emdo_google_oauth_disconnect_retention_login'
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
				'emdo_google_oauth_disconnect_reconciliation_login',
				'emdo_google_oauth_disconnect_retention_login'
			) OR child.rolname IN (
				'emdo_oauth_grant_executor',
				'emdo_google_oauth_disconnect_retention',
				'emdo_google_oauth_disconnect_reconciliation_executor',
				'emdo_google_oauth_disconnect_reconciliation',
				'emdo_google_oauth_disconnect_reconciliation_login',
				'emdo_google_oauth_disconnect_retention_login'
			)
		) = 2
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
			'INSERT,UPDATE,TRUNCATE,REFERENCES,TRIGGER'
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
		AND NOT pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_retention_login',
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
		AND NOT pg_catalog.has_function_privilege(
			'emdo_google_oauth_disconnect_retention_login',
			'emdo.purge_completed_google_oauth_disconnects(integer)',
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
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_roles AS policy
			WHERE policy.rolname =
				'emdo_google_oauth_disconnect_retention'
				AND policy.rolcanlogin = false
				AND policy.rolinherit = false
				AND policy.rolbypassrls = false
				AND policy.rolsuper = false
				AND policy.rolcreatedb = false
				AND policy.rolcreaterole = false
				AND policy.rolreplication = false
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
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_roles AS role
			WHERE role.rolname =
				'emdo_google_oauth_disconnect_retention_login'
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
					'emdo_google_oauth_disconnect_retention'
				AND child.rolname =
					'emdo_google_oauth_disconnect_retention_login'
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
				'emdo_google_oauth_disconnect_reconciliation_login',
				'emdo_google_oauth_disconnect_retention_login'
			) OR child.rolname IN (
				'emdo_oauth_grant_executor',
				'emdo_google_oauth_disconnect_retention',
				'emdo_google_oauth_disconnect_reconciliation_executor',
				'emdo_google_oauth_disconnect_reconciliation',
				'emdo_google_oauth_disconnect_reconciliation_login',
				'emdo_google_oauth_disconnect_retention_login'
			)
		) = 2
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
CREATE OR REPLACE FUNCTION emdo.google_oauth_disconnect_retention_runner_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
	SELECT
		session_user = 'emdo_google_oauth_disconnect_retention_login'
		AND pg_catalog.current_database() = 'emdo_app'
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_roles AS login
			WHERE login.rolname =
				'emdo_google_oauth_disconnect_retention_login'
				AND login.rolcanlogin = true
				AND login.rolinherit = false
				AND login.rolbypassrls = false
				AND login.rolsuper = false
				AND login.rolcreatedb = false
				AND login.rolcreaterole = false
				AND login.rolreplication = false
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_roles AS policy
			WHERE policy.rolname =
				'emdo_google_oauth_disconnect_retention'
				AND policy.rolcanlogin = false
				AND policy.rolinherit = false
				AND policy.rolbypassrls = false
				AND policy.rolsuper = false
				AND policy.rolcreatedb = false
				AND policy.rolcreaterole = false
				AND policy.rolreplication = false
		)
		AND pg_catalog.pg_has_role(
			session_user,
			'emdo_google_oauth_disconnect_retention', 'MEMBER'
		)
		AND pg_catalog.pg_has_role(
			session_user,
			'emdo_google_oauth_disconnect_retention', 'SET'
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
			'emdo_google_oauth_disconnect_reconciliation', 'MEMBER'
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
				'emdo_google_oauth_disconnect_retention_login',
				'emdo_google_oauth_disconnect_reconciliation_executor',
				'emdo_google_oauth_disconnect_reconciliation',
				'emdo_google_oauth_disconnect_reconciliation_login'
			) OR child.rolname IN (
				'emdo_oauth_grant_executor',
				'emdo_google_oauth_disconnect_retention',
				'emdo_google_oauth_disconnect_retention_login',
				'emdo_google_oauth_disconnect_reconciliation_executor',
				'emdo_google_oauth_disconnect_reconciliation',
				'emdo_google_oauth_disconnect_reconciliation_login'
			)
		) = 2
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
			'emdo.purge_completed_google_oauth_disconnects(integer)',
			'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_google_oauth_disconnect_retention',
			'emdo.purge_completed_google_oauth_disconnects(integer)',
			'EXECUTE'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_retention',
			'emdo.google_oauth_disconnect_operations',
			'SELECT,DELETE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_retention',
			'emdo.google_oauth_disconnect_operations',
			'INSERT,UPDATE,TRUNCATE,REFERENCES,TRIGGER'
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_proc AS procedure
			WHERE procedure.oid =
				'emdo.google_oauth_disconnect_retention_runner_ready()'::regprocedure
				AND procedure.prosecdef
				AND procedure.proowner = 'emdo_oauth_grant_executor'::regrole
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
				'emdo.google_oauth_disconnect_retention_runner_ready()'::regprocedure
				AND grantee.rolname =
					'emdo_google_oauth_disconnect_retention_login'
				AND privilege.privilege_type = 'EXECUTE'
		)
		AND NOT EXISTS (
			SELECT 1 FROM pg_catalog.pg_proc AS procedure
			WHERE procedure.pronamespace = 'emdo'::regnamespace
				AND procedure.oid <>
					'emdo.google_oauth_disconnect_retention_runner_ready()'::regprocedure
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
							session_user,
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
							session_user,
							relation.oid,
							'USAGE,SELECT,UPDATE'
						)
					ELSE false
				END
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_class AS relation
			WHERE relation.relnamespace = 'emdo'::regnamespace
				AND relation.oid <>
					'emdo.google_oauth_disconnect_operations'::regclass
				AND CASE
					WHEN relation.relkind IN ('r', 'p', 'v', 'm', 'f') THEN
						pg_catalog.has_table_privilege(
							'emdo_google_oauth_disconnect_retention',
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
							'emdo_google_oauth_disconnect_retention',
							relation.oid,
							'USAGE,SELECT,UPDATE'
						)
					ELSE false
				END
		)
		AND NOT EXISTS (
			SELECT 1 FROM pg_catalog.pg_proc AS procedure
			WHERE procedure.pronamespace = 'emdo'::regnamespace
				AND procedure.oid <>
					'emdo.purge_completed_google_oauth_disconnects(integer)'::regprocedure
				AND pg_catalog.has_function_privilege(
					'emdo_google_oauth_disconnect_retention',
					procedure.oid,
					'EXECUTE'
				)
		)
$function$;
--> statement-breakpoint
ALTER FUNCTION emdo.google_oauth_disconnect_ready()
	OWNER TO emdo_oauth_grant_executor;
ALTER FUNCTION emdo.google_oauth_disconnect_reconciliation_runner_ready()
	OWNER TO emdo_google_oauth_disconnect_reconciliation_executor;
ALTER FUNCTION emdo.google_oauth_disconnect_retention_runner_ready()
	OWNER TO emdo_oauth_grant_executor;
REVOKE ALL PRIVILEGES ON SCHEMA emdo
	FROM emdo_google_oauth_disconnect_retention_login;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA emdo
	FROM emdo_google_oauth_disconnect_retention_login;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA emdo
	FROM emdo_google_oauth_disconnect_retention_login;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA emdo
	FROM emdo_google_oauth_disconnect_retention_login;
REVOKE ALL ON FUNCTION emdo.google_oauth_disconnect_retention_runner_ready()
	FROM PUBLIC;
GRANT USAGE ON SCHEMA emdo
	TO emdo_google_oauth_disconnect_retention_login;
GRANT EXECUTE ON FUNCTION emdo.google_oauth_disconnect_retention_runner_ready()
	TO emdo_google_oauth_disconnect_retention_login;

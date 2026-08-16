DO $role$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_finance_import_retention_login'
	) THEN
		CREATE ROLE emdo_finance_import_retention_login NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$role$;
--> statement-breakpoint
ALTER ROLE emdo_finance_import_retention_login NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_finance_import_retention NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
--> statement-breakpoint
DO $memberships$
DECLARE
	child_role name;
	parent_role name;
BEGIN
	FOR child_role, parent_role IN
		SELECT child.rolname, parent.rolname
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		WHERE child.rolname IN (
			'emdo_finance_import_executor',
			'emdo_finance_import_retention',
			'emdo_finance_import_retention_login'
		) OR parent.rolname IN (
			'emdo_finance_import_executor',
			'emdo_finance_import_retention',
			'emdo_finance_import_retention_login'
		)
	LOOP
		EXECUTE format('REVOKE %I FROM %I', parent_role, child_role);
	END LOOP;
END
$memberships$;
--> statement-breakpoint
GRANT emdo_finance_import_retention TO emdo_finance_import_retention_login
	WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.finance_imports_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
	SELECT pg_catalog.has_function_privilege(
		'emdo_app', 'emdo.read_finance_import_preview_scope(text,uuid,uuid,text,text)', 'EXECUTE'
	) AND pg_catalog.has_function_privilege(
		'emdo_app', 'emdo.read_finance_import_destinations(uuid,uuid,text,text)', 'EXECUTE'
	) AND pg_catalog.has_function_privilege(
		'emdo_app', 'emdo.persist_finance_import_plan(uuid,text,text,jsonb,jsonb,jsonb,uuid,uuid,text,text,integer)', 'EXECUTE'
	) AND pg_catalog.has_function_privilege(
		'emdo_app', 'emdo.commit_finance_import_plan(uuid,text,uuid,uuid,text,text)', 'EXECUTE'
	) AND NOT pg_catalog.has_function_privilege(
		'emdo_app', 'emdo.resolve_finance_import_scope(text,uuid,uuid,text,text)', 'EXECUTE'
	) AND NOT pg_catalog.has_function_privilege(
		'emdo_app', 'emdo.purge_expired_finance_import_plans(integer)', 'EXECUTE'
	) AND NOT pg_catalog.has_function_privilege(
		'public', 'emdo.read_finance_import_preview_scope(text,uuid,uuid,text,text)', 'EXECUTE'
	) AND NOT pg_catalog.has_function_privilege(
		'public', 'emdo.read_finance_import_destinations(uuid,uuid,text,text)', 'EXECUTE'
	) AND NOT pg_catalog.has_function_privilege(
		'public', 'emdo.persist_finance_import_plan(uuid,text,text,jsonb,jsonb,jsonb,uuid,uuid,text,text,integer)', 'EXECUTE'
	) AND NOT pg_catalog.has_function_privilege(
		'public', 'emdo.commit_finance_import_plan(uuid,text,uuid,uuid,text,text)', 'EXECUTE'
	) AND NOT pg_catalog.has_table_privilege('emdo_app', 'emdo.finance_import_plans', 'SELECT,INSERT,UPDATE,DELETE')
		AND NOT pg_catalog.has_table_privilege('emdo_app', 'emdo.finance_import_fingerprints', 'SELECT,INSERT,UPDATE,DELETE')
		AND NOT pg_catalog.has_table_privilege('emdo_app', 'emdo.finance_import_receipts', 'SELECT,INSERT,UPDATE,DELETE')
		AND pg_catalog.has_column_privilege(
			'emdo_finance_import_executor', 'emdo.sync_entities', 'updated_at', 'UPDATE'
		)
		AND pg_catalog.has_column_privilege(
			'emdo_finance_import_executor', 'emdo.spaces', 'updated_at', 'UPDATE'
		)
		AND pg_catalog.has_column_privilege(
			'emdo_finance_import_executor', 'emdo.finance_import_fingerprints',
			'recorded_at', 'UPDATE'
		)
		AND pg_catalog.has_column_privilege(
			'emdo_finance_import_executor', 'emdo.finance_import_receipts',
			'committed_at', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_finance_import_executor', 'emdo.sync_entities', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_finance_import_executor', 'emdo.spaces', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_finance_import_executor', 'emdo.finance_import_fingerprints', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_finance_import_executor', 'emdo.finance_import_receipts', 'UPDATE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_finance_import_executor',
			'emdo.is_active_request_scope(uuid,uuid,uuid)', 'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_finance_import_executor', 'emdo.canonical_json_text(jsonb)', 'EXECUTE'
		)
		AND pg_catalog.has_column_privilege(
			'emdo_finance_import_retention', 'emdo.finance_import_plans',
			'created_at', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_finance_import_retention', 'emdo.finance_import_plans', 'UPDATE'
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_policy policy
			WHERE policy.polname = 'finance_import_plans_retention_lock'
				AND policy.polrelid = 'emdo.finance_import_plans'::regclass
				AND policy.polcmd = 'w'
				AND 'emdo_finance_import_retention'::regrole = ANY(policy.polroles)
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_policy policy
			WHERE policy.polname = 'sync_entities_finance_import_executor_select'
				AND policy.polrelid = 'emdo.sync_entities'::regclass
				AND policy.polcmd = 'r'
				AND 'emdo_finance_import_executor'::regrole = ANY(policy.polroles)
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_policy policy
			WHERE policy.polname = 'sync_entities_finance_import_executor_lock'
				AND policy.polrelid = 'emdo.sync_entities'::regclass
				AND policy.polcmd = 'w'
				AND 'emdo_finance_import_executor'::regrole = ANY(policy.polroles)
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_policy policy
			WHERE policy.polname = 'sync_entities_finance_import_executor_insert'
				AND policy.polrelid = 'emdo.sync_entities'::regclass
				AND policy.polcmd = 'a'
				AND 'emdo_finance_import_executor'::regrole = ANY(policy.polroles)
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_policy policy
			WHERE policy.polname = 'spaces_finance_import_executor_lock'
				AND policy.polrelid = 'emdo.spaces'::regclass
				AND policy.polcmd = 'w'
				AND 'emdo_finance_import_executor'::regrole = ANY(policy.polroles)
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_policy policy
			WHERE policy.polname = 'spaces_finance_import_executor_select'
				AND policy.polrelid = 'emdo.spaces'::regclass
				AND policy.polcmd = 'r'
				AND 'emdo_finance_import_executor'::regrole = ANY(policy.polroles)
		)
	AND EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_finance_import_executor'
			AND rolcanlogin = false AND rolinherit = false
			AND rolbypassrls = false AND rolsuper = false
	) AND EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_finance_import_retention'
			AND rolcanlogin = false AND rolinherit = false
			AND rolbypassrls = false AND rolsuper = false
	) AND EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_finance_import_retention_login'
			AND rolinherit = false AND rolbypassrls = false
			AND rolsuper = false AND rolcreatedb = false
			AND rolcreaterole = false AND rolreplication = false
	) AND EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname = 'emdo_finance_import_retention'
			AND child.rolname = 'emdo_finance_import_retention_login'
			AND membership.inherit_option = false
			AND membership.set_option = true
			AND membership.admin_option = false
	) AND (
		SELECT pg_catalog.count(*)
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname IN (
			'emdo_finance_import_executor',
			'emdo_finance_import_retention',
			'emdo_finance_import_retention_login'
		) OR child.rolname IN (
			'emdo_finance_import_executor',
			'emdo_finance_import_retention',
			'emdo_finance_import_retention_login'
		)
	) = 1 AND (
		SELECT pg_catalog.count(*) FROM pg_catalog.pg_class relation
		WHERE relation.oid IN ('emdo.finance_import_plans'::regclass, 'emdo.finance_import_fingerprints'::regclass, 'emdo.finance_import_receipts'::regclass)
			AND relation.relrowsecurity AND relation.relforcerowsecurity
	) = 3 AND (
		SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc proc
		WHERE proc.oid IN (
			'emdo.resolve_finance_import_scope(text,uuid,uuid,text,text)'::regprocedure,
			'emdo.read_finance_import_preview_scope(text,uuid,uuid,text,text)'::regprocedure,
			'emdo.read_finance_import_destinations(uuid,uuid,text,text)'::regprocedure,
			'emdo.persist_finance_import_plan(uuid,text,text,jsonb,jsonb,jsonb,uuid,uuid,text,text,integer)'::regprocedure,
			'emdo.commit_finance_import_plan(uuid,text,uuid,uuid,text,text)'::regprocedure,
			'emdo.finance_imports_ready()'::regprocedure
		) AND proc.prosecdef
			AND proc.proowner = 'emdo_finance_import_executor'::regrole
			AND proc.proconfig @> ARRAY['row_security=on', 'search_path=pg_catalog, emdo']
	) = 6 AND EXISTS (
		SELECT 1 FROM pg_catalog.pg_proc proc
		WHERE proc.oid = 'emdo.purge_expired_finance_import_plans(integer)'::regprocedure
			AND proc.prosecdef
			AND proc.proowner = 'emdo_finance_import_retention'::regrole
			AND proc.proconfig @> ARRAY['row_security=on', 'search_path=pg_catalog, emdo']
	)
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.finance_import_retention_runner_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
	SELECT session_user = 'emdo_finance_import_retention_login'
		AND pg_catalog.current_database() = 'emdo_app'
		AND emdo.finance_imports_ready()
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_roles login
			WHERE login.rolname = session_user
				AND login.rolcanlogin = true
				AND login.rolinherit = false
				AND login.rolbypassrls = false
				AND login.rolsuper = false
				AND login.rolcreatedb = false
				AND login.rolcreaterole = false
				AND login.rolreplication = false
		)
		AND pg_catalog.pg_has_role(
			session_user, 'emdo_finance_import_retention', 'MEMBER'
		)
		AND pg_catalog.pg_has_role(
			session_user, 'emdo_finance_import_retention', 'SET'
		)
		AND pg_catalog.has_database_privilege(session_user, 'emdo_app', 'CONNECT')
		AND pg_catalog.has_schema_privilege(session_user, 'emdo', 'USAGE')
		AND NOT pg_catalog.has_schema_privilege(session_user, 'emdo', 'CREATE')
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS procedure
			CROSS JOIN LATERAL pg_catalog.aclexplode(
				COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
			) AS privilege
			JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
			WHERE procedure.oid = 'emdo.finance_import_retention_runner_ready()'::regprocedure
				AND grantee.rolname = 'emdo_finance_import_retention_login'
				AND privilege.privilege_type = 'EXECUTE'
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS procedure
			CROSS JOIN LATERAL pg_catalog.aclexplode(
				COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
			) AS privilege
			JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
			WHERE procedure.oid = 'emdo.purge_expired_finance_import_plans(integer)'::regprocedure
				AND grantee.rolname = 'emdo_finance_import_retention_login'
				AND privilege.privilege_type = 'EXECUTE'
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_class AS relation
			CROSS JOIN LATERAL pg_catalog.aclexplode(
				COALESCE(
					relation.relacl,
					pg_catalog.acldefault(
						CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
						relation.relowner
					)
				)
			) AS privilege
			JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
			WHERE relation.relnamespace = 'emdo'::regnamespace
				AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')
				AND grantee.rolname = 'emdo_finance_import_retention_login'
		)
$function$;
--> statement-breakpoint
ALTER FUNCTION emdo.finance_imports_ready()
	OWNER TO emdo_finance_import_executor;
ALTER FUNCTION emdo.finance_import_retention_runner_ready()
	OWNER TO emdo_finance_import_executor;
REVOKE ALL PRIVILEGES ON SCHEMA emdo
	FROM emdo_finance_import_retention_login;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA emdo
	FROM emdo_finance_import_retention_login;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA emdo
	FROM emdo_finance_import_retention_login;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA emdo
	FROM emdo_finance_import_retention_login;
REVOKE ALL ON FUNCTION emdo.finance_import_retention_runner_ready() FROM PUBLIC;
GRANT USAGE ON SCHEMA emdo TO emdo_finance_import_retention_login;
GRANT EXECUTE ON FUNCTION emdo.finance_import_retention_runner_ready()
	TO emdo_finance_import_retention_login;

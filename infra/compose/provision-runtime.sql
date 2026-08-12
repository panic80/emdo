\set ON_ERROR_STOP on

-- Reassert every login's privilege attributes and rotate its password on every
-- deployment. pg_read_file executes in the PostgreSQL server, where Compose
-- mounts these secrets, so no password is placed in psql arguments or logs.
SELECT format(
  'CREATE ROLE emdo_owner_bootstrap_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/owner_bootstrap_database_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles
  WHERE rolname = 'emdo_owner_bootstrap_login'
) \gexec

SELECT format(
  'CREATE ROLE emdo_onboarding_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/onboarding_database_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles WHERE rolname = 'emdo_onboarding_login'
) \gexec

-- Upgrade existing volumes created before the three-principal worker split.
SELECT format(
  'CREATE ROLE emdo_worker_executor_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/worker_executor_database_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles WHERE rolname = 'emdo_worker_executor_login'
) \gexec
SELECT format(
  'CREATE ROLE emdo_worker_dispatcher_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/worker_dispatcher_database_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles WHERE rolname = 'emdo_worker_dispatcher_login'
) \gexec
SELECT format(
  'CREATE ROLE emdo_audio_reconciliation_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/audio_reconciliation_database_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles
  WHERE rolname = 'emdo_audio_reconciliation_login'
) \gexec
SELECT format(
  'CREATE ROLE emdo_workflow_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/workflow_database_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles WHERE rolname = 'emdo_workflow_login'
) \gexec

ALTER ROLE emdo_api_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  INHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_auth_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  INHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_onboarding_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  INHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_worker_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_worker_executor_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_worker_dispatcher_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_audio_reconciliation_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOBYPASSRLS NOREPLICATION;
-- The workflow login has no data-plane role membership. It receives only the
-- phase-specific aggregate entrypoints regranted below after blanket revocation.
ALTER ROLE emdo_workflow_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOBYPASSRLS NOREPLICATION;
-- Provisioning never leaves the deployment-only principal able to log in.
-- The protected owner-bootstrap wrapper enables it only for the bounded
-- one-shot and its EXIT trap disables it again.
ALTER ROLE emdo_owner_bootstrap_login NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_powersync_replication LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT BYPASSRLS REPLICATION;
ALTER ROLE emdo_powersync_storage LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOBYPASSRLS NOREPLICATION;

SELECT format(
  'ALTER ROLE emdo_api_login PASSWORD %L',
  trim(pg_read_file('/run/secrets/api_database_password'))
) \gexec
SELECT format(
  'ALTER ROLE emdo_auth_login PASSWORD %L',
  trim(pg_read_file('/run/secrets/auth_database_password'))
) \gexec
SELECT format(
  'ALTER ROLE emdo_onboarding_login PASSWORD %L',
  trim(pg_read_file('/run/secrets/onboarding_database_password'))
) \gexec
SELECT format(
  'ALTER ROLE emdo_worker_login PASSWORD %L',
  trim(pg_read_file('/run/secrets/worker_database_password'))
) \gexec
SELECT format(
  'ALTER ROLE emdo_worker_executor_login PASSWORD %L',
  trim(pg_read_file('/run/secrets/worker_executor_database_password'))
) \gexec
SELECT format(
  'ALTER ROLE emdo_worker_dispatcher_login PASSWORD %L',
  trim(pg_read_file('/run/secrets/worker_dispatcher_database_password'))
) \gexec
SELECT format(
  'ALTER ROLE emdo_audio_reconciliation_login PASSWORD %L',
  trim(pg_read_file('/run/secrets/audio_reconciliation_database_password'))
) \gexec
SELECT format(
  'ALTER ROLE emdo_workflow_login PASSWORD %L',
  trim(pg_read_file('/run/secrets/workflow_database_password'))
) \gexec
SELECT format(
  'ALTER ROLE emdo_owner_bootstrap_login PASSWORD %L',
  trim(pg_read_file('/run/secrets/owner_bootstrap_database_password'))
) \gexec
SELECT format(
  'ALTER ROLE emdo_powersync_replication PASSWORD %L',
  trim(pg_read_file('/run/secrets/powersync_replication_password'))
) \gexec
SELECT format(
  'ALTER ROLE emdo_powersync_storage PASSWORD %L',
  trim(pg_read_file('/run/secrets/powersync_storage_password'))
) \gexec

-- Reassert the complete cross-database CONNECT matrix on existing volumes.
-- First-volume initialization is not sufficient because a stale direct grant
-- or restored ACL would otherwise survive every later deployment.
REVOKE CONNECT ON DATABASE emdo_app FROM PUBLIC;
REVOKE CONNECT ON DATABASE emdo_app FROM
  emdo_api_login, emdo_auth_login, emdo_onboarding_login,
  emdo_worker_login,
  emdo_worker_executor_login, emdo_worker_dispatcher_login,
  emdo_audio_reconciliation_login, emdo_workflow_login,
  emdo_powersync_replication,
  emdo_owner_bootstrap_login, emdo_powersync_storage;
GRANT CONNECT ON DATABASE emdo_app TO
  emdo_api_login, emdo_auth_login, emdo_onboarding_login,
  emdo_worker_login,
  emdo_worker_executor_login, emdo_worker_dispatcher_login,
  emdo_audio_reconciliation_login, emdo_workflow_login,
  emdo_powersync_replication,
  emdo_owner_bootstrap_login;

REVOKE CONNECT ON DATABASE emdo_powersync FROM PUBLIC;
REVOKE CONNECT ON DATABASE emdo_powersync FROM
  emdo_api_login, emdo_auth_login, emdo_onboarding_login,
  emdo_worker_login,
  emdo_worker_executor_login, emdo_worker_dispatcher_login,
  emdo_audio_reconciliation_login, emdo_workflow_login,
  emdo_powersync_replication,
  emdo_powersync_storage, emdo_owner_bootstrap_login;
GRANT CONNECT ON DATABASE emdo_powersync TO emdo_powersync_storage;

-- Migrations create the NOLOGIN policy roles. These exact memberships keep
-- Every login is single-purpose. In particular emdo_auth_login must have
-- exactly one direct emdo_auth parent for the Better Auth claim bridge, while
-- emdo_onboarding_login has only emdo_onboarding for atomic invite redemption.
REVOKE ALL PRIVILEGES ON SCHEMA emdo FROM
  emdo_api_login, emdo_auth_login, emdo_onboarding_login,
  emdo_worker_login,
  emdo_worker_executor_login, emdo_worker_dispatcher_login,
  emdo_audio_reconciliation_login, emdo_workflow_login,
  emdo_powersync_replication,
  emdo_owner_bootstrap_login;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA emdo FROM
  emdo_api_login, emdo_auth_login, emdo_onboarding_login,
  emdo_worker_login,
  emdo_worker_executor_login, emdo_worker_dispatcher_login,
  emdo_audio_reconciliation_login, emdo_workflow_login,
  emdo_owner_bootstrap_login,
  emdo_powersync_replication;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA emdo FROM
  emdo_api_login, emdo_auth_login, emdo_onboarding_login,
  emdo_worker_login,
  emdo_worker_executor_login, emdo_worker_dispatcher_login,
  emdo_audio_reconciliation_login, emdo_workflow_login,
  emdo_owner_bootstrap_login,
  emdo_powersync_replication;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA emdo FROM
  emdo_api_login, emdo_auth_login, emdo_onboarding_login,
  emdo_worker_login,
  emdo_worker_executor_login, emdo_worker_dispatcher_login,
  emdo_audio_reconciliation_login, emdo_workflow_login,
  emdo_owner_bootstrap_login,
  emdo_powersync_replication;

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
      'emdo_api_login',
      'emdo_auth_login',
      'emdo_onboarding_login',
      'emdo_worker_login',
      'emdo_worker_executor_login',
      'emdo_worker_dispatcher_login',
      'emdo_audio_reconciliation_login',
      'emdo_workflow_login',
      'emdo_owner_bootstrap_login',
      'emdo_powersync_replication',
      'emdo_powersync_storage'
    )
  LOOP
    EXECUTE format('REVOKE %I FROM %I', parent_role, child_role);
  END LOOP;
END
$memberships$;

REVOKE emdo_workflow FROM emdo_workflow_login;
REVOKE emdo_workflow_executor FROM emdo_workflow_login;

GRANT emdo_app TO emdo_api_login
  WITH INHERIT TRUE, SET TRUE, ADMIN FALSE;
GRANT emdo_auth TO emdo_auth_login
  WITH INHERIT TRUE, SET TRUE, ADMIN FALSE;
GRANT emdo_onboarding TO emdo_onboarding_login
  WITH INHERIT TRUE, SET TRUE, ADMIN FALSE;
GRANT emdo_worker_executor TO emdo_worker_executor_login
  WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT emdo_worker_dispatch_executor TO emdo_worker_dispatcher_login
  WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT emdo_audio_reconciliation TO emdo_audio_reconciliation_login
  WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT emdo_owner_bootstrap TO emdo_owner_bootstrap_login
  WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;

GRANT USAGE ON SCHEMA emdo TO emdo_workflow_login;
GRANT EXECUTE ON FUNCTION
  emdo.commit_provider_proposal_create(text, jsonb),
  emdo.commit_provider_proposal_decision(text, jsonb),
  emdo.commit_provider_proposal_prepare(text, jsonb),
  emdo.commit_provider_proposal_dispatch(text, jsonb),
  emdo.commit_provider_proposal_abandonment(jsonb),
  emdo.commit_provider_proposal_transition(jsonb),
  emdo.commit_provider_proposal_completion(jsonb)
TO emdo_workflow_login;

REVOKE ALL PRIVILEGES ON SCHEMA pgboss FROM
  emdo_worker_executor_login, emdo_worker_dispatcher_login,
  emdo_audio_reconciliation_login;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA pgboss FROM
  emdo_worker_executor_login, emdo_worker_dispatcher_login,
  emdo_audio_reconciliation_login;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA pgboss FROM
  emdo_worker_executor_login, emdo_worker_dispatcher_login,
  emdo_audio_reconciliation_login;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA pgboss FROM
  emdo_worker_executor_login, emdo_worker_dispatcher_login,
  emdo_audio_reconciliation_login;

GRANT USAGE ON SCHEMA emdo TO emdo_powersync_replication;
GRANT SELECT ON
  emdo.households,
  emdo.household_memberships,
  emdo.spaces,
  emdo.space_records,
  emdo.sync_entities,
  emdo.conversation_events,
  emdo.audit_events
TO emdo_powersync_replication;

ALTER TABLE emdo.households REPLICA IDENTITY FULL;
ALTER TABLE emdo.household_memberships REPLICA IDENTITY FULL;
ALTER TABLE emdo.spaces REPLICA IDENTITY FULL;
ALTER TABLE emdo.space_records REPLICA IDENTITY FULL;
ALTER TABLE emdo.sync_entities REPLICA IDENTITY FULL;
ALTER TABLE emdo.conversation_events REPLICA IDENTITY FULL;
ALTER TABLE emdo.audit_events REPLICA IDENTITY FULL;

DO $publication$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_catalog.pg_publication WHERE pubname = 'powersync'
  ) THEN
    CREATE PUBLICATION powersync;
  END IF;
END
$publication$;

ALTER PUBLICATION powersync SET TABLE
  emdo.households,
  emdo.household_memberships,
  emdo.spaces,
  emdo.space_records,
  emdo.sync_entities,
  emdo.conversation_events,
  emdo.audit_events;

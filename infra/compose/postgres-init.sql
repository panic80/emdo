\set ON_ERROR_STOP on

-- This file runs only when the PostgreSQL volume is first initialized. The
-- server reads secret files directly, so passwords never appear in psql argv,
-- logs, Compose YAML, or the image. Runtime role membership and publication
-- grants are installed only after application migrations by
-- provision-runtime.sql.

SELECT format(
  'CREATE ROLE emdo_api_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/api_database_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles WHERE rolname = 'emdo_api_login'
) \gexec

SELECT format(
  'CREATE ROLE emdo_auth_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/auth_database_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles WHERE rolname = 'emdo_auth_login'
) \gexec

SELECT format(
  'CREATE ROLE emdo_onboarding_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/onboarding_database_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles WHERE rolname = 'emdo_onboarding_login'
) \gexec

SELECT format(
  'CREATE ROLE emdo_worker_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/worker_database_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles WHERE rolname = 'emdo_worker_login'
) \gexec

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
  'CREATE ROLE emdo_finance_import_retention_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/finance_import_retention_database_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles
  WHERE rolname = 'emdo_finance_import_retention_login'
) \gexec

SELECT format(
  'CREATE ROLE emdo_google_oauth_disconnect_reconciliation_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/google_oauth_disconnect_reconciliation_database_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles
  WHERE rolname = 'emdo_google_oauth_disconnect_reconciliation_login'
) \gexec

SELECT format(
  'CREATE ROLE emdo_google_oauth_disconnect_retention_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/google_oauth_disconnect_retention_database_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles
  WHERE rolname = 'emdo_google_oauth_disconnect_retention_login'
) \gexec

SELECT format(
  'CREATE ROLE emdo_workflow_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/workflow_database_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles WHERE rolname = 'emdo_workflow_login'
) \gexec

SELECT format(
  'CREATE ROLE emdo_visual_decision_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/visual_decision_database_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles
  WHERE rolname = 'emdo_visual_decision_login'
) \gexec

SELECT format(
  'CREATE ROLE emdo_owner_bootstrap_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/owner_bootstrap_database_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles
  WHERE rolname = 'emdo_owner_bootstrap_login'
) \gexec

SELECT format(
  'CREATE ROLE emdo_powersync_replication LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS REPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/powersync_replication_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles
  WHERE rolname = 'emdo_powersync_replication'
) \gexec

SELECT format(
  'CREATE ROLE emdo_powersync_storage LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L',
  trim(pg_read_file('/run/secrets/powersync_storage_password'))
)
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_roles WHERE rolname = 'emdo_powersync_storage'
) \gexec

SELECT 'CREATE DATABASE emdo_powersync OWNER emdo_powersync_storage'
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_database WHERE datname = 'emdo_powersync'
) \gexec

REVOKE CONNECT ON DATABASE emdo_app FROM PUBLIC;
REVOKE CONNECT ON DATABASE emdo_powersync FROM PUBLIC;
REVOKE CONNECT ON DATABASE emdo_powersync
  FROM emdo_api_login, emdo_auth_login, emdo_onboarding_login,
     emdo_worker_login, emdo_worker_executor_login,
     emdo_worker_dispatcher_login, emdo_audio_reconciliation_login,
     emdo_finance_import_retention_login,
     emdo_google_oauth_disconnect_reconciliation_login,
     emdo_google_oauth_disconnect_retention_login,
     emdo_workflow_login, emdo_visual_decision_login,
     emdo_powersync_replication, emdo_owner_bootstrap_login;
GRANT CONNECT ON DATABASE emdo_app
  TO emdo_api_login, emdo_auth_login, emdo_onboarding_login,
     emdo_worker_login,
     emdo_worker_executor_login, emdo_worker_dispatcher_login,
     emdo_audio_reconciliation_login, emdo_workflow_login,
     emdo_finance_import_retention_login,
     emdo_google_oauth_disconnect_reconciliation_login,
     emdo_google_oauth_disconnect_retention_login,
     emdo_visual_decision_login,
     emdo_powersync_replication,
     emdo_owner_bootstrap_login;
GRANT CONNECT ON DATABASE emdo_powersync TO emdo_powersync_storage;

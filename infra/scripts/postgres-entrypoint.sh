#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly role_password_source_directory=/run/secrets
readonly role_password_destination_directory=/run/emdo-role-passwords
readonly -a role_password_secrets=(
  api_database_password
  auth_database_password
  onboarding_database_password
  worker_database_password
  worker_executor_database_password
  worker_dispatcher_database_password
  audio_reconciliation_database_password
  finance_import_retention_database_password
  google_oauth_disconnect_reconciliation_database_password
  google_oauth_disconnect_retention_database_password
  workflow_database_password
  visual_decision_database_password
  powersync_replication_password
  powersync_storage_password
  owner_bootstrap_database_password
)

if [[ "$(id -u)" != 0 ]]; then
  printf '%s\n' '[emdo-postgres-entrypoint] must start as root' >&2
  exit 1
fi

install -d -o postgres -g postgres -m 0700 \
  "$role_password_destination_directory"

for secret_name in "${role_password_secrets[@]}"; do
  source_path="$role_password_source_directory/$secret_name"
  destination_path="$role_password_destination_directory/$secret_name"
  if [[ ! -f "$source_path" || -L "$source_path" || ! -s "$source_path" ]]; then
    printf '%s\n' "[emdo-postgres-entrypoint] required role secret is unavailable: $secret_name" >&2
    exit 1
  fi
  install -o postgres -g postgres -m 0400 \
    "$source_path" "$destination_path"
done

exec /usr/local/bin/docker-entrypoint.sh "$@"

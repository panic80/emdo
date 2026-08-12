#!/usr/bin/env bash
set -Eeuo pipefail

# shellcheck source=./_common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"

[[ "${PRODUCTION_OWNER_BOOTSTRAP_APPROVED:-}" == true ]] ||
  die 'production owner bootstrap requires explicit protected approval'

bootstrap_capacity_lock_fd=''
bootstrap_operation_lock_fd=''
acquire_host_lock /var/lib/emdo/locks/capacity.lock bootstrap_capacity_lock_fd
assert_no_active_staging_state
acquire_host_lock /var/lib/emdo/locks/production-mutation.lock bootstrap_operation_lock_fd
: "$bootstrap_capacity_lock_fd" "$bootstrap_operation_lock_fd"
current_lock="$PRODUCTION_STATE_DIR/current.env"
marker_file="$PRODUCTION_STATE_DIR/owner-bootstrap-complete"
assert_deployed_release_lock "$current_lock"
current_release_root="${IMAGE_LOCK_DEPLOYED_RELEASE_DIR}"
[[ "$INFRA_DIR" == "$current_release_root/infra" ]] ||
  die 'owner bootstrap must execute the assets bound to current production state'
assert_governed_parent_chain "$PRODUCTION_STATE_DIR" /var/lib/emdo
[[ ! -e "$marker_file" && ! -L "$marker_file" ]] ||
  die 'production owner bootstrap was already recorded'

export_digest_lock
load_deployment_config "$PRODUCTION_CONFIG_FILE"
export_required_config
assert_secret_directory_permissions "$SECRETS_DIR"
assert_directory_within "$SECRETS_DIR" /etc/emdo/production SECRETS_DIR
assert_base_secret_manifest "$SECRETS_DIR"
bootstrap_environment="$SECRETS_DIR/owner-bootstrap.env"
assert_secret_file_manifest "$SECRETS_DIR" owner-bootstrap.env

validate_bootstrap_environment() {
  local source_file="$1"
  local line key value seen='|' count=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *=* ]] || die 'owner bootstrap environment has a malformed line'
    key="${line%%=*}"
    value="${line#*=}"
    [[ -n "$value" && "$value" != *$'\r'* && "$value" != *$'\n'* ]] ||
      die 'owner bootstrap environment has an empty or invalid value'
    [[ "$seen" != *"|$key|"* ]] ||
      die 'owner bootstrap environment repeats a key'
    case "$key" in
      EMDO_BOOTSTRAP_DATABASE_URL)
        [[ "$value" =~ ^postgres(ql)?://emdo_owner_bootstrap_login:[^@/?#]+@postgres:5432/emdo_app([?]sslmode=disable)?$ ]] ||
          die 'owner bootstrap database URL must use only the dedicated login and internal database'
        ;;
      EMDO_BOOTSTRAP_HOUSEHOLD_NAME | EMDO_BOOTSTRAP_HOUSEHOLD_SLUG | EMDO_BOOTSTRAP_OWNER_EMAIL | EMDO_BOOTSTRAP_OWNER_NAME | EMDO_BOOTSTRAP_OWNER_PASSWORD)
        ;;
      *)
        die 'owner bootstrap environment contains a non-bootstrap key'
        ;;
    esac
    seen="${seen}${key}|"
    count=$((count + 1))
  done < "$source_file"

  [[ "$count" == 6 ]] || die 'owner bootstrap environment must contain exactly six keys'
  for key in \
    EMDO_BOOTSTRAP_DATABASE_URL \
    EMDO_BOOTSTRAP_HOUSEHOLD_NAME \
    EMDO_BOOTSTRAP_HOUSEHOLD_SLUG \
    EMDO_BOOTSTRAP_OWNER_EMAIL \
    EMDO_BOOTSTRAP_OWNER_NAME \
    EMDO_BOOTSTRAP_OWNER_PASSWORD; do
    [[ "$seen" == *"|$key|"* ]] ||
      die 'owner bootstrap environment is missing a required key'
  done
}

validate_bootstrap_environment "$bootstrap_environment"
assert_production_healthy

bootstrap_login_enabled=false
disable_bootstrap_login() {
  # Deliberately expand these variables only inside the container shell.
  # shellcheck disable=SC2016
  production_compose exec -T postgres /bin/sh -ec '
    export PGPASSWORD="$(tr -d "\r\n" < /run/secrets/postgres_superuser_password)"
    exec psql --host 127.0.0.1 --username postgres --dbname emdo_app \
      --set ON_ERROR_STOP=1 \
      --command "ALTER ROLE emdo_owner_bootstrap_login NOLOGIN NOINHERIT"
  '
}

cleanup_bootstrap_login() {
  local exit_code=$?
  trap - EXIT
  if [[ "$bootstrap_login_enabled" == true ]]; then
    disable_bootstrap_login ||
      log 'ERROR: emergency owner-bootstrap NOLOGIN cleanup failed'
  fi
  exit "$exit_code"
}
trap cleanup_bootstrap_login EXIT

bootstrap_login_enabled=true
# Deliberately expand these variables only inside the container shell.
# shellcheck disable=SC2016
production_compose exec -T postgres /bin/sh -ec '
  export PGPASSWORD="$(tr -d "\r\n" < /run/secrets/postgres_superuser_password)"
  exec psql --host 127.0.0.1 --username postgres --dbname emdo_app \
    --set ON_ERROR_STOP=1 \
    --command "ALTER ROLE emdo_owner_bootstrap_login LOGIN NOINHERIT"
'

set +e
production_compose --profile owner-bootstrap run --rm --no-deps owner-bootstrap
bootstrap_status=$?
set -e

disable_bootstrap_login
bootstrap_login_enabled=false

((bootstrap_status == 0)) || die 'production owner bootstrap did not complete'

marker_pending="$(mktemp "$PRODUCTION_STATE_DIR/.owner-bootstrap-complete.XXXXXX")"
printf 'completed_at=%s\nsource_sha=%s\n' \
  "$(date --utc +%FT%TZ)" "$IMAGE_LOCK_SOURCE_SHA" > "$marker_pending"
chmod 0600 "$marker_pending"
rm -- "$bootstrap_environment"
mv -- "$marker_pending" "$marker_file"
trap - EXIT
log 'production initial owner bootstrap completed; dedicated identity secret removed and database login disabled'

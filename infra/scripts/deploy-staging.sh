#!/usr/bin/env bash
set -Eeuo pipefail

# shellcheck source=infra/scripts/_common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"

run_id="${1:-}"
digest_lock="${2:-}"
ttl_minutes="${3:-60}"
assert_safe_identifier "$run_id" STAGING_RUN_ID
[[ "$run_id" =~ ^[0-9]{1,20}$ ]] || die 'STAGING_RUN_ID must be numeric'
[[ "$ttl_minutes" =~ ^[0-9]+$ ]] || die 'staging TTL must be an integer'
((ttl_minutes >= 15 && ttl_minutes <= 240)) ||
  die 'staging TTL must be between 15 and 240 minutes'

staging_capacity_lock_fd=''
acquire_host_lock /var/lib/emdo/locks/capacity.lock staging_capacity_lock_fd
: "$staging_capacity_lock_fd"
require_command docker
"$SCRIPT_DIR/preflight-staging.sh"
assert_digest_lock "$digest_lock"
export_digest_lock
load_deployment_config "$STAGING_CONFIG_FILE"

# assert_production_healthy isolates the same names in a subshell.
# shellcheck disable=SC2031
export COMPOSE_PROJECT_NAME="emdo-staging-$run_id" \
  DEPLOYMENT_NAMESPACE="staging-$run_id" \
  EMDO_ENVIRONMENT=staging
export STAGING_RUN_ID="$run_id"
export STAGING_HTTP_PORT="${DEPLOY_CONFIG_STAGING_HTTP_PORT:-18080}"
assert_unprivileged_tcp_port "$STAGING_HTTP_PORT"
export EMDO_DOMAIN='http://:8080'
export ACME_EMAIL='staging-invalid@emdo.invalid'
export POWERSYNC_JWKS_URI='http://api:3000/.well-known/jwks.json'
export SECRETS_DIR="${DEPLOY_CONFIG_SECRETS_DIR:-/etc/emdo/staging}"
assert_absolute_scoped_directory "$SECRETS_DIR" SECRETS_DIR
assert_secret_directory_permissions "$SECRETS_DIR"
assert_directory_within "$SECRETS_DIR" /etc/emdo/staging SECRETS_DIR
assert_staging_secret_manifest "$SECRETS_DIR"

state_dir="$STAGING_STATE_ROOT/$run_id"
assert_governed_parent_chain "$STAGING_STATE_ROOT" /var/lib/emdo
[[ ! -e "$state_dir" ]] || die "staging state already exists for run $run_id"
assert_isolated_project_absent "$COMPOSE_PROJECT_NAME" "$DEPLOYMENT_NAMESPACE"
install -d -o 0 -g 0 -m 0700 "$state_dir"
assert_governed_parent_chain "$state_dir" "$STAGING_STATE_ROOT"
install -m 0600 "$digest_lock" "$state_dir/images.env"
deadline_pending="$(mktemp "$state_dir/.expires-at-epoch.XXXXXX")"
printf '%s\n' "$(( $(date +%s) + 3600 ))" > "$deadline_pending"
chmod 0600 "$deadline_pending"
mv -- "$deadline_pending" "$state_dir/expires-at-epoch"

cleanup_failed_deploy() {
  local exit_code=$?
  trap - ERR
  log "staging deployment failed; removing only run $run_id"
  flock --unlock "$staging_capacity_lock_fd" || true
  "$SCRIPT_DIR/teardown-staging.sh" "$run_id" || true
  exit "$exit_code"
}
trap cleanup_failed_deploy ERR

staging_compose config --quiet
staging_compose pull
staging_compose up --detach postgres
staging_compose --profile operations run --rm migrate
staging_compose --profile operations run --rm job-schema
staging_compose --profile operations run --rm provision
staging_compose exec -T postgres psql \
  --username postgres --dbname emdo_app --set ON_ERROR_STOP=1 \
  --command 'ALTER ROLE emdo_owner_bootstrap_login LOGIN NOINHERIT'
staging_compose --profile operations run --rm synthetic-data
# Reassert the complete runtime grant matrix and return the deployment-only
# bootstrap principal to NOLOGIN immediately after synthetic seeding.
staging_compose --profile operations run --rm provision
staging_compose --profile operations run --rm caddy-init
staging_compose up --detach --remove-orphans
wait_for_compose_healthy staging_compose 300

deadline_pending="$(mktemp "$state_dir/.expires-at-epoch.XXXXXX")"
printf '%s\n' "$(( $(date +%s) + ttl_minutes * 60 ))" > "$deadline_pending"
chmod 0600 "$deadline_pending"
mv -- "$deadline_pending" "$state_dir/expires-at-epoch"

trap - ERR
log "staging run $run_id is healthy on loopback port $STAGING_HTTP_PORT; persistent expiry is $ttl_minutes minutes from health"

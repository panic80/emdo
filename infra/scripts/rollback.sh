#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# shellcheck source=./_common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"

[[ "${PRODUCTION_DEPLOYMENT_APPROVED:-}" == true ]] ||
  die 'protected production approval was not asserted'
[[ "${ROLLBACK_SCHEMA_COMPATIBLE:-}" == true ]] ||
  die 'ROLLBACK_SCHEMA_COMPATIBLE=true is required; this script never reverses database migrations'
[[ "${ROLLBACK_REASON:-}" =~ ^[a-zA-Z0-9][a-zA-Z0-9\ .,/_:-]{0,255}$ ]] ||
  die 'ROLLBACK_REASON must be one printable audit line'

rollback_capacity_lock_fd=''
rollback_operation_lock_fd=''
acquire_host_lock /var/lib/emdo/locks/capacity.lock rollback_capacity_lock_fd
assert_no_active_staging_state
acquire_host_lock /var/lib/emdo/locks/production-mutation.lock rollback_operation_lock_fd
: "$rollback_capacity_lock_fd" "$rollback_operation_lock_fd"
current_lock="$PRODUCTION_STATE_DIR/current.env"
previous_lock="$PRODUCTION_STATE_DIR/previous.env"
require_regular_file "$current_lock"
require_regular_file "$previous_lock"

assert_deployed_release_lock "$current_lock"
ROLLBACK_POSTGRES_IMAGE="$IMAGE_LOCK_POSTGRES_IMAGE"
ROLLBACK_POWERSYNC_IMAGE="$IMAGE_LOCK_POWERSYNC_IMAGE"
ROLLBACK_CADDY_IMAGE="$IMAGE_LOCK_CADDY_IMAGE"
ROLLBACK_DEPLOYED_RELEASE_DIR="$IMAGE_LOCK_DEPLOYED_RELEASE_DIR"
ROLLBACK_DEPLOYED_RELEASE_SOURCE_SHA="${IMAGE_LOCK_DEPLOYED_RELEASE_SOURCE_SHA:-$IMAGE_LOCK_SOURCE_SHA}"
actual_release_root="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
[[ "$actual_release_root" == "$ROLLBACK_DEPLOYED_RELEASE_DIR" ]] ||
  die 'rollback must execute the assets bound to current production state'

assert_digest_lock "$previous_lock"
ROLLBACK_SOURCE_SHA="$IMAGE_LOCK_SOURCE_SHA"
ROLLBACK_API_IMAGE="$IMAGE_LOCK_API_IMAGE"
ROLLBACK_WORKER_IMAGE="$IMAGE_LOCK_WORKER_IMAGE"
ROLLBACK_WEB_IMAGE="$IMAGE_LOCK_WEB_IMAGE"

# Roll back application images only. Infrastructure images and the Compose
# assets remain those of the currently deployed, staging-tested release.
rollback_lock="$(mktemp "$PRODUCTION_STATE_DIR/.rollback-candidate.XXXXXX")"
previous_pending="$(mktemp "$PRODUCTION_STATE_DIR/.previous-candidate.XXXXXX")"
runtime_mutated=false
cleanup_rollback() {
  local exit_code=$?
  trap - EXIT
  if [[ "$runtime_mutated" == true && -f "${failed_lock:-}" ]]; then
    log 'rollback failed after runtime mutation; reconciling the original current lock and assets'
    set +e
    assert_deployed_release_lock "$failed_lock"
    export_digest_lock
    reconciliation_failed=false
    for service in postgres api worker web powersync caddy; do
      expected_image="$(expected_image_for_service "$service")"
      if ! docker image inspect "$expected_image" >/dev/null 2>&1; then
        production_compose pull "$service" || reconciliation_failed=true
      fi
    done
    production_compose --profile operations run --rm caddy-init || reconciliation_failed=true
    production_compose up --detach --remove-orphans || reconciliation_failed=true
    wait_for_compose_healthy production_compose 300 || reconciliation_failed=true
    if [[ "$reconciliation_failed" == false ]]; then
      install -m 0600 "$failed_lock" "$current_lock" || reconciliation_failed=true
    fi
    if [[ "$reconciliation_failed" == true ]]; then
      log 'ERROR: original production state could not be reconciled; incident response is required'
    else
      log 'original current production state was restored after failed rollback'
    fi
    set -e
  fi
  rm -f -- "$rollback_lock" "$previous_pending"
  exit "$exit_code"
}
trap cleanup_rollback EXIT
printf '%s\n' \
  "SOURCE_SHA=$ROLLBACK_SOURCE_SHA" \
  "API_IMAGE=$ROLLBACK_API_IMAGE" \
  "WORKER_IMAGE=$ROLLBACK_WORKER_IMAGE" \
  "WEB_IMAGE=$ROLLBACK_WEB_IMAGE" \
  "POSTGRES_IMAGE=$ROLLBACK_POSTGRES_IMAGE" \
  "POWERSYNC_IMAGE=$ROLLBACK_POWERSYNC_IMAGE" \
  "CADDY_IMAGE=$ROLLBACK_CADDY_IMAGE" \
  "DEPLOYED_RELEASE_SOURCE_SHA=$ROLLBACK_DEPLOYED_RELEASE_SOURCE_SHA" \
  "DEPLOYED_RELEASE_DIR=$ROLLBACK_DEPLOYED_RELEASE_DIR" \
  > "$rollback_lock"
assert_deployed_release_lock "$rollback_lock"
export_digest_lock

load_deployment_config "$PRODUCTION_CONFIG_FILE"
export_required_config
assert_production_public_config
assert_governed_parent_chain "$PRODUCTION_STATE_DIR" /var/lib/emdo
assert_secret_directory_permissions "$SECRETS_DIR"
assert_directory_within "$SECRETS_DIR" /etc/emdo/production SECRETS_DIR
assert_base_secret_manifest "$SECRETS_DIR"
export COMPOSE_PROJECT_NAME=emdo-production
export DEPLOYMENT_NAMESPACE=production
export EMDO_ENVIRONMENT=production

failed_lock="$(mktemp "$PRODUCTION_STATE_DIR/failed-$(date --utc +%Y%m%dT%H%M%SZ).XXXXXX.env")"
install -m 0600 "$current_lock" "$failed_lock"
install -m 0600 "$failed_lock" "$previous_pending"

production_compose config --quiet
for service in api worker web; do
  expected_image="$(expected_image_for_service "$service")"
  if ! docker image inspect "$expected_image" >/dev/null 2>&1; then
    log "$service rollback image is not cached; pulling its exact digest"
    production_compose pull "$service"
  fi
  docker image inspect "$expected_image" >/dev/null 2>&1 ||
    die "$service rollback image is unavailable after the exact-digest pull"
done

# Candidate promotion may already have recreated steady services with candidate
# bind mounts or Compose settings while current.env still names this release.
# Reconcile the whole steady topology from the current bound release assets;
# only the application digests change and database migrations are never run or
# reversed here.
runtime_mutated=true
production_compose --profile operations run --rm caddy-init
production_compose up --detach --remove-orphans
wait_for_compose_healthy production_compose 300

mv -- "$rollback_lock" "$current_lock"
mv -- "$previous_pending" "$previous_lock"
runtime_mutated=false
printf '%s\t%s\t%s\t%s\n' \
  "$(date --utc +%FT%TZ)" \
  "${IMAGE_LOCK_SOURCE_SHA}" \
  "${GITHUB_RUN_ID:-manual}" \
  "$ROLLBACK_REASON" >> "$PRODUCTION_STATE_DIR/rollbacks.log"
chmod 0600 "$PRODUCTION_STATE_DIR/rollbacks.log"
log "application images rolled back to source ${IMAGE_LOCK_SOURCE_SHA}; database migrations were left intact"

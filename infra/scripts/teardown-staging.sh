#!/usr/bin/env bash
set -Eeuo pipefail

# shellcheck source=infra/scripts/_common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"

run_id="${1:-}"
assert_safe_identifier "$run_id" STAGING_RUN_ID
[[ "$run_id" =~ ^[0-9]{1,20}$ ]] || die 'STAGING_RUN_ID must be numeric'

staging_capacity_lock_fd=''
acquire_host_lock /var/lib/emdo/locks/capacity.lock staging_capacity_lock_fd
: "$staging_capacity_lock_fd"
state_dir="$STAGING_STATE_ROOT/$run_id"
digest_lock="$state_dir/images.env"
if [[ ! -d "$state_dir" ]]; then
  log "staging run $run_id is already absent"
  exit 0
fi

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

staging_compose down --volumes --remove-orphans --timeout 30
find "$state_dir" -xdev -type f -delete
rmdir "$state_dir"
log "staging run $run_id and its named volumes were removed"

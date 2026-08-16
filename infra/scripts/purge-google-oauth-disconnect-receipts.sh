#!/usr/bin/env bash
set -Eeuo pipefail

# shellcheck source=infra/scripts/_common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"

require_command docker

google_retention_capacity_lock_fd=''
google_retention_operation_lock_fd=''
acquire_host_lock /var/lib/emdo/locks/capacity.lock google_retention_capacity_lock_fd
acquire_host_lock /var/lib/emdo/locks/production-mutation.lock google_retention_operation_lock_fd
: "$google_retention_capacity_lock_fd" "$google_retention_operation_lock_fd"

assert_deployed_release_lock "$PRODUCTION_STATE_DIR/current.env"
google_retention_release_root="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
[[ "$google_retention_release_root" == "$IMAGE_LOCK_DEPLOYED_RELEASE_DIR" ]] ||
  die 'Google OAuth disconnect receipt retention must execute the assets bound to current production state'
export_digest_lock
load_deployment_config "$PRODUCTION_CONFIG_FILE"
export_required_config
assert_production_public_config
assert_secret_directory_permissions "$SECRETS_DIR"
assert_directory_within "$SECRETS_DIR" /etc/emdo/production SECRETS_DIR
assert_base_secret_manifest "$SECRETS_DIR"
# assert_compose_healthy isolates the same names in a subshell.
# shellcheck disable=SC2031
export COMPOSE_PROJECT_NAME=emdo-production \
  DEPLOYMENT_NAMESPACE=production \
  EMDO_ENVIRONMENT=production

assert_compose_healthy production_compose
production_compose --profile google-oauth-disconnect-retention run --rm --no-deps google-oauth-disconnect-retention
log 'Google OAuth disconnect receipt retention completed through the provider-free bounded runner'

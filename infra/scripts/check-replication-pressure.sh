#!/usr/bin/env bash
set -Eeuo pipefail

# shellcheck source=infra/scripts/_common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"

readonly MAX_WAL_LAG_BYTES=1610612736
readonly EXPECTED_WAL_CAP_BYTES=2147483648
readonly MIN_DOCKER_FREE_KIB=10485760

require_command awk
require_command df
require_command docker

assert_deployed_release_lock "$PRODUCTION_STATE_DIR/current.env"
monitor_release_root="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
[[ "$monitor_release_root" == "$IMAGE_LOCK_DEPLOYED_RELEASE_DIR" ]] ||
  die 'replication-pressure check must execute the assets bound to current production state'
export_digest_lock
load_deployment_config "$PRODUCTION_CONFIG_FILE"
export_required_config
assert_production_public_config
assert_secret_directory_permissions "$SECRETS_DIR"
assert_directory_within "$SECRETS_DIR" /etc/emdo/production SECRETS_DIR
assert_base_secret_manifest "$SECRETS_DIR"
# assert_production_healthy isolates the same names in a subshell.
# shellcheck disable=SC2031
export COMPOSE_PROJECT_NAME=emdo-production \
  DEPLOYMENT_NAMESPACE=production \
  EMDO_ENVIRONMENT=production

assert_compose_healthy production_compose

slot_pressure="$(
  production_compose exec -T postgres \
    psql --username postgres --dbname emdo_app \
      --no-align --tuples-only --field-separator='|' \
      --set ON_ERROR_STOP=1 \
      --command "
        SELECT
          COALESCE(MAX(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)), 0)::bigint,
          COUNT(*)::bigint,
          COUNT(*) FILTER (WHERE NOT active)::bigint,
          MAX(pg_size_bytes(current_setting('max_slot_wal_keep_size')))::bigint
        FROM pg_replication_slots
        WHERE slot_type = 'logical';
      "
)" || die 'could not inspect PostgreSQL logical-replication pressure'
[[ "$slot_pressure" =~ ^[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+$ ]] ||
  die 'PostgreSQL returned malformed logical-replication pressure data'
IFS='|' read -r wal_lag_bytes logical_slot_count inactive_slot_count wal_cap_bytes <<< "$slot_pressure"

((wal_cap_bytes == EXPECTED_WAL_CAP_BYTES)) ||
  die 'PostgreSQL logical-replication WAL cap differs from the reviewed 2 GiB limit'
((logical_slot_count > 0)) || die 'no logical replication slot exists'
((inactive_slot_count == 0)) || die 'logical replication slot is inactive'
((wal_lag_bytes <= MAX_WAL_LAG_BYTES)) ||
  die 'logical replication lag exceeds 1.5 GiB'

docker_root="$(docker info --format '{{.DockerRootDir}}')" ||
  die 'could not resolve Docker storage root'
assert_absolute_scoped_directory "$docker_root" DOCKER_ROOT
require_directory "$docker_root"
docker_free_kib="$(df -Pk -- "$docker_root" | awk 'NR == 2 { print $4 }')"
[[ "$docker_free_kib" =~ ^[0-9]+$ ]] ||
  die 'could not read Docker storage free space'
((docker_free_kib >= MIN_DOCKER_FREE_KIB)) ||
  die 'Docker storage has less than 10 GiB free'

log "replication pressure passed: slots=$logical_slot_count inactive=$inactive_slot_count lag=${wal_lag_bytes}B docker_free=${docker_free_kib}KiB"

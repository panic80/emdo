#!/usr/bin/env bash
set -Eeuo pipefail

# shellcheck source=infra/scripts/_common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"

candidate_lock="${1:-}"
attestation_file="${2:-}"
snapshot_reference="${HOSTINGER_SNAPSHOT_REFERENCE:-}"
snapshot_confirmed_at="${HOSTINGER_SNAPSHOT_CONFIRMED_AT:-}"

[[ "${PRODUCTION_DEPLOYMENT_APPROVED:-}" == true ]] ||
  die 'protected production approval was not asserted'
[[ "$snapshot_reference" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.:-]{5,127}$ ]] ||
  die 'HOSTINGER_SNAPSHOT_REFERENCE is required'
[[ "$snapshot_confirmed_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] ||
  die 'HOSTINGER_SNAPSHOT_CONFIRMED_AT must be an ISO-8601 timestamp'

require_command date
snapshot_epoch="$(date --date "$snapshot_confirmed_at" +%s)" ||
  die 'snapshot timestamp could not be parsed'
now_epoch="$(date +%s)"
snapshot_age=$((now_epoch - snapshot_epoch))
((snapshot_age >= 0 && snapshot_age <= 21600)) ||
  die 'manual Hostinger snapshot confirmation must be no more than six hours old'

assert_staging_attestation_matches "$candidate_lock" "$attestation_file"
staging_tested_at="$IMAGE_LOCK_STAGING_TESTED_AT"
attested_initial_bootstrap="$IMAGE_LOCK_INITIAL_DEPLOYMENT_BOOTSTRAP"
assert_digest_lock "$candidate_lock"
export_digest_lock
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]{1,20}$ ]] ||
  die 'GITHUB_RUN_ID must identify the protected production workflow run'
release_root="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
expected_release_root="/opt/emdo/releases/${IMAGE_LOCK_SOURCE_SHA}-${GITHUB_RUN_ID}"
[[ "$release_root" == "$expected_release_root" ]] ||
  die 'deployment script is not running from the attested release directory'
staging_epoch="$(date --date "$staging_tested_at" +%s)" ||
  die 'staging attestation timestamp could not be parsed'
staging_age=$((now_epoch - staging_epoch))
((staging_age >= 0 && staging_age <= 86400)) ||
  die 'staging acceptance must be no more than 24 hours old'
load_deployment_config "$PRODUCTION_CONFIG_FILE"
export_required_config
assert_production_public_config
assert_secret_directory_permissions "$SECRETS_DIR"
assert_directory_within "$SECRETS_DIR" /etc/emdo/production SECRETS_DIR
assert_base_secret_manifest "$SECRETS_DIR"
# shellcheck disable=SC2031 -- assert_production_healthy isolates the same names in a subshell.
export COMPOSE_PROJECT_NAME=emdo-production \
  DEPLOYMENT_NAMESPACE=production \
  EMDO_ENVIRONMENT=production

current_lock="$PRODUCTION_STATE_DIR/current.env"
previous_lock="$PRODUCTION_STATE_DIR/previous.env"
pending_lock="$PRODUCTION_STATE_DIR/pending.env"
current_present=false
initial_resume=false

if [[ -L "$PRODUCTION_STATE_DIR" ]]; then
  die 'production state directory must not be a symlink'
fi
if [[ -e "$PRODUCTION_STATE_DIR" && ! -d "$PRODUCTION_STATE_DIR" ]]; then
  die 'production state path must be a directory'
fi
if [[ -d "$PRODUCTION_STATE_DIR" ]]; then
  assert_governed_parent_chain "$PRODUCTION_STATE_DIR" /var/lib/emdo
fi
if [[ -L "$current_lock" ]]; then
  die 'current production lock must not be a symlink'
elif [[ -f "$current_lock" ]]; then
  current_present=true
elif [[ -e "$current_lock" ]]; then
  die 'current production lock must be a regular file'
fi

if [[ "$current_present" == false && -e "$pending_lock" ]]; then
  require_regular_file "$pending_lock"
  assert_deployed_release_lock "$pending_lock"
  pending_release_root="$IMAGE_LOCK_DEPLOYED_RELEASE_DIR"
  pending_archive_digest="$(< "$pending_release_root/.archive-sha256")"
  pending_values=()
  for key in "${DIGEST_KEYS[@]}"; do
    pending_values+=("$(image_lock_value "$key")")
  done

  assert_digest_lock "$candidate_lock"
  index=0
  for key in "${DIGEST_KEYS[@]}"; do
    [[ "$(image_lock_value "$key")" == "${pending_values[$index]}" ]] ||
      die 'an initial deployment may resume only the exact pending image lock'
    index=$((index + 1))
  done
  [[ "$(< "$release_root/.archive-sha256")" == "$pending_archive_digest" ]] ||
    die 'an initial deployment may resume only byte-identical reviewed deployment assets'
  export_digest_lock
  initial_resume=true
fi

assert_initial_bootstrap_policy \
  "${EMDO_INITIAL_DEPLOYMENT:-false}" \
  "${INITIAL_BOOTSTRAP_ACKNOWLEDGED:-false}" \
  "$attested_initial_bootstrap" \
  "$current_present"

if [[ "$current_present" == true ]]; then
  # The MVP promotion/rollback state machine is application-only. Refuse an
  # infrastructure digest change before backup, migration, pull, or mutation
  # so a failed promotion cannot leave runtime images ahead of current.env.
  assert_infrastructure_promotion_unchanged "$current_lock" "$candidate_lock"
  assert_production_healthy
  assert_deployed_release_lock "$current_lock"
  current_release_root="${IMAGE_LOCK_DEPLOYED_RELEASE_DIR}"
  current_archive_digest="$(< "$current_release_root/.archive-sha256")"
  assert_root_owned_bounded_file "$release_root/.archive-sha256" 644 128
  [[ "$(< "$release_root/.archive-sha256")" == "$current_archive_digest" ]] ||
    die 'ordinary application promotion cannot change Compose, Caddy, PowerSync, database provisioning, or host scripts'
  current_backup_script="$current_release_root/infra/scripts/backup-logical.sh"
  require_regular_file "$current_backup_script"
  [[ -x "$current_backup_script" ]] ||
    die 'the currently deployed release backup entrypoint is not executable'
  "$current_backup_script"
else
  if [[ "$initial_resume" == true ]]; then
    log 'resuming the exact failed initial candidate without deleting its database or volumes'
  else
    assert_initial_production_absent
  fi
fi

production_capacity_lock_fd=''
production_operation_lock_fd=''
acquire_host_lock /var/lib/emdo/locks/capacity.lock production_capacity_lock_fd
assert_no_active_staging_state
acquire_host_lock /var/lib/emdo/locks/production-mutation.lock production_operation_lock_fd
: "$production_capacity_lock_fd" "$production_operation_lock_fd"

# The backup command above holds and releases the same production lock. After
# reacquiring it, revalidate the state that will become previous.env so a
# concurrent manual operator can only make this deployment fail closed.
if [[ "$current_present" == true ]]; then
  assert_deployed_release_lock "$current_lock"
  assert_infrastructure_promotion_unchanged "$current_lock" "$candidate_lock"
  [[ "$(< "$IMAGE_LOCK_DEPLOYED_RELEASE_DIR/.archive-sha256")" == "$(< "$release_root/.archive-sha256")" ]] ||
    die 'the active infrastructure assets changed after the pre-deployment backup'
  install -m 0600 "$current_lock" "$previous_lock"
elif [[ "$initial_resume" == false ]]; then
  assert_initial_production_absent
fi

# Current-release validation intentionally loads the current image lock. Restore
# the already-attested candidate environment before any Compose operation or
# final deployment audit is performed.
assert_digest_lock "$candidate_lock"
export_digest_lock

install -d -o 0 -g 0 -m 0700 "$PRODUCTION_STATE_DIR"
assert_governed_parent_chain "$PRODUCTION_STATE_DIR" /var/lib/emdo
if [[ "$initial_resume" == true ]]; then
  failed_initial_lock="$(mktemp "$PRODUCTION_STATE_DIR/failed-initial-$(date --utc +%Y%m%dT%H%M%SZ).XXXXXX.env")"
  install -m 0600 "$pending_lock" "$failed_initial_lock"
fi
install -m 0600 "$candidate_lock" "$pending_lock"
printf 'DEPLOYED_RELEASE_DIR=%s\n' "$release_root" >> "$pending_lock"
assert_deployed_release_lock "$pending_lock"

production_compose config --quiet
production_compose pull
production_compose up --detach postgres
production_compose --profile operations run --rm migrate
production_compose --profile operations run --rm job-schema
production_compose --profile operations run --rm provision
production_compose --profile operations run --rm caddy-init
production_compose up --detach --remove-orphans

if ! (wait_for_compose_healthy production_compose 300); then
  log 'production health failed; pending lock retained and database was not reversed'
  log 'run rollback.sh through the protected production workflow only after confirming schema compatibility'
  exit 1
fi

require_command curl
curl --fail --silent --show-error --max-time 30 \
  --proto '=https' --tlsv1.2 \
  "https://$EMDO_DOMAIN/healthz" >/dev/null
curl --fail --silent --show-error --max-time 30 \
  --proto '=https' --tlsv1.2 \
  "https://$EMDO_DOMAIN/readyz" >/dev/null

mv -- "$pending_lock" "$current_lock"
printf '%s\t%s\t%s\t%s\n' \
  "$(date --utc +%FT%TZ)" \
  "${IMAGE_LOCK_SOURCE_SHA}" \
  "$snapshot_reference" \
  "${GITHUB_RUN_ID:-manual}" >> "$PRODUCTION_STATE_DIR/deployments.log"
chmod 0600 "$PRODUCTION_STATE_DIR/deployments.log"
log "production is healthy at source ${IMAGE_LOCK_SOURCE_SHA}"

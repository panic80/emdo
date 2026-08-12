#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# shellcheck source=./_common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"

backup_file="${1:-}"
restore_id="${RESTORE_RUN_ID:-}"
digest_lock="${RESTORE_IMAGE_LOCK_FILE:-}"
identity_file="${BACKUP_AGE_IDENTITY_FILE:-}"

[[ "${RESTORE_TARGET_ENVIRONMENT:-}" == staging ]] ||
  die 'RESTORE_TARGET_ENVIRONMENT must be exactly staging'
assert_safe_identifier "$restore_id" RESTORE_RUN_ID
[[ "$restore_id" =~ ^[0-9]{1,20}$ ]] || die 'RESTORE_RUN_ID must be numeric'
restore_capacity_lock_fd=''
restore_operation_lock_fd=''
acquire_host_lock /var/lib/emdo/locks/capacity.lock restore_capacity_lock_fd
assert_no_active_staging_state
acquire_host_lock /var/lib/emdo/locks/production-mutation.lock restore_operation_lock_fd
: "$restore_capacity_lock_fd" "$restore_operation_lock_fd"
require_regular_file "$backup_file"
require_regular_file "$backup_file.sha256"
require_regular_file "$backup_file.complete"

export COMPOSE_PROJECT_NAME="emdo-restore-$restore_id"
export DEPLOYMENT_NAMESPACE="restore-$restore_id"
export EMDO_ENVIRONMENT=staging
export EMDO_DOMAIN='http://:8080'
export ACME_EMAIL='restore-invalid@emdo.invalid'
export POWERSYNC_JWKS_URI='http://api:3000/.well-known/jwks.json'
export SECRETS_DIR="${RESTORE_SECRETS_DIR:-/etc/emdo/restore/$restore_id}"
[[ "$SECRETS_DIR" == /etc/emdo/restore/* ]] ||
  die 'RESTORE_SECRETS_DIR must be beneath /etc/emdo/restore/'
assert_absolute_scoped_directory "$SECRETS_DIR" RESTORE_SECRETS_DIR
assert_secret_directory_permissions "$SECRETS_DIR"
assert_directory_within "$SECRETS_DIR" "/etc/emdo/restore/$restore_id" RESTORE_SECRETS_DIR
assert_base_secret_manifest "$SECRETS_DIR"
[[ "$(basename -- "$digest_lock")" == images.env ]] ||
  die 'RESTORE_IMAGE_LOCK_FILE must be the governed images.env file'
digest_lock_directory="$(dirname -- "$digest_lock")"
assert_directory_within "$digest_lock_directory" "$SECRETS_DIR" RESTORE_IMAGE_LOCK_DIRECTORY
assert_root_owned_bounded_file "$digest_lock" 600 32768
assert_digest_lock "$digest_lock"
export_digest_lock
identity_directory="$(dirname -- "$identity_file")"
assert_directory_within "$identity_directory" "$SECRETS_DIR" BACKUP_AGE_IDENTITY_DIRECTORY
assert_root_owned_bounded_file "$identity_file" 600 65536

require_command docker
require_command age
require_command sha256sum
require_command tar
assert_isolated_project_absent "$COMPOSE_PROJECT_NAME" "$DEPLOYMENT_NAMESPACE"

backup_dir="$(cd -- "$(dirname -- "$backup_file")" && pwd -P)"
backup_root=/var/backups/emdo/logical
assert_governed_parent_chain "$backup_root" /var/backups/emdo
assert_directory_within "$backup_dir" "$backup_root" RESTORE_BACKUP_DIRECTORY
backup_name="$(basename -- "$backup_file")"
[[ "$backup_name" =~ ^emdo-logical-[0-9]{8}T[0-9]{6}Z\.age$ ]] ||
  die 'backup filename does not match the governed logical-backup format'
assert_root_owned_bounded_file "$backup_file" 600 107374182400
assert_root_owned_bounded_file "$backup_file.sha256" 600 4096
assert_root_owned_bounded_file "$backup_file.complete" 600 4096
read -r recorded_digest recorded_name checksum_extra < "$backup_file.sha256"
[[ "$recorded_digest" =~ ^[0-9a-f]{64}$ && "$recorded_name" == "$backup_name" && -z "${checksum_extra:-}" ]] ||
  die 'checksum record does not name the selected backup'
expected_completion="$(printf '%s\n' 'schema=emdo-logical-backup-v1' "bundle=$backup_name" "sha256=$recorded_digest")"
[[ "$(< "$backup_file.complete")" == "$expected_completion" ]] ||
  die 'backup completion marker does not match the selected backup and digest'
(
  cd -- "$backup_dir"
  printf '%s  %s\n' "$recorded_digest" "$backup_name" |
    sha256sum --check --strict -
)

work_dir="$(mktemp -d "/tmp/emdo-restore-$restore_id.XXXXXX")"
bundle_file="$work_dir/bundle.tar"
restore_compose() {
  docker compose \
    --project-name "$COMPOSE_PROJECT_NAME" \
    --file "$COMPOSE_DIR/compose.yml" \
    "$@"
}

cleanup_restore() {
  local exit_code=$?
  trap - EXIT
  if [[ "${RESTORE_KEEP:-false}" != true ]]; then
    restore_compose down --volumes --remove-orphans --timeout 30 || true
  fi
  find "$work_dir" -xdev -type f -delete 2>/dev/null || true
  rmdir "$work_dir" 2>/dev/null || true
  exit "$exit_code"
}
trap cleanup_restore EXIT

age --decrypt --identity "$identity_file" \
  --output "$bundle_file" "$backup_file"

declare -A archive_entries=()
archive_entry_count=0
while IFS= read -r entry; do
  case "$entry" in
    metadata.txt | emdo_app.dump.age | emdo_powersync.dump.age) ;;
    *) die "backup contains unexpected archive entry: $entry" ;;
  esac
  [[ -z "${archive_entries[$entry]+present}" ]] ||
    die "backup contains duplicate archive entry: $entry"
  archive_entries[$entry]=present
  ((archive_entry_count += 1))
done < <(tar --list --file "$bundle_file")
[[ "$archive_entry_count" == 3 ]] ||
  die 'backup does not contain the exact required archive entries'
for entry in metadata.txt emdo_app.dump.age emdo_powersync.dump.age; do
  [[ -n "${archive_entries[$entry]+present}" ]] ||
    die "backup is missing required archive entry: $entry"
  # Stream each allowlisted member into a fixed regular destination. Never let
  # tar materialize archive-controlled file types, links, modes, or paths.
  tar --extract --to-stdout --file "$bundle_file" -- "$entry" > "$work_dir/$entry"
  require_regular_file "$work_dir/$entry"
  [[ -s "$work_dir/$entry" ]] ||
    die "backup archive entry is empty: $entry"
  chmod 0600 "$work_dir/$entry"
done

declare -A metadata_values=()
metadata_count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" == *=* ]] || die 'backup metadata contains a malformed line'
  metadata_key="${line%%=*}"
  metadata_value="${line#*=}"
  [[ -n "$metadata_value" ]] || die 'backup metadata contains an empty value'
  [[ -z "${metadata_values[$metadata_key]+present}" ]] ||
    die 'backup metadata contains a duplicate key'
  case "$metadata_key" in
    schema | created_at | source_sha | postgres_image) ;;
    *) die 'backup metadata contains an unexpected key' ;;
  esac
  metadata_values[$metadata_key]="$metadata_value"
  metadata_count=$((metadata_count + 1))
done < "$work_dir/metadata.txt"
[[ "$metadata_count" == 4 ]] || die 'backup metadata does not contain the exact required keys'
[[ "${metadata_values[schema]:-}" == emdo-logical-backup-v1 ]] ||
  die 'backup metadata schema is unsupported'
[[ "${metadata_values[created_at]:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
  die 'backup metadata creation time is invalid'
[[ "${metadata_values[source_sha]:-}" =~ ^[0-9a-f]{40}$ ]] ||
  die 'backup metadata source SHA is invalid'
[[ "${metadata_values[postgres_image]:-}" == "$IMAGE_LOCK_POSTGRES_IMAGE" ]] ||
  die 'backup PostgreSQL image is incompatible with the restore image lock'

restore_compose config --quiet
restore_compose up --detach postgres
# Bootstrap current cluster-global policy roles and the pg-boss owner before
# replaying ownership and ACL entries from the logical dumps.
restore_compose --profile operations run --rm migrate
restore_compose --profile operations run --rm job-schema

age --decrypt --identity "$identity_file" "$work_dir/emdo_app.dump.age" \
  | restore_compose exec -T postgres \
      pg_restore --username postgres --dbname emdo_app \
        --clean --if-exists --exit-on-error

age --decrypt --identity "$identity_file" "$work_dir/emdo_powersync.dump.age" \
  | restore_compose exec -T postgres \
      pg_restore --username postgres --dbname emdo_powersync \
        --clean --if-exists --exit-on-error

restore_compose --profile operations run --rm migrate
restore_compose --profile operations run --rm job-schema
restore_compose --profile operations run --rm provision
restore_compose exec -T postgres psql \
  --username postgres --dbname emdo_app --set ON_ERROR_STOP=1 \
  --command "select 1 from emdo.households limit 1;" >/dev/null

install -d -m 0700 /var/lib/emdo/restore-drills
printf '%s\t%s\t%s\t%s\t%s\n' \
  "$(date --utc +%FT%TZ)" \
  "$restore_id" \
  "${IMAGE_LOCK_SOURCE_SHA}" \
  "$backup_name" \
  "$recorded_digest" \
  >> /var/lib/emdo/restore-drills/success.log
chmod 0600 /var/lib/emdo/restore-drills/success.log
log "logical restore drill $restore_id passed in isolated project $COMPOSE_PROJECT_NAME"

#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# shellcheck source=./_common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"

backup_capacity_lock_fd=''
backup_operation_lock_fd=''
acquire_host_lock /var/lib/emdo/locks/capacity.lock backup_capacity_lock_fd
acquire_host_lock /var/lib/emdo/locks/production-mutation.lock backup_operation_lock_fd
: "$backup_capacity_lock_fd" "$backup_operation_lock_fd"
require_command docker
require_command age
require_command sha256sum
require_command tar
assert_deployed_release_lock "$PRODUCTION_STATE_DIR/current.env"
backup_release_root="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
[[ "$backup_release_root" == "$IMAGE_LOCK_DEPLOYED_RELEASE_DIR" ]] ||
  die 'backup must execute the assets bound to current production state'
export_digest_lock
load_deployment_config "$PRODUCTION_CONFIG_FILE"
export_required_config
assert_production_public_config
assert_secret_directory_permissions "$SECRETS_DIR"
assert_directory_within "$SECRETS_DIR" /etc/emdo/production SECRETS_DIR
assert_base_secret_manifest "$SECRETS_DIR"
export COMPOSE_PROJECT_NAME=emdo-production
export DEPLOYMENT_NAMESPACE=production
export EMDO_ENVIRONMENT=production

backup_dir="${DEPLOY_CONFIG_BACKUP_DIR:-/var/backups/emdo/logical}"
recipients_file="${DEPLOY_CONFIG_BACKUP_AGE_RECIPIENTS_FILE:-/etc/emdo/backup/age-recipients.txt}"
assert_absolute_scoped_directory "$backup_dir" BACKUP_DIR
require_directory "$backup_dir"
assert_governed_parent_chain "$backup_dir" /var/backups/emdo
assert_governed_parent_chain "$(dirname -- "$recipients_file")" /etc/emdo/backup
assert_directory_within "$(dirname -- "$recipients_file")" /etc/emdo/backup BACKUP_AGE_RECIPIENTS_DIRECTORY
assert_root_owned_bounded_file "$recipients_file" 600 65536

timestamp="$(date --utc +%Y%m%dT%H%M%SZ)"
basename="emdo-logical-$timestamp"
work_dir="$(mktemp -d "$backup_dir/.${basename}.work.XXXXXX")"
pending_file="$backup_dir/.${basename}.age.pending"
final_file="$backup_dir/${basename}.age"
checksum_file="$final_file.sha256"
checksum_pending="$backup_dir/.${basename}.age.sha256.pending"
complete_file="$final_file.complete"
complete_pending="$backup_dir/.${basename}.age.complete.pending"

[[ ! -e "$pending_file" && ! -e "$checksum_pending" && ! -e "$complete_pending" && ! -e "$final_file" && ! -e "$checksum_file" && ! -e "$complete_file" ]] ||
  die "backup output already exists for timestamp $timestamp"

cleanup_backup() {
  find "$work_dir" -xdev -type f -delete 2>/dev/null || true
  rmdir "$work_dir" 2>/dev/null || true
  rm -f -- "$pending_file" "$checksum_pending" "$complete_pending"
  if [[ ! -f "$complete_file" ]]; then
    rm -f -- "$final_file" "$checksum_file"
  fi
}
trap cleanup_backup EXIT

# Each database stream is encrypted before touching disk. The outer encrypted
# bundle keeps even filenames and metadata private at rest.
production_compose exec -T postgres \
  pg_dump --username postgres --dbname emdo_app \
    --format=custom --compress=9 \
  | age --encrypt --recipients-file "$recipients_file" \
      --output "$work_dir/emdo_app.dump.age"

production_compose exec -T postgres \
  pg_dump --username postgres --dbname emdo_powersync \
    --format=custom --compress=9 \
  | age --encrypt --recipients-file "$recipients_file" \
      --output "$work_dir/emdo_powersync.dump.age"

printf '%s\n' \
  "schema=emdo-logical-backup-v1" \
  "created_at=$(date --utc +%FT%TZ)" \
  "source_sha=${IMAGE_LOCK_SOURCE_SHA}" \
  "postgres_image=${IMAGE_LOCK_POSTGRES_IMAGE}" \
  > "$work_dir/metadata.txt"

tar --sort=name --owner=0 --group=0 --numeric-owner \
  --directory "$work_dir" \
  --create --file - \
  metadata.txt emdo_app.dump.age emdo_powersync.dump.age \
  | age --encrypt --recipients-file "$recipients_file" \
      --output "$pending_file"

read -r backup_digest _ < <(sha256sum "$pending_file")
[[ "$backup_digest" =~ ^[0-9a-f]{64}$ ]] ||
  die 'could not calculate the encrypted backup digest'
printf '%s  %s\n' "$backup_digest" "${basename}.age" > "$checksum_pending"
printf '%s\n' \
  'schema=emdo-logical-backup-v1' \
  "bundle=${basename}.age" \
  "sha256=$backup_digest" \
  > "$complete_pending"
chmod 0600 "$pending_file" "$checksum_pending" "$complete_pending"
mv -- "$pending_file" "$final_file"
mv -- "$checksum_pending" "$checksum_file"
# This final same-filesystem rename is the publication boundary. Restore drills
# ignore any interrupted bundle that has no matching completion marker.
mv -- "$complete_pending" "$complete_file"

log "encrypted logical backup created: $final_file (sha256:$backup_digest)"

#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# shellcheck source=infra/scripts/_common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"

readonly finance_document_store_uid=10001
readonly finance_document_store_gid=10001

assert_finance_document_store_directory() {
  local path="$1"
  local owner_uid owner_gid mode

  require_directory "$path"
  read -r owner_uid owner_gid mode < <(stat -c '%u %g %a' "$path")
  [[ "$owner_uid" == "$finance_document_store_uid" &&
    "$owner_gid" == "$finance_document_store_gid" ]] ||
    die "finance document store must be owned by ${finance_document_store_uid}:${finance_document_store_gid}"
  [[ "$mode" == 700 ]] ||
    die 'FINANCE_DOCUMENT_STORE_DIR must have mode 0700'
}

assert_finance_document_object_file() {
  local path="$1"
  local maximum_size="$2"
  local owner_uid owner_gid mode links size

  require_regular_file "$path"
  read -r owner_uid owner_gid mode links size < <(
    stat -c '%u %g %a %h %s' "$path"
  )
  [[ "$owner_uid" == "$finance_document_store_uid" &&
    "$owner_gid" == "$finance_document_store_gid" ]] ||
    die "finance document object must be owned by ${finance_document_store_uid}:${finance_document_store_gid}"
  [[ "$mode" == 600 ]] ||
    die 'finance document object must have mode 0600'
  [[ "$links" == 1 ]] ||
    die 'finance document object must have exactly one hard link'
  [[ "$size" =~ ^[1-9][0-9]*$ ]] && (( size <= maximum_size )) ||
    die 'finance document object has an invalid ciphertext size'
}

backup_capacity_lock_fd=''
backup_operation_lock_fd=''
acquire_host_lock /var/lib/emdo/locks/capacity.lock backup_capacity_lock_fd
acquire_host_lock /var/lib/emdo/locks/production-mutation.lock backup_operation_lock_fd
: "$backup_capacity_lock_fd" "$backup_operation_lock_fd"
require_command docker
require_command age
require_command sha256sum
require_command tar
require_command find
require_command sort
require_command stat
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
# assert_production_healthy isolates the same names in a subshell.
# shellcheck disable=SC2031
export COMPOSE_PROJECT_NAME=emdo-production \
  DEPLOYMENT_NAMESPACE=production \
  EMDO_ENVIRONMENT=production

backup_dir="${DEPLOY_CONFIG_BACKUP_DIR:-/var/backups/emdo/logical}"
recipients_file="${DEPLOY_CONFIG_BACKUP_AGE_RECIPIENTS_FILE:-/etc/emdo/backup/age-recipients.txt}"
finance_document_store_dir="${FINANCE_DOCUMENT_STORE_DIR:-}"
assert_absolute_scoped_directory "$backup_dir" BACKUP_DIR
require_directory "$backup_dir"
assert_governed_parent_chain "$backup_dir" /var/backups/emdo
assert_governed_parent_chain "$(dirname -- "$recipients_file")" /etc/emdo/backup
assert_directory_within "$(dirname -- "$recipients_file")" /etc/emdo/backup BACKUP_AGE_RECIPIENTS_DIRECTORY
assert_root_owned_bounded_file "$recipients_file" 600 65536

# Existing non-Finance deployments remain backup-compatible. Finance objects
# are included only when the operator explicitly supplies the governed store.
# The store contains ciphertext only; key material is never consulted here.
finance_backup_enabled=false
if [[ -n "$finance_document_store_dir" ]]; then
  finance_backup_enabled=true
  assert_absolute_scoped_directory "$finance_document_store_dir" FINANCE_DOCUMENT_STORE_DIR
  [[ "$finance_document_store_dir" == /var/lib/emdo/finance-documents ]] ||
    die 'FINANCE_DOCUMENT_STORE_DIR must be the governed /var/lib/emdo/finance-documents store'
  require_directory "$finance_document_store_dir"
  assert_directory_within "$finance_document_store_dir" /var/lib/emdo FINANCE_DOCUMENT_STORE_DIR
  finance_document_store_parent="$(dirname -- "$finance_document_store_dir")"
  assert_governed_parent_chain "$finance_document_store_parent" /var/lib/emdo
  assert_finance_document_store_directory "$finance_document_store_dir"
fi

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

finance_backup_object_count=0
finance_backup_ciphertext_bytes=0
if [[ "$finance_backup_enabled" == true ]]; then
readonly finance_manifest_schema='emdo-finance-document-backup-v1'
readonly finance_object_name_pattern='^fd1_[A-Za-z0-9_-]{43}$'
readonly finance_max_objects=10000
readonly finance_max_ciphertext_bytes=$((25 * 1024 * 1024))
readonly finance_max_total_ciphertext_bytes=$((50 * 1024 * 1024 * 1024))
finance_source_paths="$work_dir/finance-source-paths.nul"
finance_object_names_unsorted="$work_dir/finance-object-names.unsorted"
finance_object_names="$work_dir/finance-object-names"
finance_manifest_records="$work_dir/finance-documents.manifest.records"
finance_manifest="$work_dir/finance-documents.manifest"
finance_archive="$work_dir/finance-documents.tar"
: > "$finance_object_names_unsorted"
: > "$finance_manifest_records"

# Files are minted by FinanceDocumentStorage with opaque names and atomically
# published ciphertext. Refuse every other filesystem type rather than trying
# to skip it: a partial object backup is not a recoverable finance backup.
find -P "$finance_document_store_dir" -xdev -mindepth 1 -maxdepth 1 -print0 \
  > "$finance_source_paths"

finance_object_count=0
finance_total_ciphertext_bytes=0
while IFS= read -r -d '' finance_object_path; do
  [[ "$(dirname -- "$finance_object_path")" == "$finance_document_store_dir" ]] ||
    die 'finance document store contains a nested or escaped entry'
  finance_object_name="$(basename -- "$finance_object_path")"
  [[ "$finance_object_name" =~ $finance_object_name_pattern ]] ||
    die 'finance document store contains a non-opaque object name'
  assert_finance_document_object_file \
    "$finance_object_path" "$finance_max_ciphertext_bytes"
  read -r finance_object_bytes _ < <(stat -c '%s' "$finance_object_path")
  [[ "$finance_object_bytes" =~ ^[1-9][0-9]*$ ]] ||
    die 'finance document object has an invalid ciphertext size'
  finance_object_count=$((finance_object_count + 1))
  (( finance_object_count <= finance_max_objects )) ||
    die 'finance document store exceeds the governed object-count limit'
  finance_total_ciphertext_bytes=$((finance_total_ciphertext_bytes + finance_object_bytes))
  (( finance_total_ciphertext_bytes <= finance_max_total_ciphertext_bytes )) ||
    die 'finance document store exceeds the governed ciphertext-byte limit'
  read -r finance_object_digest _ < <(sha256sum "$finance_object_path")
  [[ "$finance_object_digest" =~ ^[0-9a-f]{64}$ ]] ||
    die 'could not calculate a finance ciphertext digest'
  printf '%s\n' "$finance_object_name" >> "$finance_object_names_unsorted"
  printf '%s\t%s\t%s\n' \
    "$finance_object_name" "$finance_object_bytes" "$finance_object_digest" \
    >> "$finance_manifest_records"
done < "$finance_source_paths"

LC_ALL=C sort "$finance_object_names_unsorted" > "$finance_object_names"
{
  printf 'schema=%s\n' "$finance_manifest_schema"
  LC_ALL=C sort "$finance_manifest_records"
} > "$finance_manifest"
chmod 0600 "$finance_object_names" "$finance_manifest" "$finance_manifest_records"

# The inner archive contains only already-encrypted originals and an exact,
# sorted object order. It has no keys, user identifiers, MIME types, or names.
tar --sort=name --owner=0 --group=0 --numeric-owner --mode=0600 --mtime=@0 \
  --directory "$finance_document_store_dir" \
  --create --file "$finance_archive" \
  --no-recursion --verbatim-files-from --files-from "$finance_object_names"
chmod 0600 "$finance_archive"

finance_backup_summary="$(
  bash "$SCRIPT_DIR/finance-document-backup-verify.sh" \
    verify-archive "$finance_manifest" "$finance_archive"
)"
[[ "$finance_backup_summary" =~ ^objects=([0-9]+)\ bytes=([0-9]+)$ ]] ||
  die 'finance document archive verification returned an invalid summary'
finance_backup_object_count="${BASH_REMATCH[1]}"
finance_backup_ciphertext_bytes="${BASH_REMATCH[2]}"
fi

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

bundle_entries=(metadata.txt emdo_app.dump.age emdo_powersync.dump.age)
if [[ "$finance_backup_enabled" == true ]]; then
  bundle_entries+=(finance-documents.manifest finance-documents.tar)
fi
tar --sort=name --owner=0 --group=0 --numeric-owner \
  --directory "$work_dir" \
  --create --file - \
  "${bundle_entries[@]}" \
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

if [[ "$finance_backup_enabled" == true ]]; then
  log "encrypted logical backup created: $final_file (sha256:$backup_digest finance_objects=$finance_backup_object_count finance_ciphertext_bytes=$finance_backup_ciphertext_bytes)"
else
  log "encrypted logical backup created: $final_file (sha256:$backup_digest)"
fi

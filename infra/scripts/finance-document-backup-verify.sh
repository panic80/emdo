#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

# shellcheck source=infra/scripts/_common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"

readonly FINANCE_MANIFEST_SCHEMA='emdo-finance-document-backup-v1'
readonly FINANCE_OBJECT_NAME_PATTERN='^fd1_[A-Za-z0-9_-]{43}$'
readonly FINANCE_MAX_OBJECTS=10000
readonly FINANCE_MAX_CIPHERTEXT_BYTES=$((25 * 1024 * 1024))
readonly FINANCE_MAX_TOTAL_CIPHERTEXT_BYTES=$((50 * 1024 * 1024 * 1024))
# One 512-byte header and one 512-byte end contribution per object, plus the
# terminal blocks. This constrains the opaque inner tar before any extraction.
readonly FINANCE_MAX_ARCHIVE_BYTES=$((FINANCE_MAX_TOTAL_CIPHERTEXT_BYTES + FINANCE_MAX_OBJECTS * 1024 + 10240))
readonly FINANCE_MAX_MANIFEST_BYTES=$((2 * 1024 * 1024))

manifest_object_count=0
manifest_total_ciphertext_bytes=0
declare -A manifest_object_sizes=()
declare -A manifest_object_digests=()
declare -a manifest_object_names=()

usage() {
  die 'usage: finance-document-backup-verify.sh verify-archive <manifest> <archive> | restore-archive <manifest> <archive> <absent-run-scoped-destination> | verify-readback <expected-sha256> <caller-supplied-readback-file>'
}

file_size_bytes() {
  stat -c '%s' "$1"
}

calculate_sha256() {
  local path="$1"
  local digest extra
  read -r digest extra < <(sha256sum "$path")
  [[ "$digest" =~ ^[0-9a-f]{64}$ && -n "${extra:-}" ]] ||
    die 'could not calculate a SHA-256 digest'
  printf '%s' "$digest"
}

validate_manifest() {
  local manifest="$1" manifest_fd
  local line object_name object_bytes object_digest extra previous_name=''

  assert_root_owned_bounded_file "$manifest" 600 "$FINANCE_MAX_MANIFEST_BYTES"
  exec {manifest_fd}< "$manifest"
  IFS= read -r line <&"$manifest_fd" || die 'finance document manifest is empty'
  [[ "$line" == "schema=$FINANCE_MANIFEST_SCHEMA" ]] ||
    die 'finance document manifest schema is unsupported'

  manifest_object_count=0
  manifest_total_ciphertext_bytes=0
  manifest_object_sizes=()
  manifest_object_digests=()
  manifest_object_names=()

  while IFS= read -r line <&"$manifest_fd" || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || die 'finance document manifest contains an empty entry'
    IFS=$'\t' read -r object_name object_bytes object_digest extra <<< "$line"
    [[ -z "${extra:-}" && "$line" == "$object_name"$'\t'"$object_bytes"$'\t'"$object_digest" ]] ||
      die 'finance document manifest entry is malformed'
    [[ "$object_name" =~ $FINANCE_OBJECT_NAME_PATTERN ]] ||
      die 'finance document manifest contains a non-opaque object name'
    [[ "$object_bytes" =~ ^[1-9][0-9]*$ ]] &&
      (( 10#$object_bytes <= FINANCE_MAX_CIPHERTEXT_BYTES )) ||
      die 'finance document manifest ciphertext size is invalid'
    [[ "$object_digest" =~ ^[0-9a-f]{64}$ ]] ||
      die 'finance document manifest ciphertext digest is invalid'
    [[ -z "$previous_name" || "$previous_name" < "$object_name" ]] ||
      die 'finance document manifest entries must be unique and sorted'
    previous_name="$object_name"
    manifest_object_count=$((manifest_object_count + 1))
    (( manifest_object_count <= FINANCE_MAX_OBJECTS )) ||
      die 'finance document manifest exceeds the object-count limit'
    manifest_total_ciphertext_bytes=$((manifest_total_ciphertext_bytes + 10#$object_bytes))
    (( manifest_total_ciphertext_bytes <= FINANCE_MAX_TOTAL_CIPHERTEXT_BYTES )) ||
      die 'finance document manifest exceeds the ciphertext-byte limit'
    manifest_object_sizes["$object_name"]="$object_bytes"
    manifest_object_digests["$object_name"]="$object_digest"
    manifest_object_names+=("$object_name")
  done
  exec {manifest_fd}<&-
}

validate_archive_structure() {
  local archive="$1"
  local listing_file listing_parent line mode owner object_bytes field_count object_name
  local -a fields
  local archive_object_count=0
  declare -A archive_object_sizes=()

  assert_root_owned_bounded_file "$archive" 600 "$FINANCE_MAX_ARCHIVE_BYTES"
  listing_parent="$(dirname -- "$archive")"
  assert_root_owned_nonwritable_directory "$listing_parent"
  listing_file="$(mktemp "$listing_parent/.finance-document-archive-list.XXXXXX")"

  tar --list --verbose --numeric-owner --full-time --file "$archive" > "$listing_file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || die 'finance document archive contains an empty listing entry'
    read -r -a fields <<< "$line"
    field_count="${#fields[@]}"
    (( field_count >= 6 )) || die 'finance document archive listing is malformed'
    mode="${fields[0]}"
    owner="${fields[1]}"
    object_bytes="${fields[2]}"
    object_name="${fields[field_count - 1]}"
    # The inner tar is intentionally limited to ordinary root-owned 0600
    # opaque files. This rejects directories, symlinks, hard links, devices,
    # sockets, traversal names, and archive-controlled permissions.
    [[ "$mode" == '-rw-------' && "$owner" == 0/0 ]] ||
      die 'finance document archive contains a link, non-regular file, or unsafe mode'
    [[ "$object_name" =~ $FINANCE_OBJECT_NAME_PATTERN ]] ||
      die 'finance document archive contains an unsafe object path'
    [[ "$object_bytes" =~ ^[1-9][0-9]*$ ]] ||
      die 'finance document archive object size is invalid'
    [[ -z "${archive_object_sizes[$object_name]+present}" ]] ||
      die 'finance document archive contains duplicate object entries'
    [[ -n "${manifest_object_sizes[$object_name]+present}" ]] ||
      die 'finance document archive contains an object absent from its manifest'
    [[ "$object_bytes" == "${manifest_object_sizes[$object_name]}" ]] ||
      die 'finance document archive object size does not match its manifest'
    archive_object_sizes["$object_name"]="$object_bytes"
    archive_object_count=$((archive_object_count + 1))
    (( archive_object_count <= FINANCE_MAX_OBJECTS )) ||
      die 'finance document archive exceeds the object-count limit'
  done < "$listing_file"

  [[ "$archive_object_count" == "$manifest_object_count" ]] ||
    die 'finance document archive object count does not match its manifest'
  for object_name in "${manifest_object_names[@]}"; do
    [[ -n "${archive_object_sizes[$object_name]+present}" ]] ||
      die 'finance document archive is missing an object named by its manifest'
  done
  rm -f -- "$listing_file"
}

verify_archive() {
  local manifest="$1"
  local archive="$2"
  local object_name actual_digest

  require_command tar
  require_command sha256sum
  require_command stat
  require_command mktemp
  validate_manifest "$manifest"
  validate_archive_structure "$archive"

  for object_name in "${manifest_object_names[@]}"; do
    actual_digest="$(tar --extract --to-stdout --file "$archive" -- "$object_name" | sha256sum)"
    actual_digest="${actual_digest%%[[:space:]]*}"
    [[ "$actual_digest" == "${manifest_object_digests[$object_name]}" ]] ||
      die 'finance document archive ciphertext hash does not match its manifest'
  done
  printf 'objects=%s bytes=%s\n' \
    "$manifest_object_count" "$manifest_total_ciphertext_bytes"
}

extract_archive_member_limited() {
  local archive="$1"
  local object_name="$2"
  local destination="$3"
  local expected_bytes="$4"
  local tar_status head_status actual_bytes
  local -a pipeline_status

  [[ ! -e "$destination" && ! -L "$destination" ]] ||
    die 'finance document restore destination object already exists'
  set +e
  tar --extract --to-stdout --file "$archive" -- "$object_name" |
    head --bytes="$((10#$expected_bytes + 1))" > "$destination"
  pipeline_status=("${PIPESTATUS[@]}")
  set -e
  tar_status="${pipeline_status[0]}"
  head_status="${pipeline_status[1]}"
  actual_bytes="$(file_size_bytes "$destination")"
  (( actual_bytes <= 10#$expected_bytes )) ||
    die 'finance document archive object exceeds its manifest byte limit'
  [[ "$tar_status" == 0 && "$head_status" == 0 && "$actual_bytes" == "$expected_bytes" ]] ||
    die 'could not safely extract a finance document archive object'
}

restore_archive() {
  local manifest="$1"
  local archive="$2"
  local destination="$3"
  local object_name destination_object actual_digest

  [[ "$destination" == /* && "$destination" != / ]] ||
    die 'finance document restore destination must be an absolute scoped directory'
  [[ ! -e "$destination" && ! -L "$destination" ]] ||
    die 'finance document restore destination must be absent and run-scoped'
  require_command head
  require_command install
  require_directory "$(dirname -- "$destination")"
  verify_archive "$manifest" "$archive" >/dev/null
  install -d -m 0700 "$destination"
  for object_name in "${manifest_object_names[@]}"; do
    destination_object="$destination/$object_name"
    extract_archive_member_limited \
      "$archive" "$object_name" "$destination_object" \
      "${manifest_object_sizes[$object_name]}"
    chmod 0600 "$destination_object"
    assert_root_owned_bounded_file \
      "$destination_object" 600 "$FINANCE_MAX_CIPHERTEXT_BYTES"
    actual_digest="$(calculate_sha256 "$destination_object")"
    [[ "$actual_digest" == "${manifest_object_digests[$object_name]}" ]] ||
      die 'restored finance document ciphertext hash does not match its manifest'
  done
  printf 'objects=%s bytes=%s\n' \
    "$manifest_object_count" "$manifest_total_ciphertext_bytes"
}

verify_readback() {
  local expected_digest="$1"
  local readback_file="$2"
  local readback_bytes actual_digest

  [[ "$expected_digest" =~ ^[0-9a-f]{64}$ ]] ||
    die 'expected finance document readback digest is invalid'
  require_regular_file "$readback_file"
  readback_bytes="$(file_size_bytes "$readback_file")"
  [[ "$readback_bytes" =~ ^[1-9][0-9]*$ ]] &&
    (( readback_bytes <= FINANCE_MAX_CIPHERTEXT_BYTES )) ||
    die 'caller-supplied finance document readback exceeds the byte limit'
  actual_digest="$(calculate_sha256 "$readback_file")"
  [[ "$actual_digest" == "$expected_digest" ]] ||
    die 'caller-supplied finance document readback hash does not match'
  log 'finance document readback SHA-256 verified'
}

case "${1:-}" in
  verify-archive)
    [[ "$#" == 3 ]] || usage
    verify_archive "$2" "$3"
    ;;
  restore-archive)
    [[ "$#" == 4 ]] || usage
    restore_archive "$2" "$3" "$4"
    ;;
  verify-readback)
    [[ "$#" == 3 ]] || usage
    verify_readback "$2" "$3"
    ;;
  *)
    usage
    ;;
esac

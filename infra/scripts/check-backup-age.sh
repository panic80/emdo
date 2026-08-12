#!/usr/bin/env bash
set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"

require_command date
require_command find
require_command sha256sum
load_deployment_config "$PRODUCTION_CONFIG_FILE"
backup_dir="${DEPLOY_CONFIG_BACKUP_DIR:-/var/backups/emdo/logical}"
assert_absolute_scoped_directory "$backup_dir" BACKUP_DIR
assert_governed_parent_chain "$backup_dir" /var/backups/emdo

latest_name=''
latest_digest=''
while IFS= read -r marker; do
  [[ -n "$marker" ]] || continue
  assert_root_owned_bounded_file "$marker" 600 4096
  bundle="${marker%.complete}"
  checksum="$bundle.sha256"
  assert_root_owned_bounded_file "$bundle" 600 107374182400
  assert_root_owned_bounded_file "$checksum" 600 4096
  bundle_name="$(basename -- "$bundle")"
  [[ "$bundle_name" =~ ^emdo-logical-[0-9]{8}T[0-9]{6}Z\.age$ ]] ||
    die 'completed backup has an invalid filename'
  read -r digest recorded_name extra < "$checksum"
  [[ "$digest" =~ ^[0-9a-f]{64}$ && "$recorded_name" == "$bundle_name" && -z "${extra:-}" ]] ||
    die 'completed backup has an invalid checksum record'
  expected="$(printf '%s\n' 'schema=emdo-logical-backup-v1' "bundle=$bundle_name" "sha256=$digest")"
  [[ "$(< "$marker")" == "$expected" ]] ||
    die 'completed backup marker does not match its bundle'
  if [[ -z "$latest_name" || "$bundle_name" > "$latest_name" ]]; then
    latest_name="$bundle_name"
    latest_digest="$digest"
  fi
done < <(
  find "$backup_dir" -mindepth 1 -maxdepth 1 -type f \
    -name 'emdo-logical-????????T??????Z.age.complete' -print
)

[[ -n "$latest_name" ]] || die 'no completed logical backup is available'
(
  cd -- "$backup_dir"
  printf '%s  %s\n' "$latest_digest" "$latest_name" |
    sha256sum --check --strict -
)
timestamp="${latest_name#emdo-logical-}"
timestamp="${timestamp%.age}"
backup_epoch="$(date --date "${timestamp:0:8} ${timestamp:9:2}:${timestamp:11:2}:${timestamp:13:2} UTC" +%s)" ||
  die 'latest completed backup timestamp is invalid'
now_epoch="$(date +%s)"
age_seconds=$((now_epoch - backup_epoch))
((age_seconds >= 0 && age_seconds <= 93600)) ||
  die 'newest completed logical backup is older than 26 hours or from the future'

log "logical backup freshness passed: $latest_name age=${age_seconds}s"

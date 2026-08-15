#!/usr/bin/env bash
set -Eeuo pipefail

operation="${1:-}"
case "$operation" in
  backup) relative_entrypoint='infra/scripts/backup-logical.sh' ;;
  check-backup-age) relative_entrypoint='infra/scripts/check-backup-age.sh' ;;
  check-replication-pressure) relative_entrypoint='infra/scripts/check-replication-pressure.sh' ;;
  purge-finance-imports) relative_entrypoint='infra/scripts/purge-finance-imports.sh' ;;
  reconcile-google-oauth-disconnects) relative_entrypoint='infra/scripts/reconcile-google-oauth-disconnects.sh' ;;
  *)
    printf '[emdo-dispatch] invalid operation\n' >&2
    exit 64
    ;;
esac

state_root=/var/lib/emdo/deployments
state_file="$state_root/current.env"

validate_directory() {
  local path="$1"
  local owner mode numeric_mode
  [[ -d "$path" && ! -L "$path" ]] || return 1
  owner="$(stat -c '%u' "$path")"
  mode="$(stat -c '%a' "$path")"
  [[ "$owner" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  numeric_mode=$((8#$mode))
  (( (numeric_mode & 8#022) == 0 ))
}

validate_file() {
  local path="$1"
  local owner mode links numeric_mode
  [[ -f "$path" && ! -L "$path" ]] || return 1
  owner="$(stat -c '%u' "$path")"
  mode="$(stat -c '%a' "$path")"
  links="$(stat -c '%h' "$path")"
  [[ "$owner" == 0 && "$links" == 1 && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  numeric_mode=$((8#$mode))
  (( (numeric_mode & 8#022) == 0 ))
}

validate_directory /var/lib/emdo || exit 1
validate_directory "$state_root" || exit 1
validate_file "$state_file" || exit 1
[[ "$(stat -c '%a' "$state_file")" == 600 ]] || exit 1
[[ "$(grep -c '^DEPLOYED_RELEASE_DIR=' "$state_file")" == 1 ]] || exit 1
release_root="$(sed -n 's/^DEPLOYED_RELEASE_DIR=//p' "$state_file")"
[[ "$release_root" =~ ^/opt/emdo/releases/[0-9a-f]{40}-[1-9][0-9]{0,19}$ ]] || exit 1
validate_directory /opt/emdo || exit 1
validate_directory /opt/emdo/releases || exit 1
validate_directory "$release_root" || exit 1

entrypoint="$release_root/$relative_entrypoint"
validate_file "$entrypoint" || exit 1
[[ -x "$entrypoint" ]] || exit 1
exec "$entrypoint"

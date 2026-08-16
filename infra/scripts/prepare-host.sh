#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${EMDO_HOST_PREPARATION_APPROVED:-}" == true ]] || {
  printf '[emdo-host-prepare] explicit approval is required\n' >&2
  exit 1
}
((EUID == 0)) || {
  printf '[emdo-host-prepare] must run as root\n' >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
infra_dir="$(cd -- "$script_dir/.." && pwd -P)"
release_asset_public_key="${EMDO_RELEASE_ASSET_PUBLIC_KEY_FILE:-}"
staging_ssh_user="${EMDO_STAGING_SSH_USER:-}"

for command_name in getent openssl visudo; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf '[emdo-host-prepare] required command is unavailable: %s\n' "$command_name" >&2
    exit 1
  }
done

[[ -f "$release_asset_public_key" && ! -L "$release_asset_public_key" ]] || {
  printf '[emdo-host-prepare] EMDO_RELEASE_ASSET_PUBLIC_KEY_FILE must name the reviewed Ed25519 public key\n' >&2
  exit 1
}
[[ "$(stat -c '%u:%h' "$release_asset_public_key")" == 0:1 ]] || {
  printf '[emdo-host-prepare] release asset public key must be root-owned with one link\n' >&2
  exit 1
}
public_key_mode="$(stat -c '%a' "$release_asset_public_key")"
[[ "$public_key_mode" == 600 || "$public_key_mode" == 644 ]] || {
  printf '[emdo-host-prepare] release asset public key must have mode 0600 or 0644\n' >&2
  exit 1
}
[[ "$staging_ssh_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || {
  printf '[emdo-host-prepare] EMDO_STAGING_SSH_USER is invalid\n' >&2
  exit 1
}
getent passwd "$staging_ssh_user" >/dev/null || {
  printf '[emdo-host-prepare] staging SSH user does not exist\n' >&2
  exit 1
}
openssl pkey -pubin -in "$release_asset_public_key" -noout >/dev/null 2>&1 || {
  printf '[emdo-host-prepare] release asset public key is invalid\n' >&2
  exit 1
}

ensure_directory() {
  local path="$1"
  local mode="$2"
  local owner existing_mode
  if [[ -L "$path" || (-e "$path" && ! -d "$path") ]]; then
    printf '[emdo-host-prepare] unsafe existing path: %s\n' "$path" >&2
    exit 1
  fi
  if [[ -d "$path" ]]; then
    owner="$(stat -c '%u' "$path")"
    existing_mode="$(stat -c '%a' "$path")"
    [[ "$owner" == 0 && "$existing_mode" == "${mode#0}" ]] || {
      printf '[emdo-host-prepare] existing directory does not have the required root ownership and mode: %s\n' "$path" >&2
      exit 1
    }
  else
    install -d -o 0 -g 0 -m "$mode" "$path"
  fi
}

ensure_directory /opt/emdo 0755
ensure_directory /opt/emdo/releases 0755
ensure_directory /var/lib/emdo 0700
ensure_directory /var/lib/emdo/deployments 0700
ensure_directory /var/lib/emdo/staging 0700
ensure_directory /var/lib/emdo/staging-releases 0700
ensure_directory /var/lib/emdo/release-incoming 0700
ensure_directory /var/lib/emdo/restore-drills 0700
ensure_directory /var/lib/emdo/locks 0700
ensure_directory /var/backups/emdo 0700
ensure_directory /var/backups/emdo/logical 0700
ensure_directory /etc/emdo 0700
ensure_directory /etc/emdo/production 0700
ensure_directory /etc/emdo/staging 0700
ensure_directory /etc/emdo/backup 0700
ensure_directory /etc/emdo/restore 0700
ensure_directory /etc/emdo/release 0700

install -o 0 -g 0 -m 0644 \
  "$release_asset_public_key" \
  /etc/emdo/release/release-assets-public.pem
install -o 0 -g 0 -m 0755 \
  "$script_dir/staging-operator.sh" \
  /usr/local/sbin/emdo-staging-operator
install -o 0 -g 0 -m 0755 \
  "$script_dir/cleanup-expired-staging.sh" \
  /usr/local/sbin/emdo-cleanup-expired-staging

for lock_name in capacity production-mutation; do
  lock_path="/var/lib/emdo/locks/$lock_name.lock"
  if [[ -e "$lock_path" ]]; then
    [[ -f "$lock_path" && ! -L "$lock_path" && "$(stat -c '%u:%a:%h' "$lock_path")" == 0:600:1 ]] || {
      printf '[emdo-host-prepare] unsafe existing host lock: %s\n' "$lock_path" >&2
      exit 1
    }
  else
    printf 'emdo-host-lock-v1\n' | install -o 0 -g 0 -m 0600 /dev/stdin "$lock_path"
  fi
done

sudoers_pending="$(mktemp /etc/sudoers.d/.emdo-staging-operator.XXXXXX)"
cleanup_sudoers() {
  rm -f -- "$sudoers_pending"
}
trap cleanup_sudoers EXIT
printf '%s\n' \
  "Defaults!/usr/local/sbin/emdo-staging-operator env_reset, !set_home" \
  "$staging_ssh_user ALL=(root) NOPASSWD: /usr/local/sbin/emdo-staging-operator *" \
  > "$sudoers_pending"
chmod 0440 "$sudoers_pending"
visudo -cf "$sudoers_pending" >/dev/null
install -o 0 -g 0 -m 0440 \
  "$sudoers_pending" /etc/sudoers.d/emdo-staging-operator
rm -f -- "$sudoers_pending"
trap - EXIT

install -o 0 -g 0 -m 0755 \
  "$script_dir/dispatch-active-release.sh" \
  /usr/local/sbin/emdo-dispatch-active-release
for unit in \
  emdo-logical-backup.service \
  emdo-logical-backup.timer \
  emdo-backup-age.service \
  emdo-backup-age.timer \
  emdo-replication-pressure.service \
  emdo-replication-pressure.timer \
  emdo-finance-import-retention.service \
  emdo-finance-import-retention.timer \
  emdo-google-oauth-disconnect-reconciliation.service \
  emdo-google-oauth-disconnect-reconciliation.timer \
  emdo-google-oauth-disconnect-retention.service \
  emdo-google-oauth-disconnect-retention.timer \
  emdo-staging-sweeper.service \
  emdo-staging-sweeper.timer; do
  install -o 0 -g 0 -m 0644 \
    "$infra_dir/systemd/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now emdo-staging-sweeper.timer

printf '[emdo-host-prepare] governed host paths installed; staging expiry is active and production monitoring, backup, finance-retention, Google disconnect reconciliation, and Google disconnect receipt-retention timers remain disabled until production is healthy\n' >&2

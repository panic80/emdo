#!/usr/bin/env bash
set -Eeuo pipefail

# 1.75 GiB and 10 GiB expressed in the KiB units emitted by /proc and df -Pk.
readonly MIN_AVAILABLE_MEMORY_KIB=1835008
readonly MIN_FREE_DISK_KIB=10485760

# shellcheck source=infra/scripts/_common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"

require_command docker
require_command awk
require_command df
[[ -r /proc/meminfo ]] || die '/proc/meminfo is unavailable; staging is Linux-host only'

docker info >/dev/null 2>&1 || die 'Docker daemon is unavailable'
case "${INITIAL_STAGING_BOOTSTRAP:-false}" in
  true)
    assert_initial_production_absent
    production_gate='production absence proved for one-time bootstrap'
    ;;
  false)
    assert_production_healthy
    production_gate='production healthy'
    ;;
  *)
    die 'INITIAL_STAGING_BOOTSTRAP must be true or false'
    ;;
esac

available_memory_kib="$(awk '/^MemAvailable:/ { print $2; exit }' /proc/meminfo)"
[[ "$available_memory_kib" =~ ^[0-9]+$ ]] || die 'could not read available memory'
((available_memory_kib >= MIN_AVAILABLE_MEMORY_KIB)) ||
  die "staging requires at least 1.75 GiB available memory"

disk_probe_path="/var/lib/emdo"
if [[ ! -d "$disk_probe_path" ]]; then
  disk_probe_path='/var/lib'
fi
require_directory "$disk_probe_path"
free_disk_kib="$(df -Pk "$disk_probe_path" | awk 'NR == 2 { print $4 }')"
[[ "$free_disk_kib" =~ ^[0-9]+$ ]] || die 'could not read free disk space'
((free_disk_kib >= MIN_FREE_DISK_KIB)) ||
  die "staging requires at least 10 GiB free disk"

log "preflight passed: $production_gate, ${available_memory_kib} KiB memory and ${free_disk_kib} KiB disk available"

#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

((EUID == 0)) || {
  printf '[emdo-staging-sweeper] must run as root\n' >&2
  exit 1
}

state_root=/var/lib/emdo/staging
now_epoch="$(date +%s)"

[[ -d "$state_root" && ! -L "$state_root" && "$(stat -c '%u:%a' "$state_root")" == 0:700 ]] || {
  printf '[emdo-staging-sweeper] staging state root is not governed\n' >&2
  exit 1
}
[[ -x /usr/local/sbin/emdo-staging-operator && ! -L /usr/local/sbin/emdo-staging-operator ]] || {
  printf '[emdo-staging-sweeper] fixed staging operator is unavailable\n' >&2
  exit 1
}

cleanup_failed=false

while IFS= read -r -d '' state_dir; do
  run_id="$(basename -- "$state_dir")"
  [[ "$run_id" =~ ^[0-9]{1,20}$ ]] || {
    printf '[emdo-staging-sweeper] unsafe state entry requires operator review: %s\n' "$state_dir" >&2
    continue
  }
  deadline_file="$state_dir/expires-at-epoch"
  if [[ -f "$deadline_file" && ! -L "$deadline_file" && "$(stat -c '%u:%a:%h' "$deadline_file")" == 0:600:1 ]]; then
    deadline_epoch="$(< "$deadline_file")"
  else
    # A process killed between state-directory creation and deadline publication
    # is still bounded. Give it one hour from the root-owned directory mtime,
    # then require the same fixed signed-release teardown path.
    deadline_epoch=$(($(stat -c '%Y' "$state_dir") + 3600))
  fi
  [[ "$deadline_epoch" =~ ^[0-9]{10}$ ]] || {
    printf '[emdo-staging-sweeper] invalid deadline for run %s\n' "$run_id" >&2
    continue
  }
  if ((now_epoch >= deadline_epoch)); then
    if ! /usr/local/sbin/emdo-staging-operator teardown "$run_id"; then
      printf '[emdo-staging-sweeper] operator teardown failed for expired run %s; protected state was retained for a verified retry\n' "$run_id" >&2
      cleanup_failed=true
    fi
  fi
done < <(find "$state_root" -mindepth 1 -maxdepth 1 -type d -print0)

[[ "$cleanup_failed" == false ]] || exit 1

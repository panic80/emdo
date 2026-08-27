#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

log() {
  printf '[emdo-staging-operator] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

((EUID == 0)) || die 'this fixed operator must run as root'

readonly release_root=/opt/emdo/releases
readonly record_root=/var/lib/emdo/staging-releases
readonly incoming_root=/var/lib/emdo/release-incoming
readonly public_key=/etc/emdo/release/release-assets-public.pem

INSTALL_CLEANUP_INCOMING=''
INSTALL_CLEANUP_INSTALLING=''

assert_safe_run_id() {
  [[ "$1" =~ ^[0-9]{1,20}$ ]] || die 'workflow run ID is invalid'
}

assert_root_file() {
  local path="$1"
  local expected_mode="$2"
  local maximum_size="$3"
  local size
  [[ -f "$path" && ! -L "$path" ]] || die "required file is missing: $path"
  [[ "$(stat -c '%u:%a:%h' "$path")" == "0:$expected_mode:1" ]] ||
    die "file ownership, mode, or link count is unsafe: $path"
  size="$(stat -c '%s' "$path")"
  [[ "$size" =~ ^[1-9][0-9]*$ && "$size" -le "$maximum_size" ]] ||
    die "file size is unsafe: $path"
}

assert_incoming_file() {
  local path="$1"
  local maximum_size="$2"
  local size
  [[ "$path" == /tmp/* && -f "$path" && ! -L "$path" ]] ||
    die 'incoming release assets must be non-symlink regular files beneath /tmp'
  size="$(stat -c '%s' "$path")"
  [[ "$size" =~ ^[1-9][0-9]*$ && "$size" -le "$maximum_size" ]] ||
    die 'incoming release asset size is invalid'
}

assert_release_tree() {
  local release="$1"
  local source_sha="$2"
  local run_id="$3"
  [[ "$release" == "$release_root/$source_sha-$run_id" ]] ||
    die 'release record has an invalid root binding'
  [[ -d "$release" && ! -L "$release" ]] || die 'release directory is unavailable'
  [[ -z "$(find "$release" -xdev \( -type l -o ! -user root -o -perm /022 \) -print -quit)" ]] ||
    die 'release tree is not root-owned and immutable'
  assert_root_file "$release/.archive-sha256" 644 128
  assert_root_file "$release/images.env" 600 32768
}

write_record() {
  local path="$1"
  local release="$2"
  local source_sha="$3"
  local archive_sha="$4"
  local status="$5"
  local pending
  pending="$(mktemp "$record_root/.record.XXXXXX")"
  printf '%s\n' \
    'SCHEMA=emdo-staging-release-v1' \
    "RELEASE_DIR=$release" \
    "SOURCE_SHA=$source_sha" \
    "ARCHIVE_SHA256=$archive_sha" \
    "STATUS=$status" > "$pending"
  chmod 0600 "$pending"
  mv -- "$pending" "$path"
}

load_record() {
  local run_id="$1"
  local record="$record_root/$run_id.env"
  local expected
  assert_root_file "$record" 600 32768
  mapfile -t record_lines < "$record"
  [[ "${#record_lines[@]}" == 5 ]] || die 'staging release record is malformed'
  [[ "${record_lines[0]}" == SCHEMA=emdo-staging-release-v1 ]] ||
    die 'staging release record schema is invalid'
  RECORD_RELEASE="${record_lines[1]#RELEASE_DIR=}"
  RECORD_SOURCE_SHA="${record_lines[2]#SOURCE_SHA=}"
  RECORD_ARCHIVE_SHA="${record_lines[3]#ARCHIVE_SHA256=}"
  RECORD_STATUS="${record_lines[4]#STATUS=}"
  [[ "${record_lines[1]}" == "RELEASE_DIR=$RECORD_RELEASE" &&
    "${record_lines[2]}" == "SOURCE_SHA=$RECORD_SOURCE_SHA" &&
    "${record_lines[3]}" == "ARCHIVE_SHA256=$RECORD_ARCHIVE_SHA" &&
    "${record_lines[4]}" == "STATUS=$RECORD_STATUS" ]] ||
    die 'staging release record contains an unexpected key'
  [[ "$RECORD_SOURCE_SHA" =~ ^[0-9a-f]{40}$ && "$RECORD_ARCHIVE_SHA" =~ ^[0-9a-f]{64}$ ]] ||
    die 'staging release record identifiers are invalid'
  [[ "$RECORD_STATUS" == installed || "$RECORD_STATUS" == consumed ]] ||
    die 'staging release record status is invalid'
  expected="$release_root/$RECORD_SOURCE_SHA-$run_id"
  [[ "$RECORD_RELEASE" == "$expected" ]] || die 'staging release record is not bound to its workflow run'
  assert_release_tree "$RECORD_RELEASE" "$RECORD_SOURCE_SHA" "$run_id"
  [[ "$(< "$RECORD_RELEASE/.archive-sha256")" == "$RECORD_ARCHIVE_SHA" ]] ||
    die 'staging release archive digest record is inconsistent'
}

install_release() {
  [[ "$#" == 4 ]] || die 'install requires archive, image lock, descriptor, and signature paths'
  local archive="$1"
  local image_lock="$2"
  local descriptor="$3"
  local signature="$4"
  local incoming descriptor_text schema purpose source_sha run_id archive_sha image_lock_sha
  local copied_archive copied_lock copied_descriptor copied_signature release installing record
  local key value line expected_repository image_count=0
  declare -A image_values=()

  assert_incoming_file "$archive" 104857600
  assert_incoming_file "$image_lock" 32768
  assert_incoming_file "$descriptor" 4096
  assert_incoming_file "$signature" 4096
  assert_root_file "$public_key" 644 16384

  incoming="$(mktemp -d "$incoming_root/install.XXXXXX")"
  INSTALL_CLEANUP_INCOMING="$incoming"
  copied_archive="$incoming/release.tgz"
  copied_lock="$incoming/images.env"
  copied_descriptor="$incoming/descriptor.env"
  copied_signature="$incoming/descriptor.sig"
  installing=''
  INSTALL_CLEANUP_INSTALLING=''
  cleanup_install() {
    local exit_code=$?
    trap - EXIT
    if [[ -n "$INSTALL_CLEANUP_INCOMING" && -d "$INSTALL_CLEANUP_INCOMING" ]]; then
      find "$INSTALL_CLEANUP_INCOMING" -xdev -type f -delete 2>/dev/null || true
      rmdir "$INSTALL_CLEANUP_INCOMING" 2>/dev/null || true
    fi
    if [[ -n "$INSTALL_CLEANUP_INSTALLING" && -d "$INSTALL_CLEANUP_INSTALLING" ]]; then
      find "$INSTALL_CLEANUP_INSTALLING" -xdev -type f -delete 2>/dev/null || true
      find "$INSTALL_CLEANUP_INSTALLING" -xdev -depth -type d -delete 2>/dev/null || true
    fi
    exit "$exit_code"
  }
  trap cleanup_install EXIT
  install -o 0 -g 0 -m 0600 "$archive" "$copied_archive"
  install -o 0 -g 0 -m 0600 "$image_lock" "$copied_lock"
  install -o 0 -g 0 -m 0600 "$descriptor" "$copied_descriptor"
  install -o 0 -g 0 -m 0600 "$signature" "$copied_signature"

  openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin \
    -in "$copied_descriptor" -sigfile "$copied_signature" >/dev/null 2>&1 ||
    die 'release descriptor signature is invalid'

  mapfile -t descriptor_lines < "$copied_descriptor"
  [[ "${#descriptor_lines[@]}" == 6 ]] || die 'release descriptor is malformed'
  schema="${descriptor_lines[0]#schema=}"
  purpose="${descriptor_lines[1]#purpose=}"
  source_sha="${descriptor_lines[2]#source_sha=}"
  run_id="${descriptor_lines[3]#workflow_run_id=}"
  archive_sha="${descriptor_lines[4]#archive_sha256=}"
  image_lock_sha="${descriptor_lines[5]#image_lock_sha256=}"
  descriptor_text="$(printf '%s\n' \
    "schema=$schema" \
    "purpose=$purpose" \
    "source_sha=$source_sha" \
    "workflow_run_id=$run_id" \
    "archive_sha256=$archive_sha" \
    "image_lock_sha256=$image_lock_sha")"
  [[ "$(< "$copied_descriptor")" == "$descriptor_text" ]] ||
    die 'release descriptor keys or ordering are invalid'
  [[ "$schema" == emdo-release-assets-v1 && "$purpose" == staging ]] ||
    die 'release descriptor purpose is not staging'
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ && "$archive_sha" =~ ^[0-9a-f]{64}$ && "$image_lock_sha" =~ ^[0-9a-f]{64}$ ]] ||
    die 'release descriptor identifiers are invalid'
  assert_safe_run_id "$run_id"
  [[ "$(sha256sum "$copied_archive" | cut -d ' ' -f 1)" == "$archive_sha" ]] ||
    die 'release archive does not match its signed descriptor'
  [[ "$(sha256sum "$copied_lock" | cut -d ' ' -f 1)" == "$image_lock_sha" ]] ||
    die 'image lock does not match its signed descriptor'

  while IFS= read -r entry; do
    [[ "$entry" == infra/compose/* || "$entry" == infra/caddy/* ||
      "$entry" == infra/powersync/* || "$entry" == infra/scripts/* ||
      "$entry" == infra/systemd/* || "$entry" == infra/compose ||
      "$entry" == infra/caddy || "$entry" == infra/powersync ||
      "$entry" == infra/scripts || "$entry" == infra/systemd ]] ||
      die 'signed release archive contains an unexpected path'
    [[ "$entry" != /* && "$entry" != *'/../'* && "$entry" != ../* ]] ||
      die 'signed release archive contains a path traversal'
  done < <(tar --list --gzip --file "$copied_archive")

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *=* ]] || die 'image lock is malformed'
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      SOURCE_SHA | API_IMAGE | WORKER_IMAGE | WEB_IMAGE | POSTGRES_IMAGE | POWERSYNC_IMAGE | CADDY_IMAGE) ;;
      *) die 'image lock contains an unexpected key' ;;
    esac
    [[ -z "${image_values[$key]+present}" ]] || die 'image lock repeats a key'
    image_values[$key]="$value"
    image_count=$((image_count + 1))
  done < "$copied_lock"
  [[ "$image_count" == 7 && "${image_values[SOURCE_SHA]:-}" == "$source_sha" ]] ||
    die 'image lock is incomplete or has the wrong source SHA'
  for key in API_IMAGE WORKER_IMAGE WEB_IMAGE POSTGRES_IMAGE POWERSYNC_IMAGE CADDY_IMAGE; do
    [[ "${image_values[$key]:-}" =~ ^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$ ]] ||
      die 'image lock contains a mutable or invalid image reference'
    case "$key" in
      API_IMAGE) expected_repository=ghcr.io/panic80/emdo-api ;;
      WORKER_IMAGE) expected_repository=ghcr.io/panic80/emdo-worker ;;
      WEB_IMAGE) expected_repository=ghcr.io/panic80/emdo-web ;;
      POSTGRES_IMAGE) expected_repository=pgvector/pgvector ;;
      POWERSYNC_IMAGE) expected_repository=journeyapps/powersync-service ;;
      CADDY_IMAGE) expected_repository=caddy ;;
    esac
    [[ "${image_values[$key]%@sha256:*}" == "$expected_repository" ]] ||
      die 'image lock contains an unapproved image repository'
  done

  release="$release_root/$source_sha-$run_id"
  record="$record_root/$run_id.env"
  [[ ! -e "$release" && ! -e "$record" ]] || die 'signed staging release has already been installed or consumed'
  installing="$release_root/.installing-$source_sha-$run_id"
  INSTALL_CLEANUP_INSTALLING="$installing"
  [[ ! -e "$installing" ]] || die 'staging release installation path already exists'
  install -d -o 0 -g 0 -m 0755 "$installing"
  tar --extract --gzip --file "$copied_archive" --directory "$installing" \
    --no-same-owner --no-same-permissions
  [[ -z "$(find "$installing" -xdev ! -type f ! -type d -print -quit)" ]] ||
    die 'signed release archive contains a non-regular filesystem entry'
  for required in \
    infra/compose/compose.yml \
    infra/scripts/_common.sh \
    infra/scripts/deploy-staging.sh \
    infra/scripts/run-staging-acceptance.sh \
    infra/scripts/teardown-staging.sh; do
    [[ -f "$installing/$required" ]] || die 'signed release archive is missing a required staging asset'
  done
  chown -R root:root "$installing"
  find "$installing" -type d -exec chmod 0755 {} +
  find "$installing" -type f -exec chmod 0644 {} +
  find "$installing/infra/scripts" -type f -name '*.sh' -exec chmod 0755 {} +
  printf '%s\n' "$archive_sha" > "$installing/.archive-sha256"
  chmod 0644 "$installing/.archive-sha256"
  install -o 0 -g 0 -m 0600 "$copied_lock" "$installing/images.env"
  mv -- "$installing" "$release"
  installing=''
  INSTALL_CLEANUP_INSTALLING=''
  write_record "$record" "$release" "$source_sha" "$archive_sha" installed
  log "installed signed staging release $source_sha for workflow run $run_id"
  cleanup_install
}

deploy_release() {
  [[ "$#" == 3 || "$#" == 4 ]] ||
    die 'deploy requires run ID, initial-deployment flag, TTL, and optional Finance synthetic-staging flag'
  local run_id="$1"
  local initial_deployment="$2"
  local ttl_minutes="$3"
  local finance_synthetic_staging="${4:-false}"
  local -a finance_key_lines=()
  assert_safe_run_id "$run_id"
  [[ "$initial_deployment" == true || "$initial_deployment" == false ]] ||
    die 'initial-deployment flag is invalid'
  [[ "$ttl_minutes" =~ ^[0-9]{1,3}$ ]] || die 'staging TTL is invalid'
  [[ "$finance_synthetic_staging" == true || "$finance_synthetic_staging" == false ]] ||
    die 'Finance synthetic-staging flag is invalid'
  if [[ "$finance_synthetic_staging" == true ]]; then
    # Receive the Finance-only key through this root action's stdin before the
    # one-use release record is consumed. It never becomes an argument, env var,
    # log entry, or on-host command line.
    mapfile -t finance_key_lines
    [[ "${#finance_key_lines[@]}" == 1 && ${#finance_key_lines[0]} -ge 16 &&
      ${#finance_key_lines[0]} -le 512 &&
      "${finance_key_lines[0]}" =~ ^[A-Za-z0-9_-]+$ ]] ||
      die 'Finance staging key must be one protected stdin line with a valid format'
  fi
  load_record "$run_id"
  [[ "$RECORD_STATUS" == installed ]] || die 'staging release has already been consumed'
  # Consume before invoking candidate code. A failed attempt must use a new,
  # separately signed workflow run and cannot be replayed with the staging key.
  write_record "$record_root/$run_id.env" "$RECORD_RELEASE" "$RECORD_SOURCE_SHA" "$RECORD_ARCHIVE_SHA" consumed
  if [[ "$finance_synthetic_staging" == true ]]; then
    # The signed release reads this same root-owned protected stdin stream to
    # create its run-scoped env files without receiving a secret argument.
    printf '%s\n' "${finance_key_lines[0]}" |
      INITIAL_STAGING_BOOTSTRAP="$initial_deployment" \
        EMDO_FINANCE_SYNTHETIC_STAGING=true \
        "$RECORD_RELEASE/infra/scripts/deploy-staging.sh" \
          "$run_id" "$RECORD_RELEASE/images.env" "$ttl_minutes" true
    finance_key_lines[0]=''
  else
    INITIAL_STAGING_BOOTSTRAP="$initial_deployment" \
      EMDO_FINANCE_SYNTHETIC_STAGING=false \
      "$RECORD_RELEASE/infra/scripts/deploy-staging.sh" \
        "$run_id" "$RECORD_RELEASE/images.env" "$ttl_minutes" false
  fi
}

accept_release() {
  [[ "$#" == 1 ]] || die 'accept requires a workflow run ID'
  local run_id="$1"
  assert_safe_run_id "$run_id"
  load_record "$run_id"
  [[ "$RECORD_STATUS" == consumed ]] || die 'staging release has not been deployed'
  # The signed candidate owns the exact Finance marker and receipt validators.
  # It is sourced only after the immutable release record has been verified.
  # shellcheck source=/dev/null
  source "$RECORD_RELEASE/infra/scripts/_common.sh"
  "$RECORD_RELEASE/infra/scripts/run-staging-acceptance.sh" "$run_id"
  if finance_staging_marker_is_valid "/var/lib/emdo/staging/$run_id"; then
    cat -- "/var/lib/emdo/staging/$run_id/finance-synthetic-staging-probe.json"
  else
    cat -- "/var/lib/emdo/staging/$run_id/http-api-subset.json"
  fi
}

finance_restore_receipt_release() {
  [[ "$#" == 1 ]] || die 'finance-restore-receipt requires a workflow run ID'
  local run_id="$1"
  local state_dir receipt

  assert_safe_run_id "$run_id"
  load_record "$run_id"
  [[ "$RECORD_STATUS" == consumed ]] || die 'staging release has not been deployed'
  # shellcheck source=/dev/null
  source "$RECORD_RELEASE/infra/scripts/_common.sh"
  state_dir="$STAGING_STATE_ROOT/$run_id"
  assert_governed_parent_chain "$state_dir" "$STAGING_STATE_ROOT"
  finance_staging_marker_is_valid "$state_dir" ||
    die 'Finance restore receipt is unavailable for a baseline staging run'
  receipt="$state_dir/finance-staging-restore-receipt.json"
  assert_root_owned_bounded_file "$receipt" 600 16384
  node --input-type=module --eval '
    import { readFile } from "node:fs/promises";
    const [path, sourceSha, runId] = process.argv.slice(1);
    const value = JSON.parse(await readFile(path, "utf8"));
    const expectedKeys = [
      "authenticatedOriginalHash", "committedDocumentReadback",
      "committedEvidenceReadback", "environment", "evidenceClass",
      "releaseEligible", "schemaVersion", "secondAuthenticatedUserDenied",
      "sourceSha", "stagingRunId", "workflowRunId",
    ].sort();
    if (value?.schemaVersion !== 1 ||
        value?.evidenceClass !== "finance-staging-restore-verification" ||
        value?.releaseEligible !== false || value?.environment !== "staging" ||
        value?.sourceSha !== sourceSha || value?.workflowRunId !== runId ||
        value?.stagingRunId !== runId ||
        value?.committedDocumentReadback !== true ||
        value?.authenticatedOriginalHash !== true ||
        value?.committedEvidenceReadback !== true ||
        value?.secondAuthenticatedUserDenied !== true ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) process.exit(1);
  ' "$receipt" "$RECORD_SOURCE_SHA" "$run_id" ||
    die 'Finance restore receipt is invalid for this signed staging run'
  cat -- "$receipt"
}

teardown_release() {
  [[ "$#" == 1 ]] || die 'teardown requires a workflow run ID'
  local run_id="$1"
  assert_safe_run_id "$run_id"
  load_record "$run_id"
  "$RECORD_RELEASE/infra/scripts/teardown-staging.sh" "$run_id"
}

action="${1:-}"
shift || true
case "$action" in
  install) install_release "$@" ;;
  deploy) deploy_release "$@" ;;
  accept) accept_release "$@" ;;
  finance-restore-receipt) finance_restore_receipt_release "$@" ;;
  teardown) teardown_release "$@" ;;
  *) die 'allowed actions are install, deploy, accept, finance-restore-receipt, and teardown' ;;
esac

#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

# This script is intentionally separate from the production logical-backup
# path.  It operates only on one live, synthetic Finance staging run and
# deletes its isolated restore resources before returning.
# shellcheck source=infra/scripts/_common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"

readonly FINANCE_STAGING_BACKUP_SCHEMA='emdo-finance-staging-backup-v1'
readonly FINANCE_STAGING_BACKUP_DIRECTORY_NAME='finance-staging-backup'
readonly FINANCE_STAGING_RESTORE_DIRECTORY_NAME='finance-staging-restore'
readonly FINANCE_STAGING_BACKUP_KEY_NAME='finance-staging-backup.age-key'
readonly FINANCE_STAGING_BACKUP_NAME_PREFIX='finance-staging'
readonly FINANCE_STAGING_DOCUMENT_MANIFEST_SCHEMA='emdo-finance-document-backup-v1'
readonly FINANCE_STAGING_DOCUMENT_OBJECT_PATTERN='^fd1_[A-Za-z0-9_-]{43}$'
readonly FINANCE_STAGING_MAX_DOCUMENT_OBJECTS=10000
readonly FINANCE_STAGING_MAX_DOCUMENT_CIPHERTEXT_BYTES=$((25 * 1024 * 1024))
readonly FINANCE_STAGING_MAX_DOCUMENT_TOTAL_BYTES=$((50 * 1024 * 1024 * 1024))
readonly FINANCE_STAGING_MAX_DOCUMENT_ARCHIVE_BYTES=$((FINANCE_STAGING_MAX_DOCUMENT_TOTAL_BYTES + FINANCE_STAGING_MAX_DOCUMENT_OBJECTS * 1024 + 10240))
readonly FINANCE_STAGING_MAX_DATABASE_DUMP_BYTES=$((100 * 1024 * 1024 * 1024))
readonly FINANCE_STAGING_MAX_BACKUP_BUNDLE_BYTES=$((FINANCE_STAGING_MAX_DATABASE_DUMP_BYTES + FINANCE_STAGING_MAX_DOCUMENT_ARCHIVE_BYTES + 4 * 1024 * 1024))

usage() {
  die 'usage: FINANCE_STAGING_BACKUP_RESTORE_TARGET_ENVIRONMENT=staging finance-staging-backup-restore.sh backup <numeric-staging-run-id> | FINANCE_STAGING_BACKUP_RESTORE_TARGET_ENVIRONMENT=staging FINANCE_RESTORE_HTTP_PORT=<unprivileged-port> finance-staging-backup-restore.sh restore <numeric-staging-run-id>'
}

require_root_operator() {
  [[ "$(id -u)" == 0 ]] || die 'Finance staging backup/restore must run as root'
}

assert_staging_target() {
  [[ "${FINANCE_STAGING_BACKUP_RESTORE_TARGET_ENVIRONMENT:-}" == staging ]] ||
    die 'FINANCE_STAGING_BACKUP_RESTORE_TARGET_ENVIRONMENT must be exactly staging'
}

assert_run_id() {
  local value="$1"

  assert_safe_identifier "$value" STAGING_RUN_ID
  [[ "$value" =~ ^[1-9][0-9]{0,19}$ ]] ||
    die 'STAGING_RUN_ID must be numeric and nonzero'
  if [[ -n "${STAGING_RUN_ID:-}" && "$STAGING_RUN_ID" != "$value" ]]; then
    die 'STAGING_RUN_ID does not match the requested Finance staging run'
  fi
}

configure_staging_run() {
  state_dir="$STAGING_STATE_ROOT/$run_id"
  [[ -d "$state_dir" && ! -L "$state_dir" ]] ||
    die 'Finance staging run state is missing or unsafe'
  assert_governed_parent_chain "$state_dir" "$STAGING_STATE_ROOT"
  assert_root_owned_bounded_file "$state_dir/images.env" 600 32768
  assert_digest_lock "$state_dir/images.env"
  export_digest_lock
  assert_finance_synthetic_staging_state "$state_dir"
  export EMDO_STAGING_SOURCE_SHA="$IMAGE_LOCK_SOURCE_SHA"
  export EMDO_STAGING_WORKFLOW_RUN_ID="$run_id"
  load_deployment_config "$STAGING_CONFIG_FILE"
  export COMPOSE_PROJECT_NAME="emdo-staging-$run_id" \
    DEPLOYMENT_NAMESPACE="staging-$run_id" \
    EMDO_ENVIRONMENT=staging \
    STAGING_RUN_ID="$run_id"
  export STAGING_HTTP_PORT="${DEPLOY_CONFIG_STAGING_HTTP_PORT:-18080}"
  assert_unprivileged_tcp_port "$STAGING_HTTP_PORT"
  export EMDO_DOMAIN='http://:8080'
  export ACME_EMAIL='staging-invalid@emdo.invalid'
  export POWERSYNC_JWKS_URI='http://api:3000/.well-known/jwks.json'
  export SECRETS_DIR="${DEPLOY_CONFIG_SECRETS_DIR:-/etc/emdo/staging}"
  assert_secret_directory_permissions "$SECRETS_DIR"
  assert_directory_within "$SECRETS_DIR" /etc/emdo/staging SECRETS_DIR
  assert_staging_secret_manifest "$SECRETS_DIR"
  assert_finance_synthetic_staging_state "$state_dir"
  [[ "$EMDO_FINANCE_SYNTHETIC_STAGING" == true ]] ||
    die 'Finance synthetic staging was not enabled for the requested run'
}

assert_finance_acceptance_receipt() {
  local receipt="$state_dir/finance-synthetic-staging-probe.json"

  assert_root_owned_bounded_file "$receipt" 600 262144
  node --input-type=module --eval '
    import { readFile } from "node:fs/promises";
    const value = JSON.parse(await readFile(process.argv[1], "utf8"));
    if (value?.schemaVersion !== 1 ||
        value?.evidenceClass !== "finance-synthetic-staging-probe" ||
        value?.releaseEligible !== false ||
        value?.outcome !== "blocked" ||
        value?.environment !== "staging" ||
        value?.sourceSha !== process.env.EMDO_STAGING_SOURCE_SHA ||
        value?.execution?.runId !== process.env.EMDO_STAGING_WORKFLOW_RUN_ID) process.exit(1);
  ' "$receipt" || die 'Finance staging acceptance receipt is invalid for this run'
}

assert_document_store() {
  local directory="$1" owner_uid owner_gid mode

  [[ "$directory" == "$state_dir/$FINANCE_STAGING_DOCUMENT_STORE_DIRNAME" ]] ||
    die 'Finance document store is not the exact requested staging run path'
  require_directory "$directory"
  [[ ! -L "$directory" ]] || die 'Finance document store must not be a symlink'
  read -r owner_uid owner_gid mode < <(stat -c '%u %g %a' "$directory")
  [[ "$owner_uid" == 10001 && "$owner_gid" == 10001 && "$mode" == 700 ]] ||
    die 'Finance document store must be owned by 10001:10001 with mode 0700'
  assert_directory_within "$directory" "$state_dir" FINANCE_STAGING_DOCUMENT_STORE_DIR
}

assert_document_object() {
  local path="$1" owner_uid owner_gid mode links bytes

  require_regular_file "$path"
  [[ ! -L "$path" ]] || die 'Finance document object must not be a symlink'
  read -r owner_uid owner_gid mode links bytes < <(stat -c '%u %g %a %h %s' "$path")
  [[ "$owner_uid" == 10001 && "$owner_gid" == 10001 && "$mode" == 600 ]] ||
    die 'Finance document object must be owned by 10001:10001 with mode 0600'
  [[ "$links" == 1 ]] || die 'Finance document object must have exactly one hard link'
  [[ "$bytes" =~ ^[1-9][0-9]*$ ]] &&
    ((10#$bytes <= FINANCE_STAGING_MAX_DOCUMENT_CIPHERTEXT_BYTES)) ||
    die 'Finance document object ciphertext size is invalid'
}

create_document_archive() {
  local document_store="$1" work_directory="$2"
  local object_paths="$work_directory/document-paths.nul"
  local object_names_unsorted="$work_directory/document-names.unsorted"
  local object_names="$work_directory/document-names"
  local manifest_records="$work_directory/finance-documents.manifest.records"
  finance_manifest="$work_directory/finance-documents.manifest"
  finance_archive="$work_directory/finance-documents.tar"
  local object_path object_name object_bytes object_digest

  : > "$object_names_unsorted"
  : > "$manifest_records"
  find -P "$document_store" -xdev -mindepth 1 -maxdepth 1 -print0 > "$object_paths"
  finance_document_object_count=0
  finance_document_ciphertext_bytes=0
  while IFS= read -r -d '' object_path; do
    [[ "$(dirname -- "$object_path")" == "$document_store" ]] ||
      die 'Finance document store contains a nested or escaped entry'
    object_name="$(basename -- "$object_path")"
    [[ "$object_name" =~ $FINANCE_STAGING_DOCUMENT_OBJECT_PATTERN ]] ||
      die 'Finance document store contains a non-opaque object name'
    assert_document_object "$object_path"
    object_bytes="$(stat -c '%s' "$object_path")"
    finance_document_object_count=$((finance_document_object_count + 1))
    ((finance_document_object_count <= FINANCE_STAGING_MAX_DOCUMENT_OBJECTS)) ||
      die 'Finance document store exceeds the governed object-count limit'
    finance_document_ciphertext_bytes=$((finance_document_ciphertext_bytes + 10#$object_bytes))
    ((finance_document_ciphertext_bytes <= FINANCE_STAGING_MAX_DOCUMENT_TOTAL_BYTES)) ||
      die 'Finance document store exceeds the governed ciphertext-byte limit'
    read -r object_digest _ < <(sha256sum "$object_path")
    [[ "$object_digest" =~ ^[0-9a-f]{64}$ ]] ||
      die 'Finance document ciphertext digest could not be calculated'
    printf '%s\n' "$object_name" >> "$object_names_unsorted"
    printf '%s\t%s\t%s\n' "$object_name" "$object_bytes" "$object_digest" >> "$manifest_records"
  done < "$object_paths"
  ((finance_document_object_count >= 1)) ||
    die 'Finance staging backup requires at least one encrypted document object'

  LC_ALL=C sort "$object_names_unsorted" > "$object_names"
  {
    printf 'schema=%s\n' "$FINANCE_STAGING_DOCUMENT_MANIFEST_SCHEMA"
    LC_ALL=C sort "$manifest_records"
  } > "$finance_manifest"
  chmod 0600 "$object_names" "$manifest_records" "$finance_manifest"
  chown 0:0 "$object_names" "$manifest_records" "$finance_manifest"
  tar --sort=name --owner=0 --group=0 --numeric-owner --mode=0600 --mtime=@0 \
    --directory "$document_store" --create --file "$finance_archive" \
    --no-recursion --verbatim-files-from --files-from "$object_names"
  chmod 0600 "$finance_archive"
  chown 0:0 "$finance_archive"

  finance_archive_summary="$(
    bash "$SCRIPT_DIR/finance-document-backup-verify.sh" \
      verify-archive "$finance_manifest" "$finance_archive"
  )"
  [[ "$finance_archive_summary" =~ ^objects=([0-9]+)\ bytes=([0-9]+)$ ]] ||
    die 'Finance document archive verification returned an invalid summary'
  [[ "${BASH_REMATCH[1]}" == "$finance_document_object_count" &&
    "${BASH_REMATCH[2]}" == "$finance_document_ciphertext_bytes" ]] ||
    die 'Finance document archive verification did not bind the source store'
}

create_backup_key() {
  local secret_directory="$1" pending_directory pending_key

  finance_backup_key="$secret_directory/$FINANCE_STAGING_BACKUP_KEY_NAME"
  [[ ! -e "$finance_backup_key" && ! -L "$finance_backup_key" ]] ||
    die 'Finance staging backup key already exists for this run'
  pending_directory="$(mktemp -d "$secret_directory/.finance-backup-key.XXXXXX")"
  chmod 0700 "$pending_directory"
  chown 0:0 "$pending_directory"
  pending_key="$pending_directory/$FINANCE_STAGING_BACKUP_KEY_NAME"
  age-keygen --output "$pending_key" >/dev/null 2>&1 || {
    find "$pending_directory" -xdev -type f -delete 2>/dev/null || true
    rmdir -- "$pending_directory" 2>/dev/null || true
    die 'could not generate the run-scoped Finance staging backup key'
  }
  chmod 0600 "$pending_key"
  chown 0:0 "$pending_key"
  mv -- "$pending_key" "$finance_backup_key"
  rmdir -- "$pending_directory"
  assert_root_owned_bounded_file "$finance_backup_key" 600 65536
  finance_backup_key_created=true
}

create_age_recipient_file() {
  local destination="$1" recipient

  recipient="$(age-keygen -y "$finance_backup_key" 2>/dev/null)" ||
    die 'could not derive the Finance staging backup recipient'
  [[ "$recipient" =~ ^age1[a-z0-9]{20,}$ ]] ||
    die 'Finance staging backup recipient is invalid'
  printf '%s\n' "$recipient" > "$destination"
  chmod 0600 "$destination"
  chown 0:0 "$destination"
}

sha256_for_file() {
  local path="$1" digest extra

  read -r digest extra < <(sha256sum "$path")
  [[ "$digest" =~ ^[0-9a-f]{64}$ && -n "${extra:-}" ]] ||
    die 'could not calculate a SHA-256 digest'
  printf '%s' "$digest"
}

cleanup_backup() {
  local exit_code=$?
  trap - EXIT
  if [[ -n "${backup_work_dir:-}" && -d "$backup_work_dir" && ! -L "$backup_work_dir" ]]; then
    find "$backup_work_dir" -xdev -type f -delete 2>/dev/null || true
    rmdir -- "$backup_work_dir" 2>/dev/null || true
  fi
  if ((exit_code != 0)) && [[ "${finance_backup_key_created:-false}" == true ]]; then
    rm -f -- "$finance_backup_key"
  fi
  if ((exit_code != 0)) && [[ -n "${finance_backup_root:-}" && -d "$finance_backup_root" && ! -L "$finance_backup_root" ]]; then
    find "$finance_backup_root" -xdev -type f -delete 2>/dev/null || true
    rmdir -- "$finance_backup_root" 2>/dev/null || true
  fi
  exit "$exit_code"
}

backup_finance_staging_run() {
  local secret_directory document_store recipient_file metadata_file database_dump_age
  local archive_pending checksum_pending complete_pending backup_digest

  require_command docker
  require_command age
  require_command age-keygen
  require_command sha256sum
  require_command tar
  require_command find
  require_command sort
  require_command stat
  require_command node
  assert_finance_acceptance_receipt
  assert_compose_healthy staging_compose

  secret_directory="$state_dir/$FINANCE_STAGING_SECRET_DIR"
  document_store="$FINANCE_STAGING_DOCUMENT_STORE_DIR"
  assert_document_store "$document_store"
  finance_backup_root="$state_dir/$FINANCE_STAGING_BACKUP_DIRECTORY_NAME"
  [[ ! -e "$finance_backup_root" && ! -L "$finance_backup_root" ]] ||
    die 'Finance staging backup output already exists for this run'
  backup_name="$FINANCE_STAGING_BACKUP_NAME_PREFIX-$run_id.age"
  backup_file="$finance_backup_root/$backup_name"
  backup_checksum_file="$backup_file.sha256"
  backup_complete_file="$backup_file.complete"
  install -d -o 0 -g 0 -m 0700 "$finance_backup_root"
  assert_governed_parent_chain "$finance_backup_root" "$state_dir"
  backup_work_dir="$(mktemp -d "$state_dir/.finance-backup.XXXXXX")"
  chmod 0700 "$backup_work_dir"
  chown 0:0 "$backup_work_dir"
  finance_backup_key_created=false
  trap cleanup_backup EXIT

  create_backup_key "$secret_directory"
  recipient_file="$backup_work_dir/recipient.txt"
  create_age_recipient_file "$recipient_file"
  create_document_archive "$document_store" "$backup_work_dir"
  database_dump_age="$backup_work_dir/finance-emdo.dump.age"
  staging_compose exec -T postgres pg_dump \
    --username postgres --dbname emdo_app --schema emdo --format custom --compress 9 |
    age --encrypt --recipients-file "$recipient_file" --output "$database_dump_age"
  chmod 0600 "$database_dump_age"
  chown 0:0 "$database_dump_age"
  assert_root_owned_bounded_file "$database_dump_age" 600 "$FINANCE_STAGING_MAX_DATABASE_DUMP_BYTES"

  metadata_file="$backup_work_dir/metadata.txt"
  printf '%s\n' \
    "schema=$FINANCE_STAGING_BACKUP_SCHEMA" \
    "created_at=$(date --utc +%FT%TZ)" \
    "staging_run_id=$run_id" \
    "source_sha=$IMAGE_LOCK_SOURCE_SHA" \
    "postgres_image=$IMAGE_LOCK_POSTGRES_IMAGE" \
    'database_scope=emdo' \
    "finance_objects=$finance_document_object_count" \
    "finance_ciphertext_bytes=$finance_document_ciphertext_bytes" \
    > "$metadata_file"
  chmod 0600 "$metadata_file"
  chown 0:0 "$metadata_file"

  archive_pending="$finance_backup_root/.${backup_name}.pending"
  checksum_pending="$finance_backup_root/.${backup_name}.sha256.pending"
  complete_pending="$finance_backup_root/.${backup_name}.complete.pending"
  tar --sort=name --owner=0 --group=0 --numeric-owner --mode=0600 --mtime=@0 \
    --directory "$backup_work_dir" --create --file - \
    metadata.txt finance-emdo.dump.age finance-documents.manifest finance-documents.tar |
    age --encrypt --recipients-file "$recipient_file" --output "$archive_pending"
  chmod 0600 "$archive_pending"
  chown 0:0 "$archive_pending"
  backup_digest="$(sha256_for_file "$archive_pending")"
  printf '%s  %s\n' "$backup_digest" "$backup_name" > "$checksum_pending"
  printf '%s\n' \
    "schema=$FINANCE_STAGING_BACKUP_SCHEMA" \
    "bundle=$backup_name" \
    "sha256=$backup_digest" \
    > "$complete_pending"
  chmod 0600 "$checksum_pending" "$complete_pending"
  chown 0:0 "$checksum_pending" "$complete_pending"
  mv -- "$archive_pending" "$backup_file"
  mv -- "$checksum_pending" "$backup_checksum_file"
  mv -- "$complete_pending" "$backup_complete_file"
  assert_root_owned_bounded_file "$backup_file" 600 "$FINANCE_STAGING_MAX_BACKUP_BUNDLE_BYTES"
  assert_root_owned_bounded_file "$backup_checksum_file" 600 4096
  assert_root_owned_bounded_file "$backup_complete_file" 600 4096
  finance_backup_key_created=false
  trap - EXIT
  cleanup_backup
}

verify_backup_sidecars() {
  local recorded_digest recorded_name extra expected_completion

  assert_root_owned_bounded_file "$backup_file" 600 "$FINANCE_STAGING_MAX_BACKUP_BUNDLE_BYTES"
  assert_root_owned_bounded_file "$backup_checksum_file" 600 4096
  assert_root_owned_bounded_file "$backup_complete_file" 600 4096
  read -r recorded_digest recorded_name extra < "$backup_checksum_file"
  [[ "$recorded_digest" =~ ^[0-9a-f]{64}$ && "$recorded_name" == "$backup_name" && -z "${extra:-}" ]] ||
    die 'Finance staging backup checksum record is invalid'
  expected_completion="$(printf '%s\n' \
    "schema=$FINANCE_STAGING_BACKUP_SCHEMA" \
    "bundle=$backup_name" \
    "sha256=$recorded_digest")"
  [[ "$(< "$backup_complete_file")" == "$expected_completion" ]] ||
    die 'Finance staging backup completion marker is invalid'
  (
    cd -- "$finance_backup_root"
    printf '%s  %s\n' "$recorded_digest" "$backup_name" |
      sha256sum --check --strict -
  )
}

extract_bundle_member_limited() {
  local entry="$1" destination="$2" maximum_bytes="$3"
  local tar_status head_status actual_bytes
  local -a pipeline_status

  [[ ! -e "$destination" && ! -L "$destination" ]] ||
    die "Finance staging restore extraction destination already exists: $entry"
  set +e
  tar --extract --to-stdout --file "$restore_bundle_file" -- "$entry" |
    head --bytes="$((maximum_bytes + 1))" > "$destination"
  pipeline_status=("${PIPESTATUS[@]}")
  set -e
  tar_status="${pipeline_status[0]}"
  head_status="${pipeline_status[1]}"
  actual_bytes="$(stat -c '%s' "$destination")"
  ((actual_bytes <= maximum_bytes)) ||
    die "Finance staging backup archive entry exceeds its byte limit: $entry"
  [[ "$tar_status" == 0 && "$head_status" == 0 ]] ||
    die "could not safely extract Finance staging backup entry: $entry"
  require_regular_file "$destination"
  [[ -s "$destination" ]] || die "Finance staging backup entry is empty: $entry"
  chmod 0600 "$destination"
  chown 0:0 "$destination"
}

validate_restore_metadata() {
  local metadata="$1" line key value
  local -A values=()
  local count=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *=* ]] || die 'Finance staging backup metadata contains a malformed line'
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      schema | created_at | staging_run_id | source_sha | postgres_image | database_scope | finance_objects | finance_ciphertext_bytes) ;;
      *) die 'Finance staging backup metadata contains an unexpected key' ;;
    esac
    [[ -n "$value" && -z "${values[$key]+present}" ]] ||
      die 'Finance staging backup metadata contains an empty or duplicate value'
    values["$key"]="$value"
    count=$((count + 1))
  done < "$metadata"
  [[ "$count" == 8 && "${values[schema]:-}" == "$FINANCE_STAGING_BACKUP_SCHEMA" &&
    "${values[staging_run_id]:-}" == "$run_id" &&
    "${values[source_sha]:-}" == "$IMAGE_LOCK_SOURCE_SHA" &&
    "${values[postgres_image]:-}" == "$IMAGE_LOCK_POSTGRES_IMAGE" &&
    "${values[database_scope]:-}" == emdo ]] ||
    die 'Finance staging backup metadata does not bind the requested run and images'
  [[ "${values[created_at]:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    die 'Finance staging backup metadata creation time is invalid'
  [[ "${values[finance_objects]:-}" =~ ^[1-9][0-9]*$ &&
    "${values[finance_ciphertext_bytes]:-}" =~ ^[1-9][0-9]*$ ]] ||
    die 'Finance staging backup metadata document counts are invalid'
}

write_restore_compose_override() {
  local destination="$1" document_store="$2"

  # Compose's !override tag is already used by the governed Finance staging
  # overlay.  It replaces the API mount with the recovered, app-readable
  # 0400/0500 store and removes the active staging auth-egress network.
  cat > "$destination" <<EOF
services:
  api:
    volumes: !override
      - type: bind
        source: '$document_store'
        target: /var/lib/emdo/finance-documents
        read_only: true
        bind:
          create_host_path: false
    networks: !override
      - backend
      - edge
EOF
  chmod 0600 "$destination"
  chown 0:0 "$destination"
}

restore_compose() {
  docker compose \
    --project-name "$restore_project_name" \
    --file "$COMPOSE_DIR/compose.yml" \
    --file "$COMPOSE_DIR/compose.staging.yml" \
    --file "$COMPOSE_DIR/compose.finance-staging.yml" \
    --file "$restore_compose_override" \
    "$@"
}

wait_for_restore_http() {
  local deadline=$((SECONDS + 90))

  until curl --fail --silent --show-error \
    "http://127.0.0.1:$restore_http_port/healthz" >/dev/null; do
    ((SECONDS < deadline)) || die 'isolated Finance restore API did not become healthy'
    sleep 2
  done
}

assert_read_only_restore_mount() {
  local api_container read_only

  api_container="$(restore_compose ps --quiet api)"
  [[ -n "$api_container" ]] || die 'isolated Finance restore API container is missing'
  read_only="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/emdo/finance-documents"}}{{.RW}}{{end}}{{end}}' "$api_container")"
  [[ "$read_only" == false ]] ||
    die 'isolated Finance restore document store is not mounted read-only'
}

remove_restore_directory() {
  local directory="$1"

  [[ "$directory" == "$state_dir/$FINANCE_STAGING_RESTORE_DIRECTORY_NAME" ]] ||
    die 'Finance staging restore cleanup path is invalid'
  if [[ -d "$directory" && ! -L "$directory" ]]; then
    assert_directory_within "$directory" "$state_dir" FINANCE_STAGING_RESTORE_DIRECTORY
    find "$directory" -xdev -depth -mindepth 1 -delete
    rmdir -- "$directory"
  fi
}

cleanup_restore() {
  local exit_code=$?
  trap - EXIT
  if [[ "${restore_compose_started:-false}" == true ]]; then
    if ! restore_compose down --volumes --remove-orphans --timeout 30 >/dev/null 2>&1; then
      die 'isolated Finance restore cleanup failed; protected restore state was retained'
    fi
    assert_isolated_project_absent "$restore_project_name" "$restore_namespace"
  fi
  if [[ -n "${restore_root:-}" ]]; then
    remove_restore_directory "$restore_root"
  fi
  if [[ -n "${restore_work_dir:-}" && -d "$restore_work_dir" && ! -L "$restore_work_dir" ]]; then
    find "$restore_work_dir" -xdev -type f -delete
    rmdir -- "$restore_work_dir"
  fi
  exit "$exit_code"
}

restore_finance_staging_run() {
  local secret_directory restore_document_store backup_key
  local entry archive_entry_count=0
  local -A archive_entries=()
  local finance_restore_summary

  require_command docker
  require_command age
  require_command age-keygen
  require_command sha256sum
  require_command tar
  require_command head
  require_command curl
  require_command find
  require_command stat
  require_command node
  assert_finance_acceptance_receipt
  assert_compose_healthy staging_compose

  [[ -n "${FINANCE_RESTORE_HTTP_PORT:-}" ]] ||
    die 'FINANCE_RESTORE_HTTP_PORT is required for the isolated restore verifier'
  restore_http_port="$FINANCE_RESTORE_HTTP_PORT"
  assert_unprivileged_tcp_port "$restore_http_port"
  [[ "$restore_http_port" != "$STAGING_HTTP_PORT" ]] ||
    die 'FINANCE_RESTORE_HTTP_PORT must differ from the active staging port'

  secret_directory="$state_dir/$FINANCE_STAGING_SECRET_DIR"
  backup_key="$secret_directory/$FINANCE_STAGING_BACKUP_KEY_NAME"
  assert_root_owned_bounded_file "$backup_key" 600 65536
  finance_backup_root="$state_dir/$FINANCE_STAGING_BACKUP_DIRECTORY_NAME"
  backup_name="$FINANCE_STAGING_BACKUP_NAME_PREFIX-$run_id.age"
  backup_file="$finance_backup_root/$backup_name"
  backup_checksum_file="$backup_file.sha256"
  backup_complete_file="$backup_file.complete"
  assert_governed_parent_chain "$finance_backup_root" "$state_dir"
  verify_backup_sidecars

  restore_root="$state_dir/$FINANCE_STAGING_RESTORE_DIRECTORY_NAME"
  [[ ! -e "$restore_root" && ! -L "$restore_root" ]] ||
    die 'Finance staging restore output already exists for this run'
  install -d -o 0 -g 0 -m 0700 "$restore_root"
  assert_directory_within "$restore_root" "$state_dir" FINANCE_STAGING_RESTORE_DIRECTORY
  restore_document_store="$restore_root/finance-documents"
  restore_work_dir="$(mktemp -d "$restore_root/.work.XXXXXX")"
  chmod 0700 "$restore_work_dir"
  chown 0:0 "$restore_work_dir"
  restore_bundle_file="$restore_work_dir/bundle.tar"
  restore_compose_override="$restore_root/compose-readonly.yml"
  restore_project_name="emdo-finance-restore-$run_id"
  restore_namespace="finance-restore-$run_id"
  restore_compose_started=false
  trap cleanup_restore EXIT

  age --decrypt --identity "$backup_key" --output "$restore_bundle_file" "$backup_file"
  assert_root_owned_bounded_file "$restore_bundle_file" 600 "$FINANCE_STAGING_MAX_BACKUP_BUNDLE_BYTES"
  while IFS= read -r entry; do
    case "$entry" in
      metadata.txt | finance-emdo.dump.age | finance-documents.manifest | finance-documents.tar) ;;
      *) die 'Finance staging backup contains an unexpected archive entry' ;;
    esac
    [[ -z "${archive_entries[$entry]+present}" ]] ||
      die 'Finance staging backup contains a duplicate archive entry'
    archive_entries["$entry"]=present
    archive_entry_count=$((archive_entry_count + 1))
  done < <(tar --list --file "$restore_bundle_file")
  [[ "$archive_entry_count" == 4 ]] ||
    die 'Finance staging backup does not contain the exact required entry set'
  for entry in metadata.txt finance-emdo.dump.age finance-documents.manifest finance-documents.tar; do
    [[ -n "${archive_entries[$entry]+present}" ]] ||
      die 'Finance staging backup is missing a required archive entry'
  done
  extract_bundle_member_limited metadata.txt "$restore_work_dir/metadata.txt" 32768
  extract_bundle_member_limited finance-emdo.dump.age "$restore_work_dir/finance-emdo.dump.age" "$FINANCE_STAGING_MAX_DATABASE_DUMP_BYTES"
  extract_bundle_member_limited finance-documents.manifest "$restore_work_dir/finance-documents.manifest" $((2 * 1024 * 1024))
  extract_bundle_member_limited finance-documents.tar "$restore_work_dir/finance-documents.tar" "$FINANCE_STAGING_MAX_DOCUMENT_ARCHIVE_BYTES"
  validate_restore_metadata "$restore_work_dir/metadata.txt"
  finance_restore_summary="$(
    bash "$SCRIPT_DIR/finance-document-backup-verify.sh" \
      restore-archive "$restore_work_dir/finance-documents.manifest" \
      "$restore_work_dir/finance-documents.tar" "$restore_document_store"
  )"
  [[ "$finance_restore_summary" =~ ^objects=([0-9]+)\ bytes=([0-9]+)$ ]] ||
    die 'Finance staging document restore verification returned an invalid summary'
  chown 10001:10001 "$restore_document_store"
  chmod 0500 "$restore_document_store"
  while IFS= read -r -d '' restored_object; do
    chown 10001:10001 "$restored_object"
    chmod 0400 "$restored_object"
  done < <(find -P "$restore_document_store" -xdev -mindepth 1 -maxdepth 1 -type f -print0)
  [[ "$(stat -c '%u:%g:%a' "$restore_document_store")" == '10001:10001:500' ]] ||
    die 'Finance staging restore document directory is not app-readable and read-only'
  assert_directory_within "$restore_document_store" "$restore_root" FINANCE_RESTORE_DOCUMENT_STORE_DIR

  write_restore_compose_override "$restore_compose_override" "$restore_document_store"
  export COMPOSE_PROJECT_NAME="$restore_project_name" \
    DEPLOYMENT_NAMESPACE="$restore_namespace" \
    STAGING_RUN_ID="$restore_namespace" \
    STAGING_HTTP_PORT="$restore_http_port" \
    EMDO_ENVIRONMENT=staging \
    EMDO_FINANCE_SYNTHETIC_STAGING=true \
    FINANCE_STAGING_DOCUMENT_STORE_DIR="$restore_document_store"
  assert_isolated_project_absent "$restore_project_name" "$restore_namespace"
  restore_compose config --quiet
  restore_compose_started=true
  restore_compose up --detach postgres
  wait_for_restore_http_postgres_deadline=$((SECONDS + 90))
  until restore_compose exec -T postgres pg_isready --host 127.0.0.1 --username postgres --dbname emdo_app >/dev/null; do
    ((SECONDS < wait_for_restore_http_postgres_deadline)) ||
      die 'isolated Finance restore PostgreSQL did not become ready'
    sleep 2
  done
  # The blank isolated cluster initializes the same governed login roles.  The
  # source dump then restores only the emdo schema into that separate volume.
  restore_compose --profile operations run --rm migrate
  age --decrypt --identity "$backup_key" "$restore_work_dir/finance-emdo.dump.age" |
    restore_compose exec -T postgres pg_restore --username postgres --dbname emdo_app \
      --clean --if-exists --exit-on-error
  restore_compose --profile operations run --rm migrate
  restore_compose --profile operations run --rm job-schema
  restore_compose --profile operations run --rm provision
  restore_compose exec -T postgres psql --username postgres --dbname emdo_app \
    --set ON_ERROR_STOP=1 --command 'select 1 from emdo.finance_documents limit 1;' >/dev/null
  restore_compose up --detach api web caddy
  wait_for_restore_http
  assert_read_only_restore_mount
  FINANCE_RESTORE_API_ORIGIN="http://127.0.0.1:$restore_http_port" \
    "$SCRIPT_DIR/finance-staging-restore-verify.sh" "$run_id"
  assert_root_owned_bounded_file \
    "$state_dir/finance-staging-restore-receipt.json" 600 16384
  trap - EXIT
  cleanup_restore
}

command_name="${1:-}"
run_id="${2:-}"
[[ "$#" == 2 ]] || usage
case "$command_name" in
  backup | restore) ;;
  *) usage ;;
esac
assert_staging_target
require_root_operator
assert_run_id "$run_id"
finance_staging_operation_lock_fd=''
acquire_host_lock /var/lib/emdo/locks/capacity.lock finance_staging_operation_lock_fd
: "$finance_staging_operation_lock_fd"
configure_staging_run

case "$command_name" in
  backup) backup_finance_staging_run ;;
  restore) restore_finance_staging_run ;;
esac

log "Finance staging $command_name completed for run $run_id"

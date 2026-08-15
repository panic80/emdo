#!/usr/bin/env bash

if [[ -n "${EMDO_COMMON_SH_LOADED:-}" ]]; then
  return 0
fi
readonly EMDO_COMMON_SH_LOADED=1

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
INFRA_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
readonly INFRA_DIR
readonly COMPOSE_DIR="$INFRA_DIR/compose"
readonly PRODUCTION_STATE_DIR="/var/lib/emdo/deployments"
readonly STAGING_STATE_ROOT="/var/lib/emdo/staging"
readonly PRODUCTION_CONFIG_FILE="/etc/emdo/production/deployment.env"
# Used by the deployment entrypoints that source this shared library.
# shellcheck disable=SC2034
readonly STAGING_CONFIG_FILE="/etc/emdo/staging/deployment.env"
readonly -a BASE_SECRET_MANIFEST=(
  postgres_superuser_password
  api_database_password
  auth_database_password
  onboarding_database_password
  worker_database_password
  worker_executor_database_password
  worker_dispatcher_database_password
  audio_reconciliation_database_password
  finance_import_retention_database_password
  google_oauth_disconnect_reconciliation_database_password
  workflow_database_password
  visual_decision_database_password
  powersync_replication_password
  powersync_storage_password
  owner_bootstrap_database_password
  migration.env
  api.env
  edge-proxy.env
  worker.env
  finance-import-retention.env
  google-oauth-disconnect-reconciliation.env
  powersync.env
)
readonly -a STAGING_SECRET_MANIFEST=(
  synthetic.env
  synthetic-bootstrap.env
)

log() {
  printf '[emdo-deploy] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

require_regular_file() {
  [[ -f "$1" && ! -L "$1" ]] || die "required regular file is missing: $1"
}

require_directory() {
  [[ -d "$1" && ! -L "$1" ]] || die "required directory is missing: $1"
}

assert_safe_identifier() {
  local value="$1"
  local label="$2"
  [[ "$value" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$ ]] ||
    die "$label is not a safe identifier"
}

assert_absolute_scoped_directory() {
  local path="$1"
  local label="$2"
  [[ "$path" == /* && "$path" != / && "$path" != /etc && "$path" != /var ]] ||
    die "$label must be a scoped absolute directory"
  [[ "$path" != *$'\n'* && "$path" != *$'\r'* ]] ||
    die "$label contains a line break"
}

assert_directory_within() {
  local path="$1"
  local root="$2"
  local label="$3"
  local canonical_path canonical_root
  require_directory "$path"
  require_directory "$root"
  canonical_path="$(cd -- "$path" && pwd -P)"
  canonical_root="$(cd -- "$root" && pwd -P)"
  [[ "$canonical_path" == "$canonical_root" || "$canonical_path" == "$canonical_root/"* ]] ||
    die "$label must resolve within $canonical_root"
}

assert_unprivileged_tcp_port() {
  local port="$1"
  local numeric_port
  [[ "$port" =~ ^[1-9][0-9]{3,4}$ ]] ||
    die 'STAGING_HTTP_PORT must be an integer between 1024 and 65535'
  numeric_port=$((10#$port))
  ((numeric_port >= 1024 && numeric_port <= 65535)) ||
    die 'STAGING_HTTP_PORT must be an integer between 1024 and 65535'
}

readonly DIGEST_KEYS=(
  SOURCE_SHA
  API_IMAGE
  WORKER_IMAGE
  WEB_IMAGE
  POSTGRES_IMAGE
  POWERSYNC_IMAGE
  CADDY_IMAGE
)

reset_lock_values() {
  local key
  for key in SOURCE_SHA API_IMAGE WORKER_IMAGE WEB_IMAGE POSTGRES_IMAGE POWERSYNC_IMAGE CADDY_IMAGE DEPLOYED_RELEASE_SOURCE_SHA DEPLOYED_RELEASE_DIR STAGING_TESTED STAGING_RUN_ID STAGING_WORKFLOW_RUN_ID STAGING_TESTED_AT STAGING_INFRA_ARCHIVE_SHA256 INITIAL_DEPLOYMENT_BOOTSTRAP ACCEPTANCE_EVIDENCE_SHA256 ACCEPTANCE_EVIDENCE_RUN_ID ACCEPTANCE_CI_RUN_ID; do
    unset "IMAGE_LOCK_$key"
  done
  IMAGE_LOCK_SEEN='|'
}

image_lock_value() {
  local variable="IMAGE_LOCK_$1"
  printf '%s' "${!variable:-}"
}

is_allowed_lock_key() {
  case "$1" in
    SOURCE_SHA | API_IMAGE | WORKER_IMAGE | WEB_IMAGE | POSTGRES_IMAGE | POWERSYNC_IMAGE | CADDY_IMAGE | DEPLOYED_RELEASE_SOURCE_SHA | DEPLOYED_RELEASE_DIR | STAGING_TESTED | STAGING_RUN_ID | STAGING_WORKFLOW_RUN_ID | STAGING_TESTED_AT | STAGING_INFRA_ARCHIVE_SHA256 | INITIAL_DEPLOYMENT_BOOTSTRAP | ACCEPTANCE_EVIDENCE_SHA256 | ACCEPTANCE_EVIDENCE_RUN_ID | ACCEPTANCE_CI_RUN_ID)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

load_digest_lock() {
  local lock_file="$1"
  local line key value
  require_regular_file "$lock_file"
  local variable
  reset_lock_values

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || die "malformed image lock line"
    key="${line%%=*}"
    value="${line#*=}"
    is_allowed_lock_key "$key" || die "unexpected image lock key: $key"
    [[ "$IMAGE_LOCK_SEEN" != *"|$key|"* ]] || die "duplicate image lock key: $key"
    [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] ||
      die "invalid image lock value for $key"
    variable="IMAGE_LOCK_$key"
    printf -v "$variable" '%s' "$value"
    IMAGE_LOCK_SEEN="${IMAGE_LOCK_SEEN}${key}|"
  done < "$lock_file"
}

assert_digest_lock() {
  local lock_file="$1"
  local key reference digest expected_repository
  load_digest_lock "$lock_file"

  [[ "${IMAGE_LOCK_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] ||
    die "SOURCE_SHA must be the full 40-character Git commit"

  for key in API_IMAGE WORKER_IMAGE WEB_IMAGE POSTGRES_IMAGE POWERSYNC_IMAGE CADDY_IMAGE; do
    reference="$(image_lock_value "$key")"
    [[ "$reference" =~ ^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$ ]] ||
      die "$key is not an immutable digest reference"
    digest="${reference##*@sha256:}"
    [[ "$digest" != "$(printf '0%.0s' {1..64})" ]] ||
      die "$key uses the rejected placeholder digest"
    case "$key" in
      API_IMAGE) expected_repository=ghcr.io/panic80/emdo-api ;;
      WORKER_IMAGE) expected_repository=ghcr.io/panic80/emdo-worker ;;
      WEB_IMAGE) expected_repository=ghcr.io/panic80/emdo-web ;;
      POSTGRES_IMAGE) expected_repository=pgvector/pgvector ;;
      POWERSYNC_IMAGE) expected_repository=journeyapps/powersync-service ;;
      CADDY_IMAGE) expected_repository=caddy ;;
    esac
    [[ "${reference%@sha256:*}" == "$expected_repository" ]] ||
      die "$key is not from its approved image repository"
  done
}

assert_infrastructure_promotion_unchanged() (
  local current_lock="$1"
  local candidate_lock="$2"
  local key index=0
  local current_values=()

  assert_digest_lock "$current_lock"
  for key in POSTGRES_IMAGE POWERSYNC_IMAGE CADDY_IMAGE; do
    current_values[index]="$(image_lock_value "$key")"
    index=$((index + 1))
  done

  assert_digest_lock "$candidate_lock"
  index=0
  for key in POSTGRES_IMAGE POWERSYNC_IMAGE CADDY_IMAGE; do
    [[ "$(image_lock_value "$key")" == "${current_values[index]}" ]] ||
      die "$key infrastructure image changes require a separate maintenance procedure"
    index=$((index + 1))
  done
)

assert_release_directory_binding() {
  local release_source_sha="$1"
  local release_directory="$2"
  local release_run_id

  [[ "$release_source_sha" =~ ^[0-9a-f]{40}$ ]] ||
    die 'deployed release source must be a full 40-character Git commit'
  [[ "$release_directory" == "/opt/emdo/releases/${release_source_sha}-"* ]] ||
    die 'deployed state is not bound to its source release directory'
  release_run_id="${release_directory##*-}"
  [[ "$release_run_id" =~ ^[0-9]{1,20}$ ]] ||
    die 'deployed release directory has no valid workflow run ID'
  [[ "$release_directory" == "/opt/emdo/releases/${release_source_sha}-${release_run_id}" ]] ||
    die 'deployed release directory is malformed'
}

assert_deployed_release_lock() {
  local lock_file="$1"
  local release_directory release_source_sha
  assert_root_owned_bounded_file "$lock_file" 600 32768
  assert_digest_lock "$lock_file"
  release_directory="${IMAGE_LOCK_DEPLOYED_RELEASE_DIR:-}"
  release_source_sha="${IMAGE_LOCK_DEPLOYED_RELEASE_SOURCE_SHA:-$IMAGE_LOCK_SOURCE_SHA}"
  assert_release_directory_binding "$release_source_sha" "$release_directory"
  require_directory "$release_directory"
  assert_governed_parent_chain "$release_directory" /opt/emdo/releases
  require_command find
  [[ -z "$(find "$release_directory" -xdev \( -type l -o ! -user root -o -perm /022 \) -print -quit)" ]] ||
    die 'deployed release contains a symlink, foreign owner, or writable asset'
  assert_root_owned_bounded_file "$release_directory/.archive-sha256" 644 128
  [[ "$(< "$release_directory/.archive-sha256")" =~ ^[0-9a-f]{64}$ ]] ||
    die 'deployed release archive digest record is invalid'
}

export_digest_lock() {
  local key
  for key in "${DIGEST_KEYS[@]}"; do
    printf -v "$key" '%s' "$(image_lock_value "$key")"
    export "${key?}"
  done
}

reset_config_values() {
  local key
  for key in EMDO_DOMAIN ACME_EMAIL POWERSYNC_JWKS_URI SECRETS_DIR STAGING_HTTP_PORT BACKUP_DIR BACKUP_AGE_RECIPIENTS_FILE BACKUP_AGE_IDENTITY_FILE; do
    unset "DEPLOY_CONFIG_$key"
  done
  DEPLOY_CONFIG_SEEN='|'
}

config_value() {
  local variable="DEPLOY_CONFIG_$1"
  printf '%s' "${!variable:-}"
}

is_allowed_config_key() {
  case "$1" in
    EMDO_DOMAIN | ACME_EMAIL | POWERSYNC_JWKS_URI | SECRETS_DIR | STAGING_HTTP_PORT | BACKUP_DIR | BACKUP_AGE_RECIPIENTS_FILE | BACKUP_AGE_IDENTITY_FILE)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

load_deployment_config() {
  local config_file="$1"
  local line key value
  require_regular_file "$config_file"
  if [[ "$config_file" == /etc/emdo/* ]]; then
    assert_root_owned_bounded_file "$config_file" 600 32768
    assert_governed_parent_chain "$(dirname -- "$config_file")" /etc/emdo
  fi
  local variable
  reset_config_values

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || die "malformed deployment config line"
    key="${line%%=*}"
    value="${line#*=}"
    is_allowed_config_key "$key" || die "unexpected deployment config key: $key"
    [[ "$DEPLOY_CONFIG_SEEN" != *"|$key|"* ]] || die "duplicate deployment config key: $key"
    [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] ||
      die "invalid deployment config value for $key"
    variable="DEPLOY_CONFIG_$key"
    printf -v "$variable" '%s' "$value"
    DEPLOY_CONFIG_SEEN="${DEPLOY_CONFIG_SEEN}${key}|"
  done < "$config_file"
}

export_required_config() {
  local key
  for key in EMDO_DOMAIN ACME_EMAIL POWERSYNC_JWKS_URI SECRETS_DIR; do
    [[ -n "$(config_value "$key")" ]] || die "deployment config is missing $key"
    printf -v "$key" '%s' "$(config_value "$key")"
    export "${key?}"
  done
  assert_absolute_scoped_directory "$SECRETS_DIR" SECRETS_DIR
  require_directory "$SECRETS_DIR"
}

assert_root_owned_nonwritable_directory() {
  local path="$1"
  local owner mode numeric_mode
  require_directory "$path"
  owner="$(stat -c '%u' "$path")"
  mode="$(stat -c '%a' "$path")"
  [[ "$owner" == 0 ]] || die "$path must be owned by root"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "$path has an invalid mode"
  numeric_mode=$((8#$mode))
  (( (numeric_mode & 8#022) == 0 )) ||
    die "$path must not be group- or world-writable"
}

assert_governed_parent_chain() {
  local path="$1"
  local boundary="$2"
  local canonical_path canonical_boundary cursor
  require_directory "$path"
  require_directory "$boundary"
  canonical_path="$(cd -- "$path" && pwd -P)"
  canonical_boundary="$(cd -- "$boundary" && pwd -P)"
  [[ "$canonical_path" == "$canonical_boundary" || "$canonical_path" == "$canonical_boundary/"* ]] ||
    die "$path must resolve beneath governed root $canonical_boundary"
  cursor="$canonical_path"
  while true; do
    assert_root_owned_nonwritable_directory "$cursor"
    [[ "$cursor" == "$canonical_boundary" ]] && break
    cursor="$(dirname -- "$cursor")"
  done
}

assert_production_public_config() {
  [[ ${#EMDO_DOMAIN} -le 253 && "$EMDO_DOMAIN" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] ||
    die 'EMDO_DOMAIN must be a plain lowercase public hostname without a scheme, port, path, or wildcard'
  [[ "$ACME_EMAIL" =~ ^[^[:space:]@]+@[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$ ]] ||
    die 'ACME_EMAIL is invalid'
  [[ "$POWERSYNC_JWKS_URI" == "https://$EMDO_DOMAIN/.well-known/jwks.json" ]] ||
    die 'POWERSYNC_JWKS_URI must be the exact HTTPS JWKS route on EMDO_DOMAIN'
}

assert_secret_directory_permissions() {
  local path="$1"
  local mode canonical
  require_directory "$path"
  assert_root_owned_nonwritable_directory "$path"
  mode="$(stat -c '%a' "$path")"
  [[ "$mode" == 700 ]] || die "$path must have mode 0700 (found $mode)"
  canonical="$(cd -- "$path" && pwd -P)"
  case "$canonical" in
    /etc/emdo | /etc/emdo/*)
      assert_governed_parent_chain "$canonical" /etc/emdo
      ;;
    *)
      die "$path is not beneath the governed /etc/emdo secret root"
      ;;
  esac
}

assert_root_owned_bounded_file() {
  local path="$1"
  local expected_mode="$2"
  local maximum_size="$3"
  local mode owner links size
  require_regular_file "$path"
  mode="$(stat -c '%a' "$path")"
  owner="$(stat -c '%u' "$path")"
  links="$(stat -c '%h' "$path")"
  size="$(stat -c '%s' "$path")"
  [[ "$mode" == "$expected_mode" ]] ||
    die "$path must have mode 0$expected_mode (found $mode)"
  [[ "$owner" == 0 ]] || die "$path must be owned by root"
  [[ "$links" == 1 ]] || die "$path must not have additional hard links"
  [[ "$size" =~ ^[1-9][0-9]*$ && "$size" -le "$maximum_size" ]] ||
    die "$path must be nonempty and no larger than $maximum_size bytes"
}

acquire_host_lock() {
  local lock_path="$1"
  local output_variable="$2"
  local lock_fd
  [[ "$output_variable" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] ||
    die 'host lock output variable is invalid'
  require_command flock
  assert_governed_parent_chain "$(dirname -- "$lock_path")" /var/lib/emdo
  assert_root_owned_bounded_file "$lock_path" 600 128
  exec {lock_fd}<>"$lock_path"
  flock --nonblock "$lock_fd" || die "another governed host operation holds $lock_path"
  printf -v "$output_variable" '%s' "$lock_fd"
}

assert_no_active_staging_state() {
  local active
  assert_governed_parent_chain "$STAGING_STATE_ROOT" /var/lib/emdo
  active="$(find "$STAGING_STATE_ROOT" -mindepth 1 -maxdepth 1 -print -quit)"
  [[ -z "$active" ]] ||
    die 'production mutation is not allowed while an isolated staging run is active'
}

assert_secret_file_manifest() {
  local root="$1"
  local filename path canonical_root canonical_parent
  shift
  require_directory "$root"
  canonical_root="$(cd -- "$root" && pwd -P)"

  for filename in "$@"; do
    [[ "$filename" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$ ]] ||
      die 'secret manifest contains an invalid filename'
    path="$root/$filename"
    require_regular_file "$path"
    canonical_parent="$(cd -- "$(dirname -- "$path")" && pwd -P)"
    [[ "$canonical_parent" == "$canonical_root" ]] ||
      die "$path resolves outside its selected secret root"
    assert_root_owned_bounded_file "$path" 600 262144
  done
}

assert_env_file_allowed_keys() {
  local path="$1"
  local line key value allowed='|' seen='|'
  shift
  for key in "$@"; do
    allowed="${allowed}${key}|"
  done
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || die "$path contains a malformed environment line"
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]{1,79}$ && "$allowed" == *"|$key|"* ]] ||
      die "$path contains a non-allowlisted environment key"
    [[ "$seen" != *"|$key|"* ]] || die "$path repeats an environment key"
    [[ -n "$value" && "$value" != *$'\r'* && "$value" != *$'\n'* ]] ||
      die "$path contains an empty or invalid environment value"
    seen="${seen}${key}|"
  done < "$path"
}

env_file_value() {
  local path="$1"
  local requested_key="$2"
  local line key value found=''
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    if [[ "$key" == "$requested_key" ]]; then
      [[ -z "$found" ]] || die "$path repeats required key $requested_key"
      found="$value"
    fi
  done < "$path"
  [[ -n "$found" ]] || die "$path is missing required key $requested_key"
  printf '%s' "$found"
}

assert_internal_postgres_uri() {
  local path="$1"
  local key="$2"
  local expected_login="$3"
  local expected_database="$4"
  local value
  value="$(env_file_value "$path" "$key")"
  [[ "$value" =~ ^postgres(ql)?://${expected_login}:[^/@[:space:]]+@postgres:5432/${expected_database}\?sslmode=disable$ ]] ||
    die "$path key $key must use its exact staging-only login and internal PostgreSQL target"
}

assert_https_origin_value() {
  local path="$1"
  local key="$2"
  local value
  value="$(env_file_value "$path" "$key")"
  [[ ${#value} -le 2048 && "$value" =~ ^https://[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(:[0-9]{2,5})?$ ]] ||
    die "$path key $key must be a credential-free HTTPS origin"
}

assert_edge_proxy_secret_file() {
  assert_env_file_allowed_keys "$1" EMDO_EDGE_PROXY_SECRET
  local edge_proxy_secret
  edge_proxy_secret="$(env_file_value "$1" EMDO_EDGE_PROXY_SECRET)"
  [[ ${#edge_proxy_secret} -ge 43 && ${#edge_proxy_secret} -le 128 && "$edge_proxy_secret" =~ ^[A-Za-z0-9_-]+$ ]] ||
    die "$1 must contain one 43-128 character base64url EMDO_EDGE_PROXY_SECRET"
}

assert_staging_auth_provider_config() {
  local path="$1"
  local provider google_client_id google_client_secret resend_api_key resend_from_email
  provider="$(env_file_value "$path" EMDO_TRANSACTIONAL_EMAIL_PROVIDER)"
  google_client_id="$(env_file_value "$path" EMDO_GOOGLE_IDENTITY_CLIENT_ID)"
  google_client_secret="$(env_file_value "$path" EMDO_GOOGLE_IDENTITY_CLIENT_SECRET)"
  resend_api_key="$(env_file_value "$path" EMDO_RESEND_AUTH_API_KEY)"
  resend_from_email="$(env_file_value "$path" EMDO_RESEND_FROM_EMAIL)"

  [[ "$provider" == resend ]] ||
    die "$path must select the curated staging authentication email provider"
  [[ ${#google_client_id} -ge 20 && ${#google_client_id} -le 512 && "$google_client_id" =~ ^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$ ]] ||
    die "$path contains an invalid staging Google identity client ID"
  [[ ${#google_client_secret} -ge 16 && ${#google_client_secret} -le 512 && "$google_client_secret" =~ ^[^[:space:][:cntrl:]]+$ ]] ||
    die "$path contains an invalid staging Google identity client secret"
  [[ ${#resend_api_key} -ge 23 && ${#resend_api_key} -le 512 && "$resend_api_key" =~ ^re_[A-Za-z0-9_-]+$ ]] ||
    die "$path contains an invalid staging Resend authentication API key"
  [[ ${#resend_from_email} -le 320 && "$resend_from_email" =~ ^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] ||
    die "$path contains an invalid lowercase staging authentication sender"
}

assert_finance_import_retention_config() {
  local path="$1"
  local limit
  assert_env_file_allowed_keys "$path" \
    EMDO_FINANCE_IMPORT_RETENTION_DATABASE_URL \
    EMDO_FINANCE_IMPORT_RETENTION_LIMIT
  assert_internal_postgres_uri "$path" \
    EMDO_FINANCE_IMPORT_RETENTION_DATABASE_URL \
    emdo_finance_import_retention_login emdo_app
  limit="$(env_file_value "$path" EMDO_FINANCE_IMPORT_RETENTION_LIMIT)"
  [[ "$limit" =~ ^[1-9][0-9]{0,3}$ ]] ||
    die "$path retention limit must be an integer from 1 through 1000"
  ((10#$limit <= 1000)) ||
    die "$path retention limit must be an integer from 1 through 1000"
}

assert_google_oauth_disconnect_reconciliation_config() {
  local path="$1"
  local limit
  assert_env_file_allowed_keys "$path" \
    EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_DATABASE_URL \
    EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_LIMIT
  assert_internal_postgres_uri "$path" \
    EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_DATABASE_URL \
    emdo_google_oauth_disconnect_reconciliation_login emdo_app
  limit="$(env_file_value "$path" EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_LIMIT)"
  [[ "$limit" =~ ^[1-9][0-9]{0,2}$ ]] ||
    die "$path reconciliation limit must be an integer from 1 through 100"
  ((10#$limit <= 100)) ||
    die "$path reconciliation limit must be an integer from 1 through 100"
}

assert_base_secret_manifest() {
  assert_secret_file_manifest "$1" "${BASE_SECRET_MANIFEST[@]}"
  assert_edge_proxy_secret_file "$1/edge-proxy.env"
  assert_finance_import_retention_config "$1/finance-import-retention.env"
  assert_google_oauth_disconnect_reconciliation_config \
    "$1/google-oauth-disconnect-reconciliation.env"
}

assert_staging_secret_manifest() {
  assert_secret_file_manifest \
    "$1" \
    "${BASE_SECRET_MANIFEST[@]}" \
    "${STAGING_SECRET_MANIFEST[@]}"
  assert_edge_proxy_secret_file "$1/edge-proxy.env"
  assert_finance_import_retention_config "$1/finance-import-retention.env"
  assert_google_oauth_disconnect_reconciliation_config \
    "$1/google-oauth-disconnect-reconciliation.env"
  assert_env_file_allowed_keys "$1/migration.env" \
    EMDO_MIGRATION_DATABASE_URL EMDO_JOB_MIGRATION_DATABASE_URL
  assert_env_file_allowed_keys "$1/api.env" \
    EMDO_PUBLIC_ORIGIN EMDO_METRICS_TOKEN EMDO_API_DATABASE_URL \
    EMDO_AUTH_DATABASE_URL EMDO_ONBOARDING_DATABASE_URL \
    EMDO_VISUAL_DECISION_DATABASE_URL \
    EMDO_API_AUTH_SECRET EMDO_SESSION_SECRET EMDO_SYNC_JWT_KEYRING_B64URL \
    EMDO_EXPERIENCE_CURSOR_HMAC_KEYRING_B64URL \
    EMDO_PROPOSAL_CURSOR_HMAC_KEYRING_B64URL \
    EMDO_VISUAL_PROOF_HMAC_KEYRING_B64URL \
    EMDO_INVITATION_DELIVERY_KEY_ID \
    EMDO_INVITATION_DELIVERY_PUBLIC_KEY_SPKI_BASE64URL \
    EMDO_GOOGLE_IDENTITY_CLIENT_ID EMDO_GOOGLE_IDENTITY_CLIENT_SECRET \
    EMDO_TRANSACTIONAL_EMAIL_PROVIDER EMDO_RESEND_AUTH_API_KEY \
    EMDO_RESEND_FROM_EMAIL
  assert_env_file_allowed_keys "$1/worker.env" \
    EMDO_WORKER_DATABASE_URL EMDO_WORKER_EXECUTOR_DATABASE_URL \
    EMDO_WORKER_DISPATCHER_DATABASE_URL \
    EMDO_AUDIO_RECONCILIATION_DATABASE_URL EMDO_APPLICATION_ORIGIN \
    EMDO_WORKER_DISPATCHER_ID EMDO_WORKER_OUTBOX_POLL_MS \
    EMDO_WORKER_OUTBOX_BATCH_LIMIT EMDO_WORKER_OUTBOX_LEASE_MS
  assert_env_file_allowed_keys "$1/powersync.env" \
    PS_EMDO_APPLICATION_DATABASE_URI PS_EMDO_BUCKET_DATABASE_URI
  assert_env_file_allowed_keys "$1/synthetic.env" \
    EMDO_SYNTHETIC_OWNER_EMAIL EMDO_SYNTHETIC_OWNER_PASSWORD \
    EMDO_SYNTHETIC_CLIENT_ID EMDO_STAGING_API_ORIGIN EMDO_PUBLIC_ORIGIN
  assert_env_file_allowed_keys "$1/synthetic-bootstrap.env" \
    EMDO_BOOTSTRAP_DATABASE_URL EMDO_BOOTSTRAP_HOUSEHOLD_NAME \
    EMDO_BOOTSTRAP_HOUSEHOLD_SLUG EMDO_BOOTSTRAP_OWNER_NAME

  assert_internal_postgres_uri "$1/migration.env" \
    EMDO_MIGRATION_DATABASE_URL postgres emdo_app
  assert_internal_postgres_uri "$1/migration.env" \
    EMDO_JOB_MIGRATION_DATABASE_URL postgres emdo_app
  assert_internal_postgres_uri "$1/api.env" \
    EMDO_API_DATABASE_URL emdo_api_login emdo_app
  assert_internal_postgres_uri "$1/api.env" \
    EMDO_AUTH_DATABASE_URL emdo_auth_login emdo_app
  assert_internal_postgres_uri "$1/api.env" \
    EMDO_ONBOARDING_DATABASE_URL emdo_onboarding_login emdo_app
  assert_internal_postgres_uri "$1/api.env" \
    EMDO_VISUAL_DECISION_DATABASE_URL emdo_visual_decision_login emdo_app
  assert_staging_auth_provider_config "$1/api.env"
  assert_internal_postgres_uri "$1/worker.env" \
    EMDO_WORKER_DATABASE_URL emdo_worker_login emdo_app
  assert_internal_postgres_uri "$1/worker.env" \
    EMDO_WORKER_EXECUTOR_DATABASE_URL emdo_worker_executor_login emdo_app
  assert_internal_postgres_uri "$1/worker.env" \
    EMDO_WORKER_DISPATCHER_DATABASE_URL emdo_worker_dispatcher_login emdo_app
  assert_internal_postgres_uri "$1/worker.env" \
    EMDO_AUDIO_RECONCILIATION_DATABASE_URL \
    emdo_audio_reconciliation_login emdo_app
  assert_internal_postgres_uri "$1/powersync.env" \
    PS_EMDO_APPLICATION_DATABASE_URI emdo_powersync_replication emdo_app
  assert_internal_postgres_uri "$1/powersync.env" \
    PS_EMDO_BUCKET_DATABASE_URI emdo_powersync_storage emdo_powersync
  assert_internal_postgres_uri "$1/synthetic-bootstrap.env" \
    EMDO_BOOTSTRAP_DATABASE_URL emdo_owner_bootstrap_login emdo_app
  [[ "$(env_file_value "$1/synthetic.env" EMDO_STAGING_API_ORIGIN)" == http://127.0.0.1:3000 ]] ||
    die 'synthetic staging must call only the API network-namespace loopback origin'
  assert_https_origin_value "$1/api.env" EMDO_PUBLIC_ORIGIN
  assert_https_origin_value "$1/worker.env" EMDO_APPLICATION_ORIGIN
  assert_https_origin_value "$1/synthetic.env" EMDO_PUBLIC_ORIGIN
}

assert_isolated_project_absent() {
  local project_name="$1"
  local namespace="$2"
  local resource resource_name existing_containers existing_resources
  assert_safe_identifier "$project_name" COMPOSE_PROJECT_NAME
  assert_safe_identifier "$namespace" DEPLOYMENT_NAMESPACE

  existing_containers="$(docker ps --all --quiet --filter "label=com.docker.compose.project=$project_name")" ||
    die 'could not inspect Docker containers while proving project absence'
  [[ -z "$existing_containers" ]] ||
    die "isolated project $project_name already has containers"

  for resource in postgres caddy-data caddy-config; do
    resource_name="emdo-$namespace-$resource"
    existing_resources="$(docker volume ls --quiet --filter "name=^${resource_name}$")" ||
      die 'could not inspect Docker volumes while proving project absence'
    [[ -z "$existing_resources" ]] ||
      die "isolated project $project_name already has volume $resource_name"
  done
  for resource in edge egress auth-egress backend; do
    resource_name="emdo-$namespace-$resource"
    existing_resources="$(docker network ls --quiet --filter "name=^${resource_name}$")" ||
      die 'could not inspect Docker networks while proving project absence'
    [[ -z "$existing_resources" ]] ||
      die "isolated project $project_name already has network $resource_name"
  done
}

production_compose() {
  docker compose \
    --project-name emdo-production \
    --file "$COMPOSE_DIR/compose.yml" \
    "$@"
}

staging_compose() {
  docker compose \
    --project-name "$COMPOSE_PROJECT_NAME" \
    --file "$COMPOSE_DIR/compose.yml" \
    --file "$COMPOSE_DIR/compose.staging.yml" \
    "$@"
}

expected_image_for_service() {
  case "$1" in
    postgres) printf '%s' "${POSTGRES_IMAGE:-}" ;;
    api) printf '%s' "${API_IMAGE:-}" ;;
    worker) printf '%s' "${WORKER_IMAGE:-}" ;;
    web) printf '%s' "${WEB_IMAGE:-}" ;;
    powersync) printf '%s' "${POWERSYNC_IMAGE:-}" ;;
    caddy) printf '%s' "${CADDY_IMAGE:-}" ;;
    *) die "no governed image is defined for service $1" ;;
  esac
}

assert_compose_healthy() {
  local compose_function="$1"
  local service container_id status health configured_image expected_image
  local services=(postgres api worker web powersync caddy)

  for service in "${services[@]}"; do
    container_id="$($compose_function ps --quiet "$service")"
    [[ -n "$container_id" ]] || die "$service has no running container"
    status="$(docker inspect --format '{{.State.Status}}' "$container_id")"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")"
    configured_image="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
    expected_image="$(expected_image_for_service "$service")"
    [[ -n "$expected_image" && "$configured_image" == "$expected_image" ]] ||
      die "$service is not running its governed image reference"
    [[ "$status" == running && "$health" == healthy ]] ||
      die "$service is not healthy (status=$status health=$health)"
  done
}

wait_for_compose_healthy() {
  local compose_function="$1"
  local timeout_seconds="${2:-300}"
  local deadline=$((SECONDS + timeout_seconds))

  until "$compose_function" ps --status running --services | grep -qx caddy; do
    ((SECONDS < deadline)) || die "containers did not reach running state"
    sleep 5
  done

  while ! (assert_compose_healthy "$compose_function" 2>/dev/null); do
    ((SECONDS < deadline)) || {
      "$compose_function" ps >&2 || true
      die "containers did not become healthy within ${timeout_seconds}s"
    }
    sleep 5
  done
  assert_compose_healthy "$compose_function"
}

assert_production_healthy() {
  (
    local current_lock="$PRODUCTION_STATE_DIR/current.env"
    assert_deployed_release_lock "$current_lock"
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
    assert_compose_healthy production_compose
  )
}

assert_initial_production_absent() {
  local state_entry=''

  if [[ -L "$PRODUCTION_STATE_DIR" ]]; then
    die 'initial deployment is not permitted when the production state path is a symlink'
  fi
  if [[ -e "$PRODUCTION_STATE_DIR" && ! -d "$PRODUCTION_STATE_DIR" ]]; then
    die 'initial deployment is not permitted when the production state path is not a directory'
  fi
  if [[ -d "$PRODUCTION_STATE_DIR" ]]; then
    assert_governed_parent_chain "$PRODUCTION_STATE_DIR" /var/lib/emdo
    require_command find
    state_entry="$(find "$PRODUCTION_STATE_DIR" -mindepth 1 -maxdepth 1 -print -quit)"
    [[ -z "$state_entry" ]] ||
      die 'initial deployment is not permitted after production state exists'
  fi

  assert_isolated_project_absent emdo-production production
}

assert_initial_bootstrap_policy() {
  local requested="$1"
  local acknowledged="$2"
  local attested="$3"
  local current_present="$4"
  local value

  for value in "$requested" "$acknowledged" "$attested" "$current_present"; do
    [[ "$value" == true || "$value" == false ]] ||
      die 'initial deployment policy inputs must be true or false'
  done

  if [[ "$current_present" == true ]]; then
    [[ "$requested" == false && "$acknowledged" == false && "$attested" == false ]] ||
      die 'initial deployment bootstrap is not permitted after production exists'
    return 0
  fi

  [[ "$requested" == true && "$acknowledged" == true && "$attested" == true ]] ||
    die 'the first deployment requires all three explicit assertions: request, staging attestation, and production acknowledgment'
}

assert_staging_attestation_matches() {
  local candidate_lock="$1"
  local attestation_file="$2"
  local key index=0
  local candidate=()
  local candidate_initial_bootstrap

  assert_digest_lock "$candidate_lock"
  candidate_initial_bootstrap="${IMAGE_LOCK_INITIAL_DEPLOYMENT_BOOTSTRAP:-}"
  [[ "$candidate_initial_bootstrap" == true || "$candidate_initial_bootstrap" == false ]] ||
    die 'candidate lock has no valid initial deployment assertion'
  for key in "${DIGEST_KEYS[@]}"; do
    candidate[index]="$(image_lock_value "$key")"
    index=$((index + 1))
  done

  assert_digest_lock "$attestation_file"
  [[ "${IMAGE_LOCK_STAGING_TESTED:-}" == true ]] ||
    die "staging attestation is not marked tested"
  [[ "${IMAGE_LOCK_STAGING_RUN_ID:-}" =~ ^[0-9]{1,20}$ ]] ||
    die "staging attestation has no valid run ID"
  [[ "${IMAGE_LOCK_STAGING_WORKFLOW_RUN_ID:-}" =~ ^[0-9]{1,20}$ ]] ||
    die "staging attestation has no valid workflow run ID"
  [[ "${IMAGE_LOCK_STAGING_RUN_ID}" == "${IMAGE_LOCK_STAGING_WORKFLOW_RUN_ID}" ]] ||
    die 'staging attestation run identities do not match'
  [[ "${IMAGE_LOCK_STAGING_TESTED_AT:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] ||
    die "staging attestation has no test timestamp"
  [[ "${IMAGE_LOCK_STAGING_INFRA_ARCHIVE_SHA256:-}" =~ ^[0-9a-f]{64}$ && "${IMAGE_LOCK_STAGING_INFRA_ARCHIVE_SHA256}" != "$(printf '0%.0s' {1..64})" ]] ||
    die 'staging attestation has no valid infrastructure archive digest'
  [[ "${IMAGE_LOCK_INITIAL_DEPLOYMENT_BOOTSTRAP:-}" == true || "${IMAGE_LOCK_INITIAL_DEPLOYMENT_BOOTSTRAP:-}" == false ]] ||
    die 'staging attestation has no valid initial deployment assertion'
  [[ "${IMAGE_LOCK_ACCEPTANCE_EVIDENCE_SHA256:-}" =~ ^[0-9a-f]{64}$ && "${IMAGE_LOCK_ACCEPTANCE_EVIDENCE_SHA256}" != "$(printf '0%.0s' {1..64})" ]] ||
    die 'staging attestation has no valid acceptance evidence digest'
  [[ "${IMAGE_LOCK_ACCEPTANCE_EVIDENCE_RUN_ID:-}" =~ ^[0-9]{1,20}$ ]] ||
    die 'staging attestation has no valid acceptance evidence run ID'
  [[ "${IMAGE_LOCK_ACCEPTANCE_CI_RUN_ID:-}" =~ ^[0-9]{1,20}$ ]] ||
    die 'staging attestation has no valid acceptance CI run ID'
  [[ "${IMAGE_LOCK_ACCEPTANCE_EVIDENCE_RUN_ID}" == "${IMAGE_LOCK_STAGING_WORKFLOW_RUN_ID}" ]] ||
    die 'acceptance evidence is not bound to the staging workflow run'
  [[ "${IMAGE_LOCK_INITIAL_DEPLOYMENT_BOOTSTRAP}" == "$candidate_initial_bootstrap" ]] ||
    die 'staging attestation does not match the initial deployment assertion'

  index=0
  for key in "${DIGEST_KEYS[@]}"; do
    [[ "$(image_lock_value "$key")" == "${candidate[index]}" ]] ||
      die "staging attestation does not match $key"
    index=$((index + 1))
  done
}

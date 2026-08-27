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
readonly FINANCE_STAGING_MARKER_FILE="finance-synthetic-staging.env"
readonly FINANCE_STAGING_SECRET_DIR="finance-secrets"
readonly FINANCE_STAGING_DOCUMENT_STORE_DIRNAME="finance-documents"
readonly FINANCE_STAGING_RESTORE_VERIFIER_INPUT_NAME="finance-staging-restore-verifier-input.env"
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
  google_oauth_disconnect_retention_database_password
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
  google-oauth-disconnect-retention.env
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

env_file_has_key() {
  local path="$1"
  local requested_key="$2"
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "${line%%=*}" == "$requested_key" ]] && return 0
  done < "$path"
  return 1
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
  local key
  for key in \
    EMDO_GOOGLE_IDENTITY_CLIENT_ID \
    EMDO_GOOGLE_IDENTITY_CLIENT_SECRET \
    EMDO_ONBOARDING_DATABASE_URL \
    EMDO_RESEND_AUTH_API_KEY \
    EMDO_RESEND_FROM_EMAIL \
    EMDO_TRANSACTIONAL_EMAIL_PROVIDER; do
    if env_file_has_key "$path" "$key"; then
      die "$path must omit unavailable optional authentication provider key $key"
    fi
  done
}

assert_production_api_environment() {
  local path="$1"
  local key configured=0 api_key speech_model pricing
  assert_env_file_allowed_keys "$path" \
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
    EMDO_RESEND_FROM_EMAIL \
    EMDO_GOOGLE_CALENDAR_OAUTH_CLIENT_ID \
    EMDO_GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET \
    EMDO_GOOGLE_CALENDAR_OAUTH_STATE_SIGNING_KEY_B64URL \
    EMDO_GOOGLE_CALENDAR_VAULT_KEYRING_B64URL \
    EMDO_OPENAI_AUDIO_API_KEY EMDO_OPENAI_SPEECH_MODEL \
    EMDO_OPENAI_AUDIO_PRICING_B64URL

  for key in \
    EMDO_OPENAI_AUDIO_API_KEY \
    EMDO_OPENAI_SPEECH_MODEL \
    EMDO_OPENAI_AUDIO_PRICING_B64URL; do
    if env_file_has_key "$path" "$key"; then
      configured=$((configured + 1))
    fi
  done
  ((configured == 0)) && return 0
  ((configured == 3)) ||
    die "$path must configure all OpenAI audio settings together"

  api_key="$(env_file_value "$path" EMDO_OPENAI_AUDIO_API_KEY)"
  speech_model="$(env_file_value "$path" EMDO_OPENAI_SPEECH_MODEL)"
  pricing="$(env_file_value "$path" EMDO_OPENAI_AUDIO_PRICING_B64URL)"
  [[ ${#api_key} -ge 16 && ${#api_key} -le 512 && "$api_key" =~ ^[A-Za-z0-9_-]+$ ]] ||
    die "$path contains an invalid OpenAI audio API key"
  case "$speech_model" in
    tts-1 | tts-1-hd | gpt-4o-mini-tts | gpt-4o-mini-tts-2025-12-15) ;;
    *) die "$path contains an unsupported OpenAI speech model" ;;
  esac
  [[ ${#pricing} -ge 1 && ${#pricing} -le 32768 && "$pricing" =~ ^[A-Za-z0-9_-]+$ ]] ||
    die "$path contains an invalid OpenAI audio pricing envelope"
}

assert_staging_api_environment() {
  local path="$1"
  assert_env_file_allowed_keys "$path" \
    EMDO_PUBLIC_ORIGIN EMDO_METRICS_TOKEN EMDO_API_DATABASE_URL \
    EMDO_AUTH_DATABASE_URL EMDO_ONBOARDING_DATABASE_URL \
    EMDO_VISUAL_DECISION_DATABASE_URL \
    EMDO_API_AUTH_SECRET EMDO_SESSION_SECRET EMDO_SYNC_JWT_KEYRING_B64URL \
    EMDO_EXPERIENCE_CURSOR_HMAC_KEYRING_B64URL \
    EMDO_PROPOSAL_CURSOR_HMAC_KEYRING_B64URL \
    EMDO_VISUAL_PROOF_HMAC_KEYRING_B64URL \
    EMDO_INVITATION_DELIVERY_KEY_ID \
    EMDO_INVITATION_DELIVERY_PUBLIC_KEY_SPKI_BASE64URL
  assert_internal_postgres_uri "$path" \
    EMDO_API_DATABASE_URL emdo_api_login emdo_app
  assert_internal_postgres_uri "$path" \
    EMDO_AUTH_DATABASE_URL emdo_auth_login emdo_app
  assert_internal_postgres_uri "$path" \
    EMDO_VISUAL_DECISION_DATABASE_URL emdo_visual_decision_login emdo_app
  if env_file_has_key "$path" EMDO_ONBOARDING_DATABASE_URL; then
    assert_internal_postgres_uri "$path" \
      EMDO_ONBOARDING_DATABASE_URL emdo_onboarding_login emdo_app
  fi
  env_file_value "$path" EMDO_API_AUTH_SECRET >/dev/null
  env_file_value "$path" EMDO_SESSION_SECRET >/dev/null
  env_file_value \
    "$path" EMDO_EXPERIENCE_CURSOR_HMAC_KEYRING_B64URL >/dev/null
  assert_staging_auth_provider_config "$path"
  assert_https_origin_value "$path" EMDO_PUBLIC_ORIGIN
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

assert_google_oauth_disconnect_retention_config() {
  local path="$1"
  local limit
  assert_env_file_allowed_keys "$path" \
    EMDO_GOOGLE_OAUTH_DISCONNECT_RETENTION_DATABASE_URL \
    EMDO_GOOGLE_OAUTH_DISCONNECT_RETENTION_LIMIT
  assert_internal_postgres_uri "$path" \
    EMDO_GOOGLE_OAUTH_DISCONNECT_RETENTION_DATABASE_URL \
    emdo_google_oauth_disconnect_retention_login emdo_app
  limit="$(env_file_value "$path" EMDO_GOOGLE_OAUTH_DISCONNECT_RETENTION_LIMIT)"
  [[ "$limit" =~ ^[1-9][0-9]{0,2}$ ]] ||
    die "$path retention limit must be an integer from 1 through 100"
  ((10#$limit <= 100)) ||
    die "$path retention limit must be an integer from 1 through 100"
}

assert_base_secret_manifest() {
  assert_secret_file_manifest "$1" "${BASE_SECRET_MANIFEST[@]}"
  assert_edge_proxy_secret_file "$1/edge-proxy.env"
  assert_production_api_environment "$1/api.env"
  assert_finance_import_retention_config "$1/finance-import-retention.env"
  assert_google_oauth_disconnect_reconciliation_config \
    "$1/google-oauth-disconnect-reconciliation.env"
  assert_google_oauth_disconnect_retention_config \
    "$1/google-oauth-disconnect-retention.env"
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
  assert_google_oauth_disconnect_retention_config \
    "$1/google-oauth-disconnect-retention.env"
  assert_env_file_allowed_keys "$1/migration.env" \
    EMDO_MIGRATION_DATABASE_URL EMDO_JOB_MIGRATION_DATABASE_URL
  assert_staging_api_environment "$1/api.env"
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
  assert_https_origin_value "$1/worker.env" EMDO_APPLICATION_ORIGIN
  assert_https_origin_value "$1/synthetic.env" EMDO_PUBLIC_ORIGIN
}

assert_finance_synthetic_staging_flag() {
  case "$1" in
    true | false) ;;
    *) die 'FINANCE_SYNTHETIC_STAGING must be true or false' ;;
  esac
}

finance_staging_database_url() {
  local password_file="$1"
  local database_login="$2"
  local purpose="$3"
  local password=''

  case "$database_login:$purpose" in
    'emdo_onboarding_login:Finance staging onboarding' | \
      'emdo_workflow_login:Finance staging workflow') ;;
    *) die 'Finance staging database authority is invalid' ;;
  esac
  assert_root_owned_bounded_file "$password_file" 600 513
  if LC_ALL=C grep -q '[^A-Za-z0-9_-]' "$password_file"; then
    die "$purpose password file must contain one 16-512 character base64url line"
  fi
  LC_ALL=C awk '
    NR != 1 || length($0) < 16 || length($0) > 512 ||
      $0 !~ /^[A-Za-z0-9_-]+$/ { invalid=1; exit }
    END { exit !(NR == 1 && !invalid) }
  ' "$password_file" >/dev/null ||
    die "$purpose password file must contain one 16-512 character base64url line"
  IFS= read -r password < "$password_file" || [[ -n "$password" ]]
  [[ ${#password} -ge 16 && ${#password} -le 512 && "$password" =~ ^[A-Za-z0-9_-]+$ ]] ||
    die "$purpose password file must contain one 16-512 character base64url line"
  printf 'postgresql://%s:%s@postgres:5432/emdo_app?sslmode=disable' \
    "$database_login" "$password"
  password=''
}

finance_staging_onboarding_database_url() {
  finance_staging_database_url \
    "$1" emdo_onboarding_login 'Finance staging onboarding'
}

finance_staging_workflow_database_url() {
  finance_staging_database_url \
    "$1" emdo_workflow_login 'Finance staging workflow'
}

finance_staging_hmac_keyring() {
  local key_id="$1"
  local secret='' keyring=''

  [[ "$key_id" =~ ^finance-(approval-checkpoint|visual-proof|proposal-cursor)\.current-1$ ]] ||
    die 'Finance staging HMAC key ID is invalid'
  secret="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  keyring="$(printf '%s' \
    "{\"schemaVersion\":1,\"current\":{\"keyId\":\"$key_id\",\"keyB64url\":\"$secret\"},\"previous\":[]}" |
    openssl base64 -A | tr '+/' '-_' | tr -d '=\n')"
  [[ ${#secret} == 43 && ${#keyring} -le 8192 ]] ||
    die 'could not generate Finance staging HMAC keyring material'
  printf '%s' "$keyring"
  secret=''
  keyring=''
}

finance_staging_base64url_padded() {
  local value="$1"
  local remainder=$(( ${#value} % 4 ))

  printf '%s' "$value" | tr -- '-_' '+/'
  case "$remainder" in
    0) ;;
    2) printf '==' ;;
    3) printf '=' ;;
    *) die 'Finance staging base64url value has an impossible length' ;;
  esac
}

assert_finance_staging_hmac_keyring() {
  local value="$1"
  local expected_key_id="$2"
  local decoded='' canonical=''

  [[ ${#value} -ge 1 && ${#value} -le 8192 && "$value" =~ ^[A-Za-z0-9_-]+$ ]] ||
    die 'Finance staging HMAC keyring is not canonical base64url'
  decoded="$(finance_staging_base64url_padded "$value" | openssl base64 -d -A)" ||
    die 'Finance staging HMAC keyring is not decodable'
  canonical="$(printf '%s' "$decoded" | openssl base64 -A | tr '+/' '-_' | tr -d '=\n')"
  [[ "$canonical" == "$value" ]] ||
    die 'Finance staging HMAC keyring is not canonical base64url'
  [[ "$decoded" =~ ^\{\"schemaVersion\":1,\"current\":\{\"keyId\":\"${expected_key_id}\",\"keyB64url\":\"[A-Za-z0-9_-]{43}\"\},\"previous\":\[\]\}$ ]] ||
    die 'Finance staging HMAC keyring has an invalid exact shape'
  decoded=''
  canonical=''
}

finance_staging_invitation_delivery_public_key() {
  local public_key=''

  public_key="$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null |
    openssl pkey -pubout -outform DER 2>/dev/null |
    openssl base64 -A | tr '+/' '-_' | tr -d '=\n')"
  [[ ${#public_key} -ge 1 && ${#public_key} -le 16384 &&
    "$public_key" =~ ^[A-Za-z0-9_-]+$ ]] ||
    die 'could not generate Finance staging invitation delivery public key'
  printf '%s' "$public_key"
  public_key=''
}

assert_finance_staging_invitation_delivery_public_key() {
  local value="$1"
  local canonical=''

  [[ ${#value} -ge 1 && ${#value} -le 16384 && "$value" =~ ^[A-Za-z0-9_-]+$ ]] ||
    die 'Finance staging invitation delivery public key is not canonical base64url'
  canonical="$(finance_staging_base64url_padded "$value" |
    openssl base64 -d -A |
    openssl base64 -A | tr '+/' '-_' | tr -d '=\n')" ||
    die 'Finance staging invitation delivery public key is not decodable'
  [[ "$canonical" == "$value" ]] ||
    die 'Finance staging invitation delivery public key is not canonical base64url'
  finance_staging_base64url_padded "$value" |
    openssl base64 -d -A |
    openssl rsa -pubin -inform DER -noout >/dev/null 2>&1 ||
    die 'Finance staging invitation delivery public key is not an RSA public key'
  canonical=''
}

finance_staging_marker_is_valid() {
  local state_dir="$1"
  local marker="$state_dir/$FINANCE_STAGING_MARKER_FILE"
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  [[ "$(stat -c '%u:%a:%h' "$marker")" == '0:600:1' ]] || return 1
  [[ "$(< "$marker")" == 'FINANCE_SYNTHETIC_STAGING=true' ]]
}

assert_finance_staging_api_environment() {
  local path="$1"
  local keyring review_key approval_keyring visual_proof_keyring
  local proposal_cursor_keyring invitation_key_id invitation_public_key
  assert_env_file_allowed_keys "$path" \
    EMDO_FINANCE_DOCUMENTS_ENABLED \
    EMDO_FINANCE_DOCUMENT_KEYRING_B64URL \
    EMDO_FINANCE_DOCUMENT_REVIEW_HMAC_KEY_B64URL \
    EMDO_ONBOARDING_DATABASE_URL EMDO_WORKFLOW_DATABASE_URL \
    EMDO_APPROVAL_CHECKPOINT_KEYRING_B64URL \
    EMDO_VISUAL_PROOF_HMAC_KEYRING_B64URL \
    EMDO_PROPOSAL_CURSOR_HMAC_KEYRING_B64URL \
    EMDO_INVITATION_DELIVERY_KEY_ID \
    EMDO_INVITATION_DELIVERY_PUBLIC_KEY_SPKI_BASE64URL
  [[ "$(env_file_value "$path" EMDO_FINANCE_DOCUMENTS_ENABLED)" == true ]] ||
    die "$path must enable Finance documents"
  assert_internal_postgres_uri "$path" \
    EMDO_ONBOARDING_DATABASE_URL emdo_onboarding_login emdo_app
  assert_internal_postgres_uri "$path" \
    EMDO_WORKFLOW_DATABASE_URL emdo_workflow_login emdo_app
  keyring="$(env_file_value "$path" EMDO_FINANCE_DOCUMENT_KEYRING_B64URL)"
  review_key="$(env_file_value "$path" EMDO_FINANCE_DOCUMENT_REVIEW_HMAC_KEY_B64URL)"
  approval_keyring="$(env_file_value "$path" EMDO_APPROVAL_CHECKPOINT_KEYRING_B64URL)"
  visual_proof_keyring="$(env_file_value "$path" EMDO_VISUAL_PROOF_HMAC_KEYRING_B64URL)"
  proposal_cursor_keyring="$(env_file_value "$path" EMDO_PROPOSAL_CURSOR_HMAC_KEYRING_B64URL)"
  invitation_key_id="$(env_file_value "$path" EMDO_INVITATION_DELIVERY_KEY_ID)"
  invitation_public_key="$(env_file_value "$path" EMDO_INVITATION_DELIVERY_PUBLIC_KEY_SPKI_BASE64URL)"
  [[ ${#keyring} -le 8192 && "$keyring" =~ ^[A-Za-z0-9_-]+$ ]] ||
    die "$path contains an invalid Finance document keyring"
  [[ ${#review_key} == 43 && "$review_key" =~ ^[A-Za-z0-9_-]+$ ]] ||
    die "$path contains an invalid Finance document review key"
  assert_finance_staging_hmac_keyring \
    "$approval_keyring" finance-approval-checkpoint.current-1
  assert_finance_staging_hmac_keyring \
    "$visual_proof_keyring" finance-visual-proof.current-1
  assert_finance_staging_hmac_keyring \
    "$proposal_cursor_keyring" finance-proposal-cursor.current-1
  [[ "$invitation_key_id" =~ ^finance-staging-[0-9]{1,20}-invitation-delivery$ ]] ||
    die "$path contains an invalid Finance staging invitation delivery key ID"
  assert_finance_staging_invitation_delivery_public_key "$invitation_public_key"
}

assert_finance_staging_extraction_environment() {
  local path="$1"
  local keyring api_key
  assert_env_file_allowed_keys "$path" \
    EMDO_FINANCE_DOCUMENTS_ENABLED \
    EMDO_WORKER_EXECUTOR_DATABASE_URL \
    EMDO_FINANCE_DOCUMENT_KEYRING_B64URL \
    EMDO_OPENAI_FINANCE_API_KEY
  [[ "$(env_file_value "$path" EMDO_FINANCE_DOCUMENTS_ENABLED)" == true ]] ||
    die "$path must enable Finance documents"
  assert_internal_postgres_uri "$path" \
    EMDO_WORKER_EXECUTOR_DATABASE_URL emdo_worker_executor_login emdo_app
  keyring="$(env_file_value "$path" EMDO_FINANCE_DOCUMENT_KEYRING_B64URL)"
  api_key="$(env_file_value "$path" EMDO_OPENAI_FINANCE_API_KEY)"
  [[ ${#keyring} -le 8192 && "$keyring" =~ ^[A-Za-z0-9_-]+$ ]] ||
    die "$path contains an invalid Finance document keyring"
  [[ ${#api_key} -ge 16 && ${#api_key} -le 512 && "$api_key" =~ ^[A-Za-z0-9_-]+$ ]] ||
    die "$path contains an invalid Finance OpenAI API key"
}

finance_staging_restore_verifier_input_path() {
  local state_dir="$1"

  [[ "$state_dir" == "$STAGING_STATE_ROOT/"* ]] ||
    die 'Finance restore verifier handoff state path is invalid'
  printf '%s' \
    "$state_dir/$FINANCE_STAGING_SECRET_DIR/$FINANCE_STAGING_RESTORE_VERIFIER_INPUT_NAME"
}

assert_finance_restore_verifier_handoff_path() {
  local state_dir="$1" path owner_uid owner_gid mode links bytes

  path="$(finance_staging_restore_verifier_input_path "$state_dir")"
  require_regular_file "$path"
  [[ ! -L "$path" ]] || die 'Finance restore verifier handoff must not be a symlink'
  read -r owner_uid owner_gid mode links bytes < <(stat -c '%u %g %a %h %s' "$path")
  [[ "$mode" == 600 && "$links" == 1 ]] ||
    die 'Finance restore verifier handoff mode or link count is unsafe'
  case "$owner_uid:$owner_gid" in
    10001:10001 | 0:0) ;;
    *) die 'Finance restore verifier handoff owner is unsafe' ;;
  esac
  if ! [[ "$bytes" =~ ^[0-9]+$ ]] || ((10#$bytes > 16384)); then
    die 'Finance restore verifier handoff size is unsafe'
  fi
}

assert_finance_restore_verifier_handoff_empty() {
  local state_dir="$1" path owner_uid owner_gid mode links bytes

  path="$(finance_staging_restore_verifier_input_path "$state_dir")"
  assert_finance_restore_verifier_handoff_path "$state_dir"
  read -r owner_uid owner_gid mode links bytes < <(stat -c '%u %g %a %h %s' "$path")
  [[ "$owner_uid:$owner_gid:$mode:$links:$bytes" == '10001:10001:600:1:0' ]] ||
    die 'Finance restore verifier handoff was not left as its pre-created empty file'
}

assert_finance_restore_verifier_handoff_payload() {
  local path="$1" line key value
  local schema='' source_sha='' workflow_run_id='' document_id=''
  local evidence_id='' expected_plaintext_sha256='' owner_cookie=''
  local member_cookie='' seen='|'

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *=* ]] ||
      die 'Finance restore verifier handoff contains a malformed line'
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      schema | source_sha | workflow_run_id | document_id | evidence_id | expected_plaintext_sha256 | owner_cookie | member_cookie) ;;
      *) die 'Finance restore verifier handoff contains an unexpected key' ;;
    esac
    [[ -n "$value" && "$seen" != *"|$key|"* ]] ||
      die 'Finance restore verifier handoff contains an empty or duplicate value'
    seen="${seen}${key}|"
    case "$key" in
      schema) schema="$value" ;;
      source_sha) source_sha="$value" ;;
      workflow_run_id) workflow_run_id="$value" ;;
      document_id) document_id="$value" ;;
      evidence_id) evidence_id="$value" ;;
      expected_plaintext_sha256) expected_plaintext_sha256="$value" ;;
      owner_cookie) owner_cookie="$value" ;;
      member_cookie) member_cookie="$value" ;;
    esac
  done < "$path"

  [[ "$seen" == '|schema|source_sha|workflow_run_id|document_id|evidence_id|expected_plaintext_sha256|owner_cookie|member_cookie|' ]] ||
    die 'Finance restore verifier handoff does not contain the exact required keys'
  [[ "$schema" == emdo-finance-staging-restore-verifier-input-v1 ]] ||
    die 'Finance restore verifier handoff schema is unsupported'
  [[ "$source_sha" == "${IMAGE_LOCK_SOURCE_SHA:-}" ]] ||
    die 'Finance restore verifier handoff source SHA does not bind this staging run'
  [[ "$workflow_run_id" == "${STAGING_RUN_ID:-}" ]] ||
    die 'Finance restore verifier handoff workflow run ID does not bind this staging run'
  [[ "$document_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    die 'Finance restore verifier handoff document ID is invalid'
  [[ "$evidence_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    die 'Finance restore verifier handoff evidence ID is invalid'
  [[ "$expected_plaintext_sha256" =~ ^[0-9a-f]{64}$ ]] ||
    die 'Finance restore verifier handoff plaintext digest is invalid'
  [[ "$owner_cookie" =~ ^[A-Za-z0-9_.-]+=[A-Za-z0-9_.=-]+(\;\ [A-Za-z0-9_.-]+=[A-Za-z0-9_.=-]+)*$ ]] ||
    die 'Finance restore verifier handoff owner session is invalid'
  [[ "$member_cookie" =~ ^[A-Za-z0-9_.-]+=[A-Za-z0-9_.=-]+(\;\ [A-Za-z0-9_.-]+=[A-Za-z0-9_.=-]+)*$ ]] ||
    die 'Finance restore verifier handoff member session is invalid'
  [[ "$owner_cookie" != "$member_cookie" ]] ||
    die 'Finance restore verifier handoff requires distinct sessions'
}

claim_finance_restore_verifier_handoff() {
  local state_dir="$1" path owner_uid owner_gid mode links bytes

  path="$(finance_staging_restore_verifier_input_path "$state_dir")"
  assert_finance_restore_verifier_handoff_path "$state_dir"
  read -r owner_uid owner_gid mode links bytes < <(stat -c '%u %g %a %h %s' "$path")
  [[ "$owner_uid:$owner_gid:$mode:$links" == '10001:10001:600:1' &&
    "$bytes" =~ ^[1-9][0-9]*$ ]] ||
    die 'Finance restore verifier handoff was not written by the isolated acceptance process'
  assert_finance_restore_verifier_handoff_payload "$path"
  chown 0:0 "$path"
  chmod 0600 "$path"
  assert_root_owned_bounded_file "$path" 600 16384
}

clear_finance_restore_verifier_handoff() {
  local state_dir="$1" path

  path="$(finance_staging_restore_verifier_input_path "$state_dir")"
  assert_finance_restore_verifier_handoff_path "$state_dir"
  : > "$path"
  chmod 0600 "$path"
}

prepare_finance_staging_finalize_handoff() {
  local state_dir="$1" document_id="$2" evidence_id="$3" restore_receipt="$4"
  local path secret_dir pending receipt_digest receipt_name owner_uid owner_gid mode links bytes extra

  [[ "${IMAGE_LOCK_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ &&
    "${STAGING_RUN_ID:-}" =~ ^[1-9][0-9]{0,19}$ ]] ||
    die 'Finance staging finalize handoff has no run binding'
  [[ "$document_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    die 'Finance staging finalize document ID is invalid'
  [[ "$evidence_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    die 'Finance staging finalize evidence ID is invalid'
  receipt_name="$(basename -- "$restore_receipt")"
  [[ "$(dirname -- "$restore_receipt")" == "$state_dir" &&
    "$receipt_name" == finance-staging-restore-receipt.json ]] ||
    die 'Finance staging finalize restore receipt path is invalid'
  assert_root_owned_bounded_file "$restore_receipt" 600 262144
  read -r receipt_digest extra < <(sha256sum "$restore_receipt")
  [[ "$receipt_digest" =~ ^[0-9a-f]{64}$ && -n "${extra:-}" ]] ||
    die 'Finance staging finalize restore receipt digest is invalid'

  path="$(finance_staging_restore_verifier_input_path "$state_dir")"
  assert_finance_restore_verifier_handoff_path "$state_dir"
  read -r owner_uid owner_gid mode links bytes < <(stat -c '%u %g %a %h %s' "$path")
  [[ "$owner_uid:$owner_gid:$mode:$links:$bytes" == '0:0:600:1:0' ]] ||
    die 'Finance staging finalize handoff was not cleared by the root restore verifier'
  secret_dir="$(dirname -- "$path")"
  pending="$(mktemp "$secret_dir/.finance-finalize-input.XXXXXX")"
  printf '%s\n' \
    'schema=emdo-finance-staging-finalize-input-v1' \
    "source_sha=$IMAGE_LOCK_SOURCE_SHA" \
    "workflow_run_id=$STAGING_RUN_ID" \
    "document_id=$document_id" \
    "evidence_id=$evidence_id" \
    "backup_restore_receipt_sha256=$receipt_digest" > "$pending"
  chmod 0600 "$pending"
  chown 10001:10001 "$pending"
  mv -- "$pending" "$path"
  assert_finance_restore_verifier_handoff_path "$state_dir"
  read -r owner_uid owner_gid mode links bytes < <(stat -c '%u %g %a %h %s' "$path")
  [[ "$owner_uid:$owner_gid:$mode:$links" == '10001:10001:600:1' &&
    "$bytes" =~ ^[1-9][0-9]*$ ]] ||
    die 'Finance staging finalize handoff was not prepared safely'
}

claim_consumed_finance_staging_finalize_handoff() {
  local state_dir="$1" path owner_uid owner_gid mode links bytes

  path="$(finance_staging_restore_verifier_input_path "$state_dir")"
  assert_finance_restore_verifier_handoff_path "$state_dir"
  read -r owner_uid owner_gid mode links bytes < <(stat -c '%u %g %a %h %s' "$path")
  [[ "$owner_uid:$owner_gid:$mode:$links:$bytes" == '10001:10001:600:1:0' ]] ||
    die 'Finance staging finalize input was not consumed by the isolated acceptance process'
  chown 0:0 "$path"
  chmod 0600 "$path"
}

assert_finance_synthetic_staging_state() {
  local state_dir="$1"
  local secret_dir="$state_dir/$FINANCE_STAGING_SECRET_DIR"
  local document_store="$state_dir/$FINANCE_STAGING_DOCUMENT_STORE_DIRNAME"
  local api_environment="$secret_dir/finance-api.env"
  local extraction_environment="$secret_dir/finance-extraction.env"
  local restore_verifier_input
  local api_keyring extraction_keyring

  assert_governed_parent_chain "$state_dir" "$STAGING_STATE_ROOT"
  finance_staging_marker_is_valid "$state_dir" ||
    die 'Finance synthetic staging marker is missing or unsafe'
  require_directory "$secret_dir"
  assert_directory_within "$secret_dir" "$state_dir" FINANCE_STAGING_SECRET_DIR
  [[ "$(stat -c '%u:%g:%a' "$secret_dir")" == '0:0:700' ]] ||
    die 'Finance staging secret directory must be root-owned with mode 0700'
  assert_root_owned_bounded_file "$api_environment" 600 16384
  assert_root_owned_bounded_file "$extraction_environment" 600 16384
  assert_finance_staging_api_environment "$api_environment"
  assert_finance_staging_extraction_environment "$extraction_environment"
  api_keyring="$(env_file_value "$api_environment" EMDO_FINANCE_DOCUMENT_KEYRING_B64URL)"
  extraction_keyring="$(env_file_value "$extraction_environment" EMDO_FINANCE_DOCUMENT_KEYRING_B64URL)"
  [[ "$api_keyring" == "$extraction_keyring" ]] ||
    die 'Finance staging keyring differs between API and extraction services'
  require_directory "$document_store"
  assert_directory_within "$document_store" "$state_dir" FINANCE_STAGING_DOCUMENT_STORE_DIR
  [[ "$(stat -c '%u:%g:%a' "$document_store")" == '10001:10001:700' ]] ||
    die 'Finance staging document store must be 10001:10001 with mode 0700'
  restore_verifier_input="$(finance_staging_restore_verifier_input_path "$state_dir")"
  assert_finance_restore_verifier_handoff_path "$state_dir"

  export FINANCE_STAGING_API_ENV_FILE="$api_environment"
  export FINANCE_STAGING_EXTRACTION_ENV_FILE="$extraction_environment"
  export FINANCE_STAGING_DOCUMENT_STORE_DIR="$document_store"
  export FINANCE_STAGING_RESTORE_VERIFIER_INPUT_FILE="$restore_verifier_input"
  export EMDO_FINANCE_SYNTHETIC_STAGING=true
}

disable_finance_synthetic_staging() {
  unset FINANCE_STAGING_API_ENV_FILE
  unset FINANCE_STAGING_EXTRACTION_ENV_FILE
  unset FINANCE_STAGING_DOCUMENT_STORE_DIR
  unset FINANCE_STAGING_RESTORE_VERIFIER_INPUT_FILE
  export EMDO_FINANCE_SYNTHETIC_STAGING=false
}

load_finance_synthetic_staging_state() {
  local state_dir="$1"
  if [[ -e "$state_dir/$FINANCE_STAGING_MARKER_FILE" ]]; then
    assert_finance_synthetic_staging_state "$state_dir"
  else
    disable_finance_synthetic_staging
  fi
}

prepare_finance_synthetic_staging_state() {
  local state_dir="$1"
  local secret_dir="$state_dir/$FINANCE_STAGING_SECRET_DIR"
  local document_store="$state_dir/$FINANCE_STAGING_DOCUMENT_STORE_DIRNAME"
  local marker="$state_dir/$FINANCE_STAGING_MARKER_FILE"
  local pending_secret_dir pending_api pending_extraction pending_handoff pending_marker
  local worker_executor_database_url onboarding_database_url workflow_database_url
  local document_key review_key keyring approval_keyring visual_proof_keyring
  local proposal_cursor_keyring invitation_delivery_public_key invitation_delivery_key_id
  local -a secret_lines=()

  [[ "${EMDO_FINANCE_SYNTHETIC_STAGING:-false}" == true ]] ||
    die 'Finance synthetic staging was not explicitly enabled'
  assert_governed_parent_chain "$state_dir" "$STAGING_STATE_ROOT"
  [[ ! -e "$secret_dir" && ! -e "$document_store" && ! -e "$marker" ]] ||
    die 'Finance synthetic staging state already exists for this run'
  require_command openssl
  mapfile -t secret_lines
  [[ "${#secret_lines[@]}" == 1 ]] ||
    die 'Finance staging key must be supplied as exactly one protected stdin line'
  [[ "${#secret_lines[0]}" -ge 16 && "${#secret_lines[0]}" -le 512 &&
    "${secret_lines[0]}" =~ ^[A-Za-z0-9_-]+$ ]] ||
    die 'Finance staging key has an invalid format'
  worker_executor_database_url="$(env_file_value \
    "$SECRETS_DIR/worker.env" EMDO_WORKER_EXECUTOR_DATABASE_URL)"
  onboarding_database_url="$(finance_staging_onboarding_database_url \
    "$SECRETS_DIR/onboarding_database_password")"
  workflow_database_url="$(finance_staging_workflow_database_url \
    "$SECRETS_DIR/workflow_database_password")"
  document_key="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  review_key="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  keyring="$(printf '%s' \
    "{\"schemaVersion\":1,\"current\":{\"keyVersion\":\"finance-documents.v1\",\"keyB64url\":\"$document_key\"},\"previous\":[]}" |
    openssl base64 -A | tr '+/' '-_' | tr -d '=\n')"
  [[ ${#document_key} == 43 && ${#review_key} == 43 && ${#keyring} -le 8192 ]] ||
    die 'could not generate Finance staging cryptographic material'
  approval_keyring="$(finance_staging_hmac_keyring finance-approval-checkpoint.current-1)"
  visual_proof_keyring="$(finance_staging_hmac_keyring finance-visual-proof.current-1)"
  proposal_cursor_keyring="$(finance_staging_hmac_keyring finance-proposal-cursor.current-1)"
  invitation_delivery_public_key="$(finance_staging_invitation_delivery_public_key)"
  invitation_delivery_key_id="finance-staging-${STAGING_RUN_ID:?STAGING_RUN_ID is required}-invitation-delivery"
  [[ "$approval_keyring" != "$visual_proof_keyring" &&
    "$approval_keyring" != "$proposal_cursor_keyring" &&
    "$visual_proof_keyring" != "$proposal_cursor_keyring" ]] ||
    die 'Finance staging generated duplicate HMAC keyring material'

  pending_secret_dir="$(mktemp -d "$state_dir/.finance-secrets.XXXXXX")"
  chmod 0700 "$pending_secret_dir"
  chown 0:0 "$pending_secret_dir"
  pending_api="$(mktemp "$pending_secret_dir/.finance-api.env.XXXXXX")"
  pending_extraction="$(mktemp "$pending_secret_dir/.finance-extraction.env.XXXXXX")"
  pending_handoff="$pending_secret_dir/$FINANCE_STAGING_RESTORE_VERIFIER_INPUT_NAME"
  printf '%s\n' \
    'EMDO_FINANCE_DOCUMENTS_ENABLED=true' \
    "EMDO_FINANCE_DOCUMENT_KEYRING_B64URL=$keyring" \
    "EMDO_FINANCE_DOCUMENT_REVIEW_HMAC_KEY_B64URL=$review_key" \
    "EMDO_ONBOARDING_DATABASE_URL=$onboarding_database_url" \
    "EMDO_WORKFLOW_DATABASE_URL=$workflow_database_url" \
    "EMDO_APPROVAL_CHECKPOINT_KEYRING_B64URL=$approval_keyring" \
    "EMDO_VISUAL_PROOF_HMAC_KEYRING_B64URL=$visual_proof_keyring" \
    "EMDO_PROPOSAL_CURSOR_HMAC_KEYRING_B64URL=$proposal_cursor_keyring" \
    "EMDO_INVITATION_DELIVERY_KEY_ID=$invitation_delivery_key_id" \
    "EMDO_INVITATION_DELIVERY_PUBLIC_KEY_SPKI_BASE64URL=$invitation_delivery_public_key" > "$pending_api"
  printf '%s\n' \
    'EMDO_FINANCE_DOCUMENTS_ENABLED=true' \
    "EMDO_WORKER_EXECUTOR_DATABASE_URL=$worker_executor_database_url" \
    "EMDO_FINANCE_DOCUMENT_KEYRING_B64URL=$keyring" \
    "EMDO_OPENAI_FINANCE_API_KEY=${secret_lines[0]}" > "$pending_extraction"
  chmod 0600 "$pending_api" "$pending_extraction"
  chown 0:0 "$pending_api" "$pending_extraction"
  mv -- "$pending_api" "$pending_secret_dir/finance-api.env"
  mv -- "$pending_extraction" "$pending_secret_dir/finance-extraction.env"
  install -o 10001 -g 10001 -m 0600 /dev/null "$pending_handoff"
  install -d -o 10001 -g 10001 -m 0700 "$document_store"
  mv -- "$pending_secret_dir" "$secret_dir"
  pending_marker="$(mktemp "$state_dir/.finance-synthetic-staging.XXXXXX")"
  printf '%s\n' 'FINANCE_SYNTHETIC_STAGING=true' > "$pending_marker"
  chmod 0600 "$pending_marker"
  chown 0:0 "$pending_marker"
  mv -- "$pending_marker" "$marker"
  secret_lines[0]=''
  document_key=''
  review_key=''
  keyring=''
  approval_keyring=''
  visual_proof_keyring=''
  proposal_cursor_keyring=''
  invitation_delivery_public_key=''
  invitation_delivery_key_id=''
  worker_executor_database_url=''
  onboarding_database_url=''
  workflow_database_url=''
  assert_finance_synthetic_staging_state "$state_dir"
}

remove_staging_run_state() {
  local state_dir="$1"
  assert_governed_parent_chain "$state_dir" "$STAGING_STATE_ROOT"
  find "$state_dir" -xdev -depth -mindepth 1 -delete
  rmdir -- "$state_dir"
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
  for resource in edge egress auth-egress backend loopback-ingress finance-extraction-egress; do
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
  local -a compose_files=(
    --file "$COMPOSE_DIR/compose.yml"
    --file "$COMPOSE_DIR/compose.staging.yml"
  )
  case "${EMDO_FINANCE_SYNTHETIC_STAGING:-false}" in
    true) compose_files+=(--file "$COMPOSE_DIR/compose.finance-staging.yml") ;;
    false) ;;
    *) die 'EMDO_FINANCE_SYNTHETIC_STAGING must be true or false' ;;
  esac
  docker compose \
    --project-name "$COMPOSE_PROJECT_NAME" \
    "${compose_files[@]}" \
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

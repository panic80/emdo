#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# This verifier deliberately consumes only the narrow, short-lived handoff
# emitted by the Finance staging-acceptance harness.  It never accepts a
# document body, password, provider credential, archive key, or arbitrary URL.
# shellcheck source=infra/scripts/_common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"

readonly FINANCE_RESTORE_VERIFIER_SCHEMA='emdo-finance-staging-restore-verifier-input-v1'
readonly FINANCE_RESTORE_VERIFIER_RECEIPT_NAME='finance-staging-restore-receipt.json'

usage() {
  die 'usage: FINANCE_STAGING_BACKUP_RESTORE_TARGET_ENVIRONMENT=staging FINANCE_RESTORE_API_ORIGIN=http://127.0.0.1:<port> finance-staging-restore-verify.sh <numeric-staging-run-id>'
}

require_root_operator() {
  [[ "$(id -u)" == 0 ]] || die 'Finance staging backup/restore verification must run as root'
}

assert_staging_target() {
  [[ "${FINANCE_STAGING_BACKUP_RESTORE_TARGET_ENVIRONMENT:-}" == staging ]] ||
    die 'FINANCE_STAGING_BACKUP_RESTORE_TARGET_ENVIRONMENT must be exactly staging'
}

assert_loopback_api_origin() {
  local origin="$1" port

  [[ "$origin" =~ ^http://127\.0\.0\.1:([1-9][0-9]{3,4})$ ]] ||
    die 'FINANCE_RESTORE_API_ORIGIN must be an exact HTTP loopback origin'
  port="${BASH_REMATCH[1]}"
  assert_unprivileged_tcp_port "$port"
}

assert_uuid() {
  local value="$1" label="$2"

  [[ "$value" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    die "$label must be an opaque UUID"
}

assert_cookie_header() {
  local value="$1" label="$2"

  # This permits the two cookie pairs minted by the existing acceptance
  # harness, but excludes quotes, backslashes, control characters, and
  # newlines so a value cannot alter the curl configuration file.
  [[ "$value" =~ ^[A-Za-z0-9_.-]+=[A-Za-z0-9_.=-]+(\;\ [A-Za-z0-9_.-]+=[A-Za-z0-9_.=-]+)*$ ]] ||
    die "$label has an invalid session-material format"
}

declare -A verifier_input=()

read_verifier_input() {
  local input_file="$1" line key value
  local -a expected_keys=(
    schema
    source_sha
    workflow_run_id
    document_id
    evidence_id
    expected_plaintext_sha256
    owner_cookie
    member_cookie
  )

  assert_root_owned_bounded_file "$input_file" 600 16384
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *=* ]] || die 'Finance restore verifier input contains a malformed line'
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      schema | source_sha | workflow_run_id | document_id | evidence_id | expected_plaintext_sha256 | owner_cookie | member_cookie) ;;
      *) die 'Finance restore verifier input contains an unexpected key' ;;
    esac
    [[ -n "$value" && -z "${verifier_input[$key]+present}" ]] ||
      die 'Finance restore verifier input contains an empty or duplicate value'
    verifier_input["$key"]="$value"
  done < "$input_file"

  [[ "${#verifier_input[@]}" == "${#expected_keys[@]}" ]] ||
    die 'Finance restore verifier input does not contain the exact required keys'
  [[ "${verifier_input[schema]}" == "$FINANCE_RESTORE_VERIFIER_SCHEMA" ]] ||
    die 'Finance restore verifier input schema is unsupported'
  [[ "${verifier_input[source_sha]}" == "$IMAGE_LOCK_SOURCE_SHA" ]] ||
    die 'Finance restore verifier input source SHA does not bind this staging run'
  [[ "${verifier_input[workflow_run_id]}" == "$run_id" ]] ||
    die 'Finance restore verifier input workflow run ID does not bind this staging run'
  assert_uuid "${verifier_input[document_id]}" FINANCE_RESTORE_DOCUMENT_ID
  assert_uuid "${verifier_input[evidence_id]}" FINANCE_RESTORE_EVIDENCE_ID
  [[ "${verifier_input[expected_plaintext_sha256]}" =~ ^[0-9a-f]{64}$ ]] ||
    die 'Finance restore verifier input plaintext digest is invalid'
  assert_cookie_header "${verifier_input[owner_cookie]}" FINANCE_RESTORE_OWNER_SESSION
  assert_cookie_header "${verifier_input[member_cookie]}" FINANCE_RESTORE_MEMBER_SESSION
  [[ "${verifier_input[owner_cookie]}" != "${verifier_input[member_cookie]}" ]] ||
    die 'Finance restore verifier requires two distinct authenticated sessions'
}

write_curl_config() {
  local destination="$1" url="$2" cookie="$3" headers="$4" output="$5" write_out="$6" fail_mode="$7"

  [[ ! -e "$destination" && ! -L "$destination" ]] ||
    die 'Finance restore verifier scratch file already exists'
  {
    printf 'url = "%s"\n' "$url"
    printf 'cookie = "%s"\n' "$cookie"
    printf 'header = "Accept: application/json"\n'
    printf 'header = "Cache-Control: no-store"\n'
    printf 'dump-header = "%s"\n' "$headers"
    if [[ -n "$output" ]]; then
      printf 'output = "%s"\n' "$output"
    fi
    if [[ -n "$write_out" ]]; then
      printf 'write-out = "%s"\n' "$write_out"
    fi
    printf 'connect-timeout = 5\n'
    printf 'max-time = 15\n'
    printf 'silent\n'
    printf 'show-error\n'
    if [[ "$fail_mode" == true ]]; then
      printf 'fail\n'
    fi
  } > "$destination"
  chmod 0600 "$destination"
}

assert_response_request_id() {
  local headers="$1" line value=''

  require_regular_file "$headers"
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      [Xx]-[Rr]equest-[Ii]d:*)
        value="${line#*:}"
        value="${value//$'\r'/}"
        value="${value## }"
        ;;
    esac
  done < "$headers"
  assert_uuid "$value" FINANCE_RESTORE_RESPONSE_REQUEST_ID
}

assert_committed_document_readback() {
  local response_file="$1" document_id="$2" expected_digest="$3"

  node --input-type=module --eval '
    import { readFile } from "node:fs/promises";
    const [path, documentId, expectedDigest] = process.argv.slice(1);
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value?.schemaVersion !== 1 ||
        value?.document?.id !== documentId ||
        value?.document?.state !== "committed" ||
        value?.document?.plaintextSha256 !== expectedDigest) process.exit(1);
  ' "$response_file" "$document_id" "$expected_digest" ||
    die 'restored Finance committed-document readback is invalid'
}

assert_evidence_readback() {
  local response_file="$1" document_id="$2"

  node --input-type=module --eval '
    import { readFile } from "node:fs/promises";
    const [path, documentId] = process.argv.slice(1);
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value?.schemaVersion !== 1 || !Array.isArray(value?.items) ||
        !value.items.some((item) => item?.documentId === documentId)) process.exit(1);
  ' "$response_file" "$document_id" ||
    die 'restored Finance committed evidence readback is invalid'
}

cleanup_scratch() {
  local exit_code=$?
  trap - EXIT
  if [[ -n "${scratch_dir:-}" && -d "$scratch_dir" && ! -L "$scratch_dir" ]]; then
    find "$scratch_dir" -xdev -type f -delete 2>/dev/null || true
    rmdir -- "$scratch_dir" 2>/dev/null || true
  fi
  exit "$exit_code"
}

run_id="${1:-}"
[[ "$#" == 1 ]] || usage
assert_staging_target
require_root_operator
assert_safe_identifier "$run_id" STAGING_RUN_ID
[[ "$run_id" =~ ^[1-9][0-9]{0,19}$ ]] || die 'STAGING_RUN_ID must be numeric and nonzero'

state_dir="$STAGING_STATE_ROOT/$run_id"
assert_governed_parent_chain "$state_dir" "$STAGING_STATE_ROOT"
assert_root_owned_bounded_file "$state_dir/images.env" 600 32768
assert_digest_lock "$state_dir/images.env"
export_digest_lock
assert_finance_synthetic_staging_state "$state_dir"
assert_loopback_api_origin "${FINANCE_RESTORE_API_ORIGIN:-}"
require_command curl
require_command node
require_command sha256sum
require_command find

secret_dir="$state_dir/$FINANCE_STAGING_SECRET_DIR"
input_file="$secret_dir/$FINANCE_RESTORE_VERIFIER_INPUT_NAME"
receipt_file="$state_dir/$FINANCE_RESTORE_VERIFIER_RECEIPT_NAME"
[[ ! -e "$receipt_file" && ! -L "$receipt_file" ]] ||
  die 'Finance restore verifier receipt already exists for this staging run'
read_verifier_input "$input_file"
# The verifier retains the bounded material only in this root process and its
# short-lived 0700 scratch directory. Clear the pre-created bind source before
# any restored HTTP request so it cannot be replayed by another operation.
clear_finance_restore_verifier_handoff "$state_dir"

scratch_dir="$(mktemp -d "$state_dir/.finance-restore-verify.XXXXXX")"
chmod 0700 "$scratch_dir"
chown 0:0 "$scratch_dir"
trap cleanup_scratch EXIT

document_id="${verifier_input[document_id]}"
evidence_id="${verifier_input[evidence_id]}"
expected_digest="${verifier_input[expected_plaintext_sha256]}"
api_origin="$FINANCE_RESTORE_API_ORIGIN"

owner_detail_headers="$scratch_dir/owner-detail.headers"
owner_detail_body="$scratch_dir/owner-detail.json"
owner_detail_config="$scratch_dir/owner-detail.curl"
write_curl_config \
  "$owner_detail_config" \
  "$api_origin/api/v1/finance/documents/$document_id" \
  "${verifier_input[owner_cookie]}" \
  "$owner_detail_headers" "$owner_detail_body" '' true
curl --config "$owner_detail_config"
assert_response_request_id "$owner_detail_headers"
assert_committed_document_readback "$owner_detail_body" "$document_id" "$expected_digest"

owner_evidence_headers="$scratch_dir/owner-evidence.headers"
owner_evidence_body="$scratch_dir/owner-evidence.json"
owner_evidence_config="$scratch_dir/owner-evidence.curl"
write_curl_config \
  "$owner_evidence_config" \
  "$api_origin/api/v1/finance/evidence/$evidence_id" \
  "${verifier_input[owner_cookie]}" \
  "$owner_evidence_headers" "$owner_evidence_body" '' true
curl --config "$owner_evidence_config"
assert_response_request_id "$owner_evidence_headers"
assert_evidence_readback "$owner_evidence_body" "$document_id"

owner_original_headers="$scratch_dir/owner-original.headers"
owner_original_config="$scratch_dir/owner-original.curl"
owner_original_digest="$scratch_dir/owner-original.sha256"
write_curl_config \
  "$owner_original_config" \
  "$api_origin/api/v1/finance/documents/$document_id/original" \
  "${verifier_input[owner_cookie]}" \
  "$owner_original_headers" '' '' true
set +e
curl --config "$owner_original_config" | sha256sum > "$owner_original_digest"
pipeline_status=("${PIPESTATUS[@]}")
set -e
[[ "${pipeline_status[0]}" == 0 && "${pipeline_status[1]}" == 0 ]] ||
  die 'restored Finance authenticated original could not be read'
assert_response_request_id "$owner_original_headers"
read -r owner_original_sha256 _ < "$owner_original_digest"
[[ "$owner_original_sha256" == "$expected_digest" ]] ||
  die 'restored Finance authenticated original plaintext hash does not match'

member_original_headers="$scratch_dir/member-original.headers"
member_original_config="$scratch_dir/member-original.curl"
member_original_status="$scratch_dir/member-original.status"
write_curl_config \
  "$member_original_config" \
  "$api_origin/api/v1/finance/documents/$document_id/original" \
  "${verifier_input[member_cookie]}" \
  "$member_original_headers" /dev/null '%{http_code}' false
curl --config "$member_original_config" > "$member_original_status"
assert_response_request_id "$member_original_headers"
member_status="$(< "$member_original_status")"
[[ "$member_status" == 403 || "$member_status" == 404 ]] ||
  die 'second authenticated Finance user was not denied after restore'

receipt_pending="$(mktemp "$state_dir/.finance-restore-receipt.XXXXXX")"
  printf '%s\n' \
  "{\"schemaVersion\":1,\"evidenceClass\":\"finance-staging-restore-verification\",\"releaseEligible\":false,\"environment\":\"staging\",\"sourceSha\":\"$IMAGE_LOCK_SOURCE_SHA\",\"workflowRunId\":\"$run_id\",\"stagingRunId\":\"$run_id\",\"committedDocumentReadback\":true,\"authenticatedOriginalHash\":true,\"committedEvidenceReadback\":true,\"secondAuthenticatedUserDenied\":true}" \
  > "$receipt_pending"
chmod 0600 "$receipt_pending"
chown 0:0 "$receipt_pending"
mv -- "$receipt_pending" "$receipt_file"

log "Finance staging restore verification passed for run $run_id"

#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# shellcheck source=infra/scripts/_common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"

run_id="${1:-}"
assert_safe_identifier "$run_id" STAGING_RUN_ID
[[ "$run_id" =~ ^[0-9]{1,20}$ ]] || die 'STAGING_RUN_ID must be numeric'

state_dir="$STAGING_STATE_ROOT/$run_id"
assert_digest_lock "$state_dir/images.env"
export_digest_lock
load_finance_synthetic_staging_state "$state_dir"
export EMDO_STAGING_SOURCE_SHA="$IMAGE_LOCK_SOURCE_SHA"
export EMDO_STAGING_WORKFLOW_RUN_ID="$run_id"
load_deployment_config "$STAGING_CONFIG_FILE"
# assert_production_healthy isolates the same names in a subshell.
# shellcheck disable=SC2031
export COMPOSE_PROJECT_NAME="emdo-staging-$run_id" \
  DEPLOYMENT_NAMESPACE="staging-$run_id" \
  EMDO_ENVIRONMENT=staging
export STAGING_RUN_ID="$run_id"
export STAGING_HTTP_PORT="${DEPLOY_CONFIG_STAGING_HTTP_PORT:-18080}"
assert_unprivileged_tcp_port "$STAGING_HTTP_PORT"
export EMDO_DOMAIN='http://:8080'
export ACME_EMAIL='staging-invalid@emdo.invalid'
export POWERSYNC_JWKS_URI='http://api:3000/.well-known/jwks.json'
export SECRETS_DIR="${DEPLOY_CONFIG_SECRETS_DIR:-/etc/emdo/staging}"
assert_secret_directory_permissions "$SECRETS_DIR"
assert_directory_within "$SECRETS_DIR" /etc/emdo/staging SECRETS_DIR
assert_staging_secret_manifest "$SECRETS_DIR"

require_command curl
require_command node

finance_extraction_terminal_failure_diagnostic() {
  local acceptance_stderr_path="$1"
  local acceptance_failure acceptance_failure_found=false
  local acceptance_stderr_bytes diagnostic safe_error_code attempt extra

  [[ -f "$acceptance_stderr_path" && ! -L "$acceptance_stderr_path" ]] || return 1
  acceptance_stderr_bytes="$(LC_ALL=C wc -c < "$acceptance_stderr_path")" || return 1
  [[ "$acceptance_stderr_bytes" =~ ^[[:space:]]*([0-9]+)[[:space:]]*$ ]] || return 1
  acceptance_stderr_bytes="${BASH_REMATCH[1]}"
  ((acceptance_stderr_bytes <= 4096)) || return 1
  while IFS= read -r acceptance_failure || [[ -n "$acceptance_failure" ]]; do
    if [[ "$acceptance_failure" == 'Staging acceptance failed at stage=document-extraction-terminal.' ]]; then
      acceptance_failure_found=true
    fi
  done < "$acceptance_stderr_path"
  [[ "$acceptance_failure_found" == true ]] || return 1

  # This compose project and database are created per STAGING_RUN_ID. Select
  # only persisted terminal metadata, never a document identifier or payload.
  diagnostic="$(staging_compose exec -T postgres psql \
    --username postgres --dbname emdo_app --no-psqlrc \
    --tuples-only --no-align --field-separator '|' --quiet \
    --set ON_ERROR_STOP=1 \
    --command "SELECT extraction.safe_error_code, extraction.attempt FROM emdo.finance_document_extractions AS extraction INNER JOIN emdo.finance_documents AS document ON document.household_id = extraction.household_id AND document.space_id = extraction.space_id AND document.original_owner_user_id = extraction.original_owner_user_id AND document.id = extraction.document_id WHERE document.display_name = 'emdo-synthetic-staging.pdf' AND document.mime_type = 'application/pdf' AND document.byte_size = 683 AND document.plaintext_sha256 = '8d85942e0ee04fcfa42b1690e07844e7ac1a193fc15c149f9e27b989c77332e1' AND document.state = 'failed' AND document.extraction_revision = extraction.revision AND extraction.state = 'failed' AND extraction.completed_at IS NOT NULL ORDER BY extraction.completed_at DESC, extraction.id DESC LIMIT 1;" \
    2>/dev/null)" || return 1
  [[ "$diagnostic" != *$'\n'* ]] || return 1
  IFS='|' read -r safe_error_code attempt extra <<<"$diagnostic"
  [[ -z "$extra" ]] || return 1

  case "$safe_error_code" in
    worker-completion-rejected | worker-document-metadata-invalid | worker-extraction-failed | worker-extraction-invalid | worker-interrupted | worker-invalid-claim | worker-lease-expired | worker-original-integrity-invalid | worker-original-unavailable | worker-payload-encryption-failed | worker-provider-credential-unavailable | worker-provider-credit-balance-exhausted | worker-provider-network-unavailable | worker-provider-organization-spend-limit-exceeded | worker-provider-organization-usage-limit-exceeded | worker-provider-project-spend-limit-exceeded | worker-provider-quota-exhausted | worker-provider-rate-limit-unclassified | worker-provider-rate-limited | worker-provider-rejected | worker-provider-request-invalid | worker-provider-response-invalid | worker-provider-server-error | worker-provider-unavailable | worker-timeout) ;;
    *) return 1 ;;
  esac
  case "$attempt" in
    1 | 2) ;;
    *) return 1 ;;
  esac

  printf 'Staging acceptance failed at stage=document-extraction-terminal outcome=%s attempt=%s.\n' \
    "$safe_error_code" "$attempt" >&2
}

finance_staging_acceptance_failure_diagnostic() {
  local acceptance_stderr_path="$1"
  local acceptance_stderr_bytes acceptance_failure
  local acceptance_failure_matches=0 acceptance_failure_match=''

  [[ -f "$acceptance_stderr_path" && ! -L "$acceptance_stderr_path" ]] || return 1
  acceptance_stderr_bytes="$(LC_ALL=C wc -c < "$acceptance_stderr_path")" || return 1
  [[ "$acceptance_stderr_bytes" =~ ^[[:space:]]*([0-9]+)[[:space:]]*$ ]] || return 1
  acceptance_stderr_bytes="${BASH_REMATCH[1]}"
  ((acceptance_stderr_bytes <= 4096)) || return 1
  while IFS= read -r acceptance_failure; do
    case "$acceptance_failure" in
      'Staging acceptance failed at stage=configuration.' | \
    'Staging acceptance failed at stage=health-and-contract.' | \
    'Staging acceptance failed at stage=owner-authentication.' | \
    'Staging acceptance failed at stage=member-invitation.' | \
    'Staging acceptance failed at stage=member-token-handoff.' | \
    'Staging acceptance failed at stage=member-redemption.' | \
    'Staging acceptance failed at stage=member-membership-readback.' | \
    'Staging acceptance failed at stage=member-authentication.' | \
    'Staging acceptance failed at stage=document-upload.' | \
    'Staging acceptance failed at stage=document-extraction-terminal.' | \
    'Staging acceptance failed at stage=document-original-readback.' | \
    'Staging acceptance failed at stage=document-review-read-edit.' | \
    'Staging acceptance failed at stage=document-direct-commit-denial.' | \
    'Staging acceptance failed at stage=guarded-review-commit.' | \
    'Staging acceptance failed at stage=guarded-review-commit:initial-turn.' | \
    'Staging acceptance failed at stage=guarded-review-commit:initial-turn outcome=turn-post-or-response-invalid.' | \
    'Staging acceptance failed at stage=guarded-review-commit:initial-turn outcome=turn-acceptance-json-or-schema-invalid.' | \
    'Staging acceptance failed at stage=guarded-review-commit:initial-turn outcome=initial-sse-request-failed.' | \
    'Staging acceptance failed at stage=guarded-review-commit:initial-turn outcome=initial-sse-http-or-content-type-invalid.' | \
    'Staging acceptance failed at stage=guarded-review-commit:initial-turn outcome=initial-sse-byte-or-framing-invalid.' | \
    'Staging acceptance failed at stage=guarded-review-commit:initial-turn outcome=initial-sse-event-schema-run-or-sequence-invalid.' | \
    'Staging acceptance failed at stage=guarded-review-commit:initial-turn outcome=initial-sse-terminal-run-failed.' | \
    'Staging acceptance failed at stage=guarded-review-commit:initial-turn outcome=initial-sse-terminal-run-indeterminate.' | \
    'Staging acceptance failed at stage=guarded-review-commit:initial-turn outcome=initial-sse-terminal-other-or-cardinality-invalid.' | \
    'Staging acceptance failed at stage=guarded-review-commit:initial-turn outcome=approval-terminal-invalid.' | \
    'Staging acceptance failed at stage=guarded-review-commit:approval-parsing.' | \
    'Staging acceptance failed at stage=guarded-review-commit:proposal-read.' | \
    'Staging acceptance failed at stage=guarded-review-commit:visual-proof.' | \
    'Staging acceptance failed at stage=guarded-review-commit:decision-receipt.' | \
    'Staging acceptance failed at stage=guarded-review-commit:resumed-run.' | \
    'Staging acceptance failed at stage=guarded-review-commit:resumed-run-failed.' | \
    'Staging acceptance failed at stage=guarded-review-commit:resumed-run-completed.' | \
    'Staging acceptance failed at stage=guarded-review-commit:commit-readback.' | \
    'Staging acceptance failed at stage=guarded-review-commit:quota-readback.' | \
    'Staging acceptance failed at stage=guarded-delete-denial.' | \
    'Staging acceptance failed at stage=qna-and-isolation.' | \
    'Staging acceptance failed at stage=safe-write-and-handoff.' | \
    'Staging acceptance failed at stage=finalize-configuration.' | \
    'Staging acceptance failed at stage=finalize-attestation.' | \
    'Staging acceptance failed at stage=finalize-health-and-contract.' | \
    'Staging acceptance failed at stage=finalize-owner-authentication.' | \
    'Staging acceptance failed at stage=finalize-member-authentication.' | \
    'Staging acceptance failed at stage=finalize-document-and-evidence.' | \
    'Staging acceptance failed at stage=finalize-guarded-delete.' | \
    'Staging acceptance failed at stage=finalize-purge-and-revocation.' | \
    'Staging acceptance failed at stage=member-invitation outcome=request-or-network-failed.' | \
    'Staging acceptance failed at stage=member-invitation outcome=http-401-authentication-required.' | \
    'Staging acceptance failed at stage=member-invitation outcome=http-401-authentication-invalid.' | \
    'Staging acceptance failed at stage=member-invitation outcome=http-400-invalid-input.' | \
    'Staging acceptance failed at stage=member-invitation outcome=http-403-mutation-proof-invalid.' | \
    'Staging acceptance failed at stage=member-invitation outcome=http-403-household-owner-required.' | \
    'Staging acceptance failed at stage=member-invitation outcome=http-403-authorization-revoked.' | \
    'Staging acceptance failed at stage=member-invitation outcome=http-409-conflict.' | \
    'Staging acceptance failed at stage=member-invitation outcome=http-500-internal-error.' | \
    'Staging acceptance failed at stage=member-invitation outcome=http-502-service-contract-invalid.' | \
    'Staging acceptance failed at stage=member-invitation outcome=http-503-authentication-unavailable.' | \
    'Staging acceptance failed at stage=member-invitation outcome=http-503-mutation-verification-unavailable.' | \
    'Staging acceptance failed at stage=member-invitation outcome=http-503-invalid-result.' | \
    'Staging acceptance failed at stage=member-invitation outcome=http-problem-unrecognized.' | \
    'Staging acceptance failed at stage=member-invitation outcome=readback-invalid.' | \
    'Staging acceptance failed at stage=document-upload outcome=request-or-network-failed.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-400-request-header-invalid.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-400-idempotency-key-required.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-400-request-validation-failed.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-400-invalid-input.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-401-authentication-required.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-401-authentication-invalid.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-403-mutation-proof-invalid.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-403-authorization-revoked.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-404-document-not-found.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-409-idempotency-conflict.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-409-duplicate-document.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-409-document-state-conflict.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-413-finance-document-too-large.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-413-request-body-too-large.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-413-quota-exceeded.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-415-unsupported-media-type.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-500-internal-error.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-502-service-contract-invalid.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-503-authentication-unavailable.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-503-mutation-verification-unavailable.' | \
    'Staging acceptance failed at stage=document-upload outcome=http-503-finance-documents-unavailable.' | \
      'Staging acceptance failed at stage=document-upload outcome=http-problem-unrecognized.' | \
      'Staging acceptance failed at stage=document-upload outcome=201-json-or-schema-invalid.' | \
      'Staging acceptance failed at stage=document-upload outcome=synthetic-metadata-or-hash-mismatch.')
        ((acceptance_failure_matches += 1))
        ((acceptance_failure_matches == 1)) || return 1
        acceptance_failure_match="$acceptance_failure"
        ;;
      *) ;;
    esac
  done < "$acceptance_stderr_path"
  [[ -z "$acceptance_failure" ]] || return 1

  [[ -n "$acceptance_failure_match" ]] || return 1
  printf '%s\n' "$acceptance_failure_match" >&2
}

assert_compose_healthy staging_compose
curl --fail --silent --show-error \
  "http://127.0.0.1:$STAGING_HTTP_PORT/healthz" >/dev/null

if [[ "$EMDO_FINANCE_SYNTHETIC_STAGING" == true ]]; then
  finance_handoff_path="$(finance_staging_restore_verifier_input_path "$state_dir")"
  finance_probe_pending=''
  finance_acceptance_stderr=''
  finance_document_id=''
  finance_evidence_id=''

  # shellcheck disable=SC2317 # Invoked by the EXIT trap immediately below.
  cleanup_finance_acceptance_failure() {
    local exit_code=$?
    trap - EXIT
    if [[ -n "$finance_probe_pending" && -e "$finance_probe_pending" && ! -L "$finance_probe_pending" ]]; then
      rm -f -- "$finance_probe_pending" || true
    fi
    if [[ -n "$finance_acceptance_stderr" && -e "$finance_acceptance_stderr" && ! -L "$finance_acceptance_stderr" ]]; then
      rm -f -- "$finance_acceptance_stderr" || true
    fi
    # The bind source must remain present until compose teardown, but never
    # retain a partial or unconsumed bearer-bearing write after a failed run.
    clear_finance_restore_verifier_handoff "$state_dir" || true
    exit "$exit_code"
  }
  trap cleanup_finance_acceptance_failure EXIT

  assert_finance_restore_verifier_handoff_empty "$state_dir"
  finance_extraction_container="$(staging_compose ps --quiet finance-extraction)"
  [[ -n "$finance_extraction_container" ]] ||
    die 'Finance extraction sidecar is not present for the opted-in staging run'
  [[ "$(docker inspect --format '{{.State.Status}}' "$finance_extraction_container")" == running ]] ||
    die 'Finance extraction sidecar is not running for the opted-in staging run'
  [[ "$(docker inspect --format '{{json .Config.Cmd}}' "$finance_extraction_container")" == *'dist/cli/finance-document-extraction.js'* ]] ||
    die 'Finance extraction sidecar does not run the governed extraction CLI'

  # The Finance overlay intentionally does not satisfy the provider-free
  # Shopping readiness profile. Its own CLI uses only the authenticated EMDO
  # document and turn contracts, while this shell proves the real sidecar is
  # alive without reading its provider traffic, key, or document contents.
  finance_probe_pending="$(mktemp "$state_dir/.finance-synthetic-staging-probe.XXXXXX")"
  finance_acceptance_stderr="$(mktemp "$state_dir/.finance-synthetic-staging-acceptance.XXXXXX")"
  chmod 0600 "$finance_probe_pending"
  chmod 0600 "$finance_acceptance_stderr"
  chown 0:0 "$finance_probe_pending"
  chown 0:0 "$finance_acceptance_stderr"
  if staging_compose --profile operations run --rm --no-deps \
    --env EMDO_FINANCE_SYNTHETIC_STAGING=true \
    staging-acceptance \
      node \
      dist/cli/staging-acceptance.js \
      --all-mvp-gates \
      --require-synthetic \
      --forbid-worker-provider-execution \
      --finance-synthetic-document-gates \
    > "$finance_probe_pending" 2> "$finance_acceptance_stderr"; then
    rm -f -- "$finance_acceptance_stderr"
    finance_acceptance_stderr=''
  else
    finance_acceptance_status=$?
    if ! finance_extraction_terminal_failure_diagnostic "$finance_acceptance_stderr" && \
      ! finance_staging_acceptance_failure_diagnostic "$finance_acceptance_stderr"; then
      printf '%s\n' 'Staging acceptance failed.' >&2
    fi
    if rm -f -- "$finance_acceptance_stderr"; then
      finance_acceptance_stderr=''
    fi
    exit "$finance_acceptance_status"
  fi

  node --input-type=module --eval '
    import { readFile } from "node:fs/promises";
    const value = JSON.parse(await readFile(process.argv[1], "utf8"));
    if (value.sourceSha !== process.env.EMDO_STAGING_SOURCE_SHA ||
        value.execution?.runId !== process.env.EMDO_STAGING_WORKFLOW_RUN_ID ||
        value.evidenceClass !== "finance-synthetic-staging-probe" ||
        value.releaseEligible !== false ||
        value.outcome !== "blocked" ||
        value.proof?.backupRestore !== "blocked" ||
        value.proof?.approvedDeletePurge !== "blocked" ||
        !Array.isArray(value.blockers) || value.blockers.length !== 2 ||
        !value.blockers.includes("approved-document-purge-awaiting-backup") ||
        !value.blockers.includes("backup-restore-awaiting-root-drill") ||
        Object.entries(value.proof ?? {}).some(([key, status]) =>
          !["approvedDeletePurge", "backupRestore"].includes(key) && status !== "passed") ||
        JSON.stringify(value).includes("owner_cookie") ||
        JSON.stringify(value).includes("member_cookie")) process.exit(1);
  ' "$finance_probe_pending"
  mv -- "$finance_probe_pending" "$state_dir/finance-synthetic-staging-probe.json"
  finance_probe_pending=''
  chmod 0600 "$state_dir/finance-synthetic-staging-probe.json"

  [[ -s "$finance_handoff_path" ]] ||
    die 'Finance acceptance did not produce the committed document/evidence handoff'
  # Only the stopped acceptance container could have written this file. Root
  # validates and takes ownership before the isolated restore process sees it.
  claim_finance_restore_verifier_handoff "$state_dir"
  finance_document_id="$(env_file_value "$finance_handoff_path" document_id)"
  finance_evidence_id="$(env_file_value "$finance_handoff_path" evidence_id)"
  finance_restore_http_port="$((10#$STAGING_HTTP_PORT + 1))"
  assert_unprivileged_tcp_port "$finance_restore_http_port"
  [[ "$finance_restore_http_port" != "$STAGING_HTTP_PORT" ]] ||
    die 'Finance restore HTTP port must differ from the active staging port'
  FINANCE_STAGING_BACKUP_RESTORE_TARGET_ENVIRONMENT=staging \
    "$SCRIPT_DIR/finance-staging-backup-restore.sh" backup "$run_id"
  FINANCE_STAGING_BACKUP_RESTORE_TARGET_ENVIRONMENT=staging \
    FINANCE_RESTORE_HTTP_PORT="$finance_restore_http_port" \
    "$SCRIPT_DIR/finance-staging-backup-restore.sh" restore "$run_id"

  node --input-type=module --eval '
    import { readFile } from "node:fs/promises";
    const receipt = JSON.parse(await readFile(process.argv[1], "utf8"));
    const expectedReceiptKeys = [
      "authenticatedOriginalHash", "committedDocumentReadback",
      "committedEvidenceReadback", "environment", "evidenceClass",
      "releaseEligible", "schemaVersion", "secondAuthenticatedUserDenied",
      "sourceSha", "stagingRunId", "workflowRunId",
    ].sort();
    if (receipt?.schemaVersion !== 1 ||
        receipt?.evidenceClass !== "finance-staging-restore-verification" ||
        receipt?.releaseEligible !== false || receipt?.environment !== "staging" ||
        receipt?.sourceSha !== process.env.EMDO_STAGING_SOURCE_SHA ||
        receipt?.workflowRunId !== process.env.EMDO_STAGING_WORKFLOW_RUN_ID ||
        receipt?.stagingRunId !== process.env.EMDO_STAGING_WORKFLOW_RUN_ID ||
        receipt?.committedDocumentReadback !== true ||
        receipt?.authenticatedOriginalHash !== true ||
        receipt?.committedEvidenceReadback !== true ||
        receipt?.secondAuthenticatedUserDenied !== true ||
        JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(expectedReceiptKeys)) process.exit(1);
  ' "$state_dir/finance-staging-restore-receipt.json"
  prepare_finance_staging_finalize_handoff \
    "$state_dir" "$finance_document_id" "$finance_evidence_id" \
    "$state_dir/finance-staging-restore-receipt.json"

  finance_probe_pending="$(mktemp "$state_dir/.finance-synthetic-staging-probe-final.XXXXXX")"
  chmod 0600 "$finance_probe_pending"
  chown 0:0 "$finance_probe_pending"
  staging_compose --profile operations run --rm --no-deps \
    --env EMDO_FINANCE_SYNTHETIC_STAGING=true \
    staging-acceptance \
      node \
      dist/cli/staging-acceptance.js \
      --all-mvp-gates \
      --require-synthetic \
      --forbid-worker-provider-execution \
      --finance-synthetic-document-gates \
      --finance-synthetic-document-finalize \
    > "$finance_probe_pending"
  node --input-type=module --eval '
    import { readFile } from "node:fs/promises";
    const value = JSON.parse(await readFile(process.argv[1], "utf8"));
    if (value.sourceSha !== process.env.EMDO_STAGING_SOURCE_SHA ||
        value.execution?.runId !== process.env.EMDO_STAGING_WORKFLOW_RUN_ID ||
        value.evidenceClass !== "finance-synthetic-staging-probe" ||
        value.releaseEligible !== false || value.outcome !== "passed" ||
        !Array.isArray(value.blockers) || value.blockers.length !== 0 ||
        value.proof?.backupRestore !== "passed" ||
        value.proof?.approvedDeletePurge !== "passed" ||
        Object.values(value.proof ?? {}).some((status) => status !== "passed") ||
        JSON.stringify(value).includes("owner_cookie") ||
        JSON.stringify(value).includes("member_cookie")) process.exit(1);
  ' "$finance_probe_pending"
  claim_consumed_finance_staging_finalize_handoff "$state_dir"
  mv -- "$finance_probe_pending" "$state_dir/finance-synthetic-staging-probe.json"
  finance_probe_pending=''
  chmod 0600 "$state_dir/finance-synthetic-staging-probe.json"
  finance_document_id=''
  finance_evidence_id=''
  log "Finance synthetic staging extraction, EMDO, guarded actions, isolation, and backup/restore proof passed for run $run_id"
  trap - EXIT
  exit 0
fi

curl --fail --silent --show-error \
  "http://127.0.0.1:$STAGING_HTTP_PORT/synthetic-staging/readyz" >/dev/null

# This release-image CLI is deliberately only the authenticated HTTP/API subset.
# It cannot attest browser PowerSync connect(), two-device isolation, provider
# readback, domain workflows, agent evals, or recovery. The signed release
# evidence assembler requires separate receipts for every one of those gates.
staging_compose --profile operations run --rm --no-deps staging-acceptance \
  > "$state_dir/http-api-subset.json"

observed_at="$(node --input-type=module --eval '
  import { readFile } from "node:fs/promises";
  const value = JSON.parse(await readFile(process.argv[1], "utf8"));
  if (value.sourceSha !== process.env.EMDO_STAGING_SOURCE_SHA ||
      value.execution?.runId !== process.env.EMDO_STAGING_WORKFLOW_RUN_ID ||
      value.evidenceClass !== "staging-http-subset-probe" ||
      value.releaseEligible !== false) process.exit(1);
  process.stdout.write(value.observedAt);
' "$state_dir/http-api-subset.json")"
printf '%s\n' "$observed_at" > "$state_dir/acceptance-passed-at"
chmod 0600 "$state_dir/acceptance-passed-at" "$state_dir/http-api-subset.json"
log "synthetic HTTP/API subset passed for run $run_id; full release evidence remains separate"

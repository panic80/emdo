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

assert_compose_healthy staging_compose
curl --fail --silent --show-error \
  "http://127.0.0.1:$STAGING_HTTP_PORT/healthz" >/dev/null

if [[ "$EMDO_FINANCE_SYNTHETIC_STAGING" == true ]]; then
  finance_handoff_path="$(finance_staging_restore_verifier_input_path "$state_dir")"
  finance_probe_pending=''
  finance_document_id=''
  finance_evidence_id=''

  # shellcheck disable=SC2317 # Invoked by the EXIT trap immediately below.
  cleanup_finance_acceptance_failure() {
    local exit_code=$?
    trap - EXIT
    if [[ -n "$finance_probe_pending" && -e "$finance_probe_pending" && ! -L "$finance_probe_pending" ]]; then
      rm -f -- "$finance_probe_pending" || true
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
    > "$finance_probe_pending"

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

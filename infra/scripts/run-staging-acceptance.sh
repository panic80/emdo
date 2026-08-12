#!/usr/bin/env bash
set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"

run_id="${1:-}"
assert_safe_identifier "$run_id" STAGING_RUN_ID
[[ "$run_id" =~ ^[0-9]{1,20}$ ]] || die 'STAGING_RUN_ID must be numeric'

state_dir="$STAGING_STATE_ROOT/$run_id"
assert_digest_lock "$state_dir/images.env"
export_digest_lock
export EMDO_STAGING_SOURCE_SHA="$IMAGE_LOCK_SOURCE_SHA"
export EMDO_STAGING_WORKFLOW_RUN_ID="$run_id"
load_deployment_config "$STAGING_CONFIG_FILE"
export COMPOSE_PROJECT_NAME="emdo-staging-$run_id"
export DEPLOYMENT_NAMESPACE="staging-$run_id"
export EMDO_ENVIRONMENT=staging
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

assert_compose_healthy staging_compose
curl --fail --silent --show-error \
  "http://127.0.0.1:$STAGING_HTTP_PORT/healthz" >/dev/null
curl --fail --silent --show-error \
  "http://127.0.0.1:$STAGING_HTTP_PORT/readyz" >/dev/null

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

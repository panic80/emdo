#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$repo_root"
container="emdo-finance-runtime-check-$$"
cleanup() { docker rm -f -v "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Local, synthetic runtime proof only. No CI run or deployment attestation is emitted.
suffix="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))')"
database="emdo_ci_finance_document_knowledge_${suffix}"
export EMDO_POSTGRES_INTEGRATION_DATABASE_ATTESTATION="emdo-postgres-suite-v1:finance-document-knowledge:$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
docker run --detach --rm --name "$container" --publish 127.0.0.1::5432 \
  --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB="$database" \
  pgvector/pgvector@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
port="$(docker port "$container" 5432/tcp | sed 's/.*://')"
export TEST_FINANCE_DOCUMENT_DATABASE_URL="postgresql://postgres@127.0.0.1:${port}/${database}"
node --input-type=module <<'JS'
import pg from './packages/db/node_modules/pg/lib/index.js';
const client = new pg.Client(process.env.TEST_FINANCE_DOCUMENT_DATABASE_URL);
await client.connect();
try {
  const name = new URL(process.env.TEST_FINANCE_DOCUMENT_DATABASE_URL).pathname.slice(1);
  const marker = process.env.EMDO_POSTGRES_INTEGRATION_DATABASE_ATTESTATION;
  if (!/^emdo_ci_finance_document_knowledge_[0-9a-f]{12}$/.test(name) ||
      !/^emdo-postgres-suite-v1:finance-document-knowledge:[0-9a-f]{32}$/.test(marker))
    throw new Error('Invalid disposable database binding');
  await client.query(`comment on database "${name}" is '${marker}'`);
} finally { await client.end(); }
JS
pnpm exec vitest run \
  packages/db/src/finance/postgres-finance-document-repository.integration.test.ts \
  apps/api/src/production/finance-synthetic-staging-runtime.integration.test.ts \
  --no-file-parallelism

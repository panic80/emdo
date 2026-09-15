#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"
container="emdo-finance-v2-check-$$"
cleanup() { docker rm -f -v "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Disposable synthetic database only; no host data mounts or persistent application credentials.
docker run --detach --rm --name "$container" --publish 127.0.0.1::5432 \
  --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB=emdo_finance_live_normalization \
  pgvector/pgvector@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
port="$(docker port "$container" 5432/tcp | sed 's/.*://')"
export FINANCE_V2_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:${port}/emdo_finance_live_normalization"
export FINANCE_AUTOMATION_TEST_DATABASE_URL="$FINANCE_V2_TEST_DATABASE_URL"
export FINANCE_GENERATED_REPORT_TEST_DATABASE_URL="$FINANCE_V2_TEST_DATABASE_URL"
node --input-type=module <<'JS'
import pg from './packages/db/node_modules/pg/lib/index.js';
import fs from 'node:fs/promises';
const client=new pg.Client(process.env.FINANCE_V2_TEST_DATABASE_URL);
await client.connect();
try {
  const {entries}=JSON.parse(await fs.readFile('packages/db/drizzle/meta/_journal.json','utf8'));
  for(const {tag} of entries) {
    await client.query('begin');
    try { await client.query(await fs.readFile(`packages/db/drizzle/${tag}.sql`,'utf8')); await client.query('commit'); }
    catch(error) { await client.query('rollback'); throw error; }
  }
  console.log(`Applied ${entries.length} migrations to isolated PostgreSQL 18.`);
} finally {await client.end();}
JS
if [[ "${EMDO_FINANCE_LIVE_PROVIDER_CHECK:-}" == "1" ]]; then
  node --env-file=.env.local node_modules/vitest/vitest.mjs run apps/worker/src/finance-live-normalization.integration.test.ts --maxWorkers=1 --minWorkers=1
else
  node node_modules/vitest/vitest.mjs run apps/worker/src/finance-live-normalization.integration.test.ts --maxWorkers=1 --minWorkers=1
fi

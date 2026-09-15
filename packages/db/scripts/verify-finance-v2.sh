#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$repo_root"
container="emdo-finance-v2-check-$$"
cleanup() { docker rm -f -v "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Disposable synthetic database only; no host data mounts or persistent application credentials.
docker run --detach --rm --name "$container" --publish 127.0.0.1::5432 \
  --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB=emdo_finance_v2 \
  pgvector/pgvector@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
port="$(docker port "$container" 5432/tcp | sed 's/.*://')"
export FINANCE_V2_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:${port}/emdo_finance_v2"
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
pnpm exec vitest run packages/db/src/finance-import-lineage.integration.test.ts packages/db/src/finance-tax-entity-binding.integration.test.ts packages/db/src/finance-tax-canada-donations.integration.test.ts packages/db/src/finance-tax-mexico.integration.test.ts packages/db/src/finance-journal-draft.integration.test.ts packages/db/src/finance-investment-reconciliation.integration.test.ts apps/worker/src/finance-extraction-automation-postgres.test.ts apps/worker/src/finance-pdf-ocr-postgres.test.ts packages/db/src/finance-pdf-ocr-reader.integration.test.ts packages/db/src/finance-corporate-action-settlement.integration.test.ts packages/db/src/finance-account-source-assignment.integration.test.ts packages/db/src/finance-fec.integration.test.ts packages/db/src/finance-cash-dividend.integration.test.ts packages/db/src/finance-ofx.integration.test.ts packages/db/src/finance-planning-automation.integration.test.ts packages/db/src/finance-legacy-migration-constraints.integration.test.ts packages/db/src/finance-legacy-migration.integration.test.ts packages/db/src/finance-planning.integration.test.ts packages/db/src/finance-v2.integration.test.ts packages/db/src/finance-report-source.integration.test.ts packages/db/src/finance-normalized-components.integration.test.ts packages/db/src/finance-commercial.integration.test.ts packages/db/src/finance-structured-invoice.integration.test.ts packages/db/src/finance-tax.integration.test.ts packages/db/src/finance-tax-runs.integration.test.ts packages/db/src/finance-automation.integration.test.ts packages/db/src/finance-schedule.integration.test.ts packages/db/src/finance-corporate-actions.integration.test.ts packages/db/src/finance-corporate-action-revision.integration.test.ts packages/db/src/migration-snapshot-chain.test.ts apps/worker/src/finance-trial-balance-postgres.test.ts apps/worker/src/finance-standardization-postgres.test.ts --maxWorkers=1 --minWorkers=1

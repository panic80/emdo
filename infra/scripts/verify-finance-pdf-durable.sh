#!/bin/bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"
proof_dir=$(mktemp -d "${TMPDIR:-/tmp}/emdo-pdf-durable.XXXXXX")
name="emdo-pdf-durable-$$"
cleanup() { docker rm -f -v "$name-client" "$name-helper" "$name-renderer" "$name-artifact" "$name-pg" >/dev/null 2>&1 || true; docker volume rm "$name-socket" "$name-render-socket" >/dev/null 2>&1 || true; docker network rm "$name-network" >/dev/null 2>&1 || true; rm -rf "$proof_dir"; }
trap cleanup EXIT
apps/worker/node_modules/.bin/esbuild apps/worker/src/finance-pdf-durable.acceptance.ts --bundle --platform=node --format=esm --external:pdf-parse --external:pdfjs-dist --banner:js="import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);" --outfile="$proof_dir/client.mjs"
apps/worker/node_modules/.bin/esbuild packages/integrations/src/finance-documents/pdf-report-worker.ts --bundle --platform=node --format=esm --external:pdfjs-dist --external:pdfjs-dist/* --outfile="$proof_dir/pdf-report-worker.js"
node infra/finance-pdf-render/durable-fixture.mjs "$proof_dir/statement.pdf"
printf '%s' '{"type":"module"}' > "$proof_dir/package.json"
chmod 755 "$proof_dir"
chmod 644 "$proof_dir/client.mjs" "$proof_dir/statement.pdf"
image_id=$(docker image inspect "${EMDO_OCR_IMAGE:-emdo-finance-ocr:local-integration}" --format '{{.Id}}')
renderer_id=$(docker image inspect "${EMDO_PDF_RENDER_IMAGE:-emdo-finance-pdf-render:local-foundation}" --format '{{.Id}}')
docker create --platform linux/amd64 --name "$name-artifact" "$renderer_id" >/dev/null
docker cp "$name-artifact:/opt/emdo/pdf-render/node_modules" "$proof_dir/node_modules"
docker rm "$name-artifact" >/dev/null
docker network create --internal "$name-network" >/dev/null
docker run -d --rm --name "$name-pg" --network "$name-network" --network-alias postgres --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB=emdo_image_acceptance pgvector/pgvector@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a >/dev/null
for attempt in $(seq 1 30); do if docker exec "$name-pg" pg_isready -U postgres >/dev/null 2>&1; then break; fi; sleep 1; done
docker exec "$name-pg" pg_isready -U postgres >/dev/null
node --input-type=module > "$proof_dir/migrations.sql" <<'JS'
import fs from 'node:fs/promises';
const {entries}=JSON.parse(await fs.readFile('packages/db/drizzle/meta/_journal.json','utf8'));
for (const {tag} of entries) console.log('SET client_min_messages TO error;\nBEGIN;\n'+await fs.readFile(`packages/db/drizzle/${tag}.sql`,'utf8')+'\nCOMMIT;');
JS
docker exec -i "$name-pg" psql -U postgres -d emdo_image_acceptance -v ON_ERROR_STOP=1 -q < "$proof_dir/migrations.sql" >/dev/null
docker run --platform linux/amd64 -d --rm --name "$name-helper" --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 32 --memory 128m --cpus 1 --tmpfs /tmp:size=64m,noexec,nosuid,nodev,mode=0700,uid=10003,gid=10004 --volume "$name-socket:/run/emdo/finance-ocr" "$image_id" >/dev/null
for attempt in $(seq 1 20); do if docker exec "$name-helper" test -S /run/emdo/finance-ocr/helper.sock; then break; fi; sleep 0.25; done
docker exec "$name-helper" test -S /run/emdo/finance-ocr/helper.sock
docker run --platform linux/amd64 -d --rm --name "$name-renderer" --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 32 --memory 256m --cpus 1 --tmpfs /tmp:size=64m,noexec,nosuid,nodev,mode=0700,uid=10005,gid=10005 --volume "$name-render-socket:/run/emdo/finance-pdf-render" "$renderer_id" >/dev/null
for attempt in $(seq 1 20); do if docker exec "$name-renderer" test -S /run/emdo/finance-pdf-render/helper.sock; then break; fi; sleep 0.25; done
docker exec "$name-renderer" test -S /run/emdo/finance-pdf-render/helper.sock
docker inspect "$name-renderer" --format 'renderer image={{.Image}} network={{.HostConfig.NetworkMode}} readonly={{.HostConfig.ReadonlyRootfs}} user={{.Config.User}} caps={{json .HostConfig.CapDrop}}'
docker inspect "$name-helper" --format 'helper image={{.Image}} network={{.HostConfig.NetworkMode}} readonly={{.HostConfig.ReadonlyRootfs}} user={{.Config.User}} caps={{json .HostConfig.CapDrop}}'
docker run --platform linux/amd64 --rm --name "$name-client" --network "$name-network" --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 10002:10004 --group-add 10005 --env FINANCE_V2_TEST_DATABASE_URL=postgresql://postgres@postgres/emdo_image_acceptance --volume "$name-socket:/run/emdo/finance-ocr:ro" --volume "$name-render-socket:/run/emdo/finance-pdf-render:ro" --volume "$proof_dir:/proof:ro" --entrypoint /usr/local/bin/node "$image_id" /proof/client.mjs

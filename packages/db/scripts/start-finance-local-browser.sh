#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"
umask 077
fixture_dir="$(mktemp -d /tmp/emdo-finance-browser.XXXXXX)"
container="emdo-finance-browser-$$"
cleanup() {
  docker rm -f -v "$container" >/dev/null 2>&1 || true
  # This directory is created by this invocation and contains synthetic credentials.
  for artifact in login.json key.pem cert.pem server.mjs node_modules; do
    if [[ -e "$fixture_dir/$artifact" || -L "$fixture_dir/$artifact" ]]; then
      rm -- "$fixture_dir/$artifact"
    fi
  done
  rmdir -- "$fixture_dir"
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$fixture_dir/key.pem" -out "$fixture_dir/cert.pem" -days 2 -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' >/dev/null 2>&1
docker run --detach --rm --name "$container" --label emdo.synthetic-local-finance=true --publish 127.0.0.1::5432 --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB=emdo_app pgvector/pgvector@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
binding="$(docker port "$container" 5432/tcp)"
[[ "$binding" == 127.0.0.1:* ]] || exit 1
[[ "$(docker inspect --format '{{index .Config.Labels "emdo.synthetic-local-finance"}}' "$container")" == true ]] || exit 1
export FINANCE_LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:${binding##*:}/emdo_app"
export FINANCE_LOCAL_DIRECTORY="$fixture_dir"
export FINANCE_LOCAL_CONTAINER_ATTESTED=true
printf 'Synthetic fixture directory: %s\nContainer: %s\n' "$fixture_dir" "$container"
node apps/worker/build.mjs
node --input-type=module <<'JS'
import { build } from './apps/api/node_modules/esbuild/lib/main.js';
import { createRequire } from 'node:module';
const require=createRequire(new URL('./apps/api/package.json',import.meta.url));
await build({entryPoints:['apps/api/src/cli/finance-local-browser-acceptance.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:process.env.FINANCE_LOCAL_DIRECTORY+'/server.mjs',plugins:[{name:'workspace',setup(b){b.onResolve({filter:/^@emdo\//},a=>({path:require.resolve(a.path)}));}}]});
JS
# Bundle external dependencies resolve from API's installed dependency tree.
ln -s "$repo_root/apps/api/node_modules" "$fixture_dir/node_modules"
node "$fixture_dir/server.mjs"

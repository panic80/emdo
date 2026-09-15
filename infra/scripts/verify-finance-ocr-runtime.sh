#!/bin/bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"
proof_dir=$(mktemp -d "${TMPDIR:-/tmp}/emdo-ocr-proof.XXXXXX")
client_name="emdo-ocr-client-$$"
helper_name="emdo-ocr-proof-$$"
socket_volume="emdo-ocr-proof-$$"
cleanup() { docker rm -f "$client_name" "$helper_name" >/dev/null 2>&1 || true; docker volume rm "$socket_volume" >/dev/null 2>&1 || true; rm -rf "$proof_dir"; }
trap cleanup EXIT
apps/worker/node_modules/.bin/esbuild infra/finance-ocr/verify-runtime.ts --bundle --platform=node --format=esm --outfile="$proof_dir/client.mjs"
cp infra/finance-ocr/fixtures/financial-text.png "$proof_dir/financial-text.png"
chmod 755 "$proof_dir"
chmod 644 "$proof_dir/client.mjs" "$proof_dir/financial-text.png"
image_id=$(docker image inspect "${EMDO_OCR_IMAGE:-emdo-finance-ocr:local-integration}" --format '{{.Id}}')
docker run --platform linux/amd64 -d --rm --name "$helper_name" --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 32 --memory 128m --cpus 1 --tmpfs /tmp:size=64m,noexec,nosuid,nodev,mode=0700,uid=10003,gid=10004 --volume "$socket_volume:/run/emdo/finance-ocr" "$image_id" >/dev/null
for ((attempt = 0; attempt < 20; attempt++)); do
 if docker exec "$helper_name" test -S /run/emdo/finance-ocr/helper.sock; then break; fi
 sleep 0.25
done
docker inspect "$helper_name" --format 'sandbox={{.HostConfig.NetworkMode}} readonly={{.HostConfig.ReadonlyRootfs}} user={{.Config.User}} caps={{json .HostConfig.CapDrop}}'
docker exec "$helper_name" test -S /run/emdo/finance-ocr/helper.sock
docker run --platform linux/amd64 --name "$client_name" --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 10002:10004 --volume "$socket_volume:/run/emdo/finance-ocr:ro" --volume "$proof_dir:/proof:ro" --entrypoint /usr/local/bin/node "$image_id" /proof/client.mjs

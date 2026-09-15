#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
command -v docker >/dev/null
command -v age >/dev/null
command -v age-keygen >/dev/null
# The test creates its own loopback-only synthetic container. No user DB URL is accepted.
EMDO_FINANCE_RESTORE_DRILL=1 pnpm exec vitest run packages/db/src/finance-backup-restore.integration.test.ts --maxWorkers=1 --minWorkers=1

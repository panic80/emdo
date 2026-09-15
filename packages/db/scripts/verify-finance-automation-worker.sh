#!/usr/bin/env bash
# Explicit local-only drill: creates and removes its own localhost Docker PG.
# No existing database, provider keys or deployed worker is accepted.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../.." && pwd)"
cd "$repo_root"
EMDO_FINANCE_AUTOMATION_WORKER_DRILL=1 pnpm exec vitest run apps/worker/src/finance-automation-production.integration.test.ts

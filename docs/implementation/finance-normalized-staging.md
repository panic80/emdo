# Normalized Finance private staging

This is the opt-in acceptance lane for the current Finance work. Canada returns
and investments remain WIP/paused. It does not enable schedules or generic
provider integrations, and its probe result is not production release approval.

## Governed workflow

The `On-demand staging` workflow now accepts `finance_normalized_staging=true`
together with `finance_synthetic_staging=true`. Supply explicit integer
`finance_normalized_run_budget` and `finance_normalized_day_budget` in CAD minor
units: run 1–100, day at least the run limit and at most 500. Empty budgets are
required when normalized mode is off. These are spending ceilings, not pricing;
the existing dedicated provider key, pricing version and reviewed Astra input/
output rates must be configured separately. Live conversational chat remains an
independent opt-in.

The fixed root-owned staging operator must be updated to this reviewed version
before it can accept the new arguments. A signed candidate archive does not
automatically replace that installed operator. Existing same-commit `main` CI/
publish checks, image digest locks, archive signatures, host isolation and TTL
requirements still apply. Local dirty-worktree candidate images do not satisfy
those release gates. No workflow was dispatched as part of local validation.

For this mode the launcher prepares private run-scoped configuration, checks the
complete effective Compose environment before starting services, captures the
synthetic seed output, creates its exclusive normalized handoff, provisions only
the exact unposted synthetic book within the chosen ceilings, and starts the
fourth overlay. Acceptance saves a separate source/run/book-bound
`finance-normalized-synthetic-staging-probe.json` with `releaseEligible:false`;
it cannot substitute for the original full release or restore evidence.
Teardown reloads the same mode from protected run state and checks that its
additional egress network is absent.

Normalized staging requires at least **2.25 GiB available memory** and 10 GiB
free disk. Its Compose caps total 1760 MiB steady state and 1952 MiB while the
acceptance process runs. The baseline memory gate remains 1.75 GiB.

The lower-level manual steps below remain useful for inspecting configuration
and reproducing the individual checks; the governed launcher now performs their
configuration, seed/handoff and provision sequence.

## Configuration and order

Use a fresh disposable staging database/project and images bound to the exact
source being reviewed. Keep the existing staging provenance, migration,
restricted-role and Finance synthetic-auth setup. The staging launcher includes this lane only when normalized staging is
explicitly selected. It remains off by default.

Combine `infra/compose/compose.yml`, `compose.staging.yml`,
`compose.finance-staging.yml`, and `compose.finance-normalized-staging.yml` in
that order. Set `EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING=true` explicitly.
The normalized overlay requires separate run-scoped API and worker env files;
the API file appends to its earlier layers, while the worker file replaces its
base env file and must carry the worker's complete required configuration.

Before starting services, validate complete **effective** API and worker env
files after applying all layers and explicit environment overrides:

```sh
node infra/scripts/finance-normalized-staging-preflight.mjs \
  --api-env /absolute/run/api-effective.env \
  --worker-env /absolute/run/worker-effective.env \
  --database-target postgresql://postgres:5432/emdo_app
```

Replace the database target with this run's credential-free host/port/database.
Input files must be private, owned regular files. The check covers normalized
Finance flags, restricted process identity names and database target, matching
valid evidence keyrings, and provider/pricing configuration completeness.
It does not connect to the database/provider, verify actual grants, validate the
commercial accuracy of prices, or replace general API/auth configuration checks.
The production standardization hook selects Astra with medium reasoning.

Run `seed-synthetic` with its normal `--fail-if-nonempty --staging-only` arguments
plus `--finance-normalized-synthetic-gates`. Preserve its successful JSON output
in a private run file. The opt-in seed creates a synthetic CAD book, distinct
cash/equity/financial accounts and an open 2026 period through authenticated v2
routes. It also retains the existing three synthetic domain operations.

The overlay requires an existing fixture env file during Compose rendering.
During bootstrap, point `FINANCE_NORMALIZED_STAGING_FIXTURE_ENV_FILE` at a
private empty placeholder and do not start `staging-acceptance`. After seeding,
write a **new** validated handoff:

```sh
EMDO_ENVIRONMENT=staging \
EMDO_SYNTHETIC_DATA_ONLY=true \
EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING=true \
node infra/scripts/finance-normalized-staging-handoff.mjs \
  --seed-result /absolute/run/seed.json \
  --output /absolute/run/normalized-fixture.env
```

Set `FINANCE_NORMALIZED_STAGING_FIXTURE_ENV_FILE` to that new file before running
acceptance. The helper writes only the four validated UUIDs, uses exclusive
mode-0600 creation, and does not overwrite previous handoffs.

Execute `infra/scripts/finance-normalized-staging-provision.sql` through the
deployment-owner connection with `ON_ERROR_STOP=1` and all named parameters
documented at its top. Supply the exact seed book/workspace, synthetic household
slug and `.invalid` owner email. Readiness and entitlement writes require an
otherwise isolated, unposted synthetic book. Choose explicit positive run/day
limits within the script's fixed ceilings; never invent pricing to fit a budget.
Start the general worker with the shared evidence keyring and authorized provider
configuration, then run the normalized acceptance service.

## What acceptance proves

The command uses the authored two-row CSV to check original bytes, durable
proposal/source binding, explicit source review, mapping approval, row review,
two balanced postings, duplicate commit, and EMDO-to-Finance saved readback.
Unknown source questions, missing values or changed lineage stop the probe.
It preserves eight transaction/journal/line records with exact decimal strings.
Successful posting makes that book nonempty; use a fresh disposable fixture for
another complete acceptance run.

## Reviewing new model questions in the same run

Without extra configuration, unfamiliar questions stop the probe. To inspect
and answer them without restarting or invoking the provider again, explicitly
set `EMDO_FINANCE_NORMALIZED_SYNTHETIC_REVIEW_DIRECTORY` to a canonical absolute
directory owned by the acceptance process with mode `0700`. For container runs,
provide a writable bind mount for this private directory and set the variable to
its container path. The existing overlay does not mount an optional review
directory automatically. Add `--volume` and `--env` options to the existing
Compose `run` invocation; ownership must match the container's acceptance user.

After validating the exact authored source and proposed mapping, the CLI writes
`<runId>.request.json`, logs the review path and waits at most 180 seconds. Inspect
its complete `sourceText`, `mappingDefinition` and every question. Publish a
mode-`0600`, non-symlink, single-link `<runId>.review.json` containing:

```json
{
  "schemaVersion": 1,
  "decision": "approve-authored-synthetic-mapping",
  "binding": "COPY THE COMPLETE binding OBJECT FROM THE REQUEST HERE",
  "answers": [
    {
      "question": "EXACT FIRST QUESTION",
      "answer": "YOUR SOURCE-BACKED ANSWER"
    }
  ],
  "rationale": "YOUR EXPLICIT REVIEW OF THIS AUTHORED SOURCE AND MAPPING"
}
```

The displayed `binding` string is a placeholder: replace it with the actual
request object, unchanged. Supply one answer for every question in its original
order. The binding includes the exact run, book, evidence, source digest, mapping
revision/definition digest, one-time challenge and expiry. Do not approve an
unknown fact or change the source to obtain a pass. Finish the file privately and
publish it atomically; the reader rejects partial or changed files. The CLI saves
an accepted-review receipt and its digest, rechecks the persisted run/mapping,
then uses the existing public review/link/approval flow. Stale, mismatched or
expired reviews fail closed. The user-facing Finance UI remains the normal
review path; this directory protocol is only for the synthetic staging probe.

Local reproducible checks:

- `bash packages/db/scripts/verify-finance-normalized-staging-cli.sh` — real
  restricted PostgreSQL/Fastify workflow with explicit test adapters; see the
  implementation record for the exact adapter boundaries.
- `EMDO_FINANCE_NORMALIZED_PROVISION_DRILL=1 pnpm exec vitest run packages/db/src/finance-normalized-staging-provision.integration.test.ts --maxWorkers=1 --minWorkers=1`
  — actual provisioning SQL and denial/rollback checks in disposable PostgreSQL.
- `pnpm exec vitest run infra/tests/finance-normalized-staging-compose.test.ts infra/tests/finance-normalized-staging-handoff.test.ts infra/tests/finance-normalized-staging-preflight.test.ts --maxWorkers=1 --minWorkers=1`
  — Compose merge, handoff and static configuration checks.

An uninterrupted local live-provider-to-posting check now passes; it is separate
from the real-authenticated CLI probe. No uninterrupted live-provider private
staging execution or production rollout is established. Current evidence and remaining release
gates are tracked in [workspace-finance-v2.md](workspace-finance-v2.md).

# Production Voice Provider Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Compose a real, fail-closed production `VoiceGateway` from the existing OpenAI audio adapter, PostgreSQL spend ledger, and a server-trusted in-memory media inspector.

**Architecture:** Untrusted audio is classified and timed inside a deadline-bound worker with no filesystem access. Every provider operation creates a fresh request-bound spend guard from the authenticated principal, canonical input hashes, and `PostgresSpendLedger`. Strict API-only configuration supplies the OpenAI key, speech model, and versioned integer-CAD pricing. Durable receipt transitions, spend transitions, provider dispatch, shutdown, and evidence stay fail-closed and independently verifiable.

**Tech Stack:** Node.js 24 ESM, TypeScript, Fastify, Zod, PostgreSQL 17, `file-type` 22.0.1, `music-metadata` 11.14.0, Vitest, esbuild.

**Design:** `docs/plans/2026-08-15-production-voice-provider-design.md`

**Execution rule:** Run one Node, PostgreSQL, build, or browser command at a time. Every production behavior begins with one focused expected RED and is rerun GREEN before continuing.

---

## Task 1: Deterministic integer-CAD audio pricing

**Files:**

- Create: `packages/integrations/src/openai/cost-calculator.test.ts`
- Create: `packages/integrations/src/openai/cost-calculator.ts`
- Modify: `packages/integrations/src/openai/index.ts`
- Modify: `packages/integrations/src/package-exports.test.ts`

**Step 1:** Add failing tests for strict base64url JSON parsing, exact schema/model keys, canonical re-encoding, positive safe integer limits, distinct pricing versions, per-model transcription minute rates, per-model speech character rates, ceiling to a positive CAD cent, and overflow rejection.

**Step 2:** Run one serialized focused test:

```bash
pnpm exec vitest run packages/integrations/src/openai/cost-calculator.test.ts packages/integrations/src/package-exports.test.ts --pool=forks --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=1 --cache=false
```

Expect missing exports/source failures only.

**Step 3:** Implement `parseOpenAiAudioPricing` and `ProductionOpenAiAudioCostCalculator` with integer multiplication and ceiling division. Transcription estimate/actual uses verified milliseconds; speech estimate/actual uses validated characters. Reject unknown keys, unsafe arithmetic, zero/negative values, malformed base64url, and pricing documents over the bounded encoded/decoded sizes.

**Step 4:** Rerun the focused command; expect pass. Run targeted ESLint/Prettier and `git diff --check`.

## Task 2: Server-trusted in-memory media inspector

**Files:**

- Create: `apps/api/src/production/audio-inspector.test.ts`
- Create: `apps/api/src/production/audio-inspector.ts`
- Create: `apps/api/src/production/audio-inspector-worker.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/api/build.mjs`
- Modify: `apps/api/src/packaging.test.ts`

**Step 1:** Add failing tests for real generated WAV bytes, all allowed detected-type mappings through an injected worker result, MIME mismatch, malformed/empty data, missing/non-finite duration, client-duration disagreement, duration over 60 seconds, worker timeout/abnormal exit, exact safe result shape, parent input preservation, and worker-owned byte zeroization.

**Step 2:** Run only the inspector test with one fork and confirm the missing implementation RED.

**Step 3:** Add exact production dependencies:

```bash
pnpm --filter @emdo/api add --save-exact file-type@22.0.1 music-metadata@11.14.0
```

Allow that single package-manager process to exit before any test begins.

**Step 4:** Implement the worker parser with `fileTypeFromBuffer`, `parseBuffer`, `duration: true`, `skipCovers: true`, an exact MIME alias table, a required audio format/duration, and `finally` zeroization. Implement the parent with a copied transferable buffer, fixed deadline, abnormal-message rejection, guaranteed termination, no logs, and bounded error mapping.

**Step 5:** Add `audio-inspector-worker` as an explicit API build entry, add both external packages to the build allowlist, and require the worker artifact in packaging tests. Prove the bundle contains no source paths and the pruned production package can resolve both runtime dependencies.

**Step 6:** Rerun inspector and packaging tests, then the API package build, sequentially. Expect pass.

## Task 3: Exact PostgreSQL spend readiness boundary

**Files:**

- Create: `packages/db/drizzle/0014_audio_spend_readiness.sql`
- Create: `packages/db/drizzle/meta/0014_snapshot.json`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Create: `packages/db/src/agent/audio-spend-readiness-migration.test.ts`
- Create: `packages/db/src/agent/audio-spend-readiness.integration.test.ts`
- Modify: `packages/db/src/agent/spend-ledger.ts`
- Modify: `packages/db/src/agent/spend-ledger.test.ts`
- Modify: `packages/db/src/api.ts`
- Modify: `packages/db/src/package-exports.test.ts`
- Modify: `packages/db/src/migration-runner.test.ts`
- Modify: `packages/db/src/migration-snapshot-chain.test.ts`
- Modify: `packages/db/src/finance/finance-import-retention-runner.integration.test.ts`

**Step 1:** Add static RED tests for journal position 0014, unchanged-schema snapshot continuity, exact role ownership, forced-RLS spend relations, fixed `search_path`, `row_security=on`, application EXECUTE-only access, PUBLIC denial, and rejection of unexpected role membership/table/function grants.

**Step 2:** Add a failing unit contract for `checkPostgresAudioSpendReadiness(pool)` that accepts only the literal database boolean `true` from the exact readiness routine.

**Step 3:** Run the focused migration, ledger, journal, snapshot, and export tests in one fork; confirm only the missing 0014/readiness contract fails.

**Step 4:** Implement additive 0014 without changing spend behavior. The readiness function must be owned by the isolated metering executor, use fixed configuration, inspect all relevant roles/relations/routines/ACLs, reject PUBLIC or unexpected effective rights, and grant the application only readiness EXECUTE.

**Step 5:** Add the repository probe/export and mechanically create the identical-schema 0014 snapshot successor. Rerun the focused tests.

**Step 6:** Start one disposable PostgreSQL 17 instance with a low connection cap. Apply 0000 through 0014, exercise reserve/dispatch/release/settle plus readiness, drift one ACL/config/role invariant at a time, restore it, and prove cross-household denial. Stop and remove the instance before continuing.

## Task 4: Production voice gateway and spend adapter

**Files:**

- Create: `apps/api/src/production/voice-services.test.ts`
- Create: `apps/api/src/production/voice-services.ts`
- Modify: `apps/api/src/services/contracts.ts` only if a narrow close/readiness type is required

**Step 1:** Add RED tests for all-or-nothing configuration, safe diagnostics, speech model/configuration version, exact principal/request/audio-digest hashes, request-bound `PostgresSpendLedger`, CAD 50/75 threshold calls, reserve/dispatch/settle/release status mapping, model/attempt mapping, adapter safe-error mapping, speech byte ownership, readiness coalescing/cache/timeout, late result disposal, reject-new/drain-active close, and no provider call at construction.

**Step 2:** Run only `voice-services.test.ts` in one fork and confirm the missing factory RED.

**Step 3:** Implement `createProductionVoiceProviderBinding`. Parse config into frozen values and promptly zero temporary decoded buffers. Keep the transport/calculator/inspector shared, but construct a fresh principal-bound ledger/spend guard/adapter per provider call. Hash only canonical bounded data; use an audio SHA-256 digest, never retained audio bytes. Map all output through strict schemas and dispose speech bytes on every rejected mapping.

**Step 4:** Implement readiness as the conjunction of inspector self-test, `checkPostgresAudioSpendReadiness`, and the adapter's bounded model catalog check. Deduplicate one in-flight check and cache only a short result. Implement close as mark-closed, reject-new, await-active, then dispose references.

**Step 5:** Rerun the focused test; expect pass. Run targeted lint/format/diff checks.

## Task 5: Durable and authenticated production composition

**Files:**

- Modify: `apps/api/src/production/durable-services.ts`
- Modify: `apps/api/src/production/durable-services.test.ts`
- Modify: `apps/api/src/production/assemble-services.ts`
- Modify: `apps/api/src/production/assemble-services.test.ts`
- Modify: `apps/api/src/production/create-services.test.ts`
- Modify: `apps/api/src/app.integration.test.ts`

**Step 1:** Add RED tests proving the database pool and complete voice environment create exactly one voice composition; partial/malformed config creates none; voice close drains before database close; `voice.provider` remains unavailable without trusted authentication even when provider config is valid; and trusted authentication admits the complete binding and readiness probe.

**Step 2:** Add route RED tests proving a provider failure is not reported after `releaseKnownNoDispatch` or `markIndeterminate` persistence fails. The response must be the bounded indeterminate contract, and completion failure must attempt the durable indeterminate transition exactly once.

**Step 3:** Run only the durable/assembly/create-services/app integration tests in one fork and confirm the expected missing composition/transition failures.

**Step 4:** Add the voice dependency/factory to durable composition, include its close before database close, admit `voice` through the explicit assembly allowlist, and add it to the trusted-auth-only set. Never synthesize a principal or expose the provider when authentication is unavailable.

**Step 5:** Remove swallowed durable transition errors in the voice route. On any failed terminal transition, attempt the appropriate indeterminate transition once and return the bounded `audio-request-indeterminate` response regardless of internal error text.

**Step 6:** Rerun the focused tests and confirm `voice.provider` is truthfully ready only for the complete graph.

## Task 6: Deployment and evidence boundaries

**Files:**

- Modify: `infra/scripts/_common.sh`
- Modify: `infra/compose/compose.yml`
- Modify: `infra/compose/compose.staging.yml`
- Modify: `infra/compose/compose.test.ts`
- Modify: `infra/scripts/hostinger-common.test.ts`
- Modify: `.env.example`
- Modify: `docs/deployment/secrets.md`
- Modify: `docs/deployment/api-production-composition-blockers.md`
- Modify: `docs/deployment/acceptance-evidence.md`
- Modify: `docs/release/mvp-acceptance.md`

**Step 1:** Add RED static tests proving only the API service accepts the three audio provider settings, worker and all auxiliary containers do not, synthetic staging rejects every OpenAI audio variable, and no secret value appears in rendered config/diagnostics.

**Step 2:** Add the production API allowlist/config plumbing and documentation. Do not enable provider config in synthetic staging. Document exact generation/rotation expectations for the versioned pricing document and keep provider endpoint smokes absent until externally run.

**Step 3:** Update the blocker and acceptance ledgers truthfully: local source composition can be complete while OpenAI transcription, speech, browser WebM, staging, and production receipts remain pending.

**Step 4:** Rerun the focused infra/static tests, ShellCheck, targeted formatting, and `git diff --check`.

## Task 7: Serialized aggregate verification and review

**Step 1:** Run all new focused suites once with one worker/fork and no cache.

**Step 2:** Run sequentially:

```bash
pnpm typecheck
pnpm lint
pnpm test:package
pnpm --filter @emdo/api build
pnpm --filter @emdo/api check:package
pnpm test
```

Do not run these concurrently. Record exact failures and fix only batch-owned regressions.

**Step 3:** Run the isolated PostgreSQL 17 integration once more against the final source and remove the instance. Do not claim provider or browser evidence from this database run.

**Step 4:** Request one independent Terra review covering media parsing/worker isolation, spend hashes and ACLs, durable transition ambiguity, auth-gated composition, shutdown, package closure, and evidence wording. Address Critical/Important findings with focused RED tests.

**Step 5:** Commit the implementation, push `codex/emdo-mvp`, and verify exact-SHA CI. Keep the overall MVP open: real OpenAI endpoint smokes, real browser recording/storage, authenticated staging/production, the complete agent runtime, and worker provider graph remain separate blockers.

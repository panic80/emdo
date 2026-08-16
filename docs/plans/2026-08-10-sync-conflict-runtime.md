# Deterministic Sync Conflict Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every canonical offline upload enforce deterministic domain invariants and settle terminal browser conflicts without infinite pending retries.

**Architecture:** A pure domain resolver maps strict sync envelopes to existing conflict reducers. PostgreSQL invokes that resolver while holding the canonical entity lock, stores a replayable bounded outcome, and returns it through strict API contracts. The encrypted browser queue atomically accepts, retries, or terminalizes each operation and rolls back only its exact optimistic projection.

**Tech Stack:** TypeScript, Zod, Vitest, Fastify, PostgreSQL/Drizzle, React, encrypted PowerSync SQLite.

---

### Task 1: Strict deterministic domain resolver

**Files:**
- Create: `packages/domains/src/shared/sync-conflict-runtime.ts`
- Create: `packages/domains/src/shared/sync-conflict-runtime.test.ts`
- Modify: `packages/domains/package.json`
- Modify: `packages/domains/src/package-exports.test.ts`

**Steps:**

1. Write failing table-driven tests for conversation append, strict finance creation plus adjustment/reversal, budget and scheduler three-way merge, shopping delta/tombstone, invalid envelopes, unsupported entities, bounded conflict fields, and `providerWrites: []`.
2. Run `pnpm exec vitest run packages/domains/src/shared/sync-conflict-runtime.test.ts` and confirm the missing resolver/export failure.
3. Implement strict Zod envelopes and a pure resolver that delegates to the existing audited reducers and strips raw conflict values from its bounded result.
4. Rerun the focused domain test and `packages/domains/src/package-exports.test.ts`; expect all tests to pass.

### Task 2: Locked repository integration and durable outcomes

**Files:**
- Create: `packages/db/src/sync/sync-conflict-outcomes-migration.test.ts`
- Create: `packages/db/drizzle/0006_sync_conflict_outcomes.sql`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/drizzle/meta/0006_snapshot.json`
- Modify: `packages/db/package.json`
- Modify: `packages/db/src/sync/processor.ts`
- Modify: `packages/db/src/sync/postgres-repository.ts`
- Modify: `packages/db/src/sync/postgres-repository.test.ts`
- Modify: `packages/db/src/sync/processor.test.ts`

**Steps:**

1. Write failing repository tests proving the resolver receives locked canonical payload/revision, conflict-free merges update once, terminal conflicts do not mutate, exact receipts replay resolution/details, and no generic merge/delta helper can bypass the resolver.
2. Write a failing static migration test for additive bounded JSON outcome metadata, an append-only/RLS-protected canonical entity-revision table with current-state backfill, existing protections, and journal order after `0004`/`0005`.
3. Run the focused repository/migration tests and confirm expected failures.
4. Add the `@emdo/domains/conflicts` workspace dependency and replace generic mutation application with the pure resolver inside the existing advisory-locked transaction.
5. Add immutable receipt outcome metadata and canonical entity revision snapshots in migration `0006`, Drizzle schema, journal, and snapshot without touching migration `0003`.
6. Extend processor result types and dependency semantics so merged/ignored/duplicate are successful, while retryability remains explicit.
7. Rerun focused DB tests and package typecheck; expect pass. Run live PostgreSQL tests only when an isolated configured URL is available.

### Task 3: Strict API outcomes

**Files:**
- Modify: `apps/api/src/services/contracts.ts`
- Modify: `apps/api/src/schemas.ts`
- Modify: `apps/api/src/routes/sync.ts`
- Modify: `apps/api/src/app.integration.test.ts`

**Steps:**

1. Add failing integration tests for applied resolution, bounded terminal material conflicts, retryable outcomes, omitted/raw value rejection, exact submitted-operation coverage, and service-response overflow rejection.
2. Run the focused API tests and confirm contract failures.
3. Add strict enums and a maximum of 32 conflict descriptors with field length 200; keep raw state/value data outside the API.
4. Preserve the route's exact operation-ID set validation and add disposition consistency checks.
5. Rerun the focused API integration slice and API typecheck/lint; expect pass.

### Task 4: Encrypted browser terminal settlement

**Files:**
- Modify: `apps/web/src/offline/sync-client.ts`
- Modify: `apps/web/src/offline/sync-client.test.ts`
- Modify: `apps/web/src/features/domains/domain-data.tsx`
- Modify: `apps/web/src/features/domains/domain-data.test.tsx`
- Modify: `apps/web/src/features/domains/domain-status.tsx`
- Modify: `apps/web/src/features/domains/domain-routes.component.test.tsx`

**Steps:**

1. Write failing sync-client tests proving accepted and terminal outcomes settle atomically, exact optimistic rows roll back, terminal conflicts persist across reopen, retryable outcomes remain pending, malformed/oversized responses fail closed, and dismissal removes only reviewed notices.
2. Run the focused web tests and confirm the old rejected-pending behavior fails.
3. Add encrypted `emdo_terminal_sync_conflicts`, atomic settlement, exact `last_operation_id` rollback for the mapped local-only projection table, and list/dismiss APIs.
4. Write failing provider/component tests for reload-persistent conflict surfacing and an explicit dismiss control.
5. Extend the domain runtime snapshot/context and status component to surface bounded terminal conflicts and dismiss them; do not display raw operation payloads.
6. Rerun focused web tests, web typecheck, and lint; expect pass.

### Task 5: Integrated verification

**Files:**
- Verify only; do not add evidence artifacts unless a gate actually runs.

**Steps:**

1. Run focused domains, DB sync, API sync, and web sync/component tests together.
2. Run package and root typecheck/lint for touched workspaces.
3. Run the relevant package builds.
4. If an isolated PostgreSQL URL is configured, run the new live receipt/reducer integration test; otherwise report it unverified.
5. If rendered browser validation is requested and the in-app Browser runtime is available, follow the browser skill and exercise sync -> terminal conflict -> rollback -> dismiss. Otherwise report browser evidence unrun.
6. Inspect `git diff` and `git status`; report only this slice's files and leave commit/stage integration to the root agent in the shared worktree.

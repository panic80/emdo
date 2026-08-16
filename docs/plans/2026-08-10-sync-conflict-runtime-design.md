# Deterministic Sync Conflict Runtime Design

## Scope

EMDO browser-originated offline mutations continue to enter through the authenticated canonical API only. The server resolves each operation against the locked canonical PostgreSQL entity, applies only a strict domain reducer, and never exposes a provider-write or provider-queue capability. Invalid domain envelopes and invariant-bypassing mutations become bounded terminal outcomes rather than generic JSON writes.

## Selected architecture

The deterministic resolver lives on the curated `@emdo/domains/conflicts` surface and is invoked by `PostgresSyncRepository` inside the existing entity advisory lock and transaction. The repository persists the exact terminal resolution and bounded conflict metadata with the operation receipt, so exact replays return the same outcome even after the entity changes. An append-only canonical entity-revision table stores every payload/revision snapshot; scheduler and budget merge envelopes are accepted only when their supplied base exactly matches the server snapshot for `baseRevision`.

The supported offline envelopes are deliberately narrow:

- `conversation.event`: create-only append into an immutable event ledger; client-authored audit events remain forbidden.
- `finance.transaction`: create a strict CAD record; subsequent mutations are adjustment or reversal commands only. Direct replacement/deletion cannot rewrite history.
- `finance.budget`: create a strict CAD allocation state; updates carry exact `base` and `local` states for a three-way merge against the locked remote state.
- `shopping.item`: quantity deltas and tombstones feed the immutable shopping operation ledger.
- `scheduler.item`: create a complete scheduler state; updates carry exact `base` and `local` states for a three-way merge against the locked remote state.

Other generic offline entity mutations fail closed until they have an explicit deterministic reducer. Resolver outputs contain no executable authority and assert `providerWrites: []`.

## Outcome contract

Applied outcomes include one bounded resolution: `created`, `applied`, `merged`, `ignored`, or `duplicate`. Conflict outcomes expose only bounded safe metadata: a stable code, `terminal` or `retryable` disposition, current revision when available, and at most 32 `{ field, material }` entries. Raw base/local/remote values are not returned through the API.

Only genuinely transient outcomes remain retryable. `operation-in-progress` and `dependency-missing` stay in the browser pending queue. Schema violations, material conflicts, dependency failure/cycles, idempotency reuse, tombstones, and authorization loss are terminal for that immutable operation.

## Browser lifecycle

The encrypted SQLite store settles API outcomes atomically:

1. accepted operations are removed from the pending queue;
2. terminal operations are removed, copied into an encrypted local terminal-conflict table, and the projection row whose `last_operation_id` exactly matches the rejected operation is deleted;
3. retryable operations remain pending.

Persisted terminal conflicts survive reload, appear in the domain sync status, and can be explicitly dismissed after review. Dismissal removes only the encrypted conflict notice; it cannot re-enqueue or authorize any operation. This prevents terminal operations from looping forever while preserving explicit user visibility and a deliberate remove path.

## Persistence and migration boundary

Do not edit the concurrently active migration `0003_durable_runtime_repositories.sql`. Add an additive `0006_sync_conflict_outcomes.sql` migration after audio `0004` and invitation/membership `0005`, plus coordinated journal/snapshot entries. The migration adds bounded structured outcome metadata to immutable sync receipts and an append-only, RLS-protected `sync_entity_revisions` table, backfilled from current canonical entities. It does not weaken RLS, append-only receipt rules, or canonical API-only writes. If the requested historical revision is unavailable, the operation terminalizes instead of trusting a client-supplied base.

## Verification boundaries

Unit tests prove reducer mapping, transaction-time invocation, receipt replay, API validation, encrypted terminal settlement, optimistic rollback, persisted surfacing, and dismissal. Package typecheck/lint and focused DB/API/web suites are required. PostgreSQL integration and rendered browser evidence remain separate gates and are claimed only when actually executed against those runtimes.

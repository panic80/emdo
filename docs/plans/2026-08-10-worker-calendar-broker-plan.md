# Worker Calendar Broker Contract Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Freeze a least-privilege worker-side Google Calendar sync/readback broker contract and report the exact missing-broker blocker without creating a broker, handing OAuth/vault secrets to the worker, or claiming a credentialed smoke test.

**Architecture:** The PostgreSQL worker service will load the canonical household, space, owner, connection, provider, attempt, and approval bindings inside an exact durable-operation scope, close that transaction, and then pass only frozen sanitized authority objects plus the cancellation signal to a read-only broker interface. Direct production composition remains provider-neutral and Calendar-unavailable with `worker-calendar-broker-unavailable`; a future API-owned broker must independently authenticate the worker, re-load and compare canonical bindings, keep Google grants inside the API/vault boundary, and return only the existing strict bounded result unions.

**Tech Stack:** TypeScript, Zod, Vitest, PostgreSQL worker scopes, pnpm, ESLint, Prettier, esbuild.

---

### Task 1: Prove the exact Calendar broker request contract

**Files:**
- Modify: `packages/db/src/worker/postgres-runtime.test.ts`
- Modify: `packages/db/src/worker/calendar-maintenance.ts`

**Step 1: Write the failing synchronization test**

Extend the Calendar synchronization fixture row with `provider_id`, `household_id`, `space_id`, and `original_owner_user_id`. Assert the gateway receives exactly:

```ts
{
  jobAuthority: expect.objectContaining({
    jobName: 'emdo.calendar.sync.v1',
    operationId: 'calendar-sync-operation:0001',
    queueJobId: ids.queue,
    payloadHash: 'a'.repeat(64),
    leaseToken: ids.lease,
  }),
  connectionAuthority: {
    providerId: 'google-calendar',
    connectionId: 'google-connection-42',
    householdId: ids.household,
    spaceId: ids.privateSpace,
    originalOwnerUserId: ids.user,
    syncGeneration: 9,
    sealedCursor: 'v1.old',
  },
  signal,
}
```

Also assert that the outer request, `jobAuthority`, and `connectionAuthority` are frozen and that the request has no credential/token/grant body fields.

**Step 2: Write the failing reconciliation test**

Capture the `readBackAttempt` argument and assert the preflight transaction commits before the call. Assert the broker receives exactly:

```ts
{
  jobAuthority: expect.objectContaining({
    jobName: 'emdo.calendar.reconciliation.v1',
    operationId: 'calendar-reconcile-operation:0001',
  }),
  attemptAuthority: {
    providerId: 'google-calendar',
    providerAttemptId: ids.attempt,
    decisionId: ids.decision,
    userId: ids.user,
    agentId: 'scheduler',
    runId: ids.run,
    capabilityId: 'scheduler.calendar.create',
    capabilityFingerprint: 'd'.repeat(64),
    payloadHash: 'f'.repeat(64),
    householdId: ids.household,
    spaceId: ids.privateSpace,
    connectionId: 'calendar-grant-reference-1',
    authorizationEpoch: 7,
  },
  signal,
}
```

Assert the frozen request has no `approvalBinding`, `authorityBinding`, `spaceAccessGrantId`, `disclosureGrantId`, OAuth token, client secret, encrypted grant, canonical arguments, or provider response field.

**Step 3: Run the focused test and witness RED**

Run:

```bash
pnpm --filter @emdo/db exec vitest run src/worker/postgres-runtime.test.ts
```

Expected: FAIL because the current gateway receives flat operation/connection or operation/attempt fields and does not load the canonical scope columns.

**Step 4: Add the narrow exported broker types**

In `calendar-maintenance.ts`, replace the flat gateway arguments with readonly exported `CalendarBrokerJobAuthority`, `CalendarBrokerConnectionAuthority`, and `CalendarBrokerAttemptAuthority` types. Keep `AbortSignal` outside recursive freezing. Document that the independently service-authenticated internal broker must never forward job authority to Google and must never replay a write.

**Step 5: Build requests only from validated canonical data**

Select and strictly parse `provider_id`, `household_id`, `space_id`, and `original_owner_user_id` in the sync preflight. Build `connectionAuthority` with `deepFreeze`, then freeze the outer broker request.

After the reconciliation preflight commits, derive `attemptAuthority` only from the parsed retained approval binding and attempt ID. Map the existing non-secret opaque `providerGrantReference` to `connectionId`; do not pass the full approval/authority binding or any grant/token material. Freeze the nested authority and outer request.

**Step 6: Run the focused test and witness GREEN**

Run:

```bash
pnpm --filter @emdo/db exec vitest run src/worker/postgres-runtime.test.ts
```

Expected: all tests pass; exact request-shape and transaction-order assertions are green.

### Task 2: Report the exact source-owned missing broker

**Files:**
- Modify: `apps/worker/src/providers.test.ts`
- Modify: `apps/worker/src/providers.ts`
- Modify: `apps/worker/src/health.test.ts`
- Modify: `apps/worker/src/process.test.ts`
- Modify: `apps/worker/src/production.test.ts`
- Modify: `apps/worker/build.mjs`

**Step 1: Write the failing blocker tests**

Change only the source-owned unavailable-runtime/direct-artifact expectations from `worker-calendar-adapter-unavailable` to `worker-calendar-broker-unavailable`. Preserve `worker-calendar-adapter-unavailable` for the generic enabled-composition case where no injected adapter loader exists.

**Step 2: Run the focused tests and witness RED**

Run:

```bash
pnpm --filter @emdo/worker exec vitest run src/providers.test.ts src/health.test.ts src/process.test.ts src/production.test.ts
```

Expected: FAIL because the new blocker is not in the closed blocker union/order and the built-in unavailable runtime still reports the generic adapter blocker.

**Step 3: Add the exact blocker**

Add `worker-calendar-broker-unavailable` to `WorkerProviderBlockerCode`, `BLOCKER_ORDER`, and the exact parser. Make `createUnavailableWorkerProviderRuntime()` report it for Calendar. Keep the generic `ALL_ADAPTER_BLOCKERS` array unchanged so an absent/malformed injected provider loader remains distinguishable.

**Step 4: Run the focused tests and witness GREEN**

Run the focused worker command above.

Expected: all selected worker tests pass with the distinct broker/adapter failure modes.

### Task 3: Make the deployment contract truthful

**Files:**
- Modify: `docs/plans/2026-08-10-worker-calendar-broker-design.md`
- Modify: `docs/deployment/secrets.md`

**Step 1: Document the exact request bindings**

State that synchronization binds job, household, space, owner user, provider, connection, generation, and cursor. State that reconciliation binds job, attempt, decision, user, agent, run, capability, payload, household, space, opaque provider connection reference, and authorization epoch.

**Step 2: Document the absent implementation seam**

State that no worker service-auth channel or API-owned bounded sync/readback proxy exists; no source factory can access the Google grant store without crossing the API/vault boundary. The future API-owned broker must authenticate the worker independently, re-load/compare all canonical bindings, enforce a hard deadline and response-size limit, use Google clients internally, and return no token, grant record, or provider body.

**Step 3: Correct the production blocker claim**

The direct artifact must list `worker-calendar-broker-unavailable`. It must continue to state that optional provider degradation does not block core worker readiness and that no credentialed smoke was performed.

### Task 4: Verify the worker slice without overstating deployment

**Files:**
- Verify: `packages/db/src/worker/calendar-maintenance.ts`
- Verify: `apps/worker/src/providers.ts`
- Verify: `apps/worker/src/production.ts`
- Verify: `apps/worker/build.mjs`

**Step 1: Run focused database tests**

```bash
pnpm --filter @emdo/db exec vitest run src/worker/postgres-runtime.test.ts src/proposals/postgres-proposal-reconciliation-repository.test.ts
```

Expected: PASS.

**Step 2: Run the complete worker test suite**

```bash
pnpm --filter @emdo/worker test
```

Expected: PASS.

**Step 3: Run strict type checking and linting**

```bash
pnpm --filter @emdo/db exec tsc --noEmit -p tsconfig.json
pnpm --filter @emdo/worker exec tsc --noEmit -p tsconfig.json
pnpm exec eslint packages/db/src/worker/calendar-maintenance.ts packages/db/src/worker/postgres-runtime.test.ts apps/worker/src/providers.ts apps/worker/src/providers.test.ts apps/worker/src/health.test.ts apps/worker/src/process.test.ts apps/worker/src/production.test.ts
pnpm exec prettier --check packages/db/src/worker/calendar-maintenance.ts packages/db/src/worker/postgres-runtime.test.ts apps/worker/src/providers.ts apps/worker/src/providers.test.ts apps/worker/src/health.test.ts apps/worker/src/process.test.ts apps/worker/src/production.test.ts apps/worker/build.mjs docs/plans/2026-08-10-worker-calendar-broker-design.md docs/plans/2026-08-10-worker-calendar-broker-plan.md docs/deployment/secrets.md
```

Expected: PASS.

**Step 4: Run the production artifact gate**

```bash
pnpm --filter @emdo/worker build
```

Expected: PASS; enabled direct composition fails before database construction with the exact email-adapter, push-adapter, and Calendar-broker blockers; the artifact contains no raw agent executor, in-memory production adapter, OAuth/vault secret loader, or direct proposal-reconciliation insert.

**Step 5: Hand off without committing the shared integration worktree**

Report exact changed files and command outputs to the parent integrator. The parent owns inspection and final commit because this worktree contains concurrent uncommitted work from multiple agents.

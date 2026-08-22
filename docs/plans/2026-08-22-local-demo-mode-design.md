# Local Demo Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Provide an explicit local-only command that makes every EMDO web route navigable using synthetic authenticated data, without changing normal or production authentication.

**Architecture:** The web application will select injected local-demo dependencies only when a Vite compile-time flag is exactly `true`. The dependencies will supply a synthetic authenticated user, a safe CSRF placeholder, and the existing in-memory domain runtime used by component tests. Normal builds retain the production auth and domain implementations; the demo entry point does not call the API, PowerSync, provider, banking, purchase, or calendar-write surfaces.

**Tech Stack:** React 19, Vite 8, TypeScript, Vitest, TanStack Router, existing EMDO test runtime.

---

### Task 1: Define local-demo configuration and auth dependency

**Files:**
- Create: `apps/web/src/local-demo.ts`
- Create: `apps/web/src/local-demo.test.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/package.json`

**Step 1: Write the failing test**

Test that local demo mode is enabled only when the compile-time `VITE_EMDO_LOCAL_DEMO` value is exactly `true`, and that its auth client returns a non-expiring synthetic session without issuing network requests.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @emdo/web exec vitest run src/local-demo.test.ts`

Expected: FAIL because the local-demo module does not exist.

**Step 3: Write minimal implementation**

Create a module exporting the strict flag parser and a synthetic `EmdoAuthClient`. Keep credentials absent, model the user as a non-sensitive demo user, and make write-oriented auth methods reject with a clear local-demo error.

**Step 4: Wire the main entry point**

Pass the local-demo auth client to `AuthProvider` only when the strict flag parser returns true. Add `dev:demo` with `VITE_EMDO_LOCAL_DEMO=true vite --host 127.0.0.1`.

**Step 5: Run test to verify it passes**

Run: `pnpm --filter @emdo/web exec vitest run src/local-demo.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/web/src/local-demo.ts apps/web/src/local-demo.test.ts apps/web/src/main.tsx apps/web/package.json
git commit -m "feat(web): add explicit local demo mode"
```

### Task 2: Use an in-memory domain runtime for demo mode

**Files:**
- Modify: `apps/web/src/local-demo.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/local-demo.test.ts`

**Step 1: Write the failing test**

Test that local-demo dependencies expose the existing ready in-memory runtime factory, with no external API or PowerSync dependency.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @emdo/web exec vitest run src/local-demo.test.ts`

Expected: FAIL because no demo runtime is supplied.

**Step 3: Write minimal implementation**

Move or expose the in-memory fake runtime as a production-safe development helper outside the test-only directory, then inject it into `DomainDataProvider` in demo mode. Preserve existing test imports or update them narrowly.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @emdo/web exec vitest run src/local-demo.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/local-demo.ts apps/web/src/local-demo.test.ts apps/web/src/main.tsx apps/web/src/test/fake-domain-runtime.ts
git commit -m "feat(web): run local demo with in-memory domain data"
```

### Task 3: Verify route reachability and default safety

**Files:**
- Modify: `apps/web/src/app-shell.component.test.tsx`
- Modify: `README.md`

**Step 1: Write the failing test**

Add a direct-route matrix that uses local-demo dependencies and proves every protected route remains rendered rather than redirecting to sign-in.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @emdo/web exec vitest run src/app-shell.component.test.tsx`

Expected: FAIL until demo dependencies are wired through the shell.

**Step 3: Write minimal implementation**

Only adjust the application composition necessary for the test. Document `pnpm --filter @emdo/web dev:demo`, its URL, and the provider-free/non-production boundary in the README.

**Step 4: Run focused and build checks**

Run:

```bash
pnpm --filter @emdo/web exec vitest run src/local-demo.test.ts src/app-shell.component.test.tsx
pnpm --filter @emdo/web typecheck
pnpm --filter @emdo/web build
```

Expected: all pass.

**Step 5: Verify in a browser**

Run `pnpm --filter @emdo/web dev:demo`, then confirm `/today`, `/ask`, `/schedule`, `/finance`, `/shopping`, `/approvals`, `/activity`, and `/settings` render in a real browser.

**Step 6: Commit**

```bash
git add apps/web/src/app-shell.component.test.tsx README.md
git commit -m "docs: document EMDO local demo mode"
```

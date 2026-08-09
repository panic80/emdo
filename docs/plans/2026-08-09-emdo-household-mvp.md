# EMDO Household Personal Assistant MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a runnable, invite-only household personal-assistant MVP with an offline-capable PWA, a policy-gated manager plus three uniform specialist agents, deterministic domain services, and single-node Hostinger deployment assets.

**Architecture:** Use a TypeScript modular monolith in a pnpm workspace. Browser writes flow through the Fastify API, PostgreSQL is canonical, PowerSync is the replicated read/offline layer, and a pg-boss worker performs deterministic background work. Agent manifests resolve versioned skills and capability descriptors through deny-by-default allowlists; external writes become immutable proposals and are executed only by the policy gateway after an authenticated visual decision.

**Tech Stack:** Node.js 24 LTS, pnpm 9, TypeScript, React 19, Vite, TanStack Router/Query, React Hook Form, Zod, Workbox, Fastify, Better Auth, Drizzle, PostgreSQL 17 with pgvector, pg-boss, PowerSync, OpenAI Agents SDK, Vitest, Playwright, Docker Compose, Caddy, and GitHub Actions.

---

## Non-negotiable implementation rules

- Follow red-green-refactor for behavior. A production function is introduced only after a focused test fails for the expected missing behavior.
- Keep the manager limited to delegation tools. Specialists receive only manifest-approved capabilities and data classes.
- Never let model output, provider content, client claims, or typed/voice confirmation authorize an external action.
- Store money as integer minor units with explicit currency and perform dates, recurrence, availability, travel, totals, and reconciliation deterministically.
- Keep external connectors behind interfaces. Recorded fixtures prove local behavior; real credentialed smoke tests are a separate release gate.
- Treat PowerSync as replication/read transport and the Fastify API as the only canonical mutation path.
- Do not claim provider, staging, production, backup, or restore success without fresh evidence from that environment.

### Task 1: Workspace, tooling, and architectural records

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `eslint.config.js`, `.prettierrc.json`, `.env.example`
- Create: `.npmrc`, `.nvmrc`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`
- Create: `docs/architecture/overview.md`, `docs/architecture/security-boundaries.md`, `docs/architecture/data-lifecycle.md`, `docs/architecture/adr/0001-modular-monolith.md`
- Create: package manifests and `src/index.ts` placeholders only for every approved workspace directory
- Test: `tests/workspace-layout.test.ts`

**Step 1:** Add `tests/workspace-layout.test.ts` asserting every required workspace/package path, Node/pnpm engine, required root scripts, and architecture documents.

**Step 2:** Run `pnpm exec vitest run tests/workspace-layout.test.ts`; expect failure because the workspace files do not exist.

**Step 3:** Add the minimum root tooling, package manifests, and architectural records needed by the test. Pin Node 24 in `.nvmrc`, Docker, and CI; permit local Node 25 only for development verification.

**Step 4:** Run `pnpm install`, then rerun the focused test; expect pass.

**Step 5:** Run `pnpm lint`, `pnpm typecheck`, and `pnpm test`; fix only bootstrap defects.

**Step 6:** Commit with `chore: scaffold emdo modular monolith`.

### Task 2: Shared contracts and deny-by-default toolbox

**Files:**
- Create: `packages/contracts/src/{agent,capability,action,commerce,sync,disclosure,http}.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/toolbox/src/{registry,policy,errors,foundational-skills}.ts`
- Create: `packages/toolbox/src/index.ts`
- Test: `packages/contracts/src/contracts.test.ts`
- Test: `packages/toolbox/src/registry.test.ts`

**Step 1:** Add failing contract tests for strict Zod parsing of `AgentManifest`, `CapabilityDescriptor`, `AgentResult`, `ActionProposal`, `SyncOperation`, `CommerceOffer`, and `DataDisclosureGrant`, including immutable proposal expiry/hash/state fields.

**Step 2:** Run the focused contract test; expect missing exports.

**Step 3:** Implement strict schemas, inferred TypeScript types, branded IDs, safe errors, and explicit version fields.

**Step 4:** Add failing registry tests proving unknown capability denial, manager raw-tool denial, per-manifest allowlists, risk ceilings, data-class checks, approval requirements, and untrusted-evidence isolation.

**Step 5:** Implement the registry and policy resolver minimally; foundational skills are versioned instruction records, not executable functions.

**Step 6:** Run contract/toolbox tests and typechecking; expect pass.

**Step 7:** Commit with `feat: define agent and capability contracts`.

### Task 3: PostgreSQL, identity, privacy, audit, and proposals

**Files:**
- Create: `packages/db/src/{client,schema,rls,scoped-repository,migrations}.ts`
- Create: `packages/db/drizzle/*`
- Create: `packages/auth/src/{better-auth,bootstrap-owner,invitations,session,csrf}.ts`
- Create: `packages/integrations/src/vault/{crypto,repository}.ts`
- Create: `packages/domains/src/shared/{spaces,audit,proposals,retention}.ts`
- Test: `packages/db/src/rls.integration.test.ts`
- Test: `packages/auth/src/auth.integration.test.ts`
- Test: `packages/domains/src/shared/proposals.test.ts`

**Step 1:** Add failing schema/RLS tests for household membership, private/shared spaces, original ownership, owner administration without private-content read, household-aware foreign keys, append-only audit/conversation records, and signed-claim scoping.

**Step 2:** Run against the test PostgreSQL service; expect missing migrations/tables/policies.

**Step 3:** Implement Drizzle schemas/migrations, database roles, transaction-scoped identity claims, and repository APIs that never accept client/model scope claims.

**Step 4:** Add failing auth tests for verified email/password, passkey/Google configuration, rotating sessions, CSRF, owner bootstrap, disabled public household creation, and seven-day email-bound single-use invitations.

**Step 5:** Implement Better Auth integration and the deployment-only owner bootstrap command.

**Step 6:** Add failing vault/proposal tests for envelope encryption, OAuth separation, canonical hashes, ten-minute expiry, single-use decisions, stale-provider rejection, idempotency, and readback state.

**Step 7:** Implement the encrypted connector vault, disclosure grants, audit ledger, retention metadata, and proposal state machine.

**Step 8:** Run database/auth/proposal suites and cross-household attack fixtures; expect pass.

**Step 9:** Commit with `feat: add household identity and privacy foundation`.

### Task 4: Offline sync and deterministic conflicts

**Files:**
- Create: `packages/db/src/sync/{token,streams,operations,processor}.ts`
- Create: `packages/domains/src/shared/conflicts.ts`
- Create: `apps/web/src/offline/{database,key-manager,sync-client,logout-purge}.ts`
- Create: `infra/powersync/{config.yaml,sync-rules.yaml,README.md}`
- Test: `packages/db/src/sync/sync.integration.test.ts`
- Test: `packages/domains/src/shared/conflicts.test.ts`
- Test: `apps/web/src/offline/logout-purge.test.ts`

**Step 1:** Add failing tests for signed token claims, per-space streams, canonical API uploads, operation idempotency/dependencies/schema versions, two-device sync, and global-stream denial.

**Step 2:** Implement token/stream/upload services and separate PowerSync application/bucket role configuration.

**Step 3:** Add failing conflict reducer tests for append-only conversations/audits, finance reversals and budget review, shopping deltas/tombstones, and scheduler field merges with material-conflict surfacing.

**Step 4:** Implement deterministic reducers with explicit conflict results; offline edits must never enqueue Google writes.

**Step 5:** Add failing browser-unit tests for per-device database keys, non-extractable wrapping, sync-or-discard logout, and complete local purge.

**Step 6:** Implement the PowerSync Web adapter boundary and Safari-compatible OPFS configuration, with a tested in-memory adapter for CI.

**Step 7:** Run sync, conflict, and purge tests; expect pass.

**Step 8:** Commit with `feat: add offline sync and conflict handling`.

### Task 5: Agent core, manager, models, budgets, and eval harness

**Files:**
- Create: `packages/agent-core/src/{factory,runner,model-router,budget,memory,trace,approval-state}.ts`
- Create: `packages/agents/manager/src/{manifest,instructions/v1,schemas,skills,capabilities,agent}.ts`
- Create: `packages/agents/{scheduler,finance,shopping}/src/{manifest,instructions/v1,schemas,skills,capabilities,agent}.ts`
- Create: `evals/{cases,fixtures,src/runner}.ts`
- Test: `packages/agent-core/src/{factory,model-router,budget,runner}.test.ts`
- Test: `evals/src/runner.test.ts`

**Step 1:** Add failing factory tests that load the same package template for all agents and reject malformed manifests, missing skill versions, duplicate IDs, raw manager tools, or over-ceiling capabilities.

**Step 2:** Implement manifest validation, versioned skill loading, and a capability-only agent factory.

**Step 3:** Add failing model tests for `gpt-5.6-luna` default, `gpt-5.6-terra` complexity/validation/reconciliation/unavailability escalation, resolved-model reason recording, and clear dual-unavailable failure.

**Step 4:** Implement configuration-driven model routing and the CAD 50 warning/CAD 75 model-audio block while allowing deterministic actions/local work.

**Step 5:** Add failing orchestration tests for manager-owned conversation, delegation-only tools, independent `Promise.allSettled` calls capped at three, dependency sequencing, partial failures, app-owned memory retrieval, and serialized approval interruptions.

**Step 6:** Implement the OpenAI Agents SDK manager/specialist adapter with dependency injection so tests use a deterministic fake model provider and live smoke tests use the real SDK.

**Step 7:** Add eval cases for routing, dependencies, forbidden tools, injection, lineage, freshness, disclosure, partial failure, fallback, and approvals; make the harness exercise the same runner path.

**Step 8:** Run agent-core and eval suites; expect pass without an API key. Run credentialed smoke separately and record the selected model IDs.

**Step 9:** Commit with `feat: add policy gated multi-agent runtime`.

### Task 6: Scheduler, finance, and shopping slices

**Files:**
- Create: `packages/domains/src/scheduler/*`, `packages/integrations/src/google/*`, `packages/integrations/src/maps/*`
- Create: `packages/domains/src/finance/*`
- Create: `packages/domains/src/shopping/*`, `packages/integrations/src/commerce/*`
- Create: `packages/agents/{scheduler,finance,shopping}/src/fixtures/*`
- Create: `packages/agents/{scheduler,finance,shopping}/src/evals/*`
- Test: colocated domain and connector contract tests

**Step 1:** Add scheduler failing tests for Toronto DST, recurrence, all-authorized-calendar free/busy, private detail masking, travel buffers, ranked alternatives, exact proposals, and exactly-once readback.

**Step 2:** Implement deterministic scheduler services plus Google Calendar/Maps interfaces and recorded adapters; calendar mutation remains approval-gated.

**Step 3:** Add finance failing tests for CSV/OFX mapping preview, rejected rows, duplicate detection, atomic commit, integer-CAD calculations, reversals/adjustments, category totals, and editable budgets.

**Step 4:** Implement finance services. Explicitly omit banking aggregation, credentials, payments, transfers, investing, tax, and credit decisions.

**Step 5:** Add shopping failing tests for unit/quantity normalization, preferences/substitutions, retailer grouping, official-feed conformance, timestamps/expiry, unknown costs, refresh-before-handoff, and safe HTTPS link-out.

**Step 6:** Implement shopping services and connector status records for Walmart, No Frills, Costco, Amazon Canada, Canadian Tire, Best Buy, plus one fixture-backed approved-offer adapter interface. Never scrape, infer stock, create carts, log in, or checkout.

**Step 7:** Run each domain’s unit/contract/eval suites, then all three together; expect pass.

**Step 8:** Commit with `feat: add scheduler finance and shopping domains`.

### Task 7: Fastify API, worker, and provider boundaries

**Files:**
- Create: `apps/api/src/{app,config,problem,request-context,openapi}.ts`
- Create: `apps/api/src/routes/{turns,runs,proposals,sync,voice,google,health,metrics}.ts`
- Create: `apps/api/src/services/*`
- Create: `apps/worker/src/{main,jobs,notifications,reconciliation}.ts`
- Create: `packages/integrations/src/{openai,email,push}/**/*`
- Test: `apps/api/src/app.integration.test.ts`
- Test: `apps/worker/src/jobs.integration.test.ts`

**Step 1:** Add failing API tests for every specified route, strict Zod contracts, `application/problem+json`, request IDs, idempotency, authentication, SSE replay, protected metrics, and manager-only dispatch.

**Step 2:** Implement Fastify plugins/routes and persisted run events. The voice endpoints accept bounded audio, never persist raw bytes, set `no-store`, and enforce the spend guard.

**Step 3:** Add failing OAuth tests for state/PKCE, exact redirects, incremental Calendar scopes, separate identity/calendar grants, encrypted token storage, revocation, and disconnect.

**Step 4:** Implement Google connector routes behind the vault and scoped repositories.

**Step 5:** Add failing worker tests for pg-boss job uniqueness, reminder delivery, Calendar sync/retries/reconciliation, and non-sensitive notification previews.

**Step 6:** Implement deterministic jobs and in-app/Web Push/email adapter boundaries. Do not run agents in background jobs.

**Step 7:** Generate OpenAPI and run API/worker integration tests; expect pass.

**Step 8:** Commit with `feat: add api worker and provider adapters`.

### Task 8: Responsive PWA, offline UX, approvals, and voice

**Files:**
- Create: `apps/web/src/{main,router,app-shell}.tsx`, `apps/web/src/styles/*`
- Create: `apps/web/src/routes/{today,ask,schedule,finance,shopping,approvals,activity,settings}.tsx`
- Create: `apps/web/src/features/{chat,approval,voice,sync,notifications}/**/*`
- Create: `apps/web/public/{manifest.webmanifest,icons/*}`
- Test: colocated component tests
- Test: `apps/web/e2e/*.spec.ts`

**Step 1:** Generate and accept a full desktop app concept plus mobile shell/state concept. Record exact copy, tokens, components, icon inventory, and intentional deviations in `docs/design/`.

**Step 2:** Add failing shell tests for all routes, desktop sidebar/mobile bottom navigation, direct specialist views, unified conversation, offline/conflict indicators, and safe update prompts.

**Step 3:** Implement the shell and routes from the accepted design system with lazy route chunks and accessible primitives.

**Step 4:** Add failing chat/approval tests for persisted SSE events, immutable previews, expiry, stale state, visual authenticated approval, and rejection of typed/voice/push/email approval paths.

**Step 5:** Implement chat and approval surfaces wired to the API contracts.

**Step 6:** Add failing voice tests for 60-second capture, in-memory lifecycle, editable transcript, accuracy retry, initiating-turn-only audio, `no-store`, object-URL revocation, Play/Pause/Stop/replay/captions, settings, and microphone fallback.

**Step 7:** Implement push-to-talk and spoken summaries with provider calls behind the API.

**Step 8:** Add Workbox static-only caching, safe updates with pending-change protection, encrypted PowerSync adapter wiring, and logout purge UI.

**Step 9:** Run component tests, Playwright desktop/mobile/offline flows, axe WCAG 2.2 AA checks, and storage inspection.

**Step 10:** Compare concept and native-size screenshots with `view_image`, repair the fidelity ledger, then commit with `feat: build offline emdo pwa`.

### Task 9: Containers, Caddy, CI/CD, staging, backup, and rollback

**Files:**
- Create: `Dockerfile`, `docker-bake.hcl`
- Create: `infra/compose/{compose.yml,compose.staging.yml,.env.example}`
- Create: `infra/caddy/Caddyfile`
- Create: `infra/scripts/{preflight-staging,deploy-staging,teardown-staging,deploy-production,backup-logical,restore-drill,rollback}.sh`
- Create: `.github/workflows/{ci,publish,staging,production}.yml`
- Test: `infra/tests/*.bats` or shellcheck assertions

**Step 1:** Add failing config tests for health probes, non-root containers, resource caps, separate staging networks/volumes/credentials, digest pinning, production health precondition, 1.75 GB/10 GB staging preflight, ~1.25 GB staging cap, and automatic teardown.

**Step 2:** Implement multi-stage Node 24 images, Compose services for web/API/worker/PostgreSQL/PowerSync/Caddy, and security headers/TLS routing.

**Step 3:** Add failing workflow tests for PR no-deploy, main SHA publishing, on-demand staging, synthetic-only data, exact digest promotion, protected production environment, manual approval, migrations, and rollback.

**Step 4:** Implement GitHub Actions and scripts. Never place production secrets in repository files.

**Step 5:** Add backup/restore documentation and scripts reflecting Hostinger daily backup limits, pre-deploy manual snapshot gate, encrypted daily logical dumps, monthly staging restore drill, and accepted 24-hour catastrophic RPO.

**Step 6:** Run shellcheck, Compose config rendering, image build, fresh-database migration, and rollback compatibility tests; expect pass locally where Docker permits.

**Step 7:** Commit with `chore: add single node deployment pipeline`.

### Task 10: Whole-system gates and release handoff

**Files:**
- Create: `docs/runbooks/{local-development,provider-smoke,staging,production,backup-restore,incident-response}.md`
- Create: `docs/release/mvp-acceptance.md`
- Update: `README.md`

**Step 1:** Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm evals`, `pnpm build`, and `pnpm test:e2e` from a clean checkout.

**Step 2:** Run secret scanning, dependency audit, static security checks, Docker/Compose validation, fresh migration, and restore-drill tests. Record exact commands and outputs.

**Step 3:** Run credentialed smoke tests for current OpenAI text/transcription/speech models and Google Calendar OAuth/sync/write/readback only when configured. Leave unsupported commerce connectors explicitly disabled.

**Step 4:** Perform two-stage review: first line-by-line specification compliance, then code quality/security review. Resolve Important/Critical findings and re-review.

**Step 5:** Verify desktop/mobile browser fidelity against accepted concepts and exercise scheduler, finance, shopping, offline two-device, approval, and voice acceptance scenarios.

**Step 6:** Document unexecuted external gates honestly. Do not mark Hostinger staging, production deployment, provider backup, or restore complete without authenticated evidence.

**Step 7:** Commit with `docs: add emdo release and operations runbooks`.


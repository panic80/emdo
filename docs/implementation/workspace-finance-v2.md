# Workspace and Finance v2 implementation

Source: user-approved workspace platform and Finance redesign, 2026-09-13.
The WIP Business Models workbook is a design reference, not execution authority.

## Delivery contract

Latest user scope revision, 2026-09-15: **Canada tax returns and investments are
WIP and paused.** Preserve existing implementations and data; do not activate
incomplete capabilities. Other countries remain deferred. Active implementation
and completion focus is normalized imports, Finance-agent integration and
automations. The original broader scope below is retained as a future roadmap,
not a requirement to keep implementing paused areas in the current run.

EMDO directs one bounded specialist per section. Usage type (personal,
household, organization) is independent of administrative tier entitlements.
PostgreSQL remains canonical. Existing identities and private Finance data must
survive migration without expanded disclosure. Application reasoning uses
gpt-6-astra with explicit medium effort and the existing Responses integration.

Release order:

1. Workspace contracts, policies, generic section registry, current guidance.
2. Normalized accounting, imports, AR/AP, reports, closing, API and UI.
3. Investments, reconciliation, planning, authorized recurring work.
4. Full return-level Canadian domestic personal/sole-proprietor and standalone
   corporate tax packages, including applicable provincial/territorial coverage.

User scope revision, 2026-09-15: Canada is the only tax target for this release.
USA, Mexico, Germany, South Korea, Japan and France are deferred. Preserve their
existing work; do not activate it or count further country implementation as a
current completion requirement. Non-tax Finance scope is unchanged. Earlier
seven-country entries below are historical and superseded by this decision.

Payroll, filing, live bank/trading execution, consolidated group books and
complex cross-border tax cases are excluded. Unsupported tax coverage is never
presented as complete or replaced with an estimate.

## Current integration status

The entries below this summary are chronological implementation records, not a
current backlog. Earlier statements that a subsequently delivered feature is
missing must be read in that historical context.

| Area | Current evidence | Remaining acceptance |
| --- | --- | --- |
| PostgreSQL foundation | Current combined verifier applies all 77 migrations through `0076`; 237 tests across 32 suites pass (`/tmp/emdo-finance77-integrated.log`). | Private staging and production migration/cutover proof. |
| Accounting, imports and evidence | Restricted accounting/import/evidence checks pass. Real authenticated browser review/recovery/posting and source download pass. One uninterrupted local live-Astra v4 proposal, explicit authored review and canonical posting run now passes without replay. | Private staging remains; local live-provider and real-authenticated CLI checks are still separate proofs. Arbitrary layouts require validated mappings and explicit missing-input review. |
| Recurring automation | Database checks cover scoped schedules, revocation, retries, trial-balance delivery, journal proposals and planning. The emitted worker now passes real scheduler → pg-boss → executor acceptance, including expired initiating session, exact nonzero saved report, duplicate rejection and revoked-grant follow-up denial. | Real authenticated browser report-grant creation, reload recovery, scheduling, saved report/download, pause/replacement, revocation denial and retirement now pass against the emitted worker. Private staging/production and other capabilities in that browser workflow remain unproved. |
| Investments — WIP / paused | Existing corporate-action, settlement, dividend and reconciliation implementations are preserved and regression-tested. | Deferred by user instruction; do not activate or expand as part of current closure. |
| Canada tax — WIP / paused | Existing private tax implementations are preserved and regression-tested; complete returns remain unavailable. | Deferred by user instruction. Other countries remain deferred; no country package is activated by local test results. |
| Interface | Real-authentication/restricted-database browser imports and report automation management pass on desktop/mobile, including saved review recovery, posting drilldown, immediate overview refresh and exact downloaded report readback. Server logout yields 200 followed by protected Finance 401. | Full offline purge/PWA, remaining real-backend workflows and private staging; local evidence does not prove deployment. |
| Recovery | Current age-encrypted restore passes all 77 migrations into a separate cluster; restricted checks preserve accounting, encrypted evidence/key recovery, planning, private tax access and French export mapping/receipts (`/tmp/emdo-finance77-restore.log`). | Production key recovery, external evidence storage and private-staging recovery drill. |
| ERD | Generated implementation revision `0076`: 168 tables, 418 FKs and 178 triggers in `docs/architecture/database-erd/`. | Keep synchronized with future migrations; generated sources are not production database readback. |

No staging deployment, production deployment, database cutover or tax capability
activation is established by these local results. The full approved scope remains
the delivery contract above.

### Active integration batch

The restore verifier now creates separate source and target containers, pins the
migration bytes once, encrypts the bootstrap manifest and evidence key, verifies
role attributes/memberships on the target, then restores the database archive.
The 57-migration drill passes with manifest SHA-256
`278d9782fcfb644573218ab56f674603361360f04f8927e8f69e6a11599d5bb7`.
It proves local synthetic recovery, not production key or external-store recovery.
Both owned containers and their volumes are removed afterward.

The dividend browser entry now uses the narrow `@emdo/domains/finance/decimal`
export, whose only dependency is the browser contracts facade. Package-export,
accounting and dividend checks pass 15/15. Finance tax reads additionally redact
US business identity/address and refund routing/account fields while preserving
ordinary monetary facts; the service suite remains 35/35.

Saved image OCR inspection is wired through a readonly production port. Finance
must name the exact standardization run and extraction revision; the facade
verifies original-byte and full word-inventory digests, pages text/word boxes,
and preserves uncertainty, trained-data provenance and review requirements.
It returns no invented table or approved mapping. The current service/runtime/
composition batch passes 82 tests. Image upload persistence and bounded Astra
projection are still being integrated by the image owner.

Expanded image-review schemas plus a 16 KiB source page now require 64,743
conservative input units in the real materialized runtime test. The Finance
manifest ceiling is 80,000, with actual-spend authorization unchanged. This
supersedes the earlier 64,000 ceiling documented below.

Migrations `0051`–`0053` are now frozen. The current 54-migration journal
applies cleanly; scoped corporate/private tax tests pass 12/12 and generated
standardization-reconciliation PostgreSQL tests pass 13/13. The independent
combined verifier now passes 112 tests across 14 suites, and the ERD is regenerated
at `0053`. A subsequent receipt-update privilege hardening migration is assigned
after image/OCR persistence; no tax package is activated by these results.

Finance can now read saved cash-dividend lists and individual actions through
readonly production bindings. The facade preserves gross/withholding/net decimal
strings, FX, reviewed source revisions and journal references, rejects mismatched
source or amount bindings, and omits actor and command metadata. The service,
runtime and production-composition batch passes 81 tests. Dividend HTTP source/preview/commit/list/detail routes pass the ten-test Finance
route suite. Preview reloads current authorized source facts and rejects stale
revision/hash bindings; commit uses authenticated header idempotency. Dividend
commit UI and image/OCR integration remain active work. Administrator outcome reconciliation
and explicit optional CSV mappings pass focused desktop/mobile browser checks;
raw timestamps remain available in provenance alongside readable display dates.


The shared durable standardization hook and SDK provider are exported from
`@emdo/agent-core`. Sixteen focused tests cover source binding, authority/lease
races, exact CAD spend, confirmed reservation denials and unknown outcomes.
Dispatch invocation lineage is reserved before the provider call, including
unknown outcomes; fourteen hook tests pass. The package build, declaration
consumer, exact archive inventory and independent packed consumer checks passed
again after this exported contract change. This is package evidence, not production enablement.
Finance-agent component, private tax and saved standardization reads pass the
35-test service suite. Identity facts are redacted at the model boundary; saved
standardization reads preserve source/proposal/review status without authorization
controls. Saved reconciliation reads flatten reservations, receipts and reviewed
resolutions with exact CAD decimal costs; unavailable receipts never imply zero
spend, and no recovery commands are exposed to Finance. Interactive CSV proposals now use the same digest-bound, server-reloaded
source save path as human CSV review, preserving model invocation provenance.
Capability and production composition regressions pass 44 additional
tests. These results do not establish real-backend staging acceptance.


The full web unit suite now passes 485 tests across 55 files, superseding the
earlier broad-run failures. The full API suite passes 675 tests across 69 files;
the database-dependent runtime test was subsequently run in its isolated
attested PostgreSQL database and passed alongside 14 document authority tests. API production bundle/import checks pass after adding the
pinned Luxon runtime dependency required by calendar scheduling. Capability
inventory tests now cover normalized Finance availability. Browser verification remains a separate check.

The next combined verification includes accepted `0048` amount components,
`0049` durable standardization and root `0050` Finance disclosure compatibility.
The isolated runtime check exposed and fixed two production blockers: SQL still
recognized only seven legacy Finance capabilities, and the expanded schemas
required a measured 36,089 conservative input-token units before dispatch. The
Finance bound is now 64,000; spend authorization and actual-usage limits remain
enforced. The approval/resume flow and legacy document access checks pass.
`packages/db/scripts/verify-finance-runtime.sh` reproduces the 15-test check in a
fresh local database and removes its container/volume on exit. The subsequent
SDK/production-runtime regression check passes 48 tests, and the encrypted
restore drill passes against the current migrations. Neither check establishes
private staging or production deployment. This is active implementation, not a deployment gate being waived.

- Root owns shared Finance-agent integration and acceptance coordination. The
  read facade preserves exact amounts, source identities, scope and revision
  bindings. It does not expose standardization recovery writes to the model.
- Migration ownership is sequential: cash dividends `0051`, standardization
  outcome reconciliation `0052`, then private corporate tax runs `0053`. Owners
  freeze predecessor metadata before the next snapshot is generated. A separate
  integration reviewer audits the SQL and will regenerate the ERD after acceptance.
- The upload owner is completing authoritative outcome reconciliation. Missing
  provider receipts do not establish zero spend; retries require separate current
  authorization. Durable standardization and normalized amount components are
  implemented locally. Image/OCR and broader format coverage remain outstanding.
- The Astra Max design owner has implemented explicit optional CSV field mapping
  and administrator reconciliation controls; focused tests pass and browser
  verification is underway. Dividend review UI follows its endpoint handoff.
- Canada private corporate persistence and USA annual-return development proceed
  alongside isolated Mexico, Germany, South Korea, Japan and France domain work.
  Country agents own separate directories and cannot activate coverage or modify
  shared persistence. Every country remains unavailable as a complete return
  package until its full scope passes acceptance. Release order is unchanged.

## Initial foundation implementation record

In progress. No release, database cutover, staging or production proof yet.
Track verified outcomes here as each integrated slice is completed.

### Implemented locally

- Additive migration `0024_workspace_finance_foundation`: 11 normalized tables,
  stable workspace IDs mapped to existing households, private book grants,
  administrative entitlements, legal entities, chart of accounts, fiscal periods,
  journal headers/lines, command receipts and audit records. Existing Finance
  records are not backfilled or exposed to other members.
- Database-enforced balancing, open-period validation, immutable posted history,
  exact FX/monetary precision, exact reversal matching and serialized book writes.
  Runtime roles have forced RLS. Current-session checks and locked book grants
  prevent revoked authority from being reused by new operations.
- Transactional repository with idempotent creation/posting/reversal/closing and
  trial balance queries; native and functional amounts remain decimal strings.
- `/api/v2/workspace` and `/api/v2/finance/books` routes, book overview, accounts,
  periods, journals, reversals and closing. Browser mutations retain the existing
  CSRF/authentication boundary. New accounting is opt-in through
  `EMDO_FINANCE_V2_ENABLED=true`; it fails closed when disabled or missing its DB.
- Initial Books panel for private book creation and report inspection. This is
  an initial accounting view, not the completed seven-area Finance redesign.
- The section profile accepts server-owned additional registrations with schema
  references, readiness, entitlement requirements and manager-only parentage.
  Full production tools and runtime integration are still required for each new
  section. Registering a name alone does not implement an agent.
- Manager instructions use generic workspace language. Old planning instructions
  prescribing Luna/Terra/Sol now prescribe Astra. Historical model provenance,
  old migrations and compatibility readers remain intact.
- Tax coverage endpoint accurately reports all seven packages as unavailable.

### Verification

Local TypeScript checks and focused lint passed. API and web production builds
passed (the web build retains existing bundle-size/PowerSync warnings). Restricted
PostgreSQL 18 tests verify private access, explicit viewer/preparer grants,
concurrent idempotent posting, direct-SQL unbalanced rejection and rollback,
immutable history, reversals, closing, quota disablement, and revocation.
HTTP tests verify trusted workspace derivation, browser mutation proof and
fail-closed availability. Component tests verify exact report strings and
unavailable states. Existing Astra serialization tests verify medium reasoning
and the real SDK request shape using a fake provider transport.

Repeat database verification from the repository root:

```sh
packages/db/scripts/verify-finance-v2.sh
```

The script starts a disposable loopback-only PostgreSQL 18 container, applies the
complete migration chain, tests restricted-role behavior, then removes that test
container and its synthetic volume. It does not touch application databases.

### Remaining release work at the initial foundation checkpoint

No release is complete yet. Outstanding: workspace administration/terminology
throughout the product, taxonomy and financial account tables, normalized imports
and evidence mapping, remaining commercial workflows, financial statement reports,
complete Finance UI and localization, investment positions/lots/corporate actions,
reconciliation, planning, automation grants/workers, tax-case permissions/intake
and all seven validated return packages. Finance's existing specialist has not
been granted the new accounting writes; deterministic tools and their policy
integration must land before conversational posting is enabled.

Legacy migration/backfill, comparison, authoritative-write cutover, encrypted
backup restoration, browser end-to-end verification and private staging are also
outstanding. Production has not been changed. No tax completion, production
readiness, or migration completion is claimed by this slice.

## Continuation: receivables and payables

Migration `0025_finance_commercial_documents` adds five scoped tables: parties,
commercial documents, document lines, payments, and payment allocations. Invoices
and supplier bills retain separate net/tax amounts and reference their posted
journal. Payments support partial and multi-document allocations for one party.
Issuing, settling, and voiding require administrator/approver authority; preparers
can set up parties, accounts, and periods. All relationships stay within a book.

The database validates exact document/journal correspondence, account kinds,
functional-currency precision, matching parties/directions/dates, duplicate
references, and outstanding balances. Concurrent payment attempts serialize
before allocation checks. Issued documents, posted payments, and their lines
cannot be edited. Unpaid documents and recorded payments can be voided only with
linked exact reversals; deferred constraints prevent incomplete void operations
from committing. Payment voids reopen allocated balances. Generic journal reversal
cannot silently invalidate a commercial subledger record.

The API exposes `/books/:bookId/commercial` reads, party creation,
`commercial-documents` issuance, `payments` recording, and record-specific `/void`
commands beneath `/api/v2/finance`. Accounting conflicts now receive safe HTTP
400/403/409 responses without exposing database error text. The Books interface
includes account/period/party setup, multi-line invoices and bills, multi-document
payments, unpaid-document voids, payment reversals, and outstanding balances.

This slice uses functional currency only. Source tax amounts are explicit inputs;
no tax rates are inferred. It does not yet support foreign-currency commercial
settlement/realized FX, credit-note workflows, discounts/write-offs, automatic
source matching, aging/as-of financial reports, or direct specialist tools. New
UI controls are initially English; full locale coverage remains outstanding.

### Continuation verification

- Typechecks, targeted lint, and API/web builds passed.
- Isolated PostgreSQL verification applies all 26 migrations. Its 23 tests cover
  the migration chain, core accounting and commercial lifecycle, including
  overpayment races, payment/invoice reversals, and cross-book party rejection.
- 56 targeted unit, API, component and service-composition tests passed.
- Playwright exercised Finance → Books → invoice → partial payment → remaining
  balance (`100.01 - 40 = 60.01`) and desktop/mobile rendering. The accessibility
  audit passed after increasing disclosure-control touch targets.
- Browser plugin was unavailable; repository Playwright was used. Browser
  responses were synthetic; this is not end-to-end database or staging proof.
  No framework overlay or page exceptions occurred. The existing mocked sync
  bootstrap attempts an unavailable PowerSync stream, producing expected 404
  console errors; live PowerSync was not part of this browser check.
- Screenshots: `output/playwright/test-results/finance-commercial.browser-4577b-flow-renders-exact-balances-desktop-chromium/commercial-desktop.png`
  and `commercial-mobile.png` in that same directory.

AR/AP core posting and settlements are implemented locally; integration with
normalized imports, specialist policy tools, foreign-currency settlement,
migration cutover, and private staging remains release work. Production remains
unchanged. The full redesign is still in progress.

## Active goal: normalized imports, agents, investments, automation, taxation

The full objective remains active. Prior work is concrete progress, not a
completion claim. No blocker currently prevents further implementation.

Migration `0026_normalized_finance_imports` adds separate financial accounts,
book-scoped encrypted evidence, normalized batches/rows, append-only review
records, and economic transactions linked to posted ledger movements. Financial
account creation/list APIs are implemented. CSV and OFX/QFX normalization retain
source-row/field provenance, exact decimals, native bank business dates, and
invalid rows. Locale-sensitive number/date handling requires explicit mapping.
Encrypted originals use the existing rotating document-key provider with a new
workspace/book/document authenticated encryption scope.

The durable normalized import repository and v2 API now support encrypted
CSV/OFX/QFX uploads, saved review revisions and corrections, original retrieval,
and atomic commit. Same source identities reuse economic transactions; similar
facts from another source require acknowledgement or an explicit journal match.
Matching overlapping evidence to an existing account/journal movement reuses that
transaction. Source rows and append-only review events retain original facts.
Approval authority is required at commit, and mutations retain current book grants,
idempotency receipts, database book locks, and transaction rollback.

Production wiring uses the existing rotating document keyring. With the feature
flag enabled but no valid keyring, books remain available while encrypted uploads
and original downloads fail closed. No production configuration was changed.

The book-scoped Documents UI now supports financial-account creation, explicit
CSV mapping and OFX/QFX uploads, saved row correction/review, original download,
and approval-only commit. A synthetic browser flow covers upload through commit
on desktop and 390px mobile, with accessibility and overflow checks. Component
tests cover revision payloads and viewer controls; all 17 existing document UI
tests still pass. Browser mocks do not prove a live database/UI end-to-end run.

Still required: reusable provider/report mapping versions, investment
statement models and adapters, matching suggestions, more format adapters, broader
cross-currency and revocation acceptance cases, backfill and write-path cutover.
Existing CAD import writes remain unchanged pending migration comparison evidence.

Report standardization must separate provider extraction from canonical financial
meaning. Portfolio position snapshots must remain distinct from transactions and
prices; source labels, currencies, units, valuation dates, subtotals and unknown
columns remain recoverable. Provider mappings may propose equivalent fields but
must not infer that similarly named monetary columns have identical semantics.
Layout changes require validation before unattended reuse. Current explicit CSV
mappings are not yet the planned reusable provider mapping registry.

Finance now has a registered `finance.books.read` capability for authorized books,
trial balances, commercial records, import lists, and saved import reviews. The
request-bound principal supplies workspace/user/session identity; model inputs
cannot supply those authority fields. Repository book grants remain authoritative.
Results use bounded pages, exact decimal strings, explicit currency where relevant,
and source references. Flat named fields keep the tool schema compatible with the
strict Responses SDK boundary. A missing normalized repository fails closed.

Production composition receives the feature-gated normalized repository. Existing
Finance startup still depends on the legacy private-space/document composition;
generic-workspace-only startup and normalized mutation proposals are unfinished.
Finance instructions now distinguish normalized decimal amounts from legacy CAD
minor units and direct normalized posting to the saved Documents review flow.
Legacy writes must not be used as a substitute for normalized book commands.
The specialist remains under EMDO delegation and cannot invoke sibling agents.

Validation for this integration: 59 focused service, binding, registry, composition,
and SDK graph tests pass. This is local wiring and test evidence, not proof of a
live model conversation, migration cutover, or private staging deployment.

Investment foundations now include seven normalized tables (migration 0027):
instruments, identifiers, explicit openings, journal-linked quantity movements,
statement-observed positions, price observations, and directional FX observations.
All force book RLS and retain append-only history. Opening/movement inserts require
approval authority. An observed position does not overwrite an opening or movement.

Deterministic investment functions calculate quantities after end-of-day openings,
reconcile observed versus derived quantities, apply explicit quote multipliers,
value using same-date prices and directional FX, and retain unavailable results.
Rounding is explicitly native currency first, then functional currency, half away
from zero. Portfolio results distinguish available subtotal from complete total;
any unavailable position makes the complete total null. Explicit zero prices are
valid; missing prices are not zero. Non-terminating split quantities require
fractional-entitlement review. These are book valuation calculations, not tax cost
basis rules. Negative futures prices are not supported by the current price input.

The 28-migration chain applies on isolated PostgreSQL 18. Investment DB checks
verify separate observed/opening quantities, append-only permissions, rejection of
identity FX observations and movements without a matching posted journal date.
Investment domain tests cover exact quantities, provenance, FX direction, quote
multipliers, JPY rounding, partial totals and split entitlements. Persistent
investment services/API/UI, lots, full corporate actions, report adapters, saved
valuation runs and reconciliation cases still need implementation. No investment
capability is advertised as ready or enabled merely because these tables exist.

Investment persistence and v2 endpoints now support instrument creation, price/FX
observations, explicit evidence-backed openings, reported position observations,
and a valuation preview. Identifier mappings reject duplicate scheme/namespace/value
combinations within a book under the book mutation lock. Preview inputs explicitly
select opening, price, FX and observed-position IDs; source reads share a book lock.
Results state `mode: preview` and `valuationScope: selected-positions`, so a total
cannot be mistaken for a saved valuation run or a complete inventory of the book.
Source selections, calculation version and observed-versus-calculated differences
are returned. Revoked grants prevent preview access. The restricted PostgreSQL
suite passes 29 checks across all 28 migrations; six investment calculations and
five Finance API boundary checks pass locally. No production enablement occurred.

Still required for investments: persistent valuation runs, transaction/lot services,
complete corporate-action handling, user interface and Finance-agent tools. The
current GET investment catalog is not yet paginated and must be bounded before
large production histories are enabled.

Cross-provider normalization remains an explicit next implementation priority:
a versioned registry by provider/report type/layout, section-aware extraction,
canonical field semantics including units/quote conventions/dates, retained unknown
columns, structural/financial validation, and review of uncertain mappings. A
recognized layout alone is insufficient for unattended commit; validation and an
applicable automation grant are required. This registry is not implemented yet.

Dynamic Astra-assisted report standardization is an explicit user requirement,
not an optional later enhancement. Completion requires: EMDO-authorized Finance
analysis of unfamiliar report sections with Astra at medium reasoning; constrained
mapping proposals; source-grounded extraction/provenance; deterministic validation;
review and durable approval; reusable versioned mappings; and revalidation on
layout or semantic changes. Explicit CSV mapping alone does not satisfy this.
Astra must not approve its own proposed mapping or turn document text into authority.

Current implementation adds strict extracted-table and mapping-proposal contracts
and a deterministic section normalizer. It supports bank-transaction and investment
position field meanings, exact localized decimal parsing, separate book cost and
market value, contextual dates/currencies with anchors, preserved unknown columns,
reordered headings, and visible row/layout review states. No expressions or script
transforms are executable. Thirty-seven mapping and existing import tests pass.
Persistent mapping/version/approval storage, Astra wiring, extraction adapters,
UI, automatic reuse and validation examples remain required implementation work.

The report mapping registry is now persistent (migration 0028). Versions retain
provider/report/layout identity, immutable definitions, source-linked examples,
deterministic validation, unresolved questions, proposer provenance and review
history. Book approvers may approve clean candidates or retire versions; preparers
cannot approve. A candidate or retired mapping cannot be reused. Apply revalidates
the new table and returns no financial commit authority. HTTP v2 endpoints expose
candidate creation, paginated listing, detail, review and explicit-version reuse.
Definitions cannot be rewritten; revisions and idempotency receipts protect review
retries. Twenty-nine migrations and 30 DB checks pass on isolated PostgreSQL 18.

Next dynamic-standardization work: give the existing Astra Finance runtime scoped
source-inspection and mapping-proposal tools. Those tools must load actual evidence
server-side rather than trust a model-supplied example table, record the Astra run
provenance, and exclude approval capabilities. Then implement the review UI and
validated reuse within imports. PDF/XLSX/image/structured-document extraction and
semantic drift detection remain required; current normalized tables accept only
explicitly supplied extraction results. No live Astra mapping run has been verified.

The configured Astra Finance runtime now registers `finance.reports.inspect` and
`finance.reports.propose-mapping`. Inspection reads authorized encrypted original
CSV evidence and returns bounded, explicitly truncated samples. Proposing reloads
and parses the full original server-side; models cannot supply replacement example
rows or invented context values. Candidate receipts retain Astra model provenance
and run/agent/phase invocation lineage. The agent receives no mapping-approval tool.
Raw evidence upload now works without choosing an account or mapping first.

Local verification: strict SDK schemas and registered graph tests pass; service
checks confirm source reload, bounded samples, full decoded cell preservation,
request binding, and candidate-only results. The database suite passes 31 checks
across 29 migrations, including encrypted raw uploads without premature imports.
Existing imports retain their prior whitespace handling; the dynamic source parser
preserves decoded cell whitespace for provenance. TypeScript and focused checks pass.

This is runtime wiring, not live Astra end-to-end proof. Required next work remains:
review/upload UI integration, actual Astra conversation verification, PDF/XLSX/image
and structured-document extraction, mixed-section semantic validation, and approved
mapping reuse through the normalized commit workflow. CSV report context currently
requires explicit source columns; missing context remains unresolved rather than
assuming a currency or date. The wider investment, automation, tax and release
requirements remain active.

Completion still requires all original plan requirements, including:

| Area                    | Evidence still required                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dynamic standardization | Astra-assisted unfamiliar-layout analysis, grounded section extraction, reviewed mapping proposals, durable versioned reuse and layout/semantic drift validation                                                  |
| Imports                 | CSV/XLSX, OFX/QFX, PDF/images and structured invoice adapters; durable review/corrections, provenance, dedupe and transfer matching; migration/cutover proof                                                      |
| Finance agent           | Deterministic normalized tools under EMDO-only delegation, correct book/tax-case authorization, saved-result explanations and failure handling                                                                    |
| Investments             | Instruments/listings, prices/FX, lots/corporate actions, observed versus calculated positions, valuations and reconciliation with unavailable inputs shown honestly                                               |
| Automations             | Revocable capability/book/limit grants, fresh EMDO-managed runs, idempotent jobs, revocation during queued work, audit and exception review; no expired browser-session reuse                                     |
| Tax platform            | Private taxpayer cases, structured facts/intake, book-to-tax adjustments, carryforwards, versioned rules/forms/calculations/schedules and input/reference provenance                                              |
| Country packages        | Complete supported domestic individual/sole-proprietor/corporate returns and applicable subdivisions for CA → US → MX → DE → KR → JP → FR, latest fully published years, authoritative and independent validation |
| Release                 | Complete intended UI, encrypted backup restore, end-to-end browser/database proof and private staging before production rollout                                                                                   |

No country package is enabled; estimated liability is not a substitute for the
requested return-level capability. Completing only this table's easier items is
not sufficient to mark the goal complete.

The active goal continuation also verified financial-account creation against real
restricted PostgreSQL roles, including rejection of an asset ledger account used
for a credit-card liability. The latest repeatable database run passes 24 checks
across the 27-migration chain. No new temporary Docker containers were retained.

### Dynamic report review interface

The Books panel now includes on-demand report standardization. Authorized preparers
can save unfamiliar CSV originals before selecting an account or mapping and ask
EMDO, through the existing conversational entry point, to delegate inspection and
candidate proposal to Finance. This does not bypass the orchestrator or grant
mapping approval to the model.

Users can inspect saved mapping versions, original example rows, field meanings,
normalization conventions, validation issues, provenance, and unmapped values.
Approvers submit explicit revision-scoped decisions; unresolved semantic questions
prevent approval. Evidence and mapping lists are paginated and book-authorized.
Component checks cover literal evidence delegation, source display, role gating,
revision-scoped approval, and unresolved-question blocking. TypeScript passes.
Live Astra execution and browser verification of this new panel remain outstanding.
PDF/XLSX/image extraction, mixed-section semantics, and approved mapping reuse into
normalized import review/commit remain required work, not implied by this UI.

### Approved CSV mapping reuse into normalized review

`POST /api/v2/finance/books/:bookId/report-mappings/:recordId/import` now
accepts an evidence ID, financial account ID, expected mapping version, and
explicit provider identity. It reloads and verifies the encrypted original inside
the book-authorized command transaction, checks current mapping approval, parses
the CSV, and revalidates its layout, values, and account currency. Caller-supplied
replacement rows and inferred report context are not accepted.

The saved review batch references the existing original, retains the mapping
version/definition and per-field provenance/unmapped values, and uses the existing
review, duplicate handling, and posting pipeline. Retries use command receipts.
Restricted-role PostgreSQL verification now passes 32 checks across 29 migrations,
including candidate/retired rejection, drift/provider rejection, source retention,
and idempotent batch creation. The UI reuse controls, position-report import path,
and non-CSV source adapters remain unfinished. This is local database/API evidence,
not private staging or live Astra verification.

### Mapping reuse controls and browser verification

The report-standardization panel now exposes reuse for approved bank-transaction
mappings. Users explicitly choose a saved CSV, account, and provider, then create a
review batch. The returned reference and Documents refresh instructions identify
where to continue the existing posting review. The form prevents an immediate
second submission after success, while server receipts protect request retries.
Candidate/retired and position mappings do not offer this transaction action.

Four mapping component tests pass, including the exact reuse request and absence
of posting writes. A synthetic Playwright workflow passes at desktop and 390px
mobile width, with no page errors, horizontal overflow, or serious accessibility
violations. It verifies the rendered source example, account/source selection, and
saved review result against mocked API responses; it is not live Astra or staging
proof. TypeScript and focused lint pass. Position reuse, non-CSV adapters,
investments, grants/automations, and full tax packages remain active requirements.

### Saved investment valuation runs

Migration `0029_investment_valuation_runs` adds append-only, book-scoped valuation
runs with forced row security. The save endpoint
`POST /api/v2/finance/books/:bookId/investments/valuation-runs` uses the same explicit
source selections as the preview endpoint. Calculation and persistence share the
book mutation lock and idempotent command transaction. The saved snapshot retains
opening, movement, price, directional FX, multiplier, observed-position, and
functional-currency inputs alongside the calculation version and exact results.
`GET .../valuation-runs/:recordId` reads that historical result under current access.

A saved run still describes selected positions, not an implied whole-book total.
Missing inputs remain incomplete; saving does not confer accounting approval or
post entries. Restricted-role tests verify repeatable save receipts, preserved
snapshots, denied update/delete, and denied reads after book-grant revocation.
The isolated database run passes 32 checks through all 30 migrations. Investment
UI/agent retrieval, lots, corporate actions, full reconciliation workflows, grants,
and tax packages remain unfinished. No staging/production enablement is implied.

### Finance access to historical investment results

`finance.books.read` now supports `valuation-runs` and `valuation` views, with an
explicit nullable `valuationId` separate from import IDs. The run list paginates
in PostgreSQL; detail pages retain saved summaries, exact position values,
calculated quantities and reconciliation differences. Summary totals, available
subtotals and unavailable counts remain distinct. Source references link to the
saved run under `/investments/valuation-runs/:recordId`.

Both operations use fixed request identity and current book grants. They confer
no investment write authority. Instructions require the specialist to identify
selected-position scope and historical timing. Focused tests verify pagination,
exact large amounts, incomplete/null results, source references and missing-ID
rejection. The restricted database suite passes 32 checks through 30 migrations,
including valuation listing and current-access checks. Live Astra explanations,
investment UI, lot/corporate-action accounting, automations and full country tax
packages remain outstanding.

### Saved investment review interface

Books now includes an on-demand Investments panel listing saved valuation runs.
It displays exact native/functional values, explicit missing-input reasons,
selected-position scope, and observed-versus-calculated quantity differences.
Unavailable totals remain visibly unavailable, with available subtotals separately
labelled. Users can inspect frozen inputs and calculation/source details; the
interface does not recalculate historical values in JavaScript.

Four focused component checks pass, and a synthetic Playwright check verifies the
saved review flow on desktop and at 390px mobile width, including no page errors,
horizontal overflow, or serious accessibility violations. These are mocked API
browser checks, not live Astra/staging proof. Creating investment source records
and selecting/saving runs through the UI, portfolio report imports, lots/corporate
actions, automation grants and tax packages remain unfinished.

### Investment preview and save workflow

Authorized preparers can now build a valuation from one or more explicitly
selected brokerage/instrument pairs and recorded opening, price, FX and statement
observations. Changing the selections clears the preview. Saving passes the
reviewed input fingerprint, and the server rejects a changed source snapshot
inside its book-locked transaction. A successful save opens the historical result.
Missing sources can still produce an explicitly incomplete saved run; neither the
UI nor the server fills missing values with zero.

The database suite passes 32 checks across 30 migrations, including matching and
stale fingerprint cases. Five focused UI checks pass. The synthetic browser flow
covers source selection, preview, fingerprinted save and historical review, at
desktop and 390px widths with accessibility checks. TypeScript and focused lint
pass. Source-record creation UI, position-report import, lots/corporate actions,
automation grants and full country tax packages remain required. Browser evidence
is mocked API verification, not live Astra or private staging proof.

### Approved portfolio mappings into observed positions

Migration `0030_mapped_portfolio_observations` preserves reported book cost, market
value, price and accrued interest separately, with a scoped mapping foreign key
and immutable source facts. Approved investment-position mappings can now reuse
saved CSV evidence through the same import endpoint. Each identifier must resolve
to an existing book instrument with matching quantity/quote conventions, and the
selected account must be an active brokerage. Mixed row currencies remain native
observation currencies; they are not coerced into the brokerage account currency.

Imports save statement observations only. They create no openings, movements or
journals. Repeated instrument/date rows require review. Repeated requests for the
same evidence/account/mapping/source-row reuse observations. An unresolved row
rolls back the entire request. The mapping UI now exposes portfolio reuse and
restricts account choices to brokerages. Source fields remain in investment
catalog responses and frozen valuation evidence; the strict quantity-reconciliation
calculator receives only its defined inputs.

All 31 migrations and 33 restricted-role database checks pass. The new integration
case verifies separated source values, retained extra columns, repeat-request
handling, no invented opening and atomic unresolved-instrument failure. Four
mapping UI checks, TypeScript and focused lint pass. Portfolio-specific browser
verification, richer extraction/context and mixed-unit sections, lots/corporate
actions, automations, full tax packages and staging remain unfinished.

### Deterministic lot-cost allocation

The Finance domain now implements explicit FIFO and specific-lot disposal
allocation. It validates account/instrument/currency scope, acquisition sequence,
previously allocated cost, available quantities, and source references. Cost is
allocated cumulatively with exact integer arithmetic so splitting a disposal into
multiple requests preserves the same cumulative rounded basis and full liquidation
consumes the remaining basis exactly.

Native and functional cost histories remain distinct. Gross proceeds, fees,
commissions and taxes remain separate; tax treatment explicitly distinguishes a
disposal cost from withholding. Withholding reduces cash proceeds without
implicitly reducing the tracked gain. Different currencies require source
provenance; the engine does not invent exchange rates or statutory elections.

Thirteen focused investment/lot checks pass, including independent partial-sale
examples, JPY/KRW precision, large amounts, FIFO ordering, explicit selection,
inconsistent state, overselling and tax-treatment distinctions. This calculator
is not yet connected to persistent lot/allocation tables or Finance tools. Short
positions, additional basis methods, corporate actions and country-specific tax
adjustments remain required where applicable. No tax package is enabled by this
cost-tracking work; the full automation/tax/release scope remains active.

### Persistent investment lots and encrypted XLSX evidence

Migration `0031_investment_lot_accounting` adds immutable scoped lots, disposals
and allocations. Database checks enforce signed movement relationships, cumulative
cost conservation, quantity limits and complete disposal allocations at commit.
Posting-authorized users can record movements, acquisition costs and FIFO or
specific-lot disposals through Finance v2. Concurrent disposals serialize; a
second disposal cannot consume already allocated quantities. Backdated lot history
that would invalidate existing allocations is rejected pending a correction flow.

Migration `0032_xlsx_book_evidence` permits encrypted XLSX originals. Upload and
download preserve original binary bytes, with SHA-256 and byte-size verification.
The bounded ZIP/XML extractor retains sheet/table candidates, exact source values,
date systems, formula-cache facts and cell anchors. Finance's report inspection
and mapping-proposal tools support explicit table selection and paginated candidate
and cell provenance. They reload saved originals; extraction uncertainties remain
unresolved questions and prevent approval. This is not yet a complete reviewed
XLSX import/reuse workflow. CSV reuse continues to normalize transaction or
statement-position records, without inventing opening balances or journal events.

At this checkpoint, all 33 migrations and 35 restricted-role PostgreSQL checks
pass. The combined Finance domain, extraction, specialist and route suite passes
211 tests. API packaging now includes the XML parser runtime dependency and passes
its bundle/import verification. These are local checks, not staging or live Astra
execution evidence.

### Automation and tax execution foundations

The automation domain now models revocable book-scoped grants, current authority,
limits, attempts and execution state. Every attempt checks current membership,
book permission, entitlement and registry-ready capability. Exact monetary limits
use decimal strings. Unknown execution effects require reconciliation instead of
blind retry. The 23 policy/state tests pass. These pure functions are not execution
authority: durable grants, atomic usage reservations, EMDO job dispatch and worker
integration still need implementation.

Tax contracts separate the subject from a workspace and allow explicitly selected
book snapshots or personal facts with no book. A versioned registry validates
scope, required facts/forms/schedules, trusted source catalog and reviewed fixture
attestations; deterministic execution retains input and result hashes. Eighteen
foundation tests pass. The API derives coverage from this registry, which still
contains no enabled country package. Complete return calculations, persisted cases
and case ACLs, questionnaires, exports and country validation remain outstanding.

### Design work in progress

The shared shell received responsive navigation, authenticated account identity,
keyboard-safe mobile menus and reduced-motion-aware transitions. The user found
this initial visual pass too basic. A replacement Astra Max design agent is now
reworking Finance's actual information architecture and populated screens; the
shell changes alone do not satisfy the requested overall UI/UX redesign.

### Finance-agent access to recorded lot basis

`finance.books.read` now supports `investment-lots`, backed by a bounded,
book-authorized PostgreSQL listing and the matching Finance v2 GET endpoint.
Each row preserves original quantity/cost, remaining quantity/cost after saved
allocations, both currency identities and movement/journal/source references.
The specialist instructions explicitly distinguish recorded basis from statutory
tax-adjusted basis and market value. Pagination is applied by the repository;
revoked permission errors propagate instead of becoming empty results.

The 35 database checks pass with remaining-basis checks before and after competing
disposals. The 37 focused specialist/runtime/route tests and root TypeScript check
pass. Lot entry/correction UI and further investment-agent actions remain open.

### Reviewed XLSX mappings into durable import review

A mapping proposal can now supply `evidenceId` and a definition with explicit
`xlsxSelection`. The repository decrypts and verifies original bytes, invokes the
trusted deterministic extractor, and builds its own example; caller-supplied
example rows cannot substitute for XLSX evidence. The saved mapping retains the
confirmed selection and acknowledgements, while the example retains source and
selection SHA-256 digests plus extraction version. Full cell provenance can be
reconstructed from immutable original bytes and the saved selection.

The extractor preserves every selected row, including blanks; rejects intersecting
merged cells, source errors and missing formula caches; requires acknowledgement
for cached formulas and hidden content; and converts dates only in explicit date
columns. Converted dates require ISO mapping semantics. Approval remains a
separate authorized decision. Approved XLSX imports re-extract, revalidate and
bind to the exact reviewed document/digest, producing the existing durable
transaction-review or observed-position records. A new workbook requires its own
source-range review even when headings match. This prevents a fixed approved range
from silently omitting new rows. CSV mapping reuse is unchanged.

The restricted PostgreSQL commercial suite passes 21 tests through migration0032,
including source-derived examples, preapproval rejection, idempotent XLSX review
creation and changed-evidence rejection. The isolated run deliberately excludes
in-progress automation migration0033. Root TypeScript and 38 focused
mapping/specialist/runtime checks pass. The reviewed-selection UI and full
end-to-end browser workflow still need integration.

### Canada/Ontario 2025 sourced tax components

The tax domain includes exact-decimal calculations for the published annual
federal/Ontario taxable-income columns, Ontario surtax and health-premium bands.
Original CRA e-text captures, hashes, form versions and source locators accompany
the code. The components preserve printed annual form base amounts and remain
outside the full-return registry. Their result explicitly has `complete: false`
and no reportable amount until rounding and the full return dependency chain are
validated. The readiness artifact records twelve remaining release conditions;
this work enables no taxpayer coverage. Seventy-one component checks plus eighteen
platform checks passed in the tax agent's run.

### Reviewed XLSX browser workflow

Report standardization now offers an original-workbook download and explicit
source review: sheet, row/column bounds, date system, date-column conversions,
field bindings, numeric formats, cached-formula/hidden-content acknowledgements,
and answers to each unresolved question. Saving creates a revised candidate with
recorded findings; the existing approval action remains separate. The original
format/name is loaded with mapping detail so access does not depend on which
originals-list page is visible. Approved XLSX imports offer only that reviewed
original, preserving per-file source-range review.

Seven focused UI tests and the synthetic desktop/mobile browser flow pass. The
browser flow covers source confirmation, revised candidate, separate approval,
and durable import-review response, including accessibility checks. Root and web
TypeScript pass. Screenshot review identified a mobile Finance-title flex defect;
the design agent is correcting it and rechecking native mobile rendering. Browser
mocks do not establish live Astra or production behavior.

### Durable automation authority foundation

Migration0033 adds scoped grants and run records, a closed readiness registry and
workspace authority epochs. Triggered epoch changes invalidate grants following
membership, book-access or entitlement changes. A dedicated non-login function
owner has no superuser or row-security bypass privilege. Authenticated admin
management and session-free worker claim/settlement remain separate exports.
Workers reserve usage atomically, recheck current authority, use bounded leases
and CAS outcomes, and require reconciliation when a lease expires with unknown
effects. All capabilities default unready; no entitlements were enabled.

The combined isolated PostgreSQL18 run applies all34 migrations and passes
42 database tests across accounting/imports, foundational books and automation.
The snapshot expectation was advanced to include0033 and separately rechecked.
Concrete target resolution, leaf execution, pg-boss dispatch, schedules and
management UI remain required before unattended Finance work is enabled.

### Authenticated automation management API

Finance v2 now exposes book-scoped automation grant listing/creation/revocation
and run enqueue routes. The optional production binding is composed only with
trusted authentication and the enabled Finance v2 stack. Each request checks
service readiness; mutations use the existing browser-proof and idempotency
boundary. Grant/run UUIDv8 identities derive from authenticated workspace, user,
book, operation and retry key. Request bodies cannot supply those identities.
Grant retries replay the existing record only after current permission checks;
changed grant terms conflict, and a replay cannot revive a revoked grant.

The clean PostgreSQL18 chain applies all34 migrations and passes50 checks,
including a new grant retry/conflict/revocation case. Four HTTP tests cover proof
failure, trusted identity, stable retry identifiers, listing authentication,
enqueue/revocation and unavailable service. API composition and packaging checks
are included in parent integration. These APIs do not enable any capability or
create an active scheduler/leaf dispatcher.

### Original download and visual integration checks

Original downloads now use one explicit, short-lived in-memory download helper.
It releases its object URL after use and immediately on setup failure; no browser
database/cache/sync persistence is used. Book-document review supports binary XLSX
originals as well as text evidence. Eleven download/document/mapping/offline
exclusion checks pass without weakening the exclusion guard.

Astra Max's design replaces the stacked Finance page with persistent book context,
focused workspace panels, sourced overview figures and a compact assistant rail.
Parent reviewed native desktop/mobile screenshots and confirmed the mobile heading
width defect is corrected. Browser checks use synthetic API fixtures, with honest
empty/unavailable states; this is local UI proof, not deployment evidence.

### Further Canada/Ontario return dependencies

Federal basic personal amount phaseout, nonrefundable-credit arithmetic and the
annual worksheet top-up, Ontario basic credits and tax reduction now have sourced
deterministic components. Recurring phaseout values retain exact rational
numerators/denominators instead of being silently truncated. The tax agent's
114-test suite passes. Annual T1 rounding remains unresolved; payroll rounding
instructions were explicitly excluded as authority for annual returns. Registry
coverage remains unavailable in every country.

### Concrete saved-report automation and Finance reads

Migration0034 introduces immutable generated accounting reports. The first
`finance.reports.generate` leaf accepts only its own book as a single target and
zero monetary intent. It rechecks current authority and the execution lease,
reads posted journals only, and atomically saves the snapshot and completes the
run. Cumulative debit/credit movements and net balances remain exact decimal
strings, including aggregates larger than an individual source amount. The result
freezes account labels and source journal identities/hashes. Source caps reject
the job rather than save a partial report. Revision-bound queue deliveries reject
stale attempts before consuming reservations.

Permission-governed GET `/api/v2/finance/books/:bookId/reports` and
`/reports/:reportId` expose saved snapshots independently of paid automation
access. `finance.books.read` adds `generated-reports` discovery and
`generated-report` detail, paginating summary/account/source-journal records and
linking to the saved report. EMDO instructions distinguish these all-posted
snapshots from live book state, historical cutoffs and tax calculations.

Parent verification applies all35 migrations in isolated PostgreSQL18 and passes
57 database/queue/snapshot checks. This includes a real pg-boss delivery after
browser-session expiry and canonical saved outcome, scoped read access, source
caps and large aggregate amounts. Nine report HTTP/contract checks and36
specialist/runtime/composition checks pass; root and web TypeScript pass.
Production startup registration, recurring scheduling/outbox dispatch and
capability enablement remain unfinished and disabled.

### Bounded PDF extraction adapter

The integration layer now extracts PDF pages and positioned text spans using the
public PDF.js API in a disposable, memory-limited worker. It preserves raw text,
page geometry, transforms and offsets without declaring inferred table meanings.
No-text pages remain distinguishable from successful text extraction; encrypted,
invalid, oversized, timed-out and aborted documents return explicit unavailable
outcomes. The actual production worker artifact and local PDF.js assets are
included in API packaging. Ten genuine-PDF tests plus packaged-worker verification
pass. PDF book-evidence upload and Astra source inspection are now connected as
described below. Reviewed PDF table mapping/import and its UI remain unfinished.

### Automation management interface

The Finance Automations panel lists actual grants with scope, exact limits,
validity and status. Administrators can revoke with confirmation, current browser
proof and a stable retry key. Book/session changes cancel stale reads; empty,
forbidden and unavailable states are distinct. No creation/scheduling controls
pretend execution is enabled. The design agent reports71 focused UI tests and
three browser checks passing, including mobile/accessibility; these use synthetic
API fixtures. No production deployment occurred.

### Production worker registration and report response boundaries

The worker now passes the opt-in `EMDO_FINANCE_V2_ENABLED` dispatcher through
production composition, queue startup and shutdown. Migration0035 grants the
existing fixed `emdo_worker_executor` role only revision-bound claim, settlement
and atomic report-generation function execution. No direct Finance table writes,
role memberships or readiness activation are added. Policy source files retain
the same permissions for future migration maintenance. Startup checks these
function rights, FORCE RLS and absence of direct mutations on Finance authority
and report tables. Actual fixed-role PostgreSQL report execution passes.

Saved-report HTTP responses now validate trusted workspace/book/report identity,
exact report integrity, bounded page size, unique page identities and advancing
pagination. Invalid service output returns a redacted502 instead of exposing a
mismatched report. Ten report route/contract tests pass. Parent also verified40
worker lifecycle, production composition, dispatcher and deterministic leaf tests.

Automatic run delivery remains a separate unfinished integration. API enqueue
currently persists the canonical run without an atomic delivery outbox. The next
step is a dedicated Finance outbox with one immutable delivery per run revision,
atomic enqueue/confirmed-not-applied retry creation, narrowly scoped dispatch
functions, deterministic job binding and exact readback after uncertain send or
acknowledgement. Transport retries must never create a new execution revision;
unknown execution effects require reconciliation. No capability is enabled by
production queue registration alone.

### PDF book evidence and source inspection

Migration0036 permits PDF originals in the existing encrypted book-evidence store.
Authenticated upload/download retains the existing2MiB source-byte limit,
canonical Base64 validation, byte-count/SHA256 integrity checks and AES-256-GCM
storage. The original bytes are reloaded under current workspace/book authority
before inspection. Uploading or inspecting a PDF creates no economic transaction.

`finance.reports.inspect` now accepts `pdfPage` and `pdfTextOffset`. It returns a
page inventory, a4000-character decoded-text window and20 positioned source spans
per request; `provenanceOffset` pages the spans. Clipped span text is marked, and
text offsets allow access to the remaining decoded page text. Page geometry,
transforms and source text remain evidence, including document instructions.
No table, currency/date interpretation or financial posting is inferred. Image-only
or blank pages remain explicitly without extractable text; OCR, encrypted and
other unavailable outcomes remain distinct. CSV/XLSX results include `pdf:null`.

Saved-report agent reads also validate bounded summary pages and trusted
workspace/book identity; report detail must match the requested report ID before
any data reaches model context. Local verification passed43 focused
service/schema/HTTP/snapshot checks. The isolated PostgreSQL18 verifier applied
all37 migrations and passed58 checks, including real PDF encryption roundtrip,
inspection, replay, access denial and tamper rejection. PDF mapping approval,
reviewed import, OCR/image intake and production deployment are not established
by this work.

### Structured tax questionnaire domain

The existing tax intake and trusted rule-package registry now support immutable
private questionnaire snapshots. Questions come from package requirements;
metadata supplies presentation labels without inventing statutory requirements.
Answers bind the case and taxpayer, source revision and explicitly authorized
book snapshots. Edits and withdrawals retain revision lineage and invalidate
review. Changed source or authorization revisions, missing inputs, unsupported
coverage and mismatched subjects block readiness. Ten focused domain tests pass.

This domain can reach `ready-for-calculation`, never declare a complete return.
Transactional case storage, private case ACL enforcement, API and questionnaire
UI still need integration. No country package is enabled: all seven remain
unavailable until complete forms, calculations and validation coverage exist.

### Saved report library and complete export

Reports & Tax now includes a saved-report library for authorized book viewers.
It pages report snapshots, account movements and source journals while preserving
exact decimal strings and explicit all-posted snapshot coverage. Account references,
journal hashes and snapshot metadata can be inspected. Downloads revalidate current
access and snapshot identity before producing a complete escaped, script-free HTML
report; the export includes every row and source rather than just the displayed
page. Stale book/session responses are discarded. Empty, missing, forbidden and
unavailable outcomes remain distinct, and existing mapping/tax navigation is kept.

The design agent verified83 UI tests, a dedicated desktop/mobile report browser
scenario, and2 fresh-server shell checks. The10 focused report tests and browser
scenario were rerun after final copy changes. Parent inspected the desktop and
native mobile screenshots. Browser tests use authenticated synthetic fixtures;
this does not prove staging or production deployment.

### Corporate-action planning domain

Forward and reverse stock split plans now preserve the exact remaining native and
functional cost basis of each source lot, including partially disposed lots, and
propose immutable successor effects. Fractional share handling is explicit:
unknown policy blocks readiness; retain permits only exactly representable
quantities; cash-in-lieu remains blocked pending its consideration and basis
workflow. Nonrepresentable fractions retain rational share entitlements instead
of silently rounding away ownership. Scope, duplicate identities, currency
consistency and source date are validated.

The source boundary is explicitly immediately-before-action. A future persistent
operation must verify that boundary from revision-bound source history, reserve
the unique action identity, lock affected lots and save effects atomically. The
planner does not prove concurrent-write safety or authorize posting. Corporate
persistence, API/UI and cash-in-lieu accounting remain unfinished.

Final parent verification for this increment:37 migrations and58 isolated
PostgreSQL checks;24 investment/lot/corporate-action domain checks; root and web
TypeScript; scoped ESLint; and `git diff --check` pass. The questionnaire's
withdrawal lookup uses an immutable ES2022-compatible array copy so the shared
domain also typechecks in the browser target. No commit, staging rollout or
production enablement was performed.

### Reviewed PDF selection helper

The integration layer now accepts declarative selections of complete inspected PDF
spans for headers, logical data rows and optional as-of/currency context. It
re-extracts the original bytes, checks the expected SHA256, complete reviewed page
inventory, full span text/textLength and exact source geometry, and retains page
and span anchors. Selected decimal and date text is unchanged. Explicit joiners
are recorded with the original spans; logical row ordinals do not claim PDF row
numbers. The result includes selection/source digests and the complete unselected
span inventory across all pages. Omitted content requires acknowledgement, and
coverage always remains selected spans only.

Clipped or missing text, changed source facts, reused spans, ambiguous headings,
overlapping extents and unsupported rotated/RTL/cropped geometry reject. A source
span containing several columns cannot be split by this helper. Missing text is
not replaced by guessed values or OCR. The selection is bounded to2000 source
spans and4MiB of declarative input. Eight genuine-PDF helper checks and the10
extraction checks pass. These contracts and helper are not connected to a reviewed
PDF save endpoint, mapping approval or import; confirmation fields do not grant
authority or establish document completeness.


### Durable delivery, recovery and inspectable automation outcomes

Migration0037 adds a dedicated Finance delivery outbox. Initial run creation and
confirmed-not-applied retry transitions schedule their immutable delivery revision
in the same transaction. The existing generic worker outbox remains separate.
A fixed dispatcher role can call only narrow claim/acknowledgement functions;
it receives references, not browser identity, grant authority or worker leases.
Transport uses the same deterministic queue ID after uncertain send or
acknowledgement, verifies exact broker readback, and never creates a new run
revision to resolve a lost transport response. The poller claims one item and
bounds send/readback to ten seconds within its thirty-second lease.

Authority denial blocks a matching runnable run. Exhausted transport or a
quarantined binding produces a visible reconciliation state. Migration0039 adds
bounded recovery for expired execution leases and the thirty-minute delivery
deadline of immediate requests. It checks canonical revisions across all delivery
states, skips active report transaction locks, and preserves completed outcomes.
Unknown effects are never automatically replayed; confirmed-not-applied retries
remain governed by the original grant and attempt limits. Partial deadline indexes
support bounded polling. Capability readiness remains disabled pending release.

Migration0038 exposes administrative run history through scoped functions that
omit leases and canonical dispatch intents. GET book automation runs and individual
run endpoints validate scope, pagination and output integrity. Read access survives
an entitlement downgrade but requires current book administration. The Finance
specialist receives only bound read methods for `automation-runs` and
`automation-run` views and cites saved outcome references. It cannot issue grants,
queue work or retry runs through this facade.

PDF source inspection now returns the original SHA256, page text/span counts and
full source-span text lengths alongside bounded text previews. Long text can be
retrieved through page windows before a reviewed selection is proposed. The
Documents and Report standardization interfaces accept encrypted PDF originals,
retain exact binary download, and request authorized text inspection. OCR and PDF
mapping/import were unavailable at that inspection-only milestone. The reviewed
whole-span backend connection is described below.


Parent verification for this increment: all40 migrations and66 database/queue
checks pass in a fresh isolated PostgreSQL18 instance;44 API/specialist checks,
18 PDF extraction/selection checks, root and web TypeScript, scoped ESLint and
diff checks pass. The frontend agent verified91 units and four browser workflows
with mocked authenticated APIs. Parent inspected the native mobile PDF screen.
Disposable database containers were cleaned up. Nothing was deployed or enabled.


### Reviewed PDF mapping backend

Reviewed PDF whole-span selections now use the existing source-only mapping
candidate endpoint, with `pdfSelection` in the declarative mapping definition.
The repository decrypts and re-extracts the saved original for candidate creation,
preview and import. Original SHA256, extraction revision, exact selection digest,
page inventory and selected span text/geometry bind the saved example. Callers
cannot supply replacement PDF table cells. Legacy CSV/XLSX definitions may omit
the new optional field without changing their normalized shape.

Approval remains a separate authorized decision and unresolved questions block
approval. Approved bank mappings create transaction review rows; approved position
mappings create observations through the existing deterministic financial rules.
Neither path posts financial entries automatically. Repeated position source
identities retain existing observation IDs. Field and unmapped-column provenance
include the original PDF spans; omitted content remains in encrypted evidence.
Coverage is explicitly `selected-spans-only`, and row ordinals represent the
reviewed selection order, not physical PDF row numbers. OCR, splitting one text
span across columns, unsupported geometry and automatic document completeness
claims remain outside this implementation.

Focused genuine-PDF selection/normalization tests and authenticated candidate-route
tests pass. PostgreSQL candidate/approval/import roundtrip tests are included;
full database verification is coordinated separately with the parent task.


### Exact PDF source review endpoint and specialist proposal boundary

`GET /api/v2/finance/books/:bookId/evidence/:recordId/pdf-inspection?page=1`
returns the original digest, complete page inventory and the selected page's exact
span text and geometry. It distinguishes extracted text, pages requiring OCR and
unavailable extraction. Responses are private and non-cacheable. After the worker
finishes, the endpoint rechecks the authenticated session/workspace and current
book access, and verifies the original bytes again before disclosing extracted text.

The Finance specialist can propose a PDF mapping using the inspected whole-span
selection. The trusted facade forwards only the saved evidence ID and declarative
proposal; persistence independently extracts the original. It always adds an
unresolved source-review question. Model-supplied selection confirmations cannot
approve the candidate or import/post records. This provides a dynamic proposal
path while preserving deterministic normalization and explicit approval.

Focused checks cover exact long-span text, missing pages, changed original bytes,
revocation during extraction, changed session workspace, unauthenticated access,
and the specialist's source-only proposal payload. The migration-chain check now
includes0040 and verifies its seven private tax tables are additive, without
changes to previous table snapshots. These are local checks, not release or
country-return completion evidence.

### Private tax case persistence and authenticated intake

Private preparation routes are rooted at `/api/v2/finance/tax/cases`, independent
of book routes. They expose case list/create/detail, assessment, declarations,
answer save/review/withdraw, explicit case grants/revocations, and explicit book
source authorization/revocation. Historical detail accepts an exact revision.
The owner recovery command `reset-after-source-revocation` accepts the expected
case revision and creates the repository's sanitized incomplete snapshot.

Every mutation requires current browser verification and a UUID idempotency key.
Strict schemas reject caller-supplied access/context objects; the authenticated
principal supplies WorkspaceContext and persistence checks current private case
access. Both normalized Finance and private tax database readiness must pass.
Production assembly excludes private tax bindings without trusted authentication.
Responses are private and uncached; conflicts expose generic refresh guidance,
not tax values or internal source details. No route marks a return complete or
adds country calculations.


Migration0040 adds private tax subjects/cases, explicit case grants, immutable
questionnaire revisions, book-source authorizations, declaration revisions and
idempotency receipts. Workspace ownership and book administration do not grant
access to someone else's tax case. Creation allocates a fresh tax subject;
callers cannot reuse another taxpayer identifier to obtain access. Database
constraints keep persisted cases incomplete while the country registry is empty.

Revoked book access blocks affected questionnaire history. A case owner can
explicitly reset inputs after revocation with an expected case revision. Recovery
creates a sanitized revision with empty facts/source bindings; it does not disclose
or rewrite the revoked historical data. Return calculation and completion are not
enabled by intake or recovery.

Verification before subsequent migrations: isolated PostgreSQL18 applied all41
migrations and passed73 checks across6 suites, including private tax access,
concurrent CAS/idempotency, immutable revisions, source revocation and sanitized
recovery, alongside PDF mappings/accounting/automation/report regressions. Parent
independently passed24 tax route checks and root TypeScript. This is local database
and API evidence; staging, country-return validation and production remain pending.


### Private tax specialist reads and browser contract boundary

`finance.tax.read` is a read-only Finance capability under EMDO invocation lineage
and its own `finance.tax-cases` disclosure class. Case detail/assessment require an
explicit case ID and current private case permission. The model cannot substitute
book access, write tax facts, activate rules or mark returns complete. Detail pages
can pin a questionnaire revision; assessments return the exact revision and hash
from the same authorized database transaction. Bounded result pages distinguish
truncation from completeness and retain structured intake facts and missing-input
issues for explanations.

Private tax request schemas now live in the browser-safe contracts package.
Persistence re-exports the same schemas for compatibility; API routes import the
shared definitions directly. The browser boundary test checks the complete import
graph against reviewed public modules and permits only Zod as an external runtime
dependency, excluding server invocation and authority contracts. The prior exact
export-name assertion covered only the legacy UI and has been replaced with this
transitive boundary check plus required public exports.

Parent checks for this increment passed24 tax route tests,31 production binding
and specialist-composition tests,41 specialist/capability/contract checks and the
updated3 browser boundary checks. The PDF UI agent passed101 Finance/chat units
and6 mocked browser workflows, including mobile/accessibility/keyboard/reduced
motion and exact-original candidate/approval/import. Parent visually inspected
both desktop and native mobile source-review screenshots. Full current-tree
TypeScript and later migration verification remain necessary while calendar
scheduling and stock-split persistence are being integrated.


### Saved tax inputs and source-bound explanations

Case creation accepts an explicit `mode: "intake-only"` without rule package IDs.
The trusted service selects a reserved disabled binding; the UI can preserve
inputs while every full country package remains unavailable. Owner-only
`GET /api/v2/finance/tax/cases/:caseId/grants` exposes current grant records without
requiring access to revoked book-source values. Current case roles are supplied by
persistence, independently of book roles.

New questionnaire revisions bind declaration source IDs, exact source revisions
and content hashes. Detail reads resolve and verify those immutable sources in the
same private-case transaction. Finance exposes them as separate `declared-input`
records labelled `unreviewed`; they do not become reviewed answers or calculation
facts. Source-binding mismatches are rejected. Legacy snapshots without binding
metadata retain their original hashes and expose no inferred historical
declarations. Reset clears current bindings while preserving source history.

Parent verification:26 tax API tests,14 calendar planner tests and39 specialist,
CPP and tax-read contract tests pass; root TypeScript and scoped lint pass.
The CPP module is component-only with explicit supported-case boundaries and no
reportable rounded amounts or country-package activation. Migrations0041-0043 and
their concurrent investment/scheduling integration still require a combined fresh
database verifier run. These checks do not establish full return readiness or
production deployment.

### Recurring Finance schedules (local implementation, September 13)

Authenticated book administrators can create an immutable schedule tied to a grant
that they issued, list/read it, and change its state with an expected state
revision. Routes are `GET/POST /api/v2/finance/books/:bookId/automations/schedules`,
`GET .../:scheduleId`, and `POST .../:scheduleId/state` with
`{expectedStateRevision,status: active|paused|retired}`. Mutations require CSRF and
a UUID idempotency key. Creation derives workspace/book scope and a stable schedule
ID on the server. Changing cadence or targets requires a new schedule; retirement
is permanent. Pausing or retiring prevents future triggers; existing runs remain
subject to their independently revocable grant.

Cadences include elapsed UTC intervals and daily, weekly, or monthly local times
with an explicit IANA zone, pinned timezone-data version, DST gap/overlap policy,
and short-month policy. The bounded planner considers at most the latest nominal
occurrence, records the consumed ordinal range and selected skip/coalesce policy,
and defers without advancing the cursor while concurrency is blocked. Unknown
execution outcomes count as blocking until reconciled. No cron expression or
browser session is involved.

Migration 0043 adds forced-RLS schedule definitions and immutable plan audits. A
separate fixed scheduler role claims persisted definitions, and PostgreSQL
independently recomputes the proposed calendar plan before committing it. Current
grant revision, issuer authority, entitlement, capability readiness, time window,
limits, cursor and lease are checked under locks. One transaction creates the
canonical Finance run, explicit `controller=emdo` deterministic schedule lineage,
and existing delivery outbox row. Stable occurrence identity makes uncertain
commit retries idempotent. The Finance worker still performs its existing current
grant checks before executing any specialist leaf.

Worker polling is opt-in through `EMDO_FINANCE_SCHEDULES_ENABLED=true`, requires
`EMDO_FINANCE_V2_ENABLED=true`, and uses
`EMDO_FINANCE_SCHEDULER_DATABASE_URL` on the same database. Provision a separate
`emdo_finance_scheduler_login` with LOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS,
NOCREATEDB, NOCREATEROLE and NOREPLICATION, and only SET membership in the migration's
NOLOGIN `emdo_finance_scheduler` role (`GRANT ... WITH INHERIT FALSE, SET TRUE`).
The runtime validates this identity and membership before polling. Each database
operation is bounded; shutdown does not wait indefinitely for an unavailable
connection. A lost commit response never causes direct leaf execution.

The feature flag defaults false and migration 0043 does not enable any Finance
capability. The backend is locally implemented and tested; no production schedule,
login provisioning, deployment, or capability activation has been performed.

Integrated local verification applied all 44 journal migrations to a fresh,
isolated PostgreSQL 18 database and passed all 86 tests across eight suites,
including seven schedule scenarios through the real restricted scheduler login,
13 real worker scenarios, commercial/PDF review/import, private tax and corporate
revision checks. The verifier removed its container and volume. The separate
scheduler debug database was also removed. Root TypeScript, scoped lint, and the
50-test planner/API/lifecycle/assembly/snapshot batch passed. These results replace
the earlier pending combined-verifier note; deployment and capability readiness
remain separate.


### Coordinated normalized Finance integration check

The fresh PostgreSQL18 verifier now applies all44 migrations and passes86 checks
across accounting/commercial, worker reports, tax cases, automation authority,
fixed-login recurring scheduler, snapshot continuity and corporate revision
protection. This resolves the previous disposal trigger and rebind fixture
failures. The rebind fixtures now use distinct command keys across cases while
preserving identical keys for retries; runtime idempotency was not weakened.

A separate real age-encrypted backup/restore drill passes using the same custom
compressed dump and ownership/ACL restore behavior. It verifies normalized
accounting, encrypted originals, private tax snapshots, forced RLS and unauthorized
read/posted-edit denial after restoration into a new database. Both verifiers
use synthetic local containers and remove their own resources. These results do
not establish full stock-split acceptance, country-return readiness, private
staging or production deployment.

The Automations screen now includes recurring posted trial-balance schedule
management: paginated reads, creation, pause/resume, explicit permanent
retirement, and editing as a replacement after the original is paused or retired.
Calendar, clock-change, short-month, missed-occurrence and concurrency choices are
explicit. The report's zero amount and book target remain internal contract facts.
The authenticated, current-book-authorized `/automations/schedules/options` read
supplies the server timezone-data version; users do not invent it. The form uses
existing report grants and does not enable grant creation or other specialist
capabilities. Other existing schedule capabilities remain readable and can be
paused or retired.

UI acceptance passed 25 focused component/API tests, web TypeScript and scoped
lint, plus two synthetic authenticated browser workflows covering existing grant
revocation and schedule create → pause → weekly replacement → retirement. Desktop
and 390px mobile checks passed with no serious accessibility violations or
horizontal overflow. Captured layouts were inspected. The ordinary local preview
had no authenticated backend session, so browser workflow proof uses the existing
synthetic fixtures; the earlier real PostgreSQL scheduler proof remains separate.

### Finance-agent recurring schedule reads

`finance.books.read` now accepts `automation-schedules`. The production composition
injects only the schedule repository listing method, which checks the current
workspace/book administrator. The model sees bounded configuration summaries,
status, due time and blocked reason, with record links and continuation offsets.
It does not receive execution cursors or mutation methods. The response validates
workspace/book identity, cursor/definition consistency, duplicate IDs and page
bounds before disclosure. Instructions distinguish scheduled intent from an
executed or posted result.

The focused service, capability and composition suites pass 43 tests, including
wrong-book output, inconsistent revision, duplicate result and revoked-read
rejection. Root TypeScript and scoped lint pass. This does not activate schedules
or add specialist grant/launch authority.

### Workspace language in existing routes

Sign-in, invitation, Settings, Today, Shopping, Activity and Ask now use generic
workspace labels. Existing household-backed identities, memberships and settings
payload fields remain compatibility contracts; this copy change does not alter
sharing, entitlement checks or migration state. Shopping and Activity descriptions
also explain their user purpose instead of internal provider/projection details.

Thirteen existing authentication/experience tests pass. The Finance projection
check now explicitly opens Activity in the redesigned section navigation before
checking saved transactions. Web TypeScript, scoped lint and diff checks pass.

### Structured German invoice source adapters

The evidence upload API accepts UTF-8 UBL invoice (`format: "ubl"`) and UN/CEFACT
CII D16B invoice (`format: "cii"`) XML through the existing encrypted original
store. Migration 0045 extends only its format trigger. Originals remain bounded
at 2 MiB, with bounded XML depth, nodes, text, attributes, invoice lines and output.
DTD/entity declarations, processing instructions, malformed XML and unsupported
root namespaces are rejected before storage. No schema, stylesheet, attachment,
external reference or document instruction is executed or fetched.

`GET /api/v2/finance/books/:bookId/evidence/:evidenceId/structured-invoice`
re-extracts the authenticated book's original and returns a SHA-256 source binding,
adapter version, exact leaf text/attribute provenance using namespace-qualified
indexed paths, parties, invoice/line identifiers, dates, currencies, quantities,
prices, VAT breakdowns, allowances/charges and totals. CII format-102 dates have an
explicit normalized ISO date while their original text and format attribute stay
in source facts. Attribute provenance is an array so even the XML attribute name
`__proto__` survives safely. The result always states `conformance: not-validated`
and `reviewRequired: true`; a claimed XRechnung profile is source data, not a
validation result.

The separate `POST .../structured-invoice/review-and-post` command requires the
source digest/version, selected existing counterparty and accounts, and explicit
acknowledgements of source parties, tax-group aggregation and the absence of
conformance validation. Amount overrides are rejected. The server re-extracts and
reconciles source line totals, document allowances/charges, VAT bases/taxes, gross
and payable amounts, then uses the existing commercial issue/ledger transaction.
It records the reviewed source digest, evidence ID, mappings and VAT group
provenance in the durable audit. Exact command replay is idempotent; posting the
same source again is rejected, alongside existing counterparty/invoice-reference
duplicate protection. Current book authorization is checked again at posting.

The implemented posting subset is ordinary type-380 invoices, positive VAT basis
groups, nonnegative source VAT, explicit issue/due dates, and one supported
currency matching the book. Invoice lines remain preserved, but accounting lines
are explicitly reviewed source VAT groups: the adapter does not invent per-line
VAT allocations. Credits, nonpositive groups, unsupported currency conversion,
prepayments, payable/gross or rounding differences, unsafe/unknown extensions,
attachments and external references require separate handling. This is source
extraction and accounting review support, not full EN 16931, XRechnung, legal,
XSD or Schematron conformance validation; no capability was activated.

The bindings were checked against the official [OASIS UBL 2.1
specification](https://docs.oasis-open.org/ubl/os-UBL-2.1/UBL-2.1.html),
[OpenPeppol UBL invoice syntax](https://docs.peppol.eu/poacc/billing/3.0/syntax/ubl-invoice/tree/),
and the European Commission's [EN 16931 CII validation artefacts and
examples](https://github.com/ConnectingEurope/eInvoicing-EN16931/tree/master/cii).
The synthetic fixtures are not conformance certificates. Twenty-one focused parser
and HTTP tests plus three real restricted-PostgreSQL scenarios passed, including
both XML formats through encrypted roundtrip, source-bound review, commercial
posting, audit, duplicate rejection, unsafe XML and inconsistent settlement.

### Finance-agent saved tax working-paper reads

`finance.tax.read` now includes `runs` and `run` views, requiring an explicit
private case and (for detail) run ID. Production injects only listing and reading
methods. The repository rechecks historical source authority before disclosure;
the adapter validates strict summaries/details, case/run/snapshot bindings,
schedule content hashes, unique field ordinals and review output hashes. Results
page through exact fields, unresolved reporting status, blockers and provenance.
They remain incomplete working papers, distinct from questionnaire assessment or
completed tax returns. The model cannot create, approve or export a run through
this capability.

The focused service, read-contract and composition checks pass 34 tests. This
includes cross-case/run/revision rejection, corrupt schedule hashes, pagination
and propagated source revocation. Production wiring now supplies the tax service
rather than its readiness wrapper. Global TypeScript acceptance awaits the
concurrent financial-report contract compatibility changes; no global green or
release claim is made by this entry.

### Durable structured-invoice review in Book Documents

Book Documents now accepts the supported UBL/CII XML originals, displays original
parties, lines, totals and full field provenance, and collects explicit accounting
mappings by source VAT group. It never offers amount overrides. Source SHA-256,
adapter version and the absence of full conformance validation remain visible.
The reviewer separately acknowledges source parties, group aggregation and the
conformance limitation before confirming posting.

Incomplete reviews can be saved and resumed after a full browser reload. Migration
0047 adds user/book/evidence-scoped append-only draft revisions with forced RLS,
current authority checks, revision CAS and idempotency receipts. Posting requires
the exact latest saved review revision, then re-extracts the encrypted original
and applies the existing deterministic commercial posting boundary. Mapping
changes clear acknowledgements; uncertain posting retries preserve their request
body and idempotency key. The source reference also prevents duplicate posting.

Local acceptance includes four focused UI tests and both desktop UBL and mobile
CII browser flows with actual XML fixture content, reload recovery, explicit
confirmation, accessibility checks and no horizontal overflow. The invoice HTTP
suite passes nine tests, and the 48-entry migration snapshot chain passes eight.
The coordinated verifier compiled all 48 migrations and passed all three invoice
PostgreSQL scenarios, including draft recovery, CAS races, same-key replay, stale
revision rejection and cross-workspace denial. Its broader report/automation
regressions remain separately tracked; no global regression, production,
conformance or activation claim follows from this invoice acceptance.

## Durable source standardization — local acceptance, 2026-09-14

Migration 0049 saves source-bound standardization runs, immutable extraction
versions, a delivery outbox and CAD model-spend reservations. Authenticated book
members can start, inspect, cancel and explicitly retry eligible blocked runs.
The source/author unique key prevents duplicate analysis after an uncertain start
or browser reload. A separately saved reviewed candidate can be linked with run
revision CAS; linking grants neither approval nor posting authority.

The fixed dispatcher and executor use dedicated database logins. A saved run
continues after its initiating browser session expires, but rechecks active
membership, book role, entitlement, authorization expiry, source SHA and the
workspace authority epoch. Only a live database-held claim can read encrypted
originals or persist an extraction. Proposal dispatch verifies the immutable
extraction revision and digest, reserves configured CAD spend, and saves distinct
EMDO workflow/Finance invocation identities before the provider request. Actual
provider usage and response provenance settle the reservation. Cancellation,
revocation and unknown outcomes cannot free a reservation for an automatic retry.
Expired execution leases become indeterminate and preserve their audit evidence.

The versioned registry exposes bounded CSV, XLSX and embedded-text PDF extraction.
OFX/QFX and UBL/CII retain their existing native review routes. Image OCR is
explicitly unavailable; scanned or text-incomplete PDFs block instead of
inventing facts. Document instructions remain untrusted source data. Grounded CSV
proposals may create a candidate from the exact saved source rows. PDF/XLSX
proposals persist declarative definitions with a null mapping ID until a person
reviews exact cells or spans; model acknowledgement flags never become review
authority. Financial meaning, units, dates and incomplete coverage remain visible
uncertainties. No path automatically approves a mapping or posts financial data.

Local acceptance: a fresh isolated PostgreSQL 18 verifier applied all 50
migrations and passed 104 tests across 14 suites, including six actual-role
standardization cases for session-expiry survival, source/extraction binding,
revocation, denied direct writes, late cost settlement after cancellation,
reservation replay, lease expiry and confirmed budget denial. Delivery tests
verify stable queue identity, uncertain-send readback and cancellation. Worker
packaging boots its emitted executable and extracts a genuine two-page PDF using
the emitted child worker and local PDF.js assets. Provider composition requires
explicit CAD pricing and disables HTTP retries. Separate Astra UI acceptance
covers saved-run reload, uncertain candidate-link recovery and fresh XLSX source
review. These are local implementation results, not production activation.

`EMDO_FINANCE_STANDARDIZATION_ENABLED` defaults to false. The database readiness
configuration is seeded false with zero spend limits; enabling the environment
flag or merely supplying provider credentials does not enable saved analysis.
Operator-reviewed entitlement, readiness and budget configuration remain required.

## Standardization outcome reconciliation — implementation boundary

A saved indeterminate analysis can expose its attempt reservations and a separate
administrative reconciliation record. New reservations pin the configured CAD
rates and begin as `not-dispatched`; EMDO must persist `dispatch-started` before
calling the provider. Earlier reservations default to `unknown`, so absence of a
new marker never retroactively proves that an earlier request was not sent.

An administrator may request a receipt lookup for an already saved provider
response reference. The request is durable and deduplicated. The fixed executor
retrieves that exact reference with no transport retries or new generation, then
records only receipt identity, model, usage, calculated cost, digest and time.
It rechecks the requester's current administrative access before and after lookup.
The app role cannot write verified provider receipts directly. The existing
provider uses `store:false`: a response may therefore be unavailable, and a 404
is explicitly not proof that no provider request occurred.

Explicit reviewed resolution accepts only database-proven no dispatch, an already
settled actual cost, or a verified receipt tied to the same reservation and source.
It never accepts a caller-entered cost override. Unknown or unavailable outcomes
remain held. Review uses revision CAS and idempotency receipts; it changes an
indeterminate run to blocked while preserving cancelled or revoked states. Any
retry is a separate action that rechecks current authority and all held spend.
Reconciliation cannot approve mappings, recover generated text as financial
facts, or post records. The Finance specialist receives a read-only audit view;
lookup and resolution are not model tools.

Local recovery acceptance (migration 0052): a fresh isolated PostgreSQL 18 cluster
clean-applied all 53 migrations, then passed all 13 actual-role standardization
scenarios and eight migration-chain checks. Recovery coverage includes no
reservation/no-dispatch proof, rejection of unknown dispatch, administrative
revocation, refused app-role forged receipts, explicit actual-cost review,
idempotent lookup/review, and retrying an unavailable lookup without releasing
held spend. The bounded Finance hook passes 17 tests; receipt cost verification
passes 10, receipt-worker behavior three, and lifecycle routes eight. The emitted
worker/PDF artifact and scoped lint/typechecks also pass. Separate UI acceptance
covers five browser workflows and 27 focused unit tests. This is local proof;
readiness flags, deployment and production provider execution remain separate.

### Image source review and durable OCR standardization — local implementation (2026-09-14)

Migration 0054 adds encrypted PNG/JPEG/WebP evidence and a narrow, current-book-authorized read function for an exact saved image extraction. The metadata is an unchanged copy of 0053 apart from its chain IDs. Originals retain the existing 2 MiB bound and exact byte SHA. The worker's local ImageMagick/Tesseract adapter supplies uncertain words, pixel geometry, confidence, engine version and trained-data hashes; missing native dependencies produce an explicit unavailable result. This does not add OCR to scanned PDF pages.

The durable image envelope retains the complete bounded OCR facts (16 million pixels, dimension 8192, 5000 words, 65536 raw text units and 256 KiB JSON). Astra receives a deterministic prefix of complete OCR lines bounded to 12000 UTF-8 bytes. The projection retains original word IDs, text, confidence and boxes, and reports omitted word/line/raw-word-text counts. Its version, digest and full-extraction digest are persisted with the spend reservation before the existing single provider dispatch, and must match the completed proposal provenance. It never claims a complete source analysis or creates reviewed table cells.

`readImageInspection` and the authenticated `/evidence/:evidenceId/image-inspection` endpoint require the exact standardization run and extraction revision. Human table selection pins original/extraction/inventory digests and records selected pixel regions, full expected OCR words, exact reviewed strings and correction reasons. OCR-missed regions require explicit visual transcription and a reason. Overlapping regions, hidden intersecting words, stale geometry or changed source facts fail closed. Coverage remains selected-regions-only. Source-only candidate creation, separate mapping approval and original-bound import revalidation reuse the existing accounting review boundary. A blocked model analysis can still link a separately reviewed image candidate without acquiring model provenance or changing its blocked status.

Local acceptance: clean application of 55 migrations; a genuine PNG through native OCR and an actual restricted worker login; saved OCR/projection provenance; rejected projection/source tampering; null model mapping; reviewed candidate, separate approval, normalized bank import review and idempotent command replay; wrong-source and revoked-access denial; and blocked-analysis manual review recovery. Focused helper, projection, API, hook and registry tests passed. Worker production packaging and agent-core build/declaration/packed-consumer checks passed. Native OCR tests explicitly skip when the required local executables are absent. No production migration, capability activation, automatic approval or financial posting is asserted by this acceptance.

### Parallel integration checkpoint: normalized planning read facade

The Finance specialist now declares `budgets`, `budget`, `budget-vs-actuals`,
`forecasts`, and `forecast` read views. A separate readonly port validates saved
workspace/book identities, requested revisions, line identities and currencies,
preserves exact decimal amounts and missing forecast inputs, and strips creator
and reviewer identifiers from model records. Results are bounded by the existing
book-read pager. Source references carry the saved revision. Live budget-versus-
actuals reads retain their own snapshot timestamp and must not be combined into
one purported snapshot across changing requests. No planning writes are exposed
to the model. Production repository/route binding is now installed behind Finance v2
enablement and trusted authentication. The specialist receives five bound read
methods only. The new repository has a restricted-role/RLS readiness probe;
0057 database feature acceptance remains owned by the planning implementation.

Focused verification: 59 tests pass across the planning read helper, request-bound
Finance services, specialist composition, and actual production agent runtime.
The scoped type check found no diagnostics in this root-owned batch; a concurrent
planning route test still had an undeclared request identifier at that check.
The image backend owner separately completed 55-migration restricted-role proof
and 43 focused tests; native worker security packaging and image UI remain under
separate active owners. Dividend UI browser verification is complete and its
browser hold is released. No deployment or real financial posting occurred.

Planning production wiring verification: 50 tests across service assembly, durable
composition and planning routes pass, including explicit enablement and trusted-
authentication gating. Scoped lint passes; the API typecheck was clean at the
wiring checkpoint. These local results do not establish staging enablement.

The integrated planning wiring/read checkpoint subsequently passed 90 tests
across five suites. API typecheck is clean after aligning the route-service
response boundary and parsing the new model-read test output. The route service
returns untrusted values that the existing strict response schemas validate;
this does not expand the specialist port beyond its five read methods.

Planning read follow-up: budget-versus-actuals now emits an explicit source
snapshot header even when there are no rows, retaining scope, revision, coverage
and timestamp rather than returning an unexplained empty page or invented zero
total. 41 focused read tests pass. Repository review identified a remaining
consistency issue: the shared helper starts READ COMMITTED and the book-grant
SHARE lock does not serialize other accounting writers. Coherent multi-query
planning snapshots and durable cross-page actuals results are required before
feature acceptance; the planning owner has the exact finding.

Full API regression checkpoint after planning route registration: 710 tests
passed, one database-dependent case skipped, and one assertion failed across
73 files. The failure is the old image adapter availability expectation in
finance-standardization.test.ts:324 (`unavailable/unsupported` versus the new
`implemented/dynamic-mapping` registry entry). The import owner is reviewing
that expectation against actual OCR readiness; this is not a green full-suite
claim. Production API packaging passed in the same run. Log:
`/tmp/emdo-api-planning-full.log`.

The OCR registry regression is resolved without changing runtime availability:
its test now checks implemented/dynamic-mapping, explicit local-runtime and
human-review limitations, and `ready:false` when the service is unavailable.
The subsequent full API run passed **711 tests across 72 files**, with one
separate database-dependent case skipped. API production packaging passed;
scoped lint passed. Log: `/tmp/emdo-api-ocr-readiness-final.log`.
Native OCR image-build/isolated transport proof is still separate pending work.

### Recovery from interrupted parallel sessions

Multiple agents terminated with provider usage-limit or disconnected-stream
errors. Their reports do not establish completion. Root resumed from the actual
worktree rather than restarting them or discarding their edits.

OFX/QFX production composition now injects the source-preserving parser into
normalized imports. Finance report inspection exposes bounded native facts
(10 transaction headers and 20 lexical fields per page), source SHA-256,
source-account/institution identity, original timestamp semantics, scoped FITID,
unsupported issues and explicit truncation. It returns no fabricated table
mapping; reported balances remain source-only, not opening balances.

Verification: 83 focused API/runtime/composition tests passed, then the new
request-bound OFX inspection regression passed in the 37-test service suite.
27 automation/OFX domain tests and seven private US adapter tests passed. API
typecheck is clean after fixing the interrupted automation's deeply readonly
result type and the W-2 correction union narrowing. Scoped lint passed. These
checks do not substitute for restricted-role OFX import/duplicate acceptance.

Pending coordinated schema sequence remains0057 planning →0058 legacy migration
→0059 wage corrections →0060 planning automation. The approved0060 SQL worker
function must atomically recheck authority, materialize an immutable typed
planning result and complete the run, with same-lease replay. Direct forecast
inputs in queued intent are not proof of reviewed authority. Native OCR secure
helper transport/image-build proof, image browser QA, migration acceptance and
full country-return completion remain unfinished.

### Actual PostgreSQL planning acceptance recovery

Root added `finance-planning.integration.test.ts` and included it in the Finance
PostgreSQL verifier. It connects through a separate non-superuser/non-bypass
login with emdo_app membership. A fresh isolated cluster applied all58 journaled
migrations through0057, then five tests passed: exact budget/idempotent replay,
account-specific posted source counts/signs, a real accounting writer paused
before commit with an observed advisory-lock waiter, immutable forecast replay
after later posting, and denial after grant revocation. The test container was
cleaned. Log: `/tmp/emdo-planning-postgres-check.log`.

These tests found and fixed three real defects: the shared0057 currency trigger
referenced fields absent on other attached tables; joined ledger snapshots
returned duplicate period metadata for multi-account budgets; and source-journal
counts included journals without lines for the selected account. No posted
accounting history was changed.0057 snapshot remains
`915353ff0d5a27d0d0818ee41bbb83507b7fa3c2825a7e05b1aaa0f057dcbcdb`;
its corrected SQL SHA256 is
`9ba7ef768a02fba295ac011dd6ffcafeb02ffc5de15401be4f5e4fb100a874b1`.
This is local feature acceptance, not production migration/cutover or a completed
planning automation execution path.0058 still needs schema metadata and its own
restricted-role acceptance before0059/0060 can be sequenced.

### Legacy0058 schema and ERD checkpoint

Added all five legacy migration tables to Drizzle and generated0058 metadata.
The retained SQL includes the original custom row policies and history triggers;
generated replacement SQL was reviewed but not used to drop existing constraints.
New hardening requires every source/target mapping key (SQL NULL cannot pass the
CHECK), requires source hash/fingerprint together, and binds run/record/comparison
foreign keys to the same workspace AND book. A fresh isolated PostgreSQL cluster
applied all59 journaled migrations; three actual database structural-invariant
tests and four existing unit/static checks pass. Eight snapshot-chain checks pass.
Full source extraction/backfill/comparison/cutover and restricted-user policy
acceptance remain separate unfinished work.

0058 metadata also reconciles prior dividend source-row constraint names with
the already-corrected0051 SQL and current source schema, and normalizes the
existing guarded-action check's source representation.0058 SQL does not drop or
replace those existing constraints. Snapshot SHA256:
`18515f0e0568582b00020a90f45aa3421df78d789b04c8d076b8d70236a5db56`.

Regenerated implementation ERD at0058:150tables,361foreignkeys,131SQLtriggers.
This is the current source-backed implementation artifact, not a claim that the
entire requested schema/feature scope or production database is final. Seven ERD
generator regressions pass. Logs: `/tmp/emdo-legacy-postgres-check.log`,
`/tmp/emdo-0058-snapshot-tests.log`, `/tmp/emdo-0058-erd-tests.log`.


### Journaled US wage corrections0059

Moved the reviewed draft policy into0059_private_us_wage_corrections.sql and
created linked migration metadata with no table-definition changes. Fresh
PostgreSQL applied all60 migrations. All four durable tax-run flows passed,
including original v1 evidence, v2 original→W-2c→W-2c chains and malformed-chain
rejections, current source authority, immutable private exports, Canadian
corporate compatibility and blocked-input review. This run uses the current
federal2025.5 domain package; it does not establish full-return completeness.
Log: `/tmp/emdo-0059-postgres-check.log`.

Eight snapshot-chain tests and API typecheck pass. Snapshot table comparisons
now compare structural values rather than JSON property serialization order;
the custom-migration generator reordered properties without changing definitions.
0059 snapshot SHA256:
`9edb6994b1435d564dc62a45485b038d308313b6ef778bfcfcc74b193aa7d464`.
The implementation ERD is refreshed at0059.0060 atomic planning execution remains
unimplemented and must preserve the approved authority/lease/usage/result boundary.

### Planning automation execution handshake (0060)

Root owns migration 0060, SQL execution and migration metadata. The automation
integration lane owns automation contracts, domain, repository, executor and
scheduler tests; it does not edit planning repositories/UI or migrations.

The agreed restricted-worker call is
`emdo.generate_finance_planning_result(operationId uuid, expectedRevision integer, leaseToken uuid) RETURNS uuid`.
Arguments are positional; expectedRevision is the automation run CAS revision,
not budgetRevision. The returned UUID is the immutable saved outcome reference.
No separate JSON payload is passed to this function: it reloads the persisted
canonical run request, including request.planning. Schedule input uses planning
as a top-level sibling of capability; the materialized run request retains it.

The planning union remains schemaVersion 1, budgetId, exact positive
budgetRevision, currency and itemCount. Budget-vs-actuals requires asOf null;
forecast requires an ISO date and direct openingBalance plus assumptions.
Workspace/book scope comes from the enclosing authorized run. No payload field
rename is requested. Queue-supplied reviewedBy/reviewedAt/sourceReference are
claims, not review authority: execution must bind them to server-persisted
reviewed inputs and reject missing or changed authority. Usage counts and
currency must be recomputed/checked against authoritative records.

At this handshake, the union is present in contracts but migration 0060 and its
function do not yet exist. Repository/worker wiring can target this signature;
readiness must remain false until SQL and restricted-role acceptance land.

### Atomic planning execution 0060 implementation

The root-owned migration now implements the agreed positional worker function,
immutable `finance_planning_results`, scoped foreign keys, forced RLS, and a
restricted application reader. It preserves old enqueue overloads and adds a
10-argument overload (existing report argument followed by planning). Legacy
calls cannot enqueue a planning capability without its explicit planning intent.
Readiness rows are inserted disabled; no deployment enablement is performed.

Execution holds epoch, grant and run locks, acquires the canonical accounting
book advisory lock, rechecks the exact saved budget and reviewed forecast inputs,
validates authoritative item counts/currency/reserved limits, and materializes
exact numeric aggregates with journal lineage and a database-produced hash.
Results and completion commit together. Same-lease completed retries return the
same UUID. Lease expiry is checked again after computation. Future inputs remain
unavailable unless a single immutable saved forecast matches the supplied review.

The existing recurring scheduler now validates the same intent at schedule save
and materialization, reserves/counts budget lines rather than the single budget
target, and persists planning plus its review binding in the canonical run.
The schedule plan retains EMDO controller lineage and existing delivery identity.
Public automation history projects typed report/planning selections without
exposing the internal canonical intent, review binding, targets or leases.

Current isolated verification: eleven atomic planning tests pass, including exact
amounts above MAX_SAFE_INTEGER, linked journal counts, same-lease replay, immutable
results, saved-result application reads, forged review/count rejection, available
opening and completed-period behavior, canonical accounting-writer serialization,
expiry during lock wait, revoked grants, scheduled result materialization, decimal
overflow rollback, and the actual production dispatcher using its fixed executor
role with duplicate delivery replay.
The 16 automation and seven recurring-scheduler regression tests also pass.
The separate five-test manual planning suite also passes after correcting the
readiness table count. The combined isolated run passes all 39 tests against 61
migrations (`/tmp/emdo-0060-postgres-check.log`). Nine snapshot-chain checks pass;
seven ERD generator regressions pass. The independent SQL review and final API
read-surface integration checks remain pending. These checks are local synthetic evidence, not
private staging, production rollout, or full-goal completion.

### Native OFX/QFX acceptance and integration checks

Added `finance-ofx.integration.test.ts` to the central Finance PostgreSQL verifier.
Five native upload/review/commit workflows pass on all 61 migrations: original
byte digest/download and idempotency; OFX/QFX repeats and source-account-scoped
FITIDs; overlapping evidence requiring explicit journal matching; legacy raw
FITID collisions requiring matching; and source-currency mismatch with missing
FX retained as unavailable. Root strengthened the suite to use a separate
NOSUPERUSER/NOBYPASSRLS/NOINHERIT login with only emdo_app membership. All five
still pass (`/tmp/emdo-ofx-fixed-login-check.log`). No parser/repository behavior
change was needed. The owned disposable database was removed afterward.

The expanded root database check passes 43 tests across planning, automation,
scheduler and private-tax suites, plus one targeted standardization receipt
reconciliation test (13 unrelated tests skipped). Workspace TypeScript passes
after replacing unknown test-data assumptions with runtime schema narrowing and
correcting the restored-key Uint8Array annotation. Web TypeScript and nine grant
UI tests pass after adding the two planning capability labels. Browser-safe
planning/result contracts are explicitly exported and all three browser-boundary
checks pass. The saved-result reader verifies its hash in PostgreSQL before
returning a strictly parsed artifact. Finance instructions now distinguish that
immutable result from live budget-versus-actuals reads.

0060 integration checkpoint: all 49 targeted PostgreSQL checks pass across the
combined 43-test run, the one selected receipt-reconciliation test, and the five
OFX tests using a separate restricted login. Full `pnpm typecheck` (workspace plus
web) passes. Six focused worker/execution tests additionally distinguish a
PostgreSQL lock-timeout rollback from a lost commit acknowledgement; only the
former is safely retryable. Scoped lint and `git diff --check` pass. The current
ERD validates 151 tables, 363 foreign keys, 1,580 endpoint columns and 133 triggers.

0060 SQL SHA256:
`46ab3b533a8b51047af411fd7b8d2336b0cd3b838971027d39149078a87e8974`.
0060 snapshot SHA256:
`7459862ce7a71a026500a5f6908724cdbcd4b17c1e055d9b2109d606e6ab0fb2`.
The independent planning SQL review remains active; Canadian 2025 personal/T2125
rounding verification is a separate, country-domain-owned parallel task.

Recovery revalidation (2026-09-14): the encrypted separate-cluster restore drill
passes against all 61 captured migrations through 0060. It verifies the restored
accounting overview, decrypted original evidence, private tax case access,
rejected unauthorized reads, immutable posted journal history, exact role
bootstrap parity, and rejection of a corrupted encrypted archive. Evidence:
`/tmp/emdo-finance-restore-0060.log`; bootstrap manifest SHA256
`e74d9561560276fd992a9d754cc2cd572ab91c27e2fb7ce17ae5794f644ac3bd`.
This is local synthetic recovery proof; populated planning-result recovery,
external evidence storage/KMS recovery and private staging remain unverified.

The Canada personal reporting/package handoff was independently rerun locally:
53 focused tests pass for workflow `.10` and paper precision `.6`. Annual
rounding and other unsupported full-return inputs remain blocked. Follow-on
country work addresses carryforwards; separate owners are implementing isolated
OCR transport and the planning automation creation/result interface.

Investment acceptance follow-up (2026-09-14): six PostgreSQL tests across cash
dividends, successive corporate-action splits/disposals and revision checks pass
against all 61 migrations (`/tmp/emdo-investments-0060-check.log`). Cash-dividend
repository calls now use a separate NOSUPERUSER/NOBYPASSRLS/NOINHERIT login
granted only emdo_app; escalation to postgres is explicitly rejected. The
duplicate-claim test now attempts a second commit with a new action identity and
idempotency key before checking the persisted count. The cash-dividend suite is
included in the central Finance verifier. This does not establish broader
corporate-action coverage or browser/staging acceptance.

Tax-domain regression checkpoint (2026-09-14): all 423 tests in 29 files pass
(`/tmp/emdo-tax-current.log`). The stale US Schedule SE regression now verifies
the existing unresolved-threshold gate: exact 399.8755 versus entered 400 must
not emit downstream tax/deduction/settlement fields. Adjacent unambiguous inputs
remain checked. This test correction does not resolve the statutory/reporting
interpretation or establish complete return coverage. Dedicated primary-source
research is continuing for that boundary.

Planning audit findings (2026-09-14, acceptance remains open): the independent
review found that direct inserts can append child records to saved budget or
forecast revisions, planning writes do not all take the canonical book lock,
and forecast review binding does not prove a complete saved line set. Dedicated
database enforcement and adversarial PostgreSQL regressions are being added;
the earlier passing regression set does not close these findings. SQL now
accepts the same zero-decimal spelling as the enqueue API while storing canonical
`0`; the previous 0060 SQL hash above is therefore historical.

The separate sign-basis defect is corrected: planning calculations require
authoritative aggregate coverage even for zero activity, rather than inventing
an expense account type. Fourteen domain/repository tests pass, including
liability/equity actuals and manual forecasts. Thirty-two API agent runtime
tests also pass. The current PostgreSQL regression remains 43 passing tests plus
one selected reconciliation test; new audit-specific tests are still pending.

OCR composition now accepts a configured image adapter and verifies the original
digest before invoking it. Nine extraction/worker tests prove helper failures
save no extraction, spend no model tokens, expose no helper stderr and do not
fall back to local execution. This is transport composition proof only; actual
container-backed isolation and production wiring remain outstanding.

US boundary resolution (2026-09-14): the earlier unresolved Schedule SE
threshold is now implemented from the captured IRS IRM section
3.14.1.6.12.1.3, effective 2026-01-01 for processing. Package
`2025.6-federal-working-papers` preserves exact arithmetic and entered line
values while recording the explicit 433-dollar processing exception. Root
reran 46 workflow/private-adapter tests successfully, including neighboring
amounts, fractional receipts, aggregation and trace assertions
(`/tmp/emdo-us-threshold-root.log`). This closes that specific calculation
blocker, not complete federal/state/local return acceptance.

France FEC domain integration: `france-fec.v1` is exported through the Finance
domain package; all six focused tests pass in root's rerun. Its reviewed input
requires authoritative entity identifiers, opening-balance policy, legal entry
sequence and account/document metadata. Persisted ledger mapping and API/export
integration remain outstanding; the standalone exporter is not a delivered
end-user workflow yet.

Isolated OCR runtime proof (2026-09-14): the pinned amd64 helper image builds
successfully; tested local image ID is
`sha256:aeb259f5ab3f4ffcf5fb8e75f92a7e0a0b35baf1364a1596df460a36f5f453e1`.
A separate non-root client container invoked the actual worker adapter through
the read-only shared Unix socket mount. The helper ran with network=none,
read-only root, all capabilities dropped, 128MiB memory and one CPU. Blank input
returned no-text; an 800x120 synthetic PNG returned `TOTAL CAD 123.45`, exact
source SHA256, Tesseract/traineddata provenance and three pixel-bound words.
Evidence: `/tmp/emdo-ocr-runtime-proof-one-cpu.log` and
`/tmp/emdo-ocr-runtime-proof-text.log`. Owned test containers/volumes were removed.

The real run exposed and fixed GNU timeout millisecond syntax and tmpfs owner
permissions. One CPU meets the existing deadline in this local emulated run;
the earlier 0.25 CPU setting did not. Six packaging/production-composition tests
pass after this configuration update. This is local synthetic extraction proof,
not full upload-to-review/commit PostgreSQL or staging acceptance. The local
image has not been published and OCR remains review-only source data.

### Integration checkpoint — FEC persistence and isolated OCR (2026-09-14)

Migration 0061 adds four reviewed France FEC mapping/receipt tables. Generated
metadata adds exactly those four tables without changing existing tables; the
nine migration-chain checks pass. The schema review applied the migration in an
isolated PostgreSQL transaction and rolled it back. Full repository acceptance
is still in progress. Mapping contracts and repository transaction/readback
checks pass 21 focused tests. The implementation ERD now describes revision
0061: 155 tables, 379 foreign keys, and 154 static SQL triggers.

The repeatable `infra/scripts/verify-finance-ocr-runtime.sh` now exercises the
actual worker adapter through separate network-disabled helper/client containers.
The synthetic financial-text and blank-image cases pass with source digest and
engine provenance. This is transport proof, not full upload/review/posting or
staging acceptance.

Private NY working-paper integration passes TypeScript and 13 NY/US adapter
tests. Actual PostgreSQL acceptance found that the existing tax package scope
policy rejects NY at input review. A scoped additive migration is required;
NY support must not be reported usable until that workflow passes. Country
return completion and filing remain disabled/incomplete.

### Combined acceptance — revision 0062 (2026-09-14)

The central Finance verifier applied all 63 migrations to fresh isolated
PostgreSQL 18 and ran 160 tests across 21 files. It passed 159; the NY full-case
fixture failed because its synthetic penalty/address declarations were invalid.
After correcting those declared values, a fresh NY-only run against all 63
migrations passed, including saved-run reconstruction, reviewed CSV export, and
three attempts to insert tampered federal dependency envelopes. This is combined
and targeted evidence, not a claim that the original full run was green.

FEC's five restricted PostgreSQL acceptance cases passed in the central run.
Finance-agent mapping summaries, saved-export retrieval, and production wiring
also have focused coverage. Private NY output remains incomplete working papers;
these tests do not establish full return coverage or enable filing.


### Integrated acceptance and live cutover wiring — revision 0064 (2026-09-14)

The central Finance verifier applied all 65 journaled migrations to fresh isolated
PostgreSQL and passed 166 tests across 21 files. This covers accounting, normalized
imports, investments, planning automation and private tax working papers; it does
not establish complete country returns or staging/production readiness. The ERD
now derives from snapshot 0064 (156 tables, 381 foreign keys).

Live specialist and experience readers now route activated private scopes through
posted normalized records. The API and browser preserve ledger-authority metadata;
retired local rows cannot override normalized results. Legacy editors require a
current successful legacy server read, and failed refreshes clear their server
results. Offline legacy mutation is consequently unavailable until authority is
confirmed. Browser/parser/experience checks pass 34 tests; composed live specialist
PostgreSQL acceptance is being added separately.

Activation remains disabled. Required cutover work includes nonzero opening-balance
posting, complete newly created account coverage, efficient aggregate reads beyond
the explicit 100,000-record bound, and sync/offline retirement integration. Private
staging, browser acceptance and production cutover remain outstanding. Country
packages retain their actual incomplete coverage; this checkpoint does not narrow
the original seven-country return-level goal.


### Migration workflow integration — revision 0066 (2026-09-14)

Explicit account-source assignment (0065) and immutable opening proofs (0066)
are journaled; the generated ERD contains 159 tables and 397 foreign keys.
Assignment creation is atomic with account creation, requires an explicit private
source/subtype, and supports revisioned revocation. The live compatibility reader
uses active assignment heads, never retired archival fallback. Missing new-account
opening evidence remains unavailable; new-account opening intake is still needed.

The migration and opening HTTP modules are registered in authenticated production
composition. Source discovery returns only the current user's live private spaces;
requests and responses enforce workspace/book/owner scope. The combined HTTP
boundary tests pass 46 cases. The migration UI is being connected; API wiring alone
does not establish a usable browser workflow or deployment.

The current central 67-migration run passed 168 of 169 tests across 22 suites. The
assignment backfill case failed with a constraint conflict and is under diagnosis.
Earlier standalone opening acceptance demonstrated exact positive/negative posting,
replay, comparison/approval, activated projection, reversal denial and replacement.
Historical explicit-opening reviews without dates must remain readable and blocked
for further input; they must not be silently changed to another review disposition.
Activation remains disabled pending connected acceptance, offline retirement and
private staging. The original investments, automation, and seven-country tax
requirements remain in force; this migration work does not substitute for them.


### Consolidated correction — 2026-09-14

The backfill failure was a cross-workspace normalized ID collision: the old seed
used only private-local entity type/ID. New target identities include workspace,
private space, original owner and target book; existing persisted migration target
IDs are retained. The complete verifier subsequently passed all 169 tests across
22 suites with all 67 migrations (`/tmp/emdo-finance-v2-consolidated.log`).
Historical undated explicit opening reviews remain readable and blocked for a
reviewed date; new undated commands reject. The migration review panel is mounted
under Books; focused UI acceptance and browser verification are still pending.
This supersedes the earlier failing combined-run checkpoint, not the outstanding
production/cutover or seven-country return completeness requirements.


### Panel verification and Astra request boundary — 2026-09-14

The mounted migration panel passed seven focused UI/client tests and synthetic
Playwright desktop/mobile checks for source selection and inspection. Screenshots:
`/tmp/emdo-migration-panel-desktop.png`, `/tmp/emdo-migration-panel-mobile.png`.
These browser checks used synthetic HTTP responses, not a live financial migration.

`finance-standardization-wire.test.ts` now exercises the actual OpenAI SDK and
Agents Responses serializer with an intercepted HTTP transport. It verifies one
Astra Medium request, bounded output, no unsupported sampling/cache parameters,
no session continuation, no tools, and preserved response/usage receipts. This
matches the [official Astra API migration guidance](https://developers.openai.com/api/docs/guides/latest-model#gpt-6-astra-update-api-and-model-parameters).
It is deliberately not described as a live provider run: the local workspace lacks
the configured agent API key, document keyring and pricing settings. No secrets or
private documents were sent to a provider during this check.

### Remaining investment workflow and cutover guard — 2026-09-14

The legacy transaction category/annotation editor now follows the same current
ledger-authority gate as manual transaction creation. Normalized authority or
unavailable current data disables the entry control and removes an already-open
editor. The existing eight route tests and web TypeScript check pass; these tests
do not constitute browser acceptance of the authority transition.

Fractional corporate-action settlement remains unfinished end to end: the planner
blocks cash-in-lieu basis treatment, persistence independently rejects cash-in-lieu,
and the current form supplies no settlement input. Implementation must resolve
account-level broker entitlements before allocating settlement across lots; flooring
each lot independently can incorrectly turn a whole account share into cash. This
is the next investment workflow under review, not an enabled capability.

The split planner and mounted review now expose exact account-level entitlement
as reduced rational share units, with a decimal only when representable. Older
plan payloads remain readable through an optional additive field. The helper
aggregates remaining quantities before applying the ratio; tests demonstrate
two lots at 1:2 and three lots at 1:3 produce one account share. Lot storage
limitations still block commits where applicable, and no cash amount is inferred.
Nineteen domain tests, four UI tests and the web TypeScript check pass. Remaining
cash-in-lieu work is reviewed allocation, durable settlement/receipt linkage,
balanced accounting and saved readback; this preview is not settlement completion.

The next settlement planner accepts explicit broker-delivered and cash-disposed
rational quantities, per-lot retained/disposed book costs, allocation evidence,
cash evidence, settlement date and explicit FX where currencies differ. It checks
account and lot quantity conservation, native/functional cost conservation, current
source cost consistency and the currency conversion. Output is a validated plan,
not a posting or tax assessment. The settlement-preview HTTP route reloads source
lots under existing book authority and requires the expected revision and snapshot
hash; it rejects caller-supplied source lots. Evidence identifiers in this preview
are references, not yet database-verified settlement proof. Persistence must verify
these links and claim the normalized receipt atomically before enabling commit.

Settlement checkpoint: 46 focused tests pass (19 settlement-domain, 8 HTTP,
19 existing split/entitlement tests). API TypeScript and route/export lint pass.
HTTP acceptance uses service fixtures and demonstrates authentication, readiness,
revision/hash conflicts, rejection of injected source snapshots, authoritative
remaining basis, explicit USD/CAD conversion and inconsistent allocation rejection.
It is not a live database settlement or production acceptance result.

### Durable settlement workflow and Finance readback — 2026-09-14

This supersedes the preview-only settlement checkpoint above. Migration 0067
adds normalized settlement, allocation and evidence records, forced RLS,
scoped foreign keys, immutable history and deferred completeness guards.
Posting verifies current book authority, lot and receipt revisions, exact source
snapshots and evidence hashes. It commits successor lots, balanced journals,
the economic receipt and its import claim together. Closed lots receive explicit
zero effects so they cannot reappear through historical fallback reads.

Same-date cash settles directly. Different dates require explicit action-date
valuation: the action recognizes a receivable, and the later receipt clears both
native and functional balances with separate FX gain/loss. Saved readback uses
the stored journal proof for actual book gain and FX gain. A preview's
receipt-value difference is labelled separately and is not reported as posted gain.

The mounted review supports statement receipt selection, current evidence digests,
ledger mappings, explicit confirmation, identical-command retries and saved
readback. Synthetic Chromium checks at 1440px and 390px verified the form,
uncertain-response recovery and authoritative accounting display without page
overflow. The refreshed screenshots are `output/playwright/settlement-posting-*.png`.
These browser checks use synthetic authentication/API responses, not staging.

Finance can read the saved outcome through the existing EMDO-controlled
`finance.books.read` tool, using `view: corporate-action-settlement` and a scoped
`settlementId`. It receives exact saved accounting values, bounded allocations and
record references; this adds no model write capability or automation grant.

Verification: the consolidated PostgreSQL run applied all 68 migrations and passed
174 tests in 23 suites (`/tmp/emdo-finance-v2-settlement-final.log`). After the
accounting projection refinement, all four settlement PostgreSQL tests passed
again (`/tmp/emdo-settlement-readback-pg.log`). Forty Finance agent service tests
and nineteen HTTP tests pass. The generated ERD is revision 0067: 162 tables,
407 foreign keys and 170 statically identified SQL triggers; eight generator tests pass.

Remaining scope is explicit: retained quantities that cannot fit the current
decimal lot storage are rejected, not rounded. Full rational successor storage,
complete country tax returns, live-provider acceptance and private staging/
production rollout remain unfinished. No live financial migration or deployment
was performed for this checkpoint.

### Canada T2125 private intake integration — 2026-09-14

The Ontario 2025 personal working package is now version `.15`, with form applicability inventory `.4`. Reviewed proprietor identity, CRA program-account applicability and its full 15-character identifier, last-business-year answers, and up to five income-generating websites now feed the T2125 field mapping. Conditional identifiers and website slots are optional in generic intake; the form audit enforces their applicability and rejects contradictory declarations. The package hash includes the form inventory version and private fact definitions, preventing silent reuse across changed definitions.

Verification: 70 focused personal-package/form-applicability tests passed; 7 private tax PostgreSQL integration tests passed after applying all 68 migrations to an isolated database, including conditional business intake without automatic review. Root TypeScript and focused ESLint passed. The fixture's unresolved sole-proprietor field instances decreased from 700 to 690. These are field instances, not a return-completion percentage. Country package enablement remains false; full return validation, remaining form coverage, and subsequent country releases are still outstanding. No staging or production deployment was performed.

### T2125 preparer field — 2026-09-14

Personal package `.16` and inventory `.5` add reviewed preparer name/address to private sole-proprietor intake and its captured T2125 field. Missing, blank or unreviewed details cannot satisfy the mapping. The reviewed fixture now has 689 unresolved sole-proprietor field instances. Commission accounting controls remain unresolved pending the corresponding supported calculation branch; no additional exclusion was introduced to conceal this gap. Validation passed: 71 domain tests, 7 restricted-role PostgreSQL tax integration tests on all 68 migrations, and focused ESLint. No package activation or deployment.

### Retired offline Finance write recovery — 2026-09-14

The sync repository now isolates Finance persistence in a savepoint and handles only the database's exact `23514 / legacy-finance-writer-retired` rejection as a durable terminal conflict. Other constraint and permission failures still propagate. This prevents a retired queued edit from repeatedly aborting uploads after normalized activation. Existing terminal settlement removes the optimistic pending edit and retains a review notice; the notice explains that the change was not saved and must be reviewed/re-entered in the book. It does not retain the original edit payload or claim a successful accounting write.

Repository unit tests passed 12/12 and root TypeScript passed. The isolated PostgreSQL sync suite passed 4/4, including a deliberately synthetic retirement trigger proving savepoint recovery, durable receipt replay, no retired record insertion, and shopping success in the same upload. Actual activation locking has separate migration acceptance coverage; these tests do not constitute full activation-through-browser proof. PowerSync source replication retirement and staging cutover remain outstanding.

The mounted domain/offline tests subsequently passed 60/60, including the actionable retirement notice and mixed-upload terminal settlement. Focused ESLint passed for all six changed implementation/test files.

### Actual activation-to-sync acceptance — 2026-09-14

The reviewed migration activation fixture now registers a sync client through the restricted repository and submits a queued Finance budget create after actual activation. The real activation guard yields a durable terminal conflict; retry returns that saved outcome; the retired source row remains absent; a subsequent shopping write succeeds. Existing normalized authority and new normalized-transaction projection assertions continue to pass. This supersedes the earlier synthetic-only limitation for repository-level activation-to-sync integration, while actual device/browser convergence and replication retirement remain unverified.

The isolated PostgreSQL 18 legacy migration suite passed 9/9 after all 68 migrations. The test uses the application login and scoped repository, with no injected retirement trigger. Focused formatting and ESLint passed. No staging or production activation was performed.

### Mounted Finance authority transition — 2026-09-14

Mounted FinanceRoute coverage now exercises normalized authority with cached legacy transactions/budgets and an optimistic same-ID overwrite. Only server-authoritative records render; legacy transaction and category editors close on transition, and a failed subsequent read cannot restore writes or cached rows. The route's loading/empty/unavailable state now depends on the current Finance read, not merely the offline database being ready. This fixes unavailable data being presented as an empty ledger. Unavailable messages in English, French, Japanese and Korean no longer incorrectly attribute a failed read to locked encrypted storage.

This is mounted component acceptance with mocked API responses, not real device replication removal or staging browser acceptance. Root web TypeScript and focused route lint passed; the new mounted tests passed 2/2 alongside 8 existing route helper tests.

### Explicit international date-layout mappings — 2026-09-14

Normalized statement and provider-report mappings now support `dd.mm.yyyy` and `yyyy/mm/dd` in addition to the existing formats. The five normalized upload/review selectors expose these explicit choices, including illustrative image-review labels. The deterministic parser validates calendar dates and delimiters without guessing locale, preserves source date text/row provenance, and rejects invalid leap days or mismatched layouts. Reviewed report context dates remain canonical ISO; these additions concern explicitly mapped source columns. Existing legacy import contracts retain their prior format set.

Validation: 13 statement parser tests and 9 provider-report tests pass, including both new formats, unchanged evidence, invalid dates and wrong mappings. CSV/XLSX review tests pass 10/10 and verify explicit choice transmission plus renewed review acknowledgement. Workspace TypeScript and targeted ESLint passed. This expands supported source layouts; it does not imply arbitrary report coverage or authorize automatic mapping approval/posting.

### Durable international date mapping acceptance — 2026-09-14

The source-only PostgreSQL report suite now uploads distinct original CSVs using both new date layouts, saves source-bound mapping candidates, replays each idempotency key, and reads the stored mapping definition and source rows. Both candidates normalize successfully while remaining unapproved; original date strings and SHA-256 digests are unchanged. All 4 source-persistence tests passed on an isolated PostgreSQL database after 68 migrations. This closes durable candidate acceptance for these formats; it does not authorize automatic approval or posting.

Finance-agent integration also passed 42/42 service tests: the actual `finance.reports.propose-mapping` input schema accepts each format and forwards the explicit definition with the matching original source digest to source-bound persistence, retaining candidate status and the existing approval boundary. Workspace TypeScript and source-persistence lint passed.

### Canada commission-income implementation boundary — 2026-09-14

Captured annual T1 precision metadata now includes the exact gross/net commission fields 13899/13900, copied from the existing source-hashed field catalog; reporting tests pass 5/5. No commission calculation capability is claimed by those metadata additions alone.

The connected implementation must route T2125 8299/9946 to the commission T1 fields and include net commission income in total income, CPP and its dependency graph, Schedule6/CWB, T2204, and refundable medical-supplement working income. Reviewed reporting method governs prepared input amounts; a checkbox cannot convert accrual ledger values into cash receipts/payments. Cash/accrual transitions require their own facts and supported adjustment treatment. The commission branch is under implementation and remains unavailable until its input, calculation, form and persistence integration is verified.

### Connected Canada commission workflow — 2026-09-14

Personal package `.17` and form inventory `.6` integrate reviewed income kind/reporting method with gross/net commission T1 transfers and downstream total income, CPP, CWB, EI and medical-supplement calculations. T2125 accounting selection derives from the reviewed calculation snapshot. Private preparation exposes the four new controls only for sole-proprietor cases. Neither missing selections nor accounting-method transitions silently default; cash amounts require explicit selected-basis review and no automatic accrual-to-cash conversion is performed.

All 259 Canada domain tests passed and workspace TypeScript passed. Full return/package activation remains false; the connected monetary/form work does not resolve remaining annual rounding, unsupported return cases, independent full-return fixtures or later countries. No staging or production deployment.

### Saved commission results and explicit method editor — 2026-09-14

Restricted-role PostgreSQL acceptance now completes the commission declaration/review/run path. Unreviewed facts block calculation; exact reviewed cash-basis inputs produce gross/net commission fields 13899=10,000.00 and13900=9,000.00 while business fields13499/13500 remain zero. Stored method provenance binds its reviewed source revision. Editing that method invalidates current input review, while the historical run's inputs, schedules and hash remain unchanged. All8 private tax integration tests passed after68 migrations on isolated PostgreSQL.

The declaration editor presents income kind and reporting method as explicit choices with no default selection. The existing review-then-save flow still saves unreviewed declarations. Three mounted editor tests, web TypeScript and focused ESLint passed. Full return readiness, method-transition adjustment support and production release remain outstanding.

### Integrated Finance regression checkpoint — 2026-09-14

The central `verify-finance-v2.sh` run applied all68 migrations to isolated PostgreSQL18 and passed178 tests across23 suites. This jointly exercises the current commercial accounting, migration/cutover, imports/source mappings, investment actions/settlement, planning/automation, workers and private-tax persistence changes. Full `pnpm typecheck` also passed. Evidence log: `/tmp/emdo-finance-integrated-current.log`; TypeScript log: `/tmp/emdo-integrated-current-types.log`.

This is integrated local regression acceptance, not full international tax coverage, real provider/browser/device convergence, staging approval or production rollout. Those requirements remain open; successful narrow suites do not enable incomplete country packages.

### Ontario health-premium taxable-income correction — 2026-09-14

The full-return audit exposed an operand/dependency mismatch: ON428 line89 declared T1.26000 as its dependency but actually selected its band and calculated the premium from net income23600. Package `.18` now uses taxable income26000 for both operations, matching captured2025 ON428 page4. Regression cases with reviewed loss carryforwards prove net30,000/taxable15,000 yields premium0, net50,000/taxable40,000 yields450, and net80,000/taxable72,500 yields725. All262 Canada tests and focused ESLint passed. Existing versioned saved results remain historical artifacts; this change does not silently recompute them. The package remains disabled pending remaining full-return work.

### Ontario health-premium worksheet graph — 2026-09-14

Package `.19` replaces its opaque premium-band expression with an explicit source-backed worksheet graph: taxable-income line1, selected-band income/excess/rate-product/total, then ON428.89. Plateau rows depend on reviewed taxable income; unselected editable rows are inapplicable only for a nonblocked calculated branch. Exact captured proofs bind20 worksheet controls and line89. Fractional cents remain rounding-unproven and block downstream reported amounts instead of being rounded or hidden behind a transfer.

All291 Canada tests passed across11 suites, including27 worksheet tests, applicability and carryforward regressions. Workspace TypeScript and root-scoped ESLint passed; the source verifier checked1309 numeric fields against8 captured CRA PDFs. Full-return readiness remains false. This finishes the health-premium worksheet dependency chain, not the remaining ON428 graph or international return coverage.

### Ontario surtax printed-line graph — 2026-09-14

Package `.20` and form inventory `.8` replace the condensed surtax/pre-reduction expressions with printed63–73 transfers, both repeated68 fields and selected66/67 operands. The omitted split-income, dividend-credit and minimum-tax terms remain bound to existing reviewed scope declarations. Below/equal5710, the four editable66/67 fields are inapplicable only when a nonblocked calculation establishes line65. Subcent results and unresolved upstream field proofs still block downstream reporting.

All303 Canada tests passed across12 suites, including11 independent surtax graph cases and pure form-applicability checks. Twelve exact captured proofs were added; the source verifier checked1309 numeric fields across8 CRA PDFs. Remaining upstream Ontario bracket/credit proofs, full-return coverage and production readiness remain unfinished.

### Ontario selected tax-bracket graph — 2026-09-14

Package `.21` and form inventory `.9` record taxable income, the selected Ontario PartA column's editable2/4/6/8 operands, and the printed line51 transfer used by the existing internal ON428.8 field. Published thresholds, rates and base amounts remain source constants;15 read-only form controls preserve captured defaults, while only the16 unselected editable controls are inapplicable once the calculated branch is established. No percent rate is misrepresented as a monetary field and no subcent rounding is added.

All318 Canada tests passed across13 suites, including13 bracket tests covering every boundary, published base amounts, source paths, selected-column applicability and subcent propagation. Scoped ESLint and the captured numeric-source verifier passed. Ontario credit/reduction graph completion and full-return readiness remain open.

### Connected Ontario credits, reduction and final tax — 2026-09-14

Package `.22` and form inventory `.10` add printed credit subtotals, minimum-tax carryover zero-input calculations under reviewed exclusions, tax-reduction intermediates/repeated values, foreign-credit transfer, LIFT subtraction, food-credit exclusion and line90→T1.42800. The existing economic result is preserved for supported inputs; omitted terms remain tied to specific reviewed scope declarations and all subcent reporting blockers propagate. The published readonly line45 rate is source data, not a monetary amount.

All331 Canada tests passed across15 suites, including independent credit/reduction cases and source dependencies. Workspace TypeScript and root-scoped ESLint passed. Thirty-three captured proofs were added; the source verifier again matched1309 numeric fields across8 CRA PDFs. Full-return readiness remains incomplete: remaining fields and unsupported scenarios are not treated as complete by these connected Ontario calculations.

The private-tax PostgreSQL suite also passed8/8 after68 migrations with the expanded Ontario graph, including exact reviewed commission inputs, immutable saved results and current-input invalidation. No package activation or deployment occurred.

### Federal Part C and Step 6 reconciliation — 2026-09-14

Workflow `.23` and form inventory `.11` connect federal tax119 through40400, repeated credit subtotals,42900, foreign/special-tax guarded transfers,40600,41600 and41700 to42000. Step6 now carries143→43500→149 and48200→166 before the signed167 reconciliation and separate gross refund48400/balance48500. Omitted terms retain existing reviewed scope dependencies. The Ontario opportunities-fund choice is not inferred; gross refund is not a completed net-refund instruction. Twenty-three exact captured field proofs bind these transfers, including35000. No subcent rounding or country activation was introduced.

The eight private-tax PostgreSQL tests passed after all68 migrations (`/tmp/emdo-federal-chain-pg.log`), verifying reviewed input binding, saved schedules, historical immutability and current-source authority. The source verifier matched1309 numeric fields against8 hashed CRA PDFs. The remaining federal bracket, basic-personal-amount and credit/income subtotal graphs, annual reporting rules and complete independent return fixtures remain unfinished; this is local implementation evidence, not complete-return or production acceptance.

Final integrated Canada validation:342/342 tests across17 suites passed, workspace TypeScript passed and scoped ESLint passed. The ordinary fixture inventories still show253 individual/604 sole-proprietor unresolved or reporting-blocked controls; these counts are diagnostic, not completion percentages.

### Current durable image-upload regression — 2026-09-14

Reran `infra/scripts/verify-finance-image-durable.sh` against the current source and migration journal using local image SHA256 `aeb259f5ab3f4ffcf5fb8e75f92a7e0a0b35baf1364a1596df460a36f5f453e1`. The helper ran network-disabled, read-only, as UID10003/GID10004 with all capabilities dropped. Actual Tesseract5.3.0 extraction yielded8 source words; exact reviewed mapping produced1 normalized row and1 posted journal. Encrypted original evidence and replay receipts were verified. Log: `/tmp/emdo-image-durable-current.log`. Disposable resources were cleaned up by the runner.

This proves the current synthetic image path through persistence and posting with a provider-free proposal fixture, not a live Astra request or staging deployment. Scanned and mixed PDFs still block in `finance-standardization-extraction.ts`; existing image OCR support does not imply PDF-page OCR support. That remaining adapter must preserve original PDF digest, page/coordinate provenance and bounded isolated rendering before it can be enabled.

### Scanned-PDF page provenance foundation — 2026-09-14

Added separate PDF-page render/OCR contracts. Original PDF digest and page inventory remain distinct from the derived PNG digest; renderer identity/version, rotation, scale and raster dimensions are explicit. Nested image OCR keeps raster-local page1 coordinates, while the enclosing record identifies the original PDF page. Validation rejects OCR from another raster, invalid page/rotation/pixel limits and undeclared completion claims. Ten contract tests and scoped lint passed.

This is a component of the unfinished scanned/mixed PDF import lane. It is not wired into extraction capability readiness, database review, or the UI yet. Required remaining work includes isolated renderer packaging/transport, per-page failure inventory, saved evidence access and review bindings, page-image review, mixed embedded/OCR source handling and durable end-to-end acceptance. Existing scan blocking remains until that path is integrated.

PDF inventory contracts now require every original page exactly once and retain separate embedded-text extraction references, OCR results and explicit unresolved-page reasons. Nested OCR must match the enclosing original digest, page count and page number. Missing/duplicate pages and cross-document results reject. Thirteen focused contract tests and ESLint pass. Embedded extraction references will still require authoritative saved-source checks in the persistence integration; schema validation alone does not confer that authority.

### Federal credit subtotal and top-up graph — 2026-09-14

Workflow `.24` connects printed PartB84→85 and contribution/employment96 (including its repeated field) through98/101/106, medical addition33500 and percentage33800. The captured top-up worksheet now retains1–5 and7 before34990→35000. Sixteen exact field proofs were added; omitted claims remain bound to reviewed scope facts. Basic-personal-amount worksheet replacement is deferred because its dimensionless ratio requires explicit saved reporting evidence; no phantom monetary ratio node or invented rounding was introduced. Form applicability inventory remains `.11`.

Initial full Canada validation passed345 tests across18 suites; captured-source verification matched1309 fields against8 PDFs. Restricted private-return PostgreSQL passed8/8 after68 migrations (`/tmp/emdo-credit24-pg.log`); scoped ESLint passed. This closes the connected credit subtotal graph for the existing supported calculations, not the remaining basic-personal-amount, bracket, return-year rounding or complete-return coverage.

Final root rerun passed346 Canada tests plus13 PDF provenance tests (359 total,19 suites). The added nonzero CPP/EI/employment fixture independently verifies all four contribution operands. Workspace TypeScript exposed only concurrently unfinished PDF renderer type errors, which remain assigned to that owner; no global typecheck pass is claimed at this checkpoint.

### PDF page rendering and OCR coordinator — 2026-09-14

The bounded PDF.js renderer now has actual raster tests for scan-only/mixed pages, decoded pixel content, rotation, digest/page/pixel/output limits and cancellation. A separate worker coordinator binds original PDF bytes and page identity to rendered PNG bytes/digest, then invokes an explicitly injected image OCR adapter. No local renderer fallback is wired. OCR observation metadata remains separate from original PDF identity; blank/no-text observations do not imply complete coverage. The combined renderer, coordinator and provenance suites passed25 tests; scoped lint passed.

Native rendering still requires a killable isolated process/container and release packaging. Worker termination is not a hard native allocation/time sandbox. Neither the renderer nor the coordinator is registered in production standardization; persistence, mixed-page review and end-to-end PDF acceptance remain pending. Existing image imports remain unchanged.

### Mixed-document OCR orchestration — 2026-09-14

Added a candidate-only document coordinator around bounded native-text extraction and explicitly supplied page-render/OCR adapters. Embedded extraction bytes remain represented by a separate digest and returned facts; no OCR is relabeled as native spans. Every page is retained, including render failures, output-limit cases and pages skipped after cancellation. Aggregate proposal size is bounded without silently truncating words. Original-digest mismatch fails before extraction. Ten coordinator tests passed, including genuine mixed PDF fixtures and cancellation inventory; scoped ESLint passed. Production registration, saved extraction/review and isolated transport acceptance remain unfinished.

The document coordinator now also passes an actual PDF.js-rendered mixed-document test: page2 raster bytes are hashed, their PNG dimensions feed a deterministic OCR observation, and saved candidate metadata retains original PDF/page identity separately from raster identity. Four document tests and scoped lint pass. This is a real rendering handoff with fixture OCR, not actual Tesseract or durable PDF import acceptance.

The document-to-page handoff now also supplies the independently inspected original page count. Renderer disagreement rejects before OCR invocation, rather than waiting for final inventory assembly. Twelve coordinator tests and scoped lint pass, including this rejection and actual mixed-PDF rendering. This strengthens the source boundary while isolated runtime integration remains in progress.

### PDF extraction evidence integrity — 2026-09-14

Added a reusable saved-facts verifier and connected it to document candidate output. It checks the whole-extraction digest, expected original PDF digest, independent embedded extraction digest, page inventory cardinality and page-kind references. A newly hashed outer envelope cannot hide altered embedded facts. Eight verifier/document tests and scoped lint pass. The verifier does not supply book permissions or approval: future repository reads must bind expected digests to immutable source/extraction rows and current authorization.

### Integrated PDF renderer checkpoint — 2026-09-14

Root ran all six new PDF component suites together:43 tests passed, including actual built-child rendering, byte/page provenance, malformed frames/runtime/trailing-data rejection, cancellation, mixed-page coordination and saved evidence integrity (`/tmp/emdo-pdf-components.log`). Workspace TypeScript passed (`/tmp/emdo-pdf-integrated-types.log`). The dedicated local image `emdo-finance-pdf-render:local-foundation` was independently inspected as SHA256 `7fc58a3c20dacc32bca7b44389e79bf56d32a20c7583728bda960eb798fec8eb`, user10005:10005, fixed helper entrypoint. Owner also passed restricted network-disabled Linux rendering against this dedicated image.

Release-owned Unix socket supervision remains the next runtime integration requirement. The application must not launch Docker or acquire a Docker control socket. No standardization activation, saved PDF review, migration or production deployment is proven by this component checkpoint.

### PDF OCR review identity boundary — 2026-09-14

Added a review-selection contract with separate original-PDF and derived-raster identities. The resolver binds the saved run/revision and extraction digest, resolves only an OCR page present in the verified document, then checks raster digest/dimensions and complete word-inventory digest. Unresolved pages cannot be replaced by caller-supplied raster claims. Eighteen provenance/evidence tests, scoped ESLint and workspace TypeScript passed. Cell/region materialization, repository authorization, UI and posting remain separate unfinished integration work; these selection flags confer no approval.

The PDF review resolver now has a positive saved-page test plus substitutions of raster digest, OCR extraction digest, dimensions and word inventory. Six evidence tests and scoped lint pass. Reviewed table materialization is assigned separately so the existing image cell correction/overlap checks can be reused without mislabeling a PDF as an image or native text spans.

### Saved PDF OCR reader migration — 2026-09-14

Migration0068 adds only `emdo.read_finance_pdf_ocr_extraction`, retaining current book authorization, row security, original PDF format/digest, exact extraction kind/revision and hashed facts checks. Only emdo_app receives execution; worker roles and PUBLIC do not. No extraction activation or write permission is added. All69 migrations applied to disposable PostgreSQL; the restricted-role reader test passed, and8 existing private-return tests passed. The migration snapshot suite now checks all69 snapshots and unchanged tables for0068:14/14 pass. Added the reader test to the central Finance verifier. Positive saved-PDF readback and revocation during the full PDF review workflow remain pending.

### Integrated Finance and PDF socket acceptance — 2026-09-14

Central Finance verification applied69 migrations and passed180 tests across24 suites (`/tmp/emdo-finance69-integrated.log`). Reviewed PDF OCR materialization passed6 focused tests after aligning its original-byte bound to2MiB and exporting its integration entrypoint. Output preserves original PDF/page anchors and keeps raster cell evidence nested; no image/native-PDF provenance is falsely attached at table level.

The isolated renderer owner completed actual two-container Unix socket acceptance against image SHA256 `db9d26851d685b1f4d7d37d1747ffe65ad2cc3041c0a6c0292e094dc38f7aa55`: rendering, concurrent-request rejection, disconnect recovery and stalled-frame deadline recovery passed. Both containers denied network, used read-only roots and resource caps; clientUID10006 used a read-only socket mount with helperGID10005. Twelve transport tests, lint and TypeScript passed. This closes local isolated transport acceptance, not production lifecycle/wiring or saved PDF review/import acceptance.

### Saved inspection API and proposal instructions — 2026-09-14

The saved PDF OCR repository/API read lane is implemented at `/api/v2/finance/books/:bookId/evidence/:recordId/pdf-ocr-inspection`, binding current book authority, run/revision, stored extraction digest, injected verifier and original PDF bytes. Owner passed62 focused/adjacent tests, lint and TypeScript before the concurrent prompt-version integration. No writes/raster endpoint or UI is implied.

Active durable proposal instructions advance to `.v2`, adding already-supported dotted/year-first-slash date formats and explicit original-PDF versus raster-page identity/uncertainty rules. Historical `.v1` provenance remains readable through a version union. Eighteen delegation tests and scoped lint pass. Worker lineage type compatibility and gated PDF extraction are concurrently being integrated; no overall TypeScript pass is claimed for that unfinished combination yet.

### Reviewed PDF OCR mapping and normalization — 2026-09-14

Source-only mapping candidates now support pdfOcrSelection with current prepare access, saved extraction verification, isolated exact-raster regeneration, idempotency and existing API CSRF protection. Owner passed53 focused/adjacent tests, lint and TypeScript; approval remains separate. SQL0069 exact linking constraints and real restricted-role write acceptance remain pending.

Root added domain binding checks for reviewed-pdf-ocr.v1 source/run/revision/digest/page metadata and preserves nested PDF OCR cell provenance in mapped and unmapped fields. An actual materialized reviewed table test proves original-page provenance survives normalization and a changed page rejects. Sixteen mapping/materialization tests pass. Test fixture source columns remain distinct; no column is reused for different financial meanings.

### Prompt-version database compatibility finding — 2026-09-14

The effective nine-argument `reserve_standardization_spend` function still hard-codes proposal.v1, while the active hook now emits.v2. Migration0069 ownership includes preserving the existing controls while allowing exactlyv1/v2. Root updated the real PostgreSQL cancellation/charging/retry reservation fixture to exercisev2; the existing complete-proposal fixture retainsv1 compatibility coverage. That new database regression is pending0069, not yet green. Full PDF saved-reader/mapping-link acceptance is being implemented independently against the same migration.

### PDF mapping acceptance and integration — 2026-09-15

Migration0069 generic linking regression was a PL/pgSQL record/SQL alias collision; renaming the new record preserved the existing CSV branch. Actual restricted PostgreSQL standardization tests pass14/14 after all70 migrations (`/tmp/emdo-standardization-v2-fix.log`). The new PDF OCR PostgreSQL acceptance passes1/1 (`/tmp/pdf-ocr-pipeline-pg.log`): encrypted mixed original, claimed extraction, v2 spend, saved inspection, regenerated raster/materialized mapping, link replay and source/revision/authority rejection. Rendering is real PDF.js; OCR words are deterministic fixtures, and posting is not covered by this test.

The execution repository now accepts both explicit historicalv1 and activev2 prompt lineage types. Workspace TypeScript and scoped ESLint pass. The new PDF test is included in the central Finance verifier. Browser saved-inspection helper binds requested source/run/revision/digests and uses no-store; its three focused tests passed in the preceding checkpoint. Mounted review and Finance-agent inspection integration remain in progress.

Central Finance verification now passes182 tests across25 suites after70 migrations (`/tmp/emdo-finance70-integrated.log`). A subsequent targeted PDF acceptance extension passes with approval-before-normalization enforced and normalized amount provenance retaining original page2 and reviewed12.50 raster cell (`/tmp/emdo-pdf-normalization-pg.log`). This is source normalization evidence, not posting or production activation.

PDF acceptance now persists a normalized review batch, proves idempotent import replay, and reads the original-page/raster-cell provenance back from stored row facts (`/tmp/emdo-pdf-import-pg.log`, targeted actual PostgreSQL pass). The Finance specialist existing `finance.reports.inspect` capability now reads saved PDF OCR by explicit run/revision/original page, with separate original/raster digests and unresolved coverage;59 focused service/schema/composition tests and owner lint pass. It does not perform new OCR/provider calls or approve mappings. Mounted UI remains in progress.

The generated database ERD is refreshed through journal revision0069, including current source hashes and SQL inventory:162 tables,407 foreign keys,170 triggers. All8 generator tests pass. This documents the implemented schema; it does not assert that remaining tax packages or production rollout are complete.

### Browser artifact boundary restored — 2026-09-15

The full web release build caught server authority schema strings in the Finance chunk. The browser stock-split preview reached the root contracts barrel through corporate-actions and corporate-action-entitlements domain helpers. Both now use the existing browser-safe contract entrypoint. Full web build including assert-release-artifact passes (`/tmp/emdo-browser-boundary-build.log`);23 focused corporate-action/entitlement/browser-boundary tests and scoped lint pass. Updated the explicit browser module inventory for previously added public settlement, FEC, opening and PDF OCR contracts after inspecting their imports. No server authority exports were added or artifact checks weakened.

### Mounted PDF review and staging configuration — 2026-09-15

PDF review UI now routes saved PDF OCR runs to original-page selection and the reviewed-region editor, preserves explicit OCR corrections and other-page acknowledgement, and saves source-only PDF OCR candidates. Owner reports29 passing UI/helper suites plus subsequent blocked/manual wrapper regression. The blocked lifecycle now exposes review-source only for correctly paired PDF/finance.pdf-ocr saved extraction; missing extraction, wrong format and revoked authority remain unavailable (3 domain tests pass). Root workspace TypeScript and scoped lint pass.

Opt-in private-staging renderer overlay and runbook are added;3 Docker Compose configuration tests pass with synthetic values. They check helper isolation/resource caps, read-only API/worker sockets and required OCR overlay/GID retention. No services were started by this configuration check. Actual browser verification and real OCR-through-posting PDF acceptance are the next bounded integration checks.

The extraction registry now explicitly includes finance.pdf-ocr and removes the obsolete claim that scanned-page OCR is unavailable. It preserves the native PDF adapter as the default format lookup and describes isolated-runtime prerequisites, original-page/raster identity, unresolved coverage and explicit review. Nine registry/extraction tests and scoped lint pass; runtime activation remains separate.

### Actual PDF OCR through posting — 2026-09-15

Local isolated acceptance (`/tmp/finance-pdf-durable.log`, session92194 exit0) uses genuine raster PDF page2, real PDF renderer and Tesseract5.3.0 with helpers network-disabled/read-only. It proves encrypted upload, claimed saved extraction, deterministic provider-free proposal/spend, reviewed mapping, one normalized123.45CAD row and one posted bank-debit/capital-credit123.45 journal with receipt replay. Page3 remains unresolved after an actual renderer limit rejection. No live model call or production activation is proven. Browser verification remains in progress.

Source-selection mismatch errors now identify PDF OCR as PDF and image selections as image, rather than incorrectly reporting an XLSX review requirement. Ten adjacent saved PDF repository tests and scoped lint pass.

### Grant-controlled extraction integration — 2026-09-15

API now provides inert extraction preparation with scoped stable UUID retry identity, exact source-only enqueue validation, and current-principal immutable result reads. Twelve route tests pass. Finance read projection includes executionMode and instructions distinguish extracted observations from proposal/approval/posting; twelve standardization UI tests pass. Root integrated TypeScript passed before the latest worker acceptance additions.

Extraction UI owner reports17 tests, lint, TypeScript and full web release build passing. First restricted PostgreSQL run applies71 migrations and passes grant-controlled execution after browser expiry, inert preparation, saved reuse, no model spend and revocation (`/tmp/automation-extraction-pg.log`); migration remains under owner validation. Root review found image reuse incorrectly requiring a live OCR adapter despite saved facts; owner corrected the guard and is adding focused coverage. Actual browser automation verification is next.

### Integrated extraction automation checkpoint — 2026-09-15

Central Finance verifier applied all71 migrations and passed183 tests across26 suites (`/tmp/emdo-finance71-integrated.log`, session92160 exit0). Owner also passed60 focused worker/domain/snapshot tests, TypeScript and lint. Actual extraction automation Chrome acceptance passed2/2 with synthetic scoped responses, explicit preparation/enqueue, identical lost-response retry, immutable outcome reads, mobile layout and revoked-book clearing. These prove local implementation/acceptance, not deployment. Manual CSV/XLSX mapping after extraction-only completion remains under implementation. Saved investment reconciliation cases/resolutions are the next backend lane.


### Investment reconciliation integration checkpoint — 2026-09-15

Migration0071 now has book-scoped immutable reconciliation cases and events, exact saved comparisons, evidence-backed resolution, explicit reopening, source freshness, and a five-kind corrective-record catalog. API routes and Finance-agent reads are wired to the repository. Reconciliation actions have no accounting effect. API persistence failures map to403/400/409/503 with sanitized details, including readiness and mutation failures; agent records retain distinct case status and comparisonStatus.

Root validation:54 API/agent tests pass, repository-wide TypeScript and scoped ESLint pass. The central disposable PostgreSQL verifier applies all72 migrations and passes184 tests across27 suites including reconciliation acceptance (`/tmp/emdo-finance72-integrated.log`, exit0). UI owner reports7 focused tests and full release build passing; real browser reconciliation acceptance is ongoing. Additional positive corporate-action linkage fixtures are assigned separately. ERD regenerated through0071:165 tables,411 foreign keys,176 SQL triggers;8 generator tests pass. These are local checks; no staging/production or full tax coverage claim.


### Reconciliation acceptance completed locally — 2026-09-15

The restricted PostgreSQL reconciliation suite now passes3/3 with actual committed stock splits, cash-in-lieu settlements, and cash dividends. Each positive corrective linkage verifies catalog eligibility, saved evidence/snapshots, resolution replay, nonexistent references, and cross-instrument rejection (`/tmp/investment-reconciliation-links-pg.log`). This extends the earlier184-test central checkpoint; that earlier count predates these two added cases.

Actual Chromium acceptance passes1/1 against synthetic local API fixtures: exact create retry after a lost response, named corrective resolution, stale-source reopening with retained history, revoked-access clearing,390px mobile overflow and accessibility checks. Web typecheck/lint pass. Screenshots are under `output/playwright/investment-reconciliation`; root inspected the reopened mobile history. Browser and PostgreSQL evidence are separate scopes, not a claim of real API-to-browser deployment.

Next integration gap under assessment: `finance.journals.draft` remains in the automation capability contract without a production leaf. Existing journal insertion always posts within the same transaction; using its draft state requires a complete review/post/discard lifecycle because open drafts block period closing. The next implementation must preserve grant revocation, exact source intent, authoritative limits, immutable saved outcomes, and explicit posting approval. Recurring extraction also lacks a schedule intent and remains a separate unfinished requirement.


### Finance agent history and automation grant parity — 2026-09-15

Finance now has an explicit `investment-reconciliation-history` read instead of an instruction to follow a URL that no tool could read. Exact case scope and contiguous revisions are checked before a stable paginated stream of event, evidence, and corrective-record facts. Child rows retain event/case bindings and current stale status; links point to the existing case endpoint.45 service tests, scoped lint, and full TypeScript pass (`/tmp/finance-history-tests.log`, `/tmp/finance-history-types-final.log`).

Root fixed durable grant validation still limiting capabilities to3 after migration0060 expanded the supported count to5. API and repository now reuse the public grant capability validator, preserving uniqueness and bounds.25 domain/repository-boundary tests and12 API tests pass; repository lint passes. No capability readiness is enabled by this validation fix.

Migration0072 ownership is assigned to the journal automation lane. Generated drafts must remain nonposting proposals and reuse the canonical normalized import commit path only after explicit human authorization. No new independent accounting write path is authorized by this work.


### Exact corrective snapshot follow-up — 2026-09-15

Root integration check passes59 tests across Finance-agent, automation API and durable grant boundaries. Reconciliation history tests now parse all three pages through the actual tool output schema (45 service tests pass), rather than using a type assertion.

Review identified an unresolved precision defect after the earlier local reconciliation acceptance: `to_jsonb(r)` corrective snapshots cross pg's JSON parser and JavaScript numbers before persistence/readback. Large or fractional exact numeric values can be rounded, causing snapshot guard rejection or inaccurate evidence projection. Reconciliation owner is reproducing this with actual PostgreSQL and implementing raw SQL JSON capture plus lossless snapshot-subtree reads, without changing0071. Earlier simple-value tests do not prove this invariant; exact snapshot acceptance remains open until the regression passes.


### Corrective snapshot precision regression resolved — 2026-09-15

The actual PostgreSQL regression first reproduced the old `investment-reconciliation-correction-mismatch` failure for `-9007199254740993.123456789012`. Repository capture now keeps database-produced snapshot JSON raw until SQL insertion; reads parse the snapshot subtree using Node24 JSON reviver source tokens, exposing numeric fields as exact strings. No migration changed. All3 restricted PostgreSQL reconciliation tests pass afterward (`/tmp/investment-reconciliation-exact-after.log`), including save/reread, original corporate-action links, and unchanged quoted numeric/exponent text. Scoped repository lint passes.

Root Finance-agent regression verifies exact large and negative fractional strings through the tool output contract. Monetary/quantity snapshot fields supplied as JavaScript numbers are rejected instead of stringifying rounded values.45 service tests and scoped lint pass (`/tmp/finance-history-exact-projection.log`). Full shared TypeScript verification passes (`/tmp/finance-exact-snapshot-types.log`, exit0).


### Exact snapshot UI follow-through — 2026-09-15

Mounted reconciliation UI regression now opens saved corrective evidence and verifies the exact displayed strings `9007199254740993.123456789012` and `-0.000000000001`.5 UI tests pass (`/tmp/finance-reconciliation-ui-exact.log`). This complements the PostgreSQL and Finance-agent precision regressions without implying deployment.


### Journal automation API and canonical commit integration — 2026-09-15

Root added optional journal-draft service routes under `/api/v2/finance/books/:bookId/automations/journal-drafts`: prepare, list/detail, review, discard, and explicit post. Current principal scopes all calls; mutation verification and identical retry keys are retained. Prepared batch identity/currency precision and saved result workspace/book/id are validated; persistence failures are sanitized.9 route boundary tests pass. Existing automation enqueue now accepts an exact journal intent bound to one batch and rejects mixed or missing intents;13 automation API tests pass. Scoped lint passes. Successful persisted lifecycle responses, database binding and production service wiring remain unfinished until0072 is implemented.

The canonical import command now delegates to `commitNormalizedImportInTransaction`, a query-only-client hook retaining current approver checks, canonical book lock, duplicate handling, component evidence and source linking.29 actual PostgreSQL tests pass across commercial, OFX, and normalized components on72 migrations. The journal worker/execution repository has27 focused tests and lint passing; migration readiness remains unimplemented and unactivated. Its canonical claim requires authoritative `journalReview` line count, currency and debit amount. Shared type checks currently report the journal schema owner's missing component-table import; that correction is assigned.


### Journal management adapter and posting transaction — 2026-09-15

Root added `FinanceJournalDraftRepository` and the optional production API binding. Read/prepare/review/discard call the agreed narrow RPCs; readiness requires all lifecycle functions and forced RLS on the three journal-draft tables. Explicit posting uses one authenticated scoped transaction, current approver access, exact retry identity, source/approval lock RPC, the canonical normalized-import hook, final lifecycle RPC, receipt and audit. The adapter reads saved state on identical replay and never calls the canonical posting hook twice. It remains unavailable until0072 functions exist; actual PostgreSQL lifecycle proof is pending.

The enqueue repository now accepts exact journal source intent, calls the journal-specific enqueue RPC, and reads journal intent without fabricating a report selection.28 combined API/adapter/grant tests pass; the expanded posting suite passes5 tests covering replay, changed retry input, revoked book/session access and rollback after final validation failure. Full shared TypeScript passes (`/tmp/finance-journal-shared-types.log`); scoped adapter lint passes. Unit transaction sequencing is not a substitute for the pending real database acceptance.


### Journal database bootstrap and browser acceptance — 2026-09-15

Root's first actual0072 apply exposed invalid chained boolean equality in the Drizzle state check. Owner corrected the schema/SQL. The second bootstrap applies all73 migrations on disposable PostgreSQL18 (`/tmp/emdo-journal-migration-bootstrap.log`, exit0).0072 is still under construction; this proves current SQL apply only, not missing lifecycle functions or runtime correctness. Root flagged snapshot completeness: account mapping/currency/active state, book functional currency, relevant periods and dedup inputs must bind saved proposal authority. Re-derivation must not silently post different lines after approval.

Actual Chromium synthetic journal acceptance passes3/3 in14.4s (`/tmp/journal-drafts-browser-final2.log`). It covers saved preparation/queue/post with lost-ack identical retries, explicit posting confirmation, unreviewed and rejected discard histories,403/book clearing,390px layout and accessibility. A discovered horizontal-scroll keyboard defect was fixed with a named focusable region and actual arrow-key scroll verification. Lint/full TypeScript pass; root inspected posting-confirmation mobile screenshot. Browser fixtures remain separate from database acceptance.

Independent journal lifecycle/line-parity tests are now owned by the canonical-commit agent; Finance-agent read projections are being wired in parallel. Durable composition injects the journalDrafts service. Final ERD regeneration remains pending0072 stabilization.


### Journal agent reads and regression integration — 2026-09-15

Finance-agent composition now exposes journal-drafts, journal-draft, journal-draft-lines and journal-draft-history. It validates exact scope/lifecycle/proposal facts, preserves decimal strings, and pages flattened lines/events with current draft revision and real draft/evidence references.49 focused services/composition tests and lint pass; root durable injection is present.10 journal API boundary tests pass, including full saved-post output and workspace/book/draft substitution rejection. Management readiness now requires EXECUTE privilege on every app lifecycle RPC, not only function existence.

New journal intent validation exposed22 failures in the existing generic automation authority fixture, which had used journal capability without a source intent. Root supplied the exact snapshot intent and retained all authority/limit expectations;40 domain/schedule/worker regression tests pass. Snapshot-chain metadata test still expected72 entries after0072; owner is updating that gate.

Independent real database preparation exposed insufficient privilege for SELECT FOR UPDATE on normalized import sources. Root advised retaining source SELECT-only permissions and relying on verified canonical book writer locks instead of granting broad source UPDATE. SQL owner is correcting this before the14-case lifecycle/parity suite runs. No completed database lifecycle claim is made.

### Journal integrated validation checkpoint — 2026-09-15

Current full root and web TypeScript checks pass (`/tmp/emdo-journal-current-types.log`). The real PostgreSQL lifecycle suite reached 5 passing and 9 failing cases after preparation fixes; remaining failures exposed an immutable-result row-lock privilege issue, two mapping-drift fixture setup errors, and missing stale-source validation at approval. Owners are correcting these with restricted application and worker roles preserved. Approval must validate the current bound source snapshot under the canonical book lock, and posting must independently validate it again.

Root review also identified that final posting parity must preserve multiplicity: two identical proposed journals cannot both be satisfied by one actual journal. The SQL owner has this correction alongside consistent command-key validation. The journal lane remains pending database acceptance; passing type checks and synthetic browser checks do not establish that acceptance.

The shared `packages/db/scripts/verify-finance-v2.sh` now includes journal-draft PostgreSQL lifecycle acceptance, including distinct source identities with identical transaction signatures. Shell syntax validation passes. Current migration snapshot-chain checks pass all 15 tests (`/tmp/emdo-journal-snapshot-current.log`); current API/repository boundary checks pass all 15 tests (`/tmp/emdo-journal-root-boundaries-current.log`). Final lifecycle rerun remains pending SQL owner handoff.

### Journal lifecycle database acceptance — 2026-09-15

All 15 restricted PostgreSQL journal-draft cases pass against all 73 migrations (`/tmp/emdo-journal-draft-full-verify.log`). This covers exact CAD, FX, JPY, large-decimal and component posting parity; two identical-looking transactions with distinct source identities; concurrent posting retries; overlap rejection; stale-source rejection at approval and posting; discard and revoked authority. Final parity compares normalized decimal strings, source references and one distinct posted identity per proposed journal. The disposable database was removed after verification.

The ERD was regenerated through migration 0072: 168 tables, 418 foreign keys and 178 SQL triggers (`/tmp/emdo-erd-0072.log`). The combined Finance PostgreSQL verifier is running separately; this checkpoint does not claim staging, production, scheduler support for journal drafts, or completion of country tax packages.

The combined verifier subsequently passed: all 73 migrations applied, then 201 tests across 28 suites passed in 71.22 seconds (`/tmp/emdo-finance73-integrated.log`, exit 0). This includes the new journal lifecycle alongside normalized imports, extraction, reconciliation, planning automation, commercial accounting, investments, migration and tax-platform database regression coverage. It does not establish complete jurisdictional return calculations or production readiness.

### Recurring reviewed-source workflows — 2026-09-15

Additive migration 0073 and schedule contracts support exact extraction and journal intents. Creation and each due occurrence validate pinned sources under the canonical book lock and current authority. Extraction reserves zero money; journal item counts and debit totals come from authoritative derivation. Changed or committed sources block without advancing the cursor. Distinct occurrences may generate separate review-only drafts; retries preserve the same occurrence/run. No schedule posts journals or follows newer uploads automatically.

Restricted PostgreSQL acceptance passes all 15 schedule cases after 74 migrations. Root combined validation exposed test readiness leakage, corrected by restoring the fixture's original capability flags. The rerun passes all 210 tests across 28 suites (`/tmp/emdo-finance74-integrated.log`, exit 0). API/repository/scheduler regression tests pass 27/27. Finance-agent reads preserve extraction/journal source pins and planning revisions; all 46 service tests pass. Full base TypeScript passes (`/tmp/emdo-recurring-final-types.log`).

Prepared-source UI checks pass 15/15 and actual synthetic Chromium passes 2/2, including exact lost-ack retries, stale-source replacement review, mobile accessibility and revoked access clearing. Root inspected `output/playwright/source-schedules/journal-replacement-mobile.png`. ERD artifacts now reflect revision 0073, with 168 tables, 418 foreign keys and 178 triggers. These remain local and synthetic checks, not production activation evidence.

Mexico's private working-paper package now computes the corporate Article 44 annual inflation adjustment with reviewed monthly balances and pinned INPC sources. It remains incomplete and disabled. Its new private-intake adapter is not yet wired into shared exports, persistence or UI; full country return support remains outstanding.

### Mexico private working-paper integration — 2026-09-15

The Mexico adapter is now wired into shared domain exports and the existing private tax preparation, input-review, saved-run, readback and reviewed-export workflow. Three exact 2025 scopes use `mx-fed-2025-working-papers`; migration 0074 extends only the existing scope helper. Shared fields carry a truthful SAT working-paper reporting target and remain non-fileable with unproven form rounding explicit. Readback verifies the adapter hash and exact case/workspace/taxpayer/snapshot bindings. Historical output and source-bound reports are retained.

Corporate creation now permits an explicitly selected legal entity, validated through a currently accessible same-workspace book. Selecting an entity does not authorize book financial facts; source authorization remains separate. Existing clients may omit the entity for incomplete intake. Book listings expose the entity identity for a named selector.

Mexico PostgreSQL acceptance passes 5/5 on all 75 migrations: missing inputs across all three scopes; reviewed corporate inflation 7380, ISR 182214 and tax due 82214; replay/export immutability; source revocation; private-case and entity isolation. Combined Finance validation passes 216 tests across 29 suites (`/tmp/emdo-finance75-integrated.log`, exit 0). Mexico/Canada-corporate/US adapter regressions pass 14/14; root lint and base TypeScript pass. ERD artifacts reflect revision 0074. Mexico UI/browser acceptance is proceeding separately; complete country returns and production activation remain unproven.

Finance-agent readback now has Mexico-specific regression coverage for exact values beyond JavaScript safe integers, null reportable amounts and the SAT reporting target; all 46 service tests pass (`/tmp/emdo-agent-mexico-readback.log`). Agent instructions preserve incomplete status and prohibit inferring units from jurisdiction alone. The UI owner removed automatic currency suffixes on exact numeric tax fields because rates, factors and counts must not be presented as money. Root inspected `output/playwright/mexico-tax/working-mobile.png`; the synthetic browser log reports one passing desktop/mobile Mexico workflow (`/tmp/mexico-tax-browser.log`).

Subsequent UI screenshot inspection found the case setup form remained displayed beneath its review due to a CSS override. The UI owner is correcting that display state and rerunning acceptance; the earlier browser pass alone does not close visual acceptance.

The setup/review display issue is fixed. Final Mexico synthetic Chromium acceptance passes 1/1 in 5.1 seconds; focused working-paper/workspace tests pass 30/30, with full base TypeScript and scoped lint passing. Root inspected the corrected corporate review screenshot. The workspace availability copy now describes available scoped workflows rather than incorrectly limiting all working papers to Ontario.

Canada's domain owner completed the bounded Schedule 9 charitable-donations graph, including oldest-first carryforwards and federal-return propagation. Owner verification reports 402 Canada tests plus source precision capture checks passing; the package remains disabled and incomplete. This does not establish full-return coverage or statutory release approval.

### Further deterministic tax coverage — 2026-09-15

Mexico 2025.3 adds reviewed first-year office/computer investment deductions with full-month proration and pinned INPC adjustment. Root updated the no-asset database fixtures to declare an explicit empty asset list and added adapter/export acceptance for two assets. All five Mexico adapter tests pass (`/tmp/emdo-mexico-investment-adapter.log`), proving exact deductions 36480.6 and exact tax due 69055.82 remain unrounded with null reportable amounts, while asset identities and source references survive export. The domain owner reports 40 passing domain tests and full TypeScript. Asset classes, histories, disposals and methods outside the implemented branch remain unsupported.

The Mexico asset-list UI is being implemented as structured rows rather than raw JSON entry. Separately, Canada saved-run donation/carryforward acceptance and explicit carryforward CSV sections are in progress; calculated ledgers were retained in saved output but missing from the existing personal CSV exporter.

The structured Mexico asset editor is implemented: exact strings are serialized only when saving an explicit reviewed form, and saved malformed/unsupported rows are not silently rewritten. Owner verification passes 23 focused tests, full TypeScript/lint and 2 synthetic Chromium scenarios; root inspected `output/playwright/mexico-tax/assets-mobile.png`. Mexico restricted PostgreSQL acceptance now passes 6/6, including nonzero asset deductions and full per-asset source evidence in reviewed exports (`/tmp/emdo-mexico-assets-verify.log`).

Canada donation persistence/export acceptance passes 3/3: missing or unreviewed carryforward inputs block; a 1000 claim produces the saved 261 credit with oldest-first carryforward use; an amended 200 claim produces 29 while the original run and export remain byte-identical. Explicit CSV carryforward rows retain opening/used/expired/closing amounts and source bindings. Root fixed one array-closing delimiter during the export implementation to unblock shared compilation; subsequent full base TypeScript passes.

Both suites are now registered in the combined Finance verifier. All 75 migrations apply and all 220 tests across 30 suites pass (`/tmp/emdo-finance75-tax-expanded.log`, exit 0). This is local regression and synthetic browser evidence; full returns, private staging and production activation remain outstanding.


### Existing corporate case entity attachment — 2026-09-15

Owner-only `POST /api/v2/finance/tax/cases/:caseId/legal-entity` now binds an initially unbound case to an accessible entity with exact case revision and idempotency identity. Current book grants are locked and rechecked, including on receipt replay. Retargeting is rejected; binding grants no source-book access. The new immutable snapshot invalidates prior working-input reviews and resets generic answer/fact review states while retaining answer hash lineage and historical snapshots. The generic manifest-backed answer branch is not exercised by the current intake-only public integration fixture.

Restricted PostgreSQL acceptance applies all 75 migrations and passes 7/7 cases (`/tmp/emdo-tax-entity-binding-verify.log`), including role/isolation/revocation, retry/stale revision, historical snapshots and fresh working-input review. The suite is registered in the central verifier. API and Mexico adapter tests pass 36/36; mounted attachment/workspace tests pass 19/19. Base TypeScript and scoped lint pass. Synthetic Chromium passes 3/3 Mexico scenarios, including explicit attachment, lost-response retry, preserved inputs, and mobile accessibility. Root inspected the mobile screenshot and corrected remaining Ontario-only case-summary wording; mounted tests pass after that copy fix. No database schema change or country activation was required.

Canada carryforward export owner reports final 405 domain tests passing, with explicit donation/noncapital-loss CSV sections and historical-run compatibility. Full-return country coverage and staging/release acceptance remain incomplete.


### Consolidated acceptance and recovery refresh — 2026-09-15

The combined Finance verifier now passes 227 tests across 31 suites after all 75 migrations (83.70 seconds, `/tmp/emdo-finance75-integrated-current.log`, exit 0). A separate encrypted restore drill passes against the same migration journal (9.31 seconds test time, `/tmp/emdo-finance75-restore-current.log`, exit 0). It reconstructs matching restricted roles and restores evidence encryption keys, accounting, planning, private tax cases, and FEC export mappings/receipts; unauthorized readers remain denied. These results replace the stale foundation/restore counts in the summary above. They do not establish private staging or full-return country readiness.


### Direct-import Finance-agent posting lineage — 2026-09-15

Normalized import reads now resolve each persisted economic transaction to its posted journal and ordered exact-decimal lines under the existing workspace/book grant and canonical book lock. A selected match target without a committed transaction remains unposted. Finance-agent import-review projections expose the saved review action, counter-account/match/transaction references and individually paginated journal/line records with original row, batch and evidence identifiers. Transaction-binding and duplicate-line inconsistencies fail validation. Instructions require this saved lineage before explaining a posting and preserve the distinction between reviewed and committed rows.

Six restricted PostgreSQL cases pass after all 75 migrations (`/tmp/emdo-import-lineage-verify.log`): unposted null, CAD/FX/JPY/large exact amounts, committed-match reuse and wrong-book/revoked-access denial. The suite is registered in the central verifier; the earlier 227-test combined result predates this addition. All 46 Finance-agent service tests pass, including exact large-amount projection and malformed posting rejection (`/tmp/emdo-import-lineage-agent-complete.log`). Full TypeScript passes (`/tmp/emdo-import-lineage-types-complete.log`) and scoped lint passes. No schema migration, readiness activation or provider execution occurred.


### Shared posting contract and human review — 2026-09-15

The shared `FinanceNormalizedImportPostingSchema` now binds saved functional currency independently of each native line currency. Repository results select functional currency from the scoped book, Finance-agent line projections preserve both currencies, and the Documents UI rejects mismatched entity/transaction/line/currency bindings. Expandable posting details show named ledger accounts, exact native/functional amounts, FX sources and original-evidence references. Missing response fields and explicit unlinked postings have distinct messages. Revoked access clears displayed private results.

Actual PostgreSQL schema/amount checks pass 6/6 (`/tmp/emdo-posting-currency-pg.log`), agent service checks pass 46/46, UI checks pass 11/11, and Chromium desktop/mobile acceptance passes 1/1 (`/tmp/import-posting-browser-final.log`). Root inspected the saved mobile screenshot. Full base and web TypeScript now pass (`/tmp/emdo-current-finance-types.log`); one existing deferred Mexico test fixture needed a literal type annotation only. Tax and investments are visibly marked WIP and paused at user direction; 15 relevant UI regression tests pass. Active work is imports, Finance-agent integration and automations.


### Permanent automation failure handling — 2026-09-15

Journal and extraction leaves now return bounded blocked reasons for invalid intent, changed/invalid sources, revoked authority and unavailable extraction configuration. Confirmed journal lock/result contention stays retryable; aborted pre-effect work stays unapplied; an unknown save/commit outcome stays indeterminate. Extraction rechecks original digests and retains existing verified image observations without requiring fresh OCR. Raw errors and document contents are not copied into failure reasons.

The existing dispatcher persists blocked reasons and does not enqueue another retry for them. A journal source-invalid regression verifies the exact lease/revision settlement and blocked result. Both run-detail panels translate known reasons into source review, authorization or configuration next steps without automatically changing inputs or starting another run. Historical unknown reasons remain inert text.

All 38 worker/dispatcher checks and 28 UI/helper checks pass (`/tmp/emdo-automation-blocked-combined.log`, `/tmp/automation-blocked-ui-tests.log`). Scoped lint and full base/web TypeScript pass (`/tmp/emdo-automation-blocked-types-final.log`). Combined database regression is being refreshed separately; readiness and deployment flags remain unchanged.

The combined database refresh passes all 233 tests across 32 suites after all 75 migrations (85.36 seconds; `/tmp/emdo-finance75-automation-blocked.log`, exit 0). This includes current import posting lineage plus the existing worker, accounting, migration and private-data regression suites. Private staging and real provider execution remain unverified.


### Live Astra mapping validation — 2026-09-15

An opt-in synthetic provider check now calls the production `createDurableFinanceProposalProvider` through Responses with `gpt-6-astra`, medium reasoning, no tools/handoffs, store false and a 4000-output-token bound. Normal test runs skip it. The credential is read from environment only; diagnostics omit headers, raw provider errors and source contents. The source table is validated before provider execution.

Live validation exposed required mapping labels and grouping separator being returned as null. Prompt version `finance-standardization-proposal.v3` distinguishes proposed mapping metadata from financial facts, requires nonempty labels and enumerates grouping-separator values. Historical v1/v2 provenance remains accepted. A subsequent real response passed schema validation and deterministic normalization of two synthetic rows, preserving amounts 123.45 and -67.89 CAD. Receipt: `resp_04eae22f24df9f0b016aa8f3c3eca887d28c8242bea8f46418`; input/output tokens 634/341; synthetic source SHA256 `994f182183802bf9aeaf832e8fb382c6d34c106ebd75afa0fadbd433dbbeb026`. Log: `/tmp/emdo-astra-live-mapping-final.log`. No approval, posting or deployment occurred.

This proves a real provider proposal plus deterministic normalization, not the full persisted scheduled/staged workflow. Official compatibility guidance was checked at https://developers.openai.com/api/docs/guides/reasoning#reasoning-effort. Reproduce only intentionally with `EMDO_FINANCE_LIVE_PROVIDER_CHECK=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run packages/agent-core/src/finance-standardization-live.test.ts`; the opt-in call consumes provider credits.


### Release artifact verification — 2026-09-15

The current shared worktree passes `pnpm run build`, including the web/PWA, API and worker production artifacts (`/tmp/emdo-finance-release-build.log`, exit 0). Both packaging checks pass (`/tmp/emdo-finance-release-packaging.log`): the API bundle excludes workspace/runtime fixtures, and the emitted standardization worker boots without credentials and extracts genuine PDF text. This is local artifact verification, not image publication or deployment.

The existing `staging-acceptance.ts` and Finance Compose overlay exercise the older document workflow; they do not yet prove the normalized v2 upload/proposal/review/posting path. A separately opted-in restricted PostgreSQL + real Astra acceptance is being added for that path. Remote staging still requires an exact published source/image binding and staged credentials; a local green build or provider response must not be substituted for those gates.

### Integration closure and prompt compatibility — 2026-09-15

The full restricted-database/live-provider path exposed an SQL allowlist still limited to prompt v1/v2. Additive migration `0075_finance_standardization_prompt_v3` preserves the existing reservation function and security boundaries while admitting v3; historical v1/v2 remain valid. The ERD is regenerated at revision 0075 (168 tables, 418 foreign keys, 178 triggers), with its eight generator tests passing. Worker-role database coverage explicitly exercises all three prompt versions.

The initial full repository suite reported 14 failures. Targeted corrections remove an accidental integrations root export, explicitly authorize the native OCR test runtime, test the current server-selected Finance authority, update reviewed schema/migration inventories, and retain the Finance runtime's budget guard while setting its conservative input bound to 100000 (current schemas plus a 16 KiB source page measure about 86000). Spend authorization remains independently enforced. Six static/runtime suites pass 67 tests, route authority tests pass 19, and native OCR tests pass two. The next full run passed 4871 tests but found three failures: a newly stale migration snapshot count and two PDF worker error classifications. These remain under verification; this is not a green full-suite claim.

A real Astra response was saved as a source-bound candidate through the restricted worker lane after migration 0075. Public approval correctly refused unresolved source-review caveats. The acceptance harness is being corrected to exercise explicit public source review, preserving proposal lineage and refusing unknown model questions, before a separate approval and canonical posting. End-to-end persisted posting and private staging are not yet proved by this run.

Final checks for this integration pass: the full repository suite (`pnpm exec vitest run --maxWorkers=4 --minWorkers=1`) passes 4875 tests across 494 suites, with 327 opt-in/environment-gated tests skipped (`/tmp/emdo-release-full-suite-final.log`). Separately, all 76 migrations apply to disposable PostgreSQL and all 236 restricted-database tests across 32 suites pass (`/tmp/emdo-finance76-final.log`). The PDF failure was a genuine PDF.js stream cancellation/close race; removing duplicate reader cancellation while retaining awaited parser destruction and parent resource/timeout/termination controls fixes it. A concurrent natural-worker-exit regression verifies exact span-limit failures without subsequent uncaught errors.

The real provider run saved response `resp_08b6f0aee1c7e01c016aa8f7b1f64c87d298d7486bfa566281` (731 input / 506 output tokens) and stopped before approval on explicit source questions. The authored synthetic source can answer them: the two CSV rows are complete, dates are ISO, amounts are signed CAD economic amounts without separate fee/tax components, and proposed labels are accepted only for the fixture. A recorded-provider replay with those explicit answers passes the public source-review/link/approval/import/row-review/canonical-posting flow, producing two posted journals and four exact lines. It makes zero provider calls and records the original live receipt separately. This is combined live-proposal plus recorded-replay evidence, not a claim that one uninterrupted live execution or private staging passed. Logs: `/tmp/emdo-live-normalization-final.log`, `/tmp/emdo-normalization-recorded-replay.log`.

Post-fix production build, base TypeScript, web TypeScript, worker TypeScript, and targeted lint also pass (`/tmp/emdo-integration-final-build.log`, `/tmp/emdo-integration-final-types.log`, `/tmp/emdo-integration-types.log`, `/tmp/emdo-integration-final-lint.log`). The full suite includes emitted API/worker packaging checks. No remote publication or deployment was performed. Canada tax returns and investments remain WIP/paused, and deferred countries remain outside this active closure pass.

### Normalized HTTP and Finance readback acceptance — 2026-09-15

`packages/db/scripts/verify-finance-normalization-http.sh` now creates a dedicated localhost disposable database, applies the ordered migrations, and runs `apps/api/src/routes/finance-normalization-postgres.integration.test.ts`. It drives the actual Fastify routes with real restricted app/worker repositories, a deterministic proposal provider and an explicitly mocked session/CSRF boundary. Coverage follows upload, standardization, saved candidate, source review, mapping link/approval, import, row review, canonical commit and saved posting lineage, including premature approval rejection, mutation denial, idempotent start/commit and revoked-access read denial. This is local HTTP injection, not browser authentication or private staging proof.

The existing synthetic staging agent supports a bounded `read-normalized-import` command with explicit book/import IDs, offset and limit (maximum 20). EMDO delegates it to Finance; Finance invokes only the existing `finance_books_read` tool with `view: import-review`. The response retains exact decimal strings, source URLs and pagination, rejects mismatched book/view results, and has no proposal or write authority. Source URLs are not misrepresented as evidence-registry identifiers. Scoped synthetic-agent and existing staging acceptance tests pass 56/56.

Private staging still needs an immutable image built from the final source; the current staging acceptance is v1-only. Normalized execution requires API/worker `EMDO_FINANCE_V2_ENABLED=true` and `EMDO_FINANCE_STANDARDIZATION_ENABLED=true`, a shared valid book-evidence keyring, the worker's existing executor/dispatcher database roles, bounded provider pricing configuration, and authorized provider egress. Synthetic provisioning must enable `finance.standardizations.run` only for the acceptance workspace and explicitly configure nonzero standardization run/day limits plus readiness. The general worker owns durable standardization; launching the legacy `finance-document-extraction` CLI does not execute normalized jobs. No staging flags, credentials, entitlements, remote database settings or deployments were changed in this pass.

The HTTP acceptance now also closes and recreates Fastify between saved candidate creation and review, then verifies the recovered candidate. After posting, `createRequestScopedFinanceSpecialistServices.readFinanceBooks` reads the actual restricted repository: two posted-journal records, four posted-line records, exact amounts, journal/economic-transaction IDs, evidence and import fragment references. Revoking the book grant denies both HTTP saved-run access and the Finance service read. The existing service context requires its exact manifest capability set; all unused write/document ports in this test throw. This proves the request-bound production service seam, not a model execution, real authentication or full manager runtime.

The API packaging test passes after adding the normalized staging read command, including clean emitted artifacts without test/worker fixture leakage (`/tmp/emdo-normalized-http-package.log`).

### Authenticated local browser and current restore acceptance — 2026-09-15

The disposable localhost HTTPS fixture now exercises real BetterAuth sign-in, browser cookies/CSRF, Fastify routes and restricted PostgreSQL repositories after all 76 migrations. A two-row synthetic CSV was uploaded through Documents, explicitly mapped and reviewed, recovered after a full reload, and committed to two journals/four lines. The original evidence download retained SHA256 `994f182183802bf9aeaf832e8fb382c6d34c106ebd75afa0fadbd433dbbeb026`. Missing-CSRF account creation returned 403. Desktop and 390-pixel mobile inspection showed a contained readable layout.

Browser verification found that committing a statement did not refresh the parent book overview. The Documents panel now notifies its parent only after readback confirms the same batch is committed; unsuccessful or uncertain commits do not signal success. A subsequent real browser import posted a further 1.00 CAD receipt: switching directly to Overview, without a reload, showed three journals and net cash 56.56 CAD. Evidence: `output/playwright/finance-authenticated/page-2026-09-15T08-21-33-675Z.yml` and `page-2026-09-15T08-21-42-647Z.png`. The production web build passed after this fix (`/tmp/emdo-browser-refresh-build.log`).

This fixture has no model provider or offline-sync bindings and uses a test-only self-signed certificate. It therefore proves authenticated manual CSV review/posting, not an uninterrupted live-Astra browser workflow, offline/PWA operation or private staging. UI logout correctly stopped when it could not verify local purge; a separate server sign-out attempt exposed rejection of empty request framing and remains under correction. Do not treat either logout path as passed yet.

The encrypted separate-cluster restore drill was rerun against revision 0075 and all 76 migrations: 1/1 passes (`/tmp/emdo-finance76-restore-current.log`). It verifies matching role bootstrap, restored evidence encryption keys, private-access controls and saved FEC mapping/receipt content. This replaces the earlier 75-migration recovery evidence; no remote database or production deployment was involved.

The server logout defect is now fixed: an absent body framed with exactly `Content-Length: 0` is accepted; actual bodies, content types and transfer encoding remain rejected. Authentication regression coverage passes 71 tests, including real Node HTTP framing and origin/CSRF/session/idempotency checks. A fresh real browser sign-in against the rebuilt disposable fixture verified Finance GET 200, CSRF-protected sign-out 200, then Finance GET 401 (`output/playwright/finance-authenticated/server-session-revocation.json`). This closes server revocation, while the fixture's offline-purge limitation remains explicit. Final Documents regression passes 13/13 (`/tmp/emdo-browser-refresh-final-tests.log`). Fixture cleanup now removes its named synthetic credentials/certificates and temporary bundle as well as its own container.

### Normalized staging workflow and provisioning — 2026-09-15

`staging-acceptance.ts` now has a separate opt-in `--finance-normalized-synthetic-gates` command. It verifies original upload bytes/digest, waits for a durable Astra-medium proposal, validates every cell of its authored two-row CSV, answers only explicitly recognized questions about that authored source, approves a mapping, reviews/imports/posts the transactions, checks duplicate commit, and requests saved lineage through `/api/v1/turns`. The EMDO readback validator checks the actual eight transaction/journal/line records and their exact amounts, account bindings and evidence references. Unknown model questions or altered source/lineage block acceptance. The proposal wait accommodates the production provider's 90-second timeout plus extraction/queue delivery; it remains bounded. Existing v1 acceptance is preserved. The result is a probe with `releaseEligible: false`, not a substitute for every deployment gate.

The complete new command passes `packages/db/scripts/verify-finance-normalized-staging-cli.sh`: all 76 migrations, real Fastify v2 handlers, restricted application/worker repositories, durable proposal execution, canonical posting and production Finance-service readback. Authentication, the deterministic provider and manager/SSE envelope are explicitly adapted in this local test. This complements the separate real-browser authentication and live-provider evidence; it does not establish uninterrupted production-manager/live-provider private staging.

Synthetic provisioning now creates replay-stable book/accounts and an open 2026 period through the authenticated v2 API only when normalized staging is explicitly selected. The separate `compose.finance-normalized-staging.yml` adds the general standardization worker and its bounded provider network without enabling generic provider integrations or schedules. A real four-file Compose merge test verifies retained API env layers, replaced worker env, flags and network selection. Deployment-owned `finance-normalized-staging-provision.sql` passes execution after 76 migrations in disposable PostgreSQL: the exact synthetic workspace/book succeeds; seven invalid boundaries deny with unchanged readiness/entitlements, including nonempty books and excessive budgets. No remote provisioning was performed.

`infra/scripts/finance-normalized-staging-handoff.mjs` converts a successful seed JSON result into the four acceptance environment IDs. It requires explicit staging/synthetic/normalized flags, validates distinct UUIDs, exclusively creates a mode-0600 file, and rejects symlinks, injected values and replacement of an existing handoff. Six tests and lint pass (`/tmp/emdo-normalized-handoff-tests.log`, `/tmp/emdo-normalized-handoff-lint.log`). Runtime credentials/pricing/keyring validation, immutable image binding and actual private-staging execution remain separate gates; adding the overlay does not activate them.

Static normalized configuration preflight is now implemented with 21 passing tests. It checks private effective env files, the intended database target/restricted process names, shared valid keyrings and provider/pricing completeness without connecting or exposing values. Commercial price accuracy, credentials/grants and runtime readiness still need real staging verification. The operational sequence, including the bootstrap-to-final fixture handoff, is documented in [finance-normalized-staging.md](finance-normalized-staging.md).

The refreshed repository suite passes 4899 tests across 498 suites, with 330 opt-in/environment-gated tests skipped (`/tmp/emdo-normalized-closure-full-suite.log`). A subsequent focused pass covering the final bounded wait, handoff and newly completed preflight passes 32 tests (`/tmp/emdo-normalized-closure-focused.log`); these counts overlap and must not be summed as distinct coverage.

The production build, final base TypeScript and scoped lint pass (`/tmp/emdo-normalized-closure-build.log`, `/tmp/emdo-normalized-closure-types.log`, `/tmp/emdo-normalized-closure-lint.log`). Build and TypeScript were verified sequentially because the build replaces generated declarations included by the base TypeScript project. Local browser fixtures and their synthetic credentials were removed; no active named EMDO test container remains. No remote release or production capability activation occurred.

The normalized CLI PostgreSQL verifier now also uses `createProductionAgentPersistence` and `createRequestScopedManagerFinanceAgentRuntimeFactory` with the existing synthetic runner. The full command passes after all 76 migrations and observes the actual `manager → finance → manager` sequence, saved run events and production Finance-service readback (`/tmp/emdo-normalized-staging-cli-runtime-verifier.log`, 1/1). The earlier manager shortcut has been replaced: v1 HTTP/SSE wrapping and authentication remain test adapters, and proposal generation remains deterministic. This proves genuine synthetic orchestrator delegation/persistence with restricted saved Finance data, not a live model or deployed ingress.

### Live structured proposals and actual execution boundaries — 2026-09-15

The normalized CLI acceptance now uses real production BetterAuth/CSRF plus real v1 HTTP/SSE routes and genuine synthetic manager/Finance runtime, alongside the restricted v2 repositories. This found a missing sign-in idempotency key in the normalized command; the header is now supplied. The complete test passes with only proposal generation kept deterministic (`/tmp/emdo-normalized-staging-cli-real-auth-verifier.log`). This supersedes the earlier authentication and v1 wrapping adapters, but remains local HTTP injection rather than deployed browser ingress.

A further live call exposed a required rationale missing inside the old `proposalJson` string. The worker rejected the unverified response and posted nothing (`/tmp/emdo-uninterrupted-live-normalization.log`). The provider now supplies a strict structured proposal schema to Responses, then applies canonical semantic validation. It excludes all four human-reviewed selection fields from model output entirely; no fabricated review confirmation is accepted. Prompt v4 records the format/instruction change; additive migration `0076` preserves v1–v3 while admitting v4. The schema overhead has an enforced 8192-byte cap plus 2048 bytes of SDK allowance within the unchanged input/output ceilings. Twenty-five provider, schema, instruction and provenance tests pass. Compatibility was checked against the official Structured Outputs supported-schema guidance.

The next bounded live run succeeded without replay or another provider call: Astra medium response `resp_0ed3e5a9755385b8016aa90840d90887d2a1a1523069dbf75c`, 1110 input / 493 output tokens, prompt v4. The test paused after persisting the candidate. Root inspected the original synthetic CSV, every mapping field and all seven source questions, then supplied an exact run/digest/mapping/question-bound authored review. The same database run resumed through reviewed mapping linkage, approval, row review and two posted journals/four exact CAD lines. No unknown financial fact was inferred; proposed provider labels remain synthetic metadata. Evidence: `/tmp/emdo-uninterrupted-live-v4.log` and `output/finance-acceptance/live-v4-{candidate,authored-review,posting-proof}.json`. This is uninterrupted local provider-to-posting evidence, not remote private staging. Fixture tariffs test budget accounting and do not assert commercial billing prices.

The production automation verifier starts the actual emitted worker against disposable PostgreSQL after all 77 migrations. With no provider credentials, the real scheduler, pg-boss and fixed-role executor save an immutable trial-balance result for an exact 12.34 CAD balanced source after the initiating session expires. Identical queue delivery is rejected as a duplicate; revoking the grant yields `grant-revoked` and no additional run. Management uses restricted repositories with directly seeded synthetic identities; only disposable due timestamps are advanced for the revocation check. Reproduce with `packages/db/scripts/verify-finance-automation-worker.sh`. HTTP/browser schedule management and remote execution are separate remaining gates.

The combined restricted-database verifier passes 237 tests across 32 suites after all 77 migrations; the separate encrypted restore and all eight ERD generator tests pass as well (`/tmp/emdo-finance77-integrated.log`, `/tmp/emdo-finance77-restore.log`, `/tmp/emdo-erd0076-tests.log`). No country or investment capability was activated and no remote release was performed.

The larger structured response schema exposed an OCR input-budget regression during the full suite. Whole-line image projection now receives the actual remaining byte allowance after instructions, schema and serialized source-envelope overhead. It retains the historical default for other callers, preserves omitted-line/word counts and projection digests, and refuses a first line that cannot fit. The request's token/spend ceilings are unchanged. All 43 targeted projection/provider/runtime checks pass; the stale wire fixture was also updated to the direct structured object and verifies the outgoing strict JSON schema.

The normalized staging command now supports an explicitly selected private authored-review directory, so unfamiliar source questions can be inspected and answered in the same run. It binds answers to the exact source, mapping definition/revision, question order, one-time challenge and expiry, records an accepted-review digest, and rereads saved state before invoking public review/approval operations. Without this selection, unfamiliar questions still stop the probe. Fifty-seven focused checks pass. A complete real-authentication/HTTP/manager PostgreSQL run after 77 migrations verifies an unfamiliar deterministic question, one proposal call, the same persisted run, retained review digest and two journals (`/tmp/emdo-normalized-staging-cli-authored-review-verifier.log`). The operational JSON/file protocol is documented in the staging runbook; it does not change the normal Finance UI review workflow.

Final repository validation passes 4958 tests across 501 suites, with 332 opt-in/environment-gated tests skipped (`/tmp/emdo-v4-full-suite-final.log`). Production build and subsequent repository TypeScript both pass (`/tmp/emdo-v4-release-build.log`, `/tmp/emdo-v4-release-types.log`). The live-provider, emitted-worker, real-authenticated CLI and restore drills are distinct evidence with their stated boundaries. Remaining release gates include real-browser automation management, exact source/image binding, uninterrupted live-provider private staging and production rollout/cutover. No active named EMDO test containers remain.


### Real automation management browser check — 2026-09-15 (in progress)

The local Finance browser fixture now runs real BetterAuth/CSRF, restricted
automation management repositories, pg-boss and the emitted production worker.
Its synthetic book has a balanced 12.34 CAD opening, reports-only capability
readiness and explicit automation entitlement. No grants or schedules are
preseeded and no provider credentials are supplied.

Authenticated browser inspection found a real remaining interface gap:
`finance-automations.tsx` unconditionally displayed that all operations were
disabled and provided no grant creation control, despite ready backend execution.
This is an implementation defect, not a fixture readiness failure. Grant creation
and matching HTTP response-boundary validation are being completed before the
browser workflow can count as accepted. The initial evidence is under
`output/playwright/finance-automation-real/`.

Release hygiene: root `.playwright-cli/` downloads/snapshots and root `tmp/`
extraction scratch files are now ignored by Git. Existing files are preserved;
these scratch outputs are not release sources. No deployment occurred.


### Report automation browser acceptance completed — 2026-09-15

Closed the missing grant-creation interface: administrators choose operations,
limits, currency and a validity interval, review that authority, then confirm.
Creation validates the returned grant and a fresh saved listing. Uncertain
responses retain the same command and idempotency key for retry. The false
all-disabled banner is replaced with accurate per-run authority language;
source extraction/journal schedules now have their correct titles.

Grant HTTP list/create/revoke responses now receive canonical validation and
workspace/book checks. Creation also binds the generated grant ID and current
creator; revocation binds the requested ID and revoked status. Fifteen API
tests, eleven grant UI tests and fourteen schedule UI tests pass.

The real browser created one report-only grant and a one-minute schedule through
production BetterAuth/CSRF and the actual API/restricted database repositories.
Both survived a full reload. The emitted worker and real pg-boss produced two
immutable reports. The browser opened a saved result with exact 12.34 CAD debit
and credit totals, all three accounts and the original journal; its downloaded
HTML contains all rows and the same journal reference. Pausing stopped further
occurrences. A replacement preserved the paused original. Explicit grant
revocation caused the worker to record `grant-revoked` at the replacement's real
due time, with the run/report counts unchanged at two. Retirement then persisted.
No database timestamps were advanced to produce this evidence.

Desktop and 390px mobile checks passed, including the open grant form with no
document-level horizontal overflow. Evidence, machine-checked DB/download
assertions and screenshots are under
`output/playwright/finance-automation-real/`; `acceptance.json` records the
exact boundaries and report download digest. The temporary browser, worker,
API, dedicated Docker database, credentials and TLS files were cleaned up.

The fixture seeds only synthetic identity/book/opening/entitlement/readiness.
Providers are disabled and no model calls occur. This establishes the report
automation browser path locally, not private staging, production rollout,
offline cache purge, or the other automation capabilities' browser paths. The
web production build and exact API packaging check pass; the fixture is absent
from the production bundle. Database structure remains revision 0076, so the
existing final ERD is unchanged.

Post-integration regression validation: 4964 tests pass across 501 suites, with
332 opt-in/environment-gated tests skipped (`/tmp/emdo-grant-management-full-suite.log`).
Repository and web TypeScript pass (`/tmp/emdo-grant-management-types.log`),
scoped ESLint passes (`/tmp/emdo-grant-management-lint.log`), and diff whitespace
checks pass. These results supersede the earlier 4958-test baseline without
claiming any skipped staging or production gate has run.


### Governed normalized staging and packaged candidate — 2026-09-15

The normalized overlay is now connected to the actual staging workflow, fixed
operator and lifecycle scripts. The explicit false-by-default mode requires
Finance staging, separately configured provider/pricing material and positive
run/day CAD-minor budgets bounded by the provisioning SQL. Protected stdin and
private run-scoped files carry credentials. Effective Compose validation occurs
before service startup; the seed output is captured, its exclusive handoff is
validated, and only the exact unposted synthetic book is provisioned. Acceptance
records separate source/run/book-bound non-release evidence. Baseline and legacy
Finance paths retain their existing gates.

Teardown restores the normalized fourth overlay from protected state and proves
its additional egress network absent. Root review found that the existing memory
gate did not cover this mode: normalized steady caps are 1760 MiB, and acceptance
adds 192 MiB. Its minimum is now 2.25 GiB, retaining 352 MiB headroom; baseline
remains 1.75 GiB. All 337 infrastructure tests pass across 16 suites, including
executable invalid-mode/budget, seed failure, handoff, state-reload and orphaned
network checks. Repository/web TypeScript and ShellCheck pass. Evidence:
`/tmp/emdo-normalized-governed-infra-tests.log`,
`/tmp/emdo-normalized-governed-types.log`, and
`/tmp/emdo-normalized-governed-shellcheck.log`. These are local checks; no host
operator was installed and no workflow was dispatched.

Local linux/amd64 API, worker and web images were built from frozen Docker inputs
with context digest
`51cd3338beaffb090389783383edfc11a652a7d8f13135dc4577abab27dc0794`.
Their labels explicitly identify a dirty-worktree local candidate, not the older
Git HEAD commit. Source files and modes were verified unchanged after build.
Read-only, network-isolated container checks verify non-root users, all 77 API
migrations, production module imports without the local fixture, worker prompt
v4/fail-closed provider fallback, and the web Finance fallback plus script assets.
The site description and install manifest now describe personal, household and
organization workspaces rather than a household-only assistant. Source manifests,
BuildKit metadata and actual local image IDs are retained under
`output/finance-release-candidate/51cd3338beaf/`.

Fourteen obsolete local EMDO application images were removed only after checking
that no container referenced them; removal used no force flag. The three current
candidate images and OCR/PDF helper images remain. No database volumes were
pruned. Disposable smoke containers were removed.

Remaining release boundary: freeze the complete reviewed work into a real commit,
obtain same-commit CI/published image evidence, install the reviewed fixed operator
through the governed host procedure, then execute private staging. Local candidate
images do not satisfy or weaken that boundary. Production and migration cutover
remain unproved. Canada tax and investments remain WIP/paused.

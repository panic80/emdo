# EMDO Unified Orchestrator and Finance v1

Status: approved implementation specification  
Date: 2026-08-26  
Branch: `codex/finance-section-v1`  
Base: latest `origin/main` at goal start (`af24d3b`)

## Goal contract

EMDO is the sole user-facing, durable parent agent. It owns the conversation,
selects registered specialists, supplies minimum context, validates their typed
results, manages confirmations, and synthesizes the final answer. Finance is the
first major specialist implementation. Scheduler remains independently
available. Shopping and all other unfinished sections remain disabled.

The goal completes only when the reviewed branch is merged and the exact merged
`main` SHA passes private authenticated Hostinger staging with synthetic data,
including a real OpenAI extraction and encrypted document backup/restore drill.
Production must remain untouched.

## Unified registered-agent runtime

- A child agent is a bounded invocation under the current EMDO turn, not a new
  conversation, process, or persistent autonomous service.
- Only EMDO can invoke specialists or communicate with the user.
- Enabled v1 registrations are `scheduler` and `finance`.
- Finance and Scheduler have no children; maximum depth is one.
- Run at most three independent specialists concurrently and at most one
  invocation per section per turn, excluding server-controlled retry.
- Specialists cannot call one another, widen capability grants, or retain
  unrelated conversation state.
- Independent section work may run concurrently; dependent work is sequential.
- Partial failure produces a truthful partial EMDO response.
- Unknown, disabled, recursive, excessive-depth, and excessive-concurrency
  requests fail closed.

The server-owned registration contract contains agent id/version/section,
readiness, enabled state, allowed parents/children, capability allowlist,
input/output schemas, and disclosure policy. Child invocation context contains
orchestration, parent, agent, and phase invocation identifiers; actor; locale;
capability grants; disclosed context references; deadline; and idempotency
scope. Outcomes are one of completed, needs confirmation, needs input,
unavailable, or failed. The server validates every contract boundary.

Use the existing compiled graph/delegation foundation. Do not introduce another
agent platform or enable the all-or-nothing full specialist graph. Startup must
support EMDO alone, EMDO+Scheduler, EMDO+Finance, and
EMDO+Scheduler+Finance.

## Finance capabilities and writes

Finance receives only:

- `finance.records.read`
- `finance.records.write`
- `finance.analytics.calculate`
- `finance.documents.search`
- `finance.documents.read`
- `finance.matches.read`
- `finance.statement.import`

Inputs are authenticated record ids, reviewed plan ids, bounded queries, and
server-minted evidence references. Finance never receives raw upload bytes,
filesystem paths, unrestricted SQL, provider clients, or credentials.

Direct safe writes are limited to explicit manual-transaction creation, exact
non-destructive field edits on owned manual transactions, exact monthly category
budgets, and transaction categorization/annotation. Reversals, deletions,
statement-import commits, document commits, match acceptance, and ambiguous or
bulk actions require EMDO-controlled visual confirmation. All writes are
authenticated, idempotent, canonical-hash-bound, and audited.

No banking credentials, aggregation, money movement, provider-side financial
writes, or tax/investment/insurance/debt/credit advice is permitted.

## Finance document knowledge

Add migration `0016_finance_document_knowledge` and a seventeenth serialized
PostgreSQL integration suite. Add uploader-scoped tables for documents,
extraction revisions, committed chunks, review batches, suggested matches, and
evidence references. Reuse canonical finance entities and `audit_events`; never
reuse generic plaintext `memory_chunks`.

Document states are:

```text
uploaded -> extracting -> awaiting_review -> committed
                      \-> failed -> retry
accessible state -> deleting -> deleted tombstone
```

Re-extraction creates a revision and invalidates outstanding review tokens. It
never silently rewrites committed records. Database policies enforce uploader
identity for every document, extraction, chunk, review, match, evidence, and
derived canonical record.

`FinanceDocumentEnvelopeV1` is a discriminated union with common issuer,
recipient, source locale, currency, dates/period, integer-minor-unit totals,
masked identifiers, per-fact confidence, and page evidence. Supported types are
receipt, invoice, bank statement, credit statement, pay stub, tax slip,
insurance, loan, investment statement, and other. Receipt/invoice/pay-stub data
may propose ordinary expense/bill/income records; insurance and loan data may
propose ordinary bills/expenses; tax and investment data are facts only.

Full account, card, SIN, tax, policy, and credential identifiers remain only in
the encrypted original. Facts, chunks, embeddings, logs, capabilities, and
citations use masked values.

## Encrypted original store

Store originals outside the web root under an app-owned volume, defaulting to
`/var/lib/emdo/finance-documents`.

- Generate a random data key per file.
- Stream-encrypt with AES-256-GCM.
- Wrap the data key with the current versioned application master key.
- Use opaque names, restrictive permissions, temporary files, fsync, and atomic
  rename.
- Store wrapped-key metadata and internal plaintext/ciphertext integrity hashes.
- Compensate safely for incomplete database/filesystem finalization.
- Authenticated downloads stream-decrypt as no-store, nosniff attachments.
- Do not add public URLs or inline PDF rendering.

Deletion revokes access immediately, then purges the original, extraction
revisions, chunks, embeddings, drafts, and pending matches. Committed records
remain with a content-free audit tombstone. Historical encrypted backups expire
under the existing lifecycle.

## Extraction, review, retrieval, and evidence

Preserve deterministic CSV/OFX/QFX parsing. New document uploads accept
validated PDF, JPEG, and PNG only.

- Parse reliable PDF text locally where practical.
- Use OpenAI Responses file/image input for scans and images.
- Set `store: false`, structured output, no tools, no background mode, no
  OpenAI Files, and no hosted vector store.
- Default to `gpt-5.6-terra` with at most normal-detail plus one eligible
  high-detail retry.
- Treat document content as untrusted data, validate the versioned schema, and
  serialize provider extraction to one active VPS job.
- Never log document content, prompts, provider responses, or sensitive values.

The upload UI discloses that API data is not used for training by default and
that standard abuse-monitoring logs may retain customer content for up to 30
days. The user approved this boundary.

Unreviewed extraction is excluded from EMDO, Finance Q&A, offline sync, totals,
and budgets. Commit materializes approved redacted facts, bounded evidence
excerpts, PostgreSQL full-text indexing, and dedicated
`text-embedding-3-small` embeddings. Retrieval uses deterministic structured
queries first, then owner-filtered full-text and vector retrieval with
deterministic rank fusion. Authoritative arithmetic always uses integer minor
units in finance-domain code.

Matching uses currency, exact amount, date window, normalized merchant/payee,
and document type. Matches are suggestions until visually accepted. Evidence
markers resolve through an authenticated bounded evidence endpoint.

## Finance API and experience

Add authenticated endpoints for document upload/list/detail/original/retry/
delete, review read/edit/commit, match list/decision, and evidence resolution.
Extend `/api/v1/experience/finance`. `/api/v1/turns` remains the only chat entry
point. Existing CSV/OFX/QFX preview and reviewed-plan commit remain separate;
agents receive reviewed plan ids, never raw statement text.

The Finance interface contains Overview, Activity, Documents, and Planning.
“Ask EMDO” is available throughout. Support `en-CA`, `fr-CA`, `ja-JP`, and
`ko-KR`; browser locale is the initial default, Settings may override it, and
`en-CA` is the fallback. Evidence retains its original language while EMDO
answers in the active locale.

CAD is the canonical reporting currency. Non-CAD facts remain searchable and
labelled but are excluded from CAD totals, budget comparisons, and automatic
matching. No FX conversion is added.

Offline storage may contain localized UI, metadata, reviewed facts, and
canonical records. It must exclude originals, unreviewed extraction, full
evidence text, and embeddings.

Limits are 20 files per selection, three concurrent uploads, one active
extraction, 25 MB per file, 250 PDF pages, 40 megapixels per image, 10,000
documents, and 50 GB per uploader.

## Backup and staging

Extend the existing age-encrypted logical backup with an incremental manifest
and snapshot of immutable encrypted originals. The document master key is
managed independently and is never bundled beside the data. Restore remains
backward-compatible and must prove, in isolation, authenticated decryption,
hash equality, evidence readback, and denial to another user.

Only the Sol root may handle Git, secrets, PR merge, and staging. Reuse the
existing ignored local `OPENAI_API_KEY`; copy it without output to protected
staging secret `EMDO_OPENAI_FINANCE_API_KEY`. Enable only Finance extraction in
staging. Use synthetic users/documents and a run-scoped document master key
destroyed at teardown. Production is out of scope.

## Verification

Required coverage includes orchestrator single/multi-section routing, partial
failure, unknown/disabled agents, recursion/depth/concurrency denial, minimal
disclosure, child inability to message the user, and EMDO-owned confirmation.

Finance coverage includes every supported document type and locale; ambiguous
dates and non-CAD exclusions; upload limits, duplicate handling, atomic
recovery, retry/provider failure; prompt injection; invalid schema; identifier
and log redaction; review revision invalidation; idempotent commit; exact totals
and budgets; safe and guarded writes; suggested matching; uploader isolation;
CSRF/Origin/MIME/auth/download defenses; offline exclusion; accessibility; and
encrypted backup/restore.

Run Node 24/pnpm 9 formatting check, lint, both typechecks, unit tests, agent
evals, integration tests, the 17-suite PostgreSQL matrix cache-free and
serialized, build, Playwright, package verification, PR checks, and exact-SHA
staging proof. Database-sensitive fixes require two consecutive clean serialized
runs.

## Explicit exclusions

Do not implement Shopping or other sections, arbitrary/self-registering agents,
specialist-to-specialist or recursive spawning, persistent child agents,
banking aggregation/credentials, payments/transfers/brokerage, email/cloud/
watched-folder ingestion, financial advice, web search for personal finance,
FX conversion, forecasting, alerts/reminders/new Scheduler workflows, household
sharing, full offline documents, OpenAI Files/vector stores/background/stored
conversations, or production deployment.

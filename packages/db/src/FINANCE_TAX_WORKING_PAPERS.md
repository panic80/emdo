# Private tax working papers

Migration 0044 persists calculation runs for the server-owned Canada/Ontario 2025 personal workflow. It does not enable a country return package. Every run and review/export remains `complete: false`; calculated fields retain individual reporting proofs and blockers. The full-return release gate remains unresolved.

The authenticated case owner or reviewer reviews exact saved declaration source IDs, revisions and content hashes against a questionnaire snapshot and workflow version. These immutable approvals are distinct from the original unreviewed declarations. They do not populate the canonical questionnaire's return facts or confer source access. Changing a declaration or questionnaire revision requires a new input review for the next run.

The case owner or preparer can create a run. The server loads the immutable questionnaire, its exact declarations, current source authorizations and matching input reviews, then invokes the installed deterministic workflow. Requests cannot submit calculation outputs, executable rules, reviewed fact values or actor identities. Missing or unreviewed inputs produce a persisted blocked run.

Run headers commit to the input envelope, package definition, output and a manifest of normalized per-form schedule hashes. Original field ordinals reconstruct the domain result for its replay-checked CSV export. Package hashes identify the versioned definition and source captures, not executable bytes. Owner/reviewer acknowledgment of the exact output hash permits an explicitly incomplete working-paper export; it cannot complete a return.

All endpoints live under `/api/v2/finance/tax/cases/:caseId`:

- `GET /working-papers`: trusted scope, questions, version and current input reviews.
- `POST /working-papers/input-reviews`: review exact saved inputs with case revision/hash and idempotency.
- `POST /runs`: create a deterministic run with case revision/hash and idempotency.
- `GET /runs` and `GET /runs/:runId`: private paginated history and bounded structured detail.
- `POST /runs/:runId/reviews`: acknowledge an exact incomplete output hash.
- `GET /runs/:runId/export?reviewId=...`: export the matching reviewed working papers.

Current workspace membership and explicit private case grants are required. Historical run reads, reviews and exports recheck and lock every exact source authorization from that run's questionnaire snapshot. Source revocation hides historical run/schedule rows. A sanitized reset followed by same-book reauthorization creates a new source authorization; it cannot restore old run access. Workspace ownership and book administration alone never grant private case access.

Restricted PostgreSQL acceptance is in `finance-tax-runs.integration.test.ts`, alongside the existing private-case suite. It covers missing/unreviewed inputs, immutable review bindings, reordered idempotent requests, revisions, normalized output integrity, prohibited direct mutation, output tampering, private membership isolation, source revocation and reset/rebind history isolation.

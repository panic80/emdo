# US 2025 private federal working papers

This adapter connects the existing US federal candidate to private tax cases. It does not register an enabled return package. Every run has `complete:false`, `enabled:false`, `reportable:false`; state and local returns are expressly excluded from this workflow.

## Exact version and scope

- Workflow: `us-fed-2025-working-papers`.
- Domain package: `2025.4-federal-working-papers`.
- Review bundle: `2025.2-wage-correction-bindings`.
- Durable adapter: `2025-private-federal-output.2`.
- Private preparation package version: `2025.4-federal-working-papers+private.2`.
- Scope: US / US-FED / sole-proprietor / 2025 / income-tax-return / 1040-2025.

The domain candidate requires a reviewed single full-year domestic filer, ordinary cash-method service sole proprietorship and its explicit applicability facts. Unsupported real situations remain blockers. This adapter does not infer exclusions or zeroes from missing inputs. New York is a separate domain candidate and is not included here.

Version2025.4 applies the elected whole-dollar entries to dependent form lines and retains each pre-entry exact rational in the trace. The independent10000 and50000 profit boundaries now transfer707 and3533 respectively from Schedule SE13 to Schedule1.15. Historical2025.3 run bodies are not recomputed.

The package hash covers the pinned candidate, review-bundle version, adapter version and required questions. It is a definition hash, not a hash of executable bytes. Canadian descriptor hashes and saved output serialization are unchanged.

## Evidence and authority

`wageEvidence.documents` is an ordinary private, revision-bound declaration. Version1 decoding and its original-only database validator remain unchanged. Version2 supports W-2 originals and complete W-2c chains. The human UI presents authorized filenames, six effective box inputs, root/original and immediate-predecessor selectors, and explicit previously reported/correct amounts for each changed box. An empty correction list is explicit identity-only correction evidence; unchanged effective boxes must match the predecessor. Its internal JSON representation is not an authorization proof. The limit remains five retained documents and2000 saved-text characters; excess inputs fail without truncation.

The trusted bundle and version2 database validator reject missing originals/predecessors, branches, cycles, duplicate changed boxes, mismatched previously reported amounts and inconsistent carried effective boxes. Every original and correction is retained with immutable bytes/hash/reviewer bindings; aggregation uses terminal effective documents only. The human CSV includes retained/effective status, all effective boxes and each correction. Migration0059 replaces the trigger without rewriting0056; readiness requires its correction-schema marker. The private package version changes so stale preparation cannot silently approve a changed adapter hash. Historical output.1 CSV serialization remains unchanged.

The existing exact input review approves the saved declaration revision. The separate original-evidence review then requires an authenticated case owner/reviewer, the current snapshot/package and that exact reviewed source. It resolves original bytes from `finance_book_evidence` through a narrowly scoped function using the case snapshot's explicit book authorizations. AES-GCM scope verification, byte length and SHA-256 are checked before an immutable wage-review manifest is stored. No request may submit authoritative reviewer identity, permission, artifact hash, rule package or calculation output.

W-2 attachment applicability comes from the domain form graph, including zero wages with nonzero withholding. A saved extraction with no corresponding original review blocks a run. Wage totals must reconcile to the domain's six wage facts. The run adapter changes their calculation-only source binding to the server-created reviewed manifest; the durable questionnaire/declaration envelope remains unchanged and auditable.

Current case membership, private grants and exact historical book authorization revisions govern read, review, run and export. Revocation invalidates old runs; a later source rebind cannot reactivate the old authorization. Changing a declaration creates a new snapshot and cannot satisfy an old review. Old exports retain their stored package, manifest, input and output hashes.

## Endpoints

All paths are under `/api/v2/finance/tax/cases/:caseId` and use the existing authenticated private-case boundary:

- `GET working-papers` supplies the package-bound question list.
- `POST declarations` saves inputs; `POST working-papers/input-reviews` reviews exact revisions.
- `GET working-papers/wage-evidence` lists up to100 recent originals from explicitly authorized source books and current review metadata.
- `GET working-papers/wage-original?bookId=...&evidenceId=...` retrieves a verified original for an authorized human download.
- `POST working-papers/wage-evidence-reviews` approves the exact saved extraction against originals with CAS and idempotency.
- Existing `runs`, run detail, output review and export endpoints persist and expose the resulting working papers.

Numeric run details omit raw identity and wage-document metadata. Authorized human CSV includes reviewed form inputs. Finance-agent serializers must redact declaration values for `identity.*`, private business identity and `wageEvidence.documents`.

## Remaining return work

This integration does not resolve the federal candidate's broader credit/deduction/business applicability, complete-return independent validation, or unsupported penalty methods. New York's additional reviewed wage supplements require a subsequent adapter. W-2c support here covers the six bound federal wage boxes; other unsupported wage situations remain blocked by the domain candidate. Filing/signing is unperformed and is not used as a substitute for calculation/form completeness.

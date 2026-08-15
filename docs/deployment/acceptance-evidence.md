# Release acceptance evidence

Production promotion is fail-closed. A green image build, the API staging CLI,
or synthetic fixtures alone are not release acceptance.

The staging workflow assembles `acceptance-evidence.json` only when every
required receipt is present. The manifest is canonical JSON, bound to the full
source commit, the exact API/worker/web/PostgreSQL/PowerSync/Caddy digests, a
successful same-commit `CI` push run, the staging workflow run, and a six-hour
validity window. Staging signs the manifest with a dedicated Ed25519 private
key. Production holds only the public key and independently verifies the
signature, sidecar digest, receipt files, workflow run identities, conclusions,
source commit, image lock, and expiry.

## Required evidence

The fixed contract in `scripts/release/acceptance-evidence.mjs` requires:

- all application, infrastructure, image-build, production-preview browser,
  and agent-eval CI jobs;
- real production-preview PWA install/reopen/offline, conflict, voice,
  service-worker update, push-preference, and WCAG checks;
- a browser calling PowerSync `connect()` against staging, writing a canonical
  `sync_entities` row through the API, receiving it back through replication,
  and proving two-device private/shared isolation without tenant-wide claims;
- scheduler, finance-to-the-cent, and shopping live-offer workflows;
- cross-household RLS attacks and stale, tampered, and replayed approval tests;
- provider write/readback, fresh migration, backup-age/restore, and compatible
  rollback receipts; and
- credentialed live smokes for the enabled OpenAI, Google, Maps, email, Web
  Push, and commerce adapters.

Every required gate must be `passed`. Provider evidence must be
`credentialed-live` and release-eligible. Those manifest labels are derived
from validated receipt content; descriptors cannot assert them. Missing,
skipped, recorded, simulated, provider-disabled, credentialless, placeholder,
stale, duplicate, out-of-root, symlinked, digest-mismatched, malformed,
noncanonical, or unsigned evidence is rejected.

The API `staging-acceptance` executable contributes only the
`http-api-subset` receipt. It cannot satisfy browser, PowerSync, provider,
database-security, domain, eval, or recovery gates. It does not invoke agent,
voice, Calendar, or email-delivery provider operations; those require their
own credentialed receipts. The probe is explicitly `releaseEligible: false`.

Before any authenticated HTTP fixture, the executable requires the exact
version-1 `synthetic-http-subset` response documented in
`docs/deployment/README.md`. That staging-only response requires only the
authenticated HTTP and Sync components used by the deterministic fixture and
requires agent, Calendar, and voice providers to remain unavailable. It still
publishes the complete component map, `releaseEligible: false`, and never
changes the production `/readyz` contract. Legacy `database`/`worker`/`powersync`
check maps, missing or unknown checks, enabled excluded providers, and other
schema versions are rejected. The staging wrapper separately requires every
Compose service healthy first, including PostgreSQL, the worker, and PowerSync.
This subset readiness therefore cannot replace full API, worker, PowerSync,
database-security, replication, or provider evidence.

## Receipt layout

Receipt producers write bounded files under:

```text
release/acceptance-evidence/
  artifacts/{ci,gates,providers}/...
  descriptors/{ci,gates,providers}/<required-id>.json
```

Descriptors are written with `write-acceptance-descriptor.mjs`. A descriptor is
strictly `{id, artifact}`: the artifact name and SHA-256 digest only. Its path is
fixed to `artifacts/<category>/<id>.json`; success, status, evidence class,
freshness, and release eligibility are never accepted from a descriptor. The
writer validates the semantic receipt before creating the descriptor.

The assembler reads the exact fixed ID lists, opens each bounded regular
receipt, checks canonical UTF-8 JSON and the descriptor digest, applies the
category-and-ID-specific schema, and derives the manifest entry. Production
repeats the receipt validation after checking the canonical manifest digest and
Ed25519 signature. Both stages reject accessors, unsafe prototypes, forbidden
property names, extra fields, missing fields, sparse structures, and artifact
reuse.

CI writes strict receipts only from the successful job that ran each named
suite. Fixed producer profiles cover source quality, infrastructure policy,
the three release-image builds, provider-free agent eval/runtime safety, and
the production-build browser checks. Agent receipts require the exact 17-case
execution report, including sanitized capability/model/approval observations,
the named production-runtime Vitest results, and the separate token, spend,
and execution-budget results. Browser receipts require exact semantic
file/title/project identities to appear as successful production-Chromium
entries in the Playwright JSON report; aggregate counts alone are rejected. A
production-preview report can prove the production bundle, named routes,
responsive shell, and its bounded automated accessibility checks, but it cannot
prove the manual screen-reader, all-state contrast, and complete WCAG checklist.
The `wcag-2.2-aa` receipt therefore stays absent until a dedicated producer
consumes both the required automated results and the dated manual checklist. A
service-worker-ready offline edit/reopen check is not relabeled as a completed
PWA installation, so `pwa-install-offline-reopen` stays absent until an actual
installation suite runs. The browser voice gate requires two exact
production-Chromium identities. The lifecycle identity proves transcript
correction, captions, playback controls, and object-URL revocation. A separate
content-agnostic persistence identity arms mutation traps for browser storage,
Cache Storage, cookies, IndexedDB, and OPFS before the voice lifecycle, then
requires both zero page-realm write attempts and an exact before/after digest
of every enumerable durable value and file. The final-state comparison is
independent of key names and representation, so transformed or encrypted bytes
cannot remain hidden under a generic key. It does not claim that the separate
service-worker realm never performed a transient write followed by deletion;
it proves no voice or transcript state remains durably stored and that the page
made no persistence write. Only a report containing both exact passing
identities can emit `voice-ptt-storage-playback`. This remains provider-free
browser evidence: the test stubs transcription and speech, so it does not
satisfy the separate `openai-transcription` or `openai-speech` provider
receipts. A downstream aggregation job only merges already-validated receipts;
it does not create or relabel evidence.

The remaining PWA-installation, staging, PowerSync
cross-device, provider, database-security, domain, recovery, rollback,
service-worker update, and notification-preference receipts stay absent until
their real suites run. The assembler therefore continues to fail closed when
any required evidence is missing. Adding dummy receipt files or setting success
labels is not an acceptable release change.

## Semantic receipt envelope

Every receipt has schema version `1` and the exact fields for its contract:

- `category`, fixed ID, full 40-character `sourceSha`, canonical UTC
  `observedAt`, and `environment`;
- `execution` with the exact workflow path, GitHub run ID, head SHA, event, and
  successful conclusion;
- `result` with the required outcome and the exact ID-specific proof fields;
- the six exact digest-pinned API, worker, web, PostgreSQL, PowerSync, and Caddy
  image references for staging-run receipts; and
- `writeReadback` for approval/provider write contracts.

CI-run receipts bind to `.github/workflows/ci.yml`, the selected same-commit CI
push run, and environment `ci`. Staging-run receipts bind to
`.github/workflows/staging.yml`, the protected staging `workflow_dispatch` run,
environment `staging`, and all six release image digests. A CI receipt cannot be
relabeled as staging evidence, and a receipt from another workflow, run, commit,
or image set is rejected.

The strict proof maps are implemented beside the fixed required-ID lists in
`scripts/release/acceptance-evidence.mjs`. They cover every CI job and gate; for
example, the finance receipt must prove mapping/preview, duplicate and rejected
row isolation, integer-to-the-cent arithmetic, and an editable CAD budget. It
cannot substitute the shopping proof map. Browser/PowerSync, RLS, approval,
recovery, and rollback receipts likewise have distinct exact fields and reject
generic `passed: true` payloads.

Every provider proof additionally requires:

- `credentialed: true`, `credentialSource: protected-environment`, and a
  non-placeholder hash of the provider request ID;
- `liveRequest: true`, `simulationUsed: false`, and `skipped: false`;
- a non-placeholder SHA-256 digest of the provider response; and
- the provider-specific live assertions for OpenAI agents/audio, Google OAuth,
  Calendar, Maps, email, Web Push, or commerce offers.

`google-calendar-write-readback`, `transactional-email`, `web-push`, and the
`approval-provider-readback` gate are write-capable contracts. Their receipt
must include hashed target, idempotency, provider operation, and provider
version bindings, plus identical non-placeholder hashes for the expected
canonical payload and provider readback. A write acknowledgment without
readback is not release evidence.

Receipt producers must emit canonical JSON with `canonicalJson()` and a single
trailing newline. They must create a receipt only after the named suite has
completed successfully; the receipt validator verifies the evidence structure
and binding but does not turn an unexecuted suite into proof.

Provider-free CI profiles use
`scripts/release/write-provider-free-ci-evidence.mjs`. The shared
`writeValidatedAcceptanceReceiptAndDescriptor()` helper applies the same strict
receipt schema, canonical encoding, create-only file policy, and digest-only
descriptor rule for real staging producers; it does not supply proof values for
the caller.

Keep `ACCEPTANCE_EVIDENCE_PRIVATE_KEY` only in the protected staging GitHub
environment and `ACCEPTANCE_EVIDENCE_PUBLIC_KEY` in both staging and production.
Rotate the key pair by updating both environments together; evidence signed by
an old key immediately stops being promotable.

# API production composition status and blockers

The API executable uses one built-in production graph. It never imports an
environment-selected module and never substitutes an in-memory authority,
receipt store, provider, or read model. Missing or unhealthy capabilities stay
callable only through bounded `503` fallbacks and keep their exact readiness
component `unavailable`.

This document records source composition status. A source-green adapter or
probe is not a deployment proof: fresh and upgrade PostgreSQL execution,
purpose-specific login checks, credentialed provider smoke tests, and the
authenticated staging acceptance run remain separate gates.

## Composed durable capabilities

| Readiness component                  | Built-in binding                                                                                                                                | Required configuration                                                                                                                                   | Readiness evidence                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authority.authentication`           | Better Auth, CSRF, the PostgreSQL claim bridge, request-current scope resolver, atomic invitation redemption, and Resend action-email callbacks | Exact auth/API/onboarding DSNs, independent auth/session secrets, HTTPS public origin, Google identity client, and the selected Resend credential/sender | One coalesced probe requires the dedicated auth login, exact API scope routines, onboarding aggregate, and the verified Resend sending domain. Missing or malformed configuration opens no auth pools; a false probe routes every auth operation through the bounded unavailable boundary.                                                                          |
| `authority.household-administration` | `PostgresHouseholdAdministrationService` plus the public-only `InvitationDeliverySecretSealer`                                                  | `EMDO_API_DATABASE_URL`, `EMDO_INVITATION_DELIVERY_KEY_ID`, `EMDO_INVITATION_DELIVERY_PUBLIC_KEY_SPKI_BASE64URL`                                         | `household_administration_ready()` through `checkReady()`; malformed or missing key material leaves only this component unavailable.                                                                                                                                                                                                                                |
| `authority.proposal-queries`         | `PostgresProposalQueryRepository` with a dedicated authenticated cursor codec                                                                   | `EMDO_API_DATABASE_URL`, strict `EMDO_PROPOSAL_CURSOR_HMAC_KEYRING_B64URL`                                                                               | `check()` proves the exact query functions and privileges. Cursor verification happens before SQL, and SQL re-derives the current collection authorization scope. Missing, malformed, retired-under-grace, or duplicate key material leaves only proposal reads unavailable.                                                                                        |
| `authority.visual-proof-issuance`    | `PostgresVisualDecisionProofStore` with a dedicated rotating proof-token codec                                                                  | `EMDO_API_DATABASE_URL`, strict `EMDO_VISUAL_PROOF_HMAC_KEYRING_B64URL`                                                                                  | `check()` proves the prepare/finalize functions. PostgreSQL fixes the immutable issuance binding under locks, the API HMACs it, and only the digest is stored. Missing, malformed, retired, duplicate, or under-drained key material leaves proof issuance unavailable.                                                                                             |
| `authority.visual-decisions`         | Request-scoped `PostgresProposalRepository` plus the narrow `ProposalDecisionService`                                                           | `EMDO_API_DATABASE_URL`, exact `EMDO_VISUAL_DECISION_DATABASE_URL`, and the visual-proof keyring                                                         | One combined probe proves the API read/replay path and a membership-free decision login that can execute only the decision aggregate. Each request loads the persisted operation fingerprint, while the aggregate independently re-derives it under the fresh grant, consumes or exactly replays the proof, persists the decision, and links the staged resume job. |
| `agents.run-events`                  | `PostgresRunEventSource` over the authenticated API pool                                                                                        | `EMDO_API_DATABASE_URL` and the trusted authentication binding                                                                                           | `check()` proves the exact API login, membership, routine owner/configuration, EXECUTE-only aggregate boundary, forced RLS on manager turns/runs/events, and denial of the private authorization helper. Every replay page re-proves the fresh request grant against the exact run before reading bounded public events.                                            |
| `experience.*`                       | The seven gateways returned by `createPostgresExperienceReadGateways()` with a separate authenticated cursor codec                              | `EMDO_API_DATABASE_URL`, strict `EMDO_EXPERIENCE_CURSOR_HMAC_KEYRING_B64URL`                                                                             | Exact per-component database probes keep one projection failure from hiding the health of the other six. Missing or malformed cursor keys leave the experience ports unavailable; cursor integrity is not inferred from database readiness.                                                                                                                         |
| `sync.gateway`, `sync.jwks`          | The gateway and public JWKS returned by `createPostgresSyncGatewayRuntime()`                                                                    | `EMDO_API_DATABASE_URL`, exact HTTPS `EMDO_PUBLIC_ORIGIN`, strict `EMDO_SYNC_JWT_KEYRING_B64URL`                                                         | One coalesced `checkReady()` proves the exact API login/role, function and column privileges, forced RLS, and prohibited mutation/executor capabilities. The old PEM fields are unsupported.                                                                                                                                                                        |
| `voice.audio-requests`               | `PostgresAudioRequestCoordinator`                                                                                                               | `EMDO_API_DATABASE_URL`                                                                                                                                  | `audio_request_receipts_ready()` through `checkReady()` proves the receipt capability and isolation from operator reconciliation. It does not prove the OpenAI provider.                                                                                                                                                                                            |

Durable reads, proof issuance, and sync share the curated
`createDatabaseClient()` API pool. Visual decisions additionally own a bounded
`emdo_visual_decision_login` pool that can execute only the decision aggregate.
The broader `emdo_workflow_login` remains reserved for the unavailable agent
runtime, is not admitted to `api.env`, and is never opened by the public
decision route.
Authentication owns three bounded, purpose-specific clients:
`emdo_auth_login`, `emdo_api_login`, and `emdo_onboarding_login`. Adapter
construction is isolated per capability. The process closes every resource it
owns. If cleanup during partial construction fails, that client is retained
for the process-level cleanup pass.

The proposal-query adapter is constructed and independently probed, but the
top-level graph selects it only when the trusted authentication binding was
also constructed. No client-supplied principal or scope can activate the read
model.

## Conditionally composed capability awaiting external proof

### Authentication authority

`createProductionAuthenticationBoundary()` requires one Better Auth runtime,
CSRF protector, a single atomic durable `InvitationRedemptionCoordinator`,
exact public origin, and an
`ActivePrincipalScopeResolver` from the same trusted graph.
`PostgresSpaceAccessGrantService.resolveActivePrincipalScope()` now returns the
server-derived `collectionAuthorizationScopeFingerprint`; composition must
still never compute, cast, or accept that fingerprint from a client.

The built-in factory now owns the Better Auth pool/claim bridge, API scope
resolver, atomic onboarding coordinator, CSRF key, identity-only Google client,
and bounded Resend password-reset/verification callbacks. Configuration is
parsed completely before a pool opens. The auth and CSRF keys must be distinct
canonical base64url values containing 32–64 bytes, and the three DSNs must name
their exact logins. Provider delivery is bounded and idempotent; the readiness
probe caches success only briefly to avoid a provider request on every API
guard.

This is source composition, not credentialed evidence. Production remains
unready until the exact database roles and a verified Resend domain pass the
built artifact's probe, Google identity and email flows are exercised, and the
result is captured through protected staging/production gates. The current
staging contract admits only unrelated Google identity and Resend credentials
for this auth graph, on an API-only authentication egress network. It continues
to reject Calendar OAuth, OpenAI, push, and commerce credentials, keeps worker
provider execution disabled, and never substitutes no-op callbacks. A real
staging run remains pending.

## Intentionally unavailable capabilities

### Agent runtime

Visual decision persistence now atomically moves the already-staged
`approval_resume_jobs` row to ready. It does not claim that job or resume model
execution. Authenticated persisted run-event replay is now independently
composed through the grant-aware PostgreSQL aggregate; that read path does not
claim manager execution readiness. `createProductionAgentServiceBindingsFromDependencies()`
can bind concrete `managerTurns` and the approval-resume dispatcher, but its
environment factory remains empty because no complete request-scoped graph
supplies `DurableManagerTurnStore`, `ProductionAgentRuntimeFactory`, and
`DurableApprovalDecisionResumeBoundary`, plus their exact probes.

That runtime also needs durable memory, traces, checkpoints, disclosure grants,
spend accounting, domain persistence, provider completion receipts, trusted
provider authority-v2 resolvers, Calendar/maps/commerce providers, model cost
policy, and the OpenAI execution provider. Credential presence alone cannot
replace any of those server-owned authorities.

### Google Calendar connector

The provider boundary now uses authority v2 end to end. Conditional Calendar
writes are constructed from the trusted actor and branded stable authorization
scope fingerprint; each dispatch still receives and validates its fresh
request/grant/session operation sidecar, while the provider grant reference and
authorization epoch remain immutable approval and lease checks. A rotating
space-access grant is never pinned in the gateway constructor.

The durable factory constructs the provider-free binding only when the complete
production-only Calendar configuration is present; the top-level graph exposes
that binding only when trusted authentication was also constructed. Every
request derives a fresh actor from the authenticated principal
and constructs fresh DB-bound flow, encrypted grant, authorization epoch,
lease, and audit adapters; no principal-bound store or runtime is cached. The
session advisory lease uses a separately owned, lazy pool capped at two
connections, so holding a cross-replica lease cannot exhaust the main API pool
needed by nested durable operations. Shutdown drains route work and closes that
lease pool before the main API pool. The
exact callback is derived from `EMDO_PUBLIC_ORIGIN`, Calendar and identity
clients must differ, OAuth state and vault keys are independent, and
construction/readiness performs no Google request. The raw
`EMDO_CREDENTIAL_VAULT_KEY` has no supported fallback. Synthetic staging
rejects every Calendar client, state, and vault secret, so its current
all-components readiness contract cannot report `google.connector: ok`; that
profile mismatch remains an explicit release blocker rather than a fabricated
healthy provider. Protected credentialed consent/callback, revocation, and
Calendar read/write receipts are still required before provider acceptance.

Disconnect uses a durable provider-side-effect fence. One canonical active
operation is unique per actor regardless of request, idempotency key, session,
authorization epoch, or encrypted credential revision; retries link their own
receipts to that operation. Marking the operation `dispatching` atomically
advances the local authorization epoch, deletes the encrypted grant, and
invalidates pending flows before any Google request is allowed. A crash after
that commit therefore leaves no usable local Calendar authority. A recovered
`dispatching` operation is settled as `unconfirmed` without another Google
request, either by an authenticated retry or by the bounded aged-dispatch
reconciler. Completed receipts retain only bounded result and request/session
lineage, never token material. The isolated `NOLOGIN`
`emdo_google_oauth_disconnect_retention` and
`emdo_google_oauth_disconnect_reconciliation` policy roles can execute only
their bounded purge or reconciliation aggregates. No production login or
scheduler is composed for either role yet, so 90-day purge and aged-dispatch
reconciliation remain explicit deployment blockers outside API request
readiness.

### Voice provider

The OpenAI integration exports a bounded fetch transport, audio adapter, and
credentialed endpoint smoke routine, but there is no curated API
`VoiceGateway` production factory. The missing graph includes a trusted media
and container inspector, request-bound spend authority, frozen cost calculator,
translation between the API voice port and `OpenAiAudioAdapter`, strict API-key
configuration, and a bounded cached live smoke probe covering both
transcription models and the selected speech model. Therefore
`voice.provider` stays unavailable while the independently durable
`voice.audio-requests` receipt component may be healthy.

## Release boundary

Readiness turns `ready` only when every component in readiness schema version
`1` has a complete service binding and its bounded probe returns the literal
value `true`. The staging CLI validates that exact versioned payload and the
required OpenAPI method surface. Compose health for PostgreSQL, the worker, and
PowerSync remains mandatory outside the API readiness payload.

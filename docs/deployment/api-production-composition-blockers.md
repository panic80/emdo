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

| Readiness component                  | Built-in binding                                                                                                                                | Required configuration                                                                                                                                   | Readiness evidence                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `authority.authentication`           | Better Auth, CSRF, the PostgreSQL claim bridge, request-current scope resolver, atomic invitation redemption, and Resend action-email callbacks | Exact auth/API/onboarding DSNs, independent auth/session secrets, HTTPS public origin, Google identity client, and the selected Resend credential/sender | One coalesced probe requires the dedicated auth login, exact API scope routines, onboarding aggregate, and the verified Resend sending domain. Missing or malformed configuration opens no auth pools; a false probe routes every auth operation through the bounded unavailable boundary. |
| `authority.household-administration` | `PostgresHouseholdAdministrationService` plus the public-only `InvitationDeliverySecretSealer`                                                  | `EMDO_API_DATABASE_URL`, `EMDO_INVITATION_DELIVERY_KEY_ID`, `EMDO_INVITATION_DELIVERY_PUBLIC_KEY_SPKI_BASE64URL`                                         | `household_administration_ready()` through `checkReady()`; malformed or missing key material leaves only this component unavailable.                                                                                                                                                       |
| `authority.proposal-queries`         | `PostgresProposalQueryRepository` with a dedicated authenticated cursor codec                                                                   | `EMDO_API_DATABASE_URL`, strict `EMDO_PROPOSAL_CURSOR_HMAC_KEYRING_B64URL`                                                                               | `check()` proves the exact query functions and privileges. Cursor verification happens before SQL, and SQL re-derives the current collection authorization scope. Missing, malformed, retired-under-grace, or duplicate key material leaves only proposal reads unavailable.               |
| `experience.*`                       | The seven gateways returned by `createPostgresExperienceReadGateways()` with a separate authenticated cursor codec                              | `EMDO_API_DATABASE_URL`, strict `EMDO_EXPERIENCE_CURSOR_HMAC_KEYRING_B64URL`                                                                             | Exact per-component database probes keep one projection failure from hiding the health of the other six. Missing or malformed cursor keys leave the experience ports unavailable; cursor integrity is not inferred from database readiness.                                                |
| `sync.gateway`, `sync.jwks`          | The gateway and public JWKS returned by `createPostgresSyncGatewayRuntime()`                                                                    | `EMDO_API_DATABASE_URL`, exact HTTPS `EMDO_PUBLIC_ORIGIN`, strict `EMDO_SYNC_JWT_KEYRING_B64URL`                                                         | One coalesced `checkReady()` proves the exact API login/role, function and column privileges, forced RLS, and prohibited mutation/executor capabilities. The old PEM fields are unsupported.                                                                                               |
| `voice.audio-requests`               | `PostgresAudioRequestCoordinator`                                                                                                               | `EMDO_API_DATABASE_URL`                                                                                                                                  | `audio_request_receipts_ready()` through `checkReady()` proves the receipt capability and isolation from operator reconciliation. It does not prove the OpenAI provider.                                                                                                                   |

Durable read/sync bindings share the curated `createDatabaseClient()` API
pool. Authentication additionally owns three bounded, purpose-specific clients:
`emdo_auth_login`, `emdo_api_login`, and `emdo_onboarding_login`. Adapter
construction is isolated per capability, and the process closes every client
it owns exactly once.

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

### Visual proof, decision, and approval resume

Authenticated `proposalQueries.{list,getDetail}` is independently composed as
a read-only durable capability above. `visualProofs.issue` and
`proposals.decideWithVisualProof` remain unavailable until the write-side
authority-v2 aggregate is completely composed:

- every phase re-proves the stable server-derived
  `authorizationScopeFingerprint` under database locks;
- request, session, and space-grant IDs remain fresh non-hashed operation
  sidecars rather than immutable authority;
- visual proof tokens use a separate strict HMAC key ring; retired entries
  carry `issueUntil` and `verifyUntil`, current keys alone make new issuances,
  and prior keys only reproduce or verify eligible persisted artifacts;
- visual decision persistence, one-time proof consumption or deterministic
  replay, approval-resume job linkage, fresh phase-grant issuance, and terminal
  event CAS are atomic; and
- proof, decision, and resume adapters each expose exact fail-closed readiness
  probes after their SQL functions and ACLs are journaled.

Presence of the visual codec or key material is not health evidence. The
write-side private env name is `EMDO_VISUAL_PROOF_HMAC_KEYRING_B64URL`; the API
must not consume it until the final rotation schema and durable aggregate land.

### Agent runtime and run events

`createProductionAgentServiceBindingsFromDependencies()` can bind concrete
`managerTurns`, `runEvents`, and the approval-resume-backed `proposals` port.
Its environment factory remains empty because no complete request-scoped graph
supplies all of `DurableManagerTurnStore`, `DurableRunEventSource`,
`ProductionAgentRuntimeFactory`, and
`DurableApprovalDecisionResumeBoundary`, plus their exact probes.

That runtime also needs durable memory, traces, checkpoints, disclosure grants,
spend accounting, domain persistence, provider completion receipts, trusted
provider authority-v2 resolvers, Calendar/maps/commerce providers, model cost
policy, and the OpenAI execution provider. Credential presence alone cannot
replace any of those server-owned authorities.

### Google Calendar connector

The current Google OAuth/Calendar runtime is not bound because its earlier
grant-ID authority shape is being replaced by provider authority v2. The final
curated factory must return the route gateway and a bounded readiness check
over the DB-backed flow, encrypted grant, authorization epoch, lease, and audit
stores; vault key ring; identity and Calendar OAuth client separation; exact
redirect/public origins; and a credentialed live Calendar smoke target. The
trusted resolution must bind immutable household/private-space/provider grant
reference/authorization epoch/fingerprint authority and a fresh
request/grant/session operation sidecar. Until that exact contract lands,
`google.connector` stays unavailable.

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

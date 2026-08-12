# Worker Calendar broker boundary

## Decision

The MVP keeps transactional email and Web Push provider-neutral because the
repository has no selected vendor or production transport factory. It must not
invent provider SDKs, credentials, or delivery claims.

The selected Google Calendar clients are also not directly constructible in
the worker. They require the API OAuth/vault authority, while the worker role
has no grant-vault access and must not receive refresh tokens, the vault key,
or the OAuth client secret. The worker therefore exposes a narrow internal
Calendar broker contract and remains unavailable until a trusted internal
broker implements it.

## Broker requests

Every request carries the already-validated `DurableWorkerExecutionPermit` as
`jobAuthority`. This binds the broker call to the exact job name, operation,
queue job, payload hash, lease token, and lease expiry. The broker is an
internal trust boundary; none of these fields may be forwarded to Google.

Synchronization additionally carries only the opaque connection ID, sync
generation, sealed cursor, provider ID, household ID, space ID, and original
owner user ID loaded under the exact worker operation scope.

Reconciliation readback additionally carries the provider-attempt ID and a
sanitized attempt binding derived from the retained approval binding:
decision ID, user ID, agent ID, run ID, capability ID, capability fingerprint,
payload hash, household ID, private-space ID, authorization epoch, and the
existing opaque non-secret provider connection reference. It does not carry a
token, grant record, space/disclosure grant, raw canonical arguments, full
approval or authority binding, or provider response.

Inputs are schema-bounded and built from frozen validated values. The existing
strict sync result and full `ProviderWriteCompletion` union remain the only
accepted responses. Invalid, oversized, extra-field, timed-out, or thrown
responses fail closed as unavailable/indeterminate.

## Future internal broker obligations

A future broker implementation must:

1. authenticate the worker service independently of request data;
2. verify the active durable execution lease and exact target binding;
3. load the canonical connection or attempt itself and compare the supplied
   job, attempt, household, space, user, provider, connection, generation, and
   authorization-epoch bindings before acquiring credentials;
4. use the existing encrypted Google grant and OAuth clients inside the
   privileged boundary, returning no credential material;
5. perform only Calendar synchronization or provider readback, never replay a
   write; and
6. honor cancellation, a hard deadline, and a response-size ceiling, returning
   only the strict sanitized response contract.

The current repository has no worker service-authentication channel and no
API-owned bounded sync/readback methods. The worker has neither a canonical
grant/target lookup nor permission to open the API grant vault, so the broker
cannot be safely implemented inside the worker from existing source seams.

Until that implementation exists, direct production composition reports the
exact blocker `worker-calendar-broker-unavailable`. Optional provider absence
does not block core worker readiness, and no credentialed smoke is claimed.

## Verification

Tests must prove exact request fields, frozen data, preflight commit before
network I/O, no full approval binding at the broker, strict response parsing,
hard-bounded readiness, exact unavailable status, and absence of direct
proposal-reconciliation writes. The bundled artifact must prove enabled mode
fails before opening a database pool and disabled mode remains honestly
degraded.

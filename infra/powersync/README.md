# PowerSync infrastructure boundary

This directory is a **version-pinned deployment template**, not proof of an
operational PowerSync deployment. It targets
`journeyapps/powersync-service:1.23.3` and Sync Streams edition 3, based on the
official service configuration and Sync Streams documentation available on
2026-08-09. Production Compose must replace the tag with an approved immutable
image digest. The exact digest, server schema, PostgreSQL publication, JWKS
endpoint, and end-to-end authorization behaviour still require staging
validation. No PowerSync service package or CLI is installed in this workspace,
so these files are intentionally not represented as runnable or
provider-validated configuration.

`sync-rules.yaml` is named to match the approved repository layout. It contains
current Sync Streams, not legacy `bucket_definitions` Sync Rules.

## Trust and data flow

PowerSync is a replication/read path only:

1. PostgreSQL in the application database remains canonical.
2. PowerSync reads an explicit publication using a dedicated replication role
   and stores bucket state in a separate database using a separate storage
   owner.
3. The API issues a short-lived asymmetric JWT from `GET /api/v1/sync/token`.
   The token must contain `sub`, `aud`, `iat`, `exp`, and `jti`; `sub` is the
   server-resolved EMDO user ID and `aud` is exactly `emdo-powersync`. Keep token
   lifetime at five minutes. A matching `kid` must exist at the HTTPS JWKS URI.
4. Streams use only the signed subject (`auth.user_id()`) plus current,
   canonical membership rows. They do not use client or subscription
   parameters for authorization. A removed or inactive membership therefore
   stops qualifying for shared data on the next evaluated sync.
5. Offline mutations remain in the device upload queue. The web connector
   converts each mutation into a versioned `SyncOperation` and sends it to
   `POST /api/v1/sync/ops` with the authenticated application session and an
   idempotency key. Only the API may write canonical application tables.

The PowerSync service and its source role receive no `INSERT`, `UPDATE`,
`DELETE`, or application credential. Browsers receive neither database URI.
There is no global tenant stream. Adding a stream without an `auth.user_id()`
authorization path is a security change and must fail review.

## Databases and least-privilege roles

On the single VPS, use separate logical databases even if both live in one
PostgreSQL 17 cluster:

| Purpose                    | Example database | Example role                 | Required access                                                                                              |
| -------------------------- | ---------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Canonical application data | `emdo_app`       | `emdo_powersync_replication` | `LOGIN`, `REPLICATION`, `BYPASSRLS`, schema `USAGE`, and `SELECT` only on the allowlisted publication tables |
| PowerSync bucket state     | `emdo_powersync` | `emdo_powersync_storage`     | Own only the bucket database/schema required by the pinned service                                           |

`BYPASSRLS` is a PowerSync logical-replication requirement, so the replication
role is a sensitive infrastructure principal. Compensating boundaries are
mandatory: a private Docker network, no published PostgreSQL port, a narrowly
listed publication, explicit table grants, a secret-managed URI, and no reuse
by the API, worker, migration job, or operators.

The initial publication/grant allowlist is:

- `emdo.households`
- `emdo.household_memberships` (authorization lookup only; not emitted)
- `emdo.spaces`
- `emdo.space_records`
- `emdo.sync_entities` (canonical offline scheduler/finance/shopping rows)
- `emdo.conversation_events`
- `emdo.audit_events`

Create the `powersync` publication for only those tables—never `FOR ALL
TABLES`. Revoke cross-database access: the replication role must not connect to
the bucket database, the storage owner must not connect to the application
database, and application runtime roles must not connect to the bucket
database. Manage roles, grants, publication changes, and credential rotation in
the database/deployment migration path rather than manually on a running host.

## Configuration inputs

PowerSync expands its documented `!env` tag only for names beginning with
`PS_`. Supply these at deployment time; do not put values in tracked files or
Compose defaults:

| Variable                           | Meaning                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `PS_EMDO_APPLICATION_DATABASE_URI` | URI for the canonical database using only `emdo_powersync_replication`   |
| `PS_EMDO_BUCKET_DATABASE_URI`      | URI for the separate bucket database using only `emdo_powersync_storage` |
| `PS_EMDO_JWKS_URI`                 | Exact HTTPS URL of the API's public asymmetric JWKS                      |

The checked-in config uses `sslmode: disable` solely for same-host traffic on an
isolated, non-published Docker network. Before either PostgreSQL connection can
cross a host or untrusted network, change it to `verify-full`, configure the
pinned service's CA option, and prove certificate-name verification. Caddy is
the only public ingress; the PowerSync container port and metrics/admin routes
must remain private or separately authenticated.

## Stream privacy model

- `current_households` returns only households where the signed-in user has an
  active membership. Profile/authentication data stays outside PowerSync.
- `private_space_data` returns private spaces only when the signed-in user is
  both active in the household and the space's immutable original owner.
- `shared_space_data` returns shared spaces only to active household members.
- Domain records (including revisioned/tombstoned `sync_entities`), conversation
  events, and audit events inherit access through
  the authorized space CTE. Household owners get no private-member bypass.
- Queries enumerate output columns so a newly added secret or internal column
  cannot silently start replicating.
- Tombstoned records remain replicated long enough for deterministic client
  conflict handling and purge policy; no offline edit proposes or triggers a
  Google Calendar write.

Do not add credentials, auth sessions/accounts/passkeys, connector vault rows,
disclosure grants, raw traces, provider attempt payloads, or payment data to a
stream.

## Browser storage boundary

The web adapter (implemented outside this directory) must use PowerSync Web's
Safari-compatible OPFS path and an encrypted local SQLite database. Each device
gets a random database key, wrapped by a non-extractable WebCrypto key. The
database key, OPFS files, tokens, service-worker/private caches, and audio object
URLs are device-local and must be purged after the user chooses either **sync
now** or explicit **discard** during logout. This protects data at rest but does
not claim protection from an unlocked browser profile or successful XSS.

PowerSync does not authorize provider actions. Offline changes can update only
EMDO-local domain state through `/api/v1/sync/ops`; Calendar proposals and their
authenticated visual approval require connectivity.

## Validation and release gates

Local checks can establish only YAML syntax and static policy properties. They
cannot establish that this template is accepted by PowerSync or secure against
cross-household access.

Before enabling the service:

1. Select the exact `journeyapps/powersync-service:1.23.3` multi-architecture
   digest, record it in the deployment lock, and use compatible official schema
   validation tooling. Do not deploy `latest`, `1`, or `1.23` tags.
2. Validate both files against the schema/parser shipped for that exact image.
   Treat any warning, unsupported SQL operation, or implicit type conversion as
   a release blocker.
3. On a fresh PostgreSQL 17 staging database, verify `wal_level=logical`, the
   allowlisted `powersync` publication, role separation, bucket migrations,
   replication lag monitoring, and restore behaviour.
4. Run positive and negative token fixtures: missing/incorrect `aud`, expired
   token, unknown/retired `kid`, forged `sub`, inactive membership, private
   owner versus household owner, different household, and attempted client
   scope parameters.
5. Exercise two devices through the real API upload path and prove idempotency,
   tombstones, deterministic conflicts, logout purge, token/key rotation, and
   that no direct database mutation or external action is possible.
6. Inspect the generated client schema and confirm every replicated UUID maps
   to the PowerSync text `id` expected by the web schema.

No connector is complete until those staging gates pass. Static YAML parsing in
the repository is intentionally reported separately from runtime validation.

## Hostinger capacity boundary

The 4 GB Hostinger VPS is a single-node private-beta baseline, not high
availability. Application PostgreSQL, bucket storage, PowerSync, API, worker,
Caddy, and any on-demand staging services share that host and failure domain.
Do not represent this topology as PowerSync HA.

Start same-VPS staging only while production is healthy and preflight reports at
least 1.75 GB available memory and 10 GB free disk. Cap staging near 1.25 GB,
use separate networks, logical databases/volumes, credentials, keys, and
synthetic identities, then tear it down after the test window. Production must
use the exact staging-tested image digests and still requires tested logical
database restore plus the accepted provider-backup recovery limits.

## Upstream references

- [Self-hosted service configuration](https://docs.powersync.com/configuration/powersync-service/self-hosted-instances)
- [Sync Streams](https://docs.powersync.com/sync/streams/overview)
- [Sync Stream authorization patterns](https://docs.powersync.com/sync/streams/examples)
- [Custom JWT authentication](https://docs.powersync.com/configuration/auth/custom)
- [PostgreSQL source setup](https://docs.powersync.com/configuration/source-db/setup)
- [Schemas and connections](https://docs.powersync.com/sync/advanced/schemas-and-connections)
- [Client ID and UUID mapping](https://docs.powersync.com/sync/advanced/client-id)
- [Published PowerSync Service image tags](https://hub.docker.com/r/journeyapps/powersync-service/tags)

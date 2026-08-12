# Deployment secrets and host layout

Keep configuration outside the checkout:

```text
/etc/emdo/
  production/
    deployment.env
    postgres_superuser_password
    api_database_password
    auth_database_password
    onboarding_database_password
    worker_database_password
    worker_executor_database_password
    worker_dispatcher_database_password
    audio_reconciliation_database_password
    workflow_database_password
    powersync_replication_password
    powersync_storage_password
    owner_bootstrap_database_password
    owner-bootstrap.env  # present only until the initial owner one-shot succeeds
    migration.env
    api.env
    edge-proxy.env
    worker.env
    powersync.env
  staging/
    deployment.env
    ...the same filenames with unrelated values...
    synthetic.env
    synthetic-bootstrap.env
  backup/
    age-recipients.txt
  release/
    release-assets-public.pem
```

Directories are root-owned mode 0700. Every listed secret/env file is a
root-owned, non-symlink, single-link regular file with mode 0600, nonempty, and
no larger than 256 KiB. Deployment entrypoints validate the complete fixed
manifest before Compose can parse or mount it; a symlink or hard-link escape is
rejected. Production and staging must have unrelated PostgreSQL passwords,
session/JWT signing keys,
connector-vault keys, notification credentials, and application secrets.
Staging env files must omit all live Google, OpenAI, email, push, and commerce
credentials; the application additionally enforces
`EMDO_EXTERNAL_PROVIDERS_ENABLED=false`.

`release-assets-public.pem` is a root-owned, single-link mode-0644 Ed25519
public key installed by host preparation. The corresponding private key exists
only as the staging GitHub environment secret
`RELEASE_ASSET_SIGNING_PRIVATE_KEY`. It signs a canonical descriptor binding the
workflow run, source SHA, infrastructure archive hash, and image-lock hash. It
is never uploaded to the VPS or mounted into a container.

`deployment.env` contains only the allowlisted non-secret keys documented in
`infra/compose/.env.example`. Deployment scripts parse this file as data; they
do not `source` it. The digest artifact is likewise parsed with a key allowlist
and strict reference grammar.

Expected private env-file boundaries are:

- `migration.env`: the application migration URI plus the exact
  `EMDO_JOB_MIGRATION_DATABASE_URL` admin/migration DSN used only by the
  pg-boss installation one-shot;
- `api.env`: distinct application, Better Auth, invitation-onboarding, and
  workflow database URIs,
  application/session keys, encrypted-vault keyring, and provider settings.
  Sync signing uses only `EMDO_SYNC_JWT_KEYRING_B64URL`: canonical unpadded
  base64url of strict version-1 JSON with one current RSA PKCS#8 private key and
  at most two retired RSA SPKI public keys. Retired entries carry exact
  `retiredAt` and `verifyUntil` instants, remain valid for at least the
  five-minute token lifetime plus five seconds of skew, and are removed after
  expiry. Experience cursors use the separate required
  `EMDO_EXPERIENCE_CURSOR_HMAC_KEYRING_B64URL`: canonical unpadded base64url of
  strict version-1 JSON `{schemaVersion,current,previous}`. The current entry
  is exactly `{keyId,keyB64url}`; at most two retired entries add exact
  `{issueUntil,verifyUntil}` UTC instants. Keys are 32–64 bytes and key IDs are
  unique lowercase segmented identifiers. Authenticated proposal-list cursors
  use the same strict rotation envelope under the independent
  `EMDO_PROPOSAL_CURSOR_HMAC_KEYRING_B64URL`; their keys must not be reused for
  experience cursors, visual proofs, or Sync JWTs. The
  former raw-PEM/key-ID pair is unsupported. Invitation issuance
  uses only `EMDO_INVITATION_DELIVERY_KEY_ID` and
  `EMDO_INVITATION_DELIVERY_PUBLIC_KEY_SPKI_BASE64URL`; the API receives the
  worker's non-extractable RSA-OAEP/SHA-256 public key, never its private key.
  `EMDO_ONBOARDING_DATABASE_URL` uses only `emdo_onboarding_login`, a
  non-superuser, non-bypass login with exactly the `emdo_onboarding` role. It
  can invoke the atomic invitation-redemption aggregate but cannot read Better
  Auth tables or invoke the lower-level account provisioner directly;
- `edge-proxy.env`: exactly one 43-128 character base64url
  `EMDO_EDGE_PROXY_SECRET`, generated from at least 32 random bytes and shared
  only with the API and Caddy;
- `worker.env`: queue-only `EMDO_WORKER_DATABASE_URL` using
  `emdo_worker_login`, handler-only `EMDO_WORKER_EXECUTOR_DATABASE_URL` using
  `emdo_worker_executor_login`, dispatcher-only
  `EMDO_WORKER_DISPATCHER_DATABASE_URL` using
  `emdo_worker_dispatcher_login`, and audio-reconciliation-only
  `EMDO_AUDIO_RECONCILIATION_DATABASE_URL` using
  `emdo_audio_reconciliation_login`, plus the HTTPS
  `EMDO_APPLICATION_ORIGIN` and `EMDO_WORKER_DISPATCHER_ID`. The audio login is
  non-superuser, non-bypass, `NOINHERIT`, and has exactly one direct membership:
  the `NOLOGIN` `emdo_audio_reconciliation` role. It receives no queue,
  executor, dispatcher, API, migration, PowerSync, or provider credential.
  The runtime recognizes `EMDO_EXTERNAL_PROVIDERS_ENABLED` as an exact `true`
  or `false` flag (default `false`) and bounds enabled-adapter probes with
  `EMDO_WORKER_PROVIDER_READINESS_TIMEOUT_MS` (100-10000 ms, default 3000).
  The current host `worker.env` allowlist deliberately admits neither setting
  nor any provider credential, so the deployed MVP remains at the default.
  The direct entrypoint does not dynamically load an external composition
  module. Its source tree has no selected production email or Web Push
  transport factory. The Google clients remain inside the API OAuth/vault
  authority, and the repository has no service-authenticated, API-owned,
  hard-bounded Calendar sync/readback broker that can compare the exact worker
  lease, attempt, household, space, user, provider, and opaque connection
  bindings without returning tokens or grant records. The worker must not load
  the API OAuth client secret, vault key, refresh token, or encrypted grant.
  Consequently the direct artifact defines no provider-specific credential
  variable contract. Its artifact gate proves that forcing the flag to `true`
  fails before any database pool opens with
  `worker-email-adapter-unavailable`, `worker-push-adapter-unavailable`, and
  `worker-calendar-broker-unavailable`. A future provider-capable artifact must
  add an independently service-authenticated internal broker, exact host
  allowlisted configuration, canonical binding revalidation, response-size and
  deadline limits, and real bounded probes. No credentialed provider smoke is
  claimed. The
  worker fails closed if its purpose-specific DSNs resolve to the same effective
  identity;
  and
- `powersync.env`: replication and bucket-storage URIs only.

Staging validates these env files before Compose reads them. Database URLs must
use the exact purpose-specific login at `postgres:5432`, with `sslmode=disable`
and the expected `emdo_app` or `emdo_powersync` database. The synthetic CLI
shares the API network namespace and may call only
`http://127.0.0.1:3000`; application/public origins remain credential-free
HTTPS origins. Any non-allowlisted key—including OpenAI, Google, mail, push,
commerce, or production connector credentials—rejects the staging run.

Production `owner-bootstrap.env` is accepted only by the protected
`owner-bootstrap` Compose profile and contains exactly these six keys:

```text
EMDO_BOOTSTRAP_DATABASE_URL=postgresql://emdo_owner_bootstrap_login:<url-encoded-password>@postgres:5432/emdo_app?sslmode=disable
EMDO_BOOTSTRAP_HOUSEHOLD_NAME=...
EMDO_BOOTSTRAP_HOUSEHOLD_SLUG=...
EMDO_BOOTSTRAP_OWNER_EMAIL=...
EMDO_BOOTSTRAP_OWNER_NAME=...
EMDO_BOOTSTRAP_OWNER_PASSWORD=...
```

The API and worker never receive this file. The operator script rejects extra
keys and any database host/login other than the internal dedicated bootstrap
login, removes this identity file after success, records a non-PII completion
marker, and disables the login. Provisioning always keeps the login `NOLOGIN`;
the protected wrapper enables it only for the bounded one-shot and disables it
again through an EXIT cleanup path.

Staging's `synthetic.env` contains only
`EMDO_SYNTHETIC_OWNER_EMAIL`, `EMDO_SYNTHETIC_OWNER_PASSWORD`,
`EMDO_SYNTHETIC_CLIENT_ID`, `EMDO_STAGING_API_ORIGIN`,
`EMDO_PUBLIC_ORIGIN`, and the fail-closed staging guards. Both seeding and
acceptance receive it. `synthetic-bootstrap.env` contains only
`EMDO_BOOTSTRAP_DATABASE_URL`, `EMDO_BOOTSTRAP_HOUSEHOLD_NAME`,
`EMDO_BOOTSTRAP_HOUSEHOLD_SLUG`, and `EMDO_BOOTSTRAP_OWNER_NAME`; only the
one-shot seed container receives it. The HTTP-only acceptance container never
receives a database credential, API runtime env, migration env, or provider
credential.

`owner_bootstrap_database_password` belongs to the dedicated
`emdo_owner_bootstrap_login`, which is non-superuser, non-bypass, and a member
only of the single-use `emdo_owner_bootstrap` policy role. It is not an admin
or migration credential.

PowerSync never receives an API, migration, or PostgreSQL owner URI. The API
never receives the PowerSync storage owner or replication credential. Better
Auth uses its dedicated login, whose database preflight requires exactly one
direct membership (`emdo_auth`) and no direct object grants.

Do not put an age private identity on the routine backup host. Daily backup
uses only `age-recipients.txt` (public recipients). Supply an age identity to a
short-lived, isolated restore drill through `BACKUP_AGE_IDENTITY_FILE`, then
remove it according to the operator secret-handling procedure.

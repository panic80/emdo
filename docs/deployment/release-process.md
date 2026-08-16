# Release, staging, production, and rollback

## GitHub environment setup

Configure two GitHub environments before enabling workflows:

- `staging` contains the staging SSH identity, VPS host/known-hosts, loopback
  staging port, exact infrastructure image references, and a dedicated Ed25519
  release-asset signing key. Its SSH principal has one sudo command only:
  `/usr/local/sbin/emdo-staging-operator *`. The root-owned operator verifies a
  signed, hash-bound staging descriptor and admits only install, deploy,
  acceptance, and teardown for that workflow run. It cannot run caller-chosen
  root commands or production operations.
- `production` requires a human reviewer and permits deployments only from
  `main`. It contains a distinct production SSH identity. GitHub must not make
  its secrets available until environment approval.

Repository and environment secrets must never be echoed. Pin or Dependabot
review every third-party GitHub Action before production enablement. GitHub
environment protections, not a boolean script variable, are the authoritative
manual approval control.

## Delivery flow

1. Pull requests run CI only. No pull-request workflow has a deployment route
   or package-write permission.
2. A merge to `main` runs `Publish images`. API, worker, and web images are
   built for Node 24, run as non-root, receive SBOM/provenance attestations,
   and are pushed with `sha-<full commit>` tags. The workflow records registry
   digests in the `release-images` artifact.
3. An operator manually starts `On-demand staging` and selects the successful
   publish workflow run. The job verifies that it was a successful `push` run
   from `main`, adds reviewed PostgreSQL/PowerSync/Caddy digests, and rejects
   any non-digest reference.
4. The VPS preflight normally refuses staging unless production is fully
   healthy. The one-time `initial_deployment=true` path may replace only that
   health check with proof that no production state, Compose containers,
   volumes, or networks exist. Both paths still require `/proc/meminfo` to
   report at least 1.75 GiB available memory and `df -Pk` to report at least
   10 GiB free disk.
5. Staging receives its own network names, PostgreSQL/Caddy volumes, database
   credentials, keys, and loopback-only ingress. Provider access is disabled,
   the database must be empty, and only synthetic seed data is accepted. The
   six steady-state limits total 1248 MiB.
6. After health acceptance, GitHub creates `staging-tested-images`. The
   staging project is torn down immediately at the end of the test window; a
   persistent host sweeper is a second, reboot-durable teardown path if the
   runner disappears. A one-hour deployment deadline is published before the
   first Docker mutation, then replaced with the selected test-window deadline
   only after the project becomes healthy.
7. The operator creates and waits for a manual Hostinger snapshot, then
   manually starts `Protected production` with the successful staging run ID,
   snapshot reference, and completion timestamp. The protected environment
   holds approval.
8. Production verifies the staging workflow identity/conclusion and compares
   every digest and the full source commit. It rejects snapshot confirmations
   older than six hours, takes an encrypted logical backup, runs only declared
   backward-compatible application and pg-boss migrations, re-provisions
   runtime grants, starts the exact images, and promotes the lock only after
   every health check passes.

After the first deployment, this MVP flow promotes application images only.
`POSTGRES_IMAGE`, `POWERSYNC_IMAGE`, and `CADDY_IMAGE` must exactly match the
current production lock. The reproducible infrastructure archive digest must
also exactly match the active release, so ordinary promotion cannot change
Compose, Caddy, PowerSync, provisioning SQL, or host scripts. A mismatch is
rejected before backup, migrations, pulls, or container changes. Those
constraints keep a failed promotion and the application-only rollback lock
coherent. An infrastructure upgrade needs a separately reviewed maintenance
procedure with its own rollback model and is not authorized by these workflows.

## One-time first deployment

From the Hostinger console, an administrator first checks out the reviewed
release assets and runs `infra/scripts/prepare-host.sh` once with
`EMDO_HOST_PREPARATION_APPROVED=true`, `EMDO_STAGING_SSH_USER=<dedicated-user>`,
and `EMDO_RELEASE_ASSET_PUBLIC_KEY_FILE=<root-owned-reviewed-public-key>`. It
creates the fixed root-owned `/opt/emdo`, `/var/lib/emdo`, `/var/backups/emdo`,
and `/etc/emdo` tree, installs the root-owned recovery/staging operators, checks
and installs the one-command sudoers rule with `visudo`, and enables only the
persistent staging-expiry timer. Production backup and replication-pressure
timers stay disabled until production is healthy and alert delivery is proven.
It does not create credentials, deploy containers, or create a
household. Refuse rather than repair any path with the wrong exact owner/mode,
type, or link policy. Remove every broader sudo grant from the staging account.

Before first staging, authenticate the root Docker client to GHCR with a
dedicated machine credential limited to `read:packages`, stored in root-only
Docker credential storage outside releases and Compose env files. If all three
application packages are deliberately public, prove anonymous digest pulls
instead. Run `docker pull` for the exact API, worker, and web digest references
as the host preflight; a source repository being public does not prove its
container packages exist or are public. Rotate/revoke the machine credential
independently and never place it in GitHub deployment archives or containers.

The first release is staging-first; it is not a direct production bootstrap.
Start `On-demand staging` with `initial_deployment=true`. The host must prove
that `/var/lib/emdo/deployments` has no entries and that the
`emdo-production` project has no containers, named volumes, or networks.
Staging remains isolated, synthetic-only, capacity-gated, fully accepted, and
records the initial-deployment bit inside its exact-digest attestation.

After the staging run succeeds, create and confirm the Hostinger snapshot (or
the documented pre-bootstrap provider recovery point), then start `Protected
production` with the same staging run, `initial_deployment=true`, and
`initial_bootstrap_acknowledged=true`. GitHub environment approval remains
mandatory. Production requires all three matching facts: the workflow request,
the staging attestation, and the explicit bootstrap acknowledgment. Only then
may it create and atomically promote the first `current.env`.

Production deployment does not create a household owner automatically. After
the first release is healthy, a protected operator creates root-owned mode-0600
`/etc/emdo/production/owner-bootstrap.env` with the exact six keys documented
in `secrets.md`, then runs the script from the release bound in `current.env`:

```bash
sudo env PRODUCTION_OWNER_BOOTSTRAP_APPROVED=true \
  /opt/emdo/releases/<source-sha>-<production-run-id>/infra/scripts/bootstrap-production-owner.sh
```

The command runs `node dist/cli/bootstrap-owner.js --confirm
bootstrap-initial-owner-v1` in a network-limited, read-only one-shot container.
The database function requires an empty identity database, writes the verified
owner/household/private-space/audit records atomically, and rejects replay. On
success the host removes `owner-bootstrap.env`, records only completion time
and source SHA, and disables `emdo_owner_bootstrap_login`. Rotate
`owner_bootstrap_database_password` immediately afterward; it remains a
provisioning input but cannot authenticate while the database completion marker
exists. Never add the bootstrap env to API, worker, migration, staging seed, or
GitHub workflow secrets.

Never select either initial-deployment control for an upgrade or rollback. A
bootstrap request is rejected if any production state or Compose resource
exists; deleting only `current.env` does not make an existing installation
eligible. Once production exists, ordinary staging again requires a healthy
current release and production promotion requires all bootstrap flags and the
attested bit to be false.

Staging uses `http://:8080` inside its isolated Caddy project and binds only a
host-loopback high port. Production uses the configured public hostname and
Caddy-managed TLS. The staging HTTP exception never crosses the host or a
public Docker network.

## Production health and migrations

`current.env`, `previous.env`, and a failed `pending.env` live under
`/var/lib/emdo/deployments` with mode 0600. Staging preflight reads
`current.env`; outside the explicitly attested one-time bootstrap, a missing or
unhealthy production service is a hard stop. The
current lock also binds the exact `/opt/emdo/releases/<source>-<workflow-run>`
deployment assets. Health checks reject a container whose configured image
reference differs from that lock.

If the first production attempt fails after publishing `pending.env`, retry
only the same source and six image digests with a byte-identical reproducible
infrastructure archive. The protected initial-deployment path recognizes this
exact pending candidate and resumes without deleting its database or volumes;
it preserves the prior pending lock as failure evidence. Any changed digest or
asset archive fails closed and requires explicit incident recovery rather than
an automatic destructive cleanup.

Migration policy is expand/contract:

- a release may add nullable/new structures before readers depend on them;
- the preceding application image must remain compatible through the rollback
  window;
- destructive contraction occurs only after the old image is outside that
  window and a later backup has been tested; and
- neither the deployment nor rollback script performs reverse SQL.

## Rollback

Run the production workflow again with `operation=rollback`, a reason, and an
explicit schema-compatibility confirmation. This is a separate protected
environment approval. GitHub does not upload the current `main` deployment
files for rollback: it executes the rollback script bound into the active
production lock. The script selects only the previous API/worker/web digests,
keeps the currently tested PostgreSQL/PowerSync/Caddy digests and Compose
assets, fully reconciles all steady containers from those active assets, and
never touches the PostgreSQL volume or reverses migrations. It uses a cached
exact application digest when available and pulls only a missing one. A
mixed-image rollback lock records the application `SOURCE_SHA` separately from
`DEPLOYED_RELEASE_SOURCE_SHA`, which binds the still-active infrastructure
assets. It saves the failed lock, atomically promotes the effective rollback
lock, and writes an operator audit line. If rollback health fails after a
runtime change, it reapplies the original current lock and full steady topology
before returning failure; an unsuccessful reconciliation is a declared incident.

If the prior application is not compatible with the current schema, do not run
application rollback. Enter incident response, preserve the failed state, and
choose a forward fix or an outage restore from the pre-deployment snapshot or
a verified logical backup. A provider restore overwrites the VPS and therefore
requires explicit outage authorization.

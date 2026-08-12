# Backup and restore policy

## Accepted recovery limits

The 4 GB Hostinger VPS is one failure domain, not high availability. Enable the
provider's daily VPS backup and take a manual provider snapshot immediately
before each production deployment. Hostinger's built-in retention is limited;
restoring one of its backups or snapshots overwrites the VPS. Provider recovery
time is provider-dependent.

The accepted catastrophic VPS-loss recovery point objective is up to 24 hours.
Encrypted logical dumps kept on that same VPS improve recovery from database or
deployment mistakes, but do not reduce the catastrophic-loss RPO if the entire
VPS and local backup volume are lost together.

| Failure                        | Primary recovery source                | Bound/constraint                                     |
| ------------------------------ | -------------------------------------- | ---------------------------------------------------- |
| Bad release, compatible schema | Prior immutable application digests    | No database reversal                                 |
| Database mistake/corruption    | Latest verified encrypted logical dump | At most the logical backup interval                  |
| Pre-deployment regression      | Fresh manual Hostinger snapshot        | Restores/overwrites the whole VPS                    |
| Catastrophic VPS loss          | Hostinger daily backup                 | Accepted RPO up to 24 h; provider-dependent recovery |

## Daily encrypted logical backup

Install `infra/scripts/dispatch-active-release.sh` as root-owned mode 0755 at
`/usr/local/sbin/emdo-dispatch-active-release`, and install the four checked-in
`infra/systemd/emdo-{logical-backup,backup-age}.{service,timer}` units as
root-owned mode 0644. Enable both timers. The fixed dispatcher validates the
root-owned state/release path and invokes the script under the active lock's
exact `DEPLOYED_RELEASE_DIR`; the backup itself also refuses stale assets. The
daily backup and hourly freshness check therefore survive reboots. Configure
host monitoring to alert on either unit entering `failed`; the age check hashes
the selected bundle and fails when no complete backup exists or the newest is
older than 26 hours. The backup script:

1. requires the currently deployed immutable image lock and healthy Compose
   configuration;
2. streams custom-format dumps of `emdo_app` and `emdo_powersync` directly
   through `age`, so a plaintext database dump never lands on disk;
3. encrypts the bundle again, writes it and its SHA-256 sidecar with mode 0600,
   then atomically publishes a digest-bound `.complete` marker; and
4. records no database password, provider credential, or age private key.

The backup does not contain PostgreSQL login secrets. It does preserve database
object ownership and ACLs; a restore first initializes the current cluster-wide
NOLOGIN policy roles from migrations, then replays those governed owners and
grants. A bundle without its exact `.sha256` and `.complete` files is
interrupted/unpublished and must not be selected. Alert if the newest completed
backup is older than 26 hours. Retention deletion is an operator/storage policy
and is intentionally not performed by the backup script.

Enable the separate replication/disk-pressure timer at the same production
cutover. Its thresholds and incident response are documented in
[operations.md](./operations.md).

## Monthly restore drill

Run a restore only with all of these explicit inputs:

```bash
RESTORE_TARGET_ENVIRONMENT=staging \
RESTORE_RUN_ID=<numeric-drill-id> \
RESTORE_IMAGE_LOCK_FILE=/etc/emdo/restore/<numeric-drill-id>/images.env \
RESTORE_SECRETS_DIR=/etc/emdo/restore/<numeric-drill-id> \
BACKUP_AGE_IDENTITY_FILE=/etc/emdo/restore/<numeric-drill-id>/age-identity.txt \
infra/scripts/restore-drill.sh /var/backups/emdo/logical/<backup>.age
```

The command refuses any target other than `staging`, requires a Docker project
named `emdo-restore-<id>`, and requires credentials below
`/etc/emdo/restore/`. The temporary age identity must be a root-owned,
single-link, mode-0600 file in that same per-drill secret directory and must be
removed after the drill. The selected backup bundle and sidecars must be
root-owned mode-0600 files under `/var/backups/emdo/logical`. The drill verifies
the root-owned, single-link mode-0600 `images.env` from that same per-drill
secret directory before it can select any container image. It then verifies
the checksum, validates the exact encrypted metadata schema/source/PostgreSQL
image binding, allowlists archive entries,
restores both logical databases into a new named volume, preserves their
ownership/ACL contracts, applies forward migrations, re-provisions runtime
roles/publication, and performs a schema probe. It starts no API, PowerSync,
web, Caddy, agent, notification, or external provider service. Unless
`RESTORE_KEEP=true` is explicitly set for further restricted inspection, the
isolated volume is removed on exit. The append-only drill record includes the
selected backup basename and verified SHA-256 digest.

Record the monthly result outside the repository and alert on a drill older
than 35 days. A local successful drill proves logical recoverability only. It
does not prove a Hostinger snapshot/backup restore, DNS, TLS, provider
credentials, or production recovery time.

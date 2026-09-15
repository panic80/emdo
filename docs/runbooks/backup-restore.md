# Backup and restore

- Hostinger daily VPS backups and a pre-deployment manual snapshot are provider
  recovery layers; restoring one overwrites the VPS.
- Create an encrypted logical PostgreSQL dump every day for fast logical
  recovery. Keep encryption keys outside the VPS and repository.
- Alert on backup age, size, command failure, and missing encryption metadata.
- Monthly, restore a selected logical dump into isolated on-demand staging,
  run migrations/readiness/acceptance, and tear staging down.

The accepted catastrophic-loss objective is an RPO of up to 24 hours with
provider-dependent recovery time. Record the exact backup and restore evidence;
configuration files and a successful dump command alone are not a restore test.


## Normalized Finance local restore drill

Run `bash packages/db/scripts/verify-finance-restore.sh` from a checkout with
Docker, `age`, `age-keygen` and workspace dependencies installed. The drill
creates its own loopback-only synthetic PostgreSQL container, applies the current
migration journal, and seeds accounting, encrypted original evidence and a private
tax case through restricted application repositories.

The custom-format compressed dump is encrypted by age before it touches disk,
a tampered encrypted stream must fail authentication, and the decrypted bytes are
restored into a separate empty database. The drill checks exact accounting and
tax snapshot readback, original evidence decryption, current private permissions,
forced row security and rejection of posted journal edits. It uses the logical
backup/restore ownership and ACL behavior with cluster roles already provisioned.

Its temporary container, volume, key and encrypted artifact are removed on exit.
This local check verifies normalized database restoration and restricted reads.
The private staging drill in `docs/deployment/backup-restore.md` remains necessary
for full service restoration, external document storage and production key
recovery; this test does not replace that release gate.

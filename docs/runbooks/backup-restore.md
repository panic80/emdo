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

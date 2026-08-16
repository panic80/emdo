# EMDO production operations

## Logical-replication and disk pressure

PostgreSQL is configured with `max_slot_wal_keep_size=2048MB`. The finite cap
prevents a stalled PowerSync logical slot from retaining WAL until it fills the
single VPS disk; it does not make a stalled slot harmless.

After the first production release is healthy, enable the persistent monitor:

```bash
systemctl enable --now emdo-replication-pressure.timer
systemctl status emdo-replication-pressure.timer
```

The root-owned dispatcher binds each check to the release recorded in
`current.env`. Every 15 minutes it fails if the reviewed cap drifted, no logical
slot exists, any logical slot is inactive, retained WAL exceeds 1.5 GiB, or the
Docker storage filesystem has less than 10 GiB free. Host monitoring must alert
on `emdo-replication-pressure.service` entering `failed`; a green timer alone is
not evidence that its last service run passed.

When the alert fires:

1. preserve `current.env`, the exact image lock, service logs, slot name,
   activity state, retained-byte count, and filesystem usage;
2. stop staging and other non-production disk consumers, but do not delete a
   production slot, volume, or WAL file manually;
3. verify the latest encrypted logical backup and production health before any
   recovery mutation;
4. diagnose the pinned PowerSync service and its replication credential; and
5. if PostgreSQL has invalidated or dropped required WAL, follow the reviewed
   PowerSync full resync procedure for the pinned release, then prove private
   and shared `sync_entities` isolation and two-device readback again.

Do not increase the WAL cap as an incident workaround. A cap change is an
infrastructure maintenance release requiring a disk-capacity review, exact
staging evidence, protected approval, and its own rollback plan.

## Operator timer set

Host preparation installs, but deliberately does not activate, production
backup and monitoring timers. Once production is healthy and alert delivery is
proven, enable:

```bash
systemctl enable --now \
  emdo-logical-backup.timer \
  emdo-backup-age.timer \
  emdo-replication-pressure.timer
```

`emdo-staging-sweeper.timer` is the only timer enabled by host preparation
because it protects the host before the first production release exists.

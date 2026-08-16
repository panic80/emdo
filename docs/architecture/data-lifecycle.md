# Data lifecycle

1. The API validates a scoped request and records canonical data in PostgreSQL.
2. Authorized read models replicate to each device through PowerSync; offline
   changes return to the API as idempotent operations.
3. Agents receive only allowed data classes and produce auditable results or
   proposals, never direct external writes.
4. A policy decision may execute a fresh, single-use proposal and records the
   outcome in the append-only audit trail.
5. Retention, deletion, export, backup, and restore controls are implemented
   by later database and deployment tasks; this scaffold establishes their
   boundaries without storing customer data.

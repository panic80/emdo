# Incident response

## Immediate containment

1. Preserve request IDs, safe local trace references, immutable audit metadata,
   deployment locks, and provider request IDs. Do not copy private payloads into
   chat, tickets, or CI logs.
2. Disable the narrow affected capability or connector. Keep offline editing,
   local calculations, and deterministic reminders available when safe.
3. Revoke affected OAuth grants, sessions, keys, or invitations through their
   dedicated rotation/revocation paths.
4. For an indeterminate provider write, do not retry blindly. Reconcile with
   the stable provider idempotency key and exact target, then record the durable
   outcome.

## Data and deployment incidents

- Suspected cross-space exposure: stop affected reads, preserve RLS/audit
  evidence, rotate signing material if implicated, and prove isolation with a
  live PostgreSQL test before re-enable.
- Lost or stolen device: revoke server sessions and connector grants. Browser
  encryption does not protect an already unlocked profile or successful XSS.
- Failed release: use immutable prior image digests only when schema-compatible.
  Otherwise use a forward repair or an explicitly authorized restore.

After containment, document scope, timeline, evidence, user impact, recovery,
and a regression test. Never place credentials or raw voice audio in the report.

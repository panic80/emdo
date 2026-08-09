# Security boundaries

- Browser writes enter through the authenticated API; neither PowerSync nor a
  client cache is a canonical mutation path.
- PostgreSQL enforces household and space scoping. Every record belongs to
  exactly one server-derived space and retains its original owner. Household
  owners cannot read member-private content. Server-derived identity and
  authorization context are never accepted from a client or model claim.
- The manager delegates only to manifest-approved specialist capabilities. It
  has no raw provider or external-action tools.
- Approval-class provider mutations, including Google Calendar writes for the
  MVP, become immutable proposals and require authenticated visual approval
  before policy-gateway execution. Deterministic reminders, notifications, and
  retries are not new approval-class provider mutations and do not require a
  new visual approval.
- Connector credentials remain isolated behind encrypted integration
  boundaries. Logs, evaluations, and fixtures must contain no secrets.

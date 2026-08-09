# Security boundaries

- Browser writes enter through the authenticated API; neither PowerSync nor a
  client cache is a canonical mutation path.
- PostgreSQL enforces household and space scoping. Server-derived identity and
  authorization context are never accepted from a client or model claim.
- The manager delegates only to manifest-approved specialist capabilities. It
  has no raw provider or external-action tools.
- External side effects become immutable proposals. Only an authenticated,
  visual policy decision can authorize the policy gateway to execute one.
- Connector credentials remain isolated behind encrypted integration
  boundaries. Logs, evaluations, and fixtures must contain no secrets.

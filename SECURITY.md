# Security

Report vulnerabilities privately to the repository maintainers; do not include
secrets, household data, or exploit details in public issues. Until a dedicated
security contact is published, use the private contact method configured for
the repository owner.

EMDO treats PostgreSQL as canonical and the API as the only mutation boundary.
Every record belongs to exactly one server-derived space and retains its
original owner; household owners cannot read member-private content.

Approval-class provider mutations, including Google Calendar writes for the
MVP, are immutable proposals and require authenticated visual approval.
Deterministic reminders, notifications, and retries are not new approval-class
provider mutations and do not require a new visual approval.

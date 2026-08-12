# EMDO

EMDO is an invite-only household personal-assistant MVP. It is a TypeScript
modular monolith: the Fastify API is the sole canonical mutation path,
PostgreSQL is canonical storage, PowerSync serves replicated reads, and worker
jobs perform deterministic background work.

The user-facing manager delegates to three least-privilege specialists:
scheduler, finance, and shopping. Executable capabilities are centrally
registered and deny-by-default. External Calendar writes require a persisted,
single-use, authenticated visual approval; banking actions, purchases, and
checkout are not available.

## Workspace

- `apps/web`: responsive React/Vite PWA and encrypted offline boundary
- `apps/api`: Fastify API/BFF and streaming run-event surface
- `apps/worker`: deterministic reminders, synchronization, delivery, and
  reconciliation
- `packages/agent-core` and `packages/agents/*`: manager/specialist runtime
- `packages/{contracts,db,auth,toolbox,domains,integrations}`: shared policy,
  persistence, domain, and provider boundaries
- `infra`: Compose, PowerSync, Caddy, release, backup, and rollback assets
- `evals`: deterministic orchestration and policy regression cases

## Development

Use Node 24 (`nvm use`) and pnpm 9. Install dependencies with `pnpm install`,
then run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm evals
pnpm build
pnpm test:e2e
```

Credentialed PostgreSQL, OpenAI, Google, PowerSync, browser, and deployment
checks are separate gates. A green provider-free test suite does not imply
that a connector or Hostinger deployment is operational.

Start with the [local development runbook](docs/runbooks/local-development.md)
and [MVP acceptance ledger](docs/release/mvp-acceptance.md). Security and data
boundaries are recorded in
[docs/architecture/security-boundaries.md](docs/architecture/security-boundaries.md).

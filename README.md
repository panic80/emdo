# EMDO

EMDO is an invite-only household personal-assistant MVP. It is a TypeScript
modular monolith: the Fastify API is the sole canonical mutation path,
PostgreSQL is canonical storage, PowerSync serves replicated reads, and worker
jobs perform deterministic background work.

## Development

Use Node 24 (`nvm use`) and pnpm 9. Install dependencies with `pnpm install`,
then run `pnpm test`, `pnpm lint`, and `pnpm typecheck`.

This repository currently contains only workspace scaffolding and architecture
records; no application behaviour is implemented yet.

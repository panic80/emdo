# Architecture overview

EMDO is a TypeScript modular monolith managed as a pnpm workspace. The web
client calls the Fastify API for every canonical write. PostgreSQL is the
system of record; PowerSync only replicates authorized read models for offline
use. A worker executes deterministic background jobs. Agent packages are
policy-gated adapters around explicit capability manifests.

The code is grouped by deployable app (`apps`), reusable boundaries
(`packages`), operational configuration (`infra`), and evaluation fixtures
(`evals`). The layout keeps module boundaries explicit while retaining one
repository and coordinated deployment path for the MVP.

# Local development

## Prerequisites

- Node.js 24 and pnpm 9
- PostgreSQL 17 with `pgvector` for credentialed database tests
- Chromium and WebKit installed through Playwright for browser gates
- provider credentials only in a mode-0600 file outside Git and container
  build contexts

Use `.env.local` only for local secrets. Never print it, copy it into a
worktree, or pass secrets on a command line.

## Provider-free checks

```bash
nvm use 24
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm evals
pnpm build
pnpm test:e2e
```

The integration command must report credentialed suites as skipped when their
explicit test URL or provider environment is absent. A skip is not a pass.

## Local services

Render Compose with synthetic secrets before starting it. Do not point a local
client at production data or credentials. The API is the only canonical write
path; PowerSync is the replicated read path. Keep provider writes disabled
unless the visual-approval, durable-receipt, and provider-readback components
are all configured.

## Data reset

Use a disposable database or Compose project for destructive test resets.
Never delete a browser's OPFS database behind a running tab: first complete the
multi-tab logout handshake, then sync or explicitly discard pending changes.

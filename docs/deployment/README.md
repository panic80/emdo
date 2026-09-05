# EMDO deployment boundary

These assets describe the approved single-node Hostinger private-beta
topology. They have not deployed a VPS, created a provider backup, validated a
PowerSync release, or exercised production credentials. Those remain
environment-specific release gates.

The host runs six steady-state containers behind Caddy:

- PostgreSQL 17 plus pgvector, with separate `emdo_app` and
  `emdo_powersync` logical databases;
- API and deterministic worker processes;
- the static PWA server;
- PowerSync in unified mode; and
- Caddy as the only public ingress.

PostgreSQL, the worker, and PowerSync expose no host ports. The API has one
production-only loopback bind at `127.0.0.1:13000`; it exists solely for the
bearer-protected `/metrics` operator route and is removed by the staging
override. Caddy owns production ports 80/443, its admin endpoint remains
container-local, and Caddy always returns 404 for public `/metrics` requests.
To inspect metrics, tunnel local port 13000 to host `127.0.0.1:13000` and send
`Authorization: Bearer <EMDO_METRICS_TOKEN>`; household sessions never grant
metrics access.

## Artifact contracts

Every Compose image variable must contain an immutable reference ending in
`@sha256:<64 lowercase hex>`. Tags alone, including semantic-version and SHA
tags, are rejected by `infra/scripts/_common.sh`. `main` publishes convenient
`sha-<commit>` tags, but the deployment artifacts record and promote the
registry-returned digest.

The application image contract is:

| Target   | Runtime artifact/command                                       |
| -------- | -------------------------------------------------------------- |
| `api`    | `dist/index.js`, health at `/healthz` and `/readyz`            |
| `worker` | `dist/index.js`, readiness at port 3001 `/readyz`              |
| `web`    | `apps/web/dist/index.html` plus immutable hashed assets        |
| migrate  | `dist/cli/migrate.js --require-backward-compatible`            |
| jobs     | worker `dist/cli/migrate-jobs.js --install-only`               |
| seed     | `dist/cli/seed-synthetic.js --fail-if-nonempty --staging-only` |
| accept   | `dist/cli/staging-acceptance.js --all-mvp-gates`               |

## API readiness contract

`GET /readyz` uses readiness contract version `1`. A successful response is
strictly `{schemaVersion: 1, status: "ready", checks}` and requires every
group and component below to be `ok`:

- `authority`: `authority.authentication`,
  `authority.household-administration`, `authority.proposal-queries`,
  `authority.visual-decisions`, and `authority.visual-proof-issuance`;
- `agents`: `agents.manager-turns` and `agents.run-events`;
- `experience`: `experience.activity-read`,
  `experience.finance-imports`, `experience.finance-read`,
  `experience.notification-preferences`, `experience.schedule-read`,
  `experience.settings-read`, `experience.shopping-read`, and
  `experience.today-read`;
- `google`: `google.connector`;
- `sync`: `sync.gateway` and `sync.jwks`; and
- `voice`: `voice.audio-requests` and `voice.provider`.

Missing, extra, unhealthy, or inconsistent checks fail closed. An unready API
returns `503 application/problem+json`; its extensions include the same checks
and `readinessSchemaVersion: 1`. Changing the required key set or semantics
requires an explicit readiness-contract version change and coordinated CLI,
OpenAPI, package, and deployment updates.

Synthetic staging additionally registers `GET /synthetic-staging/readyz` only
when `EMDO_ENVIRONMENT=staging`, `EMDO_SYNTHETIC_DATA_ONLY=true`, and loopback
API ingress is enabled. Its exact version-1 response has profile
`synthetic-http-subset`, is always `releaseEligible: false`, requires
`authority.authentication`, `sync.gateway`, and `sync.jwks` to be `ok`, and
requires `agents.manager-turns`, `google.connector`, and `voice.provider` to be
`unavailable`. It includes the complete readiness check map for diagnostics.
The staging Compose healthcheck and HTTP-subset CLI use this path; production
does not register it, and `/readyz` remains the only complete API readiness
contract.

An explicitly enabled Finance synthetic run replaces that profile with
`GET /finance-synthetic-staging/readyz`; the two synthetic readiness routes are
mutually exclusive. The Finance route also requires
`EMDO_FINANCE_SYNTHETIC_STAGING=true` and
`EMDO_FINANCE_DOCUMENTS_ENABLED=true`. Its version-1 profile is
`finance-synthetic-staging`, is always `releaseEligible: false`, requires the
Finance manager, guarded-action authority, run-event, import, read, and
document checks to be `ok`, and requires `google.connector` and
`voice.provider` to remain `unavailable`. Only the Finance Compose overlay uses
this path for its API healthcheck; baseline staging and production remain
unchanged.

`database`, `worker`, and `powersync` are not API readiness keys. The API's
concrete component probes verify their own database/provider dependencies.
Worker and PowerSync process health remain mandatory Compose gates and are
checked by `assert_compose_healthy` before the release-image staging CLI runs.
This split avoids the PowerSync-to-API health dependency cycle while retaining
all three deployment gates.

The API process loads only its bundled production composition. Deployment
environment values cannot select or import executable modules. Tests exercise
an internal assembler that is not re-exported by the production package; the
production creators and server entrypoint accept only environment data.

The current exact contracts and ownership map for the fail-closed `experience`
components are documented in
[api-read-model-blockers.md](./api-read-model-blockers.md).
The complete built-in graph, source-ready bindings, and exact upstream
authority/provider blockers are documented in
[api-production-composition-blockers.md](./api-production-composition-blockers.md).

Publishing must fail if the application build does not produce those
artifacts. The release workflow never substitutes source execution for a
missing production build.

API and worker runtime stages contain only their manifests, bundled output,
and production external-dependency closure. `pnpm deploy --prod` constructs
the closure, then a scoped build helper removes bundled `@emdo/*` workspace
packages. Source, tests, workspace tooling, and development dependencies remain
in the discarded build stage. A deny-by-default `.dockerignore` keeps local
environment files, Git data, `node_modules`, stale `dist`, and tests out of the
BuildKit context itself. Release validation rejects source maps, type/source
artifacts, source-map references, and residual `@emdo/*` runtime imports across
API, worker, and web artifacts.

`POSTGRES_IMAGE` must be a PostgreSQL 17 image containing pgvector (for
example, a reviewed `pgvector/pgvector` release) and must be pinned by digest.
`POWERSYNC_IMAGE` must be the exact digest validated with the checked-in
PowerSync configuration. Final image digests are immutable even though build
base references are human-readable versions; BuildKit provenance and SBOM
attestations preserve the base-image evidence for review.

## Database principal lifecycle

The first-volume initialization file creates only login principals and the
separate PowerSync storage database. Passwords are read by PostgreSQL from
mounted secret files, never inserted into Compose or command arguments.

Application migrations create the policy roles and row-level-security
objects. A separate worker-image one-shot installs and verifies the pg-boss
schema; the steady-state worker has migrations disabled. The `provision`
one-shot then:

1. binds each login to one purpose-specific NOLOGIN role;
2. keeps Better Auth bound only to `emdo_auth`; keeps the queue login limited
   to pg-boss; and binds separate worker executor/dispatcher logins to exactly
   `emdo_worker_executor` and `emdo_worker_dispatch_executor` respectively;
   audio reconciliation uses a fourth worker-side login bound only to
   `emdo_audio_reconciliation`;
3. grants PowerSync SELECT only on the seven approved publication tables; and
4. recreates the explicit `powersync` publication—never `FOR ALL TABLES`.

The API and worker never receive the PostgreSQL owner password. The migration
and provisioning jobs are short-lived, run before the steady-state services,
and retain no credentialed container.

## What must be proven outside this repository

- exact Caddy and PowerSync configuration validation using the selected image
  digests;
- clean PostgreSQL 17 initialization, migrations, runtime-principal
  preflights, logical replication, and PowerSync bucket setup;
- application health and resource pressure on the 4 GB VPS;
- real staging acceptance, including synthetic-only verification;
- Hostinger snapshot completion, provider backup age, and provider restore;
- a monthly logical restore drill using an encrypted backup; and
- protected production environment approval for the exact staging-tested
  artifact.

See [release-process.md](./release-process.md),
[base-images.md](./base-images.md),
[secrets.md](./secrets.md), [operations.md](./operations.md), and
[backup-restore.md](./backup-restore.md).

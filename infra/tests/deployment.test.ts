import { readFile, readdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);

const read = (path: string): Promise<string> =>
  readFile(new URL(path, root), 'utf8');

describe('container and edge configuration', () => {
  it('allows only the reviewed package install hook and static SQLite WASM', async () => {
    const [rootManifestSource, webReleaseAssertion] = await Promise.all([
      read('package.json'),
      read('apps/web/scripts/assert-release-artifact.mjs'),
    ]);
    const rootManifest = JSON.parse(rootManifestSource) as {
      pnpm?: { onlyBuiltDependencies?: unknown };
    };

    expect(rootManifest.pnpm?.onlyBuiltDependencies).toEqual(['esbuild']);
    expect(webReleaseAssertion).toContain('libpowersync');
    expect(webReleaseAssertion).toContain('mc-wa-sqlite-DoDpgFfE.wasm');
    expect(webReleaseAssertion).toContain('mc-wa-sqlite-async-DYagSq56.wasm');
  });

  it('keeps server authority contracts out of web source and release artifacts', async () => {
    const webSourceRoot = new URL('apps/web/src/', root);
    const [webReleaseAssertion, sourcePaths] = await Promise.all([
      read('apps/web/scripts/assert-release-artifact.mjs'),
      readdir(webSourceRoot, { recursive: true }),
    ]);
    const webSources = await Promise.all(
      sourcePaths
        .filter((path) => /\.[cm]?[jt]sx?$/u.test(path))
        .map((path) => readFile(new URL(path, webSourceRoot), 'utf8')),
    );

    for (const source of webSources) {
      const imports = [
        ...source.matchAll(/['"](@emdo\/contracts(?:\/[^'"]*)?)['"]/gu),
      ];
      for (const [, specifier] of imports) {
        expect(specifier).toBe('@emdo/contracts/browser');
      }
    }
    for (const forbiddenMarker of [
      'google-calendar-grant-v2',
      'providerGrantReference',
      'authorizationEpoch',
      'providerSdkCallId',
    ]) {
      expect(webReleaseAssertion).toContain(forbiddenMarker);
    }
  });

  it('uses a strict Docker context allowlist without local secrets or stale artifacts', async () => {
    const dockerignore = await read('.dockerignore');
    const lines = dockerignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));

    expect(lines[0]).toBe('**');
    for (const buildInput of [
      '!apps/*/src/**',
      '!apps/*/build.mjs',
      '!apps/web/scripts/assert-release-artifact.mjs',
      '!apps/web/scripts/copy-powersync-static-assets.mjs',
      '!packages/agents/*/package.json',
      '!packages/agents/*/src/**',
      '!packages/agent-core/smoke/clean-dist.mjs',
      '!packages/db/drizzle/**',
      '!infra/scripts/validate-runtime-package.mjs',
    ]) {
      expect(lines).toContain(buildInput);
    }

    const lastAllow = Math.max(
      ...lines.map((line, index) => (line.startsWith('!') ? index : -1)),
    );
    for (const exclusion of [
      '**/.env*',
      '**/.git/**',
      '**/node_modules/**',
      '**/dist/**',
      'apps/web/public/@powersync/**',
      '**/src/test/**',
      '**/*.test.*',
      '**/*.spec.*',
    ]) {
      expect(lines.indexOf(exclusion)).toBeGreaterThan(lastAllow);
    }
  });

  it('builds the three application targets from Node 24 and drops root', async () => {
    const dockerfile = await read('Dockerfile');

    const pinnedNode = 'node:24.13.0-bookworm-slim@sha256:[0-9a-f]{64}';
    expect(dockerfile).toMatch(
      new RegExp(`^FROM ${pinnedNode} AS build$`, 'm'),
    );
    expect(dockerfile).toMatch(new RegExp(`^FROM ${pinnedNode} AS api$`, 'm'));
    expect(dockerfile).toMatch(
      new RegExp(`^FROM ${pinnedNode} AS worker$`, 'm'),
    );
    expect(dockerfile).toMatch(
      /^FROM nginxinc\/nginx-unprivileged:1\.29\.1-alpine@sha256:[0-9a-f]{64} AS web$/m,
    );
    expect(
      dockerfile.match(/node:24\.13\.0-bookworm-slim@sha256:/g),
    ).toHaveLength(3);
    expect(dockerfile).toContain(
      'node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f',
    );
    expect(dockerfile).toContain(
      'nginxinc/nginx-unprivileged:1.29.1-alpine@sha256:27985295bdb22a1ef8f712863210bd5877c0f3006494a593e86b3fe0fa55467e',
    );
    expect(dockerfile.match(/^USER (?!root\b).+$/gm)).toHaveLength(3);
    expect(dockerfile).toContain('pnpm install --frozen-lockfile');
    expect(dockerfile).toContain('pnpm build');
    expect(dockerfile).toContain('pnpm --filter @emdo/api deploy --prod');
    expect(dockerfile).toContain('pnpm --filter @emdo/worker deploy --prod');
    expect(dockerfile).toContain("-name '*.map'");
    expect(dockerfile).toContain("-name '*.d.ts'");
    expect(dockerfile).toContain('validate-runtime-package.mjs /opt/emdo/api');
    expect(dockerfile).toContain(
      'validate-runtime-package.mjs /opt/emdo/worker',
    );
    for (const apiEntrypoint of [
      './dist/index.js',
      './dist/cli/migrate.js',
      './dist/cli/bootstrap-owner.js',
      './dist/cli/seed-synthetic.js',
      './dist/cli/staging-acceptance.js',
    ]) {
      expect(dockerfile).toContain(`import('${apiEntrypoint}')`);
    }
    expect(dockerfile).toMatch(
      /RUN cd \/opt\/emdo\/api[\s\S]*?Promise\.all\(\[[\s\S]*?\]\)/,
    );
    expect(dockerfile).toContain('createUnavailableWorkerProviderRuntime');
    expect(dockerfile).toContain("runtime.status.overall !== 'degraded'");
    expect(dockerfile).toContain(
      'validate-runtime-package.mjs /workspace/apps/web',
    );
    expect(dockerfile).not.toContain('/workspace /app');
  });

  it('defines a digest-only, least-privilege production topology', async () => {
    const compose = await read('infra/compose/compose.yml');

    for (const service of [
      'postgres',
      'migrate',
      'owner-bootstrap',
      'api',
      'worker',
      'web',
      'powersync',
      'caddy',
    ]) {
      expect(compose).toMatch(new RegExp(`^  ${service}:$`, 'm'));
    }

    for (const image of [
      'POSTGRES_IMAGE',
      'API_IMAGE',
      'WORKER_IMAGE',
      'WEB_IMAGE',
      'POWERSYNC_IMAGE',
      'CADDY_IMAGE',
    ]) {
      expect(compose).toContain(`\${${image}:?`);
    }

    expect(compose).not.toMatch(/image:\s+[^\n]*:latest(?:\s|$)/);
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain('cap_drop:');
    expect(compose).toContain('- ALL');
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('internal: true');
    expect(compose).not.toMatch(/^\s+- ["']?[^\n]*:2019:2019/m);
    expect(compose).not.toMatch(/^\s+- ["']?\d+:5432/m);
    expect(compose).not.toMatch(/^\s+- ["']?\d+:8080/m);
    expect(compose).toContain("'127.0.0.1:13000:3000'");
    expect(compose.match(/healthcheck:/g)?.length).toBeGreaterThanOrEqual(6);
    expect(compose).toContain("fetch('http://127.0.0.1:3001/readyz')");
    expect(compose).not.toContain("fetch('http://127.0.0.1:3001/healthz')");
    expect(compose).toMatch(
      /worker:[\s\S]*?networks:\n\s+- backend\n\s+- egress/,
    );
    expect(compose).toMatch(/worker:[\s\S]*?env_file:[\s\S]*?\/worker\.env/);
    expect(compose).toMatch(/networks:[\s\S]*? {2}egress:\n/);
    expect(compose).toContain('uid=101,gid=101,mode=0750');
    expect(compose).toContain('max_slot_wal_keep_size=2048MB');
    expect(compose.match(/\/edge-proxy\.env/g)).toHaveLength(2);
    expect(compose).toMatch(/caddy-init:[\s\S]*?network_mode: none/);
    expect(
      compose.match(/limits:\n\s+memory:/g)?.length,
    ).toBeGreaterThanOrEqual(6);
    expect(compose.match(/pids_limit:/g)).toHaveLength(
      compose.match(/^\s+pids:/gm)?.length,
    );
  });

  it('isolates and caps ephemeral staging with synthetic data only', async () => {
    const [staging, common] = await Promise.all([
      read('infra/compose/compose.staging.yml'),
      read('infra/scripts/_common.sh'),
    ]);

    expect(staging).toContain('STAGING_RUN_ID:?');
    expect(staging).toMatch(/EMDO_SYNTHETIC_DATA_ONLY: ['"]true['"]/);
    expect(staging).toMatch(/EMDO_EXTERNAL_PROVIDERS_ENABLED: ['"]false['"]/);
    expect(staging).toMatch(/^ {2}staging-acceptance:$/m);
    expect(staging).toMatch(
      /synthetic-data:[\s\S]*?synthetic\.env[\s\S]*?synthetic-bootstrap\.env/,
    );
    expect(staging).toMatch(/staging-acceptance:[\s\S]*?synthetic\.env/);
    expect(staging.match(/network_mode: service:api/g)).toHaveLength(2);
    expect(staging).toMatch(
      /api:[\s\S]*?EMDO_ALLOW_LOOPBACK_API_INGRESS: ['"]true['"]/,
    );
    expect(staging).not.toMatch(
      /staging-acceptance:[\s\S]*?synthetic-bootstrap\.env/,
    );
    expect(staging).not.toMatch(/synthetic-data:[\s\S]*?api\.env/);
    expect(staging).toContain(
      'emdo-staging-${STAGING_RUN_ID:?STAGING_RUN_ID is required}-backend',
    );
    expect(staging).toContain(
      'emdo-staging-${STAGING_RUN_ID:?STAGING_RUN_ID is required}-postgres',
    );
    expect(staging).toContain('# Aggregate steady-state limit: 1248 MiB.');
    expect(staging).not.toContain('PRODUCTION_SECRETS_DIR');
    expect(common).toContain('EMDO_EXPERIENCE_CURSOR_HMAC_KEYRING_B64URL');
    expect(common).toContain('EMDO_PROPOSAL_CURSOR_HMAC_KEYRING_B64URL');
    expect(common).toContain('EMDO_VISUAL_PROOF_HMAC_KEYRING_B64URL');
    expect(common).toContain('EMDO_VISUAL_DECISION_DATABASE_URL');
    expect(common).not.toContain('EMDO_WORKFLOW_DATABASE_URL');
    expect(staging.match(/restart: 'no'/g)).toHaveLength(6);
    expect(staging).toMatch(/api:[\s\S]*?ports: !override \[\]/);
    expect(staging).toMatch(
      /api:[\s\S]*?networks: !override\n\s+- backend\n\s+- edge\n\s+- auth-egress/,
    );
    expect(staging).toMatch(/edge:[\s\S]*?internal: true/);
    expect(staging).toContain(
      'emdo-staging-${STAGING_RUN_ID:?STAGING_RUN_ID is required}-auth-egress',
    );
    expect(staging).toMatch(/egress:[\s\S]*?internal: true/);
    expect(
      staging.match(/limits:\n\s+memory:/g)?.length,
    ).toBeGreaterThanOrEqual(6);
  });

  it('sets TLS/security headers and forbids caching or buffering event/audio responses', async () => {
    const caddyfile = await read('infra/caddy/Caddyfile');

    expect(caddyfile).toContain('{$EMDO_DOMAIN}');
    expect(caddyfile).toContain('Strict-Transport-Security');
    expect(caddyfile).toContain('Content-Security-Policy');
    expect(caddyfile).toMatch(/script-src[^"\n]*'wasm-unsafe-eval'/);
    expect(caddyfile).not.toMatch(/script-src[^"\n]*'unsafe-eval'/);
    expect(caddyfile).toContain('X-Content-Type-Options');
    expect(caddyfile).toMatch(
      /@event_stream[\s\S]*Cache-Control "no-store, no-transform"[\s\S]*flush_interval -1/,
    );
    expect(caddyfile).toMatch(
      /@voice_audio[\s\S]*Cache-Control "no-store, private, max-age=0"/,
    );
    expect(caddyfile).toMatch(
      /@voice_audio[\s\S]*request_body[\s\S]*max_size 20MB/,
    );
    expect(caddyfile).toContain('X-Accel-Buffering "no"');
    expect(caddyfile).toContain('admin localhost:2019');
    expect(
      caddyfile.slice(0, caddyfile.indexOf('@event_stream')),
    ).not.toContain('\tencode ');
    expect(caddyfile).toMatch(/handle @api \{\n\s+encode zstd gzip/);
    expect(caddyfile).toMatch(/@api path[^\n]*\/openapi\.json/);
    expect(caddyfile.match(/header_up -X-Emdo-Edge-Proxy/g)).toHaveLength(3);
    expect(
      caddyfile.match(
        /header_up X-Emdo-Edge-Proxy \{\$EMDO_EDGE_PROXY_SECRET\}/g,
      ),
    ).toHaveLength(3);
    expect(
      caddyfile.match(
        /header_up X-Forwarded-For \{http\.request\.remote\.host\}/g,
      ),
    ).toHaveLength(3);
    expect(caddyfile.match(/header_up -Forwarded/g)).toHaveLength(3);
    expect(caddyfile.match(/header_up -X-Real-IP/g)).toHaveLength(3);
  });

  it('reasserts runtime login attributes and rotates every database password', async () => {
    const [compose, provision, initialization] = await Promise.all([
      read('infra/compose/compose.yml'),
      read('infra/compose/provision-runtime.sql'),
      read('infra/compose/postgres-init.sql'),
    ]);

    for (const secret of [
      'api_database_password',
      'auth_database_password',
      'onboarding_database_password',
      'worker_database_password',
      'worker_executor_database_password',
      'worker_dispatcher_database_password',
      'audio_reconciliation_database_password',
      'workflow_database_password',
      'visual_decision_database_password',
      'powersync_replication_password',
      'powersync_storage_password',
      'owner_bootstrap_database_password',
    ]) {
      expect(compose).toContain(`- ${secret}`);
      expect(provision).toContain(`pg_read_file('/run/secrets/${secret}')`);
    }
    const provisionService = compose.match(
      /\n {2}provision:\n[\s\S]+?\n {2}api:\n/u,
    )?.[0];
    expect(provisionService).toBeDefined();
    for (const secret of [
      'postgres_superuser_password',
      'api_database_password',
      'auth_database_password',
      'onboarding_database_password',
      'worker_database_password',
      'worker_executor_database_password',
      'worker_dispatcher_database_password',
      'audio_reconciliation_database_password',
      'workflow_database_password',
      'visual_decision_database_password',
      'powersync_replication_password',
      'powersync_storage_password',
      'owner_bootstrap_database_password',
    ]) {
      expect(provisionService).toContain(`- ${secret}`);
    }
    expect(initialization).toContain('CREATE ROLE emdo_owner_bootstrap_login');
    for (const login of [
      'emdo_onboarding_login',
      'emdo_worker_executor_login',
      'emdo_worker_dispatcher_login',
      'emdo_audio_reconciliation_login',
    ]) {
      expect(initialization).toContain(`CREATE ROLE ${login} LOGIN`);
      expect(provision).toContain(`CREATE ROLE ${login} LOGIN`);
      expect(provision).toContain(`WHERE rolname = '${login}'`);
    }
    expect(initialization).toContain('GRANT CONNECT ON DATABASE emdo_app');
    expect(provision).toContain(
      'GRANT emdo_owner_bootstrap TO emdo_owner_bootstrap_login',
    );
    expect(provision).not.toContain("bootstrap_key = 'initial-owner-v1'");
    expect(provision).toContain(
      'ALTER ROLE emdo_owner_bootstrap_login NOLOGIN',
    );
    expect(provision).toContain('ALTER ROLE emdo_api_login LOGIN NOSUPERUSER');
    expect(provision).toContain(
      'ALTER ROLE emdo_onboarding_login LOGIN NOSUPERUSER',
    );
    expect(provision).toContain(
      'ALTER ROLE emdo_powersync_replication LOGIN NOSUPERUSER',
    );
    expect(provision).toContain(
      'ALTER ROLE emdo_powersync_storage LOGIN NOSUPERUSER',
    );
    expect(provision).toContain(
      'GRANT emdo_worker_executor TO emdo_worker_executor_login',
    );
    expect(provision).toContain(
      'GRANT emdo_worker_dispatch_executor TO emdo_worker_dispatcher_login',
    );
    expect(provision).toContain(
      'GRANT emdo_audio_reconciliation TO emdo_audio_reconciliation_login',
    );
    expect(provision).toContain(
      'GRANT emdo_onboarding TO emdo_onboarding_login',
    );
    expect(provision).toContain(
      'ALTER ROLE emdo_audio_reconciliation_login LOGIN NOSUPERUSER',
    );
    expect(provision).not.toContain(
      'GRANT emdo_worker_executor TO emdo_worker_login',
    );
    expect(provision).not.toContain(
      'GRANT emdo_worker_dispatch_executor TO emdo_worker_login',
    );
    expect(provision).not.toContain('GRANT emdo_worker TO emdo_worker_login');
    expect(provision).toMatch(
      /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA emdo FROM[\s\S]*?emdo_worker_login,[\s\S]*?emdo_worker_executor_login,[\s\S]*?emdo_worker_dispatcher_login/,
    );
    expect(provision).toMatch(
      /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA emdo FROM[\s\S]*?emdo_audio_reconciliation_login/,
    );
    expect(provision).toMatch(
      /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA pgboss FROM\s+emdo_worker_executor_login, emdo_worker_dispatcher_login,\s+emdo_audio_reconciliation_login;/,
    );
    expect(provision).toContain(
      'ALTER ROLE emdo_workflow_login LOGIN NOSUPERUSER',
    );
    expect(provision).not.toContain(
      'GRANT emdo_workflow TO emdo_workflow_login',
    );
    expect(initialization).toContain('CREATE ROLE emdo_workflow_login LOGIN');
    expect(initialization).toContain(
      'CREATE ROLE emdo_visual_decision_login LOGIN',
    );
    expect(provision).toContain(
      'ALTER ROLE emdo_visual_decision_login LOGIN NOSUPERUSER',
    );
    expect(provision).toContain(
      'emdo.commit_provider_proposal_decision(text, jsonb)\nTO emdo_visual_decision_login',
    );
    expect(provision).not.toMatch(
      /GRANT EXECUTE ON FUNCTION[^;]*commit_provider_proposal_create\(text, jsonb\)[^;]*TO emdo_visual_decision_login/,
    );
    expect(provision).not.toContain(
      'GRANT EXECUTE ON FUNCTION emdo.claim_workflow_operation_scope(text)',
    );
    for (const workflowAggregate of [
      'commit_provider_proposal_create(text, jsonb)',
      'commit_provider_proposal_decision(text, jsonb)',
      'commit_provider_proposal_prepare(text, jsonb)',
      'commit_provider_proposal_dispatch(text, jsonb)',
      'commit_provider_proposal_abandonment(jsonb)',
      'commit_provider_proposal_transition(jsonb)',
      'commit_provider_proposal_completion(jsonb)',
    ]) {
      expect(provision).toContain(`emdo.${workflowAggregate}`);
    }
    for (const objectClass of ['TABLES', 'SEQUENCES', 'FUNCTIONS']) {
      expect(provision).toMatch(
        new RegExp(
          `REVOKE ALL PRIVILEGES ON ALL ${objectClass} IN SCHEMA emdo FROM[\\s\\S]*?emdo_powersync_replication;`,
        ),
      );
    }
    expect(provision).toMatch(
      /REVOKE CONNECT ON DATABASE emdo_app FROM[\s\S]*?emdo_powersync_storage;/,
    );
    expect(provision).toMatch(
      /REVOKE CONNECT ON DATABASE emdo_powersync FROM[\s\S]*?emdo_owner_bootstrap_login;/,
    );
  });

  it('publishes canonical offline entities through claim-scoped private and shared streams', async () => {
    const [provision, rules] = await Promise.all([
      read('infra/compose/provision-runtime.sql'),
      read('infra/powersync/sync-rules.yaml'),
    ]);

    expect(provision).toMatch(
      /GRANT SELECT ON[\s\S]*?emdo\.sync_entities,[\s\S]*?TO emdo_powersync_replication;/,
    );
    expect(provision).toContain(
      'ALTER TABLE emdo.sync_entities REPLICA IDENTITY FULL;',
    );
    expect(provision).toMatch(
      /ALTER PUBLICATION powersync SET TABLE[\s\S]*?emdo\.sync_entities,/,
    );
    expect(rules.match(/FROM "emdo"\."sync_entities" AS se/g)).toHaveLength(2);
    expect(rules).toMatch(
      /FROM "emdo"\."sync_entities" AS se\n\s+WHERE se\.space_id IN authorized_private_spaces/,
    );
    expect(rules).toMatch(
      /FROM "emdo"\."sync_entities" AS se\n\s+WHERE se\.space_id IN authorized_shared_spaces/,
    );
    const entityQueries = [
      ...rules.matchAll(
        /^ {6}- \|\n {8}SELECT\n((?: {10}se\.[a-z_]+,?\n)+) {8}FROM "emdo"\."sync_entities" AS se\n {8}WHERE se\.space_id IN authorized_(?:private|shared)_spaces$/gm,
      ),
    ];
    expect(entityQueries).toHaveLength(2);
    for (const query of entityQueries) {
      const projectedColumns = query[1]
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.startsWith('se.'));
      expect(projectedColumns).toEqual([
        'se.id',
        'se.household_id',
        'se.space_id',
        'se.original_owner_user_id',
        'se.entity_type',
        'se.entity_id',
        'se.payload',
        'se.actor_intent',
        'se.revision',
        'se.tombstoned_at',
        'se.created_at',
        'se.updated_at',
      ]);
    }
    expect(rules).toContain('m.user_id = auth.user_id()');
    expect(rules).not.toMatch(
      /auth\.parameters|request\.parameters|household_id\s*=\s*auth\./,
    );
    expect(rules).not.toMatch(/SELECT\s+\*/);
  });
});

describe('host deployment and recovery scripts', () => {
  it('bounds logical-replication WAL and installs a persistent pressure alert', async () => {
    const [
      compose,
      monitor,
      dispatcher,
      preparation,
      service,
      timer,
      operations,
    ] = await Promise.all([
      read('infra/compose/compose.yml'),
      read('infra/scripts/check-replication-pressure.sh'),
      read('infra/scripts/dispatch-active-release.sh'),
      read('infra/scripts/prepare-host.sh'),
      read('infra/systemd/emdo-replication-pressure.service'),
      read('infra/systemd/emdo-replication-pressure.timer'),
      read('docs/deployment/operations.md'),
    ]);

    expect(compose).toContain('max_slot_wal_keep_size=2048MB');
    expect(monitor).toContain('MAX_WAL_LAG_BYTES=1610612736');
    expect(monitor).toContain('MIN_DOCKER_FREE_KIB=10485760');
    expect(monitor).toContain('pg_replication_slots');
    expect(monitor).toContain("current_setting('max_slot_wal_keep_size')");
    expect(monitor).toContain('logical replication slot is inactive');
    expect(monitor).toContain('logical replication lag exceeds 1.5 GiB');
    expect(monitor).toContain('Docker storage has less than 10 GiB free');
    expect(monitor).toContain(
      'replication-pressure check must execute the assets bound to current production state',
    );
    expect(dispatcher).toContain(
      "check-replication-pressure) relative_entrypoint='infra/scripts/check-replication-pressure.sh'",
    );
    expect(preparation).toContain('emdo-replication-pressure.service');
    expect(preparation).toContain('emdo-replication-pressure.timer');
    expect(timer).toContain('OnUnitActiveSec=15m');
    expect(timer).toContain('Persistent=true');
    expect(service).toContain(
      'ExecStart=/usr/local/sbin/emdo-dispatch-active-release check-replication-pressure',
    );
    expect(service).toContain('ReadOnlyPaths=/var/lib/emdo /etc/emdo');
    expect(operations).toContain('max_slot_wal_keep_size');
    expect(operations).toContain('PowerSync full resync');
    expect(operations).not.toContain('raise the WAL cap until');
  });

  it('limits staging SSH root access to a fixed signed-release operator', async () => {
    const [operator, preparation, stagingWorkflow, sweeperTimer] =
      await Promise.all([
        read('infra/scripts/staging-operator.sh'),
        read('infra/scripts/prepare-host.sh'),
        read('.github/workflows/staging.yml'),
        read('infra/systemd/emdo-staging-sweeper.timer'),
      ]);

    expect(operator).toContain('openssl pkeyutl -verify');
    expect(operator).toContain('emdo-release-assets-v1');
    expect(operator).toContain('release descriptor purpose is not staging');
    expect(operator).toContain('image lock contains a mutable');
    expect(operator).toContain('STATUS=');
    expect(operator).toContain('staging release has already been consumed');
    expect(operator).toContain(
      'signed release archive contains a path traversal',
    );
    expect(preparation).toContain('EMDO_RELEASE_ASSET_PUBLIC_KEY_FILE');
    expect(preparation).toContain('/etc/sudoers.d/emdo-staging-operator');
    expect(preparation).toContain('visudo -cf');
    expect(preparation).toContain(
      'systemctl enable --now emdo-staging-sweeper.timer',
    );
    expect(stagingWorkflow).not.toMatch(/sudo\s+(?:tar|env|cat)\b/);
    expect(sweeperTimer).toContain('Persistent=true');
  });

  it('exposes initial owner creation only through the protected single-use operator path', async () => {
    const [dockerfile, compose, bootstrap, bootstrapMigration] =
      await Promise.all([
        read('Dockerfile'),
        read('infra/compose/compose.yml'),
        read('infra/scripts/bootstrap-production-owner.sh'),
        read('packages/db/drizzle/0002_owner_bootstrap.sql'),
      ]);

    expect(dockerfile).toContain('apps/api/dist/cli/bootstrap-owner.js');
    expect(dockerfile).toContain("import('./dist/cli/bootstrap-owner.js')");
    expect(compose).toMatch(/^ {2}owner-bootstrap:$/m);
    expect(compose).toMatch(
      /owner-bootstrap:[\s\S]*?profiles: \[owner-bootstrap\][\s\S]*?owner-bootstrap\.env[\s\S]*?bootstrap-initial-owner-v1/,
    );
    expect(compose).not.toMatch(/api:[\s\S]*?owner-bootstrap\.env/);
    expect(compose).not.toMatch(/worker:[\s\S]*?owner-bootstrap\.env/);
    expect(bootstrap).toContain('PRODUCTION_OWNER_BOOTSTRAP_APPROVED');
    expect(bootstrap).toContain('assert_deployed_release_lock');
    expect(bootstrap).toContain('assert_production_healthy');
    expect(bootstrap).toContain('must contain exactly six keys');
    expect(bootstrap).toContain(
      'ALTER ROLE emdo_owner_bootstrap_login NOLOGIN',
    );
    expect(bootstrap).toContain('rm -- "$bootstrap_environment"');
    expect(bootstrap).toContain('owner-bootstrap-complete');
    expect(bootstrapMigration).toContain("bootstrap_key = 'initial-owner-v1'");
    expect(bootstrapMigration).toContain("state = 'complete'");
    expect(bootstrapMigration).toContain('email_verified');
  });

  it('fails staging preflight below capacity or while production is unhealthy', async () => {
    const script = await read('infra/scripts/preflight-staging.sh');

    expect(script).toContain('MIN_AVAILABLE_MEMORY_KIB=1835008');
    expect(script).toContain('MIN_FREE_DISK_KIB=10485760');
    expect(script).toContain('assert_production_healthy');
    expect(script).toContain('INITIAL_STAGING_BOOTSTRAP');
    expect(script).toContain('assert_initial_production_absent');
    expect(script).toContain('/proc/meminfo');
    expect(script).toContain('df -Pk');
  });

  it('uses exact locks, persists staging expiry, gates snapshots and supports rollback', async () => {
    const [
      common,
      staging,
      stagingCompose,
      sweeper,
      acceptance,
      production,
      rollback,
    ] = await Promise.all([
      read('infra/scripts/_common.sh'),
      read('infra/scripts/deploy-staging.sh'),
      read('infra/compose/compose.staging.yml'),
      read('infra/scripts/cleanup-expired-staging.sh'),
      read('infra/scripts/run-staging-acceptance.sh'),
      read('infra/scripts/deploy-production.sh'),
      read('infra/scripts/rollback.sh'),
    ]);

    expect(common).toContain('@sha256:');
    expect(common).toContain('assert_digest_lock');
    expect(common).toContain("'{{.Config.Image}}'");
    expect(staging).toContain('expires-at-epoch');
    expect(staging).not.toContain('systemd-run');
    expect(sweeper).toContain('emdo-staging-operator teardown');
    expect(sweeper).toContain('deadline_epoch');
    expect(staging).toContain('synthetic-data');
    expect(staging).toContain('assert_staging_secret_manifest "$SECRETS_DIR"');
    expect(acceptance).toContain('staging-acceptance');
    expect(acceptance).toContain(
      'assert_staging_secret_manifest "$SECRETS_DIR"',
    );
    expect(acceptance).toContain('acceptance-passed-at');
    expect(acceptance).toContain(
      'EMDO_STAGING_SOURCE_SHA="$IMAGE_LOCK_SOURCE_SHA"',
    );
    expect(acceptance).toContain('EMDO_STAGING_WORKFLOW_RUN_ID="$run_id"');
    expect(stagingCompose).toContain('--forbid-worker-provider-execution');
    expect(acceptance).not.toContain('"gate":"http-api-subset"');
    expect(common).toContain('assert_env_file_allowed_keys');
    expect(common).toContain('assert_internal_postgres_uri');
    expect(common).toContain('assert_staging_auth_provider_config');
    const stagingManifest = common.slice(
      common.indexOf('assert_staging_secret_manifest()'),
      common.indexOf('assert_production_secret_manifest()'),
    );
    expect(stagingManifest).not.toContain('EMDO_CREDENTIAL_VAULT_KEY');
    expect(stagingManifest).not.toContain(
      'EMDO_GOOGLE_CALENDAR_VAULT_KEYRING_B64URL',
    );
    expect(stagingManifest).not.toContain(
      'EMDO_GOOGLE_CALENDAR_OAUTH_CLIENT_ID',
    );
    expect(stagingManifest).not.toContain(
      'EMDO_GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET',
    );
    expect(stagingManifest).not.toContain(
      'EMDO_GOOGLE_CALENDAR_OAUTH_STATE_SIGNING_KEY_B64URL',
    );
    expect(staging).toContain('assert_isolated_project_absent');
    expect(staging.indexOf('expires-at-epoch')).toBeLessThan(
      staging.indexOf('staging_compose pull'),
    );
    expect(staging.lastIndexOf('expires-at-epoch')).toBeGreaterThan(
      staging.indexOf('wait_for_compose_healthy'),
    );
    expect(production).toContain('assert_production_public_config');
    expect(production).toContain("--proto '=https'");
    expect(production).toContain('HOSTINGER_SNAPSHOT_REFERENCE');
    expect(production).toContain('HOSTINGER_SNAPSHOT_CONFIRMED_AT');
    expect(production).toContain('assert_staging_attestation_matches');
    expect(production).toContain('assert_base_secret_manifest "$SECRETS_DIR"');
    expect(production).toContain(
      'assert_infrastructure_promotion_unchanged "$current_lock" "$candidate_lock"',
    );
    expect(production).toContain(
      'current_release_root="${IMAGE_LOCK_DEPLOYED_RELEASE_DIR}"',
    );
    expect(production).toContain(
      'current_backup_script="$current_release_root/infra/scripts/backup-logical.sh"',
    );
    expect(production).toContain('"$current_backup_script"');
    expect(production).not.toContain('"$SCRIPT_DIR/backup-logical.sh"');
    expect(production).toContain('run --rm migrate');
    expect(production).toContain(
      'ordinary application promotion cannot change Compose, Caddy, PowerSync',
    );
    expect(common).toContain('acquire_host_lock');
    expect(common).toContain('assert_no_active_staging_state');
    expect(production).toContain('resuming the exact failed initial candidate');
    expect(production).toContain('exact pending image lock');
    expect(production).toContain('byte-identical reviewed deployment assets');
    expect(rollback).toContain('previous.env');
    expect(rollback).toContain('ROLLBACK_SCHEMA_COMPATIBLE');
    expect(rollback).toContain('ROLLBACK_POSTGRES_IMAGE');
    expect(rollback).toContain('assert_base_secret_manifest "$SECRETS_DIR"');
    expect(common).toContain('DEPLOYED_RELEASE_SOURCE_SHA');
    expect(common).toContain('docker volume ls --quiet --filter');
    expect(common).toContain('docker network ls --quiet --filter');
    expect(rollback).toContain('ROLLBACK_DEPLOYED_RELEASE_SOURCE_SHA');
    expect(rollback).toContain('mv -- "$rollback_lock" "$current_lock"');
    expect(rollback).not.toContain('pull api worker web powersync caddy');
    expect(rollback).toContain('docker image inspect "$expected_image"');
    expect(rollback).toContain('production_compose pull "$service"');
    expect(rollback).toContain('run --rm caddy-init');
    expect(rollback).toContain('up --detach --remove-orphans');
    expect(rollback).not.toContain('up --detach --no-deps api worker web');
  });

  it('encrypts logical backups and makes restore drills staging-only', async () => {
    const [backup, restore] = await Promise.all([
      read('infra/scripts/backup-logical.sh'),
      read('infra/scripts/restore-drill.sh'),
    ]);

    expect(backup).toContain('pg_dump');
    expect(backup).toContain('age --encrypt');
    expect(backup).toContain('sha256sum');
    expect(backup).toContain('BACKUP_AGE_RECIPIENTS_FILE');
    expect(backup).toContain('assert_base_secret_manifest "$SECRETS_DIR"');
    expect(backup).toContain('backup output already exists');
    expect(backup).toContain('.age.complete');
    expect(backup).toContain(
      'backup must execute the assets bound to current production state',
    );
    expect(restore).toContain('RESTORE_TARGET_ENVIRONMENT');
    expect(restore).toContain('assert_base_secret_manifest "$SECRETS_DIR"');
    expect(restore).toContain(
      'RESTORE_IMAGE_LOCK_FILE must be the governed images.env file',
    );
    expect(restore).toContain(
      'assert_directory_within "$digest_lock_directory" "$SECRETS_DIR"',
    );
    expect(restore).toContain(
      'assert_root_owned_bounded_file "$digest_lock" 600 32768',
    );
    expect(restore).toContain('emdo-restore-');
    expect(restore).toContain('age --decrypt');
    expect(restore).toContain('pg_restore');
    expect(restore).toContain(
      'checksum record does not name the selected backup',
    );
    expect(restore).toContain('sha256sum --check --strict -');
    expect(restore).toContain('duplicate archive entry');
    expect(restore).toContain('tar --extract --to-stdout');
    expect(restore).not.toContain(
      'tar --extract --file "$bundle_file" --directory',
    );
    expect(restore).toContain('assert_isolated_project_absent');
    expect(restore).toMatch(
      /run --rm migrate[\s\S]*pg_restore[\s\S]*run --rm migrate/,
    );
    expect(restore.match(/run --rm job-schema/g)).toHaveLength(2);
    expect(restore).toContain('"$backup_name"');
    expect(restore).toContain('"$recorded_digest"');
  });
});

describe('GitHub delivery policy', () => {
  it('keeps CI non-deploying and publishes SHA images only from main', async () => {
    const [ci, publish] = await Promise.all([
      read('.github/workflows/ci.yml'),
      read('.github/workflows/publish.yml'),
    ]);

    expect(ci).toContain('pull_request:');
    expect(ci).not.toMatch(/deploy-(?:staging|production)\.sh/);
    expect(ci).toContain('docker/build-push-action@');
    expect(ci).toContain('browser-production-preview:');
    expect(ci).toContain('agent-evals:');
    expect(ci).toContain('acceptance-ci-receipts:');
    expect(ci).toContain('acceptance-ci-receipts');
    expect(ci).toContain('owner_bootstrap_database_password');
    expect(ci).toContain('onboarding_database_password');
    expect(ci).toContain('synthetic-bootstrap.env');
    expect(ci).toContain('export EMDO_STAGING_SOURCE_SHA="$SOURCE_SHA"');
    expect(ci).toContain(
      'export EMDO_STAGING_WORKFLOW_RUN_ID="$STAGING_RUN_ID"',
    );
    expect(ci).toContain('pnpm --filter @emdo/agent-core test:package');
    expect(publish).toMatch(/push:\n\s+branches: \[main\]/);
    expect(publish).not.toContain('pull_request:');
    expect(publish).toContain('sha-${{ github.sha }}');
    expect(publish).toContain('steps.build.outputs.digest');
    expect(publish).toContain('release-images');
    expect(publish).not.toContain('id-token: write');

    for (const workflow of [ci, publish]) {
      expect(workflow).not.toMatch(/uses:\s+[^\s]+@v\d+(?:\s|$)/);
    }
  });

  it('allows only manual, synthetic staging and exact protected production promotion', async () => {
    const [staging, production] = await Promise.all([
      read('.github/workflows/staging.yml'),
      read('.github/workflows/production.yml'),
    ]);

    expect(staging).toContain('workflow_dispatch:');
    expect(staging).not.toMatch(/^\s+push:/m);
    expect(staging).toContain('/usr/local/sbin/emdo-staging-operator deploy');
    expect(staging).toContain('/usr/local/sbin/emdo-staging-operator accept');
    expect(staging).toContain('EMDO_SYNTHETIC_DATA_ONLY: true');
    expect(staging).toContain('initial_deployment:');
    expect(staging).toContain(
      'INITIAL_STAGING_BOOTSTRAP: ${{ inputs.initial_deployment }}',
    );
    expect(staging).toContain(
      '[[ "$INITIAL_STAGING_BOOTSTRAP" == true || "$INITIAL_STAGING_BOOTSTRAP" == false ]]',
    );
    expect(staging).toContain('staging-tested-images');
    expect(staging).toContain('if: always()');
    expect(staging).toContain('PUBLISH_RUN_ID: ${{ inputs.publish_run_id }}');
    expect(staging).toContain('CI_RUN_ID: ${{ inputs.ci_run_id }}');
    expect(staging).toContain("run.path !== '.github/workflows/ci.yml'");
    expect(staging).toContain('assemble-acceptance-evidence.mjs');
    expect(staging).toContain('write-staging-http-receipt.mjs');
    expect(staging).toContain('--probe release/staging-http-subset-probe.json');
    expect(staging).toContain('--image-lock release/release-images.env');
    expect(staging).not.toContain('write-acceptance-descriptor.mjs');
    expect(staging).toContain('sign-acceptance-evidence.mjs');
    expect(staging).toContain('validate-acceptance-evidence.mjs');
    expect(staging).toContain('acceptance-evidence.json.sha256');
    expect(staging).toContain("--mtime='@0'");
    expect(staging).toContain("--use-compress-program='gzip -n'");
    expect(staging).not.toContain("Number('${{ inputs.publish_run_id }}')");
    expect(staging).toContain('RELEASE_ASSET_SIGNING_PRIVATE_KEY');
    expect(staging).toContain('id: release_assets');
    expect(staging).toContain('archive_sha256=%s');
    expect(staging).toContain('STAGING_INFRA_ARCHIVE_SHA256=%s');
    expect(staging).toContain(
      '${{ steps.release_assets.outputs.archive_sha256 }}',
    );
    expect(staging).toContain('openssl pkeyutl -sign');
    expect(staging).toContain('/usr/local/sbin/emdo-staging-operator install');
    expect(staging).toContain('/usr/local/sbin/emdo-staging-operator deploy');
    expect(staging).toContain('/usr/local/sbin/emdo-staging-operator accept');
    expect(staging).toContain('/usr/local/sbin/emdo-staging-operator teardown');
    expect(staging).not.toContain('sudo tar');
    expect(staging).not.toContain('sudo env');
    expect(production).toContain('workflow_dispatch:');
    expect(production).toContain('environment: production');
    expect(production).toContain('expected_image_lock_sha256:');
    expect(production).toMatch(
      /^ {2}prepare_production:\n[\s\S]*?^ {2}production:\n/m,
    );
    expect(production).toMatch(
      /^ {2}production:\n\s+needs: prepare_production\n\s+name: Approve exact /m,
    );
    expect(production).toMatch(
      /name: Upload immutable production plan[\s\S]*?name: production-deployment-plan/,
    );
    expect(production).toMatch(
      /name: Download immutable production plan[\s\S]*?name: production-deployment-plan/,
    );
    expect(production).toContain(
      'EXPECTED_IMAGE_LOCK_DIGEST: ${{ inputs.expected_image_lock_sha256 }}',
    );
    expect(production).toContain('plan_image_lock_sha256=');
    expect(production).toContain('staging_infra_archive_sha256=');
    expect(production).toContain('infra_archive_sha256=');
    expect(production).toContain(
      'EXPECTED_INFRA_ARCHIVE_SHA256: ${{ needs.prepare_production.outputs.staging_infra_archive_sha256 }}',
    );
    expect(production).toContain(
      '[[ "$archive_digest" == "$EXPECTED_INFRA_ARCHIVE_SHA256" ]]',
    );
    expect(production).toContain('staging_run_id');
    expect(production).toContain('initial_bootstrap_acknowledged:');
    expect(production).toContain('INITIAL_BOOTSTRAP_ACKNOWLEDGED=');
    expect(production).toContain(
      'STAGING_WORKFLOW_RUN_ID=$SELECTED_STAGING_RUN_ID',
    );
    expect(production).toContain('staging-tested-images');
    expect(production).toContain('ACCEPTANCE_EVIDENCE_PUBLIC_KEY');
    expect(production).toContain('validate-acceptance-evidence.mjs');
    expect(production).toMatch(
      /Validate signed complete release acceptance evidence[\s\S]*?EXPECTED_EVIDENCE_DIGEST: \$\{\{ inputs\.expected_acceptance_evidence_sha256 \}\}/,
    );
    expect(production).toContain("run.path !== '.github/workflows/ci.yml'");
    expect(production).toContain('deploy-production.sh');
    expect(production).toContain('rollback.sh');
    expect(production).toContain(
      'STAGING_RUN_ID: ${{ inputs.staging_run_id }}',
    );
    expect(production).not.toContain("Number('${{ inputs.staging_run_id }}')");
    expect(production).toContain('/var/lib/emdo/deployments/current.env');
    expect(production).toContain('DEPLOYED_RELEASE_DIR=');
    expect(production).toContain("--mtime='@0'");
    expect(production).toContain("--use-compress-program='gzip -n'");
    expect(production).not.toContain(
      "sudo install -o 0 -g 0 -m 0755 '$release/infra/scripts/dispatch-active-release.sh'",
    );
    expect(production).not.toMatch(
      /actions\/checkout@[^\n]+\n\s+if: inputs\.operation == 'rollback'/,
    );

    for (const workflow of [staging, production]) {
      expect(workflow).not.toMatch(/uses:\s+[^\s]+@v\d+(?:\s|$)/);
      expect(workflow).toContain('persist-credentials: false');
    }
  });
});

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const rootPath = fileURLToPath(new URL('../../', import.meta.url));
const commonPath = join(rootPath, 'infra/scripts/_common.sh');

const digest = (character: string): string => character.repeat(64);
const sourceSha = 'b'.repeat(40);
const infrastructureSourceSha = 'c'.repeat(40);
const validOpenAiAudioPricing = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    pricingVersion: 'deployment-2026-08-15',
    transcriptionCadMicrosPerMinute: {
      'gpt-4o-mini-transcribe': 10_000_000,
      'gpt-4o-transcribe': 20_000_000,
    },
    speechCadMicrosPerMillionCharacters: {
      'tts-1': 10_000_000,
      'tts-1-hd': 20_000_000,
      'gpt-4o-mini-tts': 30_000_000,
      'gpt-4o-mini-tts-2025-12-15': 40_000_000,
    },
  }),
).toString('base64url');
const validExperienceCursorKeyring = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    current: {
      keyId: 'experience.current-1',
      keyB64url: Buffer.alloc(32, 17).toString('base64url'),
    },
    previous: [],
  }),
).toString('base64url');
const validStagingCoreApiEnvironment = [
  'EMDO_PUBLIC_ORIGIN=https://staging.example.invalid',
  'EMDO_API_DATABASE_URL=postgresql://emdo_api_login:fixture@postgres:5432/emdo_app?sslmode=disable',
  'EMDO_AUTH_DATABASE_URL=postgresql://emdo_auth_login:fixture@postgres:5432/emdo_app?sslmode=disable',
  'EMDO_VISUAL_DECISION_DATABASE_URL=postgresql://emdo_visual_decision_login:fixture@postgres:5432/emdo_app?sslmode=disable',
  `EMDO_API_AUTH_SECRET=${'A'.repeat(43)}`,
  `EMDO_SESSION_SECRET=${'B'.repeat(43)}`,
  `EMDO_EXPERIENCE_CURSOR_HMAC_KEYRING_B64URL=${validExperienceCursorKeyring}`,
];

const validLock = (overrides: Readonly<Record<string, string>> = {}): string =>
  [
    `SOURCE_SHA=${overrides.SOURCE_SHA ?? sourceSha}`,
    `API_IMAGE=${overrides.API_IMAGE ?? `ghcr.io/panic80/emdo-api@sha256:${digest('1')}`}`,
    `WORKER_IMAGE=${overrides.WORKER_IMAGE ?? `ghcr.io/panic80/emdo-worker@sha256:${digest('2')}`}`,
    `WEB_IMAGE=${overrides.WEB_IMAGE ?? `ghcr.io/panic80/emdo-web@sha256:${digest('3')}`}`,
    `POSTGRES_IMAGE=${overrides.POSTGRES_IMAGE ?? `pgvector/pgvector@sha256:${digest('4')}`}`,
    `POWERSYNC_IMAGE=${overrides.POWERSYNC_IMAGE ?? `journeyapps/powersync-service@sha256:${digest('5')}`}`,
    `CADDY_IMAGE=${overrides.CADDY_IMAGE ?? `caddy@sha256:${digest('6')}`}`,
  ].join('\n');

const runCommon = (
  command: string,
  ...arguments_: readonly string[]
): ReturnType<typeof spawnSync> =>
  spawnSync(
    'bash',
    ['-c', `source "$1"; ${command}`, '_', commonPath, ...arguments_],
    {
      encoding: 'utf8',
    },
  );

describe('deployment script trust boundaries', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'emdo-infra-test-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('accepts complete immutable image locks', async () => {
    const lockPath = join(directory, 'images.env');
    await writeFile(lockPath, `${validLock()}\n`, { mode: 0o600 });

    const result = runCommon('assert_digest_lock "$2"', lockPath);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it.each([
    ['mutable tag', { API_IMAGE: 'ghcr.io/panic80/emdo-api:latest' }],
    [
      'placeholder digest',
      {
        POSTGRES_IMAGE: `pgvector/pgvector@sha256:${digest('0')}`,
      },
    ],
    ['abbreviated source', { SOURCE_SHA: 'deadbeef' }],
    [
      'unapproved repository',
      {
        API_IMAGE: `ghcr.io/example/emdo-api@sha256:${digest('1')}`,
      },
    ],
  ])('rejects a %s', async (_label, override) => {
    const lockPath = join(directory, 'images.env');
    await writeFile(lockPath, `${validLock(override)}\n`, { mode: 0o600 });

    const result = runCommon('assert_digest_lock "$2"', lockPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ERROR:');
  });

  it('rejects duplicate and unrecognized lock keys', async () => {
    const duplicatePath = join(directory, 'duplicate.env');
    const unknownPath = join(directory, 'unknown.env');
    await writeFile(
      duplicatePath,
      `${validLock()}\nAPI_IMAGE=ghcr.io/panic80/emdo-api@sha256:${digest('a')}\n`,
    );
    await writeFile(
      unknownPath,
      `${validLock()}\nDATABASE_URL=do-not-accept\n`,
    );

    expect(runCommon('assert_digest_lock "$2"', duplicatePath).status).not.toBe(
      0,
    );
    expect(runCommon('assert_digest_lock "$2"', unknownPath).status).not.toBe(
      0,
    );
  });

  it('parses deployment config values as data without shell evaluation', async () => {
    const markerPath = join(directory, 'must-not-exist');
    const configPath = join(directory, 'deployment.env');
    const payload = `$(touch ${markerPath})`;
    await writeFile(
      configPath,
      [
        `EMDO_DOMAIN=${payload}`,
        'ACME_EMAIL=test@example.invalid',
        'POWERSYNC_JWKS_URI=https://example.invalid/.well-known/jwks.json',
        `SECRETS_DIR=${directory}`,
      ].join('\n'),
    );

    const result = runCommon(
      'load_deployment_config "$2"; printf "%s" "$DEPLOY_CONFIG_EMDO_DOMAIN"',
      configPath,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(payload);
    expect(
      spawnSync('test', ['-e', markerPath], { encoding: 'utf8' }).status,
    ).not.toBe(0);
  });

  it('rejects canonical directory escapes and invalid staging ports', async () => {
    const stagingRoot = join(directory, 'staging');
    const productionRoot = join(directory, 'production');
    await mkdir(stagingRoot);
    await mkdir(productionRoot);

    const escaped = runCommon(
      'assert_directory_within "$2/../production" "$2" TEST_DIRECTORY',
      stagingRoot,
    );
    const invalidPort = runCommon('assert_unprivileged_tcp_port "$2"', '443');

    expect(escaped.status).not.toBe(0);
    expect(escaped.stderr).toContain('must resolve within');
    expect(invalidPort.status).not.toBe(0);
    expect(invalidPort.stderr).toContain('between 1024 and 65535');
  });

  it('rejects a secret manifest file that escapes through a symlink', async () => {
    const stagingRoot = join(directory, 'staging');
    const productionRoot = join(directory, 'production');
    await mkdir(stagingRoot, { mode: 0o700 });
    await mkdir(productionRoot, { mode: 0o700 });
    const productionSecret = join(productionRoot, 'api.env');
    await writeFile(productionSecret, 'PRODUCTION_SECRET=not-for-staging\n', {
      mode: 0o600,
    });
    await symlink(productionSecret, join(stagingRoot, 'api.env'));

    const result = runCommon(
      'assert_secret_file_manifest "$2" api.env',
      stagingRoot,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('required regular file is missing');
  });

  it('rejects provider credentials and non-internal staging database targets', async () => {
    const workerEnvironment = join(directory, 'worker.env');
    await writeFile(
      workerEnvironment,
      [
        'EMDO_WORKER_DATABASE_URL=postgresql://emdo_worker_login:fixture@postgres:5432/emdo_app?sslmode=disable',
        'EMDO_APPLICATION_ORIGIN=https://staging.example.invalid',
        'OPENAI_API_KEY=must-not-enter-staging',
      ].join('\n'),
    );

    const providerCredential = runCommon(
      'assert_env_file_allowed_keys "$2" EMDO_WORKER_DATABASE_URL EMDO_APPLICATION_ORIGIN',
      workerEnvironment,
    );
    expect(providerCredential.status).not.toBe(0);
    expect(providerCredential.stderr).toContain(
      'non-allowlisted environment key',
    );

    await writeFile(
      workerEnvironment,
      'EMDO_WORKER_DATABASE_URL=postgresql://emdo_worker_login:fixture@production-db:5432/emdo_app?sslmode=disable\n',
    );
    const escapedDatabase = runCommon(
      'assert_internal_postgres_uri "$2" EMDO_WORKER_DATABASE_URL emdo_worker_login emdo_app',
      workerEnvironment,
    );
    expect(escapedDatabase.status).not.toBe(0);
    expect(escapedDatabase.stderr).toContain('internal PostgreSQL target');

    await writeFile(
      workerEnvironment,
      'EMDO_WORKER_DATABASE_URL=postgresql://emdo_worker_login:fixture@postgres:5432/emdo_app?sslmode=disable\n',
    );
    expect(
      runCommon(
        'assert_internal_postgres_uri "$2" EMDO_WORKER_DATABASE_URL emdo_worker_login emdo_app',
        workerEnvironment,
      ).status,
    ).toBe(0);
  });

  it('accepts only an all-or-nothing production OpenAI audio configuration', async () => {
    const apiEnvironment = join(directory, 'api.env');
    const valid = [
      'EMDO_OPENAI_AUDIO_API_KEY=sk_audio_production_fixture_0123456789',
      'EMDO_OPENAI_SPEECH_MODEL=tts-1',
      `EMDO_OPENAI_AUDIO_PRICING_B64URL=${validOpenAiAudioPricing}`,
    ];
    await writeFile(apiEnvironment, `${valid.join('\n')}\n`);

    const accepted = runCommon(
      'assert_production_api_environment "$2"',
      apiEnvironment,
    );
    expect(accepted.status).toBe(0);
    expect(accepted.stderr).toBe('');

    for (const invalid of [
      valid.slice(0, 2),
      valid.map((line) =>
        line.startsWith('EMDO_OPENAI_SPEECH_MODEL=')
          ? 'EMDO_OPENAI_SPEECH_MODEL=gpt-4o-tts'
          : line,
      ),
      valid.map((line) =>
        line.startsWith('EMDO_OPENAI_AUDIO_PRICING_B64URL=')
          ? 'EMDO_OPENAI_AUDIO_PRICING_B64URL=not+base64url'
          : line,
      ),
      [...valid, 'OPENAI_API_KEY=must-not-be-admitted'],
    ]) {
      await writeFile(apiEnvironment, `${invalid.join('\n')}\n`);
      const rejected = runCommon(
        'assert_production_api_environment "$2"',
        apiEnvironment,
      );
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).not.toContain('must-not-be-admitted');
      expect(rejected.stderr).not.toContain(
        'sk_audio_production_fixture_0123456789',
      );
    }

    await writeFile(apiEnvironment, 'EMDO_PUBLIC_ORIGIN=https://example.ca\n');
    expect(
      runCommon('assert_production_api_environment "$2"', apiEnvironment)
        .status,
    ).toBe(0);
  });

  it.each([
    'EMDO_OPENAI_AUDIO_API_KEY',
    'EMDO_OPENAI_SPEECH_MODEL',
    'EMDO_OPENAI_AUDIO_PRICING_B64URL',
  ])('rejects %s from synthetic staging API secrets', async (forbiddenKey) => {
    const apiEnvironment = join(directory, 'api.env');
    const valid = validStagingCoreApiEnvironment;
    await writeFile(apiEnvironment, `${valid.join('\n')}\n`);
    expect(
      runCommon('assert_staging_api_environment "$2"', apiEnvironment).status,
    ).toBe(0);

    await writeFile(
      apiEnvironment,
      `${[...valid, `${forbiddenKey}=synthetic-stage-secret-canary`].join('\n')}\n`,
    );
    const rejected = runCommon(
      'assert_staging_api_environment "$2"',
      apiEnvironment,
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).not.toContain('synthetic-stage-secret-canary');
  });

  it('accepts a core-only staging API environment and rejects optional provider bundles', async () => {
    const apiEnvironment = join(directory, 'api.env');
    const core = validStagingCoreApiEnvironment;
    await writeFile(apiEnvironment, `${core.join('\n')}\n`);
    expect(
      runCommon('assert_staging_api_environment "$2"', apiEnvironment).status,
    ).toBe(0);

    for (const requiredKey of [
      'EMDO_API_AUTH_SECRET',
      'EMDO_SESSION_SECRET',
      'EMDO_EXPERIENCE_CURSOR_HMAC_KEYRING_B64URL',
    ]) {
      await writeFile(
        apiEnvironment,
        `${core.filter((line) => !line.startsWith(`${requiredKey}=`)).join('\n')}\n`,
      );
      expect(
        runCommon('assert_staging_api_environment "$2"', apiEnvironment).status,
      ).not.toBe(0);
    }

    await writeFile(apiEnvironment, `${core.join('\n')}\n`);

    for (const optionalLine of [
      'EMDO_GOOGLE_IDENTITY_CLIENT_ID=123456789012-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com',
      'EMDO_GOOGLE_IDENTITY_CLIENT_SECRET=staging-google-client-secret',
      'EMDO_ONBOARDING_DATABASE_URL=postgresql://emdo_onboarding_login:fixture@postgres:5432/emdo_app?sslmode=disable',
      'EMDO_RESEND_AUTH_API_KEY=re_staging_auth_provider_key_0123456789',
      'EMDO_RESEND_FROM_EMAIL=auth@staging.emdo.invalid',
      'EMDO_TRANSACTIONAL_EMAIL_PROVIDER=resend',
    ]) {
      await writeFile(
        apiEnvironment,
        `${[...core, optionalLine].join('\n')}\n`,
      );
      const rejected = runCommon(
        'assert_staging_api_environment "$2"',
        apiEnvironment,
      );
      expect(rejected.status).not.toBe(0);
    }
  });

  it('requires the dedicated internal audio reconciliation login', async () => {
    const workerEnvironment = join(directory, 'worker.env');
    await writeFile(
      workerEnvironment,
      'EMDO_AUDIO_RECONCILIATION_DATABASE_URL=postgresql://emdo_worker_executor_login:fixture@postgres:5432/emdo_app?sslmode=disable\n',
    );

    const sharedExecutor = runCommon(
      'assert_internal_postgres_uri "$2" EMDO_AUDIO_RECONCILIATION_DATABASE_URL emdo_audio_reconciliation_login emdo_app',
      workerEnvironment,
    );
    expect(sharedExecutor.status).not.toBe(0);

    await writeFile(
      workerEnvironment,
      'EMDO_AUDIO_RECONCILIATION_DATABASE_URL=postgresql://emdo_audio_reconciliation_login:fixture@postgres:5432/emdo_app?sslmode=disable\n',
    );
    expect(
      runCommon(
        'assert_internal_postgres_uri "$2" EMDO_AUDIO_RECONCILIATION_DATABASE_URL emdo_audio_reconciliation_login emdo_app',
        workerEnvironment,
      ).status,
    ).toBe(0);
  });

  it('requires the dedicated bounded finance-import retention environment', async () => {
    const environment = join(directory, 'finance-import-retention.env');
    const valid = [
      'EMDO_FINANCE_IMPORT_RETENTION_DATABASE_URL=postgresql://emdo_finance_import_retention_login:fixture@postgres:5432/emdo_app?sslmode=disable',
      'EMDO_FINANCE_IMPORT_RETENTION_LIMIT=100',
      '',
    ].join('\n');
    await writeFile(environment, valid);
    expect(
      runCommon('assert_finance_import_retention_config "$2"', environment)
        .status,
    ).toBe(0);

    for (const invalid of [
      valid.replace('emdo_finance_import_retention_login', 'emdo_api_login'),
      valid.replace(
        'EMDO_FINANCE_IMPORT_RETENTION_LIMIT=100',
        'EMDO_FINANCE_IMPORT_RETENTION_LIMIT=0',
      ),
      valid.replace(
        'EMDO_FINANCE_IMPORT_RETENTION_LIMIT=100',
        'EMDO_FINANCE_IMPORT_RETENTION_LIMIT=1001',
      ),
      `${valid}EMDO_API_DATABASE_URL=postgresql://forbidden\n`,
    ]) {
      await writeFile(environment, invalid);
      expect(
        runCommon('assert_finance_import_retention_config "$2"', environment)
          .status,
      ).not.toBe(0);
    }
  });

  it('requires the dedicated bounded Google OAuth disconnect reconciliation environment', async () => {
    const environment = join(
      directory,
      'google-oauth-disconnect-reconciliation.env',
    );
    const valid = [
      'EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_DATABASE_URL=postgresql://emdo_google_oauth_disconnect_reconciliation_login:fixture@postgres:5432/emdo_app?sslmode=disable',
      'EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_LIMIT=25',
      '',
    ].join('\n');
    await writeFile(environment, valid);
    expect(
      runCommon(
        'assert_google_oauth_disconnect_reconciliation_config "$2"',
        environment,
      ).status,
    ).toBe(0);

    for (const invalid of [
      valid.replace(
        'emdo_google_oauth_disconnect_reconciliation_login',
        'emdo_api_login',
      ),
      valid.replace(
        'EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_LIMIT=25',
        'EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_LIMIT=0',
      ),
      valid.replace(
        'EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_LIMIT=25',
        'EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_LIMIT=101',
      ),
      `${valid}EMDO_GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET=forbidden\n`,
    ]) {
      await writeFile(environment, invalid);
      expect(
        runCommon(
          'assert_google_oauth_disconnect_reconciliation_config "$2"',
          environment,
        ).status,
      ).not.toBe(0);
    }
  });

  it('requires the dedicated bounded Google OAuth disconnect retention environment', async () => {
    const environment = join(
      directory,
      'google-oauth-disconnect-retention.env',
    );
    const valid = [
      'EMDO_GOOGLE_OAUTH_DISCONNECT_RETENTION_DATABASE_URL=postgresql://emdo_google_oauth_disconnect_retention_login:fixture@postgres:5432/emdo_app?sslmode=disable',
      'EMDO_GOOGLE_OAUTH_DISCONNECT_RETENTION_LIMIT=100',
      '',
    ].join('\n');
    await writeFile(environment, valid);
    expect(
      runCommon(
        'assert_google_oauth_disconnect_retention_config "$2"',
        environment,
      ).status,
    ).toBe(0);

    for (const invalid of [
      valid.replace(
        'emdo_google_oauth_disconnect_retention_login',
        'emdo_api_login',
      ),
      valid.replace(
        'EMDO_GOOGLE_OAUTH_DISCONNECT_RETENTION_LIMIT=100',
        'EMDO_GOOGLE_OAUTH_DISCONNECT_RETENTION_LIMIT=0',
      ),
      valid.replace(
        'EMDO_GOOGLE_OAUTH_DISCONNECT_RETENTION_LIMIT=100',
        'EMDO_GOOGLE_OAUTH_DISCONNECT_RETENTION_LIMIT=101',
      ),
      `${valid}EMDO_GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET=forbidden\n`,
    ]) {
      await writeFile(environment, invalid);
      expect(
        runCommon(
          'assert_google_oauth_disconnect_retention_config "$2"',
          environment,
        ).status,
      ).not.toBe(0);
    }
  });

  it('requires the dedicated internal invitation-onboarding login', async () => {
    const apiEnvironment = join(directory, 'api.env');
    await writeFile(
      apiEnvironment,
      'EMDO_ONBOARDING_DATABASE_URL=postgresql://emdo_auth_login:fixture@postgres:5432/emdo_app?sslmode=disable\n',
    );

    const sharedAuth = runCommon(
      'assert_internal_postgres_uri "$2" EMDO_ONBOARDING_DATABASE_URL emdo_onboarding_login emdo_app',
      apiEnvironment,
    );
    expect(sharedAuth.status).not.toBe(0);

    await writeFile(
      apiEnvironment,
      'EMDO_ONBOARDING_DATABASE_URL=postgresql://emdo_onboarding_login:fixture@postgres:5432/emdo_app?sslmode=disable\n',
    );
    expect(
      runCommon(
        'assert_internal_postgres_uri "$2" EMDO_ONBOARDING_DATABASE_URL emdo_onboarding_login emdo_app',
        apiEnvironment,
      ).status,
    ).toBe(0);
  });

  it('keeps optional staging auth providers absent or fails closed on partial bundles', async () => {
    const apiEnvironment = join(directory, 'api.env');
    await writeFile(apiEnvironment, '\n');

    expect(
      runCommon('assert_staging_auth_provider_config "$2"', apiEnvironment)
        .status,
    ).toBe(0);

    for (const optionalBundle of [
      ['EMDO_GOOGLE_IDENTITY_CLIENT_ID=production-client'],
      ['EMDO_RESEND_AUTH_API_KEY=not-a-resend-key'],
      [
        'EMDO_TRANSACTIONAL_EMAIL_PROVIDER=resend',
        'EMDO_RESEND_FROM_EMAIL=Auth@staging.emdo.invalid',
      ],
    ]) {
      await writeFile(apiEnvironment, `${optionalBundle.join('\n')}\n`);
      expect(
        runCommon('assert_staging_auth_provider_config "$2"', apiEnvironment)
          .status,
      ).not.toBe(0);
    }
  });

  it('requires one high-entropy edge-proxy proof secret', async () => {
    const edgeProxyEnvironment = join(directory, 'edge-proxy.env');
    await writeFile(
      edgeProxyEnvironment,
      'EMDO_EDGE_PROXY_SECRET=edge-proxy-test-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ\n',
    );
    expect(
      runCommon('assert_edge_proxy_secret_file "$2"', edgeProxyEnvironment)
        .status,
    ).toBe(0);

    await writeFile(
      edgeProxyEnvironment,
      'EMDO_EDGE_PROXY_SECRET=predictable\n',
    );
    const weak = runCommon(
      'assert_edge_proxy_secret_file "$2"',
      edgeProxyEnvironment,
    );
    expect(weak.status).not.toBe(0);
    expect(weak.stderr).toContain('43-128 character base64url');

    await writeFile(
      edgeProxyEnvironment,
      [
        'EMDO_EDGE_PROXY_SECRET=edge-proxy-test-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        'UNEXPECTED_SECRET=must-not-be-accepted',
      ].join('\n'),
    );
    expect(
      runCommon('assert_edge_proxy_secret_file "$2"', edgeProxyEnvironment)
        .status,
    ).not.toBe(0);
  });

  it('binds an attestation to every exact image and source digest', async () => {
    const candidatePath = join(directory, 'candidate.env');
    const attestationPath = join(directory, 'attestation.env');
    await writeFile(
      candidatePath,
      `${validLock()}\nINITIAL_DEPLOYMENT_BOOTSTRAP=false\n`,
    );
    await writeFile(
      attestationPath,
      `${validLock()}\nSTAGING_TESTED=true\nSTAGING_RUN_ID=42\nSTAGING_WORKFLOW_RUN_ID=42\nSTAGING_TESTED_AT=2026-08-09T12:00:00Z\nSTAGING_INFRA_ARCHIVE_SHA256=${digest('f')}\nINITIAL_DEPLOYMENT_BOOTSTRAP=false\nACCEPTANCE_EVIDENCE_SHA256=${digest('e')}\nACCEPTANCE_EVIDENCE_RUN_ID=42\nACCEPTANCE_CI_RUN_ID=41\n`,
    );

    expect(
      runCommon(
        'assert_staging_attestation_matches "$2" "$3"',
        candidatePath,
        attestationPath,
      ).status,
    ).toBe(0);

    await writeFile(
      attestationPath,
      `${validLock({ WEB_IMAGE: `ghcr.io/panic80/emdo-web@sha256:${digest('a')}` })}\nSTAGING_TESTED=true\nSTAGING_RUN_ID=42\nSTAGING_WORKFLOW_RUN_ID=42\nSTAGING_TESTED_AT=2026-08-09T12:00:00Z\nSTAGING_INFRA_ARCHIVE_SHA256=${digest('f')}\nINITIAL_DEPLOYMENT_BOOTSTRAP=false\nACCEPTANCE_EVIDENCE_SHA256=${digest('e')}\nACCEPTANCE_EVIDENCE_RUN_ID=42\nACCEPTANCE_CI_RUN_ID=41\n`,
    );
    expect(
      runCommon(
        'assert_staging_attestation_matches "$2" "$3"',
        candidatePath,
        attestationPath,
      ).status,
    ).not.toBe(0);

    await writeFile(
      attestationPath,
      `${validLock()}\nSTAGING_TESTED=true\nSTAGING_RUN_ID=42\nSTAGING_WORKFLOW_RUN_ID=42\nSTAGING_TESTED_AT=2026-08-09T12:00:00Z\nSTAGING_INFRA_ARCHIVE_SHA256=${digest('f')}\nINITIAL_DEPLOYMENT_BOOTSTRAP=true\nACCEPTANCE_EVIDENCE_SHA256=${digest('e')}\nACCEPTANCE_EVIDENCE_RUN_ID=42\nACCEPTANCE_CI_RUN_ID=41\n`,
    );
    const bootstrapMismatch = runCommon(
      'assert_staging_attestation_matches "$2" "$3"',
      candidatePath,
      attestationPath,
    );
    expect(bootstrapMismatch.status).not.toBe(0);
    expect(bootstrapMismatch.stderr).toContain(
      'does not match the initial deployment assertion',
    );

    await writeFile(
      attestationPath,
      `${validLock()}\nSTAGING_TESTED=true\nSTAGING_RUN_ID=41\nSTAGING_WORKFLOW_RUN_ID=42\nSTAGING_TESTED_AT=2026-08-09T12:00:00Z\nINITIAL_DEPLOYMENT_BOOTSTRAP=false\n`,
    );
    const runMismatch = runCommon(
      'assert_staging_attestation_matches "$2" "$3"',
      candidatePath,
      attestationPath,
    );
    expect(runMismatch.status).not.toBe(0);
    expect(runMismatch.stderr).toContain('run identities do not match');
  });

  it('requires a non-placeholder staging-tested infrastructure archive digest', async () => {
    const candidatePath = join(directory, 'candidate.env');
    const attestationPath = join(directory, 'attestation.env');
    await writeFile(
      candidatePath,
      `${validLock()}\nINITIAL_DEPLOYMENT_BOOTSTRAP=false\n`,
    );
    await writeFile(
      attestationPath,
      `${validLock()}\nSTAGING_TESTED=true\nSTAGING_RUN_ID=42\nSTAGING_WORKFLOW_RUN_ID=42\nSTAGING_TESTED_AT=2026-08-09T12:00:00Z\nINITIAL_DEPLOYMENT_BOOTSTRAP=false\nACCEPTANCE_EVIDENCE_SHA256=${digest('e')}\nACCEPTANCE_EVIDENCE_RUN_ID=42\nACCEPTANCE_CI_RUN_ID=41\n`,
    );

    const missing = runCommon(
      'assert_staging_attestation_matches "$2" "$3"',
      candidatePath,
      attestationPath,
    );
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('infrastructure archive digest');

    await writeFile(
      attestationPath,
      `${validLock()}\nSTAGING_TESTED=true\nSTAGING_RUN_ID=42\nSTAGING_WORKFLOW_RUN_ID=42\nSTAGING_TESTED_AT=2026-08-09T12:00:00Z\nSTAGING_INFRA_ARCHIVE_SHA256=${digest('0')}\nINITIAL_DEPLOYMENT_BOOTSTRAP=false\nACCEPTANCE_EVIDENCE_SHA256=${digest('e')}\nACCEPTANCE_EVIDENCE_RUN_ID=42\nACCEPTANCE_CI_RUN_ID=41\n`,
    );
    const placeholder = runCommon(
      'assert_staging_attestation_matches "$2" "$3"',
      candidatePath,
      attestationPath,
    );
    expect(placeholder.status).not.toBe(0);
    expect(placeholder.stderr).toContain('infrastructure archive digest');
  });

  it('rejects infrastructure image changes in ordinary application promotion', async () => {
    const currentPath = join(directory, 'current.env');
    const unchangedPath = join(directory, 'unchanged.env');
    const changedPath = join(directory, 'changed.env');
    await writeFile(currentPath, `${validLock()}\n`);
    await writeFile(
      unchangedPath,
      `${validLock({ SOURCE_SHA: 'd'.repeat(40) })}\n`,
    );
    await writeFile(
      changedPath,
      `${validLock({
        SOURCE_SHA: 'd'.repeat(40),
        POWERSYNC_IMAGE: `journeyapps/powersync-service@sha256:${digest('a')}`,
      })}\n`,
    );

    expect(
      runCommon(
        'assert_infrastructure_promotion_unchanged "$2" "$3"',
        currentPath,
        unchangedPath,
      ).status,
    ).toBe(0);
    const changed = runCommon(
      'assert_infrastructure_promotion_unchanged "$2" "$3"',
      currentPath,
      changedPath,
    );
    expect(changed.status).not.toBe(0);
    expect(changed.stderr).toContain(
      'infrastructure image changes require a separate maintenance procedure',
    );
  });

  it('rejects bootstrap reuse and incomplete first-deployment acknowledgment', () => {
    const reused = runCommon(
      'assert_initial_bootstrap_policy true true true true',
    );
    const unacknowledged = runCommon(
      'assert_initial_bootstrap_policy true false true false',
    );
    const ordinaryExisting = runCommon(
      'assert_initial_bootstrap_policy false false false true',
    );

    expect(reused.status).not.toBe(0);
    expect(reused.stderr).toContain('not permitted after production exists');
    expect(unacknowledged.status).not.toBe(0);
    expect(unacknowledged.stderr).toContain('all three explicit assertions');
    expect(ordinaryExisting.status).toBe(0);
  });

  it('binds mixed-image rollback state to the active infrastructure release', () => {
    const mixedRelease = `/opt/emdo/releases/${infrastructureSourceSha}-123456`;
    const valid = runCommon(
      'assert_release_directory_binding "$2" "$3"',
      infrastructureSourceSha,
      mixedRelease,
    );
    const appSourceMismatch = runCommon(
      'assert_release_directory_binding "$2" "$3"',
      sourceSha,
      mixedRelease,
    );

    expect(valid.status).toBe(0);
    expect(appSourceMismatch.status).not.toBe(0);
    expect(appSourceMismatch.stderr).toContain(
      'deployed state is not bound to its source release directory',
    );
  });

  it('rejects traversal identifiers and production restore targets before Docker access', () => {
    const teardown = spawnSync(
      'bash',
      [join(rootPath, 'infra/scripts/teardown-staging.sh'), '../production'],
      { encoding: 'utf8' },
    );
    const restore = spawnSync(
      'bash',
      [join(rootPath, 'infra/scripts/restore-drill.sh'), '/does/not/matter'],
      {
        encoding: 'utf8',
        env: { ...process.env, RESTORE_TARGET_ENVIRONMENT: 'production' },
      },
    );

    expect(teardown.status).not.toBe(0);
    expect(teardown.stderr).toContain('safe identifier');
    expect(restore.status).not.toBe(0);
    expect(restore.stderr).toContain(
      'RESTORE_TARGET_ENVIRONMENT must be exactly staging',
    );
  });

  it('removes deployed workspace packages but preserves external dependencies', async () => {
    const nodeModules = join(directory, 'api/node_modules');
    const workspacePackage = join(
      nodeModules,
      '.pnpm/@emdo+contracts@file+packages+contracts/node_modules/@emdo/contracts',
    );
    const externalPackage = join(nodeModules, '.pnpm/zod@4/node_modules/zod');
    await mkdir(workspacePackage, { recursive: true });
    await mkdir(externalPackage, { recursive: true });
    await writeFile(join(workspacePackage, 'index.ts'), 'export {};\n');
    await writeFile(join(externalPackage, 'index.js'), 'export {};\n');

    const result = spawnSync(
      'node',
      [
        join(rootPath, 'infra/scripts/prune-deployed-workspace.mjs'),
        nodeModules,
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    await expect(stat(workspacePackage)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      stat(join(externalPackage, 'index.js')),
    ).resolves.toBeDefined();
  });

  it('rejects runtime packages with source artifacts or residual workspace imports', async () => {
    const packageRoot = join(directory, 'api');
    const dist = join(packageRoot, 'dist');
    await mkdir(join(dist, 'cli'), { recursive: true });
    await mkdir(join(packageRoot, 'node_modules'), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), '{"type":"module"}\n');
    for (const path of [
      'cli/migrate.js',
      'cli/purge-finance-imports.js',
      'cli/purge-google-oauth-disconnect-receipts.js',
      'cli/reconcile-google-oauth-disconnects.js',
      'cli/seed-synthetic.js',
      'cli/staging-acceptance.js',
    ]) {
      await writeFile(join(dist, path), 'export {};\n');
    }
    await writeFile(join(dist, 'index.js'), 'import "@emdo/contracts";\n');

    const validationScript = join(
      rootPath,
      'infra/scripts/validate-runtime-package.mjs',
    );
    const workspaceImport = spawnSync('node', [validationScript, packageRoot], {
      encoding: 'utf8',
    });
    expect(workspaceImport.status).not.toBe(0);
    expect(workspaceImport.stderr).toContain('workspace runtime import');

    await writeFile(join(dist, 'index.js'), 'export {};\n');
    await writeFile(join(dist, 'index.js.map'), '{"sourcesContent":[]}\n');
    const sourceArtifact = spawnSync('node', [validationScript, packageRoot], {
      encoding: 'utf8',
    });
    expect(sourceArtifact.status).not.toBe(0);
    expect(sourceArtifact.stderr).toContain('source artifact');
  });

  it('rejects dynamic and non-allowlisted WASM from the web release', async () => {
    const releaseAssertion = join(
      rootPath,
      'apps/web/scripts/assert-release-artifact.mjs',
    );
    const requiredAssets = [
      'manifest.webmanifest',
      'icons/emdo-192.png',
      'icons/emdo-512.png',
      'icons/emdo-maskable-512.png',
      'icons/apple-touch-icon.png',
    ];
    const requiredPowerSyncJavaScript = [
      'AccessHandlePoolVFS-BPUHfZME.js',
      'FacadeVFS-d1ZDvud7.js',
      'IDBBatchAtomicVFS-DbkDb777.js',
      'MemoryVFS-DVJL5F8j.js',
      'OPFSCoopSyncVFS-BgTiWPfa.js',
      'OPFSWriteAheadVFS-BzodSqNq.js',
      'mc-wa-sqlite-DDFgWP93.js',
      'mc-wa-sqlite-async-lGclTjKJ.js',
      'wa-sqlite-B0tZMM0j.js',
      'wa-sqlite-async-CM6BmfRh.js',
      'websockets-Q8W_lerF.js',
      'worker.js',
    ];
    const createFixture = async (
      name: string,
      wasmFiles: readonly string[],
    ): Promise<string> => {
      const packageRoot = join(directory, name);
      const dist = join(packageRoot, 'dist');
      await mkdir(join(dist, 'icons'), { recursive: true });
      await mkdir(join(dist, '@powersync/assets'), { recursive: true });
      for (const asset of requiredAssets) {
        await writeFile(join(dist, asset), 'fixture');
      }
      for (const worker of requiredPowerSyncJavaScript) {
        await writeFile(join(dist, '@powersync', worker), 'fixture');
      }
      for (const wasm of wasmFiles) {
        await writeFile(join(dist, wasm), 'fixture');
      }
      await writeFile(
        join(dist, 'sw.js'),
        [...requiredPowerSyncJavaScript, ...wasmFiles]
          .map((asset) =>
            JSON.stringify({
              url: asset.startsWith('@powersync/')
                ? asset
                : `@powersync/${asset}`,
            }),
          )
          .join('\n'),
      );
      return packageRoot;
    };

    const allowlistedRoot = await createFixture('allowlisted-wasm', [
      '@powersync/assets/mc-wa-sqlite-DoDpgFfE.wasm',
      '@powersync/assets/mc-wa-sqlite-async-DYagSq56.wasm',
    ]);
    const dynamicRoot = await createFixture('dynamic-wasm', [
      '@powersync/assets/libpowersync-sqlite-core.wasm',
    ]);
    const unknownRoot = await createFixture('unknown-wasm', [
      '@powersync/assets/not-reviewed.wasm',
    ]);

    expect(
      spawnSync(process.execPath, [releaseAssertion], {
        cwd: allowlistedRoot,
        encoding: 'utf8',
      }).status,
    ).toBe(0);
    expect(
      spawnSync(process.execPath, [releaseAssertion], {
        cwd: dynamicRoot,
        encoding: 'utf8',
      }).status,
    ).not.toBe(0);
    expect(
      spawnSync(process.execPath, [releaseAssertion], {
        cwd: unknownRoot,
        encoding: 'utf8',
      }).status,
    ).not.toBe(0);
  });
});

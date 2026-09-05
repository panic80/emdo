import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  POSTGRES_INTEGRATION_SUITES,
  POSTGRES_INTEGRATION_DATABASE_ATTESTATION_ENVIRONMENT,
  buildPostgresSuiteVitestArguments,
  readPostgresSuiteFailureSummary,
  runPostgresIntegrationSuites,
  summarizePostgresProcessFailure,
  summarizePostgresSuiteFailure,
  type PostgresIntegrationDependencies,
  type PostgresServerInspection,
} from './postgres-integration-orchestrator.js';

const sourceSha = 'a'.repeat(40);
const runId = '1234';
const event = 'push' as const;
const attackProof = Object.freeze({
  crossHouseholdReadDenied: true,
  crossHouseholdWriteDenied: true,
  privateOwnerBypassDenied: true,
  signedClaimScope: 'passed' as const,
  attackCaseCount: 15,
});
const validServer = Object.freeze({
  adminDatabase: 'postgres',
  adminIsSuperuser: true,
  emdoRoleCount: 0,
  pgvectorExtensionVersion: '0.8.6',
  serverVersionNum: 180_010,
} satisfies PostgresServerInspection);

const expectedDatabaseName = (
  suite: (typeof POSTGRES_INTEGRATION_SUITES)[number],
): string =>
  'canonicalDatabaseName' in suite
    ? suite.canonicalDatabaseName
    : `emdo_ci_${suite.id.replaceAll('-', '_')}`;

const createDependencies = (
  events: string[],
): PostgresIntegrationDependencies => {
  const dependencies = {
    inspectServer: vi.fn(async () => validServer),
    createDatabase: vi.fn(async ({ databaseAttestation, suite }) => {
      events.push(`create:${suite.id}`);
      expect(databaseAttestation).toMatch(
        new RegExp(`^emdo-postgres-suite-v1:${suite.id}:[0-9a-f]{32}$`, 'u'),
      );
      const databaseName = expectedDatabaseName(suite);
      return {
        databaseName,
        databaseUrl: `postgresql://postgres:test@127.0.0.1:5432/${databaseName}`,
      };
    }),
    runSuite: vi.fn(async ({ databaseAttestation, databaseName, suite }) => {
      events.push(`run:${suite.id}:${databaseName}`);
      expect(databaseAttestation).toMatch(
        new RegExp(`^emdo-postgres-suite-v1:${suite.id}:[0-9a-f]{32}$`, 'u'),
      );
      return {
        numFailedTests: 0,
        numPassedTests: suite.id === 'rls-cross-household-attacks' ? 1 : 2,
        numPendingTests: 0,
        numTotalTests: suite.id === 'rls-cross-household-attacks' ? 1 : 2,
        attackProof:
          suite.id === 'rls-cross-household-attacks' ? attackProof : undefined,
      };
    }),
    dropDatabase: vi.fn(async ({ databaseName, suite }) => {
      events.push(`drop:${suite.id}:${databaseName}`);
    }),
    cleanupGlobalRoles: vi.fn(async ({ suite }) => {
      events.push(`roles:${suite.id}`);
    }),
    writeRawReport: vi.fn(async (report) => {
      events.push(`report:${report.suites.length}`);
    }),
  };
  return dependencies;
};

describe('PostgreSQL integration orchestrator', () => {
  it('surfaces a bounded suite failure without leaking a database URL', () => {
    const summary = summarizePostgresSuiteFailure({
      testResults: [
        {
          assertionResults: [
            {
              fullName: 'grant replay denies a stale request',
              status: 'failed',
              failureMessages: [
                'AssertionError: expected true to be false\npostgresql://user:secret@database.example/emdo',
              ],
            },
          ],
        },
      ],
    });

    expect(summary).toContain('grant replay denies a stale request');
    expect(summary).toContain('expected true to be false');
    expect(summary).toContain('[database-url]');
    expect(summary).not.toContain('user:secret');
  });

  it('surfaces a setup or teardown failure reported at file level', () => {
    const summary = summarizePostgresSuiteFailure({
      testResults: [
        {
          assertionResults: [],
          message:
            'permission denied for role setup at postgresql://user:secret@database.example/emdo',
          name: '/workspace/packages/db/src/agent/run-event-source.integration.test.ts',
          status: 'failed',
        },
      ],
    });

    expect(summary).toContain('run-event-source.integration.test.ts');
    expect(summary).toContain('permission denied for role setup');
    expect(summary).toContain('[database-url]');
    expect(summary).not.toContain('user:secret');
  });

  it('redacts and bounds a verbose child-process failure', () => {
    const summary = summarizePostgresProcessFailure(
      `${'ordinary test output '.repeat(400)}\n` +
        '\u001B[31mError: role activation failed\u001B[39m\n' +
        'postgresql://user:secret@database.example/emdo',
    );

    expect(summary).toContain('role activation failed');
    expect(summary).toContain('[database-url]');
    expect(summary).not.toContain('user:secret');
    expect(summary).not.toContain('\u001B');
    expect(summary.length).toBeLessThanOrEqual(4_000);
  });

  it('waits briefly for a child JSON failure report to finish flushing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emdo-postgres-report-'));
    const resultPath = join(directory, 'vitest.json');
    try {
      const pendingSummary = readPostgresSuiteFailureSummary(resultPath, {
        attempts: 10,
        delayMs: 5,
      });
      setTimeout(() => {
        void writeFile(
          resultPath,
          JSON.stringify({
            testResults: [
              {
                assertionResults: [
                  {
                    fullName: 'fresh grant denies stale replay',
                    status: 'failed',
                    failureMessages: ['expected true to be false'],
                  },
                ],
              },
            ],
          }),
          'utf8',
        );
      }, 10);

      await expect(pendingSummary).resolves.toContain(
        'fresh grant denies stale replay',
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('enrolls every dedicated live database authority suite', () => {
    expect(POSTGRES_INTEGRATION_SUITES).toHaveLength(17);
    expect(POSTGRES_INTEGRATION_SUITES).toEqual(
      expect.arrayContaining([
        {
          id: 'audio-request-coordinator',
          file: 'packages/db/src/audio/audio-request-coordinator.integration.test.ts',
          databaseEnvironment: 'TEST_DURABLE_DATABASE_URL',
        },
        {
          id: 'disclosure-authority',
          file: 'packages/db/src/agent/disclosure-gateway.integration.test.ts',
          databaseEnvironment: 'TEST_DISCLOSURE_DATABASE_URL',
        },
        {
          id: 'finance-import-receipts',
          file: 'packages/db/src/finance/postgres-finance-import-repository.integration.test.ts',
          databaseEnvironment: 'TEST_FINANCE_IMPORT_DATABASE_URL',
        },
        {
          id: 'finance-document-knowledge',
          file: 'packages/db/src/finance/postgres-finance-document-repository.integration.test.ts',
          files: [
            'packages/db/src/finance/postgres-finance-document-repository.integration.test.ts',
            'apps/api/src/production/finance-synthetic-staging-runtime.integration.test.ts',
          ],
          databaseEnvironment: 'TEST_FINANCE_DOCUMENT_DATABASE_URL',
        },
        {
          id: 'finance-import-retention-runner',
          file: 'packages/db/src/finance/finance-import-retention-runner.integration.test.ts',
          databaseEnvironment: 'TEST_FINANCE_RETENTION_DATABASE_URL',
          canonicalDatabaseName: 'emdo_app',
        },
        {
          id: 'google-oauth-authority',
          file: 'packages/db/src/google/oauth-authority.integration.test.ts',
          databaseEnvironment: 'TEST_GOOGLE_OAUTH_AUTHORITY_DATABASE_URL',
          canonicalDatabaseName: 'emdo_app',
        },
        {
          id: 'manager-run-event-replay',
          file: 'packages/db/src/agent/run-event-source.integration.test.ts',
          databaseEnvironment: 'TEST_RUN_EVENT_DATABASE_URL',
        },
        {
          id: 'household-administration',
          file: 'packages/db/src/household-administration.integration.test.ts',
          databaseEnvironment: 'TEST_HOUSEHOLD_ADMIN_DATABASE_URL',
        },
        {
          id: 'sync-conflict-runtime',
          file: 'packages/db/src/sync/sync-conflict-runtime.integration.test.ts',
          databaseEnvironment: 'TEST_SYNC_CONFLICT_DATABASE_URL',
        },
        {
          id: 'worker-fixed-roles',
          file: 'packages/db/src/worker/runtime.integration.test.ts',
          databaseEnvironment: 'TEST_WORKER_ROLE_DATABASE_URL',
        },
      ]),
    );
  });

  it('invokes both grouped finance document files in one isolated Vitest child', () => {
    const suite = POSTGRES_INTEGRATION_SUITES.find(
      ({ id }) => id === 'finance-document-knowledge',
    );
    if (suite === undefined || !('files' in suite)) {
      throw new Error('The finance document suite must declare grouped files.');
    }

    expect(POSTGRES_INTEGRATION_SUITES).toHaveLength(17);
    expect(
      buildPostgresSuiteVitestArguments(suite, '/tmp/finance-document.json'),
    ).toEqual([
      'exec',
      'vitest',
      'run',
      ...suite.files,
      '--no-file-parallelism',
      '--cache=false',
      '--reporter=verbose',
      '--reporter=json',
      '--outputFile.json=/tmp/finance-document.json',
    ]);
  });

  it('runs every suite sequentially in a fresh database instance and writes a non-release report last', async () => {
    const events: string[] = [];
    const dependencies = createDependencies(events);

    const report = await runPostgresIntegrationSuites({
      adminUrl: 'postgresql://postgres:test@127.0.0.1:5432/postgres',
      dependencies,
      now: () => new Date('2026-08-10T14:00:00.000Z'),
      event,
      runId,
      sourceSha,
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      evidenceClass: 'ci-live-postgres-non-release',
      releaseEligible: false,
      sourceSha,
      observedAt: '2026-08-10T14:00:00.000Z',
      database: {
        postgresqlMajor: 18,
        serverVersionNum: 180_010,
        pgvectorExtensionVersion: '0.8.6',
      },
      execution: 'sequential',
      databaseIsolation: 'dedicated-database-per-suite',
      workflowRun: {
        event,
        runId,
        workflow: '.github/workflows/ci.yml',
      },
      rlsCrossHouseholdAttacks: attackProof,
    });
    expect(report.suites.map(({ id }) => id)).toEqual(
      POSTGRES_INTEGRATION_SUITES.map(({ id }) => id),
    );
    expect(
      new Set(report.suites.map(({ databaseName }) => databaseName)).size,
    ).toBe(new Set(POSTGRES_INTEGRATION_SUITES.map(expectedDatabaseName)).size);
    expect(dependencies.runSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseAttestation: expect.stringMatching(
          /^emdo-postgres-suite-v1:rls-cross-household-attacks:[0-9a-f]{32}$/u,
        ),
        probeContext: {
          environment: 'ci',
          event,
          runId,
          sourceSha,
          workflow: '.github/workflows/ci.yml',
        },
        suite: expect.objectContaining({ id: 'rls-cross-household-attacks' }),
      }),
    );
    expect(events).toEqual([
      ...POSTGRES_INTEGRATION_SUITES.flatMap((suite) => {
        const databaseName = expectedDatabaseName(suite);
        return [
          `create:${suite.id}`,
          `run:${suite.id}:${databaseName}`,
          `drop:${suite.id}:${databaseName}`,
          `roles:${suite.id}`,
        ];
      }),
      `report:${POSTGRES_INTEGRATION_SUITES.length}`,
    ]);
  });

  it('uses a single minted attestation for the database creation and child suite', async () => {
    const events: string[] = [];
    const dependencies = createDependencies(events);

    await runPostgresIntegrationSuites({
      adminUrl: 'postgresql://postgres:test@127.0.0.1:5432/postgres',
      dependencies,
      event,
      runId,
      sourceSha,
    });

    const financeSuite = POSTGRES_INTEGRATION_SUITES.find(
      ({ id }) => id === 'finance-document-knowledge',
    );
    const createCall = vi
      .mocked(dependencies.createDatabase)
      .mock.calls.find(([{ suite }]) => suite.id === financeSuite?.id);
    const runCall = vi
      .mocked(dependencies.runSuite)
      .mock.calls.find(([{ suite }]) => suite.id === financeSuite?.id);
    const createdAttestation = createCall?.[0].databaseAttestation;
    const suppliedAttestation = runCall?.[0].databaseAttestation;

    expect(POSTGRES_INTEGRATION_DATABASE_ATTESTATION_ENVIRONMENT).toBe(
      'EMDO_POSTGRES_INTEGRATION_DATABASE_ATTESTATION',
    );
    expect(createdAttestation).toMatch(
      /^emdo-postgres-suite-v1:finance-document-knowledge:[0-9a-f]{32}$/u,
    );
    expect(suppliedAttestation).toBe(createdAttestation);
  });

  it('keeps every generated suite database name within the PostgreSQL identifier limit', () => {
    for (const suite of POSTGRES_INTEGRATION_SUITES) {
      const normalizedSuite = suite.id.replaceAll('-', '_').slice(0, 36);
      const generatedName = `emdo_ci_${normalizedSuite}_${'a'.repeat(12)}`;
      expect(Buffer.byteLength(generatedName, 'utf8')).toBeLessThanOrEqual(63);
    }
  });

  it('rejects a silently skipped suite, cleans its database, and emits no report', async () => {
    const events: string[] = [];
    const dependencies = createDependencies(events);
    vi.mocked(dependencies.runSuite).mockResolvedValueOnce({
      numFailedTests: 0,
      numPassedTests: 0,
      numPendingTests: 1,
      numTotalTests: 1,
    });

    await expect(
      runPostgresIntegrationSuites({
        adminUrl: 'postgresql://postgres:test@127.0.0.1:5432/postgres',
        dependencies,
        event,
        now: () => new Date('2026-08-10T14:00:00.000Z'),
        runId,
        sourceSha,
      }),
    ).rejects.toThrow('did not execute every declared test');

    expect(events).toEqual([
      `create:${POSTGRES_INTEGRATION_SUITES[0]?.id}`,
      `drop:${POSTGRES_INTEGRATION_SUITES[0]?.id}:emdo_ci_${POSTGRES_INTEGRATION_SUITES[0]?.id.replaceAll('-', '_')}`,
      `roles:${POSTGRES_INTEGRATION_SUITES[0]?.id}`,
    ]);
    expect(dependencies.runSuite).toHaveBeenCalledTimes(1);
    expect(dependencies.writeRawReport).not.toHaveBeenCalled();
  });

  it('refuses PostgreSQL 17, PostgreSQL 19, or a server without pgvector before creating a database', async () => {
    for (const server of [
      { ...validServer, serverVersionNum: 170_010 },
      { ...validServer, serverVersionNum: 190_000 },
      { ...validServer, pgvectorExtensionVersion: null },
      { ...validServer, serverVersionNum: Number.NaN },
      { ...validServer, pgvectorExtensionVersion: 'not-a-version' },
      {
        ...validServer,
        emdoRoleCount: 1,
      },
      {
        ...validServer,
        adminDatabase: 'emdo_app',
      },
      {
        ...validServer,
        adminIsSuperuser: false,
      },
    ] as const) {
      const events: string[] = [];
      const dependencies = createDependencies(events);
      vi.mocked(dependencies.inspectServer).mockResolvedValueOnce(server);

      await expect(
        runPostgresIntegrationSuites({
          adminUrl: 'postgresql://postgres:test@127.0.0.1:5432/postgres',
          dependencies,
          event,
          now: () => new Date('2026-08-10T14:00:00.000Z'),
          runId,
          sourceSha,
        }),
      ).rejects.toThrow('PostgreSQL 18 with pgvector');
      expect(dependencies.createDatabase).not.toHaveBeenCalled();
    }
  });

  it('rejects missing or invalid workflow-run binding before inspecting PostgreSQL', async () => {
    for (const workflowRun of [
      { event: 'schedule', runId },
      { event, runId: '0' },
    ] as const) {
      const events: string[] = [];
      const dependencies = createDependencies(events);

      await expect(
        runPostgresIntegrationSuites({
          adminUrl: 'postgresql://postgres:test@127.0.0.1:5432/postgres',
          dependencies,
          event: workflowRun.event as 'pull_request' | 'push',
          now: () => new Date('2026-08-10T14:00:00.000Z'),
          runId: workflowRun.runId,
          sourceSha,
        }),
      ).rejects.toThrow('workflow run binding');
      expect(dependencies.inspectServer).not.toHaveBeenCalled();
    }
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  POSTGRES_INTEGRATION_SUITES,
  readPostgresSuiteFailureSummary,
  runPostgresIntegrationSuites,
  summarizePostgresProcessFailure,
  summarizePostgresSuiteFailure,
  type PostgresIntegrationDependencies,
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

const createDependencies = (
  events: string[],
): PostgresIntegrationDependencies => {
  const dependencies = {
    inspectServer: vi.fn(async () => ({
      emdoRoleCount: 0,
      pgvectorExtensionVersion: '0.8.6',
      serverVersionNum: 170_010,
    })),
    createDatabase: vi.fn(async ({ suite }) => {
      events.push(`create:${suite.id}`);
      return {
        databaseName: `emdo_ci_${suite.id.replaceAll('-', '_')}`,
        databaseUrl: `postgresql://postgres:test@127.0.0.1:5432/emdo_ci_${suite.id.replaceAll('-', '_')}`,
      };
    }),
    runSuite: vi.fn(async ({ databaseName, suite }) => {
      events.push(`run:${suite.id}:${databaseName}`);
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
          id: 'google-oauth-authority',
          file: 'packages/db/src/google/oauth-authority.integration.test.ts',
          databaseEnvironment: 'TEST_GOOGLE_OAUTH_AUTHORITY_DATABASE_URL',
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

  it('runs every suite sequentially in its own generated database and writes a non-release report last', async () => {
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
        postgresqlMajor: 17,
        serverVersionNum: 170_010,
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
    ).toBe(POSTGRES_INTEGRATION_SUITES.length);
    expect(dependencies.runSuite).toHaveBeenCalledWith(
      expect.objectContaining({
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
      ...POSTGRES_INTEGRATION_SUITES.flatMap(({ id }) => [
        `create:${id}`,
        `run:${id}:emdo_ci_${id.replaceAll('-', '_')}`,
        `drop:${id}:emdo_ci_${id.replaceAll('-', '_')}`,
        `roles:${id}`,
      ]),
      `report:${POSTGRES_INTEGRATION_SUITES.length}`,
    ]);
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

  it('refuses a server outside PostgreSQL 17 or without pgvector before creating a database', async () => {
    for (const server of [
      { pgvectorExtensionVersion: '0.8.6', serverVersionNum: 160_009 },
      { pgvectorExtensionVersion: null, serverVersionNum: 170_010 },
      { pgvectorExtensionVersion: '0.8.6', serverVersionNum: Number.NaN },
      { pgvectorExtensionVersion: 'not-a-version', serverVersionNum: 170_010 },
      {
        emdoRoleCount: 1,
        pgvectorExtensionVersion: '0.8.6',
        serverVersionNum: 170_010,
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
      ).rejects.toThrow('PostgreSQL 17 with pgvector');
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

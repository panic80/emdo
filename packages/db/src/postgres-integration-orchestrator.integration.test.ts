import { describe, expect, it } from 'vitest';

import { runPostgresIntegrationSuites } from './postgres-integration-orchestrator.js';

const adminUrl = process.env.POSTGRES_INTEGRATION_ADMIN_URL;
const sourceSha = process.env.POSTGRES_INTEGRATION_SOURCE_SHA;
const runId = process.env.POSTGRES_INTEGRATION_RUN_ID;
const event = process.env.POSTGRES_INTEGRATION_EVENT_NAME;
const describePostgres = adminUrl === undefined ? describe.skip : describe;

describePostgres(
  'sequential isolated 17-suite PostgreSQL 18 integration matrix (requires POSTGRES_INTEGRATION_ADMIN_URL)',
  () => {
    it(
      'executes every live suite and emits only a non-release raw probe',
      async () => {
        if (
          adminUrl === undefined ||
          sourceSha === undefined ||
          runId === undefined ||
          (event !== 'push' && event !== 'pull_request')
        ) {
          throw new Error(
            'The PostgreSQL integration admin URL and exact CI workflow-run binding are required.',
          );
        }
        const report = await runPostgresIntegrationSuites({
          adminUrl,
          event,
          runId,
          sourceSha,
        });

        expect(report.releaseEligible).toBe(false);
        expect(report.database.postgresqlMajor).toBe(18);
        expect(report.database.serverVersionNum).toBeGreaterThanOrEqual(
          180_000,
        );
        expect(report.database.serverVersionNum).toBeLessThan(190_000);
        expect(report.execution).toBe('sequential');
        expect(report.databaseIsolation).toBe('dedicated-database-per-suite');
        expect(report.suites).toHaveLength(17);
        expect(report.rlsCrossHouseholdAttacks).toMatchObject({
          crossHouseholdReadDenied: true,
          crossHouseholdWriteDenied: true,
          privateOwnerBypassDenied: true,
          signedClaimScope: 'passed',
        });
      },
      10 * 60_000,
    );
  },
);

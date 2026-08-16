import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const readRepositoryFile = (path: string) =>
  readFile(resolve(repositoryRoot, path), 'utf8');

describe('live PostgreSQL CI evidence boundary', () => {
  it('runs the live suites against a digest-pinned PostgreSQL 17 pgvector service', async () => {
    const workflow = await readRepositoryFile('.github/workflows/ci.yml');

    expect(workflow).toContain('postgres-integration:');
    expect(workflow).toContain(
      'pgvector/pgvector@sha256:7ae6051efd0e60444282c27c7e141af07f322ce033300e727a49c3dd11075e38',
    );
    expect(workflow).toContain('--health-cmd pg_isready');
    expect(workflow).toContain('POSTGRES_INTEGRATION_ADMIN_URL:');
    expect(workflow).toContain('pnpm test:postgres-integration');
    expect(workflow).toContain('postgres-integration-non-release-raw-probe');
    expect(workflow).toContain('retention-days: 14');
    expect(workflow).not.toMatch(/pgvector\/pgvector:(?:pg17|latest)\b/u);
  });

  it('keeps every suite explicit, sequential, and isolated', async () => {
    const runner = await readRepositoryFile(
      'packages/db/src/postgres-integration-orchestrator.ts',
    );
    const claimBridgeSuite = await readRepositoryFile(
      'packages/db/src/better-auth-claim-transaction.integration.test.ts',
    );
    const durableSuite = await readRepositoryFile(
      'packages/db/src/durable-repositories.integration.test.ts',
    );
    const ownerBootstrapSuite = await readRepositoryFile(
      'tests/integration/owner-bootstrap.test.ts',
    );
    const attackSuite = await readRepositoryFile(
      'packages/db/src/rls-cross-household-attacks.integration.test.ts',
    );

    const expectedSuites = [
      'better-auth-claim-bridge',
      'owner-bootstrap',
      'rls-cross-household-attacks',
      'rls-foundation',
      'workflow-authority',
      'durable-repositories',
      'audio-request-coordinator',
      'household-administration',
      'disclosure-authority',
      'finance-import-retention-runner',
      'google-oauth-authority',
      'manager-run-event-replay',
      'worker-fixed-roles',
      'proposal-lifecycle',
      'sync-conflict-runtime',
    ];
    for (const suite of expectedSuites)
      expect(runner).toContain(`id: '${suite}'`);
    expect(runner).toContain(
      "file: 'packages/db/src/sync/sync-conflict-runtime.integration.test.ts'",
    );
    expect(runner).toContain(
      "databaseEnvironment: 'TEST_SYNC_CONFLICT_DATABASE_URL'",
    );
    expect(runner).toContain("canonicalDatabaseName: 'emdo_app'");
    expect(runner).toContain("execution: 'sequential'");
    expect(runner).toContain(
      "databaseIsolation: 'dedicated-database-per-suite'",
    );
    expect(runner).toContain('numPendingTests !== 0');
    expect(runner).toContain("'--cache=false'");
    expect(runner).toContain('drop database');
    expect(runner).not.toContain('Promise.all(suites');
    expect(claimBridgeSuite).toContain("rolname like 'emdo\\\\_%'");
    expect(claimBridgeSuite).not.toContain('rolname = any($1::text[])');
    expect(durableSuite).toContain('loginPassword');
    expect(durableSuite).not.toContain("runtimeUrl.password = ''");
    expect(ownerBootstrapSuite).toContain('migrations[2]?.id');
    expect(ownerBootstrapSuite).not.toContain('migrations.at(-1)?.id');
    for (const probe of [
      'own-private-record-read-control',
      'own-private-record-update-control',
      'foreign-household-read',
      'foreign-record-insert',
      'member-private-record-update',
      'forged-signed-session',
    ]) {
      expect(attackSuite).toContain(probe);
    }
  });

  it('does not let CI masquerade as the staging database-security gate', async () => {
    const workflow = await readRepositoryFile('.github/workflows/ci.yml');
    const producer = await readRepositoryFile(
      'scripts/release/write-rls-cross-household-receipt.mjs',
    );

    expect(workflow).not.toContain(
      '--id rls-cross-household-attacks --category gates',
    );
    expect(workflow).not.toContain('write-rls-cross-household-receipt.mjs');
    expect(producer).toContain("GITHUB_EVENT_NAME !== 'workflow_dispatch'");
    expect(producer).toContain('ACCEPTANCE_PRODUCER_WORKFLOW');
    expect(producer).toContain('GITHUB_WORKFLOW_REF');
    expect(producer).toContain('value.releaseEligible !== false');
    expect(producer).toContain('crossHouseholdReadDenied');
    expect(producer).toContain('crossHouseholdWriteDenied');
    expect(producer).toContain('privateOwnerBypassDenied');
    expect(producer).toContain("proof.signedClaimScope !== 'passed'");
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseAcceptanceReceipt } from '../../scripts/release/acceptance-evidence.mjs';
import { runPostgresCiEvidenceWrite } from '../../scripts/release/write-postgres-ci-evidence.mjs';

const sourceSha = 'a'.repeat(40);
const runId = '1234';
const observedAt = '2026-08-10T14:00:00.000Z';
const suiteIds = [
  'better-auth-claim-bridge',
  'owner-bootstrap',
  'rls-cross-household-attacks',
  'rls-foundation',
  'workflow-authority',
  'durable-repositories',
  'audio-request-coordinator',
  'household-administration',
  'disclosure-authority',
  'finance-import-receipts',
  'finance-import-retention-runner',
  'google-oauth-authority',
  'manager-run-event-replay',
  'worker-fixed-roles',
  'proposal-lifecycle',
  'sync-conflict-runtime',
];
const roots: string[] = [];

const rawReport = () => ({
  schemaVersion: 1,
  evidenceClass: 'ci-live-postgres-non-release',
  releaseEligible: false,
  sourceSha,
  observedAt,
  workflowRun: {
    workflow: '.github/workflows/ci.yml',
    runId,
    event: 'push',
  },
  database: {
    postgresqlMajor: 17,
    serverVersionNum: 170_010,
    pgvectorExtensionVersion: '0.8.6',
  },
  execution: 'sequential',
  databaseIsolation: 'dedicated-database-per-suite',
  suites: suiteIds.map((id, index) => ({
    id,
    databaseName: `emdo_ci_suite_${index}`,
    testCount: 2,
    status: 'passed',
  })),
  rlsCrossHouseholdAttacks: {
    crossHouseholdReadDenied: true,
    crossHouseholdWriteDenied: true,
    privateOwnerBypassDenied: true,
    signedClaimScope: 'passed',
    attackCaseCount: 15,
  },
});

const prepare = async (report: unknown) => {
  const root = await mkdtemp(join(tmpdir(), 'emdo-postgres-ci-evidence-'));
  roots.push(root);
  const rawPath = join(root, 'raw.json');
  const receiptsRoot = join(root, 'receipts');
  await mkdir(receiptsRoot, { mode: 0o700 });
  await writeFile(rawPath, `${JSON.stringify(report)}\n`, { mode: 0o600 });
  return { rawPath, receiptsRoot };
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('PostgreSQL CI evidence writer', () => {
  it('converts a complete live raw report into the strict non-provider CI receipt', async () => {
    const { rawPath, receiptsRoot } = await prepare(rawReport());

    await runPostgresCiEvidenceWrite([
      '--raw-report',
      rawPath,
      '--receipts-root',
      receiptsRoot,
      '--source-sha',
      sourceSha,
      '--run-id',
      runId,
    ]);

    const receipt = parseAcceptanceReceipt(
      await readFile(
        join(receiptsRoot, 'artifacts/ci/postgres-integration.json'),
        'utf8',
      ),
      { category: 'ci', id: 'postgres-integration', context: undefined },
    );
    expect(receipt.verification).toMatchObject({
      id: 'postgres-integration',
      environment: 'ci',
      sourceSha,
    });
    await expect(
      readFile(
        join(receiptsRoot, 'descriptors/ci/postgres-integration.json'),
        'utf8',
      ),
    ).resolves.toContain('postgres-integration');
  });

  it.each([
    ['release eligible raw input', { releaseEligible: true }],
    [
      'a missing suite',
      { suites: rawReport().suites.slice(0, rawReport().suites.length - 1) },
    ],
    [
      'a false attack result',
      {
        rlsCrossHouseholdAttacks: {
          ...rawReport().rlsCrossHouseholdAttacks,
          privateOwnerBypassDenied: false,
        },
      },
    ],
    [
      'an incomplete attack set',
      {
        rlsCrossHouseholdAttacks: {
          ...rawReport().rlsCrossHouseholdAttacks,
          attackCaseCount: 14,
        },
      },
    ],
    [
      'a report from another workflow run',
      {
        workflowRun: {
          workflow: '.github/workflows/ci.yml',
          runId: '9999',
          event: 'push',
        },
      },
    ],
  ])(
    'rejects %s before writing an acceptance artifact',
    async (_name, patch) => {
      const { rawPath, receiptsRoot } = await prepare({
        ...rawReport(),
        ...patch,
      });

      await expect(
        runPostgresCiEvidenceWrite([
          '--raw-report',
          rawPath,
          '--receipts-root',
          receiptsRoot,
          '--source-sha',
          sourceSha,
          '--run-id',
          runId,
        ]),
      ).rejects.toThrow('PostgreSQL CI evidence');
      await expect(
        readFile(join(receiptsRoot, 'artifacts/ci/postgres-integration.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});

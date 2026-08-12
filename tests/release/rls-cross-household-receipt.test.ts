import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseAcceptanceReceipt } from '../../scripts/release/acceptance-evidence.mjs';
import { runRlsCrossHouseholdReceiptWrite } from '../../scripts/release/write-rls-cross-household-receipt.mjs';

const sourceSha = 'a'.repeat(40);
const runId = '9001';
const observedAt = '2026-08-10T14:00:00.000Z';
const digest = (character: string) => character.repeat(64);
const environment = Object.freeze({
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_RUN_ID: runId,
  GITHUB_SHA: sourceSha,
  GITHUB_WORKFLOW_REF:
    'panic80/emdo/.github/workflows/staging.yml@refs/heads/main',
  EMDO_ACCEPTANCE_ENVIRONMENT: 'staging',
});
const roots: string[] = [];
interface RejectionOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly probe?: unknown;
}

const probe = () => ({
  schemaVersion: 1,
  evidenceClass: 'live-postgres-rls-probe',
  releaseEligible: false,
  environment: 'staging',
  sourceSha,
  observedAt,
  execution: {
    workflow: '.github/workflows/staging.yml',
    runId,
    event: 'workflow_dispatch',
  },
  database: {
    postgresqlMajor: 17,
    serverVersionNum: 170_010,
    pgvectorExtensionVersion: '0.8.6',
  },
  proof: {
    crossHouseholdReadDenied: true,
    crossHouseholdWriteDenied: true,
    privateOwnerBypassDenied: true,
    signedClaimScope: 'passed',
    attackCaseCount: 15,
  },
});

const prepare = async (value: unknown) => {
  const root = await mkdtemp(join(tmpdir(), 'emdo-rls-receipt-'));
  roots.push(root);
  const probePath = join(root, 'rls-attack-proof.json');
  const imageLockPath = join(root, 'images.env');
  const receiptsRoot = join(root, 'receipts');
  await mkdir(receiptsRoot, { mode: 0o700 });
  await writeFile(probePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await writeFile(
    imageLockPath,
    [
      `SOURCE_SHA=${sourceSha}`,
      `API_IMAGE=ghcr.io/panic80/emdo-api@sha256:${digest('1')}`,
      `WORKER_IMAGE=ghcr.io/panic80/emdo-worker@sha256:${digest('2')}`,
      `WEB_IMAGE=ghcr.io/panic80/emdo-web@sha256:${digest('3')}`,
      `POSTGRES_IMAGE=pgvector/pgvector@sha256:${digest('4')}`,
      `POWERSYNC_IMAGE=journeyapps/powersync-service@sha256:${digest('5')}`,
      `CADDY_IMAGE=caddy@sha256:${digest('6')}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  return { imageLockPath, probePath, receiptsRoot };
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('staging RLS cross-household receipt writer', () => {
  it('writes the fixed staging gate only from a fresh same-run live probe', async () => {
    const paths = await prepare(probe());
    await runRlsCrossHouseholdReceiptWrite(
      [
        '--probe',
        paths.probePath,
        '--image-lock',
        paths.imageLockPath,
        '--receipts-root',
        paths.receiptsRoot,
      ],
      { environment, now: () => new Date('2026-08-10T14:05:00.000Z') },
    );

    const parsed = parseAcceptanceReceipt(
      await readFile(
        join(
          paths.receiptsRoot,
          'artifacts/gates/rls-cross-household-attacks.json',
        ),
        'utf8',
      ),
      {
        category: 'gates',
        id: 'rls-cross-household-attacks',
        context: undefined,
      },
    );
    expect(parsed.verification).toMatchObject({
      category: 'gates',
      environment: 'staging',
      id: 'rls-cross-household-attacks',
      sourceSha,
    });
  });

  const rejectionCases: readonly (readonly [string, RejectionOptions])[] = [
    [
      'CI workflow context',
      { environment: { ...environment, GITHUB_EVENT_NAME: 'push' } },
    ],
    ['wrong source', { probe: { ...probe(), sourceSha: 'b'.repeat(40) } }],
    ['stale probe', { now: () => new Date('2026-08-10T14:11:00.001Z') }],
    [
      'failed live attack',
      {
        probe: {
          ...probe(),
          proof: { ...probe().proof, crossHouseholdWriteDenied: false },
        },
      },
    ],
    [
      'incomplete live attack set',
      {
        probe: {
          ...probe(),
          proof: { ...probe().proof, attackCaseCount: 14 },
        },
      },
    ],
  ];

  it.each(rejectionCases)(
    'rejects %s before writing a gate receipt',
    async (_name, options) => {
      const paths = await prepare(options.probe ?? probe());
      await expect(
        runRlsCrossHouseholdReceiptWrite(
          [
            '--probe',
            paths.probePath,
            '--image-lock',
            paths.imageLockPath,
            '--receipts-root',
            paths.receiptsRoot,
          ],
          {
            environment: options.environment ?? environment,
            now: options.now ?? (() => new Date('2026-08-10T14:05:00.000Z')),
          },
        ),
      ).rejects.toThrow('RLS cross-household receipt');
      await expect(
        readFile(
          join(
            paths.receiptsRoot,
            'artifacts/gates/rls-cross-household-attacks.json',
          ),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});

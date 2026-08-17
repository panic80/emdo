import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { parseAcceptanceReceipt } from '../../scripts/release/acceptance-evidence.mjs';

interface StagingHttpWriterModule {
  readonly runStagingHttpReceiptWrite: (
    argv: readonly string[],
    options?: Readonly<{
      environment?: Readonly<Record<string, string | undefined>>;
      now?: () => Date;
    }>,
  ) => Promise<unknown>;
}

const writerModulePath = fileURLToPath(
  new URL(
    '../../scripts/release/write-staging-http-receipt.mjs',
    import.meta.url,
  ),
);
const runStagingHttpReceiptWrite: StagingHttpWriterModule['runStagingHttpReceiptWrite'] =
  async (...arguments_) => {
    const module = (await import(writerModulePath)) as StagingHttpWriterModule;
    return module.runStagingHttpReceiptWrite(...arguments_);
  };

const sourceSha = 'a'.repeat(40);
const runId = '9001';
const observedAt = '2026-08-10T14:00:00.000Z';
const digest = (character: string) => character.repeat(64);
const images = Object.freeze({
  api: `ghcr.io/panic80/emdo-api@sha256:${digest('1')}`,
  worker: `ghcr.io/panic80/emdo-worker@sha256:${digest('2')}`,
  web: `ghcr.io/panic80/emdo-web@sha256:${digest('3')}`,
  postgres: `pgvector/pgvector@sha256:${digest('4')}`,
  powersync: `journeyapps/powersync-service@sha256:${digest('5')}`,
  caddy: `caddy@sha256:${digest('6')}`,
});
const environment = Object.freeze({
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_RUN_ID: runId,
  GITHUB_SHA: sourceSha,
  GITHUB_WORKFLOW_REF:
    'panic80/emdo/.github/workflows/staging.yml@refs/heads/main',
  EMDO_ACCEPTANCE_ENVIRONMENT: 'staging',
});
const proof = () => ({
  healthz: 'passed',
  syntheticHttpSubsetReadiness: 'passed',
  authenticatedManagerShoppingFlow: 'passed',
  protectedMetrics: 'passed',
  requestIds: 'passed',
  problemJson: 'passed',
});
const probe = () => ({
  schemaVersion: 1,
  evidenceClass: 'staging-http-subset-probe',
  releaseEligible: false,
  environment: 'staging',
  sourceSha,
  observedAt,
  execution: {
    workflow: '.github/workflows/staging.yml',
    runId,
    event: 'workflow_dispatch',
  },
  proof: proof(),
});
const roots: string[] = [];

interface RejectionOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly imageSourceSha?: string;
  readonly now?: () => Date;
  readonly probe?: unknown;
}

const imageLockSource = (lockSourceSha = sourceSha) =>
  [
    `SOURCE_SHA=${lockSourceSha}`,
    `API_IMAGE=${images.api}`,
    `WORKER_IMAGE=${images.worker}`,
    `WEB_IMAGE=${images.web}`,
    `POSTGRES_IMAGE=${images.postgres}`,
    `POWERSYNC_IMAGE=${images.powersync}`,
    `CADDY_IMAGE=${images.caddy}`,
    '',
  ].join('\n');

const prepare = async (value: unknown, imageSourceSha = sourceSha) => {
  const root = await mkdtemp(join(tmpdir(), 'emdo-staging-http-receipt-'));
  roots.push(root);
  const probePath = join(root, 'http-probe.json');
  const imageLockPath = join(root, 'images.env');
  const receiptsRoot = join(root, 'receipts');
  await mkdir(receiptsRoot, { mode: 0o700 });
  await writeFile(probePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await writeFile(imageLockPath, imageLockSource(imageSourceSha), {
    mode: 0o600,
  });
  return { root, imageLockPath, probePath, receiptsRoot };
};

const argumentsFor = (paths: {
  readonly imageLockPath: string;
  readonly probePath: string;
  readonly receiptsRoot: string;
}) => [
  '--probe',
  paths.probePath,
  '--image-lock',
  paths.imageLockPath,
  '--receipts-root',
  paths.receiptsRoot,
];

const receiptPath = (receiptsRoot: string) =>
  join(receiptsRoot, 'artifacts/gates/http-api-subset.json');
const descriptorPath = (receiptsRoot: string) =>
  join(receiptsRoot, 'descriptors/gates/http-api-subset.json');

const expectNoEvidence = async (receiptsRoot: string): Promise<void> => {
  for (const path of [
    receiptPath(receiptsRoot),
    descriptorPath(receiptsRoot),
  ]) {
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  }
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('staging HTTP receipt writer', () => {
  it('writes the exact semantic gate from a fresh same-run protected staging probe', async () => {
    const paths = await prepare(probe());

    await runStagingHttpReceiptWrite(argumentsFor(paths), {
      environment,
      now: () => new Date('2026-08-10T14:05:00.000Z'),
    });

    const parsed = parseAcceptanceReceipt(
      await readFile(receiptPath(paths.receiptsRoot), 'utf8'),
      { category: 'gates', id: 'http-api-subset', context: undefined },
    );
    expect(parsed.value).toEqual({
      schemaVersion: 1,
      category: 'gate',
      id: 'http-api-subset',
      sourceSha,
      environment: 'staging',
      observedAt,
      execution: {
        workflow: '.github/workflows/staging.yml',
        runId,
        headSha: sourceSha,
        event: 'workflow_dispatch',
        conclusion: 'success',
      },
      images,
      result: {
        outcome: 'passed',
        evidenceClass: 'staging-http-subset',
        proof: proof(),
      },
    });
    await expect(
      readFile(
        join(paths.receiptsRoot, 'descriptors/gates/http-api-subset.json'),
        'utf8',
      ),
    ).resolves.toContain('http-api-subset');
  });

  const rejectionCases: readonly (readonly [string, RejectionOptions])[] = [
    [
      'non-GitHub context',
      { environment: { ...environment, GITHUB_ACTIONS: 'false' } },
    ],
    [
      'non-dispatch workflow context',
      { environment: { ...environment, GITHUB_EVENT_NAME: 'push' } },
    ],
    [
      'non-staging acceptance environment',
      { environment: { ...environment, EMDO_ACCEPTANCE_ENVIRONMENT: 'ci' } },
    ],
    [
      'wrong workflow ref',
      {
        environment: {
          ...environment,
          GITHUB_WORKFLOW_REF:
            'panic80/emdo/.github/workflows/ci.yml@refs/heads/main',
        },
      },
    ],
    [
      'wrong probe run',
      {
        probe: {
          ...probe(),
          execution: { ...probe().execution, runId: '9002' },
        },
      },
    ],
    [
      'wrong probe workflow',
      {
        probe: {
          ...probe(),
          execution: {
            ...probe().execution,
            workflow: '.github/workflows/ci.yml',
          },
        },
      },
    ],
    [
      'wrong probe source',
      { probe: { ...probe(), sourceSha: 'b'.repeat(40) } },
    ],
    ['stale probe', { now: () => new Date('2026-08-10T14:10:00.001Z') }],
    ['future-dated probe', { now: () => new Date('2026-08-10T13:59:59.999Z') }],
    [
      'release-eligible raw probe',
      { probe: { ...probe(), releaseEligible: true } },
    ],
    [
      'failed HTTP assertion',
      {
        probe: {
          ...probe(),
          proof: { ...proof(), syntheticHttpSubsetReadiness: 'failed' },
        },
      },
    ],
    [
      'missing HTTP assertion',
      {
        probe: {
          ...probe(),
          proof: Object.fromEntries(
            Object.entries(proof()).filter(([key]) => key !== 'problemJson'),
          ),
        },
      },
    ],
    [
      'extra HTTP assertion',
      { probe: { ...probe(), proof: { ...proof(), genericPassed: 'passed' } } },
    ],
    ['extra raw-probe field', { probe: { ...probe(), status: 'passed' } }],
    ['mismatched image lock source', { imageSourceSha: 'b'.repeat(40) }],
  ];

  it.each(rejectionCases)(
    'rejects %s before writing evidence',
    async (_name, options) => {
      const paths = await prepare(
        options.probe ?? probe(),
        options.imageSourceSha ?? sourceSha,
      );

      await expect(
        runStagingHttpReceiptWrite(argumentsFor(paths), {
          environment: options.environment ?? environment,
          now: options.now ?? (() => new Date('2026-08-10T14:05:00.000Z')),
        }),
      ).rejects.toThrow('Staging HTTP receipt');
      await expectNoEvidence(paths.receiptsRoot);
    },
  );

  it('rejects a symlinked raw probe before writing evidence', async () => {
    const paths = await prepare(probe());
    const linkedProbe = join(paths.root, 'linked-http-probe.json');
    await symlink(paths.probePath, linkedProbe);

    await expect(
      runStagingHttpReceiptWrite(
        argumentsFor({ ...paths, probePath: linkedProbe }),
        {
          environment,
          now: () => new Date('2026-08-10T14:05:00.000Z'),
        },
      ),
    ).rejects.toThrow('Staging HTTP receipt');
    await expectNoEvidence(paths.receiptsRoot);
  });
});

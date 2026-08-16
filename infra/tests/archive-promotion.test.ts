import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const rootPath = fileURLToPath(new URL('../../', import.meta.url));
const productionWorkflowPath = join(
  rootPath,
  '.github/workflows/production.yml',
);
const commonPath = join(rootPath, 'infra/scripts/_common.sh');
const sourceSha = 'b'.repeat(40);

const digest = (character: string): string => character.repeat(64);

const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const extractRunScript = (workflow: string, stepName: string): string => {
  const lines = workflow.split(/\r?\n/);
  const stepLine = `      - name: ${stepName}`;
  const stepIndex = lines.indexOf(stepLine);
  if (stepIndex === -1) {
    throw new Error(`Workflow step not found: ${stepName}`);
  }

  const nextStepIndex = lines.findIndex(
    (line, index) => index > stepIndex && line.startsWith('      - '),
  );
  const boundary = nextStepIndex === -1 ? lines.length : nextStepIndex;
  const runIndex = lines.findIndex(
    (line, index) =>
      index > stepIndex && index < boundary && line === '        run: |',
  );
  if (runIndex === -1) {
    throw new Error(`Workflow run block not found: ${stepName}`);
  }

  const scriptLines: string[] = [];
  for (let index = runIndex + 1; index < boundary; index += 1) {
    const line = lines[index] ?? '';
    if (line !== '' && !line.startsWith('          ')) {
      break;
    }
    scriptLines.push(line === '' ? '' : line.slice(10));
  }
  return scriptLines.join('\n');
};

const runBash = (
  script: string,
  cwd: string,
  environment: Readonly<Record<string, string>>,
): ReturnType<typeof spawnSync> =>
  spawnSync(
    'bash',
    ['--noprofile', '--norc', '-E', '-e', '-u', '-o', 'pipefail', '-c', script],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...environment },
    },
  );

const stagingLock = (archiveDigest: string | null = digest('f')): string =>
  [
    `SOURCE_SHA=${sourceSha}`,
    `API_IMAGE=ghcr.io/panic80/emdo-api@sha256:${digest('1')}`,
    `WORKER_IMAGE=ghcr.io/panic80/emdo-worker@sha256:${digest('2')}`,
    `WEB_IMAGE=ghcr.io/panic80/emdo-web@sha256:${digest('3')}`,
    `POSTGRES_IMAGE=pgvector/pgvector@sha256:${digest('4')}`,
    `POWERSYNC_IMAGE=journeyapps/powersync-service@sha256:${digest('5')}`,
    `CADDY_IMAGE=caddy@sha256:${digest('6')}`,
    'STAGING_TESTED=true',
    'STAGING_RUN_ID=42',
    'STAGING_WORKFLOW_RUN_ID=42',
    'STAGING_TESTED_AT=2026-08-12T12:00:00Z',
    archiveDigest === null
      ? null
      : `STAGING_INFRA_ARCHIVE_SHA256=${archiveDigest}`,
    'INITIAL_DEPLOYMENT_BOOTSTRAP=false',
    `ACCEPTANCE_EVIDENCE_SHA256=${digest('e')}`,
    'ACCEPTANCE_EVIDENCE_RUN_ID=42',
    'ACCEPTANCE_CI_RUN_ID=41',
  ]
    .filter((line): line is string => line !== null)
    .join('\n') + '\n';

describe('infrastructure archive promotion', () => {
  let commandBin: string;
  let directory: string;
  let productionWorkflow: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'emdo-archive-promotion-'));
    commandBin = join(directory, 'bin');
    await mkdir(commandBin);
    const sha256sumPath = join(commandBin, 'sha256sum');
    await writeFile(
      sha256sumPath,
      `#!/usr/bin/env bash
set -Eeuo pipefail
exec shasum -a 256 "$@"
`,
    );
    await chmod(sha256sumPath, 0o755);
    productionWorkflow = await readFile(productionWorkflowPath, 'utf8');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const preparePlanWorkspace = async (): Promise<string> => {
    await mkdir(join(directory, 'infra/scripts'), { recursive: true });
    await mkdir(join(directory, 'release'), { recursive: true });
    await writeFile(
      join(directory, 'infra/scripts/_common.sh'),
      await readFile(commonPath, 'utf8'),
    );

    return extractRunScript(
      productionWorkflow,
      'Resolve and validate the immutable staging plan',
    ).replaceAll('${{ steps.source.outputs.result }}', sourceSha);
  };

  const runPlanResolution = (
    script: string,
    expectedLockDigest: string,
  ): ReturnType<typeof spawnSync> =>
    runBash(script, directory, {
      EXPECTED_IMAGE_LOCK_DIGEST: expectedLockDigest,
      GITHUB_OUTPUT: join(directory, 'github-output'),
      INITIAL_BOOTSTRAP_ACKNOWLEDGED: 'false',
      INITIAL_DEPLOYMENT: 'false',
      PATH: `${commandBin}:${process.env.PATH ?? ''}:/usr/bin:/bin:/usr/sbin:/sbin`,
      SELECTED_STAGING_RUN_ID: '42',
    });

  it('accepts the unchanged reviewed staging archive digest', async () => {
    const script = await preparePlanWorkspace();
    const lock = stagingLock();
    await writeFile(join(directory, 'release/staging-tested.env'), lock);

    const result = runPlanResolution(script, sha256(lock));

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    await expect(
      readFile(join(directory, 'github-output'), 'utf8'),
    ).resolves.toContain(`staging_infra_archive_sha256=${digest('f')}`);
  });

  it.each([
    ['missing', null],
    ['all-zero', digest('0')],
  ] as const)('rejects a %s staging archive digest', async (_label, value) => {
    const script = await preparePlanWorkspace();
    const lock = stagingLock(value);
    await writeFile(join(directory, 'release/staging-tested.env'), lock);

    const result = runPlanResolution(script, sha256(lock));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'staging attestation has no valid infrastructure archive digest',
    );
  });

  it('rejects a changed archive digest against the reviewed lock hash', async () => {
    const script = await preparePlanWorkspace();
    const reviewedLock = stagingLock();
    const changedLock = stagingLock(digest('a'));
    await writeFile(join(directory, 'release/staging-tested.env'), changedLock);

    const result = runPlanResolution(script, sha256(reviewedLock));

    expect(result.status).not.toBe(0);
    expect(await exists(join(directory, 'github-output'))).toBe(false);
  });

  it('rejects changed regenerated bytes before either transfer command', async () => {
    const transferMarker = join(directory, 'transfer-called');
    const archivePath = join(directory, 'production-infra.tgz');
    for (const relativePath of [
      'infra/compose/compose.yml',
      'infra/caddy/Caddyfile',
      'infra/powersync/config.yaml',
      'infra/scripts/deploy-production.sh',
      'infra/systemd/emdo.service',
    ]) {
      const path = join(directory, relativePath);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, `reviewed ${relativePath}\n`);
    }

    const tarPath = join(commandBin, 'tar');
    await writeFile(
      tarPath,
      `#!/usr/bin/env bash
set -Eeuo pipefail
archive=''
while (( $# > 0 )); do
  case "$1" in
    --file) archive="$2"; shift 2 ;;
    --file=*) archive="\${1#*=}"; shift ;;
    *) shift ;;
  esac
done
[[ -n "$archive" ]]
find infra/compose infra/caddy infra/powersync infra/scripts infra/systemd -type f -print \\
  | LC_ALL=C sort \\
  | while IFS= read -r file; do
      printf '%s  %s\\n' "$(sha256sum "$file" | cut -d ' ' -f 1)" "$file"
    done > "$archive"
`,
    );
    for (const command of ['scp', 'ssh']) {
      const commandPath = join(commandBin, command);
      await writeFile(
        commandPath,
        `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\\n' '${command}' >> "$TRANSFER_MARKER"
`,
      );
      await chmod(commandPath, 0o755);
    }
    await chmod(tarPath, 0o755);

    const environment = {
      EXPECTED_INFRA_ARCHIVE_SHA256: '',
      PATH: `${commandBin}:${process.env.PATH ?? ''}:/usr/bin:/bin:/usr/sbin:/sbin`,
      SOURCE_SHA: sourceSha,
      TEST_ARCHIVE_PATH: archivePath,
      TRANSFER_MARKER: transferMarker,
      VPS_HOST: 'host.invalid',
      VPS_USER: 'deploy',
    };
    const uploadScript = extractRunScript(
      productionWorkflow,
      'Upload reviewed deployment assets',
    )
      .replace(
        'archive="/tmp/emdo-production-infra-${{ github.run_id }}.tgz"',
        'archive="$TEST_ARCHIVE_PATH"',
      )
      .replaceAll('${{ github.run_id }}', '314159');

    const archiveBuild = runBash(
      'tar --create --file "$TEST_ARCHIVE_PATH" infra/compose infra/caddy infra/powersync infra/scripts infra/systemd',
      directory,
      environment,
    );
    expect(archiveBuild.status).toBe(0);
    const reviewedDigest = sha256(await readFile(archivePath));
    await rm(archivePath);

    const matching = runBash(uploadScript, directory, {
      ...environment,
      EXPECTED_INFRA_ARCHIVE_SHA256: reviewedDigest,
    });
    expect(matching.status).toBe(0);
    await expect(readFile(transferMarker, 'utf8')).resolves.toBe('scp\nssh\n');

    await writeFile(
      join(directory, 'infra/compose/compose.yml'),
      'changed after staging acceptance\n',
    );
    await rm(archivePath);
    await rm(transferMarker);

    const mismatch = runBash(uploadScript, directory, {
      ...environment,
      EXPECTED_INFRA_ARCHIVE_SHA256: reviewedDigest,
    });

    expect(mismatch.status).not.toBe(0);
    expect(await exists(transferMarker)).toBe(false);
  });
});

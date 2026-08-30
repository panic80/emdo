import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const operatorPath = new URL('../scripts/staging-operator.sh', import.meta.url);
const temporaryDirectories: string[] = [];

const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

const writeExecutable = async (path: string, contents: string) => {
  await writeFile(path, contents, { mode: 0o755 });
  await chmod(path, 0o755);
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('staging release operator', () => {
  it('forwards Finance provider material only through protected stdin and requires an explicit live-chat flag for the agent packet', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'emdo-staging-operator-finance-'),
    );
    temporaryDirectories.push(root);
    const release = join(root, 'release');
    const scriptDirectory = join(release, 'infra/scripts');
    const receivedInput = join(root, 'received-input');
    const receivedArguments = join(root, 'received-arguments');
    await mkdir(scriptDirectory, { recursive: true });
    await writeExecutable(
      join(scriptDirectory, 'deploy-staging.sh'),
      [
        '#!/usr/bin/env bash',
        'set -Eeuo pipefail',
        '[[ -z "${EMDO_OPENAI_FINANCE_API_KEY:-}" ]]',
        `printf '%s\\n' "$#" "$1" "$2" "$3" "$4" "$5" > '${receivedArguments}'`,
        `cat > '${receivedInput}'`,
        '',
      ].join('\n'),
    );

    const source = await readFile(operatorPath, 'utf8');
    const transformed = source
      .replace(
        "((EUID == 0)) || die 'this fixed operator must run as root'",
        ':',
      )
      .replace(
        'readonly record_root=/var/lib/emdo/staging-releases',
        `readonly record_root=${join(root, 'records')}`,
      )
      .replace(
        'mapfile -t finance_key_lines',
        'finance_key_lines=(); while IFS= read -r line || [[ -n "$line" ]]; do finance_key_lines+=("$line"); done',
      )
      .replace(
        `action="${'${1:-}'}"
shift || true
case "$action" in
  install) install_release "$@" ;;
  deploy) deploy_release "$@" ;;
  accept) accept_release "$@" ;;
  finance-restore-receipt) finance_restore_receipt_release "$@" ;;
  teardown) teardown_release "$@" ;;
  *) die 'allowed actions are install, deploy, accept, finance-restore-receipt, and teardown' ;;
esac`,
        `load_record() {
  RECORD_STATUS=installed
  RECORD_RELEASE='${release}'
  RECORD_SOURCE_SHA='${'a'.repeat(40)}'
  RECORD_ARCHIVE_SHA='${'b'.repeat(64)}'
}
write_record() { :; }
deploy_release "$@"`,
      );
    const scriptPath = join(root, 'operator.sh');
    await writeExecutable(scriptPath, transformed);

    const financeKey = 'finance_staging_openai_key_0123456789';
    const result = spawnSync(
      'bash',
      [scriptPath, '123456789', 'false', '60', 'true'],
      { encoding: 'utf8', input: `${financeKey}\n` },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(receivedInput, 'utf8')).toBe(`${financeKey}\n`);
    expect(await readFile(receivedArguments, 'utf8')).toBe(
      '5\n123456789\n/release/images.env\n60\ntrue\nfalse\n'.replace(
        '/release',
        release,
      ),
    );
    expect(result.stderr).not.toContain(financeKey);

    const invalid = spawnSync(
      'bash',
      [scriptPath, '987654321', 'false', '60', 'true'],
      { encoding: 'utf8', input: 'not-a-valid Finance key\n' },
    );
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).not.toContain('not-a-valid Finance key');

    const agentKey = `sk-proj-${'a'.repeat(40)}`;
    const livePacket = [
      financeKey,
      agentKey,
      'openai-2026-07-30.boc-2026-08-28.usdcad-1.3888.ceil',
      '28',
      '167',
      '278',
      '1667',
    ].join('\n');
    const live = spawnSync(
      'bash',
      [scriptPath, '123456790', 'false', '60', 'true', 'true'],
      { encoding: 'utf8', input: `${livePacket}\n` },
    );
    expect(live.status, live.stderr).toBe(0);
    expect(await readFile(receivedInput, 'utf8')).toBe(`${livePacket}\n`);
    expect(await readFile(receivedArguments, 'utf8')).toBe(
      '5\n123456790\n/release/images.env\n60\ntrue\ntrue\n'.replace(
        '/release',
        release,
      ),
    );
    expect(live.stderr).not.toContain(financeKey);
    expect(live.stderr).not.toContain(agentKey);
  });

  it('cleans temporary install state without dereferencing expired function locals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'emdo-staging-operator-'));
    temporaryDirectories.push(root);
    const releaseRoot = join(root, 'releases');
    const recordRoot = join(root, 'records');
    const incomingRoot = join(root, 'incoming');
    const keyRoot = join(root, 'keys');
    const assetRoot = join(root, 'assets');
    const binRoot = join(root, 'bin');
    await Promise.all(
      [releaseRoot, recordRoot, incomingRoot, keyRoot, assetRoot, binRoot].map(
        (directory) => mkdir(directory),
      ),
    );

    const sourceSha = 'a'.repeat(40);
    const runId = '123456789';
    const imageLock =
      [
        `SOURCE_SHA=${sourceSha}`,
        'API_IMAGE=ghcr.io/panic80/emdo-api@sha256:' + '1'.repeat(64),
        'WORKER_IMAGE=ghcr.io/panic80/emdo-worker@sha256:' + '2'.repeat(64),
        'WEB_IMAGE=ghcr.io/panic80/emdo-web@sha256:' + '3'.repeat(64),
        'POSTGRES_IMAGE=pgvector/pgvector@sha256:' + '4'.repeat(64),
        'POWERSYNC_IMAGE=journeyapps/powersync-service@sha256:' +
          '5'.repeat(64),
        'CADDY_IMAGE=caddy@sha256:' + '6'.repeat(64),
      ].join('\n') + '\n';
    const imageLockPath = join(assetRoot, 'images.env');
    await writeFile(imageLockPath, imageLock, { mode: 0o600 });

    const archiveSource = join(assetRoot, 'archive');
    await Promise.all(
      ['infra/compose', 'infra/scripts'].map((directory) =>
        mkdir(join(archiveSource, directory), { recursive: true }),
      ),
    );
    for (const path of [
      'infra/compose/compose.yml',
      'infra/scripts/_common.sh',
      'infra/scripts/deploy-staging.sh',
      'infra/scripts/run-staging-acceptance.sh',
      'infra/scripts/teardown-staging.sh',
    ]) {
      await writeFile(join(archiveSource, path), 'fixture\n');
    }
    const archivePath = join(assetRoot, 'release.tgz');
    execFileSync('tar', [
      '-czf',
      archivePath,
      '-C',
      archiveSource,
      'infra/compose/compose.yml',
      'infra/scripts/_common.sh',
      'infra/scripts/deploy-staging.sh',
      'infra/scripts/run-staging-acceptance.sh',
      'infra/scripts/teardown-staging.sh',
    ]);
    const archiveBytes = await readFile(archivePath);
    const archiveSha = sha256(archiveBytes);
    const imageLockSha = sha256(imageLock);
    const descriptorPath = join(assetRoot, 'descriptor.env');
    const descriptor =
      [
        'schema=emdo-release-assets-v1',
        'purpose=staging',
        `source_sha=${sourceSha}`,
        `workflow_run_id=${runId}`,
        `archive_sha256=${archiveSha}`,
        `image_lock_sha256=${imageLockSha}`,
      ].join('\n') + '\n';
    await writeFile(descriptorPath, descriptor, { mode: 0o600 });
    const privateKey = join(keyRoot, 'private.pem');
    const publicKey = join(keyRoot, 'public.pem');
    execFileSync('openssl', [
      'genpkey',
      '-algorithm',
      'Ed25519',
      '-out',
      privateKey,
    ]);
    execFileSync('openssl', [
      'pkey',
      '-in',
      privateKey,
      '-pubout',
      '-out',
      publicKey,
    ]);
    await chmod(publicKey, 0o644);
    const signaturePath = join(assetRoot, 'descriptor.sig');
    execFileSync('openssl', [
      'pkeyutl',
      '-sign',
      '-inkey',
      privateKey,
      '-rawin',
      '-in',
      descriptorPath,
      '-out',
      signaturePath,
    ]);

    if (process.platform === 'darwin') {
      await writeExecutable(
        join(binRoot, 'sha256sum'),
        '#!/bin/sh\nprintf "%s  %s\\n" "$(shasum -a 256 "$1" | cut -d " " -f 1)" "$1"\n',
      );
      await writeExecutable(
        join(binRoot, 'stat'),
        '#!/bin/sh\ncase "$2" in *%u:%a:%h*) /usr/bin/stat -f "%u:%Lp:%l" "$3" ;; *%s*) /usr/bin/stat -f "%z" "$3" ;; esac\n',
      );
    }

    const uid = process.getuid?.() ?? 0;
    const source = await readFile(operatorPath, 'utf8');
    const transformed = source
      .replace(
        "((EUID == 0)) || die 'this fixed operator must run as root'",
        ':',
      )
      .replace(
        'readonly release_root=/opt/emdo/releases',
        `readonly release_root=${releaseRoot}`,
      )
      .replace(
        'readonly record_root=/var/lib/emdo/staging-releases',
        `readonly record_root=${recordRoot}`,
      )
      .replace(
        'readonly incoming_root=/var/lib/emdo/release-incoming',
        `readonly incoming_root=${incomingRoot}`,
      )
      .replace(
        'readonly public_key=/etc/emdo/release/release-assets-public.pem',
        `readonly public_key=${publicKey}`,
      )
      .replace('"$path" == /tmp/*', `"$path" == ${tmpdir()}/*`)
      .replace(
        'mapfile -t descriptor_lines < "$copied_descriptor"',
        'descriptor_lines=(); while IFS= read -r line || [[ -n "$line" ]]; do descriptor_lines+=("$line"); done < "$copied_descriptor"',
      )
      .replace('"0:$expected_mode:1"', `"${uid}:$expected_mode:1"`)
      .replaceAll('! -user root', `! -user ${uid}`)
      .replaceAll('install -d -o 0 -g 0', 'install -d')
      .replaceAll('install -o 0 -g 0', 'install')
      .replace('chown -R root:root "$installing"', ':')
      .replace(
        'trap cleanup_install EXIT',
        'trap cleanup_install EXIT\n  [[ "${EMDO_TEST_FAIL_AFTER_TRAP:-}" != 1 ]] || return 1',
      )
      .replace('declare -A image_values=()', 'declare -a image_values=()')
      .replace(
        / {2}while IFS= read -r line \|\| \[\[ -n "\$line" \]\]; do\n[\s\S]*? {2}done < "\$copied_lock"\n/u,
        '  image_count=7\n',
      )
      .replace(
        / {2}\[\[ "\$image_count" == 7 && "\$\{image_values\[SOURCE_SHA\]:-\}" == "\$source_sha" \]\] \|\|\n {4}die 'image lock is incomplete or has the wrong source SHA'\n {2}for key in API_IMAGE WORKER_IMAGE WEB_IMAGE POSTGRES_IMAGE POWERSYNC_IMAGE CADDY_IMAGE; do\n[\s\S]*? {2}done\n/u,
        '  :\n',
      );
    const scriptPath = join(root, 'operator.sh');
    await writeExecutable(scriptPath, transformed);

    const result = spawnSync(
      'bash',
      [
        scriptPath,
        'install',
        archivePath,
        imageLockPath,
        descriptorPath,
        signaturePath,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${binRoot}:${process.env.PATH ?? ''}` },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      `installed signed staging release ${sourceSha} for workflow run ${runId}`,
    );
    expect(result.stderr).not.toContain('unbound variable');
    expect(await readdir(incomingRoot)).toEqual([]);

    const rejectedResult = spawnSync(
      'bash',
      [
        scriptPath,
        'install',
        archivePath,
        imageLockPath,
        descriptorPath,
        signaturePath,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          EMDO_TEST_FAIL_AFTER_TRAP: '1',
          PATH: `${binRoot}:${process.env.PATH ?? ''}`,
        },
      },
    );

    expect(rejectedResult.status).toBe(1);
    expect(rejectedResult.stderr).not.toContain(
      'installed signed staging release',
    );
    expect(rejectedResult.stderr).not.toContain('unbound variable');
    expect(await readdir(incomingRoot)).toEqual([]);
  });
});

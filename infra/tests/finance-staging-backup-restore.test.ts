import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const scriptPath = fileURLToPath(
  new URL('infra/scripts/finance-staging-backup-restore.sh', root),
);
const commonPath = fileURLToPath(new URL('infra/scripts/_common.sh', root));

const read = (path: string): Promise<string> =>
  readFile(new URL(path, root), 'utf8');

const scriptPrelude = (source: string): string => {
  const entrypoint = source.indexOf('\ncommand_name=');
  if (entrypoint < 0)
    throw new Error('Finance backup script entrypoint missing');
  return source
    .slice(0, entrypoint)
    .replace(
      'source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/_common.sh"',
      '',
    );
};

const refusalCommon = `#!/usr/bin/env bash
die() {
  printf '%s\\n' "$*" >&2
  exit 97
}
`;

describe('Finance staging backup and isolated restore drill', () => {
  it('accepts only the pre-created acceptance handoff and clears it after one use', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emdo-finance-handoff-'));
    const stateRoot = join(directory, 'staging');
    const stateDirectory = join(stateRoot, '123456789');
    const secretDirectory = join(stateDirectory, 'finance-secrets');
    const handoff = join(
      secretDirectory,
      'finance-staging-restore-verifier-input.env',
    );
    const symlinkedHandoff = join(
      secretDirectory,
      'finance-staging-restore-verifier-input-symlink.env',
    );
    const chownMarker = join(directory, 'chown-was-called');
    const common = await readFile(commonPath, 'utf8');
    const handoffFunctions = common.slice(
      common.indexOf('finance_staging_restore_verifier_input_path()'),
      common.indexOf('\nassert_finance_synthetic_staging_state()'),
    );
    const handoffPayload = [
      'schema=emdo-finance-staging-restore-verifier-input-v1',
      `source_sha=${'a'.repeat(40)}`,
      'workflow_run_id=123456789',
      'document_id=018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f94',
      'evidence_id=018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f95',
      `expected_plaintext_sha256=${'b'.repeat(64)}`,
      'owner_cookie=owner_session=owner-value',
      'member_cookie=member_session=member-value',
      '',
    ].join('\n');

    const run = (statValue: string, action: string) =>
      spawnSync(
        'bash',
        [
          '-c',
          `set -Eeuo pipefail
readonly STAGING_STATE_ROOT="$1"
readonly FINANCE_STAGING_SECRET_DIR="finance-secrets"
readonly FINANCE_STAGING_RESTORE_VERIFIER_INPUT_NAME="finance-staging-restore-verifier-input.env"
die() { printf '%s\\n' "$*" >&2; exit 97; }
require_regular_file() { [[ -f "$1" && ! -L "$1" ]] || die 'required regular file is missing'; }
assert_root_owned_bounded_file() { [[ -f "$1" && ! -L "$1" && -s "$1" ]] || die 'unsafe root-owned handoff'; }
${handoffFunctions}
stat() {
  if [[ "$1" == -c && "$2" == '%u %g %a %h %s' ]]; then
    printf '%s\\n' "$FINANCE_TEST_STAT"
  else
    command stat "$@"
  fi
}
chown() { : > "$FINANCE_TEST_CHOWN_MARKER"; }
IMAGE_LOCK_SOURCE_SHA='${'a'.repeat(40)}'
STAGING_RUN_ID=123456789
${action}`,
          '_',
          stateRoot,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            FINANCE_TEST_CHOWN_MARKER: chownMarker,
            FINANCE_TEST_STAT: statValue,
          },
        },
      );

    try {
      await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
      await writeFile(handoff, '', { mode: 0o600 });

      const accepted = run(
        '10001 10001 600 1 0',
        'assert_finance_restore_verifier_handoff_empty "$1/123456789"',
      );
      expect(accepted.status, accepted.stderr).toBe(0);
      const badMode = run(
        '10001 10001 640 1 0',
        'assert_finance_restore_verifier_handoff_empty "$1/123456789"',
      );
      expect(badMode.status).not.toBe(0);
      expect(badMode.stderr).toContain('mode or link count is unsafe');
      const hardLinked = run(
        '10001 10001 600 2 0',
        'assert_finance_restore_verifier_handoff_empty "$1/123456789"',
      );
      expect(hardLinked.status).not.toBe(0);
      expect(hardLinked.stderr).toContain('mode or link count is unsafe');
      const wrongOwner = run(
        '10002 10001 600 1 0',
        'assert_finance_restore_verifier_handoff_empty "$1/123456789"',
      );
      expect(wrongOwner.status).not.toBe(0);
      expect(wrongOwner.stderr).toContain('handoff owner is unsafe');

      await symlink(handoff, symlinkedHandoff);
      await rm(handoff);
      await symlink(symlinkedHandoff, handoff);
      const symlinked = run(
        '10001 10001 600 1 0',
        'assert_finance_restore_verifier_handoff_empty "$1/123456789"',
      );
      expect(symlinked.status).not.toBe(0);
      expect(symlinked.stderr).toContain('required regular file is missing');
      await rm(handoff);
      await rm(symlinkedHandoff);
      await writeFile(handoff, handoffPayload.slice(0, 87), { mode: 0o600 });

      const partial = run(
        '10001 10001 600 1 87',
        'claim_finance_restore_verifier_handoff "$1/123456789"',
      );
      expect(partial.status).not.toBe(0);
      expect(partial.stderr).toContain(
        'does not contain the exact required keys',
      );
      expect(
        spawnSync('test', ['-e', chownMarker], { encoding: 'utf8' }).status,
      ).not.toBe(0);

      await writeFile(handoff, handoffPayload, { mode: 0o600 });
      const cleared = run(
        `10001 10001 600 1 ${Buffer.byteLength(handoffPayload)}`,
        'clear_finance_restore_verifier_handoff "$1/123456789"',
      );
      expect(cleared.status, cleared.stderr).toBe(0);
      expect(await readFile(handoff, 'utf8')).toBe('');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('refuses a non-staging target before any Docker or backup command can run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emdo-finance-refusal-'));
    const copiedScript = join(directory, 'finance-staging-backup-restore.sh');
    const common = join(directory, '_common.sh');
    const binDirectory = join(directory, 'bin');
    const docker = join(binDirectory, 'docker');

    try {
      await copyFile(scriptPath, copiedScript);
      await writeFile(common, refusalCommon, { mode: 0o700 });
      await mkdir(binDirectory);
      await writeFile(
        docker,
        '#!/usr/bin/env bash\nprintf "docker-was-called\\n" >&2\nexit 96\n',
        { mode: 0o700 },
      );
      await chmod(docker, 0o700);

      const result = spawnSync('bash', [copiedScript, 'backup', '123'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          FINANCE_STAGING_BACKUP_RESTORE_TARGET_ENVIRONMENT: 'production',
          PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
        },
      });

      expect(result.status).toBe(97);
      expect(result.stderr).toContain(
        'FINANCE_STAGING_BACKUP_RESTORE_TARGET_ENVIRONMENT must be exactly staging',
      );
      expect(result.stderr).not.toContain('docker-was-called');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('routes the handoff only through Finance acceptance, root claim, and the isolated drill', async () => {
    const [common, compose, acceptance, verifier, workflow, operator] =
      await Promise.all([
        read('infra/scripts/_common.sh'),
        read('infra/compose/compose.finance-staging.yml'),
        read('infra/scripts/run-staging-acceptance.sh'),
        read('infra/scripts/finance-staging-restore-verify.sh'),
        read('.github/workflows/staging.yml'),
        read('infra/scripts/staging-operator.sh'),
      ]);
    const handoffVariable = 'FINANCE_STAGING_RESTORE_VERIFIER_INPUT_FILE';
    const claim = acceptance.indexOf('claim_finance_restore_verifier_handoff');
    const backup = acceptance.indexOf(
      'finance-staging-backup-restore.sh" backup',
    );
    const restore = acceptance.indexOf(
      'finance-staging-backup-restore.sh" restore',
    );
    const prepareFinalize = acceptance.indexOf(
      'prepare_finance_staging_finalize_handoff',
    );
    const finalizeArgument = acceptance.indexOf(
      '--finance-synthetic-document-finalize',
    );
    const claimFinalize = acceptance.indexOf(
      'claim_consumed_finance_staging_finalize_handoff',
    );

    expect(common).toContain(
      'install -o 10001 -g 10001 -m 0600 /dev/null "$pending_handoff"',
    );
    expect(common).toContain(
      `export ${handoffVariable}="$restore_verifier_input"`,
    );
    expect(compose).toContain(handoffVariable);
    expect(compose).toMatch(
      /staging-acceptance:[\s\S]*?FINANCE_STAGING_RESTORE_VERIFIER_INPUT_FILE[\s\S]*?target: \/run\/emdo\/finance-restore\/finance-staging-restore-verifier-input\.env[\s\S]*?network_mode: service:api/,
    );
    const apiService = compose.match(
      /\n {2}api:\n[\s\S]+?\n {2}staging-acceptance:\n/u,
    )?.[0];
    const extractionService = compose.match(
      /\n {2}finance-extraction:\n[\s\S]+?\nnetworks:\n/u,
    )?.[0];
    expect(apiService).not.toContain(handoffVariable);
    expect(extractionService).not.toContain(handoffVariable);
    expect(claim).toBeGreaterThan(-1);
    expect(backup).toBeGreaterThan(claim);
    expect(restore).toBeGreaterThan(backup);
    expect(prepareFinalize).toBeGreaterThan(restore);
    expect(finalizeArgument).toBeGreaterThan(prepareFinalize);
    expect(claimFinalize).toBeGreaterThan(finalizeArgument);
    expect(common).toContain("'schema=emdo-finance-staging-finalize-input-v1'");
    expect(common).toContain('"backup_restore_receipt_sha256=$receipt_digest"');
    expect(acceptance).not.toMatch(/--(?:document|evidence)-(?:id|reference)/u);
    expect(acceptance).not.toMatch(/export FINANCE_(?:DOCUMENT|EVIDENCE)_ID/u);
    expect(acceptance).toContain(
      'clear_finance_restore_verifier_handoff "$state_dir" || true',
    );
    expect(
      verifier.indexOf('clear_finance_restore_verifier_handoff "$state_dir"'),
    ).toBeGreaterThan(verifier.indexOf('read_verifier_input "$input_file"'));
    expect(
      verifier.indexOf('clear_finance_restore_verifier_handoff "$state_dir"'),
    ).toBeLessThan(verifier.indexOf('scratch_dir="$(mktemp -d'));
    expect(workflow).toContain('finance-restore-receipt');
    expect(workflow).toContain('release/finance-staging-restore-receipt.json');
    expect(workflow).toContain(
      'JSON.stringify(value).includes("owner_cookie")',
    );
    expect(workflow).toContain(
      'JSON.stringify(value).includes("member_cookie")',
    );
    expect(operator).toContain('finance_restore_receipt_release()');
    expect(operator).toContain(
      'finance-restore-receipt) finance_restore_receipt_release',
    );
    for (const source of [acceptance, verifier, workflow, operator]) {
      expect(source).not.toContain('backup-logical.sh');
      expect(source).not.toContain('restore-drill.sh');
      expect(source).not.toContain('set -x');
    }
  });

  it('pins every operation to the exact staged run marker, secret directory, and document-store path', async () => {
    const source = await read(
      'infra/scripts/finance-staging-backup-restore.sh',
    );

    expect(source).toContain('state_dir="$STAGING_STATE_ROOT/$run_id"');
    expect(source).toContain(
      'assert_governed_parent_chain "$state_dir" "$STAGING_STATE_ROOT"',
    );
    expect(source).toContain(
      'assert_finance_synthetic_staging_state "$state_dir"',
    );
    expect(source).toContain('"$state_dir/$FINANCE_STAGING_SECRET_DIR"');
    expect(source).toContain(
      '"$state_dir/$FINANCE_STAGING_DOCUMENT_STORE_DIRNAME"',
    );
    expect(source).toContain('Finance document store must not be a symlink');
    expect(source).toContain('require_regular_file "$path"');
    expect(source).toContain('Finance document object must not be a symlink');
    expect(source).toContain(
      'Finance document object must have exactly one hard link',
    );
    expect(source).toContain('find -P "$document_store" -xdev');
    expect(source).toContain('owner_uid" == 10001');
    expect(source).toContain('owner_gid" == 10001');
  });

  it('deterministically rejects symlinked and hard-linked source objects before archiving', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emdo-finance-object-'));
    const source = await read(
      'infra/scripts/finance-staging-backup-restore.sh',
    );
    const runner = join(directory, 'object-runner.sh');
    const object = join(
      directory,
      'fd1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const hardLink = join(
      directory,
      'fd1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    const symbolicLink = join(
      directory,
      'fd1_ccccccccccccccccccccccccccccccccccccccccccc',
    );

    try {
      await writeFile(object, 'ciphertext', { mode: 0o600 });
      await link(object, hardLink);
      await symlink(object, symbolicLink);
      await writeFile(
        runner,
        `#!/usr/bin/env bash
set -Eeuo pipefail
die() { printf '%s\\n' "$*" >&2; exit 97; }
require_regular_file() { [[ -f "$1" && ! -L "$1" ]] || die 'required regular file is missing'; }
stat() { printf '%s\\n' "$FINANCE_TEST_STAT"; }
${scriptPrelude(source)}
assert_document_object "$1"
`,
        { mode: 0o700 },
      );

      const run = (path: string, stat: string) =>
        spawnSync('bash', [runner, path], {
          encoding: 'utf8',
          env: { ...process.env, FINANCE_TEST_STAT: stat },
        });

      expect(run(object, '10001 10001 600 1 10').status).toBe(0);
      const symlinked = run(symbolicLink, '10001 10001 600 1 10');
      expect(symlinked.status).toBe(97);
      expect(symlinked.stderr).toContain('required regular file is missing');
      const hardLinked = run(hardLink, '10001 10001 600 2 10');
      expect(hardLinked.status).toBe(97);
      expect(hardLinked.stderr).toContain('exactly one hard link');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('uses a root-held run key and encrypted archive, without invoking the production backup path', async () => {
    const source = await read(
      'infra/scripts/finance-staging-backup-restore.sh',
    );

    expect(source).toContain(
      "readonly FINANCE_STAGING_BACKUP_KEY_NAME='finance-staging-backup.age-key'",
    );
    expect(source).toContain('age-keygen --output "$pending_key"');
    expect(source).toContain('age-keygen -y "$finance_backup_key"');
    expect(source).toContain(
      'age --encrypt --recipients-file "$recipient_file"',
    );
    expect(source).toContain('age --decrypt --identity "$backup_key"');
    expect(source).toContain('--schema emdo --format custom --compress 9');
    expect(source).toContain('finance-document-backup-verify.sh');
    expect(source).not.toContain('backup-logical.sh');
    expect(source).not.toContain('production_compose');
    expect(source).not.toContain('PRODUCTION_STATE_DIR');
  });

  it('verifies the published checksum before decrypting a bundle and rejects tampered ciphertext archives', async () => {
    const [source, documentVerifier] = await Promise.all([
      read('infra/scripts/finance-staging-backup-restore.sh'),
      read('infra/scripts/finance-document-backup-verify.sh'),
    ]);
    const sidecars = source.indexOf('verify_backup_sidecars');
    const decrypt = source.indexOf(
      'age --decrypt --identity "$backup_key" --output "$restore_bundle_file" "$backup_file"',
    );

    expect(sidecars).toBeGreaterThan(-1);
    expect(decrypt).toBeGreaterThan(sidecars);
    expect(source).toContain('sha256sum --check --strict -');
    expect(source).toContain(
      'Finance staging backup checksum record is invalid',
    );
    expect(source).toContain(
      'Finance staging backup completion marker is invalid',
    );
    expect(documentVerifier).toContain(
      'finance document archive ciphertext hash does not match its manifest',
    );
  });

  it('fails a tampered published bundle before any decrypt command is reached', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emdo-finance-tamper-'));
    const source = await read(
      'infra/scripts/finance-staging-backup-restore.sh',
    );
    const runner = join(directory, 'verify-sidecars.sh');
    const binDirectory = join(directory, 'bin');
    const checksum = join(binDirectory, 'sha256sum');
    const bundle = join(directory, 'finance-staging-123.age');
    const expectedDigest = createHash('sha256')
      .update('original')
      .digest('hex');

    try {
      await mkdir(binDirectory);
      await writeFile(bundle, 'tampered', { mode: 0o600 });
      await writeFile(
        `${bundle}.sha256`,
        `${expectedDigest}  finance-staging-123.age\n`,
        { mode: 0o600 },
      );
      await writeFile(
        `${bundle}.complete`,
        [
          'schema=emdo-finance-staging-backup-v1',
          'bundle=finance-staging-123.age',
          `sha256=${expectedDigest}`,
          '',
        ].join('\n'),
        { mode: 0o600 },
      );
      await writeFile(
        checksum,
        `#!/usr/bin/env bash
if [[ "$1" == '--check' ]]; then
  printf 'tamper-detected\\n' >&2
  exit 1
fi
exit 96
`,
        { mode: 0o700 },
      );
      await chmod(checksum, 0o700);
      await writeFile(
        runner,
        `#!/usr/bin/env bash
set -Eeuo pipefail
die() { printf '%s\\n' "$*" >&2; exit 97; }
require_regular_file() { [[ -f "$1" && ! -L "$1" ]] || die 'required regular file is missing'; }
assert_root_owned_bounded_file() { [[ -f "$1" && -s "$1" && ! -L "$1" ]] || die 'unsafe backup file'; }
${scriptPrelude(source)}
finance_backup_root="$1"
backup_name='finance-staging-123.age'
backup_file="$finance_backup_root/$backup_name"
backup_checksum_file="$backup_file.sha256"
backup_complete_file="$backup_file.complete"
verify_backup_sidecars
`,
        { mode: 0o700 },
      );

      const result = spawnSync('bash', [runner, directory], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('tamper-detected');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('restores only into a separate Compose project and an app-readable read-only store', async () => {
    const source = await read(
      'infra/scripts/finance-staging-backup-restore.sh',
    );

    expect(source).toContain(
      'restore_project_name="emdo-finance-restore-$run_id"',
    );
    expect(source).toContain('restore_namespace="finance-restore-$run_id"');
    expect(source).toContain(
      'assert_isolated_project_absent "$restore_project_name" "$restore_namespace"',
    );
    expect(source).toContain('read_only: true');
    expect(source).toContain('chmod 0500 "$restore_document_store"');
    expect(source).toContain('chmod 0400 "$restored_object"');
    expect(source).toContain('chown 10001:10001 "$restore_document_store"');
    expect(source).toContain('restore_compose down --volumes --remove-orphans');
    expect(source).not.toContain(
      'restore_compose down --volumes --remove-orphans --timeout 30 >/dev/null 2>&1 || true',
    );
    expect(source.indexOf('restore_compose_started=true')).toBeLessThan(
      source.indexOf('restore_compose up --detach postgres'),
    );
    expect(
      source.lastIndexOf(
        'assert_isolated_project_absent "$restore_project_name" "$restore_namespace"',
      ),
    ).toBeGreaterThan(
      source.indexOf('restore_compose down --volumes --remove-orphans'),
    );
    expect(source).toContain('remove_restore_directory "$restore_root"');
    expect(source).toContain('must differ from the active staging port');
  });

  it('defines a fail-closed, content-minimized authenticated restore verifier contract', async () => {
    const source = await read(
      'infra/scripts/finance-staging-restore-verify.sh',
    );

    expect(source).toContain(
      "readonly FINANCE_RESTORE_VERIFIER_SCHEMA='emdo-finance-staging-restore-verifier-input-v1'",
    );
    for (const required of [
      'document_id',
      'evidence_id',
      'expected_plaintext_sha256',
      'owner_cookie',
      'member_cookie',
    ]) {
      expect(source).toContain(required);
    }
    expect(source).toContain('must be an exact HTTP loopback origin');
    expect(source).toContain(
      'curl --config "$owner_original_config" | sha256sum',
    );
    expect(source).toContain('committed evidence readback is invalid');
    expect(source).toContain(
      'second authenticated Finance user was not denied after restore',
    );
    expect(source).toContain('secondAuthenticatedUserDenied\\":true');
    expect(source).not.toContain('curl --cookie');
    expect(source).not.toContain('set -x');
    expect(source).not.toContain('owner_cookie\\":');
    expect(source).not.toContain('member_cookie\\":');
  });
});

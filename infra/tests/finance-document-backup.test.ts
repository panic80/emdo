import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);

const read = (path: string): Promise<string> =>
  readFile(new URL(path, root), 'utf8');

const backupScript = fileURLToPath(
  new URL('infra/scripts/backup-logical.sh', root),
);
const backupScriptSource = readFileSync(backupScript, 'utf8');
const backupValidatorSource = backupScriptSource.slice(
  backupScriptSource.indexOf('readonly finance_document_store_uid=10001'),
  backupScriptSource.indexOf("backup_capacity_lock_fd=''"),
);

const runSourceStoreValidation = (
  assertion: string,
  path: string,
  directoryStat = '10001 10001 700',
  objectStat = '10001 10001 600 1 42',
) =>
  spawnSync(
    'bash',
    [
      '-c',
      `set -Eeuo pipefail
die() {
  printf '[emdo-test] %s\\n' "$*" >&2
  exit 1
}
require_regular_file() {
  [[ -f "$1" && ! -L "$1" ]] || die "required regular file is missing: $1"
}
require_directory() {
  [[ -d "$1" && ! -L "$1" ]] || die "required directory is missing: $1"
}
${backupValidatorSource}
stat() {
  [[ "$1" == -c ]] || command stat "$@"
  case "$2" in
    '%u %g %a') printf '%s\\n' "$FINANCE_TEST_DIRECTORY_STAT" ;;
    '%u %g %a %h %s') printf '%s\\n' "$FINANCE_TEST_OBJECT_STAT" ;;
    *) command stat "$@" ;;
  esac
}
${assertion}`,
      'bash',
      path,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FINANCE_TEST_DIRECTORY_STAT: directoryStat,
        FINANCE_TEST_OBJECT_STAT: objectStat,
      },
    },
  );

describe('Finance encrypted-original backup contract', () => {
  it('allows only the app-owned source store and rejects unsafe object ownership, mode, and links', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emdo-finance-store-'));
    const object = join(
      directory,
      'fd1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const hardLinkedObject = join(
      directory,
      'fd1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    const symlinkedObject = join(
      directory,
      'fd1_ccccccccccccccccccccccccccccccccccccccccccc',
    );

    try {
      await writeFile(object, 'ciphertext', { mode: 0o600 });
      await link(object, hardLinkedObject);
      await symlink(object, symlinkedObject);

      expect(
        runSourceStoreValidation(
          'assert_finance_document_store_directory "$1"',
          directory,
        ).status,
      ).toBe(0);
      const wrongDirectoryOwner = runSourceStoreValidation(
        'assert_finance_document_store_directory "$1"',
        directory,
        '10002 10001 700',
      );
      expect(wrongDirectoryOwner.status).not.toBe(0);
      expect(wrongDirectoryOwner.stderr).toContain(
        'finance document store must be owned by 10001:10001',
      );
      const wrongDirectoryMode = runSourceStoreValidation(
        'assert_finance_document_store_directory "$1"',
        directory,
        '10001 10001 750',
      );
      expect(wrongDirectoryMode.status).not.toBe(0);
      expect(wrongDirectoryMode.stderr).toContain('must have mode 0700');

      expect(
        runSourceStoreValidation(
          'assert_finance_document_object_file "$1" 1024',
          object,
        ).status,
      ).toBe(0);
      const wrongObjectOwner = runSourceStoreValidation(
        'assert_finance_document_object_file "$1" 1024',
        object,
        undefined,
        '10001 10002 600 1 42',
      );
      expect(wrongObjectOwner.status).not.toBe(0);
      expect(wrongObjectOwner.stderr).toContain(
        'finance document object must be owned by 10001:10001',
      );
      const wrongObjectMode = runSourceStoreValidation(
        'assert_finance_document_object_file "$1" 1024',
        object,
        undefined,
        '10001 10001 640 1 42',
      );
      expect(wrongObjectMode.status).not.toBe(0);
      expect(wrongObjectMode.stderr).toContain('must have mode 0600');
      const symlinked = runSourceStoreValidation(
        'assert_finance_document_object_file "$1" 1024',
        symlinkedObject,
      );
      expect(symlinked.status).not.toBe(0);
      expect(symlinked.stderr).toContain('required regular file is missing');
      const hardLinked = runSourceStoreValidation(
        'assert_finance_document_object_file "$1" 1024',
        hardLinkedObject,
        undefined,
        '10001 10001 600 2 42',
      );
      expect(hardLinked.status).not.toBe(0);
      expect(hardLinked.stderr).toContain(
        'finance document object must have exactly one hard link',
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('accepts only the app-owned source store and one-link ciphertext objects', async () => {
    const backup = await read('infra/scripts/backup-logical.sh');

    expect(backup).toContain('finance_backup_enabled=false');
    expect(backup).toContain('if [[ -n "$finance_document_store_dir" ]]; then');
    expect(backup).toContain('/var/lib/emdo/finance-documents');
    expect(backup).toContain('readonly finance_document_store_uid=10001');
    expect(backup).toContain('readonly finance_document_store_gid=10001');
    expect(backup).toContain(
      'assert_governed_parent_chain "$finance_document_store_parent" /var/lib/emdo',
    );
    expect(backup).toContain('assert_finance_document_store_directory');
    expect(backup).toContain(
      'finance document store must be owned by ${finance_document_store_uid}:${finance_document_store_gid}',
    );
    expect(backup).toContain('must have mode 0700');
    expect(backup).toContain("finance_object_name_pattern='^fd1_");
    expect(backup).toContain('assert_finance_document_object_file');
    expect(backup).toContain('require_regular_file "$path"');
    expect(backup).toContain(
      'finance document object must be owned by ${finance_document_store_uid}:${finance_document_store_gid}',
    );
    expect(backup).toContain('finance document object must have mode 0600');
    expect(backup).toContain('[[ "$links" == 1 ]]');
    expect(backup).toContain('must have exactly one hard link');
    expect(backup).not.toContain(
      'assert_root_owned_nonwritable_directory "$finance_document_store_dir"',
    );
  });

  it('backs up only validated opaque ciphertext objects in a normalized root-owned archive', async () => {
    const [backup, verifier] = await Promise.all([
      read('infra/scripts/backup-logical.sh'),
      read('infra/scripts/finance-document-backup-verify.sh'),
    ]);

    expect(backup).toContain('--no-recursion --verbatim-files-from');
    expect(backup).toContain('emdo-finance-document-backup-v1');
    expect(backup).toContain(
      'tar --sort=name --owner=0 --group=0 --numeric-owner --mode=0600 --mtime=@0',
    );
    expect(backup).toContain(
      'finance-documents.manifest finance-documents.tar',
    );
    expect(backup).toContain('verify-archive');
    expect(backup).not.toContain('age --decrypt');
    expect(verifier).toContain(
      'assert_root_owned_bounded_file "$archive" 600 "$FINANCE_MAX_ARCHIVE_BYTES"',
    );
  });

  it('accepts legacy three-entry bundles but requires the finance pair together', async () => {
    const restore = await read('infra/scripts/restore-drill.sh');

    expect(restore).toContain(
      'Pre-Finance bundles have exactly the original three entries',
    );
    expect(restore).toContain('3)');
    expect(restore).toContain('5)');
    expect(restore).toContain('finance document entries are incomplete');
    expect(restore).toContain(
      'finance-documents.manifest | finance-documents.tar',
    );
    expect(restore).toContain('RESTORE_FINANCE_DOCUMENT_STORE_DIR is required');
    expect(restore).toContain('/var/lib/emdo/restore/$restore_id');
    expect(restore).toContain(
      'must be the exact run-scoped finance restore directory',
    );
    expect(restore).toContain('must be absent and run-scoped');
    expect(restore).toContain('restore-archive');
    expect(restore).toContain('finance_objects=$finance_restore_object_count');
  });

  it('rejects unsafe document archives and permits hash-only readback verification', async () => {
    const verifier = await read(
      'infra/scripts/finance-document-backup-verify.sh',
    );

    expect(verifier).toContain("FINANCE_OBJECT_NAME_PATTERN='^fd1_");
    expect(verifier).toContain(
      '[[ "$mode" == \'-rw-------\' && "$owner" == 0/0 ]]',
    );
    expect(verifier).toContain('duplicate object entries');
    expect(verifier).toContain('object absent from its manifest');
    expect(verifier).toContain('ciphertext hash does not match its manifest');
    expect(verifier).toContain(
      'restore destination must be absent and run-scoped',
    );
    expect(verifier).toContain('verify-readback');
    expect(verifier).toContain(
      'caller-supplied finance document readback hash does not match',
    );
    expect(verifier).not.toContain('age --decrypt');
  });
});

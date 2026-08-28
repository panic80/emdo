import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const scriptPath = fileURLToPath(
  new URL('infra/scripts/run-staging-acceptance.sh', root),
);

const extractionDiagnostic = (source: string): string => {
  const start = source.indexOf(
    'finance_extraction_terminal_failure_diagnostic() {',
  );
  const end = source.indexOf('\n}\n\nassert_compose_healthy', start);
  if (start < 0 || end < 0)
    throw new Error('Finance extraction diagnostic function missing');
  return source.slice(start, end + 2);
};

describe('Finance staging extraction terminal diagnostic', () => {
  it.each([
    'worker-provider-network-unavailable',
    'worker-provider-rate-limited',
    'worker-provider-server-error',
    'worker-lease-expired',
  ])(
    'accepts the new diagnostic code %s and emits only the fixed line',
    async (safeErrorCode) => {
      const source = extractionDiagnostic(await readFile(scriptPath, 'utf8'));
      const directory = await mkdtemp(
        join(tmpdir(), 'emdo-finance-diagnostic-'),
      );
      const inputPath = join(directory, 'acceptance.stderr');
      await writeFile(
        inputPath,
        [
          'content-free compose status',
          'Staging acceptance failed at stage=document-extraction-terminal.',
          '',
        ].join('\n'),
      );
      try {
        const result = spawnSync(
          'bash',
          [
            '-c',
            `set -Eeuo pipefail
staging_compose() { printf '%s' "$FINANCE_TEST_QUERY_OUTPUT"; }
${source}
finance_extraction_terminal_failure_diagnostic "$1"`,
            '_',
            inputPath,
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              FINANCE_TEST_QUERY_OUTPUT: `${safeErrorCode}|2\n`,
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe(
          `Staging acceptance failed at stage=document-extraction-terminal outcome=${safeErrorCode} attempt=2.\n`,
        );
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  );

  it('fails closed without reflecting unallowlisted query values', async () => {
    const source = extractionDiagnostic(await readFile(scriptPath, 'utf8'));
    const directory = await mkdtemp(join(tmpdir(), 'emdo-finance-diagnostic-'));
    const inputPath = join(directory, 'acceptance.stderr');
    const secret =
      'provider-request-id=secret-request-id document-id=secret-document-id';
    await writeFile(
      inputPath,
      'Staging acceptance failed at stage=document-extraction-terminal.\n',
    );
    try {
      for (const queryOutput of [
        `${secret}|1\n`,
        'worker-provider-network-unavailable:retrying|1\n',
        'worker-provider-network-unavailable|1|provider-request-id=secret-request-id\n',
        'worker-timeout|3\n',
      ]) {
        const result = spawnSync(
          'bash',
          [
            '-c',
            `set -Eeuo pipefail
staging_compose() { printf '%s' "$FINANCE_TEST_QUERY_OUTPUT"; }
${source}
finance_extraction_terminal_failure_diagnostic "$1"`,
            '_',
            inputPath,
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              FINANCE_TEST_QUERY_OUTPUT: queryOutput,
            },
          },
        );
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
        expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

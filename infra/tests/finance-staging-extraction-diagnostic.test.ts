import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

const stagingAcceptanceDiagnostic = (source: string): string => {
  const start = source.indexOf(
    'finance_staging_acceptance_failure_diagnostic() {',
  );
  const end = source.indexOf('\n}\n\nassert_compose_healthy', start);
  if (start < 0 || end < 0)
    throw new Error('Finance staging acceptance diagnostic function missing');
  return source.slice(start, end + 2);
};

const stagingFailure = (stage: string): string =>
  `Staging acceptance failed at stage=${stage}.`;

const runStagingAcceptanceDiagnostic = (source: string, inputPath: string) =>
  spawnSync(
    'bash',
    [
      '-c',
      `set -Eeuo pipefail
${source}
finance_staging_acceptance_failure_diagnostic "$1"`,
      '_',
      inputPath,
    ],
    { encoding: 'utf8' },
  );

describe('Finance staging extraction terminal diagnostic', () => {
  it.each([
    'worker-completion-rejected',
    'worker-document-metadata-invalid',
    'worker-extraction-failed',
    'worker-extraction-invalid',
    'worker-interrupted',
    'worker-invalid-claim',
    'worker-lease-expired',
    'worker-original-integrity-invalid',
    'worker-original-unavailable',
    'worker-payload-encryption-failed',
    'worker-provider-credential-unavailable',
    'worker-provider-network-unavailable',
    'worker-provider-credit-balance-exhausted',
    'worker-provider-organization-spend-limit-exceeded',
    'worker-provider-organization-usage-limit-exceeded',
    'worker-provider-project-spend-limit-exceeded',
    'worker-provider-quota-exhausted',
    'worker-provider-rate-limit-unclassified',
    'worker-provider-rate-limited',
    'worker-provider-rejected',
    'worker-provider-request-invalid',
    'worker-provider-response-invalid',
    'worker-provider-server-error',
    'worker-provider-unavailable',
    'worker-timeout',
  ])(
    'accepts the allowlisted worker diagnostic code %s and emits only the fixed line',
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

  it('attributes an extraction failure only to the exact current synthetic PDF revision', async () => {
    const source = await readFile(scriptPath, 'utf8');
    expect(source).toContain('INNER JOIN emdo.finance_documents AS document');
    expect(source).toContain('document.household_id = extraction.household_id');
    expect(source).toContain('document.space_id = extraction.space_id');
    expect(source).toContain(
      'document.original_owner_user_id = extraction.original_owner_user_id',
    );
    expect(source).toContain('document.id = extraction.document_id');
    expect(source).toContain(
      "document.display_name = 'emdo-synthetic-staging.pdf'",
    );
    expect(source).toContain("document.mime_type = 'application/pdf'");
    expect(source).toContain('document.byte_size = 683');
    expect(source).toContain(
      "document.plaintext_sha256 = '8d85942e0ee04fcfa42b1690e07844e7ac1a193fc15c149f9e27b989c77332e1'",
    );
    expect(source).toContain("document.state = 'failed'");
    expect(source).toContain(
      'document.extraction_revision = extraction.revision',
    );
    expect(source).toContain("extraction.state = 'failed'");
    expect(source).toContain(
      'ORDER BY extraction.completed_at DESC, extraction.id DESC',
    );
  });

  it('fails closed without reflecting unallowlisted query values', async () => {
    const source = extractionDiagnostic(await readFile(scriptPath, 'utf8'));
    const directory = await mkdtemp(join(tmpdir(), 'emdo-finance-diagnostic-'));
    const inputPath = join(directory, 'acceptance.stderr');
    const secret =
      'provider-id=secret-provider document-id=secret-document request-id=secret-request body=secret-body arbitrary-code=secret-code';
    await writeFile(
      inputPath,
      'Staging acceptance failed at stage=document-extraction-terminal.\n',
    );
    try {
      for (const queryOutput of [
        `${secret}|1\n`,
        'worker-provider-network-unavailable:retrying|1\n',
        'worker-provider-credit-balance-exhausted-suffixed|1\n',
        'worker-provider-organization-spend-limit-exceeded|0\n',
        'worker-provider-organization-usage-limit-exceeded|3\n',
        'worker-provider-project-spend-limit-exceeded|01\n',
        'worker-provider-quota-exhausted|2:retrying\n',
        'worker-provider-rate-limit-unclassified|unknown\n',
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

describe('Finance staging acceptance failure diagnostic', () => {
  const stages = [
    'configuration',
    'health-and-contract',
    'owner-authentication',
    'member-invitation',
    'member-token-handoff',
    'member-redemption',
    'member-membership-readback',
    'member-authentication',
    'document-upload',
    'document-extraction-terminal',
    'document-original-readback',
    'document-review-read-edit',
    'document-direct-commit-denial',
    'guarded-review-commit',
    'guarded-delete-denial',
    'qna-and-isolation',
    'safe-write-and-handoff',
    'finalize-configuration',
    'finalize-attestation',
    'finalize-health-and-contract',
    'finalize-owner-authentication',
    'finalize-member-authentication',
    'finalize-document-and-evidence',
    'finalize-guarded-delete',
    'finalize-purge-and-revocation',
  ];
  const memberInvitationOutcomes = [
    'request-or-network-failed',
    'http-401-authentication-required',
    'http-401-authentication-invalid',
    'http-400-invalid-input',
    'http-403-mutation-proof-invalid',
    'http-403-household-owner-required',
    'http-403-authorization-revoked',
    'http-409-conflict',
    'http-500-internal-error',
    'http-502-service-contract-invalid',
    'http-503-authentication-unavailable',
    'http-503-mutation-verification-unavailable',
    'http-503-invalid-result',
    'http-problem-unrecognized',
    'readback-invalid',
  ];
  const documentUploadOutcomes = [
    'request-or-network-failed',
    'http-400-request-header-invalid',
    'http-400-idempotency-key-required',
    'http-400-request-validation-failed',
    'http-400-invalid-input',
    'http-401-authentication-required',
    'http-401-authentication-invalid',
    'http-403-mutation-proof-invalid',
    'http-403-authorization-revoked',
    'http-404-document-not-found',
    'http-409-idempotency-conflict',
    'http-409-duplicate-document',
    'http-409-document-state-conflict',
    'http-413-finance-document-too-large',
    'http-413-request-body-too-large',
    'http-413-quota-exceeded',
    'http-415-unsupported-media-type',
    'http-500-internal-error',
    'http-502-service-contract-invalid',
    'http-503-authentication-unavailable',
    'http-503-mutation-verification-unavailable',
    'http-503-finance-documents-unavailable',
    'http-problem-unrecognized',
    '201-json-or-schema-invalid',
    'synthetic-metadata-or-hash-mismatch',
  ];
  const acceptedFailures = [
    ...stages.map(stagingFailure),
    ...memberInvitationOutcomes.map((outcome) =>
      stagingFailure(`member-invitation outcome=${outcome}`),
    ),
    ...documentUploadOutcomes.map((outcome) =>
      stagingFailure(`document-upload outcome=${outcome}`),
    ),
  ];

  it.each(acceptedFailures)(
    'accepts the finite CLI failure line %s without reflecting any other content',
    async (failure) => {
      const source = stagingAcceptanceDiagnostic(
        await readFile(scriptPath, 'utf8'),
      );
      const directory = await mkdtemp(
        join(tmpdir(), 'emdo-finance-acceptance-diagnostic-'),
      );
      const inputPath = join(directory, 'acceptance.stderr');
      await writeFile(inputPath, `${failure}\n`);
      try {
        const result = runStagingAcceptanceDiagnostic(source, inputPath);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe(`${failure}\n`);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  );

  it('uses the generic terminal-stage marker when extraction database classification fails', async () => {
    const source = extractionDiagnostic(await readFile(scriptPath, 'utf8'));
    const directory = await mkdtemp(
      join(tmpdir(), 'emdo-finance-acceptance-diagnostic-'),
    );
    const inputPath = join(directory, 'acceptance.stderr');
    const failure = stagingFailure('document-extraction-terminal');
    await writeFile(inputPath, `${failure}\n`);
    try {
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -Eeuo pipefail
staging_compose() { return 1; }
${source}
if ! finance_extraction_terminal_failure_diagnostic "$1" &&
  ! finance_staging_acceptance_failure_diagnostic "$1"; then
  printf '%s\\n' 'Staging acceptance failed.' >&2
fi
exit 43`,
          '_',
          inputPath,
        ],
        { encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(43);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`${failure}\n`);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('ignores opaque compose and secret noise while emitting only one safe marker', async () => {
    const source = stagingAcceptanceDiagnostic(
      await readFile(scriptPath, 'utf8'),
    );
    const directory = await mkdtemp(
      join(tmpdir(), 'emdo-finance-acceptance-diagnostic-'),
    );
    const inputPath = join(directory, 'acceptance.stderr');
    const safeFailure = stagingFailure('member-invitation');
    const secret =
      'cookie=secret-cookie request-id=secret-request document-id=secret-document provider-body=secret-body arbitrary-code=secret-code';
    try {
      for (const input of [
        `content-free compose status\n${safeFailure}\n`,
        `${secret}\n${safeFailure}\n`,
        `${safeFailure}\n${secret}\n`,
      ]) {
        await writeFile(inputPath, input);
        const result = runStagingAcceptanceDiagnostic(source, inputPath);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe(`${safeFailure}\n`);
        expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('fails closed for altered, duplicate, missing, oversized, and symlinked markers', async () => {
    const source = stagingAcceptanceDiagnostic(
      await readFile(scriptPath, 'utf8'),
    );
    const directory = await mkdtemp(
      join(tmpdir(), 'emdo-finance-acceptance-diagnostic-'),
    );
    const inputPath = join(directory, 'acceptance.stderr');
    const targetPath = join(directory, 'acceptance-target.stderr');
    const safeFailure = stagingFailure('member-invitation');
    const secret =
      'cookie=secret-cookie request-id=secret-request document-id=secret-document provider-body=secret-body arbitrary-code=secret-code';
    try {
      for (const input of [
        `prefix ${safeFailure}\n`,
        `${safeFailure} suffix\n`,
        `${safeFailure}\n${safeFailure}\n`,
        `${safeFailure}\n${safeFailure}`,
        `${safeFailure}\n${stagingFailure('configuration')}\n`,
        `${safeFailure} extra=value\n`,
        `${safeFailure}`,
        `${secret}\n`,
        `content-free compose status\n${secret}\n`,
        `${safeFailure}\n${secret}`,
        `${'x'.repeat(4097)}\n`,
      ]) {
        await writeFile(inputPath, input);
        const result = runStagingAcceptanceDiagnostic(source, inputPath);
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
        expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
      }

      await writeFile(targetPath, `${safeFailure}\n`);
      await rm(inputPath);
      await symlink(targetPath, inputPath);
      const result = runStagingAcceptanceDiagnostic(source, inputPath);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  chmod,
  readFile,
  writeFile,
  realpath,
  rm,
  symlink,
  link,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runStagingAcceptanceCommand,
  waitForNormalizedAuthoredReview,
  validateNormalizedAuthoredReview,
  validateNormalizedSyntheticSourceReview,
  validateNormalizedSyntheticEmdoReadback,
} from './staging-acceptance.js';
const id = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f94';
const candidate = () => ({
  id,
  revision: 1,
  version: 1,
  provider_key: 'synthetic',
  status: 'candidate',
  definition: {
    providerKey: 'synthetic',
    reportName: 'Authored synthetic CSV',
    reportType: 'bank-transactions',
    layoutVersion: '1',
    dateFormat: 'yyyy-mm-dd',
    decimalSeparator: '.',
    groupingSeparator: '',
    quantityUnit: null,
    valuationMultiplier: null,
    identifierScheme: null,
    identifierNamespace: null,
    headers: ['Booked on', 'Details', 'Net cash', 'CCY'],
    bindings: ['transactionDate', 'description', 'amount', 'currency'].map(
      (field, index) => ({
        field,
        column: ['Booked on', 'Details', 'Net cash', 'CCY'][index],
        context: null,
      }),
    ),
  },
  unresolved_questions: [
    'Source extraction is incomplete; review the original before approval.',
  ],
  example: {
    documentId: id,
    headers: ['Booked on', 'Details', 'Net cash', 'CCY'],
    context: { asOf: null, currency: null },
    rows: [
      {
        sourceRow: 2,
        cells: ['2026-09-15', 'Synthetic service receipt', '123.45', 'CAD'],
      },
      {
        sourceRow: 3,
        cells: ['2026-09-16', 'Synthetic purchase', '-67.89', 'CAD'],
      },
    ],
  },
  validation: {
    status: 'normalized',
    rows: [
      {
        fields: {
          transactionDate: '2026-09-15',
          description: 'Synthetic service receipt',
          amount: '123.45',
          currency: 'CAD',
        },
      },
      {
        fields: {
          transactionDate: '2026-09-16',
          description: 'Synthetic purchase',
          amount: '-67.89',
          currency: 'CAD',
        },
      },
    ],
  },
});
describe('normalized staging acceptance boundaries', () => {
  it('recognizes the authored source completeness answer only after every source cell matches', () => {
    expect(validateNormalizedSyntheticSourceReview(candidate(), id).id).toBe(
      id,
    );
    const altered = candidate();
    altered.example.rows[1]!.cells[2] = '67.89';
    expect(() => validateNormalizedSyntheticSourceReview(altered, id)).toThrow(
      'source-review-mismatch',
    );
  });
  it('does not invent answers to unfamiliar model questions', () => {
    const raw = candidate();
    raw.unresolved_questions = ['Which tax rate applies to this receipt?'];
    expect(() => validateNormalizedSyntheticSourceReview(raw, id)).toThrow(
      'unknown-question',
    );
  });
  it('rejects normalized amount changes and omitted source rows', () => {
    const raw = candidate();
    raw.validation.rows[1]!.fields.amount = '67.89';
    expect(() => validateNormalizedSyntheticSourceReview(raw, id)).toThrow(
      'mismatch',
    );
    const omitted = candidate();
    omitted.example.rows.pop();
    expect(() => validateNormalizedSyntheticSourceReview(omitted, id)).toThrow(
      'mismatch',
    );
  });
  it('requires explicit provisioned synthetic opt-in before making requests', async () => {
    const request = vi.fn();
    await expect(
      runStagingAcceptanceCommand({
        argv: [
          '--all-mvp-gates',
          '--require-synthetic',
          '--finance-normalized-synthetic-gates',
        ],
        environment: {},
        fetch: request,
      }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

it('accepts production-shaped row, journal and line records and rejects altered posting lineage', () => {
  const rows = [0, 1].map((index) => ({
    id: `row-${index}`,
    amount: index ? '-67.890000000000' : '123.450000000000',
    posting: {
      journalId: `journal-${index}`,
      economicTransactionId: `economic-${index}`,
      lines: [
        {
          accountId: 'cash',
          side: index ? 'credit' : 'debit',
          amount: index ? '67.890000000000' : '123.450000000000',
        },
        {
          accountId: 'counter',
          side: index ? 'debit' : 'credit',
          amount: index ? '67.890000000000' : '123.450000000000',
        },
      ],
    },
  }));
  const record = (recordId: string, fields: Record<string, string>) => ({
    id: recordId,
    fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
  });
  const records = rows.flatMap((row) => [
    record(row.id, {
      amount: row.amount,
      evidenceId: id,
      batchId: id,
      economicTransactionId: row.posting.economicTransactionId,
    }),
    record(`${row.id}:journal:${row.posting.journalId}`, {
      journalId: row.posting.journalId,
      economicTransactionId: row.posting.economicTransactionId,
    }),
    ...row.posting.lines.map((line, index) =>
      record(`${row.id}:journal:${row.posting.journalId}:line:${index + 1}`, {
        ...line,
        journalId: row.posting.journalId,
      }),
    ),
  ]);
  const page = {
    schemaVersion: 1,
    bookId: id,
    currency: 'CAD',
    view: 'import-review',
    amountEncoding: 'decimal-string',
    nextOffset: null,
    records,
    sourceReferences: records.map(
      (r) => `/api/v2/finance/books/${id}/imports/${id}#${r.id}`,
    ),
  };
  expect(() =>
    validateNormalizedSyntheticEmdoReadback(page, id, id, id, rows),
  ).not.toThrow();
  records[2]!.fields.find((field) => field.name === 'amount')!.value = '999.00';
  expect(() =>
    validateNormalizedSyntheticEmdoReadback(page, id, id, id, rows),
  ).toThrow('lineage-mismatch');
});

const future = '2099-01-01T00:00:00.000Z';
const binding = () => ({
  runId: id,
  bookId: id,
  evidenceId: id,
  sourceDigest: 'a'.repeat(64),
  mappingId: id,
  mappingRevision: 1,
  mappingVersion: 1,
  mappingDefinitionDigest: 'b'.repeat(64),
  challenge: id,
  expiresAt: future,
  questions: ['An unfamiliar source question?', 'Another source question?'],
});
const authored = (value = binding()) => ({
  schemaVersion: 1,
  decision: 'approve-authored-synthetic-mapping',
  binding: value,
  answers: value.questions.map((question) => ({
    question,
    answer:
      'Explicit test author response against the complete synthetic source.',
  })),
  rationale:
    'The test author reviewed the complete synthetic original and all questions.',
});
async function withPrivateDirectory(
  work: (directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), 'normalized-review-'),
  );
  try {
    await chmod(directory, 0o700);
    await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const reviewInput = (directory: string) => ({
  directory,
  runId: id,
  bookId: id,
  evidenceId: id,
  mapping: { ...candidate(), unresolved_questions: binding().questions },
});
async function reviewFromRequest(directory: string) {
  const request = JSON.parse(
    await readFile(join(directory, `${id}.request.json`), 'utf8'),
  ) as { binding: ReturnType<typeof binding> };
  return authored(request.binding);
}
describe('explicit normalized authored review', () => {
  it('binds unfamiliar answers exactly without relaxing the default question gate', () => {
    expect(
      validateNormalizedAuthoredReview(authored(), binding()).answers,
    ).toHaveLength(2);
    expect(() =>
      validateNormalizedSyntheticSourceReview(
        reviewInput('/unused').mapping,
        id,
      ),
    ).toThrow('unknown-question');
    for (const field of [
      'runId',
      'bookId',
      'evidenceId',
      'mappingId',
      'challenge',
    ] as const) {
      const wrong = authored();
      wrong.binding[field] = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f95';
      expect(() => validateNormalizedAuthoredReview(wrong, binding())).toThrow(
        'binding-mismatch',
      );
    }
    for (const field of ['sourceDigest', 'mappingDefinitionDigest'] as const) {
      const wrong = authored();
      wrong.binding[field] = 'c'.repeat(64);
      expect(() => validateNormalizedAuthoredReview(wrong, binding())).toThrow(
        'binding-mismatch',
      );
    }
    const stale = authored();
    stale.binding.mappingRevision++;
    expect(() => validateNormalizedAuthoredReview(stale, binding())).toThrow(
      'binding-mismatch',
    );
    expect(() =>
      validateNormalizedAuthoredReview(
        authored(),
        binding(),
        Date.parse(future),
      ),
    ).toThrow('expired');
  });
  it('rejects missing, duplicate, reordered or changed questions and blank author responses', () => {
    for (const mutate of [
      (value: ReturnType<typeof authored>) => {
        value.answers.pop();
      },
      (value: ReturnType<typeof authored>) => {
        value.answers.reverse();
      },
      (value: ReturnType<typeof authored>) => {
        value.answers[1] = value.answers[0]!;
      },
      (value: ReturnType<typeof authored>) => {
        value.answers[0]!.question = 'Unbound question';
      },
      (value: ReturnType<typeof authored>) => {
        value.answers[0]!.answer = '   ';
      },
    ]) {
      const value = authored();
      mutate(value);
      expect(() =>
        validateNormalizedAuthoredReview(value, binding()),
      ).toThrow();
    }
    expect(() =>
      validateNormalizedAuthoredReview(
        { ...authored(), decision: 'approve' },
        binding(),
      ),
    ).toThrow();
  });
  it('pauses the same run and consumes a private exact review, retaining a receipt digest', async () => {
    await withPrivateDirectory(async (directory) => {
      const pending = vi.fn();
      const pause = vi.fn(async () => {
        await writeFile(
          join(directory, `${id}.review.json`),
          JSON.stringify(await reviewFromRequest(directory)),
          { mode: 0o600 },
        );
      });
      const result = await waitForNormalizedAuthoredReview({
        ...reviewInput(directory),
        onPending: pending,
        sleep: pause,
      });
      expect(pause).toHaveBeenCalledTimes(1);
      expect(pending).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: id,
          reviewPath: join(directory, `${id}.review.json`),
        }),
      );
      const receipt = JSON.parse(await readFile(result.acceptedPath, 'utf8'));
      expect(receipt.review.binding.runId).toBe(id);
      expect(receipt.reviewSha256).toBe(result.reviewSha256);
      expect(result.rationale).toContain(result.reviewSha256);
      expect(receipt.review.answers).toHaveLength(2);
      await expect(
        waitForNormalizedAuthoredReview(reviewInput(directory)),
      ).rejects.toThrow(); // Cannot overwrite/replay this challenge.
    });
  });
  it('rejects an altered synthetic source before issuing any review challenge', async () => {
    await withPrivateDirectory(async (directory) => {
      const raw = reviewInput(directory);
      raw.mapping.example.rows[0]!.cells[2] = '1000.00';
      await expect(waitForNormalizedAuthoredReview(raw)).rejects.toThrow(
        'source-review-mismatch',
      );
      await expect(
        readFile(join(directory, `${id}.request.json`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
  it('requires a canonical owned 0700 directory', async () => {
    await expect(
      waitForNormalizedAuthoredReview(reviewInput('relative')),
    ).rejects.toThrow('canonical-directory');
    await withPrivateDirectory(async (directory) => {
      await chmod(directory, 0o755);
      await expect(
        waitForNormalizedAuthoredReview(reviewInput(directory)),
      ).rejects.toThrow('private-directory');
      await chmod(directory, 0o700);
      const alias = directory + '-alias';
      try {
        await symlink(directory, alias);
        await expect(
          waitForNormalizedAuthoredReview(reviewInput(alias)),
        ).rejects.toThrow('canonical-directory');
      } finally {
        await rm(alias, { force: true });
      }
    });
  });
  it.each([
    'public',
    'symlink',
    'hardlink',
    'directory',
    'oversized',
    'malformed',
    'stale',
  ] as const)('fails closed on %s review files', async (kind) => {
    await withPrivateDirectory(async (directory) => {
      await expect(
        waitForNormalizedAuthoredReview({
          ...reviewInput(directory),
          sleep: async () => {
            const path = join(directory, `${id}.review.json`);
            const value = await reviewFromRequest(directory);
            if (kind === 'stale')
              value.binding.challenge = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f95';
            if (kind === 'directory') await mkdir(path, { mode: 0o700 });
            else if (kind === 'symlink' || kind === 'hardlink') {
              const target = join(directory, 'target');
              await writeFile(target, JSON.stringify(value), { mode: 0o600 });
              if (kind === 'symlink') await symlink(target, path);
              else await link(target, path);
            } else {
              await writeFile(
                path,
                kind === 'oversized'
                  ? 'x'.repeat(32769)
                  : kind === 'malformed'
                    ? '{'
                    : JSON.stringify(value),
                { mode: kind === 'public' ? 0o644 : 0o600 },
              );
              if (kind === 'public') await chmod(path, 0o644);
            }
          },
        }),
      ).rejects.toThrow();
      await expect(
        readFile(join(directory, `${id}.accepted.json`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
  it('bounds the same-process wait without resubmitting work', async () => {
    await withPrivateDirectory(async (directory) => {
      const sleep = vi.fn(async () => undefined);
      await expect(
        waitForNormalizedAuthoredReview({ ...reviewInput(directory), sleep }),
      ).rejects.toThrow('timeout');
      expect(sleep).toHaveBeenCalledTimes(360);
    });
  });
});

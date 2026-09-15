import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceContext } from '@emdo/contracts';
import type { DatabaseClient, DatabasePool } from './scoped-repository.js';
import { PostgresFranceFecRepository } from './finance-fec-repository.js';

const workspaceId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70';
const userId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71';
const sessionId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f72';
const requestId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f73';
const bookId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f74';
const context: WorkspaceContext = {
  workspaceId,
  userId,
  sessionId,
  requestId,
};

const digest = 'b'.repeat(64);

const result = (rows: readonly Record<string, unknown>[] = []) => ({
  rows,
  rowCount: rows.length,
});

const setup = (query: string): boolean => {
  const lower = query.toLowerCase();
  return (
    lower === 'begin' ||
    lower === 'commit' ||
    lower === 'rollback' ||
    lower.startsWith('set local') ||
    lower.includes('select set_config') ||
    lower.includes('lock_active_request_scope')
  );
};

function mappedLedgerRows() {
  return [
    {
      journal_id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f80',
      accounting_date: '2025-01-01',
      source_reference: 'journal:opening',
      payload_hash: digest,
      line_id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f81',
      line_number: 1,
      side: 'debit',
      amount: '100.50',
      native_amount: '100.50',
      currency: 'EUR',
      entry_sequence: 1,
      entry_number: '1',
      entry_kind: 'opening',
      journal_code: 'AN',
      journal_label: 'A-nouveaux',
      piece_reference: 'OB-2025',
      piece_date: '2025-01-01',
      entry_label: 'Opening balances',
      validation_date: '2025-01-01',
      account_number: '512000',
      account_label: 'Bank',
      auxiliary_account_number: null,
      auxiliary_account_label: null,
      lettering: null,
      lettering_date: null,
    },
    {
      journal_id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f80',
      accounting_date: '2025-01-01',
      source_reference: 'journal:opening',
      payload_hash: digest,
      line_id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f82',
      line_number: 2,
      side: 'credit',
      amount: '100.50',
      native_amount: '100.50',
      currency: 'EUR',
      entry_sequence: 1,
      entry_number: '1',
      entry_kind: 'opening',
      journal_code: 'AN',
      journal_label: 'A-nouveaux',
      piece_reference: 'OB-2025',
      piece_date: '2025-01-01',
      entry_label: 'Opening balances',
      validation_date: '2025-01-01',
      account_number: '101000',
      account_label: 'Capital',
      auxiliary_account_number: null,
      auxiliary_account_label: null,
      lettering: null,
      lettering_date: null,
    },
  ];
}

function createClient(
  options: {
    receipt?: Record<string, unknown>;
    journalCount?: number;
    rows?: Record<string, unknown>[];
  } = {},
) {
  const queries: string[] = [];
  const client: DatabaseClient = {
    query: vi.fn(async (query: string) => {
      queries.push(query);
      const lower = query.toLowerCase();
      if (setup(query)) {
        if (lower.includes('lock_active_request_scope'))
          return result([{ authorized: true }]);
        return result();
      }
      if (lower.includes('lock_finance_book_grant'))
        return result([{ allowed: true }]);
      if (lower.includes('from emdo.finance_books'))
        return result([{ functionalCurrency: 'EUR', role: 'viewer' }]);
      if (lower.includes('pg_advisory_xact_lock')) return result();
      if (lower.includes('from emdo.finance_fec_export_receipts'))
        return result(options.receipt ? [options.receipt] : []);
      if (lower.includes('from emdo.finance_fec_book_mapping_revisions'))
        return result([
          {
            siren: '123456789',
            sirenSourceReference: 'legal-entity:siren',
            sirenSourceDigest: digest,
            openingStatus: 'included',
            openingSourceReference: 'opening:review',
            openingSourceDigest: digest,
          },
        ]);
      if (lower.includes('count(distinct j.id)'))
        return result([{ count: options.journalCount ?? 1 }]);
      if (lower.includes('from emdo.finance_journals j'))
        return result(options.rows ?? mappedLedgerRows());
      if (lower.startsWith('insert into emdo.finance_fec_export_receipts'))
        return result();
      throw new Error(`Unexpected query: ${query}`);
    }),
    release: vi.fn(),
  };
  return { client, queries };
}

describe('PostgresFranceFecRepository', () => {
  it('checks forced-RLS mapping/receipt tables and restricted role readiness', async () => {
    const client: DatabaseClient = {
      query: vi.fn(async () =>
        result([{ fec_rls: true, restricted_role: true }]),
      ),
      release: vi.fn(),
    };
    const pool: DatabasePool = { connect: vi.fn(async () => client) };
    const repository = new PostgresFranceFecRepository(pool);

    await expect(repository.checkReady()).resolves.toBe(true);
    expect(String(vi.mocked(client.query).mock.calls[0]?.[0])).toContain(
      'relforcerowsecurity',
    );

    vi.mocked(client.query).mockResolvedValueOnce(
      result([{ fec_rls: false, restricted_role: true }]),
    );
    await expect(repository.checkReady()).resolves.toBe(false);
  });

  it('reads only posted ledger values and reviewed mappings under the canonical book lock', async () => {
    const { client, queries } = createClient();
    const pool: DatabasePool = { connect: vi.fn(async () => client) };
    const repository = new PostgresFranceFecRepository(pool);
    const exportResult = await repository.export(context, bookId, {
      startsOn: '2025-01-01',
      endsOn: '2025-12-31',
      mappingRevision: 1,
      idempotencyKey: 'fec-2025',
    });

    expect(exportResult.status).toBe('ready');
    if (exportResult.status !== 'ready') throw new Error('expected-fec-ready');
    expect(exportResult.file.content).toContain('AN\tA-nouveaux\t1\t20250101');
    expect(exportResult.sourceLineage).toHaveLength(2);
    expect(
      queries.some((query) => query.includes('lock_finance_book_grant')),
    ).toBe(true);
    expect(
      queries.some((query) => query.includes('pg_advisory_xact_lock')),
    ).toBe(true);
    const ledgerQuery = queries.find(
      (query) =>
        query.includes('from emdo.finance_journals j') &&
        query.includes('jm.entry_sequence'),
    );
    expect(ledgerQuery).toBeDefined();
    expect(ledgerQuery).toContain("j.status='posted'");
    expect(ledgerQuery).toContain('jm.revision=$5');
    expect(ledgerQuery).toContain('am.revision=$5');
    expect(ledgerQuery).toContain('null::text as lettering');
    expect(ledgerQuery).not.toContain('coalesce(jm.journal_code');
  });

  it('replays the immutable result for the same scoped idempotency request', async () => {
    const first = createClient();
    const firstPool: DatabasePool = {
      connect: vi.fn(async () => first.client),
    };
    const repository = new PostgresFranceFecRepository(firstPool);
    const request = {
      startsOn: '2025-01-01',
      endsOn: '2025-12-31',
      mappingRevision: 1,
      idempotencyKey: 'fec-replay',
    };
    const saved = await repository.export(context, bookId, request);
    expect(saved.status).toBe('ready');
    if (saved.status !== 'ready') throw new Error('expected-saved-fec');

    const replay = createClient({
      receipt: {
        request_hash: 'placeholder',
        result_hash: 'placeholder',
        result: saved,
      },
    });
    // The request hash is deterministic and is intentionally read from the
    // first query rather than supplied as a financial or legal input.
    const requestHash = vi
      .mocked(first.client.query)
      .mock.calls.find(([query]) =>
        String(query)
          .toLowerCase()
          .includes('insert into emdo.finance_fec_export_receipts'),
      )?.[1] as readonly unknown[];
    replay.client.query = vi.fn(
      async (query: string, values?: readonly unknown[]) => {
        const lower = query.toLowerCase();
        if (setup(query)) {
          if (lower.includes('lock_active_request_scope'))
            return result([{ authorized: true }]);
          return result();
        }
        if (lower.includes('lock_finance_book_grant'))
          return result([{ allowed: true }]);
        if (lower.includes('from emdo.finance_books'))
          return result([{ functionalCurrency: 'EUR', role: 'viewer' }]);
        if (lower.includes('pg_advisory_xact_lock')) return result();
        if (lower.includes('from emdo.finance_fec_export_receipts')) {
          return result([
            {
              request_hash: requestHash?.[6],
              result_hash: requireContentHash(saved),
              result: saved,
            },
          ]);
        }
        throw new Error(
          `Replay unexpectedly read source: ${query} ${String(values)}`,
        );
      },
    );
    const replayPool: DatabasePool = {
      connect: vi.fn(async () => replay.client),
    };
    const replayRepository = new PostgresFranceFecRepository(replayPool);
    const replayed = await replayRepository.export(context, bookId, request);
    expect(replayed).toEqual(saved);
    expect(
      replay.queries.some((query) => query.includes('finance_journals')),
    ).toBe(false);
  });

  it('refuses a posted-journal count mismatch instead of silently omitting ledger lines', async () => {
    const { client } = createClient({ journalCount: 2 });
    const pool: DatabasePool = { connect: vi.fn(async () => client) };
    const repository = new PostgresFranceFecRepository(pool);
    await expect(
      repository.export(context, bookId, {
        startsOn: '2025-01-01',
        endsOn: '2025-12-31',
        mappingRevision: 1,
        idempotencyKey: 'fec-missing-journal',
      }),
    ).rejects.toThrow('no line snapshot');
  });

  it('returns a blocked review when account or journal mappings are absent', async () => {
    const rows = mappedLedgerRows().map((row) => ({
      ...row,
      account_number: null,
      account_label: null,
      journal_code: null,
      journal_label: null,
      entry_number: null,
      entry_sequence: null,
      piece_reference: null,
      piece_date: null,
      entry_label: null,
      validation_date: null,
      entry_kind: null,
    }));
    const { client } = createClient({ rows });
    const pool: DatabasePool = { connect: vi.fn(async () => client) };
    const repository = new PostgresFranceFecRepository(pool);
    const result = await repository.export(context, bookId, {
      startsOn: '2025-01-01',
      endsOn: '2025-12-31',
      mappingRevision: 1,
      idempotencyKey: 'fec-unreviewed-mapping',
    });
    expect(result.status).toBe('blocked');
    expect(result.file).toBeNull();
    expect(result.review.errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'france-fec-entry-sequence-invalid',
        'france-fec-date-missing',
        'france-fec-opening-entries-missing',
      ]),
    );
  });
});

function requireContentHash(value: {
  status: 'ready';
  file: { content: string };
}): string {
  // Match the repository's content hash without introducing a second source
  // of financial data into the test.
  return createHash('sha256').update(value.file.content).digest('hex');
}

it('reads a saved export without regenerating its ledger snapshot and rejects corruption', async () => {
  const initial = createClient();
  const source = new PostgresFranceFecRepository({
    connect: async () => initial.client,
  });
  const saved = await source.export(context, bookId, {
    startsOn: '2025-01-01',
    endsOn: '2025-12-31',
    mappingRevision: 1,
    idempotencyKey: 'saved-fec',
  });
  if (saved.status !== 'ready') throw new Error('expected-ready');
  const hash = createHash('sha256').update(saved.file.content).digest('hex');
  const fixture = createClient({
    receipt: { result: saved, result_hash: hash },
  });
  const reader = new PostgresFranceFecRepository({
    connect: async () => fixture.client,
  });
  expect(await reader.getSavedExport(context, bookId, 'saved-fec')).toEqual(
    saved,
  );
  expect(
    fixture.queries.some((query) =>
      query.includes('from emdo.finance_journals'),
    ),
  ).toBe(false);
  const corrupt = createClient({
    receipt: { result: saved, result_hash: '0'.repeat(64) },
  });
  await expect(
    new PostgresFranceFecRepository({
      connect: async () => corrupt.client,
    }).getSavedExport(context, bookId, 'saved-fec'),
  ).rejects.toMatchObject({ code: 'conflict' });
});
it('returns null for an unavailable saved export', async () => {
  const fixture = createClient();
  expect(
    await new PostgresFranceFecRepository({
      connect: async () => fixture.client,
    }).getSavedExport(context, bookId, 'absent'),
  ).toBeNull();
});

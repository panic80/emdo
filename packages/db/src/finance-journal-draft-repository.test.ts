import { describe, expect, it, vi } from 'vitest';
import { FinanceAutomationJournalDraftResultSchema } from '@emdo/contracts';
import { FinanceJournalDraftRepository } from './finance-journal-draft-repository.js';
import type { DatabaseClient, DatabasePool } from './scoped-repository.js';
const id = (n: number) =>
  `018f1f5e-7b24-4d2b-a8e1-${String(n).padStart(12, '0')}`;
const context = {
  workspaceId: id(1),
  userId: id(2),
  sessionId: id(3),
  requestId: id(4),
};
const bookId = id(5),
  draftId = id(6),
  batchId = id(7),
  journalId = id(8),
  key = 'journal-post-1';
const at = '2026-09-15T00:00:00Z';
const result = FinanceAutomationJournalDraftResultSchema.parse({
  schemaVersion: 1,
  kind: 'finance-journal-draft',
  id: draftId,
  operationId: draftId,
  workspaceId: context.workspaceId,
  bookId,
  revision: 2,
  status: 'posted',
  source: {
    batchId,
    batchRevision: 3,
    snapshotHash: 'a'.repeat(64),
    evidenceId: id(9),
    sourceDigest: 'b'.repeat(64),
    mappingHash: 'c'.repeat(64),
    rows: [
      { rowId: id(10), sourceRow: 1, revision: 2, componentRevisions: [] },
    ],
  },
  currency: 'CAD',
  itemCount: 2,
  amount: '123.45',
  proposal: {
    journals: [
      {
        effectiveOn: '2026-09-15',
        description: 'Reviewed receipt',
        sourceReference: 'import:source:1',
        lines: ['debit', 'credit'].map((side, i) => ({
          accountId: id(20 + i),
          side,
          amount: '123.45',
          currency: 'CAD',
          nativeAmount: '123.45',
          fxRate: '1',
          fxSource: 'identity',
          description: '',
        })),
      },
    ],
  },
  review: { decision: 'approved', reason: null, actorId: context.userId, at },
  postedJournalIds: [journalId],
  posting: 'performed',
  events: [
    {
      kind: 'reviewed',
      revision: 1,
      decision: 'approved',
      reason: null,
      actorId: context.userId,
      at,
    },
    {
      kind: 'posted',
      revision: 2,
      journalIds: [journalId],
      actorId: context.userId,
      at,
    },
  ],
});
function fixture() {
  const queries: string[] = [];
  let permitted = true,
    scopeActive = true,
    failComplete = false;
  const rows = (data: Record<string, unknown>[] = []) => ({
    rows: data,
    rowCount: data.length,
  });
  let receipt: Record<string, unknown> | undefined;
  const client: DatabaseClient = {
    release: vi.fn(),
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      queries.push(sql);
      if (sql.includes('lock_active_request_scope'))
        return rows([{ authorized: scopeActive }]);
      if (sql.includes('finance_book_access')) return rows([{ permitted }]);
      if (sql.includes('select payload_hash'))
        return rows(receipt ? [receipt] : []);
      if (sql.includes('insert into emdo.finance_command_receipts')) {
        receipt = { payload_hash: values?.[4], result: { id: draftId } };
        return rows();
      }
      if (sql.includes('read_finance_journal_draft_result'))
        return rows([{ result }]);
      if (sql.includes('lock_finance_journal_draft_post'))
        return rows([{ result: { batchId, batchRevision: 3 } }]);
      if (sql.includes('select distinct t.journal_id'))
        return rows([{ journal_id: journalId }]);
      if (sql.includes('complete_finance_journal_draft_post')) {
        if (failComplete)
          throw Object.assign(new Error('journal-draft-revision-conflict'), {
            code: '23514',
          });
        return rows([{ result }]);
      }
      return rows();
    }),
  };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  const commit = vi.fn(async () => ({
    id: batchId,
    revision: 4,
    posted: 1,
    matched: 0,
  }));
  const repo = new FinanceJournalDraftRepository(pool, {
    commitNormalizedImportInTransaction: commit,
  });
  return {
    repo,
    client,
    queries,
    commit,
    deny: () => {
      permitted = false;
    },
    revokeScope: () => {
      scopeActive = false;
    },
    fail: () => {
      failComplete = true;
    },
  };
}
describe('Journal draft canonical posting transaction', () => {
  it('replays a saved posting without reposting and rejects changed input or revoked approval', async () => {
    const f = fixture();
    await f.repo.postJournalDraft(context, bookId, draftId, key, {
      expectedRevision: 1,
    });
    await expect(
      f.repo.postJournalDraft(context, bookId, draftId, key, {
        expectedRevision: 1,
      }),
    ).resolves.toEqual(result);
    expect(f.commit).toHaveBeenCalledOnce();
    await expect(
      f.repo.postJournalDraft(context, bookId, draftId, key, {
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    f.deny();
    await expect(
      f.repo.postJournalDraft(context, bookId, draftId, key, {
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'authorization-revoked' });
    expect(f.commit).toHaveBeenCalledOnce();
  });

  it('uses one scoped transaction and the canonical hook before saving lifecycle and receipt', async () => {
    const f = fixture();
    await expect(
      f.repo.postJournalDraft(context, bookId, draftId, key, {
        expectedRevision: 1,
      }),
    ).resolves.toEqual(result);
    expect(f.commit).toHaveBeenCalledWith(f.client, context, bookId, batchId, {
      expectedRevision: 3,
    });
    expect(f.queries.filter((sql) => sql === 'begin')).toHaveLength(1);
    expect(f.queries.at(-1)).toBe('commit');
    expect(
      f.queries.findIndex((sql) =>
        sql.includes('complete_finance_journal_draft_post'),
      ),
    ).toBeLessThan(
      f.queries.findIndex((sql) =>
        sql.includes('insert into emdo.finance_command_receipts'),
      ),
    );
    expect(f.client.release).toHaveBeenCalledOnce();
  });
  it('rolls back the shared transaction if final lifecycle validation fails', async () => {
    const f = fixture();
    f.fail();
    await expect(
      f.repo.postJournalDraft(context, bookId, draftId, key, {
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.queries.at(-1)).toBe('rollback');
    expect(
      f.queries.some((sql) =>
        sql.includes('insert into emdo.finance_command_receipts'),
      ),
    ).toBe(false);
    expect(f.queries).not.toContain('commit');
  });
  it.each(['book', 'session'])(
    'rejects revoked %s access before canonical posting',
    async (which) => {
      const f = fixture();
      if (which === 'book') f.deny();
      else f.revokeScope();
      await expect(
        f.repo.postJournalDraft(context, bookId, draftId, key, {
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: 'authorization-revoked' });
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.queries.at(-1)).toBe('rollback');
    },
  );
});

import { describe, expect, it, vi } from 'vitest';
import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { createApp } from '../app.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';
const id = (n: number) =>
  `018f1f5e-7b24-4d2b-a8e1-${String(n).padStart(12, '0')}`;
const bookId = id(1),
  userId = id(2),
  batchId = id(3),
  resultId = id(4);
const principal: AuthenticatedPrincipal = {
  userId,
  sessionId: id(5),
  householdId: bookId,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: id(6),
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('a'.repeat(64)),
};
const headers = {
  cookie: '__Secure-emdo.session_token=current',
  'idempotency-key': id(7),
};
const base = `/api/v2/finance/books/${bookId}/automations/journal-drafts`;
const prepared = {
  journal: {
    schemaVersion: 1,
    batchId,
    expectedBatchRevision: 3,
    expectedSnapshotHash: 'b'.repeat(64),
  },
  itemCount: 2,
  currency: 'CAD',
  amount: '123.45',
};
function fixture(authenticated = true, verified = true) {
  const repo = {
    checkReady: vi.fn(async () => true),
    prepareJournalDraft: vi.fn(async () => prepared),
    readJournalDraftResult: vi.fn(async () => null),
    listJournalDraftResults: vi.fn(async () => ({
      items: [],
      offset: 0,
      limit: 50,
      total: 0,
    })),
    reviewJournalDraft: vi.fn(),
    discardJournalDraft: vi.fn(),
    postJournalDraft: vi.fn(),
  };
  const auth = {
    authenticate: vi.fn(async () => (authenticated ? principal : undefined)),
    verifyMutation: vi.fn(async () => verified),
  } as unknown as ApiServices['auth'];
  const services = {
    ...createFailClosedApiServices({ auth }),
    financeJournalDrafts: repo,
  };
  return { repo, services };
}
describe('Journal draft API authority boundary', () => {
  it('returns a saved posting only in the requested book and draft scope', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    const at = '2026-09-15T00:00:00Z',
      journalId = id(12);
    const saved = {
      schemaVersion: 1,
      kind: 'finance-journal-draft',
      id: resultId,
      operationId: resultId,
      workspaceId: bookId,
      bookId,
      revision: 2,
      status: 'posted',
      source: {
        batchId,
        batchRevision: 3,
        snapshotHash: 'b'.repeat(64),
        evidenceId: id(8),
        sourceDigest: 'c'.repeat(64),
        mappingHash: 'd'.repeat(64),
        rows: [
          { rowId: id(9), sourceRow: 1, revision: 2, componentRevisions: [] },
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
              accountId: id(10 + i),
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
      review: { decision: 'approved', reason: null, actorId: userId, at },
      postedJournalIds: [journalId],
      posting: 'performed',
      events: [
        {
          kind: 'reviewed',
          revision: 1,
          decision: 'approved',
          reason: null,
          actorId: userId,
          at,
        },
        {
          kind: 'posted',
          revision: 2,
          journalIds: [journalId],
          actorId: userId,
          at,
        },
      ],
    };
    try {
      const request = {
        method: 'POST' as const,
        url: `${base}/${resultId}/post`,
        headers,
        payload: { expectedRevision: 1 },
      };
      f.repo.postJournalDraft.mockResolvedValueOnce(saved);
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(saved);
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect(f.repo.postJournalDraft).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: bookId, userId }),
        bookId,
        resultId,
        headers['idempotency-key'],
        { expectedRevision: 1 },
      );
      for (const mismatch of [
        { bookId: userId },
        { workspaceId: userId },
        { id: userId },
      ]) {
        f.repo.postJournalDraft.mockResolvedValueOnce({
          ...saved,
          ...mismatch,
        });
        expect((await app.inject(request)).statusCode).toBe(502);
      }
    } finally {
      await app.close();
    }
  });

  it('prepares exact source intent under current authority without enqueuing or posting', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${base}/prepare`,
        headers,
        payload: { batchId },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(prepared);
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect(f.repo.prepareJournalDraft).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: bookId, userId }),
        bookId,
        headers['idempotency-key'],
        { batchId },
      );
      expect(f.repo.postJournalDraft).not.toHaveBeenCalled();
      f.repo.prepareJournalDraft.mockResolvedValueOnce({
        ...prepared,
        journal: { ...prepared.journal, batchId: userId },
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/prepare`,
            headers,
            payload: { batchId },
          })
        ).statusCode,
      ).toBe(502);
    } finally {
      await app.close();
    }
  });
  it('rejects forged authority and invalid currency precision before use', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/prepare`,
            headers,
            payload: { batchId, workspaceId: userId },
          })
        ).statusCode,
      ).toBe(400);
      expect(f.repo.prepareJournalDraft).not.toHaveBeenCalled();
      f.repo.prepareJournalDraft.mockResolvedValueOnce({
        ...prepared,
        currency: 'JPY',
        amount: '1.25',
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/prepare`,
            headers,
            payload: { batchId },
          })
        ).statusCode,
      ).toBe(502);
    } finally {
      await app.close();
    }
  });
  it.each([
    [false, true, 401],
    [true, false, 403],
  ])(
    'requires authentication and mutation verification (%s,%s)',
    async (authenticated, verified, status) => {
      const f = fixture(Boolean(authenticated), Boolean(verified)),
        app = await createApp({ services: f.services });
      try {
        for (const operation of ['review', 'discard', 'post'])
          expect(
            (
              await app.inject({
                method: 'POST',
                url: `${base}/${resultId}/${operation}`,
                headers,
                payload: { expectedRevision: 0 },
              })
            ).statusCode,
          ).toBe(status);
        expect(f.repo.reviewJournalDraft).not.toHaveBeenCalled();
        expect(f.repo.discardJournalDraft).not.toHaveBeenCalled();
        expect(f.repo.postJournalDraft).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it('reads scoped empty lists and missing details, and enforces readiness', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    try {
      expect(
        (await app.inject({ method: 'GET', url: base, headers })).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `${base}/${resultId}`,
            headers,
          })
        ).statusCode,
      ).toBe(404);
      expect(f.repo.readJournalDraftResult).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: bookId, userId }),
        bookId,
        resultId,
      );
      f.repo.checkReady.mockResolvedValue(false);
      expect(
        (await app.inject({ method: 'GET', url: base, headers })).statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
  });
  it.each([
    ['authorization-revoked', 403],
    ['conflict', 409],
    ['invalid-input', 400],
    ['unavailable', 503],
  ])('sanitizes %s on reads and explicit posting', async (code, status) => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    const failure = Object.assign(new Error('private database details'), {
      name: 'FinanceJournalDraftPersistenceError',
      code,
    });
    f.repo.listJournalDraftResults.mockRejectedValue(failure);
    f.repo.postJournalDraft.mockRejectedValue(failure);
    try {
      for (const request of [
        { method: 'GET' as const, url: base, headers },
        {
          method: 'POST' as const,
          url: `${base}/${resultId}/post`,
          headers,
          payload: { expectedRevision: 0 },
        },
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(status);
        expect(response.body).not.toContain('private database details');
      }
    } finally {
      await app.close();
    }
  });
});

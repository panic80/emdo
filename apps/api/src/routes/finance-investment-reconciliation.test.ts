import { describe, expect, it, vi } from 'vitest';
import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { createApp } from '../app.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';
const userId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70',
  bookId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f72';
const principal: AuthenticatedPrincipal = {
  userId,
  sessionId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71',
  householdId: bookId,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f74',
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('7'.repeat(64)),
};
const headers = {
  cookie: '__Secure-emdo.session_token=current',
  'idempotency-key': '11111111-1111-4111-8111-111111111111',
};

const comparison = {
  valuationRunId: userId,
  observedPositionId: bookId,
  comparisonHash: 'a'.repeat(64),
  valuationInputHash: 'b'.repeat(64),
  financialAccountId: userId,
  instrumentId: userId,
  asOf: '2026-09-15',
  evidenceId: userId,
  sourceRow: 1,
  observedQuantity: '10',
  calculatedQuantity: '9',
  difference: '1',
  status: 'difference',
  sourceSnapshot: {},
};
function fixture(authenticated = true, verified = true) {
  const repo = {
    checkReady: vi.fn(async () => true),
    correctiveRecords: vi.fn(async () => ({
      items: [],
      offset: 0,
      limit: 50,
      total: 0,
    })),
    preview: vi.fn(async () => ({
      workspaceId: bookId,
      bookId,
      comparison,
      sourcesCurrent: true,
    })),
    list: vi.fn(async () => ({ items: [], offset: 0, limit: 50, total: 0 })),
    get: vi.fn(async () => null),
    create: vi.fn(),
    resolve: vi.fn(),
    reopen: vi.fn(),
  };
  const auth = {
    authenticate: vi.fn(async () => (authenticated ? principal : undefined)),
    verifyMutation: vi.fn(async () => verified),
  } as unknown as ApiServices['auth'];
  return {
    repo,
    services: {
      ...createFailClosedApiServices({ auth }),
      financeInvestmentReconciliation: repo,
    },
  };
}
const base = `/api/v2/finance/books/${bookId}/investments/reconciliations`;
describe('saved investment reconciliation API boundary', () => {
  it.each([
    ['authorization-revoked', 403],
    ['invalid-input', 400],
    ['conflict', 409],
    ['unavailable', 503],
  ])('maps %s without exposing persistence details', async (code, status) => {
    const f = fixture();
    const app = await createApp({ services: f.services });
    const failure = Object.assign(new Error('sensitive database detail'), {
      name: 'FinanceInvestmentReconciliationPersistenceError',
      code,
    });
    try {
      f.repo.list.mockRejectedValueOnce(failure);
      const response = await app.inject({ method: 'GET', url: base, headers });
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain('sensitive database detail');
      f.repo.checkReady.mockRejectedValueOnce(failure);
      expect(
        (await app.inject({ method: 'GET', url: base, headers })).statusCode,
      ).toBe(status);
      f.repo.create.mockRejectedValueOnce(failure);
      const mutation = await app.inject({
        method: 'POST',
        url: base,
        headers,
        payload: {
          valuationRunId: userId,
          observedPositionId: bookId,
          expectedComparisonHash: comparison.comparisonHash,
        },
      });
      expect(mutation.statusCode).toBe(status);
      expect(mutation.body).not.toContain('sensitive database detail');
    } finally {
      await app.close();
    }
  });

  it('reads corrective choices in the exact requested case scope', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    try {
      const request = {
        method: 'GET' as const,
        url: `${base}/${userId}/corrective-records`,
        headers,
      };
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect(f.repo.correctiveRecords).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: bookId, userId }),
        bookId,
        userId,
        0,
        50,
      );
      f.repo.correctiveRecords.mockResolvedValueOnce({
        items: [],
        offset: 1,
        limit: 50,
        total: 0,
      });
      expect((await app.inject(request)).statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });

  it('creates the exact comparison and rejects a substituted successful mutation response', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    const saved = {
      schemaVersion: 1,
      id: userId,
      workspaceId: bookId,
      bookId,
      revision: 1,
      status: 'open',
      effectiveStatus: 'open',
      sourcesCurrent: true,
      comparison,
      accountingEffect: 'none',
      history: [
        {
          revision: 1,
          kind: 'created',
          comparison,
          resolution: null,
          evidenceSnapshots: [],
          correctiveRecordSnapshots: [],
          reason: null,
          createdBy: userId,
          createdAt: '2026-09-15T00:00:00Z',
        },
      ],
    };
    f.repo.create.mockResolvedValue(saved);
    try {
      const payload = {
        valuationRunId: userId,
        observedPositionId: bookId,
        expectedComparisonHash: comparison.comparisonHash,
      };
      const request = { method: 'POST' as const, url: base, headers, payload };
      expect((await app.inject(request)).statusCode).toBe(200);
      expect(f.repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: bookId, userId }),
        bookId,
        headers['idempotency-key'],
        payload,
      );
      f.repo.create.mockResolvedValueOnce({
        ...saved,
        comparison: { ...comparison, comparisonHash: 'c'.repeat(64) },
      });
      expect((await app.inject(request)).statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });

  it('keeps operations unavailable until repository readiness passes', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    f.repo.checkReady.mockResolvedValue(false);
    try {
      const response = await app.inject({ method: 'GET', url: base, headers });
      expect(response.statusCode).toBe(503);
      expect(f.repo.list).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('previews exact saved comparison without mutating and rejects substituted observations', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    try {
      const request = {
        method: 'GET' as const,
        url: `${base}/preview?valuationRunId=${userId}&observedPositionId=${bookId}`,
        headers,
      };
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect(response.json().comparison).toEqual(comparison);
      expect(f.repo.create).not.toHaveBeenCalled();
      f.repo.preview.mockResolvedValueOnce({
        workspaceId: bookId,
        bookId,
        comparison: { ...comparison, observedPositionId: userId },
        sourcesCurrent: true,
      });
      expect((await app.inject(request)).statusCode).toBe(502);
      f.repo.preview.mockResolvedValueOnce({
        workspaceId: userId,
        bookId,
        comparison,
        sourcesCurrent: true,
      });
      expect((await app.inject(request)).statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });
  it('requires authentication and mutation verification before accessing case operations', async () => {
    for (const authenticated of [false, true]) {
      const f = fixture(authenticated, false),
        app = await createApp({ services: f.services });
      try {
        const response = await app.inject({
          method: 'POST',
          url: base,
          headers,
          payload: {
            valuationRunId: userId,
            observedPositionId: bookId,
            expectedComparisonHash: 'a'.repeat(64),
          },
        });
        expect(response.statusCode).toBe(authenticated ? 403 : 401);
        expect(f.repo.create).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  });
  it('returns not found for an unavailable case and rejects invalid pagination', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    try {
      expect(
        (await app.inject({ method: 'GET', url: `${base}/${userId}`, headers }))
          .statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: 'GET', url: `${base}?limit=101`, headers }))
          .statusCode,
      ).toBe(400);
      expect(f.repo.list).not.toHaveBeenCalled();
      expect(
        (await app.inject({ method: 'GET', url: base, headers })).json(),
      ).toEqual({ items: [], offset: 0, limit: 50, total: 0 });
    } finally {
      await app.close();
    }
  });
});

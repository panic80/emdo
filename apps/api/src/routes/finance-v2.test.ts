import { describe, expect, it, vi } from 'vitest';
import {
  EffectiveAuthorizationScopeFingerprintSchema,
  FinanceGeneratedReportSummarySchema,
} from '@emdo/contracts';
import { createApp } from '../app.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';
const principal: AuthenticatedPrincipal = {
  userId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70',
  sessionId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71',
  householdId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f72',
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f74',
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('7'.repeat(64)),
};
const headers = { cookie: '__Secure-emdo.session_token=current' };
function fixture(verified = true) {
  const auth = {
    authenticate: vi.fn(async () => principal),
    verifyMutation: vi.fn(async () => verified),
  } as unknown as ApiServices['auth'];
  const financeV2 = {
    checkReady: vi.fn(async () => true),
    listBooks: vi.fn(async () => []),
    uploadNormalizedStatement: vi.fn(async () => ({
      id: principal.householdId,
      revision: 1,
    })),
    createBook: vi.fn(async () => ({ id: principal.householdId })),
  } as unknown as NonNullable<ApiServices['financeV2']>;
  return {
    financeV2,
    services: { ...createFailClosedApiServices({ auth }), financeV2 },
  };
}
describe('Finance v2 HTTP authority', () => {
  it('lists current private account sources without exposing ownership metadata', async () => {
    const { services, financeV2 } = fixture();
    const list = vi.fn(async () => [
      {
        sourceSpaceId: principal.spaceAccessGrantId,
        name: 'My finance',
        sourceOwnerUserId: principal.userId,
      },
    ]);
    const app = await createApp({
      services: {
        ...services,
        financeV2: { ...financeV2, listFinancialAccountSources: list },
      },
    });
    try {
      const result = await app.inject({
        method: 'GET',
        url: `/api/v2/finance/books/${principal.householdId}/financial-account-sources`,
        headers,
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({
        sources: [
          { sourceSpaceId: principal.spaceAccessGrantId, name: 'My finance' },
        ],
      });
      expect(result.headers['cache-control']).toBe('no-store, private');
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: principal.householdId,
          userId: principal.userId,
        }),
        principal.householdId,
      );
    } finally {
      await app.close();
    }
  });

  it('reads saved report pages with current scope and reports missing snapshots', async () => {
    const { services } = fixture();
    const summary = {
      id: principal.sessionId,
      workspaceId: principal.householdId,
      bookId: principal.householdId,
      automationRunId: principal.userId,
      reportVersion: 1 as const,
      kind: 'posted-ledger-trial-balance' as const,
      coverage: 'all-posted-journals-at-snapshot' as const,
      currency: 'CAD' as const,
      snapshotAt: '2026-09-13T00:00:00Z',
    };
    const report = {
      ...summary,
      rows: [],
      sourceJournals: [],
      totalDebit: '0',
      totalCredit: '0',
    };
    const list = vi.fn(async () => ({ reports: [summary], nextOffset: 51 })),
      get = vi.fn(async () => report as typeof report | null);
    const app = await createApp({
      services: {
        ...services,
        financeGeneratedReports: { checkReady: async () => true, list, get },
      },
    });
    try {
      const page = await app.inject({
        method: 'GET',
        url: `/api/v2/finance/books/${principal.householdId}/reports?offset=50&limit=1`,
        headers,
      });
      expect(page.statusCode).toBe(200);
      expect(page.json()).toEqual({ reports: [summary], nextOffset: 51 });
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: principal.householdId,
          userId: principal.userId,
        }),
        principal.householdId,
        50,
        1,
      );
      const saved = await app.inject({
        method: 'GET',
        url: `/api/v2/finance/books/${principal.householdId}/reports/${principal.sessionId}`,
        headers,
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual(report);
      expect(saved.headers['cache-control']).toBe('no-store, private');
      get.mockResolvedValueOnce(null);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v2/finance/books/${principal.householdId}/reports/${principal.sessionId}`,
            headers,
          })
        ).statusCode,
      ).toBe(404);
      get.mockRejectedValueOnce(
        Object.assign(new Error('finance-book-forbidden'), {
          name: 'FinanceV2PersistenceError',
          code: 'authorization-revoked',
        }),
      );
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v2/finance/books/${principal.householdId}/reports/${principal.sessionId}`,
            headers,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v2/finance/books/${principal.householdId}/reports?limit=101`,
            headers,
          })
        ).statusCode,
      ).toBe(400);
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it('rejects cross-scope and malformed saved report responses without exposing their contents', async () => {
    const { services } = fixture();
    const report = {
      id: principal.sessionId,
      workspaceId: principal.householdId,
      bookId: principal.householdId,
      automationRunId: principal.userId,
      reportVersion: 1 as const,
      kind: 'posted-ledger-trial-balance' as const,
      coverage: 'all-posted-journals-at-snapshot' as const,
      currency: 'CAD' as const,
      snapshotAt: '2026-09-13T00:00:00Z',
      rows: [],
      sourceJournals: [],
      totalDebit: '0',
      totalCredit: '0',
    };
    const summary = FinanceGeneratedReportSummarySchema.parse(
      Object.fromEntries(
        Object.entries(report).filter(
          ([key]) =>
            !['rows', 'sourceJournals', 'totalDebit', 'totalCredit'].includes(
              key,
            ),
        ),
      ),
    );
    const get = vi.fn(async () => report);
    const list = vi.fn(async () => ({
      reports: [summary],
      nextOffset: null as number | null,
    }));
    const app = await createApp({
      services: {
        ...services,
        financeGeneratedReports: { checkReady: async () => true, get, list },
      },
    });
    try {
      for (const changed of [
        { workspaceId: principal.userId },
        { bookId: principal.userId },
        { id: principal.userId },
        { totalDebit: '1' },
      ]) {
        get.mockResolvedValueOnce({ ...report, ...changed });
        const response = await app.inject({
          method: 'GET',
          url: `/api/v2/finance/books/${principal.householdId}/reports/${principal.sessionId}`,
          headers,
        });
        expect(response.statusCode).toBe(502);
        expect(response.json().code).toBe('service-contract-invalid');
        expect(response.body).not.toContain(principal.userId);
        expect(response.headers['cache-control']).toBe('no-store');
      }
      for (const invalid of [
        {
          reports: [{ ...summary, workspaceId: principal.userId }],
          nextOffset: null,
        },
        {
          reports: [{ ...summary, bookId: principal.userId }],
          nextOffset: null,
        },
        { reports: [summary, summary], nextOffset: null },
        { reports: [summary], nextOffset: 0 },
        { reports: [], nextOffset: 1 },
      ]) {
        list.mockResolvedValueOnce(invalid);
        const response = await app.inject({
          method: 'GET',
          url: `/api/v2/finance/books/${principal.householdId}/reports?limit=1`,
          headers,
        });
        expect(response.statusCode).toBe(502);
        expect(response.body).not.toContain(principal.userId);
      }
    } finally {
      await app.close();
    }
  });
  it('derives workspace from authentication and reports actual tax readiness', async () => {
    const { services, financeV2 } = fixture();
    const app = await createApp({ services });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v2/finance/books',
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(financeV2.listBooks).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: principal.householdId,
          userId: principal.userId,
        }),
      );
      const coverage = await app.inject({
        method: 'GET',
        url: '/api/v2/finance/tax/coverage',
        headers,
      });
      expect(coverage.json().countries).toHaveLength(7);
      expect(
        coverage
          .json()
          .countries.every(
            (item: { status: string; forms: string[] }) =>
              item.status === 'unavailable' && item.forms.length === 0,
          ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
  it('blocks mutations before dispatch when browser verification fails', async () => {
    const { services, financeV2 } = fixture(false);
    const app = await createApp({ services });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v2/finance/books',
        headers: { ...headers, 'idempotency-key': 'test' },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(financeV2.createBook).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('uses authenticated workspace scope and browser mutation checks for imports', async () => {
    for (const verified of [false, true]) {
      const { services, financeV2 } = fixture(verified),
        app = await createApp({ services });
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v2/finance/books/${principal.householdId}/imports`,
          headers: {
            ...headers,
            'idempotency-key': '11111111-1111-4111-8111-111111111111',
          },
          payload: { filename: 'statement.csv' },
        });
        expect(response.statusCode).toBe(verified ? 200 : 403);
        if (verified) {
          expect(financeV2.uploadNormalizedStatement).toHaveBeenCalledWith(
            expect.objectContaining({
              workspaceId: principal.householdId,
              userId: principal.userId,
            }),
            principal.householdId,
            '11111111-1111-4111-8111-111111111111',
            { filename: 'statement.csv' },
          );
          expect(response.headers['cache-control']).toContain('no-store');
        } else
          expect(financeV2.uploadNormalizedStatement).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  });

  it('reloads dividend preview sources and commits only with authenticated header authority', async () => {
    const { services, financeV2 } = fixture();
    const id = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const source = {
      sourceRowId: id(1),
      batchId: id(2),
      sourceRow: 8,
      evidenceId: id(3),
      financialAccountId: id(4),
      instrumentId: id(5),
      sourceRevision: 3,
      sourceSnapshotHash: 'a'.repeat(64),
      status: 'ready',
      effectiveOn: '2026-08-15',
      description: 'Dividend receipt',
      nativeAmount: '85',
      currency: 'CAD',
      fxRate: '1',
      fxSource: 'identity',
      issues: [],
      financialAccountLedgerId: id(6),
      functionalCurrency: 'CAD',
    };
    const amount = (field: string, value: string) => ({
      nativeAmount: value,
      currency: 'CAD',
      functionalAmount: value,
      fxRate: '1',
      fxSource: 'identity',
      provenance: {
        sourceRow: 8,
        field,
        column: field,
        raw: value,
        contextAnchor: 'Dividend details',
      },
    });
    const action = {
      id: id(10),
      actionType: 'cash-dividend',
      financialAccountId: id(4),
      instrumentId: id(5),
      evidenceId: id(3),
      sourceRowId: id(1),
      declaredOn: '2026-07-20',
      exDate: null,
      payableOn: '2026-08-15',
      sourceReference: 'Statement row8',
      reviewReason: 'Reviewed original',
      gross: amount('gross', '100'),
      withholding: amount('withholding', '15'),
      net: amount('net', '85'),
      ledger: {
        cashLedgerAccountId: id(6),
        dividendIncomeLedgerAccountId: id(7),
        withholdingLedgerAccountId: id(8),
      },
    };
    const read = vi.fn(async () => source),
      commit = vi.fn(async () => ({
        actionId: action.id,
        status: 'committed',
      }));
    Object.assign(financeV2, {
      readInvestmentCashDividendSource: read,
      commitInvestmentCashDividend: commit,
    });
    const app = await createApp({ services });
    const base = `/api/v2/finance/books/${principal.householdId}/investments/cash-dividends`;
    const input = {
      action,
      expectedSourceRevision: 3,
      sourceSnapshotHash: source.sourceSnapshotHash,
    };
    try {
      const preview = await app.inject({
        method: 'POST',
        url: base + '/preview',
        headers,
        payload: input,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({
        commitReadiness: 'ready',
        grossFunctionalAmount: '100',
        withholdingFunctionalAmount: '15',
        netFunctionalAmount: '85',
      });
      expect(preview.headers['cache-control']).toContain('no-store');
      expect(read).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: principal.householdId,
          userId: principal.userId,
        }),
        principal.householdId,
        {
          sourceRowId: id(1),
          financialAccountId: id(4),
          instrumentId: id(5),
          evidenceId: id(3),
        },
      );
      expect(commit).not.toHaveBeenCalled();
      const stale = await app.inject({
        method: 'POST',
        url: base + '/preview',
        headers,
        payload: { ...input, expectedSourceRevision: 2 },
      });
      expect(stale.statusCode).toBe(409);
      const injected = await app.inject({
        method: 'POST',
        url: base + '/preview',
        headers,
        payload: { ...input, source },
      });
      expect(injected.statusCode).toBe(400);
      const missing = await app.inject({
        method: 'POST',
        url: base + '/preview',
        headers,
        payload: { ...input, action: { ...action, gross: null } },
      });
      expect(missing.statusCode).toBe(200);
      expect(missing.json()).toMatchObject({
        commitReadiness: 'blocked',
        blockedReasons: expect.arrayContaining(['gross-required']),
      });
      const result = await app.inject({
        method: 'POST',
        url: base + '/commit',
        headers: { ...headers, 'idempotency-key': 'dividend-header-key' },
        payload: { ...input, idempotencyKey: 'untrusted-body-key' },
      });
      expect(result.statusCode).toBe(200);
      expect(commit).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: principal.householdId }),
        principal.householdId,
        { ...input, idempotencyKey: 'dividend-header-key' },
      );
    } finally {
      await app.close();
    }
  });

  it('bounds saved dividend reads and rejects mutations without current verification', async () => {
    const { services, financeV2 } = fixture(false);
    const list = vi.fn(async () => ({ actions: [], nextOffset: null })),
      get = vi.fn(async () => null),
      commit = vi.fn();
    Object.assign(financeV2, {
      listInvestmentCashDividends: list,
      getInvestmentCashDividend: get,
      commitInvestmentCashDividend: commit,
    });
    const app = await createApp({ services }),
      base = `/api/v2/finance/books/${principal.householdId}/investments/cash-dividends`;
    try {
      const page = await app.inject({
        method: 'GET',
        url: base + '?offset=10&limit=2',
        headers,
      });
      expect(page.statusCode).toBe(200);
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: principal.householdId }),
        principal.householdId,
        { offset: 10, limit: 2 },
      );
      expect(page.headers['cache-control']).toContain('no-store');
      expect(
        (await app.inject({ method: 'GET', url: base + '?limit=101', headers }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: base + '/' + principal.sessionId,
            headers,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: base + '/commit',
            headers: { ...headers, 'idempotency-key': 'blocked-dividend' },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      expect(commit).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('exposes reviewed stock-split source reads and idempotent commits through Finance V2', async () => {
    const { services, financeV2 } = fixture();
    const action = {
      id: principal.sessionId,
      actionType: 'split' as const,
      financialAccountId: principal.userId,
      instrumentId: principal.householdId,
      effectiveOn: '2026-09-13',
      numerator: '2',
      denominator: '1',
      fractionalTreatment: 'retain' as const,
      evidenceId: principal.spaceAccessGrantId,
      sourceReference: 'broker split advice',
      cashInLieu: null,
    };
    const source = vi.fn(async () => ({
      sourceRevision: 4,
      sourceSnapshotHash: 'a'.repeat(64),
      sourceAsOf: action.effectiveOn,
      sourceBoundary: 'immediately-before-action' as const,
      sourceLots: [],
    }));
    const commit = vi.fn(async () => ({
      actionId: action.id,
      workspaceId: principal.householdId,
      bookId: principal.householdId,
      sourceRevision: 4,
      nextSourceRevision: 5,
      sourceSnapshotHash: 'a'.repeat(64),
      successorLotIds: [],
      effectCount: 1,
      status: 'committed' as const,
      replayed: false,
    }));
    Object.assign(financeV2, {
      getInvestmentLotRevision: vi.fn(async () => ({ revision: 4 })),
      readInvestmentStockSplitSource: source,
      commitInvestmentStockSplit: commit,
    });
    const app = await createApp({ services });
    try {
      const snapshot = await app.inject({
        method: 'POST',
        url: `/api/v2/finance/books/${principal.householdId}/investments/corporate-actions/stock-splits/source`,
        headers,
        payload: action,
      });
      expect(snapshot.statusCode).toBe(200);
      expect(source).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: principal.householdId,
          userId: principal.userId,
        }),
        principal.householdId,
        action,
      );

      const committed = await app.inject({
        method: 'POST',
        url: `/api/v2/finance/books/${principal.householdId}/investments/corporate-actions/stock-splits/commit`,
        headers: {
          ...headers,
          'idempotency-key': 'stock-split-commit-1',
        },
        payload: {
          action,
          sourceAsOf: action.effectiveOn,
          sourceBoundary: 'immediately-before-action',
          sourceLots: [],
          expectedSourceRevision: 4,
        },
      });
      expect(committed.statusCode).toBe(200);
      expect(commit).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: principal.householdId }),
        principal.householdId,
        expect.objectContaining({
          expectedSourceRevision: 4,
          idempotencyKey: 'stock-split-commit-1',
        }),
      );
    } finally {
      await app.close();
    }
  });
  it('fails closed when accounting is disabled', async () => {
    const { services } = fixture();
    const disabled = createFailClosedApiServices({ auth: services.auth });
    const app = await createApp({ services: disabled });
    try {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v2/finance/books',
            headers,
          })
        ).statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
  });
});

it('maps accounting conflicts without disclosing database exception text', async () => {
  const { services, financeV2 } = fixture();
  vi.mocked(financeV2.createBook).mockRejectedValueOnce(
    Object.assign(new Error('private supplier account and SQL detail'), {
      name: 'FinanceV2PersistenceError',
      code: 'conflict',
    }),
  );
  const app = await createApp({ services });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/finance/books',
      headers: {
        ...headers,
        'idempotency-key': '11111111-1111-4111-8111-111111111111',
      },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('finance-v2-conflict');
    expect(response.body).not.toContain('private supplier');
  } finally {
    await app.close();
  }
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CorporateActionApiError,
  financeCorporateActionApi,
} from './finance-corporate-action-api.js';

const bookId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const instrumentId = '00000000-0000-4000-8000-000000000003';
const evidenceId = '00000000-0000-4000-8000-000000000004';
const actionId = '00000000-0000-4000-8000-000000000005';
const movementId = '00000000-0000-4000-8000-000000000006';
const successorId = '00000000-0000-4000-8000-000000000007';

const sourceLot = {
  id: successorId,
  financialAccountId: accountId,
  instrumentId,
  acquiredOn: '2026-01-01',
  acquisitionSequence: 0,
  originalQuantity: '10',
  disposedQuantity: '0',
  originalNativeCost: '100',
  allocatedNativeCost: '0',
  originalFunctionalCost: '100',
  allocatedFunctionalCost: '0',
  nativeCurrency: 'CAD',
  functionalCurrency: 'CAD',
  sourceReference: 'opening:1',
};

const action = {
  id: actionId,
  actionType: 'split' as const,
  financialAccountId: accountId,
  instrumentId,
  effectiveOn: '2026-09-01',
  numerator: '2',
  denominator: '1',
  fractionalTreatment: 'unknown' as const,
  evidenceId,
  sourceReference: 'broker:notice:1',
  cashInLieu: null,
};

const source = {
  sourceRevision: 8,
  sourceSnapshotHash: 'a'.repeat(64),
  sourceAsOf: action.effectiveOn,
  sourceBoundary: 'immediately-before-action' as const,
  sourceLots: [sourceLot],
};

const commit = {
  actionId,
  workspaceId: bookId,
  bookId,
  sourceRevision: 8,
  nextSourceRevision: 9,
  sourceSnapshotHash: 'a'.repeat(64),
  successorLotIds: [successorId],
  effectCount: 1,
  status: 'committed' as const,
  replayed: false,
};

const lots = {
  id: successorId,
  movementId,
  financialAccountId: accountId,
  instrumentId,
  nativeCurrency: 'CAD',
  functionalCurrency: 'CAD',
  originalQuantity: '20',
  remainingQuantity: '20',
  originalNativeCost: '100',
  remainingNativeCost: '100',
  originalFunctionalCost: '100',
  remainingFunctionalCost: '100',
  acquiredOn: '2026-01-01',
  sourceReference: 'corporate-action:1',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('finance corporate-action API client', () => {
  it('parses book sources and sends exact reviewed commit headers', async () => {
    const fetcher = vi.fn<
      (path: string, init?: RequestInit) => Promise<Response>
    >(async (path): Promise<Response> => {
      if (path.endsWith('/financial-accounts'))
        return new Response(
          JSON.stringify({
            accounts: [
              {
                id: accountId,
                name: 'Brokerage',
                kind: 'brokerage',
                currency: 'CAD',
                active: true,
              },
            ],
          }),
        );
      if (path.endsWith('/investments'))
        return new Response(
          JSON.stringify({
            instruments: [{ id: instrumentId, name: 'EMDO Fund' }],
            prices: [],
            fx: [],
            openings: [],
            observedPositions: [],
          }),
        );
      if (path.includes('/evidence?'))
        return new Response(
          JSON.stringify({
            documents: [
              {
                id: evidenceId,
                filename: 'broker-notice.pdf',
                format: 'pdf',
                byteSize: 100,
                createdAt: '2026-08-01T12:00:00.000Z',
                sourceDigest: 'd'.repeat(64),
              },
            ],
            nextOffset: null,
          }),
        );
      if (path.includes('/investments/lots?'))
        return new Response(JSON.stringify({ lots: [lots], nextOffset: null }));
      if (path.endsWith('/corporate-actions/revision'))
        return new Response(JSON.stringify({ revision: 8 }));
      if (path.endsWith('/stock-splits/source'))
        return new Response(JSON.stringify(source));
      if (path.endsWith('/stock-splits/commit'))
        return new Response(JSON.stringify(commit));
      throw new Error(`Unexpected path ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);

    await expect(
      financeCorporateActionApi.readAccounts(bookId),
    ).resolves.toHaveLength(1);
    await expect(
      financeCorporateActionApi.readInvestments(bookId),
    ).resolves.toMatchObject({
      instruments: [{ id: instrumentId }],
    });
    await expect(
      financeCorporateActionApi.readEvidence(bookId),
    ).resolves.toMatchObject([
      { id: evidenceId, sourceDigest: 'd'.repeat(64) },
    ]);
    await expect(
      financeCorporateActionApi.readLots(bookId),
    ).resolves.toHaveLength(1);
    await expect(financeCorporateActionApi.readRevision(bookId)).resolves.toBe(
      8,
    );
    await expect(
      financeCorporateActionApi.readSource(bookId, action),
    ).resolves.toEqual(source);

    const input = {
      action,
      sourceAsOf: source.sourceAsOf,
      sourceBoundary: source.sourceBoundary,
      sourceLots: source.sourceLots,
      expectedSourceRevision: source.sourceRevision,
      idempotencyKey: 'corporate-action-retry-key',
    };
    await expect(
      financeCorporateActionApi.commit(bookId, input, 'csrf-token'),
    ).resolves.toEqual(commit);

    const sourceCall = fetcher.mock.calls.find(([path]) =>
      path.endsWith('/stock-splits/source'),
    )!;
    expect(sourceCall[1]?.cache).toBe('no-store');
    expect(JSON.parse(String(sourceCall[1]?.body))).toEqual(action);
    const commitCall = fetcher.mock.calls.find(([path]) =>
      path.endsWith('/stock-splits/commit'),
    )!;
    const headers = new Headers(commitCall[1]?.headers);
    expect(headers.get('x-csrf-token')).toBe('csrf-token');
    expect(headers.get('idempotency-key')).toBe(input.idempotencyKey);
    expect(JSON.parse(String(commitCall[1]?.body))).toEqual(input);
  });

  it('maps a CAS conflict to a retryable, actionable error', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'revision changed' }), {
          status: 409,
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(
      financeCorporateActionApi.readSource(bookId, action),
    ).rejects.toMatchObject({
      name: 'CorporateActionApiError',
      status: 409,
      message:
        'The book changed while this review was open. Refresh sources before committing.',
    } satisfies Partial<CorporateActionApiError>);
  });

  it('rejects malformed source responses instead of rendering unverifiable lots', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...source,
              sourceSnapshotHash: 'not-a-hash',
            }),
          ),
      ),
    );
    await expect(
      financeCorporateActionApi.readSource(bookId, action),
    ).rejects.toThrow();
  });
});

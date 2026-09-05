import { describe, expect, it, vi } from 'vitest';

import { createFinanceDocumentApi } from './finance-document-api.js';

const token = 'A'.repeat(43);
const summary = {
  schemaVersion: 1 as const,
  id: 'document-a',
  displayName: 'Receipt.pdf',
  mimeType: 'application/pdf' as const,
  byteSize: 2048,
  state: 'awaiting-review' as const,
  documentType: 'receipt' as const,
  plaintextSha256: 'a'.repeat(64),
  sourceLocale: 'en-CA' as const,
  currency: 'CAD',
  extractionRevision: 1,
  createdAt: '2026-08-26T12:00:00.000Z',
  updatedAt: '2026-08-26T12:00:00.000Z',
};
const authority = {
  csrfToken: 'csrf-current',
  idempotencyKey: 'finance-document:test:12345678',
};
const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });

describe('Finance document API', () => {
  it('uses domain schemas, no-store reads, and current mutation authority', async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) =>
      response(
        init?.method === 'POST' && path === '/api/v1/finance/documents'
          ? summary
          : path.endsWith('/review')
            ? {
                schemaVersion: 1,
                documentId: 'document-a',
                extractionRevision: 1,
                envelope: {
                  schemaVersion: 1,
                  documentType: 'receipt',
                  sourceLocale: 'en-CA',
                  currency: 'CAD',
                  issuer: null,
                  recipient: null,
                  issuedOn: null,
                  merchant: null,
                  purchasedOn: null,
                  dueOn: null,
                  periodStart: null,
                  periodEnd: null,
                  subtotal: null,
                  tax: null,
                  total: null,
                  accountLast4: null,
                  facts: [],
                  tip: null,
                  paymentMethodLast4: null,
                  lineItems: [],
                  proposedRecord: null,
                },
                payloadHash: 'a'.repeat(64),
                reviewToken: token,
                expiresAt: '2026-08-26T13:00:00.000Z',
              }
            : { schemaVersion: 1, items: [summary] },
      ),
    );
    const api = createFinanceDocumentApi({ fetcher: fetcher as typeof fetch });
    await api.list();
    await api.upload(
      new File(['private'], 'receipt.pdf', { type: 'application/pdf' }),
      authority,
    );
    await api.readReview('document-a');

    expect(fetcher.mock.calls[0]).toEqual([
      '/api/v1/finance/documents',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    ]);
    const upload = (
      fetcher.mock.calls as unknown as Array<[string, RequestInit]>
    )[1]?.[1];
    expect(upload).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      headers: expect.objectContaining({
        'x-csrf-token': authority.csrfToken,
        'idempotency-key': authority.idempotencyKey,
      }),
    });
    expect(upload?.body).toBeInstanceOf(FormData);
  });

  it('exposes only read endpoints for guarded review, match, and evidence actions', async () => {
    const fetcher = vi.fn(async () =>
      response({ schemaVersion: 1, items: [] }),
    );
    const api = createFinanceDocumentApi({ fetcher: fetcher as typeof fetch });
    await api.readMatches('document-a');
    await api.readEvidence('evidence-a');

    const paths = (fetcher.mock.calls as unknown as Array<[string]>).map(
      ([path]) => path,
    );
    expect(paths).toEqual([
      '/api/v1/finance/documents/document-a/matches',
      '/api/v1/finance/evidence/evidence-a',
    ]);
    expect(api.originalUrl('document-a')).toBe(
      '/api/v1/finance/documents/document-a/original',
    );
  });

  it('sends bounded cursor pagination and retains complete evidence metadata', async () => {
    const evidence = {
      schemaVersion: 1,
      items: [
        {
          id: 'evidence-a',
          documentId: 'document-a',
          extractionRevision: 2,
          page: 3,
          excerpt: 'Reviewed CAD total',
          sourceLocale: 'fr-CA',
          locator: { kind: 'text', characterStart: 10, characterEnd: 28 },
        },
      ],
    };
    const fetcher = vi.fn(async (path: string) =>
      response(
        path.startsWith('/api/v1/finance/evidence/')
          ? evidence
          : { schemaVersion: 1, items: [], nextCursor: 'next-page' },
      ),
    );
    const api = createFinanceDocumentApi({ fetcher: fetcher as typeof fetch });
    const page = await api.list({ cursor: 'after-first', limit: 1_000 });
    const result = await api.readEvidence('evidence-a');

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      '/api/v1/finance/documents?cursor=after-first&limit=100',
    );
    expect(page.nextCursor).toBe('next-page');
    expect(result.items[0]).toEqual(evidence.items[0]);
  });
});

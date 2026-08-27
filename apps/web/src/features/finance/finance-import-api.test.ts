import { describe, expect, it, vi } from 'vitest';

import { createFinanceImportApi } from './finance-import-api.js';

const csrfToken = 'csrf-token-01234567890123456789';
const accountId = 'account-a';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('finance import API', () => {
  it('posts a bounded CSV preview with the current CSRF proof', async () => {
    const fetcher = vi.fn(async () =>
      response({
        schemaVersion: 1,
        plan: {
          id: 'plan-a',
          sourceHash: 'a'.repeat(64),
          expiresAt: '2026-08-13T18:00:00.000Z',
          summary: { accepted: 2, rejected: 1, duplicates: 1 },
          rejectedRows: [{ sourceRow: 4, code: 'invalid-date' }],
          duplicateRows: [{ sourceRow: 3, reason: 'existing' }],
        },
      }),
    );
    const api = createFinanceImportApi({ fetcher });

    await expect(
      api.preview({
        csrfToken,
        sourceText: 'Date,Description,Amount\n2026-08-01,Coffee,-4.50',
        format: 'csv',
        accountId,
        mapping: {
          defaultCategoryId: 'category-a',
          dateFormat: 'yyyy-mm-dd',
          columns: {
            postedOn: 'Date',
            description: 'Description',
            amount: 'Amount',
          },
        },
      }),
    ).resolves.toMatchObject({ plan: { id: 'plan-a' } });

    expect(fetcher).toHaveBeenCalledWith('/api/v1/finance/imports/preview', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        format: 'csv',
        sourceText: 'Date,Description,Amount\n2026-08-01,Coffee,-4.50',
        accountId,
        mapping: {
          defaultCategoryId: 'category-a',
          dateFormat: 'yyyy-mm-dd',
          columns: {
            postedOn: 'Date',
            description: 'Description',
            amount: 'Amount',
          },
        },
      }),
    });
  });

  it('does not send an oversized serialized body', async () => {
    const fetcher = vi.fn();
    const api = createFinanceImportApi({ fetcher });

    await expect(
      api.preview({
        csrfToken,
        sourceText: 'x'.repeat(1_048_576),
        format: 'ofx',
        accountId,
        mapping: { defaultCategoryId: null },
      }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects malformed responses without exposing a direct commit client', async () => {
    const malformed = createFinanceImportApi({
      fetcher: vi.fn(async () => response({ schemaVersion: 1 })),
    });
    await expect(malformed.listDestinations()).rejects.toMatchObject({
      code: 'unsafe-response',
    });
    expect(malformed).not.toHaveProperty('commit');
  });
});

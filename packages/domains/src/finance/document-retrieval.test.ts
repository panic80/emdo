import { describe, expect, it } from 'vitest';

import {
  fuseFinanceEvidenceRanks,
  suggestFinanceDocumentMatches,
} from './document-retrieval.js';

describe('finance document retrieval domain', () => {
  it('fuses deterministic ranks, deduplicates, bounds, and stably sorts', () => {
    expect(
      fuseFinanceEvidenceRanks({
        candidates: [
          {
            evidenceId: 'b',
            structuredRank: null,
            fullTextRank: 1,
            vectorRank: 2,
          },
          {
            evidenceId: 'a',
            structuredRank: 1,
            fullTextRank: null,
            vectorRank: null,
          },
          {
            evidenceId: 'a',
            structuredRank: 3,
            fullTextRank: 1,
            vectorRank: 1,
          },
        ],
        limit: 2,
      }),
    ).toEqual([
      expect.objectContaining({ evidenceId: 'a' }),
      expect.objectContaining({ evidenceId: 'b' }),
    ]);
  });

  it('suggests only exact CAD amount and compatible bounded-date records', () => {
    const suggestions = suggestFinanceDocumentMatches({
      source: {
        documentId: '018f1f5e-2000-7000-8000-000000000001',
        extractionRevision: 1,
        documentType: 'receipt',
        currency: 'CAD',
        amountMinorUnits: 1299,
        occurredOn: '2026-08-20',
        merchantOrPayee: 'Cafe Toronto Inc.',
      },
      records: [
        {
          recordType: 'transaction',
          recordId: 'match',
          currency: 'CAD',
          amountMinorUnits: 1299,
          occurredOn: '2026-08-21',
          merchantOrPayee: 'Toronto Cafe',
        },
        {
          recordType: 'transaction',
          recordId: 'wrong-amount',
          currency: 'CAD',
          amountMinorUnits: 1300,
          occurredOn: '2026-08-20',
          merchantOrPayee: 'Cafe Toronto',
        },
      ],
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      recordId: 'match',
      state: 'suggested',
      reasons: [
        'currency-exact',
        'amount-exact',
        'date-window',
        'merchant-payee-normalized',
        'document-type-compatible',
      ],
    });
  });

  it('excludes non-CAD, fact-only types, and unmatched merchants', () => {
    const base = {
      documentId: '018f1f5e-2000-7000-8000-000000000001',
      extractionRevision: 1,
      amountMinorUnits: 100,
      occurredOn: '2026-08-20',
      merchantOrPayee: 'Known Merchant',
    } as const;
    const records = [
      {
        recordType: 'transaction' as const,
        recordId: 'record',
        currency: 'CAD',
        amountMinorUnits: 100,
        occurredOn: '2026-08-20',
        merchantOrPayee: 'Different Name',
      },
    ];
    expect(
      suggestFinanceDocumentMatches({
        source: { ...base, documentType: 'receipt', currency: 'USD' },
        records,
      }),
    ).toEqual([]);
    expect(
      suggestFinanceDocumentMatches({
        source: { ...base, documentType: 'tax-slip', currency: 'CAD' },
        records,
      }),
    ).toEqual([]);
    expect(
      suggestFinanceDocumentMatches({
        source: { ...base, documentType: 'receipt', currency: 'CAD' },
        records,
      }),
    ).toEqual([]);
  });
});

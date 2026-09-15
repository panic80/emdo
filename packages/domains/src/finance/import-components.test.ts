import { describe, expect, it } from 'vitest';
import {
  extractFinanceNormalizedAmountComponents,
  prepareFinanceNormalizedAmountComponents,
} from './import-components.js';

const owner = '00000000-0000-4000-8000-000000000001';
const feeAccount = '00000000-0000-4000-8000-000000000002';
const principalAccount = '00000000-0000-4000-8000-000000000003';

const sourceRow = {
  sourceRow: 7,
  fields: {
    transactionDate: '2026-09-13',
    description: 'Buy 10 shares',
    amount: '-103',
    currency: 'CAD',
    fee: '3',
    principal: '100',
    commission: null,
    tax: null,
    interest: null,
  },
  provenance: {
    fee: { raw: '3.00', column: 'Fees', contextAnchor: null },
    principal: { raw: '100.00', column: 'Principal', contextAnchor: null },
  },
};

const sources = extractFinanceNormalizedAmountComponents(sourceRow);
const reviews = [
  {
    kind: 'fee' as const,
    nativeAmount: '3',
    currency: 'CAD' as const,
    inclusion: 'included-in-net' as const,
    postingSide: 'debit' as const,
    ledgerAccountId: feeAccount,
    fxRate: '1',
    fxSource: 'identity',
  },
  {
    kind: 'principal' as const,
    nativeAmount: '100',
    currency: 'CAD' as const,
    inclusion: 'included-in-net' as const,
    postingSide: 'debit' as const,
    ledgerAccountId: principalAccount,
    fxRate: '1',
    fxSource: 'identity',
  },
];

describe('normalized amount components', () => {
  it('extracts typed source facts without adding posting authority', () => {
    expect(sources).toEqual([
      {
        kind: 'fee',
        nativeAmount: '3',
        currency: 'CAD',
        provenance: {
          sourceRow: 7,
          field: 'fee',
          column: 'Fees',
          raw: '3.00',
          contextAnchor: null,
        },
      },
      {
        kind: 'principal',
        nativeAmount: '100',
        currency: 'CAD',
        provenance: {
          sourceRow: 7,
          field: 'principal',
          column: 'Principal',
          raw: '100.00',
          contextAnchor: null,
        },
      },
    ]);
    expect(sources[0]).not.toHaveProperty('ledgerAccountId');
    const mappedRow = extractFinanceNormalizedAmountComponents({
      ...sourceRow,
      status: 'normalized',
      issues: [],
      unmapped: [],
      provenance: {
        ...sourceRow.provenance,
        fee: {
          ...sourceRow.provenance.fee,
          pdfSource: { page: 2, span: 'Fees 3.00' },
        },
      },
    });
    expect(mappedRow[0]!.provenance.pdfSource).toEqual({
      page: 2,
      span: 'Fees 3.00',
    });
  });

  it('requires provenance and a source currency for every non-null component', () => {
    expect(() =>
      extractFinanceNormalizedAmountComponents({
        ...sourceRow,
        fields: { ...sourceRow.fields, currency: null },
      }),
    ).toThrow('finance-import-component-currency-missing');
    expect(() =>
      extractFinanceNormalizedAmountComponents({
        ...sourceRow,
        provenance: { ...sourceRow.provenance, fee: undefined },
      }),
    ).toThrow('finance-import-component-provenance-missing');
  });

  it('proves included components exactly offset the cash amount', () => {
    const result = prepareFinanceNormalizedAmountComponents({
      sources,
      reviews,
      rowAmount: '-103',
      rowCurrency: 'CAD',
      rowFxRate: '1',
      functionalCurrency: 'CAD',
    });
    expect(result.map((component) => component.functionalAmount)).toEqual([
      '3',
      '100',
    ]);
    expect(result.map((component) => component.contribution)).toEqual([
      3_000_000_000_000n,
      100_000_000_000_000n,
    ]);
  });

  it('does not infer a component side from a negative source value', () => {
    const signedFeeSource = sources.map((source) =>
      source.kind === 'fee' ? { ...source, nativeAmount: '-3' } : source,
    );
    const result = prepareFinanceNormalizedAmountComponents({
      sources: signedFeeSource,
      reviews,
      rowAmount: '-103',
      rowCurrency: 'CAD',
      rowFxRate: '1',
      functionalCurrency: 'CAD',
    });
    expect(result[0]!.review.postingSide).toBe('debit');
    expect(result[0]!.contribution).toBe(3_000_000_000_000n);
  });

  it('blocks omitted, extra, excluded, and unreconciled component mappings', () => {
    expect(() =>
      prepareFinanceNormalizedAmountComponents({
        sources,
        reviews: reviews.slice(0, 1),
        rowAmount: '-103',
        rowCurrency: 'CAD',
        rowFxRate: '1',
        functionalCurrency: 'CAD',
      }),
    ).toThrow('finance-import-components-review-required');
    expect(() =>
      prepareFinanceNormalizedAmountComponents({
        sources,
        reviews: [...reviews, { ...reviews[0]!, kind: 'fee' as const }],
        rowAmount: '-103',
        rowCurrency: 'CAD',
        rowFxRate: '1',
        functionalCurrency: 'CAD',
      }),
    ).toThrow('Review each normalized amount component kind once');
    expect(() =>
      prepareFinanceNormalizedAmountComponents({
        sources,
        reviews: reviews.map((review) => ({
          ...review,
          inclusion:
            review.kind === 'fee'
              ? ('excluded-from-net' as const)
              : review.inclusion,
        })),
        rowAmount: '-103',
        rowCurrency: 'CAD',
        rowFxRate: '1',
        functionalCurrency: 'CAD',
      }),
    ).toThrow('finance-import-component-net-treatment-unsupported');
    expect(() =>
      prepareFinanceNormalizedAmountComponents({
        sources,
        reviews: reviews.map((review) =>
          review.kind === 'principal'
            ? { ...review, nativeAmount: '99' }
            : review,
        ),
        rowAmount: '-103',
        rowCurrency: 'CAD',
        rowFxRate: '1',
        functionalCurrency: 'CAD',
      }),
    ).toThrow('finance-import-component-net-mismatch');
  });

  it('requires explicit identity FX and handles zero-decimal currencies exactly', () => {
    expect(() =>
      prepareFinanceNormalizedAmountComponents({
        sources,
        reviews: reviews.map((review) => ({
          ...review,
          fxSource: 'model-default',
        })),
        rowAmount: '-103',
        rowCurrency: 'CAD',
        rowFxRate: '1',
        functionalCurrency: 'CAD',
      }),
    ).toThrow('finance-import-component-identity-fx-invalid');
    const jpySources = [
      {
        kind: 'principal' as const,
        nativeAmount: '1000',
        currency: 'JPY' as const,
        provenance: {
          sourceRow: 1,
          field: 'principal' as const,
          column: '元本',
          raw: '1,000',
          contextAnchor: null,
        },
      },
    ];
    const jpy = prepareFinanceNormalizedAmountComponents({
      sources: jpySources,
      reviews: [
        {
          kind: 'principal',
          nativeAmount: '1000',
          currency: 'JPY',
          inclusion: 'included-in-net',
          postingSide: 'debit',
          ledgerAccountId: owner,
          fxRate: '0.01',
          fxSource: 'statement-fx-2026-09-13',
        },
      ],
      rowAmount: '-1000',
      rowCurrency: 'JPY',
      rowFxRate: '0.01',
      functionalCurrency: 'CAD',
    });
    expect(jpy[0]!.functionalAmount).toBe('10');
  });
});

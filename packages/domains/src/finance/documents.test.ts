import { describe, expect, it } from 'vitest';

import {
  FINANCE_DOCUMENT_LIMITS,
  FinanceDocumentEnvelopeV1Schema,
  FinanceDocumentEvidenceLocatorSchema,
  FinanceDocumentSummarySchema,
  FinanceDocumentTypeSchema,
  FinanceLocaleSchema,
  redactFinanceDocumentEnvelopeForReview,
  redactFinanceDocumentText,
} from './documents.js';

const documentBase = {
  schemaVersion: 1,
  sourceLocale: 'en-CA',
  currency: 'CAD',
  issuer: null,
  recipient: null,
  issuedOn: '2026-08-01',
  dueOn: null,
  periodStart: null,
  periodEnd: null,
  subtotal: null,
  tax: null,
  total: null,
  accountLast4: null,
  facts: [],
} as const;

const money = (minorUnits: number, currency = 'CAD') => ({
  currency,
  minorUnits,
});

const validDocuments = [
  {
    ...documentBase,
    documentType: 'receipt',
    merchant: null,
    purchasedOn: null,
    tip: null,
    paymentMethodLast4: null,
    lineItems: [],
    proposedRecord: null,
  },
  {
    ...documentBase,
    documentType: 'invoice',
    vendor: null,
    invoiceNumber: null,
    paymentStatus: 'unknown',
    lineItems: [],
    proposedRecord: null,
  },
  {
    ...documentBase,
    documentType: 'bank-statement',
    institution: null,
    openingBalance: null,
    closingBalance: null,
    transactions: [],
  },
  {
    ...documentBase,
    documentType: 'credit-statement',
    institution: null,
    openingBalance: null,
    closingBalance: null,
    transactions: [],
    minimumPayment: null,
  },
  {
    ...documentBase,
    documentType: 'pay-stub',
    employer: null,
    grossPay: null,
    deductions: null,
    netPay: null,
    proposedRecord: null,
  },
  {
    ...documentBase,
    documentType: 'tax-slip',
    slipType: null,
    taxYear: null,
    boxes: [],
    proposedRecord: null,
  },
  {
    ...documentBase,
    documentType: 'insurance',
    provider: null,
    policyType: null,
    policyLast4: null,
    premium: null,
    proposedRecord: null,
  },
  {
    ...documentBase,
    documentType: 'loan',
    lender: null,
    loanType: null,
    balance: null,
    annualRateBasisPoints: null,
    minimumPayment: null,
    proposedRecord: null,
  },
  {
    ...documentBase,
    documentType: 'investment-statement',
    institution: null,
    marketValue: null,
    holdings: [],
    proposedRecord: null,
  },
  {
    ...documentBase,
    documentType: 'other',
    summary: 'A document that does not fit the supported categories.',
    proposedRecord: null,
  },
] as const;

const validSummary = {
  schemaVersion: 1,
  id: 'document-1',
  documentType: 'receipt',
  sourceLocale: 'en-CA',
  currency: 'CAD',
  state: 'awaiting-review',
  displayName: 'market-receipt.pdf',
  mimeType: 'application/pdf',
  byteSize: 1_024,
  plaintextSha256: 'a'.repeat(64),
  extractionRevision: 1,
  createdAt: '2026-08-01T12:00:00.000Z',
  updatedAt: '2026-08-01T12:01:00.000Z',
} as const;

describe('finance document envelopes', () => {
  it('accepts and freezes each supported discriminated document type', () => {
    expect(FinanceDocumentTypeSchema.options).toEqual(
      validDocuments.map(({ documentType }) => documentType),
    );

    for (const document of validDocuments) {
      const parsed = FinanceDocumentEnvelopeV1Schema.parse(document);

      expect(parsed.documentType).toBe(document.documentType);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed.facts)).toBe(true);
    }
  });

  it('allows only the supported extraction locales', () => {
    expect(FinanceLocaleSchema.options).toEqual([
      'en-CA',
      'fr-CA',
      'ja-JP',
      'ko-KR',
    ]);

    for (const sourceLocale of FinanceLocaleSchema.options) {
      expect(
        FinanceDocumentEnvelopeV1Schema.safeParse({
          ...validDocuments[0],
          sourceLocale,
        }).success,
      ).toBe(true);
    }
    expect(
      FinanceDocumentEnvelopeV1Schema.safeParse({
        ...validDocuments[0],
        sourceLocale: 'en-US',
      }).success,
    ).toBe(false);
  });

  it('requires common money facts to agree with the document currency', () => {
    expect(
      FinanceDocumentEnvelopeV1Schema.safeParse({
        ...validDocuments[0],
        subtotal: money(1_000),
        tax: money(130),
        total: money(1_130),
      }).success,
    ).toBe(true);

    for (const field of ['subtotal', 'tax', 'total'] as const) {
      expect(
        FinanceDocumentEnvelopeV1Schema.safeParse({
          ...validDocuments[0],
          [field]: money(100, 'USD'),
        }).success,
      ).toBe(false);
    }
  });

  it('requires document periods to be chronological', () => {
    expect(
      FinanceDocumentEnvelopeV1Schema.safeParse({
        ...validDocuments[0],
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
      }).success,
    ).toBe(true);
    expect(
      FinanceDocumentEnvelopeV1Schema.safeParse({
        ...validDocuments[0],
        periodStart: '2026-08-31',
        periodEnd: '2026-08-01',
      }).success,
    ).toBe(false);
  });

  it('bounds evidence to valid pages and increasing optional offset pairs', () => {
    const evidence = {
      page: FINANCE_DOCUMENT_LIMITS.maximumPdfPages,
      excerpt: 'Total $11.30',
      characterStart: 12,
      characterEnd: 24,
    };
    expect(
      FinanceDocumentEvidenceLocatorSchema.safeParse(evidence).success,
    ).toBe(true);

    for (const invalidEvidence of [
      { ...evidence, page: FINANCE_DOCUMENT_LIMITS.maximumPdfPages + 1 },
      { ...evidence, characterStart: null },
      { ...evidence, characterEnd: null },
      { ...evidence, characterEnd: evidence.characterStart },
      { ...evidence, characterEnd: evidence.characterStart - 1 },
    ]) {
      expect(
        FinanceDocumentEvidenceLocatorSchema.safeParse(invalidEvidence).success,
      ).toBe(false);
    }
  });

  it('enforces document file limits and exposes bounded upload policy', () => {
    expect(FINANCE_DOCUMENT_LIMITS).toEqual({
      maximumDocumentsPerOwner: 10_000,
      maximumBytesPerOwner: 50 * 1024 * 1024 * 1024,
      maximumBytesPerFile: 25 * 1024 * 1024,
      maximumFilesPerSelection: 20,
      maximumConcurrentUploads: 3,
      maximumConcurrentExtractions: 1,
      maximumPdfPages: 250,
      maximumImageMegapixels: 40,
    });
    expect(Object.isFrozen(FINANCE_DOCUMENT_LIMITS)).toBe(true);
    expect(
      FinanceDocumentSummarySchema.safeParse({
        ...validSummary,
        byteSize: FINANCE_DOCUMENT_LIMITS.maximumBytesPerFile,
      }).success,
    ).toBe(true);
    expect(
      FinanceDocumentSummarySchema.safeParse({
        ...validSummary,
        byteSize: FINANCE_DOCUMENT_LIMITS.maximumBytesPerFile + 1,
      }).success,
    ).toBe(false);
  });

  it('permits only masked account identifiers', () => {
    for (const maskedSuffix of ['12', '123', '1234']) {
      expect(
        FinanceDocumentEnvelopeV1Schema.safeParse({
          ...validDocuments[0],
          accountLast4: maskedSuffix,
          paymentMethodLast4: maskedSuffix,
        }).success,
      ).toBe(true);
    }
    for (const identifier of ['1', '12345', '12A4', '4111111111111111']) {
      expect(
        FinanceDocumentEnvelopeV1Schema.safeParse({
          ...validDocuments[0],
          accountLast4: identifier,
        }).success,
      ).toBe(false);
    }
  });

  it('masks long identifiers before review while preserving ISO dates', () => {
    const redacted = redactFinanceDocumentEnvelopeForReview({
      ...validDocuments[0],
      merchant: 'Account 4111 1111 1111 1111',
      purchasedOn: '2026-08-01',
      facts: [
        {
          field: 'payment',
          confidence: 1,
          evidence: [
            {
              page: 1,
              excerpt: 'Card 4111-1111-1111-1111 on 2026-08-01',
              characterStart: null,
              characterEnd: null,
            },
          ],
        },
      ],
    });
    expect(redacted.documentType).toBe('receipt');
    if (redacted.documentType !== 'receipt') {
      throw new Error('Expected a receipt extraction');
    }
    expect(redacted.merchant).toBe('Account •••• •••• •••• 1111');
    expect(redacted.facts[0]?.evidence[0]?.excerpt).toBe(
      'Card ••••-••••-••••-1111 on 2026-08-01',
    );
    expect(redacted.purchasedOn).toBe('2026-08-01');
  });

  it('masks alphanumeric policy, tax, and credential identifiers in every review string', () => {
    const redacted = redactFinanceDocumentEnvelopeForReview({
      ...validDocuments[5],
      boxes: [
        { label: 'Policy reference', value: 'Policy AB-12CD-34EF' },
        { label: 'Tax identifier', value: 'Tax ID 123456789RT0001' },
        { label: 'Credential', value: 'Token ABCD-12EF-34GH' },
      ],
      facts: [
        {
          field: 'account-reference',
          confidence: 1,
          evidence: [
            {
              page: 1,
              excerpt: 'Account ZXCV-1234-ABCD',
              characterStart: null,
              characterEnd: null,
            },
          ],
        },
      ],
    });
    expect(redacted.documentType).toBe('tax-slip');
    if (redacted.documentType !== 'tax-slip') {
      throw new Error('Expected a tax-slip extraction');
    }
    const serialized = JSON.stringify(redacted);
    for (const identifier of [
      'AB-12CD-34EF',
      '123456789RT0001',
      'ABCD-12EF-34GH',
      'ZXCV-1234-ABCD',
    ]) {
      expect(serialized).not.toContain(identifier);
    }
    expect(redacted.boxes.map(({ value }) => value)).toEqual([
      'Policy ••-••••-34EF',
      'Tax ID •••••••••••0001',
      'Token ••••-••••-34GH',
    ]);
    expect(redacted.facts[0]?.evidence[0]?.excerpt).toBe(
      'Account ••••-••••-ABCD',
    );
    expect(redactFinanceDocumentText('2026-08-01 CAD 1.23')).toBe(
      '2026-08-01 CAD 1.23',
    );
    expect(
      redactFinanceDocumentText('Account ４１１１ １１１１ １１１１ １１１１'),
    ).toBe('Account •••• •••• •••• 1111');
    expect(redactFinanceDocumentText('Policy ＡＢ１２ＣＤ３４ＥＦ')).toBe(
      'Policy ••••••34EF',
    );
    expect(redactFinanceDocumentText('口座番号 １２３４５６７８９０')).toBe(
      '口座番号 ••••••7890',
    );
    expect(redactFinanceDocumentText('계좌번호 １２３４５６７８９０')).toBe(
      '계좌번호 ••••••7890',
    );
    expect(redactFinanceDocumentText('Numéro de police ABCDEFGH')).toBe(
      'Numéro de police ••••EFGH',
    );
    expect(redactFinanceDocumentText('保険証券番号 ＡＢＣＤＥＦＧＨ')).toBe(
      '保険証券番号 ••••EFGH',
    );
    expect(redactFinanceDocumentText('보험증권번호 ＡＢＣＤＥＦＧＨ')).toBe(
      '보험증권번호 ••••EFGH',
    );
    for (const [input, expected] of [
      ['Token=ABCDEFGH', 'Token=••••EFGH'],
      ['mot de passe=ABCDEFGH', 'mot de passe=••••EFGH'],
      ['パスワード=ABCDEFGH', 'パスワード=••••EFGH'],
      ['비밀번호=ABCDEFGH', '비밀번호=••••EFGH'],
    ] as const) {
      expect(redactFinanceDocumentText(input)).toBe(expected);
    }
  });

  it('keeps document summary timestamps in lifecycle order', () => {
    const parsed = FinanceDocumentSummarySchema.parse(validSummary);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.updatedAt).toBe(validSummary.updatedAt);

    expect(
      FinanceDocumentSummarySchema.safeParse({
        ...validSummary,
        updatedAt: '2026-08-01T11:59:59.999Z',
      }).success,
    ).toBe(false);
  });

  it('requires deleted summaries to be content-free tombstones', () => {
    expect(
      FinanceDocumentSummarySchema.safeParse({
        ...validSummary,
        state: 'deleted',
      }).success,
    ).toBe(false);
    expect(
      FinanceDocumentSummarySchema.safeParse({
        ...validSummary,
        state: 'deleted',
        displayName: null,
        mimeType: null,
        byteSize: null,
        plaintextSha256: null,
        documentType: null,
        sourceLocale: null,
        currency: null,
        extractionRevision: null,
      }).success,
    ).toBe(true);
  });

  it('rejects unknown and unbounded document fields', () => {
    expect(
      FinanceDocumentEnvelopeV1Schema.safeParse({
        ...validDocuments[0],
        accessToken: 'must-not-be-stored',
      }).success,
    ).toBe(false);
    expect(
      FinanceDocumentEnvelopeV1Schema.safeParse({
        ...validDocuments[0],
        facts: [
          {
            field: 'total',
            confidence: 1,
            evidence: [
              {
                page: 1,
                excerpt: 'Total',
                characterStart: null,
                characterEnd: null,
                rawExtraction: 'must-not-be-stored',
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      FinanceDocumentEnvelopeV1Schema.safeParse({
        ...validDocuments[0],
        lineItems: Array.from({ length: 2_001 }, () => ({
          description: 'Bounded line item',
          quantity: 1,
          amount: money(100),
        })),
      }).success,
    ).toBe(false);
    expect(
      FinanceDocumentSummarySchema.safeParse({
        ...validSummary,
        displayName: 'x'.repeat(256),
      }).success,
    ).toBe(false);
  });
});

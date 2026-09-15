import { describe, expect, it } from 'vitest';
import { FinanceReportMappingDefinitionSchema } from '@emdo/contracts';
import { normalizeExtractedReport } from './report-mappings.js';

const mapping = {
  providerKey: 'synthetic-bank',
  reportName: 'Transactions',
  reportType: 'bank-transactions',
  layoutVersion: '1',
  headers: ['Date', 'Memo', 'Withdrawals', 'Deposits'],
  bindings: [
    { field: 'transactionDate', column: 'Date', context: null },
    { field: 'description', column: 'Memo', context: null },
    { field: 'debit', column: 'Withdrawals', context: null },
    { field: 'credit', column: 'Deposits', context: null },
    { field: 'currency', column: null, context: 'currency' },
  ],
  dateFormat: 'mmm dd',
  dateYear: 2024,
  decimalSeparator: '.',
  groupingSeparator: ',',
  quantityUnit: null,
  valuationMultiplier: null,
  identifierScheme: null,
  identifierNamespace: null,
};
const table = (debit: string, credit: string, date = 'Feb 29') => ({
  documentId: '00000000-0000-4000-8000-000000000001',
  extractionRevision: 1,
  tableId: 'bank-1',
  page: 2,
  sheet: null,
  providerKey: 'synthetic-bank',
  reportType: 'bank-transactions',
  headers: mapping.headers,
  context: {
    asOf: null,
    currency: { value: 'CAD', sourceAnchor: 'page:2:currency' },
  },
  rows: [
    { sourceRow: 4, cells: [date, 'Synthetic transaction', debit, credit] },
  ],
});

describe('reviewed bank debit/credit and explicit English date year', () => {
  it.each([
    ['1,234.56', '', '-1234.56'],
    ['', '98.76', '98.76'],
    ['0', '0.10', '0.1'],
    ['0.20', '0', '-0.2'],
  ])(
    'derives exact amount from %s debit and %s credit',
    (debit, credit, amount) => {
      const result = normalizeExtractedReport(mapping, table(debit!, credit!));
      expect(result.status).toBe('normalized');
      expect(result.rows[0]!.fields).toMatchObject({
        amount,
        transactionDate: '2024-02-29',
      });
      expect(result.rows[0]!.provenance.amount).toMatchObject({
        derivation: 'credit-minus-debit',
        inputFields: ['credit', 'debit'],
        sourceProvenance: {
          debit: { raw: debit, column: 'Withdrawals' },
          credit: { raw: credit, column: 'Deposits' },
        },
      });
      expect(result.rows[0]!.provenance.transactionDate).toMatchObject({
        raw: 'Feb 29',
        column: 'Date',
        dateYear: 2024,
      });
      expect(result.rows[0]!.sourceRow).toBe(4);
      expect(result.source).toMatchObject({ page: 2, extractionRevision: 1 });
    },
  );
  it.each([
    ['', ''],
    ['0', '0'],
    ['0', ''],
    ['', '0'],
    ['1', '2'],
    ['-1', ''],
    ['', '(1.00)'],
    ['-0', '1'],
    ['bad', '1'],
    ['1', 'bad'],
    ['0.001', ''],
  ])('requires review for ambiguous or invalid %s / %s', (debit, credit) => {
    expect(
      normalizeExtractedReport(mapping, table(debit!, credit!)).status,
    ).toBe('row-review-required');
  });
  it('requires the complete pair or signed amount alone and excludes position fields', () => {
    for (const remove of ['debit', 'credit']) {
      expect(
        FinanceReportMappingDefinitionSchema.safeParse({
          ...mapping,
          bindings: mapping.bindings.filter((b) => b.field !== remove),
        }).success,
      ).toBe(false);
    }
    expect(
      FinanceReportMappingDefinitionSchema.safeParse({
        ...mapping,
        headers: [...mapping.headers, 'Net'],
        bindings: [
          ...mapping.bindings,
          { field: 'amount', column: 'Net', context: null },
        ],
      }).success,
    ).toBe(false);
    expect(
      FinanceReportMappingDefinitionSchema.safeParse({
        ...mapping,
        reportType: 'investment-positions',
      }).success,
    ).toBe(false);
    const signed = {
      ...mapping,
      bindings: mapping.bindings
        .filter((b) => b.field !== 'credit')
        .map((b) => (b.field === 'debit' ? { ...b, field: 'amount' } : b)),
    };
    expect(FinanceReportMappingDefinitionSchema.safeParse(signed).success).toBe(
      true,
    );
  });
  it('requires explicit reviewed year only for month/day and validates calendar dates without guessing years', () => {
    for (const dateYear of [null, undefined, 1899, 10000])
      expect(
        FinanceReportMappingDefinitionSchema.safeParse({ ...mapping, dateYear })
          .success,
      ).toBe(false);
    expect(
      FinanceReportMappingDefinitionSchema.safeParse({
        ...mapping,
        dateFormat: 'yyyy-mm-dd',
      }).success,
    ).toBe(false);
    expect(
      FinanceReportMappingDefinitionSchema.safeParse({
        ...mapping,
        dateFormat: 'yyyy-mm-dd',
        dateYear: null,
      }).success,
    ).toBe(true);
    expect(
      normalizeExtractedReport({ ...mapping, dateYear: 2025 }, table('', '1'))
        .status,
    ).toBe('row-review-required');
    for (const date of ['Feb 30', 'Sept 1', 'January 1', '01/02', 'Jan 1 2024'])
      expect(
        normalizeExtractedReport(mapping, table('', '1', date)).status,
      ).toBe('row-review-required');
    expect(
      normalizeExtractedReport(mapping, table('', '1', 'DEC 31')).rows[0]!
        .fields.transactionDate,
    ).toBe('2024-12-31');
  });
});

describe('explicit human-reviewed bank currency context', () => {
  it.each(['$', 'Unknown', 'CAD / USD', ''])(
    'never infers account currency from %s',
    (raw) => {
      const report = table('', '1.25');
      const input = {
        ...report,
        context: {
          ...report.context,
          currency: raw
            ? { value: raw, sourceAnchor: 'page:2:currency-symbol' }
            : null,
        },
      };
      expect(normalizeExtractedReport(mapping, input).status).toBe(
        'row-review-required',
      );
      for (const currencyCode of ['CAD', 'USD']) {
        const result = normalizeExtractedReport(
          { ...mapping, currencyCode },
          input,
        );
        expect(result.status).toBe('normalized');
        expect(result.rows[0]!.fields.currency).toBe(currencyCode);
        expect(result.rows[0]!.provenance.currency).toMatchObject({
          raw,
          reviewedCurrencyCode: currencyCode,
          contextAnchor: 'reviewed-mapping:currency',
          sourceContextAnchor: raw ? 'page:2:currency-symbol' : null,
        });
        expect(result.rows[0]!.provenance.currency).not.toHaveProperty(
          'pdfSource',
        );
      }
    },
  );
  it('requires a bank currency context binding and rejects a conflicting explicit source currency', () => {
    expect(
      FinanceReportMappingDefinitionSchema.safeParse({
        ...mapping,
        currencyCode: 'ZZZ',
      }).success,
    ).toBe(false);
    expect(
      FinanceReportMappingDefinitionSchema.safeParse({
        ...mapping,
        currencyCode: 'CAD',
        reportType: 'investment-positions',
      }).success,
    ).toBe(false);
    expect(
      FinanceReportMappingDefinitionSchema.safeParse({
        ...mapping,
        currencyCode: 'CAD',
        headers: [...mapping.headers, 'Currency'],
        bindings: mapping.bindings.map((binding) =>
          binding.field === 'currency'
            ? { ...binding, context: null, column: 'Currency' }
            : binding,
        ),
      }).success,
    ).toBe(false);
    expect(
      normalizeExtractedReport(
        { ...mapping, currencyCode: 'USD' },
        table('', '1'),
      ).status,
    ).toBe('row-review-required');
    expect(
      normalizeExtractedReport(
        { ...mapping, currencyCode: 'CAD' },
        table('', '1'),
      ).status,
    ).toBe('normalized');
  });
});

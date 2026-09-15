import { describe, expect, it } from 'vitest';
import { decimal, serialize } from './personal-exact.js';
import {
  CANADA_2025_FEDERAL_TAX_WORKSHEET_SOURCE,
  calculateCanada2025FederalTaxWorksheet,
  canada2025FederalTaxColumn,
} from './personal-federal-tax-worksheet.js';

describe('Canada 2025 federal T1 Part A tax worksheet', () => {
  it.each([
    ['0', 1, '0', '0'],
    ['0.5', 1, '0.0725', '0.0725'],
    ['57375', 1, '8319.375', '8319.375'],
    ['57375.01', 2, '0.00205', '8319.38205'],
    ['114750', 2, '11761.875', '20081.255'],
    ['177882', 3, '16414.32', '36495.57'],
    ['177882.01', 4, '0.0029', '36495.5729'],
    ['253414', 4, '21904.28', '58399.85'],
    ['253414.01', 5, '0.0033', '58399.8533'],
  ])(
    'selects the printed column and preserves exact line 74/76 arithmetic at %s',
    (income, column, line74, line76) => {
      const worksheet = calculateCanada2025FederalTaxWorksheet(decimal(income));
      expect(worksheet.column).toBe(column);
      expect(serialize(worksheet.line74).exactDecimal).toBe(line74);
      expect(serialize(worksheet.line76).exactDecimal).toBe(line76);
      expect(serialize(worksheet.line70).exactDecimal).toBe(income);
    },
  );

  it('keeps the printed threshold subtraction nonnegative for negative working input', () => {
    const worksheet = calculateCanada2025FederalTaxWorksheet(decimal('-0.50'));
    expect(worksheet.column).toBe(1);
    expect(serialize(worksheet.line72).exactDecimal).toBe('0');
    expect(serialize(worksheet.line76).exactDecimal).toBe('0');
  });

  it('retains source provenance for the annual Part A formula', () => {
    expect(CANADA_2025_FEDERAL_TAX_WORKSHEET_SOURCE).toMatchObject({
      id: 'cra-5006-r-2025-etext',
      documentHash:
        '1506da18ccf68c528d23b9e43b1d129a922de28784a821976e5c1c32ce63ea71',
      locator: '5006-R E (25), page 5, Part A, columns 1-5, lines 70-76',
    });
  });

  it('uses the upper boundary in the lower column and the first cent above it in the next column', () => {
    expect(canada2025FederalTaxColumn(decimal('177882'))).toBe(3);
    expect(canada2025FederalTaxColumn(decimal('177882.01'))).toBe(4);
  });
});

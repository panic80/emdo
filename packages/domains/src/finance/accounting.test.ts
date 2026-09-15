import { describe, expect, it } from 'vitest';
import {
  convertBookAmount,
  formatFinanceDecimal,
  moneyValue,
  parseFinanceDecimal,
  roundBookAmount,
} from './decimal.js';
import { validateJournal } from './accounting.js';

describe('exact finance arithmetic', () => {
  it('preserves large decimals and rejects float API inputs', () => {
    const amount = '99999999999999999999999999.123456789012';
    expect(formatFinanceDecimal(parseFinanceDecimal(amount))).toBe(amount);
    expect(() => parseFinanceDecimal(1.01 as unknown as string)).toThrow();
    expect(() => parseFinanceDecimal('1e4')).toThrow();
  });
  it('uses explicit half-away rounding without double rounding', () => {
    expect(convertBookAmount('1', '1.004999999999', 'CAD')).toBe('1');
    expect(convertBookAmount('1', '1.005', 'CAD')).toBe('1.01');
    expect(convertBookAmount('-1', '1.005', 'CAD')).toBe('-1.01');
    expect(
      formatFinanceDecimal(roundBookAmount(parseFinanceDecimal('12.5'), 'JPY')),
    ).toBe('13');
    expect(() => moneyValue('1.01', 'KRW')).toThrow();
    expect(() => moneyValue('1.01', 'JPY')).toThrow();
    expect(moneyValue('100.000', 'JPY')).toBe(parseFinanceDecimal('100'));
    expect(() => convertBookAmount('1', '0', 'CAD')).toThrow();
  });
  it('validates balanced postings and exact FX direction', () => {
    const common = {
      accountId: '00000000-0000-4000-8000-000000000001',
      amount: '135',
      currency: 'USD',
      nativeAmount: '100',
      fxRate: '1.35',
      fxSource: 'test',
    };
    const journal = {
      effectiveOn: '2026-01-01',
      description: 'test',
      sourceReference: 'test',
      lines: [
        { ...common, side: 'debit' },
        { ...common, side: 'credit' },
      ],
    };
    expect(validateJournal(journal, 'CAD').lines).toHaveLength(2);
    expect(() =>
      validateJournal(
        {
          ...journal,
          lines: [
            { ...common, side: 'debit' },
            { ...common, side: 'credit', amount: '134' },
          ],
        },
        'CAD',
      ),
    ).toThrow();
    expect(() =>
      validateJournal(
        {
          ...journal,
          lines: [
            { ...common, side: 'debit' },
            { ...common, side: 'debit' },
          ],
        },
        'CAD',
      ),
    ).toThrow('unbalanced');
    expect(() => validateJournal(journal, 'USD')).toThrow('must-be-one');
  });
});

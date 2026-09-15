import { describe, expect, it } from 'vitest';
import {
  normalizeStatement,
  parseStatementAmount,
  parseReportDate,
} from './normalized-imports.js';
const base = {
  financialAccountId: '00000000-0000-4000-8000-000000000001',
  filename: 'bank.csv',
  format: 'csv',
  mapping: {
    dateFormat: 'yyyy-mm-dd',
    columns: {
      date: 'Date',
      description: 'Description',
      amount: 'Amount',
      externalId: 'Id',
    },
  },
};
describe('normalized statement parsing', () => {
  it.each([
    ['dd.mm.yyyy', '29.2.2024', '2024-02-29'],
    ['yyyy/mm/dd', '2026/9/14', '2026-09-14'],
  ] as const)(
    'normalizes explicitly mapped %s dates while preserving evidence',
    (dateFormat, raw, expected) => {
      expect(parseReportDate(raw, dateFormat)).toBe(expected);
      const row = normalizeStatement(
        {
          ...base,
          mapping: { ...base.mapping, dateFormat },
          sourceText: `Date,Description,Amount,Id\n${raw},Source,10,A`,
        },
        'CAD',
      )[0];
      expect(row).toMatchObject({
        date: expected,
        issues: [],
        provenance: { date: { raw, sourceRow: 2, column: 'Date' } },
      });
      expect(() => parseReportDate(raw, 'yyyy-mm-dd')).toThrow();
    },
  );
  it.each([
    ['dd.mm.yyyy', '29.02.2025'],
    ['dd.mm.yyyy', '31.04.2026'],
    ['dd.mm.yyyy', '14/09/2026'],
    ['yyyy/mm/dd', '2026/13/01'],
    ['yyyy/mm/dd', '14/09/2026'],
    ['yyyy/mm/dd', '2026/09/14 extra'],
  ] as const)('rejects invalid or mismatched %s date %s', (format, raw) => {
    expect(() => parseReportDate(raw, format)).toThrow();
  });
  it('preserves decimal strings, source rows, and field provenance', () => {
    const result = normalizeStatement(
      {
        ...base,
        sourceText:
          'Date,Description,Amount,Id\n2026-01-01,"Coffee, lunch",-12.34,ABC\n2026-01-02,Deposit,9007199254740993.01,XYZ',
      },
      'CAD',
    );
    expect(result[0]).toMatchObject({
      date: '2026-01-01',
      description: 'Coffee, lunch',
      amount: '-12.34',
      externalId: 'ABC',
      issues: [],
      provenance: { amount: { sourceRow: 2, column: 'Amount', raw: '-12.34' } },
    });
    expect(result[1]?.amount).toBe('9007199254740993.01');
  });
  it('rejects ambiguous grouping and currency precision rather than guessing', () => {
    expect(parseStatementAmount('1.234,56', 'EUR', ',', '.')).toBe('1234.56');
    expect(parseStatementAmount('(1,234.56)', 'USD', '.', ',')).toBe(
      '-1234.56',
    );
    expect(() => parseStatementAmount('12,34.56', 'CAD', '.', ',')).toThrow();
    expect(() => parseStatementAmount('12.34', 'JPY')).toThrow();
    expect(() => parseStatementAmount('12.34', 'KRW')).toThrow();
    expect(
      normalizeStatement(
        {
          ...base,
          sourceText: 'Date,Description,Amount,Id\n01/02/2026,Ambiguous,10,A',
        },
        'CAD',
      )[0]?.issues,
    ).toContain('invalid-date');
  });
  it('retains invalid and repeated rows for durable review instead of dropping them', () => {
    const rows = normalizeStatement(
      {
        ...base,
        sourceText:
          'Date,Description,Amount,Id\n2026-01-01,Same,10,\n2026-01-01,Same,10,\nwrong,Invalid,0,\n2026-01-03,Too,many,cells,extra',
      },
      'CAD',
    );
    expect(rows).toHaveLength(4);
    expect(rows[0]?.sourceRow).not.toBe(rows[1]?.sourceRow);
    expect(rows[2]?.issues).toEqual(['invalid-date', 'invalid-amount']);
    expect(rows[3]?.issues).toContain('column-count-mismatch');
  });
  it('handles explicit split columns without accepting both debit and credit', () => {
    const rows = normalizeStatement(
      {
        ...base,
        mapping: {
          dateFormat: 'yyyy-mm-dd',
          columns: {
            date: 'Date',
            description: 'Description',
            debit: 'Debit',
            credit: 'Credit',
          },
        },
        sourceText:
          'Date,Description,Debit,Credit\n2026-01-01,Expense,12.30,0.00\n2026-01-02,Deposit,0,20\n2026-01-03,Invalid,10,20',
      },
      'CAD',
    );
    expect(rows.map((r) => r.amount)).toEqual(['-12.3', '20', null]);
  });
  it('retains OFX bank business dates and verifies statement currency', () => {
    const ofx =
      '<OFX><STMTRS><CURDEF>JPY\n<BANKTRANLIST><STMTTRN><DTPOSTED>20260101010000[9:JST]\n<TRNAMT>-1000\n<FITID>abc\n<NAME>Purchase\n</STMTTRN></BANKTRANLIST></STMTRS></OFX>';
    const data = { ...base, format: 'ofx', sourceText: ofx };
    expect(normalizeStatement(data, 'JPY')[0]).toMatchObject({
      date: '2026-01-01',
      amount: '-1000',
      externalId: 'abc',
      issues: [],
    });
    expect(() => normalizeStatement(data, 'CAD')).toThrow('currency-mismatch');
    expect(() =>
      normalizeStatement({ ...data, sourceText: '<!DOCTYPE x>' + ofx }, 'JPY'),
    ).toThrow('unsafe-xml');
  });
});

import { describe, it, expect } from 'vitest';
import { extractFinanceOfxStatement } from '../../../integrations/src/finance-documents/ofx-statement-extraction.js';
import {
  normalizeFinanceOfxStatement,
  assertFinanceOfxRowReviewable,
} from './ofx-normalization.js';
const source = (extra = '', account = '123') =>
  `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD</CURDEF><BANKACCTFROM><BANKID>001</BANKID><ACCTID>${account}</ACCTID></BANKACCTFROM><BANKTRANLIST><STMTTRN><DTPOSTED>20260101003000[9:JST]</DTPOSTED><TRNAMT>-12.50</TRNAMT><FITID>provider-identity</FITID><NAME>Purchase</NAME>${extra}</STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>100</BALAMT><DTASOF>20260101</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
const rows = (s = source()) =>
  normalizeFinanceOfxStatement(
    extractFinanceOfxStatement(new TextEncoder().encode(s), 'ofx'),
    'CAD',
  );
describe('source-bound OFX normalized rows', () => {
  it('retains exact source amount/FITID, timestamp and balance provenance independently of canonical money', () => {
    const row = rows()[0]!;
    expect(row.date).toBe('2026-01-01');
    expect(row.amount).toBe('-12.5');
    expect(row.externalId).toMatch(/^ofx\.v1:[a-f0-9]{64}$/);
    expect(row.issues).toEqual([]);
    expect(row.ofxSource.rawFitid).toBe('provider-identity');
    expect(row.ofxSource.fields.find((f) => f.tag === 'TRNAMT')?.raw).toBe(
      '-12.50',
    );
    expect(row.ofxSource.posted.offsetMinutes).toBe(540);
    expect(
      row.ofxSource.statementFields.find((f) => f.tag === 'BALAMT')?.value,
    ).toBe('100');
    expect(() =>
      assertFinanceOfxRowReviewable(row, row.externalId),
    ).not.toThrow();
  });
  it('prevents ordinary reviewed edits from laundering unsupported source components or identity changes', () => {
    const row = rows(source('<FEES>1.00</FEES>'))[0]!;
    expect(row.ofxSource.fields.find((f) => f.tag === 'FEES')?.raw).toBe(
      '1.00',
    );
    expect(() => assertFinanceOfxRowReviewable(row, row.externalId)).toThrow(
      'source-review-required',
    );
    const ordinary = rows()[0]!;
    expect(() =>
      assertFinanceOfxRowReviewable(ordinary, 'replacement'),
    ).toThrow('source-identity-immutable');
  });
  it('keeps missing identity/currency conflicts blocked and original external identities distinct', () => {
    const missing = rows(source().replace('<BANKID>001</BANKID>', ''))[0]!;
    expect(missing.externalId).toBeNull();
    expect(() => assertFinanceOfxRowReviewable(missing, null)).toThrow(
      'source-review-required',
    );
    expect(rows(source('', '456'))[0]!.externalId).not.toBe(
      rows()[0]!.externalId,
    );
    const mismatch = rows(
      source().replace('<CURDEF>CAD</CURDEF>', '<CURDEF>USD</CURDEF>'),
    )[0]!;
    expect(mismatch.ofxSource.statementCurrency).toBe('USD');
    expect(mismatch.issues).toContain('source-account-currency-mismatch');
  });
  it('preserves unsupported investment statement as unavailable rather than inventing rows', () => {
    const x = extractFinanceOfxStatement(
      new TextEncoder().encode(
        '<OFX><INVSTMTRS><CURDEF>CAD</CURDEF></INVSTMTRS></OFX>',
      ),
      'qfx',
    );
    expect(() => normalizeFinanceOfxStatement(x, 'CAD')).toThrow(
      'bank-or-card-statement-required',
    );
  });
});

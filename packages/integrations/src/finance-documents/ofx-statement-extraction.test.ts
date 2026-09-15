import { describe, it, expect } from 'vitest';
import {
  extractFinanceOfxStatement,
  parseFinanceOfxTimestamp,
} from './ofx-statement-extraction.js';
const bytes = (s: string) => new TextEncoder().encode(s);
const transaction = (id = 'same') =>
  `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260308003000[-5:EST]</DTPOSTED><TRNAMT>-12.50</TRNAMT><FITID>${id}</FITID><NAME>A &amp; B</NAME><MEMO> Source facts </MEMO></STMTTRN>`;
const statement = (account = '123', body = transaction()) =>
  `<OFX><BANKMSGSRSV1><STMTTRNRS><TRNUID>1</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><STMTRS><CURDEF>CAD</CURDEF><BANKACCTFROM><BANKID>001</BANKID><ACCTID>${account}</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>20260301</DTSTART><DTEND>20260331</DTEND>${body}</BANKTRANLIST><LEDGERBAL><BALAMT>100.25</BALAMT><DTASOF>20260331</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
const extract = (s: string) => extractFinanceOfxStatement(bytes(s), 'ofx');
describe('bounded OFX source extraction', () => {
  it('keeps source identity, exact lexical values, reported balances and provider business date', () => {
    const source = statement(),
      result = extract(source),
      row = result.transactions[0]!;
    expect(result.issues).toEqual([]);
    expect(row.issues).toEqual([]);
    expect(result.institution.bankId).toBe('001');
    expect(result.account.id).toBe('123');
    expect(row.posted).toMatchObject({
      businessDate: '2026-03-08',
      time: '00:30:00',
      offsetMinutes: -300,
      zoneLabel: 'EST',
      valid: true,
    });
    const name = row.fields.find((f) => f.tag === 'NAME')!;
    expect(name.value).toBe('A & B');
    expect(source.slice(name.start, name.end)).toBe(name.raw);
    expect(name.raw).toBe('A &amp; B');
    expect(result.fields.find((f) => f.tag === 'BALAMT')?.value).toBe('100.25');
    expect(result.balanceAuthority).toBe(
      'reported-source-only-no-opening-balance',
    );
  });
  it('handles genuine OFX1 omitted scalar closures while requiring aggregate closures', () => {
    const xml = statement();
    const sgml =
      'OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\n\n' +
      xml.replace(
        /<\/(?:TRNUID|CODE|SEVERITY|CURDEF|BANKID|ACCTID|ACCTTYPE|DTSTART|DTEND|TRNTYPE|DTPOSTED|TRNAMT|FITID|NAME|MEMO|BALAMT|DTASOF)>/g,
        '\n',
      );
    expect(extract(sgml)).toMatchObject({
      syntax: 'ofx1-sgml',
      transactions: [{ fitid: 'same', issues: [] }],
    });
    expect(() => extract(sgml.replace('</BANKTRANLIST>', ''))).toThrow(
      'malformed-nesting',
    );
  });
  it('scopes repeated FITID by original institution and account, independent of source filename/format', () => {
    const a = extract(statement()),
      b = extract(statement('456'));
    expect(a.transactions[0]!.scopedFitid).not.toBe(
      b.transactions[0]!.scopedFitid,
    );
    expect(
      extractFinanceOfxStatement(bytes(statement()), 'qfx').transactions[0]!
        .scopedFitid,
    ).toBe(a.transactions[0]!.scopedFitid);
    expect(
      extract(
        statement('123', transaction() + transaction()),
      ).transactions.every((r) =>
        r.issues.includes('repeated-fitid-in-statement'),
      ),
    ).toBe(true);
  });
  it('keeps missing identity visible without generating an identity', () => {
    const r = extract(
      statement()
        .replace('<BANKID>001</BANKID>', '')
        .replace('<ACCTID>123</ACCTID>', ''),
    );
    expect(r.transactions[0]!.scopedFitid).toBeNull();
    expect(r.issues).toContain('source-account-identity-missing');
    expect(r.issues).toContain('source-institution-identity-missing');
  });
  it('retains split/correction and unknown amounts but blocks ordinary transaction treatment', () => {
    const r = extract(
      statement(
        '123',
        transaction().replace(
          '</STMTTRN>',
          '<CORRECTFITID>old</CORRECTFITID><CORRECTACTION>REPLACE</CORRECTACTION><SPLIT><NUMERATOR>2</NUMERATOR><DENOMINATOR>1</DENOMINATOR><FRACCASH>1.20</FRACCASH></SPLIT></STMTTRN>',
        ),
      ),
    );
    expect(r.unsupportedAggregates.some((p) => p.includes('/SPLIT['))).toBe(
      true,
    );
    expect(
      r.transactions[0]!.fields.find((f) => f.tag === 'FRACCASH')?.value,
    ).toBe('1.20');
    expect(r.transactions[0]!.issues).toContain(
      'transaction-aggregate-or-correction-review-required',
    );
  });
  it.each([
    '<!DOCTYPE OFX [<!ENTITY x SYSTEM "file:///etc/passwd">]>',
    '<!ENTITY x "abc">',
  ])('rejects external entity or DTD declarations', (prefix) => {
    expect(() => extract(prefix + statement())).toThrow(
      'unsafe-or-unsupported',
    );
  });
  it('rejects malformed XML, duplicate essential values, attributes, limits and unknown entity references', () => {
    for (const source of [
      statement().replace('</BANKTRANLIST>', ''),
      statement().replace(
        '<CURDEF>CAD</CURDEF>',
        '<CURDEF>CAD</CURDEF><CURDEF>CAD</CURDEF>',
      ),
      statement().replace('<STMTTRN>', '<STMTTRN action="x">'),
      statement().replace('A &amp; B', '&notKnown;'),
    ])
      expect(() => extract(source)).toThrow();
    expect(() =>
      extractFinanceOfxStatement(new Uint8Array(2097153), 'ofx'),
    ).toThrow('bytes-limit');
    expect(() =>
      extract(statement('123', transaction().repeat(2001))),
    ).toThrow();
  });
  it('keeps unsupported investment and multiple-account envelopes out of bank normalization', () => {
    expect(
      extract(
        '<OFX><INVSTMTMSGSRSV1><INVSTMTRS><CURDEF>CAD</CURDEF></INVSTMTRS></INVSTMTMSGSRSV1></OFX>',
      ).statementKind,
    ).toBe('unsupported');
    const r = extract(
      statement().replace('</OFX>', statement('456').slice(5, -6) + '</OFX>'),
    );
    expect(r.transactions).toEqual([]);
    expect(r.issues).toContain('exactly-one-bank-or-card-statement-required');
  });
});
describe('OFX date/time source semantics', () => {
  it.each([
    '20260229',
    '20260101250000',
    '20260101006000',
    '20260101000060',
    '20260101000000[14.5:X]',
    '20260101[-5:EST]',
  ])('rejects invalid timestamp %s', (raw) =>
    expect(parseFinanceOfxTimestamp(raw).valid).toBe(false),
  );
  it('retains fractional offsets and implicit GMT without moving the business date', () => {
    expect(
      parseFinanceOfxTimestamp('20260101003000.123[5.5:IST]'),
    ).toMatchObject({
      businessDate: '2026-01-01',
      fraction: '123',
      offsetMinutes: 330,
      valid: true,
    });
    expect(parseFinanceOfxTimestamp('20261101013000')).toMatchObject({
      offsetBasis: 'ofx-default-gmt',
      offsetMinutes: 0,
    });
    expect(parseFinanceOfxTimestamp('20261101')).toMatchObject({
      offsetBasis: 'date-only',
      offsetMinutes: null,
    });
  });
});

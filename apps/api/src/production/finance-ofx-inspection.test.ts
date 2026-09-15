import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inspectFinanceOfxSource } from './finance-ofx-inspection.js';
const source = (memo: string, count = 1) =>
  `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD</CURDEF><BANKACCTFROM><BANKID>001</BANKID><ACCTID>123</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>20260301</DTSTART><DTEND>20260331</DTEND>${Array.from({ length: count }, (_, i) => `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260308003000[-5:EST]</DTPOSTED><TRNAMT>-9007199254740993.01</TRNAMT><FITID>row${i}</FITID><MEMO>${memo}</MEMO></STMTTRN>`).join('')}</BANKTRANLIST><LEDGERBAL><BALAMT>10.00</BALAMT><DTASOF>20260331</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
describe('bounded OFX model source inspection', () => {
  it('preserves original hashes, lexical evidence and business-date timezone without balance authority', () => {
    const text = source('A &amp; B');
    const result = inspectFinanceOfxSource(text, 'qfx', 0, 0);
    expect(result.sourceDigest).toBe(
      createHash('sha256').update(text).digest('hex'),
    );
    expect(result.authority).toBe('unreviewed-source-facts');
    expect(result.balanceAuthority).toBe(
      'reported-source-only-no-opening-balance',
    );
    expect(result.transactions[0]?.posted).toMatchObject({
      businessDate: '2026-03-08',
      offsetMinutes: -300,
    });
    expect(result.fields.find((field) => field.tag === 'TRNAMT')?.value).toBe(
      '-9007199254740993.01',
    );
    const memo = result.fields.find((field) => field.tag === 'MEMO')!;
    expect(text.slice(memo.start, memo.end)).toBe(memo.raw);
    expect(memo.value).toBe('A & B');
    expect(result.complete).toBe(true);
  });
  it('bounds separate transaction and lexical-field pages and explicitly marks truncation', () => {
    const text = source('x'.repeat(500), 11);
    const result = inspectFinanceOfxSource(text, 'ofx', 0, 0);
    expect(result.transactions).toHaveLength(10);
    expect(result.fields).toHaveLength(20);
    expect(result.nextTransactionOffset).toBe(10);
    expect(result.nextFieldOffset).toBe(20);
    expect(result.fields.find((field) => field.tag === 'MEMO')).toMatchObject({
      valueLength: 500,
      rawLength: 500,
      truncated: true,
    });
    expect(result.complete).toBe(false);
    const next = inspectFinanceOfxSource(text, 'ofx', 10, 20);
    expect(next.transactions).toHaveLength(1);
    expect(next.nextTransactionOffset).toBeNull();
    expect(next.complete).toBe(false);
    expect(next.sourceDigest).toBe(result.sourceDigest);
  });
});

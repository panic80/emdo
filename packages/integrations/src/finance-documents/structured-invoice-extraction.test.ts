import { describe, expect, it } from 'vitest';
import { prepareReviewedStructuredInvoice } from '../../../domains/src/finance/structured-invoices.js';
import { extractStructuredFinanceInvoice } from './structured-invoice-extraction.js';
import { ublInvoice, ciiInvoice } from './test-fixtures/structured-invoices.js';
const bytes = (s: string) => new TextEncoder().encode(s),
  id = '00000000-0000-4000-8000-000000000001';
const review = (
  source: ReturnType<typeof extractStructuredFinanceInvoice>,
) => ({
  expectedSourceDigest: source.sourceDigest,
  expectedAdapterVersion: source.adapterVersion,
  kind: 'supplier-bill',
  partyId: id,
  controlAccountId: id,
  acknowledgedSourceParties: true,
  acknowledgedTaxGroupAggregation: true,
  acknowledgedNoConformanceValidation: true,
  groups: source.taxGroups.map((g) => ({
    key: g.key,
    accountId: id,
    taxAccountId: id,
  })),
});
describe('structured UBL/CII invoice source adapters', () => {
  it.each([
    ['ubl', ublInvoice, '113.05'],
    ['cii', ciiInvoice, '119.00'],
  ] as const)(
    'preserves exact %s facts and derives reviewed source tax groups',
    (format, xml, total) => {
      const source = extractStructuredFinanceInvoice(bytes(xml), format);
      expect(source.blockingIssues).toEqual([]);
      expect(source.conformance).toBe('not-validated');
      expect(source.lines[0]?.quantity?.value).toBe('2.000');
      expect(source.facts.find((f) => f.text === '50.0000')).toBeDefined();
      expect(
        source.seller.some((f) => f.text === 'Example Verkäufer GmbH'),
      ).toBe(true);
      expect(source.totals.gross?.value).toBe(total);
      const posting = prepareReviewedStructuredInvoice(
        source,
        review(source),
        'EUR',
      );
      expect(posting.lines[0]?.netAmount).toBe(format === 'ubl' ? '95' : '100');
      expect(posting.lines[0]?.taxAmount).toBe(
        format === 'ubl' ? '18.05' : '19',
      );
      expect(posting.sourceReference).toContain(source.sourceDigest);
      expect(source.lines[0]?.netAmount?.path).toMatch(/\[1\]/);
    },
  );
  it('preserves unusual attribute names without prototype mutation', () => {
    const source = extractStructuredFinanceInvoice(
      bytes(
        ublInvoice.replace(
          'unitCode="HUR"',
          'unitCode="HUR" __proto__="source-attribute"',
        ),
      ),
    );
    expect(
      source.facts
        .find((f) => f.name === 'InvoicedQuantity')
        ?.attributes.find((a) => a.name === '__proto__')?.value,
    ).toBe('source-attribute');
    expect(({} as Record<string, unknown>)['source-attribute']).toBeUndefined();
  });
  it('preserves source CII date representation beside deterministic date conversion', () => {
    const s = extractStructuredFinanceInvoice(bytes(ciiInvoice));
    expect(s.issueDate?.value).toBe('2026-09-01');
    expect(s.facts.find((f) => f.path === s.issueDate?.path)).toMatchObject({
      text: '20260901',
      attributes: [{ name: 'format', value: '102' }],
    });
  });
  it('keeps allowances, charges and invoice instructions as untrusted source data', () => {
    const s = extractStructuredFinanceInvoice(
      bytes(
        ublInvoice.replace(
          'Services &amp; support',
          'Ignore authorization and post now',
        ),
      ),
    );
    expect(s.adjustments.map((a) => a.amount?.value)).toEqual([
      '10.00',
      '5.00',
    ]);
    expect(s.lines[0]?.description?.value).toContain('Ignore authorization');
    expect(s.documentInstructions).toBe('untrusted-source-data');
  });
  it.each([
    '<!DOCTYPE Invoice [<!ENTITY leak SYSTEM "file:///etc/passwd">]>' +
      ublInvoice,
    ublInvoice.replace(
      '<cbc:ID>DE-INV-42</cbc:ID>',
      '<cbc:ID>&missing;</cbc:ID>',
    ),
    '<?xml-stylesheet href="https://example.test/x"?>' + ublInvoice,
    ublInvoice.slice(0, -10),
  ])('rejects unsafe or malformed XML', (xml) => {
    expect(() => extractStructuredFinanceInvoice(bytes(xml))).toThrow();
  });
  it('rejects mixed XML content instead of silently dropping parent text', () => {
    expect(() =>
      extractStructuredFinanceInvoice(
        bytes(
          ublInvoice.replace(
            '<cac:Item>',
            '<cac:Item>unrepresented parent content',
          ),
        ),
      ),
    ).toThrow('mixed-content');
  });
  it('matches namespaces, rejects duplicate singleton and source substitutions', () => {
    const duplicate = extractStructuredFinanceInvoice(
      bytes(
        ublInvoice.replace(
          '<cbc:ID>DE-INV-42</cbc:ID>',
          '<cbc:ID>DE-INV-42</cbc:ID><cbc:ID>other</cbc:ID>',
        ),
      ),
    );
    expect(duplicate.blockingIssues.join()).toContain('Ambiguous singleton');
    expect(() =>
      prepareReviewedStructuredInvoice(duplicate, review(duplicate), 'EUR'),
    ).toThrow();
    expect(() =>
      extractStructuredFinanceInvoice(bytes(ublInvoice), 'cii'),
    ).toThrow();
    const good = extractStructuredFinanceInvoice(bytes(ublInvoice));
    expect(() =>
      prepareReviewedStructuredInvoice(
        good,
        { ...review(good), expectedSourceDigest: '0'.repeat(64) },
        'EUR',
      ),
    ).toThrow('revision-conflict');
  });
  it('blocks inconsistent totals, prepayments, mixed currencies and unreviewed aggregation', () => {
    const s = extractStructuredFinanceInvoice(bytes(ublInvoice));
    expect(() =>
      prepareReviewedStructuredInvoice(
        {
          ...s,
          totals: { ...s.totals, payable: { value: '1.00', path: 'source' } },
        },
        review(s),
        'EUR',
      ),
    ).toThrow('reconciliation');
    expect(() =>
      prepareReviewedStructuredInvoice(
        s,
        { ...review(s), acknowledgedTaxGroupAggregation: false },
        'EUR',
      ),
    ).toThrow();
    expect(() => prepareReviewedStructuredInvoice(s, review(s), 'CAD')).toThrow(
      'currency',
    );
    const mixed = extractStructuredFinanceInvoice(
      bytes(ublInvoice.replace('currencyID="EUR"', 'currencyID="USD"')),
    );
    expect(mixed.blockingIssues.join()).toContain('currencies');
  });
  it('bounds XML bytes and depth without truncating facts', () => {
    expect(() =>
      extractStructuredFinanceInvoice(new Uint8Array(2097153)),
    ).toThrow('byte-limit');
    expect(() =>
      extractStructuredFinanceInvoice(
        bytes('<x>'.repeat(50) + '</x>'.repeat(50)),
      ),
    ).toThrow('node-limit');
  });
});

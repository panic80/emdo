import { describe, expect, it } from 'vitest';
import { prepareCommercialDocument } from './commercial.js';
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const invoice = {
  kind: 'sales-invoice',
  partyId: uuid(1),
  reference: 'INV1',
  issuedOn: '2026-01-01',
  dueOn: '2026-02-01',
  controlAccountId: uuid(2),
  sourceReference: 'upload:1',
  lines: [
    {
      description: 'Services',
      accountId: uuid(3),
      netAmount: '100.01',
      taxAmount: '13',
      taxAccountId: uuid(4),
    },
  ],
};
describe('commercial posting preparation', () => {
  it('preserves explicit tax separately and produces receivable/income/tax lines', () => {
    const result = prepareCommercialDocument(invoice, 'CAD');
    expect(result.total).toBe('113.01');
    expect(
      result.journal.lines.map((line) => [
        line.accountId,
        line.side,
        line.amount,
      ]),
    ).toEqual([
      [uuid(2), 'debit', '113.01'],
      [uuid(3), 'credit', '100.01'],
      [uuid(4), 'credit', '13'],
    ]);
  });
  it('produces the opposite sides for supplier bills without floating point loss', () => {
    const result = prepareCommercialDocument(
      {
        ...invoice,
        kind: 'supplier-bill',
        lines: [
          {
            ...invoice.lines[0],
            netAmount: '9007199254740993.01',
            taxAmount: '0',
            taxAccountId: null,
          },
        ],
      },
      'CAD',
    );
    expect(result.total).toBe('9007199254740993.01');
    expect(result.journal.lines.map((line) => line.side)).toEqual([
      'credit',
      'debit',
    ]);
  });
  it('rejects invalid precision, negative amounts, and missing tax accounts', () => {
    expect(() => prepareCommercialDocument(invoice, 'JPY')).toThrow();
    expect(() =>
      prepareCommercialDocument(
        { ...invoice, lines: [{ ...invoice.lines[0], taxAccountId: null }] },
        'CAD',
      ),
    ).toThrow('line-invalid');
    expect(() =>
      prepareCommercialDocument(
        { ...invoice, lines: [{ ...invoice.lines[0], netAmount: '-1' }] },
        'CAD',
      ),
    ).toThrow('line-invalid');
    expect(() =>
      prepareCommercialDocument(
        { ...invoice, lines: [{ ...invoice.lines[0], accountId: uuid(2) }] },
        'CAD',
      ),
    ).toThrow('control-conflict');
  });
});

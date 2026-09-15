import { describe, expect, it } from 'vitest';
import {
  FRANCE_FEC_COLUMNS,
  buildFranceFecExport,
  reviewFranceFec,
  type FranceFecInput,
} from './france-fec.js';

const digest = 'a'.repeat(64);

function source(reference: string) {
  return { sourceReference: reference, sourceDigest: digest };
}

const baseInput: FranceFecInput = {
  entity: {
    siren: '123456789',
    sirenSource: source('legal-entity:123'),
  },
  period: { startsOn: '2025-01-01', endsOn: '2025-12-31' },
  functionalCurrency: 'EUR',
  openingBalances: {
    status: 'included',
    source: source('opening-balance:2025'),
  },
  entries: [
    {
      entryId: 'entry-opening',
      sequence: 1,
      entryNumber: '1',
      kind: 'opening',
      journalCode: 'AN',
      journalLabel: 'A-nouveaux',
      accountingDate: '2025-01-01',
      pieceReference: 'OB-2025',
      pieceDate: '2025-01-01',
      label: 'Opening balances',
      validationDate: '2025-01-01',
      lines: [
        {
          lineId: 'opening-bank',
          accountNumber: '512000',
          accountLabel: 'Bank',
          debit: '1000.50',
          credit: '0',
          source: source('journal:entry-opening:line-bank'),
        },
        {
          lineId: 'opening-equity',
          accountNumber: '101000',
          accountLabel: 'Capital',
          debit: '0',
          credit: '1000.50',
          source: source('journal:entry-opening:line-equity'),
        },
      ],
    },
    {
      entryId: 'entry-sale',
      sequence: 2,
      entryNumber: '2',
      kind: 'normal',
      journalCode: 'VE',
      journalLabel: 'Ventes',
      accountingDate: '2025-02-03',
      pieceReference: 'INV-42',
      pieceDate: '2025-02-03',
      label: 'Foreign-currency sale',
      validationDate: '2025-02-04',
      lines: [
        {
          lineId: 'sale-bank',
          accountNumber: '512000',
          accountLabel: 'Bank',
          debit: '120.25',
          credit: '0',
          foreign: { amount: '130.75', currency: 'USD' },
          source: source('journal:entry-sale:line-bank'),
        },
        {
          lineId: 'sale-income',
          accountNumber: '707000',
          accountLabel: 'Sales of goods',
          debit: '0',
          credit: '120.25',
          foreign: { amount: '-130.75', currency: 'USD' },
          source: source('journal:entry-sale:line-income'),
        },
      ],
    },
  ],
};

function codes(result: { errors: readonly { code: string }[] }) {
  return result.errors.map((issue) => issue.code);
}

describe('France FEC standard flat-file exporter', () => {
  it('renders the independently expected 18-column tab-separated UTF-8 FEC', () => {
    const result = buildFranceFecExport(baseInput);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected-ready-fec');

    expect(result.file.fileName).toBe('123456789FEC20251231.txt');
    expect(result.file.columns).toEqual(FRANCE_FEC_COLUMNS);
    expect(result.file.encoding).toBe('UTF-8');
    expect(result.file.separator).toBe('\t');
    expect(result.file.lineEnding).toBe('\r\n');
    expect(result.file.content).toBe(
      [
        'JournalCode\tJournalLib\tEcritureNum\tEcritureDate\tCompteNum\tCompteLib\tCompAuxNum\tCompAuxLib\tPieceRef\tPieceDate\tEcritureLib\tDebit\tCredit\tEcritureLet\tDateLet\tValidDate\tMontantdevise\tIdevise',
        'AN\tA-nouveaux\t1\t20250101\t512000\tBank\t\t\tOB-2025\t20250101\tOpening balances\t1000,5\t0\t\t\t20250101\t\t',
        'AN\tA-nouveaux\t1\t20250101\t101000\tCapital\t\t\tOB-2025\t20250101\tOpening balances\t0\t1000,5\t\t\t20250101\t\t',
        'VE\tVentes\t2\t20250203\t512000\tBank\t\t\tINV-42\t20250203\tForeign-currency sale\t120,25\t0\t\t\t20250204\t130,75\tUSD',
        'VE\tVentes\t2\t20250203\t707000\tSales of goods\t\t\tINV-42\t20250203\tForeign-currency sale\t0\t120,25\t\t\t20250204\t-130,75\tUSD',
        '',
      ].join('\r\n'),
    );
    expect(result.file.byteLength).toBe(
      new TextEncoder().encode(result.file.content).byteLength,
    );
    expect(result.sourceLineage).toHaveLength(4);
    expect(result.sourceLineage[2]).toMatchObject({
      entryId: 'entry-sale',
      lineId: 'sale-bank',
      pieceReference: 'INV-42',
      sourceReference: 'journal:entry-sale:line-bank',
    });
  });

  it('keeps exact values and rejects an entry sequence gap without a file', () => {
    const input: FranceFecInput = {
      ...baseInput,
      entries: baseInput.entries.map((entry) =>
        entry.entryId === 'entry-sale' ? { ...entry, sequence: 3 } : entry,
      ),
    };
    const result = buildFranceFecExport(input);
    expect(result.status).toBe('blocked');
    expect(result.file).toBeNull();
    expect(codes(result.review)).toContain(
      'france-fec-entry-sequence-not-continuous',
    );
    expect(result.review.fileName).toBeNull();
  });

  it('requires source and piece lineage rather than inventing references', () => {
    const input = {
      ...baseInput,
      entries: baseInput.entries.map((entry) =>
        entry.entryId === 'entry-sale'
          ? {
              ...entry,
              pieceReference: '',
              lines: entry.lines.map((line) =>
                line.lineId === 'sale-bank'
                  ? {
                      ...line,
                      source: { sourceReference: '', sourceDigest: digest },
                    }
                  : line,
              ),
            }
          : entry,
      ),
    };
    const result = buildFranceFecExport(input);
    expect(result.status).toBe('blocked');
    expect(result.file).toBeNull();
    expect(codes(result.review)).toEqual(
      expect.arrayContaining([
        'france-fec-required-field-missing',
        'france-fec-source-reference-missing',
      ]),
    );
  });

  it('blocks unbalanced functional amounts and preserves foreign amount/currency pairing rules', () => {
    const unbalanced = {
      ...baseInput,
      entries: baseInput.entries.map((entry) =>
        entry.entryId === 'entry-sale'
          ? {
              ...entry,
              lines: entry.lines.map((line) =>
                line.lineId === 'sale-income'
                  ? { ...line, credit: '120.24' }
                  : line,
              ),
            }
          : entry,
      ),
    };
    const unbalancedResult = reviewFranceFec(unbalanced);
    expect(codes(unbalancedResult)).toContain('france-fec-entry-unbalanced');

    const malformedForeign = {
      ...baseInput,
      entries: baseInput.entries.map((entry) =>
        entry.entryId === 'entry-sale'
          ? {
              ...entry,
              lines: entry.lines.map((line) =>
                line.lineId === 'sale-bank'
                  ? { ...line, foreign: { amount: '130.75' } }
                  : line,
              ),
            }
          : entry,
      ),
    };
    const foreignResult = reviewFranceFec(malformedForeign);
    expect(codes(foreignResult)).toContain(
      'france-fec-foreign-currency-invalid',
    );
  });

  it('blocks missing legal identity, invalid accounts, and excluded closing entries', () => {
    const input = {
      ...baseInput,
      entity: { siren: 'workspace-id', sirenSource: null },
      entries: baseInput.entries.map((entry) =>
        entry.entryId === 'entry-sale'
          ? {
              ...entry,
              kind: 'closing',
              lines: entry.lines.map((line) =>
                line.lineId === 'sale-bank'
                  ? { ...line, accountNumber: 'BANK-512' }
                  : line,
              ),
            }
          : entry,
      ),
    };
    const result = buildFranceFecExport(input);
    expect(result.status).toBe('blocked');
    expect(result.file).toBeNull();
    expect(codes(result.review)).toEqual(
      expect.arrayContaining([
        'france-fec-siren-invalid',
        'france-fec-siren-source-missing',
        'france-fec-entry-kind-excluded',
        'france-fec-account-number-invalid',
      ]),
    );
  });

  it('collects structured errors for non-object input without throwing', () => {
    const result = reviewFranceFec(null);
    expect(result.status).toBe('blocked');
    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'france-fec-input-invalid', path: '$' }),
    ]);
    expect(result.sourceLineage).toEqual([]);
  });
});

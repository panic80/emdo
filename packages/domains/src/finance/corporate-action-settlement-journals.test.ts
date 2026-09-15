import { describe, expect, it } from 'vitest';
import { planStockSplitSettlementJournals as journals } from './corporate-action-settlement-journals.js';
import { planInvestmentStockSplitSettlement } from './corporate-action-settlement.js';
import { parseFinanceDecimal } from './decimal.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const q = (numerator: string, denominator = '1') => ({
  numerator,
  denominator,
});
function fixture(
  options: {
    crossCurrency?: boolean;
    differentDates?: boolean;
    basis?: string;
    receipt?: string;
  } = {},
) {
  const nativeCurrency = options.crossCurrency ? 'USD' : 'CAD';
  const basis = options.basis ?? '10';
  const nativeReceipt = options.receipt ?? '12';
  const settlement = planInvestmentStockSplitSettlement({
    source: {
      action: {
        id: id(1),
        actionType: 'reverse-split',
        financialAccountId: id(2),
        instrumentId: id(3),
        effectiveOn: '2026-01-01',
        numerator: '1',
        denominator: '2',
        evidenceId: id(4),
        sourceReference: 'issuer',
        fractionalTreatment: 'cash-in-lieu',
      },
      sourceAsOf: '2026-01-01',
      sourceBoundary: 'immediately-before-action',
      sourceLots: [
        {
          id: id(5),
          financialAccountId: id(2),
          instrumentId: id(3),
          acquiredOn: '2025-01-01',
          acquisitionSequence: 0,
          originalQuantity: '1',
          disposedQuantity: '0',
          originalNativeCost: basis,
          allocatedNativeCost: '0',
          originalFunctionalCost: basis,
          allocatedFunctionalCost: '0',
          nativeCurrency,
          functionalCurrency: 'CAD',
          sourceReference: 'trade',
        },
      ],
    },
    deliveredQuantity: q('0'),
    cashDisposedQuantity: q('1', '2'),
    allocations: [
      {
        sourceLotId: id(5),
        retainedQuantity: q('0'),
        cashDisposedQuantity: q('1', '2'),
        retainedNativeCost: '0',
        retainedFunctionalCost: '0',
        disposedNativeCost: basis,
        disposedFunctionalCost: basis,
      },
    ],
    cashConsideration: {
      native: { currency: nativeCurrency, amount: nativeReceipt },
      functional: {
        currency: 'CAD',
        amount: options.crossCurrency ? '15' : nativeReceipt,
      },
      evidenceId: id(6),
      sourceReference: 'receipt',
      settledOn: options.differentDates ? '2026-01-03' : '2026-01-01',
      fx: options.crossCurrency
        ? { rate: '1.25', source: 'receipt-date broker rate' }
        : null,
    },
    allocationReview: { evidenceId: id(7), sourceReference: 'allocation' },
  });
  return {
    settlement,
    ledger: {
      cashLedgerAccountId: id(20),
      investmentLedgerAccountId: id(21),
      gainLedgerAccountId: id(22),
      lossLedgerAccountId: id(23),
      receivableLedgerAccountId: id(24),
      fxGainLedgerAccountId: id(25),
      fxLossLedgerAccountId: id(26),
    },
    actionDateConsideration: null as null | {
      native: { currency: 'USD' | 'CAD'; amount: string };
      functional: { currency: 'CAD'; amount: string };
      fx: { rate: string; source: string } | null;
      evidenceId: string;
      sourceReference: string;
    },
  };
}
const entries = (journal: ReturnType<typeof journals>['journals'][number]) =>
  journal.journal.lines.map((line) => [line.accountId, line.side, line.amount]);

describe('cash in lieu balanced journal planning', () => {
  it('plans one same-date cash, book-cost and gain journal', () => {
    const result = journals(fixture());
    expect(result.journals).toHaveLength(1);
    expect(result.journals[0]!.journal.effectiveOn).toBe('2026-01-01');
    expect(entries(result.journals[0]!)).toEqual([
      [id(20), 'debit', '12'],
      [id(21), 'credit', '10'],
      [id(22), 'credit', '2'],
    ]);
    expect(result).toMatchObject({
      persistence: 'not-implemented',
      bookGainLoss: '2',
      fxGainLoss: '0',
    });
  });

  it('uses a debit for a book loss and omits zero-basis lines', () => {
    expect(entries(journals(fixture({ receipt: '8' })).journals[0]!)).toEqual([
      [id(20), 'debit', '8'],
      [id(21), 'credit', '10'],
      [id(23), 'debit', '2'],
    ]);
    expect(entries(journals(fixture({ basis: '0' })).journals[0]!)).toEqual([
      [id(20), 'debit', '12'],
      [id(22), 'credit', '12'],
    ]);
  });

  it('keeps native cash FX evidence while recording book cost at its functional carrying amount', () => {
    const result = journals(fixture({ crossCurrency: true }));
    expect(entries(result.journals[0]!)).toEqual([
      [id(20), 'debit', '15'],
      [id(21), 'credit', '10'],
      [id(22), 'credit', '5'],
    ]);
    expect(result.journals[0]!.journal.lines[0]).toMatchObject({
      currency: 'USD',
      nativeAmount: '12',
      fxRate: '1.25',
      fxSource: 'receipt-date broker rate',
    });
    expect(result.journals[0]!.journal.lines[1]).toMatchObject({
      currency: 'CAD',
      nativeAmount: '10',
      fxRate: '1',
    });
  });

  it('uses separate evidenced action and settlement valuations with a settlement FX gain', () => {
    const data = fixture({ crossCurrency: true, differentDates: true });
    data.actionDateConsideration = {
      native: { currency: 'USD', amount: '12' },
      functional: { currency: 'CAD', amount: '14.4' },
      fx: { rate: '1.2', source: 'action-date broker rate' },
      evidenceId: id(8),
      sourceReference: 'action-date valuation',
    };
    const result = journals(data);
    expect(result.journals.map((j) => [j.kind, j.journal.effectiveOn])).toEqual(
      [
        ['recognition', '2026-01-01'],
        ['settlement', '2026-01-03'],
      ],
    );
    expect(entries(result.journals[0]!)).toEqual([
      [id(24), 'debit', '14.4'],
      [id(21), 'credit', '10'],
      [id(22), 'credit', '4.4'],
    ]);
    expect(entries(result.journals[1]!)).toEqual([
      [id(20), 'debit', '15'],
      [id(24), 'credit', '14.4'],
      [id(25), 'credit', '0.6'],
    ]);
    expect(result).toMatchObject({ bookGainLoss: '4.4', fxGainLoss: '0.6' });
    const receivableLines = result.journals
      .flatMap((j) => j.journal.lines)
      .filter((line) => line.accountId === id(24));
    expect(
      receivableLines.map((line) => [
        line.currency,
        line.nativeAmount,
        line.fxRate,
      ]),
    ).toEqual([
      ['USD', '12', '1.2'],
      ['USD', '12', '1.2'],
    ]);
    expect(
      receivableLines.reduce(
        (sum, line) =>
          sum +
          (line.side === 'debit' ? 1n : -1n) *
            parseFinanceDecimal(line.nativeAmount),
        0n,
      ),
    ).toBe(0n);
    expect(
      receivableLines.reduce(
        (sum, line) =>
          sum +
          (line.side === 'debit' ? 1n : -1n) * parseFinanceDecimal(line.amount),
        0n,
      ),
    ).toBe(0n);
  });

  it('plans a separate settlement FX loss', () => {
    const data = fixture({ crossCurrency: true, differentDates: true });
    data.actionDateConsideration = {
      native: { currency: 'USD', amount: '12' },
      functional: { currency: 'CAD', amount: '15.6' },
      fx: { rate: '1.3', source: 'action-date broker rate' },
      evidenceId: id(8),
      sourceReference: 'action-date valuation',
    };
    expect(entries(journals(data).journals[1]!)).toEqual([
      [id(20), 'debit', '15'],
      [id(24), 'credit', '15.6'],
      [id(26), 'debit', '0.6'],
    ]);
  });

  it('requires action-date value and FX evidence instead of reusing receipt-day FX', () => {
    const data = fixture({ crossCurrency: true, differentDates: true });
    expect(() => journals(data)).toThrow('action-date-consideration-required');
    data.actionDateConsideration = {
      native: { currency: 'USD', amount: '12' },
      functional: { currency: 'CAD', amount: '14.4' },
      fx: null,
      evidenceId: id(8),
      sourceReference: 'action-date valuation',
    };
    expect(() => journals(data)).toThrow('fx-evidence-required');
    data.actionDateConsideration.fx = {
      rate: '1.25',
      source: 'incorrect action valuation',
    };
    expect(() => journals(data)).toThrow('fx-amount-mismatch');
  });

  it('supports different-date identity-currency receivable clearing without an FX line', () => {
    const data = fixture({ differentDates: true });
    data.actionDateConsideration = {
      native: { currency: 'CAD', amount: '12' },
      functional: { currency: 'CAD', amount: '12' },
      fx: null,
      evidenceId: id(8),
      sourceReference: 'action-date valuation',
    };
    expect(entries(journals(data).journals[1]!)).toEqual([
      [id(20), 'debit', '12'],
      [id(24), 'credit', '12'],
    ]);
  });

  it('rejects overlapping ledger mappings and missing receivable mappings', () => {
    const data = fixture();
    data.ledger.investmentLedgerAccountId = data.ledger.cashLedgerAccountId;
    expect(() => journals(data)).toThrow('ledger-mappings-must-be-distinct');
    const deferred = fixture({ differentDates: true });
    expect(() =>
      journals({
        ...deferred,
        ledger: { ...deferred.ledger, receivableLedgerAccountId: null },
        actionDateConsideration: {
          native: { currency: 'CAD', amount: '12' },
          functional: { currency: 'CAD', amount: '12' },
          fx: null,
          evidenceId: id(8),
          sourceReference: 'action-date valuation',
        },
      }),
    ).toThrow('settlement-ledger-mapping-required');
  });

  it('allows shared gain/FX gain and loss/FX loss accounts but rejects cross-kind aliases', () => {
    const data = fixture({ crossCurrency: true, differentDates: true });
    data.actionDateConsideration = {
      native: { currency: 'USD', amount: '12' },
      functional: { currency: 'CAD', amount: '14.4' },
      fx: { rate: '1.2', source: 'action rate' },
      evidenceId: id(8),
      sourceReference: 'action valuation',
    };
    data.ledger.fxGainLedgerAccountId = data.ledger.gainLedgerAccountId;
    data.ledger.fxLossLedgerAccountId = data.ledger.lossLedgerAccountId;
    expect(entries(journals(data).journals[1]!)).toContainEqual([
      id(22),
      'credit',
      '0.6',
    ]);
    data.ledger.fxLossLedgerAccountId = data.ledger.gainLedgerAccountId;
    expect(() => journals(data)).toThrow('ledger-mappings-must-be-distinct');
  });
});

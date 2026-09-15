import { describe, expect, it } from 'vitest';
import { planInvestmentCashDividend } from './cash-dividends.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const source = {
  sourceRowId: id(1),
  batchId: id(2),
  sourceRow: 8,
  evidenceId: id(3),
  financialAccountId: id(4),
  instrumentId: id(5),
  sourceRevision: 3,
  sourceSnapshotHash: 'a'.repeat(64),
  status: 'ready' as const,
  effectiveOn: '2026-08-15',
  description: 'ACME dividend received',
  nativeAmount: '85',
  currency: 'CAD' as const,
  fxRate: '1',
  fxSource: 'identity',
  issues: [],
  financialAccountLedgerId: id(6),
  functionalCurrency: 'CAD' as const,
};

const provenance = (field: 'gross' | 'withholding' | 'net') => ({
  sourceRow: source.sourceRow,
  field,
  column: field,
  raw:
    field === 'gross' ? '100.00' : field === 'withholding' ? '15.00' : '85.00',
  contextAnchor: 'Dividend details',
});

const amount = (
  field: 'gross' | 'withholding' | 'net',
  nativeAmount: string,
  functionalAmount = nativeAmount,
) => ({
  nativeAmount,
  currency: 'CAD' as const,
  functionalAmount,
  fxRate: '1',
  fxSource: 'identity',
  provenance: provenance(field),
});

const action = {
  id: id(10),
  actionType: 'cash-dividend' as const,
  financialAccountId: source.financialAccountId,
  instrumentId: source.instrumentId,
  evidenceId: source.evidenceId,
  sourceRowId: source.sourceRowId,
  declaredOn: '2026-07-20',
  exDate: '2026-07-21',
  payableOn: source.effectiveOn,
  sourceReference: 'broker:statement:2026-08-15:ACME',
  reviewReason: 'Matched the issuer notice to the statement receipt.',
  gross: amount('gross', '100'),
  withholding: amount('withholding', '15'),
  net: amount('net', '85'),
  ledger: {
    cashLedgerAccountId: source.financialAccountLedgerId,
    dividendIncomeLedgerAccountId: id(7),
    withholdingLedgerAccountId: id(8),
  },
};

describe('deterministic cash dividend planning', () => {
  it('reconciles gross, withholding, net and creates explicit journal lines', () => {
    const result = planInvestmentCashDividend({ action, source });

    expect(result).toMatchObject({
      calculationVersion: 'investment-cash-dividends.v1',
      commitReadiness: 'ready',
      blockedReasons: [],
      grossFunctionalAmount: '100',
      withholdingFunctionalAmount: '15',
      netFunctionalAmount: '85',
      journalLines: [
        {
          kind: 'net',
          accountId: source.financialAccountLedgerId,
          side: 'debit',
          amount: '85',
          nativeAmount: '85',
          currency: 'CAD',
          fxRate: '1',
          fxSource: 'identity',
        },
        {
          kind: 'withholding',
          accountId: id(8),
          side: 'debit',
          amount: '15',
        },
        {
          kind: 'gross',
          accountId: id(7),
          side: 'credit',
          amount: '100',
        },
      ],
    });
  });

  it('keeps a zero withholding fact explicit while omitting a zero journal line', () => {
    const result = planInvestmentCashDividend({
      action: {
        ...action,
        gross: amount('gross', '85'),
        withholding: amount('withholding', '0'),
        net: amount('net', '85'),
      },
      source,
    });

    expect(result.commitReadiness).toBe('ready');
    expect(result.withholdingFunctionalAmount).toBe('0');
    expect(result.journalLines).toHaveLength(2);
    expect(result.journalLines.map((line) => line.kind)).toEqual([
      'net',
      'gross',
    ]);
  });

  it('blocks missing amounts instead of deriving them from the receipt', () => {
    const result = planInvestmentCashDividend({
      action: { ...action, gross: null, withholding: null, net: null },
      source,
    });

    expect(result).toMatchObject({
      commitReadiness: 'blocked',
      blockedReasons: [
        'gross-required',
        'withholding-required',
        'net-required',
      ],
      journalLines: [],
      grossFunctionalAmount: null,
      withholdingFunctionalAmount: null,
      netFunctionalAmount: null,
    });
  });

  it('requires an exact normalized net receipt and source FX proof', () => {
    const result = planInvestmentCashDividend({
      action: {
        ...action,
        net: { ...amount('net', '84'), functionalAmount: '84' },
      },
      source: {
        ...source,
        nativeAmount: '85',
        fxRate: '1.1',
        fxSource: 'provider:fx',
      },
    });

    expect(result.commitReadiness).toBe('blocked');
    expect(result.blockedReasons).toEqual(
      expect.arrayContaining([
        'source-row-amount-mismatch',
        'fx-mapping-invalid',
      ]),
    );
  });

  it('preserves explicit cross-currency conversions at exact currency precision', () => {
    const usdSource = {
      ...source,
      nativeAmount: '85',
      currency: 'USD' as const,
      functionalCurrency: 'CAD' as const,
      fxRate: '1.35',
      fxSource: 'provider:closing-rate',
    };
    const usdAmount = (
      field: 'gross' | 'withholding' | 'net',
      nativeAmount: string,
      functionalAmount: string,
    ) => ({
      nativeAmount,
      currency: 'USD' as const,
      functionalAmount,
      fxRate: '1.35',
      fxSource: 'provider:closing-rate',
      provenance: provenance(field),
    });
    const result = planInvestmentCashDividend({
      action: {
        ...action,
        gross: usdAmount('gross', '100', '135'),
        withholding: usdAmount('withholding', '15', '20.25'),
        net: usdAmount('net', '85', '114.75'),
      },
      source: usdSource,
    });

    expect(result.commitReadiness).toBe('ready');
    expect(result.grossFunctionalAmount).toBe('135');
    expect(result.withholdingFunctionalAmount).toBe('20.25');
    expect(result.netFunctionalAmount).toBe('114.75');
    expect(result.journalLines[0]).toMatchObject({
      nativeAmount: '85',
      currency: 'USD',
      amount: '114.75',
    });
  });

  it('handles zero-decimal JPY values without binary rounding', () => {
    const jpySource = {
      ...source,
      nativeAmount: '8500',
      currency: 'JPY' as const,
      functionalCurrency: 'CAD' as const,
      fxRate: '0.0095',
      fxSource: 'provider:closing-rate',
    };
    const jpyAmount = (
      field: 'gross' | 'withholding' | 'net',
      nativeAmount: string,
      functionalAmount: string,
    ) => ({
      nativeAmount,
      currency: 'JPY' as const,
      functionalAmount,
      fxRate: '0.0095',
      fxSource: 'provider:closing-rate',
      provenance: provenance(field),
    });
    const result = planInvestmentCashDividend({
      action: {
        ...action,
        gross: jpyAmount('gross', '10000', '95'),
        withholding: jpyAmount('withholding', '1500', '14.25'),
        net: jpyAmount('net', '8500', '80.75'),
      },
      source: jpySource,
    });

    expect(result.commitReadiness).toBe('ready');
    expect(result.journalLines[1]).toMatchObject({
      nativeAmount: '1500',
      currency: 'JPY',
      amount: '14.25',
    });
  });

  it('blocks stale, non-inflow, date, provenance and account mismatches', () => {
    const result = planInvestmentCashDividend({
      action: {
        ...action,
        payableOn: '2026-08-16',
        ledger: {
          ...action.ledger,
          cashLedgerAccountId: id(99),
        },
        net: {
          ...action.net,
          provenance: { ...action.net.provenance, sourceRow: 9 },
        },
      },
      source: {
        ...source,
        status: 'committed',
        nativeAmount: '-85',
        effectiveOn: '2026-08-15',
      },
    });

    expect(result.commitReadiness).toBe('blocked');
    expect(result.blockedReasons).toEqual(
      expect.arrayContaining([
        'source-row-already-committed',
        'source-row-date-mismatch',
        'source-row-not-cash-inflow',
        'amount-provenance-mismatch',
        'cash-ledger-mapping-mismatch',
      ]),
    );
    expect(result.journalLines).toEqual([]);
  });

  it('blocks native and functional component imbalance independently', () => {
    const nativeMismatch = planInvestmentCashDividend({
      action: {
        ...action,
        gross: amount('gross', '101'),
      },
      source,
    });
    expect(nativeMismatch.blockedReasons).toContain(
      'native-reconciliation-mismatch',
    );

    const functionalMismatch = planInvestmentCashDividend({
      action: {
        ...action,
        gross: amount('gross', '100', '99'),
      },
      source,
    });
    expect(functionalMismatch.blockedReasons).toContain(
      'gross-functional-mismatch',
    );
  });
});

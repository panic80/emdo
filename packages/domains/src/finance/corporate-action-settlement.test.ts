import { describe, expect, it } from 'vitest';
import { planInvestmentStockSplitSettlement as plan } from './corporate-action-settlement.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const q = (numerator: string, denominator = '1') => ({
  numerator,
  denominator,
});
function fixture() {
  return {
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
          originalQuantity: '3',
          disposedQuantity: '0',
          originalNativeCost: '30',
          allocatedNativeCost: '0',
          originalFunctionalCost: '30',
          allocatedFunctionalCost: '0',
          nativeCurrency: 'CAD',
          functionalCurrency: 'CAD',
          sourceReference: 'trade',
        },
      ],
    },
    deliveredQuantity: q('1'),
    cashDisposedQuantity: q('1', '2'),
    allocations: [
      {
        sourceLotId: id(5),
        retainedQuantity: q('1'),
        cashDisposedQuantity: q('1', '2'),
        retainedNativeCost: '20',
        retainedFunctionalCost: '20',
        disposedNativeCost: '10',
        disposedFunctionalCost: '10',
      },
    ],
    cashConsideration: {
      native: { currency: 'CAD', amount: '12' },
      functional: { currency: 'CAD', amount: '12' },
      evidenceId: id(6),
      sourceReference: 'receipt',
      settledOn: '2026-01-03',
      fx: null as { rate: string; source: string } | null,
    },
    allocationReview: {
      evidenceId: id(7),
      sourceReference: 'broker allocation',
    },
  };
}

describe('reviewed cash-in-lieu settlement planning', () => {
  it('conserves exact quantities and book costs and keeps settlement date separate', () => {
    expect(plan(fixture())).toMatchObject({
      status: 'validated-plan',
      persistence: 'not-implemented',
      taxTreatment: 'not-assessed',
      effectiveOn: '2026-01-01',
      settledOn: '2026-01-03',
      accountEntitlement: q('3', '2'),
      retainedNativeCost: '20',
      disposedNativeCost: '10',
      nativeBookGainLoss: '2',
      functionalBookGainLoss: '2',
    });
  });

  it('retains exact thirds across source lots without independently flooring them', () => {
    const data = fixture();
    data.source.action.denominator = '3';
    data.source.sourceLots = [0, 1, 2, 3].map((i) => ({
      ...data.source.sourceLots[0]!,
      id: id(10 + i),
      acquisitionSequence: i,
      originalQuantity: '1',
      originalNativeCost: '3',
      originalFunctionalCost: '3',
    }));
    data.cashDisposedQuantity = q('1', '3');
    data.allocations = data.source.sourceLots.map((lot, i) => ({
      sourceLotId: lot.id,
      retainedQuantity: q(i === 3 ? '0' : '1', '3'),
      cashDisposedQuantity: q(i === 3 ? '1' : '0', '3'),
      retainedNativeCost: i === 3 ? '0' : '3',
      retainedFunctionalCost: i === 3 ? '0' : '3',
      disposedNativeCost: i === 3 ? '3' : '0',
      disposedFunctionalCost: i === 3 ? '3' : '0',
    }));
    const result = plan(data);
    expect(result).toMatchObject({
      accountEntitlement: q('4', '3'),
      deliveredQuantity: q('1'),
      cashDisposedQuantity: q('1', '3'),
      retainedNativeCost: '9',
      disposedNativeCost: '3',
    });
    expect(
      plan({ ...data, allocations: [...data.allocations].reverse() }),
    ).toEqual(result);
  });

  it('supports fully cashed out entitlement and realized book losses', () => {
    const data = fixture();
    data.source.sourceLots[0]!.originalQuantity = '1';
    data.deliveredQuantity = q('0');
    data.allocations[0]!.retainedQuantity = q('0');
    Object.assign(data.allocations[0]!, {
      retainedNativeCost: '0',
      retainedFunctionalCost: '0',
      disposedNativeCost: '30',
      disposedFunctionalCost: '30',
    });
    expect(plan(data)).toMatchObject({
      nativeBookGainLoss: '-18',
      retainedNativeCost: '0',
    });
  });

  it('uses remaining book costs after prior disposals and excludes closed lots', () => {
    const data = fixture();
    Object.assign(data.source.sourceLots[0]!, {
      originalQuantity: '6',
      disposedQuantity: '3',
      originalNativeCost: '60',
      allocatedNativeCost: '30',
      originalFunctionalCost: '60',
      allocatedFunctionalCost: '30',
    });
    data.source.sourceLots.push({
      ...data.source.sourceLots[0]!,
      id: id(8),
      acquisitionSequence: 1,
      disposedQuantity: '6',
      allocatedNativeCost: '60',
      allocatedFunctionalCost: '60',
    });
    expect(plan(data).sourceNativeCost).toBe('30');
    data.source.sourceLots[0]!.allocatedNativeCost = '29';
    expect(() => plan(data)).toThrow('source-cost-inconsistent');
  });

  it('requires explicit crosscurrency FX and reconciles the supplied functional amount', () => {
    const data = fixture();
    data.cashConsideration.native.currency = 'USD';
    data.source.sourceLots[0]!.nativeCurrency = 'USD';
    expect(() => plan(data)).toThrow('fx-evidence-required');
    data.cashConsideration.fx = { rate: '1.25', source: 'broker settlement' };
    expect(() => plan(data)).toThrow('fx-amount-mismatch');
    data.cashConsideration.functional.amount = '15';
    expect(plan(data)).toMatchObject({
      nativeBookGainLoss: '2',
      functionalBookGainLoss: '5',
    });
  });

  it.each([
    [
      'lot-quantity-mismatch',
      (d: ReturnType<typeof fixture>) => {
        d.allocations[0]!.retainedQuantity = q('2');
      },
    ],
    [
      'account-quantity-mismatch',
      (d: ReturnType<typeof fixture>) => {
        d.deliveredQuantity = q('2');
      },
    ],
    [
      'lot-cost-mismatch',
      (d: ReturnType<typeof fixture>) => {
        d.allocations[0]!.disposedNativeCost = '9';
      },
    ],
    [
      'allocation-duplicate',
      (d: ReturnType<typeof fixture>) => {
        d.allocations.push(d.allocations[0]!);
      },
    ],
    [
      'allocation-missing',
      (d: ReturnType<typeof fixture>) => {
        d.allocations[0]!.sourceLotId = id(9);
      },
    ],
    [
      'settlement-before-action',
      (d: ReturnType<typeof fixture>) => {
        d.cashConsideration.settledOn = '2025-12-31';
      },
    ],
    [
      'cash-in-lieu-policy-required',
      (d: ReturnType<typeof fixture>) => {
        d.source.action.fractionalTreatment = 'retain';
      },
    ],
    [
      'identity-currency-mismatch',
      (d: ReturnType<typeof fixture>) => {
        d.cashConsideration.functional.amount = '13';
      },
    ],
    [
      'cash-quantity-required',
      (d: ReturnType<typeof fixture>) => {
        d.cashDisposedQuantity = q('0');
      },
    ],
  ] as const)('rejects %s', (error, mutate) => {
    const data = fixture();
    mutate(data);
    expect(() => plan(data)).toThrow(error);
  });

  it('rejects negative quantities, excessive precision, absent evidence and denominator bounds', () => {
    const data = fixture();
    data.allocations[0]!.cashDisposedQuantity = q('-1', '2');
    expect(() => plan(data)).toThrow();
    data.allocations[0]!.cashDisposedQuantity = q('1', '2');
    data.allocations[0]!.disposedNativeCost = '10.001';
    expect(() => plan(data)).toThrow();
    data.allocations[0]!.disposedNativeCost = '10';
    data.cashConsideration.sourceReference = '';
    expect(() => plan(data)).toThrow();
    expect(() =>
      plan({ ...fixture(), cashDisposedQuantity: q('1', '1'.repeat(121)) }),
    ).toThrow();
  });

  it('checks already supplied cash consideration against settlement evidence', () => {
    const data = fixture();
    const source = {
      ...data.source,
      action: {
        ...data.source.action,
        cashInLieu: {
          consideration: data.cashConsideration.native,
          evidenceId: data.cashConsideration.evidenceId,
          sourceReference: data.cashConsideration.sourceReference,
        },
      },
    };
    expect(plan({ ...data, source }).nativeBookGainLoss).toBe('2');
    source.action.cashInLieu.evidenceId = id(9);
    expect(() => plan({ ...data, source })).toThrow(
      'source-consideration-mismatch',
    );
  });

  it('rejects same-currency cost mismatches even when both cost totals conserve', () => {
    const data = fixture();
    data.allocations[0]!.retainedFunctionalCost = '19';
    data.allocations[0]!.disposedFunctionalCost = '11';
    expect(() => plan(data)).toThrow('identity-currency-mismatch');
  });

  it('rejects a reviewed allocation for a fully closed source lot', () => {
    const data = fixture();
    const closed = {
      ...data.source.sourceLots[0]!,
      id: id(8),
      acquisitionSequence: 1,
      disposedQuantity: '3',
      allocatedNativeCost: '30',
      allocatedFunctionalCost: '30',
    };
    data.source.sourceLots.push(closed);
    data.allocations.push({ ...data.allocations[0]!, sourceLotId: closed.id });
    expect(() => plan(data)).toThrow('allocation-for-closed-lot');
  });

  it('rejects bounded rational inputs whose aggregate exceeds the rational output bound', () => {
    const data = fixture();
    data.deliveredQuantity = q('9'.repeat(120));
    data.cashDisposedQuantity = q('9'.repeat(120));
    expect(() => plan(data)).toThrow('quantity-overflow');
  });
});

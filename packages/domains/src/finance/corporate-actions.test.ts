import { describe, expect, it } from 'vitest';
import { planInvestmentStockSplit } from './corporate-actions.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const lot = {
  id: id(3),
  financialAccountId: id(1),
  instrumentId: id(2),
  acquiredOn: '2025-01-01',
  acquisitionSequence: 0,
  originalQuantity: '100',
  disposedQuantity: '20',
  originalNativeCost: '1000',
  allocatedNativeCost: '200',
  originalFunctionalCost: '1000',
  allocatedFunctionalCost: '200',
  nativeCurrency: 'CAD' as const,
  functionalCurrency: 'CAD' as const,
  sourceReference: 'trade:purchase-1',
};

const action = {
  id: id(10),
  actionType: 'split' as const,
  financialAccountId: id(1),
  instrumentId: id(2),
  effectiveOn: '2026-01-15',
  numerator: '3',
  denominator: '1',
  evidenceId: id(11),
  sourceReference: 'issuer:split-2026',
  cashInLieu: null,
};

describe('deterministic stock split planning', () => {
  it('always routes cash-in-lieu through the separate settlement workflow', () => {
    const result = planInvestmentStockSplit({
      action: { ...action, fractionalTreatment: 'cash-in-lieu' },
      sourceAsOf: action.effectiveOn,
      sourceBoundary: 'immediately-before-action',
      sourceLots: [lot],
    });
    expect(result.commitReadiness).toBe('blocked');
    expect(result.blockedReasons).toContain(
      'cash-in-lieu-basis-treatment-unsupported',
    );
  });
  it('exposes the exact account total without treating lot fractions as cash', () => {
    const result = planInvestmentStockSplit({
      action: {
        ...action,
        actionType: 'reverse-split',
        numerator: '1',
        denominator: '3',
      },
      sourceAsOf: action.effectiveOn,
      sourceBoundary: 'immediately-before-action',
      sourceLots: [0, 1, 2].map((sequence) => ({
        ...lot,
        id: id(30 + sequence),
        acquisitionSequence: sequence,
        originalQuantity: '1',
        disposedQuantity: '0',
        allocatedNativeCost: '0',
        allocatedFunctionalCost: '0',
      })),
    });
    expect(result.accountEntitlement).toEqual({
      numerator: '1',
      denominator: '1',
      wholeShares: '1',
      remainderNumerator: '0',
      remainderDenominator: '1',
      decimalQuantity: '1',
    });
    expect(result.commitReadiness).toBe('blocked');
    expect(result.action.cashInLieu).toBeNull();
  });
  it('plans a forward split with unchanged remaining cost basis', () => {
    const result = planInvestmentStockSplit({
      action,
      sourceAsOf: action.effectiveOn,
      sourceBoundary: 'immediately-before-action',
      sourceLots: [lot],
    });

    expect(result).toMatchObject({
      calculationVersion: 'investment-corporate-actions.v1',
      commitReadiness: 'ready',
      blockedReasons: [],
      persistence: 'not-implemented',
      sourceRemainingNativeCost: '800',
      sourceRemainingFunctionalCost: '800',
      successorNativeCostBasis: '800',
      successorFunctionalCostBasis: '800',
      successorLotCount: 1,
      effects: [
        {
          actionId: action.id,
          evidenceId: action.evidenceId,
          sourceLotId: lot.id,
          sourceRemainingQuantity: '80',
          successorQuantity: '240',
          sourceNativeCostBasis: '800',
          successorNativeCostBasis: '800',
          fractionalEntitlement: null,
          successorLot: {
            successorLotKey: `${action.id}:${lot.id}`,
            sourceLotId: lot.id,
            originalQuantity: '240',
            disposedQuantity: '0',
            originalNativeCost: '800',
            allocatedNativeCost: '0',
            originalFunctionalCost: '800',
            allocatedFunctionalCost: '0',
          },
        },
      ],
    });
  });

  it('plans a reverse split and preserves basis after a partial disposal', () => {
    const source = {
      ...lot,
      originalQuantity: '3',
      disposedQuantity: '1',
      originalNativeCost: '1',
      allocatedNativeCost: '0.33',
      originalFunctionalCost: '1',
      allocatedFunctionalCost: '0.33',
    };
    const result = planInvestmentStockSplit({
      action: {
        ...action,
        id: id(20),
        actionType: 'reverse-split',
        numerator: '1',
        denominator: '2',
      },
      sourceAsOf: action.effectiveOn,
      sourceBoundary: 'immediately-before-action',
      sourceLots: [source],
    });

    expect(result).toMatchObject({
      commitReadiness: 'ready',
      sourceRemainingNativeCost: '0.67',
      successorNativeCostBasis: '0.67',
      effects: [
        {
          sourceRemainingQuantity: '2',
          successorQuantity: '1',
          successorLot: {
            originalQuantity: '1',
            originalNativeCost: '0.67',
            originalFunctionalCost: '0.67',
          },
        },
      ],
    });
  });

  it('keeps fully disposed lots in the proposal without creating zero-quantity lots', () => {
    const result = planInvestmentStockSplit({
      action,
      sourceAsOf: action.effectiveOn,
      sourceBoundary: 'immediately-before-action',
      sourceLots: [
        {
          ...lot,
          disposedQuantity: '100',
          allocatedNativeCost: '1000',
          allocatedFunctionalCost: '1000',
        },
      ],
    });
    expect(result).toMatchObject({
      commitReadiness: 'ready',
      successorLotCount: 0,
      effects: [
        {
          sourceRemainingQuantity: '0',
          successorQuantity: null,
          successorLot: null,
          fractionalEntitlement: null,
          sourceNativeCostBasis: '0',
        },
      ],
    });
  });

  it('exposes a non-representable fractional entitlement and blocks readiness', () => {
    const result = planInvestmentStockSplit({
      action: {
        ...action,
        actionType: 'reverse-split',
        numerator: '1',
        denominator: '3',
      },
      sourceAsOf: action.effectiveOn,
      sourceBoundary: 'immediately-before-action',
      sourceLots: [
        {
          ...lot,
          originalQuantity: '1',
          disposedQuantity: '0',
          originalNativeCost: '10',
          allocatedNativeCost: '0',
          originalFunctionalCost: '10',
          allocatedFunctionalCost: '0',
        },
      ],
    });

    expect(result).toMatchObject({
      commitReadiness: 'blocked',
      blockedReasons: [
        'fractional-entitlement-review-required',
        'fractional-quantity-not-representable',
        'fractional-policy-required',
      ],
      successorLotCount: 0,
      effects: [
        {
          successorQuantity: null,
          successorLot: null,
          fractionalEntitlement: {
            wholeQuantity: '0.333333333333',
            wholeShareQuantity: '0',
            remainderNumerator: '1',
            remainderDenominator: '3',
            fractionalUnit: 'share',
            representable: false,
            scale: '1000000000000',
          },
        },
      ],
    });
  });

  it('surfaces provided cash-in-lieu without inventing basis treatment', () => {
    const result = planInvestmentStockSplit({
      action: {
        ...action,
        actionType: 'reverse-split',
        numerator: '1',
        denominator: '3',
        cashInLieu: {
          consideration: { amount: '2.50', currency: 'CAD' },
          evidenceId: id(12),
          sourceReference: 'broker:cash-in-lieu',
        },
      },
      sourceAsOf: action.effectiveOn,
      sourceBoundary: 'immediately-before-action',
      sourceLots: [
        {
          ...lot,
          originalQuantity: '1',
          disposedQuantity: '0',
          originalNativeCost: '10',
          allocatedNativeCost: '0',
          originalFunctionalCost: '10',
          allocatedFunctionalCost: '0',
        },
      ],
    });
    expect(result).toMatchObject({
      commitReadiness: 'blocked',
      blockedReasons: [
        'fractional-entitlement-review-required',
        'fractional-quantity-not-representable',
        'cash-in-lieu-basis-treatment-unsupported',
      ],
    });
  });

  it('requires an explicit fractional-share policy and permits exact retained halves only when declared', () => {
    const base = {
      action: {
        ...action,
        actionType: 'reverse-split' as const,
        numerator: '1',
        denominator: '2',
      },
      sourceAsOf: action.effectiveOn,
      sourceBoundary: 'immediately-before-action',
      sourceLots: [
        {
          ...lot,
          originalQuantity: '1',
          disposedQuantity: '0',
          originalNativeCost: '10',
          allocatedNativeCost: '0',
          originalFunctionalCost: '10',
          allocatedFunctionalCost: '0',
        },
      ],
    };
    const blocked = planInvestmentStockSplit(base);
    expect(blocked).toMatchObject({
      commitReadiness: 'blocked',
      blockedReasons: [
        'fractional-entitlement-review-required',
        'fractional-policy-required',
      ],
      effects: [
        {
          successorQuantity: null,
          fractionalEntitlement: {
            wholeQuantity: '0.5',
            wholeShareQuantity: '0',
            remainderNumerator: '1',
            remainderDenominator: '2',
            fractionalUnit: 'share',
            representable: true,
          },
        },
      ],
    });
    const retained = planInvestmentStockSplit({
      ...base,
      action: { ...base.action, fractionalTreatment: 'retain' as const },
    });
    expect(retained).toMatchObject({
      commitReadiness: 'ready',
      blockedReasons: [],
      effects: [
        {
          successorQuantity: '0.5',
          successorLot: {
            originalQuantity: '0.5',
            originalNativeCost: '10',
          },
        },
      ],
    });
    const oneAndHalf = planInvestmentStockSplit({
      ...base,
      action: {
        ...base.action,
        actionType: 'split' as const,
        numerator: '3',
        denominator: '2',
        fractionalTreatment: 'retain' as const,
      },
    });
    expect(oneAndHalf.effects[0]?.fractionalEntitlement).toMatchObject({
      wholeQuantity: '1.5',
      wholeShareQuantity: '1',
      remainderNumerator: '1',
      remainderDenominator: '2',
      fractionalUnit: 'share',
      representable: true,
    });
  });

  it('is deterministic and does not mutate or depend on source order', () => {
    const older = { ...lot, id: id(4), acquisitionSequence: 1 };
    const before = structuredClone([lot, older]);
    const first = planInvestmentStockSplit({
      action,
      sourceAsOf: action.effectiveOn,
      sourceBoundary: 'immediately-before-action',
      sourceLots: [older, lot],
    });
    const second = planInvestmentStockSplit({
      action,
      sourceAsOf: action.effectiveOn,
      sourceBoundary: 'immediately-before-action',
      sourceLots: [lot, older],
    });
    expect(second).toEqual(first);
    expect([lot, older]).toEqual(before);
  });

  it('rejects duplicate identities, mixed scope, ambiguous order and future lots', () => {
    expect(() =>
      planInvestmentStockSplit({
        action,
        sourceAsOf: action.effectiveOn,
        sourceBoundary: 'immediately-before-action',
        sourceLots: [lot, lot],
      }),
    ).toThrow('lot-duplicate');
    expect(() =>
      planInvestmentStockSplit({
        action,
        sourceAsOf: action.effectiveOn,
        sourceBoundary: 'immediately-before-action',
        sourceLots: [{ ...lot, instrumentId: id(99) }],
      }),
    ).toThrow('scope-mismatch');
    expect(() =>
      planInvestmentStockSplit({
        action,
        sourceAsOf: action.effectiveOn,
        sourceBoundary: 'immediately-before-action',
        sourceLots: [{ ...lot, acquiredOn: '2026-02-01' }],
      }),
    ).toThrow('after-effective-date');
    expect(() =>
      planInvestmentStockSplit({
        action,
        sourceAsOf: action.effectiveOn,
        sourceBoundary: 'immediately-before-action',
        sourceLots: [lot, { ...lot, id: id(4) }],
      }),
    ).toThrow('acquisition-order-ambiguous');
  });

  it('requires the source state boundary to match the effective date', () => {
    expect(() =>
      planInvestmentStockSplit({
        action,
        sourceAsOf: '2026-01-16',
        sourceBoundary: 'immediately-before-action',
        sourceLots: [lot],
      }),
    ).toThrow('source-snapshot-date-mismatch');
  });

  it('rejects reversed ratio direction, inconsistent disposed basis and identity currency mismatch', () => {
    expect(() =>
      planInvestmentStockSplit({
        action: { ...action, numerator: '1', denominator: '3' },
        sourceAsOf: action.effectiveOn,
        sourceBoundary: 'immediately-before-action',
        sourceLots: [lot],
      }),
    ).toThrow('ratio-direction-invalid');
    expect(() =>
      planInvestmentStockSplit({
        action,
        sourceAsOf: action.effectiveOn,
        sourceBoundary: 'immediately-before-action',
        sourceLots: [{ ...lot, allocatedNativeCost: '199.99' }],
      }),
    ).toThrow('state-inconsistent');
    expect(() =>
      planInvestmentStockSplit({
        action,
        sourceAsOf: action.effectiveOn,
        sourceBoundary: 'immediately-before-action',
        sourceLots: [
          {
            ...lot,
            nativeCurrency: 'USD',
            functionalCurrency: 'USD',
            originalNativeCost: '1000',
            allocatedNativeCost: '200',
            originalFunctionalCost: '999',
            allocatedFunctionalCost: '199.8',
          },
        ],
      }),
    ).toThrow('identity-currency-mismatch');
  });

  it('keeps exact zero-decimal currency costs and bounded decimal quantities', () => {
    const quantity = '9999999999999999999999999';
    const result = planInvestmentStockSplit({
      action: { ...action, numerator: '2', denominator: '1' },
      sourceAsOf: action.effectiveOn,
      sourceBoundary: 'immediately-before-action',
      sourceLots: [
        {
          ...lot,
          nativeCurrency: 'JPY',
          functionalCurrency: 'JPY',
          originalQuantity: quantity,
          disposedQuantity: '0',
          originalNativeCost: '100000000000000000000000',
          allocatedNativeCost: '0',
          originalFunctionalCost: '100000000000000000000000',
          allocatedFunctionalCost: '0',
        },
      ],
    });
    expect(result.effects[0]?.successorQuantity).toBe(
      '19999999999999999999999998',
    );
    expect(result.effects[0]?.successorNativeCostBasis).toBe(
      '100000000000000000000000',
    );
  });
});

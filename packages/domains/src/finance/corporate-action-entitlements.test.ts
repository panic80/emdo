import { describe, expect, it } from 'vitest';
import { calculateStockSplitAccountEntitlement as calculate } from './corporate-action-entitlements.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lot = (n: number, quantity = '1', disposed = '0') => ({
  id: id(n + 10),
  financialAccountId: id(1),
  instrumentId: id(2),
  acquiredOn: '2025-01-01',
  acquisitionSequence: n,
  originalQuantity: quantity,
  disposedQuantity: disposed,
  originalNativeCost: '0',
  allocatedNativeCost: '0',
  originalFunctionalCost: '0',
  allocatedFunctionalCost: '0',
  nativeCurrency: 'CAD',
  functionalCurrency: 'CAD',
  sourceReference: `lot:${n}`,
});
const input = (lots = [lot(1)], denominator = '2') => ({
  action: {
    id: id(3),
    actionType: 'reverse-split',
    financialAccountId: id(1),
    instrumentId: id(2),
    effectiveOn: '2026-01-01',
    numerator: '1',
    denominator,
    evidenceId: id(4),
    sourceReference: 'issuer:split',
  },
  sourceAsOf: '2026-01-01',
  sourceBoundary: 'immediately-before-action',
  sourceLots: lots,
});

describe('exact account stock split entitlement', () => {
  it.each([2, 3])(
    'aggregates %i lots before determining the fractional settlement',
    (count) => {
      const data = input(
        Array.from({ length: count }, (_, i) => lot(i)),
        String(count),
      );
      expect(calculate(data)).toEqual({
        numerator: '1',
        denominator: '1',
        wholeShares: '1',
        remainderNumerator: '0',
        remainderDenominator: '1',
        decimalQuantity: '1',
      });
      expect(
        calculate({ ...data, sourceLots: [...data.sourceLots].reverse() }),
      ).toEqual(calculate(data));
    },
  );

  it('preserves a genuine account fraction exactly', () => {
    expect(calculate(input([lot(1, '5')], '3'))).toEqual({
      numerator: '5',
      denominator: '3',
      wholeShares: '1',
      remainderNumerator: '2',
      remainderDenominator: '3',
      decimalQuantity: null,
    });
    expect(calculate(input([lot(1, '3')]))).toMatchObject({
      numerator: '3',
      denominator: '2',
      wholeShares: '1',
      remainderNumerator: '1',
      remainderDenominator: '2',
      decimalQuantity: '1.5',
    });
  });

  it('uses only remaining quantities, including completely disposed lots', () => {
    expect(
      calculate(input([lot(1, '5', '3'), lot(2, '7', '7')])),
    ).toMatchObject({ decimalQuantity: '1' });
    expect(calculate(input([lot(1, '7', '7')]))).toEqual({
      numerator: '0',
      denominator: '1',
      wholeShares: '0',
      remainderNumerator: '0',
      remainderDenominator: '1',
      decimalQuantity: '0',
    });
  });

  it('handles decimal ratios and the exact twelve-decimal boundary', () => {
    const data = input([lot(1, '0.000000000002')]);
    data.action.numerator = '0.5';
    data.action.denominator = '1';
    expect(calculate(data).decimalQuantity).toBe('0.000000000001');
    data.sourceLots = [lot(1, '0.000000000001')];
    expect(calculate(data)).toMatchObject({
      numerator: '1',
      denominator: '2000000000000',
      decimalQuantity: null,
    });
  });

  it('rejects duplicate, ambiguous, out-of-scope, future and overdisposed lots', () => {
    expect(() => calculate(input([lot(1), lot(1)]))).toThrow('lot-duplicate');
    expect(() =>
      calculate(input([lot(1), { ...lot(2), acquisitionSequence: 1 }])),
    ).toThrow('acquisition-order-ambiguous');
    expect(() =>
      calculate(input([{ ...lot(1), instrumentId: id(9) }])),
    ).toThrow('scope-mismatch');
    expect(() =>
      calculate(input([{ ...lot(1), acquiredOn: '2027-01-01' }])),
    ).toThrow('lot-after-effective-date');
    expect(() => calculate(input([lot(1, '1', '2')]))).toThrow(
      'lot-state-inconsistent',
    );
  });

  it('rejects invalid ratios and snapshots and preserves rational magnitude overflow', () => {
    expect(() => calculate(input([lot(1)], '0'))).toThrow();
    expect(() => calculate(input([lot(1)], '1'))).toThrow(
      'ratio-direction-invalid',
    );
    expect(() => calculate({ ...input(), sourceAsOf: '2025-01-01' })).toThrow(
      'snapshot-date-mismatch',
    );
    const data = input([lot(1, '99999999999999999999999999')]);
    data.action.actionType = 'split';
    data.action.numerator = '2';
    data.action.denominator = '1';
    expect(calculate(data)).toMatchObject({
      numerator: '199999999999999999999999998',
      denominator: '1',
      decimalQuantity: null,
    });
    expect(() => calculate(input([lot(1, '0.0000000000001')]))).toThrow();
  });
});

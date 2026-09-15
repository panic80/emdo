import { describe, it, expect } from 'vitest';
import {
  valueInvestmentPortfolio,
  calculateInvestmentPosition,
  reconcileInvestmentPosition,
  valueInvestmentPosition,
  splitInvestmentQuantity,
} from './investments.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = {
  financialAccountId: id(1),
  instrumentId: id(2),
  asOf: '2026-03-31',
};
const opening = {
  ...identity,
  asOf: '2026-01-31',
  quantity: '9007199254740993.125',
  sourceReference: 'opening:evidence-1',
};
const movement = {
  id: id(3),
  financialAccountId: id(1),
  instrumentId: id(2),
  effectiveOn: '2026-02-01',
  quantity: '0.125',
  sourceReference: 'journal:trade-1',
};
const price = {
  id: id(4),
  instrumentId: id(2),
  asOf: identity.asOf,
  price: '123.45',
  currency: 'USD',
  sourceReference: 'statement:price',
};
const fx = {
  id: id(5),
  asOf: identity.asOf,
  fromCurrency: 'USD',
  toCurrency: 'CAD',
  rate: '1.35',
  sourceReference: 'fx:observation',
};
describe('investment positions and valuations', () => {
  it('requires an explicit opening and applies later movements without floating point', () => {
    expect(
      calculateInvestmentPosition({
        ...identity,
        opening: null,
        movements: [movement],
      }),
    ).toMatchObject({ status: 'unavailable', quantity: null });
    const result = calculateInvestmentPosition({
      ...identity,
      opening,
      movements: [
        movement,
        { ...movement, id: id(6), effectiveOn: '2026-01-31', quantity: '100' },
        { ...movement, id: id(7), effectiveOn: '2026-04-01', quantity: '100' },
      ],
    });
    expect(result.quantity).toBe('9007199254740993.25');
    expect(result.movementIds).toEqual([movement.id]);
    expect(() =>
      calculateInvestmentPosition({
        ...identity,
        opening,
        movements: [movement, movement],
      }),
    ).toThrow('duplicate');
    expect(() =>
      calculateInvestmentPosition({
        ...identity,
        opening,
        movements: [{ ...movement, financialAccountId: id(8) }],
      }),
    ).toThrow('scope-mismatch');
  });
  it('keeps observed quantities separate from calculated history', () => {
    const calculated = calculateInvestmentPosition({
      ...identity,
      opening: { ...opening, quantity: '10' },
      movements: [movement],
    });
    const observed = {
      ...identity,
      id: id(9),
      quantity: '10.5',
      reportedMarketValue: null,
      currency: null,
      evidenceId: id(10),
      sourceRow: 8,
    };
    expect(reconcileInvestmentPosition(observed, calculated)).toMatchObject({
      observedQuantity: '10.5',
      calculatedQuantity: '10.125',
      difference: '0.375',
      status: 'difference',
    });
    expect(calculated.quantity).toBe('10.125');
    expect(
      reconcileInvestmentPosition(
        observed,
        calculateInvestmentPosition({
          ...identity,
          opening: null,
          movements: [],
        }),
      ),
    ).toMatchObject({ status: 'unavailable', difference: null });
  });
  it('values explicit quote multipliers and FX with native then functional rounding', () => {
    expect(
      valueInvestmentPosition({
        ...identity,
        quantity: '1000',
        valuationMultiplier: '0.01',
        functionalCurrency: 'CAD',
        price,
        fx,
      }),
    ).toMatchObject({
      status: 'available',
      nativeValue: '1234.5',
      functionalValue: '1666.58',
      priceId: price.id,
      fxId: fx.id,
    });
    expect(
      valueInvestmentPosition({
        ...identity,
        quantity: '2',
        valuationMultiplier: '100',
        functionalCurrency: 'USD',
        price: { ...price, price: '1.005' },
        fx: null,
      }),
    ).toMatchObject({ functionalValue: '201' });
    expect(
      valueInvestmentPosition({
        ...identity,
        quantity: '1',
        valuationMultiplier: '1',
        functionalCurrency: 'JPY',
        price: { ...price, currency: 'JPY', price: '100.5' },
        fx: null,
      }),
    ).toMatchObject({ functionalValue: '101' });
  });
  it('reports absent or stale observations and rejects inverse rates', () => {
    const input = {
      ...identity,
      quantity: '10',
      valuationMultiplier: '1',
      functionalCurrency: 'CAD',
      price,
      fx,
    };
    expect(valueInvestmentPosition({ ...input, quantity: null })).toMatchObject(
      { functionalValue: null, reason: 'missing-calculated-position' },
    );
    expect(valueInvestmentPosition({ ...input, price: null })).toMatchObject({
      functionalValue: null,
      reason: 'missing-price',
    });
    expect(valueInvestmentPosition({ ...input, fx: null })).toMatchObject({
      nativeValue: '1234.5',
      functionalValue: null,
      reason: 'missing-fx',
      sourceReferences: [price.sourceReference],
    });
    expect(
      valueInvestmentPosition({
        ...input,
        price: { ...price, asOf: '2026-03-30' },
      }),
    ).toMatchObject({ functionalValue: null, reason: 'price-date-mismatch' });
    expect(
      valueInvestmentPosition({ ...input, fx: { ...fx, asOf: '2026-03-30' } }),
    ).toMatchObject({
      reason: 'fx-date-mismatch',
      nativeValue: '1234.5',
      functionalValue: null,
      sourceReferences: [price.sourceReference],
      fxId: null,
    });
    expect(() =>
      valueInvestmentPosition({
        ...input,
        fx: { ...fx, fromCurrency: 'CAD', toCurrency: 'USD' },
      }),
    ).toThrow('direction-mismatch');
  });
  it('never presents a partial valuation as a complete portfolio total', () => {
    const valued = {
      ...identity,
      quantity: '10',
      valuationMultiplier: '1',
      functionalCurrency: 'USD',
      price,
      fx: null,
    };
    expect(
      valueInvestmentPortfolio([
        valued,
        { ...valued, instrumentId: id(10), price: null },
      ]),
    ).toMatchObject({
      status: 'incomplete',
      total: null,
      availableSubtotal: '1234.5',
      unavailableCount: 1,
    });
    expect(
      valueInvestmentPortfolio([
        { ...valued, price: { ...price, price: '0' } },
      ]),
    ).toMatchObject({ status: 'complete', total: '0' });
    expect(() => valueInvestmentPortfolio([valued, valued])).toThrow(
      'duplicate-position',
    );
  });
  it('applies exact splits and refuses to silently discard fractional entitlements', () => {
    expect(splitInvestmentQuantity('7.5', '2', '1')).toBe('15');
    expect(splitInvestmentQuantity('15', '1', '2')).toBe('7.5');
    expect(() => splitInvestmentQuantity('1', '1', '3')).toThrow(
      'fractional-entitlement',
    );
  });
});

import { describe, it, expect } from 'vitest';
import { allocateInvestmentDisposal } from './lots.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lot = {
  id: id(3),
  financialAccountId: id(1),
  instrumentId: id(2),
  acquiredOn: '2026-01-01',
  acquisitionSequence: 0,
  originalQuantity: '3',
  disposedQuantity: '0',
  originalNativeCost: '1',
  allocatedNativeCost: '0',
  originalFunctionalCost: '1',
  allocatedFunctionalCost: '0',
  nativeCurrency: 'CAD',
  functionalCurrency: 'CAD',
  sourceReference: 'purchase:1',
};
const zero = { native: '0', functional: '0' };
const input = {
  financialAccountId: id(1),
  instrumentId: id(2),
  effectiveOn: '2026-03-31',
  quantity: '1',
  nativeCurrency: 'CAD',
  functionalCurrency: 'CAD',
  method: 'fifo',
  selections: [],
  lots: [lot],
  grossProceeds: { native: '2', functional: '2' },
  fees: zero,
  commissions: zero,
  taxes: zero,
  taxTreatment: 'disposal-cost',
  fxSourceReference: null,
  sourceReference: 'sale:1',
};
describe('deterministic investment lot allocation', () => {
  it('conserves full basis across repeated partial disposals without rounding drift', () => {
    const first = allocateInvestmentDisposal(input);
    expect(first).toMatchObject({
      nativeCost: '0.33',
      nativeGain: '1.67',
      allocations: [
        { after: { remainingQuantity: '2', remainingNativeCost: '0.67' } },
      ],
    });
    const second = allocateInvestmentDisposal({
      ...input,
      lots: [
        {
          ...lot,
          disposedQuantity: '1',
          allocatedNativeCost: '0.33',
          allocatedFunctionalCost: '0.33',
        },
      ],
    });
    expect(second.nativeCost).toBe('0.34');
    const third = allocateInvestmentDisposal({
      ...input,
      lots: [
        {
          ...lot,
          disposedQuantity: '2',
          allocatedNativeCost: '0.67',
          allocatedFunctionalCost: '0.67',
        },
      ],
    });
    expect(third).toMatchObject({
      nativeCost: '0.33',
      allocations: [
        {
          after: {
            remainingQuantity: '0',
            remainingNativeCost: '0',
            remainingFunctionalCost: '0',
          },
        },
      ],
    });
    expect(
      allocateInvestmentDisposal({ ...input, quantity: '2' }).nativeCost,
    ).toBe('0.67');
  });
  it('orders FIFO by acquisition date and explicit sequence, not caller array order', () => {
    const older = {
      ...lot,
      id: id(4),
      acquiredOn: '2025-12-01',
      originalQuantity: '1',
      originalNativeCost: '10',
      originalFunctionalCost: '10',
    };
    const later = { ...lot, id: id(5), acquisitionSequence: 1 };
    const result = allocateInvestmentDisposal({
      ...input,
      quantity: '2',
      lots: [later, lot, older],
    });
    expect(result.allocations.map((a) => a.lotId)).toEqual([older.id, lot.id]);
    expect(result.nativeCost).toBe('10.33');
  });
  it('honors explicit lots and retains each native/functional amount component', () => {
    const result = allocateInvestmentDisposal({
      ...input,
      method: 'specific',
      selections: [{ lotId: lot.id, quantity: '1' }],
      nativeCurrency: 'USD',
      functionalCurrency: 'CAD',
      lots: [
        {
          ...lot,
          nativeCurrency: 'USD',
          originalNativeCost: '30',
          originalFunctionalCost: '42',
        },
      ],
      grossProceeds: { native: '20', functional: '27' },
      fees: { native: '1', functional: '1.35' },
      commissions: { native: '0.5', functional: '0.68' },
      taxes: { native: '0.25', functional: '0.34' },
      fxSourceReference: 'fx:trade-settlement',
    });
    expect(result).toMatchObject({
      nativeCost: '10',
      functionalCost: '14',
      nativeNetProceeds: '18.25',
      functionalNetProceeds: '24.63',
      nativeGain: '8.25',
      functionalGain: '10.63',
      fees: { native: '1', functional: '1.35' },
      fxSourceReference: 'fx:trade-settlement',
    });
  });
  it('keeps withheld cash separate from disposal costs when determining tracked gains', () => {
    const result = allocateInvestmentDisposal({
      ...input,
      taxes: { native: '0.5', functional: '0.5' },
      taxTreatment: 'withholding',
    });
    expect(result).toMatchObject({
      nativeNetProceeds: '1.5',
      nativeGain: '1.67',
      taxTreatment: 'withholding',
    });
  });
  it('handles zero-decimal currencies and large exact balances', () => {
    const value = '999999999999999999999999';
    const result = allocateInvestmentDisposal({
      ...input,
      quantity: '3',
      nativeCurrency: 'JPY',
      functionalCurrency: 'JPY',
      lots: [
        {
          ...lot,
          nativeCurrency: 'JPY',
          functionalCurrency: 'JPY',
          originalNativeCost: value,
          originalFunctionalCost: value,
        },
      ],
      grossProceeds: { native: value, functional: value },
    });
    expect(result).toMatchObject({ nativeCost: value, nativeGain: '0' });
    expect(
      allocateInvestmentDisposal({
        ...input,
        nativeCurrency: 'KRW',
        functionalCurrency: 'KRW',
        lots: [{ ...lot, nativeCurrency: 'KRW', functionalCurrency: 'KRW' }],
      }).nativeCost,
    ).toBe('0');
  });
  it('rejects inconsistent state, mixed scope, overselling, future acquisitions and ambiguous selections', () => {
    expect(() =>
      allocateInvestmentDisposal({
        ...input,
        lots: [
          {
            ...lot,
            disposedQuantity: '1',
            allocatedNativeCost: '0.3',
            allocatedFunctionalCost: '0.33',
          },
        ],
      }),
    ).toThrow('state-inconsistent');
    expect(() =>
      allocateInvestmentDisposal({
        ...input,
        lots: [{ ...lot, instrumentId: id(8) }],
      }),
    ).toThrow('scope-mismatch');
    expect(() =>
      allocateInvestmentDisposal({ ...input, quantity: '4' }),
    ).toThrow('insufficient-quantity');
    expect(() =>
      allocateInvestmentDisposal({ ...input, effectiveOn: '2025-01-01' }),
    ).toThrow('insufficient-quantity');
    expect(() =>
      allocateInvestmentDisposal({
        ...input,
        lots: [lot, { ...lot, id: id(4) }],
      }),
    ).toThrow('acquisition-order-ambiguous');
    expect(() =>
      allocateInvestmentDisposal({
        ...input,
        method: 'specific',
        selections: [
          { lotId: lot.id, quantity: '1' },
          { lotId: lot.id, quantity: '1' },
        ],
      }),
    ).toThrow('selection-duplicate');
    expect(() =>
      allocateInvestmentDisposal({
        ...input,
        method: 'specific',
        selections: [{ lotId: lot.id, quantity: '2' }],
      }),
    ).toThrow('selection-quantity-mismatch');
  });
  it('requires currency precision and FX provenance without assuming statutory cost-basis rules', () => {
    expect(() =>
      allocateInvestmentDisposal({
        ...input,
        fees: { native: '0.001', functional: '0.001' },
      }),
    ).toThrow();
    expect(() =>
      allocateInvestmentDisposal({
        ...input,
        nativeCurrency: 'USD',
        lots: [{ ...lot, nativeCurrency: 'USD' }],
      }),
    ).toThrow('fx-provenance-required');
    expect(() =>
      allocateInvestmentDisposal({
        ...input,
        grossProceeds: { native: '2', functional: '3' },
      }),
    ).toThrow('identity-currency-mismatch');
    expect(() =>
      allocateInvestmentDisposal({ ...input, method: 'average' }),
    ).toThrow();
  });
});

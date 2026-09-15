import {
  AllocateInvestmentDisposalSchema,
  type FinanceCurrency,
} from '@emdo/contracts';
import {
  parseFinanceDecimal as decimal,
  formatFinanceDecimal as format,
  moneyValue,
  currencyPrecision,
} from './decimal.js';
/** Cumulative allocation makes rounding independent of how a disposal is split into requests. */
function allocatedCost(
  cost: bigint,
  sold: bigint,
  quantity: bigint,
  currency: FinanceCurrency,
) {
  const unit = 10n ** BigInt(12 - currencyPrecision(currency));
  return ((cost * sold + (quantity * unit) / 2n) / (quantity * unit)) * unit;
}
export function allocateInvestmentDisposal(input: unknown) {
  const data = AllocateInvestmentDisposalSchema.parse(input);
  const ids = new Set<string>(),
    orders = new Set<string>();
  const lots = data.lots.map((lot) => {
    if (ids.has(lot.id)) throw new Error('finance-lot-duplicate');
    ids.add(lot.id);
    if (
      lot.financialAccountId !== data.financialAccountId ||
      lot.instrumentId !== data.instrumentId ||
      lot.nativeCurrency !== data.nativeCurrency ||
      lot.functionalCurrency !== data.functionalCurrency
    )
      throw new Error('finance-lot-scope-mismatch');
    const order = `${lot.acquiredOn}:${lot.acquisitionSequence}`;
    if (orders.has(order))
      throw new Error('finance-lot-acquisition-order-ambiguous');
    orders.add(order);
    const quantity = decimal(lot.originalQuantity),
      sold = decimal(lot.disposedQuantity);
    const native = moneyValue(lot.originalNativeCost, lot.nativeCurrency),
      functional = moneyValue(
        lot.originalFunctionalCost,
        lot.functionalCurrency,
      );
    const usedNative = moneyValue(lot.allocatedNativeCost, lot.nativeCurrency),
      usedFunctional = moneyValue(
        lot.allocatedFunctionalCost,
        lot.functionalCurrency,
      );
    if (
      sold > quantity ||
      usedNative !==
        allocatedCost(native, sold, quantity, lot.nativeCurrency) ||
      usedFunctional !==
        allocatedCost(functional, sold, quantity, lot.functionalCurrency)
    )
      throw new Error('finance-lot-state-inconsistent');
    return {
      lot,
      quantity,
      sold,
      native,
      functional,
      usedNative,
      usedFunctional,
    };
  });
  const target = decimal(data.quantity),
    selectionIds = new Set<string>();
  let remaining = target;
  const selected: { state: (typeof lots)[number]; quantity: bigint }[] = [];
  if (data.method === 'fifo') {
    if (data.selections.length)
      throw new Error('finance-lot-fifo-selection-not-allowed');
    for (const state of [...lots].sort(
      (a, b) =>
        a.lot.acquiredOn.localeCompare(b.lot.acquiredOn) ||
        a.lot.acquisitionSequence - b.lot.acquisitionSequence,
    )) {
      if (state.lot.acquiredOn > data.effectiveOn || remaining === 0n) continue;
      const available = state.quantity - state.sold,
        quantity = available < remaining ? available : remaining;
      if (quantity > 0n) {
        selected.push({ state, quantity });
        remaining -= quantity;
      }
    }
  } else {
    if (!data.selections.length)
      throw new Error('finance-lot-specific-selection-required');
    for (const selection of data.selections) {
      if (selectionIds.has(selection.lotId))
        throw new Error('finance-lot-selection-duplicate');
      selectionIds.add(selection.lotId);
      const state = lots.find((v) => v.lot.id === selection.lotId),
        quantity = decimal(selection.quantity);
      if (!state || state.lot.acquiredOn > data.effectiveOn)
        throw new Error('finance-lot-selection-unavailable');
      if (quantity > state.quantity - state.sold)
        throw new Error('finance-lot-insufficient-quantity');
      selected.push({ state, quantity });
      remaining -= quantity;
    }
  }
  if (remaining !== 0n)
    throw new Error(
      remaining > 0n
        ? 'finance-lot-insufficient-quantity'
        : 'finance-lot-selection-quantity-mismatch',
    );
  let nativeCost = 0n,
    functionalCost = 0n;
  const allocations = selected.map(({ state, quantity }) => {
    const totalSold = state.sold + quantity;
    const totalNative = allocatedCost(
        state.native,
        totalSold,
        state.quantity,
        data.nativeCurrency,
      ),
      totalFunctional = allocatedCost(
        state.functional,
        totalSold,
        state.quantity,
        data.functionalCurrency,
      );
    const native = totalNative - state.usedNative,
      functional = totalFunctional - state.usedFunctional;
    nativeCost += native;
    functionalCost += functional;
    return {
      lotId: state.lot.id,
      quantity: format(quantity),
      nativeCost: format(native),
      functionalCost: format(functional),
      sourceReference: state.lot.sourceReference,
      after: {
        disposedQuantity: format(totalSold),
        allocatedNativeCost: format(totalNative),
        allocatedFunctionalCost: format(totalFunctional),
        remainingQuantity: format(state.quantity - totalSold),
        remainingNativeCost: format(state.native - totalNative),
        remainingFunctionalCost: format(state.functional - totalFunctional),
      },
    };
  });
  const components = ['grossProceeds', 'fees', 'commissions', 'taxes'] as const;
  const parsed = Object.fromEntries(
    components.map((key) => [
      key,
      {
        native: moneyValue(data[key].native, data.nativeCurrency),
        functional: moneyValue(data[key].functional, data.functionalCurrency),
      },
    ]),
  ) as Record<
    (typeof components)[number],
    { native: bigint; functional: bigint }
  >;
  if (data.nativeCurrency === data.functionalCurrency) {
    if (
      components.some((key) => parsed[key].native !== parsed[key].functional) ||
      lots.some((l) => l.native !== l.functional)
    )
      throw new Error('finance-lot-identity-currency-mismatch');
  } else if (!data.fxSourceReference)
    throw new Error('finance-lot-fx-provenance-required');
  const nativeNet =
    parsed.grossProceeds.native -
    parsed.fees.native -
    parsed.commissions.native -
    parsed.taxes.native;
  const functionalNet =
    parsed.grossProceeds.functional -
    parsed.fees.functional -
    parsed.commissions.functional -
    parsed.taxes.functional;
  const amounts = {
    nativeCost: format(nativeCost),
    functionalCost: format(functionalCost),
    nativeNetProceeds: format(nativeNet),
    functionalNetProceeds: format(functionalNet),
    nativeGain: format(
      nativeNet -
        nativeCost +
        (data.taxTreatment === 'withholding' ? parsed.taxes.native : 0n),
    ),
    functionalGain: format(
      functionalNet -
        functionalCost +
        (data.taxTreatment === 'withholding' ? parsed.taxes.functional : 0n),
    ),
  };
  for (const value of Object.values(amounts)) decimal(value);
  return {
    calculationVersion: 'investment-lots.v1',
    method: data.method,
    rounding: 'cumulative-proportional-half-away-from-zero',
    financialAccountId: data.financialAccountId,
    instrumentId: data.instrumentId,
    effectiveOn: data.effectiveOn,
    quantity: data.quantity,
    nativeCurrency: data.nativeCurrency,
    functionalCurrency: data.functionalCurrency,
    ...amounts,
    grossProceeds: data.grossProceeds,
    fees: data.fees,
    commissions: data.commissions,
    taxes: data.taxes,
    taxTreatment: data.taxTreatment,
    sourceReference: data.sourceReference,
    fxSourceReference: data.fxSourceReference,
    allocations,
  };
}

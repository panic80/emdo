import {
  PlanInvestmentStockSplitSettlementSchema,
  FinanceStockSplitSettlementPlanSchema,
} from '@emdo/contracts';
import { calculateStockSplitAccountEntitlement } from './corporate-action-entitlements.js';
import {
  DECIMAL_SCALE,
  convertBookAmount,
  currencyPrecision,
  formatFinanceDecimal,
  moneyValue,
  parseFinanceDecimal,
} from './decimal.js';

type Rational = { numerator: bigint; denominator: bigint };
const fail = (reason: string): never => {
  throw new Error(`finance-corporate-action-settlement-${reason}`);
};
function rational(numerator: bigint, denominator: bigint): Rational {
  let a = numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  const result = { numerator: numerator / a, denominator: denominator / a };
  if (
    result.numerator.toString().length > 120 ||
    result.denominator.toString().length > 120
  )
    fail('quantity-overflow');
  return result;
}
const read = (value: { numerator: string; denominator: string }) =>
  rational(BigInt(value.numerator), BigInt(value.denominator));
const write = (value: Rational) => ({
  numerator: value.numerator.toString(),
  denominator: value.denominator.toString(),
});
const add = (a: Rational, b: Rational) =>
  rational(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
const equal = (a: Rational, b: Rational) =>
  a.numerator * b.denominator === b.numerator * a.denominator;

/** Validates explicit settlement evidence and book allocations; does not post or assess tax. */
export function planInvestmentStockSplitSettlement(input: unknown) {
  const data = PlanInvestmentStockSplitSettlementSchema.parse(input);
  const { action } = data.source;
  const consideration = data.cashConsideration;
  const entitlement = read(calculateStockSplitAccountEntitlement(data.source));
  if (action.fractionalTreatment !== 'cash-in-lieu')
    fail('cash-in-lieu-policy-required');
  if (consideration.settledOn < action.effectiveOn)
    fail('settlement-before-action');
  const delivered = read(data.deliveredQuantity);
  const disposed = read(data.cashDisposedQuantity);
  if (disposed.numerator === 0n) fail('cash-quantity-required');
  if (!equal(add(delivered, disposed), entitlement))
    fail('account-quantity-mismatch');

  const nativeCurrency = consideration.native.currency;
  const functionalCurrency = consideration.functional.currency;
  const nativeCash = moneyValue(consideration.native.amount, nativeCurrency);
  const functionalCash = moneyValue(
    consideration.functional.amount,
    functionalCurrency,
  );
  if (nativeCurrency === functionalCurrency) {
    if (
      nativeCash !== functionalCash ||
      (consideration.fx !== null &&
        parseFinanceDecimal(consideration.fx.rate) !== DECIMAL_SCALE)
    )
      fail('identity-currency-mismatch');
  } else {
    if (consideration.fx === null) fail('fx-evidence-required');
    if (
      moneyValue(
        convertBookAmount(
          consideration.native.amount,
          consideration.fx!.rate,
          functionalCurrency,
        ),
        functionalCurrency,
      ) !== functionalCash
    )
      fail('fx-amount-mismatch');
  }
  if (
    action.cashInLieu !== null &&
    (action.cashInLieu.consideration.currency !== nativeCurrency ||
      moneyValue(action.cashInLieu.consideration.amount, nativeCurrency) !==
        nativeCash ||
      action.cashInLieu.evidenceId !== consideration.evidenceId ||
      action.cashInLieu.sourceReference !== consideration.sourceReference)
  )
    fail('source-consideration-mismatch');

  const allocations = new Map<string, (typeof data.allocations)[number]>();
  for (const allocation of data.allocations) {
    if (allocations.has(allocation.sourceLotId)) fail('allocation-duplicate');
    allocations.set(allocation.sourceLotId, allocation);
  }
  let totalRetained = rational(0n, 1n);
  let totalDisposed = rational(0n, 1n);
  let retainedNative = 0n;
  let retainedFunctional = 0n;
  let disposedNative = 0n;
  let disposedFunctional = 0n;
  let sourceNative = 0n;
  let sourceFunctional = 0n;
  const normalized: typeof data.allocations = [];
  const ratioNumerator = parseFinanceDecimal(action.numerator);
  const ratioDenominator = parseFinanceDecimal(action.denominator);
  const lots = [...data.source.sourceLots].sort(
    (a, b) =>
      a.acquiredOn.localeCompare(b.acquiredOn) ||
      a.acquisitionSequence - b.acquisitionSequence ||
      a.id.localeCompare(b.id),
  );
  for (const lot of lots) {
    if (
      lot.nativeCurrency !== nativeCurrency ||
      lot.functionalCurrency !== functionalCurrency
    )
      fail('currency-scope-mismatch');
    const original = parseFinanceDecimal(lot.originalQuantity);
    const previousDisposed = parseFinanceDecimal(lot.disposedQuantity);
    const remaining = original - previousDisposed;
    const originalNative = moneyValue(lot.originalNativeCost, nativeCurrency);
    const originalFunctional = moneyValue(
      lot.originalFunctionalCost,
      functionalCurrency,
    );
    const previousNative = moneyValue(lot.allocatedNativeCost, nativeCurrency);
    const previousFunctional = moneyValue(
      lot.allocatedFunctionalCost,
      functionalCurrency,
    );
    const cumulative = (cost: bigint, currency: typeof nativeCurrency) => {
      const unit = 10n ** BigInt(12 - currencyPrecision(currency));
      return (
        ((cost * previousDisposed + (original * unit) / 2n) /
          (original * unit)) *
        unit
      );
    };
    if (
      previousNative !== cumulative(originalNative, nativeCurrency) ||
      previousFunctional !== cumulative(originalFunctional, functionalCurrency)
    )
      fail('source-cost-inconsistent');
    if (
      nativeCurrency === functionalCurrency &&
      (originalNative !== originalFunctional ||
        previousNative !== previousFunctional)
    )
      fail('identity-currency-mismatch');
    if (remaining === 0n) {
      if (allocations.has(lot.id)) fail('allocation-for-closed-lot');
      continue;
    }
    const allocation = allocations.get(lot.id);
    if (!allocation) fail('allocation-missing');
    allocations.delete(lot.id);
    const retained = read(allocation!.retainedQuantity);
    const cash = read(allocation!.cashDisposedQuantity);
    if (
      !equal(
        add(retained, cash),
        rational(remaining * ratioNumerator, ratioDenominator * DECIMAL_SCALE),
      )
    )
      fail('lot-quantity-mismatch');
    const rn = moneyValue(allocation!.retainedNativeCost, nativeCurrency);
    const rf = moneyValue(
      allocation!.retainedFunctionalCost,
      functionalCurrency,
    );
    const dn = moneyValue(allocation!.disposedNativeCost, nativeCurrency);
    const df = moneyValue(
      allocation!.disposedFunctionalCost,
      functionalCurrency,
    );
    if (
      rn + dn !== originalNative - previousNative ||
      rf + df !== originalFunctional - previousFunctional
    )
      fail('lot-cost-mismatch');
    if (
      (retained.numerator === 0n && (rn !== 0n || rf !== 0n)) ||
      (cash.numerator === 0n && (dn !== 0n || df !== 0n))
    )
      fail('cost-without-quantity');
    if (nativeCurrency === functionalCurrency && (rn !== rf || dn !== df))
      fail('identity-currency-mismatch');
    totalRetained = add(totalRetained, retained);
    totalDisposed = add(totalDisposed, cash);
    retainedNative += rn;
    retainedFunctional += rf;
    disposedNative += dn;
    disposedFunctional += df;
    sourceNative += originalNative - previousNative;
    sourceFunctional += originalFunctional - previousFunctional;
    normalized.push({
      ...allocation!,
      retainedQuantity: write(retained),
      cashDisposedQuantity: write(cash),
      retainedNativeCost: formatFinanceDecimal(rn),
      retainedFunctionalCost: formatFinanceDecimal(rf),
      disposedNativeCost: formatFinanceDecimal(dn),
      disposedFunctionalCost: formatFinanceDecimal(df),
    });
  }
  if (allocations.size !== 0) fail('allocation-unknown-lot');
  if (!equal(totalRetained, delivered) || !equal(totalDisposed, disposed))
    fail('allocation-account-mismatch');
  return FinanceStockSplitSettlementPlanSchema.parse({
    calculationVersion: 'investment-corporate-action-settlement.v1',
    actionId: action.id,
    financialAccountId: action.financialAccountId,
    instrumentId: action.instrumentId,
    effectiveOn: action.effectiveOn,
    settledOn: consideration.settledOn,
    accountEntitlement: write(entitlement),
    deliveredQuantity: write(delivered),
    cashDisposedQuantity: write(disposed),
    nativeCurrency,
    functionalCurrency,
    sourceNativeCost: formatFinanceDecimal(sourceNative),
    sourceFunctionalCost: formatFinanceDecimal(sourceFunctional),
    retainedNativeCost: formatFinanceDecimal(retainedNative),
    retainedFunctionalCost: formatFinanceDecimal(retainedFunctional),
    disposedNativeCost: formatFinanceDecimal(disposedNative),
    disposedFunctionalCost: formatFinanceDecimal(disposedFunctional),
    nativeBookGainLoss: formatFinanceDecimal(nativeCash - disposedNative),
    functionalBookGainLoss: formatFinanceDecimal(
      functionalCash - disposedFunctional,
    ),
    allocations: normalized,
    cashConsideration: {
      ...consideration,
      native: {
        ...consideration.native,
        amount: formatFinanceDecimal(nativeCash),
      },
      functional: {
        ...consideration.functional,
        amount: formatFinanceDecimal(functionalCash),
      },
    },
    allocationReview: data.allocationReview,
    status: 'validated-plan',
    persistence: 'not-implemented',
    taxTreatment: 'not-assessed',
  });
}

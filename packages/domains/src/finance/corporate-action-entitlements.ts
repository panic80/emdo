import {
  FinanceDecimalSchema,
  PlanInvestmentStockSplitSchema,
} from '@emdo/contracts/browser';
import {
  DECIMAL_SCALE,
  formatFinanceDecimal,
  parseFinanceDecimal,
} from './decimal.js';

function reduced(numerator: bigint, denominator: bigint) {
  let a = numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return { numerator: numerator / a, denominator: denominator / a };
}

/** Exact account entitlement; this neither allocates settlements nor authorizes a commit. */
export function calculateStockSplitAccountEntitlement(input: unknown): {
  numerator: string;
  denominator: string;
  wholeShares: string;
  remainderNumerator: string;
  remainderDenominator: string;
  decimalQuantity: string | null;
} {
  const data = PlanInvestmentStockSplitSchema.parse(input);
  const { action } = data;
  if (data.sourceAsOf !== action.effectiveOn)
    throw new Error('finance-corporate-action-source-snapshot-date-mismatch');
  const numerator = parseFinanceDecimal(action.numerator);
  const denominator = parseFinanceDecimal(action.denominator);
  if (
    (action.actionType === 'split' && numerator <= denominator) ||
    (action.actionType === 'reverse-split' && numerator >= denominator)
  )
    throw new Error('finance-corporate-action-ratio-direction-invalid');

  const ids = new Set<string>();
  const acquisitionOrders = new Set<string>();
  let remaining = 0n;
  for (const lot of data.sourceLots) {
    if (ids.has(lot.id))
      throw new Error('finance-corporate-action-lot-duplicate');
    ids.add(lot.id);
    if (
      lot.financialAccountId !== action.financialAccountId ||
      lot.instrumentId !== action.instrumentId
    )
      throw new Error('finance-corporate-action-scope-mismatch');
    if (lot.acquiredOn > action.effectiveOn)
      throw new Error('finance-corporate-action-lot-after-effective-date');
    const order = `${lot.acquiredOn}:${lot.acquisitionSequence}`;
    if (acquisitionOrders.has(order))
      throw new Error('finance-corporate-action-acquisition-order-ambiguous');
    acquisitionOrders.add(order);
    const original = parseFinanceDecimal(lot.originalQuantity);
    const disposed = parseFinanceDecimal(lot.disposedQuantity);
    if (disposed > original)
      throw new Error('finance-corporate-action-lot-state-inconsistent');
    remaining += original - disposed;
  }

  const exact = reduced(remaining * numerator, denominator * DECIMAL_SCALE);
  const wholeShares = exact.numerator / exact.denominator;
  const fraction = reduced(
    exact.numerator % exact.denominator,
    exact.denominator,
  );
  const scaled = exact.numerator * DECIMAL_SCALE;
  const candidateDecimal =
    scaled % exact.denominator === 0n
      ? formatFinanceDecimal(scaled / exact.denominator)
      : null;
  // Preserve exact rational output even if decimal precision or magnitude cannot fit.
  const decimalQuantity =
    candidateDecimal !== null &&
    FinanceDecimalSchema.safeParse(candidateDecimal).success
      ? candidateDecimal
      : null;
  if (
    [
      exact.numerator,
      exact.denominator,
      wholeShares,
      fraction.numerator,
      fraction.denominator,
    ].some((value) => value.toString().length > 120)
  )
    throw new Error('finance-corporate-action-quantity-overflow');
  return {
    numerator: exact.numerator.toString(),
    denominator: exact.denominator.toString(),
    wholeShares: wholeShares.toString(),
    remainderNumerator: fraction.numerator.toString(),
    remainderDenominator: fraction.denominator.toString(),
    decimalQuantity,
  };
}

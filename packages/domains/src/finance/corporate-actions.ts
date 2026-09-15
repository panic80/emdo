import {
  FinanceDecimalSchema,
  FinanceStockSplitPlanSchema,
  PlanInvestmentStockSplitSchema,
} from '@emdo/contracts/browser';
import {
  currencyPrecision,
  formatFinanceDecimal,
  moneyValue,
  parseFinanceDecimal,
} from './decimal.js';
import { calculateStockSplitAccountEntitlement } from './corporate-action-entitlements.js';

const DECIMAL_SCALE = 1_000_000_000_000n;

/** Cumulative cost allocation mirrors investment-lot disposal accounting. */
function allocatedCost(
  cost: bigint,
  sold: bigint,
  quantity: bigint,
  currency: Parameters<typeof currencyPrecision>[0],
) {
  const unit = 10n ** BigInt(12 - currencyPrecision(currency));
  return ((cost * sold + (quantity * unit) / 2n) / (quantity * unit)) * unit;
}

function gcd(a: bigint, b: bigint): bigint {
  let left = a < 0n ? -a : a;
  let right = b < 0n ? -b : b;
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left === 0n ? 1n : left;
}

function assertDecimal(value: string, label: string) {
  try {
    FinanceDecimalSchema.parse(value);
  } catch {
    throw new Error(`finance-corporate-action-${label}-overflow`);
  }
  return value;
}

function uniqueReasons(
  reasons: Array<
    | 'fractional-entitlement-review-required'
    | 'fractional-quantity-not-representable'
    | 'fractional-policy-required'
    | 'cash-in-lieu-consideration-missing'
    | 'cash-in-lieu-basis-treatment-unsupported'
  >,
) {
  return [...new Set(reasons)];
}

/**
 * Plans a forward or reverse stock split against the currently remaining
 * portion of each source lot. This is a proposal only: it never changes a
 * source lot or creates a persisted successor lot.
 *
 * Cost basis is carried as the exact remaining native and functional amount
 * from each source lot. It is deliberately not reallocated between a
 * representable successor and cash-in-lieu: that would require a separate
 * policy or tax treatment and is therefore blocked for review.
 */
export function planInvestmentStockSplit(input: unknown) {
  const data = PlanInvestmentStockSplitSchema.parse(input);
  const action = data.action;
  if (data.sourceAsOf !== action.effectiveOn)
    throw new Error('finance-corporate-action-source-snapshot-date-mismatch');
  const numerator = parseFinanceDecimal(action.numerator);
  const denominator = parseFinanceDecimal(action.denominator);

  if (
    (action.actionType === 'split' && numerator <= denominator) ||
    (action.actionType === 'reverse-split' && numerator >= denominator)
  )
    throw new Error('finance-corporate-action-ratio-direction-invalid');

  const lotIds = new Set<string>();
  const acquisitionOrders = new Set<string>();
  const effects: ReturnType<typeof buildLotEffect>[] = [];
  let sourceRemainingNativeCost = 0n;
  let sourceRemainingFunctionalCost = 0n;
  let hasFractionalEntitlement = false;
  let hasUnrepresentableFraction = false;

  const lots = [...data.sourceLots].sort(
    (left, right) =>
      left.acquiredOn.localeCompare(right.acquiredOn) ||
      left.acquisitionSequence - right.acquisitionSequence ||
      left.id.localeCompare(right.id),
  );

  for (const lot of lots) {
    if (lotIds.has(lot.id))
      throw new Error('finance-corporate-action-lot-duplicate');
    lotIds.add(lot.id);

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

    const originalQuantity = parseFinanceDecimal(lot.originalQuantity);
    const disposedQuantity = parseFinanceDecimal(lot.disposedQuantity);
    const originalNativeCost = moneyValue(
      lot.originalNativeCost,
      lot.nativeCurrency,
    );
    const allocatedNativeCostValue = moneyValue(
      lot.allocatedNativeCost,
      lot.nativeCurrency,
    );
    const originalFunctionalCost = moneyValue(
      lot.originalFunctionalCost,
      lot.functionalCurrency,
    );
    const allocatedFunctionalCostValue = moneyValue(
      lot.allocatedFunctionalCost,
      lot.functionalCurrency,
    );

    if (
      disposedQuantity > originalQuantity ||
      allocatedNativeCostValue !==
        allocatedCost(
          originalNativeCost,
          disposedQuantity,
          originalQuantity,
          lot.nativeCurrency,
        ) ||
      allocatedFunctionalCostValue !==
        allocatedCost(
          originalFunctionalCost,
          disposedQuantity,
          originalQuantity,
          lot.functionalCurrency,
        )
    )
      throw new Error('finance-corporate-action-lot-state-inconsistent');
    if (lot.nativeCurrency === lot.functionalCurrency) {
      if (
        originalNativeCost !== originalFunctionalCost ||
        allocatedNativeCostValue !== allocatedFunctionalCostValue
      )
        throw new Error('finance-corporate-action-identity-currency-mismatch');
    }

    const remainingQuantity = originalQuantity - disposedQuantity;
    const remainingNativeCost = originalNativeCost - allocatedNativeCostValue;
    const remainingFunctionalCost =
      originalFunctionalCost - allocatedFunctionalCostValue;
    sourceRemainingNativeCost += remainingNativeCost;
    sourceRemainingFunctionalCost += remainingFunctionalCost;

    const transformedNumerator = remainingQuantity * numerator;
    const wholeQuantityUnits = transformedNumerator / denominator;
    const remainderUnits = transformedNumerator % denominator;
    const exactShareDenominator = denominator * DECIMAL_SCALE;
    const wholeShareQuantity = transformedNumerator / exactShareDenominator;
    const shareRemainderUnits = transformedNumerator % exactShareDenominator;
    const sourceRemainingQuantity = formatFinanceDecimal(remainingQuantity);
    const wholeQuantity = formatFinanceDecimal(wholeQuantityUnits);
    const fractionalEntitlement =
      shareRemainderUnits === 0n
        ? null
        : (() => {
            hasFractionalEntitlement = true;
            if (remainderUnits !== 0n) hasUnrepresentableFraction = true;
            const divisor = gcd(shareRemainderUnits, exactShareDenominator);
            return {
              wholeQuantity: assertDecimal(wholeQuantity, 'quantity'),
              wholeShareQuantity: assertDecimal(
                wholeShareQuantity.toString(),
                'quantity',
              ),
              remainderNumerator: (shareRemainderUnits / divisor).toString(),
              remainderDenominator: (
                exactShareDenominator / divisor
              ).toString(),
              fractionalUnit: 'share' as const,
              representable: remainderUnits === 0n,
              scale: '1000000000000' as const,
            };
          })();

    const successorQuantity =
      remainingQuantity > 0n &&
      remainderUnits === 0n &&
      (shareRemainderUnits === 0n || action.fractionalTreatment === 'retain')
        ? wholeQuantity
        : null;
    const successorLot =
      successorQuantity === null
        ? null
        : {
            successorLotKey: `${action.id}:${lot.id}`,
            sourceLotId: lot.id,
            financialAccountId: action.financialAccountId,
            instrumentId: action.instrumentId,
            acquiredOn: lot.acquiredOn,
            acquisitionSequence: lot.acquisitionSequence,
            originalQuantity: assertDecimal(successorQuantity, 'quantity'),
            disposedQuantity: '0' as const,
            originalNativeCost: formatFinanceDecimal(remainingNativeCost),
            allocatedNativeCost: '0' as const,
            originalFunctionalCost: formatFinanceDecimal(
              remainingFunctionalCost,
            ),
            allocatedFunctionalCost: '0' as const,
            nativeCurrency: lot.nativeCurrency,
            functionalCurrency: lot.functionalCurrency,
            sourceReference: `corporate-action:${action.id}:${lot.id}`,
          };

    effects.push(
      buildLotEffect({
        action,
        lot,
        sourceRemainingQuantity,
        remainingNativeCost,
        remainingFunctionalCost,
        successorQuantity,
        fractionalEntitlement,
        successorLot,
      }),
    );
  }

  if (!hasFractionalEntitlement && action.cashInLieu !== null)
    throw new Error(
      'finance-corporate-action-cash-in-lieu-without-fractional-entitlement',
    );

  const blockedReasons =
    hasFractionalEntitlement &&
    (action.fractionalTreatment !== 'retain' || hasUnrepresentableFraction)
      ? uniqueReasons([
          'fractional-entitlement-review-required',
          ...(hasUnrepresentableFraction
            ? ['fractional-quantity-not-representable' as const]
            : []),
          ...(action.fractionalTreatment === 'cash-in-lieu'
            ? [
                ...(action.cashInLieu === null
                  ? (['cash-in-lieu-consideration-missing'] as const)
                  : []),
                'cash-in-lieu-basis-treatment-unsupported' as const,
              ]
            : action.cashInLieu !== null
              ? ['cash-in-lieu-basis-treatment-unsupported' as const]
              : action.fractionalTreatment === 'unknown'
                ? ['fractional-policy-required' as const]
                : []),
        ])
      : action.fractionalTreatment === 'cash-in-lieu'
        ? ['cash-in-lieu-basis-treatment-unsupported' as const]
        : [];
  const result = {
    calculationVersion: 'investment-corporate-actions.v1' as const,
    accountEntitlement: calculateStockSplitAccountEntitlement(data),
    action,
    sourceAsOf: data.sourceAsOf,
    sourceBoundary: data.sourceBoundary,
    commitReadiness: blockedReasons.length
      ? ('blocked' as const)
      : ('ready' as const),
    blockedReasons,
    sourceLotCount: lots.length,
    successorLotCount: effects.filter((effect) => effect.successorLot !== null)
      .length,
    sourceRemainingNativeCost: assertDecimal(
      formatFinanceDecimal(sourceRemainingNativeCost),
      'native-cost',
    ),
    sourceRemainingFunctionalCost: assertDecimal(
      formatFinanceDecimal(sourceRemainingFunctionalCost),
      'functional-cost',
    ),
    successorNativeCostBasis: assertDecimal(
      formatFinanceDecimal(sourceRemainingNativeCost),
      'native-cost',
    ),
    successorFunctionalCostBasis: assertDecimal(
      formatFinanceDecimal(sourceRemainingFunctionalCost),
      'functional-cost',
    ),
    effects,
    persistence: 'not-implemented' as const,
  };
  return FinanceStockSplitPlanSchema.parse(result);
}

function buildLotEffect(input: {
  action: ReturnType<typeof PlanInvestmentStockSplitSchema.parse>['action'];
  lot: ReturnType<
    typeof PlanInvestmentStockSplitSchema.parse
  >['sourceLots'][number];
  sourceRemainingQuantity: string;
  remainingNativeCost: bigint;
  remainingFunctionalCost: bigint;
  successorQuantity: string | null;
  fractionalEntitlement: {
    wholeQuantity: string;
    wholeShareQuantity: string;
    remainderNumerator: string;
    remainderDenominator: string;
    fractionalUnit: 'share';
    representable: boolean;
    scale: '1000000000000';
  } | null;
  successorLot: Record<string, unknown> | null;
}) {
  return {
    actionId: input.action.id,
    evidenceId: input.action.evidenceId,
    financialAccountId: input.action.financialAccountId,
    instrumentId: input.action.instrumentId,
    sourceLotId: input.lot.id,
    acquiredOn: input.lot.acquiredOn,
    acquisitionSequence: input.lot.acquisitionSequence,
    sourceOriginalQuantity: input.lot.originalQuantity,
    sourceDisposedQuantity: input.lot.disposedQuantity,
    sourceRemainingQuantity: input.sourceRemainingQuantity,
    sourceNativeCostBasis: formatFinanceDecimal(input.remainingNativeCost),
    sourceFunctionalCostBasis: formatFinanceDecimal(
      input.remainingFunctionalCost,
    ),
    successorQuantity: input.successorQuantity,
    successorNativeCostBasis: formatFinanceDecimal(input.remainingNativeCost),
    successorFunctionalCostBasis: formatFinanceDecimal(
      input.remainingFunctionalCost,
    ),
    fractionalEntitlement: input.fractionalEntitlement,
    successorLot: input.successorLot,
  };
}

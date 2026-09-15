import {
  CalculateInvestmentPositionSchema,
  ValueInvestmentPositionSchema,
  ObservedInvestmentPositionSchema,
  type FinanceCurrency,
} from '@emdo/contracts';
import {
  DECIMAL_SCALE,
  parseFinanceDecimal,
  formatFinanceDecimal,
  currencyPrecision,
  convertBookAmount,
} from './decimal.js';

/** Opening snapshots are end-of-day quantities; only later movements are applied. */
export function calculateInvestmentPosition(input: unknown) {
  const data = CalculateInvestmentPositionSchema.parse(input);
  const identity = {
    financialAccountId: data.financialAccountId,
    instrumentId: data.instrumentId,
    asOf: data.asOf,
  };
  if (!data.opening)
    return {
      ...identity,
      status: 'unavailable' as const,
      quantity: null,
      reason: 'missing-opening' as const,
      sourceReferences: [] as string[],
      movementIds: [] as string[],
    };
  if (
    data.opening.financialAccountId !== data.financialAccountId ||
    data.opening.instrumentId !== data.instrumentId
  )
    throw new Error('finance-investment-opening-scope-mismatch');
  if (data.opening.asOf > data.asOf)
    throw new Error('finance-investment-opening-after-valuation');
  const seen = new Set<string>();
  let quantity = parseFinanceDecimal(data.opening.quantity);
  const sources = [data.opening.sourceReference],
    movementIds: string[] = [];
  for (const movement of data.movements) {
    if (
      movement.financialAccountId !== data.financialAccountId ||
      movement.instrumentId !== data.instrumentId
    )
      throw new Error('finance-investment-movement-scope-mismatch');
    if (seen.has(movement.id))
      throw new Error('finance-investment-duplicate-movement');
    seen.add(movement.id);
    if (
      movement.effectiveOn <= data.opening.asOf ||
      movement.effectiveOn > data.asOf
    )
      continue;
    quantity += parseFinanceDecimal(movement.quantity);
    sources.push(movement.sourceReference);
    movementIds.push(movement.id);
  }
  const canonical = formatFinanceDecimal(quantity);
  // Validate aggregate storage bounds, too, rather than silently overflowing at persistence.
  CalculateInvestmentPositionSchema.shape.opening
    .unwrap()
    .shape.quantity.parse(canonical);
  return {
    ...identity,
    status: 'available' as const,
    quantity: canonical,
    reason: null,
    sourceReferences: [...new Set(sources)],
    movementIds,
  };
}

function roundedProduct(
  quantity: string,
  price: string,
  multiplier: string,
  currency: FinanceCurrency,
) {
  const product =
    parseFinanceDecimal(quantity) *
    parseFinanceDecimal(price) *
    parseFinanceDecimal(multiplier);
  const unit = 10n ** BigInt(12 - currencyPrecision(currency)),
    divisor = DECIMAL_SCALE * DECIMAL_SCALE * unit;
  const absolute = product < 0n ? -product : product,
    rounded = ((absolute + divisor / 2n) / divisor) * unit;
  return formatFinanceDecimal(product < 0n ? -rounded : rounded);
}

/** Uses explicit, same-date observations. No latest-price, inverse-FX, or zero-value fallback. */
export function valueInvestmentPosition(input: unknown) {
  const data = ValueInvestmentPositionSchema.parse(input);
  const base = {
    financialAccountId: data.financialAccountId,
    instrumentId: data.instrumentId,
    asOf: data.asOf,
    quantity: data.quantity,
    functionalCurrency: data.functionalCurrency,
    valuationMultiplier: data.valuationMultiplier,
    rounding: 'half-away-from-zero-native-then-functional' as const,
  };
  const unavailable = (reason: string, nativeValue: string | null = null) => ({
    ...base,
    status: 'unavailable' as const,
    reason,
    nativeValue,
    nativeCurrency: data.price?.currency ?? null,
    functionalValue: null,
    priceId: data.price?.id ?? null,
    fxId: null as string | null,
    sourceReferences:
      nativeValue !== null && data.price ? [data.price.sourceReference] : [],
  });
  if (data.quantity === null) return unavailable('missing-calculated-position');
  if (!data.price) return unavailable('missing-price');
  if (data.price.instrumentId !== data.instrumentId)
    throw new Error('finance-investment-price-instrument-mismatch');
  if (data.price.asOf !== data.asOf) return unavailable('price-date-mismatch');
  const nativeValue = roundedProduct(
    data.quantity,
    data.price.price,
    data.valuationMultiplier,
    data.price.currency,
  );
  let functionalValue = nativeValue,
    fxId: string | null = null;
  const sources = [data.price.sourceReference];
  if (data.price.currency !== data.functionalCurrency) {
    if (!data.fx) return unavailable('missing-fx', nativeValue);
    if (
      data.fx.fromCurrency !== data.price.currency ||
      data.fx.toCurrency !== data.functionalCurrency
    )
      throw new Error('finance-investment-fx-direction-mismatch');
    if (data.fx.asOf !== data.asOf)
      return unavailable('fx-date-mismatch', nativeValue);
    functionalValue = convertBookAmount(
      nativeValue,
      data.fx.rate,
      data.functionalCurrency,
    );
    fxId = data.fx.id;
    sources.push(data.fx.sourceReference);
  }
  ValueInvestmentPositionSchema.shape.quantity.unwrap().parse(functionalValue);
  return {
    ...base,
    status: 'available' as const,
    reason: null,
    nativeValue,
    nativeCurrency: data.price.currency,
    functionalValue,
    priceId: data.price.id,
    fxId,
    sourceReferences: sources,
  };
}

/** An observed position never supplies the opening balance or changes the derived history. */
export function reconcileInvestmentPosition(
  observedInput: unknown,
  calculated: ReturnType<typeof calculateInvestmentPosition>,
) {
  const observed = ObservedInvestmentPositionSchema.parse(observedInput);
  if (
    observed.financialAccountId !== calculated.financialAccountId ||
    observed.instrumentId !== calculated.instrumentId ||
    observed.asOf !== calculated.asOf
  )
    throw new Error('finance-investment-reconciliation-scope-mismatch');
  const difference =
    calculated.quantity === null
      ? null
      : formatFinanceDecimal(
          parseFinanceDecimal(observed.quantity) -
            parseFinanceDecimal(calculated.quantity),
        );
  return {
    observedPositionId: observed.id,
    evidenceId: observed.evidenceId,
    sourceRow: observed.sourceRow,
    observedQuantity: observed.quantity,
    calculatedQuantity: calculated.quantity,
    difference,
    status:
      difference === null
        ? 'unavailable'
        : parseFinanceDecimal(difference) === 0n
          ? 'matched'
          : 'difference',
    calculationSources: calculated.sourceReferences,
  };
}

/** Exact split quantity. Fractional entitlements require an explicit subsequent treatment. */
export function splitInvestmentQuantity(
  quantity: string,
  numerator: string,
  denominator: string,
) {
  const q = parseFinanceDecimal(quantity),
    n = parseFinanceDecimal(numerator),
    d = parseFinanceDecimal(denominator);
  if (n <= 0n || d <= 0n)
    throw new Error('finance-investment-split-ratio-invalid');
  if ((q * n) % d !== 0n)
    throw new Error(
      'finance-investment-fractional-entitlement-review-required',
    );
  const result = formatFinanceDecimal((q * n) / d);
  ValueInvestmentPositionSchema.shape.quantity.unwrap().parse(result);
  return result;
}

/** A subtotal must never masquerade as a complete portfolio valuation. */
export function valueInvestmentPortfolio(inputs: readonly unknown[]) {
  if (!inputs.length || inputs.length > 100000)
    throw new Error('finance-investment-position-set-required');
  const positions = inputs.map(valueInvestmentPosition),
    first = positions[0]!;
  const identities = new Set<string>();
  let subtotal = 0n;
  for (const position of positions) {
    if (
      position.asOf !== first.asOf ||
      position.functionalCurrency !== first.functionalCurrency
    )
      throw new Error('finance-investment-valuation-scope-mismatch');
    const identity = `${position.financialAccountId}:${position.instrumentId}`;
    if (identities.has(identity))
      throw new Error('finance-investment-duplicate-position');
    identities.add(identity);
    if (position.functionalValue !== null)
      subtotal += parseFinanceDecimal(position.functionalValue);
  }
  const availableSubtotal = formatFinanceDecimal(subtotal);
  ValueInvestmentPositionSchema.shape.quantity
    .unwrap()
    .parse(availableSubtotal);
  const complete = positions.every((p) => p.status === 'available');
  return {
    asOf: first.asOf,
    currency: first.functionalCurrency,
    status: complete ? 'complete' : 'incomplete',
    total: complete ? availableSubtotal : null,
    availableSubtotal,
    unavailableCount: positions.filter((p) => p.status === 'unavailable')
      .length,
    positions,
  };
}

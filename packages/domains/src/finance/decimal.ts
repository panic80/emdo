import {
  FinanceDecimalSchema,
  FinanceMoneySchema,
  type FinanceCurrency,
} from '@emdo/contracts/browser';

export const DECIMAL_SCALE = 1_000_000_000_000n;

/** Fixed 12-place decimal arithmetic. No financial calculation uses binary floats. */
export function parseFinanceDecimal(value: string): bigint {
  FinanceDecimalSchema.parse(value);
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const result =
    BigInt(whole!) * DECIMAL_SCALE + BigInt(fraction.padEnd(12, '0'));
  return negative ? -result : result;
}
export function formatFinanceDecimal(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % DECIMAL_SCALE)
    .toString()
    .padStart(12, '0')
    .replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${absolute / DECIMAL_SCALE}${fraction ? `.${fraction}` : ''}`;
}
export function currencyPrecision(currency: FinanceCurrency): number {
  return currency === 'JPY' || currency === 'KRW' ? 0 : 2;
}
export function moneyValue(amount: string, currency: FinanceCurrency): bigint {
  FinanceMoneySchema.parse({ amount, currency });
  return parseFinanceDecimal(amount);
}
/** Explicit half-away-from-zero rounding for book valuation; tax packs own tax rounding. */
export function roundBookAmount(
  value: bigint,
  currency: FinanceCurrency,
): bigint {
  const unit = 10n ** BigInt(12 - currencyPrecision(currency));
  const absolute = value < 0n ? -value : value;
  const rounded = ((absolute + unit / 2n) / unit) * unit;
  return value < 0n ? -rounded : rounded;
}
export function convertBookAmount(
  amount: string,
  rate: string,
  currency: FinanceCurrency,
): string {
  const parsedRate = parseFinanceDecimal(rate);
  if (parsedRate <= 0n) throw new Error('finance-fx-rate-invalid');
  const native = parseFinanceDecimal(amount);
  const unit = 10n ** BigInt(12 - currencyPrecision(currency));
  const product = native * parsedRate;
  const divisor = DECIMAL_SCALE * unit;
  const absolute = product < 0n ? -product : product;
  const rounded = ((absolute + divisor / 2n) / divisor) * unit;
  return formatFinanceDecimal(product < 0n ? -rounded : rounded);
}

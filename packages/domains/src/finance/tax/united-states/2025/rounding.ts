/** IRS 2025 Form 1040 instructions, “Rounding Off to Whole Dollars”.
 * Only the explicitly elected nonnegative whole-dollar mode is implemented.
 * Sum original cents for an input line before rounding; never round individual receipts.
 * No binary floating point, locale parsing, or implicit rounding mode.
 */
export function usdCents(value: string): bigint {
  if (!/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/.test(value))
    throw new Error(
      'Expected a nonnegative USD decimal with at most two decimal places',
    );
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
export function roundNonnegativeRatio(
  numerator: bigint,
  denominator: bigint,
): bigint {
  if (numerator < 0n || denominator <= 0n)
    throw new Error('Unsupported rounding domain');
  return (numerator * 2n + denominator) / (denominator * 2n);
}
export function roundUsdLine(amounts: readonly string[]): string {
  return roundNonnegativeRatio(
    amounts.reduce((sum, value) => sum + usdCents(value), 0n),
    100n,
  ).toString();
}

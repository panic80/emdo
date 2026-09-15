/**
 * Exact rational arithmetic for the Mexico 2025 working-papers adapter.
 *
 * All input money is parsed from decimal text and remains a reduced rational
 * until a report field is emitted.  This keeps tariff calculations independent
 * of JavaScript floating point and makes every displayed value traceable to an
 * exact numerator and denominator.
 */
export type Q = { n: bigint; d: bigint };

export function q(n: bigint, d = 1n): Q {
  if (d <= 0n) throw new Error('nonpositive-denominator');
  if (n === 0n) return { n: 0n, d: 1n };
  let a = n < 0n ? -n : n;
  let b = d;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return { n: n / a, d: d / a };
}

export function decimal(
  value: string,
  options: { maxPlaces?: number } = {},
): Q {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    throw new Error('invalid-decimal');
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  if (options.maxPlaces !== undefined && fraction.length > options.maxPlaces)
    throw new Error('excess-decimal-places');
  const numerator = BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n);
  return q(numerator, 10n ** BigInt(fraction.length));
}

export const plus = (...values: Q[]): Q =>
  values.reduce((a, b) => q(a.n * b.d + b.n * a.d, a.d * b.d), q(0n));

export const minus = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);

export const times = (a: Q, numerator: bigint, denominator = 1n): Q =>
  q(a.n * numerator, a.d * denominator);

export const compare = (a: Q, b: Q): bigint => a.n * b.d - b.n * a.d;
export const lt = (a: Q, b: Q): boolean => compare(a, b) < 0n;
export const lte = (a: Q, b: Q): boolean => compare(a, b) <= 0n;
export const gt = (a: Q, b: Q): boolean => compare(a, b) > 0n;
export const gte = (a: Q, b: Q): boolean => compare(a, b) >= 0n;
export const positive = (a: Q): Q => (a.n < 0n ? q(0n) : a);
export const minimum = (a: Q, b: Q): Q => (lt(a, b) ? a : b);
export const maximum = (a: Q, b: Q): Q => (gt(a, b) ? a : b);

/** Half-up rounding for report display, including a symmetric negative path. */
export function roundHalfUp(value: Q): bigint {
  if (value.n < 0n) return -roundHalfUp(q(-value.n, value.d));
  return (value.n * 2n + value.d) / (2n * value.d);
}

export function serialize(value: Q) {
  return {
    numerator: value.n.toString(),
    denominator: value.d.toString(),
  };
}

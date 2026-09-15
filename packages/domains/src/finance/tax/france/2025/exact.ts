/**
 * Exact rational arithmetic for the France 2025-income / 2026-return
 * working-papers adapter. Monetary inputs are decimal strings and remain
 * rational until a statutory whole-euro reporting boundary is reached.
 */
export type Exact = { n: bigint; d: bigint };

function gcd(a: bigint, b: bigint): bigint {
  let left = a < 0n ? -a : a;
  let right = b < 0n ? -b : b;
  while (right !== 0n) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left || 1n;
}

export function q(n: bigint, d = 1n): Exact {
  if (d <= 0n) throw new Error('nonpositive-denominator');
  if (n === 0n) return { n: 0n, d: 1n };
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}

export function decimal(
  value: string,
  options: { maxPlaces?: number } = {},
): Exact {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    throw new Error('invalid-exact-decimal');
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  if (options.maxPlaces !== undefined && fraction.length > options.maxPlaces)
    throw new Error('excess-decimal-places');
  return q(
    BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n),
    10n ** BigInt(fraction.length),
  );
}

export const plus = (...values: Exact[]): Exact =>
  values.reduce(
    (left, right) => q(left.n * right.d + right.n * left.d, left.d * right.d),
    q(0n),
  );

export const minus = (left: Exact, right: Exact): Exact =>
  q(left.n * right.d - right.n * left.d, left.d * right.d);

export const times = (
  value: Exact,
  numerator: bigint,
  denominator = 1n,
): Exact => q(value.n * numerator, value.d * denominator);

export const compare = (left: Exact, right: Exact): bigint =>
  left.n * right.d - right.n * left.d;
export const lt = (left: Exact, right: Exact) => compare(left, right) < 0n;
export const lte = (left: Exact, right: Exact) => compare(left, right) <= 0n;
export const gt = (left: Exact, right: Exact) => compare(left, right) > 0n;
export const gte = (left: Exact, right: Exact) => compare(left, right) >= 0n;
export const positive = (value: Exact): Exact => (value.n < 0n ? q(0n) : value);
export const minimum = (left: Exact, right: Exact): Exact =>
  lt(left, right) ? left : right;
export const maximum = (left: Exact, right: Exact): Exact =>
  gt(left, right) ? left : right;

/** Half-up rounding to the nearest euro, including an explicit negative path. */
export function roundEuro(value: Exact): bigint {
  if (value.n < 0n) return -roundEuro(q(-value.n, value.d));
  return (value.n * 2n + value.d) / (2n * value.d);
}

export function rounded(value: Exact): Exact {
  return q(roundEuro(value));
}

export function serialize(value: Exact) {
  return {
    numerator: value.n.toString(),
    denominator: value.d.toString(),
  };
}

export function report(value: Exact): string {
  return roundEuro(value).toString();
}

/**
 * Exact arithmetic primitives for the Japan 2025 working-papers adapter.
 *
 * Monetary source values are decimal strings.  They are parsed as reduced
 * rationals and are never sent through JavaScript Number arithmetic.  The
 * bounded employment-only workflow subsequently requires whole JPY inputs,
 * as the NTA return and tax tables report yen amounts.
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

export function decimal(value: string): Q {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    throw new Error('invalid-decimal');
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  return q(
    BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n),
    10n ** BigInt(fraction.length),
  );
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

/** Mathematical floor, including the negative path. */
export function floor(a: Q): bigint {
  if (a.n >= 0n) return a.n / a.d;
  return -((-a.n + a.d - 1n) / a.d);
}

/** Floor a nonnegative working amount to the nearest whole yen. */
export function floorYen(a: Q): Q {
  return q(floor(positive(a)));
}

/** Floor a nonnegative working amount to the nearest thousand yen. */
export function floorThousandYen(a: Q): Q {
  return q((floor(positive(a)) / 1000n) * 1000n);
}

export function isWholeYen(a: Q): boolean {
  return a.d === 1n;
}

export function wholeYen(a: Q): bigint {
  if (!isWholeYen(a)) throw new Error('fractional-yen-not-supported');
  return a.n;
}

export function serialize(a: Q) {
  return { numerator: a.n.toString(), denominator: a.d.toString() };
}

export function format(a: Q): string {
  if (a.d === 1n) return a.n.toString();
  const sign = a.n < 0n ? '-' : '';
  const magnitude = a.n < 0n ? -a.n : a.n;
  const whole = magnitude / a.d;
  const remainder = magnitude % a.d;
  return `${sign}${whole.toString()}.${remainder.toString()}/${a.d.toString()}`;
}

/**
 * Exact arithmetic for the South Korea 2025 working-papers adapter.
 *
 * Korean tax amounts are expressed in won.  Source formulas can still produce
 * fractions when a reviewed test input contains sub-won decimal values, so the
 * graph keeps reduced BigInt rationals until a report line is emitted.  No
 * binary floating point or implicit JavaScript rounding is used.
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

/** Parse a nonnegative or signed decimal without passing through Number. */
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
export const maximum = (a: Q, b: Q): Q => (gt(a, b) ? a : b);

/**
 * NTS year-end forms report won amounts.  The form instructions discard the
 * fractional part of a displayed amount; retain the exact Q separately and
 * apply that rule only at the output boundary.
 */
export function truncateTowardZero(value: Q): bigint {
  return value.n / value.d;
}

/** Return a finite decimal when possible, otherwise the exact rational text. */
export function exactDecimal(value: Q): string {
  if (value.n === 0n) return '0';
  let denominator = value.d;
  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    twos++;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    fives++;
  }
  if (denominator !== 1n) return `${value.n.toString()}/${value.d.toString()}`;
  const places = Math.max(twos, fives);
  const magnitude = (value.n < 0n ? -value.n : value.n) * 10n ** BigInt(places);
  const digits = (magnitude / value.d).toString().padStart(places + 1, '0');
  const sign = value.n < 0n ? '-' : '';
  if (!places) return `${sign}${digits}`;
  const whole = digits.slice(0, -places) || '0';
  const fraction = digits.slice(-places).replace(/0+$/, '');
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

export function serialize(value: Q) {
  return {
    numerator: value.n.toString(),
    denominator: value.d.toString(),
    exactDecimal: exactDecimal(value),
  };
}

/**
 * Exact rational arithmetic for the Germany 2025 candidate.
 *
 * Input amounts are EUR decimals. Calculations stay in reduced BigInt
 * rationals until a statutory whole-euro or cent boundary is applied.
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
  if (d <= 0n) throw new Error('Nonpositive denominator');
  if (n === 0n) return { n: 0n, d: 1n };
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}

export function decimal(value: string): Exact {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    throw new Error('Invalid exact decimal');
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
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

export const times = (left: Exact, right: Exact): Exact =>
  q(left.n * right.n, left.d * right.d);

export const divide = (left: Exact, right: Exact): Exact => {
  if (right.n === 0n) throw new Error('Division by zero');
  return q(left.n * right.d, left.d * right.n);
};

export const compare = (left: Exact, right: Exact): bigint =>
  left.n * right.d - right.n * left.d;

export const lt = (left: Exact, right: Exact): boolean =>
  compare(left, right) < 0n;

export const lte = (left: Exact, right: Exact): boolean =>
  compare(left, right) <= 0n;

export const positive = (value: Exact): Exact => (value.n < 0n ? q(0n) : value);

export const minimum = (left: Exact, right: Exact): Exact =>
  lt(left, right) ? left : right;

export const maximum = (left: Exact, right: Exact): Exact =>
  lt(left, right) ? right : left;

/** Floors a nonnegative exact amount to whole EUR. */
export function floorEuros(value: Exact): Exact {
  if (value.n < 0n) throw new Error('Cannot floor negative amount');
  return q(value.n / value.d);
}

/** Floors a nonnegative exact amount to the requested EUR unit. */
export function floorToEurosUnit(value: Exact, unit: bigint): Exact {
  if (value.n < 0n || unit <= 0n) throw new Error('Invalid floor input');
  const units = (value.n / value.d / unit) * unit;
  return q(units);
}

/** Floors a nonnegative exact amount at the statutory two-decimal display. */
export function floorCents(value: Exact): Exact {
  if (value.n < 0n) throw new Error('Cannot floor negative amount');
  return q((value.n * 100n) / value.d, 100n);
}

/** Fixed two-decimal EUR representation, after an explicit cent floor. */
export function formatEuros(value: Exact): string {
  const rounded = floorCents(value);
  // The caller only uses this helper for nonnegative amounts. Keeping the
  // conversion here integer-only prevents a binary floating-point detour.
  const scaled = (rounded.n * 100n) / rounded.d;
  const euros = scaled / 100n;
  const minor = (scaled % 100n).toString().padStart(2, '0');
  return `${euros.toString()}.${minor}`;
}

/** Returns an exact amount serialized as a decimal with two EUR places. */
export function formatCents(value: Exact): string {
  return formatEuros(value);
}

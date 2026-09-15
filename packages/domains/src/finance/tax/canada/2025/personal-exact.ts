/** Exact arithmetic for connecting annual form dependencies; never rounds to a filing precision. */
export type PersonalExact = { n: bigint; d: bigint };
export function rational(n: bigint, d = 1n): PersonalExact {
  if (d <= 0n) throw Error('invalid-denominator');
  // Keep zero canonical. Without this special case, rational(0, 100)
  // serializes as 0/100 and produces a different trace/hash from 0/1 even
  // though both values are mathematically identical.
  if (n === 0n) return { n: 0n, d: 1n };
  let a = n < 0n ? -n : n,
    b = d;
  while (b) [a, b] = [b, a % b];
  return { n: n / a, d: d / a };
}
export function decimal(s: string): PersonalExact {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s))
    throw Error('invalid-exact-decimal');
  const negative = s.startsWith('-');
  const [w, f = ''] = (negative ? s.slice(1) : s).split('.');
  return rational(
    BigInt(w! + f) * (negative ? -1n : 1n),
    10n ** BigInt(f.length),
  );
}
export const plus = (...v: PersonalExact[]) =>
  v.reduce((a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d), rational(0n));
export const minus = (a: PersonalExact, b: PersonalExact) =>
  rational(a.n * b.d - b.n * a.d, a.d * b.d);
export const times = (a: PersonalExact, b: PersonalExact) =>
  rational(a.n * b.n, a.d * b.d);
export const compare = (a: PersonalExact, b: PersonalExact) =>
  a.n * b.d - b.n * a.d;
export const positive = (a: PersonalExact) => (a.n < 0n ? rational(0n) : a);
export const minimum = (a: PersonalExact, b: PersonalExact) =>
  compare(a, b) < 0n ? a : b;
export function serialize(a: PersonalExact) {
  // Callers may construct a PersonalExact from persisted evidence rather than
  // through rational(), so canonicalize here as well before hashing or
  // rendering its decimal form.
  a = rational(a.n, a.d);
  let d = a.d,
    twos = 0,
    fives = 0;
  while (d % 2n === 0n) {
    d /= 2n;
    twos++;
  }
  while (d % 5n === 0n) {
    d /= 5n;
    fives++;
  }
  let exactDecimal: string | null = null;
  if (d === 1n) {
    const places = Math.max(twos, fives),
      digits = (((a.n < 0n ? -a.n : a.n) * 10n ** BigInt(places)) / a.d)
        .toString()
        .padStart(places + 1, '0');
    exactDecimal =
      (a.n < 0n ? '-' : '') +
      (places
        ? `${digits.slice(0, -places)}.${digits.slice(-places)}`.replace(
            /\.?0+$/,
            '',
          )
        : digits);
  }
  return {
    exactRational: { numerator: a.n.toString(), denominator: a.d.toString() },
    exactDecimal,
  };
}

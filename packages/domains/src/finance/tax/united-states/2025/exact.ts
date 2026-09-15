/** Small exact arithmetic primitives used by this adapter's generic form graph. */
export type Q = { n: bigint; d: bigint };
export const q = (n: bigint, d = 1n): Q => {
  if (d <= 0n) throw new Error('Nonpositive denominator');
  let a = n < 0n ? -n : n;
  let b = d;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return { n: n / a, d: d / a };
};
export const plus = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
export const minus = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
export const times = (a: Q, n: bigint, d: bigint): Q => q(a.n * n, a.d * d);
export const lt = (a: Q, b: Q): boolean => a.n * b.d < b.n * a.d;
export const positive = (a: Q): Q => (a.n < 0n ? q(0n) : a);
export const minimum = (a: Q, b: Q): Q => (lt(a, b) ? a : b);

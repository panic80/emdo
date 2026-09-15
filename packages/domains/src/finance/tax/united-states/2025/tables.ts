import { IRS_SINGLE_TABLE_DATA as rawTableData } from './tables-data.js';
import { deepFreeze } from '@emdo/contracts';
const IRS_SINGLE_TABLE_DATA = deepFreeze(rawTableData);
import { q, times, minus, type Q } from './exact.js';
import { roundNonnegativeRatio } from './rounding.js';

function findRow(rows: readonly (readonly number[])[], amount: bigint) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (BigInt(rows[mid][1]) <= amount) lo = mid + 1;
    else hi = mid;
  }
  const row = rows[lo];
  if (!row || amount < BigInt(row[0]) || amount >= BigInt(row[1]))
    throw new Error('Uncovered table interval');
  return row;
}
/** Tax-table lookup uses the elected reported line15, as directed by the table header.
 * At $100,000 the published worksheet replaces the table; never use marginal rates below it.
 */
export function singleIncomeTax2025(taxable: Q) {
  const line15 = roundNonnegativeRatio(taxable.n, taxable.d);
  if (line15 < 100000n) {
    const row = findRow(IRS_SINGLE_TABLE_DATA.singleTax, line15);
    return {
      amount: q(BigInt(row[2])),
      method: 'tax-table' as const,
      lookupDollars: line15.toString(),
      interval: [row[0], row[1]],
    };
  }
  const bands = [
    [103350n, 22n, 508600n],
    [197300n, 24n, 715300n],
    [250525n, 32n, 2293700n],
    [626350n, 35n, 3045275n],
  ] as const;
  const band = bands.find(([max]) => line15 <= max);
  const rate = band?.[1] ?? 37n;
  const subtractionCents = band?.[2] ?? 4297975n;
  return {
    amount: minus(times(q(line15), rate, 100n), q(subtractionCents, 100n)),
    method: 'computation-worksheet' as const,
    lookupDollars: line15.toString(),
    interval: null,
  };
}
export function singleNoChildEic2025(earnings: Q): bigint {
  if (earnings.n <= 0n || earnings.n >= 19104n * earnings.d) return 0n;
  const lookup = roundNonnegativeRatio(earnings.n, earnings.d);
  if (lookup < 1n || lookup >= 19104n) return 0n;
  return BigInt(findRow(IRS_SINGLE_TABLE_DATA.singleNoChildEic, lookup)[2]);
}
export { IRS_SINGLE_TABLE_DATA };

import { deepFreeze } from '@emdo/contracts';
import {
  decimal,
  gte,
  lt,
  minimum,
  minus,
  plus,
  q,
  roundEuro,
  times,
  type Exact,
} from './exact.js';

/**
 * Barème 2026 applicable to income received in calendar year 2025. The
 * published simplified formula uses the constants below after dividing the
 * rounded net taxable income by the number of quotient-familial parts.
 */
export const FRANCE_2025_INCOME_TAX_SCALE = deepFreeze([
  { lower: '0', upper: '11600', ratePercent: '0', subtract: '0' },
  { lower: '11600', upper: '29579', ratePercent: '11', subtract: '1276' },
  {
    lower: '29579',
    upper: '84577',
    ratePercent: '30',
    subtract: '6896.01',
  },
  {
    lower: '84577',
    upper: '181917',
    ratePercent: '41',
    subtract: '16199.48',
  },
  {
    lower: '181917',
    upper: null,
    ratePercent: '45',
    subtract: '23476.16',
  },
] as const);

export type France2025ScaleRow = (typeof FRANCE_2025_INCOME_TAX_SCALE)[number];

/** Statutory 2025-income amounts, in euros. */
export const FRANCE_2025_LIMITS = deepFreeze({
  salaryDeductionMinimum: decimal('509'),
  salaryDeductionMaximum: decimal('14555'),
  quotientHalfPartCap: decimal('1807'),
  singleParentFirstChildPartCap: decimal('4262'),
  decoteSingleThreshold: decimal('1982'),
  decoteSingleFixedAmount: decimal('897'),
  decoteRateNumerator: 181n,
  decoteRateDenominator: 400n,
  collectionThreshold: decimal('61'),
});

function inScaleRow(value: Exact, row: France2025ScaleRow): boolean {
  const lower = decimal(row.lower);
  const upper = row.upper === null ? null : decimal(row.upper);
  // The published table states each finite upper limit as inclusive. The
  // overlapping lower endpoint of the next row is therefore intentionally
  // resolved by the first row returned by find().
  return gte(value, lower) && (upper === null || !lt(upper, value));
}

export function findFrance2025ScaleRow(value: Exact): France2025ScaleRow {
  const row = FRANCE_2025_INCOME_TAX_SCALE.find((candidate) =>
    inScaleRow(value, candidate),
  );
  if (!row) throw new Error('uncovered-france-2025-income-scale');
  return row;
}

/**
 * Applies the official per-part simplified formula. The caller supplies the
 * exact quotient; the returned amount is still exact until the final tax
 * rounding boundary.
 */
export function france2025TaxForOnePart(quotient: Exact): Exact {
  if (quotient.n <= 0n) return q(0n);
  const row = findFrance2025ScaleRow(quotient);
  return plus(
    times(quotient, BigInt(row.ratePercent), 100n),
    q(-decimal(row.subtract).n, decimal(row.subtract).d),
  );
}

/**
 * Progressive tax before quotient-family caps and decote. `parts` is encoded
 * as an exact rational so the bounded adapter can represent 1, 1.5 and 2.
 */
export function france2025ProgressiveTax(
  taxableIncome: Exact,
  parts: Exact,
): Exact {
  if (parts.n <= 0n) throw new Error('invalid-family-parts');
  return times(
    france2025TaxForOnePart(
      q(taxableIncome.n * parts.d, taxableIncome.d * parts.n),
    ),
    parts.n,
    parts.d,
  );
}

/** Whole-euro tax result used at each double-liquidation boundary. */
export function france2025RoundedProgressiveTax(
  taxableIncome: Exact,
  parts: Exact,
): bigint {
  return roundEuro(france2025ProgressiveTax(taxableIncome, parts));
}

export function france2025DecoteSingle(grossTax: bigint): bigint {
  if (grossTax < 0n) throw new Error('negative-gross-tax');
  if (grossTax >= roundEuro(FRANCE_2025_LIMITS.decoteSingleThreshold))
    return 0n;
  const reduction = minus(
    FRANCE_2025_LIMITS.decoteSingleFixedAmount,
    times(
      q(grossTax),
      FRANCE_2025_LIMITS.decoteRateNumerator,
      FRANCE_2025_LIMITS.decoteRateDenominator,
    ),
  );
  const roundedReduction = roundEuro(reduction);
  if (roundedReduction <= 0n) return 0n;
  return roundedReduction > grossTax ? grossTax : roundedReduction;
}

/**
 * Standard salary-expense deduction for one beneficiary. For remuneration
 * below the published minimum the deduction is capped at the remuneration;
 * from the minimum upward it is max(10%, minimum), capped at the maximum.
 */
export function france2025StandardSalaryDeduction(salary: Exact): Exact {
  if (salary.n < 0n) throw new Error('negative-salary');
  if (salary.n === 0n) return q(0n);
  if (lt(salary, FRANCE_2025_LIMITS.salaryDeductionMinimum)) return salary;
  return minimum(
    FRANCE_2025_LIMITS.salaryDeductionMaximum,
    // max(10% of salary, minimum)
    gte(times(salary, 10n, 100n), FRANCE_2025_LIMITS.salaryDeductionMinimum)
      ? times(salary, 10n, 100n)
      : FRANCE_2025_LIMITS.salaryDeductionMinimum,
  );
}

export const FRANCE_2025_DISPLAY = deepFreeze({
  taxScale: FRANCE_2025_INCOME_TAX_SCALE,
  rounding: 'nearest-euro-half-up',
  incomeYear: 2025,
  filingYear: 2026,
});

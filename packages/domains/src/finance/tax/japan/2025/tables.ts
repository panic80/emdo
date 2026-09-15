import { deepFreeze } from '@emdo/contracts';
import {
  floor,
  floorThousandYen,
  floorYen,
  minus,
  plus,
  positive,
  q,
  times,
  wholeYen,
  type Q,
} from './exact.js';

/**
 * Salary-income calculation table for calendar 2025 (Reiwa 7).
 *
 * The NTA table uses the lower gross-receipt bounds shown here.  In the two
 * middle ranges it first divides gross salary by four and drops the amount
 * below the next 1,000 yen, then applies the published multiplier.
 */
export const JAPAN_2025_SALARY_INCOME_TABLE = deepFreeze([
  {
    id: 'up-to-650999',
    lower: 0,
    upper: 650_999,
    calculation: 'zero-income',
  },
  {
    id: '651000-to-1899999',
    lower: 651_000,
    upper: 1_899_999,
    calculation: 'gross-minus-650000',
  },
  {
    id: '1900000-to-3599999',
    lower: 1_900_000,
    upper: 3_599_999,
    calculation: 'floor(gross/4,1000)*2.8-minus-80000',
  },
  {
    id: '3600000-to-6599999',
    lower: 3_600_000,
    upper: 6_599_999,
    calculation: 'floor(gross/4,1000)*3.2-minus-440000',
  },
  {
    id: '6600000-to-8499999',
    lower: 6_600_000,
    upper: 8_499_999,
    calculation: 'floor(gross*0.9)-1100000',
  },
  {
    id: 'at-least-8500000',
    lower: 8_500_000,
    upper: null,
    calculation: 'gross-minus-1950000',
  },
] as const);

export type Japan2025SalaryIncomeRow =
  (typeof JAPAN_2025_SALARY_INCOME_TABLE)[number];

/** Published 2025 resident basic deduction amounts by total income. */
export const JAPAN_2025_BASIC_DEDUCTION_TABLE = deepFreeze([
  { lower: 0, upper: 1_320_000, amount: 950_000 },
  { lower: 1_320_001, upper: 3_360_000, amount: 880_000 },
  { lower: 3_360_001, upper: 4_890_000, amount: 680_000 },
  { lower: 4_890_001, upper: 6_550_000, amount: 630_000 },
  { lower: 6_550_001, upper: 23_500_000, amount: 580_000 },
  { lower: 23_500_001, upper: 24_000_000, amount: 480_000 },
  { lower: 24_000_001, upper: 24_500_000, amount: 320_000 },
  { lower: 24_500_001, upper: 25_000_000, amount: 160_000 },
  { lower: 25_000_001, upper: null, amount: 0 },
] as const);

export type Japan2025BasicDeductionRow =
  (typeof JAPAN_2025_BASIC_DEDUCTION_TABLE)[number];

/**
 * NTA quick-calculation table for national income tax.  The lower and upper
 * bounds are inclusive in the published table.  Taxable income is rounded
 * down to 1,000 yen before this lookup.
 */
export const JAPAN_2025_NATIONAL_TAX_TABLE = deepFreeze([
  { lower: 0, upper: 0, rateNumerator: 0, subtraction: 0 },
  { lower: 1_000, upper: 1_949_000, rateNumerator: 5, subtraction: 0 },
  {
    lower: 1_950_000,
    upper: 3_299_000,
    rateNumerator: 10,
    subtraction: 97_500,
  },
  {
    lower: 3_300_000,
    upper: 6_949_000,
    rateNumerator: 20,
    subtraction: 427_500,
  },
  {
    lower: 6_950_000,
    upper: 8_999_000,
    rateNumerator: 23,
    subtraction: 636_000,
  },
  {
    lower: 9_000_000,
    upper: 17_999_000,
    rateNumerator: 33,
    subtraction: 1_536_000,
  },
  {
    lower: 18_000_000,
    upper: 39_999_000,
    rateNumerator: 40,
    subtraction: 2_796_000,
  },
  {
    lower: 40_000_000,
    upper: null,
    rateNumerator: 45,
    subtraction: 4_796_000,
  },
] as const);

export type Japan2025NationalTaxRow =
  (typeof JAPAN_2025_NATIONAL_TAX_TABLE)[number];

const rowForSalary = (gross: bigint): Japan2025SalaryIncomeRow => {
  const row = JAPAN_2025_SALARY_INCOME_TABLE.find(
    (candidate) =>
      gross >= BigInt(candidate.lower) &&
      (candidate.upper === null || gross <= BigInt(candidate.upper)),
  );
  if (!row) throw new Error('uncovered-salary-income-range');
  return row;
};

/** Apply the NTA 2025 salary-income table to a whole-yen gross amount. */
export function salaryIncome2025(grossInput: Q) {
  const gross = wholeYen(grossInput);
  if (gross < 0n) throw new Error('negative-salary-gross');
  const row = rowForSalary(gross);
  let income: bigint;
  switch (row.id) {
    case 'up-to-650999':
      income = 0n;
      break;
    case '651000-to-1899999':
      income = gross - 650_000n;
      break;
    case '1900000-to-3599999': {
      const b = (gross / 4n / 1_000n) * 1_000n;
      income = (b * 14n) / 5n - 80_000n;
      break;
    }
    case '3600000-to-6599999': {
      const b = (gross / 4n / 1_000n) * 1_000n;
      income = (b * 16n) / 5n - 440_000n;
      break;
    }
    case '6600000-to-8499999':
      income = (gross * 9n) / 10n - 1_100_000n;
      break;
    case 'at-least-8500000':
      income = gross - 1_950_000n;
      break;
  }
  const salaryIncome = q(income);
  return {
    row,
    gross: q(gross),
    income: salaryIncome,
    /** Effective amount removed from gross for this salary-income result. */
    effectiveDeduction: minus(q(gross), salaryIncome),
  };
}

/** Look up the 2025 resident basic deduction from total income. */
export function basicDeduction2025(totalIncomeInput: Q) {
  const totalIncome = wholeYen(positive(totalIncomeInput));
  const row = JAPAN_2025_BASIC_DEDUCTION_TABLE.find(
    (candidate) =>
      totalIncome >= BigInt(candidate.lower) &&
      (candidate.upper === null || totalIncome <= BigInt(candidate.upper)),
  );
  if (!row) throw new Error('uncovered-basic-deduction-range');
  return { row, amount: q(BigInt(row.amount)) };
}

const taxRowFor = (taxableIncome: bigint): Japan2025NationalTaxRow => {
  const row = JAPAN_2025_NATIONAL_TAX_TABLE.find(
    (candidate) =>
      taxableIncome >= BigInt(candidate.lower) &&
      (candidate.upper === null || taxableIncome <= BigInt(candidate.upper)),
  );
  if (!row) throw new Error('uncovered-national-tax-range');
  return row;
};

/** Apply the NTA 2025 national income-tax quick-calculation table. */
export function nationalIncomeTax2025(taxableIncomeInput: Q) {
  const roundedBase = floorThousandYen(positive(taxableIncomeInput));
  const taxableIncome = wholeYen(roundedBase);
  const row = taxRowFor(taxableIncome);
  const amount =
    taxableIncome === 0n
      ? q(0n)
      : floorYen(
          minus(
            times(q(taxableIncome), BigInt(row.rateNumerator), 100n),
            q(BigInt(row.subtraction)),
          ),
        );
  return { row, taxableIncome: roundedBase, amount };
}

/** 2.1% reconstruction surtax, truncating fractions below one yen. */
export function reconstructionSurtax2025(baseIncomeTaxInput: Q): Q {
  return floorYen(times(positive(baseIncomeTaxInput), 21n, 1_000n));
}

/**
 * Apply the return's positive-assessment rule: amounts owing are truncated
 * below 100 yen; a negative result (refund) is retained as signed yen.
 */
export function declaredAssessment2025(rawAssessmentInput: Q): Q {
  if (rawAssessmentInput.n < 0n) return rawAssessmentInput;
  return q((floor(rawAssessmentInput) / 100n) * 100n);
}

/** Convenience helper for independent tests and downstream working papers. */
export function calculateJapan2025NationalTaxes(taxableIncomeInput: Q) {
  const national = nationalIncomeTax2025(taxableIncomeInput);
  const reconstruction = reconstructionSurtax2025(national.amount);
  return {
    taxableIncome: national.taxableIncome,
    baseIncomeTax: national.amount,
    reconstructionSurtax: reconstruction,
    combinedTax: plus(national.amount, reconstruction),
    row: national.row,
  };
}

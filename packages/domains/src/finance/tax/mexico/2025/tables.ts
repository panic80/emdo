import { deepFreeze } from '@emdo/contracts';
import { decimal, gte, lte, minus, plus, q, times, type Q } from './exact.js';

/**
 * Anexo 8 RMF 2025, section C(II), the annual tariff referred to by LISR
 * articles 97 and 152.  Limits and fixed amounts are intentionally retained
 * as decimal strings so the source table is not converted through a float.
 */
export const MEXICO_2025_ANNUAL_TARIFF = deepFreeze([
  { lower: '0.01', upper: '8952.49', fixed: '0.00', ratePercent: '1.92' },
  {
    lower: '8952.50',
    upper: '75984.55',
    fixed: '171.88',
    ratePercent: '6.40',
  },
  {
    lower: '75984.56',
    upper: '133536.07',
    fixed: '4461.94',
    ratePercent: '10.88',
  },
  {
    lower: '133536.08',
    upper: '155229.80',
    fixed: '10723.55',
    ratePercent: '16.00',
  },
  {
    lower: '155229.81',
    upper: '185852.57',
    fixed: '14194.54',
    ratePercent: '17.92',
  },
  {
    lower: '185852.58',
    upper: '374837.88',
    fixed: '19682.13',
    ratePercent: '21.36',
  },
  {
    lower: '374837.89',
    upper: '590795.99',
    fixed: '60049.40',
    ratePercent: '23.52',
  },
  {
    lower: '590796.00',
    upper: '1127926.84',
    fixed: '110842.74',
    ratePercent: '30.00',
  },
  {
    lower: '1127926.85',
    upper: '1503902.46',
    fixed: '271981.99',
    ratePercent: '32.00',
  },
  {
    lower: '1503902.47',
    upper: '4511707.37',
    fixed: '392294.17',
    ratePercent: '34.00',
  },
  {
    lower: '4511707.38',
    upper: null,
    fixed: '1414947.85',
    ratePercent: '35.00',
  },
] as const);

export type Mexico2025AnnualTariffRow =
  (typeof MEXICO_2025_ANNUAL_TARIFF)[number];

const zero = q(0n);

function inRow(amount: Q, row: Mexico2025AnnualTariffRow): boolean {
  const lower = decimal(row.lower);
  return (
    gte(amount, lower) &&
    (row.upper === null || lte(amount, decimal(row.upper)))
  );
}

/**
 * Apply the published annual tariff to an exact taxable base.  The last row is
 * open ended.  The source table displays inclusive two-decimal boundaries; the
 * implementation therefore treats a value equal to an upper boundary as part
 * of that row and the next representable cent as part of the next row.
 */
export function findMexico2025AnnualTariffRow(
  taxableBase: Q,
): Mexico2025AnnualTariffRow | null {
  if (taxableBase.n <= 0n) return null;
  const row = MEXICO_2025_ANNUAL_TARIFF.find((candidate) =>
    inRow(taxableBase, candidate),
  );
  if (!row) throw new Error('uncovered-annual-tariff');
  return row;
}

export function mexico2025AnnualIsr(taxableBase: Q): {
  tax: Q;
  row: Mexico2025AnnualTariffRow | null;
} {
  const row = findMexico2025AnnualTariffRow(taxableBase);
  if (!row) return { tax: zero, row: null };
  const lower = decimal(row.lower);
  const fixed = decimal(row.fixed);
  // ratePercent / 100 is the rate over the lower-limit excess.
  const tax = plus(
    fixed,
    times(
      minus(taxableBase, lower),
      decimal(row.ratePercent).n,
      decimal(row.ratePercent).d * 100n,
    ),
  );
  return { tax, row };
}

/** 2025 UMA values published by INEGI in the DOF notice effective 1 Feb 2025. */
export const MEXICO_2025_UMA = deepFreeze({
  daily: decimal('113.14'),
  monthly: decimal('3439.46'),
  annual: decimal('41273.52'),
  annualFiveTimes: decimal('206367.60'),
});

/**
 * General Article 151 cap.  The source says the lesser of five annual UMA or
 * 15% of total income including income that is not taxed.  The adapter only
 * accepts a general capped personal-deduction bucket; category-specific and
 * uncapped Article 151 cases remain explicit blockers in the workflow.
 */
export function mexico2025PersonalDeductionCap(totalIncome: Q): Q {
  return q(
    MEXICO_2025_UMA.annualFiveTimes.n * totalIncome.d <
      totalIncome.n * MEXICO_2025_UMA.annualFiveTimes.d
      ? MEXICO_2025_UMA.annualFiveTimes.n * totalIncome.d
      : totalIncome.n * MEXICO_2025_UMA.annualFiveTimes.d,
    MEXICO_2025_UMA.annualFiveTimes.d * totalIncome.d,
  );
}

export type Mexico2025SubsidyMonth = 'january' | 'february-to-december';

export const MEXICO_2025_EMPLOYMENT_SUBSIDY = deepFreeze({
  monthlyIncomeLimit: decimal('10171.00'),
  januaryUma2024Monthly: decimal('3300.53'),
  januaryRatePercent: decimal('14.39'),
  februaryToDecemberRatePercent: decimal('13.80'),
});

/**
 * Employment subsidy decree: January is 14.39% of the 2024 monthly UMA and
 * February through December are 13.8% of the 2025 monthly UMA.  Eligibility is
 * intentionally supplied by reviewed payroll facts; this helper only computes
 * the published amount for an eligible month.
 */
export function mexico2025EmploymentSubsidy(month: Mexico2025SubsidyMonth): Q {
  if (month === 'january')
    return times(
      MEXICO_2025_EMPLOYMENT_SUBSIDY.januaryUma2024Monthly,
      MEXICO_2025_EMPLOYMENT_SUBSIDY.januaryRatePercent.n,
      MEXICO_2025_EMPLOYMENT_SUBSIDY.januaryRatePercent.d * 100n,
    );
  return times(
    MEXICO_2025_UMA.monthly,
    MEXICO_2025_EMPLOYMENT_SUBSIDY.februaryToDecemberRatePercent.n,
    MEXICO_2025_EMPLOYMENT_SUBSIDY.februaryToDecemberRatePercent.d * 100n,
  );
}

export const MEXICO_2025_MONTHLY_EMPLOYMENT_SUBSIDY = deepFreeze({
  january: mexico2025EmploymentSubsidy('january'),
  februaryToDecember: mexico2025EmploymentSubsidy('february-to-december'),
  annualJanuaryPlusEleven: plus(
    mexico2025EmploymentSubsidy('january'),
    times(mexico2025EmploymentSubsidy('february-to-december'), 11n),
  ),
});

/** The published monthly employee tariff is useful for evidence/coverage. */
export const MEXICO_2025_MONTHLY_TARIFF_REFERENCE = deepFreeze([
  ['0.01', '746.04', '0.00', '1.92'],
  ['746.05', '6332.05', '14.32', '6.40'],
  ['6332.06', '11128.01', '371.83', '10.88'],
  ['11128.02', '12935.82', '893.63', '16.00'],
  ['12935.83', '15487.71', '1182.88', '17.92'],
  ['15487.72', '31236.49', '1640.18', '21.36'],
  ['31236.50', '49233.00', '5004.12', '23.52'],
  ['49233.01', '93993.90', '9236.89', '30.00'],
  ['93993.91', '125325.20', '22665.17', '32.00'],
  ['125325.21', '375975.61', '32691.18', '34.00'],
  ['375975.62', null, '117912.32', '35.00'],
] as const);

export type Mexico2025MonthlyTariffRow =
  (typeof MEXICO_2025_MONTHLY_TARIFF_REFERENCE)[number];

function monthlyRowContains(
  amount: Q,
  row: Mexico2025MonthlyTariffRow,
): boolean {
  const [lowerText, upperText] = row;
  if (typeof lowerText !== 'string') throw new Error('invalid-monthly-lower');
  const lower = decimal(lowerText);
  return (
    gte(amount, lower) &&
    (upperText === null || lte(amount, decimal(upperText)))
  );
}

/**
 * Apply the monthly employee withholding tariff in Anexo 8 section V.  The
 * caller supplies the monthly salary base after any Article 96 local-salary
 * tax deduction; payroll totals are not inferred from an annual amount.
 */
export function mexico2025MonthlySalaryIsr(monthlyTaxableBase: Q): {
  tax: Q;
  row: Mexico2025MonthlyTariffRow | null;
} {
  if (monthlyTaxableBase.n <= 0n) return { tax: q(0n), row: null };
  const row = MEXICO_2025_MONTHLY_TARIFF_REFERENCE.find((candidate) =>
    monthlyRowContains(monthlyTaxableBase, candidate),
  );
  if (!row) throw new Error('uncovered-monthly-tariff');
  const lowerText = row[0];
  const fixedText = row[2];
  const rateText = row[3];
  if (
    typeof lowerText !== 'string' ||
    typeof fixedText !== 'string' ||
    typeof rateText !== 'string'
  )
    throw new Error('invalid-monthly-tariff-row');
  const lower = decimal(lowerText);
  const fixed = decimal(fixedText);
  return {
    tax: plus(
      fixed,
      times(
        minus(monthlyTaxableBase, lower),
        decimal(rateText).n,
        decimal(rateText).d * 100n,
      ),
    ),
    row,
  };
}

export const mexico2025MonthlyEmployeeWithholding = mexico2025MonthlySalaryIsr;

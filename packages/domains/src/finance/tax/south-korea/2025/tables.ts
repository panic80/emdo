import { deepFreeze } from '@emdo/contracts';
import {
  decimal,
  lte,
  minus,
  maximum,
  minimum,
  plus,
  positive,
  q,
  times,
  type Q,
} from './exact.js';

/**
 * Article 47 of the Income Tax Act as reproduced in the NTS 2025 year-end
 * settlement guide (amounts in KRW).  The upper bound is inclusive, matching
 * the published wording.  Adjacent formulas are continuous at every bound.
 */
export const SOUTH_KOREA_2025_EARNED_INCOME_DEDUCTION_BANDS = deepFreeze([
  {
    id: 'up-to-5-million',
    upper: '5000000',
    base: '0',
    rateNumerator: '70',
    rateDenominator: '100',
    formula: '70% of total salary',
  },
  {
    id: 'over-5-to-15-million',
    upper: '15000000',
    base: '3500000',
    threshold: '5000000',
    rateNumerator: '40',
    rateDenominator: '100',
    formula: '3,500,000 + 40% of amount over 5,000,000',
  },
  {
    id: 'over-15-to-45-million',
    upper: '45000000',
    base: '7500000',
    threshold: '15000000',
    rateNumerator: '15',
    rateDenominator: '100',
    formula: '7,500,000 + 15% of amount over 15,000,000',
  },
  {
    id: 'over-45-to-100-million',
    upper: '100000000',
    base: '12000000',
    threshold: '45000000',
    rateNumerator: '5',
    rateDenominator: '100',
    formula: '12,000,000 + 5% of amount over 45,000,000',
  },
  {
    id: 'over-100-million',
    upper: null,
    base: '14750000',
    threshold: '100000000',
    rateNumerator: '2',
    rateDenominator: '100',
    formula: '14,750,000 + 2% of amount over 100,000,000',
  },
] as const);

export type SouthKorea2025EarnedIncomeDeductionBand =
  (typeof SOUTH_KOREA_2025_EARNED_INCOME_DEDUCTION_BANDS)[number];

/** Income tax rate table for global income attributable to 2025. */
export const SOUTH_KOREA_2025_INCOME_TAX_BANDS = deepFreeze([
  {
    id: 'up-to-14-million',
    lower: '0',
    upper: '14000000',
    fixed: '0',
    rateNumerator: '6',
    rateDenominator: '100',
    formula: '6% of tax base',
  },
  {
    id: 'over-14-to-50-million',
    lower: '14000000',
    upper: '50000000',
    fixed: '840000',
    rateNumerator: '15',
    rateDenominator: '100',
    formula: '840,000 + 15% of amount over 14,000,000',
  },
  {
    id: 'over-50-to-88-million',
    lower: '50000000',
    upper: '88000000',
    fixed: '6240000',
    rateNumerator: '24',
    rateDenominator: '100',
    formula: '6,240,000 + 24% of amount over 50,000,000',
  },
  {
    id: 'over-88-to-150-million',
    lower: '88000000',
    upper: '150000000',
    fixed: '15360000',
    rateNumerator: '35',
    rateDenominator: '100',
    formula: '15,360,000 + 35% of amount over 88,000,000',
  },
  {
    id: 'over-150-to-300-million',
    lower: '150000000',
    upper: '300000000',
    fixed: '37060000',
    rateNumerator: '38',
    rateDenominator: '100',
    formula: '37,060,000 + 38% of amount over 150,000,000',
  },
  {
    id: 'over-300-to-500-million',
    lower: '300000000',
    upper: '500000000',
    fixed: '94060000',
    rateNumerator: '40',
    rateDenominator: '100',
    formula: '94,060,000 + 40% of amount over 300,000,000',
  },
  {
    id: 'over-500-million-to-1-billion',
    lower: '500000000',
    upper: '1000000000',
    fixed: '174060000',
    rateNumerator: '42',
    rateDenominator: '100',
    formula: '174,060,000 + 42% of amount over 500,000,000',
  },
  {
    id: 'over-1-billion',
    lower: '1000000000',
    upper: null,
    fixed: '384060000',
    rateNumerator: '45',
    rateDenominator: '100',
    formula: '384,060,000 + 45% of amount over 1,000,000,000',
  },
] as const);

export type SouthKorea2025IncomeTaxBand =
  (typeof SOUTH_KOREA_2025_INCOME_TAX_BANDS)[number];

export const SOUTH_KOREA_2025_BASIC_PERSONAL_DEDUCTION = decimal('1500000');
export const SOUTH_KOREA_2025_STANDARD_TAX_CREDIT = decimal('130000');
/**
 * The ordinary global-income Form 40(1) branch uses the NTS standard credit
 * of KRW 70,000 when no wage-income standard-credit branch is selected.
 */
export const SOUTH_KOREA_2025_GLOBAL_STANDARD_TAX_CREDIT = decimal('70000');
export const SOUTH_KOREA_2025_EARNED_TAX_CREDIT_RATE_BELOW_THRESHOLD = q(
  55n,
  100n,
);
export const SOUTH_KOREA_2025_EARNED_TAX_CREDIT_RATE_ABOVE_THRESHOLD = q(
  30n,
  100n,
);
export const SOUTH_KOREA_2025_EARNED_TAX_CREDIT_THRESHOLD = decimal('1300000');

/** Published 2025 corporate income-tax rates for a domestic profit-making corporation. */
export const SOUTH_KOREA_2025_CORPORATE_TAX_BANDS = deepFreeze([
  {
    id: 'up-to-200-million',
    lower: '0',
    upper: '200000000',
    fixed: '0',
    rateNumerator: '9',
    rateDenominator: '100',
    formula: '9% of corporate tax base',
  },
  {
    id: 'over-200-million-to-20-billion',
    lower: '200000000',
    upper: '20000000000',
    fixed: '18000000',
    rateNumerator: '19',
    rateDenominator: '100',
    formula: '18,000,000 + 19% of amount over 200,000,000',
  },
  {
    id: 'over-20-billion-to-300-billion',
    lower: '20000000000',
    upper: '300000000000',
    fixed: '3780000000',
    rateNumerator: '21',
    rateDenominator: '100',
    formula: '3,780,000,000 + 21% of amount over 20,000,000,000',
  },
  {
    id: 'over-300-billion',
    lower: '300000000000',
    upper: null,
    fixed: '62580000000',
    rateNumerator: '24',
    rateDenominator: '100',
    formula: '62,580,000,000 + 24% of amount over 300,000,000,000',
  },
] as const);

export type SouthKorea2025CorporateTaxBand =
  (typeof SOUTH_KOREA_2025_CORPORATE_TAX_BANDS)[number];

export function findSouthKorea2025CorporateTaxBand(
  taxBase: Q,
): SouthKorea2025CorporateTaxBand {
  if (taxBase.n < 0n) throw new Error('negative-corporate-tax-base');
  const band = SOUTH_KOREA_2025_CORPORATE_TAX_BANDS.find(
    (candidate) =>
      candidate.upper === null || lte(taxBase, decimal(candidate.upper)),
  );
  if (!band) throw new Error('uncovered-corporate-tax-band');
  return band;
}

export function southKorea2025CorporateIncomeTax(taxBase: Q): {
  amount: Q;
  band: SouthKorea2025CorporateTaxBand;
} {
  const band = findSouthKorea2025CorporateTaxBand(taxBase);
  const amount = plus(
    decimal(band.fixed),
    times(
      positive(minus(taxBase, decimal(band.lower))),
      BigInt(band.rateNumerator),
      BigInt(band.rateDenominator),
    ),
  );
  return { amount, band };
}

/** Find the earned-income deduction band and preserve its exact formula inputs. */
export function findSouthKorea2025EarnedIncomeDeductionBand(
  totalSalary: Q,
): SouthKorea2025EarnedIncomeDeductionBand {
  if (totalSalary.n < 0n) throw new Error('negative-total-salary');
  const band = SOUTH_KOREA_2025_EARNED_INCOME_DEDUCTION_BANDS.find(
    (candidate) =>
      candidate.upper === null || lte(totalSalary, decimal(candidate.upper)),
  );
  if (!band) throw new Error('uncovered-earned-income-deduction');
  return band;
}

export function southKorea2025EarnedIncomeDeduction(totalSalary: Q): {
  amount: Q;
  uncapped: Q;
  band: SouthKorea2025EarnedIncomeDeductionBand;
} {
  const band = findSouthKorea2025EarnedIncomeDeductionBand(totalSalary);
  const threshold = decimal('threshold' in band ? band.threshold : '0');
  const uncapped = plus(
    decimal(band.base),
    times(
      positive(minus(totalSalary, threshold)),
      BigInt(band.rateNumerator),
      BigInt(band.rateDenominator),
    ),
  );
  // Article 47 caps the deduction at KRW 20,000,000.
  const amount = minimum(uncapped, decimal('20000000'));
  return { amount, uncapped, band };
}

/** Find the progressive global-income tax band for an exact nonnegative base. */
export function findSouthKorea2025IncomeTaxBand(
  taxBase: Q,
): SouthKorea2025IncomeTaxBand {
  if (taxBase.n < 0n) throw new Error('negative-tax-base');
  const band = SOUTH_KOREA_2025_INCOME_TAX_BANDS.find(
    (candidate) =>
      candidate.upper === null || lte(taxBase, decimal(candidate.upper)),
  );
  if (!band) throw new Error('uncovered-income-tax-band');
  return band;
}

export function southKorea2025IncomeTax(taxBase: Q): {
  amount: Q;
  band: SouthKorea2025IncomeTaxBand;
} {
  const band = findSouthKorea2025IncomeTaxBand(taxBase);
  const lower = decimal(band.lower);
  const amount = plus(
    decimal(band.fixed),
    times(
      positive(minus(taxBase, lower)),
      BigInt(band.rateNumerator),
      BigInt(band.rateDenominator),
    ),
  );
  return { amount, band };
}

/**
 * Article 59 earned-income tax credit.  The returned cap is calculated from
 * total salary, then the smaller of the statutory preliminary credit and cap is
 * used.  All thresholds are exact KRW amounts.
 */
export function southKorea2025EarnedIncomeTaxCredit(
  totalSalary: Q,
  calculatedTax: Q,
): {
  amount: Q;
  preliminary: Q;
  cap: Q;
} {
  const preliminary = lte(
    calculatedTax,
    SOUTH_KOREA_2025_EARNED_TAX_CREDIT_THRESHOLD,
  )
    ? times(calculatedTax, 55n, 100n)
    : plus(
        decimal('715000'),
        times(
          minus(calculatedTax, SOUTH_KOREA_2025_EARNED_TAX_CREDIT_THRESHOLD),
          30n,
          100n,
        ),
      );

  const cap =
    totalSalary.n <= 0n
      ? q(0n)
      : lte(totalSalary, decimal('33000000'))
        ? decimal('740000')
        : lte(totalSalary, decimal('70000000'))
          ? maximum(
              decimal('660000'),
              minus(
                decimal('740000'),
                times(minus(totalSalary, decimal('33000000')), 8n, 1000n),
              ),
            )
          : lte(totalSalary, decimal('120000000'))
            ? maximum(
                decimal('500000'),
                minus(
                  decimal('660000'),
                  times(minus(totalSalary, decimal('70000000')), 1n, 2n),
                ),
              )
            : maximum(
                decimal('200000'),
                minus(
                  decimal('500000'),
                  times(minus(totalSalary, decimal('120000000')), 1n, 2n),
                ),
              );

  return { amount: minimum(positive(preliminary), cap), preliminary, cap };
}

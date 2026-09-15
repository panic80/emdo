import { deepFreeze } from '@emdo/contracts';
import {
  decimal,
  exactDecimal,
  positive,
  q,
  times,
  truncateTowardZero,
  type Q,
} from './exact.js';
import { SOUTH_KOREA_2025_SOURCES } from './sources.js';

/**
 * NTS describes individual and corporate local income tax as 10% of the
 * related income-tax amount.  This is a national rule; the local authority
 * and filing/submission mechanics remain outside this package.
 */
export const SOUTH_KOREA_2025_LOCAL_INCOME_TAX_RATE = q(1n, 10n);
export const SOUTH_KOREA_2025_LOCAL_INCOME_TAX_SOURCE_ID =
  'nts-kr-2025-local-income-tax-guide' as const;

export type SouthKorea2025LocalTaxResult = {
  readonly taxKind: 'individual' | 'corporate';
  readonly nationalIncomeTax: string;
  readonly exactNumerator: string;
  readonly exactDenominator: string;
  readonly exactAmount: string;
  readonly reportableAmount: string;
  readonly reportedWon: string;
  readonly rateNumerator: string;
  readonly rateDenominator: string;
  readonly sourceId: typeof SOUTH_KOREA_2025_LOCAL_INCOME_TAX_SOURCE_ID;
  readonly sourceHash: string;
};

function asQ(value: Q | string): Q {
  return typeof value === 'string' ? decimal(value) : value;
}

/**
 * Calculate local income tax from a nonnegative national income-tax amount.
 * The amount is deliberately not rounded before multiplication.  The NTS
 * form's whole-won presentation is applied only to `reportedWon`.
 */
export function southKorea2025LocalIncomeTax(nationalIncomeTax: Q | string): Q {
  return times(positive(asQ(nationalIncomeTax)), 1n, 10n);
}

/** Return exact and whole-won local tax fields for a salary or corporation run. */
export function reportSouthKorea2025LocalIncomeTax(
  nationalIncomeTax: Q | string,
  taxKind: 'individual' | 'corporate' = 'individual',
): SouthKorea2025LocalTaxResult {
  const national = positive(asQ(nationalIncomeTax));
  const amount = southKorea2025LocalIncomeTax(national);
  const reportedWon = truncateTowardZero(amount).toString();
  const source = SOUTH_KOREA_2025_SOURCES.find(
    (candidate) => candidate.id === SOUTH_KOREA_2025_LOCAL_INCOME_TAX_SOURCE_ID,
  );
  if (!source) throw new Error('missing-south-korea-local-tax-source');
  return deepFreeze({
    taxKind,
    nationalIncomeTax: exactDecimal(national),
    exactNumerator: amount.n.toString(),
    exactDenominator: amount.d.toString(),
    exactAmount: exactDecimal(amount),
    reportableAmount: reportedWon,
    reportedWon,
    rateNumerator: SOUTH_KOREA_2025_LOCAL_INCOME_TAX_RATE.n.toString(),
    rateDenominator: SOUTH_KOREA_2025_LOCAL_INCOME_TAX_RATE.d.toString(),
    sourceId: SOUTH_KOREA_2025_LOCAL_INCOME_TAX_SOURCE_ID,
    sourceHash: source.documentHash,
  });
}

export const calculateSouthKorea2025LocalIncomeTax =
  southKorea2025LocalIncomeTax;

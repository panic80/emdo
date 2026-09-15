import { deepFreeze } from '@emdo/contracts';
import {
  compare,
  decimal as q,
  minimum,
  rational,
  serialize,
  times,
  type PersonalExact,
} from './personal-exact.js';

/** Versioned CRA evidence for the 2025 educator school-supply credit. */
export const CANADA_PERSONAL_EDUCATOR_CREDIT_VERSION =
  '2025-educator-school-supply-credit.1';
export const CANADA_PERSONAL_EDUCATOR_CREDIT_SOURCE = deepFreeze({
  id: 'cra-5006-r-2025-fillable',
  authority: 'Canada Revenue Agency',
  title: '2025 Income Tax and Benefit Return for Ontario (fillable)',
  formVersion: '5006-R E (25) fillable PDF',
  url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5006-r/5006-r-fill-25e.pdf',
  documentHash:
    'd307c87b2e53d98653d45065ca1b5d7b0ded5b6220e59fe6fef67c6c06717539',
  retrievedAt: '2026-09-14T02:49:18.481571+00:00',
  guidanceUrl:
    'https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/about-your-tax-return/tax-return/completing-a-tax-return/deductions-credits-expenses/lines-46800-46900-eligible-educator-school-supply-tax-credit.html',
  locator:
    'Page 8: line 46800 maximum $1,000 and line 46900 25% calculation; official 2025 line 46900 guidance supplies eligibility gates',
  rule: 'Line 46800 is the lesser of reviewed eligible school-supply expenses and $1,000; line 46900 is line 46800 multiplied by 25%.',
} as const);

export type Canada2025EducatorEligibility = {
  /** Employed in Canada as an eligible teacher or early childhood educator with a recognized certificate, licence, permit or diploma. */
  eligibleEducator: boolean | null;
  /** The eligible supplies were paid during the 2025 tax year. */
  expensesPaidIn2025: boolean | null;
  /** The expenses were not reimbursed, assisted, or included in an allowance. */
  expensesUnreimbursed: boolean | null;
  /** The same expenses were not deducted or claimed elsewhere. */
  expensesNotClaimedElsewhere: boolean | null;
};

type Issue = {
  code:
    | 'missing-eligibility-fact'
    | 'eligibility-gate-failed'
    | 'negative-expense-amount';
  path: string;
  message: string;
};

const eligibilityFacts = [
  ['eligibleEducator', 'educator.eligibleEducator'],
  ['expensesPaidIn2025', 'educator.expensesPaidIn2025'],
  ['expensesUnreimbursed', 'educator.expensesUnreimbursed'],
  ['expensesNotClaimedElsewhere', 'educator.expensesNotClaimedElsewhere'],
] as const;

/**
 * Calculates only the supported nonzero educator branch. A zero amount is an
 * explicit no-claim result and does not require eligibility assertions. A
 * nonzero amount requires every reviewed gate; a missing or false gate blocks
 * the branch so a claimed expense cannot be silently converted to zero.
 */
export function calculateCanada2025EducatorSchoolSupplyCredit(
  eligibleExpenses: PersonalExact,
  eligibility: Canada2025EducatorEligibility,
) {
  const issues: Issue[] = [];
  if (compare(eligibleExpenses, q('0')) < 0n)
    issues.push({
      code: 'negative-expense-amount',
      path: 'educator.eligibleSuppliesExpenses',
      message: 'Eligible educator supplies expenses cannot be negative.',
    });

  const nonzero = compare(eligibleExpenses, q('0')) > 0n;
  if (nonzero)
    for (const [property, factKey] of eligibilityFacts) {
      const value = eligibility[property];
      if (value === null)
        issues.push({
          code: 'missing-eligibility-fact',
          path: factKey,
          message: `Reviewed ${factKey} is required for a nonzero educator claim.`,
        });
      else if (!value)
        issues.push({
          code: 'eligibility-gate-failed',
          path: factKey,
          message: `The reviewed ${factKey} gate does not support a nonzero educator claim.`,
        });
    }

  const cappedExpenses =
    issues.length === 0 ? minimum(eligibleExpenses, q('1000')) : rational(0n);
  const credit =
    issues.length === 0 ? times(cappedExpenses, q('0.25')) : rational(0n);
  return deepFreeze({
    schemaVersion: 1 as const,
    version: CANADA_PERSONAL_EDUCATOR_CREDIT_VERSION,
    sourceId: CANADA_PERSONAL_EDUCATOR_CREDIT_SOURCE.id,
    sourceHash: CANADA_PERSONAL_EDUCATOR_CREDIT_SOURCE.documentHash,
    line: 'T1.46900',
    status:
      issues.length === 0 ? ('calculated' as const) : ('blocked' as const),
    eligibleExpenses: serialize(eligibleExpenses),
    cappedExpenses: serialize(cappedExpenses),
    credit: serialize(credit),
    issues,
  });
}

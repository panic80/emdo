import { deepFreeze, type FinanceTaxIntake } from '@emdo/contracts';
import {
  decimal as q,
  minus,
  minimum,
  plus,
  positive,
  rational,
  serialize,
  type PersonalExact,
} from './personal-exact.js';

/**
 * CRA says general non-capital losses arising after 2005 can generally be
 * carried forward for 20 years. For a 2025 return, 2006 is therefore the
 * oldest loss year this narrow continuity input accepts. Losses from an
 * earlier year, ABILs, farm/fishing losses, partnership losses and capital
 * losses require their own statutory schedules and remain outside this path.
 */
export const CANADA_PERSONAL_NONCAPITAL_LOSS_YEARS = Object.freeze(
  Array.from({ length: 19 }, (_, index) => 2006 + index),
);
export const CANADA_PERSONAL_CARRYFORWARD_VERSION =
  '2025-general-noncapital-loss-carryforward.1';
export const CANADA_PERSONAL_NONCAPITAL_LOSS_SOURCE = deepFreeze({
  id: 'cra-line-25200-2025-html',
  authority: 'Canada Revenue Agency',
  title: 'Line 25200 – Non-capital losses of other years',
  formVersion: '2025 line 25200 guidance',
  url: 'https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/about-your-tax-return/tax-return/completing-a-tax-return/deductions-credits-expenses/line-25200-non-capital-losses-other-years.html',
  retrievedAt: '2026-09-14T18:48:30Z',
  documentHash:
    'd05244de980986f5aeae6d09bbd0ced1f4fc75a204840406f4869c782045b4c2',
  localFile: 'line-25200-2025.html',
  locator: '2025 guidance: lines 31, 43, 47, 66, 70 and 81-84',
});
export const CANADA_PERSONAL_NONCAPITAL_LOSS_ORDER_SOURCE = deepFreeze({
  id: 'cra-itam-chapter-29-loss-order-2025-html',
  authority: 'Canada Revenue Agency',
  title: 'ITAM Chapter 29 – Loss carryovers',
  formVersion: '2025 loss carryover guidance',
  url: 'https://www.canada.ca/en/revenue-agency/services/tax/technical-information/income-tax-audit-manual-domestic-compliance-programs-branch-dcpb-29.html',
  retrievedAt: '2026-09-14T18:56:00Z',
  documentHash:
    '190c061be35ea46f293da6797a3db76e7d8d8b9409dd781dd11d25437415e5e4',
  localFile: 'itam-chapter-29-loss-carryovers-2025.html',
  locator: '29.5.1, 29.5.2 and 29.5.8: lines 708-728 and 785-805',
});

export const personalNonCapitalLossFactKey = (year: number) =>
  `carryforward.nonCapitalLoss.${year}`;

type Issue = { code: string; path: string; message: string };
type Fact = FinanceTaxIntake['facts'][number];

export type CanadaPersonalCarryforwardEntry = {
  lossYear: number;
  factKey: string;
  openingBalance: ReturnType<typeof serialize>;
  claimedIn2025: ReturnType<typeof serialize>;
  closingBalance: ReturnType<typeof serialize>;
  calculationEligible: boolean;
  sourceBinding: Fact['source'] | null;
};

/**
 * Applies available general non-capital losses oldest-first against the
 * positive taxable-income base before line 25200. The input balance for each
 * year is the unapplied amount shown by the taxpayer's notice of assessment or
 * reassessment; previous applications are therefore already reflected in the
 * opening balance. Every ledger entry retains the source binding from the
 * reviewed fact for replay and provenance.
 */
export function calculateCanadaPersonalNonCapitalLossCarryforward2025(
  facts: readonly Fact[],
  taxableIncomeBeforeCarryforward: PersonalExact,
) {
  const byKey = new Map<string, Fact>();
  const issues: Issue[] = [];
  for (const fact of facts) {
    if (byKey.has(fact.key))
      issues.push({
        code: 'duplicate-carryforward-fact',
        path: fact.key,
        message: 'Each carryforward loss-year balance must be supplied once.',
      });
    else byKey.set(fact.key, fact);
  }
  const entries: Array<{
    lossYear: number;
    factKey: string;
    opening: PersonalExact;
    calculationOpening: PersonalExact;
    calculationEligible: boolean;
    sourceBinding: Fact['source'] | null;
  }> = [];

  for (const lossYear of CANADA_PERSONAL_NONCAPITAL_LOSS_YEARS) {
    const factKey = personalNonCapitalLossFactKey(lossYear);
    const fact = byKey.get(factKey);
    if (!fact) {
      issues.push({
        code: 'missing-carryforward-fact',
        path: factKey,
        message: `Reviewed opening balance for loss year ${lossYear} is required.`,
      });
      entries.push({
        lossYear,
        factKey,
        opening: rational(0n),
        calculationOpening: rational(0n),
        calculationEligible: false,
        sourceBinding: null,
      });
      continue;
    }
    if (fact.reviewState !== 'reviewed')
      issues.push({
        code: 'unreviewed-carryforward-fact',
        path: factKey,
        message: 'Carryforward balances must be reviewed before calculation.',
      });
    if (fact.value.type !== 'decimal') {
      issues.push({
        code: 'invalid-carryforward-fact-type',
        path: factKey,
        message: 'Carryforward opening balances must be CAD decimal amounts.',
      });
      entries.push({
        lossYear,
        factKey,
        opening: rational(0n),
        calculationOpening: rational(0n),
        calculationEligible: false,
        sourceBinding: fact.source,
      });
      continue;
    }
    const opening = q(fact.value.value);
    const nonnegative = opening.n >= 0n;
    if (!nonnegative)
      issues.push({
        code: 'negative-carryforward-balance',
        path: factKey,
        message: 'Carryforward opening balances cannot be negative.',
      });
    entries.push({
      lossYear,
      factKey,
      opening,
      calculationOpening:
        fact.reviewState === 'reviewed' && nonnegative ? opening : rational(0n),
      calculationEligible: fact.reviewState === 'reviewed' && nonnegative,
      sourceBinding: fact.source,
    });
  }

  let remainingIncome = positive(taxableIncomeBeforeCarryforward);
  const claimedValues: PersonalExact[] = [];
  const ledger = entries.map((entry) => {
    const claimedIn2025 = entry.calculationEligible
      ? minimum(entry.calculationOpening, remainingIncome)
      : rational(0n);
    const closingBalance = minus(entry.opening, claimedIn2025);
    remainingIncome = minus(remainingIncome, claimedIn2025);
    claimedValues.push(claimedIn2025);
    return {
      lossYear: entry.lossYear,
      factKey: entry.factKey,
      openingBalance: serialize(entry.opening),
      claimedIn2025: serialize(claimedIn2025),
      closingBalance: serialize(closingBalance),
      calculationEligible: entry.calculationEligible,
      sourceBinding: entry.sourceBinding,
    } satisfies CanadaPersonalCarryforwardEntry;
  });
  const openingTotal = entries.reduce(
    (total, entry) => plus(total, entry.opening),
    rational(0n),
  );
  const claimedTotal = claimedValues.reduce(
    (total, claimed) => plus(total, claimed),
    rational(0n),
  );
  const closingTotal = minus(openingTotal, claimedTotal);

  return deepFreeze({
    schemaVersion: 1 as const,
    version: CANADA_PERSONAL_CARRYFORWARD_VERSION,
    sourceId: CANADA_PERSONAL_NONCAPITAL_LOSS_SOURCE.id,
    sourceHash: CANADA_PERSONAL_NONCAPITAL_LOSS_SOURCE.documentHash,
    orderingSourceId: CANADA_PERSONAL_NONCAPITAL_LOSS_ORDER_SOURCE.id,
    orderingSourceHash:
      CANADA_PERSONAL_NONCAPITAL_LOSS_ORDER_SOURCE.documentHash,
    line: 'T1.25200',
    lossType: 'general-noncapital-loss' as const,
    targetYear: 2025,
    carryforwardLimitYears: 20,
    status: issues.length ? ('blocked' as const) : ('calculated' as const),
    taxableIncomeBeforeCarryforward: serialize(
      positive(taxableIncomeBeforeCarryforward),
    ),
    taxableIncomeAfterCarryforward: serialize(remainingIncome),
    openingTotal: serialize(openingTotal),
    claimedTotal: serialize(claimedTotal),
    closingTotal: serialize(closingTotal),
    ledger,
    issues,
  });
}

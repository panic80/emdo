import { deepFreeze, type FinanceTaxIntake } from '@emdo/contracts';
import {
  compare,
  decimal as q,
  minus,
  minimum,
  plus,
  positive,
  rational,
  serialize,
  times,
  type PersonalExact,
} from './personal-exact.js';

/**
 * Versioned CRA evidence for the ordinary charitable-donation branch. The
 * source captures are intentionally kept beside the domain code so every
 * Schedule 9 line can be replayed against the exact 2025 form revision.
 */
export const CANADA_PERSONAL_DONATIONS_VERSION =
  '2025-federal-charitable-donations.1';
export const CANADA_PERSONAL_DONATIONS_SOURCE = deepFreeze({
  id: 'cra-5000-s9-2025-etext',
  authority: 'Canada Revenue Agency',
  title: '2025 Schedule 9 – Donations and Gifts (e-text)',
  formVersion: '5000-S9 E (25)',
  url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5000-s9/5000-s9-25e.txt',
  localFile: '5000-s9-25e.txt',
  documentHash:
    '86988baa6d4a6918d202ec7beb167e57c9ae42136bbf2ca19125aada2b26cb06',
  retrievedAt: '2026-09-15T05:00:00Z',
  fillableFormId: 'cra-5000-s9-2025-fillable',
  fillableFormUrl:
    'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5000-s9/5000-s9-fill-25e.pdf',
  fillableFormHash:
    'aac16785c69833801b8b4c4d0203b6cfc49f48cd7638dc6e61b69a294ddc5542',
  carryforwardSource: {
    id: 'cra-p113-2025-html',
    authority: 'Canada Revenue Agency',
    title: 'Gifts and Income Tax 2025',
    formVersion: 'P113 (E) Rev. 25',
    url: 'https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/p113/p113-gifts-income-tax.html',
    localFile: 'p113-gifts-income-tax-2025.html',
    documentHash:
      'b9f89b855080fb4b632adad9b99a5b77649a0d4d025549769667282e7c1b5745',
    retrievedAt: '2026-09-15T05:18:00Z',
    locator:
      'Carrying forward tax credits, lines 218–224: claim carried-forward gifts before current-year gifts and claim each amount only once',
  },
  locator:
    'Schedule 9 E (25), lines 1–23: 75% limit, line 18 threshold 253,414.00, and 2025 rates 33%, 29%, 14.5%; P113 (E) Rev. 25 lines 218–224 establishes carryforward priority',
  rule: 'Ordinary eligible donations are carried from the prior five years where still unused, claimed oldest-first when the taxpayer selects a claim amount, limited to 75% of line 23600, and calculated at 14.5% on the first $200, 29% on the remainder, and 33% on the portion above the line 26000 threshold when applicable.',
} as const);

export const CANADA_PERSONAL_DONATION_CARRYFORWARD_YEARS = Object.freeze([
  2020, 2021, 2022, 2023, 2024,
] as const);
export const CANADA_PERSONAL_DONATION_INCOME_THRESHOLD = q('253414');

type Fact = FinanceTaxIntake['facts'][number];
export type Canada2025DonationSourceBinding = Fact['source'];

export type Canada2025DonationEligibility = {
  /** Official receipts identify the eligible amount after any advantage. */
  officialReceiptsReviewed: boolean | null;
  /** Each donee is a CRA qualified donee for the supported ordinary branch. */
  qualifiedDonees: boolean | null;
  /** No capital-property, ecological, cultural, foreign, political or tax-shelter special rule. */
  ordinaryGiftsOnly: boolean | null;
  /** The same eligible amount is not claimed on another return or schedule. */
  noDuplicateClaim: boolean | null;
  /** No pre-2020 ordinary balance remains that would have expired before 2025. */
  noExpiredCarryforward: boolean | null;
};

export type Canada2025DonationCarryforwardInput = {
  year: number;
  amount: PersonalExact;
  factKey?: string;
  sourceBinding?: Canada2025DonationSourceBinding | null;
};

type Issue = { code: string; path: string; message: string };
type Serialized = ReturnType<typeof serialize>;

const zero = () => rational(0n);

function nonnegativeAmount(
  amount: PersonalExact,
  path: string,
  issues: Issue[],
  message: string,
) {
  if (compare(amount, zero()) < 0)
    issues.push({ code: 'negative-amount', path, message });
  return compare(amount, zero()) >= 0 ? amount : zero();
}

/**
 * Calculates the ordinary domestic Schedule 9 branch with exact arithmetic.
 *
 * `claimAmount` is the taxpayer's reviewed Schedule 9 election. It may be
 * less than the available current-year and carryforward balance. When a
 * positive claim is selected, the calculator consumes the oldest valid
 * carryforward year first, then current-year gifts, matching CRA's published
 * priority. Unsupported donation categories, expired balances, and missing
 * eligibility review remain blocked instead of becoming zero.
 */
export function calculateCanada2025FederalCharitableDonations(input: {
  currentEligibleGifts: PersonalExact;
  claimAmount: PersonalExact;
  netIncome: PersonalExact;
  taxableIncome: PersonalExact;
  carryforward: readonly Canada2025DonationCarryforwardInput[];
  eligibility: Canada2025DonationEligibility;
}) {
  const issues: Issue[] = [];
  const current = nonnegativeAmount(
    input.currentEligibleGifts,
    'donations.currentEligibleGifts',
    issues,
    'Current eligible donations cannot be negative.',
  );
  const requestedClaim = nonnegativeAmount(
    input.claimAmount,
    'donations.claimAmount',
    issues,
    'The selected donation claim cannot be negative.',
  );
  const netIncome = nonnegativeAmount(
    input.netIncome,
    'T1.23600',
    issues,
    'Net income used for the donation limit cannot be negative.',
  );
  const taxableIncome = nonnegativeAmount(
    input.taxableIncome,
    'T1.26000',
    issues,
    'Taxable income used for the high-rate donation tier cannot be negative.',
  );

  const expectedYears = new Set<number>(
    CANADA_PERSONAL_DONATION_CARRYFORWARD_YEARS,
  );
  const byYear = new Map<number, Canada2025DonationCarryforwardInput>();
  for (const entry of input.carryforward) {
    if (!expectedYears.has(entry.year)) {
      issues.push({
        code: 'unsupported-carryforward-year',
        path: `donations.carryforward.${entry.year}`,
        message:
          'Only ordinary donation balances from the previous five years (2020–2024) are supported for a 2025 return.',
      });
      continue;
    }
    if (byYear.has(entry.year)) {
      issues.push({
        code: 'duplicate-carryforward-year',
        path: `donations.carryforward.${entry.year}`,
        message: 'Each donation carryforward year must be supplied once.',
      });
      continue;
    }
    byYear.set(entry.year, entry);
  }
  for (const year of CANADA_PERSONAL_DONATION_CARRYFORWARD_YEARS)
    if (!byYear.has(year))
      issues.push({
        code: 'missing-carryforward-year',
        path: `donations.carryforward.${year}`,
        message: `Reviewed opening donation balance for ${year} is required, including zero when absent.`,
      });

  const entries = CANADA_PERSONAL_DONATION_CARRYFORWARD_YEARS.map((year) => {
    const inputEntry = byYear.get(year);
    if (!inputEntry)
      return {
        year,
        factKey: `donations.carryforward.${year}`,
        opening: zero(),
        calculationOpening: zero(),
        calculationEligible: false,
        sourceBinding: null as Canada2025DonationSourceBinding | null,
      };
    const opening = inputEntry.amount;
    const valid = compare(opening, zero()) >= 0;
    if (!valid)
      issues.push({
        code: 'negative-carryforward-balance',
        path: inputEntry.factKey ?? `donations.carryforward.${year}`,
        message: 'Donation carryforward opening balances cannot be negative.',
      });
    return {
      year,
      factKey: inputEntry.factKey ?? `donations.carryforward.${year}`,
      opening,
      calculationOpening: valid ? opening : zero(),
      calculationEligible: valid,
      sourceBinding: inputEntry.sourceBinding ?? null,
    };
  });

  if (input.eligibility.noExpiredCarryforward !== true)
    issues.push({
      code:
        input.eligibility.noExpiredCarryforward === null
          ? 'missing-eligibility-fact'
          : 'unsupported-expired-carryforward',
      path: 'donations.noExpiredCarryforward',
      message:
        'A reviewed declaration that no pre-2020 ordinary donation balance remains is required for a 2025 claim.',
    });
  const nonzeroClaim = compare(requestedClaim, zero()) > 0;
  if (nonzeroClaim) {
    const gates: Array<[keyof Canada2025DonationEligibility, string]> = [
      ['officialReceiptsReviewed', 'donations.officialReceiptsReviewed'],
      ['qualifiedDonees', 'donations.qualifiedDonees'],
      ['ordinaryGiftsOnly', 'donations.ordinaryGiftsOnly'],
      ['noDuplicateClaim', 'donations.noDuplicateClaim'],
    ];
    for (const [property, path] of gates) {
      const value = input.eligibility[property];
      if (value === null)
        issues.push({
          code: 'missing-eligibility-fact',
          path,
          message: `Reviewed ${path} is required for a nonzero donation claim.`,
        });
      else if (!value)
        issues.push({
          code: 'eligibility-gate-failed',
          path,
          message: `The reviewed ${path} gate does not support a nonzero donation claim.`,
        });
    }
  }

  const openingCarryforwardTotal = entries.reduce(
    (total, entry) =>
      plus(
        total,
        entry.calculationEligible ? entry.calculationOpening : zero(),
      ),
    zero(),
  );
  const available = plus(current, openingCarryforwardTotal);
  const line6 = times(netIncome, q('0.75'));
  const donationLimit = minimum(available, line6);
  if (compare(requestedClaim, available) > 0)
    issues.push({
      code: 'claim-exceeds-available',
      path: 'donations.claimAmount',
      message:
        'The selected donation claim cannot exceed current eligible gifts plus valid prior-year balances.',
    });
  if (compare(requestedClaim, donationLimit) > 0)
    issues.push({
      code: 'claim-exceeds-donation-limit',
      path: 'donations.claimAmount',
      message:
        'The selected donation claim cannot exceed the Schedule 9 donation limit.',
    });

  const blocked = issues.length > 0;
  const selectedClaim = blocked ? zero() : requestedClaim;
  let remainingClaim = selectedClaim;
  const ledger = entries.map((entry) => {
    const claimed = entry.calculationEligible
      ? minimum(entry.calculationOpening, remainingClaim)
      : zero();
    remainingClaim = minus(remainingClaim, claimed);
    return {
      year: entry.year,
      factKey: entry.factKey,
      openingBalance: serialize(entry.opening),
      claimedIn2025: serialize(claimed),
      closingBalance: serialize(minus(entry.opening, claimed)),
      calculationEligible: entry.calculationEligible,
      sourceBinding: entry.sourceBinding,
    };
  });
  const claimedFromCarryforward = ledger.reduce(
    (total, entry) =>
      plus(
        total,
        rational(
          BigInt(entry.claimedIn2025.exactRational.numerator),
          BigInt(entry.claimedIn2025.exactRational.denominator),
        ),
      ),
    zero(),
  );
  const currentClaim = minimum(current, remainingClaim);
  remainingClaim = minus(remainingClaim, currentClaim);
  // This can only be nonzero when a validation issue was added above. Keep the
  // value in the result so an unexpected future rule change is observable.
  if (compare(remainingClaim, zero()) > 0)
    issues.push({
      code: 'claim-allocation-incomplete',
      path: 'donations.claimAmount',
      message:
        'The selected donation claim could not be allocated to reviewed balances.',
    });
  const selectedEligible = plus(claimedFromCarryforward, currentClaim);
  const line1 = selectedEligible;
  const line5 = line1;
  const line8 = line6;
  const line9 = minimum(line5, line8);
  const line10 = minimum(line5, line9);
  const line11 = zero();
  const line12 = plus(line10, line11);
  const line13 = minimum(line12, q('200'));
  const line14 = minus(line12, line13);
  const line15 = zero();
  const line16 = positive(minus(line14, line15));
  const line17 = taxableIncome;
  const line18 = CANADA_PERSONAL_DONATION_INCOME_THRESHOLD;
  const line19 = positive(minus(line17, line18));
  const line20Base = minimum(line16, line19);
  const line20 = times(line20Base, q('0.33'));
  const line21Base = minus(line14, line20Base);
  const line21 = times(line21Base, q('0.29'));
  const line22 = times(line13, q('0.145'));
  const line23 = plus(line20, line21, line22);

  return deepFreeze({
    schemaVersion: 1 as const,
    version: CANADA_PERSONAL_DONATIONS_VERSION,
    sourceId: CANADA_PERSONAL_DONATIONS_SOURCE.id,
    sourceHash: CANADA_PERSONAL_DONATIONS_SOURCE.documentHash,
    fillableSourceId: CANADA_PERSONAL_DONATIONS_SOURCE.fillableFormId,
    fillableSourceHash: CANADA_PERSONAL_DONATIONS_SOURCE.fillableFormHash,
    line: 'T1.34900',
    status: issues.length ? ('blocked' as const) : ('calculated' as const),
    eligibility: input.eligibility,
    currentEligibleGifts: serialize(input.currentEligibleGifts),
    requestedClaim: serialize(input.claimAmount),
    availableEligibleGifts: serialize(available),
    donationLimit: serialize(donationLimit),
    claimedAmount: serialize(selectedEligible),
    claimedFromCarryforward: serialize(claimedFromCarryforward),
    claimedFromCurrentYear: serialize(currentClaim),
    currentYearClosingBalance: serialize(minus(current, currentClaim)),
    carryforwardLedger: ledger,
    schedule9: {
      line1: serialize(line1),
      line5: serialize(line5),
      line6: serialize(line6),
      line8: serialize(line8),
      line9: serialize(line9),
      line10: serialize(line10),
      line11: serialize(line11),
      line12: serialize(line12),
      line13: serialize(line13),
      line14: serialize(line14),
      line15: serialize(line15),
      line16: serialize(line16),
      line17: serialize(line17),
      line18: serialize(line18),
      line19: serialize(line19),
      line20Base: serialize(line20Base),
      line20: serialize(line20),
      line21Base: serialize(line21Base),
      line21: serialize(line21),
      line22: serialize(line22),
      line23: serialize(line23),
    },
    issues,
  });
}

/** Reconstructs an exact amount from a calculation result for workflow fields. */
export function exactCanada2025DonationAmount(value: Serialized) {
  return rational(
    BigInt(value.exactRational.numerator),
    BigInt(value.exactRational.denominator),
  );
}

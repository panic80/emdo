import { describe, expect, it } from 'vitest';
import {
  CANADA_PERSONAL_DONATION_CARRYFORWARD_YEARS,
  CANADA_PERSONAL_DONATION_INCOME_THRESHOLD,
  CANADA_PERSONAL_DONATIONS_SOURCE,
  CANADA_PERSONAL_DONATIONS_VERSION,
  calculateCanada2025FederalCharitableDonations,
  type Canada2025DonationEligibility,
} from './personal-donations.js';
import { decimal as q } from './personal-exact.js';

const eligible = {
  officialReceiptsReviewed: true,
  qualifiedDonees: true,
  ordinaryGiftsOnly: true,
  noDuplicateClaim: true,
  noExpiredCarryforward: true,
} as const;

function carryforward(balances: Record<number, string> = {}) {
  return CANADA_PERSONAL_DONATION_CARRYFORWARD_YEARS.map((year) => ({
    year,
    amount: q(balances[year] ?? '0'),
    factKey: `donations.carryforward.${year}`,
    sourceBinding: {
      kind: 'evidence' as const,
      reference: `fixture:donations.carryforward.${year}`,
      revision: 1,
      contentHash: 'a'.repeat(64),
    },
  }));
}

function calculate(
  current: string,
  claim: string,
  netIncome: string,
  taxableIncome: string,
  balances: Record<number, string> = {},
  eligibility: Canada2025DonationEligibility = eligible,
) {
  return calculateCanada2025FederalCharitableDonations({
    currentEligibleGifts: q(current),
    claimAmount: q(claim),
    netIncome: q(netIncome),
    taxableIncome: q(taxableIncome),
    carryforward: carryforward(balances),
    eligibility,
  });
}

describe('2025 CRA Schedule 9 ordinary charitable donations', () => {
  it('retains the source revision and produces a no-claim zero result', () => {
    const result = calculate('0', '0', '0', '0');
    expect(result.status).toBe('calculated');
    expect(result.version).toBe(CANADA_PERSONAL_DONATIONS_VERSION);
    expect(result.sourceId).toBe(CANADA_PERSONAL_DONATIONS_SOURCE.id);
    expect(result.sourceHash).toBe(
      CANADA_PERSONAL_DONATIONS_SOURCE.documentHash,
    );
    expect(result.schedule9.line23.exactDecimal).toBe('0');
    expect(result.claimedAmount.exactDecimal).toBe('0');
  });

  it.each([
    ['200', '29'],
    ['200.50', '29.145'],
    ['1000', '261'],
  ])(
    'uses the 14.5% first-$200 tier and 29% remainder for claim %s',
    (claim, credit) => {
      const result = calculate(claim, claim, '10000', '100000');
      expect(result.status).toBe('calculated');
      expect(result.schedule9.line13.exactDecimal).toBe('200');
      expect(result.schedule9.line23.exactDecimal).toBe(credit);
    },
  );

  it('switches only the portion above the taxable-income threshold to 33%', () => {
    const atThreshold = calculate('1000', '1000', '10000', '253414');
    const aboveThreshold = calculate('1000', '1000', '10000', '253414.01');
    expect(atThreshold.schedule9.line19.exactDecimal).toBe('0');
    expect(atThreshold.schedule9.line23.exactDecimal).toBe('261');
    expect(aboveThreshold.schedule9.line19.exactDecimal).toBe('0.01');
    expect(aboveThreshold.schedule9.line20Base.exactDecimal).toBe('0.01');
    expect(aboveThreshold.schedule9.line23.exactDecimal).toBe('261.0004');
    expect(CANADA_PERSONAL_DONATION_INCOME_THRESHOLD).toEqual(q('253414'));
  });

  it('applies the 75% net-income limit and preserves a selected partial claim', () => {
    const result = calculate('10000', '7500', '10000', '10000');
    expect(result.availableEligibleGifts.exactDecimal).toBe('10000');
    expect(result.donationLimit.exactDecimal).toBe('7500');
    expect(result.schedule9.line6.exactDecimal).toBe('7500');
    expect(result.schedule9.line10.exactDecimal).toBe('7500');
    expect(result.claimedAmount.exactDecimal).toBe('7500');
    expect(result.currentYearClosingBalance.exactDecimal).toBe('2500');
  });

  it('consumes prior-year balances oldest-first at the 2020 validity boundary', () => {
    const result = calculate('100', '150', '1000', '1000', {
      2020: '100',
      2021: '100',
    });
    expect(result.status).toBe('calculated');
    expect(result.claimedFromCarryforward.exactDecimal).toBe('150');
    expect(result.claimedFromCurrentYear.exactDecimal).toBe('0');
    expect(result.carryforwardLedger[0]?.claimedIn2025.exactDecimal).toBe(
      '100',
    );
    expect(result.carryforwardLedger[0]?.closingBalance.exactDecimal).toBe('0');
    expect(result.carryforwardLedger[1]?.claimedIn2025.exactDecimal).toBe('50');
    expect(result.carryforwardLedger[1]?.closingBalance.exactDecimal).toBe(
      '50',
    );
    expect(result.carryforwardLedger.at(-1)?.year).toBe(2024);
  });

  it('allocates to current-year gifts after older carryforward balances', () => {
    const result = calculate('200', '250', '1000', '1000', { 2024: '100' });
    expect(result.claimedFromCarryforward.exactDecimal).toBe('100');
    expect(result.claimedFromCurrentYear.exactDecimal).toBe('150');
    expect(result.currentYearClosingBalance.exactDecimal).toBe('50');
  });

  it('rejects an expired 2019 balance rather than dropping it', () => {
    const result = calculate('0', '0', '1000', '1000');
    const withExpired = calculateCanada2025FederalCharitableDonations({
      currentEligibleGifts: q('0'),
      claimAmount: q('0'),
      netIncome: q('1000'),
      taxableIncome: q('1000'),
      carryforward: [
        ...carryforward(),
        { year: 2019, amount: q('10'), factKey: 'donations.carryforward.2019' },
      ],
      eligibility: eligible,
    });
    expect(result.status).toBe('calculated');
    expect(withExpired.status).toBe('blocked');
    expect(withExpired.issues).toContainEqual(
      expect.objectContaining({
        code: 'unsupported-carryforward-year',
        path: 'donations.carryforward.2019',
      }),
    );
  });

  it('blocks a negative source amount and preserves its exact evidence', () => {
    const result = calculateCanada2025FederalCharitableDonations({
      currentEligibleGifts: q('-0.50'),
      claimAmount: q('0'),
      netIncome: q('1000'),
      taxableIncome: q('1000'),
      carryforward: carryforward(),
      eligibility: eligible,
    });
    expect(result.status).toBe('blocked');
    expect(result.currentEligibleGifts.exactDecimal).toBe('-0.5');
    expect(result.schedule9.line23.exactDecimal).toBe('0');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'negative-amount',
        path: 'donations.currentEligibleGifts',
      }),
    );
  });

  it('requires every nonzero claim eligibility gate and complete carryforward history', () => {
    const missingGate = calculate(
      '1',
      '1',
      '1000',
      '1000',
      {},
      {
        ...eligible,
        qualifiedDonees: null,
      },
    );
    expect(missingGate.status).toBe('blocked');
    expect(missingGate.issues).toContainEqual(
      expect.objectContaining({
        code: 'missing-eligibility-fact',
        path: 'donations.qualifiedDonees',
      }),
    );
    const incomplete = calculateCanada2025FederalCharitableDonations({
      currentEligibleGifts: q('1'),
      claimAmount: q('1'),
      netIncome: q('1000'),
      taxableIncome: q('1000'),
      carryforward: carryforward().slice(0, -1),
      eligibility: eligible,
    });
    expect(incomplete.status).toBe('blocked');
    expect(incomplete.issues).toContainEqual(
      expect.objectContaining({
        code: 'missing-carryforward-year',
        path: 'donations.carryforward.2024',
      }),
    );
  });

  it('blocks a selected claim over the limit instead of silently clipping it', () => {
    const result = calculate('1000', '751', '1000', '1000');
    expect(result.status).toBe('blocked');
    expect(result.schedule9.line23.exactDecimal).toBe('0');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'claim-exceeds-donation-limit' }),
    );
  });
});

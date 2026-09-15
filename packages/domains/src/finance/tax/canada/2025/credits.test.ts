import { describe, expect, it } from 'vitest';
import {
  calculateCanadaOntario2025Credits,
  calculateOntario2025TaxReduction,
} from './credits.js';
import { CANADA_ON_2025_READINESS } from './readiness.js';

const context = {
  scope: CANADA_ON_2025_READINESS.scope,
  fullYearCanadianResident: true,
  ontarioResidentOnDecember31: true,
  hasPermanentEstablishmentOutsideOntario: false,
};
const creditFacts = (netIncomeLine23600: string) => ({
  ...context,
  netIncomeLine23600,
  eligibleFederalAmountsExcludingBasicPersonalAmount: '0',
  federalDonationsAndGiftsLine34900: '0',
  federalSchedule9Line22: '0',
  eligibleOntarioAmountsExcludingBasicPersonalAmount: '0',
  ontarioDonationsAndGiftsLine58969: '0',
  eligibleInputsReviewed: true,
});
const reductionFacts = () => ({
  ...context,
  netIncomeLine23600: '20000',
  spouseNetIncomeLine23600: null as string | null,
  ontarioTaxBeforeReductionLine73: '500',
  additionalTaxForMinimumTaxPurposesLine72: '0',
  bankruptAnyTimeDuringYear: false,
  returnFiledByTrusteeInBankruptcy: false,
  electsOntarioTaxReduction: true,
  eligibleChildrenBorn2007OrLater: 0,
  eligibleDependantsWithImpairment: 0,
  dependantEligibilityAndExclusiveClaimsReviewed: true,
});

describe('2025 federal and Ontario sourced credit dependencies', () => {
  it.each([
    ['0', '16129', '2338.705'],
    ['177882', '16129', '2338.705'],
    ['215648', '15333.5', '2223.3575'],
    ['253414', '14538', '2108.01'],
    ['500000', '14538', '2108.01'],
  ])(
    'calculates federal BPA and 14.5 percent component at net income %s',
    (net, expectedBpa, expectedCredit) => {
      const result = calculateCanadaOntario2025Credits(creditFacts(net));
      expect(result.components.federalBasicPersonalAmount.exactDecimal).toBe(
        expectedBpa,
      );
      expect(
        result.components.federalNonrefundableCreditBeforeDonationsAndTopUp
          .exactDecimal,
      ).toBe(expectedCredit);
      expect(result.components.ontarioBasicPersonalAmount.exactDecimal).toBe(
        '12747',
      );
      expect(result.components.ontarioCreditBeforeDonations.exactDecimal).toBe(
        '643.7235',
      );
    },
  );
  it('retains recurring BPA exactly rather than discarding decimals before multiplying credits', () => {
    // Independently derived using Python Fraction: 16129 - (200000-177882)*1591/75532.
    const result = calculateCanadaOntario2025Credits(creditFacts('200000'));
    expect(result.components.federalBasicPersonalAmount.exactRational).toEqual({
      numerator: '591532945',
      denominator: '37766',
    });
    expect(
      result.components.federalBasicPersonalAmount.exactDecimal,
    ).toBeNull();
    expect(
      result.components.federalNonrefundableCreditBeforeDonationsAndTopUp
        .exactRational,
    ).toEqual({ numerator: '3430891081', denominator: '1510640' });
    expect(
      result.components.federalBasicPersonalAmount.reportableAmount,
    ).toBeNull();
  });
  it('applies worksheet 34990 top-up and keeps eligible amounts distinct from donations', () => {
    const result = calculateCanadaOntario2025Credits({
      ...creditFacts('0'),
      eligibleFederalAmountsExcludingBasicPersonalAmount: '45000',
      federalDonationsAndGiftsLine34900: '100',
      eligibleOntarioAmountsExcludingBasicPersonalAmount: '1000',
      ontarioDonationsAndGiftsLine58969: '20',
    });
    expect(result.components.federalEligibleAmounts.exactDecimal).toBe('61129');
    expect(
      result.components.federalNonrefundableCreditBeforeDonationsAndTopUp
        .exactDecimal,
    ).toBe('8863.705');
    expect(result.components.federalTopUpCredit.exactDecimal).toBe(
      '18.7792125',
    );
    expect(result.components.federalNonrefundableCredits.exactDecimal).toBe(
      '8982.4842125',
    );
    expect(result.components.ontarioNonrefundableCredits.exactDecimal).toBe(
      '714.2235',
    );
  });
  it('honours the published top-up threshold and Schedule9 line22 without inventing donation eligibility', () => {
    const below = {
      ...creditFacts('0'),
      eligibleFederalAmountsExcludingBasicPersonalAmount: '41246',
    };
    expect(
      calculateCanadaOntario2025Credits(below).components.federalTopUpCredit
        .exactDecimal,
    ).toBe('0');
    expect(
      calculateCanadaOntario2025Credits({
        ...below,
        federalSchedule9Line22: '0.01',
      }).components.federalTopUpCredit.exactDecimal,
    ).toBe('0.0001725');
    expect(
      calculateCanadaOntario2025Credits({
        ...below,
        eligibleFederalAmountsExcludingBasicPersonalAmount: '41246.04',
      }).components.federalTopUpCredit.exactDecimal,
    ).toBe('0.0000276');
  });
  it('does not equate net income and taxable income or accept unreviewed eligible credit inputs', () => {
    expect(() =>
      calculateCanadaOntario2025Credits({
        ...creditFacts('0'),
        netIncomeLine23600: undefined,
        taxableIncomeLine26000: '0',
      }),
    ).toThrow();
    expect(() =>
      calculateCanadaOntario2025Credits({
        ...creditFacts('0'),
        eligibleInputsReviewed: false,
      }),
    ).toThrow();
    expect(() =>
      calculateCanadaOntario2025Credits({
        ...creditFacts('0'),
        federalSchedule9Line22: undefined,
      }),
    ).toThrow();
    expect(calculateCanadaOntario2025Credits(creditFacts('0')).complete).toBe(
      false,
    );
  });
  it.each([
    ['0', '0', '0'],
    ['200', '388', '0'],
    ['294', '294', '0'],
    ['500', '88', '412'],
    ['588', '0', '588'],
    ['1000', '0', '1000'],
  ])(
    'follows ON428 reduction and nonnegative next line for tax %s',
    (line73, reduction, after) => {
      const result = calculateOntario2025TaxReduction({
        ...reductionFacts(),
        ontarioTaxBeforeReductionLine73: line73,
      });
      expect(result.components.ontarioTaxReduction.exactDecimal).toBe(
        reduction,
      );
      expect(result.components.ontarioTaxAfterReduction.exactDecimal).toBe(
        after,
      );
    },
  );
  it('supports both eligible child and impairment reductions when independently eligible', () => {
    const result = calculateOntario2025TaxReduction({
      ...reductionFacts(),
      eligibleChildrenBorn2007OrLater: 1,
      eligibleDependantsWithImpairment: 1,
      ontarioTaxBeforeReductionLine73: '2500',
    });
    expect(result.calculation?.line77.exactDecimal).toBe('1382');
    expect(result.components.ontarioTaxReduction.exactDecimal).toBe('264');
    expect(result.components.ontarioTaxAfterReduction.exactDecimal).toBe(
      '2236',
    );
  });
  it.each(['20000', '30000'])(
    'does not allocate dependant reductions to a claimant without higher net income than spouse %s',
    (spouseIncome) => {
      const result = calculateOntario2025TaxReduction({
        ...reductionFacts(),
        spouseNetIncomeLine23600: spouseIncome,
        eligibleChildrenBorn2007OrLater: 2,
      });
      expect(result.dependentCountsApplied).toEqual({
        children: 0,
        impaired: 0,
      });
      expect(result.components.ontarioTaxReduction.exactDecimal).toBe('88');
      expect(result.dependentCountRestriction).not.toBeNull();
    },
  );
  it('allows the higher-income spouse to apply eligible dependant counts', () => {
    const result = calculateOntario2025TaxReduction({
      ...reductionFacts(),
      spouseNetIncomeLine23600: '19999.99',
      eligibleChildrenBorn2007OrLater: 1,
    });
    expect(result.dependentCountsApplied.children).toBe(1);
    expect(result.components.ontarioTaxReduction.exactDecimal).toBe('1176');
  });
  it.each([
    { bankruptAnyTimeDuringYear: true },
    { returnFiledByTrusteeInBankruptcy: true },
    { electsOntarioTaxReduction: false },
    { additionalTaxForMinimumTaxPurposesLine72: '0.01' },
  ])('respects an explicit reduction exclusion %j', (patch) => {
    const result = calculateOntario2025TaxReduction({
      ...reductionFacts(),
      ...patch,
    });
    expect(result.components.ontarioTaxReduction.exactDecimal).toBe('0');
    expect(result.components.ontarioTaxAfterReduction.exactDecimal).toBe('500');
    expect(result.calculation).toBeNull();
    expect(result.exclusionReasons).not.toEqual([]);
  });
  it('rejects inconsistent minimum-tax input with exact cents even above safe binary-float precision', () => {
    expect(() =>
      calculateOntario2025TaxReduction({
        ...reductionFacts(),
        ontarioTaxBeforeReductionLine73: '999999999999999.98',
        additionalTaxForMinimumTaxPurposesLine72: '999999999999999.99',
      }),
    ).toThrow();
    expect(() =>
      calculateOntario2025TaxReduction({
        ...reductionFacts(),
        dependantEligibilityAndExclusiveClaimsReviewed: false,
      }),
    ).toThrow();
    expect(() =>
      calculateOntario2025TaxReduction({
        ...reductionFacts(),
        eligibleChildrenBorn2007OrLater: -1,
      }),
    ).toThrow();
  });
  it('freezes evidence and keeps package eligibility and final rounded values unavailable', () => {
    const facts = creditFacts('200000');
    const result = calculateCanadaOntario2025Credits(facts);
    facts.netIncomeLine23600 = '0';
    expect(result.inputs.netIncomeLine23600).toBe('200000');
    expect(
      Object.isFrozen(
        result.components.federalBasicPersonalAmount.exactRational,
      ),
    ).toBe(true);
    expect(result.releaseBlockerIds).toContain('rounding-policy');
    expect(CANADA_ON_2025_READINESS.registryEligible).toBe(false);
  });
});

import {
  deepFreeze,
  FinanceCanadaOntario2025CreditInputSchema,
  FinanceCanadaOntario2025ReductionInputSchema,
} from '@emdo/contracts';
import {
  CANADA_ON_2025_READINESS,
  CANADA_ON_2025_SOURCES,
} from './readiness.js';
import {
  calculateCanada2025FederalBasicPersonalAmount,
  serializeCanada2025FederalBasicPersonalAmount,
} from './personal-basic-personal-amount.js';

type Rational = { numerator: bigint; denominator: bigint };
function rational(numerator: bigint, denominator = 1n): Rational {
  let a = numerator < 0n ? -numerator : numerator,
    b = denominator;
  while (b) [a, b] = [b, a % b];
  return { numerator: numerator / a, denominator: denominator / a };
}
const number = (value: string) => {
  const [whole, fraction = ''] = value.split('.');
  return rational(
    BigInt(`${whole}${fraction}`),
    10n ** BigInt(fraction.length),
  );
};
const add = (a: Rational, b: Rational) =>
  rational(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
const subtract = (a: Rational, b: Rational) =>
  rational(
    a.numerator * b.denominator - b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
const multiply = (a: Rational, b: Rational) =>
  rational(a.numerator * b.numerator, a.denominator * b.denominator);
const positive = (value: Rational) =>
  value.numerator < 0n ? number('0') : value;
const compare = (a: Rational, b: Rational) =>
  a.numerator * b.denominator - b.numerator * a.denominator;

/** No rounding or truncation: a recurring decimal remains an exact rational. */
function exact(value: Rational) {
  let remainder = value.denominator,
    twos = 0,
    fives = 0;
  while (remainder % 2n === 0n) {
    remainder /= 2n;
    twos++;
  }
  while (remainder % 5n === 0n) {
    remainder /= 5n;
    fives++;
  }
  let exactDecimal: string | null = null;
  if (remainder === 1n) {
    const places = Math.max(twos, fives);
    const scaled =
      (value.numerator * 10n ** BigInt(places)) / value.denominator;
    const digits = scaled.toString().padStart(places + 1, '0');
    exactDecimal = places
      ? `${digits.slice(0, -places)}.${digits.slice(-places)}`.replace(
          /\.?0+$/,
          '',
        )
      : digits;
  }
  return {
    exactRational: {
      numerator: value.numerator.toString(),
      denominator: value.denominator.toString(),
    },
    exactDecimal,
  };
}
const component = (
  ruleId: string,
  sourceLocator: string,
  sourceIndexes: number[],
  amount: Rational,
) => ({
  ruleId,
  sourceLocator,
  sourceIds: sourceIndexes.map((index) => CANADA_ON_2025_SOURCES[index]!.id),
  ...exact(amount),
  reportableAmount: null,
  status: 'rounding-review-required' as const,
});

/** Complete arithmetic for these dependency lines only, not eligibility for other supplied credit amounts. */
export function calculateCanadaOntario2025Credits(input: unknown) {
  const facts = FinanceCanadaOntario2025CreditInputSchema.parse(input);
  const netIncome = number(facts.netIncomeLine23600);
  const bpaCalculation = calculateCanada2025FederalBasicPersonalAmount({
    n: netIncome.numerator,
    d: netIncome.denominator,
  });
  const bpa = {
    numerator: bpaCalculation.amount.n,
    denominator: bpaCalculation.amount.d,
  };
  const federal33500 = add(
    bpa,
    number(facts.eligibleFederalAmountsExcludingBasicPersonalAmount),
  );
  const federal33800 = multiply(federal33500, number('0.145'));
  // Worksheet line34990 has its own specified rate. Do not substitute 0.5 / 14.5 or round the input.
  const topUpBase = positive(
    subtract(
      add(federal33800, number(facts.federalSchedule9Line22)),
      number('8319.38'),
    ),
  );
  const federal34990 = multiply(topUpBase, number('0.0345'));
  const federal35000 = add(
    add(federal33800, number(facts.federalDonationsAndGiftsLine34900)),
    federal34990,
  );
  const ontario58040 = number('12747');
  const ontario58800 = add(
    ontario58040,
    number(facts.eligibleOntarioAmountsExcludingBasicPersonalAmount),
  );
  const ontario58840 = multiply(ontario58800, number('0.0505'));
  const ontario61500 = add(
    ontario58840,
    number(facts.ontarioDonationsAndGiftsLine58969),
  );
  return deepFreeze({
    status: 'components-only' as const,
    complete: false as const,
    currency: 'CAD' as const,
    rulesVersion: CANADA_ON_2025_READINESS.version,
    inputs: facts,
    components: {
      federalBasicPersonalAmount: {
        ...component(
          'ca-2025-basic-personal-amount',
          'T1 line30000; Federal Worksheet line30000 lines1-11',
          [0, 2],
          bpa,
        ),
        worksheet:
          serializeCanada2025FederalBasicPersonalAmount(bpaCalculation),
      },
      federalEligibleAmounts: component(
        'ca-2025-line33500',
        'T1 Part B line33500; supplied eligible amounts excluding line30000',
        [0],
        federal33500,
      ),
      federalNonrefundableCreditBeforeDonationsAndTopUp: component(
        'ca-2025-line33800',
        'T1 Part B lines113-115 (14.5%)',
        [0],
        federal33800,
      ),
      federalTopUpCredit: component(
        'ca-2025-line34990',
        'Federal Worksheet line34990 lines1-7 (3.45%)',
        [2],
        federal34990,
      ),
      federalNonrefundableCredits: component(
        'ca-2025-line35000',
        'T1 Part B lines115-118',
        [0],
        federal35000,
      ),
      ontarioBasicPersonalAmount: component(
        'ca-on-2025-line58040',
        'ON428 Part B line9',
        [1],
        ontario58040,
      ),
      ontarioEligibleAmounts: component(
        'ca-on-2025-line58800',
        'ON428 Part B line44; supplied eligible amounts excluding line58040',
        [1],
        ontario58800,
      ),
      ontarioCreditBeforeDonations: component(
        'ca-on-2025-line58840',
        'ON428 Part B lines44-46 (5.05%)',
        [1],
        ontario58840,
      ),
      ontarioNonrefundableCredits: component(
        'ca-on-2025-line61500',
        'ON428 Part B lines46-50',
        [1],
        ontario61500,
      ),
    },
    sources: CANADA_ON_2025_SOURCES,
    releaseBlockerIds: CANADA_ON_2025_READINESS.releaseBlockers.map(
      (blocker) => blocker.id,
    ),
  });
}

/** ON428 lines74-81: reviewed eligible counts are supplied; no dependant eligibility is inferred. */
export function calculateOntario2025TaxReduction(input: unknown) {
  const facts = FinanceCanadaOntario2025ReductionInputSchema.parse(input);
  const line73 = number(facts.ontarioTaxBeforeReductionLine73);
  const reasons: string[] = [];
  if (number(facts.additionalTaxForMinimumTaxPurposesLine72).numerator > 0n)
    reasons.push('ontario-additional-minimum-tax');
  if (facts.bankruptAnyTimeDuringYear) reasons.push('bankruptcy');
  if (facts.returnFiledByTrusteeInBankruptcy)
    reasons.push('trustee-in-bankruptcy');
  if (!facts.electsOntarioTaxReduction) reasons.push('no-claim-election');
  if (line73.numerator === 0n) reasons.push('no-ontario-tax-before-reduction');
  const canClaimDependants =
    facts.spouseNetIncomeLine23600 === null ||
    compare(
      number(facts.netIncomeLine23600),
      number(facts.spouseNetIncomeLine23600),
    ) > 0n;
  const children = canClaimDependants
    ? facts.eligibleChildrenBorn2007OrLater
    : 0;
  const impaired = canClaimDependants
    ? facts.eligibleDependantsWithImpairment
    : 0;
  const line74 = number('294');
  const line75 = multiply(number('544'), rational(BigInt(children)));
  const line76 = multiply(number('544'), rational(BigInt(impaired)));
  const line77 = add(add(line74, line75), line76);
  const line78 = multiply(line77, number('2'));
  const line80 = reasons.length
    ? number('0')
    : positive(subtract(line78, line73));
  const line81 = positive(subtract(line73, line80));
  return deepFreeze({
    status: 'components-only' as const,
    complete: false as const,
    currency: 'CAD' as const,
    rulesVersion: CANADA_ON_2025_READINESS.version,
    inputs: facts,
    calculation: reasons.length
      ? null
      : {
          line74: exact(line74),
          line75: exact(line75),
          line76: exact(line76),
          line77: exact(line77),
          line78: exact(line78),
          line79: exact(line73),
        },
    dependentCountsApplied: { children, impaired },
    dependentCountRestriction: canClaimDependants
      ? null
      : 'only-the-spouse-with-higher-net-income-can-claim-dependent-amounts',
    exclusionReasons: reasons,
    components: {
      ontarioTaxReduction: component(
        'ca-on-2025-line80',
        'ON428 Part C lines74-80; Ontario tax information tax reduction',
        [1, 3],
        line80,
      ),
      ontarioTaxAfterReduction: component(
        'ca-on-2025-line81',
        'ON428 Part C line81; not final Ontario tax',
        [1],
        line81,
      ),
    },
    sources: CANADA_ON_2025_SOURCES,
    releaseBlockerIds: CANADA_ON_2025_READINESS.releaseBlockers.map(
      (blocker) => blocker.id,
    ),
  });
}

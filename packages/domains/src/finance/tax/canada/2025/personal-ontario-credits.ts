import {
  decimal as q,
  plus,
  minus,
  times,
  positive,
  minimum,
  type PersonalExact,
} from './personal-exact.js';
/** Captured 5006-C E (25), PartB and PartC through line62.
 * Caller validates ordinary-age, no-dependants, no-other-credits/income,
 * no-EI-special-benefits and no-special-taxes scope. Omitted terms are bound
 * to those reviewed facts rather than inferred from zero income or credits. */
export function appendCanada2025OntarioCredits(
  at: (id: string) => PersonalExact,
  field: (
    id: string,
    label: string,
    amount: PersonalExact,
    dependencies: string[],
    sourceId?: string,
    locator?: string,
  ) => PersonalExact,
) {
  const add = (
    line: string,
    label: string,
    amount: PersonalExact,
    dependencies: string[],
  ) =>
    field(
      `ON428.${line}`,
      label,
      amount,
      dependencies,
      'cra-5006-c-2025-etext',
      `5006-C E (25), printed line${line}`,
    );
  const personal = add('18', 'Personal credit subtotal', at('ON428.58040'), [
    'ON428.58040',
    'fact:scope.noOtherCredits',
    'fact:scope.singleNoDependants',
  ]);
  const contributions = add(
    '24',
    'CPP and EI credit subtotal',
    plus(at('ON428.58240'), at('ON428.58280'), at('ON428.58300')),
    [
      'ON428.58240',
      'ON428.58280',
      'ON428.58300',
      'fact:scope.noEiSpecialBenefitsAgreement',
      'fact:scope.noOtherCredits',
    ],
  );
  const repeated = add(
    '24.copy2',
    'Contribution subtotal carried across printed form',
    contributions,
    ['ON428.24'],
  );
  const subtotal = add(
    '25',
    'Personal and contribution credit subtotal',
    plus(personal, repeated),
    ['ON428.18', 'ON428.24.copy2'],
  );
  const carried = add(
    '26',
    'Credit subtotal carried from prior page',
    subtotal,
    ['ON428.25'],
  );
  const pension = add('28', 'Subtotal after excluded pension credit', carried, [
    'ON428.26',
    'fact:scope.noOtherCredits',
  ]);
  const disability = add(
    '31',
    'Subtotal after excluded disability credits',
    pension,
    ['ON428.28', 'fact:scope.noOtherCredits'],
  );
  const beforeMedical = add(
    '35',
    'Subtotal after excluded student and transferred credits',
    disability,
    ['ON428.31', 'fact:scope.noOtherCredits'],
  );
  const eligible = add(
    '58800',
    'Total eligible Ontario credit amounts',
    plus(beforeMedical, at('ON428.58769')),
    ['ON428.35', 'ON428.58769'],
  );
  const ordinaryCredit = add(
    '58840',
    'Ontario credit at printed 5.05% rate',
    times(eligible, q('0.0505')),
    ['ON428.58800'],
  );
  const credit = add(
    '61500',
    'Ontario non-refundable credits after excluded donations',
    ordinaryCredit,
    ['ON428.58840', 'fact:scope.noOtherCredits'],
  );
  const creditCopy = add(
    '52',
    'Non-refundable credits transferred from line50',
    credit,
    ['ON428.61500'],
  );
  const tax = add(
    '53',
    'Ontario tax less non-refundable credits',
    positive(minus(at('ON428.8'), creditCopy)),
    ['ON428.8', 'ON428.52'],
  );
  const withSplit = add(
    '55',
    'Ontario tax after excluded split-income tax',
    tax,
    ['ON428.53', 'fact:scope.noSpecialTaxes'],
  );
  const carryoverBase = add(
    '56',
    'Tax available for minimum-tax carryover',
    tax,
    ['ON428.53'],
  );
  const afterDividend = add(
    '58',
    'Tax after excluded dividend credit',
    carryoverBase,
    ['ON428.56', 'fact:scope.noOtherIncome', 'fact:scope.noOtherCredits'],
  );
  const federalCarryover = add(
    '59.base',
    'Federal minimum-tax carryover excluded by reviewed scope',
    q('0'),
    ['fact:scope.noSpecialTaxes'],
  );
  const provincialCarryover = add(
    '59',
    'Provincial minimum-tax carryover at printed 24.63% rate',
    times(federalCarryover, q('0.2463')),
    ['ON428.59.base'],
  );
  const carryover = add(
    '61540',
    'Allowable Ontario minimum-tax carryover',
    minimum(afterDividend, provincialCarryover),
    ['ON428.58', 'ON428.59'],
  );
  const net = add(
    '61',
    'Ontario tax after minimum-tax carryover',
    positive(minus(withSplit, carryover)),
    ['ON428.55', 'ON428.61540'],
  );
  const amount = add('62', 'Ontario tax carried to surtax page', net, [
    'ON428.61',
  ]);
  return { amount, dependencies: ['ON428.62'] };
}

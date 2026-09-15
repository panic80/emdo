import {
  decimal as q,
  plus,
  minus,
  positive,
  type PersonalExact,
} from './personal-exact.js';
/** Captured 5006-R E (25), PartC lines119–142. Caller must first validate
 * ordinary domestic income, no other credits/refunds and no special taxes.
 * Omitted terms retain explicit reviewed-scope dependencies. No rounding or
 * additional scope eligibility is inferred by this helper. */
export function appendCanada2025FederalTax(
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
      `T1.${line}`,
      label,
      amount,
      dependencies,
      'cra-5006-r-2025-etext',
      `5006-R E (25), PartC printed line${line}`,
    );
  const gross = add(
    '40400',
    'Federal tax after excluded split-income tax',
    at('T1.119'),
    ['T1.119', 'fact:scope.noSpecialTaxes'],
  );
  const credits = add(
    '122',
    'Non-refundable credits carried from line35000',
    at('T1.35000'),
    ['T1.35000'],
  );
  const totalCredits = add(
    '125',
    'Federal credits after excluded dividend credit and minimum-tax carryover',
    credits,
    [
      'T1.122',
      'fact:scope.noOtherIncome',
      'fact:scope.noOtherCredits',
      'fact:scope.noSpecialTaxes',
    ],
  );
  const copiedCredits = add(
    '125.copy2',
    'Federal credit subtotal carried across printed form',
    totalCredits,
    ['T1.125'],
  );
  const basic = add(
    '42900',
    'Basic federal tax',
    positive(minus(gross, copiedCredits)),
    ['T1.40400', 'T1.125.copy2'],
  );
  const afterForeignSurtax = add(
    '128',
    'Basic federal tax after excluded foreign-income surtax',
    basic,
    ['T1.42900', 'fact:scope.noSpecialReturns', 'fact:scope.noSpecialTaxes'],
  );
  const afterForeignCredit = add(
    '130',
    'Federal tax after excluded foreign tax credit',
    afterForeignSurtax,
    ['T1.128', 'fact:scope.noSpecialTaxes'],
  );
  const afterRecapture = add(
    '132',
    'Federal tax after excluded investment-credit recapture',
    afterForeignCredit,
    ['T1.130', 'fact:scope.noSpecialTaxes'],
  );
  const tax = add(
    '40600',
    'Federal tax after excluded logging tax credit',
    positive(afterRecapture),
    ['T1.132', 'fact:scope.noSpecialTaxes'],
  );
  const specialCredits = add(
    '41600',
    'Political, investment and labour-fund tax credits excluded by reviewed scope',
    q('0'),
    ['fact:scope.noOtherCredits', 'fact:scope.noSpecialTaxes'],
  );
  const copiedSpecialCredits = add(
    '41600.copy2',
    'Special credit subtotal carried across printed form',
    specialCredits,
    ['T1.41600'],
  );
  const netBeforeAdditions = add(
    '41700',
    'Federal tax after special credits',
    positive(minus(tax, copiedSpecialCredits)),
    ['T1.40600', 'T1.41600.copy2'],
  );
  const amount = add(
    '42000',
    'Net federal tax after excluded ACWB and special taxes',
    plus(netBeforeAdditions, q('0')),
    ['T1.41700', 'fact:scope.noOtherRefunds', 'fact:scope.noSpecialTaxes'],
  );
  return { amount, dependencies: ['T1.42000'] };
}

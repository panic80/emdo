import {
  decimal as q,
  plus,
  minus,
  positive,
  times,
} from './personal-exact.js';
import type { appendCanada2025FederalTax } from './personal-federal-tax.js';
import type { PersonalExact } from './personal-exact.js';

export type Canada2025FederalDonationCreditInput = {
  /** Schedule 9 line 23 transferred to T1 line 34900. */
  line34900: PersonalExact;
  /** Schedule 9 line 22 used by the federal top-up worksheet. */
  line22: PersonalExact;
  dependencies: string[];
};
/** Printed 5006-R Part B subtotals and 5000-D1 line34990 worksheet.
 * Caller validates the existing ordinary scope. Omitted claims retain reviewed
 * scope dependencies; exact arithmetic never supplies a rounding convention. */
export function appendCanada2025FederalCredits(
  at: Parameters<typeof appendCanada2025FederalTax>[0],
  field: Parameters<typeof appendCanada2025FederalTax>[1],
  donation: Canada2025FederalDonationCreditInput | undefined = undefined,
) {
  const add = (
    line: string,
    label: string,
    value: ReturnType<typeof q>,
    dependencies: string[],
  ) =>
    field(
      `T1.${line}`,
      label,
      value,
      dependencies,
      'cra-5006-r-2025-etext',
      `5006-R E (25), Part B printed line ${line}`,
    );
  add('84', 'Basic and personal credit subtotal', at('T1.30000'), [
    'T1.30000',
    'fact:scope.singleNoDependants',
    'fact:scope.noOtherCredits',
  ]);
  add(
    '85',
    'Personal credit subtotal carried from previous page',
    at('T1.84'),
    ['T1.84'],
  );
  add(
    '96',
    'CPP, EI and employment credit subtotal',
    plus(at('T1.30800'), at('T1.31000'), at('T1.31200'), at('T1.31260')),
    [
      'T1.30800',
      'T1.31000',
      'T1.31200',
      'T1.31260',
      'fact:scope.noOtherCredits',
      'fact:scope.noEiSpecialBenefitsAgreement',
    ],
  );
  add(
    '96.copy2',
    'Contribution and employment subtotal carried across form',
    at('T1.96'),
    ['T1.96'],
  );
  add(
    '98',
    'Personal, contribution and pension credit subtotal',
    plus(at('T1.85'), at('T1.96.copy2')),
    ['T1.85', 'T1.96.copy2', 'fact:scope.noOtherCredits'],
  );
  add('101', 'Credit subtotal after excluded disability claims', at('T1.98'), [
    'T1.98',
    'fact:scope.noOtherCredits',
  ]);
  add('106', 'Credit subtotal before medical expenses', at('T1.101'), [
    'T1.101',
    'fact:scope.noOtherCredits',
    'fact:scope.singleNoDependants',
  ]);
  add(
    '33500',
    'Eligible non-refundable credit amounts',
    plus(at('T1.106'), at('T1.33200')),
    ['T1.106', 'T1.33200'],
  );
  add(
    '33800',
    'Federal credit at printed 14.5 percent rate',
    times(at('T1.33500'), q('0.145')),
    ['T1.33500'],
  );
  const worksheet = (
    line: string,
    label: string,
    value: ReturnType<typeof q>,
    dependencies: string[],
  ) =>
    field(
      `FederalTopUp.${line}`,
      label,
      value,
      dependencies,
      'cra-5000-d1-2025-etext',
      `5000-D1 E (25), line34990 worksheet line ${line}`,
    );
  worksheet(
    '1',
    'Federal non-refundable credit before top-up',
    at('T1.33800'),
    ['T1.33800'],
  );
  worksheet(
    '2',
    donation
      ? 'Schedule 9 line 22 low-rate donation amount'
      : 'Schedule9 line22 excluded by reviewed no-donation scope',
    donation?.line22 ?? q('0'),
    donation?.dependencies ?? ['fact:scope.noOtherCredits'],
  );
  worksheet(
    '3',
    'Credit and donation subtotal',
    plus(at('FederalTopUp.1'), at('FederalTopUp.2')),
    ['FederalTopUp.1', 'FederalTopUp.2'],
  );
  worksheet('4', 'Printed top-up threshold', q('8319.38'), []);
  worksheet(
    '5',
    'Credit subtotal above threshold',
    positive(minus(at('FederalTopUp.3'), at('FederalTopUp.4'))),
    ['FederalTopUp.3', 'FederalTopUp.4'],
  );
  worksheet(
    '7',
    'Top-up at printed 3.45 percent rate',
    times(at('FederalTopUp.5'), q('0.0345')),
    ['FederalTopUp.5'],
  );
  add(
    '34990',
    'Top-up tax credit transferred from worksheet',
    at('FederalTopUp.7'),
    ['FederalTopUp.7'],
  );
  add(
    '35000',
    'Total federal non-refundable tax credits',
    plus(at('T1.33800'), donation?.line34900 ?? q('0'), at('T1.34990')),
    [
      'T1.33800',
      ...(donation ? ['T1.34900'] : []),
      'T1.34990',
      'fact:scope.noOtherCredits',
    ],
  );
}

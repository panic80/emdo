import {
  decimal as q,
  plus,
  minus,
  times,
  positive,
  minimum,
  compare,
  type PersonalExact,
} from './personal-exact.js';

type Field = (
  id: string,
  label: string,
  value: PersonalExact,
  dependencies: string[],
  sourceId?: string,
  locator?: string,
) => PersonalExact;
/** Reviewed self-only eligible expenses; caller validates the annual scope and receipt guards. */
export function appendCanada2025MedicalCredits(
  at: (id: string) => PersonalExact,
  field: Field,
  expenses: PersonalExact,
) {
  const guards = [
    'fact:medical.eligibleSelfExpenses',
    'fact:scope.medicalEligibleUnreimbursed',
    'fact:scope.medicalSamePeriodNotPreviouslyClaimed',
    'fact:scope.medicalNoOntarioSpecialCategories',
    'fact:scope.singleNoDependants',
  ];
  for (const [
    prefix,
    expense,
    netLine,
    threshold,
    remainder,
    total,
    cap,
    source,
  ] of [
    [
      'T1',
      '33099',
      '108',
      '109',
      '110',
      '33200',
      '2834',
      'cra-5006-r-2025-etext',
    ],
    [
      'ON428',
      '58689',
      '39',
      '40',
      '41',
      '58769',
      '2885',
      'cra-5006-c-2025-etext',
    ],
  ]) {
    const id = (line: string) => `${prefix}.${line}`;
    field(
      id(expense!),
      'Reviewed eligible self medical expenses',
      expenses,
      guards,
      source,
      `${prefix} medical expenses`,
    );
    field(
      id(netLine!),
      'Three percent of net income',
      times(at('T1.23600'), q('0.03')),
      ['T1.23600'],
      source,
      `${prefix} medical net-income threshold`,
    );
    field(
      id(threshold!),
      'Medical expense threshold',
      minimum(at(id(netLine!)), q(cap!)),
      [id(netLine!)],
      source,
      `${prefix} annual medical threshold cap ${cap}`,
    );
    field(
      id(remainder!),
      'Eligible expenses less threshold',
      positive(minus(expenses, at(id(threshold!)))),
      compare(expenses, q('0')) === 0n
        ? [id(expense!)]
        : [id(expense!), id(threshold!)],
      source,
      `${prefix} medical remainder`,
    );
    field(
      id(total!),
      'Allowable self medical expense amount',
      at(id(remainder!)),
      [id(remainder!), 'fact:scope.singleNoDependants'],
      source,
      `${prefix} medical total; other dependants excluded`,
    );
  }
}

/** Federal Worksheet line45200; age/residency are explicit, never inferred from income. */
export function appendCanada2025MedicalSupplement(
  at: (id: string) => PersonalExact,
  field: Field,
  applicability: { fullYearCanadianResident: boolean; ageAtLeast18: boolean },
) {
  const source = 'cra-5000-d1-2025-etext';
  const add = (
    line: string,
    label: string,
    value: PersonalExact,
    dependencies: string[],
  ) =>
    field(
      `MedicalSupplement.${line}`,
      label,
      value,
      dependencies,
      source,
      `Federal Worksheet line45200: ${line}`,
    );
  const employment = add(
    'employment',
    'Employment income less eligible deductions',
    positive(minus(at('T1.10100'), at('T1.21200'))),
    [
      'T1.10100',
      'T1.21200',
      'fact:scope.noOtherDeductions',
      'fact:scope.noOtherIncome',
    ],
  );
  const working = add(
    'workingIncome',
    'Qualifying employment and positive business/commission income',
    plus(employment, positive(at('T1.13500')), positive(at('T1.13900'))),
    ['MedicalSupplement.employment', 'T1.13500', 'T1.13900'],
  );
  const family = add(
    '6',
    'Adjusted family net income, single reviewed scope',
    at('T1.23600'),
    [
      'T1.23600',
      'fact:scope.singleNoDependants',
      'fact:scope.noOtherIncome',
      'fact:scope.noOtherDeductions',
    ],
  );
  const excess = add(
    '8',
    'Income exceeding annual threshold',
    positive(minus(family, q('33294'))),
    ['MedicalSupplement.6'],
  );
  const pool = add(
    '11',
    'Allowable medical amount; disability supports excluded',
    at('T1.33200'),
    ['T1.33200', 'fact:scope.noOtherDeductions'],
  );
  const percentage = add(
    '13',
    'Twenty-five percent of allowable expenses',
    times(pool, q('0.25')),
    ['MedicalSupplement.11'],
  );
  const capped = add(
    '14',
    'Supplement before income reduction',
    minimum(percentage, q('1504')),
    ['MedicalSupplement.13'],
  );
  const reduction = add(
    '15',
    'Five percent income reduction',
    times(excess, q('0.05')),
    ['MedicalSupplement.8'],
  );
  const candidate = add(
    '16',
    'Supplement after income reduction',
    positive(minus(capped, reduction)),
    ['MedicalSupplement.14', 'MedicalSupplement.15'],
  );
  const eligible =
    applicability.fullYearCanadianResident &&
    applicability.ageAtLeast18 &&
    compare(working, q('4390')) >= 0n &&
    compare(family, q('63374')) < 0n &&
    compare(pool, q('0')) > 0n;
  field(
    'T1.45200',
    'Refundable medical expense supplement',
    eligible ? candidate : q('0'),
    [
      'MedicalSupplement.16',
      'T1.10100',
      'T1.21200',
      'T1.13500',
      'T1.13900',
      'fact:scope.noOtherIncome',
      'fact:scope.noOtherDeductions',
      'MedicalSupplement.6',
      'MedicalSupplement.11',
      'fact:dateOfBirth',
      'fact:scope.noSpecialReturns',
    ],
    source,
    'Federal Worksheet line45200: eligibility and line16',
  );
}

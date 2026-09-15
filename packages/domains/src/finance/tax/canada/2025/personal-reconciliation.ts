import {
  decimal,
  minus,
  plus,
  positive,
  type PersonalExact,
} from './personal-exact.js';
type At = (id: string) => PersonalExact;
type Field = (
  id: string,
  label: string,
  value: PersonalExact,
  dependencies: string[],
  sourceId?: string,
  locator?: string,
) => PersonalExact;
/** Caller validates reviewed ordinary-return scope. No refund donation is inferred. */
export function appendCanada2025PersonalReconciliation(at: At, field: Field) {
  const add = (
    line: string,
    label: string,
    value: PersonalExact,
    dependencies: string[],
  ) =>
    field(
      `T1.${line}`,
      label,
      value,
      dependencies,
      'cra-5006-r-2025-etext',
      `2025 T1 Step 6 line ${line}`,
    );
  add('143', 'Net federal tax carried to Step 6', at('T1.42000'), ['T1.42000']);
  add(
    '43500',
    'Total payable working figure',
    plus(
      at('T1.143'),
      at('T1.42100'),
      at('T1.42120'),
      at('T1.42200'),
      at('T1.42800'),
    ),
    [
      'T1.143',
      'T1.42100',
      'T1.42120',
      'T1.42200',
      'T1.42800',
      'fact:scope.noEiSpecialBenefitsAgreement',
      'fact:scope.noOtherIncome',
      'fact:scope.noOtherRefunds',
    ],
  );
  add('149', 'Total payable carried to reconciliation', at('T1.43500'), [
    'T1.43500',
  ]);
  const credits = [
    'T1.43700',
    'T1.44000',
    'T1.44800',
    'T1.45000',
    'T1.45200',
    'T1.45300',
    'T1.45350',
    'T1.45355',
    'T1.45400',
    'T1.45600',
    'T1.45700',
    'T1.46900',
    'T1.47555',
    'T1.47556',
    'T1.47600',
    'T1.47900',
  ];
  add('48200', 'Total credits working figure', plus(...credits.map(at)), [
    ...credits,
    'fact:scope.noOtherRefunds',
  ]);
  add('166', 'Total credits carried to reconciliation', at('T1.48200'), [
    'T1.48200',
  ]);
  const difference = add(
    '167',
    'Unrounded reconciliation working figure',
    minus(at('T1.149'), at('T1.166')),
    ['T1.149', 'T1.166'],
  );
  add(
    '48400',
    'Gross refund before any Ontario opportunities fund choice',
    positive(minus(decimal('0'), difference)),
    ['T1.167'],
  );
  add('48500', 'Balance owing working figure', positive(difference), [
    'T1.167',
  ]);
}

import {
  decimal,
  plus,
  minus,
  times,
  positive,
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
type At = (id: string) => PersonalExact;
const writer =
  (field: Field) =>
  (line: string, label: string, value: PersonalExact, dependencies: string[]) =>
    field(
      `ON428.${line}`,
      label,
      value,
      dependencies,
      'cra-5006-c-2025-etext',
      `2025 ON428 printed line${line}`,
    );
/** Caller validates full-year residency, no special returns/taxes and no dependants.
 * Eligibility is bound to reviewed scope facts, not inferred from monetary totals. */
export function appendCanada2025OntarioReduction(at: At, field: Field) {
  const add = writer(field);
  const basic = add('74', 'Ontario basic tax reduction', decimal('294'), [
    'fact:scope.noSpecialReturns',
    'fact:scope.noSpecialTaxes',
  ]);
  const total = add('77', 'Ontario reduction total with no dependants', basic, [
    'ON428.74',
    'fact:scope.singleNoDependants',
  ]);
  const repeated = add('78.base', 'Reduction total carried to line78', total, [
    'ON428.77',
  ]);
  const doubled = add(
    '78',
    'Twice the reduction total',
    times(repeated, decimal('2')),
    ['ON428.78.base'],
  );
  const tax = add(
    '79',
    'Tax before reduction carried from line73',
    at('ON428.73'),
    ['ON428.73'],
  );
  const reduction = add(
    '80',
    'Ontario tax reduction',
    positive(minus(doubled, tax)),
    ['ON428.78', 'ON428.79'],
  );
  const reductionCopy = add(
    '80.copy2',
    'Ontario reduction carried to line81',
    reduction,
    ['ON428.80'],
  );
  const after = add(
    '81',
    'Ontario tax after reduction',
    positive(minus(at('ON428.73'), reductionCopy)),
    ['ON428.73', 'ON428.80.copy2'],
  );
  const afterForeign = add(
    '83',
    'Ontario tax after excluded foreign tax credit',
    after,
    ['ON428.81', 'fact:scope.noSpecialTaxes'],
  );
  add('84', 'Ontario tax carried from line83', afterForeign, ['ON428.83']);
}
/** Run after the LIFT and health-premium schedules; no other provincial credits. */
export function appendCanada2025OntarioFinalTax(at: At, field: Field) {
  const add = writer(field);
  const afterLift = add(
    '86',
    'Ontario tax after LIFT credit',
    positive(minus(at('ON428.84'), at('ON428.62140'))),
    ['ON428.84', 'ON428.62140'],
  );
  const afterFood = add(
    '88',
    'Ontario tax after excluded food-donation credit',
    afterLift,
    ['ON428.86', 'fact:scope.noOtherCredits'],
  );
  return add(
    '90',
    'Ontario tax transferred to T1 line42800',
    plus(afterFood, at('ON428.89')),
    ['ON428.88', 'ON428.89'],
  );
}

import {
  decimal as q,
  plus,
  minus,
  times,
  compare,
  type PersonalExact,
} from './personal-exact.js';

// Captured 5006-C E (25), page 4: line 1 is taxable income from T1 line26000.
// Rows 2,4,6,8,10 contain editable operands; plateau rows contain printed constants.
const rows = [
  ['20000', '0', '0', '0'],
  ['25000', '20000', '0.06', '0'],
  ['36000', '25000', '0', '300'],
  ['38500', '36000', '0.06', '300'],
  ['48000', '38500', '0', '450'],
  ['48600', '48000', '0.25', '450'],
  ['72000', '48600', '0', '600'],
  ['72600', '72000', '0.25', '600'],
  ['200000', '72600', '0', '750'],
  ['200600', '200000', '0.25', '750'],
  [null, '200600', '0', '900'],
] as const;
export function canada2025OntarioHealthPremiumRow(income: PersonalExact) {
  return (
    rows.findIndex(
      (row) => row[0] === null || compare(income, q(row[0])) <= 0n,
    ) + 1
  );
}
export function appendCanada2025OntarioHealthPremium(
  at: (id: string) => PersonalExact,
  field: (
    id: string,
    label: string,
    value: PersonalExact,
    dependencies: string[],
    sourceId?: string,
    locator?: string,
  ) => PersonalExact,
) {
  const add = (
    id: string,
    label: string,
    amount: PersonalExact,
    dependencies: string[],
  ) =>
    field(
      id,
      label,
      amount,
      dependencies,
      'cra-5006-c-2025-etext',
      '5006-C E (25), page4 Ontario health premium worksheet',
    );
  const income = add(
    'ONHealthPremium.1',
    'Taxable income from T1 line26000',
    at('T1.26000'),
    ['T1.26000'],
  );
  const row = canada2025OntarioHealthPremiumRow(income);
  const [, threshold, rate, base] = rows[row - 1]!;
  if (rate === '0')
    return { amount: q(base), dependencies: ['ONHealthPremium.1'], row };
  const prefix = `ONHealthPremium.row${row}`;
  const selectedIncome = add(
    `${prefix}.income`,
    `Row ${row}: taxable income`,
    income,
    ['ONHealthPremium.1'],
  );
  const excess = add(
    `${prefix}.excess`,
    `Row ${row}: taxable income less ${threshold}`,
    minus(selectedIncome, q(threshold)),
    [`${prefix}.income`],
  );
  const product = add(
    `${prefix}.rateProduct`,
    `Row ${row}: excess multiplied by ${rate}`,
    times(excess, q(rate)),
    [`${prefix}.excess`],
  );
  if (row === 2)
    return { amount: product, dependencies: [`${prefix}.rateProduct`], row };
  const amount = add(
    `${prefix}.total`,
    `Row ${row}: product plus ${base}`,
    plus(product, q(base)),
    [`${prefix}.rateProduct`],
  );
  return { amount, dependencies: [`${prefix}.total`], row };
}

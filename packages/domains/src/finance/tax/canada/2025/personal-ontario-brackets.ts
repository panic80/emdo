import { ONTARIO_2025_FORM_COLUMNS } from './components.js';
import {
  decimal as q,
  plus,
  minus,
  times,
  positive,
  compare,
  type PersonalExact,
} from './personal-exact.js';

/** The captured ON428 PartA columns contain editable lines2/4/6/8.
 * Lines3/5/7 are immutable source thresholds/rates/base amounts, not CAD inputs.
 * The caller uses the returned dependency for the printed line51 transfer. */
export function canada2025OntarioBracketColumn(income: PersonalExact) {
  return (
    ONTARIO_2025_FORM_COLUMNS.findIndex(
      (column) =>
        column.maximum === null || compare(income, q(column.maximum)) <= 0n,
    ) + 1
  );
}
export function appendCanada2025OntarioBrackets(
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
    id: string,
    label: string,
    amount: PersonalExact,
    dependencies: string[],
    locator: string,
  ) => field(id, label, amount, dependencies, 'cra-5006-c-2025-etext', locator);
  const income = add(
    'ON428.1',
    'Taxable income from T1 line26000',
    at('T1.26000'),
    ['T1.26000'],
    'ON428 PartA line1',
  );
  const column = canada2025OntarioBracketColumn(income);
  const constants = ONTARIO_2025_FORM_COLUMNS[column - 1]!;
  const prefix = `ONBracket.column${column}`;
  const selectedIncome = add(
    `${prefix}.2`,
    'Selected column taxable income',
    income,
    ['ON428.1'],
    `ON428 PartA column${column} line2`,
  );
  const excess = add(
    `${prefix}.4`,
    'Taxable income less printed threshold',
    positive(minus(selectedIncome, q(constants.threshold))),
    [`${prefix}.2`],
    `ON428 PartA column${column} line4; line3 printed threshold ${constants.threshold}`,
  );
  const product = add(
    `${prefix}.6`,
    'Tax on income above printed threshold',
    times(excess, q(constants.rate)),
    [`${prefix}.4`],
    `ON428 PartA column${column} line6; line5 printed rate ${constants.rate}`,
  );
  const amount = add(
    `${prefix}.8`,
    'Ontario tax on taxable income',
    plus(product, q(constants.base)),
    [`${prefix}.6`],
    `ON428 PartA column${column} line8; line7 printed base ${constants.base}`,
  );
  return { amount, dependencies: [`${prefix}.8`], column };
}

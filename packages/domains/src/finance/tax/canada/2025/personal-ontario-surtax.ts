import {
  decimal as q,
  plus,
  minus,
  times,
  positive,
  compare,
  type PersonalExact,
} from './personal-exact.js';

/** Captured 5006-C E (25), page 3, lines63–73. Caller must first validate
 * reviewed noSpecialTaxes, noOtherIncome and noOtherCredits declarations.
 * Their dependencies bind omitted TOSI, dividend-credit and minimum-tax terms.
 * Unselected lines66/67 are not emitted. Fractional cents are never rounded. */
export function appendCanada2025OntarioSurtax(
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
      `5006-C E (25), page3 line${line}`,
    );
  const base = add('63', 'Ontario tax before surtax', at('ON428.62'), [
    'ON428.62',
  ]);
  const surtaxBase = add(
    '65',
    'Surtax base after excluded split-income tax',
    base,
    ['ON428.63', 'fact:scope.noSpecialTaxes'],
  );
  const surtaxApplies = compare(surtaxBase, q('5710')) > 0n;
  let surtax = q('0');
  let surtaxDependencies = ['ON428.65'];
  if (surtaxApplies) {
    const firstBase = add(
      '66.base',
      'Line65 carried to first surtax calculation',
      surtaxBase,
      ['ON428.65'],
    );
    const first = add(
      '66',
      'First surtax: 20% of base above5710',
      positive(times(minus(firstBase, q('5710')), q('0.20'))),
      ['ON428.66.base'],
    );
    const secondBase = add(
      '67.base',
      'Line65 carried to second surtax calculation',
      surtaxBase,
      ['ON428.65'],
    );
    const second = add(
      '67',
      'Second surtax: 36% of base above7307',
      positive(times(minus(secondBase, q('7307')), q('0.36'))),
      ['ON428.67.base'],
    );
    surtax = plus(first, second);
    surtaxDependencies = ['ON428.66', 'ON428.67'];
  }
  const total = add('68', 'Ontario surtax', surtax, surtaxDependencies);
  const copiedTotal = add(
    '68.copy2',
    'Ontario surtax carried across printed form',
    total,
    ['ON428.68'],
  );
  const afterSurtax = add(
    '69',
    'Ontario tax plus surtax',
    plus(at('ON428.62'), copiedTotal),
    ['ON428.62', 'ON428.68.copy2'],
  );
  const afterDividendCredit = add(
    '71',
    'Ontario tax after excluded dividend credit',
    afterSurtax,
    ['ON428.69', 'fact:scope.noOtherIncome', 'fact:scope.noOtherCredits'],
  );
  const amount = add(
    '73',
    'Ontario tax before tax reduction',
    afterDividendCredit,
    ['ON428.71', 'fact:scope.noSpecialTaxes'],
  );
  return { amount, dependencies: ['ON428.73'], surtaxApplies };
}

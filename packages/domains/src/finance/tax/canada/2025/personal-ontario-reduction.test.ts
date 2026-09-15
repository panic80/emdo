import { describe, expect, it } from 'vitest';
import { decimal, serialize, type PersonalExact } from './personal-exact.js';
import {
  appendCanada2025OntarioReduction,
  appendCanada2025OntarioFinalTax,
} from './personal-ontario-reduction.js';
function calculate(tax: string, lift: string, health: string) {
  const values = new Map<string, PersonalExact>([
    ['ON428.73', decimal(tax)],
    ['ON428.62140', decimal(lift)],
    ['ON428.89', decimal(health)],
  ]);
  const dependencies = new Map<string, string[]>();
  const at = (id: string) => {
    const value = values.get(id);
    if (!value) throw Error(`missing:${id}`);
    return value;
  };
  const field = (
    id: string,
    _label: string,
    value: PersonalExact,
    deps: string[],
  ) => {
    values.set(id, value);
    dependencies.set(id, deps);
    return value;
  };
  appendCanada2025OntarioReduction(at, field);
  appendCanada2025OntarioFinalTax(at, field);
  return {
    amount: (id: string) => serialize(at(id)).exactDecimal,
    dependencies,
  };
}
describe('Ontario reduction and final tax printed transfers', () => {
  it.each([
    ['0', '0', '0', '588', '0'],
    ['294', '0', '300', '294', '300'],
    ['400', '0', '300', '188', '512'],
    ['588', '100', '300', '0', '788'],
    ['1000', '2000', '750', '0', '750'],
    ['587.99', '0', '0', '0.01', '587.98'],
  ])(
    'transfers tax%s LIFT%s health%s',
    (tax, lift, health, reduction, total) => {
      const result = calculate(tax, lift, health);
      expect(result.amount('ON428.80')).toBe(reduction);
      expect(result.amount('ON428.90')).toBe(total);
      expect(result.amount('ON428.78.base')).toBe('294');
      expect(result.amount('ON428.78')).toBe('588');
      expect(result.dependencies.get('ON428.77')).toContain(
        'fact:scope.singleNoDependants',
      );
      expect(result.dependencies.get('ON428.83')).toContain(
        'fact:scope.noSpecialTaxes',
      );
      expect(result.dependencies.get('ON428.88')).toContain(
        'fact:scope.noOtherCredits',
      );
    },
  );
  it('does not round fractional intermediates or missing inputs', () => {
    expect(calculate('400.001', '0', '0').amount('ON428.90')).toBe('212.002');
    expect(() =>
      appendCanada2025OntarioFinalTax(
        () => {
          throw Error('missing');
        },
        () => decimal('0'),
      ),
    ).toThrow('missing');
  });
});

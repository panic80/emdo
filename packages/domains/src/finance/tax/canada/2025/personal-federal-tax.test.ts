import { describe, it, expect } from 'vitest';
import { appendCanada2025FederalTax } from './personal-federal-tax.js';
import {
  decimal as q,
  serialize,
  type PersonalExact,
} from './personal-exact.js';
import { applyCanadaPersonalPaperReporting } from './personal-reporting.js';
import type { PersonalFormField } from './personal-package.js';
function calculate(tax: string, credits: string) {
  const values = new Map<string, PersonalExact>();
  const fields: PersonalFormField[] = [];
  const field: Parameters<typeof appendCanada2025FederalTax>[1] = (
    id,
    label,
    value,
    dependencies,
    sourceId = 'cra-5006-r-2025-etext',
    locator = 'synthetic reviewed federal fixture',
  ) => {
    values.set(id, value);
    const [form, ...line] = id.split('.');
    fields.push({
      id,
      form: form!,
      line: line.join('.'),
      label,
      dependencies,
      sourceId,
      locator,
      ...serialize(value),
      reportableAmount: null,
    });
    return value;
  };
  field('T1.119', 'Tax from PartA', q(tax), []);
  field('T1.35000', 'Nonrefundable credits', q(credits), []);
  appendCanada2025FederalTax((id) => {
    const value = values.get(id);
    if (!value) throw Error(id);
    return value;
  }, field);
  const output = applyCanadaPersonalPaperReporting(fields, false);
  return {
    fields: output,
    at: (id: string) => output.find((f) => f.id === id)!,
  };
}
describe('ordinary federal PartC connected tax graph', () => {
  it.each([
    ['5000', '2000', '3000'],
    ['2000', '5000', '0'],
    ['2000', '2000', '0'],
    ['2000.01', '2000', '0.01'],
  ] as const)(
    'carries taxable-income tax%s less credits%s',
    (tax, credit, net) => {
      const run = calculate(tax, credit);
      expect(run.at('T1.40400').exactDecimal).toBe(tax);
      for (const id of ['122', '125', '125.copy2'])
        expect(run.at(`T1.${id}`).exactDecimal).toBe(credit);
      for (const id of [
        '42900',
        '128',
        '130',
        '132',
        '40600',
        '41700',
        '42000',
      ])
        expect(run.at(`T1.${id}`).exactDecimal).toBe(net);
      expect(run.at('T1.41600').exactDecimal).toBe('0');
      expect(run.at('T1.41600.copy2').exactDecimal).toBe('0');
      expect(
        run.fields.every((f) => f.reporting.status === 'lossless-cents'),
      ).toBe(true);
    },
  );
  it('binds omission guards and repeated source fields without shortcutting PartC', () => {
    const run = calculate('5000', '2000');
    expect(run.at('T1.40400').dependencies).toContain(
      'fact:scope.noSpecialTaxes',
    );
    expect(run.at('T1.125').dependencies).toContain('fact:scope.noOtherIncome');
    expect(run.at('T1.125').dependencies).toContain(
      'fact:scope.noOtherCredits',
    );
    expect(run.at('T1.128').dependencies).toContain(
      'fact:scope.noSpecialReturns',
    );
    expect(run.at('T1.42000').dependencies).toEqual([
      'T1.41700',
      'fact:scope.noOtherRefunds',
      'fact:scope.noSpecialTaxes',
    ]);
    expect(run.at('T1.125').reporting.fieldPath).toBe(
      'form1.Page7.PartC.Line130.Amount1',
    );
    expect(run.at('T1.125.copy2').reporting.fieldPath).toBe(
      'form1.Page7.PartC.Line130.Amount2',
    );
    expect(run.at('T1.41600.copy2').reporting.fieldPath).toBe(
      'form1.Page7.PartC.Line41600.Line_41600_Amount2',
    );
  });
  it('keeps unproven upstream subcents blocked even when final tax floors to zero', () => {
    const run = calculate('2000.001', '5000');
    expect(run.at('T1.119').reporting.status).toBe('rounding-unproven');
    expect(run.at('T1.42900').exactDecimal).toBe('0');
    expect(run.at('T1.42000').reportableAmount).toBeNull();
    expect(run.at('T1.42000').reporting.status).toBe('dependency-unresolved');
  });
});

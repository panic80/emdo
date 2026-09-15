import { describe, it, expect } from 'vitest';
import { appendCanada2025OntarioCredits } from './personal-ontario-credits.js';
import {
  decimal as q,
  serialize,
  type PersonalExact,
} from './personal-exact.js';
import { applyCanadaPersonalPaperReporting } from './personal-reporting.js';
import type { PersonalFormField } from './personal-package.js';
function calculate(tax: string, medical = '0') {
  const values = new Map<string, PersonalExact>();
  const fields: PersonalFormField[] = [];
  const field: Parameters<typeof appendCanada2025OntarioCredits>[1] = (
    id,
    label,
    value,
    dependencies,
    sourceId = 'cra-5006-c-2025-etext',
    locator = 'synthetic reviewed credit fixture',
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
  for (const [id, amount] of Object.entries({
    'ON428.8': tax,
    'ON428.58040': '12747',
    'ON428.58240': '200',
    'ON428.58280': '0',
    'ON428.58300': '53',
    'ON428.58769': medical,
  }))
    field(id, 'Reviewed source credit', q(amount), []);
  const result = appendCanada2025OntarioCredits((id) => {
    const value = values.get(id);
    if (!value) throw Error(id);
    return value;
  }, field);
  const output = applyCanadaPersonalPaperReporting(fields, false);
  return {
    ...result,
    fields: output,
    at: (id: string) => output.find((f) => f.id === id)!,
  };
}
describe('Ontario credits through tax before surtax', () => {
  it('carries all subtotals, exact credit and minimum-tax calculation to line62', () => {
    const run = calculate('2000');
    for (const [id, expected] of Object.entries({
      '18': '12747',
      '24': '253',
      '24.copy2': '253',
      '25': '13000',
      '26': '13000',
      '28': '13000',
      '31': '13000',
      '35': '13000',
      '58800': '13000',
      '58840': '656.5',
      '61500': '656.5',
      '52': '656.5',
      '53': '1343.5',
      '55': '1343.5',
      '56': '1343.5',
      '58': '1343.5',
      '59.base': '0',
      '59': '0',
      '61540': '0',
      '61': '1343.5',
      '62': '1343.5',
    }))
      expect(run.at(`ON428.${id}`).exactDecimal, id).toBe(expected);
    expect(
      run.fields.every((f) => f.reporting.status === 'lossless-cents'),
    ).toBe(true);
    expect(run.at('ON428.24').reporting.fieldPath).toBe(
      'form1.Page1.Part_B.Line24.Amount1',
    );
    expect(run.at('ON428.24.copy2').reporting.fieldPath).toBe(
      'form1.Page1.Part_B.Line24.Amount2',
    );
    expect(run.at('ON428.61540').dependencies).toEqual([
      'ON428.58',
      'ON428.59',
    ]);
    expect(run.at('ON428.62').dependencies).toEqual(['ON428.61']);
  });
  it.each([
    ['0', '0'],
    ['600', '0'],
    ['656.5', '0'],
    ['656.51', '0.01'],
  ] as const)('floors tax %s after non-refundable credits', (tax, net) => {
    expect(calculate(tax).at('ON428.62').exactDecimal).toBe(net);
  });
  it('binds every omitted source term to its existing reviewed scope and preserves subcent blockers', () => {
    const run = calculate('2000', '0.01');
    expect(run.at('ON428.18').dependencies).toContain(
      'fact:scope.singleNoDependants',
    );
    expect(run.at('ON428.24').dependencies).toContain(
      'fact:scope.noEiSpecialBenefitsAgreement',
    );
    for (const line of ['28', '31', '35', '61500'])
      expect(run.at(`ON428.${line}`).dependencies).toContain(
        'fact:scope.noOtherCredits',
      );
    expect(run.at('ON428.55').dependencies).toContain(
      'fact:scope.noSpecialTaxes',
    );
    expect(run.at('ON428.58').dependencies).toContain(
      'fact:scope.noOtherIncome',
    );
    expect(run.at('ON428.59.base').dependencies).toEqual([
      'fact:scope.noSpecialTaxes',
    ]);
    expect(run.at('ON428.58840').exactDecimal).toBe('656.500505');
    expect(run.at('ON428.58840').reporting.status).toBe('rounding-unproven');
    expect(run.at('ON428.62').reporting.status).toBe('dependency-unresolved');
    expect(run.at('ON428.62').reportableAmount).toBeNull();
  });
});

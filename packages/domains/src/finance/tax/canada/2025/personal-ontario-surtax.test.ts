import { describe, it, expect } from 'vitest';
import { appendCanada2025OntarioSurtax } from './personal-ontario-surtax.js';
import {
  decimal as q,
  serialize,
  type PersonalExact,
} from './personal-exact.js';
import { applyCanadaPersonalPaperReporting } from './personal-reporting.js';
import type { PersonalFormField } from './personal-package.js';
function calculate(base: string) {
  const values = new Map<string, PersonalExact>();
  const fields: PersonalFormField[] = [];
  const field: Parameters<typeof appendCanada2025OntarioSurtax>[1] = (
    id,
    label,
    value,
    dependencies,
    sourceId = 'cra-5006-c-2025-etext',
    locator = 'synthetic reviewed line62 fixture',
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
  field('ON428.62', 'Reviewed Ontario tax', q(base), []);
  const result = appendCanada2025OntarioSurtax((id) => {
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
describe('Ontario surtax printed dependency graph', () => {
  it.each([
    ['0', '0', '0', false],
    ['5710', '0', '5710', false],
    ['5710.01', '0.002', '5710.012', true],
    ['6000', '58', '6058', true],
    ['7307', '319.4', '7626.4', true],
    ['7307.01', '319.4056', '7626.4156', true],
    ['7308', '319.96', '7627.96', true],
    ['8000', '707.48', '8707.48', true],
    ['10000', '1827.48', '11827.48', true],
  ] as const)(
    'carries line62 %s to exact surtax %s',
    (base, surtax, total, active) => {
      const run = calculate(base);
      expect(run.surtaxApplies).toBe(active);
      expect(run.at('ON428.63').exactDecimal).toBe(base);
      expect(run.at('ON428.65').exactDecimal).toBe(base);
      expect(run.at('ON428.68').exactDecimal).toBe(surtax);
      expect(run.at('ON428.68.copy2').exactDecimal).toBe(surtax);
      for (const line of ['69', '71', '73'])
        expect(run.at(`ON428.${line}`).exactDecimal).toBe(total);
      expect(run.fields.some((f) => f.id === 'ON428.66.base')).toBe(active);
      expect(run.fields.some((f) => f.id === 'ON428.67.base')).toBe(active);
      expect(run.fields).toHaveLength(active ? 12 : 8);
    },
  );
  it('binds both printed copies and omitted terms to exact upstream and reviewed-scope dependencies', () => {
    const run = calculate('8000');
    expect(run.at('ON428.66').exactDecimal).toBe('458');
    expect(run.at('ON428.67').exactDecimal).toBe('249.48');
    expect(run.at('ON428.66.base').dependencies).toEqual(['ON428.65']);
    expect(run.at('ON428.67.base').dependencies).toEqual(['ON428.65']);
    expect(run.at('ON428.65').dependencies).toContain(
      'fact:scope.noSpecialTaxes',
    );
    expect(run.at('ON428.71').dependencies).toEqual([
      'ON428.69',
      'fact:scope.noOtherIncome',
      'fact:scope.noOtherCredits',
    ]);
    expect(run.at('ON428.73').dependencies).toContain(
      'fact:scope.noSpecialTaxes',
    );
    expect(run.at('ON428.68').reporting.fieldPath).toBe(
      'form1.Page3.Line68.Amount1',
    );
    expect(run.at('ON428.68.copy2').reporting.fieldPath).toBe(
      'form1.Page3.Line68.Amount2',
    );
    expect(
      run.fields.every((f) => f.reporting.status === 'lossless-cents'),
    ).toBe(true);
  });
  it('retains subcent uncertainty through surtax copies and tax reduction input', () => {
    const run = calculate('5710.01');
    expect(run.at('ON428.66').reporting.status).toBe('rounding-unproven');
    for (const line of ['68', '68.copy2', '69', '71', '73']) {
      expect(run.at(`ON428.${line}`).reporting.status).toBe(
        'dependency-unresolved',
      );
      expect(run.at(`ON428.${line}`).reportableAmount).toBeNull();
    }
    expect(calculate('5710').at('ON428.68').dependencies).toEqual(['ON428.65']);
  });
});

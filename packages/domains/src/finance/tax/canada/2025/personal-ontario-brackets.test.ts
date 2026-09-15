import { describe, it, expect } from 'vitest';
import { appendCanada2025OntarioBrackets } from './personal-ontario-brackets.js';
import {
  decimal as q,
  serialize,
  type PersonalExact,
} from './personal-exact.js';
import { applyCanadaPersonalPaperReporting } from './personal-reporting.js';
import type { PersonalFormField } from './personal-package.js';
function calculate(income: string) {
  const values = new Map<string, PersonalExact>();
  const fields: PersonalFormField[] = [];
  const field: Parameters<typeof appendCanada2025OntarioBrackets>[1] = (
    id,
    label,
    value,
    dependencies,
    sourceId = 'cra-5006-r-2025-etext',
    locator = 'synthetic taxable fixture',
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
  field('T1.26000', 'Reviewed taxable income', q(income), []);
  const result = appendCanada2025OntarioBrackets((id) => {
    const value = values.get(id);
    if (!value) throw Error(id);
    return value;
  }, field);
  field(
    'ON428.8',
    'Ontario tax transferred to line51',
    result.amount,
    result.dependencies,
  );
  const output = applyCanadaPersonalPaperReporting(fields, false);
  return {
    ...result,
    fields: output,
    at: (id: string) => output.find((f) => f.id === id)!,
  };
}
describe('Ontario selected bracket printed line graph', () => {
  it.each([
    ['0', '0', 1],
    ['52886', '2670.743', 1],
    ['52886.01', '2670.740915', 2],
    ['60000', '3321.671', 2],
    ['105775', '7510.0835', 2],
    ['105775.01', '7510.091116', 3],
    ['150000', '12445.6', 3],
    ['150000.01', '12445.601216', 4],
    ['220000', '20957.6', 4],
    ['220000.01', '20957.601316', 5],
    ['300000', '31485.6', 5],
  ] as const)('uses captured column for income %s', (income, tax, column) => {
    const run = calculate(income);
    expect(run.column).toBe(column);
    expect(run.at('ON428.1').exactDecimal).toBe(income);
    expect(run.at(`ONBracket.column${column}.2`).exactDecimal).toBe(income);
    expect(run.at(`ONBracket.column${column}.8`).exactDecimal).toBe(tax);
    expect(run.at('ON428.8').exactDecimal).toBe(tax);
    expect(
      run.fields.filter((f) => f.id.startsWith('ONBracket.')),
    ).toHaveLength(4);
    expect(
      run.fields
        .filter((f) => f.id.startsWith('ONBracket.'))
        .every((f) => f.id.startsWith(`ONBracket.column${column}.`)),
    ).toBe(true);
    expect(run.at('ON428.8').dependencies).toEqual([
      `ONBracket.column${column}.8`,
    ]);
  });
  it('computes each printed operand and maps line8 and its line51 transfer distinctly', () => {
    const run = calculate('300000');
    expect(run.at('ONBracket.column5.4').exactDecimal).toBe('80000');
    expect(run.at('ONBracket.column5.6').exactDecimal).toBe('10528');
    expect(run.at('ONBracket.column5.8').exactDecimal).toBe('31485.6');
    expect(run.at('ONBracket.column5.8').reporting.fieldPath).toBe(
      'form1.Page1.Chart.Column5.Line8.Amount',
    );
    expect(run.at('ON428.8').reporting.fieldPath).toBe(
      'form1.Page2.Line51.Amount',
    );
    expect(
      run.fields.every((f) => f.reporting.status === 'lossless-cents'),
    ).toBe(true);
    expect(run.at('ONBracket.column5.6').locator).toContain('0.1316');
    expect(run.at('ONBracket.column5.8').locator).toContain('20957.60');
  });
  it('keeps the source printed bases and propagates unproven subcent products without rounding', () => {
    const run = calculate('52886.01');
    expect(run.at('ONBracket.column2.4').exactDecimal).toBe('0.01');
    expect(run.at('ONBracket.column2.6').exactDecimal).toBe('0.000915');
    expect(run.at('ONBracket.column2.6').reporting.status).toBe(
      'rounding-unproven',
    );
    expect(run.at('ONBracket.column2.8').reporting.status).toBe(
      'dependency-unresolved',
    );
    expect(run.at('ON428.8').reportableAmount).toBeNull();
    expect(run.at('ON428.8').reporting.status).toBe('dependency-unresolved');
  });
});

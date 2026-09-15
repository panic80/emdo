import { describe, it, expect } from 'vitest';
import { appendCanada2025OntarioHealthPremium } from './personal-ontario-health.js';
import {
  decimal as q,
  serialize,
  type PersonalExact,
} from './personal-exact.js';
import { applyCanadaPersonalPaperReporting } from './personal-reporting.js';
import type { PersonalFormField } from './personal-package.js';
function calculate(taxable: string) {
  const values = new Map<string, PersonalExact>();
  const fields: PersonalFormField[] = [];
  const field: Parameters<typeof appendCanada2025OntarioHealthPremium>[1] = (
    id,
    label,
    value,
    dependencies,
    sourceId = 'cra-5006-r-2025-etext',
    locator = 'synthetic taxable-income fixture',
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
  field('T1.26000', 'Taxable income', q(taxable), []);
  const result = appendCanada2025OntarioHealthPremium((id) => {
    const value = values.get(id);
    if (!value) throw Error(id);
    return value;
  }, field);
  field(
    'ON428.89',
    'Ontario health premium',
    result.amount,
    result.dependencies,
  );
  return {
    ...result,
    fields: applyCanadaPersonalPaperReporting(fields, false),
    value: (id: string) => serialize(values.get(id)!).exactDecimal,
  };
}
describe('Ontario health premium captured worksheet', () => {
  it.each([
    ['20000', 1, '0'],
    ['20000.01', 2, '0.0006'],
    ['22500', 2, '150'],
    ['25000', 2, '300'],
    ['25000.01', 3, '300'],
    ['36000', 3, '300'],
    ['36000.01', 4, '300.0006'],
    ['37000', 4, '360'],
    ['38500', 4, '450'],
    ['38500.01', 5, '450'],
    ['48000', 5, '450'],
    ['48000.01', 6, '450.0025'],
    ['48300', 6, '525'],
    ['48600', 6, '600'],
    ['48600.01', 7, '600'],
    ['72000', 7, '600'],
    ['72000.01', 8, '600.0025'],
    ['72300', 8, '675'],
    ['72600', 8, '750'],
    ['72600.01', 9, '750'],
    ['200000', 9, '750'],
    ['200000.01', 10, '750.0025'],
    ['200300', 10, '825'],
    ['200600', 10, '900'],
    ['200600.01', 11, '900'],
  ] as const)(
    'computes taxable %s through selected row %s',
    (income, row, premium) => {
      const run = calculate(income);
      expect(run.row).toBe(row);
      expect(run.value('ONHealthPremium.1')).toBe(income);
      expect(run.value('ON428.89')).toBe(premium);
      expect(
        run.fields
          .filter((f) => f.id.startsWith('ONHealthPremium.row'))
          .every((f) => f.id.startsWith(`ONHealthPremium.row${row}.`)),
      ).toBe(true);
      expect(
        run.fields.filter((f) => f.id.startsWith('ONHealthPremium.')),
      ).toHaveLength(row % 2 === 1 ? 1 : row === 2 ? 4 : 5);
    },
  );
  it('carries every selected operand and captured proof into the final premium', () => {
    const run = calculate('37000');
    expect(run.value('ONHealthPremium.row4.income')).toBe('37000');
    expect(run.value('ONHealthPremium.row4.excess')).toBe('1000');
    expect(run.value('ONHealthPremium.row4.rateProduct')).toBe('60');
    expect(run.value('ONHealthPremium.row4.total')).toBe('360');
    expect(
      run.fields.every((f) => f.reporting.status === 'lossless-cents'),
    ).toBe(true);
    expect(run.fields.find((f) => f.id === 'ON428.89')!.dependencies).toEqual([
      'ONHealthPremium.row4.total',
    ]);
    expect(
      run.fields.find((f) => f.id === 'ONHealthPremium.row4.total')!.reporting
        .fieldPath,
    ).toBe(
      'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line4.Amount4',
    );
  });
  it('preserves subcent uncertainty through descendants and binds plateau constants to taxable income', () => {
    const fractional = calculate('36000.01');
    expect(
      fractional.fields.find(
        (f) => f.id === 'ONHealthPremium.row4.rateProduct',
      )!.reporting.status,
    ).toBe('rounding-unproven');
    expect(
      fractional.fields.find((f) => f.id === 'ON428.89')!.reporting.status,
    ).toBe('dependency-unresolved');
    const plateau = calculate('30000');
    expect(plateau.dependencies).toEqual(['ONHealthPremium.1']);
    expect(
      plateau.fields.find((f) => f.id === 'ON428.89')!.reportableAmount,
    ).toBe('300.00');
  });
});

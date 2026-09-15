import { describe, it, expect } from 'vitest';
import { appendCanada2025SingleBenefitSchedules } from './personal-benefit-schedules.js';
import { decimal, serialize, type PersonalExact } from './personal-exact.js';
import { applyCanadaPersonalPaperReporting } from './personal-reporting.js';
import type { PersonalFormField } from './personal-package.js';

function calculate(
  wages: string,
  business: string,
  net: string,
  commission = '0',
) {
  const fields: PersonalFormField[] = [];
  const values = new Map<string, PersonalExact>();
  const field = (
    id: string,
    label: string,
    value: PersonalExact,
    dependencies: string[],
    sourceId = 'fixture-reviewed-cent-transfer',
    locator = 'independent fixture input',
  ) => {
    values.set(id, value);
    const [form, line] = id.split('.');
    fields.push({
      id,
      form: form!,
      line: line!,
      label,
      dependencies,
      sourceId,
      locator,
      ...serialize(value),
      reportableAmount: null,
    });
    return value;
  };
  for (const [id, amount] of [
    ['T1.10100', wages],
    ['T1.13500', business],
    ['T1.13900', commission],
    ['T1.23600', net],
  ] as const)
    field(id, 'Reviewed cent-valued transfer fixture', decimal(amount), []);
  const at = (id: string) => {
    const found = values.get(id);
    if (!found) throw Error(`Unresolved dependency ${id}`);
    return found;
  };
  appendCanada2025SingleBenefitSchedules('Schedule6', at, field);
  appendCanada2025SingleBenefitSchedules('ON428-A', at, field);
  const output = applyCanadaPersonalPaperReporting(fields, false);
  return { output, at: (id: string) => output.find((f) => f.id === id)! };
}
describe('2025 single-person CWB and LIFT official monetary line graphs', () => {
  it('substitutes independent printed-form fixtures and preserves every transfer', () => {
    // CRA Schedule6: (29735 - 26855) * .15 = 432; 1633 - 432 = 1201.
    // ON428-A: min(30000 * .0505, 875) = 875; income below 32500 => no reduction.
    const run = calculate('30000', '0', '29735');
    for (const [id, expected] of Object.entries({
      'Schedule6.1': '30000',
      'Schedule6.2': '0',
      'Schedule6.3': '0',
      'Schedule6.5': '30000',
      'Schedule6.6': '30000',
      'Schedule6.7': '29735',
      'Schedule6.10': '29735',
      'Schedule6.12': '29735',
      'Schedule6.13': '29735',
      'Schedule6.15': '29735',
      'Schedule6.18': '27000',
      'Schedule6.20': '7290',
      'Schedule6.21': '1633',
      'Schedule6.22': '1633',
      'Schedule6.25': '2880',
      'Schedule6.27': '432',
      'Schedule6.28': '1201',
      'T1.45300': '1201',
      'ON428-A.3': '30000',
      'ON428-A.5': '875',
      'ON428-A.9': '29735',
      'ON428-A.12': '0',
      'ON428-A.13': '29735',
      'ON428-A.17': '0',
      'ON428-A.19': '0',
      'ON428-A.20': '875',
      'ON428.62140': '875',
    }))
      expect(run.at(id).exactDecimal, id).toBe(expected);
    expect(run.at('Schedule6.14')).toBeUndefined(); // single: printed line13 skips14
    expect(run.at('T1.45300').reportableAmount).toBe('1201.00');
    expect(run.at('ON428.62140').reportableAmount).toBe('875.00');
    expect(
      run.output.filter((f) => ['Schedule6', 'ON428-A'].includes(f.form)),
    ).toHaveLength(43);
    expect(
      run.output
        .filter((f) => f.form === 'Schedule6')
        .every((f) => f.reporting.fieldPath !== null),
    ).toBe(true);
  });
  it.each([
    ['3000', '26855', '0', '0'],
    ['3001', '26855', '0.27', '0'],
    ['10000', '26855.20', '1632.97', '0.03'],
    ['10000', '37741.60', '0.01', '1632.99'],
    ['10000', '37742', '0', '1633.05'],
  ])(
    'CWB threshold fixture wages %s / net %s',
    (wages, net, expected, reduction) => {
      const run = calculate(wages, '0', net);
      expect(run.at('Schedule6.27').exactDecimal).toBe(reduction);
      expect(run.at('Schedule6.28').exactDecimal).toBe(expected);
    },
  );
  it('retains sole-proprietor working income and unproven fractional-cent blockers', () => {
    const run = calculate('0', '9000.05', '9000.05');
    expect(run.at('Schedule6.3').reportableAmount).toBe('9000.05');
    expect(run.at('Schedule6.18').reportableAmount).toBe('6000.05');
    expect(run.at('Schedule6.20').exactDecimal).toBe('1620.0135');
    expect(run.at('Schedule6.20').reporting.status).toBe('rounding-unproven');
    expect(run.at('T1.45300').reporting.status).toBe('dependency-unresolved');
    expect(run.at('ON428-A.5').reportableAmount).toBe('0.00');
  });
  it.each([
    ['32500', '0', '875'],
    ['32500.20', '0.01', '874.99'],
    ['49999.80', '874.99', '0.01'],
    ['50000', '875', '0'],
  ])(
    'LIFT independent income-reduction boundary at %s',
    (net, reduction, credit) => {
      const run = calculate('30000', '0', net);
      expect(run.at('ON428-A.19').exactDecimal).toBe(reduction);
      expect(run.at('ON428-A.20').exactDecimal).toBe(credit);
      expect(run.at('ON428-A.20').reportableAmount).not.toBeNull();
    },
  );
  it('does not hide an unresolved multiplication behind a later maximum cap', () => {
    const run = calculate('30000.01', '0', '30000.01');
    expect(run.at('Schedule6.20').reporting.status).toBe('rounding-unproven');
    expect(run.at('Schedule6.22').exactDecimal).toBe('1633');
    expect(run.at('Schedule6.22').reportableAmount).toBeNull();
    expect(run.at('Schedule6.22').reporting.blockedDependencies).toEqual([
      'Schedule6.20',
    ]);
  });
});

it('includes commission in Schedule6 working income without duplicating business profit', () => {
  const c = calculate('0', '0', '8617.75', '9000');
  const b = calculate('0', '9000', '8617.75', '0');
  expect(c.at('Schedule6.3').exactDecimal).toBe('9000');
  expect(c.at('T1.45300').exactDecimal).toBe('1620');
  expect(c.at('T1.45300').exactDecimal).toBe(b.at('T1.45300').exactDecimal);
  expect(c.at('Schedule6.3').dependencies).toContain('T1.13900');
});

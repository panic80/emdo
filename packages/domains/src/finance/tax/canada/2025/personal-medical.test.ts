import { describe, it, expect } from 'vitest';
import {
  decimal as q,
  serialize,
  type PersonalExact,
} from './personal-exact.js';
import {
  appendCanada2025MedicalCredits,
  appendCanada2025MedicalSupplement,
} from './personal-medical.js';
function graph(inputs: Record<string, string>) {
  const values = new Map(
    Object.entries(inputs).map(([key, value]) => [key, q(value)]),
  );
  const dependencies = new Map<string, string[]>();
  const at = (id: string) => {
    const value = values.get(id);
    if (!value) throw Error(id);
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
  return {
    at,
    field,
    dependencies,
    value: (id: string) => serialize(at(id)).exactDecimal,
  };
}
describe('Canada 2025 self medical schedules', () => {
  it('uses distinct federal and Ontario annual threshold caps', () => {
    const g = graph({ 'T1.23600': '100000' });
    appendCanada2025MedicalCredits(g.at, g.field, q('10000'));
    expect(g.value('T1.109')).toBe('2834');
    expect(g.value('ON428.40')).toBe('2885');
    expect(g.value('T1.33200')).toBe('7166');
    expect(g.value('ON428.58769')).toBe('7115');
  });
  it.each([
    ['0', '0'],
    ['299.99', '0'],
    ['300', '0'],
    ['300.01', '0.01'],
  ])('applies expense threshold to %s', (expense, result) => {
    const g = graph({ 'T1.23600': '10000' });
    appendCanada2025MedicalCredits(g.at, g.field, q(expense));
    expect(g.value('T1.33200')).toBe(result);
    expect(g.value('ON428.58769')).toBe(result);
  });
  it.each([
    ['4390', '0', '33294', '10000', '1504'],
    ['4389.99', '0', '33294', '10000', '0'],
    ['4500', '110', '33294', '10000', '1504'],
    ['4500', '110.01', '33294', '10000', '0'],
    ['4390', '0', '33294', '100', '25'],
    ['4390', '0', '63373.99', '10000', '0.0005'],
    ['4390', '0', '63374', '10000', '0'],
    ['4390', '0', '33294', '0', '0'],
  ])(
    'applies employment %s, dues %s, income %s and pool %s',
    (employment, dues, income, pool, result) => {
      const g = graph({
        'T1.10100': employment,
        'T1.21200': dues,
        'T1.13500': '0',

        'T1.13900': '0',
        'T1.23600': income,
        'T1.33200': pool,
      });
      appendCanada2025MedicalSupplement(g.at, g.field, {
        fullYearCanadianResident: true,
        ageAtLeast18: true,
      });
      expect(g.value('T1.45200')).toBe(result);
    },
  );
  it.each([
    { fullYearCanadianResident: false, ageAtLeast18: true },
    { fullYearCanadianResident: true, ageAtLeast18: false },
  ])(
    'does not infer age/residency eligibility from income',
    (applicability) => {
      const g = graph({
        'T1.10100': '20000',
        'T1.21200': '0',
        'T1.13500': '0',

        'T1.13900': '0',
        'T1.23600': '20000',
        'T1.33200': '10000',
      });
      appendCanada2025MedicalSupplement(g.at, g.field, applicability);
      expect(g.value('T1.45200')).toBe('0');
    },
  );
  it('includes positive sole-proprietor income in the qualifying income test', () => {
    const g = graph({
      'T1.10100': '0',
      'T1.21200': '0',
      'T1.13500': '4390',

      'T1.13900': '0',
      'T1.23600': '4000',
      'T1.33200': '1000',
    });
    appendCanada2025MedicalSupplement(g.at, g.field, {
      fullYearCanadianResident: true,
      ageAtLeast18: true,
    });
    expect(g.value('T1.45200')).toBe('250');
  });
});

it('includes positive commission income in the medical supplement working-income threshold', () => {
  const g = graph({
    'T1.10100': '0',
    'T1.21200': '0',
    'T1.13500': '0',
    'T1.13900': '4390',
    'T1.23600': '4390',
    'T1.33200': '10000',
  });
  appendCanada2025MedicalSupplement(g.at, g.field, {
    fullYearCanadianResident: true,
    ageAtLeast18: true,
  });
  expect(g.value('MedicalSupplement.workingIncome')).toBe('4390');
  expect(g.value('T1.45200')).toBe('1504');
  expect(g.dependencies.get('MedicalSupplement.workingIncome')).toContain(
    'T1.13900',
  );
});

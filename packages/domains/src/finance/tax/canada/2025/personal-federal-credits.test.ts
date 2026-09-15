import { describe, it, expect } from 'vitest';
import { appendCanada2025FederalCredits } from './personal-federal-credits.js';
import {
  decimal as q,
  serialize,
  type PersonalExact,
} from './personal-exact.js';
function calculate(
  bpa: string,
  medical = '0',
  contributions: Record<string, string> = {},
) {
  const values = new Map<string, PersonalExact>(
    Object.entries({
      'T1.30000': bpa,
      'T1.30800': '0',
      'T1.31000': '0',
      'T1.31200': '0',
      'T1.31260': '0',
      'T1.33200': medical,
      ...contributions,
    }).map(([id, value]) => [id, q(value)]),
  );
  const dependencies = new Map<string, string[]>();
  appendCanada2025FederalCredits(
    (id) => {
      const value = values.get(id);
      if (!value) throw new Error(id);
      return value;
    },
    (id, _label, value, deps) => {
      values.set(id, value);
      dependencies.set(id, deps);
      return value;
    },
  );
  return {
    amount: (id: string) => serialize(values.get(id)!).exactDecimal,
    dependencies,
  };
}
describe('2025 federal printed credit chain', () => {
  it('carries personal credits through printed subtotals and medical addition', () => {
    const result = calculate('16129', '100');
    expect(result.amount('T1.84')).toBe('16129');
    expect(result.amount('T1.106')).toBe('16129');
    expect(result.amount('T1.33500')).toBe('16229');
    expect(result.amount('T1.33800')).toBe('2353.205');
    expect(result.amount('T1.35000')).toBe('2353.205');
    expect(result.dependencies.get('T1.33500')).toEqual(['T1.106', 'T1.33200']);
  });
  it('adds all four distinct contribution and employment operands', () => {
    const result = calculate('16129', '100', {
      'T1.30800': '1000.11',
      'T1.31000': '2000.22',
      'T1.31200': '300.33',
      'T1.31260': '1471',
    });
    expect(result.amount('T1.96')).toBe('4771.66');
    expect(result.amount('T1.96.copy2')).toBe('4771.66');
    expect(result.amount('T1.98')).toBe('20900.66');
    expect(result.amount('T1.33500')).toBe('21000.66');
  });
  it('retains reviewed omitted-claim guards and printed duplicate dependency', () => {
    const result = calculate('14538');
    expect(result.dependencies.get('T1.96')).toContain(
      'fact:scope.noEiSpecialBenefitsAgreement',
    );
    expect(result.dependencies.get('T1.98')).toContain('T1.96.copy2');
    expect(result.dependencies.get('FederalTopUp.2')).toEqual([
      'fact:scope.noOtherCredits',
    ]);
    expect(result.dependencies.get('T1.35000')).toContain(
      'fact:scope.noOtherCredits',
    );
  });
  it('preserves subcent top-up arithmetic instead of rounding the worksheet', () => {
    const result = calculate('60000');
    expect(result.amount('FederalTopUp.3')).toBe('8700');
    expect(result.amount('FederalTopUp.5')).toBe('380.62');
    expect(result.amount('FederalTopUp.7')).toBe('13.13139');
    expect(result.amount('T1.35000')).toBe('8713.13139');
  });
});

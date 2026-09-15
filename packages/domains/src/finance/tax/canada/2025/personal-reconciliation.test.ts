import { describe, expect, it } from 'vitest';
import { decimal, serialize, type PersonalExact } from './personal-exact.js';
import { appendCanada2025PersonalReconciliation } from './personal-reconciliation.js';
function run(withheld: string) {
  const values = new Map<string, PersonalExact>(
    Object.entries({
      '42000': '1000',
      '42100': '200',
      '42120': '0',
      '42200': '0',
      '42800': '300',
      '43700': withheld,
      '44000': '0',
      '44800': '10',
      '45000': '20',
      '45200': '30',
      '45300': '40',
      '45350': '0',
      '45355': '0',
      '45400': '0',
      '45600': '0',
      '45700': '0',
      '46900': '0',
      '47555': '0',
      '47556': '0',
      '47600': '100',
      '47900': '0',
    }).map(([k, v]) => [`T1.${k}`, decimal(v)]),
  );
  const dependencies = new Map<string, string[]>();
  const at = (id: string) => {
    const value = values.get(id);
    if (!value) throw Error(`missing:${id}`);
    return value;
  };
  appendCanada2025PersonalReconciliation(at, (id, _label, value, deps) => {
    values.set(id, value);
    dependencies.set(id, deps);
    return value;
  });
  return {
    amount: (id: string) => serialize(at(`T1.${id}`)).exactDecimal,
    dependencies,
  };
}
describe('T1 Step 6 reconciliation', () => {
  it.each([
    ['1000', '300', '0', '300', '1200'],
    ['1300', '0', '0', '0', '1500'],
    ['2000', '-700', '700', '0', '2200'],
    ['1300.001', '-0.001', '0.001', '0', '1500.001'],
  ])(
    'preserves payable/credit transfers and signed result for withholding%s',
    (withheld, difference, refund, owing, credits) => {
      const result = run(withheld);
      expect(result.amount('143')).toBe('1000');
      expect(result.amount('43500')).toBe('1500');
      expect(result.amount('149')).toBe('1500');
      expect(result.amount('48200')).toBe(credits);
      expect(result.amount('166')).toBe(result.amount('48200'));
      expect(result.amount('167')).toBe(difference);
      expect(result.amount('48400')).toBe(refund);
      expect(result.amount('48500')).toBe(owing);
      for (const line of [
        '44000',
        '45350',
        '45355',
        '45400',
        '45600',
        '45700',
        '46900',
        '47555',
        '47556',
        '47900',
      ])
        expect(result.amount(line), line).toBe('0');
      expect(result.dependencies.get('T1.167')).toEqual(['T1.149', 'T1.166']);
      expect(result.dependencies.get('T1.43500')).toContain(
        'fact:scope.noEiSpecialBenefitsAgreement',
      );
      expect(result.dependencies.get('T1.43500')).toContain(
        'fact:scope.noOtherIncome',
      );
      expect(result.dependencies.get('T1.48200')).toEqual([
        'T1.43700',
        'T1.44000',
        'T1.44800',
        'T1.45000',
        'T1.45200',
        'T1.45300',
        'T1.45350',
        'T1.45355',
        'T1.45400',
        'T1.45600',
        'T1.45700',
        'T1.46900',
        'T1.47555',
        'T1.47556',
        'T1.47600',
        'T1.47900',
        'fact:scope.noOtherRefunds',
      ]);
    },
  );
  it('requires authoritative inputs instead of silently substituting zero', () => {
    expect(() =>
      appendCanada2025PersonalReconciliation(
        () => {
          throw Error('missing');
        },
        (_id, _label, value) => value,
      ),
    ).toThrow('missing');
  });
});

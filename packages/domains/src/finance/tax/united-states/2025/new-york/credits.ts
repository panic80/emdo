import { deepFreeze } from '@emdo/contracts';
import { roundNonnegativeRatio } from '../rounding.js';
/** IT-215-I2025 p2–3, NYC EIC rate worksheet. Amounts are entered whole-dollar NYAGI.
 * The sliding reduction rounds to four decimal places BEFORE subtracting from the rate.
 */
export function nycEicRate2025(agi: bigint): bigint {
  if (agi < 0n) throw new Error('unsupported-negative-ny-agi');
  if (agi < 5000n) return 3000n;
  if (agi < 7500n) return 3000n - roundNonnegativeRatio(agi - 4999n, 5n);
  if (agi < 15000n) return 2500n;
  if (agi < 17500n) return 2500n - roundNonnegativeRatio(agi - 14999n, 5n);
  if (agi < 20000n) return 2000n;
  if (agi < 22500n) return 2000n - roundNonnegativeRatio(agi - 19999n, 5n);
  if (agi < 40000n) return 1500n;
  if (agi < 42500n) return 1500n - roundNonnegativeRatio(agi - 39999n, 5n);
  return 1000n;
}
/** Ordinary full-year single no-child case; investment/Medicaid/combat/other
 * resident credits excluded by reviewed federal/NY facts, not guessed from amounts.
 */
export function calculateNySingleEic2025(input: {
  agi: bigint;
  federalEic: bigint;
  stateTax: bigint;
  household: bigint;
  wages: bigint;
  business: bigint;
  city: boolean;
}) {
  if (
    Object.values(input).some(
      (value) => typeof value === 'bigint' && value < 0n,
    )
  )
    throw new Error('unsupported-negative-credit-input');
  const tentative = roundNonnegativeRatio(input.federalEic * 30n, 100n);
  const reduction =
    input.stateTax < input.household ? input.stateTax : input.household;
  const raw = tentative - reduction;
  const rate = nycEicRate2025(input.agi);
  const cityEic = input.city
    ? roundNonnegativeRatio(input.federalEic * rate, 10000n)
    : 0n;
  const fields: Record<string, string> = {
    '6': input.wages.toString(),
    '7': '0',
    '8': input.business.toString(),
    '9': input.agi.toString(),
    '10': input.federalEic.toString(),
    '11': '0.30',
    '12': tentative.toString(),
    'B.1': input.stateTax.toString(),
    'B.2': '0',
    'B.3': '0',
    'B.4': '0',
    'B.5': input.stateTax.toString(),
    '13': input.stateTax.toString(),
    '14': input.household.toString(),
    '15': reduction.toString(),
  };
  if (raw >= 0n) fields['16'] = raw.toString();
  if (input.city) {
    fields['C.1'] = input.federalEic.toString();
    fields['C.2'] =
      `${rate / 10000n}.${(rate % 10000n).toString().padStart(4, '0')}`;
    fields['C.3'] = cityEic.toString();
    fields['27'] = cityEic.toString();
  }
  return deepFreeze({
    stateEic: raw >= 0n ? raw.toString() : null,
    cityEic: cityEic.toString(),
    fields,
    unresolved:
      raw < 0n ? ['IT215-negative-line16-reporting-rule-unresolved'] : [],
    sourceIds: ['ny-2025-it215', 'ny-2025-it215i'],
  });
}
/** IT-2702025 Part1 question A is a mandatory stop: no dependent = not eligible.
 * The federal candidate explicitly requires no dependants. No income-based proxy.
 */
export const NY_2025_CHILDLESS_IT270 = deepFreeze({
  formId: 'IT-270',
  required: false,
  eligibility: { A: false },
  credit: '0',
  predicate:
    'reviewed federal dependants=false; IT-270 Part1 A says stop if No',
  sourceId: 'ny-2025-it270',
});

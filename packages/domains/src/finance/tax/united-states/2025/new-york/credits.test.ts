import { describe, it, expect } from 'vitest';
import {
  calculateNySingleEic2025,
  nycEicRate2025,
  NY_2025_CHILDLESS_IT270,
} from './credits.js';
describe('source-bound NY childless credit chain', () => {
  it('calculates IT215 state household offset and NYC four-decimal rate independently', () => {
    const result = calculateNySingleEic2025({
      agi: 6000n,
      federalEic: 649n,
      stateTax: 0n,
      household: 60n,
      wages: 0n,
      business: 6000n,
      city: true,
    });
    // State .30*649=194.7->195. NYC: (6000-4999)*.00002=.02002->.0200;
    // .30-.0200=.2800;649*.28=181.72->182.
    expect(result).toMatchObject({
      stateEic: '195',
      cityEic: '182',
      fields: { '12': '195', '15': '0', '16': '195', 'C.2': '0.2800' },
    });
  });
  it('uses exact rate table boundaries and prescribed four-decimal rounding', () => {
    expect(nycEicRate2025(4999n)).toBe(3000n);
    expect(nycEicRate2025(5000n)).toBe(3000n);
    expect(nycEicRate2025(5002n)).toBe(2999n);
    expect(nycEicRate2025(7500n)).toBe(2500n);
    expect(nycEicRate2025(17500n)).toBe(2000n);
    expect(nycEicRate2025(22500n)).toBe(1500n);
    expect(nycEicRate2025(42500n)).toBe(1000n);
  });
  it('does not invent a negative-line16 floor and proves IT270 no-dependent inapplicability', () => {
    expect(
      calculateNySingleEic2025({
        agi: 19000n,
        federalEic: 1n,
        stateTax: 500n,
        household: 45n,
        wages: 19000n,
        business: 0n,
        city: true,
      }).stateEic,
    ).toBeNull();
    expect(NY_2025_CHILDLESS_IT270).toMatchObject({
      required: false,
      eligibility: { A: false },
      credit: '0',
    });
  });
});

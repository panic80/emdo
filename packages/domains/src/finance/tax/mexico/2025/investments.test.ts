import { describe, expect, it } from 'vitest';
import { calculateMexico2025Investments } from './investments.js';

const computer = {
  assetId: 'computer1',
  assetClass: 'computer-equipment',
  acquisitionDate: '2025-01-01',
  firstUseDate: '2025-01-01',
  originalInvestment: '100000',
};

describe('Mexico first-year Article 31/34 investment schedule', () => {
  it('independently calculates full-year computers with June inflation update', () => {
    // 140.405 / 138.343 -> 1.0149; 100000 *30% *12/12 *1.0149 =30447.
    const result = calculateMexico2025Investments(JSON.stringify([computer]));
    expect(result.rows[0]).toMatchObject({
      fullMonths: 12,
      firstHalfLastMonth: 6,
      ratePercent: '30',
      acquisitionIndex: '138.343',
      firstHalfIndex: '140.405',
      factor: { numerator: '10149', denominator: '10000' },
      adjustedDeduction: { numerator: '30447', denominator: '1' },
    });
    expect(result.adjustedDeduction).toEqual({ n: 30447n, d: 1n });
  });
  it('excludes the middle month of an odd usage period and prorates eleven full months', () => {
    // Feb-Dec has11 months; midpointJuly is excluded; first half endsJune.
    // 100000 *30% *11/12 =27500; *1.0149 =27909.75.
    const result = calculateMexico2025Investments(
      JSON.stringify([{ ...computer, firstUseDate: '2025-02-01' }]),
    );
    expect(result.rows[0]).toMatchObject({
      fullMonths: 11,
      firstHalfLastMonth: 6,
      adjustedDeduction: { numerator: '111639', denominator: '4' },
    });
  });
  it('uses acquisition month separately from first-use month and combines different asset classes', () => {
    // Jun acquisition, Jul-Dec use: Sep/Jun =141.197/140.405 ->1.0056.
    // 120000 *10% *6/12 *1.0056 =6033.60. Plus30447 =36480.60.
    const result = calculateMexico2025Investments(
      JSON.stringify([
        computer,
        {
          assetId: 'office1',
          assetClass: 'office-furniture-equipment',
          acquisitionDate: '2025-06-15',
          firstUseDate: '2025-07-01',
          originalInvestment: '120000',
        },
      ]),
    );
    expect(result.rows[1]).toMatchObject({
      fullMonths: 6,
      firstHalfLastMonth: 9,
      acquisitionIndex: '140.405',
      firstHalfIndex: '141.197',
      factor: { numerator: '1257', denominator: '1250' },
      adjustedDeduction: { numerator: '30168', denominator: '5' },
    });
    expect(result.originalInvestment).toEqual({ n: 220000n, d: 1n });
    expect(result.unadjustedDeduction).toEqual({ n: 36000n, d: 1n });
    expect(result.adjustedDeduction).toEqual({ n: 182403n, d: 5n });
  });
  it('keeps cent costs and proration rational rather than rounding monthly amounts', () => {
    const result = calculateMexico2025Investments(
      JSON.stringify([
        {
          ...computer,
          acquisitionDate: '2025-11-01',
          firstUseDate: '2025-11-01',
          originalInvestment: '0.01',
        },
      ]),
    );
    expect(result.adjustedDeduction).toEqual({ n: 1n, d: 2000n });
  });
  it('requires a valid explicit list and rejects unsupported assets, histories, dates and duplicate identifiers', () => {
    for (const rows of [
      null,
      {},
      [computer, computer],
      [{ ...computer, assetClass: 'car' }],
      [{ ...computer, acquisitionDate: '2024-01-01' }],
      [{ ...computer, acquisitionDate: '2025-02-01' }],
      [{ ...computer, firstUseDate: '2025-01-02' }],
      [{ ...computer, firstUseDate: '2025-12-01' }],
      [{ ...computer, acquisitionDate: '2025-02-30' }],
      [{ ...computer, originalInvestment: '1.001' }],
      [{ ...computer, originalInvestment: '-1' }],
      [{ ...computer, originalInvestment: '0' }],
      [{ ...computer, disposalDate: '2025-12-31' }],
      [{ ...computer, priorDeductions: '1' }],
      [{ ...computer, rate: '20' }],
    ])
      expect(() =>
        calculateMexico2025Investments(JSON.stringify(rows)),
      ).toThrow();
    expect(() => calculateMexico2025Investments('not JSON')).toThrow();
    expect(calculateMexico2025Investments('[]').adjustedDeduction).toEqual({
      n: 0n,
      d: 1n,
    });
  });
});

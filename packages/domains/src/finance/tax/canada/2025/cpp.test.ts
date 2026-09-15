import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import type { FinanceCanadaCpp2025Input } from '@emdo/contracts';
import { calculateCanadaCpp2025, CANADA_CPP_2025_SOURCE } from './cpp.js';
const input = (
  changes: Partial<FinanceCanadaCpp2025Input> = {},
): FinanceCanadaCpp2025Input => ({
  schemaVersion: 1,
  year: 2025,
  currency: 'CAD',
  residentProvinceOnDecember31: 'ON',
  domesticCase: true,
  hasQuebecEarnedIncome: false,
  hasQppContributions: false,
  dateOfBirth: '1980-06-15',
  dateOfDeath: null,
  disabilityPensionMonths: [],
  retirementPensionStartDate: null,
  election: { kind: 'none' },
  basicExemption: { kind: 'published-table' },
  t4Slips: [],
  annualNetSelfEmploymentEarnings: '0',
  otherEarningsElection: { kind: 'none' },
  ...changes,
});
const slip = (earnings: string, first: string, second = '0') => ({
  reference: 'T4-1',
  box14: earnings,
  box26: earnings,
  box16: first,
  box16A: second,
});
function calculate(changes: Partial<FinanceCanadaCpp2025Input> = {}) {
  const result = calculateCanadaCpp2025(input(changes));
  if (result.status === 'blocked') throw Error(result.issues.join(','));
  return result;
}
const amount = (result: ReturnType<typeof calculate>, line: string) =>
  result.returnLines[line]!.exactDecimal;
describe('2025 Schedule8 exact worksheet components', () => {
  it('binds the official immutable source bytes', async () => {
    const bytes = await readFile(
      new URL('./sources/5000-s8-25e.txt', import.meta.url),
    );
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      CANADA_CPP_2025_SOURCE.documentHash,
    );
    const source = bytes.toString();
    expect(source).toContain('83.1933%');
    expect(source).toContain('16.80672');
    expect(source).toContain('5000-S8');
  });
  it('calculates independently hand-worked self-employment thresholds and both additional tiers', () => {
    for (const earnings of ['0', '3500', '-500'])
      expect(
        amount(
          calculate({ annualNetSelfEmploymentEarnings: earnings }),
          '42100',
        ),
      ).toBe('0');
    const small = calculate({ annualNetSelfEmploymentEarnings: '3501' });
    expect(amount(small, '42100')).toBe('0.119');
    const middle = calculate({ annualNetSelfEmploymentEarnings: '50000' });
    expect(amount(middle, '42100')).toBe('5533.5');
    expect(amount(middle, '31000')).toBe('2301.75');
    expect(amount(middle, '22200')).toBe('3231.75');
    const cap = calculate({ annualNetSelfEmploymentEarnings: '81200' });
    expect(amount(cap, '42100')).toBe('8860.2');
    expect(amount(cap, '31000')).toBe('3356.1');
    expect(amount(cap, '22200')).toBe('5504.1');
    expect(
      amount(calculate({ annualNetSelfEmploymentEarnings: '90000' }), '42100'),
    ).toBe('8860.2');
    expect(
      amount(calculate({ annualNetSelfEmploymentEarnings: '71301' }), '42100'),
    ).toBe('8068.28');
  });
  it('allocates employment credit, enhanced deduction and excess across multiple T4 slips', () => {
    const normal = calculate({ t4Slips: [slip('81200', '4034.1', '396')] });
    expect(amount(normal, '30800')).toBe('3356.1');
    expect(amount(normal, '22215')).toBe('1074');
    expect(amount(normal, '44800')).toBe('0');
    const excess = calculate({
      t4Slips: [
        slip('81200', '4034.1', '396'),
        { ...slip('5000', '89.25'), reference: 'T4-2' },
      ],
    });
    expect(amount(excess, '44800')).toBe('89.25');
    expect(amount(excess, '42100')).toBe('0');
    const short = calculate({ t4Slips: [slip('81200', '4000', '0')] });
    expect(amount(short, '30800')).toBe('3327.732');
    expect(amount(short, '22215')).toBe('672.268');
  });
  it('uses the published mixed-income conversion factor instead of substituting 1/5.95%', () => {
    // Independently evaluated worksheet:2171.75*16.80672=36499.99416;
    // remaining first-tier base31300.00584; second-tier base8699.99416.
    const result = calculate({
      t4Slips: [slip('40000', '2171.75')],
      annualNetSelfEmploymentEarnings: '40000',
    });
    expect(amount(result, '42100')).toBe('4420.70022776');
    expect(amount(result, '31000')).toBe('1549.35028908');
    expect(amount(result, '22200')).toBe('2871.34993868');
    expect(amount(result, '30800')).toBe('1806.75');
    expect(amount(result, '22215')).toBe('365');
  });
  it('allocates mixed overpayments and the remaining employment basic exemption', () => {
    const refund = calculate({
      t4Slips: [slip('25000', '2000')],
      annualNetSelfEmploymentEarnings: '10000',
    });
    expect(amount(refund, '42100')).toBe('0');
    expect(amount(refund, '44800')).toBe('125.75');
    expect(amount(refund, '30800')).toBe('1064.25');
    expect(amount(refund, '31000')).toBe('495');
    expect(amount(refund, '22215')).toBe('215');
    expect(amount(refund, '22200')).toBe('100');
    const low = calculate({
      t4Slips: [slip('2000', '0')],
      annualNetSelfEmploymentEarnings: '3000',
    });
    expect(amount(low, '42100')).toBe('178.5');
    expect(amount(low, '31000')).toBe('74.25');
    expect(amount(low, '22200')).toBe('104.25');
  });
  it('applies published monthly limits and exact earnings proration for turning18', () => {
    const result = calculate({
      dateOfBirth: '2007-06-15',
      annualNetSelfEmploymentEarnings: '50000',
    });
    expect(result.eligibleMonths).toEqual([7, 8, 9, 10, 11, 12]);
    expect(amount(result, '42100')).toBe('2766.75');
    const recurring = calculate({
      dateOfBirth: '2007-11-15',
      annualNetSelfEmploymentEarnings: '50000',
    });
    const line = recurring.worksheet.find((v) => v.locator === 'part4.line1')!;
    expect(line.exactRational).toEqual({
      numerator: '12500',
      denominator: '3',
    });
    expect(line.exactDecimal).toBeNull();
    expect(recurring.publishedProration.maximumPensionableEarnings).toBe(
      '5941.67',
    );
  });
  it('combines disability, turning70, and death correctly without prorating earnings for death alone', () => {
    const seventy = calculate({
      dateOfBirth: '1955-06-15',
      annualNetSelfEmploymentEarnings: '50000',
      disabilityPensionMonths: [2],
    });
    expect(seventy.eligibleMonths).toEqual([1, 3, 4, 5, 6]);
    const death = calculate({
      dateOfDeath: '2025-06-15',
      annualNetSelfEmploymentEarnings: '50000',
    });
    expect(death.monthCount).toBe(6);
    expect(death.selfEmploymentProration).toEqual({
      numerator: '12',
      denominator: '12',
    });
    expect(amount(death, '42100')).toBe('4430.1');
    expect(
      calculateCanadaCpp2025(
        input({
          dateOfBirth: '2007-06-15',
          dateOfDeath: '2025-09-15',
          annualNetSelfEmploymentEarnings: '50000',
        }),
      ),
    ).toMatchObject({
      status: 'blocked',
      issues: ['combined-death-self-employment-proration-review-required'],
    });
  });
  it('distinguishes CPT30 following-month and Schedule8 effective-month elections and revocations', () => {
    const base = {
      dateOfBirth: '1958-01-01',
      retirementPensionStartDate: '2023-01-01',
    };
    expect(
      calculate({
        ...base,
        election: {
          kind: 'stop-in-2025',
          change: {
            channel: 'schedule8',
            effectiveMonth: 6,
            madeByJune152027: true,
          },
        },
      }).monthCount,
    ).toBe(5);
    expect(
      calculate({
        ...base,
        t4Slips: [slip('50000', '2766.75')],
        election: {
          kind: 'stop-in-2025',
          change: {
            channel: 'cpt30',
            deliveredToEmployerDate: '2025-06-15',
            completedAndSentToCra: true,
          },
        },
      }).monthCount,
    ).toBe(6);
    expect(
      calculate({
        ...base,
        election: {
          kind: 'prior-stop',
          priorElectionValid: true,
          revocation: {
            channel: 'schedule8',
            effectiveMonth: 6,
            madeByJune152027: true,
          },
        },
      }).monthCount,
    ).toBe(7);
    expect(
      calculate({
        ...base,
        t4Slips: [slip('50000', '2766.75')],
        election: {
          kind: 'prior-stop',
          priorElectionValid: true,
          revocation: {
            channel: 'cpt30',
            deliveredToEmployerDate: '2025-06-15',
            completedAndSentToCra: true,
          },
        },
      }).monthCount,
    ).toBe(6);
    expect(
      calculate({
        ...base,
        election: {
          kind: 'prior-stop',
          priorElectionValid: true,
          revocation: null,
        },
      }).monthCount,
    ).toBe(0);
  });
  it('requires explicit supported facts, retirement exemption determination, and election evidence', () => {
    for (const changes of [
      { residentProvinceOnDecember31: 'QC' },
      { hasQppContributions: true },
      { hasQuebecEarnedIncome: true },
      { domesticCase: false },
      { dateOfBirth: '1958-01-01', retirementPensionStartDate: '2025-01-01' },
      {
        election: {
          kind: 'stop-in-2025',
          change: {
            channel: 'schedule8',
            effectiveMonth: 6,
            madeByJune152027: true,
          },
        },
      },
      {
        otherEarningsElection: {
          kind: 'cpt20',
          completed: false,
          reference: 'x',
          earningsNotOnT4: '100',
          earningsOnT4: '0',
        },
      },
    ])
      expect(calculateCanadaCpp2025({ ...input(), ...changes }).status).toBe(
        'blocked',
      );
    expect(calculateCanadaCpp2025({ year: 2025 }).status).toBe('blocked');
    const cra = calculate({
      dateOfBirth: '1958-01-01',
      retirementPensionStartDate: '2025-01-01',
      basicExemption: {
        kind: 'cra-determined',
        amount: '1750',
        reference: 'CRA determination',
      },
    });
    expect(cra.publishedProration.basicExemption.exactDecimal).toBe('1750');
  });
  it('rejects CPT30 dates before65 or retirement pension receipt and requires confirmed CPT20 amounts', () => {
    const change = {
      channel: 'cpt30' as const,
      deliveredToEmployerDate: '2025-06-10',
      completedAndSentToCra: true,
    };
    expect(
      calculateCanadaCpp2025(
        input({
          dateOfBirth: '1960-06-15',
          retirementPensionStartDate: '2024-01-01',
          t4Slips: [slip('50000', '2766.75')],
          election: { kind: 'stop-in-2025', change },
        }),
      ),
    ).toMatchObject({
      status: 'blocked',
      issues: expect.arrayContaining(['cpt30-date-ineligible']),
    });
    const elected = calculate({
      otherEarningsElection: {
        kind: 'cpt20',
        completed: true,
        reference: 'reviewed-CPT20',
        earningsNotOnT4: '50000',
        earningsOnT4: '0',
      },
    });
    expect(amount(elected, '42100')).toBe('5533.5');
  });
  it('keeps exact components separate from reportable annual amounts and country readiness', () => {
    const result = calculate({ annualNetSelfEmploymentEarnings: '50000' });
    expect(result.complete).toBe(false);
    expect(result.fullReturnReady).toBe(false);
    for (const line of Object.values(result.returnLines))
      expect(line.reportableAmount).toBeNull();
  });
});

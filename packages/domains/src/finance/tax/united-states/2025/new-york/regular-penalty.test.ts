import { describe, it, expect } from 'vitest';
import {
  calculateNyRegularPeriod2025,
  calculateNyRegularPenalty2025,
  nyRegularPenaltyFactor2025,
} from './regular-penalty.js';
const base = {
  taxBeforeRefundableCredits: 30000n,
  refundableCredits: 0n,
  withholding: 0n,
  estimatedPayments: '0',
  priorYearTaxAfterCredits: 20000n,
  priorYearAgi: 100000n,
  priorYearMctdEarnings: 0n,
  priorYearReturnFiled: true,
  priorYearFull12Months: true,
  priorYearNyResidentOrSourceIncome: true,
  subjectIncomeTaxCount: 1 as const,
  paymentLedger: '[]',
  balancePaidOn: 'unpaid',
  returnFiledOn: 'not-filed',
  returnBalancePaidOn: 'unpaid',
  returnBalancePaid: '0',
};
describe('NY2025 published regular-method ScheduleB', () => {
  it('matches all three official first-period examples and adds payment products before line rounding', () => {
    expect(
      calculateNyRegularPeriod2025({
        period: 0,
        underpayment: '5000',
        payments: [],
      }).penalty,
    ).toBe('79');
    expect(
      calculateNyRegularPeriod2025({
        period: 0,
        underpayment: '5000',
        payments: [{ date: '2025-05-06', amount: '5000' }],
      }).penalty,
    ).toBe('27');
    const partial = calculateNyRegularPeriod2025({
      period: 0,
      underpayment: '5000',
      payments: [{ date: '2025-04-26', amount: '3000' }],
    });
    expect(partial.penalty).toBe('40');
    expect(
      partial.allocations.map((entry) => entry.segments[0]!.factor),
    ).toEqual(['0.00285', '0.01587']);
    expect(partial.exactNumerator).toBe('402900000');
    expect(partial.exactDenominator).toBe('10000000');
  });
  it('retains fractional actual payments and exact allocation products before rounding a penalty line', () => {
    const result = calculateNyRegularPeriod2025({
      period: 0,
      underpayment: '5000.49',
      payments: [{ date: '2025-04-26', amount: '3000.24' }],
    });
    //3000.24*.00285 +2000.25*.01587 =40.2946515, rounded only once.
    expect(result.exactNumerator).toBe('402946515');
    expect(result.exactDenominator).toBe('10000000');
    expect(result.penalty).toBe('40');
    expect(result.allocations.map((row) => row.paidCents)).toEqual([
      '300024',
      '200025',
    ]);
  });
  it('uses source truncation and the mandatory Dec31 split even though the rate remains9.5%', () => {
    expect(nyRegularPenaltyFactor2025(85)).toMatchObject({
      ratio: '0.2328',
      factor: '0.02211',
    });
    expect(
      calculateNyRegularPeriod2025({
        period: 1,
        underpayment: '10000',
        payments: [{ date: '2025-08-15', amount: '10000' }],
      }).penalty,
    ).toBe('159');
    for (const [date, expected] of [
      ['2025-12-20', '250'],
      ['2026-01-05', '291'],
      ['2026-01-14', '315'],
    ])
      expect(
        calculateNyRegularPeriod2025({
          period: 2,
          underpayment: '10000',
          payments: [{ date: date!, amount: '10000' }],
        }).penalty,
      ).toBe(expected);
    const full = calculateNyRegularPeriod2025({
      period: 2,
      underpayment: '10000',
      payments: [],
    });
    expect(full.penalty).toBe('317');
    expect(
      full.allocations[0]!.segments.map((segment) => segment.factor),
    ).toEqual(['0.02784', '0.00389']);
  });
  it('carries ScheduleA deficits across all periods and sums entered period penalties', () => {
    const result = calculateNyRegularPenalty2025(base);
    expect(result.fields).toMatchObject({
      '17': '20000',
      '25a': '5000',
      '30a': '5000',
      '30b': '10000',
      '30c': '15000',
      '30d': '20000',
      '32': '79',
      '34': '239',
      '36': '476',
      '38': '468',
      '39': '1262',
    });
    expect(result.penalty).toBe('1262');
    const partial = calculateNyRegularPenalty2025({
      ...base,
      estimatedPayments: '3000',
      paymentLedger: JSON.stringify([{ date: '2025-04-26', amount: '3000' }]),
    });
    expect(partial.fields).toMatchObject({
      '32': '40',
      '34': '168',
      '36': '381',
      '38': '398',
      '39': '987',
    });
  });
  it('accepts timely June16 current installments while blocking the unresolved prior-April-credit edge', () => {
    expect(() =>
      calculateNyRegularPenalty2025({
        ...base,
        estimatedPayments: '5000',
        paymentLedger: JSON.stringify([{ date: '2025-06-16', amount: '5000' }]),
      }),
    ).toThrow('june16-prior-underpayment');
    const timely = calculateNyRegularPenalty2025({
      ...base,
      estimatedPayments: '10000',
      paymentLedger: JSON.stringify([
        { date: '2025-04-15', amount: '5000' },
        { date: '2025-06-16', amount: '5000' },
      ]),
    });
    expect(timely.fields).toMatchObject({
      '32': '0',
      '34': '0',
      '36': '159',
      '38': '234',
      '39': '393',
    });
    const cured = calculateNyRegularPenalty2025({
      ...base,
      estimatedPayments: '10000',
      paymentLedger: JSON.stringify([
        { date: '2025-05-06', amount: '5000' },
        { date: '2025-06-16', amount: '5000' },
      ]),
    });
    expect(cured.penalty).toBe('420');
  });
  it('binds Table4 return payments to reviewed filing and payment facts without treating them as estimates', () => {
    const result = calculateNyRegularPenalty2025({
      ...base,
      returnFiledOn: '2026-02-15',
      returnBalancePaidOn: '2026-02-15',
      returnBalancePaid: '20000',
    });
    //31 days: .0849*.095 truncated=.00806;20000*.00806=161.2→161.
    expect(result.fields['38']).toBe('161');
    expect(result.fields['26d']).toBe('0');
    expect(() =>
      calculateNyRegularPenalty2025({ ...base, returnBalancePaid: '1' }),
    ).toThrow('not-bound');
    expect(() =>
      calculateNyRegularPenalty2025({ ...base, estimatedPayments: '1' }),
    ).toThrow('mismatch');
  });
});

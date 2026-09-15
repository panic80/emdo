import { describe, it, expect } from 'vitest';
import { calculateNyShortPenalty2025 } from './penalty.js';
const fixture = () => ({
  taxBeforeRefundableCredits: 10000n,
  refundableCredits: 0n,
  withholding: 6950n,
  estimatedPayments: '0',
  priorYearTaxAfterCredits: 20000n,
  priorYearAgi: 100000n,
  priorYearMctdEarnings: 0n,
  priorYearReturnFiled: true,
  priorYearFull12Months: true,
  priorYearNyResidentOrSourceIncome: true,
  subjectIncomeTaxCount: 1 as const,
  paymentLedger: '[]',
  balancePaidOn: '2026-04-08',
});
describe('NY IT2105.9 short method', () => {
  it('matches published2050 underpayment paidApril8 example and independently computes full penalty', () => {
    const result = calculateNyShortPenalty2025(fixture());
    expect(result.fields).toMatchObject({
      '17': '9000',
      '21': '2050',
      '22': '129',
      '23': '4',
      '24': '125',
    });
    expect(result.penalty).toBe('125');
  });
  it('separates NY300-per-income-tax thresholds from MCTMT and prior-year safeharbor', () => {
    expect(
      calculateNyShortPenalty2025({
        ...fixture(),
        taxBeforeRefundableCredits: 7249n,
      }).penalty,
    ).toBe('0');
    expect(
      calculateNyShortPenalty2025({
        ...fixture(),
        taxBeforeRefundableCredits: 7500n,
        subjectIncomeTaxCount: 2,
      }).exception,
    ).toBe('below-per-jurisdiction-threshold');
    expect(
      calculateNyShortPenalty2025({
        ...fixture(),
        priorYearTaxAfterCredits: 0n,
      }).exception,
    ).toBe('no-prior-year-tax-liability');
    expect(
      calculateNyShortPenalty2025({
        ...fixture(),
        priorYearTaxAfterCredits: 0n,
        priorYearNyResidentOrSourceIncome: false,
      }).fields['17'],
    ).toBe('9000');
  });
  it('checks high-income110percent and blocks unequal/late payment shortcut', () => {
    const x = {
      ...fixture(),
      withholding: 0n,
      priorYearTaxAfterCredits: 5000n,
      priorYearAgi: 150001n,
      balancePaidOn: 'unpaid',
    };
    expect(calculateNyShortPenalty2025(x).fields['16']).toBe('5500');
    expect(() =>
      calculateNyShortPenalty2025({
        ...x,
        estimatedPayments: '1000',
        paymentLedger: '[{"date":"2025-09-01","amount":"1000"}]',
      }),
    ).toThrow('regular-method');
    expect(() =>
      calculateNyShortPenalty2025({ ...x, estimatedPayments: '1' }),
    ).toThrow('mismatch');
  });
  it('accepts four equal timely installments includingJune16 with explicit short election', () => {
    const ledger = JSON.stringify(
      ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'].map((date) => ({
        date,
        amount: '1000',
      })),
    );
    expect(
      calculateNyShortPenalty2025({
        ...fixture(),
        withholding: 0n,
        estimatedPayments: '4000',
        paymentLedger: ledger,
        balancePaidOn: 'unpaid',
      }).penalty,
    ).toBe('316');
  });
});

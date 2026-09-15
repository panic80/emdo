import { describe, expect, it } from 'vitest';
import {
  reportSouthKorea2025LocalIncomeTax,
  southKorea2025LocalIncomeTax,
} from './local.js';
import { decimal } from './exact.js';

describe('South Korea 2025 local income tax', () => {
  it('applies exactly 10% without pre-rounding', () => {
    expect(southKorea2025LocalIncomeTax(decimal('3387500'))).toEqual({
      n: 338750n,
      d: 1n,
    });
    expect(reportSouthKorea2025LocalIncomeTax('3387500')).toMatchObject({
      nationalIncomeTax: '3387500',
      exactAmount: '338750',
      reportableAmount: '338750',
      reportedWon: '338750',
      rateNumerator: '1',
      rateDenominator: '10',
      taxKind: 'individual',
    });
  });

  it('retains sub-won local tax exactly and truncates only the report value', () => {
    expect(
      reportSouthKorea2025LocalIncomeTax('0.01', 'corporate'),
    ).toMatchObject({
      exactNumerator: '1',
      exactDenominator: '1000',
      exactAmount: '0.001',
      reportableAmount: '0',
      reportedWon: '0',
      taxKind: 'corporate',
    });
  });
});

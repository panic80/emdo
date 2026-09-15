import { describe, it, expect } from 'vitest';
import {
  calculateUs2210Regular,
  parseUsPenaltyLedger,
  type UsPenaltyInput,
} from './penalty.js';
import { q, minus } from './exact.js';
function base(overrides: Partial<UsPenaltyInput> = {}): UsPenaltyInput {
  return {
    currentYearTax: q(16000n),
    withholding: q(0n),
    priorYearTax: q(20000n),
    priorYearAgi: q(100000n),
    priorYearFull12Months: true,
    priorYearFullResident: true,
    returnFiledOn: 'not-filed',
    payments: [],
    ...overrides,
  };
}
describe('IRS2025 regular2210 penalty', () => {
  it('proves statutory exceptions and the100%/110% prior-year boundary', () => {
    expect(
      calculateUs2210Regular(base({ priorYearTax: q(0n) })).exception,
    ).toBe('prior-year-zero-tax-full-year-resident');
    expect(
      calculateUs2210Regular(base({ currentYearTax: q(999n) })).penalty,
    ).toEqual(q(0n));
    expect(
      calculateUs2210Regular(base({ withholding: q(15001n) })).penalty,
    ).toEqual(q(0n));
    expect(
      calculateUs2210Regular(
        base({ priorYearTax: q(10000n), priorYearAgi: q(150000n) }),
      ).annual,
    ).toEqual(q(10000n));
    expect(
      calculateUs2210Regular(
        base({ priorYearTax: q(10000n), priorYearAgi: q(150001n) }),
      ).annual,
    ).toEqual(q(11000n));
    expect(
      calculateUs2210Regular(
        base({ priorYearTax: q(0n), priorYearFullResident: false }),
      ).penalty.n,
    ).toBeGreaterThan(0n);
  });
  it('matches IRS instruction Example3/4 payment allocations and first-column15/61 days', () => {
    // SourceExample3 has required installments4000 and payments2000/3000/4000/4000.
    const result = calculateUs2210Regular(
      base({
        currentYearTax: q(20000n),
        priorYearTax: q(16000n),
        payments: [
          { date: '2025-04-30', amount: '2000', kind: 'estimated' },
          { date: '2025-06-15', amount: '3000', kind: 'estimated' },
          { date: '2025-09-15', amount: '4000', kind: 'estimated' },
          { date: '2026-01-15', amount: '4000', kind: 'estimated' },
        ],
      }),
    );
    expect(
      result.allocations
        .filter((row) => row.installment === 1)
        .map((row) => [row.amount, row.days]),
    ).toEqual([
      [q(2000n), '15'],
      [q(2000n), '61'],
    ]);
    // Independent full sum includes source weekend adjustment: June16 due, not SundayJune15.
    expect(result.penalty).toEqual(q(74270n, 365n));
  });
  it('treats June16 payments as timely and does not forgive late first-quarter payments', () => {
    const result = calculateUs2210Regular(
      base({
        payments: [
          { date: '2025-04-15', amount: '3600', kind: 'estimated' },
          { date: '2025-06-16', amount: '3600', kind: 'estimated' },
          { date: '2025-09-15', amount: '3600', kind: 'estimated' },
          { date: '2026-01-15', amount: '3600', kind: 'estimated' },
        ],
      }),
    );
    expect(result.penalty).toEqual(q(0n));
    const late = calculateUs2210Regular(
      base({
        payments: [{ date: '2026-01-15', amount: '14400', kind: 'estimated' }],
      }),
    );
    expect(late.penalty.n).toBeGreaterThan(0n);
  });
  it('applies the early-file/full-pay exception to the fourth installment only', () => {
    const payment = {
      date: '2026-01-31',
      amount: '16000',
      kind: 'return-balance' as const,
    };
    const early = calculateUs2210Regular(
      base({ payments: [payment], returnFiledOn: '2026-01-31' }),
    );
    const normal = calculateUs2210Regular(base({ payments: [payment] }));
    expect(early.earlyFinalException).toBe(true);
    expect(early.penalty.n).toBeGreaterThan(0n);
    expect(minus(normal.penalty, early.penalty)).toEqual(
      q(3600n * 16n * 7n, 36500n),
    );
    expect(
      calculateUs2210Regular(
        base({
          payments: [{ ...payment, amount: '15999' }],
          returnFiledOn: '2026-01-31',
        }),
      ).earlyFinalException,
    ).toBe(false);
  });
  it('requires actual valid bounded payment-ledger dates and decimal amounts', () => {
    expect(() =>
      parseUsPenaltyLedger(
        '[{"date":"2025-02-30","amount":"1","kind":"estimated"}]',
      ),
    ).toThrow();
    expect(() =>
      parseUsPenaltyLedger(
        '[{"date":"2026-04-16","amount":"1","kind":"estimated"}]',
      ),
    ).toThrow();
  });
});

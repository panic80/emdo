import { z } from 'zod';
import { deepFreeze } from '@emdo/contracts';
import {
  q,
  plus,
  minus,
  times,
  positive,
  minimum,
  lt,
  type Q,
} from './exact.js';
import { usdCents } from './rounding.js';
import type { UsReturnGraph } from './return-chain.js';

export const US_PENALTY_REQUIRED_FACTS = deepFreeze([
  ...['penalty.priorYearTaxFor2210', 'penalty.priorYearAgi'].map((key) => ({
    key,
    type: 'decimal',
  })),
  ...['penalty.priorYearFull12Months', 'penalty.priorYearFullResident'].map(
    (key) => ({ key, type: 'boolean' }),
  ),
  ...[
    'penalty.waiverRequested',
    'penalty.annualizedElection',
    'penalty.actualWithholdingElection',
    'penalty.priorYearJointReturn',
    'penalty.disasterOrCombatRelief',
  ].map((key) => ({ key, type: 'boolean', equals: false })),
  { key: 'penalty.paymentLedger', type: 'text' },
  { key: 'penalty.returnFiledOn', type: 'text' },
]);
const Payment = z.strictObject({
  date: z.iso.date(),
  amount: z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/),
  kind: z.enum(['estimated', 'return-balance']),
});
export const UsPenaltyPaymentLedgerSchema = z.array(Payment).max(24);
export function parseUsPenaltyLedger(value: string) {
  const parsed = UsPenaltyPaymentLedgerSchema.parse(JSON.parse(value));
  for (const payment of parsed)
    if (payment.date < '2025-01-01' || payment.date > '2026-04-15')
      throw new Error('Payment outside2025 penalty window');
  return parsed;
}
const day = (date: string) =>
  BigInt(Date.parse(`${date}T00:00:00Z`) / 86400000);
export const US_2210_DUE_DATES = [
  '2025-04-15',
  '2025-06-16',
  '2025-09-15',
  '2026-01-15',
] as const;
const cutoff = '2026-04-15';
export type UsPenaltyInput = {
  currentYearTax: Q;
  withholding: Q;
  priorYearTax: Q;
  priorYearAgi: Q;
  priorYearFull12Months: boolean;
  priorYearFullResident: boolean;
  returnFiledOn: string;
  payments: z.infer<typeof UsPenaltyPaymentLedgerSchema>;
};
/** Equal installments/equal withholding regular method. Payments pay oldest unpaid installments.
 * IRS instructions: 7%/365 for all four2025 penalty rate periods; weekend rule adjusts June15.
 */
export function calculateUs2210Regular(input: UsPenaltyInput) {
  const current = input.currentYearTax;
  const priorFactor = lt(q(150000n), input.priorYearAgi) ? 110n : 100n;
  const prior = times(input.priorYearTax, priorFactor, 100n);
  const annual =
    input.priorYearFull12Months &&
    (input.priorYearTax.n > 0n || input.priorYearFullResident)
      ? minimum(times(positive(current), 9n, 10n), prior)
      : times(positive(current), 9n, 10n);
  const shortfall = minus(current, input.withholding);
  let exception: string | null = null;
  if (
    input.priorYearTax.n === 0n &&
    input.priorYearFull12Months &&
    input.priorYearFullResident
  )
    exception = 'prior-year-zero-tax-full-year-resident';
  else if (lt(current, q(1000n))) exception = 'current-year-tax-below1000';
  else if (lt(shortfall, q(1000n)))
    exception = 'tax-less-withholding-below1000';
  else if (!lt(input.withholding, annual))
    exception = 'withholding-covers-required-annual-payment';
  const netInstallment = times(
    positive(minus(annual, input.withholding)),
    1n,
    4n,
  );
  const outstanding = US_2210_DUE_DATES.map(() => netInstallment);
  const payments = [...input.payments].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  const paidByEarlyDeadline = payments
    .filter((p) => p.date <= '2026-02-02')
    .reduce((sum, p) => plus(sum, q(usdCents(p.amount), 100n)), q(0n));
  const earlyFinalException =
    input.returnFiledOn !== 'not-filed' &&
    input.returnFiledOn <= '2026-02-02' &&
    !lt(plus(input.withholding, paidByEarlyDeadline), current);
  const allocations: {
    installment: number;
    dueDate: string;
    paymentDate: string;
    amount: Q;
    days: string;
    penalty: Q;
  }[] = [];
  const allocate = (index: number, amount: Q, date: string) => {
    const days =
      day(date) > day(US_2210_DUE_DATES[index])
        ? day(date) - day(US_2210_DUE_DATES[index])
        : 0n;
    const penalty =
      exception || (index === 3 && earlyFinalException)
        ? q(0n)
        : times(amount, days * 7n, 36500n);
    allocations.push({
      installment: index + 1,
      dueDate: US_2210_DUE_DATES[index],
      paymentDate: date,
      amount,
      days: days.toString(),
      penalty,
    });
  };
  for (const payment of payments) {
    let remaining = q(usdCents(payment.amount), 100n);
    for (let index = 0; index < 4 && remaining.n > 0n; index++) {
      const amount = minimum(remaining, outstanding[index]);
      if (amount.n === 0n) continue;
      allocate(index, amount, payment.date);
      outstanding[index] = minus(outstanding[index], amount);
      remaining = minus(remaining, amount);
    }
  }
  for (let index = 0; index < 4; index++)
    if (outstanding[index].n > 0n) allocate(index, outstanding[index], cutoff);
  const penalty = allocations.reduce(
    (sum, item) => plus(sum, item.penalty),
    q(0n),
  );
  return {
    annual,
    prior,
    current,
    shortfall,
    netInstallment,
    penalty,
    exception,
    earlyFinalException,
    allocations,
    filing: 'not-required-regular-method-worksheet' as const,
  };
}
export function appendUs2210(g: UsReturnGraph) {
  const ledger = parseUsPenaltyLedger(String(g.fact('penalty.paymentLedger')));
  const input: UsPenaltyInput = {
    currentYearTax: minus(g.get('F1040.24'), g.get('F1040.32')),
    withholding: g.get('F1040.25d'),
    priorYearTax: g.money('penalty.priorYearTaxFor2210'),
    priorYearAgi: g.money('penalty.priorYearAgi'),
    priorYearFull12Months: g.fact('penalty.priorYearFull12Months') === true,
    priorYearFullResident: g.fact('penalty.priorYearFullResident') === true,
    returnFiledOn: String(g.fact('penalty.returnFiledOn')),
    payments: ledger,
  };
  const result = calculateUs2210Regular(input);
  g.copy('F2210', '1', 'F1040.22');
  g.copy('F2210', '2', 'S2.21');
  g.copy('F2210', '3', 'F1040.32');
  g.put('F2210', '4', result.current, ['F2210.1', 'F2210.2', 'F2210.3']);
  g.put('F2210', '5', times(result.current, 9n, 10n), ['F2210.4']);
  g.copy('F2210', '6', 'F1040.25d');
  g.put('F2210', '7', result.shortfall, ['F2210.4', 'F2210.6']);
  g.put(
    'F2210',
    '8',
    result.prior,
    [],
    ['penalty.priorYearTaxFor2210', 'penalty.priorYearAgi'],
  );
  const eligiblePrior =
    input.priorYearFull12Months &&
    (input.priorYearTax.n > 0n || input.priorYearFullResident);
  g.put(
    'F2210',
    '9',
    eligiblePrior
      ? minimum(g.get('F2210.5'), g.get('F2210.8'))
      : g.get('F2210.5'),
    ['F2210.5', 'F2210.8'],
    ['penalty.priorYearFull12Months', 'penalty.priorYearFullResident'],
  );
  // Form display consumes the entered line9. The statutory daily-allocation proof
  // stays separate and exact; it must not masquerade as an implemented printed
  // ScheduleA payment-column graph. Lines11–18 are intentionally withheld.
  for (const suffix of ['a', 'b', 'c', 'd'])
    g.put('F2210', `10.${suffix}`, times(g.get('F2210.9'), 1n, 4n), [
      'F2210.9',
    ]);
  g.issue(
    'form-2210-payment-column-display-unresolved',
    'Exact statutory regular-method penalty proof is available, but printed Form2210 payment/carryover columns11–18 are not fully implemented. Their amounts are withheld; no form-fidelity or complete-return claim.',
  );
  g.put(
    'F2210',
    '19',
    result.penalty,
    ['F2210.4', 'F2210.6'],
    US_PENALTY_REQUIRED_FACTS.map((f) => f.key),
  );
  g.copy('F1040', '38', 'F2210.19');
  return result;
}

export function serializeUsPenaltyProof(
  result: ReturnType<typeof calculateUs2210Regular>,
) {
  const rational = (value: Q) => ({
    numerator: value.n.toString(),
    denominator: value.d.toString(),
  });
  return {
    calculationBasis: 'exact-statutory-regular-method-payment-allocation',
    formDisplayComplete: false,
    unresolvedFormColumns: ['11', '12', '13', '14', '15', '16', '17', '18'],
    annual: rational(result.annual),
    penalty: rational(result.penalty),
    exception: result.exception,
    earlyFinalException: result.earlyFinalException,
    filing: result.filing,
    allocations: result.allocations.map((allocation) => ({
      ...allocation,
      amount: rational(allocation.amount),
      penalty: rational(allocation.penalty),
    })),
  };
}

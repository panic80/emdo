import { z } from 'zod';
import { deepFreeze } from '@emdo/contracts';
import { roundNonnegativeRatio, usdCents } from '../rounding.js';
const date = z.iso
  .date()
  .refine((value) => value >= '2025-01-01' && value <= '2026-04-15');
const payment = z.strictObject({
  date,
  amount: z.string().refine((value) => {
    try {
      usdCents(value);
      return true;
    } catch {
      return false;
    }
  }),
});
const payments = z.array(payment).max(24);
export const NY_PENALTY_REQUIRED_FACTS = deepFreeze([
  { key: 'penalty.method', type: 'text' },
  { key: 'penalty.paymentLedger', type: 'text' },
  { key: 'penalty.balancePaidOn', type: 'text' },
  ...[
    'priorYearTaxAfterCredits',
    'priorYearAgi',
    'priorYearMctdEarnings',
    'starCreditReceived',
  ].map((key) => ({ key: `penalty.${key}`, type: 'decimal' })),
  ...[
    'priorYearReturnFiled',
    'priorYearFull12Months',
    'priorYearNyResidentOrSourceIncome',
  ].map((key) => ({ key: `penalty.${key}`, type: 'boolean' })),
  ...[
    'annualization',
    'actualWithholdingDates',
    'waiverOrSpecialRelief',
    'priorYearJointReturn',
  ].map((key) => ({ key: `penalty.${key}`, type: 'boolean', equals: false })),
]);
const day = (value: string) =>
  Math.floor(Date.parse(`${value}T00:00:00Z`) / 86400000);
/** IT-2105.9 Part2. Explicit short-method election; original cents reconciled first.
 * Late/unequal installment cases require Part3, never an invented equal allocation.
 * balancePaidOn asserts the entire line21 underpayment was paid then; partial balance
 * payments require regular method. This is reviewed historical input, not a live payment.
 */
export function calculateNyShortPenalty2025(input: {
  taxBeforeRefundableCredits: bigint;
  refundableCredits: bigint;
  withholding: bigint;
  estimatedPayments: string;
  priorYearTaxAfterCredits: bigint;
  priorYearAgi: bigint;
  priorYearMctdEarnings: bigint;
  priorYearReturnFiled: boolean;
  priorYearFull12Months: boolean;
  priorYearNyResidentOrSourceIncome: boolean;
  subjectIncomeTaxCount: 1 | 2;
  paymentLedger: string;
  balancePaidOn: string;
}) {
  let ledger: z.infer<typeof payments>;
  try {
    ledger = payments.parse(JSON.parse(input.paymentLedger));
  } catch {
    throw new Error('invalid-ny-penalty-ledger');
  }
  if (
    ledger.reduce((sum, entry) => sum + usdCents(entry.amount), 0n) !==
    usdCents(input.estimatedPayments)
  )
    throw new Error('ny-penalty-payments-mismatch');
  // June16 is the actual2025 Monday payment due date. Payments earlier are permitted
  // under the elected short method, even if regular method would produce less penalty.
  const due = ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'];
  const sorted = ledger
    .filter((entry) => usdCents(entry.amount) > 0n)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (
    input.balancePaidOn !== 'unpaid' &&
    !date.safeParse(input.balancePaidOn).success
  )
    throw new Error('invalid-ny-penalty-balance-date');
  if (input.balancePaidOn !== 'unpaid' && input.balancePaidOn < '2026-01-15')
    throw new Error(
      'ny-penalty-early-partial-year-payment-requires-regular-method',
    );
  const current = input.taxBeforeRefundableCredits - input.refundableCredits;
  const ninety = current > 0n ? roundNonnegativeRatio(current * 90n, 100n) : 0n;
  const fields: Record<string, string> = {
    '1': input.taxBeforeRefundableCredits.toString(),
    '11': input.refundableCredits.toString(),
    '12': current.toString(),
    '13': ninety.toString(),
    '14': input.withholding.toString(),
    '15': (current - input.withholding).toString(),
  };
  const finish = (penalty: bigint, reason: string | null) =>
    deepFreeze({
      penalty: penalty.toString(),
      exception: reason,
      method: 'short-method',
      fields,
      sourceIds: ['ny-2025-it2105-9', 'ny-2025-it2105-9i'],
    });
  if (current - input.withholding < BigInt(input.subjectIncomeTaxCount) * 300n)
    return finish(0n, 'below-per-jurisdiction-threshold');
  if (
    input.priorYearTaxAfterCredits === 0n &&
    input.priorYearFull12Months &&
    input.priorYearNyResidentOrSourceIncome
  )
    return finish(0n, 'no-prior-year-tax-liability');
  let annual = ninety;
  if (
    input.priorYearReturnFiled &&
    input.priorYearFull12Months &&
    (input.priorYearTaxAfterCredits > 0n ||
      input.priorYearNyResidentOrSourceIncome)
  ) {
    const prior =
      input.priorYearAgi > 150000n || input.priorYearMctdEarnings > 150000n
        ? roundNonnegativeRatio(input.priorYearTaxAfterCredits * 110n, 100n)
        : input.priorYearTaxAfterCredits;
    fields['16'] = prior.toString();
    annual = prior < annual ? prior : annual;
  }
  fields['17'] = annual.toString();
  if (input.withholding >= annual)
    return finish(0n, 'withholding-meets-required-annual-payment');
  if (
    sorted.length &&
    (sorted.length !== 4 ||
      sorted.some(
        (entry, index) =>
          entry.date > due[index]! ||
          usdCents(entry.amount) !== usdCents(sorted[0]!.amount),
      ))
  )
    throw new Error('ny-penalty-regular-method-required');
  const estimated = roundNonnegativeRatio(
    usdCents(input.estimatedPayments),
    100n,
  );
  fields['18'] = input.withholding.toString();
  fields['19'] = estimated.toString();
  fields['20'] = (input.withholding + estimated).toString();
  const under = annual - input.withholding - estimated;
  fields['21'] = under.toString();
  if (under <= 0n) return finish(0n, 'no-short-method-underpayment');
  const initial = roundNonnegativeRatio(under * 6313n, 100000n);
  const days =
    input.balancePaidOn === 'unpaid'
      ? 0
      : day('2026-04-15') - day(input.balancePaidOn);
  const reduction = roundNonnegativeRatio(under * BigInt(days) * 26n, 100000n);
  fields['22'] = initial.toString();
  fields['23'] = reduction.toString();
  fields['24'] = (initial - reduction).toString();
  return finish(initial - reduction, null);
}

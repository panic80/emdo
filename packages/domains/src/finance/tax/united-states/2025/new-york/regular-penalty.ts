import { z } from 'zod';
import { deepFreeze } from '@emdo/contracts';
import { calculateNyShortPenalty2025 } from './penalty.js';
import { usdCents, roundNonnegativeRatio } from '../rounding.js';

const day = (value: string) =>
  Math.floor(Date.parse(`${value}T00:00:00Z`) / 86400000);
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
const periods = [
  { start: '2025-04-15', end: '2025-06-15', line: '32' },
  { start: '2025-06-15', end: '2025-09-15', line: '34' },
  { start: '2025-09-15', end: '2026-01-15', line: '36' },
  { start: '2026-01-15', end: '2026-04-15', line: '38' },
] as const;
/** NY IT-2105.9-I p3: truncate day ratio at4 places, then9.5% factor at5.
 * The January segment includes Jan1, so the exclusive lower boundary is Dec31.
 */
export function nyRegularPenaltyFactor2025(days: number) {
  if (!Number.isInteger(days) || days < 0 || days > 365)
    throw new Error('ny-penalty-days-invalid');
  const ratio = (BigInt(days) * 10000n) / 365n;
  const factor = (ratio * 95n) / 100n;
  return deepFreeze({
    days,
    ratio: `${ratio / 10000n}.${(ratio % 10000n).toString().padStart(4, '0')}`,
    factor: `0.${factor.toString().padStart(5, '0')}`,
    factorUnits: factor.toString(),
  });
}
/** One published ScheduleB period. Original cents are allocated to the oldest
 * outstanding balance; partial-payment products are added BEFORE rounding this line,
 * exactly as the official $3000/$2000 Example3. Dec31 remains a separate factor.
 */
export function calculateNyRegularPeriod2025(input: {
  period: 0 | 1 | 2 | 3;
  underpayment: string;
  payments: readonly { date: string; amount: string }[];
}) {
  const period = periods[input.period];
  if (!period) throw new Error('ny-penalty-period-invalid');
  let remaining = usdCents(input.underpayment);
  const parsed = z.array(payment).max(30).parse(input.payments);
  if (
    parsed.some(
      (entry) => entry.date <= period.start || entry.date > period.end,
    )
  )
    throw new Error('ny-period-payment-date-invalid');
  const combined = new Map<string, bigint>();
  for (const entry of parsed)
    combined.set(
      entry.date,
      (combined.get(entry.date) ?? 0n) + usdCents(entry.amount),
    );
  const allocations: {
    paymentDate: string;
    paidCents: string;
    segments: ReturnType<typeof nyRegularPenaltyFactor2025>[];
    exactNumerator: string;
    exactDenominator: string;
  }[] = [];
  const allocate = (paidCents: bigint, paidOn: string) => {
    if (paidCents === 0n) return;
    const segments =
      input.period === 2 && paidOn > '2025-12-31'
        ? [
            nyRegularPenaltyFactor2025(day('2025-12-31') - day(period.start)),
            nyRegularPenaltyFactor2025(day(paidOn) - day('2025-12-31')),
          ]
        : [nyRegularPenaltyFactor2025(day(paidOn) - day(period.start))];
    const factor = segments.reduce(
      (sum, segment) => sum + BigInt(segment.factorUnits),
      0n,
    );
    allocations.push({
      paymentDate: paidOn,
      paidCents: paidCents.toString(),
      segments,
      exactNumerator: (paidCents * factor).toString(),
      exactDenominator: '10000000',
    });
  };
  for (const [paidOn, amount] of [...combined].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const applied = amount < remaining ? amount : remaining;
    allocate(applied, paidOn);
    remaining -= applied;
  }
  allocate(remaining, period.end);
  const numerator = allocations.reduce(
    (sum, entry) => sum + BigInt(entry.exactNumerator),
    0n,
  );
  return deepFreeze({
    period: input.period,
    ...period,
    underpayment: input.underpayment,
    allocations,
    exactNumerator: numerator.toString(),
    exactDenominator: '10000000',
    penalty: roundNonnegativeRatio(numerator, 10000000n).toString(),
    sourceId: 'ny-2025-it2105-9i',
    locator:
      'pp3–4 ScheduleB lines31–38; Examples1–3; four/five-place truncation and Dec31 split',
  });
}

export const NY_REGULAR_PENALTY_FACTS = deepFreeze([
  { key: 'penalty.returnFiledOn', type: 'text' },
  { key: 'penalty.returnBalancePaidOn', type: 'text' },
  { key: 'penalty.returnBalancePaid', type: 'decimal' },
  {
    key: 'penalty.earlyReturnFourthInstallmentException',
    type: 'boolean',
    equals: false,
  },
]);
const dollars = (cents: bigint) =>
  `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
/** Ordinary regular method with uniform withholding. Annualization, changed
 * withholding dates and special relief are separately excluded by reviewed intake.
 * June16 is timely for the second installment, but a payment on that date allocated
 * to a prior April shortfall is blocked until the nominal/actual boundary is resolved.
 */
export function calculateNyRegularPenalty2025(
  input: Parameters<typeof calculateNyShortPenalty2025>[0] & {
    returnFiledOn: string;
    returnBalancePaidOn: string;
    returnBalancePaid: string;
  },
) {
  for (const value of [
    input.taxBeforeRefundableCredits,
    input.refundableCredits,
    input.withholding,
    input.priorYearTaxAfterCredits,
    input.priorYearAgi,
    input.priorYearMctdEarnings,
  ])
    if (value < 0n) throw new Error('ny-penalty-negative-input');
  let ledger: z.infer<typeof payment>[];
  try {
    ledger = z.array(payment).max(24).parse(JSON.parse(input.paymentLedger));
  } catch {
    throw new Error('invalid-ny-penalty-ledger');
  }
  if (
    ledger.reduce((sum, entry) => sum + usdCents(entry.amount), 0n) !==
    usdCents(input.estimatedPayments)
  )
    throw new Error('ny-penalty-payments-mismatch');
  if (input.balancePaidOn !== 'unpaid')
    throw new Error('ny-regular-requires-explicit-return-payment-facts');
  const paid = usdCents(input.returnBalancePaid);
  if (
    input.returnFiledOn !== 'not-filed' &&
    (!date.safeParse(input.returnFiledOn).success ||
      input.returnFiledOn < '2026-01-01')
  )
    throw new Error('ny-return-filing-date-invalid');
  if (paid === 0n) {
    if (input.returnBalancePaidOn !== 'unpaid')
      throw new Error('ny-unused-return-payment-date');
  } else if (
    input.returnFiledOn === 'not-filed' ||
    !date.safeParse(input.returnBalancePaidOn).success ||
    input.returnBalancePaidOn < '2026-01-01' ||
    input.returnBalancePaidOn > input.returnFiledOn
  )
    throw new Error('ny-return-payment-not-bound-to-filed-return');
  // Ordinary Table4 payments only. The distinct early-return fourth-installment
  // substitution requires an explicit eligibility/complete-tax-payment implementation.
  if (paid > 0n && input.returnFiledOn <= '2026-01-15')
    throw new Error('ny-early-return-installment-substitution-required');
  const base = calculateNyShortPenalty2025({
    ...input,
    estimatedPayments: '0',
    paymentLedger: '[]',
    balancePaidOn: 'unpaid',
  });
  const fields: Record<string, string> = Object.fromEntries(
    Object.entries(base.fields).filter(([key]) => Number(key) <= 17),
  );
  const scheduleATrace: {
    key: string;
    exactNumerator: string;
    exactDenominator: string;
    enteredDollars: string;
    dependencies: string[];
  }[] = [];
  const finish = (
    proofs: ReturnType<typeof calculateNyRegularPeriod2025>[],
    exception: string | null,
  ) => {
    const penalty = proofs
      .reduce((sum, proof) => sum + BigInt(proof.penalty), 0n)
      .toString();
    if (proofs.length) fields['39'] = penalty;
    return deepFreeze({
      method: 'regular-method',
      penalty,
      exception,
      fields,
      periods: proofs,
      scheduleATrace,
      sourceIds: ['ny-2025-it2105-9', 'ny-2025-it2105-9i', 'ny-2025-it2105i'],
      timelinessDates: ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
    });
  };
  if (base.exception) return finish([], base.exception);
  const annual = BigInt(fields['17']!);
  const installment = roundNonnegativeRatio(annual, 4n);
  const withholdingCents = input.withholding * 25n;
  const proofs: ReturnType<typeof calculateNyRegularPeriod2025>[] = [];
  let carry = 0n;
  // Table4 return payments do not become IT201 estimated-payment credits.
  const actualPayments = [...ledger];
  if (paid > 0n)
    actualPayments.push({
      date: input.returnFiledOn,
      amount: input.returnBalancePaid,
    });
  for (let index = 0; index < 4; index++) {
    const period = periods[index]!;
    const column = 'abcd'[index]!;
    if (
      index === 1 &&
      carry < 0n &&
      ledger.some(
        (entry) => entry.date === '2025-06-16' && usdCents(entry.amount) > 0n,
      )
    ) {
      const priorPayments = ledger
        .filter(
          (entry) => entry.date > '2025-04-15' && entry.date <= '2025-06-15',
        )
        .reduce((sum, entry) => sum + usdCents(entry.amount), withholdingCents);
      if (-carry * 100n > priorPayments)
        throw new Error('ny-june16-prior-underpayment-boundary-unresolved');
    }
    const adjusted = actualPayments.map((entry) =>
      entry.date === '2025-06-16' ? { ...entry, date: '2025-06-15' } : entry,
    );
    const before = index === 0 ? '2024-12-31' : periods[index - 1]!.start;
    const installmentPayments = adjusted.filter(
      (entry) => entry.date > before && entry.date <= period.start,
    );
    const paymentCents = installmentPayments.reduce(
      (sum, entry) => sum + usdCents(entry.amount),
      withholdingCents,
    );
    const enteredPayment = roundNonnegativeRatio(paymentCents, 100n);
    scheduleATrace.push(
      {
        key: `25${column}`,
        exactNumerator: annual.toString(),
        exactDenominator: '4',
        enteredDollars: installment.toString(),
        dependencies: ['17'],
      },
      {
        key: `26${column}`,
        exactNumerator: paymentCents.toString(),
        exactDenominator: '100',
        enteredDollars: enteredPayment.toString(),
        dependencies: ['withholding', 'paymentLedger'],
      },
    );
    const available = enteredPayment + carry;
    const net = available - installment;
    fields[`25${column}`] = installment.toString();
    fields[`26${column}`] = enteredPayment.toString();
    if (index > 0) fields[`27${column}`] = carry.toString();
    fields[`28${column}`] = available.toString();
    fields[`29${column}`] = (-net).toString();
    fields[`30${column}`] = (net < 0n ? -net : 0n).toString();
    carry = net;
    const inPeriod = adjusted.filter(
      (entry) => entry.date > period.start && entry.date <= period.end,
    );
    if (index < 3)
      inPeriod.push({ date: period.end, amount: dollars(withholdingCents) });
    const proof = calculateNyRegularPeriod2025({
      period: index as 0 | 1 | 2 | 3,
      underpayment: fields[`30${column}`]!,
      payments: inPeriod,
    });
    fields[period.line] = proof.penalty;
    proofs.push(proof);
  }
  return finish(proofs, null);
}

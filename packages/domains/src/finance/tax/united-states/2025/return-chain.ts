import { appendUs2210, serializeUsPenaltyProof } from './penalty.js';
import { roundNonnegativeRatio } from './rounding.js';
import { deepFreeze } from '@emdo/contracts';
import {
  q,
  plus,
  minus,
  times,
  lt,
  positive,
  minimum,
  type Q,
} from './exact.js';
import { singleIncomeTax2025, singleNoChildEic2025 } from './tables.js';

export const US_RETURN_REQUIRED_FACTS = deepFreeze([
  { key: 'deductionMethod', type: 'text', equals: 'standard' },
  { key: 'qbi.qualifiedDomesticTrade', type: 'boolean', equals: true },
  { key: 'eic.ageBand', type: 'text' },
  ...['eic.validEmploymentSsn', 'eic.mainHomeInUsMoreThanHalfYear'].map(
    (key) => ({ key, type: 'boolean' }),
  ),
  ...[
    'qbi.priorLossOrSuspendedLoss',
    'qbi.cooperativePatron',
    'qbi.reitOrPtp',
    'schedule1AEligibleDeductions',
    'otherCreditClaims',
    'otherTaxesOrRecaptures',
    'amtAdjustmentsOrPreferences',
    'eic.qualifyingChildOfAnother',
    'eic.priorDisallowance',
    'eic.excludedWagesOrCombatElection',
  ].map((key) => ({ key, type: 'boolean', equals: false })),
  ...[
    'w2.box2',
    'w2.box6',
    'payments.1099Withholding',
    'payments.estimatedAndPriorYearApplied',
    'payments.applyTo2026',
  ].map((key) => ({ key, type: 'decimal' })),
]);
export const US_RETURN_LINE_INVENTORY = deepFreeze({
  F8995: [
    '1i.c',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    '10',
    '11',
    '12',
    '13',
    '14',
    '15',
    '16',
    '17',
  ],
  F6251: ['1a', '1b', '2a', '4', '5', '6', '7', '8', '9', '10', '11'],
  F8959: [
    '1',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    '10',
    '11',
    '12',
    '13',
    '18',
    '19',
    '20',
    '21',
    '22',
    '24',
  ],
  EICB: [
    '1a',
    '1b',
    '1c',
    '1d',
    '1e',
    '2b',
    '2c',
    '4a',
    '4b',
    '6',
    '7',
    '8',
    '11',
  ],
  S2: ['1z', '2', '3', '11', '21'],
  F1040: [
    '12e',
    '13a',
    '13b',
    '14',
    '15',
    '16',
    '17',
    '18',
    '19',
    '20',
    '21',
    '22',
    '23',
    '24',
    '25a',
    '25b',
    '25c',
    '25d',
    '26',
    '27a',
    '28',
    '29',
    '30',
    '31',
    '32',
    '33',
    '34',
    '35a',
    '36',
    '37',
  ],
} as const);
export type UsReturnGraph = {
  get(key: string): Q;
  put(
    form: string,
    line: string,
    value: Q,
    dependencies?: string[],
    facts?: string[],
  ): Q;
  copy(form: string, line: string, key: string): Q;
  money(key: string): Q;
  fact(key: string): string | boolean;
  issue(code: string, message: string): void;
};
/** Ordinary single-filer extension. A generic form graph owns values and provenance. */
export function appendUs2025ReturnChain(g: UsReturnGraph) {
  const { put, copy, get } = g;
  const zero = (
    form: string,
    line: string,
    deps: string[] = [],
    facts: string[] = [],
  ) => put(form, line, q(0n), deps, facts);
  const sourceMoney = (form: string, line: string, key: string) =>
    put(form, line, g.money(key), [], [key]);
  const agi = get('F1040.11b');
  const standard = put(
    'F1040',
    '12e',
    q(15750n),
    [],
    ['deductionMethod', 'claimableAsDependant', 'age65OrBlind'],
  );
  zero('F1040', '13b', [], ['schedule1AEligibleDeductions']);
  const beforeQbi = minus(agi, standard);
  const businessQbi = positive(minus(get('C.31'), get('S1.15')));
  put(
    'F8995',
    '1i.c',
    businessQbi,
    ['C.31', 'S1.15'],
    ['qbi.qualifiedDomesticTrade'],
  );
  copy('F8995', '2', 'F8995.1i.c');
  zero('F8995', '3', [], ['qbi.priorLossOrSuspendedLoss']);
  copy('F8995', '4', 'F8995.2');
  const component = put('F8995', '5', times(businessQbi, 1n, 5n), ['F8995.4']);
  for (const line of ['6', '7', '8', '9'])
    zero('F8995', line, [], ['qbi.reitOrPtp']);
  copy('F8995', '10', 'F8995.5');
  put('F8995', '11', beforeQbi, ['F1040.11b', 'F1040.12e', 'F1040.13b']);
  if (lt(q(197300n), beforeQbi) && businessQbi.n > 0n) {
    g.issue(
      'form-8995-a-required',
      'Taxable income before QBI exceeds $197,300; wage/property/SSTB phase-in rules and Form8995-A are required. Downstream tax and refund are blocked.',
    );
    return;
  }
  zero('F8995', '12', [], ['otherIncome']);
  put('F8995', '13', positive(beforeQbi), ['F8995.11', 'F8995.12']);
  const limit = put('F8995', '14', times(positive(beforeQbi), 1n, 5n), [
    'F8995.13',
  ]);
  const deduction = put('F8995', '15', minimum(component, limit), [
    'F8995.10',
    'F8995.14',
  ]);
  zero('F8995', '16', ['F8995.2', 'F8995.3']);
  zero('F8995', '17', ['F8995.6', 'F8995.7']);
  copy('F1040', '13a', 'F8995.15');
  const deductions = put('F1040', '14', plus(standard, deduction), [
    'F1040.12e',
    'F1040.13a',
    'F1040.13b',
  ]);
  const taxable = put('F1040', '15', positive(minus(agi, deductions)), [
    'F1040.11b',
    'F1040.14',
  ]);
  const tax = singleIncomeTax2025(taxable);
  put('F1040', '16', tax.amount, ['F1040.15']);

  // 6251 ordinary standard deduction, no special adjustments, capital gains or foreign tax credit.
  copy('F6251', '1a', 'F1040.14');
  put('F6251', '1b', minus(agi, deductions), ['F1040.11b', 'F6251.1a']);
  copy('F6251', '2a', 'F1040.12e');
  const amti = put(
    'F6251',
    '4',
    minus(agi, deduction),
    ['F6251.1b', 'F6251.2a'],
    ['amtAdjustmentsOrPreferences'],
  );
  if (lt(q(626350n), amti)) {
    g.issue(
      'amt-exemption-phaseout-not-implemented',
      'AMTI exceeds the $626,350 single-filer exemption phaseout threshold; downstream totals are blocked.',
    );
    return;
  }
  put('F6251', '5', q(88100n));
  const amtBase = put('F6251', '6', positive(minus(amti, q(88100n))), [
    'F6251.4',
    'F6251.5',
  ]);
  // Positive-QBI cases are bounded by Form8995; zero-QBI cases are independently gated above.
  const tentative = put(
    'F6251',
    '7',
    lt(q(239100n), amtBase)
      ? minus(times(amtBase, 28n, 100n), q(4782n))
      : times(amtBase, 26n, 100n),
    ['F6251.6'],
  );
  zero('F6251', '8', [], ['otherCreditClaims']);
  copy('F6251', '9', 'F6251.7');
  copy('F6251', '10', 'F1040.16');
  put('F6251', '11', positive(minus(tentative, tax.amount)), [
    'F6251.9',
    'F6251.10',
  ]);
  zero('S2', '1z', [], ['otherTaxesOrRecaptures']);
  copy('S2', '2', 'F6251.11');
  copy('S2', '3', 'S2.2');
  copy('F1040', '17', 'S2.3');
  const beforeCredits = put('F1040', '18', plus(tax.amount, get('S2.3')), [
    'F1040.16',
    'F1040.17',
  ]);
  zero('F1040', '19', [], ['dependants']);
  zero('F1040', '20', [], ['otherCreditClaims']);
  zero('F1040', '21', ['F1040.19', 'F1040.20']);
  copy('F1040', '22', 'F1040.18');

  // 8959 ordinary Medicare wages + SE earnings; railroad and unreported wages excluded.
  const medicareWages = sourceMoney('F8959', '1', 'w2.box5');
  copy('F8959', '4', 'F8959.1');
  put('F8959', '5', q(200000n));
  const wageExcess = put(
    'F8959',
    '6',
    positive(minus(medicareWages, q(200000n))),
    ['F8959.4', 'F8959.5'],
  );
  const wageAdditional = put('F8959', '7', times(wageExcess, 9n, 1000n), [
    'F8959.6',
  ]);
  const seEarnings = lt(get('SE.4c'), q(400n)) ? q(0n) : get('SE.4c');
  put('F8959', '8', seEarnings, ['SE.4c']);
  put('F8959', '9', q(200000n));
  copy('F8959', '10', 'F8959.4');
  const seRoom = put(
    'F8959',
    '11',
    positive(minus(q(200000n), medicareWages)),
    ['F8959.9', 'F8959.10'],
  );
  const seExcess = put('F8959', '12', positive(minus(seEarnings, seRoom)), [
    'F8959.8',
    'F8959.11',
  ]);
  const seAdditional = put('F8959', '13', times(seExcess, 9n, 1000n), [
    'F8959.12',
  ]);
  const additional = put(
    'F8959',
    '18',
    plus(wageAdditional, seAdditional),
    ['F8959.7', 'F8959.13'],
    ['railroadCompensation'],
  );
  const withheld = sourceMoney('F8959', '19', 'w2.box6');
  copy('F8959', '20', 'F8959.1');
  const normalWithholding = put(
    'F8959',
    '21',
    times(medicareWages, 145n, 10000n),
    ['F8959.20'],
  );
  put('F8959', '22', positive(minus(withheld, normalWithholding)), [
    'F8959.19',
    'F8959.21',
  ]);
  copy('F8959', '24', 'F8959.22');
  copy('S2', '11', 'F8959.18');
  const otherTax = put(
    'S2',
    '21',
    plus(get('S2.4'), additional),
    ['S2.4', 'S2.11'],
    ['otherTaxesOrRecaptures'],
  );
  copy('F1040', '23', 'S2.21');
  const totalTax = put('F1040', '24', plus(beforeCredits, otherTax), [
    'F1040.22',
    'F1040.23',
  ]);

  // Worksheet B: in this no-other-income/adjustment case earned income equals AGI.
  const seDeduction = get('S1.15');
  if (lt(get('SE.4c'), q(400n))) {
    copy('EICB', '2b', 'C.31');
    copy('EICB', '2c', 'EICB.2b');
  } else {
    copy('EICB', '1a', 'SE.3');
    zero('EICB', '1b', [], ['optionalSeMethod', 'churchOrClergy']);
    copy('EICB', '1c', 'EICB.1a');
    copy('EICB', '1d', 'S1.15');
    put('EICB', '1e', minus(get('C.31'), seDeduction), ['EICB.1c', 'EICB.1d']);
  }
  copy('EICB', '4a', 'F1040.1z');
  const earned = put(
    'EICB',
    '4b',
    plus(get('F1040.1z'), minus(get('C.31'), seDeduction)),
    ['EICB.4a', lt(get('SE.4c'), q(400n)) ? 'EICB.2c' : 'EICB.1e'],
  );
  copy('EICB', '6', 'EICB.4b');
  copy('EICB', '8', 'F1040.11b');
  const eicEligible =
    g.fact('eic.ageBand') === '25-to-64' &&
    g.fact('eic.validEmploymentSsn') === true &&
    g.fact('eic.mainHomeInUsMoreThanHalfYear') === true;
  const eic = eicEligible ? singleNoChildEic2025(earned) : 0n;
  put(
    'EICB',
    '7',
    q(eic),
    ['EICB.6'],
    [
      'eic.ageBand',
      'eic.validEmploymentSsn',
      'eic.mainHomeInUsMoreThanHalfYear',
      'eic.qualifyingChildOfAnother',
      'eic.priorDisallowance',
    ],
  );
  copy('EICB', '11', 'EICB.7');
  copy('F1040', '27a', 'EICB.11');
  // Equal earned income and AGI means WorksheetB line10 is expressly skipped.
  const w2Withholding = sourceMoney('F1040', '25a', 'w2.box2');
  const otherWithholding = sourceMoney(
    'F1040',
    '25b',
    'payments.1099Withholding',
  );
  const additionalWithholding = copy('F1040', '25c', 'F8959.24');
  const totalWithholding = put(
    'F1040',
    '25d',
    plus(plus(w2Withholding, otherWithholding), additionalWithholding),
    ['F1040.25a', 'F1040.25b', 'F1040.25c'],
  );
  const estimated = sourceMoney(
    'F1040',
    '26',
    'payments.estimatedAndPriorYearApplied',
  );
  for (const line of ['28', '29', '30', '31'])
    zero('F1040', line, [], ['dependants', 'otherCreditClaims']);
  const refundable = copy('F1040', '32', 'F1040.27a');
  const payments = put(
    'F1040',
    '33',
    plus(plus(totalWithholding, estimated), refundable),
    ['F1040.25d', 'F1040.26', 'F1040.32'],
  );
  const penaltyResult = appendUs2210(g);
  const reported = (value: Q) => q(roundNonnegativeRatio(value.n, value.d));
  // IRS1040 instructions require35a+36+38 to reconcile to34. Settlement uses reported dollars.
  const reportedTax = reported(totalTax);
  const reportedPayments = reported(payments);
  const penalty = reported(penaltyResult.penalty);
  const overpaid = put(
    'F1040',
    '34',
    positive(minus(reportedPayments, reportedTax)),
    ['F1040.33', 'F1040.24'],
  );
  const available = positive(minus(overpaid, penalty));
  const apply = reported(g.money('payments.applyTo2026'));
  if (lt(available, apply)) {
    g.issue(
      'invalid-refund-allocation',
      'Amount applied to2026 exceeds overpayment after the calculated penalty; refund allocation is blocked.',
    );
    return { penalty: serializeUsPenaltyProof(penaltyResult) };
  }
  put('F1040', '36', apply, [], ['payments.applyTo2026']);
  put('F1040', '35a', minus(available, apply), [
    'F1040.34',
    'F1040.38',
    'F1040.36',
  ]);
  put(
    'F1040',
    '37',
    positive(plus(minus(reportedTax, reportedPayments), penalty)),
    ['F1040.24', 'F1040.33', 'F1040.38'],
  );
  return { penalty: serializeUsPenaltyProof(penaltyResult) };
}

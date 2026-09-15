import {
  deepFreeze,
  FinanceCanadaCpp2025InputSchema,
  type FinanceCanadaCpp2025Input,
} from '@emdo/contracts';
export const CANADA_CPP_2025_SOURCE = deepFreeze({
  id: 'cra-5000-s8-2025-etext',
  authority: 'Canada Revenue Agency',
  url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5000-s8/5000-s8-25e.txt',
  formVersion: '5000-S8 E (25)',
  documentHash:
    'db859d06606fd7a13c7c2875ab5299d4780d37d8a28ffe77b9f0650d0ef988d2',
  retrievedAt: '2026-09-14T02:03:04.246324+00:00',
});
type R = { n: bigint; d: bigint };
function r(n: bigint, d = 1n): R {
  if (d <= 0n) throw Error('invalid-denominator');
  let a = n < 0n ? -n : n,
    b = d;
  while (b) [a, b] = [b, a % b];
  return { n: n / a, d: d / a };
}
function q(value: string): R {
  const negative = value.startsWith('-');
  const [w, f = ''] = (negative ? value.slice(1) : value).split('.');
  return r(BigInt(w! + f) * (negative ? -1n : 1n), 10n ** BigInt(f.length));
}
const zero = q('0'),
  add = (a: R, b: R) => r(a.n * b.d + b.n * a.d, a.d * b.d),
  sub = (a: R, b: R) => r(a.n * b.d - b.n * a.d, a.d * b.d),
  mul = (a: R, b: R) => r(a.n * b.n, a.d * b.d),
  cmp = (a: R, b: R) => a.n * b.d - b.n * a.d,
  min = (a: R, b: R) => (cmp(a, b) < 0n ? a : b),
  pos = (a: R) => (a.n < 0n ? zero : a),
  neg = (a: R) => r(-a.n, a.d),
  sum = (...values: R[]) => values.reduce(add, zero),
  rate = (a: R, b: string) => mul(a, q(b));
function exact(value: R) {
  let d = value.d,
    twos = 0,
    fives = 0;
  while (d % 2n === 0n) {
    twos++;
    d /= 2n;
  }
  while (d % 5n === 0n) {
    fives++;
    d /= 5n;
  }
  let decimal: string | null = null;
  if (d === 1n) {
    const places = Math.max(twos, fives),
      absolute = value.n < 0n ? -value.n : value.n,
      digits = ((absolute * 10n ** BigInt(places)) / value.d)
        .toString()
        .padStart(places + 1, '0');
    decimal =
      (value.n < 0n ? '-' : '') +
      (places
        ? `${digits.slice(0, -places)}.${digits.slice(-places)}`.replace(
            /\.?0+$/,
            '',
          )
        : digits);
  }
  return {
    exactRational: {
      numerator: value.n.toString(),
      denominator: value.d.toString(),
    },
    exactDecimal: decimal,
  };
}
/** Part2 A=0 gives zero limits; rows1–12 are the literal published table, not annual limits divided and rounded by us. */
export const CPP_2025_PRORATION = deepFreeze([
  ['0', '0', '0', '0'],
  ['5941.67', '825', '6766.67', '291.67'],
  ['11883.33', '1650', '13533.33', '583.33'],
  ['17825', '2475', '20300', '875'],
  ['23766.67', '3300', '27066.67', '1166.67'],
  ['29708.33', '4125', '33833.33', '1458.33'],
  ['35650', '4950', '40600', '1750'],
  ['41591.67', '5775', '47366.67', '2041.67'],
  ['47533.33', '6600', '54133.33', '2333.33'],
  ['53475', '7425', '60900', '2625'],
  ['59416.67', '8250', '67666.67', '2916.67'],
  ['65358.33', '9075', '74433.33', '3208.33'],
  ['71300', '9900', '81200', '3500'],
] as const);
function eligibility(input: FinanceCanadaCpp2025Input) {
  const issues: string[] = [];
  if (
    !input.domesticCase ||
    input.residentProvinceOnDecember31 === 'QC' ||
    input.hasQuebecEarnedIncome ||
    input.hasQppContributions
  )
    issues.push('outside-domestic-non-quebec-schedule8');
  const birthYear = Number(input.dateOfBirth.slice(0, 4)),
    birthMonth = Number(input.dateOfBirth.slice(5, 7));
  if (birthYear < 1900 || input.dateOfBirth > '2025-12-31')
    issues.push('unsupported-birth-date');
  if (
    input.dateOfDeath !== null &&
    (!input.dateOfDeath.startsWith('2025-') ||
      input.dateOfDeath < input.dateOfBirth)
  )
    issues.push('unsupported-death-date');
  const ageMonth = (age: number) => (birthYear + age - 2025) * 12 + birthMonth;
  const retirementMonth =
    input.retirementPensionStartDate === null
      ? null
      : (Number(input.retirementPensionStartDate.slice(0, 4)) - 2025) * 12 +
        Number(input.retirementPensionStartDate.slice(5, 7));
  if (
    retirementMonth !== null &&
    (retirementMonth > 12 ||
      input.retirementPensionStartDate! < input.dateOfBirth)
  )
    issues.push('invalid-retirement-start');
  if (
    input.retirementPensionStartDate?.startsWith('2025-') &&
    input.basicExemption.kind !== 'cra-determined'
  )
    issues.push('cra-basic-exemption-determination-required');
  if (
    input.basicExemption.kind === 'cra-determined' &&
    cmp(q(input.basicExemption.amount), q('3500')) > 0n
  )
    issues.push('invalid-cra-basic-exemption');
  const hasEmployment = input.t4Slips.length > 0;
  let stopFrom = 13,
    resumeFrom = 1;
  const change =
    input.election.kind === 'none'
      ? null
      : input.election.kind === 'stop-in-2025'
        ? input.election.change
        : input.election.revocation;
  if (input.election.kind === 'prior-stop') {
    if (
      !input.election.priorElectionValid ||
      ageMonth(65) > 0 ||
      retirementMonth === null ||
      retirementMonth > 0
    )
      issues.push('invalid-prior-election');
    stopFrom = 1;
    resumeFrom = change ? 0 : 13;
  }
  if (change) {
    const effective =
      change.channel === 'cpt30'
        ? Number(change.deliveredToEmployerDate.slice(5, 7)) + 1
        : change.effectiveMonth;
    const decision =
      change.channel === 'cpt30'
        ? Number(change.deliveredToEmployerDate.slice(5, 7))
        : change.effectiveMonth;
    if (change.channel === 'cpt30') {
      const birthday65 = String(birthYear + 65) + input.dateOfBirth.slice(4),
        birthday70 = String(birthYear + 70) + input.dateOfBirth.slice(4);
      if (
        !change.deliveredToEmployerDate.startsWith('2025-') ||
        change.deliveredToEmployerDate < birthday65 ||
        change.deliveredToEmployerDate >= birthday70 ||
        input.retirementPensionStartDate === null ||
        change.deliveredToEmployerDate < input.retirementPensionStartDate
      )
        issues.push('cpt30-date-ineligible');
      if (
        input.dateOfBirth.endsWith('-02-29') &&
        (birthYear + 65 === 2025 || birthYear + 70 === 2025)
      )
        issues.push('leap-day-election-age-review-required');
    }
    if (
      change.channel === 'cpt30' &&
      (!hasEmployment || !change.completedAndSentToCra)
    )
      issues.push('cpt30-election-evidence-required');
    if (
      change.channel === 'schedule8' &&
      (hasEmployment || !change.madeByJune152027)
    )
      issues.push('unsupported-or-unconfirmed-schedule8-election');
    if (
      ageMonth(65) > decision ||
      ageMonth(70) < decision ||
      retirementMonth === null ||
      retirementMonth > decision
    )
      issues.push('election-age-or-pension-ineligible');
    if (input.election.kind === 'prior-stop') {
      resumeFrom = effective;
      stopFrom = 13;
    } else stopFrom = effective;
  }
  const beforeDeath = Array.from({ length: 12 }, (_, i) => i + 1).filter(
    (m) =>
      m > ageMonth(18) &&
      m <= ageMonth(70) &&
      !input.disabilityPensionMonths.includes(m) &&
      m < stopFrom &&
      m >= resumeFrom,
  );
  const deathMonth =
    input.dateOfDeath === null ? 12 : Number(input.dateOfDeath.slice(5, 7));
  const months = beforeDeath.filter((m) => m <= deathMonth);
  // The printed exception does not establish a combined death/other-event
  // earnings proration rule. Block rather than manufacture that treatment.
  if (
    input.dateOfDeath !== null &&
    beforeDeath.length !== 12 &&
    q(input.annualNetSelfEmploymentEarnings).n !== 0n
  )
    issues.push('combined-death-self-employment-proration-review-required');
  if (
    input.otherEarningsElection.kind === 'cpt20' &&
    (!input.otherEarningsElection.completed ||
      (!hasEmployment && q(input.otherEarningsElection.earningsOnT4).n !== 0n))
  )
    issues.push('invalid-cpt20-election');
  if (
    new Set(input.t4Slips.map((s) => s.reference)).size !== input.t4Slips.length
  )
    issues.push('duplicate-t4-reference');
  return {
    issues,
    months,
    selfEmploymentMonths: input.dateOfDeath === null ? months.length : 12,
    hasEmployment,
  };
}
/** Literal Schedule8 worksheet arithmetic. No line rounding or full-return readiness is inferred. */
export function calculateCanadaCpp2025(raw: unknown) {
  const parsed = FinanceCanadaCpp2025InputSchema.safeParse(raw);
  if (!parsed.success)
    return deepFreeze({
      status: 'blocked' as const,
      complete: false as const,
      issues: ['missing-or-invalid-cpp-input'],
      source: CANADA_CPP_2025_SOURCE,
    });
  const input = parsed.data,
    e = eligibility(input);
  if (e.issues.length)
    return deepFreeze({
      status: 'blocked' as const,
      complete: false as const,
      issues: e.issues,
      source: CANADA_CPP_2025_SOURCE,
    });
  const values = CPP_2025_PRORATION[e.months.length]!,
    B = q(values[0]),
    C = q(values[1]),
    D = q(values[2]),
    E =
      input.basicExemption.kind === 'cra-determined'
        ? q(input.basicExemption.amount)
        : q(values[3]);
  const lines: Record<string, R> = {};
  const L = (part: number, line: number, value: R) => {
    lines[`part${part}.line${line}`] = value;
    return value;
  };
  const t: Record<number, R> = {};
  const T = (n: number, v: R) => (t[n] = L(3, n, v));
  T(
    1,
    sum(...input.t4Slips.map((s) => min(q(s.box26 ?? s.box14), q('81200')))),
  );
  T(2, min(D, t[1]!));
  T(3, B);
  T(4, pos(sub(t[2]!, B)));
  T(5, pos(sub(t[2]!, t[4]!)));
  T(6, E);
  T(7, pos(sub(t[5]!, E)));
  T(8, sum(...input.t4Slips.map((s) => q(s.box16))));
  T(9, rate(t[8]!, '0.831933'));
  T(10, sub(t[8]!, t[9]!));
  T(11, rate(t[7]!, '0.0495'));
  T(12, rate(t[7]!, '0.01'));
  T(13, add(t[11]!, t[12]!));
  T(14, t[9]!);
  T(15, t[11]!);
  T(16, sub(t[9]!, t[11]!));
  T(17, t[10]!);
  T(18, t[12]!);
  T(19, sub(t[10]!, t[12]!));
  T(20, add(t[16]!, t[19]!));
  T(21, sum(...input.t4Slips.map((s) => q(s.box16A))));
  T(22, rate(t[4]!, '0.04'));
  T(23, sub(t[21]!, t[22]!));
  T(24, add(t[20]!, t[23]!));
  const output: Record<
    '30800' | '31000' | '22215' | '22200' | '42100' | '44800',
    R
  > = {
    '30800': zero,
    '31000': zero,
    '22215': zero,
    '22200': zero,
    '42100': zero,
    '44800': zero,
  };
  // Shared Part3b and Part5 employment allocation, printed conditional transfer
  // order: first-additional surplus -> base, second-additional -> base -> first.
  function employmentAllocation(part: 3 | 5) {
    const start = part === 3 ? 30 : 51;
    const A = (offset: number, v: R) => L(part, start + offset, v);
    const baseStart = A(0, t[16]!.n >= 0n ? t[11]! : t[9]!);
    A(1, pos(neg(t[16]!)));
    const toBase = A(
      2,
      t[16]!.n < 0n && t[19]!.n > 0n ? min(t[19]!, neg(t[16]!)) : zero,
    );
    const baseGap = A(3, sub(pos(neg(t[16]!)), toBase));
    const base1 = A(4, add(baseStart, toBase));
    const secondToBase = A(
      5,
      t[23]!.n > 0n && baseGap.n > 0n ? min(t[23]!, baseGap) : zero,
    );
    const base = A(6, add(base1, secondToBase));
    const firstStart = A(7, t[19]!.n >= 0n ? t[12]! : t[10]!);
    A(8, pos(neg(t[19]!)));
    const toFirst = A(
      9,
      t[19]!.n < 0n && t[16]!.n > 0n ? min(t[16]!, neg(t[19]!)) : zero,
    );
    const firstGap = A(10, sub(pos(neg(t[19]!)), toFirst));
    const first1 = A(11, add(firstStart, toFirst));
    const secondToFirst = A(
      12,
      t[23]!.n > 0n && firstGap.n > 0n
        ? min(firstGap, sub(t[23]!, secondToBase))
        : zero,
    );
    const first = A(13, add(first1, secondToFirst));
    const secondStart = A(14, t[23]!.n >= 0n ? t[22]! : t[21]!);
    A(15, pos(neg(t[23]!)));
    const toSecond = A(
      16,
      t[23]!.n < 0n && t[20]!.n > 0n ? min(t[20]!, neg(t[23]!)) : zero,
    );
    const second = A(17, add(secondStart, toSecond));
    output['30800'] = base;
    output['22215'] = A(18, add(first, second));
  }
  function employmentOnly() {
    if (t[24]!.n > 0n) {
      output['30800'] = L(3, 25, t[11]!);
      L(3, 26, t[12]!);
      L(3, 27, t[22]!);
      output['22215'] = L(3, 28, add(t[12]!, t[22]!));
      output['44800'] = L(3, 29, t[24]!);
    } else employmentAllocation(3);
  }
  const self = mul(
    q(input.annualNetSelfEmploymentEarnings),
    r(BigInt(e.selfEmploymentMonths), 12n),
  );
  const other =
    input.otherEarningsElection.kind === 'cpt20'
      ? q(input.otherEarningsElection.earningsNotOnT4)
      : zero;
  const electedT4 =
    input.otherEarningsElection.kind === 'cpt20'
      ? q(input.otherEarningsElection.earningsOnT4)
      : zero;
  let branch: 'employment-only' | 'self-employment-only' | 'mixed';
  if (!e.hasEmployment) {
    branch = 'self-employment-only';
    const p: Record<number, R> = {};
    const P = (n: number, v: R) => (p[n] = L(4, n, v));
    P(1, self);
    P(2, other);
    P(3, pos(add(self, other)));
    P(4, min(D, p[3]!));
    P(5, B);
    P(6, pos(sub(p[4]!, B)));
    P(7, pos(sub(p[4]!, p[6]!)));
    P(8, E);
    P(9, pos(sub(p[7]!, E)));
    P(10, rate(p[9]!, '0.099'));
    P(11, rate(p[9]!, '0.02'));
    P(12, rate(p[6]!, '0.08'));
    P(13, add(p[11]!, p[12]!));
    output['42100'] = P(14, add(p[10]!, p[13]!));
    output['31000'] = P(15, rate(p[10]!, '0.5'));
    P(16, p[13]!);
    output['22200'] = P(17, add(p[15]!, p[16]!));
  } else if (self.n === 0n && other.n === 0n && electedT4.n === 0n) {
    branch = 'employment-only';
    employmentOnly();
  } else {
    branch = 'mixed';
    const p: Record<number, R> = {};
    const P = (n: number, v: R) => (p[n] = L(5, n, v));
    P(1, self);
    P(2, other);
    P(3, electedT4);
    P(4, sum(self, other, electedT4));
    P(5, t[8]!);
    P(6, pos(t[20]!));
    P(7, sub(p[5]!, p[6]!));
    P(8, pos(neg(t[20]!)));
    P(9, t[20]!.n < 0n && t[23]!.n > 0n ? min(t[23]!, p[8]!) : zero);
    P(10, add(p[7]!, p[9]!));
    P(11, t[21]!);
    P(12, pos(t[23]!));
    P(13, sub(p[11]!, p[12]!));
    P(14, pos(neg(t[23]!)));
    P(15, t[20]!.n > 0n && t[23]!.n < 0n ? min(t[20]!, p[14]!) : zero);
    P(16, add(p[13]!, p[15]!));
    P(17, B);
    P(18, E);
    P(19, pos(sub(B, E)));
    P(20, rate(p[10]!, '16.80672'));
    P(21, pos(sub(p[19]!, p[20]!)));
    P(22, min(p[4]!, p[21]!));
    P(23, cmp(t[1]!, E) < 0n ? E : zero);
    P(24, cmp(t[1]!, E) < 0n ? t[1]! : zero);
    P(25, pos(sub(p[23]!, p[24]!)));
    P(26, cmp(t[1]!, E) < 0n ? p[4]! : zero);
    P(27, cmp(t[1]!, E) < 0n ? p[19]! : zero);
    P(28, pos(sub(p[26]!, p[27]!)));
    P(29, pos(sub(p[25]!, p[28]!)));
    P(30, pos(sub(p[22]!, p[29]!)));
    P(31, p[4]!);
    P(32, t[2]!);
    P(33, add(p[31]!, p[32]!));
    if (cmp(p[33]!, B) > 0n) {
      P(34, C);
      P(35, rate(p[16]!, '25'));
      P(36, sub(p[34]!, p[35]!));
      P(37, p[4]!);
      P(38, p[25]!);
      P(39, sub(p[37]!, p[38]!));
      P(40, p[30]!);
      P(41, sub(p[39]!, p[40]!));
      P(42, min(p[36]!, p[41]!));
    } else P(42, zero);
    if (p[30]!.n === 0n && p[42]!.n === 0n) {
      employmentOnly();
    } else {
      // A negative printed contribution base indicates an unsupported inconsistent
      // fact combination. Do not silently add a clamp not present on Schedule8.
      if (p[42]!.n < 0n)
        return deepFreeze({
          status: 'blocked' as const,
          complete: false as const,
          issues: ['negative-schedule8-second-additional-base'],
          source: CANADA_CPP_2025_SOURCE,
        });
      P(43, rate(p[30]!, '0.099'));
      P(44, rate(p[30]!, '0.02'));
      P(45, rate(p[42]!, '0.08'));
      P(46, add(p[44]!, p[45]!));
      P(47, add(p[43]!, p[46]!));
      P(48, rate(pos(t[24]!), '2'));
      P(49, sub(p[47]!, p[48]!));
      output['42100'] = pos(p[49]!);
      output['44800'] = P(50, rate(pos(neg(p[49]!)), '0.5'));
      employmentAllocation(5);
      output['31000'] = P(70, rate(p[43]!, '0.5'));
      P(71, rate(p[44]!, '0.5'));
      P(72, add(p[70]!, p[71]!));
      P(73, pos(t[24]!));
      P(74, sub(p[72]!, p[73]!));
      const amountA = min(p[72]!, p[73]!);
      P(75, rate(amountA, '0.831933'));
      P(76, p[75]!);
      P(77, sub(amountA, p[76]!));
      P(78, p[70]!);
      P(79, p[75]!);
      P(80, sub(p[78]!, p[79]!));
      P(81, p[71]!);
      P(82, p[77]!);
      P(83, sub(p[81]!, p[82]!));
      P(84, rate(p[45]!, '0.5'));
      P(85, p[84]!);
      P(86, pos(neg(p[74]!)));
      P(87, pos(sub(p[85]!, p[86]!)));
      output['22200'] = P(88, sum(p[80]!, p[81]!, p[83]!, p[84]!, p[87]!));
    }
  }
  return deepFreeze({
    status: 'calculated-rounding-review-required' as const,
    complete: false as const,
    currency: 'CAD' as const,
    branch,
    eligibleMonths: e.months,
    monthCount: e.months.length,
    selfEmploymentProration: {
      numerator: String(e.selfEmploymentMonths),
      denominator: '12',
    },
    publishedProration: {
      maximumPensionableEarnings: values[0],
      secondAdditionalBand: values[1],
      additionalMaximumPensionableEarnings: values[2],
      basicExemption: exact(E),
    },
    source: CANADA_CPP_2025_SOURCE,
    worksheet: Object.entries(lines).map(([locator, value]) => ({
      locator,
      ...exact(value),
    })),
    returnLines: Object.fromEntries(
      Object.entries(output).map(([line, value]) => [
        line,
        { ...exact(value), reportableAmount: null },
      ]),
    ),
    issues: ['annual-cpp-line-rounding-policy-not-established'],
    fullReturnReady: false as const,
  });
}

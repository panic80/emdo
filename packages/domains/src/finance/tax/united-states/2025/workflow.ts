import {
  US_FORM_REQUIRED_FACTS,
  validateUsFormFacts,
  buildUs2025FieldCoverage,
} from './form-fields.js';
import { US_PENALTY_REQUIRED_FACTS, parseUsPenaltyLedger } from './penalty.js';
import { z } from 'zod';
import {
  appendUs2025ReturnChain,
  US_RETURN_REQUIRED_FACTS,
  US_RETURN_LINE_INVENTORY,
} from './return-chain.js';
import { q, plus, minus, times, lt, type Q } from './exact.js';
import { createHash } from 'node:crypto';
import {
  deepFreeze,
  FinanceTaxIntakeSchema,
  FinanceTaxEvaluationSchema,
  type FinanceTaxIntake,
  type FinanceTaxEvaluation,
} from '@emdo/contracts';
import { US_2025_SOURCES } from './sources.js';
import { roundNonnegativeRatio, usdCents } from './rounding.js';

export const US_2025_VERSION = '2025.6-federal-working-papers';
export const US_2025_EXPENSE_LINES = [
  '8',
  '10',
  '11',
  '15',
  '17',
  '18',
  '20b',
  '21',
  '22',
  '23',
  '24a',
  '25',
] as const;
/** Each exclusion requires an explicit reviewed false fact. Absence is never zero. */
export const US_2025_EXCLUSIONS = [
  'dependants',
  'claimableAsDependant',
  'age65OrBlind',
  'otherIncome',
  'otherAdjustments',
  'multipleBusinesses',
  'inventory',
  'businessAssetsOrDepreciation',
  'vehicleExpenses',
  'homeOffice',
  'meals',
  'employeesOrBenefitPlans',
  'businessInterest',
  'otherBusinessExpenses',
  'farmOrPartnership',
  'statutoryEmployee',
  'churchOrClergy',
  'seExemption',
  'optionalSeMethod',
  'unreportedTipsOrForm8919',
  'railroadCompensation',
  'bankruptcy',
  'foreignOrTerritoryIncome',
  'specialBusinessRules',
  'businessCredits',
] as const;
export const US_2025_REQUIRED_FACTS = deepFreeze([
  { key: 'filingStatus', type: 'text', equals: 'single' },
  { key: 'residency', type: 'text', equals: 'full-year-domestic' },
  { key: 'accountingMethod', type: 'text', equals: 'cash' },
  { key: 'roundingElection', type: 'text', equals: 'whole-dollar' },
  { key: 'materialParticipation', type: 'boolean', equals: true },
  { key: 'expenseClassificationReviewed', type: 'boolean', equals: true },
  ...US_2025_EXCLUSIONS.map((key) => ({ key, type: 'boolean', equals: false })),
  ...[
    'w2.box1',
    'w2.box3',
    'w2.box5',
    'w2.box7',
    'business.receipts',
    'business.returns',
    ...US_2025_EXPENSE_LINES.map((line) => `business.expense.${line}`),
  ].map((key) => ({ key, type: 'decimal' })),
  ...US_RETURN_REQUIRED_FACTS,
  ...US_PENALTY_REQUIRED_FACTS,
  ...US_FORM_REQUIRED_FACTS,
]);
const lineInventory = {
  C: [
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    ...US_2025_EXPENSE_LINES,
    '28',
    '29',
    '30',
    '31',
  ],
  SE: [
    '2',
    '3',
    '4a',
    '4b',
    '4c',
    '5a',
    '5b',
    '6',
    '7',
    '8a',
    '8b',
    '8c',
    '8d',
    '9',
    '10',
    '11',
    '12',
    '13',
  ],
  S1: ['3', '10', '15', '26'],
  S2: ['4'],
  F1040: ['1a', '1z', '8', '9', '10', '11a', '11b'],
};
for (const [form, lines] of Object.entries(US_RETURN_LINE_INVENTORY)) {
  const inventory = lineInventory as Record<string, string[]>;
  inventory[form] = [...(inventory[form] ?? []), ...lines];
}
(lineInventory as Record<string, string[]>).F2210 = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10.a',
  '10.b',
  '10.c',
  '10.d',
  '17.a',
  '17.b',
  '17.c',
  '17.d',
  '19',
];
lineInventory.F1040.push('38');
const sourceByForm: Record<string, string> = {
  C: 'f1040sc',
  SE: 'f1040sse',
  S1: 'f1040s1',
  S2: 'f1040s2',
  F1040: 'f1040',
  F8995: 'f8995',
  F6251: 'f6251',
  F8959: 'f8959',
  EICB: 'i1040gi',
  F2210: 'f2210',
};
const sourceReferencesForForm = (form: string) => [
  `irs-2025-${sourceByForm[form]}`,
  'irs-2025-i1040gi',
  ...(form === 'SE' ? ['irs-2025-irm-se-threshold'] : []),
  ...(form === 'F2210' ? ['irs-2025-i2210'] : []),
  ...(form === 'F8995' ? ['irs-2025-i8995', 'irs-2025-qbi-correction'] : []),
];
export const US_2025_RULES = deepFreeze(
  Object.entries(lineInventory).flatMap(([form, lines]) =>
    lines.map((line) => ({
      id: `us2025.${form}.${line}`,
      referenceIds: [...new Set(sourceReferencesForForm(form))],
      locator: `${form} (2025), line ${line}; 1040 instructions Rounding Off to Whole Dollars`,
    })),
  ),
);
export const US_2025_CANDIDATE = deepFreeze({
  id: 'us-federal-2025-working-papers',
  version: US_2025_VERSION,
  enabled: false,
  registryEligible: false,
  complete: false,
  scope: {
    country: 'US',
    subdivision: 'US-FED',
    taxpayerType: 'sole-proprietor' as const,
    year: 2025,
    regime: 'income-tax-return',
    formVersion: '1040-2025',
  },
  coverage:
    'Federal working papers for one ordinary cash-method service sole proprietorship, a single full-year domestic filer and optional ordinary W-2 income. Zero or positive profit; no other income or adjustments.',
  references: US_2025_SOURCES,
  rules: US_2025_RULES,
  roundingPolicy: 'entered-return-lines-irs-irm-se-433-threshold-v5',
  nextScope: ['state-and-local-return-packages'],
  requiredFacts: US_2025_REQUIRED_FACTS,
  releaseBlockers: [
    'required-attachment-evidence-and-independent-field-review-not-complete',
    'qualified-business-income-8995-a-and-broader-business-cases-not-implemented',
    'broader-credit-deduction-and-tax-applicability-inventory-incomplete',
    '2210-annualized-waiver-actual-withholding-and-special-relief-cases-not-implemented',
    'independent-complete-return-validation-not-complete',
  ],
});
type Trace = {
  formId: string;
  line: string;
  exactNumerator: string;
  exactDenominator: string;
  reportedDollars: string;
  dependsOn: string[];
  sourceFactKeys: string[];
  referenceIds: string[];
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const hash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

/** Pure candidate adapter; persistence must authorize the private case before calling.
 * Generic intake validation preserves ledger snapshot lineage. No model-produced outputs accepted.
 */
export function evaluateUs2025WorkingPapers(input: FinanceTaxIntake) {
  const parsed = FinanceTaxIntakeSchema.safeParse(input);
  const issues: FinanceTaxEvaluation['issues'] = [];
  const forms: FinanceTaxEvaluation['forms'] = [];
  const trace: Trace[] = [];
  let penaltyProof: ReturnType<typeof appendUs2025ReturnChain> = undefined;
  const finish = (intake: FinanceTaxIntake | null) => {
    const evaluation = FinanceTaxEvaluationSchema.parse({ forms, issues });
    const fieldCoverage =
      intake && forms.length
        ? buildUs2025FieldCoverage(
            intake,
            evaluation,
            new Set(
              US_2025_RULES.map((rule) => rule.id.replace('us2025.', '')),
            ),
            trace,
          )
        : null;
    return deepFreeze({
      candidate: US_2025_CANDIDATE,
      complete: false as const,
      status: forms.length
        ? ('incomplete-working-papers' as const)
        : ('blocked-input' as const),
      binding: intake
        ? {
            caseId: intake.caseId,
            taxSubjectId: intake.taxSubjectId,
            workspaceId: intake.workspaceId,
            snapshotRevision: intake.revision,
            inputHash: hash(intake),
            sourceFacts: intake.facts.map((fact) => ({
              key: fact.key,
              source: fact.source,
            })),
          }
        : null,
      evaluation,
      trace,
      penaltyProof: penaltyProof?.penalty ?? null,
      fieldCoverage,
      outputHash: hash({
        evaluation,
        trace,
        penaltyProof: penaltyProof?.penalty ?? null,
        fieldCoverage,
      }),
      definitionHash: hash(US_2025_CANDIDATE),
    });
  };
  const issue = (code: string, message: string) =>
    issues.push({ code, message });
  if (!parsed.success) {
    issue('invalid-intake', 'Generic tax intake or source lineage is invalid.');
    return finish(null);
  }
  const intake = parsed.data;
  const scope = US_2025_CANDIDATE.scope;
  if (
    Object.entries(scope).some(
      ([key, value]) => intake.scope[key as keyof typeof scope] !== value,
    ) ||
    intake.domesticResident !== true ||
    intake.hasCrossBorderActivity !== false ||
    intake.requestedFeatures.length !== 1 ||
    intake.requestedFeatures[0] !== 'income-tax-return'
  )
    issue(
      'unsupported-scope',
      'Requires the exact federal 2025 sole-proprietor scope, domestic residence and income-tax-return only.',
    );
  const facts = new Map(intake.facts.map((fact) => [fact.key, fact]));
  const amounts = new Map<string, bigint>();
  for (const required of US_2025_REQUIRED_FACTS) {
    const fact = facts.get(required.key);
    if (
      !fact ||
      fact.reviewState !== 'reviewed' ||
      fact.value.type !== required.type
    ) {
      issue(
        'missing-reviewed-fact',
        `Reviewed ${required.type} fact required: ${required.key}`,
      );
      continue;
    }
    if ('equals' in required && fact.value.value !== required.equals)
      issue('unsupported-fact', `Unsupported value for ${required.key}`);
    if (fact.value.type === 'decimal') {
      try {
        amounts.set(required.key, usdCents(fact.value.value));
      } catch {
        issue(
          'invalid-money',
          `Nonnegative USD cents required: ${required.key}`,
        );
      }
    }
  }
  for (const key of ['penalty.priorYearTaxFor2210', 'penalty.priorYearAgi'])
    if (amounts.has(key) && amounts.get(key)! % 100n !== 0n)
      issue(
        'prior-year-reported-amount-required',
        `${key} must be the reported whole-dollar amount from the prior return, not an unrounded workpaper amount.`,
      );
  // Prevent additional reviewed declarations from being silently excluded from the calculation.
  const allowed = new Set(US_2025_REQUIRED_FACTS.map((fact) => fact.key));
  for (const fact of intake.facts)
    if (!allowed.has(fact.key))
      issue('unsupported-fact', `Unmapped fact: ${fact.key}`);
  const ageBand = facts.get('eic.ageBand')?.value.value;
  if (ageBand !== 'under25' && ageBand !== '25-to-64')
    issue(
      'unsupported-fact',
      'eic.ageBand must be under25 or 25-to-64; age65+ is unsupported.',
    );
  if (!issues.length) {
    try {
      const ledger = parseUsPenaltyLedger(
        String(facts.get('penalty.paymentLedger')!.value.value),
      );
      const total = ledger
        .filter((payment) => payment.kind === 'estimated')
        .reduce((sum, payment) => sum + usdCents(payment.amount), 0n);
      if (total !== amounts.get('payments.estimatedAndPriorYearApplied'))
        issue(
          'invalid-payment-ledger',
          'Dated estimated payments must reconcile exactly with Form1040 line26 inputs.',
        );
      const filed = String(facts.get('penalty.returnFiledOn')!.value.value);
      if (
        filed !== 'not-filed' &&
        (!z.iso.date().safeParse(filed).success || filed < '2026-01-01')
      )
        issue(
          'invalid-filing-date',
          'Use an explicit actual filing date in2026 or later, or not-filed.',
        );
    } catch {
      issue(
        'invalid-payment-ledger',
        'Payment ledger requires bounded valid dated USD entries.',
      );
    }
  }
  if (!issues.length) issues.push(...validateUsFormFacts(intake));
  if (issues.length) return finish(intake);
  const cents = (key: string) => amounts.get(key)!;
  const rawProfit =
    cents('business.receipts') -
    cents('business.returns') -
    US_2025_EXPENSE_LINES.reduce(
      (sum, line) => sum + cents(`business.expense.${line}`),
      0n,
    );
  if (rawProfit < 0n) {
    issue(
      'unsupported-loss',
      'Loss limitation, at-risk and carryforward rules are not implemented.',
    );
    return finish(intake);
  }
  const values = new Map<string, Q>();
  const origins = new Map<string, string[]>();
  const add = (
    formId: string,
    line: string,
    numerator: bigint,
    denominator = 1n,
    dependsOn: string[] = [],
    directFacts: string[] = [],
  ) => {
    const reported =
      roundNonnegativeRatio(
        numerator < 0n ? -numerator : numerator,
        denominator,
      ) * (numerator < 0n ? -1n : 1n);
    const key = `${formId}.${line}`;
    const sourceFactKeys = [
      ...new Set([
        ...directFacts,
        ...dependsOn.flatMap((dep) => origins.get(dep) ?? []),
      ]),
    ].sort();
    const referenceIds = [...new Set(sourceReferencesForForm(formId))];
    // Published whole-dollar election: downstream form references consume the
    // entered line. Exact pre-entry arithmetic remains in the trace below.
    values.set(key, q(reported));
    origins.set(key, sourceFactKeys);
    let form = forms.find((item) => item.id === formId);
    if (!form) {
      form = { id: formId, version: '2025', fields: [] };
      forms.push(form);
    }
    form.fields.push({
      key: line,
      value: { type: 'decimal', value: reported.toString() },
      ruleIds: [`us2025.${key}`],
      sourceFactKeys,
    });
    trace.push({
      formId,
      line,
      exactNumerator: numerator.toString(),
      exactDenominator: denominator.toString(),
      reportedDollars: reported.toString(),
      dependsOn,
      sourceFactKeys,
      referenceIds,
    });
    return q(reported);
  };
  const fromFact = (form: string, line: string, key: string) =>
    add(form, line, cents(key), 100n, [], [key]);
  const put = (
    form: string,
    line: string,
    value: Q,
    deps: string[] = [],
    facts: string[] = [],
  ) => add(form, line, value.n, value.d, deps, facts);
  const copy = (form: string, line: string, dependency: string) =>
    put(form, line, values.get(dependency)!, [dependency]);
  const receipts = fromFact('C', '1', 'business.receipts');
  const returns = fromFact('C', '2', 'business.returns');
  put('C', '3', minus(receipts, returns), ['C.1', 'C.2']);
  add('C', '4', 0n, 1n, [], ['inventory']);
  copy('C', '5', 'C.3');
  add('C', '6', 0n, 1n, [], ['otherIncome']);
  copy('C', '7', 'C.5');
  for (const line of US_2025_EXPENSE_LINES)
    fromFact('C', line, `business.expense.${line}`);
  const expenses = US_2025_EXPENSE_LINES.reduce(
    (sum, line) => plus(sum, values.get(`C.${line}`)!),
    q(0n),
  );
  put(
    'C',
    '28',
    expenses,
    US_2025_EXPENSE_LINES.map((line) => `C.${line}`),
  );
  put('C', '29', minus(minus(receipts, returns), expenses), ['C.7', 'C.28']);
  add('C', '30', 0n, 1n, [], ['homeOffice']);
  const profit = copy('C', '31', 'C.29');
  copy('SE', '2', 'C.31');
  copy('SE', '3', 'SE.2');
  const exactNet = times(profit, 9235n, 10000n);
  const net = put('SE', '4a', exactNet, ['SE.3']);
  add('SE', '4b', 0n, 1n, [], ['optionalSeMethod']);
  copy('SE', '4c', 'SE.4a');
  // IRS IRM 3.14.1.6.12.1.3 (01-01-2026) directs processing to round an
  // entered SE-income value from $433.00 through $433.99 up to $434 and
  // assess SE tax. Keep the exact 92.35% arithmetic and entered line values
  // in the trace; `net` is the authoritative whole-dollar dependency for the
  // downstream form graph. With the current whole-dollar input policy, this
  // explicit IRS exception is the only case where exactNet is below $400
  // while the entered Schedule SE line is $400.
  const enteredSeIncome = values.get('SE.3')!;
  const irs433ThresholdException =
    lt(exactNet, q(400n)) &&
    !lt(enteredSeIncome, q(433n)) &&
    lt(enteredSeIncome, q(434n));
  const liable =
    !lt(net, q(400n)) && (!lt(exactNet, q(400n)) || irs433ThresholdException);
  if (liable) {
    add('SE', '5a', 0n, 1n, [], ['churchOrClergy']);
    add('SE', '5b', 0n, 1n, ['SE.5a']);
    copy('SE', '6', 'SE.4c');
    add('SE', '7', 176100n);
    const wages = add(
      'SE',
      '8a',
      cents('w2.box3') + cents('w2.box7'),
      100n,
      [],
      ['w2.box3', 'w2.box7'],
    );
    let socialTax = q(0n);
    const belowCeiling = lt(wages, q(176100n));
    if (belowCeiling) {
      add('SE', '8b', 0n, 1n, [], ['unreportedTipsOrForm8919']);
      add('SE', '8c', 0n, 1n, [], ['unreportedTipsOrForm8919']);
      copy('SE', '8d', 'SE.8a');
      const room = put('SE', '9', minus(q(176100n), wages), ['SE.7', 'SE.8d']);
      socialTax = put(
        'SE',
        '10',
        times(lt(net, room) ? net : room, 124n, 1000n),
        ['SE.6', 'SE.9'],
      );
    }
    const medicare = put('SE', '11', times(net, 29n, 1000n), ['SE.6']);
    const tax = put(
      'SE',
      '12',
      plus(socialTax, medicare),
      belowCeiling ? ['SE.10', 'SE.11'] : ['SE.11', 'SE.8a'],
    );
    put('SE', '13', times(tax, 1n, 2n), ['SE.12']);
  }
  copy('S1', '3', 'C.31');
  copy('S1', '10', 'S1.3');
  if (liable) copy('S1', '15', 'SE.13');
  else add('S1', '15', 0n, 1n, ['SE.4c']);
  copy('S1', '26', 'S1.15');
  if (liable) copy('S2', '4', 'SE.12');
  else add('S2', '4', 0n, 1n, ['SE.4c']);
  const wages = fromFact('F1040', '1a', 'w2.box1');
  copy('F1040', '1z', 'F1040.1a');
  copy('F1040', '8', 'S1.10');
  const total = put('F1040', '9', plus(wages, profit), ['F1040.1z', 'F1040.8']);
  const adjustment = copy('F1040', '10', 'S1.26');
  put('F1040', '11a', minus(total, adjustment), ['F1040.9', 'F1040.10']);
  copy('F1040', '11b', 'F1040.11a');
  penaltyProof = appendUs2025ReturnChain({
    get: (key) => {
      const value = values.get(key);
      if (!value) throw new Error(`Missing graph dependency ${key}`);
      return value;
    },
    put,
    copy,
    money: (key) => q(cents(key), 100n),
    fact: (key) => facts.get(key)!.value.value,
    issue,
  });
  for (const blocker of US_2025_CANDIDATE.releaseBlockers)
    issue(blocker, blocker.replaceAll('-', ' '));
  return finish(intake);
}

import { createHash } from 'node:crypto';
import {
  deepFreeze,
  FinanceTaxEvaluationSchema,
  FinanceTaxIntakeSchema,
  type FinanceTaxEvaluation,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import {
  compare,
  decimal,
  divide,
  floorCents,
  floorEuros,
  floorToEurosUnit,
  formatEuros,
  lte,
  minimum,
  minus,
  plus,
  positive,
  q,
  times,
  type Exact,
} from './exact.js';
import { SourceBoundLineGraph } from './source-bound-line-graph.js';
import { buildGermany2025FieldCoverage } from './form-fields.js';
import {
  GERMANY_2025_AUTHORITY_SOURCES,
  GERMANY_2025_SOURCES,
} from './sources.js';

export { GERMANY_2025_AUTHORITY_SOURCES, GERMANY_2025_SOURCES };

export const GERMANY_2025_VERSION = '2025.1-federal-working-papers';

type ValueType = 'decimal' | 'text' | 'boolean' | 'date';
type RequiredFact = {
  key: string;
  type: ValueType;
  equals?: string | boolean;
};

const requiredText: RequiredFact[] = [
  { key: 'filingStatus', type: 'text', equals: 'single' },
  { key: 'residency', type: 'text', equals: 'full-year-domestic' },
  { key: 'assessmentMethod', type: 'text', equals: 'individual' },
  { key: 'accountingMethod', type: 'text', equals: 'cash' },
  { key: 'roundingPolicy', type: 'text', equals: 'statutory-2025' },
  // The value is deliberately open here and checked against the two supported
  // §15/§18 branches below. Missing or any third value blocks the run.
  { key: 'business.kind', type: 'text' },
];

const requiredBoolean: RequiredFact[] = [
  {
    key: 'employment.expenseClassificationReviewed',
    type: 'boolean',
    equals: true,
  },
  { key: 'employment.multipleEmployers', type: 'boolean', equals: false },
  { key: 'employment.specialWages', type: 'boolean', equals: false },
  { key: 'employment.foreignIncome', type: 'boolean', equals: false },
  { key: 'employment.incomeReplacement', type: 'boolean', equals: false },
  { key: 'employment.doubleHousehold', type: 'boolean', equals: false },
  { key: 'employment.otherWorkExpenses', type: 'boolean', equals: false },
  { key: 'business.lossesAndCarryforwards', type: 'boolean', equals: false },
  { key: 'business.multipleBusinesses', type: 'boolean', equals: false },
  { key: 'business.inventory', type: 'boolean', equals: false },
  { key: 'business.assetsOrDepreciation', type: 'boolean', equals: false },
  { key: 'business.partnership', type: 'boolean', equals: false },
  { key: 'business.foreignActivity', type: 'boolean', equals: false },
  { key: 'business.tradeTaxAdjustments', type: 'boolean', equals: false },
  { key: 'business.otherExpensesNone', type: 'boolean', equals: true },
  { key: 'business.vatAndOtherTaxes', type: 'boolean', equals: false },
  {
    key: 'insurance.pensionClassificationReviewed',
    type: 'boolean',
    equals: true,
  },
  { key: 'insurance.privateOrOther', type: 'boolean', equals: false },
  {
    key: 'insurance.refundClassificationReviewed',
    type: 'boolean',
    equals: true,
  },
  { key: 'specialExpenses.other', type: 'boolean', equals: false },
  { key: 'churchTax.member', type: 'boolean', equals: false },
  { key: 'other.income', type: 'boolean', equals: false },
  { key: 'other.deductions', type: 'boolean', equals: false },
  { key: 'other.credits', type: 'boolean', equals: false },
  { key: 'other.taxes', type: 'boolean', equals: false },
  { key: 'other.formCases', type: 'boolean', equals: false },
];

const businessExpenseLines = [
  'advertising',
  'professionalFees',
  'rent',
  'utilities',
  'insurance',
  'office',
  'travel',
  'supplies',
  'other',
] as const;

const requiredDecimals: RequiredFact[] = [
  'employment.grossWages',
  'employment.workExpensesActual',
  'employment.incomeTaxWithheld',
  'employment.soliWithheld',
  'employment.churchTaxWithheld',
  'business.grossReceipts',
  ...businessExpenseLines.map((line) => `business.expense.${line}`),
  'business.municipalityHebesatz',
  'insurance.pensionEmployee',
  'insurance.pensionAdditional',
  'insurance.healthWithSickPay',
  'insurance.healthWithoutSickPay',
  'insurance.longTermCare',
  'insurance.healthRefunds',
  'insurance.careRefunds',
  'insurance.otherVorsorge',
  'specialExpenses.otherAmount',
  'payments.incomeTaxAdvances',
  'payments.soliAdvances',
].map((key) => ({ key, type: 'decimal' }));

/** Every amount and every excluded branch is an explicit reviewed input. */
export const GERMANY_2025_REQUIRED_FACTS = deepFreeze([
  ...requiredText,
  ...requiredBoolean,
  ...requiredDecimals,
]);

const formReferences: Record<string, readonly string[]> = {
  ESt1A: [
    'de-estg-2025',
    'de-solzg-2025',
    'de-bmf-32a-2025',
    'de-bmf-35-2025',
    'de-elster-forms-2025',
    'de-est1a-2025',
  ],
  AnlageN: ['de-bmf-9a-2025', 'de-elster-forms-2025', 'de-est1a-2025'],
  AnlageS: ['de-estg-2025', 'de-elster-forms-2025'],
  AnlageG: [
    'de-estg-2025',
    'de-gewstg-2025',
    'de-bmf-35-2025',
    'de-elster-forms-2025',
  ],
  Vorsorgeaufwand: ['de-estg-2025', 'de-bmf-vorsorge-2025', 'de-est1a-2025'],
};

type FormFieldDefinition = {
  key: string;
  type: ValueType;
  ruleIds: readonly string[];
};

type FormDefinition = {
  id: string;
  version: string;
  referenceIds: readonly string[];
  fields: readonly FormFieldDefinition[];
};

const form = (id: string, fields: readonly string[]): FormDefinition => ({
  id,
  version: '2025',
  referenceIds: formReferences[id]!,
  fields: fields.map((key) => ({
    key,
    type: 'decimal',
    ruleIds: [`de2025.${id}.${key}`],
  })),
});

/** Semantic paper-line inventory. Full ELSTER line applicability remains a release gate. */
export const GERMANY_2025_FORM_DEFINITIONS = deepFreeze([
  form('AnlageN', ['grossWages', 'workExpenses', 'employmentIncome']),
  form('AnlageS', ['grossReceipts', 'deductibleExpenses', 'profit']),
  form('AnlageG', [
    'grossReceipts',
    'deductibleExpenses',
    'profit',
    'gewerbeertrag',
    'tradeTaxMeasure',
    'tradeTax',
    'incomeTaxReduction35',
  ]),
  form('Vorsorgeaufwand', [
    'pensionContributions',
    'pensionEligible',
    'healthContributions',
    'careContributions',
    'insuranceRefunds',
    'eligibleVorsorge',
    'specialExpensesAllowance',
  ]),
  form('ESt1A', [
    'incomeFromEmployment',
    'incomeFromBusiness',
    'totalIncome',
    'specialDeductions',
    'taxableIncome',
    'incomeTax',
    'solidaritySurcharge',
    'incomeTaxWithheld',
    'soliWithheld',
    'incomeTaxAdvances',
    'soliAdvances',
    'balanceDue',
    'refund',
  ]),
]);

export const GERMANY_2025_RULES = deepFreeze(
  GERMANY_2025_FORM_DEFINITIONS.flatMap((definition) =>
    definition.fields.map((field) => ({
      id: field.ruleIds[0]!,
      referenceIds: [...definition.referenceIds],
    })),
  ),
);

export const GERMANY_2025_CANDIDATE = deepFreeze({
  id: 'de-federal-2025-domestic-single-working-papers',
  version: GERMANY_2025_VERSION,
  enabled: false,
  registryEligible: false,
  complete: false,
  scope: {
    country: 'DE',
    subdivision: 'DE-FED',
    taxpayerType: 'individual' as const,
    year: 2025,
    regime: 'income-tax-return',
    formVersion: 'ESt1A-2025',
  },
  coverage:
    'Federal working papers for one full-year domestic-resident single individual with ordinary employment and one cash-method sole-proprietor activity. The activity is explicitly classified as a §18 free profession or §15 trade. Positive income only; no church tax, losses, other income, special cases or state returns.',
  forms: GERMANY_2025_FORM_DEFINITIONS,
  references: GERMANY_2025_SOURCES,
  rules: GERMANY_2025_RULES,
  requiredFacts: GERMANY_2025_REQUIRED_FACTS,
  roundingPolicy:
    'exact-rational-eur-inputs; §32a taxable income and trade-tax measure use statutory whole-euro floors; Soli and settlement amounts omit fractional cents',
  releaseBlockers: [
    'full-form-line-inventory-and-conditional-fields-incomplete',
    'all-german-state-subdivisions-and-state-tax-coverage-not-implemented',
    'joint-assessment-spouse-and-child-benefits-not-implemented',
    'church-tax-and-religion-specific-handling-not-implemented',
    'other-income-capital-rental-pension-foreign-and-progression-cases-not-implemented',
    'losses-carryforwards-and-special-business-adjustments-not-implemented',
    'vat-ewr-and-eur-formalities-not-implemented',
    'standalone-corporation-kst-gewerbesteuer-return-not-implemented',
    'electronic-filing-payroll-and-withholding-pap-not-implemented',
    'independent-complete-return-validation-not-complete',
  ],
});

export const GERMANY_2025_CONSTANTS = deepFreeze({
  basicAllowance: 12096n,
  tariffZone1End: 17443n,
  tariffZone2End: 68480n,
  tariffZone3End: 277825n,
  employeeAllowance: 1230n,
  specialExpensesAllowance: 36n,
  pensionContributionCap: 29344n,
  tradeAllowance: 24500n,
  tradeMeasureRate: q(35n, 1000n),
  minimumHebesatz: 280n,
  singleSoliThreshold: 19950n,
  soliRate: q(55n, 1000n),
  soliCapRate: q(119n, 1000n),
});

const zero = q(0n);

/** 2025 §32a EStG tariff for an individual assessment, before §35 credit. */
export function incomeTax2025(taxableIncome: Exact | bigint): Exact {
  const x =
    typeof taxableIncome === 'bigint' ? q(taxableIncome) : taxableIncome;
  if (x.n < 0n || x.d !== 1n)
    throw new Error('Tariff requires nonnegative whole EUR x');
  const value = x.n;
  let tax: Exact;
  if (value <= GERMANY_2025_CONSTANTS.basicAllowance) return zero;
  if (value <= GERMANY_2025_CONSTANTS.tariffZone1End) {
    const y = q(value - GERMANY_2025_CONSTANTS.basicAllowance, 10000n);
    tax = times(plus(times(y, q(93230n, 100n)), q(1400n)), y);
  } else if (value <= GERMANY_2025_CONSTANTS.tariffZone2End) {
    const z = q(value - GERMANY_2025_CONSTANTS.tariffZone1End, 10000n);
    tax = plus(
      times(plus(times(z, q(17664n, 100n)), q(2397n)), z),
      q(101513n, 100n),
    );
  } else if (value <= GERMANY_2025_CONSTANTS.tariffZone3End) {
    tax = minus(times(x, q(42n, 100n)), q(1091192n, 100n));
  } else {
    tax = minus(times(x, q(45n, 100n)), q(1924667n, 100n));
  }
  return floorEuros(positive(tax));
}

/** 2025 Solidarity surcharge for a single individual after §35 credit. */
export function solidaritySurcharge2025(incomeTaxAfterCredit: Exact): Exact {
  const base = floorEuros(positive(incomeTaxAfterCredit));
  if (lte(base, q(GERMANY_2025_CONSTANTS.singleSoliThreshold))) return zero;
  const percentage = times(base, GERMANY_2025_CONSTANTS.soliRate);
  const cap = times(
    minus(base, q(GERMANY_2025_CONSTANTS.singleSoliThreshold)),
    GERMANY_2025_CONSTANTS.soliCapRate,
  );
  return floorCents(minimum(percentage, cap));
}

const canonical = (value: unknown): string => {
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

const hash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

type GermanyTrace = {
  formId: string;
  line: string;
  exactNumerator: string;
  exactDenominator: string;
  reportedEuros: string;
  dependsOn: readonly string[];
  sourceFactKeys: readonly string[];
  referenceIds: readonly string[];
};

function evaluationForms(
  graph: SourceBoundLineGraph,
): FinanceTaxEvaluation['forms'] {
  const forms: FinanceTaxEvaluation['forms'] = [];
  for (const line of graph.lines()) {
    let current = forms.find((item) => item.id === line.formId);
    if (!current) {
      current = { id: line.formId, version: '2025', fields: [] };
      forms.push(current);
    }
    current.fields.push({
      key: line.line,
      value: { type: 'decimal', value: formatEuros(line.value) },
      ruleIds: [`de2025.${line.formId}.${line.line}`],
      sourceFactKeys: [...line.sourceFactKeys],
    });
  }
  return forms;
}

/**
 * Pure candidate adapter. It calculates the bounded annual chain but always
 * returns incomplete working papers until the candidate's release blockers
 * are independently cleared. Filing, payroll, persistence and activation are
 * intentionally outside this module.
 */
export function evaluateGermany2025WorkingPapers(input: FinanceTaxIntake) {
  const parsed = FinanceTaxIntakeSchema.safeParse(input);
  const issues: FinanceTaxEvaluation['issues'] = [];
  const graph = new SourceBoundLineGraph();

  const finish = (intake: FinanceTaxIntake | null) => {
    const evaluation = FinanceTaxEvaluationSchema.parse({
      forms: evaluationForms(graph),
      issues,
    });
    const trace: GermanyTrace[] = graph.lines().map((line) => ({
      formId: line.formId,
      line: line.line,
      exactNumerator: line.value.n.toString(),
      exactDenominator: line.value.d.toString(),
      reportedEuros: formatEuros(line.value),
      dependsOn: line.dependsOn,
      sourceFactKeys: line.sourceFactKeys,
      referenceIds: line.referenceIds,
    }));
    const fieldCoverage = intake
      ? buildGermany2025FieldCoverage(intake, evaluation, trace)
      : null;
    return deepFreeze({
      candidate: GERMANY_2025_CANDIDATE,
      complete: false as const,
      status: evaluation.forms.length
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
      fieldCoverage,
      outputHash: hash({ evaluation, trace, fieldCoverage }),
      definitionHash: hash(GERMANY_2025_CANDIDATE),
    });
  };

  const issue = (code: string, message: string) =>
    issues.push({ code, message });
  if (!parsed.success) {
    issue('invalid-intake', 'Generic tax intake or source lineage is invalid.');
    return finish(null);
  }
  const intake = parsed.data;
  const scope = GERMANY_2025_CANDIDATE.scope;
  if (
    Object.entries(scope).some(
      ([key, value]) => intake.scope[key as keyof typeof scope] !== value,
    ) ||
    intake.domesticResident !== true ||
    intake.hasCrossBorderActivity !== false ||
    intake.standaloneCorporation === true ||
    intake.requestedFeatures.length !== 1 ||
    intake.requestedFeatures[0] !== 'income-tax-return'
  )
    issue(
      'unsupported-scope',
      'Requires exact DE-FED 2025 ESt1A individual scope, full-year domestic residence and income-tax-return only.',
    );

  const facts = new Map(intake.facts.map((fact) => [fact.key, fact]));
  const amounts = new Map<string, Exact>();
  const required = GERMANY_2025_REQUIRED_FACTS as readonly RequiredFact[];
  for (const definition of required) {
    const fact = facts.get(definition.key);
    if (
      !fact ||
      fact.reviewState !== 'reviewed' ||
      fact.value.type !== definition.type
    ) {
      issue(
        'missing-reviewed-fact',
        `Reviewed ${definition.type} fact required: ${definition.key}`,
      );
      continue;
    }
    if ('equals' in definition && fact.value.value !== definition.equals)
      issue('unsupported-fact', `Unsupported value for ${definition.key}`);
    if (definition.type === 'decimal' && fact.value.type === 'decimal') {
      try {
        const value = decimal(fact.value.value);
        const fraction = fact.value.value.split('.')[1] ?? '';
        if (fraction.length > 2) throw new Error('fractional-cent');
        if (value.n < 0n) throw new Error('negative');
        amounts.set(definition.key, value);
      } catch {
        issue(
          'invalid-money',
          `Nonnegative EUR amount with at most two decimal places required: ${definition.key}`,
        );
      }
    }
  }
  const allowed = new Set(required.map((definition) => definition.key));
  for (const fact of intake.facts)
    if (!allowed.has(fact.key))
      issue('unsupported-fact', `Unmapped fact: ${fact.key}`);

  const businessKind = facts.get('business.kind')?.value.value;
  if (businessKind !== 'professional' && businessKind !== 'trade')
    issue(
      'unsupported-fact',
      'business.kind must be professional (§18 EStG) or trade (§15 EStG).',
    );
  if (
    intake.standaloneCorporation === false &&
    intake.scope.taxpayerType === 'corporation'
  )
    issue(
      'unsupported-scope',
      'Corporation returns are outside this individual candidate.',
    );

  if (!issues.length) {
    const money = (key: string) => amounts.get(key)!;
    const zeroAmount = q(0n);
    for (const key of [
      'employment.churchTaxWithheld',
      'business.expense.other',
      'insurance.pensionAdditional',
      'insurance.otherVorsorge',
      'specialExpenses.otherAmount',
    ])
      if (compare(money(key), zeroAmount) !== 0n)
        issue(
          'unsupported-fact',
          `${key} must be an explicit reviewed zero in this bounded case.`,
        );
    if (
      businessKind === 'professional' &&
      compare(money('business.municipalityHebesatz'), zeroAmount) !== 0n
    )
      issue(
        'unsupported-fact',
        'Professional income must carry an explicit zero municipality Hebesatz.',
      );
    if (
      businessKind === 'trade' &&
      compare(
        money('business.municipalityHebesatz'),
        q(GERMANY_2025_CONSTANTS.minimumHebesatz),
      ) < 0n
    )
      issue(
        'invalid-municipality-rate',
        'Trade activity requires a reviewed municipal Hebesatz of at least 280%.',
      );
    const healthBase = plus(
      money('insurance.healthWithSickPay'),
      money('insurance.healthWithoutSickPay'),
    );
    const careBase = money('insurance.longTermCare');
    if (
      compare(
        plus(money('insurance.healthRefunds'), money('insurance.careRefunds')),
        plus(healthBase, careBase),
      ) > 0n
    )
      issue(
        'invalid-insurance-refund',
        'Insurance refunds cannot exceed the reviewed health and care contributions.',
      );
  }
  if (issues.length) return finish(intake);

  const amount = (key: string) => amounts.get(key)!;
  const add = (
    formId: string,
    line: string,
    value: Exact,
    dependsOn: readonly string[] = [],
    directFacts: readonly string[] = [],
  ) =>
    graph.add(
      formId,
      line,
      value,
      dependsOn,
      directFacts,
      formReferences[formId] ?? [],
    );
  const fromFact = (formId: string, line: string, key: string) =>
    add(formId, line, amount(key), [], [key]);
  const put = (
    formId: string,
    line: string,
    value: Exact,
    dependencies: readonly string[] = [],
    directFacts: readonly string[] = [],
  ) => add(formId, line, value, dependencies, directFacts);

  const wagesAmount = amount('employment.grossWages');
  const actualWorkExpenses = amount('employment.workExpensesActual');
  const useActualWorkExpenses = lte(
    q(GERMANY_2025_CONSTANTS.employeeAllowance),
    actualWorkExpenses,
  );
  const selectedWorkExpenses = useActualWorkExpenses
    ? actualWorkExpenses
    : q(GERMANY_2025_CONSTANTS.employeeAllowance);
  const businessReceiptsAmount = amount('business.grossReceipts');
  const businessExpensesAmount = businessExpenseLines
    .map((line) => amount(`business.expense.${line}`))
    .reduce((sum, value) => plus(sum, value), zero);
  if (compare(wagesAmount, selectedWorkExpenses) < 0n)
    issue(
      'unsupported-negative-employment-income',
      'Employee expenses exceeding wages are outside this positive-income case.',
    );
  if (compare(businessReceiptsAmount, businessExpensesAmount) < 0n)
    issue(
      'unsupported-loss',
      'Business loss, loss limitation and carryforward rules are not implemented.',
    );
  const eligiblePensionAmount = minimum(
    amount('insurance.pensionEmployee'),
    q(GERMANY_2025_CONSTANTS.pensionContributionCap),
  );
  const eligibleHealthAmount = plus(
    amount('insurance.healthWithoutSickPay'),
    times(amount('insurance.healthWithSickPay'), q(96n, 100n)),
  );
  const eligibleInsuranceAmount = minus(
    plus(
      eligiblePensionAmount,
      eligibleHealthAmount,
      amount('insurance.longTermCare'),
    ),
    plus(amount('insurance.healthRefunds'), amount('insurance.careRefunds')),
  );
  const taxableBeforeFloor = minus(
    plus(
      minus(wagesAmount, selectedWorkExpenses),
      minus(businessReceiptsAmount, businessExpensesAmount),
    ),
    plus(
      eligibleInsuranceAmount,
      q(GERMANY_2025_CONSTANTS.specialExpensesAllowance),
    ),
  );
  if (taxableBeforeFloor.n < 0n)
    issue(
      'unsupported-negative-taxable-income',
      'Negative taxable income and loss carryforward rules are outside this bounded case.',
    );
  if (issues.length) return finish(intake);

  const wages = fromFact('AnlageN', 'grossWages', 'employment.grossWages');
  const workExpenses = add(
    'AnlageN',
    'workExpenses',
    selectedWorkExpenses,
    [],
    [
      'employment.workExpensesActual',
      'employment.expenseClassificationReviewed',
    ],
  );
  const employmentIncome = put(
    'AnlageN',
    'employmentIncome',
    minus(wages, workExpenses),
    ['AnlageN.grossWages', 'AnlageN.workExpenses'],
  );
  const businessForm = businessKind === 'trade' ? 'AnlageG' : 'AnlageS';
  const receipts = add(
    businessForm,
    'grossReceipts',
    amount('business.grossReceipts'),
    [],
    ['business.grossReceipts', 'business.kind'],
  );
  const expenseValues = businessExpenseLines.map((line) =>
    amount(`business.expense.${line}`),
  );
  const expenses = expenseValues.reduce((sum, value) => plus(sum, value), zero);
  put(
    businessForm,
    'deductibleExpenses',
    expenses,
    [],
    [
      'business.kind',
      ...businessExpenseLines.map((line) => `business.expense.${line}`),
    ],
  );
  const businessProfit = put(
    businessForm,
    'profit',
    minus(receipts, expenses),
    [`${businessForm}.grossReceipts`, `${businessForm}.deductibleExpenses`],
  );
  const pensionContributions = fromFact(
    'Vorsorgeaufwand',
    'pensionContributions',
    'insurance.pensionEmployee',
  );
  const pensionEligible = put(
    'Vorsorgeaufwand',
    'pensionEligible',
    minimum(
      pensionContributions,
      q(GERMANY_2025_CONSTANTS.pensionContributionCap),
    ),
    ['Vorsorgeaufwand.pensionContributions'],
    ['insurance.pensionClassificationReviewed'],
  );
  const healthWithSickPay = amount('insurance.healthWithSickPay');
  const healthWithoutSickPay = amount('insurance.healthWithoutSickPay');
  const healthContributions = put(
    'Vorsorgeaufwand',
    'healthContributions',
    plus(healthWithoutSickPay, times(healthWithSickPay, q(96n, 100n))),
    [],
    [
      'insurance.healthWithSickPay',
      'insurance.healthWithoutSickPay',
      'insurance.refundClassificationReviewed',
    ],
  );
  const careContributions = fromFact(
    'Vorsorgeaufwand',
    'careContributions',
    'insurance.longTermCare',
  );
  const healthRefunds = amount('insurance.healthRefunds');
  const careRefunds = amount('insurance.careRefunds');
  const insuranceRefunds = put(
    'Vorsorgeaufwand',
    'insuranceRefunds',
    plus(healthRefunds, careRefunds),
    [],
    ['insurance.healthRefunds', 'insurance.careRefunds'],
  );
  const eligibleVorsorge = put(
    'Vorsorgeaufwand',
    'eligibleVorsorge',
    minus(
      plus(pensionEligible, healthContributions, careContributions),
      insuranceRefunds,
    ),
    [
      'Vorsorgeaufwand.pensionEligible',
      'Vorsorgeaufwand.healthContributions',
      'Vorsorgeaufwand.careContributions',
      'Vorsorgeaufwand.insuranceRefunds',
    ],
  );
  const specialExpensesAllowance = add(
    'Vorsorgeaufwand',
    'specialExpensesAllowance',
    q(GERMANY_2025_CONSTANTS.specialExpensesAllowance),
    [],
    ['specialExpenses.otherAmount', 'specialExpenses.other'],
  );
  const specialDeductions = put(
    'ESt1A',
    'specialDeductions',
    plus(eligibleVorsorge, specialExpensesAllowance),
    [
      'Vorsorgeaufwand.eligibleVorsorge',
      'Vorsorgeaufwand.specialExpensesAllowance',
    ],
  );
  const totalIncome = put(
    'ESt1A',
    'totalIncome',
    plus(employmentIncome, businessProfit),
    ['AnlageN.employmentIncome', `${businessForm}.profit`],
  );
  const preRoundedTaxableIncome = minus(totalIncome, specialDeductions);
  if (preRoundedTaxableIncome.n < 0n) {
    issue(
      'unsupported-negative-taxable-income',
      'Negative taxable income and loss carryforward rules are outside this bounded case.',
    );
    return finish(intake);
  }
  const taxableIncome = put(
    'ESt1A',
    'taxableIncome',
    floorEuros(preRoundedTaxableIncome),
    ['ESt1A.totalIncome', 'ESt1A.specialDeductions'],
  );
  const tariffTax = incomeTax2025(taxableIncome);
  let incomeTaxReduction35 = zero;
  if (businessKind === 'trade') {
    // §11 GewStG: round the Gewerbeertrag down to full €100, apply the
    // €24,500 natural-person allowance, then the 3.5% measure rate. The
    // official trade-tax guidance requires the measure to be floored to EUR.
    const gewerbeertrag = put(
      'AnlageG',
      'gewerbeertrag',
      floorToEurosUnit(businessProfit, 100n),
      ['AnlageG.profit'],
    );
    const afterAllowance = positive(
      minus(gewerbeertrag, q(GERMANY_2025_CONSTANTS.tradeAllowance)),
    );
    const tradeTaxMeasure = put(
      'AnlageG',
      'tradeTaxMeasure',
      floorEuros(
        times(afterAllowance, GERMANY_2025_CONSTANTS.tradeMeasureRate),
      ),
      ['AnlageG.gewerbeertrag'],
    );
    put(
      'AnlageG',
      'tradeTax',
      floorCents(
        times(
          tradeTaxMeasure,
          divide(amount('business.municipalityHebesatz'), q(100n)),
        ),
      ),
      ['AnlageG.tradeTaxMeasure'],
      ['business.municipalityHebesatz'],
    );
    const share = divide(businessProfit, totalIncome);
    const allocatedTax = times(tariffTax, share);
    incomeTaxReduction35 = put(
      'AnlageG',
      'incomeTaxReduction35',
      minimum(times(tradeTaxMeasure, q(4n)), allocatedTax),
      ['AnlageG.tradeTaxMeasure', 'ESt1A.totalIncome', 'AnlageG.profit'],
    );
  }
  const incomeTaxAfterCredit = positive(minus(tariffTax, incomeTaxReduction35));
  const solidaritySurcharge = solidaritySurcharge2025(incomeTaxAfterCredit);
  put('ESt1A', 'incomeFromEmployment', employmentIncome, [
    'AnlageN.employmentIncome',
  ]);
  put('ESt1A', 'incomeFromBusiness', businessProfit, [
    `${businessForm}.profit`,
  ]);
  put('ESt1A', 'incomeTax', incomeTaxAfterCredit, [
    'ESt1A.taxableIncome',
    ...(businessKind === 'trade' ? ['AnlageG.incomeTaxReduction35'] : []),
  ]);
  put('ESt1A', 'solidaritySurcharge', solidaritySurcharge, ['ESt1A.incomeTax']);
  const incomeTaxWithheld = fromFact(
    'ESt1A',
    'incomeTaxWithheld',
    'employment.incomeTaxWithheld',
  );
  const soliWithheld = fromFact(
    'ESt1A',
    'soliWithheld',
    'employment.soliWithheld',
  );
  const incomeTaxAdvances = fromFact(
    'ESt1A',
    'incomeTaxAdvances',
    'payments.incomeTaxAdvances',
  );
  const soliAdvances = fromFact(
    'ESt1A',
    'soliAdvances',
    'payments.soliAdvances',
  );
  const settlement = minus(
    plus(incomeTaxAfterCredit, solidaritySurcharge),
    plus(incomeTaxWithheld, soliWithheld, incomeTaxAdvances, soliAdvances),
  );
  put('ESt1A', 'balanceDue', positive(settlement), [
    'ESt1A.incomeTax',
    'ESt1A.solidaritySurcharge',
    'ESt1A.incomeTaxWithheld',
    'ESt1A.soliWithheld',
    'ESt1A.incomeTaxAdvances',
    'ESt1A.soliAdvances',
  ]);
  put('ESt1A', 'refund', positive(minus(zero, settlement)), [
    'ESt1A.incomeTax',
    'ESt1A.solidaritySurcharge',
    'ESt1A.incomeTaxWithheld',
    'ESt1A.soliWithheld',
    'ESt1A.incomeTaxAdvances',
    'ESt1A.soliAdvances',
  ]);
  for (const blocker of GERMANY_2025_CANDIDATE.releaseBlockers)
    issue(blocker, blocker.replaceAll('-', ' '));
  return finish(intake);
}

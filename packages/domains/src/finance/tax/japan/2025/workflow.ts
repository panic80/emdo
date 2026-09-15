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
  floorThousandYen,
  format,
  isWholeYen,
  minus,
  plus,
  positive,
  q,
  serialize,
  type Q,
} from './exact.js';
import {
  basicDeduction2025,
  declaredAssessment2025,
  nationalIncomeTax2025,
  reconstructionSurtax2025,
  salaryIncome2025,
} from './tables.js';
import { JAPAN_2025_SOURCES } from './sources.js';

export const JAPAN_2025_PACKAGE_VERSION =
  '2025.1-national-salary-working-papers';

export const JAPAN_2025_SCOPE = deepFreeze({
  country: 'JP',
  subdivision: 'JP-NATIONAL',
  taxpayerType: 'individual' as const,
  year: 2025,
  regime: 'income-tax-return',
  formVersion: 'r07-form-1-2',
});

/**
 * The facts below are the complete input boundary for this bounded slice.
 * `equals` values are deliberate exclusions: absence or an inferred zero is
 * never accepted as evidence that an unsupported return branch is absent.
 */
export const JAPAN_2025_REQUIRED_FACTS = deepFreeze([
  { key: 'case.fullYearDomesticResident', type: 'boolean', equals: true },
  { key: 'case.salaryOnly', type: 'boolean', equals: true },
  { key: 'case.salaryRecordsComplete', type: 'boolean', equals: true },
  { key: 'case.noOtherIncome', type: 'boolean', equals: true },
  {
    key: 'case.noSpecialSalaryDeductions',
    type: 'boolean',
    equals: true,
  },
  { key: 'case.noOtherIncomeDeductions', type: 'boolean', equals: true },
  { key: 'case.noTaxCredits', type: 'boolean', equals: true },
  { key: 'case.noForeignTaxCredit', type: 'boolean', equals: true },
  { key: 'case.noSeparateTaxation', type: 'boolean', equals: true },
  { key: 'case.noDisasterReduction', type: 'boolean', equals: true },
  { key: 'case.noEstimatedPayments', type: 'boolean', equals: true },
  { key: 'salary.gross', type: 'decimal' },
  { key: 'deductions.socialInsurancePremiums', type: 'decimal' },
  { key: 'deductions.other', type: 'decimal', equals: '0' },
  { key: 'withholding.incomeTax', type: 'decimal' },
  { key: 'payments.estimatedTax', type: 'decimal', equals: '0' },
] as const);

export const JAPAN_2025_RELEASE_BLOCKERS = deepFreeze([
  'working-papers-only-no-full-return-attestation',
  'independent-complete-return-validation-not-complete',
  'all-applicable-form-and-attachment-field-inventory-not-complete',
  'local-inhabitant-tax-and-prefectural-municipal-tax-not-implemented',
  'sole-proprietor-business-income-and-expense-schedules-not-implemented',
  'corporation-return-and-corporate-local-tax-not-implemented',
  'other-income-separate-taxation-and-loss-schedules-not-implemented',
  'nonresident-and-cross-border-rules-not-implemented',
  'credits-reliefs-special-deductions-and-estimated-payment-rules-not-implemented',
  'high-income-special-tax-measure-not-implemented',
] as const);

const sourceByRule = {
  salaryGross: 'nta-jp-r07-salary-income',
  salaryIncome: 'nta-jp-r07-salary-income',
  socialInsurance: 'nta-jp-r07-social-insurance',
  basicDeduction: 'nta-jp-r07-basic-deduction',
  formFields: 'nta-jp-r07-form-1-2',
  nationalTax: 'nta-jp-r07-national-tax',
  reconstruction: 'nta-jp-r07-reconstruction-surtax',
  combinedTax: 'nta-jp-r07-total-tax',
  withholding: 'nta-jp-r07-withholding',
  assessment: 'nta-jp-r07-assessment',
  thirdPeriod: 'nta-jp-r07-third-period',
  highIncomeSpecial: 'nta-jp-r07-high-income',
} as const;

const rule = (id: string, sourceIds: readonly string[]) => ({
  id,
  referenceIds: [...sourceIds],
});

export const JAPAN_2025_RULES = deepFreeze([
  rule('jp2025.salary-gross', [sourceByRule.salaryGross]),
  rule('jp2025.salary-income', [sourceByRule.salaryIncome]),
  rule('jp2025.social-insurance', [sourceByRule.socialInsurance]),
  rule('jp2025.basic-deduction', [sourceByRule.basicDeduction]),
  rule('jp2025.other-deductions-excluded', [sourceByRule.formFields]),
  rule('jp2025.total-deductions', [
    sourceByRule.socialInsurance,
    sourceByRule.basicDeduction,
  ]),
  rule('jp2025.taxable-income', [sourceByRule.nationalTax]),
  rule('jp2025.national-tax', [sourceByRule.nationalTax]),
  rule('jp2025.base-income-tax', [sourceByRule.nationalTax]),
  rule('jp2025.reconstruction-surtax', [sourceByRule.reconstruction]),
  rule('jp2025.combined-tax', [sourceByRule.combinedTax]),
  rule('jp2025.withholding', [sourceByRule.withholding]),
  rule('jp2025.estimated-payment', [sourceByRule.thirdPeriod]),
  rule('jp2025.assessment', [sourceByRule.assessment]),
  rule('jp2025.third-period', [sourceByRule.thirdPeriod]),
  rule('jp2025.high-income-special-tax', [sourceByRule.highIncomeSpecial]),
] as const);

export const JAPAN_2025_CANDIDATE = deepFreeze({
  id: 'jp-national-2025-salary-working-papers',
  version: JAPAN_2025_PACKAGE_VERSION,
  enabled: false,
  registryEligible: false,
  complete: false,
  scope: JAPAN_2025_SCOPE,
  coverage:
    'Bounded national income-tax working papers for a full-year domestic resident individual with only ordinary calendar-year salary income, social-insurance-premium deduction, basic deduction, and salary withholding. All other income, deductions, credits, taxes, payments and special return cases are explicit blockers.',
  forms: ['JP-Form-1', 'JP-Form-2'],
  references: JAPAN_2025_SOURCES,
  rules: JAPAN_2025_RULES,
  requiredFacts: JAPAN_2025_REQUIRED_FACTS,
  roundingPolicy:
    'jpy-exact-decimal-with-nta-salary-and-taxable-thousand-yen-floor-reconstruction-yen-floor-assessment-hundred-yen-floor',
  releaseBlockers: JAPAN_2025_RELEASE_BLOCKERS,
  eventualScope: [
    'complete Japanese national return Form 1 and Form 2 field/attachment coverage',
    'applicable schedules and separate-taxation returns',
    'prefectural and municipal inhabitant tax returns',
    'sole-proprietor and corporation returns',
  ],
});

type JapanIssue = { code: string; message: string };

export type Japan2025Field = {
  id: string;
  form: string;
  line: string;
  label: string;
  dependencies: string[];
  sourceFactKeys: string[];
  sourceId: string;
  locator: string;
  ruleId: string;
  exactRational: { numerator: string; denominator: string };
  exactYen: string;
  reportableAmount: string;
};

type Japan2025Trace = {
  formId: string;
  line: string;
  exactNumerator: string;
  exactDenominator: string;
  reportedYen: string;
  dependsOn: string[];
  sourceFactKeys: string[];
  referenceIds: string[];
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const hash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

function valueEqual(actual: unknown, expected: unknown, type: string) {
  if (type !== 'decimal' || typeof actual !== 'string')
    return actual === expected;
  if (typeof expected !== 'string') return false;
  try {
    return compare(decimal(actual), decimal(expected)) === 0n;
  } catch {
    return false;
  }
}

function exactScopeMatches(intake: FinanceTaxIntake): boolean {
  return Object.entries(JAPAN_2025_SCOPE).every(
    ([key, value]) =>
      intake.scope[key as keyof typeof JAPAN_2025_SCOPE] === value,
  );
}

function decimalFactValue(
  facts: ReadonlyMap<string, FinanceTaxIntake['facts'][number]>,
  key: string,
): Q {
  const value = facts.get(key)?.value;
  if (!value || value.type !== 'decimal')
    throw new Error('decimal-fact-required');
  return decimal(value.value);
}

/** Validate generic intake, review state, exact scope, and all exclusions. */
export function assessJapan2025Facts(raw: unknown) {
  const parsed = FinanceTaxIntakeSchema.safeParse(raw);
  const issues: JapanIssue[] = [];
  const issue = (code: string, message: string) =>
    issues.push({ code, message });
  if (!parsed.success) {
    issue('invalid-intake', 'Generic tax intake or source lineage is invalid.');
    return { intake: null, issues };
  }
  const intake = parsed.data;
  if (!exactScopeMatches(intake))
    issue(
      'unsupported-scope',
      'Requires JP-NATIONAL individual income-tax-return scope, calendar 2025 (令和7年分), and the pinned r07 Form 1/2 version.',
    );
  if (
    intake.domesticResident !== true ||
    intake.hasCrossBorderActivity !== false ||
    intake.standaloneCorporation !== null ||
    intake.requestedFeatures.length !== 1 ||
    intake.requestedFeatures[0] !== 'income-tax-return'
  )
    issue(
      'unsupported-scope',
      'Only a full-year domestic resident individual income-tax-return calculation is covered; payroll, e-filing, consolidation and cross-border cases are outside this package.',
    );

  const required: ReadonlySet<string> = new Set(
    JAPAN_2025_REQUIRED_FACTS.map((fact) => fact.key),
  );
  const facts = new Map(intake.facts.map((fact) => [fact.key, fact]));
  for (const fact of intake.facts)
    if (!required.has(fact.key))
      issue(
        'unsupported-fact',
        `Unmapped fact is not silently ignored: ${fact.key}`,
      );

  for (const requirement of JAPAN_2025_REQUIRED_FACTS) {
    const fact = facts.get(requirement.key);
    if (!fact) {
      issue(
        'missing-reviewed-fact',
        `Reviewed ${requirement.type} fact required: ${requirement.key}`,
      );
      continue;
    }
    if (fact.reviewState !== 'reviewed')
      issue('unreviewed-fact', `Reviewed fact required: ${requirement.key}`);
    if (fact.value.type !== requirement.type) {
      issue(
        'wrong-fact-type',
        `Expected ${requirement.type} for ${requirement.key}`,
      );
      continue;
    }
    if (
      'equals' in requirement &&
      !valueEqual(fact.value.value, requirement.equals, requirement.type)
    )
      issue('unsupported-fact', `Unsupported value for ${requirement.key}`);
    if (fact.value.type === 'decimal') {
      try {
        const amount = decimal(fact.value.value);
        if (amount.n < 0n || !isWholeYen(amount))
          issue(
            'invalid-money',
            `Nonnegative whole-JPY source amount required: ${requirement.key}`,
          );
      } catch {
        issue('invalid-money', `Invalid JPY amount: ${requirement.key}`);
      }
    }
  }

  // A special 2025 high-income measure is a separate return branch.  It must
  // not be hidden behind the ordinary national quick-calculation table.
  if (!issues.length) {
    const salary = decimalFactValue(facts, 'salary.gross');
    const income = salaryIncome2025(salary).income;
    if (compare(income, q(330_000_000n)) >= 0)
      issue(
        'high-income-special-tax-not-covered',
        'Total income at or above 330,000,000 yen requires the 2025 special high-income tax measure and its separate NTA worksheet.',
      );
  }
  return { intake, issues };
}

export type Japan2025Run = ReturnType<typeof runJapan2025WorkingPapers>;

/**
 * Pure, disabled candidate evaluator.  It emits immutable working figures
 * and an exact dependency trace.  It does not register, enable, file, or
 * authorize a return, and it never accepts a caller-supplied tax result.
 */
export function runJapan2025WorkingPapers(raw: unknown) {
  const assessed = assessJapan2025Facts(raw);
  const issues = [...assessed.issues];
  const fields: Japan2025Field[] = [];
  const traces: Japan2025Trace[] = [];
  const values = new Map<string, Q>();
  const origins = new Map<string, string[]>();
  const forms: FinanceTaxEvaluation['forms'] = [];

  const finish = (intake: FinanceTaxIntake | null) => {
    const evaluation = FinanceTaxEvaluationSchema.parse({
      forms,
      issues,
    });
    const body = {
      candidate: JAPAN_2025_CANDIDATE,
      complete: false as const,
      enabled: false as const,
      reportable: false as const,
      registryEligible: false as const,
      status: fields.length
        ? ('incomplete-working-papers' as const)
        : ('blocked-input' as const),
      inputSnapshot: intake,
      inputHash: intake ? hash(intake) : null,
      binding: intake
        ? {
            caseId: intake.caseId,
            workspaceId: intake.workspaceId,
            taxSubjectId: intake.taxSubjectId,
            snapshotRevision: intake.revision,
            sourceBooks: intake.sourceBooks,
            sourceFacts: intake.facts.map((fact) => ({
              key: fact.key,
              source: fact.source,
            })),
          }
        : null,
      sources: JAPAN_2025_SOURCES,
      fields,
      evaluation,
      trace: traces,
      calculations: fields.length
        ? {
            currency: 'JPY' as const,
            salaryGross: fields.find(
              (field) => field.id === 'JP-Form-1.salaryGross',
            )?.exactYen,
            salaryIncome: fields.find(
              (field) => field.id === 'JP-Form-1.salaryIncome',
            )?.exactYen,
            socialInsurancePremiums: fields.find(
              (field) => field.id === 'JP-Form-1.socialInsurance',
            )?.exactYen,
            basicDeduction: fields.find(
              (field) => field.id === 'JP-Form-1.basicDeduction',
            )?.exactYen,
            taxableIncome: fields.find(
              (field) => field.id === 'JP-Form-1.taxableIncome',
            )?.exactYen,
            baseIncomeTax: fields.find(
              (field) => field.id === 'JP-Form-1.baseIncomeTax',
            )?.exactYen,
            reconstructionSurtax: fields.find(
              (field) => field.id === 'JP-Form-1.reconstructionSurtax',
            )?.exactYen,
            combinedTax: fields.find(
              (field) => field.id === 'JP-Form-1.combinedTax',
            )?.exactYen,
            withholding: fields.find(
              (field) => field.id === 'JP-Form-1.withholding',
            )?.exactYen,
            estimatedTax: fields.find(
              (field) => field.id === 'JP-Form-1.estimatedTax',
            )?.exactYen,
            assessmentBeforeRounding: fields.find(
              (field) => field.id === 'JP-Form-1.assessmentBeforeRounding',
            )?.exactYen,
            declaredAssessment: fields.find(
              (field) => field.id === 'JP-Form-1.declaredAssessment',
            )?.exactYen,
            amountDue: fields.find(
              (field) => field.id === 'JP-Form-1.thirdPeriodDue',
            )?.exactYen,
            refund: fields.find((field) => field.id === 'JP-Form-1.refund')
              ?.exactYen,
          }
        : null,
      formCoverage: [
        {
          id: 'JP-Form-1',
          version: JAPAN_2025_SCOPE.formVersion,
          complete: false,
          fieldCount: fields.filter((field) => field.form === 'JP-Form-1')
            .length,
        },
        {
          id: 'JP-Form-2',
          version: JAPAN_2025_SCOPE.formVersion,
          complete: false,
          fieldCount: fields.filter((field) => field.form === 'JP-Form-2')
            .length,
        },
      ],
      issues,
      releaseBlockers: JAPAN_2025_RELEASE_BLOCKERS,
      definitionHash: hash(JAPAN_2025_CANDIDATE),
    };
    return deepFreeze({ ...body, outputHash: hash(body) });
  };

  if (!assessed.intake || issues.length) return finish(assessed.intake);
  const intake = assessed.intake;
  const facts = new Map(intake.facts.map((fact) => [fact.key, fact]));

  const add = (
    formId: string,
    line: string,
    label: string,
    value: Q,
    ruleId: string,
    sourceId: string,
    locator: string,
    dependsOn: string[] = [],
    directFacts: string[] = [],
  ) => {
    const key = `${formId}.${line}`;
    const sourceFactKeys = [
      ...new Set([
        ...directFacts,
        ...dependsOn.flatMap((dependency) => origins.get(dependency) ?? []),
      ]),
    ].sort();
    const exactYen = format(value);
    const field: Japan2025Field = {
      id: key,
      form: formId,
      line,
      label,
      dependencies: [...dependsOn],
      sourceFactKeys,
      sourceId,
      locator,
      ruleId,
      exactRational: serialize(value),
      exactYen,
      reportableAmount: exactYen,
    };
    fields.push(field);
    values.set(key, value);
    origins.set(key, sourceFactKeys);
    let form = forms.find((candidate) => candidate.id === formId);
    if (!form) {
      form = {
        id: formId,
        version: JAPAN_2025_SCOPE.formVersion,
        fields: [],
      };
      forms.push(form);
    }
    form.fields.push({
      key: line,
      value: { type: 'decimal', value: exactYen },
      ruleIds: [ruleId],
      sourceFactKeys,
    });
    traces.push({
      formId,
      line,
      exactNumerator: value.n.toString(),
      exactDenominator: value.d.toString(),
      reportedYen: exactYen,
      dependsOn: [...dependsOn],
      sourceFactKeys,
      referenceIds: [sourceId],
    });
    return value;
  };
  const fact = (key: string) => decimalFactValue(facts, key);
  const at = (key: string) => {
    const value = values.get(key);
    if (!value) throw new Error(`missing-form-dependency:${key}`);
    return value;
  };
  const copy = (
    formId: string,
    line: string,
    label: string,
    dependency: string,
    ruleId: string,
    sourceId: string,
    locator: string,
  ) =>
    add(formId, line, label, at(dependency), ruleId, sourceId, locator, [
      dependency,
    ]);

  add(
    'JP-Form-1',
    'salaryGross',
    'Salary receipts (第一表 オ)',
    fact('salary.gross'),
    'jp2025.salary-gross',
    sourceByRule.salaryGross,
    '2025 NTA First Form, salary gross receipts field オ',
    [],
    ['salary.gross'],
  );
  add(
    'JP-Form-1',
    'salaryIncome',
    'Salary income after salary-income deduction (第一表 6)',
    salaryIncome2025(fact('salary.gross')).income,
    'jp2025.salary-income',
    sourceByRule.salaryIncome,
    '2025 NTA salary-income calculation table, Step 2/4 and First Form line 6',
    ['JP-Form-1.salaryGross'],
  );
  add(
    'JP-Form-2',
    'salaryIncomeDetail',
    'Salary-income detail (第二表 所得の内訳)',
    at('JP-Form-1.salaryIncome'),
    'jp2025.salary-income',
    sourceByRule.salaryIncome,
    '2025 NTA Second Form, income detail for salary',
    ['JP-Form-1.salaryIncome'],
  );
  copy(
    'JP-Form-1',
    'totalIncome',
    'Total income (第一表 12)',
    'JP-Form-1.salaryIncome',
    'jp2025.salary-income',
    sourceByRule.salaryIncome,
    '2025 NTA First Form line 12; salary-only total income',
  );
  add(
    'JP-Form-1',
    'socialInsurance',
    'Social-insurance premium deduction (第一表 10)',
    fact('deductions.socialInsurancePremiums'),
    'jp2025.social-insurance',
    sourceByRule.socialInsurance,
    '2025 NTA First Form line 10; social-insurance-premium deduction',
    [],
    ['deductions.socialInsurancePremiums'],
  );
  add(
    'JP-Form-2',
    'socialInsuranceDetail',
    'Social-insurance premium detail (第二表 10)',
    at('JP-Form-1.socialInsurance'),
    'jp2025.social-insurance',
    sourceByRule.socialInsurance,
    '2025 NTA Second Form line 10; premium type and total',
    ['JP-Form-1.socialInsurance'],
  );
  add(
    'JP-Form-1',
    'otherDeductionsExcluded',
    'Unsupported income deductions reviewed as zero',
    fact('deductions.other'),
    'jp2025.other-deductions-excluded',
    sourceByRule.formFields,
    '2025 NTA First Form lines 11-24 and 26-29; excluded branches reviewed zero',
    [],
    ['deductions.other'],
  );
  add(
    'JP-Form-1',
    'basicDeduction',
    'Basic deduction (第一表 25)',
    basicDeduction2025(at('JP-Form-1.totalIncome')).amount,
    'jp2025.basic-deduction',
    sourceByRule.basicDeduction,
    '2025 NTA basic-deduction table; resident amount by total income and First Form line 25',
    ['JP-Form-1.totalIncome'],
  );
  add(
    'JP-Form-1',
    'totalDeductions',
    'Total income deductions (第一表 30)',
    plus(
      at('JP-Form-1.socialInsurance'),
      at('JP-Form-1.otherDeductionsExcluded'),
      at('JP-Form-1.basicDeduction'),
    ),
    'jp2025.total-deductions',
    sourceByRule.basicDeduction,
    '2025 NTA First Form line 30; supported social insurance and basic deduction only',
    [
      'JP-Form-1.socialInsurance',
      'JP-Form-1.otherDeductionsExcluded',
      'JP-Form-1.basicDeduction',
    ],
  );
  const taxable = floorThousandYen(
    positive(
      minus(at('JP-Form-1.totalIncome'), at('JP-Form-1.totalDeductions')),
    ),
  );
  add(
    'JP-Form-1',
    'taxableIncome',
    'Taxable income after 1,000-yen truncation (第一表 31)',
    taxable,
    'jp2025.taxable-income',
    sourceByRule.nationalTax,
    '2025 NTA taxable-income calculation; A minus B, 1,000-yen fraction dropped, First Form line 31',
    ['JP-Form-1.totalIncome', 'JP-Form-1.totalDeductions'],
  );
  const national = nationalIncomeTax2025(at('JP-Form-1.taxableIncome'));
  add(
    'JP-Form-1',
    'taxBeforeCredits',
    'Tax on taxable income before credits (第一表 32)',
    national.amount,
    'jp2025.national-tax',
    sourceByRule.nationalTax,
    '2025 NTA national-tax quick-calculation table; First Form line 32',
    ['JP-Form-1.taxableIncome'],
  );
  add(
    'JP-Form-1',
    'deductedIncomeTax',
    'Income tax after supported zero credits (第一表 42)',
    at('JP-Form-1.taxBeforeCredits'),
    'jp2025.national-tax',
    sourceByRule.nationalTax,
    '2025 NTA First Form line 42; all credit branches explicitly excluded',
    ['JP-Form-1.taxBeforeCredits'],
  );
  add(
    'JP-Form-1',
    'baseIncomeTax',
    'Base income tax (第一表 44)',
    at('JP-Form-1.deductedIncomeTax'),
    'jp2025.base-income-tax',
    sourceByRule.nationalTax,
    '2025 NTA First Form line 44; base income tax before reconstruction surtax',
    ['JP-Form-1.deductedIncomeTax'],
  );
  add(
    'JP-Form-1',
    'reconstructionSurtax',
    'Special income tax for reconstruction (第一表 45)',
    reconstructionSurtax2025(at('JP-Form-1.baseIncomeTax')),
    'jp2025.reconstruction-surtax',
    sourceByRule.reconstruction,
    '2025 NTA First Form line 45; base income tax multiplied by 0.021, fractions below one yen dropped',
    ['JP-Form-1.baseIncomeTax'],
  );
  add(
    'JP-Form-1',
    'combinedTax',
    'Income tax and reconstruction surtax (第一表 46)',
    plus(at('JP-Form-1.baseIncomeTax'), at('JP-Form-1.reconstructionSurtax')),
    'jp2025.combined-tax',
    sourceByRule.combinedTax,
    '2025 NTA First Form line 46; line 44 plus line 45',
    ['JP-Form-1.baseIncomeTax', 'JP-Form-1.reconstructionSurtax'],
  );
  add(
    'JP-Form-1',
    'withholding',
    'Salary income tax and reconstruction surtax withheld (第一表 49)',
    fact('withholding.incomeTax'),
    'jp2025.withholding',
    sourceByRule.withholding,
    '2025 NTA First Form line 49 and Second Form salary income detail; withheld income tax等 amount',
    [],
    ['withholding.incomeTax'],
  );
  add(
    'JP-Form-2',
    'withholdingDetail',
    'Withholding detail for salary (第二表 所得の内訳)',
    at('JP-Form-1.withholding'),
    'jp2025.withholding',
    sourceByRule.withholding,
    '2025 NTA Second Form income detail; withholding tax amount for salary',
    ['JP-Form-1.withholding'],
  );
  add(
    'JP-Form-1',
    'estimatedTax',
    'Estimated tax paid (第一表 51)',
    fact('payments.estimatedTax'),
    'jp2025.estimated-payment',
    sourceByRule.thirdPeriod,
    '2025 NTA First Form line 51; this candidate requires zero estimated payments',
    [],
    ['payments.estimatedTax'],
  );
  const rawAssessment = minus(
    minus(at('JP-Form-1.combinedTax'), at('JP-Form-1.withholding')),
    at('JP-Form-1.estimatedTax'),
  );
  add(
    'JP-Form-1',
    'assessmentBeforeRounding',
    'Assessment before the return settlement rounding rule',
    rawAssessment,
    'jp2025.assessment',
    sourceByRule.assessment,
    '2025 NTA First Form line 50 dependency before positive 100-yen truncation',
    [
      'JP-Form-1.combinedTax',
      'JP-Form-1.withholding',
      'JP-Form-1.estimatedTax',
    ],
  );
  const assessment = declaredAssessment2025(rawAssessment);
  add(
    'JP-Form-1',
    'declaredAssessment',
    'Declared tax / refund settlement (第一表 50)',
    assessment,
    'jp2025.assessment',
    sourceByRule.assessment,
    '2025 NTA First Form line 50; positive amount truncates below 100 yen and negative refund remains signed',
    ['JP-Form-1.assessmentBeforeRounding'],
  );
  add(
    'JP-Form-1',
    'thirdPeriodDue',
    'Third-period tax due (第一表 52)',
    positive(assessment),
    'jp2025.third-period',
    sourceByRule.thirdPeriod,
    '2025 NTA First Form line 52; positive third-period amount',
    ['JP-Form-1.declaredAssessment'],
  );
  add(
    'JP-Form-1',
    'refund',
    'Refund amount as signed return result (第一表 53)',
    assessment.n < 0n ? assessment : q(0n),
    'jp2025.third-period',
    sourceByRule.thirdPeriod,
    '2025 NTA First Form line 53; negative third-period amount is retained with a minus sign',
    ['JP-Form-1.declaredAssessment'],
  );
  return finish(intake);
}

export function evaluateJapan2025WorkingPapers(raw: unknown) {
  return runJapan2025WorkingPapers(raw);
}

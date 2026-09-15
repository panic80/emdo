import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  deepFreeze,
  FinanceTaxEvaluationSchema,
  FinanceTaxIntakeSchema,
  type FinanceTaxEvaluation,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import {
  decimal,
  exactDecimal,
  lt,
  lte,
  minus,
  plus,
  positive,
  q,
  serialize,
  times,
  truncateTowardZero,
  type Q,
} from './exact.js';
import {
  southKorea2025EarnedIncomeDeduction,
  southKorea2025EarnedIncomeTaxCredit,
  southKorea2025IncomeTax,
  SOUTH_KOREA_2025_BASIC_PERSONAL_DEDUCTION,
  SOUTH_KOREA_2025_STANDARD_TAX_CREDIT,
} from './tables.js';
import {
  SOUTH_KOREA_2025_PUBLICATION_EVIDENCE,
  SOUTH_KOREA_2025_SOURCES,
} from './sources.js';

export const SOUTH_KOREA_2025_VERSION =
  '2025.1-national-employment-working-papers.1';
export const SOUTH_KOREA_2025_FORM_VERSION = 'NTS-YEAREND-2025';
/** NTS treats a positive year-end balance below KRW 1,000 as non-collectible. */
export const SOUTH_KOREA_2025_SMALL_COLLECTION_THRESHOLD = decimal('1000');

export const SOUTH_KOREA_2025_SCOPE = deepFreeze({
  country: 'KR',
  subdivision: 'KR-NATIONAL',
  taxpayerType: 'individual',
  year: 2025,
  regime: 'income-tax-return',
  formVersion: SOUTH_KOREA_2025_FORM_VERSION,
} as const);

const NonnegativeDecimal = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .max(100);
const PositiveCount = NonnegativeDecimal.refine((value) => {
  try {
    const amount = decimal(value);
    return amount.n >= 1n && amount.d === 1n;
  } catch {
    return false;
  }
}, 'Expected a positive whole-number count');

/**
 * Standalone arithmetic input.  The generic FinanceTaxIntake adapter below
 * supplies the review/source envelope used by the application; this schema is
 * useful for independent deterministic arithmetic fixtures.
 */
export const SouthKorea2025EmploymentInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.strictObject({
    country: z.literal('KR'),
    subdivision: z.literal('KR-NATIONAL'),
    taxpayerType: z.literal('individual'),
    year: z.literal(2025),
    regime: z.literal('income-tax-return'),
    formVersion: z.literal(SOUTH_KOREA_2025_FORM_VERSION),
  }),
  domesticResident: z.boolean(),
  hasCrossBorderActivity: z.boolean(),
  onlyOrdinaryEmploymentIncome: z.boolean(),
  hasBusinessIncome: z.boolean(),
  hasInvestmentIncome: z.boolean(),
  hasPensionIncome: z.boolean(),
  hasOtherGlobalIncome: z.boolean(),
  hasDailyEmploymentIncome: z.boolean(),
  hasForeignSourceIncome: z.boolean(),
  hasRetirementIncome: z.boolean(),
  usesForeignWorkerFlatTax: z.boolean(),
  hasTaxReductionOrExemption: z.boolean(),
  annualGrossEmploymentIncome: NonnegativeDecimal,
  annualNonTaxableEmploymentIncome: NonnegativeDecimal,
  basicDeductionCount: PositiveCount,
  nationalPensionContribution: NonnegativeDecimal,
  healthInsuranceContribution: NonnegativeDecimal,
  employmentInsuranceContribution: NonnegativeDecimal,
  longTermCareInsuranceContribution: NonnegativeDecimal,
  otherIncomeDeductions: NonnegativeDecimal,
  otherTaxCredits: NonnegativeDecimal,
  monthlyRentTaxCredit: NonnegativeDecimal,
  incomeTaxReduction: NonnegativeDecimal,
  withheldIncomeTax: NonnegativeDecimal,
});
export type SouthKorea2025EmploymentInput = z.infer<
  typeof SouthKorea2025EmploymentInputSchema
>;

type Issue = { code: string; path: string; message: string };
type EvaluationIssue = FinanceTaxEvaluation['issues'][number];

export const SOUTH_KOREA_2025_GUARDS = deepFreeze([
  {
    key: 'case.onlyOrdinaryEmploymentIncome',
    directKey: 'onlyOrdinaryEmploymentIncome',
    type: 'boolean',
    expected: true,
    label: 'Only ordinary employment income is in scope',
    locator: 'NTS year-end guide, wage and salary income scope (pp. 50-53)',
  },
  {
    key: 'case.hasBusinessIncome',
    directKey: 'hasBusinessIncome',
    type: 'boolean',
    expected: false,
    label: 'No business or rental income',
    locator:
      'NTS global-income guide, classification of taxable income (pp. 198-203)',
  },
  {
    key: 'case.hasInvestmentIncome',
    directKey: 'hasInvestmentIncome',
    type: 'boolean',
    expected: false,
    label: 'No interest or dividend income',
    locator:
      'NTS global-income guide, classification of taxable income (pp. 198-203)',
  },
  {
    key: 'case.hasPensionIncome',
    directKey: 'hasPensionIncome',
    type: 'boolean',
    expected: false,
    label: 'No pension income',
    locator:
      'NTS global-income guide, classification of taxable income (pp. 198-203)',
  },
  {
    key: 'case.hasOtherGlobalIncome',
    directKey: 'hasOtherGlobalIncome',
    type: 'boolean',
    expected: false,
    label: 'No other global income',
    locator:
      'NTS global-income guide, classification of taxable income (pp. 198-203)',
  },
  {
    key: 'case.hasDailyEmploymentIncome',
    directKey: 'hasDailyEmploymentIncome',
    type: 'boolean',
    expected: false,
    label: 'No daily-worker employment income',
    locator:
      'NTS global-income guide, non-inclusion in global income (pp. 198-199)',
  },
  {
    key: 'case.hasForeignSourceIncome',
    directKey: 'hasForeignSourceIncome',
    type: 'boolean',
    expected: false,
    label: 'No foreign-source employment or other income',
    locator:
      'NTS global-income guide, resident foreign-income reporting (pp. 32-43)',
  },
  {
    key: 'case.hasRetirementIncome',
    directKey: 'hasRetirementIncome',
    type: 'boolean',
    expected: false,
    label: 'No retirement income',
    locator: 'NTS global-income guide, classification of income (pp. 198-203)',
  },
  {
    key: 'case.usesForeignWorkerFlatTax',
    directKey: 'usesForeignWorkerFlatTax',
    type: 'boolean',
    expected: false,
    label: 'No foreign-worker 19% flat-tax election',
    locator: 'NTS year-end guide, foreign employee treatment (p. 92)',
  },
  {
    key: 'case.hasTaxReductionOrExemption',
    directKey: 'hasTaxReductionOrExemption',
    type: 'boolean',
    expected: false,
    label: 'No income-tax reduction or exemption',
    locator:
      'NTS year-end guide, income-tax reduction and credit section (pp. 148-162)',
  },
] as const);

const MONEY_FACT_DEFINITIONS = [
  [
    'income.annualGrossEmploymentIncome',
    'annualGrossEmploymentIncome',
    'Annual employment income including non-taxable pay',
  ],
  [
    'income.annualNonTaxableEmploymentIncome',
    'annualNonTaxableEmploymentIncome',
    'Non-taxable employment income',
  ],
  [
    'deduction.basicDeductionCount',
    'basicDeductionCount',
    'Reviewed number of basic-deduction persons',
  ],
  [
    'deduction.nationalPensionContribution',
    'nationalPensionContribution',
    'Employee public-pension contribution',
  ],
  [
    'deduction.healthInsuranceContribution',
    'healthInsuranceContribution',
    'National health-insurance contribution',
  ],
  [
    'deduction.employmentInsuranceContribution',
    'employmentInsuranceContribution',
    'Employment-insurance contribution',
  ],
  [
    'deduction.longTermCareInsuranceContribution',
    'longTermCareInsuranceContribution',
    'Long-term-care insurance contribution',
  ],
  [
    'deduction.otherIncomeDeductions',
    'otherIncomeDeductions',
    'Other income deductions (must be zero in this slice)',
  ],
  [
    'credit.otherTaxCredits',
    'otherTaxCredits',
    'Other tax credits (must be zero in this slice)',
  ],
  [
    'credit.monthlyRentTaxCredit',
    'monthlyRentTaxCredit',
    'Monthly-rent tax credit (must be zero in this slice)',
  ],
  [
    'credit.incomeTaxReduction',
    'incomeTaxReduction',
    'Income-tax reduction or exemption amount (must be zero)',
  ],
  [
    'withholding.incomeTax',
    'withheldIncomeTax',
    'Income tax withheld during 2025',
  ],
] as const;

export const SOUTH_KOREA_2025_MONEY_FACTS = deepFreeze(
  MONEY_FACT_DEFINITIONS.map(([key, directKey, label]) => ({
    key,
    directKey,
    type: 'decimal' as const,
    label,
  })),
);

export const SOUTH_KOREA_2025_REQUIRED_FACTS = deepFreeze([
  ...SOUTH_KOREA_2025_GUARDS.map(({ key, type }) => ({ key, type })),
  ...SOUTH_KOREA_2025_MONEY_FACTS.map(({ key, type }) => ({ key, type })),
]);

type RuleDefinition = {
  key: string;
  label: string;
  locator: string;
  referenceIds: readonly string[];
};

const RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    key: 'employment.annualGrossIncome',
    label: 'Annual employment income',
    locator: 'NTS year-end guide, wage-income flow, annual employment income',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'employment.nonTaxableIncome',
    label: 'Non-taxable employment income',
    locator: 'NTS year-end guide, wage-income flow, non-taxable income',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'employment.totalSalary',
    label: 'Total salary',
    locator:
      'NTS year-end guide, wage-income flow: annual income minus non-taxable income',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'employment.earnedIncomeDeduction',
    label: 'Earned-income deduction',
    locator: 'NTS year-end guide, Article 47 table, pp. 94-95',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'employment.earnedIncome',
    label: 'Earned-income amount',
    locator:
      'NTS year-end guide, wage-income flow: total salary minus earned-income deduction',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'deduction.basicPersonal',
    label: 'Basic personal deduction',
    locator:
      'NTS year-end guide, personal deduction: KRW 1,500,000 per eligible person, p. 95',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'deduction.nationalPension',
    label: 'Public-pension contribution deduction',
    locator:
      'NTS year-end guide, Article 51-3 pension-insurance deduction, p. 103',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'deduction.healthInsurance',
    label: 'Special income deduction for insurance contributions',
    locator:
      'NTS year-end guide, health, employment and long-term-care insurance, p. 103',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'deduction.employmentInsurance',
    label: 'Employment-insurance contribution deduction',
    locator:
      'NTS year-end guide, health, employment and long-term-care insurance, p. 103',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'deduction.longTermCareInsurance',
    label: 'Long-term-care insurance contribution deduction',
    locator:
      'NTS year-end guide, health, employment and long-term-care insurance, p. 103',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'deduction.specialInsurance',
    label: 'Total mandatory insurance contribution deduction',
    locator:
      'NTS year-end guide, health, employment and long-term-care insurance, p. 103',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'deduction.otherIncomeDeductions',
    label: 'Other income deductions',
    locator:
      'NTS year-end guide, other income deductions, pp. 120-147; zero-only guard in this slice',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'tax.taxBase',
    label: 'Income-tax base',
    locator:
      'NTS year-end guide, wage-income flow: income amount less income deductions',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'tax.calculatedTax',
    label: 'Tax calculated under progressive rates',
    locator:
      'NTS global-income guide, 2025 global-income tax rate table, pp. 17-18',
    referenceIds: [
      'nts-kr-2025-global-income-guide',
      'nts-kr-2025-year-end-settlement-guide',
    ],
  },
  {
    key: 'credit.earnedIncomeTaxCredit',
    label: 'Earned-income tax credit',
    locator:
      'NTS year-end guide, Article 59 earned-income tax credit, pp. 161-162',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'credit.standardTaxCredit',
    label: 'Standard tax credit',
    locator:
      'NTS year-end guide, standard tax credit of KRW 130,000 where special deductions/credits are not claimed, p. 14',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'credit.otherTaxCredits',
    label: 'Other tax credits',
    locator:
      'NTS year-end guide, tax-credit section, pp. 148-210; zero-only guard in this slice',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'credit.monthlyRentTaxCredit',
    label: 'Monthly-rent tax credit',
    locator:
      'NTS year-end guide, Article 95-2 monthly-rent credit, pp. 202-204; zero-only guard in this slice',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'credit.incomeTaxReduction',
    label: 'Income-tax reduction or exemption',
    locator:
      'NTS year-end guide, reduction section, pp. 148-161; zero-only guard in this slice',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'tax.taxAfterReduction',
    label: 'Tax after reductions',
    locator: 'NTS year-end guide, wage-income flow: reductions before credits',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'credit.totalTaxCredits',
    label: 'Total supported tax credits',
    locator:
      'NTS year-end guide, wage-income flow: tax credits subtracted from calculated tax',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'tax.determinedTax',
    label: 'Determined national income tax',
    locator:
      'NTS year-end guide, wage-income flow: calculated tax minus reductions and credits',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'withholding.incomeTax',
    label: 'Income tax withheld',
    locator: 'NTS year-end guide, withholding receipt and settlement form',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
  {
    key: 'settlement.balanceDueOrRefund',
    label: 'Settlement balance due or refund',
    locator: 'NTS year-end guide, withholding receipt settlement difference',
    referenceIds: ['nts-kr-2025-year-end-settlement-guide'],
  },
];

export const SOUTH_KOREA_2025_RULES = deepFreeze(
  RULE_DEFINITIONS.map((rule) => ({
    id: `kr2025.${rule.key}`,
    referenceIds: rule.referenceIds,
    locator: rule.locator,
  })),
);

export const SOUTH_KOREA_2025_CANDIDATE = deepFreeze({
  id: 'kr-national-2025-employment-working-papers',
  version: SOUTH_KOREA_2025_VERSION,
  enabled: false,
  registryEligible: false,
  complete: false,
  scope: SOUTH_KOREA_2025_SCOPE,
  coverage:
    'National KRW working papers for a domestic resident with only ordinary employment income in 2025. Supports annual salary less reviewed non-taxable pay, Article 47 earned-income deduction, basic personal deduction count, public pension and mandatory insurance deductions, 2025 progressive income tax, earned-income tax credit, conditional standard tax credit, and reviewed withholding settlement.',
  references: SOUTH_KOREA_2025_SOURCES,
  rules: SOUTH_KOREA_2025_RULES,
  roundingPolicy:
    'exact-rational-intermediates-with-whole-won-truncation-and-positive-sub-1000-noncollection-v1',
  publicationEvidence: SOUTH_KOREA_2025_PUBLICATION_EVIDENCE,
  requiredFacts: SOUTH_KOREA_2025_REQUIRED_FACTS,
  releaseBlockers: [
    'complete-national-year-end-form-field-and-attachment-inventory-not-validated',
    'local-authority-subdivision-return-and-payment-proof-not-implemented',
    'combined-income-loss-and-special-schedules-not-implemented',
    'special-deductions-credits-reliefs-and-carryovers-not-implemented',
    'independent-complete-return-validation-and-filing-certification-not-complete',
  ],
});

export const SOUTH_KOREA_2025_QUESTIONS = deepFreeze([
  ...SOUTH_KOREA_2025_GUARDS.map(({ key, type, label, locator, expected }) => ({
    key,
    type,
    label,
    locator,
    expected,
    required: true,
  })),
  ...SOUTH_KOREA_2025_MONEY_FACTS.map(({ key, type, label }) => ({
    key,
    type,
    label,
    locator:
      'NTS withholding receipt, income-and-deduction statement or reviewed ledger evidence',
    required: true,
  })),
]);

export type SouthKorea2025Line = {
  readonly key: string;
  readonly ruleId: string;
  readonly exactNumerator: string;
  readonly exactDenominator: string;
  readonly exactAmount: string;
  readonly reportableAmount: string;
  readonly reportedWon: string;
  readonly dependsOn: readonly string[];
  readonly sourceFactKeys: readonly string[];
  readonly referenceIds: readonly string[];
};

export type SouthKorea2025EmploymentResult = {
  candidate: typeof SOUTH_KOREA_2025_CANDIDATE;
  complete: false;
  status: 'calculated' | 'blocked-input';
  currency: 'KRW';
  scope: SouthKorea2025EmploymentInput['scope'] | null;
  inputs: SouthKorea2025EmploymentInput | null;
  lines: readonly SouthKorea2025Line[];
  values: Readonly<Record<string, string>>;
  exactAmounts: Readonly<Record<string, ReturnType<typeof serialize>>>;
  trace: readonly SouthKorea2025Line[];
  sources: typeof SOUTH_KOREA_2025_SOURCES;
  releaseBlockerIds: readonly string[];
  issues: readonly Issue[];
};

const ruleByKey = new Map(RULE_DEFINITIONS.map((rule) => [rule.key, rule]));

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

function pushIssue(
  issues: Issue[],
  code: string,
  path: string,
  message: string,
) {
  issues.push({ code, path, message });
}

function customInputIssues(input: SouthKorea2025EmploymentInput): Issue[] {
  const issues: Issue[] = [];
  if (
    !input.domesticResident ||
    input.hasCrossBorderActivity ||
    !input.onlyOrdinaryEmploymentIncome ||
    input.hasBusinessIncome ||
    input.hasInvestmentIncome ||
    input.hasPensionIncome ||
    input.hasOtherGlobalIncome ||
    input.hasDailyEmploymentIncome ||
    input.hasForeignSourceIncome ||
    input.hasRetirementIncome ||
    input.usesForeignWorkerFlatTax ||
    input.hasTaxReductionOrExemption
  )
    pushIssue(
      issues,
      'unsupported-scope',
      'scope',
      'Only a domestic resident with ordinary employment income and no other income, cross-border activity, flat-rate election or reduction is supported.',
    );

  const gross = decimal(input.annualGrossEmploymentIncome);
  const nonTaxable = decimal(input.annualNonTaxableEmploymentIncome);
  if (!lte(nonTaxable, gross))
    pushIssue(
      issues,
      'invalid-income',
      'annualNonTaxableEmploymentIncome',
      'Non-taxable employment income cannot exceed annual employment income.',
    );

  const unsupportedAmounts: readonly [
    keyof SouthKorea2025EmploymentInput,
    string,
  ][] = [
    [
      'otherIncomeDeductions',
      'Other income deductions are outside this bounded slice.',
    ],
    ['otherTaxCredits', 'Other tax credits are outside this bounded slice.'],
    [
      'monthlyRentTaxCredit',
      'The monthly-rent tax credit is outside this bounded slice.',
    ],
    [
      'incomeTaxReduction',
      'Income-tax reductions and exemptions are outside this bounded slice.',
    ],
  ];
  for (const [key, message] of unsupportedAmounts)
    if (decimal(String(input[key])).n !== 0n)
      pushIssue(issues, 'unsupported-feature', String(key), message);
  return issues;
}

function directFactForLine(key: string): string[] {
  switch (key) {
    case 'employment.annualGrossIncome':
      return ['income.annualGrossEmploymentIncome'];
    case 'employment.nonTaxableIncome':
      return ['income.annualNonTaxableEmploymentIncome'];
    case 'deduction.basicPersonal':
      return ['deduction.basicDeductionCount'];
    case 'deduction.nationalPension':
      return ['deduction.nationalPensionContribution'];
    case 'deduction.healthInsurance':
      return ['deduction.healthInsuranceContribution'];
    case 'deduction.otherIncomeDeductions':
      return ['deduction.otherIncomeDeductions'];
    case 'credit.otherTaxCredits':
      return ['credit.otherTaxCredits'];
    case 'credit.monthlyRentTaxCredit':
      return ['credit.monthlyRentTaxCredit'];
    case 'credit.incomeTaxReduction':
      return ['credit.incomeTaxReduction'];
    case 'withholding.incomeTax':
      return ['withholding.incomeTax'];
    default:
      return [];
  }
}

/**
 * Calculate the supported chain after strict input validation.  Report lines
 * carry both the exact rational and the NTS whole-won display value.
 */
function calculateParsed(
  input: SouthKorea2025EmploymentInput,
): SouthKorea2025EmploymentResult {
  const issues = customInputIssues(input);
  const lines: SouthKorea2025Line[] = [];
  const values = new Map<string, Q>();
  const origins = new Map<string, string[]>();
  const add = (
    key: string,
    value: Q,
    dependsOn: string[] = [],
    directFacts: string[] = [],
  ) => {
    const rule = ruleByKey.get(key);
    if (!rule) throw new Error(`missing-rule:${key}`);
    const sourceFactKeys = [
      ...new Set([
        ...directFacts,
        ...dependsOn.flatMap((dependency) => origins.get(dependency) ?? []),
      ]),
    ].sort();
    const reportable =
      key === 'settlement.balanceDueOrRefund' &&
      value.n > 0n &&
      lt(value, SOUTH_KOREA_2025_SMALL_COLLECTION_THRESHOLD)
        ? '0'
        : truncateTowardZero(value).toString();
    const serialized = serialize(value);
    const line = {
      key,
      ruleId: `kr2025.${key}`,
      exactNumerator: value.n.toString(),
      exactDenominator: value.d.toString(),
      exactAmount: exactDecimal(value),
      reportableAmount: reportable,
      reportedWon: reportable,
      dependsOn: [...dependsOn],
      sourceFactKeys,
      referenceIds: [...rule.referenceIds],
    };
    lines.push(line);
    values.set(key, value);
    origins.set(key, sourceFactKeys);
    return serialized;
  };
  const from = (key: string, value: string, factKey: string): Q => {
    const amount = decimal(value);
    add(key, amount, [], [factKey]);
    return amount;
  };
  const put = (key: string, value: Q, dependsOn: string[] = []) => {
    add(key, value, dependsOn, directFactForLine(key));
    return value;
  };

  if (!issues.length) {
    const gross = from(
      'employment.annualGrossIncome',
      input.annualGrossEmploymentIncome,
      'income.annualGrossEmploymentIncome',
    );
    const nonTaxable = from(
      'employment.nonTaxableIncome',
      input.annualNonTaxableEmploymentIncome,
      'income.annualNonTaxableEmploymentIncome',
    );
    const totalSalary = put(
      'employment.totalSalary',
      minus(gross, nonTaxable),
      ['employment.annualGrossIncome', 'employment.nonTaxableIncome'],
    );
    const earnedDeductionCalculation =
      southKorea2025EarnedIncomeDeduction(totalSalary);
    const earnedDeduction = put(
      'employment.earnedIncomeDeduction',
      earnedDeductionCalculation.amount,
      ['employment.totalSalary'],
    );
    const earnedIncome = put(
      'employment.earnedIncome',
      minus(totalSalary, earnedDeduction),
      ['employment.totalSalary', 'employment.earnedIncomeDeduction'],
    );
    const basicCount = decimal(input.basicDeductionCount);
    const basicPersonal = put(
      'deduction.basicPersonal',
      times(SOUTH_KOREA_2025_BASIC_PERSONAL_DEDUCTION, basicCount.n),
      [],
    );
    const nationalPension = from(
      'deduction.nationalPension',
      input.nationalPensionContribution,
      'deduction.nationalPensionContribution',
    );
    const health = from(
      'deduction.healthInsurance',
      input.healthInsuranceContribution,
      'deduction.healthInsuranceContribution',
    );
    const employmentInsurance = from(
      'deduction.employmentInsurance',
      input.employmentInsuranceContribution,
      'deduction.employmentInsuranceContribution',
    );
    const longTermCare = from(
      'deduction.longTermCareInsurance',
      input.longTermCareInsuranceContribution,
      'deduction.longTermCareInsuranceContribution',
    );
    const specialInsurance = put(
      'deduction.specialInsurance',
      plus(health, employmentInsurance, longTermCare),
      [
        'deduction.healthInsurance',
        'deduction.employmentInsurance',
        'deduction.longTermCareInsurance',
      ],
    );
    const otherIncomeDeductions = from(
      'deduction.otherIncomeDeductions',
      input.otherIncomeDeductions,
      'deduction.otherIncomeDeductions',
    );
    const taxBase = put(
      'tax.taxBase',
      positive(
        minus(
          earnedIncome,
          plus(
            basicPersonal,
            nationalPension,
            specialInsurance,
            otherIncomeDeductions,
          ),
        ),
      ),
      [
        'employment.earnedIncome',
        'deduction.basicPersonal',
        'deduction.nationalPension',
        'deduction.specialInsurance',
        'deduction.otherIncomeDeductions',
      ],
    );
    const calculatedTaxCalculation = southKorea2025IncomeTax(taxBase);
    const calculatedTax = put(
      'tax.calculatedTax',
      calculatedTaxCalculation.amount,
      ['tax.taxBase'],
    );
    const earnedTaxCreditCalculation = southKorea2025EarnedIncomeTaxCredit(
      totalSalary,
      calculatedTax,
    );
    const earnedTaxCredit = put(
      'credit.earnedIncomeTaxCredit',
      earnedTaxCreditCalculation.amount,
      ['employment.totalSalary', 'tax.calculatedTax'],
    );
    const otherTaxCredits = from(
      'credit.otherTaxCredits',
      input.otherTaxCredits,
      'credit.otherTaxCredits',
    );
    const monthlyRentTaxCredit = from(
      'credit.monthlyRentTaxCredit',
      input.monthlyRentTaxCredit,
      'credit.monthlyRentTaxCredit',
    );
    const incomeTaxReduction = from(
      'credit.incomeTaxReduction',
      input.incomeTaxReduction,
      'credit.incomeTaxReduction',
    );
    const standardTaxCredit = put(
      'credit.standardTaxCredit',
      specialInsurance.n === 0n ? SOUTH_KOREA_2025_STANDARD_TAX_CREDIT : q(0n),
      ['deduction.specialInsurance'],
    );
    const taxAfterReduction = put(
      'tax.taxAfterReduction',
      positive(minus(calculatedTax, incomeTaxReduction)),
      ['tax.calculatedTax', 'credit.incomeTaxReduction'],
    );
    const totalTaxCredits = put(
      'credit.totalTaxCredits',
      plus(
        earnedTaxCredit,
        standardTaxCredit,
        otherTaxCredits,
        monthlyRentTaxCredit,
      ),
      [
        'credit.earnedIncomeTaxCredit',
        'credit.standardTaxCredit',
        'credit.otherTaxCredits',
        'credit.monthlyRentTaxCredit',
      ],
    );
    const determinedTax = put(
      'tax.determinedTax',
      positive(minus(taxAfterReduction, totalTaxCredits)),
      ['tax.taxAfterReduction', 'credit.totalTaxCredits'],
    );
    const withholding = from(
      'withholding.incomeTax',
      input.withheldIncomeTax,
      'withholding.incomeTax',
    );
    put('settlement.balanceDueOrRefund', minus(determinedTax, withholding), [
      'tax.determinedTax',
      'withholding.incomeTax',
    ]);
  }

  const lineValues = Object.fromEntries(
    lines.map((line) => [line.key, line.reportedWon]),
  );
  const exactAmounts = Object.fromEntries(
    lines.map((line) => [
      line.key,
      {
        numerator: line.exactNumerator,
        denominator: line.exactDenominator,
        exactDecimal: line.exactAmount,
      },
    ]),
  );
  // Ensure the graph's internal map is consumed so an accidental unused line
  // cannot silently change the emitted report shape.
  if (values.size !== lines.length)
    throw new Error('south-korea-line-graph-inconsistent');

  return deepFreeze({
    candidate: SOUTH_KOREA_2025_CANDIDATE,
    complete: false as const,
    status: issues.length
      ? ('blocked-input' as const)
      : ('calculated' as const),
    currency: 'KRW' as const,
    scope: input.scope,
    inputs: input,
    lines,
    values: lineValues,
    exactAmounts,
    trace: lines,
    sources: SOUTH_KOREA_2025_SOURCES,
    releaseBlockerIds: SOUTH_KOREA_2025_CANDIDATE.releaseBlockers,
    issues,
  });
}

/** Independent arithmetic entry point; it never authorizes a filing. */
export function calculateSouthKorea2025Employment(
  raw: unknown,
): SouthKorea2025EmploymentResult {
  const parsed = SouthKorea2025EmploymentInputSchema.safeParse(raw);
  if (!parsed.success)
    return deepFreeze({
      candidate: SOUTH_KOREA_2025_CANDIDATE,
      complete: false as const,
      status: 'blocked-input' as const,
      currency: 'KRW' as const,
      scope: null,
      inputs: null,
      lines: [],
      values: {},
      exactAmounts: {},
      trace: [],
      sources: SOUTH_KOREA_2025_SOURCES,
      releaseBlockerIds: SOUTH_KOREA_2025_CANDIDATE.releaseBlockers,
      issues: [
        {
          code: 'invalid-input',
          path: 'input',
          message: 'Strict South Korea 2025 employment input is invalid.',
        },
      ],
    });
  return calculateParsed(parsed.data);
}

export type SouthKorea2025Assessment = {
  intake: FinanceTaxIntake | null;
  issues: readonly Issue[];
};

/** Validate the generic reviewed-fact envelope before mapping it to arithmetic. */
export function assessSouthKorea2025EmploymentFacts(
  raw: unknown,
): SouthKorea2025Assessment {
  const parsed = FinanceTaxIntakeSchema.safeParse(raw);
  if (!parsed.success)
    return {
      intake: null,
      issues: [
        {
          code: 'invalid-intake',
          path: 'intake',
          message: 'Generic tax intake or source lineage is invalid.',
        },
      ],
    };
  const intake = parsed.data;
  const issues: Issue[] = [];
  if (canonical(intake.scope) !== canonical(SOUTH_KOREA_2025_SCOPE))
    pushIssue(
      issues,
      'unsupported-scope',
      'scope',
      'Requires the exact KR-NATIONAL 2025 individual NTS-YEAREND scope.',
    );
  if (
    intake.domesticResident !== true ||
    intake.hasCrossBorderActivity !== false ||
    intake.requestedFeatures.length !== 1 ||
    intake.requestedFeatures[0] !== 'income-tax-return'
  )
    pushIssue(
      issues,
      'unsupported-scope',
      'intake',
      'Only a domestic income-tax-return review is supported.',
    );

  const facts = new Map(intake.facts.map((fact) => [fact.key, fact]));
  const allowed = new Set<string>(
    SOUTH_KOREA_2025_REQUIRED_FACTS.map(({ key }) => key),
  );
  for (const fact of intake.facts)
    if (!allowed.has(fact.key))
      pushIssue(
        issues,
        'unsupported-fact',
        fact.key,
        'Unknown reviewed facts cannot be silently omitted from this package.',
      );

  for (const required of SOUTH_KOREA_2025_REQUIRED_FACTS) {
    const fact = facts.get(required.key);
    if (!fact) {
      pushIssue(
        issues,
        'missing-fact',
        required.key,
        'Every required reviewed fact must be supplied; zero cannot be inferred.',
      );
      continue;
    }
    if (fact.reviewState !== 'reviewed')
      pushIssue(
        issues,
        'unreviewed-fact',
        required.key,
        'Only reviewed, undisputed facts may drive this calculation.',
      );
    if (fact.value.type !== required.type) {
      pushIssue(
        issues,
        'wrong-fact-type',
        required.key,
        `Expected a ${required.type} fact.`,
      );
      continue;
    }
    if (required.type === 'decimal' && fact.value.type === 'decimal') {
      if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(fact.value.value))
        pushIssue(
          issues,
          'invalid-money',
          required.key,
          'This bounded ordinary-employment package accepts nonnegative decimal KRW amounts only.',
        );
    }
  }
  for (const guard of SOUTH_KOREA_2025_GUARDS) {
    const value = facts.get(guard.key)?.value;
    if (value?.type === 'boolean' && value.value !== guard.expected)
      pushIssue(
        issues,
        'unsupported-feature',
        guard.key,
        `${guard.label} is required for this bounded package.`,
      );
  }
  return { intake, issues };
}

function customFromIntake(
  intake: FinanceTaxIntake,
): SouthKorea2025EmploymentInput {
  const values = new Map(intake.facts.map((fact) => [fact.key, fact.value]));
  const boolean = (key: string) => {
    const value = values.get(key);
    if (!value || value.type !== 'boolean')
      throw new Error(`missing-boolean:${key}`);
    return value.value;
  };
  const decimalValue = (key: string) => {
    const value = values.get(key);
    if (!value || value.type !== 'decimal')
      throw new Error(`missing-decimal:${key}`);
    return value.value;
  };
  return SouthKorea2025EmploymentInputSchema.parse({
    schemaVersion: 1,
    scope: SOUTH_KOREA_2025_SCOPE,
    domesticResident: intake.domesticResident,
    hasCrossBorderActivity: intake.hasCrossBorderActivity,
    onlyOrdinaryEmploymentIncome: boolean('case.onlyOrdinaryEmploymentIncome'),
    hasBusinessIncome: boolean('case.hasBusinessIncome'),
    hasInvestmentIncome: boolean('case.hasInvestmentIncome'),
    hasPensionIncome: boolean('case.hasPensionIncome'),
    hasOtherGlobalIncome: boolean('case.hasOtherGlobalIncome'),
    hasDailyEmploymentIncome: boolean('case.hasDailyEmploymentIncome'),
    hasForeignSourceIncome: boolean('case.hasForeignSourceIncome'),
    hasRetirementIncome: boolean('case.hasRetirementIncome'),
    usesForeignWorkerFlatTax: boolean('case.usesForeignWorkerFlatTax'),
    hasTaxReductionOrExemption: boolean('case.hasTaxReductionOrExemption'),
    annualGrossEmploymentIncome: decimalValue(
      'income.annualGrossEmploymentIncome',
    ),
    annualNonTaxableEmploymentIncome: decimalValue(
      'income.annualNonTaxableEmploymentIncome',
    ),
    basicDeductionCount: decimalValue('deduction.basicDeductionCount'),
    nationalPensionContribution: decimalValue(
      'deduction.nationalPensionContribution',
    ),
    healthInsuranceContribution: decimalValue(
      'deduction.healthInsuranceContribution',
    ),
    employmentInsuranceContribution: decimalValue(
      'deduction.employmentInsuranceContribution',
    ),
    longTermCareInsuranceContribution: decimalValue(
      'deduction.longTermCareInsuranceContribution',
    ),
    otherIncomeDeductions: decimalValue('deduction.otherIncomeDeductions'),
    otherTaxCredits: decimalValue('credit.otherTaxCredits'),
    monthlyRentTaxCredit: decimalValue('credit.monthlyRentTaxCredit'),
    incomeTaxReduction: decimalValue('credit.incomeTaxReduction'),
    withheldIncomeTax: decimalValue('withholding.incomeTax'),
  });
}

function evaluationFor(
  intake: FinanceTaxIntake | null,
  assessmentIssues: readonly Issue[],
  calculation: SouthKorea2025EmploymentResult | null,
) {
  const forms: FinanceTaxEvaluation['forms'] = calculation?.lines.length
    ? [
        {
          id: 'KR-YEAREND-2025',
          version: '2025',
          fields: calculation.lines.map((line) => ({
            key: line.key,
            value: { type: 'decimal' as const, value: line.reportedWon },
            ruleIds: [line.ruleId],
            sourceFactKeys: [...line.sourceFactKeys],
          })),
        },
      ]
    : [];
  const inputIssues: EvaluationIssue[] = assessmentIssues.map((issue) => ({
    code: issue.code,
    message: `${issue.path}: ${issue.message}`,
  }));
  if (calculation)
    for (const issue of calculation.issues)
      inputIssues.push({
        code: issue.code,
        message: `${issue.path}: ${issue.message}`,
      });
  if (calculation?.lines.length)
    for (const blocker of SOUTH_KOREA_2025_CANDIDATE.releaseBlockers)
      inputIssues.push({
        code: blocker,
        message: blocker.replaceAll('-', ' '),
      });
  const evaluation = FinanceTaxEvaluationSchema.parse({
    forms,
    issues: inputIssues,
  });
  const trace = calculation?.trace ?? [];
  return deepFreeze({
    candidate: SOUTH_KOREA_2025_CANDIDATE,
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
    fieldCoverage: {
      supportedLineKeys: calculation?.lines.map((line) => line.key) ?? [],
      unresolved: SOUTH_KOREA_2025_CANDIDATE.releaseBlockers,
    },
    outputHash: hash({ evaluation, trace }),
    definitionHash: hash(SOUTH_KOREA_2025_CANDIDATE),
  });
}

/**
 * Generic application-facing candidate evaluator.  It remains deliberately
 * incomplete and does not register or activate a full-return package.
 */
export function evaluateSouthKorea2025WorkingPapers(raw: unknown) {
  const assessment = assessSouthKorea2025EmploymentFacts(raw);
  if (!assessment.intake) return evaluationFor(null, assessment.issues, null);
  if (assessment.issues.length)
    return evaluationFor(assessment.intake, assessment.issues, null);
  try {
    const calculation = calculateParsed(customFromIntake(assessment.intake));
    return evaluationFor(assessment.intake, [], calculation);
  } catch {
    return evaluationFor(
      assessment.intake,
      [
        {
          code: 'invalid-mapped-input',
          path: 'facts',
          message:
            'Reviewed facts could not be mapped to the strict employment input.',
        },
      ],
      null,
    );
  }
}

// Explicit aliases make the bounded package easy to discover without implying
// that it is the shared country registry or a filing-capable implementation.
export const calculateSouthKorea2025 = calculateSouthKorea2025Employment;
export const evaluateSouthKorea2025 = evaluateSouthKorea2025WorkingPapers;

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  deepFreeze,
  FinanceTaxFactSchema,
  FinanceTaxIntakeSchema,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import {
  decimal,
  exactDecimal,
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
  reportSouthKorea2025LocalIncomeTax,
  southKorea2025LocalIncomeTax,
} from './local.js';
import {
  southKorea2025CorporateIncomeTax,
  southKorea2025IncomeTax,
  SOUTH_KOREA_2025_GLOBAL_STANDARD_TAX_CREDIT,
  SOUTH_KOREA_2025_BASIC_PERSONAL_DEDUCTION,
} from './tables.js';
import { SOUTH_KOREA_2025_SOURCES } from './sources.js';

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

export const SOUTH_KOREA_2025_SOLE_PROPRIETOR_VERSION =
  '2025.1-national-sole-proprietor-working-papers.1';
export const SOUTH_KOREA_2025_CORPORATION_VERSION =
  '2025.1-national-corporation-working-papers.1';

export const SOUTH_KOREA_2025_SOLE_PROPRIETOR_SCOPE = deepFreeze({
  country: 'KR',
  subdivision: 'KR-NATIONAL',
  taxpayerType: 'sole-proprietor',
  year: 2025,
  regime: 'income-tax-return',
  formVersion: 'NTS-GLOBAL-40-1-2025',
} as const);

export const SOUTH_KOREA_2025_CORPORATION_SCOPE = deepFreeze({
  country: 'KR',
  subdivision: 'KR-NATIONAL',
  taxpayerType: 'corporation',
  year: 2025,
  regime: 'corporate-income-tax-return',
  formVersion: 'NTS-CORPORATE-1-2025',
} as const);

/**
 * Ordinary ledger-supported business income only.  The simplified
 * expense-rate form is inventoried, but this branch requires explicit
 * reviewed expenses and therefore never infers an industry rate.
 */
export const SouthKorea2025SoleProprietorInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.strictObject({
    country: z.literal('KR'),
    subdivision: z.literal('KR-NATIONAL'),
    taxpayerType: z.literal('sole-proprietor'),
    year: z.literal(2025),
    regime: z.literal('income-tax-return'),
    formVersion: z.literal('NTS-GLOBAL-40-1-2025'),
  }),
  domesticResident: z.boolean(),
  hasCrossBorderActivity: z.boolean(),
  onlyOrdinaryBusinessIncome: z.boolean(),
  hasEmploymentIncome: z.boolean(),
  hasInvestmentIncome: z.boolean(),
  hasPensionIncome: z.boolean(),
  hasOtherGlobalIncome: z.boolean(),
  hasDailyEmploymentIncome: z.boolean(),
  hasForeignSourceIncome: z.boolean(),
  hasRetirementIncome: z.boolean(),
  usesSimplifiedExpenseRate: z.boolean(),
  hasBusinessLoss: z.boolean(),
  isCompliantFilingBusiness: z.boolean(),
  hasTaxReductionOrExemption: z.boolean(),
  annualGrossBusinessRevenue: NonnegativeDecimal,
  returnsAndAllowances: NonnegativeDecimal,
  necessaryBusinessExpenses: NonnegativeDecimal,
  basicDeductionCount: PositiveCount,
  nationalPensionContribution: NonnegativeDecimal,
  otherIncomeDeductions: NonnegativeDecimal,
  otherTaxCredits: NonnegativeDecimal,
  incomeTaxReduction: NonnegativeDecimal,
  prepaidIncomeTax: NonnegativeDecimal,
});
export type SouthKorea2025SoleProprietorInput = z.infer<
  typeof SouthKorea2025SoleProprietorInputSchema
>;

/**
 * Standalone domestic profit-making corporation.  Accounting profit is
 * intentionally limited to ordinary revenue less returns and reviewed
 * deductible expenses; every tax-adjustment schedule is an explicit guard.
 */
export const SouthKorea2025CorporationInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.strictObject({
    country: z.literal('KR'),
    subdivision: z.literal('KR-NATIONAL'),
    taxpayerType: z.literal('corporation'),
    year: z.literal(2025),
    regime: z.literal('corporate-income-tax-return'),
    formVersion: z.literal('NTS-CORPORATE-1-2025'),
  }),
  domesticCorporation: z.boolean(),
  hasCrossBorderActivity: z.boolean(),
  standaloneCorporation: z.boolean(),
  consolidatedGroup: z.boolean(),
  hasBranchOutsideKorea: z.boolean(),
  hasTaxAdjustments: z.boolean(),
  hasCarriedForwardLosses: z.boolean(),
  hasNonTaxableIncome: z.boolean(),
  hasIncomeDeductions: z.boolean(),
  hasTaxCredits: z.boolean(),
  hasTaxReductionOrExemption: z.boolean(),
  hasPenaltiesOrAdditionalTax: z.boolean(),
  hasCapitalGains: z.boolean(),
  hasInvestmentIncome: z.boolean(),
  hasRealEstateIncome: z.boolean(),
  hasForeignSourceIncome: z.boolean(),
  annualGrossRevenue: NonnegativeDecimal,
  returnsAndAllowances: NonnegativeDecimal,
  deductibleBusinessExpenses: NonnegativeDecimal,
  prepaidCorporateTax: NonnegativeDecimal,
});
export type SouthKorea2025CorporationInput = z.infer<
  typeof SouthKorea2025CorporationInputSchema
>;

export type SouthKorea2025BusinessIssue = {
  code: string;
  path: string;
  message: string;
};
export type SouthKorea2025BusinessLine = {
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

type BusinessCandidate = {
  readonly id: string;
  readonly version: string;
  readonly enabled: false;
  readonly registryEligible: false;
  readonly complete: false;
  readonly scope: typeof SOUTH_KOREA_2025_SOLE_PROPRIETOR_SCOPE;
  readonly references: typeof SOUTH_KOREA_2025_SOURCES;
  readonly releaseBlockers: readonly string[];
};

type CorporationCandidate = {
  readonly id: string;
  readonly version: string;
  readonly enabled: false;
  readonly registryEligible: false;
  readonly complete: false;
  readonly scope: typeof SOUTH_KOREA_2025_CORPORATION_SCOPE;
  readonly references: typeof SOUTH_KOREA_2025_SOURCES;
  readonly releaseBlockers: readonly string[];
};

export const SOUTH_KOREA_2025_SOLE_PROPRIETOR_RELEASE_BLOCKERS = deepFreeze([
  'global-income-form40-field-and-attachment-completeness-not-validated',
  'simplified-expense-rate-and-industry-classification-not-implemented',
  'combined-income-loss-and-carryforward-schedules-not-implemented',
  'local-authority-return-and-payment-proof-not-implemented',
  'filing-submission-and-independent-complete-return-validation-not-complete',
] as const);

export const SOUTH_KOREA_2025_CORPORATION_RELEASE_BLOCKERS = deepFreeze([
  'corporate-form1-and-tax-adjustment-schedule-completeness-not-validated',
  'corporate-special-rates-credits-reliefs-and-carryforwards-not-implemented',
  'corporate-local-authority-return-and-payment-proof-not-implemented',
  'standalone-corporation-financial-statement-reconciliation-not-complete',
  'filing-submission-and-independent-complete-return-validation-not-complete',
] as const);

export const SOUTH_KOREA_2025_SOLE_PROPRIETOR_CANDIDATE = deepFreeze({
  id: 'kr-national-2025-sole-proprietor-working-papers',
  version: SOUTH_KOREA_2025_SOLE_PROPRIETOR_VERSION,
  enabled: false,
  registryEligible: false,
  complete: false,
  scope: SOUTH_KOREA_2025_SOLE_PROPRIETOR_SCOPE,
  references: SOUTH_KOREA_2025_SOURCES,
  coverage:
    'Ordinary domestic resident sole-proprietor Form 40(1) working papers using reviewed ledger revenue, returns and expenses, the national progressive rate table, basic personal deduction, public-pension deduction, 70,000-won standard credit and local-income-tax arithmetic. No simplified-rate, combined-income, special schedule, local filing or submission branch.',
  releaseBlockers: SOUTH_KOREA_2025_SOLE_PROPRIETOR_RELEASE_BLOCKERS,
} as const satisfies Omit<BusinessCandidate, 'scope'> & {
  readonly scope: typeof SOUTH_KOREA_2025_SOLE_PROPRIETOR_SCOPE;
  readonly coverage: string;
});

export const SOUTH_KOREA_2025_CORPORATION_CANDIDATE = deepFreeze({
  id: 'kr-national-2025-standalone-corporation-working-papers',
  version: SOUTH_KOREA_2025_CORPORATION_VERSION,
  enabled: false,
  registryEligible: false,
  complete: false,
  scope: SOUTH_KOREA_2025_CORPORATION_SCOPE,
  references: SOUTH_KOREA_2025_SOURCES,
  coverage:
    'Standalone domestic profit-making corporation Form 1 working papers using reviewed ordinary revenue, returns and deductible expenses, the published 2025 9/19/21/24 percent corporate rate table and 10 percent local-income-tax arithmetic. Tax adjustments, losses, non-taxable income, deductions, credits, reliefs, penalties, local filing and submission are guarded out.',
  releaseBlockers: SOUTH_KOREA_2025_CORPORATION_RELEASE_BLOCKERS,
} as const satisfies Omit<CorporationCandidate, 'scope'> & {
  readonly scope: typeof SOUTH_KOREA_2025_CORPORATION_SCOPE;
  readonly coverage: string;
});

type Rule = {
  readonly key: string;
  readonly referenceIds: readonly string[];
};

const globalRule = (key: string): Rule => ({
  key,
  referenceIds: ['nts-kr-2025-global-income-guide'],
});
const localRule = (key: string): Rule => ({
  key,
  referenceIds: ['nts-kr-2025-local-income-tax-guide'],
});
const corporateRule = (key: string): Rule => ({
  key,
  referenceIds: ['nts-kr-2025-corporate-income-overview'],
});

const SOLE_RULES: readonly Rule[] = [
  globalRule('business.grossRevenue'),
  globalRule('business.returnsAndAllowances'),
  globalRule('business.netRevenue'),
  globalRule('business.necessaryBusinessExpenses'),
  globalRule('business.netIncome'),
  globalRule('business.globalIncome'),
  globalRule('deduction.basicPersonal'),
  globalRule('deduction.nationalPension'),
  globalRule('deduction.otherIncomeDeductions'),
  globalRule('business.taxBase'),
  globalRule('business.calculatedTax'),
  globalRule('credit.standardTaxCredit'),
  globalRule('credit.otherTaxCredits'),
  globalRule('credit.incomeTaxReduction'),
  globalRule('tax.taxAfterReduction'),
  globalRule('credit.totalTaxCredits'),
  globalRule('business.determinedTax'),
  globalRule('business.prepaidIncomeTax'),
  globalRule('business.balanceDueOrRefund'),
  localRule('business.localIncomeTax'),
];

const CORPORATE_RULES: readonly Rule[] = [
  corporateRule('corporate.grossRevenue'),
  corporateRule('corporate.returnsAndAllowances'),
  corporateRule('corporate.netRevenue'),
  corporateRule('corporate.deductibleBusinessExpenses'),
  corporateRule('corporate.accountingProfit'),
  corporateRule('corporate.taxBase'),
  corporateRule('corporate.calculatedTax'),
  corporateRule('corporate.taxCredits'),
  corporateRule('corporate.taxReduction'),
  corporateRule('corporate.taxAfterReduction'),
  corporateRule('corporate.prepaidCorporateTax'),
  corporateRule('corporate.balanceDueOrRefund'),
  localRule('corporate.localIncomeTax'),
];

const soleRuleByKey = new Map(SOLE_RULES.map((rule) => [rule.key, rule]));
const corporateRuleByKey = new Map(
  CORPORATE_RULES.map((rule) => [rule.key, rule]),
);

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

function addBusinessLine(
  lines: SouthKorea2025BusinessLine[],
  origins: Map<string, string[]>,
  ruleByKey: ReadonlyMap<string, Rule>,
  key: string,
  value: Q,
  dependsOn: readonly string[] = [],
  directFactKeys: readonly string[] = [],
): Q {
  const rule = ruleByKey.get(key);
  if (!rule) throw new Error(`missing-south-korea-business-rule:${key}`);
  const sourceFactKeys = [
    ...new Set([
      ...directFactKeys,
      ...dependsOn.flatMap((dependency) => origins.get(dependency) ?? []),
    ]),
  ].sort();
  const reportable = truncateTowardZero(value).toString();
  lines.push({
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
  });
  origins.set(key, sourceFactKeys);
  return value;
}

function issue(
  issues: SouthKorea2025BusinessIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function soleInputIssues(
  input: SouthKorea2025SoleProprietorInput,
): SouthKorea2025BusinessIssue[] {
  const issues: SouthKorea2025BusinessIssue[] = [];
  if (
    !input.domesticResident ||
    input.hasCrossBorderActivity ||
    !input.onlyOrdinaryBusinessIncome ||
    input.hasEmploymentIncome ||
    input.hasInvestmentIncome ||
    input.hasPensionIncome ||
    input.hasOtherGlobalIncome ||
    input.hasDailyEmploymentIncome ||
    input.hasForeignSourceIncome ||
    input.hasRetirementIncome ||
    input.usesSimplifiedExpenseRate ||
    input.hasBusinessLoss ||
    input.isCompliantFilingBusiness ||
    input.hasTaxReductionOrExemption
  )
    issue(
      issues,
      'unsupported-scope',
      'scope',
      'Only a domestic resident sole proprietor with ordinary ledger-supported business income, no other income, no simplified expense-rate election and no special relief is supported.',
    );
  const gross = decimal(input.annualGrossBusinessRevenue);
  const returns = decimal(input.returnsAndAllowances);
  const expenses = decimal(input.necessaryBusinessExpenses);
  for (const [key, amount] of [
    ['annualGrossBusinessRevenue', gross],
    ['returnsAndAllowances', returns],
    ['necessaryBusinessExpenses', expenses],
    ['nationalPensionContribution', decimal(input.nationalPensionContribution)],
    ['otherIncomeDeductions', decimal(input.otherIncomeDeductions)],
    ['otherTaxCredits', decimal(input.otherTaxCredits)],
    ['incomeTaxReduction', decimal(input.incomeTaxReduction)],
    ['prepaidIncomeTax', decimal(input.prepaidIncomeTax)],
  ] as const)
    if (amount.n < 0n)
      issue(issues, 'invalid-money', key, 'Amounts must be nonnegative.');
  const netRevenue = minus(gross, returns);
  if (!lte(returns, gross))
    issue(
      issues,
      'invalid-income',
      'returnsAndAllowances',
      'Returns and allowances cannot exceed gross business revenue.',
    );
  if (netRevenue.n < 0n)
    issue(
      issues,
      'invalid-income',
      'annualGrossBusinessRevenue',
      'Gross revenue less returns cannot be negative in this no-loss branch.',
    );
  if (!lte(expenses, positive(netRevenue)))
    issue(
      issues,
      'unsupported-loss',
      'necessaryBusinessExpenses',
      'Business expenses cannot exceed net revenue in this no-loss branch.',
    );
  for (const [key, label] of [
    ['otherIncomeDeductions', 'Other income deductions'],
    ['otherTaxCredits', 'Other tax credits'],
    ['incomeTaxReduction', 'Income-tax reductions and exemptions'],
  ] as const)
    if (decimal(input[key]).n !== 0n)
      issue(
        issues,
        'unsupported-feature',
        key,
        `${label} are outside this branch.`,
      );
  return issues;
}

function corporationInputIssues(
  input: SouthKorea2025CorporationInput,
): SouthKorea2025BusinessIssue[] {
  const issues: SouthKorea2025BusinessIssue[] = [];
  if (
    !input.domesticCorporation ||
    input.hasCrossBorderActivity ||
    !input.standaloneCorporation ||
    input.consolidatedGroup ||
    input.hasBranchOutsideKorea ||
    input.hasTaxAdjustments ||
    input.hasCarriedForwardLosses ||
    input.hasNonTaxableIncome ||
    input.hasIncomeDeductions ||
    input.hasTaxCredits ||
    input.hasTaxReductionOrExemption ||
    input.hasPenaltiesOrAdditionalTax ||
    input.hasCapitalGains ||
    input.hasInvestmentIncome ||
    input.hasRealEstateIncome ||
    input.hasForeignSourceIncome
  )
    issue(
      issues,
      'unsupported-scope',
      'scope',
      'Only a standalone domestic profit-making corporation with ordinary domestic revenue and expenses, no tax adjustments, losses, special income, credits, reliefs or penalties is supported.',
    );
  const gross = decimal(input.annualGrossRevenue);
  const returns = decimal(input.returnsAndAllowances);
  const expenses = decimal(input.deductibleBusinessExpenses);
  for (const [key, amount] of [
    ['annualGrossRevenue', gross],
    ['returnsAndAllowances', returns],
    ['deductibleBusinessExpenses', expenses],
    ['prepaidCorporateTax', decimal(input.prepaidCorporateTax)],
  ] as const)
    if (amount.n < 0n)
      issue(issues, 'invalid-money', key, 'Amounts must be nonnegative.');
  const netRevenue = minus(gross, returns);
  if (!lte(returns, gross))
    issue(
      issues,
      'invalid-income',
      'returnsAndAllowances',
      'Returns and allowances cannot exceed gross revenue.',
    );
  if (!lte(expenses, positive(netRevenue)))
    issue(
      issues,
      'unsupported-loss',
      'deductibleBusinessExpenses',
      'Expenses cannot exceed net revenue in this no-loss branch.',
    );
  return issues;
}

export type SouthKorea2025BusinessResult = {
  readonly candidate: typeof SOUTH_KOREA_2025_SOLE_PROPRIETOR_CANDIDATE;
  readonly complete: false;
  readonly selectedComplete: boolean;
  readonly reportable: false;
  readonly fileable: false;
  readonly filingAuthorized: false;
  readonly status: 'calculated' | 'blocked-input';
  readonly currency: 'KRW';
  readonly scope: SouthKorea2025SoleProprietorInput['scope'] | null;
  readonly inputs: SouthKorea2025SoleProprietorInput | null;
  readonly lines: readonly SouthKorea2025BusinessLine[];
  readonly values: Readonly<Record<string, string>>;
  readonly exactAmounts: Readonly<Record<string, ReturnType<typeof serialize>>>;
  readonly trace: readonly SouthKorea2025BusinessLine[];
  readonly localIncomeTax: ReturnType<
    typeof reportSouthKorea2025LocalIncomeTax
  > | null;
  readonly sources: typeof SOUTH_KOREA_2025_SOURCES;
  readonly releaseBlockerIds: readonly string[];
  readonly issues: readonly SouthKorea2025BusinessIssue[];
  readonly definitionHash: string;
};

export type SouthKorea2025CorporationResult = {
  readonly candidate: typeof SOUTH_KOREA_2025_CORPORATION_CANDIDATE;
  readonly complete: false;
  readonly selectedComplete: boolean;
  readonly reportable: false;
  readonly fileable: false;
  readonly filingAuthorized: false;
  readonly status: 'calculated' | 'blocked-input';
  readonly currency: 'KRW';
  readonly scope: SouthKorea2025CorporationInput['scope'] | null;
  readonly inputs: SouthKorea2025CorporationInput | null;
  readonly lines: readonly SouthKorea2025BusinessLine[];
  readonly values: Readonly<Record<string, string>>;
  readonly exactAmounts: Readonly<Record<string, ReturnType<typeof serialize>>>;
  readonly trace: readonly SouthKorea2025BusinessLine[];
  readonly localIncomeTax: ReturnType<
    typeof reportSouthKorea2025LocalIncomeTax
  > | null;
  readonly sources: typeof SOUTH_KOREA_2025_SOURCES;
  readonly releaseBlockerIds: readonly string[];
  readonly issues: readonly SouthKorea2025BusinessIssue[];
  readonly definitionHash: string;
};

function buildBusinessResult(
  input: SouthKorea2025SoleProprietorInput | null,
  issues: SouthKorea2025BusinessIssue[],
  lines: SouthKorea2025BusinessLine[],
  candidate: typeof SOUTH_KOREA_2025_SOLE_PROPRIETOR_CANDIDATE,
  localIncomeTax: ReturnType<typeof reportSouthKorea2025LocalIncomeTax> | null,
): SouthKorea2025BusinessResult {
  const values = Object.fromEntries(
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
  const body = {
    candidate,
    complete: false as const,
    selectedComplete: Boolean(input && issues.length === 0),
    reportable: false as const,
    fileable: false as const,
    filingAuthorized: false as const,
    status: issues.length
      ? ('blocked-input' as const)
      : ('calculated' as const),
    currency: 'KRW' as const,
    scope: input?.scope ?? null,
    inputs: input,
    lines,
    values,
    exactAmounts,
    trace: lines,
    localIncomeTax,
    sources: SOUTH_KOREA_2025_SOURCES,
    releaseBlockerIds: candidate.releaseBlockers,
    issues,
  };
  return deepFreeze({ ...body, definitionHash: hash(candidate) });
}

function buildCorporationResult(
  input: SouthKorea2025CorporationInput | null,
  issues: SouthKorea2025BusinessIssue[],
  lines: SouthKorea2025BusinessLine[],
  candidate: typeof SOUTH_KOREA_2025_CORPORATION_CANDIDATE,
  localIncomeTax: ReturnType<typeof reportSouthKorea2025LocalIncomeTax> | null,
): SouthKorea2025CorporationResult {
  const values = Object.fromEntries(
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
  const body = {
    candidate,
    complete: false as const,
    selectedComplete: Boolean(input && issues.length === 0),
    reportable: false as const,
    fileable: false as const,
    filingAuthorized: false as const,
    status: issues.length
      ? ('blocked-input' as const)
      : ('calculated' as const),
    currency: 'KRW' as const,
    scope: input?.scope ?? null,
    inputs: input,
    lines,
    values,
    exactAmounts,
    trace: lines,
    localIncomeTax,
    sources: SOUTH_KOREA_2025_SOURCES,
    releaseBlockerIds: candidate.releaseBlockers,
    issues,
  };
  return deepFreeze({ ...body, definitionHash: hash(candidate) });
}

function calculateSoleParsed(
  input: SouthKorea2025SoleProprietorInput,
): SouthKorea2025BusinessResult {
  const issues = soleInputIssues(input);
  const lines: SouthKorea2025BusinessLine[] = [];
  const origins = new Map<string, string[]>();
  const from = (key: string, value: string, factKey: string): Q => {
    const amount = decimal(value);
    addBusinessLine(lines, origins, soleRuleByKey, key, amount, [], [factKey]);
    return amount;
  };
  const put = (
    key: string,
    value: Q,
    dependsOn: readonly string[] = [],
    directFactKeys: readonly string[] = [],
  ): Q => {
    addBusinessLine(
      lines,
      origins,
      soleRuleByKey,
      key,
      value,
      dependsOn,
      directFactKeys,
    );
    return value;
  };
  let localIncomeTax: ReturnType<
    typeof reportSouthKorea2025LocalIncomeTax
  > | null = null;
  if (!issues.length) {
    const gross = from(
      'business.grossRevenue',
      input.annualGrossBusinessRevenue,
      'business.annualGrossBusinessRevenue',
    );
    const returns = from(
      'business.returnsAndAllowances',
      input.returnsAndAllowances,
      'business.returnsAndAllowances',
    );
    const netRevenue = put('business.netRevenue', minus(gross, returns), [
      'business.grossRevenue',
      'business.returnsAndAllowances',
    ]);
    const expenses = from(
      'business.necessaryBusinessExpenses',
      input.necessaryBusinessExpenses,
      'business.necessaryBusinessExpenses',
    );
    const netIncome = put('business.netIncome', minus(netRevenue, expenses), [
      'business.netRevenue',
      'business.necessaryBusinessExpenses',
    ]);
    put('business.globalIncome', netIncome, ['business.netIncome']);
    const basicPersonal = put(
      'deduction.basicPersonal',
      times(
        SOUTH_KOREA_2025_BASIC_PERSONAL_DEDUCTION,
        decimal(input.basicDeductionCount).n,
      ),
      [],
      ['deduction.basicDeductionCount'],
    );
    const nationalPension = from(
      'deduction.nationalPension',
      input.nationalPensionContribution,
      'deduction.nationalPensionContribution',
    );
    const otherDeductions = from(
      'deduction.otherIncomeDeductions',
      input.otherIncomeDeductions,
      'deduction.otherIncomeDeductions',
    );
    const taxBase = put(
      'business.taxBase',
      positive(
        minus(netIncome, plus(basicPersonal, nationalPension, otherDeductions)),
      ),
      [
        'business.netIncome',
        'deduction.basicPersonal',
        'deduction.nationalPension',
        'deduction.otherIncomeDeductions',
      ],
    );
    const calculatedTax = put(
      'business.calculatedTax',
      southKorea2025IncomeTax(taxBase).amount,
      ['business.taxBase'],
    );
    const standardTaxCredit = put(
      'credit.standardTaxCredit',
      SOUTH_KOREA_2025_GLOBAL_STANDARD_TAX_CREDIT,
      [],
    );
    const otherTaxCredits = from(
      'credit.otherTaxCredits',
      input.otherTaxCredits,
      'credit.otherTaxCredits',
    );
    const incomeTaxReduction = from(
      'credit.incomeTaxReduction',
      input.incomeTaxReduction,
      'credit.incomeTaxReduction',
    );
    const taxAfterReduction = put(
      'tax.taxAfterReduction',
      positive(minus(calculatedTax, incomeTaxReduction)),
      ['business.calculatedTax', 'credit.incomeTaxReduction'],
    );
    const totalCredits = put(
      'credit.totalTaxCredits',
      plus(standardTaxCredit, otherTaxCredits),
      ['credit.standardTaxCredit', 'credit.otherTaxCredits'],
    );
    const determinedTax = put(
      'business.determinedTax',
      positive(minus(taxAfterReduction, totalCredits)),
      ['tax.taxAfterReduction', 'credit.totalTaxCredits'],
    );
    const prepaid = from(
      'business.prepaidIncomeTax',
      input.prepaidIncomeTax,
      'business.prepaidIncomeTax',
    );
    put('business.balanceDueOrRefund', minus(determinedTax, prepaid), [
      'business.determinedTax',
      'business.prepaidIncomeTax',
    ]);
    localIncomeTax = reportSouthKorea2025LocalIncomeTax(determinedTax);
    put(
      'business.localIncomeTax',
      southKorea2025LocalIncomeTax(determinedTax),
      ['business.determinedTax'],
    );
  }
  return buildBusinessResult(
    input,
    issues,
    lines,
    SOUTH_KOREA_2025_SOLE_PROPRIETOR_CANDIDATE,
    localIncomeTax,
  );
}

function calculateCorporationParsed(
  input: SouthKorea2025CorporationInput,
): SouthKorea2025CorporationResult {
  const issues = corporationInputIssues(input);
  const lines: SouthKorea2025BusinessLine[] = [];
  const origins = new Map<string, string[]>();
  const from = (key: string, value: string, factKey: string): Q => {
    const amount = decimal(value);
    addBusinessLine(
      lines,
      origins,
      corporateRuleByKey,
      key,
      amount,
      [],
      [factKey],
    );
    return amount;
  };
  const put = (
    key: string,
    value: Q,
    dependsOn: readonly string[] = [],
    directFactKeys: readonly string[] = [],
  ): Q => {
    addBusinessLine(
      lines,
      origins,
      corporateRuleByKey,
      key,
      value,
      dependsOn,
      directFactKeys,
    );
    return value;
  };
  let localIncomeTax: ReturnType<
    typeof reportSouthKorea2025LocalIncomeTax
  > | null = null;
  if (!issues.length) {
    const gross = from(
      'corporate.grossRevenue',
      input.annualGrossRevenue,
      'corporate.annualGrossRevenue',
    );
    const returns = from(
      'corporate.returnsAndAllowances',
      input.returnsAndAllowances,
      'corporate.returnsAndAllowances',
    );
    const netRevenue = put('corporate.netRevenue', minus(gross, returns), [
      'corporate.grossRevenue',
      'corporate.returnsAndAllowances',
    ]);
    const expenses = from(
      'corporate.deductibleBusinessExpenses',
      input.deductibleBusinessExpenses,
      'corporate.deductibleBusinessExpenses',
    );
    const accountingProfit = put(
      'corporate.accountingProfit',
      minus(netRevenue, expenses),
      ['corporate.netRevenue', 'corporate.deductibleBusinessExpenses'],
    );
    const taxBase = put('corporate.taxBase', accountingProfit, [
      'corporate.accountingProfit',
    ]);
    const calculatedTax = put(
      'corporate.calculatedTax',
      southKorea2025CorporateIncomeTax(taxBase).amount,
      ['corporate.taxBase'],
    );
    const taxCredits = put('corporate.taxCredits', q(0n), []);
    const taxReduction = put('corporate.taxReduction', q(0n), []);
    const taxAfterReduction = put(
      'corporate.taxAfterReduction',
      positive(minus(calculatedTax, taxReduction)),
      ['corporate.calculatedTax', 'corporate.taxReduction'],
    );
    const prepaid = from(
      'corporate.prepaidCorporateTax',
      input.prepaidCorporateTax,
      'corporate.prepaidCorporateTax',
    );
    put(
      'corporate.balanceDueOrRefund',
      minus(taxAfterReduction, plus(taxCredits, prepaid)),
      [
        'corporate.taxAfterReduction',
        'corporate.taxCredits',
        'corporate.prepaidCorporateTax',
      ],
    );
    localIncomeTax = reportSouthKorea2025LocalIncomeTax(taxAfterReduction);
    put(
      'corporate.localIncomeTax',
      southKorea2025LocalIncomeTax(taxAfterReduction),
      ['corporate.taxAfterReduction'],
    );
  }
  return buildCorporationResult(
    input,
    issues,
    lines,
    SOUTH_KOREA_2025_CORPORATION_CANDIDATE,
    localIncomeTax,
  );
}

function blockedBusinessResult(): SouthKorea2025BusinessResult {
  return buildBusinessResult(
    null,
    [
      {
        code: 'invalid-input',
        path: 'input',
        message: 'Strict South Korea 2025 sole-proprietor input is invalid.',
      },
    ],
    [],
    SOUTH_KOREA_2025_SOLE_PROPRIETOR_CANDIDATE,
    null,
  );
}

function blockedCorporationResult(): SouthKorea2025CorporationResult {
  return buildCorporationResult(
    null,
    [
      {
        code: 'invalid-input',
        path: 'input',
        message: 'Strict South Korea 2025 corporation input is invalid.',
      },
    ],
    [],
    SOUTH_KOREA_2025_CORPORATION_CANDIDATE,
    null,
  );
}

export function calculateSouthKorea2025SoleProprietor(
  raw: unknown,
): SouthKorea2025BusinessResult {
  const parsed = SouthKorea2025SoleProprietorInputSchema.safeParse(raw);
  return parsed.success
    ? calculateSoleParsed(parsed.data)
    : blockedBusinessResult();
}

export const calculateSouthKorea2025Business =
  calculateSouthKorea2025SoleProprietor;

export function calculateSouthKorea2025Corporation(
  raw: unknown,
): SouthKorea2025CorporationResult {
  const parsed = SouthKorea2025CorporationInputSchema.safeParse(raw);
  return parsed.success
    ? calculateCorporationParsed(parsed.data)
    : blockedCorporationResult();
}

export const calculateSouthKorea2025StandaloneCorporation =
  calculateSouthKorea2025Corporation;

type Fact = z.infer<typeof FinanceTaxFactSchema>;
type FactType = 'decimal' | 'boolean';
type RequiredFact = {
  readonly key: string;
  readonly directKey: string;
  readonly type: FactType;
  readonly expected?: string | boolean;
};

const soleRequiredFacts: readonly RequiredFact[] = [
  {
    key: 'case.domesticResident',
    directKey: 'domesticResident',
    type: 'boolean',
    expected: true,
  },
  {
    key: 'case.hasCrossBorderActivity',
    directKey: 'hasCrossBorderActivity',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.onlyOrdinaryBusinessIncome',
    directKey: 'onlyOrdinaryBusinessIncome',
    type: 'boolean',
    expected: true,
  },
  {
    key: 'case.hasEmploymentIncome',
    directKey: 'hasEmploymentIncome',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasInvestmentIncome',
    directKey: 'hasInvestmentIncome',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasPensionIncome',
    directKey: 'hasPensionIncome',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasOtherGlobalIncome',
    directKey: 'hasOtherGlobalIncome',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasDailyEmploymentIncome',
    directKey: 'hasDailyEmploymentIncome',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasForeignSourceIncome',
    directKey: 'hasForeignSourceIncome',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasRetirementIncome',
    directKey: 'hasRetirementIncome',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.usesSimplifiedExpenseRate',
    directKey: 'usesSimplifiedExpenseRate',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasBusinessLoss',
    directKey: 'hasBusinessLoss',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.isCompliantFilingBusiness',
    directKey: 'isCompliantFilingBusiness',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasTaxReductionOrExemption',
    directKey: 'hasTaxReductionOrExemption',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'business.annualGrossBusinessRevenue',
    directKey: 'annualGrossBusinessRevenue',
    type: 'decimal',
  },
  {
    key: 'business.returnsAndAllowances',
    directKey: 'returnsAndAllowances',
    type: 'decimal',
  },
  {
    key: 'business.necessaryBusinessExpenses',
    directKey: 'necessaryBusinessExpenses',
    type: 'decimal',
  },
  {
    key: 'deduction.basicDeductionCount',
    directKey: 'basicDeductionCount',
    type: 'decimal',
  },
  {
    key: 'deduction.nationalPensionContribution',
    directKey: 'nationalPensionContribution',
    type: 'decimal',
  },
  {
    key: 'deduction.otherIncomeDeductions',
    directKey: 'otherIncomeDeductions',
    type: 'decimal',
  },
  {
    key: 'credit.otherTaxCredits',
    directKey: 'otherTaxCredits',
    type: 'decimal',
  },
  {
    key: 'credit.incomeTaxReduction',
    directKey: 'incomeTaxReduction',
    type: 'decimal',
  },
  { key: 'prepaid.incomeTax', directKey: 'prepaidIncomeTax', type: 'decimal' },
];

const corporationRequiredFacts: readonly RequiredFact[] = [
  {
    key: 'case.domesticCorporation',
    directKey: 'domesticCorporation',
    type: 'boolean',
    expected: true,
  },
  {
    key: 'case.hasCrossBorderActivity',
    directKey: 'hasCrossBorderActivity',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.standaloneCorporation',
    directKey: 'standaloneCorporation',
    type: 'boolean',
    expected: true,
  },
  {
    key: 'case.consolidatedGroup',
    directKey: 'consolidatedGroup',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasBranchOutsideKorea',
    directKey: 'hasBranchOutsideKorea',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasTaxAdjustments',
    directKey: 'hasTaxAdjustments',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasCarriedForwardLosses',
    directKey: 'hasCarriedForwardLosses',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasNonTaxableIncome',
    directKey: 'hasNonTaxableIncome',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasIncomeDeductions',
    directKey: 'hasIncomeDeductions',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasTaxCredits',
    directKey: 'hasTaxCredits',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasTaxReductionOrExemption',
    directKey: 'hasTaxReductionOrExemption',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasPenaltiesOrAdditionalTax',
    directKey: 'hasPenaltiesOrAdditionalTax',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasCapitalGains',
    directKey: 'hasCapitalGains',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasInvestmentIncome',
    directKey: 'hasInvestmentIncome',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasRealEstateIncome',
    directKey: 'hasRealEstateIncome',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'case.hasForeignSourceIncome',
    directKey: 'hasForeignSourceIncome',
    type: 'boolean',
    expected: false,
  },
  {
    key: 'corporate.annualGrossRevenue',
    directKey: 'annualGrossRevenue',
    type: 'decimal',
  },
  {
    key: 'corporate.returnsAndAllowances',
    directKey: 'returnsAndAllowances',
    type: 'decimal',
  },
  {
    key: 'corporate.deductibleBusinessExpenses',
    directKey: 'deductibleBusinessExpenses',
    type: 'decimal',
  },
  {
    key: 'prepaid.corporateIncomeTax',
    directKey: 'prepaidCorporateTax',
    type: 'decimal',
  },
];

export const SOUTH_KOREA_2025_SOLE_PROPRIETOR_REQUIRED_FACTS =
  deepFreeze(soleRequiredFacts);
export const SOUTH_KOREA_2025_CORPORATION_REQUIRED_FACTS = deepFreeze(
  corporationRequiredFacts,
);

function exactScopeMatches(
  actual: FinanceTaxIntake['scope'],
  expected:
    | typeof SOUTH_KOREA_2025_SOLE_PROPRIETOR_SCOPE
    | typeof SOUTH_KOREA_2025_CORPORATION_SCOPE,
): boolean {
  return canonical(actual) === canonical(expected);
}

function factMap(intake: FinanceTaxIntake): Map<string, Fact> {
  return new Map(intake.facts.map((fact) => [fact.key, fact]));
}

function factValue(
  facts: ReadonlyMap<string, Fact>,
  requirement: RequiredFact,
  issues: SouthKorea2025BusinessIssue[],
): string | boolean | null {
  const fact = facts.get(requirement.key);
  if (!fact) {
    issue(
      issues,
      'missing-reviewed-fact',
      requirement.key,
      `Reviewed fact required: ${requirement.key}`,
    );
    return null;
  }
  if (fact.reviewState !== 'reviewed')
    issue(
      issues,
      'unreviewed-fact',
      requirement.key,
      `Reviewed fact required: ${requirement.key}`,
    );
  if (fact.value.type !== requirement.type) {
    issue(
      issues,
      'wrong-fact-type',
      requirement.key,
      `Expected ${requirement.type} for ${requirement.key}`,
    );
    return null;
  }
  if (
    requirement.expected !== undefined &&
    fact.value.value !== requirement.expected
  )
    issue(
      issues,
      'unsupported-fact',
      requirement.key,
      `Unsupported value for ${requirement.key}`,
    );
  return fact.value.value;
}

function genericAssessment(
  raw: unknown,
  expectedScope:
    | typeof SOUTH_KOREA_2025_SOLE_PROPRIETOR_SCOPE
    | typeof SOUTH_KOREA_2025_CORPORATION_SCOPE,
  requirements: readonly RequiredFact[],
): {
  intake: FinanceTaxIntake | null;
  facts: Map<string, Fact>;
  values: Record<string, string | boolean>;
  issues: SouthKorea2025BusinessIssue[];
} {
  const parsed = FinanceTaxIntakeSchema.safeParse(raw);
  if (!parsed.success)
    return {
      intake: null,
      facts: new Map(),
      values: {},
      issues: [
        {
          code: 'invalid-intake',
          path: 'intake',
          message: 'Generic tax intake or source lineage is invalid.',
        },
      ],
    };
  const intake = parsed.data;
  const issues: SouthKorea2025BusinessIssue[] = [];
  if (!exactScopeMatches(intake.scope, expectedScope))
    issue(
      issues,
      'unsupported-scope',
      'scope',
      'Requires the exact KR-NATIONAL 2025 form scope for this branch.',
    );
  if (
    intake.domesticResident !== true &&
    expectedScope.taxpayerType === 'sole-proprietor'
  )
    issue(
      issues,
      'unsupported-scope',
      'domesticResident',
      'A domestic resident is required.',
    );
  if (
    intake.standaloneCorporation !== true &&
    expectedScope.taxpayerType === 'corporation'
  )
    issue(
      issues,
      'unsupported-scope',
      'standaloneCorporation',
      'A standalone domestic corporation is required.',
    );
  if (
    intake.hasCrossBorderActivity !== false ||
    intake.requestedFeatures.length !== 1 ||
    intake.requestedFeatures[0] !== 'income-tax-return'
  )
    issue(
      issues,
      'unsupported-scope',
      'intake',
      'Only one domestic income-tax-return feature is supported.',
    );
  const facts = factMap(intake);
  const allowed = new Set(requirements.map((requirement) => requirement.key));
  for (const fact of intake.facts)
    if (!allowed.has(fact.key))
      issue(
        issues,
        'unsupported-fact',
        fact.key,
        `Unmapped fact is not silently ignored: ${fact.key}`,
      );
  const values: Record<string, string | boolean> = {};
  for (const requirement of requirements) {
    const value = factValue(facts, requirement, issues);
    if (value !== null) values[requirement.directKey] = value;
  }
  return { intake, facts, values, issues };
}

function directSoleFromValues(
  values: Record<string, string | boolean>,
): SouthKorea2025SoleProprietorInput {
  return {
    schemaVersion: 1,
    scope: { ...SOUTH_KOREA_2025_SOLE_PROPRIETOR_SCOPE },
    domesticResident: values.domesticResident === true,
    hasCrossBorderActivity: values.hasCrossBorderActivity === true,
    onlyOrdinaryBusinessIncome: values.onlyOrdinaryBusinessIncome === true,
    hasEmploymentIncome: values.hasEmploymentIncome === true,
    hasInvestmentIncome: values.hasInvestmentIncome === true,
    hasPensionIncome: values.hasPensionIncome === true,
    hasOtherGlobalIncome: values.hasOtherGlobalIncome === true,
    hasDailyEmploymentIncome: values.hasDailyEmploymentIncome === true,
    hasForeignSourceIncome: values.hasForeignSourceIncome === true,
    hasRetirementIncome: values.hasRetirementIncome === true,
    usesSimplifiedExpenseRate: values.usesSimplifiedExpenseRate === true,
    hasBusinessLoss: values.hasBusinessLoss === true,
    isCompliantFilingBusiness: values.isCompliantFilingBusiness === true,
    hasTaxReductionOrExemption: values.hasTaxReductionOrExemption === true,
    annualGrossBusinessRevenue: String(
      values.annualGrossBusinessRevenue ?? '0',
    ),
    returnsAndAllowances: String(values.returnsAndAllowances ?? '0'),
    necessaryBusinessExpenses: String(values.necessaryBusinessExpenses ?? '0'),
    basicDeductionCount: String(values.basicDeductionCount ?? '1'),
    nationalPensionContribution: String(
      values.nationalPensionContribution ?? '0',
    ),
    otherIncomeDeductions: String(values.otherIncomeDeductions ?? '0'),
    otherTaxCredits: String(values.otherTaxCredits ?? '0'),
    incomeTaxReduction: String(values.incomeTaxReduction ?? '0'),
    prepaidIncomeTax: String(values.prepaidIncomeTax ?? '0'),
  };
}

function directCorporationFromValues(
  values: Record<string, string | boolean>,
): SouthKorea2025CorporationInput {
  return {
    schemaVersion: 1,
    scope: { ...SOUTH_KOREA_2025_CORPORATION_SCOPE },
    domesticCorporation: values.domesticCorporation === true,
    hasCrossBorderActivity: values.hasCrossBorderActivity === true,
    standaloneCorporation: values.standaloneCorporation === true,
    consolidatedGroup: values.consolidatedGroup === true,
    hasBranchOutsideKorea: values.hasBranchOutsideKorea === true,
    hasTaxAdjustments: values.hasTaxAdjustments === true,
    hasCarriedForwardLosses: values.hasCarriedForwardLosses === true,
    hasNonTaxableIncome: values.hasNonTaxableIncome === true,
    hasIncomeDeductions: values.hasIncomeDeductions === true,
    hasTaxCredits: values.hasTaxCredits === true,
    hasTaxReductionOrExemption: values.hasTaxReductionOrExemption === true,
    hasPenaltiesOrAdditionalTax: values.hasPenaltiesOrAdditionalTax === true,
    hasCapitalGains: values.hasCapitalGains === true,
    hasInvestmentIncome: values.hasInvestmentIncome === true,
    hasRealEstateIncome: values.hasRealEstateIncome === true,
    hasForeignSourceIncome: values.hasForeignSourceIncome === true,
    annualGrossRevenue: String(values.annualGrossRevenue ?? '0'),
    returnsAndAllowances: String(values.returnsAndAllowances ?? '0'),
    deductibleBusinessExpenses: String(
      values.deductibleBusinessExpenses ?? '0',
    ),
    prepaidCorporateTax: String(values.prepaidCorporateTax ?? '0'),
  };
}

export function assessSouthKorea2025SoleProprietorFacts(raw: unknown) {
  const assessment = genericAssessment(
    raw,
    SOUTH_KOREA_2025_SOLE_PROPRIETOR_SCOPE,
    soleRequiredFacts,
  );
  const input = assessment.intake
    ? directSoleFromValues(assessment.values)
    : null;
  if (input) {
    for (const problem of soleInputIssues(input))
      assessment.issues.push(problem);
  }
  return deepFreeze({ ...assessment, input });
}

export function assessSouthKorea2025CorporationFacts(raw: unknown) {
  const assessment = genericAssessment(
    raw,
    SOUTH_KOREA_2025_CORPORATION_SCOPE,
    corporationRequiredFacts,
  );
  const input = assessment.intake
    ? directCorporationFromValues(assessment.values)
    : null;
  if (input) {
    for (const problem of corporationInputIssues(input))
      assessment.issues.push(problem);
  }
  return deepFreeze({ ...assessment, input });
}

export function evaluateSouthKorea2025SoleProprietorWorkingPapers(
  raw: unknown,
) {
  const assessed = assessSouthKorea2025SoleProprietorFacts(raw);
  if (!assessed.input || assessed.issues.length)
    return buildBusinessResult(
      null,
      [...assessed.issues],
      [],
      SOUTH_KOREA_2025_SOLE_PROPRIETOR_CANDIDATE,
      null,
    );
  return calculateSoleParsed(assessed.input);
}

export function evaluateSouthKorea2025CorporationWorkingPapers(raw: unknown) {
  const assessed = assessSouthKorea2025CorporationFacts(raw);
  if (!assessed.input || assessed.issues.length)
    return buildCorporationResult(
      null,
      [...assessed.issues],
      [],
      SOUTH_KOREA_2025_CORPORATION_CANDIDATE,
      null,
    );
  return calculateCorporationParsed(assessed.input);
}

export const calculateSouthKorea2025SoleProprietorWorkingPapers =
  calculateSouthKorea2025SoleProprietor;
export const calculateSouthKorea2025CorporationWorkingPapers =
  calculateSouthKorea2025Corporation;

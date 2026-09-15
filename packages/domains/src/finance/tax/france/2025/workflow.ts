import {
  deepFreeze,
  FinanceTaxEvaluationSchema,
  FinanceTaxIntakeSchema,
  type FinanceTaxEvaluation,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import { createHash } from 'node:crypto';
import {
  compare,
  decimal,
  minus,
  q,
  report,
  rounded,
  serialize,
  type Exact,
} from './exact.js';
import {
  france2025DecoteSingle,
  france2025ProgressiveTax,
  france2025RoundedProgressiveTax,
  france2025StandardSalaryDeduction,
  FRANCE_2025_LIMITS,
} from './tables.js';
import {
  FRANCE_2025_PROVENANCE,
  FRANCE_2025_SOURCE_REVIEWS,
  FRANCE_2025_SOURCES,
} from './sources.js';

export const FRANCE_2025_VERSION = '2025.1-metropolitan-single-salary';
export const FRANCE_2025_SCOPE = deepFreeze({
  country: 'FR' as const,
  subdivision: 'FR-METRO',
  taxpayerType: 'individual' as const,
  year: 2025,
  regime: 'income-tax-return',
  formVersion: '2042-2026',
});

export type FranceFactType = 'decimal' | 'text' | 'boolean' | 'date';
export type FranceFactRequirement = {
  key: string;
  type: FranceFactType;
  expected?: string | boolean;
  label: string;
  locator: string;
};

/**
 * Required reviewed inputs. A zero-valued exclusion is deliberate: a missing
 * fact cannot silently become a tax-free assumption. `filing.*` fields make
 * the income-year / filing-year distinction explicit in the input snapshot.
 */
export const FRANCE_2025_REQUIRED_FACTS = deepFreeze([
  {
    key: 'residency.region',
    type: 'text',
    expected: 'metropolitan-france',
    label: 'Metropolitan France residence',
    locator: '2042 identification; 2025-income residence at 31 December',
  },
  {
    key: 'filing.incomeYear',
    type: 'decimal',
    expected: '2025',
    label: 'Income year',
    locator: '2042-2026 title: declaration of 2025 income',
  },
  {
    key: 'filing.declarationYear',
    type: 'decimal',
    expected: '2026',
    label: 'Filing/declaration year',
    locator: '2042-2026 form version and 2026 filing campaign',
  },
  {
    key: 'employment.incomeType',
    type: 'text',
    expected: 'ordinary-salary',
    label: 'Employment income type',
    locator: 'Brochure IR 2026 pp. 86–87; treatments et salaires',
  },
  {
    key: 'employment.employerCount',
    type: 'decimal',
    expected: '1',
    label: 'Ordinary employment source count',
    locator: 'Bounded one ordinary salary source',
  },
  {
    key: 'employment.grossSalary',
    type: 'decimal',
    label: 'Gross ordinary employment salary',
    locator: '2042 line 1AJ; Brochure IR 2026 p. 107',
  },
  {
    key: 'deduction.method',
    type: 'text',
    expected: 'standard-10-percent',
    label: 'Professional-expense deduction method',
    locator: 'Brochure IR 2026 pp. 106–107; standard 10% option',
  },
  {
    key: 'deduction.actualExpenses',
    type: 'decimal',
    expected: '0',
    label: 'Actual professional expenses',
    locator: '2042 lines 1AK–1DK; excluded from bounded candidate',
  },
  {
    key: 'income.otherTaxableIncome',
    type: 'decimal',
    expected: '0',
    label: 'Other taxable income',
    locator: '2042 income sections; excluded categories must be reviewed zero',
  },
  {
    key: 'income.otherDeductions',
    type: 'decimal',
    expected: '0',
    label: 'Other deductions and charges',
    locator: '2042 charges sections; excluded from bounded candidate',
  },
  {
    key: 'income.otherCredits',
    type: 'decimal',
    expected: '0',
    label: 'Other tax reductions and credits',
    locator:
      '2042 reductions and credits sections; excluded from bounded candidate',
  },
  {
    key: 'income.foreignTaxCredit',
    type: 'decimal',
    expected: '0',
    label: 'Foreign tax credit',
    locator: '2042/2047 foreign-income sections; cross-border excluded',
  },
  {
    key: 'income.exceptionalOrDeferred',
    type: 'decimal',
    expected: '0',
    label: 'Exceptional or deferred income',
    locator: '2042 income sections; quotient-system cases excluded',
  },
  {
    key: 'income.advanceOrInstalments',
    type: 'decimal',
    expected: '0',
    label: 'Other income-tax advances or instalments',
    locator: 'Annual settlement inputs; only PAS withholding is supported',
  },
  {
    key: 'pas.calendarYear',
    type: 'decimal',
    expected: '2025',
    label: 'PAS withholding calendar year',
    locator: '2042 lines 8HV–8IV; withholding made 1 January–31 December 2025',
  },
  {
    key: 'pas.withheld',
    type: 'decimal',
    label: 'PAS withholding paid during 2025',
    locator: '2042 lines 8HV–8IV; annual settlement credit',
  },
  {
    key: 'family.status',
    type: 'text',
    expected: 'single',
    label: 'Family/marital status',
    locator: '2042 family situation; single filer decote',
  },
  {
    key: 'family.dependentChildren',
    type: 'decimal',
    label: 'Dependent children charged to the filer',
    locator: 'CGI art. 194; bounded support for zero or one first child',
  },
  {
    key: 'family.raisingFirstChildAlone',
    type: 'boolean',
    label: 'Filer lives alone and raises the first child alone',
    locator: 'CGI art. 194 II; BOFiP BOI-IR-LIQ-20-20-20 §§ 60–70',
  },
  {
    key: 'family.livesAlone',
    type: 'boolean',
    label: 'Filer lives alone',
    locator: 'Family quotient single-parent eligibility',
  },
  {
    key: 'family.alternatingResidence',
    type: 'boolean',
    expected: false,
    label: 'Children in alternating residence',
    locator: '2042 family situation; quarter-parts excluded',
  },
  {
    key: 'family.otherDependants',
    type: 'decimal',
    expected: '0',
    label: 'Other dependants',
    locator: '2042 family situation; excluded from bounded candidate',
  },
  {
    key: 'family.specialHalfParts',
    type: 'boolean',
    expected: false,
    label: 'Special quotient-family half-parts',
    locator:
      '2042 family situation; invalidity/veteran/former-parent cases excluded',
  },
  {
    key: 'family.invalidityOrVeteran',
    type: 'boolean',
    expected: false,
    label: 'Invalidity or veteran quotient-family status',
    locator: 'Brochure IR 2026 pp. 371–373; complementary reduction excluded',
  },
  {
    key: 'family.formerSingleParent',
    type: 'boolean',
    expected: false,
    label: 'Former single-parent half-part status',
    locator: 'CGI art. 195; special half-part excluded',
  },
] as const satisfies readonly FranceFactRequirement[]);

export const FRANCE_2025_GAPS = deepFreeze([
  'full-2042-and-annex-field-inventory-not-validated',
  'identity-address-bank-signature-and-electronic-filing-fields-not-bound',
  'actual-professional-expense-option-not-implemented',
  'pensions-capital-income-rental-income-and-capital-gains-not-implemented',
  'foreign-income-tax-treaty-and-cross-border-cases-not-implemented',
  'deductions-reductions-credits-social-contributions-and-exceptional-income-not-implemented',
  'dom-overseas-local-relief-and-department-specific-rules-not-implemented',
  'children-beyond-first-child-alternating-residence-and-special-parts-not-implemented',
  'business-self-employed-and-corporate-return-forms-not-implemented',
  'independent-complete-return-field-review-and-production-acceptance-not-performed',
] as const);

export const FRANCE_2025_CANDIDATE = deepFreeze({
  id: 'france-metropolitan-2025-income-tax-working-papers',
  version: FRANCE_2025_VERSION,
  enabled: false,
  registryEligible: false,
  complete: false,
  scope: FRANCE_2025_SCOPE,
  coverage:
    'Bounded metropolitan-France resident individual: one ordinary employment salary, standard 10% professional-expense deduction, single filer, zero or one first child raised alone, 2025 income settled by the 2026 declaration.',
  references: FRANCE_2025_SOURCES,
  sourceReviews: FRANCE_2025_SOURCE_REVIEWS,
  provenance: FRANCE_2025_PROVENANCE,
  releaseBlockers: FRANCE_2025_GAPS,
  nextScope: [
    'complete 2042/2042-C/2044/2047 field and schedule inventory',
    'metropolitan and DOM local rules',
    'business, corporate and nonresident return packages',
  ],
});

type FranceRule = { id: string; referenceIds: readonly string[] };
export const FRANCE_2025_RULES = deepFreeze([
  {
    id: 'fr2025.salary.standard-deduction',
    referenceIds: ['dgfip-fr-brochure-ir-2026'],
  },
  {
    id: 'fr2025.salary.net-taxable',
    referenceIds: ['dgfip-fr-brochure-ir-2026'],
  },
  {
    id: 'fr2025.quotient.parts',
    referenceIds: [
      'dgfip-fr-brochure-ir-2026',
      'bofip-fr-ir-liq-20-20-20-20260407',
    ],
  },
  {
    id: 'fr2025.quotient.progressive-scale',
    referenceIds: [
      'dgfip-fr-brochure-ir-2026',
      'bofip-fr-ir-liq-20-10-20260407',
    ],
  },
  {
    id: 'fr2025.quotient.cap',
    referenceIds: ['bofip-fr-ir-liq-20-20-20-20260407'],
  },
  {
    id: 'fr2025.decote.single',
    referenceIds: ['bofip-fr-ir-liq-20-20-30-20260407'],
  },
  {
    id: 'fr2025.collection.threshold',
    referenceIds: ['dgfip-fr-brochure-ir-2026'],
  },
  {
    id: 'fr2025.pas.annual-credit',
    referenceIds: [
      'dgfip-fr-declaration-2026',
      'dgfip-fr-form-2042-2026',
      'bofip-fr-ir-pas-20-20-10-20260407',
    ],
  },
] as const satisfies readonly FranceRule[]);

type FranceFieldDefinition = {
  key: string;
  label: string;
  ruleIds: readonly string[];
  directFacts: readonly string[];
  sourceId: string;
  locator: string;
};

export const FRANCE_2025_FIELD_DEFINITIONS = deepFreeze([
  {
    key: '1AJ.grossSalary',
    label: 'Gross ordinary employment salary',
    ruleIds: ['fr2025.salary.net-taxable'],
    directFacts: ['employment.grossSalary'],
    sourceId: 'dgfip-fr-form-2042-2026',
    locator: '2042 line 1AJ',
  },
  {
    key: 'calc.standardDeduction10',
    label: 'Standard professional-expense deduction (10%)',
    ruleIds: ['fr2025.salary.standard-deduction'],
    directFacts: ['employment.grossSalary', 'deduction.method'],
    sourceId: 'dgfip-fr-brochure-ir-2026',
    locator: 'Brochure IR 2026 p. 107; minimum €509, maximum €14,555',
  },
  {
    key: 'calc.netTaxableSalary',
    label: 'Net taxable salary after standard deduction',
    ruleIds: ['fr2025.salary.net-taxable'],
    directFacts: ['employment.grossSalary'],
    sourceId: 'dgfip-fr-brochure-ir-2026',
    locator: 'Brochure IR 2026 p. 379 worksheet: salary less deduction',
  },
  {
    key: 'calc.familyParts',
    label: 'Quotient-family parts',
    ruleIds: ['fr2025.quotient.parts'],
    directFacts: [
      'family.status',
      'family.dependentChildren',
      'family.raisingFirstChildAlone',
      'family.livesAlone',
    ],
    sourceId: 'bofip-fr-ir-liq-20-20-20-20260407',
    locator:
      '§§ 60–70; one part single, two parts for first child raised alone',
  },
  {
    key: 'calc.taxableIncomePerPart',
    label: 'Net taxable income per quotient-family part',
    ruleIds: ['fr2025.quotient.parts'],
    directFacts: ['employment.grossSalary'],
    sourceId: 'bofip-fr-ir-liq-20-10-20260407',
    locator: '§ 10; net taxable income divided by quotient-family parts',
  },
  {
    key: 'calc.taxBeforeFamilyCap',
    label: 'Progressive tax before family-quotient cap',
    ruleIds: ['fr2025.quotient.progressive-scale'],
    directFacts: ['employment.grossSalary'],
    sourceId: 'bofip-fr-ir-liq-20-10-20260407',
    locator: '§§ 10, 40; 2025-income progressive scale',
  },
  {
    key: 'calc.familyQuotientCap',
    label: 'Family-quotient maximum tax advantage',
    ruleIds: ['fr2025.quotient.cap'],
    directFacts: ['family.dependentChildren', 'family.raisingFirstChildAlone'],
    sourceId: 'bofip-fr-ir-liq-20-20-20-20260407',
    locator: '§§ 40, 60–70; €1,807 or €4,262 bounded cap',
  },
  {
    key: 'calc.taxAfterFamilyCap',
    label: 'Progressive tax after family-quotient cap',
    ruleIds: ['fr2025.quotient.cap'],
    directFacts: ['employment.grossSalary'],
    sourceId: 'bofip-fr-ir-liq-20-20-20-20260407',
    locator: '§ 20; second-term double liquidation',
  },
  {
    key: 'calc.decote',
    label: 'Single-filer decote',
    ruleIds: ['fr2025.decote.single'],
    directFacts: ['family.status'],
    sourceId: 'bofip-fr-ir-liq-20-20-30-20260407',
    locator: '§§ 10, 40; €897 − 45.25% of gross progressive tax',
  },
  {
    key: 'calc.taxAfterDecote',
    label: 'Income tax after decote',
    ruleIds: ['fr2025.decote.single'],
    directFacts: ['family.status'],
    sourceId: 'bofip-fr-ir-liq-20-20-30-20260407',
    locator: '§ 10; decote before reductions and withholding credit',
  },
  {
    key: 'calc.collectionThresholdTax',
    label: 'Tax after €61 collection threshold',
    ruleIds: ['fr2025.collection.threshold'],
    directFacts: ['family.status'],
    sourceId: 'dgfip-fr-brochure-ir-2026',
    locator: 'Brochure IR 2026 p. 372; no collection below €61',
  },
  {
    key: '8HV.pasWithheld2025',
    label: 'PAS withholding paid in calendar 2025',
    ruleIds: ['fr2025.pas.annual-credit'],
    directFacts: ['pas.calendarYear', 'pas.withheld'],
    sourceId: 'dgfip-fr-form-2042-2026',
    locator: '2042 lines 8HV–8IV',
  },
  {
    key: 'calc.balanceAfterWithholding',
    label: 'Working balance after 2025 PAS credit',
    ruleIds: ['fr2025.pas.annual-credit'],
    directFacts: ['pas.withheld'],
    sourceId: 'dgfip-fr-declaration-2026',
    locator: '2026 declaration settles 2025 tax after PAS paid in 2025',
  },
] as const satisfies readonly FranceFieldDefinition[]);

type FranceIssue = { code: string; path: string; message: string };
export type France2025FormField = {
  id: string;
  form: string;
  line: string;
  label: string;
  dependencies: string[];
  sourceId: string;
  locator: string;
  exactRational: { numerator: string; denominator: string };
  exactDecimal: string | null;
  reportableAmount: string;
};
export type France2025Trace = {
  fieldId: string;
  exactRational: { numerator: string; denominator: string };
  reportableAmount: string;
  dependsOn: string[];
  sourceFactKeys: string[];
  referenceIds: string[];
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  if (typeof value === 'bigint') return `${value}n`;
  return JSON.stringify(value);
};
const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

const expectedScope = FRANCE_2025_SCOPE as Record<string, unknown>;
const sourceReferenceIds = (sourceId: string) =>
  Array.from(
    FRANCE_2025_RULES.find((rule) =>
      rule.referenceIds.some((referenceId) => referenceId === sourceId),
    )?.referenceIds ?? [sourceId],
  );

function issue(code: string, path: string, message: string): FranceIssue {
  return { code, path, message };
}

function exactMoney(value: string): Exact {
  const parsed = decimal(value, { maxPlaces: 2 });
  if (parsed.n < 0n) throw new Error('negative-money');
  return parsed;
}

function valueOf(
  facts: ReadonlyMap<string, FinanceTaxIntake['facts'][number]>,
  key: string,
) {
  return facts.get(key)?.value.value;
}

function factMatchesExpected(
  actual: FinanceTaxIntake['facts'][number]['value'],
  expected: string | boolean,
): boolean {
  if (actual.type === 'decimal' && typeof expected === 'string') {
    try {
      return compare(decimal(actual.value), decimal(expected)) === 0n;
    } catch {
      return false;
    }
  }
  return actual.value === expected;
}

function decimalFact(
  facts: ReadonlyMap<string, FinanceTaxIntake['facts'][number]>,
  key: string,
): Exact {
  const value = facts.get(key)?.value;
  if (!value || value.type !== 'decimal')
    throw new Error(`missing-money:${key}`);
  return exactMoney(value.value);
}

function integerFact(
  facts: ReadonlyMap<string, FinanceTaxIntake['facts'][number]>,
  key: string,
): bigint {
  const value = decimalFact(facts, key);
  if (value.d !== 1n) throw new Error(`noninteger:${key}`);
  return value.n;
}

function requiredFactIssues(
  intake: FinanceTaxIntake,
  facts: ReadonlyMap<string, FinanceTaxIntake['facts'][number]>,
): FranceIssue[] {
  const issues: FranceIssue[] = [];
  for (const required of FRANCE_2025_REQUIRED_FACTS) {
    const fact = facts.get(required.key);
    if (!fact) {
      issues.push(
        issue(
          'missing-fact',
          `facts.${required.key}`,
          `Reviewed ${required.type} input is required: ${required.label}`,
        ),
      );
      continue;
    }
    if (fact.reviewState !== 'reviewed')
      issues.push(
        issue(
          'unreviewed-fact',
          `facts.${required.key}`,
          'Unreviewed or disputed facts cannot drive a tax calculation.',
        ),
      );
    if (fact.value.type !== required.type) {
      issues.push(
        issue(
          'fact-type-mismatch',
          `facts.${required.key}`,
          `Expected a ${required.type} fact.`,
        ),
      );
      continue;
    }
    if (
      'expected' in required &&
      required.expected !== undefined &&
      !factMatchesExpected(fact.value, required.expected)
    )
      issues.push(
        issue(
          'unsupported-fact',
          `facts.${required.key}`,
          `Supported value is ${String(required.expected)}.`,
        ),
      );
    if (fact.value.type === 'decimal') {
      try {
        exactMoney(fact.value.value);
      } catch (error) {
        issues.push(
          issue(
            'invalid-money',
            `facts.${required.key}`,
            error instanceof Error && error.message === 'negative-money'
              ? 'Amounts must be nonnegative.'
              : 'Amounts must be valid nonnegative decimals with at most two fractional places.',
          ),
        );
      }
    }
  }
  for (const fact of intake.facts)
    if (
      !FRANCE_2025_REQUIRED_FACTS.some((required) => required.key === fact.key)
    )
      issues.push(
        issue(
          'unsupported-fact',
          `facts.${fact.key}`,
          'Unknown fact is outside this bounded return package.',
        ),
      );
  return issues;
}

/** Input review; no authority or filing status is granted by this function. */
export function assessFrance2025Facts(raw: unknown): {
  intake: FinanceTaxIntake | null;
  issues: FranceIssue[];
} {
  const parsed = FinanceTaxIntakeSchema.safeParse(raw);
  if (!parsed.success)
    return {
      intake: null,
      issues: [
        issue(
          'invalid-intake',
          'intake',
          'A complete versioned intake envelope with valid source lineage is required.',
        ),
      ],
    };
  const intake = parsed.data;
  const issues: FranceIssue[] = [];
  for (const [key, expected] of Object.entries(expectedScope))
    if (intake.scope[key as keyof typeof intake.scope] !== expected)
      issues.push(
        issue(
          'unsupported-scope',
          `scope.${key}`,
          `This package requires ${key}=${String(expected)}.`,
        ),
      );
  if (intake.domesticResident !== true)
    issues.push(
      issue(
        intake.domesticResident === null ? 'missing-fact' : 'unsupported-scope',
        'domesticResident',
        'Only a reviewed domestic resident is supported.',
      ),
    );
  if (intake.hasCrossBorderActivity !== false)
    issues.push(
      issue(
        intake.hasCrossBorderActivity === null
          ? 'missing-fact'
          : 'unsupported-scope',
        'hasCrossBorderActivity',
        'Cross-border activity is outside this package.',
      ),
    );
  if (intake.standaloneCorporation !== null)
    issues.push(
      issue(
        'unsupported-scope',
        'standaloneCorporation',
        'Corporate return status cannot be supplied to an individual package.',
      ),
    );
  if (
    intake.requestedFeatures.length !== 1 ||
    intake.requestedFeatures[0] !== 'income-tax-return'
  )
    issues.push(
      issue(
        'unsupported-feature',
        'requestedFeatures',
        'Only the annual income-tax-return feature is supported.',
      ),
    );
  const facts = new Map(intake.facts.map((fact) => [fact.key, fact]));
  issues.push(...requiredFactIssues(intake, facts));

  const count = facts.get('family.dependentChildren')?.value;
  if (count?.type === 'decimal') {
    try {
      const children = integerFact(facts, 'family.dependentChildren');
      if (children !== 0n && children !== 1n)
        issues.push(
          issue(
            'unsupported-family-size',
            'facts.family.dependentChildren',
            'Only zero or one dependent child is supported.',
          ),
        );
      const raising = valueOf(facts, 'family.raisingFirstChildAlone');
      const alone = valueOf(facts, 'family.livesAlone');
      if (children === 1n && (raising !== true || alone !== true))
        issues.push(
          issue(
            'unsupported-family-status',
            'facts.family.raisingFirstChildAlone',
            'The bounded child case requires a filer who lives alone and raises the first child alone.',
          ),
        );
      if (children === 0n && (raising !== false || alone !== false))
        issues.push(
          issue(
            'inconsistent-family-facts',
            'facts.family',
            'The no-child case requires both single-parent and lives-alone flags to be false.',
          ),
        );
    } catch {
      issues.push(
        issue(
          'invalid-family-size',
          'facts.family.dependentChildren',
          'Dependent-child count must be a nonnegative whole-number decimal.',
        ),
      );
    }
  }
  for (const key of [
    'deduction.actualExpenses',
    'income.otherTaxableIncome',
    'income.otherDeductions',
    'income.otherCredits',
    'income.foreignTaxCredit',
    'income.exceptionalOrDeferred',
    'income.advanceOrInstalments',
  ]) {
    const fact = facts.get(key)?.value;
    if (fact?.type === 'decimal') {
      try {
        if (exactMoney(fact.value).n !== 0n)
          issues.push(
            issue(
              'unsupported-income-item',
              `facts.${key}`,
              'Nonzero amounts in this category are outside the bounded ordinary-salary scope.',
            ),
          );
      } catch {
        // requiredFactIssues already reports malformed/negative money.
      }
    }
  }
  try {
    if (integerFact(facts, 'employment.employerCount') !== 1n)
      issues.push(
        issue(
          'unsupported-employment-count',
          'facts.employment.employerCount',
          'Exactly one ordinary employment source is supported.',
        ),
      );
  } catch {
    // Missing/type/precision issue already reported above.
  }
  return { intake, issues };
}

export type France2025Calculation = {
  grossSalary: Exact;
  standardDeduction: Exact;
  netTaxableExact: Exact;
  netTaxable: Exact;
  parts: Exact;
  taxableIncomePerPart: Exact;
  taxBeforeFamilyCapExact: Exact;
  taxBeforeFamilyCap: bigint;
  taxWithOnePart: bigint;
  familyQuotientCap: bigint;
  familyQuotientAdvantage: bigint;
  taxAfterFamilyCap: bigint;
  decote: bigint;
  taxAfterDecote: bigint;
  taxAfterCollectionThreshold: bigint;
  pasWithheldExact: Exact;
  pasWithheld: bigint;
  balanceExact: Exact;
  balance: bigint;
};

function calculationFor(intake: FinanceTaxIntake): France2025Calculation {
  const facts = new Map(intake.facts.map((fact) => [fact.key, fact]));
  const grossSalary = decimalFact(facts, 'employment.grossSalary');
  const standardDeduction = france2025StandardSalaryDeduction(grossSalary);
  const netTaxableExact = minus(grossSalary, standardDeduction);
  const netTaxable = rounded(netTaxableExact);
  const children = integerFact(facts, 'family.dependentChildren');
  const parts = children === 1n ? q(2n) : q(1n);
  const taxableIncomePerPart = q(
    netTaxable.n * parts.d,
    netTaxable.d * parts.n,
  );
  const taxBeforeFamilyCapExact = france2025ProgressiveTax(netTaxable, parts);
  const taxBeforeFamilyCap = france2025RoundedProgressiveTax(netTaxable, parts);
  const taxWithOnePart = france2025RoundedProgressiveTax(netTaxable, q(1n));
  const familyQuotientCap =
    children === 1n
      ? roundCap(FRANCE_2025_LIMITS.singleParentFirstChildPartCap)
      : 0n;
  const familyQuotientAdvantage = maxBigInt(
    0n,
    taxWithOnePart - taxBeforeFamilyCap,
  );
  const taxAfterFamilyCap =
    taxWithOnePart -
    (familyQuotientCap < familyQuotientAdvantage
      ? familyQuotientCap
      : familyQuotientAdvantage);
  const decote = france2025DecoteSingle(taxAfterFamilyCap);
  const taxAfterDecote =
    taxAfterFamilyCap > decote ? taxAfterFamilyCap - decote : 0n;
  const taxAfterCollectionThreshold =
    taxAfterDecote < roundCap(FRANCE_2025_LIMITS.collectionThreshold)
      ? 0n
      : taxAfterDecote;
  const pasWithheldExact = decimalFact(facts, 'pas.withheld');
  const pasWithheld = roundCap(pasWithheldExact);
  const balanceExact = minus(q(taxAfterCollectionThreshold), pasWithheldExact);
  return {
    grossSalary,
    standardDeduction,
    netTaxableExact,
    netTaxable,
    parts,
    taxableIncomePerPart,
    taxBeforeFamilyCapExact,
    taxBeforeFamilyCap,
    taxWithOnePart,
    familyQuotientCap,
    familyQuotientAdvantage,
    taxAfterFamilyCap,
    decote,
    taxAfterDecote,
    taxAfterCollectionThreshold,
    pasWithheldExact,
    pasWithheld,
    balanceExact,
    balance: roundCap(balanceExact),
  };
}

function roundCap(value: Exact): bigint {
  return BigInt(report(value));
}

/** Keep the BigInt comparison explicit and auditable. */
function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function buildFields(
  intake: FinanceTaxIntake,
  calculation: France2025Calculation,
) {
  const origins = new Map<string, string[]>();
  const fields: France2025FormField[] = [];
  const trace: France2025Trace[] = [];
  const add = (
    key: string,
    value: Exact,
    dependencies: string[],
    directFacts: readonly string[],
  ) => {
    const sourceFactKeys = [
      ...new Set([
        ...directFacts,
        ...dependencies.flatMap((dependency) => origins.get(dependency) ?? []),
      ]),
    ].sort();
    const definition = FRANCE_2025_FIELD_DEFINITIONS.find(
      (candidate) => candidate.key === key,
    );
    if (!definition) throw new Error(`missing-field-definition:${key}`);
    const fieldId = `2042.${key}`;
    origins.set(key, sourceFactKeys);
    const exact = serialize(value);
    const reportedAmount = report(value);
    fields.push({
      id: fieldId,
      form: '2042',
      line: key,
      label: definition.label,
      dependencies,
      sourceId: definition.sourceId,
      locator: definition.locator,
      exactRational: exact,
      exactDecimal: reportedAmount,
      reportableAmount: reportedAmount,
    });
    trace.push({
      fieldId,
      exactRational: exact,
      reportableAmount: reportedAmount,
      dependsOn: dependencies,
      sourceFactKeys,
      referenceIds: sourceReferenceIds(definition.sourceId).slice(),
    });
    return value;
  };
  add(
    '1AJ.grossSalary',
    calculation.grossSalary,
    [],
    ['employment.grossSalary'],
  );
  add(
    'calc.standardDeduction10',
    calculation.standardDeduction,
    [],
    ['employment.grossSalary', 'deduction.method'],
  );
  add(
    'calc.netTaxableSalary',
    calculation.netTaxableExact,
    ['1AJ.grossSalary', 'calc.standardDeduction10'],
    ['employment.grossSalary'],
  );
  add(
    'calc.familyParts',
    calculation.parts,
    [],
    [
      'family.status',
      'family.dependentChildren',
      'family.raisingFirstChildAlone',
      'family.livesAlone',
    ],
  );
  add(
    'calc.taxableIncomePerPart',
    calculation.taxableIncomePerPart,
    ['calc.netTaxableSalary', 'calc.familyParts'],
    [],
  );
  add(
    'calc.taxBeforeFamilyCap',
    calculation.taxBeforeFamilyCapExact,
    ['calc.taxableIncomePerPart', 'calc.familyParts'],
    [],
  );
  add(
    'calc.familyQuotientCap',
    q(calculation.familyQuotientCap),
    ['calc.familyParts'],
    ['family.dependentChildren', 'family.raisingFirstChildAlone'],
  );
  add(
    'calc.taxAfterFamilyCap',
    q(calculation.taxAfterFamilyCap),
    ['calc.taxBeforeFamilyCap', 'calc.familyQuotientCap'],
    [],
  );
  add(
    'calc.decote',
    q(calculation.decote),
    ['calc.taxAfterFamilyCap'],
    ['family.status'],
  );
  add(
    'calc.taxAfterDecote',
    q(calculation.taxAfterDecote),
    ['calc.taxAfterFamilyCap', 'calc.decote'],
    ['family.status'],
  );
  add(
    'calc.collectionThresholdTax',
    q(calculation.taxAfterCollectionThreshold),
    ['calc.taxAfterDecote'],
    ['family.status'],
  );
  add(
    '8HV.pasWithheld2025',
    calculation.pasWithheldExact,
    [],
    ['pas.calendarYear', 'pas.withheld'],
  );
  add(
    'calc.balanceAfterWithholding',
    calculation.balanceExact,
    ['calc.collectionThresholdTax', '8HV.pasWithheld2025'],
    ['pas.withheld'],
  );
  return { fields, trace };
}

function evaluationWithSources(
  fields: readonly France2025FormField[],
  trace: readonly France2025Trace[],
  issues: readonly FranceIssue[],
): FinanceTaxEvaluation {
  return FinanceTaxEvaluationSchema.parse({
    forms: fields.length
      ? [
          {
            id: '2042',
            version: '2042-2026',
            fields: fields.map((field) => {
              const definition = FRANCE_2025_FIELD_DEFINITIONS.find(
                (candidate) => `2042.${candidate.key}` === field.id,
              );
              const traceRow = trace.find((row) => row.fieldId === field.id);
              if (!definition || !traceRow)
                throw new Error(`unknown-evaluation-field:${field.id}`);
              return {
                key: definition.key,
                value: {
                  type: 'decimal' as const,
                  value: field.reportableAmount,
                },
                ruleIds: [...definition.ruleIds],
                sourceFactKeys: traceRow.sourceFactKeys,
              };
            }),
          },
        ]
      : [],
    issues: issues.map(({ code, message }) => ({ code, message })),
  });
}

/**
 * Executes the pure bounded working-papers graph. It always reports
 * complete=false, enabled=false and reportable=false; calculated values are
 * review figures and do not establish filing readiness or tax-authority
 * acceptance.
 */
export function runFrance2025PersonalWorkflow(
  raw: unknown,
  packageVersion = FRANCE_2025_VERSION,
) {
  const assessed = assessFrance2025Facts(raw);
  const issues = [...assessed.issues];
  if (packageVersion !== FRANCE_2025_VERSION)
    issues.push(
      issue(
        'package-version-mismatch',
        'packageVersion',
        'Historical France rules cannot be silently replaced by another package version.',
      ),
    );
  let calculation: France2025Calculation | null = null;
  let fields: France2025FormField[] = [];
  let trace: France2025Trace[] = [];
  if (!issues.length && assessed.intake) {
    try {
      calculation = calculationFor(assessed.intake);
      ({ fields, trace } = buildFields(assessed.intake, calculation));
    } catch {
      issues.push(
        issue(
          'calculation-error',
          'evaluation',
          'The bounded tax graph could not resolve a required reviewed dependency.',
        ),
      );
      calculation = null;
      fields = [];
      trace = [];
    }
  }
  const evaluation = evaluationWithSources(fields, trace, issues);
  const base = {
    schemaVersion: 1,
    packageId: FRANCE_2025_CANDIDATE.id,
    packageVersion,
    complete: false as const,
    enabled: false as const,
    reportable: false as const,
    registryEligible: false as const,
    status: issues.length
      ? ('blocked-input' as const)
      : ('review-calculation-produced' as const),
    inputSnapshot: assessed.intake,
    inputHash: digest(assessed.intake),
    issues,
    sources: FRANCE_2025_SOURCES,
    sourceReviews: FRANCE_2025_SOURCE_REVIEWS,
    provenance: FRANCE_2025_PROVENANCE,
    releaseBlockers: FRANCE_2025_GAPS,
    reportingPolicyVersion: 'france-2025-income-2026-return-whole-euro-v1',
    fields,
    trace,
    evaluation,
    calculation,
    formCoverage: [
      {
        formId: '2042',
        formVersion: '2042-2026',
        fieldCount: fields.length,
        complete: false,
      },
    ],
    finalAmounts: { refund: null, balanceOwing: null },
  };
  return deepFreeze({ ...base, runHash: digest(base) });
}

export function evaluateFrance2025Return(
  input: Readonly<FinanceTaxIntake>,
): FinanceTaxEvaluation {
  return FinanceTaxEvaluationSchema.parse(
    runFrance2025PersonalWorkflow(input).evaluation,
  );
}

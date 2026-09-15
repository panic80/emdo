import { createHash } from 'node:crypto';
import {
  deepFreeze,
  FinanceTaxFactSchema,
  FinanceTaxIntakeSchema,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import { z } from 'zod';
import {
  compare,
  decimal,
  floor,
  floorThousandYen,
  format,
  isWholeYen,
  minus,
  plus,
  positive,
  q,
  serialize,
  times,
  type Q,
} from './exact.js';
import { JAPAN_2025_SOURCES } from './sources.js';

export const JAPAN_2025_CORPORATION_PACKAGE_VERSION =
  '2025.1-standalone-corporation-form-1-chain.1';

export const JAPAN_2025_CORPORATION_SCOPE = deepFreeze({
  country: 'JP',
  subdivision: 'JP-NATIONAL',
  taxpayerType: 'corporation' as const,
  year: 2025,
  regime: 'corporate-income-tax-return',
  formVersion: 'r07-corporation-form-1',
});

type CorporationFactType = 'text' | 'date' | 'boolean' | 'decimal';
type CorporationRequirement = {
  key: string;
  type: CorporationFactType;
  sourceId: string;
  equals?: string | boolean;
};

/**
 * This deliberately narrow corporate branch covers a 12-month domestic
 * ordinary standalone corporation whose accounting profit already reconciles
 * to the taxable-income amount transferred from Form 4.  It excludes every
 * adjustment, credit, loss, group, interim-payment and special-tax branch so
 * the rate and local-corporate-tax chain cannot silently assume a zero.
 */
export const JAPAN_2025_CORPORATION_REQUIRED_FACTS = deepFreeze([
  {
    key: 'corporation.returnType',
    type: 'text',
    sourceId: 'nta-jp-r07-corporation-forms',
  },
  {
    key: 'corporation.legalName',
    type: 'text',
    sourceId: 'nta-jp-r07-corporation-forms',
  },
  {
    key: 'corporation.corporateNumber',
    type: 'text',
    sourceId: 'nta-jp-r07-corporation-forms',
  },
  {
    key: 'corporation.address',
    type: 'text',
    sourceId: 'nta-jp-r07-corporation-forms',
  },
  {
    key: 'corporation.fiscalStart',
    type: 'date',
    sourceId: 'nta-jp-r07-corporation-guide',
    equals: '2025-01-01',
  },
  {
    key: 'corporation.fiscalEnd',
    type: 'date',
    sourceId: 'nta-jp-r07-corporation-guide',
    equals: '2025-12-31',
  },
  {
    key: 'corporation.fiscalMonths',
    type: 'decimal',
    sourceId: 'nta-jp-r07-corporation-guide',
    equals: '12',
  },
  {
    key: 'corporation.isDomesticOrdinary',
    type: 'boolean',
    sourceId: 'nta-jp-r07-corporation-small-company-criteria',
    equals: true,
  },
  {
    key: 'corporation.isStandalone',
    type: 'boolean',
    sourceId: 'nta-jp-r07-corporation-forms',
    equals: true,
  },
  {
    key: 'corporation.isSmallCompany',
    type: 'boolean',
    sourceId: 'nta-jp-r07-corporation-small-company-criteria',
    equals: true,
  },
  {
    key: 'corporation.notExcludedCompany',
    type: 'boolean',
    sourceId: 'nta-jp-r07-corporation-small-company-criteria',
    equals: true,
  },
  {
    key: 'corporation.capital',
    type: 'decimal',
    sourceId: 'nta-jp-r07-corporation-small-company-criteria',
  },
  {
    key: 'corporation.noTaxAdjustments',
    type: 'boolean',
    sourceId: 'nta-jp-r07-corporation-form-1-instructions',
    equals: true,
  },
  {
    key: 'corporation.noTaxCredits',
    type: 'boolean',
    sourceId: 'nta-jp-r07-corporation-form-1-instructions',
    equals: true,
  },
  {
    key: 'corporation.noForeignTax',
    type: 'boolean',
    sourceId: 'nta-jp-r07-corporation-form-1-instructions',
    equals: true,
  },
  {
    key: 'corporation.noDeficits',
    type: 'boolean',
    sourceId: 'nta-jp-r07-corporation-form-1-instructions',
    equals: true,
  },
  {
    key: 'corporation.noConsolidatedGroup',
    type: 'boolean',
    sourceId: 'nta-jp-r07-corporation-guide',
    equals: true,
  },
  {
    key: 'corporation.noSpecialTaxMeasures',
    type: 'boolean',
    sourceId: 'nta-jp-r07-corporation-form-1-instructions',
    equals: true,
  },
  {
    key: 'corporation.noInterimPayments',
    type: 'boolean',
    sourceId: 'nta-jp-r07-corporation-guide',
    equals: true,
  },
  {
    key: 'corporation.accountingProfit',
    type: 'decimal',
    sourceId: 'nta-jp-r07-corporation-form-1-instructions',
  },
  {
    key: 'corporation.taxableIncome',
    type: 'decimal',
    sourceId: 'nta-jp-r07-corporation-form-1-instructions',
  },
  {
    key: 'corporation.incomeTaxWithheld',
    type: 'decimal',
    sourceId: 'nta-jp-r07-corporation-form-1-instructions',
    equals: '0',
  },
  {
    key: 'corporation.interimCorporateTax',
    type: 'decimal',
    sourceId: 'nta-jp-r07-corporation-guide',
    equals: '0',
  },
  {
    key: 'corporation.interimLocalCorporateTax',
    type: 'decimal',
    sourceId: 'nta-jp-r07-corporation-guide',
    equals: '0',
  },
] as const satisfies readonly CorporationRequirement[]);

export const JAPAN_2025_CORPORATION_RELEASE_BLOCKERS = deepFreeze([
  'selected-form-1-chain-no-complete-corporation-return',
  'form-1-continuation-and-all-applicable-corporate-schedules-not-complete',
  'corporate-accounting-to-taxable-income-adjustments-not-implemented',
  'corporate-loss-carryforwards-credits-foreign-tax-and-special-measures-not-implemented',
  'corporate-local-inhabitant-tax-enterprise-tax-and-per-capita-tax-not-implemented',
  'defense-special-corporate-tax-outside-the-2025-calendar-branch',
  'consumption-tax-payroll-and-e-tax-filing-not-implemented',
] as const);

export const JAPAN_2025_CORPORATION_CANDIDATE = deepFreeze({
  id: 'jp-national-2025-standalone-corporation-form-1-chain',
  version: JAPAN_2025_CORPORATION_PACKAGE_VERSION,
  enabled: false,
  registryEligible: false,
  complete: false,
  scope: JAPAN_2025_CORPORATION_SCOPE,
  coverage:
    'Selected standalone domestic ordinary-corporation Form 1 working chain for a 12-month 2025 fiscal year: explicit taxable-income transfer, 15%/23.2% ordinary small-company corporate tax, 10.3% local corporate tax, and zero-payment settlement. All accounting adjustments, schedules, credits, local inhabitant/enterprise/per-capita taxes, defense special tax and filing actions remain outside the candidate.',
  forms: ['JP-Corporation-Form-1-Blue', 'JP-Corporation-Form-1-White'],
  references: JAPAN_2025_SOURCES,
  requiredFacts: JAPAN_2025_CORPORATION_REQUIRED_FACTS,
  releaseBlockers: JAPAN_2025_CORPORATION_RELEASE_BLOCKERS,
});

type CorporationIssue = { code: string; message: string };
type CorporationField = {
  id: string;
  form: string;
  line: string;
  label: string;
  exactRational: { numerator: string; denominator: string } | null;
  exactYen: string | null;
  reportableAmount: string | null;
  sourceId: string;
  sourceFactKeys: string[];
  dependencies: string[];
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

function exactScopeMatches(intake: FinanceTaxIntake): boolean {
  return Object.entries(JAPAN_2025_CORPORATION_SCOPE).every(
    ([key, value]) =>
      intake.scope[key as keyof typeof JAPAN_2025_CORPORATION_SCOPE] === value,
  );
}

function factAmount(
  facts: ReadonlyMap<string, z.infer<typeof FinanceTaxFactSchema>>,
  key: string,
): Q {
  const fact = facts.get(key);
  if (!fact || fact.value.type !== 'decimal')
    throw new Error(`decimal-fact-required:${key}`);
  return decimal(fact.value.value);
}

function factEqual(
  actual: unknown,
  expected: unknown,
  type: CorporationFactType,
) {
  if (type !== 'decimal') return actual === expected;
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  try {
    return compare(decimal(actual), decimal(expected)) === 0n;
  } catch {
    return false;
  }
}

function floorHundredYen(value: Q): Q {
  return q((floor(positive(value)) / 100n) * 100n);
}

/** Validate the standalone corporate Form 1 chain input boundary. */
export function assessJapan2025CorporationFacts(raw: unknown) {
  const parsed = FinanceTaxIntakeSchema.safeParse(raw);
  const issues: CorporationIssue[] = [];
  const addIssue = (code: string, message: string) =>
    issues.push({ code, message });
  if (!parsed.success) {
    addIssue(
      'invalid-intake',
      'Generic tax intake or source lineage is invalid.',
    );
    return { intake: null, issues, returnType: null };
  }
  const intake = parsed.data;
  if (!exactScopeMatches(intake))
    addIssue(
      'unsupported-scope',
      'Requires JP-NATIONAL standalone corporation corporate-income-tax-return scope, calendar 2025 and the pinned 2025 corporate Form 1 version.',
    );
  if (
    intake.domesticResident !== true ||
    intake.hasCrossBorderActivity !== false ||
    intake.standaloneCorporation !== true ||
    intake.requestedFeatures.length !== 1 ||
    intake.requestedFeatures[0] !== 'income-tax-return'
  )
    addIssue(
      'unsupported-scope',
      'Only a domestic standalone corporation return is covered; foreign, group, payroll, e-filing, consolidation and cross-border cases are outside this package.',
    );
  const sourceFacts = new Map(intake.facts.map((fact) => [fact.key, fact]));
  const typeFact = sourceFacts.get('corporation.returnType');
  const returnType =
    typeFact?.reviewState === 'reviewed' && typeFact.value.type === 'text'
      ? typeFact.value.value
      : null;
  if (returnType !== 'blue' && returnType !== 'white')
    addIssue(
      'unsupported-return-type',
      'Return type must be the reviewed text value blue or white.',
    );
  const requiredFacts: readonly CorporationRequirement[] =
    JAPAN_2025_CORPORATION_REQUIRED_FACTS;
  const required = new Set<string>(requiredFacts.map((fact) => fact.key));
  for (const fact of intake.facts)
    if (!required.has(fact.key))
      addIssue(
        'unsupported-fact',
        `Unmapped fact is not silently ignored: ${fact.key}`,
      );
  for (const requirement of requiredFacts) {
    const fact = sourceFacts.get(requirement.key);
    if (!fact) {
      addIssue(
        'missing-reviewed-fact',
        `Reviewed ${requirement.type} fact required: ${requirement.key}`,
      );
      continue;
    }
    if (fact.reviewState !== 'reviewed')
      addIssue('unreviewed-fact', `Reviewed fact required: ${requirement.key}`);
    if (fact.value.type !== requirement.type) {
      addIssue(
        'wrong-fact-type',
        `Expected ${requirement.type} for ${requirement.key}`,
      );
      continue;
    }
    if (
      requirement.equals !== undefined &&
      !factEqual(fact.value.value, requirement.equals, requirement.type)
    )
      addIssue('unsupported-fact', `Unsupported value for ${requirement.key}`);
    if (requirement.type === 'text' && !String(fact.value.value).trim())
      addIssue('invalid-text', `Nonempty text required: ${requirement.key}`);
    if (requirement.type === 'decimal') {
      try {
        const value = decimal(String(fact.value.value));
        if (value.n < 0n || !isWholeYen(value))
          addIssue(
            'invalid-money',
            `Nonnegative whole-JPY source amount required: ${requirement.key}`,
          );
      } catch {
        addIssue('invalid-money', `Invalid JPY amount: ${requirement.key}`);
      }
    }
  }
  const corporateNumberFact = sourceFacts.get('corporation.corporateNumber');
  if (corporateNumberFact?.value.type === 'text') {
    if (!/^\d{13}$/.test(corporateNumberFact.value.value))
      addIssue(
        'invalid-corporate-number',
        'Japanese corporate number must contain 13 digits.',
      );
  }
  if (sourceFacts.get('corporation.capital')?.value.type === 'decimal') {
    try {
      const capital = factAmount(sourceFacts, 'corporation.capital');
      if (compare(capital, q(100_000_000n)) > 0)
        addIssue(
          'small-company-capital-limit',
          'Selected small-company rate branch requires capital or contributions of 100,000,000 yen or less.',
        );
    } catch {
      // The required-fact loop already records invalid-money. Keep this
      // repeated cross-field check fail closed instead of throwing.
    }
  }
  if (
    sourceFacts.get('corporation.accountingProfit')?.value.type === 'decimal' &&
    sourceFacts.get('corporation.taxableIncome')?.value.type === 'decimal'
  ) {
    try {
      const accountingProfit = factAmount(
        sourceFacts,
        'corporation.accountingProfit',
      );
      const taxableIncome = factAmount(
        sourceFacts,
        'corporation.taxableIncome',
      );
      if (compare(accountingProfit, taxableIncome) !== 0n)
        addIssue(
          'taxable-income-reconciliation-mismatch',
          'Selected no-adjustment branch requires accounting profit to equal taxable income transferred to Form 1.',
        );
      if (taxableIncome.n < 0n)
        addIssue(
          'corporate-loss-not-supported',
          'Negative taxable income requires the loss return and schedules outside this selected chain.',
        );
    } catch {
      // The required-fact loop already records invalid-money. Keep this
      // repeated reconciliation check fail closed instead of throwing.
    }
  }
  return { intake, issues, returnType: returnType as 'blue' | 'white' | null };
}

/**
 * Calculate the selected ordinary small-company corporate Form 1 chain.  The
 * result includes base corporate tax and national local corporate tax only;
 * local inhabitant/enterprise/per-capita taxes and the rest of the return are
 * explicitly outside this package.
 */
export function runJapan2025StandaloneCorporation(raw: unknown) {
  const assessed = assessJapan2025CorporationFacts(raw);
  const issues = [...assessed.issues];
  const fields: CorporationField[] = [];
  const intake = assessed.intake;
  const returnType = assessed.returnType;
  const form =
    returnType === 'blue'
      ? 'JP-Corporation-Form-1-Blue'
      : 'JP-Corporation-Form-1-White';
  const finish = (calculations: Record<string, string> | null) => {
    const selectedComplete = Boolean(
      intake && returnType && issues.length === 0 && fields.length > 0,
    );
    const body = {
      candidate: JAPAN_2025_CORPORATION_CANDIDATE,
      scope: JAPAN_2025_CORPORATION_SCOPE,
      returnType,
      packageVersion: JAPAN_2025_CORPORATION_PACKAGE_VERSION,
      enabled: false as const,
      registryEligible: false as const,
      complete: false as const,
      selectedComplete,
      formDataReady: selectedComplete,
      reportable: false as const,
      fileable: false as const,
      status: fields.length
        ? ('incomplete-corporate-working-papers' as const)
        : ('blocked-input' as const),
      inputSnapshot: intake,
      inputHash: intake ? hash(intake) : null,
      sources: JAPAN_2025_SOURCES,
      fields,
      calculations,
      formCoverage: [
        {
          id: form,
          complete: selectedComplete,
          fieldCount: fields.length,
          sourceId:
            returnType === 'blue'
              ? 'nta-jp-r07-corporation-form-1-blue'
              : 'nta-jp-r07-corporation-form-1-white',
        },
      ],
      issues,
      releaseBlockers: JAPAN_2025_CORPORATION_RELEASE_BLOCKERS,
      fullReturnGaps: [
        'corporate-form-1-continuation-and-form-4-taxable-income-adjustments',
        'corporate-form-5-1-and-form-5-2-equity-and-tax-payment-schedules',
        'corporate-credit-foreign-tax-loss-and-special-measure-schedules',
        'corporate-local-inhabitant-enterprise-and-per-capita-tax',
        'defense-special-corporate-tax-for-2026-starting-years',
        'consumption-tax-payroll-e-tax-and-filing-submission',
      ],
      definitionHash: hash(JAPAN_2025_CORPORATION_CANDIDATE),
    };
    return deepFreeze({ ...body, outputHash: hash(body) });
  };
  if (!intake || !returnType || issues.length) return finish(null);
  const facts = new Map(intake.facts.map((fact) => [fact.key, fact]));
  const direct = (
    id: string,
    line: string,
    label: string,
    key: string,
    sourceId: string,
  ) => {
    const value = facts.get(key);
    if (!value) return;
    const exact =
      value.value.type === 'decimal' ? decimal(value.value.value) : null;
    fields.push({
      id,
      form,
      line,
      label,
      exactRational: exact ? serialize(exact) : null,
      exactYen: exact ? format(exact) : null,
      reportableAmount: exact ? format(exact) : null,
      sourceId,
      sourceFactKeys: [key],
      dependencies: [],
    });
  };
  const calculated = (
    id: string,
    line: string,
    label: string,
    value: Q,
    sourceId: string,
    dependencies: string[],
    sourceFactKeys: string[],
  ) =>
    fields.push({
      id,
      form,
      line,
      label,
      exactRational: serialize(value),
      exactYen: format(value),
      reportableAmount: isWholeYen(value) ? format(value) : null,
      sourceId,
      sourceFactKeys: [...sourceFactKeys].sort(),
      dependencies,
    });
  direct(
    'corporation.legalName',
    'identity.legalName',
    'Corporation legal name',
    'corporation.legalName',
    'nta-jp-r07-corporation-forms',
  );
  direct(
    'corporation.corporateNumber',
    'identity.corporateNumber',
    'Corporate number',
    'corporation.corporateNumber',
    'nta-jp-r07-corporation-forms',
  );
  direct(
    'corporation.address',
    'identity.address',
    'Corporation address',
    'corporation.address',
    'nta-jp-r07-corporation-forms',
  );
  direct(
    'corporation.accountingProfit',
    '4.accountingProfit',
    'Accounting profit transferred to Form 4 bridge',
    'corporation.accountingProfit',
    'nta-jp-r07-corporation-form-1-instructions',
  );
  direct(
    'corporation.taxableIncome',
    '1.taxableIncome',
    'Taxable income transferred to Form 1 line 1',
    'corporation.taxableIncome',
    'nta-jp-r07-corporation-form-1-instructions',
  );
  direct(
    'corporation.capital',
    'small-company.capital',
    'Capital or contributions for small-company classification',
    'corporation.capital',
    'nta-jp-r07-corporation-small-company-criteria',
  );
  const taxableIncome = factAmount(facts, 'corporation.taxableIncome');
  const roundedTaxableIncome = floorThousandYen(taxableIncome);
  const smallRateBase =
    roundedTaxableIncome.n <= 8_000_000n ? roundedTaxableIncome : q(8_000_000n);
  const excessRateBase =
    roundedTaxableIncome.n > 8_000_000n
      ? minus(roundedTaxableIncome, q(8_000_000n))
      : q(0n);
  const smallTax = times(smallRateBase, 15n, 100n);
  const excessTax = times(excessRateBase, 232n, 1_000n);
  const corporateTax = plus(smallTax, excessTax);
  const corporateTaxDeclared = floorHundredYen(corporateTax);
  const localCorporateTaxExact = times(corporateTax, 103n, 1_000n);
  const localCorporateTaxDeclared = floorHundredYen(localCorporateTaxExact);
  const combinedExact = plus(corporateTax, localCorporateTaxExact);
  const combinedDeclared = plus(
    corporateTaxDeclared,
    localCorporateTaxDeclared,
  );
  calculated(
    'corporation.taxableIncomeThousandFloor',
    '1.taxableIncomeThousandFloor',
    'Taxable income after 1,000-yen truncation',
    roundedTaxableIncome,
    'nta-jp-r07-corporation-form-1-instructions',
    ['corporation.taxableIncome'],
    ['corporation.taxableIncome'],
  );
  calculated(
    'corporation.smallRateBase',
    '2.smallRateBase',
    'Income up to annual 8,000,000-yen small-company band',
    smallRateBase,
    'nta-jp-r07-corporation-guide',
    ['corporation.taxableIncomeThousandFloor'],
    ['corporation.taxableIncome'],
  );
  calculated(
    'corporation.excessRateBase',
    '2.excessRateBase',
    'Income above annual 8,000,000-yen band',
    excessRateBase,
    'nta-jp-r07-corporation-guide',
    ['corporation.taxableIncomeThousandFloor'],
    ['corporation.taxableIncome'],
  );
  calculated(
    'corporation.smallRateTax',
    '8.smallRateTax',
    'Corporate tax at supported 15% small-company rate',
    smallTax,
    'nta-jp-r07-corporation-guide',
    ['corporation.smallRateBase'],
    ['corporation.taxableIncome'],
  );
  calculated(
    'corporation.excessRateTax',
    '9.excessRateTax',
    'Corporate tax at 23.2% excess rate',
    excessTax,
    'nta-jp-r07-corporation-guide',
    ['corporation.excessRateBase'],
    ['corporation.taxableIncome'],
  );
  calculated(
    'corporation.corporateTax',
    '13.corporateTax',
    'Base corporate tax before credits',
    corporateTax,
    'nta-jp-r07-corporation-guide',
    ['corporation.smallRateTax', 'corporation.excessRateTax'],
    ['corporation.taxableIncome'],
  );
  direct(
    'corporation.incomeTaxWithheld',
    '16.incomeTaxWithheld',
    'Income tax credit/withholding (explicit zero)',
    'corporation.incomeTaxWithheld',
    'nta-jp-r07-corporation-form-1-instructions',
  );
  direct(
    'corporation.interimCorporateTax',
    '22.interimCorporateTax',
    'Interim corporate tax (explicit zero)',
    'corporation.interimCorporateTax',
    'nta-jp-r07-corporation-guide',
  );
  calculated(
    'corporation.corporateTaxDeclared',
    '15.corporateTaxDue',
    'Corporate tax due after positive 100-yen truncation',
    corporateTaxDeclared,
    'nta-jp-r07-corporation-form-1-instructions',
    [
      'corporation.corporateTax',
      'corporation.incomeTaxWithheld',
      'corporation.interimCorporateTax',
    ],
    [
      'corporation.taxableIncome',
      'corporation.incomeTaxWithheld',
      'corporation.interimCorporateTax',
    ],
  );
  calculated(
    'corporation.localCorporateTaxExact',
    '28.localCorporateTaxExact',
    'National local corporate tax at 10.3% before declaration rounding',
    localCorporateTaxExact,
    'nta-jp-r07-corporation-guide',
    ['corporation.corporateTax'],
    ['corporation.taxableIncome'],
  );
  calculated(
    'corporation.localCorporateTaxDeclared',
    '31.localCorporateTaxDue',
    'National local corporate tax due after positive 100-yen truncation',
    localCorporateTaxDeclared,
    'nta-jp-r07-corporation-form-1-instructions',
    [
      'corporation.localCorporateTaxExact',
      'corporation.interimLocalCorporateTax',
    ],
    ['corporation.taxableIncome', 'corporation.interimLocalCorporateTax'],
  );
  direct(
    'corporation.interimLocalCorporateTax',
    '42.interimLocalCorporateTax',
    'Interim national local corporate tax (explicit zero)',
    'corporation.interimLocalCorporateTax',
    'nta-jp-r07-corporation-guide',
  );
  calculated(
    'corporation.combinedExact',
    'combined.exact',
    'Combined corporate and national local corporate tax before payment rounding',
    combinedExact,
    'nta-jp-r07-corporation-guide',
    ['corporation.corporateTax', 'corporation.localCorporateTaxExact'],
    ['corporation.taxableIncome'],
  );
  calculated(
    'corporation.combinedDeclared',
    'combined.due',
    'Combined selected national corporate tax due',
    combinedDeclared,
    'nta-jp-r07-corporation-form-1-instructions',
    [
      'corporation.corporateTaxDeclared',
      'corporation.localCorporateTaxDeclared',
    ],
    [
      'corporation.taxableIncome',
      'corporation.incomeTaxWithheld',
      'corporation.interimCorporateTax',
      'corporation.interimLocalCorporateTax',
    ],
  );
  return finish({
    accountingProfit: format(factAmount(facts, 'corporation.accountingProfit')),
    taxableIncome: format(taxableIncome),
    taxableIncomeThousandFloor: format(roundedTaxableIncome),
    smallRateBase: format(smallRateBase),
    excessRateBase: format(excessRateBase),
    corporateTax: format(corporateTax),
    corporateTaxDeclared: format(corporateTaxDeclared),
    localCorporateTaxExact: format(localCorporateTaxExact),
    localCorporateTaxDeclared: format(localCorporateTaxDeclared),
    combinedExact: format(combinedExact),
    combinedDeclared: format(combinedDeclared),
  });
}

export type Japan2025CorporationRun = ReturnType<
  typeof runJapan2025StandaloneCorporation
>;

export const evaluateJapan2025StandaloneCorporation =
  runJapan2025StandaloneCorporation;

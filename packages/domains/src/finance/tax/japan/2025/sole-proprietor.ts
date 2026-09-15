import { createHash } from 'node:crypto';
import {
  deepFreeze,
  FinanceTaxFactSchema,
  FinanceTaxIntakeSchema,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import { z } from 'zod';
import {
  decimal,
  format,
  isWholeYen,
  minus,
  plus,
  q,
  serialize,
  type Q,
} from './exact.js';
import { JAPAN_2025_SOURCES } from './sources.js';

export const JAPAN_2025_SOLE_PROPRIETOR_PACKAGE_VERSION =
  '2025.1-sole-proprietor-general-schedules.1';

export const JAPAN_2025_SOLE_PROPRIETOR_SCOPE = deepFreeze({
  country: 'JP',
  subdivision: 'JP-NATIONAL',
  taxpayerType: 'sole-proprietor' as const,
  year: 2025,
  regime: 'income-tax-return',
  formVersion: 'r07-form-1-2-business-general',
});

type SoleFactType = 'text' | 'date' | 'boolean' | 'decimal';
type SoleRequirement = {
  key: string;
  type: SoleFactType;
  sourceId: string;
  when?: 'blue';
  equals?: string | boolean;
};

const commonSource = 'nta-jp-r07-white-business-general';
const commonFacts: readonly SoleRequirement[] = [
  {
    key: 'return.type',
    type: 'text',
    sourceId: 'nta-jp-r07-forms',
  },
  {
    key: 'business.taxpayerName',
    type: 'text',
    sourceId: 'nta-jp-r07-forms',
  },
  {
    key: 'business.tradeName',
    type: 'text',
    sourceId: 'nta-jp-r07-forms',
  },
  {
    key: 'business.address',
    type: 'text',
    sourceId: 'nta-jp-r07-forms',
  },
  {
    key: 'business.industry',
    type: 'text',
    sourceId: 'nta-jp-r07-forms',
  },
  {
    key: 'business.fiscalStart',
    type: 'date',
    sourceId: commonSource,
    equals: '2025-01-01',
  },
  {
    key: 'business.fiscalEnd',
    type: 'date',
    sourceId: commonSource,
    equals: '2025-12-31',
  },
  {
    key: 'business.singleActivity',
    type: 'boolean',
    sourceId: commonSource,
    equals: true,
  },
  {
    key: 'business.noEmployees',
    type: 'boolean',
    sourceId: commonSource,
    equals: true,
  },
  {
    key: 'business.noInventory',
    type: 'boolean',
    sourceId: commonSource,
    equals: true,
  },
  {
    key: 'business.noConsumptionTax',
    type: 'boolean',
    sourceId: commonSource,
    equals: true,
  },
  {
    key: 'business.noOtherIncome',
    type: 'boolean',
    sourceId: commonSource,
    equals: true,
  },
  {
    key: 'business.noLossCarryforward',
    type: 'boolean',
    sourceId: commonSource,
    equals: true,
  },
  {
    key: 'business.noSpecialExpenses',
    type: 'boolean',
    sourceId: commonSource,
    equals: true,
  },
  {
    key: 'business.noVehicleHomeOffice',
    type: 'boolean',
    sourceId: commonSource,
    equals: true,
  },
  {
    key: 'business.grossReceipts',
    type: 'decimal',
    sourceId: commonSource,
  },
  {
    key: 'business.salesReturns',
    type: 'decimal',
    sourceId: commonSource,
    equals: '0',
  },
  {
    key: 'business.costOfSales',
    type: 'decimal',
    sourceId: commonSource,
  },
  {
    key: 'business.personnel',
    type: 'decimal',
    sourceId: commonSource,
  },
  {
    key: 'business.outsourcing',
    type: 'decimal',
    sourceId: commonSource,
  },
  {
    key: 'business.rent',
    type: 'decimal',
    sourceId: commonSource,
  },
  {
    key: 'business.utilities',
    type: 'decimal',
    sourceId: commonSource,
  },
  {
    key: 'business.communication',
    type: 'decimal',
    sourceId: commonSource,
  },
  {
    key: 'business.supplies',
    type: 'decimal',
    sourceId: commonSource,
  },
  {
    key: 'business.travel',
    type: 'decimal',
    sourceId: commonSource,
  },
  {
    key: 'business.advertising',
    type: 'decimal',
    sourceId: commonSource,
  },
  {
    key: 'business.insurance',
    type: 'decimal',
    sourceId: commonSource,
  },
  {
    key: 'business.taxesAndDues',
    type: 'decimal',
    sourceId: commonSource,
  },
  {
    key: 'business.interest',
    type: 'decimal',
    sourceId: commonSource,
  },
  {
    key: 'business.depreciation',
    type: 'decimal',
    sourceId: commonSource,
  },
  {
    key: 'business.otherExpenses',
    type: 'decimal',
    sourceId: commonSource,
  },
];

const blueFacts: readonly SoleRequirement[] = [
  {
    key: 'return.blueBooksComplete',
    type: 'boolean',
    sourceId: 'nta-jp-r07-blue-business-general-handbook',
    when: 'blue',
    equals: true,
  },
  {
    key: 'return.blueSpecialDeduction',
    type: 'decimal',
    sourceId: 'nta-jp-r07-blue-business-general-guide',
    when: 'blue',
    equals: '0',
  },
  {
    key: 'balance.cash',
    type: 'decimal',
    sourceId: 'nta-jp-r07-blue-business-general',
    when: 'blue',
  },
  {
    key: 'balance.accountsReceivable',
    type: 'decimal',
    sourceId: 'nta-jp-r07-blue-business-general',
    when: 'blue',
  },
  {
    key: 'balance.inventory',
    type: 'decimal',
    sourceId: 'nta-jp-r07-blue-business-general',
    when: 'blue',
    equals: '0',
  },
  {
    key: 'balance.fixedAssets',
    type: 'decimal',
    sourceId: 'nta-jp-r07-blue-business-general',
    when: 'blue',
  },
  {
    key: 'balance.otherAssets',
    type: 'decimal',
    sourceId: 'nta-jp-r07-blue-business-general',
    when: 'blue',
  },
  {
    key: 'balance.accountsPayable',
    type: 'decimal',
    sourceId: 'nta-jp-r07-blue-business-general',
    when: 'blue',
  },
  {
    key: 'balance.loans',
    type: 'decimal',
    sourceId: 'nta-jp-r07-blue-business-general',
    when: 'blue',
  },
  {
    key: 'balance.otherLiabilities',
    type: 'decimal',
    sourceId: 'nta-jp-r07-blue-business-general',
    when: 'blue',
  },
  {
    key: 'balance.capital',
    type: 'decimal',
    sourceId: 'nta-jp-r07-blue-business-general',
    when: 'blue',
  },
];

export const JAPAN_2025_SOLE_PROPRIETOR_REQUIRED_FACTS = deepFreeze([
  ...commonFacts,
  ...blueFacts,
] as const);

export const JAPAN_2025_SOLE_PROPRIETOR_RELEASE_BLOCKERS = deepFreeze([
  'selected-schedule-only-no-complete-national-return',
  'form-1-and-form-2-business-return-field-and-attachment-coverage-not-complete',
  'sole-proprietor-blue-special-deduction-nonzero-not-supported',
  'blue-return-accounting-evidence-and-balance-sheet-reconciliation-not-independent',
  'white-return-expense-substantiation-and-business-use-allocation-not-independent',
  'local-inhabitant-tax-and-business-tax-not-implemented',
  'consumption-tax-and-invoice-rules-not-implemented',
  'payroll-and-filing-submission-not-implemented',
] as const);

export const JAPAN_2025_SOLE_PROPRIETOR_CANDIDATE = deepFreeze({
  id: 'jp-national-2025-sole-proprietor-general-schedules',
  version: JAPAN_2025_SOLE_PROPRIETOR_PACKAGE_VERSION,
  enabled: false,
  registryEligible: false,
  complete: false,
  scope: JAPAN_2025_SOLE_PROPRIETOR_SCOPE,
  coverage:
    'Selected general business-income schedule working papers for a full-calendar-year domestic resident sole proprietor. White return uses explicit gross receipts and expense categories; blue return additionally requires a zero blue special deduction, complete books declaration, and a balanced selected balance-sheet subset. Neither branch is a complete national, local, consumption-tax or filing return.',
  forms: [
    'JP-Form-1',
    'JP-Form-2',
    'JP-White-Business-General',
    'JP-Blue-Business-General',
  ],
  references: JAPAN_2025_SOURCES,
  requiredFacts: JAPAN_2025_SOLE_PROPRIETOR_REQUIRED_FACTS,
  releaseBlockers: JAPAN_2025_SOLE_PROPRIETOR_RELEASE_BLOCKERS,
});

type SoleIssue = { code: string; message: string };
type SoleField = {
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
  return Object.entries(JAPAN_2025_SOLE_PROPRIETOR_SCOPE).every(
    ([key, value]) =>
      intake.scope[key as keyof typeof JAPAN_2025_SOLE_PROPRIETOR_SCOPE] ===
      value,
  );
}

function amount(
  facts: ReadonlyMap<string, z.infer<typeof FinanceTaxFactSchema>>,
  key: string,
): Q {
  const fact = facts.get(key);
  if (!fact || fact.value.type !== 'decimal')
    throw new Error(`decimal-fact-required:${key}`);
  return decimal(fact.value.value);
}

function factEqual(actual: unknown, expected: unknown, type: SoleFactType) {
  if (type !== 'decimal') return actual === expected;
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  try {
    return (
      decimal(actual).n * decimal(expected).d ===
      decimal(expected).n * decimal(actual).d
    );
  } catch {
    return false;
  }
}

/** Validate the dedicated sole-proprietor schedule input boundary. */
export function assessJapan2025SoleProprietorFacts(raw: unknown) {
  const parsed = FinanceTaxIntakeSchema.safeParse(raw);
  const issues: SoleIssue[] = [];
  const addIssue = (code: string, message: string) =>
    issues.push({ code, message });
  if (!parsed.success) {
    addIssue(
      'invalid-intake',
      'Generic tax intake or source lineage is invalid.',
    );
    return { intake: null, issues };
  }
  const intake = parsed.data;
  if (!exactScopeMatches(intake))
    addIssue(
      'unsupported-scope',
      'Requires JP-NATIONAL sole-proprietor income-tax-return scope, calendar 2025 (令和7年分), and general-business Form 1/2 schedule version.',
    );
  if (
    intake.domesticResident !== true ||
    intake.hasCrossBorderActivity !== false ||
    intake.standaloneCorporation !== null ||
    intake.requestedFeatures.length !== 1 ||
    intake.requestedFeatures[0] !== 'income-tax-return'
  )
    addIssue(
      'unsupported-scope',
      'Only a full-calendar-year domestic resident sole proprietor income-tax-return schedule is covered; payroll, e-filing, consolidation and cross-border cases are outside this package.',
    );
  const sourceFacts = new Map(intake.facts.map((fact) => [fact.key, fact]));
  const typeFact = sourceFacts.get('return.type');
  const returnType =
    typeFact?.reviewState === 'reviewed' && typeFact.value.type === 'text'
      ? typeFact.value.value
      : null;
  if (returnType !== 'blue' && returnType !== 'white')
    addIssue(
      'unsupported-return-type',
      'Return type must be the reviewed text value blue or white.',
    );
  const activeRequirements = JAPAN_2025_SOLE_PROPRIETOR_REQUIRED_FACTS.filter(
    (requirement) => !requirement.when || returnType === requirement.when,
  );
  const required = new Set(
    activeRequirements.map((requirement) => requirement.key),
  );
  for (const fact of intake.facts)
    if (!required.has(fact.key))
      addIssue(
        'unsupported-fact',
        `Unmapped or inactive fact is not silently ignored: ${fact.key}`,
      );
  for (const requirement of activeRequirements) {
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
  if (returnType === 'blue') {
    const assets = [
      'balance.cash',
      'balance.accountsReceivable',
      'balance.inventory',
      'balance.fixedAssets',
      'balance.otherAssets',
    ];
    const liabilities = [
      'balance.accountsPayable',
      'balance.loans',
      'balance.otherLiabilities',
      'balance.capital',
    ];
    if (!issues.length) {
      const assetTotal = assets.reduce(
        (total, key) => plus(total, amount(sourceFacts, key)),
        q(0n),
      );
      const liabilityTotal = liabilities.reduce(
        (total, key) => plus(total, amount(sourceFacts, key)),
        q(0n),
      );
      if (assetTotal.n * liabilityTotal.d !== liabilityTotal.n * assetTotal.d)
        addIssue(
          'blue-balance-sheet-unbalanced',
          'Selected blue-return balance-sheet assets must equal liabilities plus capital.',
        );
    }
  }
  return { intake, issues, returnType: returnType as 'blue' | 'white' | null };
}

/**
 * Calculate selected general blue/white business schedule working papers.
 * `selectedComplete` only covers the schedule subset; it never changes the
 * full-return, reportable or filing flags.
 */
export function runJapan2025SoleProprietorSchedules(raw: unknown) {
  const assessed = assessJapan2025SoleProprietorFacts(raw);
  const issues = [...assessed.issues];
  const fields: SoleField[] = [];
  const intake = assessed.intake;
  const returnType = assessed.returnType;
  const source =
    returnType === 'blue' ? 'nta-jp-r07-blue-business-general' : commonSource;
  const finish = (calculations: Record<string, string> | null) => {
    const selectedComplete = Boolean(
      intake && returnType && issues.length === 0 && fields.length > 0,
    );
    const body = {
      candidate: JAPAN_2025_SOLE_PROPRIETOR_CANDIDATE,
      scope: JAPAN_2025_SOLE_PROPRIETOR_SCOPE,
      returnType,
      packageVersion: JAPAN_2025_SOLE_PROPRIETOR_PACKAGE_VERSION,
      enabled: false as const,
      registryEligible: false as const,
      complete: false as const,
      selectedComplete,
      formDataReady: selectedComplete,
      reportable: false as const,
      fileable: false as const,
      status: fields.length
        ? ('incomplete-schedule-working-papers' as const)
        : ('blocked-input' as const),
      inputSnapshot: intake,
      inputHash: intake ? hash(intake) : null,
      sources: JAPAN_2025_SOURCES,
      fields,
      calculations,
      scheduleCoverage: [
        {
          id:
            returnType === 'blue'
              ? 'JP-Blue-Business-General'
              : 'JP-White-Business-General',
          complete: selectedComplete,
          fieldCount: fields.length,
          sourceId: source,
        },
      ],
      issues,
      releaseBlockers: JAPAN_2025_SOLE_PROPRIETOR_RELEASE_BLOCKERS,
      fullReturnGaps: [
        'JP-Form-1-and-JP-Form-2-selected-national-return-fields',
        'JP-Form-3-separate-taxation-and-JP-Form-4-loss',
        'JP-local-inhabitant-tax-and-business-tax',
        'JP-consumption-tax-and-invoice-return',
        'taxpayer-signature-and-filing-submission',
      ],
      definitionHash: hash(JAPAN_2025_SOLE_PROPRIETOR_CANDIDATE),
    };
    return deepFreeze({ ...body, outputHash: hash(body) });
  };
  if (!intake || !returnType || issues.length) return finish(null);
  const facts = new Map(intake.facts.map((fact) => [fact.key, fact]));
  const direct = (
    id: string,
    form: string,
    line: string,
    label: string,
    key: string,
    ruleSource = source,
  ) => {
    const fact = facts.get(key);
    if (!fact) return;
    const exact =
      fact.value.type === 'decimal' ? decimal(fact.value.value) : null;
    fields.push({
      id,
      form,
      line,
      label,
      exactRational: exact ? serialize(exact) : null,
      exactYen: exact ? format(exact) : null,
      reportableAmount: exact ? format(exact) : null,
      sourceId: ruleSource,
      sourceFactKeys: [key],
      dependencies: [],
    });
  };
  const calculated = (
    id: string,
    line: string,
    label: string,
    value: Q,
    ruleSource: string,
    dependencies: string[],
    sourceFactKeys: string[],
  ) => {
    fields.push({
      id,
      form:
        returnType === 'blue'
          ? 'JP-Blue-Business-General'
          : 'JP-White-Business-General',
      line,
      label,
      exactRational: serialize(value),
      exactYen: format(value),
      reportableAmount: format(value),
      sourceId: ruleSource,
      sourceFactKeys: [...sourceFactKeys].sort(),
      dependencies,
    });
  };
  direct(
    'business.taxpayerName',
    'JP-Form-1',
    'identity.name',
    'Taxpayer name',
    'business.taxpayerName',
    'nta-jp-r07-forms',
  );
  direct(
    'business.tradeName',
    'JP-Form-1',
    'identity.tradeName',
    'Trade name',
    'business.tradeName',
    'nta-jp-r07-forms',
  );
  direct(
    'business.address',
    'JP-Form-1',
    'identity.address',
    'Business/current address',
    'business.address',
    'nta-jp-r07-forms',
  );
  direct(
    'business.industry',
    'JP-Form-1',
    'identity.occupation',
    'Business activity',
    'business.industry',
    'nta-jp-r07-forms',
  );
  const gross = amount(facts, 'business.grossReceipts');
  const salesReturns = amount(facts, 'business.salesReturns');
  const expenseKeys = [
    'business.costOfSales',
    'business.personnel',
    'business.outsourcing',
    'business.rent',
    'business.utilities',
    'business.communication',
    'business.supplies',
    'business.travel',
    'business.advertising',
    'business.insurance',
    'business.taxesAndDues',
    'business.interest',
    'business.depreciation',
    'business.otherExpenses',
  ] as const;
  direct(
    'schedule.grossReceipts',
    returnType === 'blue'
      ? 'JP-Blue-Business-General'
      : 'JP-White-Business-General',
    'revenue.grossReceipts',
    'Gross receipts',
    'business.grossReceipts',
  );
  direct(
    'schedule.salesReturns',
    returnType === 'blue'
      ? 'JP-Blue-Business-General'
      : 'JP-White-Business-General',
    'revenue.salesReturns',
    'Sales returns/refunds',
    'business.salesReturns',
  );
  for (const key of expenseKeys)
    direct(
      `schedule.${key.slice('business.'.length)}`,
      returnType === 'blue'
        ? 'JP-Blue-Business-General'
        : 'JP-White-Business-General',
      `expenses.${key.slice('business.'.length)}`,
      key.slice('business.'.length),
      key,
    );
  const adjustedGross = minus(gross, salesReturns);
  const totalExpenses = expenseKeys.reduce(
    (total, key) => plus(total, amount(facts, key)),
    q(0n),
  );
  const beforeBlueDeduction = minus(adjustedGross, totalExpenses);
  const specialDeduction =
    returnType === 'blue'
      ? amount(facts, 'return.blueSpecialDeduction')
      : q(0n);
  const netIncome = minus(beforeBlueDeduction, specialDeduction);
  calculated(
    'schedule.adjustedGrossReceipts',
    'revenue.adjustedGrossReceipts',
    'Adjusted gross receipts after reviewed returns',
    adjustedGross,
    returnType === 'blue'
      ? 'nta-jp-r07-blue-business-general-guide'
      : 'nta-jp-r07-white-business-general-guide',
    ['schedule.grossReceipts', 'schedule.salesReturns'],
    ['business.grossReceipts', 'business.salesReturns'],
  );
  calculated(
    'schedule.totalExpenses',
    'expenses.total',
    'Total selected business expenses',
    totalExpenses,
    returnType === 'blue'
      ? 'nta-jp-r07-blue-business-general-guide'
      : 'nta-jp-r07-white-business-general-guide',
    expenseKeys.map((key) => `schedule.${key.slice('business.'.length)}`),
    [...expenseKeys],
  );
  calculated(
    'schedule.netBusinessIncomeBeforeBlueDeduction',
    'income.netBeforeBlueDeduction',
    'Net business income before blue special deduction',
    beforeBlueDeduction,
    returnType === 'blue'
      ? 'nta-jp-r07-blue-business-general-guide'
      : 'nta-jp-r07-white-business-general-guide',
    ['schedule.adjustedGrossReceipts', 'schedule.totalExpenses'],
    ['business.grossReceipts', 'business.salesReturns', ...expenseKeys],
  );
  if (returnType === 'blue')
    direct(
      'schedule.blueSpecialDeduction',
      'JP-Blue-Business-General',
      'income.blueSpecialDeduction',
      'Blue special deduction',
      'return.blueSpecialDeduction',
      'nta-jp-r07-blue-business-general-guide',
    );
  calculated(
    'schedule.netBusinessIncome',
    'income.netBusinessIncome',
    'Net business income after supported blue special deduction',
    netIncome,
    returnType === 'blue'
      ? 'nta-jp-r07-blue-business-general-guide'
      : 'nta-jp-r07-white-business-general-guide',
    returnType === 'blue'
      ? [
          'schedule.netBusinessIncomeBeforeBlueDeduction',
          'schedule.blueSpecialDeduction',
        ]
      : ['schedule.netBusinessIncomeBeforeBlueDeduction'],
    returnType === 'blue'
      ? [
          'business.grossReceipts',
          'business.salesReturns',
          ...expenseKeys,
          'return.blueSpecialDeduction',
        ]
      : ['business.grossReceipts', 'business.salesReturns', ...expenseKeys],
  );
  if (returnType === 'blue') {
    const assets = [
      'balance.cash',
      'balance.accountsReceivable',
      'balance.inventory',
      'balance.fixedAssets',
      'balance.otherAssets',
    ] as const;
    const liabilities = [
      'balance.accountsPayable',
      'balance.loans',
      'balance.otherLiabilities',
      'balance.capital',
    ] as const;
    for (const key of [...assets, ...liabilities])
      direct(
        `schedule.${key}`,
        'JP-Blue-Business-General',
        `balance.${key.slice('balance.'.length)}`,
        key.slice('balance.'.length),
        key,
        'nta-jp-r07-blue-business-general',
      );
    const assetTotal = assets.reduce(
      (total, key) => plus(total, amount(facts, key)),
      q(0n),
    );
    const liabilityTotal = liabilities.reduce(
      (total, key) => plus(total, amount(facts, key)),
      q(0n),
    );
    calculated(
      'schedule.balanceAssetsTotal',
      'balance.assetsTotal',
      'Selected balance-sheet assets total',
      assetTotal,
      'nta-jp-r07-blue-business-general',
      assets.map((key) => `schedule.${key}`),
      [...assets],
    );
    calculated(
      'schedule.balanceLiabilitiesAndCapitalTotal',
      'balance.liabilitiesAndCapitalTotal',
      'Selected liabilities and capital total',
      liabilityTotal,
      'nta-jp-r07-blue-business-general',
      liabilities.map((key) => `schedule.${key}`),
      [...liabilities],
    );
    calculated(
      'schedule.balanceDifference',
      'balance.difference',
      'Selected balance-sheet difference',
      minus(assetTotal, liabilityTotal),
      'nta-jp-r07-blue-business-general',
      [
        'schedule.balanceAssetsTotal',
        'schedule.balanceLiabilitiesAndCapitalTotal',
      ],
      [...assets, ...liabilities],
    );
  }
  return finish({
    grossReceipts: format(gross),
    adjustedGrossReceipts: format(adjustedGross),
    totalExpenses: format(totalExpenses),
    netBusinessIncomeBeforeBlueDeduction: format(beforeBlueDeduction),
    blueSpecialDeduction: format(specialDeduction),
    netBusinessIncome: format(netIncome),
  });
}

export type Japan2025SoleProprietorScheduleRun = ReturnType<
  typeof runJapan2025SoleProprietorSchedules
>;

export const evaluateJapan2025SoleProprietorSchedules =
  runJapan2025SoleProprietorSchedules;

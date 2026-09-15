import { deepFreeze } from '@emdo/contracts';
import { createHash } from 'node:crypto';
import {
  CanadaCorporate2025IntakeSchema,
  T2_2025_ADDITIONAL_SCHEDULE_TRIGGERS,
  type CanadaCorporate2025Intake,
} from './intake.js';
import { CANADA_CORPORATE_2025_SOURCES } from './sources.js';
import { buildCorporateReporting } from './reporting.js';
import { buildCorporateFieldCoverage } from './field-coverage.js';
import { corporateRefundableSections } from './refundable-sections.js';
import { corporateT2Totals } from './t2-totals.js';
import { populateCorporateSchedules } from './schedule-support.js';
import { corporateRequiredControlManifest } from './required-controls.js';

export const CANADA_CORPORATE_2025_COVERAGE = deepFreeze({
  id: 'ca-on-2025-standalone-ccpc-ordinary-abi-v1',
  country: 'CA',
  province: 'ON',
  taxYearStart: '2025-01-01',
  taxYearEnd: '2025-12-31',
  description:
    'Ontario-only resident standalone CCPC with ordinary active business income, one Canadian-resident individual common shareholder; no additional-schedule triggers, capital assets, inventory, losses, elections or special credits.',
  readiness: 'incomplete',
  completeReturnReady: false,
  filingAvailable: false,
  blockers: ['t2-and-gifi-rounding-authority-unresolved'],
} as const);
export type CorporateIssue = { code: string; path: string; detail: string };
type ExactMoney = {
  currency: 'CAD';
  exactDecimal: string;
  numerator: string;
  denominator: string;
  reportableAmount: string | null;
};
type FieldValue = ExactMoney | string | boolean | string[] | null;
export type CorporateForm = {
  id: string;
  purpose: 'return' | 'schedule' | 'worksheet';
  sourceFile: string;
  fields: Record<string, FieldValue>;
  dependsOn: string[];
};
const scale = 1_000_000n;
function amount(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return (
    (BigInt(whole) * scale + BigInt(fraction.padEnd(6, '0'))) *
    (negative ? -1n : 1n)
  );
}
function money(value: bigint): ExactMoney {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const fractional = (abs % scale)
    .toString()
    .padStart(6, '0')
    .replace(/0+$/, '');
  let a = abs,
    b = scale;
  while (b !== 0n) [a, b] = [b, a % b];
  return {
    currency: 'CAD',
    exactDecimal: `${negative ? '-' : ''}${abs / scale}${fractional ? `.${fractional}` : ''}`,
    numerator: (value / a).toString(),
    denominator: (scale / a).toString(),
    reportableAmount: null,
  };
}
const total = (values: string[]) =>
  values.reduce((sum, value) => sum + amount(value), 0n);
function rate(value: bigint, numerator: bigint, denominator: bigint) {
  const product = value * numerator;
  if (product % denominator !== 0n)
    throw new Error('corporate-exact-scale-exceeded');
  return product / denominator;
}
/** Stable serialization has no clock, locale, browser/session, or generated identifiers. */
export function canonicalCorporateJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalCorporateJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, entry]) =>
        `${JSON.stringify(key)}:${canonicalCorporateJson(entry)}`,
    )
    .join(',')}}`;
}
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalCorporateJson(value)).digest('hex');

/** Versioned review manifest, not a certified executable or filing specification. */
export const CANADA_CORPORATE_2025_PACKAGE_VERSION = '2025.7';
export const CANADA_CORPORATE_2025_DEFINITION = deepFreeze({
  workflowId: CANADA_CORPORATE_2025_COVERAGE.id,
  packageVersion: CANADA_CORPORATE_2025_PACKAGE_VERSION,
  coverage: CANADA_CORPORATE_2025_COVERAGE,
  arithmetic: 'exact-bigint-six-decimal-rates-v1',
  reporting: 'lossless-xfa-field-encoding-with-upstream-dependencies-v1',
  fieldCoverage: 'exhaustive-xfa-conditional-review-ledger-v1',
  refundableSections: 't2-pages5-7-ordinary-abi-with-historical-pools-v1',
  totals: 't2-pages3-4-8-9-ordinary-abi-v1',
  schedules: 's1-zero-other-adjustments-s5-ontario-chain-v1',
  fieldValidation: 'explicit-xfa-limits-and-format-v1',
  requiredControls: 'rc4088-validity-check-fixed-controls-v1',
  formGraph: ['GIFI100', 'GIFI125', 'GIFI141', 'S1', 'S50', 'S500', 'S5', 'T2'],
  sources: CANADA_CORPORATE_2025_SOURCES,
} as const);
export const CANADA_CORPORATE_2025_DEFINITION_HASH = hash(
  CANADA_CORPORATE_2025_DEFINITION,
);

function validate(input: CanadaCorporate2025Intake): CorporateIssue[] {
  const issues: CorporateIssue[] = [];
  if (input.financialStatements.incomeStatementActivity !== 'non-farming')
    issues.push({
      code: 'unsupported-farming-gifi',
      path: 'financialStatements.incomeStatementActivity',
      detail:
        'Farming and mixed GIFI classifications require their own income-statement adapter; do not relabel farming receipts as trade sales.',
    });
  if (amount(input.financialStatements.otherComprehensiveIncome) !== 0n)
    issues.push({
      code: 'unsupported-oci-gifi',
      path: 'financialStatements.otherComprehensiveIncome',
      detail:
        'Nonzero OCI requires component and balance-sheet lineage beyond the current no-other-equity-movements adapter.',
    });
  if (
    amount(input.taxWithholding.amount) >
      amount(input.taxWithholding.payments) ||
    amount(input.taxWithholding.payments) >
      amount(input.financialStatements.tradeSales)
  )
    issues.push({
      code: 'inconsistent-tax-withholding',
      path: 'taxWithholding',
      detail:
        'Withheld tax cannot exceed its gross payments; covered trade payments cannot exceed reported gross trade sales.',
    });
  if (
    amount(input.taxWithholding.amount) > 0n &&
    !input.sourceReferences.some(
      (source) => source.id === input.taxWithholding.sourceReferenceId,
    )
  )
    issues.push({
      code: 'missing-withholding-source',
      path: 'taxWithholding.sourceReferenceId',
      detail:
        'Positive withheld tax requires supplied evidence tied to reported gross income.',
    });
  if (
    !input.sourceReferences.some(
      (source) =>
        source.id === input.priorYear.refundableTaxHistory.sourceReferenceId,
    )
  )
    issues.push({
      code: 'missing-pool-source-reference',
      path: 'priorYear.refundableTaxHistory.sourceReferenceId',
      detail:
        'Prior T2 lines 530/545 and dividend refunds require a supplied source reference; balances are not inferred from current-year activity.',
    });
  const fail = (code: string, path: string, detail: string) =>
    issues.push({ code, path, detail });
  const requireTrue = (value: boolean | null, path: string) => {
    if (value !== true)
      fail(
        value === null ? 'missing-fact' : 'unsupported-fact',
        path,
        'This coverage requires an explicit affirmative declaration.',
      );
  };
  for (const [key, value] of Object.entries(input.declarations))
    requireTrue(value, `declarations.${key}`);
  requireTrue(
    input.identity.addressesUnchangedAndSame,
    'identity.addressesUnchangedAndSame',
  );
  requireTrue(
    input.identity.signingOfficer.contactIsSigningOfficer,
    'identity.signingOfficer.contactIsSigningOfficer',
  );
  if (
    input.identity.province !== 'ON' ||
    input.identity.taxYearStart !== '2025-01-01' ||
    input.identity.taxYearEnd !== '2025-12-31'
  )
    fail(
      'unsupported-jurisdiction-or-period',
      'identity',
      'Only the full 2025 calendar year and Ontario-only establishment are implemented.',
    );
  if (
    amount(input.identity.shareholder.commonSharePercentage) !== 100n * scale ||
    amount(input.identity.shareholder.preferredSharePercentage) !== 0n
  )
    fail(
      'unsupported-share-structure',
      'identity.shareholder',
      'One individual must hold all common shares and there must be no preferred shares.',
    );
  for (const [code, value] of Object.entries(input.attachmentAnswers)) {
    if (value !== false)
      fail(
        value === null ? 'missing-fact' : 'unsupported-required-schedule',
        `attachmentAnswers.${code}`,
        T2_2025_ADDITIONAL_SCHEDULE_TRIGGERS[
          code as keyof typeof T2_2025_ADDITIONAL_SCHEDULE_TRIGGERS
        ],
      );
  }
  if (
    amount(input.priorYear.taxableCapitalEmployedCanada) >
      10_000_000n * scale ||
    amount(input.priorYear.adjustedAggregateInvestmentIncome) !== 0n
  )
    fail(
      'unsupported-business-limit-reduction',
      'priorYear',
      'Capital taper and prior-year investment-income Schedule 7 lineage are not implemented.',
    );
  if (input.priorYear.federalSmallBusinessDeductionClaimed === null)
    fail(
      'missing-fact',
      'priorYear.federalSmallBusinessDeductionClaimed',
      'Required for balance-due-day review.',
    );
  for (const [key, value] of Object.entries(input.additionalInformation)) {
    if (
      value === null &&
      !['quarterlyEligibilityCeasedOn', 'refundPreference'].includes(key)
    )
      fail(
        'missing-fact',
        `additionalInformation.${key}`,
        'Explicit T2 additional-information answers are required.',
      );
  }
  if (input.additionalInformation.taxExemptUnderSection149 === true)
    fail(
      'unsupported-tax-exemption',
      'additionalInformation.taxExemptUnderSection149',
      'Section 149 exemptions require a different calculation and return mapping.',
    );
  const cessation = input.additionalInformation.quarterlyEligibilityCeasedOn;
  if (
    cessation !== null &&
    (cessation < input.identity.taxYearStart ||
      cessation > input.identity.taxYearEnd)
  )
    fail(
      'invalid-quarterly-cessation-date',
      'additionalInformation.quarterlyEligibilityCeasedOn',
      'The supplied cessation must occur within this return tax year.',
    );
  const shares = [
    input.identity.principalActivityRevenuePercentage,
    ...input.identity.otherPrincipalActivities.map((a) => a.revenuePercentage),
  ];
  if (
    shares.some(
      (share) => amount(share) <= 0n || amount(share) > 100n * scale,
    ) ||
    total(shares) !== 100n * scale ||
    shares.some(
      (share, index) => index > 0 && amount(share) > amount(shares[index - 1]!),
    )
  )
    fail(
      'invalid-principal-activity-percentages',
      'identity.otherPrincipalActivities',
      'Positive principal activity revenue percentages must total 100.',
    );
  if (input.additionalInformation.quarterlyInstalmentRemitterRequested === true)
    fail(
      'unsupported-quarterly-instalment-election',
      'additionalInformation.quarterlyInstalmentRemitterRequested',
      'Quarterly remitter eligibility has not been implemented.',
    );
  if (
    input.additionalInformation.constructionIsMajorBusinessActivity === false &&
    input.additionalInformation.constructionSubcontractors === true
  )
    fail(
      'inconsistent-construction-answer',
      'additionalInformation.constructionSubcontractors',
      'A non-construction case cannot supply a construction-subcontractor answer.',
    );
  if (amount(input.priorYear.businessLimit) > 500_000n * scale)
    fail(
      'invalid-prior-business-limit',
      'priorYear.businessLimit',
      'The stated prior business limit exceeds the standalone maximum.',
    );
  const fs = input.financialStatements;
  const netBeforeTax =
    amount(fs.tradeSales) -
    total(Object.values(fs.operatingExpenses)) -
    total(Object.values(fs.costOfSales));
  if (netBeforeTax <= 0n || netBeforeTax > 500_000n * scale)
    fail(
      'unsupported-taxable-income',
      'financialStatements',
      'Positive ordinary ABI through $500,000 is implemented; loss/zero/general-rate cases need additional review.',
    );
  for (const period of ['opening', 'closing'] as const) {
    const b = fs[period];
    for (const [code, value] of Object.entries(b))
      if (code !== '3600' && amount(value) < 0n)
        fail(
          'invalid-balance-sign',
          `financialStatements.${period}.${code}`,
          'Negative amounts require a different GIFI classification.',
        );
    const assets = total([b['1001'], b['1060'], b['1483']]);
    const liabilityEquity = total([b['2621'], b['2680'], b['3500'], b['3600']]);
    if (assets !== liabilityEquity)
      fail(
        'unbalanced-financial-statements',
        `financialStatements.${period}`,
        'Assets must equal liabilities plus equity exactly before any reporting rounding.',
      );
    if (assets >= 50_000_000n * scale)
      fail(
        'unsupported-corporate-minimum-tax-review',
        `financialStatements.${period}`,
        'Large-asset cases require Ontario CMT review.',
      );
  }
  if (amount(fs.tradeSales) >= 100_000_000n * scale)
    fail(
      'unsupported-corporate-minimum-tax-review',
      'financialStatements.tradeSales',
      'Large-revenue cases require Ontario CMT review.',
    );
  if (amount(fs.opening['3500']) !== amount(fs.closing['3500']))
    fail(
      'unsupported-share-capital-movement',
      'financialStatements.closing.3500',
      'Share capital changes require further transaction review.',
    );
  if (
    amount(fs.closing['3600']) !==
    amount(fs.opening['3600']) +
      netBeforeTax -
      amount(fs.currentIncomeTaxProvision)
  )
    fail(
      'retained-earnings-reconciliation-failed',
      'financialStatements.closing.3600',
      'Opening retained earnings plus after-tax net income must equal closing retained earnings.',
    );
  const g = input.gifi141;
  for (const key of [
    'primaryPreparerIdentified',
    'returnPreparerIsPrimaryPreparer',
    'returnPreparerAccountingDesignation',
  ] as const)
    if (g[key] === null)
      fail(
        'missing-fact',
        `gifi141.${key}`,
        'Preparer identity/role facts cannot be inferred.',
      );
  if (g.primaryPreparerIdentified === true)
    for (const key of [
      'primaryPreparerAccountingDesignation',
      'primaryPreparerConnected',
    ] as const)
      if (g[key] === null)
        fail(
          'missing-fact',
          `gifi141.${key}`,
          'Required for the identified primary preparer.',
        );
  if (g.involvement.includes('305') !== (g.involvementOther !== null))
    fail(
      'inconsistent-preparer-information',
      'gifi141.involvementOther',
      'Other involvement requires its description, only when selected.',
    );
  if (
    (g.involvement.includes('300') || g.involvement.includes('301')) &&
    g.reservation === null
  )
    fail(
      'missing-fact',
      'gifi141.reservation',
      'Audit/review involvement requires the reservation answer.',
    );
  if (g.reservation === true)
    fail(
      'unsupported-financial-reservation',
      'gifi141.reservation',
      'A financial-report reservation needs review.',
    );
  for (const key of [
    'subsequentEvents',
    'assetsRevalued',
    'contingentLiabilities',
    'commitments',
    'jointVenturesOrPartnerships',
    'impairmentOrFairValueChanges',
    'financialInstrumentsDerecognized',
    'hedgeAccountingApplied',
    'hedgeAccountingDiscontinued',
    'openingEquityAdjustment',
  ] as const)
    if (g[key] !== false)
      fail(
        g[key] === null ? 'missing-fact' : 'unsupported-financial-disclosure',
        `gifi141.${key}`,
        'Additional financial disclosure/reconciliation is not implemented.',
      );
  const part5 =
    g.returnPreparerIsPrimaryPreparer === false &&
    g.returnPreparerAccountingDesignation === true;
  if (
    part5 !== g.returnPreparerInputs.length > 0 ||
    g.returnPreparerInputs.includes('314') !== (g.returnPreparerOther !== null)
  )
    fail(
      'inconsistent-preparer-information',
      'gifi141.returnPreparerInputs',
      'Part 5 must match the actual separate professional preparer and supplied input types.',
    );
  if (
    new Set(input.sourceReferences.map((r) => r.id)).size !==
    input.sourceReferences.length
  )
    fail(
      'duplicate-source-reference',
      'sourceReferences',
      'Source IDs must be unique.',
    );
  return issues;
}

/** Read-only structured intake -> validation -> exact rule/form graph -> review export.
 * Deliberately cannot produce a complete or fileable return until rounding and form coverage are reviewed.
 */
export function prepareCanadaCorporate2025Review(raw: unknown) {
  const parsed = CanadaCorporate2025IntakeSchema.safeParse(raw);
  const base = {
    schemaVersion: 1 as const,
    workflowId: CANADA_CORPORATE_2025_COVERAGE.id,
    packageVersion: CANADA_CORPORATE_2025_PACKAGE_VERSION,
    definitionHash: CANADA_CORPORATE_2025_DEFINITION_HASH,
    coverage: CANADA_CORPORATE_2025_COVERAGE,
    complete: false as const,
    filingAvailable: false as const,
    sources: CANADA_CORPORATE_2025_SOURCES,
  };
  if (!parsed.success)
    return deepFreeze({
      ...base,
      status: 'blocked-input' as const,
      issues: parsed.error.issues.map((i) => ({
        code: 'invalid-or-missing-input',
        path: i.path.join('.'),
        detail: i.message,
      })),
      forms: [] as CorporateForm[],
      reviewExport: null,
    });
  const input = parsed.data;
  const issues = validate(input);
  if (issues.length > 0)
    return deepFreeze({
      ...base,
      status: 'blocked-input' as const,
      binding: input.binding,
      issues,
      forms: [] as CorporateForm[],
      reviewExport: null,
    });
  const fs = input.financialStatements;
  const sales = amount(fs.tradeSales),
    operatingExpenses = total(Object.values(fs.operatingExpenses)),
    costs = total(Object.values(fs.costOfSales)),
    expenses = operatingExpenses + costs;
  const taxable = sales - expenses,
    provision = amount(fs.currentIncomeTaxProvision),
    net = taxable - provision;
  const federalBase = rate(taxable, 38n, 100n),
    abatement = rate(taxable, 10n, 100n),
    federalSbd = rate(taxable, 19n, 100n);
  const federal = federalBase - abatement - federalSbd;
  const ontarioBase = rate(taxable, 115n, 1000n),
    ontarioSbd = rate(taxable, 83n, 1000n),
    ontario = ontarioBase - ontarioSbd;
  const tax = federal + ontario,
    instalments = amount(input.taxInstalmentsPaid),
    balance = tax - instalments;
  const refundableSections = corporateRefundableSections(
    input,
    taxable,
    federal,
    amount,
  );
  const forms: CorporateForm[] = [];
  const form = (
    id: string,
    sourceFile: string,
    purpose: CorporateForm['purpose'],
    dependsOn: string[],
    fields: CorporateForm['fields'],
  ) => forms.push({ id, sourceFile, purpose, dependsOn, fields });
  const common: CorporateForm['fields'] = {
    legalName: [input.identity.legalName, input.identity.legalNameContinuation]
      .filter(Boolean)
      .join(' '),
    businessNumber: input.identity.businessNumber,
    taxYearEnd: input.identity.taxYearEnd,
  };
  const b = fs.closing;
  const assets = total([b['1001'], b['1060'], b['1483']]),
    liabilities = total([b['2621'], b['2680']]),
    equity = total([b['3500'], b['3600']]);
  form('GIFI100', 't2sch100-20e.pdf', 'schedule', [], {
    ...common,
    ...Object.fromEntries(
      Object.entries(b).map(([k, v]) => [k, money(amount(v))]),
    ),
    '1599': money(assets),
    '2599': money(assets),
    '3139': money(liabilities),
    '3499': money(liabilities),
    '3620': money(equity),
    '3640': money(liabilities + equity),
    '3660': money(amount(fs.opening['3600'])),
    '3680': money(net),
    '3849': money(amount(b['3600'])),
  });
  form('GIFI125', 't2sch125-23e.pdf', 'schedule', [], {
    ...common,
    '0001': input.identity.operatingName,
    '0002': input.identity.activity,
    '0003': '01',
    '8000': money(sales),
    '8299': money(sales),
    ...Object.fromEntries(
      Object.entries(fs.operatingExpenses).map(([k, v]) => [
        k,
        money(amount(v)),
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(fs.costOfSales).map(([key, value]) => [
        key,
        money(amount(value)),
      ]),
    ),
    '8518': money(costs),
    '9367': money(operatingExpenses),
    '9368': money(expenses),
    '9369': money(taxable),
    '9970': money(taxable),
    '9990': money(provision),
    '9999': money(net),
  });
  const g = input.gifi141;
  form('GIFI141', 't2sch141-23e.pdf', 'schedule', [], {
    ...common,
    '111': g.primaryPreparerIdentified,
    '095': g.primaryPreparerIdentified
      ? g.primaryPreparerAccountingDesignation
      : null,
    '097': g.primaryPreparerIdentified ? g.primaryPreparerConnected : null,
    ...Object.fromEntries(
      ['300', '301', '302', '303', '304'].map((k) => [
        k,
        g.involvement.includes(k as '300'),
      ]),
    ),
    '305': g.involvementOther,
    '099': g.involvement.some((i) => i === '300' || i === '301')
      ? g.reservation
      : null,
    '101': fs.notes.length > 0,
    '104': false,
    '105': false,
    '106': false,
    '107': false,
    '108': false,
    '200': false,
    '250': false,
    '255': false,
    '260': false,
    '265': false,
    ...Object.fromEntries(
      ['310', '311', '312', '313'].map((k) => [
        k,
        g.returnPreparerInputs.includes(k as '310'),
      ]),
    ),
    '314': g.returnPreparerOther,
    notes: fs.notes,
  });
  form(
    'S1',
    't2sch1-25e.pdf',
    provision === 0n ? 'worksheet' : 'schedule',
    ['GIFI125'],
    {
      ...common,
      A: money(net),
      '101': money(provision),
      '500': money(provision),
      B: money(taxable),
      '510': money(0n),
      C: money(taxable),
    },
  );
  form('S50', 't2sch50-19e.pdf', 'schedule', [], {
    ...common,
    '100': `${input.identity.shareholder.name} (individual)`,
    '300': input.identity.shareholder.socialInsuranceNumber,
    '400': '100',
    '500': '0',
  });
  form('S500', 't2sch500-23e.pdf', 'worksheet', ['S1'], {
    ...common,
    '1A': money(taxable),
    '1B': '11.5%',
    '1C': money(ontarioBase),
    '2A': money(taxable),
    '2B': money(taxable),
    '2C': money(500_000n * scale),
    '2D': money(0n),
    '2F': money(0n),
    '2G': money(0n),
    '2H': money(0n),
    '2I': money(500_000n * scale),
    '2J': money(taxable),
    odfOntarioIncome: money(taxable),
    odfAllIncome: money(taxable),
    '2K': '1',
    '2L': money(taxable),
    '2M': money(taxable),
    '2N': money(taxable),
    '2O': money(ontarioSbd),
  });
  form('S5', 't2sch5-25e.pdf', 'schedule', ['S500'], {
    ...common,
    '270': money(ontarioBase),
    '402': money(ontarioSbd),
    '290': money(ontario),
    '255': money(ontario),
  });
  const t2: CorporateForm['fields'] = {
    '001': input.identity.businessNumber,
    '002': input.identity.legalName,
    '010': false,
    '020': false,
    '030': false,
    '040': '1',
    '060': input.identity.taxYearStart,
    '061': input.identity.taxYearEnd,
    '063': false,
    '066': false,
    '067': false,
    '070': false,
    '071': false,
    '072': false,
    '076': false,
    '078': false,
    '080': true,
    ...input.attachmentAnswers,
    '173': true,
    '201': provision !== 0n,
    '205': true,
    '270': input.additionalInformation.usesIfrs,
    '280': false,
    '290': false,
    '284': input.identity.activity,
    '285': input.identity.principalActivityRevenuePercentage,
    '286': input.identity.otherPrincipalActivities[0]?.description ?? null,
    '287':
      input.identity.otherPrincipalActivities[0]?.revenuePercentage ?? null,
    '288': input.identity.otherPrincipalActivities[1]?.description ?? null,
    '289':
      input.identity.otherPrincipalActivities[1]?.revenuePercentage ?? null,
    '294': input.additionalInformation.quarterlyEligibilityCeasedOn,
    '291': false,
    '292': false,
    '293': input.additionalInformation.quarterlyInstalmentRemitterRequested,
    '295': input.additionalInformation.constructionIsMajorBusinessActivity
      ? input.additionalInformation.constructionSubcontractors
      : null,
    '300': money(taxable),
    '360': money(taxable),
    '400': money(taxable),
    '405': money(taxable),
    '410': money(500_000n * scale),
    '415': money(0n),
    '417': money(0n),
    '422': money(0n),
    '426': money(500_000n * scale),
    '428': money(500_000n * scale),
    '430': money(federalSbd),
    '550': money(federalBase),
    '604': money(0n),
    '608': money(abatement),
    '638': money(0n),
    '700': money(federal),
    '750': 'ON',
    '760': money(ontario),
    '770': money(tax),
    '840': money(instalments),
    '890': money(instalments),
    refund: money(balance < 0n ? -balance : 0n),
    balanceOwing: money(balance > 0n ? balance : 0n),
    '896':
      amount(input.priorYear.taxableIncome) <=
      amount(input.priorYear.businessLimit),
    '950': input.identity.signingOfficer.lastName,
    '951': input.identity.signingOfficer.firstName,
    '954': input.identity.signingOfficer.position,
    '955': null,
    signature: null,
    '956': input.identity.signingOfficer.telephone,
    '957': true,
    '990': input.identity.correspondenceLanguage === 'en' ? '1' : '2',
    naics: input.identity.naics,
    ...Object.fromEntries(
      Object.entries(refundableSections.values).map(([key, value]) => [
        key,
        money(value),
      ]),
    ),
  };
  const totals = corporateT2Totals(
    input,
    Object.fromEntries(
      Object.entries(t2)
        .filter(
          ([, value]) =>
            value !== null &&
            typeof value === 'object' &&
            'exactDecimal' in value,
        )
        .map(([key, value]) => [
          key,
          amount((value as ExactMoney).exactDecimal),
        ]),
    ),
    amount,
  );
  Object.assign(
    t2,
    Object.fromEntries(
      Object.entries(totals.values).map(([key, value]) => [key, money(value)]),
    ),
  );
  form(
    'T2',
    't2-25e.pdf',
    'return',
    ['GIFI100', 'GIFI125', 'GIFI141', 'S1', 'S5', 'S50'],
    t2,
  );
  const blockers: CorporateIssue[] =
    CANADA_CORPORATE_2025_COVERAGE.blockers.map((code) => ({
      code,
      path: 'coverage',
      detail:
        code === 't2-and-gifi-rounding-authority-unresolved'
          ? 'Exact values are preserved for every case. Official fillable controls prove field precision and permit lossless representations with resolved dependencies. Fractional rounding, tie handling and cross-form rounding reconciliation remain unproven; field representations are not a complete or fileable return.'
          : code === 'complete-form-coverage-review-pending'
            ? 'Mapped form graph is available for review; complete field/conditional schedule coverage has not passed independent approval.'
            : 'This export is not a CRA-certified electronic return, paper return, signature or submission.',
    }));
  if (provision !== tax)
    blockers.push({
      code: 'book-tax-provision-differs-from-calculation',
      path: 'financialStatements.currentIncomeTaxProvision',
      detail:
        'Reported book provision is retained, not silently replaced. Review the difference from exact calculated current tax.',
    });
  const scheduleDependencies = populateCorporateSchedules(forms, money, amount);
  const reporting = buildCorporateReporting(forms, {
    ...refundableSections.dependencies,
    ...totals.dependencies,
    ...scheduleDependencies,
  });
  const fieldCoverage = buildCorporateFieldCoverage(
    input,
    reporting.forms,
    reporting,
  );
  const invalidFields = fieldCoverage.fields.filter(
    (field) => field.validation?.status === 'invalid',
  );
  if (invalidFields.length)
    return deepFreeze({
      ...base,
      status: 'blocked-input' as const,
      forms: [] as CorporateForm[],
      issues: invalidFields.map((field) => ({
        code: 'invalid-official-field',
        path: `${field.form}:${field.ordinal}`,
        detail: `Supplied value violates captured field rules: ${field
          .validation!.checks.filter((check) => !check.valid)
          .map((check) => check.rule)
          .join(', ')}`,
      })),
      reviewExport: null,
    });
  const payload = {
    ...base,
    fieldCoverage,
    requiredControlManifest: corporateRequiredControlManifest(fieldCoverage),
    status: 'incomplete-review' as const,
    binding: input.binding,
    inputHash: hash(input),
    sourceReferences: input.sourceReferences,
    issues: blockers,
    forms: reporting.forms,
    reporting: {
      proof: reporting.proof,
      complete: reporting.complete,
      roundingMethod: reporting.roundingMethod,
      fields: reporting.fields,
      numericNonMoneyFields: reporting.numericNonMoneyFields,
      coverage: reporting.coverage,
    },
    intake: input,
    supportingFinancialStatements: fs,
    identity: input.identity,
    declarations: input.declarations,
    priorYear: input.priorYear,
    roundingPolicy:
      'proven-lossless-field-encoding-unresolved-rounding' as const,
    certification: 'unsigned-review-only' as const,
  };
  return deepFreeze({
    ...payload,
    reviewExport: {
      mediaType: 'application/json' as const,
      filename: `canada-on-t2-2025-${input.binding.caseId}-r${input.binding.snapshotRevision}-review.json`,
      content: canonicalCorporateJson(payload),
      sha256: hash(payload),
    },
  });
}

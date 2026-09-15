import { appendCanada2025FederalCredits } from './personal-federal-credits.js';
import { appendCanada2025FederalTax } from './personal-federal-tax.js';
import { appendCanada2025PersonalReconciliation } from './personal-reconciliation.js';
import { appendCanada2025OntarioCredits } from './personal-ontario-credits.js';
import {
  appendCanada2025OntarioReduction,
  appendCanada2025OntarioFinalTax,
} from './personal-ontario-reduction.js';
import { appendCanada2025OntarioBrackets } from './personal-ontario-brackets.js';
import { appendCanada2025OntarioSurtax } from './personal-ontario-surtax.js';
import { appendCanada2025OntarioHealthPremium } from './personal-ontario-health.js';
import {
  appendCanada2025MedicalCredits,
  appendCanada2025MedicalSupplement,
} from './personal-medical.js';
import {
  PERSONAL_REQUIRED_FORM_FACTS as privateFormFacts,
  PERSONAL_REQUIRED_BUSINESS_FORM_FACTS as privateBusinessFacts,
} from './personal-form-applicability.js';
import {
  personalCppWorksheetDependencies,
  personalCppTransferDependencies,
} from './personal-cpp-graph.js';
import { appendCanada2025SingleBenefitSchedules } from './personal-benefit-schedules.js';
import {
  applyCanadaPersonalPaperReporting,
  PERSONAL_PAPER_REPORTING_POLICY_VERSION,
} from './personal-reporting.js';
import { PERSONAL_PAPER_PRECISION_SOURCES } from './personal-precision-evidence.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  deepFreeze,
  FinanceTaxIntakeSchema,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import { calculateCanadaCpp2025, CANADA_CPP_2025_SOURCE } from './cpp.js';
import { CANADA_ON_2025_SOURCES } from './readiness.js';
import {
  CANADA_PERSONAL_CARRYFORWARD_VERSION,
  CANADA_PERSONAL_NONCAPITAL_LOSS_YEARS,
  calculateCanadaPersonalNonCapitalLossCarryforward2025,
  personalNonCapitalLossFactKey,
} from './personal-carryforward.js';
import {
  calculateCanada2025FederalBasicPersonalAmount,
  serializeCanada2025FederalBasicPersonalAmount,
  serializeDimensionlessRatio,
  type Canada2025DimensionlessProvenance,
} from './personal-basic-personal-amount.js';
import { calculateCanada2025FederalTaxWorksheet } from './personal-federal-tax-worksheet.js';
import {
  decimal as q,
  rational,
  plus,
  minus,
  times,
  positive,
  minimum,
  compare,
  serialize,
  type PersonalExact,
} from './personal-exact.js';
import {
  calculateCanada2025EducatorSchoolSupplyCredit,
  type Canada2025EducatorEligibility,
} from './personal-educator-credit.js';
import {
  CANADA_PERSONAL_DONATION_CARRYFORWARD_YEARS,
  CANADA_PERSONAL_DONATIONS_SOURCE,
  calculateCanada2025FederalCharitableDonations,
  exactCanada2025DonationAmount,
} from './personal-donations.js';

export const CANADA_ON_2025_PERSONAL_PACKAGE_VERSION =
  '2025.1-personal-workflow.30';
const formVersion = '5006-R-E-25_5006-C-E-25';
const extraSources = [
  {
    id: 'cra-t2204-2025',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/t2204/t2204-25e.pdf',
    formVersion: 'T2204 E (25)',
    documentHash:
      '5b34eff9998812738dc116272db8cd20add88b84a3fde7532f580cd1fd11f987',
    retrievedAt: '2026-09-14T02:43:50.377152+00:00',
  },
  {
    id: 'cra-t2125-2025',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/t2125/t2125-25e.pdf',
    formVersion: 'T2125 E (25)',
    documentHash:
      'fae75091753cb1810404c00aaa3f2c1a91cfae942b73bace7e6b884f24a08738',
    retrievedAt: '2026-09-14T02:21:46.923712+00:00',
  },
  {
    id: 'cra-5000-s6-25e',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5000-s6/5000-s6-25e.txt',
    formVersion: '5000-S6 E (25)',
    documentHash:
      'eea18e6c3593e7289c1eb5f1279597bc6980203f01aeea5711cc9cdd1c07a7e1',
    retrievedAt: '2026-09-14T02:22:53.804828+00:00',
  },
  {
    id: 'cra-5006-a-25e',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5006-a/5006-a-25e.txt',
    formVersion: '5006-A E (25)',
    documentHash:
      'ca7f17ba89f09d6e1ede0cf859e2a1b89199f82c3302d5673277f3011d5ce53f',
    retrievedAt: '2026-09-14T02:22:56.886402+00:00',
  },
  {
    id: 'cra-5000-s9-2025-etext',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5000-s9/5000-s9-25e.txt',
    formVersion: '5000-S9 E (25)',
    documentHash:
      '86988baa6d4a6918d202ec7beb167e57c9ae42136bbf2ca19125aada2b26cb06',
    retrievedAt: '2026-09-15T05:00:00+00:00',
  },
  {
    id: 'cra-5000-s9-2025-fillable',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5000-s9/5000-s9-fill-25e.pdf',
    formVersion: '5000-S9 fillable PDF (25)',
    documentHash:
      'aac16785c69833801b8b4c4d0203b6cfc49f48cd7638dc6e61b69a294ddc5542',
    retrievedAt: '2026-09-15T05:00:00+00:00',
  },
] as const;
export const CANADA_ON_2025_PERSONAL_CANDIDATE = deepFreeze({
  id: 'ca-on-2025-personal-workflow',
  version: CANADA_ON_2025_PERSONAL_PACKAGE_VERSION,
  enabled: false,
  registryEligible: false,
  scopes: ['individual', 'sole-proprietor'].map((taxpayerType) => ({
    country: 'CA',
    subdivision: 'CA-ON',
    taxpayerType,
    year: 2025,
    regime: 'income-tax-return',
    formVersion,
  })),
  coverage:
    'Review calculations for full-year Ontario residents aged 19–64, single without dependants; zero or one ordinary T4, domestic interest, optionally one ordinary service business or commission activity with reviewed reporting method and selected-basis amounts, reviewed eligible annual union/professional dues and self medical expenses, and reviewed general non-capital loss carryforward balances.',
  forms: [
    'T1',
    'ON428',
    'Schedule8',
    'Schedule6',
    'Schedule9',
    'ON428-A',
    'T2125',
    'T2204',
    'MedicalSupplement',
  ],
  releaseBlockers: [
    'annual-return-intermediate-and-final-rounding-unverified',
    'independent-complete-return-fixtures-not-validated',
    'identification-and-all-applicable-form-field-completeness-not-validated',
    'eligibility-exclusion-inventory-requires-independent-review',
    'unsupported-loss-types-and-carryforward-history-require-independent-review',
  ],
  eventualScope: [
    'all Canadian subdivisions',
    'individuals',
    'sole proprietors',
    'standalone corporations',
  ],
  sources: [
    ...CANADA_ON_2025_SOURCES,
    CANADA_CPP_2025_SOURCE,
    ...extraSources,
    CANADA_PERSONAL_DONATIONS_SOURCE.carryforwardSource,
    ...PERSONAL_PAPER_PRECISION_SOURCES,
  ],
});
const guards = [
  [
    'scope.medicalEligibleUnreimbursed',
    'Reviewed eligible self medical expenses, with no reimbursement or duplicate deduction; zero when absent',
    'T1 line33099; ON428 line58689',
  ],
  [
    'scope.medicalSamePeriodNotPreviouslyClaimed',
    'Expenses cover the same reviewed 12-month period ending in 2025 and were not claimed for 2024 or any earlier return',
    'Ontario 2025 information line58689',
  ],
  [
    'scope.medicalNoOntarioSpecialCategories',
    'No attendant-care, adapted-van or medical moving expenses requiring different Ontario limits',
    'Ontario 2025 information line58689 exceptions',
  ],
  [
    'scope.duesEligibleUnreimbursed',
    'The supplied annual union/professional dues are reviewed eligible amounts supported by receipts or T4 box 44, with no reimbursement; enter zero when absent',
    'T1 line 21200: receipts and box 44 of T4 slips',
  ],
  [
    'scope.duesNotClaimedInBusiness',
    'The supplied line 21200 dues are not also included in T2125 expenses or another deduction',
    'T1 line 21200; T2125 business expenses: prevent duplicate deduction',
  ],
  [
    'scope.singleNoDependants',
    'Single throughout 2025; no spouse, dependants or dependant claims',
    'T1 pages 1–2; Schedule6 eligibility',
  ],
  [
    'scope.noSpecialReturns',
    'No bankruptcy, death, immigration/emigration, nonresident, foreign, exempt-income or special return circumstances',
    'T1 pages 1–2',
  ],
  [
    'scope.noOtherIncome',
    'No income other than this ordinary T4, domestic interest and selected service business or commission activity',
    'T1 Step 2',
  ],
  [
    'scope.noOtherDeductions',
    'No Step 3 deductions other than calculated CPP contributions and reviewed eligible annual union/professional dues; no Step 4 deductions except supported general non-capital loss carryforward',
    'T1 Steps 3–4',
  ],
  [
    'scope.noOtherCredits',
    'No other federal/provincial credits, disability, tuition, pension or transferred amounts except reviewed self medical expenses, supported educator school-supply credit and supported ordinary charitable donations',
    'T1 Part B; ON428 Part B',
  ],
  [
    'scope.noSpecialTaxes',
    'No TOSI, AMT/minimum-tax carryovers, foreign tax, investment recapture, logging, political or special taxes',
    'T1 Part C; ON428 Part C',
  ],
  [
    'scope.noUnsupportedCarryforwards',
    'No ABIL, farm/fishing, limited-partnership, net-capital-loss or other carryforward pools; only general non-capital losses are supplied below',
    'CRA 2025 line 25200 guidance; T1 Step 4',
  ],
  [
    'scope.noOtherRefunds',
    'No other refunds, rebates, provincial479 credits, social benefit repayments or ACWB/RC210 except the calculated medical expense supplement',
    'T1 Step 6; Schedule6 Step 4',
  ],
  [
    'scope.cwbEligibility',
    'Meets Schedule6 residency/age rules; no disqualifying student, confinement, diplomatic or disability circumstances',
    'Schedule6 page 1',
  ],
  [
    'scope.liftEligibility',
    'No LIFT bankruptcy, confinement or Ontario additional minimum tax exclusion',
    'Ontario 2025 tax information line 85',
  ],
  [
    'scope.noEiSpecialBenefitsAgreement',
    'No EI special-benefits agreement, Schedule 13, PPIP premiums or EI-exempt/special employment',
    'T2204 E (25) instructions and notes',
  ],
  [
    'scope.ordinaryCpp',
    'Ordinary 12-month CPP; no QPP/Quebec earnings, disability/retirement/elections or CPT20',
    'Schedule8 Parts 1–2',
  ],
  [
    'scope.singleOrdinaryT4',
    'At most one T4; all employment is ordinary pensionable/insurable Canadian employment; no special boxes',
    'T1 lines10100/31200; Schedule8',
  ],
  [
    'business.noOtherIncome',
    'No other business income, grants, rebates, recapture or reserves deducted last year',
    'T2125 Part3C lines8290 and8230',
  ],
  [
    'business.simpleService',
    'One Ontario nonprofessional service business, full calendar 2025; no inventory, staff/subcontracts, partnership, reserves, assets/CCA, vehicle/home-office, special expenses, flipped property or GST quick method',
    'T2125 Parts 1–9',
  ],
] as const;
const optionalEducatorBooleanFacts = new Set([
  'educator.eligibleEducator',
  'educator.expensesPaidIn2025',
  'educator.expensesUnreimbursed',
  'educator.expensesNotClaimedElsewhere',
]);
const optionalDonationBooleanFacts = new Set([
  'donations.officialReceiptsReviewed',
  'donations.qualifiedDonees',
  'donations.ordinaryGiftsOnly',
  'donations.noDuplicateClaim',
]);
const money = [
  ['t4.box14', 'Employment income'],
  ['t4.box26', 'CPP pensionable earnings'],
  ['t4.box16', 'CPP contributions'],
  ['t4.box16A', 'Second additional CPP contributions'],
  ['t4.box18', 'EI premiums'],
  [
    't4.box24',
    'EI insurable earnings: box 24, or box 14 only when box 24 is blank',
  ],
  ['t4.box22', 'Income tax deducted'],
  ['interest', 'Domestic taxable interest'],
  ['instalments', 'Tax paid by instalments'],
] as const;
const expenseLines = {
  8521: 'Advertising',
  8690: 'Insurance',
  8760: 'Business taxes/licences',
  8810: 'Office expenses',
  8811: 'Stationery/supplies',
  8860: 'Professional fees',
  8910: 'Rent',
  9220: 'Utilities',
} as const;
export const CANADA_ON_2025_PERSONAL_QUESTIONS = deepFreeze([
  ...guards.map(([key, label, locator]) => ({
    key,
    label,
    type: 'boolean',
    required: true,
    locator,
  })),
  {
    key: 'dateOfBirth',
    label: 'Date of birth',
    type: 'date',
    required: true,
    locator: 'T1 identification; Schedule8',
  },
  {
    key: 'deductions.annualDues',
    label:
      'Reviewed eligible annual union/professional dues from receipts or T4 box 44 (zero when absent)',
    type: 'decimal' as const,
    required: true,
    locator: '2025 T1 line 21200: receipts and box 44 of T4 slips',
  },
  {
    key: 'medical.eligibleSelfExpenses',
    label:
      'Reviewed eligible unreimbursed self medical expenses (zero when absent)',
    type: 'decimal' as const,
    required: true,
    locator: 'T1 line33099; ON428 line58689; reviewed same-period receipts',
  },
  {
    key: 'educator.eligibleEducator',
    label:
      'Reviewed 2025 eligibility: employed in Canada as an eligible teacher or early childhood educator with a recognized certificate, licence, permit or diploma',
    type: 'boolean' as const,
    required: true,
    locator:
      '2025 CRA line 46900 guidance: eligible educator employment and recognized certificate, licence, permit or diploma',
  },
  {
    key: 'educator.expensesPaidIn2025',
    label: 'Reviewed eligible educator supplies were paid during 2025',
    type: 'boolean' as const,
    required: true,
    locator: '2025 CRA line 46900 guidance: eligible supplies expenses',
  },
  {
    key: 'educator.expensesUnreimbursed',
    label:
      'Reviewed educator supplies expenses were not reimbursed, assisted or included in an allowance',
    type: 'boolean' as const,
    required: true,
    locator:
      '2025 CRA line 46900 guidance: reimbursement and assistance restriction',
  },
  {
    key: 'educator.expensesNotClaimedElsewhere',
    label:
      'Reviewed educator supplies expenses were not deducted or claimed elsewhere',
    type: 'boolean' as const,
    required: true,
    locator: '2025 CRA line 46900 guidance: no duplicate deduction or claim',
  },
  {
    key: 'educator.eligibleSuppliesExpenses',
    label:
      'Reviewed eligible educator school-supply expenses paid in 2025 before the $1,000 line 46800 cap (zero when absent)',
    type: 'decimal' as const,
    required: true,
    locator:
      'T1 lines 46800–46900; 2025 CRA line 46900 guidance: line 46800 maximum $1,000',
  },
  {
    key: 'donations.officialReceiptsReviewed',
    label:
      'Reviewed official donation receipts identify the eligible amount after any advantage (false only when no donation claim is selected)',
    type: 'boolean' as const,
    required: true,
    locator: '2025 Schedule 9 instructions; Guide P113 official receipt rules',
  },
  {
    key: 'donations.qualifiedDonees',
    label:
      'Reviewed all claimed donees are CRA qualified donees (false only when no donation claim is selected)',
    type: 'boolean' as const,
    required: true,
    locator: '2025 Schedule 9 line 1; Guide P113 qualified donees',
  },
  {
    key: 'donations.ordinaryGiftsOnly',
    label:
      'Reviewed claimed gifts are ordinary domestic gifts with no capital-property, ecological, cultural, foreign, political or tax-shelter special rule (false only when no donation claim is selected)',
    type: 'boolean' as const,
    required: true,
    locator: '2025 Schedule 9 lines 1–4 and Guide P113 special rules',
  },
  {
    key: 'donations.noDuplicateClaim',
    label:
      'Reviewed claimed eligible amounts were not already claimed on another return or an earlier year',
    type: 'boolean' as const,
    required: true,
    locator:
      '2025 Schedule 9 front-page note and CRA donation carryforward guidance',
  },
  {
    key: 'donations.noExpiredCarryforward',
    label:
      'Reviewed no pre-2020 ordinary donation balance remains that expired before the 2025 return',
    type: 'boolean' as const,
    required: true,
    locator: '2025 Schedule 9 front-page previous-five-years rule',
  },
  {
    key: 'donations.currentEligibleGifts',
    label:
      'Reviewed current-year eligible ordinary donation amounts from official receipts (zero when absent)',
    type: 'decimal' as const,
    required: true,
    locator: '2025 Schedule 9 line 1; official receipts',
  },
  {
    key: 'donations.claimAmount',
    label:
      'Reviewed eligible donation amount selected for the 2025 return (may be partial; zero when not claimed)',
    type: 'decimal' as const,
    required: true,
    locator:
      '2025 CRA donation claim guidance; Schedule 9 line 10/line 34000 election',
  },
  ...CANADA_PERSONAL_DONATION_CARRYFORWARD_YEARS.map((year) => ({
    key: `donations.carryforward.${year}`,
    label: `Reviewed unused ordinary donation balance from ${year}`,
    type: 'decimal' as const,
    required: true,
    locator:
      'CRA donation carryforward continuity and 2025 Schedule 9 previous-five-years rule',
  })),
  ...money.map(([key, label]) => ({
    key,
    label,
    type: 'decimal',
    required: true,
    locator: key.startsWith('t4.')
      ? 'T4 source box; T1/Schedule8'
      : 'T1 Steps2/6',
  })),
  ...[
    ['business.incomeKind', 'Income kind: business or commission', 'text'],
    [
      'business.reportingMethod',
      'Reporting method: cash or accrual (cash is available to commission agents)',
      'text',
    ],
    [
      'business.methodChanged',
      'Did the reporting method change? Changes require a separately reviewed transition calculation',
      'boolean',
    ],
    [
      'business.amountsOnSelectedBasis',
      'All commission or business income and expense amounts are prepared on the selected basis: receipts/payments for cash, earned/incurred for accrual; no automatic ledger conversion',
      'boolean',
    ],
  ].map(([key, label, type]) => ({
    key: key!,
    label: label!,
    type: type! as 'text' | 'boolean',
    required: true,
    locator: 'T2125 Part1; CRA T4002 Chapter1 reporting methods',
  })),
  ...[
    ['business.grossSales', 'Gross sales including GST/HST'],
    [
      'business.9931',
      'Total business liabilities at the end of the fiscal period',
    ],
    ['business.9932', 'Drawings in the current year'],
    ['business.9933', 'Capital contributions in the current year'],
    [
      'business.salesAdjustments',
      'Sales taxes/returns/adjustments included in gross sales',
    ],
    ...Object.entries(expenseLines).map(([line, label]) => [
      `business.${line}`,
      label,
    ]),
  ].map(([key, label]) => ({
    key: key!,
    label: label!,
    type: 'decimal',
    required: true,
    locator: key?.match(/business\.993[123]$/)
      ? 'T2125 Part9: equity details'
      : 'T2125 Parts3A–5; business portion after applicable sales-tax adjustments',
  })),
  ...CANADA_PERSONAL_NONCAPITAL_LOSS_YEARS.map((year) => ({
    key: personalNonCapitalLossFactKey(year),
    label: `Available general non-capital loss balance from ${year}`,
    type: 'decimal' as const,
    required: true,
    locator:
      'CRA line 25200: reviewed notice-of-assessment or reassessment continuity balance',
  })),
] as const);
type Issue = { code: string; path: string; message: string };
export type PersonalFormField = {
  id: string;
  form: string;
  line: string;
  label: string;
  dependencies: string[];
  sourceId: string;
  locator: string;
  exactRational: { numerator: string; denominator: string };
  exactDecimal: string | null;
  reportableAmount: string | null;
  /** Only the BPA worksheet line 7 uses this non-CAD unit. */
  unit?: 'dimensionless';
  provenance?: Canada2025DimensionlessProvenance;
};
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object')
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(',')}}`;
  return JSON.stringify(v);
}
const digest = (v: unknown) =>
  createHash('sha256').update(canonical(v)).digest('hex');

/** Input review and access must be established by trusted persistence; this pure adapter never grants either. */
export function assessCanadaOntario2025PersonalFacts(raw: unknown) {
  const parsed = FinanceTaxIntakeSchema.safeParse(raw);
  const issues: Issue[] = [];
  if (!parsed.success)
    return {
      intake: null,
      issues: [
        {
          code: 'invalid-intake',
          path: 'intake',
          message: 'A complete versioned intake envelope is required.',
        },
      ],
    };
  const intake = parsed.data;
  if (
    !CANADA_ON_2025_PERSONAL_CANDIDATE.scopes.some(
      (s) => canonical(s) === canonical(intake.scope),
    )
  )
    issues.push({
      code: 'unsupported-scope',
      path: 'scope',
      message: 'Exact candidate scope/form/year coverage is required.',
    });
  if (
    intake.domesticResident !== true ||
    intake.hasCrossBorderActivity !== false ||
    intake.requestedFeatures.length !== 1 ||
    intake.requestedFeatures[0] !== 'income-tax-return'
  )
    issues.push({
      code: 'unsupported-case',
      path: 'intake',
      message: 'Only domestic income-tax-return review is covered.',
    });
  const expected = new Set(
    [
      ...CANADA_ON_2025_PERSONAL_QUESTIONS,
      ...privateFormFacts,
      ...(intake.scope.taxpayerType === 'sole-proprietor'
        ? privateBusinessFacts
        : []),
    ].map((x) => x.key),
  );
  for (const fact of intake.facts) {
    if (!expected.has(fact.key))
      issues.push({
        code: 'unsupported-fact',
        path: fact.key,
        message: 'Unknown input cannot silently be omitted.',
      });
    if (
      fact.source.kind === 'ledger-snapshot' &&
      !intake.sourceBooks.some(
        (b) =>
          b.bookId === fact.source.sourceBookId &&
          b.snapshotRevision === fact.source.revision &&
          b.snapshotHash === fact.source.contentHash,
      )
    )
      issues.push({
        code: 'source-snapshot-mismatch',
        path: fact.key,
        message: 'Fact must match an explicitly bound book snapshot.',
      });
  }
  const methodKeys = new Set([
    'business.incomeKind',
    'business.reportingMethod',
    'business.methodChanged',
    'business.amountsOnSelectedBasis',
  ]);
  for (const question of CANADA_ON_2025_PERSONAL_QUESTIONS) {
    if (
      intake.scope.taxpayerType === 'individual' &&
      methodKeys.has(question.key)
    )
      continue;
    const fact = intake.facts.find((f) => f.key === question.key);
    if (!fact) {
      issues.push({
        code: 'missing-fact',
        path: question.key,
        message: question.label,
      });
      continue;
    }
    if (fact.reviewState !== 'reviewed')
      issues.push({
        code: 'unreviewed-fact',
        path: question.key,
        message: 'Unreviewed or disputed inputs cannot drive this calculation.',
      });
    if (fact.value.type !== question.type)
      issues.push({
        code: 'wrong-fact-type',
        path: question.key,
        message: `Expected ${question.type}.`,
      });
    else if (
      question.key === 'business.methodChanged' &&
      fact.value.type === 'boolean' &&
      fact.value.value
    )
      issues.push({
        code: 'unsupported-accounting-method-transition',
        path: question.key,
        message:
          'Method changes require adjustment statements and any required CRA permission; transition calculations are not yet implemented.',
      });
    else if (
      fact.value.type === 'boolean' &&
      question.key !== 'business.methodChanged' &&
      !optionalEducatorBooleanFacts.has(question.key) &&
      !optionalDonationBooleanFacts.has(question.key) &&
      fact.value.value !== true
    )
      issues.push({
        code: 'unsupported-feature',
        path: question.key,
        message: question.label,
      });
    else if (
      fact.value.type === 'decimal' &&
      !/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/.test(fact.value.value)
    )
      issues.push({
        code: 'invalid-money',
        path: question.key,
        message:
          'Reviewed CAD source amount must be nonnegative with at most two decimal places.',
      });
  }
  if (intake.scope.taxpayerType === 'sole-proprietor') {
    const kind = intake.facts.find(
      (f) => f.key === 'business.incomeKind',
    )?.value;
    const method = intake.facts.find(
      (f) => f.key === 'business.reportingMethod',
    )?.value;
    if (
      kind?.type === 'text' &&
      !['business', 'commission'].includes(kind.value)
    )
      issues.push({
        code: 'invalid-business-income-kind',
        path: 'business.incomeKind',
        message: 'Select business or commission explicitly.',
      });
    if (method?.type === 'text' && !['cash', 'accrual'].includes(method.value))
      issues.push({
        code: 'invalid-reporting-method',
        path: 'business.reportingMethod',
        message: 'Select cash or accrual explicitly.',
      });
    if (
      kind?.type === 'text' &&
      kind.value === 'business' &&
      method?.type === 'text' &&
      method.value === 'cash'
    )
      issues.push({
        code: 'unsupported-reporting-method',
        path: 'business.reportingMethod',
        message:
          'Ordinary service business income must use accrual; cash reporting is available for the commission branch.',
      });
  }
  const employment = intake.facts.find((f) => f.key === 't4.box14')?.value;
  if (
    employment?.type === 'decimal' &&
    q(employment.value).n === 0n &&
    intake.facts.some(
      (f) =>
        f.key.startsWith('t4.') &&
        f.value.type === 'decimal' &&
        q(f.value.value).n !== 0n,
    )
  )
    issues.push({
      code: 'inconsistent-empty-t4',
      path: 't4',
      message:
        'A zero-income ordinary T4 cannot hide pensionable earnings, contributions or tax withheld.',
    });
  const birth = intake.facts.find((f) => f.key === 'dateOfBirth')?.value;
  if (
    birth?.type === 'date' &&
    (birth.value < '1961-01-01' || birth.value > '2006-12-31')
  )
    issues.push({
      code: 'unsupported-age',
      path: 'dateOfBirth',
      message: 'Candidate covers ages19–64 only.',
    });
  if (
    intake.scope.taxpayerType === 'individual' &&
    intake.facts.some(
      (f) =>
        f.key.startsWith('business.') &&
        f.value.type === 'decimal' &&
        q(f.value.value).n !== 0n,
    )
  )
    issues.push({
      code: 'business-requires-sole-proprietor-scope',
      path: 'scope.taxpayerType',
      message: 'Business amounts require explicit sole-proprietor coverage.',
    });
  return { intake, issues };
}

/** Executes a connected annual form graph. Exact values are working figures, not amounts approved for filing. */
export function runCanadaOntario2025PersonalWorkflow(
  raw: unknown,
  packageVersion = CANADA_ON_2025_PERSONAL_PACKAGE_VERSION,
) {
  const assessed = assessCanadaOntario2025PersonalFacts(raw);
  const issues = [...assessed.issues];
  if (packageVersion !== CANADA_ON_2025_PERSONAL_PACKAGE_VERSION)
    issues.push({
      code: 'package-version-mismatch',
      path: 'packageVersion',
      message: 'Historical rules cannot be silently replaced.',
    });
  const fields: PersonalFormField[] = [];
  const values = new Map<string, PersonalExact>();
  let federalBasicPersonalAmountWorksheet: ReturnType<
    typeof serializeCanada2025FederalBasicPersonalAmount
  > | null = null;
  let educatorSchoolSupplyCredit: ReturnType<
    typeof calculateCanada2025EducatorSchoolSupplyCredit
  > | null = null;
  let charitableDonations: ReturnType<
    typeof calculateCanada2025FederalCharitableDonations
  > | null = null;
  const base = {
    schemaVersion: 1,
    packageId: CANADA_ON_2025_PERSONAL_CANDIDATE.id,
    packageVersion,
    complete: false as const,
    enabled: false as const,
    reportable: false as const,
    registryEligible: false as const,
    sources: CANADA_ON_2025_PERSONAL_CANDIDATE.sources,
    releaseBlockers: CANADA_ON_2025_PERSONAL_CANDIDATE.releaseBlockers,
    carryforwardPolicyVersion: CANADA_PERSONAL_CARRYFORWARD_VERSION,
  };
  const finish = (
    intake: FinanceTaxIntake | null,
    cpp: ReturnType<typeof calculateCanadaCpp2025> | null,
    carryforward: ReturnType<
      typeof calculateCanadaPersonalNonCapitalLossCarryforward2025
    > | null,
  ) => {
    const output = {
      ...base,
      status: issues.length
        ? ('blocked' as const)
        : ('review-calculation-produced' as const),
      inputSnapshot: intake,
      inputHash: digest(intake),
      issues,
      reportingPolicyVersion: PERSONAL_PAPER_REPORTING_POLICY_VERSION,
      fields: applyCanadaPersonalPaperReporting(
        intake?.scope.taxpayerType === 'individual'
          ? fields.filter((f) => f.form !== 'T2125')
          : fields,
        issues.length > 0,
      ),
      cpp,
      carryforward,
      federalBasicPersonalAmountWorksheet,
      educatorSchoolSupplyCredit,
      charitableDonations,
      formCoverage: base.sources.map((s) => ({
        sourceId: s.id,
        formVersion: s.formVersion,
        fieldCount: fields.filter((f) => f.sourceId === s.id).length,
        complete: false,
      })),
      finalAmounts: { refund: null, balanceOwing: null },
    };
    return deepFreeze({ ...output, runHash: digest(output) });
  };
  if (!assessed.intake || issues.length)
    return finish(assessed.intake, null, null);
  const intake = assessed.intake;
  const fact = (key: string) => {
    const f = intake.facts.find((f) => f.key === key)!;
    if (f.value.type !== 'decimal') throw Error('money-fact-required');
    return q(f.value.value);
  };
  const text = (key: string) => {
    const v = intake.facts.find((f) => f.key === key)!.value;
    return String(v.value);
  };
  const factBoolean = (key: string) => {
    const v = intake.facts.find((f) => f.key === key)!.value;
    if (v.type !== 'boolean') throw Error('boolean-fact-required');
    return v.value;
  };
  const at = (id: string) => {
    const v = values.get(id);
    if (!v) throw Error(`missing-form-dependency:${id}`);
    return v;
  };
  const field = (
    id: string,
    label: string,
    value: PersonalExact,
    deps: string[],
    sourceId = 'cra-5006-r-2025-etext',
    locator = '2025 annual form printed line formula',
  ) => {
    const [form, ...line] = id.split('.');
    values.set(id, value);
    fields.push({
      id,
      form: form!,
      line: line.join('.'),
      label,
      dependencies: deps,
      sourceId,
      locator,
      ...serialize(value),
      reportableAmount: null,
    });
    return value;
  };
  const dimensionlessField = (
    id: string,
    label: string,
    value: ReturnType<typeof serializeDimensionlessRatio>,
    deps: string[],
    sourceId: string,
    locator: string,
  ) => {
    const [form, ...line] = id.split('.');
    fields.push({
      id,
      form: form!,
      line: line.join('.'),
      label,
      dependencies: deps,
      sourceId,
      locator,
      exactRational: value.exactRational,
      exactDecimal: value.exactDecimal,
      reportableAmount: null,
      unit: 'dimensionless',
      provenance: value.provenance,
    });
  };
  const zero = q('0');
  field('T1.10100', 'Employment income', fact('t4.box14'), ['fact:t4.box14']);
  field('T1.12100', 'Domestic interest', fact('interest'), ['fact:interest']);
  const business = intake.scope.taxpayerType === 'sole-proprietor';
  const commission = business && text('business.incomeKind') === 'commission';
  const basisDependencies = business
    ? [
        'fact:business.incomeKind',
        'fact:business.reportingMethod',
        'fact:business.methodChanged',
        'fact:business.amountsOnSelectedBasis',
      ]
    : [];
  field(
    'T2125.3A',
    'Gross sales including GST/HST',
    fact('business.grossSales'),
    ['fact:business.grossSales', ...basisDependencies],
    'cra-t2125-2025',
    'Part3A amount3A',
  );
  field(
    'T2125.3B',
    'Sales taxes, returns and adjustments included in gross sales',
    fact('business.salesAdjustments'),
    ['fact:business.salesAdjustments', ...basisDependencies],
    'cra-t2125-2025',
    'Part3A amount3B',
  );
  field(
    'T2125.3C',
    'Gross sales less adjustments',
    minus(at('T2125.3A'), at('T2125.3B')),
    ['T2125.3A', 'T2125.3B'],
    'cra-t2125-2025',
    'Part3A amount3C',
  );
  field(
    'T2125.3G',
    'Adjusted gross sales; no quick method',
    at('T2125.3C'),
    ['T2125.3C', 'fact:business.simpleService'],
    'cra-t2125-2025',
    'Part3A amount3G; reviewed no quick method',
  );
  const gross = field(
    'T2125.8000',
    'Adjusted gross sales',
    at('T2125.3G'),
    ['T2125.3G'],
    'cra-t2125-2025',
    'Part3A amounts3A–3G',
  );
  if (gross.n < 0n) {
    issues.push({
      code: 'invalid-business-adjustments',
      path: 'business.salesAdjustments',
      message: 'Adjustments cannot exceed gross sales for this candidate.',
    });
    return finish(intake, null, null);
  }
  field(
    'T2125.8299',
    'Gross business income',
    gross,
    ['T2125.8000', 'fact:business.noOtherIncome'],
    'cra-t2125-2025',
    'Part3C; no reserves/other income',
  );
  field(
    'T2125.8519',
    'Gross profit',
    gross,
    ['T2125.8299'],
    'cra-t2125-2025',
    'Part3D; no cost-of-goods inventory',
  );
  field(
    'T2125.4A',
    'Gross profit transferred to expenses calculation',
    at('T2125.8519'),
    ['T2125.8519'],
    'cra-t2125-2025',
    'Part4 amount4A',
  );
  for (const [line, label] of Object.entries(expenseLines))
    field(
      `T2125.${line}`,
      label,
      fact(`business.${line}`),
      [`fact:business.${line}`, ...basisDependencies],
      'cra-t2125-2025',
      'Part4; reviewed business portion',
    );
  field(
    'T2125.9368',
    'Total covered business expenses',
    plus(...Object.keys(expenseLines).map((l) => at(`T2125.${l}`))),
    Object.keys(expenseLines).map((l) => `T2125.${l}`),
    'cra-t2125-2025',
    'Part4 total; all other expense categories excluded',
  );
  field(
    'T2125.9368.copy2',
    'Total expenses carried across the printed form',
    at('T2125.9368'),
    ['T2125.9368'],
    'cra-t2125-2025',
    'Part4 line9368 instance2',
  );
  field(
    'T2125.9369',
    'Net income before adjustments',
    minus(at('T2125.4A'), at('T2125.9368')),
    ['T2125.4A', 'T2125.9368'],
    'cra-t2125-2025',
    'Part4',
  );
  field(
    'T2125.5A',
    'Sole owner share of net income',
    at('T2125.9369'),
    ['T2125.9369', 'fact:business.simpleService'],
    'cra-t2125-2025',
    'Part5 amount5A',
  );
  field(
    'T2125.5C',
    'Total share after partnership additions',
    at('T2125.5A'),
    ['T2125.5A', 'fact:business.simpleService'],
    'cra-t2125-2025',
    'Part5 amount5C; no partnership allocations or rebates',
  );
  field(
    'T2125.5C.copy2',
    'Total share carried across the printed form',
    at('T2125.5C'),
    ['T2125.5C'],
    'cra-t2125-2025',
    'Part5 amount5C instance2',
  );
  field(
    'T2125.5D',
    'Net income after partnership adjustments',
    at('T2125.5C'),
    ['T2125.5C', 'fact:business.simpleService'],
    'cra-t2125-2025',
    'Part5 amount5D; no partnership expenses',
  );
  for (const [line, label] of [
    ['9931', 'Total business liabilities'],
    ['9932', 'Drawings in the current year'],
    ['9933', 'Capital contributions in the current year'],
  ])
    field(
      `T2125.${line}`,
      label!,
      fact(`business.${line}`),
      [`fact:business.${line}`, ...basisDependencies],
      'cra-t2125-2025',
      `Part9 line${line}; does not adjust business profit`,
    );
  field(
    'T2125.9946',
    'Net business income',
    at('T2125.5D'),
    ['T2125.5D', 'fact:business.simpleService'],
    'cra-t2125-2025',
    'Part5; sole owner, no partnership/home-office adjustments',
  );
  if (at('T2125.9946').n < 0n) {
    issues.push({
      code: 'business-loss-not-covered',
      path: 'business',
      message: 'Loss eligibility and carryovers require additional schedules.',
    });
    return finish(intake, null, null);
  }
  field(
    'T1.13499',
    'Gross business income',
    business && !commission ? gross : zero,
    business ? ['T2125.8299', ...basisDependencies] : [],
  );
  field(
    'T1.13500',
    'Net business income',
    business && !commission ? at('T2125.9946') : zero,
    business ? ['T2125.9946', ...basisDependencies] : [],
  );
  field(
    'T1.13899',
    'Gross commission income',
    commission ? at('T2125.8299') : zero,
    business ? ['T2125.8299', ...basisDependencies] : [],
  );
  field(
    'T1.13900',
    'Net commission income',
    commission ? at('T2125.9946') : zero,
    business ? ['T2125.9946', ...basisDependencies] : [],
  );
  const netSelfEmployment = plus(at('T1.13500'), at('T1.13900'));
  field(
    'T1.15000',
    'Total income',
    plus(at('T1.10100'), at('T1.12100'), netSelfEmployment),
    ['T1.10100', 'T1.12100', 'T1.13500', 'T1.13900'],
  );
  const cpp = calculateCanadaCpp2025({
    schemaVersion: 1,
    year: 2025,
    currency: 'CAD',
    residentProvinceOnDecember31: 'ON',
    domesticCase: true,
    hasQuebecEarnedIncome: false,
    hasQppContributions: false,
    dateOfBirth: text('dateOfBirth'),
    dateOfDeath: null,
    disabilityPensionMonths: [],
    retirementPensionStartDate: null,
    election: { kind: 'none' },
    basicExemption: { kind: 'published-table' },
    t4Slips:
      fact('t4.box14').n === 0n
        ? []
        : [
            {
              reference: intake.facts.find((f) => f.key === 't4.box14')!.source
                .reference,
              box14: text('t4.box14'),
              box26: text('t4.box26'),
              box16: text('t4.box16'),
              box16A: text('t4.box16A'),
            },
          ],
    annualNetSelfEmploymentEarnings: serialize(netSelfEmployment).exactDecimal!,
    otherEarningsElection: { kind: 'none' },
  });
  if (cpp.status === 'blocked') {
    issues.push(
      ...cpp.issues.map((message) => ({
        code: 'cpp-blocked',
        path: 'Schedule8',
        message,
      })),
    );
    return finish(intake, cpp, null);
  }
  for (const item of cpp.worksheet.filter(
    (item) =>
      cpp.branch !== 'self-employment-only' ||
      !item.locator.startsWith('part3.'),
  ))
    field(
      `Schedule8.${item.locator}`,
      'CPP worksheet',
      rational(
        BigInt(item.exactRational.numerator),
        BigInt(item.exactRational.denominator),
      ),
      personalCppWorksheetDependencies(
        item.locator,
        cpp.worksheet.map((line) => line.locator),
      ) ?? ['Schedule8.part5.reporting-proof-unresolved'],
      CANADA_CPP_2025_SOURCE.id,
      item.locator,
    );
  for (const [line, result] of Object.entries(cpp.returnLines))
    field(
      `T1.${line}`,
      'CPP return transfer',
      rational(
        BigInt(result.exactRational.numerator),
        BigInt(result.exactRational.denominator),
      ),
      personalCppTransferDependencies(
        line,
        cpp.branch,
        cpp.worksheet.map((item) => item.locator),
      ),
      CANADA_CPP_2025_SOURCE.id,
      `Schedule8 transfer to line${line}`,
    );
  field(
    'T1.42120',
    'Employment insurance premiums payable on self-employment and other eligible earnings',
    zero,
    ['fact:scope.noEiSpecialBenefitsAgreement', 'fact:scope.noOtherIncome'],
    'cra-5006-r-2025-fillable',
    'form1.Page7.Step6.Line42120.Line_42120_Amount; Schedule13 not applicable because no self-employed EI special-benefits registration',
  );
  field(
    'T1.42200',
    'Social benefits repayment transferred from line 23500',
    zero,
    ['fact:scope.noOtherIncome'],
    'cra-5006-r-2025-fillable',
    'form1.Page7.Step6.Line42200.Line_42200_Amount; line23500 absent under reviewed no-other-income scope',
  );
  field(
    'T1.21200',
    'Annual union, professional, or like dues',
    fact('deductions.annualDues'),
    [
      'fact:deductions.annualDues',
      'fact:scope.duesEligibleUnreimbursed',
      'fact:scope.duesNotClaimedInBusiness',
    ],
    'cra-5006-r-2025-etext',
    'T1 printed line 39 / 21200: receipts and T4 box 44',
  );
  field(
    'T1.23300',
    'Total deductions',
    plus(plus(at('T1.22200'), at('T1.22215')), at('T1.21200')),
    ['T1.22200', 'T1.22215', 'T1.21200'],
  );
  field(
    'T1.23600',
    'Net income',
    positive(minus(at('T1.15000'), at('T1.23300'))),
    ['T1.15000', 'T1.23300'],
  );
  const carryforward = calculateCanadaPersonalNonCapitalLossCarryforward2025(
    intake.facts,
    at('T1.23600'),
  );
  if (carryforward.issues.length)
    issues.push(
      ...carryforward.issues.map((issue) => ({
        code: `carryforward-${issue.code}`,
        path: issue.path,
        message: issue.message,
      })),
    );
  field(
    'T1.25200',
    'Non-capital losses of other years',
    rational(
      BigInt(carryforward.claimedTotal.exactRational.numerator),
      BigInt(carryforward.claimedTotal.exactRational.denominator),
    ),
    [
      'T1.23600',
      'fact:scope.noUnsupportedCarryforwards',
      ...CANADA_PERSONAL_NONCAPITAL_LOSS_YEARS.map(
        (year) => `fact:${personalNonCapitalLossFactKey(year)}`,
      ),
    ],
    'cra-5006-r-2025-etext',
    'T1 line25200; oldest eligible general non-capital losses first',
  );
  field(
    'T1.26000',
    'Taxable income',
    positive(minus(at('T1.23600'), at('T1.25200'))),
    ['T1.23600', 'T1.25200'],
  );
  const donationInputDependencies = [
    'fact:donations.currentEligibleGifts',
    'fact:donations.claimAmount',
    'fact:donations.officialReceiptsReviewed',
    'fact:donations.qualifiedDonees',
    'fact:donations.ordinaryGiftsOnly',
    'fact:donations.noDuplicateClaim',
    'fact:donations.noExpiredCarryforward',
    ...CANADA_PERSONAL_DONATION_CARRYFORWARD_YEARS.map(
      (year) => `fact:donations.carryforward.${year}`,
    ),
    'fact:scope.noOtherCredits',
  ];
  const donation = calculateCanada2025FederalCharitableDonations({
    currentEligibleGifts: fact('donations.currentEligibleGifts'),
    claimAmount: fact('donations.claimAmount'),
    netIncome: at('T1.23600'),
    taxableIncome: at('T1.26000'),
    carryforward: CANADA_PERSONAL_DONATION_CARRYFORWARD_YEARS.map((year) => ({
      year,
      amount: fact(`donations.carryforward.${year}`),
      factKey: `donations.carryforward.${year}`,
      sourceBinding: intake.facts.find(
        (f) => f.key === `donations.carryforward.${year}`,
      )!.source,
    })),
    eligibility: {
      officialReceiptsReviewed: factBoolean(
        'donations.officialReceiptsReviewed',
      ),
      qualifiedDonees: factBoolean('donations.qualifiedDonees'),
      ordinaryGiftsOnly: factBoolean('donations.ordinaryGiftsOnly'),
      noDuplicateClaim: factBoolean('donations.noDuplicateClaim'),
      noExpiredCarryforward: factBoolean('donations.noExpiredCarryforward'),
    },
  });
  charitableDonations = donation;
  if (donation.status === 'blocked') {
    issues.push(
      ...donation.issues.map((issue) => ({
        code: `donations-${issue.code}`,
        path: issue.path,
        message: issue.message,
      })),
    );
    return finish(intake, cpp, carryforward);
  }
  const donationSource = 'cra-5000-s9-2025-fillable';
  const donationField = (
    line: string,
    label: string,
    value: ReturnType<typeof exactCanada2025DonationAmount>,
    dependencies: string[],
    locator: string,
  ) =>
    field(
      `Schedule9.${line}`,
      label,
      value,
      dependencies,
      donationSource,
      locator,
    );
  donationField(
    '1',
    'Selected ordinary eligible donations from current year and valid carryforwards',
    exactCanada2025DonationAmount(donation.schedule9.line1),
    donationInputDependencies,
    'form1.Page1.Line1.Amount; ordinary line 1 input after reviewed oldest-first carryforward election',
  );
  donationField(
    '5',
    'Total eligible ordinary charitable donations',
    exactCanada2025DonationAmount(donation.schedule9.line5),
    ['Schedule9.1'],
    'form1.Page1.Line5.Amount; add lines 1–4 with lines 2–4 outside supported ordinary scope',
  );
  donationField(
    '6A',
    'Net income used for the Schedule 9 limit',
    at('T1.23600'),
    ['T1.23600'],
    'form1.Page1.Line6.AmountA.Amount; amount A from T1 line 23600',
  );
  donationField(
    '6',
    '75% of net income',
    exactCanada2025DonationAmount(donation.schedule9.line6),
    ['Schedule9.6A'],
    'form1.Page1.Line6.Amount; amount A multiplied by 75%',
  );
  donationField(
    '7D',
    'Capital-property donation limit increase excluded by ordinary scope',
    q('0'),
    ['fact:donations.ordinaryGiftsOnly'],
    'form1.Page1.Line7.AmountD.Amount; capital-property amounts B plus C are outside this ordinary branch',
  );
  donationField(
    '7',
    '25% capital-property limit increase excluded by ordinary scope',
    q('0'),
    ['Schedule9.7D', 'fact:donations.ordinaryGiftsOnly'],
    'form1.Page1.Line7.Amount; amount D multiplied by 25%',
  );
  donationField(
    '8',
    'Total charitable donation limit base',
    exactCanada2025DonationAmount(donation.schedule9.line8),
    ['Schedule9.6', 'Schedule9.7'],
    'form1.Page1.Line8.Amount; line 6 plus line 7',
  );
  donationField(
    '9',
    'Total charitable donations limit',
    exactCanada2025DonationAmount(donation.schedule9.line9),
    ['Schedule9.5', 'Schedule9.8'],
    'form1.Page1.Line9.Amount; lesser of amount A or line 8',
  );
  donationField(
    '10',
    'Allowable charitable donations selected for line 34000',
    exactCanada2025DonationAmount(donation.schedule9.line10),
    ['Schedule9.5', 'Schedule9.9'],
    'form1.Page1.Line10.Amount; lesser of selected line 5 or line 9',
  );
  donationField(
    '11',
    'Ecological and cultural gifts excluded by ordinary scope',
    exactCanada2025DonationAmount(donation.schedule9.line11),
    ['fact:donations.ordinaryGiftsOnly'],
    'form1.Page1.Line11.Amount; special ecological/cultural gifts remain outside this branch',
  );
  donationField(
    '12',
    'Total eligible donations for rate calculation',
    exactCanada2025DonationAmount(donation.schedule9.line12),
    ['Schedule9.10', 'Schedule9.11'],
    'form1.Page1.Line12.Amount; line 10 plus line 11',
  );
  donationField(
    '13',
    'First $200 of eligible donations',
    exactCanada2025DonationAmount(donation.schedule9.line13),
    ['Schedule9.12'],
    'form1.Page1.Line13.Amount_Line13; lesser of line 12 or $200',
  );
  donationField(
    '14',
    'Eligible donations above the first $200',
    exactCanada2025DonationAmount(donation.schedule9.line14),
    ['Schedule9.12', 'Schedule9.13'],
    'form1.Page1.Line14.Amount_Line14; line 12 minus line 13',
  );
  donationField(
    '15',
    'Pre-2016 ecological gifts excluded by ordinary scope',
    exactCanada2025DonationAmount(donation.schedule9.line15),
    ['fact:donations.ordinaryGiftsOnly'],
    'form1.Page1.Line15.Amount; special ecological transition amount excluded',
  );
  donationField(
    '16',
    'Eligible donations above $200 after excluded ecological transition amount',
    exactCanada2025DonationAmount(donation.schedule9.line16),
    ['Schedule9.14', 'Schedule9.15'],
    'form1.Page1.Line16.Amount; line 14 minus line 15, floored at zero',
  );
  donationField(
    '17',
    'Taxable income used for the high-rate donation tier',
    exactCanada2025DonationAmount(donation.schedule9.line17),
    ['T1.26000'],
    'form1.Page1.Line17.Amount; amount from T1 line 26000',
  );
  donationField(
    '18',
    '2025 federal high-rate income threshold',
    exactCanada2025DonationAmount(donation.schedule9.line18),
    [],
    'form1.Page1.Line18.Amount; published 253,414.00 threshold',
  );
  donationField(
    '19',
    'Taxable income above the high-rate threshold',
    exactCanada2025DonationAmount(donation.schedule9.line19),
    ['Schedule9.17', 'Schedule9.18'],
    'form1.Page1.Line19.Amount; line 17 minus line 18, floored at zero',
  );
  donationField(
    '20Base',
    'Donation amount eligible for the 33% rate',
    exactCanada2025DonationAmount(donation.schedule9.line20Base),
    ['Schedule9.16', 'Schedule9.19'],
    'form1.Page2.Line20.AmountF.Amount; lesser of line 16 or line 19',
  );
  donationField(
    '20',
    'High-rate donation credit at 33%',
    exactCanada2025DonationAmount(donation.schedule9.line20),
    ['Schedule9.20Base'],
    'form1.Page2.Line20.Amount; amount F multiplied by 33%',
  );
  donationField(
    '21Base',
    'Donation amount eligible for the 29% rate',
    exactCanada2025DonationAmount(donation.schedule9.line21Base),
    ['Schedule9.14', 'Schedule9.20Base'],
    'form1.Page2.Line21.AmountG.Amount; amount E minus amount F',
  );
  donationField(
    '21',
    'Middle-rate donation credit at 29%',
    exactCanada2025DonationAmount(donation.schedule9.line21),
    ['Schedule9.21Base'],
    'form1.Page2.Line21.Amount; amount G multiplied by 29%',
  );
  donationField(
    '22',
    'Lowest-rate donation credit at 14.5%',
    exactCanada2025DonationAmount(donation.schedule9.line22),
    ['Schedule9.13'],
    'form1.Page2.Line22.Amount; amount H multiplied by 14.5%',
  );
  const donationLine23 = donationField(
    '23',
    'Allowable donations for 2025 transferred to T1 line 34900',
    exactCanada2025DonationAmount(donation.schedule9.line23),
    ['Schedule9.20', 'Schedule9.21', 'Schedule9.22'],
    'form1.Page2.Line23.Amount; add lines 20 to 22',
  );
  field(
    'T1.34900',
    'Donations and gifts tax credit from Schedule 9',
    donationLine23,
    ['Schedule9.23', ...donationInputDependencies],
    'cra-5006-r-2025-fillable',
    'form1.Page6.PartB.Line34900.Line_34900_Amount; amount from Schedule 9 line 23',
  );
  const federalTaxWorksheet = calculateCanada2025FederalTaxWorksheet(
    at('T1.26000'),
  );
  const federalTaxColumn = federalTaxWorksheet.column;
  const federalTaxSource = 'cra-5006-r-2025-fillable';
  const federalTaxField = (
    line: string,
    label: string,
    value: PersonalExact,
    dependencies: string[],
    locator: string,
  ) =>
    field(
      `FederalTax.Column${federalTaxColumn}.${line}`,
      label,
      value,
      dependencies,
      federalTaxSource,
      locator,
    );
  const federalTaxPath = (line: 70 | 71 | 72 | 74 | 75 | 76) => {
    const suffix = {
      70: `Line36Amount${federalTaxColumn}`,
      71: `Line37Amount${federalTaxColumn}`,
      72: `Line38Amount${federalTaxColumn}`,
      74: `Line40Amount${federalTaxColumn}`,
      75: `Line41Amount${federalTaxColumn}`,
      76: `Line42Amount${federalTaxColumn}`,
    }[line];
    return `form1.Page5.PartA.Column${federalTaxColumn}.${suffix}`;
  };
  federalTaxField(
    '70',
    'Taxable income selected by the federal Part A column',
    federalTaxWorksheet.line70,
    ['T1.26000'],
    federalTaxPath(70),
  );
  federalTaxField(
    '71',
    'Federal Part A column threshold',
    federalTaxWorksheet.line71,
    [],
    federalTaxPath(71),
  );
  federalTaxField(
    '72',
    'Taxable income above the federal Part A threshold',
    federalTaxWorksheet.line72,
    [
      `FederalTax.Column${federalTaxColumn}.70`,
      `FederalTax.Column${federalTaxColumn}.71`,
    ],
    federalTaxPath(72),
  );
  federalTaxField(
    '74',
    `Federal Part A line 72 multiplied by the printed line 73 rate (${serialize(federalTaxWorksheet.line73Rate).exactDecimal})`,
    federalTaxWorksheet.line74,
    [`FederalTax.Column${federalTaxColumn}.72`],
    federalTaxPath(74),
  );
  federalTaxField(
    '75',
    'Federal Part A published base amount',
    federalTaxWorksheet.line75,
    [],
    federalTaxPath(75),
  );
  federalTaxField(
    '76',
    'Federal tax on taxable income from the selected Part A column',
    federalTaxWorksheet.line76,
    [
      `FederalTax.Column${federalTaxColumn}.74`,
      `FederalTax.Column${federalTaxColumn}.75`,
    ],
    federalTaxPath(76),
  );
  field(
    'T1.119',
    'Federal tax on taxable income transferred from Part A line 76',
    federalTaxWorksheet.line76,
    [`FederalTax.Column${federalTaxColumn}.76`],
    federalTaxSource,
    'form1.Page7.PartC.Line124.Amount',
  );
  const net = at('T1.23600');
  const bpaCalculation = calculateCanada2025FederalBasicPersonalAmount(net);
  federalBasicPersonalAmountWorksheet =
    serializeCanada2025FederalBasicPersonalAmount(bpaCalculation);
  const bpaWorksheet = bpaCalculation.worksheet;
  if (bpaWorksheet) {
    const source = 'cra-5000-d1-2025-fillable';
    const worksheetField = (
      line: string,
      label: string,
      value: PersonalExact,
      deps: string[],
      locator: string,
    ) => field(`FederalBpa.${line}`, label, value, deps, source, locator);
    worksheetField(
      '1',
      'Base amount',
      bpaWorksheet.line1,
      [],
      'form1.Page3.Line30000.Line1.Line1_Amount',
    );
    worksheetField(
      '2',
      'Supplement amount',
      bpaWorksheet.line2,
      [],
      'form1.Page3.Line30000.Line2.Line2_Amount',
    );
    worksheetField(
      '3',
      'Amount from line 23600 of the return',
      bpaWorksheet.line3,
      ['T1.23600'],
      'form1.Page3.Line30000.Line3.Line3_Amount',
    );
    worksheetField(
      '4',
      'Income threshold',
      bpaWorksheet.line4,
      [],
      'form1.Page3.Line30000.Line4.Line4_Amount',
    );
    worksheetField(
      '5',
      'Line 3 minus line 4',
      bpaWorksheet.line5,
      ['FederalBpa.3', 'FederalBpa.4'],
      'form1.Page3.Line30000.Line5.Line5_Amount',
    );
    worksheetField(
      '6',
      'Division denominator',
      bpaWorksheet.line6,
      [],
      'form1.Page3.Line30000.Line6.Amount',
    );
    dimensionlessField(
      'FederalBpa.7',
      'Line 5 divided by line 6 (dimensionless ratio)',
      serializeDimensionlessRatio(bpaWorksheet.line7),
      ['FederalBpa.5', 'FederalBpa.6'],
      source,
      'form1.Page3.Line30000.Line7.Amount',
    );
    worksheetField(
      '8',
      'Supplement amount carried to line 8',
      bpaWorksheet.line8,
      ['FederalBpa.2'],
      'form1.Page3.Line30000.Line8.Line2_Amount',
    );
    worksheetField(
      '9',
      'Line 7 multiplied by line 8',
      bpaWorksheet.line9,
      ['FederalBpa.7', 'FederalBpa.8'],
      'form1.Page3.Line30000.Line9.Amount1',
    );
    worksheetField(
      '9.copy2',
      'Line 9 carried to the second printed instance',
      bpaWorksheet.line9,
      ['FederalBpa.9'],
      'form1.Page3.Line30000.Line9.Amount2',
    );
    worksheetField(
      '10',
      'Line 2 minus line 9, floored at zero',
      bpaWorksheet.line10,
      ['FederalBpa.2', 'FederalBpa.9'],
      'form1.Page3.Line30000.Line10.Amount1',
    );
    worksheetField(
      '10.copy2',
      'Line 10 carried to the second printed instance',
      bpaWorksheet.line10,
      ['FederalBpa.10'],
      'form1.Page3.Line30000.Line10.Amount2',
    );
    worksheetField(
      '11',
      'Line 1 plus line 10',
      bpaWorksheet.line11,
      ['FederalBpa.1', 'FederalBpa.10'],
      'form1.Page3.Line30000.Line11.Amount',
    );
  }
  field(
    'T1.30000',
    'Basic personal amount',
    bpaCalculation.amount,
    bpaWorksheet ? ['FederalBpa.11'] : ['T1.23600'],
    'cra-5006-r-2025-fillable',
    'form1.Page5.PartB.Line30000.Line_30000_Amount',
  );
  // T2204 E (25), no Schedule 13 or PPIP. Exact working values only.
  const ei = (
    line: string,
    label: string,
    value: PersonalExact,
    dependencies: string[],
  ) =>
    field(
      `T2204.${line}`,
      label,
      value,
      dependencies,
      'cra-t2204-2025',
      `T2204 line ${line}`,
    );
  ei(
    '1',
    'EI insurable earnings',
    compare(fact('t4.box24'), q('2000')) < 0n &&
      compare(netSelfEmployment, q('0')) === 0n
      ? q('0')
      : fact('t4.box24'),
    ['fact:t4.box24', 'T1.13500', 'T1.13900'],
  );
  ei('2', 'EI special-benefit earnings excluded', q('0'), [
    'fact:scope.noEiSpecialBenefitsAgreement',
  ]);
  ei('3', 'Capped eligible earnings', minimum(at('T2204.1'), q('65700')), [
    'T2204.1',
    'T2204.2',
  ]);
  ei('4', 'EI premiums deducted', fact('t4.box18'), ['fact:t4.box18']);
  ei('5', 'Schedule 13 premiums excluded', q('0'), [
    'fact:scope.noEiSpecialBenefitsAgreement',
  ]);
  ei('6', 'Combined premiums', at('T2204.4'), ['T2204.4', 'T2204.5']);
  ei(
    '7',
    'Earnings above exemption',
    positive(minus(at('T2204.3'), q('2000'))),
    ['T2204.3'],
  );
  ei(
    '8',
    'Low-earnings excess',
    positive(minus(at('T2204.6'), at('T2204.7'))),
    ['T2204.6', 'T2204.7'],
  );
  ei('9', 'Premiums deducted', at('T2204.4'), ['T2204.4']);
  ei(
    '10',
    'Required Ontario premiums',
    minimum(times(at('T2204.1'), q('0.0164')), q('1077.48')),
    ['T2204.1'],
  );
  ei('12', 'Required premiums', at('T2204.10'), ['T2204.10']);
  ei('13', 'Excess deducted', positive(minus(at('T2204.9'), at('T2204.12'))), [
    'T2204.9',
    'T2204.12',
  ]);
  ei(
    '14',
    'Greater excess',
    compare(at('T2204.8'), at('T2204.13')) >= 0n
      ? at('T2204.8')
      : at('T2204.13'),
    ['T2204.8', 'T2204.13'],
  );
  ei(
    '15',
    'EI overpayment before claim threshold',
    minimum(at('T2204.9'), at('T2204.14')),
    ['T2204.9', 'T2204.14'],
  );
  ei(
    '16',
    'EI nonrefundable credit base',
    minimum(at('T2204.7'), minimum(at('T2204.9'), at('T2204.12'))),
    ['T2204.7', 'T2204.9', 'T2204.12'],
  );
  field(
    'T1.31200',
    'Employment EI credit base',
    at('T2204.16'),
    ['T2204.16'],
    'cra-t2204-2025',
    'T2204 line 16',
  );
  field(
    'T1.45000',
    'EI overpayment working transfer',
    compare(at('T2204.15'), q('1')) > 0n ? at('T2204.15') : q('0'),
    ['T2204.15'],
    'cra-t2204-2025',
    'T2204 line 15: claim only when more than $1',
  );
  field(
    'T1.31260',
    'Canada employment amount',
    minimum(at('T1.10100'), q('1471')),
    ['T1.10100'],
  );
  appendCanada2025MedicalCredits(
    at,
    field,
    fact('medical.eligibleSelfExpenses'),
  );
  appendCanada2025FederalCredits(at, field, {
    line34900: donationLine23,
    line22: exactCanada2025DonationAmount(donation.schedule9.line22),
    dependencies: ['Schedule9.22', ...donationInputDependencies],
  });
  appendCanada2025FederalTax(at, field);
  const on = 'cra-5006-c-2025-etext';
  const ontarioBracket = appendCanada2025OntarioBrackets(at, field);
  field(
    'ON428.8',
    'Ontario tax on taxable income transferred to line51',
    ontarioBracket.amount,
    ontarioBracket.dependencies,
    on,
    'ON428 line51 transfer from selected PartA line8',
  );
  field('ON428.58040', 'Ontario basic personal amount', q('12747'), [], on);
  for (const [provincial, federal] of [
    ['58240', '30800'],
    ['58280', '31000'],
    ['58300', '31200'],
  ])
    field(
      `ON428.${provincial}`,
      'CPP or EI credit transfer',
      at(`T1.${federal}`),
      [`T1.${federal}`],
      on,
      `ON428 line ${provincial}; amount from T1 line ${federal}`,
    );
  appendCanada2025OntarioCredits(at, field);
  appendCanada2025OntarioSurtax(at, field);
  appendCanada2025OntarioReduction(at, field);
  appendCanada2025SingleBenefitSchedules('ON428-A', at, field);
  const healthPremium = appendCanada2025OntarioHealthPremium(at, field);
  field(
    'ON428.89',
    'Ontario health premium',
    healthPremium.amount,
    healthPremium.dependencies,
    on,
    'Line89 published chart',
  );
  const finalOntarioTax = appendCanada2025OntarioFinalTax(at, field);
  field(
    'T1.42800',
    'Ontario tax working figure',
    finalOntarioTax,
    ['ON428.90'],
    on,
    'ON428 lines82–90; other items excluded',
  );
  appendCanada2025SingleBenefitSchedules('Schedule6', at, field);
  const noOtherRefunds = ['fact:scope.noOtherRefunds'];
  for (const [line, label, locator] of [
    [
      '44000',
      'Refundable Quebec abatement',
      'form1.Page8.Step6-Continued.Line44000.Line_44000_Amount',
    ],
    [
      '45350',
      'Canada training credit',
      'form1.Page8.Step6-Continued.Line45350.Line_45350_Amount',
    ],
    [
      '45355',
      'Multigenerational home renovation tax credit',
      'form1.Page8.Step6-Continued.Line45355.Line_45355_Amount',
    ],
    [
      '45400',
      'Refund of investment tax credit',
      'form1.Page8.Step6-Continued.Line45400.Line_45400_Amount',
    ],
    [
      '45600',
      'Part XII.2 tax credit',
      'form1.Page8.Step6-Continued.Line45600.Line_45600_Amount',
    ],
    [
      '45700',
      'Employee and partner GST/HST rebate',
      'form1.Page8.Step6-Continued.Line45700.Line_45700_Amount',
    ],
    [
      '47555',
      'Canadian journalism labour tax credit',
      'form1.Page8.Step6-Continued.Line47555.Line_47600_Amount',
    ],
    [
      '47556',
      'Return of fuel charge proceeds to farmers tax credit',
      'form1.Page8.Step6-Continued.Line47556.Line_47556_Amount',
    ],
    [
      '47900',
      'Provincial or territorial credits',
      'form1.Page8.Step6-Continued.Line47900.Line_47900_Amount',
    ],
  ] as const)
    field(
      `T1.${line}`,
      label,
      zero,
      noOtherRefunds,
      'cra-5006-r-2025-fillable',
      locator,
    );
  const educatorEligibility: Canada2025EducatorEligibility = {
    eligibleEducator: factBoolean('educator.eligibleEducator'),
    expensesPaidIn2025: factBoolean('educator.expensesPaidIn2025'),
    expensesUnreimbursed: factBoolean('educator.expensesUnreimbursed'),
    expensesNotClaimedElsewhere: factBoolean(
      'educator.expensesNotClaimedElsewhere',
    ),
  };
  const educator = calculateCanada2025EducatorSchoolSupplyCredit(
    fact('educator.eligibleSuppliesExpenses'),
    educatorEligibility,
  );
  educatorSchoolSupplyCredit = educator;
  if (educator.status === 'blocked') {
    issues.push(
      ...educator.issues.map((issue) => ({
        code: `educator-${issue.code}`,
        path: issue.path,
        message: issue.message,
      })),
    );
    return finish(intake, cpp, carryforward);
  }
  const educatorDependencies = [
    'fact:educator.eligibleSuppliesExpenses',
    'fact:educator.eligibleEducator',
    'fact:educator.expensesPaidIn2025',
    'fact:educator.expensesUnreimbursed',
    'fact:educator.expensesNotClaimedElsewhere',
    'fact:scope.noOtherCredits',
  ];
  field(
    'T1.46800',
    'Eligible educator school supply expenses capped at $1,000',
    q(educator.cappedExpenses.exactDecimal!),
    educatorDependencies,
    'cra-5006-r-2025-fillable',
    'form1.Page8.Step6-Continued.Line46900.Line46800.Line_46800_Amount',
  );
  field(
    'T1.46900',
    'Eligible educator school supply tax credit',
    q(educator.credit.exactDecimal!),
    ['T1.46800', ...educatorDependencies],
    'cra-5006-r-2025-fillable',
    'form1.Page8.Step6-Continued.Line46900.Line_46900_Amount',
  );
  field('T1.43700', 'Income tax deducted', fact('t4.box22'), ['fact:t4.box22']);
  field('T1.47600', 'Tax instalments', fact('instalments'), [
    'fact:instalments',
  ]);
  appendCanada2025MedicalSupplement(at, field, {
    fullYearCanadianResident:
      intake.domesticResident === true &&
      intake.hasCrossBorderActivity === false,
    ageAtLeast18: text('dateOfBirth') <= '2007-12-31',
  });
  appendCanada2025PersonalReconciliation(at, field);
  return finish(intake, cpp, carryforward);
}
export type CanadaOntario2025PersonalRun = ReturnType<
  typeof runCanadaOntario2025PersonalWorkflow
>;
type Canada2025PersonalSerializedAmount = ReturnType<typeof serialize>;
type Canada2025PersonalFactSource = FinanceTaxIntake['facts'][number]['source'];
export type Canada2025PersonalCarryforwardSectionId =
  'charitable-donations' | 'general-noncapital-loss';
export type Canada2025PersonalCarryforwardExportProvenance = {
  schemaVersion: 1;
  packageVersion: string;
  runHash: string;
  inputHash: string;
  caseId: string | null;
  taxSubjectId: string | null;
  revision: number | null;
  targetYear: number | null;
};
export type Canada2025PersonalCarryforwardExportRow = {
  sectionId: Canada2025PersonalCarryforwardSectionId;
  sectionLabel: string;
  year: number;
  factKey: string;
  label: string;
  opening: Canada2025PersonalSerializedAmount;
  used: Canada2025PersonalSerializedAmount;
  expired: Canada2025PersonalSerializedAmount;
  closing: Canada2025PersonalSerializedAmount;
  calculationEligible: boolean;
  sourceBinding: Canada2025PersonalFactSource | null;
};
export type Canada2025PersonalCarryforwardExportSection = {
  sectionId: Canada2025PersonalCarryforwardSectionId;
  label: string;
  version: string;
  targetLine: string;
  sourceId: string;
  sourceHash: string;
  orderingSourceId?: string;
  orderingSourceHash?: string;
  provenance: Canada2025PersonalCarryforwardExportProvenance;
  rows: readonly Canada2025PersonalCarryforwardExportRow[];
};
const serializedZero = serialize(rational(0n));

/**
 * Projects the already-calculated carryforward ledgers for authorized export.
 * This is deliberately a projection: it does not recalculate or normalize any
 * opening, used or closing amount. The supported years are all within their
 * current carryforward windows, so the explicit expired amount is exact zero;
 * an invalid or incomplete ledger cannot reach export because the run is
 * blocked first.
 */
export function projectCanada2025PersonalCarryforwardSections(
  run: CanadaOntario2025PersonalRun,
): readonly Canada2025PersonalCarryforwardExportSection[] {
  const inputSnapshot = run.inputSnapshot;
  const provenance: Canada2025PersonalCarryforwardExportProvenance = {
    schemaVersion: 1,
    packageVersion: run.packageVersion,
    runHash: run.runHash,
    inputHash: run.inputHash,
    caseId: inputSnapshot?.caseId ?? null,
    taxSubjectId: inputSnapshot?.taxSubjectId ?? null,
    revision: inputSnapshot?.revision ?? null,
    targetYear: inputSnapshot?.scope.year ?? null,
  };
  const sourceBinding = (factKey: string) =>
    inputSnapshot?.facts.find((fact) => fact.key === factKey)?.source ?? null;
  const sections: Canada2025PersonalCarryforwardExportSection[] = [];
  const donation = (
    run as CanadaOntario2025PersonalRun & {
      charitableDonations?: CanadaOntario2025PersonalRun['charitableDonations'];
    }
  ).charitableDonations;
  if (donation) {
    const sectionId = 'charitable-donations' as const;
    const sectionLabel = 'Federal ordinary charitable donations (Schedule 9)';
    const rows: Canada2025PersonalCarryforwardExportRow[] =
      donation.carryforwardLedger.map((entry) => ({
        sectionId,
        sectionLabel,
        year: entry.year,
        factKey: entry.factKey,
        label: `Unused ordinary donation balance from ${entry.year}`,
        opening: entry.openingBalance,
        used: entry.claimedIn2025,
        expired: serializedZero,
        closing: entry.closingBalance,
        calculationEligible: entry.calculationEligible,
        sourceBinding: entry.sourceBinding,
      }));
    rows.push({
      sectionId,
      sectionLabel,
      year: inputSnapshot?.scope.year ?? 2025,
      factKey: 'donations.currentEligibleGifts',
      label: 'Current-year eligible ordinary donation balance',
      opening: donation.currentEligibleGifts,
      used: donation.claimedFromCurrentYear,
      expired: serializedZero,
      closing: donation.currentYearClosingBalance,
      calculationEligible: true,
      sourceBinding: sourceBinding('donations.currentEligibleGifts'),
    });
    sections.push({
      sectionId,
      label: sectionLabel,
      version: donation.version,
      targetLine: donation.line,
      sourceId: donation.sourceId,
      sourceHash: donation.sourceHash,
      orderingSourceId: CANADA_PERSONAL_DONATIONS_SOURCE.carryforwardSource.id,
      orderingSourceHash:
        CANADA_PERSONAL_DONATIONS_SOURCE.carryforwardSource.documentHash,
      provenance,
      rows,
    });
  }
  const loss = run.carryforward;
  if (loss) {
    const sectionId = 'general-noncapital-loss' as const;
    const sectionLabel =
      'General non-capital loss carryforward (T1 line 25200)';
    sections.push({
      sectionId,
      label: sectionLabel,
      version: loss.version,
      targetLine: loss.line,
      sourceId: loss.sourceId,
      sourceHash: loss.sourceHash,
      orderingSourceId: loss.orderingSourceId,
      orderingSourceHash: loss.orderingSourceHash,
      provenance,
      rows: loss.ledger.map((entry) => ({
        sectionId,
        sectionLabel,
        year: entry.lossYear,
        factKey: entry.factKey,
        label: `General non-capital loss balance from ${entry.lossYear}`,
        opening: entry.openingBalance,
        used: entry.claimedIn2025,
        expired: serializedZero,
        closing: entry.closingBalance,
        calculationEligible: entry.calculationEligible,
        sourceBinding: entry.sourceBinding,
      })),
    });
  }
  return deepFreeze(sections);
}
/** Reviewer identity/authority is supplied by trusted persistence, not conferred by this function. */
export function reviewCanadaOntario2025PersonalExport(
  run: CanadaOntario2025PersonalRun,
  raw: unknown,
) {
  const review = z
    .strictObject({
      reviewerId: z.uuid(),
      reviewedAt: z.iso.datetime(),
      runHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(raw);
  const { runHash, ...body } = run;
  if (review.runHash !== runHash || digest(body) !== runHash)
    throw Error('personal-review-run-hash-mismatch');
  if (run.status === 'blocked')
    throw Error('personal-review-has-blocking-inputs');
  return deepFreeze({
    schemaVersion: 1,
    status: 'reviewed-working-schedules-not-fileable',
    complete: false,
    reportable: false,
    review,
    run,
    exportHash: digest({ review, run }),
  });
}
export function exportCanadaOntario2025PersonalSchedules(
  run: CanadaOntario2025PersonalRun,
) {
  const { runHash, ...body } = run;
  if (digest(body) !== runHash)
    throw Error('personal-export-run-hash-mismatch');
  if (run.status === 'blocked')
    throw Error('personal-export-has-blocking-inputs');
  const quote = (s: string) => {
    const safe = /^[\s]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s) ? `'${s}` : s;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const carryforwardSections =
    projectCanada2025PersonalCarryforwardSections(run);
  const carryforwardContent = carryforwardSections.length
    ? [
        'Carryforward section type,Section ID,Section label,Rule version,Target line,Source ID,Source hash,Ordering source ID,Ordering source hash,Package version,Run hash,Input hash,Revision,Case ID,Tax subject ID,Target year',
        'Carryforward row type,Section ID,Section label,Year,Fact key,Row label,Opening exact numerator,Opening exact denominator,Opening exact decimal,Used exact numerator,Used exact denominator,Used exact decimal,Expired exact numerator,Expired exact denominator,Expired exact decimal,Closing exact numerator,Closing exact denominator,Closing exact decimal,Calculation eligible,Source binding',
        ...carryforwardSections.flatMap((section) => [
          [
            'Carryforward section',
            section.sectionId,
            section.label,
            section.version,
            section.targetLine,
            section.sourceId,
            section.sourceHash,
            section.orderingSourceId ?? '',
            section.orderingSourceHash ?? '',
            section.provenance.packageVersion,
            section.provenance.runHash,
            section.provenance.inputHash,
            section.provenance.revision,
            section.provenance.caseId,
            section.provenance.taxSubjectId,
            section.provenance.targetYear,
          ]
            .map((value) => quote(value === null ? '' : String(value)))
            .join(','),
          ...section.rows.map((row) =>
            [
              'Carryforward row',
              row.sectionId,
              row.sectionLabel,
              row.year,
              row.factKey,
              row.label,
              row.opening.exactRational.numerator,
              row.opening.exactRational.denominator,
              row.opening.exactDecimal ?? 'recurring rational',
              row.used.exactRational.numerator,
              row.used.exactRational.denominator,
              row.used.exactDecimal ?? 'recurring rational',
              row.expired.exactRational.numerator,
              row.expired.exactRational.denominator,
              row.expired.exactDecimal ?? 'recurring rational',
              row.closing.exactRational.numerator,
              row.closing.exactRational.denominator,
              row.closing.exactDecimal ?? 'recurring rational',
              row.calculationEligible,
              canonical(row.sourceBinding),
            ]
              .map((value) => quote(String(value)))
              .join(','),
          ),
        ]),
      ]
    : [];
  return {
    filename: `ca-on-2025-${run.inputSnapshot?.caseId ?? 'invalid'}-review.csv`,
    mimeType: 'text/csv',
    content: [
      'Review working figures only; NOT A FILEABLE RETURN; annual rounding and coverage proof incomplete',
      `Package version,${quote(run.packageVersion)}`,
      `Run hash,${quote(run.runHash)}`,
      `Input hash,${quote(run.inputHash)}`,
      ...run.sources.map((source) =>
        [
          'Source',
          source.id,
          source.formVersion,
          source.documentHash,
          source.url,
        ]
          .map(quote)
          .join(','),
      ),
      'Form,Line,Label,Exact numerator,Exact denominator,Exact decimal,Reportable amount,Dependencies,Source,Locator,Paper field status,Paper field source,Paper field path',
      ...run.fields.map((f) =>
        [
          f.form,
          f.line,
          f.label,
          f.exactRational.numerator,
          f.exactRational.denominator,
          f.exactDecimal ?? 'recurring rational',
          f.reportableAmount ?? 'UNAVAILABLE',
          f.dependencies.join(';'),
          f.sourceId,
          f.locator,
          f.reporting.status,
          f.reporting.sourceId ?? '',
          f.reporting.fieldPath ?? '',
        ]
          .map(quote)
          .join(','),
      ),
      ...carryforwardContent,
    ].join('\n'),
    runHash,
    carryforwardSections,
  };
}

export function exportReviewedCanadaOntario2025PersonalSchedules(
  review: ReturnType<typeof reviewCanadaOntario2025PersonalExport>,
) {
  const { exportHash, ...body } = review;
  if (
    digest({ review: review.review, run: review.run }) !== exportHash ||
    body.status !== 'reviewed-working-schedules-not-fileable'
  )
    throw Error('personal-reviewed-export-hash-mismatch');
  const exported = exportCanadaOntario2025PersonalSchedules(review.run);
  return {
    ...exported,
    content:
      `Reviewer,${review.review.reviewerId}\nReviewed at,${review.review.reviewedAt}\nReview export hash,${exportHash}\n` +
      exported.content,
    reviewHash: exportHash,
  };
}

export {
  auditCanadaOntario2025PersonalFormApplicability,
  CanadaPersonalFormInputEnvelopeSchema,
  PERSONAL_FORM_APPLICABILITY_VERSION,
  PERSONAL_REQUIRED_FORM_FACTS,
  PERSONAL_REQUIRED_BUSINESS_FORM_FACTS,
} from './personal-form-applicability.js';

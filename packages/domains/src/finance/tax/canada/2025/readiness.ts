import { deepFreeze } from '@emdo/contracts';
import {
  CANADA_PERSONAL_NONCAPITAL_LOSS_ORDER_SOURCE,
  CANADA_PERSONAL_NONCAPITAL_LOSS_SOURCE,
} from './personal-carryforward.js';
import { CANADA_PERSONAL_DONATIONS_SOURCE } from './personal-donations.js';

/** Immutable captures of CRA's own E-text files; SHA-256 covers the original downloaded bytes. */
export const CANADA_ON_2025_SOURCES = deepFreeze([
  {
    id: 'cra-5006-r-2025-etext',
    authority: 'Canada Revenue Agency',
    title: '2025 Income Tax and Benefit Return for Ontario',
    formVersion: '5006-R E (25)',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5006-r/5006-r-25e.txt',
    pdfUrl:
      'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5006-r/5006-r-25e.pdf',
    retrievedAt: '2026-09-13T23:54:00.557053Z',
    documentHash:
      '1506da18ccf68c528d23b9e43b1d129a922de28784a821976e5c1c32ce63ea71',
    localFile: '5006-r-25e.txt',
    locator: 'Page 5 of 8, Step 5 Part A, lines 70-76',
  },
  {
    id: 'cra-5006-c-2025-etext',
    authority: 'Canada Revenue Agency',
    title: '2025 Form ON428 Ontario Tax',
    formVersion: '5006-C E (25)',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5006-c/5006-c-25e.txt',
    pdfUrl:
      'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5006-c/5006-c-25e.pdf',
    retrievedAt: '2026-09-13T23:54:03.658936Z',
    documentHash:
      'fde08130c7bba00e02b0c6dd8bbd5cfc73deae942be7b9b9206cf247943845ab',
    localFile: '5006-c-25e.txt',
    locator: 'Pages 1, 3 and 4; lines 1-8, 63-68 and line 89 chart',
  },
  {
    id: 'cra-5000-d1-2025-etext',
    authority: 'Canada Revenue Agency',
    title: '2025 Federal Worksheet',
    formVersion: '5000-D1 (25)',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5000-d1/5000-d1-25e.txt',
    pdfUrl:
      'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5000-d1/5000-d1-25e.pdf',
    retrievedAt: '2026-09-13T23:54:04.751079Z',
    documentHash:
      '4842910eae22963bcf81cbf5588dbc154277429ce8b9c6f64f0a6f79b1457ad4',
    localFile: '5000-d1-25e.txt',
    locator:
      'Federal worksheet line30000 basic personal amount and line34990 top-up credit',
  },
  {
    id: 'cra-5006-pc-2025-html',
    authority: 'Canada Revenue Agency',
    title: 'Ontario tax information for 2025',
    formVersion: '2025 Ontario tax information',
    url: 'https://www.canada.ca/en/revenue-agency/services/forms-publications/tax-packages-years/general-income-tax-benefit-package/ontario/5006-pc.html',
    retrievedAt: '2026-09-14T00:16:59.104296Z',
    documentHash:
      '9674e44418ce85370d19b2df3b0e35997fdaf416ecb8ac7652bebbcbffafd999',
    localFile: '5006-pc-2025.html.txt',
    locator: 'Ontario tax reduction; line75 and line76 dependent reductions',
  },
  CANADA_PERSONAL_NONCAPITAL_LOSS_SOURCE,
  CANADA_PERSONAL_NONCAPITAL_LOSS_ORDER_SOURCE,
] as const);

/** This is a development readiness artifact, not a FinanceTaxPackageManifest or registry registration. */
export const CANADA_ON_2025_READINESS = deepFreeze({
  artifactId: 'ca-on-individual-2025-readiness',
  version: '2025.1-components.3',
  reviewedSourceDate: '2026-09-13',
  status: 'unavailable',
  fullReturnValidated: false,
  registryEligible: false,
  scope: {
    country: 'CA',
    subdivision: 'CA-ON',
    taxpayerType: 'individual',
    year: 2025,
    regime: 'income-tax-return',
    formVersion: '5006-R-E-25_5006-C-E-25',
  },
  publicationEvidence: {
    selectedYear: 2025,
    basis:
      'CRA currently links the 2025 T1 and ON428 annual forms; published 2026 rate tables alone do not establish a complete 2026 annual return package.',
    packageUrl:
      'https://www.canada.ca/en/revenue-agency/services/forms-publications/tax-packages-years/general-income-tax-benefit-package/ontario.html',
    returnPageUrl:
      'https://www.canada.ca/en/revenue-agency/services/forms-publications/forms/5006-r.html',
    ontarioPageUrl:
      'https://www.canada.ca/en/revenue-agency/services/forms-publications/forms/5006-c.html',
    formPageUpdatedAt: '2026-09-04',
  },
  roundingReview: {
    status: 'annual-return-authority-not-established',
    checkedAt: '2026-09-14',
    checkedAnnualSourceIds: [
      'cra-5006-r-2025-etext',
      'cra-5006-c-2025-etext',
      'cra-5000-d1-2025-etext',
    ],
    finding:
      'The captured annual forms prescribe line formulas and printed constants but do not establish a general intermediate and final rounding convention. Federal BPA phaseout may produce recurring decimals; exact rational values are retained.',
    electronicFieldPrecisionReview: {
      url: 'https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/rc4018/chapter-1.html',
      locator: 'Appendix G1 - Line numbers used on EFILE records',
      finding:
        'CRA distinguishes numeric, whole-dollar and dollar-and-cent electronic fields. This establishes field-specific transmission precision, not a general intermediate calculation or rounding algorithm. EFILE is outside this release scope; no calculation rounding rule is activated from this table.',
    },
    excludedBorrowedGuidance: {
      url: 'https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/payroll-deductions-t4127-payroll-deductions-formulas/t4127-jan-120th-edition-effective-january-1-2025/t4127-jan-payroll-deductions-formulas-computer-programs.html',
      reason:
        'CRA T4127 explicitly supplies payroll BPA/pay-period rounding procedures. This is not established as annual T1 return rounding authority and is not activated here.',
    },
  },
  implementedComponents: [
    {
      id: 'ca-2025-basic-personal-amount',
      sourceId: 'cra-5000-d1-2025-etext',
      locator: 'Worksheet line30000 lines1-11',
      status: 'exact-rational-arithmetic-only',
    },
    {
      id: 'ca-2025-nonrefundable-credits',
      sourceId: 'cra-5006-r-2025-etext',
      locator: 'T1 lines33500/33800/35000; supplied eligible other amounts',
      status: 'exact-rational-arithmetic-only',
    },
    {
      id: 'ca-2025-top-up-credit',
      sourceId: 'cra-5000-d1-2025-etext',
      locator: 'Worksheet line34990 lines1-7; supplied Schedule9 line22',
      status: 'exact-rational-arithmetic-only',
    },
    {
      id: 'ca-2025-educator-school-supply-credit',
      sourceId: 'cra-5006-r-2025-fillable',
      locator:
        'T1 lines46800/46900; reviewed eligibility, 2025 payment, reimbursement and duplicate-claim gates; min($1,000) then 25%',
      status: 'exact-rational-arithmetic-only-with-explicit-gates',
    },
    {
      id: 'ca-2025-ordinary-charitable-donations',
      sourceId: 'cra-5000-s9-2025-etext',
      locator:
        'Schedule 9 lines1-23; five-year ordinary carryforward, 75% limit, $200/29%/33% tiers and T1 line34900 transfer',
      status: 'exact-rational-arithmetic-only-with-explicit-gates',
    },
    {
      id: 'ca-on-2025-basic-personal-and-credits',
      sourceId: 'cra-5006-c-2025-etext',
      locator:
        'ON428 lines58040/58800/58840/61500; supplied eligible other amounts',
      status: 'exact-rational-arithmetic-only',
    },
    {
      id: 'ca-on-2025-tax-reduction',
      sourceId: 'cra-5006-c-2025-etext',
      locator:
        'ON428 lines74-81; reviewed dependency and exclusive-claim inputs',
      status: 'exact-rational-arithmetic-only',
    },
    {
      id: 'ca-2025-t1-tax-on-taxable-income',
      sourceId: 'cra-5006-r-2025-etext',
      locator: 'T1 Step 5 Part A, lines 70-76',
      status: 'exact-arithmetic-only',
    },
    {
      id: 'ca-on-2025-tax-on-taxable-income',
      sourceId: 'cra-5006-c-2025-etext',
      locator: 'ON428 Part A, lines 1-8',
      status: 'exact-arithmetic-only',
    },
    {
      id: 'ca-on-2025-surtax',
      sourceId: 'cra-5006-c-2025-etext',
      locator: 'ON428 Part C, lines 63-68',
      status: 'exact-arithmetic-only',
    },
    {
      id: 'ca-on-2025-health-premium',
      sourceId: 'cra-5006-c-2025-etext',
      locator: 'ON428 line 89 chart',
      status: 'exact-arithmetic-only',
    },
  ],
  releaseBlockers: [
    {
      id: 'taxpayer-applicability',
      requirement:
        'Validate taxpayer identification, full-year residency, marital/dependant elections, deceased/bankrupt/special-return cases and all relevant income classifications.',
    },
    {
      id: 'income-and-deductions',
      requirement:
        'Implement T1 Steps 2-4, including source-slip mapping, RRSP/FHSA, investment/rental income, capital gains, losses, deductions and carryforwards; line 26000 is currently a supplied fact.',
    },
    {
      id: 'federal-credits',
      requirement:
        'Basic personal amount phaseout, line33800/35000, ordinary Schedule 9 donations and worksheet top-up arithmetic are implemented. Still implement all remaining eligibility and source schedules for other Part B amounts, including medical, tuition and dependant rules; special donation categories remain outside the ordinary branch.',
    },
    {
      id: 'federal-net-tax',
      requirement:
        'Implement T1 Part C including dividend credits, TOSI, AMT/carryovers, other applicable credits, special taxes and ACWB.',
    },
    {
      id: 'ontario-net-tax',
      requirement:
        'Basic personal amount, credit-total and tax-reduction arithmetic are implemented with explicit supplied eligible facts. Still implement all other ON428 eligibility, dividend credits, minimum tax, LIFT and final line42800. Surtax requires supplied line62 and line54.',
    },
    {
      id: 'contributions-and-repayments',
      requirement:
        'Implement Schedule 8/RC381, applicable Schedule 13, social benefit repayments and refund/balance owing reconciliation.',
    },
    {
      id: 'provincial-benefits',
      requirement:
        'Determine and implement applicability and required outputs for ON479, ON-BEN, ON428-A, ON479-A, ON(S2), and ON(S11).',
    },
    {
      id: 'complete-forms',
      requirement:
        'Produce a complete applicable T1/ON428 and all required schedule/worksheet field inventory with evidence-backed facts and explicit no-claim decisions.',
    },
    {
      id: 'rounding-policy',
      requirement:
        'Verify authoritative annual-return line and final-amount rounding rules. Component outputs retain exact decimal arithmetic; no reportable monetary amount or rounded liability is asserted.',
    },
    {
      id: 'independent-statutory-review',
      requirement:
        'Review legislation, effective dates, source changes and full applicability with qualified independent tax review; source capture plus arithmetic tests is not statutory certification.',
    },
    {
      id: 'full-return-fixtures',
      requirement:
        'Pass independently reviewed complete-return fixtures, boundary/election/carryforward scenarios and package registration validation before enabling this scope.',
    },
    {
      id: 'historical-evidence',
      requirement:
        'Bind authorized reviewed return facts, source snapshots, carryforward history and tax-subject permissions to immutable persisted runs.',
    },
  ],
  outsideThisComponentScope: [
    'Other tax years or provinces',
    'Partial-year or non-resident returns',
    'Permanent establishments outside Ontario (CRA directs applicable cases to T2203)',
    'Sole-proprietor complete returns and T2125/T4002 calculations',
    'Corporate returns',
    'Complex cross-border cases',
    'Payroll',
    'Electronic filing',
  ],
  sources: [
    ...CANADA_ON_2025_SOURCES,
    CANADA_PERSONAL_DONATIONS_SOURCE,
    CANADA_PERSONAL_DONATIONS_SOURCE.carryforwardSource,
  ],
} as const);

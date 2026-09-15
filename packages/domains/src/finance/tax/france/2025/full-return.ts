import {
  deepFreeze,
  FinanceTaxEvaluationSchema,
  FinanceTaxIntakeSchema,
  type FinanceTaxEvaluation,
  type FinanceTaxIntake,
  type FinanceTaxValue,
} from '@emdo/contracts';
import { createHash } from 'node:crypto';
import {
  compare,
  decimal,
  minus,
  plus,
  q,
  report,
  rounded,
  serialize,
  times,
  type Exact,
} from './exact.js';
import {
  FRANCE_2025_LIMITS,
  france2025DecoteSingle,
  france2025ProgressiveTax,
  france2025RoundedProgressiveTax,
} from './tables.js';
import {
  FRANCE_2025_PROVENANCE,
  FRANCE_2025_SOURCE_REVIEWS,
  FRANCE_2025_SOURCES,
} from './sources.js';
import {
  FRANCE_2025_CANDIDATE,
  FRANCE_2025_REQUIRED_FACTS,
  FRANCE_2025_SCOPE,
  runFrance2025PersonalWorkflow,
  type France2025Calculation,
  type FranceFactRequirement,
} from './workflow.js';

/**
 * This is a selected-return adapter. It enumerates the fields needed to
 * produce a reviewed paper-data snapshot for three deliberately narrow
 * French cases. It is not a registry manifest and never changes package
 * availability.
 */
export const FRANCE_2025_SELECTED_RETURN_VERSION =
  '2025.2-selected-return-fields.1';
export const FRANCE_2025_REPORTING_POLICY_VERSION =
  'france-2025-selected-return-whole-euro-v1';

export type France2025ReturnKind = 'salary' | 'sole-proprietor' | 'corporation';

export const FRANCE_2025_SELECTED_SCOPES = deepFreeze({
  salary: FRANCE_2025_SCOPE,
  'sole-proprietor': {
    country: 'FR' as const,
    subdivision: 'FR-METRO',
    taxpayerType: 'sole-proprietor' as const,
    year: 2025,
    regime: 'income-tax-return',
    formVersion: '2042-2026_2042-C-PRO-2026',
  },
  corporation: {
    country: 'FR' as const,
    subdivision: 'FR-METRO',
    taxpayerType: 'corporation' as const,
    year: 2025,
    regime: 'income-tax-return',
    formVersion: '2065-SD-2026_2050-2059-G-2026',
  },
} as const);

export const FRANCE_2025_SELECTED_RETURN_GAPS = deepFreeze([
  'identity-private-intake-and-bank-details-remain-a-platform-seam',
  'manual-taxpayer-signature-and-electronic-filing-remain-unperformed',
  'complete-all-2042-and-annex-field-inventory-remains-open',
  'sole-proprietor-support-is-limited-to-one-metropolitan-micro-service-activity',
  'sole-proprietor-social-contributions-vat-and-versement-liberatoire-are-excluded',
  'corporate-support-is-limited-to-one-metropolitan-standalone-real-normal-is-return',
  'corporate-2050-to-2059-underlying-accounting-field-inventory-remains-user-required',
  'corporate-special-rates-credits-groups-deficits-and-large-enterprise-contributions-are-excluded',
  'independent-complete-return-review-and-production-acceptance-remain-open',
] as const);

type FactType = 'decimal' | 'text' | 'boolean' | 'date';
export type France2025SelectedFactRequirement = FranceFactRequirement & {
  formIds: readonly string[];
  sensitive?: boolean;
};

const identityFacts = [
  {
    key: 'identity.nameAtBirth',
    type: 'text',
    label: 'Birth surname',
    locator: '2042 p. 1, état civil — Nom de naissance',
    formIds: ['2042'],
    sensitive: true,
  },
  {
    key: 'identity.givenNames',
    type: 'text',
    label: 'Given names',
    locator: '2042 p. 1, état civil — Prénoms',
    formIds: ['2042'],
    sensitive: true,
  },
  {
    key: 'identity.birthDate',
    type: 'date',
    label: 'Date of birth',
    locator: '2042 p. 1, état civil — Date de naissance',
    formIds: ['2042'],
    sensitive: true,
  },
  {
    key: 'identity.birthPlace',
    type: 'text',
    label: 'Place of birth',
    locator: '2042 p. 1, état civil — Lieu de naissance',
    formIds: ['2042'],
    sensitive: true,
  },
  {
    key: 'identity.addressAtJan2026',
    type: 'text',
    label: 'Address at 1 January 2026',
    locator: '2042 p. 1, adresse au 1er janvier 2026',
    formIds: ['2042'],
    sensitive: true,
  },
  {
    key: 'identity.postalCode',
    type: 'text',
    label: 'Postal code',
    locator: '2042 p. 1, adresse au 1er janvier 2026 — code postal',
    formIds: ['2042'],
    sensitive: true,
  },
  {
    key: 'identity.city',
    type: 'text',
    label: 'City',
    locator: '2042 p. 1, adresse au 1er janvier 2026 — commune',
    formIds: ['2042'],
    sensitive: true,
  },
  {
    key: 'identity.taxNumber',
    type: 'text',
    label: 'French tax number',
    locator: '2042 p. 1, numéro fiscal',
    formIds: ['2042'],
    sensitive: true,
  },
  {
    key: 'identity.phone',
    type: 'text',
    label: 'Telephone',
    locator: '2042 p. 1, Votre téléphone',
    formIds: ['2042'],
    sensitive: true,
  },
  {
    key: 'identity.email',
    type: 'text',
    label: 'Email',
    locator: '2042 p. 1, Votre mél',
    formIds: ['2042'],
    sensitive: true,
  },
  {
    key: 'identity.firstDeclaration',
    type: 'boolean',
    label: 'First income-tax declaration',
    locator: '2042 p. 1, première déclaration checkbox',
    formIds: ['2042'],
  },
  {
    key: 'identity.addressChanged2025',
    type: 'boolean',
    label: 'Address changed during 2025',
    locator: '2042 p. 1, changements d’adresse 2025',
    formIds: ['2042'],
  },
  {
    key: 'identity.addressChanged2026',
    type: 'boolean',
    label: 'Address changed during 2026',
    locator: '2042 p. 1, changements d’adresse 2026',
    formIds: ['2042'],
  },
  {
    key: 'identity.bankDetailsProvided',
    type: 'boolean',
    label: 'Bank-details seam available',
    locator: '2042 p. 2, coordonnées bancaires / mandat de prélèvement',
    formIds: ['2042'],
    sensitive: true,
  },
  {
    key: 'identity.signatureStatus',
    type: 'text',
    expected: 'manual-unperformed',
    label: 'Taxpayer signature status',
    locator: '2042 p. 1, signature du ou des déclarants',
    formIds: ['2042'],
  },
] as const satisfies readonly France2025SelectedFactRequirement[];

const individualCommonFacts = [
  ...FRANCE_2025_REQUIRED_FACTS.filter((fact) =>
    [
      'residency.region',
      'filing.incomeYear',
      'filing.declarationYear',
      'income.otherTaxableIncome',
      'income.otherDeductions',
      'income.otherCredits',
      'income.foreignTaxCredit',
      'income.exceptionalOrDeferred',
      'income.advanceOrInstalments',
      'pas.calendarYear',
      'pas.withheld',
      'family.status',
      'family.dependentChildren',
      'family.raisingFirstChildAlone',
      'family.livesAlone',
      'family.alternatingResidence',
      'family.otherDependants',
      'family.specialHalfParts',
      'family.invalidityOrVeteran',
      'family.formerSingleParent',
    ].includes(fact.key),
  ).map((fact) => ({ ...fact, formIds: ['2042'] as const })),
  {
    key: 'income.pensions',
    type: 'decimal' as const,
    expected: '0',
    label: 'Pensions, retirement and annuities excluded from selected case',
    locator: '2042 p. 3, pensions/retraites/rentes lines 1AS–1DR',
    formIds: ['2042'] as const,
  },
  {
    key: 'income.capital',
    type: 'decimal' as const,
    expected: '0',
    label: 'Capital income excluded from selected case',
    locator: '2042 p. 3, revenus de capitaux mobiliers lines 2AA–2EE',
    formIds: ['2042'] as const,
  },
  {
    key: 'income.rental',
    type: 'decimal' as const,
    expected: '0',
    label: 'Rental income excluded from selected case',
    locator: '2042 p. 4, revenus fonciers lines 4BA–4BZ',
    formIds: ['2042'] as const,
  },
  {
    key: 'income.capitalGains',
    type: 'decimal' as const,
    expected: '0',
    label: 'Capital gains excluded from selected case',
    locator: '2042-C and annexes; selected case has no capital gains',
    formIds: ['2042'] as const,
  },
  {
    key: 'income.socialContributions',
    type: 'decimal' as const,
    expected: '0',
    label: 'Social contributions outside selected income-tax chain',
    locator: '2042 p. 4 and 2042-C-PRO social-contribution sections',
    formIds: ['2042'] as const,
  },
] as const satisfies readonly France2025SelectedFactRequirement[];

const salaryFacts = [
  ...FRANCE_2025_REQUIRED_FACTS.filter((fact) =>
    [
      'employment.incomeType',
      'employment.employerCount',
      'employment.grossSalary',
      'deduction.method',
      'deduction.actualExpenses',
    ].includes(fact.key),
  ).map((fact) => ({ ...fact, formIds: ['2042'] as const })),
] as const satisfies readonly France2025SelectedFactRequirement[];

const soleProprietorFacts = [
  {
    key: 'employment.incomeType',
    type: 'text' as const,
    expected: 'no-ordinary-salary',
    label: 'No ordinary employment salary in sole-proprietor-only branch',
    locator: 'Selected branch guard; 2042 salary lines 1AJ–1DJ',
    formIds: ['2042'] as const,
  },
  {
    key: 'employment.employerCount',
    type: 'decimal' as const,
    expected: '0',
    label: 'Ordinary employment source count',
    locator: 'Selected sole-proprietor-only branch',
    formIds: ['2042'] as const,
  },
  {
    key: 'employment.grossSalary',
    type: 'decimal' as const,
    expected: '0',
    label: 'Salary amount in sole-proprietor-only branch',
    locator: '2042 line 1AJ; explicit zero guard',
    formIds: ['2042'] as const,
  },
  {
    key: 'deduction.method',
    type: 'text' as const,
    expected: 'not-applicable',
    label: 'Salary expense deduction method',
    locator: 'Selected sole-proprietor-only branch',
    formIds: ['2042'] as const,
  },
  {
    key: 'deduction.actualExpenses',
    type: 'decimal' as const,
    expected: '0',
    label: 'Salary actual expenses',
    locator: '2042 lines 1AK–1DK; explicit zero guard',
    formIds: ['2042'] as const,
  },
  {
    key: 'business.incomeCategory',
    type: 'text' as const,
    label: 'Micro-business income category',
    locator: '2042-C-PRO p. 1, nature des revenus; BIC services or BNC',
    formIds: ['2042-C-PRO'] as const,
  },
  {
    key: 'business.accountingRegime',
    type: 'text' as const,
    expected: 'micro',
    label: 'Micro-business tax regime',
    locator: '2042-C-PRO professional-income sections; micro-BIC/micro-BNC',
    formIds: ['2042-C-PRO'] as const,
  },
  {
    key: 'business.grossReceipts',
    type: 'decimal' as const,
    label: 'Gross business receipts or service sales',
    locator: '2042-C-PRO lines 5KP (micro-BIC services) or 5HV (micro-BNC)',
    formIds: ['2042-C-PRO'] as const,
  },
  {
    key: 'business.priorYearThresholdEligible',
    type: 'boolean' as const,
    expected: true,
    label: 'Prior-year micro-regime threshold reviewed',
    locator: 'DGFiP professions indépendantes: 2025 micro thresholds',
    formIds: ['2042-C-PRO'] as const,
  },
  {
    key: 'business.activitiesCount',
    type: 'decimal' as const,
    expected: '1',
    label: 'Number of business activities',
    locator: 'Selected one-activity branch',
    formIds: ['2042-C-PRO'] as const,
  },
  {
    key: 'business.fiscalMonths',
    type: 'decimal' as const,
    expected: '12',
    label: 'Months operated during 2025',
    locator: '2042-C-PRO professional-income duration fields 5DB/5XI context',
    formIds: ['2042-C-PRO'] as const,
  },
  {
    key: 'business.cessationDuringYear',
    type: 'boolean' as const,
    expected: false,
    label: 'No cessation during 2025',
    locator: '2042-C-PRO cessation fields 5BF/5AO',
    formIds: ['2042-C-PRO'] as const,
  },
  {
    key: 'business.foreignActivity',
    type: 'boolean' as const,
    expected: false,
    label: 'No foreign business activity',
    locator: '2042-C-PRO foreign-income lines; selected domestic branch',
    formIds: ['2042-C-PRO'] as const,
  },
  {
    key: 'business.versementLiberatoire',
    type: 'boolean' as const,
    expected: false,
    label: 'No versement libératoire election',
    locator: '2042-C-PRO micro-entrepreneur versement libératoire sections',
    formIds: ['2042-C-PRO'] as const,
  },
  {
    key: 'business.realRegime',
    type: 'boolean' as const,
    expected: false,
    label: 'No real accounting regime',
    locator: '2042-C-PRO regime du bénéfice réel sections',
    formIds: ['2042-C-PRO'] as const,
  },
  {
    key: 'business.lossesCarryforward',
    type: 'boolean' as const,
    expected: false,
    label: 'No losses or carryforwards',
    locator: '2042-C-PRO deficits and prior-year carryforward fields',
    formIds: ['2042-C-PRO'] as const,
  },
  {
    key: 'business.actualExpenses',
    type: 'decimal' as const,
    expected: '0',
    label: 'Actual business expenses excluded by micro regime',
    locator: 'DGFiP micro regime: fixed abatement represents expenses',
    formIds: ['2042-C-PRO'] as const,
  },
  {
    key: 'business.socialContributions',
    type: 'decimal' as const,
    expected: '0',
    label: 'Social contributions outside this income-tax chain',
    locator: '2042-C-PRO p. 8, prélèvements sociaux lines 5HY–5JY',
    formIds: ['2042-C-PRO'] as const,
  },
  {
    key: 'pas.independentAdvance',
    type: 'decimal' as const,
    label: '2025 income-tax advances on independent activity',
    locator: '2042 line 8HW; annual settlement credit',
    formIds: ['2042'] as const,
  },
  {
    key: 'business.operatorName',
    type: 'text' as const,
    label: 'Operator surname',
    locator: '2042-C-PRO p. 1, Nom de l’exploitant',
    formIds: ['2042-C-PRO'] as const,
    sensitive: true,
  },
  {
    key: 'business.operatorGivenNames',
    type: 'text' as const,
    label: 'Operator given names',
    locator: '2042-C-PRO p. 1, Prénom',
    formIds: ['2042-C-PRO'] as const,
    sensitive: true,
  },
  {
    key: 'business.operatorAddress',
    type: 'text' as const,
    label: 'Business address',
    locator: '2042-C-PRO p. 1, Adresse d’exploitation',
    formIds: ['2042-C-PRO'] as const,
    sensitive: true,
  },
  {
    key: 'business.siret',
    type: 'text' as const,
    label: 'SIRET',
    locator: '2042-C-PRO p. 1, No Siret',
    formIds: ['2042-C-PRO'] as const,
    sensitive: true,
  },
] as const satisfies readonly France2025SelectedFactRequirement[];

const corporationFacts = [
  {
    key: 'filing.incomeYear',
    type: 'decimal' as const,
    expected: '2025',
    label: 'Corporate income year',
    locator: '2065-SD 2026 header and exercise period',
    formIds: ['2065-SD', '2050-2059-G'] as const,
  },
  {
    key: 'filing.declarationYear',
    type: 'decimal' as const,
    expected: '2026',
    label: 'Corporate filing year',
    locator: '2065-SD millésime 2026',
    formIds: ['2065-SD', '2050-2059-G'] as const,
  },
  {
    key: 'corporate.name',
    type: 'text' as const,
    label: 'Company designation',
    locator: '2065-SD p. 1, cadre A — Désignation de la société',
    formIds: ['2065-SD', '2050-2059-G'] as const,
    sensitive: true,
  },
  {
    key: 'corporate.siret',
    type: 'text' as const,
    label: 'Company SIRET',
    locator: '2065-SD p. 1, cadre A — SIRET',
    formIds: ['2065-SD', '2050-2059-G'] as const,
    sensitive: true,
  },
  {
    key: 'corporate.registeredOffice',
    type: 'text' as const,
    label: 'Registered office',
    locator: '2065-SD p. 1, cadre A — Adresse du siège social',
    formIds: ['2065-SD', '2050-2059-G'] as const,
    sensitive: true,
  },
  {
    key: 'corporate.activity',
    type: 'text' as const,
    label: 'Principal activity',
    locator: '2065-SD p. 1, cadre B — Activités exercées',
    formIds: ['2065-SD', '2050-2059-G'] as const,
  },
  {
    key: 'corporate.exerciseStart',
    type: 'date' as const,
    expected: '2025-01-01',
    label: 'Exercise opening date',
    locator: '2065-SD p. 1, Exercice ouvert le',
    formIds: ['2065-SD', '2050-2059-G'] as const,
  },
  {
    key: 'corporate.exerciseEnd',
    type: 'date' as const,
    expected: '2025-12-31',
    label: 'Exercise closing date',
    locator: '2065-SD p. 1, Exercice clos le',
    formIds: ['2065-SD', '2050-2059-G'] as const,
  },
  {
    key: 'corporate.taxRegime',
    type: 'text' as const,
    expected: 'real-normal',
    label: 'Real-normal corporation tax regime',
    locator: '2065-SD p. 1, régime réel normal checkbox',
    formIds: ['2065-SD', '2050-2059-G'] as const,
  },
  {
    key: 'corporate.groupMember',
    type: 'boolean' as const,
    expected: false,
    label: 'No tax group membership',
    locator: '2065-SD p. 1, régime fiscal des groupes',
    formIds: ['2065-SD'] as const,
  },
  {
    key: 'corporate.foreignActivity',
    type: 'boolean' as const,
    expected: false,
    label: 'No foreign activity or treaty income',
    locator: '2065-SD cadre D and selected domestic scope',
    formIds: ['2065-SD', '2050-2059-G'] as const,
  },
  {
    key: 'corporate.accountingResult',
    type: 'decimal' as const,
    label: 'Accounting result before tax adjustments',
    locator: '2058-A-SD line WA/WS source result',
    formIds: ['2058-A-SD'] as const,
  },
  {
    key: 'corporate.taxReintegrations',
    type: 'decimal' as const,
    expected: '0',
    label: 'Tax result reintegrations',
    locator:
      '2058-A-SD lines WR and non-deductible charges; selected zero-adjustment branch',
    formIds: ['2058-A-SD'] as const,
  },
  {
    key: 'corporate.taxDeductions',
    type: 'decimal' as const,
    expected: '0',
    label: 'Tax result deductions',
    locator:
      '2058-A-SD lines XH and deductions; selected zero-adjustment branch',
    formIds: ['2058-A-SD'] as const,
  },
  {
    key: 'corporate.taxableProfit',
    type: 'decimal' as const,
    label: 'Taxable profit before rate split',
    locator: '2058-A-SD line XN (benefit) or XO (deficit)',
    formIds: ['2058-A-SD', '2065-SD'] as const,
  },
  {
    key: 'corporate.annualTurnover',
    type: 'decimal' as const,
    label: 'Annual turnover',
    locator: 'DGFiP IS rate page; reduced-rate €10m turnover condition',
    formIds: ['2065-SD'] as const,
  },
  {
    key: 'corporate.reducedRateEligible',
    type: 'boolean' as const,
    label: 'Reviewed reduced-rate election/eligibility',
    locator: '2065-SD cadre C, bénéfice imposable à 15%; CGI article 219 I b',
    formIds: ['2065-SD'] as const,
  },
  {
    key: 'corporate.capitalFullyPaid',
    type: 'boolean' as const,
    label: 'Capital fully paid',
    locator: 'DGFiP IS rate page; reduced-rate condition',
    formIds: ['2065-SD'] as const,
  },
  {
    key: 'corporate.capitalNaturalPersonOwnership',
    type: 'boolean' as const,
    label: 'At least 75% qualifying natural-person ownership',
    locator: 'DGFiP IS rate page; reduced-rate condition',
    formIds: ['2065-SD'] as const,
  },
  {
    key: 'corporate.longTerm15Profit',
    type: 'decimal' as const,
    expected: '0',
    label: 'Long-term gains at 15%',
    locator: '2065-SD cadre C2, plus-values à long terme imposables à 15%',
    formIds: ['2065-SD'] as const,
  },
  {
    key: 'corporate.longTerm19Profit',
    type: 'decimal' as const,
    expected: '0',
    label: 'Long-term gains at 19%',
    locator: '2065-SD cadre C2, plus-values à long terme imposables à 19%',
    formIds: ['2065-SD'] as const,
  },
  {
    key: 'corporate.exemptProfit',
    type: 'decimal' as const,
    expected: '0',
    label: 'Exempt profit or abatement',
    locator: '2065-SD cadre C3, abattements et exonérations',
    formIds: ['2065-SD', '2058-A-SD'] as const,
  },
  {
    key: 'corporate.taxCredits',
    type: 'decimal' as const,
    expected: '0',
    label: 'Corporate tax credits and imputations',
    locator: '2065-SD cadre D and settlement schedules; selected zero branch',
    formIds: ['2065-SD'] as const,
  },
  {
    key: 'corporate.distributions',
    type: 'decimal' as const,
    expected: '0',
    label: 'Distributions and 2065 bis amounts',
    locator: '2065 bis-SD cadre G; selected no-distribution branch',
    formIds: ['2065 bis-SD'] as const,
  },
  {
    key: 'corporate.taxInstallments',
    type: 'decimal' as const,
    label: 'Corporate income-tax instalments paid',
    locator: 'Annual IS settlement; outside the 2065 form itself',
    formIds: ['2065-SD'] as const,
  },
] as const satisfies readonly France2025SelectedFactRequirement[];

export const FRANCE_2025_SELECTED_REQUIRED_FACTS = deepFreeze({
  salary: [...identityFacts, ...individualCommonFacts, ...salaryFacts],
  'sole-proprietor': [
    ...identityFacts,
    ...individualCommonFacts,
    ...soleProprietorFacts,
  ],
  corporation: corporationFacts,
} as const);

const selectedRules = [
  {
    id: 'fr2025.forms.2042.identity-and-family',
    referenceIds: ['dgfip-fr-form-2042-2026'],
  },
  {
    id: 'fr2025.forms.2042.salary-and-pas',
    referenceIds: [
      'dgfip-fr-form-2042-2026',
      'dgfip-fr-declaration-2026',
      'dgfip-fr-brochure-ir-2026',
    ],
  },
  {
    id: 'fr2025.forms.2042-c-pro.micro-business',
    referenceIds: [
      'dgfip-fr-form-2042-c-pro-2026',
      'dgfip-fr-brochure-ir-2026',
    ],
  },
  {
    id: 'fr2025.forms.2065.is-rates',
    referenceIds: ['dgfip-fr-form-2065-2026', 'dgfip-fr-is-rates-2026'],
  },
  {
    id: 'fr2025.forms.2058-a.tax-result',
    referenceIds: ['dgfip-fr-form-2065-2026'],
  },
] as const;
export const FRANCE_2025_SELECTED_RULES = deepFreeze(selectedRules);

type FieldKind =
  | 'identity'
  | 'family'
  | 'salary'
  | 'salary-zero'
  | 'salary-calculation'
  | 'pas'
  | 'business'
  | 'business-calculation'
  | 'corporate-identity'
  | 'corporate-accounting'
  | 'corporate-rate'
  | 'corporate-zero'
  | 'corporate-calculation'
  | 'corporate-liasse';

type SelectedFieldDefinition = {
  id: string;
  formId: string;
  formVersion: string;
  line: string;
  key: string;
  label: string;
  type: FactType;
  kind: France2025ReturnKind;
  fieldKind: FieldKind;
  required: boolean;
  sensitive?: boolean;
  sourceId: string;
  locator: string;
  ruleIds: readonly string[];
  directFacts: readonly string[];
  manual?: boolean;
};

const identityFieldDefinitions = (
  kind: 'salary' | 'sole-proprietor',
): SelectedFieldDefinition[] =>
  identityFacts.map((fact) => ({
    id: `2042.${fact.key}`,
    formId: '2042',
    formVersion: '2042-2026',
    line: fact.key.startsWith('identity.') ? fact.key.slice(9) : fact.key,
    key: fact.key,
    label: fact.label,
    type: fact.type,
    kind,
    fieldKind: 'identity',
    required: true,
    sensitive: 'sensitive' in fact ? fact.sensitive : undefined,
    sourceId: 'dgfip-fr-form-2042-2026',
    locator: fact.locator,
    ruleIds: ['fr2025.forms.2042.identity-and-family'],
    directFacts: [fact.key],
    manual: fact.key === 'identity.signatureStatus',
  }));

const familyFieldDefinitions = (
  kind: 'salary' | 'sole-proprietor',
): SelectedFieldDefinition[] => [
  {
    id: '2042.family.C',
    formId: '2042',
    formVersion: '2042-2026',
    line: 'C',
    key: 'family.C',
    label: 'Single family status',
    type: 'boolean',
    kind,
    fieldKind: 'family',
    required: true,
    sourceId: 'dgfip-fr-form-2042-2026',
    locator: '2042 p. 2, situation du foyer fiscal — Célibataire C',
    ruleIds: ['fr2025.forms.2042.identity-and-family'],
    directFacts: ['family.status'],
  },
  {
    id: '2042.family.T',
    formId: '2042',
    formVersion: '2042-2026',
    line: 'T',
    key: 'family.T',
    label: 'Parent isolé checkbox',
    type: 'boolean',
    kind,
    fieldKind: 'family',
    required: true,
    sourceId: 'dgfip-fr-form-2042-2026',
    locator: '2042 p. 2, parent isolé T',
    ruleIds: ['fr2025.forms.2042.identity-and-family'],
    directFacts: [
      'family.dependentChildren',
      'family.raisingFirstChildAlone',
      'family.livesAlone',
    ],
  },
  {
    id: '2042.family.F',
    formId: '2042',
    formVersion: '2042-2026',
    line: 'F',
    key: 'family.F',
    label: 'Dependent children count',
    type: 'decimal',
    kind,
    fieldKind: 'family',
    required: true,
    sourceId: 'dgfip-fr-form-2042-2026',
    locator: '2042 p. 2, personnes à charge — enfants à charge F',
    ruleIds: ['fr2025.forms.2042.identity-and-family'],
    directFacts: ['family.dependentChildren'],
  },
];

const salaryFieldDefinitions = (): SelectedFieldDefinition[] => [
  {
    id: '2042.1AJ',
    formId: '2042',
    formVersion: '2042-2026',
    line: '1AJ',
    key: '1AJ.grossSalary',
    label: 'Ordinary salary reported for declarant 1',
    type: 'decimal',
    kind: 'salary',
    fieldKind: 'salary',
    required: true,
    sourceId: 'dgfip-fr-form-2042-2026',
    locator: '2042 p. 3, traitements et salaires — 1AJ',
    ruleIds: ['fr2025.forms.2042.salary-and-pas'],
    directFacts: ['employment.grossSalary'],
  },
  {
    id: '2042.1AK',
    formId: '2042',
    formVersion: '2042-2026',
    line: '1AK',
    key: '1AK.actualExpenses',
    label: 'Actual professional expenses',
    type: 'decimal',
    kind: 'salary',
    fieldKind: 'salary-zero',
    required: true,
    sourceId: 'dgfip-fr-form-2042-2026',
    locator: '2042 p. 3, frais réels — 1AK',
    ruleIds: ['fr2025.forms.2042.salary-and-pas'],
    directFacts: ['deduction.method', 'deduction.actualExpenses'],
  },
  ...[
    ['1AA', 'Private-employer salary', 'income.otherTaxableIncome'],
    [
      '1GA',
      'Assistant-maternel or journalist allowance',
      'income.otherTaxableIncome',
    ],
    ['1GH', 'Exempt overtime or RTT', 'income.otherTaxableIncome'],
    ['1PB', 'Exempt tips', 'income.otherTaxableIncome'],
    ['1AD', 'Exempt value-sharing bonus', 'income.otherTaxableIncome'],
    [
      '1GB',
      'Article 62 associate or manager income',
      'income.otherTaxableIncome',
    ],
    ['1GF', 'Copyright or researcher income', 'income.otherTaxableIncome'],
    [
      '1AP',
      'Other taxable salary or unemployment income',
      'income.otherTaxableIncome',
    ],
    ['1AF', 'Foreign salary with French tax credit', 'income.foreignTaxCredit'],
    ['1AG', 'Other foreign salary', 'income.foreignTaxCredit'],
  ].map(([line, label, fact]) => ({
    id: `2042.${line}`,
    formId: '2042',
    formVersion: '2042-2026',
    line,
    key: `${line}.inapplicable`,
    label,
    type: 'decimal' as const,
    kind: 'salary' as const,
    fieldKind: 'salary-zero' as const,
    required: true,
    sourceId: 'dgfip-fr-form-2042-2026',
    locator: `2042 p. 3, salary branch — ${line}`,
    ruleIds: ['fr2025.forms.2042.salary-and-pas'],
    directFacts: [fact],
  })),
  ...[
    ['1AS', 'Pensions and retirement', 'income.pensions'],
    ['2DC', 'Dividends and other distributed income', 'income.capital'],
    ['4BA', 'Rental income', 'income.rental'],
    ['6DE', 'Deductible CSG', 'income.otherDeductions'],
    ['7UD', 'Donations and reductions', 'income.otherCredits'],
    ['8TK', 'Foreign income with tax credit', 'income.foreignTaxCredit'],
    ['8TA', 'Nonresident withholding', 'income.foreignTaxCredit'],
    ['8TT', 'Foreign insurance contract', 'income.foreignTaxCredit'],
    ['8UU', 'Foreign accounts', 'income.foreignTaxCredit'],
  ].map(([line, label, fact]) => ({
    id: `2042.${line}`,
    formId: '2042',
    formVersion: '2042-2026',
    line,
    key: `${line}.inapplicable`,
    label,
    type: 'decimal' as const,
    kind: 'salary' as const,
    fieldKind: 'salary-zero' as const,
    required: true,
    sourceId: 'dgfip-fr-form-2042-2026',
    locator: `2042 selected zero branch — ${line}`,
    ruleIds: ['fr2025.forms.2042.salary-and-pas'],
    directFacts: [fact],
  })),
  {
    id: '2042.calc.standardDeduction10',
    formId: '2042',
    formVersion: '2042-2026',
    line: 'calc.standardDeduction10',
    key: 'calc.standardDeduction10',
    label: 'Standard professional-expense deduction',
    type: 'decimal',
    kind: 'salary',
    fieldKind: 'salary-calculation',
    required: true,
    sourceId: 'dgfip-fr-brochure-ir-2026',
    locator:
      'Brochure IR 2026 p. 107; 10% with €509 minimum and €14,555 maximum',
    ruleIds: ['fr2025.forms.2042.salary-and-pas'],
    directFacts: ['employment.grossSalary', 'deduction.method'],
  },
  {
    id: '2042.calc.netTaxableSalary',
    formId: '2042',
    formVersion: '2042-2026',
    line: 'calc.netTaxableSalary',
    key: 'calc.netTaxableSalary',
    label: 'Net taxable salary after standard deduction',
    type: 'decimal',
    kind: 'salary',
    fieldKind: 'salary-calculation',
    required: true,
    sourceId: 'dgfip-fr-brochure-ir-2026',
    locator: 'Brochure IR 2026 p. 107 and income-tax worksheet',
    ruleIds: ['fr2025.forms.2042.salary-and-pas'],
    directFacts: ['employment.grossSalary', 'deduction.method'],
  },
];

const individualCalculationFieldDefinitions = (
  kind: 'salary' | 'sole-proprietor',
): SelectedFieldDefinition[] =>
  [
    ['calc.familyParts', 'Quotient-family parts'],
    ['calc.taxableIncomePerPart', 'Taxable income per quotient-family part'],
    ['calc.taxBeforeFamilyCap', 'Tax before family-quotient cap'],
    ['calc.familyQuotientCap', 'Family-quotient cap'],
    ['calc.taxAfterFamilyCap', 'Tax after family-quotient cap'],
    ['calc.decote', 'Single-filer decote'],
    ['calc.taxAfterDecote', 'Tax after decote'],
    ['calc.collectionThresholdTax', 'Tax after collection threshold'],
    [
      'calc.balanceAfterWithholding',
      'Balance after 2025 withholding and advances',
    ],
  ].map(([key, label]) => ({
    id: `2042.${key}`,
    formId: '2042',
    formVersion: '2042-2026',
    line: key,
    key,
    label,
    type: 'decimal' as const,
    kind,
    fieldKind: 'salary-calculation' as const,
    required: true,
    sourceId: 'dgfip-fr-brochure-ir-2026',
    locator:
      key === 'calc.decote'
        ? 'BOFiP BOI-IR-LIQ-20-20-30; single-filer decote'
        : 'BOFiP and Brochure IR 2026; selected annual income-tax chain',
    ruleIds: ['fr2025.forms.2042.salary-and-pas'],
    directFacts: [
      'family.status',
      'family.dependentChildren',
      'family.raisingFirstChildAlone',
      'family.livesAlone',
    ],
  }));

const pasFieldDefinitions = (
  kind: 'salary' | 'sole-proprietor',
): SelectedFieldDefinition[] => [
  {
    id: '2042.8HV',
    formId: '2042',
    formVersion: '2042-2026',
    line: '8HV',
    key: '8HV.pasWithheld2025',
    label: 'Salary withholding paid in 2025',
    type: 'decimal',
    kind,
    fieldKind: 'pas',
    required: true,
    sourceId: 'dgfip-fr-form-2042-2026',
    locator:
      '2042 p. 4, PAS already paid — retenue à la source sur salaires 8HV',
    ruleIds: ['fr2025.forms.2042.salary-and-pas'],
    directFacts: ['pas.calendarYear', 'pas.withheld'],
  },
  {
    id: '2042.8HW',
    formId: '2042',
    formVersion: '2042-2026',
    line: '8HW',
    key: '8HW.independentAdvance2025',
    label: 'Independent-activity income-tax advances paid in 2025',
    type: 'decimal',
    kind,
    fieldKind: 'pas',
    required: kind === 'sole-proprietor',
    sourceId: 'dgfip-fr-form-2042-2026',
    locator: '2042 p. 4, acomptes d’impôt sur le revenu 8HW',
    ruleIds: ['fr2025.forms.2042.salary-and-pas'],
    directFacts: kind === 'sole-proprietor' ? ['pas.independentAdvance'] : [],
  },
];

const soleBusinessFieldDefinitions = (): SelectedFieldDefinition[] => [
  {
    id: '2042-C-PRO.5KP',
    formId: '2042-C-PRO',
    formVersion: '2042-C-PRO-2026',
    line: '5KP',
    key: '5KP.microBicServicesReceipts',
    label: 'Micro-BIC services gross sales',
    type: 'decimal',
    kind: 'sole-proprietor',
    fieldKind: 'business',
    required: true,
    sourceId: 'dgfip-fr-form-2042-c-pro-2026',
    locator: '2042-C-PRO p. 3, micro BIC prestations de services — 5KP',
    ruleIds: ['fr2025.forms.2042-c-pro.micro-business'],
    directFacts: ['business.grossReceipts', 'business.incomeCategory'],
  },
  {
    id: '2042-C-PRO.5HV',
    formId: '2042-C-PRO',
    formVersion: '2042-C-PRO-2026',
    line: '5HV',
    key: '5HV.microBncGrossReceipts',
    label: 'Micro-BNC gross receipts',
    type: 'decimal',
    kind: 'sole-proprietor',
    fieldKind: 'business',
    required: true,
    sourceId: 'dgfip-fr-form-2042-c-pro-2026',
    locator: '2042-C-PRO p. 6, micro BNC recettes brutes — 5HV',
    ruleIds: ['fr2025.forms.2042-c-pro.micro-business'],
    directFacts: ['business.grossReceipts', 'business.incomeCategory'],
  },
  {
    id: '2042-C-PRO.5HQ',
    formId: '2042-C-PRO',
    formVersion: '2042-C-PRO-2026',
    line: '5HQ',
    key: '5HQ.microBncTaxableIncome',
    label: 'Micro-BNC taxable income after 34% abatement',
    type: 'decimal',
    kind: 'sole-proprietor',
    fieldKind: 'business-calculation',
    required: true,
    sourceId: 'dgfip-fr-form-2042-c-pro-2026',
    locator: '2042-C-PRO p. 6, micro BNC revenus imposables — 5HQ',
    ruleIds: ['fr2025.forms.2042-c-pro.micro-business'],
    directFacts: ['business.grossReceipts', 'business.incomeCategory'],
  },
  {
    id: '2042-C-PRO.identity',
    formId: '2042-C-PRO',
    formVersion: '2042-C-PRO-2026',
    line: 'operator-identity',
    key: 'business.operatorIdentity',
    label: 'Operator identity, address and SIRET',
    type: 'text',
    kind: 'sole-proprietor',
    fieldKind: 'business',
    required: true,
    sourceId: 'dgfip-fr-form-2042-c-pro-2026',
    locator:
      '2042-C-PRO p. 1, identification des personnes exerçant une activité non salariée',
    ruleIds: ['fr2025.forms.2042-c-pro.micro-business'],
    directFacts: [
      'business.operatorName',
      'business.operatorGivenNames',
      'business.operatorAddress',
      'business.siret',
    ],
    sensitive: true,
  },
  {
    id: '2042-C-PRO.calc.businessTaxableIncome',
    formId: '2042-C-PRO',
    formVersion: '2042-C-PRO-2026',
    line: 'calc.businessTaxableIncome',
    key: 'calc.businessTaxableIncome',
    label: 'Micro-business taxable income after fixed abatement',
    type: 'decimal',
    kind: 'sole-proprietor',
    fieldKind: 'business-calculation',
    required: true,
    sourceId: 'dgfip-fr-brochure-ir-2026',
    locator:
      'Brochure IR 2026 professional-income section; 50% BIC services or 34% BNC, minimum €305',
    ruleIds: ['fr2025.forms.2042-c-pro.micro-business'],
    directFacts: ['business.grossReceipts', 'business.incomeCategory'],
  },
];

const corporateFieldDefinitions = (): SelectedFieldDefinition[] => [
  ...corporationFacts
    .filter((fact) =>
      [
        'corporate.name',
        'corporate.siret',
        'corporate.registeredOffice',
        'corporate.activity',
        'corporate.exerciseStart',
        'corporate.exerciseEnd',
        'corporate.taxRegime',
        'corporate.groupMember',
        'corporate.foreignActivity',
      ].includes(fact.key),
    )
    .map((fact) => ({
      id: `2065-SD.${fact.key}`,
      formId: '2065-SD',
      formVersion: '2065-SD-2026',
      line: fact.key,
      key: fact.key,
      label: fact.label,
      type: fact.type,
      kind: 'corporation' as const,
      fieldKind: 'corporate-identity' as const,
      required: true,
      sensitive: 'sensitive' in fact ? fact.sensitive : undefined,
      sourceId: 'dgfip-fr-form-2065-2026',
      locator: fact.locator,
      ruleIds: ['fr2025.forms.2065.is-rates'],
      directFacts: [fact.key],
    })),
  {
    id: '2058-A.WA',
    formId: '2058-A-SD',
    formVersion: '2050-2059-G-2026',
    line: 'WA',
    key: '2058-A.accountingResult',
    label: 'Accounting result before tax adjustments',
    type: 'decimal',
    kind: 'corporation',
    fieldKind: 'corporate-accounting',
    required: true,
    sourceId: 'dgfip-fr-form-2065-2026',
    locator: '2058-A-SD p. 11, I — bénéfice comptable WA / perte comptable WS',
    ruleIds: ['fr2025.forms.2058-a.tax-result'],
    directFacts: ['corporate.accountingResult'],
  },
  {
    id: '2058-A.WR',
    formId: '2058-A-SD',
    formVersion: '2050-2059-G-2026',
    line: 'WR',
    key: '2058-A.totalReintegrations',
    label: 'Total tax-result reintegrations',
    type: 'decimal',
    kind: 'corporation',
    fieldKind: 'corporate-accounting',
    required: true,
    sourceId: 'dgfip-fr-form-2065-2026',
    locator: '2058-A-SD p. 11, TOTAL I — WR',
    ruleIds: ['fr2025.forms.2058-a.tax-result'],
    directFacts: ['corporate.taxReintegrations'],
  },
  {
    id: '2058-A.XH',
    formId: '2058-A-SD',
    formVersion: '2050-2059-G-2026',
    line: 'XH',
    key: '2058-A.totalDeductions',
    label: 'Total tax-result deductions',
    type: 'decimal',
    kind: 'corporation',
    fieldKind: 'corporate-accounting',
    required: true,
    sourceId: 'dgfip-fr-form-2065-2026',
    locator: '2058-A-SD p. 11, TOTAL II — XH',
    ruleIds: ['fr2025.forms.2058-a.tax-result'],
    directFacts: ['corporate.taxDeductions'],
  },
  {
    id: '2058-A.XN',
    formId: '2058-A-SD',
    formVersion: '2050-2059-G-2026',
    line: 'XN',
    key: '2058-A.taxableProfit',
    label: 'Final taxable profit',
    type: 'decimal',
    kind: 'corporation',
    fieldKind: 'corporate-calculation',
    required: true,
    sourceId: 'dgfip-fr-form-2065-2026',
    locator: '2058-A-SD p. 11, résultat fiscal — bénéfice XN',
    ruleIds: ['fr2025.forms.2058-a.tax-result'],
    directFacts: [
      'corporate.accountingResult',
      'corporate.taxReintegrations',
      'corporate.taxDeductions',
      'corporate.taxableProfit',
    ],
  },
  {
    id: '2058-A.XO',
    formId: '2058-A-SD',
    formVersion: '2050-2059-G-2026',
    line: 'XO',
    key: '2058-A.deficit',
    label: 'Taxable deficit carried forward',
    type: 'decimal',
    kind: 'corporation',
    fieldKind: 'corporate-zero',
    required: true,
    sourceId: 'dgfip-fr-form-2065-2026',
    locator: '2058-A-SD p. 11, résultat fiscal — déficit reportable XO',
    ruleIds: ['fr2025.forms.2058-a.tax-result'],
    directFacts: ['corporate.taxableProfit'],
  },
  {
    id: '2065.C1',
    formId: '2065-SD',
    formVersion: '2065-SD-2026',
    line: 'C1-normal',
    key: '2065.normalRateProfit',
    label: 'Profit taxable at normal 25% rate',
    type: 'decimal',
    kind: 'corporation',
    fieldKind: 'corporate-rate',
    required: true,
    sourceId: 'dgfip-fr-form-2065-2026',
    locator: '2065-SD p. 1, cadre C — bénéfice imposable au taux normal',
    ruleIds: ['fr2025.forms.2065.is-rates'],
    directFacts: ['corporate.taxableProfit', 'corporate.reducedRateEligible'],
  },
  {
    id: '2065.C2',
    formId: '2065-SD',
    formVersion: '2065-SD-2026',
    line: 'C1-15',
    key: '2065.reducedRateProfit',
    label: 'Profit taxable at reduced 15% rate',
    type: 'decimal',
    kind: 'corporation',
    fieldKind: 'corporate-rate',
    required: true,
    sourceId: 'dgfip-fr-form-2065-2026',
    locator: '2065-SD p. 1, cadre C — bénéfice imposable à 15%',
    ruleIds: ['fr2025.forms.2065.is-rates'],
    directFacts: [
      'corporate.taxableProfit',
      'corporate.reducedRateEligible',
      'corporate.annualTurnover',
      'corporate.capitalFullyPaid',
      'corporate.capitalNaturalPersonOwnership',
    ],
  },
  {
    id: '2065.IS',
    formId: '2065-SD',
    formVersion: '2065-SD-2026',
    line: 'calculated-IS',
    key: '2065.calculatedIncomeTax',
    label: 'Calculated corporate income tax',
    type: 'decimal',
    kind: 'corporation',
    fieldKind: 'corporate-calculation',
    required: true,
    sourceId: 'dgfip-fr-is-rates-2026',
    locator:
      'DGFiP IS rate page and 2065-SD cadre C; profit rounded to euro then rate applied',
    ruleIds: ['fr2025.forms.2065.is-rates'],
    directFacts: ['corporate.taxableProfit'],
  },
  {
    id: '2065.balance',
    formId: '2065-SD',
    formVersion: '2065-SD-2026',
    line: 'calculated-balance',
    key: '2065.balanceAfterInstallments',
    label: 'Working balance after corporate instalments',
    type: 'decimal',
    kind: 'corporation',
    fieldKind: 'corporate-calculation',
    required: true,
    sourceId: 'dgfip-fr-form-2065-2026',
    locator:
      'Selected annual settlement working paper; instalments are not a 2065 field',
    ruleIds: ['fr2025.forms.2065.is-rates'],
    directFacts: ['corporate.taxInstallments'],
  },
  ...[
    [
      '2065bis.distributions',
      '2065 bis distributions',
      'corporate.distributions',
    ],
    [
      '2065bis.remunerations',
      '2065 bis associate remunerations',
      'corporate.distributions',
    ],
  ].map(([key, label, fact]) => ({
    id: `2065-bis.${key}`,
    formId: '2065 bis-SD',
    formVersion: '2065-SD-2026',
    line: key,
    key,
    label,
    type: 'decimal' as const,
    kind: 'corporation' as const,
    fieldKind: 'corporate-zero' as const,
    required: true,
    sourceId: 'dgfip-fr-form-2065-2026',
    locator: '2065 bis-SD cadres G/H; selected no-distribution branch',
    ruleIds: ['fr2025.forms.2065.is-rates'],
    directFacts: [fact],
  })),
  {
    id: '2050-2059-G.liasse',
    formId: '2050-2059-G',
    formVersion: '2050-2059-G-2026',
    line: 'required-liasse',
    key: '2050-2059-G.completeLiasse',
    label: 'Underlying real-normal liasse field set',
    type: 'text',
    kind: 'corporation',
    fieldKind: 'corporate-liasse',
    required: true,
    sourceId: 'dgfip-fr-form-2065-2026',
    locator:
      '2065-SD notice: tables 2050 to 2059-G are attached for real-normal companies',
    ruleIds: ['fr2025.forms.2058-a.tax-result'],
    directFacts: [],
  },
];

export const FRANCE_2025_SELECTED_FIELD_CATALOG = deepFreeze([
  ...identityFieldDefinitions('salary'),
  ...familyFieldDefinitions('salary'),
  ...salaryFieldDefinitions(),
  ...individualCalculationFieldDefinitions('salary'),
  ...pasFieldDefinitions('salary'),
  ...identityFieldDefinitions('sole-proprietor'),
  ...familyFieldDefinitions('sole-proprietor'),
  ...individualCalculationFieldDefinitions('sole-proprietor'),
  ...pasFieldDefinitions('sole-proprietor'),
  ...soleBusinessFieldDefinitions(),
  ...corporateFieldDefinitions(),
] as const);

export type France2025SelectedFieldDecision =
  'populated' | 'inapplicable' | 'user-required' | 'unsupported';

export type France2025SelectedFormField = {
  id: string;
  formId: string;
  formVersion: string;
  line: string;
  key: string;
  label: string;
  type: FactType;
  decision: France2025SelectedFieldDecision;
  required: boolean;
  reason: string;
  sensitive: boolean;
  value: FinanceTaxValue | null;
  exactRational: { numerator: string; denominator: string } | null;
  reportableValue: string | null;
  sourceId: string;
  documentHash: string;
  locator: string;
  dependencies: string[];
  sourceFactKeys: string[];
  referenceIds: string[];
  ruleIds: string[];
};

export type France2025SelectedFormCoverage = {
  formId: string;
  formVersion: string;
  required: boolean;
  fieldCount: number;
  populatedCount: number;
  inapplicableCount: number;
  userRequiredCount: number;
  unsupportedCount: number;
  selectedFieldsComplete: boolean;
};

export type France2025SelectedFormApplicability = {
  version: string;
  packageVersion: string;
  returnKind: France2025ReturnKind | null;
  scope: Record<string, unknown>;
  inputHash: string;
  complete: false;
  formDataReady: boolean;
  signature: {
    status: 'manual-unperformed';
    blocksCalculation: false;
  };
  fields: France2025SelectedFormField[];
  forms: France2025SelectedFormCoverage[];
  unresolvedCount: number;
  issues: France2025SelectedIssue[];
  requiredFacts: France2025SelectedFactRequirement[];
};

export type France2025SelectedIssue = {
  code: string;
  path: string;
  message: string;
};

type Fact = FinanceTaxIntake['facts'][number];
type Facts = ReadonlyMap<string, Fact>;

type IndividualSelectedCalculation = {
  taxableIncomeExact: Exact;
  taxableIncome: Exact;
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
  pasSalaryExact: Exact;
  pasAdvanceExact: Exact;
  pasTotalExact: Exact;
  balanceExact: Exact;
};

export type France2025SoleProprietorCalculation =
  IndividualSelectedCalculation & {
    returnKind: 'sole-proprietor';
    incomeCategory: 'BIC-services' | 'BNC';
    grossReceipts: Exact;
    abatement: Exact;
    abatementRate: Exact;
    taxableBusinessIncome: Exact;
  };

export type France2025CorporationCalculation = {
  returnKind: 'corporation';
  accountingResult: Exact;
  taxReintegrations: Exact;
  taxDeductions: Exact;
  taxableProfitExact: Exact;
  taxableProfit: Exact;
  annualTurnover: Exact;
  reducedRateEligible: boolean;
  reducedRateProfit: Exact;
  normalRateProfit: Exact;
  incomeTaxExact: Exact;
  incomeTax: bigint;
  taxInstallmentsExact: Exact;
  balanceExact: Exact;
  balance: bigint;
};

export type France2025SelectedCalculation =
  | (France2025Calculation & { returnKind: 'salary' })
  | France2025SoleProprietorCalculation
  | France2025CorporationCalculation;

export type France2025SelectedReturnRun = {
  schemaVersion: 1;
  packageId: string;
  packageVersion: string;
  returnKind: France2025ReturnKind | null;
  scope: Record<string, unknown>;
  complete: false;
  enabled: false;
  reportable: false;
  registryEligible: false;
  status: 'blocked-input' | 'review-calculation-produced';
  inputSnapshot: FinanceTaxIntake | null;
  inputHash: string;
  runHash: string;
  issues: France2025SelectedIssue[];
  sources: typeof FRANCE_2025_SOURCES;
  sourceReviews: typeof FRANCE_2025_SOURCE_REVIEWS;
  provenance: Omit<typeof FRANCE_2025_PROVENANCE, 'returnForm'> & {
    returnForm: string;
  };
  releaseBlockers: readonly string[];
  reportingPolicyVersion: string;
  calculation: France2025SelectedCalculation | null;
  fields: France2025SelectedFormField[];
  formCoverage: France2025SelectedFormCoverage[];
  formApplicability: France2025SelectedFormApplicability;
  evaluation: FinanceTaxEvaluation;
};

type ValueRecord = {
  value: FinanceTaxValue;
  exact?: Exact;
  sourceFactKeys: string[];
  dependencies: string[];
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

const authoritySource = (sourceId: string) => {
  const source = FRANCE_2025_SOURCES.find((entry) => entry.id === sourceId);
  if (!source) throw new Error(`missing-france-source:${sourceId}`);
  return source;
};

const sourceReferenceIds = (sourceId: string) =>
  Array.from(
    FRANCE_2025_SELECTED_RULES.find((rule) =>
      rule.referenceIds.some((referenceId) => referenceId === sourceId),
    )?.referenceIds ?? [sourceId],
  );

function selectedReturnFormVersion(
  returnKind: France2025ReturnKind | null,
): string {
  if (!returnKind) return 'unresolved';
  return FRANCE_2025_SELECTED_SCOPES[returnKind].formVersion;
}

function selectedProvenance(
  returnKind: France2025ReturnKind | null,
): Omit<typeof FRANCE_2025_PROVENANCE, 'returnForm'> & { returnForm: string } {
  return {
    ...FRANCE_2025_PROVENANCE,
    returnForm: selectedReturnFormVersion(returnKind),
  };
}

function issue(
  code: string,
  path: string,
  message: string,
): France2025SelectedIssue {
  return { code, path, message };
}

function blockingFactKeys(
  issues: readonly France2025SelectedIssue[],
): ReadonlySet<string> {
  return new Set(
    issues
      .filter((entry) => entry.path.startsWith('facts.'))
      .map((entry) => entry.path.slice('facts.'.length)),
  );
}

function valueOf(
  facts: Facts,
  key: string,
): FinanceTaxValue['value'] | undefined {
  return facts.get(key)?.value.value;
}

function exactAmount(value: string, signed = false): Exact {
  const parsed = decimal(value, { maxPlaces: 2 });
  if (!signed && parsed.n < 0n) throw new Error('negative-money');
  return parsed;
}

function decimalFact(facts: Facts, key: string, signed = false): Exact {
  const value = facts.get(key)?.value;
  if (!value || value.type !== 'decimal')
    throw new Error(`missing-money:${key}`);
  return exactAmount(value.value, signed);
}

function integerFact(facts: Facts, key: string): bigint {
  const value = decimalFact(facts, key);
  if (value.d !== 1n) throw new Error(`noninteger:${key}`);
  return value.n;
}

function matchesExpected(value: FinanceTaxValue, expected: string | boolean) {
  if (value.type === 'decimal' && typeof expected === 'string') {
    try {
      return compare(decimal(value.value), decimal(expected)) === 0n;
    } catch {
      return false;
    }
  }
  return value.value === expected;
}

function requirementsFor(
  kind: France2025ReturnKind | null,
): readonly France2025SelectedFactRequirement[] {
  return kind ? FRANCE_2025_SELECTED_REQUIRED_FACTS[kind] : [];
}

function resolveReturnKind(
  scope: FinanceTaxIntake['scope'],
): France2025ReturnKind | null {
  if (scope.country !== 'FR' || scope.subdivision !== 'FR-METRO') return null;
  if (scope.taxpayerType === 'individual') return 'salary';
  if (scope.taxpayerType === 'sole-proprietor') return 'sole-proprietor';
  if (scope.taxpayerType === 'corporation') return 'corporation';
  return null;
}

function expectedScopeFor(kind: France2025ReturnKind) {
  return FRANCE_2025_SELECTED_SCOPES[kind] as Record<string, unknown>;
}

function validateFactValue(
  requirement: France2025SelectedFactRequirement,
  fact: Fact,
  issues: France2025SelectedIssue[],
) {
  if (fact.reviewState !== 'reviewed')
    issues.push(
      issue(
        'unreviewed-fact',
        `facts.${requirement.key}`,
        'Unreviewed or disputed facts cannot populate a return field.',
      ),
    );
  if (fact.value.type !== requirement.type) {
    issues.push(
      issue(
        'fact-type-mismatch',
        `facts.${requirement.key}`,
        `Expected a ${requirement.type} fact.`,
      ),
    );
    return;
  }
  if (
    requirement.expected !== undefined &&
    !matchesExpected(fact.value, requirement.expected)
  )
    issues.push(
      issue(
        'unsupported-fact',
        `facts.${requirement.key}`,
        `Supported value is ${String(requirement.expected)}.`,
      ),
    );
  if (fact.value.type === 'decimal') {
    try {
      exactAmount(
        fact.value.value,
        ['corporate.accountingResult', 'corporate.taxableProfit'].includes(
          requirement.key,
        ),
      );
    } catch (error) {
      issues.push(
        issue(
          'invalid-money',
          `facts.${requirement.key}`,
          error instanceof Error && error.message === 'negative-money'
            ? 'Amounts must be nonnegative in this selected return branch.'
            : 'Amounts must be valid decimals with at most two fractional places.',
        ),
      );
    }
  }
}

function assessIdentityFormat(
  facts: Facts,
  kind: France2025ReturnKind,
  issues: France2025SelectedIssue[],
) {
  if (kind === 'corporation') return;
  const textKeys = [
    'identity.nameAtBirth',
    'identity.givenNames',
    'identity.birthPlace',
    'identity.addressAtJan2026',
    'identity.postalCode',
    'identity.city',
    'identity.taxNumber',
    'identity.phone',
    'identity.email',
  ];
  for (const key of textKeys) {
    const value = facts.get(key)?.value;
    if (value?.type === 'text' && !value.value.trim())
      issues.push(
        issue(
          'invalid-identity',
          `facts.${key}`,
          'Identity text cannot be blank.',
        ),
      );
  }
  const postalCode = valueOf(facts, 'identity.postalCode');
  if (typeof postalCode === 'string' && !/^\d{5}$/.test(postalCode))
    issues.push(
      issue(
        'invalid-identity',
        'facts.identity.postalCode',
        'Metropolitan postal code must contain five digits.',
      ),
    );
  const taxNumber = valueOf(facts, 'identity.taxNumber');
  if (typeof taxNumber === 'string' && !/^\d{13}$/.test(taxNumber))
    issues.push(
      issue(
        'invalid-identity',
        'facts.identity.taxNumber',
        'French tax number must contain thirteen digits.',
      ),
    );
}

function assessFamily(facts: Facts, issues: France2025SelectedIssue[]) {
  const count = facts.get('family.dependentChildren')?.value;
  if (!count || count.type !== 'decimal') return;
  try {
    const children = integerFact(facts, 'family.dependentChildren');
    if (children !== 0n && children !== 1n)
      issues.push(
        issue(
          'unsupported-family-size',
          'facts.family.dependentChildren',
          'Selected individual returns support zero or one first child only.',
        ),
      );
    const raising = valueOf(facts, 'family.raisingFirstChildAlone');
    const alone = valueOf(facts, 'family.livesAlone');
    if (children === 1n && (raising !== true || alone !== true))
      issues.push(
        issue(
          'unsupported-family-status',
          'facts.family.raisingFirstChildAlone',
          'The one-child branch requires living alone and raising the first child alone.',
        ),
      );
    if (children === 0n && (raising !== false || alone !== false))
      issues.push(
        issue(
          'inconsistent-family-facts',
          'facts.family',
          'The no-child branch requires false single-parent and lives-alone flags.',
        ),
      );
  } catch {
    issues.push(
      issue(
        'invalid-family-size',
        'facts.family.dependentChildren',
        'Dependent-child count must be a whole-number decimal.',
      ),
    );
  }
}

function assessSoleProprietor(facts: Facts, issues: France2025SelectedIssue[]) {
  const category = valueOf(facts, 'business.incomeCategory');
  if (category !== 'BIC-services' && category !== 'BNC')
    issues.push(
      issue(
        'unsupported-business-category',
        'facts.business.incomeCategory',
        'Only one ordinary micro-BIC services or micro-BNC activity is supported.',
      ),
    );
  const receipts = facts.get('business.grossReceipts')?.value;
  if (receipts?.type === 'decimal') {
    try {
      if (
        compare(decimal(receipts.value, { maxPlaces: 2 }), decimal('77700')) >
        0n
      )
        issues.push(
          issue(
            'unsupported-business-threshold',
            'facts.business.grossReceipts',
            'Selected micro service/BNC receipts may not exceed the 2025 €77,700 threshold.',
          ),
        );
    } catch {
      // validateFactValue reports malformed money.
    }
  }
  for (const [key, expected] of [
    ['business.activitiesCount', 1n],
    ['business.fiscalMonths', 12n],
  ] as const) {
    try {
      if (integerFact(facts, key) !== expected)
        issues.push(
          issue(
            'unsupported-business-shape',
            `facts.${key}`,
            `Selected branch requires ${String(expected)}.`,
          ),
        );
    } catch {
      // Missing/type issues are reported by the requirement pass.
    }
  }
}

function assessCorporation(
  intake: FinanceTaxIntake,
  facts: Facts,
  issues: France2025SelectedIssue[],
) {
  if (intake.legalEntityId === null)
    issues.push(
      issue(
        'missing-corporate-identity',
        'legalEntityId',
        'A standalone corporation requires a bound legal-entity identity.',
      ),
    );
  const siret = valueOf(facts, 'corporate.siret');
  if (typeof siret === 'string' && !/^\d{14}$/.test(siret))
    issues.push(
      issue(
        'invalid-corporate-identity',
        'facts.corporate.siret',
        'French SIRET must contain fourteen digits.',
      ),
    );
  const taxable = facts.get('corporate.taxableProfit')?.value;
  const accounting = facts.get('corporate.accountingResult')?.value;
  if (taxable?.type === 'decimal' && accounting?.type === 'decimal') {
    try {
      const expected = plus(
        decimal(accounting.value, { maxPlaces: 2 }),
        decimal(String(valueOf(facts, 'corporate.taxReintegrations') ?? '0'), {
          maxPlaces: 2,
        }),
        times(
          decimal(String(valueOf(facts, 'corporate.taxDeductions') ?? '0'), {
            maxPlaces: 2,
          }),
          -1n,
        ),
      );
      if (compare(expected, decimal(taxable.value, { maxPlaces: 2 })) !== 0n)
        issues.push(
          issue(
            'corporate-tax-result-mismatch',
            'facts.corporate.taxableProfit',
            'Taxable profit must equal accounting result plus reintegrations less deductions.',
          ),
        );
      if (expected.n < 0n)
        issues.push(
          issue(
            'unsupported-corporate-deficit',
            'facts.corporate.taxableProfit',
            'Corporate deficit carryforward and carryback are outside this selected chain.',
          ),
        );
    } catch {
      // The requirement pass reports malformed amounts.
    }
  }
  const reduced = valueOf(facts, 'corporate.reducedRateEligible');
  if (reduced === true) {
    const turnover = facts.get('corporate.annualTurnover')?.value;
    if (turnover?.type === 'decimal') {
      try {
        if (
          compare(
            decimal(turnover.value, { maxPlaces: 2 }),
            decimal('10000000'),
          ) > 0n
        )
          issues.push(
            issue(
              'unsupported-reduced-rate',
              'facts.corporate.annualTurnover',
              'Reduced 15% rate requires turnover no greater than €10,000,000.',
            ),
          );
      } catch {
        // The requirement pass reports malformed amounts.
      }
    }
    if (valueOf(facts, 'corporate.capitalFullyPaid') !== true)
      issues.push(
        issue(
          'unsupported-reduced-rate',
          'facts.corporate.capitalFullyPaid',
          'Reduced 15% rate requires fully paid capital.',
        ),
      );
    if (valueOf(facts, 'corporate.capitalNaturalPersonOwnership') !== true)
      issues.push(
        issue(
          'unsupported-reduced-rate',
          'facts.corporate.capitalNaturalPersonOwnership',
          'Reduced 15% rate requires qualifying ownership review.',
        ),
      );
  }
}

/**
 * Validates the selected-return intake. Every excluded field is represented by
 * a reviewed zero/false fact so a missing exclusion cannot become an implicit
 * zero. The private identity values remain facts in the envelope; persistence
 * may later provide them through a dedicated private-intake seam.
 */
export function assessFrance2025SelectedReturnFacts(raw: unknown): {
  intake: FinanceTaxIntake | null;
  returnKind: France2025ReturnKind | null;
  issues: France2025SelectedIssue[];
} {
  const parsed = FinanceTaxIntakeSchema.safeParse(raw);
  if (!parsed.success)
    return {
      intake: null,
      returnKind: null,
      issues: [
        issue(
          'invalid-intake',
          'intake',
          'A complete versioned intake envelope with source-bound reviewed facts is required.',
        ),
      ],
    };
  const intake = parsed.data;
  const returnKind = resolveReturnKind(intake.scope);
  const issues: France2025SelectedIssue[] = [];
  if (!returnKind)
    issues.push(
      issue(
        'unsupported-scope',
        'scope',
        'Only metropolitan France individual, sole-proprietor or corporation scopes are supported.',
      ),
    );
  if (returnKind) {
    for (const [key, expected] of Object.entries(expectedScopeFor(returnKind)))
      if (intake.scope[key as keyof typeof intake.scope] !== expected)
        issues.push(
          issue(
            'unsupported-scope',
            `scope.${key}`,
            `This selected branch requires ${key}=${String(expected)}.`,
          ),
        );
  }
  if (intake.domesticResident !== true)
    issues.push(
      issue(
        intake.domesticResident === null ? 'missing-fact' : 'unsupported-scope',
        'domesticResident',
        'Only a reviewed domestic resident or domestic corporation is supported.',
      ),
    );
  if (intake.hasCrossBorderActivity !== false)
    issues.push(
      issue(
        intake.hasCrossBorderActivity === null
          ? 'missing-fact'
          : 'unsupported-scope',
        'hasCrossBorderActivity',
        'Cross-border activity and treaty cases are outside this package.',
      ),
    );
  if (returnKind === 'corporation') {
    if (intake.standaloneCorporation !== true)
      issues.push(
        issue(
          intake.standaloneCorporation === null
            ? 'missing-fact'
            : 'unsupported-scope',
          'standaloneCorporation',
          'A standalone corporation status is required.',
        ),
      );
  } else if (intake.standaloneCorporation !== null)
    issues.push(
      issue(
        'unsupported-scope',
        'standaloneCorporation',
        'Corporate status cannot be attached to an individual return.',
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
        'Filing, payroll, electronic-filing and consolidation features are outside this package.',
      ),
    );
  const facts = new Map(intake.facts.map((fact) => [fact.key, fact]));
  const requirements = requirementsFor(returnKind);
  const known = new Set(requirements.map((requirement) => requirement.key));
  for (const fact of intake.facts)
    if (!known.has(fact.key))
      issues.push(
        issue(
          'unsupported-fact',
          `facts.${fact.key}`,
          'Fact is outside the selected France return branch.',
        ),
      );
  for (const requirement of requirements) {
    const fact = facts.get(requirement.key);
    if (!fact) {
      issues.push(
        issue(
          'missing-fact',
          `facts.${requirement.key}`,
          `Reviewed ${requirement.type} input is required: ${requirement.label}.`,
        ),
      );
      continue;
    }
    validateFactValue(requirement, fact, issues);
  }
  if (returnKind === 'salary' || returnKind === 'sole-proprietor') {
    assessIdentityFormat(facts, returnKind, issues);
    assessFamily(facts, issues);
  }
  if (returnKind === 'sole-proprietor') assessSoleProprietor(facts, issues);
  if (returnKind === 'corporation') assessCorporation(intake, facts, issues);
  return { intake, returnKind, issues };
}

function roundCap(value: Exact): bigint {
  return BigInt(report(value));
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function individualCalculation(
  taxableIncomeExact: Exact,
  children: bigint,
  pasSalaryExact: Exact,
  pasAdvanceExact: Exact,
): IndividualSelectedCalculation {
  const taxableIncome = rounded(taxableIncomeExact);
  const parts = children === 1n ? q(2n) : q(1n);
  const taxableIncomePerPart = q(
    taxableIncome.n * parts.d,
    taxableIncome.d * parts.n,
  );
  const taxBeforeFamilyCapExact = france2025ProgressiveTax(
    taxableIncome,
    parts,
  );
  const taxBeforeFamilyCap = france2025RoundedProgressiveTax(
    taxableIncome,
    parts,
  );
  const taxWithOnePart = france2025RoundedProgressiveTax(taxableIncome, q(1n));
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
  const pasTotalExact = plus(pasSalaryExact, pasAdvanceExact);
  const balanceExact = minus(q(taxAfterCollectionThreshold), pasTotalExact);
  return {
    taxableIncomeExact,
    taxableIncome,
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
    pasSalaryExact,
    pasAdvanceExact,
    pasTotalExact,
    balanceExact,
  };
}

function soleProprietorCalculation(
  intake: FinanceTaxIntake,
): France2025SoleProprietorCalculation {
  const facts = new Map(intake.facts.map((fact) => [fact.key, fact]));
  const category = valueOf(facts, 'business.incomeCategory');
  if (category !== 'BIC-services' && category !== 'BNC')
    throw new Error('unsupported-business-category');
  const grossReceipts = decimalFact(facts, 'business.grossReceipts');
  const abatementRate =
    category === 'BIC-services' ? q(50n, 100n) : q(34n, 100n);
  const percentageAbatement = times(
    grossReceipts,
    category === 'BIC-services' ? 50n : 34n,
    100n,
  );
  const statutoryMinimum = q(305n);
  const requestedAbatement =
    compare(percentageAbatement, statutoryMinimum) >= 0
      ? percentageAbatement
      : statutoryMinimum;
  const abatement =
    compare(requestedAbatement, grossReceipts) > 0
      ? grossReceipts
      : requestedAbatement;
  const taxableBusinessIncome = minus(grossReceipts, abatement);
  const children = integerFact(facts, 'family.dependentChildren');
  const individual = individualCalculation(
    taxableBusinessIncome,
    children,
    decimalFact(facts, 'pas.withheld'),
    decimalFact(facts, 'pas.independentAdvance'),
  );
  return {
    returnKind: 'sole-proprietor',
    incomeCategory: category,
    grossReceipts,
    abatement,
    abatementRate,
    taxableBusinessIncome,
    ...individual,
  };
}

function corporationCalculation(
  intake: FinanceTaxIntake,
): France2025CorporationCalculation {
  const facts = new Map(intake.facts.map((fact) => [fact.key, fact]));
  const accountingResult = decimalFact(
    facts,
    'corporate.accountingResult',
    true,
  );
  const taxReintegrations = decimalFact(facts, 'corporate.taxReintegrations');
  const taxDeductions = decimalFact(facts, 'corporate.taxDeductions');
  const taxableProfitExact = plus(
    accountingResult,
    taxReintegrations,
    times(taxDeductions, -1n),
  );
  if (taxableProfitExact.n < 0n)
    throw new Error('unsupported-corporate-deficit');
  const taxableProfit = rounded(taxableProfitExact);
  const annualTurnover = decimalFact(facts, 'corporate.annualTurnover');
  const reducedRateEligible =
    valueOf(facts, 'corporate.reducedRateEligible') === true;
  const reducedRateProfit = reducedRateEligible
    ? q(taxableProfit.n > 42500n ? 42500n : taxableProfit.n)
    : q(0n);
  const normalRateProfit = minus(taxableProfit, reducedRateProfit);
  const incomeTaxExact = plus(
    times(reducedRateProfit, 15n, 100n),
    times(normalRateProfit, 25n, 100n),
  );
  const incomeTax = roundCap(incomeTaxExact);
  const taxInstallmentsExact = decimalFact(facts, 'corporate.taxInstallments');
  const balanceExact = minus(q(incomeTax), taxInstallmentsExact);
  return {
    returnKind: 'corporation',
    accountingResult,
    taxReintegrations,
    taxDeductions,
    taxableProfitExact,
    taxableProfit,
    annualTurnover,
    reducedRateEligible,
    reducedRateProfit,
    normalRateProfit,
    incomeTaxExact,
    incomeTax,
    taxInstallmentsExact,
    balanceExact,
    balance: roundCap(balanceExact),
  };
}

function salaryCalculation(
  intake: FinanceTaxIntake,
): France2025Calculation & { returnKind: 'salary' } {
  const filteredFacts = intake.facts.filter((fact) =>
    FRANCE_2025_REQUIRED_FACTS.some((required) => required.key === fact.key),
  );
  const result = runFrance2025PersonalWorkflow({
    ...intake,
    facts: filteredFacts,
  });
  if (!result.calculation) throw new Error('salary-calculation-unavailable');
  return { returnKind: 'salary', ...result.calculation };
}

function calculationFor(
  intake: FinanceTaxIntake,
  returnKind: France2025ReturnKind,
): France2025SelectedCalculation {
  if (returnKind === 'salary') return salaryCalculation(intake);
  if (returnKind === 'sole-proprietor')
    return soleProprietorCalculation(intake);
  return corporationCalculation(intake);
}

function decimalValue(value: Exact): FinanceTaxValue {
  return { type: 'decimal', value: report(value) };
}

function textValue(value: string): FinanceTaxValue {
  return { type: 'text', value };
}

function booleanValue(value: boolean): FinanceTaxValue {
  return { type: 'boolean', value };
}

function inputValue(facts: Facts, key: string): FinanceTaxValue | null {
  return facts.get(key)?.value ?? null;
}

function selectedValues(
  intake: FinanceTaxIntake,
  returnKind: France2025ReturnKind,
  calculation: France2025SelectedCalculation | null,
): Map<string, ValueRecord> {
  const facts = new Map(intake.facts.map((fact) => [fact.key, fact]));
  const values = new Map<string, ValueRecord>();
  const addFact = (key: string) => {
    const value = inputValue(facts, key);
    if (value)
      values.set(key, {
        value,
        sourceFactKeys: [key],
        dependencies: [],
      });
  };
  for (const requirement of requirementsFor(returnKind))
    addFact(requirement.key);

  // The paper forms expose family checkboxes/columns rather than the
  // normalized intake keys. Keep the derivation source-bound so those form
  // fields remain reportable even when the tax calculation is blocked.
  const familyStatus = facts.get('family.status')?.value;
  if (familyStatus?.type === 'text')
    values.set('family.C', {
      value: booleanValue(familyStatus.value === 'single'),
      sourceFactKeys: ['family.status'],
      dependencies: [],
    });
  const childCount = facts.get('family.dependentChildren')?.value;
  const raising = facts.get('family.raisingFirstChildAlone')?.value;
  const livesAlone = facts.get('family.livesAlone')?.value;
  if (
    childCount?.type === 'decimal' &&
    raising?.type === 'boolean' &&
    livesAlone?.type === 'boolean'
  ) {
    let count: Exact | null = null;
    try {
      count = exactAmount(childCount.value);
    } catch {
      // The intake assessment reports malformed numeric facts.
    }
    if (count) {
      values.set('family.F', {
        value: childCount,
        exact: count,
        sourceFactKeys: ['family.dependentChildren'],
        dependencies: [],
      });
      values.set('family.T', {
        value: booleanValue(
          count.d === 1n &&
            count.n === 1n &&
            raising.value === true &&
            livesAlone.value === true,
        ),
        sourceFactKeys: [
          'family.dependentChildren',
          'family.raisingFirstChildAlone',
          'family.livesAlone',
        ],
        dependencies: [],
      });
    }
  }

  if (returnKind === 'sole-proprietor') {
    const operatorKeys = [
      'business.operatorName',
      'business.operatorGivenNames',
      'business.operatorAddress',
      'business.siret',
    ] as const;
    const operatorValues = operatorKeys.map((key) => facts.get(key)?.value);
    if (
      operatorValues.every(
        (value): value is Extract<FinanceTaxValue, { type: 'text' }> =>
          value?.type === 'text',
      )
    )
      values.set('business.operatorIdentity', {
        value: textValue(
          operatorValues.map((value) => value.value).join(' | '),
        ),
        sourceFactKeys: [...operatorKeys],
        dependencies: [],
      });
  }
  if (!calculation) return values;
  const addExact = (
    key: string,
    value: Exact,
    sourceFactKeys: string[],
    dependencies: string[] = [],
  ) =>
    values.set(key, {
      value: decimalValue(value),
      exact: value,
      sourceFactKeys: [...new Set(sourceFactKeys)].sort(),
      dependencies,
    });
  const addInteger = (
    key: string,
    value: bigint,
    sourceFactKeys: string[],
    dependencies: string[] = [],
  ) => addExact(key, q(value), sourceFactKeys, dependencies);
  if (returnKind === 'salary') {
    const c = calculation as France2025Calculation & { returnKind: 'salary' };
    addExact('1AJ.grossSalary', c.grossSalary, ['employment.grossSalary']);
    addExact('calc.standardDeduction10', c.standardDeduction, [
      'employment.grossSalary',
      'deduction.method',
    ]);
    addExact(
      'calc.netTaxableSalary',
      c.netTaxableExact,
      ['employment.grossSalary', 'deduction.method'],
      ['calc.standardDeduction10'],
    );
    addInteger('calc.familyParts', c.parts.n / c.parts.d, [
      'family.status',
      'family.dependentChildren',
      'family.raisingFirstChildAlone',
      'family.livesAlone',
    ]);
    addExact(
      'calc.taxableIncomePerPart',
      c.taxableIncomePerPart,
      [
        'employment.grossSalary',
        'deduction.method',
        'family.dependentChildren',
      ],
      ['calc.netTaxableSalary', 'calc.familyParts'],
    );
    addExact(
      'calc.taxBeforeFamilyCap',
      c.taxBeforeFamilyCapExact,
      ['employment.grossSalary', 'family.dependentChildren'],
      ['calc.taxableIncomePerPart'],
    );
    addInteger('calc.familyQuotientCap', c.familyQuotientCap, [
      'family.dependentChildren',
      'family.raisingFirstChildAlone',
    ]);
    addInteger(
      'calc.taxAfterFamilyCap',
      c.taxAfterFamilyCap,
      ['family.dependentChildren'],
      ['calc.taxBeforeFamilyCap', 'calc.familyQuotientCap'],
    );
    addInteger(
      'calc.decote',
      c.decote,
      ['family.status'],
      ['calc.taxAfterFamilyCap'],
    );
    addInteger(
      'calc.taxAfterDecote',
      c.taxAfterDecote,
      ['family.status'],
      ['calc.taxAfterFamilyCap', 'calc.decote'],
    );
    addInteger(
      'calc.collectionThresholdTax',
      c.taxAfterCollectionThreshold,
      ['family.status'],
      ['calc.taxAfterDecote'],
    );
    addExact('8HV.pasWithheld2025', c.pasWithheldExact, [
      'pas.calendarYear',
      'pas.withheld',
    ]);
    addExact(
      'calc.balanceAfterWithholding',
      c.balanceExact,
      ['pas.withheld'],
      ['calc.collectionThresholdTax', '8HV.pasWithheld2025'],
    );
  } else if (returnKind === 'sole-proprietor') {
    const c = calculation as France2025SoleProprietorCalculation;
    addExact('5KP.microBicServicesReceipts', c.grossReceipts, [
      'business.grossReceipts',
      'business.incomeCategory',
    ]);
    addExact('5HV.microBncGrossReceipts', c.grossReceipts, [
      'business.grossReceipts',
      'business.incomeCategory',
    ]);
    addExact(
      '5HQ.microBncTaxableIncome',
      c.taxableBusinessIncome,
      ['business.grossReceipts', 'business.incomeCategory'],
      ['calc.businessTaxableIncome'],
    );
    addExact('calc.businessTaxableIncome', c.taxableBusinessIncome, [
      'business.grossReceipts',
      'business.incomeCategory',
    ]);
    addExact('calc.businessAbatement', c.abatement, [
      'business.grossReceipts',
      'business.incomeCategory',
    ]);
    addInteger('calc.familyParts', c.parts.n / c.parts.d, [
      'family.status',
      'family.dependentChildren',
      'family.raisingFirstChildAlone',
      'family.livesAlone',
    ]);
    addExact(
      'calc.taxableIncomePerPart',
      c.taxableIncomePerPart,
      [
        'business.grossReceipts',
        'business.incomeCategory',
        'family.dependentChildren',
      ],
      ['calc.businessTaxableIncome', 'calc.familyParts'],
    );
    addExact(
      'calc.taxBeforeFamilyCap',
      c.taxBeforeFamilyCapExact,
      [
        'business.grossReceipts',
        'business.incomeCategory',
        'family.dependentChildren',
      ],
      ['calc.taxableIncomePerPart'],
    );
    addInteger('calc.familyQuotientCap', c.familyQuotientCap, [
      'family.dependentChildren',
      'family.raisingFirstChildAlone',
    ]);
    addInteger(
      'calc.taxAfterFamilyCap',
      c.taxAfterFamilyCap,
      ['family.dependentChildren'],
      ['calc.taxBeforeFamilyCap', 'calc.familyQuotientCap'],
    );
    addInteger(
      'calc.decote',
      c.decote,
      ['family.status'],
      ['calc.taxAfterFamilyCap'],
    );
    addInteger(
      'calc.taxAfterDecote',
      c.taxAfterDecote,
      ['family.status'],
      ['calc.taxAfterFamilyCap', 'calc.decote'],
    );
    addInteger(
      'calc.collectionThresholdTax',
      c.taxAfterCollectionThreshold,
      ['family.status'],
      ['calc.taxAfterDecote'],
    );
    addExact('8HV.pasWithheld2025', c.pasSalaryExact, [
      'pas.calendarYear',
      'pas.withheld',
    ]);
    addExact('8HW.independentAdvance2025', c.pasAdvanceExact, [
      'pas.independentAdvance',
    ]);
    addExact(
      'calc.balanceAfterWithholding',
      c.balanceExact,
      ['pas.withheld', 'pas.independentAdvance'],
      [
        'calc.collectionThresholdTax',
        '8HV.pasWithheld2025',
        '8HW.independentAdvance2025',
      ],
    );
  } else {
    const c = calculation as France2025CorporationCalculation;
    addExact('2058-A.accountingResult', c.accountingResult, [
      'corporate.accountingResult',
    ]);
    addExact('2058-A.totalReintegrations', c.taxReintegrations, [
      'corporate.taxReintegrations',
    ]);
    addExact('2058-A.totalDeductions', c.taxDeductions, [
      'corporate.taxDeductions',
    ]);
    addExact(
      '2058-A.taxableProfit',
      c.taxableProfit,
      [
        'corporate.accountingResult',
        'corporate.taxReintegrations',
        'corporate.taxDeductions',
        'corporate.taxableProfit',
      ],
      [
        '2058-A.accountingResult',
        '2058-A.totalReintegrations',
        '2058-A.totalDeductions',
      ],
    );
    addExact(
      '2065.normalRateProfit',
      c.normalRateProfit,
      ['corporate.taxableProfit', 'corporate.reducedRateEligible'],
      ['2058-A.taxableProfit'],
    );
    addExact(
      '2065.reducedRateProfit',
      c.reducedRateProfit,
      [
        'corporate.taxableProfit',
        'corporate.reducedRateEligible',
        'corporate.annualTurnover',
        'corporate.capitalFullyPaid',
        'corporate.capitalNaturalPersonOwnership',
      ],
      ['2058-A.taxableProfit'],
    );
    addExact(
      '2065.calculatedIncomeTax',
      q(c.incomeTax),
      ['corporate.taxableProfit', 'corporate.reducedRateEligible'],
      ['2065.normalRateProfit', '2065.reducedRateProfit'],
    );
    addExact(
      '2065.balanceAfterInstallments',
      c.balanceExact,
      ['corporate.taxInstallments'],
      ['2065.calculatedIncomeTax'],
    );
  }
  return values;
}

function fieldSourceFacts(
  definition: SelectedFieldDefinition,
  value: ValueRecord | undefined,
): string[] {
  return [
    ...new Set([...(value?.sourceFactKeys ?? []), ...definition.directFacts]),
  ].sort();
}

function boolFromFacts(facts: Facts, key: string): boolean | null {
  const value = facts.get(key)?.value;
  return value?.type === 'boolean' ? value.value : null;
}

function fieldKindDecision(
  definition: SelectedFieldDefinition,
  returnKind: France2025ReturnKind,
  facts: Facts,
  values: ReadonlyMap<string, ValueRecord>,
  invalidFactKeys: ReadonlySet<string>,
): { decision: France2025SelectedFieldDecision; reason: string } {
  const value = values.get(definition.key);
  if (definition.fieldKind === 'corporate-liasse')
    return {
      decision: 'user-required',
      reason:
        'The selected aggregate tax-result facts do not replace the underlying 2050–2059-G liasse fields.',
    };
  if (definition.manual)
    return {
      decision: 'user-required',
      reason:
        'Taxpayer signature remains a manual action outside the deterministic adapter.',
    };
  if (definition.fieldKind === 'salary-zero') {
    if (definition.kind === 'sole-proprietor')
      return {
        decision: 'inapplicable',
        reason:
          'The selected sole-proprietor-only branch has no ordinary salary or excluded 2042 category.',
      };
    if (definition.key === '1AK.actualExpenses')
      return {
        decision: 'inapplicable',
        reason:
          'Standard 10% salary deduction is selected; actual professional expenses are not entered.',
      };
    return {
      decision: 'inapplicable',
      reason:
        'The reviewed zero guard excludes this income, deduction or credit category.',
    };
  }
  if (definition.fieldKind === 'corporate-zero')
    return {
      decision: 'inapplicable',
      reason:
        'The reviewed zero guard excludes this corporate schedule branch.',
    };
  if (definition.directFacts.some((key) => invalidFactKeys.has(key)))
    return {
      decision: 'unsupported',
      reason:
        'A source fact required by this field is missing, unreviewed, mistyped or outside the selected branch.',
    };
  if (definition.fieldKind === 'corporate-rate') {
    const reduced = boolFromFacts(facts, 'corporate.reducedRateEligible');
    if (definition.key === '2065.reducedRateProfit' && reduced === false)
      return {
        decision: 'inapplicable',
        reason:
          'The reviewed corporation selected the ordinary 25% rate branch.',
      };
    if (
      definition.key === '2065.normalRateProfit' &&
      reduced === true &&
      !value
    )
      return {
        decision: 'unsupported',
        reason:
          'Reduced-rate eligibility must be resolved before the normal-rate split can be reported.',
      };
  }
  if (
    definition.fieldKind === 'business' &&
    definition.key === '5KP.microBicServicesReceipts'
  ) {
    if (valueOf(facts, 'business.incomeCategory') === 'BNC')
      return {
        decision: 'inapplicable',
        reason: 'The selected sole proprietor is in the micro-BNC branch.',
      };
  }
  if (
    definition.fieldKind === 'business' &&
    definition.key === '5HV.microBncGrossReceipts'
  ) {
    if (valueOf(facts, 'business.incomeCategory') === 'BIC-services')
      return {
        decision: 'inapplicable',
        reason:
          'The selected sole proprietor is in the micro-BIC services branch.',
      };
  }
  if (
    definition.fieldKind === 'business-calculation' &&
    definition.key === '5HQ.microBncTaxableIncome'
  ) {
    if (valueOf(facts, 'business.incomeCategory') === 'BIC-services')
      return {
        decision: 'inapplicable',
        reason: 'The 5HQ net-income line is specific to the micro-BNC branch.',
      };
  }
  if (returnKind === 'corporation' && definition.kind !== 'corporation')
    return {
      decision: 'inapplicable',
      reason: 'Individual return forms do not apply to the corporation branch.',
    };
  if (returnKind !== 'corporation' && definition.kind === 'corporation')
    return {
      decision: 'inapplicable',
      reason: 'Corporate forms do not apply to the individual branch.',
    };
  if (!value)
    return {
      decision: definition.required ? 'user-required' : 'inapplicable',
      reason: definition.required
        ? 'A reviewed source fact or calculation value is required for this selected field.'
        : 'This selected field is optional and no value was supplied.',
    };
  return {
    decision: 'populated',
    reason:
      'Value is bound to reviewed intake facts and the selected deterministic rule chain.',
  };
}

function toSelectedField(
  definition: SelectedFieldDefinition,
  returnKind: France2025ReturnKind,
  facts: Facts,
  values: ReadonlyMap<string, ValueRecord>,
  invalidFactKeys: ReadonlySet<string> = new Set(),
): France2025SelectedFormField {
  const value = values.get(definition.key);
  const { decision, reason } = fieldKindDecision(
    definition,
    returnKind,
    facts,
    values,
    invalidFactKeys,
  );
  const source = authoritySource(definition.sourceId);
  const sourceFactKeys = fieldSourceFacts(definition, value);
  const exact = value?.exact ?? null;
  return {
    id: definition.id,
    formId: definition.formId,
    formVersion: definition.formVersion,
    line: definition.line,
    key: definition.key,
    label: definition.label,
    type: definition.type,
    decision,
    required: definition.required,
    reason,
    sensitive: definition.sensitive === true,
    value: decision === 'populated' ? (value?.value ?? null) : null,
    exactRational: decision === 'populated' && exact ? serialize(exact) : null,
    reportableValue:
      decision === 'populated'
        ? value?.exact
          ? report(value.exact)
          : value?.value.type === 'boolean'
            ? value.value.value
              ? 'true'
              : 'false'
            : (value?.value.value.toString() ?? null)
        : null,
    sourceId: definition.sourceId,
    documentHash: source.documentHash,
    locator: definition.locator,
    dependencies: [...(value?.dependencies ?? [])],
    sourceFactKeys,
    referenceIds: sourceReferenceIds(definition.sourceId),
    ruleIds: [...definition.ruleIds],
  };
}

function definitionsForKind(
  returnKind: France2025ReturnKind,
): readonly SelectedFieldDefinition[] {
  return FRANCE_2025_SELECTED_FIELD_CATALOG.filter(
    (definition) => definition.kind === returnKind,
  );
}

function formCoverageFor(
  fields: readonly France2025SelectedFormField[],
): France2025SelectedFormCoverage[] {
  const byForm = new Map<string, France2025SelectedFormField[]>();
  for (const field of fields) {
    const existing = byForm.get(field.formId) ?? [];
    existing.push(field);
    byForm.set(field.formId, existing);
  }
  return [...byForm.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([formId, formFields]) => ({
      formId,
      formVersion: formFields[0]!.formVersion,
      required: true,
      fieldCount: formFields.length,
      populatedCount: formFields.filter(
        (field) => field.decision === 'populated',
      ).length,
      inapplicableCount: formFields.filter(
        (field) => field.decision === 'inapplicable',
      ).length,
      userRequiredCount: formFields.filter(
        (field) => field.decision === 'user-required',
      ).length,
      unsupportedCount: formFields.filter(
        (field) => field.decision === 'unsupported',
      ).length,
      selectedFieldsComplete: formFields.every(
        (field) =>
          field.decision !== 'user-required' &&
          field.decision !== 'unsupported',
      ),
    }));
}

function evaluationFor(
  fields: readonly France2025SelectedFormField[],
  issues: readonly France2025SelectedIssue[],
): FinanceTaxEvaluation {
  const forms = new Map<string, France2025SelectedFormField[]>();
  for (const field of fields) {
    if (field.decision !== 'populated' || !field.value) continue;
    const existing = forms.get(field.formId) ?? [];
    existing.push(field);
    forms.set(field.formId, existing);
  }
  return FinanceTaxEvaluationSchema.parse({
    forms: [...forms.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, formFields]) => ({
        id,
        version: formFields[0]!.formVersion,
        fields: formFields.map((field) => ({
          key: field.key,
          value: field.value!,
          ruleIds: field.ruleIds,
          sourceFactKeys: field.sourceFactKeys,
        })),
      })),
    issues: issues.map(({ code, message }) => ({ code, message })),
  });
}

function formApplicabilityFor(
  intake: FinanceTaxIntake | null,
  returnKind: France2025ReturnKind | null,
  issues: readonly France2025SelectedIssue[],
  fields: France2025SelectedFormField[],
  inputHash: string,
  packageVersion = FRANCE_2025_SELECTED_RETURN_VERSION,
): France2025SelectedFormApplicability {
  const forms = formCoverageFor(fields);
  const unresolvedCount = fields.filter(
    (field) =>
      field.decision === 'user-required' || field.decision === 'unsupported',
  ).length;
  return deepFreeze({
    version: FRANCE_2025_SELECTED_RETURN_VERSION,
    packageVersion,
    returnKind,
    scope: returnKind
      ? { ...FRANCE_2025_SELECTED_SCOPES[returnKind] }
      : { ...(intake?.scope ?? {}) },
    inputHash,
    complete: false,
    formDataReady: unresolvedCount === 0,
    signature: { status: 'manual-unperformed', blocksCalculation: false },
    fields,
    forms,
    unresolvedCount,
    issues: [...issues],
    requiredFacts: [...requirementsFor(returnKind)],
  }) as unknown as France2025SelectedFormApplicability;
}

/** Builds a source-bound field decision for every selected form field. */
export function buildFrance2025SelectedFormApplicability(
  intake: FinanceTaxIntake,
  returnKind: France2025ReturnKind,
  calculation: France2025SelectedCalculation | null,
  issues: readonly France2025SelectedIssue[] = [],
): France2025SelectedFormApplicability {
  const values = selectedValues(intake, returnKind, calculation);
  const facts = new Map(intake.facts.map((fact) => [fact.key, fact]));
  const invalidFacts = blockingFactKeys(issues);
  const fields = definitionsForKind(returnKind).map((definition) =>
    toSelectedField(definition, returnKind, facts, values, invalidFacts),
  );
  return formApplicabilityFor(
    intake,
    returnKind,
    issues,
    fields,
    digest(intake),
    FRANCE_2025_SELECTED_RETURN_VERSION,
  );
}

/**
 * Executes the selected return branches. Values are review calculations only;
 * the return remains disabled and incomplete even when every selected field is
 * populated. No filing, payroll, persistence or external submission occurs.
 */
export function runFrance2025SelectedReturn(
  raw: unknown,
  packageVersion = FRANCE_2025_SELECTED_RETURN_VERSION,
): France2025SelectedReturnRun {
  const assessed = assessFrance2025SelectedReturnFacts(raw);
  const issues = [...assessed.issues];
  if (packageVersion !== FRANCE_2025_SELECTED_RETURN_VERSION)
    issues.push(
      issue(
        'package-version-mismatch',
        'packageVersion',
        'The selected return package version is pinned and cannot be silently replaced.',
      ),
    );
  let calculation: France2025SelectedCalculation | null = null;
  let fields: France2025SelectedFormField[] = [];
  let formCoverage: France2025SelectedFormCoverage[] = [];
  let formApplicability: France2025SelectedFormApplicability;
  if (!issues.length && assessed.intake && assessed.returnKind) {
    try {
      calculation = calculationFor(assessed.intake, assessed.returnKind);
    } catch {
      issues.push(
        issue(
          'calculation-error',
          'evaluation',
          'The selected deterministic chain could not resolve a required reviewed dependency.',
        ),
      );
      calculation = null;
    }
  }
  if (assessed.intake && assessed.returnKind) {
    const values = selectedValues(
      assessed.intake,
      assessed.returnKind,
      calculation,
    );
    const facts = new Map(
      assessed.intake.facts.map((fact) => [fact.key, fact]),
    );
    const invalidFacts = blockingFactKeys(issues);
    fields = definitionsForKind(assessed.returnKind).map((definition) =>
      toSelectedField(
        definition,
        assessed.returnKind!,
        facts,
        values,
        invalidFacts,
      ),
    );
    formCoverage = formCoverageFor(fields);
    formApplicability = formApplicabilityFor(
      assessed.intake,
      assessed.returnKind,
      issues,
      fields,
      digest(assessed.intake),
      packageVersion,
    );
  } else {
    formApplicability = deepFreeze({
      version: FRANCE_2025_SELECTED_RETURN_VERSION,
      packageVersion,
      returnKind: assessed.returnKind,
      scope: { ...(assessed.intake?.scope ?? {}) },
      inputHash: digest(assessed.intake),
      complete: false,
      formDataReady: false,
      signature: { status: 'manual-unperformed', blocksCalculation: false },
      fields: [],
      forms: [],
      unresolvedCount: 0,
      issues: [...issues],
      requiredFacts: [...requirementsFor(assessed.returnKind)],
    }) as unknown as France2025SelectedFormApplicability;
  }
  const evaluation = evaluationFor(fields, issues);
  const base = {
    schemaVersion: 1 as const,
    packageId: `${FRANCE_2025_CANDIDATE.id}-selected-return`,
    packageVersion,
    returnKind: assessed.returnKind,
    scope: assessed.returnKind
      ? { ...FRANCE_2025_SELECTED_SCOPES[assessed.returnKind] }
      : { ...(assessed.intake?.scope ?? {}) },
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
    provenance: selectedProvenance(assessed.returnKind),
    releaseBlockers: FRANCE_2025_SELECTED_RETURN_GAPS,
    reportingPolicyVersion: FRANCE_2025_REPORTING_POLICY_VERSION,
    calculation,
    fields,
    formCoverage,
    formApplicability,
    evaluation,
  };
  return deepFreeze({
    ...base,
    runHash: digest(base),
  }) as unknown as France2025SelectedReturnRun;
}

export function evaluateFrance2025SelectedReturn(
  input: Readonly<FinanceTaxIntake>,
): FinanceTaxEvaluation {
  return runFrance2025SelectedReturn(input).evaluation;
}

export type France2025ReturnExport = {
  schemaVersion: 1;
  exportVersion: 'france-2025-return-export.1';
  packageId: string;
  packageVersion: string;
  returnKind: France2025ReturnKind | null;
  scope: Record<string, unknown>;
  incomeYear: 2025;
  filingYear: 2026;
  runHash: string;
  inputHash: string;
  redactedSensitiveFields: boolean;
  sourceIds: string[];
  forms: Array<{
    formId: string;
    formVersion: string;
    fields: Array<{
      line: string;
      key: string;
      decision: France2025SelectedFieldDecision;
      value: string | null;
      sourceFactKeys: string[];
      sourceId: string;
      documentHash: string;
    }>;
  }>;
  unresolvedCount: number;
  complete: false;
  enabled: false;
  reportable: false;
};

/**
 * Deterministic JSON-ready reporting export. Identity values are redacted by
 * default; a trusted private-intake caller can opt in explicitly. The export
 * is an artifact only and does not submit or persist a declaration.
 */
export function exportFrance2025Return(
  run: France2025SelectedReturnRun,
  options: { includeSensitiveIdentity?: boolean } = {},
): France2025ReturnExport {
  const includeSensitive = options.includeSensitiveIdentity === true;
  const forms = new Map<string, France2025SelectedFormField[]>();
  for (const field of run.fields) {
    const existing = forms.get(field.formId) ?? [];
    existing.push(field);
    forms.set(field.formId, existing);
  }
  return deepFreeze({
    schemaVersion: 1,
    exportVersion: 'france-2025-return-export.1',
    packageId: run.packageId,
    packageVersion: run.packageVersion,
    returnKind: run.returnKind,
    scope: { ...run.scope },
    incomeYear: 2025,
    filingYear: 2026,
    runHash: run.runHash,
    inputHash: run.inputHash,
    redactedSensitiveFields: !includeSensitive,
    sourceIds: [...new Set(run.fields.map((field) => field.sourceId))].sort(),
    forms: [...forms.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([formId, fields]) => ({
        formId,
        formVersion: fields[0]!.formVersion,
        fields: fields
          .slice()
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((field) => ({
            line: field.line,
            key: field.key,
            decision: field.decision,
            value:
              field.sensitive && !includeSensitive
                ? null
                : field.reportableValue,
            sourceFactKeys: [...field.sourceFactKeys],
            sourceId: field.sourceId,
            documentHash: field.documentHash,
          })),
      })),
    unresolvedCount: run.formApplicability.unresolvedCount,
    complete: false,
    enabled: false,
    reportable: false,
  }) as unknown as France2025ReturnExport;
}

export function serializeFrance2025ReturnExport(
  exported: France2025ReturnExport,
): string {
  return canonical(exported);
}

/** Platform integration is intentionally deferred; these are the required seams. */
export const FRANCE_2025_PLATFORM_CONTRACT_NEEDS = deepFreeze([
  'private-identity-intake-seam-for-2042-and-2042-C-PRO-fields',
  'private-bank-details-and-manual-signature-state-seam',
  'versioned-selected-return-form-applicability-and-export-payload',
  'separate-registry-scope-bindings-for-individual-sole-proprietor-and-corporation',
  'corporate-underlying-2050-to-2059-G-accounting-fact-set-before-full-release',
] as const);

export const FRANCE_2025_SELECTED_RETURN_METADATA = deepFreeze({
  version: FRANCE_2025_SELECTED_RETURN_VERSION,
  sources: FRANCE_2025_SOURCES.map((source) => ({
    id: source.id,
    documentHash: source.documentHash,
  })),
  scopes: FRANCE_2025_SELECTED_SCOPES,
  fieldCount: FRANCE_2025_SELECTED_FIELD_CATALOG.length,
  platformContractNeeds: FRANCE_2025_PLATFORM_CONTRACT_NEEDS,
  enabled: false,
  complete: false,
  reportable: false,
});

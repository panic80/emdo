import {
  calculateMexico2025Investments,
  MEXICO_2025_INVESTMENT_REFERENCE_IDS,
} from './investments.js';
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
  minus,
  minimum,
  plus,
  positive,
  q,
  roundHalfUp,
  times,
  type Q,
} from './exact.js';
import {
  mexico2025AnnualIsr,
  mexico2025PersonalDeductionCap,
} from './tables.js';
import { MEXICO_2025_SOURCES } from './sources.js';

/** Latest SAT annual-return year fully published at the time of this capture. */
export const MEXICO_2025_LATEST_FULLY_PUBLISHED_YEAR = 2025 as const;
export const MEXICO_2025_VERSION =
  '2025.3-federal-annual-isr-working-papers' as const;
export const MX_2025_VERSION = MEXICO_2025_VERSION;

type RequiredFact = {
  key: string;
  type: 'decimal' | 'text' | 'boolean';
  equals?: string | boolean;
};

const textFact = (key: string, equals?: string): RequiredFact => ({
  key,
  type: 'text',
  ...(equals === undefined ? {} : { equals }),
});
const boolFact = (key: string, equals?: boolean): RequiredFact => ({
  key,
  type: 'boolean',
  ...(equals === undefined ? {} : { equals }),
});
const moneyFact = (key: string, equals?: string): RequiredFact => ({
  key,
  type: 'decimal',
  ...(equals === undefined ? {} : { equals }),
});

/**
 * Every exclusion is a reviewed false fact.  A missing fact never becomes a
 * zero by inference.  These gates keep this adapter on the ordinary federal
 * resident slice while the eventual country package is expanded.
 */
export const MEXICO_2025_EXCLUSIONS = deepFreeze([
  'hasForeignIncome',
  'hasForeignTaxCredit',
  'hasOtherTitleIvIncome',
  'hasRentalIncome',
  'hasInterestIncome',
  'hasDividendIncome',
  'hasSaleOrAcquisitionIncome',
  'hasPlatformIncome',
  'hasResicoIncome',
  'hasAgricultureOrLivestockIncome',
  'hasTransportElection',
  'hasCopropiedad',
  'hasSociedadConyugal',
  'hasSuccession',
  'hasPartialYear',
  'hasBankruptcyReturn',
  'hasDeathReturn',
  'hasImmigrationOrEmigration',
  'hasNonresidentPeriod',
  'hasSeparationOrRetirementPayment',
  'hasNonAccumulatingSalaryIncome',
  'hasAsimiladosIncome',
  'hasSalarySpecialExemption',
  'hasBusinessLoss',
  'hasInventoryOrCostOfGoodsSchedule',
  'hasInvestmentOrDepreciationSchedule',
  'hasEmployeeOrPayrollSchedule',
  'hasBusinessInterestSchedule',
  'hasBusinessCreditOrStimulus',
  'hasForeignPermanentEstablishment',
] as const);

const COMMON_REQUIRED_FACTS: readonly RequiredFact[] = [
  textFact('filingStatus', 'individual'),
  textFact('residency', 'full-year-domestic'),
  textFact('taxPeriod', '2025'),
  textFact('currency', 'MXN'),
  moneyFact('personalDeductions.amount'),
  boolFact('personalDeductions.proofReviewed', true),
  boolFact('personalDeductions.generalCapOnly', true),
  boolFact('personalDeductions.noUncappedCategories', true),
  boolFact('personalDeductions.excludesLocalSalaryTax', true),
  boolFact('personalDeductions.noCategorySpecificLimit', true),
  moneyFact('otherChapterIncome', '0'),
  boolFact('otherChapterIncome.reviewed', true),
  moneyFact('foreignTaxCredit', '0'),
  moneyFact('annualOtherCredits', '0'),
  boolFact('annualOtherCredits.reviewed', true),
  ...MEXICO_2025_EXCLUSIONS.map((key) => boolFact(key, false)),
];

export const MEXICO_2025_SALARIED_REQUIRED_FACTS = deepFreeze([
  ...COMMON_REQUIRED_FACTS,
  moneyFact('salary.annualIncome'),
  moneyFact('salary.exemptIncome'),
  moneyFact('salary.localIncomeTax'),
  moneyFact('salary.employmentSubsidy'),
  moneyFact('salary.isrWithheld'),
  moneyFact('salary.provisionalPayments', '0'),
  boolFact('salary.payrollCertificatesReviewed', true),
  boolFact('salary.multipleEmployersReviewed', true),
  boolFact('salary.annualIncomeAndWithholdingReconciled', true),
  boolFact('salary.localIncomeTaxRateAtMostFive', true),
  boolFact('salary.subsidyEligibilityReviewed', true),
  boolFact('salary.subsidyEligible'),
  boolFact('salary.noExcludedSubsidyIncome', true),
]);

export const MEXICO_2025_PROFESSIONAL_REQUIRED_FACTS = deepFreeze([
  ...COMMON_REQUIRED_FACTS,
  textFact('business.incomeRecognition', 'cash'),
  moneyFact('business.grossReceipts'),
  moneyFact('business.refundsDiscounts'),
  moneyFact('business.authorizedDeductions'),
  moneyFact('business.localIncomeTax'),
  moneyFact('business.ptuPaid'),
  moneyFact('business.priorLossesApplied'),
  moneyFact('business.otherAccruedIncome', '0'),
  moneyFact('business.taxStimuli', '0'),
  moneyFact('business.provisionalPayments'),
  moneyFact('business.professionalPaymentsFromLegalEntities'),
  moneyFact('business.legalEntityWithholding'),
  boolFact('business.cashAccrualReviewed', true),
  boolFact('business.deductionRequirementsReviewed', true),
  boolFact('business.ptuReviewed', true),
  boolFact('business.lossHistoryReviewed', true),
  boolFact('business.paymentsAndWithholdingsReviewed', true),
  boolFact('business.deductionsAreCompleteForOrdinaryCase', true),
  boolFact('business.vatExcluded', true),
]);

/**
 * Corporate gates are deliberately separate from the individual Title IV
 * gates above.  They describe the ordinary, full-year, standalone Régimen
 * General slice and force every other corporate regime or schedule to be
 * reviewed explicitly before a result can be emitted.
 */
export const MEXICO_2025_CORPORATE_EXCLUSIONS = deepFreeze([
  'hasExemptOrNonAccumulatingIncome',
  'hasAnnualOnlyIncome',
  'hasForeignIncome',
  'hasForeignDividendIncome',
  'hasForeignTaxCredit',
  'hasRelatedPartyTransactions',
  'hasConsolidatedGroup',
  'hasResicoRegime',
  'hasNonprofitRegime',
  'hasCooperativeRegime',
  'hasCoordinatedRegime',
  'hasAgricultureOrLivestockIncome',
  'hasMaquiladoraRegime',
  'hasForeignPermanentEstablishment',
  'hasPartialYear',
  'hasLiquidationReturn',
  'hasMergerOrSplitReturn',
  'hasInventoryOrCostOfGoodsSchedule',
  'hasEmployeeOrPayrollSchedule',
  'hasBusinessInterestSchedule',
  'hasBusinessCreditOrStimulus',
  'hasAdministrativeFacilityOrDeductibleStimulus',
  'hasDividendTaxCredit',
  'hasForeignDividendCredit',
  'hasPlanMexicoStimulus',
  'hasCompensationsOrOtherApplications',
  'hasCucaOrCufinMovements',
  'hasLowerUtilityCoefficientAuthorization',
  'hasReportableScheme',
  'hasRenewableEnergyGeneration',
] as const);

export const MEXICO_2025_INFLATION_MONTHS = deepFreeze(
  Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0')),
);
export const MEXICO_2025_INFLATION_FACTS = deepFreeze([
  ...MEXICO_2025_INFLATION_MONTHS.flatMap((month) => [
    moneyFact(`corporation.inflation.${month}.credits`),
    moneyFact(`corporation.inflation.${month}.debts`),
  ]),
  boolFact('corporation.inflation.article45And46ClassificationReviewed', true),
  boolFact('corporation.inflation.currentMonthInterestExcluded', true),
  boolFact('corporation.inflation.ordinaryDomesticBalancesOnly', true),
  boolFact('corporation.inflation.excludedFromOtherIncomeAndDeductions', true),
]);

export const MEXICO_2025_INVESTMENT_FACTS = deepFreeze([
  textFact('corporation.investments.rows'),
  boolFact(
    'corporation.investments.originalInvestmentRequirementsReviewed',
    true,
  ),
  boolFact(
    'corporation.investments.ordinaryFirstYearMaximumRateElectionReviewed',
    true,
  ),
  boolFact(
    'corporation.investments.whollyBusinessUseAndRetainedThroughYearEnd',
    true,
  ),
  boolFact('corporation.investments.excludedFromOtherDeductions', true),
]);
export const MEXICO_2025_CORPORATE_REQUIRED_FACTS = deepFreeze([
  ...MEXICO_2025_INVESTMENT_FACTS,
  ...MEXICO_2025_INFLATION_FACTS,
  textFact('filingStatus', 'corporation'),
  textFact('residency', 'full-year-domestic'),
  textFact('taxPeriod', '2025'),
  textFact('currency', 'MXN'),
  textFact('corporation.regime', 'ordinary'),
  textFact('corporation.accountingMethod', 'accrual'),
  moneyFact('corporation.accruedIncome'),
  moneyFact('corporation.refundsDiscounts'),
  moneyFact('corporation.authorizedDeductions'),
  moneyFact('corporation.ptuPaid'),
  moneyFact('corporation.priorLossesApplied'),
  moneyFact('corporation.otherFacilidadesAndStimuli', '0'),
  moneyFact('corporation.dividendTaxCredit', '0'),
  moneyFact('corporation.foreignTaxCredit', '0'),
  moneyFact('corporation.provisionalPayments'),
  moneyFact('corporation.isrWithheld'),
  moneyFact('corporation.subsidyForEmployment', '0'),
  moneyFact('corporation.compensations', '0'),
  moneyFact('corporation.otherPaymentApplications', '0'),
  boolFact('corporation.accrualAccountingReviewed', true),
  boolFact('corporation.incomeScheduleReviewed', true),
  boolFact('corporation.deductionScheduleReviewed', true),
  boolFact('corporation.deductionRequirementsReviewed', true),
  boolFact('corporation.ptuReviewed', true),
  boolFact('corporation.lossHistoryReviewed', true),
  boolFact('corporation.provisionalPaymentsReviewed', true),
  boolFact('corporation.withholdingReviewed', true),
  boolFact('corporation.employeeSubsidyReviewed', true),
  boolFact('corporation.additionalDataReviewed', true),
  boolFact('corporation.financialPositionReviewed', true),
  boolFact('corporation.inventoryPositionReviewed', true),
  boolFact('corporation.returnReconciled', true),
  ...MEXICO_2025_CORPORATE_EXCLUSIONS.map((key) => boolFact(key, false)),
]);

export const MX_2025_SALARIED_REQUIRED_FACTS =
  MEXICO_2025_SALARIED_REQUIRED_FACTS;
export const MX_2025_PROFESSIONAL_REQUIRED_FACTS =
  MEXICO_2025_PROFESSIONAL_REQUIRED_FACTS;
export const MX_2025_CORPORATE_REQUIRED_FACTS =
  MEXICO_2025_CORPORATE_REQUIRED_FACTS;
export const MEXICO_2025_REQUIRED_FACTS_BY_TAXPAYER_TYPE = deepFreeze({
  individual: MEXICO_2025_SALARIED_REQUIRED_FACTS,
  'sole-proprietor': MEXICO_2025_PROFESSIONAL_REQUIRED_FACTS,
  corporation: MEXICO_2025_CORPORATE_REQUIRED_FACTS,
});
export const MX_2025_REQUIRED_FACTS_BY_TAXPAYER_TYPE =
  MEXICO_2025_REQUIRED_FACTS_BY_TAXPAYER_TYPE;

const SALARY_SCOPE = {
  country: 'MX',
  subdivision: 'MX-FED',
  taxpayerType: 'individual' as const,
  year: 2025,
  regime: 'income-tax-return',
  formVersion: 'declaracion-anual-pf-2025-sueldos',
} as const;
const PROFESSIONAL_SCOPE = {
  country: 'MX',
  subdivision: 'MX-FED',
  taxpayerType: 'sole-proprietor' as const,
  year: 2025,
  regime: 'income-tax-return',
  formVersion: 'declaracion-anual-pf-2025-actividad-profesional',
} as const;
const CORPORATE_SCOPE = {
  country: 'MX',
  subdivision: 'MX-FED',
  taxpayerType: 'corporation' as const,
  year: 2025,
  regime: 'income-tax-return',
  formVersion: 'declaracion-anual-pm-2025-regimen-general',
} as const;
export const MEXICO_2025_SALARIED_SCOPE = deepFreeze(SALARY_SCOPE);
export const MEXICO_2025_PROFESSIONAL_SCOPE = deepFreeze(PROFESSIONAL_SCOPE);
export const MEXICO_2025_CORPORATE_SCOPE = deepFreeze(CORPORATE_SCOPE);
export const MX_2025_SALARIED_SCOPE = MEXICO_2025_SALARIED_SCOPE;
export const MX_2025_PROFESSIONAL_SCOPE = MEXICO_2025_PROFESSIONAL_SCOPE;
export const MX_2025_CORPORATE_SCOPE = MEXICO_2025_CORPORATE_SCOPE;

const salaryReferences = [
  'sat-mx-2025-declaracion-anual-personas',
  'sat-mx-2025-guia-sueldos-salarios',
  'sat-mx-anexo8-rmf-2025',
  'sat-mx-lisr-articulo-90',
  'sat-mx-lisr-articulo-93',
  'sat-mx-lisr-articulo-94',
  'sat-mx-lisr-articulo-96',
  'sat-mx-lisr-articulo-97',
  'sat-mx-lisr-articulo-151',
  'sat-mx-lisr-articulo-152',
  'sat-mx-2025-subsidio-empleo',
  'dof-mx-2025-uma',
] as const;
const professionalReferences = [
  'sat-mx-2025-declaracion-anual-personas',
  'sat-mx-2025-guia-actividad-profesional',
  'sat-mx-anexo8-rmf-2025',
  'sat-mx-lisr-articulo-90',
  'sat-mx-lisr-articulo-100',
  'sat-mx-lisr-articulo-102',
  'sat-mx-lisr-articulo-103',
  'sat-mx-lisr-articulo-105',
  'sat-mx-lisr-articulo-106',
  'sat-mx-lisr-articulo-109',
  'sat-mx-lisr-articulo-151',
  'sat-mx-lisr-articulo-152',
  'dof-mx-2025-uma',
] as const;
const corporateReferences = [
  ...MEXICO_2025_INVESTMENT_REFERENCE_IDS,
  'sat-mx-2025-declaracion-anual-empresas',
  'sat-mx-2025-guia-personas-morales-regimen-general',
  'sat-mx-lisr-articulo-9',
  'sat-mx-lisr-articulo-14',
  'sat-mx-lisr-articulo-25',
  'sat-mx-lisr-articulo-27',
  'sat-mx-lisr-articulo-44',
  'inegi-mx-inpc-december-2024',
  'inegi-mx-inpc-december-2025',
  'sat-mx-cff-articulo-17a',
  'sat-mx-lisr-articulo-76',
  'sat-mx-lisr-articulo-77',
] as const;

const commonAnnualFields = [
  'otherChapterIncome',
  'accumulatedIncome',
  'personalDeductionsClaimed',
  'personalDeductionsAllowed',
  'personalDeductionCap',
  'taxableBase',
  'isrAnnual',
  'otherCredits',
  'provisionalPayments',
  'isrWithheld',
  'credits',
  'taxDue',
  'balanceFavor',
] as const;
const salaryAnnualFields = [
  ...commonAnnualFields,
  'employmentSubsidy',
  'employmentSubsidyApplied',
] as const;
const salaryFields = [
  'annualIncome',
  'exemptIncome',
  'accumulatedIncome',
  'localIncomeTax',
  'personalDeductionsOther',
  'personalDeductionsTotal',
  'employmentSubsidy',
  'incomeTaxWithheld',
  'provisionalPayments',
] as const;
const professionalAnnualFields = [
  ...commonAnnualFields,
  'professionalPaymentsFromLegalEntities',
  'professionalWithholding',
] as const;
const professionalFields = [
  'grossReceipts',
  'refundsDiscounts',
  'netReceipts',
  'authorizedDeductions',
  'localIncomeTax',
  'fiscalUtilityBeforePtu',
  'utilityAfterPtu',
  'ptuPaid',
  'priorLossesApplied',
  'taxableUtility',
  'otherAccruedIncome',
  'taxStimuli',
  'accumulatedIncome',
] as const;
const corporateIncomeFields = [
  'averageAnnualCredits',
  'averageAnnualDebts',
  'annualInflationAdjustmentIncome',
  'accruedIncome',
  'refundsDiscounts',
  'totalAccumulatedIncome',
] as const;
const corporateDeductionFields = [
  'investmentOriginalCost',
  'investmentUnadjustedDeduction',
  'investmentDeductions',
  'authorizedDeductions',
  'annualInflationAdjustmentDeductible',
  'totalAuthorizedDeductions',
] as const;
const corporateAnnualFields = [
  'totalAccumulatedIncome',
  'totalAuthorizedDeductions',
  'otherFacilidadesAndStimuli',
  'utilityBeforePtu',
  'ptuPaid',
  'fiscalUtility',
  'priorLossesApplied',
  'fiscalResult',
  'isrCaused',
  'stimuliAppliedToTax',
  'isrExercise',
  'dividendTaxCredit',
  'foreignTaxCredit',
  'provisionalPayments',
  'isrWithheld',
  'subsidyForEmployment',
  'compensations',
  'otherPaymentApplications',
  'credits',
  'taxDue',
  'balanceFavor',
] as const;
const corporateAdditionalFields = ['cuca', 'cufin'] as const;
const paymentFields = ['taxDue', 'balanceFavor'] as const;

const refsForForm = (formId: string, professional: boolean | 'corporation') => {
  if (formId === 'SUELDOS') return salaryReferences;
  if (formId === 'PAGO')
    return [
      ...new Set([
        ...salaryReferences,
        ...professionalReferences,
        ...corporateReferences,
      ]),
    ];
  if (
    professional === 'corporation' ||
    formId.includes('MORAL') ||
    formId === 'INGRESOS_PERSONA_MORAL' ||
    formId === 'DEDUCCIONES_PERSONA_MORAL'
  )
    return corporateReferences;
  return professional ? professionalReferences : salaryReferences;
};

const ruleRows = [
  ...salaryFields.map((key) => ({
    formId: 'SUELDOS',
    key,
    professional: false,
  })),
  ...salaryAnnualFields.map((key) => ({
    formId: 'DECLARACION_ANUAL',
    key,
    professional: false,
  })),
  ...professionalAnnualFields.map((key) => ({
    formId: 'DECLARACION_ANUAL_PROFESIONAL',
    key,
    professional: true,
  })),
  ...professionalFields.map((key) => ({
    formId: 'ACTIVIDAD_PROFESIONAL',
    key,
    professional: true,
  })),
  ...corporateIncomeFields.map((key) => ({
    formId: 'INGRESOS_PERSONA_MORAL',
    key,
    professional: 'corporation' as const,
  })),
  ...corporateDeductionFields.map((key) => ({
    formId: 'DEDUCCIONES_PERSONA_MORAL',
    key,
    professional: 'corporation' as const,
  })),
  ...corporateAnnualFields.map((key) => ({
    formId: 'DECLARACION_ANUAL_MORAL',
    key,
    professional: 'corporation' as const,
  })),
  ...corporateAdditionalFields.map((key) => ({
    formId: 'DATOS_ADICIONALES_MORAL',
    key,
    professional: 'corporation' as const,
  })),
  ...paymentFields.map((key) => ({ formId: 'PAGO', key, professional: false })),
] as const;

export const MEXICO_2025_RULES = deepFreeze(
  ruleRows.map(({ formId, key, professional }) => ({
    id: `mx2025.${formId}.${key}`,
    referenceIds: refsForForm(formId, professional),
    locator: `${formId} field ${key}; 2025 annual ISR working-papers chain`,
  })),
);
export const MX_2025_RULES = MEXICO_2025_RULES;

/** Emitted working-paper forms; the source-bound field catalog adds unresolved SAT fields. */
export const MEXICO_2025_FORM_INVENTORY = deepFreeze([
  {
    id: 'SUELDOS',
    version: '2025',
    referenceIds: salaryReferences,
    fields: salaryFields,
  },
  {
    id: 'ACTIVIDAD_PROFESIONAL',
    version: '2025',
    referenceIds: professionalReferences,
    fields: professionalFields,
  },
  {
    id: 'DECLARACION_ANUAL',
    version: '2025',
    referenceIds: salaryReferences,
    fields: salaryAnnualFields,
  },
  {
    id: 'DECLARACION_ANUAL_PROFESIONAL',
    version: '2025',
    referenceIds: professionalReferences,
    fields: professionalAnnualFields,
  },
  {
    id: 'INGRESOS_PERSONA_MORAL',
    version: '2025',
    referenceIds: corporateReferences,
    fields: corporateIncomeFields,
  },
  {
    id: 'DEDUCCIONES_PERSONA_MORAL',
    version: '2025',
    referenceIds: corporateReferences,
    fields: corporateDeductionFields,
  },
  {
    id: 'DECLARACION_ANUAL_MORAL',
    version: '2025',
    referenceIds: corporateReferences,
    fields: corporateAnnualFields,
  },
  {
    id: 'DATOS_ADICIONALES_MORAL',
    version: '2025',
    referenceIds: corporateReferences,
    fields: corporateAdditionalFields,
  },
  {
    id: 'PAGO',
    version: '2025',
    referenceIds: [
      ...new Set([
        ...salaryReferences,
        ...professionalReferences,
        ...corporateReferences,
      ]),
    ],
    fields: paymentFields,
  },
] as const);
export const MX_2025_FORM_INVENTORY = MEXICO_2025_FORM_INVENTORY;

const commonReleaseBlockers = [
  'complete-applicable-form-inventory-not-validated',
  'personal-deduction-category-and-eligibility-inventory-incomplete',
  'personal-deduction-cap-source-rounding-review-required',
  'other-title-iv-income-and-credit-schedules-not-implemented',
  'federal-electronic-return-and-payment-not-implemented',
  'state-local-and-iva-payroll-not-implemented',
  'independent-complete-return-fixtures-not-validated',
] as const;

export const MEXICO_2025_SALARIED_CANDIDATE = deepFreeze({
  id: 'mx-federal-2025-salaried-individual-working-papers',
  version: MEXICO_2025_VERSION,
  enabled: false,
  registryEligible: false,
  complete: false,
  scope: SALARY_SCOPE,
  coverage:
    'Federal annual ISR working papers for a full-year domestic resident individual with ordinary salary income, reviewed payroll totals and ordinary capped personal deductions. The output is incomplete and cannot be used as a full return.',
  references: MEXICO_2025_SOURCES,
  rules: MEXICO_2025_RULES,
  forms: MEXICO_2025_FORM_INVENTORY,
  roundingPolicy: 'whole-peso-display-exact-rational-intermediates-v1',
  requiredFacts: MEXICO_2025_SALARIED_REQUIRED_FACTS,
  releaseBlockers: [
    ...commonReleaseBlockers,
    'salary-periodic-withholding-recalculation-not-implemented',
    'article-93-exemption-category-inventory-incomplete',
    'salary-nonaccumulating-and-separation-payment-schedules-not-implemented',
  ],
  eventualScope:
    'All Mexican federal individual salary and other Title IV returns',
});

export const MEXICO_2025_PROFESSIONAL_CANDIDATE = deepFreeze({
  id: 'mx-federal-2025-professional-sole-proprietor-working-papers',
  version: MEXICO_2025_VERSION,
  enabled: false,
  registryEligible: false,
  complete: false,
  scope: PROFESSIONAL_SCOPE,
  coverage:
    'Federal annual ISR working papers for a full-year domestic resident individual providing ordinary cash-basis professional services as a sole proprietor, with reviewed receipts, Article 103 deduction total, PTU, prior-loss amount, provisional payments and Article 106 legal-entity withholding. The output is incomplete and cannot be used as a full return.',
  references: MEXICO_2025_SOURCES,
  rules: MEXICO_2025_RULES,
  forms: MEXICO_2025_FORM_INVENTORY,
  roundingPolicy: 'whole-peso-display-exact-rational-intermediates-v1',
  requiredFacts: MEXICO_2025_PROFESSIONAL_REQUIRED_FACTS,
  releaseBlockers: [
    ...commonReleaseBlockers,
    'professional-investment-depreciation-schedule-not-implemented',
    'professional-loss-carryforward-history-not-implemented',
    'professional-monthly-provisional-payment-schedule-not-implemented',
    'professional-balance-sheet-and-cfdi-inventory-not-implemented',
  ],
  eventualScope:
    'All Mexican federal individual business, professional and other Title IV returns',
});

const corporateReleaseBlockers = [
  'complete-corporate-form-inventory-not-validated',
  'corporate-authorized-deduction-category-and-cfdi-inventory-incomplete',
  'corporate-cost-of-sales-and-payroll-schedules-not-implemented',
  'corporate-other-investment-classes-history-and-disposals-not-implemented',
  'corporate-inflation-credit-debt-classification-review-required',
  'corporate-loss-carryforward-history-not-implemented',
  'corporate-monthly-provisional-payment-reconstruction-not-implemented',
  'corporate-cuca-cufin-and-additional-data-not-implemented',
  'federal-electronic-return-and-payment-not-implemented',
  'independent-supported-corporate-slice-fixture-only',
] as const;

export const MEXICO_2025_CORPORATION_CANDIDATE = deepFreeze({
  id: 'mx-federal-2025-ordinary-standalone-corporation-working-papers',
  version: MEXICO_2025_VERSION,
  enabled: false,
  registryEligible: false,
  complete: false,
  scope: CORPORATE_SCOPE,
  coverage:
    'Federal annual ISR working papers for a full-year domestic standalone corporation in the ordinary Régimen General, with reviewed accumulated income, ordinary authorized-deduction aggregate, PTU, prior-loss application, provisional payments and withholding. The result is a source-bound supported slice and is incomplete until all SAT schedules and proof are covered.',
  references: MEXICO_2025_SOURCES,
  rules: MEXICO_2025_RULES,
  forms: MEXICO_2025_FORM_INVENTORY,
  roundingPolicy: 'whole-peso-display-exact-rational-intermediates-v1',
  requiredFacts: MEXICO_2025_CORPORATE_REQUIRED_FACTS,
  releaseBlockers: corporateReleaseBlockers,
  eventualScope:
    'All Mexican federal corporate income-tax returns and applicable Régimen General schedules',
});
export const MEXICO_2025_CORPORATE_CANDIDATE =
  MEXICO_2025_CORPORATION_CANDIDATE;

export const MX_2025_SALARIED_CANDIDATE = MEXICO_2025_SALARIED_CANDIDATE;
export const MX_2025_PROFESSIONAL_CANDIDATE =
  MEXICO_2025_PROFESSIONAL_CANDIDATE;
export const MX_2025_CORPORATION_CANDIDATE = MEXICO_2025_CORPORATION_CANDIDATE;
export const MX_2025_CORPORATE_CANDIDATE = MEXICO_2025_CORPORATION_CANDIDATE;
export const MEXICO_2025_CANDIDATES = deepFreeze([
  MEXICO_2025_SALARIED_CANDIDATE,
  MEXICO_2025_PROFESSIONAL_CANDIDATE,
  MEXICO_2025_CORPORATION_CANDIDATE,
] as const);
export const MX_2025_CANDIDATES = MEXICO_2025_CANDIDATES;

type Mode = 'salary' | 'professional' | 'corporation';
type Trace = {
  formId: string;
  line: string;
  exactNumerator: string;
  exactDenominator: string;
  reportedDollars: string;
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
  return JSON.stringify(value);
};
const hash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

function same(a: Q, b: Q) {
  return compare(a, b) === 0n;
}

function hasAtMostTwoDecimalPlaces(value: Q) {
  return (value.n * 100n) % value.d === 0n;
}

/** Pure evaluator. Persistence, activation, filing and payment remain outside this candidate. */
function evaluateMexico2025(input: FinanceTaxIntake, mode: Mode) {
  const candidate =
    mode === 'salary'
      ? MEXICO_2025_SALARIED_CANDIDATE
      : mode === 'professional'
        ? MEXICO_2025_PROFESSIONAL_CANDIDATE
        : MEXICO_2025_CORPORATION_CANDIDATE;
  const requiredFacts =
    mode === 'salary'
      ? MEXICO_2025_SALARIED_REQUIRED_FACTS
      : mode === 'professional'
        ? MEXICO_2025_PROFESSIONAL_REQUIRED_FACTS
        : MEXICO_2025_CORPORATE_REQUIRED_FACTS;
  const parsed = FinanceTaxIntakeSchema.safeParse(input);
  const issues: FinanceTaxEvaluation['issues'] = [];
  const forms: FinanceTaxEvaluation['forms'] = [];
  const trace: Trace[] = [];
  let investmentSchedule: ReturnType<
    typeof calculateMexico2025Investments
  >['rows'] = [];
  let investmentCalculation: ReturnType<
    typeof calculateMexico2025Investments
  > | null = null;
  const values = new Map<string, Q>();
  const origins = new Map<string, string[]>();
  const clearCalculation = () => {
    forms.length = 0;
    trace.length = 0;
    investmentSchedule = [];
    values.clear();
    origins.clear();
  };

  const finish = (intake: FinanceTaxIntake | null) => {
    const evaluation = FinanceTaxEvaluationSchema.parse({ forms, issues });
    return deepFreeze({
      candidate,
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
      investmentSchedule,
      outputHash: hash({ evaluation, trace, investmentSchedule }),
      definitionHash: hash(candidate),
    });
  };
  const issue = (code: string, message: string) =>
    issues.push({ code, message });

  if (!parsed.success) {
    issue('invalid-intake', 'Generic tax intake or source lineage is invalid.');
    return finish(null);
  }
  const intake = parsed.data;
  const expectedScope = candidate.scope;
  if (
    Object.entries(expectedScope).some(
      ([key, value]) =>
        intake.scope[key as keyof typeof expectedScope] !== value,
    ) ||
    intake.domesticResident !== true ||
    intake.hasCrossBorderActivity !== false ||
    intake.requestedFeatures.length !== 1 ||
    intake.requestedFeatures[0] !== 'income-tax-return' ||
    (mode === 'corporation'
      ? intake.standaloneCorporation !== true || intake.legalEntityId === null
      : intake.standaloneCorporation === true)
  )
    issue(
      'unsupported-scope',
      mode === 'corporation'
        ? 'Requires the exact federal Mexico 2025 ordinary domestic-resident standalone-corporation scope, a legal-entity binding and income-tax-return feature only.'
        : 'Requires the exact federal Mexico 2025 ordinary domestic-resident individual scope and income-tax-return feature only.',
    );

  const facts = new Map(intake.facts.map((fact) => [fact.key, fact]));
  const amounts = new Map<string, Q>();
  for (const required of requiredFacts) {
    const fact = facts.get(required.key);
    if (
      !fact ||
      fact.reviewState !== 'reviewed' ||
      fact.value.type !== required.type
    ) {
      issue(
        'missing-reviewed-fact',
        `Reviewed ${required.type} fact required: ${required.key}`,
      );
      continue;
    }
    if (
      'equals' in required &&
      required.equals !== undefined &&
      fact.value.value !== required.equals
    )
      issue('unsupported-fact', `Unsupported value for ${required.key}`);
    if (fact.value.type === 'decimal') {
      try {
        const amount = decimal(fact.value.value, { maxPlaces: 2 });
        if (fact.value.value.startsWith('-') || amount.n < 0n)
          issue(
            'negative-money',
            `Nonnegative MXN amount required: ${required.key}`,
          );
        amounts.set(required.key, amount);
      } catch {
        issue(
          'invalid-money',
          `MXN decimal with at most two decimal places required: ${required.key}`,
        );
      }
    }
  }
  const allowed = new Set(requiredFacts.map((fact) => fact.key));
  for (const fact of intake.facts)
    if (!allowed.has(fact.key))
      issue('unsupported-fact', `Unmapped fact: ${fact.key}`);

  if (mode === 'salary') {
    const subsidy = amounts.get('salary.employmentSubsidy');
    const eligible = facts.get('salary.subsidyEligible')?.value;
    if (
      subsidy &&
      subsidy.n > 0n &&
      (!eligible || eligible.type !== 'boolean' || eligible.value !== true)
    )
      issue(
        'unsupported-fact',
        'A positive employment subsidy requires a reviewed eligible-subsidy fact.',
      );
    const income = amounts.get('salary.annualIncome');
    const exempt = amounts.get('salary.exemptIncome');
    if (income && exempt && compare(exempt, income) > 0n)
      issue(
        'invalid-income',
        'Salary exempt income cannot exceed annual salary income.',
      );
  }
  if (mode === 'professional') {
    const professionalPayments = amounts.get(
      'business.professionalPaymentsFromLegalEntities',
    );
    const withholding = amounts.get('business.legalEntityWithholding');
    if (professionalPayments && withholding) {
      const expectedWithholding = times(professionalPayments, 10n, 100n);
      if (!hasAtMostTwoDecimalPlaces(expectedWithholding))
        issue(
          'professional-withholding-precision-unsupported',
          'The exact 10% Article 106 withholding is below cent precision for the supplied payment total; no rounding convention is assumed.',
        );
      else if (!same(expectedWithholding, withholding))
        issue(
          'professional-withholding-mismatch',
          'Article 106 requires 10% withholding on professional-service payments by legal entities without deduction.',
        );
    }
    const gross = amounts.get('business.grossReceipts');
    const refunds = amounts.get('business.refundsDiscounts');
    if (gross && refunds && compare(refunds, gross) > 0n)
      issue(
        'invalid-income',
        'Refunds and discounts cannot exceed gross receipts.',
      );
  }
  if (mode === 'corporation') {
    const accruedIncome = amounts.get('corporation.accruedIncome');
    const refunds = amounts.get('corporation.refundsDiscounts');
    if (accruedIncome && refunds && compare(refunds, accruedIncome) > 0n)
      issue(
        'invalid-income',
        'Corporate refunds and discounts cannot exceed accrued income.',
      );
  }
  if (mode === 'corporation' && !issues.length) {
    try {
      const rows = facts.get('corporation.investments.rows')!.value;
      investmentCalculation = calculateMexico2025Investments(
        String(rows.value),
      );
    } catch {
      issue(
        'unsupported-investment-schedule',
        'Reviewed JSON asset rows must satisfy the supported ordinary first-year classes, dates, positive cost and unique identifiers; use [] for no assets.',
      );
    }
  }
  if (issues.length) return finish(intake);

  const money = (key: string) => {
    const value = amounts.get(key);
    if (!value) throw new Error(`missing-money-${key}`);
    return value;
  };
  const refsFor = (formId: string) => [
    ...refsForForm(
      formId,
      mode === 'corporation' ? 'corporation' : mode === 'professional',
    ),
  ];
  const addFormField = (
    formId: string,
    key: string,
    field: FinanceTaxEvaluation['forms'][number]['fields'][number],
  ) => {
    let form = forms.find((candidateForm) => candidateForm.id === formId);
    if (!form) {
      form = { id: formId, version: '2025', fields: [] };
      forms.push(form);
    }
    form.fields.push(field);
    return `${formId}.${key}`;
  };
  const addDecimal = (
    formId: string,
    key: string,
    value: Q,
    dependsOn: string[] = [],
    directFacts: string[] = [],
  ) => {
    const graphKey = `${formId}.${key}`;
    const report = roundHalfUp(value).toString();
    const sourceFactKeys = [
      ...new Set([
        ...directFacts,
        ...dependsOn.flatMap((dependency) => origins.get(dependency) ?? []),
      ]),
    ].sort();
    addFormField(formId, key, {
      key,
      value: { type: 'decimal', value: report },
      ruleIds: [`mx2025.${graphKey}`],
      sourceFactKeys,
    });
    values.set(graphKey, value);
    origins.set(graphKey, sourceFactKeys);
    trace.push({
      formId,
      line: key,
      exactNumerator: value.n.toString(),
      exactDenominator: value.d.toString(),
      reportedDollars: report,
      dependsOn,
      sourceFactKeys,
      referenceIds: refsFor(formId),
    });
    return value;
  };
  const fromFact = (formId: string, key: string, factKey: string) =>
    addDecimal(formId, key, money(factKey), [], [factKey]);
  const put = (
    formId: string,
    key: string,
    value: Q,
    dependsOn: string[] = [],
    directFacts: string[] = [],
  ) => addDecimal(formId, key, value, dependsOn, directFacts);
  const copy = (formId: string, key: string, dependency: string) => {
    const value = values.get(dependency);
    if (!value) throw new Error(`missing-graph-dependency-${dependency}`);
    return put(formId, key, value, [dependency]);
  };

  const otherIncome =
    mode === 'corporation'
      ? q(0n)
      : fromFact(
          mode === 'salary' ? 'DECLARACION_ANUAL' : 'ACTIVIDAD_PROFESIONAL',
          mode === 'salary' ? 'otherChapterIncome' : 'otherAccruedIncome',
          mode === 'salary'
            ? 'otherChapterIncome'
            : 'business.otherAccruedIncome',
        );
  const annualForm =
    mode === 'salary'
      ? 'DECLARACION_ANUAL'
      : mode === 'professional'
        ? 'DECLARACION_ANUAL_PROFESIONAL'
        : 'DECLARACION_ANUAL_MORAL';
  let accumulatedIncome: Q;
  let totalIncomeForCap: Q;
  let personalDeductionsClaimed: Q;
  let otherCredits: Q;
  let provisionalPayments: Q;
  let isrWithheld: Q;
  let employmentSubsidy = q(0n);
  let professionalWithholding = q(0n);

  if (mode === 'salary') {
    const annualIncome = fromFact(
      'SUELDOS',
      'annualIncome',
      'salary.annualIncome',
    );
    const exemptIncome = fromFact(
      'SUELDOS',
      'exemptIncome',
      'salary.exemptIncome',
    );
    const salaryAccumulated = put(
      'SUELDOS',
      'accumulatedIncome',
      minus(annualIncome, exemptIncome),
      ['SUELDOS.annualIncome', 'SUELDOS.exemptIncome'],
    );
    const localIncomeTax = fromFact(
      'SUELDOS',
      'localIncomeTax',
      'salary.localIncomeTax',
    );
    const deductionsOther = fromFact(
      'SUELDOS',
      'personalDeductionsOther',
      'personalDeductions.amount',
    );
    personalDeductionsClaimed = put(
      'SUELDOS',
      'personalDeductionsTotal',
      plus(deductionsOther, localIncomeTax),
      ['SUELDOS.personalDeductionsOther', 'SUELDOS.localIncomeTax'],
    );
    employmentSubsidy = fromFact(
      'SUELDOS',
      'employmentSubsidy',
      'salary.employmentSubsidy',
    );
    isrWithheld = fromFact(
      'SUELDOS',
      'incomeTaxWithheld',
      'salary.isrWithheld',
    );
    provisionalPayments = fromFact(
      'SUELDOS',
      'provisionalPayments',
      'salary.provisionalPayments',
    );
    // Keep the guide's direct annual salary fields and the Article 151 VIII
    // local-tax deduction separate in the trace, then combine them exactly.
    accumulatedIncome = salaryAccumulated;
    totalIncomeForCap = plus(annualIncome, otherIncome);
    otherCredits = plus(money('foreignTaxCredit'), money('annualOtherCredits'));
  } else if (mode === 'professional') {
    const grossReceipts = fromFact(
      'ACTIVIDAD_PROFESIONAL',
      'grossReceipts',
      'business.grossReceipts',
    );
    const refunds = fromFact(
      'ACTIVIDAD_PROFESIONAL',
      'refundsDiscounts',
      'business.refundsDiscounts',
    );
    const netReceipts = put(
      'ACTIVIDAD_PROFESIONAL',
      'netReceipts',
      minus(grossReceipts, refunds),
      [
        'ACTIVIDAD_PROFESIONAL.grossReceipts',
        'ACTIVIDAD_PROFESIONAL.refundsDiscounts',
      ],
    );
    const deductions = fromFact(
      'ACTIVIDAD_PROFESIONAL',
      'authorizedDeductions',
      'business.authorizedDeductions',
    );
    const localIncomeTax = fromFact(
      'ACTIVIDAD_PROFESIONAL',
      'localIncomeTax',
      'business.localIncomeTax',
    );
    const utility = put(
      'ACTIVIDAD_PROFESIONAL',
      'fiscalUtilityBeforePtu',
      minus(minus(netReceipts, deductions), localIncomeTax),
      [
        'ACTIVIDAD_PROFESIONAL.netReceipts',
        'ACTIVIDAD_PROFESIONAL.authorizedDeductions',
        'ACTIVIDAD_PROFESIONAL.localIncomeTax',
      ],
    );
    if (utility.n < 0n) {
      issue(
        'unsupported-business-loss',
        'Business losses, current-year loss treatment and carryforwards are outside this ordinary positive-utility candidate.',
      );
      clearCalculation();
      return finish(intake);
    }
    const ptu = fromFact(
      'ACTIVIDAD_PROFESIONAL',
      'ptuPaid',
      'business.ptuPaid',
    );
    if (compare(ptu, utility) > 0n) {
      issue(
        'invalid-ptu',
        'PTU paid cannot exceed the fiscal utility in this slice.',
      );
      clearCalculation();
      return finish(intake);
    }
    const utilityAfterPtu = put(
      'ACTIVIDAD_PROFESIONAL',
      'utilityAfterPtu',
      minus(utility, ptu),
      [
        'ACTIVIDAD_PROFESIONAL.fiscalUtilityBeforePtu',
        'ACTIVIDAD_PROFESIONAL.ptuPaid',
      ],
    );
    const losses = fromFact(
      'ACTIVIDAD_PROFESIONAL',
      'priorLossesApplied',
      'business.priorLossesApplied',
    );
    if (compare(losses, utilityAfterPtu) > 0n) {
      issue(
        'invalid-loss-application',
        'Prior losses applied cannot exceed the available positive utility.',
      );
      clearCalculation();
      return finish(intake);
    }
    const taxableUtility = put(
      'ACTIVIDAD_PROFESIONAL',
      'taxableUtility',
      minus(utilityAfterPtu, losses),
      [
        'ACTIVIDAD_PROFESIONAL.utilityAfterPtu',
        'ACTIVIDAD_PROFESIONAL.priorLossesApplied',
      ],
    );
    const stimuli = fromFact(
      'ACTIVIDAD_PROFESIONAL',
      'taxStimuli',
      'business.taxStimuli',
    );
    accumulatedIncome = put(
      'ACTIVIDAD_PROFESIONAL',
      'accumulatedIncome',
      plus(taxableUtility, otherIncome),
      [
        'ACTIVIDAD_PROFESIONAL.taxableUtility',
        'ACTIVIDAD_PROFESIONAL.otherAccruedIncome',
      ],
    );
    // The guide has a separate optional stimuli module. It is explicitly zero
    // in this ordinary slice; no unreviewed credit is silently fabricated.
    if (stimuli.n !== 0n) {
      issue(
        'unsupported-fact',
        'Nonzero business tax stimuli are outside this candidate.',
      );
      clearCalculation();
      return finish(intake);
    }
    personalDeductionsClaimed = money('personalDeductions.amount');
    provisionalPayments = money('business.provisionalPayments');
    const professionalPayments = fromFact(
      annualForm,
      'professionalPaymentsFromLegalEntities',
      'business.professionalPaymentsFromLegalEntities',
    );
    professionalWithholding = addDecimal(
      annualForm,
      'professionalWithholding',
      money('business.legalEntityWithholding'),
      [],
      [
        'business.legalEntityWithholding',
        'business.professionalPaymentsFromLegalEntities',
      ],
    );
    // This is the Article 106 ten-percent credit; keeping the payment total in
    // the graph makes the withholding ratio auditable.
    void professionalPayments;
    isrWithheld = professionalWithholding;
    totalIncomeForCap = plus(grossReceipts, otherIncome);
    otherCredits = plus(money('foreignTaxCredit'), money('annualOtherCredits'));
  } else {
    const accruedIncome = fromFact(
      'INGRESOS_PERSONA_MORAL',
      'accruedIncome',
      'corporation.accruedIncome',
    );
    const refunds = fromFact(
      'INGRESOS_PERSONA_MORAL',
      'refundsDiscounts',
      'corporation.refundsDiscounts',
    );
    const creditKeys = MEXICO_2025_INFLATION_MONTHS.map(
      (month) => `corporation.inflation.${month}.credits`,
    );
    const debtKeys = MEXICO_2025_INFLATION_MONTHS.map(
      (month) => `corporation.inflation.${month}.debts`,
    );
    const reviewKeys = MEXICO_2025_INFLATION_FACTS.filter(
      (fact) => fact.type === 'boolean',
    ).map((fact) => fact.key);
    const averageCredits = put(
      'INGRESOS_PERSONA_MORAL',
      'averageAnnualCredits',
      times(plus(...creditKeys.map(money)), 1n, 12n),
      [],
      [...creditKeys, ...reviewKeys],
    );
    const averageDebts = put(
      'INGRESOS_PERSONA_MORAL',
      'averageAnnualDebts',
      times(plus(...debtKeys.map(money)), 1n, 12n),
      [],
      [...debtKeys, ...reviewKeys],
    );
    // Article 44 III: 143.042 / 137.949 - 1 = 5093 / 137949.
    // CFF 17-A: factor to ten-thousandths (0.0369 for this pinned year).
    const unroundedFactor = minus(q(143042n, 137949n), q(1n));
    const inflationFactor = q(
      (unroundedFactor.n * 10000n) / unroundedFactor.d,
      10000n,
    );
    const inflationDependencies = [
      'INGRESOS_PERSONA_MORAL.averageAnnualCredits',
      'INGRESOS_PERSONA_MORAL.averageAnnualDebts',
    ];
    const inflationIncome = put(
      'INGRESOS_PERSONA_MORAL',
      'annualInflationAdjustmentIncome',
      times(
        positive(minus(averageDebts, averageCredits)),
        inflationFactor.n,
        inflationFactor.d,
      ),
      inflationDependencies,
    );
    const inflationDeduction = put(
      'DEDUCCIONES_PERSONA_MORAL',
      'annualInflationAdjustmentDeductible',
      times(
        positive(minus(averageCredits, averageDebts)),
        inflationFactor.n,
        inflationFactor.d,
      ),
      inflationDependencies,
    );
    const totalAccumulatedIncome = put(
      'INGRESOS_PERSONA_MORAL',
      'totalAccumulatedIncome',
      plus(minus(accruedIncome, refunds), inflationIncome),
      [
        'INGRESOS_PERSONA_MORAL.accruedIncome',
        'INGRESOS_PERSONA_MORAL.refundsDiscounts',
        'INGRESOS_PERSONA_MORAL.annualInflationAdjustmentIncome',
      ],
    );
    const ordinaryDeductions = fromFact(
      'DEDUCCIONES_PERSONA_MORAL',
      'authorizedDeductions',
      'corporation.authorizedDeductions',
    );
    investmentSchedule = investmentCalculation!.rows;
    const investmentFacts = MEXICO_2025_INVESTMENT_FACTS.map(
      (fact) => fact.key,
    );
    put(
      'DEDUCCIONES_PERSONA_MORAL',
      'investmentOriginalCost',
      investmentCalculation!.originalInvestment,
      [],
      investmentFacts,
    );
    put(
      'DEDUCCIONES_PERSONA_MORAL',
      'investmentUnadjustedDeduction',
      investmentCalculation!.unadjustedDeduction,
      ['DEDUCCIONES_PERSONA_MORAL.investmentOriginalCost'],
      investmentFacts,
    );
    const investmentDeduction = put(
      'DEDUCCIONES_PERSONA_MORAL',
      'investmentDeductions',
      investmentCalculation!.adjustedDeduction,
      ['DEDUCCIONES_PERSONA_MORAL.investmentUnadjustedDeduction'],
      investmentFacts,
    );
    const deductions = put(
      'DEDUCCIONES_PERSONA_MORAL',
      'totalAuthorizedDeductions',
      plus(ordinaryDeductions, inflationDeduction, investmentDeduction),
      [
        'DEDUCCIONES_PERSONA_MORAL.authorizedDeductions',
        'DEDUCCIONES_PERSONA_MORAL.annualInflationAdjustmentDeductible',
        'DEDUCCIONES_PERSONA_MORAL.investmentDeductions',
      ],
    );
    put(
      'DECLARACION_ANUAL_MORAL',
      'totalAccumulatedIncome',
      totalAccumulatedIncome,
      ['INGRESOS_PERSONA_MORAL.totalAccumulatedIncome'],
    );
    put('DECLARACION_ANUAL_MORAL', 'totalAuthorizedDeductions', deductions, [
      'DEDUCCIONES_PERSONA_MORAL.totalAuthorizedDeductions',
    ]);
    const utilityBeforePtu = put(
      'DECLARACION_ANUAL_MORAL',
      'utilityBeforePtu',
      minus(
        minus(totalAccumulatedIncome, deductions),
        money('corporation.otherFacilidadesAndStimuli'),
      ),
      [
        'INGRESOS_PERSONA_MORAL.totalAccumulatedIncome',
        'DEDUCCIONES_PERSONA_MORAL.totalAuthorizedDeductions',
      ],
      ['corporation.otherFacilidadesAndStimuli'],
    );
    if (utilityBeforePtu.n < 0n) {
      issue(
        'unsupported-corporate-loss',
        'Corporate loss and current-year loss treatment are outside this positive-result ordinary slice.',
      );
      clearCalculation();
      return finish(intake);
    }
    const ptu = fromFact(
      'DECLARACION_ANUAL_MORAL',
      'ptuPaid',
      'corporation.ptuPaid',
    );
    if (compare(ptu, utilityBeforePtu) > 0n) {
      issue(
        'invalid-ptu',
        'Corporate PTU paid cannot exceed utility before PTU in this slice.',
      );
      clearCalculation();
      return finish(intake);
    }
    const fiscalUtility = put(
      'DECLARACION_ANUAL_MORAL',
      'fiscalUtility',
      minus(utilityBeforePtu, ptu),
      [
        'DECLARACION_ANUAL_MORAL.utilityBeforePtu',
        'DECLARACION_ANUAL_MORAL.ptuPaid',
      ],
    );
    const losses = fromFact(
      'DECLARACION_ANUAL_MORAL',
      'priorLossesApplied',
      'corporation.priorLossesApplied',
    );
    if (compare(losses, fiscalUtility) > 0n) {
      issue(
        'invalid-loss-application',
        'Corporate prior losses applied cannot exceed fiscal utility.',
      );
      clearCalculation();
      return finish(intake);
    }
    const fiscalResult = put(
      'DECLARACION_ANUAL_MORAL',
      'fiscalResult',
      minus(fiscalUtility, losses),
      [
        'DECLARACION_ANUAL_MORAL.fiscalUtility',
        'DECLARACION_ANUAL_MORAL.priorLossesApplied',
      ],
    );
    const isrCaused = put(
      'DECLARACION_ANUAL_MORAL',
      'isrCaused',
      times(fiscalResult, 30n, 100n),
      ['DECLARACION_ANUAL_MORAL.fiscalResult'],
    );
    const otherFacilidades = fromFact(
      'DECLARACION_ANUAL_MORAL',
      'otherFacilidadesAndStimuli',
      'corporation.otherFacilidadesAndStimuli',
    );
    const stimuliApplied = put(
      'DECLARACION_ANUAL_MORAL',
      'stimuliAppliedToTax',
      minimum(otherFacilidades, isrCaused),
      [
        'DECLARACION_ANUAL_MORAL.otherFacilidadesAndStimuli',
        'DECLARACION_ANUAL_MORAL.isrCaused',
      ],
    );
    const dividendTaxCredit = fromFact(
      'DECLARACION_ANUAL_MORAL',
      'dividendTaxCredit',
      'corporation.dividendTaxCredit',
    );
    const foreignTaxCredit = fromFact(
      'DECLARACION_ANUAL_MORAL',
      'foreignTaxCredit',
      'corporation.foreignTaxCredit',
    );
    const isrExercise = put(
      'DECLARACION_ANUAL_MORAL',
      'isrExercise',
      positive(
        minus(
          minus(minus(isrCaused, stimuliApplied), dividendTaxCredit),
          foreignTaxCredit,
        ),
      ),
      [
        'DECLARACION_ANUAL_MORAL.isrCaused',
        'DECLARACION_ANUAL_MORAL.stimuliAppliedToTax',
        'DECLARACION_ANUAL_MORAL.dividendTaxCredit',
        'DECLARACION_ANUAL_MORAL.foreignTaxCredit',
      ],
    );
    provisionalPayments = fromFact(
      'DECLARACION_ANUAL_MORAL',
      'provisionalPayments',
      'corporation.provisionalPayments',
    );
    isrWithheld = fromFact(
      'DECLARACION_ANUAL_MORAL',
      'isrWithheld',
      'corporation.isrWithheld',
    );
    const subsidy = fromFact(
      'DECLARACION_ANUAL_MORAL',
      'subsidyForEmployment',
      'corporation.subsidyForEmployment',
    );
    const compensations = fromFact(
      'DECLARACION_ANUAL_MORAL',
      'compensations',
      'corporation.compensations',
    );
    const otherApplications = fromFact(
      'DECLARACION_ANUAL_MORAL',
      'otherPaymentApplications',
      'corporation.otherPaymentApplications',
    );
    // Corporate payment applications are separate SAT fields. They are
    // explicit zero facts in this ordinary slice and are not inferred.
    const corporateCredits = put(
      'DECLARACION_ANUAL_MORAL',
      'credits',
      plus(
        provisionalPayments,
        isrWithheld,
        subsidy,
        compensations,
        otherApplications,
      ),
      [
        'DECLARACION_ANUAL_MORAL.provisionalPayments',
        'DECLARACION_ANUAL_MORAL.isrWithheld',
        'DECLARACION_ANUAL_MORAL.subsidyForEmployment',
        'DECLARACION_ANUAL_MORAL.compensations',
        'DECLARACION_ANUAL_MORAL.otherPaymentApplications',
      ],
    );
    put(
      'DECLARACION_ANUAL_MORAL',
      'taxDue',
      positive(minus(isrExercise, corporateCredits)),
      [
        'DECLARACION_ANUAL_MORAL.isrExercise',
        'DECLARACION_ANUAL_MORAL.credits',
      ],
    );
    put(
      'DECLARACION_ANUAL_MORAL',
      'balanceFavor',
      positive(minus(corporateCredits, isrExercise)),
      [
        'DECLARACION_ANUAL_MORAL.credits',
        'DECLARACION_ANUAL_MORAL.isrExercise',
      ],
    );
    // The guide requires CUCA/CUFIN additional-data schedules. Their detailed
    // balances are deliberately unresolved; the reviewed boolean above is a
    // coverage gate and does not fabricate an account balance.
    copy('PAGO', 'taxDue', `${annualForm}.taxDue`);
    copy('PAGO', 'balanceFavor', `${annualForm}.balanceFavor`);
    for (const blocker of candidate.releaseBlockers)
      issue(blocker, blocker.replaceAll('-', ' '));
    return finish(intake);
  }

  // Common Article 151 / 152 annual chain. Salary local income tax is already
  // included in its personal-deduction total under Article 151(VIII); business
  // local income tax was included in the Article 103 utility deduction above.
  const claimed = put(
    annualForm,
    'personalDeductionsClaimed',
    personalDeductionsClaimed,
    mode === 'salary' ? ['SUELDOS.personalDeductionsTotal'] : [],
    mode === 'salary' ? [] : ['personalDeductions.amount'],
  );
  const cap = put(
    annualForm,
    'personalDeductionCap',
    mexico2025PersonalDeductionCap(totalIncomeForCap),
    [],
    mode === 'salary'
      ? ['salary.annualIncome', 'otherChapterIncome']
      : [
          'business.grossReceipts',
          'business.otherAccruedIncome',
          'otherChapterIncome',
        ],
  );
  if (mode === 'professional')
    put(
      annualForm,
      'otherChapterIncome',
      otherIncome,
      ['ACTIVIDAD_PROFESIONAL.otherAccruedIncome'],
      ['otherChapterIncome'],
    );
  put(annualForm, 'accumulatedIncome', accumulatedIncome, [
    mode === 'salary'
      ? 'SUELDOS.accumulatedIncome'
      : 'ACTIVIDAD_PROFESIONAL.accumulatedIncome',
  ]);
  const allowedDeductions = put(
    annualForm,
    'personalDeductionsAllowed',
    minimum(claimed, cap),
    [
      `${annualForm}.personalDeductionsClaimed`,
      `${annualForm}.personalDeductionCap`,
    ],
  );
  const taxableBase = put(
    annualForm,
    'taxableBase',
    positive(minus(accumulatedIncome, allowedDeductions)),
    [
      `${annualForm}.accumulatedIncome`,
      `${annualForm}.personalDeductionsAllowed`,
    ],
  );
  const annualTaxResult = mexico2025AnnualIsr(taxableBase);
  const annualTax = put(annualForm, 'isrAnnual', annualTaxResult.tax, [
    `${annualForm}.taxableBase`,
  ]);
  if (mode === 'salary') {
    put(annualForm, 'employmentSubsidy', employmentSubsidy, [
      'SUELDOS.employmentSubsidy',
    ]);
  }
  if (mode === 'salary') {
    put(annualForm, 'isrWithheld', isrWithheld, ['SUELDOS.incomeTaxWithheld']);
  } else {
    put(annualForm, 'isrWithheld', isrWithheld, [
      `${annualForm}.professionalWithholding`,
    ]);
  }
  put(
    annualForm,
    'provisionalPayments',
    provisionalPayments,
    mode === 'salary' ? ['SUELDOS.provisionalPayments'] : [],
    mode === 'salary' ? [] : ['business.provisionalPayments'],
  );
  put(
    annualForm,
    'otherCredits',
    otherCredits,
    [],
    ['foreignTaxCredit', 'annualOtherCredits'],
  );
  const subsidyApplied = minimum(employmentSubsidy, annualTax);
  if (mode === 'salary')
    put(annualForm, 'employmentSubsidyApplied', subsidyApplied, [
      `${annualForm}.employmentSubsidy`,
      `${annualForm}.isrAnnual`,
    ]);
  const credits = put(
    annualForm,
    'credits',
    // Professional withholding is the annual isrWithheld amount in this
    // ordinary business slice; adding both names would double-count Article
    // 106's same credit.
    plus(subsidyApplied, isrWithheld, provisionalPayments, otherCredits),
    [
      `${annualForm}.isrAnnual`,
      ...(mode === 'salary' ? [`${annualForm}.employmentSubsidyApplied`] : []),
      ...(mode === 'salary'
        ? ['SUELDOS.incomeTaxWithheld']
        : [`${annualForm}.professionalWithholding`]),
      ...(mode === 'salary'
        ? ['SUELDOS.provisionalPayments']
        : [`${annualForm}.provisionalPayments`]),
      `${annualForm}.otherCredits`,
    ],
  );
  put(annualForm, 'taxDue', positive(minus(annualTax, credits)), [
    `${annualForm}.isrAnnual`,
    `${annualForm}.credits`,
  ]);
  put(annualForm, 'balanceFavor', positive(minus(credits, annualTax)), [
    `${annualForm}.credits`,
    `${annualForm}.isrAnnual`,
  ]);
  copy('PAGO', 'taxDue', `${annualForm}.taxDue`);
  copy('PAGO', 'balanceFavor', `${annualForm}.balanceFavor`);

  // Candidate outputs are always marked incomplete, even when all bounded
  // input facts are present. This blocker list is the release boundary.
  for (const blocker of candidate.releaseBlockers)
    issue(blocker, blocker.replaceAll('-', ' '));
  return finish(intake);
}

export function evaluateMexico2025SalariedIndividual(input: FinanceTaxIntake) {
  return evaluateMexico2025(input, 'salary');
}

export function evaluateMexico2025ProfessionalSoleProprietor(
  input: FinanceTaxIntake,
) {
  return evaluateMexico2025(input, 'professional');
}

export function evaluateMexico2025StandaloneCorporation(
  input: FinanceTaxIntake,
) {
  return evaluateMexico2025(input, 'corporation');
}

export const evaluateMexico2025Corporation =
  evaluateMexico2025StandaloneCorporation;

/** Dispatches the bounded salary, professional and ordinary-corporation candidates. */
export function evaluateMexico2025WorkingPapers(input: FinanceTaxIntake) {
  if (input.scope.taxpayerType === 'corporation')
    return evaluateMexico2025StandaloneCorporation(input);
  return input.scope.taxpayerType === 'sole-proprietor'
    ? evaluateMexico2025ProfessionalSoleProprietor(input)
    : evaluateMexico2025SalariedIndividual(input);
}

export const evaluateMx2025WorkingPapers = evaluateMexico2025WorkingPapers;

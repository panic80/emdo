import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  deepFreeze,
  FinanceTaxFactSchema,
  FinanceTaxIntakeSchema,
} from '@emdo/contracts';
import { decimal, q, type Q } from './exact.js';
import { reportSouthKorea2025LocalIncomeTax } from './local.js';
import { SOUTH_KOREA_2025_SOURCES } from './sources.js';
import { evaluateSouthKorea2025WorkingPapers } from './workflow.js';

/**
 * Source-bound inventory version.  The inventory uses printed NTS labels and
 * page locators rather than invented application field names.  It remains a
 * selected working-paper inventory; it is not an attestation that every NTS
 * return branch has been implemented.
 */
export const SOUTH_KOREA_2025_FORM_INVENTORY_VERSION =
  '2025-nts-form-and-attachment-inventory.1';

export type SouthKorea2025FormValueType =
  'text' | 'date' | 'boolean' | 'decimal';
export type SouthKorea2025FormFieldKind =
  | 'reviewed-input'
  | 'calculated'
  | 'guarded-inapplicable'
  | 'out-of-scope'
  | 'manual';
export type SouthKorea2025FormFieldDecision =
  | 'reviewed-input'
  | 'calculated'
  | 'inapplicable'
  | 'out-of-scope'
  | 'manual-unperformed'
  | 'unresolved';

type SourceId = (typeof SOUTH_KOREA_2025_SOURCES)[number]['id'];
type SouthKorea2025Fact = z.infer<typeof FinanceTaxFactSchema>;
type SouthKorea2025FactSource = SouthKorea2025Fact['source'];

export type SouthKorea2025FormInventoryField = {
  readonly id: string;
  readonly formId: string;
  readonly fieldPath: string;
  readonly labelKo: string;
  readonly labelEn: string;
  readonly valueType: SouthKorea2025FormValueType;
  readonly kind: SouthKorea2025FormFieldKind;
  readonly requiredForSupportedCase: boolean;
  readonly sourceId: SourceId;
  readonly locator: string;
  readonly factKey?: string;
  readonly lineKey?: string;
  readonly applicabilityFactKey?: string;
  readonly applicabilityMode?: 'zero' | 'true';
  readonly reason: string;
};

export type SouthKorea2025ActualForm = {
  readonly id: string;
  readonly titleKo: string;
  readonly titleEn: string;
  readonly version: string;
  readonly sourceId: SourceId;
  readonly locator: string;
  readonly purpose: string;
};

const yearEndSource = 'nts-kr-2025-year-end-settlement-guide' as const;
const globalSource = 'nts-kr-2025-global-income-guide' as const;
const localSource = 'nts-kr-2025-local-income-tax-guide' as const;
const globalFormSource = 'nts-kr-2025-global-form40-1' as const;
const corporateSource = 'nts-kr-2025-corporate-income-overview' as const;
const corporateFormSource = 'nts-kr-2025-corporate-form1' as const;

export const SOUTH_KOREA_2025_ACTUAL_FORMS = deepFreeze([
  {
    id: 'NTS-YEAREND-2025',
    titleKo: '근로소득 원천징수영수증(지급명세서)',
    titleEn: 'Income tax withholding receipt / salary payment statement',
    version: '소득세법 시행규칙 별지 제24호서식(1), 2025 attribution',
    sourceId: yearEndSource,
    locator:
      '2025 year-end guide pp. 237-245: actual nine-page 별지 제24호서식(1) and 작성방법',
    purpose:
      'Employer-issued annual salary statement and year-end national/local tax settlement detail',
  },
  {
    id: 'NTS-GLOBAL-40-1-2025',
    titleKo: '종합소득세·농어촌특별세 과세표준 확정신고 및 납부계산서',
    titleEn:
      'Global income tax and rural special tax assessment and payment statement',
    version: '소득세법 시행규칙 별지 제40호서식(1), 2025 attribution',
    sourceId: globalFormSource,
    locator:
      'NTS Form 40(1) publication and HWP attachment; guide pp. 60-87 describes the actual page 3, 11, 13, 15, 17, 19 and 21 sections',
    purpose:
      'General global-income return used for an ordinary sole proprietor with ledger-supported business income',
  },
  {
    id: 'NTS-GLOBAL-40-4-2025',
    titleKo:
      '종합소득세·농어촌특별세 과세표준 확정신고 및 납부계산서(단순경비율 사업자용)',
    titleEn:
      'Global income tax assessment and payment statement for simplified expense-rate filers',
    version: '소득세법 시행규칙 별지 제40호서식(4), 2025 attribution',
    sourceId: globalSource,
    locator:
      'Global-income guide pp. 88-93: actual simplified expense-rate example and Form 40(4) page/section instructions',
    purpose:
      'Actual NTS alternative form; this package records it for applicability but does not select a rate automatically',
  },
  {
    id: 'NTS-CORPORATE-1-2025',
    titleKo: '법인세 과세표준 및 세액신고서',
    titleEn: 'Corporate tax assessment and tax statement',
    version:
      '법인세법 시행규칙 별지 제1호서식, historical revision effective 2025-01-01',
    sourceId: corporateFormSource,
    locator:
      'NTS Taxlaw historical Form 1: revision effective 2025-01-01; corporate overview supplies the taxable-income and rate chain',
    purpose:
      'Standalone domestic profit-making corporation annual corporate-income-tax form',
  },
] as const satisfies readonly SouthKorea2025ActualForm[]);

const field = (
  entry: SouthKorea2025FormInventoryField,
): SouthKorea2025FormInventoryField => entry;

/**
 * Printed NTS field inventory for the selected salary graph and the bounded
 * business/corporate branches.  The fields marked out-of-scope are retained
 * so the review export can say why a full form is not complete.
 */
export const SOUTH_KOREA_2025_FORM_FIELD_CATALOG = deepFreeze([
  field({
    id: 'KR-YEAREND-2025.identity.residenceStatus',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).header.거주구분',
    labelKo: '거주구분',
    labelEn: 'Residence status',
    valueType: 'boolean',
    kind: 'reviewed-input',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 237, actual receipt header',
    factKey: 'form.resident',
    reason: 'The selected graph requires a reviewed domestic-resident branch',
  }),
  field({
    id: 'KR-YEAREND-2025.identity.taxpayerName',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득자.⑥성명',
    labelKo: '성명',
    labelEn: 'Taxpayer name',
    valueType: 'text',
    kind: 'reviewed-input',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 237, actual receipt taxpayer block',
    factKey: 'form.taxpayerName',
    reason: 'The actual receipt identifies the reviewed taxpayer',
  }),
  field({
    id: 'KR-YEAREND-2025.identity.taxpayerRegistrationNumber',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득자.⑦주민등록번호(외국인등록번호)',
    labelKo: '주민등록번호(외국인등록번호)',
    labelEn: 'Resident or foreign registration number',
    valueType: 'text',
    kind: 'reviewed-input',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 237, actual receipt taxpayer block',
    factKey: 'form.taxpayerRegistrationNumber',
    reason:
      'Identity is required to bind the receipt to the private tax subject',
  }),
  field({
    id: 'KR-YEAREND-2025.identity.taxpayerAddress',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득자.⑧주소',
    labelKo: '주소',
    labelEn: 'Taxpayer address',
    valueType: 'text',
    kind: 'reviewed-input',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 237, actual receipt taxpayer block',
    factKey: 'form.taxpayerAddress',
    reason: 'The actual receipt contains the taxpayer address',
  }),
  field({
    id: 'KR-YEAREND-2025.payer.name',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).징수의무자.①법인명(상호)',
    labelKo: '법인명(상호)',
    labelEn: 'Withholding agent name',
    valueType: 'text',
    kind: 'reviewed-input',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator:
      '2025 year-end guide p. 237, actual receipt withholding-agent block',
    factKey: 'form.withholdingAgentName',
    reason: 'The selected one-payer salary case needs the paying employer',
  }),
  field({
    id: 'KR-YEAREND-2025.payer.registrationNumber',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).징수의무자.③사업자등록번호',
    labelKo: '사업자등록번호',
    labelEn: 'Withholding agent business registration number',
    valueType: 'text',
    kind: 'reviewed-input',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator:
      '2025 year-end guide p. 237, actual receipt withholding-agent block',
    factKey: 'form.withholdingAgentRegistrationNumber',
    reason: 'The actual receipt identifies the employer source',
  }),
  field({
    id: 'KR-YEAREND-2025.employment.singlePayer',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득명세.⑨-⑩근무처별',
    labelKo: '주(현)근무지 1곳',
    labelEn: 'Exactly one current workplace row',
    valueType: 'boolean',
    kind: 'reviewed-input',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator:
      '2025 year-end guide pp. 233, 237: workplace rows and prior-employer instructions',
    factKey: 'form.singleSalaryPayer',
    reason: 'Prior-employer transfers are outside this independent salary case',
  }),
  field({
    id: 'KR-YEAREND-2025.employment.periodStart',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득명세.⑪근무기간.start',
    labelKo: '근무기간 시작일',
    labelEn: 'Employment period start',
    valueType: 'date',
    kind: 'reviewed-input',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 233: workplace-period instructions',
    factKey: 'form.employmentPeriodStart',
    reason: 'The bounded case is a full-year ordinary salary case',
  }),
  field({
    id: 'KR-YEAREND-2025.employment.periodEnd',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득명세.⑪근무기간.end',
    labelKo: '근무기간 종료일',
    labelEn: 'Employment period end',
    valueType: 'date',
    kind: 'reviewed-input',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 233: workplace-period instructions',
    factKey: 'form.employmentPeriodEnd',
    reason: 'The bounded case is a full-year ordinary salary case',
  }),
  field({
    id: 'KR-YEAREND-2025.income.salary',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득명세.⑬급여+⑭상여+...',
    labelKo: '급여·상여 등 과세 근로소득',
    labelEn: 'Taxable salary, bonus and other employment income',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator:
      '2025 year-end guide pp. 237, 233-236: workplace income detail and total',
    lineKey: 'employment.totalSalary',
    reason:
      'The receipt total is derived from reviewed annual gross less reviewed non-taxable pay',
  }),
  field({
    id: 'KR-YEAREND-2025.income.nonTaxableTotal',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).비과세소득.비과세소득계',
    labelKo: '비과세소득 계',
    labelEn: 'Total non-taxable income',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide pp. 234-236, actual non-taxable-income table',
    lineKey: 'employment.nonTaxableIncome',
    reason:
      'The actual form reports non-taxable pay separately from taxable salary',
  }),
  field({
    id: 'KR-YEAREND-2025.income.earnedIncomeDeduction',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).정산명세.근로소득공제',
    labelKo: '근로소득공제',
    labelEn: 'Earned-income deduction',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide pp. 94-95 and receipt settlement detail',
    lineKey: 'employment.earnedIncomeDeduction',
    reason: 'Article 47 deduction is calculated from total salary',
  }),
  field({
    id: 'KR-YEAREND-2025.income.earnedIncome',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).정산명세.근로소득금액',
    labelKo: '근로소득금액',
    labelEn: 'Earned-income amount',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide wage-income calculation flow',
    lineKey: 'employment.earnedIncome',
    reason: 'The earned-income amount follows the NTS salary flow',
  }),
  field({
    id: 'KR-YEAREND-2025.deduction.basicPersonal',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득공제명세.기본공제',
    labelKo: '기본공제',
    labelEn: 'Basic personal deduction',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 95 and actual income-deduction detail',
    lineKey: 'deduction.basicPersonal',
    reason: 'An already reviewed eligible-person count drives this amount',
  }),
  field({
    id: 'KR-YEAREND-2025.deduction.publicPension',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득공제명세.연금보험료공제',
    labelKo: '연금보험료공제',
    labelEn: 'Public-pension contribution deduction',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 103 and actual income-deduction detail',
    lineKey: 'deduction.nationalPension',
    reason: 'Reviewed employee public-pension contributions are deducted',
  }),
  field({
    id: 'KR-YEAREND-2025.deduction.healthInsurance',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득공제명세.건강보험료',
    labelKo: '건강보험료',
    labelEn: 'Health-insurance contribution deduction',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 103 and actual income-deduction detail',
    lineKey: 'deduction.healthInsurance',
    reason: 'Reviewed mandatory insurance contributions are deducted',
  }),
  field({
    id: 'KR-YEAREND-2025.deduction.employmentInsurance',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득공제명세.고용보험료',
    labelKo: '고용보험료',
    labelEn: 'Employment-insurance contribution deduction',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 103 and actual income-deduction detail',
    lineKey: 'deduction.employmentInsurance',
    reason: 'Reviewed mandatory insurance contributions are deducted',
  }),
  field({
    id: 'KR-YEAREND-2025.deduction.longTermCareInsurance',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득공제명세.장기요양보험료',
    labelKo: '장기요양보험료',
    labelEn: 'Long-term-care insurance contribution deduction',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 103 and actual income-deduction detail',
    lineKey: 'deduction.longTermCareInsurance',
    reason: 'Reviewed mandatory insurance contributions are deducted',
  }),
  field({
    id: 'KR-YEAREND-2025.tax.taxBase',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).정산명세.과세표준',
    labelKo: '과세표준',
    labelEn: 'Income-tax base',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 8 and salary calculation flow',
    lineKey: 'tax.taxBase',
    reason: 'The actual settlement detail reports the national income-tax base',
  }),
  field({
    id: 'KR-YEAREND-2025.tax.calculatedTax',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).정산명세.산출세액',
    labelKo: '산출세액',
    labelEn: 'Calculated national income tax',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide pp. 17-18 and salary calculation flow',
    lineKey: 'tax.calculatedTax',
    reason: 'The 2025 progressive rates are applied to the tax base',
  }),
  field({
    id: 'KR-YEAREND-2025.credit.earnedIncomeTaxCredit',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).세액공제명세.근로소득세액공제',
    labelKo: '근로소득세액공제',
    labelEn: 'Earned-income tax credit',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide pp. 161-162 and actual settlement detail',
    lineKey: 'credit.earnedIncomeTaxCredit',
    reason: 'Article 59 credit and salary cap are calculated exactly',
  }),
  field({
    id: 'KR-YEAREND-2025.credit.standardTaxCredit',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).세액공제명세.표준세액공제',
    labelKo: '표준세액공제',
    labelEn: 'Standard tax credit',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 14 and actual settlement detail',
    lineKey: 'credit.standardTaxCredit',
    reason:
      'The standard credit is selected only when special deductions/credits are absent',
  }),
  field({
    id: 'KR-YEAREND-2025.tax.determinedTax',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).세액명세.결정세액.소득세',
    labelKo: '결정세액(소득세)',
    labelEn: 'Determined national income tax',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 237 and receipt settlement detail',
    lineKey: 'tax.determinedTax',
    reason: 'The actual receipt reports the determined national income tax',
  }),
  field({
    id: 'KR-YEAREND-2025.tax.localIncomeTax',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).세액명세.결정세액.지방소득세',
    labelKo: '결정세액(지방소득세)',
    labelEn: 'Determined local income tax',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: true,
    sourceId: localSource,
    locator:
      '2025 year-end guide p. 237 actual receipt; NTS local-income-tax overview',
    lineKey: 'tax.localIncomeTax',
    reason: 'NTS states that individual local income tax is 10% of income tax',
  }),
  field({
    id: 'KR-YEAREND-2025.tax.withheldIncomeTax',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).세액명세.기납부세액.주(현)근무지',
    labelKo: '기납부세액(소득세)',
    labelEn: 'Income tax withheld at the current workplace',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide pp. 236-237, receipt withholding detail',
    lineKey: 'withholding.incomeTax',
    reason: 'The reviewed withholding total is carried to the actual receipt',
  }),
  field({
    id: 'KR-YEAREND-2025.tax.balanceDueOrRefund',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).세액명세.차감징수세액',
    labelKo: '차감징수세액',
    labelEn: 'Settlement balance due or refund',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 237 and form-writing instruction 15',
    lineKey: 'settlement.balanceDueOrRefund',
    reason:
      'The NTS under-KRW-1,000 presentation rule is applied only at report boundary',
  }),
  field({
    id: 'KR-YEAREND-2025.input.otherDeductions',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득공제명세.그밖의소득공제',
    labelKo: '그 밖의 소득공제',
    labelEn: 'Other income deductions',
    valueType: 'decimal',
    kind: 'guarded-inapplicable',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide pp. 120-147 and actual deduction detail',
    factKey: 'deduction.otherIncomeDeductions',
    applicabilityFactKey: 'deduction.otherIncomeDeductions',
    applicabilityMode: 'zero',
    reason:
      'The selected salary case requires an explicit reviewed zero for unsupported deductions',
  }),
  field({
    id: 'KR-YEAREND-2025.input.otherTaxCredits',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).세액공제명세.그밖의세액공제',
    labelKo: '그 밖의 세액공제',
    labelEn: 'Other tax credits',
    valueType: 'decimal',
    kind: 'guarded-inapplicable',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide pp. 148-210 and actual credit detail',
    factKey: 'credit.otherTaxCredits',
    applicabilityFactKey: 'credit.otherTaxCredits',
    applicabilityMode: 'zero',
    reason:
      'The selected salary case requires an explicit reviewed zero for unsupported credits',
  }),
  field({
    id: 'KR-YEAREND-2025.input.monthlyRentCredit',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).세액공제명세.월세액세액공제',
    labelKo: '월세액 세액공제',
    labelEn: 'Monthly-rent tax credit',
    valueType: 'decimal',
    kind: 'guarded-inapplicable',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide pp. 202-204 and rent-detail schedule',
    factKey: 'credit.monthlyRentTaxCredit',
    applicabilityFactKey: 'credit.monthlyRentTaxCredit',
    applicabilityMode: 'zero',
    reason:
      'The selected salary case requires an explicit reviewed zero for the rent branch',
  }),
  field({
    id: 'KR-YEAREND-2025.input.taxReduction',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).비과세및감면소득.감면소득계',
    labelKo: '감면소득 계 / 감면세액',
    labelEn: 'Income-tax reduction or exemption',
    valueType: 'decimal',
    kind: 'guarded-inapplicable',
    requiredForSupportedCase: true,
    sourceId: yearEndSource,
    locator: '2025 year-end guide pp. 148-162 and actual reduction detail',
    factKey: 'credit.incomeTaxReduction',
    applicabilityFactKey: 'credit.incomeTaxReduction',
    applicabilityMode: 'zero',
    reason: 'The selected salary case requires an explicit no-reduction guard',
  }),
  field({
    id: 'KR-YEAREND-2025.manual.taxpayerSignature',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).서명',
    labelKo: '징수(보고)의무자 서명 또는 인',
    labelEn: 'Withholding agent signature or seal',
    valueType: 'boolean',
    kind: 'manual',
    requiredForSupportedCase: false,
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 237 actual receipt signature block',
    reason:
      'Signature is a taxpayer/employer action outside deterministic calculation',
  }),
  field({
    id: 'KR-GLOBAL-40-1-2025.businessIncome',
    formId: 'NTS-GLOBAL-40-1-2025',
    fieldPath: '별지40호서식(1).11-13.사업소득명세',
    labelKo: '사업소득명세',
    labelEn: 'Business income statement',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: false,
    sourceId: globalFormSource,
    locator:
      'Global-income guide pp. 60-63 and Form 40(1) business-income statement',
    lineKey: 'business.netIncome',
    reason:
      'The ordinary sole-proprietor branch maps net ledger business income to Form 40(1)',
  }),
  field({
    id: 'KR-GLOBAL-40-1-2025.globalIncome',
    formId: 'NTS-GLOBAL-40-1-2025',
    fieldPath: '별지40호서식(1).3.⑬종합소득금액',
    labelKo: '종합소득금액',
    labelEn: 'Global income amount',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: false,
    sourceId: globalSource,
    locator: 'Global-income guide pp. 16-18 and pp. 90-92 example',
    lineKey: 'business.globalIncome',
    reason: 'The selected sole-proprietor branch has business income only',
  }),
  field({
    id: 'KR-GLOBAL-40-1-2025.taxBase',
    formId: 'NTS-GLOBAL-40-1-2025',
    fieldPath: '별지40호서식(1).3.⑮종합소득과세표준',
    labelKo: '종합소득 과세표준',
    labelEn: 'Global income tax base',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: false,
    sourceId: globalSource,
    locator: 'Global-income guide pp. 16-18 and Form 40(1) computation section',
    lineKey: 'business.taxBase',
    reason:
      'The progressive national income-tax base is calculated after supported deductions',
  }),
  field({
    id: 'KR-GLOBAL-40-1-2025.determinedTax',
    formId: 'NTS-GLOBAL-40-1-2025',
    fieldPath: '별지40호서식(1).3.결정세액',
    labelKo: '결정세액',
    labelEn: 'Determined income tax',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: false,
    sourceId: globalSource,
    locator: 'Global-income guide pp. 16-18 and pp. 90-93 example',
    lineKey: 'business.determinedTax',
    reason:
      'The business branch reports national determined tax after standard credit',
  }),
  field({
    id: 'KR-GLOBAL-40-1-2025.localIncomeTax',
    formId: 'NTS-GLOBAL-40-1-2025',
    fieldPath: '지방세법.별지40의2.결정세액',
    labelKo: '개인지방소득세 결정세액',
    labelEn: 'Determined individual local income tax',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: false,
    sourceId: localSource,
    locator:
      'NTS local-income-tax overview: individual local income tax is 10% of income tax',
    lineKey: 'business.localIncomeTax',
    reason: 'The local tax helper applies the NTS 10% rule',
  }),
  field({
    id: 'KR-CORPORATE-1-2025.accountingProfit',
    formId: 'NTS-CORPORATE-1-2025',
    fieldPath: '별지제1호서식.재무제표.당기순손익',
    labelKo: '당기순손익',
    labelEn: 'Net profit or loss for the period',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: false,
    sourceId: corporateSource,
    locator:
      'NTS corporation guide formula: financial statements begin with current-period net profit or loss',
    lineKey: 'corporate.accountingProfit',
    reason:
      'The standalone corporation branch starts from reviewed ordinary revenue less expenses',
  }),
  field({
    id: 'KR-CORPORATE-1-2025.taxBase',
    formId: 'NTS-CORPORATE-1-2025',
    fieldPath: '별지제1호서식.법인세과세표준및세액조정계산서.과세표준',
    labelKo: '법인세 과세표준',
    labelEn: 'Corporate income-tax base',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: false,
    sourceId: corporateSource,
    locator:
      'NTS corporation guide: taxable base = net profit/loss ± tax adjustments − carried-forward losses − non-taxable income − income deductions',
    lineKey: 'corporate.taxBase',
    reason:
      'The bounded corporation branch explicitly reviews all omitted bridge inputs as zero',
  }),
  field({
    id: 'KR-CORPORATE-1-2025.calculatedTax',
    formId: 'NTS-CORPORATE-1-2025',
    fieldPath: '별지제1호서식.법인세과세표준및세액조정계산서.산출세액',
    labelKo: '법인세 산출세액',
    labelEn: 'Calculated corporate income tax',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: false,
    sourceId: corporateSource,
    locator: 'NTS corporation guide: 2025 rates 9%, 19%, 21%, 24%',
    lineKey: 'corporate.calculatedTax',
    reason: 'The published progressive corporate rates are applied exactly',
  }),
  field({
    id: 'KR-CORPORATE-1-2025.determinedTax',
    formId: 'NTS-CORPORATE-1-2025',
    fieldPath: '별지제1호서식.법인세과세표준및세액조정계산서.차감납부세액',
    labelKo: '차감납부할 법인세액',
    labelEn: 'Corporate tax payable after prepaid tax',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: false,
    sourceId: corporateSource,
    locator:
      'NTS corporation guide: payable = calculated tax − credits/reductions + penalties/additional tax − prepaid tax',
    lineKey: 'corporate.balanceDueOrRefund',
    reason:
      'The bounded branch supports only zero credits, penalties and prepaid tax',
  }),
  field({
    id: 'KR-CORPORATE-1-2025.localIncomeTax',
    formId: 'NTS-CORPORATE-1-2025',
    fieldPath: '지방세법.법인지방소득세.결정세액',
    labelKo: '법인지방소득세',
    labelEn: 'Corporate local income tax',
    valueType: 'decimal',
    kind: 'calculated',
    requiredForSupportedCase: false,
    sourceId: localSource,
    locator:
      'NTS withholding overview: corporate local income tax is 10% of corporate income tax',
    lineKey: 'corporate.localIncomeTax',
    reason: 'The local tax helper applies the NTS 10% rule',
  }),
  field({
    id: 'KR-GLOBAL-40-4-2025.simplifiedRate',
    formId: 'NTS-GLOBAL-40-4-2025',
    fieldPath: '별지40호서식(4).사업소득명세.단순경비율',
    labelKo: '단순경비율',
    labelEn: 'Simplified expense rate',
    valueType: 'decimal',
    kind: 'out-of-scope',
    requiredForSupportedCase: false,
    sourceId: globalSource,
    locator:
      'Global-income guide pp. 48-55 and pp. 88-93 simplified expense-rate example',
    reason:
      'The ordinary sole-proprietor branch uses reviewed ledger expenses and never infers an industry rate',
  }),
  field({
    id: 'KR-YEAREND-2025.outOfScope.specialDeductionSchedules',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).각종소득공제명세서및별지',
    labelKo: '특별소득공제·세액공제·감면 상세명세',
    labelEn: 'Special deductions, credits and relief schedules',
    valueType: 'decimal',
    kind: 'out-of-scope',
    requiredForSupportedCase: false,
    sourceId: yearEndSource,
    locator: '2025 year-end guide pp. 120-210 and attachments pp. 394 onward',
    reason:
      'The catalog records the actual area but the complete eligibility and attachment tree is not implemented',
  }),
  field({
    id: 'KR-GLOBAL-40-1-2025.outOfScope.combinedIncome',
    formId: 'NTS-GLOBAL-40-1-2025',
    fieldPath: '별지40호서식(1).11-21.다른소득및결손금',
    labelKo: '근로·이자·배당·연금·기타 및 결손금·이월결손금',
    labelEn: 'Combined income and loss schedules',
    valueType: 'decimal',
    kind: 'out-of-scope',
    requiredForSupportedCase: false,
    sourceId: globalSource,
    locator: 'Global-income guide pp. 16-18 and pp. 60-87 form instructions',
    reason:
      'Only a single ordinary income stream is supported per selected branch',
  }),
  field({
    id: 'KR-CORPORATE-1-2025.outOfScope.taxAdjustments',
    formId: 'NTS-CORPORATE-1-2025',
    fieldPath: '별지제3호서식.세무조정및이월결손금',
    labelKo: '세무조정·이월결손금·비과세·소득공제',
    labelEn: 'Tax adjustments, losses, non-taxable income and deductions',
    valueType: 'decimal',
    kind: 'out-of-scope',
    requiredForSupportedCase: false,
    sourceId: corporateSource,
    locator:
      'NTS corporation guide taxable-income bridge and associated Form 3 schedules',
    reason:
      'The standalone corporation branch requires these reviewed as zero and does not implement nonzero schedules',
  }),
] as const satisfies readonly SouthKorea2025FormInventoryField[]);

export type SouthKorea2025AttachmentApplicability =
  | { readonly mode: 'always' }
  | { readonly mode: 'when-nonzero'; readonly factKey: string }
  | { readonly mode: 'when-true'; readonly factKey: string }
  | { readonly mode: 'never-in-slice'; readonly reason: string };

export type SouthKorea2025AttachmentInventoryEntry = {
  readonly id: string;
  readonly formId: string;
  readonly titleKo: string;
  readonly titleEn: string;
  readonly sourceId: SourceId;
  readonly locator: string;
  readonly applicability: SouthKorea2025AttachmentApplicability;
  readonly requiredForSupportedCase: boolean;
  readonly reason: string;
};

export const SOUTH_KOREA_2025_ATTACHMENT_INVENTORY = deepFreeze([
  {
    id: 'attachment.salary-withholding-receipt',
    formId: 'NTS-YEAREND-2025',
    titleKo: '근로소득 원천징수영수증',
    titleEn: 'Salary income withholding receipt',
    sourceId: yearEndSource,
    locator: '2025 year-end guide pp. 237-245, actual 별지 제24호서식(1)',
    applicability: { mode: 'always' },
    requiredForSupportedCase: true,
    reason:
      'The independent salary case requires one reviewed employer receipt',
  },
  {
    id: 'attachment.salary-income-deduction-declaration',
    formId: 'NTS-YEAREND-2025',
    titleKo: '근로소득자 소득·세액공제신고서',
    titleEn: 'Employee income and tax deduction declaration',
    sourceId: yearEndSource,
    locator:
      '2025 year-end guide contents and pp. 394 onward attachment checklist',
    applicability: { mode: 'always' },
    requiredForSupportedCase: true,
    reason:
      'The employee declaration is the source of the reviewed deduction branch and explicit zero choices',
  },
  {
    id: 'attachment.public-pension-contribution-evidence',
    formId: 'NTS-YEAREND-2025',
    titleKo: '연금보험료 납입 확인자료',
    titleEn: 'Public-pension contribution evidence',
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 103 and actual deduction statement',
    applicability: {
      mode: 'when-nonzero',
      factKey: 'deduction.nationalPensionContribution',
    },
    requiredForSupportedCase: false,
    reason: 'Required when a nonzero public-pension deduction is claimed',
  },
  {
    id: 'attachment.mandatory-insurance-contribution-evidence',
    formId: 'NTS-YEAREND-2025',
    titleKo: '건강보험료·고용보험료·장기요양보험료 자료',
    titleEn: 'Mandatory insurance contribution evidence',
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 103 and actual deduction statement',
    applicability: {
      mode: 'when-nonzero',
      factKey: 'deduction.specialInsurance',
    },
    requiredForSupportedCase: false,
    reason: 'Required when any special insurance deduction is nonzero',
  },
  {
    id: 'attachment.previous-employer-withholding-receipt',
    formId: 'NTS-YEAREND-2025',
    titleKo: '종(전)근무지 근로소득 원천징수영수증',
    titleEn: 'Previous-employer salary withholding receipt',
    sourceId: yearEndSource,
    locator:
      '2025 year-end guide pp. 233, 236 and actual receipt prior-employer columns',
    applicability: {
      mode: 'when-true',
      factKey: 'form.multipleSalaryPayers',
    },
    requiredForSupportedCase: false,
    reason:
      'Explicitly outside the independent one-payer fixture; a true value blocks that case',
  },
  {
    id: 'attachment.medical-expense-statement',
    formId: 'NTS-YEAREND-2025',
    titleKo: '의료비 지급명세서 및 증명자료',
    titleEn: 'Medical-expense statement and proof',
    sourceId: yearEndSource,
    locator: '2025 year-end guide pp. 148-160 and p. 394 attachment checklist',
    applicability: {
      mode: 'never-in-slice',
      reason: 'Medical deduction is outside this bounded salary graph',
    },
    requiredForSupportedCase: false,
    reason:
      'The full medical eligibility and submitted statement are not implemented',
  },
  {
    id: 'attachment.donation-statement',
    formId: 'NTS-YEAREND-2025',
    titleKo: '기부금명세서',
    titleEn: 'Donation statement',
    sourceId: yearEndSource,
    locator:
      '2025 year-end guide contents and pp. 229-232, 394 attachment checklist',
    applicability: {
      mode: 'never-in-slice',
      reason:
        'Donation credits and carryforwards are outside this bounded graph',
    },
    requiredForSupportedCase: false,
    reason:
      'The full donation category, carryforward and statement tree is not implemented',
  },
  {
    id: 'attachment.rent-and-housing-schedule',
    formId: 'NTS-YEAREND-2025',
    titleKo: '월세액·주택임차차입금 명세서',
    titleEn: 'Rent and housing-loan schedule',
    sourceId: yearEndSource,
    locator: '2025 year-end guide p. 237 and p. 394 attachment checklist',
    applicability: {
      mode: 'never-in-slice',
      reason: 'Housing deductions are outside this bounded graph',
    },
    requiredForSupportedCase: false,
    reason: 'The housing eligibility and attachment tree is not implemented',
  },
  {
    id: 'attachment.business-financial-statements',
    formId: 'NTS-GLOBAL-40-1-2025',
    titleKo: '재무제표·조정계산서 및 사업증빙',
    titleEn: 'Financial statements, tax adjustment and business proof',
    sourceId: globalSource,
    locator:
      'Global-income guide p. 15: business income requires financial statement, balance sheet, trial balance, attachments and tax adjustment statement',
    applicability: {
      mode: 'when-true',
      factKey: 'case.soleProprietor',
    },
    requiredForSupportedCase: false,
    reason:
      'Ordinary sole-proprietor review requires these artifacts; payroll and filing remain outside',
  },
  {
    id: 'attachment.corporate-financial-statements',
    formId: 'NTS-CORPORATE-1-2025',
    titleKo: '법인 재무제표·세무조정계산서',
    titleEn: 'Corporate financial statements and tax adjustment statement',
    sourceId: corporateSource,
    locator:
      'NTS corporation guide: financial statements and taxable-income bridge',
    applicability: {
      mode: 'when-true',
      factKey: 'case.standaloneCorporation',
    },
    requiredForSupportedCase: false,
    reason:
      'Standalone corporation review requires these artifacts; filing and submission remain outside',
  },
  {
    id: 'attachment.corporate-local-tax-return',
    formId: 'NTS-CORPORATE-1-2025',
    titleKo: '법인지방소득세 신고서',
    titleEn: 'Corporate local income-tax return',
    sourceId: localSource,
    locator: 'NTS local-income-tax overview and local filing channel',
    applicability: {
      mode: 'when-true',
      factKey: 'case.standaloneCorporation',
    },
    requiredForSupportedCase: false,
    reason:
      'Local filing artifact is inventory-only and no filing authorization is produced',
  },
] as const satisfies readonly SouthKorea2025AttachmentInventoryEntry[]);

export type SouthKorea2025RequiredFormFact = {
  readonly key: string;
  readonly type: SouthKorea2025FormValueType;
  readonly formId: string;
  readonly fieldPath: string;
  readonly label: string;
  readonly sourceId: SourceId;
};

export const SOUTH_KOREA_2025_REQUIRED_FORM_FACTS = deepFreeze([
  {
    key: 'form.resident',
    type: 'boolean',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).header.거주구분',
    label: 'Reviewed resident selection',
    sourceId: yearEndSource,
  },
  {
    key: 'form.taxpayerName',
    type: 'text',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득자.⑥성명',
    label: 'Taxpayer name',
    sourceId: yearEndSource,
  },
  {
    key: 'form.taxpayerRegistrationNumber',
    type: 'text',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득자.⑦주민등록번호(외국인등록번호)',
    label: 'Taxpayer registration number',
    sourceId: yearEndSource,
  },
  {
    key: 'form.taxpayerAddress',
    type: 'text',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득자.⑧주소',
    label: 'Taxpayer address',
    sourceId: yearEndSource,
  },
  {
    key: 'form.withholdingAgentName',
    type: 'text',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).징수의무자.①법인명(상호)',
    label: 'Withholding agent name',
    sourceId: yearEndSource,
  },
  {
    key: 'form.withholdingAgentRegistrationNumber',
    type: 'text',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).징수의무자.③사업자등록번호',
    label: 'Withholding agent registration number',
    sourceId: yearEndSource,
  },
  {
    key: 'form.singleSalaryPayer',
    type: 'boolean',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득명세.주(현)근무지',
    label: 'Exactly one salary payer',
    sourceId: yearEndSource,
  },
  {
    key: 'form.employmentPeriodStart',
    type: 'date',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득명세.⑪근무기간.start',
    label: 'Employment period start',
    sourceId: yearEndSource,
  },
  {
    key: 'form.employmentPeriodEnd',
    type: 'date',
    formId: 'NTS-YEAREND-2025',
    fieldPath: '별지24호서식(1).소득명세.⑪근무기간.end',
    label: 'Employment period end',
    sourceId: yearEndSource,
  },
] as const satisfies readonly SouthKorea2025RequiredFormFact[]);

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const ReviewText = z.string().trim().min(1).max(2000);
const FormReviewAttachmentSchema = z.strictObject({
  artifactId: z.uuid(),
  attachmentId: z.string().trim().min(1).max(160),
  formId: z.string().trim().min(1).max(160),
  authoritySourceId: z.string().trim().min(1).max(160),
  authorityDocumentHash: Hash,
  contentHash: Hash,
  bytes: z.instanceof(Uint8Array),
  reviewedBy: ReviewText,
  reviewedAt: z.iso.datetime(),
});
export type SouthKorea2025FormReviewAttachment = z.infer<
  typeof FormReviewAttachmentSchema
>;

export const SouthKorea2025FormReviewInputSchema = z.strictObject({
  intake: FinanceTaxIntakeSchema,
  /** Actual form identity/period facts; arithmetic facts remain in intake. */
  formFacts: z.array(FinanceTaxFactSchema).max(100),
  attachments: z.array(FormReviewAttachmentSchema).max(100),
});
export type SouthKorea2025FormReviewInput = z.infer<
  typeof SouthKorea2025FormReviewInputSchema
>;

type ReviewIssue = { code: string; path: string; message: string };

type EvaluatedField = {
  readonly id: string;
  readonly formId: string;
  readonly fieldPath: string;
  readonly labelKo: string;
  readonly labelEn: string;
  readonly kind: SouthKorea2025FormFieldKind;
  readonly requiredForSupportedCase: boolean;
  readonly sourceId: string;
  readonly authorityDocumentHash: string;
  readonly factKey: string | null;
  readonly lineKey: string | null;
  readonly value: string | boolean | null;
  readonly decision: SouthKorea2025FormFieldDecision;
  readonly reason: string;
  readonly sourceBinding: SouthKorea2025FactSource | null;
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

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function sourceHash(id: string): string {
  const source = SOUTH_KOREA_2025_SOURCES.find(
    (candidate) => candidate.id === id,
  );
  if (!source) throw new Error(`missing-south-korea-source:${id}`);
  return source.documentHash;
}

function valueForFact(
  fact: SouthKorea2025Fact | undefined,
): string | boolean | null {
  return fact?.value.value ?? null;
}

function validFormFact(
  fact: SouthKorea2025Fact | undefined,
  requirement: SouthKorea2025RequiredFormFact,
): boolean {
  if (!fact || fact.reviewState !== 'reviewed') return false;
  if (fact.value.type !== requirement.type) return false;
  switch (requirement.type) {
    case 'text':
      return fact.value.type === 'text' && fact.value.value.trim().length > 0;
    case 'boolean':
      return fact.value.type === 'boolean' && fact.value.value === true;
    case 'date':
      return (
        fact.value.type === 'date' &&
        fact.value.value ===
          (requirement.key === 'form.employmentPeriodStart'
            ? '2025-01-01'
            : '2025-12-31')
      );
    case 'decimal':
      return fact.value.type === 'decimal';
  }
}

function exactLine(
  evaluation: ReturnType<typeof evaluateSouthKorea2025WorkingPapers>,
  key: string,
): Q | null {
  const line = evaluation.trace.find((entry) => entry.key === key);
  return line
    ? q(BigInt(line.exactNumerator), BigInt(line.exactDenominator))
    : null;
}

function intakeFactMap(intake: SouthKorea2025FormReviewInput['intake']) {
  return new Map<string, SouthKorea2025Fact>(
    intake.facts.map((fact) => [fact.key, fact]),
  );
}

function factIsZero(
  intakeFacts: Map<string, SouthKorea2025Fact>,
  key: string,
): boolean {
  const fact = intakeFacts.get(key);
  return (
    fact?.reviewState === 'reviewed' &&
    fact.value.type === 'decimal' &&
    decimal(fact.value.value).n === 0n
  );
}

function factIsTrue(
  intakeFacts: Map<string, SouthKorea2025Fact>,
  key: string,
): boolean {
  const fact = intakeFacts.get(key);
  return (
    fact?.reviewState === 'reviewed' &&
    fact.value.type === 'boolean' &&
    fact.value.value === true
  );
}

function attachmentApplicable(
  entry: SouthKorea2025AttachmentInventoryEntry,
  intakeFacts: Map<string, SouthKorea2025Fact>,
  formFacts: Map<string, SouthKorea2025Fact>,
): boolean {
  switch (entry.applicability.mode) {
    case 'always':
      return true;
    case 'when-nonzero':
      if (entry.applicability.factKey === 'deduction.specialInsurance')
        return ![
          'deduction.healthInsuranceContribution',
          'deduction.employmentInsuranceContribution',
          'deduction.longTermCareInsuranceContribution',
        ].every((key) => factIsZero(intakeFacts, key));
      return factIsZero(intakeFacts, entry.applicability.factKey) === false;
    case 'when-true':
      return factIsTrue(formFacts, entry.applicability.factKey);
    case 'never-in-slice':
      return false;
  }
}

function attachmentContentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Audit actual NTS fields and attachments against a reviewed generic intake.
 * `selectedComplete` means the selected salary field/attachment subset is
 * complete. `fullReturnComplete` remains false because the NTS form has
 * additional schedules and filing actions outside this package.
 */
export function auditSouthKorea2025FormApplicability(raw: unknown) {
  const parsed = SouthKorea2025FormReviewInputSchema.safeParse(raw);
  const issues: ReviewIssue[] = [];
  if (!parsed.success) {
    const body = {
      version: SOUTH_KOREA_2025_FORM_INVENTORY_VERSION,
      runHash: null,
      intakeHash: null,
      packageVersion: '2025.1-national-employment-working-papers.1',
      selectedComplete: false,
      fullReturnComplete: false as const,
      formDataReady: false,
      fieldCount: SOUTH_KOREA_2025_FORM_FIELD_CATALOG.length,
      unresolvedCount: SOUTH_KOREA_2025_FORM_FIELD_CATALOG.length,
      requirements: [],
      fields: [],
      attachments: [],
      issues: [
        {
          code: 'invalid-form-review-input',
          path: 'input',
          message: 'Strict South Korea form review input is invalid.',
        },
      ],
      fullReturnGaps: SOUTH_KOREA_2025_FORM_FIELD_CATALOG.filter(
        (entry) => entry.kind === 'out-of-scope',
      ).map((entry) => entry.id),
      remainingProof: [
        'valid-source-bound-form-review-input',
        'complete-national-year-end-form-and-attachment-proof',
        'local-authority-filing-and-payment-proof',
      ],
    };
    return deepFreeze({ ...body, auditHash: hash(body) });
  }
  const input = parsed.data;
  const evaluation = evaluateSouthKorea2025WorkingPapers(input.intake);
  const intakeFacts = intakeFactMap(input.intake);
  const formFactMap = new Map<string, SouthKorea2025Fact>();
  for (const fact of input.formFacts) {
    if (formFactMap.has(fact.key))
      issues.push({
        code: 'duplicate-form-fact',
        path: fact.key,
        message: 'A form fact key may occur only once.',
      });
    formFactMap.set(fact.key, fact);
  }
  const requirements = SOUTH_KOREA_2025_REQUIRED_FORM_FACTS.map(
    (requirement) => {
      const fact = formFactMap.get(requirement.key);
      const satisfied = validFormFact(fact, requirement);
      if (!satisfied)
        issues.push({
          code: 'missing-or-unreviewed-form-fact',
          path: requirement.key,
          message: `${requirement.label} must be explicitly reviewed and valid.`,
        });
      return {
        key: requirement.key,
        type: requirement.type,
        formId: requirement.formId,
        fieldPath: requirement.fieldPath,
        label: requirement.label,
        required: true,
        satisfied,
        sourceId: requirement.sourceId,
        authorityDocumentHash: sourceHash(requirement.sourceId),
        sourceBinding: fact?.source ?? null,
      };
    },
  );
  const knownFormFacts = new Set<string>(
    SOUTH_KOREA_2025_REQUIRED_FORM_FACTS.map((entry) => entry.key),
  );
  for (const fact of input.formFacts)
    if (!knownFormFacts.has(fact.key))
      issues.push({
        code: 'unknown-form-fact',
        path: fact.key,
        message: 'Unknown form facts cannot silently populate an NTS field.',
      });

  if (evaluation.status === 'blocked-input')
    issues.push({
      code: 'bound-run-blocked-input',
      path: 'intake',
      message: 'The source-bound national working-paper run is blocked.',
    });

  const evaluationFields = new Map(
    evaluation.evaluation.forms[0]?.fields.map((field) => [field.key, field]) ??
      [],
  );
  const localTax =
    evaluation.status !== 'blocked-input'
      ? reportSouthKorea2025LocalIncomeTax(
          exactLine(evaluation, 'tax.determinedTax') ?? q(0n),
        )
      : null;
  const fields: EvaluatedField[] = SOUTH_KOREA_2025_FORM_FIELD_CATALOG.map(
    (entry) => {
      const authorityDocumentHash = sourceHash(entry.sourceId);
      let decision: SouthKorea2025FormFieldDecision = 'unresolved';
      let value: string | boolean | null = null;
      let reason = 'Required field proof is unresolved.';
      let sourceBinding: SouthKorea2025FactSource | null = null;
      if (entry.kind === 'out-of-scope') {
        decision = 'out-of-scope';
        reason = entry.reason;
      } else if (entry.kind === 'manual') {
        decision = 'manual-unperformed';
        reason = entry.reason;
      } else if (entry.kind === 'guarded-inapplicable') {
        const factKey = entry.applicabilityFactKey ?? entry.factKey;
        if (
          entry.applicabilityMode === 'zero' &&
          factKey &&
          factIsZero(intakeFacts, factKey)
        ) {
          decision = 'inapplicable';
          reason = entry.reason;
        } else {
          reason = 'Required zero guard is unresolved or nonzero.';
        }
        sourceBinding = factKey
          ? (intakeFacts.get(factKey)?.source ?? null)
          : null;
      } else if (entry.kind === 'reviewed-input') {
        const fact = entry.factKey ? formFactMap.get(entry.factKey) : undefined;
        const requirement = entry.factKey
          ? requirements.find((candidate) => candidate.key === entry.factKey)
          : undefined;
        if (requirement?.satisfied && fact) {
          decision = 'reviewed-input';
          value = valueForFact(fact) as string | boolean | null;
          reason = 'Reviewed source-bound NTS form fact.';
          sourceBinding = fact.source;
        } else {
          reason = 'Required form fact is missing or invalid.';
        }
      } else if (entry.kind === 'calculated') {
        if (entry.lineKey === 'tax.localIncomeTax' && localTax) {
          decision = 'calculated';
          value = localTax.reportedWon;
          reason =
            'Exact national tax multiplied by the NTS 10% local-tax rate.';
        } else {
          const calculated = entry.lineKey
            ? evaluationFields.get(entry.lineKey)
            : undefined;
          if (calculated && evaluation.status !== 'blocked-input') {
            decision = 'calculated';
            value = calculated.value.value as string | boolean;
            reason = 'Exact source-bound national working-paper calculation.';
          }
        }
      }
      if (entry.requiredForSupportedCase && decision === 'unresolved')
        issues.push({
          code: 'unresolved-required-form-field',
          path: entry.id,
          message: reason,
        });
      return {
        id: entry.id,
        formId: entry.formId,
        fieldPath: entry.fieldPath,
        labelKo: entry.labelKo,
        labelEn: entry.labelEn,
        kind: entry.kind,
        requiredForSupportedCase: entry.requiredForSupportedCase,
        sourceId: entry.sourceId,
        authorityDocumentHash,
        factKey: entry.factKey ?? null,
        lineKey: entry.lineKey ?? null,
        value,
        decision,
        reason,
        sourceBinding,
      };
    },
  );

  const attachmentMetadata = new Map<
    string,
    SouthKorea2025FormReviewAttachment
  >();
  for (const attachment of input.attachments) {
    if (attachmentMetadata.has(attachment.attachmentId))
      issues.push({
        code: 'duplicate-attachment',
        path: attachment.attachmentId,
        message: 'An attachment identifier may occur only once.',
      });
    attachmentMetadata.set(attachment.attachmentId, attachment);
  }
  const attachments = SOUTH_KOREA_2025_ATTACHMENT_INVENTORY.map((entry) => {
    const applicable = attachmentApplicable(entry, intakeFacts, formFactMap);
    const artifact = attachmentMetadata.get(entry.id);
    const source = SOUTH_KOREA_2025_SOURCES.find(
      (candidate) => candidate.id === entry.sourceId,
    )!;
    let satisfied = !applicable;
    let reason = applicable
      ? 'Required reviewed attachment is missing.'
      : entry.reason;
    if (applicable && artifact) {
      if (artifact.formId !== entry.formId)
        reason =
          'Attachment form identifier does not match the actual NTS form.';
      else if (artifact.authoritySourceId !== entry.sourceId)
        reason =
          'Attachment authority binding does not match the inventory source.';
      else if (artifact.authorityDocumentHash !== source.documentHash)
        reason =
          'Attachment authority hash does not match the pinned NTS source.';
      else if (
        artifact.bytes.byteLength === 0 ||
        attachmentContentHash(artifact.bytes) !== artifact.contentHash
      )
        reason = 'Attachment byte hash is invalid.';
      else {
        satisfied = true;
        reason =
          'Reviewed attachment bytes and NTS authority binding verified.';
      }
    }
    if (applicable && !satisfied)
      issues.push({
        code: 'missing-or-unbound-attachment',
        path: entry.id,
        message: reason,
      });
    return {
      id: entry.id,
      formId: entry.formId,
      titleKo: entry.titleKo,
      titleEn: entry.titleEn,
      sourceId: entry.sourceId,
      authorityDocumentHash: source.documentHash,
      locator: entry.locator,
      applicable,
      requiredForSupportedCase: entry.requiredForSupportedCase,
      satisfied,
      artifactId: artifact?.artifactId ?? null,
      contentHash: artifact?.contentHash ?? null,
      reason,
    };
  });
  const unresolved = fields.filter(
    (entry) =>
      entry.requiredForSupportedCase && entry.decision === 'unresolved',
  );
  const selectedComplete =
    evaluation.status !== 'blocked-input' &&
    requirements.every((requirement) => requirement.satisfied) &&
    unresolved.length === 0 &&
    issues.length === 0;
  const body = {
    version: SOUTH_KOREA_2025_FORM_INVENTORY_VERSION,
    runHash: evaluation.outputHash,
    intakeHash: hash(input.intake),
    packageVersion: evaluation.candidate.version,
    selectedComplete,
    fullReturnComplete: false as const,
    formDataReady: selectedComplete,
    fieldCount: fields.length,
    unresolvedCount: unresolved.length,
    requirements,
    fields,
    attachments,
    issues,
    fullReturnGaps: fields
      .filter(
        (entry) =>
          entry.kind === 'out-of-scope' || entry.formId !== 'NTS-YEAREND-2025',
      )
      .map((entry) => entry.id),
    remainingProof: [
      'complete-national-year-end-form-field-and-attachment-inventory',
      'all-special-deduction-credit-relief-and-carryforward-schedules',
      'local-authority-subdivision-return-and-payment-proof',
      'taxpayer-and-withholding-agent-signature',
      'filing-submission-and-independent-complete-return-validation',
    ],
  };
  return deepFreeze({ ...body, auditHash: hash(body) });
}

export const assessSouthKorea2025FormApplicability =
  auditSouthKorea2025FormApplicability;

export const SOUTH_KOREA_2025_FORMS = SOUTH_KOREA_2025_ACTUAL_FORMS;
export const SOUTH_KOREA_2025_ATTACHMENTS =
  SOUTH_KOREA_2025_ATTACHMENT_INVENTORY;

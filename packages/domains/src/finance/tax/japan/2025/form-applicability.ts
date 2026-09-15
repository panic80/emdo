import { createHash } from 'node:crypto';
import { deepFreeze, FinanceTaxFactSchema } from '@emdo/contracts';
import { z } from 'zod';
import { compare, decimal, isWholeYen } from './exact.js';
import { JAPAN_2025_SOURCES } from './sources.js';
import type { Japan2025Run } from './workflow.js';

/**
 * This is a private, source-bound adapter for selected NTA Form 1/Form 2
 * working-paper fields.  It is intentionally separate from the shared run
 * contract: the shared contract currently models CA/US field reporting and
 * requires full-return `complete: false` output.
 */
export const JAPAN_2025_FORM_APPLICABILITY_VERSION =
  '2025-form1-2-applicability.1';

export const Japan2025FormInputEnvelopeSchema = z.strictObject({
  caseId: z.uuid(),
  taxSubjectId: z.uuid(),
  revision: z.number().int().positive(),
  /** Binds the form facts to the immutable Japan run output, not to a caller-supplied amount. */
  runHash: z.string().regex(/^[a-f0-9]{64}$/),
  facts: z.array(FinanceTaxFactSchema).max(200),
});

type JapanFormFactType = 'text' | 'date' | 'boolean' | 'decimal';
type ApplicabilityMode =
  | 'selected-input'
  | 'selected-calculation'
  | 'guarded-inapplicable'
  | 'out-of-scope'
  | 'manual';

type RequiredFormFact = {
  key: string;
  type: JapanFormFactType;
  sourceId: string;
  fieldPath: string;
  label: string;
  matchesFieldId?: string;
};
type FinanceTaxFact = z.infer<typeof FinanceTaxFactSchema>;

/**
 * Every selected form input is explicit.  In particular, the zero-valued
 * branch declarations and the blank local-tax acknowledgement are facts,
 * rather than deductions from omitted data.
 */
export const JAPAN_2025_REQUIRED_FORM_FACTS = deepFreeze([
  {
    key: 'identity.taxOffice',
    type: 'text',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.taxOffice',
    label: 'Tax office jurisdiction',
  },
  {
    key: 'identity.submissionDate',
    type: 'date',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.submissionDate',
    label: 'Submission date',
  },
  {
    key: 'identity.fullName',
    type: 'text',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.name',
    label: 'Name',
  },
  {
    key: 'identity.furigana',
    type: 'text',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.furigana',
    label: 'Name furigana',
  },
  {
    key: 'identity.taxNumber',
    type: 'text',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.individualNumber',
    label: 'Individual number (My Number)',
  },
  {
    key: 'identity.postalCode',
    type: 'text',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.postalCode',
    label: 'Postal code',
  },
  {
    key: 'identity.address',
    type: 'text',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.address',
    label: 'Current address',
  },
  {
    key: 'identity.dateOfBirth',
    type: 'date',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.dateOfBirth',
    label: 'Date of birth',
  },
  {
    key: 'identity.gender',
    type: 'text',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.gender',
    label: 'Gender selection',
  },
  {
    key: 'identity.occupation',
    type: 'text',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.occupation',
    label: 'Occupation',
  },
  {
    key: 'identity.tradeName',
    type: 'text',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.tradeName',
    label: 'Trade name (or explicit none)',
  },
  {
    key: 'identity.householdHead',
    type: 'text',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.householdHead',
    label: 'Household head',
  },
  {
    key: 'identity.householdRelationship',
    type: 'text',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.householdRelationship',
    label: 'Relationship to household head',
  },
  {
    key: 'identity.phone',
    type: 'text',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.phone',
    label: 'Telephone number',
  },
  {
    key: 'identity.sameAddressAt2026-01-01',
    type: 'boolean',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.addressAt2026-01-01',
    label: 'Address is unchanged at 1 January 2026',
  },
  {
    key: 'form.noBlueReturn',
    type: 'boolean',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.returnType.blueReturn',
    label: 'No blue-return filing',
  },
  {
    key: 'form.noSeparateTaxation',
    type: 'boolean',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.returnType.separateTaxation',
    label: 'No separate-taxation return',
  },
  {
    key: 'form.noEmigrationTax',
    type: 'boolean',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.returnType.emigration',
    label: 'No emigration/departure return',
  },
  {
    key: 'form.noLossReturn',
    type: 'boolean',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.returnType.loss',
    label: 'No loss return',
  },
  {
    key: 'form.noAmendedReturn',
    type: 'boolean',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.returnType.amended',
    label: 'No amended/corrected return',
  },
  {
    key: 'form.noSpecialAgriculture',
    type: 'boolean',
    sourceId: 'nta-jp-r07-identification',
    fieldPath: 'JP-Form-1.returnType.specialAgriculture',
    label: 'No special agriculture return',
  },
  {
    key: 'case.singleSalaryPayer',
    type: 'boolean',
    sourceId: 'nta-jp-r07-form-1-2',
    fieldPath: 'JP-Form-2.incomeDetails.salaryPayerCount',
    label: 'Exactly one salary payer detail row',
  },
  {
    key: 'salary.payerName',
    type: 'text',
    sourceId: 'nta-jp-r07-form-1-2',
    fieldPath: 'JP-Form-2.incomeDetails.salary.payerName',
    label: 'Salary payer name',
  },
  {
    key: 'salary.payerAddressOrNumber',
    type: 'text',
    sourceId: 'nta-jp-r07-form-1-2',
    fieldPath: 'JP-Form-2.incomeDetails.salary.payerAddressOrNumber',
    label: 'Salary payer address or withholding-office number',
  },
  {
    key: 'salary.incomeDetailGross',
    type: 'decimal',
    sourceId: 'nta-jp-r07-form-1-2',
    fieldPath: 'JP-Form-2.incomeDetails.salary.grossReceipts',
    label: 'Salary gross receipts in income details',
    matchesFieldId: 'JP-Form-1.salaryGross',
  },
  {
    key: 'salary.incomeDetailWithholding',
    type: 'decimal',
    sourceId: 'nta-jp-r07-withholding',
    fieldPath: 'JP-Form-2.incomeDetails.salary.withholding',
    label:
      'Salary income tax and reconstruction surtax withheld in income details',
    matchesFieldId: 'JP-Form-1.withholding',
  },
  {
    key: 'socialInsurance.detailType',
    type: 'text',
    sourceId: 'nta-jp-r07-social-insurance',
    fieldPath: 'JP-Form-2.socialInsurance.type',
    label: 'Social-insurance premium detail type',
  },
  {
    key: 'socialInsurance.detailAmount',
    type: 'decimal',
    sourceId: 'nta-jp-r07-social-insurance',
    fieldPath: 'JP-Form-2.socialInsurance.amount',
    label: 'Social-insurance premium detail amount',
    matchesFieldId: 'JP-Form-1.socialInsurance',
  },
  {
    key: 'case.noSpouseOrDependants',
    type: 'boolean',
    sourceId: 'nta-jp-r07-form-1-2',
    fieldPath: 'JP-Form-2.relatives.spouseAndDependants',
    label: 'No spouse or dependant entries',
  },
  {
    key: 'case.noSpecialProvisionArticles',
    type: 'boolean',
    sourceId: 'nta-jp-r07-form-1-2',
    fieldPath: 'JP-Form-2.specialProvisions',
    label: 'No special-provision article entries',
  },
  {
    key: 'scope.localTaxOutOfScopeAcknowledged',
    type: 'boolean',
    sourceId: 'nta-jp-r07-form-1-2',
    fieldPath: 'JP-Form-2.localTaxSection',
    label:
      'Prefectural/municipal inhabitant-tax section explicitly outside this package',
  },
] as const satisfies readonly RequiredFormFact[]);

type CatalogEntry = {
  id: string;
  form: 'JP-Form-1' | 'JP-Form-2';
  fieldPath: string;
  label: string;
  kind: JapanFormFactType | 'calculated' | 'manual' | 'section';
  sourceId: string;
  factKey?: string;
  calculationKey?: string;
  mode: ApplicabilityMode;
  required: boolean;
  blocksSelected: boolean;
  fullReturnGap: boolean;
  reason: string;
};

const sourceId = 'nta-jp-r07-form-1-2';
const identitySourceId = 'nta-jp-r07-identification';

const input = (
  id: string,
  form: CatalogEntry['form'],
  fieldPath: string,
  label: string,
  factKey: string,
  kind: JapanFormFactType,
  source: string = identitySourceId,
): CatalogEntry => ({
  id,
  form,
  fieldPath,
  label,
  kind,
  sourceId: source,
  factKey,
  mode: 'selected-input',
  required: true,
  blocksSelected: true,
  fullReturnGap: false,
  reason: 'Reviewed source fact populates a selected Form 1/Form 2 field',
});

const calculation = (
  calculationKey: string,
  form: CatalogEntry['form'],
  fieldPath: string,
  label: string,
  source: string,
): CatalogEntry => ({
  id: `calculated:${calculationKey}`,
  form,
  fieldPath,
  label,
  kind: 'calculated',
  sourceId: source,
  calculationKey,
  mode: 'selected-calculation',
  required: true,
  blocksSelected: true,
  fullReturnGap: false,
  reason:
    'Exact value is produced by the bound Japan salary working-paper graph',
});

const manual = (
  id: string,
  form: CatalogEntry['form'],
  fieldPath: string,
  label: string,
): CatalogEntry => ({
  id,
  form,
  fieldPath,
  label,
  kind: 'manual',
  sourceId,
  mode: 'manual',
  required: false,
  blocksSelected: false,
  fullReturnGap: false,
  reason:
    'Taxpayer or preparer action remains manual and is not performed by this package',
});

const inapplicable = (
  id: string,
  form: CatalogEntry['form'],
  fieldPath: string,
  label: string,
  reason: string,
): CatalogEntry => ({
  id,
  form,
  fieldPath,
  label,
  kind: 'section',
  sourceId,
  mode: 'guarded-inapplicable',
  required: false,
  blocksSelected: false,
  fullReturnGap: false,
  reason,
});

const outOfScope = (
  id: string,
  form: CatalogEntry['form'],
  fieldPath: string,
  label: string,
  source: string = sourceId,
): CatalogEntry => ({
  id,
  form,
  fieldPath,
  label,
  kind: 'section',
  sourceId: source,
  mode: 'out-of-scope',
  required: false,
  blocksSelected: false,
  fullReturnGap: true,
  reason:
    'Applicable only to a return branch or local-tax section outside this selected national salary package',
});

const requiredFormFacts: readonly RequiredFormFact[] =
  JAPAN_2025_REQUIRED_FORM_FACTS;

const identityInputs = requiredFormFacts
  .filter(
    (fact) =>
      fact.key.startsWith('identity.') ||
      fact.key.startsWith('form.') ||
      fact.key === 'case.singleSalaryPayer' ||
      fact.key === 'case.noSpouseOrDependants' ||
      fact.key === 'case.noSpecialProvisionArticles' ||
      fact.key === 'scope.localTaxOutOfScopeAcknowledged',
  )
  .map((fact) =>
    input(
      `input:${fact.key}`,
      fact.fieldPath.startsWith('JP-Form-2') ? 'JP-Form-2' : 'JP-Form-1',
      fact.fieldPath,
      fact.label,
      fact.key,
      fact.type,
      fact.sourceId,
    ),
  );

const detailInputs = requiredFormFacts
  .filter(
    (fact) =>
      fact.key.startsWith('salary.') || fact.key.startsWith('socialInsurance.'),
  )
  .map((fact) =>
    input(
      `input:${fact.key}`,
      'JP-Form-2',
      fact.fieldPath,
      fact.label,
      fact.key,
      fact.type,
      fact.sourceId,
    ),
  );

const selectedCalculations: readonly CatalogEntry[] = [
  calculation(
    'JP-Form-1.salaryGross',
    'JP-Form-1',
    'JP-Form-1.salaryReceipts.オ',
    'Salary receipts (第一表 オ)',
    'nta-jp-r07-salary-income',
  ),
  calculation(
    'JP-Form-1.salaryIncome',
    'JP-Form-1',
    'JP-Form-1.salaryIncome.⑥',
    'Salary income after salary-income deduction (第一表 ⑥)',
    'nta-jp-r07-salary-income',
  ),
  calculation(
    'JP-Form-2.salaryIncomeDetail',
    'JP-Form-2',
    'JP-Form-2.incomeDetails.salary.income',
    'Salary income in income details',
    'nta-jp-r07-salary-income',
  ),
  calculation(
    'JP-Form-1.totalIncome',
    'JP-Form-1',
    'JP-Form-1.totalIncome.⑫',
    'Total income (第一表 ⑫)',
    'nta-jp-r07-salary-income',
  ),
  calculation(
    'JP-Form-1.socialInsurance',
    'JP-Form-1',
    'JP-Form-1.deductions.socialInsurance.⑩',
    'Social-insurance premium deduction (第一表 ⑩)',
    'nta-jp-r07-social-insurance',
  ),
  calculation(
    'JP-Form-2.socialInsuranceDetail',
    'JP-Form-2',
    'JP-Form-2.socialInsurance.total.⑩',
    'Social-insurance premium detail total',
    'nta-jp-r07-social-insurance',
  ),
  calculation(
    'JP-Form-1.otherDeductionsExcluded',
    'JP-Form-1',
    'JP-Form-1.deductions.unsupportedBranches.⑪-㉔/㉖-㉙',
    'Excluded deductions reviewed zero',
    sourceId,
  ),
  calculation(
    'JP-Form-1.basicDeduction',
    'JP-Form-1',
    'JP-Form-1.deductions.basic.㉕',
    'Basic deduction (第一表 ㉕)',
    'nta-jp-r07-basic-deduction',
  ),
  calculation(
    'JP-Form-1.totalDeductions',
    'JP-Form-1',
    'JP-Form-1.totalDeductions.㉚',
    'Total deductions (第一表 ㉚)',
    'nta-jp-r07-basic-deduction',
  ),
  calculation(
    'JP-Form-1.taxableIncome',
    'JP-Form-1',
    'JP-Form-1.taxableIncome.㉛',
    'Taxable income after 1,000-yen truncation (第一表 ㉛)',
    'nta-jp-r07-national-tax',
  ),
  calculation(
    'JP-Form-1.taxBeforeCredits',
    'JP-Form-1',
    'JP-Form-1.taxBeforeCredits.㉜',
    'Tax on taxable income before credits (第一表 ㉜)',
    'nta-jp-r07-national-tax',
  ),
  calculation(
    'JP-Form-1.deductedIncomeTax',
    'JP-Form-1',
    'JP-Form-1.deductedIncomeTax.㊵-㊶',
    'Income tax after supported zero credits',
    'nta-jp-r07-national-tax',
  ),
  calculation(
    'JP-Form-1.baseIncomeTax',
    'JP-Form-1',
    'JP-Form-1.baseIncomeTax.㊷/㊸',
    'Base income tax (第一表 ㊷/㊸)',
    'nta-jp-r07-national-tax',
  ),
  calculation(
    'JP-Form-1.reconstructionSurtax',
    'JP-Form-1',
    'JP-Form-1.reconstructionSurtax.㊹',
    'Special income tax for reconstruction (第一表 ㊹)',
    'nta-jp-r07-reconstruction-surtax',
  ),
  calculation(
    'JP-Form-1.combinedTax',
    'JP-Form-1',
    'JP-Form-1.combinedTax.㊺',
    'Income tax and reconstruction surtax (第一表 ㊺)',
    'nta-jp-r07-total-tax',
  ),
  calculation(
    'JP-Form-1.withholding',
    'JP-Form-1',
    'JP-Form-1.withholding.㊽',
    'Withheld income tax and reconstruction surtax (第一表 ㊽)',
    'nta-jp-r07-withholding',
  ),
  calculation(
    'JP-Form-2.withholdingDetail',
    'JP-Form-2',
    'JP-Form-2.incomeDetails.salary.withholding',
    'Withholding in income details',
    'nta-jp-r07-withholding',
  ),
  calculation(
    'JP-Form-1.estimatedTax',
    'JP-Form-1',
    'JP-Form-1.estimatedTax.㊿',
    'Estimated tax paid (第一表 ㊿)',
    'nta-jp-r07-third-period',
  ),
  calculation(
    'JP-Form-1.assessmentBeforeRounding',
    'JP-Form-1',
    'JP-Form-1.assessmentBeforeRounding',
    'Assessment before settlement rounding',
    'nta-jp-r07-assessment',
  ),
  calculation(
    'JP-Form-1.declaredAssessment',
    'JP-Form-1',
    'JP-Form-1.declaredAssessment.㊾',
    'Declared assessment/refund settlement (第一表 ㊾)',
    'nta-jp-r07-assessment',
  ),
  calculation(
    'JP-Form-1.thirdPeriodDue',
    'JP-Form-1',
    'JP-Form-1.thirdPeriodDue.51',
    'Third-period tax due (第一表 51)',
    'nta-jp-r07-third-period',
  ),
  calculation(
    'JP-Form-1.refund',
    'JP-Form-1',
    'JP-Form-1.refund.52',
    'Refund amount (第一表 52)',
    'nta-jp-r07-third-period',
  ),
];

const inapplicableFields: readonly CatalogEntry[] = [
  inapplicable(
    'inapplicable:business-income',
    'JP-Form-1',
    'JP-Form-1.income.business',
    'Business income fields',
    'Salary-only, no-business-income guard is reviewed by the bound intake',
  ),
  inapplicable(
    'inapplicable:pension-income',
    'JP-Form-1',
    'JP-Form-1.income.publicPension',
    'Public pension income fields',
    'No-other-income guard excludes pension income',
  ),
  inapplicable(
    'inapplicable:other-income',
    'JP-Form-1',
    'JP-Form-1.income.other',
    'Miscellaneous/occasional/retirement income fields',
    'No-other-income guard excludes other income branches',
  ),
  inapplicable(
    'inapplicable:other-deductions',
    'JP-Form-1',
    'JP-Form-1.deductions.other',
    'Medical, life, earthquake, mutual-aid and other deductions',
    'No-other-income-deductions guard plus explicit zero deduction fact',
  ),
  inapplicable(
    'inapplicable:credits',
    'JP-Form-1',
    'JP-Form-1.taxCredits',
    'Housing, donation, foreign-tax and other credit fields',
    'No-tax-credits and no-foreign-tax-credit guards are reviewed',
  ),
  inapplicable(
    'inapplicable:estimated-payments',
    'JP-Form-1',
    'JP-Form-1.estimatedPayments.other',
    'Nonzero estimated-payment and prepayment branches',
    'No-estimated-payments guard and explicit zero payment fact',
  ),
  inapplicable(
    'inapplicable:disaster',
    'JP-Form-1',
    'JP-Form-1.disasterReduction',
    'Disaster-loss/reduction fields',
    'No-disaster-reduction guard is reviewed',
  ),
  inapplicable(
    'inapplicable:high-income',
    'JP-Form-1',
    'JP-Form-1.highIncomeSpecialMeasure',
    'Special high-income tax measure worksheet',
    'Ordinary salary graph blocks total income at or above the NTA threshold',
  ),
  inapplicable(
    'inapplicable:spouse-dependants',
    'JP-Form-2',
    'JP-Form-2.relatives.spouseAndDependants',
    'Spouse, dependant, disability and student entries',
    'No-spouse-or-dependants guard is reviewed',
  ),
  inapplicable(
    'inapplicable:special-provisions',
    'JP-Form-2',
    'JP-Form-2.specialProvisions',
    'Special provision article entries',
    'No-special-provision-articles guard is reviewed',
  ),
];

const outOfScopeFields: readonly CatalogEntry[] = [
  outOfScope(
    'out-of-scope:form-3',
    'JP-Form-1',
    'JP-Form-3',
    'Third Form separate-taxation return',
  ),
  outOfScope(
    'out-of-scope:form-4',
    'JP-Form-1',
    'JP-Form-4',
    'Fourth Form loss declaration',
  ),
  outOfScope(
    'out-of-scope:business-schedules',
    'JP-Form-1',
    'JP-Schedule.business',
    'Blue/white return business schedules',
  ),
  outOfScope(
    'out-of-scope:medical-schedule',
    'JP-Form-1',
    'JP-Schedule.medical',
    'Medical expense calculation statement',
  ),
  outOfScope(
    'out-of-scope:housing-schedule',
    'JP-Form-1',
    'JP-Schedule.housing',
    'Housing loan and renovation schedules',
  ),
  outOfScope(
    'out-of-scope:foreign-tax-schedule',
    'JP-Form-1',
    'JP-Schedule.foreignTax',
    'Foreign-tax-credit schedule',
  ),
  outOfScope(
    'out-of-scope:local-tax',
    'JP-Form-2',
    'JP-Form-2.localTaxSection',
    'Prefectural and municipal inhabitant-tax declaration fields',
  ),
  outOfScope(
    'out-of-scope:bank-refund',
    'JP-Form-1',
    'JP-Form-1.refundBank',
    'Refund bank-account instructions and verification',
  ),
  outOfScope(
    'out-of-scope:filing-submission',
    'JP-Form-1',
    'JP-Filing.submission',
    'Taxpayer signature, e-filing authorization and filing submission',
  ),
];

export const JAPAN_2025_FORM_FIELD_CATALOG = deepFreeze([
  ...identityInputs,
  ...detailInputs,
  ...selectedCalculations,
  ...inapplicableFields,
  ...outOfScopeFields,
  manual(
    'manual:taxpayer-signature',
    'JP-Form-1',
    'JP-Form-1.taxpayerSignature',
    'Taxpayer signature and date',
  ),
  manual(
    'manual:preparer',
    'JP-Form-1',
    'JP-Form-1.preparer',
    'Tax-return preparer name and credentials',
  ),
] as const);

export type Japan2025FormField = (typeof JAPAN_2025_FORM_FIELD_CATALOG)[number];
export type Japan2025FormDecision =
  | 'calculated'
  | 'reviewed-input'
  | 'inapplicable'
  | 'out-of-scope'
  | 'manual-unperformed'
  | 'unresolved';

type FormSourceBinding = FinanceTaxFact['source'] | null;

const sourceHash = (id: string) => {
  const source = JAPAN_2025_SOURCES.find((candidate) => candidate.id === id);
  if (!source) throw new Error(`missing-japan-source:${id}`);
  return source.documentHash;
};

const runField = (run: Japan2025Run, id: string) =>
  run.fields.find((field) => field.id === id) ?? null;

const factValue = (fact: FinanceTaxFact | undefined) =>
  fact?.value.value ?? null;

function validFact(
  fact: FinanceTaxFact | undefined,
  type: JapanFormFactType,
  key: string,
): boolean {
  if (!fact || fact.reviewState !== 'reviewed' || fact.value.type !== type)
    return false;
  const raw = String(fact.value.value);
  if (type === 'text' && !raw.trim()) return false;
  if (type === 'decimal') {
    try {
      const amount = decimal(raw);
      if (amount.n < 0n || !isWholeYen(amount)) return false;
    } catch {
      return false;
    }
  }
  if (key === 'identity.taxNumber' && !/^\d{12}$/.test(raw)) return false;
  if (key === 'identity.postalCode' && !/^\d{3}-?\d{4}$/.test(raw))
    return false;
  if (
    key.startsWith('form.') ||
    key === 'case.singleSalaryPayer' ||
    key === 'case.noSpouseOrDependants' ||
    key === 'case.noSpecialProvisionArticles' ||
    key === 'identity.sameAddressAt2026-01-01' ||
    key === 'scope.localTaxOutOfScopeAcknowledged'
  )
    return fact.value.type === 'boolean' && fact.value.value === true;
  return true;
}

function mainGuard(run: Japan2025Run, key: string, expected: boolean): boolean {
  return (
    run.inputSnapshot?.facts.some(
      (fact) =>
        fact.key === key &&
        fact.reviewState === 'reviewed' &&
        fact.value.type === 'boolean' &&
        fact.value.value === expected,
    ) ?? false
  );
}

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

/**
 * Audits selected national Form 1/Form 2 fields against a bound run.  A true
 * `selectedComplete` means the selected salary branch has all reviewed input
 * and exact calculation fields.  `fullReturnComplete` remains false because
 * local tax, schedules, signatures and other return branches are outside this
 * package.
 */
export function auditJapan2025FormApplicability(
  run: Japan2025Run,
  raw?: unknown,
) {
  const parsed = Japan2025FormInputEnvelopeSchema.safeParse(raw);
  const issues: string[] = [];
  if (raw === undefined) issues.push('form-input-envelope-required');
  else if (!parsed.success) issues.push('invalid-form-input-envelope');
  const envelope = parsed.success ? parsed.data : null;
  const runHash = run.outputHash;
  const bindingValid =
    envelope !== null &&
    envelope.caseId === run.inputSnapshot?.caseId &&
    envelope.taxSubjectId === run.inputSnapshot?.taxSubjectId &&
    envelope.revision === run.inputSnapshot?.revision &&
    envelope.runHash === runHash;
  if (envelope && !bindingValid)
    issues.push('form-input-case-revision-run-binding-mismatch');
  if (run.status === 'blocked-input') issues.push('bound-run-blocked-input');

  const facts = new Map<string, FinanceTaxFact>();
  if (bindingValid && envelope) {
    for (const fact of envelope.facts) {
      if (facts.has(fact.key)) issues.push(`duplicate-form-fact:${fact.key}`);
      facts.set(fact.key, fact);
    }
  }
  const requiredByKey = new Map(
    requiredFormFacts.map((fact) => [fact.key, fact]),
  );
  const requirements = requiredFormFacts.map((requirement) => {
    const fact = facts.get(requirement.key);
    let satisfied = validFact(fact, requirement.type, requirement.key);
    let reason = satisfied ? 'reviewed-and-valid' : 'missing-or-unreviewed';
    if (satisfied && requirement.matchesFieldId) {
      const calculated = runField(run, requirement.matchesFieldId);
      if (!calculated || fact?.value.type !== 'decimal') {
        satisfied = false;
        reason = 'bound-calculation-missing';
      } else if (
        compare(decimal(fact.value.value), decimal(calculated.exactYen)) !== 0n
      ) {
        satisfied = false;
        reason = 'does-not-match-bound-calculation';
        issues.push(`form-detail-does-not-match:${requirement.key}`);
      }
    }
    if (!satisfied)
      issues.push(`missing-or-unreviewed-form-fact:${requirement.key}`);
    return {
      key: requirement.key,
      type: requirement.type,
      fieldPath: requirement.fieldPath,
      label: requirement.label,
      required: true,
      satisfied,
      reason,
      sourceId: requirement.sourceId,
      sourceBinding: (fact?.source ?? null) as FormSourceBinding,
    };
  });

  if (bindingValid && envelope)
    for (const fact of envelope.facts)
      if (!requiredByKey.has(fact.key))
        issues.push(`unknown-form-fact:${fact.key}`);

  const valueByKey = new Map(
    requirements.map((requirement) => [requirement.key, requirement.satisfied]),
  );
  const calculationById = new Map(run.fields.map((field) => [field.id, field]));
  const fields = JAPAN_2025_FORM_FIELD_CATALOG.map((entry) => {
    let decision: Japan2025FormDecision = 'unresolved';
    let reason = 'Selected field is unresolved';
    let fieldId: string | null = null;
    let value: string | boolean | null = null;
    const requirement = entry.factKey
      ? requirements.find((candidate) => candidate.key === entry.factKey)
      : undefined;
    if (entry.mode === 'out-of-scope') {
      decision = 'out-of-scope';
      reason = entry.reason;
    } else if (entry.mode === 'manual') {
      decision = 'manual-unperformed';
      reason = entry.reason;
    } else if (entry.mode === 'guarded-inapplicable') {
      const guardSatisfied =
        (entry.id === 'inapplicable:business-income' &&
          mainGuard(run, 'case.salaryOnly', true)) ||
        (entry.id === 'inapplicable:pension-income' &&
          mainGuard(run, 'case.noOtherIncome', true)) ||
        (entry.id === 'inapplicable:other-income' &&
          mainGuard(run, 'case.noOtherIncome', true)) ||
        (entry.id === 'inapplicable:other-deductions' &&
          mainGuard(run, 'case.noOtherIncomeDeductions', true)) ||
        (entry.id === 'inapplicable:credits' &&
          mainGuard(run, 'case.noTaxCredits', true) &&
          mainGuard(run, 'case.noForeignTaxCredit', true)) ||
        (entry.id === 'inapplicable:estimated-payments' &&
          mainGuard(run, 'case.noEstimatedPayments', true)) ||
        (entry.id === 'inapplicable:disaster' &&
          mainGuard(run, 'case.noDisasterReduction', true)) ||
        (entry.id === 'inapplicable:high-income' &&
          run.status !== 'blocked-input') ||
        (entry.id === 'inapplicable:spouse-dependants' &&
          valueByKey.get('case.noSpouseOrDependants') === true) ||
        (entry.id === 'inapplicable:special-provisions' &&
          valueByKey.get('case.noSpecialProvisionArticles') === true);
      if (guardSatisfied) {
        decision = 'inapplicable';
        reason = entry.reason;
      } else {
        reason = 'Required applicability guard is unresolved';
      }
    } else if (entry.mode === 'selected-input') {
      if (requirement?.satisfied) {
        decision = 'reviewed-input';
        reason = 'reviewed-and-valid';
        const fact = facts.get(entry.factKey!);
        value = factValue(fact) as string | boolean | null;
      } else {
        reason = requirement?.reason ?? 'required form fact is missing';
      }
    } else if (entry.mode === 'selected-calculation') {
      const calculated = calculationById.get(entry.calculationKey!);
      if (calculated && run.status !== 'blocked-input') {
        decision = 'calculated';
        reason = 'exact-bound-calculation';
        fieldId = calculated.id;
        value = calculated.exactYen;
      } else {
        reason = 'bound calculation is unavailable';
      }
    }
    return {
      id: entry.id,
      form: entry.form,
      fieldPath: entry.fieldPath,
      label: entry.label,
      kind: entry.kind,
      required: entry.required,
      blocksSelected: entry.blocksSelected,
      fullReturnGap: entry.fullReturnGap,
      sourceId: entry.sourceId,
      documentHash: sourceHash(entry.sourceId),
      factKey: entry.factKey ?? null,
      calculationKey: entry.calculationKey ?? null,
      fieldId,
      value,
      decision,
      reason,
      sourceBinding: requirement?.sourceBinding ?? null,
    };
  });

  const unresolved = fields.filter(
    (field) => field.blocksSelected && field.decision === 'unresolved',
  );
  const fullReturnGaps = fields
    .filter((field) => field.fullReturnGap)
    .map((field) => field.id);
  const selectedComplete =
    bindingValid &&
    run.status !== 'blocked-input' &&
    issues.length === 0 &&
    unresolved.length === 0;
  const body = {
    version: JAPAN_2025_FORM_APPLICABILITY_VERSION,
    runHash,
    packageVersion: run.candidate.version,
    complete: selectedComplete,
    selectedComplete,
    fullReturnComplete: false as const,
    formDataReady: selectedComplete,
    reportable: false as const,
    signature: {
      status: 'manual-unperformed' as const,
      blocksCalculation: false as const,
    },
    fieldCount: fields.length,
    unresolvedCount: unresolved.length,
    requirements,
    fields,
    issues,
    fullReturnGaps,
    remainingProof: [
      'complete-japan-form-1-and-form-2-full-field-and-attachment-inventory',
      'prefectural-and-municipal-inhabitant-tax-return',
      'form-3-separate-taxation-and-form-4-loss-branches',
      'sole-proprietor-blue-and-white-return-schedules',
      'standalone-corporation-return-and-corporate-local-tax',
      'taxpayer-signature-and-filing-submission',
    ],
  };
  return deepFreeze({
    ...body,
    auditHash: createSha256(body),
  });
}

function createSha256(value: unknown): string {
  // Kept local so this adapter does not add a shared hash/registry dependency.
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export const assessJapan2025FormApplicability = auditJapan2025FormApplicability;

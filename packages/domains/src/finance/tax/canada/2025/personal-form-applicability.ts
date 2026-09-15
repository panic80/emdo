import { canada2025OntarioBracketColumn } from './personal-ontario-brackets.js';
import { canada2025OntarioHealthPremiumRow } from './personal-ontario-health.js';
import { deepFreeze, FinanceTaxFactSchema } from '@emdo/contracts';
import { z } from 'zod';
import { decimal, compare, rational } from './personal-exact.js';
import { PERSONAL_COMPLETE_FIELD_CATALOG } from './personal-field-catalog.js';
import {
  PERSONAL_PAPER_FIELD_PROOFS,
  PERSONAL_PAPER_PRECISION_SOURCES,
} from './personal-precision-evidence.js';
import { personalT1ExcludedBranch } from './personal-t1-applicability.js';
import { canada2025FederalTaxColumn } from './personal-federal-tax-worksheet.js';
import type { CanadaOntario2025PersonalRun } from './personal-package.js';

export const PERSONAL_FORM_APPLICABILITY_VERSION =
  '2025-personal-form-inventory.17';
/** Private reviewed form-data adapter. Persistence binds and authorizes each
 * exact source revision before supplying reviewed facts. */
export const CanadaPersonalFormInputEnvelopeSchema = z.strictObject({
  caseId: z.uuid(),
  taxSubjectId: z.uuid(),
  revision: z.number().int().positive(),
  runHash: z.string().regex(/^[a-f0-9]{64}$/),
  facts: z.array(FinanceTaxFactSchema).max(100),
});
const t1 = 'cra-5006-r-2025-fillable';
const identity = 'form1.Page1.Identification.';
export const PERSONAL_REQUIRED_FORM_FACTS = deepFreeze([
  {
    key: 'identity.firstName',
    type: 'text',
    path: identity + 'ID_FirstNameInitial',
  },
  { key: 'identity.lastName', type: 'text', path: identity + 'ID_LastName' },
  {
    key: 'identity.mailingAddress',
    type: 'text',
    path: identity + 'ID_MailingAddress',
  },
  { key: 'identity.city', type: 'text', path: identity + 'ID_City' },
  { key: 'identity.province', type: 'text', path: identity + 'Prov_DropDown' },
  {
    key: 'identity.postalCode',
    type: 'text',
    path: identity + 'PostalCode_Comb_BordersAll.PostalCode',
  },
  {
    key: 'identity.taxNumber',
    type: 'text',
    path:
      identity +
      'NumericField_Comb9_CaptionTop.NumericField_Comb9_CaptionTop_Field',
  },
  {
    key: 'identity.language',
    type: 'text',
    path: identity + 'Your_Language.RadioButtonlanguaget.',
  },
  {
    key: 'identity.canadianCitizen',
    type: 'boolean',
    path: 'form1.Page2.ElectionsCanada.LineA.',
  },
  {
    key: 'identity.electionsCanadaAuthorization',
    type: 'boolean',
    path: 'form1.Page2.ElectionsCanada.LineB.',
    when: 'identity.canadianCitizen',
  },
  {
    key: 'identity.emailNotifications',
    type: 'boolean',
    path: identity + 'EmailAddress',
  },
  {
    key: 'identity.email',
    type: 'text',
    path: identity + 'EmailAddress',
    when: 'email-requested',
  },
  {
    key: 'identity.ontarioContactSharingConsent',
    type: 'boolean',
    path: 'form1.Page2.Organ_donor.Question.',
  },
  {
    key: 'identity.specifiedForeignProperty',
    type: 'boolean',
    path: 'form1.Page2.Foreign_property.Line26600.',
  },
  {
    key: 'identity.currentProvince',
    type: 'text',
    path: 'form1.Page1.Residence_Info.Prov_DropDown',
  },
] as const);

const businessPrefix = 'form1.Page1.Prt1_sf.Prt1_Frm_sf.';
export const PERSONAL_REQUIRED_BUSINESS_FORM_FACTS = deepFreeze([
  {
    key: 'businessIdentity.preparerNameAndAddress',
    type: 'text',
    path: businessPrefix + 'Prt1_Frm_inpt16',
  },
  {
    key: 'businessIdentity.hasProgramAccount',
    type: 'boolean',
    path: businessPrefix + 'Prt1_Frm_grp3.Prt1_Frm_grp3_inpt4',
  },
  {
    key: 'businessIdentity.programAccountNumber',
    type: 'text',
    path: businessPrefix + 'Prt1_Frm_grp3.Prt1_Frm_grp3_inpt4',
  },
  {
    key: 'businessIdentity.lastBusinessYear',
    type: 'boolean',
    path: businessPrefix + 'cbGrp.cb',
  },
  ...([1, 2, 3, 4, 5] as const).map((n) => ({
    key: `businessIdentity.internetSite${n}` as const,
    type: 'text' as const,
    path: `form1.Page1.Prt2_sf.Prt2_Frm_sf.Prt2_Frm_grp${n + 1}.Prt2_Frm_grp${n + 1}_inpt${n + 1}`,
  })),
  {
    key: 'businessIdentity.name',
    type: 'text',
    path: businessPrefix + 'Prt1_Frm_inpt3',
  },
  {
    key: 'businessIdentity.address',
    type: 'text',
    path: businessPrefix + 'Prt1_Frm_inpt5',
  },
  {
    key: 'businessIdentity.city',
    type: 'text',
    path: businessPrefix + 'Prt1_Frm_inpt6',
  },
  {
    key: 'businessIdentity.province',
    type: 'text',
    path: businessPrefix + 'Prt1_Frm_grp4.Prt1_Frm_grp4_inpt7',
  },
  {
    key: 'businessIdentity.postalCode',
    type: 'text',
    path: businessPrefix + 'Prt1_Frm_grp5.Prt1_Frm_grp5_inpt8',
  },
  {
    key: 'businessIdentity.productOrService',
    type: 'text',
    path: businessPrefix + 'Prt1_Frm_inpt11',
  },
  {
    key: 'businessIdentity.industryCode',
    type: 'text',
    path: businessPrefix + 'Prt1_Frm_grp7.Prt1_Frm_grp7_inpt12',
  },
  {
    key: 'businessIdentity.fiscalStart',
    type: 'date',
    path: businessPrefix + 'Prt1_Frm_grp6.FromDate',
  },
  {
    key: 'businessIdentity.fiscalEnd',
    type: 'date',
    path: businessPrefix + 'Prt1_Frm_grp6.ToDate',
  },
  {
    key: 'businessIdentity.internetIncomePercentage',
    type: 'decimal',
    path: 'form1.Page1.Prt2_sf.Prt2_Frm_sf.Prt2_Frm_grp7.Prt2_Frm_grp7_inpt7',
  },
  {
    key: 'businessIdentity.internetSiteCount',
    type: 'decimal',
    path: 'form1.Page1.Prt2_sf.Prt2_Frm_sf.Prt2_Frm_grp1.Prt2_Frm_grp1_inpt1',
  },
] as const);

type Decision =
  | 'mapped-amount'
  | 'reporting-blocked'
  | 'reviewed-input'
  | 'missing-input'
  | 'not-applicable'
  | 'source-layout'
  | 'manual-signing'
  | 'unresolved-field';
/** Exhaustive inventory audit, never a substitute for independent return validation.
 * Missing inputs and unknown fields stay explicit. A manual signature is an
 * unperformed taxpayer action, not a deterministic calculation completion gate. */
export function auditCanadaOntario2025PersonalFormApplicability(
  run: CanadaOntario2025PersonalRun,
  raw?: unknown,
) {
  const parsed = CanadaPersonalFormInputEnvelopeSchema.safeParse(raw);
  const issues: string[] = [];
  if (raw !== undefined && !parsed.success)
    issues.push('invalid-form-input-envelope');
  const envelope = parsed.success ? parsed.data : null;
  const bindingValid =
    envelope !== null &&
    envelope.caseId === run.inputSnapshot?.caseId &&
    envelope.taxSubjectId === run.inputSnapshot?.taxSubjectId &&
    envelope.revision === run.inputSnapshot?.revision &&
    envelope.runHash === run.runHash;
  if (envelope && !bindingValid)
    issues.push('form-input-case-revision-run-binding-mismatch');
  const facts = new Map<string, z.infer<typeof FinanceTaxFactSchema>>();
  if (bindingValid)
    for (const fact of envelope.facts) {
      if (facts.has(fact.key)) issues.push(`duplicate-form-fact:${fact.key}`);
      facts.set(fact.key, fact);
    }
  const bool = (key: string) =>
    facts.get(key)?.reviewState === 'reviewed' &&
    facts.get(key)?.value.type === 'boolean' &&
    facts.get(key)?.value.value === true;
  const active = (key: string) =>
    key !== 'identity.electionsCanadaAuthorization' ||
    !(
      facts.get('identity.canadianCitizen')?.reviewState === 'reviewed' &&
      facts.get('identity.canadianCitizen')?.value.type === 'boolean' &&
      facts.get('identity.canadianCitizen')?.value.value === false
    );
  const reviewedBoolean = (key: string) => {
    const f = facts.get(key);
    return f?.reviewState === 'reviewed' && f.value.type === 'boolean'
      ? f.value.value
      : null;
  };
  const siteCountFact = facts.get('businessIdentity.internetSiteCount');
  const siteCount =
    siteCountFact?.reviewState === 'reviewed' &&
    siteCountFact.value.type === 'decimal' &&
    /^(0|[1-9]\d*)$/.test(siteCountFact.value.value)
      ? BigInt(siteCountFact.value.value)
      : null;
  const isRequired = (key: string) =>
    (key !== 'businessIdentity.programAccountNumber' ||
      reviewedBoolean('businessIdentity.hasProgramAccount') !== false) &&
    (!/^businessIdentity\.internetSite[1-5]$/.test(key) ||
      siteCount === null ||
      siteCount >= BigInt(key.slice(-1))) &&
    active(key) &&
    (key !== 'identity.email' ||
      bool('identity.emailNotifications') ||
      bool('identity.ontarioContactSharingConsent'));
  const valid = (key: string, type: string) => {
    const fact = facts.get(key);
    if (!fact || fact.reviewState !== 'reviewed' || fact.value.type !== type)
      return false;
    if (
      key === 'businessIdentity.internetSiteCount' &&
      !/^(0|[1-9]\d*)$/.test(String(fact.value.value))
    )
      return false;
    if (
      key === 'businessIdentity.internetIncomePercentage' &&
      (compare(decimal(String(fact.value.value)), decimal('0')) < 0n ||
        compare(decimal(String(fact.value.value)), decimal('100')) > 0n)
    )
      return false;
    if (
      key === 'businessIdentity.industryCode' &&
      !/^\d{6}$/.test(String(fact.value.value))
    )
      return false;
    if (
      key === 'businessIdentity.fiscalStart' &&
      fact.value.value !== '2025-01-01'
    )
      return false;
    if (
      key === 'businessIdentity.fiscalEnd' &&
      fact.value.value !== '2025-12-31'
    )
      return false;
    if (
      key === 'businessIdentity.programAccountNumber' &&
      !/^\d{9}[A-Z]{2}\d{4}$/.test(String(fact.value.value))
    )
      return false;
    if (type === 'text' && !String(fact.value.value).trim()) return false;
    if (
      key === 'identity.taxNumber' &&
      !/^\d{9}$/.test(String(fact.value.value))
    )
      return false;
    if (
      key === 'identity.language' &&
      !['en', 'fr'].includes(String(fact.value.value))
    )
      return false;
    if (
      key === 'identity.specifiedForeignProperty' &&
      fact.value.value !== false
    )
      return false;
    return true;
  };
  // T2125 page 1 and CRA T4002 Chapter 2 require the assigned 15-character
  // program account and up to five highest-income website addresses.
  // https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/t4002/t4002-4.html
  if (
    reviewedBoolean('businessIdentity.hasProgramAccount') === false &&
    facts.has('businessIdentity.programAccountNumber')
  )
    issues.push(
      'contradictory-form-fact:businessIdentity.programAccountNumber',
    );
  for (let n = 1; n <= 5; n++)
    if (
      siteCount !== null &&
      siteCount < BigInt(n) &&
      facts.has(`businessIdentity.internetSite${n}`)
    )
      issues.push(`contradictory-form-fact:businessIdentity.internetSite${n}`);
  if (
    siteCount === 0n &&
    valid('businessIdentity.internetIncomePercentage', 'decimal') &&
    compare(
      decimal(
        String(
          facts.get('businessIdentity.internetIncomePercentage')!.value.value,
        ),
      ),
      decimal('0'),
    ) !== 0n
  )
    issues.push(
      'contradictory-form-fact:businessIdentity.internetIncomePercentage',
    );
  const specs = [
    ...PERSONAL_REQUIRED_FORM_FACTS.map((r) => ({ ...r, sourceId: t1 })),
    ...(run.inputSnapshot?.scope.taxpayerType === 'sole-proprietor'
      ? PERSONAL_REQUIRED_BUSINESS_FORM_FACTS.map((r) => ({
          ...r,
          sourceId: 'cra-t2125-2025-fillable',
        }))
      : []),
  ];
  const requirements = specs.map((f) => ({
    ...f,
    required: isRequired(f.key),
    satisfied: facts.has(f.key) ? valid(f.key, f.type) : !isRequired(f.key),
    sourceId: f.sourceId,
    sourceBinding: facts.get(f.key)?.source ?? null,
  }));
  for (const req of requirements)
    if (!req.satisfied)
      issues.push(`missing-or-unreviewed-form-fact:${req.key}`);
  for (const key of facts.keys())
    if (!specs.some((r) => r.key === key))
      issues.push(`unknown-form-fact:${key}`);
  const guarded = (key: string) =>
    run.status !== 'blocked' &&
    run.inputSnapshot?.facts.some(
      (f) =>
        f.key === key &&
        f.reviewState === 'reviewed' &&
        f.value.type === 'boolean' &&
        f.value.value,
    );
  const workflowText = (key: string) => {
    if (run.status === 'blocked') return null;
    const matches = run.inputSnapshot?.facts.filter((f) => f.key === key) ?? [];
    const fact = matches.length === 1 ? matches[0] : undefined;
    return fact?.reviewState === 'reviewed' && fact.value.type === 'text'
      ? fact.value.value
      : null;
  };
  const values = new Map(run.fields.map((f) => [f.id, f]));
  const proofs = Object.entries(PERSONAL_PAPER_FIELD_PROOFS);
  const fields = PERSONAL_COMPLETE_FIELD_CATALOG.map((entry) => {
    let decision: Decision = 'unresolved-field',
      reason = 'No reviewed applicability or field mapping yet';
    let fieldId: string | null = null;
    let inputValue: string | boolean | null = null;
    let selected: boolean | null = null;
    const hash = PERSONAL_PAPER_PRECISION_SOURCES.find(
      (s) => s.id === entry.sourceId,
    )!.documentHash;
    const mapped = proofs.find(
      ([, p]) => p.sourceId === entry.sourceId && p.path === entry.path,
    );
    const field = mapped ? values.get(mapped[0]) : null;
    const healthRowMatch =
      entry.sourceId === 'cra-5006-c-2025-fillable'
        ? entry.path.match(
            /^form1\.Page4\.ON_Health_Prenium-worksheet\.Chart_ON_Health_Prenium\.Taxable_Line(2|4|6|8|10)\.Amount[1-4]$/,
          )
        : null;
    const healthIncome =
      run.status !== 'blocked' ? values.get('ONHealthPremium.1') : null;
    const inactiveHealthRow =
      healthRowMatch &&
      healthIncome &&
      Number(healthRowMatch[1]) !==
        canada2025OntarioHealthPremiumRow(
          rational(
            BigInt(healthIncome.exactRational.numerator),
            BigInt(healthIncome.exactRational.denominator),
          ),
        );
    const surtaxBase = run.status !== 'blocked' ? values.get('ON428.65') : null;
    const inactiveSurtaxRow =
      entry.sourceId === 'cra-5006-c-2025-fillable' &&
      /^form1\.Page3\.Line(66|67)\.Amount[12]$/.test(entry.path) &&
      surtaxBase &&
      compare(
        rational(
          BigInt(surtaxBase.exactRational.numerator),
          BigInt(surtaxBase.exactRational.denominator),
        ),
        decimal('5710'),
      ) <= 0n;
    const bracketMatch =
      entry.sourceId === 'cra-5006-c-2025-fillable'
        ? entry.path.match(
            /^form1\.Page1\.Chart\.Column([1-5])\.Line(2|4|6|8)\.Amount$/,
          )
        : null;
    const bracketIncome =
      run.status !== 'blocked' ? values.get('ON428.1') : null;
    const inactiveBracketColumn =
      bracketMatch &&
      bracketIncome &&
      Number(bracketMatch[1]) !==
        canada2025OntarioBracketColumn(
          rational(
            BigInt(bracketIncome.exactRational.numerator),
            BigInt(bracketIncome.exactRational.denominator),
          ),
        );
    const federalTaxColumnMatch =
      entry.sourceId === t1
        ? entry.path.match(
            /^form1\.Page5\.PartA\.Column([1-5])\.(Line(?:36|37|38|40|41|42)Amount\d+)$/,
          )
        : null;
    const federalTaxRateMatch =
      entry.sourceId === t1
        ? entry.path.match(
            /^form1\.Page5\.PartA\.Column([1-5])\.Line39Rate\d+$/,
          )
        : null;
    const federalTaxIncome =
      run.status !== 'blocked' ? values.get('T1.26000') : null;
    const federalTaxColumnEntry = federalTaxColumnMatch || federalTaxRateMatch;
    const inactiveFederalTaxColumn =
      federalTaxColumnEntry &&
      federalTaxIncome &&
      Number(federalTaxColumnEntry[1]) !==
        canada2025FederalTaxColumn(
          rational(
            BigInt(federalTaxIncome.exactRational.numerator),
            BigInt(federalTaxIncome.exactRational.denominator),
          ),
        );
    const excludedBranch = personalT1ExcludedBranch(
      entry.sourceId,
      entry.label,
      guarded,
    );
    if (
      entry.kind === 'button' ||
      /(?:Page_number|Pages|PageNumbers|PageNumbers|\.Page)\.(?:CurrentPage|PageCount)$/.test(
        entry.path,
      )
    ) {
      decision = 'source-layout';
      reason = 'Captured form navigation/layout control';
    } else if (
      entry.sourceId === 'cra-5006-c-2025-fillable' &&
      /^(?:form1\.Page1\.Chart\.Column[1-5]\.Line(?:3\.Amount|5\.Percent|7\.Amount)|form1\.Page2\.Line45\.Percent_ReadOnly)$/.test(
        entry.path,
      ) &&
      entry.access === 'readOnly' &&
      entry.defaultValue !== null
    ) {
      decision = 'source-layout';
      reason = 'Published Ontario constant captured from the source form';
      inputValue = entry.defaultValue;
    } else if (
      entry.sourceId === t1 &&
      entry.path.startsWith('form1.Page8.Certification.')
    ) {
      decision = 'manual-signing';
      reason =
        'Taxpayer completes signature, date and contact details manually; not signed by EMDO';
    } else if (
      entry.sourceId === 'cra-t2125-2025-fillable' &&
      run.inputSnapshot?.scope.taxpayerType === 'individual' &&
      run.status !== 'blocked'
    ) {
      decision = 'not-applicable';
      reason = 'Reviewed individual case has no business income';
    } else if (
      entry.sourceId === 'cra-5000-s8-2025-fillable' &&
      run.cpp &&
      'branch' in run.cpp &&
      ((run.cpp.branch === 'self-employment-only' &&
        /\.Part3/.test(entry.path)) ||
        (run.cpp.branch !== 'self-employment-only' &&
          /\.Part4/.test(entry.path)) ||
        (run.cpp.branch !== 'mixed' && /\.Part5/.test(entry.path)))
    ) {
      decision = 'not-applicable';
      reason =
        'Schedule8 page1 parts-to-complete instruction and evaluated income branch';
    } else if (
      ((entry.sourceId === 'cra-5006-a-2025-fillable' &&
        entry.path.includes('.PartB.')) ||
        (entry.sourceId === t1 && entry.path.includes('.Info_Spouse_CLP.'))) &&
      guarded('scope.singleNoDependants')
    ) {
      decision = 'not-applicable';
      reason = 'Reviewed single/no-spouse scope';
    } else if (inactiveBracketColumn) {
      decision = 'not-applicable';
      reason =
        'Captured ON428 PartA instruction: another column selected by computed taxable income';
    } else if (inactiveSurtaxRow) {
      decision = 'not-applicable';
      reason =
        'Captured ON428 instruction: computed line65 does not exceed5710; lines66 and67 are skipped';
    } else if (inactiveHealthRow) {
      decision = 'not-applicable';
      reason =
        'Captured ON428 health-premium worksheet: another row selected by computed T1 taxable income';
    } else if (inactiveFederalTaxColumn) {
      decision = 'not-applicable';
      reason =
        'Captured T1 Part A instruction: another federal tax column selected by computed taxable income';
    } else if (federalTaxRateMatch && federalTaxIncome) {
      decision = 'source-layout';
      reason =
        'Published federal Part A rate constant captured from the source form';
    } else if (field) {
      fieldId = field.id;
      decision =
        field.reportableAmount === null ? 'reporting-blocked' : 'mapped-amount';
      reason = field.reporting.status;
    } else if (excludedBranch) {
      decision = 'not-applicable';
      reason = `${excludedBranch.guard}: ${excludedBranch.instruction}`;
    } else if (
      entry.sourceId === 'cra-t2125-2025-fillable' &&
      entry.path === businessPrefix + 'cbGrp.cb' &&
      (entry.occurrence === 2 || entry.occurrence === 3)
    ) {
      const kind = workflowText('business.incomeKind');
      const method = workflowText('business.reportingMethod');
      const methodReady = method === 'cash' || method === 'accrual';
      if (kind === 'business' && method === 'accrual') {
        decision = 'not-applicable';
        reason =
          'Reviewed noncommission business; these accounting controls are commission-only';
      } else {
        decision =
          kind === 'commission' && methodReady
            ? 'reviewed-input'
            : 'missing-input';
        reason = 'Accounting method bound to reviewed calculation snapshot';
        if (decision === 'reviewed-input') {
          inputValue = method!;
          selected = entry.occurrence === (method === 'cash' ? 2 : 3);
        }
      }
    } else if (
      entry.sourceId === 'cra-t2125-2025-fillable' &&
      entry.path === businessPrefix + 'Prt1_Frm_inpt1'
    ) {
      const ready =
        valid('identity.firstName', 'text') &&
        valid('identity.lastName', 'text');
      decision = ready ? 'reviewed-input' : 'missing-input';
      reason =
        'Proprietor name transferred from reviewed identity.firstName and identity.lastName';
      if (ready)
        inputValue = `${facts.get('identity.firstName')!.value.value} ${facts.get('identity.lastName')!.value.value}`;
    } else if (
      entry.sourceId === 'cra-t2125-2025-fillable' &&
      entry.path ===
        businessPrefix +
          'Prt1_Frm_grp1.Prt1_Frm_grp1_grp2.Prt1_Frm_grp1_grp2_inpt2'
    ) {
      decision = valid('identity.taxNumber', 'text')
        ? 'reviewed-input'
        : 'missing-input';
      reason = 'Proprietor number transferred from reviewed identity.taxNumber';
      if (decision === 'reviewed-input')
        inputValue = String(facts.get('identity.taxNumber')!.value.value);
    } else if (
      entry.sourceId === 'cra-t2125-2025-fillable' &&
      entry.path === businessPrefix + 'cbGrp.cb' &&
      entry.occurrence < 2
    ) {
      const last = reviewedBoolean('businessIdentity.lastBusinessYear');
      decision = last === null ? 'missing-input' : 'reviewed-input';
      reason = 'Captured T2125 page 1 explicit last-business-year choice';
      if (last !== null) selected = entry.occurrence === 0 ? last : !last;
    } else {
      const matched = requirements.filter(
        (r) =>
          r.sourceId === entry.sourceId &&
          !(
            r.key === 'businessIdentity.lastBusinessYear' &&
            entry.occurrence >= 2
          ) &&
          (entry.path === r.path ||
            (r.path.endsWith('.') && entry.path.startsWith(r.path))),
      );
      if (matched.length) {
        decision = matched.every((r) => r.satisfied)
          ? 'reviewed-input'
          : 'missing-input';
        reason = matched.map((r) => r.key).join(',');
        if (
          matched.every((r) => !r.required && !facts.has(r.key)) ||
          (entry.sourceId === 'cra-t2125-2025-fillable' &&
            entry.path ===
              businessPrefix + 'Prt1_Frm_grp3.Prt1_Frm_grp3_inpt4' &&
            reviewedBoolean('businessIdentity.hasProgramAccount') === false &&
            !facts.has('businessIdentity.programAccountNumber'))
        ) {
          decision = 'not-applicable';
          reason += ': explicitly reviewed applicability excludes this field';
        } else if (decision === 'reviewed-input') {
          const valueRequirement = matched.find(
            (r) => r.key !== 'businessIdentity.hasProgramAccount',
          );
          if (valueRequirement && facts.has(valueRequirement.key))
            inputValue = String(facts.get(valueRequirement.key)!.value.value);
        }
      }
    }
    if (
      requirements.some(
        (r) =>
          r.sourceId === entry.sourceId &&
          r.path === entry.path &&
          issues.includes(`contradictory-form-fact:${r.key}`),
      )
    ) {
      decision = 'missing-input';
      reason = 'Contradictory reviewed form facts require correction';
      inputValue = null;
      selected = null;
    }
    return {
      sourceId: entry.sourceId,
      documentHash: hash,
      fieldPath: entry.path,
      occurrence: entry.occurrence,
      label: entry.label,
      kind: entry.kind,
      fieldId,
      inputValue,
      selected,
      decision,
      reason,
    };
  });
  const unresolvedCount = fields.filter((f) =>
    ['unresolved-field', 'missing-input', 'reporting-blocked'].includes(
      f.decision,
    ),
  ).length;
  return deepFreeze({
    version: PERSONAL_FORM_APPLICABILITY_VERSION,
    runHash: run.runHash,
    packageVersion: run.packageVersion,
    complete: false as const,
    formDataReady: false as const,
    signature: {
      status: 'manual-unperformed' as const,
      blocksCalculation: false,
    },
    fieldCount: fields.length,
    unresolvedCount,
    requirements,
    fields,
    issues,
    remainingProof: [
      'complete-form-field-applicability',
      'authoritative-subcent-rounding',
      'independent-complete-return-expected-fixtures',
    ],
  });
}

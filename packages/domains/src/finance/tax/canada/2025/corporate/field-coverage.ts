import { deepFreeze } from '@emdo/contracts';
import { validateCorporateFieldValue } from './field-validation.js';
import { CANADA_CORPORATE_2025_SOURCES } from './sources.js';
import {
  CORPORATE_XFA_FIELDS,
  type CorporateXfaField,
} from './xfa-inventory.js';
import type { CanadaCorporate2025Intake } from './intake.js';
import type { buildCorporateReporting } from './reporting.js';

type Classification =
  'populated' | 'inapplicable' | 'user-required' | 'unresolved';
type Decision = {
  classification: Classification;
  predicate: string;
  logicalField: string | null;
  value: unknown;
};
const decision = (
  classification: Classification,
  predicate: string,
  logicalField: string | null = null,
  value: unknown = null,
): Decision => ({ classification, predicate, logicalField, value });

/** Exhaustive field-instance ledger. Unknown fields remain visible; no blanket assertion that an unused field is optional. */
export function buildCorporateFieldCoverage(
  input: CanadaCorporate2025Intake,
  forms: ReturnType<typeof buildCorporateReporting>['forms'],
  reporting: ReturnType<typeof buildCorporateReporting>,
) {
  const financial = new Map<string, Decision>();
  for (const report of reporting.fields)
    for (const binding of report.bindings) {
      financial.set(
        `${binding.field.form}:${binding.field.ordinal}`,
        decision(
          report.reportableAmount === null ? 'unresolved' : 'populated',
          report.status,
          report.id,
          report.reportableAmount,
        ),
      );
      if (binding.companionCodeField)
        financial.set(
          `${binding.companionCodeField.form}:${binding.companionCodeField.ordinal}`,
          decision(
            'populated',
            'Selected GIFI classification from the validated financial-statement adapter.',
            report.id,
            binding.companionCodeValue,
          ),
        );
    }
  for (const report of reporting.numericNonMoneyFields)
    for (const binding of report.bindings)
      financial.set(
        `${binding.field.form}:${binding.field.ordinal}`,
        decision(
          report.reportableValue === null ? 'unresolved' : 'populated',
          report.status,
          report.id,
          report.reportableValue,
        ),
      );
  const byForm = new Map(forms.map((form) => [form.id, form.fields]));
  function classify(field: CorporateXfaField): Decision {
    if (field.form === 'S500' && [14, 15, 16].includes(field.ordinal))
      return decision(
        'inapplicable',
        'S500 pre-April7,2022 business-limit reduction branch; tax year begins2025-01-01.',
      );
    const known = financial.get(`${field.form}:${field.ordinal}`);
    if (known) return known;
    const assist = field.assist?.trim() ?? '';
    const leaf = field.path.split('.').at(-1)!;
    if (/^(ClearData_EN|CurrentPage|PageCount|Footnote\w*|Note\d+)$/.test(leaf))
      return decision(
        'inapplicable',
        'PDF presentation/navigation control, not a return input.',
      );
    const values = byForm.get(field.form)!;
    const line = /^Line (\d{3,4})\./.exec(assist)?.[1];
    if (field.form !== 'T2') {
      if (/^Corporation's name\.?$/.test(assist))
        return decision(
          'populated',
          'Same legal entity on each applicable schedule.',
          'identity.legalName',
          [input.identity.legalName, input.identity.legalNameContinuation]
            .filter(Boolean)
            .join(' '),
        );
      if (assist.startsWith('Business number.'))
        return decision(
          'populated',
          'Same corporation account on each applicable schedule.',
          'identity.businessNumber',
          input.identity.businessNumber,
        );
      if (/^Tax year[- ]end/.test(assist))
        return decision(
          'populated',
          'Same tax period on each applicable schedule.',
          'identity.taxYearEnd',
          input.identity.taxYearEnd,
        );
    }
    if (field.form === 'T2') {
      if (
        field.path.includes('.Page5.') &&
        ['490', '500', '505'].includes(line ?? '') &&
        input.attachmentAnswers['207'] === false
      )
        return decision(
          'inapplicable',
          'attachmentAnswers.207 === false: no specified corporate income or business-limit assignment; lines510/515 explicitly zero.',
        );
      if (field.path.includes('.Page5.Tax_Reduction_sub.'))
        return decision(
          'inapplicable',
          'T2 page 5 instructs CCPCs not to complete the separate general tax reduction section; declarations.ccpcThroughout === true.',
        );
      if (field.ordinal === 2)
        return decision(
          'populated',
          'BN base: first nine digits.',
          'identity.businessNumber',
          input.identity.businessNumber.slice(0, 9),
        );
      if (field.ordinal === 3)
        return decision(
          'populated',
          'Corporation income-tax program identifier.',
          'identity.businessNumber',
          'RC',
        );
      if (field.ordinal === 4)
        return decision(
          'populated',
          'BN program account: last four digits.',
          'identity.businessNumber',
          input.identity.businessNumber.slice(-4),
        );
      if (field.ordinal === 5)
        return decision(
          'populated',
          'Legal name, first line; no truncation.',
          'identity.legalName',
          [input.identity.legalName, input.identity.legalNameContinuation]
            .filter(Boolean)
            .join(' '),
        );
      if (field.ordinal === 6)
        return input.identity.legalNameContinuation === null
          ? decision(
              'inapplicable',
              'identity.legalNameContinuation === null (explicitly no second name line).',
            )
          : decision(
              'populated',
              'Supplied legal name continuation.',
              'identity.legalNameContinuation',
              input.identity.legalNameContinuation,
            );
      if (field.ordinal >= 32 && field.ordinal <= 36)
        return decision(
          'populated',
          'declarations.ccpcThroughout === true; selected corporation type is 1.',
          'T2.040',
          field.ordinal === 32,
        );
      if (
        [
          '011',
          '012',
          '015',
          '016',
          '017',
          '018',
          '021',
          '022',
          '023',
          '025',
          '026',
          '027',
          '028',
          '031',
          '032',
          '035',
          '036',
          '037',
          '038',
        ].includes(line ?? '')
      )
        return decision(
          'inapplicable',
          'identity.addressesUnchangedAndSame === true; T2 010/020/030 are No, and not a first/amalgamated return.',
        );
      if (line === '043' || field.ordinal === 37)
        return decision(
          'inapplicable',
          'declarations.ccpcThroughout === true; no type change or other corporation type.',
        );
      if (line === '065')
        return decision(
          'inapplicable',
          'T2.063 === false; no acquisition of control.',
        );
      if (line === '079')
        return decision(
          'inapplicable',
          'currency === CAD and declarations.noOtherElectionsOrSpecialTaxes === true.',
        );
      if (line === '081' || line === '082')
        return decision(
          'inapplicable',
          'declarations.residentCanadaThroughout === true; non-resident treaty questions do not apply.',
        );
      if (field.ordinal >= 64 && field.ordinal <= 66)
        return decision(
          'inapplicable',
          'additionalInformation.taxExemptUnderSection149 === false.',
        );
      if (
        ['286', '287', '288', '289'].includes(line ?? '') &&
        values[line!] === null
      )
        return decision(
          'inapplicable',
          'No supplied second/third principal activity; supplied activity percentages total 100.',
        );
      if (
        line === '294' &&
        input.additionalInformation.quarterlyEligibilityCeasedOn === null
      )
        return decision(
          'inapplicable',
          'Explicitly no cessation of quarterly eligibility during this tax year.',
        );
      if (
        line === '295' &&
        !input.additionalInformation.constructionIsMajorBusinessActivity
      )
        return decision(
          'inapplicable',
          'additionalInformation.constructionIsMajorBusinessActivity === false.',
        );
      if (line === '920' || line === '925')
        return decision(
          'inapplicable',
          'declarations.noTaxPreparerFee === true; fee-preparer identifiers do not apply.',
        );
      if (line === '955')
        return decision(
          'inapplicable',
          'Private unsigned review export; certification and filing are outside scope.',
        );
      if (line === '958' || line === '959')
        return decision(
          'inapplicable',
          'identity.signingOfficer.contactIsSigningOfficer === true.',
        );
      if (
        line === '894' &&
        reporting.fields.find((f) => f.id === 'T2.refund')?.encodedAmount ===
          '0'
      )
        return decision(
          'inapplicable',
          'Exact refund is zero; no refund allocation is needed.',
        );
      if (
        line === '894' &&
        ['refund', 'next-year-instalments'].includes(
          input.additionalInformation.refundPreference ?? '',
        )
      )
        return decision(
          'populated',
          'T4012 E(25) page 138, line 894: 1 refund, 2 transfer to next-year instalments. This records a preference only.',
          'additionalInformation.refundPreference',
          input.additionalInformation.refundPreference === 'refund' ? '1' : '2',
        );
      if (line === '894')
        return decision(
          'user-required',
          'Positive refund: an explicit allocation preference or instructions for another liability are still required; T4012 page 138.',
          'T2.894',
        );
    }
    if (field.form === 'S500' && field.ordinal >= 39)
      return decision(
        'inapplicable',
        'S500 Parts3/4 apply to Ontario manufacturing credit or credit unions; attachment217/227 false and no other provincial credits.',
      );
    if (leaf === 'designer__defaultHyphenation')
      return decision(
        'inapplicable',
        'PDF layout hyphenation setting, not a return fact.',
      );
    if (field.form === 'GIFI100' && field.ordinal === 197)
      return decision(
        'populated',
        'Fixed GIFI total liabilities and equity code printed on the form.',
        'GIFI100.3640',
        '3640',
      );
    if (field.form === 'GIFI125') {
      if (
        /[Ff]arm(?:ing)?/.test(assist) &&
        !/Non-farming|non-farming/.test(assist)
      )
        return decision(
          'inapplicable',
          'financialStatements.incomeStatementActivity === non-farming; no farming statement is supplied.',
        );
      if (field.path.includes('.Pg2_Table5.'))
        return decision(
          'inapplicable',
          'Explicit otherComprehensiveIncome === 0 and noOtherEquityMovements; no OCI components to report.',
        );
      if (field.path.includes('.Pg2_Sch140.'))
        return decision(
          'inapplicable',
          'One complete income statement (sequence01); RC4088 summary statement applies when reporting multiple income statements.',
        );
    }
    if (field.form === 'S5') {
      if (field.path.includes('.Part1_SF.'))
        return decision(
          'inapplicable',
          'T4012 Part1 of Schedule5: allocation required for permanent establishments in multiple jurisdictions; declared Ontario-only, no partnership.',
        );
      if (
        [
          '.Prt2_NFL_PEI_SF.',
          '.NS_SF.',
          '.NB_SF.',
          '.Prt2_MB_SK_SF.',
          '.Prt_2_BC_YK_SF.',
          '.Prt2_NWT_NV_SF.',
        ].some((path) => field.path.includes(path))
      )
        return decision(
          'inapplicable',
          'Declared Ontario-only permanent establishment; other province/territory tax computation. Mapped total255 remains populated.',
        );
    }
    if (
      field.form === 'S1' &&
      (field.path.includes('.P3_table.') || field.path.includes('.P4_table.'))
    )
      return decision(
        'inapplicable',
        'declarations.noOtherTaxAdjustmentsOrLossPools === true: no free-form other additions/deductions rows.',
      );
    if (field.form === 'S50') {
      const row = /Row (\d+)\./.exec(assist)?.[1];
      if (row && Number(row) > 1)
        return decision(
          'inapplicable',
          'Exactly one shareholder, declared sole individual Canadian-resident common shareholder.',
        );
      if (line === '200' || line === '350')
        return decision(
          'inapplicable',
          'The shareholder is an individual; SIN supplied on line 300, not corporation/partnership/trust account.',
        );
    }
    if (
      (field.form === 'GIFI100' || field.form === 'GIFI125') &&
      /\. (?:Field [Cc]ode|Amount)\. Row \d+\.$/.test(assist)
    ) {
      const category = assist.replace(
        /\. (?:Field [Cc]ode|Amount)\. Row \d+\.$/,
        '',
      );
      const selectedRows = reporting.fields
        .flatMap((r) => r.bindings)
        .filter(
          (b) =>
            b.field.form === field.form &&
            b.field.assist?.startsWith(`${category}. Amount. Row `),
        );
      if (selectedRows.length > 0)
        return decision(
          'inapplicable',
          `Unused repeating ${category} slot after ${selectedRows.length} populated rows; declarations.completeFinancialStatements and noUnreportedLiabilitiesAssetsOrIncome are true.`,
        );
    }
    if (field.form === 'GIFI141') {
      if (
        ['310', '311', '312', '313', '314'].includes(line ?? '') &&
        (input.gifi141.returnPreparerIsPrimaryPreparer ||
          !input.gifi141.returnPreparerAccountingDesignation)
      )
        return decision(
          'inapplicable',
          'Part 5 applies only to a different return preparer with an accounting designation.',
        );
      if (
        (line === '095' || line === '097') &&
        !input.gifi141.primaryPreparerIdentified
      )
        return decision(
          'inapplicable',
          'GIFI141.111 === false; Part 1 instructs proceeding to Part 2.',
        );
      if (
        line === '099' &&
        !input.gifi141.involvement.some((v) => v === '300' || v === '301')
      )
        return decision(
          'inapplicable',
          'No audit or review engagement selected; reservation question is conditional.',
        );
      if (line === '305' && !input.gifi141.involvement.includes('305'))
        return decision('inapplicable', 'No other involvement selected.');
      if (line === '314' && !input.gifi141.returnPreparerInputs.includes('314'))
        return decision(
          'inapplicable',
          'No other return-preparer input selected.',
        );
      if (
        [
          '210',
          '211',
          '215',
          '216',
          '220',
          '225',
          '230',
          '231',
          '235',
          '236',
        ].includes(line ?? '')
      )
        return decision(
          'inapplicable',
          'gifi141.impairmentOrFairValueChanges === false; no amount recognized under line 200.',
        );
    }
    if (line && Object.hasOwn(values, line) && values[line] !== null) {
      const value = values[line];
      if (typeof value === 'boolean') {
        const option = /[.?] (Yes|No)\./.exec(assist)?.[1];
        return decision(
          'populated',
          option
            ? `Explicit ${option} option from the validated answer.`
            : 'Explicit checkbox answer from the validated questionnaire.',
          `${field.form}.${line}`,
          option ? value === (option === 'Yes') : value,
        );
      }
      if (typeof value === 'string')
        return decision(
          'populated',
          'Supplied or deterministic logical value; field-level length/character validation remains separately required.',
          `${field.form}.${line}`,
          value,
        );
    }
    return decision(
      'unresolved',
      'Applicability or exact field mapping not yet proven; retained for review.',
    );
  }
  const fields = CORPORATE_XFA_FIELDS.map((field) => ({
    form: field.form,
    ordinal: field.ordinal,
    path: field.path,
    sourceFile: field.sourceFile,
    sourceSha256: CANADA_CORPORATE_2025_SOURCES.find(
      (source) => source.file === field.sourceFile,
    )!.sha256,
    assist: field.assist,
    ...classify(field),
    validation:
      classify(field).classification === 'populated'
        ? validateCorporateFieldValue(field, classify(field).value)
        : null,
  }));
  return deepFreeze({
    version: 2,
    complete: false,
    proof: 'private-review-field-instance-mapping',
    fields,
    unresolvedValidationFields: fields.filter(
      (field) => field.validation?.status === 'rules-unresolved',
    ),
    unresolvedFields: fields.filter(
      (field) =>
        field.classification === 'unresolved' ||
        field.classification === 'user-required',
    ),
    attachments: CORPORATE_XFA_FIELDS.filter(
      (field) =>
        field.form === 'T2' &&
        /Attach (?:Schedule|Form|schedule)/.test(field.assist ?? ''),
    ).map((field) => {
      const line = /^Line (\d+)\./.exec(field.assist!)?.[1];
      return {
        line: line ?? null,
        sourceOrdinal: field.ordinal,
        instruction: field.assist,
        answer: line ? (byForm.get('T2')![line] ?? null) : null,
      };
    }),
  });
}

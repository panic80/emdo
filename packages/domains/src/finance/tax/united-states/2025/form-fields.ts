import { US_SCHEDULE_C_ACTIVITY_CODES } from './activity-codes.js';
import {
  deepFreeze,
  type FinanceTaxIntake,
  type FinanceTaxEvaluation,
} from '@emdo/contracts';
import { IRS_FIELD_CATALOG as rawCatalog } from './field-catalog-data.js';
export const US_2025_FIELD_CATALOG = deepFreeze(rawCatalog);
export const US_FORM_REQUIRED_FACTS = deepFreeze([
  ...[
    'identity.firstAndMiddleName',
    'identity.lastName',
    'identity.ssn',
    'identity.street',
    'identity.apartment',
    'identity.city',
    'identity.state',
    'identity.zip',
    'identity.occupation',
    'identity.phone',
    'identity.email',
    'identity.ipPin',
    'business.description',
    'business.code',
    'business.separateName',
    'business.ein',
    'business.street',
    'business.cityStateZip',
    'refund.method',
    'refund.routing',
    'refund.account',
  ].map((key) => ({ key, type: 'text' })),
  { key: 'identity.birthDate', type: 'date' },
  ...[
    'identity.presidentialFund',
    'refund.accountInTaxpayerName',
    'business.started2025',
    'business.requires1099',
    'business.filedOrWillFile1099',
  ].map((key) => ({ key, type: 'boolean' })),
  ...[
    'identity.specialFiling',
    'identity.deceased',
    'identity.digitalAssets',
    'identity.foreignAddress',
    'payments.formerSpouseEstimates',
    'thirdPartyDesignee',
    'identity.1099kErrorOrPersonalLoss',
  ].map((key) => ({ key, type: 'boolean', equals: false })),
  { key: 'selfPrepared', type: 'boolean', equals: true },
]);
const states = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(
    ' ',
  ),
);
export function validateUsFormFacts(intake: FinanceTaxIntake) {
  const facts = new Map(intake.facts.map((f) => [f.key, f.value.value]));
  const issues: { code: string; message: string }[] = [];
  const check = (key: string, valid: boolean, message: string) => {
    if (!valid)
      issues.push({
        code: 'invalid-form-field',
        message: `${key}: ${message}`,
      });
  };
  const value = (key: string) => String(facts.get(key));
  for (const required of US_FORM_REQUIRED_FACTS)
    if (required.type === 'text')
      check(
        required.key,
        ![...value(required.key)].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
        'single-line field cannot contain control characters',
      );
  check(
    'identity.ssn',
    /^\d{9}$/.test(value('identity.ssn')),
    'nine digits required by the form',
  );
  check(
    'identity.state',
    states.has(value('identity.state')),
    'supported domestic state or DC abbreviation required',
  );
  check(
    'identity.zip',
    /^\d{5}(?:-\d{4})?$/.test(value('identity.zip')),
    'five or nine digit ZIP required',
  );
  check(
    'business.code',
    US_SCHEDULE_C_ACTIVITY_CODES.includes(value('business.code')),
    'a published2025 ScheduleC activity code is required, not an arbitrary six-digit NAICS code',
  );
  check(
    'business.ein',
    value('business.ein') === 'none' || /^\d{9}$/.test(value('business.ein')),
    'nine digits or explicit none',
  );
  check(
    'identity.ipPin',
    value('identity.ipPin') === 'none' ||
      /^\d{6}$/.test(value('identity.ipPin')),
    'six digits or explicit none',
  );
  const birth = value('identity.birthDate');
  const age =
    2026 - Number(birth.slice(0, 4)) - (birth.slice(5) > '01-01' ? 1 : 0);
  check(
    'identity.birthDate',
    age >= 0 && age < 65,
    'this case excludes age65 or older; January1 birthday rule applies',
  );
  check(
    'eic.ageBand',
    facts.get('eic.ageBand') === (age < 25 ? 'under25' : '25-to-64'),
    'must agree with date of birth',
  );
  check(
    'refund.method',
    ['no-direct-deposit', 'checking', 'savings'].includes(
      value('refund.method'),
    ),
    'explicit refund delivery choice required',
  );
  if (value('refund.method') !== 'no-direct-deposit') {
    check(
      'refund.accountInTaxpayerName',
      facts.get('refund.accountInTaxpayerName') === true,
      'IRS direct-deposit account must be in taxpayer name',
    );
    check(
      'refund.routing',
      /^(?:0[1-9]|1[0-2]|2[1-9]|3[0-2])\d{7}$/.test(value('refund.routing')),
      'nine routing digits; first two must be01–12 or21–32',
    );
    check(
      'refund.account',
      /^[A-Za-z0-9-]{1,17}$/.test(value('refund.account')),
      'one to17 letters, digits or hyphens; no spaces',
    );
  } else {
    check(
      'refund.routing',
      value('refund.routing') === 'none',
      'explicit none required without direct deposit',
    );
    check(
      'refund.account',
      value('refund.account') === 'none',
      'explicit none required without direct deposit',
    );
  }
  return issues;
}
type Decision = {
  formId: string;
  fieldId: string;
  label: string;
  sourceId: string;
  sourceHash: string;
  status: 'populated' | 'inapplicable' | 'user-required' | 'unresolved';
  value: string | boolean | null;
  predicate: string;
  sourceFactKeys: string[];
  calculationKey: string | null;
  required: boolean;
};
/** A complete field inventory is not an attestation of a complete tax package.
 * XFA labels locate fields only; visible forms/instructions govern rules (6251 label5 is stale).
 */
export function buildUs2025FieldCoverage(
  intake: FinanceTaxIntake,
  evaluation: FinanceTaxEvaluation,
  requiredKeys: ReadonlySet<string>,
  rawTrace: readonly { formId: string; line: string; exactNumerator: string }[],
) {
  const facts = new Map(intake.facts.map((f) => [f.key, f]));
  const values = new Map(
    evaluation.forms.flatMap((form) =>
      form.fields.map(
        (field) => [`${form.id}.${field.key}`, field.value.value] as const,
      ),
    ),
  );
  const fact = (key: string) => facts.get(key)?.value.value;
  const positiveRaw = (key: string) => {
    const row = rawTrace.find((item) => `${item.formId}.${item.line}` === key);
    return row ? BigInt(row.exactNumerator) > 0n : false;
  };
  const fullName = `${fact('identity.firstAndMiddleName')} ${fact('identity.lastName')}`;
  const decisions: Decision[] = [];
  for (const field of US_2025_FIELD_CATALOG) {
    const { formId: form, fieldId: id, label } = field;
    const base = {
      formId: form,
      fieldId: id,
      label,
      sourceId: field.sourceId,
      sourceHash: field.sourceHash,
    };
    const emit = (
      status: Decision['status'],
      value: Decision['value'],
      predicate: string,
      keys: string[] = [],
      calculationKey: string | null = null,
      required = true,
    ) =>
      decisions.push({
        ...base,
        status,
        value,
        predicate,
        sourceFactKeys: keys,
        calculationKey,
        required,
      });
    const input = (key: string) => {
      const f = facts.get(key);
      if (!f || f.reviewState !== 'reviewed')
        emit('user-required', null, `reviewed ${key} required`, [key]);
      else if (f.value.value === 'none')
        emit('inapplicable', null, `${key}=explicit none`, [key], null, false);
      else emit('populated', f.value.value, `reviewed ${key}`, [key]);
    };
    const na = (predicate: string, keys: string[] = []) =>
      emit('inapplicable', null, predicate, keys, null, false);
    const check = (value: boolean, predicate: string, keys: string[] = []) =>
      emit('populated', value, predicate, keys);
    const monetary = (key: string) => {
      const value = values.get(`${form}.${key}`);
      if (value === undefined) return false;
      emit(
        'populated',
        value,
        `calculated ${form}.${key}`,
        [],
        `${form}.${key}`,
      );
      return true;
    };
    // Header copies are source-bound; never invent a preparer or a signature.
    if (
      form !== 'F1040' &&
      /Name of proprietor|Name\(s\) shown|Name of person with self-employment/.test(
        label,
      )
    ) {
      emit('populated', fullName, 'name copied from reviewed1040 identity', [
        'identity.firstAndMiddleName',
        'identity.lastName',
      ]);
      continue;
    }
    if (
      form !== 'F1040' &&
      /^(?:Your )?social security number|^Social security number|^Your taxpayer identification|^Identifying number/i.test(
        label,
      )
    ) {
      input('identity.ssn');
      continue;
    }
    if (form === 'F1040') {
      const direct: Record<string, string> = {
        'f1_14[0]': 'identity.firstAndMiddleName',
        'f1_15[0]': 'identity.lastName',
        'f1_16[0]': 'identity.ssn',
        'f1_20[0]': 'identity.street',
        'f1_21[0]': 'identity.apartment',
        'f1_22[0]': 'identity.city',
        'f1_23[0]': 'identity.state',
        'f1_24[0]': 'identity.zip',
        'f2_40[0]': 'identity.occupation',
        'f2_41[0]': 'identity.ipPin',
        'f2_44[0]': 'identity.phone',
        'f2_45[0]': 'identity.email',
      };
      if (direct[id]) {
        input(direct[id]);
        continue;
      }
      if (id === 'c1_5[0]') {
        check(
          fact('eic.mainHomeInUsMoreThanHalfYear') === true,
          'reviewed main-home answer',
          ['eic.mainHomeInUsMoreThanHalfYear'],
        );
        continue;
      }
      if (id === 'c1_6[0]') {
        check(
          fact('identity.presidentialFund') === true,
          'voluntary presidential-fund choice',
          ['identity.presidentialFund'],
        );
        continue;
      }
      if (id.startsWith('c1_8[')) {
        check(id === 'c1_8[0]', 'filingStatus=single', ['filingStatus']);
        continue;
      }
      if (id.startsWith('c1_10[')) {
        check(id === 'c1_10[1]', 'identity.digitalAssets=false', [
          'identity.digitalAssets',
        ]);
        continue;
      }
      if (id.startsWith('c2_17[')) {
        check(id === 'c2_17[1]', 'thirdPartyDesignee=false', [
          'thirdPartyDesignee',
        ]);
        continue;
      }
      if (['f2_32[0]', 'f2_33[0]', 'c2_16[0]', 'c2_16[1]'].includes(id)) {
        if (
          fact('refund.method') === 'no-direct-deposit' ||
          values.get('F1040.35a') === '0'
        ) {
          na('no direct-deposit election or no refundable amount', [
            'refund.method',
          ]);
          continue;
        }
        if (id === 'f2_32[0]') input('refund.routing');
        else if (id === 'f2_33[0]') input('refund.account');
        else
          check(
            fact('refund.method') ===
              (id === 'c2_16[0]' ? 'checking' : 'savings'),
            'exactly one elected account type',
            ['refund.method'],
          );
        continue;
      }
      if (id === 'f2_07[0]') {
        na('no special tax form/type on line16', ['otherTaxesOrRecaptures']);
        continue;
      }
      if (id === 'f2_17[0]') {
        monetary('25a');
        continue;
      }
      if (id === 'c2_13[0]') {
        check(
          values.get('F1040.27a') === '0',
          'EIC worksheet zero/ineligible instruction to check27c',
          ['eic.ageBand', 'eic.validEmploymentSsn'],
        );
        continue;
      }
      if (id === 'c2_15[0]') {
        check(false, 'single refund account; Form8888 not requested', [
          'refund.method',
        ]);
        continue;
      }
      if (id === 'f2_22[0]') {
        na('no former-spouse estimated payments', [
          'payments.formerSpouseEstimates',
        ]);
        continue;
      }
      const numeric = Number(id.match(/^f1_(\d+)/)?.[1]);
      if (numeric >= 1 && numeric <= 13) {
        na('calendar-year original living filer; no special filing notations', [
          'identity.specialFiling',
          'identity.deceased',
        ]);
        continue;
      }
      if (
        (numeric >= 17 && numeric <= 19) ||
        (numeric >= 25 && numeric <= 46)
      ) {
        na(
          numeric >= 31
            ? 'no dependants'
            : 'single domestic address; no spouse/foreign-address fields',
          ['filingStatus', 'dependants', 'identity.foreignAddress'],
        );
        continue;
      }
      if (['f2_37[0]', 'f2_38[0]', 'f2_39[0]'].includes(id)) {
        na('no third-party designee', ['thirdPartyDesignee']);
        continue;
      }
      if (['f2_42[0]', 'f2_43[0]'].includes(id)) {
        na('single filer: no spouse', ['filingStatus']);
        continue;
      }
      if (Number(id.match(/^f2_(\d+)/)?.[1]) >= 46 || id === 'c2_18[0]') {
        na('selfPrepared=true; paid-preparer fields do not apply', [
          'selfPrepared',
        ]);
        continue;
      }
      if (field.kind === 'checkbox') {
        na(
          'reviewed single/no-dependent/no-other-income or special-tax exclusions',
          [
            'filingStatus',
            'dependants',
            'otherIncome',
            'otherTaxesOrRecaptures',
            'identity.specialFiling',
          ],
        );
        continue;
      }
    }
    if (form === 'C') {
      const direct: Record<string, string> = {
        'f1_3[0]': 'business.description',
        'f1_4[0]': 'business.code',
        'f1_5[0]': 'business.separateName',
        'f1_6[0]': 'business.ein',
        'f1_7[0]': 'business.street',
        'f1_8[0]': 'business.cityStateZip',
      };
      if (direct[id]) {
        input(direct[id]);
        continue;
      }
      if (id.startsWith('c1_1[')) {
        check(id === 'c1_1[0]', 'accountingMethod=cash', ['accountingMethod']);
        continue;
      }
      if (id.startsWith('c1_2[')) {
        check(id === 'c1_2[0]', 'materialParticipation=true', [
          'materialParticipation',
        ]);
        continue;
      }
      if (id === 'c1_3[0]') {
        check(
          fact('business.started2025') === true,
          'reviewed started/acquired answer',
          ['business.started2025'],
        );
        continue;
      }
      if (id.startsWith('c1_4[')) {
        check(
          (id === 'c1_4[0]') === (fact('business.requires1099') === true),
          'reviewed1099 filing obligation',
          ['business.requires1099'],
        );
        continue;
      }
      if (id.startsWith('c1_5[')) {
        if (fact('business.requires1099') !== true)
          na('lineI=no; lineJ does not apply', ['business.requires1099']);
        else
          check(
            (id === 'c1_5[0]') ===
              (fact('business.filedOrWillFile1099') === true),
            'reviewed1099 filed/will-file answer',
            ['business.filedOrWillFile1099'],
          );
        continue;
      }
      if (id === 'f1_9[0]') {
        na('cash method, no other accounting method', ['accountingMethod']);
        continue;
      }
      if (id.startsWith('c1_7')) {
        na('nonnegative business profit: loss-at-risk choices do not apply');
        continue;
      }
      if (id === 'c1_6[0]') {
        check(false, 'statutoryEmployee=false', ['statutoryEmployee']);
        continue;
      }
      if (id === 'f1_43[0]' || id === 'f1_44[0]') {
        na('homeOffice=false; no simplified-area entries', ['homeOffice']);
        continue;
      }
      if (id.startsWith('f2_') || id.startsWith('c2_')) {
        na('no inventory, vehicle claim or other-expense list', [
          'inventory',
          'vehicleExpenses',
          'otherBusinessExpenses',
        ]);
        continue;
      }
    }
    if (form === 'F8995') {
      if (id === 'f1_03[0]') {
        emit(
          'populated',
          fact('business.separateName') === 'none'
            ? fullName
            : String(fact('business.separateName')),
          'one reviewed trade name',
          [
            'business.separateName',
            'identity.firstAndMiddleName',
            'identity.lastName',
          ],
        );
        continue;
      }
      if (id === 'f1_04[0]') {
        input(
          fact('business.ein') === 'none' ? 'identity.ssn' : 'business.ein',
        );
        continue;
      }
      if (id === 'f1_05[0]') {
        if (!monetary('1i.c'))
          emit('unresolved', null, 'missing calculated QBI');
        continue;
      }
      const number = Number(id.match(/^f1_(\d+)/)?.[1]);
      if (number >= 6 && number <= 17) {
        na('one business; rowsii–v are unused', ['multipleBusinesses']);
        continue;
      }
    }
    if (form === 'SE' && (id.startsWith('f2_') || id.startsWith('c1_'))) {
      na('ordinary nonfarm/nonclergy method; no optional election', [
        'optionalSeMethod',
        'churchOrClergy',
      ]);
      continue;
    }
    if (form === 'F6251' && id.startsWith('f2_')) {
      na('no capital gains or foreign earned income: PartIII not required', [
        'otherIncome',
        'foreignOrTerritoryIncome',
      ]);
      continue;
    }
    if (form === 'S2' && id === 'f1_14[0]') {
      na('no SE exemption notation', ['seExemption']);
      continue;
    }
    if (form === 'F2210') {
      na(
        'no PartII election: regular method retained as worksheet; Form2210 is not filed',
        [
          'penalty.waiverRequested',
          'penalty.annualizedElection',
          'penalty.actualWithholdingElection',
          'penalty.priorYearJointReturn',
        ],
      );
      continue;
    }
    // Accessible labels provide identifiers, not tax constants. Explicit overrides handle split line labels.
    const overrides: Record<string, string> = {
      'C:f1_35[0]': '24a',
      'C:f1_45[0]': '30',
      'F1040:f1_55[0]': '1h',
      'S2:f1_15[0]': '4',
    };
    const cleaned = label.replace(/^Page \d+\. /, '');
    const line =
      overrides[`${form}:${id}`] ??
      cleaned.match(/(?:^|\. )([1-9]\d*[a-z]?)\./)?.[1];
    if (field.kind === 'text' && line && monetary(line)) continue;
    if (field.kind === 'text' && line && requiredKeys.has(`${form}.${line}`)) {
      if (form === 'SE' && !values.has('SE.12')) {
        na('ScheduleSE stops at4c: actual net earnings below400', [
          'optionalSeMethod',
          'churchOrClergy',
        ]);
        continue;
      }
      if (
        form === 'SE' &&
        ['8b', '8c', '8d', '9', '10'].includes(line) &&
        !values.has('SE.10')
      ) {
        na('ScheduleSE8a wage ceiling branch skips8b–10', [
          'w2.box3',
          'w2.box7',
        ]);
        continue;
      }
      emit(
        'unresolved',
        null,
        `Required calculation ${form}.${line} was blocked`,
        [],
        `${form}.${line}`,
      );
      continue;
    }
    const excluded: Record<string, string[]> = {
      F1040: ['otherIncome', 'otherCreditClaims'],
      C: [
        'vehicleExpenses',
        'businessAssetsOrDepreciation',
        'employeesOrBenefitPlans',
        'businessInterest',
        'meals',
        'otherBusinessExpenses',
      ],
      SE: [
        'farmOrPartnership',
        'optionalSeMethod',
        'churchOrClergy',
        'unreportedTipsOrForm8919',
      ],
      S1: [
        'otherIncome',
        'otherAdjustments',
        'identity.1099kErrorOrPersonalLoss',
      ],
      S2: ['otherTaxesOrRecaptures', 'seExemption'],
      F6251: ['amtAdjustmentsOrPreferences'],
      F8959: ['railroadCompensation', 'unreportedTipsOrForm8919'],
    };
    if (excluded[form]) {
      na(
        `unclaimed/excluded ${form} field under reviewed applicability facts`,
        excluded[form],
      );
      continue;
    }
    emit(
      'unresolved',
      null,
      'No proven field binding or inapplicability predicate',
    );
  }
  return deepFreeze({
    sourceFieldCount: US_2025_FIELD_CATALOG.length,
    fields: decisions,
    unresolved: decisions
      .filter(
        (field) =>
          field.status === 'unresolved' || field.status === 'user-required',
      )
      .map((field) => `${field.formId}.${field.fieldId}`),
    executionActions: [
      {
        action: 'taxpayer-signature-and-date',
        status: 'required-before-filing',
        sourceId: 'irs-2025-f1040',
      },
    ],
    attachments: [
      { form: 'C', required: true, reason: 'sole-proprietor business' },
      {
        form: 'SE',
        required: values.has('SE.12'),
        reason: 'regular SE filing threshold',
      },
      { form: 'S1', required: true, reason: 'business income/SE deduction' },
      {
        form: 'S2',
        required: values.get('S2.21') !== '0' || values.get('S2.3') !== '0',
        reason: 'additional taxes',
      },
      {
        form: 'F8995',
        required: values.get('F8995.15') !== '0',
        reason: 'QBI deduction claimed',
      },
      {
        form: 'F6251',
        required: positiveRaw('F6251.11'),
        reason: 'AMT owed; other filing triggers separately excluded',
      },
      {
        form: 'F8959',
        required: positiveRaw('F8959.18') || positiveRaw('F8959.24'),
        reason: 'Additional Medicare tax/withholding',
      },
      {
        form: 'F2210',
        required: false,
        reason: 'ordinary regular method, no PartII boxes',
      },
      {
        form: 'W-2',
        required: intake.facts.some(
          (item) =>
            item.key.startsWith('w2.') &&
            item.value.type === 'decimal' &&
            BigInt(item.value.value.replace('.', '')) > 0n,
        ),
        reason: 'Form1040 attach wage statements',
      },
    ],
  });
}

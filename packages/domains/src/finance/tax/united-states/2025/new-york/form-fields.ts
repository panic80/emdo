import { deepFreeze, type FinanceTaxIntake } from '@emdo/contracts';
import { NY_FIELD_CATALOG } from './physical-fields.js';
import { NY_SCHOOL_DISTRICTS } from './school-district-data.js';
const schoolDistricts: readonly {
  county: string;
  district: string;
  code: string;
  sourceHash: string;
  url: string;
}[] = deepFreeze(NY_SCHOOL_DISTRICTS);
import { nyPhysicalFieldDecision } from './physical-fields.js';

export const NY_FORM_REQUIRED_FACTS = deepFreeze([
  ...[
    'identity.firstName',
    'identity.middleInitial',
    'identity.county',
    'identity.schoolDistrict',
    'identity.schoolDistrictCode',
    'identity.homeStreet',
    'identity.homeApartment',
    'identity.homeCity',
    'identity.homeZip',
    'refund.method',
    'refund.routing',
    'refund.account',
  ].map((key) => ({ key, type: 'text' })),
  ...[
    'identity.homeSameAsMailing',
    'identity.foreignAccount',
    'identity.nycQuarters',
    'identity.yonkersQuarters',
    'refund.accountInTaxpayerName',
  ].map((key) => ({ key, type: 'boolean' })),
  { key: 'identity.nycDays', type: 'decimal' },
  ...[
    'identity.specialConditions',
    'thirdPartyDesignee',
    'refund.split529',
    'payment.electronicWithdrawal',
    'refund.foreignAccount',
  ].map((key) => ({ key, type: 'boolean', equals: false })),
]);

/** Only reviewed facts reach this mapper through evaluateNewYork2025WorkingPapers.
 * Explicit “none” distinguishes an intentionally blank field from a missing input.
 * County/district are declared from actual Dec31 residence, never geocoded from mailing address.
 */
export function prepareNy201PhysicalFields(
  federal: FinanceTaxIntake,
  ny: FinanceTaxIntake,
  rows: readonly { key: string; value: string }[],
) {
  const values = new Map(ny.facts.map((fact) => [fact.key, fact.value.value]));
  const federalValues = new Map(
    federal.facts.map((fact) => [fact.key, fact.value.value]),
  );
  const text = (key: string) => String(values.get(key));
  const ft = (key: string) => String(federalValues.get(key));
  const optional = (value: string) => (value === 'none' ? null : value);
  const issues: string[] = [];
  for (const fact of NY_FORM_REQUIRED_FACTS) {
    const raw = ny.facts.find((entry) => entry.key === fact.key);
    if (
      !raw ||
      raw.reviewState !== 'reviewed' ||
      raw.value.type !== fact.type ||
      ('equals' in fact && raw.value.value !== fact.equals)
    )
      issues.push(`required-ny-${fact.key}`);
    if (
      fact.type === 'text' &&
      (!text(fact.key).trim() || text(fact.key) === 'undefined')
    )
      issues.push(`invalid-ny-${fact.key}`);
  }
  if (issues.length)
    return deepFreeze({ fields: [], issues, schoolDistrictSource: null });
  const district = schoolDistricts.find(
    (entry) =>
      entry.county === text('identity.county') &&
      entry.district === text('identity.schoolDistrict') &&
      entry.code === text('identity.schoolDistrictCode'),
  );
  if (!district) issues.push('ny-school-district-county-code-mismatch');
  // IRS2025 i1040gi p23 requires ScheduleB PartIII for a foreign account, even without interest income.
  if (values.get('identity.foreignAccount') === true)
    issues.push('federal-schedule-b-foreign-account-required');
  const city = values.get('localResidence') === 'NYC';
  const yonkers = values.get('localResidence') === 'Yonkers';
  const nycCounty = [
    'Bronx',
    'Kings',
    'New York',
    'Queens',
    'Richmond',
  ].includes(text('identity.county'));
  if (
    city !== nycCounty ||
    (yonkers && text('identity.county') !== 'Westchester')
  )
    issues.push('ny-local-residence-county-mismatch');
  const days = text('identity.nycDays');
  if (!/^\d{1,3}$/.test(days) || Number(days) > 365)
    issues.push('ny-nyc-days-invalid');
  if (city && values.get('identity.nycQuarters') !== true)
    issues.push('ny-nyc-residence-quarters-mismatch');
  if (yonkers && values.get('identity.yonkersQuarters') !== true)
    issues.push('ny-yonkers-residence-quarters-mismatch');
  if (
    text('identity.middleInitial') !== 'none' &&
    !/^[A-Za-z]$/.test(text('identity.middleInitial'))
  )
    issues.push('ny-middle-initial-invalid');
  // Federal line combines first and middle names; preserve the separately reviewed
  // NY first name rather than splitting a multiword given name heuristically.
  const given = ft('identity.firstAndMiddleName');
  const first = text('identity.firstName');
  const remainingName = given.startsWith(first + ' ')
    ? given.slice(first.length + 1)
    : '';
  if (
    !(given === first || given.startsWith(first + ' ')) ||
    (text('identity.middleInitial') === 'none'
      ? remainingName !== ''
      : remainingName[0]?.toUpperCase() !==
        text('identity.middleInitial').toUpperCase())
  )
    issues.push('ny-federal-given-name-mismatch');
  const homeSame = values.get('identity.homeSameAsMailing') === true;
  if (homeSame && ft('identity.state') !== 'NY')
    issues.push('ny-permanent-home-must-be-in-ny');
  for (const key of [
    'identity.homeStreet',
    'identity.homeApartment',
    'identity.homeCity',
    'identity.homeZip',
  ])
    if (homeSame && text(key) !== 'none') issues.push(`ny-unused-${key}`);
  if (
    !homeSame &&
    (['identity.homeStreet', 'identity.homeCity'].some(
      (key) => text(key) === 'none',
    ) ||
      !/^\d{5}(?:-\d{4})?$/.test(text('identity.homeZip')))
  )
    issues.push('ny-home-address-required');
  const refund = text('refund.method');
  if (
    ![
      'check',
      'personal checking',
      'personal savings',
      'business checking',
      'business savings',
    ].includes(refund)
  )
    issues.push('ny-refund-method-invalid');
  if (refund === 'check') {
    if (text('refund.routing') !== 'none' || text('refund.account') !== 'none')
      issues.push('ny-unused-refund-account');
  } else if (
    !/^(?:0[1-9]|1[0-2]|2[1-9]|3[0-2])\d{7}$/.test(text('refund.routing')) ||
    !/^[A-Za-z0-9-]{1,17}$/.test(text('refund.account')) ||
    values.get('refund.accountInTaxpayerName') !== true
  )
    issues.push('ny-refund-account-invalid');
  const money = new Map(rows.map((row) => [row.key, row.value]));
  const hasRefund = BigInt(money.get('78') ?? '0') > 0n;
  const firstName = text('identity.firstName'),
    middle = optional(text('identity.middleInitial'));
  const name = [firstName, middle, ft('identity.lastName')]
    .filter(Boolean)
    .join(' ');
  const birth = ft('identity.birthDate').split('-');
  const phone = ft('identity.phone').replace(/[^0-9]/g, '');
  if (ft('identity.phone') !== 'none' && phone.length !== 10)
    issues.push('ny-phone-ten-digits-required');
  const entries: Record<string, string | null> = {
    Itemized: 'no',
    Dependent: 'no',
    Filing_status: '1 Single',
    TP_first_name: firstName,
    TP_MI: middle,
    TP_last_name: ft('identity.lastName'),
    TP_DOB: `${birth[1]}${birth[2]}${birth[0]}`,
    TP_SSN: ft('identity.ssn'),
    TP_mail_address: ft('identity.street'),
    TP_mail_apt: optional(ft('identity.apartment')),
    TP_mail_city: ft('identity.city'),
    TP_mail_state: ft('identity.state'),
    TP_mail_zip: ft('identity.zip'),
    TP_mail_country: 'United States',
    TP_home_address: homeSame ? null : text('identity.homeStreet'),
    TP_home_city: homeSame ? null : text('identity.homeCity'),
    TP_home_zip: homeSame ? null : text('identity.homeZip'),
    TP_home_apt: homeSame ? null : optional(text('identity.homeApartment')),
    NYS_county_residence: text('identity.county'),
    SD_name: text('identity.schoolDistrict'),
    SD_code: text('identity.schoolDistrictCode'),
    Foreign_account: values.get('identity.foreignAccount') ? 'yes' : 'no',
    yonkers_freeze_credit: values.get('identity.yonkersQuarters')
      ? 'yes'
      : 'no',
    D1_Yonkers: values.get('identity.yonkersQuarters')
      ? yonkers
        ? '12'
        : '0'
      : null,
    D4: values.get('identity.yonkersQuarters') ? null : 'no',
    E1: city ? null : values.get('identity.nycQuarters') ? 'yes' : 'no',
    E2: city ? null : days,
    F1_NYC: city ? '12' : null,
    '34Deduction': 'Standard',
    Name_as_page1: name,
    '18_identify':
      BigInt(money.get('18') ?? '0') > 0n
        ? 'Self-employment tax deduction'
        : null,
    TP_occupation: ft('identity.occupation'),
    '3rd_party_box': 'no',
    day_ac: phone.length === 10 ? phone.slice(0, 3) : null,
    day_phone: phone.length === 10 ? phone.slice(3) : null,
    sign_email: optional(ft('identity.email')),
    Line78_refund: hasRefund
      ? refund === 'check'
        ? 'check'
        : 'direct deposit'
      : null,
    Line83a_account: hasRefund && refund !== 'check' ? refund : null,
    Line83b_routing:
      hasRefund && refund !== 'check' ? text('refund.routing') : null,
    Line83c_account_num:
      hasRefund && refund !== 'check' ? text('refund.account') : null,
    Line78a: null,
    Line78b: money.get('78') ?? null,
  };
  const fields = NY_FIELD_CATALOG.filter(
    (field) => field.formId === 'IT-201',
  ).map((field) => {
    let value: string | null = null;
    let status: 'inapplicable' | 'user-required' | 'unresolved' = 'unresolved';
    let reason =
      'Required/applicable decision has not been proved; field remains visible';
    if (field.fieldId in entries) {
      value = entries[field.fieldId]!;
      status = 'inapplicable';
      reason =
        'Reviewed NY declaration or same-taxpayer federal identity; published IT-201 field';
    } else if (
      /^Line\d+[a-e]?$/.test(field.fieldId) &&
      money.has(field.fieldId.slice(4))
    ) {
      value = money.get(field.fieldId.slice(4))!;
      reason = `Calculated IT-201 line ${field.fieldId.slice(4)}`;
    } else if (
      /^(Spouse_|H_|Fiscal_year_|G[12]_con_code|TP_date_death|D3_Yonkers|F2_NYC|designee|Prep_|NYTPRIN_|firm_name|Firm_)/.test(
        field.fieldId,
      )
    ) {
      status = 'inapplicable';
      reason =
        'Reviewed single/no-dependants/calendar-year/living/self-prepared/no-special-conditions/no-designee case';
    } else if (
      [
        'Line 9_box',
        'Line 10_box',
        '15_identify',
        '65_EIC',
        '70_EIC',
        'Line80_box',
        'Line83_box',
        'Line84_withdrawal_Date',
        'Line84_withdrawal_amount',
      ].includes(field.fieldId)
    ) {
      status = 'inapplicable';
      reason =
        'No beneficiary income, computed EIC, no foreign bank and no electronic withdrawal; explicit reviewed elections';
    } else if (field.fieldId === 'signed_date') {
      status = 'user-required';
      reason =
        'Taxpayer execution date is supplied when signing; not fabricated from preparation time';
    }
    try {
      return nyPhysicalFieldDecision(
        'IT-201',
        field.fieldId,
        value,
        reason,
        status,
      );
    } catch (error) {
      issues.push(
        error instanceof Error ? error.message : 'ny-invalid-physical-field',
      );
      return nyPhysicalFieldDecision(
        'IT-201',
        field.fieldId,
        null,
        'Declared input exceeds published form constraints',
        'user-required',
      );
    }
  });
  return deepFreeze({ fields, issues, schoolDistrictSource: district ?? null });
}

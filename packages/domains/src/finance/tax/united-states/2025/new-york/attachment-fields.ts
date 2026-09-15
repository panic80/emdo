import { deepFreeze, type FinanceTaxIntake } from '@emdo/contracts';
import { NY_FIELD_CATALOG } from './physical-fields.js';
import { nyPhysicalFieldDecision } from './physical-fields.js';
import type { calculateNySingleEic2025 } from './credits.js';
import type { calculateNyShortPenalty2025 } from './penalty.js';
import type { calculateNyRegularPenalty2025 } from './regular-penalty.js';
import { usReviewContentHash } from '../review-bundle.js';
import { roundUsdLine } from '../rounding.js';

/** Physical form decisions supplement (never replace) the exact calculation proofs.
 * No absent numeric dependency is silently zeroed. Stop predicates are explicit.
 */
export function prepareNyAttachmentPhysicalFields(
  federal: FinanceTaxIntake,
  ny: FinanceTaxIntake,
  rows: readonly { key: string; value: string }[],
  credit: ReturnType<typeof calculateNySingleEic2025> | null,
  penalty:
    | ReturnType<typeof calculateNyShortPenalty2025>
    | ReturnType<typeof calculateNyRegularPenalty2025>
    | null,
) {
  const money = new Map(rows.map((row) => [row.key, row.value]));
  const facts = new Map(ny.facts.map((fact) => [fact.key, fact.value.value]));
  const ff = new Map(federal.facts.map((fact) => [fact.key, fact.value.value]));
  const name = [
    ff.get('identity.firstAndMiddleName'),
    ff.get('identity.lastName'),
  ].join(' ');
  const ssn = String(ff.get('identity.ssn'));
  const hasEic = credit !== null && BigInt(credit.fields['10']!) > 0n;
  const city = facts.get('localResidence') === 'NYC';
  const issues: string[] = [];
  const creditValues: Record<string, string | null> = {
    'Your last name': name,
    'Your SSN': ssn,
    'Line 1': 'Yes',
    'Line 2': 'No',
    'Line 3': 'No',
    'Line 1a': 'No',
    'Line 5': 'No',
    '8 ein15':
      ff.get('business.ein') === 'none' ? ssn : String(ff.get('business.ein')),
  };
  for (const key of ['6', '7', '8', '9', '10', '12', '13', '14', '15', '16'])
    creditValues[`${key} dollars15`] = credit?.fields[key] ?? null;
  for (let i = 1; i <= 5; i++)
    creditValues[`Worksheet B ${i} dollars15`] =
      credit?.fields[`B.${i}`] ?? null;
  creditValues['27 dollars15'] = city ? (credit?.fields['27'] ?? null) : null;
  const penaltyValues: Record<string, string | null> = {
    'name as shown': name,
    'ident number': ssn,
  };
  for (const [key, value] of Object.entries(penalty?.fields ?? {}))
    penaltyValues[`${key}d`] = value;
  for (const [line, source] of Object.entries({
    '2': '63',
    '3': '64',
    '4': '65',
    '5': '66',
    '6': '67',
    '7': '68',
    '9': '70',
    '9a': '70a',
    '10': '71',
  }))
    penaltyValues[`${line}d`] = money.get(source) ?? null;
  penaltyValues['7ad'] = roundUsdLine([
    String(facts.get('penalty.starCreditReceived')),
  ]);
  penaltyValues['8d'] =
    money.has('69') && money.has('69a')
      ? (BigInt(money.get('69')!) + BigInt(money.get('69a')!)).toString()
      : null;
  const regular = penalty && 'periods' in penalty ? penalty : null;
  const regularAuxiliary = new Set([
    '31 1',
    '31 2',
    '31 3',
    '33 1',
    '33 2',
    '33 3',
    '35 oct',
    'oct  35 1.1',
    '35 oct total',
    '35 jan',
    'jan 35 1.1',
    '35 jan total',
    '35 total',
    '37 1',
    'jan 15 1',
    'jan 15 2',
  ]);
  if (regular) {
    for (const line of ['32', '34', '36'])
      if (regular.fields[line] !== undefined)
        penaltyValues[line] = regular.fields[line]!;
    if (regular.fields['38'] !== undefined)
      penaltyValues['38dd'] = regular.fields['38']!;
    if (regular.fields['39'] !== undefined)
      penaltyValues['39dd'] = regular.fields['39']!;
    for (const proof of regular.periods) {
      const line = String(Number(proof.line) - 1);
      penaltyValues[line] = null;
      if (proof.allocations.length !== 1) continue;
      const allocation = proof.allocations[0]!;
      const factor = allocation.segments
        .reduce((sum, segment) => sum + BigInt(segment.factorUnits), 0n)
        .toString()
        .padStart(5, '0');
      penaltyValues[line] = `.${factor}`;
      if (allocation.paymentDate === proof.end) continue; // preprinted full-period factor
      const printedDate = (date: string) =>
        `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(2, 4)}`;
      if (proof.period === 2) {
        const first = allocation.segments[0]!;
        penaltyValues['35 oct'] = printedDate(
          allocation.paymentDate > '2025-12-31'
            ? '2025-12-31'
            : allocation.paymentDate,
        );
        penaltyValues['oct  35 1.1'] = String(first.days);
        penaltyValues['35 oct total'] = first.factor.slice(2);
        if (allocation.segments[1]) {
          penaltyValues['35 jan'] = printedDate(allocation.paymentDate);
          penaltyValues['jan 35 1.1'] = String(allocation.segments[1].days);
          penaltyValues['35 jan total'] =
            allocation.segments[1].factor.slice(2);
        }
        penaltyValues['35 total'] = factor;
      } else {
        penaltyValues[`${line} 1`] = printedDate(allocation.paymentDate);
        penaltyValues[proof.period === 3 ? 'jan 15 1' : `${line} 2`] = String(
          allocation.segments[0]!.days,
        );
        penaltyValues[proof.period === 3 ? 'jan 15 2' : `${line} 3`] =
          allocation.segments[0]!.factor.slice(2);
      }
    }
  }
  const regularPeriodStatements =
    regular?.periods
      .filter((proof) => proof.allocations.length > 1)
      .map((proof) => ({
        required: true,
        title: `IT-2105.9 line${proof.line} separate payment computations`,
        content: proof,
        contentHash: usReviewContentHash(proof),
      })) ?? [];
  const forms = ['IT-215', 'IT-2105.9', 'IT-270'].map((formId) => ({
    formId,
    required:
      formId === 'IT-215'
        ? hasEic
        : formId === 'IT-2105.9'
          ? penalty !== null && BigInt(penalty.penalty) > 0n
          : false,
    fields: NY_FIELD_CATALOG.filter((field) => field.formId === formId).map(
      (field) => {
        let value: string | null = null;
        let status: 'inapplicable' | 'unresolved' = 'inapplicable';
        let reason: string;
        if (formId === 'IT-270')
          reason =
            'Reviewed no dependants; Part1 question A requires stop, so no IT-270 attachment';
        else if (formId === 'IT-215') {
          if (!hasEic)
            reason = 'No federal EIC claimed; IT-215 question1 requires stop';
          else if (field.fieldId in creditValues) {
            value = creditValues[field.fieldId]!;
            status =
              value === null && field.fieldId !== '27 dollars15'
                ? 'unresolved'
                : 'inapplicable';
            reason =
              field.fieldId === '27 dollars15' && !city
                ? 'Not a NYC resident'
                : 'IT-215 ordinary single/no-child proof; exact federal EIC and reviewed primary business identity';
          } else if (
            /^(ln34|month|1[78] |19 |2[0-6] |28[ab] )/.test(field.fieldId)
          )
            reason =
              'Full-year single NY resident with no children; joint allocation, child entries and part-year calculations do not apply';
          else {
            status = 'unresolved';
            reason = 'IT-215 field mapping not proved';
          }
        } else if (!penalty) {
          status = 'unresolved';
          reason = 'Penalty applicability/calculation unavailable';
        } else if (field.fieldId in penaltyValues) {
          value = penaltyValues[field.fieldId]!;
          status =
            value === null &&
            !(regular && ['31', '33', '35', '37'].includes(field.fieldId))
              ? 'unresolved'
              : 'inapplicable';
          reason =
            regular && value === null
              ? 'No underpayment or multiple payment factors; required source-bound separate computation accompanies the period'
              : 'IT-2105.9 exact proof, entered ScheduleA values, per-period penalty and explicit IT-201 credit transfers';
        } else if (/^(1[6-9]|2[0-4])d$/.test(field.fieldId))
          reason =
            regular && Number(field.fieldId.slice(0, -1)) >= 18
              ? 'Selected Part3 regular method; Part2 short-method fields are inapplicable'
              : penalty.exception
                ? `Stopped by proved penalty exception: ${penalty.exception}`
                : 'Prior-year safe harbor unavailable under reviewed prior-return predicates; current-year annual requirement used';
        else if (regular && regularAuxiliary.has(field.fieldId))
          reason =
            'Preprinted full-period factor, unused January split or required separate multi-payment computation';
        else if (regular && !penalty.exception) {
          status = 'unresolved';
          reason =
            'Regular-method physical control not mapped; no silent inapplicability';
        } else
          reason =
            'Reviewed short-method election and verified eligibility; Part3 regular-method fields are not used';
        try {
          return nyPhysicalFieldDecision(
            formId,
            field.fieldId,
            value,
            reason,
            status,
          );
        } catch (error) {
          issues.push(
            error instanceof Error
              ? error.message
              : 'ny-attachment-field-invalid',
          );
          return nyPhysicalFieldDecision(
            formId,
            field.fieldId,
            null,
            'Value violates published form constraint',
            'unresolved',
          );
        }
      },
    ),
  }));
  return deepFreeze({ forms, issues, regularPeriodStatements });
}

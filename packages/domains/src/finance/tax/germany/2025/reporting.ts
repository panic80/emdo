import {
  deepFreeze,
  type FinanceTaxEvaluation,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import {
  buildGermany2025FieldCoverage,
  type Germany2025FieldCoverage,
  type Germany2025FieldDecision,
  type Germany2025TraceLike,
} from './form-fields.js';

export const GERMANY_2025_REPORTING_POLICY_VERSION =
  '2025-review-export.precision.1';

export type Germany2025ReportingStatus =
  | 'lossless'
  | 'inapplicable'
  | 'user-required'
  | 'blocked-input'
  | 'field-proof-missing'
  | 'rounding-unproven';

export type Germany2025ReportingField = {
  formId: Germany2025FieldDecision['formId'];
  fieldId: string | null;
  line: string;
  label: string;
  actualField: boolean;
  electronicOnly: boolean;
  status: Germany2025ReportingStatus;
  value: string | boolean | null;
  encodedValue: string | boolean | null;
  sourceId: string;
  sourceHash: string;
  sourceFactKeys: readonly string[];
  calculationKey: string | null;
  predicate: string;
};

const validDecimal = /^-?(?:0|[1-9]\d*)(?:\.(\d+))?$/;

/**
 * Encode a proven FMS field without applying an undocumented rounding rule.
 * Whole-euro controls accept a decimal only when its fractional part is zero;
 * euro-cent controls retain exactly two places.  No value is encoded for a
 * semantic electronic-only line or a calculated review output.
 */
function encodeLosslessly(field: Germany2025FieldDecision): {
  status: Germany2025ReportingStatus;
  encodedValue: string | boolean | null;
} {
  if (field.status === 'inapplicable')
    return { status: 'inapplicable', encodedValue: null };
  if (field.status === 'user-required')
    return { status: 'user-required', encodedValue: null };
  if (field.status === 'unresolved')
    return {
      status: field.actualField ? 'blocked-input' : 'field-proof-missing',
      encodedValue: null,
    };
  if (field.value === null)
    return { status: 'blocked-input', encodedValue: null };
  if (typeof field.value !== 'string' || field.kind !== 'amount')
    return { status: 'lossless', encodedValue: field.value };
  const parsed = validDecimal.exec(field.value);
  if (!parsed) return { status: 'blocked-input', encodedValue: null };
  const fraction = parsed[1] ?? '';
  if (field.precision === 'whole-euro') {
    if (fraction.replace(/0/g, '') !== '')
      return { status: 'rounding-unproven', encodedValue: null };
    return { status: 'lossless', encodedValue: field.value.split('.')[0]! };
  }
  if (field.precision === 'euro-cent') {
    if (fraction.length > 2)
      return { status: 'rounding-unproven', encodedValue: null };
    return {
      status: 'lossless',
      encodedValue: `${field.value.split('.')[0]!}.${fraction.padEnd(2, '0')}`,
    };
  }
  return { status: 'rounding-unproven', encodedValue: null };
}

function fromCoverage(coverage: Germany2025FieldCoverage) {
  const fields = coverage.fields.map((field) => {
    const encoded = encodeLosslessly(field);
    return {
      formId: field.formId,
      fieldId: field.fieldId,
      line: field.line,
      label: field.label,
      actualField: field.actualField,
      electronicOnly: field.electronicOnly === true,
      status: encoded.status,
      value: field.value,
      encodedValue: encoded.encodedValue,
      sourceId: field.sourceId,
      sourceHash: field.sourceHash,
      sourceFactKeys: field.sourceFactKeys,
      calculationKey: field.calculationKey,
      predicate: field.predicate,
    } satisfies Germany2025ReportingField;
  });
  const unresolvedFields = fields.filter(
    (field) => field.status !== 'lossless' && field.status !== 'inapplicable',
  );
  return deepFreeze({
    target: 'de-elster-2025-review-export' as const,
    policyVersion: GERMANY_2025_REPORTING_POLICY_VERSION,
    taxYear: 2025 as const,
    filingArtifact: false as const,
    complete: false as const,
    proof: 'source-bound-review-mapping-without-filing-submission',
    fields,
    unresolvedFields,
    blockers: [
      ...coverage.blockers,
      'review-export-does-not-create-or-submit-a-tax-return',
      'calculated-output-lines-are-review-values-not-physical-est1a-controls',
    ],
    sourceRefs: coverage.sourceRefs,
    summary: {
      total: fields.length,
      lossless: fields.filter((field) => field.status === 'lossless').length,
      inapplicable: fields.filter((field) => field.status === 'inapplicable')
        .length,
      userRequired: fields.filter((field) => field.status === 'user-required')
        .length,
      blockedInput: fields.filter((field) => field.status === 'blocked-input')
        .length,
      fieldProofMissing: fields.filter(
        (field) => field.status === 'field-proof-missing',
      ).length,
      roundingUnproven: fields.filter(
        (field) => field.status === 'rounding-unproven',
      ).length,
    },
  });
}

/** Build a review-only mapping from an already-classified field inventory. */
export function buildGermany2025Reporting(
  coverage: Germany2025FieldCoverage,
): ReturnType<typeof fromCoverage>;
/** Build a review-only mapping directly from an intake and evaluation. */
export function buildGermany2025Reporting(
  intake: FinanceTaxIntake,
  evaluation: FinanceTaxEvaluation,
  trace?: readonly Germany2025TraceLike[],
): ReturnType<typeof fromCoverage>;
export function buildGermany2025Reporting(
  coverageOrIntake: Germany2025FieldCoverage | FinanceTaxIntake,
  evaluation?: FinanceTaxEvaluation,
  trace: readonly Germany2025TraceLike[] = [],
) {
  const coverage = evaluation
    ? buildGermany2025FieldCoverage(
        coverageOrIntake as FinanceTaxIntake,
        evaluation,
        trace,
      )
    : (coverageOrIntake as Germany2025FieldCoverage);
  return fromCoverage(coverage);
}

export const buildGermany2025FormExport = buildGermany2025Reporting;
export const buildGermany2025ReviewExport = buildGermany2025Reporting;
export const exportGermany2025Review = buildGermany2025Reporting;

import { deepFreeze } from '@emdo/contracts';
import type { buildCorporateFieldCoverage } from './field-coverage.js';

/** Independently enumerated fixed controls from RC4088 Validity check items and
 * the captured Schedule100/125 layouts. Repeating-row entries cannot satisfy these. */
export const CORPORATE_GIFI_REQUIRED_CONTROLS = deepFreeze([
  { form: 'GIFI100', ordinal: 84, code: '2599', requirement: 'Total assets' },
  {
    form: 'GIFI100',
    ordinal: 164,
    code: '3499',
    requirement: 'Total liabilities',
  },
  {
    form: 'GIFI100',
    ordinal: 196,
    code: '3620',
    requirement: 'Total shareholder equity',
  },
  {
    form: 'GIFI100',
    ordinal: 226,
    code: '3849',
    requirement: 'Ending retained earnings when breakdown provided',
  },
  {
    form: 'GIFI125',
    ordinal: 74,
    code: '8299',
    requirement: 'Total non-farming revenue',
  },
  {
    form: 'GIFI125',
    ordinal: 206,
    code: '9368',
    requirement: 'Total non-farming expenses',
  },
  {
    form: 'GIFI125',
    ordinal: 208,
    code: '9369',
    requirement: 'Non-farming revenue less expenses validity equation',
  },
  {
    form: 'GIFI125',
    ordinal: 302,
    code: '9999',
    requirement: 'Net income after taxes and extraordinary items',
  },
]);
export function corporateRequiredControlManifest(
  coverage: ReturnType<typeof buildCorporateFieldCoverage>,
) {
  const requiredControls = CORPORATE_GIFI_REQUIRED_CONTROLS.map((required) => {
    const field = coverage.fields.find(
      (f) => f.form === required.form && f.ordinal === required.ordinal,
    )!;
    return {
      ...required,
      sourceFile: field.sourceFile,
      sourceSha256: field.sourceSha256,
      path: field.path,
      value: field.value,
      populated: field.classification === 'populated',
      applicableMappingPresent:
        field.logicalField === `${required.form}.${required.code}`,
    };
  });
  const unresolvedApplicability = coverage.fields.filter(
    (field) =>
      field.classification === 'unresolved' && field.logicalField === null,
  );
  const missingUserInputs = coverage.fields.filter(
    (field) => field.classification === 'user-required',
  );
  return deepFreeze({
    version: 1,
    authority:
      'RC4088 Validity check items; captured T2/Schedule100/Schedule125 controls',
    requiredControls,
    requiredGifiMappingsComplete: requiredControls.every(
      (f) => f.applicableMappingPresent,
    ),
    requiredGifiValuesAvailable: requiredControls.every((f) => f.populated),
    applicabilityResolved: unresolvedApplicability.length === 0,
    unresolvedApplicability,
    missingUserInputs,
    // Unknown general text rules are disclosure, not invented requirements.
    textConstraintDisclosure: coverage.unresolvedValidationFields,
    completeReturn: false,
    readiness: 'disabled',
  });
}

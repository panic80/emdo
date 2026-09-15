export {
  CanadaCorporate2025IntakeSchema,
  T2_2025_ADDITIONAL_SCHEDULE_TRIGGERS,
  T2_2025_EXPENSE_CODES,
  type CanadaCorporate2025Intake,
} from './intake.js';
export { CANADA_CORPORATE_2025_SOURCES } from './sources.js';
export {
  CANADA_CORPORATE_2025_COVERAGE,
  CANADA_CORPORATE_2025_PACKAGE_VERSION,
  CANADA_CORPORATE_2025_DEFINITION,
  CANADA_CORPORATE_2025_DEFINITION_HASH,
  canonicalCorporateJson,
  prepareCanadaCorporate2025Review,
  type CorporateForm,
  type CorporateIssue,
} from './workflow.js';

export {
  buildCorporateReporting,
  encodeCorporateFieldLosslessly,
} from './reporting.js';
export { CORPORATE_XFA_FIELDS } from './xfa-inventory.js';

export { buildCorporateFieldCoverage } from './field-coverage.js';

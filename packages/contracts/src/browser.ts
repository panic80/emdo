/**
 * Browser-safe public workspace and Finance contracts. This entrypoint excludes
 * agent execution, disclosure, capability invocation, and provider-authority schemas.
 * Reviewable Finance proposals are data contracts and do not grant write authority.
 */
export * from './workspace.js';
export * from './finance-v2.js';
export {
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  OpaqueReferenceSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
} from './primitives.js';
export type { DeepReadonly, JsonValue } from './primitives.js';

export { SupportedLocaleSchema } from './locale.js';
export type { SupportedLocale } from './locale.js';

export {
  FinanceImportDestinationAccountSchema,
  FinanceImportDestinationCategorySchema,
  FinanceImportDestinationsSchema,
} from './finance-imports.js';
export type { FinanceImportDestinations } from './finance-imports.js';

export { SyncOperationSchema } from './sync.js';
export type { SyncOperation } from './sync.js';

export {
  ActivityPageSchema,
  FinancePageSchema,
  NotificationPreferencesUpdateRequestSchema,
  NotificationPreferencesViewSchema,
  SchedulePageSchema,
  SettingsViewSchema,
  ShoppingPageSchema,
  TodayViewSchema,
} from './experience.js';
export type {
  ActivityPage,
  FinancePage,
  NotificationPreferencesUpdateRequest,
  NotificationPreferencesView,
  SchedulePage,
  SettingsView,
  ShoppingPage,
  TodayView,
} from './experience.js';

export * from './finance-investments.js';

export * from './finance-report-mappings.js';

export * from './finance-import-components.js';
export * from './finance-import-posting.js';

export * from './finance-lots.js';

export * from './finance-corporate-actions.js';
export * from './finance-corporate-action-settlement.js';

export * from './finance-tax.js';

export * from './finance-automations.js';

export * from './finance-xlsx.js';
export * from './finance-generated-reports.js';

export * from './finance-tax-questionnaire.js';

export * from './finance-pdf.js';

export * from './finance-pdf-inspection.js';

export * from './finance-tax-read.js';

export * from './finance-tax-cases.js';

export * from './finance-automation-schedules.js';

export * from './finance-canada-cpp-2025.js';

export * from './finance-tax-runs.js';
export * from './finance-structured-invoices.js';

export * from './finance-standardization.js';

export * from './finance-dividends.js';
export * from './finance-standardization-reconciliation.js';

export * from './finance-image.js';
export * from './finance-pdf-ocr.js';

export * from './finance-legacy-migration.js';

export * from './finance-ofx.js';

export * from './finance-planning.js';
export * from './finance-planning-results.js';

export * from './finance-fec.js';

export * from './finance-opening.js';

export * from './finance-investment-reconciliation.js';

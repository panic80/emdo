/**
 * Browser-safe public contracts. This entrypoint deliberately excludes agent,
 * proposal, disclosure, capability, and provider-authority schemas.
 */
export {
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  OpaqueReferenceSchema,
  UuidSchema,
  deepFreeze,
} from './primitives.js';
export type { DeepReadonly, JsonValue } from './primitives.js';

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

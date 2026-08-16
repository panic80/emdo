/**
 * Server-only deterministic Calendar capability facade. Browser and agent
 * packages must never receive its credential-broker or provider clients.
 */
export {
  CalendarWriteExecutor,
  GoogleCalendarWriteCommandSchema,
  hashGoogleCalendarPayload,
  isGoogleCalendarWriteAuthorized,
} from './calendar-write.js';
export type {
  ApprovedCalendarCanonicalArguments,
  ApprovedCalendarWriteContext,
  CalendarWriteApprovalBinding,
  CalendarWriteReceiptStore,
  CalendarWriteResult,
  CalendarWriteSafeError,
  CalendarWriteSafeErrorCode,
  GoogleCalendarConditionalGateway,
  GoogleCalendarProviderState,
  GoogleCalendarWriteCommand,
} from './calendar-write.js';

export {
  GOOGLE_CALENDAR_API_ENDPOINTS,
  GOOGLE_CALENDAR_FETCH_LIMITS,
  FetchGoogleCalendarConditionalGateway,
  GoogleCalendarFetchError,
  GoogleCalendarFreeBusyClient,
  GoogleCalendarReadClient,
  deriveGoogleCalendarEventId,
} from './calendar-fetch.js';
export type {
  GoogleCalendarCredentialBroker,
  GoogleCalendarEventEvidence,
  GoogleCalendarFetch,
  GoogleCalendarSummary,
} from './calendar-fetch.js';

export { runGoogleCalendarReadOnlySmoke } from './calendar-smoke.js';
export type { GoogleCalendarReadOnlySmokeResult } from './calendar-smoke.js';

import { describe, expect, it } from 'vitest';

import {
  mapCalendarWriteResultForAgent,
  materializeCalendarCanonicalArguments,
} from './calendar-capability-adapter.js';
import { parseProductionProviderWriteCapabilityId } from './capability-runtime.js';

const CALENDAR_CREATE = parseProductionProviderWriteCapabilityId(
  'google-calendar.event.create',
);
const CALENDAR_UPDATE = parseProductionProviderWriteCapabilityId(
  'google-calendar.event.update',
);
const CALENDAR_DELETE = parseProductionProviderWriteCapabilityId(
  'google-calendar.event.delete',
);

const createArguments = {
  schemaVersion: 1,
  calendarRef: 'opaque-calendar-ref',
  event: {
    summary: 'Dentist appointment',
    start: '2026-08-11T14:00:00-04:00',
    end: '2026-08-11T15:00:00-04:00',
    timeZone: 'America/Toronto',
  },
} as const;

describe('Calendar capability Task6 mapper', () => {
  it('derives every provider identifier and version from trusted state', () => {
    expect(
      materializeCalendarCanonicalArguments({
        capabilityId: CALENDAR_CREATE,
        modelArguments: createArguments,
        trustedState: {
          calendarRef: 'opaque-calendar-ref',
          calendarId: 'primary',
          expectedCalendarVersion: 'calendar-etag-7',
          createdEventId: '0123456789abcdef',
        },
      }),
    ).toEqual({
      operation: 'create',
      calendarId: 'primary',
      expectedCalendarVersion: 'calendar-etag-7',
      event: {
        eventId: '0123456789abcdef',
        summary: 'Dentist appointment',
        start: '2026-08-11T14:00:00-04:00',
        end: '2026-08-11T15:00:00-04:00',
        timeZone: 'America/Toronto',
      },
    });

    expect(
      materializeCalendarCanonicalArguments({
        capabilityId: CALENDAR_UPDATE,
        modelArguments: {
          schemaVersion: 1,
          calendarRef: 'opaque-calendar-ref',
          eventRef: 'opaque-event-ref',
          replacement: {
            ...createArguments.event,
            summary: 'Updated appointment',
          },
        },
        trustedState: {
          calendarRef: 'opaque-calendar-ref',
          eventRef: 'opaque-event-ref',
          calendarId: 'primary',
          eventId: 'provider-event-1',
          expectedCalendarVersion: 'calendar-etag-7',
          expectedEventVersion: 'event-etag-3',
        },
      }),
    ).toMatchObject({
      operation: 'update',
      calendarId: 'primary',
      eventId: 'provider-event-1',
      expectedCalendarVersion: 'calendar-etag-7',
      expectedEventVersion: 'event-etag-3',
      replacement: {
        eventId: 'provider-event-1',
        summary: 'Updated appointment',
      },
    });
  });

  it('rejects model provider versions and mismatched trusted opaque references', () => {
    expect(() =>
      materializeCalendarCanonicalArguments({
        capabilityId: CALENDAR_CREATE,
        modelArguments: {
          ...createArguments,
          expectedCalendarVersion: 'model-etag',
        },
        trustedState: {
          calendarRef: 'opaque-calendar-ref',
          calendarId: 'primary',
          expectedCalendarVersion: 'calendar-etag-7',
          createdEventId: '0123456789abcdef',
        },
      }),
    ).toThrow('api-calendar-model-arguments-invalid');

    expect(() =>
      materializeCalendarCanonicalArguments({
        capabilityId: CALENDAR_DELETE,
        modelArguments: {
          schemaVersion: 1,
          calendarRef: 'opaque-calendar-ref',
          eventRef: 'opaque-event-ref',
        },
        trustedState: {
          calendarRef: 'another-calendar-ref',
          eventRef: 'opaque-event-ref',
          calendarId: 'primary',
          eventId: 'provider-event-1',
          expectedCalendarVersion: 'calendar-etag-7',
          expectedEventVersion: 'event-etag-3',
        },
      }),
    ).toThrow('api-calendar-trusted-state-mismatch');
  });

  it('maps the exact Calendar executor result into the finite agent output schema', () => {
    expect(
      mapCalendarWriteResultForAgent(CALENDAR_CREATE, {
        status: 'applied',
        providerRequestId: 'provider-request-1',
        reconciled: true,
        readbackCalendarVersion: 'calendar-etag-8',
        readback: {
          eventId: '0123456789abcdef',
          eventVersion: 'event-etag-1',
          summary: 'Dentist appointment',
          start: '2026-08-11T14:00:00-04:00',
          end: '2026-08-11T15:00:00-04:00',
          timeZone: 'America/Toronto',
        },
      }),
    ).toMatchObject({
      schemaVersion: 1,
      result: {
        status: 'applied',
        readbackCalendarVersion: 'calendar-etag-8',
      },
    });

    expect(
      mapCalendarWriteResultForAgent(CALENDAR_DELETE, {
        status: 'indeterminate',
        reconciliationRequired: true,
        safeError: {
          code: 'calendar-provider-indeterminate',
          message: 'Provider outcome requires reconciliation.',
          retryable: false,
        },
      }),
    ).toMatchObject({
      schemaVersion: 1,
      result: { status: 'indeterminate', reconciliationRequired: true },
    });
  });
});

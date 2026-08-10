import { ActionProposalSchema } from '@emdo/contracts';
import { hashCanonicalJson } from '@emdo/toolbox';
import { describe, expect, it } from 'vitest';

import {
  CalendarProposalMaterializer,
  ScopedCalendarProposalMaterializer,
} from './proposals.js';
import {
  ProposalService,
  hashActionProposalApproval,
} from '../shared/proposals.js';

const event = {
  eventId: 'emdodentist20260810',
  summary: 'Dentist',
  start: '2026-08-10T15:00:00.000Z',
  end: '2026-08-10T16:00:00.000Z',
  timeZone: 'America/Toronto' as const,
  location: 'Clinic',
};

const allCalendarFields = [
  'calendar-id',
  'calendar-version',
  'event-id',
  'event-version',
  'summary',
  'start',
  'end',
  'time-zone',
  'location',
  'description',
  'attendees',
  'recurrence',
] as const;

const proposalScope = (...calendarIds: string[]) => ({
  grantId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f201',
  userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f202',
  householdId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f203',
  runId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f204',
  agentId: 'scheduler' as const,
  provider: 'google-calendar' as const,
  recordAllowlist: calendarIds.map((calendarId) => ({
    dataClass: 'calendar.events' as const,
    recordId: `${calendarId.length}:${calendarId}${event.eventId.length}:${event.eventId}`,
    fields: allCalendarFields,
  })),
});

const reader = {
  readTargetState: async ({
    calendarId,
    eventId,
  }: {
    calendarId: string;
    eventId: string;
  }) => ({
    calendarId,
    queriedEventId: eventId,
    calendarVersion: calendarId === 'primary' ? 'calendar-v7' : 'calendar-v2',
    event:
      calendarId === 'primary' && eventId === event.eventId
        ? {
            calendarId,
            ...event,
            eventVersion: 'event-v3',
          }
        : null,
  }),
};

const targetId = (calendarId: string): string =>
  `${calendarId.length}:${calendarId}${event.eventId.length}:${event.eventId}`;

describe('CalendarProposalMaterializer', () => {
  it('materializes exact create, update, and delete previews and preconditions', async () => {
    const materializer = new CalendarProposalMaterializer(
      reader,
      proposalScope('primary', 'secondary'),
    );
    await expect(
      materializer.materialize({
        capabilityId: 'google-calendar.event.create',
        canonicalArguments: {
          operation: 'create',
          calendarId: 'secondary',
          expectedCalendarVersion: 'calendar-v2',
          event,
        },
      }),
    ).resolves.toEqual({
      targets: [
        {
          kind: 'google-calendar.event',
          id: targetId('secondary'),
          expectedVersion: 'absent',
        },
      ],
      beforePreview: null,
      afterPreview: event,
      providerPreconditions: [
        {
          kind: 'calendar-version',
          targetId: 'secondary',
          expectedValue: 'calendar-v2',
        },
        {
          kind: 'event-absence',
          targetId: targetId('secondary'),
          expectedValue: 'absent',
        },
      ],
    });

    const replacement = { ...event, summary: 'Dentist checkup' };
    await expect(
      materializer.materialize({
        capabilityId: 'google-calendar.event.update',
        canonicalArguments: {
          operation: 'update',
          calendarId: 'primary',
          eventId: event.eventId,
          expectedCalendarVersion: 'calendar-v7',
          expectedEventVersion: 'event-v3',
          replacement,
        },
      }),
    ).resolves.toMatchObject({
      targets: [
        {
          kind: 'google-calendar.event',
          id: targetId('primary'),
          expectedVersion: 'event-v3',
        },
      ],
      beforePreview: expect.objectContaining({
        summary: 'Dentist',
        eventVersion: 'event-v3',
      }),
      afterPreview: replacement,
      providerPreconditions: [
        {
          kind: 'calendar-version',
          targetId: 'primary',
          expectedValue: 'calendar-v7',
        },
        {
          kind: 'event-version',
          targetId: targetId('primary'),
          expectedValue: 'event-v3',
        },
      ],
    });

    await expect(
      materializer.materialize({
        capabilityId: 'google-calendar.event.delete',
        canonicalArguments: {
          operation: 'delete',
          calendarId: 'primary',
          eventId: event.eventId,
          expectedCalendarVersion: 'calendar-v7',
          expectedEventVersion: 'event-v3',
        },
      }),
    ).resolves.toMatchObject({
      beforePreview: expect.objectContaining({ summary: 'Dentist' }),
      afterPreview: null,
    });
  });

  it('rejects capability mismatches, stale state, extra fields, and create overwrite', async () => {
    const materializer = new CalendarProposalMaterializer(
      reader,
      proposalScope('primary', 'secondary'),
    );
    await expect(
      materializer.materialize({
        capabilityId: 'google-calendar.event.delete',
        canonicalArguments: {
          operation: 'update',
          calendarId: 'primary',
          eventId: event.eventId,
          expectedCalendarVersion: 'calendar-v7',
          expectedEventVersion: 'event-v3',
          replacement: event,
        },
      }),
    ).rejects.toMatchObject({ code: 'calendar-capability-mismatch' });
    await expect(
      materializer.materialize({
        capabilityId: 'google-calendar.event.delete',
        canonicalArguments: {
          operation: 'delete',
          calendarId: 'primary',
          eventId: event.eventId,
          expectedCalendarVersion: 'calendar-v7',
          expectedEventVersion: 'stale',
        },
      }),
    ).rejects.toMatchObject({ code: 'calendar-precondition-failed' });
    await expect(
      materializer.materialize({
        capabilityId: 'google-calendar.event.create',
        canonicalArguments: {
          operation: 'create',
          calendarId: 'primary',
          expectedCalendarVersion: 'calendar-v7',
          event,
          hiddenAction: 'delete-all',
        },
      }),
    ).rejects.toMatchObject({ code: 'calendar-arguments-invalid' });
    await expect(
      materializer.materialize({
        capabilityId: 'google-calendar.event.create',
        canonicalArguments: {
          operation: 'create',
          calendarId: 'primary',
          expectedCalendarVersion: 'calendar-v7',
          event,
        },
      }),
    ).rejects.toMatchObject({ code: 'calendar-event-already-exists' });
  });

  it('does not invoke hostile argument accessors and freezes materialized output', async () => {
    const materializer = new CalendarProposalMaterializer(
      reader,
      proposalScope('primary'),
    );
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, 'capabilityId', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'google-calendar.event.delete';
      },
    });
    await expect(materializer.materialize(hostile)).rejects.toMatchObject({
      code: 'calendar-arguments-invalid',
    });
    expect(getterCalls).toBe(0);

    const result = await materializer.materialize({
      capabilityId: 'google-calendar.event.delete',
      canonicalArguments: {
        operation: 'delete',
        calendarId: 'primary',
        eventId: event.eventId,
        expectedCalendarVersion: 'calendar-v7',
        expectedEventVersion: 'event-v3',
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.targets)).toBe(true);
    expect(Object.isFrozen(result.beforePreview)).toBe(true);
  });

  it('rejects recurrence rules that bypass Toronto DST semantics', async () => {
    const materializer = new CalendarProposalMaterializer(
      {
        readTargetState: async ({ calendarId, eventId }) => ({
          calendarId,
          queriedEventId: eventId,
          calendarVersion: 'calendar-v2',
          event: null,
        }),
      },
      proposalScope('secondary'),
    );
    const recurringEvent = {
      ...event,
      eventId: 'dstgap20260307',
      start: '2026-03-07T07:30:00.000Z',
      end: '2026-03-07T08:00:00.000Z',
      recurrence: {
        frequency: 'daily' as const,
        interval: 1,
        count: 2,
        disambiguation: 'reject' as const,
      },
    };
    await expect(
      materializer.materialize({
        capabilityId: 'google-calendar.event.create',
        canonicalArguments: {
          operation: 'create',
          calendarId: 'secondary',
          expectedCalendarVersion: 'calendar-v2',
          event: recurringEvent,
        },
      }),
    ).rejects.toMatchObject({ code: 'calendar-arguments-invalid' });
    await expect(
      materializer.materialize({
        capabilityId: 'google-calendar.event.create',
        canonicalArguments: {
          operation: 'create',
          calendarId: 'secondary',
          expectedCalendarVersion: 'calendar-v2',
          event: {
            ...recurringEvent,
            eventId: 'badrrule100',
            start: '2026-08-10T13:00:00.000Z',
            end: '2026-08-10T14:00:00.000Z',
            recurrence: {
              ...recurringEvent.recurrence,
              byWeekday: ['MO'],
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'calendar-arguments-invalid' });

    await expect(
      materializer.materialize({
        capabilityId: 'google-calendar.event.create',
        canonicalArguments: {
          operation: 'create',
          calendarId: 'secondary',
          expectedCalendarVersion: 'calendar-v2',
          event: {
            ...recurringEvent,
            eventId: 'falloverlap1',
            start: '2026-11-01T06:30:00.000Z',
            end: '2026-11-01T07:00:00.000Z',
            recurrence: {
              frequency: 'weekly',
              interval: 1,
              count: 2,
              byWeekday: ['SU'],
              disambiguation: 'earlier',
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'calendar-arguments-invalid' });

    await expect(
      materializer.materialize({
        capabilityId: 'google-calendar.event.create',
        canonicalArguments: {
          operation: 'create',
          calendarId: 'secondary',
          expectedCalendarVersion: 'calendar-v2',
          event: {
            ...event,
            eventId: 'omitstart1',
            recurrence: {
              frequency: 'weekly',
              interval: 1,
              count: 2,
              byWeekday: ['TU'],
              disambiguation: 'reject',
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'calendar-arguments-invalid' });
  });

  it('accepts a bounded biweekly recurrence with multiple weekdays', async () => {
    const materializer = new CalendarProposalMaterializer(
      {
        readTargetState: async ({ calendarId, eventId }) => ({
          calendarId,
          queriedEventId: eventId,
          calendarVersion: 'calendar-v2',
          event: null,
        }),
      },
      proposalScope('secondary'),
    );

    await expect(
      materializer.materialize({
        capabilityId: 'google-calendar.event.create',
        canonicalArguments: {
          operation: 'create',
          calendarId: 'secondary',
          expectedCalendarVersion: 'calendar-v2',
          event: {
            ...event,
            start: '2026-08-10T13:00:00.000Z',
            end: '2026-08-10T14:00:00.000Z',
            recurrence: {
              frequency: 'weekly',
              interval: 2,
              count: 366,
              byWeekday: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'],
              disambiguation: 'reject',
            },
          },
        },
      }),
    ).resolves.toMatchObject({
      afterPreview: { recurrence: { count: 366, interval: 2 } },
    });
  });

  it('rejects a provider snapshot bound to a different target', async () => {
    const materializer = new CalendarProposalMaterializer(
      {
        readTargetState: async () => ({
          calendarId: 'different-calendar',
          queriedEventId: event.eventId,
          calendarVersion: 'calendar-v7',
          event: null,
        }),
      },
      proposalScope('primary'),
    );
    await expect(
      materializer.materialize({
        capabilityId: 'google-calendar.event.create',
        canonicalArguments: {
          operation: 'create',
          calendarId: 'primary',
          expectedCalendarVersion: 'calendar-v7',
          event,
        },
      }),
    ).rejects.toMatchObject({ code: 'calendar-precondition-failed' });
  });

  it('accepts the largest bounded calendar and event IDs in an exact grant target', async () => {
    const calendarId = 'a'.repeat(240);
    const eventId = 'b'.repeat(240);
    const exactTarget = `${calendarId.length}:${calendarId}${eventId.length}:${eventId}`;
    const materializer = new CalendarProposalMaterializer(
      {
        readTargetState: async () => ({
          calendarId,
          queriedEventId: eventId,
          calendarVersion: 'calendar-v1',
          event: null,
        }),
      },
      {
        ...proposalScope(),
        recordAllowlist: [
          {
            dataClass: 'calendar.events',
            recordId: exactTarget,
            fields: allCalendarFields,
          },
        ],
      },
    );

    await expect(
      materializer.materialize({
        capabilityId: 'google-calendar.event.create',
        canonicalArguments: {
          operation: 'create',
          calendarId,
          expectedCalendarVersion: 'calendar-v1',
          event: { ...event, eventId },
        },
      }),
    ).resolves.toMatchObject({ targets: [{ id: exactTarget }] });
  });

  it('rejects a server grant scoped to another calendar before repository access', async () => {
    let readCalls = 0;
    const scopedReader = {
      readTargetState: async ({
        calendarId,
        eventId,
      }: {
        calendarId: string;
        eventId: string;
      }) => {
        readCalls += 1;
        return {
          calendarId,
          queriedEventId: eventId,
          calendarVersion: 'calendar-v7',
          event: {
            calendarId,
            ...event,
            eventVersion: 'event-v3',
          },
        };
      },
    };
    const replacement = { ...event, summary: 'Dentist checkup' };
    const canonicalArguments = {
      operation: 'update' as const,
      calendarId: 'primary',
      eventId: event.eventId,
      expectedCalendarVersion: 'calendar-v7',
      expectedEventVersion: 'event-v3',
      replacement,
    };
    const disclosureGrant = {
      schemaVersion: 1 as const,
      id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f101',
      version: 1,
      userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f102',
      householdId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f103',
      agentId: 'scheduler',
      purpose: 'Update the approved appointment.',
      runId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f104',
      recordAllowlist: [
        {
          dataClass: 'calendar.events',
          recordId: targetId('secondary'),
          fields: ['summary'],
        },
      ],
      provider: 'google-calendar',
      createdAt: '2026-08-09T12:00:00.000Z',
      expiresAt: '2026-08-09T12:10:00.000Z',
      oneRunOnly: true as const,
    };
    const proposalInput = {
      schemaVersion: 1 as const,
      id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f105',
      version: 1,
      runId: disclosureGrant.runId,
      capabilityId: 'google-calendar.event.update',
      capabilityFingerprint: 'c'.repeat(64),
      canonicalArguments,
      targets: [
        {
          kind: 'google-calendar.event',
          id: targetId('primary'),
          expectedVersion: 'event-v3',
        },
      ],
      beforePreview: {
        calendarId: 'primary',
        ...event,
        eventVersion: 'event-v3',
      },
      afterPreview: replacement,
      providerPreconditions: [
        {
          kind: 'calendar-version',
          targetId: 'primary',
          expectedValue: 'calendar-v7',
        },
        {
          kind: 'event-version',
          targetId: targetId('primary'),
          expectedValue: 'event-v3',
        },
      ],
      payloadHash: hashCanonicalJson(canonicalArguments),
      disclosureGrant,
      createdAt: '2026-08-09T12:00:00.000Z',
      expiresAt: '2026-08-09T12:10:00.000Z',
      idempotencyKey: 'scheduler-scope-test-1',
      state: 'pending' as const,
    };
    const proposal = ActionProposalSchema.parse({
      ...proposalInput,
      approvalHash: hashActionProposalApproval(proposalInput),
    });
    const service = new ProposalService(
      new ScopedCalendarProposalMaterializer(scopedReader),
      { resolve: async () => disclosureGrant },
      undefined,
      () => new Date('2026-08-09T12:05:00.000Z'),
    );

    await expect(service.create(proposal)).rejects.toMatchObject({
      code: 'calendar-authorization-invalid',
    });
    expect(readCalls).toBe(0);
  });
});

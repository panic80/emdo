import {
  ActionProposalSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
} from '@emdo/contracts';
import { hashCanonicalJson } from '@emdo/toolbox';
import { describe, expect, it } from 'vitest';

import {
  CalendarProposalMaterializer,
  ScopedCalendarProposalMaterializer,
} from './proposals.js';
import {
  InMemoryProposalRepository,
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

const authorizationScopeFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse('e'.repeat(64));
const providerAuthorityBinding = {
  kind: 'google-calendar-grant-v2' as const,
  householdId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f203',
  privateSpaceId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f205',
  authorizationScopeFingerprint,
  providerGrantReference: 'google-grant-reference-1',
  authorizationEpoch: 1,
};
const proposalSpaceAccessGrantId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f206';
const providerAuthorityBindingHash = hashCanonicalJson(
  providerAuthorityBinding,
);
const testInvocationContext = (runId: string, actorId: string) =>
  ({
    orchestrationRunId: runId,
    parentInvocationId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f210',
    agentInvocationId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f211',
    phaseInvocationId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f212',
    actorId,
    locale: 'en-CA' as const,
    grantedCapabilities: ['google-calendar.event.create'],
    disclosedContextRefs: [
      `context-ref-${hashCanonicalJson({
        dataClass: 'agent.delegations',
        recordId: 'scheduler-delegation-1',
      })}`,
    ],
    deadline: '2026-08-09T12:10:00.000Z',
    idempotencyScope: '2'.repeat(64),
  }) as const;

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
      providerAuthorityBinding,
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
      providerAuthorityBindingHash,
      targets: [
        {
          kind: 'google-calendar.event',
          id: targetId('secondary'),
          expectedVersion: 'absent',
        },
      ],
      beforePreview: null,
      afterPreview: {
        ...event,
        attendeeNotificationPolicy: {
          sendUpdates: 'none',
          disclosure:
            'Attendee invitation and update notifications will not be sent.',
        },
      },
      approvalDisplay: {
        schemaVersion: 1 as const,
        title: 'Create Google Calendar event',
        summary:
          'Review the exact event details before creating it in Google Calendar.',
        beforeSummary: 'No event exists at the approved target.',
        afterSummary: 'The approved event will be created.',
        fields: [
          { label: 'Calendar', value: 'secondary' },
          { label: 'Title', value: 'Dentist' },
          { label: 'Starts', value: '2026-08-10T15:00:00.000Z' },
          { label: 'Ends', value: '2026-08-10T16:00:00.000Z' },
          { label: 'Time zone', value: 'America/Toronto' },
          { label: 'Location', value: 'Clinic' },
        ],
      },
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
      afterPreview: {
        ...replacement,
        attendeeNotificationPolicy: {
          sendUpdates: 'none',
          disclosure:
            'Attendee invitation and update notifications will not be sent.',
        },
      },
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
      beforePreview: expect.objectContaining({
        summary: 'Dentist',
        attendeeNotificationPolicy: {
          sendUpdates: 'none',
          disclosure: 'Attendee cancellation notifications will not be sent.',
        },
      }),
      afterPreview: null,
      approvalDisplay: {
        schemaVersion: 1,
        title: 'Delete Google Calendar event',
        summary:
          'Review the exact event identifiers before deleting it in Google Calendar.',
        beforeSummary: 'The event at the approved target will be deleted.',
        afterSummary: 'No event will remain at the approved target.',
        fields: [
          { label: 'Calendar', value: 'primary' },
          { label: 'Event ID', value: event.eventId },
          { label: 'Expected calendar version', value: 'calendar-v7' },
          { label: 'Expected event version', value: 'event-v3' },
        ],
      },
    });
  });

  it('rejects capability mismatches, stale state, extra fields, and create overwrite', async () => {
    const materializer = new CalendarProposalMaterializer(
      reader,
      providerAuthorityBinding,
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
      providerAuthorityBinding,
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
    expect(Object.isFrozen(result.approvalDisplay)).toBe(true);
    expect(Object.isFrozen(result.approvalDisplay.fields)).toBe(true);
  });

  it('rejects display-spoofing controls before a proposal can be persisted', async () => {
    const materializer = new CalendarProposalMaterializer(
      {
        readTargetState: async ({ calendarId, eventId }) => ({
          calendarId,
          queriedEventId: eventId,
          calendarVersion: 'calendar-v2',
          event: null,
        }),
      },
      providerAuthorityBinding,
    );

    await expect(
      materializer.materialize({
        capabilityId: 'google-calendar.event.create',
        canonicalArguments: {
          operation: 'create',
          calendarId: 'secondary',
          expectedCalendarVersion: 'calendar-v2',
          event: { ...event, summary: 'Dentist\u202Eapproved' },
        },
      }),
    ).rejects.toMatchObject({ code: 'calendar-arguments-invalid' });
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
      providerAuthorityBinding,
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
      providerAuthorityBinding,
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
      providerAuthorityBinding,
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
      providerAuthorityBinding,
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

  it('accepts the real scheduler delegation grant and keeps it out of the provider state request', async () => {
    const readRequests: unknown[] = [];
    const materializer = new ScopedCalendarProposalMaterializer(
      {
        readTargetState: async (request) => {
          readRequests.push(request);
          const { calendarId, eventId } = request;
          return {
            calendarId,
            queriedEventId: eventId,
            calendarVersion: 'calendar-v7',
            event: null,
          };
        },
      },
      providerAuthorityBinding,
    );
    const invocationContext = testInvocationContext(
      '018f1f5e-6f47-7d61-a6dd-1e86f8b8f204',
      '018f1f5e-6f47-7d61-a6dd-1e86f8b8f202',
    );
    const disclosureGrant = {
      schemaVersion: 1 as const,
      id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f111',
      version: 1,
      userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f202',
      householdId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f203',
      agentId: 'scheduler',
      purpose: 'Create the requested calendar appointment.',
      runId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f204',
      invocationContext,
      invocationContextHash: hashCanonicalJson(invocationContext),
      recordAllowlist: [
        {
          dataClass: 'agent.delegations',
          recordId: 'scheduler-delegation-1',
          fields: ['delegation'],
        },
      ],
      provider: 'openai',
      createdAt: '2026-08-09T12:00:00.000Z',
      expiresAt: '2026-08-09T12:10:00.000Z',
      oneRunOnly: true as const,
    };
    const input = {
      capabilityId: 'google-calendar.event.create' as const,
      capabilityFingerprint: 'c'.repeat(64),
      canonicalArguments: {
        operation: 'create' as const,
        calendarId: 'primary',
        expectedCalendarVersion: 'calendar-v7',
        event,
      },
      disclosureGrant,
      now: new Date('2026-08-09T12:05:00.000Z'),
    };

    await expect(materializer.materialize(input)).resolves.toMatchObject({
      approvalDisplay: { title: 'Create Google Calendar event' },
    });
    expect(readRequests).toEqual([
      { calendarId: 'primary', eventId: event.eventId },
    ]);
    await expect(
      materializer.materialize({
        ...input,
        disclosureGrant: { ...disclosureGrant, provider: 'google-calendar' },
      }),
    ).rejects.toMatchObject({ code: 'calendar-authorization-invalid' });
    await expect(
      materializer.materialize({
        ...input,
        disclosureGrant: {
          ...disclosureGrant,
          householdId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f999',
        },
      }),
    ).rejects.toMatchObject({ code: 'calendar-authorization-invalid' });
    await expect(
      materializer.materialize({
        ...input,
        disclosureGrant: {
          ...disclosureGrant,
          recordAllowlist: [
            {
              dataClass: 'agent.delegations',
              recordId: 'scheduler-delegation-1',
              fields: ['other'],
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'calendar-authorization-invalid' });
  });

  it('rejects a scheduler model grant without the delegation source before provider state access', async () => {
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
    const invocationContext = testInvocationContext(
      '018f1f5e-6f47-7d61-a6dd-1e86f8b8f104',
      '018f1f5e-6f47-7d61-a6dd-1e86f8b8f102',
    );
    const disclosureGrant = {
      schemaVersion: 1 as const,
      id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f101',
      version: 1,
      userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f102',
      householdId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f103',
      agentId: 'scheduler',
      purpose: 'Update the approved appointment.',
      runId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f104',
      invocationContext,
      invocationContextHash: hashCanonicalJson(invocationContext),
      recordAllowlist: [
        {
          dataClass: 'agent.delegations',
          recordId: 'scheduler-delegation-1',
          fields: ['not-delegation'],
        },
      ],
      provider: 'openai',
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
      authorizationScopeFingerprint:
        providerAuthorityBinding.authorizationScopeFingerprint,
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
      approvalDisplay: {
        schemaVersion: 1 as const,
        title: 'Update Google Calendar event',
        summary:
          'Review the exact event details before updating it in Google Calendar.',
        beforeSummary: 'The current event will be replaced.',
        afterSummary: 'The approved event details will replace it.',
        fields: [
          { label: 'Calendar', value: 'primary' },
          { label: 'Title', value: replacement.summary },
          { label: 'Starts', value: replacement.start },
          { label: 'Ends', value: replacement.end },
          { label: 'Time zone', value: replacement.timeZone },
          { label: 'Location', value: replacement.location },
        ],
      },
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
      providerAuthorityBindingHash,
      providerSdkCallId: 'call-scheduler-scope-test-1',
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
      new ScopedCalendarProposalMaterializer(
        scopedReader,
        providerAuthorityBinding,
      ),
      { resolve: async () => disclosureGrant },
      new InMemoryProposalRepository(),
      () => new Date('2026-08-09T12:05:00.000Z'),
    );

    await expect(
      service.create(proposal, {
        proposalId: proposal.id,
        originRequestId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f106',
        runId: proposal.runId,
        householdId: disclosureGrant.householdId,
        userId: disclosureGrant.userId,
        originSessionId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f107',
        agentId: disclosureGrant.agentId,
        originSpaceAccessGrantId: proposalSpaceAccessGrantId,
        disclosureGrantId: disclosureGrant.id,
        disclosurePolicyVersion: '1.0.0',
        capabilityId: proposal.capabilityId,
        sdkCallId: proposal.providerSdkCallId,
        providerAuthorityBindingHash,
      }),
    ).rejects.toMatchObject({
      code: 'calendar-authorization-invalid',
    });
    expect(readCalls).toBe(0);
  });
});

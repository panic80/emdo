import {
  ActionProposalApprovalDisplaySchema,
  DataDisclosureGrantSchema,
  JsonValueSchema,
  ProviderWriteAuthorityBindingSchema,
  deepFreeze,
  type ActionProposalApprovalDisplay,
  type DeepReadonly,
  type JsonValue,
  type ProviderWriteAuthorityBinding,
} from '@emdo/contracts';
import { hashCanonicalJson } from '@emdo/toolbox';
import { z } from 'zod';

import { SchedulerDomainError } from './errors.js';
import type { TrustedProposalMaterializer } from '../shared/proposals.js';
import {
  expandTorontoRecurrence,
  formatTorontoInstant,
  resolveTorontoLocalDateTime,
} from './timezone.js';
import { boundedSafeParse } from './validation.js';

const ReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      }),
    'Reference contains control characters',
  );
const GoogleEventIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      }),
    'Google event ID contains control characters',
  );
const VersionSchema = z.string().trim().min(1).max(512);
const EventTextSchema = z.string().trim().min(1).max(8_000);
const EmailSchema = z.email().max(320);

export const CalendarEventPayloadSchema = z
  .strictObject({
    eventId: GoogleEventIdSchema,
    summary: EventTextSchema.max(2_000),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    timeZone: z.literal('America/Toronto'),
    location: EventTextSchema.max(2_000).optional(),
    description: EventTextSchema.optional(),
    attendees: z.array(EmailSchema).max(100).optional(),
    recurrence: z
      .strictObject({
        frequency: z.enum(['daily', 'weekly']),
        interval: z.number().int().safe().min(1).max(52),
        count: z.number().int().safe().min(1).max(366),
        disambiguation: z.enum(['reject', 'earlier', 'later']),
        byWeekday: z
          .array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']))
          .min(1)
          .max(7)
          .optional(),
      })
      .optional(),
  })
  .superRefine((event, context) => {
    if (Date.parse(event.end) <= Date.parse(event.start)) {
      context.addIssue({
        code: 'custom',
        path: ['end'],
        message: 'Event end must be after its start',
      });
    }
    if (
      Date.parse(event.start) % 60_000 !== 0 ||
      Date.parse(event.end) % 60_000 !== 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['start'],
        message: 'Scheduler events must use minute-aligned timestamps',
      });
    }
  });

const CreateArgumentsSchema = z.strictObject({
  operation: z.literal('create'),
  calendarId: ReferenceSchema,
  expectedCalendarVersion: VersionSchema,
  event: CalendarEventPayloadSchema,
});
const UpdateArgumentsSchema = z
  .strictObject({
    operation: z.literal('update'),
    calendarId: ReferenceSchema,
    eventId: GoogleEventIdSchema,
    expectedCalendarVersion: VersionSchema,
    expectedEventVersion: VersionSchema,
    replacement: CalendarEventPayloadSchema,
  })
  .superRefine((value, context) => {
    if (value.eventId !== value.replacement.eventId) {
      context.addIssue({
        code: 'custom',
        path: ['replacement', 'eventId'],
        message: 'Replacement event ID must match the target event ID',
      });
    }
  });
const DeleteArgumentsSchema = z.strictObject({
  operation: z.literal('delete'),
  calendarId: ReferenceSchema,
  eventId: GoogleEventIdSchema,
  expectedCalendarVersion: VersionSchema,
  expectedEventVersion: VersionSchema,
});

const MaterializationInputSchema = z.strictObject({
  capabilityId: z.enum([
    'google-calendar.event.create',
    'google-calendar.event.update',
    'google-calendar.event.delete',
  ]),
  canonicalArguments: z.unknown(),
});

export const CalendarCanonicalArgumentsSchema = z.discriminatedUnion(
  'operation',
  [CreateArgumentsSchema, UpdateArgumentsSchema, DeleteArgumentsSchema],
);
export type CalendarCanonicalArguments = z.infer<
  typeof CalendarCanonicalArgumentsSchema
>;

const CalendarEventRecordSchema = CalendarEventPayloadSchema.extend({
  calendarId: ReferenceSchema,
  eventVersion: VersionSchema,
});
export type CalendarEventRecord = z.infer<typeof CalendarEventRecordSchema>;

const CalendarTargetStateSchema = z.strictObject({
  calendarId: ReferenceSchema,
  queriedEventId: GoogleEventIdSchema,
  calendarVersion: VersionSchema,
  event: CalendarEventRecordSchema.nullable(),
});

export interface CalendarProposalReadRequest {
  readonly calendarId: string;
  readonly eventId: string;
}

export interface CalendarProposalStateReader {
  /**
   * Request-scoped adapter that obtains a conditional provider snapshot from
   * its server-owned authority. Only canonical target identifiers cross this
   * boundary; disclosure grants and record allowlists never do.
   */
  readTargetState(request: CalendarProposalReadRequest): Promise<unknown>;
}

export interface CalendarProposalMaterialization {
  readonly providerAuthorityBindingHash: string;
  readonly approvalDisplay: ActionProposalApprovalDisplay;
  readonly targets: readonly {
    readonly kind: 'google-calendar.event';
    readonly id: string;
    readonly expectedVersion: string;
  }[];
  readonly beforePreview: DeepReadonly<JsonValue>;
  readonly afterPreview: DeepReadonly<JsonValue>;
  readonly providerPreconditions: readonly {
    readonly kind: 'calendar-version' | 'event-absence' | 'event-version';
    readonly targetId: string;
    readonly expectedValue: string;
  }[];
}

const capabilityForOperation = {
  create: 'google-calendar.event.create',
  update: 'google-calendar.event.update',
  delete: 'google-calendar.event.delete',
} as const;

const invalidArguments = (): never => {
  throw new SchedulerDomainError(
    'calendar-arguments-invalid',
    'Calendar action arguments are invalid or exceed their bounds.',
  );
};

const targetIdFor = (calendarId: string, eventId: string): string =>
  `${calendarId.length}:${calendarId}${eventId.length}:${eventId}`;

const parseEventRecord = (input: unknown): CalendarEventRecord | null => {
  if (input === null) return null;
  const parsed = boundedSafeParse(CalendarEventRecordSchema, input);
  if (!parsed.success) {
    throw new SchedulerDomainError(
      'calendar-precondition-failed',
      'The current provider event could not be validated.',
    );
  }
  return parsed.data;
};

const asPreview = (
  input: unknown,
  operation: 'create' | 'update' | 'delete',
): JsonValue =>
  JsonValueSchema.parse({
    ...(input as Record<string, unknown>),
    attendeeNotificationPolicy: {
      sendUpdates: 'none',
      disclosure:
        operation === 'delete'
          ? 'Attendee cancellation notifications will not be sent.'
          : 'Attendee invitation and update notifications will not be sent.',
    },
  });

const displayFieldsForEvent = (
  calendarId: string,
  event: z.infer<typeof CalendarEventPayloadSchema>,
): readonly { readonly label: string; readonly value: string }[] => [
  { label: 'Calendar', value: calendarId },
  { label: 'Title', value: event.summary },
  { label: 'Starts', value: event.start },
  { label: 'Ends', value: event.end },
  { label: 'Time zone', value: event.timeZone },
  ...(event.location === undefined
    ? []
    : [{ label: 'Location', value: event.location }]),
  ...(event.description === undefined
    ? []
    : [{ label: 'Description', value: event.description }]),
  ...(event.attendees === undefined
    ? []
    : [{ label: 'Attendees', value: event.attendees.join(', ') }]),
  ...(event.recurrence === undefined
    ? []
    : [{ label: 'Recurrence', value: JSON.stringify(event.recurrence) }]),
];

const approvalDisplayFor = (
  operation: 'create' | 'update',
  calendarId: string,
  event: z.infer<typeof CalendarEventPayloadSchema>,
): ActionProposalApprovalDisplay => {
  const verb = operation === 'create' ? 'creating' : 'updating';
  const titleVerb = operation === 'create' ? 'Create' : 'Update';
  const parsed = ActionProposalApprovalDisplaySchema.safeParse({
    schemaVersion: 1,
    title: `${titleVerb} Google Calendar event`,
    summary: `Review the exact event details before ${verb} it in Google Calendar.`,
    beforeSummary:
      operation === 'create'
        ? 'No event exists at the approved target.'
        : 'The current event will be replaced.',
    afterSummary:
      operation === 'create'
        ? 'The approved event will be created.'
        : 'The approved event details will replace it.',
    fields: displayFieldsForEvent(calendarId, event),
  });
  if (!parsed.success) return invalidArguments();
  return parsed.data;
};

const deleteApprovalDisplayFor = (
  argumentsValue: Extract<
    CalendarCanonicalArguments,
    { readonly operation: 'delete' }
  >,
): ActionProposalApprovalDisplay => {
  const parsed = ActionProposalApprovalDisplaySchema.safeParse({
    schemaVersion: 1,
    title: 'Delete Google Calendar event',
    summary:
      'Review the exact event identifiers before deleting it in Google Calendar.',
    beforeSummary: 'The event at the approved target will be deleted.',
    afterSummary: 'No event will remain at the approved target.',
    fields: [
      { label: 'Calendar', value: argumentsValue.calendarId },
      { label: 'Event ID', value: argumentsValue.eventId },
      {
        label: 'Expected calendar version',
        value: argumentsValue.expectedCalendarVersion,
      },
      {
        label: 'Expected event version',
        value: argumentsValue.expectedEventVersion,
      },
    ],
  });
  if (!parsed.success) return invalidArguments();
  return parsed.data;
};

const assertRecurrenceDeterministic = (
  event: z.infer<typeof CalendarEventPayloadSchema>,
): void => {
  if (event.recurrence === undefined) return;
  const { disambiguation, ...rule } = event.recurrence;
  try {
    const localStartDateTime = formatTorontoInstant(event.start).localDateTime;
    if (
      resolveTorontoLocalDateTime(localStartDateTime, disambiguation)
        .instant !== new Date(event.start).toISOString()
    ) {
      return invalidArguments();
    }
    const occurrences = expandTorontoRecurrence({
      startLocalDateTime: localStartDateTime,
      durationMinutes:
        (Date.parse(event.end) - Date.parse(event.start)) / 60_000,
      rule,
      rangeStart: event.start,
      rangeEnd: new Date(
        Date.parse(event.start) + 10 * 366 * 86_400_000,
      ).toISOString(),
      disambiguation,
    });
    if (
      occurrences.length !== rule.count ||
      occurrences[0]?.start !== new Date(event.start).toISOString()
    ) {
      return invalidArguments();
    }
  } catch {
    return invalidArguments();
  }
};

/**
 * Re-materializes visual previews from strict canonical arguments and current
 * provider state. It never trusts a model-supplied preview or target list.
 */
export class CalendarProposalMaterializer {
  readonly #providerAuthorityBindingHash: string;

  constructor(
    private readonly reader: CalendarProposalStateReader,
    authorityBindingInput: unknown,
  ) {
    const authorityBinding = boundedSafeParse(
      ProviderWriteAuthorityBindingSchema,
      authorityBindingInput,
    );
    if (!authorityBinding.success) {
      throw new SchedulerDomainError(
        'calendar-authorization-invalid',
        'The calendar proposal authority is invalid.',
      );
    }
    this.#providerAuthorityBindingHash = hashCanonicalJson(
      authorityBinding.data,
    );
  }

  async materialize(input: unknown): Promise<CalendarProposalMaterialization> {
    const materializationInput = boundedSafeParse(
      MaterializationInputSchema,
      input,
    );
    if (!materializationInput.success) return invalidArguments();
    const parsed = boundedSafeParse(
      CalendarCanonicalArgumentsSchema,
      materializationInput.data.canonicalArguments,
    );
    if (!parsed.success) return invalidArguments();
    const argumentsValue = parsed.data;
    if (argumentsValue.operation === 'create') {
      assertRecurrenceDeterministic(argumentsValue.event);
    } else if (argumentsValue.operation === 'update') {
      assertRecurrenceDeterministic(argumentsValue.replacement);
    }
    if (
      materializationInput.data.capabilityId !==
      capabilityForOperation[argumentsValue.operation]
    ) {
      throw new SchedulerDomainError(
        'calendar-capability-mismatch',
        'The capability does not match the canonical calendar operation.',
      );
    }

    const eventId =
      argumentsValue.operation === 'create'
        ? argumentsValue.event.eventId
        : argumentsValue.eventId;
    const targetId = targetIdFor(argumentsValue.calendarId, eventId);
    let rawState: unknown;
    try {
      rawState = await this.reader.readTargetState(
        deepFreeze({
          calendarId: argumentsValue.calendarId,
          eventId,
        }),
      );
    } catch {
      throw new SchedulerDomainError(
        'calendar-precondition-failed',
        'Current calendar state could not be revalidated.',
      );
    }
    const state = boundedSafeParse(CalendarTargetStateSchema, rawState);
    if (
      !state.success ||
      state.data.calendarId !== argumentsValue.calendarId ||
      state.data.queriedEventId !== eventId ||
      state.data.calendarVersion !== argumentsValue.expectedCalendarVersion
    ) {
      throw new SchedulerDomainError(
        'calendar-precondition-failed',
        'The calendar version changed before proposal materialization.',
      );
    }
    const currentEvent = parseEventRecord(state.data.event);

    if (argumentsValue.operation === 'create') {
      if (currentEvent !== null) {
        throw new SchedulerDomainError(
          'calendar-event-already-exists',
          'The proposed calendar event ID already exists.',
        );
      }
      return deepFreeze({
        providerAuthorityBindingHash: this.#providerAuthorityBindingHash,
        approvalDisplay: approvalDisplayFor(
          'create',
          argumentsValue.calendarId,
          argumentsValue.event,
        ),
        targets: [
          {
            kind: 'google-calendar.event' as const,
            id: targetId,
            expectedVersion: 'absent',
          },
        ],
        beforePreview: null,
        afterPreview: asPreview(argumentsValue.event, 'create'),
        providerPreconditions: [
          {
            kind: 'calendar-version' as const,
            targetId: argumentsValue.calendarId,
            expectedValue: argumentsValue.expectedCalendarVersion,
          },
          {
            kind: 'event-absence' as const,
            targetId,
            expectedValue: 'absent',
          },
        ],
      });
    }

    if (currentEvent === null) {
      throw new SchedulerDomainError(
        'calendar-event-not-found',
        'The target calendar event does not exist.',
      );
    }
    if (
      currentEvent.calendarId !== argumentsValue.calendarId ||
      currentEvent.eventId !== argumentsValue.eventId ||
      currentEvent.eventVersion !== argumentsValue.expectedEventVersion
    ) {
      throw new SchedulerDomainError(
        'calendar-precondition-failed',
        'The calendar event version changed before proposal materialization.',
      );
    }

    return deepFreeze({
      providerAuthorityBindingHash: this.#providerAuthorityBindingHash,
      approvalDisplay:
        argumentsValue.operation === 'update'
          ? approvalDisplayFor(
              'update',
              argumentsValue.calendarId,
              argumentsValue.replacement,
            )
          : deleteApprovalDisplayFor(argumentsValue),
      targets: [
        {
          kind: 'google-calendar.event' as const,
          id: targetId,
          expectedVersion: argumentsValue.expectedEventVersion,
        },
      ],
      beforePreview: asPreview(currentEvent, argumentsValue.operation),
      afterPreview:
        argumentsValue.operation === 'update'
          ? asPreview(argumentsValue.replacement, 'update')
          : null,
      providerPreconditions: [
        {
          kind: 'calendar-version' as const,
          targetId: argumentsValue.calendarId,
          expectedValue: argumentsValue.expectedCalendarVersion,
        },
        {
          kind: 'event-version' as const,
          targetId,
          expectedValue: argumentsValue.expectedEventVersion,
        },
      ],
    });
  }
}

/** Adapter used by the shared proposal service with server-scoped grant data. */
export class ScopedCalendarProposalMaterializer implements TrustedProposalMaterializer {
  readonly #authorityBinding: ProviderWriteAuthorityBinding;

  constructor(
    private readonly reader: CalendarProposalStateReader,
    authorityBindingInput: unknown,
  ) {
    const authorityBinding = boundedSafeParse(
      ProviderWriteAuthorityBindingSchema,
      authorityBindingInput,
    );
    if (!authorityBinding.success) {
      throw new SchedulerDomainError(
        'calendar-authorization-invalid',
        'The calendar proposal provider authority is invalid.',
      );
    }
    this.#authorityBinding = deepFreeze(authorityBinding.data);
  }

  async materialize(
    input: Parameters<TrustedProposalMaterializer['materialize']>[0],
  ): Promise<CalendarProposalMaterialization> {
    const grant = boundedSafeParse(
      DataDisclosureGrantSchema,
      input.disclosureGrant,
    );
    const now = input.now.getTime();
    if (
      !grant.success ||
      grant.data.agentId !== 'scheduler' ||
      grant.data.provider !== 'openai' ||
      grant.data.householdId !== this.#authorityBinding.householdId ||
      !Number.isSafeInteger(now) ||
      now < Date.parse(grant.data.createdAt) ||
      now >= Date.parse(grant.data.expiresAt)
    ) {
      throw new SchedulerDomainError(
        'calendar-authorization-invalid',
        'The calendar proposal is not bound to a scheduler model disclosure grant.',
      );
    }
    const hasDelegationSource = grant.data.recordAllowlist.some(
      (record) =>
        record.dataClass === 'agent.delegations' &&
        record.fields.length === 1 &&
        record.fields[0] === 'delegation',
    );
    if (!hasDelegationSource) {
      throw new SchedulerDomainError(
        'calendar-authorization-invalid',
        'The disclosure grant has no valid scheduler delegation source.',
      );
    }
    return new CalendarProposalMaterializer(
      this.reader,
      this.#authorityBinding,
    ).materialize({
      capabilityId: input.capabilityId,
      canonicalArguments: input.canonicalArguments,
    });
  }
}

import {
  DataDisclosureGrantSchema,
  JsonValueSchema,
  deepFreeze,
  type DeepReadonly,
  type JsonValue,
} from '@emdo/contracts';
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
const TargetReferenceSchema = z
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
    'Target reference contains control characters',
  );
const GoogleEventIdSchema = z
  .string()
  .min(5)
  .max(240)
  .regex(/^[0-9a-v]+$/);
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

const CalendarDisclosureFieldSchema = z.enum([
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
]);

const CalendarProposalReadScopeSchema = z.strictObject({
  grantId: ReferenceSchema,
  userId: ReferenceSchema,
  householdId: ReferenceSchema,
  runId: ReferenceSchema,
  agentId: z.literal('scheduler'),
  provider: z.literal('google-calendar'),
  recordAllowlist: z
    .array(
      z.strictObject({
        dataClass: z.literal('calendar.events'),
        recordId: TargetReferenceSchema,
        fields: z.array(CalendarDisclosureFieldSchema).min(1).max(12),
      }),
    )
    .min(1)
    .max(256),
});

export type CalendarProposalReadScope = DeepReadonly<
  z.infer<typeof CalendarProposalReadScopeSchema>
>;

export interface CalendarProposalReadRequest {
  readonly scope: CalendarProposalReadScope;
  readonly calendarId: string;
  readonly eventId: string;
}

export interface CalendarProposalStateReader {
  /** One grant-scoped snapshot prevents torn or cross-tenant previews. */
  readTargetState(request: CalendarProposalReadRequest): Promise<unknown>;
}

export interface CalendarProposalMaterialization {
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

const eventFieldName = {
  eventId: 'event-id',
  summary: 'summary',
  start: 'start',
  end: 'end',
  timeZone: 'time-zone',
  location: 'location',
  description: 'description',
  attendees: 'attendees',
  recurrence: 'recurrence',
} as const;

type CalendarDisclosureField = z.infer<typeof CalendarDisclosureFieldSchema>;

const assertFieldsAllowed = (
  allowed: ReadonlySet<CalendarDisclosureField>,
  required: readonly CalendarDisclosureField[],
): void => {
  if (required.some((field) => !allowed.has(field))) {
    throw new SchedulerDomainError(
      'calendar-authorization-invalid',
      'The disclosure grant does not allow the required calendar fields.',
    );
  }
};

const fieldsForEvent = (
  eventValue: z.infer<typeof CalendarEventPayloadSchema>,
): CalendarDisclosureField[] =>
  Object.keys(eventValue).flatMap((key) => {
    const field = eventFieldName[key as keyof typeof eventFieldName];
    return field === undefined ? [] : [field];
  });

const targetDisclosureFields = (
  scope: CalendarProposalReadScope,
  targetId: string,
): ReadonlySet<CalendarDisclosureField> => {
  const matching = scope.recordAllowlist.filter(
    (record) =>
      record.dataClass === 'calendar.events' && record.recordId === targetId,
  );
  if (matching.length !== 1) {
    throw new SchedulerDomainError(
      'calendar-authorization-invalid',
      'The disclosure grant is not scoped to the exact calendar event.',
    );
  }
  return new Set(matching[0]!.fields);
};

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

const asPreview = (input: unknown): JsonValue => JsonValueSchema.parse(input);

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
  readonly #scope: CalendarProposalReadScope;

  constructor(
    private readonly reader: CalendarProposalStateReader,
    scopeInput: unknown,
  ) {
    const scope = boundedSafeParse(CalendarProposalReadScopeSchema, scopeInput);
    if (!scope.success) {
      throw new SchedulerDomainError(
        'calendar-authorization-invalid',
        'The calendar proposal read scope is invalid.',
      );
    }
    this.#scope = deepFreeze(scope.data);
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
    const allowedFields = targetDisclosureFields(this.#scope, targetId);
    const proposedEvent =
      argumentsValue.operation === 'create'
        ? argumentsValue.event
        : argumentsValue.operation === 'update'
          ? argumentsValue.replacement
          : undefined;
    assertFieldsAllowed(allowedFields, [
      'calendar-id',
      'calendar-version',
      'event-id',
      ...(argumentsValue.operation === 'create'
        ? []
        : (['event-version', 'summary', 'start', 'end', 'time-zone'] as const)),
      ...(proposedEvent === undefined ? [] : fieldsForEvent(proposedEvent)),
    ]);
    let rawState: unknown;
    try {
      rawState = await this.reader.readTargetState(
        deepFreeze({
          scope: this.#scope,
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
    if (currentEvent !== null) {
      assertFieldsAllowed(allowedFields, [
        'calendar-id',
        'event-id',
        'event-version',
        ...fieldsForEvent(currentEvent),
      ]);
    }

    if (argumentsValue.operation === 'create') {
      if (currentEvent !== null) {
        throw new SchedulerDomainError(
          'calendar-event-already-exists',
          'The proposed calendar event ID already exists.',
        );
      }
      return deepFreeze({
        targets: [
          {
            kind: 'google-calendar.event' as const,
            id: targetId,
            expectedVersion: 'absent',
          },
        ],
        beforePreview: null,
        afterPreview: asPreview(argumentsValue.event),
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
      targets: [
        {
          kind: 'google-calendar.event' as const,
          id: targetId,
          expectedVersion: argumentsValue.expectedEventVersion,
        },
      ],
      beforePreview: asPreview(currentEvent),
      afterPreview:
        argumentsValue.operation === 'update'
          ? asPreview(argumentsValue.replacement)
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
  constructor(private readonly reader: CalendarProposalStateReader) {}

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
      grant.data.provider !== 'google-calendar' ||
      !Number.isSafeInteger(now) ||
      now < Date.parse(grant.data.createdAt) ||
      now >= Date.parse(grant.data.expiresAt)
    ) {
      throw new SchedulerDomainError(
        'calendar-authorization-invalid',
        'The calendar proposal is not bound to a scheduler Calendar grant.',
      );
    }
    const calendarRecords = grant.data.recordAllowlist.filter(
      (record) => record.dataClass === 'calendar.events',
    );
    const scope = boundedSafeParse(CalendarProposalReadScopeSchema, {
      grantId: grant.data.id,
      userId: grant.data.userId,
      householdId: grant.data.householdId,
      runId: grant.data.runId,
      agentId: grant.data.agentId,
      provider: grant.data.provider,
      recordAllowlist: calendarRecords,
    });
    if (!scope.success) {
      throw new SchedulerDomainError(
        'calendar-authorization-invalid',
        'The disclosure grant has no valid Calendar record scope.',
      );
    }
    return new CalendarProposalMaterializer(
      this.reader,
      scope.data,
    ).materialize({
      capabilityId: input.capabilityId,
      canonicalArguments: input.canonicalArguments,
    });
  }
}

import { z } from 'zod';

import {
  deepFreeze,
  OpaqueReferenceSchema,
  type DeepReadonly,
} from '@emdo/contracts';
import {
  CalendarCanonicalArgumentsSchema,
  type CalendarCanonicalArguments,
} from '@emdo/domains/scheduler';
import type { CalendarWriteResult } from '@emdo/integrations/google-calendar';

import {
  parseSpecialistCapabilityInput,
  parseSpecialistCapabilityOutput,
  type ProviderWriteCapabilityId,
} from './capability-runtime.js';

const ReferenceSchema = OpaqueReferenceSchema;
const VersionSchema = z.string().trim().min(1).max(512);
const CreatedGoogleEventIdSchema = z
  .string()
  .min(5)
  .max(240)
  .regex(/^[0-9a-v]+$/u);

const CreateTrustedStateSchema = z.strictObject({
  calendarRef: ReferenceSchema,
  calendarId: ReferenceSchema,
  expectedCalendarVersion: VersionSchema,
  createdEventId: CreatedGoogleEventIdSchema,
});

const ExistingEventTrustedStateSchema = z.strictObject({
  calendarRef: ReferenceSchema,
  eventRef: ReferenceSchema,
  calendarId: ReferenceSchema,
  eventId: ReferenceSchema,
  expectedCalendarVersion: VersionSchema,
  expectedEventVersion: VersionSchema,
});

const ModelCalendarEventSchema = z.strictObject({
  summary: z.string(),
  start: z.string(),
  end: z.string(),
  timeZone: z.literal('America/Toronto'),
  location: z.string().optional(),
  description: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  recurrence: z
    .strictObject({
      frequency: z.enum(['daily', 'weekly']),
      interval: z.number(),
      count: z.number(),
      disambiguation: z.enum(['reject', 'earlier', 'later']),
      byWeekday: z
        .array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']))
        .optional(),
    })
    .optional(),
});

const CreateModelArgumentsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  calendarRef: ReferenceSchema,
  event: ModelCalendarEventSchema,
});

const UpdateModelArgumentsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  calendarRef: ReferenceSchema,
  eventRef: ReferenceSchema,
  replacement: ModelCalendarEventSchema,
});

const DeleteModelArgumentsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  calendarRef: ReferenceSchema,
  eventRef: ReferenceSchema,
});

export interface CalendarCanonicalMaterializationInput {
  readonly capabilityId: ProviderWriteCapabilityId;
  readonly modelArguments: unknown;
  /** Loaded by a server-scoped repository; never accepted from a client/model. */
  readonly trustedState: unknown;
}

const parseModelArguments = (
  capabilityId: ProviderWriteCapabilityId,
  modelArguments: unknown,
): unknown => {
  try {
    return parseSpecialistCapabilityInput(capabilityId, modelArguments);
  } catch {
    throw new Error('api-calendar-model-arguments-invalid');
  }
};

const parseTrustedState = <Output>(
  schema: z.ZodType<Output>,
  trustedState: unknown,
): Output => {
  const parsed = schema.safeParse(trustedState);
  if (!parsed.success) throw new Error('api-calendar-trusted-state-invalid');
  return parsed.data;
};

const assertOpaqueReferencesMatch = (
  ...pairs: ReadonlyArray<readonly [actual: string, trusted: string]>
): void => {
  if (pairs.some(([actual, trusted]) => actual !== trusted)) {
    throw new Error('api-calendar-trusted-state-mismatch');
  }
};

export const materializeCalendarCanonicalArguments = (
  input: CalendarCanonicalMaterializationInput,
): DeepReadonly<CalendarCanonicalArguments> => {
  const parsedModel = parseModelArguments(
    input.capabilityId,
    input.modelArguments,
  );

  let canonicalArguments: unknown;
  if (input.capabilityId === 'google-calendar.event.create') {
    const model = CreateModelArgumentsSchema.parse(parsedModel);
    const trusted = parseTrustedState(
      CreateTrustedStateSchema,
      input.trustedState,
    );
    assertOpaqueReferencesMatch([model.calendarRef, trusted.calendarRef]);
    canonicalArguments = {
      operation: 'create',
      calendarId: trusted.calendarId,
      expectedCalendarVersion: trusted.expectedCalendarVersion,
      event: { eventId: trusted.createdEventId, ...model.event },
    };
  } else if (input.capabilityId === 'google-calendar.event.update') {
    const model = UpdateModelArgumentsSchema.parse(parsedModel);
    const trusted = parseTrustedState(
      ExistingEventTrustedStateSchema,
      input.trustedState,
    );
    assertOpaqueReferencesMatch(
      [model.calendarRef, trusted.calendarRef],
      [model.eventRef, trusted.eventRef],
    );
    canonicalArguments = {
      operation: 'update',
      calendarId: trusted.calendarId,
      eventId: trusted.eventId,
      expectedCalendarVersion: trusted.expectedCalendarVersion,
      expectedEventVersion: trusted.expectedEventVersion,
      replacement: { eventId: trusted.eventId, ...model.replacement },
    };
  } else {
    const model = DeleteModelArgumentsSchema.parse(parsedModel);
    const trusted = parseTrustedState(
      ExistingEventTrustedStateSchema,
      input.trustedState,
    );
    assertOpaqueReferencesMatch(
      [model.calendarRef, trusted.calendarRef],
      [model.eventRef, trusted.eventRef],
    );
    canonicalArguments = {
      operation: 'delete',
      calendarId: trusted.calendarId,
      eventId: trusted.eventId,
      expectedCalendarVersion: trusted.expectedCalendarVersion,
      expectedEventVersion: trusted.expectedEventVersion,
    };
  }

  const parsedCanonicalArguments =
    CalendarCanonicalArgumentsSchema.safeParse(canonicalArguments);
  if (!parsedCanonicalArguments.success) {
    throw new Error('api-calendar-canonical-arguments-invalid');
  }
  return deepFreeze(parsedCanonicalArguments.data);
};

export const mapCalendarWriteResultForAgent = (
  capabilityId: ProviderWriteCapabilityId,
  result: CalendarWriteResult,
): unknown => {
  try {
    return parseSpecialistCapabilityOutput(capabilityId, {
      schemaVersion: 1,
      result,
    });
  } catch {
    throw new Error('api-calendar-executor-result-invalid');
  }
};

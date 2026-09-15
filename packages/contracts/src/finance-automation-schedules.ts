import { z } from 'zod';
import { UuidSchema, IsoDateTimeSchema } from './primitives.js';
import {
  FinanceAutomationCapabilitySchema,
  FinanceAutomationExtractionIntentSchema,
  FinanceAutomationJournalDraftIntentSchema,
  FinanceAutomationPlanningIntentSchema,
  isFinanceAutomationPlanningCapability,
} from './finance-automations.js';
import { FinanceMoneySchema } from './finance-v2.js';
const Revision = z.number().int().safe().positive();
const Ordinal = z.number().int().safe().min(0).max(1_000_000_000);
const Zone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return !/^[+-]/.test(value);
    } catch {
      return false;
    }
  }, 'An explicit supported IANA time zone is required');
const local = {
  timeZone: Zone,
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/),
  gapPolicy: z.enum(['skip', 'shift-forward']),
  overlapPolicy: z.enum(['earlier', 'later']),
  /** Trusted runtime tzdb release, pinned by persistence on explicit schedule review. */
  tzdbVersion: z.string().min(1).max(40),
};
export const FinanceAutomationCadenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('interval'),
    everySeconds: z.number().int().min(60).max(31622400),
    timeZone: Zone,
    clock: z.literal('elapsed-utc'),
  }),
  z.strictObject({
    kind: z.literal('daily'),
    anchorDate: z.iso.date(),
    everyDays: z.number().int().min(1).max(366),
    ...local,
  }),
  z.strictObject({
    kind: z.literal('weekly'),
    anchorDate: z.iso.date(),
    weekday: z.number().int().min(1).max(7),
    everyWeeks: z.number().int().min(1).max(52),
    ...local,
  }),
  z.strictObject({
    kind: z.literal('monthly'),
    anchorMonth: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
    dayOfMonth: z.number().int().min(1).max(31),
    everyMonths: z.number().int().min(1).max(12),
    shortMonthPolicy: z.enum(['skip', 'last-day']),
    ...local,
  }),
]);
export const FinanceAutomationScheduleDefinitionSchema = z
  .strictObject({
    workspaceId: UuidSchema,
    bookId: UuidSchema,
    grantId: UuidSchema,
    grantRevision: Revision,
    capability: FinanceAutomationCapabilitySchema,
    targets: z
      .array(UuidSchema)
      .min(1)
      .max(10000)
      .refine((v) => new Set(v).size === v.length, 'Duplicate target'),
    /** Versioned planning intent is a sibling of capability in scheduled input. */
    planning: FinanceAutomationPlanningIntentSchema.optional(),
    extraction: FinanceAutomationExtractionIntentSchema.optional(),
    journal: FinanceAutomationJournalDraftIntentSchema.optional(),
    money: FinanceMoneySchema.refine(
      (v) => !v.amount.startsWith('-'),
      'Nonnegative amount required',
    ),
    /** No new trigger may be planned outside this start-inclusive/end-exclusive window. */
    startAt: IsoDateTimeSchema,
    endAt: IsoDateTimeSchema.nullable(),
    cadence: FinanceAutomationCadenceSchema,
    misfire: z.discriminatedUnion('policy', [
      z.strictObject({
        policy: z.literal('skip'),
        graceSeconds: z.number().int().min(0).max(300),
      }),
      z.strictObject({
        policy: z.literal('coalesce-latest'),
        maxLatenessSeconds: z.number().int().min(0).max(86400),
      }),
    ]),
    concurrency: z.discriminatedUnion('policy', [
      z.strictObject({
        policy: z.literal('forbid'),
        onBusy: z.literal('defer'),
      }),
      z.strictObject({
        policy: z.literal('allow'),
        maxInFlight: z.number().int().min(1).max(100),
        onBusy: z.literal('defer'),
      }),
    ]),
  })
  .superRefine((value, context) => {
    for (const [field, capability, target] of [
      ['extraction', 'finance.documents.extract', value.extraction?.evidenceId],
      ['journal', 'finance.journals.draft', value.journal?.batchId],
    ] as const) {
      if ((value.capability === capability) !== (value[field] !== undefined))
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Capability requires exactly its matching source intent',
        });
      if (
        value[field] !== undefined &&
        (value.targets.length !== 1 || value.targets[0] !== target)
      )
        context.addIssue({
          code: 'custom',
          path: ['targets'],
          message: 'Schedule must target exactly the pinned source',
        });
    }
    if (value.extraction !== undefined && value.money.amount !== '0')
      context.addIssue({
        code: 'custom',
        path: ['money', 'amount'],
        message: 'Extraction schedules require zero amount',
      });
    const isPlanning = isFinanceAutomationPlanningCapability(value.capability);
    if (isPlanning !== (value.planning !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['planning'],
        message: isPlanning
          ? 'Planning capability requires a versioned planning intent'
          : 'Planning intent is only valid for a planning capability',
      });
    }
    if (value.planning !== undefined) {
      if (value.planning.capability !== value.capability)
        context.addIssue({
          code: 'custom',
          path: ['planning', 'capability'],
          message: 'Planning capability does not match the schedule capability',
        });
      if (
        value.targets.length !== 1 ||
        value.targets[0] !== value.planning.budgetId
      )
        context.addIssue({
          code: 'custom',
          path: ['targets'],
          message: 'Planning schedules must target exactly the planning budget',
        });
      if (value.money.amount !== '0')
        context.addIssue({
          code: 'custom',
          path: ['money', 'amount'],
          message: 'Planning schedules cannot reserve a nonzero amount',
        });
      if (value.money.currency !== value.planning.currency)
        context.addIssue({
          code: 'custom',
          path: ['planning', 'currency'],
          message: 'Planning currency does not match the schedule currency',
        });
    }
  })
  .refine(
    (v) => v.endAt === null || Date.parse(v.startAt) < Date.parse(v.endAt),
    'Empty schedule validity window',
  );
/** Definition revision changes cadence/intent/grant; state revision changes pause/resume.
 * Reusing a definition revision for different content is forbidden in persistence. */
export const FinanceAutomationScheduleSchema = z.strictObject({
  id: UuidSchema,
  definitionRevision: Revision,
  stateRevision: Revision,
  status: z.enum(['active', 'paused', 'retired']),
  definition: FinanceAutomationScheduleDefinitionSchema,
});
export const FinanceAutomationScheduleCursorSchema = z.strictObject({
  scheduleId: UuidSchema,
  definitionRevision: Revision,
  nextOrdinal: Ordinal,
});
export const FinanceAutomationDuePlanInputSchema = z.strictObject({
  schedule: FinanceAutomationScheduleSchema,
  cursor: FinanceAutomationScheduleCursorSchema,
  now: IsoDateTimeSchema,
  /** Trusted locked count includes queued/executing/retryable AND reconciliation runs. */
  blockingRunCount: z.number().int().safe().nonnegative(),
  runtimeTimezoneVersion: z.string().min(1).max(40),
});
export type FinanceAutomationSchedule = z.infer<
  typeof FinanceAutomationScheduleSchema
>;
export type FinanceAutomationCadence = z.infer<
  typeof FinanceAutomationCadenceSchema
>;
export type FinanceAutomationScheduleCursor = z.infer<
  typeof FinanceAutomationScheduleCursorSchema
>;

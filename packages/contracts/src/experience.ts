import { z } from 'zod';

import {
  IdentifierSchema,
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly,
} from './primitives.js';

export const TorontoLocalDateSchema = z.iso.date();
export const TorontoTimezoneSchema = z.literal('America/Toronto');

const DisplayTitleSchema = z.string().trim().min(1).max(200);
const ScheduleTitleSchema = z.string().trim().min(1).max(500);
const BoundedCountSchema = z.number().int().safe().nonnegative().max(1_000_000);

export const ExperienceScheduleItemSchema = z
  .strictObject({
    id: OpaqueReferenceSchema,
    title: ScheduleTitleSchema,
    startsAt: IsoDateTimeSchema,
    endsAt: IsoDateTimeSchema.optional(),
    completion: z.enum(['pending', 'completed', 'cancelled']),
  })
  .refine(
    ({ startsAt, endsAt }) =>
      endsAt === undefined || Date.parse(endsAt) > Date.parse(startsAt),
    {
      path: ['endsAt'],
      message: 'Schedule end must be after start',
    },
  );

const StandardReminderSchema = z.strictObject({
  id: OpaqueReferenceSchema,
  title: DisplayTitleSchema,
  sensitivity: z.literal('standard'),
  dueAt: IsoDateTimeSchema,
  state: z.enum(['scheduled', 'delivered', 'cancelled']),
});
const SensitiveReminderSchema = z.strictObject({
  id: OpaqueReferenceSchema,
  title: z.literal('Private reminder'),
  sensitivity: z.literal('sensitive'),
  dueAt: IsoDateTimeSchema,
  state: z.enum(['scheduled', 'delivered', 'cancelled']),
});
export const ExperienceReminderSchema = z.discriminatedUnion('sensitivity', [
  StandardReminderSchema,
  SensitiveReminderSchema,
]);

const StandardNotificationSchema = z.strictObject({
  id: UuidSchema,
  title: DisplayTitleSchema,
  sensitivity: z.literal('standard'),
  createdAt: IsoDateTimeSchema,
});
const SensitiveNotificationSchema = z.strictObject({
  id: UuidSchema,
  title: z.literal('Private notification'),
  sensitivity: z.literal('sensitive'),
  createdAt: IsoDateTimeSchema,
});
export const ExperienceNotificationSchema = z.discriminatedUnion(
  'sensitivity',
  [StandardNotificationSchema, SensitiveNotificationSchema],
);

const availableItems = <Item extends z.ZodType>(item: Item, maximum: number) =>
  z.strictObject({
    status: z.literal('available'),
    items: z.array(item).max(maximum),
  });
const unavailableItems = <Item extends z.ZodType>(item: Item) =>
  z.strictObject({
    status: z.literal('unavailable'),
    items: z.array(item).max(0),
  });
const itemSection = <Item extends z.ZodType>(item: Item, maximum: number) =>
  z.discriminatedUnion('status', [
    availableItems(item, maximum),
    unavailableItems(item),
  ]);

const FinanceSummarySchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    budgetCount: BoundedCountSchema,
    transactionCount: BoundedCountSchema,
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    budgetCount: z.literal(0),
    transactionCount: z.literal(0),
  }),
]);

const ShoppingSummarySchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    itemCount: BoundedCountSchema,
    retailerCount: BoundedCountSchema,
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    itemCount: z.literal(0),
    retailerCount: z.literal(0),
  }),
]);

const TodayViewBaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  date: TorontoLocalDateSchema,
  timezone: TorontoTimezoneSchema,
  schedule: itemSection(ExperienceScheduleItemSchema, 24),
  reminders: itemSection(ExperienceReminderSchema, 24),
  notifications: itemSection(ExperienceNotificationSchema, 24),
  finance: FinanceSummarySchema,
  shopping: ShoppingSummarySchema,
});
export const TodayViewSchema = TodayViewBaseSchema.transform(deepFreeze);
export type TodayView = DeepReadonly<z.input<typeof TodayViewBaseSchema>>;

const ActivityItemSchema = z.strictObject({
  id: OpaqueReferenceSchema,
  category: z.enum(['audit', 'calendar', 'notification', 'sync']),
  title: DisplayTitleSchema,
  kind: IdentifierSchema.optional(),
  status: IdentifierSchema.optional(),
  occurredAt: IsoDateTimeSchema,
});
const ActivityPageBaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  items: z.array(ActivityItemSchema).max(50),
  nextCursor: OpaqueReferenceSchema.optional(),
});
export const ActivityPageSchema = ActivityPageBaseSchema.transform(deepFreeze);
export type ActivityPage = DeepReadonly<z.input<typeof ActivityPageBaseSchema>>;

const CalendarConnectionSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unavailable') }),
  z.strictObject({ status: z.literal('disconnected') }),
  z.strictObject({
    status: z.enum(['connected', 'syncing', 'retry-pending']),
    lastSyncedAt: IsoDateTimeSchema.optional(),
  }),
]);

const SchedulePageBaseSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    timezone: TorontoTimezoneSchema,
    from: TorontoLocalDateSchema,
    to: TorontoLocalDateSchema,
    items: itemSection(ExperienceScheduleItemSchema, 50),
    nextCursor: OpaqueReferenceSchema.optional(),
    calendar: CalendarConnectionSchema,
  })
  .refine(
    ({ from, to }) => {
      const range =
        Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`);
      return range >= 0 && range <= 31 * 86_400_000;
    },
    {
      path: ['to'],
      message: 'Schedule range must be ordered and at most 31 days',
    },
  );
export const SchedulePageSchema = SchedulePageBaseSchema.transform(deepFreeze);
export type SchedulePage = DeepReadonly<z.input<typeof SchedulePageBaseSchema>>;

const FinanceTransactionViewSchema = z.strictObject({
  recordType: z.literal('transaction'),
  id: OpaqueReferenceSchema,
  description: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(80),
  postedOn: TorontoLocalDateSchema,
  currency: z.literal('CAD'),
  amountCadMinor: z.number().int().safe(),
  state: z.enum(['active', 'reversed', 'needs-review']),
});

const BudgetAllocationsSchema = z
  .record(IdentifierSchema, z.number().int().safe().nonnegative())
  .refine((allocations) => Object.keys(allocations).length <= 100, {
    message: 'A budget projection can contain at most 100 allocations',
  });

const FinanceBudgetViewSchema = z.strictObject({
  recordType: z.literal('budget'),
  id: OpaqueReferenceSchema,
  currency: z.literal('CAD'),
  allocationsCadMinor: BudgetAllocationsSchema,
});

export const FinanceItemSchema = z.discriminatedUnion('recordType', [
  FinanceTransactionViewSchema,
  FinanceBudgetViewSchema,
]);

const FinancePageBaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  items: z.array(FinanceItemSchema).max(50),
  nextCursor: OpaqueReferenceSchema.optional(),
});
export const FinancePageSchema = FinancePageBaseSchema.transform(deepFreeze);
export type FinancePage = DeepReadonly<z.input<typeof FinancePageBaseSchema>>;

export const ShoppingItemViewSchema = z.strictObject({
  id: OpaqueReferenceSchema,
  name: z.string().trim().min(1).max(120).optional(),
  unit: z.string().trim().min(1).max(40).optional(),
  retailer: z.string().trim().min(1).max(120).optional(),
  quantityMinorUnits: z.number().int().safe().nonnegative(),
  state: z.enum(['active', 'needs-review']),
});

const ShoppingPageBaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  items: z.array(ShoppingItemViewSchema).max(50),
  nextCursor: OpaqueReferenceSchema.optional(),
});
export const ShoppingPageSchema = ShoppingPageBaseSchema.transform(deepFreeze);
export type ShoppingPage = DeepReadonly<z.input<typeof ShoppingPageBaseSchema>>;

const SettingsViewBaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  household: z.strictObject({
    name: z.string().trim().min(1).max(200),
    role: z.enum(['owner', 'member']),
  }),
  privateSpaces: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(200),
      }),
    )
    .max(50),
  calendar: CalendarConnectionSchema,
});
export const SettingsViewSchema = SettingsViewBaseSchema.transform(deepFreeze);
export type SettingsView = DeepReadonly<z.input<typeof SettingsViewBaseSchema>>;

const NotificationPreferenceFields = {
  inApp: z.boolean(),
  push: z.boolean(),
  email: z.boolean(),
  spokenReplies: z.boolean(),
} as const;

const NotificationPreferencesViewBaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: z.number().int().safe().positive(),
  ...NotificationPreferenceFields,
  updatedAt: IsoDateTimeSchema,
});
export const NotificationPreferencesViewSchema =
  NotificationPreferencesViewBaseSchema.transform(deepFreeze);
export type NotificationPreferencesView = DeepReadonly<
  z.input<typeof NotificationPreferencesViewBaseSchema>
>;

const NotificationPreferencesUpdateRequestBaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  expectedVersion: z.number().int().safe().positive(),
  preferences: z.strictObject(NotificationPreferenceFields),
});
export const NotificationPreferencesUpdateRequestSchema =
  NotificationPreferencesUpdateRequestBaseSchema.transform(deepFreeze);
export type NotificationPreferencesUpdateRequest = DeepReadonly<
  z.input<typeof NotificationPreferencesUpdateRequestBaseSchema>
>;

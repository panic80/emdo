import {
  ActivityPageSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
  FinancePageSchema,
  IdempotencyKeySchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  NotificationPreferencesViewSchema,
  OpaqueReferenceSchema,
  SchedulePageSchema,
  SettingsViewSchema,
  ShoppingPageSchema,
  TodayViewSchema,
  UuidSchema,
  type ActivityPage,
  type EffectiveAuthorizationScopeFingerprint,
  type FinancePage,
  type NotificationPreferencesUpdateRequest,
  type NotificationPreferencesView,
  type SchedulePage,
  type SettingsView,
  type ShoppingPage,
  type TodayView,
} from '@emdo/contracts';
import {
  FINANCE_EXPERIENCE_LIMITS,
  FinanceExperienceSnapshotSchema,
  validateFinanceRecord,
  type FinanceExperienceSnapshot,
  type FinanceRecord,
} from '@emdo/domains/finance';
import { z } from 'zod';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  DurableRepositoryError,
  parseDurablePrincipal,
  withDurableTransaction,
} from '../durable/scoped-transaction.js';
import {
  ExperienceQueryCursorCodec,
  ExperienceQueryCursorCodecError,
  type ExperienceQueryCursorExpectedBinding,
} from './experience-query-cursor-codec.js';

const ApiPrincipalSchema = z.strictObject({
  userId: UuidSchema,
  sessionId: UuidSchema,
  householdId: UuidSchema,
  role: z.enum(['owner', 'member']),
  emailVerified: z.literal(true),
  spaceAccessGrantId: UuidSchema,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema,
});

const TodayReadInputSchema = z.strictObject({
  date: z.iso.date(),
  principal: ApiPrincipalSchema,
  requestId: UuidSchema,
});

const ActivityReadInputSchema = z.strictObject({
  cursor: OpaqueReferenceSchema.optional(),
  limit: z.number().int().min(1).max(50),
  principal: ApiPrincipalSchema,
  requestId: UuidSchema,
});

const EntityPageInputSchema = ActivityReadInputSchema;

const FinanceSnapshotPrincipalSchema = ApiPrincipalSchema.extend({
  privateSpaceId: UuidSchema,
});
const FinanceSnapshotReadInputSchema = z.strictObject({
  principal: FinanceSnapshotPrincipalSchema,
  requestId: UuidSchema,
});

const ScheduleReadInputSchema = z
  .strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
    cursor: OpaqueReferenceSchema.optional(),
    limit: z.number().int().min(1).max(50),
    principal: ApiPrincipalSchema,
    requestId: UuidSchema,
  })
  .refine(
    ({ from, to }) => {
      const range =
        Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`);
      return range >= 0 && range <= 31 * 86_400_000;
    },
    { path: ['to'], message: 'Schedule range must be at most 31 days' },
  );

const SettingsReadInputSchema = z.strictObject({
  principal: ApiPrincipalSchema,
  requestId: UuidSchema,
});

const PreferencesUpdateInputSchema = z.strictObject({
  expectedVersion: z.number().int().safe().positive(),
  preferences: z.strictObject({
    inApp: z.boolean(),
    push: z.boolean(),
    email: z.boolean(),
    spokenReplies: z.boolean(),
  }),
  idempotencyKey: IdempotencyKeySchema,
  principal: ApiPrincipalSchema,
  requestId: UuidSchema,
});

const DateTimeValueSchema = z
  .union([z.date(), IsoDateTimeSchema])
  .transform((value) =>
    value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
  );

const ReminderRowSchema = z.strictObject({
  reminder_id: OpaqueReferenceSchema,
  title: z.string().trim().min(1).max(200),
  sensitivity: z.enum(['standard', 'sensitive']),
  due_at: DateTimeValueSchema,
  state: z.enum(['scheduled', 'delivered', 'cancelled']),
});

const NotificationRowSchema = z.strictObject({
  notification_id: UuidSchema,
  title: z.string().trim().min(1).max(200),
  sensitivity: z.enum(['standard', 'sensitive']),
  created_at: DateTimeValueSchema,
});

const ActivityRowSchema = z.strictObject({
  id: OpaqueReferenceSchema,
  category: z.enum(['audit', 'calendar', 'notification', 'sync']),
  title: z.string().trim().min(1).max(200),
  kind: IdentifierSchema.nullable(),
  status: IdentifierSchema.nullable(),
  occurred_at: DateTimeValueSchema,
});

const CalendarStateRowSchema = z.strictObject({
  state: z.enum(['ready', 'syncing', 'retry-pending', 'disconnected']),
  last_synced_at: DateTimeValueSchema.nullable(),
});

const HouseholdRowSchema = z.strictObject({
  household_name: z.string().trim().min(1).max(200),
  role: z.enum(['owner', 'member']),
});

const PrivateSpaceRowSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
});

const CanonicalSchedulerPayloadSchema = z
  .strictObject({
    id: OpaqueReferenceSchema,
    title: z.string().trim().min(1).max(500),
    notes: z.string().trim().max(10_000).nullable(),
    location: z.string().trim().max(1_000).nullable(),
    startsAt: IsoDateTimeSchema,
    endsAt: IsoDateTimeSchema,
    recurrence: z.string().trim().min(1).max(2_000).nullable(),
    attendees: z.array(OpaqueReferenceSchema).max(512),
    completion: z.enum(['open', 'completed', 'skipped']),
  })
  .refine(({ startsAt, endsAt }) => Date.parse(endsAt) > Date.parse(startsAt), {
    path: ['endsAt'],
    message: 'Canonical schedule end must follow its start',
  });

const FinanceAdjustmentSchema = z.strictObject({
  operationId: UuidSchema,
  amountCadMinor: z
    .number()
    .int()
    .safe()
    .refine((value) => value !== 0),
  reason: z.string().trim().min(3).max(1_000),
});
const FinanceReversalSchema = z.strictObject({
  operationId: UuidSchema,
  reason: z.string().trim().min(3).max(1_000),
});
const CanonicalFinanceTransactionSchema = z.strictObject({
  recordType: z.literal('transaction'),
  description: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(80),
  postedOn: z.iso.date(),
  source: z.string().trim().min(1).max(80),
  id: OpaqueReferenceSchema,
  currency: z.literal('CAD'),
  originalAmountCadMinor: z.number().int().safe(),
  effectiveAmountCadMinor: z.number().int().safe(),
  amountConflict: z.boolean(),
  adjustments: z.array(FinanceAdjustmentSchema).max(10_000),
  reversal: FinanceReversalSchema.nullable(),
  appliedOperationIds: z.array(UuidSchema).max(10_001),
});
const CanonicalFinanceBudgetSchema = z.strictObject({
  id: OpaqueReferenceSchema,
  currency: z.literal('CAD'),
  allocationsCadMinor: z
    .record(IdentifierSchema, z.number().int().safe().nonnegative())
    .refine(
      (value) =>
        Object.keys(value).length <=
        FINANCE_EXPERIENCE_LIMITS.maximumMonthlyBudgetAllocations,
    ),
});

const FinanceCurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/u);

const ShoppingOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    operationId: UuidSchema,
    kind: z.literal('delta'),
    quantityMinorUnits: z
      .number()
      .int()
      .safe()
      .refine((value) => value !== 0),
  }),
  z.strictObject({ operationId: UuidSchema, kind: z.literal('tombstone') }),
]);
const CanonicalShoppingPayloadSchema = z.strictObject({
  itemId: OpaqueReferenceSchema,
  name: z.string().trim().min(1).max(120).optional(),
  unit: z.string().trim().min(1).max(40).optional(),
  retailer: z.string().trim().min(1).max(120).optional(),
  quantityMinorUnits: z.number().int().safe().nonnegative(),
  tombstoned: z.literal(false),
  baseQuantityMinorUnits: z.number().int().safe().nonnegative(),
  baseTombstoned: z.boolean(),
  quantityConflict: z.boolean(),
  appliedOperationIds: z.array(UuidSchema).max(100_000),
  appliedOperations: z.array(ShoppingOperationSchema).max(100_000),
});

const EntityRowSchema = z.strictObject({
  entity_id: OpaqueReferenceSchema,
  payload: z.unknown(),
  updated_at: DateTimeValueSchema,
});
const FinanceEntityRowSchema = EntityRowSchema.extend({
  entity_type: z.enum(['finance.transaction', 'finance.budget']),
});

const FinanceSnapshotEntityRowSchema = z.strictObject({
  entity_id: OpaqueReferenceSchema,
  payload: z.unknown(),
  revision: z.coerce.number().int().safe().nonnegative(),
});
const FinanceSnapshotRowSchema = z.strictObject({
  transactions: z.array(FinanceSnapshotEntityRowSchema).max(100_001),
  budgets: z.array(FinanceSnapshotEntityRowSchema).max(1_001),
  categories: z.array(FinanceSnapshotEntityRowSchema).max(1_001),
});

const CountRowSchema = z.strictObject({
  budget_count: z.coerce.number().int().safe().nonnegative(),
  transaction_count: z.coerce.number().int().safe().nonnegative(),
});
const ShoppingCountRowSchema = z.strictObject({
  item_count: z.coerce.number().int().safe().nonnegative(),
  retailer_count: z.coerce.number().int().safe().nonnegative(),
});

const PreferencesFunctionRowSchema = z.strictObject({ result: z.unknown() });

const ReadinessRowSchema = z.strictObject({ ready: z.literal(true) });

export interface ExperienceApiPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly householdId: string;
  readonly role: 'owner' | 'member';
  readonly emailVerified: true;
  readonly spaceAccessGrantId: string;
  readonly collectionAuthorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
}

export interface PostgresExperienceReadGateways {
  readonly todayRead: {
    read(input: {
      readonly date: string;
      readonly principal: ExperienceApiPrincipal;
      readonly requestId: string;
    }): Promise<TodayView>;
  };
  readonly activityRead: {
    list(input: {
      readonly cursor?: string;
      readonly limit: number;
      readonly principal: ExperienceApiPrincipal;
      readonly requestId: string;
    }): Promise<ActivityPage>;
  };
  readonly scheduleRead: {
    list(input: {
      readonly from: string;
      readonly to: string;
      readonly cursor?: string;
      readonly limit: number;
      readonly principal: ExperienceApiPrincipal;
      readonly requestId: string;
    }): Promise<SchedulePage>;
  };
  readonly settingsRead: {
    read(input: {
      readonly principal: ExperienceApiPrincipal;
      readonly requestId: string;
    }): Promise<SettingsView>;
  };
  readonly financeRead: {
    list(input: {
      readonly cursor?: string;
      readonly limit: number;
      readonly principal: ExperienceApiPrincipal;
      readonly requestId: string;
    }): Promise<FinancePage>;
    readSnapshot(input: {
      readonly principal: ExperienceApiPrincipal & {
        readonly privateSpaceId?: string;
      };
      readonly requestId: string;
    }): Promise<FinanceExperienceSnapshot>;
  };
  readonly shoppingRead: {
    list(input: {
      readonly cursor?: string;
      readonly limit: number;
      readonly principal: ExperienceApiPrincipal;
      readonly requestId: string;
    }): Promise<ShoppingPage>;
  };
  readonly notificationPreferences: {
    get(input: {
      readonly principal: ExperienceApiPrincipal;
      readonly requestId: string;
    }): Promise<NotificationPreferencesView>;
    update(input: {
      readonly expectedVersion: number;
      readonly preferences: NotificationPreferencesUpdateRequest['preferences'];
      readonly idempotencyKey: string;
      readonly principal: ExperienceApiPrincipal;
      readonly requestId: string;
    }): Promise<NotificationPreferencesView>;
  };
}

const invalidInput = (message: string): never => {
  throw new DurableRepositoryError('invalid-input', message);
};

const invalidResult = (message: string): never => {
  throw new DurableRepositoryError('invalid-result', message);
};

const databaseErrorMessage = (error: unknown): string | undefined => {
  if (error === null || typeof error !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      typeof descriptor.value !== 'string'
    ) {
      return undefined;
    }
    return descriptor.value.toLowerCase();
  } catch {
    return undefined;
  }
};

const runExperienceDatabaseOperation = async <Result>(
  operation: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DurableRepositoryError) throw error;
    const message = databaseErrorMessage(error);
    if (message === 'emdo:authorization-revoked') {
      throw new DurableRepositoryError(
        'authorization-revoked',
        'Experience authority is no longer active',
      );
    }
    if (
      message === 'emdo:version-conflict' ||
      message === 'emdo:idempotency-conflict'
    ) {
      throw new DurableRepositoryError(
        'conflict',
        'Notification preferences conflicted with durable state',
      );
    }
    throw error;
  }
};

const parseInput = <Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  message: string,
): z.output<Schema> => {
  const parsed = schema.safeParse(input);
  return parsed.success ? parsed.data : invalidInput(message);
};

const parseRows = <Schema extends z.ZodType>(
  schema: Schema,
  rows: readonly Record<string, unknown>[],
  message: string,
): readonly z.output<Schema>[] => {
  const parsed = z.array(schema).safeParse(rows);
  return parsed.success ? parsed.data : invalidResult(message);
};

const durablePrincipalFor = (input: {
  readonly principal: ExperienceApiPrincipal;
  readonly requestId: string;
}) =>
  parseDurablePrincipal({
    userId: input.principal.userId,
    sessionId: input.principal.sessionId,
    requestId: input.requestId,
    householdId: input.principal.householdId,
  });

const withHouseholdScope = <Result>(
  pool: DatabasePool,
  input: {
    readonly principal: ExperienceApiPrincipal;
    readonly requestId: string;
  },
  work: (client: DatabaseClient) => Promise<Result>,
) =>
  withDurableTransaction(
    pool,
    durablePrincipalFor(input),
    { householdId: input.principal.householdId },
    work,
  );

const withPrivateFinanceScope = <Result>(
  pool: DatabasePool,
  input: z.output<typeof FinanceSnapshotReadInputSchema>,
  work: (client: DatabaseClient) => Promise<Result>,
) =>
  withDurableTransaction(
    pool,
    durablePrincipalFor(input),
    {
      householdId: input.principal.householdId,
      spaceId: input.principal.privateSpaceId,
    },
    work,
  );

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const asRecordObject = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const modernFinanceSnapshotRecord = (input: {
  readonly row: z.output<typeof FinanceSnapshotEntityRowSchema>;
  readonly expectedType: 'transaction' | 'budget' | 'category';
  readonly principal: z.output<typeof FinanceSnapshotPrincipalSchema>;
}): FinanceRecord => {
  const raw = asRecordObject(input.row.payload);
  const payload =
    input.expectedType === 'transaction' &&
    raw !== undefined &&
    !Object.hasOwn(raw, 'revision')
      ? { ...raw, revision: input.row.revision }
      : input.row.payload;
  const validated = validateFinanceRecord(payload);
  if (
    validated.status !== 'accepted' ||
    validated.record.recordType !== input.expectedType ||
    validated.record.id !== input.row.entity_id ||
    validated.record.spaceId !== input.principal.privateSpaceId ||
    validated.record.ownerUserId !== input.principal.userId
  ) {
    return invalidResult(
      'Database returned malformed owner-scoped Finance data',
    );
  }
  return validated.record;
};

const financeSnapshotCurrency = (
  value: Readonly<Record<string, unknown>> | undefined,
): string => {
  const parsed = FinanceCurrencyCodeSchema.safeParse(value?.currency);
  return parsed.success
    ? parsed.data
    : invalidResult('Database returned Finance data with malformed currency');
};

const financeSnapshotItemId = (input: {
  readonly budgetId: string;
  readonly categoryId: string;
}): string => {
  const id = `${input.budgetId}:${input.categoryId}`;
  return id.length <= 512
    ? id
    : invalidResult('Finance budget allocation identifier is too long');
};

const safeSnapshotTotal = (value: bigint): number => {
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    return invalidResult(
      'Finance snapshot total is outside safe integer range',
    );
  }
  return Number(value);
};

const verifyExperienceCursor = (
  codec: ExperienceQueryCursorCodec,
  cursor: string | undefined,
  expected: ExperienceQueryCursorExpectedBinding,
  message: string,
) => {
  if (cursor === undefined) return undefined;
  try {
    return codec.verify(cursor, expected).position;
  } catch (error) {
    if (error instanceof ExperienceQueryCursorCodecError) {
      return invalidInput(message);
    }
    throw error;
  }
};

const cursorPrincipalBinding = (principal: ExperienceApiPrincipal) => ({
  userId: principal.userId,
  sessionId: principal.sessionId,
  householdId: principal.householdId,
  collectionAuthorizationScopeFingerprint:
    principal.collectionAuthorizationScopeFingerprint,
});

const scheduleProjection = (entityId: string, payload: unknown) => {
  const parsed = CanonicalSchedulerPayloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.id !== entityId) {
    return invalidResult('Database returned a malformed scheduler entity');
  }
  return {
    id: parsed.data.id,
    title: parsed.data.title,
    startsAt: parsed.data.startsAt,
    endsAt: parsed.data.endsAt,
    completion:
      parsed.data.completion === 'open'
        ? ('pending' as const)
        : parsed.data.completion === 'completed'
          ? ('completed' as const)
          : ('cancelled' as const),
  };
};

const queryScheduleEntities = async (
  client: DatabaseClient,
  input: {
    readonly householdId: string;
    readonly from: string;
    readonly to: string;
    readonly cursor?: Readonly<{ readonly at: string; readonly id: string }>;
    readonly limit: number;
    readonly marker:
      'experience_schedule_entities' | 'experience_today_schedule';
    readonly issueCursor?: (position: {
      readonly at: string;
      readonly id: string;
    }) => string;
  },
) => {
  const result = await client.query(
    `/* ${input.marker} */
     select entity_id, payload, updated_at
       from emdo.sync_entities
      where household_id = $1
        and entity_type = 'scheduler.item'
        and tombstoned_at is null
        and pg_catalog.jsonb_typeof(payload -> 'startsAt') = 'string'
        and (payload ->> 'startsAt')::timestamptz >=
            ($2::date::timestamp at time zone 'America/Toronto')
        and (payload ->> 'startsAt')::timestamptz <
            (($3::date + 1)::timestamp at time zone 'America/Toronto')
        and (
          $4::timestamptz is null
          or ((payload ->> 'startsAt')::timestamptz, entity_id) > ($4, $5)
        )
      order by (payload ->> 'startsAt')::timestamptz, entity_id
      limit $6`,
    [
      input.householdId,
      input.from,
      input.to,
      input.cursor?.at ?? null,
      input.cursor?.id ?? null,
      input.limit + 1,
    ],
  );
  const rows = parseRows(
    EntityRowSchema,
    result.rows,
    'Database returned malformed scheduler rows',
  );
  const page = rows.slice(0, input.limit).map((row) => ({
    item: scheduleProjection(row.entity_id, row.payload),
    row,
  }));
  const last = page.at(-1);
  return {
    items: page.map(({ item }) => item),
    ...(rows.length > input.limit &&
    last !== undefined &&
    input.issueCursor !== undefined
      ? {
          nextCursor: input.issueCursor({
            at: last.item.startsAt,
            id: last.row.entity_id,
          }),
        }
      : {}),
  };
};

const readCalendarState = async (
  client: DatabaseClient,
  householdId: string,
  userId: string,
) => {
  const result = await client.query(
    `/* experience_calendar_state */
     select state, last_synced_at
       from emdo.calendar_sync_states
      where household_id = $1
        and original_owner_user_id = $2
      order by updated_at desc, connection_id
      limit 1`,
    [householdId, userId],
  );
  const rows = parseRows(
    CalendarStateRowSchema,
    result.rows,
    'Database returned a malformed Calendar state',
  );
  const row = rows[0];
  if (row === undefined) return { status: 'unavailable' as const };
  if (row.state === 'disconnected') return { status: 'disconnected' as const };
  return {
    status: row.state === 'ready' ? ('connected' as const) : row.state,
    ...(row.last_synced_at === null
      ? {}
      : { lastSyncedAt: row.last_synced_at }),
  };
};

const createTodayRead = (pool: DatabasePool) => ({
  async read(input: {
    readonly date: string;
    readonly principal: ExperienceApiPrincipal;
    readonly requestId: string;
  }): Promise<TodayView> {
    const parsed = parseInput(
      TodayReadInputSchema,
      input,
      'Today read input is malformed',
    );
    return withHouseholdScope(pool, parsed, async (client) => {
      const remindersResult = await client.query(
        `/* experience_today_reminders */
         select reminder_id, title, sensitivity, due_at, state
           from emdo.scheduler_reminders
          where household_id = $1
            and original_owner_user_id = $2
            and tombstoned_at is null
            and due_at >= ($3::date::timestamp at time zone 'America/Toronto')
            and due_at < (($3::date + 1)::timestamp at time zone 'America/Toronto')
          order by due_at, reminder_id
          limit 24`,
        [parsed.principal.householdId, parsed.principal.userId, parsed.date],
      );
      const notificationsResult = await client.query(
        `/* experience_today_notifications */
         select notification_id, title, sensitivity, created_at
           from emdo.notifications
          where household_id = $1
            and original_owner_user_id = $2
            and tombstoned_at is null
            and in_app = true
            and created_at >= ($3::date::timestamp at time zone 'America/Toronto')
            and created_at < (($3::date + 1)::timestamp at time zone 'America/Toronto')
          order by created_at, notification_id
          limit 24`,
        [parsed.principal.householdId, parsed.principal.userId, parsed.date],
      );
      const schedule = await queryScheduleEntities(client, {
        householdId: parsed.principal.householdId,
        from: parsed.date,
        to: parsed.date,
        limit: 24,
        marker: 'experience_today_schedule',
      });
      const financeCountResult = await client.query(
        `/* experience_today_finance_count */
         select count(*) filter (
                  where entity_type = 'finance.budget'
                )::integer as budget_count,
                count(*) filter (
                  where entity_type = 'finance.transaction'
                )::integer as transaction_count
           from emdo.sync_entities
          where household_id = $1
            and entity_type in ('finance.budget', 'finance.transaction')
            and tombstoned_at is null`,
        [parsed.principal.householdId],
      );
      const shoppingCountResult = await client.query(
        `/* experience_today_shopping_count */
         select count(*)::integer as item_count,
                count(distinct payload ->> 'retailer') filter (
                  where pg_catalog.jsonb_typeof(payload -> 'retailer') = 'string'
                )::integer as retailer_count
           from emdo.sync_entities
          where household_id = $1
            and entity_type = 'shopping.item'
            and tombstoned_at is null`,
        [parsed.principal.householdId],
      );
      const reminders = parseRows(
        ReminderRowSchema,
        remindersResult.rows,
        'Database returned malformed Today reminders',
      );
      const notifications = parseRows(
        NotificationRowSchema,
        notificationsResult.rows,
        'Database returned malformed Today notifications',
      );
      const financeCount = parseRows(
        CountRowSchema,
        financeCountResult.rows,
        'Database returned malformed Today finance counts',
      )[0];
      const shoppingCount = parseRows(
        ShoppingCountRowSchema,
        shoppingCountResult.rows,
        'Database returned malformed Today shopping counts',
      )[0];
      if (financeCount === undefined || shoppingCount === undefined) {
        return invalidResult('Database returned no Today aggregate counts');
      }
      return TodayViewSchema.parse({
        schemaVersion: 1,
        date: parsed.date,
        timezone: 'America/Toronto',
        schedule: { status: 'available', items: schedule.items },
        reminders: {
          status: 'available',
          items: reminders.map((row) => ({
            id: row.reminder_id,
            title:
              row.sensitivity === 'sensitive' ? 'Private reminder' : row.title,
            sensitivity: row.sensitivity,
            dueAt: row.due_at,
            state: row.state,
          })),
        },
        notifications: {
          status: 'available',
          items: notifications.map((row) => ({
            id: row.notification_id,
            title:
              row.sensitivity === 'sensitive'
                ? 'Private notification'
                : row.title,
            sensitivity: row.sensitivity,
            createdAt: row.created_at,
          })),
        },
        finance: {
          status: 'available',
          budgetCount: financeCount.budget_count,
          transactionCount: financeCount.transaction_count,
        },
        shopping: {
          status: 'available',
          itemCount: shoppingCount.item_count,
          retailerCount: shoppingCount.retailer_count,
        },
      });
    });
  },
});

const createActivityRead = (
  pool: DatabasePool,
  cursorCodec: ExperienceQueryCursorCodec,
) => ({
  async list(input: {
    readonly cursor?: string;
    readonly limit: number;
    readonly principal: ExperienceApiPrincipal;
    readonly requestId: string;
  }): Promise<ActivityPage> {
    const parsed = parseInput(
      ActivityReadInputSchema,
      input,
      'Activity read input is malformed',
    );
    const binding = {
      ...cursorPrincipalBinding(parsed.principal),
      kind: 'activity' as const,
    };
    const cursor = verifyExperienceCursor(
      cursorCodec,
      parsed.cursor,
      binding,
      'Activity cursor is malformed',
    );
    return withHouseholdScope(pool, parsed, async (client) => {
      const result = await client.query(
        `/* experience_activity */
         select id, category, title, kind, status, occurred_at
           from (
             select event.id::text as id,
                    'audit'::text as category,
                    'Activity recorded'::text as title,
                    event.event_type as kind,
                    null::text as status,
                    event.occurred_at
               from emdo.audit_events event
              where event.household_id = $1
             union all
             select receipt.receipt_id::text as id,
                    'calendar'::text as category,
                    'Calendar maintenance recorded'::text as title,
                    ('calendar.' || receipt.kind)::text as kind,
                    receipt.status,
                    receipt.recorded_at as occurred_at
               from emdo.calendar_maintenance_receipts receipt
              where receipt.household_id = $1
             union all
             select delivery.delivery_id::text as id,
                    'notification'::text as category,
                    'Notification delivery recorded'::text as title,
                    'notification.delivery'::text as kind,
                    delivery.status,
                    delivery.attempted_at as occurred_at
               from emdo.notification_deliveries delivery
              where delivery.household_id = $1
           ) activity
          where ($2::timestamptz is null or (occurred_at, id) < ($2, $3))
          order by occurred_at desc, id desc
          limit $4`,
        [
          parsed.principal.householdId,
          cursor !== undefined && 'occurredAt' in cursor
            ? cursor.occurredAt
            : null,
          cursor?.id ?? null,
          parsed.limit + 1,
        ],
      );
      const rows = parseRows(
        ActivityRowSchema,
        result.rows,
        'Database returned malformed activity records',
      );
      const page = rows.slice(0, parsed.limit).map((row) => ({
        id: row.id,
        category: row.category,
        title: row.title,
        ...(row.kind === null ? {} : { kind: row.kind }),
        ...(row.status === null ? {} : { status: row.status }),
        occurredAt: row.occurred_at,
      }));
      const last = page.at(-1);
      return ActivityPageSchema.parse({
        schemaVersion: 1,
        items: page,
        ...(rows.length > parsed.limit && last !== undefined
          ? {
              nextCursor: cursorCodec.issue({
                ...binding,
                position: { occurredAt: last.occurredAt, id: last.id },
              }),
            }
          : {}),
      });
    });
  },
});

const createScheduleRead = (
  pool: DatabasePool,
  cursorCodec: ExperienceQueryCursorCodec,
) => ({
  async list(input: {
    readonly from: string;
    readonly to: string;
    readonly cursor?: string;
    readonly limit: number;
    readonly principal: ExperienceApiPrincipal;
    readonly requestId: string;
  }): Promise<SchedulePage> {
    const parsed = parseInput(
      ScheduleReadInputSchema,
      input,
      'Schedule read input is malformed',
    );
    const binding = {
      ...cursorPrincipalBinding(parsed.principal),
      kind: 'schedule' as const,
      from: parsed.from,
      to: parsed.to,
    };
    const verifiedCursor = verifyExperienceCursor(
      cursorCodec,
      parsed.cursor,
      binding,
      'schedule cursor is malformed',
    );
    const cursor =
      verifiedCursor !== undefined && 'at' in verifiedCursor
        ? verifiedCursor
        : undefined;
    return withHouseholdScope(pool, parsed, async (client) => {
      const schedule = await queryScheduleEntities(client, {
        householdId: parsed.principal.householdId,
        from: parsed.from,
        to: parsed.to,
        cursor,
        limit: parsed.limit,
        marker: 'experience_schedule_entities',
        issueCursor: (position) => cursorCodec.issue({ ...binding, position }),
      });
      return SchedulePageSchema.parse({
        schemaVersion: 1,
        timezone: 'America/Toronto',
        from: parsed.from,
        to: parsed.to,
        items: { status: 'available', items: schedule.items },
        ...(schedule.nextCursor === undefined
          ? {}
          : { nextCursor: schedule.nextCursor }),
        calendar: await readCalendarState(
          client,
          parsed.principal.householdId,
          parsed.principal.userId,
        ),
      });
    });
  },
});

const createFinanceRead = (
  pool: DatabasePool,
  cursorCodec: ExperienceQueryCursorCodec,
) => ({
  async readSnapshot(input: {
    readonly principal: ExperienceApiPrincipal & {
      readonly privateSpaceId?: string;
    };
    readonly requestId: string;
  }): Promise<FinanceExperienceSnapshot> {
    const parsed = parseInput(
      FinanceSnapshotReadInputSchema,
      input,
      'Finance snapshot input is malformed',
    );
    return withPrivateFinanceScope(pool, parsed, async (client) => {
      const result = await client.query(
        `/* experience_finance_snapshot */
         with transaction_rows as materialized (
           select entity.entity_id, entity.payload, entity.revision
             from emdo.sync_entities as entity
            where entity.household_id = $1::uuid
              and entity.space_id = $2::uuid
              and entity.original_owner_user_id = $3::uuid
              and entity.entity_type = 'finance.transaction'
              and entity.tombstoned_at is null
            order by entity.id asc
            limit 100001
         ),
         budget_rows as materialized (
           select entity.entity_id, entity.payload, entity.revision
             from emdo.sync_entities as entity
            where entity.household_id = $1::uuid
              and entity.space_id = $2::uuid
              and entity.original_owner_user_id = $3::uuid
              and entity.entity_type = 'finance.budget'
              and entity.tombstoned_at is null
            order by entity.id asc
            limit 1001
         ),
         category_rows as materialized (
           select entity.entity_id, entity.payload, entity.revision
             from emdo.sync_entities as entity
            where entity.household_id = $1::uuid
              and entity.space_id = $2::uuid
              and entity.original_owner_user_id = $3::uuid
              and entity.entity_type = 'finance.category'
              and entity.tombstoned_at is null
            order by entity.id asc
            limit 1001
         )
         select coalesce(
                  (
                    select jsonb_agg(
                      jsonb_build_object(
                        'entity_id', row.entity_id,
                        'payload', row.payload,
                        'revision', row.revision
                      ) order by row.entity_id
                    )
                      from transaction_rows as row
                  ),
                  '[]'::jsonb
                ) as transactions,
                coalesce(
                  (
                    select jsonb_agg(
                      jsonb_build_object(
                        'entity_id', row.entity_id,
                        'payload', row.payload,
                        'revision', row.revision
                      ) order by row.entity_id
                    )
                      from budget_rows as row
                  ),
                  '[]'::jsonb
                ) as budgets,
                coalesce(
                  (
                    select jsonb_agg(
                      jsonb_build_object(
                        'entity_id', row.entity_id,
                        'payload', row.payload,
                        'revision', row.revision
                      ) order by row.entity_id
                    )
                      from category_rows as row
                  ),
                  '[]'::jsonb
                ) as categories`,
        [
          parsed.principal.householdId,
          parsed.principal.privateSpaceId,
          parsed.principal.userId,
        ],
      );
      const rows = parseRows(
        FinanceSnapshotRowSchema,
        result.rows,
        'Database returned a malformed Finance snapshot',
      );
      const snapshot = rows[0];
      if (snapshot === undefined || rows.length !== 1) {
        return invalidResult('Database returned no unique Finance snapshot');
      }
      if (snapshot.transactions.length > 100_000) {
        return invalidResult(
          'Finance transaction scope exceeded its bounded snapshot limit',
        );
      }
      if (
        snapshot.budgets.length >
        FINANCE_EXPERIENCE_LIMITS.maximumMonthlyBudgetAllocations
      ) {
        return invalidResult(
          'Finance budget scope exceeded its bounded snapshot limit',
        );
      }
      if (
        snapshot.categories.length >
        FINANCE_EXPERIENCE_LIMITS.maximumCategoryTotals
      ) {
        return invalidResult(
          'Finance category scope exceeded its bounded snapshot limit',
        );
      }

      const categoryNames = new Map<string, string>();
      for (const row of snapshot.categories) {
        const record = modernFinanceSnapshotRecord({
          row,
          expectedType: 'category',
          principal: parsed.principal,
        });
        if (record.recordType !== 'category' || categoryNames.has(record.id)) {
          return invalidResult(
            'Database returned malformed owner-scoped Finance categories',
          );
        }
        categoryNames.set(record.id, record.name);
      }
      const categoryFor = (
        categoryId: string | null,
      ): Readonly<{ key: string; label: string }> => {
        if (categoryId === null)
          return { key: 'modern:uncategorized', label: 'uncategorized' };
        const name = categoryNames.get(categoryId);
        return name === undefined
          ? invalidResult(
              'Database returned a Finance record with a missing category reference',
            )
          : { key: `modern:${categoryId}`, label: name };
      };

      const totals = new Map<
        string,
        Readonly<{ label: string; amountCadMinor: bigint }>
      >();
      const recentActivity: Array<{
        id: string;
        label: string;
        occurredAt: string;
      }> = [];
      const appendRecentActivity = (input: {
        readonly id: string;
        readonly category: string;
        readonly description: string;
        readonly postedOn: string;
      }) => {
        recentActivity.push({
          id: input.id,
          label: `${input.category}: ${input.description}`.slice(0, 500),
          occurredAt: `${input.postedOn}T12:00:00.000Z`,
        });
      };
      for (const row of snapshot.transactions) {
        const raw = asRecordObject(row.payload);
        if (financeSnapshotCurrency(raw) !== 'CAD') continue;
        const legacy = CanonicalFinanceTransactionSchema.safeParse(row.payload);
        if (legacy.success) {
          if (legacy.data.id !== row.entity_id) {
            return invalidResult(
              'Database returned a malformed Finance transaction',
            );
          }
          appendRecentActivity({
            id: legacy.data.id,
            category: legacy.data.category,
            description: legacy.data.description,
            postedOn: legacy.data.postedOn,
          });
          if (legacy.data.amountConflict || legacy.data.reversal !== null) {
            continue;
          }
          const key = `legacy:${legacy.data.category}`;
          const current = totals.get(key);
          totals.set(key, {
            label: legacy.data.category,
            amountCadMinor:
              (current?.amountCadMinor ?? 0n) +
              BigInt(legacy.data.effectiveAmountCadMinor),
          });
          continue;
        }
        const record = modernFinanceSnapshotRecord({
          row,
          expectedType: 'transaction',
          principal: parsed.principal,
        });
        if (record.recordType !== 'transaction') {
          return invalidResult(
            'Database returned a malformed Finance transaction',
          );
        }
        appendRecentActivity({
          id: record.id,
          category:
            record.categoryId === null
              ? 'uncategorized'
              : (categoryNames.get(record.categoryId) ?? 'uncategorized'),
          description: record.description,
          postedOn: record.postedOn,
        });
        if (record.reversal !== null) continue;
        const category = categoryFor(record.categoryId);
        const current = totals.get(category.key);
        totals.set(category.key, {
          label: category.label,
          amountCadMinor:
            (current?.amountCadMinor ?? 0n) +
            BigInt(record.effectiveAmountCadMinor),
        });
      }
      if (totals.size > FINANCE_EXPERIENCE_LIMITS.maximumCategoryTotals) {
        return invalidResult(
          'Finance category totals exceeded the non-paginated snapshot limit',
        );
      }

      const reviewedCadTotals = [...totals.entries()]
        .sort(([leftKey, left], [rightKey, right]) => {
          const byLabel = compareText(left.label, right.label);
          return byLabel === 0 ? compareText(leftKey, rightKey) : byLabel;
        })
        .map(([, value]) => ({
          label: value.label,
          amountCadMinor: safeSnapshotTotal(value.amountCadMinor),
        }));
      recentActivity.sort((left, right) => {
        const byOccurrence = compareText(right.occurredAt, left.occurredAt);
        return byOccurrence === 0
          ? compareText(right.id, left.id)
          : byOccurrence;
      });
      const budgets: Array<{
        id: string;
        label: string;
        allocatedCadMinor: number;
      }> = [];
      const appendBudgetAllocation = (input: {
        readonly budgetId: string;
        readonly categoryId: string;
        readonly label: string;
        readonly allocatedCadMinor: number;
      }) => {
        if (
          budgets.length >=
          FINANCE_EXPERIENCE_LIMITS.maximumMonthlyBudgetAllocations
        ) {
          return invalidResult(
            'Finance budget allocations exceeded the non-paginated snapshot limit',
          );
        }
        budgets.push({
          id: financeSnapshotItemId(input),
          label: input.label,
          allocatedCadMinor: input.allocatedCadMinor,
        });
      };
      for (const row of snapshot.budgets) {
        const raw = asRecordObject(row.payload);
        if (financeSnapshotCurrency(raw) !== 'CAD') continue;
        const legacy = CanonicalFinanceBudgetSchema.safeParse(row.payload);
        if (legacy.success) {
          if (legacy.data.id !== row.entity_id) {
            return invalidResult(
              'Database returned a malformed Finance budget',
            );
          }
          for (const [category, allocatedCadMinor] of Object.entries(
            legacy.data.allocationsCadMinor,
          )) {
            appendBudgetAllocation({
              budgetId: legacy.data.id,
              categoryId: category,
              label: category,
              allocatedCadMinor,
            });
          }
          continue;
        }
        const record = modernFinanceSnapshotRecord({
          row,
          expectedType: 'budget',
          principal: parsed.principal,
        });
        if (record.recordType !== 'budget') {
          return invalidResult('Database returned a malformed Finance budget');
        }
        for (const allocation of record.allocations) {
          const category = categoryFor(allocation.categoryId);
          appendBudgetAllocation({
            budgetId: record.id,
            categoryId: allocation.categoryId,
            label: category.label,
            allocatedCadMinor: allocation.amountCadMinor,
          });
        }
      }
      budgets.sort((left, right) => compareText(left.id, right.id));
      return FinanceExperienceSnapshotSchema.parse({
        reviewedCadTotals,
        recentActivity: recentActivity.slice(0, 50),
        budgets,
      });
    });
  },

  async list(input: {
    readonly cursor?: string;
    readonly limit: number;
    readonly principal: ExperienceApiPrincipal;
    readonly requestId: string;
  }): Promise<FinancePage> {
    const parsed = parseInput(
      EntityPageInputSchema,
      input,
      'Finance read input is malformed',
    );
    const binding = {
      ...cursorPrincipalBinding(parsed.principal),
      kind: 'finance' as const,
    };
    const verifiedCursor = verifyExperienceCursor(
      cursorCodec,
      parsed.cursor,
      binding,
      'finance cursor is malformed',
    );
    const cursor =
      verifiedCursor !== undefined &&
      'at' in verifiedCursor &&
      verifiedCursor.entityType !== undefined
        ? verifiedCursor
        : undefined;
    if (parsed.cursor !== undefined && cursor === undefined) {
      return invalidInput('finance cursor is malformed');
    }
    return withHouseholdScope(pool, parsed, async (client) => {
      const result = await client.query(
        `/* experience_finance_entities */
         select entity_type, entity_id, payload, updated_at
           from emdo.sync_entities
          where household_id = $1
            and entity_type in ('finance.transaction', 'finance.budget')
            and tombstoned_at is null
            and (
              $2::timestamptz is null
              or (updated_at, entity_type, entity_id) < ($2, $3, $4)
            )
          order by updated_at desc, entity_type desc, entity_id desc
          limit $5`,
        [
          parsed.principal.householdId,
          cursor?.at ?? null,
          cursor?.entityType ?? null,
          cursor?.id ?? null,
          parsed.limit + 1,
        ],
      );
      const rows = parseRows(
        FinanceEntityRowSchema,
        result.rows,
        'Database returned malformed finance rows',
      );
      const page = rows.slice(0, parsed.limit).map((row) => {
        if (row.entity_type === 'finance.transaction') {
          const transaction = CanonicalFinanceTransactionSchema.safeParse(
            row.payload,
          );
          if (!transaction.success || transaction.data.id !== row.entity_id) {
            return invalidResult(
              'Database returned a malformed finance transaction',
            );
          }
          return {
            row,
            item: {
              recordType: 'transaction' as const,
              id: transaction.data.id,
              description: transaction.data.description,
              category: transaction.data.category,
              postedOn: transaction.data.postedOn,
              currency: transaction.data.currency,
              amountCadMinor: transaction.data.effectiveAmountCadMinor,
              state: transaction.data.amountConflict
                ? ('needs-review' as const)
                : transaction.data.reversal === null
                  ? ('active' as const)
                  : ('reversed' as const),
            },
          };
        }
        const budget = CanonicalFinanceBudgetSchema.safeParse(row.payload);
        if (!budget.success || budget.data.id !== row.entity_id) {
          return invalidResult('Database returned a malformed finance budget');
        }
        return {
          row,
          item: {
            recordType: 'budget' as const,
            id: budget.data.id,
            currency: budget.data.currency,
            allocationsCadMinor: budget.data.allocationsCadMinor,
          },
        };
      });
      const last = page.at(-1);
      return FinancePageSchema.parse({
        schemaVersion: 1,
        items: page.map(({ item }) => item),
        ...(rows.length > parsed.limit && last !== undefined
          ? {
              nextCursor: cursorCodec.issue({
                ...binding,
                position: {
                  at: last.row.updated_at,
                  entityType: last.row.entity_type,
                  id: last.row.entity_id,
                },
              }),
            }
          : {}),
      });
    });
  },
});

const createShoppingRead = (
  pool: DatabasePool,
  cursorCodec: ExperienceQueryCursorCodec,
) => ({
  async list(input: {
    readonly cursor?: string;
    readonly limit: number;
    readonly principal: ExperienceApiPrincipal;
    readonly requestId: string;
  }): Promise<ShoppingPage> {
    const parsed = parseInput(
      EntityPageInputSchema,
      input,
      'Shopping read input is malformed',
    );
    const binding = {
      ...cursorPrincipalBinding(parsed.principal),
      kind: 'shopping' as const,
    };
    const verifiedCursor = verifyExperienceCursor(
      cursorCodec,
      parsed.cursor,
      binding,
      'shopping cursor is malformed',
    );
    const cursor =
      verifiedCursor !== undefined && 'at' in verifiedCursor
        ? verifiedCursor
        : undefined;
    return withHouseholdScope(pool, parsed, async (client) => {
      const result = await client.query(
        `/* experience_shopping_entities */
         select entity_id, payload, updated_at
           from emdo.sync_entities
          where household_id = $1
            and entity_type = 'shopping.item'
            and tombstoned_at is null
            and ($2::timestamptz is null or (updated_at, entity_id) < ($2, $3))
          order by updated_at desc, entity_id desc
          limit $4`,
        [
          parsed.principal.householdId,
          cursor?.at ?? null,
          cursor?.id ?? null,
          parsed.limit + 1,
        ],
      );
      const rows = parseRows(
        EntityRowSchema,
        result.rows,
        'Database returned malformed shopping rows',
      );
      const page = rows.slice(0, parsed.limit).map((row) => {
        const item = CanonicalShoppingPayloadSchema.safeParse(row.payload);
        if (!item.success || item.data.itemId !== row.entity_id) {
          return invalidResult('Database returned a malformed shopping item');
        }
        return {
          row,
          item: {
            id: item.data.itemId,
            ...(item.data.name === undefined ? {} : { name: item.data.name }),
            ...(item.data.unit === undefined ? {} : { unit: item.data.unit }),
            ...(item.data.retailer === undefined
              ? {}
              : { retailer: item.data.retailer }),
            quantityMinorUnits: item.data.quantityMinorUnits,
            state: item.data.quantityConflict
              ? ('needs-review' as const)
              : ('active' as const),
          },
        };
      });
      const last = page.at(-1);
      return ShoppingPageSchema.parse({
        schemaVersion: 1,
        items: page.map(({ item }) => item),
        ...(rows.length > parsed.limit && last !== undefined
          ? {
              nextCursor: cursorCodec.issue({
                ...binding,
                position: {
                  at: last.row.updated_at,
                  id: last.row.entity_id,
                },
              }),
            }
          : {}),
      });
    });
  },
});

const createNotificationPreferences = (pool: DatabasePool) => ({
  async get(input: {
    readonly principal: ExperienceApiPrincipal;
    readonly requestId: string;
  }): Promise<NotificationPreferencesView> {
    const parsed = parseInput(
      SettingsReadInputSchema,
      input,
      'Notification preference read input is malformed',
    );
    return runExperienceDatabaseOperation(() =>
      withHouseholdScope(pool, parsed, async (client) => {
        const row = parseRows(
          PreferencesFunctionRowSchema,
          (
            await client.query(
              `/* experience_notification_preferences_get */
             select emdo.read_experience_notification_preferences($1) as result`,
              [parsed.principal.householdId],
            )
          ).rows,
          'Database returned a malformed notification preference row',
        )[0];
        if (row === undefined) {
          return invalidResult('Database returned no notification preferences');
        }
        const result = NotificationPreferencesViewSchema.safeParse(row.result);
        return result.success
          ? result.data
          : invalidResult(
              'Database returned malformed notification preferences',
            );
      }),
    );
  },
  async update(input: {
    readonly expectedVersion: number;
    readonly preferences: NotificationPreferencesUpdateRequest['preferences'];
    readonly idempotencyKey: string;
    readonly principal: ExperienceApiPrincipal;
    readonly requestId: string;
  }): Promise<NotificationPreferencesView> {
    const parsed = parseInput(
      PreferencesUpdateInputSchema,
      input,
      'Notification preference update input is malformed',
    );
    return runExperienceDatabaseOperation(() =>
      withHouseholdScope(pool, parsed, async (client) => {
        const row = parseRows(
          PreferencesFunctionRowSchema,
          (
            await client.query(
              `/* experience_notification_preferences_update */
             select emdo.update_experience_notification_preferences(
               $1, $2, $3, $4, $5, $6, $7
             ) as result`,
              [
                parsed.principal.householdId,
                parsed.expectedVersion,
                parsed.preferences.inApp,
                parsed.preferences.push,
                parsed.preferences.email,
                parsed.preferences.spokenReplies,
                parsed.idempotencyKey,
              ],
            )
          ).rows,
          'Database returned a malformed preference update row',
        )[0];
        if (row === undefined) {
          return invalidResult('Database returned no preference update');
        }
        const result = NotificationPreferencesViewSchema.safeParse(row.result);
        return result.success
          ? result.data
          : invalidResult('Database returned a malformed preference update');
      }),
    );
  },
});

const createSettingsRead = (pool: DatabasePool) => ({
  async read(input: {
    readonly principal: ExperienceApiPrincipal;
    readonly requestId: string;
  }): Promise<SettingsView> {
    const parsed = parseInput(
      SettingsReadInputSchema,
      input,
      'Settings read input is malformed',
    );
    return withHouseholdScope(pool, parsed, async (client) => {
      const householdResult = await client.query(
        `/* experience_settings_household */
         select household.name as household_name, membership.role
           from emdo.households household
           join emdo.household_memberships membership
             on membership.household_id = household.id
            and membership.user_id = $2
            and membership.status = 'active'
          where household.id = $1
          limit 1`,
        [parsed.principal.householdId, parsed.principal.userId],
      );
      const householdRows = parseRows(
        HouseholdRowSchema,
        householdResult.rows,
        'Database returned malformed household settings',
      );
      const household = householdRows[0];
      if (household === undefined) {
        return invalidResult('Database returned no active household settings');
      }
      const privateSpacesResult = await client.query(
        `/* experience_settings_private_spaces */
         select name
           from emdo.spaces
          where household_id = $1
            and original_owner_user_id = $2
            and visibility = 'private'
            and tombstoned_at is null
          order by name, id
          limit 50`,
        [parsed.principal.householdId, parsed.principal.userId],
      );
      const privateSpaces = parseRows(
        PrivateSpaceRowSchema,
        privateSpacesResult.rows,
        'Database returned malformed private-space settings',
      );
      return SettingsViewSchema.parse({
        schemaVersion: 1,
        household: {
          name: household.household_name,
          role: household.role,
        },
        privateSpaces,
        calendar: await readCalendarState(
          client,
          parsed.principal.householdId,
          parsed.principal.userId,
        ),
      });
    });
  },
});

export const createPostgresExperienceReadGateways = (
  pool: DatabasePool,
  cursorCodec: ExperienceQueryCursorCodec,
): PostgresExperienceReadGateways =>
  Object.freeze({
    todayRead: Object.freeze(createTodayRead(pool)),
    activityRead: Object.freeze(createActivityRead(pool, cursorCodec)),
    scheduleRead: Object.freeze(createScheduleRead(pool, cursorCodec)),
    financeRead: Object.freeze(createFinanceRead(pool, cursorCodec)),
    shoppingRead: Object.freeze(createShoppingRead(pool, cursorCodec)),
    settingsRead: Object.freeze(createSettingsRead(pool)),
    notificationPreferences: Object.freeze(createNotificationPreferences(pool)),
  });

interface ExperienceReadinessRelation {
  readonly name: string;
  readonly columns: readonly string[];
}

interface ExperienceReadinessDefinition {
  readonly marker: string;
  readonly relations?: readonly ExperienceReadinessRelation[];
  readonly routines?: readonly string[];
  readonly isolatedRoutines?: readonly string[];
  readonly privateRelations?: readonly string[];
}

const readinessRelationCondition = ({
  name,
  columns,
}: ExperienceReadinessRelation): string =>
  `(
    pg_catalog.to_regclass('${name}') is not null
    and coalesce((
      select relation.relrowsecurity and relation.relforcerowsecurity
        from pg_catalog.pg_class relation
       where relation.oid = pg_catalog.to_regclass('${name}')
    ), false)
    and pg_catalog.has_table_privilege(
      session_user, pg_catalog.to_regclass('${name}'), 'SELECT'
    )
    ${columns
      .map(
        (column) => `and pg_catalog.has_column_privilege(
      session_user, '${name}', '${column}', 'SELECT'
    )`,
      )
      .join('\n    ')}
  )`;

const readinessRoutineCondition = (signature: string): string =>
  `(
    pg_catalog.to_regprocedure('${signature}') is not null
    and pg_catalog.has_function_privilege(
      session_user, '${signature}', 'EXECUTE'
    )
  )`;

const readinessIsolatedRoutineCondition = (signature: string): string =>
  `(
    pg_catalog.to_regprocedure('${signature}') is not null
    and pg_catalog.has_function_privilege(
      session_user, '${signature}', 'EXECUTE'
    )
    and exists (
      select 1
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_roles owner on owner.oid = routine.proowner
       where routine.oid = pg_catalog.to_regprocedure('${signature}')
         and routine.prosecdef
         and owner.rolname = 'emdo_experience_preferences_executor'
         and not owner.rolcanlogin
         and not owner.rolsuper
         and not owner.rolbypassrls
         and coalesce(routine.proconfig, array[]::text[])
               @> array['search_path=pg_catalog, emdo', 'row_security=on']::text[]
         and not exists (
           select 1
             from pg_catalog.aclexplode(
               coalesce(
                 routine.proacl,
                 pg_catalog.acldefault('f', routine.proowner)
               )
             ) acl
            where acl.grantee = 0
              and acl.privilege_type = 'EXECUTE'
         )
         and not exists (
           select 1
             from pg_catalog.pg_auth_members membership
            where membership.member = owner.oid
               or membership.roleid = owner.oid
         )
    )
  )`;

const API_LOGIN_AUTHORITY_READINESS = `(
    exists (
      select 1
        from pg_catalog.pg_roles login_role
       where login_role.rolname = session_user
         and login_role.rolcanlogin
         and login_role.rolinherit
         and not login_role.rolsuper
         and not login_role.rolbypassrls
         and not login_role.rolcreaterole
         and not login_role.rolcreatedb
         and not login_role.rolreplication
    )
    and exists (
      select 1
        from pg_catalog.pg_auth_members membership
        join pg_catalog.pg_roles child on child.oid = membership.member
        join pg_catalog.pg_roles parent on parent.oid = membership.roleid
       where child.rolname = session_user
         and parent.rolname = 'emdo_app'
         and membership.inherit_option
         and membership.set_option
         and not membership.admin_option
    )
    and not exists (
      select 1
        from pg_catalog.pg_auth_members membership
        join pg_catalog.pg_roles child on child.oid = membership.member
        join pg_catalog.pg_roles parent on parent.oid = membership.roleid
       where child.rolname = session_user
         and parent.rolname <> 'emdo_app'
    )
  )`;

const readinessPrivateRelationCondition = (name: string): string =>
  `(
    pg_catalog.to_regclass('${name}') is not null
    and coalesce((
      select relation.relrowsecurity and relation.relforcerowsecurity
        from pg_catalog.pg_class relation
       where relation.oid = pg_catalog.to_regclass('${name}')
    ), false)
    and not pg_catalog.has_any_column_privilege(
      session_user,
      pg_catalog.to_regclass('${name}'),
      'SELECT,INSERT,UPDATE,REFERENCES'
    )
    and not pg_catalog.has_table_privilege(
      session_user,
      pg_catalog.to_regclass('${name}'),
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    )
  )`;

const checkExperienceComponentReadiness = async (
  pool: DatabasePool,
  definition: ExperienceReadinessDefinition,
): Promise<boolean> => {
  const client = await pool.connect().catch(() => undefined);
  if (client === undefined) return false;
  const conditions = [
    "session_user = 'emdo_api_login'",
    'current_user = session_user',
    "pg_catalog.pg_has_role(session_user, 'emdo_app', 'USAGE')",
    API_LOGIN_AUTHORITY_READINESS,
    readinessRoutineCondition('emdo.lock_active_request_scope(uuid,uuid,uuid)'),
    ...(definition.relations ?? []).map(readinessRelationCondition),
    ...(definition.routines ?? []).map(readinessRoutineCondition),
    ...(definition.isolatedRoutines ?? []).map(
      readinessIsolatedRoutineCondition,
    ),
    ...(definition.privateRelations ?? []).map(
      readinessPrivateRelationCondition,
    ),
  ];
  let ready = false;
  try {
    const result = await client.query(
      `/* ${definition.marker} */
       select (${conditions.join('\n         and ')}) as ready`,
      [],
    );
    ready = ReadinessRowSchema.safeParse(result.rows[0]).success;
  } catch {
    ready = false;
  }
  try {
    client.release();
  } catch {
    return false;
  }
  return ready;
};

const SYNC_ENTITY_READINESS = {
  name: 'emdo.sync_entities',
  columns: [
    'household_id',
    'entity_type',
    'entity_id',
    'payload',
    'tombstoned_at',
    'updated_at',
  ],
} as const;

const FINANCE_SNAPSHOT_ENTITY_READINESS = {
  name: 'emdo.sync_entities',
  columns: [
    'id',
    'household_id',
    'space_id',
    'original_owner_user_id',
    'entity_type',
    'entity_id',
    'payload',
    'revision',
    'tombstoned_at',
    'updated_at',
  ],
} as const;

const EXPERIENCE_READINESS_DEFINITIONS = Object.freeze({
  todayRead: {
    marker: 'experience_today_read_ready',
    relations: [
      SYNC_ENTITY_READINESS,
      {
        name: 'emdo.scheduler_reminders',
        columns: [
          'household_id',
          'original_owner_user_id',
          'reminder_id',
          'title',
          'sensitivity',
          'due_at',
          'state',
          'tombstoned_at',
        ],
      },
      {
        name: 'emdo.notifications',
        columns: [
          'household_id',
          'original_owner_user_id',
          'notification_id',
          'title',
          'sensitivity',
          'in_app',
          'created_at',
          'tombstoned_at',
        ],
      },
    ],
  },
  activityRead: {
    marker: 'experience_activity_read_ready',
    relations: [
      {
        name: 'emdo.audit_events',
        columns: ['household_id', 'id', 'event_type', 'occurred_at'],
      },
      {
        name: 'emdo.calendar_maintenance_receipts',
        columns: [
          'household_id',
          'receipt_id',
          'kind',
          'status',
          'recorded_at',
        ],
      },
      {
        name: 'emdo.notification_deliveries',
        columns: ['household_id', 'delivery_id', 'status', 'attempted_at'],
      },
    ],
  },
  scheduleRead: {
    marker: 'experience_schedule_read_ready',
    relations: [
      SYNC_ENTITY_READINESS,
      {
        name: 'emdo.calendar_sync_states',
        columns: [
          'household_id',
          'original_owner_user_id',
          'connection_id',
          'state',
          'last_synced_at',
          'updated_at',
        ],
      },
    ],
  },
  financeRead: {
    marker: 'experience_finance_read_ready',
    relations: [FINANCE_SNAPSHOT_ENTITY_READINESS],
  },
  shoppingRead: {
    marker: 'experience_shopping_read_ready',
    relations: [SYNC_ENTITY_READINESS],
  },
  settingsRead: {
    marker: 'experience_settings_read_ready',
    relations: [
      { name: 'emdo.households', columns: ['id', 'name'] },
      {
        name: 'emdo.household_memberships',
        columns: ['household_id', 'user_id', 'role', 'status'],
      },
      {
        name: 'emdo.spaces',
        columns: [
          'household_id',
          'id',
          'name',
          'original_owner_user_id',
          'visibility',
          'tombstoned_at',
        ],
      },
      {
        name: 'emdo.calendar_sync_states',
        columns: [
          'household_id',
          'original_owner_user_id',
          'connection_id',
          'state',
          'last_synced_at',
          'updated_at',
        ],
      },
    ],
  },
  notificationPreferences: {
    marker: 'experience_preferences_ready',
    isolatedRoutines: [
      'emdo.read_experience_notification_preferences(uuid)',
      'emdo.update_experience_notification_preferences(uuid,integer,boolean,boolean,boolean,boolean,text)',
    ],
    privateRelations: [
      'emdo.notification_preferences',
      'emdo.notification_preference_commands',
    ],
  },
} satisfies Record<string, ExperienceReadinessDefinition>);

export interface PostgresExperienceReadinessChecks {
  readonly todayRead: () => Promise<boolean>;
  readonly activityRead: () => Promise<boolean>;
  readonly scheduleRead: () => Promise<boolean>;
  readonly financeRead: () => Promise<boolean>;
  readonly shoppingRead: () => Promise<boolean>;
  readonly settingsRead: () => Promise<boolean>;
  readonly notificationPreferences: () => Promise<boolean>;
}

export const createPostgresExperienceReadinessChecks = (
  pool: DatabasePool,
): PostgresExperienceReadinessChecks =>
  Object.freeze({
    todayRead: () =>
      checkExperienceComponentReadiness(
        pool,
        EXPERIENCE_READINESS_DEFINITIONS.todayRead,
      ),
    activityRead: () =>
      checkExperienceComponentReadiness(
        pool,
        EXPERIENCE_READINESS_DEFINITIONS.activityRead,
      ),
    scheduleRead: () =>
      checkExperienceComponentReadiness(
        pool,
        EXPERIENCE_READINESS_DEFINITIONS.scheduleRead,
      ),
    financeRead: () =>
      checkExperienceComponentReadiness(
        pool,
        EXPERIENCE_READINESS_DEFINITIONS.financeRead,
      ),
    shoppingRead: () =>
      checkExperienceComponentReadiness(
        pool,
        EXPERIENCE_READINESS_DEFINITIONS.shoppingRead,
      ),
    settingsRead: () =>
      checkExperienceComponentReadiness(
        pool,
        EXPERIENCE_READINESS_DEFINITIONS.settingsRead,
      ),
    notificationPreferences: () =>
      checkExperienceComponentReadiness(
        pool,
        EXPERIENCE_READINESS_DEFINITIONS.notificationPreferences,
      ),
  });

/**
 * Capability-specific preflight for the aggregate read surface. This proves
 * the fixed API login, inherited app role, request-scope lock, forced RLS, and
 * the exact relations/columns used above. It intentionally does not use a
 * generic connectivity probe.
 */
export const checkPostgresExperienceReadiness = async (
  pool: DatabasePool,
): Promise<boolean> => {
  const client = await pool.connect().catch(() => undefined);
  if (client === undefined) return false;
  let ready = false;
  try {
    const result = await client.query(
      `/* experience_read_ready */
       select (
         session_user = 'emdo_api_login'
         and current_user = session_user
         and pg_catalog.pg_has_role(session_user, 'emdo_app', 'USAGE')
         and ${API_LOGIN_AUTHORITY_READINESS}
         and pg_catalog.to_regprocedure(
           'emdo.lock_active_request_scope(uuid,uuid,uuid)'
         ) is not null
         and pg_catalog.has_function_privilege(
           session_user,
           'emdo.lock_active_request_scope(uuid,uuid,uuid)',
           'EXECUTE'
         )
         and not exists (
           select from (
             values
               ('emdo.households'),
               ('emdo.household_memberships'),
               ('emdo.spaces'),
               ('emdo.audit_events'),
               ('emdo.scheduler_reminders'),
               ('emdo.notifications'),
               ('emdo.notification_deliveries'),
               ('emdo.calendar_sync_states'),
               ('emdo.calendar_maintenance_receipts'),
               ('emdo.sync_entities')
           ) as expected(relation_name)
           left join pg_catalog.pg_class relation
             on relation.oid = pg_catalog.to_regclass(expected.relation_name)
          where relation.oid is null
             or relation.relrowsecurity is not true
             or relation.relforcerowsecurity is not true
             or not pg_catalog.has_table_privilege(
               session_user, relation.oid, 'SELECT'
             )
         )
         and pg_catalog.has_column_privilege(
           session_user, 'emdo.households', 'name', 'SELECT'
         )
         and pg_catalog.has_column_privilege(
           session_user, 'emdo.household_memberships', 'role', 'SELECT'
         )
         and pg_catalog.has_column_privilege(
           session_user, 'emdo.spaces', 'name', 'SELECT'
         )
         and pg_catalog.has_column_privilege(
           session_user, 'emdo.audit_events', 'event_type', 'SELECT'
         )
         and pg_catalog.has_column_privilege(
           session_user, 'emdo.scheduler_reminders', 'due_at', 'SELECT'
         )
         and pg_catalog.has_column_privilege(
           session_user, 'emdo.notifications', 'title', 'SELECT'
         )
         and pg_catalog.has_column_privilege(
           session_user, 'emdo.notification_deliveries', 'status', 'SELECT'
         )
         and pg_catalog.has_column_privilege(
           session_user, 'emdo.calendar_sync_states', 'state', 'SELECT'
         )
         and pg_catalog.has_column_privilege(
           session_user, 'emdo.calendar_maintenance_receipts', 'kind', 'SELECT'
         )
         and pg_catalog.has_column_privilege(
           session_user, 'emdo.sync_entities', 'payload', 'SELECT'
         )
         and pg_catalog.has_column_privilege(
           session_user, 'emdo.sync_entities', 'entity_type', 'SELECT'
         )
         and not exists (
           select from (
             values
               ('emdo.notification_preferences'),
               ('emdo.notification_preference_commands')
           ) as expected(relation_name)
           left join pg_catalog.pg_class relation
             on relation.oid = pg_catalog.to_regclass(expected.relation_name)
          where relation.oid is null
             or relation.relrowsecurity is not true
             or relation.relforcerowsecurity is not true
             or pg_catalog.has_any_column_privilege(
               session_user, relation.oid, 'SELECT,INSERT,UPDATE,REFERENCES'
             )
             or pg_catalog.has_table_privilege(
               session_user, relation.oid,
               'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
             )
         )
         and pg_catalog.to_regprocedure(
           'emdo.read_experience_notification_preferences(uuid)'
         ) is not null
         and pg_catalog.has_function_privilege(
           session_user,
           'emdo.read_experience_notification_preferences(uuid)',
           'EXECUTE'
         )
         and pg_catalog.to_regprocedure(
           'emdo.update_experience_notification_preferences(uuid,integer,boolean,boolean,boolean,boolean,text)'
         ) is not null
         and pg_catalog.has_function_privilege(
           session_user,
           'emdo.update_experience_notification_preferences(uuid,integer,boolean,boolean,boolean,boolean,text)',
           'EXECUTE'
         )
       ) as ready`,
      [],
    );
    ready = ReadinessRowSchema.safeParse(result.rows[0]).success;
  } catch {
    ready = false;
  }
  try {
    client.release();
  } catch {
    return false;
  }
  return ready;
};

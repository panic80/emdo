import { sql } from 'drizzle-orm';
import {
  pgSchema,
  uuid,
  integer,
  bigint,
  text,
  jsonb,
  timestamp,
  unique,
  index,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core';
import {
  financeAutomationGrants,
  financeAutomationRuns,
} from './finance-automation-schema.js';
import { authUsers } from './schema.js';
const schema = pgSchema('emdo');
const at = (name: string) => timestamp(name, { withTimezone: true });
export const financeSchedules = schema.table(
  'finance_schedules',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    grantId: uuid('grant_id').notNull(),
    grantRevision: integer('grant_revision').notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => authUsers.id),
    definition: jsonb('definition').notNull(),
    definitionRevision: integer('definition_revision').notNull().default(1),
    stateRevision: integer('state_revision').notNull().default(1),
    status: text('status').notNull().default('active'),
    nextOrdinal: bigint('next_ordinal', { mode: 'number' })
      .notNull()
      .default(0),
    nextDueAt: at('next_due_at'),
    nextPollAt: at('next_poll_at').notNull().defaultNow(),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: at('lease_expires_at'),
    plannedAt: at('planned_at'),
    blockedReason: text('blocked_reason'),
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('finance_schedule_scope').on(t.workspaceId, t.bookId, t.id),
    foreignKey({
      name: 'finance_schedule_grant_scope',
      columns: [t.workspaceId, t.bookId, t.grantId],
      foreignColumns: [
        financeAutomationGrants.workspaceId,
        financeAutomationGrants.bookId,
        financeAutomationGrants.id,
      ],
    }),
    index('finance_schedule_due')
      .on(t.nextPollAt, t.nextDueAt)
      .where(sql`${t.status}='active'`),
    check(
      'finance_schedule_state',
      sql`${t.status} in ('active','paused','retired') and ${t.definitionRevision}=1 and ${t.stateRevision}>0 and ${t.grantRevision}>0 and ${t.nextOrdinal} between 0 and 1000000000 and octet_length(${t.definition}::text)<=1048576`,
    ),
  ],
);
export const financeSchedulePlans = schema.table(
  'finance_schedule_plans',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    scheduleId: uuid('schedule_id').notNull(),
    definitionRevision: integer('definition_revision').notNull(),
    lastOrdinal: bigint('last_ordinal', { mode: 'number' }).notNull(),
    leaseToken: uuid('lease_token').notNull(),
    operationId: uuid('operation_id'),
    occurrenceKey: text('occurrence_key'),
    plan: jsonb('plan').notNull(),
    lineage: jsonb('lineage').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('finance_schedule_occurrence').on(
      t.scheduleId,
      t.definitionRevision,
      t.lastOrdinal,
    ),
    unique('finance_schedule_plan_lease').on(t.leaseToken),
    unique('finance_schedule_operation').on(t.operationId),
    foreignKey({
      name: 'finance_schedule_plan_scope',
      columns: [t.workspaceId, t.bookId, t.scheduleId],
      foreignColumns: [
        financeSchedules.workspaceId,
        financeSchedules.bookId,
        financeSchedules.id,
      ],
    }),
    foreignKey({
      name: 'finance_schedule_run_scope',
      columns: [t.workspaceId, t.bookId, t.operationId],
      foreignColumns: [
        financeAutomationRuns.workspaceId,
        financeAutomationRuns.bookId,
        financeAutomationRuns.id,
      ],
    }),
    check(
      'finance_schedule_plan_bounds',
      sql`${t.definitionRevision}=1 and ${t.lastOrdinal} between 0 and 999999999 and octet_length(${t.plan}::text)<=16384 and octet_length(${t.lineage}::text)<=4096 and (${t.operationId} is null)=(${t.occurrenceKey} is null)`,
    ),
  ],
);

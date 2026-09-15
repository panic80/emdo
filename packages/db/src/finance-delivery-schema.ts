import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { financeAutomationRuns } from './finance-automation-schema.js';
export const financeDeliveries = pgSchema('emdo').table(
  'finance_deliveries',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    operationId: uuid('operation_id').notNull(),
    deliveryRevision: integer('delivery_revision').notNull(),
    payloadHash: text('payload_hash').notNull(),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    availableAt: timestamp('available_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('finance_delivery_run_revision').on(
      t.operationId,
      t.deliveryRevision,
    ),
    foreignKey({
      name: 'finance_delivery_run_scope',
      columns: [t.workspaceId, t.bookId, t.operationId],
      foreignColumns: [
        financeAutomationRuns.workspaceId,
        financeAutomationRuns.bookId,
        financeAutomationRuns.id,
      ],
    }),
    check(
      'finance_delivery_bounds',
      sql`${t.deliveryRevision}>0 and ${t.attempts} between 0 and 20 and ${t.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'finance_delivery_state',
      sql`${t.state} in ('pending','leased','enqueued','cancelled','quarantined')`,
    ),
    index('finance_delivery_due').on(t.state, t.availableAt),
  ],
);

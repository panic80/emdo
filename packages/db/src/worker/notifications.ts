import { deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import { firstResultRow } from '../durable/scoped-transaction.js';
import {
  WORKER_JOB_NAMES,
  WorkerOperationIdSchema,
  WorkerPersistenceError,
  WorkerReferenceSchema,
  parseDurableWorkerExecutionContext,
  withWorkerOperationTransaction,
  type DurableWorkerExecutionContext,
} from './scope.js';

const LoadSchema = z.strictObject({
  operationId: WorkerOperationIdSchema,
  notificationId: WorkerReferenceSchema,
});
const WriteInAppSchema = z.strictObject({
  operationId: WorkerOperationIdSchema,
  deliveryId: WorkerReferenceSchema,
  notificationId: WorkerReferenceSchema,
  revision: z.number().int().safe().positive(),
  sensitivity: z.enum(['standard', 'sensitive']),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4_000),
});
const ExternalOutcomeSchema = z.strictObject({
  operationId: WorkerOperationIdSchema,
  deliveryId: WorkerReferenceSchema,
  notificationId: WorkerReferenceSchema,
  channel: z.enum(['email', 'push']),
  status: z.enum(['sent', 'duplicate', 'gone', 'not-applied', 'indeterminate']),
});

const DeliveryPreferencesSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    notificationId: WorkerReferenceSchema,
    revision: z.number().int().safe().positive(),
    sensitivity: z.enum(['standard', 'sensitive']),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(4_000),
    channels: z.strictObject({
      inApp: z.boolean(),
      email: z.strictObject({
        enabled: z.boolean(),
        recipient: z.email().max(320).nullable(),
      }),
      push: z.strictObject({
        enabled: z.boolean(),
        subscriptionReference: WorkerReferenceSchema.nullable(),
      }),
    }),
  })
  .superRefine((value, context) => {
    if (
      value.channels.email.enabled !==
      (value.channels.email.recipient !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['channels', 'email'],
        message: 'Email delivery preference is inconsistent',
      });
    }
    if (
      value.channels.push.enabled !==
      (value.channels.push.subscriptionReference !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['channels', 'push'],
        message: 'Push delivery preference is inconsistent',
      });
    }
  });

export interface PostgresNotificationDeliveryRecord {
  readonly schemaVersion: 1;
  readonly notificationId: string;
  readonly revision: number;
  readonly sensitivity: 'standard' | 'sensitive';
  readonly title: string;
  readonly body: string;
  readonly channels: Readonly<{
    inApp: boolean;
    email: Readonly<{ recipient: string }> | null;
    push: Readonly<{ subscriptionReference: string }> | null;
  }>;
  readonly externalOutcomes: Readonly<{
    email: 'sent' | 'duplicate' | 'not-applied' | 'indeterminate' | null;
    push:
      'sent' | 'duplicate' | 'gone' | 'not-applied' | 'indeterminate' | null;
  }>;
}

const parseRecord = (
  row: Record<string, unknown>,
): PostgresNotificationDeliveryRecord => {
  const parsed = z
    .strictObject({
      delivery_preferences: DeliveryPreferencesSchema,
      email_outcome: z
        .enum(['sent', 'duplicate', 'not-applied', 'indeterminate'])
        .nullable(),
      push_outcome: z
        .enum(['sent', 'duplicate', 'gone', 'not-applied', 'indeterminate'])
        .nullable(),
    })
    .safeParse(row);
  if (!parsed.success) {
    throw new WorkerPersistenceError(
      'invalid-result',
      'Canonical notification record is malformed',
    );
  }
  const value = parsed.data;
  const preferences = value.delivery_preferences;
  return deepFreeze({
    schemaVersion: 1 as const,
    notificationId: preferences.notificationId,
    revision: preferences.revision,
    sensitivity: preferences.sensitivity,
    title: preferences.title,
    body: preferences.body,
    channels: {
      inApp: preferences.channels.inApp,
      email: !preferences.channels.email.enabled
        ? null
        : { recipient: preferences.channels.email.recipient! },
      push: !preferences.channels.push.enabled
        ? null
        : {
            subscriptionReference:
              preferences.channels.push.subscriptionReference!,
          },
    },
    externalOutcomes: {
      email: value.email_outcome,
      push: value.push_outcome,
    },
  });
};

/** Structurally matches the worker NotificationDeliveryRepository. */
export class PostgresNotificationDeliveryRepository {
  constructor(private readonly pool: DatabasePool) {}

  async loadForDelivery(
    input: { readonly operationId: string; readonly notificationId: string },
    context: DurableWorkerExecutionContext,
  ): Promise<PostgresNotificationDeliveryRecord> {
    const request = LoadSchema.parse(input);
    const executionContext = parseDurableWorkerExecutionContext(context, {
      jobName: WORKER_JOB_NAMES.notificationDelivery,
      operationId: request.operationId,
    });
    return withWorkerOperationTransaction(
      this.pool,
      {
        execution: executionContext.execution,
        targetType: 'notification',
        targetId: request.notificationId,
      },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select preferences.delivery_preferences,
                    (
                      select delivery.status
                        from emdo.notification_deliveries as delivery
                       where delivery.notification_id =
                               (preferences.delivery_preferences
                                  ->> 'notificationId')::uuid
                         and delivery.revision =
                               (preferences.delivery_preferences
                                  ->> 'revision')::integer
                         and delivery.channel = 'email'
                       order by delivery.updated_at desc, delivery.delivery_id
                       limit 1
                    ) as email_outcome,
                    (
                      select delivery.status
                        from emdo.notification_deliveries as delivery
                       where delivery.notification_id =
                               (preferences.delivery_preferences
                                  ->> 'notificationId')::uuid
                         and delivery.revision =
                               (preferences.delivery_preferences
                                  ->> 'revision')::integer
                         and delivery.channel = 'push'
                       order by delivery.updated_at desc, delivery.delivery_id
                       limit 1
                    ) as push_outcome
               from (
                 select emdo.read_worker_notification_delivery_preferences(
                   $1::uuid
                 ) as delivery_preferences
               ) as preferences
              where preferences.delivery_preferences is not null`,
            [request.notificationId],
          ),
        );
        if (row === undefined) {
          throw new WorkerPersistenceError(
            'operation-unavailable',
            'Notification is unavailable in the canonical worker scope',
          );
        }
        return parseRecord(row);
      },
    );
  }

  async writeInApp(
    input: {
      readonly operationId: string;
      readonly deliveryId: string;
      readonly notificationId: string;
      readonly revision: number;
      readonly sensitivity: 'standard' | 'sensitive';
      readonly title: string;
      readonly body: string;
    },
    context: DurableWorkerExecutionContext,
  ): Promise<Readonly<{ status: 'created' | 'duplicate' }>> {
    const request = WriteInAppSchema.parse(input);
    const executionContext = parseDurableWorkerExecutionContext(context, {
      jobName: WORKER_JOB_NAMES.notificationDelivery,
      operationId: request.operationId,
    });
    return withWorkerOperationTransaction(
      this.pool,
      {
        execution: executionContext.execution,
        targetType: 'notification',
        targetId: request.notificationId,
        targetRevision: request.revision,
      },
      async (client) => {
        const inserted = firstResultRow(
          await client.query(
            `with database_time as (
               select pg_catalog.clock_timestamp() as now
             )
             insert into emdo.notification_deliveries
               (delivery_id, household_id, space_id, original_owner_user_id,
                notification_id, operation_id, revision, channel, status,
                sensitivity, title, body, attempted_at, updated_at, retain_until)
             select $1, household_id, space_id, original_owner_user_id,
                    notification_id, $3, revision, 'in-app', 'created',
                    sensitivity, title, body, database_time.now,
                    database_time.now, database_time.now + interval '90 days'
               from emdo.notifications cross join database_time
              where notification_id = $2 and revision = $4
                and sensitivity = $5 and title = $6 and body = $7
                and in_app = true and tombstoned_at is null
             on conflict (delivery_id) do nothing
             returning delivery_id`,
            [
              request.deliveryId,
              request.notificationId,
              request.operationId,
              request.revision,
              request.sensitivity,
              request.title,
              request.body,
            ],
          ),
        );
        if (inserted?.delivery_id === request.deliveryId) {
          return deepFreeze({ status: 'created' as const });
        }
        const existing = firstResultRow(
          await client.query(
            `select notification_id, operation_id, revision, channel, status,
                    sensitivity, title, body
               from emdo.notification_deliveries
              where delivery_id = $1`,
            [request.deliveryId],
          ),
        );
        if (
          existing?.notification_id !== request.notificationId ||
          existing.operation_id !== request.operationId ||
          existing.revision !== request.revision ||
          existing.channel !== 'in-app' ||
          existing.status !== 'created' ||
          existing.sensitivity !== request.sensitivity ||
          existing.title !== request.title ||
          existing.body !== request.body
        ) {
          throw new WorkerPersistenceError(
            'conflict',
            'In-app delivery idempotency binding conflicts',
          );
        }
        return deepFreeze({ status: 'duplicate' as const });
      },
    );
  }

  async recordExternalOutcome(
    input: {
      readonly operationId: string;
      readonly deliveryId: string;
      readonly notificationId: string;
      readonly channel: 'email' | 'push';
      readonly status:
        'sent' | 'duplicate' | 'gone' | 'not-applied' | 'indeterminate';
    },
    context: DurableWorkerExecutionContext,
  ): Promise<void> {
    const request = ExternalOutcomeSchema.parse(input);
    const executionContext = parseDurableWorkerExecutionContext(context, {
      jobName: WORKER_JOB_NAMES.notificationDelivery,
      operationId: request.operationId,
    });
    await withWorkerOperationTransaction(
      this.pool,
      {
        execution: executionContext.execution,
        targetType: 'notification',
        targetId: request.notificationId,
      },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `with canonical as (
               select household_id, space_id, original_owner_user_id,
                      notification_id, revision
                 from emdo.notifications
                where notification_id = $2
                  and revision = emdo.current_worker_target_revision()
                  and tombstoned_at is null
             ), database_time as (
               select pg_catalog.clock_timestamp() as now
             )
             insert into emdo.notification_deliveries
               (delivery_id, household_id, space_id, original_owner_user_id,
                notification_id, operation_id, revision, channel, status,
                sensitivity, title, body, attempted_at, updated_at, retain_until)
             select $1, household_id, space_id, original_owner_user_id,
                    notification_id, $3, revision, $4, $5,
                    null, null, null, database_time.now, database_time.now,
                    database_time.now + interval '90 days'
               from canonical cross join database_time
             on conflict (delivery_id) do update
               set status = excluded.status,
                   updated_at = pg_catalog.clock_timestamp()
             where notification_deliveries.notification_id = excluded.notification_id
               and notification_deliveries.operation_id = excluded.operation_id
               and notification_deliveries.revision = excluded.revision
               and notification_deliveries.channel = excluded.channel
               and notification_deliveries.sensitivity is null
               and notification_deliveries.title is null
               and notification_deliveries.body is null
               and (
                 notification_deliveries.status = excluded.status
                 or (
                   notification_deliveries.status in ('sent', 'duplicate')
                   and excluded.status in ('sent', 'duplicate')
                 )
                 or notification_deliveries.status in ('not-applied', 'indeterminate')
               )
             returning delivery_id`,
            [
              request.deliveryId,
              request.notificationId,
              request.operationId,
              request.channel,
              request.status,
            ],
          ),
        );
        if (row?.delivery_id !== request.deliveryId) {
          throw new WorkerPersistenceError(
            'conflict',
            'External delivery outcome binding conflicts',
          );
        }
      },
    );
  }
}

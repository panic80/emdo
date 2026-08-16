import { UuidSchema, deepFreeze, type JsonValue } from '@emdo/contracts';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import {
  firstResultRow,
  lockDurableScope,
  parseDurablePrincipal,
  withDurableTransaction,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';
import { hashDurableWorkerJobPayload } from './outbox.js';
import {
  WORKER_JOB_NAMES,
  WorkerOperationIdSchema,
  WorkerPersistenceError,
  WorkerReferenceSchema,
  parseDurableWorkerExecutionContext,
  withWorkerOperationTransaction,
  type DurableWorkerExecutionContext,
} from './scope.js';

const ChannelsSchema = z
  .strictObject({
    inApp: z.boolean(),
    email: z.email().max(320).nullable(),
    pushSubscriptionReference: WorkerReferenceSchema.nullable(),
  })
  .refine(
    ({ inApp, email, pushSubscriptionReference }) =>
      inApp || email !== null || pushSubscriptionReference !== null,
  );
const ReminderContent = {
  sensitivity: z.enum(['standard', 'sensitive']),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4_000),
  channels: ChannelsSchema,
} as const;
const ScheduleSchema = z.strictObject({
  reminderId: WorkerReferenceSchema,
  spaceId: UuidSchema,
  operationId: WorkerOperationIdSchema,
  dueAt: z.iso.datetime({ offset: true }),
  ...ReminderContent,
});
const RescheduleSchema = z.strictObject({
  reminderId: WorkerReferenceSchema,
  expectedDueRevision: z.number().int().safe().positive(),
  operationId: WorkerOperationIdSchema,
  dueAt: z.iso.datetime({ offset: true }),
});
const DeliverySchema = z.strictObject({
  operationId: WorkerOperationIdSchema,
  reminderId: WorkerReferenceSchema,
  dueRevision: z.number().int().safe().positive(),
});

const reminderPayload = (
  operationId: string,
  reminderId: string,
  dueRevision: number,
) =>
  deepFreeze({
    schemaVersion: 1 as const,
    origin: 'deterministic-worker' as const,
    operationId,
    reminderId,
    dueRevision,
  });

const insertReminderOutbox = async (
  client: import('../scoped-repository.js').DatabaseClient,
  input: {
    readonly operationId: string;
    readonly reminderId: string;
    readonly dueRevision: number;
    readonly dueAt: Date;
  },
): Promise<void> => {
  const payload = reminderPayload(
    input.operationId,
    input.reminderId,
    input.dueRevision,
  );
  const payloadHash = hashDurableWorkerJobPayload(
    WORKER_JOB_NAMES.reminderDelivery,
    payload as JsonValue,
  );
  const row = firstResultRow(
    await client.query(
      `with reminder_scope as (
         select household_id, space_id, original_owner_user_id
           from emdo.scheduler_reminders
          where reminder_id = $1
       ), database_time as (
         select pg_catalog.clock_timestamp() as now
       )
       insert into emdo.worker_operation_outbox
         (household_id, space_id, original_owner_user_id, request_id,
          job_name, operation_id, target_type, target_id, target_revision,
          payload, payload_hash, state, available_at, created_at, updated_at,
          retain_until)
       select household_id, space_id, original_owner_user_id,
              emdo.current_request_id(), $2, $3, 'reminder', $1, $4,
              $5::jsonb, $6, 'pending', $7, database_time.now,
              database_time.now, database_time.now + interval '90 days'
         from reminder_scope cross join database_time
       on conflict (job_name, operation_id) do nothing
       returning outbox_id`,
      [
        input.reminderId,
        WORKER_JOB_NAMES.reminderDelivery,
        input.operationId,
        input.dueRevision,
        payload,
        payloadHash,
        input.dueAt,
      ],
    ),
  );
  if (row === undefined) {
    const existing = firstResultRow(
      await client.query(
        `select payload_hash, target_id, target_revision
           from emdo.worker_operation_outbox
          where job_name = $1 and operation_id = $2`,
        [WORKER_JOB_NAMES.reminderDelivery, input.operationId],
      ),
    );
    if (
      existing?.payload_hash !== payloadHash ||
      existing.target_id !== input.reminderId ||
      existing.target_revision !== input.dueRevision
    ) {
      throw new WorkerPersistenceError(
        'conflict',
        'Reminder outbox binding conflicts',
      );
    }
  }
};

/** User/request-scoped reminder commands. */
export class PostgresReminderRepository {
  readonly #principal: Readonly<DurableRepositoryPrincipal>;

  constructor(
    private readonly pool: DatabasePool,
    principal: DurableRepositoryPrincipal,
  ) {
    this.#principal = parseDurablePrincipal(principal);
  }

  async schedule(input: z.input<typeof ScheduleSchema>): Promise<{
    readonly reminderId: string;
    readonly dueRevision: 1;
  }> {
    const request = ScheduleSchema.parse(input);
    return withDurableTransaction(
      this.pool,
      this.#principal,
      { householdId: this.#principal.householdId, spaceId: request.spaceId },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `with database_time as (
               select pg_catalog.clock_timestamp() as now
             )
             insert into emdo.scheduler_reminders
               (reminder_id, household_id, space_id, original_owner_user_id,
                due_revision, due_at, state, sensitivity, title, body, in_app,
                email_recipient, push_subscription_reference, created_at,
                updated_at)
             select $1, space.household_id, space.id, emdo.current_user_id(),
                    1, $2, 'scheduled', $3, $4, $5, $6, $7, $8,
                    database_time.now, database_time.now
               from emdo.spaces space cross join database_time
              where space.id = $9 and space.household_id = $10
                and space.tombstoned_at is null
             returning reminder_id`,
            [
              request.reminderId,
              new Date(request.dueAt),
              request.sensitivity,
              request.title,
              request.body,
              request.channels.inApp,
              request.channels.email,
              request.channels.pushSubscriptionReference,
              request.spaceId,
              this.#principal.householdId,
            ],
          ),
        );
        if (row?.reminder_id !== request.reminderId) {
          throw new WorkerPersistenceError(
            'conflict',
            'Reminder id already exists or its scope is unavailable',
          );
        }
        await insertReminderOutbox(client, {
          operationId: request.operationId,
          reminderId: request.reminderId,
          dueRevision: 1,
          dueAt: new Date(request.dueAt),
        });
        return deepFreeze({
          reminderId: request.reminderId,
          dueRevision: 1 as const,
        });
      },
    );
  }

  async reschedule(input: z.input<typeof RescheduleSchema>): Promise<{
    readonly reminderId: string;
    readonly dueRevision: number;
  }> {
    const request = RescheduleSchema.parse(input);
    return withDurableTransaction(
      this.pool,
      this.#principal,
      { householdId: this.#principal.householdId },
      async (client) => {
        const scope = firstResultRow(
          await client.query(
            `select household_id, space_id, original_owner_user_id
               from emdo.scheduler_reminders
              where reminder_id = $1`,
            [request.reminderId],
          ),
        );
        if (
          scope?.household_id !== this.#principal.householdId ||
          scope.original_owner_user_id !== this.#principal.userId ||
          typeof scope.space_id !== 'string'
        ) {
          throw new WorkerPersistenceError(
            'operation-unavailable',
            'Reminder is unavailable in the active scope',
          );
        }
        await lockDurableScope(client, {
          householdId: this.#principal.householdId,
          spaceId: scope.space_id,
        });
        const row = firstResultRow(
          await client.query(
            `update emdo.scheduler_reminders
                set due_revision = due_revision + 1, due_at = $3,
                    state = 'scheduled', delivered_revision = null,
                    delivered_at = null,
                    updated_at = pg_catalog.clock_timestamp()
              where reminder_id = $1 and due_revision = $2
                and household_id = $4 and space_id = $5
                and original_owner_user_id = emdo.current_user_id()
                and tombstoned_at is null
              returning reminder_id, due_revision, due_at`,
            [
              request.reminderId,
              request.expectedDueRevision,
              new Date(request.dueAt),
              this.#principal.householdId,
              scope.space_id,
            ],
          ),
        );
        if (
          row?.reminder_id !== request.reminderId ||
          typeof row.due_revision !== 'number'
        ) {
          throw new WorkerPersistenceError(
            'conflict',
            'Reminder revision changed before rescheduling',
          );
        }
        await insertReminderOutbox(client, {
          operationId: request.operationId,
          reminderId: request.reminderId,
          dueRevision: row.due_revision,
          dueAt: new Date(String(row.due_at)),
        });
        return deepFreeze({
          reminderId: request.reminderId,
          dueRevision: row.due_revision,
        });
      },
    );
  }
}

/** Structurally matches the deterministic worker ReminderDeliveryService. */
export class PostgresReminderDeliveryService {
  constructor(private readonly pool: DatabasePool) {}

  async deliverReminder(
    input: z.input<typeof DeliverySchema>,
    context: DurableWorkerExecutionContext,
  ): Promise<void> {
    const request = DeliverySchema.parse(input);
    const executionContext = parseDurableWorkerExecutionContext(context, {
      jobName: WORKER_JOB_NAMES.reminderDelivery,
      operationId: request.operationId,
    });
    await withWorkerOperationTransaction(
      this.pool,
      {
        execution: executionContext.execution,
        targetType: 'reminder',
        targetId: request.reminderId,
        targetRevision: request.dueRevision,
      },
      async (client) => {
        const reminder = firstResultRow(
          await client.query(
            `select state, due_revision, due_at, sensitivity, title, body,
                    in_app, email_recipient, push_subscription_reference
               from emdo.scheduler_reminders
              where reminder_id = $1
              for update`,
            [request.reminderId],
          ),
        );
        if (
          reminder === undefined ||
          reminder.state !== 'scheduled' ||
          reminder.due_revision !== request.dueRevision
        ) {
          return;
        }
        const databaseTime = firstResultRow(
          await client.query(`select pg_catalog.clock_timestamp() as now`),
        );
        const now =
          databaseTime?.now instanceof Date
            ? databaseTime.now
            : new Date(String(databaseTime?.now));
        const dueAt =
          reminder.due_at instanceof Date
            ? reminder.due_at
            : new Date(String(reminder.due_at));
        if (
          !Number.isFinite(now.getTime()) ||
          dueAt.getTime() > now.getTime()
        ) {
          return;
        }
        const notification = firstResultRow(
          await client.query(
            `insert into emdo.notifications
               (household_id, space_id, original_owner_user_id, source_type,
                source_id, source_revision, revision, sensitivity, title, body,
                in_app, email_recipient, push_subscription_reference,
                created_at, updated_at)
             select household_id, space_id, original_owner_user_id, 'reminder',
                    reminder_id, due_revision, 1, sensitivity, title, body,
                    in_app, email_recipient, push_subscription_reference,
                    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
               from emdo.scheduler_reminders
              where reminder_id = $1 and due_revision = $2
             on conflict (household_id, space_id, original_owner_user_id,
                          source_type, source_id, source_revision)
             do nothing
             returning notification_id, revision`,
            [request.reminderId, request.dueRevision],
          ),
        );
        const canonicalNotification =
          notification ??
          firstResultRow(
            await client.query(
              `select notification_id, revision
                 from emdo.notifications
                where source_type = 'reminder' and source_id = $1
                  and source_revision = $2`,
              [request.reminderId, request.dueRevision],
            ),
          );
        const notificationId = UuidSchema.safeParse(
          canonicalNotification?.notification_id,
        );
        if (!notificationId.success || canonicalNotification?.revision !== 1) {
          throw new WorkerPersistenceError(
            'invalid-result',
            'Canonical reminder notification is malformed',
          );
        }
        const notificationOperationId = `notification:${notificationId.data}:r1`;
        const payload = deepFreeze({
          schemaVersion: 1 as const,
          origin: 'deterministic-worker' as const,
          operationId: notificationOperationId,
          notificationId: notificationId.data,
        });
        const payloadHash = hashDurableWorkerJobPayload(
          WORKER_JOB_NAMES.notificationDelivery,
          payload as JsonValue,
        );
        const outboxInsert = await client.query(
          `with notification_scope as (
             select household_id, space_id, original_owner_user_id
               from emdo.notifications
              where notification_id = $1
           ), database_time as (
             select pg_catalog.clock_timestamp() as now
           )
           insert into emdo.worker_operation_outbox
             (household_id, space_id, original_owner_user_id, request_id,
              job_name, operation_id, target_type, target_id, target_revision,
              payload, payload_hash, state, available_at, created_at,
              updated_at, retain_until)
           select household_id, space_id, original_owner_user_id,
                  emdo.current_request_id(), $2, $3, 'notification', $1, 1,
                  $4::jsonb, $5, 'pending', database_time.now,
                  database_time.now, database_time.now,
                  database_time.now + interval '90 days'
             from notification_scope cross join database_time
           on conflict (job_name, operation_id) do nothing
           returning outbox_id`,
          [
            notificationId.data,
            WORKER_JOB_NAMES.notificationDelivery,
            notificationOperationId,
            payload,
            payloadHash,
          ],
        );
        if (outboxInsert.rows[0]?.outbox_id === undefined) {
          const existingOutbox = firstResultRow(
            await client.query(
              `select payload_hash, target_id, target_revision
                 from emdo.worker_operation_outbox
                where job_name = $1 and operation_id = $2`,
              [WORKER_JOB_NAMES.notificationDelivery, notificationOperationId],
            ),
          );
          if (
            existingOutbox?.payload_hash !== payloadHash ||
            existingOutbox.target_id !== notificationId.data ||
            existingOutbox.target_revision !== 1
          ) {
            throw new WorkerPersistenceError(
              'conflict',
              'Notification delivery outbox binding conflicts',
            );
          }
        }
        const updated = firstResultRow(
          await client.query(
            `update emdo.scheduler_reminders
                set state = 'delivered', delivered_revision = $2,
                    delivered_at = pg_catalog.clock_timestamp(),
                    updated_at = pg_catalog.clock_timestamp()
              where reminder_id = $1 and due_revision = $2
                and state = 'scheduled'
              returning reminder_id`,
            [request.reminderId, request.dueRevision],
          ),
        );
        if (updated?.reminder_id !== request.reminderId) {
          throw new WorkerPersistenceError(
            'conflict',
            'Reminder changed before delivery commit',
          );
        }
      },
    );
  }
}

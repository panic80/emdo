import { createHash } from 'node:crypto';

import { UuidSchema, deepFreeze, type JsonValue } from '@emdo/contracts';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import {
  firstResultRow,
  parseDurablePrincipal,
  withDurableTransaction,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';
import {
  WorkerJobNameSchema,
  WorkerJobPayloadSchema,
  WorkerOperationIdSchema,
  WorkerPersistenceError,
  WorkerReferenceSchema,
  WorkerSignalSchema,
  withWorkerClient,
  type DurableWorkerJobName,
} from './scope.js';

const DispatchRequestSchema = z.strictObject({
  dispatcherId: WorkerReferenceSchema,
  now: z.date(),
  limit: z.number().int().safe().min(1).max(100),
  leaseMs: z.number().int().safe().min(1_000).max(300_000),
  signal: WorkerSignalSchema,
});
const MarkEnqueuedSchema = z.strictObject({
  outboxId: UuidSchema,
  leaseToken: UuidSchema,
  queueJobId: UuidSchema,
  enqueuedAt: z.date(),
  signal: WorkerSignalSchema,
});
const BindQueueJobSchema = z.strictObject({
  outboxId: UuidSchema,
  leaseToken: UuidSchema,
  queueJobId: UuidSchema,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
  boundAt: z.date(),
  signal: WorkerSignalSchema,
});
const MarkFailedSchema = z
  .strictObject({
    outboxId: UuidSchema,
    leaseToken: UuidSchema,
    failedAt: z.date(),
    nextAttemptAt: z.date(),
    safeCode: z.enum(['queue-unavailable', 'invalid-operation']),
    signal: WorkerSignalSchema,
  })
  .refine(
    ({ failedAt, nextAttemptAt }) =>
      nextAttemptAt.getTime() >= failedAt.getTime() &&
      nextAttemptAt.getTime() <= failedAt.getTime() + 24 * 60 * 60 * 1_000,
    { message: 'Outbox retry time is invalid' },
  );

const dateFromDatabase = (value: unknown, name: string): Date => {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new WorkerPersistenceError(
      'invalid-result',
      `Database returned an invalid ${name}`,
    );
  }
  return date;
};

export interface WorkerOutboxDispatchItem {
  readonly outboxId: string;
  /** Raw claim fields are validated and quarantined one row at a time by the dispatcher. */
  readonly jobName: string;
  readonly payload: unknown;
  readonly payloadHash: string;
  readonly startAfter: string | null;
  readonly leaseToken: string;
}

export interface WorkerOutboxListDueInput {
  readonly dispatcherId: string;
  /** Validated for caller sanity; PostgreSQL time remains authoritative. */
  readonly now: Date;
  readonly limit: number;
  readonly leaseMs: number;
  readonly signal: AbortSignal;
}

export class PostgresWorkerOutboxRepository {
  constructor(private readonly pool: DatabasePool) {}

  async listDue(
    input: WorkerOutboxListDueInput,
  ): Promise<readonly WorkerOutboxDispatchItem[]> {
    const request = DispatchRequestSchema.parse(input);
    request.signal.throwIfAborted();
    return withWorkerClient(this.pool, async (client) => {
      const result = await client.query(
        `select outbox_id, job_name, payload, payload_hash, start_after, lease_token
           from emdo.claim_due_worker_outbox($1, $2, $3)`,
        [request.dispatcherId, request.limit, request.leaseMs],
      );
      return Object.freeze(
        result.rows.map((row) => {
          const outboxId = UuidSchema.safeParse(row.outbox_id);
          const leaseToken = UuidSchema.safeParse(row.lease_token);
          if (!outboxId.success || !leaseToken.success) {
            throw new WorkerPersistenceError(
              'invalid-result',
              'Database returned a malformed outbox item',
            );
          }
          const startAfter =
            row.start_after === null || row.start_after === undefined
              ? null
              : dateFromDatabase(
                  row.start_after,
                  'outbox start time',
                ).toISOString();
          return deepFreeze({
            outboxId: outboxId.data,
            jobName: typeof row.job_name === 'string' ? row.job_name : '',
            payload: row.payload,
            payloadHash:
              typeof row.payload_hash === 'string' ? row.payload_hash : '',
            startAfter,
            leaseToken: leaseToken.data,
          });
        }),
      );
    });
  }

  async bindQueueJob(input: {
    readonly outboxId: string;
    readonly leaseToken: string;
    readonly queueJobId: string;
    readonly payloadHash: string;
    readonly boundAt: Date;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const request = BindQueueJobSchema.parse(input);
    request.signal.throwIfAborted();
    await withWorkerClient(this.pool, async (client) => {
      const row = firstResultRow(
        await client.query(
          `select emdo.bind_worker_outbox_queue_job($1, $2, $3, $4) as applied`,
          [
            request.outboxId,
            request.leaseToken,
            request.queueJobId,
            request.payloadHash,
          ],
        ),
      );
      if (row?.applied !== true) {
        throw new WorkerPersistenceError(
          'conflict',
          'Outbox queue binding is no longer current',
        );
      }
    });
  }

  async markEnqueued(input: {
    readonly outboxId: string;
    readonly leaseToken: string;
    readonly queueJobId: string;
    readonly enqueuedAt: Date;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const request = MarkEnqueuedSchema.parse(input);
    request.signal.throwIfAborted();
    await withWorkerClient(this.pool, async (client) => {
      const row = firstResultRow(
        await client.query(
          `select emdo.mark_worker_outbox_enqueued($1, $2, $3) as applied`,
          [request.outboxId, request.leaseToken, request.queueJobId],
        ),
      );
      if (row?.applied !== true) {
        throw new WorkerPersistenceError(
          'conflict',
          'Outbox lease is no longer current',
        );
      }
    });
  }

  async markDispatchFailed(input: {
    readonly outboxId: string;
    readonly leaseToken: string;
    readonly failedAt: Date;
    readonly nextAttemptAt: Date;
    readonly safeCode: 'queue-unavailable' | 'invalid-operation';
    readonly signal: AbortSignal;
  }): Promise<void> {
    const request = MarkFailedSchema.parse(input);
    request.signal.throwIfAborted();
    await withWorkerClient(this.pool, async (client) => {
      const row = firstResultRow(
        await client.query(
          `select emdo.mark_worker_outbox_failed($1, $2, $3, $4) as applied`,
          [
            request.outboxId,
            request.leaseToken,
            request.nextAttemptAt,
            request.safeCode,
          ],
        ),
      );
      if (row?.applied !== true) {
        throw new WorkerPersistenceError(
          'conflict',
          'Outbox lease is no longer current',
        );
      }
    });
  }
}

const RegistrationSchema = z.strictObject({
  outboxId: UuidSchema.optional(),
  spaceId: UuidSchema,
  jobName: WorkerJobNameSchema,
  operationId: WorkerOperationIdSchema,
  targetType: WorkerReferenceSchema,
  targetId: WorkerReferenceSchema,
  targetRevision: z.number().int().safe().nonnegative().optional(),
  relatedOperationId: WorkerOperationIdSchema.optional(),
  retrySequence: z.number().int().safe().min(1).max(20).optional(),
  payload: z.custom<JsonValue>(),
  availableAt: z.iso.datetime({ offset: true }),
});

const canonicalizeJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalizeJson(value[key] as JsonValue)}`,
    )
    .join(',')}}`;
};

const expectedBindingForPayload = (
  binding: z.output<typeof WorkerJobPayloadSchema>,
): Readonly<{
  targetType: string;
  targetId: string;
  targetRevision?: number;
  relatedOperationId?: string;
  retrySequence?: number;
}> => {
  switch (binding.jobName) {
    case 'emdo.reminder.delivery.v1': {
      const payload = binding.payload as {
        readonly reminderId: string;
        readonly dueRevision: number;
      };
      return {
        targetType: 'reminder',
        targetId: payload.reminderId,
        targetRevision: payload.dueRevision,
      };
    }
    case 'emdo.calendar.sync.v1': {
      const payload = binding.payload as {
        readonly connectionId: string;
        readonly syncGeneration: number;
      };
      return {
        targetType: 'calendar-connection',
        targetId: payload.connectionId,
        targetRevision: payload.syncGeneration,
      };
    }
    case 'emdo.calendar.retry.v1': {
      const payload = binding.payload as {
        readonly connectionId: string;
        readonly failedOperationId: string;
        readonly retrySequence: number;
      };
      return {
        targetType: 'calendar-connection',
        targetId: payload.connectionId,
        relatedOperationId: payload.failedOperationId,
        retrySequence: payload.retrySequence,
      };
    }
    case 'emdo.calendar.reconciliation.v1': {
      const payload = binding.payload as {
        readonly providerAttemptId: string;
      };
      return {
        targetType: 'provider-attempt',
        targetId: payload.providerAttemptId,
      };
    }
    case 'emdo.notification.delivery.v1': {
      const payload = binding.payload as {
        readonly notificationId: string;
      };
      return {
        targetType: 'notification',
        targetId: payload.notificationId,
      };
    }
    case 'emdo.invitation.delivery.v1': {
      const payload = binding.payload as {
        readonly invitationId: string;
      };
      return {
        targetType: 'invitation',
        targetId: payload.invitationId,
        targetRevision: 1,
      };
    }
  }
  throw new WorkerPersistenceError(
    'invalid-input',
    'Worker outbox payload has an unsupported job name',
  );
};

/** Matches apps/worker hashWorkerJobPayload without importing the worker. */
export const hashDurableWorkerJobPayload = (
  jobNameInput: DurableWorkerJobName,
  payloadInput: JsonValue,
): string => {
  const parsed = WorkerJobPayloadSchema.parse({
    jobName: jobNameInput,
    payload: payloadInput,
  });
  return createHash('sha256')
    .update(
      `${parsed.jobName}\0${canonicalizeJson(parsed.payload as JsonValue)}`,
      'utf8',
    )
    .digest('hex');
};

/** Application-side writer for canonical background operations. */
export class PostgresWorkerOperationOutboxWriter {
  readonly #principal: Readonly<DurableRepositoryPrincipal>;

  constructor(
    private readonly pool: DatabasePool,
    principal: DurableRepositoryPrincipal,
  ) {
    this.#principal = parseDurablePrincipal(principal);
  }

  async register(input: z.input<typeof RegistrationSchema>): Promise<{
    readonly status: 'created' | 'duplicate';
    readonly outboxId: string;
  }> {
    const request = RegistrationSchema.parse(input);
    const parsedPayload = WorkerJobPayloadSchema.safeParse({
      jobName: request.jobName,
      payload: request.payload,
    });
    if (
      !parsedPayload.success ||
      parsedPayload.data.payload.operationId !== request.operationId
    ) {
      throw new WorkerPersistenceError(
        'invalid-input',
        'Worker outbox payload does not match its operation binding',
      );
    }
    const expectedBinding = expectedBindingForPayload(parsedPayload.data);
    if (
      request.targetType !== expectedBinding.targetType ||
      request.targetId !== expectedBinding.targetId ||
      request.targetRevision !== expectedBinding.targetRevision ||
      request.relatedOperationId !== expectedBinding.relatedOperationId ||
      request.retrySequence !== expectedBinding.retrySequence
    ) {
      throw new WorkerPersistenceError(
        'invalid-input',
        'Worker outbox target binding does not match its typed payload',
      );
    }
    const payloadHash = hashDurableWorkerJobPayload(
      request.jobName,
      parsedPayload.data.payload as JsonValue,
    );
    return withDurableTransaction(
      this.pool,
      this.#principal,
      {
        householdId: this.#principal.householdId,
        spaceId: request.spaceId,
      },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `with target_space as (
               select household_id, id, emdo.current_user_id() as owner_user_id
                 from emdo.spaces
                where id = $1 and household_id = $2 and tombstoned_at is null
             ), database_time as (
               select pg_catalog.clock_timestamp() as now
             )
             insert into emdo.worker_operation_outbox
               (outbox_id, household_id, space_id, original_owner_user_id,
                request_id, job_name, operation_id, target_type, target_id,
                target_revision, related_operation_id, retry_sequence, payload,
                payload_hash, state, available_at, created_at, updated_at,
                retain_until)
             select coalesce($3, pg_catalog.gen_random_uuid()), household_id, id,
                    owner_user_id, emdo.current_request_id(), $4, $5, $6, $7,
                    $8, $9, $10, $11::jsonb, $12, 'pending', $13,
                    database_time.now, database_time.now,
                    database_time.now + interval '90 days'
               from target_space cross join database_time
             on conflict (job_name, operation_id) do nothing
             returning outbox_id`,
            [
              request.spaceId,
              this.#principal.householdId,
              request.outboxId ?? null,
              request.jobName,
              request.operationId,
              request.targetType,
              request.targetId,
              request.targetRevision ?? null,
              request.relatedOperationId ?? null,
              request.retrySequence ?? null,
              parsedPayload.data.payload,
              payloadHash,
              new Date(request.availableAt),
            ],
          ),
        );
        if (row?.outbox_id !== undefined) {
          return deepFreeze({
            status: 'created' as const,
            outboxId: UuidSchema.parse(row.outbox_id),
          });
        }
        const existing = firstResultRow(
          await client.query(
            `select outbox_id, payload_hash, target_type, target_id, target_revision,
                    related_operation_id, retry_sequence, available_at
               from emdo.worker_operation_outbox
              where job_name = $1 and operation_id = $2`,
            [request.jobName, request.operationId],
          ),
        );
        if (
          existing === undefined ||
          existing.payload_hash !== payloadHash ||
          existing.target_type !== request.targetType ||
          existing.target_id !== request.targetId ||
          existing.target_revision !== (request.targetRevision ?? null) ||
          existing.related_operation_id !==
            (request.relatedOperationId ?? null) ||
          existing.retry_sequence !== (request.retrySequence ?? null) ||
          new Date(String(existing.available_at)).getTime() !==
            new Date(request.availableAt).getTime()
        ) {
          throw new WorkerPersistenceError(
            'conflict',
            'Worker operation idempotency binding conflicts',
          );
        }
        return deepFreeze({
          status: 'duplicate' as const,
          outboxId: UuidSchema.parse(existing.outbox_id),
        });
      },
    );
  }
}

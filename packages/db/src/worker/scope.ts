import {
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
} from '@emdo/contracts';
import { z } from 'zod';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import { firstResultRow } from '../durable/scoped-transaction.js';

export const WORKER_JOB_NAMES = deepFreeze({
  reminderDelivery: 'emdo.reminder.delivery.v1',
  calendarSync: 'emdo.calendar.sync.v1',
  calendarRetry: 'emdo.calendar.retry.v1',
  calendarReconciliation: 'emdo.calendar.reconciliation.v1',
  notificationDelivery: 'emdo.notification.delivery.v1',
  invitationDelivery: 'emdo.invitation.delivery.v1',
});

export type DurableWorkerJobName =
  (typeof WORKER_JOB_NAMES)[keyof typeof WORKER_JOB_NAMES];

export const WorkerJobNameSchema = z.enum([
  WORKER_JOB_NAMES.reminderDelivery,
  WORKER_JOB_NAMES.calendarSync,
  WORKER_JOB_NAMES.calendarRetry,
  WORKER_JOB_NAMES.calendarReconciliation,
  WORKER_JOB_NAMES.notificationDelivery,
  WORKER_JOB_NAMES.invitationDelivery,
]);
export const WorkerReferenceSchema = OpaqueReferenceSchema;
export const WorkerOperationIdSchema = IdempotencyKeySchema;
export const WorkerSignalSchema = z.custom<AbortSignal>(
  (value) => value instanceof AbortSignal,
  'Expected an AbortSignal',
);

export const DurableWorkerExecutionPermitSchema = z.strictObject({
  jobName: WorkerJobNameSchema,
  operationId: WorkerOperationIdSchema,
  queueJobId: UuidSchema,
  payloadHash: Sha256Schema,
  leaseToken: UuidSchema,
  leaseExpiresAt: IsoDateTimeSchema,
});

export type DurableWorkerExecutionPermit = z.output<
  typeof DurableWorkerExecutionPermitSchema
>;

export const DurableWorkerExecutionContextSchema = z.strictObject({
  execution: DurableWorkerExecutionPermitSchema,
  signal: WorkerSignalSchema,
});

export interface DurableWorkerExecutionContext {
  readonly execution: DurableWorkerExecutionPermit;
  readonly signal: AbortSignal;
}

export const parseDurableWorkerExecutionContext = (
  input: DurableWorkerExecutionContext,
  expected: {
    readonly jobName: DurableWorkerJobName;
    readonly operationId: string;
  },
): DurableWorkerExecutionContext => {
  const context = DurableWorkerExecutionContextSchema.safeParse(input);
  const operationId = WorkerOperationIdSchema.safeParse(expected.operationId);
  if (
    !context.success ||
    !operationId.success ||
    context.data.execution.jobName !== expected.jobName ||
    context.data.execution.operationId !== operationId.data
  ) {
    throw new WorkerPersistenceError(
      'invalid-input',
      'Worker execution context does not match the domain operation',
    );
  }
  context.data.signal.throwIfAborted();
  return Object.freeze({
    execution: deepFreeze(context.data.execution),
    signal: context.data.signal,
  });
};

const CommonPayload = {
  schemaVersion: z.literal(1),
  origin: z.literal('deterministic-worker'),
  operationId: WorkerOperationIdSchema,
} as const;

export const WorkerJobPayloadSchema = z.discriminatedUnion('jobName', [
  z.strictObject({
    jobName: z.literal(WORKER_JOB_NAMES.reminderDelivery),
    payload: z.strictObject({
      ...CommonPayload,
      reminderId: WorkerReferenceSchema,
      dueRevision: z.number().int().safe().positive(),
    }),
  }),
  z.strictObject({
    jobName: z.literal(WORKER_JOB_NAMES.calendarSync),
    payload: z.strictObject({
      ...CommonPayload,
      connectionId: WorkerReferenceSchema,
      syncGeneration: z.number().int().safe().nonnegative(),
    }),
  }),
  z.strictObject({
    jobName: z.literal(WORKER_JOB_NAMES.calendarRetry),
    payload: z.strictObject({
      ...CommonPayload,
      failedOperationId: WorkerOperationIdSchema,
      connectionId: WorkerReferenceSchema,
      retrySequence: z.number().int().safe().min(1).max(20),
    }),
  }),
  z.strictObject({
    jobName: z.literal(WORKER_JOB_NAMES.calendarReconciliation),
    payload: z.strictObject({
      ...CommonPayload,
      providerAttemptId: UuidSchema,
    }),
  }),
  z.strictObject({
    jobName: z.literal(WORKER_JOB_NAMES.notificationDelivery),
    payload: z.strictObject({
      ...CommonPayload,
      notificationId: WorkerReferenceSchema,
    }),
  }),
  z.strictObject({
    jobName: z.literal(WORKER_JOB_NAMES.invitationDelivery),
    payload: z.strictObject({
      ...CommonPayload,
      invitationId: UuidSchema,
      deliverySecretId: UuidSchema,
    }),
  }),
]);

export type DurableWorkerJobPayload = z.output<
  typeof WorkerJobPayloadSchema
>['payload'];

export class WorkerPersistenceError extends Error {
  constructor(
    readonly code:
      | 'operation-unavailable'
      | 'attempt-exhausted'
      | 'conflict'
      | 'invalid-input'
      | 'invalid-result',
    message: string,
  ) {
    super(message);
    this.name = 'WorkerPersistenceError';
  }
}

const rollbackQuietly = async (client: DatabaseClient): Promise<void> => {
  try {
    await client.query('rollback');
  } catch {
    // Preserve the original boundary failure.
  }
};

export const withWorkerOperationTransaction = async <Result>(
  pool: DatabasePool,
  input: {
    readonly execution: DurableWorkerExecutionPermit;
    readonly targetType?: string;
    readonly targetId?: string;
    readonly targetRevision?: number;
    readonly relatedOperationId?: string;
    readonly retrySequence?: number;
  },
  work: (client: DatabaseClient) => Promise<Result>,
): Promise<Result> => {
  const parsed = z
    .strictObject({
      execution: DurableWorkerExecutionPermitSchema,
      targetType: WorkerReferenceSchema.optional(),
      targetId: WorkerReferenceSchema.optional(),
      targetRevision: z.number().int().safe().nonnegative().optional(),
      relatedOperationId: WorkerOperationIdSchema.optional(),
      retrySequence: z.number().int().safe().min(1).max(20).optional(),
    })
    .parse(input);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '5s'");
    await client.query('set local row_security = on');
    const row = firstResultRow(
      await client.query(
        `select emdo.claim_worker_operation_scope(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
         ) as authorized`,
        [
          parsed.execution.jobName,
          parsed.execution.operationId,
          parsed.execution.queueJobId,
          parsed.execution.payloadHash,
          parsed.execution.leaseToken,
          parsed.targetType ?? null,
          parsed.targetId ?? null,
          parsed.targetRevision ?? null,
          parsed.relatedOperationId ?? null,
          parsed.retrySequence ?? null,
        ],
      ),
    );
    if (row?.authorized !== true) {
      throw new WorkerPersistenceError(
        'operation-unavailable',
        'The canonical worker operation is unavailable',
      );
    }
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
};

export const withWorkerClient = async <Result>(
  pool: DatabasePool,
  work: (client: DatabaseClient) => Promise<Result>,
): Promise<Result> => {
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
};

/** Transaction boundary for executor functions that establish their own lease. */
export const withWorkerTransaction = async <Result>(
  pool: DatabasePool,
  signal: AbortSignal,
  work: (client: DatabaseClient) => Promise<Result>,
): Promise<Result> => {
  WorkerSignalSchema.parse(signal).throwIfAborted();
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '5s'");
    await client.query('set local row_security = on');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
};

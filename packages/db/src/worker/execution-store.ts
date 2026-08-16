import { UuidSchema, deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import { firstResultRow } from '../durable/scoped-transaction.js';
import {
  DurableWorkerExecutionPermitSchema,
  WorkerJobNameSchema,
  WorkerOperationIdSchema,
  WorkerPersistenceError,
  WorkerReferenceSchema,
  WorkerSignalSchema,
  withWorkerTransaction,
  type DurableWorkerJobName,
  type DurableWorkerExecutionPermit,
} from './scope.js';

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ExecutionInputSchema = z.strictObject({
  jobId: WorkerReferenceSchema,
  jobName: WorkerJobNameSchema,
  operationId: WorkerOperationIdSchema,
  payloadHash: HashSchema,
  signal: WorkerSignalSchema,
});

export interface DurableJobExecutionInput {
  readonly jobId: string;
  readonly jobName: DurableWorkerJobName;
  readonly operationId: string;
  readonly payloadHash: string;
  readonly signal: AbortSignal;
}

export type DurableJobExecutionResult = Readonly<{
  status: 'executed' | 'duplicate';
}>;

const AcquisitionRowSchema = z
  .strictObject({
    status: z.enum(['acquired', 'duplicate', 'exhausted']),
    job_name: WorkerJobNameSchema,
    operation_id: WorkerOperationIdSchema,
    queue_job_id: UuidSchema,
    payload_hash: HashSchema,
    lease_token: UuidSchema.nullable(),
    lease_expires_at: z.coerce.date().nullable(),
  })
  .superRefine((value, context) => {
    if (
      value.status === 'acquired' &&
      (value.lease_token === null || value.lease_expires_at === null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['lease_token'],
        message: 'An acquired worker execution requires a lease',
      });
    }
  });

export class PostgresDeterministicJobExecutionStore {
  constructor(private readonly pool: DatabasePool) {}

  async executeOnce(
    input: DurableJobExecutionInput,
    operation: (permit: DurableWorkerExecutionPermit) => Promise<void>,
  ): Promise<DurableJobExecutionResult> {
    const request = ExecutionInputSchema.parse(input);
    request.signal.throwIfAborted();

    const acquisition = await withWorkerTransaction(
      this.pool,
      request.signal,
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select status, job_name, operation_id, queue_job_id, payload_hash,
                    lease_token, lease_expires_at
               from emdo.acquire_worker_job_execution($1, $2, $3, $4)`,
            [
              request.jobName,
              request.operationId,
              request.jobId,
              request.payloadHash,
            ],
          ),
        );
        const parsed = AcquisitionRowSchema.safeParse(row);
        if (
          !parsed.success ||
          parsed.data.job_name !== request.jobName ||
          parsed.data.operation_id !== request.operationId ||
          parsed.data.queue_job_id !== request.jobId ||
          parsed.data.payload_hash !== request.payloadHash
        ) {
          throw new WorkerPersistenceError(
            'operation-unavailable',
            'Worker execution could not acquire its canonical queue binding',
          );
        }
        return parsed.data;
      },
    );

    if (acquisition.status === 'duplicate') {
      return deepFreeze({ status: 'duplicate' as const });
    }
    if (acquisition.status === 'exhausted') {
      throw new WorkerPersistenceError(
        'attempt-exhausted',
        'Worker operation retry limit is exhausted',
      );
    }
    if (
      acquisition.lease_token === null ||
      acquisition.lease_expires_at === null
    ) {
      throw new WorkerPersistenceError(
        'invalid-result',
        'Worker execution lease is unavailable after acquisition',
      );
    }
    const permit = DurableWorkerExecutionPermitSchema.parse({
      jobName: acquisition.job_name,
      operationId: acquisition.operation_id,
      queueJobId: acquisition.queue_job_id,
      payloadHash: acquisition.payload_hash,
      leaseToken: acquisition.lease_token,
      leaseExpiresAt: acquisition.lease_expires_at.toISOString(),
    });

    let callbackSucceeded = false;
    try {
      request.signal.throwIfAborted();
      await operation(deepFreeze(permit));
      callbackSucceeded = true;
    } catch {
      callbackSucceeded = false;
    }

    let completionStatus: 'applied' | 'exhausted';
    try {
      completionStatus = await withWorkerTransaction(
        this.pool,
        AbortSignal.timeout(5_000),
        async (client) => {
          const completed = firstResultRow(
            await client.query(
              `select emdo.complete_worker_job_execution(
                 $1, $2, $3, $4, $5, $6
               ) as completion_status`,
              [
                request.jobName,
                request.operationId,
                request.jobId,
                request.payloadHash,
                permit.leaseToken,
                callbackSucceeded ? 'completed' : 'failed',
              ],
            ),
          );
          if (
            completed?.completion_status !== 'applied' &&
            completed?.completion_status !== 'exhausted'
          ) {
            throw new WorkerPersistenceError(
              'conflict',
              'Worker execution completion claim is no longer current',
            );
          }
          return completed.completion_status;
        },
      );
    } catch {
      throw new Error('Worker execution persistence failed');
    }

    if (completionStatus === 'exhausted') {
      throw new WorkerPersistenceError(
        'attempt-exhausted',
        'Worker operation retry limit is exhausted',
      );
    }

    if (!callbackSucceeded) {
      throw new Error('Worker operation failed');
    }
    return deepFreeze({ status: 'executed' as const });
  }
}

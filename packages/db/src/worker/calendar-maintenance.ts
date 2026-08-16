import { createHash } from 'node:crypto';

import {
  ProviderWriteAuthorizationSchema,
  UuidSchema,
  deepFreeze,
  type JsonValue,
  type ProviderWriteApprovalBinding,
} from '@emdo/contracts';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import { firstResultRow } from '../durable/scoped-transaction.js';
import { hashDurableWorkerJobPayload } from './outbox.js';
import {
  WORKER_JOB_NAMES,
  WorkerOperationIdSchema,
  WorkerPersistenceError,
  WorkerReferenceSchema,
  parseDurableWorkerExecutionContext,
  withWorkerOperationTransaction,
  type DurableWorkerExecutionContext,
  type DurableWorkerExecutionPermit,
  type DurableWorkerJobName,
} from './scope.js';

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const SyncInputSchema = z.strictObject({
  operationId: WorkerOperationIdSchema,
  connectionId: WorkerReferenceSchema,
  syncGeneration: z.number().int().safe().nonnegative(),
});
const RetryInputSchema = z.strictObject({
  operationId: WorkerOperationIdSchema,
  failedOperationId: WorkerOperationIdSchema,
  connectionId: WorkerReferenceSchema,
  retrySequence: z.number().int().safe().min(1).max(20),
});
const ReconcileInputSchema = z.strictObject({
  operationId: WorkerOperationIdSchema,
  providerAttemptId: UuidSchema,
});
const SyncGatewayResultSchema = z.strictObject({
  status: z.enum(['current', 'advanced']),
  sealedCursor: z.string().min(1).max(64_000).nullable(),
  providerVersion: z.string().trim().min(1).max(512),
  evidenceHash: HashSchema,
});
const IndeterminateCompletionSchema = z.strictObject({
  state: z.literal('indeterminate'),
  application: z.literal('indeterminate'),
  reason: z.enum([
    'timeout-after-dispatch',
    'transport-lost-after-dispatch',
    'executor-threw-after-dispatch-boundary',
    'provider-outcome-envelope-invalid',
  ]),
  reconciliationRequired: z.literal(true),
  evidenceHash: HashSchema.optional(),
});
const ReadbackResultSchema = z
  .union([
    z.strictObject({
      state: z.literal('executed'),
      application: z.literal('applied'),
      outputStatus: z.literal('valid'),
      resultHash: HashSchema,
      evidenceHash: HashSchema.optional(),
    }),
    z.strictObject({
      state: z.literal('executed'),
      application: z.literal('applied'),
      outputStatus: z.literal('invalid'),
      safeErrorCode: z.literal('provider-write-output-invalid'),
      evidenceHash: HashSchema.optional(),
    }),
    z.strictObject({
      state: z.literal('not-applied'),
      application: z.literal('not-applied'),
      reason: z.enum([
        'approval-expired-before-dispatch',
        'approval-policy-mismatch',
        'provider-precondition-failed',
        'provider-rejected-before-apply',
      ]),
      evidenceHash: HashSchema.optional(),
    }),
    IndeterminateCompletionSchema,
  ])
  .transform(deepFreeze);
const ReconciliationPreflightRowSchema = z.strictObject({
  id: UuidSchema,
  attempt_state: z.literal('indeterminate'),
  authorization: ProviderWriteAuthorizationSchema,
  outcome_application: z.literal('indeterminate'),
  outcome_completion: IndeterminateCompletionSchema,
});

export type CalendarProviderWriteCompletion = z.output<
  typeof ReadbackResultSchema
>;

/**
 * Exact durable lease proof for an API-owned internal Calendar broker. The
 * broker must independently authenticate the worker caller and must never
 * forward any of these fields to Google.
 */
export type CalendarBrokerJobAuthority = DurableWorkerExecutionPermit;

export interface CalendarBrokerConnectionAuthority {
  readonly providerId: 'google-calendar';
  readonly connectionId: string;
  readonly householdId: string;
  readonly spaceId: string;
  readonly originalOwnerUserId: string;
  readonly syncGeneration: number;
  readonly sealedCursor: string | null;
}

export interface CalendarBrokerAttemptAuthority {
  readonly providerId: 'google-calendar';
  readonly providerAttemptId: string;
  readonly decisionId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly capabilityId: string;
  readonly capabilityFingerprint: string;
  readonly payloadHash: string;
  readonly householdId: string;
  readonly spaceId: string;
  /** Opaque, non-secret reference only. A broker must resolve it canonically. */
  readonly connectionId: string;
  readonly authorizationEpoch: number;
}

export interface CalendarMaintenanceReadGateway {
  /**
   * API-owned, service-authenticated provider sync only. It must re-load and
   * compare the canonical binding, return no credential material, and never
   * apply a Calendar mutation.
   */
  synchronize(input: {
    readonly jobAuthority: CalendarBrokerJobAuthority;
    readonly connectionAuthority: CalendarBrokerConnectionAuthority;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  /**
   * API-owned, service-authenticated provider readback only. It must re-load
   * and compare the canonical attempt and connection binding, return no
   * credential material, and never replay the original write.
   */
  readBackAttempt(input: {
    readonly jobAuthority: CalendarBrokerJobAuthority;
    readonly attemptAuthority: CalendarBrokerAttemptAuthority;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export interface CalendarProviderAttemptReconciler {
  reconcile(input: {
    readonly providerAttemptId: string;
    readonly approvalBinding: ProviderWriteApprovalBinding;
    readonly completion: CalendarProviderWriteCompletion;
    readonly execution: DurableWorkerExecutionPermit;
  }): Promise<'finalized' | 'already-finalized' | 'not-found' | 'mismatch'>;
}

type GatewayMethod = (...arguments_: never[]) => Promise<unknown>;

const captureGatewayMethod = (
  gateway: CalendarMaintenanceReadGateway,
  name: 'synchronize' | 'readBackAttempt',
): GatewayMethod => {
  let cursor: object | null = gateway;
  while (cursor !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
    if (descriptor !== undefined) {
      if (
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        typeof descriptor.value !== 'function'
      ) {
        break;
      }
      return descriptor.value.bind(gateway) as GatewayMethod;
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  throw new Error('Calendar maintenance gateway boundary is invalid');
};

const captureReconcilerMethod = (
  reconciler: CalendarProviderAttemptReconciler,
): CalendarProviderAttemptReconciler['reconcile'] => {
  let cursor: object | null = reconciler;
  while (cursor !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, 'reconcile');
    if (descriptor !== undefined) {
      if (
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        typeof descriptor.value !== 'function'
      ) {
        break;
      }
      return descriptor.value.bind(
        reconciler,
      ) as CalendarProviderAttemptReconciler['reconcile'];
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  throw new Error('Calendar provider attempt reconciler boundary is invalid');
};

interface SyncState {
  readonly providerId: 'google-calendar';
  readonly householdId: string;
  readonly spaceId: string;
  readonly originalOwnerUserId: string;
  readonly generation: number;
  readonly sealedCursor: string | null;
  readonly retrySequence: number;
}

const parseSyncState = (row: Record<string, unknown>): SyncState => {
  const parsed = z
    .strictObject({
      provider_id: z.literal('google-calendar'),
      household_id: UuidSchema,
      space_id: UuidSchema,
      original_owner_user_id: UuidSchema,
      sync_generation: z.number().int().safe().nonnegative(),
      sealed_cursor: z.string().min(1).max(64_000).nullable(),
      state: z.enum(['ready', 'syncing', 'retry-pending']),
      retry_sequence: z.number().int().safe().min(0).max(20),
    })
    .safeParse(row);
  if (!parsed.success) {
    throw new WorkerPersistenceError(
      'invalid-result',
      'Calendar sync state is malformed',
    );
  }
  return deepFreeze({
    providerId: parsed.data.provider_id,
    householdId: parsed.data.household_id,
    spaceId: parsed.data.space_id,
    originalOwnerUserId: parsed.data.original_owner_user_id,
    generation: parsed.data.sync_generation,
    sealedCursor: parsed.data.sealed_cursor,
    retrySequence: parsed.data.retry_sequence,
  });
};

const retryOperationId = (
  failedOperationId: string,
  retrySequence: number,
): string =>
  `calendar-retry:${createHash('sha256')
    .update(`${failedOperationId}\0${retrySequence}`, 'utf8')
    .digest('hex')}`;

export class PostgresCalendarMaintenanceService {
  readonly #synchronizeProvider: CalendarMaintenanceReadGateway['synchronize'];
  readonly #readBackProviderAttempt: CalendarMaintenanceReadGateway['readBackAttempt'];
  readonly #reconcileProviderAttempt: CalendarProviderAttemptReconciler['reconcile'];

  constructor(
    private readonly pool: DatabasePool,
    gateway: CalendarMaintenanceReadGateway,
    reconciler: CalendarProviderAttemptReconciler,
  ) {
    this.#synchronizeProvider = captureGatewayMethod(
      gateway,
      'synchronize',
    ) as CalendarMaintenanceReadGateway['synchronize'];
    this.#readBackProviderAttempt = captureGatewayMethod(
      gateway,
      'readBackAttempt',
    ) as CalendarMaintenanceReadGateway['readBackAttempt'];
    this.#reconcileProviderAttempt = captureReconcilerMethod(reconciler);
  }

  async synchronize(
    input: z.input<typeof SyncInputSchema>,
    context: DurableWorkerExecutionContext,
  ): Promise<void> {
    const request = SyncInputSchema.parse(input);
    const executionContext = parseDurableWorkerExecutionContext(context, {
      jobName: WORKER_JOB_NAMES.calendarSync,
      operationId: request.operationId,
    });
    await this.#runSynchronization({
      jobName: WORKER_JOB_NAMES.calendarSync,
      kind: 'sync',
      operationId: request.operationId,
      connectionId: request.connectionId,
      expectedGeneration: request.syncGeneration,
      execution: executionContext.execution,
      signal: executionContext.signal,
    });
  }

  async retrySynchronization(
    input: z.input<typeof RetryInputSchema>,
    context: DurableWorkerExecutionContext,
  ): Promise<void> {
    const request = RetryInputSchema.parse(input);
    const executionContext = parseDurableWorkerExecutionContext(context, {
      jobName: WORKER_JOB_NAMES.calendarRetry,
      operationId: request.operationId,
    });
    await this.#runSynchronization({
      jobName: WORKER_JOB_NAMES.calendarRetry,
      kind: 'retry',
      operationId: request.operationId,
      connectionId: request.connectionId,
      failedOperationId: request.failedOperationId,
      retrySequence: request.retrySequence,
      execution: executionContext.execution,
      signal: executionContext.signal,
    });
  }

  async reconcileProviderAttempt(
    input: z.input<typeof ReconcileInputSchema>,
    context: DurableWorkerExecutionContext,
  ): Promise<void> {
    const request = ReconcileInputSchema.parse(input);
    const executionContext = parseDurableWorkerExecutionContext(context, {
      jobName: WORKER_JOB_NAMES.calendarReconciliation,
      operationId: request.operationId,
    });
    const approvalBinding = await withWorkerOperationTransaction(
      this.pool,
      {
        execution: executionContext.execution,
        targetType: 'provider-attempt',
        targetId: request.providerAttemptId,
      },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select attempt.id::text as id, attempt.attempt_state,
                    attempt.authorization,
                    outcome.application as outcome_application,
                    outcome.completion as outcome_completion
               from emdo.provider_attempts attempt
               join emdo.provider_outcomes outcome on outcome.attempt_id = attempt.id
              where attempt.id = $1::uuid
                and attempt.attempt_state = 'indeterminate'
                and outcome.application = 'indeterminate'
              for key share of attempt, outcome`,
            [request.providerAttemptId],
          ),
        );
        if (row === undefined) {
          throw new WorkerPersistenceError(
            'operation-unavailable',
            'Provider attempt is unavailable for readback',
          );
        }
        const preflight = ReconciliationPreflightRowSchema.safeParse(row);
        if (
          !preflight.success ||
          preflight.data.id !== request.providerAttemptId ||
          preflight.data.authorization.attemptId !== request.providerAttemptId
        ) {
          throw new WorkerPersistenceError(
            'invalid-result',
            'Provider attempt authorization is malformed',
          );
        }
        return preflight.data.authorization.approvalBinding;
      },
    );

    let rawReadback: unknown;
    try {
      const attemptAuthority = deepFreeze({
        providerId: 'google-calendar' as const,
        providerAttemptId: request.providerAttemptId,
        decisionId: approvalBinding.decisionId,
        userId: approvalBinding.userId,
        agentId: approvalBinding.agentId,
        runId: approvalBinding.runId,
        capabilityId: approvalBinding.capabilityId,
        capabilityFingerprint: approvalBinding.capabilityFingerprint,
        payloadHash: approvalBinding.payloadHash,
        householdId: approvalBinding.authorityBinding.householdId,
        spaceId: approvalBinding.authorityBinding.privateSpaceId,
        connectionId: approvalBinding.authorityBinding.providerGrantReference,
        authorizationEpoch: approvalBinding.authorityBinding.authorizationEpoch,
      }) satisfies CalendarBrokerAttemptAuthority;
      rawReadback = await this.#readBackProviderAttempt(
        Object.freeze({
          jobAuthority: executionContext.execution,
          attemptAuthority,
          signal: executionContext.signal,
        }),
      );
    } catch {
      rawReadback = null;
    }
    const readback = ReadbackResultSchema.safeParse(rawReadback);
    if (!readback.success) {
      await this.#recordReconciliationIndeterminate(request, executionContext);
      return;
    }
    executionContext.signal.throwIfAborted();
    const reconciliationStatus = await this.#reconcileProviderAttempt({
      providerAttemptId: request.providerAttemptId,
      approvalBinding,
      completion: readback.data,
      execution: executionContext.execution,
    });
    if (
      reconciliationStatus !== 'finalized' &&
      reconciliationStatus !== 'already-finalized'
    ) {
      await this.#recordReconciliationIndeterminate(request, executionContext);
      return;
    }

    await withWorkerOperationTransaction(
      this.pool,
      {
        execution: executionContext.execution,
        targetType: 'provider-attempt',
        targetId: request.providerAttemptId,
      },
      async (client) =>
        this.#insertReceipt(client, {
          operationId: request.operationId,
          kind: 'reconciliation',
          targetId: request.providerAttemptId,
          status: 'completed',
          ...('resultHash' in readback.data
            ? { resultHash: readback.data.resultHash }
            : {}),
          ...(readback.data.evidenceHash === undefined
            ? {}
            : { evidenceHash: readback.data.evidenceHash }),
        }),
    );
  }

  async #runSynchronization(input: {
    readonly jobName: DurableWorkerJobName;
    readonly kind: 'sync' | 'retry';
    readonly operationId: string;
    readonly connectionId: string;
    readonly expectedGeneration?: number;
    readonly failedOperationId?: string;
    readonly retrySequence?: number;
    readonly execution: DurableWorkerExecutionPermit;
    readonly signal: AbortSignal;
  }): Promise<void> {
    input.signal.throwIfAborted();
    const binding = {
      execution: input.execution,
      targetType: 'calendar-connection',
      targetId: input.connectionId,
      ...(input.expectedGeneration === undefined
        ? {}
        : { targetRevision: input.expectedGeneration }),
      ...(input.failedOperationId === undefined
        ? {}
        : { relatedOperationId: input.failedOperationId }),
      ...(input.retrySequence === undefined
        ? {}
        : { retrySequence: input.retrySequence }),
    } as const;
    const state = await withWorkerOperationTransaction(
      this.pool,
      binding,
      async (client) => {
        await client.query(
          `select pg_catalog.pg_advisory_xact_lock(
             pg_catalog.hashtextextended($1, 0)
           )`,
          [input.connectionId],
        );
        const row = firstResultRow(
          await client.query(
            `select provider_id, household_id::text as household_id,
                    space_id::text as space_id,
                    original_owner_user_id::text as original_owner_user_id,
                    sync_generation, sealed_cursor, state, retry_sequence
               from emdo.calendar_sync_states
              where connection_id = $1 and disconnected_at is null
              for update`,
            [input.connectionId],
          ),
        );
        if (row === undefined) {
          throw new WorkerPersistenceError(
            'operation-unavailable',
            'Calendar connection is unavailable for synchronization',
          );
        }
        const parsed = parseSyncState(row);
        if (
          (input.expectedGeneration !== undefined &&
            parsed.generation !== input.expectedGeneration) ||
          (input.retrySequence !== undefined &&
            parsed.retrySequence !== input.retrySequence)
        ) {
          throw new WorkerPersistenceError(
            'conflict',
            'Calendar synchronization generation changed',
          );
        }
        return parsed;
      },
    );

    let rawResult: unknown;
    try {
      const connectionAuthority = deepFreeze({
        providerId: state.providerId,
        connectionId: input.connectionId,
        householdId: state.householdId,
        spaceId: state.spaceId,
        originalOwnerUserId: state.originalOwnerUserId,
        syncGeneration: state.generation,
        sealedCursor: state.sealedCursor,
      }) satisfies CalendarBrokerConnectionAuthority;
      rawResult = await this.#synchronizeProvider(
        Object.freeze({
          jobAuthority: input.execution,
          connectionAuthority,
          signal: input.signal,
        }),
      );
    } catch {
      rawResult = null;
    }
    const result = SyncGatewayResultSchema.safeParse(rawResult);
    if (!result.success) {
      await this.#recordSyncFailure(input, state);
      return;
    }

    await withWorkerOperationTransaction(this.pool, binding, async (client) => {
      const updated = firstResultRow(
        await client.query(
          `update emdo.calendar_sync_states
                set sync_generation = sync_generation + 1,
                    sealed_cursor = $3, provider_version = $4,
                    state = 'ready', retry_sequence = 0,
                    last_safe_code = null, last_evidence_hash = $5,
                    last_synced_at = pg_catalog.clock_timestamp(),
                    updated_at = pg_catalog.clock_timestamp()
              where connection_id = $1 and sync_generation = $2
                and disconnected_at is null
              returning connection_id`,
          [
            input.connectionId,
            state.generation,
            result.data.sealedCursor,
            result.data.providerVersion,
            result.data.evidenceHash,
          ],
        ),
      );
      if (updated?.connection_id !== input.connectionId) {
        throw new WorkerPersistenceError(
          'conflict',
          'Calendar synchronization generation changed before commit',
        );
      }
      await this.#insertReceipt(client, {
        operationId: input.operationId,
        kind: input.kind,
        targetId: input.connectionId,
        relatedOperationId: input.failedOperationId,
        retrySequence: input.retrySequence,
        status: 'completed',
        providerVersion: result.data.providerVersion,
        evidenceHash: result.data.evidenceHash,
      });
    });
  }

  async #recordSyncFailure(
    input: {
      readonly jobName: DurableWorkerJobName;
      readonly kind: 'sync' | 'retry';
      readonly operationId: string;
      readonly connectionId: string;
      readonly expectedGeneration?: number;
      readonly failedOperationId?: string;
      readonly retrySequence?: number;
      readonly execution: DurableWorkerExecutionPermit;
    },
    state: SyncState,
  ): Promise<void> {
    const nextRetrySequence = Math.min(state.retrySequence + 1, 20);
    await withWorkerOperationTransaction(
      this.pool,
      {
        execution: input.execution,
        targetType: 'calendar-connection',
        targetId: input.connectionId,
        ...(input.expectedGeneration === undefined
          ? {}
          : { targetRevision: input.expectedGeneration }),
        ...(input.failedOperationId === undefined
          ? {}
          : { relatedOperationId: input.failedOperationId }),
        ...(input.retrySequence === undefined
          ? {}
          : { retrySequence: input.retrySequence }),
      },
      async (client) => {
        const updated = firstResultRow(
          await client.query(
            `update emdo.calendar_sync_states
                set state = 'retry-pending', retry_sequence = $3,
                    last_safe_code = 'provider-unavailable',
                    updated_at = pg_catalog.clock_timestamp()
              where connection_id = $1 and sync_generation = $2
                and disconnected_at is null
              returning household_id, space_id, original_owner_user_id`,
            [input.connectionId, state.generation, nextRetrySequence],
          ),
        );
        if (updated === undefined) {
          throw new WorkerPersistenceError(
            'conflict',
            'Calendar failure state changed before commit',
          );
        }
        await this.#insertReceipt(client, {
          operationId: input.operationId,
          kind: input.kind,
          targetId: input.connectionId,
          relatedOperationId: input.failedOperationId,
          retrySequence: input.retrySequence,
          status: 'failed',
          safeCode: 'provider-unavailable',
        });

        // Sequence 20 is the deterministic retry ceiling. Persist the failed
        // terminal observation, but never manufacture another sequence-20
        // operation with a different failed-operation binding.
        if (state.retrySequence >= 20) {
          return;
        }

        const nextOperationId = retryOperationId(
          input.operationId,
          nextRetrySequence,
        );
        const payload = deepFreeze({
          schemaVersion: 1 as const,
          origin: 'deterministic-worker' as const,
          operationId: nextOperationId,
          failedOperationId: input.operationId,
          connectionId: input.connectionId,
          retrySequence: nextRetrySequence,
        });
        const payloadHash = hashDurableWorkerJobPayload(
          WORKER_JOB_NAMES.calendarRetry,
          payload as JsonValue,
        );
        const outboxInsert = await client.query(
          `with database_time as (
             select pg_catalog.clock_timestamp() as now
           )
           insert into emdo.worker_operation_outbox
             (household_id, space_id, original_owner_user_id, request_id,
              job_name, operation_id, target_type, target_id,
              related_operation_id, retry_sequence, payload, payload_hash,
              state, available_at, created_at, updated_at, retain_until)
           values ($1, $2, $3, emdo.current_request_id(), $4, $5,
                   'calendar-connection', $6, $7, $8, $9::jsonb, $10,
                   'pending', pg_catalog.clock_timestamp() + interval '2 minutes',
                   pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
                   pg_catalog.clock_timestamp() + interval '90 days')
           on conflict (job_name, operation_id) do nothing
           returning outbox_id`,
          [
            updated.household_id,
            updated.space_id,
            updated.original_owner_user_id,
            WORKER_JOB_NAMES.calendarRetry,
            nextOperationId,
            input.connectionId,
            input.operationId,
            nextRetrySequence,
            payload,
            payloadHash,
          ],
        );
        if (outboxInsert.rows[0]?.outbox_id === undefined) {
          const existingOutbox = firstResultRow(
            await client.query(
              `select payload_hash, target_id, related_operation_id,
                      retry_sequence
                 from emdo.worker_operation_outbox
                where job_name = $1 and operation_id = $2`,
              [WORKER_JOB_NAMES.calendarRetry, nextOperationId],
            ),
          );
          if (
            existingOutbox?.payload_hash !== payloadHash ||
            existingOutbox.target_id !== input.connectionId ||
            existingOutbox.related_operation_id !== input.operationId ||
            existingOutbox.retry_sequence !== nextRetrySequence
          ) {
            throw new WorkerPersistenceError(
              'conflict',
              'Calendar retry outbox binding conflicts',
            );
          }
        }
      },
    );
  }

  async #recordReconciliationIndeterminate(
    input: z.output<typeof ReconcileInputSchema>,
    context: DurableWorkerExecutionContext,
  ): Promise<void> {
    await withWorkerOperationTransaction(
      this.pool,
      {
        execution: context.execution,
        targetType: 'provider-attempt',
        targetId: input.providerAttemptId,
      },
      async (client) => {
        await this.#insertReceipt(client, {
          operationId: input.operationId,
          kind: 'reconciliation',
          targetId: input.providerAttemptId,
          status: 'indeterminate',
          safeCode: 'readback-indeterminate',
        });
      },
    );
  }

  async #insertReceipt(
    client: import('../scoped-repository.js').DatabaseClient,
    input: {
      readonly operationId: string;
      readonly kind: 'sync' | 'retry' | 'reconciliation';
      readonly targetId: string;
      readonly relatedOperationId?: string;
      readonly retrySequence?: number;
      readonly status: 'completed' | 'failed' | 'indeterminate';
      readonly safeCode?:
        | 'provider-unavailable'
        | 'cursor-invalid'
        | 'generation-conflict'
        | 'readback-indeterminate';
      readonly providerVersion?: string;
      readonly resultHash?: string;
      readonly evidenceHash?: string;
    },
  ): Promise<void> {
    const row = firstResultRow(
      await client.query(
        `with operation_scope as (
           select household_id, space_id, original_owner_user_id
             from emdo.worker_operation_outbox
            where job_name = emdo.current_worker_job_name()
              and operation_id = $1
         ), database_time as (
           select pg_catalog.clock_timestamp() as now
         )
         insert into emdo.calendar_maintenance_receipts
           (household_id, space_id, original_owner_user_id, operation_id,
            kind, target_id, related_operation_id, retry_sequence, status,
            safe_code, provider_version, result_hash, evidence_hash,
            recorded_at, retain_until)
         select household_id, space_id, original_owner_user_id, $1, $2, $3,
                $4, $5, $6, $7, $8, $9, $10,
                database_time.now, database_time.now + interval '90 days'
           from operation_scope cross join database_time
         on conflict (operation_id) do nothing
         returning operation_id`,
        [
          input.operationId,
          input.kind,
          input.targetId,
          input.relatedOperationId ?? null,
          input.retrySequence ?? null,
          input.status,
          input.safeCode ?? null,
          input.providerVersion ?? null,
          input.resultHash ?? null,
          input.evidenceHash ?? null,
        ],
      ),
    );
    if (row?.operation_id !== input.operationId) {
      const existing = firstResultRow(
        await client.query(
          `select kind, target_id, related_operation_id, retry_sequence,
                  status, safe_code, provider_version, result_hash, evidence_hash
             from emdo.calendar_maintenance_receipts
            where operation_id = $1`,
          [input.operationId],
        ),
      );
      if (
        existing?.kind !== input.kind ||
        existing.target_id !== input.targetId ||
        existing.related_operation_id !== (input.relatedOperationId ?? null) ||
        existing.retry_sequence !== (input.retrySequence ?? null) ||
        existing.status !== input.status ||
        existing.safe_code !== (input.safeCode ?? null) ||
        existing.provider_version !== (input.providerVersion ?? null) ||
        existing.result_hash !== (input.resultHash ?? null) ||
        existing.evidence_hash !== (input.evidenceHash ?? null)
      ) {
        throw new WorkerPersistenceError(
          'conflict',
          'Calendar maintenance receipt binding conflicts',
        );
      }
    }
  }
}

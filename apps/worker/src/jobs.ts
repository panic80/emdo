import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

import {
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly,
} from '@emdo/contracts';
import type {
  PgBoss as InstalledPgBoss,
  JobWithMetadata,
  Queue,
  SendOptions,
  WorkOptions,
} from 'pg-boss';
import { z } from 'zod';

import type { InvitationDeliveryService } from './invitations.js';
import type { NotificationDeliveryService } from './notifications.js';
import type { CalendarMaintenanceService } from './reconciliation.js';

export const BACKGROUND_JOB_POLICY = deepFreeze({
  agentExecution: 'forbidden' as const,
  modelExecution: 'forbidden' as const,
  externalApprovalExecution: 'forbidden' as const,
});

export const WORKER_JOB_NAMES = deepFreeze({
  reminderDelivery: 'emdo.reminder.delivery.v1',
  calendarSync: 'emdo.calendar.sync.v1',
  calendarRetry: 'emdo.calendar.retry.v1',
  calendarReconciliation: 'emdo.calendar.reconciliation.v1',
  notificationDelivery: 'emdo.notification.delivery.v1',
  invitationDelivery: 'emdo.invitation.delivery.v1',
});

export type WorkerJobName =
  (typeof WORKER_JOB_NAMES)[keyof typeof WORKER_JOB_NAMES];

const WorkerJobNameSchema = z.enum([
  WORKER_JOB_NAMES.reminderDelivery,
  WORKER_JOB_NAMES.calendarSync,
  WORKER_JOB_NAMES.calendarRetry,
  WORKER_JOB_NAMES.calendarReconciliation,
  WORKER_JOB_NAMES.notificationDelivery,
  WORKER_JOB_NAMES.invitationDelivery,
]);

const JobOriginSchema = z.literal('deterministic-worker');
const CommonJobShape = {
  schemaVersion: z.literal(1),
  origin: JobOriginSchema,
  operationId: IdempotencyKeySchema,
} as const;

const ReminderDeliveryJobSchema = z.strictObject({
  ...CommonJobShape,
  reminderId: OpaqueReferenceSchema,
  dueRevision: z.number().int().safe().positive(),
});
const CalendarSyncJobSchema = z.strictObject({
  ...CommonJobShape,
  connectionId: OpaqueReferenceSchema,
  syncGeneration: z.number().int().safe().nonnegative(),
});
const CalendarRetryJobSchema = z.strictObject({
  ...CommonJobShape,
  failedOperationId: IdempotencyKeySchema,
  connectionId: OpaqueReferenceSchema,
  retrySequence: z.number().int().safe().min(1).max(20),
});
const CalendarReconciliationJobSchema = z.strictObject({
  ...CommonJobShape,
  providerAttemptId: UuidSchema,
});
const NotificationDeliveryJobSchema = z.strictObject({
  ...CommonJobShape,
  notificationId: OpaqueReferenceSchema,
});
const InvitationDeliveryJobSchema = z.strictObject({
  ...CommonJobShape,
  invitationId: UuidSchema,
  deliverySecretId: UuidSchema,
});

type ReminderDeliveryJob = z.output<typeof ReminderDeliveryJobSchema>;
type CalendarSyncJob = z.output<typeof CalendarSyncJobSchema>;
type CalendarRetryJob = z.output<typeof CalendarRetryJobSchema>;
type CalendarReconciliationJob = z.output<
  typeof CalendarReconciliationJobSchema
>;
type NotificationDeliveryJob = z.output<typeof NotificationDeliveryJobSchema>;
type InvitationDeliveryJob = z.output<typeof InvitationDeliveryJobSchema>;

type WorkerPayloadByName = {
  readonly [WORKER_JOB_NAMES.reminderDelivery]: ReminderDeliveryJob;
  readonly [WORKER_JOB_NAMES.calendarSync]: CalendarSyncJob;
  readonly [WORKER_JOB_NAMES.calendarRetry]: CalendarRetryJob;
  readonly [WORKER_JOB_NAMES.calendarReconciliation]: CalendarReconciliationJob;
  readonly [WORKER_JOB_NAMES.notificationDelivery]: NotificationDeliveryJob;
  readonly [WORKER_JOB_NAMES.invitationDelivery]: InvitationDeliveryJob;
};

export interface PgBossJob<TData = unknown> {
  readonly id: string;
  readonly name: string;
  readonly data: TData;
  readonly signal: AbortSignal;
}

export interface PgBossCompatible {
  createQueue(name: string, options: Omit<Queue, 'name'>): Promise<unknown>;
  work(
    name: string,
    options: WorkOptions,
    handler: (jobs: readonly PgBossJob[]) => Promise<unknown>,
  ): Promise<string>;
  send(
    name: string,
    data: object,
    options: SendOptions,
  ): Promise<string | null>;
  getJobById<TData extends object>(
    name: string,
    id: string,
  ): Promise<JobWithMetadata<TData> | null>;
}

/** Compile-time guard against drift from the installed pg-boss public API. */
export const INSTALLED_PG_BOSS_API_COMPATIBLE: InstalledPgBoss extends PgBossCompatible
  ? true
  : false = true;

export interface DeterministicJobExecutionStore {
  /**
   * Atomically claims operationId, invokes operation at most once, and stores
   * completion. Durable production implementations must survive processes.
   */
  executeOnce(
    input: {
      readonly jobId: string;
      readonly jobName: WorkerJobName;
      readonly operationId: string;
      readonly payloadHash: string;
      readonly signal: AbortSignal;
    },
    operation: (permit: WorkerExecutionPermit) => Promise<void>,
  ): Promise<unknown>;
}

const WorkerExecutionPermitSchema = z.strictObject({
  jobName: WorkerJobNameSchema,
  operationId: IdempotencyKeySchema,
  queueJobId: UuidSchema,
  payloadHash: Sha256Schema,
  leaseToken: UuidSchema,
  leaseExpiresAt: IsoDateTimeSchema,
});

export type WorkerExecutionPermit = DeepReadonly<
  z.output<typeof WorkerExecutionPermitSchema>
>;

const parseWorkerExecutionPermit = (
  input: unknown,
): WorkerExecutionPermit | undefined => {
  try {
    if (
      input === null ||
      typeof input !== 'object' ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null)
    ) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const expected = [
      'jobName',
      'operationId',
      'queueJobId',
      'payloadHash',
      'leaseToken',
      'leaseExpiresAt',
    ] as const;
    if (
      Reflect.ownKeys(descriptors).length !== expected.length ||
      expected.some((name) => {
        const descriptor = descriptors[name];
        return (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        );
      })
    ) {
      return undefined;
    }
    const candidate = Object.fromEntries(
      expected.map((name) => [name, descriptors[name]!.value]),
    );
    const parsed = WorkerExecutionPermitSchema.safeParse(candidate);
    return parsed.success ? deepFreeze(parsed.data) : undefined;
  } catch {
    return undefined;
  }
};

export interface WorkerExecutionContext {
  readonly execution: WorkerExecutionPermit;
  readonly signal: AbortSignal;
}

export interface ReminderDeliveryService {
  /** Resolves the canonical reminder and creates its notification idempotently. */
  deliverReminder(
    input: {
      readonly operationId: string;
      readonly reminderId: string;
      readonly dueRevision: number;
    },
    context: WorkerExecutionContext,
  ): Promise<void>;
}

export interface WorkerJobDependencies {
  readonly executions: DeterministicJobExecutionStore;
  readonly reminders: ReminderDeliveryService;
  readonly calendar: CalendarMaintenanceService;
  readonly notifications: NotificationDeliveryService;
  readonly invitations: InvitationDeliveryService;
}

const ExecutionResultSchema = z.strictObject({
  status: z.enum(['executed', 'duplicate']),
});
const NotificationDeliveryResultSchema = z.strictObject({
  status: z.enum(['delivered', 'requires-reconciliation']),
  attemptedChannels: z.number().int().min(1).max(3),
});
const InvitationDeliveryResultSchema = z.strictObject({
  status: z.enum(['delivered', 'expired', 'requires-reconciliation']),
});

export const WORKER_DEAD_LETTER_QUEUE = 'emdo.worker.dead-letter.v1';
const retention = {
  retentionSeconds: 2_592_000,
  deleteAfterSeconds: 604_800,
  deadLetter: WORKER_DEAD_LETTER_QUEUE,
} as const;

const definitions = {
  [WORKER_JOB_NAMES.reminderDelivery]: {
    schema: ReminderDeliveryJobSchema,
    retry: {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 120,
      ...retention,
    },
  },
  [WORKER_JOB_NAMES.calendarSync]: {
    schema: CalendarSyncJobSchema,
    retry: {
      // Calendar sync persists a new, sequence-bound retry outbox operation.
      // Retrying this same operation in pg-boss would race that durable path.
      retryLimit: 0,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 3_600,
      expireInSeconds: 300,
      ...retention,
    },
  },
  [WORKER_JOB_NAMES.calendarRetry]: {
    schema: CalendarRetryJobSchema,
    retry: {
      // Each failed retry produces the next canonical retry operation.
      retryLimit: 0,
      retryDelay: 120,
      retryBackoff: true,
      retryDelayMax: 7_200,
      expireInSeconds: 300,
      ...retention,
    },
  },
  [WORKER_JOB_NAMES.calendarReconciliation]: {
    schema: CalendarReconciliationJobSchema,
    retry: {
      retryLimit: 5,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 3_600,
      expireInSeconds: 180,
      ...retention,
    },
  },
  [WORKER_JOB_NAMES.notificationDelivery]: {
    schema: NotificationDeliveryJobSchema,
    retry: {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 120,
      ...retention,
    },
  },
  [WORKER_JOB_NAMES.invitationDelivery]: {
    schema: InvitationDeliveryJobSchema,
    retry: {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 120,
      ...retention,
    },
  },
} as const;

export const WORKER_JOB_DEFINITIONS = deepFreeze(
  Object.entries(definitions).map(([name, definition]) => ({
    name: name as WorkerJobName,
    retry: definition.retry,
    singletonSeconds: 2_592_000,
    batchSize: 1,
    localConcurrency: 1,
  })),
);

type MethodNames = Readonly<Record<string, readonly string[]>>;
const dependencyMethods: MethodNames = {
  executions: ['executeOnce'],
  reminders: ['deliverReminder'],
  calendar: ['synchronize', 'retrySynchronization', 'reconcileProviderAttempt'],
  notifications: ['deliver'],
  invitations: ['deliver'],
};

type Callable = (...arguments_: never[]) => unknown;

const resolveMethod = (target: object, name: string): Callable | undefined => {
  let current: object | null = target;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        typeof descriptor.value !== 'function'
      ) {
        return undefined;
      }
      return descriptor.value.bind(target) as Callable;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
};

interface NormalizedDependencies {
  readonly executeOnce: DeterministicJobExecutionStore['executeOnce'];
  readonly deliverReminder: ReminderDeliveryService['deliverReminder'];
  readonly synchronize: CalendarMaintenanceService['synchronize'];
  readonly retrySynchronization: CalendarMaintenanceService['retrySynchronization'];
  readonly reconcileProviderAttempt: CalendarMaintenanceService['reconcileProviderAttempt'];
  readonly deliverNotification: NotificationDeliveryService['deliver'];
  readonly deliverInvitation: InvitationDeliveryService['deliver'];
}

const normalizeDependencies = (input: unknown): NormalizedDependencies => {
  try {
    if (input === null || typeof input !== 'object') throw new Error('invalid');
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    const allowedKeys = Object.keys(dependencyMethods);
    if (
      keys.some((key) => typeof key !== 'string') ||
      keys.length !== allowedKeys.length ||
      allowedKeys.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      throw new Error('invalid');
    }

    const resolved = new Map<string, Callable>();
    for (const [dependencyName, methods] of Object.entries(dependencyMethods)) {
      const descriptor = descriptors[dependencyName];
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.value === null ||
        typeof descriptor.value !== 'object'
      ) {
        throw new Error('invalid');
      }
      for (const methodName of methods) {
        const method = resolveMethod(descriptor.value, methodName);
        if (method === undefined) throw new Error('invalid');
        resolved.set(`${dependencyName}.${methodName}`, method);
      }
    }

    return Object.freeze({
      executeOnce: resolved.get('executions.executeOnce')!,
      deliverReminder: resolved.get('reminders.deliverReminder')!,
      synchronize: resolved.get('calendar.synchronize')!,
      retrySynchronization: resolved.get('calendar.retrySynchronization')!,
      reconcileProviderAttempt: resolved.get(
        'calendar.reconcileProviderAttempt',
      )!,
      deliverNotification: resolved.get('notifications.deliver')!,
      deliverInvitation: resolved.get('invitations.deliver')!,
    }) as NormalizedDependencies;
  } catch {
    throw new Error('Worker dependency boundary is invalid');
  }
};

type BaseWorkerJob = {
  readonly schemaVersion: 1;
  readonly origin: 'deterministic-worker';
  readonly operationId: string;
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
};

const payloadHashForParsed = (
  name: WorkerJobName,
  payload: BaseWorkerJob,
): string =>
  createHash('sha256')
    .update(`${name}\0${canonicalJson(payload)}`, 'utf8')
    .digest('hex');

const QUEUE_JOB_ID_DOMAIN = 'emdo.worker.pg-boss.queue-job-id.v1';

const updateLengthPrefixed = (
  hash: ReturnType<typeof createHash>,
  value: string,
): void => {
  const encoded = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.length);
  hash.update(length);
  hash.update(encoded);
};

/**
 * Produces the immutable RFC 9562 UUIDv8 used as pg-boss's caller-supplied id.
 * The versioned domain and length prefixes prevent cross-protocol ambiguity.
 */
export const deriveWorkerQueueJobId = (
  name: WorkerJobName,
  operationId: string,
  payloadHash: string,
): string => {
  const parsed = z
    .tuple([WorkerJobNameSchema, IdempotencyKeySchema, Sha256Schema])
    .safeParse([name, operationId, payloadHash]);
  if (!parsed.success) throw new Error('Worker queue binding is invalid');
  const digest = createHash('sha256');
  updateLengthPrefixed(digest, QUEUE_JOB_ID_DOMAIN);
  for (const value of parsed.data) updateLengthPrefixed(digest, value);
  const bytes = Buffer.from(digest.digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const hashWorkerJobPayload = (
  name: WorkerJobName,
  input: unknown,
): string => {
  try {
    const definition = definitions[name];
    if (definition === undefined) throw new Error('invalid');
    const parsed = definition.schema.safeParse(input);
    if (!parsed.success) throw new Error('invalid');
    return payloadHashForParsed(name, parsed.data);
  } catch {
    throw new Error('Background job payload is invalid');
  }
};

export const resolveWorkerJobQueueBinding = (
  name: WorkerJobName,
  input: unknown,
): Readonly<{
  operationId: string;
  payloadHash: string;
  queueJobId: string;
}> => {
  try {
    const definition = definitions[name];
    if (definition === undefined) throw new Error('invalid');
    const parsed = definition.schema.safeParse(input);
    if (!parsed.success) throw new Error('invalid');
    const payloadHash = payloadHashForParsed(name, parsed.data);
    return deepFreeze({
      operationId: parsed.data.operationId,
      payloadHash,
      queueJobId: deriveWorkerQueueJobId(
        name,
        parsed.data.operationId,
        payloadHash,
      ),
    });
  } catch {
    throw new Error('Background job payload is invalid');
  }
};

const parseJob = <TData extends BaseWorkerJob>(
  expectedName: WorkerJobName,
  schema: z.ZodType<TData>,
  jobs: readonly PgBossJob[],
): {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly data: DeepReadonly<TData>;
} => {
  let id: unknown;
  let name: unknown;
  let data: unknown;
  let signal: unknown;
  try {
    if (!Array.isArray(jobs) || jobs.length !== 1 || jobs[0] === undefined) {
      throw new Error('invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(jobs[0]);
    const read = (key: 'id' | 'name' | 'data' | 'signal'): unknown => {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        throw new Error('invalid');
      }
      return descriptor.value;
    };
    id = read('id');
    name = read('name');
    data = read('data');
    signal = read('signal');
  } catch {
    throw new Error('Background job batch is invalid');
  }
  if (
    name !== expectedName ||
    !UuidSchema.safeParse(id).success ||
    !(signal instanceof AbortSignal)
  ) {
    throw new Error('Background job batch is invalid');
  }
  let result: z.ZodSafeParseResult<TData>;
  try {
    result = schema.safeParse(data);
  } catch {
    throw new Error('Background job payload is invalid');
  }
  if (!result.success) throw new Error('Background job payload is invalid');
  return {
    id: id as string,
    signal,
    data: deepFreeze(result.data),
  };
};

export type WorkerJobHandler = (
  jobs: readonly PgBossJob[],
) => Promise<{ readonly status: 'executed' | 'duplicate' | 'exhausted' }>;

export type WorkerJobHandlers = Readonly<
  Record<WorkerJobName, WorkerJobHandler>
>;

const readOwnSafeErrorCode = (error: unknown): string | undefined => {
  if (
    error === null ||
    (typeof error !== 'object' && typeof error !== 'function')
  ) {
    return undefined;
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  } catch {
    return undefined;
  }
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    typeof descriptor.value !== 'string'
  ) {
    return undefined;
  }
  return descriptor.value;
};

class WorkerQueueBindingError extends Error {
  readonly code = 'invalid-operation';

  constructor() {
    super('Worker queue binding is invalid');
    this.name = 'WorkerQueueBindingError';
  }
}

class WorkerQueueDispatchIndeterminateError extends Error {
  readonly code = 'queue-dispatch-indeterminate';

  constructor() {
    super('Worker queue dispatch outcome is indeterminate');
    this.name = 'WorkerQueueDispatchIndeterminateError';
  }
}

export const isWorkerQueueBindingError = (error: unknown): boolean => {
  try {
    return (
      readOwnSafeErrorCode(error) === 'invalid-operation' &&
      error instanceof WorkerQueueBindingError
    );
  } catch {
    return false;
  }
};

export const isWorkerQueueDispatchIndeterminateError = (
  error: unknown,
): boolean => {
  try {
    return (
      readOwnSafeErrorCode(error) === 'queue-dispatch-indeterminate' &&
      error instanceof WorkerQueueDispatchIndeterminateError
    );
  } catch {
    return false;
  }
};

export const createWorkerJobHandlers = (input: unknown): WorkerJobHandlers => {
  const dependencies = normalizeDependencies(input);

  const createHandler =
    <TData extends BaseWorkerJob>(
      name: WorkerJobName,
      schema: z.ZodType<TData>,
      operation: (job: {
        readonly id: string;
        readonly signal: AbortSignal;
        readonly data: DeepReadonly<TData>;
        readonly execution: WorkerExecutionPermit;
      }) => Promise<void>,
    ): WorkerJobHandler =>
    async (jobs) => {
      const parsed = parseJob(name, schema, jobs);
      parsed.signal.throwIfAborted();
      let operationCalls = 0;
      let callbackOpen = true;
      try {
        let rawResult: unknown;
        try {
          rawResult = await dependencies.executeOnce(
            {
              jobId: parsed.id,
              jobName: name,
              operationId: parsed.data.operationId,
              payloadHash: payloadHashForParsed(name, parsed.data),
              signal: parsed.signal,
            },
            async (rawPermit) => {
              if (!callbackOpen) throw new Error('invalid');
              operationCalls += 1;
              if (operationCalls > 1) throw new Error('invalid');
              const permit = parseWorkerExecutionPermit(rawPermit);
              if (
                permit === undefined ||
                permit.jobName !== name ||
                permit.operationId !== parsed.data.operationId ||
                permit.queueJobId !== parsed.id ||
                permit.payloadHash !== payloadHashForParsed(name, parsed.data)
              ) {
                throw new Error('invalid');
              }
              await operation({
                ...parsed,
                execution: permit,
              });
            },
          );
        } finally {
          callbackOpen = false;
        }
        const result = ExecutionResultSchema.safeParse(rawResult);
        if (
          !result.success ||
          (result.data.status === 'executed' && operationCalls !== 1) ||
          (result.data.status === 'duplicate' && operationCalls !== 0)
        ) {
          throw new Error('invalid');
        }
        return deepFreeze({ status: result.data.status });
      } catch (error) {
        if (readOwnSafeErrorCode(error) === 'attempt-exhausted') {
          return deepFreeze({ status: 'exhausted' as const });
        }
        throw new Error('Background job execution failed');
      }
    };

  return Object.freeze({
    [WORKER_JOB_NAMES.reminderDelivery]: createHandler(
      WORKER_JOB_NAMES.reminderDelivery,
      ReminderDeliveryJobSchema,
      async ({ data, signal, execution }) => {
        await dependencies.deliverReminder(
          {
            operationId: data.operationId,
            reminderId: data.reminderId,
            dueRevision: data.dueRevision,
          },
          Object.freeze({ execution, signal }),
        );
      },
    ),
    [WORKER_JOB_NAMES.calendarSync]: createHandler(
      WORKER_JOB_NAMES.calendarSync,
      CalendarSyncJobSchema,
      async ({ data, signal, execution }) => {
        await dependencies.synchronize(
          data,
          Object.freeze({ execution, signal }),
        );
      },
    ),
    [WORKER_JOB_NAMES.calendarRetry]: createHandler(
      WORKER_JOB_NAMES.calendarRetry,
      CalendarRetryJobSchema,
      async ({ data, signal, execution }) => {
        await dependencies.retrySynchronization(
          data,
          Object.freeze({ execution, signal }),
        );
      },
    ),
    [WORKER_JOB_NAMES.calendarReconciliation]: createHandler(
      WORKER_JOB_NAMES.calendarReconciliation,
      CalendarReconciliationJobSchema,
      async ({ data, signal, execution }) => {
        await dependencies.reconcileProviderAttempt(
          data,
          Object.freeze({ execution, signal }),
        );
      },
    ),
    [WORKER_JOB_NAMES.notificationDelivery]: createHandler(
      WORKER_JOB_NAMES.notificationDelivery,
      NotificationDeliveryJobSchema,
      async ({ data, signal, execution }) => {
        const result = NotificationDeliveryResultSchema.safeParse(
          await dependencies.deliverNotification(
            {
              operationId: data.operationId,
              notificationId: data.notificationId,
            },
            Object.freeze({ execution, signal }),
          ),
        );
        if (!result.success) throw new Error('invalid');
        // requires-reconciliation is intentionally terminal here: each
        // indeterminate channel outcome is already durable and must be handled
        // through the scoped reconciliation/operator queue, never blind retry.
      },
    ),
    [WORKER_JOB_NAMES.invitationDelivery]: createHandler(
      WORKER_JOB_NAMES.invitationDelivery,
      InvitationDeliveryJobSchema,
      async ({ data, signal, execution }) => {
        const result = InvitationDeliveryResultSchema.safeParse(
          await dependencies.deliverInvitation(
            {
              operationId: data.operationId,
              invitationId: data.invitationId,
              deliverySecretId: data.deliverySecretId,
            },
            Object.freeze({ execution, signal }),
          ),
        );
        if (!result.success) throw new Error('invalid');
        // An indeterminate provider outcome is already durably settled for
        // reconciliation with its sealed secret retained. Never blind-retry it.
      },
    ),
  });
};

const singletonKeyFor = (
  name: WorkerJobName,
  operationId: string,
  payloadHash: string,
): string =>
  createHash('sha256')
    .update(`${name}\0${operationId}\0${payloadHash}`, 'utf8')
    .digest('hex');

export interface WorkerJobSchedulingOptions {
  readonly startAfter?: Date;
}

export type WorkerJobEnqueueResult =
  | { readonly status: 'enqueued'; readonly jobId: string }
  | { readonly status: 'duplicate'; readonly jobId: string };

const isExactExistingQueueJob = (
  input: unknown,
  expected: {
    readonly id: string;
    readonly name: WorkerJobName;
    readonly payloadHash: string;
    readonly singletonKey: string;
  },
): boolean => {
  try {
    if (
      input === null ||
      typeof input !== 'object' ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null)
    ) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const read = (name: string): unknown => {
      const descriptor = descriptors[name];
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        throw new Error('invalid');
      }
      return descriptor.value;
    };
    const state = read('state');
    return (
      read('id') === expected.id &&
      read('name') === expected.name &&
      read('singletonKey') === expected.singletonKey &&
      (state === 'created' ||
        state === 'retry' ||
        state === 'active' ||
        state === 'completed') &&
      hashWorkerJobPayload(expected.name, read('data')) === expected.payloadHash
    );
  } catch {
    return false;
  }
};

const parseSchedulingOptions = (input: unknown): WorkerJobSchedulingOptions => {
  if (input === undefined) return Object.freeze({});
  try {
    if (
      input === null ||
      typeof input !== 'object' ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      throw new Error('invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => typeof key !== 'string' || key !== 'startAfter') ||
      keys.length > 1
    ) {
      throw new Error('invalid');
    }
    const descriptor = descriptors.startAfter;
    if (descriptor === undefined) return Object.freeze({});
    if (
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !(descriptor.value instanceof Date) ||
      !Number.isFinite(descriptor.value.getTime())
    ) {
      throw new Error('invalid');
    }
    return Object.freeze({ startAfter: new Date(descriptor.value.getTime()) });
  } catch {
    throw new Error('Background job scheduling options are invalid');
  }
};

export const enqueueWorkerJob = async <TName extends WorkerJobName>(
  boss: Pick<PgBossCompatible, 'send' | 'getJobById'>,
  name: TName,
  input: unknown,
  options?: WorkerJobSchedulingOptions,
): Promise<WorkerJobEnqueueResult> => {
  const definition = definitions[name];
  if (definition === undefined) {
    throw new Error('Background job payload is invalid');
  }
  let parsed: ReturnType<(typeof definition)['schema']['safeParse']>;
  try {
    parsed = definition.schema.safeParse(input) as typeof parsed;
  } catch {
    throw new Error('Background job payload is invalid');
  }
  if (!parsed.success) throw new Error('Background job payload is invalid');
  const data = deepFreeze(parsed.data) as WorkerPayloadByName[TName];
  const scheduling = parseSchedulingOptions(options);
  const { payloadHash, queueJobId: jobId } = resolveWorkerJobQueueBinding(
    name,
    data,
  );
  const singletonKey = singletonKeyFor(name, data.operationId, payloadHash);
  let queuedId: string | null;
  let sendThrew = false;
  try {
    queuedId = await boss.send(name, data, {
      id: jobId,
      singletonKey,
      singletonSeconds: 2_592_000,
      ...definition.retry,
      ...scheduling,
    });
  } catch {
    sendThrew = true;
    queuedId = null;
  }
  if (queuedId !== null) {
    if (queuedId !== jobId) throw new WorkerQueueBindingError();
    return deepFreeze({ status: 'enqueued' as const, jobId });
  }
  let existing: unknown;
  try {
    existing = await boss.getJobById(name, jobId);
  } catch {
    throw new WorkerQueueDispatchIndeterminateError();
  }
  if (
    isExactExistingQueueJob(existing, {
      id: jobId,
      name,
      payloadHash,
      singletonKey,
    })
  ) {
    return deepFreeze({ status: 'duplicate' as const, jobId });
  }
  if (sendThrew && existing === null) {
    // A transport failure can race a server-side commit. One immediate null
    // readback is not proof of non-application, so retain the durable binding.
    throw new WorkerQueueDispatchIndeterminateError();
  }
  throw new WorkerQueueBindingError();
};

export const registerWorkerJobs = async (
  boss: Pick<PgBossCompatible, 'createQueue' | 'work'>,
  dependencies: unknown,
): Promise<Readonly<Record<WorkerJobName, string>>> => {
  const handlers = createWorkerJobHandlers(dependencies);
  const workerIds = {} as Record<WorkerJobName, string>;
  await boss.createQueue(WORKER_DEAD_LETTER_QUEUE, {
    policy: 'standard',
    retryLimit: 0,
    retentionSeconds: 2_592_000,
    deleteAfterSeconds: 2_592_000,
  });
  for (const definition of WORKER_JOB_DEFINITIONS) {
    await boss.createQueue(definition.name, {
      policy: 'short',
      ...definition.retry,
    });
    workerIds[definition.name] = await boss.work(
      definition.name,
      {
        batchSize: definition.batchSize,
        localConcurrency: definition.localConcurrency,
        pollingIntervalSeconds: 2,
      },
      handlers[definition.name],
    );
  }
  return deepFreeze(workerIds);
};

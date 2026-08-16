import { createHash } from 'node:crypto';

import {
  IdempotencyKeySchema,
  OpaqueReferenceSchema,
  deepFreeze,
  type DeepReadonly,
} from '@emdo/contracts';
import type { EmailNotificationSender } from '@emdo/integrations/email';
import type { PushNotificationSender } from '@emdo/integrations/push';
import { z } from 'zod';

import type { WorkerExecutionContext } from './jobs.js';

const NotificationDeliveryRequestSchema = z.strictObject({
  operationId: IdempotencyKeySchema,
  notificationId: OpaqueReferenceSchema,
});

const NotificationDeliveryRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    notificationId: OpaqueReferenceSchema,
    revision: z.number().int().safe().positive(),
    sensitivity: z.enum(['standard', 'sensitive']),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(4_000),
    channels: z.strictObject({
      inApp: z.boolean(),
      email: z.strictObject({ recipient: z.email().max(320) }).nullable(),
      push: z
        .strictObject({ subscriptionReference: OpaqueReferenceSchema })
        .nullable(),
    }),
    externalOutcomes: z
      .strictObject({
        email: z
          .enum(['sent', 'duplicate', 'not-applied', 'indeterminate'])
          .nullable(),
        push: z
          .enum(['sent', 'duplicate', 'gone', 'not-applied', 'indeterminate'])
          .nullable(),
      })
      .default({ email: null, push: null }),
  })
  .superRefine((record, context) => {
    if (
      !record.channels.inApp &&
      record.channels.email === null &&
      record.channels.push === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['channels'],
        message: 'At least one notification channel is required',
      });
    }
  });

type NotificationDeliveryRecord = DeepReadonly<
  z.output<typeof NotificationDeliveryRecordSchema>
>;

export interface NotificationDeliveryRepository {
  /** Resolve content, preferences, and opaque endpoints under server scope. */
  loadForDelivery(
    input: {
      readonly operationId: string;
      readonly notificationId: string;
    },
    context: WorkerExecutionContext,
  ): Promise<unknown>;
  /** Idempotent canonical write keyed by deliveryId. */
  writeInApp(
    input: {
      readonly operationId: string;
      readonly deliveryId: string;
      readonly notificationId: string;
      readonly revision: number;
      readonly sensitivity: 'standard' | 'sensitive';
      readonly title: string;
      readonly body: string;
    },
    context: WorkerExecutionContext,
  ): Promise<unknown>;
  /** Idempotent audit/update keyed by channel plus deliveryId. */
  recordExternalOutcome(
    input: {
      readonly operationId: string;
      readonly deliveryId: string;
      readonly notificationId: string;
      readonly channel: 'email' | 'push';
      readonly status:
        'sent' | 'duplicate' | 'gone' | 'not-applied' | 'indeterminate';
    },
    context: WorkerExecutionContext,
  ): Promise<void>;
}

export interface NotificationDeliveryService {
  deliver(
    input: {
      readonly operationId: string;
      readonly notificationId: string;
    },
    context: WorkerExecutionContext,
  ): Promise<{
    readonly status: 'delivered' | 'requires-reconciliation';
    readonly attemptedChannels: number;
  }>;
}

const InAppResultSchema = z.strictObject({
  status: z.enum(['created', 'duplicate']),
});

const deliveryIdFor = (
  record: NotificationDeliveryRecord,
  channel: 'in-app' | 'email' | 'push',
): string =>
  `notification:${createHash('sha256')
    .update(
      JSON.stringify([
        record.schemaVersion,
        record.notificationId,
        record.revision,
        channel,
      ]),
      'utf8',
    )
    .digest('hex')}`;

type Method = (...arguments_: never[]) => unknown;

const captureMethod = (target: object, name: string): Method | undefined => {
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
      return descriptor.value.bind(target) as Method;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
};

interface NotificationBindings {
  readonly loadForDelivery: NotificationDeliveryRepository['loadForDelivery'];
  readonly writeInApp: NotificationDeliveryRepository['writeInApp'];
  readonly recordExternalOutcome: NotificationDeliveryRepository['recordExternalOutcome'];
  readonly sendEmail: EmailNotificationSender['send'];
  readonly sendPush: PushNotificationSender['send'];
}

const captureNotificationBindings = (input: unknown): NotificationBindings => {
  try {
    if (
      input === null ||
      typeof input !== 'object' ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null)
    ) {
      throw new Error('invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const expected = ['repository', 'email', 'push'] as const;
    if (
      Reflect.ownKeys(descriptors).length !== expected.length ||
      expected.some((key) => {
        const descriptor = descriptors[key];
        return (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          descriptor.value === null ||
          typeof descriptor.value !== 'object'
        );
      })
    ) {
      throw new Error('invalid');
    }
    const repository = descriptors.repository!.value as object;
    const email = descriptors.email!.value as object;
    const push = descriptors.push!.value as object;
    const loadForDelivery = captureMethod(repository, 'loadForDelivery');
    const writeInApp = captureMethod(repository, 'writeInApp');
    const recordExternalOutcome = captureMethod(
      repository,
      'recordExternalOutcome',
    );
    const sendEmail = captureMethod(email, 'send');
    const sendPush = captureMethod(push, 'send');
    if (
      loadForDelivery === undefined ||
      writeInApp === undefined ||
      recordExternalOutcome === undefined ||
      sendEmail === undefined ||
      sendPush === undefined
    ) {
      throw new Error('invalid');
    }
    return Object.freeze({
      loadForDelivery:
        loadForDelivery as NotificationDeliveryRepository['loadForDelivery'],
      writeInApp: writeInApp as NotificationDeliveryRepository['writeInApp'],
      recordExternalOutcome:
        recordExternalOutcome as NotificationDeliveryRepository['recordExternalOutcome'],
      sendEmail: sendEmail as EmailNotificationSender['send'],
      sendPush: sendPush as PushNotificationSender['send'],
    });
  } catch {
    throw new Error('Notification delivery dependencies are invalid');
  }
};

const createOutcomeSignal = (): AbortSignal => AbortSignal.timeout(5_000);

export const createNotificationDeliveryService = (dependencies: {
  readonly repository: NotificationDeliveryRepository;
  readonly email: EmailNotificationSender;
  readonly push: PushNotificationSender;
}): NotificationDeliveryService => {
  const bindings = captureNotificationBindings(dependencies);
  return {
    async deliver(input, context) {
      context.signal.throwIfAborted();
      const request = NotificationDeliveryRequestSchema.safeParse(input);
      if (!request.success) {
        throw new Error('Notification delivery request is invalid');
      }

      let rawRecord: unknown;
      try {
        rawRecord = await bindings.loadForDelivery(request.data, context);
      } catch {
        throw new Error('Notification is unavailable for delivery');
      }
      const parsedRecord =
        NotificationDeliveryRecordSchema.safeParse(rawRecord);
      if (
        !parsedRecord.success ||
        parsedRecord.data.notificationId !== request.data.notificationId
      ) {
        throw new Error('Notification is unavailable for delivery');
      }
      const record = deepFreeze(parsedRecord.data);
      const attempts: Promise<void>[] = [];
      let requiresReconciliation = false;

      if (record.channels.inApp) {
        attempts.push(
          (async () => {
            const rawResult = await bindings.writeInApp(
              deepFreeze({
                operationId: request.data.operationId,
                deliveryId: deliveryIdFor(record, 'in-app'),
                notificationId: record.notificationId,
                revision: record.revision,
                sensitivity: record.sensitivity,
                title: record.title,
                body: record.body,
              }),
              context,
            );
            if (!InAppResultSchema.safeParse(rawResult).success) {
              throw new Error('invalid');
            }
          })(),
        );
      }

      if (record.channels.email !== null) {
        attempts.push(
          (async () => {
            const previous = record.externalOutcomes.email;
            if (
              previous === 'sent' ||
              previous === 'duplicate' ||
              previous === 'indeterminate'
            ) {
              if (previous === 'indeterminate') requiresReconciliation = true;
              return;
            }
            const deliveryId = deliveryIdFor(record, 'email');
            let result: {
              readonly status:
                'sent' | 'duplicate' | 'not-applied' | 'indeterminate';
            };
            try {
              result = await bindings.sendEmail(
                {
                  deliveryId,
                  recipient: record.channels.email!.recipient,
                },
                { signal: context.signal },
              );
            } catch {
              result = { status: 'indeterminate' };
            }
            await bindings.recordExternalOutcome(
              deepFreeze({
                operationId: request.data.operationId,
                deliveryId,
                notificationId: record.notificationId,
                channel: 'email' as const,
                status: result.status,
              }),
              {
                execution: context.execution,
                signal: createOutcomeSignal(),
              },
            );
            if (result.status === 'indeterminate') {
              requiresReconciliation = true;
            }
            if (result.status === 'not-applied') throw new Error('retry');
          })(),
        );
      }

      if (record.channels.push !== null) {
        attempts.push(
          (async () => {
            const previous = record.externalOutcomes.push;
            if (
              previous === 'sent' ||
              previous === 'duplicate' ||
              previous === 'gone' ||
              previous === 'indeterminate'
            ) {
              if (previous === 'indeterminate') requiresReconciliation = true;
              return;
            }
            const deliveryId = deliveryIdFor(record, 'push');
            let result: {
              readonly status:
                'sent' | 'duplicate' | 'gone' | 'not-applied' | 'indeterminate';
            };
            try {
              result = await bindings.sendPush(
                {
                  deliveryId,
                  subscriptionReference:
                    record.channels.push!.subscriptionReference,
                },
                { signal: context.signal },
              );
            } catch {
              result = { status: 'indeterminate' };
            }
            await bindings.recordExternalOutcome(
              deepFreeze({
                operationId: request.data.operationId,
                deliveryId,
                notificationId: record.notificationId,
                channel: 'push' as const,
                status: result.status,
              }),
              {
                execution: context.execution,
                signal: createOutcomeSignal(),
              },
            );
            if (result.status === 'indeterminate') {
              requiresReconciliation = true;
            }
            if (result.status === 'not-applied') throw new Error('retry');
          })(),
        );
      }

      const results = await Promise.allSettled(attempts);
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('Notification delivery failed');
      }
      return deepFreeze({
        status: requiresReconciliation
          ? ('requires-reconciliation' as const)
          : ('delivered' as const),
        attemptedChannels: attempts.length,
      });
    },
  };
};

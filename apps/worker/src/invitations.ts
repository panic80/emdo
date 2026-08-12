import {
  IdempotencyKeySchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly,
} from '@emdo/contracts';
import {
  InvitationDeliverySecretEnvelopeSchema,
  type InvitationDeliverySecretOpeningBoundary,
  type InvitationEmailSender,
} from '@emdo/integrations/email';
import { z } from 'zod';

import type { WorkerExecutionContext } from './jobs.js';

const InvitationDeliveryRequestSchema = z.strictObject({
  operationId: IdempotencyKeySchema,
  invitationId: UuidSchema,
  deliverySecretId: UuidSchema,
});

const InvitationDeliveryIdentityShape = {
  schemaVersion: z.literal(1),
  invitationId: UuidSchema,
  deliverySecretId: UuidSchema,
} as const;

const ActiveInvitationDeliveryRecordSchema = z.strictObject({
  ...InvitationDeliveryIdentityShape,
  status: z.literal('active'),
  recipient: z
    .email()
    .max(320)
    .refine(
      (value) => value === value.trim().toLowerCase(),
      'Expected a normalized recipient',
    ),
  role: z.enum(['owner', 'member']),
  tokenHash: Sha256Schema,
  templateVersion: z.literal('invitation-redemption.v1'),
  envelope: InvitationDeliverySecretEnvelopeSchema,
});

const ExpiredInvitationDeliveryRecordSchema = z.strictObject({
  ...InvitationDeliveryIdentityShape,
  status: z.literal('expired'),
});

const InvitationDeliveryRecordSchema = z.discriminatedUnion('status', [
  ActiveInvitationDeliveryRecordSchema,
  ExpiredInvitationDeliveryRecordSchema,
]);

const InvitationEmailResultSchema = z.strictObject({
  status: z.enum(['sent', 'duplicate', 'not-applied', 'indeterminate']),
});

const InvitationDeliverySettlementResultSchema = z.strictObject({
  status: z.enum(['settled', 'duplicate']),
});

type InvitationDeliveryRequest = DeepReadonly<
  z.output<typeof InvitationDeliveryRequestSchema>
>;

export type InvitationDeliveryDisposition =
  'confirmed' | 'indeterminate' | 'expired';

export interface InvitationDeliveryRepository {
  /**
   * Under the supplied claimed worker scope, capture only the canonical
   * recipient and its sealed, reference-bound delivery secret. Implementations
   * must use database time to return `expired` instead of exposing stale
   * ciphertext, and must never return invitation plaintext.
   */
  captureForDelivery(
    input: {
      readonly operationId: string;
      readonly invitationId: string;
      readonly deliverySecretId: string;
    },
    context: WorkerExecutionContext,
  ): Promise<unknown>;

  /**
   * Confirmed and expired dispositions terminally erase the sealed secret.
   * Indeterminate retains it for durable reconciliation. A proven not-applied
   * provider outcome does not call this method and remains retryable.
   */
  settleDelivery(
    input: {
      readonly operationId: string;
      readonly invitationId: string;
      readonly deliverySecretId: string;
      readonly disposition: InvitationDeliveryDisposition;
    },
    context: WorkerExecutionContext,
  ): Promise<unknown>;
}

export type InvitationDeliveryServiceResult = DeepReadonly<
  | { readonly status: 'delivered' }
  | { readonly status: 'expired' }
  | { readonly status: 'requires-reconciliation' }
>;

export interface InvitationDeliveryService {
  deliver(
    input: InvitationDeliveryRequest,
    context: WorkerExecutionContext,
  ): Promise<InvitationDeliveryServiceResult>;
}

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

interface InvitationDeliveryBindings {
  readonly captureForDelivery: InvitationDeliveryRepository['captureForDelivery'];
  readonly settleDelivery: InvitationDeliveryRepository['settleDelivery'];
  readonly withOpenedSecret: InvitationDeliverySecretOpeningBoundary['withOpenedSecret'];
  readonly sendEmail: InvitationEmailSender['send'];
}

const captureInvitationDeliveryBindings = (
  input: unknown,
): InvitationDeliveryBindings => {
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
    const expected = ['repository', 'opener', 'email'] as const;
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
    const captureForDelivery = captureMethod(
      descriptors.repository!.value as object,
      'captureForDelivery',
    );
    const settleDelivery = captureMethod(
      descriptors.repository!.value as object,
      'settleDelivery',
    );
    const withOpenedSecret = captureMethod(
      descriptors.opener!.value as object,
      'withOpenedSecret',
    );
    const sendEmail = captureMethod(descriptors.email!.value as object, 'send');
    if (
      captureForDelivery === undefined ||
      settleDelivery === undefined ||
      withOpenedSecret === undefined ||
      sendEmail === undefined
    ) {
      throw new Error('invalid');
    }
    return Object.freeze({
      captureForDelivery:
        captureForDelivery as InvitationDeliveryRepository['captureForDelivery'],
      settleDelivery:
        settleDelivery as InvitationDeliveryRepository['settleDelivery'],
      withOpenedSecret:
        withOpenedSecret as InvitationDeliverySecretOpeningBoundary['withOpenedSecret'],
      sendEmail: sendEmail as InvitationEmailSender['send'],
    });
  } catch {
    throw new Error('Invitation delivery dependencies are invalid');
  }
};

const settle = async (
  bindings: InvitationDeliveryBindings,
  request: InvitationDeliveryRequest,
  disposition: InvitationDeliveryDisposition,
  context: WorkerExecutionContext,
): Promise<void> => {
  let rawResult: unknown;
  try {
    rawResult = await bindings.settleDelivery(
      deepFreeze({ ...request, disposition }),
      context,
    );
  } catch {
    throw new Error('Invitation delivery failed');
  }
  if (!InvitationDeliverySettlementResultSchema.safeParse(rawResult).success) {
    throw new Error('Invitation delivery failed');
  }
};

const settlementContext = (
  context: WorkerExecutionContext,
): WorkerExecutionContext =>
  Object.freeze({
    execution: context.execution,
    signal: AbortSignal.timeout(5_000),
  });

export const createInvitationDeliveryService = (dependencies: {
  readonly repository: InvitationDeliveryRepository;
  readonly opener: InvitationDeliverySecretOpeningBoundary;
  readonly email: InvitationEmailSender;
}): InvitationDeliveryService => {
  const bindings = captureInvitationDeliveryBindings(dependencies);
  const service: InvitationDeliveryService = {
    async deliver(input, context) {
      context.signal.throwIfAborted();
      const request = InvitationDeliveryRequestSchema.safeParse(input);
      if (
        !request.success ||
        context.execution.jobName !== 'emdo.invitation.delivery.v1' ||
        context.execution.operationId !== request.data.operationId
      ) {
        throw new Error('Invitation delivery request is invalid');
      }
      const canonicalRequest = deepFreeze(request.data);

      let rawRecord: unknown;
      try {
        rawRecord = await bindings.captureForDelivery(
          canonicalRequest,
          context,
        );
      } catch {
        throw new Error('Invitation is unavailable for delivery');
      }
      const parsedRecord = InvitationDeliveryRecordSchema.safeParse(rawRecord);
      if (
        !parsedRecord.success ||
        parsedRecord.data.invitationId !== canonicalRequest.invitationId ||
        parsedRecord.data.deliverySecretId !== canonicalRequest.deliverySecretId
      ) {
        throw new Error('Invitation is unavailable for delivery');
      }
      const record = deepFreeze(parsedRecord.data);

      if (record.status === 'expired') {
        await settle(bindings, canonicalRequest, 'expired', context);
        return deepFreeze({ status: 'expired' as const });
      }

      let rawResult: unknown;
      try {
        rawResult = await bindings.withOpenedSecret(
          deepFreeze({
            envelope: record.envelope,
            binding: {
              invitationId: record.invitationId,
              normalizedRecipient: record.recipient,
              role: record.role,
              tokenHash: record.tokenHash,
              templateVersion: record.templateVersion,
            },
          }),
          (invitationTokenBytes) =>
            bindings.sendEmail(
              Object.freeze({
                operationId: canonicalRequest.operationId,
                invitationId: record.invitationId,
                invitationTokenBytes,
                recipient: record.recipient,
              }),
              { signal: context.signal },
            ),
        );
      } catch {
        throw new Error('Invitation delivery failed');
      }
      const result = InvitationEmailResultSchema.safeParse(rawResult);
      if (!result.success || result.data.status === 'not-applied') {
        throw new Error('Invitation delivery failed');
      }
      if (result.data.status === 'indeterminate') {
        await settle(
          bindings,
          canonicalRequest,
          'indeterminate',
          settlementContext(context),
        );
        return deepFreeze({ status: 'requires-reconciliation' as const });
      }
      await settle(
        bindings,
        canonicalRequest,
        'confirmed',
        settlementContext(context),
      );
      return deepFreeze({ status: 'delivered' as const });
    },
  };
  return Object.freeze(service);
};

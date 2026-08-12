import { Buffer } from 'node:buffer';

import {
  IdempotencyKeySchema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly,
} from '@emdo/contracts';
import { z } from 'zod';

import type { TransactionalEmailTransport } from './notification-email.js';

const InvitationTokenBytesSchema = z
  .instanceof(Uint8Array)
  .refine(
    (value) =>
      value.buffer instanceof ArrayBuffer &&
      value.byteLength >= 40 &&
      value.byteLength <= 128 &&
      value.every(
        (byte) =>
          (byte >= 48 && byte <= 57) ||
          (byte >= 65 && byte <= 90) ||
          byte === 95 ||
          (byte >= 97 && byte <= 122) ||
          byte === 45,
      ),
  );

const InvitationEmailInputSchema = z.strictObject({
  operationId: IdempotencyKeySchema,
  invitationId: UuidSchema,
  invitationTokenBytes: InvitationTokenBytesSchema,
  recipient: z.email().max(320),
});

const InvitationEmailTransportMessageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  deliveryId: IdempotencyKeySchema,
  recipient: z.email().max(320),
  subject: z.literal("You're invited to EMDO"),
  text: z.string().min(1).max(4_096),
  contentClassification: z.literal('invitation-redemption-link'),
});

const InvitationEmailTransportResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('sent'),
    providerMessageReference: z.string().trim().min(1).max(1_024),
  }),
  z.strictObject({ status: z.literal('duplicate') }),
  z.strictObject({ status: z.literal('not-applied') }),
  z.strictObject({ status: z.literal('indeterminate') }),
]);

export type InvitationEmailTransportMessage = DeepReadonly<
  z.output<typeof InvitationEmailTransportMessageSchema>
>;

export interface InvitationEmailSenderConfiguration {
  readonly applicationOrigin: string;
}

export const INVITATION_TRANSPORT_TIMEOUT_MS = 15_000;

const TRANSPORT_ABORTED = Symbol('transport-aborted');

const runBoundedTransport = async (
  signal: AbortSignal,
  operation: (boundedSignal: AbortSignal) => Promise<unknown>,
): Promise<unknown | typeof TRANSPORT_ABORTED> => {
  signal.throwIfAborted();
  const timeoutController = new AbortController();
  const boundedSignal = AbortSignal.any([signal, timeoutController.signal]);
  let resolveAbort: ((value: typeof TRANSPORT_ABORTED) => void) | undefined;
  const aborted = new Promise<typeof TRANSPORT_ABORTED>((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = (): void => resolveAbort?.(TRANSPORT_ABORTED);
  boundedSignal.addEventListener('abort', onAbort, { once: true });
  if (boundedSignal.aborted) onAbort();
  const timeout = setTimeout(
    () => timeoutController.abort(),
    INVITATION_TRANSPORT_TIMEOUT_MS,
  );
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(boundedSignal)),
      aborted,
    ]);
  } finally {
    clearTimeout(timeout);
    boundedSignal.removeEventListener('abort', onAbort);
  }
};

const captureTransportSend = (
  transport: TransactionalEmailTransport,
): TransactionalEmailTransport['send'] => {
  try {
    if (transport === null || typeof transport !== 'object') {
      throw new Error('invalid');
    }
    let current: object | null = transport;
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'send');
      if (descriptor !== undefined) {
        if (
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          typeof descriptor.value !== 'function'
        ) {
          throw new Error('invalid');
        }
        return descriptor.value.bind(
          transport,
        ) as TransactionalEmailTransport['send'];
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    throw new Error('invalid');
  } catch {
    throw new Error('Invitation email transport is invalid');
  }
};

const parseApplicationOrigin = (value: string): string => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.origin !== value.replace(/\/$/u, '')
    ) {
      throw new Error('invalid');
    }
    return url.origin;
  } catch {
    throw new Error('Invitation email configuration is invalid');
  }
};

const ownInvitationTokenBytes = (input: unknown): Uint8Array | undefined => {
  try {
    if (
      input === null ||
      typeof input !== 'object' ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null)
    ) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      input,
      'invitationTokenBytes',
    );
    return descriptor !== undefined &&
      descriptor.get === undefined &&
      descriptor.set === undefined &&
      descriptor.value instanceof Uint8Array
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
};

export class InvitationEmailSender {
  readonly #sendTransport: TransactionalEmailTransport['send'];
  readonly #applicationOrigin: string;

  constructor(
    transport: TransactionalEmailTransport,
    configuration: InvitationEmailSenderConfiguration,
  ) {
    this.#sendTransport = captureTransportSend(transport);
    this.#applicationOrigin = parseApplicationOrigin(
      configuration.applicationOrigin,
    );
  }

  async send(
    input: unknown,
    context: { readonly signal: AbortSignal },
  ): Promise<{
    readonly status: 'sent' | 'duplicate' | 'not-applied' | 'indeterminate';
  }> {
    const tokenBytes = ownInvitationTokenBytes(input);
    try {
      context.signal.throwIfAborted();
      const parsed = InvitationEmailInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error('Invitation email request is invalid');
      }
      const invitationToken = Buffer.from(
        parsed.data.invitationTokenBytes.buffer,
        parsed.data.invitationTokenBytes.byteOffset,
        parsed.data.invitationTokenBytes.byteLength,
      ).toString('ascii');
      const redemptionUrl = new URL('/invite', this.#applicationOrigin);
      redemptionUrl.searchParams.set('invitationId', parsed.data.invitationId);
      redemptionUrl.searchParams.set('token', invitationToken);
      redemptionUrl.searchParams.set('email', parsed.data.recipient);
      const message: InvitationEmailTransportMessage = deepFreeze(
        InvitationEmailTransportMessageSchema.parse({
          schemaVersion: 1,
          deliveryId: parsed.data.operationId,
          recipient: parsed.data.recipient,
          subject: "You're invited to EMDO",
          text: `Join your household in EMDO: ${redemptionUrl.href}`,
          contentClassification: 'invitation-redemption-link',
        }),
      );

      let rawResult: unknown;
      try {
        rawResult = await runBoundedTransport(context.signal, (signal) =>
          this.#sendTransport(message, { signal }),
        );
      } catch {
        return deepFreeze({ status: 'indeterminate' as const });
      }
      if (rawResult === TRANSPORT_ABORTED) {
        return deepFreeze({ status: 'indeterminate' as const });
      }
      const result = InvitationEmailTransportResultSchema.safeParse(rawResult);
      if (!result.success) {
        return deepFreeze({ status: 'indeterminate' as const });
      }
      return deepFreeze({ status: result.data.status });
    } finally {
      tokenBytes?.fill(0);
    }
  }
}

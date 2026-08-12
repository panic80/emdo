import {
  IdempotencyKeySchema,
  OpaqueReferenceSchema,
  deepFreeze,
  type DeepReadonly,
} from '@emdo/contracts';
import { z } from 'zod';

const EmailNotificationInputSchema = z.strictObject({
  deliveryId: IdempotencyKeySchema,
  recipient: z.email().max(320),
});

const EmailTransportMessageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  deliveryId: IdempotencyKeySchema,
  recipient: z.email().max(320),
  subject: z.literal('You have a new EMDO update'),
  text: z.string().max(1_000),
  contentClassification: z.literal('redacted-notification-preview'),
});

const EmailTransportResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('sent'),
    providerMessageReference: OpaqueReferenceSchema,
  }),
  z.strictObject({ status: z.literal('duplicate') }),
  z.strictObject({ status: z.literal('not-applied') }),
  z.strictObject({ status: z.literal('indeterminate') }),
]);

export type EmailTransportMessage = DeepReadonly<
  z.output<typeof EmailTransportMessageSchema>
>;

export type TransactionalEmailMessage = DeepReadonly<{
  readonly schemaVersion: 1;
  readonly deliveryId: string;
  readonly recipient: string;
  readonly subject: string;
  readonly text: string;
  readonly contentClassification:
    'redacted-notification-preview' | 'invitation-redemption-link';
}>;

export interface TransactionalEmailTransport {
  /**
   * Provider-specific worker implementation point. Callers receive a bounded,
   * validated message and must use deliveryId as the provider idempotency key.
   * Invitation messages contain a redemption credential and must never be
   * logged, persisted outside the provider request, or copied into outcomes.
   */
  send(
    message: TransactionalEmailMessage,
    context: { readonly signal: AbortSignal },
  ): Promise<unknown>;
}

export interface EmailNotificationSenderConfiguration {
  readonly applicationOrigin: string;
}

export const NOTIFICATION_TRANSPORT_TIMEOUT_MS = 15_000;

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
    NOTIFICATION_TRANSPORT_TIMEOUT_MS,
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
    throw new Error('Email notification transport is invalid');
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
      url.origin !== value.replace(/\/$/, '')
    ) {
      throw new Error('invalid');
    }
    return url.origin;
  } catch {
    throw new Error('Email notification configuration is invalid');
  }
};

/**
 * The public API intentionally accepts no subject or body. This makes the
 * privacy-preserving external preview an invariant instead of a caller flag.
 */
export class EmailNotificationSender {
  readonly #sendTransport: TransactionalEmailTransport['send'];
  readonly #activityUrl: string;

  constructor(
    transport: TransactionalEmailTransport,
    configuration: EmailNotificationSenderConfiguration,
  ) {
    this.#sendTransport = captureTransportSend(transport);
    this.#activityUrl = `${parseApplicationOrigin(configuration.applicationOrigin)}/activity`;
  }

  async send(
    input: unknown,
    context: { readonly signal: AbortSignal },
  ): Promise<{
    readonly status: 'sent' | 'duplicate' | 'not-applied' | 'indeterminate';
  }> {
    context.signal.throwIfAborted();
    const parsed = EmailNotificationInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error('Email notification request is invalid');
    }
    const message = deepFreeze(
      EmailTransportMessageSchema.parse({
        schemaVersion: 1,
        deliveryId: parsed.data.deliveryId,
        recipient: parsed.data.recipient,
        subject: 'You have a new EMDO update',
        text: `Open EMDO to view this update: ${this.#activityUrl}`,
        contentClassification: 'redacted-notification-preview',
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
    const result = EmailTransportResultSchema.safeParse(rawResult);
    if (!result.success) {
      return deepFreeze({ status: 'indeterminate' as const });
    }
    return deepFreeze({ status: result.data.status });
  }
}

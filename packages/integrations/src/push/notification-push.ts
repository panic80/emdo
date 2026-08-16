import {
  IdempotencyKeySchema,
  OpaqueReferenceSchema,
  deepFreeze,
  type DeepReadonly,
} from '@emdo/contracts';
import { z } from 'zod';

const PushNotificationInputSchema = z.strictObject({
  deliveryId: IdempotencyKeySchema,
  subscriptionReference: OpaqueReferenceSchema,
});

const PushTransportMessageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  deliveryId: IdempotencyKeySchema,
  subscriptionReference: OpaqueReferenceSchema,
  title: z.literal('EMDO update'),
  body: z.literal('Open EMDO to view the latest update.'),
  url: z.literal('/activity'),
  tag: z.literal('emdo-notification'),
  contentClassification: z.literal('redacted-notification-preview'),
});

const PushTransportResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('sent'),
    providerMessageReference: OpaqueReferenceSchema,
  }),
  z.strictObject({ status: z.literal('duplicate') }),
  z.strictObject({ status: z.literal('gone') }),
  z.strictObject({ status: z.literal('not-applied') }),
  z.strictObject({ status: z.literal('indeterminate') }),
]);

export type PushTransportMessage = DeepReadonly<
  z.output<typeof PushTransportMessageSchema>
>;

export interface WebPushTransport {
  /**
   * Resolves subscriptionReference inside the credential boundary. Endpoint
   * keys and authorization material must never be placed in a worker job.
   */
  send(
    message: PushTransportMessage,
    context: { readonly signal: AbortSignal },
  ): Promise<unknown>;
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
  transport: WebPushTransport,
): WebPushTransport['send'] => {
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
        return descriptor.value.bind(transport) as WebPushTransport['send'];
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    throw new Error('invalid');
  } catch {
    throw new Error('Push notification transport is invalid');
  }
};

/** Fixed-preview Web Push boundary; arbitrary caller content is impossible. */
export class PushNotificationSender {
  readonly #sendTransport: WebPushTransport['send'];

  constructor(transport: WebPushTransport) {
    this.#sendTransport = captureTransportSend(transport);
  }

  async send(
    input: unknown,
    context: { readonly signal: AbortSignal },
  ): Promise<{
    readonly status:
      'sent' | 'duplicate' | 'gone' | 'not-applied' | 'indeterminate';
  }> {
    context.signal.throwIfAborted();
    const parsed = PushNotificationInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error('Push notification request is invalid');
    }
    const message = deepFreeze(
      PushTransportMessageSchema.parse({
        schemaVersion: 1,
        deliveryId: parsed.data.deliveryId,
        subscriptionReference: parsed.data.subscriptionReference,
        title: 'EMDO update',
        body: 'Open EMDO to view the latest update.',
        url: '/activity',
        tag: 'emdo-notification',
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
    const result = PushTransportResultSchema.safeParse(rawResult);
    if (!result.success) {
      return deepFreeze({ status: 'indeterminate' as const });
    }
    return deepFreeze({ status: result.data.status });
  }
}

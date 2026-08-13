import { createHash } from 'node:crypto';

import { deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

import type { TransactionalEmailTransport } from './notification-email.js';

const ConfigurationSchema = z.strictObject({
  applicationOrigin: z
    .url({ protocol: /^https$/u })
    .max(512)
    .refine((value) => new URL(value).origin === value),
  timeoutMs: z.number().int().min(1).max(30_000).default(15_000),
});
const UserSchema = z.object({ id: z.uuid(), email: z.email().max(320) });
const ActionInputSchema = z.strictObject({
  user: UserSchema,
  token: z
    .string()
    .min(20)
    .max(2_048)
    .regex(/^[A-Za-z0-9._~-]+$/u),
  url: z.url({ protocol: /^https$/u }).max(4_096),
});
const DeliveryResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('sent'),
    providerMessageReference: z.string().trim().min(1).max(1_024),
  }),
  z.strictObject({ status: z.literal('duplicate') }),
  z.strictObject({ status: z.literal('not-applied') }),
  z.strictObject({ status: z.literal('indeterminate') }),
]);

const captureSend = (
  transport: TransactionalEmailTransport,
): TransactionalEmailTransport['send'] => {
  try {
    if (transport === null || typeof transport !== 'object') throw new Error();
    let current: object | null = transport;
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'send');
      if (descriptor !== undefined) {
        if (
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          typeof descriptor.value !== 'function'
        ) {
          throw new Error();
        }
        return descriptor.value.bind(
          transport,
        ) as TransactionalEmailTransport['send'];
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    throw new Error();
  } catch {
    throw new Error('Authentication email transport is invalid');
  }
};

const TRANSPORT_ABORTED = Symbol('authentication-email-transport-aborted');

const runBoundedSend = async (
  send: TransactionalEmailTransport['send'],
  message: Parameters<TransactionalEmailTransport['send']>[0],
  requestSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown | typeof TRANSPORT_ABORTED> => {
  const timeoutController = new AbortController();
  const signal =
    requestSignal === undefined
      ? timeoutController.signal
      : AbortSignal.any([requestSignal, timeoutController.signal]);
  let resolveAbort: ((value: typeof TRANSPORT_ABORTED) => void) | undefined;
  const aborted = new Promise<typeof TRANSPORT_ABORTED>((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = (): void => resolveAbort?.(TRANSPORT_ABORTED);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  try {
    return await Promise.race([
      Promise.resolve().then(() => send(message, { signal })),
      aborted,
    ]);
  } catch {
    return TRANSPORT_ABORTED;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }
};

const validateActionUrl = (
  kind: 'password-reset' | 'verification',
  rawUrl: string,
  token: string,
  applicationOrigin: string,
): string => {
  const url = new URL(rawUrl);
  const expectedPath =
    kind === 'password-reset'
      ? `/api/auth/reset-password/${token}`
      : '/api/auth/verify-email';
  const tokenMatches =
    kind === 'password-reset'
      ? url.pathname === expectedPath
      : url.pathname === expectedPath &&
        url.searchParams.getAll('token').length === 1 &&
        url.searchParams.get('token') === token;
  const callbackValues = url.searchParams.getAll('callbackURL');
  const callbackValue = callbackValues[0];
  const expectedQueryKeys =
    kind === 'password-reset' ? ['callbackURL'] : ['callbackURL', 'token'];
  const actualQueryKeys = [...url.searchParams.keys()].sort();
  const callbackIsSafe = (() => {
    if (
      callbackValues.length !== 1 ||
      callbackValue === undefined ||
      callbackValue.length === 0 ||
      callbackValue.length > 2_048 ||
      !callbackValue.startsWith('/') ||
      callbackValue.startsWith('//') ||
      callbackValue.includes('\\') ||
      [...callbackValue].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || (code >= 127 && code <= 159);
      })
    ) {
      return false;
    }
    try {
      return (
        new URL(callbackValue, applicationOrigin).origin === applicationOrigin
      );
    } catch {
      return false;
    }
  })();
  if (
    url.origin !== applicationOrigin ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    !tokenMatches ||
    !callbackIsSafe ||
    actualQueryKeys.length !== expectedQueryKeys.length ||
    actualQueryKeys.some((key, index) => key !== expectedQueryKeys[index])
  ) {
    throw new Error('Authentication email request is invalid');
  }
  return url.href;
};

const deliveryId = (
  kind: 'password-reset' | 'verification',
  userId: string,
  email: string,
  token: string,
): string =>
  `auth-email:${kind}:${createHash('sha256')
    .update('emdo.auth-email.v1', 'utf8')
    .update('\0', 'utf8')
    .update(kind, 'utf8')
    .update('\0', 'utf8')
    .update(userId, 'utf8')
    .update('\0', 'utf8')
    .update(email, 'utf8')
    .update('\0', 'utf8')
    .update(token, 'utf8')
    .digest('hex')}`;

export const createBetterAuthEmailCallbacks = (
  transport: TransactionalEmailTransport,
  configuration: {
    readonly applicationOrigin: string;
    readonly timeoutMs?: number;
  },
) => {
  const parsedConfiguration = ConfigurationSchema.safeParse(configuration);
  if (!parsedConfiguration.success) {
    throw new Error('Authentication email configuration is invalid');
  }
  const send = captureSend(transport);

  const deliver = async (
    kind: 'password-reset' | 'verification',
    input: unknown,
    request?: Request,
  ): Promise<void> => {
    const parsed = ActionInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error('Authentication email request is invalid');
    }
    const url = validateActionUrl(
      kind,
      parsed.data.url,
      parsed.data.token,
      parsedConfiguration.data.applicationOrigin,
    );
    const subject =
      kind === 'password-reset'
        ? 'Reset your EMDO password'
        : 'Verify your EMDO email';
    const message = deepFreeze({
      schemaVersion: 1 as const,
      deliveryId: deliveryId(
        kind,
        parsed.data.user.id,
        parsed.data.user.email,
        parsed.data.token,
      ),
      recipient: parsed.data.user.email,
      subject,
      text: `${subject}: ${url}`,
      contentClassification: 'authentication-action-link' as const,
    });
    const result = DeliveryResultSchema.safeParse(
      await runBoundedSend(
        send,
        message,
        request?.signal,
        parsedConfiguration.data.timeoutMs,
      ),
    );
    if (
      !result.success ||
      (result.data.status !== 'sent' && result.data.status !== 'duplicate')
    ) {
      throw new Error('Authentication email delivery failed');
    }
  };

  return Object.freeze({
    sendInvitationEmail: async (input?: unknown): Promise<void> => {
      void input;
      throw new Error('Better Auth organization invitations are disabled');
    },
    sendPasswordResetEmail: (
      input: unknown,
      request?: Request,
    ): Promise<void> => deliver('password-reset', input, request),
    sendVerificationEmail: (input: unknown, request?: Request): Promise<void> =>
      deliver('verification', input, request),
  });
};

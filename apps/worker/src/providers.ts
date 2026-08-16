import type { CalendarMaintenanceReadGateway } from '@emdo/db/worker';
import type {
  InvitationDeliverySecretOpeningBoundary,
  TransactionalEmailTransport,
} from '@emdo/integrations/email';
import type { WebPushTransport } from '@emdo/integrations/push';

export type WorkerProviderStatus = Readonly<{
  overall: 'available' | 'degraded';
  email: 'available' | 'unavailable';
  push: 'available' | 'unavailable';
  calendar: 'available' | 'unavailable';
  blockers: readonly WorkerProviderBlockerCode[];
}>;

export type WorkerProviderBlockerCode =
  | 'worker-email-adapter-unavailable'
  | 'worker-email-credentials-unavailable'
  | 'worker-email-readiness-failed'
  | 'worker-push-adapter-unavailable'
  | 'worker-push-credentials-unavailable'
  | 'worker-push-readiness-failed'
  | 'worker-calendar-adapter-unavailable'
  | 'worker-calendar-broker-unavailable'
  | 'worker-calendar-credentials-unavailable'
  | 'worker-calendar-readiness-failed';

export type WorkerProviderReadinessCheck = (input: {
  readonly signal: AbortSignal;
}) => Promise<unknown>;

export interface WorkerProviderRuntime {
  readonly status: WorkerProviderStatus;
  readonly email: TransactionalEmailTransport;
  readonly push: WebPushTransport;
  readonly calendar: CalendarMaintenanceReadGateway;
  readonly invitationSecrets: InvitationDeliverySecretOpeningBoundary;
  checkEmailReadiness: WorkerProviderReadinessCheck;
  checkPushReadiness: WorkerProviderReadinessCheck;
  checkCalendarReadiness: WorkerProviderReadinessCheck;
  close(): Promise<void>;
}

type Method = (...arguments_: never[]) => unknown;

const captureMethod = (target: object, name: string): Method => {
  let current: object | null = target;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        typeof descriptor.value !== 'function'
      ) {
        break;
      }
      return descriptor.value.bind(target) as Method;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new Error('invalid');
};

const BLOCKER_ORDER = [
  'worker-email-adapter-unavailable',
  'worker-email-credentials-unavailable',
  'worker-email-readiness-failed',
  'worker-push-adapter-unavailable',
  'worker-push-credentials-unavailable',
  'worker-push-readiness-failed',
  'worker-calendar-adapter-unavailable',
  'worker-calendar-broker-unavailable',
  'worker-calendar-credentials-unavailable',
  'worker-calendar-readiness-failed',
] as const satisfies readonly WorkerProviderBlockerCode[];

const BLOCKER_CODES = new Set<WorkerProviderBlockerCode>(BLOCKER_ORDER);

const parseBlockers = (
  input: unknown,
): readonly WorkerProviderBlockerCode[] => {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > 3
  ) {
    throw new Error('invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const expectedKeys = [
    ...Array.from({ length: input.length }, (_, index) => String(index)),
    'length',
  ];
  if (
    Reflect.ownKeys(descriptors).length !== expectedKeys.length ||
    expectedKeys.some((key) => {
      const descriptor = descriptors[key];
      return (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      );
    })
  ) {
    throw new Error('invalid');
  }
  const blockers = expectedKeys
    .filter((key) => key !== 'length')
    .map((key) => descriptors[key]!.value as unknown);
  if (
    blockers.some(
      (value): boolean =>
        typeof value !== 'string' ||
        !BLOCKER_CODES.has(value as WorkerProviderBlockerCode),
    ) ||
    new Set(blockers).size !== blockers.length
  ) {
    throw new Error('invalid');
  }
  const typed = blockers as WorkerProviderBlockerCode[];
  if (
    typed.some(
      (value, index) =>
        index > 0 &&
        BLOCKER_ORDER.indexOf(typed[index - 1]!) >=
          BLOCKER_ORDER.indexOf(value),
    )
  ) {
    throw new Error('invalid');
  }
  return Object.freeze([...typed]);
};

const blockerChannel = (
  blocker: WorkerProviderBlockerCode,
): 'email' | 'push' | 'calendar' => {
  if (blocker.startsWith('worker-email-')) return 'email';
  if (blocker.startsWith('worker-push-')) return 'push';
  return 'calendar';
};

const parseStatus = (input: unknown): WorkerProviderStatus => {
  if (
    input === null ||
    typeof input !== 'object' ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new Error('invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const expected = [
    'overall',
    'email',
    'push',
    'calendar',
    'blockers',
  ] as const;
  if (
    Reflect.ownKeys(descriptors).length !== expected.length ||
    expected.some((name) => {
      const descriptor = descriptors[name];
      return (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        (name === 'blockers'
          ? descriptor.value === null || typeof descriptor.value !== 'object'
          : typeof descriptor.value !== 'string')
      );
    })
  ) {
    throw new Error('invalid');
  }
  const status = input as WorkerProviderStatus;
  const blockers = parseBlockers(descriptors.blockers!.value);
  const channels = [status.email, status.push, status.calendar];
  if (
    (status.overall !== 'available' && status.overall !== 'degraded') ||
    channels.some(
      (value) => value !== 'available' && value !== 'unavailable',
    ) ||
    (status.overall === 'available' &&
      channels.some((value) => value !== 'available')) ||
    (status.overall === 'degraded' &&
      channels.every((value) => value === 'available')) ||
    (status.overall === 'available' && blockers.length > 0)
  ) {
    throw new Error('invalid');
  }
  for (const channel of ['email', 'push', 'calendar'] as const) {
    const channelBlockers = blockers.filter(
      (blocker) => blockerChannel(blocker) === channel,
    );
    if (
      (status[channel] === 'available' && channelBlockers.length > 0) ||
      (status[channel] === 'unavailable' && channelBlockers.length !== 1)
    ) {
      throw new Error('invalid');
    }
  }
  return Object.freeze({
    overall: status.overall,
    email: status.email,
    push: status.push,
    calendar: status.calendar,
    blockers,
  });
};

export const normalizeWorkerProviderRuntime = (
  input: unknown,
): WorkerProviderRuntime => {
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
    const expected = [
      'status',
      'email',
      'push',
      'calendar',
      'invitationSecrets',
      'checkEmailReadiness',
      'checkPushReadiness',
      'checkCalendarReadiness',
      'close',
    ] as const;
    if (
      Reflect.ownKeys(descriptors).length !== expected.length ||
      expected.some((name) => {
        const descriptor = descriptors[name];
        if (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          return true;
        }
        return name === 'close' || name.startsWith('check')
          ? typeof descriptor.value !== 'function'
          : descriptor.value === null || typeof descriptor.value !== 'object';
      })
    ) {
      throw new Error('invalid');
    }
    const runtime = input as WorkerProviderRuntime;
    const email = Object.freeze({
      send: captureMethod(
        runtime.email,
        'send',
      ) as TransactionalEmailTransport['send'],
    });
    const push = Object.freeze({
      send: captureMethod(runtime.push, 'send') as WebPushTransport['send'],
    });
    const calendar = Object.freeze({
      synchronize: captureMethod(
        runtime.calendar,
        'synchronize',
      ) as CalendarMaintenanceReadGateway['synchronize'],
      readBackAttempt: captureMethod(
        runtime.calendar,
        'readBackAttempt',
      ) as CalendarMaintenanceReadGateway['readBackAttempt'],
    });
    const invitationSecrets = Object.freeze({
      withOpenedSecret: captureMethod(
        runtime.invitationSecrets,
        'withOpenedSecret',
      ) as InvitationDeliverySecretOpeningBoundary['withOpenedSecret'],
    });
    return Object.freeze({
      status: parseStatus(runtime.status),
      email,
      push,
      calendar,
      invitationSecrets,
      checkEmailReadiness: captureMethod(
        runtime,
        'checkEmailReadiness',
      ) as WorkerProviderReadinessCheck,
      checkPushReadiness: captureMethod(
        runtime,
        'checkPushReadiness',
      ) as WorkerProviderReadinessCheck,
      checkCalendarReadiness: captureMethod(
        runtime,
        'checkCalendarReadiness',
      ) as WorkerProviderReadinessCheck,
      close: captureMethod(runtime, 'close') as WorkerProviderRuntime['close'],
    });
  } catch {
    throw new Error('Worker provider runtime is unavailable');
  }
};

const isExactAvailableResult = (input: unknown): boolean => {
  if (
    input === null ||
    typeof input !== 'object' ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const descriptor = descriptors.status;
  return (
    Reflect.ownKeys(descriptors).length === 1 &&
    descriptor !== undefined &&
    descriptor.get === undefined &&
    descriptor.set === undefined &&
    descriptor.value === 'available'
  );
};

export const checkWorkerProviderReadiness = async (
  runtime: WorkerProviderRuntime,
  input: { readonly timeoutMs: number },
): Promise<WorkerProviderStatus> => {
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 30_000
  ) {
    throw new Error('Worker provider readiness configuration is invalid');
  }
  const normalized = normalizeWorkerProviderRuntime(runtime);
  const controller = new AbortController();
  let resolveAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = (): void => resolveAbort?.();
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const checks = [
    normalized.checkEmailReadiness,
    normalized.checkPushReadiness,
    normalized.checkCalendarReadiness,
  ] as const;
  let results: readonly boolean[];
  try {
    results = await Promise.all(
      checks.map(async (check) => {
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => check({ signal: controller.signal })),
            aborted.then(() => null),
          ]);
          return isExactAvailableResult(result);
        } catch {
          return false;
        }
      }),
    );
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener('abort', onAbort);
  }
  const channels = ['email', 'push', 'calendar'] as const;
  const availability = Object.fromEntries(
    channels.map((channel, index) => [
      channel,
      results[index] ? 'available' : 'unavailable',
    ]),
  ) as Record<(typeof channels)[number], 'available' | 'unavailable'>;
  const blockers = Object.freeze(
    channels.flatMap((channel, index) =>
      results[index]
        ? []
        : ([
            `worker-${channel}-readiness-failed`,
          ] as WorkerProviderBlockerCode[]),
    ),
  );
  return Object.freeze({
    overall: blockers.length === 0 ? 'available' : 'degraded',
    ...availability,
    blockers,
  });
};

/**
 * Safe built-in boundary for an MVP deployment without provider credentials.
 * It never claims delivery, Calendar evidence, or mutation success.
 */
export const createUnavailableWorkerProviderRuntime =
  (): WorkerProviderRuntime =>
    normalizeWorkerProviderRuntime({
      status: {
        overall: 'degraded',
        email: 'unavailable',
        push: 'unavailable',
        calendar: 'unavailable',
        blockers: [
          'worker-email-adapter-unavailable',
          'worker-push-adapter-unavailable',
          'worker-calendar-broker-unavailable',
        ],
      },
      email: {
        async send() {
          return Object.freeze({ status: 'not-applied' as const });
        },
      },
      push: {
        async send() {
          return Object.freeze({ status: 'not-applied' as const });
        },
      },
      calendar: {
        async synchronize() {
          return Object.freeze({ status: 'provider-unavailable' as const });
        },
        async readBackAttempt() {
          return Object.freeze({ status: 'provider-unavailable' as const });
        },
      },
      invitationSecrets: {
        async withOpenedSecret() {
          throw new Error('Invitation delivery secret opener is unavailable');
        },
      },
      async checkEmailReadiness() {
        return Object.freeze({ status: 'unavailable' as const });
      },
      async checkPushReadiness() {
        return Object.freeze({ status: 'unavailable' as const });
      },
      async checkCalendarReadiness() {
        return Object.freeze({ status: 'unavailable' as const });
      },
      async close() {},
    });

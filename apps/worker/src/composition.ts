import {
  EmailNotificationSender,
  InvitationEmailSender,
} from '@emdo/integrations/email';
import type {
  InvitationDeliverySecretOpeningBoundary,
  TransactionalEmailTransport,
} from '@emdo/integrations/email';
import { PushNotificationSender } from '@emdo/integrations/push';
import type { WebPushTransport } from '@emdo/integrations/push';

import type { WorkerJobDependencies } from './jobs.js';
import {
  createInvitationDeliveryService,
  type InvitationDeliveryRepository,
} from './invitations.js';
import {
  createNotificationDeliveryService,
  type NotificationDeliveryRepository,
} from './notifications.js';
import {
  startWorkerOutboxDispatcher,
  type WorkerOutboxRepository,
} from './outbox.js';
import type { WorkerProcessComposition } from './process.js';
import type { WorkerProviderStatus } from './providers.js';

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
  throw new Error('Worker repository boundary is invalid');
};

export interface WorkerCompositionRepositories {
  readonly executions: WorkerJobDependencies['executions'];
  readonly reminders: WorkerJobDependencies['reminders'];
  readonly calendar: WorkerJobDependencies['calendar'];
  readonly notifications: NotificationDeliveryRepository;
  readonly invitations: InvitationDeliveryRepository;
  readonly outbox: WorkerOutboxRepository;
  close(): Promise<void>;
}

export interface WorkerProviderBindings {
  readonly email: TransactionalEmailTransport;
  readonly push: WebPushTransport;
  readonly invitationSecrets: InvitationDeliverySecretOpeningBoundary;
}

export const createWorkerComposition = (input: {
  readonly applicationOrigin: string;
  readonly providerStatus: WorkerProviderStatus;
  readonly repositories: WorkerCompositionRepositories;
  readonly providers: WorkerProviderBindings;
  readonly outbox: {
    readonly dispatcherId: string;
    readonly pollIntervalMs: number;
    readonly batchLimit: number;
    readonly leaseMs: number;
  };
}): WorkerProcessComposition => {
  const email = new EmailNotificationSender(input.providers.email, {
    applicationOrigin: input.applicationOrigin,
  });
  const invitationEmail = new InvitationEmailSender(input.providers.email, {
    applicationOrigin: input.applicationOrigin,
  });
  const push = new PushNotificationSender(input.providers.push);
  const notifications = createNotificationDeliveryService({
    repository: input.repositories.notifications,
    email,
    push,
  });
  const invitations = createInvitationDeliveryService({
    repository: input.repositories.invitations,
    opener: input.providers.invitationSecrets,
    email: invitationEmail,
  });
  const outbox: WorkerOutboxRepository = Object.freeze({
    listDue: captureMethod(
      input.repositories.outbox as object,
      'listDue',
    ) as WorkerOutboxRepository['listDue'],
    bindQueueJob: captureMethod(
      input.repositories.outbox as object,
      'bindQueueJob',
    ) as WorkerOutboxRepository['bindQueueJob'],
    markEnqueued: captureMethod(
      input.repositories.outbox as object,
      'markEnqueued',
    ) as WorkerOutboxRepository['markEnqueued'],
    markDispatchFailed: captureMethod(
      input.repositories.outbox as object,
      'markDispatchFailed',
    ) as WorkerOutboxRepository['markDispatchFailed'],
  });
  const closeRepositories = captureMethod(
    input.repositories as object,
    'close',
  ) as WorkerCompositionRepositories['close'];
  const jobDependencies: WorkerJobDependencies = Object.freeze({
    executions: input.repositories.executions,
    reminders: input.repositories.reminders,
    calendar: input.repositories.calendar,
    notifications,
    invitations,
  });

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    providerStatus: Object.freeze({ ...input.providerStatus }),
    jobDependencies,
    startOutboxDispatcher({
      signal,
      enqueue,
      onFatalError,
    }: Parameters<WorkerProcessComposition['startOutboxDispatcher']>[0]) {
      return startWorkerOutboxDispatcher({
        repository: outbox,
        enqueue,
        dispatcherId: input.outbox.dispatcherId,
        pollIntervalMs: input.outbox.pollIntervalMs,
        batchLimit: input.outbox.batchLimit,
        leaseMs: input.outbox.leaseMs,
        signal,
        onFatalError,
      });
    },
    close(): Promise<void> {
      closePromise ??= closeRepositories();
      return closePromise;
    },
  });
};

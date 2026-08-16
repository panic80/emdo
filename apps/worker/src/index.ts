import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runWorkerEntrypoint } from './entrypoint.js';
import { createDirectProductionWorkerComposition } from './production.js';

export * from './composition.js';
export * from './entrypoint.js';
export * from './health.js';
export * from './job-schema.js';
export * from './jobs.js';
export * from './invitations.js';
export * from './main.js';
export * from './notifications.js';
export {
  dispatchWorkerOutboxOnce,
  startWorkerOutboxDispatcher,
  type WorkerOutboxEnqueue,
  type WorkerOutboxRepository,
} from './outbox.js';
export * from './process.js';
export * from './production.js';
export * from './providers.js';
export * from './reconciliation.js';

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  void runWorkerEntrypoint({
    environment: process.env,
    createComposition: ({ environment }) =>
      createDirectProductionWorkerComposition({ environment }),
  }).catch(() => {
    process.stderr.write('Worker startup failed.\n');
    process.exitCode = 1;
  });
}

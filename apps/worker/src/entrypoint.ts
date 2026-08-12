import { startWorkerProcess, type WorkerProcessHandle } from './process.js';

type WorkerProcessInput = Parameters<typeof startWorkerProcess>[0];

export interface WorkerEntrypointRuntime {
  exitCode: number | undefined;
  readonly stderr: { write(message: string): unknown };
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export const runWorkerEntrypoint = async (input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly createComposition: WorkerProcessInput['createComposition'];
  readonly runtime?: WorkerEntrypointRuntime;
  readonly startProcess?: (
    input: WorkerProcessInput,
  ) => Promise<WorkerProcessHandle>;
}): Promise<WorkerProcessHandle> => {
  const runtime = input.runtime ?? process;
  const reportedCodes = new Set<string>();
  const processHandle = await (input.startProcess ?? startWorkerProcess)({
    environment: input.environment,
    createComposition: input.createComposition,
    onOperationalEvent(event) {
      runtime.exitCode = 1;
      if (reportedCodes.has(event.code)) return;
      reportedCodes.add(event.code);
      runtime.stderr.write(`Worker operational failure: ${event.code}.\n`);
    },
  });

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      runtime.off('SIGTERM', onSignal);
      runtime.off('SIGINT', onSignal);
      await processHandle.stop();
    })();
    return stopPromise;
  };
  const onSignal = (): void => {
    void stop().catch(() => {
      runtime.exitCode = 1;
      runtime.stderr.write('Worker shutdown failed.\n');
    });
  };
  runtime.once('SIGTERM', onSignal);
  runtime.once('SIGINT', onSignal);

  return Object.freeze({ stop });
};

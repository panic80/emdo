import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { runWorkerEntrypoint } from './entrypoint.js';

class FakeRuntime extends EventEmitter {
  readonly messages: string[] = [];
  exitCode: number | undefined;
  readonly stderr = {
    write: (message: string) => {
      this.messages.push(message);
      return true;
    },
  };
}

describe('worker process entrypoint', () => {
  it('installs graceful signals and stops exactly once', async () => {
    const runtime = new FakeRuntime();
    let stops = 0;
    const handle = await runWorkerEntrypoint({
      environment: {},
      createComposition: async () => {
        throw new Error('not used');
      },
      runtime,
      startProcess: async () => ({
        async stop() {
          stops += 1;
        },
      }),
    });

    runtime.emit('SIGTERM');
    runtime.emit('SIGINT');
    await new Promise<void>((resolve) => setImmediate(resolve));
    await handle.stop();
    expect(stops).toBe(1);
    expect(runtime.listenerCount('SIGTERM')).toBe(0);
    expect(runtime.listenerCount('SIGINT')).toBe(0);
    expect(runtime.exitCode).toBeUndefined();
  });

  it('emits only a safe operational code and marks fatal runtime shutdown', async () => {
    const runtime = new FakeRuntime();
    await runWorkerEntrypoint({
      environment: {},
      createComposition: async () => {
        throw new Error('not used');
      },
      runtime,
      startProcess: async (input) => {
        input.onOperationalEvent?.({ code: 'queue-runtime-error' });
        return { async stop() {} };
      },
    });

    expect(runtime.exitCode).toBe(1);
    expect(runtime.messages).toEqual([
      'Worker operational failure: queue-runtime-error.\n',
    ]);
  });
});

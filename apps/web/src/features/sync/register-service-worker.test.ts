import { describe, expect, it, vi } from 'vitest';

import { createServiceWorkerUpdateLifecycle } from './register-service-worker.js';

describe('service worker update lifecycle', () => {
  it('keeps the old client controlled until a confirmed waiting worker activates and then reloads', async () => {
    const handlers = new Map<string, () => void>();
    const messageSkipWaiting = vi.fn();
    const dispatchUpdateWaiting = vi.fn();
    const reload = vi.fn();
    const workbox = {
      addEventListener: vi.fn((type: string, listener: () => void) => {
        handlers.set(type, listener);
      }),
      messageSkipWaiting,
    };
    const lifecycle = createServiceWorkerUpdateLifecycle({
      dispatchUpdateWaiting,
      reload,
    });

    lifecycle.bind(workbox);
    handlers.get('waiting')?.();

    expect(lifecycle.coordinator.snapshot().state).toBe('update-ready');
    expect(messageSkipWaiting).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    handlers.get('activated')?.();
    expect(reload).not.toHaveBeenCalled();

    await lifecycle.coordinator.apply();

    expect(messageSkipWaiting).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();

    handlers.get('activated')?.();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(dispatchUpdateWaiting).toHaveBeenCalledTimes(1);
  });
});

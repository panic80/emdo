import { describe, expect, it, vi } from 'vitest';

import {
  LogoutFlowController,
  SafeUpdateCoordinator,
  type LogoutBoundaryAdapter,
} from './update-coordinator.js';

describe('safe service worker updates', () => {
  it('does not activate a waiting worker while local changes are pending', async () => {
    const activateWaitingWorker = vi.fn(async () => undefined);
    const coordinator = new SafeUpdateCoordinator({ activateWaitingWorker });
    coordinator.setPendingChanges(2);
    coordinator.markUpdateWaiting();

    await expect(coordinator.apply()).rejects.toThrow(
      'Sync or discard local changes before updating EMDO.',
    );
    expect(activateWaitingWorker).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toEqual({
      state: 'blocked-pending-changes',
      pendingChanges: 2,
    });
  });

  it('activates a waiting worker only after pending changes reach zero', async () => {
    const activateWaitingWorker = vi.fn(async () => undefined);
    const coordinator = new SafeUpdateCoordinator({ activateWaitingWorker });
    coordinator.markUpdateWaiting();

    await coordinator.apply();

    expect(activateWaitingWorker).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot().state).toBe('activating');
  });
});

describe('logout purge UI boundary', () => {
  function adapter(
    overrides: Partial<LogoutBoundaryAdapter> = {},
  ): LogoutBoundaryAdapter {
    return {
      inspect: vi.fn(async () => ({ pendingOperations: 3 })),
      syncAndPurge: vi.fn(async () => ({ status: 'complete' as const })),
      discardAndPurge: vi.fn(async () => ({ status: 'complete' as const })),
      ...overrides,
    };
  }

  it('requires sync-now or an explicit discard decision when operations are pending', async () => {
    const controller = new LogoutFlowController(adapter());

    await controller.begin();

    expect(controller.snapshot()).toEqual({
      state: 'decision-required',
      pendingOperations: 3,
    });
  });

  it('still revokes the server session and purges local data when no operations are pending', async () => {
    const boundary = adapter({
      inspect: vi.fn(async () => ({ pendingOperations: 0 })),
    });
    const controller = new LogoutFlowController(boundary);

    await controller.begin();

    expect(boundary.syncAndPurge).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()).toEqual({ state: 'complete' });
  });

  it('does not discard until the user repeats an explicit destructive confirmation', async () => {
    const boundary = adapter();
    const controller = new LogoutFlowController(boundary);
    await controller.begin();

    await controller.discard('DISCARD');
    expect(boundary.discardAndPurge).not.toHaveBeenCalled();
    expect(controller.snapshot().state).toBe('decision-required');

    await controller.discard('DISCARD OFFLINE CHANGES');
    expect(boundary.discardAndPurge).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().state).toBe('complete');
  });

  it.each([
    ['sync-failed', 'sync-failed'],
    ['logout-blocked', 'logout-blocked'],
    ['incomplete', 'incomplete'],
  ] as const)(
    'surfaces %s without claiming logout completed',
    async (status, expected) => {
      const controller = new LogoutFlowController(
        adapter({ syncAndPurge: vi.fn(async () => ({ status })) }),
      );
      await controller.begin();

      await controller.syncNow();

      expect(controller.snapshot().state).toBe(expected);
    },
  );
});

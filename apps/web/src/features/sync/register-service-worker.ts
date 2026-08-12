import { Workbox } from 'workbox-window';

import { SafeUpdateCoordinator } from './update-coordinator.js';

interface UpdateWorkbox {
  readonly addEventListener: (
    type: 'waiting' | 'activated',
    listener: () => void,
  ) => void;
  readonly messageSkipWaiting: () => void;
}

export function createServiceWorkerUpdateLifecycle(dependencies: {
  readonly dispatchUpdateWaiting: () => void;
  readonly reload: () => void;
}) {
  let waitingWorkbox: UpdateWorkbox | undefined;
  const coordinator = new SafeUpdateCoordinator({
    activateWaitingWorker: async () => {
      if (!waitingWorkbox)
        throw new Error('No waiting service worker is available.');
      waitingWorkbox.messageSkipWaiting();
    },
  });

  return {
    coordinator,
    bind(workbox: UpdateWorkbox): void {
      workbox.addEventListener('waiting', () => {
        waitingWorkbox = workbox;
        coordinator.markUpdateWaiting();
        dependencies.dispatchUpdateWaiting();
      });
      workbox.addEventListener('activated', () => {
        // `clientsClaim()` is intentionally disabled: the confirmed waiting
        // worker activates without replacing the controller for this document.
        // Reload only after activation so the next navigation is controlled by
        // the new worker, while first-install activation remains non-disruptive.
        if (coordinator.snapshot().state === 'activating') {
          dependencies.reload();
        }
      });
    },
  };
}

const serviceWorkerUpdateLifecycle = createServiceWorkerUpdateLifecycle({
  dispatchUpdateWaiting: () => {
    window.dispatchEvent(new CustomEvent('emdo:update-waiting'));
  },
  reload: () => window.location.reload(),
});

export const serviceWorkerUpdateCoordinator =
  serviceWorkerUpdateLifecycle.coordinator;

export async function registerServiceWorker(): Promise<void> {
  const buildEnvironment = (
    import.meta as ImportMeta & {
      readonly env?: { readonly PROD?: boolean };
    }
  ).env;
  if (!('serviceWorker' in navigator) || buildEnvironment?.PROD !== true)
    return;
  const workbox = new Workbox('/sw.js', { scope: '/' });
  serviceWorkerUpdateLifecycle.bind(workbox);
  await workbox.register();
}

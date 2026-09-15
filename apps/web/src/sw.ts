/// <reference lib="webworker" />

import {
  cleanupOutdatedCaches,
  matchPrecache,
  precacheAndRoute,
  type PrecacheEntry,
} from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope & {
  readonly __WB_MANIFEST: readonly PrecacheEntry[];
};

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  // The shared host serves a separate POS application under this prefix.
  // Its navigation must never fall back to EMDO's cached application shell.
  const pathname = new URL(event.request.url).pathname;
  if (pathname === '/pos' || pathname.startsWith('/pos/')) return;
  event.respondWith(
    (async () => {
      try {
        return await fetch(event.request);
      } catch {
        return (
          (await matchPrecache('/index.html')) ??
          new Response('EMDO offline shell is unavailable.', {
            status: 503,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          })
        );
      }
    })(),
  );
});

self.addEventListener('message', (event) => {
  if ((event.data as { type?: unknown } | undefined)?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

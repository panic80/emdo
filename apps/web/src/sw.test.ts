import { afterEach, expect, it, vi } from 'vitest';

vi.mock('workbox-precaching', () => ({
  cleanupOutdatedCaches: vi.fn(),
  precacheAndRoute: vi.fn(),
  matchPrecache: vi.fn(async () => new Response('EMDO cached shell')),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('leaves POS navigation to the browser while keeping EMDO offline navigation', async () => {
  let fetchHandler:
    | ((event: {
        request: { mode: string; url: string };
        respondWith: (response: Promise<Response>) => void;
      }) => void)
    | undefined;
  vi.stubGlobal('self', {
    __WB_MANIFEST: [],
    addEventListener: (type: string, handler: typeof fetchHandler) => {
      if (type === 'fetch') fetchHandler = handler;
    },
  });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  await import('./sw.js');
  expect(fetchHandler).toBeDefined();
  for (const path of [
    '/pos',
    '/pos/',
    '/pos/live/v6/',
    '/pos/live/?view=report',
  ]) {
    const respondWith = vi.fn();
    fetchHandler!({
      request: { mode: 'navigate', url: `https://bot.32cbgg8.com${path}` },
      respondWith,
    });
    expect(respondWith).not.toHaveBeenCalled();
  }
  let offlineResponse: Promise<Response> | undefined;
  fetchHandler!({
    request: { mode: 'navigate', url: 'https://bot.32cbgg8.com/finance' },
    respondWith: (response) => {
      offlineResponse = response;
    },
  });
  expect(await (await offlineResponse)?.text()).toBe('EMDO cached shell');
});

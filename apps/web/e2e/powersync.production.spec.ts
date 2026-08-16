import { expect, test, type Page } from '@playwright/test';

import { mockAuthenticatedSession } from './support.js';

interface IndexedDbSecurityState {
  readonly databaseNames: readonly string[];
  readonly wrappingKey: {
    readonly algorithm: string;
    readonly extractable: boolean;
    readonly usages: readonly KeyUsage[];
  } | null;
  readonly wrappedDatabaseKey: {
    readonly algorithm?: unknown;
    readonly ciphertextLength: number;
    readonly initializationVectorLength: number;
    readonly version?: unknown;
  } | null;
  readonly sessionState: {
    readonly bindingLength: number;
    readonly status?: unknown;
    readonly version?: unknown;
  } | null;
}

async function inspectDeviceKeyStorage(
  page: Page,
): Promise<IndexedDbSecurityState> {
  return page.evaluate(async () => {
    const open = indexedDB.open('emdo-device-secrets', 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () =>
        reject(open.error ?? new Error('Unable to inspect device keys'));
    });
    const transaction = database.transaction('device-secrets', 'readonly');
    const store = transaction.objectStore('device-secrets');
    const read = (key: string) =>
      new Promise<unknown>((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(request.error ?? new Error('Unable to inspect key record'));
      });
    const [wrappingKey, wrappedDatabaseKey, sessionState] = await Promise.all([
      read('wrapping-key'),
      read('wrapped-database-key'),
      read('session-state'),
    ]);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Key inspection failed'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Key inspection aborted'));
    });
    database.close();

    const key = wrappingKey instanceof CryptoKey ? wrappingKey : null;
    const wrapped =
      wrappedDatabaseKey && typeof wrappedDatabaseKey === 'object'
        ? (wrappedDatabaseKey as Record<string, unknown>)
        : null;
    const state =
      sessionState && typeof sessionState === 'object'
        ? (sessionState as Record<string, unknown>)
        : null;
    const databases =
      typeof indexedDB.databases === 'function'
        ? await indexedDB.databases()
        : [];
    return {
      databaseNames: databases.flatMap(({ name }) => (name ? [name] : [])),
      wrappingKey: key
        ? {
            algorithm: key.algorithm.name,
            extractable: key.extractable,
            usages: [...key.usages],
          }
        : null,
      wrappedDatabaseKey: wrapped
        ? {
            algorithm: wrapped.algorithm,
            ciphertextLength:
              typeof wrapped.ciphertext === 'string'
                ? wrapped.ciphertext.length
                : 0,
            initializationVectorLength:
              typeof wrapped.initializationVector === 'string'
                ? wrapped.initializationVector.length
                : 0,
            version: wrapped.version,
          }
        : null,
      sessionState: state
        ? {
            bindingLength:
              typeof state.sessionBinding === 'string'
                ? state.sessionBinding.length
                : 0,
            status: state.status,
            version: state.version,
          }
        : null,
    };
  });
}

async function listOpfsEntries(page: Page): Promise<readonly string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const entries: string[] = [];
    const isDirectoryHandle = (
      handle: FileSystemHandle,
    ): handle is FileSystemDirectoryHandle =>
      handle.kind === 'directory' && 'entries' in handle;
    const visit = async (
      directory: FileSystemDirectoryHandle,
      prefix = '',
    ): Promise<void> => {
      for await (const [name, handle] of directory.entries()) {
        const path = `${prefix}${name}`;
        entries.push(`${handle.kind}:${path}`);
        if (isDirectoryHandle(handle)) await visit(handle, `${path}/`);
      }
    };
    await visit(root);
    return entries.sort();
  });
}

test('production preview boots the pinned encrypted PowerSync OPFS runtime', async ({
  page,
}) => {
  const runtimeResponses = new Map<
    string,
    { readonly contentType: string; readonly status: number }
  >();
  const forbiddenWasmRequests: string[] = [];
  const credentialRequests: string[] = [];
  const replicationAttempts: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/sync/token')
      credentialRequests.push(url.href);
    if (url.pathname.startsWith('/powersync'))
      replicationAttempts.push(url.href);
  });
  page.on('websocket', (socket) => {
    const url = new URL(socket.url());
    if (url.pathname.startsWith('/powersync'))
      replicationAttempts.push(url.href);
  });
  page.on('response', (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.startsWith('/@powersync/')) {
      runtimeResponses.set(pathname, {
        contentType: response.headers()['content-type'] ?? '',
        status: response.status(),
      });
    }
    if (
      /libpowersync[^/]*\.wasm$/iu.test(pathname) ||
      /\/(?:wa-sqlite)(?:-async)?-[^/]+\.wasm$/iu.test(pathname)
    ) {
      forbiddenWasmRequests.push(pathname);
    }
  });
  await mockAuthenticatedSession(page);

  await page.goto('/today');
  await expect(
    page.getByRole('heading', { name: 'Good morning' }),
  ).toBeVisible();
  await expect(
    page.getByText('Offline-ready · Sync starting', { exact: true }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/synced just now/iu)).toHaveCount(0);
  await expect
    .poll(() => credentialRequests.length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(() => replicationAttempts.length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  expect(
    replicationAttempts.every((requestUrl) => {
      const attempt = new URL(requestUrl);
      return (
        attempt.origin === new URL(page.url()).origin &&
        attempt.pathname.startsWith('/powersync')
      );
    }),
  ).toBe(true);
  await expect(
    page.getByText(/live replication|live sync|provider connected/iu),
  ).toHaveCount(0);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });

  await expect
    .poll(() => [...runtimeResponses.keys()], { timeout: 30_000 })
    .toEqual(
      expect.arrayContaining([
        '/@powersync/worker.js',
        '/@powersync/OPFSCoopSyncVFS-BgTiWPfa.js',
        '/@powersync/assets/mc-wa-sqlite-DoDpgFfE.wasm',
      ]),
    );
  for (const [pathname, response] of runtimeResponses) {
    expect(response.status, pathname).toBe(200);
    if (pathname.endsWith('.wasm')) {
      expect(response.contentType, pathname).toContain('application/wasm');
    }
  }
  expect(forbiddenWasmRequests).toEqual([]);

  const keyState = await inspectDeviceKeyStorage(page);
  expect(keyState.databaseNames).toEqual(
    expect.arrayContaining(['emdo-device-secrets', 'emdo-browser-metadata-v1']),
  );
  expect(keyState.wrappingKey).toEqual({
    algorithm: 'AES-GCM',
    extractable: false,
    usages: ['encrypt', 'decrypt'],
  });
  expect(keyState.wrappedDatabaseKey).toMatchObject({
    algorithm: 'AES-GCM',
    version: 1,
  });
  expect(keyState.wrappedDatabaseKey?.ciphertextLength).toBeGreaterThan(32);
  expect(
    keyState.wrappedDatabaseKey?.initializationVectorLength,
  ).toBeGreaterThan(8);
  expect(keyState.sessionState).toEqual({
    bindingLength: 64,
    status: 'active',
    version: 1,
  });

  const opfsEntries = await listOpfsEntries(page);
  expect(opfsEntries.length).toBeGreaterThan(0);
  expect(
    opfsEntries.some((entry) => /(?:emdo\.sqlite3|\.ahp-)/u.test(entry)),
  ).toBe(true);

  const cachedPaths = await page.evaluate(async () => {
    const paths: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys())
        paths.push(new URL(request.url).pathname);
    }
    return paths;
  });
  expect(cachedPaths).toEqual(
    expect.arrayContaining([
      '/index.html',
      '/@powersync/worker.js',
      '/@powersync/assets/mc-wa-sqlite-DoDpgFfE.wasm',
      '/@powersync/assets/mc-wa-sqlite-async-DYagSq56.wasm',
    ]),
  );

  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  await page.unroute('**/api/auth/get-session');
  await page.context().setOffline(true);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await page.reload({ waitUntil: 'domcontentloaded' });
  expect((await inspectDeviceKeyStorage(page)).sessionState).toEqual({
    bindingLength: 64,
    status: 'active',
    version: 1,
  });
  await expect(
    page.getByRole('heading', { name: 'Good morning' }),
  ).toBeVisible();
  await expect(
    page.getByText('Offline · Local edits stay on this device', {
      exact: true,
    }),
  ).toBeVisible({ timeout: 30_000 });

  await page
    .getByRole('link', { name: 'Finance', exact: true })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Finance' })).toBeVisible();
  await page.getByRole('button', { name: 'Add transaction' }).click();
  await page.getByLabel('Description').fill('Offline transit pass');
  await page.getByLabel('Category').fill('Transport');
  await page.getByLabel('Amount (CAD)').fill('24.50');
  await page.getByLabel('Date').fill('2026-08-10');
  await page.getByRole('button', { name: 'Save transaction' }).click();

  const transactionRow = page
    .getByRole('table', { name: 'Recent manual transactions' })
    .getByRole('row');
  await expect(transactionRow.getByRole('cell')).toHaveText([
    '08-10',
    'Offline transit pass',
    'Transport',
    '$24.50',
  ]);
  await expect(
    page.getByText('1 local change queued · Connect to sync'),
  ).toBeVisible();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Finance' })).toBeVisible();
  await expect(transactionRow.getByRole('cell')).toHaveText([
    '08-10',
    'Offline transit pass',
    'Transport',
    '$24.50',
  ]);
  await expect(
    page.getByText('1 local change queued · Connect to sync'),
  ).toBeVisible();
});

import { expect, test } from '@playwright/test';

import { mockAuthenticatedSession } from './support.js';

async function installVoiceBrowserMocks(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.addInitScript(() => {
    const track = { stop: () => undefined };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
    });
    class MemoryMediaRecorder extends EventTarget {
      public static isTypeSupported(): boolean {
        return true;
      }

      public state: 'inactive' | 'recording' = 'inactive';

      public start(): void {
        this.state = 'recording';
      }

      public stop(): void {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        const data = new Event('dataavailable');
        Object.defineProperty(data, 'data', {
          value: new Blob(['in-memory-voice'], { type: 'audio/webm' }),
        });
        this.dispatchEvent(data);
        this.dispatchEvent(new Event('stop'));
      }
    }
    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: MemoryMediaRecorder,
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:http://127.0.0.1/spoken-reply',
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: (value: string) => {
        (
          window as typeof window & { __revokedAudioUrls?: string[] }
        ).__revokedAudioUrls = [
          ...((window as typeof window & { __revokedAudioUrls?: string[] })
            .__revokedAudioUrls ?? []),
          value,
        ];
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: async () => undefined,
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value: () => undefined,
    });
  });
}

test.describe('push-to-talk ephemeral lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedSession(page);
    await installVoiceBrowserMocks(page);
  });

  test('records in memory, permits transcript correction, and revokes spoken audio', async ({
    context,
    page,
  }) => {
    let transcriptionContentType = '';
    let transcriptionBytes = 0;
    await page.route('**/api/v1/voice/transcribe?*', async (route) => {
      transcriptionContentType =
        route.request().headers()['content-type'] ?? '';
      transcriptionBytes = route.request().postDataBuffer()?.byteLength ?? 0;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'cache-control': 'no-store, private',
          pragma: 'no-cache',
          expires: '0',
          'x-content-type-options': 'nosniff',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          transcript: 'Book dentist Tuesday',
          model: 'gpt-4o-mini-transcribe',
          attempt: 'default',
          spendWarning: false,
          replayed: false,
        }),
      });
    });
    await page.route('**/api/v1/turns', async (route) => {
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          runId: '11111111-1111-4111-8111-111111111111',
          status: 'accepted',
          replayed: false,
          eventsPath:
            '/api/v1/runs/11111111-1111-4111-8111-111111111111/events',
        }),
      });
    });
    await page.route('**/api/v1/runs/*/events', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'id: 1\nevent: assistant.message\ndata: {"schemaVersion":1,"runId":"11111111-1111-4111-8111-111111111111","sequence":1,"type":"assistant.message","occurredAt":"2026-08-09T12:00:00.000Z","data":{"text":"I found three safe appointment options."}}\n\n',
      });
    });
    await page.route('**/api/v1/voice/speak', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'audio/mpeg',
        headers: {
          'cache-control': 'no-store, private',
          pragma: 'no-cache',
          expires: '0',
          'x-content-type-options': 'nosniff',
        },
        body: Buffer.from('ephemeral-spoken-summary'),
      });
    });

    await page.goto('/ask');
    await page.evaluate(async () => {
      if (location.port === '4173') await navigator.serviceWorker.ready;
    });
    await page.getByRole('button', { name: 'Start push-to-talk' }).click();
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByText('Listening…')).toBeVisible();
    await page.getByRole('button', { name: 'Stop recording' }).click();

    const transcript = page.getByLabel('Review and correct your transcript');
    await expect(transcript).toHaveValue('Book dentist Tuesday');
    await transcript.fill('Book the dentist next Tuesday after lunch');
    await page.getByRole('button', { name: 'Use transcript' }).click();

    await expect(
      page.getByText('Book the dentist next Tuesday after lunch'),
    ).toBeVisible();
    await expect(
      page
        .locator('.conversation-messages .message--assistant')
        .filter({ hasText: 'I found three safe appointment options.' }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Spoken reply' }),
    ).toBeVisible();
    expect(transcriptionContentType).toContain('audio/webm');
    expect(transcriptionBytes).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Play spoken reply' }).click();
    await expect(
      page.getByRole('button', { name: 'Pause spoken reply' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Stop spoken reply' }).click();
    await page.getByText('Captions').click();
    await expect(
      page
        .getByRole('region', { name: 'Spoken reply' })
        .getByText('I found three safe appointment options.'),
    ).toBeVisible();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __revokedAudioUrls?: string[] })
              .__revokedAudioUrls ?? [],
        ),
      )
      .toContain('blob:http://127.0.0.1/spoken-reply');
    const forbiddenVoiceMaterial = [
      'in-memory-voice',
      Buffer.from('in-memory-voice').toString('base64'),
      'ephemeral-spoken-summary',
      Buffer.from('ephemeral-spoken-summary').toString('base64'),
      'Book dentist Tuesday',
      'Book the dentist next Tuesday after lunch',
      'I found three safe appointment options.',
      'blob:http://127.0.0.1/spoken-reply',
    ];
    const persistentState = await page.evaluate(async (forbiddenMaterial) => {
      const forbiddenArtifactName = /(?:audio|blob|spoken|transcript|voice)/iu;
      const encodedForbiddenMaterial = forbiddenMaterial.map(
        (material) => [material, new TextEncoder().encode(material)] as const,
      );
      const sensitivePersistence: string[] = [];
      const voiceNamedArtifacts: string[] = [];
      const matchesForbiddenBytes = (bytes: Uint8Array): readonly string[] =>
        encodedForbiddenMaterial.flatMap(([material, encoded]) => {
          if (encoded.byteLength === 0 || encoded.byteLength > bytes.byteLength)
            return [];
          for (
            let offset = 0;
            offset <= bytes.byteLength - encoded.byteLength;
            offset += 1
          ) {
            let matches = true;
            for (let index = 0; index < encoded.byteLength; index += 1) {
              if (bytes[offset + index] !== encoded[index]) {
                matches = false;
                break;
              }
            }
            if (matches) return [material];
          }
          return [];
        });
      const recordSensitiveBytes = (
        location: string,
        bytes: Uint8Array,
      ): void => {
        for (const material of matchesForbiddenBytes(bytes)) {
          sensitivePersistence.push(`${location}:${material}`);
        }
      };
      const inspectPersistedValue = async (
        value: unknown,
        location: string,
        seen = new WeakSet<object>(),
      ): Promise<void> => {
        if (typeof value === 'string') {
          recordSensitiveBytes(location, new TextEncoder().encode(value));
          if (forbiddenArtifactName.test(value))
            voiceNamedArtifacts.push(`${location}:value`);
          return;
        }
        if (
          value === null ||
          value === undefined ||
          typeof value === 'boolean' ||
          typeof value === 'number' ||
          typeof value === 'bigint'
        ) {
          return;
        }
        if (value instanceof Blob) {
          voiceNamedArtifacts.push(`${location}:blob`);
          if (/^audio\//iu.test(value.type))
            voiceNamedArtifacts.push(`${location}:audio-blob`);
          if (value instanceof File && forbiddenArtifactName.test(value.name)) {
            voiceNamedArtifacts.push(`${location}:file:${value.name}`);
          }
          recordSensitiveBytes(
            location,
            new Uint8Array(await value.arrayBuffer()),
          );
          return;
        }
        if (value instanceof ArrayBuffer) {
          recordSensitiveBytes(location, new Uint8Array(value));
          return;
        }
        if (ArrayBuffer.isView(value)) {
          recordSensitiveBytes(
            location,
            new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
          );
          return;
        }
        if (value instanceof CryptoKey || value instanceof Date) return;
        if (typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (value instanceof Map) {
          let index = 0;
          for (const [key, entry] of value.entries()) {
            await inspectPersistedValue(
              key,
              `${location}:map-key-${index}`,
              seen,
            );
            await inspectPersistedValue(
              entry,
              `${location}:map-value-${index}`,
              seen,
            );
            index += 1;
          }
          return;
        }
        if (value instanceof Set) {
          let index = 0;
          for (const entry of value.values()) {
            await inspectPersistedValue(
              entry,
              `${location}:set-${index}`,
              seen,
            );
            index += 1;
          }
          return;
        }
        for (const [key, entry] of Object.entries(value)) {
          if (forbiddenArtifactName.test(key))
            voiceNamedArtifacts.push(`${location}:field:${key}`);
          await inspectPersistedValue(entry, `${location}.${key}`, seen);
        }
      };

      const cacheNames = (await caches.keys()).sort();
      const cacheEntries: Array<{
        readonly cacheName: string;
        readonly contentType: string;
        readonly method: string;
        readonly privateCacheDirective: boolean;
        readonly sensitiveMaterialMatches: readonly string[];
        readonly status: number | null;
        readonly url: string;
      }> = [];
      for (const cacheName of cacheNames) {
        const cache = await caches.open(cacheName);
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          const bodyBytes = response
            ? new Uint8Array(await response.clone().arrayBuffer())
            : new Uint8Array();
          const cacheControl = response?.headers.get('cache-control') ?? '';
          cacheEntries.push({
            cacheName,
            contentType: response?.headers.get('content-type') ?? '',
            method: request.method,
            privateCacheDirective: cacheControl
              .split(',')
              .some((directive) =>
                /^\s*(?:no-store|private)(?:\s*=|\s*$)/iu.test(directive),
              ),
            sensitiveMaterialMatches: matchesForbiddenBytes(bodyBytes),
            status: response?.status ?? null,
            url: request.url,
          });
        }
      }

      if (typeof indexedDB.databases !== 'function') {
        throw new Error(
          'IndexedDB enumeration is required for voice persistence evidence',
        );
      }
      const indexedDbNames = (await indexedDB.databases())
        .flatMap(({ name }) => (name ? [name] : []))
        .sort();
      const indexedDbSchema: string[] = [];
      for (const databaseName of indexedDbNames) {
        indexedDbSchema.push(`database:${databaseName}`);
        if (forbiddenArtifactName.test(databaseName)) {
          voiceNamedArtifacts.push(`indexeddb:database:${databaseName}`);
        }
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(databaseName);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () =>
            reject(
              request.error ??
                new Error(`Unable to inspect IndexedDB ${databaseName}`),
            );
        });
        try {
          for (const storeName of database.objectStoreNames) {
            indexedDbSchema.push(`store:${databaseName}:${storeName}`);
            if (forbiddenArtifactName.test(storeName)) {
              voiceNamedArtifacts.push(
                `indexeddb:${databaseName}:store:${storeName}`,
              );
            }
            const transaction = database.transaction(storeName, 'readonly');
            const transactionFinished = new Promise<void>((resolve, reject) => {
              transaction.oncomplete = () => resolve();
              transaction.onerror = () =>
                reject(
                  transaction.error ?? new Error('IndexedDB inspection failed'),
                );
              transaction.onabort = () =>
                reject(
                  transaction.error ??
                    new Error('IndexedDB inspection aborted'),
                );
            });
            const store = transaction.objectStore(storeName);
            for (const indexName of store.indexNames) {
              indexedDbSchema.push(
                `index:${databaseName}:${storeName}:${indexName}`,
              );
              if (forbiddenArtifactName.test(indexName)) {
                voiceNamedArtifacts.push(
                  `indexeddb:${databaseName}:${storeName}:index:${indexName}`,
                );
              }
            }
            const requestResult = <Value>(
              request: IDBRequest<Value>,
            ): Promise<Value> =>
              new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result);
                request.onerror = () =>
                  reject(request.error ?? new Error('IndexedDB read failed'));
              });
            const [keys, values] = await Promise.all([
              requestResult(store.getAllKeys()),
              requestResult(store.getAll()),
            ]);
            await transactionFinished;
            for (let index = 0; index < values.length; index += 1) {
              const location = `indexeddb:${databaseName}:${storeName}:record-${index}`;
              await inspectPersistedValue(keys[index], `${location}:key`);
              await inspectPersistedValue(values[index], `${location}:value`);
            }
          }
        } finally {
          database.close();
        }
      }

      const opfsArtifacts: string[] = [];
      const opfsRoot = await navigator.storage.getDirectory();
      const isDirectoryHandle = (
        handle: FileSystemHandle,
      ): handle is FileSystemDirectoryHandle =>
        handle.kind === 'directory' && 'entries' in handle;
      const isFileHandle = (
        handle: FileSystemHandle,
      ): handle is FileSystemFileHandle =>
        handle.kind === 'file' && 'getFile' in handle;
      const visitOpfs = async (
        directory: FileSystemDirectoryHandle,
        prefix = '',
      ): Promise<void> => {
        for await (const [name, handle] of directory.entries()) {
          const path = `${prefix}/${name}`;
          opfsArtifacts.push(`${handle.kind}:${path}`);
          if (forbiddenArtifactName.test(name))
            voiceNamedArtifacts.push(`opfs:${path}`);
          if (isDirectoryHandle(handle)) {
            await visitOpfs(handle, path);
            continue;
          }
          if (!isFileHandle(handle)) {
            throw new Error(`Unsupported OPFS handle: ${path}`);
          }
          const file = await handle.getFile();
          if (/^audio\//iu.test(file.type))
            voiceNamedArtifacts.push(`opfs:${path}:audio-file`);
          recordSensitiveBytes(
            `opfs:${path}`,
            new Uint8Array(await file.arrayBuffer()),
          );
        }
      };
      await visitOpfs(opfsRoot);

      return {
        cacheEntries,
        cacheNames,
        indexedDbNames,
        indexedDbSchema,
        localStorageEntries: Object.entries(localStorage),
        opfsArtifacts: opfsArtifacts.sort(),
        sensitivePersistence,
        sessionStorageEntries: Object.entries(sessionStorage),
        voiceNamedArtifacts,
      };
    }, forbiddenVoiceMaterial);
    const cookies = await context.cookies(page.url());
    const serializedCookies = JSON.stringify(cookies);
    for (const material of forbiddenVoiceMaterial) {
      expect(serializedCookies).not.toContain(material);
    }
    for (const cookie of cookies) {
      expect(cookie.name).not.toMatch(
        /(?:audio|blob|spoken|transcript|voice)/iu,
      );
    }

    expect(persistentState.sessionStorageEntries).toEqual([]);
    expect(persistentState.localStorageEntries).toHaveLength(1);
    const [offlineContextKey, offlineContextValue] =
      persistentState.localStorageEntries[0] ?? [];
    const offlineContextPrefix = 'emdo.offline.context.v1.';
    expect(offlineContextKey).toMatch(
      /^emdo\.offline\.context\.v1\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    const contextId = offlineContextKey?.slice(offlineContextPrefix.length);
    const offlineContext = JSON.parse(offlineContextValue ?? '') as {
      readonly contextId: string;
      readonly lastSeenAt: number;
      readonly sessionBinding: string;
      readonly version: number;
    };
    expect(offlineContext).toEqual({
      contextId,
      lastSeenAt: expect.any(Number),
      sessionBinding: expect.stringMatching(/^[a-f0-9]{64}$/u),
      version: 1,
    });
    expect(Number.isSafeInteger(offlineContext.lastSeenAt)).toBe(true);
    expect(offlineContext.lastSeenAt).toBeGreaterThan(0);

    const serializedBrowserStorage = [
      ...persistentState.localStorageEntries,
      ...persistentState.sessionStorageEntries,
    ]
      .flat()
      .join('\n');
    for (const material of forbiddenVoiceMaterial) {
      expect(serializedBrowserStorage).not.toContain(material);
    }
    expect(persistentState.indexedDbNames).toEqual([
      'emdo-browser-metadata-v1',
      'emdo-device-secrets',
    ]);
    expect(persistentState.indexedDbSchema).toEqual([
      'database:emdo-browser-metadata-v1',
      'store:emdo-browser-metadata-v1:device',
      'database:emdo-device-secrets',
      'store:emdo-device-secrets:device-secrets',
    ]);
    expect(persistentState.opfsArtifacts.length).toBeGreaterThan(0);
    expect(persistentState.opfsArtifacts.length).toBeLessThanOrEqual(512);
    for (const artifact of persistentState.opfsArtifacts) {
      expect(artifact).toMatch(/^(?:directory|file):\/[A-Za-z0-9._/-]+$/u);
    }
    expect(
      persistentState.opfsArtifacts.some((artifact) =>
        /(?:emdo\.sqlite3|\.ahp-)/u.test(artifact),
      ),
    ).toBe(true);
    expect(persistentState.sensitivePersistence).toEqual([]);
    expect(persistentState.voiceNamedArtifacts).toEqual([]);

    const pageOrigin = new URL(page.url()).origin;
    const isProductionPwaPreview = new URL(page.url()).port === '4173';
    if (isProductionPwaPreview) {
      expect(persistentState.cacheNames).toEqual([
        `workbox-precache-v2-${pageOrigin}/`,
      ]);
      expect(persistentState.cacheEntries.length).toBeGreaterThan(0);
    } else {
      expect(persistentState.cacheNames).toEqual([]);
      expect(persistentState.cacheEntries).toEqual([]);
    }
    for (const entry of persistentState.cacheEntries) {
      expect(entry.cacheName).toBe(`workbox-precache-v2-${pageOrigin}/`);
      expect(entry.method).toBe('GET');
      expect(entry.status).toBe(200);
      expect(entry.privateCacheDirective).toBe(false);
      expect(entry.contentType).not.toMatch(/^audio\//iu);
      expect(entry.sensitiveMaterialMatches).toEqual([]);

      const cacheUrl = new URL(entry.url);
      expect(cacheUrl.protocol).toBe('http:');
      expect(cacheUrl.origin).toBe(pageOrigin);
      expect(cacheUrl.username).toBe('');
      expect(cacheUrl.password).toBe('');
      expect(cacheUrl.hash).toBe('');
      expect(cacheUrl.pathname).toMatch(
        /^\/(?:index\.html|registerSW\.js|(?:@powersync|assets|icons)\/[A-Za-z0-9._/-]+\.(?:css|html|ico|js|png|svg|webp|woff2|wasm))$/u,
      );
      const cacheParameters = [...cacheUrl.searchParams.entries()];
      if (cacheParameters.length > 0) {
        expect(cacheParameters).toHaveLength(1);
        expect(cacheParameters[0]?.[0]).toBe('__WB_REVISION__');
        expect(cacheParameters[0]?.[1]).toMatch(/^[a-f0-9]{32}$/u);
      }
    }
  });

  test('falls back to typed input when microphone access is unavailable', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => {
            throw new DOMException('denied', 'NotAllowedError');
          },
        },
      });
    });
    await page.goto('/ask');
    await page.getByRole('button', { name: 'Start push-to-talk' }).click();
    await page.getByRole('button', { name: 'Start recording' }).click();

    await expect(page.getByRole('alert')).toContainText(
      'Microphone access is unavailable. You can type your request instead.',
    );
    await page.getByRole('button', { name: 'Type instead' }).click();
    await expect(page.getByPlaceholder('What can I help with?')).toBeVisible();
  });
});

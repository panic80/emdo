import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { mockAuthenticatedSession } from './support.js';

async function installVoiceBrowserMocks(page: Page): Promise<void> {
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

const durableMutationProbeName = '__emdoDurableMutationProbe' as const;

interface DurableMutationProbe {
  readonly arm: () => readonly string[];
  readonly stop: () => readonly string[];
  readonly installed: () => readonly string[];
}

async function installDurableMutationProbe(page: Page): Promise<void> {
  await page.addInitScript((probeName) => {
    const attempts: string[] = [];
    const installed = new Set<string>();
    let armed = false;
    const record = (label: string): void => {
      if (armed) attempts.push(label);
    };
    const wrapMethod = (
      target: object | undefined,
      property: string,
      label: string,
      shouldRecord: (arguments_: readonly unknown[]) => boolean = () => true,
    ): void => {
      if (!target) return;
      const recordTarget = target as Record<string, unknown>;
      const original = recordTarget[property];
      if (typeof original !== 'function') return;
      Object.defineProperty(target, property, {
        configurable: true,
        writable: true,
        value: function (this: unknown, ...arguments_: readonly unknown[]) {
          if (shouldRecord(arguments_)) record(label);
          return Reflect.apply(original, this, arguments_);
        },
      });
      installed.add(label);
    };

    wrapMethod(Storage.prototype, 'setItem', 'Storage.setItem');
    wrapMethod(Storage.prototype, 'removeItem', 'Storage.removeItem');
    wrapMethod(Storage.prototype, 'clear', 'Storage.clear');
    wrapMethod(Cache.prototype, 'put', 'Cache.put');
    wrapMethod(Cache.prototype, 'add', 'Cache.add');
    wrapMethod(Cache.prototype, 'addAll', 'Cache.addAll');
    wrapMethod(Cache.prototype, 'delete', 'Cache.delete');
    wrapMethod(CacheStorage.prototype, 'delete', 'CacheStorage.delete');
    wrapMethod(
      IDBDatabase.prototype,
      'createObjectStore',
      'IDBDatabase.createObjectStore',
    );
    wrapMethod(
      IDBDatabase.prototype,
      'deleteObjectStore',
      'IDBDatabase.deleteObjectStore',
    );
    wrapMethod(IDBObjectStore.prototype, 'add', 'IDBObjectStore.add');
    wrapMethod(IDBObjectStore.prototype, 'put', 'IDBObjectStore.put');
    wrapMethod(IDBObjectStore.prototype, 'delete', 'IDBObjectStore.delete');
    wrapMethod(IDBObjectStore.prototype, 'clear', 'IDBObjectStore.clear');
    wrapMethod(IDBCursor.prototype, 'update', 'IDBCursor.update');
    wrapMethod(IDBCursor.prototype, 'delete', 'IDBCursor.delete');
    wrapMethod(
      IDBFactory.prototype,
      'deleteDatabase',
      'IDBFactory.deleteDatabase',
    );
    wrapMethod(
      globalThis.FileSystemDirectoryHandle?.prototype,
      'getDirectoryHandle',
      'FileSystemDirectoryHandle.getDirectoryHandle(create)',
      (arguments_) =>
        (arguments_[1] as { readonly create?: unknown } | undefined)?.create ===
        true,
    );
    wrapMethod(
      globalThis.FileSystemDirectoryHandle?.prototype,
      'getFileHandle',
      'FileSystemDirectoryHandle.getFileHandle(create)',
      (arguments_) =>
        (arguments_[1] as { readonly create?: unknown } | undefined)?.create ===
        true,
    );
    wrapMethod(
      globalThis.FileSystemDirectoryHandle?.prototype,
      'removeEntry',
      'FileSystemDirectoryHandle.removeEntry',
    );
    wrapMethod(
      globalThis.FileSystemFileHandle?.prototype,
      'createWritable',
      'FileSystemFileHandle.createWritable',
    );
    wrapMethod(
      globalThis.FileSystemHandle?.prototype,
      'move',
      'FileSystemHandle.move',
    );
    wrapMethod(
      globalThis.StorageManager?.prototype,
      'persist',
      'StorageManager.persist',
    );

    const cookieOwner = [Document.prototype, HTMLDocument.prototype].find(
      (candidate) =>
        Object.getOwnPropertyDescriptor(candidate, 'cookie')?.set !== undefined,
    );
    const cookieDescriptor = cookieOwner
      ? Object.getOwnPropertyDescriptor(cookieOwner, 'cookie')
      : undefined;
    if (cookieOwner && cookieDescriptor?.get && cookieDescriptor.set) {
      Object.defineProperty(cookieOwner, 'cookie', {
        ...cookieDescriptor,
        get: cookieDescriptor.get,
        set(value: string) {
          record('Document.cookie');
          cookieDescriptor.set?.call(this, value);
        },
      });
      installed.add('Document.cookie');
    }

    const cookieStorePrototype = (
      globalThis as typeof globalThis & {
        CookieStore?: { readonly prototype?: object };
      }
    ).CookieStore?.prototype;
    wrapMethod(cookieStorePrototype, 'set', 'CookieStore.set');
    wrapMethod(cookieStorePrototype, 'delete', 'CookieStore.delete');

    const probe: DurableMutationProbe = Object.freeze({
      arm: () => {
        attempts.length = 0;
        armed = true;
        return Object.freeze([...attempts]);
      },
      stop: () => {
        armed = false;
        return Object.freeze([...attempts]);
      },
      installed: () => Object.freeze([...installed].sort()),
    });
    Object.defineProperty(window, probeName, {
      configurable: false,
      enumerable: false,
      value: probe,
      writable: false,
    });
  }, durableMutationProbeName);
}

async function captureDurableBrowserState(
  page: Page,
  context: BrowserContext,
): Promise<unknown> {
  const pageState = await page.evaluate(async () => {
    const digest = async (bytes: BufferSource): Promise<string> =>
      [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    const describeValue = async (
      value: unknown,
      seen = new WeakMap<object, number>(),
      nextReference = { value: 0 },
    ): Promise<unknown> => {
      if (value === null) return { type: 'null' };
      if (value === undefined) return { type: 'undefined' };
      if (typeof value === 'string') return { type: 'string', value };
      if (typeof value === 'boolean') return { type: 'boolean', value };
      if (typeof value === 'number') {
        return {
          type: 'number',
          value: Number.isNaN(value)
            ? 'NaN'
            : Object.is(value, -0)
              ? '-0'
              : String(value),
        };
      }
      if (typeof value === 'bigint') {
        return { type: 'bigint', value: value.toString(10) };
      }
      if (typeof value !== 'object') {
        return { type: typeof value };
      }
      const reference = seen.get(value);
      if (reference !== undefined) return { reference };
      const currentReference = nextReference.value;
      nextReference.value += 1;
      seen.set(value, currentReference);
      if (value instanceof Blob) {
        return {
          reference: currentReference,
          type: value instanceof File ? 'File' : 'Blob',
          mimeType: value.type,
          size: value.size,
          name: value instanceof File ? value.name : null,
          lastModified: value instanceof File ? value.lastModified : null,
          sha256: await digest(await value.arrayBuffer()),
        };
      }
      if (value instanceof ArrayBuffer) {
        return {
          reference: currentReference,
          type: 'ArrayBuffer',
          byteLength: value.byteLength,
          sha256: await digest(value),
        };
      }
      if (ArrayBuffer.isView(value)) {
        const bytes = new Uint8Array(
          value.buffer,
          value.byteOffset,
          value.byteLength,
        );
        const digestBytes = new Uint8Array(bytes.byteLength);
        digestBytes.set(bytes);
        return {
          reference: currentReference,
          type: value.constructor.name,
          byteLength: value.byteLength,
          sha256: await digest(digestBytes.buffer),
        };
      }
      if (value instanceof Date) {
        return {
          reference: currentReference,
          type: 'Date',
          value: value.toISOString(),
        };
      }
      if (value instanceof RegExp) {
        return {
          reference: currentReference,
          type: 'RegExp',
          source: value.source,
          flags: value.flags,
        };
      }
      if (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) {
        return {
          reference: currentReference,
          type: 'CryptoKey',
          algorithm: JSON.parse(JSON.stringify(value.algorithm)) as unknown,
          extractable: value.extractable,
          usages: [...value.usages].sort(),
        };
      }
      if (value instanceof Map) {
        const entries = [];
        for (const [key, entry] of value.entries()) {
          entries.push([
            await describeValue(key, seen, nextReference),
            await describeValue(entry, seen, nextReference),
          ]);
        }
        return { reference: currentReference, type: 'Map', entries };
      }
      if (value instanceof Set) {
        const entries = [];
        for (const entry of value.values()) {
          entries.push(await describeValue(entry, seen, nextReference));
        }
        return { reference: currentReference, type: 'Set', entries };
      }
      if (Array.isArray(value)) {
        return {
          reference: currentReference,
          type: 'Array',
          entries: await Promise.all(
            value.map((entry) => describeValue(entry, seen, nextReference)),
          ),
        };
      }
      const entries = [];
      for (const key of Object.keys(value).sort()) {
        entries.push([
          key,
          await describeValue(
            (value as Record<string, unknown>)[key],
            seen,
            nextReference,
          ),
        ]);
      }
      return {
        reference: currentReference,
        type: value.constructor?.name ?? 'Object',
        entries,
      };
    };
    const storageEntries = (storage: Storage): readonly (readonly string[])[] =>
      Array.from({ length: storage.length }, (_, index) => storage.key(index))
        .flatMap((key) =>
          key === null ? [] : [[key, storage.getItem(key) ?? ''] as const],
        )
        .sort(([left], [right]) => left.localeCompare(right, 'en'));

    const cacheEntries = [];
    for (const cacheName of (await caches.keys()).sort()) {
      const cache = await caches.open(cacheName);
      const requests = [...(await cache.keys())];
      for (const request of requests.sort((left, right) =>
        `${left.method}\n${left.url}`.localeCompare(
          `${right.method}\n${right.url}`,
          'en',
        ),
      )) {
        const response = await cache.match(request);
        cacheEntries.push({
          cacheName,
          request: {
            headers: [...request.headers.entries()].sort(),
            method: request.method,
            url: request.url,
          },
          response: response
            ? {
                bodySha256: await digest(await response.clone().arrayBuffer()),
                headers: [...response.headers.entries()].sort(),
                status: response.status,
                statusText: response.statusText,
                type: response.type,
              }
            : null,
        });
      }
    }

    if (typeof indexedDB.databases !== 'function') {
      throw new Error(
        'IndexedDB enumeration is required for voice persistence evidence',
      );
    }
    const indexedDatabases = [];
    for (const metadata of (await indexedDB.databases())
      .filter(
        (candidate): candidate is IDBDatabaseInfo & { name: string } =>
          typeof candidate.name === 'string',
      )
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(metadata.name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(
            request.error ??
              new Error(`Unable to inspect IndexedDB ${metadata.name}`),
          );
      });
      const stores = [];
      try {
        for (const storeName of [...database.objectStoreNames].sort()) {
          const transaction = database.transaction(storeName, 'readonly');
          const completed = new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () =>
              reject(
                transaction.error ?? new Error('IndexedDB inspection failed'),
              );
            transaction.onabort = () =>
              reject(
                transaction.error ?? new Error('IndexedDB inspection aborted'),
              );
          });
          const store = transaction.objectStore(storeName);
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
          await completed;
          stores.push({
            autoIncrement: store.autoIncrement,
            indexes: [...store.indexNames].sort().map((indexName) => {
              const index = store.index(indexName);
              return {
                keyPath: index.keyPath,
                multiEntry: index.multiEntry,
                name: index.name,
                unique: index.unique,
              };
            }),
            keyPath: store.keyPath,
            name: store.name,
            records: await Promise.all(
              values.map(async (value, index) => ({
                key: await describeValue(keys[index]),
                value: await describeValue(value),
              })),
            ),
          });
        }
      } finally {
        database.close();
      }
      indexedDatabases.push({
        name: metadata.name,
        stores,
        version: database.version,
      });
    }

    const opfsEntries: Array<{
      readonly kind: 'directory' | 'file';
      readonly lastModified: number | null;
      readonly mimeType: string | null;
      readonly path: string;
      readonly sha256: string | null;
      readonly size: number | null;
    }> = [];
    const isDirectoryHandle = (
      handle: FileSystemHandle,
    ): handle is FileSystemDirectoryHandle =>
      handle.kind === 'directory' && 'entries' in handle;
    const isFileHandle = (
      handle: FileSystemHandle,
    ): handle is FileSystemFileHandle =>
      handle.kind === 'file' && 'getFile' in handle;
    const visitDirectory = async (
      directory: FileSystemDirectoryHandle,
      prefix = '',
    ): Promise<void> => {
      const entries = [];
      for await (const entry of directory.entries()) entries.push(entry);
      entries.sort(([left], [right]) => left.localeCompare(right, 'en'));
      for (const [name, handle] of entries) {
        const path = `${prefix}/${name}`;
        if (isDirectoryHandle(handle)) {
          opfsEntries.push({
            kind: 'directory',
            lastModified: null,
            mimeType: null,
            path,
            sha256: null,
            size: null,
          });
          await visitDirectory(handle, path);
          continue;
        }
        if (!isFileHandle(handle)) {
          throw new Error(`Unsupported OPFS handle: ${path}`);
        }
        const file = await handle.getFile();
        opfsEntries.push({
          kind: 'file',
          lastModified: file.lastModified,
          mimeType: file.type,
          path,
          sha256: await digest(await file.arrayBuffer()),
          size: file.size,
        });
      }
    };
    await visitDirectory(await navigator.storage.getDirectory());

    return {
      cacheEntries,
      indexedDatabases,
      localStorage: storageEntries(localStorage),
      opfsEntries,
      sessionStorage: storageEntries(sessionStorage),
    };
  });
  const cookies = (await context.cookies(page.url()))
    .map((cookie) => ({
      domain: cookie.domain,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      name: cookie.name,
      path: cookie.path,
      sameSite: cookie.sameSite,
      secure: cookie.secure,
      value: cookie.value,
    }))
    .sort((left, right) =>
      `${left.domain}\n${left.path}\n${left.name}`.localeCompare(
        `${right.domain}\n${right.path}\n${right.name}`,
        'en',
      ),
    );
  return { cookies, pageState };
}

async function armDurableMutationProbe(page: Page): Promise<readonly string[]> {
  return page.evaluate((probeName) => {
    const probe = (window as unknown as Record<string, DurableMutationProbe>)[
      probeName
    ];
    if (!probe) throw new Error('Durable mutation probe is unavailable');
    return probe.arm();
  }, durableMutationProbeName);
}

async function stopDurableMutationProbe(
  page: Page,
): Promise<readonly string[]> {
  return page.evaluate((probeName) => {
    const probe = (window as unknown as Record<string, DurableMutationProbe>)[
      probeName
    ];
    if (!probe) throw new Error('Durable mutation probe is unavailable');
    return probe.stop();
  }, durableMutationProbeName);
}

async function installedDurableMutationHooks(
  page: Page,
): Promise<readonly string[]> {
  return page.evaluate((probeName) => {
    const probe = (window as unknown as Record<string, DurableMutationProbe>)[
      probeName
    ];
    if (!probe) throw new Error('Durable mutation probe is unavailable');
    return probe.installed();
  }, durableMutationProbeName);
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

  test('leaves no push-to-talk audio or transcript in durable browser storage', async ({
    context,
    page,
  }) => {
    await installDurableMutationProbe(page);
    await page.route('**/api/v1/voice/transcribe?*', async (route) => {
      expect(route.request().postDataBuffer()?.byteLength ?? 0).toBeGreaterThan(
        0,
      );
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
          transcript: 'Voice persistence canary transcript',
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
        headers: { 'cache-control': 'no-store, private' },
        body: JSON.stringify({
          schemaVersion: 1,
          runId: '22222222-2222-4222-8222-222222222222',
          status: 'accepted',
          replayed: false,
          eventsPath:
            '/api/v1/runs/22222222-2222-4222-8222-222222222222/events',
        }),
      });
    });
    await page.route('**/api/v1/runs/*/events', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'cache-control': 'no-store, private' },
        body: 'id: 1\nevent: assistant.message\ndata: {"schemaVersion":1,"runId":"22222222-2222-4222-8222-222222222222","sequence":1,"type":"assistant.message","occurredAt":"2026-08-09T12:00:00.000Z","data":{"text":"Voice persistence canary reply."}}\n\n',
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
        body: Buffer.from('voice-persistence-canary-spoken-audio'),
      });
    });

    await page.goto('/ask');
    await page.evaluate(async () => {
      if (location.port === '4173') await navigator.serviceWorker.ready;
    });
    await expect(page.getByRole('heading', { name: 'Ask EMDO' })).toBeVisible();
    expect(await installedDurableMutationHooks(page)).toEqual(
      expect.arrayContaining([
        'Cache.add',
        'Cache.addAll',
        'Cache.delete',
        'Cache.put',
        'CacheStorage.delete',
        'Document.cookie',
        'FileSystemDirectoryHandle.getDirectoryHandle(create)',
        'FileSystemDirectoryHandle.getFileHandle(create)',
        'FileSystemDirectoryHandle.removeEntry',
        'FileSystemFileHandle.createWritable',
        'IDBDatabase.createObjectStore',
        'IDBDatabase.deleteObjectStore',
        'IDBFactory.deleteDatabase',
        'IDBObjectStore.add',
        'IDBObjectStore.clear',
        'IDBObjectStore.delete',
        'IDBObjectStore.put',
        'Storage.clear',
        'Storage.removeItem',
        'Storage.setItem',
      ]),
    );
    const durableStateBefore = await captureDurableBrowserState(page, context);
    expect(await armDurableMutationProbe(page)).toEqual([]);

    await page.getByRole('button', { name: 'Start push-to-talk' }).click();
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByText('Listening…')).toBeVisible();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    const transcript = page.getByLabel('Review and correct your transcript');
    await expect(transcript).toHaveValue('Voice persistence canary transcript');
    await transcript.fill('Corrected persistence canary transcript');
    await page.getByRole('button', { name: 'Use transcript' }).click();
    await expect(
      page.getByText('Corrected persistence canary transcript'),
    ).toBeVisible();
    await expect(
      page
        .locator('.conversation-messages .message--assistant')
        .filter({ hasText: 'Voice persistence canary reply.' }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Spoken reply' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Play spoken reply' }).click();
    await expect(
      page.getByRole('button', { name: 'Pause spoken reply' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Stop spoken reply' }).click();
    await page.getByText('Captions').click();
    await expect(
      page
        .getByRole('region', { name: 'Spoken reply' })
        .getByText('Voice persistence canary reply.'),
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
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    expect(await stopDurableMutationProbe(page)).toEqual([]);
    expect(await captureDurableBrowserState(page, context)).toEqual(
      durableStateBefore,
    );
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

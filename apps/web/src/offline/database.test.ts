import { describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import {
  BroadcastChannelCrossContextTeardownTransport,
  InMemoryOfflineDatabaseAdapter,
  InMemoryOfflineDatabaseLifecycleLock,
  InMemoryBrowserContextPresenceStore,
  OfflineDatabaseController,
  PowerSyncBrowserRuntime,
  PowerSyncWebDatabaseAdapter,
  SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
  VerifiedCrossContextLogoutBoundary,
  registerOfflinePurgeOperation,
  type EncryptedSqliteConnection,
  type OfflinePurgePermit,
  type VerifiedOfflinePurgeAuthorization,
} from './database.js';

const TEST_SESSION_BINDING = 'a'.repeat(64);
const BACKGROUND_CONNECTION_ATTEMPT = Object.freeze({
  state: 'background-started' as const,
  liveReplicationVerified: false as const,
});

const runTestPurge = async <Value>(
  lifecycleLock: InMemoryOfflineDatabaseLifecycleLock,
  operation: (
    permit: OfflinePurgePermit,
    signal: AbortSignal,
  ) => Promise<Value>,
  sessionBinding = TEST_SESSION_BINDING,
): Promise<Value> => {
  const prepared = await new VerifiedCrossContextLogoutBoundary(
    {
      requestKnownContextTeardown: async () => ({
        knownContextIds: [],
        acknowledgements: [],
      }),
    },
    lifecycleLock,
    { sessionBinding },
  ).prepare('discard');
  return prepared.run(operation);
};

const createSqlConnection = (): EncryptedSqliteConnection => {
  const connection: EncryptedSqliteConnection = {
    encryption: 'required',
    storage: 'safari-opfs',
    close: async () => undefined,
    execute: async () => undefined,
    query: async <Row>() => [] as Row[],
    transaction: async <Value>(
      operation: (active: EncryptedSqliteConnection) => Promise<Value>,
    ) => operation(connection),
  };
  return connection;
};

const purgeController = async (
  controller: OfflineDatabaseController,
  lifecycleLock: InMemoryOfflineDatabaseLifecycleLock,
) => {
  const seal = await controller.sealAndCloseForLogout();
  if (!seal.complete) {
    return seal;
  }
  return runTestPurge(lifecycleLock, (permit, signal) =>
    controller.purge(permit, signal),
  );
};

describe('OfflineDatabaseController', () => {
  it('rejects conflicting explicit and key-provider session bindings', () => {
    expect(
      () =>
        new OfflineDatabaseController(
          new InMemoryOfflineDatabaseAdapter(),
          {
            authenticatedSessionBinding: TEST_SESSION_BINDING,
            getOrCreateDatabaseKey: async () => new Uint8Array(32),
          },
          new InMemoryOfflineDatabaseLifecycleLock(),
          'emdo.sqlite3',
          'b'.repeat(64),
        ),
    ).toThrow(/session binding.*mismatch/i);
  });

  it('opens encrypted SQLite through the Safari-compatible OPFS boundary', async () => {
    const adapter = new InMemoryOfflineDatabaseAdapter();
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const leasedKey = new Uint8Array(32).fill(7);
    const controller = new OfflineDatabaseController(
      adapter,
      {
        authenticatedSessionBinding: TEST_SESSION_BINDING,
        getOrCreateDatabaseKey: async () => leasedKey,
      },
      lifecycleLock,
      'emdo.sqlite3',
    );

    await controller.open();

    expect(adapter.lastOpenOptions).toMatchObject({
      databaseName: 'emdo.sqlite3',
      encryption: 'required',
      storage: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
    });
    expect(adapter.lastOpenOptions?.databaseKey).toEqual(
      new Uint8Array(32).fill(7),
    );
    expect(leasedKey.every((byte) => byte === 0)).toBe(true);
    expect(Object.isFrozen(SAFARI_COMPATIBLE_OPFS_CONFIGURATION)).toBe(true);
  });

  it('erases the leased key even when opening the database fails', async () => {
    const leasedKey = new Uint8Array(32).fill(9);
    const adapter = {
      open: async () => {
        throw new Error('open failed');
      },
      deleteLocalDatabase: async () => undefined,
    };
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const controller = new OfflineDatabaseController(
      adapter,
      {
        authenticatedSessionBinding: TEST_SESSION_BINDING,
        getOrCreateDatabaseKey: async () => leasedKey,
      },
      lifecycleLock,
    );

    await expect(controller.open()).rejects.toThrow('open failed');
    expect(leasedKey.every((byte) => byte === 0)).toBe(true);
  });

  it('refuses OPFS deletion when the active connection cannot close', async () => {
    const calls: string[] = [];
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const controller = new OfflineDatabaseController(
      {
        open: async () => ({
          close: async () => {
            calls.push('close');
            throw new Error('close failed');
          },
        }),
        deleteLocalDatabase: async () => {
          calls.push('delete');
          throw new Error('delete failed');
        },
      },
      {
        authenticatedSessionBinding: TEST_SESSION_BINDING,
        getOrCreateDatabaseKey: async () => new Uint8Array(32),
      },
      lifecycleLock,
    );
    await controller.open();

    await expect(controller.sealAndCloseForLogout()).resolves.toEqual({
      complete: false,
      failedSteps: ['close-connection'],
    });
    expect(calls).toEqual(['close']);
  });

  it('provides a deterministic in-memory adapter for browser-independent CI', async () => {
    const adapter = new InMemoryOfflineDatabaseAdapter();
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const controller = new OfflineDatabaseController(
      adapter,
      {
        authenticatedSessionBinding: TEST_SESSION_BINDING,
        getOrCreateDatabaseKey: async () => new Uint8Array(32).fill(3),
      },
      lifecycleLock,
    );
    await controller.open();
    expect(adapter.hasLocalDatabase).toBe(true);

    await expect(purgeController(controller, lifecycleLock)).resolves.toEqual({
      complete: true,
      failedSteps: [],
    });
    expect(adapter.hasLocalDatabase).toBe(false);
    await expect(controller.open()).rejects.toThrow(/sealed/i);
  });

  it('waits for an in-flight open before deleting and deduplicates purge', async () => {
    const calls: string[] = [];
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    let releaseOpen = (): void => undefined;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const controller = new OfflineDatabaseController(
      {
        open: async () => {
          calls.push('open-start');
          await openGate;
          calls.push('open-complete');
          return {
            close: async () => {
              calls.push('close');
            },
          };
        },
        deleteLocalDatabase: async () => {
          calls.push('delete');
        },
      },
      {
        authenticatedSessionBinding: TEST_SESSION_BINDING,
        getOrCreateDatabaseKey: async () => new Uint8Array(32),
      },
      lifecycleLock,
    );

    const opening = controller.open();
    await Promise.resolve();
    const firstPurge = purgeController(controller, lifecycleLock);
    const secondPurge = purgeController(controller, lifecycleLock);
    releaseOpen();
    await expect(opening).rejects.toThrow(/sealed/i);
    await Promise.all([firstPurge, secondPurge]);

    expect(calls).toEqual(['open-start', 'open-complete', 'close', 'delete']);
  });

  it('maps the encrypted Safari OPFS contract into a PowerSync runtime boundary', async () => {
    const calls: unknown[] = [];
    const adapter = new PowerSyncWebDatabaseAdapter({
      openEncryptedDatabase: async (options) => {
        calls.push([
          'open',
          {
            ...options,
            encryptionKey: new Uint8Array(options.encryptionKey),
          },
        ]);
        return createSqlConnection();
      },
      connectEncryptedDatabase: async () => BACKGROUND_CONNECTION_ATTEMPT,
      deleteEncryptedDatabase: async (options) => {
        calls.push(['delete', options]);
      },
    });
    const key = new Uint8Array(32).fill(4);

    await adapter.open({
      databaseName: 'emdo.sqlite3',
      databaseKey: key,
      encryption: 'required',
      storage: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
    });
    await adapter.deleteLocalDatabase(
      {
        databaseName: 'emdo.sqlite3',
        storage: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
      },
      new AbortController().signal,
    );

    expect(calls).toEqual([
      [
        'open',
        {
          databaseName: 'emdo.sqlite3',
          encryptionKey: key,
          opfs: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
        },
      ],
      [
        'delete',
        {
          databaseName: 'emdo.sqlite3',
          opfs: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
        },
      ],
    ]);
  });

  it('opens PowerSync with encrypted OPFSCoopSyncVFS static-worker configuration', async () => {
    const schema = Object.freeze({ kind: 'test-schema' });
    let constructedOptions: Record<string, unknown> | undefined;
    let closeOptions: Record<string, unknown> | undefined;
    let connectedConnector: unknown;
    const statements: string[] = [];
    const workerRequests: Array<readonly [string, string, string]> = [];
    const removedEntries: Array<
      readonly [string, { readonly recursive?: boolean } | undefined]
    > = [];
    class FakePowerSyncDatabase {
      constructor(options: Record<string, unknown>) {
        constructedOptions = options;
        const databaseWorker = (
          options.database as {
            worker: (options: unknown) => Worker;
          }
        ).worker;
        databaseWorker({});
      }

      async init(): Promise<void> {
        return undefined;
      }

      async connect(connector: unknown): Promise<void> {
        connectedConnector = connector;
      }

      async close(options?: Record<string, unknown>): Promise<void> {
        closeOptions = options;
      }

      async execute(statement: string): Promise<void> {
        statements.push(statement);
      }

      async getAll<Row>(): Promise<Row[]> {
        return [{ value: 1 }] as Row[];
      }

      async writeTransaction<Value>(
        operation: (transaction: {
          execute(statement: string): Promise<void>;
          getAll<Row>(statement: string): Promise<Row[]>;
        }) => Promise<Value>,
      ): Promise<Value> {
        return operation({
          execute: async (statement) => {
            statements.push(`transaction:${statement}`);
          },
          getAll: async <Row>() => [{ value: 2 }] as Row[],
        });
      }
    }
    const runtime = new PowerSyncBrowserRuntime({
      schema: schema as never,
      workerFactory: {
        createDatabaseWorker: ({ scriptUrl, name }) => {
          workerRequests.push(['database', scriptUrl, name]);
          return { terminate: () => undefined } as unknown as Worker;
        },
        createSyncWorker: ({ scriptUrl, name }) => {
          workerRequests.push(['sync', scriptUrl, name]);
          return {
            port: { close: () => undefined },
          } as unknown as SharedWorker;
        },
      },
      sdkLoader: async () =>
        ({
          WASQLiteVFS: { OPFSCoopSyncVFS: 'OPFSCoopSyncVFS' },
          PowerSyncDatabase: FakePowerSyncDatabase,
        }) as never,
      opfsStorage: {
        getDirectory: async () => ({
          removeEntry: async (name, options) => {
            removedEntries.push([name, options]);
          },
          async *values() {
            yield { name: '.ahp-stale', kind: 'directory' as const };
            yield { name: 'unrelated.txt', kind: 'file' as const };
          },
        }),
      },
      temporaryDirectoryLock: {
        runIfAvailable: async (_name, operation) => {
          await operation();
          return true;
        },
      },
    });
    const encryptionKey = new Uint8Array(32).fill(7);
    const signal = new AbortController().signal;

    const connection = await runtime.openEncryptedDatabase(
      {
        databaseName: 'emdo.sqlite3',
        encryptionKey,
        opfs: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
      },
      signal,
    );

    expect(constructedOptions).toMatchObject({
      schema,
      sync: {
        worker: expect.any(Function),
      },
      database: {
        dbFilename: 'emdo.sqlite3',
        vfs: 'OPFSCoopSyncVFS',
        useWebWorker: true,
        enableMultiTabs: false,
        encryptionKey: '07'.repeat(32),
        worker: expect.any(Function),
      },
    });
    expect(workerRequests).toEqual([
      ['database', '/@powersync/worker.js', 'powersync-emdo.sqlite3'],
    ]);
    const connector = {
      fetchCredentials: async () => null,
      uploadData: async () => undefined,
    };
    await expect(
      runtime.connectEncryptedDatabase(
        { databaseName: 'emdo.sqlite3', connector },
        signal,
      ),
    ).resolves.toEqual({
      state: 'background-started',
      liveReplicationVerified: false,
    });
    expect(connectedConnector).toBe(connector);
    await connection.execute('UPDATE local_items SET value = 1');
    await expect(
      connection.query('SELECT value FROM local_items'),
    ).resolves.toEqual([{ value: 1 }]);
    await connection.transaction(async (transaction) => {
      await transaction.execute('INSERT INTO local_items VALUES (2)');
      await expect(transaction.query('SELECT value')).resolves.toEqual([
        { value: 2 },
      ]);
    });
    expect(statements).toEqual([
      'UPDATE local_items SET value = 1',
      'transaction:INSERT INTO local_items VALUES (2)',
    ]);
    await expect(
      runtime.deleteEncryptedDatabase(
        {
          databaseName: 'emdo.sqlite3',
          opfs: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
        },
        signal,
      ),
    ).rejects.toThrow(/open|active/i);

    await connection.close(signal);
    expect(closeOptions).toEqual({ disconnect: true });
    await runtime.deleteEncryptedDatabase(
      {
        databaseName: 'emdo.sqlite3',
        opfs: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
      },
      signal,
    );
    expect(removedEntries).toEqual([
      ['emdo.sqlite3', undefined],
      ['emdo.sqlite3-journal', undefined],
      ['emdo.sqlite3-wal', undefined],
      ['.ahp-stale', { recursive: true }],
    ]);
  });

  it('ships the static encrypted SQLite worker assets required by the PowerSync build', async () => {
    const require = createRequire(import.meta.url);
    const packageRoot = resolve(
      dirname(require.resolve('@powersync/web')),
      '..',
    );
    const assets = await readdir(resolve(packageRoot, 'dist/worker/assets'));

    expect(assets).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^mc-wa-sqlite-[A-Za-z0-9_-]+\.wasm$/u),
        expect.stringMatching(/^mc-wa-sqlite-async-[A-Za-z0-9_-]+\.wasm$/u),
      ]),
    );
  });

  it('bounds a stalled SDK module load before constructing any database worker', async () => {
    let workerCreations = 0;
    const runtime = new PowerSyncBrowserRuntime({
      schema: {} as never,
      openTimeoutMs: 10,
      sdkLoader: async () => new Promise<never>(() => undefined),
      workerFactory: {
        createDatabaseWorker: () => {
          workerCreations += 1;
          return { terminate: () => undefined } as unknown as Worker;
        },
        createSyncWorker: () => {
          workerCreations += 1;
          return {
            port: { close: () => undefined },
          } as unknown as SharedWorker;
        },
      },
      opfsStorage: {
        getDirectory: async () => ({
          removeEntry: async () => undefined,
          async *values() {
            yield* [];
          },
        }),
      },
      temporaryDirectoryLock: {
        runIfAvailable: async () => true,
      },
    });
    const signal = new AbortController().signal;

    await expect(
      runtime.openEncryptedDatabase(
        {
          databaseName: 'emdo.sqlite3',
          encryptionKey: new Uint8Array(32).fill(9),
          opfs: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
        },
        signal,
      ),
    ).rejects.toThrow(/open.*timed out/i);
    expect(workerCreations).toBe(0);
    await expect(
      runtime.deleteEncryptedDatabase(
        {
          databaseName: 'emdo.sqlite3',
          opfs: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
        },
        signal,
      ),
    ).resolves.toBeUndefined();
  });

  it('bounds a stalled encrypted database init and terminates its owned workers', async () => {
    let terminatedDatabaseWorkers = 0;
    let closedSyncWorkerPorts = 0;
    class StalledInitPowerSyncDatabase {
      constructor(options: Record<string, unknown>) {
        (
          options.database as {
            worker: (options: unknown) => Worker;
          }
        ).worker({});
      }

      async init(): Promise<void> {
        return new Promise<void>(() => undefined);
      }

      async close(): Promise<void> {
        return new Promise<void>(() => undefined);
      }
    }
    const runtime = new PowerSyncBrowserRuntime({
      schema: {} as never,
      openTimeoutMs: 10,
      workerFactory: {
        createDatabaseWorker: () =>
          ({
            terminate: () => {
              terminatedDatabaseWorkers += 1;
            },
          }) as unknown as Worker,
        createSyncWorker: () =>
          ({
            port: {
              close: () => {
                closedSyncWorkerPorts += 1;
              },
            },
          }) as unknown as SharedWorker,
      },
      sdkLoader: async () =>
        ({
          WASQLiteVFS: { OPFSCoopSyncVFS: 'OPFSCoopSyncVFS' },
          PowerSyncDatabase: StalledInitPowerSyncDatabase,
        }) as never,
      opfsStorage: {
        getDirectory: async () => ({
          removeEntry: async () => undefined,
          async *values() {
            yield* [];
          },
        }),
      },
      temporaryDirectoryLock: {
        runIfAvailable: async () => true,
      },
    });
    const signal = new AbortController().signal;

    await expect(
      runtime.openEncryptedDatabase(
        {
          databaseName: 'emdo.sqlite3',
          encryptionKey: new Uint8Array(32).fill(2),
          opfs: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
        },
        signal,
      ),
    ).rejects.toThrow(/open.*timed out/i);
    expect(terminatedDatabaseWorkers).toBe(1);
    expect(closedSyncWorkerPorts).toBe(0);
    await expect(
      runtime.deleteEncryptedDatabase(
        {
          databaseName: 'emdo.sqlite3',
          opfs: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
        },
        signal,
      ),
    ).resolves.toBeUndefined();
  });

  it('routes an abort at init completion through bounded owned-worker cleanup', async () => {
    const controller = new AbortController();
    let terminatedDatabaseWorkers = 0;
    class AbortedInitPowerSyncDatabase {
      constructor(options: Record<string, unknown>) {
        (
          options.database as {
            worker: (options: unknown) => Worker;
          }
        ).worker({});
      }

      async init(): Promise<void> {
        controller.abort(new Error('peer teardown'));
      }

      async close(): Promise<void> {
        return new Promise<void>(() => undefined);
      }
    }
    const runtime = new PowerSyncBrowserRuntime({
      schema: {} as never,
      workerFactory: {
        createDatabaseWorker: () =>
          ({
            terminate: () => {
              terminatedDatabaseWorkers += 1;
            },
          }) as unknown as Worker,
        createSyncWorker: () => {
          throw new Error('sync worker is not used by this fake');
        },
      },
      sdkLoader: async () =>
        ({
          WASQLiteVFS: { OPFSCoopSyncVFS: 'OPFSCoopSyncVFS' },
          PowerSyncDatabase: AbortedInitPowerSyncDatabase,
        }) as never,
      opfsStorage: {
        getDirectory: async () => ({
          removeEntry: async () => undefined,
          async *values() {
            yield* [];
          },
        }),
      },
      temporaryDirectoryLock: {
        runIfAvailable: async () => true,
      },
    });

    await expect(
      runtime.openEncryptedDatabase(
        {
          databaseName: 'emdo.sqlite3',
          encryptionKey: new Uint8Array(32).fill(1),
          opfs: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
        },
        controller.signal,
      ),
    ).rejects.toThrow(/open.*aborted/i);
    expect(terminatedDatabaseWorkers).toBe(1);
  });

  it('bounds a stalled PowerSync connection bootstrap and requests disconnect', async () => {
    let disconnectCount = 0;
    let terminatedDatabaseWorkers = 0;
    let closedSyncWorkerPorts = 0;
    class StalledPowerSyncDatabase {
      constructor(options: Record<string, unknown>) {
        (
          options.database as {
            worker: (options: unknown) => Worker;
          }
        ).worker({});
      }

      async init(): Promise<void> {
        return undefined;
      }

      async connect(): Promise<void> {
        return new Promise<void>(() => undefined);
      }

      async disconnect(): Promise<void> {
        disconnectCount += 1;
        return new Promise<void>(() => undefined);
      }

      async close(): Promise<void> {
        return new Promise<void>(() => undefined);
      }

      async execute(): Promise<void> {
        return undefined;
      }

      async getAll<Row>(): Promise<Row[]> {
        return [];
      }

      async writeTransaction<Value>(
        operation: (transaction: {
          execute(): Promise<void>;
          getAll<Row>(): Promise<Row[]>;
        }) => Promise<Value>,
      ): Promise<Value> {
        return operation({
          execute: async () => undefined,
          getAll: async <Row>() => [] as Row[],
        });
      }
    }
    const runtime = new PowerSyncBrowserRuntime({
      schema: {} as never,
      connectTimeoutMs: 10,
      closeTimeoutMs: 10,
      workerFactory: {
        createDatabaseWorker: () =>
          ({
            terminate: () => {
              terminatedDatabaseWorkers += 1;
            },
          }) as unknown as Worker,
        createSyncWorker: () =>
          ({
            port: {
              close: () => {
                closedSyncWorkerPorts += 1;
              },
            },
          }) as unknown as SharedWorker,
      },
      sdkLoader: async () =>
        ({
          WASQLiteVFS: { OPFSCoopSyncVFS: 'OPFSCoopSyncVFS' },
          PowerSyncDatabase: StalledPowerSyncDatabase,
        }) as never,
      opfsStorage: {
        getDirectory: async () => ({
          removeEntry: async () => undefined,
          async *values() {
            yield* [];
          },
        }),
      },
      temporaryDirectoryLock: {
        runIfAvailable: async () => true,
      },
    });
    const signal = new AbortController().signal;
    const connection = await runtime.openEncryptedDatabase(
      {
        databaseName: 'emdo.sqlite3',
        encryptionKey: new Uint8Array(32).fill(3),
        opfs: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
      },
      signal,
    );

    await expect(
      runtime.connectEncryptedDatabase(
        {
          databaseName: 'emdo.sqlite3',
          connector: {
            fetchCredentials: async () => null,
            uploadData: async () => undefined,
          },
        },
        signal,
      ),
    ).rejects.toThrow(/connect.*timed out/i);
    await Promise.resolve();
    expect(disconnectCount).toBe(1);
    await connection.close(signal);
    expect(terminatedDatabaseWorkers).toBe(1);
    expect(closedSyncWorkerPorts).toBe(0);
  });

  it('retains worker authority after failed forced close and retries termination before deletion', async () => {
    let terminationAttempts = 0;
    class StalledClosePowerSyncDatabase {
      constructor(options: Record<string, unknown>) {
        (
          options.database as {
            worker: (options: unknown) => Worker;
          }
        ).worker({});
      }

      async init(): Promise<void> {
        return undefined;
      }

      async close(): Promise<void> {
        return new Promise<void>(() => undefined);
      }

      async execute(): Promise<void> {
        return undefined;
      }

      async getAll<Row>(): Promise<Row[]> {
        return [];
      }

      async writeTransaction<Value>(
        operation: (transaction: {
          execute(): Promise<void>;
          getAll<Row>(): Promise<Row[]>;
        }) => Promise<Value>,
      ): Promise<Value> {
        return operation({
          execute: async () => undefined,
          getAll: async <Row>() => [] as Row[],
        });
      }
    }
    const runtime = new PowerSyncBrowserRuntime({
      schema: {} as never,
      closeTimeoutMs: 10,
      workerFactory: {
        createDatabaseWorker: () =>
          ({
            terminate: () => {
              terminationAttempts += 1;
              if (terminationAttempts === 1) {
                throw new Error('worker still owns OPFS');
              }
            },
          }) as unknown as Worker,
        createSyncWorker: () => {
          throw new Error('sync worker is not used by this fake');
        },
      },
      sdkLoader: async () =>
        ({
          WASQLiteVFS: { OPFSCoopSyncVFS: 'OPFSCoopSyncVFS' },
          PowerSyncDatabase: StalledClosePowerSyncDatabase,
        }) as never,
      opfsStorage: {
        getDirectory: async () => ({
          removeEntry: async () => undefined,
          async *values() {
            yield* [];
          },
        }),
      },
      temporaryDirectoryLock: {
        runIfAvailable: async () => true,
      },
    });
    const signal = new AbortController().signal;
    const connection = await runtime.openEncryptedDatabase(
      {
        databaseName: 'emdo.sqlite3',
        encryptionKey: new Uint8Array(32).fill(6),
        opfs: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
      },
      signal,
    );

    await expect(connection.close(signal)).rejects.toThrow(
      /termination.*incomplete/i,
    );
    await expect(
      runtime.deleteEncryptedDatabase(
        {
          databaseName: 'emdo.sqlite3',
          opfs: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
        },
        signal,
      ),
    ).rejects.toThrow(/active/i);
    await expect(connection.close(signal)).resolves.toBeUndefined();
    expect(terminationAttempts).toBe(2);
    await expect(
      runtime.deleteEncryptedDatabase(
        {
          databaseName: 'emdo.sqlite3',
          opfs: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
        },
        signal,
      ),
    ).resolves.toBeUndefined();
  });

  it('exposes the opened encrypted PowerSync SQL connection to the durable queue', async () => {
    const sqlConnection = createSqlConnection();
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const controller = new OfflineDatabaseController(
      new PowerSyncWebDatabaseAdapter({
        openEncryptedDatabase: async () => sqlConnection,
        connectEncryptedDatabase: async () => BACKGROUND_CONNECTION_ATTEMPT,
        deleteEncryptedDatabase: async () => undefined,
      }),
      {
        authenticatedSessionBinding: TEST_SESSION_BINDING,
        getOrCreateDatabaseKey: async () => new Uint8Array(32).fill(5),
      },
      lifecycleLock,
    );

    await controller.open();

    expect(controller.getEncryptedSqliteConnection()).toBe(sqlConnection);
    await purgeController(controller, lifecycleLock);
    expect(() => controller.getEncryptedSqliteConnection()).toThrow(
      /opened encrypted/i,
    );
  });

  it('disposes an active controller without deleting or tombstoning its database', async () => {
    const adapter = new InMemoryOfflineDatabaseAdapter();
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const keyProvider = {
      authenticatedSessionBinding: TEST_SESSION_BINDING,
      getOrCreateDatabaseKey: async () => new Uint8Array(32).fill(5),
    };
    const first = new OfflineDatabaseController(
      adapter,
      keyProvider,
      lifecycleLock,
    );
    await first.open();

    await expect(first.dispose()).resolves.toEqual({
      complete: true,
      failedSteps: [],
    });
    expect(adapter.hasLocalDatabase).toBe(true);
    await expect(first.open()).rejects.toThrow(/disposed/i);

    const replacement = new OfflineDatabaseController(
      adapter,
      keyProvider,
      lifecycleLock,
    );
    await expect(replacement.open()).resolves.toBeUndefined();
    await expect(replacement.dispose()).resolves.toMatchObject({
      complete: true,
    });
    expect(adapter.hasLocalDatabase).toBe(true);
  });

  it('keeps failed close/delete work retryable while permanently sealing opens', async () => {
    let closeAttempts = 0;
    let deleteAttempts = 0;
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const controller = new OfflineDatabaseController(
      {
        open: async () => ({
          close: async () => {
            closeAttempts += 1;
            if (closeAttempts === 1) {
              throw new Error('transient close');
            }
          },
        }),
        deleteLocalDatabase: async () => {
          deleteAttempts += 1;
          if (deleteAttempts === 1) {
            throw new Error('transient delete');
          }
        },
      },
      {
        authenticatedSessionBinding: TEST_SESSION_BINDING,
        getOrCreateDatabaseKey: async () => new Uint8Array(32),
      },
      lifecycleLock,
    );
    await controller.open();

    await expect(controller.sealAndCloseForLogout()).resolves.toEqual({
      complete: false,
      failedSteps: ['close-connection'],
    });
    await expect(purgeController(controller, lifecycleLock)).resolves.toEqual({
      complete: false,
      failedSteps: ['sqlite-opfs'],
    });
    await expect(purgeController(controller, lifecycleLock)).resolves.toEqual({
      complete: true,
      failedSteps: [],
    });
    expect(closeAttempts).toBe(2);
    expect(deleteAttempts).toBe(2);
    await expect(controller.open()).rejects.toThrow(/sealed/i);
  });

  it('rejects a purge permit from a different same-named lock authority', async () => {
    let deleteCalls = 0;
    const controllerLock = new InMemoryOfflineDatabaseLifecycleLock(
      'emdo:offline-database-lifecycle:shared-name',
    );
    const unrelatedLock = new InMemoryOfflineDatabaseLifecycleLock(
      'emdo:offline-database-lifecycle:shared-name',
    );
    const controller = new OfflineDatabaseController(
      {
        open: async () => ({ close: async () => undefined }),
        deleteLocalDatabase: async () => {
          deleteCalls += 1;
        },
      },
      {
        authenticatedSessionBinding: TEST_SESSION_BINDING,
        getOrCreateDatabaseKey: async () => new Uint8Array(32),
      },
      controllerLock,
    );
    await controller.open();
    await controller.sealAndCloseForLogout();

    await runTestPurge(unrelatedLock, async (permit, signal) => {
      await expect(controller.purge(permit, signal)).rejects.toThrow(/permit/i);
    });

    expect(deleteCalls).toBe(0);
  });

  it('rejects an otherwise valid permit bound to a different authenticated session', async () => {
    let deleteCalls = 0;
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const controller = new OfflineDatabaseController(
      {
        open: async () => ({ close: async () => undefined }),
        deleteLocalDatabase: async () => {
          deleteCalls += 1;
        },
      },
      {
        authenticatedSessionBinding: TEST_SESSION_BINDING,
        getOrCreateDatabaseKey: async () => new Uint8Array(32),
      },
      lifecycleLock,
    );
    await controller.open();
    await controller.sealAndCloseForLogout();
    await runTestPurge(
      lifecycleLock,
      async (permit, signal) => {
        await expect(controller.purge(permit, signal)).rejects.toThrow(
          /another session/i,
        );
      },
      'b'.repeat(64),
    );

    expect(deleteCalls).toBe(0);
  });

  it('holds the exclusive lease until a registered detached purge settles', async () => {
    let signalDeleteStarted = (): void => undefined;
    const deleteStarted = new Promise<void>((resolve) => {
      signalDeleteStarted = resolve;
    });
    let finishDelete = (): void => undefined;
    const deleteGate = new Promise<void>((resolve) => {
      finishDelete = resolve;
    });
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const controller = new OfflineDatabaseController(
      {
        open: async () => ({ close: async () => undefined }),
        deleteLocalDatabase: async () => {
          signalDeleteStarted();
          await deleteGate;
        },
      },
      {
        authenticatedSessionBinding: TEST_SESSION_BINDING,
        getOrCreateDatabaseKey: async () => new Uint8Array(32),
      },
      lifecycleLock,
    );
    await controller.sealAndCloseForLogout();
    let detachedPurge: Promise<unknown> | null = null;

    const exclusive = runTestPurge(lifecycleLock, async (permit, signal) => {
      detachedPurge = controller.purge(permit, signal);
    });
    await deleteStarted;
    let sharedAcquired = false;
    const nextSharedLease = lifecycleLock
      .acquireSharedOpenLease()
      .then((lease) => {
        sharedAcquired = true;
        return lease;
      });
    await Promise.resolve();

    expect(sharedAcquired).toBe(false);
    finishDelete();
    await exclusive;
    await detachedPurge;
    const sharedLease = await nextSharedLease;
    await sharedLease.release();
  });

  it('drains every registered purge before propagating one purge failure', async () => {
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    let failFirstPurge: (error: Error) => void = () => undefined;
    const failedPurge = new Promise<void>((_resolve, reject) => {
      failFirstPurge = reject;
    });
    let finishSlowPurge = (): void => undefined;
    const slowPurge = new Promise<void>((resolve) => {
      finishSlowPurge = resolve;
    });
    let signalOperationsRegistered = (): void => undefined;
    const operationsRegistered = new Promise<void>((resolve) => {
      signalOperationsRegistered = resolve;
    });
    const exclusive = runTestPurge(lifecycleLock, async (permit) => {
      void registerOfflinePurgeOperation(
        permit,
        lifecycleLock,
        'database',
        async () => failedPurge,
      );
      void registerOfflinePurgeOperation(
        permit,
        lifecycleLock,
        'database',
        async () => slowPurge,
      );
      signalOperationsRegistered();
    });
    void exclusive.catch(() => undefined);
    await operationsRegistered;
    failFirstPurge(new Error('first purge failed'));
    let sharedAcquired = false;
    const nextSharedLease = lifecycleLock
      .acquireSharedOpenLease()
      .then((lease) => {
        sharedAcquired = true;
        return lease;
      });
    const earlyExclusiveResult = await Promise.race([
      exclusive.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      new Promise<'still-held'>((resolve) => {
        setTimeout(() => resolve('still-held'), 10);
      }),
    ]);

    expect(earlyExclusiveResult).toBe('still-held');
    expect(sharedAcquired).toBe(false);
    finishSlowPurge();
    await expect(exclusive).rejects.toThrow('first purge failed');
    const sharedLease = await nextSharedLease;
    await sharedLease.release();
  });

  it('keeps permit issuance behind verified teardown and binds immutable claims', async () => {
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const forged = Object.freeze({
      version: 1 as const,
      requestId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f703',
      sessionBinding: 'a'.repeat(64),
      decision: 'discard' as const,
      deadlineAt: Date.now() + 10_000,
      targets: ['database', 'keys'] as const,
    }) as VerifiedOfflinePurgeAuthorization;

    await expect(
      lifecycleLock.runWithExclusivePurgeLease(
        forged,
        new AbortController().signal,
        async () => undefined,
      ),
    ).rejects.toThrow(/verified|authorization/i);

    let verifiedRequest:
      | {
          readonly requestId: string;
          readonly sessionBinding: string;
          readonly decision: 'discard' | 'sync-now';
          readonly deadlineAt: number;
        }
      | undefined;
    const prepared = await new VerifiedCrossContextLogoutBoundary(
      {
        requestKnownContextTeardown: async (request) => {
          verifiedRequest = request;
          return { knownContextIds: [], acknowledgements: [] };
        },
      },
      lifecycleLock,
      { sessionBinding: TEST_SESSION_BINDING },
    ).prepare('discard');
    await prepared.run(async (permit) => {
      expect(verifiedRequest).toBeDefined();
      expect(permit).toMatchObject({
        requestId: verifiedRequest?.requestId,
        sessionBinding: verifiedRequest?.sessionBinding,
        decision: verifiedRequest?.decision,
        deadlineAt: verifiedRequest?.deadlineAt,
      });
      expect(permit.targets).toEqual([
        'database',
        'keys',
        'auth-tokens',
        'sync-tokens',
        'private-caches',
      ]);
    });
    await expect(prepared.run(async () => undefined)).rejects.toThrow(
      /terminal/i,
    );
    const moduleExports = await import('./database.js');
    expect('authorizeOfflinePurgeAfterVerifiedTeardown' in moduleExports).toBe(
      false,
    );
  });
});

describe('BroadcastChannelCrossContextTeardownTransport', () => {
  const contextA = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f201';
  const contextB = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f202';

  it('derives the complete same-session peer set and returns exact sealed acknowledgements', async () => {
    const presence = new InMemoryBrowserContextPresenceStore();
    const hub = new TestCrossContextBroadcastHub();
    const peerRequests: unknown[] = [];
    const first = await BroadcastChannelCrossContextTeardownTransport.create({
      contextId: contextA,
      sessionBinding: TEST_SESSION_BINDING,
      presenceStore: presence,
      channelFactory: hub.create,
      heartbeatIntervalMs: 10_000,
      contextStaleAfterMs: 20_000,
      teardownPeer: async () => undefined,
    });
    const second = await BroadcastChannelCrossContextTeardownTransport.create({
      contextId: contextB,
      sessionBinding: TEST_SESSION_BINDING,
      presenceStore: presence,
      channelFactory: hub.create,
      heartbeatIntervalMs: 10_000,
      contextStaleAfterMs: 20_000,
      teardownPeer: async (request) => {
        peerRequests.push(request);
      },
    });
    const request = {
      version: 1 as const,
      requestId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f203',
      sessionBinding: TEST_SESSION_BINDING,
      decision: 'discard' as const,
      deadlineAt: Date.now() + 2_000,
    };

    const response = await first.requestKnownContextTeardown(
      request,
      new AbortController().signal,
    );

    expect(response).toEqual({
      knownContextIds: [contextB],
      acknowledgements: [
        {
          version: 1,
          requestId: request.requestId,
          sessionBinding: request.sessionBinding,
          decision: request.decision,
          deadlineAt: request.deadlineAt,
          contextId: contextB,
          state: 'sealed-and-closed',
        },
      ],
    });
    expect(peerRequests).toEqual([request]);
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it('fails closed when a live known context cannot acknowledge', async () => {
    const presence = new InMemoryBrowserContextPresenceStore();
    const hub = new TestCrossContextBroadcastHub();
    const first = await BroadcastChannelCrossContextTeardownTransport.create({
      contextId: contextA,
      sessionBinding: TEST_SESSION_BINDING,
      presenceStore: presence,
      channelFactory: hub.create,
      heartbeatIntervalMs: 10_000,
      contextStaleAfterMs: 20_000,
      teardownPeer: async () => undefined,
    });
    await presence.upsert({
      version: 1,
      contextId: contextB,
      sessionBinding: TEST_SESSION_BINDING,
      lastSeenAt: Date.now(),
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);

    await expect(
      first.requestKnownContextTeardown(
        {
          version: 1,
          requestId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f204',
          sessionBinding: TEST_SESSION_BINDING,
          decision: 'sync-now',
          deadlineAt: Date.now() + 2_000,
        },
        controller.signal,
      ),
    ).rejects.toThrow(/abort|acknowledge|context/i);
    await first.dispose();
  });

  it('excludes other sessions and stale registrations from a teardown request', async () => {
    const presence = new InMemoryBrowserContextPresenceStore();
    const hub = new TestCrossContextBroadcastHub();
    const now = Date.now();
    const first = await BroadcastChannelCrossContextTeardownTransport.create({
      contextId: contextA,
      sessionBinding: TEST_SESSION_BINDING,
      presenceStore: presence,
      channelFactory: hub.create,
      heartbeatIntervalMs: 250,
      contextStaleAfterMs: 1_000,
      now: () => now,
      teardownPeer: async () => undefined,
    });
    await presence.upsert({
      version: 1,
      contextId: contextB,
      sessionBinding: 'b'.repeat(64),
      lastSeenAt: now,
    });
    await presence.upsert({
      version: 1,
      contextId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f205',
      sessionBinding: TEST_SESSION_BINDING,
      lastSeenAt: now - 2_000,
    });

    await expect(
      first.requestKnownContextTeardown(
        {
          version: 1,
          requestId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f206',
          sessionBinding: TEST_SESSION_BINDING,
          decision: 'discard',
          deadlineAt: now + 2_000,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ knownContextIds: [], acknowledgements: [] });
    await first.dispose();
  });
});

class TestCrossContextBroadcastHub {
  private readonly channels = new Set<TestCrossContextBroadcastChannel>();

  readonly create = (name: string): TestCrossContextBroadcastChannel => {
    void name;
    const channel = new TestCrossContextBroadcastChannel(this);
    this.channels.add(channel);
    return channel;
  };

  post(sender: TestCrossContextBroadcastChannel, data: unknown): void {
    for (const channel of this.channels) {
      if (channel !== sender) {
        queueMicrotask(() => channel.deliver(data));
      }
    }
  }

  close(channel: TestCrossContextBroadcastChannel): void {
    this.channels.delete(channel);
  }
}

class TestCrossContextBroadcastChannel {
  private readonly listeners = new Set<
    (event: MessageEvent<unknown>) => void
  >();

  constructor(private readonly hub: TestCrossContextBroadcastHub) {}

  postMessage(data: unknown): void {
    this.hub.post(this, data);
  }

  addEventListener(
    _type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listeners.delete(listener);
  }

  close(): void {
    this.hub.close(this);
  }

  deliver(data: unknown): void {
    for (const listener of this.listeners) {
      listener({ data } as MessageEvent<unknown>);
    }
  }
}

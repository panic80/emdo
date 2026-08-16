import { describe, expect, it, vi } from 'vitest';

import {
  CrossContextPurgeBarrierExpiredError,
  InMemoryBrowserContextPresenceStore,
  InMemoryOfflineDatabaseAdapter,
  InMemoryOfflineDatabaseLifecycleLock,
  OfflineDatabaseController,
  type EncryptedSqliteConnection,
} from './database.js';
import {
  DeviceDatabaseKeyManager,
  InMemoryDeviceKeyStorage,
  InMemoryExclusiveDeviceLock,
} from './key-manager.js';
import {
  BrowserStaticAssetCache,
  LogoutPurgeCoordinator,
  OFFLINE_STORAGE_SECURITY_NOTICE,
  VerifiedCrossContextLogoutBoundary,
  assertServiceWorkerCacheable,
  createBrowserOfflineLogoutRecoveryComposition,
  createBrowserOfflineRuntimeComposition,
  inspectBrowserOfflineSession,
  type LogoutPurgeDependencies,
} from './logout-purge.js';
import {
  ApiCanonicalSyncClient,
  InMemoryPendingOperationStore,
} from './sync-client.js';

const TEST_SESSION_BINDING = 'a'.repeat(64);
const TEST_REPLICATION_CLIENT_ID = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f399';
const BACKGROUND_CONNECTION_ATTEMPT = Object.freeze({
  state: 'background-started' as const,
  liveReplicationVerified: false as const,
});

const successfulDependencies = (calls: string[]): LogoutPurgeDependencies => {
  const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
  return {
    sync: {
      sealForLogout: async () => undefined,
      resumeAfterFailedLogout: () => undefined,
      hasPendingOperations: async () => true,
      syncNowForLogout: async () => {
        calls.push('sync');
        return {
          status: 'complete',
          submittedCount: 1,
          acceptedOperationIds: ['018f1f5e-6f47-7d61-a6dd-1e86f8b8f001'],
          terminalConflicts: [],
          retryableOperations: [],
        };
      },
    },
    database: {
      sealAndCloseForLogout: async () => ({ complete: true, failedSteps: [] }),
      purge: async () => {
        calls.push('database');
        return { complete: true, failedSteps: [] };
      },
    },
    keys: {
      sealForLogout: async () => ({ complete: true, failedSteps: [] }),
      purge: async () => {
        calls.push('keys');
        return { complete: true, failedSteps: [] };
      },
    },
    crossContext: new VerifiedCrossContextLogoutBoundary(
      {
        requestKnownContextTeardown: async () => ({
          knownContextIds: [],
          acknowledgements: [],
        }),
      },
      lifecycleLock,
      { sessionBinding: TEST_SESSION_BINDING },
    ),
    serverSession: {
      revokeServerSession: async () => undefined,
    },
    tokens: {
      deleteAuthTokens: async () => {
        calls.push('auth-tokens');
      },
      deleteSyncTokens: async () => {
        calls.push('sync-tokens');
      },
    },
    privateCaches: {
      purge: async () => {
        calls.push('private-caches');
      },
    },
  };
};

describe('LogoutPurgeCoordinator', () => {
  it('exposes only an opaque, fail-closed offline session hint', async () => {
    const storage = new InMemoryDeviceKeyStorage();
    await expect(inspectBrowserOfflineSession(storage)).resolves.toBeNull();
    const keys = new DeviceDatabaseKeyManager(
      storage,
      crypto,
      new InMemoryExclusiveDeviceLock(),
      TEST_SESSION_BINDING,
    );
    const databaseKey = await keys.getOrCreateDatabaseKey();
    databaseKey.fill(0);

    await expect(inspectBrowserOfflineSession(storage)).resolves.toEqual({
      version: 1,
      status: 'active',
      canEditOffline: true,
      sessionBinding: TEST_SESSION_BINDING,
    });
    expect(
      Object.keys((await inspectBrowserOfflineSession(storage)) ?? {}),
    ).toEqual(['version', 'status', 'canEditOffline', 'sessionBinding']);

    await expect(keys.sealForLogout()).resolves.toMatchObject({
      complete: true,
    });
    await expect(inspectBrowserOfflineSession(storage)).resolves.toEqual({
      version: 1,
      status: 'logout-pending',
      canEditOffline: false,
      sessionBinding: TEST_SESSION_BINDING,
    });
    await storage.deleteWrappingKey();
    await expect(inspectBrowserOfflineSession(storage)).rejects.toThrow(
      /incomplete/i,
    );
  });

  it('requires sync-now or an explicitly confirmed discard before purging', async () => {
    const calls: string[] = [];
    const coordinator = new LogoutPurgeCoordinator(
      successfulDependencies(calls),
    );

    await expect(coordinator.logout()).resolves.toEqual({
      status: 'decision-required',
      failedSteps: [],
    });
    await expect(
      coordinator.logout({ kind: 'discard', confirmed: false } as never),
    ).resolves.toEqual({
      status: 'decision-required',
      failedSteps: [],
    });
    expect(calls).toEqual([]);
  });

  it('syncs pending operations before completely purging local private state', async () => {
    const calls: string[] = [];
    const dependencies = successfulDependencies(calls);
    dependencies.sync.hasPendingOperations = async () => false;
    const coordinator = new LogoutPurgeCoordinator(dependencies);

    await expect(coordinator.logout({ kind: 'sync-now' })).resolves.toEqual({
      status: 'complete',
      failedSteps: [],
    });
    expect(calls).toEqual([
      'sync',
      'database',
      'auth-tokens',
      'sync-tokens',
      'private-caches',
      'keys',
    ]);
  });

  it('completes logout when every pending operation settles terminally', async () => {
    const calls: string[] = [];
    const dependencies = successfulDependencies(calls);
    dependencies.sync.syncNowForLogout = async () => ({
      status: 'complete',
      submittedCount: 1,
      acceptedOperationIds: [],
      terminalConflicts: [
        {
          operationId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
          status: 'conflict',
          code: 'material-conflict',
          conflicts: [{ field: 'time', material: true }],
        },
      ],
      retryableOperations: [],
    });
    dependencies.sync.hasPendingOperations = async () => false;

    await expect(
      new LogoutPurgeCoordinator(dependencies).logout({ kind: 'sync-now' }),
    ).resolves.toEqual({ status: 'complete', failedSteps: [] });
    expect(calls).toEqual([
      'database',
      'auth-tokens',
      'sync-tokens',
      'private-caches',
      'keys',
    ]);
  });

  it('continues terminal-only batches until the durable queue is empty', async () => {
    const calls: string[] = [];
    const dependencies = successfulDependencies(calls);
    let syncCount = 0;
    dependencies.sync.syncNowForLogout = async () => {
      syncCount += 1;
      return {
        status: 'complete',
        submittedCount: 1,
        acceptedOperationIds: [],
        terminalConflicts: [
          {
            operationId: `018f1f5e-6f47-7d61-a6dd-1e86f8b8f00${syncCount}`,
            status: 'conflict' as const,
            code: 'material-conflict',
            conflicts: [{ field: 'time', material: true }],
          },
        ],
        retryableOperations: [],
      };
    };
    dependencies.sync.hasPendingOperations = async () => syncCount < 2;

    await expect(
      new LogoutPurgeCoordinator(dependencies).logout({ kind: 'sync-now' }),
    ).resolves.toEqual({ status: 'complete', failedSteps: [] });
    expect(syncCount).toBe(2);
  });

  it('revokes the server session after readiness and close but before local deletion', async () => {
    const calls: string[] = [];
    const dependencies = successfulDependencies(calls);
    dependencies.sync.hasPendingOperations = async () => false;
    dependencies.database.sealAndCloseForLogout = async () => {
      calls.push('database-close');
      return { complete: true, failedSteps: [] };
    };
    dependencies.serverSession.revokeServerSession = async () => {
      calls.push('server-session');
    };

    await expect(
      new LogoutPurgeCoordinator(dependencies).logout({ kind: 'sync-now' }),
    ).resolves.toEqual({ status: 'complete', failedSteps: [] });
    expect(calls).toEqual([
      'sync',
      'database-close',
      'server-session',
      'database',
      'auth-tokens',
      'sync-tokens',
      'private-caches',
      'keys',
    ]);
  });

  it('does not purge or claim logout when server session revocation fails', async () => {
    const calls: string[] = [];
    const dependencies = successfulDependencies(calls);
    dependencies.serverSession.revokeServerSession = async () => {
      calls.push('server-session');
      throw new Error('network unavailable');
    };

    await expect(
      new LogoutPurgeCoordinator(dependencies).logout({
        kind: 'discard',
        confirmed: true,
      }),
    ).resolves.toEqual({
      status: 'logout-blocked',
      failedSteps: ['server-session'],
    });
    expect(calls).toEqual(['server-session']);
  });

  it('preserves local state when sync fails or leaves retryable operations', async () => {
    const calls: string[] = [];
    const dependencies = successfulDependencies(calls);
    dependencies.sync.syncNowForLogout = async () => ({
      status: 'partial',
      submittedCount: 1,
      acceptedOperationIds: [],
      terminalConflicts: [],
      retryableOperations: [
        {
          operationId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
          status: 'conflict',
          code: 'operation-in-progress',
        },
      ],
    });
    const coordinator = new LogoutPurgeCoordinator(dependencies);

    await expect(coordinator.logout({ kind: 'sync-now' })).resolves.toEqual({
      status: 'sync-failed',
      failedSteps: ['canonical-sync'],
    });
    expect(calls).toEqual([]);
  });

  it('keeps a failed sync logout recoverable only through the same session', async () => {
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const deviceLock = new InMemoryExclusiveDeviceLock();
    const storage = new InMemoryDeviceKeyStorage();
    const keys = new DeviceDatabaseKeyManager(
      storage,
      crypto,
      deviceLock,
      TEST_SESSION_BINDING,
      lifecycleLock,
    );
    const expectedKey = await keys.getOrCreateDatabaseKey();
    const database = new OfflineDatabaseController(
      new InMemoryOfflineDatabaseAdapter(),
      keys,
      lifecycleLock,
    );
    await database.open();
    const dependencies = successfulDependencies([]);
    dependencies.keys = keys;
    dependencies.database = database;
    dependencies.sync.syncNowForLogout = async () => ({
      status: 'partial',
      submittedCount: 1,
      acceptedOperationIds: [],
      terminalConflicts: [],
      retryableOperations: [
        {
          operationId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
          status: 'conflict',
          code: 'operation-in-progress',
        },
      ],
    });
    dependencies.crossContext = new VerifiedCrossContextLogoutBoundary(
      {
        requestKnownContextTeardown: async () => ({
          knownContextIds: [],
          acknowledgements: [],
        }),
      },
      lifecycleLock,
      { sessionBinding: TEST_SESSION_BINDING },
    );

    await expect(
      new LogoutPurgeCoordinator(dependencies).logout({ kind: 'sync-now' }),
    ).resolves.toEqual({
      status: 'sync-failed',
      failedSteps: ['canonical-sync'],
    });
    const recovery = new DeviceDatabaseKeyManager(
      storage,
      crypto,
      deviceLock,
      TEST_SESSION_BINDING,
      lifecycleLock,
    );
    await expect(recovery.getOrCreateDatabaseKey()).rejects.toThrow(/logout/i);
    await expect(
      recovery.getExistingDatabaseKeyForLogoutRecovery(),
    ).resolves.toEqual(expectedKey);
    await database.sealAndCloseForLogout();
  });

  it('seals new local edits before syncing or discarding', async () => {
    const calls: string[] = [];
    const dependencies = successfulDependencies(calls);
    dependencies.sync.sealForLogout = async () => {
      calls.push('seal-edits');
    };
    dependencies.sync.hasPendingOperations = async () => false;

    await new LogoutPurgeCoordinator(dependencies).logout({
      kind: 'sync-now',
    });

    expect(calls.slice(0, 2)).toEqual(['seal-edits', 'sync']);
  });

  it('bounds a hung initial local-edit seal and resumes the active session', async () => {
    const calls: string[] = [];
    const dependencies = successfulDependencies(calls);
    let observedSignal: AbortSignal | null = null;
    dependencies.sync.sealForLogout = async (signal) => {
      observedSignal = signal;
      return new Promise(() => undefined);
    };
    dependencies.sync.resumeAfterFailedLogout = () => {
      calls.push('resume-edits');
    };
    const result = await Promise.race([
      new LogoutPurgeCoordinator(dependencies, {
        preflightTimeoutMs: 5,
      }).logout({ kind: 'discard', confirmed: true }),
      new Promise<'test-timeout'>((resolve) => {
        setTimeout(() => resolve('test-timeout'), 100);
      }),
    ]);

    expect(result).toEqual({
      status: 'logout-blocked',
      failedSteps: ['local-edit-boundary'],
    });
    expect(calls).toEqual(['resume-edits']);
    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('bounds a hung durable key seal without starting destructive purge', async () => {
    const calls: string[] = [];
    const dependencies = successfulDependencies(calls);
    let observedSignal: AbortSignal | null = null;
    dependencies.keys.sealForLogout = async (signal) => {
      observedSignal = signal;
      return new Promise(() => undefined);
    };
    const result = await Promise.race([
      new LogoutPurgeCoordinator(dependencies, {
        preflightTimeoutMs: 5,
      }).logout({ kind: 'discard', confirmed: true }),
      new Promise<'test-timeout'>((resolve) => {
        setTimeout(() => resolve('test-timeout'), 100);
      }),
    ]);

    expect(result).toEqual({
      status: 'logout-blocked',
      failedSteps: ['keys'],
    });
    expect(calls).toEqual([]);
    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('drains multiple canonical upload batches before purging', async () => {
    const calls: string[] = [];
    const dependencies = successfulDependencies(calls);
    let syncCount = 0;
    dependencies.sync.syncNowForLogout = async () => {
      calls.push('sync');
      syncCount += 1;
      return {
        status: 'complete',
        submittedCount: 1,
        acceptedOperationIds: [
          `018f1f5e-6f47-7d61-a6dd-1e86f8b8f00${syncCount}`,
        ],
        terminalConflicts: [],
        retryableOperations: [],
      };
    };
    dependencies.sync.hasPendingOperations = async () => syncCount < 2;

    await expect(
      new LogoutPurgeCoordinator(dependencies).logout({ kind: 'sync-now' }),
    ).resolves.toEqual({ status: 'complete', failedSteps: [] });
    expect(calls.filter((call) => call === 'sync')).toHaveLength(2);
  });

  it('allows an explicitly confirmed discard without attempting sync', async () => {
    const calls: string[] = [];
    const coordinator = new LogoutPurgeCoordinator(
      successfulDependencies(calls),
    );

    await expect(
      coordinator.logout({ kind: 'discard', confirmed: true }),
    ).resolves.toEqual({ status: 'complete', failedSteps: [] });
    expect(calls).not.toContain('sync');
    expect(calls).toEqual([
      'database',
      'auth-tokens',
      'sync-tokens',
      'private-caches',
      'keys',
    ]);
  });

  it('attempts non-key purge targets and preserves recovery keys after failure', async () => {
    const calls: string[] = [];
    const dependencies = successfulDependencies(calls);
    dependencies.database.purge = async () => {
      calls.push('database');
      return { complete: false, failedSteps: ['sqlite-opfs'] };
    };
    dependencies.keys.purge = async () => {
      calls.push('keys');
      throw new Error('sensitive key store diagnostic');
    };
    dependencies.tokens.deleteAuthTokens = async () => {
      calls.push('auth-tokens');
      throw new Error('sensitive auth diagnostic');
    };

    const result = await new LogoutPurgeCoordinator(dependencies).logout({
      kind: 'discard',
      confirmed: true,
    });

    expect(result).toEqual({
      status: 'incomplete',
      failedSteps: ['database.sqlite-opfs', 'auth-tokens'],
    });
    expect(JSON.stringify(result)).not.toContain('sensitive');
    expect(calls).toEqual([
      'database',
      'auth-tokens',
      'sync-tokens',
      'private-caches',
    ]);
  });

  it('keeps logout-pending key material recoverable across reload until later cleanup succeeds', async () => {
    const storage = new InMemoryDeviceKeyStorage();
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const initialKeys = new DeviceDatabaseKeyManager(
      storage,
      crypto,
      new InMemoryExclusiveDeviceLock(),
      TEST_SESSION_BINDING,
      lifecycleLock,
    );
    (await initialKeys.getOrCreateDatabaseKey()).fill(0);
    const firstDependencies = successfulDependencies([]);
    firstDependencies.keys = {
      sealForLogout: (signal) => initialKeys.sealForLogout(signal),
      purge: (permit, signal) => initialKeys.purge(permit, signal),
    };
    firstDependencies.crossContext = new VerifiedCrossContextLogoutBoundary(
      {
        requestKnownContextTeardown: async () => ({
          knownContextIds: [],
          acknowledgements: [],
        }),
      },
      lifecycleLock,
      { sessionBinding: TEST_SESSION_BINDING },
    );
    firstDependencies.privateCaches.purge = async () => {
      throw new Error('cache cleanup unavailable');
    };

    await expect(
      new LogoutPurgeCoordinator(firstDependencies).logout({
        kind: 'discard',
        confirmed: true,
      }),
    ).resolves.toEqual({
      status: 'incomplete',
      failedSteps: ['private-caches'],
    });
    await expect(inspectBrowserOfflineSession(storage)).resolves.toEqual({
      version: 1,
      status: 'logout-pending',
      canEditOffline: false,
      sessionBinding: TEST_SESSION_BINDING,
    });

    const reloadedKeys = new DeviceDatabaseKeyManager(
      storage,
      crypto,
      new InMemoryExclusiveDeviceLock(),
      TEST_SESSION_BINDING,
      lifecycleLock,
    );
    (await reloadedKeys.getExistingDatabaseKeyForLogoutRecovery()).fill(0);
    const retryDependencies = successfulDependencies([]);
    retryDependencies.keys = {
      sealForLogout: (signal) => reloadedKeys.sealForLogout(signal),
      purge: (permit, signal) => reloadedKeys.purge(permit, signal),
    };
    retryDependencies.crossContext = new VerifiedCrossContextLogoutBoundary(
      {
        requestKnownContextTeardown: async () => ({
          knownContextIds: [],
          acknowledgements: [],
        }),
      },
      lifecycleLock,
      { sessionBinding: TEST_SESSION_BINDING },
    );

    await expect(
      new LogoutPurgeCoordinator(retryDependencies).logout({
        kind: 'discard',
        confirmed: true,
      }),
    ).resolves.toEqual({ status: 'complete', failedSteps: [] });
    await expect(storage.loadWrappingKey()).resolves.toBeNull();
    await expect(storage.loadWrappedDatabaseKey()).resolves.toBeNull();
  });

  it('fails closed on an internally inconsistent purge report', async () => {
    const calls: string[] = [];
    const dependencies = successfulDependencies(calls);
    dependencies.database.purge = async () => ({
      complete: false,
      failedSteps: [],
    });

    await expect(
      new LogoutPurgeCoordinator(dependencies).logout({
        kind: 'discard',
        confirmed: true,
      }),
    ).resolves.toEqual({
      status: 'incomplete',
      failedSteps: ['database'],
    });
  });

  it('deduplicates concurrent logout purge requests', async () => {
    const calls: string[] = [];
    const dependencies = successfulDependencies(calls);
    let releaseDatabase = (): void => undefined;
    const databaseGate = new Promise<void>((resolve) => {
      releaseDatabase = resolve;
    });
    dependencies.database.purge = async () => {
      calls.push('database');
      await databaseGate;
      return { complete: true, failedSteps: [] };
    };
    const coordinator = new LogoutPurgeCoordinator(dependencies);
    const decision = { kind: 'discard', confirmed: true } as const;

    const first = coordinator.logout(decision);
    const second = coordinator.logout(decision);
    await Promise.resolve();
    releaseDatabase();
    await Promise.all([first, second]);

    expect(calls.filter((call) => call === 'database')).toHaveLength(1);
    expect(calls.filter((call) => call === 'keys')).toHaveLength(1);
  });

  it('writes the durable tombstone but refuses deletion when peer teardown fails', async () => {
    const calls: string[] = [];
    const dependencies = successfulDependencies(calls);
    dependencies.keys.sealForLogout = async () => {
      calls.push('key-tombstone');
      return { complete: true, failedSteps: [] };
    };
    dependencies.crossContext = {
      prepare: async () => {
        throw new Error('peer timeout');
      },
    };

    await expect(
      new LogoutPurgeCoordinator(dependencies).logout({
        kind: 'discard',
        confirmed: true,
      }),
    ).resolves.toEqual({
      status: 'logout-blocked',
      failedSteps: ['cross-context-teardown'],
    });
    expect(calls).toEqual(['key-tombstone']);
  });

  it('times out a hung local close without deleting OPFS, keys, or tokens', async () => {
    const calls: string[] = [];
    const dependencies = successfulDependencies(calls);
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    dependencies.keys.sealForLogout = async () => {
      calls.push('key-tombstone');
      return { complete: true, failedSteps: [] };
    };
    let closeSignal: AbortSignal | null = null;
    dependencies.database.sealAndCloseForLogout = async (signal) => {
      closeSignal = signal;
      return new Promise(() => undefined);
    };
    dependencies.crossContext = new VerifiedCrossContextLogoutBoundary(
      {
        requestKnownContextTeardown: async () => ({
          knownContextIds: [],
          acknowledgements: [],
        }),
      },
      lifecycleLock,
      { sessionBinding: TEST_SESSION_BINDING, timeoutMs: 5 },
    );

    const result = await Promise.race([
      new LogoutPurgeCoordinator(dependencies).logout({
        kind: 'discard',
        confirmed: true,
      }),
      new Promise<'test-timeout'>((resolve) => {
        setTimeout(() => resolve('test-timeout'), 100);
      }),
    ]);

    expect(result).toEqual({
      status: 'logout-blocked',
      failedSteps: ['database', 'cross-context-teardown'],
    });
    expect(calls).toEqual(['key-tombstone']);
    expect((closeSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('times out a hung canonical sync after peer teardown without purging', async () => {
    const calls: string[] = [];
    const dependencies = successfulDependencies(calls);
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    dependencies.keys.sealForLogout = async () => {
      calls.push('key-tombstone');
      return { complete: true, failedSteps: [] };
    };
    let syncSignal: AbortSignal | null = null;
    dependencies.sync.syncNowForLogout = async (signal) => {
      syncSignal = signal;
      return new Promise(() => undefined);
    };
    dependencies.crossContext = new VerifiedCrossContextLogoutBoundary(
      {
        requestKnownContextTeardown: async () => ({
          knownContextIds: [],
          acknowledgements: [],
        }),
      },
      lifecycleLock,
      { sessionBinding: TEST_SESSION_BINDING, timeoutMs: 50 },
    );

    await expect(
      new LogoutPurgeCoordinator(dependencies).logout({ kind: 'sync-now' }),
    ).resolves.toEqual({
      status: 'sync-failed',
      failedSteps: ['canonical-sync', 'cross-context-teardown'],
    });
    expect(calls).toEqual(['key-tombstone']);
    expect((syncSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('propagates the teardown deadline through destructive purge targets', async () => {
    const calls: string[] = [];
    const dependencies = successfulDependencies(calls);
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    dependencies.crossContext = new VerifiedCrossContextLogoutBoundary(
      {
        requestKnownContextTeardown: async () => ({
          knownContextIds: [],
          acknowledgements: [],
        }),
      },
      lifecycleLock,
      { sessionBinding: TEST_SESSION_BINDING, timeoutMs: 5 },
    );
    dependencies.database.purge = async (_permit, signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            calls.push('database-aborted');
            resolve({ complete: false, failedSteps: ['sqlite-opfs'] });
          },
          { once: true },
        );
      });
    dependencies.keys.purge = async (_permit, signal) => {
      calls.push(signal.aborted ? 'keys-aborted' : 'keys-live');
      return { complete: true, failedSteps: [] };
    };
    dependencies.tokens.deleteAuthTokens = async (signal) => {
      calls.push(signal.aborted ? 'auth-aborted' : 'auth-live');
    };
    dependencies.tokens.deleteSyncTokens = async (signal) => {
      calls.push(signal.aborted ? 'sync-token-aborted' : 'sync-token-live');
    };
    dependencies.privateCaches.purge = async (signal) => {
      calls.push(signal.aborted ? 'cache-aborted' : 'cache-live');
    };

    const result = await Promise.race([
      new LogoutPurgeCoordinator(dependencies).logout({
        kind: 'discard',
        confirmed: true,
      }),
      new Promise<'test-timeout'>((resolve) => {
        setTimeout(() => resolve('test-timeout'), 100);
      }),
    ]);

    expect(result).toEqual({
      status: 'incomplete',
      failedSteps: ['database.sqlite-opfs'],
    });
    expect(calls).toEqual([
      'database-aborted',
      'auth-aborted',
      'sync-token-aborted',
      'cache-aborted',
    ]);
  });

  it('purges the integrated in-memory database and wrapped keys only under the exclusive permit', async () => {
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const keyStorage = new InMemoryDeviceKeyStorage();
    const keys = new DeviceDatabaseKeyManager(
      keyStorage,
      crypto,
      new InMemoryExclusiveDeviceLock(),
      TEST_SESSION_BINDING,
      lifecycleLock,
    );
    const databaseAdapter = new InMemoryOfflineDatabaseAdapter();
    const database = new OfflineDatabaseController(
      databaseAdapter,
      keys,
      lifecycleLock,
    );
    await database.open();
    const sync = new ApiCanonicalSyncClient(
      new InMemoryPendingOperationStore(),
      {
        uploadOperations: async () => ({
          results: [],
        }),
      },
    );
    const crossContext = new VerifiedCrossContextLogoutBoundary(
      {
        requestKnownContextTeardown: async () => ({
          knownContextIds: [],
          acknowledgements: [],
        }),
      },
      lifecycleLock,
      { sessionBinding: TEST_SESSION_BINDING },
    );

    await expect(
      new LogoutPurgeCoordinator({
        sync,
        database,
        keys,
        crossContext,
        serverSession: {
          revokeServerSession: async () => undefined,
        },
        tokens: {
          deleteAuthTokens: async () => undefined,
          deleteSyncTokens: async () => undefined,
        },
        privateCaches: { purge: async () => undefined },
      }).logout({ kind: 'discard', confirmed: true }),
    ).resolves.toEqual({ status: 'complete', failedSteps: [] });

    expect(databaseAdapter.hasLocalDatabase).toBe(false);
    await expect(keyStorage.loadWrappedDatabaseKey()).resolves.toBeNull();
    await expect(keyStorage.loadWrappingKey()).resolves.toBeNull();
    await expect(database.open()).rejects.toThrow(/sealed/i);
    await expect(keys.getOrCreateDatabaseKey()).rejects.toThrow(/purged/i);
  });

  it('refuses production composition without an acknowledged peer memory-clear boundary', async () => {
    await expect(
      createBrowserOfflineRuntimeComposition({
        sessionBinding: TEST_SESSION_BINDING,
        schema: {} as never,
        replicationClientId: TEST_REPLICATION_CLIENT_ID,
        replicationMode: 'online',
        canonicalSyncApi: {
          uploadOperations: async () => ({
            results: [],
          }),
        },
        serverSession: { revokeServerSession: async () => undefined },
        tokens: {
          deleteAuthTokens: async () => undefined,
          deleteSyncTokens: async () => undefined,
        },
        privateCaches: { purge: async () => undefined },
      } as never),
    ).rejects.toThrow(/peer teardown.*callback|required/i);
  });

  it('composes one browser lifecycle authority across PowerSync, keys, peers, and logout', async () => {
    const calls: string[] = [];
    const contextId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f301';
    const presenceStore = new InMemoryBrowserContextPresenceStore();
    const connection: EncryptedSqliteConnection = {
      encryption: 'required' as const,
      storage: 'safari-opfs' as const,
      close: async () => {
        calls.push('powersync-close');
      },
      execute: async () => undefined,
      query: async <Row>() => [] as Row[],
      transaction: async <Value>(
        operation: (active: typeof connection) => Promise<Value>,
      ) => operation(connection),
    };
    const lockManager = {
      request: async <Value>(
        _name: string,
        _options: unknown,
        operation: () => Promise<Value>,
      ) => operation(),
    };
    const composition = await createBrowserOfflineRuntimeComposition({
      sessionBinding: TEST_SESSION_BINDING,
      schema: {} as never,
      replicationClientId: TEST_REPLICATION_CLIENT_ID,
      replicationMode: 'online' as const,
      canonicalSyncApi: {
        uploadOperations: async () => ({
          results: [],
        }),
      },
      serverSession: {
        revokeServerSession: async () => {
          calls.push('server-session');
        },
      },
      tokens: {
        deleteAuthTokens: async () => {
          calls.push('auth-tokens');
        },
        deleteSyncTokens: async () => {
          calls.push('sync-tokens');
        },
      },
      privateCaches: {
        purge: async () => {
          calls.push('private-caches');
        },
      },
      onPeerTeardown: async () => undefined,
      deviceKeyStorage: new InMemoryDeviceKeyStorage(),
      lockManager: lockManager as never,
      powerSyncRuntime: {
        openEncryptedDatabase: async () => {
          const activeContexts = await presenceStore.list();
          expect(activeContexts.map((context) => context.contextId)).toContain(
            contextId,
          );
          return connection;
        },
        connectEncryptedDatabase: async () => {
          calls.push('powersync-connect');
          return BACKGROUND_CONNECTION_ATTEMPT;
        },
        deleteEncryptedDatabase: async () => {
          calls.push('opfs-delete');
        },
      },
      presenceStore,
      channelFactory: () => ({
        postMessage: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        close: () => undefined,
      }),
      contextId,
    });

    expect(composition.database.getEncryptedSqliteConnection()).toBe(
      connection,
    );
    expect(composition.replication).toEqual({
      mode: 'online',
      state: 'background-started',
      liveReplicationVerified: false,
    });
    await expect(
      composition.logoutBoundary.logout({
        kind: 'discard',
        confirmed: true,
      }),
    ).resolves.toEqual({ status: 'complete', failedSteps: [] });
    expect(calls).toEqual([
      'powersync-connect',
      'powersync-close',
      'server-session',
      'opfs-delete',
      'auth-tokens',
      'sync-tokens',
      'private-caches',
    ]);
    await composition.dispose();
  });

  it('closes startup state and permits a clean retry when queue schema initialization fails', async () => {
    const storage = new InMemoryDeviceKeyStorage();
    const presenceStore = new InMemoryBrowserContextPresenceStore();
    let openAttempts = 0;
    let closeCount = 0;
    const powerSyncRuntime = {
      openEncryptedDatabase: async (): Promise<EncryptedSqliteConnection> => {
        openAttempts += 1;
        const attempt = openAttempts;
        const connection: EncryptedSqliteConnection = {
          encryption: 'required',
          storage: 'safari-opfs',
          close: async () => {
            closeCount += 1;
          },
          execute: async (statement) => {
            if (attempt === 1 && statement.includes('CREATE TABLE')) {
              throw new Error('queue schema unavailable');
            }
          },
          query: async <Row>() => [] as Row[],
          transaction: async <Value>(
            operation: (active: EncryptedSqliteConnection) => Promise<Value>,
          ) => operation(connection),
        };
        return connection;
      },
      connectEncryptedDatabase: async () => BACKGROUND_CONNECTION_ATTEMPT,
      deleteEncryptedDatabase: async () => undefined,
    };
    const lockManager = {
      request: async <Value>(
        _name: string,
        _options: unknown,
        operation: () => Promise<Value>,
      ) => operation(),
    };
    const options = {
      sessionBinding: TEST_SESSION_BINDING,
      schema: {} as never,
      replicationClientId: TEST_REPLICATION_CLIENT_ID,
      replicationMode: 'online' as const,
      canonicalSyncApi: {
        uploadOperations: async () => ({
          results: [],
        }),
      },
      serverSession: { revokeServerSession: async () => undefined },
      tokens: {
        deleteAuthTokens: async () => undefined,
        deleteSyncTokens: async () => undefined,
      },
      privateCaches: { purge: async () => undefined },
      onPeerTeardown: async () => undefined,
      deviceKeyStorage: storage,
      lockManager: lockManager as never,
      powerSyncRuntime,
      presenceStore,
      channelFactory: () => ({
        postMessage: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        close: () => undefined,
      }),
      contextId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f304',
    };

    await expect(
      createBrowserOfflineRuntimeComposition(options),
    ).rejects.toThrow(/queue schema unavailable/i);
    expect(closeCount).toBe(1);
    await expect(presenceStore.list()).resolves.toEqual([]);

    const recovered = await createBrowserOfflineRuntimeComposition(options);
    expect(openAttempts).toBe(2);
    await recovered.dispose();
    expect(closeCount).toBe(2);
  });

  it('closes the encrypted runtime and presence record when PowerSync connect fails', async () => {
    const presenceStore = new InMemoryBrowserContextPresenceStore();
    let connectAttempts = 0;
    let closeCount = 0;
    const connection: EncryptedSqliteConnection = {
      encryption: 'required',
      storage: 'safari-opfs',
      close: async () => {
        closeCount += 1;
      },
      execute: async () => undefined,
      query: async <Row>() => [] as Row[],
      transaction: async <Value>(
        operation: (active: EncryptedSqliteConnection) => Promise<Value>,
      ) => operation(connection),
    };
    const options = {
      sessionBinding: TEST_SESSION_BINDING,
      schema: {} as never,
      replicationClientId: TEST_REPLICATION_CLIENT_ID,
      replicationMode: 'online' as const,
      canonicalSyncApi: {
        uploadOperations: async () => ({
          results: [],
        }),
      },
      serverSession: { revokeServerSession: async () => undefined },
      tokens: {
        deleteAuthTokens: async () => undefined,
        deleteSyncTokens: async () => undefined,
      },
      privateCaches: { purge: async () => undefined },
      onPeerTeardown: async () => undefined,
      deviceKeyStorage: new InMemoryDeviceKeyStorage(),
      lockManager: {
        request: async <Value>(
          _name: string,
          _options: unknown,
          operation: () => Promise<Value>,
        ) => operation(),
      } as never,
      powerSyncRuntime: {
        openEncryptedDatabase: async () => connection,
        connectEncryptedDatabase: async () => {
          connectAttempts += 1;
          if (connectAttempts === 1) {
            throw new Error('PowerSync connection bootstrap failed');
          }
          return BACKGROUND_CONNECTION_ATTEMPT;
        },
        deleteEncryptedDatabase: async () => undefined,
      },
      presenceStore,
      channelFactory: () => ({
        postMessage: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        close: () => undefined,
      }),
      contextId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f398',
    };

    await expect(
      createBrowserOfflineRuntimeComposition(options),
    ).rejects.toThrow(/connection bootstrap failed/i);
    expect(closeCount).toBe(1);
    await expect(presenceStore.list()).resolves.toEqual([]);

    const recovered = await createBrowserOfflineRuntimeComposition(options);
    expect(connectAttempts).toBe(2);
    await recovered.dispose();
    expect(closeCount).toBe(2);
  });

  it('acknowledges peer teardown only after encrypted close and decrypted-memory clearing', async () => {
    const calls: string[] = [];
    const presenceStore = new InMemoryBrowserContextPresenceStore();
    let messageListener: ((event: MessageEvent<unknown>) => void) | undefined;
    let resolveAcknowledgement!: (message: unknown) => void;
    const acknowledgement = new Promise<unknown>((resolve) => {
      resolveAcknowledgement = resolve;
    });
    const connection: EncryptedSqliteConnection = {
      encryption: 'required',
      storage: 'safari-opfs',
      close: async () => {
        calls.push('database-close');
      },
      execute: async () => undefined,
      query: async <Row>() => [] as Row[],
      transaction: async <Value>(
        operation: (active: EncryptedSqliteConnection) => Promise<Value>,
      ) => operation(connection),
    };
    const composition = await createBrowserOfflineRuntimeComposition({
      sessionBinding: TEST_SESSION_BINDING,
      schema: {} as never,
      replicationClientId: TEST_REPLICATION_CLIENT_ID,
      replicationMode: 'online',
      canonicalSyncApi: {
        uploadOperations: async () => ({
          results: [],
        }),
      },
      serverSession: { revokeServerSession: async () => undefined },
      tokens: {
        deleteAuthTokens: async () => undefined,
        deleteSyncTokens: async () => undefined,
      },
      privateCaches: { purge: async () => undefined },
      onPeerTeardown: async () => {
        calls.push('memory-clear');
      },
      deviceKeyStorage: new InMemoryDeviceKeyStorage(),
      lockManager: {
        request: async <Value>(
          _name: string,
          _options: unknown,
          operation: () => Promise<Value>,
        ) => operation(),
      } as never,
      powerSyncRuntime: {
        openEncryptedDatabase: async () => connection,
        connectEncryptedDatabase: async () => BACKGROUND_CONNECTION_ATTEMPT,
        deleteEncryptedDatabase: async () => undefined,
      },
      presenceStore,
      channelFactory: () => ({
        postMessage: (message) => {
          if (
            typeof message === 'object' &&
            message !== null &&
            'kind' in message &&
            message.kind === 'teardown-acknowledgement'
          ) {
            resolveAcknowledgement(message);
          }
        },
        addEventListener: (_type, listener) => {
          messageListener = listener;
        },
        removeEventListener: () => undefined,
        close: () => undefined,
      }),
      contextId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f305',
    });
    const request = {
      version: 1 as const,
      requestId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f306',
      sessionBinding: TEST_SESSION_BINDING,
      decision: 'discard' as const,
      deadlineAt: Date.now() + 2_000,
    };
    const senderContextId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f307';
    await presenceStore.upsert({
      version: 1,
      contextId: senderContextId,
      sessionBinding: TEST_SESSION_BINDING,
      lastSeenAt: Date.now(),
    });

    messageListener?.({
      data: {
        version: 1,
        kind: 'teardown-request',
        senderContextId,
        request,
      },
    } as MessageEvent<unknown>);

    await expect(acknowledgement).resolves.toMatchObject({
      kind: 'teardown-acknowledgement',
      acknowledgement: {
        requestId: request.requestId,
        state: 'sealed-and-closed',
      },
    });
    expect(calls).toEqual(['database-close', 'memory-clear']);
    await composition.dispose();
  });

  it('fails closed when peer teardown arrives during encrypted database startup', async () => {
    const presenceStore = new InMemoryBrowserContextPresenceStore();
    const senderContextId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f308';
    const localContextId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f309';
    await presenceStore.upsert({
      version: 1,
      contextId: senderContextId,
      sessionBinding: TEST_SESSION_BINDING,
      lastSeenAt: Date.now(),
    });
    let messageListener: ((event: MessageEvent<unknown>) => void) | undefined;
    let closeCount = 0;
    let memoryClearCount = 0;
    let resolveAcknowledgement!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      resolveAcknowledgement = resolve;
    });
    let resolvePeerSealStarted!: () => void;
    const peerSealStarted = new Promise<void>((resolve) => {
      resolvePeerSealStarted = resolve;
    });
    class SignallingDeviceKeyStorage extends InMemoryDeviceKeyStorage {
      override async markSessionLogoutPending(
        sessionBinding: string,
        keyGeneration: string,
        signal: AbortSignal,
      ): Promise<boolean> {
        const marked = await super.markSessionLogoutPending(
          sessionBinding,
          keyGeneration,
          signal,
        );
        if (marked) {
          resolvePeerSealStarted();
        }
        return marked;
      }
    }
    const request = {
      version: 1 as const,
      requestId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f310',
      sessionBinding: TEST_SESSION_BINDING,
      decision: 'discard' as const,
      deadlineAt: Date.now() + 2_000,
    };
    const connection: EncryptedSqliteConnection = {
      encryption: 'required',
      storage: 'safari-opfs',
      close: async () => {
        closeCount += 1;
      },
      execute: async () => undefined,
      query: async <Row>() => [] as Row[],
      transaction: async <Value>(
        operation: (active: EncryptedSqliteConnection) => Promise<Value>,
      ) => operation(connection),
    };

    const creating = createBrowserOfflineRuntimeComposition({
      sessionBinding: TEST_SESSION_BINDING,
      schema: {} as never,
      replicationClientId: TEST_REPLICATION_CLIENT_ID,
      replicationMode: 'offline',
      canonicalSyncApi: {
        uploadOperations: async () => ({
          results: [],
        }),
      },
      serverSession: { revokeServerSession: async () => undefined },
      tokens: {
        deleteAuthTokens: async () => undefined,
        deleteSyncTokens: async () => undefined,
      },
      privateCaches: { purge: async () => undefined },
      onPeerTeardown: async () => {
        memoryClearCount += 1;
      },
      deviceKeyStorage: new SignallingDeviceKeyStorage(),
      lockManager: {
        request: async <Value>(
          _name: string,
          _options: unknown,
          operation: () => Promise<Value>,
        ) => operation(),
      } as never,
      powerSyncRuntime: {
        openEncryptedDatabase: async () => {
          messageListener?.({
            data: {
              version: 1,
              kind: 'teardown-request',
              senderContextId,
              request,
            },
          } as MessageEvent<unknown>);
          await peerSealStarted;
          return connection;
        },
        connectEncryptedDatabase: async () => BACKGROUND_CONNECTION_ATTEMPT,
        deleteEncryptedDatabase: async () => undefined,
      },
      presenceStore,
      channelFactory: () => ({
        postMessage: (message) => {
          if (
            typeof message === 'object' &&
            message !== null &&
            'kind' in message &&
            message.kind === 'teardown-acknowledgement'
          ) {
            resolveAcknowledgement();
          }
        },
        addEventListener: (_type, listener) => {
          messageListener = listener;
        },
        removeEventListener: () => undefined,
        close: () => undefined,
      }),
      contextId: localContextId,
    });

    await expect(creating).rejects.toThrow(/sealed|aborted|peer logout/i);
    await expect(acknowledgement).resolves.toBeUndefined();
    expect(closeCount).toBe(1);
    expect(memoryClearCount).toBe(1);
    await expect(presenceStore.list()).resolves.not.toContainEqual(
      expect.objectContaining({ contextId: localContextId }),
    );
  });

  it('reopens a logout-pending database through a recovery-only sealed boundary', async () => {
    const storage = new InMemoryDeviceKeyStorage();
    const initialKeys = new DeviceDatabaseKeyManager(
      storage,
      crypto,
      new InMemoryExclusiveDeviceLock(),
      TEST_SESSION_BINDING,
    );
    (await initialKeys.getOrCreateDatabaseKey()).fill(0);
    await expect(initialKeys.sealForLogout()).resolves.toMatchObject({
      complete: true,
    });
    const calls: string[] = [];
    const connection: EncryptedSqliteConnection = {
      encryption: 'required',
      storage: 'safari-opfs',
      close: async () => {
        calls.push('close');
      },
      execute: async () => undefined,
      query: async <Row>() => [] as Row[],
      transaction: async <Value>(
        operation: (active: EncryptedSqliteConnection) => Promise<Value>,
      ) => operation(connection),
    };
    const recovery = await createBrowserOfflineLogoutRecoveryComposition({
      sessionBinding: TEST_SESSION_BINDING,
      schema: {} as never,
      replicationClientId: TEST_REPLICATION_CLIENT_ID,
      replicationMode: 'online',
      canonicalSyncApi: {
        uploadOperations: async () => ({
          results: [],
        }),
      },
      serverSession: {
        revokeServerSession: async () => {
          calls.push('server-session');
        },
      },
      tokens: {
        deleteAuthTokens: async () => undefined,
        deleteSyncTokens: async () => undefined,
      },
      privateCaches: { purge: async () => undefined },
      onPeerTeardown: async () => undefined,
      deviceKeyStorage: storage,
      lockManager: {
        request: async <Value>(
          _name: string,
          _options: unknown,
          operation: () => Promise<Value>,
        ) => operation(),
      } as never,
      powerSyncRuntime: {
        openEncryptedDatabase: async () => connection,
        connectEncryptedDatabase: async () => BACKGROUND_CONNECTION_ATTEMPT,
        deleteEncryptedDatabase: async () => {
          calls.push('delete');
        },
      },
      presenceStore: new (
        await import('./database.js')
      ).InMemoryBrowserContextPresenceStore(),
      channelFactory: () => ({
        postMessage: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        close: () => undefined,
      }),
      contextId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f302',
    });

    expect(recovery.canEditOffline).toBe(false);
    expect('sync' in recovery).toBe(false);
    await expect(recovery.hasPendingOperations()).resolves.toBe(false);
    await expect(
      recovery.logoutBoundary.logout({ kind: 'discard', confirmed: true }),
    ).resolves.toEqual({ status: 'complete', failedSteps: [] });
    expect(calls).toEqual(['close', 'server-session', 'delete']);
    await recovery.dispose();
  });

  it('disposes the production composition without purging active key material', async () => {
    const calls: string[] = [];
    const storage = new InMemoryDeviceKeyStorage();
    const connection: EncryptedSqliteConnection = {
      encryption: 'required',
      storage: 'safari-opfs',
      close: async () => {
        calls.push('close');
      },
      execute: async () => undefined,
      query: async <Row>() => [] as Row[],
      transaction: async <Value>(
        operation: (active: EncryptedSqliteConnection) => Promise<Value>,
      ) => operation(connection),
    };
    const composition = await createBrowserOfflineRuntimeComposition({
      sessionBinding: TEST_SESSION_BINDING,
      schema: {} as never,
      replicationClientId: TEST_REPLICATION_CLIENT_ID,
      replicationMode: 'online',
      canonicalSyncApi: {
        uploadOperations: async () => ({
          results: [],
        }),
      },
      serverSession: { revokeServerSession: async () => undefined },
      tokens: {
        deleteAuthTokens: async () => undefined,
        deleteSyncTokens: async () => undefined,
      },
      privateCaches: { purge: async () => undefined },
      onPeerTeardown: async () => undefined,
      deviceKeyStorage: storage,
      lockManager: {
        request: async <Value>(
          _name: string,
          _options: unknown,
          operation: () => Promise<Value>,
        ) => operation(),
      } as never,
      powerSyncRuntime: {
        openEncryptedDatabase: async () => connection,
        connectEncryptedDatabase: async () => BACKGROUND_CONNECTION_ATTEMPT,
        deleteEncryptedDatabase: async () => {
          calls.push('delete');
        },
      },
      presenceStore: new (
        await import('./database.js')
      ).InMemoryBrowserContextPresenceStore(),
      channelFactory: () => ({
        postMessage: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        close: () => undefined,
      }),
      contextId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f303',
    });

    await expect(
      Promise.all([composition.dispose(), composition.dispose()]),
    ).resolves.toEqual([undefined, undefined]);
    expect(calls).toEqual(['close']);
    await expect(storage.loadSessionState()).resolves.toMatchObject({
      status: 'active',
      sessionBinding: TEST_SESSION_BINDING,
    });
    await expect(storage.loadWrappingKey()).resolves.not.toBeNull();
    await expect(storage.loadWrappedDatabaseKey()).resolves.not.toBeNull();
  });
});

describe('VerifiedCrossContextLogoutBoundary', () => {
  const contextA = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f101';

  it.each([
    {
      name: 'missing acknowledgement',
      response: () => ({ knownContextIds: [contextA], acknowledgements: [] }),
    },
    {
      name: 'stale nonce',
      response: () => ({
        knownContextIds: [contextA],
        acknowledgements: [
          {
            version: 1 as const,
            requestId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f999',
            sessionBinding: TEST_SESSION_BINDING,
            decision: 'discard' as const,
            deadlineAt: 1,
            contextId: contextA,
            state: 'sealed-and-closed' as const,
          },
        ],
      }),
    },
    {
      name: 'wrong session',
      response: (request: {
        requestId: string;
        decision: 'discard' | 'sync-now';
        deadlineAt: number;
      }) => ({
        knownContextIds: [contextA],
        acknowledgements: [
          {
            version: 1 as const,
            requestId: request.requestId,
            sessionBinding: 'b'.repeat(64),
            decision: request.decision,
            deadlineAt: request.deadlineAt,
            contextId: contextA,
            state: 'sealed-and-closed' as const,
          },
        ],
      }),
    },
    {
      name: 'duplicate acknowledgement',
      response: (request: {
        requestId: string;
        decision: 'discard' | 'sync-now';
        deadlineAt: number;
      }) => {
        const acknowledgement = {
          version: 1 as const,
          requestId: request.requestId,
          sessionBinding: TEST_SESSION_BINDING,
          decision: request.decision,
          deadlineAt: request.deadlineAt,
          contextId: contextA,
          state: 'sealed-and-closed' as const,
        };
        return {
          knownContextIds: [contextA],
          acknowledgements: [acknowledgement, acknowledgement],
        };
      },
    },
  ])('rejects a $name', async ({ response }) => {
    const boundary = new VerifiedCrossContextLogoutBoundary(
      {
        requestKnownContextTeardown: async (request) => response(request),
      },
      new InMemoryOfflineDatabaseLifecycleLock(),
      { sessionBinding: TEST_SESSION_BINDING },
    );

    await expect(boundary.prepare('discard')).rejects.toThrow(
      /context|acknowledge|teardown/i,
    );
  });

  it('times out an unresponsive known-context transport', async () => {
    const boundary = new VerifiedCrossContextLogoutBoundary(
      {
        requestKnownContextTeardown: async () => new Promise(() => undefined),
      },
      new InMemoryOfflineDatabaseLifecycleLock(),
      { sessionBinding: TEST_SESSION_BINDING, timeoutMs: 5 },
    );

    await expect(boundary.prepare('discard')).rejects.toThrow(/acknowledge/i);
  });

  it('queues an exclusive purge behind live tabs and blocks a newly opening tab', async () => {
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const liveTabLease = await lifecycleLock.acquireSharedOpenLease();
    const boundary = new VerifiedCrossContextLogoutBoundary(
      {
        requestKnownContextTeardown: async () => ({
          knownContextIds: [],
          acknowledgements: [],
        }),
      },
      lifecycleLock,
      { sessionBinding: TEST_SESSION_BINDING, timeoutMs: 100 },
    );
    const prepared = await boundary.prepare('discard');
    let purgeEntered = false;
    let signalPurgeEntered = (): void => undefined;
    const purgeEntry = new Promise<void>((resolve) => {
      signalPurgeEntered = resolve;
    });
    let finishPurge = (): void => undefined;
    const purgeGate = new Promise<void>((resolve) => {
      finishPurge = resolve;
    });
    const purging = prepared.run(async () => {
      purgeEntered = true;
      signalPurgeEntered();
      await purgeGate;
      return 'purged';
    });
    let newTabAcquired = false;
    const newTab = lifecycleLock.acquireSharedOpenLease().then((lease) => {
      newTabAcquired = true;
      return lease;
    });
    await Promise.resolve();
    expect(purgeEntered).toBe(false);
    expect(newTabAcquired).toBe(false);

    await liveTabLease.release();
    await purgeEntry;
    expect(purgeEntered).toBe(true);
    expect(newTabAcquired).toBe(false);
    finishPurge();
    await expect(purging).resolves.toBe('purged');
    const newTabLease = await newTab;
    expect(newTabAcquired).toBe(true);
    await newTabLease.release();
  });

  it('aborts a queued purge on timeout and never executes it after a frozen tab releases', async () => {
    vi.useFakeTimers();
    try {
      const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
      const frozenTabLease = await lifecycleLock.acquireSharedOpenLease();
      const boundary = new VerifiedCrossContextLogoutBoundary(
        {
          requestKnownContextTeardown: async () => ({
            knownContextIds: [],
            acknowledgements: [],
          }),
        },
        lifecycleLock,
        { sessionBinding: TEST_SESSION_BINDING, timeoutMs: 100 },
      );
      const prepared = await boundary.prepare('discard');
      let purgeCalls = 0;
      const purging = prepared.run(async () => {
        purgeCalls += 1;
      });
      const purgeExpiry = expect(purging).rejects.toBeInstanceOf(
        CrossContextPurgeBarrierExpiredError,
      );

      await vi.advanceTimersByTimeAsync(101);
      await purgeExpiry;
      await frozenTabLease.release();
      await Promise.resolve();
      expect(purgeCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a typed barrier expiry when the deadline crosses during exclusive-lock handoff', async () => {
    let clockReads = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      clockReads += 1;
      if (clockReads === 1) return 0;
      if (clockReads < 4) return 50;
      return 100;
    });
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const boundary = new VerifiedCrossContextLogoutBoundary(
      {
        requestKnownContextTeardown: async () => ({
          knownContextIds: [],
          acknowledgements: [],
        }),
      },
      lifecycleLock,
      { sessionBinding: TEST_SESSION_BINDING, timeoutMs: 100 },
    );
    const prepared = await boundary.prepare('discard');
    let purgeCalls = 0;

    await expect(
      prepared.run(async () => {
        purgeCalls += 1;
      }),
    ).rejects.toBeInstanceOf(CrossContextPurgeBarrierExpiredError);
    expect(purgeCalls).toBe(0);
  });
});

describe('service-worker cache boundary', () => {
  const responseFrom = (
    url: string,
    body: BodyInit,
    init: ResponseInit,
  ): Response => {
    const response = new Response(body, init);
    Object.defineProperty(response, 'url', { configurable: true, value: url });
    return response;
  };
  const publicRequest = (
    url: string,
    init: Omit<RequestInit, 'credentials'> = {},
  ): Request => new Request(url, { ...init, credentials: 'omit' });

  it('allows only public app-shell assets and rejects user data and raw audio', () => {
    expect(() => assertServiceWorkerCacheable('app-shell')).not.toThrow();
    expect(() => assertServiceWorkerCacheable('public-static')).not.toThrow();
    expect(() => assertServiceWorkerCacheable('user-data')).toThrow(
      /must not/i,
    );
    expect(() => assertServiceWorkerCacheable('raw-audio')).toThrow(
      /must not/i,
    );
    expect(() => assertServiceWorkerCacheable('auth-token')).toThrow(
      /must not/i,
    );
    expect(() => assertServiceWorkerCacheable('sync-token')).toThrow(
      /must not/i,
    );
  });

  it('does not overstate what local encryption protects', () => {
    expect(OFFLINE_STORAGE_SECURITY_NOTICE).toMatch(
      /unlocked browser profile/i,
    );
    expect(OFFLINE_STORAGE_SECURITY_NOTICE).toMatch(/successful XSS/i);
  });

  it('infers static-only cache safety and cannot store API or audio responses', async () => {
    const puts: string[] = [];
    const cacheStorage = {
      open: async () => ({
        put: async (request: Request) => {
          puts.push(request.url);
        },
      }),
    } as unknown as CacheStorage;
    const cache = new BrowserStaticAssetCache(
      cacheStorage,
      'https://emdo.example',
    );

    await cache.put(
      new Request('https://emdo.example/assets/app.123.js', {
        credentials: 'omit',
      }),
      responseFrom('https://emdo.example/assets/app.123.js', 'app', {
        status: 200,
        headers: { 'content-type': 'text/javascript' },
      }),
    );
    await expect(
      cache.put(
        publicRequest('https://emdo.example/api/v1/voice/speak'),
        new Response('audio', {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
      ),
    ).rejects.toThrow(/static|audio|API/i);
    await expect(
      cache.put(
        publicRequest('https://emdo.example/assets/private.js'),
        responseFrom(
          'https://emdo.example/assets/private.js',
          'private app data',
          {
            status: 200,
            headers: {
              'cache-control': 'no-store',
              'content-type': 'text/javascript',
            },
          },
        ),
      ),
    ).rejects.toThrow(/no-store|cache/i);
    await expect(
      cache.put(
        publicRequest('https://emdo.example/assets/personalized.js'),
        responseFrom(
          'https://emdo.example/assets/personalized.js',
          'private app data',
          {
            status: 200,
            headers: {
              'cache-control': 'max-age=60, private="set-cookie"',
              'content-type': 'text/javascript',
            },
          },
        ),
      ),
    ).rejects.toThrow(/cache/i);

    expect(puts).toEqual(['https://emdo.example/assets/app.123.js']);
  });

  it('rejects credential-bearing cache keys and redirected dynamic responses', async () => {
    const cache = new BrowserStaticAssetCache(
      {
        open: async () => ({ put: async () => undefined }),
      } as unknown as CacheStorage,
      'https://emdo.example',
    );
    const staticResponse = () =>
      responseFrom('https://emdo.example/assets/app.js', 'app', {
        status: 200,
        headers: { 'content-type': 'text/javascript' },
      });

    await expect(
      cache.put(
        new Request('https://emdo.example/assets/app.js'),
        staticResponse(),
      ),
    ).rejects.toThrow(/credential|cache/i);

    await expect(
      cache.put(
        publicRequest('https://emdo.example/assets/app.js?access_token=secret'),
        staticResponse(),
      ),
    ).rejects.toThrow(/static|cache|query/i);
    await expect(
      cache.put(
        publicRequest('https://emdo.example/assets/app.js', {
          headers: { authorization: 'Bearer secret' },
        }),
        staticResponse(),
      ),
    ).rejects.toThrow(/credential|cache/i);

    const redirected = staticResponse();
    Object.defineProperty(redirected, 'redirected', { value: true });
    Object.defineProperty(redirected, 'url', {
      value: 'https://emdo.example/api/v1/private-app.js',
    });
    await expect(
      cache.put(
        publicRequest('https://emdo.example/assets/app.js'),
        redirected,
      ),
    ).rejects.toThrow(/redirect|cache/i);
    await expect(
      cache.put(
        publicRequest('https://emdo.example/assets/app.js'),
        new Response('synthetic private data', {
          status: 200,
          headers: { 'content-type': 'text/javascript' },
        }),
      ),
    ).rejects.toThrow(/response|cache/i);
  });

  it('rejects custom credential variants, range requests, and partial responses', async () => {
    const cache = new BrowserStaticAssetCache(
      {
        open: async () => ({ put: async () => undefined }),
      } as unknown as CacheStorage,
      'https://emdo.example',
    );
    const url = 'https://emdo.example/assets/app.js';

    await expect(
      cache.put(
        publicRequest(url, { headers: { 'x-api-key': 'secret' } }),
        responseFrom(url, 'personalized app', {
          status: 200,
          headers: {
            'content-type': 'text/javascript',
            vary: 'X-API-Key',
          },
        }),
      ),
    ).rejects.toThrow(/header|cache|static/i);
    await expect(
      cache.put(
        publicRequest(url, { headers: { range: 'bytes=0-9' } }),
        responseFrom(url, 'partial app', {
          status: 206,
          headers: { 'content-type': 'text/javascript' },
        }),
      ),
    ).rejects.toThrow(/header|cache|static/i);
    await expect(
      cache.put(
        publicRequest(url),
        responseFrom(url, 'partial app', {
          status: 206,
          headers: { 'content-type': 'text/javascript' },
        }),
      ),
    ).rejects.toThrow(/response|cache/i);
  });
});

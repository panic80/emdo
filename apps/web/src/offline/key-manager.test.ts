import { describe, expect, it } from 'vitest';

import {
  InMemoryOfflineDatabaseLifecycleLock,
  VerifiedCrossContextLogoutBoundary,
  type OfflinePurgePermit,
} from './database.js';
import {
  DeviceDatabaseKeyManager,
  InMemoryDeviceKeyStorage,
  InMemoryExclusiveDeviceLock,
  IndexedDbDeviceKeyStorage,
  type ExclusiveDeviceLock,
} from './key-manager.js';

const TEST_SESSION_BINDING = 'a'.repeat(64);
const TEST_LIFECYCLE_LOCK_NAME = 'emdo:offline-database-lifecycle:test';
const managerLifecycleLocks = new WeakMap<
  DeviceDatabaseKeyManager,
  InMemoryOfflineDatabaseLifecycleLock
>();
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

const createTestManager = (
  storage: InMemoryDeviceKeyStorage,
  lock: ExclusiveDeviceLock = new InMemoryExclusiveDeviceLock(),
  sessionBinding = TEST_SESSION_BINDING,
  lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock(
    TEST_LIFECYCLE_LOCK_NAME,
  ),
): DeviceDatabaseKeyManager => {
  const manager = new DeviceDatabaseKeyManager(
    storage,
    crypto,
    lock,
    sessionBinding,
    lifecycleLock,
  );
  managerLifecycleLocks.set(manager, lifecycleLock);
  return manager;
};

const purgeManager = async (manager: DeviceDatabaseKeyManager) => {
  const lifecycleLock = managerLifecycleLocks.get(manager);
  if (lifecycleLock === undefined) {
    throw new Error('Test manager has no lifecycle lock');
  }
  return runTestPurge(lifecycleLock, (permit, signal) =>
    manager.purge(permit, signal),
  );
};

describe('DeviceDatabaseKeyManager', () => {
  it('creates one random 256-bit database key per device and reuses it', async () => {
    const firstDeviceStorage = new InMemoryDeviceKeyStorage();
    const secondDeviceStorage = new InMemoryDeviceKeyStorage();
    const firstDevice = createTestManager(firstDeviceStorage);
    const secondDevice = createTestManager(secondDeviceStorage);

    const first = await firstDevice.getOrCreateDatabaseKey();
    const reopened = await firstDevice.getOrCreateDatabaseKey();
    const second = await secondDevice.getOrCreateDatabaseKey();

    expect(first).toHaveLength(32);
    expect(reopened).toEqual(first);
    expect(second).toHaveLength(32);
    expect(second).not.toEqual(first);
  });

  it('persists only a wrapped key under a non-extractable WebCrypto key', async () => {
    const storage = new InMemoryDeviceKeyStorage();
    const manager = createTestManager(storage);

    const databaseKey = await manager.getOrCreateDatabaseKey();
    const wrappingKey = await storage.loadWrappingKey();
    const wrapped = await storage.loadWrappedDatabaseKey();

    expect(wrappingKey).not.toBeNull();
    expect(wrappingKey?.extractable).toBe(false);
    expect(wrappingKey?.algorithm.name).toBe('AES-GCM');
    expect(wrappingKey?.usages).toEqual(['encrypt', 'decrypt']);
    expect(wrapped).toMatchObject({
      version: 1,
      algorithm: 'AES-GCM',
    });
    expect(JSON.stringify(wrapped)).not.toContain(
      Array.from(databaseKey).join(','),
    );
  });

  it('fails closed when wrapped key material has lost its device wrapping key', async () => {
    const storage = new InMemoryDeviceKeyStorage();
    const manager = createTestManager(storage);
    await manager.getOrCreateDatabaseKey();
    await storage.deleteWrappingKey();

    await expect(manager.getOrCreateDatabaseKey()).rejects.toThrow(
      /incomplete/i,
    );
  });

  it('rejects an extractable wrapping key loaded from storage', async () => {
    const storage = new InMemoryDeviceKeyStorage();
    const extractableKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    await storage.saveWrappingKey(extractableKey);

    await expect(
      createTestManager(storage).getOrCreateDatabaseKey(),
    ).rejects.toThrow(/non-extractable/i);
  });

  it('fails closed when only one half of a stored key pair exists', async () => {
    const storage = new InMemoryDeviceKeyStorage();
    const wrappingKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    await storage.saveWrappingKey(wrappingKey);

    await expect(
      createTestManager(storage).getOrCreateDatabaseKey(),
    ).rejects.toThrow(/incomplete|asymmetric/i);
  });

  it('cannot recreate device secrets after it has been purged for logout', async () => {
    const storage = new InMemoryDeviceKeyStorage();
    const manager = createTestManager(storage);
    await manager.getOrCreateDatabaseKey();

    await expect(purgeManager(manager)).resolves.toEqual({
      complete: true,
      failedSteps: [],
    });
    await expect(manager.getOrCreateDatabaseKey()).rejects.toThrow(/purged/i);
    await expect(storage.loadWrappingKey()).resolves.toBeNull();
    await expect(storage.loadWrappedDatabaseKey()).resolves.toBeNull();
  });

  it('serializes first initialization across manager instances', async () => {
    const storage = new InMemoryDeviceKeyStorage();
    const lock = new InMemoryExclusiveDeviceLock();
    const firstManager = createTestManager(storage, lock);
    const secondManager = createTestManager(storage, lock);

    const [first, second] = await Promise.all([
      firstManager.getOrCreateDatabaseKey(),
      secondManager.getOrCreateDatabaseKey(),
    ]);

    expect(first).toEqual(second);
    expect(lock.acquisitionCount).toBe(2);
  });

  it('keeps later waiters behind an active holder when an intermediate waiter aborts', async () => {
    const lock = new InMemoryExclusiveDeviceLock();
    let releaseFirst = (): void => undefined;
    let markFirstStarted = (): void => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = lock.runExclusive('emdo:test:three-waiter-lock', async () => {
      markFirstStarted();
      await firstGate;
    });
    await firstStarted;

    const secondAbort = new AbortController();
    const second = lock.runExclusive(
      'emdo:test:three-waiter-lock',
      async () => undefined,
      secondAbort.signal,
    );
    secondAbort.abort();
    await expect(second).rejects.toThrow(/aborted/i);

    let thirdEntered = false;
    const third = lock.runExclusive('emdo:test:three-waiter-lock', async () => {
      thirdEntered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(thirdEntered).toBe(false);

    releaseFirst();
    await first;
    await third;
    expect(thirdEntered).toBe(true);
  });

  it('exposes a native IndexedDB storage adapter and fails clearly when unavailable', async () => {
    const storage = new IndexedDbDeviceKeyStorage({
      indexedDb: null,
      databaseName: 'emdo-device-secrets-test',
    });

    await expect(storage.loadWrappingKey()).rejects.toThrow(
      /IndexedDB is required/i,
    );
  });

  it('deduplicates concurrent key purge attempts', async () => {
    let wrappedDeletes = 0;
    let wrappingDeletes = 0;
    class CountingStorage extends InMemoryDeviceKeyStorage {
      override async deleteKeyPairForLogout(
        sessionBinding: string,
        keyGeneration: string,
        signal: AbortSignal,
      ): Promise<boolean> {
        wrappedDeletes += 1;
        wrappingDeletes += 1;
        return super.deleteKeyPairForLogout(
          sessionBinding,
          keyGeneration,
          signal,
        );
      }
    }
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const manager = createTestManager(
      new CountingStorage(),
      undefined,
      undefined,
      lifecycleLock,
    );
    await manager.getOrCreateDatabaseKey();

    await runTestPurge(lifecycleLock, (permit, signal) =>
      Promise.all([
        manager.purge(permit, signal),
        manager.purge(permit, signal),
      ]),
    );

    expect(wrappedDeletes).toBe(1);
    expect(wrappingDeletes).toBe(1);
  });

  it('persists a logout tombstone across manager instances and requires a new session', async () => {
    const storage = new InMemoryDeviceKeyStorage();
    const lock = new InMemoryExclusiveDeviceLock();
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock(
      TEST_LIFECYCLE_LOCK_NAME,
    );
    const firstBinding = 'a'.repeat(64);
    const nextBinding = 'b'.repeat(64);
    const first = createTestManager(storage, lock, firstBinding, lifecycleLock);
    const staleTab = new DeviceDatabaseKeyManager(
      storage,
      crypto,
      lock,
      firstBinding,
      lifecycleLock,
    );
    await first.getOrCreateDatabaseKey();
    await purgeManager(first);

    await expect(staleTab.getOrCreateDatabaseKey()).rejects.toThrow(/logout/i);
    await expect(
      new DeviceDatabaseKeyManager(
        storage,
        crypto,
        lock,
        nextBinding,
        lifecycleLock,
      ).getOrCreateDatabaseKey(),
    ).resolves.toHaveLength(32);
  });

  it('does not let a stale session purge a replacement session key pair', async () => {
    const storage = new InMemoryDeviceKeyStorage();
    const deviceLock = new InMemoryExclusiveDeviceLock();
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const firstSession = createTestManager(
      storage,
      deviceLock,
      'a'.repeat(64),
      lifecycleLock,
    );
    const staleFirstSession = createTestManager(
      storage,
      deviceLock,
      'a'.repeat(64),
      lifecycleLock,
    );
    await firstSession.getOrCreateDatabaseKey();
    await purgeManager(firstSession);
    const replacementSession = createTestManager(
      storage,
      deviceLock,
      'b'.repeat(64),
      lifecycleLock,
    );
    const replacementKey = await replacementSession.getOrCreateDatabaseKey();

    await expect(purgeManager(firstSession)).resolves.toEqual({
      complete: true,
      failedSteps: [],
    });
    await expect(purgeManager(staleFirstSession)).resolves.toEqual({
      complete: false,
      failedSteps: ['session-tombstone'],
    });
    await expect(replacementSession.getOrCreateDatabaseKey()).resolves.toEqual(
      replacementKey,
    );
    await expect(storage.loadWrappedDatabaseKey()).resolves.not.toBeNull();
    await expect(storage.loadWrappingKey()).resolves.not.toBeNull();
  });

  it('allows only an explicit same-session logout recovery to reopen pending data', async () => {
    const storage = new InMemoryDeviceKeyStorage();
    const deviceLock = new InMemoryExclusiveDeviceLock();
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const manager = createTestManager(
      storage,
      deviceLock,
      TEST_SESSION_BINDING,
      lifecycleLock,
    );
    const databaseKey = await manager.getOrCreateDatabaseKey();
    await manager.sealForLogout();
    const recoveryManager = createTestManager(
      storage,
      deviceLock,
      TEST_SESSION_BINDING,
      lifecycleLock,
    );

    await expect(recoveryManager.getOrCreateDatabaseKey()).rejects.toThrow(
      /logout|logged out/i,
    );
    await expect(
      recoveryManager.getExistingDatabaseKeyForLogoutRecovery(),
    ).resolves.toEqual(databaseKey);
  });

  it('requires explicit authenticated-session and cross-context lock injection outside a wired browser', async () => {
    const manager = new DeviceDatabaseKeyManager(
      new InMemoryDeviceKeyStorage(),
    );

    await expect(manager.getOrCreateDatabaseKey()).rejects.toThrow(
      /session binding/i,
    );
  });

  it('fails closed without an injected cross-context lock even with a session binding', async () => {
    const manager = new DeviceDatabaseKeyManager(
      new InMemoryDeviceKeyStorage(),
      crypto,
      undefined,
      TEST_SESSION_BINDING,
    );

    await expect(manager.getOrCreateDatabaseKey()).rejects.toThrow(
      /Web Locks/i,
    );
  });

  it('does not delete key material when the durable logout tombstone fails', async () => {
    let wrappedDeletes = 0;
    let wrappingDeletes = 0;
    class FailingTombstoneStorage extends InMemoryDeviceKeyStorage {
      override async markSessionLogoutPending(): Promise<boolean> {
        throw new Error('tombstone unavailable');
      }

      override async deleteKeyPairForLogout(): Promise<boolean> {
        wrappedDeletes += 1;
        wrappingDeletes += 1;
        return true;
      }
    }
    const storage = new FailingTombstoneStorage();
    const manager = createTestManager(storage);
    await manager.getOrCreateDatabaseKey();

    await expect(purgeManager(manager)).resolves.toEqual({
      complete: false,
      failedSteps: ['session-tombstone'],
    });
    expect(wrappedDeletes).toBe(0);
    expect(wrappingDeletes).toBe(0);
    await expect(storage.loadWrappedDatabaseKey()).resolves.not.toBeNull();
    await expect(storage.loadWrappingKey()).resolves.not.toBeNull();
  });

  it('reports a failed destructive key lock without releasing a rejected purge operation', async () => {
    const storage = new InMemoryDeviceKeyStorage();
    const underlyingLock = new InMemoryExclusiveDeviceLock();
    let acquisitions = 0;
    const failingDeleteLock = {
      runExclusive: async <Value>(
        name: string,
        operation: () => Promise<Value>,
      ): Promise<Value> => {
        acquisitions += 1;
        if (acquisitions === 3) {
          throw new Error('destructive key lock unavailable');
        }
        return underlyingLock.runExclusive(name, operation);
      },
    };
    const manager = createTestManager(storage, failingDeleteLock);
    await manager.getOrCreateDatabaseKey();

    await expect(purgeManager(manager)).resolves.toEqual({
      complete: false,
      failedSteps: ['wrapped-database-key', 'device-wrapping-key'],
    });
    await expect(storage.loadWrappedDatabaseKey()).resolves.not.toBeNull();
    await expect(storage.loadWrappingKey()).resolves.not.toBeNull();
  });

  it('rejects a purge permit issued by a different same-named lifecycle lock', async () => {
    const storage = new InMemoryDeviceKeyStorage();
    const managerLock = new InMemoryOfflineDatabaseLifecycleLock(
      TEST_LIFECYCLE_LOCK_NAME,
    );
    const manager = createTestManager(
      storage,
      undefined,
      undefined,
      managerLock,
    );
    await manager.getOrCreateDatabaseKey();
    await manager.sealForLogout();
    const wrongLock = new InMemoryOfflineDatabaseLifecycleLock(
      TEST_LIFECYCLE_LOCK_NAME,
    );

    await runTestPurge(wrongLock, async (permit, signal) => {
      await expect(manager.purge(permit, signal)).rejects.toThrow(/permit/i);
    });
    await expect(storage.loadWrappedDatabaseKey()).resolves.not.toBeNull();
    await expect(storage.loadWrappingKey()).resolves.not.toBeNull();
  });

  it('rejects an otherwise valid purge permit for a different authenticated session', async () => {
    const storage = new InMemoryDeviceKeyStorage();
    const lifecycleLock = new InMemoryOfflineDatabaseLifecycleLock();
    const manager = createTestManager(
      storage,
      undefined,
      TEST_SESSION_BINDING,
      lifecycleLock,
    );
    await manager.getOrCreateDatabaseKey();
    await manager.sealForLogout();
    await runTestPurge(
      lifecycleLock,
      async (permit, signal) => {
        await expect(manager.purge(permit, signal)).rejects.toThrow(
          /another session/i,
        );
      },
      'b'.repeat(64),
    );

    await expect(storage.loadWrappedDatabaseKey()).resolves.not.toBeNull();
    await expect(storage.loadWrappingKey()).resolves.not.toBeNull();
  });

  it('wipes the internal resolved plaintext after all concurrent callers receive copies', async () => {
    const storage = new InMemoryDeviceKeyStorage();
    let internalPlaintext: Uint8Array<ArrayBuffer> | null = null;
    const lock = {
      runExclusive: async <Value>(
        _name: string,
        operation: () => Promise<Value>,
      ): Promise<Value> => {
        const value = await operation();
        internalPlaintext = value as Uint8Array<ArrayBuffer>;
        return value;
      },
    };
    const manager = new DeviceDatabaseKeyManager(
      storage,
      crypto,
      lock,
      TEST_SESSION_BINDING,
      new InMemoryOfflineDatabaseLifecycleLock(TEST_LIFECYCLE_LOCK_NAME),
    );

    const [first, second] = await Promise.all([
      manager.getOrCreateDatabaseKey(),
      manager.getOrCreateDatabaseKey(),
    ]);

    expect(first).toEqual(second);
    expect(first.some((byte) => byte !== 0)).toBe(true);
    expect(internalPlaintext).not.toBeNull();
    expect(
      (internalPlaintext as unknown as Uint8Array).every((byte) => byte === 0),
    ).toBe(true);
  });
});

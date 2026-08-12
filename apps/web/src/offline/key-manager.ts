import {
  assertActiveOfflinePurgePermit,
  registerOfflinePurgeOperation,
  type OfflineDatabaseLifecycleLock,
  type OfflinePurgePermit,
} from './database.js';

const DATABASE_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const WRAP_ADDITIONAL_DATA = new TextEncoder().encode(
  'emdo:offline-database-key:v1',
);

export interface WrappedDatabaseKey {
  readonly version: 1;
  readonly algorithm: 'AES-GCM';
  readonly initializationVector: string;
  readonly ciphertext: string;
}

export interface DeviceKeySessionState {
  readonly version: 1;
  readonly status: 'active' | 'logout-pending';
  readonly sessionBinding: string;
  readonly keyGeneration: string;
}

export interface DeviceKeyStorage {
  loadWrappingKey(): Promise<CryptoKey | null>;
  saveWrappingKey(key: CryptoKey): Promise<void>;
  loadWrappedDatabaseKey(): Promise<WrappedDatabaseKey | null>;
  saveWrappedDatabaseKey(key: WrappedDatabaseKey): Promise<void>;
  loadSessionState(): Promise<DeviceKeySessionState | null>;
  saveNewKeyPair(
    sessionBinding: string,
    keyGeneration: string,
    wrappingKey: CryptoKey,
    wrappedDatabaseKey: WrappedDatabaseKey,
  ): Promise<void>;
  markSessionLogoutPending(
    sessionBinding: string,
    keyGeneration: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  deleteKeyPairForLogout(
    sessionBinding: string,
    keyGeneration: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  deleteWrappingKey(): Promise<void>;
  deleteWrappedDatabaseKey(): Promise<void>;
}

export interface ExclusiveDeviceLock {
  runExclusive<Value>(
    name: string,
    operation: () => Promise<Value>,
    signal?: AbortSignal,
  ): Promise<Value>;
}

interface BrowserLockManager {
  request<Value>(
    name: string,
    options: { readonly mode: 'exclusive'; readonly signal?: AbortSignal },
    operation: () => Promise<Value>,
  ): Promise<Value>;
}

export interface KeyPurgeResult {
  readonly complete: boolean;
  readonly failedSteps: readonly (
    'session-tombstone' | 'wrapped-database-key' | 'device-wrapping-key'
  )[];
}

export interface KeySealResult {
  readonly complete: boolean;
  readonly failedSteps: readonly 'session-tombstone'[];
}

const cloneWrappedKey = (key: WrappedDatabaseKey): WrappedDatabaseKey => ({
  ...key,
});

export class InMemoryDeviceKeyStorage implements DeviceKeyStorage {
  private wrappingKey: CryptoKey | null = null;
  private wrappedDatabaseKey: WrappedDatabaseKey | null = null;
  private sessionState: DeviceKeySessionState | null = null;

  async loadWrappingKey(): Promise<CryptoKey | null> {
    return this.wrappingKey;
  }

  async saveWrappingKey(key: CryptoKey): Promise<void> {
    this.wrappingKey = key;
  }

  async loadWrappedDatabaseKey(): Promise<WrappedDatabaseKey | null> {
    return this.wrappedDatabaseKey === null
      ? null
      : cloneWrappedKey(this.wrappedDatabaseKey);
  }

  async saveWrappedDatabaseKey(key: WrappedDatabaseKey): Promise<void> {
    this.wrappedDatabaseKey = cloneWrappedKey(key);
  }

  async loadSessionState(): Promise<DeviceKeySessionState | null> {
    return this.sessionState === null ? null : { ...this.sessionState };
  }

  async saveNewKeyPair(
    sessionBinding: string,
    keyGeneration: string,
    wrappingKey: CryptoKey,
    wrappedDatabaseKey: WrappedDatabaseKey,
  ): Promise<void> {
    assertSessionBinding(sessionBinding);
    assertKeyGeneration(keyGeneration);
    assertSecureWrappingKey(wrappingKey);
    this.wrappingKey = wrappingKey;
    this.wrappedDatabaseKey = cloneWrappedKey(wrappedDatabaseKey);
    this.sessionState = {
      version: 1,
      status: 'active',
      sessionBinding,
      keyGeneration,
    };
  }

  async markSessionLogoutPending(
    sessionBinding: string,
    keyGeneration: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    assertSessionBinding(sessionBinding);
    assertKeyGeneration(keyGeneration);
    throwIfDeviceOperationAborted(signal);
    const current = this.sessionState;
    if (
      current === null ||
      current.sessionBinding !== sessionBinding ||
      current.keyGeneration !== keyGeneration ||
      (current.status !== 'active' && current.status !== 'logout-pending')
    ) {
      return false;
    }
    this.sessionState = {
      version: 1,
      status: 'logout-pending',
      sessionBinding,
      keyGeneration,
    };
    return true;
  }

  async deleteKeyPairForLogout(
    sessionBinding: string,
    keyGeneration: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    assertSessionBinding(sessionBinding);
    assertKeyGeneration(keyGeneration);
    if (signal.aborted) {
      throw new Error('Device key-pair deletion was aborted');
    }
    const current = this.sessionState;
    if (
      current === null ||
      current.status !== 'logout-pending' ||
      current.sessionBinding !== sessionBinding ||
      current.keyGeneration !== keyGeneration
    ) {
      return false;
    }
    this.wrappedDatabaseKey = null;
    this.wrappingKey = null;
    return true;
  }

  async deleteWrappingKey(): Promise<void> {
    this.wrappingKey = null;
  }

  async deleteWrappedDatabaseKey(): Promise<void> {
    this.wrappedDatabaseKey = null;
  }
}

export class InMemoryExclusiveDeviceLock implements ExclusiveDeviceLock {
  private readonly tails = new Map<string, Promise<void>>();
  private acquisitions = 0;

  get acquisitionCount(): number {
    return this.acquisitions;
  }

  async runExclusive<Value>(
    name: string,
    operation: () => Promise<Value>,
    signal?: AbortSignal,
  ): Promise<Value> {
    this.acquisitions += 1;
    const previous = this.tails.get(name) ?? Promise.resolve();
    let release = (): void => undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => turn);
    this.tails.set(name, tail);
    void tail.then(() => {
      if (this.tails.get(name) === tail) {
        this.tails.delete(name);
      }
    });

    try {
      await waitForDeviceLockTurn(
        previous.catch(() => undefined),
        signal,
      );
    } catch (error) {
      release();
      throw error;
    }
    try {
      if (signal !== undefined) {
        throwIfDeviceOperationAborted(signal);
      }
      return await operation();
    } finally {
      release();
    }
  }
}

export class NavigatorExclusiveDeviceLock implements ExclusiveDeviceLock {
  constructor(private readonly lockManager: BrowserLockManager) {}

  runExclusive<Value>(
    name: string,
    operation: () => Promise<Value>,
    signal?: AbortSignal,
  ): Promise<Value> {
    return this.lockManager.request(
      name,
      signal === undefined
        ? { mode: 'exclusive' }
        : { mode: 'exclusive', signal },
      operation,
    );
  }
}

const waitForDeviceLockTurn = async (
  turn: Promise<void>,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal === undefined) {
    await turn;
    return;
  }
  throwIfDeviceOperationAborted(signal);
  let abort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Device key operation was aborted'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    await Promise.race([turn, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
};

const throwIfDeviceOperationAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new Error('Device key operation was aborted');
  }
};

export interface IndexedDbDeviceKeyStorageOptions {
  readonly indexedDb?: IDBFactory | null;
  readonly databaseName?: string;
}

const INDEXED_DB_STORE = 'device-secrets';
const WRAPPING_KEY_RECORD = 'wrapping-key';
const WRAPPED_DATABASE_KEY_RECORD = 'wrapped-database-key';
const SESSION_STATE_RECORD = 'session-state';

export class IndexedDbDeviceKeyStorage implements DeviceKeyStorage {
  private readonly indexedDb: IDBFactory | null;
  private readonly databaseName: string;
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(options: IndexedDbDeviceKeyStorageOptions = {}) {
    this.indexedDb =
      'indexedDb' in options
        ? (options.indexedDb ?? null)
        : (globalThis.indexedDB ?? null);
    this.databaseName = options.databaseName ?? 'emdo-device-secrets';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(this.databaseName)) {
      throw new Error('Invalid device-key database name');
    }
  }

  async loadWrappingKey(): Promise<CryptoKey | null> {
    const value = await this.readRecord(WRAPPING_KEY_RECORD);
    return value === undefined ? null : (value as CryptoKey);
  }

  async saveWrappingKey(key: CryptoKey): Promise<void> {
    assertSecureWrappingKey(key);
    await this.writeRecord(WRAPPING_KEY_RECORD, key);
  }

  async loadWrappedDatabaseKey(): Promise<WrappedDatabaseKey | null> {
    const value = await this.readRecord(WRAPPED_DATABASE_KEY_RECORD);
    if (value === undefined) {
      return null;
    }
    if (value === null || typeof value !== 'object') {
      throw new Error('Invalid wrapped database key record');
    }
    const record = value as Partial<WrappedDatabaseKey>;
    if (
      record.version !== 1 ||
      record.algorithm !== 'AES-GCM' ||
      typeof record.initializationVector !== 'string' ||
      typeof record.ciphertext !== 'string'
    ) {
      throw new Error('Invalid wrapped database key record');
    }
    return Object.freeze({
      version: 1,
      algorithm: 'AES-GCM',
      initializationVector: record.initializationVector,
      ciphertext: record.ciphertext,
    });
  }

  async saveWrappedDatabaseKey(key: WrappedDatabaseKey): Promise<void> {
    await this.writeRecord(WRAPPED_DATABASE_KEY_RECORD, cloneWrappedKey(key));
  }

  async loadSessionState(): Promise<DeviceKeySessionState | null> {
    return parseDeviceKeySessionState(
      await this.readRecord(SESSION_STATE_RECORD),
    );
  }

  async saveNewKeyPair(
    sessionBinding: string,
    keyGeneration: string,
    wrappingKey: CryptoKey,
    wrappedDatabaseKey: WrappedDatabaseKey,
  ): Promise<void> {
    assertSessionBinding(sessionBinding);
    assertKeyGeneration(keyGeneration);
    assertSecureWrappingKey(wrappingKey);
    const database = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(INDEXED_DB_STORE, 'readwrite');
      const store = transaction.objectStore(INDEXED_DB_STORE);
      store.put(wrappingKey, WRAPPING_KEY_RECORD);
      store.put(
        cloneWrappedKey(wrappedDatabaseKey),
        WRAPPED_DATABASE_KEY_RECORD,
      );
      store.put(
        {
          version: 1,
          status: 'active',
          sessionBinding,
          keyGeneration,
        } satisfies DeviceKeySessionState,
        SESSION_STATE_RECORD,
      );
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(new Error('Unable to atomically store the device key pair'));
      transaction.onabort = () =>
        reject(new Error('Atomic device key-pair storage was aborted'));
    });
  }

  async markSessionLogoutPending(
    sessionBinding: string,
    keyGeneration: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    assertSessionBinding(sessionBinding);
    assertKeyGeneration(keyGeneration);
    return this.compareAndUpdateSessionState(
      sessionBinding,
      keyGeneration,
      false,
      signal,
    );
  }

  async deleteKeyPairForLogout(
    sessionBinding: string,
    keyGeneration: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    assertSessionBinding(sessionBinding);
    assertKeyGeneration(keyGeneration);
    return this.compareAndUpdateSessionState(
      sessionBinding,
      keyGeneration,
      true,
      signal,
    );
  }

  async deleteWrappingKey(): Promise<void> {
    await this.deleteRecord(WRAPPING_KEY_RECORD);
  }

  async deleteWrappedDatabaseKey(): Promise<void> {
    await this.deleteRecord(WRAPPED_DATABASE_KEY_RECORD);
  }

  private async openDatabase(): Promise<IDBDatabase> {
    if (this.indexedDb === null) {
      throw new Error('IndexedDB is required for device key storage');
    }
    if (this.databasePromise !== null) {
      return this.databasePromise;
    }

    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.indexedDb?.open(this.databaseName, 1);
      if (request === undefined) {
        reject(new Error('IndexedDB is required for device key storage'));
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(INDEXED_DB_STORE)) {
          database.createObjectStore(INDEXED_DB_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error('Unable to open IndexedDB device key storage'));
      request.onblocked = () =>
        reject(new Error('IndexedDB device key storage is blocked'));
    });
    this.databasePromise = pending;
    try {
      return await pending;
    } catch (error) {
      if (this.databasePromise === pending) {
        this.databasePromise = null;
      }
      throw error;
    }
  }

  private async readRecord(key: string): Promise<unknown> {
    const database = await this.openDatabase();
    return new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(INDEXED_DB_STORE, 'readonly');
      const request = transaction.objectStore(INDEXED_DB_STORE).get(key);
      let value: unknown;
      request.onsuccess = () => {
        value = request.result;
      };
      request.onerror = () =>
        reject(new Error('Unable to read IndexedDB device key storage'));
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () =>
        reject(new Error('Unable to read IndexedDB device key storage'));
      transaction.onabort = () =>
        reject(new Error('IndexedDB device key read was aborted'));
    });
  }

  private async writeRecord(key: string, value: unknown): Promise<void> {
    const database = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(INDEXED_DB_STORE, 'readwrite');
      transaction.objectStore(INDEXED_DB_STORE).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(new Error('Unable to write IndexedDB device key storage'));
      transaction.onabort = () =>
        reject(new Error('IndexedDB device key write was aborted'));
    });
  }

  private async deleteRecord(key: string): Promise<void> {
    const database = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(INDEXED_DB_STORE, 'readwrite');
      transaction.objectStore(INDEXED_DB_STORE).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(new Error('Unable to delete IndexedDB device key storage'));
      transaction.onabort = () =>
        reject(new Error('IndexedDB device key deletion was aborted'));
    });
  }

  private async compareAndUpdateSessionState(
    sessionBinding: string,
    keyGeneration: string,
    deleteKeyPair: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) {
      throw new Error('Device key session update was aborted');
    }
    const database = await this.openDatabase();
    return new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(INDEXED_DB_STORE, 'readwrite');
      const store = transaction.objectStore(INDEXED_DB_STORE);
      const request = store.get(SESSION_STATE_RECORD);
      let matched = false;
      const abort = (): void => transaction.abort();
      signal?.addEventListener('abort', abort, { once: true });
      request.onsuccess = () => {
        try {
          const state = parseDeviceKeySessionState(request.result);
          matched =
            state !== null &&
            state.sessionBinding === sessionBinding &&
            state.keyGeneration === keyGeneration &&
            (deleteKeyPair
              ? state.status === 'logout-pending'
              : state.status === 'active' || state.status === 'logout-pending');
          if (!matched) {
            return;
          }
          if (deleteKeyPair) {
            store.delete(WRAPPED_DATABASE_KEY_RECORD);
            store.delete(WRAPPING_KEY_RECORD);
          } else {
            store.put(
              {
                version: 1,
                status: 'logout-pending',
                sessionBinding,
                keyGeneration,
              } satisfies DeviceKeySessionState,
              SESSION_STATE_RECORD,
            );
          }
        } catch {
          transaction.abort();
        }
      };
      request.onerror = () =>
        reject(new Error('Unable to compare device key session state'));
      transaction.oncomplete = () => {
        signal?.removeEventListener('abort', abort);
        resolve(matched);
      };
      transaction.onerror = () => {
        signal?.removeEventListener('abort', abort);
        reject(new Error('Unable to update device key session state'));
      };
      transaction.onabort = () => {
        signal?.removeEventListener('abort', abort);
        reject(new Error('Device key session update was aborted'));
      };
    });
  }
}

const parseDeviceKeySessionState = (
  value: unknown,
): DeviceKeySessionState | null => {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value !== 'object') {
    throw new Error('Invalid device key session state');
  }
  const state = value as Partial<DeviceKeySessionState>;
  if (
    state.version !== 1 ||
    (state.status !== 'active' && state.status !== 'logout-pending') ||
    typeof state.sessionBinding !== 'string' ||
    typeof state.keyGeneration !== 'string'
  ) {
    throw new Error('Invalid device key session state');
  }
  assertSessionBinding(state.sessionBinding);
  assertKeyGeneration(state.keyGeneration);
  return Object.freeze({
    version: 1,
    status: state.status,
    sessionBinding: state.sessionBinding,
    keyGeneration: state.keyGeneration,
  });
};

const DEVICE_KEY_LOCK_NAME = 'emdo:offline-database-key:v1';

interface PendingDatabaseKeyOperation {
  readonly promise: Promise<Uint8Array<ArrayBuffer>>;
  consumers: number;
}

export class DeviceDatabaseKeyManager {
  private pendingKey: PendingDatabaseKeyOperation | null = null;
  private pendingSeal: Promise<KeySealResult> | null = null;
  private completedSeal: KeySealResult | null = null;
  private pendingPurge: Promise<KeyPurgeResult> | null = null;
  private completedPurge: KeyPurgeResult | null = null;
  private keyGeneration: string | null = null;
  private purged = false;

  constructor(
    private readonly storage: DeviceKeyStorage,
    private readonly webCrypto: Crypto = globalThis.crypto,
    private readonly exclusiveLock: ExclusiveDeviceLock | null = null,
    readonly authenticatedSessionBinding: string | null = null,
    private readonly purgeLifecycleLock: OfflineDatabaseLifecycleLock | null = null,
  ) {
    if (webCrypto === undefined) {
      throw new Error('WebCrypto is required for the offline database');
    }
    if (authenticatedSessionBinding !== null) {
      assertSessionBinding(authenticatedSessionBinding);
    }
  }

  async getOrCreateDatabaseKey(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    throwIfDeviceOperationAborted(signal);
    if (this.purged) {
      throw new Error('The device database key manager has been purged');
    }
    if (this.authenticatedSessionBinding === null) {
      throw new Error(
        'An authenticated session binding is required for device key access',
      );
    }
    const exclusiveLock = this.requireExclusiveLock();
    let active = this.pendingKey;
    if (active === null) {
      active = {
        promise: exclusiveLock.runExclusive(
          DEVICE_KEY_LOCK_NAME,
          async () => {
            throwIfDeviceOperationAborted(signal);
            if (this.purged) {
              throw new Error(
                'The device database key manager has been purged',
              );
            }
            return this.loadOrCreateDatabaseKey(signal);
          },
          signal,
        ),
        consumers: 0,
      };
      this.pendingKey = active;
    }
    active.consumers += 1;
    let resolved: Uint8Array<ArrayBuffer> | null = null;
    try {
      resolved = await active.promise;
      return new Uint8Array(resolved);
    } finally {
      active.consumers -= 1;
      if (active.consumers === 0) {
        if (this.pendingKey === active) {
          this.pendingKey = null;
        }
        resolved?.fill(0);
      }
    }
  }

  async sealForLogout(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<KeySealResult> {
    if (this.completedSeal !== null) {
      return this.completedSeal;
    }
    if (this.pendingSeal !== null) {
      return this.pendingSeal;
    }
    this.purged = true;
    const pending = this.performSealForLogout(signal);
    this.pendingSeal = pending;
    try {
      const result = await pending;
      if (result.complete) {
        this.completedSeal = result;
      }
      return result;
    } finally {
      if (this.pendingSeal === pending) {
        this.pendingSeal = null;
      }
    }
  }

  async purge(
    permit: OfflinePurgePermit,
    signal: AbortSignal,
  ): Promise<KeyPurgeResult> {
    if (this.purgeLifecycleLock === null) {
      throw new Error('An offline database lifecycle lock is required');
    }
    if (
      this.authenticatedSessionBinding === null ||
      permit.sessionBinding !== this.authenticatedSessionBinding
    ) {
      throw new Error('The purge permit belongs to another session');
    }
    assertActiveOfflinePurgePermit(permit, this.purgeLifecycleLock, 'keys');
    if (this.completedPurge !== null) {
      return this.completedPurge;
    }
    if (this.pendingPurge !== null) {
      return this.pendingPurge;
    }
    this.purged = true;
    const pending = registerOfflinePurgeOperation(
      permit,
      this.purgeLifecycleLock,
      'keys',
      () => this.performPurge(signal),
    );
    this.pendingPurge = pending;
    try {
      const result = await pending;
      if (result.complete) {
        this.completedPurge = result;
      }
      return result;
    } finally {
      if (this.pendingPurge === pending) {
        this.pendingPurge = null;
      }
    }
  }

  async getExistingDatabaseKeyForLogoutRecovery(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    throwIfDeviceOperationAborted(signal);
    const sessionBinding = this.authenticatedSessionBinding;
    if (sessionBinding === null) {
      throw new Error(
        'An authenticated session binding is required for logout recovery',
      );
    }
    return this.requireExclusiveLock().runExclusive(
      DEVICE_KEY_LOCK_NAME,
      async () => {
        throwIfDeviceOperationAborted(signal);
        const [wrappingKey, wrappedDatabaseKey, sessionState] =
          await Promise.all([
            this.storage.loadWrappingKey(),
            this.storage.loadWrappedDatabaseKey(),
            this.storage.loadSessionState(),
          ]);
        if (
          wrappingKey === null ||
          wrappedDatabaseKey === null ||
          sessionState === null ||
          sessionState.status !== 'logout-pending' ||
          sessionState.sessionBinding !== sessionBinding
        ) {
          throw new Error(
            'No recoverable same-session logout transaction is available',
          );
        }
        assertSecureWrappingKey(wrappingKey);
        this.keyGeneration = sessionState.keyGeneration;
        const unwrapped = await this.unwrapDatabaseKey(
          wrappingKey,
          wrappedDatabaseKey,
        );
        if (signal.aborted) {
          unwrapped.fill(0);
          throwIfDeviceOperationAborted(signal);
        }
        return unwrapped;
      },
      signal,
    );
  }

  private async performPurge(signal: AbortSignal): Promise<KeyPurgeResult> {
    let sealResult: KeySealResult;
    try {
      sealResult = await this.sealForLogout(signal);
    } catch {
      return Object.freeze({
        complete: false,
        failedSteps: Object.freeze(['session-tombstone'] as const),
      });
    }
    if (!sealResult.complete) {
      return Object.freeze({
        complete: false,
        failedSteps: Object.freeze([...sealResult.failedSteps]),
      });
    }
    const sessionBinding = this.authenticatedSessionBinding;
    const keyGeneration = this.keyGeneration;
    if (sessionBinding === null || keyGeneration === null) {
      return Object.freeze({
        complete: false,
        failedSteps: Object.freeze(['session-tombstone'] as const),
      });
    }
    try {
      return await this.requireExclusiveLock().runExclusive(
        DEVICE_KEY_LOCK_NAME,
        async () => {
          const failedSteps: Array<
            'session-tombstone' | 'wrapped-database-key' | 'device-wrapping-key'
          > = [...sealResult.failedSteps];

          let deleted = false;
          try {
            deleted = await this.storage.deleteKeyPairForLogout(
              sessionBinding,
              keyGeneration,
              signal,
            );
          } catch {
            failedSteps.push('wrapped-database-key');
            failedSteps.push('device-wrapping-key');
          }
          if (!deleted && failedSteps.length === 0) {
            failedSteps.push('wrapped-database-key');
            failedSteps.push('device-wrapping-key');
          }

          return Object.freeze({
            complete: failedSteps.length === 0,
            failedSteps: Object.freeze([...failedSteps]),
          });
        },
        signal,
      );
    } catch {
      return Object.freeze({
        complete: false,
        failedSteps: Object.freeze([
          'wrapped-database-key',
          'device-wrapping-key',
        ] as const),
      });
    }
  }

  private async performSealForLogout(
    signal: AbortSignal,
  ): Promise<KeySealResult> {
    throwIfDeviceOperationAborted(signal);
    const active = this.pendingKey;
    if (active !== null) {
      try {
        await waitForDeviceLockTurn(
          active.promise.then(() => undefined),
          signal,
        );
      } catch {
        throwIfDeviceOperationAborted(signal);
        // Failed key initialization cannot leave a usable plaintext key.
      }
    }

    return this.requireExclusiveLock().runExclusive(
      DEVICE_KEY_LOCK_NAME,
      async () => {
        throwIfDeviceOperationAborted(signal);
        const failedSteps: 'session-tombstone'[] = [];
        if (this.authenticatedSessionBinding === null) {
          failedSteps.push('session-tombstone');
        } else {
          try {
            const state = await this.storage.loadSessionState();
            const keyGeneration = this.keyGeneration ?? state?.keyGeneration;
            const marked =
              state !== null &&
              state.sessionBinding === this.authenticatedSessionBinding &&
              keyGeneration !== undefined &&
              state.keyGeneration === keyGeneration &&
              (await this.storage.markSessionLogoutPending(
                this.authenticatedSessionBinding,
                keyGeneration,
                signal,
              ));
            if (!marked || keyGeneration === undefined) {
              failedSteps.push('session-tombstone');
            } else {
              this.keyGeneration = keyGeneration;
            }
          } catch {
            failedSteps.push('session-tombstone');
          }
        }
        return Object.freeze({
          complete: failedSteps.length === 0,
          failedSteps: Object.freeze([...failedSteps]),
        });
      },
      signal,
    );
  }

  private requireExclusiveLock(): ExclusiveDeviceLock {
    if (this.exclusiveLock === null) {
      throw new Error(
        'An explicit cross-context Web Locks implementation is required for device key access',
      );
    }
    return this.exclusiveLock;
  }

  private async loadOrCreateDatabaseKey(
    signal: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    throwIfDeviceOperationAborted(signal);
    const sessionBinding = this.authenticatedSessionBinding;
    if (sessionBinding === null) {
      throw new Error(
        'An authenticated session binding is required for device key access',
      );
    }
    const [wrappingKey, wrappedDatabaseKey, sessionState] = await Promise.all([
      this.storage.loadWrappingKey(),
      this.storage.loadWrappedDatabaseKey(),
      this.storage.loadSessionState(),
    ]);

    if (wrappingKey !== null) {
      assertSecureWrappingKey(wrappingKey);
    }
    if ((wrappedDatabaseKey === null) !== (wrappingKey === null)) {
      throw new Error('The stored device database key pair is incomplete');
    }
    const hasKeyPair = wrappedDatabaseKey !== null && wrappingKey !== null;

    if (sessionState === null) {
      if (hasKeyPair) {
        throw new Error('The stored device key pair has no session binding');
      }
    } else {
      assertSessionBinding(sessionState.sessionBinding);
      if (sessionState.status === 'active') {
        if (sessionState.sessionBinding !== sessionBinding) {
          throw new Error('The device key belongs to another session');
        }
        if (!hasKeyPair) {
          throw new Error('The active device database key pair is incomplete');
        }
        this.keyGeneration = sessionState.keyGeneration;
        const unwrapped = await this.unwrapDatabaseKey(
          wrappingKey,
          wrappedDatabaseKey,
        );
        if (signal.aborted) {
          unwrapped.fill(0);
          throwIfDeviceOperationAborted(signal);
        }
        return unwrapped;
      }
      if (sessionState.sessionBinding === sessionBinding) {
        throw new Error(
          'The authenticated device session has a logout pending',
        );
      }
      if (hasKeyPair) {
        throw new Error('Logged-out device key material was not fully purged');
      }
    }

    const newWrappingKey = await this.createNonExtractableWrappingKey();
    throwIfDeviceOperationAborted(signal);
    const keyGeneration = createKeyGeneration(this.webCrypto);

    const databaseKey = this.webCrypto.getRandomValues(
      new Uint8Array(DATABASE_KEY_BYTES),
    );
    try {
      const wrapped = await this.wrapDatabaseKey(newWrappingKey, databaseKey);
      throwIfDeviceOperationAborted(signal);
      await this.storage.saveNewKeyPair(
        sessionBinding,
        keyGeneration,
        newWrappingKey,
        wrapped,
      );
      this.keyGeneration = keyGeneration;
      return new Uint8Array(databaseKey);
    } finally {
      databaseKey.fill(0);
    }
  }

  private async createNonExtractableWrappingKey(): Promise<CryptoKey> {
    const key = await this.webCrypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    assertSecureWrappingKey(key);
    return key;
  }

  private async wrapDatabaseKey(
    wrappingKey: CryptoKey,
    databaseKey: Uint8Array<ArrayBuffer>,
  ): Promise<WrappedDatabaseKey> {
    const initializationVector = this.webCrypto.getRandomValues(
      new Uint8Array(AES_GCM_IV_BYTES),
    );
    const encrypted = new Uint8Array(
      await this.webCrypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: initializationVector,
          additionalData: WRAP_ADDITIONAL_DATA,
          tagLength: AES_GCM_TAG_BYTES * 8,
        },
        wrappingKey,
        databaseKey,
      ),
    );

    return Object.freeze({
      version: 1,
      algorithm: 'AES-GCM',
      initializationVector: encodeBase64Url(initializationVector),
      ciphertext: encodeBase64Url(encrypted),
    });
  }

  private async unwrapDatabaseKey(
    wrappingKey: CryptoKey,
    wrapped: WrappedDatabaseKey,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (wrapped.version !== 1 || wrapped.algorithm !== 'AES-GCM') {
      throw new Error('Unsupported wrapped database key format');
    }

    const initializationVector = decodeBase64Url(
      wrapped.initializationVector,
      AES_GCM_IV_BYTES,
      'initialization vector',
    );
    const ciphertext = decodeBase64Url(
      wrapped.ciphertext,
      DATABASE_KEY_BYTES + AES_GCM_TAG_BYTES,
      'wrapped database key',
    );

    const plaintext = new Uint8Array(
      await this.webCrypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: initializationVector,
          additionalData: WRAP_ADDITIONAL_DATA,
          tagLength: AES_GCM_TAG_BYTES * 8,
        },
        wrappingKey,
        ciphertext,
      ),
    );

    if (plaintext.byteLength !== DATABASE_KEY_BYTES) {
      plaintext.fill(0);
      throw new Error('Invalid offline database key length');
    }
    return plaintext;
  }
}

const assertSessionBinding = (sessionBinding: string): void => {
  if (!/^[a-f0-9]{64}$/u.test(sessionBinding)) {
    throw new Error('Expected a SHA-256 authenticated session binding');
  }
};

const assertKeyGeneration = (keyGeneration: string): void => {
  if (!/^[a-f0-9]{64}$/u.test(keyGeneration)) {
    throw new Error('Expected a random 256-bit key generation identifier');
  }
};

const createKeyGeneration = (webCrypto: Crypto): string =>
  [...webCrypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

const assertSecureWrappingKey = (key: CryptoKey): void => {
  const algorithm = key.algorithm as AesKeyAlgorithm;
  const usages = new Set(key.usages);
  if (
    key.type !== 'secret' ||
    key.extractable ||
    algorithm.name !== 'AES-GCM' ||
    algorithm.length !== 256 ||
    usages.size !== 2 ||
    !usages.has('encrypt') ||
    !usages.has('decrypt')
  ) {
    throw new Error(
      'The device wrapping key must be a non-extractable 256-bit AES-GCM key',
    );
  }
};

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
};

const decodeBase64Url = (
  encoded: string,
  expectedLength: number,
  label: string,
): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Error(`Invalid ${label} encoding`);
  }
  const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error(`Invalid ${label} encoding`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    bytes.byteLength !== expectedLength ||
    encodeBase64Url(bytes) !== encoded
  ) {
    throw new Error(`Invalid ${label} length or encoding`);
  }
  return bytes;
};

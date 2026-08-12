import type { Schema } from '@powersync/web';

import {
  BroadcastChannelCrossContextTeardownTransport,
  CrossContextPurgeBarrierExpiredError,
  LocalStorageBrowserContextPresenceStore,
  NavigatorOfflineDatabaseLifecycleLock,
  OfflineDatabaseController,
  PowerSyncBrowserRuntime,
  PowerSyncWebDatabaseAdapter,
  VerifiedCrossContextLogoutBoundary,
  type BrowserContextPresenceStore,
  type CrossContextBroadcastChannel,
  type DatabaseKeyProvider,
  type DatabaseLogoutSealResult,
  type DatabasePurgeResult,
  type CrossContextLogoutBoundary,
  type CrossContextTeardownRequest,
  type OfflineDatabaseLifecycleLock,
  type OfflinePurgePermit,
  type PowerSyncWebRuntimeBoundary,
  type PowerSyncConnectionAttemptResult,
  type PreparedCrossContextPurge,
} from './database.js';
export {
  VerifiedCrossContextLogoutBoundary,
  type CrossContextLogoutBoundary,
  type CrossContextTeardownAcknowledgement,
  type CrossContextTeardownRequest,
  type CrossContextTeardownResponse,
  type CrossContextTeardownTransport,
  type PreparedCrossContextPurge,
  type VerifiedCrossContextLogoutOptions,
} from './database.js';
import {
  DeviceDatabaseKeyManager,
  IndexedDbDeviceKeyStorage,
  NavigatorExclusiveDeviceLock,
  type DeviceKeyStorage,
  type KeyPurgeResult,
  type KeySealResult,
} from './key-manager.js';
import {
  ApiOwnedPowerSyncBackendConnector,
  ApiCanonicalSyncClient,
  EncryptedSqlitePendingOperationStore,
  type CanonicalSyncApi,
  type SyncNowResult,
} from './sync-client.js';

export type LogoutDecision =
  | { readonly kind: 'sync-now' }
  | { readonly kind: 'discard'; readonly confirmed: true };

export interface LogoutSyncBoundary {
  sealForLogout(signal: AbortSignal): Promise<void>;
  resumeAfterFailedLogout(): void;
  hasPendingOperations(signal: AbortSignal): Promise<boolean>;
  syncNowForLogout(signal: AbortSignal): Promise<SyncNowResult>;
}

export interface LogoutDatabaseBoundary {
  sealAndCloseForLogout(signal: AbortSignal): Promise<DatabaseLogoutSealResult>;
  purge(
    permit: OfflinePurgePermit,
    signal: AbortSignal,
  ): Promise<DatabasePurgeResult>;
}

export interface LogoutKeyBoundary {
  sealForLogout(signal: AbortSignal): Promise<KeySealResult>;
  purge(
    permit: OfflinePurgePermit,
    signal: AbortSignal,
  ): Promise<KeyPurgeResult>;
}

export interface LogoutTokenBoundary {
  deleteAuthTokens(signal: AbortSignal): Promise<void>;
  deleteSyncTokens(signal: AbortSignal): Promise<void>;
}

export interface LogoutServerSessionBoundary {
  revokeServerSession(signal: AbortSignal): Promise<void>;
}

export interface PrivateRuntimeCacheBoundary {
  purge(signal: AbortSignal): Promise<void>;
}

/**
 * Structural subset shared by `navigator.locks` consumers. Production
 * composition deliberately passes the exact same authority object to both
 * the database lifecycle and device-key locks.
 */
export interface BrowserOfflineLockManager {
  request<Value>(
    name: string,
    options: {
      readonly mode: 'shared' | 'exclusive';
      readonly signal?: AbortSignal;
    },
    operation: () => Promise<Value>,
  ): Promise<Value>;
}

export interface BrowserOfflineRuntimeCompositionOptions {
  readonly sessionBinding: string;
  readonly schema: Schema;
  readonly replicationClientId: string;
  readonly replicationMode: 'online' | 'offline';
  readonly expectedPowerSyncEndpoint?: string;
  readonly replicationFetch?: typeof fetch;
  readonly canonicalSyncApi: CanonicalSyncApi;
  readonly serverSession: LogoutServerSessionBoundary;
  readonly tokens: LogoutTokenBoundary;
  readonly privateCaches: PrivateRuntimeCacheBoundary;
  /**
   * Clears decrypted application/auth memory in this browser context. A peer
   * teardown is not acknowledged until this callback resolves.
   */
  readonly onPeerTeardown: (signal: AbortSignal) => Promise<void>;
  readonly deviceKeyStorage?: DeviceKeyStorage;
  readonly lockManager?: BrowserOfflineLockManager;
  readonly powerSyncRuntime?: PowerSyncWebRuntimeBoundary;
  readonly presenceStore?: BrowserContextPresenceStore;
  readonly channelFactory?: (name: string) => CrossContextBroadcastChannel;
  readonly contextId?: string;
  readonly databaseName?: string;
  readonly teardownTimeoutMs?: number;
  readonly webCrypto?: Crypto;
}

export type LogoutBoundaryAdapter = Pick<LogoutPurgeCoordinator, 'logout'>;

export interface BrowserOfflineRuntimeComposition {
  readonly lifecycleLock: OfflineDatabaseLifecycleLock;
  readonly keys: DeviceDatabaseKeyManager;
  readonly database: OfflineDatabaseController;
  readonly sync: ApiCanonicalSyncClient;
  readonly crossContext: VerifiedCrossContextLogoutBoundary;
  readonly logoutBoundary: LogoutBoundaryAdapter;
  readonly replication:
    | {
        readonly mode: 'offline';
        readonly state: 'disabled';
        readonly liveReplicationVerified: false;
      }
    | ({ readonly mode: 'online' } & PowerSyncConnectionAttemptResult);
  dispose(): Promise<void>;
}

export interface BrowserOfflineLogoutRecoveryComposition {
  readonly canEditOffline: false;
  readonly logoutBoundary: LogoutBoundaryAdapter;
  hasPendingOperations(signal?: AbortSignal): Promise<boolean>;
  dispose(): Promise<void>;
}

export type BrowserOfflineSessionHint =
  | {
      readonly version: 1;
      readonly status: 'active';
      readonly canEditOffline: true;
      /** Opaque hash only. It is not identity or authorization data. */
      readonly sessionBinding: string;
    }
  | {
      readonly version: 1;
      readonly status: 'logout-pending';
      readonly canEditOffline: false;
      /** Opaque hash only. It is not identity or authorization data. */
      readonly sessionBinding: string;
    };

/**
 * Reads only the opaque device-key binding needed to reopen the same encrypted
 * local database while the network session endpoint is unavailable. Callers
 * must never treat this value as identity or authorization data.
 */
export const inspectBrowserOfflineSession = async (
  storage: DeviceKeyStorage = new IndexedDbDeviceKeyStorage(),
): Promise<BrowserOfflineSessionHint | null> => {
  const state = await storage.loadSessionState();
  if (state === null) {
    return null;
  }
  if (
    state.version !== 1 ||
    (state.status !== 'active' && state.status !== 'logout-pending') ||
    !/^[a-f0-9]{64}$/u.test(state.sessionBinding)
  ) {
    throw new Error('Invalid offline session binding state');
  }
  const [wrappingKey, wrappedDatabaseKey] = await Promise.all([
    storage.loadWrappingKey(),
    storage.loadWrappedDatabaseKey(),
  ]);
  if (wrappingKey === null || wrappedDatabaseKey === null) {
    throw new Error('Offline session key material is incomplete');
  }
  if (
    wrappingKey.extractable ||
    wrappingKey.algorithm.name !== 'AES-GCM' ||
    wrappingKey.usages.length !== 2 ||
    !wrappingKey.usages.includes('encrypt') ||
    !wrappingKey.usages.includes('decrypt') ||
    wrappedDatabaseKey.version !== 1 ||
    wrappedDatabaseKey.algorithm !== 'AES-GCM'
  ) {
    throw new Error('Offline session key material is invalid');
  }
  return state.status === 'active'
    ? Object.freeze({
        version: 1 as const,
        status: 'active' as const,
        canEditOffline: true as const,
        sessionBinding: state.sessionBinding,
      })
    : Object.freeze({
        version: 1 as const,
        status: 'logout-pending' as const,
        canEditOffline: false as const,
        sessionBinding: state.sessionBinding,
      });
};

const raceWithAbort = async <Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
  message: string,
): Promise<Value> => {
  if (signal.aborted) {
    throw new Error(message);
  }
  let abort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error(message));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
};

export interface LogoutPurgeDependencies {
  sync: LogoutSyncBoundary;
  database: LogoutDatabaseBoundary;
  keys: LogoutKeyBoundary;
  crossContext: CrossContextLogoutBoundary;
  serverSession: LogoutServerSessionBoundary;
  tokens: LogoutTokenBoundary;
  privateCaches: PrivateRuntimeCacheBoundary;
}

export type LogoutPurgeFailure =
  | 'canonical-sync'
  | 'local-edit-boundary'
  | 'cross-context-teardown'
  | 'database'
  | 'database.close-connection'
  | 'database.shared-lifecycle-lock'
  | 'database.sqlite-opfs'
  | 'keys'
  | 'keys.session-tombstone'
  | 'keys.wrapped-database-key'
  | 'keys.device-wrapping-key'
  | 'server-session'
  | 'auth-tokens'
  | 'sync-tokens'
  | 'private-caches';

export interface LogoutPurgeResult {
  readonly status:
    | 'decision-required'
    | 'logout-blocked'
    | 'sync-failed'
    | 'complete'
    | 'incomplete';
  readonly failedSteps: readonly LogoutPurgeFailure[];
}

export interface LogoutPurgeCoordinatorOptions {
  readonly preflightTimeoutMs?: number;
}

export type ServiceWorkerCacheDataClass =
  | 'app-shell'
  | 'public-static'
  | 'user-data'
  | 'raw-audio'
  | 'auth-token'
  | 'sync-token';

export const OFFLINE_STORAGE_SECURITY_NOTICE =
  'Local encryption does not protect data from an unlocked browser profile or successful XSS.';

export const assertServiceWorkerCacheable = (
  dataClass: ServiceWorkerCacheDataClass,
): void => {
  if (dataClass !== 'app-shell' && dataClass !== 'public-static') {
    throw new Error(
      'User data, raw audio, and credentials must not enter service-worker or Cache Storage APIs',
    );
  }
};

const STATIC_ASSET_PATH =
  /^\/assets\/[A-Za-z0-9._/-]+\.(?:css|ico|js|png|svg|webp|woff2)$/u;

/**
 * Cache Storage enforcement point for the later Workbox service worker. It
 * infers safety from the request/response and has no caller-controlled data
 * classification escape hatch.
 */
export class BrowserStaticAssetCache {
  private readonly applicationOrigin: string;

  constructor(
    private readonly cacheStorage: CacheStorage,
    applicationOrigin: string,
    private readonly cacheName = 'emdo-static-v1',
  ) {
    this.applicationOrigin = new URL(applicationOrigin).origin;
    if (!/^emdo-static-[A-Za-z0-9._-]+$/u.test(cacheName)) {
      throw new Error('Invalid EMDO static cache name');
    }
  }

  async put(request: Request, response: Response): Promise<void> {
    const url = new URL(request.url);
    const cacheControl = response.headers.get('cache-control') ?? '';
    const contentType = response.headers.get('content-type') ?? '';
    if (
      request.method !== 'GET' ||
      url.origin !== this.applicationOrigin ||
      url.search !== '' ||
      url.hash !== '' ||
      request.credentials !== 'omit' ||
      hasCredentialHeader(request.headers) ||
      hasUnsafeStaticRequestHeader(request.headers) ||
      url.pathname.startsWith('/api/') ||
      !isPublicStaticPath(url.pathname)
    ) {
      throw new Error('Only same-origin public static assets may be cached');
    }
    if (
      response.status !== 200 ||
      response.type === 'opaque' ||
      response.redirected ||
      !hasMatchingResponseUrl(response.url, url) ||
      hasPrivateCacheDirective(cacheControl) ||
      hasUnsafeStaticVary(response.headers.get('vary') ?? '') ||
      /^audio\//iu.test(contentType) ||
      response.headers.has('set-cookie')
    ) {
      throw new Error('This response must not enter Cache Storage');
    }

    const cache = await this.cacheStorage.open(this.cacheName);
    const publicCacheKey = new Request(`${url.origin}${url.pathname}`, {
      method: 'GET',
      mode: 'same-origin',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    await cache.put(publicCacheKey, response.clone());
  }
}

const isPublicStaticPath = (pathname: string): boolean =>
  pathname === '/' ||
  pathname === '/index.html' ||
  pathname === '/manifest.webmanifest' ||
  pathname === '/favicon.ico' ||
  STATIC_ASSET_PATH.test(pathname);

const hasPrivateCacheDirective = (cacheControl: string): boolean =>
  cacheControl
    .split(',')
    .some((directive) =>
      /^\s*(?:no-store|private)(?:\s*=|\s*$)/iu.test(directive),
    );

const hasCredentialHeader = (headers: Headers): boolean =>
  headers.has('authorization') ||
  headers.has('proxy-authorization') ||
  headers.has('cookie');

const hasUnsafeStaticRequestHeader = (headers: Headers): boolean => {
  let unsafe = false;
  headers.forEach((_value, name) => {
    if (name !== 'accept' && name !== 'accept-encoding') {
      unsafe = true;
    }
  });
  return unsafe;
};

const hasUnsafeStaticVary = (vary: string): boolean =>
  vary
    .split(',')
    .some(
      (name) =>
        name.trim() !== '' && name.trim().toLowerCase() !== 'accept-encoding',
    );

const hasMatchingResponseUrl = (
  responseUrl: string,
  requestUrl: URL,
): boolean => {
  if (responseUrl === '') {
    return false;
  }
  try {
    const parsed = new URL(responseUrl);
    return (
      parsed.origin === requestUrl.origin &&
      parsed.pathname === requestUrl.pathname &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
};

export class LogoutPurgeCoordinator {
  private pendingLogout: Promise<LogoutPurgeResult> | null = null;
  private readonly preflightTimeoutMs: number;

  constructor(
    private readonly dependencies: LogoutPurgeDependencies,
    options: LogoutPurgeCoordinatorOptions = {},
  ) {
    const timeoutMs = options.preflightTimeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new Error('Invalid logout preflight timeout');
    }
    this.preflightTimeoutMs = timeoutMs;
  }

  async logout(decision?: LogoutDecision): Promise<LogoutPurgeResult> {
    if (!isConfirmedDecision(decision)) {
      return freezeResult('decision-required', []);
    }

    if (this.pendingLogout !== null) {
      return this.pendingLogout;
    }
    const pending = this.performLogout(decision);
    this.pendingLogout = pending;
    try {
      return await pending;
    } finally {
      if (this.pendingLogout === pending) {
        this.pendingLogout = null;
      }
    }
  }

  private async performLogout(
    decision: LogoutDecision,
  ): Promise<LogoutPurgeResult> {
    try {
      await this.runPreflight((signal) =>
        this.dependencies.sync.sealForLogout(signal),
      );
    } catch {
      try {
        this.dependencies.sync.resumeAfterFailedLogout();
      } catch {
        // A safe, non-destructive result is returned either way.
      }
      return freezeResult('logout-blocked', ['local-edit-boundary']);
    }

    try {
      const keySeal = await this.runPreflight((signal) =>
        this.dependencies.keys.sealForLogout(signal),
      );
      if (!keySeal.complete || keySeal.failedSteps.length > 0) {
        const keyFailures: LogoutPurgeFailure[] =
          keySeal.failedSteps.length === 0
            ? ['keys']
            : keySeal.failedSteps.map((step) => `keys.${step}` as const);
        return freezeResult('logout-blocked', keyFailures);
      }
    } catch {
      return freezeResult('logout-blocked', ['keys']);
    }

    let crossContext: PreparedCrossContextPurge;
    try {
      crossContext = await this.dependencies.crossContext.prepare(
        decision.kind,
      );
    } catch {
      return freezeResult('logout-blocked', ['cross-context-teardown']);
    }

    if (decision.kind === 'sync-now') {
      try {
        for (let batch = 0; batch < 1_024; batch += 1) {
          const result = await crossContext.guard((signal) =>
            this.dependencies.sync.syncNowForLogout(signal),
          );
          if (result.status === 'partial') {
            return this.failSyncAfterPreparedTeardown(crossContext);
          }
          if (
            !(await crossContext.guard((signal) =>
              this.dependencies.sync.hasPendingOperations(signal),
            ))
          ) {
            break;
          }
          if (
            result.status === 'idle' ||
            result.acceptedOperationIds.length +
              result.terminalConflicts.length ===
              0 ||
            batch === 1_023
          ) {
            return this.failSyncAfterPreparedTeardown(crossContext);
          }
        }
      } catch (error) {
        return this.failSyncAfterPreparedTeardown(
          crossContext,
          error instanceof CrossContextPurgeBarrierExpiredError,
        );
      }
    }

    const closeFailures: LogoutPurgeFailure[] = [];
    try {
      const result = await crossContext.guard((signal) =>
        this.dependencies.database.sealAndCloseForLogout(signal),
      );
      if (!result.complete && result.failedSteps.length === 0) {
        closeFailures.push('database');
      }
      for (const step of result.failedSteps) {
        closeFailures.push(`database.${step}`);
      }
    } catch (error) {
      closeFailures.push('database');
      if (error instanceof CrossContextPurgeBarrierExpiredError) {
        closeFailures.push('cross-context-teardown');
      }
    }
    if (closeFailures.length > 0) {
      if (
        !(await this.abortPreparedTeardown(crossContext)) &&
        !closeFailures.includes('cross-context-teardown')
      ) {
        closeFailures.push('cross-context-teardown');
      }
      return freezeResult('logout-blocked', closeFailures);
    }

    try {
      return await crossContext.run(async (permit, signal) => {
        try {
          await this.dependencies.serverSession.revokeServerSession(signal);
        } catch {
          const failures: LogoutPurgeFailure[] = ['server-session'];
          if (signal.aborted) {
            failures.push('cross-context-teardown');
          }
          return freezeResult('logout-blocked', failures);
        }
        return this.purgeAllLocalState(permit, signal);
      });
    } catch {
      return freezeResult('logout-blocked', ['cross-context-teardown']);
    }
  }

  private async failSyncAfterPreparedTeardown(
    prepared: PreparedCrossContextPurge,
    barrierExpired = false,
  ): Promise<LogoutPurgeResult> {
    const failures: LogoutPurgeFailure[] = ['canonical-sync'];
    if (barrierExpired) {
      failures.push('cross-context-teardown');
    }
    if (!(await this.abortPreparedTeardown(prepared))) {
      if (!failures.includes('cross-context-teardown')) {
        failures.push('cross-context-teardown');
      }
    }
    return freezeResult('sync-failed', failures);
  }

  private async abortPreparedTeardown(
    prepared: PreparedCrossContextPurge,
  ): Promise<boolean> {
    try {
      await prepared.abort();
      return true;
    } catch {
      return false;
    }
  }

  private async purgeAllLocalState(
    permit: OfflinePurgePermit,
    signal: AbortSignal,
  ): Promise<LogoutPurgeResult> {
    const failures: LogoutPurgeFailure[] = [];

    try {
      const result = await this.dependencies.database.purge(permit, signal);
      if (!result.complete && result.failedSteps.length === 0) {
        failures.push('database');
      }
      for (const step of result.failedSteps) {
        failures.push(`database.${step}`);
      }
    } catch {
      failures.push('database');
    }

    try {
      await this.dependencies.tokens.deleteAuthTokens(signal);
    } catch {
      failures.push('auth-tokens');
    }

    try {
      await this.dependencies.tokens.deleteSyncTokens(signal);
    } catch {
      failures.push('sync-tokens');
    }

    try {
      await this.dependencies.privateCaches.purge(signal);
    } catch {
      failures.push('private-caches');
    }

    // Key deletion is the final irreversible step. If another cleanup target
    // fails after server revocation, retaining the atomic wrapped key pair and
    // logout-pending tombstone allows a reload to enter cleanup-only recovery
    // and retry; it never restores ordinary offline editing.
    if (failures.length === 0) {
      try {
        const result = await this.dependencies.keys.purge(permit, signal);
        if (!result.complete && result.failedSteps.length === 0) {
          failures.push('keys');
        }
        for (const step of result.failedSteps) {
          failures.push(`keys.${step}`);
        }
      } catch {
        failures.push('keys');
      }
    }

    return freezeResult(
      failures.length === 0 ? 'complete' : 'incomplete',
      failures,
    );
  }

  private async runPreflight<Value>(
    operation: (signal: AbortSignal) => Promise<Value>,
  ): Promise<Value> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.preflightTimeoutMs,
    );
    try {
      return await raceWithAbort(
        Promise.resolve().then(() => operation(controller.signal)),
        controller.signal,
        'Logout preflight timed out',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Production browser composition for the offline boundary. This is the only
 * factory that should wire the PowerSync database, device key, cross-tab
 * teardown, durable API upload queue, and logout purge together.
 */
export const createBrowserOfflineRuntimeComposition = (
  options: BrowserOfflineRuntimeCompositionOptions,
): Promise<BrowserOfflineRuntimeComposition> =>
  createBrowserOfflineRuntimeCompositionInternal(options, false);

export const createBrowserOfflineLogoutRecoveryComposition = async (
  options: BrowserOfflineRuntimeCompositionOptions,
): Promise<BrowserOfflineLogoutRecoveryComposition> => {
  const deviceKeyStorage =
    options.deviceKeyStorage ?? new IndexedDbDeviceKeyStorage();
  const recoveryOptions: BrowserOfflineRuntimeCompositionOptions =
    options.deviceKeyStorage === undefined
      ? { ...options, deviceKeyStorage }
      : options;
  const hint = await inspectBrowserOfflineSession(deviceKeyStorage);
  if (
    hint?.status !== 'logout-pending' ||
    hint.sessionBinding !== options.sessionBinding
  ) {
    throw new Error(
      'A matching logout-pending offline session is required for recovery',
    );
  }
  const composition = await createBrowserOfflineRuntimeCompositionInternal(
    recoveryOptions,
    true,
  );
  try {
    await composition.sync.sealForLogout();
  } catch (error) {
    await composition.dispose().catch(() => undefined);
    throw error;
  }
  return Object.freeze({
    canEditOffline: false as const,
    logoutBoundary: composition.logoutBoundary,
    hasPendingOperations: (signal?: AbortSignal) =>
      composition.sync.hasPendingOperations(signal),
    dispose: () => composition.dispose(),
  });
};

const createBrowserOfflineRuntimeCompositionInternal = async (
  options: BrowserOfflineRuntimeCompositionOptions,
  logoutRecovery: boolean,
): Promise<BrowserOfflineRuntimeComposition> => {
  if (!/^[a-f0-9]{64}$/u.test(options.sessionBinding)) {
    throw new Error('Expected a SHA-256 authenticated session binding');
  }
  if (typeof options.onPeerTeardown !== 'function') {
    throw new Error('A peer teardown memory-clearing callback is required');
  }
  const webCrypto = options.webCrypto ?? globalThis.crypto;
  if (webCrypto === undefined) {
    throw new Error('WebCrypto is required for browser offline storage');
  }
  const lockManager = options.lockManager ?? requireBrowserOfflineLockManager();
  const lifecycleLock = new NavigatorOfflineDatabaseLifecycleLock(lockManager);
  const deviceKeyStorage =
    options.deviceKeyStorage ?? new IndexedDbDeviceKeyStorage();
  const keys = new DeviceDatabaseKeyManager(
    deviceKeyStorage,
    webCrypto,
    new NavigatorExclusiveDeviceLock(lockManager),
    options.sessionBinding,
    lifecycleLock,
  );
  const powerSyncRuntime =
    options.powerSyncRuntime ??
    new PowerSyncBrowserRuntime({ schema: options.schema });
  const databaseKeyProvider: DatabaseKeyProvider = logoutRecovery
    ? Object.freeze({
        authenticatedSessionBinding: options.sessionBinding,
        getOrCreateDatabaseKey: (signal?: AbortSignal) =>
          keys.getExistingDatabaseKeyForLogoutRecovery(signal),
      })
    : keys;
  const database = new OfflineDatabaseController(
    new PowerSyncWebDatabaseAdapter(powerSyncRuntime),
    databaseKeyProvider,
    lifecycleLock,
    options.databaseName ?? 'emdo.sqlite3',
    options.sessionBinding,
  );

  let sync: ApiCanonicalSyncClient | null = null;
  let replication: ApiOwnedPowerSyncBackendConnector | null = null;
  let replicationState: BrowserOfflineRuntimeComposition['replication'] =
    Object.freeze({
      mode: 'offline' as const,
      state: 'disabled' as const,
      liveReplicationVerified: false as const,
    });
  let peerTeardownStarted = false;
  let pendingPeerTeardown: Promise<void> | null = null;
  const startupController = new AbortController();
  const presenceStore =
    options.presenceStore ??
    new LocalStorageBrowserContextPresenceStore(requireBrowserLocalStorage());
  let transport: BroadcastChannelCrossContextTeardownTransport;
  try {
    transport = await BroadcastChannelCrossContextTeardownTransport.create({
      sessionBinding: options.sessionBinding,
      teardownPeer: async (
        _request: CrossContextTeardownRequest,
        signal: AbortSignal,
      ) => {
        peerTeardownStarted = true;
        startupController.abort(
          new Error('Peer logout sealed this browser context during startup'),
        );
        const pending = (async () => {
          if (sync !== null) {
            await sync.sealForLogout(signal);
          }
          replication?.sealForLogout();
          const keyResult = await keys.sealForLogout(signal);
          if (!keyResult.complete || keyResult.failedSteps.length > 0) {
            throw new Error('Peer device-key teardown did not complete');
          }
          const databaseResult = await database.sealAndCloseForLogout(signal);
          if (
            !databaseResult.complete ||
            databaseResult.failedSteps.length > 0
          ) {
            throw new Error('Peer database teardown did not complete');
          }
          await options.onPeerTeardown(signal);
        })();
        pendingPeerTeardown = pending;
        try {
          await pending;
        } finally {
          if (pendingPeerTeardown === pending) {
            pendingPeerTeardown = null;
          }
        }
      },
      presenceStore,
      ...(options.channelFactory === undefined
        ? {}
        : { channelFactory: options.channelFactory }),
      ...(options.contextId === undefined
        ? {}
        : { contextId: options.contextId }),
      webCrypto,
    });
  } catch (error) {
    await database.dispose().catch(() => undefined);
    throw error;
  }

  let activeSync: ApiCanonicalSyncClient;
  try {
    if (peerTeardownStarted) {
      throw new Error('Peer logout sealed this browser context during startup');
    }
    await database.open(startupController.signal);
    if (peerTeardownStarted) {
      throw new Error('Peer logout sealed this browser context during startup');
    }
    const pendingOperations = new EncryptedSqlitePendingOperationStore(
      database.getEncryptedSqliteConnection(),
      webCrypto,
    );
    await pendingOperations.initialize();
    if (peerTeardownStarted) {
      throw new Error('Peer logout sealed this browser context during startup');
    }
    activeSync = new ApiCanonicalSyncClient(
      pendingOperations,
      options.canonicalSyncApi,
      webCrypto,
    );
    sync = activeSync;
    if (!logoutRecovery && options.replicationMode === 'online') {
      replication = new ApiOwnedPowerSyncBackendConnector({
        clientId: options.replicationClientId,
        sessionBinding: options.sessionBinding,
        sync: activeSync,
        ...(options.expectedPowerSyncEndpoint === undefined
          ? {}
          : { expectedEndpoint: options.expectedPowerSyncEndpoint }),
        ...(options.replicationFetch === undefined
          ? {}
          : { fetcher: options.replicationFetch }),
      });
      const attempt = await powerSyncRuntime.connectEncryptedDatabase(
        {
          databaseName: options.databaseName ?? 'emdo.sqlite3',
          connector: replication,
        },
        startupController.signal,
      );
      if (
        attempt.state !== 'background-started' ||
        attempt.liveReplicationVerified !== false
      ) {
        throw new Error(
          'PowerSync returned an invalid connection attempt state',
        );
      }
      replicationState = Object.freeze({
        mode: 'online' as const,
        ...attempt,
      });
    }
    if (peerTeardownStarted) {
      throw new Error('Peer logout sealed this browser context during startup');
    }
  } catch (error) {
    replication?.dispose();
    if (pendingPeerTeardown !== null) {
      await Promise.allSettled([pendingPeerTeardown]);
    }
    await transport.waitForActivePeerTeardowns();
    await Promise.allSettled([transport.dispose(), database.dispose()]);
    throw error;
  }

  const crossContext = new VerifiedCrossContextLogoutBoundary(
    transport,
    lifecycleLock,
    {
      sessionBinding: options.sessionBinding,
      ...(options.teardownTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.teardownTimeoutMs }),
      webCrypto,
    },
  );
  const logoutBoundary = new LogoutPurgeCoordinator({
    sync: {
      sealForLogout: async (signal) => {
        await activeSync.sealForLogout(signal);
        replication?.sealForLogout();
      },
      resumeAfterFailedLogout: () => {
        replication?.resumeAfterFailedLogout();
        activeSync.resumeAfterFailedLogout();
      },
      hasPendingOperations: (signal) => activeSync.hasPendingOperations(signal),
      syncNowForLogout: (signal) => activeSync.syncNowForLogout(signal),
    },
    database,
    keys,
    crossContext,
    serverSession: options.serverSession,
    tokens: options.tokens,
    privateCaches: options.privateCaches,
  });
  let pendingDispose: Promise<void> | null = null;
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    if (pendingDispose !== null) {
      return pendingDispose;
    }
    const pending = (async () => {
      let syncSealFailed = false;
      try {
        await activeSync.sealForLogout();
      } catch {
        syncSealFailed = true;
      }
      replication?.dispose();
      const [transportResult, databaseResult] = await Promise.allSettled([
        transport.dispose(),
        database.dispose(),
      ]);
      if (
        transportResult.status === 'rejected' ||
        databaseResult.status === 'rejected' ||
        syncSealFailed ||
        (databaseResult.status === 'fulfilled' &&
          (!databaseResult.value.complete ||
            databaseResult.value.failedSteps.length > 0))
      ) {
        throw new Error('Browser offline runtime disposal was incomplete');
      }
      disposed = true;
    })();
    pendingDispose = pending;
    try {
      await pending;
    } finally {
      if (pendingDispose === pending) {
        pendingDispose = null;
      }
    }
  };

  return Object.freeze({
    lifecycleLock,
    keys,
    database,
    sync: activeSync,
    crossContext,
    logoutBoundary,
    replication: replicationState,
    dispose,
  });
};

const requireBrowserOfflineLockManager = (): BrowserOfflineLockManager => {
  const navigatorValue = globalThis.navigator as unknown as {
    readonly locks?: BrowserOfflineLockManager;
  };
  if (navigatorValue?.locks === undefined) {
    throw new Error('Web Locks are required for browser offline storage');
  }
  return navigatorValue.locks;
};

const requireBrowserLocalStorage = (): Storage => {
  let storage: Storage | undefined;
  try {
    storage = globalThis.localStorage;
  } catch {
    throw new Error('Browser localStorage is required for context presence');
  }
  if (storage === undefined) {
    throw new Error('Browser localStorage is required for context presence');
  }
  return storage;
};

const isConfirmedDecision = (
  decision: LogoutDecision | undefined,
): decision is LogoutDecision =>
  decision?.kind === 'sync-now' ||
  (decision?.kind === 'discard' && decision.confirmed === true);

const freezeResult = (
  status: LogoutPurgeResult['status'],
  failedSteps: readonly LogoutPurgeFailure[],
): LogoutPurgeResult =>
  Object.freeze({
    status,
    failedSteps: Object.freeze([...failedSteps]),
  });

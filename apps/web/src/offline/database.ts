import type {
  CommonPowerSyncDatabase,
  PowerSyncBackendConnector,
  Schema,
  Transaction,
  WASQLiteVFS,
  WebPowerSyncDatabaseOptions,
} from '@powersync/web';

export interface SafariCompatibleOpfsConfiguration {
  readonly storage: 'opfs';
  readonly safariCompatibilityMode: true;
  readonly workerMode: 'dedicated';
  readonly sharedArrayBufferRequired: false;
}

export const SAFARI_COMPATIBLE_OPFS_CONFIGURATION: SafariCompatibleOpfsConfiguration =
  Object.freeze({
    storage: 'opfs',
    safariCompatibilityMode: true,
    workerMode: 'dedicated',
    sharedArrayBufferRequired: false,
  });

const LIFECYCLE_LOCK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/u;

export interface OfflinePurgePermit {
  readonly version: 1;
  readonly lifecycleLockName: string;
  readonly requestId: string;
  readonly sessionBinding: string;
  readonly decision: 'sync-now' | 'discard';
  readonly deadlineAt: number;
  readonly targets: readonly OfflinePurgeTarget[];
}

export type OfflinePurgeTarget =
  'database' | 'keys' | 'auth-tokens' | 'sync-tokens' | 'private-caches';

export interface VerifiedOfflinePurgeAuthorization {
  readonly version: 1;
  readonly requestId: string;
  readonly sessionBinding: string;
  readonly decision: 'sync-now' | 'discard';
  readonly deadlineAt: number;
  readonly targets: readonly OfflinePurgeTarget[];
}

export interface OfflineDatabaseSharedLease {
  release(): Promise<void>;
}

export interface OfflineDatabaseLifecycleLock {
  readonly lifecycleLockName: string;
  acquireSharedOpenLease(
    signal?: AbortSignal,
  ): Promise<OfflineDatabaseSharedLease>;
  runWithExclusivePurgeLease<Value>(
    authorization: VerifiedOfflinePurgeAuthorization,
    signal: AbortSignal,
    operation: (permit: OfflinePurgePermit) => Promise<Value>,
  ): Promise<Value>;
}

interface ActivePurgePermitState {
  readonly authority: OfflineDatabaseLifecycleLock;
  readonly operations: Set<Promise<unknown>>;
  acceptingOperations: boolean;
}

interface ActivePurgeAuthorizationState {
  readonly authority: OfflineDatabaseLifecycleLock;
  consumed: boolean;
}

const ACTIVE_PURGE_PERMITS = new WeakMap<object, ActivePurgePermitState>();
const ACTIVE_PURGE_AUTHORIZATIONS = new WeakMap<
  object,
  ActivePurgeAuthorizationState
>();
const PURGE_TARGETS: readonly OfflinePurgeTarget[] = Object.freeze([
  'database',
  'keys',
  'auth-tokens',
  'sync-tokens',
  'private-caches',
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SESSION_BINDING_PATTERN = /^[a-f0-9]{64}$/u;

interface BrowserLifecycleLockManager {
  request<Value>(
    name: string,
    options: {
      readonly mode: 'shared' | 'exclusive';
      readonly signal?: AbortSignal;
    },
    operation: () => Promise<Value>,
  ): Promise<Value>;
}

const issuePurgePermit = (
  authority: OfflineDatabaseLifecycleLock,
  authorization: VerifiedOfflinePurgeAuthorization,
): OfflinePurgePermit => {
  const permit = Object.freeze({
    version: 1 as const,
    lifecycleLockName: authority.lifecycleLockName,
    requestId: authorization.requestId,
    sessionBinding: authorization.sessionBinding,
    decision: authorization.decision,
    deadlineAt: authorization.deadlineAt,
    targets: authorization.targets,
  });
  ACTIVE_PURGE_PERMITS.set(permit, {
    authority,
    operations: new Set(),
    acceptingOperations: true,
  });
  return permit;
};

const authorizeOfflinePurgeAfterVerifiedTeardown = (
  authority: OfflineDatabaseLifecycleLock,
  claims: Omit<VerifiedOfflinePurgeAuthorization, 'version' | 'targets'>,
): VerifiedOfflinePurgeAuthorization => {
  if (
    !UUID_PATTERN.test(claims.requestId) ||
    !SESSION_BINDING_PATTERN.test(claims.sessionBinding) ||
    (claims.decision !== 'sync-now' && claims.decision !== 'discard') ||
    !Number.isFinite(claims.deadlineAt)
  ) {
    throw new Error('Invalid verified offline purge authorization claims');
  }
  if (claims.deadlineAt <= Date.now()) {
    throw new CrossContextPurgeBarrierExpiredError();
  }
  const authorization = Object.freeze({
    version: 1 as const,
    ...claims,
    targets: PURGE_TARGETS,
  });
  ACTIVE_PURGE_AUTHORIZATIONS.set(authorization, {
    authority,
    consumed: false,
  });
  return authorization;
};

const consumeVerifiedPurgeAuthorization = (
  authorization: VerifiedOfflinePurgeAuthorization,
  authority: OfflineDatabaseLifecycleLock,
): void => {
  const state = ACTIVE_PURGE_AUTHORIZATIONS.get(authorization);
  if (
    state === undefined ||
    state.authority !== authority ||
    state.consumed ||
    authorization.targets !== PURGE_TARGETS
  ) {
    throw new Error('A current verified purge authorization is required');
  }
  if (authorization.deadlineAt <= Date.now()) {
    throw new CrossContextPurgeBarrierExpiredError();
  }
  state.consumed = true;
};

const revokePurgePermit = (permit: OfflinePurgePermit): void => {
  ACTIVE_PURGE_PERMITS.delete(permit);
};

export const assertActiveOfflinePurgePermit = (
  permit: OfflinePurgePermit,
  expectedAuthority: OfflineDatabaseLifecycleLock,
  expectedTarget: 'database' | 'keys',
): void => {
  const state = ACTIVE_PURGE_PERMITS.get(permit);
  if (
    state === undefined ||
    state.authority !== expectedAuthority ||
    !state.acceptingOperations ||
    permit.version !== 1 ||
    permit.lifecycleLockName !== expectedAuthority.lifecycleLockName ||
    permit.lifecycleLockName !== state.authority.lifecycleLockName ||
    permit.deadlineAt <= Date.now() ||
    !permit.targets.includes(expectedTarget)
  ) {
    throw new Error('An active exclusive offline purge permit is required');
  }
};

export const registerOfflinePurgeOperation = <Value>(
  permit: OfflinePurgePermit,
  expectedAuthority: OfflineDatabaseLifecycleLock,
  expectedTarget: 'database' | 'keys',
  operation: () => Promise<Value>,
): Promise<Value> => {
  assertActiveOfflinePurgePermit(permit, expectedAuthority, expectedTarget);
  const state = ACTIVE_PURGE_PERMITS.get(permit);
  if (state === undefined) {
    throw new Error('An active exclusive offline purge permit is required');
  }
  const pending = operation();
  state.operations.add(pending);
  return pending;
};

const stopAndDrainPurgeOperations = async (
  permit: OfflinePurgePermit,
  expectedAuthority: OfflineDatabaseLifecycleLock,
): Promise<void> => {
  const state = ACTIVE_PURGE_PERMITS.get(permit);
  if (state === undefined || state.authority !== expectedAuthority) {
    throw new Error('An active exclusive offline purge permit is required');
  }
  state.acceptingOperations = false;
  const outcomes = await Promise.allSettled([...state.operations]);
  const failed = outcomes.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === 'rejected',
  );
  if (failed !== undefined) {
    throw failed.reason;
  }
};

export class NavigatorOfflineDatabaseLifecycleLock implements OfflineDatabaseLifecycleLock {
  constructor(
    private readonly lockManager: BrowserLifecycleLockManager,
    readonly lifecycleLockName = 'emdo:offline-database-lifecycle:v1',
  ) {
    assertLifecycleLockName(lifecycleLockName);
  }

  async acquireSharedOpenLease(
    signal?: AbortSignal,
  ): Promise<OfflineDatabaseSharedLease> {
    let signalAcquired = (): void => undefined;
    let signalReleased = (): void => undefined;
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    const released = new Promise<void>((resolve) => {
      signalReleased = resolve;
    });
    const holding = this.lockManager.request(
      this.lifecycleLockName,
      signal === undefined ? { mode: 'shared' } : { mode: 'shared', signal },
      async () => {
        signalAcquired();
        await released;
      },
    );
    const acquisition = holding.catch(() => undefined);
    await Promise.race([
      acquired,
      holding.then(() => {
        throw new Error('Unable to acquire the shared offline database lock');
      }),
    ]);
    let leaseReleased = false;
    return Object.freeze({
      release: async () => {
        if (leaseReleased) {
          return;
        }
        leaseReleased = true;
        signalReleased();
        await acquisition;
      },
    });
  }

  runWithExclusivePurgeLease<Value>(
    authorization: VerifiedOfflinePurgeAuthorization,
    signal: AbortSignal,
    operation: (permit: OfflinePurgePermit) => Promise<Value>,
  ): Promise<Value> {
    consumeVerifiedPurgeAuthorization(authorization, this);
    return this.lockManager.request(
      this.lifecycleLockName,
      { mode: 'exclusive', signal },
      async () => {
        if (authorization.deadlineAt <= Date.now()) {
          throw new CrossContextPurgeBarrierExpiredError();
        }
        const permit = issuePurgePermit(this, authorization);
        try {
          try {
            return await operation(permit);
          } finally {
            await stopAndDrainPurgeOperations(permit, this);
          }
        } finally {
          revokePurgePermit(permit);
        }
      },
    );
  }
}

export class InMemoryOfflineDatabaseLifecycleLock implements OfflineDatabaseLifecycleLock {
  private readers = 0;
  private writerActive = false;
  private writersWaiting = 0;
  private change = createDeferred<void>();

  constructor(
    readonly lifecycleLockName = 'emdo:offline-database-lifecycle:test',
  ) {
    assertLifecycleLockName(lifecycleLockName);
  }

  async acquireSharedOpenLease(
    signal?: AbortSignal,
  ): Promise<OfflineDatabaseSharedLease> {
    if (signal?.aborted) {
      throw new Error('Shared offline database lock acquisition was aborted');
    }
    while (this.writerActive || this.writersWaiting > 0) {
      if (signal === undefined) {
        await this.change.promise;
      } else {
        await waitForChangeOrAbort(this.change.promise, signal);
      }
    }
    this.readers += 1;
    let released = false;
    return Object.freeze({
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        this.readers -= 1;
        this.signalChange();
      },
    });
  }

  async runWithExclusivePurgeLease<Value>(
    authorization: VerifiedOfflinePurgeAuthorization,
    signal: AbortSignal,
    operation: (permit: OfflinePurgePermit) => Promise<Value>,
  ): Promise<Value> {
    consumeVerifiedPurgeAuthorization(authorization, this);
    if (signal.aborted) {
      throw new Error('Exclusive offline purge lock acquisition was aborted');
    }
    this.writersWaiting += 1;
    let acquired = false;
    try {
      while (this.writerActive || this.readers > 0) {
        await waitForChangeOrAbort(this.change.promise, signal);
      }
      this.writerActive = true;
      acquired = true;
    } finally {
      this.writersWaiting -= 1;
      if (!acquired) {
        this.signalChange();
      }
    }

    let permit: OfflinePurgePermit | null = null;
    try {
      if (authorization.deadlineAt <= Date.now()) {
        throw new CrossContextPurgeBarrierExpiredError();
      }
      permit = issuePurgePermit(this, authorization);
      try {
        return await operation(permit);
      } finally {
        await stopAndDrainPurgeOperations(permit, this);
      }
    } finally {
      if (permit !== null) {
        revokePurgePermit(permit);
      }
      this.writerActive = false;
      this.signalChange();
    }
  }

  private signalChange(): void {
    const current = this.change;
    this.change = createDeferred<void>();
    current.resolve(undefined);
  }
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

const createDeferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const waitForChangeOrAbort = async (
  change: Promise<void>,
  signal: AbortSignal,
): Promise<void> => {
  let abort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(new Error('Exclusive offline purge lock acquisition was aborted'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    await Promise.race([change, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
};

export type OfflineLogoutDecisionKind = 'sync-now' | 'discard';

export interface CrossContextTeardownRequest {
  readonly version: 1;
  readonly requestId: string;
  readonly sessionBinding: string;
  readonly decision: OfflineLogoutDecisionKind;
  readonly deadlineAt: number;
}

export interface CrossContextTeardownAcknowledgement {
  readonly version: 1;
  readonly requestId: string;
  readonly sessionBinding: string;
  readonly decision: OfflineLogoutDecisionKind;
  readonly deadlineAt: number;
  readonly contextId: string;
  readonly state: 'sealed-and-closed';
}

export interface CrossContextTeardownResponse {
  readonly knownContextIds: readonly string[];
  readonly acknowledgements: readonly CrossContextTeardownAcknowledgement[];
}

export interface CrossContextTeardownTransport {
  requestKnownContextTeardown(
    request: CrossContextTeardownRequest,
    signal: AbortSignal,
  ): Promise<CrossContextTeardownResponse>;
}

export interface PreparedCrossContextPurge {
  guard<Value>(
    operation: (signal: AbortSignal) => Promise<Value>,
  ): Promise<Value>;
  run<Value>(
    operation: (
      permit: OfflinePurgePermit,
      signal: AbortSignal,
    ) => Promise<Value>,
  ): Promise<Value>;
  abort(): Promise<void>;
}

export interface CrossContextLogoutBoundary {
  prepare(
    decision: OfflineLogoutDecisionKind,
  ): Promise<PreparedCrossContextPurge>;
}

export interface BrowserContextPresenceRecord {
  readonly version: 1;
  readonly contextId: string;
  readonly sessionBinding: string;
  readonly lastSeenAt: number;
}

export interface BrowserContextPresenceStore {
  upsert(record: BrowserContextPresenceRecord): Promise<void>;
  list(): Promise<readonly BrowserContextPresenceRecord[]>;
  remove(contextId: string, sessionBinding: string): Promise<void>;
}

export class InMemoryBrowserContextPresenceStore implements BrowserContextPresenceStore {
  private readonly records = new Map<string, BrowserContextPresenceRecord>();

  async upsert(record: BrowserContextPresenceRecord): Promise<void> {
    validatePresenceRecord(record);
    this.records.set(record.contextId, Object.freeze({ ...record }));
  }

  async list(): Promise<readonly BrowserContextPresenceRecord[]> {
    return Object.freeze(
      [...this.records.values()].map((record) => Object.freeze({ ...record })),
    );
  }

  async remove(contextId: string, sessionBinding: string): Promise<void> {
    const current = this.records.get(contextId);
    if (current?.sessionBinding === sessionBinding) {
      this.records.delete(contextId);
    }
  }
}

export interface BrowserKeyValueStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class LocalStorageBrowserContextPresenceStore implements BrowserContextPresenceStore {
  constructor(
    private readonly storage: BrowserKeyValueStorage,
    private readonly keyPrefix = 'emdo.offline.context.v1.',
  ) {
    if (!/^emdo\.offline\.context\.v1\.[A-Za-z0-9._-]*$/u.test(keyPrefix)) {
      throw new Error('Invalid browser-context presence key prefix');
    }
  }

  async upsert(record: BrowserContextPresenceRecord): Promise<void> {
    validatePresenceRecord(record);
    this.storage.setItem(
      `${this.keyPrefix}${record.contextId}`,
      JSON.stringify(record),
    );
  }

  async list(): Promise<readonly BrowserContextPresenceRecord[]> {
    if (this.storage.length > MAX_POWERSYNC_OPFS_ENTRIES) {
      throw new Error('Browser storage entry count exceeds safe bounds');
    }
    const records: BrowserContextPresenceRecord[] = [];
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (key === null || !key.startsWith(this.keyPrefix)) {
        continue;
      }
      const value = this.storage.getItem(key);
      if (value === null || value.length > 512) {
        throw new Error('Invalid browser-context presence record');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error('Invalid browser-context presence record');
      }
      validatePresenceRecord(parsed);
      records.push(Object.freeze({ ...parsed }));
    }
    return Object.freeze(records);
  }

  async remove(contextId: string, sessionBinding: string): Promise<void> {
    const key = `${this.keyPrefix}${contextId}`;
    const value = this.storage.getItem(key);
    if (value === null) {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(value);
      validatePresenceRecord(parsed);
      if (parsed.sessionBinding === sessionBinding) {
        this.storage.removeItem(key);
      }
    } catch {
      throw new Error('Invalid browser-context presence record');
    }
  }
}

export interface CrossContextBroadcastChannel {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  close(): void;
}

export interface BroadcastChannelCrossContextTeardownOptions {
  readonly sessionBinding: string;
  readonly teardownPeer: (
    request: CrossContextTeardownRequest,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly contextId?: string;
  readonly presenceStore?: BrowserContextPresenceStore;
  readonly channelFactory?: (name: string) => CrossContextBroadcastChannel;
  readonly channelName?: string;
  readonly heartbeatIntervalMs?: number;
  readonly contextStaleAfterMs?: number;
  readonly now?: () => number;
  readonly webCrypto?: Crypto;
}

interface PendingCrossContextAcknowledgements {
  readonly request: CrossContextTeardownRequest;
  readonly knownContextIds: readonly string[];
  readonly known: ReadonlySet<string>;
  readonly acknowledgements: Map<string, CrossContextTeardownAcknowledgement>;
  readonly resolve: (response: CrossContextTeardownResponse) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

interface CrossContextTeardownRequestMessage {
  readonly version: 1;
  readonly kind: 'teardown-request';
  readonly senderContextId: string;
  readonly request: CrossContextTeardownRequest;
}

interface CrossContextTeardownAcknowledgementMessage {
  readonly version: 1;
  readonly kind: 'teardown-acknowledgement';
  readonly senderContextId: string;
  readonly acknowledgement: CrossContextTeardownAcknowledgement;
}

/**
 * Real browser peer transport. Presence records contain lifecycle metadata
 * only; no user payloads, credentials, or audio are written to localStorage or
 * BroadcastChannel. The Web Lock lifecycle barrier remains the final authority
 * that prevents a newly opening or frozen tab from racing deletion.
 */
export class BroadcastChannelCrossContextTeardownTransport implements CrossContextTeardownTransport {
  private readonly channel: CrossContextBroadcastChannel;
  private readonly contextId: string;
  private readonly sessionBinding: string;
  private readonly presenceStore: BrowserContextPresenceStore;
  private readonly teardownPeer: BroadcastChannelCrossContextTeardownOptions['teardownPeer'];
  private readonly heartbeatIntervalMs: number;
  private readonly contextStaleAfterMs: number;
  private readonly now: () => number;
  private readonly pending = new Map<
    string,
    PendingCrossContextAcknowledgements
  >();
  private readonly peerRequests = new Map<string, Promise<void>>();
  private readonly activePeerMessageHandlers = new Set<Promise<void>>();
  private readonly completedPeerRequests: string[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  static async create(
    options: BroadcastChannelCrossContextTeardownOptions,
  ): Promise<BroadcastChannelCrossContextTeardownTransport> {
    const transport = new BroadcastChannelCrossContextTeardownTransport(
      options,
    );
    await transport.heartbeat();
    transport.start();
    return transport;
  }

  private constructor(options: BroadcastChannelCrossContextTeardownOptions) {
    assertSessionBindingValue(options.sessionBinding);
    const webCrypto = options.webCrypto ?? globalThis.crypto;
    if (webCrypto === undefined) {
      throw new Error('WebCrypto is required for browser-context teardown');
    }
    const contextId = options.contextId ?? createPurgeRequestUuid(webCrypto);
    if (!CONTEXT_ID_PATTERN.test(contextId)) {
      throw new Error('Invalid browser context identifier');
    }
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 2_000;
    const contextStaleAfterMs = options.contextStaleAfterMs ?? 15_000;
    if (
      !Number.isInteger(heartbeatIntervalMs) ||
      heartbeatIntervalMs < 250 ||
      heartbeatIntervalMs > 30_000 ||
      !Number.isInteger(contextStaleAfterMs) ||
      contextStaleAfterMs < heartbeatIntervalMs * 2 ||
      contextStaleAfterMs > 120_000
    ) {
      throw new Error('Invalid browser-context heartbeat configuration');
    }
    this.sessionBinding = options.sessionBinding;
    this.contextId = contextId;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.contextStaleAfterMs = contextStaleAfterMs;
    this.now = options.now ?? Date.now;
    this.teardownPeer = options.teardownPeer;
    this.presenceStore =
      options.presenceStore ?? defaultBrowserContextPresenceStore();
    const channelFactory =
      options.channelFactory ?? defaultCrossContextBroadcastChannelFactory();
    const channelName = options.channelName ?? 'emdo:offline-teardown:v1';
    if (!LIFECYCLE_LOCK_NAME_PATTERN.test(channelName)) {
      throw new Error('Invalid cross-context teardown channel name');
    }
    this.channel = channelFactory(channelName);
  }

  async requestKnownContextTeardown(
    request: CrossContextTeardownRequest,
    signal: AbortSignal,
  ): Promise<CrossContextTeardownResponse> {
    this.requireActive();
    validateTeardownRequest(request, this.sessionBinding, this.now());
    if (signal.aborted) {
      throw new Error('Browser-context teardown was aborted');
    }
    await this.heartbeat();
    const now = this.now();
    const records = await this.presenceStore.list();
    const knownContextIds = records
      .filter(
        (record) =>
          record.contextId !== this.contextId &&
          record.sessionBinding === this.sessionBinding &&
          record.lastSeenAt <= now &&
          now - record.lastSeenAt <= this.contextStaleAfterMs,
      )
      .map((record) => record.contextId)
      .sort();
    if (
      knownContextIds.length > MAX_KNOWN_BROWSER_CONTEXTS ||
      new Set(knownContextIds).size !== knownContextIds.length
    ) {
      throw new Error('Invalid known browser context set');
    }
    if (knownContextIds.length === 0) {
      return Object.freeze({
        knownContextIds: Object.freeze([]),
        acknowledgements: Object.freeze([]),
      });
    }

    return new Promise<CrossContextTeardownResponse>((resolve, reject) => {
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = (): void =>
        pending.reject(new Error('Browser-context teardown was aborted'));
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
        if (deadlineTimer !== null) {
          clearTimeout(deadlineTimer);
        }
        this.pending.delete(request.requestId);
      };
      const pending: PendingCrossContextAcknowledgements = {
        request,
        knownContextIds: Object.freeze([...knownContextIds]),
        known: new Set(knownContextIds),
        acknowledgements: new Map(),
        resolve: (response) => {
          cleanup();
          resolve(response);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        cleanup,
      };
      this.pending.set(request.requestId, pending);
      signal.addEventListener('abort', onAbort, { once: true });
      deadlineTimer = setTimeout(
        () =>
          pending.reject(
            new Error('Not every known browser context acknowledged teardown'),
          ),
        Math.max(1, request.deadlineAt - this.now()),
      );
      this.channel.postMessage(
        Object.freeze({
          version: 1 as const,
          kind: 'teardown-request' as const,
          senderContextId: this.contextId,
          request,
        } satisfies CrossContextTeardownRequestMessage),
      );
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.channel.removeEventListener('message', this.onMessage);
    this.channel.close();
    for (const pending of [...this.pending.values()]) {
      pending.reject(new Error('Browser-context teardown was disposed'));
    }
    await this.presenceStore.remove(this.contextId, this.sessionBinding);
  }

  async waitForActivePeerTeardowns(): Promise<void> {
    while (this.activePeerMessageHandlers.size > 0) {
      await Promise.allSettled([...this.activePeerMessageHandlers]);
    }
  }

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (isTeardownAcknowledgementMessage(message)) {
      this.acceptAcknowledgement(message);
      return;
    }
    if (isTeardownRequestMessage(message)) {
      const active = this.handlePeerRequest(message);
      this.activePeerMessageHandlers.add(active);
      void active
        .catch(() => undefined)
        .finally(() => this.activePeerMessageHandlers.delete(active));
    }
  };

  private start(): void {
    this.channel.addEventListener('message', this.onMessage);
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch(() => undefined);
    }, this.heartbeatIntervalMs);
  }

  private async heartbeat(): Promise<void> {
    this.requireActive();
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error('Browser-context clock is invalid');
    }
    await this.presenceStore.upsert(
      Object.freeze({
        version: 1 as const,
        contextId: this.contextId,
        sessionBinding: this.sessionBinding,
        lastSeenAt: now,
      }),
    );
  }

  private acceptAcknowledgement(
    message: CrossContextTeardownAcknowledgementMessage,
  ): void {
    const pending = this.pending.get(message.acknowledgement.requestId);
    if (pending === undefined || this.now() > pending.request.deadlineAt) {
      return;
    }
    const acknowledgement = message.acknowledgement;
    if (
      message.senderContextId !== acknowledgement.contextId ||
      acknowledgement.version !== 1 ||
      acknowledgement.requestId !== pending.request.requestId ||
      acknowledgement.sessionBinding !== pending.request.sessionBinding ||
      acknowledgement.decision !== pending.request.decision ||
      acknowledgement.deadlineAt !== pending.request.deadlineAt ||
      acknowledgement.state !== 'sealed-and-closed' ||
      !pending.known.has(acknowledgement.contextId) ||
      pending.acknowledgements.has(acknowledgement.contextId)
    ) {
      return;
    }
    pending.acknowledgements.set(
      acknowledgement.contextId,
      Object.freeze({ ...acknowledgement }),
    );
    if (pending.acknowledgements.size === pending.known.size) {
      pending.resolve(
        Object.freeze({
          knownContextIds: pending.knownContextIds,
          acknowledgements: Object.freeze(
            pending.knownContextIds.map((contextId) => {
              const exact = pending.acknowledgements.get(contextId);
              if (exact === undefined) {
                throw new Error('Missing browser-context acknowledgement');
              }
              return exact;
            }),
          ),
        }),
      );
    }
  }

  private async handlePeerRequest(
    message: CrossContextTeardownRequestMessage,
  ): Promise<void> {
    if (
      this.disposed ||
      message.senderContextId === this.contextId ||
      !CONTEXT_ID_PATTERN.test(message.senderContextId)
    ) {
      return;
    }
    validateTeardownRequest(message.request, this.sessionBinding, this.now());
    if (
      this.completedPeerRequests.includes(message.request.requestId) ||
      this.peerRequests.has(message.request.requestId)
    ) {
      return;
    }
    const now = this.now();
    const senderPresent = (await this.presenceStore.list()).some(
      (record) =>
        record.contextId === message.senderContextId &&
        record.sessionBinding === this.sessionBinding &&
        record.lastSeenAt <= now &&
        now - record.lastSeenAt <= this.contextStaleAfterMs,
    );
    if (!senderPresent) {
      return;
    }

    const pending = this.performPeerTeardown(message.request);
    this.peerRequests.set(message.request.requestId, pending);
    try {
      await pending;
      this.completedPeerRequests.push(message.request.requestId);
      if (this.completedPeerRequests.length > 128) {
        this.completedPeerRequests.shift();
      }
      if (!this.disposed && this.now() <= message.request.deadlineAt) {
        const acknowledgement = Object.freeze({
          version: 1 as const,
          requestId: message.request.requestId,
          sessionBinding: message.request.sessionBinding,
          decision: message.request.decision,
          deadlineAt: message.request.deadlineAt,
          contextId: this.contextId,
          state: 'sealed-and-closed' as const,
        });
        this.channel.postMessage(
          Object.freeze({
            version: 1 as const,
            kind: 'teardown-acknowledgement' as const,
            senderContextId: this.contextId,
            acknowledgement,
          } satisfies CrossContextTeardownAcknowledgementMessage),
        );
      }
    } finally {
      this.peerRequests.delete(message.request.requestId);
    }
  }

  private async performPeerTeardown(
    request: CrossContextTeardownRequest,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1, request.deadlineAt - this.now()),
    );
    try {
      await raceCrossContextOperationWithAbort(
        this.teardownPeer(request, controller.signal),
        controller.signal,
        'Peer browser-context teardown expired',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireActive(): void {
    if (this.disposed) {
      throw new Error('Browser-context teardown transport is disposed');
    }
  }
}

const defaultBrowserContextPresenceStore = (): BrowserContextPresenceStore => {
  let storage: Storage;
  try {
    storage = globalThis.localStorage;
  } catch {
    throw new Error('Browser localStorage is required for context presence');
  }
  if (storage === undefined) {
    throw new Error('Browser localStorage is required for context presence');
  }
  return new LocalStorageBrowserContextPresenceStore(storage);
};

const defaultCrossContextBroadcastChannelFactory = (): ((
  name: string,
) => CrossContextBroadcastChannel) => {
  if (typeof globalThis.BroadcastChannel === 'undefined') {
    throw new Error('BroadcastChannel is required for cross-context logout');
  }
  return (name) => new BroadcastChannel(name);
};

const validatePresenceRecord: (
  value: unknown,
) => asserts value is BrowserContextPresenceRecord = (value) => {
  if (value === null || typeof value !== 'object') {
    throw new Error('Invalid browser-context presence record');
  }
  const record = value as Partial<BrowserContextPresenceRecord>;
  if (
    record.version !== 1 ||
    typeof record.contextId !== 'string' ||
    !CONTEXT_ID_PATTERN.test(record.contextId) ||
    typeof record.sessionBinding !== 'string' ||
    !SESSION_BINDING_PATTERN.test(record.sessionBinding) ||
    !Number.isSafeInteger(record.lastSeenAt) ||
    (record.lastSeenAt ?? -1) < 0
  ) {
    throw new Error('Invalid browser-context presence record');
  }
};

const validateTeardownRequest = (
  request: CrossContextTeardownRequest,
  expectedSessionBinding: string,
  now: number,
): void => {
  if (
    request.version !== 1 ||
    !UUID_PATTERN.test(request.requestId) ||
    request.sessionBinding !== expectedSessionBinding ||
    (request.decision !== 'sync-now' && request.decision !== 'discard') ||
    !Number.isSafeInteger(request.deadlineAt) ||
    request.deadlineAt <= now ||
    request.deadlineAt - now > 30_000
  ) {
    throw new Error('Invalid browser-context teardown request');
  }
};

const isTeardownRequestMessage = (
  value: unknown,
): value is CrossContextTeardownRequestMessage => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const message = value as Partial<CrossContextTeardownRequestMessage>;
  return (
    message.version === 1 &&
    message.kind === 'teardown-request' &&
    typeof message.senderContextId === 'string' &&
    message.request !== null &&
    typeof message.request === 'object'
  );
};

const isTeardownAcknowledgementMessage = (
  value: unknown,
): value is CrossContextTeardownAcknowledgementMessage => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const message = value as Partial<CrossContextTeardownAcknowledgementMessage>;
  return (
    message.version === 1 &&
    message.kind === 'teardown-acknowledgement' &&
    typeof message.senderContextId === 'string' &&
    message.acknowledgement !== null &&
    typeof message.acknowledgement === 'object'
  );
};

const assertSessionBindingValue = (sessionBinding: string): void => {
  if (!SESSION_BINDING_PATTERN.test(sessionBinding)) {
    throw new Error('Expected a SHA-256 authenticated session binding');
  }
};

export interface VerifiedCrossContextLogoutOptions {
  readonly sessionBinding: string;
  readonly timeoutMs?: number;
  readonly webCrypto?: Crypto;
}

const CONTEXT_ID_PATTERN = UUID_PATTERN;
const MAX_KNOWN_BROWSER_CONTEXTS = 64;

export class CrossContextPurgeBarrierExpiredError extends Error {
  constructor() {
    super('Cross-context purge barrier has expired');
    this.name = 'CrossContextPurgeBarrierExpiredError';
  }
}

/**
 * The only production issuer of a purge authorization. It validates every
 * known peer acknowledgement before queuing the exclusive database lock. The
 * authorization itself remains module-private and is never returned to callers.
 */
export class VerifiedCrossContextLogoutBoundary implements CrossContextLogoutBoundary {
  private readonly sessionBinding: string;
  private readonly timeoutMs: number;
  private readonly webCrypto: Crypto;

  constructor(
    private readonly transport: CrossContextTeardownTransport,
    private readonly lifecycleLock: OfflineDatabaseLifecycleLock,
    options: VerifiedCrossContextLogoutOptions,
  ) {
    if (!SESSION_BINDING_PATTERN.test(options.sessionBinding)) {
      throw new Error('Expected a SHA-256 authenticated session binding');
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new Error('Invalid cross-context teardown timeout');
    }
    const webCrypto = options.webCrypto ?? globalThis.crypto;
    if (webCrypto === undefined) {
      throw new Error('WebCrypto is required for cross-context logout');
    }
    this.sessionBinding = options.sessionBinding;
    this.timeoutMs = timeoutMs;
    this.webCrypto = webCrypto;
  }

  async prepare(
    decision: OfflineLogoutDecisionKind,
  ): Promise<PreparedCrossContextPurge> {
    if (decision !== 'sync-now' && decision !== 'discard') {
      throw new Error('Invalid offline logout decision');
    }
    const now = Date.now();
    if (!Number.isFinite(now)) {
      throw new Error('Cross-context teardown clock is invalid');
    }
    const request = Object.freeze({
      version: 1 as const,
      requestId: createPurgeRequestUuid(this.webCrypto),
      sessionBinding: this.sessionBinding,
      decision,
      deadlineAt: now + this.timeoutMs,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: CrossContextTeardownResponse;
    try {
      response = await raceCrossContextOperationWithAbort(
        this.transport.requestKnownContextTeardown(request, controller.signal),
        controller.signal,
        'Known browser contexts did not acknowledge logout',
      );
    } finally {
      clearTimeout(timeout);
    }
    validateTeardownResponse(response, request);
    const remainingMs = request.deadlineAt - Date.now();
    if (remainingMs < 1) {
      throw new Error('Cross-context teardown authorization expired');
    }
    const authorization = authorizeOfflinePurgeAfterVerifiedTeardown(
      this.lifecycleLock,
      {
        requestId: request.requestId,
        sessionBinding: request.sessionBinding,
        decision: request.decision,
        deadlineAt: request.deadlineAt,
      },
    );
    return new PreparedExclusivePurge(
      this.lifecycleLock,
      remainingMs,
      authorization,
    );
  }
}

class PreparedExclusivePurge implements PreparedCrossContextPurge {
  private readonly operation =
    createDeferred<
      (permit: OfflinePurgePermit, signal: AbortSignal) => Promise<unknown>
    >();
  private readonly abortController = new AbortController();
  private readonly exclusiveResult: Promise<unknown>;
  private readonly watchdog: ReturnType<typeof setTimeout>;
  private expired = false;
  private purgeStarted = false;
  private terminal = false;

  constructor(
    lifecycleLock: OfflineDatabaseLifecycleLock,
    timeoutMs: number,
    authorization: VerifiedOfflinePurgeAuthorization,
  ) {
    this.watchdog = setTimeout(() => this.expire(), timeoutMs);
    this.exclusiveResult = lifecycleLock.runWithExclusivePurgeLease(
      authorization,
      this.abortController.signal,
      async (permit) => {
        const operation = await this.operation.promise;
        this.purgeStarted = true;
        return operation(permit, this.abortController.signal);
      },
    );
    void this.exclusiveResult.then(
      () => clearTimeout(this.watchdog),
      () => clearTimeout(this.watchdog),
    );
    void this.exclusiveResult.catch(() => undefined);
  }

  guard<Value>(
    operation: (signal: AbortSignal) => Promise<Value>,
  ): Promise<Value> {
    if (this.terminal || this.expired) {
      return Promise.reject(new CrossContextPurgeBarrierExpiredError());
    }
    return raceCrossContextOperationWithAbort(
      Promise.resolve().then(() => operation(this.abortController.signal)),
      this.abortController.signal,
      'Cross-context purge barrier has expired',
    ).catch((error: unknown) => {
      if (this.abortController.signal.aborted) {
        throw new CrossContextPurgeBarrierExpiredError();
      }
      throw error;
    });
  }

  async run<Value>(
    operation: (
      permit: OfflinePurgePermit,
      signal: AbortSignal,
    ) => Promise<Value>,
  ): Promise<Value> {
    if (this.terminal) {
      throw new Error('Cross-context purge barrier is already terminal');
    }
    if (this.expired) {
      await this.exclusiveResult.catch(() => undefined);
      throw new CrossContextPurgeBarrierExpiredError();
    }
    this.terminal = true;
    this.operation.resolve(async (permit, signal) => {
      if (this.expired) {
        throw new CrossContextPurgeBarrierExpiredError();
      }
      return operation(permit, signal);
    });
    try {
      return (await this.exclusiveResult) as Value;
    } catch (error: unknown) {
      if (this.expired || this.abortController.signal.aborted) {
        throw new CrossContextPurgeBarrierExpiredError();
      }
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (!this.purgeStarted) {
      this.terminal = true;
      this.operation.resolve(async () => {
        throw new Error('Cross-context purge barrier was aborted');
      });
    }
    this.abortController.abort();
    await this.exclusiveResult.catch(() => undefined);
  }

  private expire(): void {
    if (this.expired) {
      return;
    }
    this.expired = true;
    this.abortController.abort();
    if (!this.purgeStarted) {
      this.operation.resolve(async () => {
        throw new CrossContextPurgeBarrierExpiredError();
      });
    }
  }
}

const raceCrossContextOperationWithAbort = async <Value>(
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

const validateTeardownResponse = (
  response: CrossContextTeardownResponse,
  request: CrossContextTeardownRequest,
): void => {
  if (
    !Array.isArray(response.knownContextIds) ||
    !Array.isArray(response.acknowledgements) ||
    response.knownContextIds.length > MAX_KNOWN_BROWSER_CONTEXTS ||
    response.acknowledgements.length > MAX_KNOWN_BROWSER_CONTEXTS
  ) {
    throw new Error('Invalid cross-context teardown response');
  }
  const known = new Set<string>();
  for (const contextId of response.knownContextIds) {
    if (!CONTEXT_ID_PATTERN.test(contextId) || known.has(contextId)) {
      throw new Error('Invalid known browser context set');
    }
    known.add(contextId);
  }
  const acknowledged = new Set<string>();
  for (const acknowledgement of response.acknowledgements) {
    if (
      acknowledgement === null ||
      typeof acknowledgement !== 'object' ||
      acknowledgement.version !== 1 ||
      acknowledgement.requestId !== request.requestId ||
      acknowledgement.sessionBinding !== request.sessionBinding ||
      acknowledgement.decision !== request.decision ||
      acknowledgement.deadlineAt !== request.deadlineAt ||
      acknowledgement.state !== 'sealed-and-closed' ||
      !known.has(acknowledgement.contextId) ||
      acknowledged.has(acknowledgement.contextId)
    ) {
      throw new Error('Invalid browser-context teardown acknowledgement');
    }
    acknowledged.add(acknowledgement.contextId);
  }
  if (acknowledged.size !== known.size) {
    throw new Error('Not every known browser context acknowledged teardown');
  }
};

const createPurgeRequestUuid = (webCrypto: Crypto): string => {
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const assertLifecycleLockName = (name: string): void => {
  if (!LIFECYCLE_LOCK_NAME_PATTERN.test(name)) {
    throw new Error('Invalid offline database lifecycle lock name');
  }
};

export interface OfflineDatabaseOpenOptions {
  readonly databaseName: string;
  readonly databaseKey: Uint8Array<ArrayBuffer>;
  readonly encryption: 'required';
  readonly storage: SafariCompatibleOpfsConfiguration;
}

export interface OfflineDatabaseDeleteOptions {
  readonly databaseName: string;
  readonly storage: SafariCompatibleOpfsConfiguration;
}

export interface OfflineDatabaseConnection {
  close(signal: AbortSignal): Promise<void>;
}

export interface EncryptedSqliteConnection extends OfflineDatabaseConnection {
  readonly encryption: 'required';
  readonly storage: 'safari-opfs';
  execute(statement: string, parameters?: readonly unknown[]): Promise<void>;
  query<Row>(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<readonly Row[]>;
  transaction<Value>(
    operation: (connection: EncryptedSqliteConnection) => Promise<Value>,
  ): Promise<Value>;
}

export interface OfflineDatabaseAdapter {
  open(
    options: OfflineDatabaseOpenOptions,
    signal: AbortSignal,
  ): Promise<OfflineDatabaseConnection>;
  deleteLocalDatabase(
    options: OfflineDatabaseDeleteOptions,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface PowerSyncWebRuntimeBoundary {
  openEncryptedDatabase(
    options: {
      readonly databaseName: string;
      readonly encryptionKey: Uint8Array<ArrayBuffer>;
      readonly opfs: SafariCompatibleOpfsConfiguration;
    },
    signal: AbortSignal,
  ): Promise<EncryptedSqliteConnection>;
  connectEncryptedDatabase(
    options: {
      readonly databaseName: string;
      readonly connector: PowerSyncBackendConnector;
    },
    signal: AbortSignal,
  ): Promise<PowerSyncConnectionAttemptResult>;
  deleteEncryptedDatabase(
    options: {
      readonly databaseName: string;
      readonly opfs: SafariCompatibleOpfsConfiguration;
    },
    signal: AbortSignal,
  ): Promise<void>;
}

export interface PowerSyncConnectionAttemptResult {
  readonly state: 'background-started';
  /** Set only by a later live Sync Streams acceptance receipt, never by connect(). */
  readonly liveReplicationVerified: false;
}

export interface PowerSyncOpfsEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory';
}

export interface PowerSyncOpfsDirectory {
  removeEntry(
    name: string,
    options?: { readonly recursive?: boolean },
  ): Promise<void>;
  values(): AsyncIterable<PowerSyncOpfsEntry>;
}

export interface PowerSyncOpfsStorage {
  getDirectory(): Promise<PowerSyncOpfsDirectory>;
}

export interface PowerSyncTemporaryDirectoryLock {
  runIfAvailable(
    name: string,
    operation: () => Promise<void>,
  ): Promise<boolean>;
}

export interface PowerSyncWebSdkModule {
  readonly PowerSyncDatabase: new (
    options: WebPowerSyncDatabaseOptions,
  ) => CommonPowerSyncDatabase;
  readonly WASQLiteVFS: {
    readonly OPFSCoopSyncVFS: WASQLiteVFS;
  };
}

export interface PowerSyncBrowserRuntimeOptions {
  readonly schema: Schema;
  readonly sdkLoader?: () => Promise<PowerSyncWebSdkModule>;
  readonly opfsStorage?: PowerSyncOpfsStorage;
  readonly temporaryDirectoryLock?: PowerSyncTemporaryDirectoryLock;
  readonly workerFactory?: PowerSyncRuntimeWorkerFactory;
  readonly openTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
}

export interface PowerSyncRuntimeWorkerFactory {
  createDatabaseWorker(options: {
    readonly scriptUrl: string;
    readonly name: string;
  }): Worker;
  createSyncWorker(options: {
    readonly scriptUrl: string;
    readonly name: string;
  }): SharedWorker;
}

const POWERSYNC_DATABASE_FILE_SUFFIXES = Object.freeze([
  '',
  '-journal',
  '-wal',
] as const);
const POWERSYNC_TEMP_DIRECTORY_PATTERN = /^\.ahp-[a-z0-9]+$/iu;
const MAX_POWERSYNC_OPFS_ENTRIES = 512;
const DEFAULT_POWERSYNC_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_POWERSYNC_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_POWERSYNC_CLOSE_TIMEOUT_MS = 10_000;
const MIN_POWERSYNC_CONNECT_TIMEOUT_MS = 10;
const MAX_POWERSYNC_CONNECT_TIMEOUT_MS = 60_000;
const POWERSYNC_STATIC_WORKER_URL = '/@powersync/worker.js';

interface PowerSyncWorkerGeneration {
  readonly databaseWorkers: Set<Worker>;
  readonly syncWorkers: Set<SharedWorker>;
}

/**
 * Production @powersync/web 2.1.x runtime. The fixed public worker URL points
 * at the SDK's source-map-free static worker tree, preserving its relative
 * encrypted `mc-wa-sqlite` WASM URLs. It never depends on the optional
 * dynamically downloaded PowerSync core.
 */
export class PowerSyncBrowserRuntime implements PowerSyncWebRuntimeBoundary {
  private readonly sdkLoader: () => Promise<PowerSyncWebSdkModule>;
  private readonly opfsStorage: PowerSyncOpfsStorage;
  private readonly temporaryDirectoryLock: PowerSyncTemporaryDirectoryLock;
  private readonly workerFactory: PowerSyncRuntimeWorkerFactory;
  private readonly openTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly activeDatabases = new Map<string, CommonPowerSyncDatabase>();
  private readonly openingDatabases = new Set<string>();
  private readonly workerGenerations = new Map<
    string,
    PowerSyncWorkerGeneration
  >();

  constructor(private readonly options: PowerSyncBrowserRuntimeOptions) {
    this.sdkLoader = options.sdkLoader ?? defaultPowerSyncSdkLoader;
    this.opfsStorage = options.opfsStorage ?? browserOpfsStorage();
    this.temporaryDirectoryLock =
      options.temporaryDirectoryLock ?? browserTemporaryDirectoryLock();
    this.workerFactory =
      options.workerFactory ?? browserPowerSyncWorkerFactory();
    this.openTimeoutMs = parsePowerSyncLifecycleTimeout(
      options.openTimeoutMs,
      DEFAULT_POWERSYNC_OPEN_TIMEOUT_MS,
      'open',
    );
    this.connectTimeoutMs = parsePowerSyncConnectTimeout(
      options.connectTimeoutMs,
    );
    this.closeTimeoutMs = parsePowerSyncLifecycleTimeout(
      options.closeTimeoutMs,
      DEFAULT_POWERSYNC_CLOSE_TIMEOUT_MS,
      'close',
    );
  }

  async openEncryptedDatabase(
    options: {
      readonly databaseName: string;
      readonly encryptionKey: Uint8Array<ArrayBuffer>;
      readonly opfs: SafariCompatibleOpfsConfiguration;
    },
    signal: AbortSignal,
  ): Promise<EncryptedSqliteConnection> {
    assertDatabaseNameAndOpfs(options.databaseName, options.opfs);
    if (options.encryptionKey.byteLength !== 32) {
      throw new Error('PowerSync requires a 256-bit encrypted database key');
    }
    throwIfDatabaseRuntimeAborted(signal, 'open');
    if (
      this.activeDatabases.has(options.databaseName) ||
      this.openingDatabases.has(options.databaseName)
    ) {
      throw new Error('This encrypted PowerSync database is already active');
    }
    this.openingDatabases.add(options.databaseName);
    const workers: PowerSyncWorkerGeneration = {
      databaseWorkers: new Set(),
      syncWorkers: new Set(),
    };
    this.workerGenerations.set(options.databaseName, workers);
    let database: CommonPowerSyncDatabase | null = null;
    let safeToReleaseOpeningMarker = false;
    try {
      const openDeadlineAt = Date.now() + this.openTimeoutMs;
      const sdk = await runPowerSyncLifecycleOperation(
        this.sdkLoader(),
        signal,
        remainingPowerSyncLifecycleTime(openDeadlineAt),
        'open',
      );
      throwIfDatabaseRuntimeAborted(signal, 'open');
      if (sdk.WASQLiteVFS.OPFSCoopSyncVFS !== 'OPFSCoopSyncVFS') {
        throw new Error('Unsupported PowerSync OPFSCoopSyncVFS runtime');
      }
      database = new sdk.PowerSyncDatabase({
        schema: this.options.schema,
        sync: {
          worker: () => {
            const worker = this.workerFactory.createSyncWorker({
              scriptUrl: POWERSYNC_STATIC_WORKER_URL,
              name: `shared-powersync-${options.databaseName}`,
            });
            workers.syncWorkers.add(worker);
            return worker;
          },
        },
        database: {
          dbFilename: options.databaseName,
          vfs: sdk.WASQLiteVFS.OPFSCoopSyncVFS,
          useWebWorker: true,
          // The pinned SDK cannot authoritatively terminate its internally
          // transferred SharedWorker sync port after a Comlink fault. Its
          // supported tab-local mode still coordinates one sync loop through
          // BroadcastChannel + Web Locks, while EMDO owns cross-tab teardown.
          enableMultiTabs: false,
          encryptionKey: encodeDatabaseEncryptionKey(options.encryptionKey),
          worker: () => {
            const worker = this.workerFactory.createDatabaseWorker({
              scriptUrl: POWERSYNC_STATIC_WORKER_URL,
              name: `powersync-${options.databaseName}`,
            });
            workers.databaseWorkers.add(worker);
            return worker;
          },
        },
      });
      await runPowerSyncLifecycleOperation(
        database.init(),
        signal,
        remainingPowerSyncLifecycleTime(openDeadlineAt),
        'open',
      );
      if (signal.aborted) {
        throw new Error('Encrypted PowerSync database open was aborted');
      }
      const openedDatabase = database;
      this.activeDatabases.set(options.databaseName, openedDatabase);
      safeToReleaseOpeningMarker = true;
      return createPowerSyncEncryptedConnection(
        openedDatabase,
        signal,
        async (closeSignal) =>
          this.closeDatabase(options.databaseName, openedDatabase, closeSignal),
      );
    } catch (error) {
      if (database !== null && !database.closed) {
        void Promise.resolve()
          .then(() => database?.close({ disconnect: true }))
          .catch(() => undefined);
      }
      try {
        this.forceCloseWorkerGeneration(options.databaseName);
        this.workerGenerations.delete(options.databaseName);
        safeToReleaseOpeningMarker = true;
      } catch {
        throw new Error(
          'PowerSync database startup failed and worker shutdown was incomplete',
        );
      }
      throw error;
    } finally {
      if (safeToReleaseOpeningMarker) {
        this.openingDatabases.delete(options.databaseName);
      }
    }
  }

  async connectEncryptedDatabase(
    options: {
      readonly databaseName: string;
      readonly connector: PowerSyncBackendConnector;
    },
    signal: AbortSignal,
  ): Promise<PowerSyncConnectionAttemptResult> {
    if (!DATABASE_NAME_PATTERN.test(options.databaseName)) {
      throw new Error('Invalid PowerSync database name');
    }
    throwIfDatabaseRuntimeAborted(signal, 'connect');
    const database = this.activeDatabases.get(options.databaseName);
    if (database === undefined) {
      throw new Error(
        'Open the encrypted PowerSync database before connecting',
      );
    }
    await connectPowerSyncDatabase(
      database,
      options.connector,
      signal,
      this.connectTimeoutMs,
    );
    return Object.freeze({
      state: 'background-started' as const,
      liveReplicationVerified: false as const,
    });
  }

  async deleteEncryptedDatabase(
    options: {
      readonly databaseName: string;
      readonly opfs: SafariCompatibleOpfsConfiguration;
    },
    signal: AbortSignal,
  ): Promise<void> {
    assertDatabaseNameAndOpfs(options.databaseName, options.opfs);
    throwIfDatabaseRuntimeAborted(signal, 'deletion');
    if (
      this.activeDatabases.has(options.databaseName) ||
      this.openingDatabases.has(options.databaseName)
    ) {
      throw new Error('Cannot delete an active encrypted PowerSync database');
    }

    await Promise.resolve();
    const root = await this.opfsStorage.getDirectory();
    const failures: unknown[] = [];
    for (const suffix of POWERSYNC_DATABASE_FILE_SUFFIXES) {
      if (signal.aborted) {
        failures.push(new Error('Encrypted database deletion was aborted'));
        break;
      }
      try {
        await root.removeEntry(`${options.databaseName}${suffix}`);
      } catch (error) {
        if (!isMissingOpfsEntry(error)) {
          failures.push(error);
        }
      }
    }

    let inspectedEntries = 0;
    try {
      for await (const entry of root.values()) {
        inspectedEntries += 1;
        if (inspectedEntries > MAX_POWERSYNC_OPFS_ENTRIES) {
          throw new Error('PowerSync OPFS entry count exceeds safe bounds');
        }
        if (
          entry.kind !== 'directory' ||
          !POWERSYNC_TEMP_DIRECTORY_PATTERN.test(entry.name)
        ) {
          continue;
        }
        throwIfDatabaseRuntimeAborted(signal, 'deletion');
        const deleted = await this.temporaryDirectoryLock.runIfAvailable(
          entry.name,
          async () => root.removeEntry(entry.name, { recursive: true }),
        );
        if (!deleted) {
          failures.push(
            new Error('A PowerSync temporary OPFS directory is still active'),
          );
        }
      }
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new Error('PowerSync encrypted OPFS purge was incomplete');
    }
  }

  private async closeDatabase(
    databaseName: string,
    database: CommonPowerSyncDatabase,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.activeDatabases.get(databaseName) !== database) {
      return;
    }
    const active = database.close({ disconnect: true });
    void active.catch(() => undefined);
    let rejectForAbort = (): void => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectForAbort = () =>
        reject(new Error('Encrypted PowerSync database close was aborted'));
      signal.addEventListener('abort', rejectForAbort, { once: true });
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('Encrypted PowerSync database close timed out')),
        this.closeTimeoutMs,
      );
    });
    let closed = false;
    try {
      if (signal.aborted) {
        throw new Error('Encrypted PowerSync database close was aborted');
      }
      await Promise.race([active, aborted, timedOut]);
      closed = true;
    } catch {
      // PowerSync 2.1.x can leave Comlink calls pending forever after a worker
      // fault. This runtime owns the exact custom workers, so terminating the
      // dedicated database worker and closing our shared-worker port is the
      // bounded fail-closed escape hatch before releasing the lifecycle lease.
      this.forceCloseWorkerGeneration(databaseName);
      closed = true;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      signal.removeEventListener('abort', rejectForAbort);
    }
    if (closed) {
      this.activeDatabases.delete(databaseName);
      this.workerGenerations.delete(databaseName);
    }
  }

  private forceCloseWorkerGeneration(databaseName: string): void {
    const workers = this.workerGenerations.get(databaseName);
    if (workers === undefined) {
      return;
    }
    const failures: unknown[] = [];
    for (const worker of workers.databaseWorkers) {
      try {
        worker.terminate();
        workers.databaseWorkers.delete(worker);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const worker of workers.syncWorkers) {
      try {
        worker.port.close();
        workers.syncWorkers.delete(worker);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new Error('PowerSync worker termination was incomplete');
    }
  }
}

const defaultPowerSyncSdkLoader = async (): Promise<PowerSyncWebSdkModule> =>
  import('@powersync/web');

const parsePowerSyncConnectTimeout = (value: number | undefined): number => {
  return parsePowerSyncLifecycleTimeout(
    value,
    DEFAULT_POWERSYNC_CONNECT_TIMEOUT_MS,
    'connect',
  );
};

const parsePowerSyncLifecycleTimeout = (
  value: number | undefined,
  fallback: number,
  operation: 'open' | 'connect' | 'close',
): number => {
  const timeout = value ?? fallback;
  if (
    !Number.isInteger(timeout) ||
    timeout < MIN_POWERSYNC_CONNECT_TIMEOUT_MS ||
    timeout > MAX_POWERSYNC_CONNECT_TIMEOUT_MS
  ) {
    throw new Error(`PowerSync ${operation} timeout is invalid`);
  }
  return timeout;
};

const remainingPowerSyncLifecycleTime = (deadlineAt: number): number =>
  Math.max(0, deadlineAt - Date.now());

const runPowerSyncLifecycleOperation = async <Value>(
  active: Promise<Value>,
  signal: AbortSignal,
  timeoutMs: number,
  operation: 'open',
): Promise<Value> => {
  void active.catch(() => undefined);
  let rejectForAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectForAbort = () =>
      reject(
        new Error(`Encrypted PowerSync database ${operation} was aborted`),
      );
    signal.addEventListener('abort', rejectForAbort, { once: true });
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          new Error(`Encrypted PowerSync database ${operation} timed out`),
        ),
      timeoutMs,
    );
  });
  try {
    if (signal.aborted) {
      throw new Error(`Encrypted PowerSync database ${operation} was aborted`);
    }
    const value = await Promise.race([active, aborted, timedOut]);
    if (signal.aborted) {
      throw new Error(`Encrypted PowerSync database ${operation} was aborted`);
    }
    return value;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    signal.removeEventListener('abort', rejectForAbort);
  }
};

const connectPowerSyncDatabase = async (
  database: CommonPowerSyncDatabase,
  connector: PowerSyncBackendConnector,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> => {
  throwIfDatabaseRuntimeAborted(signal, 'connect');
  const active = database.connect(connector);
  void active.catch(() => undefined);
  let rejectForAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectForAbort = () =>
      reject(new Error('Encrypted PowerSync database connect was aborted'));
    signal.addEventListener('abort', rejectForAbort, { once: true });
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error('Encrypted PowerSync database connect timed out')),
      timeoutMs,
    );
  });
  try {
    await Promise.race([active, aborted, timedOut]);
    throwIfDatabaseRuntimeAborted(signal, 'connect');
  } catch (error) {
    // The SDK does not accept an AbortSignal for connect(). Ask it to stop now,
    // and also consume a late connection settlement so it cannot resurrect
    // replication after this authenticated composition has failed.
    void database.disconnect().catch(() => undefined);
    void active.then(() => database.disconnect()).catch(() => undefined);
    throw error;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    signal.removeEventListener('abort', rejectForAbort);
  }
};

const browserPowerSyncWorkerFactory = (): PowerSyncRuntimeWorkerFactory => {
  const factory: PowerSyncRuntimeWorkerFactory = {
    createDatabaseWorker: ({
      scriptUrl,
      name,
    }: {
      readonly scriptUrl: string;
      readonly name: string;
    }) => {
      if (typeof globalThis.Worker !== 'function') {
        throw new Error('Dedicated Worker support is required for PowerSync');
      }
      return new Worker(scriptUrl, { name, type: 'module' });
    },
    createSyncWorker: ({
      scriptUrl,
      name,
    }: {
      readonly scriptUrl: string;
      readonly name: string;
    }) => {
      if (typeof globalThis.SharedWorker !== 'function') {
        // The SDK invokes this only where its own platform checks enable
        // multi-tab sync; Safari/iOS retain the supported tab-local default.
        throw new Error('SharedWorker support is unavailable on this platform');
      }
      return new SharedWorker(scriptUrl, { name, type: 'module' });
    },
  };
  return Object.freeze(factory);
};

const browserOpfsStorage = (): PowerSyncOpfsStorage => {
  const storage = globalThis.navigator?.storage;
  if (storage === undefined || typeof storage.getDirectory !== 'function') {
    throw new Error('Browser OPFS storage is required for PowerSync');
  }
  return Object.freeze({
    getDirectory: async () =>
      (await storage.getDirectory()) as unknown as PowerSyncOpfsDirectory,
  });
};

const browserTemporaryDirectoryLock = (): PowerSyncTemporaryDirectoryLock => {
  const locks = globalThis.navigator?.locks;
  if (locks === undefined) {
    throw new Error('Browser Web Locks are required for PowerSync OPFS purge');
  }
  return Object.freeze({
    runIfAvailable: async (
      name: string,
      operation: () => Promise<void>,
    ): Promise<boolean> => {
      let acquired = false;
      await locks.request(
        name,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          if (lock === null) {
            return;
          }
          acquired = true;
          await operation();
        },
      );
      return acquired;
    },
  });
};

const encodeDatabaseEncryptionKey = (
  encryptionKey: Uint8Array<ArrayBuffer>,
): string =>
  [...encryptionKey].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const throwIfDatabaseRuntimeAborted = (
  signal: AbortSignal,
  operation: 'open' | 'connect' | 'close' | 'deletion',
): void => {
  if (signal.aborted) {
    throw new Error(`Encrypted PowerSync database ${operation} was aborted`);
  }
};

const isMissingOpfsEntry = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'NotFoundError';

type PowerSyncSqlExecutor = Pick<
  CommonPowerSyncDatabase | Transaction,
  'execute' | 'getAll'
>;

const createPowerSyncEncryptedConnection = (
  database: CommonPowerSyncDatabase,
  openingSignal: AbortSignal,
  closeDatabase: (signal: AbortSignal) => Promise<void>,
): EncryptedSqliteConnection => {
  let closePromise: Promise<void> | null = null;
  let closed = false;
  const requireOpen = (): void => {
    if (closed || database.closed || openingSignal.aborted) {
      throw new Error('The encrypted PowerSync connection is closed');
    }
  };
  const wrapExecutor = (
    executor: PowerSyncSqlExecutor,
    allowTransaction: boolean,
  ): EncryptedSqliteConnection => {
    const connection: EncryptedSqliteConnection = {
      encryption: 'required',
      storage: 'safari-opfs',
      close: async (signal) => {
        if (!allowTransaction) {
          throw new Error('A PowerSync transaction cannot close its database');
        }
        if (closed) {
          return;
        }
        const active = closePromise ?? closeDatabase(signal);
        closePromise = active;
        try {
          await active;
          closed = true;
        } finally {
          if (!closed && closePromise === active) {
            closePromise = null;
          }
        }
      },
      execute: async (statement, parameters = []) => {
        requireOpen();
        await executor.execute(statement, [...parameters]);
      },
      query: async <Row>(statement: string, parameters = []) => {
        requireOpen();
        return executor.getAll<Row>(statement, [...parameters]);
      },
      transaction: async <Value>(
        operation: (connection: EncryptedSqliteConnection) => Promise<Value>,
      ): Promise<Value> => {
        requireOpen();
        if (!allowTransaction) {
          return operation(connection);
        }
        return database.writeTransaction((transaction) =>
          operation(wrapExecutor(transaction, false)),
        );
      },
    };
    return Object.freeze(connection);
  };
  return wrapExecutor(database, true);
};

/**
 * Narrow adapter around the production `@powersync/web` runtime. Injection is
 * retained for deterministic CI. The runtime must finish consuming the leased
 * key before open resolves, and PowerSync remains read/replication storage—not
 * a canonical API writer.
 */
export class PowerSyncWebDatabaseAdapter implements OfflineDatabaseAdapter {
  constructor(private readonly runtime: PowerSyncWebRuntimeBoundary) {}

  async open(
    options: OfflineDatabaseOpenOptions,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<EncryptedSqliteConnection> {
    assertEncryptedOpfsOptions(options);
    if (signal.aborted) {
      throw new Error('Encrypted database open was aborted');
    }
    const leasedKey = new Uint8Array(options.databaseKey);
    try {
      const connection = await this.runtime.openEncryptedDatabase(
        {
          databaseName: options.databaseName,
          encryptionKey: leasedKey,
          opfs: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
        },
        signal,
      );
      assertEncryptedSqliteConnection(connection);
      return connection;
    } finally {
      leasedKey.fill(0);
    }
  }

  async deleteLocalDatabase(
    options: OfflineDatabaseDeleteOptions,
    signal: AbortSignal,
  ): Promise<void> {
    assertDatabaseNameAndOpfs(options.databaseName, options.storage);
    if (signal.aborted) {
      throw new Error('Encrypted database deletion was aborted');
    }
    await this.runtime.deleteEncryptedDatabase(
      {
        databaseName: options.databaseName,
        opfs: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
      },
      signal,
    );
  }
}

export interface DatabaseKeyProvider {
  readonly authenticatedSessionBinding?: string | null;
  getOrCreateDatabaseKey(
    signal?: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>>;
}

export interface DatabasePurgeResult {
  readonly complete: boolean;
  readonly failedSteps: readonly 'sqlite-opfs'[];
}

export interface DatabaseLogoutSealResult {
  readonly complete: boolean;
  readonly failedSteps: readonly (
    'close-connection' | 'shared-lifecycle-lock'
  )[];
}

const DEFAULT_DATABASE_NAME = 'emdo.sqlite3';
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const assertDatabaseNameAndOpfs = (
  databaseName: string,
  storage: SafariCompatibleOpfsConfiguration,
): void => {
  if (
    !DATABASE_NAME_PATTERN.test(databaseName) ||
    storage.storage !== 'opfs' ||
    !storage.safariCompatibilityMode ||
    storage.workerMode !== 'dedicated' ||
    storage.sharedArrayBufferRequired
  ) {
    throw new Error('Invalid Safari-compatible OPFS database options');
  }
};

const assertEncryptedOpfsOptions = (
  options: OfflineDatabaseOpenOptions,
): void => {
  assertDatabaseNameAndOpfs(options.databaseName, options.storage);
  if (
    options.encryption !== 'required' ||
    options.databaseKey.byteLength !== 32
  ) {
    throw new Error('PowerSync requires a 256-bit encrypted database key');
  }
};

const isEncryptedSqliteConnection = (
  connection: OfflineDatabaseConnection,
): connection is EncryptedSqliteConnection => {
  const candidate = connection as Partial<EncryptedSqliteConnection>;
  return (
    candidate.encryption === 'required' &&
    candidate.storage === 'safari-opfs' &&
    typeof candidate.execute === 'function' &&
    typeof candidate.query === 'function' &&
    typeof candidate.transaction === 'function'
  );
};

function assertEncryptedSqliteConnection(
  connection: OfflineDatabaseConnection,
): asserts connection is EncryptedSqliteConnection {
  if (!isEncryptedSqliteConnection(connection)) {
    throw new Error(
      'PowerSync must expose an opened encrypted local SQLite connection',
    );
  }
}

export class OfflineDatabaseController {
  private connection: OfflineDatabaseConnection | null = null;
  private sharedLifecycleLease: OfflineDatabaseSharedLease | null = null;
  private pendingOpen: Promise<void> | null = null;
  private pendingOpenAbortController: AbortController | null = null;
  private pendingClose: Promise<DatabaseLogoutSealResult> | null = null;
  private pendingLogoutSeal: Promise<DatabaseLogoutSealResult> | null = null;
  private completedLogoutSeal: DatabaseLogoutSealResult | null = null;
  private pendingPurge: Promise<DatabasePurgeResult> | null = null;
  private completedPurge: DatabasePurgeResult | null = null;
  private logoutSealed = false;
  private disposed = false;
  private readonly authenticatedSessionBinding: string | null;

  constructor(
    private readonly adapter: OfflineDatabaseAdapter,
    private readonly keyProvider: DatabaseKeyProvider,
    private readonly lifecycleLock: OfflineDatabaseLifecycleLock,
    private readonly databaseName = DEFAULT_DATABASE_NAME,
    authenticatedSessionBinding: string | null = null,
  ) {
    if (!DATABASE_NAME_PATTERN.test(databaseName)) {
      throw new Error('Invalid offline database name');
    }
    const explicitSessionBinding = authenticatedSessionBinding ?? null;
    const keyProviderSessionBinding =
      keyProvider.authenticatedSessionBinding ?? null;
    if (
      explicitSessionBinding !== null &&
      keyProviderSessionBinding !== null &&
      explicitSessionBinding !== keyProviderSessionBinding
    ) {
      throw new Error(
        'Offline database session binding mismatch with the key provider',
      );
    }
    this.authenticatedSessionBinding =
      explicitSessionBinding ?? keyProviderSessionBinding;
    if (
      this.authenticatedSessionBinding !== null &&
      !SESSION_BINDING_PATTERN.test(this.authenticatedSessionBinding)
    ) {
      throw new Error('Invalid offline database session binding');
    }
  }

  async open(
    callerSignal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    if (callerSignal.aborted) {
      throw new Error('The offline database open was aborted');
    }
    if (this.disposed) {
      throw new Error('The offline database controller is disposed');
    }
    if (this.logoutSealed) {
      throw new Error('The offline database controller is sealed for logout');
    }
    if (this.connection !== null) {
      return;
    }
    if (this.pendingOpen !== null) {
      return this.pendingOpen;
    }

    const openAbortController = new AbortController();
    const abortOpen = (): void => openAbortController.abort();
    callerSignal.addEventListener('abort', abortOpen, { once: true });
    const pending = this.openEncryptedDatabase(openAbortController.signal);
    this.pendingOpen = pending;
    this.pendingOpenAbortController = openAbortController;
    try {
      await pending;
    } finally {
      callerSignal.removeEventListener('abort', abortOpen);
      if (this.pendingOpen === pending) {
        this.pendingOpen = null;
      }
      if (this.pendingOpenAbortController === openAbortController) {
        this.pendingOpenAbortController = null;
      }
    }
  }

  async dispose(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<DatabaseLogoutSealResult> {
    this.disposed = true;
    this.pendingOpenAbortController?.abort();
    return this.closeConnectionAndReleaseLease(signal);
  }

  async sealAndCloseForLogout(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<DatabaseLogoutSealResult> {
    if (this.completedLogoutSeal !== null) {
      return this.completedLogoutSeal;
    }
    if (this.pendingLogoutSeal !== null) {
      return this.pendingLogoutSeal;
    }
    this.logoutSealed = true;
    this.pendingOpenAbortController?.abort();
    const pending = this.closeConnectionAndReleaseLease(signal);
    this.pendingLogoutSeal = pending;
    try {
      const result = await pending;
      if (result.complete) {
        this.completedLogoutSeal = result;
      }
      return result;
    } finally {
      if (this.pendingLogoutSeal === pending) {
        this.pendingLogoutSeal = null;
      }
    }
  }

  async purge(
    permit: OfflinePurgePermit,
    signal: AbortSignal,
  ): Promise<DatabasePurgeResult> {
    if (
      this.authenticatedSessionBinding === null ||
      permit.sessionBinding !== this.authenticatedSessionBinding
    ) {
      throw new Error('The database purge permit belongs to another session');
    }
    assertActiveOfflinePurgePermit(permit, this.lifecycleLock, 'database');
    if (!this.logoutSealed || this.completedLogoutSeal === null) {
      throw new Error('Close and seal the offline database before purging it');
    }
    if (this.connection !== null || this.sharedLifecycleLease !== null) {
      throw new Error(
        'The offline database still holds an active shared lease',
      );
    }
    if (this.completedPurge !== null) {
      return this.completedPurge;
    }
    if (this.pendingPurge !== null) {
      return this.pendingPurge;
    }
    const pending = registerOfflinePurgeOperation(
      permit,
      this.lifecycleLock,
      'database',
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

  getEncryptedSqliteConnection(): EncryptedSqliteConnection {
    const active = this.connection;
    if (
      this.logoutSealed ||
      this.disposed ||
      active === null ||
      !isEncryptedSqliteConnection(active)
    ) {
      throw new Error('An opened encrypted SQLite connection is required');
    }
    return active;
  }

  private async closeConnectionAndReleaseLease(
    signal: AbortSignal,
  ): Promise<DatabaseLogoutSealResult> {
    const active = this.pendingClose;
    if (active !== null) {
      return active;
    }
    const pending = this.performCloseConnectionAndReleaseLease(signal);
    this.pendingClose = pending;
    try {
      return await pending;
    } finally {
      if (this.pendingClose === pending) {
        this.pendingClose = null;
      }
    }
  }

  private async performCloseConnectionAndReleaseLease(
    signal: AbortSignal,
  ): Promise<DatabaseLogoutSealResult> {
    if (this.pendingOpen !== null) {
      try {
        await this.pendingOpen;
      } catch {
        // A failed open has no usable connection to retain.
      }
    }

    const failedSteps: Array<'close-connection' | 'shared-lifecycle-lock'> = [];
    const activeConnection = this.connection;

    if (activeConnection !== null) {
      try {
        if (signal.aborted) {
          throw new Error('Offline database close was aborted');
        }
        await activeConnection.close(signal);
        if (this.connection === activeConnection) {
          this.connection = null;
        }
      } catch {
        failedSteps.push('close-connection');
      }
    }

    if (this.connection === null && this.sharedLifecycleLease !== null) {
      const lease = this.sharedLifecycleLease;
      try {
        await lease.release();
        if (this.sharedLifecycleLease === lease) {
          this.sharedLifecycleLease = null;
        }
      } catch {
        failedSteps.push('shared-lifecycle-lock');
      }
    }

    return Object.freeze({
      complete: failedSteps.length === 0,
      failedSteps: Object.freeze([...failedSteps]),
    });
  }

  private async performPurge(
    signal: AbortSignal,
  ): Promise<DatabasePurgeResult> {
    const failedSteps: 'sqlite-opfs'[] = [];

    try {
      await this.adapter.deleteLocalDatabase(
        {
          databaseName: this.databaseName,
          storage: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
        },
        signal,
      );
    } catch {
      failedSteps.push('sqlite-opfs');
    }

    return Object.freeze({
      complete: failedSteps.length === 0,
      failedSteps: Object.freeze([...failedSteps]),
    });
  }

  private async openEncryptedDatabase(signal: AbortSignal): Promise<void> {
    const lifecycleLease =
      await this.lifecycleLock.acquireSharedOpenLease(signal);
    if (this.logoutSealed || this.disposed || signal.aborted) {
      await lifecycleLease.release();
      throw new Error(
        this.logoutSealed
          ? 'The offline database controller is sealed for logout'
          : this.disposed
            ? 'The offline database controller is disposed'
            : 'The offline database open was aborted',
      );
    }

    try {
      const databaseKey = await this.keyProvider.getOrCreateDatabaseKey(signal);
      if (databaseKey.byteLength !== 32) {
        databaseKey.fill(0);
        throw new Error('The offline database requires a 256-bit key');
      }

      let opened: OfflineDatabaseConnection;
      try {
        opened = await this.adapter.open(
          {
            databaseName: this.databaseName,
            databaseKey,
            encryption: 'required',
            storage: SAFARI_COMPATIBLE_OPFS_CONFIGURATION,
          },
          signal,
        );
      } finally {
        databaseKey.fill(0);
      }
      if (this.logoutSealed || this.disposed || signal.aborted) {
        await opened.close(new AbortController().signal);
        throw new Error(
          this.logoutSealed
            ? 'The offline database controller is sealed for logout'
            : this.disposed
              ? 'The offline database controller is disposed'
              : 'The offline database open was aborted',
        );
      }
      this.connection = opened;
      this.sharedLifecycleLease = lifecycleLease;
    } catch (error) {
      if (this.sharedLifecycleLease !== lifecycleLease) {
        try {
          await lifecycleLease.release();
        } catch {
          throw new Error('Unable to release a failed database open lease');
        }
      }
      throw error;
    }
  }
}

export class InMemoryOfflineDatabaseAdapter implements OfflineDatabaseAdapter {
  private databaseExists = false;
  private active = false;
  private capturedOpenOptions: OfflineDatabaseOpenOptions | null = null;

  get hasLocalDatabase(): boolean {
    return this.databaseExists;
  }

  get lastOpenOptions(): OfflineDatabaseOpenOptions | null {
    const captured = this.capturedOpenOptions;
    return captured === null
      ? null
      : {
          ...captured,
          databaseKey: new Uint8Array(captured.databaseKey),
        };
  }

  async open(
    options: OfflineDatabaseOpenOptions,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<OfflineDatabaseConnection> {
    if (signal.aborted) {
      throw new Error('The in-memory database open was aborted');
    }
    if (
      options.encryption !== 'required' ||
      options.databaseKey.length !== 32
    ) {
      throw new Error('The in-memory database requires a 256-bit key');
    }
    if (
      options.storage.storage !== 'opfs' ||
      !options.storage.safariCompatibilityMode
    ) {
      throw new Error('Safari-compatible OPFS configuration is required');
    }

    this.databaseExists = true;
    this.active = true;
    this.capturedOpenOptions = {
      ...options,
      databaseKey: new Uint8Array(options.databaseKey),
    };

    return {
      close: async () => {
        this.active = false;
      },
    };
  }

  async deleteLocalDatabase(
    options: OfflineDatabaseDeleteOptions,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      !DATABASE_NAME_PATTERN.test(options.databaseName) ||
      options.storage.storage !== 'opfs' ||
      !options.storage.safariCompatibilityMode
    ) {
      throw new Error('Invalid local database deletion request');
    }
    if (this.active) {
      throw new Error('Close the database before deleting it');
    }
    if (signal.aborted) {
      throw new Error('Local database deletion was aborted');
    }
    this.databaseExists = false;
    this.capturedOpenOptions?.databaseKey.fill(0);
  }
}

import {
  SyncOperationSchema,
  type JsonValue,
  type SyncOperation,
} from '@emdo/contracts/browser';
import type {
  CommonPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from '@powersync/web';
import { z } from 'zod';
import type { EncryptedSqliteConnection } from './database.js';

export type OfflineJsonValue = JsonValue;
export type OfflineSyncOperation = SyncOperation;

export type SyncAppliedResolution =
  'created' | 'applied' | 'merged' | 'ignored' | 'duplicate';

export interface SyncConflictDetail {
  readonly field: string;
  readonly material: boolean;
}

export type CanonicalSyncOperationOutcome =
  | {
      readonly operationId: string;
      readonly status: 'applied';
      readonly revision: number;
      readonly resolution: SyncAppliedResolution;
      readonly conflicts: readonly SyncConflictDetail[];
      readonly replayed: boolean;
    }
  | {
      readonly operationId: string;
      readonly status: 'conflict';
      readonly code: string;
      readonly disposition: 'terminal' | 'retryable';
      readonly currentRevision?: number;
      readonly conflicts: readonly SyncConflictDetail[];
      readonly replayed: boolean;
    }
  | {
      readonly operationId: string;
      readonly status: 'blocked';
      readonly code: string;
      readonly disposition: 'terminal' | 'retryable';
      readonly dependencyOperationId?: string;
      readonly conflicts: readonly SyncConflictDetail[];
      readonly replayed: false;
    };

export interface TerminalSyncConflict {
  readonly operationId: string;
  readonly status: 'conflict' | 'blocked';
  readonly code: string;
  readonly currentRevision?: number;
  readonly conflicts: readonly SyncConflictDetail[];
}

export interface RetryableSyncOperation {
  readonly operationId: string;
  readonly status: 'conflict' | 'blocked';
  readonly code: 'operation-in-progress' | 'dependency-missing';
}

export interface CanonicalSyncUploadRequest {
  readonly channel: 'api-canonical-write';
  readonly idempotencyKey: string;
  readonly operations: readonly OfflineSyncOperation[];
}

export interface CanonicalSyncUploadResponse {
  readonly results: readonly CanonicalSyncOperationOutcome[];
}

export interface CanonicalSyncApi {
  uploadOperations(
    request: CanonicalSyncUploadRequest,
    signal: AbortSignal,
  ): Promise<CanonicalSyncUploadResponse>;
}

export interface PendingOperationStore {
  enqueue(operation: OfflineSyncOperation): Promise<void>;
  listPendingOperations(
    limit?: number,
  ): Promise<readonly OfflineSyncOperation[]>;
  settleOutcomes(
    outcomes: readonly CanonicalSyncOperationOutcome[],
  ): Promise<void>;
  listTerminalConflicts(
    limit?: number,
  ): Promise<readonly TerminalSyncConflict[]>;
  dismissTerminalConflict(operationId: string): Promise<void>;
}

export type LocalSqliteConnection = EncryptedSqliteConnection;

export type LocalDomainProjectionMutation = (
  transaction: LocalSqliteConnection,
  operation: OfflineSyncOperation,
) => Promise<void>;

export interface AtomicPendingOperationStore extends PendingOperationStore {
  applyLocalMutation(
    operation: OfflineSyncOperation,
    mutateProjection: LocalDomainProjectionMutation,
  ): Promise<void>;
}

export interface SyncNowResult {
  readonly status: 'idle' | 'complete' | 'partial';
  readonly submittedCount: number;
  readonly acceptedOperationIds: readonly string[];
  readonly terminalConflicts: readonly TerminalSyncConflict[];
  readonly retryableOperations: readonly RetryableSyncOperation[];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_PENDING_OPERATIONS_PER_UPLOAD = 128;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_BYTES = 262_144;
const MAX_JSON_CONTAINER_ITEMS = 10_000;
const MAX_JSON_OBJECT_KEYS = 1_024;
const MAX_JSON_KEY_BYTES = 512;
const MAX_DURABLE_PENDING_OPERATIONS = 10_000;
const MAX_DURABLE_TERMINAL_CONFLICTS_PER_READ = 1_000;
const MAX_STORED_OPERATION_CHARACTERS = MAX_JSON_BYTES + 16_384;
const MAX_STORED_CONFLICT_DETAILS_CHARACTERS = 32_768;
const POWERSYNC_TOKEN_AUDIENCE = 'emdo-powersync';
const MAX_POWERSYNC_CREDENTIAL_RESPONSE_CHARACTERS = 65_536;
const MAX_POWERSYNC_ENDPOINT_CHARACTERS = 2_048;
const MAX_POWERSYNC_TOKEN_CHARACTERS = 32_768;
const MAX_POWERSYNC_CREDENTIAL_LIFETIME_MS = 10 * 60 * 1_000;
const DEFAULT_POWERSYNC_CREDENTIAL_TIMEOUT_MS = 10_000;
const DEFAULT_POWERSYNC_UPLOAD_TIMEOUT_MS = 30_000;
const MIN_POWERSYNC_OPERATION_TIMEOUT_MS = 10;
const MAX_POWERSYNC_OPERATION_TIMEOUT_MS = 60_000;

const SyncConflictDetailSchema = z.strictObject({
  field: z.string().trim().min(1).max(200),
  material: z.boolean(),
});

const SyncAppliedOutcomeSchema = z.strictObject({
  operationId: z.string().uuid(),
  status: z.literal('applied'),
  revision: z.number().int().positive().safe(),
  resolution: z.enum(['created', 'applied', 'merged', 'ignored', 'duplicate']),
  conflicts: z.array(z.never()).max(0),
  replayed: z.boolean(),
});

const TERMINAL_CONFLICT_CODES = [
  'entity-exists',
  'entity-not-found',
  'revision-mismatch',
  'tombstoned',
  'mutation-invalid',
  'repository-rejected',
  'domain-operation-invalid',
  'domain-operation-unsupported',
  'base-revision-unavailable',
  'base-state-mismatch',
  'material-conflict',
  'idempotency-key-reused',
] as const;
const TERMINAL_BLOCKED_CODES = [
  'authorization-revoked',
  'dependency-failed',
  'dependency-cycle',
] as const;

const SyncConflictOutcomeSchema = z
  .strictObject({
    operationId: z.string().uuid(),
    status: z.literal('conflict'),
    code: z.enum([...TERMINAL_CONFLICT_CODES, 'operation-in-progress']),
    disposition: z.enum(['terminal', 'retryable']),
    currentRevision: z.number().int().positive().safe().optional(),
    conflicts: z.array(SyncConflictDetailSchema).max(32),
    replayed: z.boolean(),
  })
  .superRefine((outcome, context) => {
    const expected =
      outcome.code === 'operation-in-progress' ? 'retryable' : 'terminal';
    if (outcome.disposition !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['disposition'],
        message: 'Sync conflict disposition does not match its outcome code',
      });
    }
    if (outcome.disposition === 'retryable' && outcome.conflicts.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['conflicts'],
        message: 'Retryable sync outcomes cannot contain material conflicts',
      });
    }
  });

const SyncBlockedOutcomeSchema = z
  .strictObject({
    operationId: z.string().uuid(),
    status: z.literal('blocked'),
    code: z.enum([...TERMINAL_BLOCKED_CODES, 'dependency-missing']),
    disposition: z.enum(['terminal', 'retryable']),
    dependencyOperationId: z.string().uuid().optional(),
    conflicts: z.array(z.never()).max(0),
    replayed: z.literal(false),
  })
  .superRefine((outcome, context) => {
    const expected =
      outcome.code === 'dependency-missing' ? 'retryable' : 'terminal';
    if (outcome.disposition !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['disposition'],
        message: 'Blocked sync disposition does not match its outcome code',
      });
    }
  });

const CanonicalSyncOperationOutcomeSchema = z.discriminatedUnion('status', [
  SyncAppliedOutcomeSchema,
  SyncConflictOutcomeSchema,
  SyncBlockedOutcomeSchema,
]);

const StoredTerminalConflictSchema = z.strictObject({
  operation_id: z.string().uuid(),
  outcome_status: z.enum(['conflict', 'blocked']),
  code: z.string().min(1).max(100),
  current_revision: z.number().int().positive().safe().nullable(),
  conflicts_json: z.string().max(MAX_STORED_CONFLICT_DETAILS_CHARACTERS),
});

const LOCAL_PROJECTION_TABLE_BY_ENTITY_TYPE = Object.freeze({
  'conversation.event': 'emdo_conversation_projection',
  'scheduler.item': 'emdo_scheduler_projection',
  'finance.transaction': 'emdo_finance_projection',
  'finance.budget': 'emdo_finance_projection',
  'shopping.item': 'emdo_shopping_projection',
} as const);

export interface ApiOwnedPowerSyncBackendConnectorOptions {
  readonly clientId: string;
  readonly sessionBinding: string;
  readonly expectedEndpoint?: string;
  readonly sync: ApiCanonicalSyncClient;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly credentialTimeoutMs?: number;
  readonly uploadTimeoutMs?: number;
}

/**
 * PowerSync may replicate canonical server rows, but every browser-originated
 * mutation remains in EMDO's validated API queue. The SDK CRUD queue is denied
 * rather than being translated into an unscoped database write.
 */
export class ApiOwnedPowerSyncBackendConnector implements PowerSyncBackendConnector {
  private readonly clientId: string;
  private readonly sessionBinding: string;
  private readonly sync: ApiCanonicalSyncClient;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly expectedEndpoint: string;
  private readonly credentialTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private operationController = new AbortController();
  private sealed = false;
  private disposed = false;

  constructor(options: ApiOwnedPowerSyncBackendConnectorOptions) {
    if (!UUID_PATTERN.test(options.clientId)) {
      throw new Error('A registered browser sync client is required');
    }
    if (!/^[a-f0-9]{64}$/u.test(options.sessionBinding)) {
      throw new Error('An authenticated session binding is required');
    }
    const fetcher = options.fetcher ?? globalThis.fetch;
    if (typeof fetcher !== 'function') {
      throw new Error('Browser fetch is required for PowerSync credentials');
    }
    this.clientId = options.clientId;
    this.sessionBinding = options.sessionBinding;
    this.sync = options.sync;
    this.fetcher = (input, init) => fetcher.call(globalThis, input, init);
    this.now = options.now ?? Date.now;
    this.expectedEndpoint = parsePowerSyncEndpoint(
      options.expectedEndpoint ?? defaultPowerSyncEndpoint(),
    );
    this.credentialTimeoutMs = parsePowerSyncOperationTimeout(
      options.credentialTimeoutMs,
      DEFAULT_POWERSYNC_CREDENTIAL_TIMEOUT_MS,
    );
    this.uploadTimeoutMs = parsePowerSyncOperationTimeout(
      options.uploadTimeoutMs,
      DEFAULT_POWERSYNC_UPLOAD_TIMEOUT_MS,
    );
  }

  readonly fetchCredentials =
    async (): Promise<PowerSyncCredentials | null> => {
      return this.runWithDeadline(
        'PowerSync credential request',
        this.credentialTimeoutMs,
        async (signal) => {
          const responsePromise = this.fetcher(
            `/api/v1/sync/token?clientId=${encodeURIComponent(this.clientId)}`,
            {
              method: 'GET',
              credentials: 'same-origin',
              cache: 'no-store',
              headers: { accept: 'application/json' },
              signal,
            },
          );
          void responsePromise
            .then(async (lateResponse) => {
              if (signal.aborted) {
                await lateResponse.body?.cancel().catch(() => undefined);
              }
            })
            .catch(() => undefined);
          const response = await responsePromise;
          throwIfConnectorSignalAborted(signal);
          if (response.status === 401 || response.status === 403) {
            await response.body?.cancel().catch(() => undefined);
            return null;
          }
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error('PowerSync credentials are unavailable');
          }
          const contentType = response.headers.get('content-type');
          if (
            contentType !== null &&
            !contentType.includes('application/json')
          ) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error('PowerSync credential response is not JSON');
          }
          const text = await readBoundedCredentialBody(response, signal);
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new Error('PowerSync credential response is invalid');
          }
          return parsePowerSyncCredentials(
            parsed,
            this.clientId,
            this.expectedEndpoint,
            this.now(),
          );
        },
      );
    };

  readonly uploadData = async (
    database: CommonPowerSyncDatabase,
  ): Promise<void> => {
    await this.runWithDeadline(
      'PowerSync canonical upload',
      this.uploadTimeoutMs,
      async (signal) => {
        const directCrudBatch = await database.getCrudBatch(1);
        throwIfConnectorSignalAborted(signal);
        if (directCrudBatch !== null) {
          throw new Error(
            'Direct PowerSync CRUD writes are forbidden; use the canonical API queue',
          );
        }
        await this.sync.syncNow(signal);
        throwIfConnectorSignalAborted(signal);
      },
    );
  };

  sealForLogout(): void {
    if (this.disposed || this.sealed) {
      return;
    }
    this.sealed = true;
    this.operationController.abort(
      new Error('The PowerSync backend connector is sealed for logout'),
    );
  }

  resumeAfterFailedLogout(): void {
    if (this.disposed || !this.sealed) {
      return;
    }
    this.sealed = false;
    this.operationController = new AbortController();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.sealed = true;
    this.operationController.abort(
      new Error('The PowerSync backend connector is disposed'),
    );
  }

  private requireActiveSignal(): AbortSignal {
    if (this.disposed) {
      throw new Error('The PowerSync backend connector is disposed');
    }
    if (this.sealed || this.operationController.signal.aborted) {
      throw new Error('The PowerSync backend connector is sealed for logout');
    }
    // Reading the binding here ensures every operation belongs to the exact
    // authenticated composition generation that created this connector.
    if (!/^[a-f0-9]{64}$/u.test(this.sessionBinding)) {
      throw new Error('The PowerSync session binding is invalid');
    }
    return this.operationController.signal;
  }

  private async runWithDeadline<Value>(
    label: string,
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<Value>,
  ): Promise<Value> {
    const sessionSignal = this.requireActiveSignal();
    const controller = new AbortController();
    const abortForSession = (): void =>
      controller.abort(
        sessionSignal.reason instanceof Error
          ? sessionSignal.reason
          : new Error(`${label} was aborted`),
      );
    sessionSignal.addEventListener('abort', abortForSession, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error(`${label} timed out`)),
      timeoutMs,
    );
    let rejectForAbort = (): void => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectForAbort = () =>
        reject(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error(`${label} was aborted`),
        );
      controller.signal.addEventListener('abort', rejectForAbort, {
        once: true,
      });
    });
    const active = Promise.resolve().then(() => operation(controller.signal));
    void active.catch(() => undefined);
    try {
      return await Promise.race([active, aborted]);
    } finally {
      clearTimeout(timeout);
      sessionSignal.removeEventListener('abort', abortForSession);
      controller.signal.removeEventListener('abort', rejectForAbort);
    }
  }
}

const parsePowerSyncCredentials = (
  value: unknown,
  expectedClientId: string,
  expectedEndpoint: string,
  now: number,
): PowerSyncCredentials => {
  if (value === null || typeof value !== 'object') {
    throw new Error('PowerSync credential response is invalid');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.endpoint !== 'string' ||
    record.endpoint.length === 0 ||
    record.endpoint.length > MAX_POWERSYNC_ENDPOINT_CHARACTERS ||
    typeof record.token !== 'string' ||
    record.token.length < 16 ||
    record.token.length > MAX_POWERSYNC_TOKEN_CHARACTERS ||
    typeof record.expiresAt !== 'string'
  ) {
    throw new Error('PowerSync credential response is invalid');
  }
  const endpoint = parsePowerSyncEndpoint(record.endpoint);
  if (endpoint !== expectedEndpoint) {
    throw new Error('PowerSync endpoint differs from the configured service');
  }
  const expiresAtMs = Date.parse(record.expiresAt);
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= now ||
    expiresAtMs - now > MAX_POWERSYNC_CREDENTIAL_LIFETIME_MS
  ) {
    throw new Error('PowerSync credentials have an invalid lifetime');
  }
  const claims = parsePowerSyncJwtClaims(record.token);
  if (
    claims.aud !== POWERSYNC_TOKEN_AUDIENCE ||
    claims.clientId !== expectedClientId
  ) {
    throw new Error(
      'PowerSync credential audience or client binding is invalid',
    );
  }
  if (
    typeof claims.exp !== 'number' ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp * 1_000 !== expiresAtMs
  ) {
    throw new Error('PowerSync credential expiry is inconsistent');
  }
  if (
    record.writeScope === null ||
    typeof record.writeScope !== 'object' ||
    (record.writeScope as Record<string, unknown>).clientId !== expectedClientId
  ) {
    throw new Error('PowerSync credential write scope is invalid');
  }
  return Object.freeze({
    endpoint,
    token: record.token,
    expiresAt: new Date(expiresAtMs),
  });
};

const parsePowerSyncEndpoint = (value: string): string => {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('PowerSync endpoint is invalid');
  }
  const loopback =
    endpoint.hostname === 'localhost' ||
    endpoint.hostname === '127.0.0.1' ||
    endpoint.hostname === '[::1]';
  if (
    (endpoint.protocol !== 'https:' &&
      !(loopback && endpoint.protocol === 'http:')) ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  ) {
    throw new Error('PowerSync endpoint must be a secure service URL');
  }
  return endpoint.toString().replace(/\/$/u, '');
};

const defaultPowerSyncEndpoint = (): string => {
  const location = globalThis.location;
  if (location === undefined || location.origin === 'null') {
    throw new Error('The configured browser PowerSync endpoint is unavailable');
  }
  return new URL('/powersync', location.origin).toString();
};

const parsePowerSyncOperationTimeout = (
  value: number | undefined,
  fallback: number,
): number => {
  const timeout = value ?? fallback;
  if (
    !Number.isInteger(timeout) ||
    timeout < MIN_POWERSYNC_OPERATION_TIMEOUT_MS ||
    timeout > MAX_POWERSYNC_OPERATION_TIMEOUT_MS
  ) {
    throw new Error('PowerSync operation timeout is invalid');
  }
  return timeout;
};

const throwIfConnectorSignalAborted = (signal: AbortSignal): void => {
  if (!signal.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('PowerSync connector operation was aborted');
};

const readBoundedCredentialBody = async (
  response: Response,
  signal: AbortSignal,
): Promise<string> => {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]{0,8})$/u.test(contentLength)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('PowerSync credential body length is invalid');
    }
    if (Number(contentLength) > MAX_POWERSYNC_CREDENTIAL_RESPONSE_CHARACTERS) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('PowerSync credential response exceeds safe bounds');
    }
  }
  const body = response.body;
  if (body === null) {
    throw new Error('PowerSync credential response is empty');
  }
  const reader = body.getReader();
  const cancelForAbort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', cancelForAbort, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let decoded = '';
  let totalBytes = 0;
  try {
    while (true) {
      throwIfConnectorSignalAborted(signal);
      const next = await reader.read();
      throwIfConnectorSignalAborted(signal);
      if (next.done) {
        break;
      }
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_POWERSYNC_CREDENTIAL_RESPONSE_CHARACTERS) {
        await reader.cancel().catch(() => undefined);
        throw new Error('PowerSync credential response exceeds safe bounds');
      }
      decoded += decoder.decode(next.value, { stream: true });
      if (decoded.length > MAX_POWERSYNC_CREDENTIAL_RESPONSE_CHARACTERS) {
        await reader.cancel().catch(() => undefined);
        throw new Error('PowerSync credential response exceeds safe bounds');
      }
    }
    decoded += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancelForAbort);
    reader.releaseLock();
  }
  if (totalBytes === 0 || decoded.length === 0) {
    throw new Error('PowerSync credential response is empty');
  }
  return decoded;
};

const parsePowerSyncJwtClaims = (
  token: string,
): {
  readonly aud: unknown;
  readonly clientId: unknown;
  readonly exp: unknown;
} => {
  const segments = token.split('.');
  if (
    segments.length !== 3 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.length > 16_384 ||
        !/^[A-Za-z0-9_-]+$/u.test(segment),
    )
  ) {
    throw new Error('PowerSync credential token is malformed');
  }
  const payload = segments[1];
  if (payload === undefined) {
    throw new Error('PowerSync credential token is malformed');
  }
  let decoded: unknown;
  try {
    const base64 = payload.replaceAll('-', '+').replaceAll('_', '/');
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(`${base64}${padding}`), (character) =>
      character.charCodeAt(0),
    );
    decoded = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('PowerSync credential token payload is malformed');
  }
  if (decoded === null || typeof decoded !== 'object') {
    throw new Error('PowerSync credential token claims are invalid');
  }
  const claims = decoded as Record<string, unknown>;
  return Object.freeze({
    aud: claims.aud,
    clientId: claims.clientId,
    exp: claims.exp,
  });
};

export class InMemoryPendingOperationStore implements PendingOperationStore {
  private readonly pending = new Map<string, OfflineSyncOperation>();
  private readonly terminalConflicts = new Map<string, TerminalSyncConflict>();

  async enqueue(operation: OfflineSyncOperation): Promise<void> {
    const snapshot = snapshotOperation(operation);
    const existing = this.pending.get(snapshot.operationId);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(snapshot)) {
        throw new Error(
          'Operation ID is already queued with different content',
        );
      }
      return;
    }
    this.pending.set(snapshot.operationId, snapshot);
  }

  async listPendingOperations(
    limit = MAX_DURABLE_PENDING_OPERATIONS,
  ): Promise<readonly OfflineSyncOperation[]> {
    assertPendingReadLimit(limit);
    return Object.freeze(
      [...this.pending.values()]
        .slice(0, limit)
        .map((operation) => snapshotOperation(operation)),
    );
  }

  async settleOutcomes(
    outcomes: readonly CanonicalSyncOperationOutcome[],
  ): Promise<void> {
    for (const outcome of outcomes) {
      if (outcome.status !== 'applied' && outcome.disposition === 'retryable') {
        continue;
      }
      if (
        outcome.status !== 'applied' &&
        this.pending.has(outcome.operationId)
      ) {
        this.terminalConflicts.set(
          outcome.operationId,
          terminalConflictFromOutcome(outcome),
        );
      }
      this.pending.delete(outcome.operationId);
    }
  }

  async listTerminalConflicts(
    limit = MAX_DURABLE_TERMINAL_CONFLICTS_PER_READ,
  ): Promise<readonly TerminalSyncConflict[]> {
    assertTerminalConflictReadLimit(limit);
    return Object.freeze(
      [...this.terminalConflicts.values()]
        .slice(0, limit)
        .map((conflict) => freezeTerminalConflict(conflict)),
    );
  }

  async dismissTerminalConflict(operationId: string): Promise<void> {
    if (!UUID_PATTERN.test(operationId)) {
      throw new Error('Invalid terminal conflict identity');
    }
    this.terminalConflicts.delete(operationId);
  }
}

interface PendingOperationRow {
  readonly operation_id: string;
  readonly canonical_hash: string;
  readonly canonical_payload: string;
}

interface StoredTerminalConflictRow {
  readonly operation_id: string;
  readonly outcome_status: string;
  readonly code: string;
  readonly current_revision: number | null;
  readonly conflicts_json: string;
}

const PENDING_OPERATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS emdo_pending_sync_operations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  canonical_hash TEXT NOT NULL,
  canonical_payload TEXT NOT NULL
)`;

const TERMINAL_CONFLICT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS emdo_terminal_sync_conflicts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  outcome_status TEXT NOT NULL CHECK (outcome_status IN ('conflict', 'blocked')),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 100),
  current_revision INTEGER CHECK (current_revision IS NULL OR current_revision > 0),
  conflicts_json TEXT NOT NULL CHECK (length(conflicts_json) <= ${MAX_STORED_CONFLICT_DETAILS_CHARACTERS})
)`;

/**
 * Durable queue for a PowerSync-managed encrypted SQLite connection. An
 * operation ID is replayable only with its exact canonical payload.
 */
export class EncryptedSqlitePendingOperationStore implements AtomicPendingOperationStore {
  private schemaReady: Promise<void> | null = null;

  constructor(
    private readonly connection: LocalSqliteConnection,
    private readonly webCrypto: Crypto = globalThis.crypto,
  ) {
    if (webCrypto === undefined) {
      throw new Error('WebCrypto is required for pending-operation binding');
    }
    if (
      connection.encryption !== 'required' ||
      connection.storage !== 'safari-opfs'
    ) {
      throw new Error(
        'Pending operations require encrypted Safari-compatible OPFS SQLite',
      );
    }
  }

  async enqueue(operation: OfflineSyncOperation): Promise<void> {
    await this.persistOperation(operation);
  }

  /**
   * Creates the durable queue before application code performs direct local
   * readiness queries against the shared encrypted database.
   */
  async initialize(): Promise<void> {
    await this.ensureSchema();
  }

  async applyLocalMutation(
    operation: OfflineSyncOperation,
    mutateProjection: LocalDomainProjectionMutation,
  ): Promise<void> {
    if (typeof mutateProjection !== 'function') {
      throw new Error('A local domain projection mutation is required');
    }
    await this.persistOperation(operation, mutateProjection);
  }

  private async persistOperation(
    operation: OfflineSyncOperation,
    mutateProjection?: LocalDomainProjectionMutation,
  ): Promise<void> {
    const snapshot = snapshotOperation(operation);
    const canonicalPayload = canonicalJson(snapshot);
    const canonicalHash = await sha256Hex(canonicalPayload, this.webCrypto);
    await this.ensureSchema();

    await this.connection.transaction(async (transaction) => {
      const existing = await transaction.query<PendingOperationRow>(
        `SELECT operation_id, canonical_hash, canonical_payload
         FROM emdo_pending_sync_operations
         WHERE operation_id = ?`,
        [snapshot.operationId],
      );
      if (existing.length > 1) {
        throw new Error('Pending operation identity is not unique');
      }
      const record = existing[0];
      if (record !== undefined) {
        if (
          record.canonical_hash !== canonicalHash ||
          record.canonical_payload !== canonicalPayload
        ) {
          throw new Error(
            'Operation ID is already bound to a different canonical payload',
          );
        }
        return;
      }

      if (mutateProjection !== undefined) {
        await mutateProjection(transaction, snapshot);
      }

      await transaction.execute(
        `INSERT INTO emdo_pending_sync_operations
           (operation_id, canonical_hash, canonical_payload)
         VALUES (?, ?, ?)`,
        [snapshot.operationId, canonicalHash, canonicalPayload],
      );
    });
  }

  async listPendingOperations(
    limit = MAX_DURABLE_PENDING_OPERATIONS,
  ): Promise<readonly OfflineSyncOperation[]> {
    assertPendingReadLimit(limit);
    await this.ensureSchema();
    const rows = await this.connection.query<PendingOperationRow>(
      `SELECT operation_id, canonical_hash, canonical_payload
       FROM emdo_pending_sync_operations
       ORDER BY sequence ASC
       LIMIT ?`,
      [limit],
    );
    if (rows.length > limit) {
      throw new Error('Encrypted SQLite returned too many pending operations');
    }

    const operations: OfflineSyncOperation[] = [];
    for (const row of rows) {
      if (
        !UUID_PATTERN.test(row.operation_id) ||
        !/^[a-f0-9]{64}$/u.test(row.canonical_hash) ||
        row.canonical_payload.length > MAX_STORED_OPERATION_CHARACTERS
      ) {
        throw new Error('Invalid encrypted pending-operation record');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.canonical_payload);
      } catch {
        throw new Error('Invalid encrypted pending-operation payload');
      }
      const snapshot = snapshotOperation(parsed as OfflineSyncOperation);
      const canonicalPayload = canonicalJson(snapshot);
      const canonicalHash = await sha256Hex(canonicalPayload, this.webCrypto);
      if (
        snapshot.operationId !== row.operation_id ||
        canonicalPayload !== row.canonical_payload ||
        canonicalHash !== row.canonical_hash
      ) {
        throw new Error(
          'Pending operation canonical binding verification failed',
        );
      }
      operations.push(snapshot);
    }
    return Object.freeze(operations);
  }

  async settleOutcomes(
    outcomes: readonly CanonicalSyncOperationOutcome[],
  ): Promise<void> {
    if (outcomes.length > MAX_PENDING_OPERATIONS_PER_UPLOAD) {
      throw new Error('Too many sync outcomes to settle');
    }
    await this.ensureSchema();
    await this.connection.transaction(async (transaction) => {
      for (const outcome of outcomes) {
        if (
          outcome.status !== 'applied' &&
          outcome.disposition === 'retryable'
        ) {
          continue;
        }
        if (outcome.status !== 'applied') {
          const pendingRows = await transaction.query<PendingOperationRow>(
            `SELECT operation_id, canonical_hash, canonical_payload
               FROM emdo_pending_sync_operations
              WHERE operation_id = ?`,
            [outcome.operationId],
          );
          if (pendingRows.length > 1) {
            throw new Error('Pending operation identity is not unique');
          }
          const pending = pendingRows[0];
          // Another browser context may already have atomically settled and
          // dismissed this exact operation. Never recreate a reviewed notice.
          if (pending === undefined) continue;
          const operation = await verifyPendingOperationRow(
            pending,
            this.webCrypto,
          );
          const terminalConflict = terminalConflictFromOutcome(outcome);
          await persistTerminalConflict(transaction, terminalConflict);
          const projectionTable =
            LOCAL_PROJECTION_TABLE_BY_ENTITY_TYPE[
              operation.entity
                .type as keyof typeof LOCAL_PROJECTION_TABLE_BY_ENTITY_TYPE
            ];
          if (projectionTable !== undefined) {
            await transaction.execute(
              `DELETE FROM ${projectionTable}
                WHERE last_operation_id = ?`,
              [outcome.operationId],
            );
          }
        }
        await transaction.execute(
          `DELETE FROM emdo_pending_sync_operations
           WHERE operation_id = ?`,
          [outcome.operationId],
        );
      }
    });
  }

  async listTerminalConflicts(
    limit = MAX_DURABLE_TERMINAL_CONFLICTS_PER_READ,
  ): Promise<readonly TerminalSyncConflict[]> {
    assertTerminalConflictReadLimit(limit);
    await this.ensureSchema();
    const rows = await this.connection.query<StoredTerminalConflictRow>(
      `SELECT operation_id, outcome_status, code, current_revision, conflicts_json
         FROM emdo_terminal_sync_conflicts
        ORDER BY sequence ASC
        LIMIT ?`,
      [limit],
    );
    if (rows.length > limit) {
      throw new Error('Encrypted SQLite returned too many terminal conflicts');
    }
    return Object.freeze(rows.map(parseStoredTerminalConflict));
  }

  async dismissTerminalConflict(operationId: string): Promise<void> {
    if (!UUID_PATTERN.test(operationId)) {
      throw new Error('Invalid terminal conflict identity');
    }
    await this.ensureSchema();
    await this.connection.execute(
      `DELETE FROM emdo_terminal_sync_conflicts
        WHERE operation_id = ?`,
      [operationId],
    );
  }

  private async ensureSchema(): Promise<void> {
    const active = this.schemaReady;
    if (active !== null) {
      return active;
    }
    const pending = (async () => {
      await this.connection.execute(PENDING_OPERATION_SCHEMA_SQL);
      await this.connection.execute(TERMINAL_CONFLICT_SCHEMA_SQL);
    })();
    this.schemaReady = pending;
    try {
      await pending;
    } catch (error) {
      if (this.schemaReady === pending) {
        this.schemaReady = null;
      }
      throw error;
    }
  }
}

const verifyPendingOperationRow = async (
  row: PendingOperationRow,
  webCrypto: Crypto,
): Promise<OfflineSyncOperation> => {
  if (
    !UUID_PATTERN.test(row.operation_id) ||
    !/^[a-f0-9]{64}$/u.test(row.canonical_hash) ||
    row.canonical_payload.length > MAX_STORED_OPERATION_CHARACTERS
  ) {
    throw new Error('Invalid encrypted pending-operation record');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.canonical_payload);
  } catch {
    throw new Error('Invalid encrypted pending-operation payload');
  }
  const snapshot = snapshotOperation(parsed as OfflineSyncOperation);
  const canonicalPayload = canonicalJson(snapshot);
  const canonicalHash = await sha256Hex(canonicalPayload, webCrypto);
  if (
    snapshot.operationId !== row.operation_id ||
    canonicalPayload !== row.canonical_payload ||
    canonicalHash !== row.canonical_hash
  ) {
    throw new Error('Pending operation canonical binding verification failed');
  }
  return snapshot;
};

const terminalConflictFromOutcome = (
  outcome: Exclude<
    CanonicalSyncOperationOutcome,
    { readonly status: 'applied' }
  >,
): TerminalSyncConflict =>
  freezeTerminalConflict({
    operationId: outcome.operationId,
    status: outcome.status,
    code: outcome.code,
    ...(outcome.status === 'conflict' && outcome.currentRevision !== undefined
      ? { currentRevision: outcome.currentRevision }
      : {}),
    conflicts: outcome.conflicts,
  });

const freezeTerminalConflict = (
  conflict: TerminalSyncConflict,
): TerminalSyncConflict =>
  Object.freeze({
    ...conflict,
    conflicts: Object.freeze(
      conflict.conflicts.map((detail) => Object.freeze({ ...detail })),
    ),
  });

const terminalConflictPayload = (conflict: TerminalSyncConflict): string =>
  JSON.stringify(conflict.conflicts);

const parseStoredTerminalConflict = (
  raw: StoredTerminalConflictRow,
): TerminalSyncConflict => {
  const row = StoredTerminalConflictSchema.safeParse(raw);
  if (!row.success) {
    throw new Error('Invalid encrypted terminal-conflict record');
  }
  let details: unknown;
  try {
    details = JSON.parse(row.data.conflicts_json);
  } catch {
    throw new Error('Invalid encrypted terminal-conflict details');
  }
  const parsedDetails = z
    .array(SyncConflictDetailSchema)
    .max(32)
    .safeParse(details);
  if (!parsedDetails.success) {
    throw new Error('Invalid encrypted terminal-conflict details');
  }
  return freezeTerminalConflict({
    operationId: row.data.operation_id,
    status: row.data.outcome_status,
    code: row.data.code,
    ...(row.data.current_revision === null
      ? {}
      : { currentRevision: row.data.current_revision }),
    conflicts: parsedDetails.data,
  });
};

const persistTerminalConflict = async (
  transaction: LocalSqliteConnection,
  conflict: TerminalSyncConflict,
): Promise<void> => {
  const existingRows = await transaction.query<StoredTerminalConflictRow>(
    `SELECT operation_id, outcome_status, code, current_revision, conflicts_json
       FROM emdo_terminal_sync_conflicts
      WHERE operation_id = ?`,
    [conflict.operationId],
  );
  if (existingRows.length > 1) {
    throw new Error('Terminal conflict identity is not unique');
  }
  const existing = existingRows[0];
  if (existing !== undefined) {
    const parsed = parseStoredTerminalConflict(existing);
    if (JSON.stringify(parsed) !== JSON.stringify(conflict)) {
      throw new Error(
        'Terminal conflict identity is bound to different content',
      );
    }
    return;
  }
  await transaction.execute(
    `INSERT INTO emdo_terminal_sync_conflicts
       (operation_id, outcome_status, code, current_revision, conflicts_json)
     VALUES (?, ?, ?, ?, ?)`,
    [
      conflict.operationId,
      conflict.status,
      conflict.code,
      conflict.currentRevision ?? null,
      terminalConflictPayload(conflict),
    ],
  );
};

const isAtomicPendingOperationStore = (
  store: PendingOperationStore,
): store is AtomicPendingOperationStore =>
  typeof (store as Partial<AtomicPendingOperationStore>).applyLocalMutation ===
  'function';

export class ApiCanonicalSyncClient {
  private pendingSync: Promise<SyncNowResult> | null = null;
  private logoutSealed = false;
  private syncSealed = false;
  private readonly activeEnqueues = new Set<Promise<void>>();
  private readonly snapshotInvalidationListeners = new Set<() => void>();

  constructor(
    private readonly store: PendingOperationStore,
    private readonly api: CanonicalSyncApi,
    private readonly webCrypto: Crypto = globalThis.crypto,
  ) {
    if (webCrypto === undefined) {
      throw new Error('WebCrypto is required for sync idempotency');
    }
  }

  async queueLocalOperation(operation: OfflineSyncOperation): Promise<void> {
    if (this.logoutSealed) {
      throw new Error('Local edits are paused during logout');
    }

    return this.trackLocalWrite(
      this.store.enqueue(snapshotOperation(operation)),
    );
  }

  async applyLocalMutation(
    operation: OfflineSyncOperation,
    mutateProjection: LocalDomainProjectionMutation,
  ): Promise<void> {
    if (this.logoutSealed) {
      throw new Error('Local edits are paused during logout');
    }
    if (!isAtomicPendingOperationStore(this.store)) {
      throw new Error(
        'Atomic local domain mutations require encrypted SQLite storage',
      );
    }
    return this.trackLocalWrite(
      this.store.applyLocalMutation(
        snapshotOperation(operation),
        mutateProjection,
      ),
    );
  }

  private async trackLocalWrite(localWrite: Promise<void>): Promise<void> {
    this.activeEnqueues.add(localWrite);
    try {
      await localWrite;
    } finally {
      this.activeEnqueues.delete(localWrite);
    }
  }

  async sealForLogout(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    throwIfSyncOperationAborted(signal);
    this.logoutSealed = true;
    this.syncSealed = true;
    await raceSyncOperationWithAbort(
      Promise.all([...this.activeEnqueues]),
      signal,
    );
    if (this.pendingSync !== null) {
      await raceSyncOperationWithAbort(this.pendingSync, signal);
    }
  }

  resumeAfterFailedLogout(): void {
    this.logoutSealed = false;
    this.syncSealed = false;
  }

  async hasPendingOperations(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<boolean> {
    throwIfSyncOperationAborted(signal);
    const pending = await raceSyncOperationWithAbort(
      this.store.listPendingOperations(1),
      signal,
    );
    return pending.length > 0;
  }

  async listTerminalConflicts(): Promise<readonly TerminalSyncConflict[]> {
    return this.store.listTerminalConflicts();
  }

  subscribeSnapshotInvalidation(listener: () => void): () => void {
    this.snapshotInvalidationListeners.add(listener);
    return () => this.snapshotInvalidationListeners.delete(listener);
  }

  async dismissTerminalConflict(operationId: string): Promise<void> {
    if (this.logoutSealed) {
      throw new Error('Conflict review is paused during logout');
    }
    await this.trackLocalWrite(this.store.dismissTerminalConflict(operationId));
    this.invalidateSnapshots();
  }

  async syncNow(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SyncNowResult> {
    if (this.syncSealed) {
      throw new Error('Canonical sync is paused during logout');
    }
    return this.runSync(signal);
  }

  async syncNowForLogout(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SyncNowResult> {
    if (!this.syncSealed) {
      throw new Error('Logout sync requires a sealed local-write boundary');
    }
    return this.runSync(signal);
  }

  private async runSync(signal: AbortSignal): Promise<SyncNowResult> {
    throwIfSyncOperationAborted(signal);
    const active = this.pendingSync;
    if (active !== null) {
      return raceSyncOperationWithAbort(active, signal);
    }

    const pending = this.performSync(signal);
    this.pendingSync = pending;
    try {
      return await pending;
    } finally {
      if (this.pendingSync === pending) {
        this.pendingSync = null;
      }
    }
  }

  private async performSync(signal: AbortSignal): Promise<SyncNowResult> {
    const pending = await raceSyncOperationWithAbort(
      this.store.listPendingOperations(MAX_PENDING_OPERATIONS_PER_UPLOAD),
      signal,
    );
    if (pending.length === 0) {
      return freezeSyncResult({
        status: 'idle',
        submittedCount: 0,
        acceptedOperationIds: [],
        terminalConflicts: [],
        retryableOperations: [],
      });
    }

    const operations = Object.freeze(
      pending.map((operation) => snapshotOperation(operation)),
    );
    const response = await raceSyncOperationWithAbort(
      this.api.uploadOperations(
        Object.freeze({
          channel: 'api-canonical-write' as const,
          idempotencyKey: await this.createIdempotencyKey(operations),
          operations,
        }),
        signal,
      ),
      signal,
    );
    throwIfSyncOperationAborted(signal);
    const validated = validateUploadResponse(response, operations);
    await this.store.settleOutcomes(validated);
    this.invalidateSnapshots();
    const acceptedOperationIds = validated.flatMap((outcome) =>
      outcome.status === 'applied' ? [outcome.operationId] : [],
    );
    const terminalConflicts = validated.flatMap((outcome) =>
      outcome.status !== 'applied' && outcome.disposition === 'terminal'
        ? [terminalConflictFromOutcome(outcome)]
        : [],
    );
    const retryableOperations = validated.flatMap<RetryableSyncOperation>(
      (outcome) =>
        outcome.status !== 'applied' && outcome.disposition === 'retryable'
          ? [
              Object.freeze({
                operationId: outcome.operationId,
                status: outcome.status,
                code: outcome.code,
              }) as RetryableSyncOperation,
            ]
          : [],
    );

    return freezeSyncResult({
      status: retryableOperations.length === 0 ? 'complete' : 'partial',
      submittedCount: operations.length,
      acceptedOperationIds,
      terminalConflicts,
      retryableOperations,
    });
  }

  private async createIdempotencyKey(
    operations: readonly OfflineSyncOperation[],
  ): Promise<string> {
    const identity = operations
      .map((operation) => canonicalJson(operation))
      .join('\n');
    return `sync.v1.${await sha256Hex(identity, this.webCrypto)}`;
  }

  private invalidateSnapshots(): void {
    for (const listener of this.snapshotInvalidationListeners) {
      try {
        listener();
      } catch {
        // A view listener cannot change the durable settlement outcome.
      }
    }
  }
}

const throwIfSyncOperationAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new Error('Canonical sync operation was aborted');
  }
};

const raceSyncOperationWithAbort = async <Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> => {
  throwIfSyncOperationAborted(signal);
  let abort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Canonical sync operation was aborted'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
};

const assertPendingReadLimit = (limit: number): void => {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_DURABLE_PENDING_OPERATIONS
  ) {
    throw new Error('Invalid pending-operation read limit');
  }
};

const assertTerminalConflictReadLimit = (limit: number): void => {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_DURABLE_TERMINAL_CONFLICTS_PER_READ
  ) {
    throw new Error('Invalid terminal-conflict read limit');
  }
};

const sha256Hex = async (value: string, webCrypto: Crypto): Promise<string> => {
  const digest = new Uint8Array(
    await webCrypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const validateUploadResponse = (
  response: CanonicalSyncUploadResponse,
  submitted: readonly OfflineSyncOperation[],
): readonly CanonicalSyncOperationOutcome[] => {
  const submittedIds = new Set(
    submitted.map((operation) => operation.operationId),
  );
  if (
    response === null ||
    typeof response !== 'object' ||
    !Array.isArray((response as { readonly results?: unknown }).results) ||
    response.results.length !== submitted.length
  ) {
    throw new Error('Canonical sync API returned invalid operation outcomes');
  }
  const seen = new Set<string>();
  const outcomes: CanonicalSyncOperationOutcome[] = [];
  for (const raw of response.results) {
    const parsed = CanonicalSyncOperationOutcomeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error('Canonical sync API returned an invalid outcome');
    }
    const outcome = parsed.data as CanonicalSyncOperationOutcome;
    if (
      !submittedIds.has(outcome.operationId) ||
      seen.has(outcome.operationId)
    ) {
      throw new Error('Canonical sync API returned an invalid operation ID');
    }
    seen.add(outcome.operationId);
    outcomes.push(freezeCanonicalOutcome(outcome));
  }
  if (seen.size !== submittedIds.size) {
    throw new Error('Canonical sync API omitted an operation result');
  }
  return Object.freeze(outcomes);
};

const freezeCanonicalOutcome = (
  outcome: CanonicalSyncOperationOutcome,
): CanonicalSyncOperationOutcome =>
  Object.freeze({
    ...outcome,
    conflicts: Object.freeze(
      outcome.conflicts.map((detail) => Object.freeze({ ...detail })),
    ),
  }) as CanonicalSyncOperationOutcome;

const snapshotOperation = (
  operation: OfflineSyncOperation,
): OfflineSyncOperation => {
  const payload = cloneBoundedJsonValue(operation.mutation.payload);
  const parsed = SyncOperationSchema.parse({
    ...operation,
    mutation: {
      ...operation.mutation,
      kind: operation.mutation.kind,
      payload,
    },
  });
  return Object.freeze({
    ...parsed,
    entity: Object.freeze({ ...parsed.entity }),
    mutation: Object.freeze({
      ...parsed.mutation,
      payload: freezeJsonSnapshot(
        parsed.mutation.payload as unknown as OfflineJsonValue,
      ),
    }),
    dependencies: Object.freeze([...parsed.dependencies]),
  });
};

const freezeJsonSnapshot = (value: OfflineJsonValue): OfflineJsonValue => {
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((nested) => freezeJsonSnapshot(nested as OfflineJsonValue)),
    ) as unknown as OfflineJsonValue;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      Object.defineProperty(value, key, {
        value: freezeJsonSnapshot(value[key] ?? null),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(value);
  }
  return value;
};

interface JsonSnapshotBudget {
  nodes: number;
  bytes: number;
  readonly ancestors: WeakSet<object>;
}

const cloneBoundedJsonValue = (value: unknown): OfflineJsonValue =>
  cloneJsonNode(
    value,
    { nodes: 0, bytes: 0, ancestors: new WeakSet<object>() },
    0,
  );

const cloneJsonNode = (
  value: unknown,
  budget: JsonSnapshotBudget,
  depth: number,
): OfflineJsonValue => {
  if (depth > MAX_JSON_DEPTH) {
    throw new Error('Sync payload exceeds JSON depth bounds');
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES) {
    throw new Error('Sync payload exceeds JSON node bounds');
  }

  if (value === null || typeof value === 'boolean') {
    budget.bytes += value === null ? 4 : value ? 4 : 5;
    assertJsonSize(budget);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Sync payload numbers must be finite');
    }
    budget.bytes += String(value).length;
    assertJsonSize(budget);
    return value;
  }
  if (typeof value === 'string') {
    addStringBytes(value, budget, 'value');
    return value;
  }
  if (typeof value !== 'object') {
    throw new Error('Sync payload must contain JSON values only');
  }
  if (budget.ancestors.has(value)) {
    throw new Error('Sync payload contains a cyclic JSON value');
  }
  budget.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_JSON_CONTAINER_ITEMS) {
        throw new Error('Sync payload exceeds JSON container bounds');
      }
      budget.bytes += 2 + Math.max(0, value.length - 1);
      assertJsonSize(budget);
      return value.map((nested) => cloneJsonNode(nested, budget, depth + 1));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Sync payload must contain JSON values only');
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_JSON_OBJECT_KEYS) {
      throw new Error('Sync payload exceeds JSON object-key bounds');
    }
    budget.bytes += 2 + Math.max(0, entries.length - 1);
    assertJsonSize(budget);
    const clone: Record<string, OfflineJsonValue> = {};
    for (const [key, nested] of entries) {
      addStringBytes(key, budget, 'key', MAX_JSON_KEY_BYTES);
      Object.defineProperty(clone, key, {
        value: cloneJsonNode(nested, budget, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return clone;
  } finally {
    budget.ancestors.delete(value);
  }
};

const addStringBytes = (
  value: string,
  budget: JsonSnapshotBudget,
  label: 'key' | 'value',
  maximum = MAX_JSON_BYTES,
): void => {
  if (value.length > maximum) {
    throw new Error(`Sync payload JSON ${label} exceeds size bounds`);
  }
  const byteLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (byteLength > maximum) {
    throw new Error(`Sync payload JSON ${label} exceeds size bounds`);
  }
  budget.bytes += byteLength;
  assertJsonSize(budget);
};

const assertJsonSize = (budget: JsonSnapshotBudget): void => {
  if (budget.bytes > MAX_JSON_BYTES) {
    throw new Error('Sync payload exceeds JSON size bounds');
  }
};

const canonicalJson = (
  value: OfflineJsonValue | OfflineSyncOperation,
): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            (value as Record<string, OfflineJsonValue>)[key] ?? null,
          )}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const freezeSyncResult = (result: SyncNowResult): SyncNowResult =>
  Object.freeze({
    ...result,
    acceptedOperationIds: Object.freeze([...result.acceptedOperationIds]),
    terminalConflicts: Object.freeze(
      result.terminalConflicts.map(freezeTerminalConflict),
    ),
    retryableOperations: Object.freeze(
      result.retryableOperations.map((retryable) =>
        Object.freeze({ ...retryable }),
      ),
    ),
  });

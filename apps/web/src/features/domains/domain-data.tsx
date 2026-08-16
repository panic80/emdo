import {
  SyncOperationSchema,
  type JsonValue,
  type SyncOperation,
} from '@emdo/contracts/browser';
import {
  resolveDeterministicSyncOperation,
  type CanonicalSyncEntityVersion,
} from '@emdo/domains/conflicts';
import { Schema, Table, column } from '@powersync/web';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { flushSync } from 'react-dom';
import { z } from 'zod';

import type { EmdoAuthClient } from '../auth/auth-client.js';
import { useAuth } from '../auth/auth-context.js';
import type { LogoutBoundaryAdapter as LogoutPanelBoundary } from '../sync/update-coordinator.js';
import {
  createBrowserOfflineRuntimeComposition,
  createBrowserOfflineLogoutRecoveryComposition,
  type BrowserOfflineRuntimeComposition,
} from '../../offline/logout-purge.js';
import type {
  CanonicalSyncApi,
  CanonicalSyncUploadRequest,
  SyncNowResult,
  TerminalSyncConflict,
} from '../../offline/sync-client.js';
import type { EncryptedSqliteConnection } from '../../offline/database.js';

export type DomainName = 'scheduler' | 'finance' | 'shopping';

export interface DomainRecord {
  readonly domain: DomainName;
  readonly entityType: string;
  readonly id: string;
  readonly value: Readonly<Record<string, JsonValue>>;
  readonly revision: number;
  readonly tombstoned: boolean;
  readonly updatedAt: string;
  readonly spaceId?: string;
  readonly originalOwnerUserId?: string;
  readonly actorIntent?: string;
  readonly lastOperationId?: string;
}

export type DomainConflict = TerminalSyncConflict;

export interface DomainMutationInput {
  readonly domain: DomainName;
  readonly entityType:
    | 'scheduler.item'
    | 'finance.transaction'
    | 'finance.budget'
    | 'shopping.item';
  readonly entityId: string;
  readonly kind: 'create' | 'update' | 'delete' | 'delta';
  readonly data?: Readonly<Record<string, JsonValue>>;
  readonly actorIntent: string;
}

export interface WritableSpace {
  readonly id: string;
  readonly visibility: 'private' | 'shared';
  readonly originalOwnerUserId: string;
}

export type DomainReplicationSnapshot =
  | BrowserOfflineRuntimeComposition['replication']
  | {
      readonly mode: 'online';
      readonly state: 'verified';
      readonly liveReplicationVerified: true;
      /** Timestamp from a validated live Sync Streams acceptance receipt. */
      readonly verifiedAt: string;
    };

export interface DomainRuntimeSnapshot {
  readonly records: readonly DomainRecord[];
  readonly pendingCount: number;
  readonly conflicts: readonly DomainConflict[];
  readonly spaces: readonly WritableSpace[];
  readonly replication: DomainReplicationSnapshot;
}

export interface DomainDataRuntime {
  readonly clientId: string;
  inspect(): Promise<DomainRuntimeSnapshot>;
  applyLocalMutation(operation: SyncOperation): Promise<void>;
  syncNow(signal?: AbortSignal): Promise<SyncNowResult>;
  dismissTerminalConflict(operationId: string): Promise<void>;
  subscribeSnapshotInvalidation(listener: () => void): () => void;
  logout(decision: 'sync-now' | 'discard'): Promise<{
    readonly status:
      'complete' | 'sync-failed' | 'logout-blocked' | 'incomplete';
  }>;
  dispose(): Promise<void>;
}

export interface DomainRuntimeFactoryOptions {
  readonly sessionBinding: string;
  readonly online: boolean;
  readonly getCsrfToken: () => string | undefined;
  readonly authClient: EmdoAuthClient;
  readonly serverSessionKnownRevoked: boolean;
  readonly onPeerTeardown: (signal: AbortSignal) => Promise<void>;
}

export type DomainRuntimeFactory = (
  options: DomainRuntimeFactoryOptions,
) => Promise<DomainDataRuntime>;

export interface DomainDataContextValue {
  readonly state:
    | 'locked'
    | 'initializing'
    | 'ready'
    | 'offline-ready'
    | 'logout-recovery'
    | 'unavailable';
  readonly records: readonly DomainRecord[];
  readonly pendingCount: number;
  readonly replication: DomainReplicationSnapshot;
  readonly conflicts: readonly DomainConflict[];
  readonly activeSpace?: WritableSpace;
  readonly error?: string;
  readonly logoutBoundary?: LogoutPanelBoundary;
  applyMutation(input: DomainMutationInput): Promise<SyncOperation>;
  syncNow(): Promise<void>;
  dismissConflict(operationId: string): Promise<void>;
}

const DISABLED_REPLICATION = Object.freeze({
  mode: 'offline',
  state: 'disabled',
  liveReplicationVerified: false,
} as const satisfies DomainReplicationSnapshot);

const ProjectionColumns = {
  space_id: column.text,
  entity_type: column.text,
  entity_id: column.text,
  payload_json: column.text,
  actor_intent: column.text,
  revision: column.integer,
  tombstoned: column.integer,
  updated_at: column.text,
  last_operation_id: column.text,
};

const PowerSyncEndpointSchema = z
  .string()
  .max(2_048)
  .superRefine((value, context) => {
    try {
      const endpoint = new URL(value);
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
        context.addIssue({
          code: 'custom',
          message: 'Invalid secure PowerSync endpoint',
        });
      }
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Invalid PowerSync endpoint URL',
      });
    }
  });

export const EMDO_OFFLINE_SCHEMA = new Schema({
  sync_entities: new Table({
    household_id: column.text,
    space_id: column.text,
    original_owner_user_id: column.text,
    entity_type: column.text,
    entity_id: column.text,
    payload: column.text,
    actor_intent: column.text,
    revision: column.integer,
    tombstoned_at: column.text,
    created_at: column.text,
    updated_at: column.text,
  }),
  emdo_scheduler_projection: Table.createLocalOnly(ProjectionColumns),
  emdo_finance_projection: Table.createLocalOnly(ProjectionColumns),
  emdo_shopping_projection: Table.createLocalOnly(ProjectionColumns),
  emdo_conversation_projection: Table.createLocalOnly(ProjectionColumns),
  emdo_write_scope: Table.createLocalOnly({
    client_id: column.text,
    visibility: column.text,
    original_owner_user_id: column.text,
  }),
});

const WriteScopeResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  endpoint: PowerSyncEndpointSchema,
  token: z.string().min(16).max(32_768),
  expiresAt: z.string().datetime({ offset: true }),
  writeScope: z.strictObject({
    clientId: z.string().uuid(),
    spaces: z
      .array(
        z.strictObject({
          id: z.string().uuid(),
          visibility: z.enum(['private', 'shared']),
          originalOwnerUserId: z.string().uuid(),
        }),
      )
      .min(1)
      .max(256),
  }),
});

const SyncClientRegistrationResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  clientId: z.string().uuid(),
  status: z.literal('registered'),
  replayed: z.boolean(),
});

const SyncOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    operationId: z.string().uuid(),
    status: z.literal('applied'),
    revision: z.number().int().positive().safe(),
    resolution: z.enum([
      'created',
      'applied',
      'merged',
      'ignored',
      'duplicate',
    ]),
    conflicts: z.array(z.never()).max(0),
    replayed: z.boolean(),
  }),
  z
    .strictObject({
      operationId: z.string().uuid(),
      status: z.literal('conflict'),
      code: z.enum([
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
        'operation-in-progress',
      ]),
      disposition: z.enum(['terminal', 'retryable']),
      currentRevision: z.number().int().positive().safe().optional(),
      conflicts: z
        .array(
          z.strictObject({
            field: z.string().trim().min(1).max(200),
            material: z.boolean(),
          }),
        )
        .max(32),
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
    }),
  z
    .strictObject({
      operationId: z.string().uuid(),
      status: z.literal('blocked'),
      code: z.enum([
        'authorization-revoked',
        'dependency-failed',
        'dependency-cycle',
        'dependency-missing',
      ]),
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
    }),
]);

const SyncResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  clientId: z.string().uuid(),
  results: z.array(SyncOutcomeSchema).max(128),
});

const MAX_CANONICAL_SYNC_RESPONSE_BYTES = 2 * 1_024 * 1_024;

const ProjectionRowSchema = z.strictObject({
  id: z.string().min(1).max(1_024),
  space_id: z.string().uuid(),
  entity_type: z.string().min(1).max(200),
  entity_id: z.string().min(1).max(512),
  payload_json: z.string().max(262_144),
  actor_intent: z.string().min(1).max(1_000),
  revision: z.number().int().nonnegative(),
  tombstoned: z.union([z.literal(0), z.literal(1)]),
  updated_at: z.string().datetime({ offset: true }),
  last_operation_id: z.string().uuid().nullable(),
});

const ReplicatedEntityRowSchema = z.strictObject({
  id: z.string().uuid(),
  household_id: z.string().uuid(),
  space_id: z.string().uuid(),
  original_owner_user_id: z.string().uuid(),
  entity_type: z.string().min(1).max(200),
  entity_id: z.string().min(1).max(512),
  payload: z.string().max(262_144),
  actor_intent: z.string().min(1).max(1_000),
  revision: z.number().int().nonnegative(),
  tombstoned_at: z.string().datetime({ offset: true }).nullable(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});

const CanonicalProjectionSourceRowSchema = z.strictObject({
  payload: z.string().max(262_144),
  revision: z.number().int().positive().safe(),
  tombstoned_at: z.string().datetime({ offset: true }).nullable(),
});

const PendingOperationIdRowSchema = z.strictObject({
  operation_id: z.string().uuid(),
});

const WriteScopeRowSchema = z.strictObject({
  id: z.string().uuid(),
  client_id: z.string().uuid(),
  visibility: z.enum(['private', 'shared']),
  original_owner_user_id: z.string().uuid(),
});

const DOMAIN_TABLES = {
  scheduler: 'emdo_scheduler_projection',
  finance: 'emdo_finance_projection',
  shopping: 'emdo_shopping_projection',
} as const;

const ENTITY_DOMAINS: Readonly<
  Record<DomainMutationInput['entityType'], DomainName>
> = {
  'scheduler.item': 'scheduler',
  'finance.transaction': 'finance',
  'finance.budget': 'finance',
  'shopping.item': 'shopping',
};

const LOCAL_PROJECTION_TABLE_BY_ENTITY_TYPE = Object.freeze({
  'conversation.event': 'emdo_conversation_projection',
  'scheduler.item': 'emdo_scheduler_projection',
  'finance.transaction': 'emdo_finance_projection',
  'finance.budget': 'emdo_finance_projection',
  'shopping.item': 'emdo_shopping_projection',
} as const);

const RESERVED_DATA_KEYS = new Set([
  'approval',
  'authorization',
  'checkout',
  'credential',
  'householdid',
  'oauth',
  'payment',
  'providerwrite',
  'role',
  'sessionid',
  'spaceid',
  'userid',
  'visibility',
]);

const DomainDataContext = createContext<DomainDataContextValue | undefined>(
  undefined,
);

function safeRecord(
  value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> {
  if (!value || Array.isArray(value) || typeof value !== 'object')
    return Object.freeze({});
  return Object.freeze({ ...(value as Record<string, JsonValue>) });
}

function assertSafeDomainData(
  value: Readonly<Record<string, JsonValue>>,
): void {
  const visit = (candidate: JsonValue): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, nested] of Object.entries(candidate)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
      if (RESERVED_DATA_KEYS.has(normalized)) {
        throw new Error(
          'Domain edits cannot supply authorization or provider-action fields.',
        );
      }
      visit(nested);
    }
  };
  visit(value);
}

function selectActiveSpace(
  spaces: readonly WritableSpace[],
): WritableSpace | undefined {
  return spaces.find(({ visibility }) => visibility === 'private') ?? spaces[0];
}

function makeOperation(input: {
  readonly mutation: DomainMutationInput;
  readonly clientId: string;
  readonly spaceId: string;
  readonly baseRevision: number;
  readonly dependency?: string;
}): SyncOperation {
  const { mutation } = input;
  if (ENTITY_DOMAINS[mutation.entityType] !== mutation.domain) {
    throw new Error('The entity is outside the selected domain.');
  }
  const data = mutation.data ?? {};
  assertSafeDomainData(data);
  const payload =
    mutation.kind === 'create'
      ? { spaceId: input.spaceId, value: data }
      : mutation.kind === 'update'
        ? { spaceId: input.spaceId, patch: data }
        : mutation.kind === 'delta'
          ? { spaceId: input.spaceId, delta: data }
          : { spaceId: input.spaceId };
  return SyncOperationSchema.parse({
    schemaVersion: 1,
    clientId: input.clientId,
    operationId: crypto.randomUUID(),
    entity: { type: mutation.entityType, id: mutation.entityId },
    mutation: { kind: mutation.kind, payload },
    baseRevision: input.baseRevision,
    dependencies: input.dependency ? [input.dependency] : [],
    actorIntent: mutation.actorIntent,
    createdAt: new Date().toISOString(),
  });
}

export function DomainDataProvider({
  children,
  runtimeFactory = productionDomainRuntimeFactory,
  recoveryFactory = productionLogoutRecoveryRuntimeFactory,
  clearPrivateMemory = () => undefined,
}: PropsWithChildren<{
  readonly runtimeFactory?: DomainRuntimeFactory;
  readonly recoveryFactory?: DomainRuntimeFactory;
  readonly clearPrivateMemory?: () => void;
}>) {
  const auth = useAuth();
  const csrfRef = useRef(auth.csrfToken);
  csrfRef.current = auth.csrfToken;
  const clearPrivateMemoryRef = useRef(clearPrivateMemory);
  clearPrivateMemoryRef.current = clearPrivateMemory;
  const [runtime, setRuntime] = useState<DomainDataRuntime>();
  const runtimeRef = useRef<DomainDataRuntime | undefined>(undefined);
  const snapshotInspectionRef = useRef(0);
  const peerSealedRuntimeRef = useRef<DomainDataRuntime | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<DomainRuntimeSnapshot>({
    records: [],
    pendingCount: 0,
    conflicts: [],
    spaces: [],
    replication: DISABLED_REPLICATION,
  });
  const [state, setState] = useState<DomainDataContextValue['state']>('locked');
  const [error, setError] = useState<string>();

  const clearDecryptedDomainMemory = useCallback(() => {
    snapshotInspectionRef.current += 1;
    runtimeRef.current = undefined;
    setRuntime(undefined);
    setSnapshot({
      records: [],
      pendingCount: 0,
      conflicts: [],
      spaces: [],
      replication: DISABLED_REPLICATION,
    });
    setError(undefined);
    setState('locked');
  }, []);

  const onPeerTeardown = useCallback(
    async (signal: AbortSignal) => {
      if (signal.aborted) throw new Error('Peer UI teardown was aborted');
      const sealedRuntime = runtimeRef.current;
      peerSealedRuntimeRef.current = sealedRuntime;
      let privateMemoryFailure: unknown;
      flushSync(() => {
        clearDecryptedDomainMemory();
        auth.sealForPeerTeardown();
        try {
          clearPrivateMemoryRef.current();
        } catch (error) {
          privateMemoryFailure = error;
        }
      });
      if (privateMemoryFailure !== undefined) {
        throw new Error(
          'Private in-memory state could not be cleared before peer teardown',
        );
      }
      if (signal.aborted) throw new Error('Peer UI teardown was aborted');

      // The transport emits its acknowledgement in the promise continuation.
      // Dispose the already-sealed wrapper in the next task so it cannot close
      // the BroadcastChannel before that acknowledgement is sent.
      if (sealedRuntime) {
        window.setTimeout(() => {
          void sealedRuntime.dispose().finally(() => {
            if (peerSealedRuntimeRef.current === sealedRuntime) {
              peerSealedRuntimeRef.current = undefined;
            }
          });
        }, 0);
      }
    },
    [auth.sealForPeerTeardown, clearDecryptedDomainMemory],
  );

  useEffect(() => {
    const recovery = auth.state === 'logout-pending';
    if (
      auth.memorySeal === 'peer-teardown' ||
      (auth.state !== 'authenticated' &&
        auth.state !== 'offline-authenticated' &&
        !recovery) ||
      !auth.sessionBinding
    ) {
      clearDecryptedDomainMemory();
      return;
    }
    let active = true;
    let createdRuntime: DomainDataRuntime | undefined;
    setState('initializing');
    setError(undefined);
    const pendingRuntime = (recovery ? recoveryFactory : runtimeFactory)({
      sessionBinding: auth.sessionBinding,
      online: auth.state === 'authenticated' || Boolean(auth.session),
      getCsrfToken: () => csrfRef.current,
      authClient: auth.client,
      serverSessionKnownRevoked: auth.serverSessionKnownRevoked,
      onPeerTeardown,
    });
    void pendingRuntime
      .then(async (created) => {
        createdRuntime = created;
        const next = await created.inspect();
        if (!active) {
          if (peerSealedRuntimeRef.current !== created) await created.dispose();
          return;
        }
        runtimeRef.current = created;
        setRuntime(created);
        setSnapshot(next);
        setState(
          recovery
            ? 'logout-recovery'
            : auth.state === 'authenticated'
              ? 'ready'
              : 'offline-ready',
        );
      })
      .catch(() => {
        if (!active) return;
        runtimeRef.current = undefined;
        setRuntime(undefined);
        setState('unavailable');
        setError(
          'Encrypted offline data is unavailable. Local editing is locked.',
        );
      });
    return () => {
      active = false;
      if (createdRuntime) {
        if (peerSealedRuntimeRef.current !== createdRuntime) {
          void createdRuntime.dispose();
        }
      } else {
        void pendingRuntime.then(
          (created) => created.dispose(),
          () => undefined,
        );
      }
    };
  }, [
    auth.client,
    auth.memorySeal,
    auth.serverSessionKnownRevoked,
    auth.session,
    auth.sessionBinding,
    auth.state,
    clearDecryptedDomainMemory,
    onPeerTeardown,
    recoveryFactory,
    runtimeFactory,
  ]);

  const refreshSnapshot = useCallback(
    async (activeRuntime: DomainDataRuntime) => {
      const inspection = ++snapshotInspectionRef.current;
      try {
        const next = await activeRuntime.inspect();
        if (
          runtimeRef.current === activeRuntime &&
          inspection === snapshotInspectionRef.current
        ) {
          setSnapshot(next);
        }
      } catch (error) {
        if (
          runtimeRef.current === activeRuntime &&
          inspection === snapshotInspectionRef.current
        ) {
          throw error;
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!runtime) return undefined;
    let active = true;
    const inspect = (): void => {
      void refreshSnapshot(runtime).catch(() => {
        if (active)
          setError('Encrypted offline status could not be refreshed.');
      });
    };
    const unsubscribe = runtime.subscribeSnapshotInvalidation(inspect);
    // Re-inspect after the listener is registered so a settlement that occurs
    // between the initial hydration and this effect cannot be missed.
    inspect();
    return () => {
      active = false;
      snapshotInspectionRef.current += 1;
      unsubscribe();
    };
  }, [refreshSnapshot, runtime]);

  const applyMutation = useCallback(
    async (input: DomainMutationInput) => {
      if (!runtime || (state !== 'ready' && state !== 'offline-ready')) {
        throw new Error('Encrypted offline editing is not ready.');
      }
      const space = selectActiveSpace(snapshot.spaces);
      if (!space) {
        throw new Error('No server-authorized writable space is available.');
      }
      const existing = snapshot.records.find(
        (record) =>
          record.spaceId === space.id &&
          record.entityType === input.entityType &&
          record.id === input.entityId,
      );
      const operation = makeOperation({
        mutation: input,
        clientId: runtime.clientId,
        spaceId: space.id,
        baseRevision: existing?.revision ?? 0,
        ...(existing?.lastOperationId
          ? { dependency: existing.lastOperationId }
          : {}),
      });
      await runtime.applyLocalMutation(operation);
      await refreshSnapshot(runtime);
      return operation;
    },
    [refreshSnapshot, runtime, snapshot.records, snapshot.spaces, state],
  );

  const syncNow = useCallback(async () => {
    if (!runtime || state !== 'ready') {
      throw new Error('Connect to EMDO before syncing local changes.');
    }
    const result = await runtime.syncNow();
    void result;
    await refreshSnapshot(runtime);
  }, [refreshSnapshot, runtime, state]);

  const dismissConflict = useCallback(
    async (operationId: string) => {
      if (!runtime || (state !== 'ready' && state !== 'offline-ready')) {
        throw new Error('Encrypted conflict review is not ready.');
      }
      await runtime.dismissTerminalConflict(operationId);
      await refreshSnapshot(runtime);
    },
    [refreshSnapshot, runtime, state],
  );

  const logoutBoundary = useMemo<LogoutPanelBoundary | undefined>(() => {
    if (!runtime) return undefined;
    const finish = async (decision: 'sync-now' | 'discard') => {
      const result = await runtime.logout(decision);
      if (result.status === 'complete' || result.status === 'incomplete') {
        let privateMemoryFailure = false;
        flushSync(() => {
          clearDecryptedDomainMemory();
          try {
            clearPrivateMemoryRef.current();
          } catch {
            privateMemoryFailure = true;
          }
          auth.sealAfterLogout(
            privateMemoryFailure || result.status === 'incomplete'
              ? 'incomplete'
              : 'complete',
          );
        });
        if (privateMemoryFailure) return { status: 'incomplete' as const };
      }
      return result;
    };
    return {
      inspect: async () => ({
        pendingOperations: (await runtime.inspect()).pendingCount,
      }),
      syncAndPurge: async () => finish('sync-now'),
      discardAndPurge: async () => finish('discard'),
    };
  }, [auth.sealAfterLogout, clearDecryptedDomainMemory, runtime]);

  const value = useMemo<DomainDataContextValue>(
    () => ({
      state,
      records: snapshot.records,
      pendingCount: snapshot.pendingCount,
      replication: snapshot.replication,
      conflicts: snapshot.conflicts,
      activeSpace: selectActiveSpace(snapshot.spaces),
      error,
      logoutBoundary,
      applyMutation,
      syncNow,
      dismissConflict,
    }),
    [
      applyMutation,
      dismissConflict,
      error,
      logoutBoundary,
      snapshot,
      state,
      syncNow,
    ],
  );
  return (
    <DomainDataContext.Provider value={value}>
      {children}
    </DomainDataContext.Provider>
  );
}

export function useDomainData(): DomainDataContextValue {
  const context = useContext(DomainDataContext);
  if (!context)
    throw new Error('useDomainData must be used inside DomainDataProvider');
  return context;
}

interface ProductionRuntime extends DomainDataRuntime {
  readonly composition: BrowserOfflineRuntimeComposition;
  readonly connection: EncryptedSqliteConnection;
  readonly spaces: readonly WritableSpace[];
}

interface SharedProductionRuntimeLease {
  readonly mode: 'editing' | 'logout-recovery';
  readonly sessionBinding: string;
  readonly runtime: Promise<DomainDataRuntime>;
  references: number;
  closing?: Promise<void>;
}

let productionRuntimeLease: SharedProductionRuntimeLease | undefined;

async function productionDomainRuntimeFactory(
  options: DomainRuntimeFactoryOptions,
): Promise<DomainDataRuntime> {
  return acquireProductionRuntime('editing', options, () =>
    createProductionDomainRuntime(options),
  );
}

async function productionLogoutRecoveryRuntimeFactory(
  options: DomainRuntimeFactoryOptions,
): Promise<DomainDataRuntime> {
  return acquireProductionRuntime('logout-recovery', options, () =>
    createProductionLogoutRecoveryRuntime(options),
  );
}

export async function acquireProductionRuntime(
  mode: SharedProductionRuntimeLease['mode'],
  options: DomainRuntimeFactoryOptions,
  create: () => Promise<DomainDataRuntime>,
): Promise<DomainDataRuntime> {
  let lease = productionRuntimeLease;
  if (lease?.closing) {
    await lease.closing;
    lease = productionRuntimeLease;
  }
  if (
    lease &&
    (lease.sessionBinding !== options.sessionBinding || lease.mode !== mode)
  ) {
    if (lease.references > 0) {
      throw new Error(
        'A different authenticated offline database is still active',
      );
    }
    if (lease.closing) await lease.closing;
    lease = productionRuntimeLease;
  }
  if (!lease) {
    lease = {
      mode,
      sessionBinding: options.sessionBinding,
      runtime: create(),
      references: 0,
    };
    productionRuntimeLease = lease;
  }
  if (lease.mode !== mode || lease.sessionBinding !== options.sessionBinding) {
    throw new Error('The prior offline database did not close completely');
  }
  lease.references += 1;
  let base: DomainDataRuntime;
  try {
    base = await lease.runtime;
  } catch (error) {
    lease.references -= 1;
    if (productionRuntimeLease === lease && lease.references === 0) {
      productionRuntimeLease = undefined;
    }
    throw error;
  }
  let released = false;
  let pendingRelease: Promise<void> | undefined;
  return Object.freeze({
    clientId: base.clientId,
    inspect: () => base.inspect(),
    applyLocalMutation: (operation: SyncOperation) =>
      base.applyLocalMutation(operation),
    syncNow: (signal?: AbortSignal) => base.syncNow(signal),
    dismissTerminalConflict: (operationId: string) =>
      base.dismissTerminalConflict(operationId),
    subscribeSnapshotInvalidation: (listener: () => void) =>
      base.subscribeSnapshotInvalidation(listener),
    logout: (decision: 'sync-now' | 'discard') => base.logout(decision),
    async dispose() {
      if (released) return;
      if (pendingRelease) return pendingRelease;
      const pending = (async () => {
        if (lease.references > 1) {
          lease.references -= 1;
          released = true;
          return;
        }
        if (lease.references !== 1) {
          throw new Error(
            'The offline runtime lease reference count is invalid',
          );
        }

        // Keep the final reference and the rejected close promise attached to
        // the global lease until close succeeds. That blocks a replacement
        // runtime from orphaning the retained worker/Web Lock, while this exact
        // owner can safely retry a transient close failure.
        const closing = Promise.resolve().then(() => base.dispose());
        lease.closing = closing;
        await closing;
        lease.references -= 1;
        released = true;
        if (productionRuntimeLease === lease && lease.references === 0) {
          productionRuntimeLease = undefined;
        }
      })();
      pendingRelease = pending;
      try {
        await pending;
      } finally {
        if (pendingRelease === pending) {
          pendingRelease = undefined;
        }
      }
    },
  });
}

async function createProductionDomainRuntime(
  options: DomainRuntimeFactoryOptions,
): Promise<ProductionRuntime> {
  const clientId = await getOrCreateClientId();
  const canonicalSyncApi = createCanonicalSyncApi(options.getCsrfToken);
  if (options.online) {
    // The durable token service rejects unknown browser clients. Registration
    // therefore precedes the composition's online PowerSync connection.
    await registerSyncClient(clientId, options.getCsrfToken);
  }
  const composition = await createBrowserOfflineRuntimeComposition({
    sessionBinding: options.sessionBinding,
    schema: EMDO_OFFLINE_SCHEMA,
    replicationClientId: clientId,
    replicationMode: options.online ? 'online' : 'offline',
    canonicalSyncApi,
    serverSession: {
      revokeServerSession: (signal) =>
        options.serverSessionKnownRevoked
          ? Promise.resolve()
          : options.authClient.signOut(signal),
    },
    tokens: {
      deleteAuthTokens: async () => undefined,
      deleteSyncTokens: deleteBrowserClientIdentity,
    },
    privateCaches: { purge: purgePrivateRuntimeCaches },
    onPeerTeardown: options.onPeerTeardown,
  });
  const connection = composition.database.getEncryptedSqliteConnection();
  let spaces: readonly WritableSpace[];
  try {
    spaces = await resolveWritableSpaces({
      connection,
      clientId,
      online: options.online,
      clientAlreadyRegistered: options.online,
      getCsrfToken: options.getCsrfToken,
    });
  } catch (error) {
    await composition.dispose().catch(() => undefined);
    throw error;
  }

  const runtime: ProductionRuntime = {
    clientId,
    composition,
    connection,
    spaces,
    async inspect() {
      const [records, pending, conflicts] = await Promise.all([
        readAllDomainRecords(connection, spaces),
        connection.query<{ readonly count: number }>(
          'SELECT COUNT(*) AS count FROM emdo_pending_sync_operations',
        ),
        composition.sync.listTerminalConflicts(),
      ]);
      const pendingCount = Number(pending[0]?.count ?? 0);
      if (!Number.isSafeInteger(pendingCount) || pendingCount < 0) {
        throw new Error('Invalid pending operation count');
      }
      return {
        records,
        pendingCount,
        conflicts,
        spaces,
        replication: composition.replication,
      };
    },
    async applyLocalMutation(operation) {
      const parsed = SyncOperationSchema.parse(operation);
      await composition.sync.applyLocalMutation(
        parsed,
        async (transaction, frozen) => {
          await applyProjectionMutation(transaction, frozen);
        },
      );
    },
    syncNow: (signal) => composition.sync.syncNow(signal),
    dismissTerminalConflict: (operationId) =>
      composition.sync.dismissTerminalConflict(operationId),
    subscribeSnapshotInvalidation: (listener) =>
      composition.sync.subscribeSnapshotInvalidation(listener),
    async logout(decision: 'sync-now' | 'discard') {
      const result = await composition.logoutBoundary.logout(
        decision === 'sync-now'
          ? { kind: 'sync-now' }
          : { kind: 'discard', confirmed: true },
      );
      return {
        status:
          result.status === 'decision-required'
            ? 'logout-blocked'
            : result.status,
      };
    },
    async dispose() {
      await composition.dispose();
    },
  };
  return runtime;
}

async function createProductionLogoutRecoveryRuntime(
  options: DomainRuntimeFactoryOptions,
): Promise<DomainDataRuntime> {
  const clientId = await getOrCreateClientId();
  const canonicalSyncApi = createCanonicalSyncApi(options.getCsrfToken);
  const composition = await createBrowserOfflineLogoutRecoveryComposition({
    sessionBinding: options.sessionBinding,
    schema: EMDO_OFFLINE_SCHEMA,
    replicationClientId: clientId,
    replicationMode: 'offline',
    canonicalSyncApi,
    serverSession: {
      revokeServerSession: (signal) =>
        options.serverSessionKnownRevoked
          ? Promise.resolve()
          : options.authClient.signOut(signal),
    },
    tokens: {
      deleteAuthTokens: async () => undefined,
      deleteSyncTokens: deleteBrowserClientIdentity,
    },
    privateCaches: { purge: purgePrivateRuntimeCaches },
    onPeerTeardown: options.onPeerTeardown,
  });
  return Object.freeze({
    clientId,
    async inspect() {
      const pending = await composition.hasPendingOperations();
      return {
        records: [],
        pendingCount: pending ? 1 : 0,
        conflicts: [],
        spaces: [],
        replication: DISABLED_REPLICATION,
      };
    },
    async applyLocalMutation() {
      throw new Error('Local editing is sealed during logout recovery');
    },
    async syncNow() {
      throw new Error('Use the staged logout recovery boundary');
    },
    async dismissTerminalConflict() {
      throw new Error('Conflict review is sealed during logout recovery');
    },
    subscribeSnapshotInvalidation() {
      return () => undefined;
    },
    async logout(decision: 'sync-now' | 'discard') {
      const result = await composition.logoutBoundary.logout(
        decision === 'sync-now'
          ? { kind: 'sync-now' }
          : { kind: 'discard', confirmed: true },
      );
      return {
        status:
          result.status === 'decision-required'
            ? 'logout-blocked'
            : result.status,
      };
    },
    dispose: () => composition.dispose(),
  });
}

export function createCanonicalSyncApi(
  getCsrfToken: () => string | undefined,
): CanonicalSyncApi {
  return {
    async uploadOperations(request, signal) {
      const csrfToken = getCsrfToken();
      if (!csrfToken)
        throw new Error('A current authenticated mutation proof is required');
      const clientId = singleClientId(request);
      const response = await fetch('/api/v1/sync/ops', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': request.idempotencyKey,
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          clientId,
          operations: request.operations,
        }),
      });
      if (!response.ok) throw new Error('Canonical domain sync failed');
      const parsed = SyncResponseSchema.safeParse(
        await readBoundedCanonicalSyncResponse(response, signal),
      );
      if (!parsed.success || parsed.data.clientId !== clientId) {
        throw new Error('Canonical domain sync returned an invalid result');
      }
      const expected = new Set(
        request.operations.map(({ operationId }) => operationId),
      );
      if (
        parsed.data.results.length !== expected.size ||
        parsed.data.results.some(
          ({ operationId }) => !expected.has(operationId),
        )
      ) {
        throw new Error('Canonical domain sync returned mismatched operations');
      }
      return Object.freeze({
        results: Object.freeze(parsed.data.results),
      });
    },
  };
}

async function readBoundedCanonicalSyncResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const contentType = response.headers.get('content-type');
  if (
    contentType !== null &&
    !/^application\/json(?:\s*;|$)/iu.test(contentType)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Canonical domain sync returned an invalid content type');
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]{0,8})$/u.test(contentLength)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Canonical domain sync response size is invalid');
    }
    if (Number(contentLength) > MAX_CANONICAL_SYNC_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Canonical domain sync response exceeds safe bounds');
    }
  }

  if (response.body === null) {
    throw new Error('Canonical domain sync returned an empty result');
  }

  const reader = response.body.getReader();
  const cancelForAbort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', cancelForAbort, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let decoded = '';
  let totalBytes = 0;
  try {
    while (true) {
      if (signal.aborted)
        throw signal.reason ?? new Error('Canonical sync aborted');
      const next = await reader.read();
      if (signal.aborted)
        throw signal.reason ?? new Error('Canonical sync aborted');
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_CANONICAL_SYNC_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Canonical domain sync response exceeds safe bounds');
      }
      decoded += decoder.decode(next.value, { stream: true });
    }
    decoded += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancelForAbort);
    reader.releaseLock();
  }

  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    throw new Error('Canonical domain sync returned an invalid result');
  }
}

function singleClientId(request: CanonicalSyncUploadRequest): string {
  const ids = new Set(request.operations.map(({ clientId }) => clientId));
  if (ids.size !== 1)
    throw new Error('Canonical upload must belong to one client');
  return [...ids][0]!;
}

async function resolveWritableSpaces(input: {
  readonly connection: EncryptedSqliteConnection;
  readonly clientId: string;
  readonly online: boolean;
  readonly clientAlreadyRegistered: boolean;
  readonly getCsrfToken: () => string | undefined;
}): Promise<readonly WritableSpace[]> {
  if (input.online) {
    try {
      if (!input.clientAlreadyRegistered) {
        await registerSyncClient(input.clientId, input.getCsrfToken);
      }
      const response = await fetch(
        `/api/v1/sync/token?clientId=${encodeURIComponent(input.clientId)}`,
        { method: 'GET', credentials: 'same-origin', cache: 'no-store' },
      );
      if (!response.ok) throw new Error('Writable space bootstrap failed');
      const parsed = WriteScopeResponseSchema.safeParse(await response.json());
      if (
        !parsed.success ||
        parsed.data.writeScope.clientId !== input.clientId
      ) {
        throw new Error('Writable space bootstrap is invalid');
      }
      await persistWritableSpaces(
        input.connection,
        input.clientId,
        parsed.data.writeScope.spaces,
      );
      return Object.freeze(
        parsed.data.writeScope.spaces.map((space) => Object.freeze(space)),
      );
    } catch {
      // A previously server-derived encrypted scope can keep local editing
      // available; the upload endpoint re-authorizes every operation later.
    }
  }
  const stored = await readWritableSpaces(input.connection, input.clientId);
  if (stored.length === 0)
    throw new Error('No server-derived writable space is available');
  return stored;
}

async function registerSyncClient(
  clientId: string,
  getCsrfToken: () => string | undefined,
): Promise<void> {
  const csrfToken = getCsrfToken();
  if (!csrfToken)
    throw new Error('A current authenticated mutation proof is required');
  const response = await fetch('/api/v1/sync/clients', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': `sync-client-register.${clientId}`,
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify({
      schemaVersion: 1,
      clientId,
      displayName: 'EMDO web device',
    }),
  });
  if (!response.ok) throw new Error('Browser sync client registration failed');
  const parsed = SyncClientRegistrationResponseSchema.safeParse(
    await response.json(),
  );
  if (!parsed.success || parsed.data.clientId !== clientId) {
    throw new Error(
      'Browser sync client registration returned an invalid result',
    );
  }
}

async function persistWritableSpaces(
  connection: EncryptedSqliteConnection,
  clientId: string,
  spaces: readonly WritableSpace[],
): Promise<void> {
  await connection.transaction(async (transaction) => {
    await transaction.execute('DELETE FROM emdo_write_scope');
    for (const space of spaces) {
      await transaction.execute(
        `INSERT INTO emdo_write_scope
           (id, client_id, visibility, original_owner_user_id)
         VALUES (?, ?, ?, ?)`,
        [space.id, clientId, space.visibility, space.originalOwnerUserId],
      );
    }
  });
}

async function readWritableSpaces(
  connection: EncryptedSqliteConnection,
  clientId: string,
): Promise<readonly WritableSpace[]> {
  const rows = await connection.query<unknown>(
    `SELECT id, client_id, visibility, original_owner_user_id
       FROM emdo_write_scope
      WHERE client_id = ?
      ORDER BY visibility DESC, id ASC`,
    [clientId],
  );
  return Object.freeze(
    rows.map((row) => {
      const parsed = WriteScopeRowSchema.parse(row);
      return Object.freeze({
        id: parsed.id,
        visibility: parsed.visibility,
        originalOwnerUserId: parsed.original_owner_user_id,
      });
    }),
  );
}

export async function readAllDomainRecords(
  connection: EncryptedSqliteConnection,
  spaces: readonly WritableSpace[],
): Promise<readonly DomainRecord[]> {
  const allowedSpaces = new Map(spaces.map((space) => [space.id, space]));
  const records = new Map<string, DomainRecord>();
  const replicatedRows = await connection.query<unknown>(
    `SELECT id, household_id, space_id, original_owner_user_id,
            entity_type, entity_id, payload, actor_intent, revision,
            tombstoned_at, created_at, updated_at
       FROM sync_entities
      ORDER BY updated_at DESC, id ASC`,
  );
  for (const row of replicatedRows) {
    const parsed = ReplicatedEntityRowSchema.parse(row);
    const writableSpace = allowedSpaces.get(parsed.space_id);
    // Signed Sync Stream rules are the tenant authority. This local filter is
    // defense in depth only and never derives household membership or grants.
    if (
      !writableSpace ||
      (writableSpace.visibility === 'private' &&
        parsed.original_owner_user_id !== writableSpace.originalOwnerUserId)
    ) {
      continue;
    }
    const domain =
      ENTITY_DOMAINS[parsed.entity_type as DomainMutationInput['entityType']];
    if (!domain) continue;
    const key = domainRecordKey(
      parsed.space_id,
      parsed.entity_type,
      parsed.entity_id,
    );
    if (records.has(key))
      throw new Error('Replicated domain identity is not unique');
    records.set(
      key,
      Object.freeze({
        domain,
        entityType: parsed.entity_type,
        id: parsed.entity_id,
        value: parseStoredDomainPayload(parsed.payload),
        revision: parsed.revision,
        tombstoned: parsed.tombstoned_at !== null,
        updatedAt: parsed.updated_at,
        spaceId: parsed.space_id,
        originalOwnerUserId: parsed.original_owner_user_id,
        actorIntent: parsed.actor_intent,
      }),
    );
  }

  const pendingRows = await connection.query<unknown>(
    'SELECT operation_id FROM emdo_pending_sync_operations ORDER BY sequence ASC',
  );
  const pendingOperationIds = new Set(
    pendingRows.map(
      (row) => PendingOperationIdRowSchema.parse(row).operation_id,
    ),
  );
  for (const [domain, table] of Object.entries(DOMAIN_TABLES) as Array<
    [DomainName, (typeof DOMAIN_TABLES)[DomainName]]
  >) {
    const rows = await connection.query<unknown>(
      `SELECT id, space_id, entity_type, entity_id, payload_json, actor_intent,
              revision, tombstoned, updated_at, last_operation_id
         FROM ${table}
        ORDER BY updated_at DESC, id ASC`,
    );
    for (const row of rows) {
      const parsed = ProjectionRowSchema.parse(row);
      if (!allowedSpaces.has(parsed.space_id)) continue;
      if (
        ENTITY_DOMAINS[
          parsed.entity_type as DomainMutationInput['entityType']
        ] !== domain
      ) {
        throw new Error('Local projection contains an invalid domain entity');
      }
      const key = domainRecordKey(
        parsed.space_id,
        parsed.entity_type,
        parsed.entity_id,
      );
      const canonical = records.get(key);
      const pending =
        parsed.last_operation_id !== null &&
        pendingOperationIds.has(parsed.last_operation_id);
      if (canonical && !pending && parsed.revision <= canonical.revision)
        continue;
      records.set(
        key,
        Object.freeze({
          domain,
          entityType: parsed.entity_type,
          id: parsed.entity_id,
          value: parseStoredDomainPayload(parsed.payload_json),
          revision: parsed.revision,
          tombstoned: parsed.tombstoned === 1,
          updatedAt: parsed.updated_at,
          spaceId: parsed.space_id,
          actorIntent: parsed.actor_intent,
          ...(parsed.last_operation_id
            ? { lastOperationId: parsed.last_operation_id }
            : {}),
        }),
      );
    }
  }
  return Object.freeze(
    [...records.values()].sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    ),
  );
}

export async function applyProjectionMutation(
  transaction: EncryptedSqliteConnection,
  operation: SyncOperation,
): Promise<void> {
  const table =
    LOCAL_PROJECTION_TABLE_BY_ENTITY_TYPE[
      operation.entity
        .type as keyof typeof LOCAL_PROJECTION_TABLE_BY_ENTITY_TYPE
    ];
  if (!table)
    throw new Error(
      'Provider-backed entities cannot enter the offline projection',
    );
  const envelope = safeRecord(operation.mutation.payload as JsonValue);
  const spaceId = z.string().uuid().parse(envelope.spaceId);
  const projectionId = domainRecordKey(
    spaceId,
    operation.entity.type,
    operation.entity.id,
  );
  const rows = await transaction.query<unknown>(
    `SELECT id, space_id, entity_type, entity_id, payload_json, actor_intent,
            revision, tombstoned, updated_at, last_operation_id
       FROM ${table}
      WHERE id = ?`,
    [projectionId],
  );
  if (rows.length > 1)
    throw new Error('Local domain projection identity is not unique');
  const local = rows[0] ? ProjectionRowSchema.parse(rows[0]) : undefined;
  if (
    local !== undefined &&
    (local.id !== projectionId ||
      local.space_id !== spaceId ||
      local.entity_type !== operation.entity.type ||
      local.entity_id !== operation.entity.id)
  ) {
    throw new Error('Local domain projection identity is invalid');
  }

  let localPending = false;
  if (local?.last_operation_id) {
    const pendingRows = await transaction.query<unknown>(
      `SELECT operation_id
         FROM emdo_pending_sync_operations
        WHERE operation_id = ?`,
      [local.last_operation_id],
    );
    if (pendingRows.length > 1)
      throw new Error('Pending operation identity is not unique');
    if (pendingRows[0] !== undefined) {
      const pendingOperationId = PendingOperationIdRowSchema.parse(
        pendingRows[0],
      ).operation_id;
      if (pendingOperationId !== local.last_operation_id) {
        throw new Error('Pending operation identity is invalid');
      }
      localPending = true;
    }
  }

  let canonical: CanonicalSyncEntityVersion | undefined;
  if (!localPending) {
    const canonicalRows = await transaction.query<unknown>(
      `SELECT payload, revision, tombstoned_at
         FROM sync_entities
        WHERE space_id = ? AND entity_type = ? AND entity_id = ?`,
      [spaceId, operation.entity.type, operation.entity.id],
    );
    if (canonicalRows.length > 1)
      throw new Error('Replicated domain identity is not unique');
    if (canonicalRows[0] !== undefined) {
      const parsedCanonical = CanonicalProjectionSourceRowSchema.parse(
        canonicalRows[0],
      );
      canonical = {
        payload: parseStoredDomainPayload(parsedCanonical.payload),
        revision: parsedCanonical.revision,
        tombstoned: parsedCanonical.tombstoned_at !== null,
      };
    }
  }
  const localVersion =
    local === undefined
      ? undefined
      : ({
          payload: parseStoredDomainPayload(local.payload_json),
          revision: local.revision,
          tombstoned: local.tombstoned === 1,
        } satisfies CanonicalSyncEntityVersion);
  const current =
    localVersion !== undefined &&
    (localPending ||
      canonical === undefined ||
      localVersion.revision > canonical.revision)
      ? localVersion
      : canonical;

  let base: CanonicalSyncEntityVersion | undefined;
  if (
    operation.mutation.kind === 'update' &&
    (operation.entity.type === 'scheduler.item' ||
      operation.entity.type === 'finance.budget')
  ) {
    const patch = safeRecord(envelope.patch);
    if (patch.base !== undefined) {
      base = {
        payload: patch.base,
        revision: operation.baseRevision,
        tombstoned: false,
      };
    }
  }

  const result = resolveDeterministicSyncOperation({
    operation,
    ...(current === undefined ? {} : { current }),
    ...(base === undefined ? {} : { base }),
  });
  if (result.status !== 'applied') {
    throw new Error(
      `Offline domain operation requires review (${result.code})`,
    );
  }
  if (
    !result.state ||
    Array.isArray(result.state) ||
    typeof result.state !== 'object'
  ) {
    throw new Error('Offline domain operation returned an invalid projection');
  }
  const projectionRevision = (current?.revision ?? operation.baseRevision) + 1;
  if (!Number.isSafeInteger(projectionRevision) || projectionRevision <= 0) {
    throw new Error('Offline domain projection revision is invalid');
  }
  await transaction.execute(
    `INSERT OR REPLACE INTO ${table}
       (id, space_id, entity_type, entity_id, payload_json, actor_intent,
        revision, tombstoned, updated_at, last_operation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      projectionId,
      spaceId,
      operation.entity.type,
      operation.entity.id,
      JSON.stringify(result.state),
      operation.actorIntent,
      projectionRevision,
      result.tombstoned ? 1 : 0,
      operation.createdAt,
      operation.operationId,
    ],
  );
}

function domainRecordKey(
  spaceId: string,
  entityType: string,
  entityId: string,
): string {
  return `${spaceId}:${entityType}:${entityId}`;
}

function parseStoredDomainPayload(
  serialized: string,
): Readonly<Record<string, JsonValue>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('Stored domain payload is not valid JSON');
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Stored domain payload must be a JSON object');
  }
  return Object.freeze({ ...(parsed as Record<string, JsonValue>) });
}

const CLIENT_METADATA_DATABASE = 'emdo-browser-metadata-v1';
const CLIENT_METADATA_STORE = 'device';
const CLIENT_ID_KEY = 'sync-client-id';

async function getOrCreateClientId(): Promise<string> {
  const database = await openClientMetadataDatabase();
  try {
    const existing = await indexedDbRequest<unknown>(
      database
        .transaction(CLIENT_METADATA_STORE, 'readonly')
        .objectStore(CLIENT_METADATA_STORE)
        .get(CLIENT_ID_KEY),
    );
    const parsed = z.string().uuid().safeParse(existing);
    if (parsed.success) return parsed.data;
    const clientId = crypto.randomUUID();
    await indexedDbRequest(
      database
        .transaction(CLIENT_METADATA_STORE, 'readwrite')
        .objectStore(CLIENT_METADATA_STORE)
        .put(clientId, CLIENT_ID_KEY),
    );
    return clientId;
  } finally {
    database.close();
  }
}

function openClientMetadataDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CLIENT_METADATA_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CLIENT_METADATA_STORE)) {
        request.result.createObjectStore(CLIENT_METADATA_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error('Browser sync identity storage is unavailable'));
  });
}

function indexedDbRequest<Value>(request: IDBRequest<Value>): Promise<Value> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error('Browser sync identity storage failed'));
  });
}

async function deleteBrowserClientIdentity(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(CLIENT_METADATA_DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(new Error('Browser sync identity purge failed'));
    request.onblocked = () =>
      reject(new Error('Browser sync identity purge was blocked'));
  });
}

async function purgePrivateRuntimeCaches(): Promise<void> {
  if (!('caches' in globalThis)) return;
  const names = await caches.keys();
  const privateNames = names.filter((name) =>
    /^(?:emdo-private-|emdo-user-|powersync-private-)/u.test(name),
  );
  const results = await Promise.all(
    privateNames.map((name) => caches.delete(name)),
  );
  if (results.some((deleted) => !deleted)) {
    throw new Error('A private runtime cache could not be purged');
  }
}

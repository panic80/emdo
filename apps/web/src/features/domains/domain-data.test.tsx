import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import type { SyncOperation } from '@emdo/contracts/browser';

import type { EmdoAuthClient } from '../auth/auth-client.js';
import { AuthProvider, useAuth } from '../auth/auth-context.js';
import type { EncryptedSqliteConnection } from '../../offline/database.js';
import {
  DomainDataProvider,
  acquireProductionRuntime,
  applyProjectionMutation,
  createCanonicalSyncApi,
  readAllDomainRecords,
  useDomainData,
  type DomainDataRuntime,
  type DomainRuntimeFactory,
  type DomainRuntimeSnapshot,
} from './domain-data.js';
import { DomainSyncStatus } from './domain-status.js';
import { createDomainRuntimeSnapshot } from '../../test/fake-domain-runtime.js';

const space = {
  id: '11111111-1111-4111-8111-111111111111',
  visibility: 'private' as const,
  originalOwnerUserId: '22222222-2222-4222-8222-222222222222',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const sharedSpace = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  visibility: 'shared' as const,
  originalOwnerUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

const unrelatedSpace = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  visibility: 'private' as const,
  originalOwnerUserId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
};

const startingReplication = {
  mode: 'online',
  state: 'background-started',
  liveReplicationVerified: false,
} as const;

interface FakeDomainRows {
  readonly replicated?: readonly unknown[];
  readonly pendingOperationIds?: readonly string[];
  readonly scheduler?: readonly unknown[];
  readonly finance?: readonly unknown[];
  readonly shopping?: readonly unknown[];
}

function domainConnection(rows: FakeDomainRows): EncryptedSqliteConnection {
  return {
    encryption: 'required',
    storage: 'safari-opfs',
    execute: vi.fn(async () => undefined),
    query: async <Row,>(statement: string): Promise<readonly Row[]> => {
      let result: readonly unknown[] | undefined;
      if (statement.includes('FROM sync_entities'))
        result = rows.replicated ?? [];
      if (statement.includes('FROM emdo_pending_sync_operations')) {
        result = (rows.pendingOperationIds ?? []).map((operation_id) => ({
          operation_id,
        }));
      } else if (statement.includes('FROM emdo_scheduler_projection')) {
        result = rows.scheduler ?? [];
      } else if (statement.includes('FROM emdo_finance_projection')) {
        result = rows.finance ?? [];
      } else if (statement.includes('FROM emdo_shopping_projection')) {
        result = rows.shopping ?? [];
      }
      if (result === undefined)
        throw new Error(`Unexpected query: ${statement}`);
      return result as readonly Row[];
    },
    transaction: vi.fn(async (operation) => operation(domainConnection(rows))),
    close: vi.fn(async () => undefined),
  };
}

function replicatedRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    household_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    space_id: space.id,
    original_owner_user_id: space.originalOwnerUserId,
    entity_type: 'scheduler.item',
    entity_id: 'appointment',
    payload: JSON.stringify({ title: 'Dentist' }),
    actor_intent: 'Keep the household schedule current',
    revision: 2,
    tombstoned_at: null,
    created_at: '2026-08-09T12:00:00.000Z',
    updated_at: '2026-08-10T12:00:00.000Z',
    ...overrides,
  };
}

function projectionRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: `${space.id}:scheduler.item:appointment`,
    space_id: space.id,
    entity_type: 'scheduler.item',
    entity_id: 'appointment',
    payload_json: JSON.stringify({ title: 'Local dentist note' }),
    actor_intent: 'Edit the appointment locally',
    revision: 3,
    tombstoned: 0,
    updated_at: '2026-08-10T12:05:00.000Z',
    last_operation_id: '99999999-9999-4999-8999-999999999999',
    ...overrides,
  };
}

function authClient(session: 'online' | 'offline'): EmdoAuthClient {
  return {
    getSession: vi.fn(async () => {
      if (session === 'offline') throw new Error('network unavailable');
      return {
        session: { id: 'session-1', expiresAt: '2999-08-16T12:00:00.000Z' },
        user: {
          id: space.originalOwnerUserId,
          email: 'member@example.ca',
          emailVerified: true,
          name: 'Member',
        },
      };
    }),
    getMutationCsrf: vi.fn(async () => 'csrf-token-01234567890123456789'),
    signInEmail: vi.fn(async () => undefined),
    signInGoogle: vi.fn(async () => undefined),
    signInPasskey: vi.fn(async () => 'authenticated' as const),
    registerPasskey: vi.fn(async () => undefined),
    redeemInvitation: vi.fn(async () => ({
      status: 'provisioned' as const,
      email: 'member@example.ca',
      role: 'member' as const,
    })),
    signOut: vi.fn(async () => undefined),
  };
}

function runtimeFactory(operations: SyncOperation[]): DomainRuntimeFactory {
  return vi.fn(async () => {
    let pendingCount = 0;
    let records: DomainRuntimeSnapshot['records'] = [];
    const runtime: DomainDataRuntime = {
      clientId: '33333333-3333-4333-8333-333333333333',
      inspect: vi.fn(async () =>
        createDomainRuntimeSnapshot({
          records,
          pendingCount,
          spaces: [space],
          replication: startingReplication,
        }),
      ),
      applyLocalMutation: vi.fn(async (operation) => {
        operations.push(operation);
        pendingCount += 1;
        records = [
          {
            domain: 'shopping',
            entityType: operation.entity.type,
            id: operation.entity.id,
            value: { quantityMinorUnits: 1_000 },
            revision: operation.baseRevision + 1,
            tombstoned: false,
            updatedAt: operation.createdAt,
            lastOperationId: operation.operationId,
          },
        ];
      }),
      syncNow: vi.fn(async () => ({
        status: 'complete' as const,
        submittedCount: pendingCount,
        acceptedOperationIds: operations.map(({ operationId }) => operationId),
        terminalConflicts: [],
        retryableOperations: [],
      })),
      dismissTerminalConflict: vi.fn(async () => undefined),
      subscribeSnapshotInvalidation: () => () => undefined,
      logout: vi.fn(async () => ({ status: 'complete' as const })),
      dispose: vi.fn(async () => undefined),
    };
    return runtime;
  });
}

function ShoppingMutationProbe() {
  const domain = useDomainData();
  const [syncError, setSyncError] = useState('');
  return (
    <section>
      <output>{`${domain.state}:${domain.pendingCount}`}</output>
      <button
        type="button"
        onClick={() =>
          void domain.applyMutation({
            domain: 'shopping',
            entityType: 'shopping.item',
            entityId: 'milk',
            kind: 'delta',
            data: { quantityMinorUnits: 1_000 },
            actorIntent: 'Increase milk quantity by one litre',
          })
        }
      >
        Increase milk
      </button>
      <button
        type="button"
        onClick={() =>
          void domain.syncNow().catch((error: unknown) => {
            setSyncError(
              error instanceof Error ? error.message : 'Sync failed',
            );
          })
        }
      >
        Sync
      </button>
      {syncError ? <p role="alert">{syncError}</p> : null}
    </section>
  );
}

function MemoryBoundaryProbe() {
  const auth = useAuth();
  const domain = useDomainData();
  return (
    <section>
      <output data-testid="auth-memory">{`${auth.state}:${auth.csrfToken ?? 'no-proof'}:${auth.sessionBinding ?? 'locked'}:${auth.memorySeal}`}</output>
      <output data-testid="domain-memory">{`${domain.state}:${domain.records.map(({ id }) => id).join(',') || 'empty'}`}</output>
      <button
        type="button"
        onClick={() => void domain.logoutBoundary?.syncAndPurge()}
      >
        Finish logout
      </button>
    </section>
  );
}

function sensitiveRuntime(
  logoutStatus: 'complete' | 'incomplete' = 'complete',
): DomainDataRuntime {
  return {
    clientId: '33333333-3333-4333-8333-333333333333',
    inspect: vi.fn(async () =>
      createDomainRuntimeSnapshot({
        records: [
          {
            domain: 'finance' as const,
            entityType: 'finance.transaction',
            id: 'private-transaction',
            value: { description: 'Private household expense' },
            revision: 1,
            tombstoned: false,
            updatedAt: '2026-08-10T00:00:00.000Z',
          },
        ],
        pendingCount: 0,
        spaces: [space],
        replication: startingReplication,
      }),
    ),
    applyLocalMutation: vi.fn(async () => undefined),
    syncNow: vi.fn(async () => ({
      status: 'idle' as const,
      submittedCount: 0,
      acceptedOperationIds: [],
      terminalConflicts: [],
      retryableOperations: [],
    })),
    dismissTerminalConflict: vi.fn(async () => undefined),
    subscribeSnapshotInvalidation: () => () => undefined,
    logout: vi.fn(async () => ({ status: logoutStatus })),
    dispose: vi.fn(async () => undefined),
  };
}

describe('DomainDataProvider', () => {
  it('hydrates encrypted terminal conflicts and dismisses only the reviewed notice', async () => {
    const firstOperationId = '44444444-4444-4444-8444-444444444441';
    const secondOperationId = '44444444-4444-4444-8444-444444444442';
    let conflicts = [
      {
        operationId: firstOperationId,
        status: 'conflict' as const,
        code: 'material-conflict',
        currentRevision: 3,
        conflicts: [{ field: 'time', material: true }],
      },
      {
        operationId: secondOperationId,
        status: 'blocked' as const,
        code: 'authorization-revoked',
        conflicts: [],
      },
    ];
    const dismissTerminalConflict = vi.fn(async (operationId: string) => {
      conflicts = conflicts.filter(
        (conflict) => conflict.operationId !== operationId,
      );
    });
    const runtime: DomainDataRuntime = {
      ...sensitiveRuntime(),
      inspect: vi.fn(async () =>
        createDomainRuntimeSnapshot({
          pendingCount: 1,
          conflicts,
          spaces: [space],
          replication: startingReplication,
        }),
      ),
      dismissTerminalConflict,
    } as DomainDataRuntime;

    render(
      <AuthProvider client={authClient('online')}>
        <DomainDataProvider runtimeFactory={vi.fn(async () => runtime)}>
          <DomainSyncStatus />
        </DomainDataProvider>
      </AuthProvider>,
    );

    expect(await screen.findByText('2 changes need review')).toBeVisible();
    expect(screen.getByText('material-conflict')).toBeVisible();
    expect(screen.getByText('Canonical revision 3')).toBeVisible();
    expect(screen.getByText('time (material)')).toBeVisible();
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Dismiss material-conflict review notice',
      }),
    );

    expect(dismissTerminalConflict).toHaveBeenCalledWith(firstOperationId);
    expect(await screen.findByText('1 change needs review')).toBeVisible();
    expect(screen.queryByText('material-conflict')).not.toBeInTheDocument();
    expect(screen.getByText('1 local change waiting to sync')).toBeVisible();
  });

  it('surfaces conflicts settled by background canonical uploads', async () => {
    let conflicts: DomainRuntimeSnapshot['conflicts'] = [];
    let invalidate: (() => void) | undefined;
    const runtime = {
      ...sensitiveRuntime(),
      inspect: vi.fn(async () =>
        createDomainRuntimeSnapshot({
          conflicts,
          spaces: [space],
          replication: startingReplication,
        }),
      ),
      subscribeSnapshotInvalidation(listener: () => void) {
        invalidate = listener;
        return () => {
          if (invalidate === listener) invalidate = undefined;
        };
      },
    } as DomainDataRuntime;

    render(
      <AuthProvider client={authClient('online')}>
        <DomainDataProvider runtimeFactory={vi.fn(async () => runtime)}>
          <DomainSyncStatus />
        </DomainDataProvider>
      </AuthProvider>,
    );

    expect(
      await screen.findByText('Encrypted offline data is up to date'),
    ).toBeVisible();
    conflicts = [
      {
        operationId: '44444444-4444-4444-8444-444444444443',
        status: 'conflict',
        code: 'material-conflict',
        conflicts: [{ field: 'time', material: true }],
      },
    ];
    act(() => invalidate?.());

    expect(await screen.findByText('1 change needs review')).toBeVisible();
  });

  it('closes the initial inspect-to-subscribe conflict race', async () => {
    const terminalConflict: DomainRuntimeSnapshot['conflicts'][number] = {
      operationId: '44444444-4444-4444-8444-444444444444',
      status: 'conflict',
      code: 'material-conflict',
      conflicts: [{ field: 'time', material: true }],
    };
    let inspectCount = 0;
    const inspect = vi.fn(async () => {
      inspectCount += 1;
      return createDomainRuntimeSnapshot({
        conflicts: inspectCount === 1 ? [] : [terminalConflict],
        spaces: [space],
        replication: startingReplication,
      });
    });
    const runtime = {
      ...sensitiveRuntime(),
      inspect,
      subscribeSnapshotInvalidation: () => () => undefined,
    } as DomainDataRuntime;

    render(
      <AuthProvider client={authClient('online')}>
        <DomainDataProvider runtimeFactory={vi.fn(async () => runtime)}>
          <DomainSyncStatus />
        </DomainDataProvider>
      </AuthProvider>,
    );

    expect(await screen.findByText('1 change needs review')).toBeVisible();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('does not let an older refresh re-surface a dismissed conflict', async () => {
    const terminalConflict: DomainRuntimeSnapshot['conflicts'][number] = {
      operationId: '45454545-4545-4545-8545-454545454545',
      status: 'conflict',
      code: 'material-conflict',
      conflicts: [{ field: 'time', material: true }],
    };
    let conflicts: DomainRuntimeSnapshot['conflicts'] = [terminalConflict];
    let inspectCount = 0;
    let resolveStaleInspection: (() => void) | undefined;
    const inspect = vi.fn(async () => {
      inspectCount += 1;
      if (inspectCount === 2) {
        const stale = createDomainRuntimeSnapshot({
          conflicts,
          spaces: [space],
          replication: startingReplication,
        });
        await new Promise<void>((resolve) => {
          resolveStaleInspection = resolve;
        });
        return stale;
      }
      return createDomainRuntimeSnapshot({
        conflicts,
        spaces: [space],
        replication: startingReplication,
      });
    });
    const runtime = {
      ...sensitiveRuntime(),
      inspect,
      dismissTerminalConflict: vi.fn(async () => {
        conflicts = [];
      }),
      subscribeSnapshotInvalidation: () => () => undefined,
    } as DomainDataRuntime;

    render(
      <AuthProvider client={authClient('online')}>
        <DomainDataProvider runtimeFactory={vi.fn(async () => runtime)}>
          <DomainSyncStatus />
        </DomainDataProvider>
      </AuthProvider>,
    );

    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Dismiss material-conflict review notice',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText('material-conflict')).not.toBeInTheDocument(),
    );
    act(() => resolveStaleInspection?.());
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(3));
    expect(screen.queryByText('material-conflict')).not.toBeInTheDocument();
  });

  it('does not acknowledge peer teardown until domain, auth, and private query memory are cleared', async () => {
    const runtime = sensitiveRuntime();
    const clearPrivateMemory = vi.fn();
    let onPeerTeardown: ((signal: AbortSignal) => Promise<void>) | undefined;
    const factory: DomainRuntimeFactory = vi.fn(async (options) => {
      onPeerTeardown = options.onPeerTeardown;
      return runtime;
    });
    render(
      <AuthProvider client={authClient('online')}>
        <DomainDataProvider
          clearPrivateMemory={clearPrivateMemory}
          runtimeFactory={factory}
        >
          <MemoryBoundaryProbe />
        </DomainDataProvider>
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('domain-memory')).toHaveTextContent(
        'ready:private-transaction',
      ),
    );

    await act(async () => {
      await onPeerTeardown?.(new AbortController().signal);
    });

    expect(clearPrivateMemory).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('domain-memory')).toHaveTextContent(
      'locked:empty',
    );
    expect(screen.getByTestId('auth-memory')).toHaveTextContent(
      'logout-pending:no-proof:locked:peer-teardown',
    );
    await waitFor(() => expect(runtime.dispose).toHaveBeenCalledTimes(1));
  });

  it('seals decrypted UI state and enters cleanup-only recovery after server logout partially purges', async () => {
    const runtime = sensitiveRuntime('incomplete');
    const recoveryRuntime: DomainDataRuntime = {
      ...sensitiveRuntime(),
      inspect: vi.fn(async () =>
        createDomainRuntimeSnapshot({
          pendingCount: 1,
          spaces: [],
          replication: startingReplication,
        }),
      ),
      applyLocalMutation: vi.fn(async () => {
        throw new Error('Recovery cannot edit');
      }),
    };
    const clearPrivateMemory = vi.fn();
    render(
      <AuthProvider client={authClient('online')}>
        <DomainDataProvider
          clearPrivateMemory={clearPrivateMemory}
          recoveryFactory={vi.fn(async () => recoveryRuntime)}
          runtimeFactory={vi.fn(async () => runtime)}
        >
          <MemoryBoundaryProbe />
        </DomainDataProvider>
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('domain-memory')).toHaveTextContent(
        'ready:private-transaction',
      ),
    );

    await userEvent.click(
      screen.getByRole('button', { name: 'Finish logout' }),
    );

    expect(clearPrivateMemory).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('auth-memory')).toHaveTextContent(
      /logout-pending:no-proof:.*:local-cleanup-pending/u,
    );
    expect(await screen.findByTestId('domain-memory')).toHaveTextContent(
      'logout-recovery:empty',
    );
    expect(
      screen.queryByText('Private household expense'),
    ).not.toBeInTheDocument();
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it('never reuses a same-binding runtime while its last lease is closing', async () => {
    let finishClose = (): void => undefined;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const firstRuntime: DomainDataRuntime = {
      clientId: '33333333-3333-4333-8333-333333333333',
      inspect: async () => createDomainRuntimeSnapshot({ spaces: [space] }),
      applyLocalMutation: async () => undefined,
      syncNow: async () => ({
        status: 'idle',
        submittedCount: 0,
        acceptedOperationIds: [],
        terminalConflicts: [],
        retryableOperations: [],
      }),
      dismissTerminalConflict: async () => undefined,
      subscribeSnapshotInvalidation: () => () => undefined,
      logout: async () => ({ status: 'complete' }),
      dispose: vi.fn(() => closeGate),
    };
    const secondRuntime = {
      ...firstRuntime,
      clientId: '44444444-4444-4444-8444-444444444444',
      dispose: vi.fn(async () => undefined),
    } satisfies DomainDataRuntime;
    const options = {
      sessionBinding: 'e'.repeat(64),
      online: true,
      getCsrfToken: () => 'csrf-token-01234567890123456789',
      authClient: authClient('online'),
      serverSessionKnownRevoked: false,
      onPeerTeardown: async () => undefined,
    };
    const first = await acquireProductionRuntime(
      'editing',
      options,
      async () => firstRuntime,
    );
    const closing = first.dispose();
    const createSecond = vi.fn(async () => secondRuntime);
    const acquiring = acquireProductionRuntime(
      'editing',
      options,
      createSecond,
    );

    await Promise.resolve();
    expect(createSecond).not.toHaveBeenCalled();
    finishClose();
    await closing;
    const second = await acquiring;

    expect(second.clientId).toBe(secondRuntime.clientId);
    expect(createSecond).toHaveBeenCalledTimes(1);
    await second.dispose();
  });

  it('keeps a failed last-reference close retryable and blocks a replacement runtime', async () => {
    let closeAttempts = 0;
    const firstRuntime: DomainDataRuntime = {
      clientId: '33333333-3333-4333-8333-333333333333',
      inspect: async () => createDomainRuntimeSnapshot({ spaces: [space] }),
      applyLocalMutation: async () => undefined,
      syncNow: async () => ({
        status: 'idle',
        submittedCount: 0,
        acceptedOperationIds: [],
        terminalConflicts: [],
        retryableOperations: [],
      }),
      dismissTerminalConflict: async () => undefined,
      subscribeSnapshotInvalidation: () => () => undefined,
      logout: async () => ({ status: 'complete' }),
      dispose: vi.fn(async () => {
        closeAttempts += 1;
        if (closeAttempts === 1)
          throw new Error('offline runtime close failed');
      }),
    };
    const replacementRuntime = {
      ...firstRuntime,
      clientId: '44444444-4444-4444-8444-444444444444',
      dispose: vi.fn(async () => undefined),
    } satisfies DomainDataRuntime;
    const options = {
      sessionBinding: 'f'.repeat(64),
      online: true,
      getCsrfToken: () => 'csrf-token-01234567890123456789',
      authClient: authClient('online'),
      serverSessionKnownRevoked: false,
      onPeerTeardown: async () => undefined,
    };
    const first = await acquireProductionRuntime(
      'editing',
      options,
      async () => firstRuntime,
    );

    await expect(first.dispose()).rejects.toThrow(
      'offline runtime close failed',
    );
    const createReplacement = vi.fn(async () => replacementRuntime);
    await expect(
      acquireProductionRuntime('editing', options, createReplacement),
    ).rejects.toThrow('offline runtime close failed');
    expect(createReplacement).not.toHaveBeenCalled();

    await expect(first.dispose()).resolves.toBeUndefined();
    const replacement = await acquireProductionRuntime(
      'editing',
      options,
      createReplacement,
    );
    expect(replacement.clientId).toBe(replacementRuntime.clientId);
    expect(createReplacement).toHaveBeenCalledTimes(1);
    await replacement.dispose();
  });

  it('turns a UI edit into one validated local-only SyncOperation', async () => {
    const operations: SyncOperation[] = [];
    const factory = runtimeFactory(operations);
    render(
      <AuthProvider client={authClient('online')}>
        <DomainDataProvider runtimeFactory={factory}>
          <ShoppingMutationProbe />
        </DomainDataProvider>
      </AuthProvider>,
    );

    expect(await screen.findByText('ready:0')).toBeVisible();
    await userEvent.click(
      screen.getByRole('button', { name: 'Increase milk' }),
    );
    expect(await screen.findByText('ready:1')).toBeVisible();

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      schemaVersion: 1,
      clientId: '33333333-3333-4333-8333-333333333333',
      entity: { type: 'shopping.item', id: 'milk' },
      mutation: {
        kind: 'delta',
        payload: {
          spaceId: space.id,
          delta: { quantityMinorUnits: 1_000 },
        },
      },
      baseRevision: 0,
      dependencies: [],
      actorIntent: 'Increase milk quantity by one litre',
    });
    expect(JSON.stringify(operations[0])).not.toMatch(
      /google|providerWrite|checkout|householdId|role/iu,
    );
  });

  it('permits encrypted local edits from an active offline binding but blocks network sync', async () => {
    const operations: SyncOperation[] = [];
    const factory = runtimeFactory(operations);
    render(
      <AuthProvider
        client={authClient('offline')}
        inspectOfflineSession={async () => ({
          version: 1,
          status: 'active',
          canEditOffline: true,
          sessionBinding: 'a'.repeat(64),
        })}
        isOnline={() => false}
      >
        <DomainDataProvider runtimeFactory={factory}>
          <ShoppingMutationProbe />
        </DomainDataProvider>
      </AuthProvider>,
    );

    expect(await screen.findByText('offline-ready:0')).toBeVisible();
    await userEvent.click(
      screen.getByRole('button', { name: 'Increase milk' }),
    );
    expect(await screen.findByText('offline-ready:1')).toBeVisible();
    expect(operations).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Sync' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Connect to EMDO before syncing local changes.',
    );
  });

  it('rejects client-supplied authority or provider-action fields before the adapter', async () => {
    const operations: SyncOperation[] = [];
    const factory = runtimeFactory(operations);

    function UnsafeProbe() {
      const domain = useDomainData();
      return (
        <button
          type="button"
          onClick={() =>
            void domain
              .applyMutation({
                domain: 'shopping',
                entityType: 'shopping.item',
                entityId: 'milk',
                kind: 'update',
                data: { providerWrite: true },
                actorIntent: 'Attempt an unsafe shopping edit',
              })
              .catch(() => undefined)
          }
        >
          Unsafe edit
        </button>
      );
    }

    render(
      <AuthProvider client={authClient('online')}>
        <DomainDataProvider runtimeFactory={factory}>
          <UnsafeProbe />
        </DomainDataProvider>
      </AuthProvider>,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Unsafe edit' }),
    );
    await waitFor(() => expect(operations).toHaveLength(0));
  });
});

describe('canonical sync browser transport', () => {
  const pendingOperation: SyncOperation = {
    schemaVersion: 1,
    clientId: '33333333-3333-4333-8333-333333333333',
    operationId: '55555555-5555-4555-8555-555555555555',
    entity: { type: 'shopping.item', id: 'milk' },
    mutation: {
      kind: 'delta',
      payload: { spaceId: space.id, delta: { quantityMinorUnits: 1_000 } },
    },
    baseRevision: 1,
    dependencies: [],
    actorIntent: 'Increase milk by one litre.',
    createdAt: '2026-08-10T12:00:00.000Z',
  };

  it('preserves strict structured terminal outcomes from the canonical API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              schemaVersion: 1,
              clientId: pendingOperation.clientId,
              results: [
                {
                  operationId: pendingOperation.operationId,
                  status: 'conflict',
                  code: 'material-conflict',
                  disposition: 'terminal',
                  currentRevision: 2,
                  conflicts: [{ field: 'quantityMinorUnits', material: true }],
                  replayed: false,
                },
              ],
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const api = createCanonicalSyncApi(() => 'csrf-token-01234567890123456789');

    await expect(
      api.uploadOperations(
        {
          channel: 'api-canonical-write',
          idempotencyKey: `sync.v1.${'a'.repeat(64)}`,
          operations: [pendingOperation],
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      results: [
        {
          operationId: pendingOperation.operationId,
          status: 'conflict',
          code: 'material-conflict',
          disposition: 'terminal',
          currentRevision: 2,
          conflicts: [{ field: 'quantityMinorUnits', material: true }],
          replayed: false,
        },
      ],
    });
  });

  it('rejects an oversized canonical response before buffering it', async () => {
    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{}'));
                controller.close();
              },
              cancel() {
                cancelled = true;
              },
            }),
            {
              headers: {
                'content-length': '9999999',
                'content-type': 'application/json',
              },
            },
          ),
      ),
    );
    const api = createCanonicalSyncApi(() => 'csrf-token-01234567890123456789');

    await expect(
      api.uploadOperations(
        {
          channel: 'api-canonical-write',
          idempotencyKey: `sync.v1.${'b'.repeat(64)}`,
          operations: [pendingOperation],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/bounds|size/i);
    expect(cancelled).toBe(true);
  });

  it('bounds a streamed canonical response when content-length is absent', async () => {
    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(1_048_577));
                controller.enqueue(new Uint8Array(1_048_577));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const api = createCanonicalSyncApi(() => 'csrf-token-01234567890123456789');

    await expect(
      api.uploadOperations(
        {
          channel: 'api-canonical-write',
          idempotencyKey: `sync.v1.${'c'.repeat(64)}`,
          operations: [pendingOperation],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/bounds|size/i);
    expect(cancelled).toBe(true);
  });
});

describe('replicated domain projection', () => {
  function projectionTransaction(
    current?: unknown,
    options: {
      readonly canonical?: unknown;
      readonly pendingOperationIds?: readonly string[];
    } = {},
  ) {
    const execute = vi.fn(
      async (statement: string, parameters?: readonly unknown[]) => {
        void statement;
        void parameters;
      },
    );
    const transaction: EncryptedSqliteConnection = {
      encryption: 'required',
      storage: 'safari-opfs',
      execute,
      query: async <Row,>(
        statement: string,
        parameters: readonly unknown[] = [],
      ): Promise<readonly Row[]> => {
        if (statement.includes('_projection')) {
          return (current === undefined
            ? []
            : [current]) as unknown as readonly Row[];
        }
        if (statement.includes('FROM emdo_pending_sync_operations')) {
          return (options.pendingOperationIds?.includes(parameters[0] as string)
            ? [{ operation_id: parameters[0] }]
            : []) as unknown as readonly Row[];
        }
        if (statement.includes('FROM sync_entities')) {
          return (options.canonical === undefined
            ? []
            : [options.canonical]) as unknown as readonly Row[];
        }
        throw new Error(`Unexpected query: ${statement}`);
      },
      transaction: async (operation) => operation(transaction),
      close: async () => undefined,
    };
    return { execute, transaction };
  }

  function writtenPayload(execute: ReturnType<typeof vi.fn>) {
    const serialized = execute.mock.calls[0]?.[1]?.[4];
    if (typeof serialized !== 'string')
      throw new Error('Projection payload was not written');
    return JSON.parse(serialized) as unknown;
  }

  it('binds the exact space, entity, payload, intent, and operation columns atomically', async () => {
    const { execute, transaction } = projectionTransaction();
    const scheduler = {
      id: 'appointment',
      title: 'Dentist',
      notes: null,
      location: null,
      startsAt: '2026-08-11T16:00:00.000-04:00',
      endsAt: '2026-08-11T17:00:00.000-04:00',
      recurrence: null,
      attendees: [],
      completion: 'open',
    };
    const operation: SyncOperation = {
      schemaVersion: 1,
      clientId: '33333333-3333-4333-8333-333333333333',
      operationId: '99999999-9999-4999-8999-999999999999',
      entity: { type: 'scheduler.item', id: 'appointment' },
      mutation: {
        kind: 'create',
        payload: { spaceId: space.id, value: scheduler },
      },
      baseRevision: 0,
      dependencies: [],
      actorIntent: 'Create a local appointment draft',
      createdAt: '2026-08-10T12:00:00.000Z',
    };

    await applyProjectionMutation(transaction, operation);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toEqual([
      `${space.id}:scheduler.item:appointment`,
      space.id,
      'scheduler.item',
      'appointment',
      JSON.stringify(scheduler),
      'Create a local appointment draft',
      1,
      0,
      '2026-08-10T12:00:00.000Z',
      operation.operationId,
    ]);
  });

  it('applies finance ledger commands without projecting the command envelope', async () => {
    const current = projectionRow({
      id: `${space.id}:finance.transaction:groceries`,
      entity_type: 'finance.transaction',
      entity_id: 'groceries',
      payload_json: JSON.stringify({
        recordType: 'transaction',
        description: 'Groceries',
        category: 'food',
        postedOn: '2026-08-10',
        source: 'manual',
        id: 'groceries',
        currency: 'CAD',
        originalAmountCadMinor: 4_000,
        effectiveAmountCadMinor: 4_000,
        amountConflict: false,
        adjustments: [],
        reversal: null,
        appliedOperationIds: [],
      }),
      revision: 1,
    });
    const { execute, transaction } = projectionTransaction(current);
    const operation: SyncOperation = {
      schemaVersion: 1,
      clientId: '33333333-3333-4333-8333-333333333333',
      operationId: '77777777-7777-4777-8777-777777777777',
      entity: { type: 'finance.transaction', id: 'groceries' },
      mutation: {
        kind: 'update',
        payload: {
          spaceId: space.id,
          patch: {
            ledgerOperation: {
              kind: 'adjustment',
              amountCadMinor: 500,
              reason: 'Correct receipt total',
            },
          },
        },
      },
      baseRevision: 1,
      dependencies: [],
      actorIntent: 'Correct the grocery transaction',
      createdAt: '2026-08-10T12:00:00.000Z',
    };

    await applyProjectionMutation(transaction, operation);

    expect(writtenPayload(execute)).toMatchObject({
      effectiveAmountCadMinor: 4_500,
      adjustments: [
        {
          operationId: operation.operationId,
          amountCadMinor: 500,
          reason: 'Correct receipt total',
        },
      ],
      appliedOperationIds: [operation.operationId],
    });
    expect(writtenPayload(execute)).not.toHaveProperty('ledgerOperation');
  });

  it('resolves the next edit from newer canonical state instead of a stale settled projection', async () => {
    const stale = projectionRow({
      id: `${space.id}:finance.transaction:groceries`,
      entity_type: 'finance.transaction',
      entity_id: 'groceries',
      payload_json: JSON.stringify({
        recordType: 'transaction',
        description: 'Groceries',
        category: 'food',
        postedOn: '2026-08-10',
        source: 'manual',
        id: 'groceries',
        currency: 'CAD',
        originalAmountCadMinor: 4_000,
        effectiveAmountCadMinor: 4_000,
        amountConflict: false,
        adjustments: [],
        reversal: null,
        appliedOperationIds: [],
      }),
      revision: 1,
      last_operation_id: '99999999-9999-4999-8999-999999999999',
    });
    const canonical = {
      payload: JSON.stringify({
        recordType: 'transaction',
        description: 'Groceries',
        category: 'food',
        postedOn: '2026-08-10',
        source: 'manual',
        id: 'groceries',
        currency: 'CAD',
        originalAmountCadMinor: 5_000,
        effectiveAmountCadMinor: 5_000,
        amountConflict: false,
        adjustments: [],
        reversal: null,
        appliedOperationIds: [],
      }),
      revision: 2,
      tombstoned_at: null,
    };
    const { execute, transaction } = projectionTransaction(stale, {
      canonical,
    });
    const operation: SyncOperation = {
      schemaVersion: 1,
      clientId: '33333333-3333-4333-8333-333333333333',
      operationId: '12121212-1212-4212-8212-121212121212',
      entity: { type: 'finance.transaction', id: 'groceries' },
      mutation: {
        kind: 'update',
        payload: {
          spaceId: space.id,
          patch: {
            ledgerOperation: {
              kind: 'adjustment',
              amountCadMinor: 500,
              reason: 'Correct receipt total',
            },
          },
        },
      },
      baseRevision: 2,
      dependencies: [],
      actorIntent: 'Correct the grocery transaction',
      createdAt: '2026-08-10T12:00:00.000Z',
    };

    await applyProjectionMutation(transaction, operation);

    expect(writtenPayload(execute)).toMatchObject({
      effectiveAmountCadMinor: 5_500,
      adjustments: [
        {
          operationId: operation.operationId,
          amountCadMinor: 500,
        },
      ],
    });
  });

  it('projects shopping deltas as the immutable reducer ledger with display metadata', async () => {
    const current = projectionRow({
      id: `${space.id}:shopping.item:milk`,
      entity_type: 'shopping.item',
      entity_id: 'milk',
      payload_json: JSON.stringify({
        itemId: 'milk',
        name: 'Oat milk',
        unit: 'ml',
        retailer: 'Market',
        quantityMinorUnits: 1_000,
        tombstoned: false,
        baseQuantityMinorUnits: 1_000,
        baseTombstoned: false,
        quantityConflict: false,
        appliedOperationIds: [],
        appliedOperations: [],
      }),
      revision: 1,
    });
    const { execute, transaction } = projectionTransaction(current);
    const operation: SyncOperation = {
      schemaVersion: 1,
      clientId: '33333333-3333-4333-8333-333333333333',
      operationId: '66666666-6666-4666-8666-666666666666',
      entity: { type: 'shopping.item', id: 'milk' },
      mutation: {
        kind: 'delta',
        payload: { spaceId: space.id, delta: { quantityMinorUnits: 1_000 } },
      },
      baseRevision: 1,
      dependencies: [],
      actorIntent: 'Add one litre of oat milk',
      createdAt: '2026-08-10T12:00:00.000Z',
    };

    await applyProjectionMutation(transaction, operation);

    expect(writtenPayload(execute)).toEqual({
      itemId: 'milk',
      name: 'Oat milk',
      unit: 'ml',
      retailer: 'Market',
      quantityMinorUnits: 2_000,
      tombstoned: false,
      baseQuantityMinorUnits: 1_000,
      baseTombstoned: false,
      quantityConflict: false,
      appliedOperationIds: [operation.operationId],
      appliedOperations: [
        {
          operationId: operation.operationId,
          kind: 'delta',
          quantityMinorUnits: 1_000,
        },
      ],
    });
  });

  it('records an ignored shopping delta after a tombstone without reviving the item', async () => {
    const tombstoneOperationId = '56565656-5656-4656-8656-565656565656';
    const current = projectionRow({
      id: `${space.id}:shopping.item:milk`,
      entity_type: 'shopping.item',
      entity_id: 'milk',
      payload_json: JSON.stringify({
        itemId: 'milk',
        name: 'Oat milk',
        unit: 'ml',
        retailer: 'Market',
        quantityMinorUnits: 0,
        tombstoned: true,
        baseQuantityMinorUnits: 1_000,
        baseTombstoned: false,
        quantityConflict: false,
        appliedOperationIds: [tombstoneOperationId],
        appliedOperations: [
          { operationId: tombstoneOperationId, kind: 'tombstone' },
        ],
      }),
      revision: 2,
      tombstoned: 1,
      last_operation_id: tombstoneOperationId,
    });
    const { execute, transaction } = projectionTransaction(current);
    const operation: SyncOperation = {
      schemaVersion: 1,
      clientId: '33333333-3333-4333-8333-333333333333',
      operationId: '57575757-5757-4757-8757-575757575757',
      entity: { type: 'shopping.item', id: 'milk' },
      mutation: {
        kind: 'delta',
        payload: { spaceId: space.id, delta: { quantityMinorUnits: 1_000 } },
      },
      baseRevision: 2,
      dependencies: [],
      actorIntent: 'Record a later milk quantity change',
      createdAt: '2026-08-10T12:00:00.000Z',
    };

    await applyProjectionMutation(transaction, operation);

    expect(writtenPayload(execute)).toMatchObject({
      quantityMinorUnits: 0,
      tombstoned: true,
      appliedOperationIds: [tombstoneOperationId, operation.operationId],
      appliedOperations: [
        { operationId: tombstoneOperationId, kind: 'tombstone' },
        {
          operationId: operation.operationId,
          kind: 'delta',
          quantityMinorUnits: 1_000,
        },
      ],
    });
    expect(execute.mock.calls[0]?.[1]?.[7]).toBe(1);
  });

  it('projects the resolved budget local state instead of the base/local envelope', async () => {
    const base = {
      id: 'monthly-budget',
      currency: 'CAD',
      allocationsCadMinor: { food: 40_000 },
    } as const;
    const local = {
      ...base,
      allocationsCadMinor: { food: 45_000 },
    } as const;
    const current = projectionRow({
      id: `${space.id}:finance.budget:${base.id}`,
      entity_type: 'finance.budget',
      entity_id: base.id,
      payload_json: JSON.stringify(base),
      revision: 2,
    });
    const { execute, transaction } = projectionTransaction(current);
    const operation: SyncOperation = {
      schemaVersion: 1,
      clientId: '33333333-3333-4333-8333-333333333333',
      operationId: '44444444-4444-4444-8444-444444444444',
      entity: { type: 'finance.budget', id: base.id },
      mutation: {
        kind: 'update',
        payload: { spaceId: space.id, patch: { base, local } },
      },
      baseRevision: 2,
      dependencies: [],
      actorIntent: 'Raise the food allocation',
      createdAt: '2026-08-10T12:00:00.000Z',
    };

    await applyProjectionMutation(transaction, operation);

    expect(writtenPayload(execute)).toEqual(local);
  });

  it('projects append-only conversation events into their canonical event ledger', async () => {
    const { execute, transaction } = projectionTransaction();
    const operation: SyncOperation = {
      schemaVersion: 1,
      clientId: '33333333-3333-4333-8333-333333333333',
      operationId: '88888888-8888-4888-8888-888888888888',
      entity: { type: 'conversation.event', id: 'message-1' },
      mutation: {
        kind: 'create',
        payload: {
          spaceId: space.id,
          value: { role: 'user', text: 'Add milk to the list' },
        },
      },
      baseRevision: 0,
      dependencies: [],
      actorIntent: 'Append a local conversation event',
      createdAt: '2026-08-10T12:00:00.000Z',
    };

    await applyProjectionMutation(transaction, operation);

    expect(writtenPayload(execute)).toEqual({
      events: [
        {
          operationId: operation.operationId,
          eventId: 'message-1',
          kind: 'append',
          payload: { role: 'user', text: 'Add milk to the list' },
        },
      ],
    });
    expect(execute.mock.calls[0]?.[0]).toContain(
      'emdo_conversation_projection',
    );
  });

  it('rejects incomplete scheduler envelopes before writing any projection', async () => {
    const { execute, transaction } = projectionTransaction();
    const operation: SyncOperation = {
      schemaVersion: 1,
      clientId: '33333333-3333-4333-8333-333333333333',
      operationId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      entity: { type: 'scheduler.item', id: 'appointment' },
      mutation: {
        kind: 'create',
        payload: { spaceId: space.id, value: { title: 'Dentist' } },
      },
      baseRevision: 0,
      dependencies: [],
      actorIntent: 'Create an incomplete appointment',
      createdAt: '2026-08-10T12:00:00.000Z',
    };

    await expect(
      applyProjectionMutation(transaction, operation),
    ).rejects.toThrow(/requires review|domain operation/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it('reads private and shared canonical rows only from server-derived spaces', async () => {
    const records = await readAllDomainRecords(
      domainConnection({
        replicated: [
          replicatedRow(),
          replicatedRow({
            id: '12121212-1212-4121-8121-121212121212',
            space_id: sharedSpace.id,
            original_owner_user_id: '13131313-1313-4131-8131-131313131313',
            entity_type: 'shopping.item',
            entity_id: 'oat-milk',
            payload: JSON.stringify({
              name: 'Oat milk',
              quantityMinorUnits: 1_000,
            }),
            actor_intent: 'Share a grocery item with the household',
          }),
          replicatedRow({
            id: '14141414-1414-4141-8141-141414141414',
            space_id: unrelatedSpace.id,
            original_owner_user_id: unrelatedSpace.originalOwnerUserId,
            entity_id: 'must-not-be-visible',
          }),
        ],
      }),
      [space, sharedSpace],
    );

    expect(records.map(({ id }) => id)).toEqual(['appointment', 'oat-milk']);
    expect(records[0]).toMatchObject({
      domain: 'scheduler',
      spaceId: space.id,
      originalOwnerUserId: space.originalOwnerUserId,
    });
    expect(records[1]).toMatchObject({
      domain: 'shopping',
      spaceId: sharedSpace.id,
      originalOwnerUserId: '13131313-1313-4131-8131-131313131313',
    });
  });

  it('retains replicated tombstones instead of silently deleting history', async () => {
    const records = await readAllDomainRecords(
      domainConnection({
        replicated: [
          replicatedRow({
            tombstoned_at: '2026-08-10T12:01:00.000Z',
            updated_at: '2026-08-10T12:01:00.000Z',
          }),
        ],
      }),
      [space],
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: 'appointment',
      tombstoned: true,
      revision: 2,
    });
  });

  it('overlays a still-pending local edit on its canonical base row', async () => {
    const operationId = '99999999-9999-4999-8999-999999999999';
    const records = await readAllDomainRecords(
      domainConnection({
        replicated: [replicatedRow()],
        pendingOperationIds: [operationId],
        scheduler: [projectionRow({ last_operation_id: operationId })],
      }),
      [space],
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: 'appointment',
      value: { title: 'Local dentist note' },
      revision: 3,
      lastOperationId: operationId,
    });
  });

  it('lets replicated canonical tombstones replace stale accepted local overlays', async () => {
    const records = await readAllDomainRecords(
      domainConnection({
        replicated: [
          replicatedRow({
            revision: 3,
            payload: JSON.stringify({ title: 'Dentist cancelled' }),
            tombstoned_at: '2026-08-10T12:10:00.000Z',
            updated_at: '2026-08-10T12:10:00.000Z',
          }),
        ],
        scheduler: [projectionRow()],
      }),
      [space],
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: 'appointment',
      value: { title: 'Dentist cancelled' },
      revision: 3,
      tombstoned: true,
    });
    expect(records[0]?.lastOperationId).toBeUndefined();
  });
});

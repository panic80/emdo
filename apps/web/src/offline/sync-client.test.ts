import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import {
  ApiOwnedPowerSyncBackendConnector,
  ApiCanonicalSyncClient,
  EncryptedSqlitePendingOperationStore,
  InMemoryPendingOperationStore,
  type CanonicalSyncApi,
  type LocalSqliteConnection,
  type OfflineSyncOperation,
} from './sync-client.js';

const operation = (operationId: string): OfflineSyncOperation => ({
  schemaVersion: 1,
  clientId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
  operationId,
  entity: { type: 'shopping.item', id: `item-${operationId}` },
  mutation: { kind: 'delta', payload: { quantityDelta: 2 } },
  baseRevision: 7,
  dependencies: [],
  actorIntent: 'Add two bottles to the local shopping list.',
  createdAt: '2026-08-09T16:00:00.000Z',
});

const appliedResults = (operations: readonly OfflineSyncOperation[]) => ({
  results: operations.map((item) => ({
    operationId: item.operationId,
    status: 'applied' as const,
    revision: item.baseRevision + 1,
    resolution: 'applied' as const,
    conflicts: [] as const,
    replayed: false,
  })),
});

const jwtFor = (
  clientId: string,
  expiresAtSeconds: number,
  audience = 'emdo-powersync',
): string => {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/u, '');
  return `${encode({ alg: 'RS256', typ: 'JWT', kid: 'sync-key-1' })}.${encode({
    aud: audience,
    clientId,
    exp: expiresAtSeconds,
  })}.${'a'.repeat(43)}`;
};

describe('ApiCanonicalSyncClient', () => {
  it('uses package exports instead of workspace source-layout deep imports', async () => {
    const workingDirectory = process.cwd();
    const webRoot =
      basename(workingDirectory) === 'web' &&
      basename(dirname(workingDirectory)) === 'apps'
        ? workingDirectory
        : resolve(workingDirectory, 'apps/web');
    const source = await readFile(
      resolve(webRoot, 'src/offline/sync-client.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/packages\/[^/]+\/src\//u);
    expect(source).toContain("from '@emdo/contracts/browser'");
  });

  it('uploads local edits only through the canonical API and removes accepted work', async () => {
    const store = new InMemoryPendingOperationStore();
    const uploads: Parameters<CanonicalSyncApi['uploadOperations']>[0][] = [];
    const api: CanonicalSyncApi = {
      uploadOperations: async (request) => {
        uploads.push(request);
        return appliedResults(request.operations);
      },
    };
    const client = new ApiCanonicalSyncClient(store, api);
    const pending = operation('018f1f5e-6f47-7d61-a6dd-1e86f8b8f002');

    await client.queueLocalOperation(pending);
    await expect(client.syncNow()).resolves.toMatchObject({
      status: 'complete',
      submittedCount: 1,
      acceptedOperationIds: [pending.operationId],
    });

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      channel: 'api-canonical-write',
      operations: [pending],
    });
    expect(uploads[0]?.idempotencyKey).toMatch(/^sync\.v1\.[a-f0-9]{64}$/u);
    await expect(client.hasPendingOperations()).resolves.toBe(false);
  });

  it('keeps operations pending when the API cannot make the canonical write', async () => {
    const store = new InMemoryPendingOperationStore();
    const client = new ApiCanonicalSyncClient(store, {
      uploadOperations: async () => {
        throw new Error('offline');
      },
    });
    await client.queueLocalOperation(
      operation('018f1f5e-6f47-7d61-a6dd-1e86f8b8f003'),
    );

    await expect(client.syncNow()).rejects.toThrow('offline');
    await expect(client.hasPendingOperations()).resolves.toBe(true);
  });

  it('keeps operation-in-progress pending and returns only bounded safe reasons', async () => {
    const store = new InMemoryPendingOperationStore();
    const rejectedId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004';
    const client = new ApiCanonicalSyncClient(store, {
      uploadOperations: async () => ({
        results: [
          {
            operationId: rejectedId,
            status: 'conflict',
            code: 'operation-in-progress',
            disposition: 'retryable',
            conflicts: [],
            replayed: false,
          },
        ],
      }),
    });
    await client.queueLocalOperation(operation(rejectedId));

    await expect(client.syncNow()).resolves.toEqual({
      status: 'partial',
      submittedCount: 1,
      acceptedOperationIds: [],
      terminalConflicts: [],
      retryableOperations: [
        {
          operationId: rejectedId,
          status: 'conflict',
          code: 'operation-in-progress',
        },
      ],
    });
    await expect(client.hasPendingOperations()).resolves.toBe(true);
  });

  it('atomically terminalizes a material conflict, rolls back its exact optimistic row, and persists review state', async () => {
    const connection = new TestLocalSqliteConnection();
    const store = new EncryptedSqlitePendingOperationStore(connection);
    const operationId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f112';
    const pending = operation(operationId);
    const client = new ApiCanonicalSyncClient(store, {
      uploadOperations: async () =>
        ({
          results: [
            {
              operationId,
              status: 'conflict',
              code: 'material-conflict',
              disposition: 'terminal',
              currentRevision: 8,
              conflicts: [{ field: 'quantityMinorUnits', material: true }],
              replayed: false,
            },
          ],
        }) as never,
    });
    await client.applyLocalMutation(pending, async (transaction) => {
      await transaction.execute('UPSERT EMDO_TEST_PROJECTION', [
        pending.entity.id,
        pending.operationId,
      ]);
    });

    await expect(client.syncNow()).resolves.toMatchObject({
      status: 'complete',
      acceptedOperationIds: [],
      retryableOperations: [],
      terminalConflicts: [
        {
          operationId,
          status: 'conflict',
          code: 'material-conflict',
          currentRevision: 8,
          conflicts: [{ field: 'quantityMinorUnits', material: true }],
        },
      ],
    });
    await expect(client.hasPendingOperations()).resolves.toBe(false);
    expect(
      connection.getProjectionOperationId(pending.entity.id),
    ).toBeUndefined();

    const reopenedStore = new EncryptedSqlitePendingOperationStore(connection);
    const reopenedClient = new ApiCanonicalSyncClient(reopenedStore, {
      uploadOperations: async () => ({ results: [] }) as never,
    });
    await expect(reopenedClient.listTerminalConflicts()).resolves.toEqual([
      {
        operationId,
        status: 'conflict',
        code: 'material-conflict',
        currentRevision: 8,
        conflicts: [{ field: 'quantityMinorUnits', material: true }],
      },
    ]);
    await reopenedClient.dismissTerminalConflict(operationId);
    await expect(reopenedClient.listTerminalConflicts()).resolves.toEqual([]);
  });

  it('invalidates conflict snapshots after durable settlement and dismissal', async () => {
    const store = new InMemoryPendingOperationStore();
    const operationId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f117';
    const client = new ApiCanonicalSyncClient(store, {
      uploadOperations: async () =>
        ({
          results: [
            {
              operationId,
              status: 'conflict',
              code: 'material-conflict',
              disposition: 'terminal',
              conflicts: [{ field: 'quantityMinorUnits', material: true }],
              replayed: false,
            },
          ],
        }) as never,
    });
    const snapshots: number[] = [];
    const unsubscribe = client.subscribeSnapshotInvalidation(() => {
      snapshots.push(snapshots.length + 1);
    });
    await client.queueLocalOperation(operation(operationId));

    await client.syncNow();
    await client.dismissTerminalConflict(operationId);
    unsubscribe();
    await client.queueLocalOperation(
      operation('018f1f5e-6f47-7d61-a6dd-1e86f8b8f118'),
    );

    expect(snapshots).toEqual([1, 2]);
  });

  it.each([
    {
      status: 'conflict' as const,
      code: 'operation-in-progress' as const,
      disposition: 'retryable' as const,
      replayed: false,
    },
    {
      status: 'blocked' as const,
      code: 'dependency-missing' as const,
      disposition: 'retryable' as const,
      dependencyOperationId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f114',
      replayed: false as const,
    },
  ])(
    'keeps the retryable $code outcome and its optimistic row pending',
    async (outcome) => {
      const connection = new TestLocalSqliteConnection();
      const store = new EncryptedSqlitePendingOperationStore(connection);
      const operationId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f113';
      const pending = operation(operationId);
      const client = new ApiCanonicalSyncClient(store, {
        uploadOperations: async () =>
          ({
            results: [
              {
                operationId,
                ...outcome,
                conflicts: [],
              },
            ],
          }) as never,
      });
      await client.applyLocalMutation(pending, async (transaction) => {
        await transaction.execute('UPSERT EMDO_TEST_PROJECTION', [
          pending.entity.id,
          pending.operationId,
        ]);
      });

      await expect(client.syncNow()).resolves.toMatchObject({
        status: 'partial',
        acceptedOperationIds: [],
        terminalConflicts: [],
        retryableOperations: [{ operationId, code: outcome.code }],
      });
      await expect(client.hasPendingOperations()).resolves.toBe(true);
      expect(connection.getProjectionOperationId(pending.entity.id)).toBe(
        operationId,
      );
      await expect(client.listTerminalConflicts()).resolves.toEqual([]);
    },
  );

  it('rolls back the entire settlement when terminal conflict persistence fails', async () => {
    const connection = new TestLocalSqliteConnection();
    const store = new EncryptedSqlitePendingOperationStore(connection);
    const operationId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f115';
    const pending = operation(operationId);
    const client = new ApiCanonicalSyncClient(store, {
      uploadOperations: async () =>
        ({
          results: [
            {
              operationId,
              status: 'blocked',
              code: 'authorization-revoked',
              disposition: 'terminal',
              conflicts: [],
              replayed: false,
            },
          ],
        }) as never,
    });
    await client.applyLocalMutation(pending, async (transaction) => {
      await transaction.execute('UPSERT EMDO_TEST_PROJECTION', [
        pending.entity.id,
        pending.operationId,
      ]);
    });
    connection.failNextConflictInsert = true;

    await expect(client.syncNow()).rejects.toThrow(/conflict insert failed/i);
    await expect(client.hasPendingOperations()).resolves.toBe(true);
    await expect(client.listTerminalConflicts()).resolves.toEqual([]);
    expect(connection.getProjectionOperationId(pending.entity.id)).toBe(
      operationId,
    );
  });

  it('fails closed when a terminal code is mislabeled retryable', async () => {
    const store = new InMemoryPendingOperationStore();
    const operationId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f116';
    const client = new ApiCanonicalSyncClient(store, {
      uploadOperations: async () =>
        ({
          results: [
            {
              operationId,
              status: 'conflict',
              code: 'material-conflict',
              disposition: 'retryable',
              conflicts: [],
              replayed: false,
            },
          ],
        }) as never,
    });
    await client.queueLocalOperation(operation(operationId));

    await expect(client.syncNow()).rejects.toThrow(/disposition|outcome/i);
    await expect(client.hasPendingOperations()).resolves.toBe(true);
  });

  it('deduplicates concurrent sync-now requests', async () => {
    const store = new InMemoryPendingOperationStore();
    let uploadCount = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new ApiCanonicalSyncClient(store, {
      uploadOperations: async (request) => {
        uploadCount += 1;
        await gate;
        return appliedResults(request.operations);
      },
    });
    await client.queueLocalOperation(
      operation('018f1f5e-6f47-7d61-a6dd-1e86f8b8f005'),
    );

    const first = client.syncNow();
    const second = client.syncNow();
    release?.();
    await Promise.all([first, second]);

    expect(uploadCount).toBe(1);
  });

  it('rejects malformed operations before they enter the offline queue', async () => {
    const store = new InMemoryPendingOperationStore();
    const client = new ApiCanonicalSyncClient(store, {
      uploadOperations: async () => ({ results: [] }),
    });

    await expect(
      client.queueLocalOperation({
        ...operation('018f1f5e-6f47-7d61-a6dd-1e86f8b8f006'),
        mutation: { kind: 'provider-write', payload: {} },
      } as never),
    ).rejects.toThrow();
    await expect(
      client.queueLocalOperation({
        ...operation('018f1f5e-6f47-7d61-a6dd-1e86f8b8f00b'),
        entity: { type: 'a', id: 'item-1' },
      }),
    ).rejects.toThrow();
    await expect(client.hasPendingOperations()).resolves.toBe(false);
  });

  it('seals local writes during logout and resumes them after a failed logout', async () => {
    const store = new InMemoryPendingOperationStore();
    const client = new ApiCanonicalSyncClient(store, {
      uploadOperations: async () => ({ results: [] }),
    });
    const pending = operation('018f1f5e-6f47-7d61-a6dd-1e86f8b8f007');

    await client.sealForLogout();
    await expect(client.queueLocalOperation(pending)).rejects.toThrow(
      /paused during logout/i,
    );

    client.resumeAfterFailedLogout();
    await expect(client.queueLocalOperation(pending)).resolves.toBeUndefined();
  });

  it('waits for an in-flight upload and blocks ordinary sync after logout sealing', async () => {
    const store = new InMemoryPendingOperationStore();
    let releaseUpload = (): void => undefined;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const client = new ApiCanonicalSyncClient(store, {
      uploadOperations: async (request) => {
        await uploadGate;
        return appliedResults(request.operations);
      },
    });
    await client.queueLocalOperation(
      operation('018f1f5e-6f47-7d61-a6dd-1e86f8b8f00c'),
    );
    const syncing = client.syncNow();
    const sealing = client.sealForLogout();
    let sealCompleted = false;
    void sealing.then(() => {
      sealCompleted = true;
    });
    await Promise.resolve();
    expect(sealCompleted).toBe(false);

    releaseUpload();
    await Promise.all([syncing, sealing]);
    await expect(client.syncNow()).rejects.toThrow(/paused during logout/i);
  });

  it('fails logout sealing when an in-flight durable enqueue fails', async () => {
    let rejectEnqueue!: (error: Error) => void;
    const enqueueGate = new Promise<void>((_resolve, reject) => {
      rejectEnqueue = reject;
    });
    const store = {
      enqueue: async () => enqueueGate,
      listPendingOperations: async () => [],
      settleOutcomes: async () => undefined,
      listTerminalConflicts: async () => [],
      dismissTerminalConflict: async () => undefined,
    };
    const client = new ApiCanonicalSyncClient(store, {
      uploadOperations: async () => ({ results: [] }),
    });
    const enqueue = client.queueLocalOperation(
      operation('018f1f5e-6f47-7d61-a6dd-1e86f8b8f00d'),
    );
    const enqueueFailure = expect(enqueue).rejects.toThrow(
      'durable write failed',
    );
    const sealing = client.sealForLogout();

    rejectEnqueue(new Error('durable write failed'));

    await enqueueFailure;
    await expect(sealing).rejects.toThrow('durable write failed');
  });

  it('binds the batch idempotency key to immutable operation content', async () => {
    const keys: string[] = [];
    const api: CanonicalSyncApi = {
      uploadOperations: async (request) => {
        keys.push(request.idempotencyKey);
        return appliedResults(request.operations);
      },
    };
    const operationId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f008';
    const first = new ApiCanonicalSyncClient(
      new InMemoryPendingOperationStore(),
      api,
    );
    const second = new ApiCanonicalSyncClient(
      new InMemoryPendingOperationStore(),
      api,
    );
    await first.queueLocalOperation(operation(operationId));
    await second.queueLocalOperation({
      ...operation(operationId),
      mutation: { kind: 'delta', payload: { quantityDelta: 3 } },
    });

    await first.syncNow();
    await second.syncNow();

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('rejects cyclic, deeply nested, and oversized JSON payloads', async () => {
    const client = new ApiCanonicalSyncClient(
      new InMemoryPendingOperationStore(),
      {
        uploadOperations: async () => ({ results: [] }),
      },
    );
    const operationId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f009';
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deeplyNested: Record<string, unknown> = {};
    const root = deeplyNested;
    for (let depth = 0; depth < 40; depth += 1) {
      const next: Record<string, unknown> = {};
      deeplyNested.next = next;
      deeplyNested = next;
    }

    await expect(
      client.queueLocalOperation({
        ...operation(operationId),
        mutation: { kind: 'update', payload: cyclic },
      } as never),
    ).rejects.toThrow(/cyclic|bounds/i);
    await expect(
      client.queueLocalOperation({
        ...operation(operationId),
        mutation: { kind: 'update', payload: root },
      } as never),
    ).rejects.toThrow(/depth|bounds/i);
    await expect(
      client.queueLocalOperation({
        ...operation(operationId),
        mutation: { kind: 'update', payload: 'x'.repeat(262_145) },
      }),
    ).rejects.toThrow(/size|bounds/i);
    await expect(
      client.queueLocalOperation({
        ...operation(operationId),
        mutation: { kind: 'update', payload: '\u0000'.repeat(50_000) },
      }),
    ).rejects.toThrow(/size|bounds/i);
  });

  it('persists operationId-to-canonical-payload bindings in encrypted local SQLite', async () => {
    const connection = new TestLocalSqliteConnection();
    const firstStore = new EncryptedSqlitePendingOperationStore(connection);
    const pending = operation('018f1f5e-6f47-7d61-a6dd-1e86f8b8f00a');
    await firstStore.enqueue(pending);

    const reopenedStore = new EncryptedSqlitePendingOperationStore(connection);
    await expect(reopenedStore.listPendingOperations()).resolves.toEqual([
      pending,
    ]);
    await expect(
      reopenedStore.enqueue({
        ...pending,
        mutation: { kind: 'delta', payload: { quantityDelta: 99 } },
      }),
    ).rejects.toThrow(/different canonical payload/i);

    await reopenedStore.settleOutcomes([
      {
        operationId: pending.operationId,
        status: 'applied',
        revision: pending.baseRevision + 1,
        resolution: 'applied',
        conflicts: [],
        replayed: false,
      },
    ]);
    await expect(reopenedStore.listPendingOperations()).resolves.toEqual([]);
  });

  it('initializes the durable queue schema before application code reads it directly', async () => {
    const connection = new TestLocalSqliteConnection();
    const store = new EncryptedSqlitePendingOperationStore(connection);

    await Promise.all([store.initialize(), store.initialize()]);

    expect(connection.schemaInitializationCount).toBe(2);
  });

  it('atomically persists a domain projection and its exact canonical sync operation', async () => {
    const connection = new TestLocalSqliteConnection();
    const store = new EncryptedSqlitePendingOperationStore(connection);
    const pending = operation('018f1f5e-6f47-7d61-a6dd-1e86f8b8f00e');
    let projectionApplications = 0;

    await store.applyLocalMutation(
      pending,
      async (transaction, exactOperation) => {
        projectionApplications += 1;
        expect(Object.isFrozen(exactOperation)).toBe(true);
        expect(exactOperation).toEqual(pending);
        await transaction.execute('UPSERT EMDO_TEST_DOMAIN', [
          exactOperation.entity.id,
          'three bottles',
        ]);
      },
    );
    await store.applyLocalMutation(pending, async () => {
      projectionApplications += 1;
    });

    expect(connection.getDomainValue(pending.entity.id)).toBe('three bottles');
    await expect(store.listPendingOperations()).resolves.toEqual([pending]);
    expect(projectionApplications).toBe(1);
    expect(connection.transactionCount).toBe(2);
  });

  it('rolls back the domain projection when durable queue insertion fails', async () => {
    const connection = new TestLocalSqliteConnection();
    const store = new EncryptedSqlitePendingOperationStore(connection);
    const pending = operation('018f1f5e-6f47-7d61-a6dd-1e86f8b8f00f');
    connection.failNextPendingInsert = true;

    await expect(
      store.applyLocalMutation(pending, async (transaction) => {
        await transaction.execute('UPSERT EMDO_TEST_DOMAIN', [
          pending.entity.id,
          'must roll back',
        ]);
      }),
    ).rejects.toThrow(/queue insert failed/i);

    expect(connection.getDomainValue(pending.entity.id)).toBeUndefined();
    await expect(store.listPendingOperations()).resolves.toEqual([]);
  });

  it('tracks atomic domain mutations in the logout local-write boundary', async () => {
    const connection = new TestLocalSqliteConnection();
    const store = new EncryptedSqlitePendingOperationStore(connection);
    const client = new ApiCanonicalSyncClient(store, {
      uploadOperations: async () => ({ results: [] }),
    });
    let releaseMutation = (): void => undefined;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutation = client.applyLocalMutation(
      operation('018f1f5e-6f47-7d61-a6dd-1e86f8b8f010'),
      async () => mutationGate,
    );
    const sealing = client.sealForLogout();
    let sealed = false;
    void sealing.then(() => {
      sealed = true;
    });
    await Promise.resolve();
    expect(sealed).toBe(false);

    releaseMutation();
    await Promise.all([mutation, sealing]);
    await expect(
      client.applyLocalMutation(
        operation('018f1f5e-6f47-7d61-a6dd-1e86f8b8f011'),
        async () => undefined,
      ),
    ).rejects.toThrow(/paused during logout/i);
  });
});

describe('ApiOwnedPowerSyncBackendConnector', () => {
  const clientId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f101';
  const sessionBinding = 'b'.repeat(64);
  const expectedEndpoint = 'https://sync.emdo.example/powersync';
  const now = new Date('2026-08-10T04:00:00.000Z');

  const makeSyncClient = () => {
    const store = new InMemoryPendingOperationStore();
    const sync = new ApiCanonicalSyncClient(store, {
      uploadOperations: async (request) => appliedResults(request.operations),
    });
    return { store, sync };
  };

  it('fetches fresh same-origin PowerSync credentials bound to the registered client', async () => {
    const { sync } = makeSyncClient();
    const expiresAtSeconds = Math.floor(now.getTime() / 1_000) + 300;
    const requests: Array<{
      readonly input: string;
      readonly init?: RequestInit;
    }> = [];
    const connector = new ApiOwnedPowerSyncBackendConnector({
      clientId,
      sessionBinding,
      expectedEndpoint,
      sync,
      now: () => now.getTime(),
      fetcher: async (input, init) => {
        requests.push({ input: String(input), ...(init ? { init } : {}) });
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            endpoint: 'https://sync.emdo.example/powersync',
            token: jwtFor(clientId, expiresAtSeconds),
            expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
            writeScope: {
              clientId,
              spaces: [
                {
                  id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f102',
                  visibility: 'private',
                  originalOwnerUserId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f103',
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    await expect(connector.fetchCredentials()).resolves.toEqual({
      endpoint: 'https://sync.emdo.example/powersync',
      token: jwtFor(clientId, expiresAtSeconds),
      expiresAt: new Date(expiresAtSeconds * 1_000),
    });
    await connector.fetchCredentials();

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      input: `/api/v1/sync/token?clientId=${clientId}`,
      init: {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      },
    });
  });

  it('preserves the browser receiver required by a native credential fetcher', async () => {
    const { sync } = makeSyncClient();
    const expiresAtSeconds = Math.floor(now.getTime() / 1_000) + 300;
    const receiverSensitiveFetch = async function (
      this: unknown,
    ): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          endpoint: expectedEndpoint,
          token: jwtFor(clientId, expiresAtSeconds),
          expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
          writeScope: {
            clientId,
            spaces: [
              {
                id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f102',
                visibility: 'private',
                originalOwnerUserId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f103',
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const connector = new ApiOwnedPowerSyncBackendConnector({
      clientId,
      sessionBinding,
      expectedEndpoint,
      sync,
      now: () => now.getTime(),
      fetcher: receiverSensitiveFetch as typeof fetch,
    });

    await expect(connector.fetchCredentials()).resolves.toMatchObject({
      endpoint: expectedEndpoint,
    });
  });

  it('rejects credentials with the wrong audience or client binding', async () => {
    const { sync } = makeSyncClient();
    const expiresAtSeconds = Math.floor(now.getTime() / 1_000) + 300;
    const connector = new ApiOwnedPowerSyncBackendConnector({
      clientId,
      sessionBinding,
      expectedEndpoint,
      sync,
      now: () => now.getTime(),
      fetcher: async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            endpoint: 'https://sync.emdo.example/powersync',
            token: jwtFor(clientId, expiresAtSeconds, 'another-service'),
            expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
            writeScope: { clientId, spaces: [] },
          }),
          { status: 200 },
        ),
    });

    await expect(connector.fetchCredentials()).rejects.toThrow(
      /audience|credential/i,
    );
  });

  it('drains only the canonical API queue and rejects direct PowerSync CRUD writes', async () => {
    const { sync } = makeSyncClient();
    const pending = operation('018f1f5e-6f47-7d61-a6dd-1e86f8b8f104');
    await sync.queueLocalOperation(pending);
    const connector = new ApiOwnedPowerSyncBackendConnector({
      clientId,
      sessionBinding,
      expectedEndpoint,
      sync,
      fetcher: async () => {
        throw new Error('not used');
      },
    });

    await connector.uploadData({
      getCrudBatch: async () => null,
    } as never);
    await expect(sync.hasPendingOperations()).resolves.toBe(false);

    await expect(
      connector.uploadData({
        getCrudBatch: async () => ({ crud: [{ table: 'sync_entities' }] }),
      } as never),
    ).rejects.toThrow(/direct PowerSync|canonical API/i);
  });

  it('fails closed after logout sealing and can resume only after a failed logout', async () => {
    const { sync } = makeSyncClient();
    const connector = new ApiOwnedPowerSyncBackendConnector({
      clientId,
      sessionBinding,
      expectedEndpoint,
      sync,
      fetcher: async () => {
        throw new Error('not used');
      },
    });

    connector.sealForLogout();
    await expect(
      connector.uploadData({ getCrudBatch: async () => null } as never),
    ).rejects.toThrow(/sealed|logout/i);
    connector.resumeAfterFailedLogout();
    await expect(
      connector.uploadData({ getCrudBatch: async () => null } as never),
    ).resolves.toBeUndefined();
    connector.dispose();
    connector.resumeAfterFailedLogout();
    await expect(
      connector.uploadData({ getCrudBatch: async () => null } as never),
    ).rejects.toThrow(/disposed/i);
  });

  it('aborts in-flight credential fetches at logout and uses a new generation after resume', async () => {
    const { sync } = makeSyncClient();
    const expiresAtSeconds = Math.floor(now.getTime() / 1_000) + 300;
    let requestCount = 0;
    const connector = new ApiOwnedPowerSyncBackendConnector({
      clientId,
      sessionBinding,
      expectedEndpoint,
      sync,
      now: () => now.getTime(),
      fetcher: async (_input, init) => {
        requestCount += 1;
        if (requestCount === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new Error('credential request aborted')),
              { once: true },
            );
          });
        }
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            endpoint: 'https://sync.emdo.example/powersync',
            token: jwtFor(clientId, expiresAtSeconds),
            expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
            writeScope: { clientId, spaces: [] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const pending = connector.fetchCredentials();
    connector.sealForLogout();
    await expect(pending).rejects.toThrow(/aborted|sealed|logout/i);
    connector.resumeAfterFailedLogout();
    await expect(connector.fetchCredentials()).resolves.toMatchObject({
      endpoint: 'https://sync.emdo.example/powersync',
    });
    expect(requestCount).toBe(2);
  });

  it('rejects endpoint drift from the exact configured same-origin service path', async () => {
    const { sync } = makeSyncClient();
    const expiresAtSeconds = Math.floor(now.getTime() / 1_000) + 300;
    const connector = new ApiOwnedPowerSyncBackendConnector({
      clientId,
      sessionBinding,
      expectedEndpoint,
      sync,
      now: () => now.getTime(),
      fetcher: async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            endpoint: 'https://attacker.example/powersync',
            token: jwtFor(clientId, expiresAtSeconds),
            expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
            writeScope: { clientId, spaces: [] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(connector.fetchCredentials()).rejects.toThrow(
      /configured|endpoint/i,
    );
  });

  it('rejects oversized credential bodies before buffering and cancels the body', async () => {
    const { sync } = makeSyncClient();
    let bodyCancelled = false;
    const connector = new ApiOwnedPowerSyncBackendConnector({
      clientId,
      sessionBinding,
      expectedEndpoint,
      sync,
      fetcher: async () =>
        new Response(
          new ReadableStream({
            pull: () => undefined,
            cancel: () => {
              bodyCancelled = true;
            },
          }),
          {
            status: 200,
            headers: {
              'content-length': '999999',
              'content-type': 'application/json',
            },
          },
        ),
    });

    await expect(connector.fetchCredentials()).rejects.toThrow(/bounds|size/i);
    expect(bodyCancelled).toBe(true);
  });

  it('bounds streamed credential bytes when content-length is absent', async () => {
    const { sync } = makeSyncClient();
    const connector = new ApiOwnedPowerSyncBackendConnector({
      clientId,
      sessionBinding,
      expectedEndpoint,
      sync,
      fetcher: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(65_537).fill(97));
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    });

    await expect(connector.fetchCredentials()).rejects.toThrow(/bounds|size/i);
  });

  it('hard-times-out credential and upload operations even when dependencies ignore abort', async () => {
    const never = new Promise<never>(() => undefined);
    const store = new InMemoryPendingOperationStore();
    let uploadAttempts = 0;
    const sync = new ApiCanonicalSyncClient(store, {
      uploadOperations: async (request) => {
        uploadAttempts += 1;
        if (uploadAttempts === 1) return never;
        return appliedResults(request.operations);
      },
    });
    await sync.queueLocalOperation(
      operation('018f1f5e-6f47-7d61-a6dd-1e86f8b8f105'),
    );
    const connector = new ApiOwnedPowerSyncBackendConnector({
      clientId,
      sessionBinding,
      expectedEndpoint,
      sync,
      credentialTimeoutMs: 20,
      uploadTimeoutMs: 20,
      fetcher: async () => never,
    });

    await expect(connector.fetchCredentials()).rejects.toThrow(/timed out/i);
    await expect(
      connector.uploadData({ getCrudBatch: async () => null } as never),
    ).rejects.toThrow(/timed out/i);
    await expect(sync.hasPendingOperations()).resolves.toBe(true);
    await expect(
      connector.uploadData({ getCrudBatch: async () => null } as never),
    ).resolves.toBeUndefined();
    await expect(sync.hasPendingOperations()).resolves.toBe(false);
  });
});

interface PendingRow {
  operation_id: string;
  canonical_hash: string;
  canonical_payload: string;
  sequence: number;
}

interface TerminalConflictRow {
  operation_id: string;
  outcome_status: 'conflict' | 'blocked';
  code: string;
  current_revision: number | null;
  conflicts_json: string;
  sequence: number;
}

class TestLocalSqliteConnection implements LocalSqliteConnection {
  readonly encryption = 'required' as const;
  readonly storage = 'safari-opfs' as const;
  private readonly rows = new Map<string, PendingRow>();
  private readonly domainValues = new Map<string, string>();
  private readonly projectionOperationIds = new Map<string, string>();
  private readonly terminalConflicts = new Map<string, TerminalConflictRow>();
  private nextSequence = 1;
  private nextConflictSequence = 1;
  transactionCount = 0;
  schemaInitializationCount = 0;
  failNextPendingInsert = false;
  failNextConflictInsert = false;

  getDomainValue(id: string): string | undefined {
    return this.domainValues.get(id);
  }

  getProjectionOperationId(id: string): string | undefined {
    return this.projectionOperationIds.get(id);
  }

  async close(): Promise<void> {
    return undefined;
  }

  async execute(statement: string, parameters: readonly unknown[] = []) {
    if (statement.includes('CREATE TABLE')) {
      this.schemaInitializationCount += 1;
      return;
    }
    if (statement.includes('INSERT INTO emdo_pending_sync_operations')) {
      if (this.failNextPendingInsert) {
        this.failNextPendingInsert = false;
        throw new Error('queue insert failed');
      }
      const [operationId, canonicalHash, canonicalPayload] = parameters as [
        string,
        string,
        string,
      ];
      this.rows.set(operationId, {
        operation_id: operationId,
        canonical_hash: canonicalHash,
        canonical_payload: canonicalPayload,
        sequence: this.nextSequence,
      });
      this.nextSequence += 1;
      return;
    }
    if (statement === 'UPSERT EMDO_TEST_DOMAIN') {
      const [id, value] = parameters as [string, string];
      this.domainValues.set(id, value);
      return;
    }
    if (statement === 'UPSERT EMDO_TEST_PROJECTION') {
      const [id, operationId] = parameters as [string, string];
      this.projectionOperationIds.set(id, operationId);
      return;
    }
    if (statement.includes('INSERT INTO emdo_terminal_sync_conflicts')) {
      if (this.failNextConflictInsert) {
        this.failNextConflictInsert = false;
        throw new Error('conflict insert failed');
      }
      const [operationId, status, code, currentRevision, conflictsJson] =
        parameters as [
          string,
          'conflict' | 'blocked',
          string,
          number | null,
          string,
        ];
      this.terminalConflicts.set(operationId, {
        operation_id: operationId,
        outcome_status: status,
        code,
        current_revision: currentRevision,
        conflicts_json: conflictsJson,
        sequence: this.nextConflictSequence,
      });
      this.nextConflictSequence += 1;
      return;
    }
    if (
      statement.includes('DELETE FROM emdo_scheduler_projection') ||
      statement.includes('DELETE FROM emdo_finance_projection') ||
      statement.includes('DELETE FROM emdo_shopping_projection') ||
      statement.includes('DELETE FROM emdo_conversation_projection')
    ) {
      const operationId = parameters.at(-1) as string;
      for (const [id, exactOperationId] of this.projectionOperationIds) {
        if (exactOperationId === operationId)
          this.projectionOperationIds.delete(id);
      }
      return;
    }
    if (statement.includes('DELETE FROM emdo_pending_sync_operations')) {
      this.rows.delete(parameters[0] as string);
      return;
    }
    if (statement.includes('DELETE FROM emdo_terminal_sync_conflicts')) {
      this.terminalConflicts.delete(parameters[0] as string);
      return;
    }
    throw new Error(`Unexpected statement: ${statement}`);
  }

  async query<Row>(statement: string, parameters: readonly unknown[] = []) {
    if (statement.includes('FROM emdo_terminal_sync_conflicts')) {
      const rows = [...this.terminalConflicts.values()]
        .sort((left, right) => left.sequence - right.sequence)
        .map(({ sequence, ...row }) => {
          void sequence;
          return row;
        });
      if (statement.includes('WHERE operation_id = ?')) {
        const row = this.terminalConflicts.get(parameters[0] as string);
        if (row === undefined) return [];
        const { sequence, ...selected } = row;
        void sequence;
        return [selected] as Row[];
      }
      const limit = parameters[0] as number | undefined;
      return (limit === undefined ? rows : rows.slice(0, limit)) as Row[];
    }
    if (statement.includes('WHERE operation_id = ?')) {
      const row = this.rows.get(parameters[0] as string);
      return (row === undefined ? [] : [row]) as Row[];
    }
    if (statement.includes('ORDER BY sequence')) {
      const limit = parameters[0] as number;
      return [...this.rows.values()]
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, limit) as Row[];
    }
    throw new Error(`Unexpected query: ${statement}`);
  }

  async transaction<Value>(
    operation: (connection: LocalSqliteConnection) => Promise<Value>,
  ): Promise<Value> {
    this.transactionCount += 1;
    const rowsBefore = new Map(this.rows);
    const domainValuesBefore = new Map(this.domainValues);
    const projectionsBefore = new Map(this.projectionOperationIds);
    const conflictsBefore = new Map(this.terminalConflicts);
    const sequenceBefore = this.nextSequence;
    const conflictSequenceBefore = this.nextConflictSequence;
    try {
      return await operation(this);
    } catch (error) {
      this.rows.clear();
      for (const [key, value] of rowsBefore) {
        this.rows.set(key, value);
      }
      this.domainValues.clear();
      for (const [key, value] of domainValuesBefore) {
        this.domainValues.set(key, value);
      }
      this.projectionOperationIds.clear();
      for (const [key, value] of projectionsBefore) {
        this.projectionOperationIds.set(key, value);
      }
      this.terminalConflicts.clear();
      for (const [key, value] of conflictsBefore) {
        this.terminalConflicts.set(key, value);
      }
      this.nextSequence = sequenceBefore;
      this.nextConflictSequence = conflictSequenceBefore;
      throw error;
    }
  }
}

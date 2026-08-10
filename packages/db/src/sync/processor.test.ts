import { describe, expect, it } from 'vitest';

import { CanonicalSyncUploadValidator } from './operations.js';
import {
  SyncUploadProcessor,
  type OfflineSyncExecutionContext,
  type ResolvedSyncWriteScope,
  type StoredSyncOperationOutcome,
  type SyncExecuteOnceInput,
  type SyncExecuteOnceResult,
  type SyncOperationProcessorRepository,
} from './processor.js';

const CLIENT_A = '40000000-0000-4000-8000-000000000001';
const CLIENT_B = '40000000-0000-4000-8000-000000000002';
const USER_ID = '40000000-0000-4000-8000-000000000003';
const HOUSEHOLD_ID = '40000000-0000-4000-8000-000000000004';
const SPACE_ID = '40000000-0000-4000-8000-000000000005';
const SESSION_ID = '40000000-0000-4000-8000-000000000006';
const REQUEST_ID = '40000000-0000-4000-8000-000000000007';
const OTHER_PRIVATE_SPACE_ID = '40000000-0000-4000-8000-000000000008';

const processContext = (authenticatedClientId: string) => ({
  authenticatedClientId,
  authenticatedSessionId: SESSION_ID,
  requestId: REQUEST_ID,
});

const op = (input: {
  clientId: string;
  operationId: string;
  entityId?: string;
  spaceId?: string;
  kind?: 'create' | 'update' | 'delete' | 'delta';
  baseRevision?: number;
  dependencies?: string[];
  payload?: Record<string, unknown>;
  createdAt?: string;
}) => {
  const kind = input.kind ?? 'update';
  const localData = input.payload ?? { quantity: 2 };
  const spaceId = input.spaceId ?? SPACE_ID;
  const payload =
    kind === 'create'
      ? { spaceId, value: localData }
      : kind === 'update'
        ? { spaceId, patch: localData }
        : kind === 'delta'
          ? { spaceId, delta: localData }
          : { spaceId };
  return {
    schemaVersion: 1,
    clientId: input.clientId,
    operationId: input.operationId,
    entity: { type: 'shopping.item', id: input.entityId ?? 'milk' },
    mutation: { kind, payload },
    baseRevision: input.baseRevision ?? 1,
    dependencies: input.dependencies ?? [],
    actorIntent: 'Synchronize a shopping list edit',
    createdAt: input.createdAt ?? '2026-08-09T12:00:00.000Z',
  };
};

class InMemorySyncRepository implements SyncOperationProcessorRepository {
  readonly receipts = new Map<
    string,
    { fingerprint: string; outcome: StoredSyncOperationOutcome }
  >();
  readonly entities = new Map<
    string,
    { revision: number; payload: unknown; tombstoned: boolean }
  >();
  readonly processingLog: string[] = [];
  readonly contexts: OfflineSyncExecutionContext[] = [];
  mutationCount = 0;
  dependencyLookupCount = 0;
  authorizationActive = true;
  revokeAfterOperationId?: string;

  private key(clientId: string, operationId: string) {
    return `${clientId}:${operationId}`;
  }

  async resolveWriteScope(input: {
    authenticatedSessionId: string;
    clientId: string;
  }): Promise<ResolvedSyncWriteScope | undefined> {
    if (
      !this.authorizationActive ||
      input.authenticatedSessionId !== SESSION_ID ||
      (input.clientId !== CLIENT_A && input.clientId !== CLIENT_B)
    ) {
      return undefined;
    }
    return {
      userId: USER_ID,
      householdId: HOUSEHOLD_ID,
      role: 'owner' as const,
      writableSpaces: [
        {
          id: SPACE_ID,
          householdId: HOUSEHOLD_ID,
          visibility: 'private' as const,
          originalOwnerUserId: USER_ID,
        },
      ],
    };
  }

  async getStoredOutcomes(input: {
    clientId: string;
    operationIds: readonly string[];
  }) {
    this.dependencyLookupCount += 1;
    return new Map(
      input.operationIds.flatMap((operationId) => {
        const receipt = this.receipts.get(
          this.key(input.clientId, operationId),
        );
        return receipt === undefined ? [] : [[operationId, receipt] as const];
      }),
    );
  }

  async executeOnce(
    input: SyncExecuteOnceInput,
  ): Promise<SyncExecuteOnceResult> {
    if (!this.authorizationActive) return { kind: 'authorization-revoked' };
    const receiptKey = this.key(
      input.operation.clientId,
      input.operation.operationId,
    );
    const existing = this.receipts.get(receiptKey);
    if (existing !== undefined) {
      return existing.fingerprint === input.fingerprint
        ? { kind: 'replay', outcome: existing.outcome }
        : { kind: 'idempotency-key-reused' };
    }

    this.processingLog.push(input.operation.operationId);
    this.contexts.push(input.context);
    const entityKey = `${input.context.householdId}:${input.context.targetSpaceId}:${input.operation.entity.type}:${input.operation.entity.id}`;
    const entity = this.entities.get(entityKey);
    let outcome: StoredSyncOperationOutcome;

    if (input.operation.mutation.kind === 'create') {
      if (input.operation.baseRevision !== 0 || entity !== undefined) {
        outcome = {
          status: 'conflict',
          code: 'entity-exists',
          currentRevision: entity?.revision,
        };
      } else {
        this.entities.set(entityKey, {
          revision: 1,
          payload: input.operation.mutation.payload,
          tombstoned: false,
        });
        this.mutationCount += 1;
        outcome = { status: 'applied', revision: 1 };
      }
    } else if (entity === undefined || entity.tombstoned) {
      outcome = { status: 'conflict', code: 'entity-not-found' };
    } else if (entity.revision !== input.operation.baseRevision) {
      outcome = {
        status: 'conflict',
        code: 'revision-mismatch',
        currentRevision: entity.revision,
      };
    } else {
      entity.revision += 1;
      entity.payload = input.operation.mutation.payload;
      entity.tombstoned = input.operation.mutation.kind === 'delete';
      this.mutationCount += 1;
      outcome = { status: 'applied', revision: entity.revision };
    }

    this.receipts.set(receiptKey, { fingerprint: input.fingerprint, outcome });
    if (input.operation.operationId === this.revokeAfterOperationId) {
      this.authorizationActive = false;
    }
    return { kind: 'executed', outcome };
  }
}

const createProcessor = (repository: InMemorySyncRepository) =>
  new SyncUploadProcessor({
    validator: new CanonicalSyncUploadValidator({
      currentSchemaVersion: 1,
      clock: { now: () => new Date('2026-08-09T12:05:00.000Z') },
    }),
    repository,
  });

describe('SyncUploadProcessor', () => {
  it('orders dependencies deterministically even when uploads arrive reversed', async () => {
    const repository = new InMemorySyncRepository();
    const processor = createProcessor(repository);
    const firstId = '40000000-0000-4000-8000-000000000010';
    const secondId = '40000000-0000-4000-8000-000000000011';

    const result = await processor.process(
      {
        operations: [
          op({
            clientId: CLIENT_A,
            operationId: secondId,
            entityId: 'bread',
            kind: 'update',
            baseRevision: 1,
            dependencies: [firstId],
          }),
          op({
            clientId: CLIENT_A,
            operationId: firstId,
            entityId: 'bread',
            kind: 'create',
            baseRevision: 0,
          }),
        ],
      },
      processContext(CLIENT_A),
    );

    expect(result.results.map((entry) => entry.operationId)).toEqual([
      firstId,
      secondId,
    ]);
    expect(result.results.map((entry) => entry.status)).toEqual([
      'applied',
      'applied',
    ]);
    expect(repository.processingLog).toEqual([firstId, secondId]);
  });

  it('provides explicit dependency-missing, dependency-failed, and cycle feedback', async () => {
    const repository = new InMemorySyncRepository();
    const processor = createProcessor(repository);
    const missing = '40000000-0000-4000-8000-000000000020';
    const blocked = '40000000-0000-4000-8000-000000000021';
    const cycleA = '40000000-0000-4000-8000-000000000022';
    const cycleB = '40000000-0000-4000-8000-000000000023';

    const missingResult = await processor.process(
      {
        operations: [
          op({
            clientId: CLIENT_A,
            operationId: blocked,
            dependencies: [missing],
          }),
        ],
      },
      processContext(CLIENT_A),
    );
    expect(missingResult.results[0]).toMatchObject({
      status: 'blocked',
      code: 'dependency-missing',
      dependencyOperationId: missing,
    });

    const cycleResult = await processor.process(
      {
        operations: [
          op({
            clientId: CLIENT_A,
            operationId: cycleB,
            dependencies: [cycleA],
          }),
          op({
            clientId: CLIENT_A,
            operationId: cycleA,
            dependencies: [cycleB],
          }),
        ],
      },
      processContext(CLIENT_A),
    );
    expect(cycleResult.results).toEqual([
      expect.objectContaining({
        operationId: cycleA,
        status: 'blocked',
        code: 'dependency-cycle',
      }),
      expect.objectContaining({
        operationId: cycleB,
        status: 'blocked',
        code: 'dependency-cycle',
      }),
    ]);

    const conflictId = '40000000-0000-4000-8000-000000000024';
    const dependentId = '40000000-0000-4000-8000-000000000025';
    const failedResult = await processor.process(
      {
        operations: [
          op({
            clientId: CLIENT_A,
            operationId: dependentId,
            dependencies: [conflictId],
          }),
          op({
            clientId: CLIENT_A,
            operationId: conflictId,
            baseRevision: 99,
          }),
        ],
      },
      processContext(CLIENT_A),
    );
    expect(failedResult.results).toEqual([
      expect.objectContaining({
        operationId: conflictId,
        status: 'conflict',
        code: 'entity-not-found',
      }),
      expect.objectContaining({
        operationId: dependentId,
        status: 'blocked',
        code: 'dependency-failed',
        dependencyOperationId: conflictId,
      }),
    ]);
  });

  it('bulk-loads repeated external dependencies once per upload', async () => {
    const repository = new InMemorySyncRepository();
    const missing = '40000000-0000-4000-8000-000000000026';
    const result = await createProcessor(repository).process(
      {
        operations: [
          op({
            clientId: CLIENT_A,
            operationId: '40000000-0000-4000-8000-000000000027',
            dependencies: [missing],
          }),
          op({
            clientId: CLIENT_A,
            operationId: '40000000-0000-4000-8000-000000000028',
            entityId: 'bread',
            dependencies: [missing],
          }),
        ],
      },
      processContext(CLIENT_A),
    );

    expect(result.results).toHaveLength(2);
    expect(result.results).toEqual([
      expect.objectContaining({
        status: 'blocked',
        code: 'dependency-missing',
      }),
      expect.objectContaining({
        status: 'blocked',
        code: 'dependency-missing',
      }),
    ]);
    expect(repository.dependencyLookupCount).toBe(1);
  });

  it('uses client plus operation for idempotency and rejects key reuse', async () => {
    const repository = new InMemorySyncRepository();
    const processor = createProcessor(repository);
    const operationId = '40000000-0000-4000-8000-000000000030';
    const original = op({
      clientId: CLIENT_A,
      operationId,
      kind: 'create',
      baseRevision: 0,
    });

    const first = await processor.process(
      { operations: [original] },
      processContext(CLIENT_A),
    );
    const replay = await processor.process(
      { operations: [original] },
      processContext(CLIENT_A),
    );
    const reused = await processor.process(
      { operations: [op({ ...original, payload: { quantity: 99 } })] },
      processContext(CLIENT_A),
    );

    expect(first.results[0]).toMatchObject({
      status: 'applied',
      revision: 1,
      replayed: false,
    });
    expect(replay.results[0]).toMatchObject({
      status: 'applied',
      revision: 1,
      replayed: true,
    });
    expect(reused.results[0]).toMatchObject({
      status: 'conflict',
      code: 'idempotency-key-reused',
      replayed: false,
    });
    expect(repository.mutationCount).toBe(1);
  });

  it('never gives offline operations authority to enqueue provider writes', async () => {
    const repository = new InMemorySyncRepository();
    const processor = createProcessor(repository);

    await processor.process(
      {
        operations: [
          op({
            clientId: CLIENT_A,
            operationId: '40000000-0000-4000-8000-000000000040',
            kind: 'create',
            baseRevision: 0,
            payload: {
              title: 'Dentist appointment',
            },
          }),
        ],
      },
      processContext(CLIENT_A),
    );

    expect(repository.contexts).toEqual([
      {
        source: 'offline-sync-api',
        externalEffects: 'forbidden',
        mayEnqueueProviderWrites: false,
        authorizationRevalidation: 'required-in-transaction',
        authenticatedUserId: USER_ID,
        authenticatedSessionId: SESSION_ID,
        householdId: HOUSEHOLD_ID,
        role: 'owner',
        requestId: REQUEST_ID,
        writableSpaceIds: [SPACE_ID],
        targetSpaceId: SPACE_ID,
      },
    ]);
  });

  it('fails closed when server write scope is unavailable or the space is not writable', async () => {
    const repository = new InMemorySyncRepository();
    const processor = createProcessor(repository);
    const candidate = op({
      clientId: CLIENT_A,
      operationId: '40000000-0000-4000-8000-000000000041',
      kind: 'create',
      baseRevision: 0,
    });

    await expect(
      processor.process(
        { operations: [candidate] },
        {
          authenticatedClientId: CLIENT_A,
          authenticatedSessionId: '40000000-0000-4000-8000-000000000099',
          requestId: REQUEST_ID,
        },
      ),
    ).rejects.toMatchObject({ code: 'write-scope-unavailable' });

    const crossHouseholdRepository = new InMemorySyncRepository();
    crossHouseholdRepository.resolveWriteScope = async () => ({
      userId: USER_ID,
      householdId: HOUSEHOLD_ID,
      role: 'member',
      writableSpaces: [
        {
          id: SPACE_ID,
          householdId: '40000000-0000-4000-8000-000000000098',
          visibility: 'private',
          originalOwnerUserId: '40000000-0000-4000-8000-000000000097',
        },
      ],
    });
    await expect(
      createProcessor(crossHouseholdRepository).process(
        { operations: [candidate] },
        processContext(CLIENT_A),
      ),
    ).rejects.toMatchObject({ code: 'invalid-write-scope' });

    await expect(
      processor.process(
        {
          operations: [
            op({
              clientId: CLIENT_A,
              operationId: '40000000-0000-4000-8000-000000000042',
              kind: 'create',
              baseRevision: 0,
              spaceId: OTHER_PRIVATE_SPACE_ID,
            }),
          ],
        },
        processContext(CLIENT_A),
      ),
    ).rejects.toMatchObject({ code: 'space-not-writable' });
    expect(repository.mutationCount).toBe(0);
  });

  it('requires transaction-time authorization revalidation for every operation', async () => {
    const repository = new InMemorySyncRepository();
    const firstId = '40000000-0000-4000-8000-000000000043';
    const secondId = '40000000-0000-4000-8000-000000000044';
    repository.revokeAfterOperationId = firstId;

    const result = await createProcessor(repository).process(
      {
        operations: [
          op({
            clientId: CLIENT_A,
            operationId: firstId,
            entityId: 'eggs',
            kind: 'create',
            baseRevision: 0,
          }),
          op({
            clientId: CLIENT_A,
            operationId: secondId,
            entityId: 'eggs',
            kind: 'update',
            baseRevision: 1,
            dependencies: [firstId],
          }),
        ],
      },
      processContext(CLIENT_A),
    );

    expect(result.results).toEqual([
      expect.objectContaining({ operationId: firstId, status: 'applied' }),
      expect.objectContaining({
        operationId: secondId,
        status: 'blocked',
        code: 'authorization-revoked',
      }),
    ]);
    expect(repository.mutationCount).toBe(1);
  });
});

describe('two-device synchronization fixture', () => {
  it('applies one edit, returns a stale-revision conflict to the other device, and replays exactly once', async () => {
    const repository = new InMemorySyncRepository();
    const processor = createProcessor(repository);
    const createId = '40000000-0000-4000-8000-000000000050';
    const deviceBId = '40000000-0000-4000-8000-000000000051';
    const staleAId = '40000000-0000-4000-8000-000000000052';

    await processor.process(
      {
        operations: [
          op({
            clientId: CLIENT_A,
            operationId: createId,
            kind: 'create',
            baseRevision: 0,
          }),
        ],
      },
      processContext(CLIENT_A),
    );
    const deviceBOperation = op({
      clientId: CLIENT_B,
      operationId: deviceBId,
      baseRevision: 1,
      payload: { quantity: 3 },
    });
    const deviceB = await processor.process(
      { operations: [deviceBOperation] },
      processContext(CLIENT_B),
    );
    const staleA = await processor.process(
      {
        operations: [
          op({
            clientId: CLIENT_A,
            operationId: staleAId,
            baseRevision: 1,
            payload: { quantity: 4 },
          }),
        ],
      },
      processContext(CLIENT_A),
    );
    const deviceBReplay = await processor.process(
      { operations: [deviceBOperation] },
      processContext(CLIENT_B),
    );

    expect(deviceB.results[0]).toMatchObject({
      status: 'applied',
      revision: 2,
    });
    expect(staleA.results[0]).toMatchObject({
      status: 'conflict',
      code: 'revision-mismatch',
      currentRevision: 2,
    });
    expect(deviceBReplay.results[0]).toMatchObject({
      status: 'applied',
      revision: 2,
      replayed: true,
    });
    expect(repository.mutationCount).toBe(2);
  });
});

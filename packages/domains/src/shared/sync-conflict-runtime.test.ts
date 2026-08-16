import { describe, expect, it } from 'vitest';

import {
  resolveDeterministicSyncOperation,
  type CanonicalSyncEntityVersion,
} from './sync-conflict-runtime.js';

const ids = {
  client: '70000000-0000-4000-8000-000000000001',
  space: '70000000-0000-4000-8000-000000000002',
  operationA: '70000000-0000-4000-8000-000000000003',
  operationB: '70000000-0000-4000-8000-000000000004',
  operationC: '70000000-0000-4000-8000-000000000005',
} as const;

const operation = (input: {
  readonly entityType: string;
  readonly entityId: string;
  readonly kind: 'create' | 'update' | 'delete' | 'delta';
  readonly data?: Readonly<Record<string, unknown>>;
  readonly operationId?: string;
  readonly baseRevision?: number;
}) => ({
  schemaVersion: 1 as const,
  clientId: ids.client,
  operationId: input.operationId ?? ids.operationA,
  entity: { type: input.entityType, id: input.entityId },
  mutation: {
    kind: input.kind,
    payload:
      input.kind === 'create'
        ? { spaceId: ids.space, value: input.data ?? {} }
        : input.kind === 'update'
          ? { spaceId: ids.space, patch: input.data ?? {} }
          : input.kind === 'delta'
            ? { spaceId: ids.space, delta: input.data ?? {} }
            : { spaceId: ids.space },
  },
  baseRevision: input.baseRevision ?? (input.kind === 'create' ? 0 : 1),
  dependencies: [],
  actorIntent: 'Synchronize a deterministic local-only domain edit.',
  createdAt: '2026-08-10T12:00:00.000Z',
});

const version = (
  payload: CanonicalSyncEntityVersion['payload'],
  revision = 1,
): CanonicalSyncEntityVersion => ({
  payload,
  revision,
  tombstoned: false,
});

const schedulerState = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  id: 'appointment',
  title: 'Dentist',
  notes: null,
  location: null,
  startsAt: '2026-08-11T14:00:00.000-04:00',
  endsAt: '2026-08-11T15:00:00.000-04:00',
  recurrence: null,
  attendees: [],
  completion: 'open',
  ...overrides,
});

describe('deterministic canonical sync resolver', () => {
  it('appends immutable conversation events and exposes no provider authority', () => {
    const result = resolveDeterministicSyncOperation({
      operation: operation({
        entityType: 'conversation.event',
        entityId: 'event-1',
        kind: 'create',
        data: { message: 'Hello' },
      }),
    });

    expect(result).toMatchObject({
      status: 'applied',
      resolution: 'created',
      state: {
        events: [
          {
            operationId: ids.operationA,
            eventId: 'event-1',
            kind: 'append',
            payload: { message: 'Hello' },
          },
        ],
      },
      tombstoned: false,
      conflicts: [],
      providerWrites: [],
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('rejects client-authored audit events because audit is server-owned', () => {
    const result = resolveDeterministicSyncOperation({
      operation: operation({
        entityType: 'audit.event',
        entityId: 'audit-1',
        kind: 'create',
        data: { action: 'shopping.quantity.changed' },
      }),
    });

    expect(result).toEqual({
      status: 'conflict',
      code: 'domain-operation-unsupported',
      disposition: 'terminal',
      conflicts: [],
      providerWrites: [],
    });
  });

  it('creates a strict CAD transaction and only accepts ledger commands later', () => {
    const created = resolveDeterministicSyncOperation({
      operation: operation({
        entityType: 'finance.transaction',
        entityId: 'manual-1',
        kind: 'create',
        data: {
          recordType: 'transaction',
          description: 'Groceries',
          category: 'Food',
          amountCadMinor: 2_500,
          currency: 'CAD',
          postedOn: '2026-08-10',
          source: 'manual',
        },
      }),
    });
    expect(created).toMatchObject({
      status: 'applied',
      resolution: 'created',
      state: {
        id: 'manual-1',
        originalAmountCadMinor: 2_500,
        effectiveAmountCadMinor: 2_500,
        adjustments: [],
        reversal: null,
      },
    });
    if (created.status !== 'applied') throw new Error('expected create');

    const adjusted = resolveDeterministicSyncOperation({
      operation: operation({
        entityType: 'finance.transaction',
        entityId: 'manual-1',
        kind: 'update',
        operationId: ids.operationB,
        data: {
          ledgerOperation: {
            kind: 'adjustment',
            amountCadMinor: -100,
            reason: 'Correct the imported amount.',
          },
        },
      }),
      current: version(created.state),
    });
    expect(adjusted).toMatchObject({
      status: 'applied',
      resolution: 'applied',
      state: {
        effectiveAmountCadMinor: 2_400,
        adjustments: [{ operationId: ids.operationB, amountCadMinor: -100 }],
      },
      providerWrites: [],
    });

    expect(
      resolveDeterministicSyncOperation({
        operation: operation({
          entityType: 'finance.transaction',
          entityId: 'manual-1',
          kind: 'update',
          data: { amountCadMinor: 1 },
        }),
        current: version(created.state),
      }),
    ).toMatchObject({
      status: 'conflict',
      code: 'domain-operation-invalid',
      disposition: 'terminal',
      conflicts: [],
      providerWrites: [],
    });
  });

  it('three-way merges a verified stale budget base against locked remote state', () => {
    const base = {
      id: 'august',
      currency: 'CAD',
      allocationsCadMinor: { groceries: 50_000, transport: 20_000 },
    } as const;
    const local = {
      ...base,
      allocationsCadMinor: { groceries: 55_000, transport: 20_000 },
    } as const;
    const remote = {
      ...base,
      allocationsCadMinor: { groceries: 50_000, transport: 25_000 },
    } as const;
    const result = resolveDeterministicSyncOperation({
      operation: operation({
        entityType: 'finance.budget',
        entityId: 'august',
        kind: 'update',
        baseRevision: 1,
        data: { base, local },
      }),
      base: version(base, 1),
      current: version(remote, 2),
    });

    expect(result).toMatchObject({
      status: 'applied',
      resolution: 'merged',
      state: {
        allocationsCadMinor: { groceries: 55_000, transport: 25_000 },
      },
      conflicts: [],
    });
  });

  it('returns bounded scheduler material conflicts without reflecting values', () => {
    const base = schedulerState();
    const local = schedulerState({
      startsAt: '2026-08-11T16:00:00.000-04:00',
      endsAt: '2026-08-11T17:00:00.000-04:00',
    });
    const remote = schedulerState({
      startsAt: '2026-08-11T18:00:00.000-04:00',
      endsAt: '2026-08-11T19:00:00.000-04:00',
    });
    const result = resolveDeterministicSyncOperation({
      operation: operation({
        entityType: 'scheduler.item',
        entityId: 'appointment',
        kind: 'update',
        data: { base, local },
      }),
      base: version(base),
      current: version(remote, 2),
    });

    expect(result).toEqual({
      status: 'conflict',
      code: 'material-conflict',
      disposition: 'terminal',
      currentRevision: 2,
      conflicts: [{ field: 'time', material: true }],
      providerWrites: [],
    });
    expect(JSON.stringify(result)).not.toContain('2026-08-11T18:00');
  });

  it('applies shopping deltas through the immutable reducer ledger', () => {
    const result = resolveDeterministicSyncOperation({
      operation: operation({
        entityType: 'shopping.item',
        entityId: 'milk',
        kind: 'delta',
        baseRevision: 0,
        data: { quantityMinorUnits: 2_000 },
      }),
    });

    expect(result).toMatchObject({
      status: 'applied',
      resolution: 'created',
      state: {
        itemId: 'milk',
        quantityMinorUnits: 2_000,
        appliedOperationIds: [ids.operationA],
        appliedOperations: [
          {
            operationId: ids.operationA,
            kind: 'delta',
            quantityMinorUnits: 2_000,
          },
        ],
      },
    });
  });

  it('preserves strict shopping display metadata around quantity reduction', () => {
    const current = resolveDeterministicSyncOperation({
      operation: operation({
        entityType: 'shopping.item',
        entityId: 'milk',
        kind: 'create',
        data: {
          name: 'Milk',
          unit: 'carton',
          retailer: 'Market',
          quantityMinorUnits: 1_000,
        },
      }),
    });
    if (current.status !== 'applied') throw new Error('expected create');

    const result = resolveDeterministicSyncOperation({
      operation: operation({
        entityType: 'shopping.item',
        entityId: 'milk',
        operationId: ids.operationB,
        kind: 'delta',
        data: { quantityMinorUnits: 1_000 },
      }),
      current: version(current.state),
    });

    expect(result).toMatchObject({
      status: 'applied',
      state: {
        name: 'Milk',
        unit: 'carton',
        retailer: 'Market',
        quantityMinorUnits: 2_000,
      },
    });
  });

  it('lets the shopping tombstone dominate a later delta while recording the ignored operation', () => {
    const created = resolveDeterministicSyncOperation({
      operation: operation({
        entityType: 'shopping.item',
        entityId: 'milk',
        kind: 'create',
        data: { quantityMinorUnits: 1_000 },
      }),
    });
    if (created.status !== 'applied') throw new Error('expected create');
    const tombstoned = resolveDeterministicSyncOperation({
      operation: operation({
        entityType: 'shopping.item',
        entityId: 'milk',
        operationId: ids.operationB,
        kind: 'delete',
      }),
      current: version(created.state),
    });
    if (tombstoned.status !== 'applied') {
      throw new Error('expected tombstone');
    }

    const ignored = resolveDeterministicSyncOperation({
      operation: operation({
        entityType: 'shopping.item',
        entityId: 'milk',
        operationId: ids.operationC,
        kind: 'delta',
        data: { quantityMinorUnits: 1_000 },
        baseRevision: 2,
      }),
      current: {
        payload: tombstoned.state,
        revision: 2,
        tombstoned: true,
      },
    });

    expect(ignored).toMatchObject({
      status: 'applied',
      resolution: 'ignored',
      tombstoned: true,
      state: {
        quantityMinorUnits: 0,
        tombstoned: true,
        appliedOperationIds: [ids.operationB, ids.operationC],
      },
    });
  });

  it('fails closed for a forged base and unsupported generic entities', () => {
    const actualBase = schedulerState();
    const forgedBase = schedulerState({ title: 'Forged base' });
    expect(
      resolveDeterministicSyncOperation({
        operation: operation({
          entityType: 'scheduler.item',
          entityId: 'appointment',
          kind: 'update',
          data: { base: forgedBase, local: schedulerState({ title: 'Local' }) },
        }),
        base: version(actualBase),
        current: version(actualBase),
      }),
    ).toMatchObject({
      status: 'conflict',
      code: 'base-state-mismatch',
      disposition: 'terminal',
      currentRevision: 1,
    });

    expect(
      resolveDeterministicSyncOperation({
        operation: operation({
          entityType: 'finance.account',
          entityId: 'cash',
          kind: 'create',
          data: { balance: 1_000 },
        }),
      }),
    ).toEqual({
      status: 'conflict',
      code: 'domain-operation-unsupported',
      disposition: 'terminal',
      conflicts: [],
      providerWrites: [],
    });
  });
});

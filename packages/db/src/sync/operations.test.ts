import { describe, expect, it } from 'vitest';

import {
  CanonicalSyncUploadValidator,
  SyncUploadValidationError,
  fingerprintSyncOperation,
} from './operations.js';

const CLIENT_ID = '30000000-0000-4000-8000-000000000001';
const OPERATION_ID = '30000000-0000-4000-8000-000000000002';
const SPACE_ID = '30000000-0000-4000-8000-000000000003';
const validationContext = {
  authenticatedClientId: CLIENT_ID,
  authorizedSpaceIds: [SPACE_ID],
} as const;

const operation = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  clientId: CLIENT_ID,
  operationId: OPERATION_ID,
  entity: { type: 'finance.transaction', id: 'txn-1' },
  mutation: {
    kind: 'update',
    payload: { spaceId: SPACE_ID, patch: { quantity: 2, unit: 'litre' } },
  },
  baseRevision: 1,
  dependencies: [],
  actorIntent: 'Append an adjustment to the household transaction ledger',
  createdAt: '2026-08-09T12:00:00.000Z',
  ...overrides,
});

const validator = new CanonicalSyncUploadValidator({
  currentSchemaVersion: 1,
  clock: { now: () => new Date('2026-08-09T12:01:00.000Z') },
});

describe('CanonicalSyncUploadValidator', () => {
  it('accepts a strict native-domain API upload and freezes it', () => {
    const parsed = validator.validate(
      { operations: [operation()] },
      validationContext,
    );

    expect(parsed.operations).toHaveLength(1);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.operations[0]?.mutation.payload)).toBe(true);
  });

  it.each([
    [
      'client-id-mismatch',
      operation({ clientId: '30000000-0000-4000-8000-000000000099' }),
    ],
    ['schema-version-unsupported', operation({ schemaVersion: 2 })],
    [
      'offline-provider-write-forbidden',
      operation({ entity: { type: 'google.calendar-event', id: 'event-1' } }),
    ],
    [
      'offline-provider-write-forbidden',
      operation({ entity: { type: 'shopping.checkout', id: 'cart-1' } }),
    ],
    ['invalid-dependency', operation({ dependencies: [OPERATION_ID] })],
  ])('returns the explicit %s boundary error', (code, candidate) => {
    expect(() =>
      validator.validate({ operations: [candidate] }, validationContext),
    ).toThrow(expect.objectContaining({ code }));
  });

  it('rejects unknown body fields, duplicate operation IDs, and unsupported mutations', () => {
    expect(() =>
      validator.validate(
        { operations: [operation()], householdId: 'client-controlled' },
        validationContext,
      ),
    ).toThrow(SyncUploadValidationError);

    expect(() =>
      validator.validate(
        { operations: [operation(), operation()] },
        validationContext,
      ),
    ).toThrow(expect.objectContaining({ code: 'duplicate-operation' }));

    expect(() =>
      validator.validate(
        {
          operations: [
            operation({
              entity: { type: 'finance.transaction', id: 'txn-1' },
              mutation: {
                kind: 'delta',
                payload: { spaceId: SPACE_ID, delta: { amount: 5 } },
              },
            }),
          ],
        },
        validationContext,
      ),
    ).toThrow(expect.objectContaining({ code: 'mutation-not-allowed' }));
  });

  it.each([
    [
      'unsupported generic scheduler type',
      operation({
        entity: { type: 'scheduler.task', id: 'task-1' },
        mutation: {
          kind: 'create',
          payload: { spaceId: SPACE_ID, value: { title: 'Task' } },
        },
        baseRevision: 0,
      }),
      'entity-not-supported',
    ],
    [
      'scheduler delete without a deterministic reducer',
      operation({
        entity: { type: 'scheduler.item', id: 'appointment' },
        mutation: { kind: 'delete', payload: { spaceId: SPACE_ID } },
      }),
      'mutation-not-allowed',
    ],
    [
      'budget delete without a deterministic reducer',
      operation({
        entity: { type: 'finance.budget', id: 'monthly' },
        mutation: { kind: 'delete', payload: { spaceId: SPACE_ID } },
      }),
      'mutation-not-allowed',
    ],
    [
      'shopping replacement without a deterministic reducer',
      operation({
        entity: { type: 'shopping.item', id: 'milk' },
        mutation: {
          kind: 'update',
          payload: { spaceId: SPACE_ID, patch: { quantityMinorUnits: 2_000 } },
        },
      }),
      'mutation-not-allowed',
    ],
  ])('rejects %s before repository execution', (_label, candidate, code) => {
    expect(() =>
      validator.validate({ operations: [candidate] }, validationContext),
    ).toThrow(expect.objectContaining({ code }));
  });

  it('fingerprints canonical data independently of object key order', () => {
    const one = validator.validate(
      { operations: [operation()] },
      validationContext,
    ).operations[0]!;
    const two = validator.validate(
      {
        operations: [
          operation({
            mutation: {
              kind: 'update',
              payload: {
                patch: { unit: 'litre', quantity: 2 },
                spaceId: SPACE_ID,
              },
            },
          }),
        ],
      },
      validationContext,
    ).operations[0]!;

    expect(fingerprintSyncOperation(one)).toBe(fingerprintSyncOperation(two));
  });

  it('cannot be configured to expose calendar events or malformed entity policies', () => {
    expect(
      () =>
        new CanonicalSyncUploadValidator({
          currentSchemaVersion: 1,
          clock: { now: () => new Date('2026-08-09T12:01:00.000Z') },
          entityPolicies: [
            {
              entityType: 'scheduler.event',
              allowedMutations: ['create'],
            },
          ],
        }),
    ).toThrow(
      expect.objectContaining({ code: 'offline-provider-write-forbidden' }),
    );

    expect(
      () =>
        new CanonicalSyncUploadValidator({
          currentSchemaVersion: 1,
          clock: { now: () => new Date('2026-08-09T12:01:00.000Z') },
          entityPolicies: [
            {
              entityType: 'shopping.item',
              allowedMutations: ['execute' as 'create'],
            },
          ],
        }),
    ).toThrow(expect.objectContaining({ code: 'invalid-upload' }));
  });

  it('turns cyclic, deeply nested, and accessor-backed inputs into safe validation errors', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      validator.validate(
        {
          operations: [
            operation({
              mutation: {
                kind: 'update',
                payload: { spaceId: SPACE_ID, patch: cyclic },
              },
            }),
          ],
        },
        validationContext,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid-upload' }));

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 40; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(() =>
      validator.validate(
        {
          operations: [
            operation({
              mutation: {
                kind: 'update',
                payload: { spaceId: SPACE_ID, patch: deep },
              },
            }),
          ],
        },
        validationContext,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid-upload' }));

    let getterCalled = false;
    const accessorPayload = {};
    Object.defineProperty(accessorPayload, 'unsafe', {
      enumerable: true,
      get() {
        getterCalled = true;
        throw new Error('must not execute');
      },
    });
    expect(() =>
      validator.validate(
        {
          operations: [
            operation({
              mutation: {
                kind: 'update',
                payload: { spaceId: SPACE_ID, patch: accessorPayload },
              },
            }),
          ],
        },
        validationContext,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid-upload' }));
    expect(getterCalled).toBe(false);
  });

  it('bounds raw upload bytes and rejects a non-finite server clock', () => {
    const tinyValidator = new CanonicalSyncUploadValidator({
      currentSchemaVersion: 1,
      clock: { now: () => new Date('2026-08-09T12:01:00.000Z') },
      maximumUploadBytes: 128,
    });
    expect(() =>
      tinyValidator.validate({ operations: [operation()] }, validationContext),
    ).toThrow(expect.objectContaining({ code: 'upload-too-large' }));

    const invalidClockValidator = new CanonicalSyncUploadValidator({
      currentSchemaVersion: 1,
      clock: { now: () => new Date(Number.NaN) },
    });
    expect(() =>
      invalidClockValidator.validate(
        { operations: [operation()] },
        validationContext,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid-upload' }));
  });

  it('requires a strict mutation envelope, writable space, and no authority fields', () => {
    expect(() =>
      validator.validate(
        {
          operations: [
            operation({
              mutation: {
                kind: 'update',
                payload: { spaceId: SPACE_ID, quantity: 2 },
              },
            }),
          ],
        },
        validationContext,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid-operation-payload' }));

    expect(() =>
      validator.validate(
        {
          operations: [
            operation({
              mutation: {
                kind: 'update',
                payload: {
                  spaceId: SPACE_ID,
                  patch: { requestedExternalAction: 'calendar.create' },
                },
              },
            }),
          ],
        },
        validationContext,
      ),
    ).toThrow(
      expect.objectContaining({ code: 'offline-provider-write-forbidden' }),
    );

    expect(() =>
      validator.validate(
        { operations: [operation()] },
        {
          authenticatedClientId: CLIENT_ID,
          authorizedSpaceIds: ['30000000-0000-4000-8000-000000000099'],
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'space-not-writable' }));
  });

  it('caps total dependency lookup work per upload', () => {
    const budgetedValidator = new CanonicalSyncUploadValidator({
      currentSchemaVersion: 1,
      clock: { now: () => new Date('2026-08-09T12:01:00.000Z') },
      maximumDependencyEdges: 1,
      maximumDistinctDependencies: 1,
    });
    expect(() =>
      budgetedValidator.validate(
        {
          operations: [
            operation({
              operationId: '30000000-0000-4000-8000-000000000010',
              dependencies: ['30000000-0000-4000-8000-000000000011'],
            }),
            operation({
              operationId: '30000000-0000-4000-8000-000000000012',
              dependencies: ['30000000-0000-4000-8000-000000000013'],
            }),
          ],
        },
        validationContext,
      ),
    ).toThrow(expect.objectContaining({ code: 'dependency-budget-exceeded' }));
  });
});

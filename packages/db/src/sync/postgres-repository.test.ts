import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import { PostgresSyncRepository } from './postgres-repository.js';

const ids = {
  user: '50000000-0000-4000-8000-000000000001',
  session: '50000000-0000-4000-8000-000000000002',
  request: '50000000-0000-4000-8000-000000000003',
  household: '50000000-0000-4000-8000-000000000004',
  space: '50000000-0000-4000-8000-000000000005',
  client: '50000000-0000-4000-8000-000000000006',
  operation: '50000000-0000-4000-8000-000000000007',
};
const context = {
  source: 'offline-sync-api' as const,
  externalEffects: 'forbidden' as const,
  mayEnqueueProviderWrites: false as const,
  authorizationRevalidation: 'required-in-transaction' as const,
  authenticatedUserId: ids.user,
  authenticatedSessionId: ids.session,
  householdId: ids.household,
  role: 'owner' as const,
  requestId: ids.request,
  writableSpaceIds: [ids.space],
  targetSpaceId: ids.space,
};
const operation = {
  schemaVersion: 1 as const,
  clientId: ids.client,
  operationId: ids.operation,
  entity: { type: 'shopping.item', id: 'milk' },
  mutation: {
    kind: 'create' as const,
    payload: {
      spaceId: ids.space,
      value: {
        name: 'Milk',
        unit: 'carton',
        quantityMinorUnits: 2_000,
      },
    },
  },
  baseRevision: 0,
  dependencies: [],
  actorIntent: 'Add milk to the household list',
  createdAt: '2026-08-09T12:00:00.000Z',
};

const poolFor = (
  respond: (
    sql: string,
    parameters: readonly unknown[],
  ) => readonly Record<string, unknown>[],
) => {
  const query = vi.fn(
    async (sql: string, parameters: readonly unknown[] = []) => ({
      rowCount: 1,
      rows: respond(sql, parameters),
    }),
  );
  const client: DatabaseClient = { query, release: vi.fn() };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query };
};

describe('PostgresSyncRepository', () => {
  it('resolves only canonical server-side session/client scope', async () => {
    const { pool } = poolFor((sql) =>
      sql.includes('resolve_sync_access')
        ? [
            {
              user_id: ids.user,
              household_id: ids.household,
              role: 'owner',
              writable_spaces: [
                {
                  id: ids.space,
                  householdId: ids.household,
                  visibility: 'private',
                  originalOwnerUserId: ids.user,
                },
              ],
            },
          ]
        : [],
    );

    await expect(
      new PostgresSyncRepository(pool).resolveWriteScope({
        authenticatedSessionId: ids.session,
        clientId: ids.client,
      }),
    ).resolves.toMatchObject({
      userId: ids.user,
      householdId: ids.household,
      writableSpaces: [{ id: ids.space }],
    });
  });

  it('returns only the canonical client registration binding', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope')) {
        return [{ authorized: true }];
      }
      if (sql.includes('insert into emdo.sync_clients')) {
        return [
          {
            id: ids.client,
            household_id: ids.household,
            user_id: ids.user,
            display_name: 'Integration device',
          },
        ];
      }
      return [];
    });

    await expect(
      new PostgresSyncRepository(pool).registerClient({
        principal: {
          userId: ids.user,
          sessionId: ids.session,
          requestId: ids.request,
          householdId: ids.household,
        },
        clientId: ids.client,
        displayName: 'Integration device',
      }),
    ).resolves.toEqual({
      id: ids.client,
      household_id: ids.household,
      user_id: ids.user,
      display_name: 'Integration device',
    });
    const insert = query.mock.calls.find(([sql]) =>
      sql.includes('insert into emdo.sync_clients'),
    )?.[0];
    expect(insert).toContain(
      'returning id, household_id, user_id, display_name',
    );
    expect(insert).not.toMatch(
      /returning[\s\S]+?(registered_at|last_seen_at)/u,
    );
  });

  it('applies entity CAS and stores the terminal receipt in one transaction', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('from emdo.sync_operation_receipts')) return [];
      if (sql.includes('from emdo.sync_entities')) return [];
      if (sql.includes('insert into emdo.sync_entities'))
        return [{ revision: 1 }];
      if (sql.includes('insert into emdo.sync_operation_receipts')) {
        return [{ operation_id: ids.operation }];
      }
      return [];
    });

    await expect(
      new PostgresSyncRepository(pool).executeOnce({
        operation,
        fingerprint: 'a'.repeat(64),
        context,
      }),
    ).resolves.toEqual({
      kind: 'executed',
      outcome: {
        status: 'applied',
        revision: 1,
        resolution: 'created',
        conflicts: [],
      },
    });
    const sql = query.mock.calls.map(([statement]) => statement);
    expect(sql.at(-2)).toContain('insert into emdo.sync_operation_receipts');
    expect(sql.at(-1)).toBe('commit');
    expect(sql).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining('insert into emdo.sync_entity_revisions'),
      ]),
    );
  });

  it('replays an exact receipt without applying another mutation', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('from emdo.sync_operation_receipts')) {
        return [
          {
            fingerprint: 'a'.repeat(64),
            outcome_contract_version: 0,
            outcome_status: 'applied',
            outcome_code: null,
            outcome_resolution: null,
            outcome_disposition: null,
            conflict_details: [],
            current_revision: null,
            resulting_revision: 1,
          },
        ];
      }
      return [];
    });

    await expect(
      new PostgresSyncRepository(pool).executeOnce({
        operation,
        fingerprint: 'a'.repeat(64),
        context,
      }),
    ).resolves.toEqual({
      kind: 'replay',
      outcome: {
        status: 'applied',
        revision: 1,
        resolution: 'applied',
        conflicts: [],
      },
    });
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('insert into emdo.sync_entities'),
      ),
    ).toBe(false);
  });

  it('runs a strict shopping reducer after locking canonical state instead of shallow delta merge', async () => {
    const deltaOperation = {
      ...operation,
      mutation: {
        kind: 'delta' as const,
        payload: { spaceId: ids.space, delta: { quantityMinorUnits: 1_000 } },
      },
      baseRevision: 1,
    };
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('from emdo.sync_operation_receipts')) return [];
      if (sql.includes('from emdo.sync_entities')) {
        return [
          {
            revision: 1,
            tombstoned_at: null,
            payload: {
              itemId: 'milk',
              quantityMinorUnits: 2_000,
              tombstoned: false,
              baseQuantityMinorUnits: 2_000,
              baseTombstoned: false,
              quantityConflict: false,
              appliedOperationIds: [],
              appliedOperations: [],
            },
          },
        ];
      }
      if (sql.includes('update emdo.sync_entities')) return [{ revision: 2 }];
      if (sql.includes('insert into emdo.sync_operation_receipts')) {
        return [{ operation_id: ids.operation }];
      }
      return [];
    });

    await expect(
      new PostgresSyncRepository(pool).executeOnce({
        operation: deltaOperation,
        fingerprint: 'b'.repeat(64),
        context,
      }),
    ).resolves.toEqual({
      kind: 'executed',
      outcome: {
        status: 'applied',
        revision: 2,
        resolution: 'applied',
        conflicts: [],
      },
    });
    const update = query.mock.calls.find(([sql]) =>
      sql.includes('update emdo.sync_entities'),
    );
    expect(update?.[1]).toContainEqual(
      expect.objectContaining({
        quantityMinorUnits: 3_000,
        appliedOperationIds: [ids.operation],
      }),
    );
    expect(query.mock.calls.map(([sql]) => sql)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('jsonb ||')]),
    );
  });

  it('loads the exact server revision snapshot and persists a conflict-free scheduler merge', async () => {
    const base = {
      id: 'appointment',
      title: 'Dentist',
      notes: null,
      location: null,
      startsAt: '2026-08-11T14:00:00.000-04:00',
      endsAt: '2026-08-11T15:00:00.000-04:00',
      recurrence: null,
      attendees: [],
      completion: 'open',
    } as const;
    const local = { ...base, notes: 'Bring insurance card.' };
    const remote = { ...base, location: 'Toronto clinic' };
    const schedulerOperation = {
      ...operation,
      entity: { type: 'scheduler.item', id: 'appointment' },
      mutation: {
        kind: 'update' as const,
        payload: { spaceId: ids.space, patch: { base, local } },
      },
      baseRevision: 1,
    };
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('from emdo.sync_operation_receipts')) return [];
      if (sql.includes('from emdo.sync_entities')) {
        return [{ payload: remote, revision: 2, tombstoned_at: null }];
      }
      if (sql.includes('from emdo.sync_entity_revisions')) {
        return [{ payload: base, revision: 1, tombstoned: false }];
      }
      if (sql.includes('update emdo.sync_entities')) return [{ revision: 3 }];
      if (sql.includes('insert into emdo.sync_operation_receipts')) {
        return [{ operation_id: ids.operation }];
      }
      return [];
    });

    await expect(
      new PostgresSyncRepository(pool).executeOnce({
        operation: schedulerOperation,
        fingerprint: 'c'.repeat(64),
        context,
      }),
    ).resolves.toEqual({
      kind: 'executed',
      outcome: {
        status: 'applied',
        revision: 3,
        resolution: 'merged',
        conflicts: [],
      },
    });
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(
      statements.findIndex((sql) => sql.includes('from emdo.sync_entities')),
    ).toBeLessThan(
      statements.findIndex((sql) =>
        sql.includes('from emdo.sync_entity_revisions'),
      ),
    );
    const update = query.mock.calls.find(([sql]) =>
      sql.includes('update emdo.sync_entities'),
    );
    expect(update?.[1]).toContainEqual(
      expect.objectContaining({
        notes: 'Bring insurance card.',
        location: 'Toronto clinic',
      }),
    );
  });

  it('terminalizes a stale scheduler update when its exact base snapshot is unavailable', async () => {
    const base = {
      id: 'appointment',
      title: 'Dentist',
      notes: null,
      location: null,
      startsAt: '2026-08-11T14:00:00.000-04:00',
      endsAt: '2026-08-11T15:00:00.000-04:00',
      recurrence: null,
      attendees: [],
      completion: 'open',
    } as const;
    const schedulerOperation = {
      ...operation,
      entity: { type: 'scheduler.item', id: 'appointment' },
      mutation: {
        kind: 'update' as const,
        payload: {
          spaceId: ids.space,
          patch: { base, local: { ...base, notes: 'Bring insurance.' } },
        },
      },
      baseRevision: 1,
    };
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('from emdo.sync_operation_receipts')) return [];
      if (sql.includes('from emdo.sync_entities')) {
        return [
          {
            payload: { ...base, location: 'Clinic' },
            revision: 2,
            tombstoned_at: null,
          },
        ];
      }
      if (sql.includes('from emdo.sync_entity_revisions')) return [];
      if (sql.includes('insert into emdo.sync_operation_receipts')) {
        return [{ operation_id: ids.operation }];
      }
      return [];
    });

    await expect(
      new PostgresSyncRepository(pool).executeOnce({
        operation: schedulerOperation,
        fingerprint: 'f'.repeat(64),
        context,
      }),
    ).resolves.toEqual({
      kind: 'executed',
      outcome: {
        status: 'conflict',
        code: 'base-revision-unavailable',
        disposition: 'terminal',
        currentRevision: 2,
        conflicts: [],
      },
    });
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('update emdo.sync_entities'),
      ),
    ).toBe(false);
  });

  it('terminalizes a material conflict without mutating the canonical entity and replays exact details', async () => {
    const conflictDetails = [{ field: 'time', material: true }];
    const replayPool = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('from emdo.sync_operation_receipts')) {
        return [
          {
            fingerprint: 'd'.repeat(64),
            outcome_contract_version: 1,
            outcome_status: 'conflict',
            outcome_code: 'material-conflict',
            outcome_resolution: null,
            outcome_disposition: 'terminal',
            conflict_details: conflictDetails,
            current_revision: 2,
            resulting_revision: null,
          },
        ];
      }
      return [];
    });

    await expect(
      new PostgresSyncRepository(replayPool.pool).executeOnce({
        operation,
        fingerprint: 'd'.repeat(64),
        context,
      }),
    ).resolves.toEqual({
      kind: 'replay',
      outcome: {
        status: 'conflict',
        code: 'material-conflict',
        disposition: 'terminal',
        currentRevision: 2,
        conflicts: conflictDetails,
      },
    });
    expect(
      replayPool.query.mock.calls.some(([sql]) =>
        sql.includes('update emdo.sync_entities'),
      ),
    ).toBe(false);
  });

  it('rejects unsupported generic entities without reaching a generic payload write', async () => {
    const unsupported = {
      ...operation,
      entity: { type: 'finance.account', id: 'cash' },
      mutation: {
        kind: 'create' as const,
        payload: { spaceId: ids.space, value: { balance: 1_000 } },
      },
      baseRevision: 0,
    };
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('from emdo.sync_operation_receipts')) return [];
      if (sql.includes('from emdo.sync_entities')) return [];
      if (sql.includes('insert into emdo.sync_operation_receipts')) {
        return [{ operation_id: ids.operation }];
      }
      return [];
    });

    await expect(
      new PostgresSyncRepository(pool).executeOnce({
        operation: unsupported,
        fingerprint: 'e'.repeat(64),
        context,
      }),
    ).resolves.toEqual({
      kind: 'executed',
      outcome: {
        status: 'conflict',
        code: 'domain-operation-unsupported',
        disposition: 'terminal',
        conflicts: [],
      },
    });
    expect(
      query.mock.calls.some(([sql]) =>
        /(?:insert into|update) emdo\.sync_entities/u.test(sql),
      ),
    ).toBe(false);
  });
});

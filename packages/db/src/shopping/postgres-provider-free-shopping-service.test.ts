import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';

const ids = Object.freeze({
  userId: '92000000-0000-4000-8000-000000000001',
  sessionId: '92000000-0000-4000-8000-000000000002',
  requestId: '92000000-0000-4000-8000-000000000003',
  householdId: '92000000-0000-4000-8000-000000000004',
  grantId: '92000000-0000-4000-8000-000000000005',
  privateSpaceId: '92000000-0000-4000-8000-000000000006',
  runId: '92000000-0000-4000-8000-000000000007',
});

const input = Object.freeze({
  principal: Object.freeze({
    userId: ids.userId,
    sessionId: ids.sessionId,
    householdId: ids.householdId,
    spaceAccessGrantId: ids.grantId,
  }),
  requestId: ids.requestId,
  privateSpaceId: ids.privateSpaceId,
  runId: ids.runId,
  item: Object.freeze({
    id: 'mvp-shopping-milk-001',
    name: 'Milk',
    quantityMinorUnits: 2,
    unit: 'carton',
  }),
});

const canonicalPayload = Object.freeze({
  itemId: input.item.id,
  name: input.item.name,
  unit: input.item.unit,
  quantityMinorUnits: input.item.quantityMinorUnits,
  tombstoned: false,
  baseQuantityMinorUnits: input.item.quantityMinorUnits,
  baseTombstoned: false,
  quantityConflict: false,
  appliedOperationIds: [],
  appliedOperations: [],
});

const poolFor = (
  respond: (
    sql: string,
    values: readonly unknown[],
  ) => readonly Record<string, unknown>[],
) => {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => ({
    rowCount: 1,
    rows: respond(sql, values),
  }));
  const client: DatabaseClient = { query, release: vi.fn() };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query };
};

describe('PostgresProviderFreeShoppingService', () => {
  it('reports ready only when the API login has the exact provider-free shopping prerequisites', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('provider_free_shopping_ready') ? [{ ready: true }] : [],
    );
    const api = await import('@emdo/db/api');
    const service = new (
      api as typeof api & {
        PostgresProviderFreeShoppingService: new (pool: DatabasePool) => {
          checkReady: () => Promise<boolean>;
        };
      }
    ).PostgresProviderFreeShoppingService(pool);

    await expect(service.checkReady()).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('provider_free_shopping_ready'),
    );
    const readiness = query.mock.calls.find(([sql]) =>
      sql.includes('provider_free_shopping_ready'),
    );
    expect(readiness?.[0]).toContain("to_regclass('emdo.sync_entities')");
    expect(readiness?.[0]).toContain('relrowsecurity');
    expect(readiness?.[0]).toContain('relforcerowsecurity');
    expect(readiness?.[0]).toContain("'SELECT,INSERT'");
    expect(readiness?.[0]).toContain(
      "'emdo.resolve_space_access_grant(uuid,uuid,uuid,uuid,uuid,uuid)'",
    );
    expect(readiness?.[0]).not.toContain('lock_current_authorization_scope');
  });

  it('fails closed when readiness metadata is malformed or the catalog query fails', async () => {
    const malformed = poolFor((sql) =>
      sql.includes('provider_free_shopping_ready') ? [{ ready: 'yes' }] : [],
    );
    const unavailableQuery = vi.fn(async () => {
      throw new Error('catalog unavailable');
    });
    const unavailableClient: DatabaseClient = {
      query: unavailableQuery,
      release: vi.fn(),
    };
    const unavailablePool: DatabasePool = {
      connect: vi.fn(async () => unavailableClient),
    };
    const api = await import('@emdo/db/api');
    const Service = (
      api as typeof api & {
        PostgresProviderFreeShoppingService: new (pool: DatabasePool) => {
          checkReady: () => Promise<boolean>;
        };
      }
    ).PostgresProviderFreeShoppingService;

    await expect(new Service(malformed.pool).checkReady()).resolves.toBe(false);
    await expect(new Service(unavailablePool).checkReady()).resolves.toBe(
      false,
    );
    expect(unavailableClient.release).toHaveBeenCalledWith(true);
  });

  it('creates the exact canonical shopping item after fresh grant and private-space authority checks', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('resolve_space_access_grant')) {
        return [
          {
            user_id: ids.userId,
            session_id: ids.sessionId,
            request_id: ids.requestId,
            household_id: ids.householdId,
            private_space_id: ids.privateSpaceId,
            writable_space_ids: [ids.privateSpaceId],
          },
        ];
      }
      if (sql.includes('insert into emdo.sync_entities')) {
        return [
          {
            entity_id: input.item.id,
            payload: canonicalPayload,
            revision: 1,
            updated_at: new Date('2026-08-15T12:00:00.000Z'),
          },
        ];
      }
      return [];
    });
    const api = await import('@emdo/db/api');
    expect(api).toHaveProperty('PostgresProviderFreeShoppingService');
    const service = new (
      api as typeof api & {
        PostgresProviderFreeShoppingService: new (pool: DatabasePool) => {
          create: (value: typeof input) => Promise<unknown>;
        };
      }
    ).PostgresProviderFreeShoppingService(pool);

    await expect(service.create(input)).resolves.toEqual({
      status: 'applied',
      item: {
        id: input.item.id,
        name: input.item.name,
        quantityMinorUnits: input.item.quantityMinorUnits,
        unit: input.item.unit,
        revision: 1,
        updatedAt: '2026-08-15T12:00:00.000Z',
      },
    });
    const authority = query.mock.calls.find(([sql]) =>
      sql.includes('resolve_space_access_grant'),
    );
    expect(authority?.[1]).toEqual([
      ids.grantId,
      ids.householdId,
      ids.userId,
      ids.sessionId,
      ids.requestId,
      ids.privateSpaceId,
    ]);
    const insert = query.mock.calls.find(([sql]) =>
      sql.includes('insert into emdo.sync_entities'),
    );
    expect(insert?.[1]).toEqual(
      expect.arrayContaining([
        ids.householdId,
        ids.privateSpaceId,
        input.item.id,
        canonicalPayload,
        `Provider-free shopping create for run ${ids.runId}`,
      ]),
    );
  });

  it('returns duplicate only when the existing private-space item has the exact canonical payload', async () => {
    const { pool } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('resolve_space_access_grant')) {
        return [
          {
            user_id: ids.userId,
            session_id: ids.sessionId,
            request_id: ids.requestId,
            household_id: ids.householdId,
            private_space_id: ids.privateSpaceId,
            writable_space_ids: [ids.privateSpaceId],
          },
        ];
      }
      if (sql.includes('insert into emdo.sync_entities')) return [];
      if (sql.includes('provider_free_shopping_existing')) {
        return [
          {
            entity_id: input.item.id,
            payload: canonicalPayload,
            revision: 1,
            updated_at: new Date('2026-08-15T12:00:00.000Z'),
          },
        ];
      }
      return [];
    });
    const api = await import('@emdo/db/api');
    const service = new (
      api as typeof api & {
        PostgresProviderFreeShoppingService: new (pool: DatabasePool) => {
          create: (value: typeof input) => Promise<unknown>;
        };
      }
    ).PostgresProviderFreeShoppingService(pool);

    await expect(service.create(input)).resolves.toMatchObject({
      status: 'duplicate',
      item: { id: input.item.id, revision: 1 },
    });
  });

  it('returns a safe conflict when an existing private-space item differs', async () => {
    const { pool } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('resolve_space_access_grant')) {
        return [
          {
            user_id: ids.userId,
            session_id: ids.sessionId,
            request_id: ids.requestId,
            household_id: ids.householdId,
            private_space_id: ids.privateSpaceId,
            writable_space_ids: [ids.privateSpaceId],
          },
        ];
      }
      if (sql.includes('insert into emdo.sync_entities')) return [];
      if (sql.includes('provider_free_shopping_existing')) {
        return [
          {
            entity_id: input.item.id,
            payload: { ...canonicalPayload, quantityMinorUnits: 3 },
            revision: 1,
            updated_at: new Date('2026-08-15T12:00:00.000Z'),
          },
        ];
      }
      return [];
    });
    const api = await import('@emdo/db/api');
    const service = new (
      api as typeof api & {
        PostgresProviderFreeShoppingService: new (pool: DatabasePool) => {
          create: (value: typeof input) => Promise<unknown>;
        };
      }
    ).PostgresProviderFreeShoppingService(pool);

    await expect(service.create(input)).resolves.toEqual({
      status: 'conflict',
      safeError: {
        code: 'shopping-item-id-conflict',
        message: 'A shopping item already exists with different data.',
      },
    });
  });
});

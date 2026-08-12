import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  PostgresScopedDomainEntityRepository,
  ScopedDomainEntityError,
} from './scoped-entity-repository.js';

const principal = {
  userId: '90000000-0000-4000-8000-000000000001',
  sessionId: '90000000-0000-4000-8000-000000000002',
  requestId: '90000000-0000-4000-8000-000000000003',
  householdId: '90000000-0000-4000-8000-000000000004',
};
const spaceId = '90000000-0000-4000-8000-000000000005';

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

describe('PostgresScopedDomainEntityRepository', () => {
  it('binds entity type and space in the constructor and applies revision CAS with DB time', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('update emdo.sync_entities')) {
        return [
          {
            entity_id: 'budget-2026-08',
            payload: { limitCadMinor: 100_00 },
            revision: 2,
            tombstoned_at: null,
            updated_at: new Date('2026-08-10T12:00:00.000Z'),
          },
        ];
      }
      return [];
    });
    const repository = new PostgresScopedDomainEntityRepository(
      pool,
      principal,
      { spaceId, entityType: 'finance.budget' },
    );

    await expect(
      repository.compareAndSet({
        entityId: 'budget-2026-08',
        expectedRevision: 1,
        payload: { limitCadMinor: 100_00 },
        actorIntent: 'Set the August household budget',
      }),
    ).resolves.toMatchObject({ revision: 2 });

    const update = query.mock.calls.find(([sql]) =>
      sql.includes('update emdo.sync_entities'),
    );
    expect(update?.[0]).toContain('updated_at = pg_catalog.clock_timestamp()');
    expect(update?.[1]).toEqual(
      expect.arrayContaining([spaceId, 'finance.budget', 'budget-2026-08', 1]),
    );
  });

  it('rejects authority-bearing payload keys before opening a database transaction', async () => {
    const { pool } = poolFor(() => []);
    const repository = new PostgresScopedDomainEntityRepository(
      pool,
      principal,
      { spaceId, entityType: 'shopping.item' },
    );

    await expect(
      repository.create({
        entityId: 'milk',
        payload: { quantity: 2, householdId: principal.householdId },
        actorIntent: 'Add milk',
      }),
    ).rejects.toMatchObject({
      code: 'authority-field-forbidden',
    } satisfies Partial<ScopedDomainEntityError>);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('returns no row when RLS hides an entity outside the active private space', async () => {
    const { pool } = poolFor((sql) =>
      sql.includes('lock_active_request_scope') ? [{ authorized: true }] : [],
    );
    const repository = new PostgresScopedDomainEntityRepository(
      pool,
      principal,
      { spaceId, entityType: 'scheduler.item' },
    );

    await expect(repository.get('private-task')).resolves.toBeUndefined();
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(1_001)],
  ])(
    'rejects an actor intent that is %s before opening a transaction',
    async (_label, actorIntent) => {
      const { pool } = poolFor(() => []);
      const repository = new PostgresScopedDomainEntityRepository(
        pool,
        principal,
        { spaceId, entityType: 'scheduler.item' },
      );

      await expect(
        repository.create({
          entityId: 'task-1',
          payload: { title: 'Safe task' },
          actorIntent,
        }),
      ).rejects.toMatchObject({ name: 'ZodError' });
      expect(pool.connect).not.toHaveBeenCalled();
    },
  );
});

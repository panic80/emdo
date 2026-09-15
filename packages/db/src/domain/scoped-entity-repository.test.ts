import * as projection from '../finance-legacy-activation-projection.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  afterEach(() => vi.restoreAllMocks());
  it('reads normalized transactions with lexical pagination and the original space owner', async () => {
    const owner = '90000000-0000-4000-8000-000000000006';
    const { pool, query } = poolFor((sql) =>
      sql.includes('lock_active_request_scope')
        ? [{ authorized: true }]
        : sql.includes('select original_owner_user_id')
          ? [{ original_owner_user_id: owner }]
          : [],
    );
    const route = {
      kind: 'normalized' as const,
      migrationId: principal.requestId,
      bookId: principal.sessionId,
      activatedAt: '2026-09-14T00:00:00.000Z',
    };
    const resolve = vi
      .spyOn(projection, 'resolveLegacyFinanceRoute')
      .mockResolvedValue(route);
    const transaction = {
      id: 'tx-z',
      legacyEntityId: 'tx-z',
      economicTransactionId: principal.userId,
      journalId: principal.sessionId,
      financialAccountId: principal.requestId,
      legacyAccountId: 'bank',
      effectiveOn: '2026-09-14',
      description: 'Ledger posted',
      createdAt: '2026-09-14T01:00:00.000Z',
      updatedAt: '2026-09-14T01:00:00.000Z',
      nativeAmount: '12.34',
      categoryId: null,
      currency: 'CAD' as const,
      amountCadMinor: 1234,
      originalFingerprint: null,
      originalSourceHash: null,
      originalSourceRow: null,
      externalId: null,
    };
    const read = vi
      .spyOn(projection, 'readLegacyFinanceCompatibility')
      .mockResolvedValue({
        kind: 'ready',
        accounts: [],
        archives: [],
        transactions: [transaction],
        nextCursor: null,
        nextEntityId: null,
      });
    const repository = new PostgresScopedDomainEntityRepository(
      pool,
      principal,
      { spaceId, entityType: 'finance.transaction' },
    );
    expect(
      await repository.list({ afterEntityId: 'tx-y', limit: 1 }),
    ).toMatchObject([
      {
        entityId: 'tx-z',
        updatedAt: transaction.updatedAt,
        payload: {
          ownerUserId: owner,
          source: { kind: 'normalized-ledger', bookId: route.bookId },
          originalAmountCadMinor: 1234,
        },
      },
    ]);
    expect(resolve).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: principal.householdId,
      sourceSpaceId: spaceId,
      sourceOwnerUserId: owner,
    });
    expect(read).toHaveBeenLastCalledWith(
      expect.anything(),
      route,
      expect.anything(),
      { order: 'entity-id', afterEntityId: 'tx-y', limit: 1 },
    );
    await repository.get('tx-z');
    expect(read).toHaveBeenLastCalledWith(
      expect.anything(),
      route,
      expect.anything(),
      { order: 'entity-id', entityId: 'tx-z', limit: 1 },
    );
    read.mockResolvedValueOnce({
      kind: 'unsupported-currency',
      currency: 'EUR',
    });
    await expect(repository.list()).rejects.toMatchObject({
      code: 'invalid-result',
    });
    expect(
      query.mock.calls.some(([sql]) => sql.includes('from emdo.sync_entities')),
    ).toBe(false);
  });
  it('preserves the legacy path before activation and keeps configuration records on their scoped path', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('lock_active_request_scope')
        ? [{ authorized: true }]
        : sql.includes('select original_owner_user_id')
          ? [{ original_owner_user_id: principal.userId }]
          : [],
    );
    const resolve = vi
      .spyOn(projection, 'resolveLegacyFinanceRoute')
      .mockResolvedValue({ kind: 'legacy' });
    const repository = new PostgresScopedDomainEntityRepository(
      pool,
      principal,
      { spaceId, entityType: 'finance.transaction' },
    );
    expect(await repository.get('missing')).toBeUndefined();
    expect(
      query.mock.calls.some(([sql]) => sql.includes('from emdo.sync_entities')),
    ).toBe(true);
    resolve.mockClear();
    const config = new PostgresScopedDomainEntityRepository(pool, principal, {
      spaceId,
      entityType: 'finance.budget',
    });
    await config.list();
    expect(resolve).not.toHaveBeenCalled();
  });
  it('preserves the database freeze for normalized legacy mutation attempts', async () => {
    const { pool } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('update emdo.sync_entities'))
        throw new Error('legacy-finance-activated-write-forbidden');
      return [];
    });
    const resolve = vi.spyOn(projection, 'resolveLegacyFinanceRoute');
    const repository = new PostgresScopedDomainEntityRepository(
      pool,
      principal,
      { spaceId, entityType: 'finance.transaction' },
    );
    await expect(
      repository.tombstone({
        entityId: 'transaction-1',
        expectedRevision: 1,
        actorIntent: 'Remove transaction',
      }),
    ).rejects.toThrow('legacy-finance-activated-write-forbidden');
    expect(resolve).not.toHaveBeenCalled();
  });
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

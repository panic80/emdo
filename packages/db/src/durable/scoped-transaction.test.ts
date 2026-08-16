import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  DurableRepositoryError,
  parseDurablePrincipal,
  withDurableTransaction,
} from './scoped-transaction.js';

const principal = {
  userId: '10000000-0000-4000-8000-000000000001',
  sessionId: '10000000-0000-4000-8000-000000000002',
  requestId: '10000000-0000-4000-8000-000000000003',
  householdId: '10000000-0000-4000-8000-000000000004',
};

const fixture = (authorized: boolean) => {
  const query = vi.fn(async (sql: string) => ({
    rowCount: 1,
    rows: sql.includes('lock_active_request_scope') ? [{ authorized }] : [],
  }));
  const release = vi.fn();
  const client: DatabaseClient = { query, release };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { client, pool, query, release };
};

describe('durable scoped transaction', () => {
  it('sets transaction-local claims, locks canonical scope, and commits', async () => {
    const { pool, query, release } = fixture(true);
    const result = await withDurableTransaction(
      pool,
      parseDurablePrincipal(principal),
      {
        householdId: principal.householdId,
        spaceId: '10000000-0000-4000-8000-000000000005',
      },
      async () => 'ok',
    );

    expect(result).toBe('ok');
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'begin',
      'set local row_security = on',
      "set local statement_timeout = '30s'",
      "set local lock_timeout = '5s'",
      expect.stringContaining("set_config('emdo.user_id'"),
      expect.stringContaining('lock_active_request_scope'),
      'commit',
    ]);
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes("set_config('emdo.user_id'"),
      )?.[0],
    ).not.toContain('set local');
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back and fails closed when database authorization is absent', async () => {
    const { pool, query, release } = fixture(false);

    await expect(
      withDurableTransaction(
        pool,
        parseDurablePrincipal(principal),
        { householdId: principal.householdId },
        async () => 'must-not-run',
      ),
    ).rejects.toMatchObject({
      code: 'authorization-revoked',
    } satisfies Partial<DurableRepositoryError>);
    expect(query).toHaveBeenLastCalledWith('rollback');
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects malformed principals before opening a transaction', () => {
    expect(() =>
      parseDurablePrincipal({ ...principal, householdId: 'client-supplied' }),
    ).toThrow(
      expect.objectContaining<Partial<DurableRepositoryError>>({
        code: 'invalid-input',
      }),
    );
  });
});

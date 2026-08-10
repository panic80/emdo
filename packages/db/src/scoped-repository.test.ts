import { describe, expect, it, vi } from 'vitest';

import { createScopedDatabase } from './scoped-repository.js';

const userId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001';
const sessionId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002';
const requestId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003';

const fakePool = () => {
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    if (text.includes('insert into emdo.space_records')) {
      return {
        rowCount: 1,
        rows: [
          {
            id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004',
            space_id: values?.[0],
            record_kind: values?.[1],
            payload: values?.[2],
            revision: '1',
          },
        ],
      };
    }
    return { rowCount: 0, rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect }, connect, query, release };
};

describe('scoped database', () => {
  it('derives identity from an authenticated session and sets transaction-local claims', async () => {
    const database = fakePool();
    const resolve = vi.fn(async () => ({
      userId,
      sessionId,
      emailVerified: true as const,
    }));
    const scoped = createScopedDatabase(database.pool, { resolve });

    await scoped.run(sessionId, requestId, async (repositories) => {
      expect(Object.keys(repositories).sort()).toEqual([
        'audit',
        'conversations',
        'records',
        'spaces',
      ]);
      expect(repositories).not.toHaveProperty('query');
      expect(repositories).not.toHaveProperty('setClaims');
    });

    expect(resolve).toHaveBeenCalledWith(sessionId);
    expect(database.query).toHaveBeenNthCalledWith(1, 'begin');
    expect(database.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("set_config('emdo.user_id', $1, true)"),
      [userId, sessionId, requestId],
    );
    expect(database.query).toHaveBeenCalledWith('commit');
    expect(database.release).toHaveBeenCalledOnce();
  });

  it('does not open a transaction for an invalid or unverified identity', async () => {
    const database = fakePool();
    const scoped = createScopedDatabase(database.pool, {
      resolve: async () => undefined,
    });

    await expect(
      scoped.run(sessionId, requestId, async () => undefined),
    ).rejects.toThrow('Authenticated session is invalid');
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('derives household and original owner in SQL instead of accepting scope claims', async () => {
    const database = fakePool();
    const scoped = createScopedDatabase(database.pool, {
      resolve: async () => ({ userId, sessionId, emailVerified: true }),
    });
    const spaceId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f005';

    await scoped.run(sessionId, requestId, async ({ records }) => {
      await records.create({
        spaceId,
        recordKind: 'shopping.item',
        payload: { quantity: 2 },
        actorIntent: 'Add two items',
      });
    });

    const insert = database.query.mock.calls.find(([text]) =>
      String(text).includes('insert into emdo.space_records'),
    );
    expect(insert?.[0]).toMatch(/select[\s\S]+s\.household_id/);
    expect(insert?.[0]).toContain('emdo.current_user_id()');
    expect(insert?.[1]).toEqual([
      spaceId,
      'shopping.item',
      { quantity: 2 },
      'Add two items',
    ]);
  });

  it('rolls back and releases the connection when scoped work fails', async () => {
    const database = fakePool();
    const scoped = createScopedDatabase(database.pool, {
      resolve: async () => ({ userId, sessionId, emailVerified: true }),
    });

    await expect(
      scoped.run(sessionId, requestId, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(database.query).toHaveBeenCalledWith('rollback');
    expect(database.query).not.toHaveBeenCalledWith('commit');
    expect(database.release).toHaveBeenCalledOnce();
  });
});

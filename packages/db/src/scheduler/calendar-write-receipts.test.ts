import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import { PostgresCalendarWriteReceiptStore } from './calendar-write-receipts.js';

const principal = {
  userId: '60000000-0000-4000-8000-000000000001',
  sessionId: '60000000-0000-4000-8000-000000000002',
  requestId: '60000000-0000-4000-8000-000000000003',
  householdId: '60000000-0000-4000-8000-000000000004',
};
const scope = {
  spaceId: '60000000-0000-4000-8000-000000000005',
  runId: '60000000-0000-4000-8000-000000000006',
};
const receiptKey = 'a'.repeat(64);
const commandHash = 'b'.repeat(64);
const indeterminate = {
  status: 'indeterminate' as const,
  reconciliationRequired: true as const,
  safeError: {
    code: 'calendar-provider-indeterminate' as const,
    message: 'Provider state is unknown.',
    retryable: false as const,
  },
};

const poolFor = (
  respond: (sql: string) => readonly Record<string, unknown>[],
) => {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    void values;
    return {
      rowCount: 1,
      rows: respond(sql),
    };
  });
  const client: DatabaseClient = { query, release: vi.fn() };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query };
};

describe('PostgresCalendarWriteReceiptStore', () => {
  it('acquires exactly one pending provider receipt in the approved run scope', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('select command_hash')) return [];
      if (sql.includes('insert into emdo.scheduler_execution_receipts')) {
        return [{ receipt_key: receiptKey }];
      }
      return [];
    });

    await expect(
      new PostgresCalendarWriteReceiptStore(pool, principal, scope).acquire(
        receiptKey,
        commandHash,
      ),
    ).resolves.toEqual({ status: 'acquired' });
    expect(
      query.mock.calls.some(([sql]) => sql.includes('pg_advisory_xact_lock')),
    ).toBe(true);
  });

  it('replays a completed exact result and rejects command hash reuse', async () => {
    const exact = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('select command_hash')) {
        return [
          {
            command_hash: commandHash,
            state: 'completed',
            result: indeterminate,
          },
        ];
      }
      return [];
    });
    await expect(
      new PostgresCalendarWriteReceiptStore(
        exact.pool,
        principal,
        scope,
      ).acquire(receiptKey, commandHash),
    ).resolves.toEqual({ status: 'existing', result: indeterminate });

    const conflict = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('select command_hash')) {
        return [
          { command_hash: 'c'.repeat(64), state: 'pending', result: null },
        ];
      }
      return [];
    });
    await expect(
      new PostgresCalendarWriteReceiptStore(
        conflict.pool,
        principal,
        scope,
      ).acquire(receiptKey, commandHash),
    ).resolves.toEqual({ status: 'conflict' });
  });

  it('persists an indeterminate outcome as an explicit reconciliation marker', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('select command_hash')) {
        return [{ command_hash: commandHash, state: 'pending', result: null }];
      }
      if (sql.includes('update emdo.scheduler_execution_receipts')) {
        return [{ receipt_key: receiptKey }];
      }
      return [];
    });

    await new PostgresCalendarWriteReceiptStore(
      pool,
      principal,
      scope,
    ).complete(receiptKey, commandHash, indeterminate);

    const updateCall = query.mock.calls.find(([sql]) =>
      sql.includes('update emdo.scheduler_execution_receipts'),
    );
    expect(updateCall?.[1]?.at(-1)).toBe(true);
  });
});

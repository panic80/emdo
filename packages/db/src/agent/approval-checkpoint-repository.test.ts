import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import { PostgresApprovalCheckpointRepository } from './approval-checkpoint-repository.js';

const principal = {
  userId: '30000000-0000-4000-8000-000000000001',
  sessionId: '30000000-0000-4000-8000-000000000002',
  requestId: '30000000-0000-4000-8000-000000000003',
  householdId: '30000000-0000-4000-8000-000000000004',
};
const record = {
  checkpointId: '30000000-0000-4000-8000-000000000005',
  householdId: principal.householdId,
  userId: principal.userId,
  runId: '30000000-0000-4000-8000-000000000006',
  agentGraphHash: 'a'.repeat(64),
  sdkVersion: '0.14.3',
  formatVersion: 1 as const,
  revision: 1,
  state: 'pending' as const,
  createdAt: '2026-08-09T12:00:00.000Z',
  expiresAt: '2026-08-09T12:10:00.000Z',
  updatedAt: '2026-08-09T12:00:00.000Z',
  sealedState: 'v1.key.nonce.tag.ciphertext',
};
const row = (state = 'pending', revision = 1) => ({
  checkpoint_id: record.checkpointId,
  household_id: record.householdId,
  user_id: record.userId,
  run_id: record.runId,
  format_version: 1,
  revision,
  state,
  agent_graph_hash: record.agentGraphHash,
  sdk_version: record.sdkVersion,
  sealed_state: record.sealedState,
  created_at: new Date(record.createdAt),
  expires_at: new Date(record.expiresAt),
  updated_at: new Date(
    revision === 1 ? record.updatedAt : '2026-08-09T12:05:00.000Z',
  ),
});

const poolFor = (
  respond: (sql: string) => readonly Record<string, unknown>[],
) => {
  const query = vi.fn(async (sql: string) => ({
    rowCount: 1,
    rows: respond(sql),
  }));
  const client: DatabaseClient = { query, release: vi.fn() };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query };
};

describe('PostgresApprovalCheckpointRepository', () => {
  it('creates sealed state only after locking the run scope with database time', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('from emdo.agent_runs')) {
        return [{ space_id: '30000000-0000-4000-8000-000000000007' }];
      }
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('clock_timestamp() as now')) {
        return [{ now: new Date('2026-08-09T12:00:01.000Z') }];
      }
      if (sql.includes('insert into emdo.approval_checkpoints')) {
        return [{ checkpoint_id: record.checkpointId }];
      }
      return [];
    });

    await expect(
      new PostgresApprovalCheckpointRepository(pool, principal).create(record),
    ).resolves.toBe('created');
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('sealed_state, created_at, expires_at'),
      ),
    ).toBe(true);
  });

  it('atomically expires a pending checkpoint at the database boundary', async () => {
    const { pool } = poolFor((sql) => {
      if (sql.includes('for update')) return [row()];
      if (sql.includes('select space_id')) {
        return [{ space_id: '30000000-0000-4000-8000-000000000007' }];
      }
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('clock_timestamp() as now')) {
        return [{ now: new Date(record.expiresAt) }];
      }
      if (sql.includes('update emdo.approval_checkpoints')) {
        return [row('expired', 2)];
      }
      return [];
    });

    await expect(
      new PostgresApprovalCheckpointRepository(pool, principal).consume({
        checkpointId: record.checkpointId,
        expectedRevision: 1,
        identity: {
          checkpointId: record.checkpointId,
          householdId: record.householdId,
          userId: record.userId,
          runId: record.runId,
          agentGraphHash: record.agentGraphHash,
          sdkVersion: record.sdkVersion,
        },
      }),
    ).resolves.toEqual({ status: 'expired' });
  });

  it('does not reveal a checkpoint belonging to another tenant', async () => {
    const { pool } = poolFor(() => []);
    await expect(
      new PostgresApprovalCheckpointRepository(pool, principal).get(
        record.checkpointId,
      ),
    ).resolves.toBeUndefined();
  });
});

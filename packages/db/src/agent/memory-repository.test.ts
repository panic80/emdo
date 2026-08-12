import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import { PostgresAgentMemoryRepository } from './memory-repository.js';

const principal = {
  userId: '40000000-0000-4000-8000-000000000001',
  sessionId: '40000000-0000-4000-8000-000000000002',
  requestId: '40000000-0000-4000-8000-000000000003',
  householdId: '40000000-0000-4000-8000-000000000004',
};
const spaceId = '40000000-0000-4000-8000-000000000005';
const runId = '40000000-0000-4000-8000-000000000006';
const runRow = {
  id: runId,
  space_id: spaceId,
  agent_id: 'scheduler.agent',
  agent_version: '1.0.0',
  requested_model: 'gpt-5.6-luna',
  resolved_model: null,
  model_reason: null,
  status: 'queued',
  local_trace_reference: null,
  safe_error: null,
  usage: null,
  created_at: new Date('2026-08-09T12:00:00.000Z'),
  completed_at: null,
  retain_until: new Date('2026-11-07T12:00:00.000Z'),
};

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

describe('PostgresAgentMemoryRepository', () => {
  it('creates a run in a locked space with a 90-day trace boundary', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('insert into emdo.agent_runs')) return [runRow];
      return [];
    });

    await expect(
      new PostgresAgentMemoryRepository(pool, principal).createRun({
        runId,
        spaceId,
        agentId: 'scheduler.agent',
        agentVersion: '1.0.0',
        requestedModel: 'gpt-5.6-luna',
      }),
    ).resolves.toMatchObject({ id: runId, status: 'queued' });
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes("database_time.now + interval '90 days'"),
      ),
    ).toBe(true);
  });

  it('appends replayable run events after re-locking canonical run scope', async () => {
    const { pool } = poolFor((sql) => {
      if (sql.includes('select household_id')) {
        return [
          {
            household_id: principal.householdId,
            space_id: spaceId,
            original_owner_user_id: principal.userId,
          },
        ];
      }
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('insert into emdo.agent_run_events')) {
        return [
          {
            id: '40000000-0000-4000-8000-000000000007',
            run_id: runId,
            sequence: '1',
            event_type: 'response.delta',
            payload: { text: 'Hello' },
            occurred_at: new Date('2026-08-09T12:00:01.000Z'),
          },
        ];
      }
      return [];
    });

    await expect(
      new PostgresAgentMemoryRepository(pool, principal).appendRunEvent({
        runId,
        sequence: 1,
        eventType: 'response.delta',
        payload: { text: 'Hello' },
      }),
    ).resolves.toMatchObject({ sequence: 1, eventType: 'response.delta' });
  });

  it('rejects a client event replay whose immutable content differs', async () => {
    const { pool } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('insert into emdo.conversation_events')) return [];
      if (sql.includes('from emdo.conversation_events')) {
        return [
          {
            id: '40000000-0000-4000-8000-000000000008',
            conversation_id: '40000000-0000-4000-8000-000000000009',
            client_event_id: 'client-event-00001',
            sequence: '1',
            event_type: 'message.user',
            payload: { text: 'Different' },
            occurred_at: new Date('2026-08-09T12:00:01.000Z'),
          },
        ];
      }
      return [];
    });

    await expect(
      new PostgresAgentMemoryRepository(
        pool,
        principal,
      ).appendConversationEvent({
        spaceId,
        conversationId: '40000000-0000-4000-8000-000000000009',
        clientEventId: 'client-event-00001',
        sequence: 1,
        eventType: 'message.user',
        payload: { text: 'Original' },
      }),
    ).rejects.toThrow('reused with different content');
  });
});

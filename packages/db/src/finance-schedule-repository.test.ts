import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  PostgresFinanceScheduleDueRepository,
  PostgresFinanceScheduleRepository,
} from './finance-schedule-repository.js';

function fixture(kind: 'extraction' | 'journal') {
  const id = randomUUID();
  const context = {
    workspaceId: randomUUID(),
    userId: randomUUID(),
    sessionId: randomUUID(),
    requestId: randomUUID(),
  };
  const bookId = randomUUID();
  const definition = {
    workspaceId: context.workspaceId,
    bookId,
    grantId: randomUUID(),
    grantRevision: 2,
    capability:
      kind === 'extraction'
        ? 'finance.documents.extract'
        : 'finance.journals.draft',
    targets: [id],
    ...(kind === 'extraction'
      ? {
          extraction: {
            schemaVersion: 1,
            evidenceId: id,
            expectedSourceDigest: 'a'.repeat(64),
            standardizationRunId: randomUUID(),
            expectedRunRevision: 3,
            expectedExtractionRevision: 1,
          },
        }
      : {
          journal: {
            schemaVersion: 1,
            batchId: id,
            expectedBatchRevision: 4,
            expectedSnapshotHash: 'b'.repeat(64),
          },
        }),
    money: { currency: 'CAD', amount: kind === 'extraction' ? '0' : '125.25' },
    startAt: '2026-09-15T00:00:00Z',
    endAt: null,
    cadence: {
      kind: 'interval',
      everySeconds: 3600,
      timeZone: 'UTC',
      clock: 'elapsed-utc',
    },
    misfire: { policy: 'coalesce-latest', maxLatenessSeconds: 3600 },
    concurrency: { policy: 'forbid', onBusy: 'defer' },
  };
  const row = {
    id,
    definition_revision: 1,
    state_revision: 1,
    status: 'active',
    definition,
    next_ordinal: '0',
    next_due_at: null,
    blocked_reason: null,
    created_at: '2026-09-15T00:00:00Z',
    updated_at: '2026-09-15T00:00:00Z',
  };
  const claim = {
    leaseToken: randomUUID(),
    input: {
      schedule: {
        id,
        definitionRevision: 1,
        stateRevision: 1,
        status: 'active',
        definition,
      },
      cursor: { scheduleId: id, definitionRevision: 1, nextOrdinal: 0 },
      now: '2026-09-15T00:00:00Z',
      blockingRunCount: 0,
      runtimeTimezoneVersion: 'test-tz',
    },
  };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    void values;
    if (sql.includes('lock_active_request_scope'))
      return { rows: [{ authorized: true }], rowCount: 1 };
    if (
      sql.includes('create_finance_schedule') ||
      sql.includes('read_finance_schedules')
    )
      return { rows: [{ schedule: row }], rowCount: 1 };
    if (sql.includes('claim_finance_schedules'))
      return { rows: [{ claim }], rowCount: 1 };
    if (sql.includes('commit_finance_schedule'))
      return {
        rows: [{ result: { status: 'due', operationId: id } }],
        rowCount: 1,
      };
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const pool = { connect: async () => ({ query, release }) };
  return { id, context, bookId, definition, claim, query, pool };
}

describe('exact-source schedule persistence transport', () => {
  it.each(['extraction', 'journal'] as const)(
    'preserves %s revisions and hashes on management round trip',
    async (kind) => {
      const f = fixture(kind);
      const repo = new PostgresFinanceScheduleRepository(f.pool, 'test-tz');
      const created = await repo.createSchedule(
        f.context,
        f.bookId,
        f.id,
        f.definition,
      );
      expect(created.schedule.definition).toEqual(f.definition);
      expect(f.query).toHaveBeenCalledWith(
        'select emdo.create_finance_schedule($1,$2,$3,$4::jsonb,$5) as schedule',
        [
          f.context.workspaceId,
          f.bookId,
          f.id,
          JSON.stringify(f.definition),
          'test-tz',
        ],
      );
      expect(
        (await repo.listSchedules(f.context, f.bookId))[0]?.schedule.definition,
      ).toEqual(f.definition);
    },
  );
  it.each(['extraction', 'journal'] as const)(
    'preserves %s reviewed source in claims and commits only lease/CAS/plan',
    async (kind) => {
      const f = fixture(kind);
      const repo = new PostgresFinanceScheduleDueRepository(f.pool, 'test-tz');
      const [claim] = await repo.claimDue(1);
      expect(claim).toEqual(f.claim);
      await repo.planAndCommit(claim!);
      const call = f.query.mock.calls.find(([sql]) =>
        sql.includes('commit_finance_schedule'),
      );
      expect(call?.[1]?.slice(0, 5)).toEqual([
        f.id,
        f.claim.leaseToken,
        1,
        0,
        'test-tz',
      ]);
      const plan = JSON.parse(String(call?.[1]?.[5]));
      expect(plan.status).toBe('due');
      expect(JSON.stringify(plan)).not.toMatch(
        /expectedSourceDigest|expectedSnapshotHash|standardizationRunId|batchId/,
      );
      expect(f.query.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(
        /enqueue_finance|generate_finance|insert into|update emdo/i,
      );
    },
  );
});

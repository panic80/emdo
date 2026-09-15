import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  FinancePlanningResultNotAppliedError,
  PostgresFinancePlanningExecutionRepository,
} from './finance-planning-execution-repository.js';
import type { DatabasePool } from './scoped-repository.js';

function poolFor(query: ReturnType<typeof vi.fn>): DatabasePool {
  return {
    async connect() {
      return {
        query,
        release: vi.fn(),
      };
    },
  };
}

describe('restricted Finance planning automation execution repository', () => {
  it('calls the positional SQL function with the run CAS revision and lease', async () => {
    const resultId = randomUUID();
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('select emdo.generate_finance_planning_result'))
        return { rowCount: 1, rows: [{ result_id: resultId }] };
      return { rowCount: 0, rows: [] };
    });
    const repository = new PostgresFinancePlanningExecutionRepository(
      poolFor(query),
    );
    const input = {
      operationId: randomUUID(),
      expectedRevision: 7,
      leaseToken: randomUUID(),
    };
    await expect(repository.generatePlanningResult(input)).resolves.toEqual({
      resultId,
    });
    expect(query).toHaveBeenCalledWith(
      'select emdo.generate_finance_planning_result($1,$2,$3) as result_id',
      [input.operationId, input.expectedRevision, input.leaseToken],
    );
    expect(query.mock.calls.map((call) => call[0])).toEqual([
      'begin',
      "set local statement_timeout='60s'",
      "set local lock_timeout='5s'",
      'set local row_security=on',
      'select emdo.generate_finance_planning_result($1,$2,$3) as result_id',
      'commit',
    ]);
  });

  it('distinguishes a rolled-back lock timeout from lost commit acknowledgement', async () => {
    for (const phase of ['locked', 'commit'] as const) {
      const error =
        phase === 'locked'
          ? Object.assign(new Error('lock timeout'), { code: '55P03' })
          : new Error('connection lost');
      const query = vi.fn(async (sql: string) => {
        if (
          phase === 'locked' &&
          sql.startsWith('select emdo.generate_finance_planning_result')
        )
          throw error;
        if (phase === 'commit' && sql === 'commit') throw error;
        return { rowCount: 1, rows: [{ result_id: randomUUID() }] };
      });
      const call = new PostgresFinancePlanningExecutionRepository(
        poolFor(query),
      ).generatePlanningResult({
        operationId: randomUUID(),
        expectedRevision: 2,
        leaseToken: randomUUID(),
      });
      if (phase === 'locked')
        await expect(call).rejects.toMatchObject({ reason: 'result-conflict' });
      else await expect(call).rejects.toBe(error);
      expect(query).toHaveBeenCalledWith('rollback');
    }
  });

  it('maps known SQL rejection and reports false readiness when the function is absent', async () => {
    const rejectionQuery = vi.fn(async (sql: string) => {
      if (sql.startsWith('select emdo.generate_finance_planning_result'))
        throw Object.assign(new Error('planning-authority-revoked'), {
          code: '42501',
        });
      return { rowCount: 0, rows: [] };
    });
    const repository = new PostgresFinancePlanningExecutionRepository(
      poolFor(rejectionQuery),
    );
    await expect(
      repository.generatePlanningResult({
        operationId: randomUUID(),
        expectedRevision: 1,
        leaseToken: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(FinancePlanningResultNotAppliedError);

    const overflowQuery = vi.fn(async (sql: string) => {
      if (sql.startsWith('select emdo.generate_finance_planning_result'))
        throw Object.assign(new Error('numeric field overflow'), {
          code: '22003',
        });
      return { rowCount: 0, rows: [] };
    });
    const overflow = new PostgresFinancePlanningExecutionRepository(
      poolFor(overflowQuery),
    );
    await expect(
      overflow.generatePlanningResult({
        operationId: randomUUID(),
        expectedRevision: 1,
        leaseToken: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'source-invalid' });

    const readinessQuery = vi.fn(async () => ({
      rowCount: 1,
      rows: [{ ready: false }],
    }));
    const missing = new PostgresFinancePlanningExecutionRepository(
      poolFor(readinessQuery),
    );
    await expect(missing.checkReady()).resolves.toBe(false);
    expect(readinessQuery).toHaveBeenCalledWith(
      expect.stringContaining(
        'generate_finance_planning_result(uuid,integer,uuid)',
      ),
    );
  });
});

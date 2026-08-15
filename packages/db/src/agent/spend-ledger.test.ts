import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  PostgresSpendLedger,
  checkPostgresAudioSpendReadiness,
} from './spend-ledger.js';

const principal = {
  userId: '20000000-0000-4000-8000-000000000001',
  sessionId: '20000000-0000-4000-8000-000000000002',
  requestId: '20000000-0000-4000-8000-000000000003',
  householdId: '20000000-0000-4000-8000-000000000004',
};
const request = {
  authorizationHash: 'a'.repeat(64),
  category: 'model' as const,
  estimatedCadMinor: 100,
  executionId: 'execution-00000001',
  householdId: principal.householdId,
  period: '2026-08',
  requestHash: 'b'.repeat(64),
  reservationId: 'reservation-00001',
};

const poolFor = (
  respond: (
    sql: string,
    values: readonly unknown[],
  ) => Record<string, unknown>[],
) => {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => ({
    rowCount: 1,
    rows: respond(sql, values),
  }));
  const client: DatabaseClient = { query, release: vi.fn() };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query, client };
};

const stored = (state: string, decisionCadMinor = 100) => ({
  reservation_id: request.reservationId,
  household_id: request.householdId,
  period: request.period,
  request_hash: request.requestHash,
  authorization_hash: request.authorizationHash,
  execution_id: request.executionId,
  estimated_cad_minor: '100',
  actual_cad_minor: null,
  decision_cad_minor: String(decisionCadMinor),
  warning: false,
  state,
});

describe('PostgresSpendLedger', () => {
  it('accepts only the literal true result from the exact readiness aggregate', async () => {
    for (const [ready, expected] of [
      [true, true],
      [false, false],
      [null, false],
      ['true', false],
    ] as const) {
      const { pool, query, client } = poolFor((sql) =>
        sql.includes('emdo.audio_spend_ready()') ? [{ ready }] : [],
      );

      await expect(checkPostgresAudioSpendReadiness(pool)).resolves.toBe(
        expected,
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('emdo.audio_spend_ready()'),
        [],
      );
      expect(client.release).toHaveBeenCalledTimes(1);
    }
  });

  it('fails readiness closed and releases the failed database session', async () => {
    const client: DatabaseClient = {
      query: vi.fn(async () => {
        throw new Error('private database detail');
      }),
      release: vi.fn(),
    };
    const pool: DatabasePool = { connect: vi.fn(async () => client) };

    await expect(checkPostgresAudioSpendReadiness(pool)).resolves.toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('serializes the monthly total and persists an exact reservation result', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('reserve_ai_spend')) {
        return [{ ...stored('reserved', 5000), warning: true }];
      }
      return [];
    });

    await expect(
      new PostgresSpendLedger(pool, principal).reserve(request, {
        warningCadMinor: 5000,
        limitCadMinor: 7500,
      }),
    ).resolves.toEqual({
      status: 'reserved',
      warning: true,
      period: '2026-08',
      projectedCadMinor: 5000,
      reservationId: request.reservationId,
    });
    expect(
      query.mock.calls.some(([sql]) => sql.includes('reserve_ai_spend')),
    ).toBe(true);
  });

  it('persists a blocked decision without exceeding the household limit', async () => {
    const { pool } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('reserve_ai_spend')) {
        return [{ ...stored('blocked', 7450), warning: true }];
      }
      return [];
    });

    await expect(
      new PostgresSpendLedger(pool, principal).reserve(request, {
        warningCadMinor: 5000,
        limitCadMinor: 7500,
      }),
    ).resolves.toMatchObject({
      status: 'blocked',
      currentCadMinor: 7450,
      warning: true,
    });
  });

  it('rejects caller attempts to override the locked CAD 50/CAD 75 thresholds', async () => {
    const { pool, query } = poolFor(() => []);

    await expect(
      new PostgresSpendLedger(pool, principal).reserve(request, {
        warningCadMinor: 5000,
        limitCadMinor: 75_000,
      }),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('fails closed when the database reservation command rejects an idempotency conflict', async () => {
    const { pool } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('reserve_ai_spend')) {
        throw new Error('spend-reservation-idempotency-conflict');
      }
      return [];
    });

    await expect(
      new PostgresSpendLedger(pool, principal).reserve(request, {
        warningCadMinor: 5000,
        limitCadMinor: 7500,
      }),
    ).rejects.toThrow('spend-reservation-idempotency-conflict');
  });

  it('settles through the exact post-dispatch database function', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      return sql.includes('settle_ai_spend')
        ? [
            {
              period: '2026-08',
              reservation_id: request.reservationId,
              actual_cad_minor: '125',
              reservation_exceeded: true,
            },
          ]
        : [];
    });

    await expect(
      new PostgresSpendLedger(pool, principal).settle({
        reservationId: request.reservationId,
        executionId: request.executionId,
        actualCadMinor: 125,
      }),
    ).resolves.toEqual({
      status: 'settled',
      period: '2026-08',
      reservationId: request.reservationId,
      actualCadMinor: 125,
      reservationExceeded: true,
    });
    expect(
      query.mock.calls.some(([sql]) => sql.includes('settle_ai_spend')),
    ).toBe(true);
  });
});

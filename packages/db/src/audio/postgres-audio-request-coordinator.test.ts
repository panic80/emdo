import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  AudioRequestCoordinatorError,
  PostgresAudioRequestCoordinator,
  PostgresAudioRequestReconciliationStore,
} from './postgres-audio-request-coordinator.js';

const ids = {
  user: 'a1000000-0000-4000-8000-000000000001',
  session: 'a1000000-0000-4000-8000-000000000002',
  request: 'a1000000-0000-4000-8000-000000000003',
  household: 'a1000000-0000-4000-8000-000000000004',
  claim: 'a1000000-0000-4000-8000-000000000005',
  execution: 'a1000000-0000-4000-8000-000000000006',
  reservation: 'a1000000-0000-4000-8000-000000000007',
  receipt: 'a1000000-0000-4000-8000-000000000008',
  operation: 'a1000000-0000-4000-8000-000000000010',
} as const;

const principal = {
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  role: 'owner' as const,
  emailVerified: true as const,
  spaceAccessGrantId: 'a1000000-0000-4000-8000-000000000009',
};

const claimInput = {
  kind: 'transcription' as const,
  model: 'gpt-4o-mini-transcribe' as const,
  inputUnits: 4_096,
  requestFingerprint: 'a'.repeat(64),
  principal,
  requestId: ids.request,
  idempotencyKey: 'audio:request:durable:0001',
};

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
  const release = vi.fn();
  const client: DatabaseClient = { query, release };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query, release };
};

const claimRow = (status: string, extra: Record<string, unknown> = {}) => ({
  claim_result: { status, ...extra },
});

describe('PostgresAudioRequestCoordinator', () => {
  it('claims one exact request with a database-bound token hash and no audio bytes', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('claim_audio_request')
        ? [
            claimRow('claimed', {
              claimId: ids.claim,
              executionId: ids.execution,
              reservationId: ids.reservation,
            }),
          ]
        : [],
    );
    const coordinator = new PostgresAudioRequestCoordinator(pool);

    const result = await coordinator.claim(claimInput);

    expect(result).toMatchObject({
      status: 'claimed',
      claimId: ids.claim,
      executionId: ids.execution,
      reservationId: ids.reservation,
      ownershipToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    const claim = query.mock.calls.find(([sql]) =>
      sql.includes('claim_audio_request'),
    );
    expect(claim?.[1]?.slice(0, 5)).toEqual([
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
      expect.stringMatching(/^[a-f0-9]{64}$/u),
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    ]);
    expect(claim?.[1]?.slice(5)).toEqual([
      claimInput.idempotencyKey,
      claimInput.kind,
      claimInput.model,
      claimInput.inputUnits,
      claimInput.requestFingerprint,
      createHash('sha256')
        .update((result as { ownershipToken: string }).ownershipToken, 'utf8')
        .digest('hex'),
      120_000,
      principal.householdId,
      principal.spaceAccessGrantId,
      principal.role,
    ]);
    expect(
      claim?.[1]?.some(
        (value) => value instanceof Uint8Array || Buffer.isBuffer(value),
      ),
    ).toBe(false);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'begin',
      'set local row_security = on',
      "set local statement_timeout = '30s'",
      "set local lock_timeout = '5s'",
      expect.stringContaining("set_config('emdo.user_id'"),
      expect.stringContaining('claim_audio_request'),
      'commit',
    ]);
  });

  it.each([
    [
      'in-progress',
      { retryAfterMs: 12_345 },
      { status: 'in-progress', retryAfterMs: 12_345 },
    ],
    ['conflict', {}, { status: 'conflict' }],
    ['completed-nonreplayable', {}, { status: 'completed-nonreplayable' }],
    ['indeterminate', {}, { status: 'indeterminate' }],
    [
      'replay',
      {
        result: {
          kind: 'transcription',
          transcript: 'durable transcript',
          model: 'gpt-4o-mini-transcribe',
          spendWarning: true,
        },
      },
      {
        status: 'replay',
        result: {
          kind: 'transcription',
          transcript: 'durable transcript',
          model: 'gpt-4o-mini-transcribe',
          spendWarning: true,
        },
      },
    ],
  ] as const)(
    'maps the durable %s claim outcome',
    async (status, extra, expected) => {
      const { pool } = poolFor((sql) =>
        sql.includes('claim_audio_request') ? [claimRow(status, extra)] : [],
      );

      await expect(
        new PostgresAudioRequestCoordinator(pool).claim(claimInput),
      ).resolves.toEqual(expected);
    },
  );

  it('destroys an ambiguous commit session and verifies the exact operation acknowledgement on a fresh connection', async () => {
    const firstQuery = vi.fn(async (sql: string) => {
      if (sql.includes('complete_audio_transcription')) {
        return {
          rowCount: 1,
          rows: [{ settlement_result: { status: 'completed' } }],
        };
      }
      if (sql === 'commit') throw new Error('commit response lost');
      return { rowCount: 0, rows: [] };
    });
    const secondQuery = vi.fn(async (sql: string) => {
      if (sql.includes('read_audio_request_operation')) {
        return {
          rowCount: 1,
          rows: [{ readback_result: { status: 'exact-replay' } }],
        };
      }
      return { rowCount: 0, rows: [] };
    });
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    const clients: DatabaseClient[] = [
      { query: firstQuery, release: firstRelease },
      { query: secondQuery, release: secondRelease },
    ];
    const pool: DatabasePool = {
      connect: vi.fn(async () => clients.shift()!),
    };
    const coordinator = new PostgresAudioRequestCoordinator(pool);

    await expect(
      coordinator.completeTranscription({
        claimId: ids.claim,
        ownershipToken: 't'.repeat(43),
        transcript: 'settled once',
        model: 'gpt-4o-mini-transcribe',
        spendWarning: false,
        principal,
        requestId: ids.request,
      }),
    ).resolves.toBeUndefined();

    expect(
      firstQuery.mock.calls.filter(([sql]) =>
        sql.includes('complete_audio_transcription'),
      ),
    ).toHaveLength(1);
    expect(
      secondQuery.mock.calls.filter(([sql]) =>
        sql.includes('read_audio_request_operation'),
      ),
    ).toHaveLength(1);
    expect(firstRelease).toHaveBeenCalledWith(true);
    expect(secondRelease).toHaveBeenCalledWith(false);
  });

  it('re-evaluates an unmutated claim outcome after a lost COMMIT acknowledgement', async () => {
    const firstQuery = vi.fn(async (sql: string) => {
      if (sql.includes('claim_audio_request')) {
        return { rowCount: 1, rows: [claimRow('conflict')] };
      }
      if (sql === 'commit') throw new Error('claim commit response lost');
      return { rowCount: 0, rows: [] };
    });
    const secondQuery = vi.fn(
      async (sql: string, values?: readonly unknown[]) => {
        void values;
        if (sql.includes('read_audio_request_claim')) {
          return {
            rowCount: 1,
            rows: [{ readback_result: { status: 'conflict' } }],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    );
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    const clients: DatabaseClient[] = [
      { query: firstQuery, release: firstRelease },
      { query: secondQuery, release: secondRelease },
    ];
    const pool: DatabasePool = {
      connect: vi.fn(async () => clients.shift()!),
    };

    await expect(
      new PostgresAudioRequestCoordinator(pool).claim(claimInput),
    ).resolves.toEqual({ status: 'conflict' });

    expect(firstRelease).toHaveBeenCalledWith(true);
    expect(secondRelease).toHaveBeenCalledWith(false);
    const readback = secondQuery.mock.calls.find(([sql]) =>
      sql.includes('read_audio_request_claim'),
    );
    expect(readback?.[1]?.slice(4, 9)).toEqual([
      claimInput.idempotencyKey,
      claimInput.kind,
      claimInput.model,
      claimInput.inputUnits,
      claimInput.requestFingerprint,
    ]);
  });

  it('releases only a known-no-dispatch owner and denies stale ownership tokens', async () => {
    const exact = poolFor((sql) =>
      sql.includes('release_audio_request_claim')
        ? [{ settlement_result: { status: 'released' } }]
        : [],
    );
    await expect(
      new PostgresAudioRequestCoordinator(exact.pool).releaseKnownNoDispatch({
        claimId: ids.claim,
        ownershipToken: 'u'.repeat(43),
        reasonCode: 'transcription-provider-not-dispatched',
        principal,
        requestId: ids.request,
      }),
    ).resolves.toBeUndefined();

    const denied = poolFor((sql) =>
      sql.includes('release_audio_request_claim')
        ? [{ settlement_result: { status: 'denied' } }]
        : [],
    );
    await expect(
      new PostgresAudioRequestCoordinator(denied.pool).releaseKnownNoDispatch({
        claimId: ids.claim,
        ownershipToken: 'v'.repeat(43),
        reasonCode: 'transcription-provider-not-dispatched',
        principal,
        requestId: ids.request,
      }),
    ).rejects.toMatchObject({
      name: 'AudioRequestCoordinatorError',
      code: 'stale-ownership',
    } satisfies Partial<AudioRequestCoordinatorError>);
  });

  it('persists only bounded indeterminate reasons and cannot treat denial as success', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('mark_audio_request_indeterminate')
        ? [{ settlement_result: { status: 'indeterminate' } }]
        : [],
    );
    const coordinator = new PostgresAudioRequestCoordinator(pool);
    await coordinator.markIndeterminate({
      claimId: ids.claim,
      ownershipToken: 'w'.repeat(43),
      reasonCode: 'speech-provider-state-unknown',
      principal,
      requestId: ids.request,
    });
    const transition = query.mock.calls.find(([sql]) =>
      sql.includes('mark_audio_request_indeterminate'),
    );
    expect(transition?.[1]?.[4]).toBe('speech-provider-state-unknown');
    expect(transition?.[1]?.slice(5)).toEqual([
      principal.householdId,
      principal.spaceAccessGrantId,
      principal.role,
    ]);

    await expect(
      coordinator.markIndeterminate({
        claimId: ids.claim,
        ownershipToken: 'w'.repeat(43),
        reasonCode: 'raw-provider-error-body' as never,
        principal,
        requestId: ids.request,
      }),
    ).rejects.toThrow();
  });

  it('uses a narrow database readiness probe and fails closed on malformed results', async () => {
    const ready = poolFor((sql) =>
      sql.includes('audio_request_receipts_ready') ? [{ ready: true }] : [],
    );
    await expect(
      new PostgresAudioRequestCoordinator(ready.pool).checkReady(),
    ).resolves.toBe(true);
    expect(ready.release).toHaveBeenCalledOnce();

    const malformed = poolFor((sql) =>
      sql.includes('audio_request_receipts_ready') ? [{ ready: 'yes' }] : [],
    );
    await expect(
      new PostgresAudioRequestCoordinator(malformed.pool).checkReady(),
    ).resolves.toBe(false);
  });
});

describe('PostgresAudioRequestReconciliationStore', () => {
  it('bounds operator listing and resolves only versioned enumerated outcomes', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('list_audio_request_reconciliation')) {
        return [
          {
            receipt_id: ids.receipt,
            kind: 'speech',
            model: 'tts-1',
            reason_code: 'claim-lease-expired',
            version: 2,
            execution_id: ids.execution,
            reservation_id: ids.reservation,
            marked_at: new Date('2026-08-10T14:00:00.000Z'),
          },
        ];
      }
      if (sql.includes('resolve_audio_request_reconciliation')) {
        return [{ resolution_result: 'resolved' }];
      }
      return [];
    });
    const store = new PostgresAudioRequestReconciliationStore(pool);

    await expect(store.listPending({ limit: 25 })).resolves.toEqual([
      {
        receiptId: ids.receipt,
        kind: 'speech',
        model: 'tts-1',
        reasonCode: 'claim-lease-expired',
        version: 2,
        executionId: ids.execution,
        reservationId: ids.reservation,
        markedAt: '2026-08-10T14:00:00.000Z',
      },
    ]);
    await expect(
      store.resolve({
        operationId: ids.operation,
        receiptId: ids.receipt,
        expectedVersion: 2,
        resolution: 'confirmed-not-dispatched',
        operatorReference: 'incident-2026-08-10-0001',
      }),
    ).resolves.toBe('resolved');
    await expect(store.listPending({ limit: 1_001 })).rejects.toThrow();

    const resolution = query.mock.calls.find(([sql]) =>
      sql.includes('resolve_audio_request_reconciliation'),
    );
    expect(resolution?.[1]).toEqual([
      ids.operation,
      createHash('sha256')
        .update(
          `${ids.receipt}:2:confirmed-not-dispatched:incident-2026-08-10-0001`,
          'utf8',
        )
        .digest('hex'),
      ids.receipt,
      2,
      'confirmed-not-dispatched',
      'incident-2026-08-10-0001',
    ]);
  });

  it('destroys an ambiguous operator session and verifies its exact acknowledgement', async () => {
    const firstQuery = vi.fn(async (sql: string) => {
      if (sql.includes('resolve_audio_request_reconciliation')) {
        return {
          rowCount: 1,
          rows: [{ resolution_result: 'resolved' }],
        };
      }
      if (sql === 'commit') throw new Error('operator commit response lost');
      return { rowCount: 0, rows: [] };
    });
    const secondQuery = vi.fn(
      async (sql: string, values?: readonly unknown[]) => {
        void values;
        if (sql.includes('read_audio_request_reconciliation_operation')) {
          return {
            rowCount: 1,
            rows: [{ resolution_result: 'resolved' }],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    );
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    const clients: DatabaseClient[] = [
      { query: firstQuery, release: firstRelease },
      { query: secondQuery, release: secondRelease },
    ];
    const pool: DatabasePool = {
      connect: vi.fn(async () => clients.shift()!),
    };

    await expect(
      new PostgresAudioRequestReconciliationStore(pool).resolve({
        operationId: ids.operation,
        receiptId: ids.receipt.toUpperCase(),
        expectedVersion: 2,
        resolution: 'confirmed-dispatched',
        operatorReference: 'incident-2026-08-10-0002',
      }),
    ).resolves.toBe('resolved');

    expect(firstRelease).toHaveBeenCalledWith(true);
    expect(secondRelease).toHaveBeenCalledWith(false);
    const readback = secondQuery.mock.calls.find(([sql]) =>
      sql.includes('read_audio_request_reconciliation_operation'),
    );
    expect(readback?.[1]?.[2]).toBe(ids.receipt);
  });

  it('accepts revisions beyond the former v64 dead-end and exposes a narrow readiness probe', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('resolve_audio_request_reconciliation')) {
        return [{ resolution_result: 'resolved' }];
      }
      if (sql.includes('audio_request_reconciliation_ready')) {
        return [{ ready: true }];
      }
      return [];
    });
    const store = new PostgresAudioRequestReconciliationStore(pool);

    await expect(
      store.resolve({
        operationId: ids.operation,
        receiptId: ids.receipt,
        expectedVersion: 65,
        resolution: 'confirmed-not-dispatched',
        operatorReference: 'incident-2026-08-10-0065',
      }),
    ).resolves.toBe('resolved');
    await expect(store.checkReady()).resolves.toBe(true);
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('audio_request_reconciliation_ready'),
      ),
    ).toBe(true);
  });
});

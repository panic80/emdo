import { describe, expect, it, vi } from 'vitest';

import {
  InMemorySpendAuthorizationResolver,
  InMemorySpendLedger,
  SpendGuard,
} from './budget.js';

const householdId = 'household-00000000-0000-4000-8000-000000000001';

const createFixture = (initialNow = '2026-01-15T17:00:00.000Z') => {
  let now = new Date(initialNow);
  const ledger = new InMemorySpendLedger();
  const resolver = new InMemorySpendAuthorizationResolver({
    'audio-run-000001': {
      authorizationId: 'authorization-audio-000001',
      category: 'audio',
      householdId,
    },
    'deterministic-run-000001': {
      authorizationId: 'authorization-deterministic-000001',
      category: 'deterministic',
      householdId,
    },
    'model-run-000001': {
      authorizationId: 'authorization-model-000001',
      category: 'model',
      householdId,
    },
    'model-run-000002': {
      authorizationId: 'authorization-model-000002',
      category: 'model',
      householdId,
    },
  });
  const guard = new SpendGuard(ledger, resolver, () => new Date(now));
  return {
    guard,
    ledger,
    resolver,
    setNow: (value: string | number) => {
      now = new Date(value);
    },
  };
};

describe('SpendGuard', () => {
  it('warns at CAD 50 and blocks new model/audio work at CAD 75', async () => {
    const { guard } = createFixture();

    const first = await guard.reserve({
      executionId: 'model-run-000001',
      estimatedCadMinor: 5_000,
      reservationId: 'reservation-00000001',
    });
    expect(first.status).toBe('reserved');
    if (first.status !== 'reserved') {
      throw new Error('expected a metered reservation');
    }
    expect(first.warning).toBe(true);
    await guard.settle({
      executionId: 'model-run-000001',
      reservationId: 'reservation-00000001',
      actualCadMinor: 5_000,
    });

    const second = await guard.reserve({
      executionId: 'audio-run-000001',
      estimatedCadMinor: 2_500,
      reservationId: 'reservation-00000002',
    });
    expect(second.status).toBe('reserved');
    await guard.settle({
      executionId: 'audio-run-000001',
      reservationId: 'reservation-00000002',
      actualCadMinor: 2_500,
    });

    await expect(
      guard.reserve({
        executionId: 'model-run-000002',
        estimatedCadMinor: 1,
        reservationId: 'reservation-00000003',
      }),
    ).resolves.toMatchObject({
      status: 'blocked',
      safeError: { code: 'monthly-ai-spend-limit-reached' },
    });
  });

  it('derives the deterministic exemption from an authoritative resolver', async () => {
    const { guard } = createFixture('2026-02-01T01:30:00.000Z');

    await expect(
      guard.reserve({
        executionId: 'deterministic-run-000001',
        estimatedCadMinor: Number.MAX_SAFE_INTEGER,
        reservationId: 'reservation-00000004',
      }),
    ).resolves.toEqual({
      status: 'not-metered',
      warning: false,
      period: '2026-01',
    });
    await expect(
      guard.reserve({
        executionId: 'unknown-run-000001',
        estimatedCadMinor: 1,
        reservationId: 'reservation-00000005',
      }),
    ).rejects.toThrow('spend-authorization-denied');
  });

  it('uses an injected Toronto clock across UTC month boundaries', async () => {
    const { guard, ledger } = createFixture('2026-02-01T04:30:00.000Z');

    await guard.reserve({
      executionId: 'model-run-000001',
      estimatedCadMinor: 100,
      reservationId: 'reservation-00000006',
    });
    await guard.settle({
      executionId: 'model-run-000001',
      reservationId: 'reservation-00000006',
      actualCadMinor: 100,
    });

    expect(await ledger.total(householdId, '2026-01')).toBe(100);
    expect(await ledger.total(householdId, '2026-02')).toBe(0);
  });

  it('binds idempotent reservation replay to the exact authorization and request', async () => {
    const { guard, resolver } = createFixture('2026-03-01T12:00:00.000Z');
    const request = {
      executionId: 'model-run-000001',
      estimatedCadMinor: 250,
      reservationId: 'reservation-00000007',
    };

    const first = await guard.reserve(request);
    await expect(guard.reserve(request)).resolves.toEqual(first);
    await expect(
      guard.reserve({ ...request, estimatedCadMinor: 251 }),
    ).rejects.toThrow('spend-reservation-idempotency-conflict');

    resolver.set('model-run-000001', {
      authorizationId: 'authorization-model-revoked-000001',
      category: 'model',
      householdId,
    });
    await expect(guard.reserve(request)).rejects.toThrow(
      'spend-reservation-idempotency-conflict',
    );
  });

  it('persists a blocked decision so later capacity cannot reuse its key', async () => {
    const { guard } = createFixture('2026-03-02T12:00:00.000Z');
    await guard.reserve({
      executionId: 'model-run-000001',
      estimatedCadMinor: 7_500,
      reservationId: 'reservation-00000008',
    });
    const blockedRequest = {
      executionId: 'audio-run-000001',
      estimatedCadMinor: 1,
      reservationId: 'reservation-00000009',
    };
    const blocked = await guard.reserve(blockedRequest);
    expect(blocked.status).toBe('blocked');

    await guard.release({
      executionId: 'model-run-000001',
      reservationId: 'reservation-00000008',
    });
    await expect(guard.reserve(blockedRequest)).resolves.toEqual(blocked);
  });

  it('replays released and settled reservations as terminal, never active', async () => {
    const { guard } = createFixture('2026-04-02T12:00:00.000Z');
    const releasedRequest = {
      executionId: 'audio-run-000001',
      estimatedCadMinor: 7_500,
      reservationId: 'reservation-00000010',
    };
    await guard.reserve(releasedRequest);
    await expect(
      guard.release({
        executionId: releasedRequest.executionId,
        reservationId: releasedRequest.reservationId,
      }),
    ).resolves.toMatchObject({ status: 'released' });
    await expect(guard.reserve(releasedRequest)).resolves.toMatchObject({
      status: 'released',
    });

    const settledRequest = {
      executionId: 'model-run-000002',
      estimatedCadMinor: 200,
      reservationId: 'reservation-00000011',
    };
    await guard.reserve(settledRequest);
    await guard.settle({
      executionId: settledRequest.executionId,
      reservationId: settledRequest.reservationId,
      actualCadMinor: 150,
    });
    await expect(guard.reserve(settledRequest)).resolves.toMatchObject({
      status: 'settled',
      actualCadMinor: 150,
    });
  });

  it('requires a positive reservation and records billed overage', async () => {
    const { guard, ledger } = createFixture('2026-04-03T12:00:00.000Z');
    await expect(
      guard.reserve({
        executionId: 'model-run-000001',
        estimatedCadMinor: 0,
        reservationId: 'reservation-00000012',
      }),
    ).rejects.toThrow('invalid-spend-request');

    await guard.reserve({
      executionId: 'model-run-000001',
      estimatedCadMinor: 100,
      reservationId: 'reservation-00000013',
    });
    await expect(
      guard.settle({
        executionId: 'model-run-000001',
        reservationId: 'reservation-00000013',
        actualCadMinor: 101,
      }),
    ).resolves.toMatchObject({
      status: 'settled',
      actualCadMinor: 101,
      reservationExceeded: true,
    });
    expect(await ledger.total(householdId, '2026-04')).toBe(101);
  });

  it('scopes settlement and release to the same authoritative execution', async () => {
    const { guard } = createFixture('2026-04-04T12:00:00.000Z');
    await guard.reserve({
      executionId: 'model-run-000001',
      estimatedCadMinor: 100,
      reservationId: 'reservation-00000014',
    });

    await expect(
      guard.settle({
        executionId: 'model-run-000002',
        reservationId: 'reservation-00000014',
        actualCadMinor: 100,
      }),
    ).rejects.toThrow('spend-reservation-authorization-mismatch');
    await expect(
      guard.release({
        executionId: 'model-run-000002',
        reservationId: 'reservation-00000014',
      }),
    ).rejects.toThrow('spend-reservation-authorization-mismatch');
  });

  it('rejects unsafe values and an invalid trusted clock', async () => {
    const { guard, setNow } = createFixture('2026-04-05T12:00:00.000Z');
    await expect(
      guard.reserve({
        executionId: 'model-run-000001',
        estimatedCadMinor: Number.MAX_SAFE_INTEGER + 1,
        reservationId: 'reservation-00000015',
      }),
    ).rejects.toThrow('invalid-spend-request');

    setNow(Number.NaN);
    await expect(
      guard.reserve({
        executionId: 'model-run-000001',
        estimatedCadMinor: 1,
        reservationId: 'reservation-00000016',
      }),
    ).rejects.toThrow('invalid-spend-request');
  });

  it('rejects accessor-backed resolver output instead of re-reading mutable authority', async () => {
    let categoryReads = 0;
    const resolver = {
      resolve: async () => {
        const authorization = {
          authorizationId: 'authorization-accessor-000001',
          householdId,
        } as SpendAuthorizationWithGetter;
        Object.defineProperty(authorization, 'category', {
          enumerable: true,
          get: () => (++categoryReads === 1 ? 'model' : 'deterministic'),
        });
        return authorization;
      },
    };
    const guard = new SpendGuard(
      new InMemorySpendLedger(),
      resolver,
      () => new Date('2026-04-06T12:00:00.000Z'),
    );

    await expect(
      guard.reserve({
        executionId: 'model-run-accessor-000001',
        estimatedCadMinor: 1,
        reservationId: 'reservation-00000017',
      }),
    ).rejects.toThrow('spend-authorization-denied');
    expect(categoryReads).toBe(0);
  });

  it('captures ledger operations at construction instead of trusting later mutation', async () => {
    const ledger = new InMemorySpendLedger();
    const replacementReserve = vi.fn(async () => {
      throw new Error('replacement ledger method must not execute');
    });
    const resolver = new InMemorySpendAuthorizationResolver({
      'model-run-mutation-000001': {
        authorizationId: 'authorization-mutation-000001',
        category: 'model',
        householdId,
      },
    });
    const guard = new SpendGuard(
      ledger,
      resolver,
      () => new Date('2026-04-07T12:00:00.000Z'),
    );
    (ledger as unknown as { reserve: typeof replacementReserve }).reserve =
      replacementReserve;

    await expect(
      guard.reserve({
        executionId: 'model-run-mutation-000001',
        estimatedCadMinor: 1,
        reservationId: 'reservation-00000018',
      }),
    ).resolves.toMatchObject({ status: 'reserved' });
    expect(replacementReserve).not.toHaveBeenCalled();
  });

  it('rejects accessor-backed spend requests before an authorization await', async () => {
    const { guard } = createFixture('2026-04-08T12:00:00.000Z');
    let reads = 0;
    const request = {
      executionId: 'model-run-000001',
      reservationId: 'reservation-00000019',
      get estimatedCadMinor() {
        reads += 1;
        return reads === 1 ? 1 : -100;
      },
    };

    await expect(guard.reserve(request)).rejects.toThrow(
      'invalid-spend-request',
    );
  });

  it('records late billed usage after release and blocks further capacity', async () => {
    const { guard, ledger } = createFixture('2026-04-09T12:00:00.000Z');
    await guard.reserve({
      executionId: 'model-run-000001',
      estimatedCadMinor: 7_500,
      reservationId: 'reservation-00000020',
    });
    await guard.release({
      executionId: 'model-run-000001',
      reservationId: 'reservation-00000020',
    });
    await expect(
      guard.settle({
        executionId: 'model-run-000001',
        reservationId: 'reservation-00000020',
        actualCadMinor: 7_500,
      }),
    ).resolves.toMatchObject({ status: 'settled', actualCadMinor: 7_500 });
    expect(await ledger.total(householdId, '2026-04')).toBe(7_500);

    await expect(
      guard.reserve({
        executionId: 'audio-run-000001',
        estimatedCadMinor: 1,
        reservationId: 'reservation-00000021',
      }),
    ).resolves.toMatchObject({ status: 'blocked' });
  });

  it('marks provider dispatch so a billed reservation cannot be released', async () => {
    const { guard } = createFixture('2026-04-10T12:00:00.000Z');
    await guard.reserve({
      executionId: 'model-run-000001',
      estimatedCadMinor: 100,
      reservationId: 'reservation-00000022',
    });
    await expect(
      guard.markDispatched({
        executionId: 'model-run-000001',
        reservationId: 'reservation-00000022',
      }),
    ).resolves.toMatchObject({ status: 'dispatched' });
    await expect(
      guard.release({
        executionId: 'model-run-000001',
        reservationId: 'reservation-00000022',
      }),
    ).rejects.toThrow('dispatched-spend-reservation-cannot-be-released');
    await expect(
      guard.settle({
        executionId: 'model-run-000001',
        reservationId: 'reservation-00000022',
        actualCadMinor: 80,
      }),
    ).resolves.toMatchObject({ status: 'settled', actualCadMinor: 80 });
  });

  it('records trusted post-dispatch billing after live authorization changes', async () => {
    const { guard, ledger, resolver } = createFixture(
      '2026-04-11T12:00:00.000Z',
    );
    await guard.reserve({
      executionId: 'model-run-000001',
      estimatedCadMinor: 1,
      reservationId: 'reservation-00000023',
    });
    await guard.markDispatched({
      executionId: 'model-run-000001',
      reservationId: 'reservation-00000023',
    });
    resolver.set('model-run-000001', {
      authorizationId: 'authorization-model-revoked-000002',
      category: 'model',
      householdId,
    });

    await expect(
      guard.settle({
        executionId: 'model-run-000001',
        reservationId: 'reservation-00000023',
        actualCadMinor: 7_500,
      }),
    ).resolves.toMatchObject({ status: 'settled', actualCadMinor: 7_500 });
    expect(await ledger.total(householdId, '2026-04')).toBe(7_500);
  });
});

interface SpendAuthorizationWithGetter {
  readonly authorizationId: string;
  readonly householdId: string;
  readonly category: 'model' | 'deterministic';
}

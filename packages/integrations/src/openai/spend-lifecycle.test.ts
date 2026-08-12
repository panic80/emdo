import { describe, expect, it } from 'vitest';

import {
  createLateReservationReleaseCallback,
  createReserveSpendOperation,
} from './spend-lifecycle.js';

describe('detached audio spend lifecycle callbacks', () => {
  it('captures only a cloned spend context for a late release', async () => {
    const source = {
      executionId: 'voice-execution-detached-0001',
      reservationId: 'voice-reservation-detached-0001',
      audio: new Uint8Array([9, 8, 7]),
    };
    const released: unknown[] = [];
    const callback = createLateReservationReleaseCallback(
      source,
      async (context) => {
        released.push(context);
        return true;
      },
    );
    source.executionId = 'mutated-execution-id-0000001';
    source.reservationId = 'mutated-reservation-id-0001';

    callback('reserved');
    await Promise.resolve();

    expect(released).toEqual([
      {
        executionId: 'voice-execution-detached-0001',
        reservationId: 'voice-reservation-detached-0001',
      },
    ]);
    expect(released[0]).not.toBe(source);
    expect(released[0]).not.toHaveProperty('audio');
    expect(Object.isFrozen(released[0])).toBe(true);
  });

  it('captures only cloned spend identifiers for a pending reserve operation', async () => {
    const source = {
      executionId: 'voice-execution-detached-0002',
      reservationId: 'voice-reservation-detached-0002',
      audio: new Uint8Array([6, 5, 4]),
    };
    const reservations: unknown[] = [];
    const operation = createReserveSpendOperation(source, 7, async (input) => {
      reservations.push(input);
      return { status: 'reserved' };
    });
    source.executionId = 'mutated-execution-id-0000002';
    source.reservationId = 'mutated-reservation-id-0002';

    await expect(operation()).resolves.toBe('reserved');
    expect(reservations).toEqual([
      {
        executionId: 'voice-execution-detached-0002',
        reservationId: 'voice-reservation-detached-0002',
        estimatedCadMinor: 7,
      },
    ]);
    expect(reservations[0]).not.toHaveProperty('audio');
    expect(Object.isFrozen(reservations[0])).toBe(true);
  });
});

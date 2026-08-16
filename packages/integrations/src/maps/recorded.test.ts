import { describe, expect, it } from 'vitest';

import { RecordedMapsTravelTimeClient } from './recorded.js';

describe('RecordedMapsTravelTimeClient', () => {
  it('serves only exact, validated recorded queries and never infers a route', async () => {
    const client = new RecordedMapsTravelTimeClient([
      {
        query: {
          origin: 'Home',
          destination: 'Clinic',
          mode: 'driving',
          departureAt: '2026-08-10T13:00:00.000Z',
        },
        response: {
          status: 'available',
          durationSeconds: 1_201,
          fetchedAt: '2026-08-10T12:59:00.000Z',
        },
      },
    ]);

    await expect(
      client.lookup({
        origin: 'Home',
        destination: 'Clinic',
        mode: 'driving',
        departureAt: '2026-08-10T13:00:00.000Z',
      }),
    ).resolves.toMatchObject({ status: 'available', durationSeconds: 1_201 });
    await expect(
      client.lookup({
        origin: 'Home',
        destination: 'Unknown',
        mode: 'driving',
        departureAt: '2026-08-10T13:00:00.000Z',
      }),
    ).resolves.toEqual({ status: 'unavailable', reason: 'not-recorded' });
    expect(client.lookupCount).toBe(2);
  });

  it('rejects malformed fixture responses rather than accepting provider text', () => {
    expect(
      () =>
        new RecordedMapsTravelTimeClient([
          {
            query: {
              origin: 'Home',
              destination: 'Clinic',
              mode: 'driving',
              departureAt: '2026-08-10T13:00:00.000Z',
            },
            response: {
              status: 'available',
              durationSeconds: -1,
              fetchedAt: 'not-a-date',
            },
          },
        ]),
    ).toThrow();
  });

  it('rejects accessors and cycles without invoking external code', async () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, 'query', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return {};
      },
    });
    expect(() => new RecordedMapsTravelTimeClient([hostile])).toThrow();
    expect(getterCalls).toBe(0);

    const hostileArray: unknown[] = [];
    Object.defineProperty(hostileArray, '0', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        return hostile;
      },
    });
    expect(() => new RecordedMapsTravelTimeClient(hostileArray)).toThrow();
    expect(getterCalls).toBe(0);

    const client = new RecordedMapsTravelTimeClient([]);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(client.lookup(cyclic)).resolves.toEqual({
      status: 'unavailable',
      reason: 'not-recorded',
    });
  });
});

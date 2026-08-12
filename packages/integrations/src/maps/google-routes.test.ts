import { describe, expect, it } from 'vitest';

import {
  GOOGLE_ROUTES_FIELD_MASK,
  GOOGLE_ROUTES_LIMITS,
  GOOGLE_ROUTES_MATRIX_ENDPOINT,
  GoogleRoutesTravelTimeClient,
  type GoogleRoutesFetch,
} from './index.js';

const apiKey = `AIza${'a'.repeat(35)}`;

const travelQuery = (mode: 'driving' | 'transit' | 'walking' = 'driving') => ({
  origin: '100 Queen St W, Toronto, ON',
  destination: '290 Bremner Blvd, Toronto, ON',
  mode,
  departureAt: '2026-08-10T09:00:00-04:00',
});

const routeResponse = (overrides: Record<string, unknown> = {}) => [
  {
    originIndex: 0,
    destinationIndex: 0,
    status: {},
    condition: 'ROUTE_EXISTS',
    duration: '1200.1s',
    ...overrides,
  },
];

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('GoogleRoutesTravelTimeClient', () => {
  it('calls the exact Routes matrix endpoint with a narrow field mask and Toronto instant', async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const fetch: GoogleRoutesFetch = async (input, init) => {
      requests.push({ input, init });
      return jsonResponse(routeResponse());
    };
    const client = new GoogleRoutesTravelTimeClient({
      fetch,
      getApiKey: () => apiKey,
      clock: () => new Date('2026-08-10T13:00:00.000Z'),
    });

    await expect(client.lookup(travelQuery())).resolves.toEqual({
      status: 'available',
      durationSeconds: 1_201,
      fetchedAt: '2026-08-10T13:00:00.000Z',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe(GOOGLE_ROUTES_MATRIX_ENDPOINT);
    expect(requests[0]?.init?.method).toBe('POST');
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-goog-api-key')).toBe(apiKey);
    expect(headers.get('x-goog-fieldmask')).toBe(GOOGLE_ROUTES_FIELD_MASK);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      origins: [{ waypoint: { address: '100 Queen St W, Toronto, ON' } }],
      destinations: [
        { waypoint: { address: '290 Bremner Blvd, Toronto, ON' } },
      ],
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      departureTime: '2026-08-10T09:00:00-04:00',
      languageCode: 'en-CA',
      regionCode: 'ca',
      units: 'METRIC',
    });
  });

  it.each([
    ['transit', 'TRANSIT'],
    ['walking', 'WALK'],
  ] as const)(
    'maps %s without an invalid driving-only routing preference',
    async (mode, providerMode) => {
      let body: Record<string, unknown> | undefined;
      const client = new GoogleRoutesTravelTimeClient({
        fetch: async (_input, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return jsonResponse(routeResponse({ duration: '601s' }));
        },
        getApiKey: () => apiKey,
      });

      await expect(client.lookup(travelQuery(mode))).resolves.toMatchObject({
        status: 'available',
        durationSeconds: 601,
      });
      expect(body?.travelMode).toBe(providerMode);
      expect(body).not.toHaveProperty('routingPreference');
    },
  );

  it('maps only an explicit ROUTE_NOT_FOUND element to no-route', async () => {
    const client = new GoogleRoutesTravelTimeClient({
      fetch: async () =>
        jsonResponse(
          routeResponse({
            status: { code: 5, message: `${apiKey} private provider detail` },
            condition: 'ROUTE_NOT_FOUND',
            duration: undefined,
          }),
        ),
      getApiKey: () => apiKey,
    });

    const result = await client.lookup(travelQuery());

    expect(result).toEqual({ status: 'unavailable', reason: 'no-route' });
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain('private provider detail');
  });

  it.each([
    [504, 'timeout'],
    [408, 'timeout'],
    [403, 'provider-unavailable'],
    [429, 'provider-unavailable'],
    [500, 'provider-unavailable'],
  ] as const)('maps HTTP %s to a safe status', async (status, reason) => {
    const client = new GoogleRoutesTravelTimeClient({
      fetch: async () =>
        jsonResponse(
          { error: { message: `${apiKey} secret Toronto route body` } },
          status,
        ),
      getApiKey: () => apiKey,
    });

    const result = await client.lookup(travelQuery());

    expect(result).toEqual({ status: 'unavailable', reason });
    expect(JSON.stringify(result)).not.toMatch(
      /AIza|secret Toronto route body/,
    );
  });

  it('rejects malformed and oversized provider JSON without reflecting it', async () => {
    const responses = [
      jsonResponse(
        routeResponse({
          status: { code: 13, message: `${apiKey} provider stack` },
        }),
      ),
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(GOOGLE_ROUTES_LIMITS.maxResponseBytes + 1),
        },
      }),
    ];
    const client = new GoogleRoutesTravelTimeClient({
      fetch: async () => responses.shift()!,
      getApiKey: () => apiKey,
    });

    for (let index = 0; index < 2; index += 1) {
      const result = await client.lookup(travelQuery());
      expect(result).toEqual({
        status: 'unavailable',
        reason: 'provider-unavailable',
      });
      expect(JSON.stringify(result)).not.toMatch(/AIza|provider stack/);
    }
  });

  it('rejects hostile query accessors before key lookup or fetch', async () => {
    let getterCalls = 0;
    let keyCalls = 0;
    let fetchCalls = 0;
    const hostile = { ...travelQuery() } as Record<string, unknown>;
    Object.defineProperty(hostile, 'origin', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('must not execute');
      },
    });
    const client = new GoogleRoutesTravelTimeClient({
      fetch: async () => {
        fetchCalls += 1;
        return jsonResponse(routeResponse());
      },
      getApiKey: () => {
        keyCalls += 1;
        return apiKey;
      },
    });

    await expect(client.lookup(hostile)).resolves.toEqual({
      status: 'unavailable',
      reason: 'provider-unavailable',
    });
    expect(getterCalls).toBe(0);
    expect(keyCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it('preflights raw string lengths before schema transforms or provider access', async () => {
    let keyCalls = 0;
    let fetchCalls = 0;
    const client = new GoogleRoutesTravelTimeClient({
      fetch: async () => {
        fetchCalls += 1;
        return jsonResponse(routeResponse());
      },
      getApiKey: () => {
        keyCalls += 1;
        return apiKey;
      },
    });

    await expect(
      client.lookup({
        ...travelQuery(),
        origin: 'x'.repeat(513),
      }),
    ).resolves.toEqual({
      status: 'unavailable',
      reason: 'provider-unavailable',
    });
    expect(keyCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it('hard-times out key and fetch implementations that ignore abort', async () => {
    const hungKey = new GoogleRoutesTravelTimeClient({
      fetch: async () => jsonResponse(routeResponse()),
      getApiKey: async () => new Promise<string>(() => undefined),
      timeoutMs: 5,
    });
    const hungFetch = new GoogleRoutesTravelTimeClient({
      fetch: async () => new Promise<Response>(() => undefined),
      getApiKey: () => apiKey,
      timeoutMs: 5,
    });

    await expect(hungKey.lookup(travelQuery())).resolves.toEqual({
      status: 'unavailable',
      reason: 'timeout',
    });
    await expect(hungFetch.lookup(travelQuery())).resolves.toEqual({
      status: 'unavailable',
      reason: 'timeout',
    });
  });

  it('honors caller abort without misreporting a provider timeout', async () => {
    const controller = new AbortController();
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const client = new GoogleRoutesTravelTimeClient({
      fetch: async () => {
        fetchStarted();
        return new Promise<Response>(() => undefined);
      },
      getApiKey: () => apiKey,
    });

    const pending = client.lookup(travelQuery(), { signal: controller.signal });
    await started;
    controller.abort();

    await expect(pending).resolves.toEqual({
      status: 'unavailable',
      reason: 'provider-unavailable',
    });
  });

  it('rejects an endpoint override instead of becoming an SSRF primitive', () => {
    expect(
      () =>
        new GoogleRoutesTravelTimeClient({
          fetch: async () => jsonResponse(routeResponse()),
          getApiKey: () => apiKey,
          endpoint: 'https://attacker.example/collect' as never,
        }),
    ).toThrow('invalid-google-routes-endpoint');
  });
});

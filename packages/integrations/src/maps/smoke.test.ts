import { describe, expect, it } from 'vitest';

import {
  GOOGLE_ROUTES_DEPLOYMENT_SMOKE_CONTRACT,
  GoogleRoutesTravelTimeClient,
  runGoogleRoutesDeploymentSmoke,
  runGoogleRoutesFixtureSmoke,
  type MapsTravelQuery,
} from './index.js';

describe('Google Routes deployment smoke', () => {
  it('keeps injected fixture evidence explicitly simulated and never live-ready', async () => {
    let query: MapsTravelQuery | undefined;
    const result = await runGoogleRoutesFixtureSmoke({
      client: {
        async lookup(input) {
          query = input as MapsTravelQuery;
          return {
            status: 'available',
            durationSeconds: 901,
            fetchedAt: '2026-08-10T13:00:02.000Z',
          };
        },
      },
      clock: () => new Date('2026-08-10T13:00:00.000Z'),
      monotonicNowMs: (() => {
        let now = 100;
        return () => (now += 4);
      })(),
    });

    expect(query).toEqual({
      origin: 'Toronto City Hall, 100 Queen St W, Toronto, ON',
      destination: 'CN Tower, 290 Bremner Blvd, Toronto, ON',
      mode: 'walking',
      departureAt: '2026-08-10T09:05:00.000-04:00',
    });
    expect(result).toEqual({
      schemaVersion: 1,
      provider: 'google-routes',
      operation: 'travel-time',
      checkedAt: '2026-08-10T13:00:00.000Z',
      status: 'simulated',
      evidenceClass: 'recorded-fixture',
      latencyMs: 4,
    });
    expect(JSON.stringify(result)).not.toMatch(/Queen|Bremner|duration|901/);
    expect(GOOGLE_ROUTES_DEPLOYMENT_SMOKE_CONTRACT).toMatchObject({
      schemaVersion: 1,
      liveProviderRequired: true,
      fixturePolicy: 'public-toronto-landmarks',
      readyEvidenceClass: 'credentialed-live-endpoint',
    });
  });

  it('redacts thrown fixture details and reports unavailable evidence safely', async () => {
    const result = await runGoogleRoutesFixtureSmoke({
      client: {
        async lookup() {
          throw new Error('AIza-secret private address and provider body');
        },
      },
    });

    expect(result).toMatchObject({
      schemaVersion: 1,
      status: 'unavailable',
      evidenceClass: 'recorded-fixture',
      safeReason: 'smoke-run-failed',
    });
    expect(JSON.stringify(result)).not.toMatch(
      /AIza|private address|provider body/,
    );
  });

  it('refuses to label an injected client as live deployment evidence', async () => {
    let keyCalls = 0;
    let fetchCalls = 0;
    const injectedClient = new GoogleRoutesTravelTimeClient({
      fetch: async () => {
        fetchCalls += 1;
        return new Response();
      },
      getApiKey: () => {
        keyCalls += 1;
        return `AIza${'a'.repeat(35)}`;
      },
    });

    const result = await runGoogleRoutesDeploymentSmoke({
      client: injectedClient,
    });

    expect(result).toMatchObject({
      schemaVersion: 1,
      status: 'unavailable',
      evidenceClass: 'not-live',
      safeReason: 'live-client-required',
    });
    expect(keyCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it('bounds a fixture smoke client that ignores abort', async () => {
    const result = await Promise.race([
      runGoogleRoutesFixtureSmoke({
        client: {
          async lookup() {
            return new Promise<never>(() => undefined);
          },
        },
        timeoutMs: 5,
      }),
      new Promise<'did-not-settle'>((resolve) =>
        setTimeout(() => resolve('did-not-settle'), 100),
      ),
    ]);

    expect(result).not.toBe('did-not-settle');
    expect(result).toMatchObject({
      status: 'unavailable',
      evidenceClass: 'recorded-fixture',
      safeReason: 'timeout',
    });
  });

  it('rejects accessor-bearing smoke options without invoking them', async () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, 'client', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('must not execute');
      },
    });

    const result = await runGoogleRoutesFixtureSmoke(hostile as never);

    expect(result).toMatchObject({
      status: 'unavailable',
      evidenceClass: 'recorded-fixture',
      safeReason: 'smoke-run-failed',
    });
    expect(getterCalls).toBe(0);
  });

  it('creates live clients only through the exact global-fetch deployment factory', () => {
    const client = GoogleRoutesTravelTimeClient.createDeploymentClient({
      getApiKey: () => `AIza${'a'.repeat(35)}`,
    });

    expect(client).toBeInstanceOf(GoogleRoutesTravelTimeClient);
  });
});

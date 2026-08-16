import { describe, expect, it, vi } from 'vitest';

import {
  GoogleCalendarFreeBusyClient,
  GoogleCalendarReadClient,
} from './calendar-fetch.js';
import {
  createGoogleCalendarCredentialedLiveSmokeTarget,
  runGoogleCalendarReadOnlyFixtureSmoke,
  runGoogleCalendarReadOnlySmoke,
} from './calendar-smoke.js';

const actor = {
  userId: 'user-1',
  householdId: 'household-1',
  privateSpaceId: 'private-space-1',
  sessionId: 'session-1',
};

const clock = () => new Date('2026-08-09T12:00:00.000Z');

const productionClients = () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const broker = {
    acquireAccessTokenForCapability: vi.fn(async () => ({
      accessToken: 'credentialed-live-access-token',
      grantReference: 'grant-reference-0000000001',
      authorizationEpoch: 0,
      expiresAt: '2026-08-09T13:00:00.000Z',
    })),
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (
      url ===
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&minAccessRole=freeBusyReader&showDeleted=false&fields=nextPageToken%2Citems%28id%2Csummary%2CaccessRole%2Cprimary%2CtimeZone%29'
    ) {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'primary',
              summary: 'Sensitive calendar name',
              accessRole: 'owner',
              primary: true,
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    }
    if (url === 'https://www.googleapis.com/calendar/v3/freeBusy') {
      return new Response(
        JSON.stringify({ calendars: { primary: { busy: [] } } }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    }
    throw new Error('unexpected Google Calendar request');
  });
  return {
    broker,
    calls,
    fetch,
    readClient: new GoogleCalendarReadClient({ fetch, broker, clock }),
    freeBusyClient: new GoogleCalendarFreeBusyClient({
      fetch,
      broker,
      clock,
    }),
  };
};

describe('Google Calendar read-only smoke evidence', () => {
  it('keeps recorded or simulated ports explicitly ineligible for release acceptance', async () => {
    const listCalendars = vi.fn(async () => ({
      calendars: [
        {
          id: 'primary',
          summary: 'Sensitive calendar name',
          accessRole: 'owner',
          primary: true,
        },
      ],
      fetchedAt: '2026-08-09T12:00:00.000Z',
      grantReference: 'sensitive-grant-reference',
    }));
    const query = vi.fn(async () => ({
      calendars: [
        {
          calendarId: 'primary',
          status: 'available',
          busy: [
            {
              start: '2026-08-09T12:01:00.000Z',
              end: '2026-08-09T12:02:00.000Z',
            },
          ],
        },
      ],
      fetchedAt: '2026-08-09T12:00:00.000Z',
      grantReference: 'sensitive-grant-reference',
    }));

    const result = await runGoogleCalendarReadOnlyFixtureSmoke({
      actor,
      readClient: { listCalendars },
      freeBusyClient: { query },
      clock,
    });

    expect(result).toEqual({
      schemaVersion: 1,
      provider: 'google-calendar',
      operation: 'calendar-list-free-busy',
      status: 'simulated',
      evidenceClass: 'recorded-or-simulated',
      releaseEligible: false,
      calendarCount: 1,
      freeBusy: 'available',
      checkedAt: '2026-08-09T12:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toMatch(/Sensitive|grant-reference/);
  });

  it('is inert unless the credentialed-live check is explicitly enabled', async () => {
    const result = await runGoogleCalendarReadOnlySmoke({
      enabled: false,
      actor,
      target: {} as never,
      clock,
    });

    expect(result).toEqual({
      schemaVersion: 1,
      provider: 'google-calendar',
      operation: 'calendar-list-free-busy',
      status: 'skipped',
      evidenceClass: 'not-run',
      releaseEligible: false,
      reason: 'not-enabled',
    });
  });

  it('refuses arbitrary fixture ports as credentialed-live evidence without invoking them', async () => {
    const listCalendars = vi.fn();
    const query = vi.fn();

    const result = await runGoogleCalendarReadOnlySmoke({
      enabled: true,
      actor,
      target: {
        readClient: { listCalendars },
        freeBusyClient: { query },
      } as never,
      clock,
    });

    expect(result).toEqual({
      schemaVersion: 1,
      provider: 'google-calendar',
      operation: 'calendar-list-free-busy',
      status: 'unavailable',
      evidenceClass: 'not-live',
      releaseEligible: false,
      safeCode: 'google-calendar-live-target-required',
      checkedAt: '2026-08-09T12:00:00.000Z',
    });
    expect(listCalendars).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('does not let prototype impostors produce credentialed-live evidence', async () => {
    const target = createGoogleCalendarCredentialedLiveSmokeTarget({
      readClient: Object.create(GoogleCalendarReadClient.prototype),
      freeBusyClient: Object.create(GoogleCalendarFreeBusyClient.prototype),
    });

    const result = await runGoogleCalendarReadOnlySmoke({
      enabled: true,
      actor,
      target,
      clock,
    });

    expect(result).toEqual({
      schemaVersion: 1,
      provider: 'google-calendar',
      operation: 'calendar-list-free-busy',
      status: 'unavailable',
      evidenceClass: 'not-live',
      releaseEligible: false,
      safeCode: 'google-calendar-live-target-required',
      checkedAt: '2026-08-09T12:00:00.000Z',
    });
  });

  it('returns release-eligible evidence only through exact production clients', async () => {
    const clients = productionClients();
    const target = createGoogleCalendarCredentialedLiveSmokeTarget({
      readClient: clients.readClient,
      freeBusyClient: clients.freeBusyClient,
    });

    const result = await runGoogleCalendarReadOnlySmoke({
      enabled: true,
      actor,
      target,
      clock,
    });

    expect(result).toEqual({
      schemaVersion: 1,
      provider: 'google-calendar',
      operation: 'calendar-list-free-busy',
      status: 'ready',
      evidenceClass: 'credentialed-live',
      releaseEligible: true,
      calendarCount: 1,
      freeBusy: 'available',
      checkedAt: '2026-08-09T12:00:00.000Z',
    });
    expect(clients.fetch).toHaveBeenCalledTimes(2);
    expect(
      clients.broker.acquireAccessTokenForCapability,
    ).toHaveBeenCalledTimes(2);
    expect(clients.calls[1]?.init?.body).toBe(
      JSON.stringify({
        timeMin: '2026-08-09T12:00:00.000Z',
        timeMax: '2026-08-09T12:05:00.000Z',
        timeZone: 'America/Toronto',
        items: [{ id: 'primary' }],
      }),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /Sensitive|access-token|grant-reference/,
    );
  });

  it('samples the live evidence clock exactly once', async () => {
    const clients = productionClients();
    const target = createGoogleCalendarCredentialedLiveSmokeTarget({
      readClient: clients.readClient,
      freeBusyClient: clients.freeBusyClient,
    });
    let clockCalls = 0;

    const result = await runGoogleCalendarReadOnlySmoke({
      enabled: true,
      actor,
      target,
      clock: () => {
        clockCalls += 1;
        return new Date('2026-08-09T12:00:00.000Z');
      },
    });

    expect(result).toMatchObject({
      status: 'ready',
      checkedAt: '2026-08-09T12:00:00.000Z',
    });
    expect(clockCalls).toBe(1);
  });

  it('maps credentialed provider failures to safe ineligible live evidence', async () => {
    const clients = productionClients();
    clients.fetch.mockImplementationOnce(async () => {
      throw new Error('access-token=secret provider body');
    });
    const target = createGoogleCalendarCredentialedLiveSmokeTarget({
      readClient: clients.readClient,
      freeBusyClient: clients.freeBusyClient,
    });

    const result = await runGoogleCalendarReadOnlySmoke({
      enabled: true,
      actor,
      target,
      clock,
    });

    expect(result).toEqual({
      schemaVersion: 1,
      provider: 'google-calendar',
      operation: 'calendar-list-free-busy',
      status: 'unavailable',
      evidenceClass: 'credentialed-live',
      releaseEligible: false,
      safeCode: 'google-calendar-smoke-failed',
      checkedAt: '2026-08-09T12:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('rejects accessor-bearing targets and factory inputs without invoking getters', async () => {
    let getterCalls = 0;
    const hostileTarget = Object.defineProperty({}, 'readClient', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('must not execute');
      },
    });
    const hostileFactoryInput = Object.defineProperty({}, 'readClient', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('must not execute');
      },
    });

    const result = await runGoogleCalendarReadOnlySmoke({
      enabled: true,
      actor,
      target: hostileTarget as never,
      clock,
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      evidenceClass: 'not-live',
      releaseEligible: false,
      safeCode: 'google-calendar-live-target-required',
    });
    expect(() =>
      createGoogleCalendarCredentialedLiveSmokeTarget(
        hostileFactoryInput as never,
      ),
    ).toThrow('invalid-google-calendar-live-smoke-clients');
    expect(getterCalls).toBe(0);
  });
});

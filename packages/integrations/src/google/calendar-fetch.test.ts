import { createHash } from 'node:crypto';

import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  CalendarWriteExecutor,
  InMemoryCalendarWriteReceiptStore,
  hashGoogleCalendarPayload,
  type ApprovedCalendarWriteContext,
  type GoogleCalendarWriteCommand,
} from './calendar-write.js';
import {
  GOOGLE_CALENDAR_API_ENDPOINTS,
  FetchGoogleCalendarConditionalGateway,
  GoogleCalendarFreeBusyClient,
  GoogleCalendarFetchError,
  GoogleCalendarProposalTargetReader,
  GoogleCalendarReadClient,
  deriveGoogleCalendarEventId,
  type GoogleCalendarCredentialBroker,
} from './calendar-fetch.js';
import type { GoogleCalendarOAuthActor } from './oauth/service.js';

const actor: GoogleCalendarOAuthActor = {
  userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f005',
  householdId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f007',
  privateSpaceId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f008',
  sessionId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f009',
};
const requestId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f010';
const spaceAccessGrantId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f011';
const authorizationScopeFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse('5'.repeat(64));

const approvalClock = () => new Date('2026-08-09T12:05:00.000Z');

const accessTokenLease = {
  accessToken: 'server-side-access-token',
  grantReference: 'grant-reference-1234',
  authorizationEpoch: 0,
  expiresAt: '2026-08-09T14:00:00.000Z',
};
const proposalAuthorityResolution = {
  authorityBinding: {
    kind: 'google-calendar-grant-v2' as const,
    householdId: actor.householdId,
    privateSpaceId: actor.privateSpaceId,
    authorizationScopeFingerprint,
    providerGrantReference: accessTokenLease.grantReference,
    authorizationEpoch: accessTokenLease.authorizationEpoch,
  },
  operationScope: {
    requestId,
    sessionId: actor.sessionId,
    householdId: actor.householdId,
    userId: actor.userId,
    spaceAccessGrantId,
    authorizationScopeFingerprint,
  },
} as const;

const broker = (): GoogleCalendarCredentialBroker & {
  calls: Array<{ actor: GoogleCalendarOAuthActor; capability: string }>;
} => {
  const calls: Array<{
    actor: GoogleCalendarOAuthActor;
    capability: string;
  }> = [];
  return {
    calls,
    async acquireAccessTokenForCapability(input) {
      calls.push(input);
      return accessTokenLease;
    },
  };
};

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
};

const hashJson = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

const targetId = (calendarId: string, eventId: string): string =>
  `${calendarId.length}:${calendarId}${eventId.length}:${eventId}`;

const approvedContext = (
  command: GoogleCalendarWriteCommand,
): ApprovedCalendarWriteContext => {
  const common = {
    operation: command.operation,
    calendarId: command.calendarId,
    expectedCalendarVersion: command.expectedCalendarVersion,
  };
  const approvedCanonicalArguments =
    command.operation === 'create'
      ? { ...common, operation: 'create' as const, event: command.payload }
      : command.operation === 'update'
        ? {
            ...common,
            operation: 'update' as const,
            eventId: command.eventId,
            expectedEventVersion: command.expectedEventVersion,
            replacement: command.payload,
          }
        : {
            ...common,
            operation: 'delete' as const,
            eventId: command.eventId,
            expectedEventVersion: command.expectedEventVersion,
          };
  const approvalBinding = {
    decisionId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004',
    userId: actor.userId,
    agentId: 'scheduler' as const,
    runId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f006',
    capabilityId: `google-calendar.event.${command.operation}` as const,
    capabilityFingerprint: '3'.repeat(64),
    disclosureGrantId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002',
    payloadHash: hashJson(approvedCanonicalArguments),
    idempotencyTtlMs: 86_400_000,
    authorityBinding: {
      kind: 'google-calendar-grant-v2' as const,
      householdId: actor.householdId,
      privateSpaceId: actor.privateSpaceId,
      authorizationScopeFingerprint,
      providerGrantReference: accessTokenLease.grantReference,
      authorizationEpoch: accessTokenLease.authorizationEpoch,
    },
  };
  return {
    approvedCanonicalArguments,
    approvalBinding,
    providerWriteOperationScope: {
      requestId,
      sessionId: actor.sessionId,
      householdId: actor.householdId,
      userId: actor.userId,
      spaceAccessGrantId,
      authorizationScopeFingerprint,
    },
    providerWritePermit: {
      proposalId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
      approvalHash: '1'.repeat(64),
      approvalBindingHash: hashJson({
        domain: 'emdo.provider-write-approval-binding.v1',
        binding: approvalBinding,
      }),
      capabilityFingerprint: '3'.repeat(64),
      proposalCreatedAt: '2026-08-09T12:00:00.000Z',
      expiresAt: '2026-08-09T12:10:00.000Z',
      disclosureGrantId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002',
      disclosureGrantHash: '4'.repeat(64),
      approvalBinding,
      providerIdempotencyKey: command.idempotencyKey,
      idempotencyExpiresAt: '2026-08-10T12:01:00.000Z',
      attemptId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003',
      attemptVersion: 1,
      issuedAt: '2026-08-09T12:01:00.000Z',
      targets: [
        {
          kind: 'google-calendar.event',
          id: targetId(command.calendarId, command.eventId),
          expectedVersion: command.expectedEventVersion,
        },
      ],
      providerPreconditions: [
        {
          kind: 'calendar-version',
          targetId: command.calendarId,
          expectedValue: command.expectedCalendarVersion,
        },
        {
          kind:
            command.operation === 'create' ? 'event-absence' : 'event-version',
          targetId: targetId(command.calendarId, command.eventId),
          expectedValue: command.expectedEventVersion,
        },
      ],
    },
  };
};

describe('GoogleCalendarReadClient', () => {
  it('constructs a proposal target reader with zero provider I/O and reads only the canonical Calendar target', async () => {
    const credentialBroker = broker();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ etag: 'calendar-v7' }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const reader = new GoogleCalendarProposalTargetReader({
      actor,
      request: {
        requestId,
        spaceAccessGrantId,
        authorizationScopeFingerprint,
      },
      authorityResolution: proposalAuthorityResolution,
      fetch,
      broker: credentialBroker,
      clock: approvalClock,
    });

    expect(credentialBroker.calls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      reader.readTargetState({
        calendarId: 'primary',
        eventId: 'emdo1234567890abcdef',
      }),
    ).resolves.toEqual({
      calendarId: 'primary',
      queriedEventId: 'emdo1234567890abcdef',
      calendarVersion: 'calendar-v7',
      event: null,
    });
    expect(credentialBroker.calls).toEqual([
      { actor, capability: 'calendar-event-write' },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1&showDeleted=true&fields=etag',
    );
    expect(fetch.mock.calls[1]?.[0]).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/emdo1234567890abcdef?fields=id%2Cetag%2Cstatus%2Csummary%2Cdescription%2Clocation%2Cstart%2Cend%2Cattendees%28email%29%2Crecurrence%2CextendedProperties%28private%29',
    );
  });

  it('fails closed before credential or provider I/O when proposal authority is not bound to the current request', () => {
    const credentialBroker = broker();
    const fetch = vi.fn();
    expect(
      () =>
        new GoogleCalendarProposalTargetReader({
          actor,
          request: {
            requestId,
            spaceAccessGrantId,
            authorizationScopeFingerprint,
          },
          authorityResolution: {
            ...proposalAuthorityResolution,
            operationScope: {
              ...proposalAuthorityResolution.operationScope,
              sessionId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f099',
            },
          },
          fetch,
          broker: credentialBroker,
          clock: approvalClock,
        }),
    ).toThrow('invalid-google-calendar-proposal-target-reader');
    expect(credentialBroker.calls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a rotated Calendar grant after lease acquisition and before target reads', async () => {
    const credentialBroker: GoogleCalendarCredentialBroker = {
      acquireAccessTokenForCapability: async () => ({
        ...accessTokenLease,
        grantReference: 'grant-reference-rotated',
      }),
    };
    const fetch = vi.fn();
    const reader = new GoogleCalendarProposalTargetReader({
      actor,
      request: {
        requestId,
        spaceAccessGrantId,
        authorizationScopeFingerprint,
      },
      authorityResolution: proposalAuthorityResolution,
      fetch,
      broker: credentialBroker,
      clock: approvalClock,
    });

    await expect(
      reader.readTargetState({
        calendarId: 'primary',
        eventId: 'emdo1234567890abcdef',
      }),
    ).rejects.toMatchObject({
      kind: 'credential-unavailable',
      dispatched: false,
    } satisfies Partial<GoogleCalendarFetchError>);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('paginates the exact CalendarList endpoint with read-only broker authority', async () => {
    const credentialBroker = broker();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          nextPageToken: 'next-page',
          items: [
            {
              id: 'primary',
              summary: 'Personal',
              accessRole: 'owner',
              primary: true,
              timeZone: 'America/Toronto',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: 'family@example.com',
              summary: 'Family',
              accessRole: 'writerWithoutPrivateAccess',
              timeZone: 'America/Toronto',
            },
          ],
        }),
      );
    const client = new GoogleCalendarReadClient({
      fetch,
      broker: credentialBroker,
      clock: () => new Date('2026-08-09T12:00:00.000Z'),
    });

    const result = await client.listCalendars({ actor });

    expect(result).toEqual({
      calendars: [
        {
          id: 'primary',
          summary: 'Personal',
          accessRole: 'owner',
          primary: true,
          timeZone: 'America/Toronto',
        },
        {
          id: 'family@example.com',
          summary: 'Family',
          accessRole: 'writerWithoutPrivateAccess',
          timeZone: 'America/Toronto',
        },
      ],
      fetchedAt: '2026-08-09T12:00:00.000Z',
      grantReference: accessTokenLease.grantReference,
    });
    expect(credentialBroker.calls).toEqual([
      { actor, capability: 'calendar-read' },
    ]);
    const [firstUrl] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    const first = new URL(firstUrl);
    expect(`${first.origin}${first.pathname}`).toBe(
      GOOGLE_CALENDAR_API_ENDPOINTS.calendarList,
    );
    expect(first.searchParams.get('maxResults')).toBe('250');
    expect(first.searchParams.get('minAccessRole')).toBe('freeBusyReader');
    expect(first.searchParams.get('showDeleted')).toBe('false');
    const [secondUrl] = fetch.mock.calls[1]! as unknown as [
      string,
      RequestInit,
    ];
    const second = new URL(secondUrl);
    expect(second.searchParams.get('pageToken')).toBe('next-page');
    for (const call of fetch.mock.calls) {
      expect(call[1]?.headers).toMatchObject({
        authorization: `Bearer ${accessTokenLease.accessToken}`,
      });
      expect(call[1]).toMatchObject({ cache: 'no-store', redirect: 'error' });
    }
  });

  it('lists bounded event evidence with exact time and calendar filters', async () => {
    const credentialBroker = broker();
    const fetch = vi.fn(async () =>
      jsonResponse({
        etag: '"calendar-v1"',
        items: [
          {
            id: 'event1',
            etag: '"event-v1"',
            status: 'confirmed',
            summary: 'Dentist',
            start: {
              dateTime: '2026-08-10T09:00:00-04:00',
              timeZone: 'America/Toronto',
            },
            end: {
              dateTime: '2026-08-10T10:00:00-04:00',
              timeZone: 'America/Toronto',
            },
            attendees: [{ email: 'member@example.com' }],
          },
        ],
      }),
    );
    const client = new GoogleCalendarReadClient({
      fetch,
      broker: credentialBroker,
      clock: () => new Date('2026-08-09T12:00:00.000Z'),
    });

    const result = await client.listEvents({
      actor,
      calendarId: 'family@example.com',
      timeMin: '2026-08-09T00:00:00-04:00',
      timeMax: '2026-08-16T00:00:00-04:00',
    });

    expect(result.events).toEqual([
      expect.objectContaining({
        id: 'event1',
        eventVersion: '"event-v1"',
        summary: 'Dentist',
        attendees: ['member@example.com'],
      }),
    ]);
    expect(result.calendarVersion).toBe('"calendar-v1"');
    const [requestUrl] = fetch.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    const url = new URL(requestUrl);
    expect(url.pathname).toBe(
      '/calendar/v3/calendars/family%40example.com/events',
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      timeMin: '2026-08-09T00:00:00-04:00',
      timeMax: '2026-08-16T00:00:00-04:00',
      timeZone: 'America/Toronto',
      singleEvents: 'true',
      orderBy: 'startTime',
      showDeleted: 'false',
    });
  });

  it('reacquires a same-grant token before the next page enters its expiry skew', async () => {
    let now = new Date('2026-08-09T12:00:00.000Z');
    let leaseCall = 0;
    const credentialBroker: GoogleCalendarCredentialBroker = {
      async acquireAccessTokenForCapability() {
        leaseCall += 1;
        return {
          ...accessTokenLease,
          accessToken:
            leaseCall === 1
              ? 'first-short-lived-token'
              : 'refreshed-same-grant-token',
          expiresAt:
            leaseCall === 1
              ? '2026-08-09T12:02:00.000Z'
              : '2026-08-09T14:00:00.000Z',
        };
      },
    };
    let fetchCall = 0;
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      void input;
      void init;
      fetchCall += 1;
      if (fetchCall === 1) {
        now = new Date('2026-08-09T12:01:30.000Z');
        return jsonResponse({ nextPageToken: 'next-page', items: [] });
      }
      return jsonResponse({ items: [] });
    });
    const client = new GoogleCalendarReadClient({
      fetch,
      broker: credentialBroker,
      clock: () => new Date(now.getTime()),
    });

    await expect(client.listCalendars({ actor })).resolves.toMatchObject({
      calendars: [],
      grantReference: accessTokenLease.grantReference,
    });
    expect(leaseCall).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer first-short-lived-token',
    });
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer refreshed-same-grant-token',
    });
  });

  it('stops pagination when token reacquisition resolves to a reconnected grant', async () => {
    let now = new Date('2026-08-09T12:00:00.000Z');
    let leaseCall = 0;
    const credentialBroker: GoogleCalendarCredentialBroker = {
      async acquireAccessTokenForCapability() {
        leaseCall += 1;
        return {
          ...accessTokenLease,
          grantReference:
            leaseCall === 1
              ? accessTokenLease.grantReference
              : 'new-reconnected-grant-reference',
          expiresAt:
            leaseCall === 1
              ? '2026-08-09T12:02:00.000Z'
              : '2026-08-09T14:00:00.000Z',
        };
      },
    };
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      void input;
      void init;
      now = new Date('2026-08-09T12:01:30.000Z');
      return jsonResponse({ nextPageToken: 'next-page', items: [] });
    });
    const client = new GoogleCalendarReadClient({
      fetch,
      broker: credentialBroker,
      clock: () => new Date(now.getTime()),
    });

    await expect(client.listCalendars({ actor })).rejects.toMatchObject({
      kind: 'credential-unavailable',
      dispatched: false,
    });
    expect(leaseCall).toBe(2);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects accessor-backed actor input before credential brokerage', async () => {
    const credentialBroker = broker();
    const client = new GoogleCalendarReadClient({
      fetch: vi.fn(),
      broker: credentialBroker,
    });
    const hostileActor = Object.defineProperty({}, 'userId', {
      enumerable: true,
      get: () => actor.userId,
    });

    await expect(
      client.listCalendars({ actor: hostileActor }),
    ).rejects.toThrow();
    expect(credentialBroker.calls).toEqual([]);
  });
});

describe('GoogleCalendarFreeBusyClient', () => {
  it('posts only the approved calendars and normalizes busy intervals', async () => {
    const credentialBroker = broker();
    const fetch = vi.fn(async () =>
      jsonResponse({
        calendars: {
          primary: {
            busy: [
              {
                start: '2026-08-10T13:00:00Z',
                end: '2026-08-10T14:00:00Z',
              },
            ],
          },
          'family@example.com': {
            errors: [{ domain: 'calendar', reason: 'notFound' }],
            busy: [],
          },
        },
      }),
    );
    const client = new GoogleCalendarFreeBusyClient({
      fetch,
      broker: credentialBroker,
      clock: () => new Date('2026-08-09T12:00:00.000Z'),
    });

    const result = await client.query({
      actor,
      calendarIds: ['primary', 'family@example.com'],
      timeMin: '2026-08-10T08:00:00-04:00',
      timeMax: '2026-08-11T08:00:00-04:00',
      timeZone: 'America/Toronto',
    });

    expect(result.calendars).toEqual([
      {
        calendarId: 'primary',
        status: 'available',
        busy: [
          {
            start: '2026-08-10T13:00:00Z',
            end: '2026-08-10T14:00:00Z',
          },
        ],
      },
      {
        calendarId: 'family@example.com',
        status: 'unavailable',
        busy: [],
      },
    ]);
    expect(credentialBroker.calls[0]?.capability).toBe('calendar-read');
    const [url, init] = fetch.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(GOOGLE_CALENDAR_API_ENDPOINTS.freeBusy);
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessTokenLease.accessToken}`,
        'content-type': 'application/json',
      },
    });
    expect(JSON.parse(init.body as string)).toEqual({
      timeMin: '2026-08-10T08:00:00-04:00',
      timeMax: '2026-08-11T08:00:00-04:00',
      timeZone: 'America/Toronto',
      items: [{ id: 'primary' }, { id: 'family@example.com' }],
    });
  });
});

describe('FetchGoogleCalendarConditionalGateway', () => {
  const idempotencyKey = 'a'.repeat(64);
  const eventId = deriveGoogleCalendarEventId(idempotencyKey);
  const payload = {
    eventId,
    summary: 'Dentist',
    start: '2026-08-10T09:00:00-04:00',
    end: '2026-08-10T10:00:00-04:00',
    timeZone: 'America/Toronto' as const,
    attendees: ['member@example.com'],
  };
  const command: GoogleCalendarWriteCommand = {
    schemaVersion: 1,
    operation: 'create',
    calendarId: 'primary',
    eventId,
    expectedCalendarVersion: '"calendar-v1"',
    expectedEventVersion: 'absent',
    payload,
    payloadHash: hashGoogleCalendarPayload(payload),
    idempotencyKey,
  };

  it('derives stable Google-compatible event IDs from approved idempotency keys', () => {
    expect(deriveGoogleCalendarEventId(idempotencyKey)).toBe(eventId);
    expect(eventId).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(deriveGoogleCalendarEventId('b'.repeat(64))).not.toBe(eventId);
    expect(() => deriveGoogleCalendarEventId('not-a-key')).toThrow(
      'invalid-google-calendar-idempotency-key',
    );
  });

  it('accepts a rotated operation grant when the trusted scope fingerprint is unchanged', async () => {
    const credentialBroker = broker();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ etag: '"calendar-v1"' }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 404 }));
    const authorization = approvedContext(command);
    const rotatedAuthorization: ApprovedCalendarWriteContext = {
      ...authorization,
      providerWriteOperationScope: {
        ...authorization.providerWriteOperationScope,
        requestId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f090',
        spaceAccessGrantId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f091',
      },
    };
    const gateway = new FetchGoogleCalendarConditionalGateway({
      actor,
      authorizationScopeFingerprint,
      clock: approvalClock,
      broker: credentialBroker,
      fetch,
    });

    await expect(
      gateway.readCurrent(command, rotatedAuthorization),
    ).resolves.toMatchObject({
      calendarId: command.calendarId,
      calendarVersion: '"calendar-v1"',
      event: null,
    });
    expect(credentialBroker.calls).toHaveLength(1);
  });

  it('rejects a trusted scope fingerprint mismatch before credential brokerage', async () => {
    const credentialBroker = broker();
    const gateway = new FetchGoogleCalendarConditionalGateway({
      actor,
      authorizationScopeFingerprint:
        EffectiveAuthorizationScopeFingerprintSchema.parse('6'.repeat(64)),
      clock: approvalClock,
      broker: credentialBroker,
      fetch: vi.fn(),
    });

    await expect(
      gateway.readCurrent(command, approvedContext(command)),
    ).rejects.toThrow('google-calendar-write-authorization-invalid');
    expect(credentialBroker.calls).toEqual([]);
  });

  it('creates with a deterministic ID, exact body, and verified readback', async () => {
    const credentialBroker = broker();
    const providerEvent = {
      id: eventId,
      etag: '"event-v1"',
      status: 'confirmed',
      summary: payload.summary,
      start: { dateTime: payload.start, timeZone: payload.timeZone },
      end: { dateTime: payload.end, timeZone: payload.timeZone },
      attendees: [{ email: 'member@example.com' }],
      extendedProperties: {
        private: {
          emdoPayloadHash: command.payloadHash,
          emdoIdempotencyKey: command.idempotencyKey,
        },
      },
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ etag: '"calendar-v1"' }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ etag: '"calendar-v1"' }))
      .mockResolvedValueOnce(jsonResponse(providerEvent, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ etag: '"calendar-v2"' }))
      .mockResolvedValueOnce(jsonResponse(providerEvent));
    const gateway = new FetchGoogleCalendarConditionalGateway({
      actor,
      authorizationScopeFingerprint,
      clock: approvalClock,
      broker: credentialBroker,
      fetch,
    });
    const executor = new CalendarWriteExecutor(
      gateway,
      new InMemoryCalendarWriteReceiptStore(),
    );

    await expect(
      executor.execute(command, approvedContext(command)),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'applied',
        readbackCalendarVersion: '"calendar-v2"',
        readback: expect.objectContaining({
          eventId,
          eventVersion: '"event-v1"',
        }),
      }),
    );
    expect(credentialBroker.calls.map((call) => call.capability)).toEqual([
      'calendar-event-write',
      'calendar-event-write',
      'calendar-event-write',
      'calendar-event-write',
    ]);
    const [createUrl, createInit] = fetch.mock.calls[3]! as unknown as [
      string,
      RequestInit,
    ];
    expect(new URL(createUrl).pathname).toBe(
      '/calendar/v3/calendars/primary/events',
    );
    expect(new URL(createUrl).searchParams.get('sendUpdates')).toBe('none');
    expect(createInit.method).toBe('POST');
    const body = JSON.parse(createInit.body as string);
    expect(body).toEqual({
      id: eventId,
      summary: payload.summary,
      start: { dateTime: payload.start, timeZone: payload.timeZone },
      end: { dateTime: payload.end, timeZone: payload.timeZone },
      attendees: [{ email: 'member@example.com' }],
      extendedProperties: {
        private: {
          emdoPayloadHash: command.payloadHash,
          emdoIdempotencyKey: command.idempotencyKey,
        },
      },
    });
  });

  it('reconciles a deterministic create collision only through exact EMDO readback', async () => {
    const providerEvent = {
      id: eventId,
      etag: '"event-v1"',
      status: 'confirmed',
      summary: payload.summary,
      start: { dateTime: payload.start, timeZone: payload.timeZone },
      end: { dateTime: payload.end, timeZone: payload.timeZone },
      attendees: [{ email: 'member@example.com' }],
      extendedProperties: {
        private: {
          emdoPayloadHash: command.payloadHash,
          emdoIdempotencyKey: command.idempotencyKey,
        },
      },
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ etag: '"calendar-v1"' }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ etag: '"calendar-v1"' }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 409 }))
      .mockResolvedValueOnce(jsonResponse({ etag: '"calendar-v2"' }))
      .mockResolvedValueOnce(jsonResponse(providerEvent));
    const executor = new CalendarWriteExecutor(
      new FetchGoogleCalendarConditionalGateway({
        actor,
        authorizationScopeFingerprint,
        clock: approvalClock,
        broker: broker(),
        fetch,
      }),
      new InMemoryCalendarWriteReceiptStore(),
    );

    await expect(
      executor.execute(command, approvedContext(command)),
    ).resolves.toMatchObject({
      status: 'applied',
      readback: { eventId, eventVersion: '"event-v1"' },
    });
  });

  it('rejects a matching provider payload whose EMDO idempotency binding is absent', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ etag: '"calendar-v2"' }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: eventId,
          etag: '"event-v1"',
          status: 'confirmed',
          summary: payload.summary,
          start: { dateTime: payload.start, timeZone: payload.timeZone },
          end: { dateTime: payload.end, timeZone: payload.timeZone },
          attendees: [{ email: 'member@example.com' }],
        }),
      );
    const gateway = new FetchGoogleCalendarConditionalGateway({
      actor,
      authorizationScopeFingerprint,
      clock: approvalClock,
      broker: broker(),
      fetch,
    });

    await expect(
      gateway.readBack(command, approvedContext(command)),
    ).rejects.toMatchObject({ kind: 'response-invalid' });
  });

  it.each([
    ['update', 'PATCH'],
    ['delete', 'DELETE'],
  ] as const)(
    'uses If-Match for a conditional %s',
    async (operation, method) => {
      const conditionalCommand: GoogleCalendarWriteCommand =
        operation === 'update'
          ? {
              ...command,
              operation,
              expectedEventVersion: '"event-v1"',
            }
          : {
              ...command,
              operation,
              expectedEventVersion: '"event-v1"',
              payload: null,
              payloadHash: hashGoogleCalendarPayload(null),
            };
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'GET') {
          return jsonResponse({ etag: '"calendar-v1"' });
        }
        return operation === 'delete'
          ? new Response(null, { status: 204 })
          : jsonResponse({ id: eventId, etag: '"event-v2"' });
      });
      const gateway = new FetchGoogleCalendarConditionalGateway({
        actor,
        authorizationScopeFingerprint,
        clock: approvalClock,
        broker: broker(),
        fetch,
      });

      await expect(
        gateway.applyConditionalExactlyOnce(
          conditionalCommand,
          approvedContext(conditionalCommand),
        ),
      ).resolves.toMatchObject({ status: 'applied' });
      expect(fetch).toHaveBeenCalledTimes(2);
      const [, init] = fetch.mock.calls[1]! as unknown as [string, RequestInit];
      expect(init).toMatchObject({
        method,
        headers: expect.objectContaining({ 'if-match': '"event-v1"' }),
      });
    },
  );

  it('maps a native 412 precondition failure to not-applied', async () => {
    const updateCommand: GoogleCalendarWriteCommand = {
      ...command,
      operation: 'update',
      expectedEventVersion: '"event-v1"',
    };
    const response = new Response('stale provider body', { status: 412 });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const gateway = new FetchGoogleCalendarConditionalGateway({
      actor,
      authorizationScopeFingerprint,
      clock: approvalClock,
      broker: broker(),
      fetch: vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ etag: '"calendar-v1"' }))
        .mockResolvedValueOnce(response),
    });

    await expect(
      gateway.applyConditionalExactlyOnce(
        updateCommand,
        approvedContext(updateCommand),
      ),
    ).resolves.toEqual({
      status: 'not-applied',
      reason: 'conditional-rejected',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('revalidates the calendar version immediately before mutation dispatch', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ etag: '"calendar-changed"' }),
    );
    const gateway = new FetchGoogleCalendarConditionalGateway({
      actor,
      authorizationScopeFingerprint,
      clock: approvalClock,
      broker: broker(),
      fetch,
    });

    await expect(
      gateway.applyConditionalExactlyOnce(command, approvedContext(command)),
    ).resolves.toEqual({
      status: 'not-applied',
      reason: 'conditional-rejected',
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(init.method).toBe('GET');
  });

  it('revalidates the provider grant at mutation dispatch even while the cached token is fresh', async () => {
    let leaseCall = 0;
    const credentialBroker: GoogleCalendarCredentialBroker = {
      async acquireAccessTokenForCapability() {
        leaseCall += 1;
        return leaseCall === 1
          ? accessTokenLease
          : {
              ...accessTokenLease,
              grantReference: 'different-reconnected-grant-reference',
              authorizationEpoch: accessTokenLease.authorizationEpoch + 1,
            };
      },
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ etag: '"calendar-v1"' }));
    const gateway = new FetchGoogleCalendarConditionalGateway({
      actor,
      authorizationScopeFingerprint,
      clock: approvalClock,
      broker: credentialBroker,
      fetch,
    });

    await expect(
      gateway.applyConditionalExactlyOnce(command, approvedContext(command)),
    ).resolves.toEqual({
      status: 'not-applied',
      reason: 'conditional-rejected',
    });
    expect(leaseCall).toBe(2);
    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(init.method).toBe('GET');
  });

  it('updates with a field-scoped conditional PATCH and explicit approved clears', async () => {
    const replacement = {
      eventId: payload.eventId,
      summary: payload.summary,
      start: payload.start,
      end: payload.end,
      timeZone: payload.timeZone,
    };
    const updateCommand: GoogleCalendarWriteCommand = {
      ...command,
      operation: 'update',
      expectedEventVersion: '"event-v1"',
      payload: replacement,
      payloadHash: hashGoogleCalendarPayload(replacement),
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ etag: '"calendar-v1"' }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: eventId,
          etag: '"event-v2"',
          reminders: { useDefault: false, overrides: [{ method: 'popup' }] },
          conferenceData: { conferenceId: 'provider-owned-meeting' },
          attachments: [{ fileUrl: 'https://example.invalid/provider-file' }],
        }),
      );
    const gateway = new FetchGoogleCalendarConditionalGateway({
      actor,
      authorizationScopeFingerprint,
      clock: approvalClock,
      broker: broker(),
      fetch,
    });

    await expect(
      gateway.applyConditionalExactlyOnce(
        updateCommand,
        approvedContext(updateCommand),
      ),
    ).resolves.toMatchObject({ status: 'applied' });
    const [, mutation] = fetch.mock.calls[1]! as unknown as [
      string,
      RequestInit,
    ];
    expect(mutation.method).toBe('PATCH');
    expect(mutation.headers).toMatchObject({ 'if-match': '"event-v1"' });
    expect(JSON.parse(mutation.body as string)).toEqual({
      summary: payload.summary,
      start: { dateTime: payload.start, timeZone: payload.timeZone },
      end: { dateTime: payload.end, timeZone: payload.timeZone },
      location: null,
      description: null,
      attendees: [],
      recurrence: [],
    });
    expect(mutation.body).not.toContain('reminders');
    expect(mutation.body).not.toContain('conferenceData');
    expect(mutation.body).not.toContain('attachments');
    expect(mutation.body).not.toContain('extendedProperties');
  });

  it('conditionally deletes an opaque all-day provider event without parsing its payload', async () => {
    const opaqueEventId = `provider_event_${'x'.repeat(280)}_20260810T130000Z`;
    const deleteCommand: GoogleCalendarWriteCommand = {
      ...command,
      operation: 'delete',
      eventId: opaqueEventId,
      expectedEventVersion: '"event-v1"',
      payload: null,
      payloadHash: hashGoogleCalendarPayload(null),
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ etag: '"calendar-v1"' }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: opaqueEventId,
          etag: '"event-v1"',
          status: 'confirmed',
          start: { date: '2026-08-10' },
          end: { date: '2026-08-11' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ etag: '"calendar-v1"' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ etag: '"calendar-v2"' }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 404 }));
    const executor = new CalendarWriteExecutor(
      new FetchGoogleCalendarConditionalGateway({
        actor,
        authorizationScopeFingerprint,
        clock: approvalClock,
        broker: broker(),
        fetch,
      }),
      new InMemoryCalendarWriteReceiptStore(),
    );

    await expect(
      executor.execute(deleteCommand, approvedContext(deleteCommand)),
    ).resolves.toMatchObject({ status: 'applied', readback: null });
    const [deleteUrl, deleteInit] = fetch.mock.calls[3]! as unknown as [
      string,
      RequestInit,
    ];
    expect(decodeURIComponent(new URL(deleteUrl).pathname)).toContain(
      opaqueEventId,
    );
    expect(deleteInit).toMatchObject({
      method: 'DELETE',
      headers: expect.objectContaining({ 'if-match': '"event-v1"' }),
    });
  });

  it('returns indeterminate after a dispatched timeout and disposes a late body', async () => {
    let resolveFetch!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const gateway = new FetchGoogleCalendarConditionalGateway({
      actor,
      authorizationScopeFingerprint,
      clock: approvalClock,
      broker: broker(),
      timeoutMs: 5,
      fetch: vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ etag: '"calendar-v1"' }))
        .mockImplementationOnce(async () => pending),
    });

    await expect(
      gateway.applyConditionalExactlyOnce(command, approvedContext(command)),
    ).resolves.toMatchObject({ status: 'indeterminate' });
    const late = new Response('late-provider-body');
    const cancel = vi.spyOn(late.body!, 'cancel');
    resolveFetch(late);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not broker or dispatch when the visual approval has expired', async () => {
    const credentialBroker = broker();
    const fetch = vi.fn();
    const gateway = new FetchGoogleCalendarConditionalGateway({
      actor,
      authorizationScopeFingerprint,
      broker: credentialBroker,
      fetch,
      clock: () => new Date('2026-08-09T12:10:00.000Z'),
    });

    await expect(
      gateway.applyConditionalExactlyOnce(command, approvedContext(command)),
    ).resolves.toEqual({
      status: 'not-applied',
      reason: 'conditional-rejected',
    });
    expect(credentialBroker.calls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rechecks approval expiry after token brokerage at the exact write boundary', async () => {
    const credentialBroker = broker();
    const fetch = vi.fn();
    let clockCall = 0;
    const gateway = new FetchGoogleCalendarConditionalGateway({
      actor,
      authorizationScopeFingerprint,
      broker: credentialBroker,
      fetch,
      clock: () => {
        clockCall += 1;
        return new Date(
          clockCall === 1
            ? '2026-08-09T12:09:59.999Z'
            : '2026-08-09T12:10:00.000Z',
        );
      },
    });

    await expect(
      gateway.applyConditionalExactlyOnce(command, approvedContext(command)),
    ).resolves.toEqual({
      status: 'not-applied',
      reason: 'conditional-rejected',
    });
    expect(credentialBroker.calls).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rechecks approval expiry after the version read at the mutation dispatch boundary', async () => {
    const credentialBroker = broker();
    let clockCall = 0;
    const fetch = vi.fn(async () => jsonResponse({ etag: '"calendar-v1"' }));
    const gateway = new FetchGoogleCalendarConditionalGateway({
      actor,
      authorizationScopeFingerprint,
      broker: credentialBroker,
      fetch,
      clock: () => {
        clockCall += 1;
        return new Date(
          clockCall < 5
            ? '2026-08-09T12:09:59.999Z'
            : '2026-08-09T12:10:00.000Z',
        );
      },
    });

    await expect(
      gateway.applyConditionalExactlyOnce(command, approvedContext(command)),
    ).resolves.toEqual({
      status: 'not-applied',
      reason: 'conditional-rejected',
    });
    expect(credentialBroker.calls).toHaveLength(2);
    expect(fetch).toHaveBeenCalledOnce();
    const [, preflightInit] = fetch.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(preflightInit.method).toBe('GET');
  });

  it('allows post-dispatch readback after approval expiry to resolve the outcome', async () => {
    let now = new Date('2026-08-09T12:05:00.000Z');
    const providerEvent = {
      id: eventId,
      etag: '"event-v1"',
      status: 'confirmed',
      summary: payload.summary,
      start: { dateTime: payload.start, timeZone: payload.timeZone },
      end: { dateTime: payload.end, timeZone: payload.timeZone },
      attendees: [{ email: 'member@example.com' }],
      extendedProperties: {
        private: {
          emdoPayloadHash: command.payloadHash,
          emdoIdempotencyKey: command.idempotencyKey,
        },
      },
    };
    const responses = [
      () => jsonResponse({ etag: '"calendar-v1"' }),
      () => jsonResponse({}, { status: 404 }),
      () => jsonResponse({ etag: '"calendar-v1"' }),
      () => {
        now = new Date('2026-08-09T12:10:00.000Z');
        return jsonResponse(providerEvent, { status: 201 });
      },
      () => jsonResponse({ etag: '"calendar-v2"' }),
      () => jsonResponse(providerEvent),
    ];
    const fetch = vi.fn(async () => responses.shift()!());
    const executor = new CalendarWriteExecutor(
      new FetchGoogleCalendarConditionalGateway({
        actor,
        authorizationScopeFingerprint,
        broker: broker(),
        fetch,
        clock: () => new Date(now.getTime()),
      }),
      new InMemoryCalendarWriteReceiptStore(),
    );

    await expect(
      executor.execute(command, approvedContext(command)),
    ).resolves.toMatchObject({ status: 'applied', reconciled: false });
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it.each([
    ['household', { ...actor, householdId: 'different-household' }],
    ['private space', { ...actor, privateSpaceId: 'different-private-space' }],
    [
      'session',
      {
        ...actor,
        sessionId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f099',
      },
    ],
  ] as const)(
    'rejects an approval from a different %s before credential brokerage',
    async (_label, differentActor) => {
      const credentialBroker = broker();
      const gateway = new FetchGoogleCalendarConditionalGateway({
        actor: differentActor,
        authorizationScopeFingerprint,
        clock: approvalClock,
        broker: credentialBroker,
        fetch: vi.fn(),
      });

      await expect(
        gateway.readCurrent(command, approvedContext(command)),
      ).rejects.toThrow('google-calendar-write-authorization-invalid');
      expect(credentialBroker.calls).toEqual([]);
    },
  );

  it('rejects an old approval after the actor reconnects to another grant instance', async () => {
    const credentialBroker: GoogleCalendarCredentialBroker = {
      async acquireAccessTokenForCapability() {
        return {
          ...accessTokenLease,
          grantReference: 'different-reconnected-grant-reference',
        };
      },
    };
    const fetch = vi.fn();
    const gateway = new FetchGoogleCalendarConditionalGateway({
      actor,
      authorizationScopeFingerprint,
      clock: approvalClock,
      broker: credentialBroker,
      fetch,
    });

    await expect(
      gateway.applyConditionalExactlyOnce(command, approvedContext(command)),
    ).resolves.toEqual({
      status: 'not-applied',
      reason: 'conditional-rejected',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects the removed constructor grant seam before token access', () => {
    const credentialBroker = broker();
    expect(
      () =>
        new FetchGoogleCalendarConditionalGateway({
          actor,
          spaceAccessGrantId,
          clock: approvalClock,
          broker: credentialBroker,
          fetch: vi.fn(),
        } as never),
    ).toThrow('invalid-google-calendar-conditional-gateway');
    expect(credentialBroker.calls).toEqual([]);
  });

  it('rejects an incorrect payload digest before credential brokerage', async () => {
    const credentialBroker = broker();
    const gateway = new FetchGoogleCalendarConditionalGateway({
      actor,
      authorizationScopeFingerprint,
      clock: approvalClock,
      broker: credentialBroker,
      fetch: vi.fn(),
    });
    const incorrectDigestCommand = {
      ...command,
      payloadHash: 'f'.repeat(64),
    };

    await expect(
      gateway.readCurrent(
        incorrectDigestCommand,
        approvedContext(incorrectDigestCommand),
      ),
    ).rejects.toThrow('google-calendar-write-authorization-invalid');
    expect(credentialBroker.calls).toEqual([]);
  });

  it('rejects an old approval when the durable authorization epoch advances', async () => {
    const credentialBroker: GoogleCalendarCredentialBroker = {
      async acquireAccessTokenForCapability() {
        return {
          ...accessTokenLease,
          authorizationEpoch: accessTokenLease.authorizationEpoch + 1,
        };
      },
    };
    const fetch = vi.fn();
    const gateway = new FetchGoogleCalendarConditionalGateway({
      actor,
      authorizationScopeFingerprint,
      clock: approvalClock,
      broker: credentialBroker,
      fetch,
    });

    await expect(
      gateway.applyConditionalExactlyOnce(command, approvedContext(command)),
    ).resolves.toEqual({
      status: 'not-applied',
      reason: 'conditional-rejected',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an approval bound to a different server actor before token access', async () => {
    const credentialBroker = broker();
    const authorization = approvedContext(command);
    const gateway = new FetchGoogleCalendarConditionalGateway({
      actor: { ...actor, userId: 'different-user' },
      authorizationScopeFingerprint,
      clock: approvalClock,
      broker: credentialBroker,
      fetch: vi.fn(),
    });

    await expect(gateway.readCurrent(command, authorization)).rejects.toThrow(
      'google-calendar-write-authorization-invalid',
    );
    expect(credentialBroker.calls).toEqual([]);
  });
});

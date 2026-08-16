import { describe, expect, it, vi } from 'vitest';

import {
  normalizeAuthorizedCalendarEvidence,
  rankScheduleAlternatives,
  resolveTrustedCalendarAuthorizationContext,
  resolveDeterministicTravelBuffer,
  type TrustedCalendarAuthorizationContext,
} from './planning.js';

const evidencePolicy = {
  now: new Date('2026-08-09T12:05:00.000Z'),
  maxSnapshotAgeMs: 15 * 60_000,
  referenceNamespace: 'scheduler-run-018f1f5e',
  referenceKey: new Uint8Array(32).fill(7),
} as const;

const authorizationContext = (authorizedCalendars: readonly unknown[]) =>
  resolveTrustedCalendarAuthorizationContext({
    listAuthorizedCalendars: async () => authorizedCalendars,
  });

describe('scheduler planning evidence', () => {
  it('requires every authorized calendar and masks non-shared details', async () => {
    const context = await authorizationContext([
      {
        calendarId: 'private-owner',
        access: 'events',
        detailSharing: 'private',
      },
      {
        calendarId: 'household',
        access: 'events',
        detailSharing: 'household-full',
      },
      {
        calendarId: 'free-busy',
        access: 'free-busy',
        detailSharing: 'private',
      },
    ]);
    const result = normalizeAuthorizedCalendarEvidence(
      context,
      {
        snapshots: [
          {
            kind: 'events',
            calendarId: 'private-owner',
            calendarVersion: 'cal-private-v1',
            fetchedAt: '2026-08-09T12:00:00.000Z',
            events: [
              {
                eventId: 'private-event',
                eventVersion: 'private-v1',
                start: '2026-08-10T13:00:00.000Z',
                end: '2026-08-10T14:00:00.000Z',
                visibility: 'default',
                summary: 'Medical appointment',
                location: 'Private clinic',
              },
            ],
          },
          {
            kind: 'events',
            calendarId: 'household',
            calendarVersion: 'cal-household-v1',
            fetchedAt: '2026-08-09T12:00:01.000Z',
            events: [
              {
                eventId: 'shared-event',
                eventVersion: 'shared-v1',
                start: '2026-08-10T15:00:00.000Z',
                end: '2026-08-10T16:00:00.000Z',
                visibility: 'default',
                summary: 'School pickup',
                location: 'School',
              },
              {
                eventId: 'explicit-private',
                eventVersion: 'shared-v2',
                start: '2026-08-10T17:00:00.000Z',
                end: '2026-08-10T18:00:00.000Z',
                visibility: 'private',
                summary: 'Do not disclose',
              },
            ],
          },
          {
            kind: 'free-busy',
            calendarId: 'free-busy',
            calendarVersion: 'cal-fb-v1',
            fetchedAt: '2026-08-09T12:00:02.000Z',
            busy: [
              {
                start: '2026-08-10T19:00:00.000Z',
                end: '2026-08-10T20:00:00.000Z',
              },
            ],
          },
        ],
      },
      evidencePolicy,
    );

    expect(result.calendarRefs).toHaveLength(3);
    expect(result.snapshots).toHaveLength(3);
    expect(result.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          details: null,
          maskReason: 'calendar-private',
        }),
        expect.objectContaining({
          details: { summary: 'School pickup', location: 'School' },
          maskReason: null,
        }),
        expect.objectContaining({
          details: null,
          maskReason: 'event-private',
        }),
        expect.objectContaining({
          eventRef: null,
          details: null,
          maskReason: 'free-busy-only',
        }),
      ]),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('private-owner');
    expect(serialized).not.toContain('private-event');
    expect(serialized).not.toContain('private-v1');
    expect(serialized).not.toContain('Medical appointment');
  });

  it('fails closed for missing, duplicate, or unauthorized calendar evidence', async () => {
    const authorizedCalendars = [
      {
        calendarId: 'primary',
        access: 'events' as const,
        detailSharing: 'private' as const,
      },
    ];
    const context = await authorizationContext(authorizedCalendars);
    expect(() =>
      normalizeAuthorizedCalendarEvidence(
        context,
        { snapshots: [] },
        evidencePolicy,
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'calendar-evidence-missing' }),
    );
    expect(() =>
      normalizeAuthorizedCalendarEvidence(
        context,
        {
          snapshots: [
            {
              kind: 'free-busy',
              calendarId: 'other',
              calendarVersion: 'v1',
              fetchedAt: '2026-08-09T12:00:00.000Z',
              busy: [],
            },
          ],
        },
        evidencePolicy,
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'calendar-evidence-unauthorized' }),
    );

    await expect(
      authorizationContext([...authorizedCalendars, ...authorizedCalendars]),
    ).rejects.toMatchObject({ code: 'calendar-evidence-duplicate' });

    const freeBusyContext = await authorizationContext([
      {
        calendarId: 'free-busy',
        access: 'free-busy',
        detailSharing: 'private',
      },
    ]);
    expect(() =>
      normalizeAuthorizedCalendarEvidence(
        freeBusyContext,
        {
          snapshots: [
            {
              kind: 'events',
              calendarId: 'free-busy',
              calendarVersion: 'v1',
              fetchedAt: '2026-08-09T12:00:00.000Z',
              events: [],
            },
          ],
        },
        evidencePolicy,
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'calendar-evidence-unauthorized' }),
    );
  });

  it('requires a server-issued policy, fresh snapshots, and unique event evidence', async () => {
    const context = await authorizationContext([
      {
        calendarId: 'primary',
        access: 'events',
        detailSharing: 'private',
      },
    ]);
    const emptySnapshot = {
      snapshots: [
        {
          kind: 'events' as const,
          calendarId: 'primary',
          calendarVersion: 'v1',
          fetchedAt: '2026-08-09T12:00:00.000Z',
          events: [],
        },
      ],
    };
    const empty = normalizeAuthorizedCalendarEvidence(
      context,
      emptySnapshot,
      evidencePolicy,
    );
    expect(empty.snapshots).toMatchObject([{ blockCount: 0 }]);

    expect(() =>
      normalizeAuthorizedCalendarEvidence(
        {} as TrustedCalendarAuthorizationContext,
        emptySnapshot,
        evidencePolicy,
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'calendar-authorization-invalid' }),
    );
    expect(() =>
      normalizeAuthorizedCalendarEvidence(context, emptySnapshot, {
        ...evidencePolicy,
        now: new Date('2026-08-09T13:00:00.000Z'),
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'calendar-evidence-stale' }),
    );

    const duplicate = {
      snapshots: [
        {
          kind: 'events',
          calendarId: 'primary',
          calendarVersion: 'v1',
          fetchedAt: '2026-08-09T12:00:00.000Z',
          events: [
            {
              eventId: 'same',
              eventVersion: 'v1',
              start: '2026-08-10T13:00:00.000Z',
              end: '2026-08-10T14:00:00.000Z',
              visibility: 'default',
            },
            {
              eventId: 'same',
              eventVersion: 'v2',
              start: '2026-08-10T15:00:00.000Z',
              end: '2026-08-10T16:00:00.000Z',
              visibility: 'default',
            },
          ],
        },
      ],
    };
    expect(() =>
      normalizeAuthorizedCalendarEvidence(context, duplicate, evidencePolicy),
    ).toThrowError(
      expect.objectContaining({ code: 'calendar-evidence-duplicate' }),
    );
  });
});

describe('travel buffers and ranked alternatives', () => {
  it('rounds Maps seconds up, adds a fixed buffer, and uses a bounded fallback', async () => {
    await expect(
      resolveDeterministicTravelBuffer(
        {
          origin: 'Home',
          destination: 'Clinic',
          mode: 'driving',
          departureAt: '2026-08-10T13:00:00.000Z',
        },
        {
          lookup: async () => ({
            status: 'available',
            durationSeconds: 1_201,
            fetchedAt: '2026-08-10T12:59:00.000Z',
          }),
          now: new Date('2026-08-10T13:00:00.000Z'),
          fixedBufferMinutes: 10,
          fallbackMinutes: { driving: 35, transit: 50, walking: 25 },
        },
      ),
    ).resolves.toMatchObject({
      travelMinutes: 21,
      totalBufferMinutes: 31,
      source: 'google-maps',
    });

    await expect(
      resolveDeterministicTravelBuffer(
        {
          origin: 'Home',
          destination: 'Clinic',
          mode: 'driving',
          departureAt: '2026-08-10T13:00:00.000Z',
        },
        {
          lookup: async () => ({ status: 'unavailable', reason: 'no-route' }),
          now: new Date('2026-08-10T13:00:00.000Z'),
          fixedBufferMinutes: 10,
          fallbackMinutes: { driving: 35, transit: 50, walking: 25 },
        },
      ),
    ).resolves.toMatchObject({
      travelMinutes: 35,
      totalBufferMinutes: 45,
      source: 'fallback',
    });
  });

  it('falls back for stale, future, malformed, or failed Maps evidence', async () => {
    const basePolicy = {
      now: new Date('2026-08-10T13:00:00.000Z'),
      fixedBufferMinutes: 10,
      fallbackMinutes: { driving: 35, transit: 50, walking: 25 },
    } as const;
    const query = {
      origin: 'Home',
      destination: 'Clinic',
      mode: 'driving',
      departureAt: '2026-08-10T13:00:00.000Z',
    } as const;

    for (const lookup of [
      async () => ({
        status: 'available',
        durationSeconds: 600,
        fetchedAt: '2026-08-10T12:00:00.000Z',
      }),
      async () => ({
        status: 'available',
        durationSeconds: 600,
        fetchedAt: '2026-08-10T14:00:00.000Z',
      }),
      async () => ({ status: 'available', durationSeconds: -1 }),
      async () => {
        throw new Error('recorded provider failure');
      },
    ]) {
      await expect(
        resolveDeterministicTravelBuffer(query, { ...basePolicy, lookup }),
      ).resolves.toMatchObject({ source: 'fallback', travelMinutes: 35 });
    }
  });

  it('ranks available slots deterministically around travel and busy time', async () => {
    const lookup = vi.fn(async () => ({
      status: 'available' as const,
      durationSeconds: 1_200,
      fetchedAt: '2026-08-10T12:00:00.000Z',
    }));
    const alternatives = await rankScheduleAlternatives(
      {
        windowStart: '2026-08-10T13:00:00.000Z',
        windowEnd: '2026-08-10T18:00:00.000Z',
        durationMinutes: 60,
        stepMinutes: 30,
        preferredStart: '2026-08-10T15:00:00.000Z',
        appointmentLocation: 'Clinic',
        travelMode: 'driving',
        maxAlternatives: 3,
        busy: [
          {
            start: '2026-08-10T13:00:00.000Z',
            end: '2026-08-10T14:00:00.000Z',
            location: 'Home',
          },
          {
            start: '2026-08-10T17:00:00.000Z',
            end: '2026-08-10T18:00:00.000Z',
            location: 'School',
          },
        ],
      },
      {
        lookup,
        now: new Date('2026-08-10T12:01:00.000Z'),
        fixedBufferMinutes: 10,
        fallbackMinutes: { driving: 35, transit: 50, walking: 25 },
      },
    );

    expect(alternatives.map(({ start }) => start)).toEqual([
      '2026-08-10T15:00:00.000Z',
      '2026-08-10T14:30:00.000Z',
      '2026-08-10T15:30:00.000Z',
    ]);
    expect(alternatives[0]).toMatchObject({
      end: '2026-08-10T16:00:00.000Z',
      score: 0,
      travelBeforeMinutes: 30,
      travelAfterMinutes: 30,
    });
  });

  it('uses the latest-ending prior event and enforces a strict Maps call budget', async () => {
    const lookup = vi.fn(async (query: { origin: string }) => ({
      status: 'available' as const,
      durationSeconds: query.origin === 'Far Away' ? 3_600 : 0,
      fetchedAt: '2026-08-10T13:59:00.000Z',
    }));
    const alternatives = await rankScheduleAlternatives(
      {
        windowStart: '2026-08-10T14:00:00.000Z',
        windowEnd: '2026-08-10T18:00:00.000Z',
        durationMinutes: 60,
        stepMinutes: 30,
        preferredStart: '2026-08-10T14:00:00.000Z',
        appointmentLocation: 'Clinic',
        travelMode: 'driving',
        maxAlternatives: 10,
        busy: [
          {
            start: '2026-08-10T10:00:00.000Z',
            end: '2026-08-10T14:00:00.000Z',
            location: 'Far Away',
          },
          {
            start: '2026-08-10T11:00:00.000Z',
            end: '2026-08-10T12:00:00.000Z',
            location: 'Clinic',
          },
        ],
      },
      {
        lookup,
        now: new Date('2026-08-10T14:00:00.000Z'),
        fixedBufferMinutes: 0,
        fallbackMinutes: { driving: 35, transit: 50, walking: 25 },
        maxLookupCalls: 2,
      },
    );

    expect(alternatives[0]?.start).not.toBe('2026-08-10T14:00:00.000Z');
    expect(lookup.mock.calls.length).toBeLessThanOrEqual(2);
    expect(lookup.mock.calls[0]?.[0]).toMatchObject({ origin: 'Far Away' });
  });

  it('times out a hanging Maps lookup and preserves same-location setup time', async () => {
    const never = new Promise<unknown>(() => undefined);
    await expect(
      resolveDeterministicTravelBuffer(
        {
          origin: 'Home',
          destination: 'Clinic',
          mode: 'driving',
          departureAt: '2026-08-10T13:00:00.000Z',
        },
        {
          lookup: async () => never,
          now: new Date('2026-08-10T13:00:00.000Z'),
          fixedBufferMinutes: 10,
          fallbackMinutes: { driving: 35, transit: 50, walking: 25 },
          lookupTimeoutMs: 50,
        },
      ),
    ).resolves.toMatchObject({ source: 'fallback', totalBufferMinutes: 45 });

    const lookup = vi.fn(async () => ({ status: 'unavailable' as const }));
    await expect(
      resolveDeterministicTravelBuffer(
        {
          origin: 'Clinic',
          destination: 'clinic',
          mode: 'driving',
          departureAt: '2026-08-10T13:00:00.000Z',
        },
        {
          lookup,
          now: new Date('2026-08-10T13:00:00.000Z'),
          fixedBufferMinutes: 10,
          fallbackMinutes: { driving: 35, transit: 50, walking: 25 },
        },
      ),
    ).resolves.toMatchObject({
      source: 'same-location',
      travelMinutes: 0,
      totalBufferMinutes: 10,
    });
    expect(lookup).not.toHaveBeenCalled();
  });
});

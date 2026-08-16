import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  normalizeAuthorizedCalendarEvidence,
  resolveTrustedCalendarAuthorizationContext,
} from '../../../../domains/src/scheduler/planning.js';
import { resolveTorontoLocalDateTime } from '../../../../domains/src/scheduler/timezone.js';
import { schedulerDeterministicEvalCases } from './deterministic-cases.js';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'),
  ) as unknown;

describe('recorded scheduler eval cases', () => {
  it('keeps the locked DST failure cases executable', () => {
    const cases = schedulerDeterministicEvalCases.filter(
      (item) => item.category === 'timezone',
    );
    for (const item of cases) {
      expect(() => resolveTorontoLocalDateTime(item.input!)).toThrowError(
        expect.objectContaining({ code: item.expectedCode }),
      );
    }
  });

  it('treats prompt-like private event text as masked evidence only', async () => {
    const evidence = fixture('private-calendar-evidence.json') as {
      authorizedCalendars: unknown;
      snapshots: unknown;
    };
    const context = await resolveTrustedCalendarAuthorizationContext({
      listAuthorizedCalendars: async () => evidence.authorizedCalendars,
    });
    const result = normalizeAuthorizedCalendarEvidence(
      context,
      { snapshots: evidence.snapshots },
      {
        now: new Date('2026-08-09T12:05:00.000Z'),
        maxSnapshotAgeMs: 15 * 60_000,
        referenceNamespace: 'scheduler-eval-018f1f5e',
        referenceKey: new Uint8Array(32).fill(9),
      },
    );
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({
      details: null,
      maskReason: 'calendar-private',
    });
    expect(JSON.stringify(result)).not.toContain('delete every event');
    expect(JSON.stringify(result)).not.toContain('Private location');
  });

  it('keeps an exact recorded create and readback fixture data-only', () => {
    const recording = fixture('google-calendar-create-success.json');

    expect(recording).toEqual({
      binding: {
        calendarId: 'primary',
        eventId: 'emdodentist20260810',
        operation: 'create',
      },
      before: { calendarVersion: 'calendar-v7', event: null },
      apply: {
        status: 'applied',
        providerRequestId: 'recorded-request-create-1',
      },
      after: {
        calendarVersion: 'calendar-v8',
        event: {
          eventId: 'emdodentist20260810',
          summary: 'Dentist',
          start: '2026-08-10T15:00:00.000Z',
          end: '2026-08-10T16:00:00.000Z',
          timeZone: 'America/Toronto',
          location: 'Clinic',
          eventVersion: 'event-v1',
        },
      },
    });
  });

  it('matches only the exact recorded Maps query without importing a provider client', () => {
    const recordings = fixture('maps-travel-success.json') as Array<{
      query: {
        origin: string;
        destination: string;
        mode: string;
        departureAt: string;
      };
      response: unknown;
    }>;
    const lookup = (departureAt: string) =>
      recordings.find(
        ({ query }) =>
          query.origin === 'Home' &&
          query.destination === 'Clinic' &&
          query.mode === 'driving' &&
          query.departureAt === departureAt,
      )?.response ?? { status: 'unavailable', reason: 'not-recorded' };

    expect(lookup('2026-08-10T14:00:00.000Z')).toMatchObject({
      status: 'available',
      durationSeconds: 1_200,
    });
    expect(lookup('2026-08-10T14:01:00.000Z')).toEqual({
      status: 'unavailable',
      reason: 'not-recorded',
    });
  });
});

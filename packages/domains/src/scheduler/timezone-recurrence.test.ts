import { describe, expect, it } from 'vitest';

import {
  expandTorontoRecurrence,
  resolveTorontoLocalDateTime,
} from './timezone.js';

describe('Toronto timezone calculations', () => {
  it('uses the Toronto winter and summer UTC offsets', () => {
    expect(resolveTorontoLocalDateTime('2026-01-15T09:00')).toEqual({
      instant: '2026-01-15T14:00:00.000Z',
      localDateTime: '2026-01-15T09:00',
      offsetMinutes: -300,
    });
    expect(resolveTorontoLocalDateTime('2026-07-15T09:00')).toEqual({
      instant: '2026-07-15T13:00:00.000Z',
      localDateTime: '2026-07-15T09:00',
      offsetMinutes: -240,
    });
  });

  it('fails closed for nonexistent and ambiguous wall times', () => {
    expect(() => resolveTorontoLocalDateTime('2026-03-08T02:30')).toThrowError(
      expect.objectContaining({ code: 'nonexistent-local-time' }),
    );
    expect(() => resolveTorontoLocalDateTime('2026-11-01T01:30')).toThrowError(
      expect.objectContaining({ code: 'ambiguous-local-time' }),
    );

    const earlier = resolveTorontoLocalDateTime('2026-11-01T01:30', 'earlier');
    const later = resolveTorontoLocalDateTime('2026-11-01T01:30', 'later');
    expect(Date.parse(later.instant) - Date.parse(earlier.instant)).toBe(
      3_600_000,
    );
    expect(() =>
      resolveTorontoLocalDateTime('2026-11-01T01:30', 'bogus' as never),
    ).toThrowError(expect.objectContaining({ code: 'invalid-local-time' }));
  });

  it('expands weekly wall-clock recurrences across DST deterministically', () => {
    const occurrences = expandTorontoRecurrence({
      startLocalDateTime: '2026-02-23T09:00',
      durationMinutes: 60,
      rule: {
        frequency: 'weekly',
        interval: 1,
        count: 4,
        byWeekday: ['MO'],
      },
      rangeStart: '2026-02-01T00:00:00.000Z',
      rangeEnd: '2026-04-01T00:00:00.000Z',
    });

    expect(occurrences.map((item) => item.localStart)).toEqual([
      '2026-02-23T09:00',
      '2026-03-02T09:00',
      '2026-03-09T09:00',
      '2026-03-16T09:00',
    ]);
    expect(occurrences.map((item) => item.start)).toEqual([
      '2026-02-23T14:00:00.000Z',
      '2026-03-02T14:00:00.000Z',
      '2026-03-09T13:00:00.000Z',
      '2026-03-16T13:00:00.000Z',
    ]);
  });

  it('rejects a recurrence containing a spring-forward gap', () => {
    expect(() =>
      expandTorontoRecurrence({
        startLocalDateTime: '2026-03-07T02:30',
        durationMinutes: 30,
        rule: { frequency: 'daily', interval: 1, count: 2 },
        rangeStart: '2026-03-01T00:00:00.000Z',
        rangeEnd: '2026-04-01T00:00:00.000Z',
      }),
    ).toThrowError(expect.objectContaining({ code: 'nonexistent-local-time' }));
  });

  it('rejects invalid calendar dates and hostile recurrence input', () => {
    expect(() => resolveTorontoLocalDateTime('2026-02-30T09:00')).toThrowError(
      expect.objectContaining({ code: 'invalid-local-time' }),
    );

    let getterCalls = 0;
    const hostile = Object.defineProperty({}, 'startLocalDateTime', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return '2026-08-10T09:00';
      },
    });
    expect(() => expandTorontoRecurrence(hostile)).toThrowError(
      expect.objectContaining({ code: 'recurrence-out-of-bounds' }),
    );
    expect(getterCalls).toBe(0);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => expandTorontoRecurrence(cyclic)).toThrowError(
      expect.objectContaining({ code: 'recurrence-out-of-bounds' }),
    );
  });
});

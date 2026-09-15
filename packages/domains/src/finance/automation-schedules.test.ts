import { Settings } from 'luxon';
import { describe, expect, it } from 'vitest';
import { FinanceAutomationScheduleSchema } from '@emdo/contracts';
import { planFinanceAutomationDue } from './automation-schedules.js';
const id = '00000000-0000-4000-8000-000000000001';
const local = {
  timeZone: 'America/Toronto',
  localTime: '09:00:00',
  gapPolicy: 'skip' as const,
  overlapPolicy: 'earlier' as const,
  tzdbVersion: '2025b',
};
const schedule = FinanceAutomationScheduleSchema.parse({
  id,
  definitionRevision: 1,
  stateRevision: 1,
  status: 'active',
  definition: {
    workspaceId: id,
    bookId: id,
    grantId: id,
    grantRevision: 2,
    capability: 'finance.reports.generate',
    targets: [id],
    money: { currency: 'CAD', amount: '0' },
    startAt: '2026-01-01T00:00:00Z',
    endAt: null,
    cadence: {
      kind: 'interval',
      everySeconds: 60,
      timeZone: 'UTC',
      clock: 'elapsed-utc',
    },
    misfire: { policy: 'coalesce-latest', maxLatenessSeconds: 86400 },
    concurrency: { policy: 'forbid', onBusy: 'defer' },
  },
});
function input(
  cadence: unknown = schedule.definition.cadence,
  now = '2026-01-01T00:00:00Z',
) {
  return {
    schedule: { ...schedule, definition: { ...schedule.definition, cadence } },
    cursor: { scheduleId: id, definitionRevision: 1, nextOrdinal: 0 },
    now,
    blockingRunCount: 0,
    runtimeTimezoneVersion: '2025b',
  };
}
function plan(cadence: unknown, now: string) {
  const result = planFinanceAutomationDue(input(cadence, now));
  if (result.status === 'invalid') throw new Error(result.reason);
  return result;
}
describe('bounded recurring Finance trigger planning', () => {
  it('uses stable occurrence keys, explicit no-authority and cursor consumption, independent of poll time', () => {
    const first = plan(schedule.definition.cadence, '2026-01-01T00:01:05Z');
    const retry = plan(schedule.definition.cadence, '2026-01-01T00:01:10Z');
    expect(first.occurrence).toEqual(retry.occurrence);
    expect(first.executionAuthority).toBe('none');
    expect(first.occurrence?.id).toBe(`finance-schedule:${id}:1:1`);
    expect(
      planFinanceAutomationDue({
        ...input(),
        now: '2026-01-01T00:01:10Z',
        cursor: first.nextCursor,
      }),
    ).toMatchObject({ status: 'not-due', occurrence: null });
  });
  it('bounds years of overdue intervals to one occurrence and one auditable range', () => {
    const result = plan(schedule.definition.cadence, '2036-01-01T00:00:00Z');
    expect(result.status).toBe('due');
    expect(result.consumedRange!.count).toBeGreaterThan(5_000_000);
    expect(result.occurrence).not.toBeNull();
    const skip = input();
    skip.now = '2036-01-01T00:00:10Z';
    skip.schedule.definition.misfire = { policy: 'skip', graceSeconds: 5 };
    expect(planFinanceAutomationDue(skip)).toMatchObject({
      status: 'skipped',
      reason: 'misfire-expired',
      occurrence: null,
    });
  });
  it('uses elapsed UTC intervals across DST rather than silently changing interval duration', () => {
    const result = input(
      {
        kind: 'interval',
        everySeconds: 86400,
        timeZone: 'America/Toronto',
        clock: 'elapsed-utc',
      },
      '2026-03-09T14:00:00Z',
    );
    result.schedule.definition.startAt = '2026-03-07T14:00:00Z';
    expect(planFinanceAutomationDue(result)).toMatchObject({
      occurrence: { scheduledAt: '2026-03-09T14:00:00.000Z', ordinal: 2 },
    });
  });
  it('keeps daily local time while UTC offsets change in spring and autumn', () => {
    const cadence = {
      kind: 'daily',
      anchorDate: '2026-03-07',
      everyDays: 1,
      ...local,
    };
    expect(plan(cadence, '2026-03-07T14:00:00Z').occurrence?.scheduledAt).toBe(
      '2026-03-07T14:00:00.000Z',
    );
    expect(plan(cadence, '2026-03-08T13:00:00Z').occurrence?.scheduledAt).toBe(
      '2026-03-08T13:00:00.000Z',
    );
    expect(
      plan(cadence, '2026-11-01T14:00:00Z').occurrence?.offsetMinutes,
    ).toBe(-300);
  });
  it('makes spring gap skip versus shift-forward explicit without a guessed time', () => {
    const cadence = {
      kind: 'daily',
      anchorDate: '2026-03-08',
      everyDays: 1,
      ...local,
      localTime: '02:30:00',
    };
    expect(plan(cadence, '2026-03-08T07:30:00Z')).toMatchObject({
      status: 'skipped',
      reason: 'gap-skipped',
      occurrence: null,
    });
    expect(
      plan({ ...cadence, gapPolicy: 'shift-forward' }, '2026-03-08T07:30:00Z'),
    ).toMatchObject({
      status: 'due',
      occurrence: {
        scheduledAt: '2026-03-08T07:30:00.000Z',
        intendedLocal: '2026-03-08T02:30:00',
        adjustment: 'gap-shift-forward',
      },
    });
  });
  it('selects exactly one autumn overlap instant and does not duplicate on its later offset', () => {
    const cadence = {
      kind: 'daily',
      anchorDate: '2026-11-01',
      everyDays: 1,
      ...local,
      localTime: '01:30:00',
    };
    const earlier = plan(cadence, '2026-11-01T06:30:00Z');
    const later = plan(
      { ...cadence, overlapPolicy: 'later' },
      '2026-11-01T06:30:00Z',
    );
    expect(earlier.occurrence?.scheduledAt).toBe('2026-11-01T05:30:00.000Z');
    expect(later.occurrence?.scheduledAt).toBe('2026-11-01T06:30:00.000Z');
    expect(
      plan({ ...cadence, overlapPolicy: 'later' }, '2026-11-01T05:30:00Z')
        .status,
    ).toBe('not-due');
    expect(
      planFinanceAutomationDue({
        ...input(cadence, '2026-11-01T06:30:00Z'),
        cursor: earlier.nextCursor,
      }),
    ).toMatchObject({ status: 'not-due' });
  });
  it('resolves overlap identically regardless of the host clock or default zone', () => {
    const cadence = {
      kind: 'daily',
      anchorDate: '2026-11-01',
      everyDays: 1,
      ...local,
      localTime: '01:30:00',
      overlapPolicy: 'later',
    };
    const originalNow = Settings.now,
      originalZone = Settings.defaultZone;
    try {
      Settings.now = () => Date.parse('2026-01-01T00:00:00Z');
      Settings.defaultZone = 'Asia/Tokyo';
      const winter = plan(cadence, '2026-11-01T06:30:00Z');
      Settings.now = () => Date.parse('2026-07-01T00:00:00Z');
      Settings.defaultZone = 'Europe/Berlin';
      expect(plan(cadence, '2026-11-01T06:30:00Z')).toEqual(winter);
    } finally {
      Settings.now = originalNow;
      Settings.defaultZone = originalZone;
    }
  });
  it('uses actual timezone gap size including a thirty-minute transition', () => {
    const cadence = {
      kind: 'daily',
      anchorDate: '2026-10-04',
      everyDays: 1,
      ...local,
      timeZone: 'Australia/Lord_Howe',
      localTime: '02:15:00',
      gapPolicy: 'shift-forward',
    };
    expect(plan(cadence, '2026-10-03T15:45:00Z')).toMatchObject({
      occurrence: {
        scheduledAt: '2026-10-03T15:45:00.000Z',
        resolvedLocal: '2026-10-04T02:45:00.000+11:00',
        adjustments: ['gap-shift-forward'],
      },
    });
  });
  it('supports weekly anchored weekdays and rejects mismatched anchors', () => {
    const cadence = {
      kind: 'weekly',
      anchorDate: '2026-03-02',
      weekday: 1,
      everyWeeks: 1,
      ...local,
    };
    expect(plan(cadence, '2026-03-09T13:00:00Z')).toMatchObject({
      occurrence: { ordinal: 1, scheduledAt: '2026-03-09T13:00:00.000Z' },
    });
    expect(
      plan({ ...cadence, weekday: 2 }, '2026-03-09T13:00:00Z'),
    ).toMatchObject({
      status: 'blocked',
      reason: 'weekly-anchor-weekday-mismatch',
    });
  });
  it('explicitly skips or clamps short months and honors leap years without anchor drift', () => {
    const cadence = {
      kind: 'monthly',
      anchorMonth: '2026-01',
      dayOfMonth: 31,
      everyMonths: 1,
      shortMonthPolicy: 'skip',
      ...local,
    };
    expect(plan(cadence, '2026-02-28T14:00:00Z')).toMatchObject({
      status: 'skipped',
      reason: 'short-month-skipped',
    });
    expect(
      plan(
        { ...cadence, shortMonthPolicy: 'last-day' },
        '2026-02-28T14:00:00Z',
      ),
    ).toMatchObject({
      occurrence: {
        scheduledAt: '2026-02-28T14:00:00.000Z',
        adjustment: 'short-month-last-day',
      },
    });
    expect(
      plan({ ...cadence, shortMonthPolicy: 'last-day' }, '2028-02-29T14:00:00Z')
        .occurrence?.scheduledAt,
    ).toBe('2028-02-29T14:00:00.000Z');
    expect(
      plan({ ...cadence, shortMonthPolicy: 'last-day' }, '2026-03-31T13:00:00Z')
        .occurrence?.scheduledAt,
    ).toBe('2026-03-31T13:00:00.000Z');
  });
  it('defers concurrency without consuming a due occurrence, including unknown-effect blocking runs', () => {
    const blocked = { ...input(), blockingRunCount: 1 };
    expect(planFinanceAutomationDue(blocked)).toMatchObject({
      status: 'deferred',
      nextCursor: blocked.cursor,
    });
    const allowed = {
      ...blocked,
      schedule: {
        ...schedule,
        definition: {
          ...schedule.definition,
          concurrency: { policy: 'allow', maxInFlight: 2, onBusy: 'defer' },
        },
      },
    };
    expect(planFinanceAutomationDue(allowed)).toMatchObject({ status: 'due' });
  });
  it('preserves identity across pause/resume and blocks changed definition cursors and timezone rules', () => {
    const paused = {
      ...input(),
      schedule: { ...schedule, status: 'paused', stateRevision: 2 },
    };
    expect(planFinanceAutomationDue(paused)).toMatchObject({
      status: 'paused',
      nextCursor: paused.cursor,
    });
    expect(
      planFinanceAutomationDue({
        ...input(),
        schedule: { ...schedule, stateRevision: 3 },
      }),
    ).toMatchObject({ occurrence: { id: `finance-schedule:${id}:1:0` } });
    expect(
      planFinanceAutomationDue({
        ...input(),
        cursor: { scheduleId: id, definitionRevision: 2, nextOrdinal: 0 },
      }),
    ).toMatchObject({
      status: 'blocked',
      reason: 'cursor-definition-mismatch',
    });
    expect(
      planFinanceAutomationDue({
        ...input({
          kind: 'daily',
          anchorDate: '2026-01-01',
          everyDays: 1,
          ...local,
        }),
        runtimeTimezoneVersion: 'changed',
      }),
    ).toMatchObject({
      status: 'blocked',
      reason: 'timezone-rules-review-required',
    });
  });
  it('treats start inclusive/end exclusive and never schedules after end', () => {
    const data = input();
    data.schedule.definition.endAt = '2026-01-01T00:01:00Z';
    data.now = '2026-01-01T00:01:00Z';
    expect(planFinanceAutomationDue(data)).toMatchObject({
      status: 'exhausted',
      reason: 'schedule-ended',
      occurrence: null,
    });
    data.now = '2026-01-01T00:00:59Z';
    expect(planFinanceAutomationDue(data)).toMatchObject({
      occurrence: { ordinal: 0 },
    });
    data.now = '2026-01-01T00:01:00Z';
    data.cursor.nextOrdinal = 1;
    expect(planFinanceAutomationDue(data)).toMatchObject({
      status: 'exhausted',
    });
  });
  it('rejects oversized/executable-looking input and invalid calendar zones', () => {
    expect(
      planFinanceAutomationDue({ ...input(), session: { userId: id } }),
    ).toMatchObject({ status: 'invalid' });
    expect(
      planFinanceAutomationDue(
        input({
          ...local,
          kind: 'daily',
          anchorDate: '2026-01-01',
          everyDays: 1,
          timeZone: 'Invented/Zone',
        }),
      ),
    ).toMatchObject({ status: 'invalid' });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(planFinanceAutomationDue(cycle)).toMatchObject({
      status: 'invalid',
    });
  });
});

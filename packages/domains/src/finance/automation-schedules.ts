import { DateTime } from 'luxon';
import {
  FinanceAutomationDuePlanInputSchema,
  deepFreeze,
  type FinanceAutomationCadence,
  type FinanceAutomationScheduleCursor,
} from '@emdo/contracts';
import { boundedFinanceParse } from './guard.js';

interface Slot {
  ordinal: number;
  dueAt: number;
  scheduledAt: number | null;
  intendedLocal: string | null;
  resolvedLocal: string | null;
  offsetMinutes: number | null;
  adjustment:
    | 'none'
    | 'gap-shift-forward'
    | 'gap-skipped'
    | 'short-month-last-day'
    | 'short-month-skipped'
    | 'overlap-earlier'
    | 'overlap-later';
  adjustments: Slot['adjustment'][];
}
export interface FinanceAutomationDuePlan {
  status:
    | 'due'
    | 'not-due'
    | 'deferred'
    | 'paused'
    | 'retired'
    | 'exhausted'
    | 'skipped'
    | 'blocked';
  executionAuthority: 'none';
  reason: string | null;
  expectedStateRevision: number;
  /** Pending nominal due instant; may be in the past while concurrency defers. */
  nextDueAt: string | null;
  nextCursor: FinanceAutomationScheduleCursor;
  evaluatedSlot: {
    ordinal: number;
    dueAt: string;
    intendedLocal: string | null;
    resolvedLocal: string | null;
    adjustments: readonly Slot['adjustment'][];
  } | null;
  occurrence: {
    id: string;
    ordinal: number;
    scheduledAt: string;
    intendedLocal: string | null;
    resolvedLocal: string | null;
    offsetMinutes: number | null;
    adjustment: Slot['adjustment'];
    adjustments: readonly Slot['adjustment'][];
    timezoneEngine: 'luxon-3.7.2';
    tzdbVersion: string | null;
  } | null;
  consumedRange: {
    firstOrdinal: number;
    lastOrdinal: number;
    count: number;
    disposition: 'prior-slots-skipped' | 'prior-slots-coalesced';
    triggeredOrdinal: number | null;
  } | null;
}
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const plainDate = (date: string) => DateTime.fromISO(date, { zone: 'UTC' });
function slotAt(
  c: FinanceAutomationCadence,
  start: number,
  ordinal: number,
): Slot {
  if (c.kind === 'interval')
    return {
      ordinal,
      dueAt: start + ordinal * c.everySeconds * 1000,
      scheduledAt: start + ordinal * c.everySeconds * 1000,
      intendedLocal: null,
      resolvedLocal: null,
      offsetMinutes: null,
      adjustment: 'none',
      adjustments: [],
    };
  const adjustments: Slot['adjustment'][] = [];
  let date: DateTime,
    adjustment: Slot['adjustment'] = 'none';
  if (c.kind === 'monthly') {
    const month = plainDate(`${c.anchorMonth}-01`).plus({
      months: ordinal * c.everyMonths,
    });
    const short = c.dayOfMonth > month.daysInMonth!;
    date = month.set({ day: Math.min(c.dayOfMonth, month.daysInMonth!) });
    if (short)
      adjustment =
        c.shortMonthPolicy === 'skip'
          ? 'short-month-skipped'
          : 'short-month-last-day';
    if (short) adjustments.push(adjustment);
  } else
    date = plainDate(c.anchorDate).plus({
      days: ordinal * (c.kind === 'daily' ? c.everyDays : c.everyWeeks * 7),
    });
  if (!date.isValid) throw new Error('calendar-out-of-range');
  const [hour, minute, second] = c.localTime.split(':').map(Number);
  const intendedLocal = `${c.kind === 'monthly' && adjustment !== 'none' ? `${`${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}`}-${String(c.dayOfMonth).padStart(2, '0')}` : date.toISODate()}T${c.localTime}`;
  let zoned = DateTime.fromObject(
    {
      year: date.year,
      month: date.month,
      day: date.day,
      hour,
      minute,
      second,
      millisecond: 0,
    },
    { zone: c.timeZone },
  );
  if (!zoned.isValid) throw new Error('invalid-zone-date');
  const gap =
    zoned.year !== date.year ||
    zoned.month !== date.month ||
    zoned.day !== date.day ||
    zoned.hour !== hour ||
    zoned.minute !== minute ||
    zoned.second !== second;
  if (gap)
    adjustment = c.gapPolicy === 'skip' ? 'gap-skipped' : 'gap-shift-forward';
  else {
    const possibilities = zoned
      .getPossibleOffsets()
      .sort((a, b) => a.toMillis() - b.toMillis());
    if (possibilities.length > 1) {
      zoned =
        possibilities[
          c.overlapPolicy === 'earlier' ? 0 : possibilities.length - 1
        ]!;
      adjustment = `overlap-${c.overlapPolicy}`;
    }
  }
  if (adjustment !== 'none' && !adjustments.includes(adjustment))
    adjustments.push(adjustment);
  const skipped =
    adjustment === 'gap-skipped' ||
    (c.kind === 'monthly' &&
      c.shortMonthPolicy === 'skip' &&
      c.dayOfMonth > date.daysInMonth!);
  return {
    ordinal,
    dueAt: zoned.toMillis(),
    scheduledAt: skipped ? null : zoned.toMillis(),
    intendedLocal,
    resolvedLocal: zoned.toISO(),
    offsetMinutes: zoned.offset,
    adjustment,
    adjustments,
  };
}
function latestOrdinal(
  c: FinanceAutomationCadence,
  start: number,
  now: number,
) {
  if (c.kind === 'interval')
    return Math.floor((now - start) / (c.everySeconds * 1000));
  const localNow = DateTime.fromMillis(now, { zone: c.timeZone });
  if (c.kind === 'monthly') {
    const anchor = plainDate(`${c.anchorMonth}-01`);
    return Math.floor(
      ((localNow.year - anchor.year) * 12 + localNow.month - anchor.month) /
        c.everyMonths,
    );
  }
  const date = plainDate(localNow.toISODate()!);
  return Math.floor(
    date.diff(plainDate(c.anchorDate), 'days').days /
      (c.kind === 'daily' ? c.everyDays : c.everyWeeks * 7),
  );
}
/** Pure bounded trigger proposal. At most one latest nominal slot; never a run,
 * grant, permit, queue write, or approval. Persistence must atomically CAS cursor,
 * reread grant/current authority, create EMDO lineage + unique occurrence + outbox.
 * Calendar skip slots are consumed without substituting an older occurrence.
 */
export function planFinanceAutomationDue(
  raw: unknown,
):
  | FinanceAutomationDuePlan
  | { status: 'invalid'; executionAuthority: 'none'; reason: string } {
  const parsed = boundedFinanceParse(FinanceAutomationDuePlanInputSchema, raw);
  if (!parsed.success)
    return {
      status: 'invalid',
      executionAuthority: 'none',
      reason: 'invalid-input',
    };
  const { schedule, cursor, now, blockingRunCount, runtimeTimezoneVersion } =
      parsed.data,
    d = schedule.definition,
    c = d.cadence;
  const base: FinanceAutomationDuePlan = {
    status: 'not-due',
    executionAuthority: 'none',
    reason: null,
    expectedStateRevision: schedule.stateRevision,
    nextDueAt: null,
    nextCursor: { ...cursor },
    occurrence: null,
    evaluatedSlot: null,
    consumedRange: null,
  };
  const finish = (changes: Partial<FinanceAutomationDuePlan>) => {
    const result = { ...base, ...changes };
    if (
      !['blocked', 'paused', 'retired', 'exhausted'].includes(result.status)
    ) {
      try {
        const pending = slotAt(
          c,
          Date.parse(d.startAt),
          result.nextCursor.nextOrdinal,
        );
        const next = Math.max(Date.parse(d.startAt), pending.dueAt);
        if (d.endAt === null || next < Date.parse(d.endAt))
          result.nextDueAt = iso(next);
      } catch {
        return deepFreeze({
          ...result,
          status: 'blocked' as const,
          reason: 'calendar-resolution-failed',
          occurrence: null,
          consumedRange: null,
          nextCursor: { ...cursor },
        });
      }
    }
    return deepFreeze(result);
  };
  if (
    cursor.scheduleId !== schedule.id ||
    cursor.definitionRevision !== schedule.definitionRevision
  )
    return finish({ status: 'blocked', reason: 'cursor-definition-mismatch' });
  if (schedule.status !== 'active') return finish({ status: schedule.status });
  if (c.kind !== 'interval' && c.tzdbVersion !== runtimeTimezoneVersion)
    return finish({
      status: 'blocked',
      reason: 'timezone-rules-review-required',
    });
  if (c.kind === 'weekly' && plainDate(c.anchorDate).weekday !== c.weekday)
    return finish({
      status: 'blocked',
      reason: 'weekly-anchor-weekday-mismatch',
    });
  const start = Date.parse(d.startAt),
    time = Date.parse(now),
    end = d.endAt === null ? Infinity : Date.parse(d.endAt);
  if (time < start) return finish({});
  if (time >= end)
    return finish({ status: 'exhausted', reason: 'schedule-ended' });
  try {
    let ordinal = latestOrdinal(c, start, Math.min(time, end - 1));
    if (ordinal < 0)
      return finish({ status: time >= end ? 'exhausted' : 'not-due' });
    let slot = slotAt(c, start, ordinal);
    // Local period estimate can include a not-yet-due wall time. No unbounded scan.
    for (
      let adjustments = 0;
      slot.dueAt > Math.min(time, end - 1) && ordinal >= 0 && adjustments < 3;
      adjustments++
    ) {
      ordinal--;
      if (ordinal >= 0) slot = slotAt(c, start, ordinal);
    }
    if (ordinal < cursor.nextOrdinal || ordinal < 0)
      return finish({ status: time >= end ? 'exhausted' : 'not-due' });
    if (slot.dueAt > Math.min(time, end - 1))
      return finish({ status: 'blocked', reason: 'calendar-resolution-bound' });
    if (ordinal >= 1_000_000_000)
      return finish({ status: 'blocked', reason: 'ordinal-limit' });
    const max = c.kind === 'interval' ? null : c.tzdbVersion;
    const lateness =
      d.misfire.policy === 'skip'
        ? d.misfire.graceSeconds
        : d.misfire.maxLatenessSeconds;
    const eligible =
      slot.scheduledAt !== null &&
      slot.scheduledAt >= start &&
      time - slot.scheduledAt <= lateness * 1000;
    if (
      eligible &&
      blockingRunCount >=
        (d.concurrency.policy === 'forbid' ? 1 : d.concurrency.maxInFlight)
    )
      return finish({ status: 'deferred', reason: 'concurrency-limit' });
    const occurrence = eligible
      ? {
          id: `finance-schedule:${schedule.id}:${schedule.definitionRevision}:${ordinal}`,
          ordinal,
          scheduledAt: iso(slot.scheduledAt!),
          intendedLocal: slot.intendedLocal,
          resolvedLocal: slot.resolvedLocal,
          offsetMinutes: slot.offsetMinutes,
          adjustment: slot.adjustment,
          adjustments: slot.adjustments,
          timezoneEngine: 'luxon-3.7.2' as const,
          tzdbVersion: max,
        }
      : null;
    return finish({
      status: occurrence ? 'due' : 'skipped',
      evaluatedSlot: {
        ordinal,
        dueAt: iso(slot.dueAt),
        intendedLocal: slot.intendedLocal,
        resolvedLocal: slot.resolvedLocal,
        adjustments: slot.adjustments,
      },
      reason: occurrence
        ? null
        : slot.scheduledAt === null
          ? slot.adjustment
          : slot.dueAt < start
            ? 'before-start'
            : 'misfire-expired',
      nextCursor: { ...cursor, nextOrdinal: ordinal + 1 },
      occurrence,
      consumedRange: {
        firstOrdinal: cursor.nextOrdinal,
        lastOrdinal: ordinal,
        count: ordinal - cursor.nextOrdinal + 1,
        disposition:
          occurrence && d.misfire.policy === 'coalesce-latest'
            ? 'prior-slots-coalesced'
            : 'prior-slots-skipped',
        triggeredOrdinal: occurrence ? ordinal : null,
      },
    });
  } catch {
    return finish({ status: 'blocked', reason: 'calendar-resolution-failed' });
  }
}

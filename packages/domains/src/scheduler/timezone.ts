import { deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

import { SchedulerDomainError } from './errors.js';
import { boundedSafeParse } from './validation.js';

export const TORONTO_TIME_ZONE = 'America/Toronto' as const;

const LOCAL_DATE_TIME =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})$/;

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TORONTO_TIME_ZONE,
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const parseLocalParts = (input: string): LocalParts => {
  if (typeof input !== 'string') {
    throw new SchedulerDomainError(
      'invalid-local-time',
      'Expected a minute-precision local date and time.',
    );
  }
  const match = LOCAL_DATE_TIME.exec(input);
  if (match?.groups === undefined) {
    throw new SchedulerDomainError(
      'invalid-local-time',
      'Expected a minute-precision local date and time.',
    );
  }
  const parts = {
    year: Number(match.groups.year),
    month: Number(match.groups.month),
    day: Number(match.groups.day),
    hour: Number(match.groups.hour),
    minute: Number(match.groups.minute),
  };
  const normalized = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute),
  );
  if (
    normalized.getUTCFullYear() !== parts.year ||
    normalized.getUTCMonth() + 1 !== parts.month ||
    normalized.getUTCDate() !== parts.day ||
    normalized.getUTCHours() !== parts.hour ||
    normalized.getUTCMinutes() !== parts.minute
  ) {
    throw new SchedulerDomainError(
      'invalid-local-time',
      'The local date and time is not valid.',
    );
  }
  return parts;
};

const localPartsAt = (instantMs: number): LocalParts => {
  const values = new Map(
    formatter
      .formatToParts(new Date(instantMs))
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
  };
};

const sameParts = (left: LocalParts, right: LocalParts): boolean =>
  left.year === right.year &&
  left.month === right.month &&
  left.day === right.day &&
  left.hour === right.hour &&
  left.minute === right.minute;

export type TorontoTimeDisambiguation = 'reject' | 'earlier' | 'later';

export interface ResolvedTorontoDateTime {
  readonly instant: string;
  readonly localDateTime: string;
  readonly offsetMinutes: number;
}

/**
 * Resolves a Toronto wall time without relying on the host timezone. A bounded
 * offset search detects both DST gaps and overlaps and rejects either by
 * default.
 */
export const resolveTorontoLocalDateTime = (
  localDateTime: string,
  disambiguation: TorontoTimeDisambiguation = 'reject',
): ResolvedTorontoDateTime => {
  if (!['reject', 'earlier', 'later'].includes(disambiguation)) {
    throw new SchedulerDomainError(
      'invalid-local-time',
      'The Toronto time disambiguation policy is invalid.',
    );
  }
  const parts = parseLocalParts(localDateTime);
  const naiveMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
  const candidates: number[] = [];

  // Covers every civil offset while retaining quarter-hour zones; Toronto is
  // currently either UTC-05:00 or UTC-04:00.
  for (let offsetMinutes = -900; offsetMinutes <= 900; offsetMinutes += 15) {
    const candidate = naiveMs - offsetMinutes * 60_000;
    if (sameParts(localPartsAt(candidate), parts)) candidates.push(candidate);
  }
  candidates.sort((left, right) => left - right);

  if (candidates.length === 0) {
    throw new SchedulerDomainError(
      'nonexistent-local-time',
      'The Toronto wall time does not exist because of a clock change.',
    );
  }
  if (candidates.length > 1 && disambiguation === 'reject') {
    throw new SchedulerDomainError(
      'ambiguous-local-time',
      'The Toronto wall time occurs twice because of a clock change.',
    );
  }
  const instantMs =
    disambiguation === 'later' ? candidates.at(-1)! : candidates[0]!;

  return deepFreeze({
    instant: new Date(instantMs).toISOString(),
    localDateTime,
    offsetMinutes: (naiveMs - instantMs) / 60_000,
  });
};

export const formatTorontoInstant = (
  instant: string,
): ResolvedTorontoDateTime => {
  const parsed = z.iso.datetime({ offset: true }).safeParse(instant);
  if (!parsed.success) {
    throw new SchedulerDomainError(
      'invalid-local-time',
      'Expected an ISO instant with an explicit offset.',
    );
  }
  const instantMs = Date.parse(parsed.data);
  const parts = localPartsAt(instantMs);
  const localDateTime = formatLocal(parts);
  const naiveMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
  return deepFreeze({
    instant: new Date(instantMs).toISOString(),
    localDateTime,
    offsetMinutes: (naiveMs - instantMs) / 60_000,
  });
};

const WeekdaySchema = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
const RecurrenceInputSchema = z.strictObject({
  startLocalDateTime: z.string().regex(LOCAL_DATE_TIME),
  durationMinutes: z.number().int().safe().min(1).max(10_080),
  rule: z.strictObject({
    frequency: z.enum(['daily', 'weekly']),
    interval: z.number().int().safe().min(1).max(52),
    count: z.number().int().safe().min(1).max(366),
    byWeekday: z.array(WeekdaySchema).min(1).max(7).optional(),
  }),
  rangeStart: z.iso.datetime({ offset: true }),
  rangeEnd: z.iso.datetime({ offset: true }),
  disambiguation: z.enum(['reject', 'earlier', 'later']).default('reject'),
});

export interface TorontoOccurrence {
  readonly localStart: string;
  readonly start: string;
  readonly end: string;
  readonly offsetMinutes: number;
}

const weekdayByUtcDay = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const weekdayOrder = new Map([
  ['MO', 0],
  ['TU', 1],
  ['WE', 2],
  ['TH', 3],
  ['FR', 4],
  ['SA', 5],
  ['SU', 6],
]);

const addLocalDays = (parts: LocalParts, days: number): LocalParts => {
  const value = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day + days,
      parts.hour,
      parts.minute,
    ),
  );
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
    hour: value.getUTCHours(),
    minute: value.getUTCMinutes(),
  };
};

const pad = (value: number): string => String(value).padStart(2, '0');
const formatLocal = (parts: LocalParts): string =>
  `${String(parts.year).padStart(4, '0')}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;

export const expandTorontoRecurrence = (
  input: unknown,
): readonly TorontoOccurrence[] => {
  const parsed = boundedSafeParse(RecurrenceInputSchema, input);
  if (!parsed.success) {
    throw new SchedulerDomainError(
      'recurrence-out-of-bounds',
      'The recurrence request is invalid or exceeds its execution bounds.',
    );
  }
  const request = parsed.data;
  const rangeStartMs = Date.parse(request.rangeStart);
  const rangeEndMs = Date.parse(request.rangeEnd);
  if (
    rangeEndMs <= rangeStartMs ||
    rangeEndMs - rangeStartMs > 10 * 366 * 86_400_000
  ) {
    throw new SchedulerDomainError(
      'recurrence-out-of-bounds',
      'The recurrence range must be positive and no longer than ten years.',
    );
  }
  if (
    request.rule.frequency === 'daily' &&
    request.rule.byWeekday !== undefined
  ) {
    throw new SchedulerDomainError(
      'recurrence-out-of-bounds',
      'Weekday selection is supported only for weekly recurrences.',
    );
  }

  const startParts = parseLocalParts(request.startLocalDateTime);
  const selectedWeekdays = new Set(
    request.rule.byWeekday ?? [
      weekdayByUtcDay[
        new Date(
          Date.UTC(startParts.year, startParts.month - 1, startParts.day),
        ).getUTCDay()
      ]!,
    ],
  );
  const startWeekday = weekdayOrder.get(
    weekdayByUtcDay[
      new Date(
        Date.UTC(startParts.year, startParts.month - 1, startParts.day),
      ).getUTCDay()
    ]!,
  )!;
  const results: TorontoOccurrence[] = [];
  let generated = 0;
  let scannedDays = 0;

  while (generated < request.rule.count) {
    if (scannedDays > 140_000) {
      throw new SchedulerDomainError(
        'recurrence-out-of-bounds',
        'The recurrence expansion exceeded its deterministic scan bound.',
      );
    }
    const candidateParts =
      request.rule.frequency === 'daily'
        ? addLocalDays(startParts, generated * request.rule.interval)
        : addLocalDays(startParts, scannedDays);
    let include = request.rule.frequency === 'daily';
    if (request.rule.frequency === 'weekly') {
      const weekday =
        weekdayByUtcDay[
          new Date(
            Date.UTC(
              candidateParts.year,
              candidateParts.month - 1,
              candidateParts.day,
            ),
          ).getUTCDay()
        ]!;
      const weekIndex = Math.floor((scannedDays + startWeekday) / 7);
      include =
        weekIndex % request.rule.interval === 0 &&
        selectedWeekdays.has(weekday);
      scannedDays += 1;
    }
    if (!include) continue;

    generated += 1;
    const localStart = formatLocal(candidateParts);
    const resolved = resolveTorontoLocalDateTime(
      localStart,
      request.disambiguation,
    );
    const startMs = Date.parse(resolved.instant);
    const endMs = startMs + request.durationMinutes * 60_000;
    if (startMs < rangeEndMs && endMs > rangeStartMs) {
      results.push(
        deepFreeze({
          localStart,
          start: resolved.instant,
          end: new Date(endMs).toISOString(),
          offsetMinutes: resolved.offsetMinutes,
        }),
      );
    }
  }

  return deepFreeze(results);
};

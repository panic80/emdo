import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import type { SchedulePage } from '@emdo/contracts/browser';

import { Button } from '../components/button.js';
import { Page, PageHeader } from '../components/page.js';
import { AskComposer } from '../features/chat/ask-composer.js';
import { useConversation } from '../features/chat/conversation.js';
import { useDomainData } from '../features/domains/domain-data.js';
import { DomainSyncStatus } from '../features/domains/domain-status.js';
import { useExperienceApi } from '../features/experience/experience-api.js';

const TORONTO_TIMEZONE = 'America/Toronto';
const DAY_MS = 86_400_000;

const CanonicalSchedulerStateSchema = z.strictObject({
  id: z.string().trim().min(1).max(512),
  title: z.string().trim().min(1).max(500),
  notes: z.string().trim().max(10_000).nullable(),
  location: z.string().trim().max(1_000).nullable(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  recurrence: z.string().trim().min(1).max(2_000).nullable(),
  attendees: z.array(z.string().trim().min(1).max(512)).max(512),
  completion: z.enum(['open', 'completed', 'skipped']),
});

const dateInToronto = (date: Date): string => {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      day: '2-digit',
      month: '2-digit',
      timeZone: TORONTO_TIMEZONE,
      year: 'numeric',
    })
      .formatToParts(date)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value]),
  );
  if (!values.year || !values.month || !values.day)
    throw new Error('Toronto date is unavailable');
  return `${values.year}-${values.month}-${values.day}`;
};

const formatTime = (value: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: TORONTO_TIMEZONE,
  }).format(new Date(value));

const canonicalCompletion = (
  value: SchedulePage['items']['items'][number]['completion'],
) =>
  value === 'completed'
    ? 'completed'
    : value === 'cancelled'
      ? 'skipped'
      : 'open';

export function ScheduleRoute() {
  const api = useExperienceApi();
  const conversation = useConversation();
  const domain = useDomainData();
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const [page, setPage] = useState<SchedulePage>();
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>(
    'loading',
  );
  const [notice, setNotice] = useState<string>();

  const from = dateInToronto(new Date());
  const to = dateInToronto(new Date(Date.now() + 7 * DAY_MS));

  const load = (cursor?: string) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState('loading');
    void api
      .listSchedule(
        { from, to, ...(cursor ? { cursor } : {}), limit: 25 },
        { signal: controller.signal },
      )
      .then(
        (next) => {
          if (controller.signal.aborted) return;
          setPage((current) =>
            cursor && current
              ? {
                  ...next,
                  items:
                    next.items.status === 'available' &&
                    current.items.status === 'available'
                      ? {
                          status: 'available',
                          items: [...current.items.items, ...next.items.items],
                        }
                      : next.items,
                }
              : next,
          );
          setState('ready');
        },
        () => {
          if (!controller.signal.aborted) setState('unavailable');
        },
      );
  };

  useEffect(() => {
    load();
    return () => controllerRef.current?.abort();
  }, [api]);

  const saveOffline = async (item: SchedulePage['items']['items'][number]) => {
    if (!item.endsAt) {
      setNotice(
        'This schedule item has no end time, so no local copy was saved.',
      );
      return;
    }
    const existing = domain.records.find(
      (record) =>
        record.entityType === 'scheduler.item' &&
        record.id === item.id &&
        !record.tombstoned,
    );
    const base = CanonicalSchedulerStateSchema.safeParse(existing?.value);
    const local = CanonicalSchedulerStateSchema.parse({
      ...(base.success
        ? base.data
        : {
            id: item.id,
            notes: null,
            location: null,
            recurrence: null,
            attendees: [],
          }),
      id: item.id,
      title: item.title,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      completion: canonicalCompletion(item.completion),
    });
    setNotice(undefined);
    try {
      await domain.applyMutation({
        domain: 'scheduler',
        entityType: 'scheduler.item',
        entityId: item.id,
        kind: base.success ? 'update' : 'create',
        data: base.success ? { base: base.data, local } : local,
        actorIntent: 'Save this schedule item to encrypted offline data',
      });
      setNotice(
        'Schedule item saved locally. Google Calendar was not changed.',
      );
    } catch {
      setNotice(
        'Encrypted offline editing is unavailable. Nothing was changed.',
      );
    }
  };

  return (
    <Page>
      <PageHeader
        title="Schedule"
        description="Toronto time · Calendar writes always require visual approval."
      />
      <AskComposer
        compact
        onSubmit={async (message) => {
          await conversation.submit(message, 'scheduler');
        }}
      />
      <DomainSyncStatus />
      <section
        className="open-section"
        aria-labelledby="schedule-items-heading"
      >
        <div className="section-title-row">
          <h2 id="schedule-items-heading">Upcoming schedule</h2>
          <span>{page ? `${page.from}–${page.to}` : 'Toronto time'}</span>
        </div>
        {state === 'loading' && !page ? (
          <p role="status">Loading schedule…</p>
        ) : null}
        {state === 'unavailable' ? (
          <p role="status">Schedule is unavailable.</p>
        ) : null}
        {page?.items.status === 'unavailable' ? (
          <p>Schedule items are unavailable.</p>
        ) : null}
        {page?.items.status === 'available' && page.items.items.length === 0 ? (
          <p>No schedule items in this range.</p>
        ) : null}
        {page?.items.status === 'available' ? (
          <ol className="agenda-list">
            {page.items.items.map((item) => (
              <li key={item.id}>
                <time dateTime={item.startsAt}>
                  {formatTime(item.startsAt)}
                </time>
                <div>
                  <strong>{item.title}</strong>
                  <span>
                    {item.endsAt ? `Ends ${formatTime(item.endsAt)} · ` : ''}
                    {item.completion}
                  </span>
                </div>
                <Button
                  disabled={!item.endsAt}
                  variant="quiet"
                  onClick={() => void saveOffline(item)}
                >
                  Save offline copy of {item.title}
                </Button>
              </li>
            ))}
          </ol>
        ) : null}
        {page?.nextCursor ? (
          <Button
            busy={state === 'loading'}
            onClick={() => load(page.nextCursor)}
          >
            Load more
          </Button>
        ) : null}
        {notice ? (
          <p className="inline-notice" role="status">
            {notice}
          </p>
        ) : null}
      </section>
      <section
        className="open-section"
        aria-labelledby="calendar-state-heading"
      >
        <h2 id="calendar-state-heading">Calendar connection</h2>
        <p>{page ? page.calendar.status : 'Unavailable'}</p>
      </section>
    </Page>
  );
}

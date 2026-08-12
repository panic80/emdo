import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import type { TodayView } from '@emdo/contracts/browser';

import { Icon } from '../components/icon.js';
import { AskComposer } from '../features/chat/ask-composer.js';
import { useConversation } from '../features/chat/conversation.js';
import { useExperienceApi } from '../features/experience/experience-api.js';

const TORONTO_TIMEZONE = 'America/Toronto';

const torontoDate = (value = new Date()): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: TORONTO_TIMEZONE,
    year: 'numeric',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw new Error('Toronto date is unavailable');
  return `${year}-${month}-${day}`;
};

const formatDate = (value: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'full',
    timeZone: TORONTO_TIMEZONE,
  }).format(new Date(`${value}T12:00:00.000Z`));

const formatTime = (value: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TORONTO_TIMEZONE,
  }).format(new Date(value));

function TodayTimeline({ view }: { readonly view: TodayView }) {
  return (
    <section className="today-timeline" aria-label="Day timeline">
      <div className="timeline-track">
        {view.schedule.status === 'unavailable' ? (
          <p>Schedule is unavailable.</p>
        ) : view.schedule.items.length === 0 ? (
          <p>No schedule items for today.</p>
        ) : (
          view.schedule.items.map((item) => (
            <article className="timeline-event" key={item.id}>
              <Icon name="calendar" size={21} />
              <div>
                <strong>{item.title}</strong>
                <span>
                  {formatTime(item.startsAt)}
                  {item.endsAt ? `–${formatTime(item.endsAt)}` : ''}
                </span>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function DomainSummaries({ view }: { readonly view: TodayView }) {
  return (
    <section className="domain-summaries" aria-label="Household overview">
      <article className="domain-summary">
        <h2>
          <Icon name="check" /> Reminders
        </h2>
        {view.reminders.status === 'unavailable' ? (
          <p>Reminders are unavailable.</p>
        ) : view.reminders.items.length === 0 ? (
          <p>No reminders for today.</p>
        ) : (
          <ul>
            {view.reminders.items.map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong>{' '}
                <span>{formatTime(item.dueAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </article>

      <article className="domain-summary">
        <h2>
          <Icon name="finance" /> Finance
        </h2>
        {view.finance.status === 'unavailable' ? (
          <p>Finance summary is unavailable.</p>
        ) : (
          <p>
            {view.finance.budgetCount} budgets · {view.finance.transactionCount}{' '}
            transactions
          </p>
        )}
        <Link className="text-link" to="/finance">
          View finance <Icon name="chevron-right" size={18} />
        </Link>
      </article>

      <article className="domain-summary">
        <h2>
          <Icon name="shopping" /> Shopping
        </h2>
        {view.shopping.status === 'unavailable' ? (
          <p>Shopping summary is unavailable.</p>
        ) : (
          <p>
            {view.shopping.itemCount} items across {view.shopping.retailerCount}{' '}
            retailers
          </p>
        )}
        <Link className="text-link" to="/shopping">
          View shopping list <Icon name="chevron-right" size={18} />
        </Link>
      </article>
    </section>
  );
}

function Notifications({ view }: { readonly view: TodayView }) {
  return (
    <aside className="coming-up" aria-labelledby="today-notifications-heading">
      <h2 id="today-notifications-heading">Notifications</h2>
      {view.notifications.status === 'unavailable' ? (
        <p>Notifications are unavailable.</p>
      ) : view.notifications.items.length === 0 ? (
        <p>No new notifications.</p>
      ) : (
        view.notifications.items.map((item) => (
          <article key={item.id}>
            <Icon name="check" />
            <div>
              <strong>{item.title}</strong>
              <span>{formatTime(item.createdAt)}</span>
            </div>
          </article>
        ))
      )}
    </aside>
  );
}

export function TodayRoute() {
  const api = useExperienceApi();
  const conversation = useConversation();
  const navigate = useNavigate();
  const [view, setView] = useState<TodayView>();
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setUnavailable(false);
    void api
      .readToday({ date: torontoDate() }, { signal: controller.signal })
      .then(setView, () => {
        if (!controller.signal.aborted) setUnavailable(true);
      });
    return () => controller.abort();
  }, [api]);

  return (
    <main className="today-page">
      <div className="today-page__main">
        <header className="today-heading">
          <h1>Good morning</h1>
          <p>{view ? formatDate(view.date) : 'Toronto time'}</p>
        </header>
        <AskComposer
          onSubmit={async (message) => {
            await navigate({ to: '/ask' });
            await conversation.submit(message);
          }}
        />
        {unavailable ? (
          <p className="inline-error" role="status">
            Today data is unavailable.
          </p>
        ) : view ? (
          <>
            <TodayTimeline view={view} />
            <DomainSummaries view={view} />
          </>
        ) : (
          <p role="status">Loading today…</p>
        )}
      </div>
      {view ? <Notifications view={view} /> : null}
    </main>
  );
}

import { useEffect, useRef, useState } from 'react';

import type { ActivityPage } from '@emdo/contracts/browser';

import { Button } from '../components/button.js';
import { Icon } from '../components/icon.js';
import { Page, PageHeader } from '../components/page.js';
import { useExperienceApi } from '../features/experience/experience-api.js';

const formatOccurredAt = (value: string) =>
  new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Toronto',
  }).format(new Date(value));

export function ActivityRoute() {
  const api = useExperienceApi();
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const [items, setItems] = useState<ActivityPage['items']>([]);
  const [cursor, setCursor] = useState<string>();
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>(
    'loading',
  );

  const load = (nextCursor?: string) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState('loading');
    void api
      .listActivity(
        { ...(nextCursor ? { cursor: nextCursor } : {}), limit: 25 },
        { signal: controller.signal },
      )
      .then(
        (page) => {
          if (controller.signal.aborted) return;
          setItems((current) =>
            nextCursor === undefined ? page.items : [...current, ...page.items],
          );
          setCursor(page.nextCursor);
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

  return (
    <Page>
      <PageHeader
        title="Activity"
        description="Bounded household receipts and outcomes. Sensitive payloads are not shown."
      />
      <section className="activity-list" aria-label="Recent activity">
        {items.map((item) => (
          <article key={item.id}>
            <span className="activity-list__marker">
              <Icon name="check" size={16} />
            </span>
            <time dateTime={item.occurredAt}>
              {formatOccurredAt(item.occurredAt)}
            </time>
            <div>
              <h2>{item.title}</h2>
              <p>
                {item.category}
                {item.status ? ` · ${item.status}` : ''}
              </p>
            </div>
          </article>
        ))}
        {state === 'loading' && items.length === 0 ? (
          <p role="status">Loading activity…</p>
        ) : null}
        {state === 'unavailable' ? (
          <p className="inline-error" role="status">
            Activity is unavailable.
          </p>
        ) : null}
        {state === 'ready' && items.length === 0 ? (
          <p>No activity has been recorded yet.</p>
        ) : null}
      </section>
      {cursor ? (
        <Button busy={state === 'loading'} onClick={() => load(cursor)}>
          Load more
        </Button>
      ) : null}
    </Page>
  );
}

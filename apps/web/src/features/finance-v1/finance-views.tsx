import { useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import type { FinanceLocale } from './finance-document-api.js';
import { financeCopy, type FinanceViewId } from './finance-locales.js';

const viewIds: readonly FinanceViewId[] = [
  'overview',
  'activity',
  'documents',
  'planning',
];

export function FinanceViews({
  locale,
  ask,
  overview,
  activity,
  documents,
  planning,
}: {
  readonly locale: FinanceLocale;
  readonly ask: ReactNode;
  readonly overview: ReactNode;
  readonly activity: ReactNode;
  readonly documents: ReactNode;
  readonly planning: ReactNode;
}) {
  const [activeView, setActiveView] = useState<FinanceViewId>('overview');
  const copy = financeCopy[locale];
  const panels: Record<FinanceViewId, ReactNode> = {
    overview,
    activity,
    documents,
    planning,
  };
  const moveTabFocus = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % viewIds.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + viewIds.length) % viewIds.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = viewIds.length - 1;
    }
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextView = viewIds[nextIndex];
    const nextTab =
      event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
        '[role="tab"]',
      )[nextIndex];
    if (nextView !== undefined && nextTab !== undefined) {
      setActiveView(nextView);
      nextTab.focus();
    }
  };
  return (
    <>
      <div
        className="finance-view-tabs"
        aria-label={copy.viewsAriaLabel}
        role="tablist"
      >
        {viewIds.map((view, index) => (
          <button
            key={view}
            aria-controls={`finance-${view}-panel`}
            aria-selected={activeView === view}
            id={`finance-${view}-tab`}
            role="tab"
            tabIndex={activeView === view ? 0 : -1}
            type="button"
            onClick={() => setActiveView(view)}
            onKeyDown={(event) => moveTabFocus(event, index)}
          >
            {copy.views[view]}
          </button>
        ))}
      </div>
      {ask}
      <section
        aria-labelledby={`finance-${activeView}-tab`}
        id={`finance-${activeView}-panel`}
        role="tabpanel"
      >
        {panels[activeView]}
      </section>
    </>
  );
}

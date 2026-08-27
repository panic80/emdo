import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { FinanceLocale } from './finance-document-api.js';
import { financeCopy } from './finance-locales.js';
import { FinanceViews } from './finance-views.js';

const locales: readonly FinanceLocale[] = ['en-CA', 'fr-CA', 'ja-JP', 'ko-KR'];

describe('FinanceViews', () => {
  it.each(locales)(
    'localizes every tab and its accessible tab-list name for %s',
    (locale) => {
      const copy = financeCopy[locale];
      render(
        <FinanceViews
          locale={locale}
          ask={<p>Ask EMDO</p>}
          overview={<p>Overview panel</p>}
          activity={<p>Activity panel</p>}
          documents={<p>Documents panel</p>}
          planning={<p>Planning panel</p>}
        />,
      );

      const tabList = screen.getByRole('tablist', {
        name: copy.viewsAriaLabel,
      });
      expect(tabList.classList.contains('finance-view-tabs')).toBe(true);
      for (const label of Object.values(copy.views)) {
        expect(screen.getByRole('tab', { name: label })).toBeVisible();
      }
      expect(screen.getByText('Ask EMDO')).toBeVisible();
    },
  );

  it('keeps the selected panel connected to its localized tab and allows wrapped controls', async () => {
    const user = userEvent.setup();
    const copy = financeCopy['fr-CA'];
    render(
      <FinanceViews
        locale="fr-CA"
        ask={<p>Ask EMDO</p>}
        overview={<p>Overview panel</p>}
        activity={<p>Activity panel</p>}
        documents={<p>Documents panel</p>}
        planning={<p>Planning panel</p>}
      />,
    );

    await user.click(screen.getByRole('tab', { name: copy.views.planning }));
    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      'finance-planning-tab',
    );
    expect(
      screen.getByRole('tab', { name: copy.views.planning }),
    ).toHaveAttribute('aria-selected', 'true');
  });

  it('supports roving arrow, Home, and End keyboard focus', async () => {
    const user = userEvent.setup();
    const copy = financeCopy['en-CA'];
    render(
      <FinanceViews
        locale="en-CA"
        ask={<p>Ask EMDO</p>}
        overview={<p>Overview panel</p>}
        activity={<p>Activity panel</p>}
        documents={<p>Documents panel</p>}
        planning={<p>Planning panel</p>}
      />,
    );

    const overview = screen.getByRole('tab', { name: copy.views.overview });
    const activity = screen.getByRole('tab', { name: copy.views.activity });
    const planning = screen.getByRole('tab', { name: copy.views.planning });
    overview.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(activity);
    expect(activity).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(planning);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(overview);
  });
});

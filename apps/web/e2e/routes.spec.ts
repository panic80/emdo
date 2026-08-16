import { expect, test } from '@playwright/test';

import {
  expectNoSeriousAccessibilityViolations,
  mockAuthenticatedSession,
} from './support.js';

const routes = [
  ['/today', 'Good morning'],
  ['/ask', 'Ask EMDO'],
  ['/schedule', 'Schedule'],
  ['/finance', 'Finance'],
  ['/shopping', 'Shopping'],
  ['/approvals', 'Pending approvals'],
  ['/activity', 'Activity'],
  ['/settings', 'Settings'],
] as const;

test.describe('key route accessibility', () => {
  test.beforeEach(async ({ page }) => mockAuthenticatedSession(page));

  for (const [path, heading] of routes) {
    test(`${path} has a named heading and no serious WCAG violations`, async ({
      page,
    }) => {
      await page.goto(path);
      await expect(
        page.getByRole('heading', { name: heading, exact: true }),
      ).toBeVisible();
      await expectNoSeriousAccessibilityViolations(page);
    });
  }

  test('supports keyboard navigation through the visible skip link and named routes', async ({
    page,
  }) => {
    await page.goto('/today');
    await expect(
      page.getByRole('heading', { name: 'Good morning' }),
    ).toBeVisible();
    await page.keyboard.press('Tab');
    const skipLink = page.getByRole('link', { name: 'Skip to content' });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();

    const schedule = page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Schedule' });
    for (let index = 0; index < 40; index += 1) {
      await page.keyboard.press('Tab');
      if (
        await schedule.evaluate((element) => element === document.activeElement)
      )
        break;
    }
    await expect(schedule).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/schedule$/u);
    await expect(
      page.getByRole('heading', { name: 'Schedule', exact: true }),
    ).toBeVisible();
  });
});

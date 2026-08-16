import { expect, test } from '@playwright/test';

import {
  expectNoSeriousAccessibilityViolations,
  mockAuthenticatedSession,
} from './support.js';

test.describe('EMDO accepted responsive shell', () => {
  test.beforeEach(async ({ page }) => mockAuthenticatedSession(page));

  test('renders the desktop Today concept without runtime errors', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1586, height: 992 });
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => runtimeErrors.push(error.message));

    await page.goto('/today');

    await expect(
      page.getByRole('heading', { name: 'Good morning' }),
    ).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Primary' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Notifications' }),
    ).toBeVisible();
    await expect(page.getByText('Today data is unavailable.')).toBeVisible();
    await expect(page.getByText('Offline-ready · Sync starting')).toBeVisible();
    await expect(page.getByText(/synced just now/iu)).toHaveCount(0);
    expect(runtimeErrors).toEqual([]);

    await expectNoSeriousAccessibilityViolations(page);
  });
});

import { expect, test } from '@playwright/test';
import {
  mockAuthenticatedSession,
  expectNoSeriousAccessibilityViolations,
} from './support.js';

test('workspace chrome stays accessible across desktop and mobile', async ({
  page,
}) => {
  await mockAuthenticatedSession(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/today');
  await expect(
    page.getByRole('heading', { name: 'Good morning' }),
  ).toBeVisible();
  await expect(page.getByText('Today data is unavailable.')).toBeVisible();
  await page.screenshot({
    path: '/tmp/emdo-shell-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await expectNoSeriousAccessibilityViolations(page);
  await page.getByRole('button', { name: 'Open account settings' }).click();
  await expect(page).toHaveURL(/\/settings$/u);
  await page
    .getByRole('button', { name: 'Notifications', exact: true })
    .click();
  await expect(page).toHaveURL(/\/activity$/u);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/today');
  await expect(
    page.getByRole('heading', { name: 'Good morning' }),
  ).toBeVisible();
  await page.screenshot({ path: '/tmp/emdo-shell-mobile.png', fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const close = page.getByRole('button', { name: 'Close menu' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    page.getByRole('dialog').getByRole('link', { name: 'Settings' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.screenshot({
    path: '/tmp/emdo-shell-mobile-menu.png',
    fullPage: true,
    animations: 'disabled',
  });
  await expectNoSeriousAccessibilityViolations(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'More', exact: true }),
  ).toBeFocused();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await page
      .locator('.today-page')
      .evaluate((el) => getComputedStyle(el).animationDuration),
  ).toBe('1e-05s');
  expect(errors).toEqual([]);
});

test('Finance workspace preserves book context and clear populated, empty, and unavailable states', async ({
  page,
}) => {
  await mockAuthenticatedSession(page);
  const id = '00000000-0000-4000-8000-000000000001';
  const secondId = '00000000-0000-4000-8000-000000000002';
  let state: 'populated' | 'empty' | 'unavailable' = 'populated';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/experience/finance*', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).search
        ? { schemaVersion: 1, items: [] }
        : {
            schemaVersion: 1,
            locale: 'en-CA',
            connectivity: 'online',
            quota: {
              documentsUsed: 0,
              documentsLimit: 100,
              bytesUsed: 0,
              bytesLimit: 1000000,
            },
            reviewedCadTotals: [],
            recentActivity: [],
            budgets: [],
          },
    }),
  );
  await page.route('**/api/v2/finance/books**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (state === 'unavailable')
      return route.fulfill({ status: 503, json: {} });
    if (path.endsWith('/automations/grants'))
      return route.fulfill({ json: { grants: [] } });
    if (path.endsWith('/books'))
      return route.fulfill({
        json: {
          books:
            state === 'empty'
              ? []
              : [
                  {
                    id,
                    name: 'Operations',
                    entityName: 'Example',
                    country: 'CA',
                    functionalCurrency: 'CAD',
                    role: 'administrator',
                  },
                  {
                    id: secondId,
                    name: 'Personal',
                    entityName: 'Member',
                    country: 'CA',
                    functionalCurrency: 'CAD',
                    role: 'administrator',
                  },
                ],
        },
      });
    return route.fulfill({
      json: {
        trialBalance: [
          {
            id,
            code: '1000',
            name: 'Cash',
            kind: 'asset',
            debit: '0',
            credit: '0',
            balance: '0',
          },
          {
            id: secondId,
            code: '1100',
            name: 'Receivables',
            kind: 'asset',
            debit: '0',
            credit: '0',
            balance: '0',
          },
          {
            id: '00000000-0000-4000-8000-000000000003',
            code: '4000',
            name: 'Sales',
            kind: 'income',
            debit: '0',
            credit: '0',
            balance: '0',
          },
        ],
        periods: [
          { id, startsOn: '2026-01-01', endsOn: '2026-12-31', status: 'open' },
        ],
        journals: [],
      },
    });
  });
  await page.setViewportSize({ width: 1505, height: 1045 });
  await page.goto('/finance');
  await expect(page).toHaveTitle(/EMDO/u);
  await expect(
    page.getByRole('heading', { name: 'Your book at a glance' }),
  ).toBeVisible();
  await expect(page.getByRole('tabpanel')).toContainText(
    'Based on posted records in Operations.',
  );
  await page.screenshot({
    path: '/tmp/emdo-finance-astra-desktop.png',
    animations: 'disabled',
  });
  await expectNoSeriousAccessibilityViolations(page);
  await page.getByLabel('Accounting book').selectOption(secondId);
  await expect(page.getByRole('tabpanel')).toContainText(
    'Based on posted records in Personal.',
  );
  await page.getByRole('tab', { name: 'Overview', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('tab', { name: 'Books', exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole('heading', { name: 'Personal — trial balance (CAD)' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Refresh books', exact: true })
    .click();
  await expect(page.getByLabel('Accounting book')).toHaveValue(secondId);
  await page.keyboard.press('End');
  await page.getByRole('tab', { name: 'Automations', exact: true }).click();
  await expect(
    page.getByText('Automated workflows are not available yet.'),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Reports & tax', exact: true }).click();
  await page.getByRole('button', { name: 'Tax cases', exact: true }).click();
  await page.getByText('Country availability', { exact: true }).click();
  await expect(
    page
      .getByRole('tabpanel')
      .getByText('Calculations unavailable', { exact: true }),
  ).toHaveCount(7);
  await page.screenshot({
    path: '/tmp/emdo-finance-astra-readiness.png',
    animations: 'disabled',
  });
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.getByLabel('Accounting book').selectOption(id);
  await expect(page.getByRole('tabpanel')).toContainText(
    'Based on posted records in Operations.',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const descriptionBox = await page
    .locator('.finance-workspace .page-header p')
    .boundingBox();
  expect(descriptionBox?.width).toBeGreaterThan(240);
  expect(descriptionBox?.height).toBeLessThan(65);
  await page.screenshot({
    path: '/tmp/emdo-finance-astra-mobile.png',
    animations: 'disabled',
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expectNoSeriousAccessibilityViolations(page);
  await page.getByRole('button', { name: 'Close Finance assistant' }).click();
  await page.getByRole('button', { name: 'Open Finance assistant' }).click();
  await expect(page.getByRole('textbox', { name: 'Ask EMDO' })).toBeFocused();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await page
      .getByRole('tabpanel')
      .evaluate((element) => getComputedStyle(element).animationDuration),
  ).toBe('1e-05s');
  await page.setViewportSize({ width: 1505, height: 1045 });
  state = 'empty';
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Start with an accounting book' }),
  ).toBeVisible();
  await page.screenshot({
    path: '/tmp/emdo-finance-astra-empty.png',
    animations: 'disabled',
  });
  state = 'unavailable';
  await page
    .getByRole('button', { name: 'Refresh books', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Books are not enabled for this environment yet.',
  );
  await page.screenshot({
    path: '/tmp/emdo-finance-astra-unavailable.png',
    animations: 'disabled',
  });
  await expectNoSeriousAccessibilityViolations(page);
  expect(errors).toEqual([]);
});

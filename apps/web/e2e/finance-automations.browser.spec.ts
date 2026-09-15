import { expect, test } from '@playwright/test';
import {
  expectNoSeriousAccessibilityViolations,
  mockAuthenticatedSession,
} from './support.js';
import type { FinanceAutomationGrant } from '@emdo/contracts/browser';

const uuid = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const bookId = uuid(1),
  secondBookId = uuid(2);
const grant: FinanceAutomationGrant = {
  id: uuid(3),
  revision: 1,
  workspaceId: uuid(4),
  bookId,
  grantedByUserId: uuid(5),
  executor: 'emdo-managed',
  specialist: 'finance',
  status: 'active',
  allowedCapabilities: [
    'finance.documents.extract',
    'finance.reports.generate',
    'finance.journals.draft',
  ],
  authorityRevision: { membership: 1, bookAccess: 2, entitlement: 1 },
  limits: {
    maxRuns: 100,
    maxAttemptsPerRun: 3,
    maxItemsPerRun: 25,
    maxTotalItems: 1000,
    currency: 'CAD',
    maxAmountPerRun: '2500.00',
    maxTotalAmount: '99999999999999999999.99',
  },
  validFrom: '2026-09-13T00:00:00.000Z',
  expiresAt: '2999-10-01T00:00:00.000Z',
};

test('administrator reviews exact grant authority and revokes it across desktop and mobile', async ({
  page,
}) => {
  await mockAuthenticatedSession(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let currentGrant = grant;
  let grantStatus = 200;
  const mutations: unknown[] = [];
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
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST') {
      expect(path).toBe(
        `/api/v2/finance/books/${bookId}/automations/grants/${grant.id}/revoke`,
      );
      expect(request.headers()['x-csrf-token']).toBe(
        'e2e-csrf-token-01234567890123456789',
      );
      expect(request.headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
      expect(request.postDataJSON()).toEqual({});
      mutations.push(request.postDataJSON());
      currentGrant = { ...grant, revision: 2, status: 'revoked' };
      return route.fulfill({ json: currentGrant });
    }
    if (path.endsWith('/automations/grants'))
      return route.fulfill({
        status: grantStatus,
        json:
          grantStatus !== 200
            ? {}
            : { grants: path.includes(secondBookId) ? [] : [currentGrant] },
      });
    if (path.endsWith('/books'))
      return route.fulfill({
        json: {
          books: [
            {
              id: bookId,
              name: 'Operations',
              entityName: 'Example',
              country: 'CA',
              functionalCurrency: 'CAD',
              role: 'administrator',
            },
            {
              id: secondBookId,
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
      json: { trialBalance: [], periods: [], journals: [] },
    });
  });
  await page.setViewportSize({ width: 1505, height: 1045 });
  await page.goto('/finance');
  await expect(page.getByLabel('Accounting book')).toHaveValue(bookId);
  await page.getByRole('tab', { name: 'Automations', exact: true }).click();
  const panel = page.getByRole('region', {
    name: 'Automation grants',
    exact: true,
  });
  await expect(panel.getByText('99999999999999999999.99 CAD')).toBeVisible();
  await expect(panel.getByText(grant.validFrom)).toBeVisible();
  await expect(
    panel.getByText('Execution disabled', { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: /create|run now/i }),
  ).toHaveCount(0);
  await page.screenshot({
    path: '/tmp/emdo-finance-automations-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await expectNoSeriousAccessibilityViolations(page);
  await panel.getByText('Authority details', { exact: true }).click();
  await expect(
    panel.getByText(grant.workspaceId, { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText(
      'finance.documents.extract, finance.reports.generate, finance.journals.draft',
      { exact: true },
    ),
  ).toBeVisible();
  await panel.getByText('Authority details', { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const description = await page
    .locator('.finance-workspace .page-header p')
    .boundingBox();
  expect(description?.width).toBeGreaterThan(240);
  expect(description?.height).toBeLessThan(65);
  const availability = await panel
    .locator('.finance-automations__availability > div')
    .boundingBox();
  expect(availability?.width).toBeGreaterThan(220);
  const totalAmount = await panel
    .getByText('99999999999999999999.99 CAD')
    .boundingBox();
  expect(totalAmount?.height).toBeLessThan(25);
  await page.screenshot({
    path: '/tmp/emdo-finance-automations-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await expectNoSeriousAccessibilityViolations(page);
  await panel
    .getByRole('button', { name: 'Revoke grant', exact: true })
    .click();
  const confirmation = panel.getByRole('button', {
    name: 'Confirm revocation',
    exact: true,
  });
  await expect(confirmation).toBeFocused();
  expect(mutations).toEqual([]);
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(mutations).toEqual([]);
  await expect(
    panel.getByRole('button', { name: 'Revoke grant', exact: true }),
  ).toBeFocused();
  await panel
    .getByRole('button', { name: 'Revoke grant', exact: true })
    .click();
  await page.screenshot({
    path: '/tmp/emdo-finance-automations-confirm-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await expectNoSeriousAccessibilityViolations(page);
  await confirmation.press('Enter');
  await expect(panel.getByRole('status')).toContainText('Grant revoked.');
  await expect(panel.getByText('Revoked', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Revoke grant' })).toHaveCount(
    0,
  );
  expect(mutations).toEqual([{}]);
  await page.getByLabel('Accounting book').selectOption(secondBookId);
  await expect(
    panel.getByText('No automation grants for this book'),
  ).toBeVisible();
  await expect(panel.getByRole('article')).toHaveCount(0);
  grantStatus = 503;
  await panel.getByRole('button', { name: 'Refresh grants' }).click();
  await expect(panel.getByRole('alert')).toContainText('not available');
  await expect(
    panel.getByText('No automation grants for this book'),
  ).toHaveCount(0);
  await page.screenshot({
    path: '/tmp/emdo-finance-automations-unavailable.png',
    fullPage: true,
    animations: 'disabled',
  });
  grantStatus = 403;
  await panel.getByRole('button', { name: 'Refresh grants' }).click();
  await expect(panel.getByRole('alert')).toContainText('Administrator access');
  await expect(panel.getByRole('article')).toHaveCount(0);
  await expectNoSeriousAccessibilityViolations(page);
  expect(errors).toEqual([]);
});

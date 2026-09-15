import { expect, test } from '@playwright/test';
import {
  mockAuthenticatedSession,
  expectNoSeriousAccessibilityViolations,
} from './support.js';
const id = '00000000-0000-4000-8000-000000000001';
test('saved investments retain unavailable totals and differences on desktop and mobile', async ({
  page,
}, testInfo) => {
  await mockAuthenticatedSession(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const summary = {
    id,
    asOf: '2026-03-31',
    calculationVersion: 'investment-valuation.v1',
    status: 'incomplete',
    currency: 'JPY',
    total: null,
    valuationScope: 'selected-positions',
  };
  const detail = {
    ...summary,
    inputSnapshot: { price: null },
    result: {
      ...summary,
      mode: 'saved',
      availableSubtotal: '99999999999999999999',
      unavailableCount: 1,
      positions: [
        {
          financialAccountId: id,
          instrumentId: id,
          quantity: '12.125',
          nativeCurrency: null,
          nativeValue: null,
          functionalValue: null,
          status: 'unavailable',
          reason: 'missing-price',
          sourceReferences: [],
        },
      ],
      reconciliations: [
        {
          observedPositionId: id,
          evidenceId: id,
          sourceRow: 3,
          observedQuantity: '12.25',
          calculatedQuantity: '12.125',
          difference: '0.125',
          status: 'difference',
        },
      ],
      calculations: [],
    },
  };
  await page.route('**/api/v1/experience/finance*', (route) =>
    route.fulfill({
      json: {
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
  await page.route('**/api/v1/finance/documents*', (route) =>
    route.fulfill({ json: { schemaVersion: 1, items: [] } }),
  );
  await page.route('**/api/v1/finance/imports/options', (route) =>
    route.fulfill({ json: { schemaVersion: 1, accounts: [], categories: [] } }),
  );

  await page.route('**/api/v2/finance/books**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') {
      if (path.endsWith('/valuation-preview'))
        return route.fulfill({
          json: { ...detail.result, inputHash: 'a'.repeat(64) },
        });
      expect(path).toBe(
        `/api/v2/finance/books/${id}/investments/valuation-runs`,
      );
      expect(route.request().postDataJSON()).toMatchObject({
        asOf: '2026-03-31',
        expectedInputHash: 'a'.repeat(64),
      });
      return route.fulfill({ json: { id } });
    }
    if (path.endsWith('/investments'))
      return route.fulfill({
        json: {
          instruments: [{ id, name: 'Fund' }],
          prices: [],
          openings: [],
          fx: [],
          observedPositions: [],
        },
      });
    if (path.endsWith('/financial-accounts'))
      return route.fulfill({
        json: {
          accounts: [{ id, name: 'Broker', kind: 'brokerage', active: true }],
        },
      });
    return route.fulfill({
      json: path.endsWith('/books')
        ? {
            books: [
              {
                id,
                name: 'Investments',
                entityName: 'Example',
                country: 'JP',
                functionalCurrency: 'JPY',
                role: 'preparer',
              },
            ],
          }
        : path.endsWith('/valuation-runs')
          ? { runs: [summary], nextOffset: null }
          : path.includes('/valuation-runs/')
            ? detail
            : { trialBalance: [], periods: [], journals: [] },
    });
  });
  await page.goto('/finance');
  await page.getByLabel('Accounting book').selectOption(id);
  await page
    .getByRole('tab', { name: 'Accounts & investments', exact: true })
    .click();
  await page.getByRole('button', { name: 'Create a valuation' }).click();
  await page.getByLabel('Valuation date').fill('2026-03-31');
  await page
    .getByRole('combobox', { name: 'Brokerage account', exact: true })
    .selectOption(id);
  await page
    .getByRole('combobox', { name: 'Instrument', exact: true })
    .selectOption(id);
  await page
    .getByRole('button', { name: 'Preview valuation', exact: true })
    .click();
  await expect(
    page.getByText('Selected-position total: Unavailable', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save reviewed valuation' }).click();
  await expect(
    page.getByText('Total: Unavailable', { exact: true }),
  ).toBeVisible();

  await page
    .getByRole('button', { name: 'Open investment valuations' })
    .click();
  await page
    .getByRole('button', { name: `2026-03-31 · JPY · incomplete · ${id}` })
    .click();
  await expect(
    page.getByText('Total: Unavailable', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('0.125', { exact: true })).toBeVisible();
  await page
    .getByText('Frozen inputs and calculation provenance', { exact: true })
    .click();
  await expectNoSeriousAccessibilityViolations(page);
  await page.screenshot({
    path: testInfo.outputPath('investments-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('investments-mobile.png'),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

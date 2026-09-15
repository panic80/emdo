import { expect, test, type Page } from '@playwright/test';
import {
  expectNoSeriousAccessibilityViolations,
  mockAuthenticatedSession,
} from './support.js';

const bookId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const instrumentId = '00000000-0000-4000-8000-000000000003';
const evidenceId = '00000000-0000-4000-8000-000000000004';
const sourceLotId = '00000000-0000-4000-8000-000000000005';
const successorLotId = '00000000-0000-4000-8000-000000000006';
const movementId = '00000000-0000-4000-8000-000000000007';
const csrfToken = 'e2e-csrf-token-01234567890123456789';

const source = {
  sourceRevision: 12,
  sourceSnapshotHash: 'b'.repeat(64),
  sourceAsOf: '2026-09-01',
  sourceBoundary: 'immediately-before-action',
  sourceLots: [
    {
      id: sourceLotId,
      financialAccountId: accountId,
      instrumentId,
      acquiredOn: '2026-01-01',
      acquisitionSequence: 0,
      originalQuantity: '10',
      disposedQuantity: '0',
      originalNativeCost: '100',
      allocatedNativeCost: '0',
      originalFunctionalCost: '100',
      allocatedFunctionalCost: '0',
      nativeCurrency: 'CAD',
      functionalCurrency: 'CAD',
      sourceReference: 'opening:broker:1',
    },
  ],
};

const currentLot = {
  id: successorLotId,
  movementId,
  financialAccountId: accountId,
  instrumentId,
  nativeCurrency: 'CAD',
  functionalCurrency: 'CAD',
  originalQuantity: '20',
  remainingQuantity: '20',
  originalNativeCost: '100',
  remainingNativeCost: '100',
  originalFunctionalCost: '100',
  remainingFunctionalCost: '100',
  acquiredOn: '2026-01-01',
  sourceReference: 'corporate-action:successor',
};

async function installMocks(page: Page) {
  await mockAuthenticatedSession(page);
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
          bytesLimit: 1_000_000,
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
  await page.route('**/api/v2/finance/books**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === 'POST') {
      if (path.endsWith('/stock-splits/source')) {
        expect(request.postDataJSON()).toMatchObject({
          actionType: 'split',
          numerator: '2',
          denominator: '1',
          effectiveOn: '2026-09-01',
          evidenceId,
          cashInLieu: null,
        });
        return route.fulfill({ json: source });
      }
      if (path.endsWith('/stock-splits/commit')) {
        expect(request.headers()['x-csrf-token']).toBe(csrfToken);
        const body = request.postDataJSON();
        expect(body.expectedSourceRevision).toBe(12);
        expect(request.headers()['idempotency-key']).toBe(body.idempotencyKey);
        return route.fulfill({
          json: {
            actionId: body.action.id,
            workspaceId: bookId,
            bookId,
            sourceRevision: 12,
            nextSourceRevision: 13,
            sourceSnapshotHash: 'b'.repeat(64),
            successorLotIds: [successorLotId],
            effectCount: 1,
            status: 'committed',
            replayed: false,
          },
        });
      }
      return route.fulfill({ json: { id: sourceLotId } });
    }
    if (path.endsWith('/books'))
      return route.fulfill({
        json: {
          books: [
            {
              id: bookId,
              name: 'Operating investments',
              entityName: 'Northstar Holdings',
              country: 'CA',
              functionalCurrency: 'CAD',
              role: 'administrator',
            },
          ],
        },
      });
    if (path.endsWith('/financial-accounts'))
      return route.fulfill({
        json: {
          accounts: [
            {
              id: accountId,
              name: 'Northstar Brokerage',
              kind: 'brokerage',
              currency: 'CAD',
              active: true,
            },
          ],
        },
      });
    if (path.endsWith('/investments'))
      return route.fulfill({
        json: {
          instruments: [
            { id: instrumentId, name: 'Northstar Fund', symbol: 'NST' },
          ],
          prices: [],
          fx: [],
          openings: [],
          observedPositions: [],
        },
      });
    if (request.url().includes('/evidence?'))
      return route.fulfill({
        json: {
          documents: [
            {
              id: evidenceId,
              filename: 'broker-notice.pdf',
              format: 'pdf',
              byteSize: 12_345,
              createdAt: '2026-08-20T10:00:00.000Z',
              sourceDigest: 'd'.repeat(64),
            },
          ],
          nextOffset: null,
        },
      });
    if (request.url().includes('/investments/lots?'))
      return route.fulfill({ json: { lots: [currentLot], nextOffset: null } });
    if (path.endsWith('/corporate-actions/revision'))
      return route.fulfill({ json: { revision: 12 } });
    if (path.endsWith('/valuation-runs'))
      return route.fulfill({ json: { runs: [], nextOffset: null } });
    return route.fulfill({
      json: { trialBalance: [], periods: [], journals: [] },
    });
  });
}

test('reviewed stock splits are usable and readable on desktop and mobile', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installMocks(page);
  await page.goto('/finance');
  await page.getByLabel('Accounting book').selectOption(bookId);
  await page
    .getByRole('tab', { name: 'Accounts & investments', exact: true })
    .click();
  await page.getByRole('button', { name: 'Review a stock split' }).click();
  await page.getByLabel('Effective date').fill('2026-09-01');
  await page
    .getByRole('combobox', { name: 'Brokerage account', exact: true })
    .selectOption(accountId);
  await page
    .getByRole('combobox', { name: 'Instrument', exact: true })
    .selectOption(instrumentId);
  await page
    .getByRole('combobox', { name: 'Evidence document', exact: true })
    .selectOption(evidenceId);
  await page.getByLabel('Source reference').fill('broker:notice:2026-09-01');
  await page
    .getByRole('button', { name: 'Preview deterministic result', exact: true })
    .click();
  await expect(
    page.getByText('Ready to commit', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Source lots', { exact: true })).toBeVisible();
  await page
    .getByLabel('I reviewed the source snapshot and proposed successor lots.')
    .check();
  await page
    .getByRole('button', { name: 'Commit reviewed stock split', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Stock split committed', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Committed', { exact: true })).toBeVisible();
  await expect(page.getByText('Split preview', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Current successor lots', { exact: true }),
  ).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
  await page.screenshot({
    path: testInfo.outputPath('corporate-action-desktop.png'),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('corporate-action-mobile.png'),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  FinanceGeneratedReportSummarySchema,
  type FinanceGeneratedReport,
} from '@emdo/contracts/browser';
import {
  expectNoSeriousAccessibilityViolations,
  mockAuthenticatedSession,
} from './support.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bookId = id(1),
  otherBookId = id(2);
const report: FinanceGeneratedReport = {
  id: id(3),
  bookId,
  workspaceId: id(4),
  automationRunId: id(5),
  reportVersion: 1,
  kind: 'posted-ledger-trial-balance',
  coverage: 'all-posted-journals-at-snapshot',
  currency: 'CAD',
  snapshotAt: '2026-09-13T12:59:56.000Z',
  rows: [
    {
      accountId: id(6),
      code: '1000',
      name: 'Cash',
      kind: 'asset',
      debit: '2500.00',
      credit: '400.25',
      balance: '2099.75',
    },
    {
      accountId: id(7),
      code: '4000',
      name: 'Sales income',
      kind: 'income',
      debit: '0',
      credit: '2500.00',
      balance: '-2500.00',
    },
    {
      accountId: id(8),
      code: '6100',
      name: 'Office expenses',
      kind: 'expense',
      debit: '400.25',
      credit: '0',
      balance: '400.25',
    },
  ],
  sourceJournals: [
    {
      journalId: id(9),
      effectiveOn: '2026-09-11',
      sourceReference: 'invoice:INV-2048',
      payloadHash: 'a'.repeat(64),
    },
    {
      journalId: id(10),
      effectiveOn: '2026-09-12',
      sourceReference: 'receipt:Office-supplies',
      payloadHash: 'b'.repeat(64),
    },
  ],
  totalDebit: '2900.25',
  totalCredit: '2900.25',
};
function summary(value: FinanceGeneratedReport) {
  return FinanceGeneratedReportSummarySchema.strip().parse(value);
}

test('saved report library preserves snapshot provenance, readable downloads, and book access', async ({
  page,
}) => {
  await mockAuthenticatedSession(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let status = 200;
  const reports = Array.from({ length: 21 }, (_, n) => ({
    ...report,
    id: n === 0 ? report.id : id(30 + n),
    snapshotAt: `2026-09-13T12:${String(59 - n).padStart(2, '0')}:56.000Z`,
  }));
  let reportReads = 0;
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
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    expect(request.method()).toBe('GET');
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
              role: 'viewer',
            },
            {
              id: otherBookId,
              name: 'Personal',
              entityName: 'Member',
              country: 'CA',
              functionalCurrency: 'CAD',
              role: 'viewer',
            },
          ],
        },
      });
    if (path.includes('/reports')) {
      if (status !== 200) return route.fulfill({ status, json: {} });
      if (path.endsWith('/reports')) {
        expect(url.searchParams.get('limit')).toBe('20');
        const offset = Number(url.searchParams.get('offset'));
        return route.fulfill({
          json: {
            reports: path.includes(otherBookId)
              ? []
              : reports.slice(offset, offset + 20).map(summary),
            nextOffset: path.includes(otherBookId) || offset > 0 ? null : 20,
          },
        });
      }
      const selected = reports.find((value) => path.endsWith(value.id));
      expect(selected).toBeTruthy();
      reportReads++;
      return route.fulfill({ json: selected });
    }
    return route.fulfill({
      json: { trialBalance: [], journals: [], periods: [] },
    });
  });
  await page.setViewportSize({ width: 1505, height: 1045 });
  await page.goto('/finance');
  await expect(page.getByLabel('Accounting book')).toHaveValue(bookId);
  await page.getByRole('tab', { name: 'Reports & tax', exact: true }).click();
  await page
    .getByRole('button', { name: 'Saved reports', exact: true })
    .click();
  const panel = page.getByRole('region', {
    name: 'Saved accounting reports',
    exact: true,
  });
  await expect(
    panel.getByRole('button', { name: /Posted ledger snapshot/ }),
  ).toHaveCount(20);
  await expect(
    panel.getByRole('heading', { name: 'Select a saved report' }),
  ).toBeVisible();
  await panel
    .getByRole('button', {
      name: new RegExp(
        `Posted ledger snapshot.*${report.snapshotAt.replaceAll('.', '\\.')}`,
      ),
    })
    .click();
  const heading = panel.getByRole('heading', {
    name: 'Posted ledger snapshot',
    exact: true,
  });
  await expect(heading).toBeFocused();
  const table = panel.getByRole('table', {
    name: 'Gross posted movements · CAD',
  });
  await expect(table.getByRole('row', { name: /1000 · Cash/ })).toContainText(
    '2099.75',
  );
  await expect(panel.getByText('2900.25', { exact: true })).toHaveCount(2);
  await expect(panel.getByText(/No period filter is applied/)).toBeVisible();
  await expect(
    panel.getByRole('button', { name: /generate|schedule/i }),
  ).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: '/tmp/emdo-saved-reports-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await expectNoSeriousAccessibilityViolations(page);
  await panel.getByText(/^Source journals\s*2$/u).click();
  await panel.getByText('invoice:INV-2048', { exact: true }).click();
  await expect(panel.getByText('a'.repeat(64), { exact: true })).toBeVisible();
  await panel.getByText('Snapshot provenance', { exact: true }).click();
  await expect(
    panel.getByText(report.automationRunId, { exact: true }),
  ).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await panel
    .getByRole('button', { name: 'Download report', exact: true })
    .click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(
    `emdo-posted-ledger-${report.id}.html`,
  );
  const downloadPath = '/tmp/emdo-saved-report-reviewed.html';
  await download.saveAs(downloadPath);
  const content = await readFile(downloadPath, 'utf8');
  expect(content).toContain('Gross debit movements');
  expect(content).toContain(report.snapshotAt);
  expect(content).toContain('receipt:Office-supplies');
  expect(content).toContain('b'.repeat(64));
  expect(content).not.toContain('<script');
  expect(reportReads).toBe(2);
  const exportPage = await page.context().newPage();
  await exportPage.setViewportSize({ width: 1505, height: 1045 });
  await exportPage.goto(pathToFileURL(downloadPath).href);
  await expect(
    exportPage.getByRole('heading', {
      name: 'Posted ledger snapshot',
      exact: true,
    }),
  ).toBeVisible();
  await expectNoSeriousAccessibilityViolations(exportPage);
  await exportPage.screenshot({
    path: '/tmp/emdo-saved-report-download.png',
    fullPage: true,
  });
  await exportPage.close();
  await panel
    .getByRole('button', { name: 'Next reports', exact: true })
    .click();
  await expect(
    panel.getByRole('button', { name: /Posted ledger snapshot/ }),
  ).toHaveCount(1);
  await expect(panel.getByRole('table')).toHaveCount(0);
  await panel
    .getByRole('button', { name: 'Previous reports', exact: true })
    .click();
  await panel
    .getByRole('button', { name: /Posted ledger snapshot/ })
    .first()
    .click();
  await expect(table).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const detailWidth = await panel
    .locator('.finance-report-detail')
    .boundingBox();
  expect(detailWidth?.width).toBeGreaterThan(280);
  await page.screenshot({
    path: '/tmp/emdo-saved-reports-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await heading.scrollIntoViewIfNeeded();
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await expectNoSeriousAccessibilityViolations(page);
  await page.screenshot({
    path: '/tmp/emdo-saved-report-mobile-native.png',
    animations: 'disabled',
  });
  await page.getByLabel('Accounting book').selectOption(otherBookId);
  await expect(panel.getByText('No saved reports for this book')).toBeVisible();
  await expect(panel.getByRole('table')).toHaveCount(0);
  await page.screenshot({
    path: '/tmp/emdo-saved-reports-empty.png',
    fullPage: true,
    animations: 'disabled',
  });
  status = 503;
  await panel.getByRole('button', { name: 'Refresh reports' }).click();
  await expect(panel.getByRole('alert')).toContainText('not available');
  await expect(panel.getByText('No saved reports for this book')).toHaveCount(
    0,
  );
  await page.screenshot({
    path: '/tmp/emdo-saved-reports-unavailable.png',
    fullPage: true,
    animations: 'disabled',
  });
  status = 403;
  await panel.getByRole('button', { name: 'Refresh reports' }).click();
  await expect(panel.getByRole('alert')).toContainText('Current book access');
  await expect(
    panel.getByRole('button', { name: 'Download report' }),
  ).toHaveCount(0);
  await expectNoSeriousAccessibilityViolations(page);
  await page
    .getByRole('button', { name: 'Report standardization', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Open report standardization' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Tax cases', exact: true }).click();
  await page.getByText('Country availability', { exact: true }).click();
  await expect(
    page
      .getByRole('tabpanel')
      .getByText('Calculations unavailable', { exact: true }),
  ).toHaveCount(7);
  expect(errors).toEqual([]);
});

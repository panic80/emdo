import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import {
  mockAuthenticatedSession,
  expectNoSeriousAccessibilityViolations,
} from './support.js';
import { taxWorkingFixture } from '../test/finance-tax-working-fixture.js';
import { taxBookId } from '../test/finance-tax-fixture.js';

async function setup(page: Page) {
  await mockAuthenticatedSession(page);
  const fixture = taxWorkingFixture();
  const writes: Array<{
    path: string;
    body: Record<string, unknown>;
    key: string;
  }> = [];
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
  await page.route('**/api/v1/finance/documents*', (route) =>
    route.fulfill({ json: { schemaVersion: 1, items: [] } }),
  );
  await page.route('**/api/v1/finance/imports/options', (route) =>
    route.fulfill({ json: { schemaVersion: 1, accounts: [], categories: [] } }),
  );
  await page.route('**/api/v2/finance/**', (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.includes('/tax/cases')) {
      const body =
        request.method() === 'POST'
          ? (request.postDataJSON() as Record<string, unknown>)
          : {};
      if (request.method() === 'POST') {
        expect(request.headers()['x-csrf-token']).toBe(
          'e2e-csrf-token-01234567890123456789',
        );
        const key = request.headers()['idempotency-key']!;
        expect(key).toMatch(/^[a-f0-9-]{36}$/u);
        writes.push({ path, body, key });
      }
      const result = fixture.handle(request.url(), request.method(), body);
      return route.fulfill({ status: result.status, json: result.json });
    }
    if (path.endsWith('/books'))
      return route.fulfill({
        json: {
          books: fixture.books.map((book) => ({
            ...book,
            role: 'administrator',
          })),
        },
      });
    return route.fulfill({
      json: path.endsWith('/report-mappings')
        ? { mappings: [], reports: [] }
        : path.endsWith('/evidence')
          ? { evidence: [] }
          : { trialBalance: [], journals: [], periods: [], imports: [] },
    });
  });
  return { ...fixture, writes, errors };
}
async function openWorking(page: Page) {
  await page.goto('/finance');
  await expect(page.getByLabel('Accounting book')).toHaveValue(taxBookId);
  await page.getByRole('tab', { name: 'Reports & tax', exact: true }).click();
  await page.getByRole('button', { name: 'Tax cases', exact: true }).click();
  await page
    .getByRole('button', { name: 'Open tax case 2025 · Personal income tax' })
    .click();
  await page
    .getByRole('button', { name: 'Working papers', exact: true })
    .click();
  await expect(page.getByLabel('Working-paper input progress')).toBeVisible();
}
test('exact input review, durable run and incomplete CSV review work on desktop and mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1505, height: 1045 });
  const fixture = await setup(page);
  fixture.approveInputs();
  const first = fixture.detail.declaredInputs[0]!;
  fixture.leaveInputUnreviewed(first.sourceId);
  await openWorking(page);
  const privateCase = page.getByRole('region', {
    name: 'Private tax case',
    exact: true,
  });
  await privateCase.screenshot({
    path: '/tmp/emdo-tax-working-prepare-desktop.png',
    animations: 'disabled',
  });
  await expectNoSeriousAccessibilityViolations(page);
  const checkbox = page.getByRole('checkbox', {
    name: `Review saved version: ${fixture.preparation().questions[0]!.label}`,
  });
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();
  await page
    .getByRole('button', { name: 'Review selected input versions' })
    .click();
  const review = page.getByRole('region', {
    name: 'Confirm exact input review',
  });
  await expect(
    review.getByText(first.contentHash, { exact: true }),
  ).toBeVisible();
  await review.getByRole('checkbox').check();
  await review
    .getByRole('button', { name: 'Approve exact input versions' })
    .click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  expect(fixture.writes[0]!.body.inputs).toEqual([
    {
      sourceId: first.sourceId,
      sourceRevision: first.sourceRevision,
      contentHash: first.contentHash,
    },
  ]);
  await page.getByRole('button', { name: 'Review run creation' }).click();
  const creation = page.getByRole('region', {
    name: 'Confirm working-paper run',
  });
  await creation.getByRole('checkbox').check();
  await creation
    .getByRole('button', { name: 'Create working-paper run' })
    .click();
  await expect(
    page.getByRole('region', { name: 'Exact working-paper fields' }),
  ).toBeVisible();
  expect(fixture.runs[0]!.summary.status).toBe('incomplete-working-papers');
  await expect(
    page.getByRole('cell', { name: /^50000 Exact decimal/u }).first(),
  ).toBeVisible();
  await privateCase.screenshot({
    path: '/tmp/emdo-tax-working-run-desktop.png',
    animations: 'disabled',
  });
  await expectNoSeriousAccessibilityViolations(page);
  await page.getByText('Field provenance', { exact: true }).first().click();
  await expect(
    page.getByText('Input dependencies', { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole('button', {
      name: 'Review incomplete working papers',
      exact: true,
    })
    .click();
  const outputReview = page.getByRole('region', {
    name: 'Confirm incomplete working-paper review',
  });
  await expect(
    outputReview.getByText(fixture.runs[0]!.summary.outputHash, {
      exact: true,
    }),
  ).toBeVisible();
  await outputReview.getByRole('checkbox').check();
  await outputReview
    .getByRole('button', { name: 'Save incomplete working-paper review' })
    .click();
  const downloadButton = page.getByRole('button', {
    name: 'Download incomplete working papers (CSV)',
  });
  await expect(downloadButton).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page
    .getByRole('region', { name: 'Exact working-paper fields' })
    .evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({
    path: '/tmp/emdo-tax-working-run-mobile-native.png',
    animations: 'disabled',
  });
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390);
  await expectNoSeriousAccessibilityViolations(page);
  const downloadEvent = page.waitForEvent('download');
  await downloadButton.click();
  const download = await downloadEvent;
  const destination = '/tmp/emdo-tax-working-reviewed.csv';
  await download.saveAs(destination);
  expect(await readFile(destination, 'utf8')).toBe(fixture.exportRun().content);
  await page.getByRole('button', { name: 'Back to run history' }).click();
  await expect(
    page.getByRole('region', { name: 'Saved working-paper runs' }),
  ).toBeVisible();
  await page.screenshot({
    path: '/tmp/emdo-tax-working-history-mobile.png',
    animations: 'disabled',
  });
  await page
    .getByRole('button', { name: 'Prepare inputs', exact: true })
    .click();
  await page.getByLabel('Show inputs').selectOption('all');
  await page.getByText('Employment & other income', { exact: true }).click();
  await page
    .getByRole('button', {
      name: 'Revise working input: Employment income',
      exact: true,
    })
    .click();
  await page.getByLabel(/^Declaration value/u).fill('50000.20');
  await page.getByRole('button', { name: 'Review input', exact: true }).click();
  await expect(
    page
      .getByLabel('Review declaration')
      .getByText('50000.20', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Tax declaration editor').screenshot({
    path: '/tmp/emdo-tax-working-input-review-mobile.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Save unreviewed input' }).click();
  await expect(page.getByText('for revision 3', { exact: true })).toBeVisible();
  expect(fixture.preparation().inputReviews).toHaveLength(0);
  await page.getByRole('button', { name: 'Run history', exact: true }).click();
  await page
    .getByRole('button', {
      name: /Incomplete working papers.*Snapshot revision/u,
    })
    .click();
  await expect(
    page.getByText(/This run uses an earlier saved snapshot/u),
  ).toBeVisible();
  fixture.state.exportStatus = 403;
  await page
    .getByRole('button', { name: 'Download incomplete working papers (CSV)' })
    .click();
  await expect(
    page.getByText(/Refresh the tax case to check current access/u),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Exact working-paper fields' }),
  ).toHaveCount(0);
  await page.screenshot({
    path: '/tmp/emdo-tax-working-forbidden-mobile.png',
    animations: 'disabled',
  });
  expect(fixture.errors).toEqual([]);
});

test('blocked runs, viewer permissions and unavailable workflow scopes remain explicit', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await setup(page);
  const blockedRun = fixture.createRun();
  expect(blockedRun.summary.status).toBe('blocked-input');
  fixture.detail.caseRole = 'viewer';
  await openWorking(page);
  await expect(
    page.getByRole('button', { name: 'Review run creation' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('checkbox', { name: /Review saved version/u }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Run history', exact: true }).click();
  await page
    .getByRole('button', { name: /Input blockers.*Snapshot revision/u })
    .click();
  await expect(
    page.getByRole('region', { name: 'Run input blockers' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Review incomplete working papers' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'Download incomplete working papers (CSV)',
    }),
  ).toHaveCount(0);
  await page.screenshot({
    path: '/tmp/emdo-tax-working-blocked-mobile.png',
    animations: 'disabled',
  });
  await expectNoSeriousAccessibilityViolations(page);
  await page.getByRole('button', { name: 'Back to run history' }).click();
  fixture.state.scopeSupported = false;
  await page.getByRole('button', { name: 'Refresh working papers' }).click();
  await page
    .getByRole('button', { name: 'Prepare inputs', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Unsupported working-paper scope' }),
  ).toBeVisible();
  fixture.state.status = 503;
  await page.getByRole('button', { name: 'Refresh working papers' }).click();
  await expect(
    page.getByText('Private tax preparation is not available right now.'),
  ).toBeVisible();
  await expect(page.getByText('No saved runs', { exact: true })).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

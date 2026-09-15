import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Locator } from '@playwright/test';
import {
  expectNoSeriousAccessibilityViolations,
  mockAuthenticatedSession,
} from './support.js';
import {
  dividendCsrf,
  dividendFixture,
  dividendIds,
} from '../test/finance-dividend-fixture.js';

async function mockDividends(page: Page) {
  const fixture = dividendFixture();
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
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v2/finance/books**', async (route) => {
    const request = route.request(),
      body: unknown = request.method() === 'POST' ? request.postDataJSON() : {};
    if (new URL(request.url()).pathname.endsWith('/cash-dividends/commit')) {
      expect(request.headers()['x-csrf-token']).toBe(dividendCsrf);
      expect(request.headers()['idempotency-key']).toBe(
        (body as { idempotencyKey: string }).idempotencyKey,
      );
    }
    try {
      const result = fixture.handle(
        request.method(),
        request.url(),
        body,
        request.headers()['idempotency-key'] ?? '',
      );
      await route.fulfill({ status: result.status, json: result.json });
    } catch (error) {
      if (error instanceof TypeError && /Posting/u.test(error.message))
        return route.abort('failed');
      throw error;
    }
  });
  return { ...fixture, errors };
}
async function openWorkspace(page: Page) {
  await page.goto('/finance');
  await page.getByRole('tab', { name: 'Accounts & investments' }).click();
  await page
    .getByRole('button', { name: 'Open cash dividends', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Saved dividends', exact: true }),
  ).toBeVisible();
}
async function openSource(page: Page) {
  await page
    .getByRole('button', { name: 'Review a cash dividend', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Saved statement', exact: true })
    .selectOption(dividendIds.batch);
  await page
    .getByRole('combobox', { name: 'Investment', exact: true })
    .selectOption(dividendIds.instrument);
  await page
    .getByRole('combobox', { name: 'Statement receipt row', exact: true })
    .selectOption(dividendIds.row);
  await page
    .getByRole('button', { name: 'Load current dividend source', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Prepare a cash dividend', exact: true }),
  ).toBeVisible();
}
async function fill(page: Page, gross = '100.00', tax = '15.00') {
  const review = page.getByRole('region', {
    name: 'Cash dividend review',
    exact: true,
  });
  await review.getByLabel('Declared date', { exact: true }).fill('2026-07-20');
  await review
    .getByLabel('Ex-dividend date · optional', { exact: true })
    .fill('2026-07-21');
  await review
    .getByLabel('Dividend reference', { exact: true })
    .fill('ACME · August 2026 dividend');
  await review
    .getByRole('combobox', { name: 'Dividend income account', exact: true })
    .selectOption(dividendIds.income);
  await review
    .getByRole('combobox', { name: 'Withholding account', exact: true })
    .selectOption(dividendIds.tax);
  await review
    .getByLabel('Source review notes', { exact: true })
    .fill(
      'Checked the gross dividend, withholding tax, net cash and original statement headings.',
    );
  for (const [name, value, heading] of [
    ['Gross dividend', gross, 'Gross'],
    ['Withholding tax', tax, 'Tax'],
    ['Net cash received', '85.00', 'Net'],
  ] as const) {
    const group = review.getByRole('group', { name, exact: true });
    if (name !== 'Net cash received') {
      await group
        .getByRole('textbox', { name: 'Original currency amount', exact: true })
        .fill(value);
      if (value)
        await group
          .getByRole('combobox', { name: 'Original currency', exact: true })
          .selectOption('CAD');
    }
    if (value) {
      await group
        .getByRole('textbox', { name: 'Exact value as printed', exact: true })
        .fill(value);
      await group
        .getByRole('textbox', {
          name: 'Exact source column heading',
          exact: true,
        })
        .fill(heading);
    }
  }
  return review;
}
async function showHeading(page: Page, locator: Locator) {
  await locator.evaluate((element) =>
    element.scrollIntoView({ block: 'start', behavior: 'instant' }),
  );
  if ((page.viewportSize()?.width ?? 1440) < 1024)
    await expect
      .poll(() =>
        page
          .locator('.top-bar')
          .evaluate((element) => element.getBoundingClientRect().top),
      )
      .toBe(0);
}
test('dividend amounts, journal review and saved source proof work on desktop and mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const fixture = await mockDividends(page);
  await openWorkspace(page);
  await openSource(page);
  const review = await fill(page);
  const grossBounds = await review
    .getByRole('group', { name: 'Gross dividend', exact: true })
    .boundingBox();
  const taxBounds = await review
    .getByRole('group', { name: 'Withholding tax', exact: true })
    .boundingBox();
  expect(grossBounds).not.toBeNull();
  expect(taxBounds).not.toBeNull();
  expect(Math.abs(grossBounds!.y - taxBounds!.y)).toBeLessThan(2);
  expect(taxBounds!.x).toBeGreaterThan(grossBounds!.x + grossBounds!.width);
  await review.screenshot({
    path: '/tmp/emdo-dividend-amount-review-desktop.png',
    animations: 'disabled',
  });
  await expectNoSeriousAccessibilityViolations(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await showHeading(
    page,
    review.getByRole('group', { name: 'Gross dividend', exact: true }),
  );
  await page.screenshot({
    path: '/tmp/emdo-dividend-amount-mobile-native.png',
    animations: 'disabled',
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await review
    .getByRole('button', { name: 'Preview dividend journal', exact: true })
    .click();
  await expect(
    review.getByRole('heading', {
      name: 'Review the dividend journal',
      exact: true,
    }),
  ).toBeFocused();
  await expect(
    review.getByRole('button', { name: 'Post reviewed dividend', exact: true }),
  ).toBeDisabled();
  expect(
    fixture.writes.filter((write) => write.path.endsWith('/commit')),
  ).toHaveLength(0);
  const preview = fixture.writes.find((write) =>
    write.path.endsWith('/preview'),
  )!.body;
  expect(preview).toMatchObject({
    expectedSourceRevision: 3,
    sourceSnapshotHash: 'a'.repeat(64),
  });
  expect(preview).not.toHaveProperty('source');
  const tableBounds = await review.getByRole('table').boundingBox();
  const tableContainerBounds = await review
    .locator('.finance-table-scroll')
    .boundingBox();
  expect(tableBounds).not.toBeNull();
  expect(tableContainerBounds).not.toBeNull();
  expect(
    Math.abs(tableBounds!.width - tableContainerBounds!.width),
  ).toBeLessThan(3);
  await review.screenshot({
    path: '/tmp/emdo-dividend-journal-desktop.png',
    animations: 'disabled',
  });
  await expectNoSeriousAccessibilityViolations(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await showHeading(
    page,
    review.getByRole('heading', {
      name: 'Review the dividend journal',
      exact: true,
    }),
  );
  await page.screenshot({
    path: '/tmp/emdo-dividend-journal-mobile-native.png',
    animations: 'disabled',
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await expectNoSeriousAccessibilityViolations(page);
  await review.getByRole('checkbox').focus();
  await page.keyboard.press('Space');
  await expect(review.getByRole('checkbox')).toBeChecked();
  await review
    .getByRole('button', { name: 'Post reviewed dividend', exact: true })
    .click();
  await expect(
    review.getByRole('heading', {
      name: 'Dividend posting confirmed',
      exact: true,
    }),
  ).toBeVisible();
  expect(fixture.actions).toHaveLength(1);
  await review
    .getByRole('button', {
      name: 'View saved dividend and evidence',
      exact: true,
    })
    .click();
  const saved = page.getByRole('region', {
    name: 'Saved cash dividend',
    exact: true,
  });
  await expect(saved).toBeVisible();
  await showHeading(
    page,
    saved.getByRole('heading', {
      name: 'ACME · August 2026 dividend',
      exact: true,
    }),
  );
  await page.screenshot({
    path: '/tmp/emdo-dividend-saved-mobile-native.png',
    animations: 'disabled',
  });
  const originalDownload = page.waitForEvent('download');
  await saved
    .getByRole('button', { name: 'Download dividend original', exact: true })
    .click();
  const original = await originalDownload;
  expect(original.suggestedFilename()).toBe('brokerage-dividend.csv');
  expect(await readFile((await original.path())!, 'utf8')).toContain(
    '100.00,15.00,85.00,CAD',
  );
  const recordDownload = page.waitForEvent('download');
  await saved
    .getByRole('button', { name: 'Download saved dividend', exact: true })
    .click();
  const record = await recordDownload,
    text = await readFile((await record.path())!, 'utf8');
  expect(JSON.parse(text)).toMatchObject({
    journalId: dividendIds.journal,
    gross: { nativeAmount: '100', provenance: { raw: '100.00' } },
    sourceRevision: 3,
  });
  await expectNoSeriousAccessibilityViolations(page);
  expect(fixture.errors).toEqual([]);
});
test('a lost dividend posting response resumes from its saved action after reload without a second posting', async ({
  page,
}) => {
  const fixture = await mockDividends(page);
  fixture.state.loseCommitResponse = true;
  await openWorkspace(page);
  await openSource(page);
  const review = await fill(page);
  await review
    .getByRole('button', { name: 'Preview dividend journal', exact: true })
    .click();
  await review.getByRole('checkbox').check();
  await review
    .getByRole('button', { name: 'Post reviewed dividend', exact: true })
    .click();
  await expect(
    review.getByRole('heading', {
      name: 'Check this posting outcome',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    review.getByRole('button', { name: 'Retry exact posting', exact: true }),
  ).toHaveCount(0);
  await openWorkspace(page);
  await page
    .getByRole('button', {
      name: 'Open saved dividend: ACME · August 2026 dividend',
      exact: true,
    })
    .click();
  const saved = page.getByRole('region', {
    name: 'Saved cash dividend',
    exact: true,
  });
  await expect(saved.getByText('Posted', { exact: true })).toBeVisible();
  expect(
    fixture.writes.filter((write) => write.path.endsWith('/commit')),
  ).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});
test('missing withholding, current permission denial and unavailable capability do not expose posting', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const fixture = await mockDividends(page);
  await openWorkspace(page);
  await openSource(page);
  const review = await fill(page, '100.00', '');
  await review
    .getByRole('button', { name: 'Preview dividend journal', exact: true })
    .click();
  await expect(
    review.getByText(
      'Enter withholding tax explicitly, including a supported zero.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    review.getByRole('button', { name: 'Post reviewed dividend', exact: true }),
  ).toHaveCount(0);
  await review
    .getByRole('button', { name: 'Return to amount review', exact: true })
    .click();
  const withholding = review.getByRole('group', {
    name: 'Withholding tax',
    exact: true,
  });
  await withholding
    .getByRole('textbox', { name: 'Original currency amount', exact: true })
    .fill('15.00');
  await withholding
    .getByRole('combobox', { name: 'Original currency', exact: true })
    .selectOption('CAD');
  await withholding
    .getByRole('textbox', { name: 'Exact value as printed', exact: true })
    .fill('15.00');
  await withholding
    .getByRole('textbox', { name: 'Exact source column heading', exact: true })
    .fill('Tax');
  fixture.state.previewStatus = 403;
  await review
    .getByRole('button', { name: 'Preview dividend journal', exact: true })
    .click();
  await expect(
    page.getByRole('alert').filter({ hasText: /Loaded private details/u }),
  ).toBeVisible();
  await expect(review).toHaveCount(0);
  fixture.state.listStatus = 503;
  await page
    .getByRole('button', { name: 'Open cash dividends', exact: true })
    .click();
  await expect(
    page.getByRole('alert').filter({ hasText: /not available right now/u }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Review a cash dividend', exact: true }),
  ).toHaveCount(0);
  expect(
    fixture.writes.filter((write) => write.path.endsWith('/commit')),
  ).toHaveLength(0);
  await expectNoSeriousAccessibilityViolations(page);
});
test('a stale preview requires fresh source review and an unconfirmed posting retries only the same reviewed command', async ({
  page,
}) => {
  const fixture = await mockDividends(page);
  await openWorkspace(page);
  await openSource(page);
  const review = await fill(page);
  fixture.source.sourceRevision = 4;
  fixture.source.sourceSnapshotHash = 'b'.repeat(64);
  await review
    .getByRole('button', { name: 'Preview dividend journal', exact: true })
    .click();
  await expect(
    review.getByRole('button', {
      name: 'Refresh statement source',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    review.getByRole('button', { name: 'Post reviewed dividend', exact: true }),
  ).toHaveCount(0);
  await review
    .getByRole('button', { name: 'Refresh statement source', exact: true })
    .click();
  await expect(
    review.getByRole('heading', {
      name: 'Prepare a cash dividend',
      exact: true,
    }),
  ).toBeVisible();
  await fill(page);
  await review
    .getByRole('button', { name: 'Preview dividend journal', exact: true })
    .click();
  fixture.state.skipCommitOnce = true;
  await review.getByRole('checkbox').check();
  await review
    .getByRole('button', { name: 'Post reviewed dividend', exact: true })
    .click();
  await expect(
    review.getByRole('heading', {
      name: 'Check this posting outcome',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    review.getByRole('button', { name: 'Retry exact posting', exact: true }),
  ).toHaveCount(0);
  await review
    .getByRole('button', { name: 'Check saved dividend', exact: true })
    .click();
  await review
    .getByRole('button', { name: 'Retry exact posting', exact: true })
    .click();
  await expect(
    review.getByRole('heading', {
      name: 'Dividend posting confirmed',
      exact: true,
    }),
  ).toBeVisible();
  const commits = fixture.writes.filter((write) =>
    write.path.endsWith('/commit'),
  );
  expect(commits).toHaveLength(2);
  expect(commits[0]!.key).toBe(commits[1]!.key);
  expect(commits[0]!.body).toEqual(commits[1]!.body);
  expect(commits[1]!.body).toMatchObject({
    expectedSourceRevision: 4,
    sourceSnapshotHash: 'b'.repeat(64),
  });
  expect(fixture.actions).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

import { readFile, mkdir } from 'node:fs/promises';
import { expect, test, type Page, type Locator } from '@playwright/test';
import { SaveReviewedFinancePdfOcrMappingSchema } from '@emdo/contracts/browser';
import {
  mockAuthenticatedSession,
  expectNoSeriousAccessibilityViolations,
} from './support.js';
import {
  pdfOcrReviewFixture,
  pdfOcrReviewBytes,
  imageReviewIds,
  imageReviewCorrection,
} from '../test/finance-pdf-ocr-review-fixture.js';
const artifacts = '../../output/playwright/pdf-ocr';
async function mockImages(page: Page) {
  await mockAuthenticatedSession(page);
  const fixture = await pdfOcrReviewFixture(),
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
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
  await page.route('**/api/v2/finance/books**', async (route) => {
    const request = route.request(),
      body: unknown = request.method() === 'POST' ? request.postDataJSON() : {};
    if (request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe(
        'e2e-csrf-token-01234567890123456789',
      );
      expect(request.headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/u);
    }
    try {
      const result = fixture.handle(
        request.url(),
        request.method(),
        body,
        request.headers()['idempotency-key'] ?? '',
      );
      await route.fulfill({ status: result.status, json: result.json });
    } catch (cause) {
      if (
        cause instanceof TypeError &&
        cause.message.includes('response was lost')
      )
        return route.abort('failed');
      throw cause;
    }
  });
  return { ...fixture, errors };
}
async function openWorkspace(page: Page) {
  await page.goto('/finance');
  await page.getByLabel('Accounting book').selectOption(imageReviewIds.book);
  await page.getByRole('tab', { name: 'Reports & tax', exact: true }).click();
  await page
    .getByRole('button', { name: 'Open report standardization', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Refresh saved analyses', exact: true }),
  ).toBeEnabled();
}
async function openReview(page: Page) {
  await page
    .getByRole('button', {
      name: 'Open saved analysis: scanned-statement.pdf',
      exact: true,
    })
    .click();
  const detail = page.getByRole('region', {
    name: 'Saved analysis detail',
    exact: true,
  });
  await detail
    .getByRole('button', { name: 'Review original source', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  const review = page.getByRole('region', {
    name: 'Image source review',
    exact: true,
  });
  await page
    .getByRole('checkbox', { name: /I acknowledge that this candidate/ })
    .check();
  await expect(review).toContainText('0 / 7');
  return review;
}
async function nativePosition(page: Page, element: Locator) {
  await element.evaluate((value) =>
    value.scrollIntoView({ block: 'start', behavior: 'instant' }),
  );
  await expect
    .poll(() =>
      page
        .locator('.top-bar')
        .evaluate((value) => value.getBoundingClientRect().top),
    )
    .toBe(0);
}
test('scanned PDF page review renders real raster, preserves original and saves reviewed source-only candidate', async ({
  page,
}) => {
  test.setTimeout(45000);
  page.setDefaultTimeout(10000);
  await mkdir(artifacts, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  const fixture = await mockImages(page);
  await openWorkspace(page);
  const review = await openReview(page);
  await expect(
    page.getByRole('combobox', { name: 'Original PDF page' }),
  ).toHaveValue('2');
  await expect(
    page.getByText('Page 1 omitted from this candidate: ocr-unavailable.'),
  ).toBeVisible();
  for (const name of [
    'Heading 1: Date',
    'Heading 2: Description',
    'Heading 3: Amount',
    'Row 1, column 1: 2026-09-01',
    'Row 1, column 2: Coffee',
    'Row 1, column 3: 12.5O',
    'Currency context: CAD',
  ]) {
    await review
      .getByRole('button', { name: `Review ${name}`, exact: true })
      .click();
    const image = review.getByRole('img', {
      name: 'Original image: scanned-statement.pdf',
      exact: true,
    });
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBe(1100);
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalHeight))
      .toBe(160);
    if (name.includes('12.5O')) {
      await review
        .getByRole('textbox', {
          name: 'Text visible in this region',
          exact: true,
        })
        .fill('12.50');
      await expect(
        review.getByRole('checkbox', { name: /I checked this region/ }),
      ).toBeDisabled();
      await review
        .getByLabel(/Correction or missed-text explanation/)
        .fill(imageReviewCorrection);
      await page.screenshot({
        path: `${artifacts}/desktop-page2-correction.png`,
        fullPage: true,
      });
      await expect(review.locator('rect.is-selected')).toHaveAttribute(
        'x',
        '560',
      );
      await expect(review.locator('rect.is-selected')).toHaveAttribute(
        'y',
        '83',
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await review
        .getByRole('combobox', { name: 'Image zoom', exact: true })
        .selectOption('300');
      await nativePosition(
        page,
        review.locator('.finance-image-original-column'),
      );
      await page.screenshot({ path: `${artifacts}/mobile-page2-overlay.png` });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      await nativePosition(page, review.locator('.finance-image-cell-editor'));
      await page.screenshot({ path: `${artifacts}/mobile-correction.png` });
      await page.setViewportSize({ width: 1440, height: 1100 });
      await review
        .getByRole('combobox', { name: 'Image zoom', exact: true })
        .selectOption('100');
    }
    await review
      .getByRole('checkbox', { name: /I checked this region/ })
      .check();
    await review
      .getByRole('button', { name: 'Use reviewed cell', exact: true })
      .click();
  }
  await expectNoSeriousAccessibilityViolations(page);
  const downloadPromise = page.waitForEvent('download');
  await review
    .getByRole('button', { name: 'Download image original', exact: true })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('scanned-statement.pdf');
  const path = await download.path();
  expect(await readFile(path!)).toEqual(pdfOcrReviewBytes);
  await review
    .getByRole('button', { name: 'Continue to field meanings', exact: true })
    .click();
  await review
    .getByLabel('Image source review notes', { exact: false })
    .fill('Reviewed page2 cells and original PDF; page1 remains omitted.');
  await review
    .getByRole('button', {
      name: 'Preview selected transcription',
      exact: true,
    })
    .click();
  for (const name of [
    /I checked the selected text/,
    /I checked the headings/,
    /I reviewed unselected content/,
  ])
    await review.getByRole('checkbox', { name }).check();
  await review
    .getByRole('button', { name: 'Save reviewed image candidate', exact: true })
    .click();
  await expect
    .poll(
      () =>
        fixture.writes.filter((w) => w.path.endsWith('/report-mappings'))
          .length,
    )
    .toBe(1);
  const saved = SaveReviewedFinancePdfOcrMappingSchema.parse(
    fixture.writes.find((w) => w.path.endsWith('/report-mappings'))!.body,
  );
  expect(saved.proposal.definition.pdfOcrSelection?.pageNumber).toBe(2);
  expect(saved.proposal.definition.imageSelection).toBeUndefined();
  expect(saved).not.toHaveProperty('example');
  expect(
    saved.proposal.definition.pdfOcrSelection?.imageSelection.rows[0]!.cells[2]!
      .reviewedText,
  ).toBe('12.50');
  expect(fixture.writes.some((w) => /approve|import/.test(w.path))).toBe(false);
  await expect(
    page.getByRole('button', {
      name: 'Review PDF page regions and create a revised candidate',
      exact: true,
    }),
  ).toBeVisible();
  expect(fixture.getMapping()?.example.page).toBe(2);
  expect(fixture.getMapping()?.example.extractionReview?.version).toBe(
    'reviewed-pdf-ocr.v1',
  );
  await page
    .getByRole('button', {
      name: 'Review PDF page regions and create a revised candidate',
      exact: true,
    })
    .click();
  await page
    .getByRole('checkbox', { name: /I acknowledge that this candidate/ })
    .check();
  await expect(
    page.getByRole('combobox', { name: 'Original PDF page' }),
  ).toHaveValue('2');
  await expect(review).toContainText('0 / 7');
  await review
    .getByRole('button', { name: 'Review Heading 1: Date', exact: true })
    .click();
  await expect
    .poll(() =>
      review
        .getByRole('img')
        .evaluate((el: HTMLImageElement) => el.naturalWidth),
    )
    .toBe(1100);
  await page.screenshot({
    path: `${artifacts}/reopened-original-page2.png`,
    fullPage: true,
  });
  expect(fixture.errors).toEqual([]);
});
for (const revokedStatus of [401, 403])
  test(`revoked access ${revokedStatus} clears loaded PDF review and private raster`, async ({
    page,
  }) => {
    const fixture = await mockImages(page);
    await openWorkspace(page);
    const review = await openReview(page);
    await review
      .getByRole('button', { name: 'Review Heading 1: Date', exact: true })
      .click();
    await expect(review.getByRole('img')).toBeVisible();
    fixture.state.originalStatus = revokedStatus;
    await review
      .getByRole('button', { name: 'Download image original', exact: true })
      .click();
    await expect(
      page.getByRole('alert').filter({ hasText: /Current book access/ }),
    ).toBeVisible();
    await expect(review).toHaveCount(0);
    await expect(page.getByRole('img', { name: /Original image/ })).toHaveCount(
      0,
    );
    expect(fixture.writes).toHaveLength(0);
    expect(fixture.errors).toEqual([]);
  });

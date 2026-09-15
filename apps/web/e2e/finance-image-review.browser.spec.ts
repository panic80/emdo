import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Locator } from '@playwright/test';
import { SaveReviewedFinanceImageMappingSchema } from '@emdo/contracts/browser';
import {
  mockAuthenticatedSession,
  expectNoSeriousAccessibilityViolations,
} from './support.js';
import {
  imageReviewBytes,
  imageReviewCorrection,
  imageReviewFixture,
  imageReviewIds,
} from '../test/finance-image-review-fixture.js';

async function mockImages(page: Page) {
  await mockAuthenticatedSession(page);
  const fixture = imageReviewFixture(),
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
      name: 'Open saved analysis: image-statement.png',
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
test('image original, visual corrections, durable candidate and separate approval/import work on desktop and mobile', async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1440, height: 1100 });
  const fixture = await mockImages(page);
  fixture.state.hasRun = false;
  fixture.state.hasOriginal = false;
  fixture.state.loseSaveResponse = true;
  await openWorkspace(page);
  await page
    .getByLabel('Report or image original', { exact: true })
    .setInputFiles({
      name: 'image-statement.png',
      mimeType: 'image/png',
      buffer: imageReviewBytes,
    });
  await expect(
    page.getByRole('button', {
      name: 'Save original and start analysis',
      exact: true,
    }),
  ).toBeDisabled();
  await page.getByRole('checkbox', { name: /Allow EMDO to inspect/u }).check();
  await page
    .getByRole('button', {
      name: 'Save original and start analysis',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('region', { name: 'Saved analysis detail', exact: true }),
  ).toContainText('Proposal saved');
  expect(fixture.writes.map((write) => write.path.split('/').pop())).toEqual([
    'evidence',
    'standardizations',
  ]);
  await openWorkspace(page);
  const review = await openReview(page);
  await expect(
    review.getByRole('button', { name: /approve|post/iu }),
  ).toHaveCount(0);
  await review.screenshot({
    path: '/tmp/emdo-image-selected-table-desktop.png',
    animations: 'disabled',
  });
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
    const original = review.getByRole('img', {
      name: 'Original image: image-statement.png',
      exact: true,
    });
    await expect
      .poll(() =>
        original.evaluate((value: HTMLImageElement) => value.naturalWidth),
      )
      .toBe(1100);
    if (name.includes('12.5O')) {
      await review
        .getByLabel('Image zoom', { exact: true })
        .selectOption('200');
      await review
        .getByLabel('Text visible in this region', { exact: true })
        .fill('12.50');
      await expect(
        review.getByRole('checkbox', {
          name: 'I checked this region and its exact text against the original image.',
          exact: true,
        }),
      ).toBeDisabled();
      await review
        .getByLabel('Correction or missed-text explanation', { exact: false })
        .fill(imageReviewCorrection);
      const source = review.getByRole('region', {
        name: 'Review image cell: Row 1, column 3',
        exact: true,
      });
      const originalColumn = await source
          .locator('.finance-image-original-column')
          .boundingBox(),
        cellColumn = await source
          .locator('.finance-image-cell-editor')
          .boundingBox();
      expect(cellColumn!.x).toBeGreaterThan(
        originalColumn!.x + originalColumn!.width,
      );
      await source.screenshot({
        path: '/tmp/emdo-image-source-desktop.png',
        animations: 'disabled',
      });
      await expectNoSeriousAccessibilityViolations(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await review
        .getByLabel('Image zoom', { exact: true })
        .selectOption('300');
      await nativePosition(
        page,
        source.locator('.finance-image-original-column'),
      );
      await page.screenshot({
        path: '/tmp/emdo-image-original-mobile-native.png',
        animations: 'disabled',
      });
      await nativePosition(page, source.locator('.finance-image-cell-editor'));
      await page.screenshot({
        path: '/tmp/emdo-image-cell-mobile-native.png',
        animations: 'disabled',
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      await expectNoSeriousAccessibilityViolations(page);
      await review
        .getByRole('checkbox', {
          name: 'I checked this region and its exact text against the original image.',
          exact: true,
        })
        .focus();
      await page.keyboard.press('Space');
      await expect(
        review.getByRole('checkbox', {
          name: 'I checked this region and its exact text against the original image.',
          exact: true,
        }),
      ).toBeChecked();
      await page.setViewportSize({ width: 1440, height: 1100 });
    } else
      await review
        .getByRole('checkbox', {
          name: 'I checked this region and its exact text against the original image.',
          exact: true,
        })
        .check();
    await review
      .getByRole('button', { name: 'Use reviewed cell', exact: true })
      .click();
  }
  await expect(review).toContainText('7 / 7');
  await review
    .getByRole('button', { name: 'Continue to field meanings', exact: true })
    .click();
  await expect(
    review.getByLabel('Image mapping: Fee', { exact: true }),
  ).toBeVisible();
  await review
    .getByLabel('Image source review notes', { exact: false })
    .fill(
      'Verified the selected regions, date and decimal conventions, and omitted Currency heading against the original image.',
    );
  await review
    .getByRole('button', {
      name: 'Preview selected transcription',
      exact: true,
    })
    .click();
  await expect(
    review.getByRole('button', {
      name: 'Save reviewed image candidate',
      exact: true,
    }),
  ).toBeDisabled();
  await review.screenshot({
    path: '/tmp/emdo-image-candidate-desktop.png',
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await nativePosition(page, review.locator('.finance-image-active-panel'));
  await page.screenshot({
    path: '/tmp/emdo-image-candidate-mobile-native.png',
    animations: 'disabled',
  });
  await review.getByText('Unselected OCR words · 1', { exact: true }).click();
  await expect(review.locator('.finance-image-omissions')).toContainText(
    'Currency',
  );
  for (const name of [
    /I checked the selected text/u,
    /I checked the headings/u,
    /I reviewed unselected content/u,
  ])
    await review.getByRole('checkbox', { name }).check();
  await review
    .getByRole('button', { name: 'Save reviewed image candidate', exact: true })
    .click();
  await expect(review.getByRole('alert')).toBeVisible();
  await review
    .getByRole('button', { name: 'Save reviewed image candidate', exact: true })
    .click();
  const mapping = page.getByRole('region', {
    name: 'Selected mapping review',
    exact: true,
  });
  await expect(
    mapping.getByRole('heading', {
      name: 'Mapping v1 · candidate',
      exact: true,
    }),
  ).toBeVisible();
  const saves = fixture.writes.filter((write) =>
    write.path.endsWith('/report-mappings'),
  );
  expect(saves).toHaveLength(2);
  expect(saves[0]!.key).toBe(saves[1]!.key);
  expect(saves[0]!.body).toEqual(saves[1]!.body);
  const payload = SaveReviewedFinanceImageMappingSchema.parse(saves[1]!.body);
  expect(
    payload.proposal.definition.imageSelection!.rows[0]!.cells[2],
  ).toMatchObject({
    reviewedText: '12.50',
    correctionReason: imageReviewCorrection,
    words: [{ text: '12.5O' }],
  });
  expect(payload).not.toHaveProperty('example');
  expect(payload).not.toHaveProperty('decision');
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Reviewed IMAGE candidate saved' }),
  ).toBeVisible();
  expect(fixture.getMapping()!.validation.status).toBe('normalized');
  expect(fixture.getMapping()!.validation.rows[0]!.fields).toMatchObject({
    amount: '12.5',
    currency: 'CAD',
  });
  expect(fixture.run.reviewedMapping?.mappingId).toBe(imageReviewIds.mapping);
  expect(
    fixture.writes.some((write) => /\/review$|\/import$/u.test(write.path)),
  ).toBe(false);
  await expectNoSeriousAccessibilityViolations(page);
  await mapping
    .getByLabel('Mapping decision', { exact: true })
    .selectOption('approve');
  await mapping
    .getByLabel('Review reason', { exact: true })
    .fill(
      'Verified source-derived validation, exact pixel regions and the recorded visual correction.',
    );
  await mapping
    .getByRole('button', { name: 'Save mapping decision', exact: true })
    .click();
  await mapping
    .getByRole('button', { name: 'Choose account for reuse', exact: true })
    .click();
  await expect(
    mapping
      .getByLabel('Saved report to standardize', { exact: true })
      .getByRole('option'),
  ).toHaveCount(2);
  await mapping
    .getByLabel('Saved report to standardize', { exact: true })
    .selectOption(imageReviewIds.evidence);
  await mapping
    .getByLabel('Report financial account', { exact: true })
    .selectOption(imageReviewIds.account);
  await mapping
    .getByLabel('Report provider', { exact: true })
    .fill('Example Bank');
  await mapping
    .getByRole('button', { name: 'Standardize for import review', exact: true })
    .click();
  await expect(mapping).toContainText('No transactions have been posted.');
  await openWorkspace(page);
  await page
    .getByRole('button', {
      name: 'Open saved analysis: image-statement.png',
      exact: true,
    })
    .click();
  const download = page.waitForEvent('download');
  await page
    .getByRole('region', { name: 'Saved analysis detail', exact: true })
    .getByRole('button', { name: 'Download analysis original', exact: true })
    .click();
  const original = await download;
  expect(original.suggestedFilename()).toBe('image-statement.png');
  expect(await readFile((await original.path())!)).toEqual(imageReviewBytes);
  expect(fixture.errors).toEqual([]);
});
test('a blocked image run with no OCR words supports explicit pixel review and current denial clears the original', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const fixture = await mockImages(page);
  fixture.run.proposal = null;
  fixture.run.modelProvenance = null;
  fixture.run.status = 'blocked';
  fixture.inspection.facts.status = 'no-text';
  fixture.inspection.facts.qualityStatus = 'unreadable';
  fixture.inspection.facts.words = [];
  fixture.inspection.facts.text = '';
  fixture.inspection.wordInventoryDigest = createHash('sha256')
    .update('[]')
    .digest('hex');
  fixture.inspection.extractionDigest = createHash('sha256')
    .update(JSON.stringify(fixture.inspection.facts))
    .digest('hex');
  fixture.run.extraction!.extractionDigest =
    fixture.inspection.extractionDigest;
  await openWorkspace(page);
  await page
    .getByRole('button', {
      name: 'Open saved analysis: image-statement.png',
      exact: true,
    })
    .click();
  await page
    .getByRole('region', { name: 'Saved analysis detail', exact: true })
    .getByRole('button', { name: 'Review original source', exact: true })
    .click();
  const review = page.getByRole('region', {
    name: 'Image source review',
    exact: true,
  });
  await expect(review).toContainText('OCR found no readable words.');
  await review
    .getByRole('button', { name: 'Add source column', exact: true })
    .click();
  await expect
    .poll(() =>
      review
        .getByRole('img')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1100);
  await review
    .getByRole('button', { name: 'Draw pixel region', exact: true })
    .click();
  const svg = review.locator('.finance-image-pixels svg');
  await svg.scrollIntoViewIfNeeded();
  const bounds = (await svg.boundingBox())!;
  await page.mouse.move(
    bounds.x + (15 / 1100) * bounds.width,
    bounds.y + (20 / 160) * bounds.height,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + (99 / 1100) * bounds.width,
    bounds.y + (60 / 160) * bounds.height,
  );
  await page.mouse.up();
  await expect(review.getByLabel('Left · px', { exact: true })).not.toHaveValue(
    '',
  );
  for (const [name, value] of [
    ['Left · px', '20'],
    ['Top · px', '24'],
    ['Width · px', '74'],
    ['Height · px', '26'],
  ])
    await review.getByLabel(name!, { exact: true }).fill(value!);
  await review
    .getByRole('button', { name: 'Use pixel region', exact: true })
    .click();
  await review
    .getByLabel('Text visible in this region', { exact: true })
    .fill('Date');
  await expect(
    review.getByRole('checkbox', { name: /I checked this region/u }),
  ).toBeDisabled();
  await review
    .getByLabel('Correction or missed-text explanation', { exact: false })
    .fill('The Date heading is visible at this exact region. OCR missed it.');
  await review
    .getByRole('checkbox', { name: /I checked this region/u })
    .check();
  await review
    .getByRole('button', { name: 'Use reviewed cell', exact: true })
    .click();
  await expect(
    review.getByRole('button', { name: 'Review Heading 1: Date', exact: true }),
  ).toContainText('Visually confirmed');
  expect(fixture.writes).toHaveLength(0);
  await expectNoSeriousAccessibilityViolations(page);
  fixture.state.originalStatus = 403;
  await review
    .getByRole('button', { name: 'Download image original', exact: true })
    .click();
  await expect(
    page.getByRole('alert').filter({ hasText: /Current book access/u }),
  ).toBeVisible();
  await expect(review).toHaveCount(0);
  await expect(page.getByRole('img', { name: /Original image/u })).toHaveCount(
    0,
  );
  expect(fixture.errors).toEqual([]);
});
test('unavailable image inspection leaves the original saved without inventing source cells', async ({
  page,
}) => {
  const fixture = await mockImages(page);
  fixture.state.inspectionStatus = 503;
  await openWorkspace(page);
  await page
    .getByRole('button', {
      name: 'Open saved analysis: image-statement.png',
      exact: true,
    })
    .click();
  await page
    .getByRole('region', { name: 'Saved analysis detail', exact: true })
    .getByRole('button', { name: 'Review original source', exact: true })
    .click();
  const review = page.getByRole('region', {
    name: 'Image source review',
    exact: true,
  });
  await expect(review.getByRole('alert')).toContainText(
    'Saved image inspection is not available right now.',
  );
  await expect(review.getByRole('table')).toHaveCount(0);
  await expect(
    review.getByRole('button', {
      name: 'Save reviewed image candidate',
      exact: true,
    }),
  ).toHaveCount(0);
  expect(fixture.writes).toHaveLength(0);
  await expectNoSeriousAccessibilityViolations(page);
});

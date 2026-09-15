import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { SaveFinanceReportMappingFromSourceSchema } from '@emdo/contracts/browser';
import {
  mockAuthenticatedSession,
  expectNoSeriousAccessibilityViolations,
} from './support.js';
import {
  standardizationFixture,
  standardizationBookId as bookId,
  standardizationEvidenceId as evidenceId,
  standardizationMappingId as mappingId,
  standardizationCsv,
  standardizationDigest,
  standardizationDefinition,
} from '../test/finance-standardization-fixture.js';
import {
  reconciliationFixture,
  reservationId,
  receiptId,
} from '../test/finance-reconciliation-fixture.js';

const revisedId = '73000000-0000-4000-8000-000000000009';
async function mockStandardization(page: Page, role = 'administrator') {
  await mockAuthenticatedSession(page);
  const fixture = standardizationFixture();
  fixture.state.canManage = role !== 'viewer';
  const writes: { path: string; body: Record<string, unknown>; key: string }[] =
    [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const makeMapping = (id: string, version: number) => ({
    id,
    evidence_id: evidenceId,
    evidence_format: 'csv',
    evidence_filename: 'activity.csv',
    providerKey: 'Example bank',
    reportName: 'Account activity',
    version,
    revision: 1,
    status: 'candidate',
    validationStatus: 'normalized',
    proposed_by_model: version === 1 ? 'gpt-6-astra' : null,
    rationale: 'Confirmed from the exact saved CSV original.',
    unresolved_questions:
      version === 1
        ? ['Confirm whether positive amounts represent receipts.']
        : [],
    definition: standardizationDefinition,
    example: {
      headers: standardizationDefinition.headers,
      rows: [
        {
          sourceRow: 2,
          cells: ['2026-01-01', 'Reviewed payment', '10.00', 'CAD'],
        },
      ],
    },
    validation: {
      status: 'normalized',
      issues: [],
      rows: [
        {
          sourceRow: 2,
          fields: {
            transactionDate: '2026-01-01',
            description: 'Reviewed payment',
            amount: '10.00',
            currency: 'CAD',
          },
          issues: [],
        },
      ],
    },
  });
  const originalMapping = makeMapping(mappingId, 1),
    revisedMapping = makeMapping(revisedId, 2);
  let sourceSaved = false,
    loseLinkResponse = false;
  const state = {
    setLoseLink: () => {
      loseLinkResponse = true;
    },
  };
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
  await page.route('**/api/v2/finance/books**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>,
        key = req.headers()['idempotency-key']!;
      expect(req.headers()['x-csrf-token']).toBe(
        'e2e-csrf-token-01234567890123456789',
      );
      expect(key).toMatch(/^[a-f0-9-]{36}$/u);
      writes.push({ path, body, key });
      if (path.endsWith('/report-mappings/from-source')) {
        const input = SaveFinanceReportMappingFromSourceSchema.parse(body);
        expect(input.evidenceId).toBe(evidenceId);
        expect(input.expectedSourceDigest).toBe(standardizationDigest);
        expect(Object.keys(input)).toEqual([
          'evidenceId',
          'expectedSourceDigest',
          'proposal',
        ]);
        expect(input.proposal.definition.headers).toEqual(
          standardizationDefinition.headers,
        );
        expect(input.proposal.unresolvedQuestions).toEqual([]);
        sourceSaved = true;
        revisedMapping.definition = input.proposal.definition;
        return route.fulfill({ json: { id: revisedId, status: 'candidate' } });
      }
      if (path.endsWith('/reviewed-mapping')) {
        const run = fixture.runs[0]!;
        expect(sourceSaved).toBe(true);
        expect(body).toEqual({
          expectedRevision: run.revision,
          mappingId: revisedId,
        });
        run.revision++;
        run.reviewedMapping = {
          mappingId: revisedId,
          mappingVersion: 2,
          status: 'candidate',
        };
        fixture.updateRun(run, run.status);
        if (loseLinkResponse) {
          loseLinkResponse = false;
          return route.abort('failed');
        }
        return route.fulfill({ json: run });
      }
      if (path.endsWith(`/report-mappings/${revisedId}/review`)) {
        expect(sourceSaved).toBe(true);
        expect(body).toMatchObject({
          expectedRevision: 1,
          decision: 'approve',
        });
        revisedMapping.status = 'approved';
        revisedMapping.revision++;
        fixture.runs[0]!.reviewedMapping!.status = 'approved';
        return route.fulfill({ json: { id: revisedId, status: 'approved' } });
      }
      if (path.endsWith(`/report-mappings/${revisedId}/import`)) {
        expect(revisedMapping.status).toBe('approved');
        expect(body).toMatchObject({
          evidenceId,
          expectedMappingVersion: 2,
          financialAccountId: bookId,
        });
        return route.fulfill({ json: { id: evidenceId, status: 'review' } });
      }
      try {
        const result = fixture.handle(req.url(), req.method(), body);
        return route.fulfill({ status: result.status, json: result.json });
      } catch (cause) {
        if (cause instanceof TypeError) return route.abort('failed');
        throw cause;
      }
    }
    if (
      path.includes('/standardizations') ||
      path.endsWith('/evidence') ||
      path.endsWith(`/evidence/${evidenceId}`)
    ) {
      const result = fixture.handle(req.url());
      return route.fulfill({ status: result.status, json: result.json });
    }
    const json = path.endsWith('/books')
      ? {
          books: [
            {
              id: bookId,
              name: 'Operations',
              entityName: 'Example Company',
              country: 'CA',
              functionalCurrency: 'CAD',
              role,
            },
          ],
        }
      : path.endsWith('/report-mappings')
        ? {
            mappings: fixture.runs[0]?.proposal
              ? [...(sourceSaved ? [revisedMapping] : []), originalMapping]
              : [],
            nextOffset: null,
          }
        : path.endsWith(`/report-mappings/${mappingId}`)
          ? { mapping: originalMapping, reviews: [] }
          : path.endsWith(`/report-mappings/${revisedId}`)
            ? {
                mapping: revisedMapping,
                reviews:
                  revisedMapping.status === 'approved'
                    ? [
                        {
                          revision: 2,
                          decision: 'approve',
                          reason: 'Checked the source-derived candidate.',
                        },
                      ]
                    : [],
              }
            : path.endsWith('/financial-accounts')
              ? {
                  accounts: [
                    { id: bookId, name: 'Operating bank', currency: 'CAD' },
                  ],
                }
              : { trialBalance: [], periods: [], journals: [] };
    return route.fulfill({ json });
  });
  return { ...fixture, writes, errors, ...state };
}
async function openWorkspace(page: Page) {
  await page.goto('/finance');
  await page.getByLabel('Accounting book').selectOption(bookId);
  await page.getByRole('tab', { name: 'Reports & tax', exact: true }).click();
  await page
    .getByRole('button', { name: 'Open report standardization' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Refresh saved analyses' }),
  ).toBeEnabled();
}
async function openAnalysis(page: Page, filename = 'activity.csv') {
  await page
    .getByRole('button', { name: `Open saved analysis: ${filename}` })
    .click();
  const detail = page.getByRole('region', { name: 'Saved analysis detail' });
  await expect(
    detail.getByRole('heading', { name: filename, exact: true }),
  ).toBeFocused();
  if (page.viewportSize()!.width < 1024)
    await expect
      .poll(async () => (await page.locator('.top-bar').boundingBox())?.y)
      .toBe(0);
  return detail;
}
test('saved CSV analysis resumes after reload, source review creates and links a new candidate, and approval/import stay separate', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const fixture = await mockStandardization(page);
  await openWorkspace(page);
  await page.getByLabel('Report or image original').setInputFiles({
    name: 'activity.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(standardizationCsv),
  });
  await expect(
    page.getByRole('button', { name: 'Save original and start analysis' }),
  ).toBeDisabled();
  await page.getByRole('checkbox', { name: /Allow EMDO to inspect/u }).check();
  await page
    .getByRole('button', { name: 'Save original and start analysis' })
    .click();
  await expect(
    page.getByRole('region', { name: 'Saved analysis detail' }),
  ).toContainText('Waiting to start');
  expect(fixture.writes.map((write) => write.path.split('/').pop())).toEqual([
    'evidence',
    'standardizations',
  ]);
  fixture.updateRun(fixture.runs[0]!, 'needs-review');
  await page.getByRole('button', { name: 'Refresh saved analyses' }).click();
  const detail = page.getByRole('region', { name: 'Saved analysis detail' });
  await expect(detail).toContainText('Proposal saved');
  await expect(detail).toContainText(
    'Confirm whether positive amounts represent receipts.',
  );
  await expect(
    detail.getByRole('button', { name: /approve|import/iu }),
  ).toHaveCount(0);
  await expectNoSeriousAccessibilityViolations(page);
  await page
    .locator('.finance-standardization')
    .screenshot({ path: '/tmp/emdo-standardization-desktop.png' });
  await openWorkspace(page);
  await openAnalysis(page);
  await detail.getByRole('button', { name: 'Review original source' }).focus();
  await page.keyboard.press('Enter');
  const review = page.getByRole('region', {
    name: 'CSV source review',
    exact: true,
  });
  await expect(review.getByLabel('Original CSV text')).toHaveText(
    standardizationCsv,
  );
  await expect(
    page.getByRole('region', { name: 'Selected CSV source review' }),
  ).toBeFocused();
  await review.screenshot({
    path: '/tmp/emdo-standardization-csv-review-desktop.png',
  });
  const downloadPromise = page.waitForEvent('download');
  await review.getByRole('button', { name: 'Download original CSV' }).click();
  const download = await downloadPromise;
  expect(await readFile((await download.path())!, 'utf8')).toBe(
    standardizationCsv,
  );
  await expect(
    review.getByRole('button', { name: 'Save reviewed CSV candidate' }),
  ).toBeDisabled();
  await review
    .getByLabel('Confirm whether positive amounts represent receipts.')
    .fill(
      'The source lists receipts as positive amounts; checked the complete original.',
    );
  await review
    .getByLabel('Source review notes')
    .fill(
      'Checked the exact headings, all source rows, ISO dates, signs and CAD currency.',
    );
  await review.getByRole('checkbox').check();
  fixture.setLoseLink();
  await review
    .getByRole('button', { name: 'Save reviewed CSV candidate' })
    .click();
  await expect(
    page.getByRole('region', { name: 'Selected mapping review' }),
  ).toContainText('Mapping v2 · candidate');
  await expect(
    page.getByRole('button', { name: 'Check saved candidate link' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Check saved candidate link' })
    .click();
  await expect(
    page.getByText(
      'Reviewed candidate linked to the saved analysis. No approval or import was performed.',
    ),
  ).toBeVisible();
  expect(
    fixture.writes.filter((write) => write.path.endsWith('/from-source')),
  ).toHaveLength(1);
  expect(
    fixture.writes.filter((write) => write.path.endsWith('/reviewed-mapping')),
  ).toHaveLength(1);
  await openWorkspace(page);
  await openAnalysis(page);
  await expect(detail).toContainText('Reviewed candidate linked · v2');
  await detail.getByRole('button', { name: 'Open mapping review' }).click();
  const selected = page.getByRole('region', {
    name: 'Selected mapping review',
  });
  await expect(selected).toContainText('Mapping v2 · candidate');
  expect(
    fixture.writes.filter((write) => write.path.endsWith('/review')),
  ).toHaveLength(0);
  await selected
    .getByLabel('Review reason')
    .fill(
      'Verified the source-derived example and the resolved meaning of all mapped fields.',
    );
  await selected.getByRole('button', { name: 'Save mapping decision' }).click();
  await expect(selected).toContainText('Mapping v2 · approved');
  await selected
    .getByRole('button', { name: 'Choose account for reuse' })
    .click();
  await selected
    .getByLabel('Saved report to standardize')
    .selectOption(evidenceId);
  await selected.getByLabel('Report financial account').selectOption(bookId);
  await selected
    .getByLabel('Report provider', { exact: true })
    .fill('Example bank');
  await selected
    .getByRole('button', { name: 'Standardize for import review' })
    .click();
  await expect(selected.getByText(/Saved import reference:/u)).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
  expect(
    fixture.writes.filter((write) => write.path.endsWith('/import')),
  ).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});
test('mobile saved analysis supports keyboard review, reduced motion and exact-source recovery without overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const fixture = await mockStandardization(page);
  fixture.createRun('needs-review');
  await openWorkspace(page);
  const detail = await openAnalysis(page);
  await page.screenshot({
    path: '/tmp/emdo-standardization-mobile-native.png',
  });
  await detail.getByRole('button', { name: 'Review original source' }).focus();
  await page.keyboard.press('Enter');
  const review = page.getByRole('region', {
    name: 'CSV source review',
    exact: true,
  });
  await expect(review.getByLabel('Original CSV text')).toBeVisible();
  await page.screenshot({
    path: '/tmp/emdo-standardization-csv-mobile-native.png',
  });
  await review.screenshot({
    path: '/tmp/emdo-standardization-csv-mobile-full.png',
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expectNoSeriousAccessibilityViolations(page);
  expect(
    await page
      .locator('.finance-standardization-detail')
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
  await review.getByRole('button', { name: 'Close CSV review' }).click();
  fixture.updateRun(fixture.runs[0]!, 'blocked');
  await page.getByRole('button', { name: 'Refresh saved analyses' }).click();
  await detail.getByRole('button', { name: 'Review retry' }).click();
  let confirmation = page.getByRole('region', {
    name: 'Confirm saved analysis action',
  });
  await expect(
    confirmation.getByRole('button', { name: 'Retry saved analysis' }),
  ).toBeDisabled();
  await confirmation.getByRole('checkbox').check();
  await confirmation
    .getByRole('button', { name: 'Retry saved analysis' })
    .click();
  await expect(detail).toContainText('Waiting to start');
  await detail.getByRole('button', { name: 'Review cancellation' }).click();
  confirmation = page.getByRole('region', {
    name: 'Confirm saved analysis action',
  });
  await confirmation.getByRole('checkbox').check();
  await confirmation
    .getByRole('button', { name: 'Cancel saved analysis' })
    .click();
  await expect(detail).toContainText('Cancelled');
  expect(fixture.writes.map((write) => write.body.expectedRevision)).toEqual([
    1, 2,
  ]);
  expect(fixture.errors).toEqual([]);
});
test('read-only, unavailable and OCR states remain honest and current permission loss clears private details', async ({
  page,
}) => {
  const fixture = await mockStandardization(page, 'viewer');
  const run = fixture.createRun('needs-review');
  await openWorkspace(page);
  const detail = await openAnalysis(page);
  await expect(
    page.getByRole('button', { name: 'Save original report' }),
  ).toHaveCount(0);
  await expect(
    detail.getByRole('button', { name: 'Download original for review' }),
  ).toBeVisible();
  await detail.getByRole('button', { name: 'Open mapping review' }).click();
  await expect(
    page.getByRole('button', { name: 'Save mapping decision' }),
  ).toHaveCount(0);
  fixture.updateRun(run, 'blocked');
  run.extraction!.status = 'needs-ocr';
  run.blockers = [
    'Image-only content needs an OCR service, which is not available.',
  ];
  await page.getByRole('button', { name: 'Refresh saved analyses' }).click();
  await expect(detail).toContainText('Image-only content needs OCR.');
  await expect(
    detail.getByRole('button', { name: 'Review retry' }),
  ).toHaveCount(0);
  fixture.state.readStatus = 503;
  await page.getByRole('button', { name: 'Refresh saved analyses' }).click();
  await expect(
    page.getByText(/Saved report analysis is not available right now/u),
  ).toBeVisible();
  await expect(page.getByText('No saved analyses on this page')).toHaveCount(0);
  fixture.state.readStatus = 200;
  fixture.state.ready = false;
  await page.getByRole('button', { name: 'Refresh saved analyses' }).click();
  await expect(
    page.getByText('Background analysis is not available right now.'),
  ).toBeVisible();
  fixture.state.readStatus = 403;
  await page.getByRole('button', { name: 'Refresh saved analyses' }).click();
  await expect(
    page.getByRole('region', { name: 'Saved analysis detail' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Selected mapping review' }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/Current book access does not permit this analysis/u),
  ).toBeVisible();
  expect(fixture.writes).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
test('a saved XLSX proposal without a mapping record opens fresh source review directly', async ({
  page,
}) => {
  const fixture = await mockStandardization(page);
  const run = fixture.createRun('needs-review', 'xlsx');
  expect(run.proposal!.mappingId).toBeNull();
  await openWorkspace(page);
  const detail = await openAnalysis(page, 'activity.xlsx');
  await expect(
    detail.getByRole('button', { name: 'Open mapping review' }),
  ).toHaveCount(0);
  await detail.getByRole('button', { name: 'Review original source' }).click();
  const review = page.getByRole('region', {
    name: 'Selected XLSX source review',
  });
  await expect(review).toBeFocused();
  await review
    .getByText('Review XLSX source and create a revised candidate')
    .click();
  await expect(review.getByLabel('Worksheet name')).toBeVisible();
  const boxes = review.getByRole('checkbox');
  for (const box of await boxes.all()) await expect(box).not.toBeChecked();
  expect(fixture.writes).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
test('administrator receipt review survives reload and resolves only its evidenced actual cost', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const fixture = await mockStandardization(page),
    run = fixture.createRun('indeterminate'),
    outcome = reconciliationFixture(run);
  const writes: Array<Record<string, unknown>> = [];
  await page.route('**/standardizations/*/reconciliation**', async (route) => {
    const request = route.request(),
      body =
        request.method() === 'POST'
          ? (request.postDataJSON() as Record<string, unknown>)
          : {};
    if (request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe(
        'e2e-csrf-token-01234567890123456789',
      );
      expect(request.headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/u);
      writes.push(body);
    }
    const result = outcome.handle(
      request.method(),
      body,
      new URL(request.url()).pathname,
    );
    return route.fulfill({ status: result.status, json: result.json });
  });
  await openWorkspace(page);
  await openAnalysis(page);
  const panel = page.getByRole('region', {
    name: 'Analysis outcome reconciliation',
  });
  await panel.getByRole('button', { name: 'Review outcome evidence' }).click();
  await panel.getByRole('radio', { name: /Attempt 1/u }).check();
  await expect(
    panel.getByRole('button', { name: 'Review not-sent resolution' }),
  ).toHaveCount(0);
  await panel.getByRole('button', { name: 'Request provider receipt' }).click();
  await expect(
    panel.getByText('Receipt requested', { exact: true }),
  ).toBeVisible();
  await openWorkspace(page);
  await openAnalysis(page);
  await panel.getByRole('button', { name: 'Review outcome evidence' }).click();
  await panel.getByRole('radio', { name: /Attempt 1/u }).check();
  await expect(
    panel.getByText('Receipt requested', { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([{ expectedRevision: 1, reservationId }]);
  outcome.addReceipt('verified');
  await panel.getByRole('button', { name: 'Refresh outcome evidence' }).click();
  await panel
    .getByRole('radio', {
      name: 'Use this verified receipt for the cost review',
    })
    .check();
  await panel.getByRole('button', { name: 'Review recorded cost' }).click();
  const confirmation = panel.getByRole('region', {
    name: 'Confirm analysis outcome resolution',
  });
  await expect(confirmation).toContainText('CAD 0.04');
  await expect(
    confirmation.getByRole('button', { name: 'Save outcome resolution' }),
  ).toBeDisabled();
  await panel.screenshot({
    path: '/tmp/emdo-standardization-outcome-desktop.png',
  });
  await expectNoSeriousAccessibilityViolations(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await confirmation.getByRole('checkbox').focus();
  await expect
    .poll(async () => (await page.locator('.top-bar').boundingBox())?.y)
    .toBe(0);
  await page.screenshot({
    path: '/tmp/emdo-standardization-outcome-mobile-native.png',
  });
  await panel.screenshot({
    path: '/tmp/emdo-standardization-outcome-mobile-full.png',
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expectNoSeriousAccessibilityViolations(page);
  await page.keyboard.press('Space');
  await confirmation
    .getByRole('button', { name: 'Save outcome resolution' })
    .click();
  await expect(panel.getByText(/Outcome resolution saved/u)).toBeVisible();
  expect(writes[1]).toEqual({
    expectedRevision: 1,
    reservationId,
    decision: 'accept-actual-cost',
    receiptId,
    acknowledgeNoApproval: true,
  });
  expect(run.status).toBe('blocked');
  expect(fixture.writes).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
test('a cancelled analysis needs explicit not-sent proof and permission loss clears its cost evidence', async ({
  page,
}) => {
  const fixture = await mockStandardization(page),
    run = fixture.createRun('cancelled'),
    outcome = reconciliationFixture(run);
  outcome.record.spend = [];
  outcome.record.hasLiveLease = true;
  const writes: Array<Record<string, unknown>> = [];
  await page.route('**/standardizations/*/reconciliation**', async (route) => {
    const request = route.request(),
      body =
        request.method() === 'POST'
          ? (request.postDataJSON() as Record<string, unknown>)
          : {};
    if (request.method() === 'POST') writes.push(body);
    const result = outcome.handle(
      request.method(),
      body,
      new URL(request.url()).pathname,
    );
    return route.fulfill({ status: result.status, json: result.json });
  });
  await openWorkspace(page);
  await openAnalysis(page);
  const panel = page.getByRole('region', {
    name: 'Analysis outcome reconciliation',
  });
  await panel.getByRole('button', { name: 'Review outcome evidence' }).click();
  await expect(
    panel.getByText(/analysis is still being processed/u),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Review not-sent resolution' }),
  ).toHaveCount(0);
  outcome.record.hasLiveLease = false;
  await panel.getByRole('button', { name: 'Refresh outcome evidence' }).click();
  await panel
    .getByRole('button', { name: 'Review not-sent resolution' })
    .click();
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Save outcome resolution' }).click();
  await expect(panel.getByText(/Outcome resolution saved/u)).toBeVisible();
  expect(writes).toEqual([
    {
      expectedRevision: 1,
      reservationId: null,
      decision: 'confirm-not-sent',
      receiptId: null,
      acknowledgeNoApproval: true,
    },
  ]);
  expect(run.status).toBe('cancelled');
  await expect(page.getByRole('button', { name: 'Review retry' })).toHaveCount(
    0,
  );
  outcome.state.readStatus = 403;
  await panel.getByRole('button', { name: 'Refresh outcome evidence' }).click();
  await expect(
    panel.getByText(/Administrator access is required/u),
  ).toBeVisible();
  await expect(panel.getByText('Saved resolution history · 1')).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});
test('CSV source review exposes optional fields without guessing an omitted fee and keeps omissions visible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const fixture = await mockStandardization(page),
    run = fixture.createRun('needs-review');
  const csv =
    'Date,Memo,Amount,Currency,Fee\n2026-01-01,Receipt,10.00,CAD,0.25\n';
  run.sourceDigest = createHash('sha256').update(csv).digest('hex');
  run.extraction!.sourceDigest = run.sourceDigest;
  run.proposal!.definition = {
    ...standardizationDefinition,
    headers: [...standardizationDefinition.headers, 'Fee'],
  };
  await page.route(`**/evidence/${evidenceId}`, (route) =>
    route.fulfill({
      json: { filename: 'activity.csv', format: 'csv', sourceText: csv },
    }),
  );
  await openWorkspace(page);
  const detail = await openAnalysis(page);
  await detail.getByRole('button', { name: 'Review original source' }).click();
  const review = page.getByRole('region', {
    name: 'CSV source review',
    exact: true,
  });
  await expect(review.getByText('Column 5: Fee')).toBeVisible();
  await review.getByLabel('Optional financial field').selectOption('fee');
  await review.getByRole('button', { name: 'Add financial field' }).click();
  await expect(
    review.getByRole('combobox', { name: 'Fee', exact: true }),
  ).toBeFocused();
  await expect(
    review.getByRole('combobox', { name: 'Fee', exact: true }),
  ).toHaveValue('');
  await review
    .getByRole('combobox', { name: 'Fee', exact: true })
    .selectOption('Fee');
  await expect(review.getByText('Column 5: Fee')).toHaveCount(0);
  await expect(
    review.getByRole('button', { name: 'Remove Amount mapping' }),
  ).toHaveCount(0);
  await review.getByRole('button', { name: 'Remove Fee mapping' }).click();
  await expect(review.getByText('Column 5: Fee')).toBeVisible();
  await review
    .getByText('Unmapped source headings · 1')
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/emdo-csv-unmapped-mobile-native.png' });
  await expectNoSeriousAccessibilityViolations(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(fixture.writes).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

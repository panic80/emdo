import { expect, test, type Page } from '@playwright/test';
import {
  pdfBlankPageInspection,
  pdfReviewBookId as bookId,
  pdfReviewEvidenceId as evidenceId,
  pdfReviewMappingId as mappingId,
  pdfReviewFixture,
} from '../test/finance-pdf-review-fixture.js';
import {
  mockAuthenticatedSession,
  expectNoSeriousAccessibilityViolations,
} from './support.js';

async function mockPdfReview(page: Page, retryFirstSave = false) {
  await mockAuthenticatedSession(page);
  const fixture = pdfReviewFixture();
  const mapping = {
    id: mappingId,
    evidence_id: evidenceId,
    evidence_format: 'pdf',
    evidence_filename: 'statement.pdf',
    providerKey: 'Example',
    reportName: 'Account activity',
    version: 1,
    revision: 1,
    status: 'candidate',
    validationStatus: 'normalized',
    proposed_by_model: 'gpt-6-astra',
    rationale:
      'Proposed whole-span selection; human source review is required.',
    unresolved_questions: ['Does CAD apply to every selected row?'],
    definition: fixture.definition,
    example: {
      headers: fixture.definition.headers,
      rows: [
        { sourceRow: 1, cells: ['2026-09-13', 'Coffee beans', '-12.3400'] },
      ],
    },
    validation: {
      status: 'normalized',
      issues: [],
      rows: [
        {
          sourceRow: 1,
          fields: { amount: '-12.34', currency: 'CAD' },
          provenance: { amount: { sourceAnchor: 'pdf-page-1:spans-6' } },
          issues: [],
        },
      ],
    },
  };
  const writes: { path: string; body: Record<string, unknown>; key: string }[] =
    [];
  const errors: string[] = [],
    turns: Record<string, unknown>[] = [];
  let attempts = 0;
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
  await page.route('**/api/v1/turns', (route) => {
    const body = route.request().postDataJSON();
    turns.push(body);
    expect(body.message).toContain('definition.pdfSelection');
    expect(body.message).toContain(
      'Always leave an unresolved human source-review question',
    );
    expect(body.message).toContain(
      'do not approve the mapping, import a report, or post financial records',
    );
    expect(body.routeHint).toBe('finance');
    return route.fulfill({
      json: {
        schemaVersion: 1,
        runId: 'pdf-proposal',
        status: 'accepted',
        replayed: false,
        eventsPath: '/api/v1/runs/pdf-proposal/events',
      },
    });
  });
  await page.route('**/api/v1/runs/*/events', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `id: 1\nevent: run.completed\ndata: ${JSON.stringify({ type: 'run.completed', data: { status: 'completed', output: { summary: 'A whole-span PDF candidate is ready for human source review.' } } })}\n\n`,
    }),
  );
  await page.route('**/api/v2/finance/books**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe(
        'e2e-csrf-token-01234567890123456789',
      );
      const key = request.headers()['idempotency-key']!;
      expect(key).toMatch(/^[a-f0-9-]{36}$/u);
      const body = request.postDataJSON();
      writes.push({ path, body, key });
      if (path.endsWith('/report-mappings')) {
        expect(Object.keys(body)).toEqual(['evidenceId', 'proposal']);
        expect(body.evidenceId).toBe(evidenceId);
        expect(body.proposal.definition.pdfSelection).toEqual(
          fixture.definition.pdfSelection,
        );
        expect(body.proposal.unresolvedQuestions).toEqual([]);
        expect(body).not.toHaveProperty('example');
        expect(body).not.toHaveProperty('decision');
        if (++attempts === 1 && retryFirstSave) return route.abort('failed');
        mapping.version = 2;
        mapping.definition = body.proposal.definition;
        mapping.unresolved_questions = [];
        mapping.rationale = body.proposal.rationale;
        return route.fulfill({ json: { id: mappingId, status: 'candidate' } });
      }
      if (path.endsWith('/review')) {
        expect(attempts).toBeGreaterThan(0);
        expect(body).toEqual({
          expectedRevision: 1,
          decision: 'approve',
          reason:
            'Verified the source-derived example and exact PDF selection.',
        });
        mapping.status = 'approved';
        mapping.revision = 2;
        return route.fulfill({ json: { id: mappingId } });
      }
      expect(path).toBe(
        `/api/v2/finance/books/${bookId}/report-mappings/${mappingId}/import`,
      );
      expect(mapping.status).toBe('approved');
      expect(body).toEqual({
        evidenceId,
        financialAccountId: bookId,
        expectedMappingVersion: 2,
        providerKey: 'Example',
      });
      return route.fulfill({ json: { id: evidenceId, status: 'review' } });
    }
    if (path.endsWith('/pdf-inspection'))
      return route.fulfill({
        json:
          url.searchParams.get('page') === '2'
            ? pdfBlankPageInspection(fixture.inspection)
            : fixture.inspection,
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
          ],
        },
      });
    if (path.endsWith('/evidence'))
      return route.fulfill({
        json: {
          documents: [
            { id: evidenceId, filename: 'statement.pdf', format: 'pdf' },
            {
              id: '00000000-0000-4000-8000-000000000004',
              filename: 'new-statement.pdf',
              format: 'pdf',
            },
            {
              id: '00000000-0000-4000-8000-000000000005',
              filename: 'other.csv',
              format: 'csv',
            },
          ],
          nextOffset: null,
        },
      });
    if (path.endsWith('/report-mappings'))
      return route.fulfill({ json: { mappings: [mapping], nextOffset: null } });
    if (path.endsWith(mappingId))
      return route.fulfill({ json: { mapping, reviews: [] } });
    if (path.endsWith('/financial-accounts'))
      return route.fulfill({
        json: {
          accounts: [{ id: bookId, name: 'Operating bank', currency: 'CAD' }],
        },
      });
    return route.fulfill({
      json: { trialBalance: [], journals: [], periods: [], imports: [] },
    });
  });
  await page.goto('/finance');
  await expect(page.getByLabel('Accounting book')).toHaveValue(bookId);
  await page.getByRole('tab', { name: 'Reports & tax', exact: true }).click();
  await page
    .getByRole('button', { name: 'Open report standardization' })
    .click();
  return { ...fixture, writes, turns, errors };
}

test('reviewed PDF candidate needs exact source review, separate approval, and exact-original import', async ({
  page,
}) => {
  const { writes, turns, errors } = await mockPdfReview(page, true);
  await page.setViewportSize({ width: 1505, height: 1045 });
  await page
    .getByRole('button', {
      name: 'Ask EMDO to propose PDF mapping for statement.pdf',
      exact: true,
    })
    .click();
  await expect.poll(() => turns.length).toBe(1);
  await page
    .getByRole('button', {
      name: 'Example · Account activity · v1 · candidate',
    })
    .click();
  await expect(
    page.getByRole('option', { name: 'Approve this version' }),
  ).toHaveCount(0);
  await page
    .getByRole('button', {
      name: 'Review PDF selection and create a revised candidate',
    })
    .click();
  const review = page.getByRole('region', { name: 'PDF source review' });
  await expect(
    review.getByRole('table', { name: 'Explicitly selected PDF cells' }),
  ).toBeVisible();
  await expect(
    review.getByLabel(/I checked every selected heading/),
  ).not.toBeChecked();
  await review.getByLabel('Inspect source page').selectOption('2');
  await expect(
    review.getByText(/This page has no extractable text/),
  ).toBeVisible();
  await expect(
    review.getByRole('button', { name: 'Use page 2 for this table' }),
  ).toBeDisabled();
  await review.getByRole('button', { name: 'Return to table page 1' }).click();
  await expect(
    review.getByRole('button', { name: 'Save reviewed PDF candidate' }),
  ).toBeEnabled();
  await review
    .getByRole('button', { name: 'Select spans for row 1, column 2' })
    .click();
  await expect(
    review.getByRole('checkbox', { name: 'Source span 0: Date', exact: true }),
  ).toBeDisabled();
  await expect(
    review.getByRole('checkbox', {
      name: 'Source span 4: Coffee',
      exact: true,
    }),
  ).toBeChecked();
  await review
    .getByRole('checkbox', { name: 'Source span 5: beans', exact: true })
    .uncheck();
  await review
    .getByRole('checkbox', { name: 'Source span 5: beans', exact: true })
    .check();
  await review
    .getByLabel('Does CAD apply to every selected row?')
    .fill('The original specifies CAD for all selected rows.');
  await review
    .getByLabel('PDF source review notes')
    .fill(
      'Verified all selected spans, row order, currency and the omitted footer and image-only page.',
    );
  await review.getByLabel(/I checked every selected heading/).check();
  await review.getByLabel(/I checked date and currency context/).check();
  await review.getByLabel(/I reviewed the omitted pages/).check();
  await expectNoSeriousAccessibilityViolations(page);
  await review.screenshot({
    path: '/tmp/emdo-pdf-review-desktop.png',
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await review
    .getByRole('button', { name: 'Select spans for row 1, column 1' })
    .click();
  await expect(
    page.getByRole('complementary', { name: 'Exact PDF source spans' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    review.getByRole('region', { name: 'Source span choices' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    review.getByRole('checkbox', {
      name: 'Source span 3: 2026-09-13',
      exact: true,
    }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expectNoSeriousAccessibilityViolations(page);
  await review.screenshot({
    path: '/tmp/emdo-pdf-review-mobile.png',
    animations: 'disabled',
  });
  await review
    .locator('.finance-pdf-review__source')
    .evaluate((element) =>
      window.scrollTo(
        0,
        window.scrollY + element.getBoundingClientRect().top - 90,
      ),
    );
  await page.screenshot({
    path: '/tmp/emdo-pdf-review-mobile-native.png',
    animations: 'disabled',
  });
  expect(writes).toHaveLength(0);
  await review
    .getByRole('button', { name: 'Save reviewed PDF candidate' })
    .click();
  await expect(review.getByRole('alert')).toContainText(/fetch/i);
  await review
    .getByRole('button', { name: 'Save reviewed PDF candidate' })
    .click();
  await expect(
    page.getByText('Mapping v2 · candidate', { exact: true }),
  ).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[0]!.key).toBe(writes[1]!.key);
  expect(writes[0]!.body).toEqual(writes[1]!.body);
  await page.getByLabel('Mapping decision').selectOption('approve');
  await page
    .getByLabel('Review reason')
    .fill('Verified the source-derived example and exact PDF selection.');
  await page.getByRole('button', { name: 'Save mapping decision' }).click();
  await expect(
    page.getByText('Mapping v2 · approved', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Choose account for reuse' }).click();
  const original = page.getByLabel('Saved report to standardize');
  await expect(original.getByRole('option')).toHaveCount(2);
  await expect(
    original.getByRole('option', { name: 'new-statement.pdf' }),
  ).toHaveCount(0);
  await expect(original.getByRole('option', { name: 'other.csv' })).toHaveCount(
    0,
  );
  await original.selectOption(evidenceId);
  await page.getByLabel('Report financial account').selectOption(bookId);
  await page.getByLabel('Report provider').fill('Example');
  await page
    .getByRole('button', { name: 'Standardize for import review' })
    .click();
  await expect(page.getByText(/Saved import reference:/)).toBeVisible();
  expect(writes.map((write) => write.path.split('/').at(-1))).toEqual([
    'report-mappings',
    'report-mappings',
    'review',
    'import',
  ]);
  expect(errors).toEqual([]);
});

test('a user can build a PDF candidate from exact spans without a model proposal', async ({
  page,
}) => {
  const { writes, errors } = await mockPdfReview(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('button', {
      name: 'Review PDF source: statement.pdf',
      exact: true,
    })
    .click();
  const review = page.getByRole('region', { name: 'PDF source review' });
  await expect(
    review.getByText(/No rows or columns are inferred/),
  ).toBeVisible();
  for (let column = 0; column < 3; column++) {
    await review
      .getByRole('button', { name: 'Add column', exact: true })
      .click();
    await review
      .getByRole('checkbox', { name: new RegExp(`^Source span ${column}:`) })
      .check();
  }
  for (const [column, spans] of [
    [1, [3]],
    [2, [4, 5]],
    [3, [6]],
  ] as const) {
    await review
      .getByRole('button', { name: `Select spans for row 1, column ${column}` })
      .click();
    for (const span of spans)
      await review
        .getByRole('checkbox', { name: new RegExp(`^Source span ${span}:`) })
        .check();
  }
  await review
    .getByRole('button', { name: 'Select spans for currency context' })
    .click();
  await review
    .getByRole('checkbox', { name: 'Source span 7: CAD', exact: true })
    .check();
  await review.getByLabel('PDF report provider').fill('Example');
  await review.getByLabel('PDF report name').fill('Account activity');
  await review.getByLabel('Layout version').fill('2026-09');
  await review.getByLabel('Transaction date · required').selectOption('0');
  await review.getByLabel('Description · required').selectOption('1');
  await review.getByLabel('Amount representation').selectOption('signed');
  await review.getByLabel('Amount · required').selectOption('2');
  await review.getByLabel('Currency · required').selectOption('context');
  await review
    .getByRole('combobox', { name: 'Date format', exact: true })
    .selectOption('yyyy-mm-dd');
  await review
    .getByRole('combobox', { name: 'Decimal separator', exact: true })
    .selectOption('.');
  await review.getByLabel('Thousands separator').selectOption(',');
  await review
    .getByLabel('PDF source review notes')
    .fill('Manually selected every source cell and reviewed omitted content.');
  await review.getByLabel(/I checked every selected heading/).check();
  await review.getByLabel(/I checked date and currency context/).check();
  await review.getByLabel(/I reviewed the omitted pages/).check();
  await review
    .getByRole('button', { name: 'Save reviewed PDF candidate' })
    .click();
  await expect(
    page.getByText('Mapping v2 · candidate', { exact: true }),
  ).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(errors).toEqual([]);
});

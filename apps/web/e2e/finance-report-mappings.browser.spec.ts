import { expect, test } from '@playwright/test';
import {
  mockAuthenticatedSession,
  expectNoSeriousAccessibilityViolations,
} from './support.js';
const bookId = '00000000-0000-4000-8000-000000000001',
  evidenceId = '00000000-0000-4000-8000-000000000002',
  mappingId = '00000000-0000-4000-8000-000000000003';
test('approved report mappings create review batches in desktop and mobile', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await mockAuthenticatedSession(page);
  const mapping = {
    id: mappingId,
    evidence_id: evidenceId,
    providerKey: 'Example',
    reportName: 'Activity',
    version: 1,
    revision: 1,
    status: 'approved',
    validationStatus: 'normalized',
    proposed_by_model: 'gpt-6-astra',
    rationale: 'The source identifies currency separately.',
    unresolved_questions: [],
    definition: {
      providerKey: 'Example',
      reportName: 'Activity',
      reportType: 'bank-transactions',
      layoutVersion: '1',
      headers: ['Date', 'Memo', 'Amount', 'Currency'],
      bindings: [
        { field: 'transactionDate', column: 'Date', context: null },
        { field: 'description', column: 'Memo', context: null },
        { field: 'amount', column: 'Amount', context: null },
        { field: 'currency', column: 'Currency', context: null },
      ],
      dateFormat: 'yyyy-mm-dd',
      decimalSeparator: '.',
      groupingSeparator: ',',
      quantityUnit: null,
      valuationMultiplier: null,
      identifierScheme: null,
      identifierNamespace: null,
    },
    example: {
      headers: ['Date', 'Memo', 'Amount', 'Currency'],
      rows: [
        {
          sourceRow: 2,
          cells: ['2026-01-01', 'Example payment', '10.00', 'CAD'],
        },
      ],
    },
    validation: {
      status: 'normalized',
      issues: [],
      rows: [
        {
          sourceRow: 2,
          fields: { amount: '10.00', currency: 'CAD' },
          issues: [],
        },
      ],
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
  let writes = 0;
  await page.route('**/api/v2/finance/books**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (req.method() === 'POST') {
      expect(path).toBe(
        `/api/v2/finance/books/${bookId}/report-mappings/${mappingId}/import`,
      );
      expect(req.postDataJSON()).toEqual({
        evidenceId,
        financialAccountId: bookId,
        expectedMappingVersion: 1,
        providerKey: 'Example',
      });
      expect(req.headers()['x-csrf-token']).toBe(
        'e2e-csrf-token-01234567890123456789',
      );
      writes++;
      return route.fulfill({ json: { id: evidenceId, status: 'review' } });
    }
    const result = path.endsWith('/books')
      ? {
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
        }
      : path.endsWith('/evidence')
        ? {
            documents: [
              { id: evidenceId, filename: 'unfamiliar.csv', format: 'csv' },
            ],
            nextOffset: null,
          }
        : path.endsWith('/report-mappings')
          ? { mappings: [mapping], nextOffset: null }
          : path.endsWith(mappingId)
            ? { mapping, reviews: [] }
            : path.endsWith('/financial-accounts')
              ? {
                  accounts: [
                    { id: bookId, name: 'Operating bank', currency: 'CAD' },
                  ],
                }
              : { trialBalance: [], periods: [], journals: [] };
    return route.fulfill({ json: result });
  });
  await page.goto('/finance');
  await page.getByLabel('Accounting book').selectOption(bookId);
  await page.getByRole('tab', { name: 'Reports & tax', exact: true }).click();
  await page
    .getByRole('button', { name: 'Open report standardization' })
    .click();
  await page
    .getByRole('button', { name: 'Example · Activity · v1 · approved' })
    .click();
  await expect(
    page.getByRole('table', { name: 'Original example rows' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Choose account for reuse' }).click();
  await page.getByLabel('Saved report to standardize').selectOption(evidenceId);
  await page.getByLabel('Report financial account').selectOption(bookId);
  await page.getByLabel('Report provider', { exact: true }).fill('Example');
  await page
    .getByRole('button', { name: 'Standardize for import review' })
    .click();
  await expect(page.getByText(/Saved import reference:/)).toBeVisible();
  expect(writes).toBe(1);
  await expectNoSeriousAccessibilityViolations(page);
  await page.screenshot({
    path: testInfo.outputPath('mapping-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('mapping-mobile.png'),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

import { expect, test } from '@playwright/test';
import {
  mockAuthenticatedSession,
  expectNoSeriousAccessibilityViolations,
} from './support.js';
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const bookId = uuid(1),
  partyId = uuid(2),
  documentId = uuid(3),
  journalId = uuid(4);
const accounts = [
  { id: uuid(10), code: '1000', name: 'Cash', kind: 'asset' },
  { id: uuid(11), code: '1100', name: 'Receivables', kind: 'asset' },
  { id: uuid(12), code: '4000', name: 'Sales', kind: 'income' },
];

test('Books invoice and partial payment flow renders exact balances', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
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
  let issued = false,
    paid = false;
  const requests: unknown[] = [];
  await page.route('**/api/v2/finance/books**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe(
        'e2e-csrf-token-01234567890123456789',
      );
      expect(request.headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
      const body = request.postDataJSON();
      requests.push(body);
      if (path.endsWith('/commercial-documents')) {
        expect(body).toMatchObject({
          kind: 'sales-invoice',
          partyId,
          reference: 'INV-1',
          lines: [{ netAmount: '100.01', taxAmount: '0' }],
        });
        issued = true;
      } else if (path.endsWith('/payments')) {
        expect(body).toMatchObject({
          direction: 'receipt',
          allocations: [{ documentId, amount: '40' }],
        });
        paid = true;
      } else throw new Error(`Unexpected write ${path}`);
      await route.fulfill({ json: { id: documentId, journalId } });
      return;
    }
    if (path.endsWith('/books'))
      await route.fulfill({
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
    else if (path.endsWith('/commercial'))
      await route.fulfill({
        json: {
          currency: 'CAD',
          parties: [
            {
              id: partyId,
              name: 'Customer',
              kind: 'organization',
              reference: 'C1',
            },
          ],
          documents: issued
            ? [
                {
                  id: documentId,
                  kind: 'sales-invoice',
                  partyId,
                  partyName: 'Customer',
                  reference: 'INV-1',
                  issuedOn: '2026-01-10',
                  dueOn: '2026-02-10',
                  status: 'issued',
                  total: '100.010000000000',
                  paid: paid ? '40.000000000000' : '0',
                  outstanding: paid ? '60.010000000000' : '100.010000000000',
                  journalId,
                  voidJournalId: null,
                  sourceReference: 'source:INV-1',
                },
              ]
            : [],
          payments: paid
            ? [
                {
                  id: uuid(6),
                  direction: 'receipt',
                  status: 'posted',
                  voidJournalId: null,
                  reference: 'PAY-1',
                  total: '40',
                  effectiveOn: '2026-02-01',
                  journalId: uuid(7),
                  sourceReference: 'statement:PAY-1',
                },
              ]
            : [],
        },
      });
    else
      await route.fulfill({
        json: {
          trialBalance: accounts.map((account) => ({
            ...account,
            debit: '0',
            credit: '0',
            balance: '0',
          })),
          periods: [
            {
              id: uuid(20),
              startsOn: '2026-01-01',
              endsOn: '2026-12-31',
              status: 'open',
            },
          ],
          journals: [],
        },
      });
  });
  await page.goto('/finance');
  await expect(page).toHaveTitle(/EMDO/i);
  await expect(
    page.getByRole('heading', { name: 'Finance', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Accounting book').selectOption(bookId);
  await page.getByRole('tab', { name: 'Books', exact: true }).click();
  await page
    .getByRole('button', { name: 'Receivables & payables', exact: true })
    .click();
  const section = page.getByRole('region', {
    name: 'Receivables and payables',
  });
  await expect(
    section.getByText('No invoices or bills recorded.'),
  ).toBeVisible();
  await section.getByText('Issue an invoice or bill', { exact: true }).click();
  await section
    .getByRole('combobox', { name: 'Customer or supplier', exact: true })
    .selectOption(partyId);
  await section.getByLabel('Document reference', { exact: true }).fill('INV-1');
  await section
    .getByLabel('Source reference', { exact: true })
    .fill('source:INV-1');
  await section.getByLabel('Issue date', { exact: true }).fill('2026-01-10');
  await section.getByLabel('Due date', { exact: true }).fill('2026-02-10');
  await section
    .getByRole('combobox', { name: 'Receivable control account', exact: true })
    .selectOption(uuid(11));
  await section.getByLabel('Description', { exact: true }).fill('Services');
  await section
    .getByRole('combobox', { name: 'Income account', exact: true })
    .selectOption(uuid(12));
  await section.getByLabel('Net amount', { exact: true }).fill('100.01');
  await section
    .getByRole('button', { name: 'Issue and post document' })
    .click();
  await expect(
    section.getByRole('row').filter({ hasText: 'INV-1' }),
  ).toContainText('100.01');
  await section.getByText('Record a payment', { exact: true }).click();
  await section
    .getByRole('combobox', { name: 'Payment party', exact: true })
    .selectOption(partyId);
  await section
    .getByRole('combobox', { name: 'Cash ledger account', exact: true })
    .selectOption(uuid(10));
  await section.getByLabel('Payment date', { exact: true }).fill('2026-02-01');
  await section.getByLabel('Payment reference', { exact: true }).fill('PAY-1');
  await section
    .getByLabel('Payment source', { exact: true })
    .fill('statement:PAY-1');
  await section.getByPlaceholder('Amount to allocate').fill('40');
  await section
    .getByRole('button', { name: 'Record and post payment' })
    .click();
  await expect(
    section.getByRole('row').filter({ hasText: 'INV-1' }),
  ).toContainText('60.01');
  expect(requests).toHaveLength(2);
  expect(errors).toEqual([]);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expectNoSeriousAccessibilityViolations(page);
  await page.screenshot({
    path: testInfo.outputPath('commercial-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    section.getByRole('heading', { name: 'Receivables and payables' }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('commercial-mobile.png'),
    fullPage: true,
  });
  await testInfo.attach('console-errors', {
    body: JSON.stringify(consoleErrors),
    contentType: 'application/json',
  });
});

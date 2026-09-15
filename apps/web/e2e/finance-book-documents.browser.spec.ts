import { expect, test } from '@playwright/test';
import {
  mockAuthenticatedSession,
  expectNoSeriousAccessibilityViolations,
} from './support.js';
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const bookId = uuid(1);
const accounts = [
  { id: uuid(10), code: '1000', name: 'Cash', kind: 'asset' },
  { id: uuid(11), code: '1100', name: 'Receivables', kind: 'asset' },
  { id: uuid(12), code: '4000', name: 'Sales', kind: 'income' },
];

test('Book statements persist review and commit in desktop and mobile layouts', async ({
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
  let uploaded = false,
    revision = 1,
    status = 'review',
    rowStatus = 'review',
    rowRevision = 1;
  await page.route('**/api/v2/finance/books**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      expect(request.headers()['x-csrf-token']).toBe(
        'e2e-csrf-token-01234567890123456789',
      );
      if (path.endsWith('/imports')) {
        expect(body.sourceText).toContain('27.13');
        uploaded = true;
      } else if (path.endsWith('/review')) {
        expect(body.expectedRevision).toBe(1);
        revision = 2;
        rowRevision = 2;
        rowStatus = 'ready';
      } else if (path.endsWith('/commit')) {
        expect(body.expectedRevision).toBe(2);
        revision = 3;
        status = 'committed';
        rowStatus = 'committed';
      } else throw new Error(`Unexpected write ${path}`);
      return route.fulfill({ json: { id: uuid(30) } });
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
      : path.endsWith('/commercial')
        ? { currency: 'CAD', parties: [], documents: [], payments: [] }
        : path.endsWith('/financial-accounts')
          ? {
              accounts: [
                {
                  id: uuid(20),
                  name: 'Operating bank',
                  currency: 'CAD',
                  ledgerAccountId: uuid(10),
                },
              ],
            }
          : path.endsWith('/imports')
            ? {
                imports: uploaded
                  ? [{ id: uuid(30), filename: 'bank.csv', status, revision }]
                  : [],
              }
            : path.includes('/imports/')
              ? {
                  batch: {
                    id: uuid(30),
                    evidence_id: uuid(31),
                    revision,
                    status,
                  },
                  rows: [
                    {
                      id: uuid(32),
                      source_row: 2,
                      date: '2026-03-01',
                      amount: '27.13',
                      description: 'Service',
                      external_id: null,
                      issues: [],
                      status: rowStatus,
                      revision: rowRevision,
                      counter_account_id: null,
                      match_journal_id: null,
                      fxRate: null,
                      fx_source: null,
                      source_facts: { description: 'Service', amount: '27.13' },
                      economic_transaction_id:
                        status === 'committed' ? uuid(40) : null,
                      posting:
                        status === 'committed'
                          ? {
                              functionalCurrency: 'CAD',
                              economicTransactionId: uuid(40),
                              journalId: uuid(41),
                              effectiveOn: '2026-03-01',
                              description: 'Saved service payment',
                              sourceReference: `evidence:${uuid(31)}`,
                              reversalOf: null,
                              lines: [
                                {
                                  lineNumber: 1,
                                  accountId: uuid(10),
                                  side: 'debit',
                                  amount: '27.1300',
                                  currency: 'CAD',
                                  nativeAmount: '27.13',
                                  fxRate: '1.0000',
                                  fxSource: 'Same currency',
                                  description: 'Operating bank receipt',
                                },
                                {
                                  lineNumber: 2,
                                  accountId: uuid(12),
                                  side: 'credit',
                                  amount: '27.1300',
                                  currency: 'CAD',
                                  nativeAmount: '27.13',
                                  fxRate: '1.0000',
                                  fxSource: 'Same currency',
                                  description: 'Reviewed sales',
                                },
                              ],
                            }
                          : null,
                    },
                  ],
                }
              : {
                  trialBalance: accounts.map((a) => ({
                    ...a,
                    debit: '0',
                    credit: '0',
                    balance: '0',
                  })),
                  periods: [],
                  journals: [],
                };
    await route.fulfill({ json: result });
  });
  await page.goto('/finance');
  await page.getByLabel('Accounting book').selectOption(bookId);
  await page.getByRole('tab', { name: 'Documents', exact: true }).click();
  const documents = page.getByRole('region', { name: 'Book documents' });
  await documents
    .getByRole('button', { name: 'Open documents', exact: true })
    .click();
  await documents.getByText('Upload a statement', { exact: true }).click();
  await documents
    .getByRole('combobox', { name: 'Financial account', exact: true })
    .selectOption(uuid(20));
  await documents
    .getByLabel('Original statement', { exact: true })
    .setInputFiles({
      name: 'bank.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Date,Description,Amount\n2026-03-01,Service,27.13'),
    });
  await documents.getByRole('button', { name: 'Upload for review' }).click();
  await expect(
    documents.getByText('Statement review · revision 1'),
  ).toBeVisible();
  await expect(
    documents.getByRole('button', { name: 'Commit reviewed statement' }),
  ).toBeDisabled();
  await documents
    .getByText('Row 2: Service · 27.13 · review', { exact: true })
    .click();
  await documents
    .getByRole('combobox', {
      name: 'Counter ledger account (new postings)',
      exact: true,
    })
    .selectOption(uuid(12));
  await documents
    .getByLabel('Review reason')
    .fill('Checked original statement');
  await documents.getByRole('button', { name: 'Save row review' }).click();
  await expect(
    documents.getByText('Statement review · revision 2'),
  ).toBeVisible();
  await documents
    .getByRole('button', { name: 'Commit reviewed statement' })
    .click();
  await expect(
    documents.getByText('Statement review · revision 3'),
  ).toBeVisible();
  await expect(
    documents.getByRole('button', { name: 'Commit reviewed statement' }),
  ).toHaveCount(0);
  await documents
    .getByText('Row 2: Service · 27.13 · committed', { exact: true })
    .click();
  await documents
    .getByText('Saved accounting trail · 2026-03-01', { exact: true })
    .click();
  await expect(
    documents.getByRole('heading', { name: 'Line 1 · Debit · 1000 · Cash' }),
  ).toBeVisible();
  await expect(
    documents.getByRole('heading', { name: 'Line 2 · Credit · 4000 · Sales' }),
  ).toBeVisible();
  await expect(documents.getByText('27.1300', { exact: true })).toHaveCount(2);
  await documents
    .getByText('Saved journal and source references', { exact: true })
    .click();
  await expect(
    documents.getByText(`evidence:${uuid(31)}`, { exact: true }),
  ).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
  await page.screenshot({
    path: testInfo.outputPath('documents-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    documents.getByRole('button', { name: 'Download original' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expectNoSeriousAccessibilityViolations(page);
  await page.screenshot({
    path: testInfo.outputPath('documents-mobile.png'),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

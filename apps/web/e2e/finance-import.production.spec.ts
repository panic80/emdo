import { expect, test, type Page } from '@playwright/test';

import { mockAuthenticatedSession } from './support.js';

const csrfToken = 'e2e-csrf-token-01234567890123456789';
const accountId = 'account-chequing-e2e';
const categoryId = 'category-groceries-e2e';
const planId = 'finance-import-plan-e2e';
const rawStatement = [
  'DATE,DESCRIPTION,AMOUNT',
  '2026-08-10,PRIVATE-COFFEE,-4.25',
  '2026-08-11,PRIVATE-GROCERIES,-32.10',
].join('\n');

async function installFinanceImportMocks(page: Page): Promise<{
  readonly observations: {
    financeReads: number;
    optionsRequests: number;
    previewRequest: unknown;
    commitRequest: unknown;
    commitIdempotencyKey: string | undefined;
  };
}> {
  const observations: {
    financeReads: number;
    optionsRequests: number;
    previewRequest: unknown;
    commitRequest: unknown;
    commitIdempotencyKey: string | undefined;
  } = {
    financeReads: 0,
    optionsRequests: 0,
    previewRequest: undefined,
    commitRequest: undefined,
    commitIdempotencyKey: undefined,
  };

  await page.route('**/api/v1/experience/finance?*', async (route) => {
    const requestUrl = new URL(route.request().url());
    expect(route.request().method()).toBe('GET');
    expect(requestUrl.searchParams.get('limit')).toBe('25');
    observations.financeReads += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store, private' },
      body: JSON.stringify({ schemaVersion: 1, items: [] }),
    });
  });
  await page.route('**/api/v1/finance/imports/options', async (route) => {
    const request = route.request();
    expect(request.method()).toBe('GET');
    expect(request.headers().accept).toContain('application/json');
    expect(request.postData()).toBeNull();
    observations.optionsRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store, private' },
      body: JSON.stringify({
        schemaVersion: 1,
        accounts: [
          {
            id: accountId,
            name: 'Shared chequing',
            accountKind: 'chequing',
          },
        ],
        categories: [
          {
            id: categoryId,
            name: 'Groceries',
            categoryKind: 'expense',
          },
        ],
      }),
    });
  });
  await page.route('**/api/v1/finance/imports/preview', async (route) => {
    const request = route.request();
    expect(request.method()).toBe('POST');
    expect(request.headers()['x-csrf-token']).toBe(csrfToken);
    expect(request.headers()['idempotency-key']).toBeUndefined();
    observations.previewRequest = request.postDataJSON();
    expect(observations.previewRequest).toEqual({
      schemaVersion: 1,
      format: 'csv',
      sourceText: rawStatement,
      accountId,
      mapping: {
        defaultCategoryId: categoryId,
        dateFormat: 'yyyy-mm-dd',
        columns: {
          postedOn: 'DATE',
          description: 'DESCRIPTION',
          amount: 'AMOUNT',
        },
      },
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store, private' },
      body: JSON.stringify({
        schemaVersion: 1,
        plan: {
          id: planId,
          sourceHash: 'a'.repeat(64),
          expiresAt: '2999-08-16T12:00:00.000Z',
          summary: { accepted: 2, rejected: 1, duplicates: 0 },
          rejectedRows: [{ sourceRow: 4, code: 'invalid-date' }],
          duplicateRows: [],
        },
      }),
    });
  });
  await page.route('**/api/v1/finance/imports/commit', async (route) => {
    const request = route.request();
    expect(request.method()).toBe('POST');
    expect(request.headers()['x-csrf-token']).toBe(csrfToken);
    expect(request.headers()['idempotency-key']).toMatch(
      new RegExp(`^finance-import:${planId}:[0-9a-f-]{36}$`, 'u'),
    );
    observations.commitIdempotencyKey = request.headers()['idempotency-key'];
    observations.commitRequest = request.postDataJSON();
    expect(observations.commitRequest).toEqual({ schemaVersion: 1, planId });
    expect(request.postData()).not.toContain('PRIVATE-COFFEE');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store, private' },
      body: JSON.stringify({
        schemaVersion: 1,
        status: 'committed',
        receipt: {
          id: 'finance-import-receipt-e2e',
          planId,
          transactionCount: 2,
          verified: true,
        },
        sourceDeletionAuthorized: true,
      }),
    });
  });

  return { observations };
}

test('commits a reviewed CSV import against the production browser contract', async ({
  page,
}) => {
  await mockAuthenticatedSession(page);
  const { observations } = await installFinanceImportMocks(page);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/finance');
  await expect(
    page.getByRole('heading', { name: 'Finance', exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Import statement' }).click();
  await expect(page.getByLabel('Import account')).toBeVisible();
  await page.getByLabel('Import account').selectOption(accountId);
  await page.getByLabel('Default category (optional)').selectOption(categoryId);

  const statementFile = page.getByLabel('Statement file');
  await statementFile.setInputFiles({
    name: 'statement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(rawStatement),
  });
  await expect(page.getByLabel('Posted date column')).toHaveValue('DATE');
  await expect(page.getByLabel('Description column')).toHaveValue(
    'DESCRIPTION',
  );
  await expect(page.getByLabel('Signed amount column')).toHaveValue('AMOUNT');
  expect(await page.locator('body').textContent()).not.toContain(
    'PRIVATE-COFFEE',
  );

  await page.getByRole('button', { name: 'Preview import' }).click();
  await expect(
    page.getByRole('heading', { name: 'Review import', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.finance-import-panel__preview').getByRole('status'),
  ).toContainText('2 accepted · 1 rejected · 0 duplicates');
  await expect(page.getByText('Row 4: invalid-date')).toBeVisible();
  expect(await page.locator('body').textContent()).not.toContain(
    'PRIVATE-COFFEE',
  );
  expect(observations.optionsRequests).toBe(1);
  expect(observations.previewRequest).toBeDefined();

  const commit = page.getByRole('button', { name: 'Commit 2 transactions' });
  await expect(commit).toBeDisabled();
  await page
    .getByLabel('I reviewed this import and want to commit it.')
    .check();
  await expect(commit).toBeEnabled();
  await commit.click();

  await expect(
    page.getByText('Imported 2 transactions.', { exact: true }),
  ).toBeVisible();
  expect(observations.commitRequest).toEqual({ schemaVersion: 1, planId });
  expect(observations.commitIdempotencyKey).toMatch(
    new RegExp(`^finance-import:${planId}:[0-9a-f-]{36}$`, 'u'),
  );
  await expect.poll(() => observations.financeReads).toBeGreaterThanOrEqual(2);

  expect(
    await statementFile.evaluate(
      (input) => (input as HTMLInputElement).files?.length,
    ),
  ).toBe(0);
  await expect(page.getByText('CSV column mapping')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Review import', exact: true }),
  ).toHaveCount(0);
  expect(await page.locator('body').textContent()).not.toContain(
    'PRIVATE-COFFEE',
  );

  await page.setViewportSize({ width: 320, height: 700 });
  const horizontalOverflow = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const describeLayout = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return {
        tag: element.tagName.toLowerCase(),
        id: element.id,
        className: element.className,
        left: bounds.left,
        right: bounds.right,
        width: bounds.width,
        display: style.display,
        minWidth: style.minWidth,
        overflowX: style.overflowX,
        flexWrap: style.flexWrap,
        gridTemplateColumns: style.gridTemplateColumns,
      };
    };
    const offenders = Array.from(
      document.body.querySelectorAll<HTMLElement>('*'),
    )
      .flatMap((element) => {
        const bounds = element.getBoundingClientRect();
        if (bounds.left >= -0.5 && bounds.right <= viewportWidth + 0.5) {
          return [];
        }
        const style = window.getComputedStyle(element);
        const ancestors: ReturnType<typeof describeLayout>[] = [];
        let ancestor = element.parentElement;
        while (ancestor && ancestors.length < 5) {
          ancestors.push(describeLayout(ancestor));
          ancestor = ancestor.parentElement;
        }
        return [
          {
            tag: element.tagName.toLowerCase(),
            id: element.id,
            className: element.className,
            name: element.getAttribute('name'),
            type: element.getAttribute('type'),
            left: bounds.left,
            right: bounds.right,
            width: bounds.width,
            minWidth: style.minWidth,
            overflowX: style.overflowX,
            inFinanceImportActions: element.matches(
              '.finance-import-panel__actions *',
            ),
            ancestors,
          },
        ];
      })
      .slice(0, 20);
    return {
      viewportWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      offenders,
    };
  });
  expect(
    horizontalOverflow.offenders,
    JSON.stringify(horizontalOverflow, undefined, 2),
  ).toEqual([]);
  expect(horizontalOverflow.documentScrollWidth).toBeLessThanOrEqual(
    horizontalOverflow.viewportWidth,
  );
});

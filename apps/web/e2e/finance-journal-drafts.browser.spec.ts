import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import {
  FinanceAutomationJournalDraftResultSchema,
  type FinanceAutomationGrant,
  type FinanceAutomationRunRecord,
} from '@emdo/contracts/browser';
import {
  mockAuthenticatedSession,
  expectNoSeriousAccessibilityViolations,
} from './support.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const grant: FinanceAutomationGrant = {
  id: id(2),
  revision: 1,
  workspaceId: id(3),
  bookId: id(1),
  grantedByUserId: id(4),
  executor: 'emdo-managed',
  specialist: 'finance',
  status: 'active',
  allowedCapabilities: ['finance.journals.draft'],
  authorityRevision: { membership: 1, bookAccess: 1, entitlement: 1 },
  limits: {
    maxRuns: 10,
    maxAttemptsPerRun: 3,
    maxItemsPerRun: 100,
    maxTotalItems: 1000,
    currency: 'CAD',
    maxAmountPerRun: '1000',
    maxTotalAmount: '10000',
  },
  validFrom: '2026-01-01T00:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z',
};
const prepared = {
  journal: {
    schemaVersion: 1 as const,
    batchId: id(5),
    expectedBatchRevision: 3,
    expectedSnapshotHash: 'a'.repeat(64),
  },
  itemCount: 2,
  currency: 'CAD',
  amount: '12.50',
};
const queued: FinanceAutomationRunRecord = {
  run: {
    request: {
      operationId: id(6),
      grantId: grant.id,
      grantRevision: 1,
      workspaceId: grant.workspaceId,
      bookId: grant.bookId,
      capability: 'finance.journals.draft',
      requestHash: 'b'.repeat(64),
      itemCount: 2,
      currency: 'CAD',
      amount: '12.50',
      journal: prepared.journal,
    },
    revision: 1,
    attempts: 0,
    status: 'queued',
    outcomeReference: null,
  },
  createdAt: '2026-09-15T00:00:00Z',
  blockedReason: null,
};
const initial = FinanceAutomationJournalDraftResultSchema.parse({
  schemaVersion: 1,
  kind: 'finance-journal-draft',
  id: id(7),
  operationId: id(6),
  workspaceId: id(3),
  bookId: id(1),
  revision: 0,
  status: 'review_required',
  source: {
    batchId: id(5),
    batchRevision: 3,
    snapshotHash: 'a'.repeat(64),
    evidenceId: id(8),
    sourceDigest: 'c'.repeat(64),
    mappingHash: 'd'.repeat(64),
    rows: [{ rowId: id(9), sourceRow: 2, revision: 2, componentRevisions: [] }],
  },
  currency: 'CAD',
  itemCount: 2,
  amount: '12.50',
  proposal: {
    journals: [
      {
        effectiveOn: '2026-09-01',
        description: 'Reviewed bank payment',
        sourceReference: 'statement:row:2',
        lines: [
          {
            accountId: id(10),
            side: 'debit',
            amount: '12.50',
            currency: 'CAD',
            nativeAmount: '12.50',
            fxRate: '1',
            fxSource: 'same-currency',
            description: 'Payment',
          },
          {
            accountId: id(11),
            side: 'credit',
            amount: '12.50',
            currency: 'CAD',
            nativeAmount: '12.50',
            fxRate: '1',
            fxSource: 'same-currency',
            description: 'Payment',
          },
        ],
      },
    ],
  },
  review: null,
  postedJournalIds: [],
  posting: 'not-performed',
  events: [],
});
const artifacts = '../../output/playwright/journal-drafts';
async function fixture(page: Page, existing = false) {
  await mockAuthenticatedSession(page);
  let current = structuredClone(initial),
    denied = false,
    lose = '',
    exists = existing;
  const writes: { path: string; body: Record<string, unknown>; key: string }[] =
      [],
    errors: string[] = [];
  const receipts = new Map<string, unknown>();
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
  await page.route('**/api/v2/finance/books**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith('/books'))
      return route.fulfill({
        json: {
          books: [
            {
              id: id(1),
              name: 'Operations',
              entityName: 'Example',
              country: 'CA',
              functionalCurrency: 'CAD',
              role: 'administrator',
            },
            {
              id: id(99),
              name: 'Other book',
              entityName: 'Other',
              country: 'CA',
              functionalCurrency: 'CAD',
              role: 'administrator',
            },
          ],
        },
      });
    if (denied) return route.fulfill({ status: 403, json: {} });
    if (path.includes(id(99)))
      return route.fulfill({
        json: { grants: [], trialBalance: [], periods: [], journals: [] },
      });
    let value: unknown;
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>,
        key = request.headers()['idempotency-key']!;
      expect(request.headers()['x-csrf-token']).toBe(
        'e2e-csrf-token-01234567890123456789',
      );
      writes.push({ path, body, key });
      if (receipts.has(key)) return route.fulfill({ json: receipts.get(key) });
      if (path.endsWith('/prepare')) value = prepared;
      else if (path.endsWith('/automations/runs')) value = queued;
      else if (path.endsWith('/review')) {
        const decision = body.decision as 'approved' | 'rejected';
        current = {
          ...current,
          status: decision,
          revision: 1,
          review: {
            decision,
            reason: String(body.reason),
            actorId: id(4),
            at: '2026-09-15T00:00:00Z',
          },
          events: [
            {
              kind: 'reviewed',
              revision: 1,
              decision,
              reason: String(body.reason),
              actorId: id(4),
              at: '2026-09-15T00:00:00Z',
            },
          ],
        };
        value = current;
      } else if (path.endsWith('/post')) {
        current = {
          ...current,
          status: 'posted',
          revision: 2,
          posting: 'performed',
          postedJournalIds: [id(12)],
          events: [
            ...current.events,
            {
              kind: 'posted',
              revision: 2,
              journalIds: [id(12)],
              actorId: id(4),
              at: '2026-09-15T00:01:00Z',
            },
          ],
        };
        value = current;
      } else if (path.endsWith('/discard')) {
        current = {
          ...current,
          status: 'discarded',
          revision: current.revision + 1,
          events: [
            ...current.events,
            {
              kind: 'discarded',
              revision: current.revision + 1,
              reason: String(body.reason),
              actorId: id(4),
              at: '2026-09-15T00:01:00Z',
            },
          ],
        };
        value = current;
      } else throw new Error(`Unexpected write ${path}`);
      receipts.set(key, value);
      if (lose && path.endsWith(lose)) {
        lose = '';
        return route.abort('failed');
      }
    } else if (path.endsWith('/automations/grants'))
      value = { grants: [grant] };
    else if (path.endsWith('/imports'))
      value = {
        imports: [
          {
            id: id(5),
            filename: 'Reviewed bank.csv',
            status: 'review',
            revision: 3,
          },
        ],
      };
    else if (path.endsWith('/journal-drafts'))
      value = {
        items: exists ? [current] : [],
        offset: 0,
        limit: 50,
        total: exists ? 1 : 0,
      };
    else if (path.endsWith(`/journal-drafts/${id(7)}`)) value = current;
    else if (path.endsWith(`/automations/runs/${id(6)}`)) {
      exists = true;
      value = {
        ...queued,
        run: { ...queued.run, status: 'completed', outcomeReference: id(7) },
      };
    } else
      value = {
        trialBalance: [
          {
            id: id(10),
            name: 'Bank',
            code: '1000',
            kind: 'asset',
            debit: '0',
            credit: '0',
            balance: '0',
          },
          {
            id: id(11),
            name: 'Revenue',
            code: '4000',
            kind: 'income',
            debit: '0',
            credit: '0',
            balance: '0',
          },
        ],
        periods: [],
        journals: [],
      };
    return route.fulfill({ json: value });
  });
  await page.goto('/finance');
  await expect(page.getByLabel('Accounting book')).toHaveValue(id(1));
  await page.getByRole('tab', { name: 'Automations', exact: true }).click();
  const panel = page.getByRole('region', {
    name: 'Journal draft automation',
    exact: true,
  });
  await panel
    .getByRole('button', { name: 'Open journal drafts', exact: true })
    .click();
  await expect(
    panel.getByRole('combobox', { name: 'Saved source import', exact: true }),
  ).toBeVisible();
  return {
    panel,
    writes,
    errors,
    lose: (suffix: string) => {
      lose = suffix;
    },
    deny: () => {
      denied = true;
    },
    current: () => current,
  };
}
test('journal prepare and exact retry, saved draft review, separate posting and mobile access clearing', async ({
  page,
}) => {
  await mkdir(artifacts, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1050 });
  const f = await fixture(page);
  await f.panel
    .getByRole('combobox', { name: 'Saved source import', exact: true })
    .selectOption(id(5));
  await f.panel
    .getByRole('button', { name: 'Prepare journal scope', exact: true })
    .click();
  const scope = f.panel.getByRole('region', {
    name: 'Prepared journal scope',
    exact: true,
  });
  await expect(scope).toContainText('12.50 CAD');
  await expect(scope.locator('dd')).toContainText([
    'Reviewed bank.csv · revision 3',
    '2',
    '12.50 CAD',
  ]);
  expect(f.writes).toHaveLength(1);
  await f.panel
    .getByRole('combobox', { name: 'Journal draft grant', exact: true })
    .selectOption(grant.id);
  await scope.screenshot({ path: `${artifacts}/prepared-desktop.png` });
  f.lose('/automations/runs');
  await f.panel
    .getByRole('button', { name: 'Queue reviewed journal draft', exact: true })
    .click();
  await expect(f.panel.getByRole('alert')).toBeVisible();
  await f.panel
    .getByRole('button', { name: 'Queue reviewed journal draft', exact: true })
    .click();
  await expect(
    f.panel.getByText('Saved draft run · queued', { exact: true }),
  ).toBeVisible();
  expect(f.writes[1]).toEqual(f.writes[2]);
  expect(f.writes[1]!.body).toEqual({
    grantId: grant.id,
    capability: 'finance.journals.draft',
    targets: [id(5)],
    currency: 'CAD',
    amount: '12.50',
    journal: prepared.journal,
  });
  await f.panel
    .getByRole('button', { name: 'Refresh draft run', exact: true })
    .click();
  const detail = f.panel.getByRole('region', {
    name: 'Saved journal draft detail',
    exact: true,
  });
  await expect(detail).toContainText('Posting: Not performed');
  await expect(
    detail.getByRole('cell', { name: 'Bank Payment', exact: true }),
  ).toBeVisible();
  await expect(
    f.panel.getByRole('button', { name: 'Review posting action', exact: true }),
  ).toHaveCount(0);
  await detail
    .getByRole('combobox', { name: 'Draft decision', exact: true })
    .selectOption('approved');
  await detail
    .getByRole('textbox', { name: 'Review reason', exact: true })
    .fill('Checked the original and every saved journal line.');
  await detail
    .getByRole('button', { name: 'Save draft review', exact: true })
    .click();
  await expect(detail).toContainText('approved · revision 1');
  expect(f.writes.filter((item) => item.path.endsWith('/post'))).toHaveLength(
    0,
  );
  await detail
    .getByRole('button', { name: 'Review posting action', exact: true })
    .click();
  expect(f.writes.filter((item) => item.path.endsWith('/post'))).toHaveLength(
    0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const lines = detail.getByRole('region', {
    name: 'Journal 1 line details',
    exact: true,
  });
  await lines.focus();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() => lines.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await lines.screenshot({ path: `${artifacts}/journal-lines-mobile.png` });
  await detail
    .getByRole('checkbox', { name: /I reviewed the approved journals/ })
    .check();
  await detail
    .getByRole('button', {
      name: 'Confirm and post approved draft',
      exact: true,
    })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${artifacts}/posting-confirmation-mobile.png`,
  });
  expect(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  f.lose('/post');
  await detail
    .getByRole('button', {
      name: 'Confirm and post approved draft',
      exact: true,
    })
    .click();
  await expect(f.panel.getByRole('alert')).toBeVisible();
  await detail
    .getByRole('button', {
      name: 'Confirm and post approved draft',
      exact: true,
    })
    .click();
  await expect(detail).toContainText('Posting: Performed');
  const posts = f.writes.filter((item) => item.path.endsWith('/post'));
  expect(posts[0]).toEqual(posts[1]);
  expect(posts[0]!.body).toEqual({ expectedRevision: 1 });
  await detail
    .getByRole('heading', { name: 'Saved actions', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${artifacts}/posted-history-mobile.png` });
  await expectNoSeriousAccessibilityViolations(page);
  expect(f.errors).toEqual([]);
  f.deny();
  await f.panel
    .getByRole('button', { name: 'Refresh journal drafts', exact: true })
    .click();
  await expect(f.panel.getByRole('alert')).toContainText('Current book access');
  await expect(
    f.panel.getByRole('region', {
      name: 'Saved journal draft detail',
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    f.panel.getByRole('region', {
      name: 'Prepared journal scope',
      exact: true,
    }),
  ).toHaveCount(0);
});
for (const reviewed of [false, true])
  test(`discard ${reviewed ? 'rejected' : 'unreviewed'} draft retains accurate history and book switch clears it`, async ({
    page,
  }) => {
    await mkdir(artifacts, { recursive: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const f = await fixture(page, true);
    await f.panel
      .getByRole('button', {
        name: 'Reviewed bank.csv · review required · revision 0',
        exact: true,
      })
      .click();
    const detail = f.panel.getByRole('region', {
      name: 'Saved journal draft detail',
      exact: true,
    });
    if (reviewed) {
      await detail
        .getByRole('combobox', { name: 'Draft decision', exact: true })
        .selectOption('rejected');
      await detail
        .getByRole('textbox', { name: 'Review reason', exact: true })
        .fill('The saved source account requires correction.');
      await detail
        .getByRole('button', { name: 'Save draft review', exact: true })
        .click();
      await expect(detail).toContainText('rejected · revision 1');
    }
    await detail.getByText('Discard this draft', { exact: true }).click();
    await detail
      .getByRole('textbox', { name: 'Discard reason', exact: true })
      .fill('Discard this snapshot before correcting the source.');
    await detail
      .getByRole('button', { name: 'Discard saved draft', exact: true })
      .click();
    await expect(detail).toContainText(
      `discarded · revision ${reviewed ? 2 : 1}`,
    );
    await expect(detail).toContainText('Posting: Not performed');
    expect(f.current().review?.decision ?? null).toBe(
      reviewed ? 'rejected' : null,
    );
    expect(f.current().events.map((event) => event.kind)).toEqual(
      reviewed ? ['reviewed', 'discarded'] : ['discarded'],
    );
    expect(f.writes.every((item) => !item.path.endsWith('/post'))).toBe(true);
    await detail
      .getByRole('heading', { name: 'Saved actions', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${artifacts}/discarded-${reviewed ? 'rejected' : 'unreviewed'}-mobile.png`,
    });
    expect(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await expectNoSeriousAccessibilityViolations(page);
    await page
      .getByRole('combobox', { name: 'Accounting book', exact: true })
      .selectOption(id(99));
    await expect(
      page.getByRole('combobox', { name: 'Accounting book', exact: true }),
    ).toHaveValue(id(99));
    await expect(
      page.getByRole('region', {
        name: 'Saved journal draft detail',
        exact: true,
      }),
    ).toHaveCount(0);
    expect(f.errors).toEqual([]);
  });

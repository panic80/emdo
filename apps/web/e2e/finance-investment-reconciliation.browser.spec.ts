import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import {
  InvestmentReconciliationResolutionSchema,
  type InvestmentReconciliationCase,
} from '@emdo/contracts/browser';
import {
  mockAuthenticatedSession,
  expectNoSeriousAccessibilityViolations,
} from './support.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const comparison: InvestmentReconciliationCase['comparison'] = {
  valuationRunId: id(2),
  observedPositionId: id(3),
  comparisonHash: 'a'.repeat(64),
  valuationInputHash: 'b'.repeat(64),
  financialAccountId: id(4),
  instrumentId: id(5),
  asOf: '2026-09-01',
  evidenceId: id(6),
  sourceRow: 2,
  observedQuantity: '10.125',
  calculatedQuantity: '10',
  difference: '0.125',
  status: 'difference',
  sourceSnapshot: {},
};
const event: InvestmentReconciliationCase['history'][number] = {
  revision: 1,
  kind: 'created',
  comparison,
  resolution: null,
  evidenceSnapshots: [],
  correctiveRecordSnapshots: [],
  reason: null,
  createdBy: id(9),
  createdAt: '2026-09-15T00:00:00Z',
};
const saved: InvestmentReconciliationCase = {
  schemaVersion: 1,
  id: id(7),
  workspaceId: id(8),
  bookId: id(1),
  revision: 1,
  status: 'open',
  effectiveStatus: 'open',
  sourcesCurrent: true,
  comparison,
  history: [event],
  accountingEffect: 'none',
};
const artifacts = '../../output/playwright/investment-reconciliation';
async function fixture(page: Page) {
  await mockAuthenticatedSession(page);
  let current = structuredClone(saved),
    exists = false,
    denied = false,
    lose = false;
  const writes: { path: string; body: Record<string, unknown>; key: string }[] =
      [],
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
          ],
        },
      });
    if (denied) return route.fulfill({ status: 403, json: {} });
    let result: unknown;
    if (request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe(
        'e2e-csrf-token-01234567890123456789',
      );
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path, body, key: request.headers()['idempotency-key']! });
      if (!path.includes('/reconciliations'))
        throw new Error(`Unexpected accounting write ${path}`);
      if (lose) {
        lose = false;
        return route.abort('failed');
      }
      exists = true;
      if (path.endsWith('/resolve')) {
        const resolution = InvestmentReconciliationResolutionSchema.parse(
          body.resolution,
        );
        current = {
          ...current,
          revision: 2,
          status: 'resolved',
          effectiveStatus: 'resolved',
          history: [
            event,
            {
              ...event,
              revision: 2,
              kind: 'resolved',
              resolution,
              evidenceSnapshots: [{ id: id(6), sourceDigest: 'd'.repeat(64) }],
              correctiveRecordSnapshots: [
                {
                  kind: 'movement',
                  id: id(10),
                  snapshot: {
                    as_of: '2026-09-01',
                    quantity: '0.125',
                    source_reference: 'Broker correction',
                  },
                },
              ],
            },
          ],
        };
      } else if (path.endsWith('/reopen')) {
        const newer = {
          ...comparison,
          valuationRunId: id(12),
          comparisonHash: 'c'.repeat(64),
          calculatedQuantity: '10.125',
          difference: '0',
          status: 'matched' as const,
        };
        current = {
          ...current,
          revision: 3,
          status: 'open',
          effectiveStatus: 'open',
          sourcesCurrent: true,
          comparison: newer,
          history: [
            ...current.history,
            {
              ...event,
              revision: 3,
              kind: 'reopened',
              reason: String(body.reason),
              comparison: newer,
            },
          ],
        };
      } else if (!path.endsWith('/reconciliations'))
        throw new Error(`Unexpected write ${path}`);
      result = current;
    } else if (path.endsWith('/corrective-records'))
      result = {
        items: [
          {
            kind: 'movement',
            id: id(10),
            label: 'Broker correction · 0.125 shares',
            effectiveOn: '2026-09-01',
            evidenceIds: [id(6)],
          },
        ],
        offset: 0,
        limit: 50,
        total: 1,
      };
    else if (path.endsWith('/reconciliations/preview')) {
      const run = new URL(request.url()).searchParams.get('valuationRunId');
      result = {
        bookId: id(1),
        workspaceId: id(8),
        sourcesCurrent: true,
        comparison:
          run === id(12)
            ? {
                ...comparison,
                valuationRunId: id(12),
                comparisonHash: 'c'.repeat(64),
                calculatedQuantity: '10.125',
                difference: '0',
                status: 'matched',
              }
            : comparison,
      };
    } else if (path.endsWith('/reconciliations'))
      result = {
        items: exists ? [current] : [],
        offset: 0,
        limit: 50,
        total: exists ? 1 : 0,
      };
    else if (path.endsWith(`/reconciliations/${id(7)}`)) result = current;
    else if (path.endsWith('/valuation-runs'))
      result = {
        runs: [
          {
            id: id(2),
            asOf: '2026-09-01',
            status: 'complete',
            calculationVersion: 'v1',
          },
          {
            id: id(12),
            asOf: '2026-09-02',
            status: 'complete',
            calculationVersion: 'v1',
          },
        ],
        nextOffset: null,
      };
    else if (path.includes('/valuation-runs/'))
      result = {
        id: path.split('/').at(-1),
        result: { reconciliations: [comparison] },
      };
    else if (path.endsWith('/investments'))
      result = {
        instruments: [{ id: id(5), name: 'Example shares' }],
        openings: [],
        observedPositions: [],
      };
    else if (path.endsWith('/evidence'))
      result = {
        documents: [
          { id: id(6), filename: 'Broker statement.pdf', format: 'pdf' },
        ],
        nextOffset: null,
      };
    else result = { trialBalance: [], periods: [], journals: [] };
    return route.fulfill({ json: result });
  });
  await page.goto('/finance');
  await expect(page.getByLabel('Accounting book')).toHaveValue(id(1));
  await page
    .getByRole('tab', { name: 'Accounts & investments', exact: true })
    .click();
  const panel = page.getByRole('region', {
    name: 'Investment reconciliation cases',
    exact: true,
  });
  await panel
    .getByRole('button', { name: 'Open reconciliation review', exact: true })
    .click();
  await expect(
    panel.getByRole('combobox', { name: 'Saved valuation', exact: true }),
  ).toBeVisible();
  return {
    panel,
    writes,
    errors,
    lose: () => {
      lose = true;
    },
    stale: () => {
      current = {
        ...current,
        effectiveStatus: 'reopen-required',
        sourcesCurrent: false,
      };
    },
    deny: () => {
      denied = true;
    },
  };
}
async function preview(page: Page, run = id(2)) {
  const panel = page.getByRole('region', {
    name: 'Investment reconciliation cases',
    exact: true,
  });
  await panel
    .getByRole('combobox', { name: 'Saved valuation', exact: true })
    .selectOption(run);
  await expect(
    panel
      .getByRole('combobox', {
        name: 'Observed statement position',
        exact: true,
      })
      .locator('option'),
  ).toHaveCount(2);
  await panel
    .getByRole('combobox', { name: 'Observed statement position', exact: true })
    .selectOption(id(3));
  await panel
    .getByRole('button', { name: 'Preview saved comparison', exact: true })
    .click();
  await expect(
    panel.getByRole('region', {
      name: 'Reviewed comparison preview',
      exact: true,
    }),
  ).toBeVisible();
}
test('real mounted reconciliation create, resolve, stale reopen, mobile history and revocation', async ({
  page,
}) => {
  await mkdir(artifacts, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1050 });
  const f = await fixture(page);
  await preview(page);
  expect(f.writes).toHaveLength(0);
  await expect(
    f.panel.getByRole('region', { name: 'Reviewed comparison preview' }),
  ).toContainText('0.125');
  await f.panel.screenshot({ path: `${artifacts}/preview-desktop.png` });
  f.lose();
  await f.panel
    .getByRole('button', { name: 'Create reconciliation case', exact: true })
    .click();
  await expect(f.panel.getByRole('alert')).toBeVisible();
  await f.panel
    .getByRole('button', { name: 'Create reconciliation case', exact: true })
    .click();
  await expect(
    f.panel.getByRole('region', {
      name: 'Saved reconciliation detail',
      exact: true,
    }),
  ).toBeVisible();
  expect(f.writes[0]).toEqual(f.writes[1]);
  expect(f.writes[0]!.body).toEqual({
    valuationRunId: id(2),
    observedPositionId: id(3),
    expectedComparisonHash: comparison.comparisonHash,
  });
  await f.panel
    .getByRole('combobox', { name: 'Resolution type', exact: true })
    .selectOption('corrective-records');
  await f.panel
    .getByRole('textbox', { name: 'Reviewed explanation', exact: true })
    .fill(
      'The saved broker movement corrects the reported fractional quantity.',
    );
  await f.panel
    .getByRole('checkbox', { name: 'Broker statement.pdf', exact: true })
    .check();
  await f.panel.getByRole('checkbox', { name: /Broker correction/ }).check();
  await page.setViewportSize({ width: 390, height: 844 });
  await f.panel
    .getByRole('button', { name: 'Save reviewed resolution', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${artifacts}/resolution-mobile.png` });
  expect(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await f.panel
    .getByRole('button', { name: 'Save reviewed resolution', exact: true })
    .click();
  await expect(
    f.panel.getByRole('heading', {
      name: 'Saved case · revision 2 · resolved',
      exact: true,
    }),
  ).toBeVisible();
  expect(f.writes[2]!.body).toMatchObject({
    expectedRevision: 1,
    resolution: {
      kind: 'corrective-records',
      correctiveRecords: [{ kind: 'movement', id: id(10) }],
      evidenceIds: [id(6)],
    },
  });
  f.stale();
  await f.panel
    .getByRole('button', {
      name: 'Refresh reconciliation sources',
      exact: true,
    })
    .click();
  await f.panel
    .getByRole('button', { name: /Example shares.*reopen-required/ })
    .click();
  await expect(f.panel.getByText(/Resolution is unavailable/)).toBeVisible();
  await expect(
    f.panel.getByRole('button', {
      name: 'Save reviewed resolution',
      exact: true,
    }),
  ).toHaveCount(0);
  await preview(page, id(12));
  await f.panel
    .getByRole('textbox', { name: 'Reason for reopening', exact: true })
    .fill('Reviewed the newer saved valuation after the source correction.');
  await f.panel
    .getByRole('button', {
      name: 'Reopen with reviewed valuation',
      exact: true,
    })
    .click();
  await expect(
    f.panel.getByRole('heading', {
      name: 'Saved case · revision 3 · open',
      exact: true,
    }),
  ).toBeVisible();
  await expect(f.panel.getByText(/Revision 1 · created/)).toBeVisible();
  await expect(f.panel.getByText(/Revision 2 · resolved/)).toBeVisible();
  await expect(f.panel.getByText(/Revision 3 · reopened/)).toBeVisible();
  expect(f.writes[3]!.body).toMatchObject({
    expectedRevision: 2,
    valuationRunId: id(12),
    expectedComparisonHash: 'c'.repeat(64),
  });
  await f.panel.getByText(/Revision 3 · reopened/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${artifacts}/reopened-history-mobile.png` });
  expect(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await expectNoSeriousAccessibilityViolations(page);
  f.deny();
  await f.panel
    .getByRole('button', {
      name: 'Refresh reconciliation sources',
      exact: true,
    })
    .click();
  await expect(f.panel.getByRole('alert')).toContainText('Current book access');
  await expect(
    f.panel.getByRole('region', {
      name: 'Saved reconciliation detail',
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    f.panel.getByText('Broker statement.pdf', { exact: true }),
  ).toHaveCount(0);
  expect(f.errors).toEqual([]);
});

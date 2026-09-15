import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import type { FinanceAutomationGrant } from '@emdo/contracts/browser';
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
  allowedCapabilities: ['finance.documents.extract'],
  authorityRevision: { membership: 1, bookAccess: 1, entitlement: 1 },
  limits: {
    maxRuns: 10,
    maxAttemptsPerRun: 3,
    maxItemsPerRun: 1,
    maxTotalItems: 10,
    currency: 'CAD',
    maxAmountPerRun: '0',
    maxTotalAmount: '0',
  },
  validFrom: '2026-01-01T00:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z',
};
const document = {
  id: id(5),
  filename: 'September statement.pdf',
  format: 'pdf',
  sourceDigest: 'a'.repeat(64),
};
const intent = {
  schemaVersion: 1,
  evidenceId: document.id,
  expectedSourceDigest: document.sourceDigest,
  standardizationRunId: id(6),
  expectedRunRevision: 2,
  expectedExtractionRevision: 0,
};
const record = {
  run: {
    request: {
      operationId: id(7),
      grantId: grant.id,
      grantRevision: 1,
      workspaceId: grant.workspaceId,
      bookId: grant.bookId,
      capability: 'finance.documents.extract',
      requestHash: 'b'.repeat(64),
      itemCount: 1,
      currency: 'CAD',
      amount: '0',
      extraction: intent,
    },
    revision: 1,
    attempts: 0,
    status: 'queued',
    outcomeReference: null,
  },
  createdAt: '2026-09-15T00:00:00Z',
  blockedReason: null,
};

const artifacts = '../../output/playwright/extraction-automation';
async function fixture(page: Page) {
  await mockAuthenticatedSession(page);
  const writes: { path: string; body: unknown; key: string }[] = [];
  let denied = false,
    lose = false,
    enqueued = false;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const completed = {
    ...record,
    run: {
      ...record.run,
      status: 'completed',
      attempts: 1,
      outcomeReference: id(7),
    },
  };
  const result = {
    schemaVersion: 1,
    kind: 'finance-document-extraction',
    operationId: id(7),
    workspaceId: grant.workspaceId,
    bookId: grant.bookId,
    evidenceId: document.id,
    sourceDigest: document.sourceDigest,
    standardizationRunId: intent.standardizationRunId,
    extractionRevision: 1,
    extractionDigest: 'c'.repeat(64),
    summary: {
      revision: 1,
      adapterId: 'finance.pdf-ocr',
      adapterVersion: '1',
      sourceDigest: document.sourceDigest,
      extractionDigest: 'c'.repeat(64),
      status: 'needs-source-review',
      tableCount: 0,
      sheetCount: 0,
      pageCount: 2,
      truncated: false,
      issues: ['Review the two original PDF pages.'],
    },
    approval: 'not-granted',
    posting: 'not-performed',
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
  await page.route('**/api/v2/finance/books**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith('/books'))
      return route.fulfill({
        json: {
          books: [
            {
              id: grant.bookId,
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
    if (request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe(
        'e2e-csrf-token-01234567890123456789',
      );
      writes.push({
        path,
        body: request.postDataJSON(),
        key: request.headers()['idempotency-key']!,
      });
      if (path.endsWith('/extractions/prepare'))
        return route.fulfill({ json: intent });
      if (path.endsWith('/automations/runs')) {
        enqueued = true;
        if (lose) {
          lose = false;
          return route.abort('failed');
        }
        return route.fulfill({ json: record });
      }
      throw new Error(`Unexpected write ${path}`);
    }
    if (path.endsWith('/automations/grants'))
      return route.fulfill({ json: { grants: [grant] } });
    if (path.endsWith('/evidence'))
      return route.fulfill({
        json: { documents: [document], nextOffset: null },
      });
    if (path.endsWith('/automations/runs'))
      return route.fulfill({
        json: { runs: enqueued ? [record] : [], nextOffset: null },
      });
    if (path.endsWith(`/automations/runs/${id(7)}`))
      return route.fulfill({ json: completed });
    if (path.endsWith(`/extractions/results/${id(7)}`))
      return route.fulfill({ json: result });
    return route.fulfill({
      json: { trialBalance: [], periods: [], journals: [] },
    });
  });
  await page.goto('/finance');
  await expect(page.getByLabel('Accounting book')).toHaveValue(grant.bookId);
  await page.getByRole('tab', { name: 'Automations', exact: true }).click();
  const panel = page.getByRole('region', {
    name: 'Document extraction automation',
    exact: true,
  });
  await panel
    .getByRole('button', { name: 'Open document extraction', exact: true })
    .click();
  await panel
    .getByRole('combobox', { name: 'Saved document', exact: true })
    .selectOption(document.id);
  await panel
    .getByRole('combobox', { name: 'Extraction grant', exact: true })
    .selectOption(grant.id);
  return {
    panel,
    writes,
    errors,
    deny: () => {
      denied = true;
    },
    lose: () => {
      lose = true;
    },
  };
}
test('prepared extraction is inert, explicit enqueue retries identically and shows exact saved outcome on desktop/mobile', async ({
  page,
}) => {
  await mkdir(artifacts, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  const f = await fixture(page);
  await f.panel
    .getByRole('button', { name: 'Prepare extraction scope', exact: true })
    .click();
  await expect(
    f.panel.getByRole('region', { name: 'Prepared extraction scope' }),
  ).toBeVisible();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]!.body).toEqual({
    evidenceId: document.id,
    expectedSourceDigest: document.sourceDigest,
  });
  await f.panel.screenshot({ path: `${artifacts}/prepared-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await f.panel
    .getByRole('region', { name: 'Prepared extraction scope' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${artifacts}/prepared-mobile.png` });
  expect(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  f.lose();
  await f.panel
    .getByRole('button', { name: 'Queue reviewed extraction', exact: true })
    .click();
  await expect(f.panel.getByRole('alert')).toBeVisible();
  await f.panel
    .getByRole('button', { name: 'Queue reviewed extraction', exact: true })
    .click();
  await expect(
    f.panel.getByText('Extraction request saved. Check its status below.'),
  ).toBeVisible();
  const calls = f.writes.filter((w) => w.path.endsWith('/automations/runs'));
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0]!.body).toEqual({
    grantId: grant.id,
    capability: 'finance.documents.extract',
    targets: [document.id],
    currency: 'CAD',
    amount: '0',
    extraction: intent,
  });
  await f.panel
    .getByRole('button', { name: 'Refresh extraction result', exact: true })
    .click();
  await expect(
    f.panel.getByText('Review the two original PDF pages.'),
  ).toBeVisible();
  await expect(f.panel.getByText('Status: completed.')).toBeVisible();
  await f.panel
    .getByRole('region', { name: 'Saved extraction result' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${artifacts}/completed-mobile.png` });
  await expectNoSeriousAccessibilityViolations(page);
  expect(f.errors).toEqual([]);
  expect(f.writes.every((w) => !/approve|posting|journal/.test(w.path))).toBe(
    true,
  );
});
test('revoked book access clears prepared document scope and saved results', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.panel
    .getByRole('button', { name: 'Prepare extraction scope', exact: true })
    .click();
  await expect(
    f.panel.getByRole('region', { name: 'Prepared extraction scope' }),
  ).toBeVisible();
  f.deny();
  await f.panel
    .getByRole('button', { name: 'Open document extraction', exact: true })
    .click();
  await expect(f.panel.getByRole('alert')).toContainText('Current access');
  await expect(
    f.panel.getByRole('region', { name: 'Prepared extraction scope' }),
  ).toHaveCount(0);
  await expect(
    f.panel.getByRole('option', { name: 'September statement.pdf · PDF' }),
  ).toHaveCount(0);
  await expect(
    f.panel.getByRole('region', { name: 'Saved extraction result' }),
  ).toHaveCount(0);
  expect(f.writes).toHaveLength(1);
  expect(f.errors).toEqual([]);
});

import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import {
  FinanceAutomationScheduleDefinitionSchema,
  type FinanceAutomationGrant,
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
  allowedCapabilities: ['finance.documents.extract', 'finance.journals.draft'],
  authorityRevision: { membership: 1, bookAccess: 1, entitlement: 1 },
  limits: {
    maxRuns: 10,
    maxAttemptsPerRun: 3,
    maxItemsPerRun: 10,
    maxTotalItems: 100,
    currency: 'CAD',
    maxAmountPerRun: '1000',
    maxTotalAmount: '10000',
  },
  validFrom: '2020-01-01T00:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z',
};
const artifacts = '../../output/playwright/source-schedules';
async function fixture(page: Page, kind: 'extraction' | 'journal') {
  await mockAuthenticatedSession(page);
  let denied = false,
    lose = false,
    changed = false,
    sequence = 10;
  const writes: { path: string; body: Record<string, unknown>; key: string }[] =
      [],
    errors: string[] = [];
  const rows: unknown[] = [],
    receipts = new Map<string, unknown>();
  const extraction = () => ({
    schemaVersion: 1,
    evidenceId: id(5),
    expectedSourceDigest: 'a'.repeat(64),
    standardizationRunId: id(6),
    expectedRunRevision: changed ? 3 : 2,
    expectedExtractionRevision: changed ? 2 : 1,
  });
  const journal = () => ({
    schemaVersion: 1,
    batchId: id(5),
    expectedBatchRevision: changed ? 8 : 7,
    expectedSnapshotHash: (changed ? 'c' : 'b').repeat(64),
  });
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
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>,
        key = request.headers()['idempotency-key']!;
      expect(request.headers()['x-csrf-token']).toBe(
        'e2e-csrf-token-01234567890123456789',
      );
      writes.push({ path, body, key });
      if (receipts.has(key)) return route.fulfill({ json: receipts.get(key) });
      let value: unknown;
      if (path.endsWith('/extractions/prepare')) value = extraction();
      else if (path.endsWith('/journal-drafts/prepare'))
        value = {
          journal: journal(),
          itemCount: 2,
          currency: 'CAD',
          amount: '12.50',
        };
      else if (path.endsWith('/schedules')) {
        const definition = FinanceAutomationScheduleDefinitionSchema.parse({
            ...body,
            workspaceId: id(3),
            bookId: id(1),
          }),
          scheduleId = id(sequence++);
        value = {
          schedule: {
            id: scheduleId,
            definitionRevision: 1,
            stateRevision: 1,
            status: 'active',
            definition,
          },
          cursor: { scheduleId, definitionRevision: 1, nextOrdinal: 0 },
          nextDueAt: '2026-10-01T13:00:00Z',
          blockedReason: null,
          createdAt: '2026-09-15T00:00:00Z',
          updatedAt: '2026-09-15T00:00:00Z',
        };
        rows.push(value);
      } else if (path.endsWith('/state')) {
        const scheduleId = path.split('/').at(-2);
        const prior = rows.find(
          (value) =>
            (value as { schedule: { id: string } }).schedule.id === scheduleId,
        ) as { schedule: Record<string, unknown> };
        value = {
          ...prior,
          schedule: {
            ...prior.schedule,
            status: body.status,
            stateRevision: Number(body.expectedStateRevision) + 1,
          },
          blockedReason: changed
            ? kind === 'journal'
              ? 'finance-journal-source-invalid'
              : 'extraction-source-revision-conflict'
            : null,
        };
      } else throw new Error(`Unexpected source schedule write ${path}`);
      receipts.set(key, value);
      if (lose && path.endsWith('/schedules')) {
        lose = false;
        return route.abort('failed');
      }
      return route.fulfill({ json: value });
    }
    if (path.endsWith('/automations/grants'))
      return route.fulfill({ json: { grants: [grant] } });
    if (path.endsWith('/schedules/options'))
      return route.fulfill({ json: { tzdbVersion: '2026a' } });
    if (path.endsWith('/schedules'))
      return route.fulfill({ json: { schedules: rows } });
    if (path.endsWith('/evidence'))
      return route.fulfill({
        json: {
          documents: [
            {
              id: id(5),
              filename: 'Fixed statement.pdf',
              format: 'pdf',
              sourceDigest: 'a'.repeat(64),
            },
          ],
          nextOffset: null,
        },
      });
    if (path.endsWith('/imports'))
      return route.fulfill({
        json: {
          imports: [
            {
              id: id(5),
              filename: 'Reviewed statement.csv',
              status: 'review',
              revision: changed ? 8 : 7,
            },
          ],
        },
      });
    return route.fulfill({
      json: { trialBalance: [], periods: [], journals: [] },
    });
  });
  await page.goto('/finance');
  await expect(page.getByLabel('Accounting book')).toHaveValue(id(1));
  await page.getByRole('tab', { name: 'Automations', exact: true }).click();
  const panel = page.getByRole('region', {
    name: 'Recurring schedules',
    exact: true,
  });
  await panel
    .getByRole('button', { name: 'Load schedules', exact: true })
    .click();
  await expect(
    panel.getByRole('button', {
      name: 'New source or report schedule',
      exact: true,
    }),
  ).toBeVisible();
  return {
    panel,
    writes,
    errors,
    extraction,
    journal,
    lose: () => {
      lose = true;
    },
    change: () => {
      changed = true;
    },
    deny: () => {
      denied = true;
    },
  };
}
for (const kind of ['extraction', 'journal'] as const)
  test(`recurring ${kind} exact preparation/retry and explicit changed-source replacement`, async ({
    page,
  }) => {
    await mkdir(artifacts, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1050 });
    const f = await fixture(page, kind);
    await f.panel
      .getByRole('button', {
        name: 'New source or report schedule',
        exact: true,
      })
      .click();
    await f.panel
      .getByRole('combobox', { name: 'Scheduled operation', exact: true })
      .selectOption(kind);
    await f.panel
      .getByRole('button', { name: 'Load saved source choices', exact: true })
      .click();
    await f.panel
      .getByRole('combobox', {
        name:
          kind === 'extraction' ? 'Saved document' : 'Reviewed source import',
        exact: true,
      })
      .selectOption(id(5));
    await f.panel
      .getByRole('button', { name: 'Prepare scheduled source', exact: true })
      .click();
    await expect(
      f.panel.getByLabel('Prepared schedule source', { exact: true }),
    ).toContainText(
      kind === 'journal'
        ? '2 proposed journal lines · 12.50 CAD'
        : '1 document · 0 CAD',
    );
    expect(f.writes).toHaveLength(1);
    await f.panel
      .getByRole('region', { name: 'Scheduled source review', exact: true })
      .screenshot({ path: `${artifacts}/${kind}-prepared-desktop.png` });
    f.lose();
    await f.panel
      .getByRole('button', { name: 'Save schedule', exact: true })
      .click();
    await expect(f.panel.getByRole('alert')).toBeVisible();
    await f.panel
      .getByRole('button', { name: 'Save schedule', exact: true })
      .click();
    await expect(f.panel.getByText(/Schedule saved/)).toBeVisible();
    expect(f.writes[1]).toEqual(f.writes[2]);
    expect(f.writes[1]!.body).toMatchObject({
      capability:
        kind === 'journal'
          ? 'finance.journals.draft'
          : 'finance.documents.extract',
      targets: [id(5)],
      money: { currency: 'CAD', amount: kind === 'journal' ? '12.50' : '0' },
      ...(kind === 'journal'
        ? { journal: f.journal() }
        : { extraction: f.extraction() }),
    });
    f.change();
    await f.panel
      .getByRole('button', { name: 'Pause schedule', exact: true })
      .click();
    await expect(
      f.panel.getByText(/saved source no longer matches/),
    ).toBeVisible();
    await f.panel
      .getByRole('button', { name: 'Edit as replacement', exact: true })
      .click();
    await expect(
      f.panel.getByRole('combobox', {
        name: 'Scheduled operation',
        exact: true,
      }),
    ).toHaveValue(kind);
    await expect(f.panel.getByText(/Saved pin:/)).toContainText(
      kind === 'journal' ? 'revision 7' : 'extraction revision 1',
    );
    await expect(
      f.panel.getByLabel('Prepared schedule source', { exact: true }),
    ).toHaveCount(0);
    const count = f.writes.length;
    await f.panel
      .getByRole('button', { name: 'Save replacement', exact: true })
      .click();
    expect(f.writes).toHaveLength(count);
    await f.panel
      .getByRole('button', { name: 'Load saved source choices', exact: true })
      .click();
    await f.panel
      .getByRole('combobox', {
        name:
          kind === 'extraction' ? 'Saved document' : 'Reviewed source import',
        exact: true,
      })
      .selectOption(id(5));
    await f.panel
      .getByRole('button', { name: 'Prepare scheduled source', exact: true })
      .click();
    await expect(
      f.panel.getByLabel('Prepared schedule source', { exact: true }),
    ).toContainText(
      kind === 'journal' ? 'Import revision 8' : 'Extraction revision 2',
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await f.panel
      .getByRole('region', { name: 'Scheduled source review', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${artifacts}/${kind}-replacement-mobile.png`,
    });
    expect(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await expectNoSeriousAccessibilityViolations(page);
    await f.panel
      .getByRole('button', { name: 'Save replacement', exact: true })
      .click();
    await expect(f.panel.getByText(/Replacement saved/)).toBeVisible();
    const last = f.writes.at(-1)!;
    expect(last.body).toHaveProperty(
      kind,
      kind === 'journal' ? f.journal() : f.extraction(),
    );
    expect(
      f.writes.every(
        (item) =>
          !item.path.endsWith('/post') &&
          !item.path.endsWith('/automations/runs'),
      ),
    ).toBe(true);
    f.deny();
    await f.panel
      .getByRole('button', { name: 'Refresh schedules', exact: true })
      .click();
    await expect(f.panel.getByRole('alert')).toContainText(
      'Current administrator access',
    );
    await expect(
      f.panel.getByRole('button', { name: 'Edit as replacement', exact: true }),
    ).toHaveCount(0);
    await expect(
      f.panel.getByText(/Fixed document|Reviewed import/),
    ).toHaveCount(0);
    expect(f.errors).toEqual([]);
  });

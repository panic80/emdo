import { expect, test } from '@playwright/test';
import type { ScheduleRecord } from '../src/features/finance-v1/finance-schedule-api.js';
import {
  expectNoSeriousAccessibilityViolations,
  mockAuthenticatedSession,
} from './support.js';
const id = '00000000-0000-4000-8000-000000000001';
const grant = {
  id,
  revision: 1,
  workspaceId: id,
  bookId: id,
  grantedByUserId: id,
  executor: 'emdo-managed',
  specialist: 'finance',
  status: 'active',
  allowedCapabilities: ['finance.reports.generate'],
  authorityRevision: { membership: 1, bookAccess: 1, entitlement: 1 },
  limits: {
    maxRuns: 10,
    maxAttemptsPerRun: 2,
    maxItemsPerRun: 1,
    maxTotalItems: 10,
    currency: 'CAD',
    maxAmountPerRun: '0',
    maxTotalAmount: '0',
  },
  validFrom: '2020-01-01T00:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z',
};
test('schedule monthly report, pause, edit replacement and retire on desktop and mobile', async ({
  page,
}) => {
  await mockAuthenticatedSession(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let records: ScheduleRecord[] = [];
  await page.route('**/api/v1/experience/finance*', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        locale: 'en-CA',
        connectivity: 'online',
        quota: {
          documentsUsed: 0,
          documentsLimit: 10000,
          bytesUsed: 0,
          bytesLimit: 53687091200,
        },
        reviewedCadTotals: [],
        recentActivity: [],
        budgets: [],
      },
    }),
  );
  await page.route('**/api/v2/finance/books**', (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path.endsWith('/options'))
      return route.fulfill({ json: { tzdbVersion: '2026a' } });
    if (path.endsWith('/automations/grants'))
      return route.fulfill({ json: { grants: [grant] } });
    if (path.includes('/automations/schedules')) {
      if (req.method() === 'POST') {
        expect(req.headers()['x-csrf-token']).toBe(
          'e2e-csrf-token-01234567890123456789',
        );
        expect(req.headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
        const body = req.postDataJSON();
        if (path.endsWith('/state')) {
          const r = records.find((r) => path.includes(r.schedule.id))!;
          expect(body.expectedStateRevision).toBe(r.schedule.stateRevision);
          r.schedule = {
            ...r.schedule,
            status: body.status,
            stateRevision: r.schedule.stateRevision + 1,
          };
          return route.fulfill({ json: r });
        }
        expect(body).toMatchObject({
          targets: [id],
          money: { currency: 'CAD', amount: '0' },
          cadence: { tzdbVersion: '2026a' },
        });
        expect(body.workspaceId).toBeUndefined();
        const sid = `00000000-0000-4000-8000-00000000000${records.length + 3}`;
        const r = {
          schedule: {
            id: sid,
            definitionRevision: 1,
            stateRevision: 1,
            status: 'active',
            definition: { ...body, workspaceId: id, bookId: id },
          },
          cursor: { scheduleId: sid, definitionRevision: 1, nextOrdinal: 0 },
          nextDueAt: null,
          blockedReason: null,
          createdAt: '2026-09-13T00:00:00Z',
          updatedAt: '2026-09-13T00:00:00Z',
        };
        records = [r as ScheduleRecord, ...records];
        return route.fulfill({ json: r });
      }
      return route.fulfill({ json: records });
    }
    if (path.endsWith('/books'))
      return route.fulfill({
        json: {
          books: [
            {
              id,
              name: 'Operations',
              entityName: 'Example',
              country: 'CA',
              functionalCurrency: 'CAD',
              role: 'administrator',
            },
          ],
        },
      });
    return route.fulfill({
      json: { trialBalance: [], periods: [], journals: [] },
    });
  });
  await page.goto('/finance');
  await page.getByRole('tab', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'Load schedules' }).click();
  await page.getByRole('button', { name: 'New report schedule' }).click();
  await page.getByLabel('IANA time zone').fill('America/Toronto');
  await page.getByLabel('Day of month', { exact: true }).fill('31');
  await page
    .getByLabel('When the clock repeats this time')
    .selectOption('later');
  await expectNoSeriousAccessibilityViolations(page);
  await page.screenshot({
    path: '/tmp/emdo-finance-schedules-desktop.png',
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Save schedule', exact: true })
    .click();
  await expect(page.getByText(/Schedule saved/)).toBeVisible();
  await page
    .getByRole('button', { name: 'Pause schedule', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Resume schedule' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Edit as replacement' }).click();
  await expect(page.getByLabel('Day of month', { exact: true })).toHaveValue(
    '31',
  );
  await page.getByLabel('Cadence').selectOption('weekly');
  await page
    .getByLabel('First weekly date (sets the weekday)')
    .fill('2026-10-05');
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoSeriousAccessibilityViolations(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: '/tmp/emdo-finance-schedules-mobile.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Save replacement' }).click();
  await expect(page.getByText(/Replacement saved/)).toBeVisible();
  const active = page.locator('.finance-schedules .finance-grant').filter({
    has: page.getByRole('button', { name: 'Pause schedule', exact: true }),
  });
  await active
    .getByRole('button', { name: 'Retire schedule', exact: true })
    .click();
  await active.getByRole('button', { name: 'Confirm retirement' }).click();
  await expect(page.getByText(/Schedule retired permanently/)).toBeVisible();
  expect(records[0]?.schedule.status).toBe('retired');
  expect(records[1]?.schedule.status).toBe('paused');
  expect(errors).toEqual([]);
});

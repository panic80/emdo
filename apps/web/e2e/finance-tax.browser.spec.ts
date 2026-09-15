import { test, expect, type Page } from '@playwright/test';
import {
  mockAuthenticatedSession,
  expectNoSeriousAccessibilityViolations,
} from './support.js';
import {
  taxFixture,
  taxCaseId,
  taxBookId,
  taxSourceId,
  taxMemberId,
  taxAuthorizationId,
  taxSecondAuthorizationId,
} from '../test/finance-tax-fixture.js';

async function taxMock(page: Page) {
  await mockAuthenticatedSession(page);
  const fixture = taxFixture();
  const state = {
    empty: false,
    status: 200,
    blocked: false,
    authorizationCount: 0,
  };
  const writes: { path: string; body: Record<string, unknown>; key: string }[] =
    [];
  const turns: Record<string, unknown>[] = [],
    errors: string[] = [];
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
  await page.route('**/api/v1/household/memberships', (route) =>
    route.fulfill({ status: 403, json: {} }),
  );
  await page.route('**/api/v1/turns', (route) => {
    turns.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        schemaVersion: 1,
        runId: 'tax-explanation',
        status: 'accepted',
        replayed: false,
        route: 'finance',
      },
    });
  });
  await page.route('**/api/v2/finance/**', (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe(
        'e2e-csrf-token-01234567890123456789',
      );
      const body = request.postDataJSON(),
        key = request.headers()['idempotency-key']!;
      expect(key).toMatch(/^[a-f0-9-]{36}$/);
      writes.push({ path, body, key });
      if (path.endsWith('/tax/cases')) {
        state.empty = false;
        return route.fulfill({ json: fixture.receipt() });
      }
      if (path.endsWith('/declarations')) {
        const declaration = {
          sourceId: body.sourceId ?? taxSourceId,
          sourceRevision: (body.expectedSourceRevision ?? 0) + 1,
          contentHash: 'e'.repeat(64),
          factKey: body.factKey,
          category: body.category,
          value: body.value,
          reviewState: 'unreviewed' as const,
        };
        fixture.declarations.splice(
          0,
          fixture.declarations.length,
          declaration,
        );
        fixture.detail.declaredInputs = [declaration];
        fixture.detail.questionnaire.declarationSourceBindings = [
          {
            sourceId: declaration.sourceId,
            sourceRevision: declaration.sourceRevision,
            contentHash: declaration.contentHash,
          },
        ];
        fixture.advance();
        return route.fulfill({ json: fixture.receipt() });
      }
      if (path.endsWith('/book-sources')) {
        state.authorizationCount++;
        const binding = {
          bookId: taxBookId,
          snapshotRevision: state.authorizationCount,
          snapshotHash: 'f'.repeat(64),
          authorizationId:
            state.authorizationCount === 1
              ? taxAuthorizationId
              : taxSecondAuthorizationId,
          authorizationRevision: state.authorizationCount,
        };
        fixture.detail.questionnaire.sourceAuthorizationBindings = [binding];
        fixture.detail.questionnaire.intake.sourceBooks = [
          {
            bookId: taxBookId,
            snapshotRevision: binding.snapshotRevision,
            snapshotHash: binding.snapshotHash,
          },
        ];
        fixture.advance();
        return route.fulfill({ json: { ...fixture.receipt(), ...binding } });
      }
      if (path.includes('/book-sources/') && path.endsWith('/revoke')) {
        state.blocked = true;
        return route.fulfill({
          json: { caseId: taxCaseId, authorizationRevision: 2 },
        });
      }
      if (path.endsWith('/reset-after-source-revocation')) {
        state.blocked = false;
        fixture.detail.declaredInputs = [];
        fixture.detail.questionnaire.declarationSourceBindings = [];
        fixture.detail.questionnaire.sourceAuthorizationBindings = [];
        fixture.detail.questionnaire.intake.sourceBooks = [];
        fixture.advance();
        return route.fulfill({ json: fixture.receipt() });
      }
      if (path.endsWith('/grants/revoke')) {
        const grant = fixture.grants.find(
          (item) => item.userId === body.userId,
        )!;
        grant.status = 'revoked';
        grant.revokedAt = '2026-09-13T12:00:00.000Z';
        grant.revision++;
        return route.fulfill({
          json: { caseId: taxCaseId, revision: grant.revision },
        });
      }
      if (path.endsWith('/grants')) {
        const grant = fixture.grants.find(
          (item) => item.userId === body.userId,
        )!;
        grant.role = body.role;
        grant.revision++;
        return route.fulfill({
          json: { caseId: taxCaseId, revision: grant.revision },
        });
      }
      throw new Error(`Unexpected tax write: ${path}`);
    }
    if (path.endsWith('/books'))
      return route.fulfill({
        json: {
          books: fixture.books.map((book) => ({
            ...book,
            role: 'administrator',
          })),
        },
      });
    if (path.includes('/books/'))
      return route.fulfill({
        json: path.endsWith('/report-mappings')
          ? { mappings: [], reports: [] }
          : path.endsWith('/evidence')
            ? { evidence: [] }
            : { trialBalance: [], journals: [], periods: [], imports: [] },
      });
    if (path.endsWith('/tax/cases'))
      return route.fulfill({
        status: state.status,
        json:
          state.status === 200
            ? { cases: state.empty ? [] : [fixture.summary()] }
            : {},
      });
    if (path.endsWith('/grants'))
      return route.fulfill({ json: fixture.grants });
    if (state.blocked)
      return route.fulfill({
        status: 409,
        json: { code: 'finance-tax-source-revoked' },
      });
    if (state.status !== 200)
      return route.fulfill({ status: state.status, json: {} });
    if (path.endsWith('/assessment'))
      return route.fulfill({ json: fixture.assessment() });
    if (path.endsWith('/declarations'))
      return route.fulfill({ json: fixture.declarations });
    return route.fulfill({ json: fixture.detail });
  });
  await page.goto('/finance');
  await expect(page.getByLabel('Accounting book')).toHaveValue(taxBookId);
  await page.getByRole('tab', { name: 'Reports & tax', exact: true }).click();
  await page.getByRole('button', { name: 'Tax cases', exact: true }).click();
  await expect(page.getByLabel('Accounting book')).toBeHidden();
  return { ...fixture, state, writes, turns, errors };
}
async function openCase(page: Page) {
  await page
    .getByRole('button', { name: 'Open tax case 2025 · Personal income tax' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Saved inputs', exact: true }),
  ).toBeVisible();
}

test('private tax inputs, source recovery and case grants remain explicit across desktop and mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1505, height: 1045 });
  const { writes, turns, errors } = await taxMock(page);
  await expectNoSeriousAccessibilityViolations(page);
  await openCase(page);
  await page
    .getByRole('region', { name: 'Private tax case', exact: true })
    .screenshot({
      path: '/tmp/emdo-tax-summary-desktop.png',
      animations: 'disabled',
    });
  await page.getByRole('button', { name: 'Ask EMDO about this case' }).click();
  await expect.poll(() => turns.length).toBe(1);
  expect(turns[0]!.message).toContain('finance.tax.read');
  expect(turns[0]!.message).toContain('read-only explanation');
  expect(turns[0]!.message).toContain(taxCaseId);
  await page.getByRole('button', { name: 'Saved inputs', exact: true }).click();
  await page
    .getByRole('region', { name: 'Saved tax inputs', exact: true })
    .focus();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('table').getByText('Source reference', { exact: true }),
  ).toBeFocused();
  await page
    .getByRole('button', {
      name: 'Revise Employment income (CAD)',
      exact: true,
    })
    .click();
  await page.getByLabel('Declaration value').fill('9007199254740993.1200');
  await page.getByRole('button', { name: 'Review input', exact: true }).click();
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Save unreviewed input' }).click();
  await expect(page.getByRole('table')).toContainText('9007199254740993.1200');
  expect(writes[0]!.body).toMatchObject({
    expectedCaseRevision: 2,
    expectedSourceRevision: 1,
    value: { type: 'decimal', value: '9007199254740993.1200' },
  });
  await expectNoSeriousAccessibilityViolations(page);
  await page
    .getByRole('region', { name: 'Private tax case', exact: true })
    .screenshot({
      path: '/tmp/emdo-tax-inputs-desktop.png',
      animations: 'disabled',
    });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('region', { name: 'Saved tax inputs', exact: true })
    .scrollIntoViewIfNeeded();
  await page
    .getByRole('region', { name: 'Saved tax inputs', exact: true })
    .screenshot({
      path: '/tmp/emdo-tax-inputs-mobile.png',
      animations: 'disabled',
    });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expectNoSeriousAccessibilityViolations(page);
  await page.setViewportSize({ width: 1505, height: 1045 });

  await page
    .getByRole('button', { name: 'Sources & access', exact: true })
    .click();
  await page.getByLabel('Book to authorize').selectOption(taxBookId);
  await page
    .getByLabel('I authorize this book snapshot for this private tax case.')
    .check();
  await page.getByRole('button', { name: 'Authorize book snapshot' }).click();
  await expect(
    page.getByText('Saved snapshot 1 · authorization revision 1'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Change role', exact: true }).click();
  await page.getByLabel('Case role', { exact: false }).selectOption('reviewer');
  await page
    .getByRole('button', { name: 'Review case access', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save case access' }).click();
  await expect(
    page.getByText('reviewer · active · grant revision 3'),
  ).toBeVisible();
  expect(writes.at(-1)!.body).toEqual({
    userId: taxMemberId,
    role: 'reviewer',
    expectedGrantRevision: 2,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page
    .getByRole('button', { name: 'Sources & access', exact: true })
    .scrollIntoViewIfNeeded();
  expect(
    await page
      .locator('.finance-tax-access')
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe('none');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole('region', { name: 'Private tax case', exact: true })
    .screenshot({
      path: '/tmp/emdo-tax-access-mobile.png',
      animations: 'disabled',
    });
  await expectNoSeriousAccessibilityViolations(page);
  await page
    .getByRole('button', {
      name: 'Review removal of Personal finances',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('button', { name: 'Remove source authorization' }),
  ).toBeDisabled();
  await page
    .getByLabel(
      'I understand this will make the current questionnaire inputs unavailable.',
    )
    .check();
  await page
    .getByRole('button', { name: 'Remove source authorization' })
    .click();
  await page
    .getByRole('button', { name: 'Review questionnaire reset' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Reset questionnaire inputs' }),
  ).toBeDisabled();
  await page
    .getByLabel(
      'I understand which questionnaire inputs will be removed and that declaration sources will remain.',
    )
    .check();
  await page
    .getByRole('region', { name: 'Private tax case', exact: true })
    .screenshot({
      path: '/tmp/emdo-tax-recovery-mobile.png',
      animations: 'disabled',
    });
  await expectNoSeriousAccessibilityViolations(page);
  await page
    .getByRole('button', { name: 'Reset questionnaire inputs' })
    .click();
  await page.getByRole('button', { name: 'Saved inputs', exact: true }).click();
  await expect(
    page.getByText('No inputs attached to this questionnaire'),
  ).toBeVisible();
  await page
    .getByText('Retained declaration sources (1)', { exact: true })
    .click();
  await expect(
    page.getByText('9007199254740993.1200', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Sources & access', exact: true })
    .click();
  await page.getByLabel('Book to authorize').selectOption(taxBookId);
  await page
    .getByLabel('I authorize this book snapshot for this private tax case.')
    .check();
  await page.getByRole('button', { name: 'Authorize book snapshot' }).click();
  await expect(
    page.getByText('Saved snapshot 2 · authorization revision 2'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Case summary', exact: true }).click();
  await page
    .getByRole('button', { name: 'All tax cases' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: '/tmp/emdo-tax-summary-mobile-native.png',
    animations: 'disabled',
  });
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page.getByLabel('Accounting book')).toHaveValue(taxBookId);
  expect(errors).toEqual([]);
});

test('tax case setup reviews explicit scope and handles empty, unavailable and forbidden states honestly', async ({
  page,
}) => {
  const { state, writes, errors } = await taxMock(page);
  state.empty = true;
  await page.getByRole('button', { name: 'Refresh tax cases' }).click();
  await expect(page.getByText('No private cases on this page')).toBeVisible();
  await page.getByRole('button', { name: 'New tax case' }).click();
  for (const [label, value] of [
    ['Case title', '2025 Personal'],
    ['Person or legal entity', 'Jordan Chen'],
    ['Province, state or region code', 'CA-ON'],
    ['Tax year', '2025'],
    ['Form and version reference', 'T1-2025'],
  ])
    await page.getByLabel(label!).fill(value!);
  await page.getByLabel('Taxpayer type').selectOption('individual');
  await page
    .getByRole('combobox', { name: 'Country', exact: true })
    .selectOption('CA');
  await page.getByLabel('Return type').selectOption('income-tax-return');
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoSeriousAccessibilityViolations(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Review case setup' }).click();
  expect(writes).toHaveLength(0);
  await page.getByLabel('Review new tax case').screenshot({
    path: '/tmp/emdo-tax-create-mobile.png',
    animations: 'disabled',
  });
  await page
    .getByRole('button', { name: 'Create case · save inputs only' })
    .click();
  await expect(
    page.getByRole('button', { name: 'All tax cases' }),
  ).toBeVisible();
  expect(writes[0]!.body).toMatchObject({
    mode: 'intake-only',
    domesticResident: null,
    hasCrossBorderActivity: null,
  });
  expect(writes[0]!.body).not.toHaveProperty('packageId');
  state.status = 503;
  await page
    .getByRole('button', { name: 'Refresh tax case', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'not available right now',
  );
  await expect(
    page.getByRole('button', { name: 'Saved inputs', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'All tax cases' }).click();
  await expect(page.getByText('No private cases on this page')).toHaveCount(0);
  state.status = 403;
  await page.getByRole('button', { name: 'Refresh tax cases' }).click();
  await expect(page.getByRole('alert')).toContainText('access');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({
    path: '/tmp/emdo-tax-forbidden-mobile.png',
    animations: 'disabled',
    fullPage: true,
  });
  await expectNoSeriousAccessibilityViolations(page);
  expect(errors).toEqual([]);
});

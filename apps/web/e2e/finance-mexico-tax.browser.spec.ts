import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import {
  mockAuthenticatedSession,
  expectNoSeriousAccessibilityViolations,
} from './support.js';
import { taxWorkingFixture } from '../test/finance-tax-working-fixture.js';
import { taxBookId } from '../test/finance-tax-fixture.js';

async function setup(page: Page, assets = false) {
  await mockAuthenticatedSession(page);
  const fixture = taxWorkingFixture();
  let denied = false;
  let loseEntityAck = false;
  let entityReceipt: unknown;
  const mexicoScope = {
    country: 'MX',
    subdivision: 'MX-FED',
    taxpayerType: assets ? ('corporation' as const) : ('individual' as const),
    year: 2025,
    regime: 'income-tax-return',
    formVersion: assets
      ? 'declaracion-anual-pm-2025-regimen-general'
      : 'declaracion-anual-pf-2025-sueldos',
  };
  fixture.detail.questionnaire.intake.scope = mexicoScope;
  fixture.detail.questionnaire.binding.scope = mexicoScope;
  const writes: Array<{
    path: string;
    body: Record<string, unknown>;
    key: string;
  }> = [];
  const errors: string[] = [];
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
  await page.route('**/api/v2/finance/**', (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.includes('/tax/cases')) {
      if (denied) return route.fulfill({ status: 403, json: {} });
      if (path.endsWith('/working-papers'))
        return route.fulfill({
          json: {
            ...fixture.preparation(),
            workflowId: 'mx-fed-2025-working-papers',
            supportedScopes: [mexicoScope],
            questions: [
              {
                key: assets
                  ? 'corporation.investments.rows'
                  : 'salary.taxableIncome',
                label: assets
                  ? 'Investment assets'
                  : 'Reviewed taxable salary (MXN)',
                type: assets ? 'text' : 'decimal',
                required: true,
                locator: 'SAT salary working paper',
              },
            ],
          },
        });
      if (path.endsWith('/runs') && request.method() === 'GET')
        return route.fulfill({ json: { runs: [] } });
      const body =
        request.method() === 'POST'
          ? (request.postDataJSON() as Record<string, unknown>)
          : {};
      if (request.method() === 'POST') {
        expect(request.headers()['x-csrf-token']).toBe(
          'e2e-csrf-token-01234567890123456789',
        );
        const key = request.headers()['idempotency-key']!;
        expect(key).toMatch(/^[a-f0-9-]{36}$/u);
        writes.push({ path, body, key });
      }
      if (path.endsWith('/legal-entity') && request.method() === 'POST') {
        if (!entityReceipt) {
          expect(body.expectedCaseRevision).toBe(
            fixture.detail.currentRevision,
          );
          expect(body.legalEntityId).toBe(
            '70000000-0000-4000-8000-000000000099',
          );
          fixture.detail.questionnaire.intake.legalEntityId = String(
            body.legalEntityId,
          );
          fixture.advance();
          entityReceipt = fixture.receipt();
        }
        if (loseEntityAck) {
          loseEntityAck = false;
          return route.abort('failed');
        }
        return route.fulfill({ json: entityReceipt });
      }
      if (path.endsWith('/tax/cases') && request.method() === 'POST')
        return route.fulfill({ json: fixture.receipt() });
      const result = fixture.handle(request.url(), request.method(), body);
      return route.fulfill({ status: result.status, json: result.json });
    }
    if (path.endsWith('/books'))
      return route.fulfill({
        json: {
          books: fixture.books.map((book) => ({
            ...book,
            legalEntityId: '70000000-0000-4000-8000-000000000099',
            role: 'administrator',
          })),
        },
      });
    return route.fulfill({
      json: path.endsWith('/report-mappings')
        ? { mappings: [], reports: [] }
        : path.endsWith('/evidence')
          ? { evidence: [] }
          : { trialBalance: [], journals: [], periods: [], imports: [] },
    });
  });
  return {
    ...fixture,
    loseEntityResponse: () => {
      loseEntityAck = true;
    },
    writes,
    errors,
    revoke: () => {
      denied = true;
    },
  };
}
async function openWorking(page: Page) {
  await page.goto('/finance');
  await expect(page.getByLabel('Accounting book')).toHaveValue(taxBookId);
  await page.getByRole('tab', { name: 'Reports & tax', exact: true }).click();
  await page.getByRole('button', { name: 'Tax cases', exact: true }).click();
  await page
    .getByRole('button', { name: 'Open tax case 2025 · Personal income tax' })
    .click();
  await page
    .getByRole('button', { name: 'Working papers', exact: true })
    .click();
  await expect(page.getByLabel('Working-paper input progress')).toBeVisible();
}

test('Mexico presets, explicit entity choice and incomplete private working papers on desktop and mobile', async ({
  page,
}) => {
  const fixture = await setup(page);
  await openWorking(page);
  await expect(
    page.getByText(/Limited Mexico 2025 federal calculations/),
  ).toBeVisible();
  await expect(
    page.getByText('Incomplete working papers · not fileable'),
  ).toBeVisible();
  await page
    .getByText('Reviewed taxable salary (MXN)', { exact: true })
    .locator('xpath=ancestor::details')
    .locator('summary')
    .click();
  await expect(
    page.getByText('Reviewed taxable salary (MXN)', { exact: true }),
  ).toBeVisible();
  await mkdir('../../output/playwright/mexico-tax', { recursive: true });
  await page.screenshot({
    path: '../../output/playwright/mexico-tax/working-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoSeriousAccessibilityViolations(page);
  expect(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '../../output/playwright/mexico-tax/working-mobile.png',
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'All tax cases', exact: true })
    .click();
  await page.getByRole('button', { name: 'New tax case', exact: true }).click();
  for (const [label, type, form] of [
    ['salary individual', 'individual', 'declaracion-anual-pf-2025-sueldos'],
    [
      'professional sole proprietor',
      'sole-proprietor',
      'declaracion-anual-pf-2025-actividad-profesional',
    ],
    [
      'standalone corporation',
      'corporation',
      'declaracion-anual-pm-2025-regimen-general',
    ],
  ]) {
    await page
      .getByRole('button', { name: `Use Mexico 2025 ${label} scope` })
      .click();
    await expect(page.getByLabel('Taxpayer type')).toHaveValue(type!);
    await expect(page.getByRole('combobox', { name: /^Country/ })).toHaveValue(
      'MX',
    );
    await expect(page.getByLabel(/Form and version reference/)).toHaveValue(
      form!,
    );
  }
  await expect(
    page.getByRole('combobox', { name: /^Corporate legal entity/ }),
  ).toHaveValue('');
  await page
    .getByRole('combobox', { name: /^Corporate legal entity/ })
    .selectOption('70000000-0000-4000-8000-000000000099');
  await expect(
    page.getByRole('combobox', { name: /^Standalone corporation/ }),
  ).toHaveValue('unknown');
  await page
    .getByRole('textbox', { name: /^Case title/ })
    .fill('Mexico corporation 2025');
  await page
    .getByRole('textbox', { name: /^Person or legal entity/ })
    .fill('Synthetic Mexico corporation');
  await page.getByRole('button', { name: 'Review case setup' }).click();
  await expect(page.getByRole('textbox', { name: /^Case title/ })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: '../../output/playwright/mexico-tax/corporate-review-mobile.png',
    fullPage: true,
  });
  await expectNoSeriousAccessibilityViolations(page);
  await page
    .getByRole('button', { name: 'Create case · save inputs only' })
    .click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  expect(fixture.writes[0]!.body).toMatchObject({
    legalEntityId: '70000000-0000-4000-8000-000000000099',
    scope: {
      country: 'MX',
      subdivision: 'MX-FED',
      taxpayerType: 'corporation',
      formVersion: 'declaracion-anual-pm-2025-regimen-general',
    },
    standaloneCorporation: null,
  });
  await page
    .getByRole('button', { name: 'All tax cases', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Refresh tax cases', exact: true }),
  ).toBeEnabled();
  fixture.revoke();
  await page
    .getByRole('button', { name: 'Refresh tax cases', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Open tax case 2025 · Personal income tax',
    }),
  ).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test('Mexico asset rows save exact source facts from a mobile structured editor', async ({
  page,
}) => {
  const fixture = await setup(page, true);
  await openWorking(page);
  await page
    .getByText('Investment assets', { exact: true })
    .locator('xpath=ancestor::details')
    .locator('summary')
    .click();
  await page
    .getByRole('button', {
      name: 'Add working input: Investment assets',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('region', { name: 'Mexico investment assets' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add asset', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Asset identifier', exact: true })
    .fill('computer_1');
  await page
    .getByRole('combobox', { name: /^Asset class/ })
    .selectOption('computer-equipment');
  await page.getByLabel('Acquisition date').fill('2025-01-01');
  await page.getByLabel(/First-use date/).fill('2025-02-01');
  await page
    .getByRole('textbox', { name: 'Original investment (MXN)', exact: true })
    .fill('12000.00');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expectNoSeriousAccessibilityViolations(page);
  await page.screenshot({
    path: '../../output/playwright/mexico-tax/assets-mobile.png',
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Review asset rows', exact: true })
    .click();
  expect(fixture.writes).toHaveLength(0);
  await page
    .getByRole('button', { name: 'Save assets as unreviewed input' })
    .click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  expect(fixture.writes[0]!.body).toMatchObject({
    factKey: 'corporation.investments.rows',
    expectedSourceRevision: null,
    value: {
      type: 'text',
      value: JSON.stringify([
        {
          assetId: 'computer_1',
          assetClass: 'computer-equipment',
          acquisitionDate: '2025-01-01',
          firstUseDate: '2025-02-01',
          originalInvestment: '12000.00',
        },
      ]),
    },
  });
  expect(fixture.errors).toEqual([]);
});

test('existing unbound corporate case attaches a reviewed entity and preserves its saved inputs', async ({
  page,
}) => {
  const fixture = await setup(page, true);
  const originalInputs = JSON.stringify(fixture.detail.declaredInputs);
  const caseId = fixture.detail.caseId;
  const revision = fixture.detail.currentRevision;
  await openWorking(page);
  await page.getByRole('button', { name: 'Case summary', exact: true }).click();
  const attachment = page.getByRole('region', {
    name: 'Attach corporate legal entity',
  });
  await expect(attachment).toBeVisible();
  const choice = attachment.getByRole('combobox', {
    name: /Corporate legal entity/,
  });
  await expect(choice).toHaveValue('');
  await choice.selectOption({ label: 'Jordan Chen · Personal finances' });
  await attachment
    .getByRole('button', { name: 'Review entity attachment' })
    .click();
  await expect(
    attachment.getByText(
      `Attach this entity to saved case revision ${revision}. Existing declarations and permissions remain in place.`,
    ),
  ).toBeVisible();
  expect(fixture.writes).toHaveLength(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoSeriousAccessibilityViolations(page);
  expect(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '../../output/playwright/mexico-tax/entity-attachment-review-mobile.png',
    fullPage: true,
  });
  fixture.loseEntityResponse();
  await attachment
    .getByRole('button', { name: 'Attach reviewed entity' })
    .click();
  await expect(
    attachment.getByRole('button', { name: 'Change entity choice' }),
  ).toBeDisabled();
  await attachment
    .getByRole('button', { name: 'Retry exact entity attachment' })
    .click();
  await expect(attachment).toHaveCount(0);
  await expect(
    page.getByText(
      'Corporate entity attached to this existing case. Review the new exact input versions before calculating. No book sources were authorized.',
    ),
  ).toBeVisible();
  expect(fixture.writes).toHaveLength(2);
  expect(fixture.writes[0]).toEqual(fixture.writes[1]);
  expect(fixture.writes[0]!.path).toBe(
    `/api/v2/finance/tax/cases/${caseId}/legal-entity`,
  );
  expect(fixture.writes[0]!.body).toEqual({
    expectedCaseRevision: revision,
    legalEntityId: '70000000-0000-4000-8000-000000000099',
  });
  expect(fixture.detail.caseId).toBe(caseId);
  expect(fixture.detail.currentRevision).toBe(revision + 1);
  expect(JSON.stringify(fixture.detail.declaredInputs)).toBe(originalInputs);
  expect(fixture.detail.questionnaire.sourceAuthorizationBindings).toEqual([]);
  await page.screenshot({
    path: '../../output/playwright/mexico-tax/entity-attached-mobile.png',
    fullPage: true,
  });
  expect(fixture.errors).toEqual([]);
});

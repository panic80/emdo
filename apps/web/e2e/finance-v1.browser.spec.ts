import { expect, test, type Page } from '@playwright/test';

import {
  expectNoSeriousAccessibilityViolations,
  mockAuthenticatedSession,
} from './support.js';

const csrfToken = 'e2e-csrf-token-01234567890123456789';
const now = '2026-08-26T12:00:00.000Z';
const privateOriginal = 'PRIVATE_ORIGINAL_SHOULD_NEVER_RENDER_OR_PERSIST';
const financeEvidenceId = '00000000-0000-4000-8000-000000000001';
const financeEvidenceExcerpt = 'Reviewed source excerpt from page two.';

type Observations = {
  readonly turns: unknown[];
  readonly reviewPatches: unknown[];
  readonly financeRequests: string[];
  uploadInFlight: number;
  maxUploadInFlight: number;
  uploads: number;
};

async function installFinanceMocks(page: Page): Promise<Observations> {
  const observations: Observations = {
    turns: [],
    reviewPatches: [],
    financeRequests: [],
    uploadInFlight: 0,
    maxUploadInFlight: 0,
    uploads: 0,
  };
  const documents = [
    {
      schemaVersion: 1,
      id: 'review-document',
      displayName: 'Awaiting-review receipt.pdf',
      mimeType: 'application/pdf',
      byteSize: 1024,
      plaintextSha256: 'a'.repeat(64),
      state: 'awaiting-review',
      documentType: 'receipt',
      sourceLocale: 'en-CA',
      currency: 'CAD',
      extractionRevision: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      schemaVersion: 1,
      id: 'committed-non-cad',
      displayName: `Non-CAD-${'very-long-label-'.repeat(12)}.pdf`,
      mimeType: 'application/pdf',
      byteSize: 1024,
      plaintextSha256: 'b'.repeat(64),
      state: 'committed',
      documentType: 'statement',
      sourceLocale: 'en-CA',
      currency: 'USD',
      extractionRevision: 2,
      createdAt: now,
      updatedAt: now,
    },
  ];

  await mockAuthenticatedSession(page);
  await page.route(
    /\/api\/v1\/experience\/finance(?:\?.*)?$/u,
    async (route) => {
      observations.financeRequests.push(route.request().url());
      if (route.request().url().includes('?')) {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            schemaVersion: 1,
            items: [
              {
                id: 'transaction-e2e',
                recordType: 'transaction',
                postedOn: '2026-08-26',
                description: 'Groceries',
                category: 'groceries',
                currency: 'CAD',
                amountCadMinor: -1234,
                state: 'active',
              },
            ],
          }),
        });
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          locale: 'en-CA',
          connectivity: 'online',
          quota: {
            documentsUsed: 2,
            documentsLimit: 10000,
            bytesUsed: 2048,
            bytesLimit: 53687091200,
          },
          reviewedCadTotals: [{ label: 'Reviewed CAD', amountCadMinor: 1234 }],
          recentActivity: [
            { id: 'activity-e2e', label: 'Reviewed receipt', occurredAt: now },
          ],
          budgets: [],
        }),
      });
    },
  );
  await page.route(
    /\/api\/v1\/finance\/documents(?:\?.*)?$/u,
    async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        const url = new URL(request.url());
        expect(url.searchParams.get('limit')).toBe('50');
        expect(url.searchParams.has('cursor')).toBe(false);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ schemaVersion: 1, items: documents }),
        });
        return;
      }
      expect(request.method()).toBe('POST');
      expect(request.headers()['x-csrf-token']).toBe(csrfToken);
      expect(request.headers()['idempotency-key']).toMatch(
        /^finance-document:upload:/u,
      );
      observations.uploadInFlight += 1;
      observations.maxUploadInFlight = Math.max(
        observations.maxUploadInFlight,
        observations.uploadInFlight,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      observations.uploadInFlight -= 1;
      observations.uploads += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ...documents[0],
          id: `upload-${observations.uploads}`,
          displayName: `upload-${observations.uploads}.pdf`,
        }),
      });
    },
  );
  await page.route(
    '**/api/v1/finance/documents/review-document/review',
    async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            schemaVersion: 1,
            documentId: 'review-document',
            extractionRevision: 1,
            envelope: {
              schemaVersion: 1,
              documentType: 'receipt',
              sourceLocale: 'en-CA',
              currency: 'CAD',
              total: { currency: 'CAD', minorUnits: 1234 },
              merchant: 'Redacted merchant',
            },
            payloadHash: 'c'.repeat(64),
            reviewToken: 'd'.repeat(43),
            expiresAt: '2999-08-26T12:00:00.000Z',
          }),
        });
        return;
      }
      expect(request.method()).toBe('PATCH');
      expect(request.headers()['x-csrf-token']).toBe(csrfToken);
      const patch = request.postDataJSON();
      observations.reviewPatches.push(patch);
      expect(patch).toMatchObject({ expectedExtractionRevision: 1 });
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          documentId: 'review-document',
          extractionRevision: 2,
          envelope: patch.envelope,
          payloadHash: 'e'.repeat(64),
          reviewToken: 'f'.repeat(43),
          expiresAt: '2999-08-26T12:00:00.000Z',
        }),
      });
    },
  );
  await page.route(
    '**/api/v1/finance/documents/committed-non-cad/matches',
    async (route) => {
      expect(route.request().method()).toBe('GET');
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          items: [
            {
              id: 'match-e2e',
              documentId: 'committed-non-cad',
              recordType: 'transaction',
              scoreBasisPoints: 9500,
            },
          ],
        }),
      });
    },
  );
  await page.route('**/api/v1/turns', async (route) => {
    const request = route.request();
    expect(request.method()).toBe('POST');
    expect(request.headers()['x-csrf-token']).toBe(csrfToken);
    expect(request.headers()['idempotency-key']).toMatch(/^turn-/u);
    const body = request.postDataJSON();
    expect(body).toMatchObject({ schemaVersion: 1 });
    expect(body.routeHint === undefined || body.routeHint === 'finance').toBe(
      true,
    );
    observations.turns.push(body);
    const runId = `run-${observations.turns.length}`;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        runId,
        status: 'accepted',
        replayed: false,
        eventsPath: `/api/v1/runs/${runId}/events`,
      }),
    });
  });
  await page.route('**/api/v1/runs/*/events', async (route) => {
    await route.fulfill({
      contentType: 'text/event-stream',
      body: `id: 1\nevent: run.completed\ndata: ${JSON.stringify({
        type: 'run.completed',
        data: {
          status: 'completed',
          output: {
            summary: 'The reviewed Finance answer is CAD 12.34.',
            evidenceReferences: [financeEvidenceId],
          },
          specialistOutcomes: [
            {
              specialistId: 'finance',
              status: 'completed',
              output: { evidenceReferences: [financeEvidenceId] },
            },
          ],
        },
      })}\n\n`,
    });
  });
  await page.route(
    `**/api/v1/finance/evidence/${financeEvidenceId}`,
    async (route) => {
      expect(route.request().method()).toBe('GET');
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          items: [
            {
              id: financeEvidenceId,
              documentId: '00000000-0000-4000-8000-000000000002',
              extractionRevision: 1,
              page: 2,
              excerpt: financeEvidenceExcerpt,
              sourceLocale: 'fr-CA',
              locator: { kind: 'text', characterStart: 20, characterEnd: 60 },
            },
          ],
        }),
      });
    },
  );
  return observations;
}

test('uses localized, accessible Finance views and routes guarded actions through turns', async ({
  page,
}) => {
  const observations = await installFinanceMocks(page);
  await page.addInitScript(() => {
    localStorage.setItem('emdo.active-locale.v1', 'en-CA');
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/finance');

  const tablist = page.getByRole('tablist', { name: 'Finance views' });
  await expect(tablist).toBeVisible();
  await expect(tablist.getByRole('tab')).toHaveCount(4);
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('textbox', { name: 'Ask EMDO' })).toBeVisible();
  await expect
    .poll(() => observations.financeRequests.length)
    .toBeGreaterThan(1);
  await expect(page.getByText('Groceries').first()).toBeVisible();
  for (const [index, label] of [
    'Overview',
    'Activity',
    'Documents',
    'Planning',
  ].entries()) {
    await page.getByRole('tab', { name: label }).click();
    await expect(page.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      `finance-${label.toLowerCase()}-tab`,
    );
    await page
      .getByRole('textbox', { name: 'Ask EMDO' })
      .fill(`Ask on ${label}`);
    await page.getByRole('button', { name: 'Ask EMDO', exact: true }).click();
    await expect.poll(() => observations.turns.length).toBe(index + 1);
  }

  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByText('Reviewed receipt')).toBeVisible();
  await page.getByRole('button', { name: 'Categorize or annotate' }).click();
  await page.getByLabel('Category ID').fill('food');
  await page.getByLabel('Annotation').fill('Reviewed in browser');
  await page.getByRole('button', { name: 'Ask EMDO to save' }).click();
  await expect.poll(() => observations.turns.length).toBe(5);

  await page.getByRole('tab', { name: 'Documents' }).click();
  const original = page
    .getByRole('link', { name: 'Download original' })
    .first();
  await expect(original).toHaveAttribute('download');
  await expect(original).toHaveAttribute(
    'href',
    '/api/v1/finance/documents/review-document/original',
  );
  await expect(page.locator('embed, iframe, object')).toHaveCount(0);
  const dataControls = page.getByRole('link', {
    name: /OpenAI does not use your data/u,
  });
  await expect(dataControls).toHaveAttribute('target', '_blank');
  await expect(dataControls).toHaveAttribute('rel', /noreferrer/u);
  await expect(
    page.getByText(
      'Items in currencies other than CAD are excluded from CAD totals.',
    ),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Review extraction' }).click();
  await page.locator('#finance-review-currency').fill('USD');
  await page.getByRole('button', { name: 'Save reviewed changes' }).click();
  await expect.poll(() => observations.reviewPatches.length).toBe(1);
  expect(observations.reviewPatches[0]).toMatchObject({
    envelope: { currency: 'USD', sourceLocale: 'en-CA' },
  });
  await page.getByRole('button', { name: 'Commit reviewed document' }).click();
  await expect.poll(() => observations.turns.length).toBe(6);
  await page.getByRole('button', { name: 'View matches' }).click();
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect.poll(() => observations.turns.length).toBe(7);
  await page.getByRole('button', { name: 'Ask EMDO to delete' }).last().click();
  await expect.poll(() => observations.turns.length).toBe(8);

  const files = Array.from({ length: 21 }, (_, index) => ({
    name: `private-${index}.pdf`,
    mimeType: 'application/pdf',
    buffer: Buffer.from(privateOriginal),
  }));
  await page.getByLabel('Add documents').setInputFiles(files);
  await expect.poll(() => observations.uploads).toBe(20);
  expect(observations.maxUploadInFlight).toBeLessThanOrEqual(3);
  await expect(page.locator('body')).not.toContainText(privateOriginal);
  const browserStorage = await page.evaluate(() => ({
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
  }));
  expect(JSON.stringify(browserStorage)).not.toContain(privateOriginal);

  await page.getByRole('tab', { name: 'Planning' }).click();
  await expect(page.getByText('Reviewed CAD', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Overview' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Activity' })).toBeFocused();
  await expectNoSeriousAccessibilityViolations(page);

  await page.setViewportSize({ width: 320, height: 700 });
  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.bodyScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(observations.turns).toHaveLength(8);
  expect(
    observations.turns.every(
      (turn) =>
        typeof turn === 'object' &&
        turn !== null &&
        (turn as { readonly routeHint?: unknown }).routeHint === 'finance',
    ),
  ).toBe(true);
});

test('renders an authorized Finance citation through the unified EMDO conversation without persisting its excerpt', async ({
  page,
}) => {
  await installFinanceMocks(page);
  await page.goto('/ask');

  await page
    .getByRole('textbox', { name: 'Ask EMDO' })
    .fill('What was the reviewed total?');
  await page.getByRole('button', { name: 'Ask EMDO', exact: true }).click();

  await expect(
    page.getByText('The reviewed Finance answer is CAD 12.34.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sources 1' }).click();
  await expect(page.getByText(financeEvidenceExcerpt)).toBeVisible();
  await expect(page.getByText('Page 2 · Source language: fr-CA')).toBeVisible();

  const browserStorage = await page.evaluate(() => ({
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
  }));
  expect(JSON.stringify(browserStorage)).not.toContain(financeEvidenceExcerpt);
});

test('exposes the four supported locale options and falls back from an unsupported browser locale', async ({
  page,
}) => {
  await installFinanceMocks(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'en-US',
    });
  });
  await page.goto('/settings');
  const selector = page.getByLabel('EMDO responses');
  await expect(selector.locator('option')).toHaveCount(4);
  await expect(selector).toHaveValue('en-CA');
  for (const locale of ['en-CA', 'fr-CA', 'ja-JP', 'ko-KR']) {
    await selector.selectOption(locale);
    await expect(selector).toHaveValue(locale);
  }
});

import { expect, test } from '@playwright/test';
import {
  mockAuthenticatedSession,
  expectNoSeriousAccessibilityViolations,
} from './support.js';
import fixtures from '../test/finance-invoice-fixture.json' with { type: 'json' };
const id = '00000000-0000-4000-8000-000000000001';
for (const [format, width] of [
  ['ubl', 1440],
  ['cii', 390],
] as const) {
  test(`${format} invoice draft survives reload and explicit posting at ${width}px`, async ({
    page,
  }) => {
    await mockAuthenticatedSession(page);
    await page.setViewportSize({ width, height: 1000 });
    const fixture = fixtures[format];
    let uploaded = false,
      stored: {
        id: string;
        evidenceId: string;
        revision: number;
        draft: Record<string, unknown>;
      } | null = null,
      posted: {
        id: string;
        journalId: string;
        status: string;
        total: string;
        currency: string;
      } | null = null;
    const writes: {
      path: string;
      body: Record<string, unknown>;
      key: string | undefined;
    }[] = [];
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
    await page.route('**/api/v2/finance/**', async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        writes.push({ path, body, key: request.headers()['idempotency-key'] });
        expect(request.headers()['x-csrf-token']).toBe(
          'e2e-csrf-token-01234567890123456789',
        );
        if (path.endsWith('/evidence')) {
          expect(body).toEqual({
            filename: `invoice-${format}.xml`,
            format,
            sourceText: fixture.xml,
          });
          uploaded = true;
          return route.fulfill({ json: { id } });
        }
        if (path.endsWith('/review-draft')) {
          expect(body.expectedRevision).toBe(stored?.revision ?? 0);
          stored = {
            id,
            evidenceId: id,
            revision: body.expectedRevision + 1,
            draft: body.draft,
          };
          return route.fulfill({ json: stored });
        }
        expect(path).toContain('/review-and-post');
        expect(body.expectedReviewRevision).toBe(stored?.revision);
        expect(body.expectedSourceDigest).toBe(fixture.source.sourceDigest);
        posted = {
          id,
          journalId: id,
          status: 'issued',
          total: format === 'ubl' ? '113.05' : '119',
          currency: 'EUR',
        };
        return route.fulfill({
          json: {
            id,
            journalId: id,
            total: posted.total,
            currency: 'EUR',
            evidenceId: id,
            sourceDigest: fixture.source.sourceDigest,
            adapterVersion: fixture.source.adapterVersion,
          },
        });
      }
      if (path.endsWith('/books'))
        return route.fulfill({
          json: {
            books: [
              {
                id,
                name: 'German invoices',
                entityName: 'Buyer GmbH',
                country: 'DE',
                functionalCurrency: 'EUR',
                role: 'administrator',
              },
            ],
          },
        });
      if (path.endsWith('/review-draft'))
        return route.fulfill({ json: { review: stored, posting: posted } });
      if (path.endsWith('/structured-invoice'))
        return route.fulfill({ json: fixture.source });
      if (path.endsWith('/evidence'))
        return route.fulfill({
          json: {
            documents: uploaded
              ? [{ id, filename: `invoice-${format}.xml`, format }]
              : [],
            nextOffset: null,
          },
        });
      if (path.endsWith('/commercial'))
        return route.fulfill({
          json: {
            parties: [
              {
                id,
                name: 'Source seller',
                kind: 'organization',
                reference: 'seller',
              },
            ],
          },
        });
      if (path.endsWith('/financial-accounts'))
        return route.fulfill({ json: { accounts: [] } });
      if (path.endsWith('/imports'))
        return route.fulfill({ json: { imports: [] } });
      if (path.endsWith('/report-mappings'))
        return route.fulfill({ json: { mappings: [], nextOffset: null } });
      return route.fulfill({
        json: {
          trialBalance: [
            {
              id,
              code: '100',
              name: 'Review account',
              kind: 'asset',
              debit: '0',
              credit: '0',
              balance: '0',
            },
          ],
          journals: [],
          periods: [],
        },
      });
    });
    async function open() {
      await page.goto('/finance');
      await page.getByRole('tab', { name: 'Documents', exact: true }).click();
      await page
        .getByRole('button', { name: 'Open documents', exact: true })
        .click();
      await page.getByRole('button', { name: 'Open invoice library' }).click();
    }
    await open();
    const region = page.getByRole('region', {
      name: 'Structured invoices',
      exact: true,
    });
    await region.getByLabel('XML syntax').selectOption(format);
    await region
      .getByLabel('Invoice XML file (UTF-8, up to 2 MiB)')
      .setInputFiles({
        name: `invoice-${format}.xml`,
        mimeType: 'application/xml',
        buffer: Buffer.from(fixture.xml),
      });
    await region
      .getByRole('button', { name: 'Upload invoice original' })
      .click();
    await region.getByLabel('Existing counterparty').selectOption(id);
    await region
      .getByRole('button', { name: 'Save review', exact: true })
      .click();
    await expect(region.getByText(/Review revision 1 saved/)).toBeVisible();
    await page.reload();
    await page.getByRole('tab', { name: 'Documents', exact: true }).click();
    await page
      .getByRole('button', { name: 'Open documents', exact: true })
      .click();
    await page.getByRole('button', { name: 'Open invoice library' }).click();
    await region
      .getByRole('button', {
        name: `invoice-${format}.xml · ${format.toUpperCase()}`,
      })
      .click();
    await expect(region.getByLabel('Existing counterparty')).toHaveValue(id);
    await region
      .getByLabel('Payables / receivables control account')
      .selectOption(id);
    await region.getByLabel('Net account for group 1').selectOption(id);
    await region.getByLabel('Tax account for group 1').selectOption(id);
    await region.getByLabel(/I verified the source seller/).check();
    await region.getByLabel(/I reviewed the exact amounts/).check();
    await region.getByLabel(/I understand this extraction/).check();
    await region
      .getByRole('button', { name: 'Save review', exact: true })
      .click();
    await expect(region.getByText(/Review revision 2 saved/)).toBeVisible();
    await region
      .getByRole('button', { name: 'Review posting', exact: true })
      .click();
    await expect(
      region.getByRole('group', { name: 'Confirm invoice posting' }),
    ).toBeVisible();
    await expectNoSeriousAccessibilityViolations(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/emdo-invoice-${format}-${width}.png`,
      fullPage: true,
    });
    await region
      .getByRole('button', { name: 'Confirm and post invoice' })
      .click();
    await expect(region.getByRole('heading', { name: /Posted/ })).toBeVisible();
    expect(
      writes.filter((w) => w.path.endsWith('/review-and-post')),
    ).toHaveLength(1);
  });
}

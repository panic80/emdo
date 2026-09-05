import { expect, test } from '@playwright/test';

import { mockAuthenticatedSession } from './support.js';

test('renders four localized Finance v1 views and uses attachment-only document originals', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('emdo.active-locale.v1', 'fr-CA');
  });
  await mockAuthenticatedSession(page);
  await page.route('**/api/v1/experience/finance', async (route) => {
    const request = route.request();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        request.url().includes('?')
          ? { schemaVersion: 1, items: [] }
          : {
              schemaVersion: 1,
              locale: 'fr-CA',
              connectivity: 'online',
              quota: {
                documentsUsed: 1,
                documentsLimit: 10000,
                bytesUsed: 1024,
                bytesLimit: 53687091200,
              },
              reviewedCadTotals: [
                { label: 'Dépenses révisées', amountCadMinor: 1234 },
              ],
              recentActivity: [
                {
                  id: 'activity-a',
                  label: 'Reçu examiné',
                  occurredAt: '2026-08-26T12:00:00.000Z',
                },
              ],
              budgets: [],
            },
      ),
    });
  });
  await page.route(
    /\/api\/v1\/finance\/documents(?:\?.*)?$/u,
    async (route) => {
      const request = route.request();
      expect(request.method()).toBe('GET');
      const url = new URL(request.url());
      expect(url.searchParams.get('limit')).toBe('50');
      expect(url.searchParams.has('cursor')).toBe(false);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          items: [
            {
              schemaVersion: 1,
              id: 'document-a',
              displayName: 'Receipt.pdf',
              mimeType: 'application/pdf',
              byteSize: 1024,
              plaintextSha256: 'a'.repeat(64),
              state: 'committed',
              documentType: 'receipt',
              sourceLocale: 'fr-CA',
              currency: 'CAD',
              extractionRevision: 1,
              createdAt: '2026-08-26T12:00:00.000Z',
              updatedAt: '2026-08-26T12:00:00.000Z',
            },
          ],
        }),
      });
    },
  );

  await page.goto('/finance');
  await expect(page.getByRole('tab', { name: 'Aperçu' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('textbox', { name: 'Ask EMDO' })).toBeVisible();
  await expect(
    page.getByText(/OpenAI n’utilise pas vos données/u),
  ).toBeVisible();
  await expect(
    page.getByText(/Seules les informations CAD révisées/u),
  ).toBeVisible();

  await page.getByRole('tab', { name: 'Activité' }).click();
  await expect(page.getByText('Reçu examiné')).toBeVisible();
  await page.getByRole('tab', { name: 'Planification' }).click();
  await expect(page.getByText('Dépenses révisées')).toBeVisible();
  await page.getByRole('tab', { name: 'Documents' }).click();
  await expect(page.getByRole('textbox', { name: 'Ask EMDO' })).toBeVisible();
  const original = await page.getByRole('link', {
    name: 'Télécharger l’original',
  });
  await expect(original).toHaveAttribute('download');
  await expect(original).toHaveAttribute(
    'href',
    '/api/v1/finance/documents/document-a/original',
  );
  await expect(page.locator('embed, iframe, object')).toHaveCount(0);
});

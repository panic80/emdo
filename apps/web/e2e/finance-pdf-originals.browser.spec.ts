import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  expectNoSeriousAccessibilityViolations,
  mockAuthenticatedSession,
} from './support.js';
const bookId = '00000000-0000-4000-8000-000000000001',
  evidenceId = '00000000-0000-4000-8000-000000000002',
  otherBookId = '00000000-0000-4000-8000-000000000003';

// A real one-page text PDF keeps this browser fixture independent of providers.
function pdfOriginalFixture() {
  const content =
    'BT /F1 12 Tf 50 750 Td (Account statement) Tj 0 -20 Td (2026-09-13  CAD 123.45) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
  ];
  let document = '%PDF-1.7\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    document += `${String(offset).padStart(10, '0')} 00000 n \n`;
  document += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}

test('PDF originals upload and download exactly, with inspection-only EMDO requests', async ({
  page,
}) => {
  await mockAuthenticatedSession(page);
  const bytes = pdfOriginalFixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const writes: { path: string; body: Record<string, unknown> }[] = [],
    turns: Record<string, unknown>[] = [];
  let saved = false,
    evidenceStatus = 200;
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
  await page.route('**/api/v2/finance/books**', (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === 'POST') {
      expect(path).toBe(`/api/v2/finance/books/${bookId}/evidence`);
      expect(request.headers()['x-csrf-token']).toBe(
        'e2e-csrf-token-01234567890123456789',
      );
      expect(request.headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/u);
      const body = request.postDataJSON();
      expect(body).toEqual({
        filename: 'statement.pdf',
        format: 'pdf',
        sourceBase64: bytes.toString('base64'),
      });
      writes.push({ path, body });
      saved = true;
      return route.fulfill({ json: { id: evidenceId } });
    }
    if (path.endsWith('/books'))
      return route.fulfill({
        json: {
          books: [
            {
              id: bookId,
              name: 'Operations',
              entityName: 'Example',
              country: 'CA',
              functionalCurrency: 'CAD',
              role: 'administrator',
            },
            {
              id: otherBookId,
              name: 'Personal',
              entityName: 'Member',
              country: 'CA',
              functionalCurrency: 'CAD',
              role: 'viewer',
            },
          ],
        },
      });
    if (path.includes('/evidence')) {
      if (evidenceStatus !== 200)
        return route.fulfill({ status: evidenceStatus, json: {} });
      if (path.endsWith('/evidence'))
        return route.fulfill({
          json: {
            documents:
              saved && !path.includes(otherBookId)
                ? [{ id: evidenceId, filename: 'statement.pdf', format: 'pdf' }]
                : [],
            nextOffset: null,
          },
        });
      return route.fulfill({
        json: {
          filename: 'statement.pdf',
          format: 'pdf',
          sourceBase64: bytes.toString('base64'),
        },
      });
    }
    if (path.endsWith('/financial-accounts'))
      return route.fulfill({ json: { accounts: [] } });
    if (path.endsWith('/imports'))
      return route.fulfill({ json: { imports: [] } });
    if (path.endsWith('/report-mappings'))
      return route.fulfill({ json: { mappings: [], nextOffset: null } });
    return route.fulfill({
      json: { trialBalance: [], journals: [], periods: [] },
    });
  });
  await page.route('**/api/v1/turns', (route) => {
    const request = route.request(),
      body = request.postDataJSON();
    turns.push(body);
    expect(body.routeHint).toBe('finance');
    expect(body.message).toContain('inspect embedded text and page references');
    expect(body.message).toContain('OCR is not implemented');
    expect(body.message).toContain('do not propose a mapping');
    expect(body.message).toContain(JSON.stringify({ bookId, evidenceId }));
    expect(body.message).not.toContain('finance.reports.propose-mapping');
    expect(request.headers()['x-csrf-token']).toBe(
      'e2e-csrf-token-01234567890123456789',
    );
    return route.fulfill({
      json: {
        schemaVersion: 1,
        runId: `pdf-${turns.length}`,
        status: 'accepted',
        replayed: false,
        eventsPath: `/api/v1/runs/pdf-${turns.length}/events`,
      },
    });
  });
  await page.route('**/api/v1/runs/*/events', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `id: 1\nevent: run.completed\ndata: ${JSON.stringify({ type: 'run.completed', data: { status: 'completed', output: { summary: 'Embedded PDF text inspected. No mapping or financial import was performed.' } } })}\n\n`,
    }),
  );
  await page.setViewportSize({ width: 1505, height: 1045 });
  await page.goto('/finance');
  await expect(page.getByLabel('Accounting book')).toHaveValue(bookId);
  await page.getByRole('tab', { name: 'Documents', exact: true }).click();
  await page
    .getByRole('button', { name: 'Open documents', exact: true })
    .click();
  const pdf = page.getByRole('region', { name: 'PDF originals', exact: true });
  await pdf.getByText('PDF originals', { exact: true }).click();
  await expect(pdf.getByText('No PDF originals on this page.')).toBeVisible();
  const input = pdf.getByLabel('PDF original · up to 2 MiB');
  await input.setInputFiles({
    name: 'oversized.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.alloc(2097153),
  });
  await pdf.getByRole('button', { name: 'Save PDF original' }).click();
  await expect(pdf.getByRole('alert')).toContainText('2 MiB');
  expect(writes).toEqual([]);
  await input.setInputFiles({
    name: 'statement.pdf',
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  await pdf.getByRole('button', { name: 'Save PDF original' }).click();
  await expect(pdf.getByRole('status')).toContainText(
    'No import rows or financial records were created',
  );
  await expect(pdf.getByText(/Image-only pages need OCR/)).toBeVisible();
  await expect(
    pdf.getByRole('button', { name: /import|commit|approve/i }),
  ).toHaveCount(0);
  await page.screenshot({
    path: '/tmp/emdo-pdf-originals-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await expectNoSeriousAccessibilityViolations(page);
  const downloadPending = page.waitForEvent('download');
  await pdf.getByRole('button', { name: 'Download statement.pdf' }).click();
  const download = await downloadPending;
  expect(download.suggestedFilename()).toBe('statement.pdf');
  expect(await readFile((await download.path())!)).toEqual(bytes);
  await pdf
    .getByRole('button', { name: 'Ask EMDO to inspect statement.pdf' })
    .click();
  await expect.poll(() => turns.length).toBe(1);
  await expect(pdf.getByRole('status')).toContainText(
    'PDF inspection sent to EMDO',
  );
  await page.getByRole('tab', { name: 'Reports & tax', exact: true }).click();
  await page
    .getByRole('button', { name: 'Report standardization', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Open report standardization' })
    .click();
  const mappings = page.getByRole('region', {
    name: 'Dynamic report standardization',
  });
  await mappings.getByLabel('Report or image original').setInputFiles({
    name: 'statement.pdf',
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  await mappings.getByRole('button', { name: 'Save original report' }).click();
  await expect(mappings.getByRole('status')).toContainText(
    'PDF original saved securely',
  );
  await mappings
    .getByRole('button', { name: 'Ask EMDO to inspect statement.pdf' })
    .click();
  await expect.poll(() => turns.length).toBe(2);
  await expect(
    mappings
      .getByRole('status')
      .filter({ hasText: 'No mapping or import was requested' }),
  ).toBeVisible();
  await expect(mappings.getByRole('table')).toHaveCount(0);
  await expect(
    mappings.getByRole('button', { name: /approve|reuse|commit/i }),
  ).toHaveCount(0);
  await page.getByRole('tab', { name: 'Documents', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/emdo-pdf-originals-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await pdf.getByText('PDF originals', { exact: true }).evaluate((element) => {
    window.scrollTo(
      0,
      window.scrollY + element.getBoundingClientRect().top - 90,
    );
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expectNoSeriousAccessibilityViolations(page);
  await page.screenshot({
    path: '/tmp/emdo-pdf-originals-mobile-native.png',
    animations: 'disabled',
  });
  await page.getByLabel('Accounting book').selectOption(otherBookId);
  await page.getByRole('button', { name: 'Open documents' }).click();
  await pdf.getByText('PDF originals', { exact: true }).click();
  await expect(pdf.getByText('No PDF originals on this page.')).toBeVisible();
  await expect(
    pdf.getByRole('button', { name: 'Save PDF original' }),
  ).toHaveCount(0);
  evidenceStatus = 503;
  await pdf.getByRole('button', { name: 'Refresh PDF originals' }).click();
  await expect(pdf.getByRole('alert')).toContainText('not available');
  await expect(pdf.getByText('No PDF originals on this page.')).toHaveCount(0);
  evidenceStatus = 403;
  await pdf.getByRole('button', { name: 'Refresh PDF originals' }).click();
  await expect(pdf.getByRole('alert')).toContainText('Current book access');
  expect(writes).toHaveLength(2);
  expect(errors).toEqual([]);
});

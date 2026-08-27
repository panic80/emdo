import { describe, expect, it } from 'vitest';

import { FINANCE_DOCUMENT_LIMITS } from '@emdo/domains/finance';

import { createFinancePdfInspector } from './finance-pdf-inspection.js';

const pdfWithPages = (pageCount: number, suffix = ''): Uint8Array => {
  const pageObjectNumbers = Array.from(
    { length: pageCount },
    (_entry, index) => index + 3,
  );
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjectNumbers
      .map((number) => `${number} 0 R`)
      .join(' ')}] /Count ${pageCount} >>`,
    ...pageObjectNumbers.map(
      () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
    ),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const startXref = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n${suffix}`;
  return new TextEncoder().encode(pdf);
};

describe('Finance PDF inspection', () => {
  it('reads the actual PDF page tree', async () => {
    const pdf = pdfWithPages(3);

    await expect(createFinancePdfInspector().pageCount(pdf)).resolves.toBe(3);
    pdf.fill(0);
  });

  it('does not count page-like plaintext tokens outside the PDF page tree', async () => {
    const pdf = pdfWithPages(1, `/Type /Page\n`.repeat(300));

    await expect(createFinancePdfInspector().pageCount(pdf)).resolves.toBe(1);
    pdf.fill(0);
  });

  it('rejects a valid PDF above the approved 250-page boundary', async () => {
    const pdf = pdfWithPages(FINANCE_DOCUMENT_LIMITS.maximumPdfPages + 1);

    await expect(
      createFinancePdfInspector().pageCount(pdf),
    ).resolves.toBeUndefined();
    pdf.fill(0);
  });

  it('rejects malformed PDF bytes without leaking parser details', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\nnot-a-document');

    await expect(
      createFinancePdfInspector().pageCount(pdf),
    ).resolves.toBeUndefined();
    pdf.fill(0);
  });
});

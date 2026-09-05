import { describe, expect, it } from 'vitest';

import {
  createLocalPdfTextExtractor,
  LOCAL_PDF_TEXT_EXTRACTION_LIMITS,
  usableLocalPdfText,
} from './local-pdf-text-extraction.js';

const minimalPdf = (text: string): Uint8Array => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length + 27} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream`,
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
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
};

describe('local PDF text extraction', () => {
  it('extracts bounded text with the Node parser and leaves the source byte buffer to its caller', async () => {
    const text =
      'Invoice A-123 total CAD 12.99 due 2026-08-26. Account 9911 is billed monthly for household services.';
    const document = minimalPdf(text);
    const extractor = createLocalPdfTextExtractor();

    const result = await extractor.extract({
      document,
      pageCount: 1,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ status: 'usable' });
    if (result.status === 'usable')
      expect(result.text).toContain('Invoice A-123');
    expect(document.every((value) => value !== 0)).toBe(true);
    document.fill(0);
  });

  it('rejects control data and both text caps before it can reach a provider', () => {
    expect(
      usableLocalPdfText(`Invoice\u0000${'a '.repeat(80)}`),
    ).toBeUndefined();
    expect(
      usableLocalPdfText(
        'a '.repeat(
          LOCAL_PDF_TEXT_EXTRACTION_LIMITS.maxExtractedTextCharacters,
        ),
      ),
    ).toBeUndefined();
    expect(
      usableLocalPdfText(
        '€'.repeat(
          Math.ceil(LOCAL_PDF_TEXT_EXTRACTION_LIMITS.maxExtractedTextBytes / 3),
        ),
      ),
    ).toBeUndefined();
  });

  it('does not initialize parser work for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const document = minimalPdf(
      'Invoice A-123 total CAD 12.99 due 2026-08-26.',
    );

    await expect(
      createLocalPdfTextExtractor().extract({
        document,
        pageCount: 1,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ status: 'unusable' });
    document.fill(0);
  });

  it('keeps the existing PDF page boundary before parser initialization', async () => {
    const document = minimalPdf(
      'Invoice A-123 total CAD 12.99 due 2026-08-26.',
    );

    await expect(
      createLocalPdfTextExtractor().extract({
        document,
        pageCount: LOCAL_PDF_TEXT_EXTRACTION_LIMITS.maxPdfPages + 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: 'unusable' });
    document.fill(0);
  });
});
